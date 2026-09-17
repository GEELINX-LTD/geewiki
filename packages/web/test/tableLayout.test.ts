/**
 * ★ 表格布局守卫：**滚动容器必须在包裹层上，不能给 `<table>` 自己设 `display: block`**。
 *
 * ## 防的是一次真实回归
 * `styles.css` 里曾是：
 *
 *     .md-body table { … display: block; max-width: 100%; overflow-x: auto; }
 *
 * 注释当时写着"既有观感不变"——**那句是错的**。`display: block` 会让 `<thead>` 与
 * `<tbody>` 各自成为**独立的匿名表格盒**，于是表头与数据行渲染成两个互不相连的框、
 * 列也不再对齐：一张表看起来像两张（用户报的「编辑器中的表格渲染有问题」，附图为证）。
 *
 * 这个错法很容易被"再优化回去"——`display: block` 确实是让 `<table>` 产生滚动容器
 * 的**最短写法**，不知道这条教训的人会重新写上。所以把它钉成 CI 判据。
 *
 * 没有 DOM、测不了真实布局，故这里钉的是**判据**（规则里不许有 display:block；
 * 滚动必须在包裹层上），而不是像素。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * **必须先剥 CSS 注释再断言**：样式文件里解释"为什么不能这么写"的注释里必然引述那条
 * 旧规则（本文件第二段的注释就原样引了）。不剥注释就会把解释本身当违规 ——
 * 这个坑本仓库本会话已经踩到**第四次**（脚手架生成器、迁移方言守卫、附件探针守卫、
 * 这次的表格守卫），规则完全一样：**判据要能区分"代码里写了"与"注释里提到"。**
 */
const CSS = readFileSync(join(HERE, '..', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

test('★ 表格：不得用 display:block 做横向滚动（会把一张表拆成两个框）', () => {
  const rule = /\.md-body table\s*\{([^}]*)\}/.exec(CSS)
  assert.ok(rule, '未找到 .md-body table 规则（判据失效即红，别让它空转通过）')
  const body = rule[1] as string
  assert.equal(
    /display\s*:\s*block/.test(body),
    false,
    '不要把 display:block 加回表格：它会让 thead/tbody 成为独立表格盒，一张表渲染成两个框',
  )
  assert.equal(
    /overflow-x\s*:\s*auto/.test(body),
    false,
    'overflow-x 也要放在包裹层上（见 .gw-table-scroll）',
  )
})

test('★ 表格：包裹层存在且承担滚动（两条渲染路径共用它）', () => {
  assert.match(
    CSS,
    /\.gw-table-scroll\s*\{[^}]*overflow-x\s*:\s*auto/,
    '.gw-table-scroll 必须承担 overflow-x:auto',
  )
  // 注入方：阅读页与编辑器的实时渲染块都要调用同一个 helper
  const render = readFileSync(join(HERE, '..', 'src', 'lib', 'markdownRender.ts'), 'utf8')
  assert.match(render, /export function wrapTables\(/, 'wrapTables 必须是可复用的导出')
  const editor = readFileSync(join(HERE, '..', 'src', 'components', 'editor', 'liveRender.ts'), 'utf8')
  assert.match(
    editor,
    /wrapTables\(wrap\)/,
    '编辑器的渲染块直接写 innerHTML、不走 renderMarkdownBody，必须显式调用 wrapTables',
  )
})
