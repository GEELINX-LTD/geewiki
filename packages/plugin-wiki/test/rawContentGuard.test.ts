/**
 * `rawContent` 的**两条防线**守卫。
 *
 * ## 这条缺陷的形态（本仓实测复现过两次）
 * `<!--gated:org-->` 这类标记是**可见性结构**，而投影会把它吃掉（换成人读的占位）。
 * 于是"读投影 → 改内容 → 整篇写回"这条最自然的编辑链路，一次普通的改标点就会把
 * 受限段落**静默变成公开**（`packages/plugin-wiki/src/index.ts:894` 记着实测）。
 *
 * 第一次修复放在**路由层**（`?content=raw` 时先 `resolvePage`，无编辑权 ⇒ 403）。
 * 但 `getPage` 是 cordis 全局单例上的普通方法，**跨插件调用根本不经过路由**
 * （`@geewiki/ai-kb` 的 `read_page`、`@geewiki/ai-pages` 的 `page.update` 都是），
 * 同一条缺陷于是从另一条路上原样回来。第二次修复把判据**收进服务内部**
 * （`wantRaw = opts?.rawContent === true && access.canEdit`）。
 *
 * ## 为什么还要一条源码守卫（已经有用例了）
 * 判据收进 `getPage` 之后，**包装层漏转发一个参数**就足以让它整体失效：
 * `svc.get = async (slug, principal) => getPage(slug, principal)` —— 接口上加了第三个参数，
 * 实现里也写了，唯独这一层只转两个，于是**跨插件调用方永远拿到投影正文**，
 * 而 HTTP 路径照常拿到原文。两条路径行为不一致，**且不报错**。
 * 这个坑在 P4 尾巴上真的踩了：`page.update` 拿到投影正文并据此拒绝了写入，
 * 表现是"AI 说读不到原文" —— 拦住它的是一次端到端验收，不是任何一条单测。
 *
 * 行为面的证明在 `scripts/acceptance/p4-undo/run.ts`（它打真实 HTTP + 真实服务）；
 * 这里钉的是**包装层不许再少转一个参数**，因为那是"静默失效"最常见的入口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '../src/index.ts'), 'utf8')

test('源码守卫：`svc.get` 必须把第三个参数 opt 原样转发给 getPage', () => {
  const start = SRC.indexOf('const svc: WikiService = {')
  assert.notEqual(start, -1, '找不到 WikiService 的实现字面量 —— 守卫必须跟着改，别让它静默变空')
  const block = SRC.slice(start, SRC.indexOf('backlinks:', start))
  assert.match(
    block,
    /get:\s*async \(slug, principal, opts\)/,
    'svc.get 的形参里必须有 opts —— 少了它，rawContent 会被**静默丢掉**',
  )
  assert.match(block, /getPage\(slug, principal, opts\)/, 'svc.get 必须把 opts 转给 getPage')
})

test('源码守卫：判据在服务里（`wantRaw` 必须同时看 opts 与 canEdit）', () => {
  assert.match(
    SRC,
    /const wantRaw = opts\?\.rawContent === true && access\.canEdit/,
    'wantRaw 不能只看调用方要什么 —— 否则跨插件调用就是一条绕过权限的原文通道',
  )
})

test('源码守卫：路由层的 403 检查必须保留（纵深防御，不是重复）', () => {
  // 服务层拦不住"路由层先放行、服务层再退回投影"这种半开状态；
  // 两份检查同时存在时，任一份被误删都还有另一份在。
  assert.match(SRC, /raw_requires_edit/, '路由层的 403 `raw_requires_edit` 被删了')
})
