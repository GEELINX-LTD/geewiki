/**
 * 输入条的纯逻辑测试（帧解码 / 流式状态机 / 本地会话 / 客户端工具交接）。
 *
 * 这一组用例的共同点是：**它们覆盖的东西在真浏览器里"常常正好不复现"**——
 * 一个 chunk 恰好切在帧中间、`localStorage` 里恰好有一段别的用户的数据、
 * 客户端工具恰好抛了错。等它们在生产上复现时，症状分别是
 * "回答卡在生成中""A 看到 B 的对话""上游 400 但不知道谁少补了一条消息"。
 *
 * 另有几条**源码级守卫**（本仓既有形态）：浏览器侧不能 import 服务端包，
 * 于是端点名、事件名、props 形状都是被迫的镜像，而镜像漂移**不会编译失败**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyTurnEvent,
  buildTurnBody,
  conversationsKey,
  errorLine,
  groundingAfterDone,
  initialDockState,
  loadConversations,
  MAX_CONVERSATIONS,
  parseToolArguments,
  relativeTime,
  runClientTools,
  saveConversation,
  STORAGE_NAMESPACE,
  titleOf,
  toolResultMessages,
  withUserMessage,
  type MiniStore,
} from '../ui/dockPlan.js'
import { createTurnDecoder, parseTurnEvent, type DoneData, type TurnEvent } from '../ui/sse.js'

/* ============================== 夹具 ============================== */

function memoryStore(seed: Record<string, string> = {}): MiniStore & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v)
    },
  }
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const statusFrame = (tools: readonly string[] = ['search_kb']): string =>
  frame('status', { round: 0, tools, clientToolsAccepted: [] })

/* ============================== 解码器 ============================== */

test('解码器：一整帧解出一个事件', () => {
  const d = createTurnDecoder()
  const events = d.push(frame('delta', { text: '你好' }))
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { event: 'delta', data: { text: '你好' } })
})

test('★ 解码器：一次推入多帧，按序全部解出', () => {
  const d = createTurnDecoder()
  const events = d.push(statusFrame() + frame('delta', { text: 'a' }) + frame('delta', { text: 'b' }))
  assert.deepEqual(events.map((e) => e.event), ['status', 'delta', 'delta'])
})

test('★ 解码器：帧被切成两半时，前半段不产生事件（残帧绝不送去 JSON.parse）', () => {
  const d = createTurnDecoder()
  const whole = frame('delta', { text: '你好世界' })
  const cut = Math.floor(whole.length / 2)
  const first = d.push(whole.slice(0, cut))
  assert.deepEqual(first, [], '半个帧不能被解析出来')
  const second = d.push(whole.slice(cut))
  assert.deepEqual(second, [{ event: 'delta', data: { text: '你好世界' } }])
})

test('★ 解码器：切点落在多字节字符的转义序列中间也不出错', () => {
  const d = createTurnDecoder()
  const whole = frame('delta', { text: '😀中文' })
  // 逐字符喂进去：这是最坏情况的边界切分
  const events: TurnEvent[] = []
  for (const ch of whole) events.push(...d.push(ch))
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { event: 'delta', data: { text: '😀中文' } })
})

test('解码器：CRLF 换行的帧同样能解（某些中间层会改写换行）', () => {
  const d = createTurnDecoder()
  const events = d.push('event: delta\r\ndata: {"text":"x"}\r\n\r\n')
  assert.deepEqual(events, [{ event: 'delta', data: { text: 'x' } }])
})

test('解码器：data 分多行时按规范拼回一行', () => {
  const d = createTurnDecoder()
  const events = d.push('event: delta\ndata: {"text":\ndata: "x"}\n\n')
  assert.deepEqual(events, [{ event: 'delta', data: { text: 'x' } }])
})

test('★ 解码器：畸形帧降级成 invalid 而不是抛（抛在流处理里会让回答看起来卡住）', () => {
  const d = createTurnDecoder()
  assert.doesNotThrow(() => d.push('event: delta\ndata: {不是 JSON}\n\n'))
  const events = d.push('event: delta\ndata: {不是 JSON}\n\n')
  assert.equal(events[0]?.event, 'invalid')
})

test('解码器：没有 event 行的块被忽略（空行分隔产生的空块也一样）', () => {
  const d = createTurnDecoder()
  assert.deepEqual(d.push('\n\n'), [])
  assert.deepEqual(d.push('data: {"x":1}\n\n'), [])
})

test('★ 解码器：flush 能把"完整但没带收尾空行"的残帧解出来（连接被提前关掉的情形）', () => {
  const d = createTurnDecoder()
  assert.deepEqual(d.push('event: delta\ndata: {"text":"结尾"}'), [])
  assert.deepEqual(d.flush(), [{ event: 'delta', data: { text: '结尾' } }])
})

test('解码器：flush 之后缓冲清空（再 flush 不重复产出）', () => {
  const d = createTurnDecoder()
  d.push('event: delta\ndata: {"text":"x"}')
  assert.equal(d.flush().length, 1)
  assert.deepEqual(d.flush(), [])
})

/* ============================== 帧校验 ============================== */

test('parseTurnEvent：delta 缺 text 即 invalid', () => {
  assert.equal(parseTurnEvent('delta', '{}').event, 'invalid')
  assert.equal(parseTurnEvent('delta', '{"text":42}').event, 'invalid')
})

test('parseTurnEvent：未知事件名是 invalid（不是崩溃，也不是当作正常帧）', () => {
  const ev = parseTurnEvent('keepalive', '{}')
  assert.equal(ev.event, 'invalid')
})

test('★ parseTurnEvent：done 的 messages / finishReason 任一坏掉即 invalid（这两个字段是权威转录与流程分支的依据）', () => {
  assert.equal(parseTurnEvent('done', JSON.stringify({ finishReason: 'stop' })).event, 'invalid')
  assert.equal(
    parseTurnEvent('done', JSON.stringify({ messages: [], finishReason: '什么' })).event,
    'invalid',
  )
  assert.equal(
    parseTurnEvent('done', JSON.stringify({ messages: [{ role: 'system', content: 'x' }], finishReason: 'stop' })).event,
    'invalid',
  )
})

test('parseTurnEvent：done 的 toolCalls 为 null 时解析成 null（而不是空数组——两者语义不同）', () => {
  const ev = parseTurnEvent('done', JSON.stringify({ messages: [], finishReason: 'stop', toolCalls: null }))
  assert.equal(ev.event, 'done')
  if (ev.event === 'done') assert.equal(ev.data.toolCalls, null)
})

test('parseTurnEvent：status 的 tools 坏掉时降级成空数组，而不是把整帧判无效（它只用于展示）', () => {
  const ev = parseTurnEvent('status', JSON.stringify({ round: 2, tools: 'nope' }))
  assert.equal(ev.event, 'status')
  if (ev.event === 'status') {
    assert.deepEqual(ev.data.tools, [])
    assert.equal(ev.data.round, 2)
  }
})

test('parseTurnEvent：tool 帧缺 id/name 即 invalid（没有它们就无法归并活动）', () => {
  assert.equal(parseTurnEvent('tool', JSON.stringify({ name: 'x' })).event, 'invalid')
})

/* ============================== 状态机 ============================== */

const ev = (e: TurnEvent): TurnEvent => e

test('状态机：status 重置本轮的正文与活动（上一轮的残留不得串到这一轮）', () => {
  let s = withUserMessage(initialDockState(), 'q')
  s = applyTurnEvent(s, ev({ event: 'delta', data: { text: '旧' } }))
  s = applyTurnEvent(s, ev({ event: 'status', data: { round: 1, tools: ['read_page'], clientToolsAccepted: [] } }))
  assert.equal(s.answer, '')
  assert.deepEqual(s.tools, ['read_page'])
  assert.equal(s.streaming, true)
})

test('状态机：delta 累积', () => {
  let s = withUserMessage(initialDockState(), 'q')
  s = applyTurnEvent(s, ev({ event: 'status', data: { round: 0, tools: [], clientToolsAccepted: [] } }))
  s = applyTurnEvent(s, ev({ event: 'delta', data: { text: '一' } }))
  s = applyTurnEvent(s, ev({ event: 'delta', data: { text: '二' } }))
  assert.equal(s.answer, '一二')
})

test('★ 状态机：tool 帧按 id 归并（start 帧 ok=null，end 帧覆盖它）', () => {
  let s = initialDockState()
  s = applyTurnEvent(s, ev({ event: 'tool', data: { id: 'c1', name: 'search_kb', side: 'server', arguments: '{}', ok: null, summary: '' } }))
  assert.equal(s.activities.length, 1)
  assert.equal(s.activities[0]?.ok, null)
  s = applyTurnEvent(s, ev({ event: 'tool', data: { id: 'c1', name: 'search_kb', side: 'server', arguments: '{}', ok: true, summary: '1 命中' } }))
  assert.equal(s.activities.length, 1, '同一个 id 不得变成两条')
  assert.equal(s.activities[0]?.ok, true)
  assert.equal(s.activities[0]?.summary, '1 命中')
})

test('★ 状态机：done 的 messages 是权威转录（客户端不自己拼）', () => {
  let s = withUserMessage(initialDockState(), 'q')
  const authoritative = [
    { role: 'user' as const, content: 'q' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'search_kb', arguments: '{}' }] },
    { role: 'tool' as const, content: '{"total":1}', toolCallId: 'c1', name: 'search_kb' },
    { role: 'assistant' as const, content: '答' },
  ]
  s = applyTurnEvent(s, ev({ event: 'done', data: { messages: authoritative, answer: '答', finishReason: 'stop', toolCalls: null, toolResults: [], usage: null, partial: false, rounds: 2, elapsedMs: 3, groundingSources: [] } }))
  assert.deepEqual(s.messages, authoritative)
  assert.equal(s.streaming, false)
})

test('★ 状态机：finishReason=tool_calls 时**仍然是 streaming**（服务端只是把控制权交回来了）', () => {
  let s = withUserMessage(initialDockState(), 'q')
  s = applyTurnEvent(s, ev({
    event: 'done',
    data: {
      messages: [{ role: 'user', content: 'q' }],
      answer: null,
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'k1', name: 'editor.replace', arguments: '{}' }],
      toolResults: [],
      usage: null,
      partial: false,
      rounds: 1,
      elapsedMs: 1,
      groundingSources: [],
    },
  }))
  assert.equal(s.streaming, true, '当成结束会让界面在工具执行期间显示"已完成"')
  assert.equal(s.finishReason, 'tool_calls')
})

test('状态机：error 结束 streaming 并置 partial（半截回答不是完整回答）', () => {
  let s = withUserMessage(initialDockState(), 'q')
  s = applyTurnEvent(s, ev({ event: 'error', data: { code: 'RATE_LIMIT', message: '上游拒绝' } }))
  assert.equal(s.streaming, false)
  assert.equal(s.error?.code, 'RATE_LIMIT')
  assert.equal(s.partial, true)
})

test('状态机：invalid 帧是**空操作**（一条不认识的帧不该让界面看起来坏了）', () => {
  const s = withUserMessage(initialDockState(), 'q')
  const next = applyTurnEvent(s, ev({ event: 'invalid', reason: 'x' }))
  assert.equal(next, s, '应原样返回同一个对象（纯函数且无副作用）')
})

/* ============================== 客户端工具交接 ============================== */

const call = (id: string, name = 'editor.replace', args = '{}') => ({ id, name, arguments: args })

test('★ 每一条调用都必须补一条结果消息（缺一条就会在下游变成孤儿调用）', async () => {
  const calls = [call('c1'), call('c2'), call('c3')]
  const results = await runClientTools(calls, async () => ({ ok: true }))
  const messages = toolResultMessages(calls, results)
  assert.equal(messages.length, 3)
  for (const m of messages) {
    assert.equal(m.role, 'tool')
    assert.ok(m.toolCallId !== undefined && m.toolCallId !== '', '缺 toolCallId 上游无法配对')
  }
})

test('★ 调用抛错时也要留下结果（把失败如实回报给模型，而不是让它以为成功）', async () => {
  const results = await runClientTools([call('c1')], async () => {
    throw new Error('宿主拒绝了这次调用')
  })
  assert.equal(results.get('c1')?.ok, false)
  assert.match(results.get('c1')?.content ?? '', /tool_failed/)
})

test('★ 参数是坏 JSON 时**拒绝执行**并如实回报（浏览器里没有"下一轮改对"这回事）', async () => {
  let invoked = 0
  const results = await runClientTools([call('c1', 'editor.replace', '{"text":')], async () => {
    invoked++
    return null
  })
  assert.equal(invoked, 0, '坏参数绝不能被执行')
  assert.match(results.get('c1')?.content ?? '', /invalid_arguments/)
})

test('工具返回 undefined 时补 null（JSON.stringify(undefined) 是 undefined，回灌会坏掉整条消息）', async () => {
  const results = await runClientTools([call('c1')], async () => undefined)
  assert.equal(results.get('c1')?.content, 'null')
})

test('缺少结果时 toolResultMessages 仍产出说明性内容（不跳过）', () => {
  const messages = toolResultMessages([call('c1')], new Map())
  assert.equal(messages.length, 1)
  assert.match(messages[0]?.content ?? '', /no_result/)
})

test('parseToolArguments：空串按空对象，坏 JSON 明确失败', () => {
  assert.deepEqual(parseToolArguments(''), { ok: true, value: {} })
  assert.deepEqual(parseToolArguments('  '), { ok: true, value: {} })
  assert.deepEqual(parseToolArguments('{"a":1}'), { ok: true, value: { a: 1 } })
  assert.equal(parseToolArguments('{oops}').ok, false)
})

/* ============================== 本地会话 ============================== */

test('★ 会话按用户分键：两个用户的数据互不可见', () => {
  const store = memoryStore()
  saveConversation(store, 1, { id: 'a', title: 'A 的对话', updatedAt: 1, messages: [], notGrounded: [], webGrounded: [] })
  saveConversation(store, 2, { id: 'b', title: 'B 的对话', updatedAt: 1, messages: [], notGrounded: [], webGrounded: [] })
  assert.deepEqual(loadConversations(store, 1).map((c) => c.id), ['a'])
  assert.deepEqual(loadConversations(store, 2).map((c) => c.id), ['b'])
  assert.deepEqual(loadConversations(store, 3), [])
  assert.notEqual(conversationsKey(1), conversationsKey(2))
  assert.notEqual(conversationsKey(null), conversationsKey(0), '未登录不能与 id=0 共用键')
})

test('★ 只保留最近 10 段（同 id 覆盖，而不是每次保存都追加一条）', () => {
  const store = memoryStore()
  for (let i = 0; i < 15; i++) {
    saveConversation(store, 1, { id: `c${i}`, title: `t${i}`, updatedAt: i, messages: [], notGrounded: [], webGrounded: [] })
  }
  const list = loadConversations(store, 1)
  assert.equal(list.length, MAX_CONVERSATIONS)
  assert.equal(list[0]?.id, 'c14', '最新的在前')

  // 同一段对话反复保存（每轮结束一次）不得把它撑成 10 条
  for (let i = 0; i < 5; i++) {
    saveConversation(store, 1, { id: 'c14', title: 't14', updatedAt: 100 + i, messages: [], notGrounded: [], webGrounded: [] })
  }
  const again = loadConversations(store, 1)
  assert.equal(again.filter((c) => c.id === 'c14').length, 1)
  assert.equal(again.length, MAX_CONVERSATIONS)
})

test('★ 损坏的存储数据折算成空数组，绝不抛（它会连输入条一起崩掉）', () => {
  for (const junk of ['', 'not json', '{"not":"array"}', '[1,2,3]', '[{"无 id":1}]', 'null']) {
    const store = memoryStore({ [conversationsKey(1)]: junk })
    assert.doesNotThrow(() => loadConversations(store, 1))
    assert.deepEqual(loadConversations(store, 1), [], `junk=${junk}`)
  }
})

test('读取时抛异常的存储（隐私模式）也不得让调用方崩', () => {
  const hostile: MiniStore = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
  assert.deepEqual(loadConversations(hostile, 1), [])
  assert.doesNotThrow(() => saveConversation(hostile, 1, { id: 'x', title: 'x', updatedAt: 1, messages: [], notGrounded: [], webGrounded: [] }))
})

test('titleOf：取第一条用户消息并压平截断；没有用户消息时给中性占位', () => {
  assert.equal(titleOf([{ role: 'user', content: '  主页上\n怎么新建内容？  ' }]), '主页上 怎么新建内容？')
  assert.equal(titleOf([{ role: 'assistant', content: 'hi' }]), '新对话')
  const long = titleOf([{ role: 'user', content: 'x'.repeat(100) }])
  assert.ok(long.length <= 25 && long.endsWith('…'), long)
})

test('loadConversations：按 updatedAt 倒序（跨会话恢复时的顺序必须稳定）', () => {
  const store = memoryStore()
  saveConversation(store, 1, { id: 'old', title: 'o', updatedAt: 100, messages: [], notGrounded: [], webGrounded: [] })
  saveConversation(store, 1, { id: 'new', title: 'n', updatedAt: 200, messages: [], notGrounded: [], webGrounded: [] })
  assert.deepEqual(loadConversations(store, 1).map((c) => c.id), ['new', 'old'])
})

/* ============================== 错误话术 ============================== */

test('errorLine：把错误码翻成**可执行**的话，而不是照抄给运维的 message', () => {
  assert.match(errorLine('model_unavailable', '没有可用的模型路由'), /模型接入/)
  assert.match(errorLine('unauthorized', ''), /登录/)
  assert.match(errorLine('too_many_streams', ''), /稍等/)
  assert.match(errorLine('unavailable', ''), /刷新/)
  assert.match(errorLine('network', 'Failed to fetch'), /Failed to fetch/)
  // 未知码不得显示 undefined
  assert.doesNotMatch(errorLine('something_new', ''), /undefined/)
})

/* ============================== 请求体 ============================== */

test('buildTurnBody：六个字段齐全，page 为 null 时也是显式的 null（不是缺字段）', () => {
  const body = buildTurnBody({
    messages: [{ role: 'user', content: 'q' }],
    clientTools: ['a'],
    round: 0,
    page: null,
    conversationId: 'c-1',
    turnId: 't-1',
  })
  assert.deepEqual(Object.keys(body).sort(), [
    'clientTools',
    'conversationId',
    'messages',
    'page',
    'round',
    'turnId',
  ])
  assert.equal(body.page, null)
})

/*
 * P4 的契约守卫：**两个轮次标识必须真的发出去**。
 *
 * 缺了它们服务端不会报错（它们是可选的），只会让写工具明确拒绝动手——
 * 于是症状是"AI 说它不能改"而不是"参数没传"，排查方向会完全跑偏。
 * 这条守卫钉的就是"发出去"这一个事实。
 */
test('buildTurnBody：会话 id 与轮次 id 原样透传（写工具靠它们把变更记进可回退的那一轮）', () => {
  const body = buildTurnBody({
    messages: [],
    clientTools: [],
    round: 3,
    page: { slug: 'home' },
    conversationId: 'conv-abc',
    turnId: 'turn-xyz',
  })
  assert.equal(body.conversationId, 'conv-abc')
  assert.equal(body.turnId, 'turn-xyz')
  assert.equal(body.round, 3)
})

/* ============================== 源码级守卫 ============================== */

const read = (rel: string): string => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8')

/**
 * 剥掉注释后再扫描。
 *
 * **这不是洁癖，是本仓记档过两次的陷阱**："被守卫的东西出现在被扫描的文本里，
 * 是所有源码级守卫的共同陷阱"。本文件的两条守卫都恰好踩中：
 * `ui/index.tsx` 的文件头写着"本文件**不出现** location.hash"，
 * 而它同时解释了"插件只 dangerouslySetInnerHTML"——两句话都会让守卫误报。
 *
 * 实现是真的走了引号状态机（而不是正则）：正则版本会在 `'https://x'` 上把 `//` 当注释起点，
 * 于是从那里往后的代码全被吃掉——**守卫会因此静默变松**，比误报更糟。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    out += ch
    i++
  }
  return out
}

const readCode = (rel: string): string => stripComments(read(rel))

/** 从一段源码里取出接口的字段（名字 + 是否可选），用来比对两处镜像 */
function interfaceFields(source: string, name: string): Array<{ name: string; optional: boolean }> {
  const start = source.indexOf(`interface ${name} {`)
  assert.ok(start >= 0, `未找到 interface ${name}`)
  let depth = 0
  let end = start
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(source.indexOf('{', start) + 1, end)
  const fields: Array<{ name: string; optional: boolean }> = []
  // 逐行找 `readonly? name?:` / `name(` 形态的字段（只取顶层：嵌套对象在测试数据里不存在）
  for (const line of body.split('\n')) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\??)\s*[:(]/.exec(line)
    if (m) fields.push({ name: m[1] as string, optional: m[2] === '?' })
  }
  return fields
}

test('★ 守卫：端点常量与服务端逐字相同（镜像漂移不会编译失败，只会 404）', () => {
  const server = read('packages/plugin-ai-assistant/src/index.ts')
  const client = read('packages/plugin-ai-assistant/ui/dockPlan.ts')
  for (const [name, value] of [
    ['TURN_PATH', "'/api/ai/turn'"],
    ['ASSISTANT_CAPABILITIES_PATH', "'/api/ai/assistant/capabilities'"],
  ] as const) {
    assert.ok(server.includes(`export const ${name} = ${value}`), `服务端未找到 ${name} = ${value}`)
    // 客户端只镜像了 turn 路径（探测端点由宿主判定登录，界面不需要它）
    if (name === 'TURN_PATH') assert.ok(client.includes(`export const ${name} = ${value}`), `客户端未找到 ${name}`)
  }
})

test('★ 守卫：SSE 事件名与服务端/core 逐字相同', () => {
  const ui = read('packages/plugin-ai-assistant/ui/sse.ts')
  const core = read('packages/core/src/sse.ts')
  for (const [local, coreName, value] of [
    ['EVENT_STATUS', 'SSE_EVENT_STATUS', 'status'],
    ['EVENT_DELTA', 'SSE_EVENT_DELTA', 'delta'],
    ['EVENT_DONE', 'SSE_EVENT_DONE', 'done'],
    ['EVENT_ERROR', 'SSE_EVENT_ERROR', 'error'],
  ] as const) {
    assert.ok(core.includes(`export const ${coreName} = '${value}'`), `core 未找到 ${coreName} = '${value}'`)
    assert.ok(ui.includes(`export const ${local} = '${value}'`), `ui 未找到 ${local} = '${value}'`)
  }
  // 工具活动帧是**插件私有**的中间帧，不进 core —— 这条钉住"别把它加进平台层"
  assert.ok(ui.includes("export const EVENT_TOOL = 'tool'"))
  assert.ok(!core.includes("SSE_EVENT_TOOL"), 'tool 帧不该进平台层的事件名集合')
})

test('★ 守卫：AppDockSlotProps 与宿主镜像逐字段一致（含可选性）', () => {
  const serverSide = read('packages/web/src/lib/slots.tsx')
  const clientSide = read('packages/plugin-ai-assistant/ui/index.tsx')
  const a = interfaceFields(serverSide, 'AppDockSlotProps')
  const b = interfaceFields(clientSide, 'AppDockSlotProps')
  assert.ok(a.length >= 5, `宿主的 AppDockSlotProps 字段太少：${JSON.stringify(a)}`)
  assert.deepEqual(
    b,
    a,
    '镜像漂移的症状是运行期静默：宿主不传该字段，插件读到 undefined 且不报错',
  )
  for (const required of ['page', 'clientTools', 'userId', 'openPage', 'invokeTool']) {
    assert.ok(a.some((f) => f.name === required && !f.optional), `必需字段 ${required} 缺失或变成可选`)
  }
})

test('★ 守卫：插件界面不得自己拼路由（路由表是宿主资产）', () => {
  for (const file of ['ui/index.tsx', 'ui/dockPlan.ts', 'ui/sse.ts']) {
    const src = readCode(`packages/plugin-ai-assistant/${file}`)
    assert.ok(!src.includes('location.hash'), `${file} 里出现了 location.hash`)
    assert.ok(!src.includes('window.location'), `${file} 里出现了 window.location`)
  }
})

test('★ 守卫：未消毒的 markdown 不得绕过宿主管线（只允许经 renderMarkdown 的结果进 innerHTML）', () => {
  const src = readCode('packages/plugin-ai-assistant/ui/index.tsx')
  const hits = src.split('dangerouslySetInnerHTML').length - 1
  assert.equal(hits, 1, `dangerouslySetInnerHTML 只应出现在 Body 的那一处，实际 ${hits} 处`)
  // 那一处必须紧邻 markdownRenderer 的返回值
  const around = src.slice(Math.max(0, src.indexOf('dangerouslySetInnerHTML') - 200), src.indexOf('dangerouslySetInnerHTML') + 100)
  assert.match(around, /markdownRenderer\(props\.text\)/)
  assert.match(around, /props\.rich/)
})

/* ============================ 需求 ⑥：知识库之外的回答要显著标注 ============================ */

/**
 * 造一帧 done（只带本组用例关心的字段，其余给稳定的缺省值）。
 *
 * 返回类型**收窄到 done 那一个分支**，而不是 `TurnEvent`：本组用例全都要读 `data`，
 * 而联合类型上 `.data` 不存在——不收窄的话每个调用点都得写一次
 * `(ev as { data: DoneData }).data`，那种断言散在十几处时，其中一处写错是看不出来的。
 */
function groundingDone(over: Record<string, unknown>): { readonly event: 'done'; readonly data: DoneData } {
  const data = {
    messages: [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
    ],
    answer: '回答',
    finishReason: 'stop',
    toolCalls: null,
    toolResults: [],
    usage: null,
    partial: false,
    rounds: 1,
    elapsedMs: 1,
    ...over,
  }
  const ev = parseTurnEvent('done', JSON.stringify(data))
  assert.equal(ev.event, 'done')
  return ev as { readonly event: 'done'; readonly data: DoneData }
}

test('★ parseTurnEvent：done 帧必须解析出 mutatingTools（漏读一个**可选**字段什么都不会发生）', () => {
  /*
   * 这条是一次真实缺陷的回归（P5 修）。
   *
   * `DoneData.mutatingTools` 声明了、服务端一直在发，而 `parseTurnEvent` 从没读它
   * ⇒ 恒为 `undefined` ⇒ 消费者（`ui/index.tsx` 的 `mutatingCalls`）在 `undefined` 时
   * 的语义是"一个写工具都没有" ⇒ `recordClientMutation` **一次都没被调用过**：
   * 编辑框的改动从来没进过日志，也就从来不可回退。
   *
   * 整条链路不报错、类型全对——只有端到端点一次「回退」才会发现。
   */
  const ev = groundingDone({ finishReason: 'tool_calls', answer: null, mutatingTools: ['editor.insert_text'] })
  assert.deepEqual(ev.data.mutatingTools, ['editor.insert_text'])
})

test('parseTurnEvent：done 帧的 mutatingTools 形状不符 ⇒ 不发这个键（而不是发一个空数组）', () => {
  /*
   * `[]` 与"没读到"是两件事：前者是服务端明确说了"一个写工具都没有"，
   * 后者是这次没读到。把后者当 `[]` 正是上面那个缺陷的形状。
   */
  for (const bad of ['editor.insert_text', [1, 2], null]) {
    const ev = groundingDone({ mutatingTools: bad })
    assert.equal('mutatingTools' in ev.data, false, `形状 ${JSON.stringify(bad)} 不该被当成一份名单`)
  }
  // 服务端明确发了空数组 ⇒ 保留它（这是"确实没有写工具"）
  const empty = groundingDone({ mutatingTools: [] })
  assert.deepEqual(empty.data.mutatingTools, [])
})

test('★ parseTurnEvent：grounded 缺失时**不补 false**（补了会让每条回答都挂标注）', () => {
  const missing = groundingDone({})
  assert.equal(missing.data.grounded, undefined)

  const said = groundingDone({ grounded: false })
  assert.equal(said.data.grounded, false)
})

test('★ parseTurnEvent：groundingSources 缺省与形状不符都读成 `[]`，且**不判帧无效**', () => {
  /*
   * 缺省 `[]` 与 `grounded` 缺省"不补 false"是同一条理的两面：一个可选字段缺席时，
   * 解码层只能退化成"不新增信息"，不能替服务端下一个它没说过的结论。
   *
   * 而"形状不符 ⇒ 整份丢掉"是**全有或全无**：逐项过滤会让 `['web','未来档']` 变成
   * `['web']`，界面据此渲染「依据的是公开网络资料」，而服务端说的其实是两档混合。
   * 另：这里绝不能判 `invalid` —— 丢掉整帧 `done` 等于丢掉权威转录，用户看到的是
   * "回答没收完"，比少一条标注严重得多。
   */
  assert.deepEqual(groundingDone({}).data.groundingSources, [], '旧服务端不发它 ⇒ 空清单')

  assert.deepEqual(groundingDone({ groundingSources: ['web'] }).data.groundingSources, ['web'])
  assert.deepEqual(groundingDone({ groundingSources: ['kb', 'web'] }).data.groundingSources, ['kb', 'web'])

  for (const bad of ['web', ['kb', 1], ['kb', 'bilibili'], null, {}]) {
    const ev = groundingDone({ groundingSources: bad })
    assert.equal(ev.event, 'done', `形状 ${JSON.stringify(bad)} 不该把整帧 done 丢掉`)
    assert.deepEqual(ev.data.groundingSources, [])
  }
})

test('★ groundingAfterDone：只有 web 依据 ⇒ 进"依据公开网络"那一档，而不是 notGrounded', () => {
  /*
   * 这是本次扩展的**核心判据**：联网搜索有依据，只是依据不在本知识库里。
   * 只看 `grounded=false` 的话，这条回答会被渲染成「来自模型自身的知识」——
   * 等于把模型给出的来源链接说成是它自己编的，那是需求 ⑥ 要消灭的误读。
   */
  const ledger = groundingAfterDone(
    { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [], webGrounded: [] },
    groundingDone({ grounded: false, groundingSources: ['web'] }).data,
  )
  assert.equal(ledger.anyGrounded, false)
  assert.equal(ledger.anyWeb, true)
  assert.deepEqual(ledger.notGrounded, [], '"依据公开网络"不能同时被标成"来自模型自身知识"')
  assert.deepEqual(ledger.webGrounded, [1], '下标指向那条有正文的助手消息')
})

test('★ groundingAfterDone：kb 与 web 同时声明 ⇒ 两档都不标（回答确实引用了知识库）', () => {
  const ledger = groundingAfterDone(
    { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [], webGrounded: [] },
    groundingDone({ grounded: true, groundingSources: ['kb', 'web'] }).data,
  )
  assert.deepEqual(ledger.notGrounded, [])
  assert.deepEqual(ledger.webGrounded, [], '有知识库依据时不该降级成"依据公开网络"')
})

test('★ groundingAfterDone：web 依据也跨 HTTP 回合取或（第二回合报 false 不能抹掉第一回合的网络依据）', () => {
  let ledger = { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [] as readonly number[], webGrounded: [] as readonly number[] }
  ledger = groundingAfterDone(
    ledger,
    groundingDone({ finishReason: 'tool_calls', answer: null, grounded: false, groundingSources: ['web'] }).data,
  )
  assert.deepEqual(ledger.webGrounded, [], 'tool_calls 回合还没有答复，不该落标注')
  ledger = groundingAfterDone(ledger, groundingDone({ grounded: false, groundingSources: [] }).data)
  assert.equal(ledger.anyWeb, true, '第二回合没声明任何出处，但那一问的网络依据已经记下')
  assert.deepEqual(ledger.notGrounded, [])
  assert.deepEqual(ledger.webGrounded, [1])
})

test('★ groundingAfterDone：一次提问跨多个 HTTP 回合时，依据的账要**取或**', () => {
  /*
   * 无状态协议下一次提问可能跨多个回合（客户端工具跑完再发一轮），
   * 而第二个回合的服务端**看不到**第一回合执行过的服务端工具 —— 它算出来的
   * `grounded` 必然是 false。只看最后一回合的后果是：凡是"先 read_page 再改编辑框"
   * 的正常用法，最终答案都会被误标成"未使用知识库资料"。
   * 一个总在误报的标注等于没有标注，而且它会让真的那一次也不可信。
   */
  let ledger = { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [] as readonly number[], webGrounded: [] as readonly number[] }
  // 第一回合：服务端读了页面（有依据），但还要等客户端执行编辑框工具 ⇒ 不落标注
  ledger = groundingAfterDone(ledger, groundingDone({ finishReason: 'tool_calls', answer: null, grounded: true }).data)
  assert.deepEqual(ledger.notGrounded, [], 'tool_calls 回合还没有答复，不该落标注')
  // 第二回合：服务端这一次没执行任何工具 ⇒ grounded=false，但账要记住第一回合的依据
  ledger = groundingAfterDone(ledger, groundingDone({ grounded: false }).data)
  assert.equal(ledger.anyGrounded, true)
  assert.deepEqual(ledger.notGrounded, [], '第一回合有依据 ⇒ 最终答案有依据，不该标注')
})

test('★ groundingAfterDone：一次依据都没有 ⇒ 给答复所在的那条消息落标注', () => {
  const ledger = groundingAfterDone(
    { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [], webGrounded: [] },
    groundingDone({ grounded: false }).data,
  )
  assert.equal(ledger.sawGrounding, true)
  assert.deepEqual(ledger.notGrounded, [1], '下标应指向那条有正文的助手消息')
  assert.deepEqual(ledger.webGrounded, [], '一档网络依据都没有 ⇒ 不进网络那一档')
})

test('★ groundingAfterDone：旧服务端不发 grounded ⇒ 永远不标注（把"不知道"读成"没有依据"会让标注恒亮）', () => {
  const ledger = groundingAfterDone(
    { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [], webGrounded: [] },
    groundingDone({}).data,
  )
  assert.equal(ledger.sawGrounding, false)
  assert.equal(ledger.anyWeb, false)
  assert.deepEqual(ledger.notGrounded, [])
  assert.deepEqual(ledger.webGrounded, [], '旧服务端的既有行为一字不变：两条标注都不出现')
})

test('groundingAfterDone：下标累加且不重复（连问两句，两条都要标）', () => {
  let ledger = { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [] as readonly number[], webGrounded: [] as readonly number[] }
  ledger = groundingAfterDone(ledger, groundingDone({ grounded: false }).data)
  const twoTurns = groundingDone({
    grounded: false,
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ],
  })
  ledger = groundingAfterDone(ledger, twoTurns.data)
  assert.deepEqual(ledger.notGrounded, [1, 3])
})

test('groundingAfterDone：带工具调用但正文为空的助手消息**不算答复**（标注不能贴到它上面）', () => {
  const ledger = groundingAfterDone(
    { sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [], webGrounded: [] },
    groundingDone({
      grounded: false,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] },
        { role: 'tool', content: '{}', toolCallId: 'c1', name: 'x' },
        { role: 'assistant', content: '真正的回答' },
      ],
    }).data,
  )
  assert.deepEqual(ledger.notGrounded, [3])
})

test('★ 会话落盘：notGrounded 随回答一起存下来（刷新之后标注不能消失）', () => {
  const store = memoryStore()
  saveConversation(store, 7, {
    id: 'c1',
    title: 't',
    updatedAt: 1,
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ],
    notGrounded: [1],
    webGrounded: [],
  })
  assert.deepEqual(loadConversations(store, 7)[0]?.notGrounded, [1])
})

test('★ 会话读回：越界的 notGrounded 下标被丢弃（把标签贴到别人的回答上比不贴更坏）', () => {
  const store = memoryStore()
  saveConversation(store, 7, {
    id: 'c1',
    title: 't',
    updatedAt: 1,
    messages: [{ role: 'assistant', content: 'a' }],
    notGrounded: [0, 5, -1, 1.5],
    webGrounded: [],
  })
  assert.deepEqual(loadConversations(store, 7)[0]?.notGrounded, [0])
})

test('★ 会话落盘：webGrounded 与 notGrounded 一样随回答存下来（刷新之后"依据公开网络"不能消失）', () => {
  /*
   * 只改渲染不改落盘是这类改动最容易漏的一处：屏幕上有、刷新之后没了，
   * 而用户会把那条回答读成有知识库出处的——正好是需求 ⑥ 要防的误读。
   * 故两条标注必须走同一条落盘路径、同一个字段寿命。
   */
  const store = memoryStore()
  saveConversation(store, 7, {
    id: 'c1',
    title: 't',
    updatedAt: 1,
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ],
    notGrounded: [],
    webGrounded: [1],
  })
  assert.deepEqual(loadConversations(store, 7)[0]?.webGrounded, [1])
})

test('★ 会话读回：越界的 webGrounded 下标同样被丢弃（理由与 notGrounded 逐字相同）', () => {
  const store = memoryStore()
  saveConversation(store, 7, {
    id: 'c1',
    title: 't',
    updatedAt: 1,
    messages: [{ role: 'assistant', content: 'a' }],
    notGrounded: [],
    webGrounded: [0, 5, -1, 1.5],
  })
  assert.deepEqual(loadConversations(store, 7)[0]?.webGrounded, [0])
})

test('会话读回：老数据没有 notGrounded 字段 ⇒ 空数组（不炸、也不误标）', () => {
  const store = memoryStore({
    [`${STORAGE_NAMESPACE}.u7`]: JSON.stringify([
      { id: 'old', title: '旧', updatedAt: 1, messages: [{ role: 'assistant', content: 'a' }] },
    ]),
  })
  assert.deepEqual(loadConversations(store, 7)[0]?.notGrounded, [])
  // 同一条老数据也没有 `webGrounded`：两个字段的缺省行为必须一致，否则一个旧会话会炸或误标
  assert.deepEqual(loadConversations(store, 7)[0]?.webGrounded, [])
})

/* ============================ done 帧字段的镜像守卫 ============================ */

/** 取出接口里某个**嵌套对象字段**（如 `data`）的成员行 */
function nestedFields(source: string, iface: string, field: string): string[] {
  const head = source.indexOf(`interface ${iface} {`)
  assert.ok(head >= 0, `未找到 interface ${iface}`)
  const at = source.indexOf(`${field}: {`, head)
  assert.ok(at >= 0, `${iface} 里没有嵌套字段 ${field}`)
  const open = source.indexOf('{', at)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const names: string[] = []
  for (const line of source.slice(open + 1, end).split('\n')) {
    const m = /^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line)
    if (m) names.push(m[1] as string)
  }
  return names
}

test('★ 守卫：done 帧的每个字段都必须在客户端被解析（声明了却不读，可选字段会静默失效）', () => {
  /*
   * 这条守卫的存在理由就是 `mutatingTools` 那个真实缺陷：字段在接口上、
   * 服务端一直在发，而解码那一层从没读它 ⇒ 恒 `undefined` ⇒ 消费者按
   * "一个写工具都没有"处理 ⇒ 编辑框改动永远不进日志、永远不可回退。
   * 漏读一个**必填**字段，消费者拿到 `undefined` 会当场炸；
   * 漏读一个**可选**字段则什么都不会发生——只有这条守卫能发现它。
   */
  const server = readCode('packages/plugin-ai-assistant/src/sse.ts')
  const client = readCode('packages/plugin-ai-assistant/ui/sse.ts')
  const fields = nestedFields(server, 'TurnDoneEvent', 'data')
  assert.ok(fields.length >= 10, `解析出的 done 字段过少（${fields.length}），疑似正则失效`)

  const clientFields = interfaceFields(client, 'DoneData').map((f) => f.name)
  assert.deepEqual(
    [...fields].sort(),
    [...clientFields].sort(),
    '服务端 done 帧的字段与客户端 DoneData 不再是同一份（镜像漂移不会编译失败）',
  )

  const start = client.indexOf('if (event === EVENT_DONE) {')
  assert.ok(start >= 0, '未找到 done 解码分支')
  const region = client.slice(start, client.indexOf('return { event: \'invalid\', reason: `未知事件名', start))
  /*
   * 解码分支：逐字段确认它真的**进了返回的那个 data 对象**。
   *
   * ⚠️ 这里不能只扫"整个 done 分支里有没有出现 `o['<字段>']`"——那正是本仓记档过两次的
   * 陷阱：**被守卫的东西出现在被扫描的文本里**。字段的读取与它的落键是两行
   * （`const x = parse(o['x'])` 与 `{ x }`），只扫前者的话，把落键那一行删掉守卫照样绿。
   * 现场验证过：删掉 `...(mutatingTools === null ? {} : { mutatingTools })` 这一行，
   * 只扫读取点的版本**不会红**。
   *
   * 所以扫描范围收窄到 `return { event: 'done', data: { … } }` 那个对象字面量本体。
   */
  const ret = region.indexOf("return {\n      event: 'done',\n      data: {")
  assert.ok(ret >= 0, '未找到 done 分支里返回 data 的对象字面量')
  const open = region.indexOf('data: {', ret)
  let depth = 0
  let end = open
  for (let i = region.indexOf('{', open); i < region.length; i++) {
    if (region[i] === '{') depth++
    else if (region[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const literal = region.slice(open, end)
  assert.ok(literal.length > 100, `取到的 data 字面量过短（${literal.length}），疑似括号匹配失效`)
  const unread = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(literal))
  assert.deepEqual(unread, [], `以下 done 字段声明了却没有落进返回的 data：${unread.join(', ')}`)
})

/* ============================== 历史列表与正文排版 ============================== */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)

test('relativeTime：各档边界（列表里没有时间就分不清哪段是刚才的）', () => {
  const at = (ago: number): string => relativeTime(NOW - ago, NOW)
  assert.equal(at(0), '刚刚')
  assert.equal(at(59_000), '刚刚')
  assert.equal(at(MIN), '1 分钟前')
  assert.equal(at(59 * MIN), '59 分钟前')
  assert.equal(at(HOUR), '1 小时前')
  assert.equal(at(23 * HOUR), '23 小时前')
  assert.equal(at(DAY), '1 天前')
  assert.equal(at(29 * DAY), '29 天前')
  // 30 天起换成绝对日期："87 天前"对人没有意义，反而要人自己换算
  assert.equal(at(30 * DAY), '2026-08-16')
})

test('★ relativeTime：时钟回拨与非有限值不得产出 "NaN 分钟前" 这类文案', () => {
  assert.equal(relativeTime(NOW + 5 * MIN, NOW), '刚刚')
  assert.equal(relativeTime(Number.NaN, NOW), '')
  assert.equal(relativeTime(Number.POSITIVE_INFINITY, NOW), '')
})

/**
 * 取一条 CSS 规则的声明体。
 *
 * 扫描前**必须剥注释**：本次三个缺陷的成因与说明都写在注释里，
 * 而注释正文恰好包含 `pre-wrap`、`flex: none`、`15px` 这些被守卫的字符串
 * ——"被守卫的东西出现在被扫描的文本里"是本仓记档过四次的陷阱。
 */
function cssRuleBody(css: string, selector: string): string {
  /*
   * 按**选择器列表**匹配，而不是字符串查找 `selector {`：本次的滚动条属性写成了
   * 分组规则 `.gw-dock-thread,\n.gw-dock-history { … }`，字符串查找会找不到
   * `.gw-dock-thread {` 而误报成"缺样式"。
   *
   * 实现是**真的括号扫描器**而不是正则——正则版（`([^{}@]+?)\{([^{}]*)\}`）
   * 在嵌套的 `@media { … }` 上匹配不到里面的规则，于是 `.gw-dock-msg` 这类
   * 位于 `@media` 之后的规则会时有时无。本仓已经栽过两次同类问题，教训是
   * "把范围收窄比把正则写精巧可靠得多"。
   */
  const code = stripComments(css)
  const found: string[] = []
  let buf = ''
  let i = 0
  while (i < code.length) {
    const ch = code[i] as string
    if (ch === '{') {
      const prelude = buf.trim()
      buf = ''
      let depth = 1
      const bodyStart = i + 1
      let j = bodyStart
      while (j < code.length && depth > 0) {
        if (code[j] === '{') depth++
        else if (code[j] === '}') depth--
        j++
      }
      const body = code.slice(bodyStart, j - 1)
      if (prelude.startsWith('@')) {
        // 只把 at-rule 的**内层**当作候选（本文件里只有 @media / @supports）
        found.push(...ruleBodiesOf(body, selector))
      } else {
        const list = prelude.split(',').map((x) => x.trim()).filter((x) => x !== '')
        if (list.includes(selector)) found.push(body)
      }
      i = j
      continue
    }
    buf += ch
    i++
  }
  assert.ok(found.length > 0, `未找到规则 ${selector}（按选择器列表匹配）`)
  return found.join('\n')
}

/** 递归地在 at-rule 的内层找规则体（用同一套扫描逻辑） */
function ruleBodiesOf(css: string, selector: string): string[] {
  const code = stripComments(css)
  const out: string[] = []
  let buf = ''
  let i = 0
  while (i < code.length) {
    const ch = code[i] as string
    if (ch === '{') {
      const prelude = buf.trim()
      buf = ''
      let depth = 1
      const bodyStart = i + 1
      let j = bodyStart
      while (j < code.length && depth > 0) {
        if (code[j] === '{') depth++
        else if (code[j] === '}') depth--
        j++
      }
      const body = code.slice(bodyStart, j - 1)
      if (prelude.startsWith('@')) out.push(...ruleBodiesOf(body, selector))
      else {
        const list = prelude.split(',').map((x) => x.trim()).filter((x) => x !== '')
        if (list.includes(selector)) out.push(body)
      }
      i = j
      continue
    }
    buf += ch
    i++
  }
  return out
}

const DOCK_CSS = 'packages/plugin-ai-assistant/ui/style.css'

test('★ 守卫：pre-wrap 不得落在 .gw-dock-msg 上（它会继承进 markdown，凭空造出空行）', () => {
  const css = read(DOCK_CSS)
  const msg = cssRuleBody(css, '.gw-dock-msg')
  assert.ok(
    !/white-space\s*:\s*pre-wrap/.test(msg),
    '.gw-dock-msg 又带上了 pre-wrap：marked 生成的 `<ul>\\n<li>` 里，标签之间的换行会各生成一个空行盒，' +
      '每个列表项因此白多出约 28px（改前实测：三行列表高 147px、单项 49px 而文字只有 21px）。' +
      '它只该出现在 .gw-dock-text 上（流式期间的纯文本才需要保留换行）。',
  )
  // 正向对照：流式纯文本那一侧必须**仍然**保留 pre-wrap，否则守卫会以"两边都删掉"的方式通过
  assert.match(cssRuleBody(css, '.gw-dock-text'), /white-space\s*:\s*pre-wrap/)
})

test('★ 守卫：markdown 容器必须显式回到 normal（不靠父级没设置来碰运气）', () => {
  assert.match(cssRuleBody(read(DOCK_CSS), '.gw-dock-md'), /white-space\s*:\s*normal/)
})

test('★ 守卫：历史面板不得被 flex 挤扁（改前只剩 40px，三段历史只看得见一条）', () => {
  const panel = cssRuleBody(read(DOCK_CSS), '.gw-dock-history-panel')
  assert.match(
    panel,
    /flex\s*:\s*none/,
    '历史面板必须是 flex: none：它带 overflow:auto ⇒ min-height 自动变 0，' +
      '于是会被同一列里的 .gw-dock-thread 压到只剩一行高，其余条目要靠内嵌滚动条去翻。',
  )
  const thread = cssRuleBody(read(DOCK_CSS), '.gw-dock-thread')
  assert.match(thread, /overflow-y\s*:\s*auto/, '对话区要能纵向滚动')
  assert.match(thread, /flex\s*:\s*1\s+1\s+auto/, '对话区必须可收缩（否则长回答把面板顶高而不是滚动）')
})

test('★ 守卫：两个滚动容器都要有细滚动条样式（默认那条是 15px 带箭头的浅色带）', () => {
  const css = read(DOCK_CSS)
  for (const sel of ['.gw-dock-thread', '.gw-dock-history']) {
    assert.match(
      cssRuleBody(css, sel),
      /scrollbar-width\s*:\s*thin/,
      `${sel} 少了标准滚动条属性（Firefox 与新版 Chromium 用它，且它优先于 ::-webkit-*）`,
    )
  }
  assert.match(css, /\.gw-dock-thread::-webkit-scrollbar\b/, '缺少 Chromium 侧的滚动条宽度规则')
  assert.match(css, /::-webkit-scrollbar-button\s*\{[^}]*display\s*:\s*none/, '必须去掉滚动条的上下箭头按钮')
  // 滑块颜色只能来自契约块里的语义变量，不得写死色值
  const thumb = css.slice(css.indexOf('::-webkit-scrollbar-thumb'))
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(thumb.slice(0, 400)), '滚动条滑块不得写死十六进制色值')
})

test('★ 守卫：工具痕迹行必须与活动列表互斥（同一件事不得显示两遍）', () => {
  const src = readCode('packages/plugin-ai-assistant/ui/index.tsx')
  /*
   * 扫描范围收窄到推那一行的那段代码本体。
   *
   * 两个坑都在这里踩过，记下来：
   *  ① 锚点**不能选注释**：`readCode` 会剥掉注释，`indexOf('// tool：…')` 恒为 -1
   *     ⇒ 守卫会以"断言未找到锚点"的形式恒红（第一版就是这样）。
   *  ② 范围**不能是全文件**：`renderThread` 上方的新注释里正写着
   *     `activityIds.has(m.toolCallId)` 这句话 —— 把代码里那行删掉，全文件搜索
   *     仍能在注释里命中，守卫**依然绿**。这正是本仓记档过四次的
   *     "被守卫的东西出现在被扫描的文本里"。范围收窄比把正则写精巧可靠得多。
   */
  const at = src.indexOf('gw-dock-msg-tool')
  assert.ok(at >= 0, '未找到工具痕迹行的 JSX 锚点')
  const branch = src.slice(Math.max(0, at - 300), at + 200)
  assert.match(
    branch,
    /activityIds\.has\(m\.toolCallId\)/,
    '每一次工具调用原本会在对话流里留一条灰字、又在活动列表里出现一次 —— 同一件事两遍。' +
      '该分支必须先问 activityIds 再决定要不要推那一行。',
  )
  // 正向对照：活动 id 的集合必须真的从 state.activities 建出来，而不是一个恒空的 Set
  assert.match(src, /activityIds\s*=\s*new Set\(state\.activities\.map\(/)
})
