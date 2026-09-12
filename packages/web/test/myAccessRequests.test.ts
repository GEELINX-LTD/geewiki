/**
 * **"我提交过的访问申请"本地句柄**（M3）—— 单测。
 * ============================================================================
 *
 * 这个模块只有 4 个短函数，但它服务于一个**不能失败**的动作：撤回。
 * 撤回端点按 id 定位，而服务端没有"查我的待审申请"的端点（那是审批人视角），
 * 所以句柄只存在于本地存储 —— 存坏了、读错了、或者抛异常把页面搞崩，
 * 用户就永远撤不回自己的申请。
 *
 * 因此这里重点测**失败路径**：坏 JSON、脏数据、getItem/setItem 抛错、
 * `window.localStorage` 取值本身就抛（Safari 隐私模式）、乃至根本没有 window
 * —— 全部必须**静默降级**（返回 null / 什么都不做），绝不抛。
 *
 * 注入方式：模块每次调用都现取 `window.localStorage`（不在模块顶层缓存），
 * 所以测试只要换掉 `globalThis.window` 即可，不需要 mock 框架。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MY_ACCESS_REQUESTS_KEY,
  forgetRequest,
  recallRequest,
  rememberRequest,
} from '../src/lib/myAccessRequests'

interface FakeStorage {
  map: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
}

function installWindow(localStorage: unknown): void {
  ;(globalThis as unknown as { window?: unknown }).window = { localStorage }
}

function uninstallWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window
}

/* ------------------------------ 往返 ------------------------------ */

test('写读删往返：多条互不干扰，删一条不影响另一条', () => {
  installWindow(fakeStorage())
  try {
    rememberRequest('guide/intro', 7)
    assert.equal(recallRequest('guide/intro'), 7)
    rememberRequest('ops/runbook', 8)
    assert.equal(recallRequest('ops/runbook'), 8)
    assert.equal(recallRequest('guide/intro'), 7, '写第二条不该影响第一条')

    forgetRequest('guide/intro')
    assert.equal(recallRequest('guide/intro'), null)
    assert.equal(recallRequest('ops/runbook'), 8, '删一条不该把整张表清掉')

    forgetRequest('never-seen')
    assert.equal(recallRequest('ops/runbook'), 8, '删不存在的键是空操作')
  } finally {
    uninstallWindow()
  }
})

test('只存 {slug: id}：键名固定、载荷不含任何其它字段', () => {
  const s = fakeStorage()
  installWindow(s)
  try {
    assert.equal(MY_ACCESS_REQUESTS_KEY, 'gw.access-requests.v1')
    rememberRequest('guide/intro', 12)
    const raw = s.map.get(MY_ACCESS_REQUESTS_KEY)
    assert.ok(raw !== undefined, '应写到固定键名上')
    assert.deepEqual(
      JSON.parse(raw as string),
      { 'guide/intro': 12 },
      '载荷只能是 slug → id 的映射（申请正文/角色属敏感信息，不该落本地）',
    )
  } finally {
    uninstallWindow()
  }
})

test('非法入参不写：空 slug、非正整数 id 一律忽略', () => {
  const s = fakeStorage()
  installWindow(s)
  try {
    for (const [slug, id] of [
      ['', 3],
      ['a', 0],
      ['a', -1],
      ['a', 1.5],
      ['a', Number.NaN],
      ['a', Number.POSITIVE_INFINITY],
    ] as const) {
      rememberRequest(slug, id)
      assert.equal(recallRequest(slug), null, `${JSON.stringify([slug, id])} 不该被存下来`)
    }
    assert.equal(s.map.size, 0, '非法入参不该写盘')
    assert.equal(recallRequest(''), null, '空 slug 连读都不该去读存储')
  } finally {
    uninstallWindow()
  }
})

/* ---------------------------- 静默降级 ---------------------------- */

test('坏 JSON 不抛：读回 null，且后续写入能覆盖掉坏值', () => {
  const s = fakeStorage({ [MY_ACCESS_REQUESTS_KEY]: '{这不是 JSON' })
  installWindow(s)
  try {
    assert.equal(recallRequest('a'), null)
    // 不该抛 —— 抛了的话详情页的 404 态会整块白屏
    assert.doesNotThrow(() => rememberRequest('a', 5))
    assert.equal(recallRequest('a'), 5, '写入应覆盖坏值，而不是被它带坏')
  } finally {
    uninstallWindow()
  }
})

test('脏数据逐项滤掉：字符串 id / 0 / 负数 / 小数 / 数组载荷', () => {
  const s = fakeStorage({
    [MY_ACCESS_REQUESTS_KEY]: JSON.stringify({ a: '7', b: 0, c: -1, d: 1.5, e: 9, f: null }),
  })
  installWindow(s)
  try {
    assert.equal(recallRequest('a'), null, '字符串 id 不是服务端给的形态')
    assert.equal(recallRequest('b'), null)
    assert.equal(recallRequest('c'), null)
    assert.equal(recallRequest('d'), null)
    assert.equal(recallRequest('f'), null)
    assert.equal(recallRequest('e'), 9, '合法项必须留下')

    // 数组/标量载荷整份作废（不是对象就没有 slug→id 的语义）
    for (const bad of ['[]', '[1,2]', '3', '"x"', 'null', 'true']) {
      s.map.set(MY_ACCESS_REQUESTS_KEY, bad)
      assert.equal(recallRequest('e'), null, `载荷 ${bad} 应被视为无记录`)
      assert.doesNotThrow(() => forgetRequest('e'))
    }
  } finally {
    uninstallWindow()
  }
})

test('getItem 抛错 ⇒ 静默降级（读返回 null，写/删不抛）', () => {
  installWindow({
    getItem: () => {
      throw new Error('SecurityError: 存储被禁用')
    },
    setItem: () => {
      throw new Error('SecurityError: 存储被禁用')
    },
  })
  try {
    assert.equal(recallRequest('a'), null)
    assert.doesNotThrow(() => rememberRequest('a', 1))
    assert.doesNotThrow(() => forgetRequest('a'))
    assert.equal(recallRequest('a'), null, '存不下就是"记不住"，不能抛')
  } finally {
    uninstallWindow()
  }
})

test('setItem 抛错（配额满）⇒ 不抛；本次会话内已有记录仍可读', () => {
  const s = fakeStorage({ [MY_ACCESS_REQUESTS_KEY]: JSON.stringify({ a: 1 }) })
  installWindow({
    getItem: s.getItem,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  })
  try {
    assert.equal(recallRequest('a'), 1)
    assert.doesNotThrow(() => rememberRequest('b', 2))
    assert.doesNotThrow(() => forgetRequest('a'))
  } finally {
    uninstallWindow()
  }
})

test('window.localStorage 取值本身抛（隐私模式）⇒ 不抛', () => {
  ;(globalThis as unknown as { window?: unknown }).window = {
    get localStorage(): unknown {
      throw new Error('SecurityError: 隐私模式下禁止访问 localStorage')
    },
  }
  try {
    assert.equal(recallRequest('a'), null)
    assert.doesNotThrow(() => rememberRequest('a', 1))
    assert.doesNotThrow(() => forgetRequest('a'))
  } finally {
    uninstallWindow()
  }
})

test('没有 window（Node / SSR）⇒ 全部为空操作且不抛', () => {
  uninstallWindow()
  assert.equal(recallRequest('a'), null)
  assert.doesNotThrow(() => rememberRequest('a', 1))
  assert.doesNotThrow(() => forgetRequest('a'))
})

test('localStorage 缺失（window 存在但没有该字段）⇒ 不抛', () => {
  ;(globalThis as unknown as { window?: unknown }).window = {}
  try {
    assert.equal(recallRequest('a'), null)
    assert.doesNotThrow(() => rememberRequest('a', 1))
  } finally {
    uninstallWindow()
  }
})
