/**
 * 降级词汇与可用性投影（`src/degrade.ts` + `src/availability.ts`）的守卫测试。
 *
 * 这两份词汇是从 `@geewiki/ai` **上移**到本包的（契约：映射表只要出现在第二个插件里就是两份真源；
 * 详见 `docs/design/ai-plugin-architecture.md` 的「AI 失败语义与降级词汇」）。`@geewiki/ai-assistant` 是仅有的消费方
 * （P8 前是它与 `@geewiki/ai-qa` 两个，ai-qa 已随 `wiki-ask` 拆除），
 * 要防的失败模式全是"看起来正常、语义已错位"那一类：
 *
 * - `CODE_TO_REASON` 少映射一个错误码 ⇒ 该上游错误码在运行时落成 `undefined` reason，前端无从分支；
 * - `DegradedReason` 多声明一个没人产生的成员（死枚举）⇒ 前端要为永远不会出现的原因写文案
 *   （历史教训：`empty_query` 曾被误从 HTTP 400 错误码抄进降级枚举）；
 * - 绕过 `makeDegraded` 手拼 message ⇒ 上游报错文本夹带的密钥直达浏览器——
 *   `makeDegraded` 是这条链路上 `redact` 的**唯一调用点**（见 src/degrade.ts 文件头）；
 * - 可用性投影遇 `available()` 抛错 ⇒ 一个坏适配器就能把能力查询打成 500。
 *
 * 风格对齐 `packages/web/test/degradedReason.test.ts`：union 类型**运行时不存在**，
 * "某个字符串是否为成员"只能对源码做正则解析，因此每个解析结果都配**反空洞断言**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODE_TO_REASON,
  NULL_PROVIDER,
  createLlmService,
  listRouteInfos,
  makeDegraded,
  noModelDegraded,
  safeAvailable,
  type LlmChunk,
  type LlmErrorCode,
  type LlmProvider,
  type LlmService,
} from '../src/index.js'

const HERE = import.meta.dirname

/**
 * 从源码文本抽 `export type X = | 'a' | 'b' …` 的成员集合。
 * 刻意不做 AST 解析（本仓库既有守卫都是文本级）；代价是必须显式断言解析非空，
 * 否则正则写坏会退化成"0 === 0"的空洞通过。
 */
function extractUnion(source: string, typeName: string): Set<string> {
  const m = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?)(?:\\n\\n|\\nexport |\\n\\/\\*\\*)`).exec(source)
  assert.ok(m, `未找到 \`export type ${typeName} =\` 声明（正则失效即守卫失效）`)
  const members = new Set<string>()
  for (const hit of (m?.[1] as string).matchAll(/'([A-Za-z_]+)'/g)) members.add(hit[1] as string)
  assert.ok(members.size > 0, `${typeName}：解析出的成员集合为空（正则失效即守卫失效）`)
  return members
}

const DEGRADE_SRC = readFileSync(join(HERE, '../src/degrade.ts'), 'utf8')
/**
 * ★ F3：LLM 契约已**下沉到 `@geewiki/core`**（真源 `packages/core/src/llm.ts`），
 * 本包的 `src/types.ts` 现在只是转出。所以这条守卫改成读**真源**——
 * 若继续读本包的转出文件，正则必然失配（或被改写后虚假通过），
 * 那样守的就不是"契约有没有漂移"，而是"转出文件长什么样"，本末倒置。
 */
const TYPES_SRC = readFileSync(join(HERE, '../../core/src/llm.ts'), 'utf8')
/** 本包的 types.ts 必须**只是转出**：不得再本地 `export type LlmErrorCode = …`（否则又出现第二份真源） */
const LOCAL_TYPES_SRC = readFileSync(join(HERE, '../src/types.ts'), 'utf8')
const DEGRADED_REASONS = extractUnion(DEGRADE_SRC, 'DegradedReason')
const SOURCE_ERROR_CODES = extractUnion(TYPES_SRC, 'LlmErrorCode')

/** 假 provider：可用性由参数固定；stream 与本文件无关 */
function stubProvider(route: string, ok: boolean, label = `Stub-${route}`): LlmProvider {
  return {
    route,
    descriptor: {
      route,
      label,
      vendor: 'test',
      model: `${route}-1`,
      // ⚠️ `available` 是**函数**（降级契约的唯一入口），不是布尔字段。
      available: () => ok,
    },
    // 契约要求 AsyncIterable
    async *stream(): AsyncIterable<LlmChunk> {
      yield { type: 'error', code: 'PROVIDER_ERROR' }
    },
  }
}

/* ================= CODE_TO_REASON：可达性 / 全覆盖守卫 ================= */

test('★ F3：本包 types.ts 只是转出 —— 不得再本地定义契约（否则出现第二份真源）', () => {
  /*
   * 契约搬走后，本包最容易发生的回归是"顺手又抄一份"：抄的那份在有人改动前
   * 与实际生效的类型**完全一致**，所有运行期断言都照常通过，只在漂移发生后才红。
   * 所以这里直接钉住"不得本地定义"，而不是比对两份内容是否相等。
   */
  for (const name of ['LlmErrorCode', 'LlmService', 'LlmChunk', 'LlmRequest']) {
    assert.equal(
      new RegExp(`export (?:type|interface) ${name}\\b[^=]*=`).test(LOCAL_TYPES_SRC),
      false,
      `packages/plugin-llm/src/types.ts 又本地定义了 ${name}——契约真源必须只有 packages/core/src/llm.ts 一处`,
    )
  }
  assert.match(
    LOCAL_TYPES_SRC,
    /from '@geewiki\/core'/,
    'packages/plugin-llm/src/types.ts 必须从 @geewiki/core 转出契约',
  )
})

test('CODE_TO_REASON：对 LlmErrorCode 全覆盖，且落点集合恰等于 DegradedReason 成员集合', () => {
  // 显式枚举 + 源码 union + 运行时键集 三方一致。防的缺陷：
  // ① 有人给 LlmErrorCode 加新码却没补映射 ⇒ 运行时 CODE_TO_REASON[code] === undefined，
  //    前端 reason 分支落空；本断言（键集 === 枚举）当场变红。
  const allCodes: readonly LlmErrorCode[] = [
    'NO_ADAPTER',
    'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL',
    'AUTH',
    'RATE_LIMIT',
    'CONTEXT_WINDOW_EXCEEDED',
    'TIMEOUT',
    'NETWORK',
    'PROVIDER_ERROR',
    'ABORTED',
  ]
  assert.equal(allCodes.length >= 10, true, '反空洞：显式枚举不得被删空')
  assert.deepEqual(
    [...SOURCE_ERROR_CODES].sort(),
    [...allCodes].sort(),
    '显式枚举与 src/types.ts 的 LlmErrorCode union 已漂移：改 union 必须同步本测试与 CODE_TO_REASON',
  )
  assert.deepEqual(
    Object.keys(CODE_TO_REASON).sort(),
    [...allCodes].sort(),
    'CODE_TO_REASON 必须覆盖整个错误码集合，漏一个该码就落成 undefined reason',
  )
  // ② 落点集合 == 成员集合：多出成员 = 死枚举（永远不会被产生，前端却要为其写模型侧文案）；
  //    超出成员的落点 = 映射出未声明的值（Record 类型挡不住运行时手滑，运行时再挡一遍）。
  const values = new Set(Object.values(CODE_TO_REASON))
  assert.equal(values.size >= 8, true, '反空洞：映射目标不应少于 8 个 reason')
  assert.deepEqual(
    [...values].sort(),
    [...DEGRADED_REASONS].sort(),
    'DegradedReason 成员必须恰被 CODE_TO_REASON 全体命中：多出的成员是死枚举，缺失者是被映射出枚举外的值',
  )
})

/* ================= makeDegraded：redact 唯一出口 ================= */

test('makeDegraded：message 必经脱敏（本链路上 redact 的唯一出口），reason/code 原样透传', () => {
  // 防的缺陷：上游报错经常整段回显请求 URL 与鉴权头；任何一条降级路径漏了脱敏，
  // 等于把密钥发给浏览器（还会顺带进访问日志）。
  const secret = 'sk-abcdefghijklmnop1234567890'
  const d = makeDegraded('provider_error', 'PROVIDER_ERROR', `上游报错：鉴权失败（${secret}）`)
  assert.equal(d.reason, 'provider_error')
  assert.equal(d.code, 'PROVIDER_ERROR', 'reason/code 是分支依据，脱敏只动 message')
  assert.ok(!d.message.includes(secret), '密钥形态不得出现在外发 message 里')
  assert.match(d.message, /\*\*\*/, '应被替换为 *** 而不是整段丢弃')

  // 敏感头名后面的值：即便短到不命中密钥形态正则，也必须被遮蔽（头名规则与值形态无关）
  const bearer = makeDegraded('network', 'NETWORK', '上游回显：authorization: Bearer hunter2token')
  assert.ok(!bearer.message.includes('hunter2token'), '敏感头名后一律遮蔽')
  assert.equal(bearer.reason, 'network')
  assert.equal(bearer.code, 'NETWORK')
})

/* ================= noModelDegraded：生成前的必然降级投影 ================= */

test('noModelDegraded：存在可用路由 ⇒ null（补上密钥后下一次请求就该能用，不得提前判死）', () => {
  const llm = createLlmService()
  llm.register(stubProvider('ok', true))
  llm.register(NULL_PROVIDER) // 混入一条恒不可用的兜底路由：不影响结论
  assert.equal(noModelDegraded(llm), null)
})

test('noModelDegraded：llm-service 缺席 ⇒ no_provider + code null（没有上游参与，不得谎报 NO_ADAPTER）', () => {
  const d = noModelDegraded(undefined)
  assert.notEqual(d, null)
  assert.equal(d?.reason, 'no_provider')
  assert.equal(d?.code, null, '本侧自身产生的降级必须是 null code；编造上游码会误导排查方向')
  assert.match(String(d?.message), /@geewiki\/llm 未激活/)
})

test('noModelDegraded：路由已注册但全不可用 ⇒ NO_ADAPTER（与真跑生成同码同因）+ message 点名各路由 + tail 追加', () => {
  const llm = createLlmService()
  llm.register(stubProvider('ds', false, 'DeepSeek 网关'))
  llm.register(stubProvider('self', false, '自建网关'))
  const d = noModelDegraded(llm)
  assert.notEqual(d, null)
  // "提前判定"与"真跑一遍生成"必须同码同因，否则会出现"探测说可用、一调用就降级"的错位：
  // availableProviders() 为空时选路必然产出 NO_ADAPTER。
  assert.equal(d?.code, 'NO_ADAPTER')
  assert.equal(d?.reason, CODE_TO_REASON.NO_ADAPTER)
  assert.match(String(d?.message), /DeepSeek 网关\(ds\)/, 'message 要点名已注册路由，用户才知道去配哪一个')
  assert.match(String(d?.message), /自建网关\(self\)/)
  // tail 由各插件追加下游语义（问答会说"检索结果不受影响"，写作没有检索可说）
  const t = noModelDegraded(llm, '。AI 辅助写作需要可用的模型')
  assert.ok(String(t?.message).endsWith('。AI 辅助写作需要可用的模型'), 'tail 必须追加在 message 末尾')
  assert.match(String(t?.message), /DeepSeek 网关/, '追加 tail 不得挤掉路由清单')
  assert.ok(String(noModelDegraded(undefined, 'TAIL')?.message).endsWith('TAIL'), '缺席分支同样要吃到 tail')
})

/* ================= safeAvailable / listRouteInfos：抛错不拖垮投影 ================= */

test('safeAvailable：available() 抛错视为不可用（一个坏适配器不该让能力查询 500）', () => {
  // 防的缺陷：某个适配器在 available() 里读配置炸了，能力探测端点整个 500——
  // 用户看到的是"系统坏了"，而正确答案是"这个路由不可用"（与 llm-service 内部口径一致）。
  assert.equal(safeAvailable(() => {
    throw new Error('适配器初始化失败')
  }), false)
  assert.equal(safeAvailable(undefined), false, '没有查询函数 = 无从判定可用')
  assert.equal(safeAvailable(() => true), true)
  assert.equal(safeAvailable(() => false), false)
})

test('listRouteInfos：listProviders 抛错 ⇒ 空列表；单条路由 available 抛错 ⇒ 只标它自己不可用', () => {
  assert.deepEqual(listRouteInfos(undefined), [])
  const boom = {
    listProviders: () => {
      throw new Error('注册表坏了')
    },
  } as unknown as LlmService
  assert.deepEqual(listRouteInfos(boom), [], '注册表抛错要折算成"没有路由"，capabilities 端点报不可用而非 500')

  const llm = createLlmService()
  const broken: LlmProvider = {
    route: 'bad',
    descriptor: {
      route: 'bad',
      label: '坏掉的',
      vendor: 'test',
      model: 'm',
      available: () => {
        throw new Error('available 内部炸了')
      },
    },
    // 契约要求 AsyncIterable
    async *stream(): AsyncIterable<LlmChunk> {
      yield { type: 'error', code: 'PROVIDER_ERROR' }
    },
  }
  llm.register(broken)
  llm.register(stubProvider('good', true))
  // 一条坏路由不得连累其它路由的展示：字段原样保留，只把它的 available 折成 false
  assert.deepEqual(listRouteInfos(llm), [
    { route: 'bad', label: '坏掉的', vendor: 'test', model: 'm', available: false },
    { route: 'good', label: 'Stub-good', vendor: 'test', model: 'good-1', available: true },
  ])
})

test('listRouteInfos：label/model 里的形似密钥片段必须被脱敏（capabilities 是公开端点）', () => {
  /*
   * 防的缺陷（本批审出来的真问题）：`listRouteInfos` 把 descriptor 的字段**直接抄给调用方**，
   * 而 `makeDegraded` 那条"redact 的唯一出口"纪律管不到它。两个 `capabilities` 端点还是
   * `access: 'public'`（注册时三参形式 ⇒ 默认 public）⇒ 未登录就能读。
   * 今天出厂的 label 是静态字面量，看着无害；但 `@geewiki/openai` 的 `model` 是
   * **对用户设置的实时 getter** —— 这份列表外发的就是后台填进去的字符串，
   * 而"把密钥写在 baseUrl 的 basic-auth 里"是能工作的写法。
   * 判据：正常名字逐字不变（否则能力面板就废了），密钥形状必须变 `***`。
   */
  const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const llm = createLlmService()
  // 注：`register()` 收的是 **LlmProvider**（对外字段住在它的 `descriptor` 里），
  // 直接把 descriptor 摊平传进去会注册出一个 `listProviders()` 里的 undefined 条目。
  const leaky: LlmProvider = {
    route: 'leaky',
    descriptor: {
      route: 'leaky',
      // 真实世界里这会来自管理员填的 baseUrl（basic-auth 写法是能工作的）
      label: `自建网关 https://u:${secret}@gw.internal/v1`,
      vendor: 'openai',
      model: 'DeepSeek V4 Flash',
      available: () => true,
    },
    // 契约要求 AsyncIterable
    async *stream(): AsyncIterable<LlmChunk> {
      yield { type: 'error', code: 'PROVIDER_ERROR' }
    },
  }
  llm.register(leaky)
  const [info] = listRouteInfos(llm)
  assert.ok(info !== undefined)
  assert.equal(info!.label.includes(secret), false, `label 泄漏了疑似密钥：${info!.label}`)
  assert.ok(info!.label.includes('***'), '应看到脱敏标记，证明确实经过 redact')
  assert.equal(info!.model, 'DeepSeek V4 Flash', '正常模型名不得被改动（否则能力面板不可用）')
  assert.equal(info!.vendor, 'openai')
  assert.equal(info!.available, true, '脱敏不得影响判定')
})

/* ================= search_unavailable 的归属（源级钉桩） ================= */

test('DegradedReason：不含"功能没有资料地基"这类前提缺失（它们是功能错误码，不是模型降级）', () => {
  // 防的缺陷：把"检索地基不在"塞回模型降级词汇表 ⇒ 前端要为一条**永远不会由模型产生**
  // 的原因写模型侧文案。src/degrade.ts 文件头写明理由，本测试钉住这个决定。
  assert.ok(DEGRADED_REASONS.size >= 8, `反空洞：DegradedReason 应 ≥8 个成员，实际 ${DEGRADED_REASONS.size}`)
  assert.equal(DEGRADED_REASONS.has('search_unavailable'), false, 'search_unavailable 不得回到 DegradedReason')
  assert.equal(DEGRADED_REASONS.has('tools_unavailable'), false, 'tools_unavailable 不得回到 DegradedReason')
  /*
   * 双向守卫：它不是消失了，而是归了另一套词汇——所以这里去**它的新家**核实它在位。
   *
   * ★ 这条守卫在 P8 被迫改过一次落点，值得记档：它原先读 `plugin-ai-qa/src/types.ts` 的
   * `AskErrorCode`（那时 `search_unavailable` 属问答）。P8 把整个 `@geewiki/ai-qa` 删掉，
   * 于是守卫会**因为找不到文件而失败**——那是对的，它该失败；但它要防的缺陷（"这个词整个
   * 丢了"）换了名字继续存在：检索变成贡献工具之后，缺的不再是一个检索服务，
   * 而是**必需的那几条工具**，现在是 `@geewiki/ai-assistant` 的 `tools_unavailable`。
   * 守卫跟着词搬家，而不是跟着文件搬家。
   */
  const turnSrc = readFileSync(join(HERE, '../../plugin-ai-assistant/src/index.ts'), 'utf8')
  assert.ok(
    turnSrc.includes("'tools_unavailable'"),
    '功能前提缺失的词必须仍在位（现在叫 tools_unavailable，属 @geewiki/ai-assistant）',
  )
})
