/**
 * 密钥形态守卫回归测试：`apiKeyEnv` 只接受**环境变量名**，绝不接受密钥值。
 *
 * 为什么单独成文件：这是**安全属性**，且此前在 adapter 侧被真实漏判过——
 * `packages/plugin-openai` 曾用黑名单 `detectSuspiciousCredential` 校验自己的 `apiKeyEnv`，
 * 而 32 位 hex / 全大写 32 位 / 16 字符混合这三种**随机密钥最常见的形态**在语法上都是
 * 合法标识符，黑名单一条都拦不住 ⇒ 会被判为"合法配置"并**静默落盘**进 git 跟踪的
 * `config/plugins.base.json`（密钥一旦进 git 历史不可撤销）。
 *
 * 现在两层都是**白名单**（`@geewiki/llm` 的 `ENV_VAR_NAME_FIELD_RE` / `isEnvVarName`，
 * 单一实现）：
 * - **schema 层**：`OpenAiConfigSchema.apiKeyEnv` 的 `.pattern(...)`，由 cordis 的
 *   `resolveConfig` 在激活前执行；`Manager.updateConfig` 亦经 `validateConfig`，
 *   故**激活与热更新两条路径**都在此被拦下，走不到 `persistConfig` 落盘。
 * - **apply 层**：`apply` 里显式 `isEnvVarName` 校验，覆盖"直接以代码构造 config 装配"
 *   （测试、程序化装配）这条绕过 schema 的路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { LLM_SERVICE_KEY, createLlmService, isEnvVarName } from '@geewiki/llm'
import { OpenAiConfigSchema, OpenAiPlugin } from '../src/index.js'

/**
 * 必须被拒绝的形态。前三行是本次修复前**能穿透黑名单落盘**的三种，是最重要的回归面。
 * 这些字符串是**形态样例**，不是真实凭据。
 */
const REJECTED: [label: string, value: string][] = [
  ['32 位 hex（黑名单漏判）', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'],
  ['全大写 32 位（黑名单漏判）', 'ABCDEF1234567890ABCDEF1234567890'],
  ['16 字符混合（黑名单漏判）', 'Xk9mQ2pL7vR4tN8w'],
  ['sk- 前缀形态', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV'],
  ['AIza 前缀形态', 'AIzaSyA1B2C3D4E5F6G7H8I9J0KLMNOPQRSTUV'],
  ['小写名（不合惯例）', 'openai_key'],
  ['无下划线单词', 'PATH'],
  ['含连字符', 'OPENAI-API-KEY'],
  ['含空格', 'OPENAI API KEY'],
  ['数字开头', '9OPENAI_KEY'],
]

/** 必须被接受的形态：空串（未配置）与惯例形态的变量名 */
const ACCEPTED: [label: string, value: string][] = [
  ['空串 = 未配置', ''],
  ['惯例形态', 'OPENAI_API_KEY'],
  ['惯例形态（测试用）', 'GEEWIKI_TEST_UNSET_KEY'],
  ['前导下划线', '_X'],
  ['字母数字混合', 'A1_B2'],
]

/** 装配：真实 cordis + 真实 llm-service */
async function setup(): Promise<Context> {
  const root = new Context()
  root.provide(LLM_SERVICE_KEY, createLlmService())
  return root
}

/* ------------------------- schema 层（主闸门） ------------------------- */

test('schema 层：三种黑名单漏判形态 + 前缀形态一律被 pattern 拒绝', () => {
  for (const [label, value] of REJECTED) {
    assert.throws(
      () => new OpenAiConfigSchema({ apiKeyEnv: value }),
      /match regexp/,
      `${label}（${value.slice(0, 8)}…）必须被 schema 拒绝，否则会静默落盘进 git`,
    )
  }
})

test('schema 层：空串与惯例形态的变量名必须通过（否则插件连默认配置都无法激活）', () => {
  for (const [label, value] of ACCEPTED) {
    const config = new OpenAiConfigSchema({ apiKeyEnv: value }) as { apiKeyEnv?: string }
    assert.equal(config.apiKeyEnv, value, `${label} 应原样通过`)
  }
})

test('schema 层：默认值通过 pattern（pattern 必须显式允许空串与默认值）', () => {
  const config = new OpenAiConfigSchema({}) as { apiKeyEnv?: string }
  assert.equal(config.apiKeyEnv, 'OPENAI_API_KEY', '默认值应被填充')
  // 默认值本身也要合法，否则激活必然抛错——这是"pattern 漏写 ^$| 分支"的经典翻车点
  assert.equal(isEnvVarName(config.apiKeyEnv ?? ''), true)
})

test('schema 层：经真实 cordis 激活路径被拒（resolveConfig 在 apply 之前拦下）', async () => {
  const root = await setup()
  for (const [label, value] of REJECTED) {
    const fork = root.plugin(OpenAiPlugin, { route: `reject-${label}`, apiKeyEnv: value })
    await assert.rejects(
      async () => {
        await fork
      },
      /invalid config|match regexp/,
      `${label} 经 ctx.plugin() 激活必须失败`,
    )
  }
})

/* ------------------------- apply 层（第二道闸门） ------------------------- */

test('apply 层：直接调 apply（绕过 schema）时三种漏判形态仍被拒绝，且不回显该值', async () => {
  const root = await setup()
  for (const [label, value] of REJECTED) {
    assert.throws(
      () => OpenAiPlugin.apply(root, { route: 'direct', apiKeyEnv: value }),
      (err: unknown) => {
        const message = (err as Error).message
        assert.match(message, /看起来是\*\*密钥值本身\*\*而不是环境变量名/, `${label} 应给出可读说明`)
        // 安全要求：报错**不得回显**该值——它可能就是密钥本身，而日志会被收集
        assert.equal(message.includes(value), false, `${label}：报错信息不得回显疑似密钥的值`)
        return true
      },
    )
  }
})

test('apply 层：空串与惯例形态直接调 apply 不抛错（降级路径必须能安全走通）', async () => {
  for (const [label, value] of ACCEPTED) {
    const root = await setup()
    const dispose = OpenAiPlugin.apply(root, { route: `ok-${label}`, apiKeyEnv: value })
    assert.equal(typeof dispose, 'function', `${label} 应正常装配并返回 disposer`)
    dispose()
  }
})

/* ------------------------- 判据来源一致性 ------------------------- */

test('单一实现：schema pattern 与实际判据同源（都是 @geewiki/llm 的 isEnvVarName 语义）', () => {
  // 防止将来有人只改一处：凡是 isEnvVarName 判 false 的，schema 也必须拒绝
  for (const value of ['a1b2c3d4e5f60718293a4b5c6d7e8f90', 'Xk9mQ2pL7vR4tN8w', 'openai_key', 'PATH']) {
    assert.equal(isEnvVarName(value), false, `前置：${value} 应被白名单判否`)
    assert.throws(
      () => new OpenAiConfigSchema({ apiKeyEnv: value }),
      /match regexp/,
      `${value} 在 isEnvVarName 判否时 schema 也必须拒绝（两层不得漂移）`,
    )
  }
  // 反向：isEnvVarName 判 true 的必须被 schema 接受
  for (const value of ['', 'OPENAI_API_KEY', 'GEEWIKI_TEST_UNSET_KEY']) {
    assert.equal(isEnvVarName(value), true, `前置：${value} 应被白名单判真`)
    assert.doesNotThrow(() => new OpenAiConfigSchema({ apiKeyEnv: value }))
  }
})
