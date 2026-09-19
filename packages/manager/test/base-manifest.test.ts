/**
 * 基础层清单的「example（入库）/ live（本机）」双文件模型（2026-09-19）。
 *
 * ## 这个文件存在的理由
 * `config/plugins.base.json` 是**运行期可写**文件：在管理台保存一次配置就会重写它。
 * 它曾经是入库文件，于是有两个后果，且都**不会让任何构建或测试变红**：
 * ① 每个人本机的模型端点/开关（例如 `reasoningEffort`）会以"改动"的形式进入 `git status`，
 *    随时可能被 `git add -A` 提交；
 * ② 更严重的一条同源：`.dockerignore` 当时只排除了 `plugins.session.json`，
 *    于是 `COPY config /app/config` 把 **`config/secrets.json`（模型 API key）打进镜像层**——
 *    密钥随镜像一起分发。这条已用探测构建实测（`/cfg/secrets.json` 确实在上下文里）。
 *
 * 修法：默认值放 `plugins.base.example.json`（入库、只读），live 文件不入库、缺失时回退读模板。
 * 本文件钉住"修法不被重新破坏"：文件名约定、启动回退、以及两份 ignore 文件的语义。
 *
 * ## 为什么 ignore 文件要在这里按语义校验（而不是只看 `git ls-files`）
 * `git ls-files` 只反映**此刻的索引**：规则被删掉时它仍然绿（文件本来就没被跟踪），
 * 直到有人 `git add -A` 才变红——那时已经晚了。所以两份都查：事实（是否被跟踪）+ 机制（规则是否还在）。
 * `.dockerignore` 没有"事实"可查（那要真的构建一次镜像），只能查规则。
 */
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { ConfigSchema } from '@geewiki/core'
import { findRepoRoot } from '@geewiki/core'
import Schema from 'schemastery'
import { GeeWikiManager, exampleManifestPathOf } from '../src/index.js'
import type { RegisteredPlugin } from '../src/deps.js'

const HERE = import.meta.url
/** `findRepoRoot` 的返回类型是 `string | undefined`：这里把它收敛成 string，失败即让本文件整体报错 */
const ROOT: string = (() => {
  const root = findRepoRoot(HERE)
  if (root === undefined) throw new Error(`未找到仓库根（从 ${HERE} 向上找 pnpm-workspace.yaml）`)
  return root
})()

/** 本机（运行期可写）的配置文件：一个都不许入库、一个都不许进 Docker 构建上下文 */
const LIVE_CONFIG_FILES = [
  'config/plugins.base.json',
  'config/plugins.session.json',
  'config/secrets.json',
] as const
/** 随版本发布的默认值模板：必须入库、必须能进构建上下文 */
const SHIPPED_TEMPLATE = 'config/plugins.base.example.json'

/* ------------------------------ 夹具 ------------------------------ */

const MESSAGE_SCHEMA: ConfigSchema = Schema.object({
  message: Schema.string().default('默认消息').description('消息内容'),
})

function cfgPlugin(name: string, log: string[]): RegisteredPlugin {
  return {
    name,
    manifest: {
      name,
      version: '1.0.0',
      geewiki: {
        requires: [],
        runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 0 },
        configSchema: MESSAGE_SCHEMA,
      },
    },
    module: {
      name,
      Config: MESSAGE_SCHEMA,
      apply: (_ctx: unknown, config?: unknown) => {
        log.push(`apply:${name}:${JSON.stringify(config)}`)
        return () => log.push(`dispose:${name}`)
      },
    },
  }
}

interface Env {
  dir: string
  baseFile: string
  exampleFile: string
  sessionFile: string
  exampleText: string
  cleanup(): void
}

/** 只造 example（**不造 live 文件**）：这正是"干净检出/新容器"的初始状态 */
function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-base-manifest-'))
  const exampleText = `${JSON.stringify(
    { enabled: [{ name: '@t/from-example', config: { message: '来自模板' } }] },
    null,
    2,
  )}\n`
  const exampleFile = join(dir, 'plugins.base.example.json')
  writeFileSync(exampleFile, exampleText, 'utf8')
  return {
    dir,
    baseFile: join(dir, 'plugins.base.json'),
    exampleFile,
    sessionFile: join(dir, 'plugins.session.json'),
    exampleText,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function makeManager(env: Env, log: string[]): GeeWikiManager {
  return new GeeWikiManager(new Context(), {
    registry: [cfgPlugin('@t/from-example', log)],
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
  })
}

/* --------------------------- 文件名派生约定 --------------------------- */

test('exampleManifestPathOf：同目录、同主名，后缀换成 .example.json', () => {
  assert.equal(exampleManifestPathOf('/x/config/plugins.base.json'), '/x/config/plugins.base.example.json')
  assert.equal(exampleManifestPathOf('plugins.base.json'), 'plugins.base.example.json')
  // 非 .json 不猜后缀：宁可没有回退（读到空清单，报错清楚）也不要读错文件
  assert.equal(exampleManifestPathOf('/x/config/plugins.base'), null)
  assert.equal(exampleManifestPathOf('/x/config/plugins.base.yaml'), null)
})

/* ----------------------------- 启动回退 ----------------------------- */

test('★ live 清单缺失 ⇒ 按 example 的默认值装配，且启动**不写盘**', async () => {
  const env = makeEnv()
  const log: string[] = []
  try {
    const manager = makeManager(env, log)
    await manager.boot()

    assert.ok(
      log.some((l) => l.startsWith('apply:@t/from-example')),
      'live 文件不存在时应回退读 example 并装配其中的插件',
    )
    assert.ok(
      log.some((l) => l.includes('来自模板')),
      'example 里的 config 必须一并生效（否则默认值等于只有启用关系没有配置）',
    )
    // 关键性质：启动**不**把 example 复制成 live。启动写盘会让只读挂载的部署直接启动失败，
    // 也会让"我什么都没改，却多出一个文件"成为默认行为。
    assert.equal(existsSync(env.baseFile), false, '启动不得生成 live 文件')
    assert.equal(readFileSync(env.exampleFile, 'utf8'), env.exampleText, 'example 不得被改写')
  } finally {
    env.cleanup()
  }
})

test('★ live 文件存在时以它为准，example 只作回退（本机改动不会被模板盖掉）', async () => {
  const env = makeEnv()
  const log: string[] = []
  try {
    writeFileSync(env.baseFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
    const manager = makeManager(env, log)
    await manager.boot()
    assert.equal(
      log.some((l) => l.startsWith('apply:')),
      false,
      'live 文件是空清单 ⇒ 不应装配 example 里的插件（本机现状优先于模板）',
    )
  } finally {
    env.cleanup()
  }
})

test('★ 首次写入配置 ⇒ 生成 live 文件，example 逐字不变', async () => {
  const env = makeEnv()
  const log: string[] = []
  try {
    const manager = makeManager(env, log)
    await manager.boot()
    await manager.updateConfig('@t/from-example', { message: '本机改过的值' })

    assert.ok(existsSync(env.baseFile), '配置写入必须落 live 文件（它才是运行期真源）')
    const live = JSON.parse(readFileSync(env.baseFile, 'utf8')) as {
      enabled: { name: string; config?: Record<string, unknown> }[]
    }
    assert.equal(live.enabled.find((e) => e.name === '@t/from-example')?.config?.['message'], '本机改过的值')
    assert.equal(
      readFileSync(env.exampleFile, 'utf8'),
      env.exampleText,
      'example 是随版本发布的只读默认值：进程永远不写它',
    )
  } finally {
    env.cleanup()
  }
})

/* ----------------------------- 仓库卫生 ----------------------------- */

/** `git ls-files --error-unmatch`：命中（=被跟踪）返回 true */
function gitTracks(rel: string): boolean | null {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' })
  if (probe.status !== 0 || probe.stdout.trim() !== 'true') return null
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: ROOT, encoding: 'utf8' }).status === 0
}

test('★ 守卫：本机配置文件不得被 git 跟踪，模板必须入库', (t) => {
  for (const rel of LIVE_CONFIG_FILES) {
    const tracked = gitTracks(rel)
    if (tracked === null) {
      t.skip('不是 git 工作树（打包分发场景），跳过"是否被跟踪"的断言')
      return
    }
    assert.equal(
      tracked,
      false,
      `${rel} 被 git 跟踪了：它是运行期可写文件，入库后每个人本机保存一次配置都会变成别人的改动`,
    )
  }
  assert.equal(gitTracks(SHIPPED_TEMPLATE), true, `${SHIPPED_TEMPLATE} 必须入库：它是随版本发布的默认值`)
})

/**
 * 本仓实际用到的 dockerignore / gitignore 形态求值（**故意只支持这几种**）。
 *
 * 不做通用 glob 是有意的：一个写错的通用实现会让这条守卫**静默变松**，而静默变松比覆盖不全更糟
 * （本仓已有同类教训：源码扫描用正则而不是引号状态机，于是守卫在 `'https://x'` 处静默失效）。
 * 支持：字面路径、`dir/*`、`**` 前缀通配、`*.ext`、`!` 反选（后出现的规则胜出，与两者语义一致）。
 * 注意本注释不能出现"星号紧跟斜杠"的字面形态——那会**提前终止块注释**，把后面的散文当成代码解析
 * （本次就踩了两次：块注释里那个两字符序列让整个文件在转译期报 Unexpected "."）。
 */
function ignoredBy(patterns: readonly string[], rel: string): boolean {
  let ignored = false
  for (const raw of patterns) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const pattern = negated ? line.slice(1) : line
    const match =
      pattern === rel ||
      (pattern.endsWith('/*') && rel.startsWith(pattern.slice(0, -1))) ||
      (pattern.startsWith('*.') && rel.endsWith(pattern.slice(1))) ||
      (pattern.startsWith('**/') && (rel === pattern.slice(3) || rel.endsWith(`/${pattern.slice(3)}`)))
    if (match) ignored = !negated
  }
  return ignored
}

test('★ 守卫：.gitignore / .dockerignore 都必须排除每一个本机配置文件', () => {
  for (const file of ['.gitignore', '.dockerignore']) {
    const patterns = readFileSync(join(ROOT, file), 'utf8').split('\n')
    for (const rel of LIVE_CONFIG_FILES) {
      assert.equal(
        ignoredBy(patterns, rel),
        true,
        `${file} 没有排除 ${rel}：` +
          (file === '.dockerignore'
            ? '它会进入构建上下文 → Dockerfile 的 COPY 把它打进镜像层（secrets.json 里是模型 API key）'
            : '它会被 `git add -A` 提交，把本机设置变成所有人的改动'),
      )
    }
    // 反向：模板必须能通过，否则容器读到空清单 → 没有插件被激活 → HTTP 不监听 → 静默重启循环
    assert.equal(
      ignoredBy(patterns, SHIPPED_TEMPLATE),
      false,
      `${file} 把 ${SHIPPED_TEMPLATE} 也排除了：它是要随版本发布的默认值`,
    )
  }
})
