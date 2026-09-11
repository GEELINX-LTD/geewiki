import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backlinkSummary,
  isMissingRef,
  missingHint,
  missingNewPageHref,
  refHref,
  refLabel,
} from '../src/lib/pageLinksPlan'

test('isMissingRef：只有 title === null 才算红链', () => {
  assert.equal(isMissingRef({ slug: 'a', title: null }), true)
  assert.equal(isMissingRef({ slug: 'a', title: '甲页' }), false)
  /*
    空标题**不是**红链：页面确实存在，只是标题被用户清空了。
    若这里用 `!title` 判断，就会把"存在但没标题"误报成"页面不存在"——这是本用例要钉住的分界。
  */
  assert.equal(isMissingRef({ slug: 'a', title: '' }), false)
})

test('refLabel：优先标题，退化为 slug（绝不留空，否则列表项看起来像坏了）', () => {
  assert.equal(refLabel({ slug: 'a', title: '甲页' }), '甲页')
  assert.equal(refLabel({ slug: 'ghost', title: null }), 'ghost')
  assert.equal(refLabel({ slug: 'blank', title: '' }), 'blank')
  assert.equal(refLabel({ slug: 'spaces', title: '   ' }), 'spaces')
})

test('refHref：层级 slug 必须编码成 %2F，否则 hash 路由段数不符 → 404', () => {
  assert.equal(refHref('architecture'), '#/wiki/architecture')
  // 这条是与正文链接共用 pageHash 的理由：编码规则只能有一份。
  assert.ok(refHref('guides/authoring').includes('%2F'), refHref('guides/authoring'))
  assert.equal(refHref('guides/authoring'), '#/wiki/guides%2Fauthoring')
})

test('backlinkSummary：未加载完不得宣称 0；0 与 >0 文案不同', () => {
  // 加载中就宣称"还没有页面引用"是在陈述一个还不知道的事实。
  assert.equal(backlinkSummary(0, false), null)
  assert.equal(backlinkSummary(3, false), null)
  assert.equal(backlinkSummary(0, true), '还没有页面引用本页')
  assert.equal(backlinkSummary(1, true), '1 个页面引用了本页')
  assert.equal(backlinkSummary(12, true), '12 个页面引用了本页')
})

test('missingHint：带 slug，便于用户复制后去新建', () => {
  assert.equal(missingHint('ghost-page'), '目标页面不存在：ghost-page')
})

test('missingNewPageHref：指向新建页（路由不支持预填 slug，见函数注释）', () => {
  assert.equal(missingNewPageHref(), '#/wiki/new')
})
