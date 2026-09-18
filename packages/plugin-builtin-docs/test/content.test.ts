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
      assert.ok(m[1] && !m[1].includes('#'), `${doc.slug} 里的 [[${m[1]}]] 带锚点——前端会渲染成红链`)
      targets.push(m[1]!)
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
