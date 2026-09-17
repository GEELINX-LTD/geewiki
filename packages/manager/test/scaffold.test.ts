/**
 * ★ F21：外部插件脚手架的守卫。
 *
 * ## 这个文件要防的失效
 * 模板的价值全在"生成出来的东西**真的能用**"。而模板会随着平台演进而过期：
 * 清单多了一个必填字段、入口探测顺序改了、UI 根换了位置、按需加载的插槽集合变了 ——
 * 任何一项都会让**新作者**拿到一个静默不工作的插件，而模板作者不会收到任何通知。
 *
 * 所以这里不做"字符串快照"式的断言（那种测试只会在你改模板时碍事），而是把生成物
 * **送回真实管线**：
 * - 清单交给真的 `parsePluginManifest()` 解析（而不是 `JSON.parse` 后自己看字段）；
 * - 目录交给真的 `loadExternalPlugins()` 扫描与 `import()` 加载；
 * - UI 声明与实际 `registerSlot()` 调用互相比对。
 *
 * 这样断言的是"这份模板产出的插件能被平台接受"，而不是"模板文本没变"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadExternalPlugins, parsePluginManifest } from '../src/discovery.js'
import {
  gitignoreLinesFor,
  packageNameOf,
  scaffoldFiles,
  validatePluginName,
  writeScaffold,
  type ScaffoldSpec,
} from '../src/scaffold.js'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..', '..')

function spec(over: Partial<ScaffoldSpec> = {}): ScaffoldSpec {
  return {
    name: 'demo-notes',
    displayName: '演示笔记',
    description: '脚手架守卫用例',
    withUi: false,
    hotReload: true,
    ...over,
  }
}

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const fileOf = (files: ReturnType<typeof scaffoldFiles>, path: string): string => {
  const f = files.find((x) => x.path === path)
  assert.ok(f, `生成物里应有 ${path}（实有: ${files.map((x) => x.path).join(', ')}）`)
  return f.content
}

/* ------------------------------ 名字校验 ------------------------------ */

test('★ F21：插件名白名单——合法通过，越界/可疑一律拒绝且给出人话理由', () => {
  for (const ok of ['a', 'my-notes', 'note2', 'a-b-c-1']) {
    assert.equal(validatePluginName(ok), undefined, `${ok} 应合法`)
  }
  const bad = [
    '',
    'Bad',
    'my_notes',
    'my notes',
    '-lead',
    'trail-',
    'double--dash',
    '2start',
    'a'.repeat(41),
    '../escape',
    'a/b',
    'a\\b',
    '.',
    '..',
    'a.b',
  ]
  for (const b of bad) {
    assert.ok(validatePluginName(b) !== undefined, `${JSON.stringify(b)} 应被拒绝`)
  }
  // 拒绝理由要能直接打给用户（不是 "invalid"）
  assert.match(validatePluginName('Bad') as string, /小写字母/)
})

test('★ F21：名字非法时脚手架直接抛错，不产生任何文件内容', () => {
  assert.throws(() => scaffoldFiles(spec({ name: '../escape' })), /不合法/)
})

/* --------------------- 清单：交给真实的解析器 --------------------- */

test('★ F21：生成的 package.json 能被 parsePluginManifest 真正接受，且字段齐备', () => {
  const files = scaffoldFiles(spec())
  const parsed = JSON.parse(fileOf(files, 'package.json')) as { name: string; geewiki: unknown }
  const manifest = parsePluginManifest(parsed, undefined)
  assert.equal(manifest.name, packageNameOf('demo-notes'))
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.geewiki.entry, 'index.ts')
  // `provides` 是**依赖图 token**，不是 cordis 服务名；http 路由服务的 token 是 http-service
  assert.equal(manifest.geewiki.provides, 'demo-notes-service')
  assert.deepEqual(manifest.geewiki.requires, ['http-service'])
  assert.equal(manifest.geewiki.runtime?.supportsHotReload, true)
  assert.equal(manifest.geewiki.runtime?.drainTimeout, 5)
})

test('★ F21：默认（无 UI）不生成 client/slots/dist —— 用不到就别声明', () => {
  const files = scaffoldFiles(spec())
  assert.deepEqual(
    files.map((f) => f.path),
    ['package.json', 'index.ts', 'README.md'],
  )
  const parsed = JSON.parse(fileOf(files, 'package.json')) as { geewiki: Record<string, unknown> }
  assert.equal(parsed.geewiki.client, undefined, '无 UI 就不该声明 client')
  assert.equal(parsed.geewiki.slots, undefined, '无 UI 就不该声明 slots')
  // permissions 同理：本模板零 Node 依赖，声明任何权限都是不诚实的清单（F10 的初衷）
  assert.equal(parsed.geewiki.permissions, undefined, '零依赖模板不该声明 permissions')
})

/* ------------------- 端到端：真的能被发现并加载 ------------------- */

test('★ F21：生成物送进真实的 loadExternalPlugins——零 issue、入口可 import、模块有 apply', async () => {
  const env = tempDir('gw-scaffold-')
  try {
    writeScaffold(env.dir, spec())
    const result = await loadExternalPlugins({ root: env.dir, builtinNames: [] })
    assert.deepEqual(result.issues, [], `发现阶段不应有任何 issue: ${JSON.stringify(result.issues)}`)
    assert.equal(result.plugins.length, 1)
    const entry = result.plugins[0]!
    assert.equal(entry.name, packageNameOf('demo-notes'))
    assert.equal(typeof entry.module.apply, 'function', '入口模块必须导出可用的 apply')
    // 入口真的被 import 成功了（.ts 由 tsx loader 处理）——这一步失败会体现为 issues，已断言为空
  } finally {
    env.cleanup()
  }
})

test('★ F21：带 UI 的变体同样能被发现，且 client 声明的文件真的存在', async () => {
  const env = tempDir('gw-scaffold-ui-')
  try {
    const result = writeScaffold(env.dir, spec({ withUi: true }))
    assert.ok(result.written.includes('dist/client.js'))
    assert.ok(result.written.includes('dist/client.css'))
    const dir = join(env.dir, 'demo-notes')
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      geewiki: { client: { entry: string; css?: string }; slots: string[] }
    }
    // UI 根被 plugin-ui.ts 硬编码为 <插件目录>/dist，故声明的是**相对该根**的路径
    assert.equal(parsed.geewiki.client.entry, 'client.js')
    assert.ok(existsSync(join(dir, 'dist', parsed.geewiki.client.entry)), 'client.entry 必须真实存在')
    assert.ok(existsSync(join(dir, 'dist', parsed.geewiki.client.css as string)), 'client.css 必须真实存在')

    const discovered = await loadExternalPlugins({ root: env.dir, builtinNames: [] })
    assert.deepEqual(discovered.issues, [])
  } finally {
    env.cleanup()
  }
})

/* --------------- UI：声明与实现必须自洽（本项最容易悄悄错） --------------- */

test('★ F21：清单 slots 声明与 client.js 里真正 registerSlot 的名字一致', () => {
  const files = scaffoldFiles(spec({ withUi: true }))
  const parsed = JSON.parse(fileOf(files, 'package.json')) as { geewiki: { slots: string[] } }
  const client = fileOf(files, 'dist/client.js')
  const registered = [...client.matchAll(/registerSlot\(\s*'([^']+)'/g)].map((m) => m[1] as string)
  assert.ok(registered.length > 0, 'client.js 必须真的调用 registerSlot（否则声明了 slot 也是空的）')
  /*
   * 两侧不一致的两种后果都不报错：
   * - 声明了却不注册 ⇒ 插槽永远空着；
   * - 注册了却没声明 ⇒ 宿主按需加载的判定看不到它（editor 一类会是"界面永不加载"）。
   */
  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...parsed.geewiki.slots].sort(),
    'package.json 的 slots 必须与 client.js 实际注册的插槽集合完全一致',
  )
  // 客户端必须导出宿主约定的入口（命名 `register` 或 default 函数）
  assert.match(client, /export function register\(host\)/, 'client.js 必须导出 register(host)')
})

test('★ F21：后端入口零依赖——不 import 任何包（外部插件不得有自己的依赖）', () => {
  const src = fileOf(scaffoldFiles(spec()), 'index.ts')
  /*
   * 必须**先剥掉注释**再判：模板的说明文字里就有「不 import 任何包（包括 `@geewiki/core`）」
   * 这句话本身。不剥注释的粗暴断言会误报——而误报的守卫会被下一次改动顺手删掉，
   * 比没有守卫更糟。（同款处理见 `slot-props-schema.test.ts` 的 `topLevelFields`。）
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(/^\s*import\s/m.test(code), false, 'index.ts 不得出现 import 语句')
  assert.equal(/(^|[^\w.])require\s*\(/.test(code), false, 'index.ts 不得 require')
  assert.equal(code.includes('@geewiki/'), false, 'index.ts 不得引用宿主包名（需要契约时用 interface 描述）')
  assert.equal(/^\s*export\s+.*\bfrom\b/m.test(code), false, 'index.ts 不得 re-export 任何包')
  // 必须返回卸载函数：路由不撤销的话，插件停用后端点仍然在
  assert.match(code, /return \(\) => \{/, 'apply 必须返回卸载函数')
  // 默认导出 cordis 插件对象（发现流程依赖它，用例 5 已端到端验证）
  assert.match(code, /export default plugin/)
})

/* ------------------------------ 写盘语义 ------------------------------ */

test('★ F21：拒绝覆盖已存在且非空的目录（不静默盖掉作者的半成品）', () => {
  const env = tempDir('gw-scaffold-guard-')
  try {
    const dir = join(env.dir, 'demo-notes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), '// 作者手写的半成品\n', 'utf8')
    assert.throws(() => writeScaffold(env.dir, spec()), /拒绝覆盖/)
    // 原有内容必须原样保留
    assert.equal(readFileSync(join(dir, 'index.ts'), 'utf8'), '// 作者手写的半成品\n')
  } finally {
    env.cleanup()
  }
})

test('★ F21：空目录允许写入（mkdir -p 之后的常见状态）', () => {
  const env = tempDir('gw-scaffold-empty-')
  try {
    mkdirSync(join(env.dir, 'demo-notes'), { recursive: true })
    const r = writeScaffold(env.dir, spec())
    assert.ok(r.written.includes('index.ts'))
    assert.deepEqual(readdirSync(r.dir).sort(), ['README.md', 'index.ts', 'package.json'])
  } finally {
    env.cleanup()
  }
})

/* --------------------- 那条 .gitignore 例外的前提 --------------------- */

test('★ F21：dist/ 仍被全局忽略（前提断言）——一旦上游修好，这里会红并提示可简化', () => {
  /*
   * 这条不是测脚手架本身，而是**钉住它必须处理的那个前提**：
   * 外部插件的 UI 根是 <插件目录>/dist（plugin-ui.ts 的 resolvePluginUiRoots ①），
   * 而仓库 .gitignore 有全局 `dist/` ⇒ 手写的前端产物**提交不进去**。
   * 若将来 UI 根改成可声明（例如 client.root），这条前提消失，本用例应当变红，
   * 提醒后来者：scaffold 里的 gitignore 提示与 gitignoreLinesFor 可以删掉了。
   */
  const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
  const lines = gitignore.split('\n').map((l) => l.trim())
  assert.ok(lines.includes('dist/'), '全局 `dist/` 忽略规则已不在——请复核脚手架是否仍需要 gitignore 例外')
  assert.equal(
    lines.some((l) => l === '!plugins/*/dist/' || l === '!plugins/*/dist/**'),
    false,
    '仓库里不应存在覆盖全部插件的 dist 例外（那会把 ui-demo/hello-geewiki 的真构建产物也纳入）',
  )
  // 例外必须逐插件、且成对（目录 + 内容），否则 git 不会下降进被忽略的目录
  const forPlugin = gitignoreLinesFor('demo-notes')
  assert.deepEqual(forPlugin, ['!plugins/demo-notes/dist/', '!plugins/demo-notes/dist/**'])
  assert.ok(forPlugin[0]!.includes('demo-notes'), '例外必须带具体插件名')
})

test('★ F21：CLI 已接入根 package.json 的 scripts（否则作者按 README 跑会 command not found）', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.ok(pkg.scripts['new:plugin']?.includes('create-plugin'), '根 scripts 应有 new:plugin')
  assert.ok(existsSync(join(REPO_ROOT, 'scripts', 'create-plugin.ts')), 'CLI 文件必须存在')
})
