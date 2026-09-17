/**
 * `@geewiki/ai-summary` 的前端产物：文章顶部那张**折叠摘要卡**（用户需求 ④）。
 *
 * 挂在 `article-summary` 插槽上（单占用）。宿主只传两个字段：`slug` 与 `title`
 * —— 摘要的内容、有没有过期、能不能重算，全部由**本插件的服务端**回答。
 *
 * ## 三条要点
 *
 * **① 没有模型 ⇒ 整张卡片不渲染。** 这是本插件的验收判据之一。理由不是省事：
 * 一张永远转不出结果的折叠卡会让读者**学会不再看摘要**，连带那些真的有摘要的页面
 * 一起被忽略。所以 `available === false` 时 `return null`，而不是显示"暂不可用"。
 *
 * **② 组件里不出现 `location.hash` / `window.location`。** 路由是宿主资产
 * （`packages/web/test/pluginUi.test.ts` 会扫构建产物字节）。本卡片本来也不需要路由：
 * 它显示的是"你正在看的这一页"的摘要。
 *
 * **③ 请求必须带凭据与 CSRF 头。** 服务端在带会话 cookie 时强制校验 `x-gw-csrf`
 * （宿主 `api.ts` 的注释写着"绝不能漏"）。漏了它的表现是**每个登录用户的每一次请求都 401**
 * ——P3 在 dock 上踩过一次，那次的验收脚本从 node 发请求、自己带头，**根本没走浏览器传输**。
 * 所以这里的传输写成与 dock 同形，并被 `pluginUi.test.ts` 读字节钉住。
 */
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
// 样式必须由入口 import：Vite 的 lib 模式只在被引用时才会产出 `client.css`，
// 而 manifest 声明了它（`pluginUi.test.ts` 会断言产物目录里确实有 .css 文件）
import './style.css'

/* ============================== 与宿主的接口（镜像宿主 SDK，不能 import） ============================== */

/**
 * 宿主 SDK 的最小面。
 *
 * 浏览器侧不能 import `@geewiki/core`（它顶层 `import 'node:fs'`），也不能 import
 * `packages/web/src/lib/slots.tsx`（那是宿主的源码，插件产物里没有它）——
 * 故这里是一份**被迫的镜像**。与 `@geewiki/ai-assistant/ui/` 同一条约定：
 * 插件侧对宿主能力一律**特性探测**，不比版本字符串。
 */
interface PluginUiHost {
  registerSlot(name: string, component: ComponentType<never>): () => void
}

/** `article-summary` 插槽的 props 镜像（与 core / slots.tsx 逐字段对应） */
interface ArticleSummarySlotProps {
  readonly slug: string
  readonly title: string
}

declare global {
  interface Window {
    __GEEWIKI_HOST__?: PluginUiHost
  }
}

/* ============================== 服务端形状（镜像 src/types.ts） ============================== */

interface SummaryView {
  ok: true
  available: boolean
  slug: string
  title: string | null
  summary: string | null
  stale: boolean
  generatedAt: string | null
  model: string | null
  audience: 'public' | 'org' | 'restricted' | null
  canRegenerate: boolean
  reason?: string
}

const SUMMARY_PATH = '/api/ai/summary'

/*
 * 与宿主 `api.ts` 同形：凭据 + CSRF，一个都不能少。
 *
 * 写成两个薄函数而不是一个通用的 `transport`：那个"通用"版本要么把 URL 塞进
 * `RequestInit`（类型上不存在，得靠断言），要么自己发明一套参数协议——
 * 两种都比直接写 `fetch` 更难看出"这里到底发了什么、带了哪些头"。
 */
const getJson = async (url: string): Promise<Response> =>
  fetch(url, { credentials: 'same-origin', headers: { 'x-gw-csrf': '1' } })

const postJson = async (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-gw-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/* ============================== 组件 ============================== */

export function SummaryCard(props: ArticleSummarySlotProps): ReactNode {
  const [view, setView] = useState<SummaryView | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  /*
   * 卸载后不再 setState。摘要是**按 slug 取**的，而读者翻页很快——
   * 慢的那个响应回来时组件可能已经换成下一页了，那时 setState 会把**上一页的摘要
   * 显示在这一页顶上**：内容看起来完全合理，只是属于另一篇文章。
   */
  const alive = useRef(true)

  const fetchSummary = useCallback(async (slug: string): Promise<void> => {
    try {
      const res = await getJson(`${SUMMARY_PATH}?slug=${encodeURIComponent(slug)}`)
      if (!alive.current) return
      if (!res.ok) {
        // 403/404 都在这里：**不显示任何东西**比显示"你看不到"更合适——
        // 读者正在读这一页，卡片说"你看不到这一页的摘要"只会让人困惑。
        setView(null)
        return
      }
      const body = (await res.json()) as SummaryView
      if (!alive.current) return
      setView(body)
      setErr('')
    } catch {
      if (alive.current) setView(null)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    setView(null)
    setErr('')
    void fetchSummary(props.slug)
    return () => {
      alive.current = false
    }
  }, [props.slug, fetchSummary])

  const regenerate = useCallback(async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const res = await postJson(SUMMARY_PATH, { slug: props.slug })
      const body = (await res.json().catch(() => ({}))) as { message?: string; summary?: string }
      if (!res.ok) {
        if (alive.current) setErr(body.message ?? '生成失败')
        return
      }
      await fetchSummary(props.slug)
    } catch {
      if (alive.current) setErr('生成失败（网络错误）')
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [props.slug, fetchSummary])

  // ① 没有可用模型 ⇒ **整张卡片不渲染**（见文件头）
  if (view === null || !view.available) {
    /*
     * 一个例外：`view === null` 是"还没拿到答案"或"请求失败"。这两种情况也都不渲染——
     * 显示一个加载中的骨架会在每次翻页时闪一下，而摘要出现得慢本来就是可接受的。
     */
    return null
  }

  if (view.summary === null) {
    // 有模型但这一页还没生成：只有**能重算的人**才看得到入口（否则读者能做的事只有等待）
    if (!view.canRegenerate) return null
    return (
      <div className="gw-summary gw-summary-empty" data-stale="false">
        <span className="gw-summary-empty-text">这一页还没有摘要。</span>
        <button type="button" className="gw-summary-btn" onClick={() => void regenerate()} disabled={busy}>
          {busy ? '生成中…' : '生成摘要'}
        </button>
        {err !== '' && <span className="gw-summary-err">{err}</span>}
      </div>
    )
  }

  return (
    <details className="gw-summary" data-stale={view.stale ? 'true' : 'false'}>
      {/*
        用原生 `<details>` / `<summary>` 而不是自己写按钮 + 状态：
        折叠语义、键盘可达性、`aria-expanded` 与屏幕阅读器播报都由浏览器负责，
        自己实现一遍最容易漏掉的是"读屏用户不知道这里可以展开"。
      */}
      <summary className="gw-summary-head">
        <span className="gw-summary-label">摘要</span>
        {view.stale && (
          <span className="gw-summary-tag" title="正文在这份摘要之后改过">
            已过期
          </span>
        )}
        {/*
          折叠态的一行预览。**它不重复摘要正文的排版**：这里是纯文本、单行、截断，
          目的是让读者判断值不值得展开，而不是让他在这里读完。
        */}
        <span className="gw-summary-peek" aria-hidden="true">
          {view.summary}
        </span>
      </summary>
      <div className="gw-summary-body">
        <p className="gw-summary-text">{view.summary}</p>
        <div className="gw-summary-foot">
          {view.canRegenerate && (
            <button type="button" className="gw-summary-btn" onClick={() => void regenerate()} disabled={busy}>
              {busy ? '生成中…' : '重新生成'}
            </button>
          )}
          {err !== '' ? (
            <span className="gw-summary-err">{err}</span>
          ) : (
            <span className="gw-summary-meta">
              {view.generatedAt === null ? '' : `${view.generatedAt.slice(0, 10)} 由 AI 生成`}
            </span>
          )}
          {view.audience === 'public' && (
            /*
             * 2026-09-17 用户原话：「把摘要的 仅公开部分 字样放到 由AI生成 的后面」。
             *
             * 这句话搬过一次家：原先在**折叠态**的 head 里（紧跟「摘要」/「已过期」），现在在
             * 展开态的脚注里、紧跟「… 由 AI 生成」。代价要如实说：**折叠态不再提这件事**，
             * 只有展开后才看得到这句限定。
             *
             * 语义没变，也没有放宽：只在**公开档**标注——组织内页面的读者都是成员，说
             * "公开部分"是噪音；而公开页若含受限段落，摘要只覆盖公开的那部分，读者有权知道
             * （否则他会以为整篇就讲了这么多）。所以它**不塞进上面的三元分支**：重新生成
             * 失败（`err` 占了那一格）时这句限定仍然要在。
             */
            <span className="gw-summary-note">仅公开部分</span>
          )}
        </div>
      </div>
    </details>
  )
}

/* ============================== 注册 ============================== */

export function register(host: PluginUiHost): () => void {
  return host.registerSlot('article-summary', SummaryCard as unknown as ComponentType<never>)
}

export default register
