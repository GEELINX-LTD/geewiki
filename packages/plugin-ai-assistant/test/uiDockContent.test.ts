/**
 * 「AI 改了当前文章，页面不刷新」这一缺陷的两半（插件侧）：
 *
 *   ① `affectedSlugs` —— 这一回合里**成功的写操作**影响了哪些页面的纯函数判据（三态）；
 *   ② **事件名镜像守卫** —— 插件（独立构建，import 不到宿主）与宿主两侧各写一份字面量，
 *      必须逐字一致，否则广播发出去没人接（表现为"刷新又坏了"，而且两处都看不出问题）。
 *
 * 宿主侧的订阅与防御式解析在 `packages/web/test/contentEvents.test.ts`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { affectedSlugs, undoneSlugs } from '../ui/dockPlan.js'
import type { ToolActivityView } from '../ui/sse.js'

const ui = readFileSync(join(import.meta.dirname, '..', 'ui', 'index.tsx'), 'utf8')
const HOST = join(import.meta.dirname, '..', '..', 'web', 'src', 'lib', 'contentEvents.ts')
const host = readFileSync(HOST, 'utf8')

const result = (id: string, name: string, ok: boolean | null, args: unknown = {}): ToolActivityView => ({
  id,
  name,
  side: 'server',
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
  ok,
  summary: '',
})

test('affectedSlugs：读工具不触发（没有成功的写操作 ⇒ null）', () => {
  const results = [result('1', 'read_page', true, { slug: 'a' }), result('2', 'list_pages', true)]
  assert.equal(affectedSlugs(results, ['page.update']), null, '该回合没有任何 mutating 工具的结果')
})

test('affectedSlugs：**真实帧形状**——最终 done 帧 `toolCalls` 为 null，写操作只出现在 toolResults 里', () => {
  /*
   * 这是真踩过的形状：AI 用 page.update 改了库，但那一轮模型没再发起调用 ⇒
   * 最终 done 帧的 `toolCalls` 是 `null`，只有 `toolResults` 里记着那次写。
   * 本函数第一版从 toolCalls 里找写工具 ⇒ 判定"没有写操作" ⇒ 宿主不刷新（用户报的缺陷）。
   */
  const results = [result('1', 'read_page', true, { slug: 'a' }), result('2', 'page.update', true, { slug: 'a', content: 'x' })]
  assert.deepEqual(affectedSlugs(results, ['page.update', 'read_page']), ['a'])
})


test('affectedSlugs：成功的写操作给出具体 slug；多个去重', () => {
  const results = [
    result('1', 'page.update', true, { slug: 'a', content: 'x' }),
    result('2', 'page.update', true, { slug: 'a', content: 'y' }),
  ]
  assert.deepEqual(affectedSlugs(results, ['page.update']), ['a'])
})


test('affectedSlugs：**明确失败**的写操作不广播（它没改库，别让宿主白刷一次）', () => {
  assert.equal(affectedSlugs([result('1', 'page.update', false, { slug: 'a' })], ['page.update']), null)
})


test('affectedSlugs：`ok === null`（还在跑）按"可能改了"处理（宁可多刷）', () => {
  const results = [result('1', 'page.update', null, { slug: 'a' }), result('2', 'page.update', null, { slug: 'b' })]
  assert.deepEqual(affectedSlugs(results, ['page.update']), ['a', 'b'])
})


test('affectedSlugs：解析不出 slug 时返回**空数组**（= 改了东西但不知道是哪一页，仍要广播）', () => {
  const cases: [string, string][] = [
    ['不是 JSON', 'not-json-at-all'],
    ['JSON 但不是对象', '"just a string"'],
    ['换了参数名', JSON.stringify({ target: 'a', content: 'x' })],
    ['slug 不是字符串', JSON.stringify({ slug: 42 })],
    ['slug 是空串', JSON.stringify({ slug: '' })],
  ]
  for (const [why, args] of cases) {
    assert.deepEqual(affectedSlugs([result('1', 'page.update', true, args)], ['page.update']), [], `${why} ⇒ 应为空数组而不是 null`)
  }
})


test('事件名与宿主逐字一致（插件独立构建，只能靠字面量镜像）', () => {
  const hostConst = /export const CONTENT_CHANGED_EVENT = '([^']+)'/.exec(host)?.[1]
  assert.ok(hostConst !== undefined, '宿主 contentEvents.ts 里应有 CONTENT_CHANGED_EVENT 常量')
  const mirrors = [...ui.matchAll(/const CONTENT_CHANGED_EVENT = '([^']+)'/g)].map((m) => m[1])
  assert.equal(mirrors.length, 1, `插件侧应恰好一份字面量镜像（当前 ${mirrors.length} 份）`)
  assert.equal(mirrors[0], hostConst, `事件名两侧必须逐字一致（插件 ${mirrors[0]} vs 宿主 ${hostConst}）`)
  // detail 形状也要对得上：宿主解析 slugs/source，插件就得发这两个键
  assert.match(
    ui,
    /detail: \{ slugs, source: `@geewiki\/ai-assistant:\$\{source\}` \}/,
    'detail 必须以 { slugs, source } 形状发出（source 只用于诊断，带来源后缀）',
  )
  assert.match(host, /if \(!Array\.isArray\(raw\.slugs\)\) return null/, '宿主侧要防御式解析 slugs')
})

test('★ 空闲计时器必须被我们自己的进展重置（kick 曾经从未被调用 ⇒ 任何 >30s 的回合都被砍）', () => {
  /*
   * 用户反馈：「其次，模型服务是有反应的」——他说得对：`watchdog.kick()` 是重置空闲计时器的
   * **唯一** API，而它在本插件里此前**从未被调用过**，于是计时器只在回合开始时上弦一次，
   * 任何超过 30 秒的回合都会被判成"空闲"并中止（哪怕上游一直在正常吐字）。
   * 这条守卫钉住：路由的事件回调里必须 kick（工具执行期间上游一个字节都不发，
   * 只在上游分片处重置是不够的）。
   */
  const route = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
  assert.match(
    route,
    /\(ev\) => \{\s*\/\*[\s\S]*?\*\/\s*watchdog\.kick\(\)/,
    'loop 的每个进展事件都要重置空闲计时器',
  )
  // 反面对照：kick 不能只留在注释/文档里
  const calls = [...route.matchAll(/watchdog\.kick\(\)/g)].length
  assert.ok(calls >= 1, `watchdog.kick() 至少要真的被调用一次（当前 ${calls} 次）`)
})

test('★ 中止后必须有一个**真的**「继续」按钮（文案指过不存在的入口）', () => {
  /*
   * 用户反馈：「首先没有继续这个按钮」——文案里写着"可以点「继续」接着做"，
   * 而界面上并没有它（我把用户上一轮自己发的一条消息气泡当成了按钮）。
   * 这条守卫钉住：有一个按钮、它的文案就是「继续」、且它把「继续」当**用户消息**发出去
   * （与在输入框里敲字走同一条路径，会话里留痕）。
   */
  assert.match(ui, /state\.error\.code === 'ABORTED' && \(/, '只在"本轮中止"这一类错误下给入口')
  assert.match(ui, /<button type="button" className="gw-dock-btn gw-dock-btn-primary" onClick=\{\(\) => send\('继续'\)\}>/, '按钮必须真的发「继续」')
  assert.match(ui, /const text = \(preset \?\? input\)\.trim\(\)/, 'send 要接受预设文本（按钮与输入框共用同一条发送路径）')
  assert.match(
    ui,
    /if \(preset === undefined\) \{\s*setInput\(''\)/,
    '点按钮不该清空用户正在输入的内容（2026-09-20 起那一段还负责清掉待发图片，故从一个单句变成一个块）',
  )
  // 文案不许指向不存在的入口：提到「继续」就说明按钮在
  assert.match(readFileSync(join(import.meta.dirname, '..', 'src', 'loop.ts'), 'utf8'), /点下面的「继续」/, '文案里的「继续」必须与按钮的位置对应（下面的按钮）')
})

test('undoneSlugs：取这一回回退要动的页面；已撤过的记录不算，没有页面目标时返回 null', () => {
  const rec = (target: string, undoneAt: string | null = null) => ({
    id: 1,
    turnId: 't',
    tool: 'page.update',
    domain: 'wiki',
    target,
    before: null,
    after: null,
    undoneAt,
  })
  assert.deepEqual(undoneSlugs([rec('a'), rec('a'), rec('b')]), ['a', 'b'], '去重')
  assert.equal(undoneSlugs([rec('a', '2026-01-01T00:00:00.000Z')]), null, '已经撤过的不构成"这次要动的"')
  assert.equal(undoneSlugs([rec('')]), null, '没有页面目标（如草稿域）⇒ null ⇒ 宿主按当前页处理')
  assert.equal(undoneSlugs([]), null)
})

test('★ 回退之后必须通知宿主（用户报"回退后不会自动刷新"）', () => {
  /*
   * 回退走服务端的撤销执行体（正文按快照改回去了），而页面上那份是取来的数据——
   * 没人通知，用户就得手动刷新。与"工具写完"同一条缝隙，只是来源不同。
   */
  assert.match(ui, /if \(report\.undone\.length > 0\) notifyHostChanged\(undoneSlugs\(turn\?\.records \?\? \[\]\), 'undo'\)/,
    '回退后（且服务端真的撤掉了东西）要广播，来源标记为 undo')
  assert.doesNotMatch(ui, /report\.conflicts\.length === 0 && notifyHostChanged/, '不该在"什么都没撤"时也刷')
})

test('两处回合边界都会广播（中间回合就要刷，不必等整轮结束）', () => {
  const calls = [...ui.matchAll(/notifyHostIfMutated\(finished\)/g)].length
  assert.equal(calls, 2, `应在"工具回合结束"与"整轮结束"两处各广播一次（当前 ${calls} 处）`)
  assert.match(ui, /const slugs = affectedSlugs\(done\.toolResults \?\? \[\], done\.mutatingTools\)/, '写操作的身份与服务端下发的 mutatingTools 同源，且只读 toolResults')
  assert.doesNotMatch(ui, /affectedSlugs\(done\.toolCalls/, '不得再从 toolCalls 找写操作（最终帧里它是 null，会漏刷）')
  assert.match(ui, /if \(slugs === null\) return/, 'null（没有成功的写操作）不得广播')
})
