/**
 * 站点主页**共享缓存**的取数口径（主页批，2026-09-18）。
 *
 * 这里只钉一件事，但它是本批最容易在混跑环境里出事的：**旧后端没有这个端点**。
 * 前端产物与后端是两个进程（dev 形态下 Vite 热更新、后端要重启；生产形态下也可能分开部署），
 * 于是"新前端 + 旧后端"必然出现，此时 `GET /api/site/home` 拿到的是 404。
 *
 * 判据：
 *   · **404 ⇒ 按"未设置"处理**（`unset`），落点回落约定 slug `home` —— 这正是本批之前的
 *     行为，`#/wiki` 这个**全站默认落点**必须照常工作；
 *   · 5xx / 网络不可达 ⇒ **仍然是错误**，不许一起吞掉：那会让主页静默指向约定 slug，
 *     而真正的原因（服务坏了）被藏起来 —— 那才是撒谎。
 *
 * 这条口径有实测依据：新前端 + 旧后端时，`#/wiki` 曾整页显示
 * 「内容不存在或已被删除 / 请求失败 (404)」——一个**设置**接口缺失，不该让全站默认落点变成错误页。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __homeStateForTest, __resetHomeStoreForTest, loadHome, type HomeState } from '../src/lib/homeStore'

/** 用临时的 fetch 替身跑一轮取数，返回结算后的 store 快照 */
async function loadWith(impl: () => Response | Promise<Response>): Promise<HomeState> {
  const original = globalThis.fetch
  const fake = (async () => await impl()) as typeof globalThis.fetch
  globalThis.fetch = fake
  __resetHomeStoreForTest()
  try {
    await loadHome()
    return __homeStateForTest()
  } finally {
    globalThis.fetch = original
    __resetHomeStoreForTest()
  }
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('旧后端（404）⇒ 按"未设置"处理：让 #/wiki 回落约定 slug，而不是整页报错', async () => {
  const snap = await loadWith(() => json({ ok: false, error: 'not_found', path: '/api/site/home' }, 404))
  assert.deepEqual(snap.home, { ok: true, state: 'unset' })
  assert.equal(snap.error, null, '404 不是错误：它表示"这个后端还没有主页设置"')
  assert.equal(snap.loading, false)
})

test('5xx ⇒ 仍然是错误（不许被 404 那条兜底一起吞掉）', async () => {
  const snap = await loadWith(() => json({ ok: false, error: 'internal' }, 500))
  assert.equal(snap.home, null, '真失败时不得给出任何结论')
  assert.ok(snap.error !== null, '必须留下可见的错误（界面据此给"重试"）')
})

test('网络不可达（fetch 抛错）⇒ 同样是错误，不静默回落', async () => {
  const snap = await loadWith(() => {
    throw new TypeError('Failed to fetch')
  })
  assert.equal(snap.home, null)
  assert.ok(snap.error !== null)
})

test('新后端：visible 原样存下（含分层 slug）', async () => {
  const snap = await loadWith(() => json({ ok: true, state: 'visible', slug: 'guide/intro' }, 200))
  assert.deepEqual(snap.home, { ok: true, state: 'visible', slug: 'guide/intro' })
  assert.equal(snap.error, null)
})

test('已有结论时再调 loadHome 命中缓存（不发第二次请求）', async () => {
  const original = globalThis.fetch
  let hits = 0
  globalThis.fetch = (async () => {
    hits += 1
    return json({ ok: true, state: 'unset' }, 200)
  }) as typeof globalThis.fetch
  __resetHomeStoreForTest()
  try {
    await loadHome()
    assert.equal(hits, 1)
    await loadHome()
    assert.equal(hits, 1, '缓存已有结论时不得重发（并发去重之外的第二次兜底）')
    // `force` 才重取：写完主页设置后走的就是这条路（见 invalidateHome）
    await loadHome({ force: true })
    assert.equal(hits, 2)
  } finally {
    globalThis.fetch = original
    __resetHomeStoreForTest()
  }
})
