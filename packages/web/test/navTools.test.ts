/**
 * 跳转类客户端工具的宿主侧判据（需求 ②）。
 *
 * 这里测的都是**真正容易写错的那部分**：模型看不到渲染后的 DOM，它给的小节说法
 * 与真实的 id 之间隔着一层归一化（`## 用法` ⇒ `usage`），而对不上时的**反馈质量**
 * 决定了它下一轮是改对还是继续猜。
 *
 * 真实 DOM 的部分（`getElementById` / `scrollIntoView`）不在 node 里跑——
 * 它们经 {@link NavDom} 端口注入替身，判据本身因此可以逐条钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerNavTools, resolveAnchor, headingHints, type HeadingRef, type NavDom } from '../src/lib/navTools.js'
import { clientToolNames, invokeClientTool, unregisterClientTools } from '../src/lib/clientTools.js'

/** 一页典型的正文小节 */
const HEADINGS: readonly HeadingRef[] = [
  { id: 'usage', text: '用法' },
  { id: 'install-steps', text: '安装步骤' },
  { id: 'usage-1', text: '用法' },
]

function fakeDom(over: Partial<NavDom> = {}): NavDom & { scrolled: string[]; settled: string[] } {
  const scrolled: string[] = []
  const settled: string[] = []
  return {
    scrolled,
    settled,
    headings: () => HEADINGS,
    scrollTo: (id) => {
      scrolled.push(id)
      return true
    },
    settle: (id) => settled.push(id),
    ...over,
  }
}

/** 每个用例自建登记、结束时注销（`registerClientTool` 重名会抛错，故不能跨用例共享） */
async function withTools<T>(
  dom: NavDom,
  openPage: (slug: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const off = registerNavTools({ openPage, dom })
  try {
    return await fn()
  } finally {
    off()
    unregisterClientTools('host')
  }
}

/* ============================== resolveAnchor ============================== */

test('resolveAnchor：原样就是 id 时精确命中（优先级最高，避免归一化反而对不上）', () => {
  assert.equal(resolveAnchor('usage', HEADINGS), 'usage')
  assert.equal(resolveAnchor('usage-1', HEADINGS), 'usage-1')
})

test('resolveAnchor：标题原文归一化后命中（模型看到的是「用法」，不是 usage）', () => {
  assert.equal(resolveAnchor('安装步骤', HEADINGS), 'install-steps')
})

test('resolveAnchor：大小写/空白不一致的 id 也认', () => {
  assert.equal(resolveAnchor('Usage', HEADINGS), 'usage')
  assert.equal(resolveAnchor('  install-steps  ', HEADINGS), 'install-steps')
})

test('resolveAnchor：同名小节按出现顺序取第一个（与 assignHeadingIds 的 -1/-2 后缀同源）', () => {
  assert.equal(resolveAnchor('用法', HEADINGS), 'usage')
})

test('★ resolveAnchor：对不上时回 null（由调用方把真实小节列给模型，而不是猜一个近似的）', () => {
  for (const bad of ['', '   ', '部署', 'nope']) assert.equal(resolveAnchor(bad, HEADINGS), null, `${bad} 不该被猜中`)
})

test('resolveAnchor：空小节列表下任何输入都是 null（不抛错）', () => {
  assert.equal(resolveAnchor('usage', []), null)
})

test('headingHints：没有小节与有小节给两种不同的话（"没有"本身也是可据以改主意的信息）', () => {
  assert.match(headingHints([]), /没有/)
  const hints = headingHints(HEADINGS)
  assert.match(hints, /usage（用法）/)
  assert.match(hints, /install-steps（安装步骤）/)
})

/* ============================== 处理器 ============================== */

test('★ open_page：真的调用宿主的 openPage，并把 slug 回报给模型', async () => {
  const opened: string[] = []
  const dom = fakeDom()
  await withTools(dom, (s) => opened.push(s), async () => {
    const r = (await invokeClientTool('open_page', { slug: 'guide/intro' })) as Record<string, unknown>
    assert.deepEqual(opened, ['guide/intro'])
    assert.equal(r['ok'], true)
    assert.equal(r['slug'], 'guide/intro')
    // 提示里必须说清"打开 ≠ 读过"——否则模型会声称自己看过那一页
    assert.match(String(r['note']), /正在阅读/)
  })
})

test('open_page：slug 缺失/空串 ⇒ 拒绝执行，不跳到一个空页面', async () => {
  const opened: string[] = []
  await withTools(fakeDom(), (s) => opened.push(s), async () => {
    for (const bad of [{}, { slug: '' }, { slug: 42 }, null, 'home']) {
      const r = (await invokeClientTool('open_page', bad)) as Record<string, unknown>
      assert.equal(r['ok'], false, `${JSON.stringify(bad)} 不该被接受`)
      assert.equal(r['error'], 'invalid_slug')
    }
  })
  assert.deepEqual(opened, [], '校验失败时一次跳转都不该发生')
})

test('★ scroll_to：命中后滚动**并且**把锚点写进 URL（可分享、可刷新、可后退）', async () => {
  const dom = fakeDom()
  await withTools(dom, () => {}, async () => {
    const r = (await invokeClientTool('scroll_to', { anchor: '安装步骤' })) as Record<string, unknown>
    assert.deepEqual(dom.scrolled, ['install-steps'])
    assert.deepEqual(dom.settled, ['install-steps'], '只滚动不写 URL 的话，链接分享出去会落在页首')
    assert.equal(r['ok'], true)
    assert.equal(r['id'], 'install-steps')
  })
})

test('★ scroll_to：找不到小节时**如实说 + 列出真实小节**（空结果必须带一条能据以改主意的信息）', async () => {
  const dom = fakeDom()
  await withTools(dom, () => {}, async () => {
    const r = (await invokeClientTool('scroll_to', { anchor: '部署' })) as Record<string, unknown>
    assert.equal(r['ok'], false)
    assert.equal(r['error'], 'anchor_not_found')
    assert.match(String(r['headings']), /usage（用法）/, '不列候选的话模型只能重复同一个词')
    assert.deepEqual(dom.scrolled, [])
  })
})

test('★ scroll_to：元素还没渲染出来（scrollTo 返回 false）时**不许说成功**', async () => {
  /*
   * 找到了 id 但滚不过去，说明正文还没渲染（页面刚切过去）。此时若回 `ok: true`，
   * 模型会告诉用户"已经带你到那一节了"，而用户的屏幕没有动——
   * 这是"静默把没做到说成做到了"，本仓最不能接受的一类失败。
   */
  const dom = fakeDom({ scrollTo: () => false })
  await withTools(dom, () => {}, async () => {
    const r = (await invokeClientTool('scroll_to', { anchor: 'usage' })) as Record<string, unknown>
    assert.equal(r['ok'], true, 'id 确实找到了（这一步没失败）')
    assert.match(String(r['note']), /没有真正滚动/)
    assert.deepEqual(dom.settled, [], '没滚成功就不该改 URL——地址栏与画面必须一致')
  })
})

test('scroll_to：anchor 缺失 ⇒ 拒绝，不滚到页首也不抛错', async () => {
  const dom = fakeDom()
  await withTools(dom, () => {}, async () => {
    for (const bad of [{}, { anchor: '  ' }, { anchor: 7 }]) {
      const r = (await invokeClientTool('scroll_to', bad)) as Record<string, unknown>
      assert.equal(r['error'], 'invalid_anchor')
    }
  })
  assert.deepEqual(dom.scrolled, [])
})

/* ============================== 登记形状 ============================== */

test('★ 登记的两条名字已排序（这份名单经轮次协议上送服务端，顺序不稳会让前缀缓存失效）', async () => {
  const dom = fakeDom()
  await withTools(dom, () => {}, async () => {
    const names = clientToolNames()
    assert.deepEqual(names, [...names].sort())
    assert.deepEqual(names, ['open_page', 'scroll_to'])
  })
})

test('★ 注销之后名字从可调用集里消失（登出再登录不能撞上"重名抛错"）', () => {
  const off = registerNavTools({ openPage: () => {}, dom: fakeDom() })
  assert.ok(clientToolNames().includes('open_page'))
  off()
  assert.deepEqual(clientToolNames(), [])
})
