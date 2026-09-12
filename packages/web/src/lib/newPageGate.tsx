/**
 * 知识库**写入口**的门控 —— 三态判据的唯一真源（R11 建立，本批 G1 补齐侧栏与编辑路由）。
 * ============================================================================
 *
 * ## 为什么要有这个门（真实浏览器取证发现的缺陷）
 *
 * 未登录访客在 `#/wiki/list` 上看到可点亮的「新建页面」，点进去得到**完整编辑器**，
 * 填完一屏、点保存才被 401 弹回登录页。服务端拒绝得没错（**不越权**），但把匿名用户
 * 引进死路、白填一屏，是纯浪费。同一缺陷当初有**三条**路径：
 *   1. 列表页页头/空态的「新建页面」按钮 —— R11 已修；
 *   2. 侧栏空态的「新建页面」按钮 —— 本批 G1 补；
 *   3. `#/wiki/new` 路由本身 —— R11 已修（按钮只是入口，路由才是兜底：
 *      别人贴过来的链接、浏览器历史、手输地址都汇到这里）。
 * 本批 G1 又把 **`#/wiki/<slug>/edit`** 一并收进同一道门：编辑路由此前对匿名（以及
 * 无编辑权的角色）同样会渲染出完整可用的编辑器。
 *
 * ## 为什么抽成一个模块
 *
 * 判据分散在四处，迟早出现"列表页挡住了、侧栏按钮还亮着"这类漂移（侧栏就是漏网的那一处）。
 * 因此三态判定（`newPageEntry`）与按钮渲染（`NewPageAction`）都只在这里定义一份，
 * `pages/WikiPage.tsx` 与 `components/Sidebar.tsx` 都从这里 import。
 *
 * ⚠️ 判据刻意**不用** `administer`（那是运维台的能力），只用全局 `editContent`
 * （后端语义 `isAdmin || role === 'member'`，见 `packages/plugin-auth/src/index.ts` 的
 * `capabilitiesOf`）—— 与命令面板的 `action:new`（`requires: 'editContent'`）**同一判据、
 * 同一来源**，否则两条入口会分叉：命令面板搜不到、列表按钮却点得进去。
 */
import type { ReactNode } from 'react'
import { LogIn, Plus } from 'lucide-react'
import type { AuthCapabilities, AuthUser } from '../api'
import { Button, type ButtonSize } from '../ui/Button'

/**
 * 写入口的三态。
 *
 * 为什么匿名不做成"禁用"：匿名用户**有**一条真实可走的路（登录后直接落在目标页），
 * 把一个走得通的入口做成灰色按钮，只会让人卡在原地；而"有会话但没编辑权"的人没有
 * 可走的下一步（得先找管理员改角色），所以那一态才禁用 + 说清原因。
 * 两态都用**可见**文案，不靠 `title`（触屏与读屏都拿不到 `title`）。
 */
export type NewPageEntry =
  /** 有会话且能力允许：正常进入编辑器 */
  | { kind: 'ready' }
  /** 匿名：**可点**，点了去登录页并带回跳（见 `loginForWikiPath`） */
  | { kind: 'login' }
  /** 有会话但能力不足（或权限尚未确认）：按钮禁用 + **可见**原因 */
  | { kind: 'blocked'; reason: string }

/** 写入口的两种动作 —— 只影响文案里的动词（判据完全相同） */
export type WikiWriteAction = 'new' | 'edit'

const ACTION_LABEL: Record<WikiWriteAction, string> = { new: '新建页面', edit: '编辑页面' }

/**
 * 三态判据。
 *
 * - `auth.user === null` ⇒ 匿名 ⇒ `login`；
 * - `capabilities === null`（仍在确认）按"未知即不放行"处理：宁可晚一次请求看到入口，
 *   也不要先给一个点了必然 401 的按钮（与 `lib/navPlan.ts` 的失败关闭同一策略）；
 * - 全局 `editContent` 为假 ⇒ `blocked`（文案按 `action` 给出正确动词）。
 *
 * `action` 只决定 `blocked` 的原因文案（"新建页面" / "编辑页面"），**不改变判定** ——
 * 两类入口的能力判据是同一个，这正是本模块存在的意义。
 */
export function newPageEntry(
  user: AuthUser | null,
  capabilities: AuthCapabilities | null,
  action: WikiWriteAction = 'new',
): NewPageEntry {
  if (user === null) return { kind: 'login' }
  if (capabilities === null) return { kind: 'blocked', reason: '正在确认你的权限…' }
  if (!capabilities.editContent) {
    return { kind: 'blocked', reason: `你的角色没有${ACTION_LABEL[action]}的权限（需要成员及以上）。` }
  }
  return { kind: 'ready' }
}

/**
 * `#/wiki/new?create=home` 里的「预填哪个 slug」。
 *
 * 为什么主页创建要**复用 `new` 这个形状**，而不是自造 `#/wiki/home/new`：
 * `home/new` 同时满足「合法 slug」（`SLUG_SEGMENT_RE` 允许，首段 `home` 不在保留段里）
 * 与「主页创建入口」两个含义。前端路由**先匹配就赢**，于是这个 URL 会把一个真实可建的
 * 页面（slug 恰好叫 `home/new`）从用户手里抢走 —— 页面建得出来、却打不开，
 * 正是 `lib/wikiRoute.ts` 与 `lib/slugRules.ts` 头注里记录过的同一类缺陷
 * （保留段被前端路由吃掉）。查询参数不在 slug 形状里，因此不占用任何标识。
 *
 * 用**手写解析**而不是 `URLSearchParams`：后者会做一次百分号解码，而本仓库的锚点
 * 参数处理（`lib/hashAnchor.ts`）刻意避开它（解码两次会把 `%2F` 变成段内斜杠）。
 * 这里只读一个无编码的短值，手写解析最短且行为可预测。
 *
 * 返回值恒为字符串（没有该参数时是空串），调用方自行与 {@link HOME_SLUG} 比对；
 * 非浏览器环境（SSR 测试、node 单测）返回空串而不是抛错。
 */
export function createParam(hash: string): string {
  const q = hash.indexOf('?')
  if (q === -1) return ''
  for (const part of hash.slice(q + 1).split('&')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq) === 'create') return part.slice(eq + 1)
  }
  return ''
}

/**
 * 去登录页，并把**回到目标页**的地址带上（登录成功后 `LoginPage` 会直接跳回这里）。
 *
 * `redirect` 的值必须是站内 hash 路由（如 `/wiki/new`、`/wiki/guide%2Fintro/edit`），
 * 由 `LoginPage` 的 `normalizeRedirect()` 校验 —— 与 `AccountPage.tsx` 的
 * `'/login?redirect=%2Faccount'` 同一写法。
 */
export function loginForWikiPath(hashPath: string): void {
  window.location.hash = `/login?redirect=${encodeURIComponent(hashPath)}`
}

/**
 * 去登录页，登录后回到 `#/wiki/new`。
 *
 * `createHome` 为真时回到 **`#/wiki/new?create=home`**（创建主页的入口）——
 * 同一道登录门、同一个 `new` 形状，只是把"想干什么"原样带回去。
 * 不回带的话，从主页缺省面板点「去登录」的人会被丢进普通新建页，
 * 得自己再找一次创建主页的入口（或更糟：随手建了另一篇，主页仍然空着）。
 */
export function loginForNewPage(createHome = false): void {
  loginForWikiPath(createHome ? '/wiki/new?create=home' : '/wiki/new')
}

/**
 * 去登录页，登录后回到 `#/wiki/<slug>/edit`。
 *
 * slug 里的 `/`（分层页面）**必须编码**：否则回跳地址会被路由当成多一段
 * （与 `components/Sidebar.tsx` 的 `wikiHref` 同一条规则）。
 */
export function loginForEditPage(slug: string): void {
  loginForWikiPath(`/wiki/${encodeURIComponent(slug)}/edit`)
}

/**
 * 写入口的按钮（列表页页头、列表页空态、侧栏空态**共用一份实现**，避免门控漂移）。
 *
 * `blocked` 态把原因渲染成 `role="status"` 的**可见**文字：只挂在 `title` 上的原因
 * 触屏用户与读屏用户都拿不到。
 */
export function NewPageAction({
  entry,
  onNew,
  size = 'md',
}: {
  entry: NewPageEntry
  onNew: () => void
  /** 按钮尺寸：列表页用默认 `md`，侧栏 240px 窄列沿用 `sm`（与抽出前的密度一致） */
  size?: ButtonSize
}): ReactNode {
  if (entry.kind === 'ready') {
    return (
      <Button variant="primary" size={size} icon={<Plus className="size-3.5" />} onClick={onNew}>
        新建页面
      </Button>
    )
  }
  if (entry.kind === 'login') {
    return (
      <Button
        variant="primary"
        size={size}
        icon={<LogIn className="size-3.5" />}
        /*
         * ⚠️ 必须包一层箭头函数：`onClick={loginForNewPage}` 会把 **MouseEvent** 当成
         * 第一个参数（`createHome`）传进去 —— 事件对象是 truthy，于是所有入口都被当成
         * "创建主页"，跳到 `?create=home`。签名一旦有可选参数，直接当处理器用就是陷阱。
         */
        onClick={() => loginForNewPage()}
        title="新建页面需要账号：登录后会直接回到新建页"
      >
        登录后新建页面
      </Button>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button variant="primary" size={size} icon={<Plus className="size-3.5" />} disabled>
        新建页面
      </Button>
      {/* 禁用的原因必须可见（不能只挂在 title 上）*/}
      <span className="text-note text-warn-ink" role="status">
        {entry.reason}
      </span>
    </span>
  )
}
