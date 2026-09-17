/**
 * **主体必填**——P1 验收里「漏传主体编译期报错」那一条的落点。
 *
 * 为什么这条值得单开一个测试文件：它是**唯一**能防住"一次编码疏忽变成全量泄漏"的机制
 * （原话见 `packages/plugin-wiki/src/index.ts` 的 P2 注释）。把主体做成可选参数，
 * 任何忘了传的调用点都会静默退化成"不过滤"——不报错、不告警，只是所有内容都对所有人可见。
 *
 * ## 这个文件里真正的断言是编译期断言
 * `pnpm test` 走 tsx，**只剥类型不做类型检查**，所以下面的类型断言与 `@ts-expect-error`
 * 在本文件运行时什么也不验证。它们由 `pnpm typecheck`（`tsc --noEmit`）验证。
 *
 * ## 三类守卫，各自能抓什么（写清楚是因为第一版写错了）
 * 1. {@link _handlerPrincipalIsExactlyPrincipal} 这类**条件类型断言**抓"首参被放宽成
 *    `Principal | undefined`"。这是最强的一条：可选参数会让 `Parameters<>[0]` 变成联合类型，
 *    而 `[Principal | undefined] extends [Principal]` 为假 ⇒ 常量声明报错。
 * 2. `@ts-expect-error` + **少传一个参数**抓"arity 被放宽"：`service.list()` 在
 *    `list(principal: Principal)` 下是「Expected 1 arguments, but got 0」，
 *    若 principal 变成可选，这一行就合法了，`@ts-expect-error` 失去作用 ⇒ TS2578 ⇒ typecheck 红。
 * 3. 正向对照行抓"上面那些断言的类型环境已经坏掉"。**没有正向对照，一个无关的类型错误
 *    可能顺带满足 `@ts-expect-error`，让守卫在该红的时候保持绿色**（第一版就踩了这个：
 *    把首参放宽成 `Principal | undefined` 时，红的是正向对照那一行，而不是我声称的那行）。
 *
 * 文件末尾那个空跑的真值断言只是让本文件在 `node --test` 下也是一条**通过**的用例，
 * 而不是一个"没有测试的文件"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Principal } from '@geewiki/core'
import { AiToolRegistry, type AiToolHandler, type AiToolService } from '../src/index.js'

/**
 * 编译期断言：`T` 与 `Principal` **互为子类型**（即恰好是 `Principal`，不多不少）。
 *
 * 用元组包一层是为了挡掉条件类型对联合类型的分配律——不包的话
 * `Principal | undefined extends Principal` 会在分配律下逐支判断，结论就错了。
 */
type ExactlyPrincipal<T> = [T] extends [Principal] ? ([Principal] extends [T] ? true : false) : false

/** handler 的首参必须恰好是 Principal（可选化 ⇒ 这里变成 false ⇒ 常量声明报错） */
const _handlerPrincipalIsExactlyPrincipal: ExactlyPrincipal<Parameters<AiToolHandler>[0]> = true
/** list 的参数必须恰好是 Principal（同上） */
const _listPrincipalIsExactlyPrincipal: ExactlyPrincipal<Parameters<AiToolService['list']>[0]> = true
void _handlerPrincipalIsExactlyPrincipal
void _listPrincipalIsExactlyPrincipal

declare const handler: AiToolHandler
declare const service: AiToolService
declare const principal: Principal

/**
 * 这个函数**从不被调用**——它存在的唯一目的是让下面几行进入 `tsc` 的检查范围
 * （函数体不会被裁剪，即使函数永不执行）。
 */
function _compileTimeGuards(): void {
  // ---- 正向对照：这些**必须**能编译 ----
  void handler(principal, { q: 'x' }, { conversationId: null, turnId: null })
  void service.list(principal)
  void service.contribute('x', {
    descriptor: {
      name: 'kb.search',
      description: '检索',
      parameters: { type: 'object', properties: {} },
      side: 'server',
    },
    execute: async (p: Principal, args: unknown) => ({ content: `${String(p.userId)}${String(args)}` }),
  })

  // ---- 反向：少传主体 / 少传参数 / 形状不符，都必须报错 ----

  // @ts-expect-error 零参调用 list()：principal 是必填的
  void service.list()

  // @ts-expect-error 少传参数：handler 的 args 不能省
  void handler(principal)

  // @ts-expect-error 首参形状必须符合 Principal，随便给个对象不行
  void handler({ q: 'x' }, { q: 'x' })
}
void _compileTimeGuards

const MEMBER: Principal = {
  kind: 'user',
  userId: 7,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}

test('执行体真的收到主体（类型约束之外，运行期也不能丢）', async () => {
  const reg = new AiToolRegistry()
  let got: Principal | undefined
  reg.contribute('kb', {
    descriptor: {
      name: 'kb.whoami',
      description: '回报当前主体',
      parameters: { type: 'object', properties: {} },
      side: 'server',
    },
    execute: async (p) => {
      got = p
      return { content: 'ok' }
    },
  })

  const tool = reg.list(MEMBER)[0]
  assert.ok(tool)
  await tool.execute(MEMBER, {}, { conversationId: null, turnId: null })

  assert.deepEqual(got, MEMBER)
})

test('list(principal) 把主体真的交给了 available 判据（不是只走个过场）', () => {
  const reg = new AiToolRegistry()
  const seen: (Principal | undefined)[] = []
  reg.contribute('kb', {
    descriptor: {
      name: 'kb.scoped',
      description: '按主体可用',
      parameters: { type: 'object', properties: {} },
      side: 'server',
      available: (p) => {
        seen.push(p)
        return true
      },
    },
    execute: async () => ({ content: 'ok' }),
  })

  reg.list(MEMBER)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], MEMBER)
})
