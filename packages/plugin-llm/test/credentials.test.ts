/**
 * `apiKeyEnv` 必须是**环境变量名**，绝不能是密钥值本身。
 *
 * 为什么这组用例存在：`config/plugins.base.json` 是**入库文件**（`git ls-files config/` 可见），
 * 任何写进配置的密钥都会被提交进 git 历史且**不可撤销**。而"黑名单启发式"拦不住下面
 * {@link MUST_REJECT} 这三类——它们的共同点是**语法上就是合法的标识符**（字母数字，
 * 长度 16/32），恰恰是随机密钥最常见的形态：
 * - 32 位 hex：不满足黑名单的"≥40 字符无分隔串"；
 * - 全大写 32 位：被黑名单里的 `UPPER_SNAKE_NAME` **主动豁免**；
 * - 16 字符混合：既不匹配前缀规则也不满足 40 字符下限。
 *
 * 后果不是"少了一层保护"，而是**静默失败**：`PUT /api/plugins/:name/config` 返回 200 并
 * 落盘，系统随后只是降级成"没有 LLM"（`degraded.reason = no_provider`），用户看不出自己
 * 填错了，密钥却已进入 git 历史。
 *
 * 修法因此不是"把黑名单补全"（永远补不全），而是**白名单**：只接受环境变量名的惯例形态，
 * 密钥值天然不可能通过。本组用例钉住这条契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { LlmConfigSchema, LlmPlugin } from '../src/index.js'
import { resolveCredential } from '../src/credentials.js'

/** cordis 的 fork 状态常量（`FiberState` 是 const enum，isolatedModules 下无运行时导出） */
const FIBER_ACTIVE = 2

/**
 * **必须被拒绝**的三类（外部审查实测漏判的形态，均已复现）。
 * 注意它们不是"奇怪的字符串"——每一个都通过 `/^[A-Za-z_][A-Za-z0-9_]*$/`。
 */
const MUST_REJECT: readonly string[] = [
  'a1b2c3d4e5f60718293a4b5c6d7e8f90', // 32 位 hex
  'ABCDEF1234567890ABCDEF1234567890', // 全大写 32 位（旧黑名单主动豁免的形态）
  'Xk9mQ2pL7vR4tN8w', // 16 字符混合
  'sk-abcdefghijklmnop', // 带前缀（旧黑名单能拦，保留防回归）
  'AIzaSyA1234567890abcdefghijklmnop', // Google 形态（旧黑名单能拦，保留防回归）
  'a.b', // 含点：不是合法变量名
  'a b', // 含空格
  'a-b', // 含连字符
  '密钥名字', // 非 ASCII
]

/**
 * **必须通过**：惯例形态的环境变量名（全部是仓库内真实使用/文档示例的写法）。
 * `''` 也通过——它的语义是"未配置"，是必须能安全走通的降级路径。
 */
const MUST_ACCEPT: readonly string[] = [
  '',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEEWIKI_TEST_PLUGIN_KEY',
  'GEEWIKI_TEST_OPENAI_KEY_1',
  '_X',
  'A1_B2',
  `${'A'.repeat(127)}_`, // 128 字符上限边界
]

test('LlmConfigSchema：密钥形态的 apiKeyEnv 必须被 schema 拒绝（这是阻止其落盘的闸门）', () => {
  // schema 层拦截是关键：`Manager.updateConfig` 与激活前校验都走 `validateConfig(schema, …)`，
  // 因此**启动与热更新两条路径**都在这里被拦下，不会走到 persistConfig 落盘。
  for (const bad of MUST_REJECT) {
    assert.throws(
      () => new LlmConfigSchema({ apiKeyEnv: bad }),
      /apiKeyEnv/,
      `密钥形态必须被 schema 拒绝（否则会落盘进入库文件）: ${bad}`,
    )
  }
})

test('LlmConfigSchema：惯例形态的环境变量名与空值必须通过（不得误伤）', () => {
  for (const good of MUST_ACCEPT) {
    const parsed = new LlmConfigSchema({ apiKeyEnv: good })
    assert.equal(parsed.apiKeyEnv, good, `应原样接受: ${good}`)
  }
  // 未提供该键时由默认值填充（默认必须是合法值，否则插件无法用默认配置激活）
  assert.equal(new LlmConfigSchema({}).apiKeyEnv, '', '缺省应为空串')
  assert.equal(new LlmConfigSchema({ apiKeyEnv: undefined }).apiKeyEnv, '', 'undefined 应回落默认值')
})

test('apply（经 cordis）：密钥形态的 apiKeyEnv 让激活失败（而不是静默降级）', async () => {
  for (const bad of MUST_REJECT.slice(0, 3)) {
    const ctx = new Context()
    // cordis 的 apply 是**异步结算**的：错误不会从 ctx.plugin() 同步抛出，必须 await fork。
    // 注意这条路径上**先**由 Config schema 拦下（见下一个用例覆盖 apply 自身的闸门），
    // 所以报错文本来自 schemastery，只保证提到字段名、且不回显密钥。
    const fork = ctx.plugin(LlmPlugin, { apiKeyEnv: bad })
    const failure = await fork.then(
      () => undefined,
      (err: unknown) => err as Error,
    )
    assert.ok(failure, `密钥形态必须导致激活失败: ${bad}`)
    assert.match(failure.message, /apiKeyEnv/, '报错应指出是哪个字段')
    assert.ok(!failure.message.includes(bad), '报错不得回显密钥原文')
    // schema 层拒绝发生在 fiber 启动**之前**，故状态停在 PENDING（0）而非 FAILED（3）。
    // 关键语义是"绝不放行"：不得进入 ACTIVE。
    assert.notEqual(fork.state, FIBER_ACTIVE, 'fork 不得进入 ACTIVE 态')
    assert.equal(ctx.get('llm-service'), undefined, '激活失败不得注册服务')
  }
})

test('apply（直接调用，绕过 cordis 的 Config 校验）：apply 自身的闸门同样拒绝密钥形态', () => {
  // 为什么需要这条：schema 只覆盖"经管理器读写配置"的路径；`apply` 里的检查是**第二道闸门**，
  // 覆盖直接以代码构造 config 调用 apply 的场景（程序化装配、测试夹具）。
  // 少了它，一旦有人绕过 Config 装配，密钥形态的配置就会静默通过。
  for (const bad of MUST_REJECT.slice(0, 3)) {
    assert.throws(
      () => LlmPlugin.apply(new Context(), { apiKeyEnv: bad }),
      /环境变量名/,
      `apply 必须拒绝并说明该填环境变量名: ${bad}`,
    )
  }
  // 报错信息不得回显那个值（它可能就是密钥本身）
  const err = (() => {
    try {
      LlmPlugin.apply(new Context(), { apiKeyEnv: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })
      return undefined
    } catch (e) {
      return e as Error
    }
  })()
  assert.ok(err && !err.message.includes('a1b2c3d4e5f60718293a4b5c6d7e8f90'), '报错不得回显密钥原文')
})

test('apply：惯例形态的环境变量名照常激活（未配置该变量只降级，不失败）', async () => {
  const ctx = new Context()
  // 变量确实未设 → 走"缺少凭据"的降级路径，但**配置本身合法**，插件必须能激活
  const fork = ctx.plugin(LlmPlugin, { apiKeyEnv: 'GEEWIKI_TEST_ABSENT_KEY_XYZ' })
  await fork
  assert.ok(ctx.get('llm-service'), '合法配置必须激活成功')
  await fork.dispose()
})

test('resolveCredential：密钥形态 → INVALID_CREDENTIAL（绝不去查 env、绝不静默降级）', () => {
  for (const bad of MUST_REJECT) {
    assert.deepEqual(
      resolveCredential(bad),
      { ok: false, code: 'INVALID_CREDENTIAL' },
      `密钥形态必须报"凭据非法"而不是"缺少凭据": ${bad}`,
    )
  }
})

test('resolveCredential：惯例形态但变量未设 → MISSING_CREDENTIAL；空值 → MISSING_CREDENTIAL', () => {
  for (const good of MUST_ACCEPT) {
    assert.deepEqual(
      resolveCredential(good),
      { ok: false, code: 'MISSING_CREDENTIAL' },
      `合法名字但变量未设应报"缺少凭据"（这是可安全走通的降级路径）: "${good}"`,
    )
  }
  assert.deepEqual(resolveCredential(undefined), { ok: false, code: 'MISSING_CREDENTIAL' })
  assert.deepEqual(resolveCredential('   '), { ok: false, code: 'MISSING_CREDENTIAL' })
})

test('resolveCredential：合法名字且变量已设 → 取到值（成功路径不得被白名单误伤）', () => {
  process.env['GEEWIKI_LLM_CRED_TEST_KEY'] = 'value-from-env'
  try {
    assert.deepEqual(resolveCredential('GEEWIKI_LLM_CRED_TEST_KEY'), { ok: true, value: 'value-from-env' })
  } finally {
    delete process.env['GEEWIKI_LLM_CRED_TEST_KEY']
  }
})
