/**
 * **编辑路径的正文来源**——源码级守卫（★ 本批）。
 * ============================================================================
 *
 * ## 这一组守卫守的是什么
 *
 * 详情接口默认返回**按读者投影后**的正文：`<!--gated:org-->` 这类标记被消费掉、
 * 受限段落对看不到的人变成占位文案。编辑页此前用的就是这份正文，于是最普通的一次操作
 * ——"打开编辑页 → 改一个标点 → 保存"——会把标记写没：**受限段落静默变成公开**
 * （实测复现：公开页 + 组织受限段，保存后匿名访客能读到该段全文）。
 *
 * 修法是编辑页显式请求原文（`api.page(slug, { raw: true })` → 服务端 `?content=raw`，
 * 只对 `canEdit` 的主体下发，见 `packages/plugin-wiki/src/index.ts` 的路由注释）。
 *
 * 为什么用源码级守卫而不是渲染级：这条约束是"**谁在什么时候读了哪份正文**"，
 * 渲染级测试要拉起整个编辑页 + mock 网络 + 断言"发的请求带 raw"，
 * 而那件事在源码里就是一处字面量。真正的行为验证在服务端（`plugin-wiki` 的
 * 「★ 原文模式」用例）与浏览器验收（`scripts/acceptance/editor-modes-cdp.mjs`）里。
 *
 * ⚠️ 所有**否定**断言都先剥注释：本仓库反复踩过"注释里出现被禁字面量"的坑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

function readSrc(...parts: string[]): { raw: string; code: string } {
  const raw = readFileSync(join(SRC, ...parts), 'utf8')
  return { raw, code: stripComments(raw) }
}

/** 去掉行注释、块注释与 JSX 注释（只用于否定断言） */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

const page = readSrc('pages', 'WikiPage.tsx')

test('编辑页加载正文时**必须**请求原文（raw），否则保存会毁掉段落权限标记', () => {
  assert.ok(page.code.length > 5000, `WikiPage.tsx 读入异常（${page.code.length} 字符）`)
  assert.match(
    page.code,
    /api\s*\.\s*page\(slug,\s*\{\s*raw:\s*true\s*\}\)/,
    '编辑页必须用 api.page(slug, { raw: true }) 取正文（默认口径是投影后的，用它当原文会毁标记）',
  )
})

test('编辑页不得用「默认口径」的详情响应去填充正文', () => {
  /*
   * 唯一允许出现 `api.page(slug)` 的地方是**冲突检测**（只读 `updated_at`，不用正文）。
   * 若将来有人把 load() 改回默认口径，`raw: true` 那条断言会红；这条断言再兜一层：
   * 默认口径的调用**不得**出现在 `setContent` 附近（那正是"把投影结果当正文"的形状）。
   */
  const calls = [...page.code.matchAll(/api\s*\.\s*page\(([^)]*)\)/g)].map((m) => m[1] ?? '')
  assert.ok(calls.length >= 2, `应能抽到 api.page 的调用（实际 ${calls.length} 处）`)
  assert.ok(
    calls.some((args) => args.includes('raw: true')),
    '至少一处必须带 { raw: true }',
  )
  for (const args of calls) {
    if (args.includes('raw: true')) continue
    // 不带 raw 的调用只允许是冲突检测：它后面 200 字符内不得出现 setContent
    const at = page.code.indexOf(`api.page(${args})`)
    const near = page.code.slice(at, at + 400)
    assert.doesNotMatch(near, /setContent\(/, `不带 raw 的 api.page 调用不得用来填充正文（偏移 ${at}）`)
  }
})

test('「手上不是原文」的拦截必须存在：提示 + 保存拦截 + 两条出路', () => {
  // 1) 识别器来自 gatedPreview（占位文案的唯一镜像处）
  assert.match(
    page.code,
    /looksProjected\(content\)/,
    '必须用 looksProjected(content) 判断正文里有没有服务端占位文案',
  )
  // 2) 保存拦截：在真正发请求前 return
  assert.match(
    page.code,
    /if \(opts\.allowProjected !== true && looksProjected\(content\)\)[\s\S]{0,400}?setProjectedGuard\(true\)[\s\S]{0,80}?return/,
    '保存前必须拦一次（setProjectedGuard(true) 之后立即 return，不得继续发请求）',
  )
  // 3) 可见提示（role=alert）——不能只在对话框里说
  assert.match(page.code, /role="alert"[\s\S]{0,400}?占位文案/, '编辑区必须有一条 role="alert" 的就地提示')
  // 4) 两条出路都在：重新加载原文（load()）/ 仍然保存（allowProjected）
  assert.match(page.code, /重新加载原文/, '必须给出「重新加载原文」这条路')
  assert.match(page.code, /allowProjected: true/, '「仍然保存」必须显式带上 allowProjected')
})

test('保存拦截与冲突覆盖是两个开关（后果不同，不能共用一个 force）', () => {
  const saveSig = /async \(opts: \{ force\?: boolean; allowProjected\?: boolean \} = \{\}\)/
  assert.match(page.code, saveSig, 'save 的选项必须同时有 force 与 allowProjected')
  /*
   * 「仍然保存」同时带 force 是**有意**的：用户已经明确要覆盖，且手上的正文是投影结果，
   * 冲突检测再拦一次没有意义（会第二次弹同一个对话框，让人以为按钮坏了）。
   */
  assert.match(page.code, /save\(\{ force: true, allowProjected: true \}\)/)
})
