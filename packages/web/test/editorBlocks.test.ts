/**
 * `lib/editorBlocks.ts` —— 编辑页的**块模型**（服务端 `parseBlocks()` 的前端镜像 + 字符位置）。
 * ============================================================================
 *
 * 三组断言，缺一不可：
 *   1. **解析**：块边界（空行切块、围栏内不切）、标记行的归属、五类解析问题用的服务端错误码；
 *   2. **改写**：按块/按区段改档位后 —— 正文一字不变、块数不变、重写结果仍然合法；
 *   3. **源码级守卫**：四个手抄字面量（OPEN_RE / CLOSE_RE / KNOWN_MARKERS / FENCE_RE）
 *      与 `packages/plugin-wiki/src/blocks.ts` **逐字一致**。
 *
 * 为什么第 3 组必须有：web 不能 import 后端包（`packages/core` 不进浏览器包），镜像只能手抄。
 * 漂移的表现是"编辑页看着没问题、保存时服务端 400"，或者更糟 —— 作者以为收紧了、实际按
 * public 存下去。故宁可让这条守卫在改服务端时变红（仓库同款：`test/gatedPreview.test.ts`）。
 *
 * ⚠️ 对源码的**否定**断言一律先剥注释：本模块的解释性注释里就写着 `plugin-wiki`、`blocks.ts`
 * 这些字面量，不剥注释会把"说明"当成"代码"（仓库踩过这个坑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BLOCK_TIER_OPTIONS,
  BLOCK_TIER_VALUES,
  applyBlockTiers,
  blockAtOffset,
  blockTierOf,
  issuesText,
  parseSourceDoc,
  regionOfBlock,
  setBlockTier,
  setRegionTier,
  type GatedMarker,
  type TierRewrite,
} from '../src/lib/editorBlocks'
import type { BlockVisibility } from '../src/api'

/* ============================ 小工具 ============================ */

/** 改写成功 ⇒ 返回新正文；被拒绝 ⇒ 直接让测试失败（把 error 打出来，而不是只报 undefined） */
function rewritten(result: TierRewrite): string {
  if (!result.ok) assert.fail(`改写本应成功，却被拒绝：${result.error}`)
  return result.text
}

const blocksOf = (content: string): string[] => parseSourceDoc(content).blocks.map((b) => b.text)
const markersOf = (content: string): Array<GatedMarker | null> => parseSourceDoc(content).blocks.map((b) => b.marker)
const countOf = (text: string, needle: string): number => text.split(needle).length - 1

/** 内容里有区段、有围栏、有公开段 —— 解析类断言都用它 */
const SAMPLE = ['开头段落', '', '<!--gated:org-->', '甲段', '', '乙段', '<!--/gated-->', '', '结尾段落'].join('\n')

/* ======================= 一、parseSourceDoc ======================= */

test('parseSourceDoc：空行切块；**围栏里的空行不切**，且围栏的开/闭行本身属于代码块', () => {
  const doc = parseSourceDoc('前\n\n```\n代码一\n\n代码二\n```\n\n后')
  assert.deepEqual(doc.issues, [])
  assert.deepEqual(
    doc.blocks.map((b) => b.text),
    ['前', '```\n代码一\n\n代码二\n```', '后'],
    '围栏之间的空行是代码内容，不是块边界',
  )
  assert.deepEqual(
    doc.blocks.map((b) => b.kind),
    ['paragraph', 'code', 'paragraph'],
  )
  const code = doc.blocks[1]
  assert.equal(code?.startLine, 2, '开围栏那一行属于代码块')
  assert.equal(code?.endLine, 6, '闭围栏那一行也属于代码块（否则块文本会被截掉围栏）')
})

test('parseSourceDoc：围栏里的 gated 标记是**内容**，不开区段（与服务端一致）', () => {
  const doc = parseSourceDoc('```\n<!--gated:org-->\n```')
  assert.deepEqual(doc.issues, [])
  assert.deepEqual(doc.regions, [], '围栏里的标记不得开区段')
  assert.deepEqual(doc.blocks.map((b) => b.text), ['```\n<!--gated:org-->\n```'])
  assert.equal(doc.blocks[0]?.marker, null)
})

test('parseSourceDoc：标记行不属于任何块，区段内**每一块**都带该区段的 marker', () => {
  const doc = parseSourceDoc(SAMPLE)
  assert.deepEqual(doc.issues, [], '格式良好的正文不该有任何问题')
  assert.deepEqual(blocksOf(SAMPLE), ['开头段落', '甲段', '乙段', '结尾段落'])
  assert.ok(
    doc.blocks.every((b) => !b.text.includes('gated')),
    '标记行是区段分隔符而不是内容 —— 公共视图不会因为块文本里含标记而泄露"这里有个受限区段"',
  )
  assert.deepEqual(markersOf(SAMPLE), [null, 'org', 'org', null])
  assert.deepEqual(doc.blocks.map((b) => blockTierOf(b)), ['public', 'org', 'org', 'public'])
  assert.deepEqual(
    doc.regions.map((r) => [r.marker, r.blocks]),
    [['org', [1, 2]]],
  )
})

test('parseSourceDoc：from/to 能原样切回 text，区段的开闭位置指向标记行', () => {
  const doc = parseSourceDoc(SAMPLE)
  const lines = SAMPLE.split('\n')
  for (const b of doc.blocks) {
    assert.equal(SAMPLE.slice(b.from, b.to), b.text, `块 #${b.ordinal} 的位置区间应正好切回它的正文`)
    assert.equal(lines[b.startLine], b.text.split('\n')[0], 'startLine 应指向块的第一行')
  }
  const region = doc.regions[0]
  assert.equal(region?.openFrom, SAMPLE.indexOf('<!--gated:org-->'))
  assert.equal(region?.closeFrom, SAMPLE.indexOf('<!--/gated-->'))
  assert.equal(region?.from, SAMPLE.indexOf('甲段'), '区段正文从开标记那一行之后开始')
  assert.equal(region?.to, SAMPLE.indexOf('<!--/gated-->'), '到闭标记那一行之前为止')
  assert.equal(region?.openLine, 2)
  assert.equal(region?.closeLine, 6)
})

test('parseSourceDoc：五类问题都用**服务端的错误码**记下来（便于两侧文案对齐）', () => {
  const issuesOf = (content: string): string[] => parseSourceDoc(content).issues
  assert.deepEqual(issuesOf('<!--gated:org-->\n<!--gated:granted-->\n甲\n<!--/gated-->'), ['gated_nested'])
  assert.deepEqual(issuesOf('<!--gated:org-->\n\n甲'), ['gated_unclosed'])
  assert.deepEqual(issuesOf('甲\n<!--/gated-->'), ['gated_close_without_open'])
  assert.deepEqual(issuesOf('<!--gated:team-->\n\n甲'), ['gated_marker_unknown'], '不认识的档位必须报出来')
  assert.deepEqual(issuesOf('<!--gated:private-->\n\n甲'), ['gated_marker_removed'], '旧档位 private 已废弃')
  assert.deepEqual(
    issuesOf('<!--gated:role=editor-->\n\n甲'),
    ['gated_marker_removed'],
    'v2/v3 的 role=* 语法必须显式拒绝：静默忽略 = 作者以为收紧了、实际按 public 暴露',
  )
  assert.deepEqual(issuesOf('```\n甲'), ['code_fence_unclosed'])
})

test('parseSourceDoc：有问题时**不抛**，已经解析出来的块照常返回（编辑页还要画给作者看）', () => {
  const content = '开头\n\n<!--gated:org-->\n\n甲'
  const doc = parseSourceDoc(content)
  assert.deepEqual(doc.issues, ['gated_unclosed'])
  assert.deepEqual(doc.blocks.map((b) => b.text), ['开头', '甲'], '服务端在这里抛错中止，镜像必须继续解析')
  assert.equal(doc.blocks[1]?.marker, 'org')
  assert.equal(doc.regions[0]?.closeLine, null, '未闭合 ⇒ 没有闭合行')
  assert.equal(doc.regions[0]?.to, content.length, '未闭合区段一直延伸到文末')
})

test('parseSourceDoc：嵌套时保留**外层**区段，内层标记当无效（块仍归外层）', () => {
  const doc = parseSourceDoc('<!--gated:org-->\n<!--gated:granted-->\n甲\n<!--/gated-->')
  assert.deepEqual(doc.issues, ['gated_nested'])
  assert.equal(doc.regions.length, 1, '只认外层区段')
  assert.deepEqual(doc.blocks.map((b) => b.marker), ['org'], '内层标记不得把块改成 granted')
  assert.deepEqual(doc.blocks.map((b) => b.text), ['甲'])
})

test('parseSourceDoc：标记允许空格写法（`<!-- gated : granted -->`），档位取 trim 后的值', () => {
  const doc = parseSourceDoc('<!--  gated  :  granted  -->\n\n甲\n<!--  /gated  -->')
  assert.deepEqual(doc.issues, [])
  assert.deepEqual(doc.blocks.map((b) => b.marker), ['granted'])
})

test('issuesText：错误码直接露出来（作者要能拿着它对着服务端日志排查）', () => {
  assert.equal(issuesText([]), '')
  assert.equal(issuesText(['gated_nested']), 'gated_nested')
  assert.equal(issuesText(['gated_nested', 'gated_unclosed']), 'gated_nested、gated_unclosed')
})

/* ==================== 二、applyBlockTiers / setBlockTier ==================== */

test('applyBlockTiers：未标记块改成 org ⇒ 恰好一对标记，且**每块正文一字不变**、块数不变', () => {
  const content = '甲\n\n乙\n\n丙'
  const result = setBlockTier(content, 1, 'org')
  const text = rewritten(result)
  assert.equal(result.ok && result.changed, true)
  assert.equal(countOf(text, '<!--gated:org-->'), 1, '有且只有一个开标记')
  assert.equal(countOf(text, '<!--/gated-->'), 1, '有且只有一个闭标记')
  assert.deepEqual(blocksOf(text), blocksOf(content), '块正文必须一字不变（作者的手写换行不能被吃掉）')
  assert.deepEqual(markersOf(text), [null, 'org', null])
  assert.deepEqual(parseSourceDoc(text).issues, [], '改写结果必须自己也能解析')
})

test('applyBlockTiers：org → granted 只重写开标记（闭标记仍是一个）', () => {
  const content = '<!--gated:org-->\n\n甲\n\n<!--/gated-->\n\n乙'
  const text = rewritten(setBlockTier(content, 0, 'granted'))
  assert.equal(countOf(text, '<!--gated:granted-->'), 1)
  assert.equal(countOf(text, '<!--gated:org-->'), 0, '旧档位的开标记必须被换掉，不能两个并存')
  assert.equal(countOf(text, '<!--/gated-->'), 1)
  assert.deepEqual(markersOf(text), ['granted', null])
  assert.deepEqual(blocksOf(text), ['甲', '乙'])
})

test('applyBlockTiers：两个相邻的 org 块是**一个**区段（中间没有标记对），且同档位再应用是空操作', () => {
  const merged = rewritten(
    applyBlockTiers('甲\n\n乙\n\n丙', new Map<number, BlockVisibility>([[0, 'org'], [1, 'org']])),
  )
  assert.equal(countOf(merged, '<!--gated:org-->'), 1, '相邻同档块共用一个开标记')
  assert.equal(countOf(merged, '<!--/gated-->'), 1)
  assert.ok(!merged.includes('<!--/gated-->\n\n<!--gated:org-->'), '相邻同档块之间不得插入标记对')
  assert.deepEqual(markersOf(merged), ['org', 'org', null])
  assert.deepEqual(parseSourceDoc(merged).regions[0]?.blocks, [0, 1], '两块同属一个区段')

  const one = '<!--gated:org-->\n\n甲\n\n乙\n\n<!--/gated-->'
  const again = setBlockTier(one, 1, 'org')
  assert.equal(again.ok, true)
  if (again.ok) {
    assert.equal(again.changed, false, '档位没变 ⇒ changed=false')
    assert.equal(again.text, one, '档位没变 ⇒ 正文一个字都不动（幂等：编辑页不能"点一下就重排一次"）')
  }
})

test('applyBlockTiers：org → public 把开闭标记都去掉（"跟随页面档位"就是**不写**标记）', () => {
  const content = '<!--gated:org-->\n\n甲\n\n<!--/gated-->\n\n乙'
  const text = rewritten(setBlockTier(content, 0, 'public'))
  assert.ok(!text.includes('gated'), '标记必须全部消失')
  assert.deepEqual(markersOf(text), [null, null])
  assert.deepEqual(blocksOf(text), ['甲', '乙'])
})

test('applyBlockTiers：**任何**改写都不改变块数（块身份不能因为改档位而变）', () => {
  const content = ['甲', '', '<!--gated:org-->', '', '乙', '', '丙', '', '<!--/gated-->', '', '丁'].join('\n')
  assert.deepEqual(blocksOf(content), ['甲', '乙', '丙', '丁'])
  const cases: Array<[number, BlockVisibility]> = [
    [1, 'granted'],
    [2, 'public'],
    [0, 'org'],
    [3, 'org'],
    [1, 'public'],
  ]
  for (const [ordinal, tier] of cases) {
    const text = rewritten(setBlockTier(content, ordinal, tier))
    assert.equal(blocksOf(text).length, 4, `块 #${ordinal} → ${tier} 之后块数应不变`)
    assert.deepEqual(blocksOf(text), blocksOf(content), `块 #${ordinal} → ${tier} 之后每块正文应一字不变`)
    assert.deepEqual(parseSourceDoc(text).issues, [], '重写后的标记必须合法（模块内部自检也看这一条）')
  }
})

test('applyBlockTiers：正文有任何解析问题 ⇒ 拒绝改写（绝不基于自己都解析不了的正文去动标记）', () => {
  const bad = [
    '<!--gated:team-->\n\n甲',
    '<!--gated:org-->\n\n甲',
    '甲\n\n<!--/gated-->',
    '```\n甲',
    '<!--gated:org-->\n<!--gated:granted-->\n甲\n<!--/gated-->',
  ]
  for (const content of bad) {
    const r = setBlockTier(content, 0, 'public')
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(content)}`)
    if (r.ok) continue
    assert.ok(
      r.error.includes(parseSourceDoc(content).issues[0] ?? ''),
      '错误文案里要露出错误码，便于对着服务端日志排查',
    )
    assert.ok(!('text' in (r as unknown as Record<string, unknown>)), '拒绝时不得给出半截正文')
  }
})

test('applyBlockTiers：**空的**受限区段 ⇒ 拒绝（改写会把它静默吃掉，作者以为只是删了标记）', () => {
  for (const content of ['<!--gated:org-->\n\n<!--/gated-->', '<!--gated:granted-->\n<!--/gated-->']) {
    const r = setBlockTier(content, 0, 'public')
    assert.equal(r.ok, false, `空的受限区段应拒绝：${JSON.stringify(content)}`)
    if (!r.ok) assert.ok(r.error.includes('空'), '文案要说清是"空的受限区段"')
  }
})

test('applyBlockTiers：CRLF 输入 ⇒ 输出只有 LF，块正文（归一后）一字不变', () => {
  const content = '<!--gated:org-->\r\n\r\n甲\r\n\r\n乙\r\n\r\n<!--/gated-->\r\n\r\n丙'
  const before = parseSourceDoc(content)
  const text = rewritten(setBlockTier(content, 1, 'granted'))
  assert.ok(!text.includes('\r'), '输出不得留 CR（服务端按 LF 归一，留着只会让 diff 抖）')
  const after = parseSourceDoc(text)
  assert.deepEqual(after.issues, [])
  assert.equal(after.blocks.length, before.blocks.length)
  assert.deepEqual(after.blocks.map((b) => b.text), before.blocks.map((b) => b.text))
  assert.deepEqual(after.blocks.map((b) => b.marker), ['org', 'granted', null], '只有被改的那一块换档位')
})

test('applyBlockTiers：改档位只动标记行 —— 空行是作者的排版，来回切换不能把正文"长高"', () => {
  const content = '<!--gated:org-->\n\n甲\n\n<!--/gated-->\n\n乙'
  assert.equal(
    rewritten(setBlockTier(content, 0, 'granted')),
    '<!--gated:granted-->\n\n甲\n\n<!--/gated-->\n\n乙',
    '换档位只应改开标记那一个词，其余一字不动',
  )
  let text = content
  for (let i = 0; i < 3; i++) {
    text = rewritten(setBlockTier(text, 0, 'granted'))
    text = rewritten(setBlockTier(text, 0, 'org'))
  }
  assert.equal(text, content, '来回切换三轮后应与原文一字不差（标记的补白空行不能被重复计数）')
})

/* ============ 三、blockAtOffset / regionOfBlock / setRegionTier ============ */

test('blockAtOffset：块内任意偏移命中该块，块之间的空行与标记行返回 null', () => {
  const doc = parseSourceDoc(SAMPLE)
  const first = doc.blocks[0]
  const second = doc.blocks[1]
  assert.equal(blockAtOffset(doc, first?.from ?? 0)?.ordinal, 0, '块首命中')
  assert.equal(blockAtOffset(doc, (first?.to ?? 0) - 1)?.ordinal, 0, '块尾命中')
  assert.equal(blockAtOffset(doc, second?.from ?? 0)?.ordinal, 1)
  assert.equal(blockAtOffset(doc, SAMPLE.indexOf('<!--gated:org-->')), null, '标记行不属于任何块')
  assert.equal(blockAtOffset(doc, (first?.to ?? 0) + 1), null, '块与标记之间的空行不是任何块')
  assert.equal(blockAtOffset(doc, SAMPLE.indexOf('<!--/gated-->')), null, '闭标记行同样不属于任何块')
})

test('regionOfBlock：区段内的块找到区段，未标记块/越界序号返回 null', () => {
  const doc = parseSourceDoc(SAMPLE)
  assert.equal(regionOfBlock(doc, 0), null, '公开块没有区段')
  assert.equal(regionOfBlock(doc, 1)?.marker, 'org')
  assert.equal(regionOfBlock(doc, 2)?.marker, 'org')
  assert.equal(regionOfBlock(doc, 3), null)
  assert.equal(regionOfBlock(doc, 99), null, '越界序号不抛')
})

test('setRegionTier：改区段里的**每一块**（含邻接同档块），未标记块则退化成只改自己', () => {
  const content = ['<!--gated:org-->', '', '甲', '', '乙', '', '<!--/gated-->', '', '丙'].join('\n')
  const text = rewritten(setRegionTier(content, 1, 'granted'))
  assert.deepEqual(markersOf(text), ['granted', 'granted', null], '区段里两块都要变')
  assert.equal(countOf(text, '<!--/gated-->'), 1, '两块同档 ⇒ 仍是一个区段')
  assert.deepEqual(blocksOf(text), ['甲', '乙', '丙'])

  const single = rewritten(setRegionTier('甲\n\n乙', 0, 'org'))
  assert.deepEqual(markersOf(single), ['org', null], '未标记块没有区段可改 ⇒ 退化成 setBlockTier')
})

/* ====================== 四、档位取值与选项表 ====================== */

test('blockTierOf / BLOCK_TIER_OPTIONS：未标记 = 「跟随页面档位」，**不能**叫「公开」', () => {
  const doc = parseSourceDoc(SAMPLE)
  assert.deepEqual(doc.blocks.map((b) => blockTierOf(b)), ['public', 'org', 'org', 'public'])
  assert.deepEqual(BLOCK_TIER_VALUES, ['public', 'org', 'granted'], '块没有 private 这一档')

  const follow = BLOCK_TIER_OPTIONS.find((o) => o.id === 'public')
  assert.ok(follow !== undefined)
  assert.equal(follow.label, '跟随页面档位')
  assert.notEqual(
    follow.label,
    '公开',
    '未标记块的有效档位还要与页面档位取更严的一方；写成「公开」会让作者以为"这块匿名能看到"',
  )
  assert.equal(follow.marker, null, 'public 就是不写标记')
  assert.deepEqual(
    BLOCK_TIER_OPTIONS.map((o) => o.marker),
    [null, 'org', 'granted'],
  )
  for (const o of BLOCK_TIER_OPTIONS) {
    assert.ok(o.label.length > 0 && o.hint.length > 0, '选项文案不能是空的')
    // 选项表与改写器必须是同一套口径：选哪档就该写出哪个标记（public 不写）
    assert.deepEqual(markersOf(rewritten(setBlockTier('甲', 0, o.id))), [o.marker], `${o.id} 应写出 ${o.marker}`)
  }
})

/* ========================= 五、源码级守卫 ========================= */

const MIRROR = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'editorBlocks.ts'), 'utf8')
const SERVER = readFileSync(join(import.meta.dirname, '..', '..', 'plugin-wiki', 'src', 'blocks.ts'), 'utf8')

/** 去掉 `/* … *\/` 与 `// …`：注释里的示例代码不是生效代码（本仓库踩过这个坑） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * 取某常量在源码里的**字面量文本**。
 *
 * 服务端的 `KNOWN_MARKERS` 写成 `new Set<string>([...])`、镜像写成裸数组，
 * 包一层容器只影响存放方式，要比的是**字面量本身**，故只把 `new Set<…>(…)` 的外壳剥掉。
 */
function literalOf(source: string, name: string): string {
  const line = source.split('\n').find((l) => l.startsWith(`const ${name} =`) || l.startsWith(`const ${name}:`))
  assert.ok(line !== undefined, `两侧源码都应定义常量 ${name}（改名的同时请改这条守卫）`)
  const rhs = line.slice(line.indexOf('=') + 1).trim()
  const wrapped = /^new\s+Set<[^>]*>\((.*)\)$/.exec(rhs)
  return wrapped?.[1] ?? rhs
}

const MIRRORED = ['OPEN_RE', 'CLOSE_RE', 'KNOWN_MARKERS', 'FENCE_RE'] as const

test('守卫：四个块语法字面量与服务端 blocks.ts **逐字一致**（镜像漂移必须变红）', () => {
  for (const name of MIRRORED) {
    const mirror = literalOf(MIRROR, name)
    const server = literalOf(SERVER, name)
    // 反空洞：提取器写坏时要立刻红，而不是拿两个空串互相 equal
    assert.ok(mirror.length > 0, `${name} 应能从镜像里提取出字面量`)
    assert.ok(server.length > 0, `${name} 应能从服务端里提取出字面量`)
    assert.equal(mirror, server, `${name} 两侧必须逐字一致：web 不能 import 后端包，只能手抄`)
  }
})

test('守卫：提取器真的取到了字面量（形状对得上，别把变量名当成值）', () => {
  for (const name of ['OPEN_RE', 'CLOSE_RE', 'FENCE_RE'] as const) {
    const literal = literalOf(MIRROR, name)
    assert.ok(literal.startsWith('/') && literal.endsWith('/'), `${name} 应是正则字面量，实际取到 ${literal}`)
  }
  assert.equal(literalOf(MIRROR, 'KNOWN_MARKERS'), "['org', 'granted']")
  assert.equal(
    literalOf(SERVER, 'KNOWN_MARKERS'),
    "['org', 'granted']",
    '服务端用 Set 装，但字面量本身仍是这个数组',
  )
  assert.equal(literalOf(SERVER, 'OPEN_RE'), literalOf(MIRROR, 'OPEN_RE'))
  assert.ok(literalOf(MIRROR, 'OPEN_RE').includes('gated'), '正则里得真有 gated 这个词')
})

test('守卫：镜像模块不得 import 后端包（web 包进不了浏览器，只能手抄纯逻辑）', () => {
  const code = codeOnly(MIRROR)
  assert.ok(MIRROR.includes('plugin-wiki'), '反空洞：注释里确实提到后端包，说明这条断言在测"剥注释"')
  for (const banned of ['@geewiki/core', '@geewiki/wiki', 'plugin-wiki']) {
    assert.ok(!code.includes(banned), `去掉注释后的实现里不得出现 ${banned}`)
  }
  assert.match(code, /import type \{ BlockVisibility \} from '\.\.\/api'/, '只允许这一条类型专用导入（编译后擦除）')
})
