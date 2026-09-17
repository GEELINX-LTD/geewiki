/**
 * `page.update` 的**可见性结构护栏**测试。
 *
 * ## 这道护栏要拦的是什么（P4 实测发现的权限红线）
 * `page.update` 的契约是"整篇替换正文"，而它拿到的正文来自 `read_page`。
 * 修复前那条链路是这样的：
 *
 *   `read_page` → `wiki-service.get(slug, principal)`（**不带** `rawContent`）
 *              ⇒ 投影正文：`<!--gated:org-->` 区段被换成「🔒 此处有 N 段内容」占位
 *   `page.update` → `wiki-service.save(slug, { content })`
 *              ⇒ 把**投影结果**当**原文**写回
 *
 * 后果是那次保存之后 `blocks` 从新正文重算：标记没了 ⇒ 受限区段**变成公开块**
 * （或者干脆被那段占位符替换掉，内容永久丢失）。整个过程不报错、不记日志。
 * 仓库里这条缺陷**已经为编辑者路径实测复现过一次**（`packages/plugin-wiki/src/index.ts:894`
 * 的注释写着"公开页 + gated 段，编辑者改一个标点后匿名访客即可读到该段"），
 * 当时的修复放在**路由层**；而跨插件调用（`ctx.get('wiki-service')`）根本不经过路由，
 * 于是同一条缺陷从另一条路上原样回来了。P4 的修法是把判据收进服务，并在此包加护栏。
 *
 * ## 为什么护栏是"比结构"而不是"比内容"
 * 允许 AI 改受限区段**里面**的文字（可见性没变），只拒绝会改变"哪些内容受哪种限制"的改写。
 * 比内容会把正常的润色也拦下来，那道闸很快就会被绕过（或者被删掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gatedRewriteRefusal, gatedShapeOf } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ============================== 纯函数：抽取 ============================== */

test('gatedShapeOf：按行识别标记，顺序敏感', () => {
  const shape = gatedShapeOf(['开头', '<!--gated:org-->', '机密', '<!--/gated-->', '结尾'].join('\n'))
  assert.equal(shape.broken, false)
  assert.deepEqual(shape.markers, ['org'])
})

test('gatedShapeOf：写成一行里的一部分 ⇒ 护栏按"认不出的痕迹"处理（比解析器保守）', () => {
  const shape = gatedShapeOf('这句话里 <!--gated:org--> 不算标记')
  /*
   * 解析器把它当普通文字（`OPEN_RE` 带 `^…$`），护栏则算 broken。
   * 这是**刻意**的偏差，理由写在 `GatedShape` 的注释里：方向朝"多拦一次"偏。
   * 这条用例把偏差钉住——它变绿的原因只能是"护栏放宽了"，那需要一次有意的决定。
   */
  assert.equal(shape.broken, true)
  assert.deepEqual(shape.markers, [])
})

test('gatedShapeOf：成对但嵌套 ⇒ broken（解析器同样拒绝嵌套）', () => {
  const shape = gatedShapeOf(['<!--gated:org-->', '<!--gated:granted-->', '<!--/gated-->', '<!--/gated-->'].join('\n'))
  assert.equal(shape.broken, true)
})

test('gatedShapeOf：只开不合 / 只合不开 ⇒ broken', () => {
  assert.equal(gatedShapeOf('<!--gated:org-->\n正文').broken, true)
  assert.equal(gatedShapeOf('正文\n<!--/gated-->').broken, true)
})

test('gatedShapeOf：形态认不出的 gated 痕迹 ⇒ broken（认不出就必须落在"拒绝"那一侧）', () => {
  // 解析器的 OPEN_RE 要求"gated:"后是 `[^>]*?` 再 `-->`；缺冒号就两种都不匹配
  assert.equal(gatedShapeOf('<!--gated org-->').broken, true)
  // 空白宽松形态是解析器认得的，护栏也必须认得——但要成对，否则仍算 broken
  const loose = gatedShapeOf('<!-- gated : org-->\n正文\n<!--/gated-->')
  assert.equal(loose.broken, false)
  assert.deepEqual(loose.markers, ['org'])
})

test('gatedRewriteRefusal：两边都没有 gated ⇒ 放行', () => {
  assert.equal(gatedRewriteRefusal('旧正文', '新正文'), null)
})

test('gatedRewriteRefusal：结构一模一样 ⇒ 放行（允许改区段里的文字）', () => {
  const before = ['开头', '<!--gated:org-->', '机密 A', '<!--/gated-->'].join('\n')
  const after = ['开头改了', '<!--gated:org-->', '机密 B', '<!--/gated-->'].join('\n')
  assert.equal(gatedRewriteRefusal(before, after), null)
})

test('gatedRewriteRefusal：**丢掉一个标记 ⇒ 拒绝**（这是这条缺陷的原始形态）', () => {
  const before = ['开头', '<!--gated:org-->', '机密', '<!--/gated-->'].join('\n')
  const after = '开头\n机密'
  const reason = gatedRewriteRefusal(before, after)
  assert.notEqual(reason, null)
  assert.match(reason as string, /受限区段/)
  assert.match(reason as string, /没有修改任何内容/)
})

test('gatedRewriteRefusal：**新增**一个标记也拒绝（AI 不得扩大限制范围）', () => {
  const before = '普通正文'
  const after = ['<!--gated:org-->', '正文', '<!--/gated-->'].join('\n')
  assert.notEqual(gatedRewriteRefusal(before, after), null)
})

test('gatedRewriteRefusal：档位被换掉（org → granted）也拒绝', () => {
  const before = ['<!--gated:org-->', '正文', '<!--/gated-->'].join('\n')
  const after = ['<!--gated:granted-->', '正文', '<!--/gated-->'].join('\n')
  assert.notEqual(gatedRewriteRefusal(before, after), null)
})

test('gatedRewriteRefusal：任一侧 broken ⇒ 拒绝（不知道就不动手）', () => {
  const ok = ['<!--gated:org-->', '正文', '<!--/gated-->'].join('\n')
  assert.notEqual(gatedRewriteRefusal(ok, '<!--gated:org-->\n正文'), null, '新正文没闭合')
  assert.notEqual(gatedRewriteRefusal('<!--gated:org-->\n正文', ok), null, '旧正文没闭合')
})

/* ============================== 源码守卫 ============================== */

/*
 * 这两个正则在本仓是**同一份事实的第二处**：解析器在 `packages/plugin-wiki/src/blocks.ts`，
 * 护栏在这里。两份对"什么算标记"的看法一旦分叉，护栏就会在解析器认得、它认不得的形态上
 * **静默放行**——那比误报糟得多，因为它看起来还在检查。
 *
 * 所以这条守卫**直接读解析器的源码**比对字面量，而不是断言"我认为标记长这样"。
 * 教训来源：`packages/web/test/appDockHost.test.ts` 曾因"被守卫的东西出现在被扫描的文本里"
 * 而恒红/恒绿；这里只扫 `blocks.ts` 的两行常量，不扫注释。
 */
test('源码守卫：护栏的两个正则必须与 blocks.ts 的 OPEN_RE / CLOSE_RE 逐字相同', () => {
  const blocks = readFileSync(join(HERE, '../../plugin-wiki/src/blocks.ts'), 'utf8')
  const mine = readFileSync(join(HERE, '../src/index.ts'), 'utf8')

  const grab = (src: string, name: string): string => {
    const m = new RegExp(`(?:const|export const)\\s+${name}\\s*=\\s*(/.+?/[a-z]*)\\s*$`, 'm').exec(src)
    assert.notEqual(m, null, `${name} 必须能在源码里找到（找不到就说明它被改名/挪走了，守卫必须跟着改）`)
    return (m as RegExpExecArray)[1] as string
  }

  assert.equal(grab(mine, 'GATED_OPEN_RE'), grab(blocks, 'OPEN_RE'), 'gated 开标记的正则分叉了')
  assert.equal(grab(mine, 'GATED_CLOSE_RE'), grab(blocks, 'CLOSE_RE'), 'gated 闭标记的正则分叉了')
})
