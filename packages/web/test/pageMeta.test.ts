/**
 * 页面元信息纯逻辑单测（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/web test
 *
 * 钉住两件容易做错的事：
 * 1. `titleForRoute` 的**降级**：详情页标题是异步取回的，取不到时必须退化为「知识库」，
 *    **不能**把 slug 当标题显示出来；
 * 2. `stripDuplicateLeadingTitle` 的**保守**：只有首个一级标题与页面标题相同时才剥离，
 *    其余一切（二级标题、不同的一级标题、Setext 的 `---`、空标题）都必须原样返回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP_NAME, stripDuplicateLeadingTitle, titleForRoute } from '../src/lib/pageMeta'

/* ------------------------- titleForRoute ------------------------- */

test('titleForRoute：产品名后缀与分区名', () => {
  assert.equal(titleForRoute(''), `知识库 · ${APP_NAME}`)
  assert.equal(titleForRoute('wiki'), `知识库 · ${APP_NAME}`)
  assert.equal(titleForRoute('wiki/'), `知识库 · ${APP_NAME}`)
  assert.equal(titleForRoute('plugins'), `插件管理 · ${APP_NAME}`)
  assert.equal(titleForRoute('graph'), `依赖图 · ${APP_NAME}`)
})

test('titleForRoute：详情页用页面标题，取不到时退化为「知识库」而不是 slug', () => {
  assert.equal(titleForRoute('wiki/getting-started', '快速开始'), `快速开始 · ${APP_NAME}`)
  // 异步未回 / 取不到
  assert.equal(titleForRoute('wiki/getting-started', null), `知识库 · ${APP_NAME}`)
  assert.equal(titleForRoute('wiki/getting-started'), `知识库 · ${APP_NAME}`)
  // 空白标题等价于没有
  assert.equal(titleForRoute('wiki/getting-started', '   '), `知识库 · ${APP_NAME}`)
  // 绝不能出现 slug
  assert.ok(!titleForRoute('wiki/getting-started').includes('getting-started'))
})

test('titleForRoute：知识库下的保留子路由', () => {
  assert.equal(titleForRoute('wiki/new'), `新建页面 · ${APP_NAME}`)
  assert.equal(titleForRoute('wiki/search'), `搜索 · ${APP_NAME}`)
  assert.equal(titleForRoute('wiki/ask'), `问答 · ${APP_NAME}`)
  // 带查询串：查询串不进标题（可能很长）
  assert.equal(titleForRoute('wiki/search/%E6%A3%80%E7%B4%A2'), `搜索 · ${APP_NAME}`)
  assert.equal(titleForRoute('wiki/ask/%E6%A3%80%E7%B4%A2'), `问答 · ${APP_NAME}`)
  // 详情编辑页
  assert.equal(titleForRoute('wiki/getting-started/edit'), `编辑页面 · ${APP_NAME}`)
})

test('titleForRoute：前导 # 与多余斜杠、未知路由', () => {
  assert.equal(titleForRoute('#wiki'), `知识库 · ${APP_NAME}`)
  assert.equal(titleForRoute('/wiki/getting-started/', '快速开始'), `快速开始 · ${APP_NAME}`)
  // 未知路由：只显示产品名（不伪装成某个页面）
  assert.equal(titleForRoute('nope/whatever'), APP_NAME)
})

test('titleForRoute：标题文本原样呈现（不做 HTML 或 slug 变换）', () => {
  assert.equal(titleForRoute('wiki/a b', '含 空格 的标题'), `含 空格 的标题 · ${APP_NAME}`)
})

/* ------------------- stripDuplicateLeadingTitle ------------------- */

test('stripDuplicateLeadingTitle：首个 ATX 一级标题与页面标题相同时剥离', () => {
  const md = '# 快速开始\n\n正文第一段。\n\n## 第二步\n\n更多。'
  assert.equal(stripDuplicateLeadingTitle(md, '快速开始'), '正文第一段。\n\n## 第二步\n\n更多。')
})

test('stripDuplicateLeadingTitle：容忍开头空行与闭合井号、无空格写法', () => {
  assert.equal(stripDuplicateLeadingTitle('\n\n# 快速开始\n\n正文', '快速开始'), '\n\n正文')
  assert.equal(stripDuplicateLeadingTitle('# 快速开始 ##\n\n正文', '快速开始'), '正文')
  assert.equal(stripDuplicateLeadingTitle('#快速开始\n\n正文', '快速开始'), '正文')
})

test('stripDuplicateLeadingTitle：首尾空白差异不影响判定', () => {
  assert.equal(stripDuplicateLeadingTitle('#   快速开始  \n\n正文', ' 快速开始 '), '正文')
})

test('stripDuplicateLeadingTitle：Setext（===）一级标题同样剥离', () => {
  const md = '快速开始\n=====\n\n正文'
  assert.equal(stripDuplicateLeadingTitle(md, '快速开始'), '正文')
})

test('stripDuplicateLeadingTitle：标题不同 / 二级标题 / Setext 二级 → 原样返回', () => {
  const other = '# 别的标题\n\n正文'
  assert.equal(stripDuplicateLeadingTitle(other, '快速开始'), other)

  const h2 = '## 快速开始\n\n正文'
  assert.equal(stripDuplicateLeadingTitle(h2, '快速开始'), h2)

  // `---` 是二级标题，不能当一级标题剥掉
  const setextH2 = '快速开始\n---\n\n正文'
  assert.equal(stripDuplicateLeadingTitle(setextH2, '快速开始'), setextH2)

  // 7 个 `#` 不是合法 ATX 标题
  const seven = '####### 快速开始\n\n正文'
  assert.equal(stripDuplicateLeadingTitle(seven, '快速开始'), seven)
})

test('stripDuplicateLeadingTitle：保守 —— 页面标题为空、正文为空、只有标题', () => {
  const md = '# 快速开始\n\n正文'
  assert.equal(stripDuplicateLeadingTitle(md, ''), md)
  assert.equal(stripDuplicateLeadingTitle(md, '   '), md)
  assert.equal(stripDuplicateLeadingTitle('', '快速开始'), '')
  assert.equal(stripDuplicateLeadingTitle('   ', '快速开始'), '   ')
  // 正文只有这个标题：剥掉后应为空串（不残留标题）
  assert.equal(stripDuplicateLeadingTitle('# 快速开始', '快速开始'), '')
  assert.equal(stripDuplicateLeadingTitle('# 快速开始\n', '快速开始'), '')
})

test('stripDuplicateLeadingTitle：不触碰正文其余结构与行内标记', () => {
  const md = '# 快速开始\n\n- 列表项 **加粗**\n- 第二项\n\n```\n# 代码块里的井号\n```\n'
  const out = stripDuplicateLeadingTitle(md, '快速开始')
  assert.equal(out, '- 列表项 **加粗**\n- 第二项\n\n```\n# 代码块里的井号\n```\n')
  // 代码块里的 `#` 不受影响
  assert.ok(out.includes('# 代码块里的井号'))
})
