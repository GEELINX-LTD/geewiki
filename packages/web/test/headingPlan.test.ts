/**
 * 标题锚点与目录的纯逻辑单测（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/web test
 *
 * 重点钉住三类最容易做错、且在浏览器里"看起来正常"的边界：
 * 1. **中文标题不能被清空**——slug 若用 `[a-z0-9]` 过滤，中文标题会全变成空串，
 *    所有小节共用一个 id，目录点哪个都跳到同一处；
 * 2. **重复标题必须加序号**——否则第二个同名锚点永远点不到（浏览器只认第一个）；
 * 3. **高亮的边界**：还没滚到第一个标题、滚到两节之间、滚到底，都要有确定答案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TOC_ENTRIES,
  anchorLabel,
  assignHeadingIds,
  pickActiveHeading,
  slugifyHeading,
  tocEntries,
} from '../src/lib/headingPlan'

/* ------------------------- slugifyHeading ------------------------- */

test('slugifyHeading：中文标题保留原文（不得被拉丁字符集过滤掉）', () => {
  assert.equal(slugifyHeading('快速开始'), '快速开始')
  assert.equal(slugifyHeading('检索增强问答'), '检索增强问答')
})

test('slugifyHeading：英文小写化、空格与标点折叠为连字符', () => {
  assert.equal(slugifyHeading('Getting Started'), 'getting-started')
  assert.equal(slugifyHeading('  Hello, World!  '), 'hello-world')
  assert.equal(slugifyHeading('A  B'), 'a-b') // 连续空格折叠成一个 -
  assert.equal(slugifyHeading('a - b'), 'a-b') // 空格+连字符不会产出 a--b
})

test('slugifyHeading：全角空格也当空白处理', () => {
  assert.equal(slugifyHeading('中文\u3000标题'), '中文-标题')
})

test('slugifyHeading：中英混排保留两部分', () => {
  assert.equal(slugifyHeading('API 参考'), 'api-参考')
})

test('slugifyHeading：emoji 与纯标点被丢弃；全丢弃时返回空串（由调用方兜底）', () => {
  assert.equal(slugifyHeading('🎉 发布'), '发布')
  assert.equal(slugifyHeading('!!!'), '')
  assert.equal(slugifyHeading('   '), '')
  assert.equal(slugifyHeading(''), '')
})

test('slugifyHeading：保留点与下划线（版本号、a_b 这类标识要能对上）', () => {
  assert.equal(slugifyHeading('v1.2.0 说明'), 'v1.2.0-说明')
  assert.equal(slugifyHeading('foo_bar'), 'foo_bar')
})

test('slugifyHeading：首尾的连字符/点被去掉（不产出 -foo- 这种 id）', () => {
  assert.equal(slugifyHeading('— 标题 —'), '标题')
  assert.equal(slugifyHeading('.hidden'), 'hidden')
})

/* ------------------------- assignHeadingIds ------------------------- */

test('assignHeadingIds：重复标题按出现顺序加序号（否则第二个锚点永远点不到）', () => {
  const out = assignHeadingIds([
    { level: 2, text: '用法' },
    { level: 2, text: '用法' },
    { level: 2, text: '用法' },
  ])
  assert.deepEqual(
    out.map((h) => h.id),
    ['用法', '用法-1', '用法-2'],
  )
})

test('assignHeadingIds：无可读字符的标题回退为 section 并同样去重', () => {
  const out = assignHeadingIds([
    { level: 2, text: '!!!' },
    { level: 2, text: '???' },
  ])
  assert.deepEqual(
    out.map((h) => h.id),
    ['section', 'section-1'],
  )
})

test('assignHeadingIds：纯函数——同一输入两次调用结果一致（目录与正文必须一致）', () => {
  const input = [
    { level: 2, text: 'A' },
    { level: 3, text: 'A' },
    { level: 2, text: 'B' },
  ]
  assert.deepEqual(assignHeadingIds(input), assignHeadingIds(input))
})

test('assignHeadingIds：保留层级与原文（用于展示）', () => {
  const out = assignHeadingIds([{ level: 3, text: '深层小节' }])
  assert.deepEqual(out[0], { id: '深层小节', level: 3, text: '深层小节' })
})

/* ------------------------- tocEntries ------------------------- */

test('tocEntries：只收 h2–h3（与 Docusaurus/VitePress 默认口径一致），丢弃 h1/h4', () => {
  const entries = assignHeadingIds([
    { level: 1, text: '标题' },
    { level: 2, text: '一节' },
    { level: 3, text: '一小节' },
    { level: 4, text: '更深' },
  ])
  assert.deepEqual(
    tocEntries(entries).map((e) => e.text),
    ['一节', '一小节'],
  )
})

test('tocEntries：超长文档截断到上限（目录不该变成一堵墙）', () => {
  const many = Array.from({ length: MAX_TOC_ENTRIES + 20 }, (_, i) => ({
    level: 2,
    text: `第${i}节`,
  }))
  assert.equal(tocEntries(assignHeadingIds(many)).length, MAX_TOC_ENTRIES)
})

/* ------------------------- anchorLabel ------------------------- */

test('anchorLabel：带上标题文本（屏幕阅读器要能区分不同小节的链接）', () => {
  assert.equal(anchorLabel('用法'), '链接到「用法」')
  assert.equal(anchorLabel('  '), '本节链接')
})

/* ------------------------- pickActiveHeading ------------------------- */

test('pickActiveHeading：还没滚到第一个标题时高亮首个（而不是什么都不高亮）', () => {
  const ids = [
    { id: 'a', top: 300 },
    { id: 'b', top: 800 },
  ]
  assert.equal(pickActiveHeading(ids, 80), 'a')
})

test('pickActiveHeading：越过若干标题后取最后一个越过的（即当前所在小节）', () => {
  const ids = [
    { id: 'a', top: -500 },
    { id: 'b', top: -100 },
    { id: 'c', top: 50 },
    { id: 'd', top: 600 },
  ]
  assert.equal(pickActiveHeading(ids, 80), 'c')
  assert.equal(pickActiveHeading(ids, 0), 'b')
})

test('pickActiveHeading：全部滚出视口上方（读到底部）时高亮最后一个', () => {
  const ids = [
    { id: 'a', top: -900 },
    { id: 'b', top: -300 },
  ]
  assert.equal(pickActiveHeading(ids, 80), 'b')
})

test('pickActiveHeading：空列表返回 null（无标题的页面不该崩）', () => {
  assert.equal(pickActiveHeading([], 80), null)
})

test('pickActiveHeading：恰好压线（top == threshold）也算越过，避免亚像素抖动导致闪烁', () => {
  const ids = [
    { id: 'a', top: -10 },
    { id: 'b', top: 80 },
  ]
  assert.equal(pickActiveHeading(ids, 80), 'b')
})
