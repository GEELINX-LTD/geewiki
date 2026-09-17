/**
 * `lib/gatedPreview.ts` —— 编辑器预览的块级可见性投影。
 *
 * 两组断言，缺一不可：
 *   1. **行为**：三个视角各自遮蔽什么、占位长什么样、非法标记被记下来。
 *   2. **源码级守卫**：镜像与服务端（`packages/plugin-wiki/src/blocks.ts`）的
 *      标记正则与占位文案**逐字一致**。
 *
 * 为什么第 2 组必须有：投影的真源在服务端，前端只是镜像（`packages/core` 不能进
 * 浏览器包）。镜像漂移的表现是"预览里看着没问题、线上别人看到的却不一样" ——
 * 而预览存在的**唯一理由**就是让作者相信它。所以宁可让这条守卫在改服务端时变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  projectForAudience,
  looksProjected,
} from '../src/lib/gatedPreview'

/* ------------------------------ 行为 ------------------------------ */

const SAMPLE = [
  '开头公开段落',
  '',
  '<!--gated:org-->',
  '组织内才看得到的细节',
  '<!--/gated-->',
  '',
  '中间公开段落',
  '',
  '<!--gated:granted-->',
  '只有被授权者看得到的运维备注',
  '<!--/gated-->',
  '',
  '结尾公开段落',
].join('\n')

test('gatedPreview：我的视角不遮蔽任何内容，但**剥掉标记**（标记是语法，不是内容）', () => {
  const r = projectForAudience(SAMPLE, 'all')
  assert.equal(r.gatedCount, 0)
  assert.deepEqual(r.invalidMarkers, [])
  assert.ok(r.markdown.includes('组织内才看得到的细节'), '我的视角应看到 org 段')
  assert.ok(r.markdown.includes('只有被授权者看得到的运维备注'), '我的视角应看到 granted 段')
  assert.ok(!r.markdown.includes('<!--gated'), '标记必须被剥掉（与 ParsedBlock.text 的语义一致）')
  assert.ok(!r.markdown.includes('<!--/gated-->'), '闭合标记同样要剥掉')
})

test('gatedPreview：组织成员视角遮蔽 granted 段，保留 org 段', () => {
  const r = projectForAudience(SAMPLE, 'org')
  assert.equal(r.gatedCount, 1, '只有 granted 那一段被遮蔽')
  assert.ok(r.markdown.includes('组织内才看得到的细节'), 'org 段对组织成员可见')
  assert.ok(!r.markdown.includes('运维备注'), 'granted 段的内容**一个字都不能出现**')
  assert.ok(r.markdown.includes('需更高权限查看'), '已登录读者的措辞是"需更高权限查看"')
})

test('gatedPreview：匿名视角两段都遮蔽，措辞是"需登录查看"', () => {
  const r = projectForAudience(SAMPLE, 'anonymous')
  assert.equal(r.gatedCount, 2)
  assert.ok(!r.markdown.includes('组织内才看得到的细节'))
  assert.ok(!r.markdown.includes('运维备注'))
  assert.ok(r.markdown.includes('需登录查看'), '匿名读者的措辞是"需登录查看"（可行动的提示）')
  assert.ok(r.markdown.includes('开头公开段落') && r.markdown.includes('结尾公开段落'), '公开部分不受影响')
})

test('gatedPreview：**连续的受限区段合并成一个占位**（行数不泄露分段方式）', () => {
  const two = ['<!--gated:org-->', '甲', '<!--/gated-->', '<!--gated:granted-->', '乙', '<!--/gated-->'].join('\n')
  const r = projectForAudience(two, 'anonymous')
  const placeholders = r.markdown.split('\n').filter((l) => l.includes('此处有'))
  assert.equal(placeholders.length, 1, '相邻的受限区段应合并成一个占位，而不是两行重复文案')
  assert.ok(placeholders[0]?.includes('2 段内容'), '合并后计数是两段')
})

test('gatedPreview：非法标记被记下来（保存时服务端会 400 拒绝，不能等保存才发现）', () => {
  const bad = ['<!--gated:role=editor-->', '旧语法', '<!--/gated-->'].join('\n')
  const r = projectForAudience(bad, 'anonymous')
  assert.deepEqual(r.invalidMarkers, ['role=editor'], '废弃的 v2/v3 标记必须被报出来')
})

test('gatedPreview：未闭合 / 多余闭合 / 嵌套都记进 invalidMarkers，且未闭合内容**不当作可见正文**', () => {
  const unclosed = projectForAudience('<!--gated:org-->\n没闭合的内容', 'all')
  assert.deepEqual(unclosed.invalidMarkers, ['unclosed'])
  assert.ok(!unclosed.markdown.includes('没闭合的内容'), '未闭合时按失败关闭处理：不吐出去')

  const extraClose = projectForAudience('普通\n<!--/gated-->', 'all')
  assert.deepEqual(extraClose.invalidMarkers, ['/gated'])

  const nested = projectForAudience('<!--gated:org-->\n<!--gated:granted-->\n甲\n<!--/gated-->', 'all')
  assert.ok(nested.invalidMarkers.includes('nested'), '嵌套是服务端的硬拒绝（gated_nested）')
})

/* --------------------------- 源码级守卫 --------------------------- */

const MIRROR = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'gatedPreview.ts'), 'utf8')
const SERVER = readFileSync(
  join(import.meta.dirname, '..', '..', 'plugin-wiki', 'src', 'blocks.ts'),
  'utf8',
)

test('守卫：前端镜像的标记正则与服务端**逐字一致**', () => {
  const open = '/^<!--\\s*gated\\s*:\\s*([^>]*?)\\s*-->\\s*$/'
  const close = '/^<!--\\s*\\/gated\\s*-->\\s*$/'
  for (const [name, src] of [
    ['服务端 blocks.ts', SERVER],
    ['前端镜像 gatedPreview.ts', MIRROR],
  ] as const) {
    assert.ok(src.includes(open), `${name} 的 OPEN_RE 字面量应与约定一致`)
    assert.ok(src.includes(close), `${name} 的 CLOSE_RE 字面量应与约定一致`)
  }
})

test('守卫：占位文案的关键措辞两边一致（措辞按读者而非内容选择）', () => {
  for (const [name, src] of [
    ['服务端 blocks.ts', SERVER],
    ['前端镜像 gatedPreview.ts', MIRROR],
  ] as const) {
    assert.ok(src.includes('此处有 '), `${name} 应含占位前缀「此处有 」`)
    assert.ok(src.includes('段内容'), `${name} 应含「段内容」`)
    assert.ok(src.includes('需登录查看'), `${name} 应含匿名措辞「需登录查看」`)
    assert.ok(src.includes('需更高权限查看'), `${name} 应含已登录措辞「需更高权限查看」`)
  }
})

/**
 * ★ 本批：`looksProjected` 是**编辑路径的安全网**。
 *
 * 它要认出的正是上面那句话 —— 服务端在"读者看不到某段"时写进正文的占位。
 * 一旦编辑页拿到这样的正文，保存就会把占位写进正文并丢掉段落权限标记
 * （受限段落静默变公开），故识别器必须对**服务端生成的两种措辞**都为真。
 */
test('looksProjected：认得出服务端生成的两种占位（编辑路径的安全网）', () => {
  // 两个措辞各一条（匿名 / 已登录但权限不够），以及多行正文里的情形
  assert.equal(looksProjected('> 🔒 此处有 2 段内容需登录查看'), true, '匿名措辞必须被认出')
  assert.equal(looksProjected('> 🔒 此处有 12 段内容需更高权限查看'), true, '已登录措辞必须被认出')
  assert.equal(
    looksProjected('前言\n\n> 🔒 此处有 1 段内容需登录查看\n\n结尾'),
    true,
    '混在正文里也要认得出来（多行匹配）',
  )
  // 不许误伤：普通的引用、普通的正文、以及**没有被遮蔽**的说明文字
  assert.equal(looksProjected('> 说明：占位的措辞按读者选择'), false, '普通引用不得被误判')
  assert.equal(looksProjected('这一段是公开的。'), false, '普通正文不得被误判')
  assert.equal(looksProjected('此处有 3 段内容需登录查看'), false, '没有引用前缀的行不是占位（服务端总会写成引用块）')
})

test('守卫：识别器与服务端占位文案同源（措辞改了必须一起改）', () => {
  /*
   * 正则里写死了「此处有 / 段内容 / 需登录查看 / 需更高权限查看」这几个片段。
   * 若哪天服务端改了措辞（比如「需登录后查看」），`looksProjected` 会**静默失效**
   * —— 那正是安全网最危险的失效方式（不报错、只是不再拦）。故这里钉住：
   * 正则中的片段必须仍出现在服务端的占位语句里。
   */
  for (const fragment of ['此处有', '段内容', '需登录查看', '需更高权限查看']) {
    assert.ok(SERVER.includes(fragment), `服务端占位文案应仍含「${fragment}」（否则识别器要跟着改）`)
  }
  assert.ok(MIRROR.includes('GATED_PLACEHOLDER_RE'), '镜像应导出识别式')
  assert.ok(MIRROR.includes('looksProjected'), '镜像应导出识别函数')
})

test('守卫：服务端只接受 org / granted（镜像不得放宽）', () => {
  assert.ok(SERVER.includes("只接受 org 与 granted"), '服务端的取值域说明应仍在')
  assert.ok(MIRROR.includes("spec !== 'org' && spec !== 'granted'"), '镜像的取值域判定应与之一致')
})
