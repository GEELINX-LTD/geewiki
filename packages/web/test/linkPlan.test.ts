/**
 * 正文链接改写规则的穷举测试（纯函数，无 DOM）。
 *
 * 重点在边界：`javascript:`、`%2F` 编码、前后空格、相对路径歧义、
 * "列表尚未取到"（knownSlugs === null）时**不得**误判缺失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlugTarget, pageHash, resolveBodyLink } from '../src/lib/linkPlan'

const route = 'wiki/guides/authoring'
const pages = new Map([
  ['getting-started', '快速开始'],
  ['architecture', '架构设计'],
  ['guides/authoring', '撰写指南'],
])
const none = null

test('外链：http/https 原样保留并标记新标签打开', () => {
  for (const href of ['https://vite.dev', 'http://example.com/a?b=1#c']) {
    const r = resolveBodyLink(href, { route, knownSlugs: pages })
    assert.equal(r.kind, 'external', href)
    assert.equal(r.href, href)
    assert.equal(r.blank, true)
  }
})

test('外链：协议相对地址按外链处理', () => {
  const r = resolveBodyLink('//cdn.example.com/x.js', { route, knownSlugs: pages })
  assert.equal(r.kind, 'external')
  assert.equal(r.blank, true)
})

test('mailto/tel 不改写且不新开标签（交给系统处理）', () => {
  for (const href of ['mailto:a@b.c', 'tel:+861000000000']) {
    const r = resolveBodyLink(href, { route, knownSlugs: pages })
    assert.equal(r.kind, 'keep')
    assert.equal(r.href, href)
    assert.equal(r.blank, false)
  }
})

test('危险/未知 scheme 一律 keep，绝不改写成可点链接', () => {
  for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
    const r = resolveBodyLink(href, { route, knownSlugs: pages })
    assert.equal(r.kind, 'keep', href)
    assert.equal(r.href, href, '原值保留（是否可点由消毒层决定）')
    assert.equal(r.blank, false)
  }
})

test('同页锚点：转成路由内锚点形态（否则会把 hash 换成 #section 打乱路由）', () => {
  const r = resolveBodyLink('#section', { route, knownSlugs: pages })
  assert.equal(r.kind, 'anchor')
  assert.equal(r.href, '#/wiki/guides/authoring?a=section')
})

test('同页锚点：百分号编码的 id 只解码一次', () => {
  const r = resolveBodyLink('#%E4%B8%AD%E6%96%87', { route, knownSlugs: pages })
  assert.equal(r.href, '#/wiki/guides/authoring?a=%E4%B8%AD%E6%96%87')
})

test('同页锚点：没有路由上下文时保持原样（无法构造合法 hash）', () => {
  const r = resolveBodyLink('#section', { route: '', knownSlugs: pages })
  assert.equal(r.kind, 'keep')
})

test('空 href 与裸 "#" 保持原样', () => {
  for (const href of ['', '   ', '#']) {
    const r = resolveBodyLink(href, { route, knownSlugs: pages })
    assert.equal(r.kind, 'keep', JSON.stringify(href))
  }
})

test('站内绝对路径 → hash 表单，绝不整页跳走', () => {
  const cases: Array<[string, string]> = [
    ['/architecture', 'architecture'],
    ['/wiki/getting-started', 'getting-started'],
    ['/wiki/guides/authoring', 'guides/authoring'],
    ['/wiki/guides%2Fauthoring', 'guides/authoring'],
  ]
  for (const [href, slug] of cases) {
    const r = resolveBodyLink(href, { route, knownSlugs: pages })
    assert.equal(r.kind, 'page', href)
    assert.equal(r.slug, slug, href)
    assert.equal(r.href, pageHash(slug), href)
  }
})

test('层级 slug 必须编码成 %2F（否则路由段数不符 → 404）', () => {
  const r = resolveBodyLink('/wiki/guides/authoring', { route, knownSlugs: pages })
  assert.equal(r.href, '#/wiki/guides%2Fauthoring')
  assert.ok(!r.href.includes('/wiki/guides/authoring'), '不得出现未编码的层级路径')
})

test('已是 hash 路由形态的链接：归一后重写', () => {
  const r = resolveBodyLink('#/wiki/getting-started', { route, knownSlugs: pages })
  assert.equal(r.kind, 'page')
  assert.equal(r.href, '#/wiki/getting-started')
})

test('站内链接目标不存在 → missing（仍可点，进"页面不存在"空态）', () => {
  const r = resolveBodyLink('/nope', { route, knownSlugs: pages })
  assert.equal(r.kind, 'missing')
  assert.equal(r.slug, 'nope')
  assert.equal(r.href, '#/wiki/nope', '仍是站内 hash 链接，不是死链接')
  assert.equal(r.blank, false)
})

test('已知页面但列表未知（null）时不判定缺失，只做形态改写', () => {
  for (const href of ['/architecture', '/whatever-unknown']) {
    const r = resolveBodyLink(href, { route, knownSlugs: none })
    assert.equal(r.kind, 'page', `${href} 在列表未知时不得被判为 missing`)
    assert.equal(r.href.startsWith('#/wiki/'), true)
  }
})

test('相对路径有歧义：只有确知是页面时才改写，否则原样保留', () => {
  // 已知页面 → 改写
  const known = resolveBodyLink('getting-started', { route, knownSlugs: pages })
  assert.equal(known.kind, 'page')
  assert.equal(known.href, '#/wiki/getting-started')
  // 未知相对路径（可能是文件）→ 原样保留，绝不猜
  const file = resolveBodyLink('image.png', { route, knownSlugs: pages })
  assert.equal(file.kind, 'keep')
  assert.equal(file.href, 'image.png')
  // 列表未知时同样不改写相对路径
  const unknown = resolveBodyLink('getting-started', { route, knownSlugs: none })
  assert.equal(unknown.kind, 'keep')
})

test('前后空格被 trim', () => {
  const r = resolveBodyLink('  /architecture  ', { route, knownSlugs: pages })
  assert.equal(r.kind, 'page')
  assert.equal(r.href, '#/wiki/architecture')
})

test('站点根 "/" 不是页面，保持原样', () => {
  for (const href of ['/', '/wiki/', '/wiki']) {
    const r = resolveBodyLink(href, { route, knownSlugs: pages })
    assert.equal(r.kind, 'keep', href)
  }
})

test('query/fragment 尾巴不参与 slug 归一', () => {
  assert.equal(normalizeSlugTarget('/wiki/foo?x=1'), 'foo')
  assert.equal(normalizeSlugTarget('/wiki/foo#bar'), 'foo')
})

test('normalizeSlugTarget 覆盖各种写法', () => {
  for (const input of ['/wiki/foo', '#/wiki/foo', 'wiki/foo', 'foo', '/foo', 'foo/', 'guides%2Fauthoring']) {
    const expected = input.includes('authoring') ? 'guides/authoring' : 'foo'
    assert.equal(normalizeSlugTarget(input), expected, input)
  }
})

test('非法百分号编码不抛错（降级为原样）', () => {
  assert.equal(normalizeSlugTarget('/wiki/%zz'), 'wiki/%zz'.replace(/^wiki\//, ''))
})

test('pageHash 对普通与层级 slug 都产出合法 hash', () => {
  assert.equal(pageHash('foo'), '#/wiki/foo')
  assert.equal(pageHash('a/b'), '#/wiki/a%2Fb')
})
