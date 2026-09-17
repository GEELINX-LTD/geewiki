/**
 * 客户端工具注册表测试。
 *
 * 这张表是设计文档 §3.3 那条安全红线的落点：**客户端上报的可调用集只能收窄，不能扩权**。
 * 所以本文件里最重要的两条断言是"未登记的名字被拒绝"与"重复名字抛错"——
 * 它们分别对应"插件凭空声明一个工具"与"插件顶掉别人的工具"这两条扩权路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clientToolNames,
  clientToolNamesSnapshot,
  clientToolSummary,
  invokeClientTool,
  registerClientTool,
  subscribeClientTools,
  unregisterClientTools,
} from '../src/lib/clientTools'

test('登记后可调用，且名字出现在名单里', async () => {
  const off = registerClientTool('editor.replace_selection', (args) => `已替换:${String(args)}`, 'ai-writing')
  assert.deepEqual(clientToolNames(), ['editor.replace_selection'])
  assert.equal(await invokeClientTool('editor.replace_selection', 'abc'), '已替换:abc')
  off()
  assert.deepEqual(clientToolNames(), [])
})

test('未登记的名字**拒绝调用**（不是返回 undefined）', async () => {
  await assert.rejects(
    () => invokeClientTool('admin.disable_plugin', {}),
    /客户端工具 admin\.disable_plugin 未登记，拒绝调用/,
  )
})

test('重复名字抛错，且不顶掉先登记的那个', () => {
  const off = registerClientTool('editor.bold', () => 'first', 'plugin-a')
  assert.throws(() => registerClientTool('editor.bold', () => 'second', 'plugin-b'), /已被 plugin-a 登记/)
  // 关键：失败的那次登记不得改变既有记录
  assert.equal(clientToolSummary().length, 1)
  assert.equal(clientToolSummary()[0]?.source, 'plugin-a')
  off()
})

test('名字与处理器都要校验（空名 / 非函数各给一条明确错误）', () => {
  assert.throws(() => registerClientTool('', () => 1), /名字必须是非空字符串/)
  assert.throws(() => registerClientTool('   ', () => 1), /名字必须是非空字符串/)
  assert.throws(
    () => registerClientTool('editor.x', undefined as unknown as () => void),
    /缺少处理器函数/,
  )
})

test('注销函数幂等，且不误删"已换主人"的同名工具', async () => {
  const off = registerClientTool('editor.link', () => 'a', 'plugin-a')
  off()
  off() // 再调一次不得抛错、不得改变任何东西

  const off2 = registerClientTool('editor.link', () => 'b', 'plugin-b')
  unregisterClientTools('plugin-a') // plugin-a 已经没有任何工具，这次调用必须是空操作
  assert.equal(await invokeClientTool('editor.link', null), 'b')
  off2()
})

test('unregisterClientTools 按登记方定向回收，不误伤名字相近的登记方', () => {
  const a = registerClientTool('a.one', () => 1, 'plugin-a')
  const ab = registerClientTool('ab.two', () => 2, 'plugin-ab')
  unregisterClientTools('plugin-a')
  assert.deepEqual(clientToolNames(), ['ab.two'])
  a()
  ab()
})

test('名单**已排序**（顺序不稳会让上游前缀缓存全失效）', () => {
  const offs = [
    registerClientTool('z.last', () => 1, 'p'),
    registerClientTool('a.first', () => 2, 'p'),
    registerClientTool('m.mid', () => 3, 'p'),
  ]
  assert.deepEqual(clientToolNames(), ['a.first', 'm.mid', 'z.last'])
  for (const off of offs) off()
})

test('快照引用稳定：内容不变时返回同一个数组（useSyncExternalStore 的必要条件）', () => {
  const off = registerClientTool('snap.one', () => 1, 'p')
  const first = clientToolNamesSnapshot()
  const second = clientToolNamesSnapshot()
  // 引用不同会让 React 每次渲染都认为 store 变了 → 无限重渲染
  assert.equal(first, second, '内容未变时快照必须是同一个引用')

  const off2 = registerClientTool('snap.two', () => 2, 'p')
  const third = clientToolNamesSnapshot()
  assert.notEqual(third, first, '内容变了必须是新引用，否则订阅者不会重渲染')
  assert.deepEqual(third, ['snap.one', 'snap.two'])
  off()
  off2()
})

test('订阅在登记与回收时都被通知', () => {
  let fired = 0
  const unsubscribe = subscribeClientTools(() => {
    fired += 1
  })
  const off = registerClientTool('sub.one', () => 1, 'p')
  assert.equal(fired, 1, '登记应通知订阅者')
  off()
  assert.equal(fired, 2, '注销应通知订阅者')
  unsubscribe()
  const off2 = registerClientTool('sub.two', () => 1, 'p')
  assert.equal(fired, 2, '退订后不该再收到通知')
  off2()
})

test('summary 按名字排序，供诊断使用', () => {
  const offs = [
    registerClientTool('b.two', () => 1, 'p2'),
    registerClientTool('a.one', () => 1, 'p1'),
  ]
  assert.deepEqual(clientToolSummary(), [
    { name: 'a.one', source: 'p1' },
    { name: 'b.two', source: 'p2' },
  ])
  for (const off of offs) off()
})
