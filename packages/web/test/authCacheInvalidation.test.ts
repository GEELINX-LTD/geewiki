/**
 * **登录/登出必须清页面列表缓存** —— 源码级守卫（本文件存在的唯一理由）。
 *
 * 背景：`pagesStore` 是**模块级全局缓存**，它缓存的是"上一个身份能看到的页面列表"。
 * 登录后不失效 ⇒ 新身份可能复用匿名时的列表；登出后不失效 ⇒ 下一个使用者可能看到
 * 上一个身份的列表。这是前端侧最严重的越权残留，而且**没有任何报错**：
 * 页面照常渲染，只是内容属于别人。设计文档 §9 R5 与 §8.2 P1-6 都点名了这条。
 *
 * 为什么用**源码级**守卫而不是运行时断言：
 * 本仓库的前端测试全是"纯函数 + 源码守卫"两类的组合（先例：`breadcrumb.test.ts` 的
 * "单一渲染点"守卫、`degradedReason.test.ts` 的两侧对齐守卫）。而"某个函数里有没有
 * 调 `invalidatePages()`"是**调用点**问题——运行时断言需要 mock 整个 api 模块，
 * 而且 `useSyncExternalStore` 的 store 是模块级单例，跨用例互相污染。
 * 源码守卫恰好能钉住这个不变量，且不会因为将来换了实现而假通过（见下方的反空洞断言）。
 *
 * 守卫如何避免"空洞通过"：先断言**三段函数体都真的被抽取出来了**（正则写坏 ⇒ 立即红），
 * 再断言每段里都出现 `invalidatePages()`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'authStore.ts')
const source = readFileSync(SRC, 'utf8')

/** 抽取一个顶层导出函数的函数体（到首个顶格 `}` 为止） */
function bodyOf(name: string): string {
  const re = new RegExp(`export async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`)
  const matched = re.exec(source)
  return matched?.[1] ?? ''
}

test('authStore：确有效果物 —— 三个改变身份的函数体都能被抽取出来（防正则写坏导致 0===0）', () => {
  for (const name of ['login', 'setup', 'logout']) {
    const body = bodyOf(name)
    assert.ok(body.length > 40, `应能抽取出 ${name} 的函数体（实际 ${body.length} 字符）`)
  }
})

test('authStore：login / setup / logout 三条路径都必须清页面列表缓存（§8.2 P1-6 / §9 R5）', () => {
  for (const name of ['login', 'setup', 'logout']) {
    assert.match(
      bodyOf(name),
      /invalidatePages\(\)/,
      `${name} 之后必须调用 invalidatePages()：否则跨身份复用的缓存就是一次静默越权`,
    )
  }
})

test('authStore：缓存失效只能来自 pagesStore 的那一个入口（不得就地自己清）', () => {
  assert.match(
    source,
    /import \{[^}]*invalidatePages[^}]*\} from '\.\/pagesStore'/,
    '必须复用 pagesStore 暴露的 invalidatePages，而不是自己造一个清理路径',
  )
  // 反例守卫：`logout` 里若只清 auth 而忘了清 pages，上面的断言就会红——
  // 这里额外钉住"先服务端吊销、再清本地"的顺序（顺序反了会让吊销失败时用户以为已登出）
  const logout = bodyOf('logout')
  const revokeAt = logout.indexOf('authLogout')
  const resetAt = logout.indexOf('resetToAnonymous')
  assert.ok(revokeAt >= 0 && resetAt >= 0, 'logout 应同时包含「服务端吊销」与「本地复位」')
  assert.ok(revokeAt < resetAt, '必须先请求服务端吊销，再清本地身份（否则吊销失败时用户会以为已登出）')
})
