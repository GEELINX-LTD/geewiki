import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HIDDEN_LINK_ATTR,
  backlinkSummary,
  hiddenHint,
  isHiddenRef,
  isMissingRef,
  linkStateOf,
  missingHint,
  missingNewPageHref,
  refHref,
  refLabel,
} from '../src/lib/pageLinksPlan'

/*
  四态的分界是本文件最重要的部分。判据来自 `exists`（服务端**按主体**算过的事实），
  不是 `title === null` —— 后者只是 LEFT JOIN 的副产物，区分不出"不存在"与"存在但看不到"。
*/
test('linkStateOf：exists 的四种取值各归一态', () => {
  assert.equal(linkStateOf({ slug: 'a', title: '甲页', exists: true }), 'ok')
  assert.equal(linkStateOf({ slug: 'a', title: null, exists: false }), 'missing')
  assert.equal(linkStateOf({ slug: 'a', title: null, exists: 'hidden' }), 'hidden')
  assert.equal(linkStateOf({ slug: 'a', title: '甲页', exists: undefined }), 'unknown')
})

test('linkStateOf：exists 缺失**绝不**归为 missing —— 那会给用户一个可能建出重复页的入口', () => {
  // 反向链接本就没有 exists 字段（服务端已按可见性过滤过），它们必须走 unknown 而非 missing。
  assert.equal(linkStateOf({ slug: 'a', title: '甲页' }), 'unknown')
  /*
    即使 title 为 null 也一样：缺失只说明"这个后端没告诉我们"，不等于"目标不存在"。
    把"不知道"当"不存在"，用户就会去创建一个可能已经存在的页面 ⇒ 脏数据 + 错误引导。
  */
  assert.equal(linkStateOf({ slug: 'ghost', title: null }), 'unknown')
  assert.notEqual(linkStateOf({ slug: 'ghost', title: null }), 'missing')
})

test('isMissingRef / isHiddenRef：红链与"存在但看不到"必须互斥', () => {
  const missing = { slug: 'a', title: null, exists: false } as const
  const hidden = { slug: 'a', title: null, exists: 'hidden' } as const
  const ok = { slug: 'a', title: '甲页', exists: true } as const

  assert.equal(isMissingRef(missing), true)
  assert.equal(isMissingRef(hidden), false) // ← 归错的后果是引导用户创建已存在的页
  assert.equal(isMissingRef(ok), false)

  assert.equal(isHiddenRef(hidden), true)
  assert.equal(isHiddenRef(missing), false)
  assert.equal(isHiddenRef(ok), false)
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

test('hiddenHint：措辞必须**说明"存在"** —— 这一项的全部价值就是告诉用户别去新建它', () => {
  const hint = hiddenHint('secret-page')
  assert.ok(hint.includes('已存在'), hint)
  assert.ok(hint.includes('secret-page'), hint)
  // 若只写"无权查看"，用户仍可能以为目标不存在而去创建。
  assert.notEqual(hint, missingHint('secret-page'))
})

test('missingNewPageHref：指向新建页（路由不支持预填 slug，见函数注释）', () => {
  assert.equal(missingNewPageHref(), '#/wiki/new')
})

test('HIDDEN_LINK_ATTR：与红链标记是不同的属性（否则测试只能靠类名猜三态）', () => {
  assert.equal(HIDDEN_LINK_ATTR, 'data-gw-hidden')
  assert.notEqual(HIDDEN_LINK_ATTR, 'data-gw-missing')
})
