/**
 * `image.save` 的**声明面**守卫（2026-09-20）。
 *
 * 这条工具是**两半点名同一个名字**的那种贡献（`packages/web/src/lib/clientTools.ts` 文件头）：
 * **服务端说"它存在"**（本包的描述符，进模型的工具表），
 * **浏览器说"它在我这儿怎么跑"**（`@geewiki/ai-assistant/ui/imageSave.ts` 登记处理器）。
 *
 * 因此这里钉四件事，每一件都对应一种"不报错的坏法"：
 *  ① 名字两侧一致——漂移的症状是**模型永远不调它**（描述符在、处理器不在，或反过来）；
 *  ② `side` 必须是 `'client'`——写成 `'server'` 会让 `loop.ts` 在服务端执行它，
 *    而服务端**没有图片字节**（用户可能在这一轮才说"把上一轮那张存起来"）；
 *  ③ 不得是 `mutating`——它只新增附件行，不改既有内容；标错了会让回退 UI
 *    多出一条点了没反应的条目；
 *  ④ 匿名主体必须被挡在工具表外——没有编辑权就没有上传权限，
 *    摆出来只会让模型答应一件注定 401 的事。
 *
 * 用**替身服务**而不是真 journal：本文件测的是描述符与收窄规则，
 * 不测"日志记了什么"（那件事在 `pages.test.ts` 里用真 journal 测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import type { Principal } from '@geewiki/core'
import { TOOL_DESCRIPTION_BUDGET } from '@geewiki/ai-tools'
import { AiPagesPlugin, IMAGE_TOOL_NAMES, manifest } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSISTANT_UI = ['..', '..', 'plugin-ai-assistant', 'ui', 'imageSave.ts']

const MEMBER: Principal = { kind: 'user', userId: 7, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }

interface CapturedDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly side: string
  readonly mutating?: boolean
  readonly available?: (principal: Principal) => boolean
}

interface Captured {
  readonly owner: string
  readonly descriptor: CapturedDescriptor
  readonly execute: (principal: Principal, args: unknown, context: unknown) => Promise<unknown>
}

/** 用替身把两条工具贡献捕下来，不碰 wiki / policy / journal 的真实实现 */
async function contributionOf(name: string): Promise<Captured> {
  const captured: Captured[] = []
  const ctx = new Context()
  ctx.provide('ai-tool-service', {
    contribute: (owner: string, tool: Captured) => {
      captured.push({ ...tool, owner })
      return () => {}
    },
    list: () => [],
    ownerOf: () => undefined,
    release: () => {},
    diagnostics: () => ({ count: 0, overBudget: [], mutating: [] }),
  })
  ctx.provide('ai-journal-service', {
    registerUndoer: () => () => {},
    registerProbe: () => () => {},
    record: async () => 1,
  })
  await ctx.plugin(AiPagesPlugin)
  const found = captured.find((c) => c.descriptor.name === name)
  assert.notEqual(found, undefined, `${name} 必须被贡献（当前：${captured.map((c) => c.descriptor.name).join(' / ') || '（无）'}）`)
  return found as Captured
}

test('① ★ 镜像守卫：工具名在服务端描述符与浏览器执行体两侧逐字一致', () => {
  assert.deepEqual([...IMAGE_TOOL_NAMES], ['image.save'], '本包声明的名字变了就要同步改浏览器那一半')
  const browser = readFileSync(join(HERE, ...ASSISTANT_UI), 'utf8')
  assert.match(
    browser,
    /export const IMAGE_SAVE_TOOL_NAME = 'image\.save'/,
    '浏览器那一半的名字必须与 IMAGE_TOOL_NAMES 一致（漂移 ⇒ 模型永远看不到这条工具）',
  )
  // 描述符里的 name 也必须是同一个字面量（不能只有常量对、贡献里写错）
  const source = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')
  assert.match(source, /name: 'image\.save'/)
})

test('① `page.update` 仍在（加了第二条贡献不得把它顶掉）', async () => {
  const update = await contributionOf('page.update')
  assert.equal(update.owner, manifest.name)
  assert.equal(update.descriptor.mutating, true, 'page.update 是写工具，必须仍然标 mutating')
})

test("② image.save 必须是 side:'client'，且服务端执行体一被调用就抛错", async () => {
  const tool = await contributionOf('image.save')
  assert.equal(tool.descriptor.side, 'client', '写成 server 会让服务端去执行一个它没有输入的工具')
  await assert.rejects(
    // 包一层 async：替身是**同步**抛错，而 `assert.rejects` 只接住拒绝（同步抛会被当成用例自身的错）
    async () => tool.execute(MEMBER, {}, {}),
    /side:'client'|不得执行/,
    '服务端真执行到它时必须显式抛错（代码错，不是用户输入错）',
  )
})

test('③ image.save 不得标 mutating（它只新增附件行，不改既有内容）', async () => {
  const tool = await contributionOf('image.save')
  assert.equal(tool.descriptor.mutating, undefined, '标成 mutating 会在回退 UI 上多出一条点了没反应的条目')
})

test('④ 匿名主体没有编辑/上传权，必须被挡在工具表之外', async () => {
  const tool = await contributionOf('image.save')
  assert.equal(typeof tool.descriptor.available, 'function', '必须声明 available，否则匿名的工具表里会有它')
  assert.equal(tool.descriptor.available?.(ANON), false, '匿名不得看到 image.save')
  assert.equal(tool.descriptor.available?.(MEMBER), true, '已登录成员可用')
})

test('④ 参数表：slug 必填、additionalProperties 关闭，且描述不超预算', async () => {
  const tool = await contributionOf('image.save')
  const params = tool.descriptor.parameters
  assert.deepEqual(params['required'], ['slug'], '只有 slug 是必填（index/name/alt 都可省）')
  assert.equal(params['additionalProperties'], false, '参数表必须是闭合的（模型会臆造字段）')
  assert.equal(params['type'], 'object', 'OpenAI 工具协议要求 object 根')
  assert.ok(
    tool.descriptor.description.length <= TOOL_DESCRIPTION_BUDGET,
    `描述 ${tool.descriptor.description.length} 字超过预算 ${TOOL_DESCRIPTION_BUDGET}（超预算不报错，但会稀释模型注意力）`,
  )
})
