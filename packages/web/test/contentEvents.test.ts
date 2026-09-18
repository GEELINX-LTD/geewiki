/**
 * 宿主侧「内容变更广播」（2026-09-16）：解析要**防御式**，订阅要真的接上重取。
 *
 * 背景（用户报的缺陷）：让 AI 助手改当前这篇文章，`page.update` 在服务端跑完、库里已经变了，
 * 但页面上还是旧正文。宿主现在订阅 `window` 上的 `geewiki:content-changed`
 * （契约与理由见 `src/lib/contentEvents.ts`），这里钉住三件事：
 *   ① 畸形事件不得把详情页打崩（解析返回 null，监听器直接忽略）；
 *   ② 订阅返回退订函数（组件卸载必须摘掉，否则会在已卸载组件上 setState）；
 *   ③ 详情页的处理规则：**当前页（或"不知道是哪一页"）⇒ 重取正文；别的页 ⇒ 只失效列表**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTENT_CHANGED_EVENT, parseContentChanged } from '../src/lib/contentEvents'

const wikiPage = readFileSync(join(import.meta.dirname, '..', 'src', 'pages', 'WikiPage.tsx'), 'utf8')
const lib = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'contentEvents.ts'), 'utf8')

const fakeEvent = (detail: unknown): Event => ({ detail }) as unknown as Event

test('事件名是插件侧镜像的那一个（两侧各写一份字面量，必须同名）', () => {
  assert.equal(CONTENT_CHANGED_EVENT, 'geewiki:content-changed')
  const mirror = readFileSync(
    join(import.meta.dirname, '..', '..', 'plugin-ai-assistant', 'ui', 'index.tsx'),
    'utf8',
  )
  assert.match(mirror, new RegExp(`const CONTENT_CHANGED_EVENT = '${CONTENT_CHANGED_EVENT}'`), '插件侧镜像必须同名')
})

test('parseContentChanged：形状不对一律返回 null（**不抛**，否则一个畸形事件就打崩详情页）', () => {
  const bad: unknown[] = [
    undefined,
    null,
    42,
    'geewiki:content-changed',
    {},
    { slugs: 'a' },
    { slugs: null },
    { slugs: {} },
  ]
  for (const detail of bad) {
    assert.equal(parseContentChanged(fakeEvent(detail)), null, `${JSON.stringify(detail)} 应被忽略`)
  }
})

test('parseContentChanged：好的形状照常解析；非字符串项被丢掉而不是整条作废', () => {
  assert.deepEqual(parseContentChanged(fakeEvent({ slugs: ['a', 'b'], source: 'x' })), {
    slugs: ['a', 'b'],
    source: 'x',
  })
  assert.deepEqual(parseContentChanged(fakeEvent({ slugs: ['a', 42, '', null, 'b'] })), {
    slugs: ['a', 'b'],
    source: 'unknown',
  })
  // 空数组是**有意义**的形态："改了东西但不知道是哪一页"（宿主按当前页处理）
  assert.deepEqual(parseContentChanged(fakeEvent({ slugs: [] })), { slugs: [], source: 'unknown' })
})

test('详情页的订阅规则：当前页或"不知道是哪一页" ⇒ 重取正文；别的页 ⇒ 只失效列表', () => {
  /*
   * 这一段直接扫源码：判断本身很短（`slugs.length === 0 || slugs.includes(slug)`），
   * 而它错了的表现是"刷新逻辑又悄悄失效"——没有异常、没有报错，只有用户看到旧正文。
   */
  assert.match(wikiPage, /return onContentChanged\(\(detail\) => \{/, '详情页必须订阅内容变更')
  assert.match(
    wikiPage,
    /const mine = detail\.slugs\.length === 0 \|\| detail\.slugs\.includes\(slug\)/,
    '空 slugs 必须按"当前页"处理（不知道是哪一页时宁可多刷）',
  )
  assert.match(wikiPage, /if \(mine\) \{\s*\n\s*load\(\)/, '命中当前页时要重取正文')
  assert.match(wikiPage, /void invalidatePages\(\)/, '无论改的是不是这一页，列表缓存都要失效')
  // 退订：effect 必须把 onContentChanged 的返回值当 cleanup 返回（否则卸载后仍在监听）
  assert.match(wikiPage, /\n {2}\}, \[slug, load\]\)/, 'effect 依赖要被钉住（slug 变了要重新订阅）')
})

test('lib 自身：订阅返回退订函数，且监听器在门口就用 parse 过滤畸形事件', () => {
  assert.match(lib, /export function onContentChanged\(handler: \(detail: ContentChangedDetail\) => void\): \(\) => void \{/)
  assert.match(lib, /window\.addEventListener\(CONTENT_CHANGED_EVENT, listener\)/)
  assert.match(lib, /return \(\) => window\.removeEventListener\(CONTENT_CHANGED_EVENT, listener\)/)
  assert.match(lib, /const detail = parseContentChanged\(event\)\s*\n\s*if \(detail === null\)/)
})
