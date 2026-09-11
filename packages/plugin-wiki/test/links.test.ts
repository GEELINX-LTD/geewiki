/**
 * links.ts 的单测：站内链接抽取与归一化。
 *
 * 重点在**"跳过代码"**——正文里的示例文本（如 `` `[x](y)` ``）若被当成真实链接，
 * 反向链接里会混进不存在的页面。这是本模块最容易做错的地方，故用例最密。
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { extractLinkTargets, maskCode, normalizeLinkTarget } from '../src/links.js'
import { isValidSlug } from '../src/index.js'

const ex = (md: string): string[] => extractLinkTargets(md, isValidSlug)

/* ============================ 归一化 ============================ */

test('normalizeLinkTarget：站内写法归一化', () => {
  const cases: [string, string | null][] = [
    ['/wiki/foo', 'foo'],
    ['#/wiki/foo', 'foo'],
    ['/foo', 'foo'],
    ['foo', 'foo'],
    ['  foo  ', 'foo'],
    ['<foo>', 'foo'],
    ['</wiki/foo>', 'foo'],
    ['/wiki/guides%2Fintro', 'guides/intro'],
    ['/wiki/foo#section', 'foo'],
    ['/wiki/foo?x=1', 'foo'],
    ['./foo', 'foo'],
    // 纯锚点 / 绝对 URI 一律不是站内链接
    ['#section', null],
    ['https://example.com/foo', null],
    ['mailto:a@b.c', null],
    ['', null],
    ['   ', null],
    ['/', null],
  ]
  for (const [input, want] of cases) {
    assert.equal(normalizeLinkTarget(input), want, `归一化 ${JSON.stringify(input)}`)
  }
})

test('normalizeLinkTarget：裸写 wiki/foo 是合法层级 slug，不被当作路由前缀剥掉', () => {
  // 只有**带前导斜杠**的 /wiki/foo 才按路由形态剥前缀；否则 wiki/foo 本身是合法 slug。
  // 这是支持两种写法的代价，已在源码登记。
  assert.equal(normalizeLinkTarget('/wiki/foo'), 'foo')
  assert.equal(normalizeLinkTarget('wiki/foo'), 'wiki/foo')
})

test('normalizeLinkTarget：非法百分号编码按原样处理，不抛错', () => {
  assert.equal(normalizeLinkTarget('/wiki/%zz'), '%zz')
})

/* ============================ 抽取：写法 ============================ */

test('extractLinkTargets：支持 Markdown 链接的各种站内写法', () => {
  assert.deepEqual(ex('[甲](/wiki/foo)'), ['foo'])
  assert.deepEqual(ex('[甲](#/wiki/foo)'), ['foo'])
  assert.deepEqual(ex('[甲](/foo)'), ['foo'])
  assert.deepEqual(ex('[甲](foo)'), ['foo'])
  assert.deepEqual(ex('[甲](<foo>)'), ['foo'])
  assert.deepEqual(ex('[甲](/wiki/foo "标题")'), ['foo'])
})

test('extractLinkTargets：支持 wikilink 两种形态', () => {
  assert.deepEqual(ex('[[foo]]'), ['foo'])
  assert.deepEqual(ex('[[foo|显示文本]]'), ['foo'])
  assert.deepEqual(ex('见 [[guides/intro|入门]] 一节'), ['guides/intro'])
})

test('extractLinkTargets：层级 slug 与 %2F 解码', () => {
  assert.deepEqual(ex('[甲](/wiki/guides%2Fintro)'), ['guides/intro'])
  assert.deepEqual(ex('[甲](guides/intro)'), ['guides/intro'])
})

/* ============================ 抽取：跳过代码 ============================ */

test('extractLinkTargets：围栏代码块内的链接不得被抽取', () => {
  const md = ['正常 [甲](real-one)', '```md', '[乙](in-fence)', '[[in-fence-2]]', '```', '结尾 [丙](real-two)'].join('\n')
  assert.deepEqual(ex(md), ['real-one', 'real-two'])
})

test('extractLinkTargets：~~~ 围栏同样跳过，且未闭合的围栏吃到文末', () => {
  assert.deepEqual(ex(['~~~', '[乙](in-fence)', '~~~', '[丙](after)'].join('\n')), ['after'])
  assert.deepEqual(ex(['```', '[乙](in-fence)'].join('\n')), [])
})

test('extractLinkTargets：围栏内容串里的标记不算闭合围栏', () => {
  // 开启围栏有 4 个反引号，则 3 个反引号的行不构成闭合
  const md = ['````', '```', '[乙](still-in-fence)', '````', '[丙](outside)'].join('\n')
  assert.deepEqual(ex(md), ['outside'])
})

test('extractLinkTargets：行内代码内的链接不得被抽取', () => {
  assert.deepEqual(ex('写法是 `[甲](inline-code)` 这样'), [])
  assert.deepEqual(ex('`[[inline-wiki]]` 也不是链接'), [])
  assert.deepEqual(ex('前缀 `code` 然后 [甲](real)'), ['real'])
})

test('extractLinkTargets：多反引号行内代码按长度配对（``a`` 与 `b` 不互为闭合）', () => {
  // `` 开启、`` 闭合；中间的单反引号不闭合
  assert.deepEqual(ex('``[甲](in-code)` `` [乙](real)'), ['real'])
})

test('extractLinkTargets：缩进代码块内的链接不得被抽取', () => {
  const md = ['段落', '', '    [甲](indented-code)', '', '[乙](real)'].join('\n')
  assert.deepEqual(ex(md), ['real'])
})

test('extractLinkTargets：缩进不能打断段落（紧跟段落文字的缩进行不算代码块）', () => {
  // CommonMark：缩进代码块不能打断段落，故这里的链接应被抽取
  assert.deepEqual(ex(['段落文字', '    [甲](real)'].join('\n')), ['real'])
})

test('extractLinkTargets：文档开头即缩进 → 是缩进代码块', () => {
  assert.deepEqual(ex('    [甲](code-at-start)'), [])
})

/* ============================ 抽取：过滤与去重 ============================ */

test('extractLinkTargets：非法 slug 一律丢弃（复用 isValidSlug）', () => {
  const md = [
    '[保留段](search)',
    '[第二段保留字](guide/edit)',
    '[空段](a//b)',
    '[超深](' + 'a/'.repeat(9) + 'a)',
    '[外链](https://example.com/x)',
    '[锚点](#section)',
    '[合法](real)',
  ].join('\n')
  assert.deepEqual(ex(md), ['real'])
})

test('extractLinkTargets：去重并保持首次出现顺序', () => {
  const md = ['[甲](b)', '[乙](a)', '[[b]]', '[丙](c)', '[丁](/wiki/a)'].join('\n')
  assert.deepEqual(ex(md), ['b', 'a', 'c'])
})

test('extractLinkTargets：畸形输入不崩且不误抽', () => {
  const md = ['[未闭合](', '[[未闭合', '[甲](好的', '![](/x.png)', '[](empty-text)'].join('\n')
  // 未闭合的 `](` 不产生目标；中文目标因不符合 slug 字符集被丢弃；
  // 图片链接与"空显示文本"都是合法链接（后者只是文本为空）
  assert.deepEqual(ex(md), ['x.png', 'empty-text'])
})

test('extractLinkTargets：空正文与纯文本返回空数组', () => {
  assert.deepEqual(ex(''), [])
  assert.deepEqual(ex('既没有链接也没有其它东西。'), [])
})

test('extractLinkTargets：自链接也被记录（由调用方决定是否需要过滤）', () => {
  assert.deepEqual(ex('[自己](self)'), ['self'])
})

/* ============================ maskCode 直接行为 ============================ */

test('maskCode：遮罩后原文长度按行保持（便于定位）', () => {
  const md = ['前言', '```', 'code', '```', '后记'].join('\n')
  const masked = maskCode(md)
  assert.equal(masked.split('\n').length, 5)
  assert.equal(masked.includes('code'), false)
  // 非代码行原样保留
  assert.equal(masked.split('\n')[0], '前言')
  assert.equal(masked.split('\n')[4], '后记')
})
