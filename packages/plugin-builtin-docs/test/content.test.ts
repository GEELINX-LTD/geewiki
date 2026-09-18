/**
 * 内置文档**正文**的回归守卫。
 *
 * 这些文章是要给真人读的交付物，但更是**会被真解析器过一遍的数据**：
 * gated 标记写坏（不闭合/未知档位）会让同步当场抛错、检索回填卡住。所以本文件
 * 用 `@geewiki/wiki` 的**真** `parseBlocks` 与 **真** `isValidSlug` 逐篇过一遍，
 * 而不是抄一份简化规则——抄的规则会漂移，真解析器不会。
 *
 * 同时钉住几条"人看不出、上线才炸"的书写纪律：
 *   - wikilink 目标里带 `#锚点` 在前端会退化成红链（wikilink 的正则不含锚点段）；
 *   - home 必须链向其余全部目录页（新读者唯一的入口页）；
 *   - `DOCS_VERSION` 与正文的联动纪律由 `plugin.test.ts` 的行为用例负责，这里只钉类型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidSlug } from '@geewiki/wiki'
import { BUILTIN_DOCS } from '../src/catalog.js'
import { DOCS_VERSION } from '../src/types.js'

/**
 * `@geewiki/wiki` 的包出口刻意不含 blocks 模块（最小公开面），
 * 这里按仓库既有的"跨包读真源文件"纪律（测试读真迁移文件同理）直接动态 import。
 */
const blocks = (await import(
  pathToFileURL(join(import.meta.dirname, '..', '..', 'plugin-wiki', 'src', 'blocks.ts')).href
)) as {
  parseBlocks: (content: string) => { visibility: string }[]
}

const EXPECTED_SLUGS = ['home', 'guide/architecture', 'guide/features', 'guide/markdown-demo', 'guide/special-structures']

/* ------------------------------ 表格扫描：复现真渲染器的切列规则 ------------------------------ */

/**
 * 围栏开/闭行。**必须按"同字符且不短于开栏"判闭合**，不能见到反引号就取反：
 * 本仓的对照页用 4 个反引号包住 3 个反引号的示例（markdown-demo 的 ````md 段），
 * 取反式判断在嵌套处会把自己算回"不在围栏里"，于是把演示源码当成真表格来查。
 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

/** 表格分隔行（`:---:` / `---` / `:---`）；调用方还要求该行**含 `|`** —— 否则 `---` 分隔线与 Setext 下划线都会误判 */
const DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/**
 * 按 GFM 规则切分一行表格：`\|` 是转义（字面 `|`），首尾的裸 `|` 是边框而非单元格。
 *
 * 与 marked 的 `splitCells` 同语义 —— 本用例要复现的正是"渲染器怎么切，我们就怎么查"。
 */
function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && s[s.length - 2] !== '\\') s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

interface TableRow {
  /** 1 起算的行号：报错要能直接跳过去改 */
  readonly line: number
  readonly cells: readonly string[]
}

/** 正文里所有**活的**表格（跳过围栏代码块里的演示源码），按表头 → 数据行返回 */
function tablesOf(md: string): TableRow[][] {
  const lines = md.split('\n')
  const tables: TableRow[][] = []
  let fence: { char: string; len: number } | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch !== null) {
      const char = fenceMatch[1]![0]!
      const len = fenceMatch[1]!.length
      if (fence === null) fence = { char, len }
      else if (char === fence.char && len >= fence.len) fence = null
      continue
    }
    if (fence !== null) continue
    if (!line.includes('|') || !DELIMITER_RE.test(line)) continue
    const header = lines[i - 1]
    if (header === undefined || !header.includes('|')) continue
    const rows: TableRow[] = [
      { line: i, cells: splitTableRow(header) },
      { line: i + 1, cells: splitTableRow(line) },
    ]
    let j = i + 2
    while (j < lines.length && lines[j]!.trim() !== '' && lines[j]!.includes('|')) {
      if (FENCE_RE.test(lines[j]!)) break
      rows.push({ line: j + 1, cells: splitTableRow(lines[j]!) })
      j += 1
    }
    tables.push(rows)
    i = j - 1
  }
  return tables
}

test('目录构成：恰好这 5 篇，slug 全部合法且互不重复', () => {
  assert.deepEqual(
    [...BUILTIN_DOCS.map((d) => d.slug)].sort(),
    [...EXPECTED_SLUGS].sort(),
    '增删文档 = 改目录 + bump DOCS_VERSION（见 types.ts 注释）',
  )
  for (const doc of BUILTIN_DOCS) {
    assert.equal(isValidSlug(doc.slug), true, `${doc.slug} 必须是合法 slug（保留段/长度/字符集全过）`)
    assert.ok(doc.title.length > 0 && doc.title.length <= 200, `${doc.slug} 的标题要符合 wiki 的标题约束`)
    assert.ok(doc.content.length > 300, `${doc.slug} 正文不短于 300 字符（是文章不是占位符）`)
  }
})

test('每篇正文都能被真 parseBlocks 解析（gated 标记不闭合/未知档位会直接抛）', () => {
  for (const doc of BUILTIN_DOCS) {
    assert.doesNotThrow(() => blocks.parseBlocks(doc.content), `${doc.slug} 的正文必须能被块解析器接受`)
  }
})

test('gated 标记的分布：special-structures 有且仅有一个**活的** org 受限块；其余篇目一个都没有', () => {
  // 围栏代码里的标记会被解析器掩掉（字面演示），不计入"活块"
  const liveGated = (content: string): number =>
    blocks.parseBlocks(content).filter((b) => b.visibility === 'org' || b.visibility === 'granted').length
  for (const doc of BUILTIN_DOCS) {
    const expected = doc.slug === 'guide/special-structures' ? 1 : 0
    assert.equal(liveGated(doc.content), expected, `${doc.slug} 的活受限块数应为 ${expected}`)
  }
})

test('wikilink 纪律：目标里不得带 #锚点；home 链向其余全部目录页', () => {
  const targets: string[] = []
  for (const doc of BUILTIN_DOCS) {
    for (const m of doc.content.matchAll(/\[\[([^[\]\n|]+)(?:\|[^[\]\n]+)?\]\]/g)) {
      // 表格单元格里的 `[[slug\|别名]]`：那个 `\` 是 Markdown 对 `|` 的转义（渲染时被 marked 的
      // splitCells 还原，wikilink 扩展收到的仍是裸 `|`），**不是 slug 的一部分**——判据要的是转义前的目标。
      const target = m[1]!.replace(/\\/g, '')
      assert.ok(target !== '' && !target.includes('#'), `${doc.slug} 里的 [[${target}]] 带锚点——前端会渲染成红链`)
      targets.push(target)
    }
  }
  const home = BUILTIN_DOCS.find((d) => d.slug === 'home')!.content
  for (const slug of EXPECTED_SLUGS.filter((s) => s !== 'home')) {
    assert.ok(home.includes(`[[${slug}`), `home 必须链向 ${slug}（它是唯一入口页）`)
  }
  // 目录外的 wikilink 只允许示例红链（example/ 前缀是"演示用不存在页"的约定）
  for (const t of targets) {
    if (!EXPECTED_SLUGS.includes(t)) {
      assert.ok(t.startsWith('example/'), `${t} 不在目录里——真实页间链接必须落在目录内，红链演示用 example/ 前缀`)
    }
  }
})

test('DOCS_VERSION 是日期式整数戳（它不参与比较语义，只回答"变没变"）', () => {
  assert.equal(typeof DOCS_VERSION, 'number')
  assert.ok(Number.isInteger(DOCS_VERSION) && DOCS_VERSION >= 20250101 && DOCS_VERSION <= 20991231)
})

/**
 * 表格列数纪律。
 *
 * ## 为什么要有这条（真实缺陷）
 *
 * `home` 的目录表曾把 wikilink 写成 `| [[guide/architecture|架构]] | 引擎分层… |` ——
 * 单元格里的**裸 `|`** 被 marked 当成列分隔符，那一行被撕成 3 个单元格；而 marked 的
 * `splitCells` 只按表头列数（2）截断，**后面整整一列（"讲什么"）静默消失**：
 * 页面上既没有报错、也没有错位提示，只是那四句话不见了。
 *
 * 判据不看"有没有写 `\|`"这种表面特征，而是**用渲染器同一套规则切列、再比对列数** ——
 * 于是行内代码里的裸 `|`（markdown-demo 专门警告过的第二处）同样会被抓出来。
 */
test('表格纪律：每张表每行的列数必须与表头一致（单元格里的裸 `|` 会撕列并静默吞掉整列）', () => {
  let tables = 0
  for (const doc of BUILTIN_DOCS) {
    for (const rows of tablesOf(doc.content)) {
      tables += 1
      const header = rows[0]!
      for (const row of rows) {
        assert.equal(
          row.cells.length,
          header.cells.length,
          `${doc.slug}:${row.line} 切出 ${row.cells.length} 列，表头是 ${header.cells.length} 列 —— ` +
            '单元格里的 `|` 必须写成 `\\|`（`[[page\\|别名]]` 与行内代码同理，见 guide/markdown-demo「三条最常踩的坑」②）',
        )
      }
    }
  }
  // 判据写坏时不得靠"一张表都没扫到"空集通过（与库内其它守卫同款要求）
  assert.ok(tables >= 5, `至少应扫到 5 张表，实际 ${tables} —— 扫描逻辑可能已经失效`)
})
