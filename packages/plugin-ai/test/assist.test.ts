/**
 * AI 辅助写作（`POST /api/ai/assist`）的契约测试。
 *
 * **测试策略**：本模块被刻意设计成"不碰 HTTP、不碰数据库"的纯逻辑（见 `src/assist.ts`
 * 文件头），因此这里用**假 provider 与假权限判定**直接驱动，不起服务、不建临时库。
 * 真实 HTTP 链路（401/403/降级状态码的端到端形态）由隔离实例的 curl 验收覆盖。
 *
 * 本文件同时承载三条硬规则的**守卫断言**（红线不能被后人顺手改掉）：
 * 1. 上下文只来自请求体 ⇒ `assist.ts` 里不得出现取正文/检索的调用点；
 * 2. `slug` 只用于权限校验；
 * 3. 无可用模型时 `text` 恒为 `null`（绝不用任何文本兜底）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LlmChunk, LlmProvider, LlmRequest } from '@geewiki/llm'
import { createLlmService } from '@geewiki/llm'
import {
  ASSIST_ACTIONS,
  ASSIST_MAX_TOKENS,
  ASSIST_TEXT_MAX,
  assist,
  buildAssistMessages,
  hasEditContent,
  missingInput,
  pageEditableFrom,
  parseAssistBody,
  type AssistDeps,
  type AssistPageAccess,
} from '../src/assist.js'

const HERE = import.meta.dirname
const ASSIST_SRC = readFileSync(join(HERE, '../src/assist.ts'), 'utf8')

/** 去掉注释后的源码：守卫断言只看真实代码，避免被注释里的示例字符串误命中/误放过 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const OWNER = { kind: 'user', orgRole: 'owner' }
const MEMBER = { kind: 'user', orgRole: 'member' }
const VIEWER = { kind: 'user', orgRole: 'viewer' }
const ANON = { kind: 'anonymous', orgRole: null }

/** 假 provider：按脚本吐出 chunk，用于验证"有模型"路径的文本拼装 */
function stubProvider(chunks: LlmChunk[]): LlmProvider {
  return {
    route: 'stub',
    descriptor: {
      route: 'stub',
      label: 'Stub',
      vendor: 'test',
      model: 'stub-1',
      // ⚠️ `available` 是**函数**（降级契约的唯一入口），不是布尔字段：
      // 写成 `available: true` 会让服务判定为不可用，于是所有"有模型"用例都会静默走降级分支。
      available: () => true,
    },
    // eslint-disable-next-line require-yield -- 契约要求 AsyncIterable
    async *stream(_req: LlmRequest): AsyncIterable<LlmChunk> {
      for (const c of chunks) yield c
    },
  } as LlmProvider
}

function deps(over: Partial<AssistDeps> = {}): AssistDeps {
  return {
    getLlm: () => undefined,
    resolveEditAccess: async (): Promise<AssistPageAccess | null> => null,
    preGenerationDegraded: () => null,
    ...over,
  }
}

// ---------------- 输入校验 ----------------

test('parseAssistBody：四个动作都接受，缺必填输入各自报错', () => {
  for (const action of ASSIST_ACTIONS) {
    const okBody =
      action === 'continue'
        ? { action, before: '已经写好的一段' }
        : { action, selection: '选中的一段' }
    assert.equal(parseAssistBody(okBody).ok, true, `${action} 应被接受`)
  }
  // continue 缺 before
  const a = parseAssistBody({ action: 'continue' })
  assert.equal(a.ok, false)
  if (!a.ok) assert.equal(a.error, 'invalid_body')
  // rewrite 缺 selection
  const b = parseAssistBody({ action: 'rewrite' })
  assert.equal(b.ok, false)
  if (!b.ok) assert.match(b.message, /selection/)
  // 只能是空白字符也算缺失（trim 后判空）
  const c = parseAssistBody({ action: 'polish', selection: '   \n  ' })
  assert.equal(c.ok, false)
  // summarize 允许只用 before
  assert.equal(parseAssistBody({ action: 'summarize', before: '全文内容' }).ok, true)
  // missingInput 纯函数自证
  assert.equal(missingInput('continue', false, false), 'continue 需要提供 before（光标前的文本）')
  assert.equal(missingInput('rewrite', true, false), null)
})

test('parseAssistBody：非法动作、未知字段、非对象、超长、maxTokens 越界都拒绝', () => {
  const bad = parseAssistBody({ action: 'translate', selection: 'x' })
  assert.equal(bad.ok, false)
  if (!bad.ok) {
    assert.equal(bad.status, 400)
    assert.equal(bad.error, 'invalid_action')
  }
  const unknown = parseAssistBody({ action: 'continue', before: 'x', nope: 1 })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.message, /未知字段: nope/)

  for (const raw of [null, undefined, 42, 'str', ['array']]) {
    const r = parseAssistBody(raw)
    assert.equal(r.ok, false, `${JSON.stringify(raw)} 应被拒`)
    if (!r.ok) assert.equal(r.error, 'invalid_body')
  }
  const tooLong = parseAssistBody({ action: 'continue', before: 'x'.repeat(ASSIST_TEXT_MAX + 1) })
  assert.equal(tooLong.ok, false)
  if (!tooLong.ok) {
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.error, 'payload_too_large')
  }
  // 正好等于上限应被接受（边界不能差一）
  assert.equal(parseAssistBody({ action: 'continue', before: 'x'.repeat(ASSIST_TEXT_MAX) }).ok, true)
  const wrongType = parseAssistBody({ action: 'continue', before: 123 })
  assert.equal(wrongType.ok, false)
  if (!wrongType.ok) assert.match(wrongType.message, /before 必须是字符串/)

  for (const maxTokens of [0, -1, ASSIST_MAX_TOKENS + 1, 1.5, '1024']) {
    const r = parseAssistBody({ action: 'continue', before: 'x', maxTokens })
    assert.equal(r.ok, false, `maxTokens=${String(maxTokens)} 应被拒`)
    if (!r.ok) assert.equal(r.error, 'invalid_maxTokens')
  }
  const okMax = parseAssistBody({ action: 'continue', before: 'x', maxTokens: 77 })
  assert.equal(okMax.ok, true)
  if (okMax.ok) assert.equal(okMax.value.maxTokens, 77)
})

test('parseAssistBody：每个动作有各自的默认 token 预算，且不超过硬上限', () => {
  const budgets = new Map<string, number>()
  for (const action of ASSIST_ACTIONS) {
    const body = action === 'continue' ? { action, before: 'x' } : { action, selection: 'x' }
    const r = parseAssistBody(body)
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.ok(r.value.maxTokens > 0 && r.value.maxTokens <= ASSIST_MAX_TOKENS)
      budgets.set(action, r.value.maxTokens)
    }
  }
  // 反空洞：确认真的取到了四个动作的预算（否则上面的循环可能一个都没跑）
  assert.equal(budgets.size, ASSIST_ACTIONS.length)
})

// ---------------- 提示词拼装（上下文来源的唯一入口） ----------------

test('buildAssistMessages：只含系统提示词与用户文本，不夹带其它来源', () => {
  const msgs = buildAssistMessages('continue', { selection: '', before: '前半段', title: '我的标题' })
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]?.role, 'system')
  assert.equal(msgs[1]?.role, 'user')
  assert.match(String(msgs[1]?.content), /前半段/)
  assert.match(String(msgs[1]?.content), /我的标题/)
  // 续写不得把 selection 混进来（否则等于让模型重复用户没选的内容）
  assert.doesNotMatch(String(msgs[1]?.content), /选中的段落/)

  const rewrite = buildAssistMessages('rewrite', { selection: '要改的段落', before: '光标前', title: '' })
  assert.match(String(rewrite[1]?.content), /要改的段落/)
  assert.doesNotMatch(String(rewrite[1]?.content), /光标前/)
  // 空标题不得产生空括号
  assert.doesNotMatch(String(rewrite[1]?.content), /本文标题/)
})

// ---------------- 权限 ----------------

test('hasEditContent：owner/admin/member 为真；viewer、匿名、undefined 为假', () => {
  assert.equal(hasEditContent(OWNER), true)
  assert.equal(hasEditContent({ kind: 'user', orgRole: 'admin' }), true)
  assert.equal(hasEditContent(MEMBER), true)
  assert.equal(hasEditContent(VIEWER), false)
  assert.equal(hasEditContent(ANON), false)
  assert.equal(hasEditContent({ kind: 'user', orgRole: null }), false)
  assert.equal(hasEditContent(undefined), false)
  // 断链：应急通道不是"用户"，不得因此获得写作能力
  assert.equal(hasEditContent({ kind: 'break-glass', orgRole: null }), false)
})

test('pageEditableFrom：缺失/null/level none/canEdit 假 一律失败关闭', () => {
  assert.equal(pageEditableFrom(null), false)
  assert.equal(pageEditableFrom(undefined), false)
  assert.equal(pageEditableFrom({ level: 'none', canEdit: false }), false)
  assert.equal(pageEditableFrom({ level: 'none', canEdit: true }), false, 'level=none 即便 canEdit 为真也不放行')
  assert.equal(pageEditableFrom({ level: 'read', canEdit: false }), false)
  assert.equal(pageEditableFrom({ level: 'full', canEdit: true }), true)
})

test('assist：匿名/只读 403，且**先判权限再看降级**（降级不能变成权限探测通道）', async () => {
  let degradedAsked = false
  const d = deps({
    preGenerationDegraded: () => {
      degradedAsked = true
      return { reason: 'no_provider', code: 'NO_ADAPTER', message: '没模型' }
    },
  })
  for (const principal of [ANON, VIEWER, undefined]) {
    const out = await assist(principal, { action: 'continue', before: 'x' }, d)
    assert.equal(out.status, 403)
  }
  // 关键：被判 403 的请求**没有**去问降级状态 —— 否则无权限者能从响应差异里探测出模型配置
  assert.equal(degradedAsked, false, '权限未通过时不得触达降级投影')
})

test('assist：带 slug 时收紧到该页可编辑；判定函数只拿到 slug、不取正文', async () => {
  const seen: string[] = []
  const denied = deps({
    resolveEditAccess: async (_p, slug) => {
      seen.push(slug)
      return { level: 'read', canEdit: false }
    },
  })
  const out = await assist(MEMBER, { action: 'continue', before: 'x', slug: 'some/page' }, denied)
  assert.equal(out.status, 403)
  if (out.status === 403) assert.match(String((out.body as { message: string }).message), /没有编辑该条目/)
  assert.deepEqual(seen, ['some/page'])

  // policy-service 缺失（返回 null）⇒ 失败关闭
  const missingPolicy = deps({ resolveEditAccess: async () => null })
  assert.equal((await assist(MEMBER, { action: 'continue', before: 'x', slug: 'a' }, missingPolicy)).status, 403)

  // 无 slug 时不得调用页级判定
  let called = false
  const noSlug = deps({
    resolveEditAccess: async () => {
      called = true
      return { level: 'full', canEdit: true }
    },
    preGenerationDegraded: () => ({ reason: 'no_provider', code: 'NO_ADAPTER', message: '没模型' }),
  })
  await assist(MEMBER, { action: 'continue', before: 'x' }, noSlug)
  assert.equal(called, false)
})

// ---------------- 降级与生成 ----------------

test('assist：无可用模型 ⇒ 502 + mode unavailable + text 恒为 null（绝不用任何文本兜底）', async () => {
  const out = await assist(
    OWNER,
    { action: 'rewrite', selection: '段落' },
    deps({ preGenerationDegraded: () => ({ reason: 'no_provider', code: 'NO_ADAPTER', message: '没有可用模型路由' }) }),
  )
  assert.equal(out.status, 502)
  const body = out.body as { mode: string; text: unknown; degraded: { code: string | null } }
  assert.equal(body.mode, 'unavailable')
  assert.equal(body.text, null)
  assert.equal(body.degraded.code, 'NO_ADAPTER')
  assert.equal(ASSIST_SRC.includes('extractiveSummary'), false, 'assist 不得引用抽取式摘要')
})

test('assist：llm-service 缺失 ⇒ 502 unavailable', async () => {
  const out = await assist(OWNER, { action: 'continue', before: 'x' }, deps({ getLlm: () => undefined }))
  assert.equal(out.status, 502)
  assert.equal((out.body as { text: unknown }).text, null)
})

test('assist：真实 llm 服务无 provider ⇒ NO_ADAPTER 降级（与生产现状一致）', async () => {
  const llm = createLlmService()
  const out = await assist(
    OWNER,
    { action: 'continue', before: '正文' },
    deps({
      getLlm: () => llm,
      // 与 index.ts 的 preGenerationDegraded() 同源判据：无可用 provider
      preGenerationDegraded: () =>
        llm.availableProviders().length > 0
          ? null
          : { reason: 'no_provider', code: 'NO_ADAPTER', message: '模型不可用（NO_ADAPTER）' },
    }),
  )
  assert.equal(out.status, 502)
  assert.equal((out.body as { text: unknown }).text, null)
  assert.equal((out.body as { degraded: { code: string } }).degraded.code, 'NO_ADAPTER')
})

test('assist：有可用 provider ⇒ 200 generated，文本按 delta 拼装', async () => {
  const llm = createLlmService()
  llm.register(
    stubProvider([
      { type: 'status', provider: 'stub', model: 'stub-1' },
      { type: 'text-delta', text: '你好' },
      { type: 'text-delta', text: '，世界' },
      { type: 'done', provider: 'stub', model: 'stub-1' },
    ]),
  )
  const out = await assist(OWNER, { action: 'continue', before: '前文' }, deps({ getLlm: () => llm }))
  assert.equal(out.status, 200)
  const body = out.body as { ok: boolean; mode: string; text: string | null; degraded: unknown }
  assert.equal(body.ok, true)
  assert.equal(body.mode, 'generated')
  assert.equal(body.text, '你好，世界')
  assert.equal(body.degraded, null)
})

test('assist：provider 报错 ⇒ 502 且 text 为 null（半截产物不得当完整回答发出）', async () => {
  const llm = createLlmService()
  llm.register(
    stubProvider([
      { type: 'status', provider: 'stub', model: 'stub-1' },
      { type: 'text-delta', text: '半截' },
      { type: 'error', code: 'RATE_LIMIT' },
    ]),
  )
  const out = await assist(OWNER, { action: 'polish', selection: '段落' }, deps({ getLlm: () => llm }))
  assert.equal(out.status, 502)
  const body = out.body as { text: unknown; degraded: { code: string | null } }
  assert.equal(body.text, null, '有部分文本也必须置 null —— 前端只能显示"不可用"，不能显示半截产物')
  assert.equal(body.degraded.code, 'RATE_LIMIT')
})

test('assist：非法输入优先于权限与降级（400 先于 403/502）', async () => {
  // 匿名 + 非法 action ⇒ 400（输入校验在最前，避免"先鉴权"泄露动作清单之外的信息）
  const bad = await assist(ANON, { action: 'nope' }, deps())
  assert.equal(bad.status, 400)
  // 有权限但缺必填 ⇒ 400 而不是 502
  const missing = await assist(OWNER, { action: 'rewrite' }, deps())
  assert.equal(missing.status, 400)
})

// ---------------- 硬规则守卫（源码级） ----------------

test('守卫：assist.ts 不得出现任何"取正文/检索"的调用点（块级权限红线）', () => {
  const code = codeOnly(ASSIST_SRC)
  assert.ok(code.length > 2000, '反空洞：源码读取失败时本测试必须变红')
  for (const forbidden of [
    'search-service',
    'contents(',
    'retrieve(',
    'getPage(',
    'FROM pages',
    'page_versions',
  ]) {
    assert.equal(code.includes(forbidden), false, `assist.ts 不得出现 ${forbidden}`)
  }
  // 反向自证：确实提到了权限判定的入口，防止"整段代码被删空"也算通过
  assert.ok(code.includes('resolveEditAccess'), 'assist.ts 应通过注入的判定函数拿访问结论')
  assert.ok(code.includes('canEdit'), 'assist.ts 应使用 canEdit 判据')
})
