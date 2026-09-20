/**
 * Agent loop 的行为测试。
 *
 * 用**脚本化的假 provider** 而不是真上游：本文件要钉住的是**协议与纪律**
 * （每个调用都有配对结果、截断必须说出来、空 id 不可执行、轮次上限如实上报），
 * 这些性质在真模型上不可复现（真模型不会恰好返回一个空 id 的调用），
 * 而它们恰恰是"偶发 400""模型以为查过了"这类最难查的问题的成因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Principal } from '@geewiki/core'
import type { AiToolResult, ResolvedTool } from '@geewiki/ai-tools'
import type { LlmChunk, LlmErrorCode, LlmRequest, LlmService } from '@geewiki/llm'
import { abortMessageOf, runAgentLoop, type LoopEvent, type LoopOptions } from '../src/loop.js'
import type { TurnMessage } from '../src/types.js'

const principal: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}

/* ============================== 假 provider ============================== */

interface RoundScript {
  readonly text?: string
  /** 推理型模型的思考内容（先于 `text` 产出，与真实上游同序） */
  readonly reasoning?: string
  readonly calls?: readonly { id: string; name: string; arguments: string }[]
  readonly finishReason?: string
  readonly errorCode?: LlmErrorCode
  readonly usage?: { promptTokens?: number; completionTokens?: number }
}

interface ScriptedLlm {
  readonly svc: LlmService
  /** 每次 `stream()` 收到的请求（用来断言"请求里到底有没有 tools 键"） */
  readonly requests: LlmRequest[]
}

/**
 * 按脚本逐轮返回 chunk。
 *
 * 工具调用**按上游的真实分片形态**发两帧（首帧给 id/name + 空 arguments，
 * 次帧给 arguments 片段）——只发一帧会让 `assembleToolCalls` 的一条分支永远不被覆盖。
 */
function scriptedLlm(scripts: readonly RoundScript[]): ScriptedLlm {
  const requests: LlmRequest[] = []
  let round = 0
  const svc = {
    stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      requests.push(req)
      const script = scripts[Math.min(round, scripts.length - 1)] ?? {}
      round++
      return (async function* generate(): AsyncGenerator<LlmChunk> {
        yield { type: 'status', provider: 'fake', model: 'fake-model' }
        // 思考**先于正文**（与真实推理型上游同序：先 reasoning_content 再 content）
        if (script.reasoning !== undefined && script.reasoning !== '') {
          yield { type: 'reasoning-delta', text: script.reasoning }
        }
        if (script.text !== undefined && script.text !== '') {
          yield { type: 'text-delta', text: script.text }
        }
        for (const [index, call] of (script.calls ?? []).entries()) {
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: '' }
          if (call.arguments !== '') {
            yield { type: 'tool-call-delta', index, argumentsDelta: call.arguments }
          }
        }
        if (script.errorCode !== undefined) {
          yield { type: 'error', code: script.errorCode }
          return
        }
        yield {
          type: 'done',
          provider: 'fake',
          model: 'fake-model',
          ...(script.usage !== undefined ? { usage: script.usage } : {}),
          finishReason: script.finishReason ?? ((script.calls?.length ?? 0) > 0 ? 'tool_calls' : 'stop'),
        }
      })()
    },
  }
  return { svc: svc as unknown as LlmService, requests }
}

/* ============================== 假工具 ============================== */

function fakeTool(
  name: string,
  side: 'server' | 'client',
  impl?: (args: unknown) => Promise<AiToolResult> | AiToolResult,
  /*
   * 第 4 个参数是后补的：夹具原先**从不设 `mutating`**，于是"写工具名单"那条路径
   * 在单测里从来没有真正被走到（第一次写用例时 `mutatingTools` 恒为空，才发现夹具缺这个开关）。
   */
  mutating = false,
): ResolvedTool {
  return {
    owner: 'owner-test',
    descriptor: { name, description: `${name} 的说明`, parameters: { type: 'object' }, side, mutating },
    execute: async (_p: Principal, args: unknown) => (impl ? impl(args) : { content: `{"tool":"${name}"}` }),
  }
}

/* ============================== 夹具 ============================== */

function opts(over: Partial<LoopOptions> & { llm: LlmService }): LoopOptions {
  return {
    principal,
    context: { conversationId: 'c-test', turnId: 't-test' },
    tools: [],
    messages: [{ role: 'user', content: '你好' }],
    page: null,
    maxRounds: 6,
    maxToolResultChars: 8000,
    maxHistoryMessages: 40,
    signal: new AbortController().signal,
    ...over,
  }
}

async function run(
  options: LoopOptions,
): Promise<{ outcome: Awaited<ReturnType<typeof runAgentLoop>>; events: LoopEvent[] }> {
  const events: LoopEvent[] = []
  const outcome = await runAgentLoop(options, (ev) => events.push(ev))
  return { outcome, events }
}

/**
 * **核心不变量**：`assistant.toolCalls` 里每个 `id` 都必须有恰好一条同 `toolCallId` 的
 * `tool` 消息。少一条，下一次请求就是一个"孤儿调用"，多数网关**直接 400**，
 * 而报错点离病因（我们悄悄跳过了某条调用）很远。
 */
function assertPairing(messages: readonly TurnMessage[], where: string): void {
  const requested: string[] = []
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) requested.push(call.id)
  }
  const answered = messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)
  for (const id of requested) {
    const hits = answered.filter((a) => a === id).length
    assert.equal(hits, 1, `${where}：调用 ${id} 应有恰好一条配对结果，实际 ${hits} 条`)
  }
  assert.equal(answered.length, requested.length, `${where}：结果条数应等于调用条数`)
  for (const m of messages.filter((x) => x.role === 'tool')) {
    assert.ok(m.toolCallId !== undefined && m.toolCallId !== '', `${where}：tool 消息必须带 toolCallId`)
  }
}

/* ============================== 基本形态 ============================== */

test('一轮答完：answer 与转录正确，rounds=1，无 pending', async () => {
  const { svc } = scriptedLlm([{ text: '你好，我是助手。' }])
  const { outcome } = await run(opts({ llm: svc }))
  assert.equal(outcome.error, null)
  assert.equal(outcome.answer, '你好，我是助手。')
  assert.equal(outcome.finishReason, 'stop')
  assert.equal(outcome.pendingToolCalls, null)
  assert.equal(outcome.rounds, 1)
  assert.deepEqual(
    outcome.messages.map((m) => m.role),
    ['user', 'assistant'],
  )
  assertPairing(outcome.messages, '一轮答完')
})

test('★ 思考内容只往外发：不进 answer、不进转录、也不出现在回传给上游的请求里', async () => {
  const thinking = '先看看知识库里有没有相关页面……'
  const { svc, requests } = scriptedLlm([{ reasoning: thinking, text: '答案是 A。' }])
  const { outcome, events } = await run(opts({ llm: svc }))
  // ① 它是一条**独立的** `reasoning` 事件（界面据此折叠渲染，不与正文混流）
  assert.deepEqual(
    events.filter((e) => e.type === 'reasoning').map((e) => (e.type === 'reasoning' ? e.text : '')),
    [thinking],
  )
  // ② 它不是回答
  assert.equal(outcome.answer, '答案是 A。')
  const assistant = outcome.messages.filter((m) => m.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0]?.content, '答案是 A。')
  // ③ 也不进转录：多轮时转录会整份回传给上游，带上思考内容会被网关拒收/当成新指令
  assert.equal(
    outcome.messages.some((m) => m.content.includes(thinking)),
    false,
    '思考内容不得进入转录（它是给人看的，不是给模型的）',
  )
  assert.equal(JSON.stringify(requests).includes(thinking), false, '请求里也不该出现思考内容')
})

test('没有工具时，请求体里**不出现** tools 键（沿用 P0 的口径：不填 ≠ 发空数组）', async () => {
  const { svc, requests } = scriptedLlm([{ text: 'ok' }])
  await run(opts({ llm: svc, tools: [] }))
  assert.equal(requests.length, 1)
  assert.equal('tools' in (requests[0] as object), false, 'tools 键不得出现')
})

test('有工具时，请求体里出现 tools 且名字与顺序与工具表一致', async () => {
  const { svc, requests } = scriptedLlm([{ text: 'ok' }])
  await run(opts({ llm: svc, tools: [fakeTool('search_kb', 'server'), fakeTool('read_page', 'server')] }))
  assert.deepEqual(
    requests[0]?.tools?.map((t) => t.name),
    ['search_kb', 'read_page'],
  )
})

test('系统提示**不在**转录里，但每轮请求都带上它（转录是客户端往返的那份，不含系统提示）', async () => {
  const { svc, requests } = scriptedLlm([{ text: 'ok' }])
  const { outcome } = await run(opts({ llm: svc }))
  assert.equal(outcome.messages.some((m) => m.role === ('system' as never)), false)
  assert.equal(requests[0]?.messages[0]?.role, 'system')
})

/* ============================== 工具执行 ============================== */

test('服务端工具被真正执行，结果以 tool 角色回灌，且留下配对', async () => {
  let executed: unknown = null
  const { svc, requests } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'search_kb', arguments: '{"q":"新建"}' }] },
    { text: '查到了。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [fakeTool('search_kb', 'server', (args) => {
        executed = args
        return { content: '{"total":1,"hits":["home"]}' }
      })],
    }),
  )
  assert.deepEqual(executed, { q: '新建' })
  assert.equal(outcome.rounds, 2)
  assert.equal(outcome.answer, '查到了。')
  assertPairing(outcome.messages, '服务端工具')
  const toolMessage = outcome.messages.find((m) => m.role === 'tool')
  assert.equal(toolMessage?.content, '{"total":1,"hits":["home"]}')
  assert.equal(toolMessage?.name, 'search_kb')
  // 第二轮的请求里必须有那条工具结果（否则模型看不见它，会重复调用）
  assert.ok(requests[1]?.messages.some((m) => m.role === 'tool' && m.toolCallId === 'c1'))
})

test('工具抛错**不炸整个回合**：折算成一条可读的失败结果，模型可以换路', async () => {
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'boom', arguments: '{}' }] },
    { text: '那个工具坏了，我换个办法。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [fakeTool('boom', 'server', () => {
        throw new Error('内部错误 /root/secret/path')
      })],
    }),
  )
  assert.equal(outcome.error, null)
  assert.equal(outcome.answer, '那个工具坏了，我换个办法。')
  const toolMessage = outcome.messages.find((m) => m.role === 'tool')
  assert.match(toolMessage?.content ?? '', /tool_failed/)
  assert.equal(outcome.toolResults[0]?.ok, false)
  assert.match(outcome.toolResults[0]?.summary ?? '', /执行失败/)
})

test('模型报了一个不存在的工具名：**仍留下配对结果**，且绝不执行任何东西', async () => {
  let executed = 0
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'delete_everything', arguments: '{}' }] },
    { text: '没有这个工具，我换个方式。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [fakeTool('search_kb', 'server', () => {
        executed++
        return { content: '{}' }
      })],
    }),
  )
  assert.equal(executed, 0, '名字不在交集里就什么都别执行')
  assertPairing(outcome.messages, '未知工具')
  assert.match(outcome.messages.find((m) => m.role === 'tool')?.content ?? '', /unknown_tool/)
  assert.equal(outcome.toolResults[0]?.ok, false)
  assert.match(outcome.toolResults[0]?.summary ?? '', /未知工具/)
})

test('多条调用一次发出时，逐个执行且逐个配对（含一好一坏）', async () => {
  const { svc } = scriptedLlm([
    {
      calls: [
        { id: 'c1', name: 'ok_tool', arguments: '{}' },
        { id: 'c2', name: 'bad_tool', arguments: '{}' },
        { id: 'c3', name: 'nope', arguments: '{}' },
      ],
    },
    { text: '好。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [
        fakeTool('ok_tool', 'server'),
        fakeTool('bad_tool', 'server', () => {
          throw new Error('boom')
        }),
      ],
    }),
  )
  assertPairing(outcome.messages, '多条调用')
  assert.equal(outcome.toolResults.length, 3)
  assert.deepEqual(outcome.toolResults.map((r) => r.ok), [true, false, false])
})

/* ============================== 客户端工具 ============================== */

test('客户端工具：服务端**先把自己该跑的跑完**，再把控制权交回去', async () => {
  let serverRan = 0
  const { svc } = scriptedLlm([
    {
      calls: [
        { id: 's1', name: 'search_kb', arguments: '{}' },
        { id: 'k1', name: 'editor.replace', arguments: '{"text":"x"}' },
      ],
    },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [
        fakeTool('search_kb', 'server', () => {
          serverRan++
          return { content: '{"total":0}' }
        }),
        fakeTool('editor.replace', 'client'),
      ],
    }),
  )
  assert.equal(serverRan, 1, '服务端工具必须先执行掉，否则客户端要再跑一趟服务端')
  assert.equal(outcome.finishReason, 'tool_calls')
  assert.equal(outcome.answer, null)
  assert.deepEqual(outcome.pendingToolCalls?.map((c) => c.id), ['k1'], 'pending 里只该有客户端那些')
  // 服务端那条的结果必须已经在转录里（客户端下一次原样带上，服务端不记得任何事）
  assert.ok(outcome.messages.some((m) => m.role === 'tool' && m.toolCallId === 's1'))
  assert.equal(outcome.messages.some((m) => m.role === 'tool' && m.toolCallId === 'k1'), false)
  assertPairing(
    [...outcome.messages, { role: 'tool' as const, content: '{}', toolCallId: 'k1' }],
    '客户端工具补上结果后',
  )
})

test('客户端工具不会被外发成 tool-start 活动（它由客户端自己跑）', async () => {
  const { svc } = scriptedLlm([{ calls: [{ id: 'k1', name: 'editor.replace', arguments: '{}' }] }])
  const { events } = await run(opts({ llm: svc, tools: [fakeTool('editor.replace', 'client')] }))
  assert.equal(events.some((e) => e.type === 'tool-start'), false)
})

/* =============== 中止原因必须能区分（用户问"这是什么情况"） =============== */

test('★ 中止原因映射：四种处境给四句可执行的文案，不再共用"超时或断开"', () => {
  /*
   * 起因：用户截了一张图问"这是什么情况"——那一轮跑了 10 个读工具后被中止，
   * 界面只写着「本轮已取消（超时或客户端断开）」，看不出是上游卡住、自身超限、页面离开还是运维动作。
   * 现在原因一路从 `AbortSignal.reason` 带到这里，且文案给出**下一步**。
   */
  const idle = abortMessageOf('idle_timeout', 10)
  const hard = abortMessageOf('hard_timeout', 10)
  const gone = abortMessageOf('client_disconnect', 0)
  const shut = abortMessageOf('shutdown', 0)
  assert.match(idle, /本轮长时间没有任何进展/, '空闲超时要说"没有任何进展"，而不是替用户断定是上游')
  assert.match(idle, /「继续」/, '要给下一步（继续）')
  assert.match(idle, /上游没有响应，或某个工具卡住/, '两种可能都要说（用户实测上游是有反应的，不能把锅扣给它）')
  assert.match(idle, /已执行 10 个工具/, '要告诉用户已跑完的成果还在')
  assert.match(hard, /硬性时限/, '硬限要点明是时限')
  assert.match(hard, /拆小/, '硬限的建议是"把要求拆小"')
  assert.match(gone, /页面已离开或连接断开/)
  assert.match(shut, /服务正在关闭或插件被卸载/)
  for (const m of [idle, hard, gone, shut]) {
    assert.ok(!m.includes('超时或客户端断开'), '这四条不得再退回那句模糊文案')
  }
  // 未知原因（老调用方、别的 aborter）仍要能显示，不能变成空白
  assert.match(abortMessageOf(undefined, 0), /本轮已取消/)
  assert.match(abortMessageOf({ weird: true }, 3), /已执行 3 个工具/)
})

test('★ 真的被 abort 时，outcome 用的是带原因的文案（不是硬编码那句）', async () => {
  const { svc } = scriptedLlm([{ text: '做了一半…', calls: undefined }])
  const ac = new AbortController()
  ac.abort('idle_timeout')
  const { outcome } = await run(opts({ llm: svc, signal: ac.signal }))
  assert.equal(outcome.error?.code, 'ABORTED')
  assert.match(outcome.error?.message ?? '', /本轮长时间没有任何进展/)
  assert.equal(outcome.rounds, 0, '还没开始任何一轮就被中止')
})

/* =============== 写工具名单必须跨轮累积（用户报的"AI 改完不刷新"） =============== */

test('★ 写工具跑完后模型直接收尾：mutatingTools 仍必须包含它（原实现取最后一轮的 pending ⇒ 恒为空）', async () => {
  /*
   * 真实缺陷（2026-09-16）：模型第 1 轮调 `editor.replace`（mutating），第 2 轮只说一句话就收尾。
   * 原实现把名单算作"最后一轮 `pending` 里的写工具"，而收尾那一轮没有 pending ⇒ 名单是 `[]`。
   * 客户端据此判定"这一回合没有写操作"，于是**AI 改完正文后页面不刷新**
   * （变更日志的接线也永远收不到信号）。
   * 现在在执行处跨轮累加，与"在哪一轮跑的"无关。
   */
  const { svc } = scriptedLlm([
    { calls: [{ id: 's1', name: 'page.update', arguments: '{"slug":"a","content":"x"}' }] },
    { text: '改好了。' },
  ])
  const { outcome } = await run(
    // 用**服务端**写工具：客户端工具那一支会以 `tool_calls` 把控制权交还浏览器，
    // 而真实失手场景是服务端工具跑完、模型下一轮直接收尾（那一帧没有任何 pending）
    opts({
      llm: svc,
      tools: [fakeTool('page.update', 'server', () => ({ content: '{"ok":true}' }), true)],
    }),
  )
  assert.equal(outcome.finishReason, 'stop')
  assert.deepEqual(outcome.mutatingTools, ['page.update'], '收尾帧也必须带着第 1 轮那次写操作')
  assert.equal(outcome.pendingToolCalls, null, '这一帧确实没有待执行的调用（正是原实现失手的前提）')
})

test('读工具不进名单；同一个写工具跑两次只登记一次（去重）', async () => {
  const { svc } = scriptedLlm([
    {
      calls: [
        { id: 's1', name: 'search_kb', arguments: '{}' },
        { id: 's2', name: 'page.update', arguments: '{"slug":"a","content":"1"}' },
      ],
    },
    { calls: [{ id: 's3', name: 'page.update', arguments: '{"slug":"a","content":"2"}' }] },
    { text: '好了。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [
        fakeTool('search_kb', 'server', () => ({ content: '{"total":0}' })),
        fakeTool('page.update', 'server', () => ({ content: '{"ok":true}' }), true),
      ],
    }),
  )
  assert.deepEqual(outcome.mutatingTools, ['page.update'], '只报写工具，且去重')
})

/* ============================== 硬约束：空 id ============================== */

test('★ 上游没给 id 的调用：整轮以 invalid_tool_call 失败，不猜、不丢', async () => {
  const { svc } = scriptedLlm([{ calls: [{ id: '', name: 'search_kb', arguments: '{}' }] }])
  const { outcome } = await run(opts({ llm: svc, tools: [fakeTool('search_kb', 'server')] }))
  assert.equal(outcome.error?.code, 'invalid_tool_call')
  assert.match(outcome.error?.message ?? '', /缺少 id/)
  assert.equal(outcome.answer, null)
})

/* ============================== 截断 ============================== */

test('★ 工具结果超预算被截断，且**截断这件事写在文本里**（不注明＝把"我没看到"伪装成"资料里没有"）', async () => {
  const long = 'A'.repeat(500)
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'big', arguments: '{}' }] },
    { text: '看完了。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      maxToolResultChars: 100,
      tools: [fakeTool('big', 'server', () => ({ content: long }))],
    }),
  )
  const content = outcome.messages.find((m) => m.role === 'tool')?.content ?? ''
  assert.ok(content.startsWith('A'.repeat(100)), '前 100 字符原样保留')
  assert.match(content, /共 500 字符/)
  assert.match(content, /只含前 100 字符/)
  assert.match(content, /不要.*断言/, '必须明确告诉模型不要据此断言"没有"')
})

test('工具结果不超预算时逐字不改（不得凭空加注）', async () => {
  const exact = 'B'.repeat(100)
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'big', arguments: '{}' }] },
    { text: 'ok' },
  ])
  const { outcome } = await run(
    opts({ llm: svc, maxToolResultChars: 100, tools: [fakeTool('big', 'server', () => ({ content: exact }))] }),
  )
  assert.equal(outcome.messages.find((m) => m.role === 'tool')?.content, exact)
})

/* ============================== 上限与失败 ============================== */

test('★ 撞上轮次上限：finishReason=rounds，如实上报而不是把半截文本当正常回答', async () => {
  /*
   * 每轮都请求工具、永远不收口。**每轮的调用 id 必须不同**——真实上游每轮都会给新 id，
   * 而复用同一个 id 会让"调用与结果的配对"在转录里退化成一对多（本用例第一版就这么错过，
   * assertPairing 把它抓了出来：'调用 c1 应有恰好一条配对结果，实际 3 条'）。
   */
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'loop_tool', arguments: '{}' }] },
    { calls: [{ id: 'c2', name: 'loop_tool', arguments: '{}' }] },
    { calls: [{ id: 'c3', name: 'loop_tool', arguments: '{}' }] },
  ])
  const { outcome } = await run(
    opts({ llm: svc, maxRounds: 3, tools: [fakeTool('loop_tool', 'server')] }),
  )
  assert.equal(outcome.finishReason, 'rounds')
  assert.equal(outcome.rounds, 3)
  assertPairing(outcome.messages, '轮次用尽')
})

test('finishReason=length 被如实透传（模型的话可能是半截的）', async () => {
  const { svc } = scriptedLlm([{ text: '这是一句没写完的话', finishReason: 'length' }])
  const { outcome } = await run(opts({ llm: svc }))
  assert.equal(outcome.finishReason, 'length')
})

test('上游报错：error.code 透传，且不是 invalid_tool_call 那种本层判定', async () => {
  const { svc } = scriptedLlm([{ errorCode: 'RATE_LIMIT' }])
  const { outcome } = await run(opts({ llm: svc }))
  assert.equal(outcome.error?.code, 'RATE_LIMIT')
  assert.match(outcome.error?.message ?? '', /RATE_LIMIT/)
  assert.equal(outcome.answer, null)
})

test('NO_ADAPTER 的说明指向"没有可用路由"，其它错误指向"上游拒绝了"（两者该做的事相反）', async () => {
  const a = await run(opts({ llm: scriptedLlm([{ errorCode: 'NO_ADAPTER' }]).svc }))
  assert.match(a.outcome.error?.message ?? '', /没有已注册或可用/)
  const b = await run(opts({ llm: scriptedLlm([{ errorCode: 'TIMEOUT' }]).svc }))
  assert.match(b.outcome.error?.message ?? '', /是它拒绝了或没能及时返回/)
  assert.doesNotMatch(b.outcome.error?.message ?? '', /没有已注册/)
})

test('已取消的信号：返回 ABORTED，且不再往下跑', async () => {
  const ac = new AbortController()
  ac.abort()
  const { svc, requests } = scriptedLlm([{ text: '不该出现' }])
  const { outcome } = await run(opts({ llm: svc, signal: ac.signal }))
  assert.equal(outcome.error?.code, 'ABORTED')
  assert.equal(requests.length, 0, '已取消就不该再发起上游请求')
})

/* ============================== usage 与活动 ============================== */

test('usage 跨轮**累加**（每轮都是一次独立的上游请求，成本应当相加）', async () => {
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 't', arguments: '{}' }], usage: { promptTokens: 10, completionTokens: 2 } },
    { text: 'done', usage: { promptTokens: 20, completionTokens: 3 } },
  ])
  const { outcome } = await run(opts({ llm: svc, tools: [fakeTool('t', 'server')] }))
  assert.equal(outcome.usage?.promptTokens, 30)
  assert.equal(outcome.usage?.completionTokens, 5)
})

test('活动事件成对出现：tool-start 后必有同 id 的 tool-end，且 done 的清单与之一致', async () => {
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 't', arguments: '{"a":1}' }] },
    { text: 'ok' },
  ])
  const { outcome, events } = await run(opts({ llm: svc, tools: [fakeTool('t', 'server')] }))
  const starts = events.filter((e) => e.type === 'tool-start')
  const ends = events.filter((e) => e.type === 'tool-end')
  assert.equal(starts.length, 1)
  assert.equal(ends.length, 1)
  assert.equal(starts[0]?.type === 'tool-start' ? starts[0].arguments : '', '{"a":1}')
  assert.equal(outcome.toolResults.length, 1)
  assert.equal(outcome.toolResults[0]?.id, 'c1')
})

test('delta 事件与 answer 逐字一致（流式与最终答案不会漂）', async () => {
  const { svc } = scriptedLlm([{ text: '一二三四五' }])
  const { outcome, events } = await run(opts({ llm: svc }))
  const streamed = events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : '')).join('')
  assert.equal(streamed, outcome.answer)
})

/* ============================== 参数解析 ============================== */

test('模型给了坏 JSON 参数：不抛，折算成一条可读的说明交给它自己改', async () => {
  let received: unknown = 'unset'
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 't', arguments: '{"q":' }] },
    { text: '我改一下参数。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [fakeTool('t', 'server', (args) => {
        received = args
        return { content: '{}' }
      })],
    }),
  )
  assert.deepEqual(received, { __invalid_arguments: '{"q":' })
  assert.equal(outcome.error, null)
  assert.equal(outcome.answer, '我改一下参数。')
})

test('空 arguments 按空对象处理（模型对无参工具常发空串）', async () => {
  let received: unknown = 'unset'
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'list_pages', arguments: '' }] },
    { text: 'ok' },
  ])
  await run(
    opts({
      llm: svc,
      tools: [fakeTool('list_pages', 'server', (args) => {
        received = args
        return { content: '{}' }
      })],
    }),
  )
  assert.deepEqual(received, {})
})

/* ==================== 需求 ⑥：这一轮有没有知识库依据 ==================== */

test('★ grounded：工具结果声明了 kb 依据时为 true，出处清单里是 kb', async () => {
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'read_page', arguments: '{"slug":"home"}' }] },
    { text: '主页说明了如何新建内容。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [fakeTool('read_page', 'server', () => ({ content: '{"text":"…"}', grounding: 'kb' }))],
    }),
  )
  assert.equal(outcome.grounded, true)
  assert.deepEqual(outcome.groundingSources, ['kb'])
})

test("★ grounded：只声明 'web' ⇒ grounded=false，但出处清单里必须有 web", async () => {
  /*
   * 这是本次扩展要钉住的那条分界：联网搜索**有依据**，只是依据不在本知识库里。
   * 把 `'web'` 也算进 `grounded` 会让「依据的是公开网络资料」被渲染成没有任何标注
   * （用户以为话出自本知识库）；反过来丢掉它则会把这条回答渲染成「来自模型自身的知识」
   * （把模型给的来源链接说成是它编的）。两条都是误导，故两档必须分别下传。
   */
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'web_search', arguments: '{"query":"geewiki"}' }] },
    { text: '按公开资料，来源见 https://example.com/a。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [fakeTool('web_search', 'server', () => ({ content: '{"hits":[{"url":"https://example.com/a"}]}', grounding: 'web' }))],
    }),
  )
  assert.equal(outcome.grounded, false, '公开网络资料不是知识库依据，不得并进 grounded')
  assert.deepEqual(outcome.groundingSources, ['web'])
})

test("★ grounded：kb 与 web 都有 ⇒ grounded=true，清单是字典序的两档", async () => {
  const { svc } = scriptedLlm([
    {
      calls: [
        { id: 'c1', name: 'web_search', arguments: '{"query":"x"}' },
        { id: 'c2', name: 'read_page', arguments: '{"slug":"home"}' },
      ],
    },
    { text: '知识库与公开资料都这么说。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [
        fakeTool('web_search', 'server', () => ({ content: '{"hits":[]}', grounding: 'web' })),
        fakeTool('read_page', 'server', () => ({ content: '{"text":"…"}', grounding: 'kb' })),
      ],
    }),
  )
  assert.equal(outcome.grounded, true)
  // 排序稳定（字典序 'kb' < 'web'）：同一份事实在两次请求里应当是同一份字节
  assert.deepEqual(outcome.groundingSources, ['kb', 'web'])
})

test('★ grounded：工具跑了但没拿到资料（0 命中）⇒ false，出处清单为空', async () => {
  /*
   * 逐次结果而不是逐条描述符的全部理由：`search_kb` 命中 0 条时它确实跑了，
   * 但一个字的资料都没给模型。按描述符声明的话这一轮会被判成"有依据"，
   * 于是模型凭先验知识写的答案**不带任何标注**地显示出来——
   * 而这正是最像答案、也最不该被相信的一种。
   */
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'search_kb', arguments: '{"query":"新建"}' }] },
    { text: '一般是点右上角。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      // 与 ai-kb 的 search_kb 在 0 命中时的返回完全同形：不带 grounding 键
      tools: [fakeTool('search_kb', 'server', () => ({ content: '{"total":0,"hits":[]}' }))],
    }),
  )
  assert.equal(outcome.grounded, false)
  assert.deepEqual(outcome.groundingSources, [], '没拿到资料 ⇒ 任何一档都不声明')
})

test('★ grounded：一旦拿到过依据就**永远是 true**（后续轮次改页面不会把资料从上下文里拿走）', async () => {
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'read_page', arguments: '{}' }] },
    { calls: [{ id: 'c2', name: 'page.update', arguments: '{}' }] },
    { text: '已按页面里的写法改好了。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [
        fakeTool('read_page', 'server', () => ({ content: '{"text":"…"}', grounding: 'kb' })),
        fakeTool('page.update', 'server', () => ({ content: '{"ok":true}' })),
      ],
    }),
  )
  assert.equal(outcome.grounded, true, '最后一轮没有依据 ≠ 整轮没有依据')
  assert.deepEqual(outcome.groundingSources, ['kb'], '清单同样是单调的：拿到过就一直在')
})

test('grounded：工具抛错不算依据（跑了但没拿到）', async () => {
  const { svc } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'boom', arguments: '{}' }] },
    { text: '没查到。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [
        fakeTool('boom', 'server', () => {
          throw new Error('上游 500')
        }),
      ],
    }),
  )
  assert.equal(outcome.grounded, false)
  // 失败**没有任何产出**，连"声明过 web"都不算——判据挂在返回值上，抛错就没有返回值
  assert.deepEqual(outcome.groundingSources, [])
})

test('grounded：一条工具都没调 ⇒ false（模型直接凭自身知识作答）', async () => {
  const { svc } = scriptedLlm([{ text: '你好！' }])
  const { outcome } = await run(opts({ llm: svc, tools: [fakeTool('search_kb', 'server')] }))
  assert.equal(outcome.grounded, false)
  assert.deepEqual(outcome.groundingSources, [])
})

test('grounded：提前收场的分支也带这两个字段（形状恒定，客户端不必判有没有）', async () => {
  const { svc } = scriptedLlm([{ calls: [{ id: '', name: 'x', arguments: '{}' }] }])
  const { outcome } = await run(opts({ llm: svc, tools: [fakeTool('x', 'server')] }))
  assert.notEqual(outcome.error, null)
  assert.equal(outcome.grounded, false)
  assert.deepEqual(outcome.groundingSources, [])
})

/* ================= 工具返回的图片（2026-09-20） ================= */

test('★ 工具返回的图挂在**那条 tool 消息**上，会话核心不造 user 消息（flush 是适配器的事）', async () => {
  const png = 'iVBORw0KGgo='
  const { svc, requests } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'read_image', arguments: '{"id":5}' }] },
    { text: '这是一张拓扑图。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [
        fakeTool('read_image', 'server', () => ({
          content: '{"id":5,"note":"图片已随本条结果一并提供。"}',
          grounding: 'kb',
          images: [{ mime: 'image/png', data: png }],
        })),
      ],
    }),
  )

  const second = requests[1]?.messages ?? []
  const toolMessage = second.find((m) => m.role === 'tool')
  assert.deepEqual(
    toolMessage?.images,
    [{ url: `data:image/png;base64,${png}` }],
    '图片必须挂在那条 tool 消息上（内部模型说事实，协议方言归适配器）',
  )
  assert.equal(
    second.filter((m) => m.role === 'user').length,
    1,
    '会话核心不得凭空造出一条"不是用户说的 user 消息"',
  )
  // 权威转录（随 done.messages 回给客户端、被原样存下、下一轮原样带回）里不能有图片
  assert.equal(JSON.stringify(outcome.messages).includes(png), false, 'base64 不得进权威转录')
})

test('★ 工具交上来的图要过与线协议**同一份**校验：坏 MIME / 坏 base64 / 超长一律丢掉', async () => {
  const bad = [
    { mime: 'image/svg+xml', data: 'AAAA' },
    { mime: 'image/png', data: 'not base64!!' },
    { mime: 'image/png', data: '' },
    { mime: 'image/png', data: 'A'.repeat(1_400_001) },
    { mime: 'text/html', data: 'AAAA' },
  ]
  const { svc, requests } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'read_image', arguments: '{}' }] },
    { text: '好。' },
  ])
  const { outcome } = await run(
    opts({
      llm: svc,
      tools: [fakeTool('read_image', 'server', () => ({ content: '{"n":0}', images: bad }))],
    }),
  )
  const toolMessage = requests[1]?.messages.find((m) => m.role === 'tool')
  assert.equal(toolMessage?.images, undefined, '一张都不合规 ⇒ 一张都不该发出去')
  // 图被丢掉**不影响**工具结果本身进上下文（一次坏图不该让整个回合失败）
  assert.equal(toolMessage?.content, '{"n":0}')
  assert.ok(outcome.messages.some((m) => m.role === 'tool'))
})

test('★ 工具结果超过单条上限时只留前几张，且**如实说出**少给了', async () => {
  const many = Array.from({ length: 6 }, () => ({ mime: 'image/png', data: 'AAAA' }))
  const { svc, requests } = scriptedLlm([
    { calls: [{ id: 'c1', name: 'read_image', arguments: '{}' }] },
    { text: '好。' },
  ])
  const { outcome } = await run(
    opts({ llm: svc, tools: [fakeTool('read_image', 'server', () => ({ content: '{"n":6}', images: many }))] }),
  )
  const toolMessage = requests[1]?.messages.find((m) => m.role === 'tool')
  assert.equal(toolMessage?.images?.length, 4, '单条工具结果最多 4 张（与单条消息的图预算同值）')
  assert.match(
    toolMessage?.content ?? '',
    /只有前 4 张交给了你/,
    '少给必须说出来：工具已在自己文本里写了给了几张，静默截断会让模型以为看到了全部',
  )
  assert.ok(outcome.messages.some((m) => m.role === 'tool'))
})
