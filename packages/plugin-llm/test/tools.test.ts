/**
 * `assembleToolCalls` 的单元测试。
 *
 * 这个函数是全仓**唯一**一份工具片段拼装实现，所以它的边界就是整个工具调用链路的边界：
 * 拼错不会报错，只会让工具结果配到另一个调用上（答案变怪，且极难定位）。
 * 故这里把"上游可能发出来的各种畸形分片"逐条钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleToolCalls, type LlmToolCallDelta } from '@geewiki/llm'

test('按 index 归组：arguments 跨帧拼接成一份完整 JSON 文本', () => {
  const calls = assembleToolCalls([
    { index: 0, id: 'call_1', name: 'search_kb', argumentsDelta: '{"q":' },
    { index: 0, argumentsDelta: '"麒麟"' },
    { index: 0, argumentsDelta: '}' },
  ])
  assert.deepEqual(calls, [{ id: 'call_1', name: 'search_kb', arguments: '{"q":"麒麟"}' }])
})

test('id / name 取首个**非空**值，不被后续空片段覆盖', () => {
  // 实测上游形态：首帧给 id 与 name、但 arguments 是空串；也见过 id 出现在第二帧。
  // 用"非空"而不是"首个片段"作判据，两种形态都能拼对。
  const calls = assembleToolCalls([
    { index: 0, id: '', name: '', argumentsDelta: '' },
    { index: 0, id: 'call_9', name: 'read_page' },
    { index: 0, id: 'call_ignored', name: 'wrong_name', argumentsDelta: '{}' },
  ])
  assert.deepEqual(calls, [{ id: 'call_9', name: 'read_page', arguments: '{}' }])
})

test('多个调用按 index 升序返回（执行顺序 = 模型产出顺序，不依赖到达顺序）', () => {
  const calls = assembleToolCalls([
    { index: 1, id: 'b', name: 'second', argumentsDelta: '{}' },
    { index: 0, id: 'a', name: 'first', argumentsDelta: '{}' },
  ])
  assert.deepEqual(
    calls.map((c) => c.name),
    ['first', 'second'],
  )
})

test('丢掉没有 name 的调用：空名字既无法执行也无法向模型解释', () => {
  const calls = assembleToolCalls([
    { index: 0, argumentsDelta: '{"半截' },
    { index: 1, id: 'ok', name: 'list_pages', argumentsDelta: '{}' },
  ])
  assert.deepEqual(calls, [{ id: 'ok', name: 'list_pages', arguments: '{}' }])
})

test('坏 JSON / 被截断的 arguments 原样保留——本层不做解析', () => {
  // 解析是调用方的事，而且调用方**必须**自己处理坏 JSON：
  // 在这里抛错会把"上游给了半截东西"的事实变成一次含糊的异常。
  const calls = assembleToolCalls([{ index: 0, id: 'c', name: 'save', argumentsDelta: '{"title":"半' }])
  assert.deepEqual(calls, [{ id: 'c', name: 'save', arguments: '{"title":"半' }])
})

test('index 非法（负数 / 非整数）一律归到 0，不丢片段', () => {
  const calls = assembleToolCalls([
    { index: -1, id: 'c', name: 'only_one', argumentsDelta: '{"a":' },
    { index: 1.5, argumentsDelta: '1}' },
  ])
  assert.deepEqual(calls, [{ id: 'c', name: 'only_one', arguments: '{"a":1}' }])
})

test('空输入 → 空数组；只有空壳片段（上游发 {index:0}）也不产生调用', () => {
  assert.deepEqual(assembleToolCalls([]), [])
  assert.deepEqual(assembleToolCalls([{ index: 0 }]), [])
})

test('arguments 全程缺失时是空串，而不是 undefined', () => {
  // 消费者会直接 JSON.parse(arguments)：给 undefined 会在更远的地方炸，
  // 给空串则在这一层就得到一致的"解析失败"。
  const calls = assembleToolCalls([{ index: 0, id: 'c', name: 'no_args' }])
  assert.deepEqual(calls, [{ id: 'c', name: 'no_args', arguments: '' }])
})

test('不修改入参（纯函数）', () => {
  const deltas: LlmToolCallDelta[] = [{ index: 0, id: 'c', name: 'n', argumentsDelta: '{}' }]
  const snapshot = JSON.parse(JSON.stringify(deltas)) as unknown
  assembleToolCalls(deltas)
  assert.deepEqual(JSON.parse(JSON.stringify(deltas)) as unknown, snapshot)
})
