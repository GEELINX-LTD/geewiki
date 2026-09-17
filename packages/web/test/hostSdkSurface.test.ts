/**
 * 宿主 SDK **表面**的源码级守卫（F2 / F6）。
 *
 * ## 为什么必须有一条这样的守卫
 * `index.html` 的 import map 把裸说明符（`react-dom` …）指向 `public/host-sdk/*.js`，
 * 而那些 shim 在**模块求值期**读 `globalThis.__GEEWIKI_HOST__` 上的字段。
 * 这条链上有三处各自独立、且任何一处漏改都是**静默失败**：
 *
 *   ① import map 里有一条映射，但 `public/host-sdk/` 下没有对应的 shim 文件
 *      ⇒ 插件 `import 'react-dom'` 直接 404，插件整个 bundle 加载失败；
 *   ② shim 存在、也映射了，但 SDK 对象上**没有那个字段**（如 `ReactDOM`）
 *      ⇒ shim 抛 `未初始化`，同样是插件整体不可用；
 *   ③ 映射与 shim 都好，但 shim 少枚举了一个具名导出
 *      ⇒ 插件 `import { createRoot } from 'react-dom/client'` 拿到 `undefined`，
 *        **只在真正调用时才炸**（错误现场离原因很远）。
 *
 * 三处的"正确"是同一份事实的三个副本，只能靠守卫钉住——这正是本仓库
 * `slotPropsMirror.test.ts` / `pluginUiPlan.test.ts` 的既有做法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const htmlPath = join(webRoot, 'index.html')
const hostSdkPath = join(webRoot, 'src/lib/hostSdk.ts')

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

/** 从 index.html 抠出 import map 的 `imports` 表 */
function importMap(): Record<string, string> {
  const html = read(htmlPath)
  const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, 'index.html 里找不到 import map（正则失效即红，不允许静默通过）')
  const parsed = JSON.parse(match[1] as string) as { imports?: Record<string, string> }
  assert.ok(parsed.imports && Object.keys(parsed.imports).length > 0, 'import map 的 imports 为空')
  return parsed.imports
}

test('import map：react / jsx-runtime / react-dom / react-dom/client 四条映射齐备', () => {
  const map = importMap()
  for (const spec of ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']) {
    assert.ok(map[spec], `import map 缺少 "${spec}" 映射——插件按裸说明符 import 时会 404`)
  }
})

test('import map 的每个目标都**真实存在**（映射到不存在的 shim = 插件整体加载失败）', () => {
  const map = importMap()
  for (const [spec, target] of Object.entries(map)) {
    assert.ok(target.startsWith('/host-sdk/'), `${spec} 应映射到 /host-sdk/ 下的 shim，实得 ${target}`)
    const file = join(webRoot, 'public', target.replace(/^\//, ''))
    assert.ok(existsSync(file), `${spec} → ${target} 指向的文件不存在：${file}`)
  }
})

test('shim 读取的 SDK 字段都已在 hostSdk.ts 上暴露', () => {
  /*
   * 每个 shim 的第一件事都是 `const H = globalThis.__GEEWIKI_HOST__` 然后取一个字段。
   * 把那个字段名抠出来，确认 hostSdk.ts 里真的有它——否则 shim 会抛"未初始化"，
   * 而症状（插件整体不可用）与真正的原因（宿主少暴露一个字段）隔着好几层。
   */
  const shims: readonly { file: string; field: string }[] = [
    { file: 'react.js', field: 'React' },
    { file: 'jsx-runtime.js', field: 'jsxRuntime' },
    { file: 'react-dom.js', field: 'ReactDOM' },
    { file: 'react-dom-client.js', field: 'ReactDOMClient' },
  ]
  const sdk = read(hostSdkPath)
  for (const { file, field } of shims) {
    const src = read(join(webRoot, 'public/host-sdk', file))
    assert.match(
      src,
      new RegExp(`H\\.${field}\\b`),
      `${file} 应当从宿主 SDK 取 ${field}（结构与预期不符）`,
    )
    // 字段必须在 GeeWikiHostSdk 接口 + sdk 对象两处都出现
    assert.ok(
      sdk.includes(`readonly ${field}:`) || sdk.includes(`${field}:`),
      `hostSdk.ts 未暴露 ${field}：${file} 会在模块求值期抛"未初始化"`,
    )
  }
})

test('react-dom / react-dom/client shim：关键具名导出逐条枚举（ESM 无法动态转发）', () => {
  const dom = read(join(webRoot, 'public/host-sdk/react-dom.js'))
  for (const name of ['createPortal', 'flushSync', 'version']) {
    assert.match(dom, new RegExp(`export const ${name}\\b`), `react-dom shim 缺少具名导出 ${name}`)
  }
  const client = read(join(webRoot, 'public/host-sdk/react-dom-client.js'))
  for (const name of ['createRoot', 'hydrateRoot']) {
    assert.match(
      client,
      new RegExp(`export const ${name}\\b`),
      `react-dom/client shim 缺少具名导出 ${name}——插件 import 到 undefined，只在调用时才炸`,
    )
  }
})

test('hostSdk：F6 的便捷直出与命名空间成对存在（缺一个都是半成品）', () => {
  const sdk = read(hostSdkPath)
  // 命名空间（供 import map 的 shim 转发）
  for (const field of ['ReactDOM', 'ReactDOMClient']) {
    assert.match(sdk, new RegExp(`readonly ${field}:`), `接口缺 ${field}`)
    assert.match(sdk, new RegExp(`^\\s+${field},$`, 'm'), `sdk 对象缺 ${field}`)
  }
  // 便捷直出（插件最常用的两个；有它们才不必写 host.ReactDOM.createPortal）
  for (const field of ['createPortal', 'createRoot', 'hydrateRoot']) {
    assert.match(sdk, new RegExp(`readonly ${field}:`), `接口缺 ${field}`)
  }
})

test('hostSdk：版本号单调且与文档化的能力演进一致', () => {
  const sdk = read(hostSdkPath)
  const match = /export const HOST_SDK_VERSION = '(\d+)\.(\d+)\.(\d+)'/.exec(sdk)
  assert.ok(match, '未能解析出 HOST_SDK_VERSION')
  const [, major, minor] = match as unknown as [string, string, string, string]
  assert.equal(major, '0')
  // F1=0.4.0（动态插槽）、F2=0.5.0（页面路由）、F6=0.6.0（react-dom/portal）。
  // 回退版本号会让插件的**特性探测**（`typeof host.PluginSlotOutlet === 'function'`）失去意义。
  assert.ok(
    Number(minor) >= 6,
    `版本 ${match[1]}.${match[2]}.${match[3]} 低于已落地能力的版本（至少 0.6.0）——` +
      '不要回退：插件按特性探测而非比大小，但文档与排障都以它为准',
  )
  // F8=0.7.0（Markdown 渲染注册表）、F16=0.8.0（主题 token 覆盖）、F15=0.9.0（共享文案目录）。
  for (const cap of ['0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0']) {
    assert.ok(sdk.includes(cap), `版本演进说明里缺少 ${cap}（改动历史是插件作者的唯一依据）`)
  }
})

test('hostSdk：F16 主题覆盖的接口与实现成对存在（只写接口 = 插件探测到函数但调用即抛）', () => {
  const sdk = read(hostSdkPath)
  for (const field of ['registerTheme', 'unregisterThemes', 'themeContributors']) {
    assert.match(sdk, new RegExp(`\\b${field}\\b`), `hostSdk 缺 ${field}`)
  }
  // 与 `markdownExtensions`/`clientTools` 同理：必须用 getter（sdk 是模块加载期构造的单例，
  // 而插件登记发生在其后；快照会让插件永远读到空数组，且不报错）
  assert.match(sdk, /get themeContributors\(\)\s*\{/, 'themeContributors 必须是 getter 而不是快照值')
  assert.match(sdk, /get markdownExtensions\(\)\s*\{/, 'markdownExtensions 必须是 getter（回归护栏）')
})
