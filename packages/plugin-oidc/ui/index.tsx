/**
 * `@geewiki/oidc` 的客户端界面：账号页 `account-identities` 插槽里的「外部身份」。
 *
 * ## 为什么这块界面归插件，而不是留在宿主账号页
 * 「**谁能提供外部身份，谁就提供这块界面**」。宿主账号页此前把 SSO 的文案（"在登录页选择
 * 企业 SSO…"、绑定确认、解绑列表）写死在核心代码里，于是在**一个 SSO 提供者都没装**的
 * 实例上，用户照样看到一个讲企业 SSO 的空态 —— 那是一个指向不存在功能的界面。
 * 现在宿主只保留真正属于核心的「本地密码」，外部身份的**数据与界面一起**搬到这里。
 *
 * ## 为什么数据由插件自己取
 * `account-identities` 是**零属性插槽**（见 `packages/web/src/lib/slots.tsx` 的
 * `ZeroPropsSlotName`）：宿主不向插件传任何数据，也不该知道"外部身份"这个概念。
 * 于是"没装这个插件" = "没有这块界面"，而不是"有界面但永远是空态"。
 *
 * ## 三条照 `packages/web/src/api.ts` 抄的约定（不自创协议）
 * 1. **票据从不经过前端**：`POST /api/auth/identities/link` **不带任何参数** —— 票据只存在于
 *    SSO 回跳时下发的 `HttpOnly` cookie 里（JS 读不到也传不了，写进 URL/请求体会经
 *    Referer、历史、日志与错误上报泄漏）。所以插件无法"提前知道"有没有待绑定票据，
 *    只能由 URL 上的 `link=required` 触发展示确认卡片。
 * 2. **会话走 cookie，代价是必须防 CSRF**：每个请求都带 `credentials: 'same-origin'` 与
 *    `x-gw-csrf: 1`（跨站表单设不了自定义头，这一个头就是第二道闸门；服务端在带会话 cookie
 *    时强制要求它，漏了会以 403 的形式静默失败）。**没有** `Authorization`：令牌对 JS 不可见。
 * 3. **服务端才是权威判据**：没有密码且只剩一个身份时服务端返回 409 `last_credential`。
 *    前端据此提前禁用按钮，只是避免用户白点一次，**不是**安全措施
 *    （隐藏按钮永远不能替代服务端校验）。
 *
 * ## 与 `@geewiki/ai-assistant` 的一处刻意不同
 * 入口与 `@geewiki/ai-assistant` 同一条纪律：**本文件不出现 `window.location`**。
 * `link=required` 这个提示由**宿主**读好当 prop 传进来（路由归宿主，见 `AccountIdentitiesSlotProps`），
 * 插件只管画；身份列表则自己按会话取（那是它的数据）。这个提示决定
 * "要不要显示绑定确认卡片"。这里读的是**进入页面那一刻的提示**，不做跳转、不改变路由，
 * 所以与本插件"不掌握路由"的总体约定并不冲突。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import './style.css'

/* ============================== 宿主 SDK ============================== */

/**
 * 插件对宿主的最小要求（`packages/web/src/lib/pluginUi.ts` 的 `PluginUiHost` 镜像）。
 *
 * 刻意**只声明用得上的那一项**、且**不 import 宿主模块**：这个文件会被打成独立 bundle，
 * 除 `react` / `react/jsx-runtime` 外一切都必须是 external（见
 * `packages/web/fixtures/vite.config.ts` 的 `rollupOptions.external`）。多声明一项就多一份
 * "宿主没提供时插件崩在注册阶段"的风险，而注册失败的表现是**界面凭空消失**、没有任何报错。
 */
interface PluginUiHost {
  readonly pluginName: string
  readonly version?: string
  registerSlot(name: string, component: () => ReactNode): () => void
}

/* ============================== 数据契约 ============================== */

/** 与 `packages/web/src/api.ts:730` 的 `AuthIdentity` 逐字段一致（跨包镜像，不能 import） */
interface AuthIdentity {
  id: number
  issuer: string
  subject: string
  emailAtLink: string | null
  linkedAt: string
  lastLoginAt: string | null
}

/** 本组件的三态（与宿主其余页面同思路：互斥，避免"加载中同时显示上次的错误"） */
type View =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown }
  | { kind: 'ready'; hasPassword: boolean; identities: AuthIdentity[] }

interface Notice {
  kind: 'ok' | 'err'
  text: string
}

/** 端点路径逐字照抄 `packages/web/src/api.ts`（自创路径的症状是 404，而 404 只会显示成一句人话） */
const IDENTITIES_PATH = '/api/auth/identities'
const LINK_PATH = '/api/auth/identities/link'
const UNLINK_PATH = '/api/auth/identities/unlink'

/**
 * HTTP 失败：把服务端的机器码与状态码都留着。
 *
 * `message` 与 `code` 分开存而不是拼成一句，是因为 `errText()` 要按"人话优先、机器码兜底"
 * 的顺序挑一句显示；拼在一起就没法再挑，用户会看到 `last_credential` 这种内部词。
 */
class IdentityRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'IdentityRequestError'
  }
}

/**
 * 同源 JSON 请求（`api.ts` 的 `request()` 的等价缩小版）。
 *
 * 为什么不复用宿主的 `api.ts`：插件 bundle 只能外置 react 系，把宿主模块拉进来会让
 * 这份产物与宿主源码**版本绑死**（宿主改一行就可能打不进/打错），而插件产物是可以
 * 单独分发到 `plugins/<名>/dist` 的。代价只是这十几行重复 —— 协议侧的关键字
 * （路径、`x-gw-csrf`、`credentials`）在注释里点名出处，便于漂移时对照。
 */
async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? { 'x-gw-csrf': '1' } : { 'content-type': 'application/json', 'x-gw-csrf': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // 非 JSON（网关的 HTML 错误页、204 等）：留着 data=null，下面按状态码拼兜底文案
  }
  if (!res.ok) {
    const f = (data ?? {}) as { error?: unknown; message?: unknown }
    const code = typeof f.error === 'string' && f.error.length > 0 ? f.error : 'http_' + String(res.status)
    const message =
      typeof f.message === 'string' && f.message.length > 0 ? f.message : `请求失败 (${String(res.status)})`
    throw new IdentityRequestError(res.status, code, message)
  }
  return data as T
}

/** 从错误里取一句人话（服务端的 message 优先，其次机器码，最后兜底） */
function errText(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; message?: unknown }
    if (typeof e.message === 'string' && e.message.length > 0) return e.message
    if (typeof e.code === 'string' && e.code.length > 0) return e.code
  }
  return '操作失败，请重试。'
}


/**
 * 时间一律走 `toLocaleString()`：这里只回答"何时绑的/最近何时登录"，不需要相对时间那套
 * 复杂度（也就没有"30 秒前"与真实时刻不一致的窗口）。解析不了就原样显示 —— 宁可显示
 * 一个原始 ISO 串，也不要显示 `Invalid Date`。
 */
function fmtTime(iso: string | null): string {
  if (iso === null) return '—'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso
}

/* ============================== 组件 ============================== */

/**
 * 「外部身份」面板。
 *
 * 输入只有一样：`linkPending`（宿主从 `?link=required` 读来的"这次回跳需要确认绑定"）。
 * 数据（身份名单）由本组件自己按会话取。**不读 window.location**——见文件头。
 */
export function IdentityPanel(props: { readonly linkPending?: boolean } = {}): ReactNode {
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirming, setConfirming] = useState(false)
  /*
   * 「这次回跳需要确认绑定」= 宿主说需要 **且** 用户还没点掉。
   *
   * 拆成两个来源是有意的：提示属于路由（宿主），"点掉"属于用户在本页的即时决定（插件）。
   * 于是宿主重复传 `true`（每次 re-render 都会传）也不会把用户关掉的卡片翻回来。
   */
  const [dismissed, setDismissed] = useState(false)
  const linkPending = props.linkPending === true && !dismissed

  const reload = useCallback(async (): Promise<void> => {
    setView({ kind: 'loading' })
    try {
      const r = await request<{ hasPassword: boolean; identities: AuthIdentity[] }>('GET', IDENTITIES_PATH)
      setView({ kind: 'ready', hasPassword: r.hasPassword, identities: r.identities })
    } catch (error) {
      setView({ kind: 'error', error })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const onConfirmLink = async (): Promise<void> => {
    setConfirming(true)
    setNotice(null)
    try {
      // 不带参数：票据在 HttpOnly cookie 里（见文件头第 1 条）
      const r = await request<{ alreadyLinked: boolean }>('POST', LINK_PATH)
      setNotice({
        kind: 'ok',
        text: r.alreadyLinked ? '该外部身份此前已绑定到当前账号。' : '绑定成功，下次可直接用 SSO 登录。',
      })
      setDismissed(true)
      await reload()
    } catch (err) {
      setNotice({ kind: 'err', text: errText(err) })
    } finally {
      setConfirming(false)
    }
  }

  const onUnlink = async (identity: AuthIdentity): Promise<void> => {
    setNotice(null)
    try {
      await request<{ ok: true }>('POST', UNLINK_PATH, { identityId: identity.id })
      setNotice({ kind: 'ok', text: '已解绑。' })
      await reload()
    } catch (err) {
      // 409 last_credential 也走这里：服务端的人话比"只剩一个登录方式"更准确（可能还有别的提供方）
      setNotice({ kind: 'err', text: errText(err) })
    }
  }

  return (
    <div className="gw-oidc-root">
      {linkPending && (
        <section className="gw-oidc-card gw-oidc-confirm" aria-label="确认绑定外部身份">
          <h2 className="gw-oidc-card-title">确认绑定外部身份</h2>
          <p className="gw-oidc-card-desc">系统不会按邮箱自动合并账号 —— 需要你在这里显式确认</p>
          <p className="gw-oidc-text">
            你刚刚通过 SSO 验证了身份，但该邮箱已有一个本地账号。确认后，这个外部身份会绑定到
            <strong>当前登录的账号</strong>上，之后可以直接用 SSO 登录。
          </p>
          <div className="gw-oidc-actions">
            <button
              type="button"
              className="gw-oidc-btn gw-oidc-btn-primary"
              disabled={confirming}
              onClick={() => void onConfirmLink()}
            >
              {confirming ? '正在绑定…' : '确认绑定'}
            </button>
            <button type="button" className="gw-oidc-btn gw-oidc-btn-ghost" onClick={() => setDismissed(true)}>
              稍后再说
            </button>
          </div>
        </section>
      )}

      {notice !== null && (
        // role=alert 让读屏软件立刻打断朗读（失败必须被听到）；成功只是状态播报
        <p
          role={notice.kind === 'err' ? 'alert' : 'status'}
          className={notice.kind === 'err' ? 'gw-oidc-notice gw-oidc-notice-err' : 'gw-oidc-notice gw-oidc-notice-ok'}
        >
          {notice.text}
        </p>
      )}

      <section className="gw-oidc-card" aria-label="外部身份">
        <h2 className="gw-oidc-card-title">外部身份</h2>
        <p className="gw-oidc-card-desc">通过企业 SSO（OIDC）登录的方式</p>

        {view.kind === 'loading' && (
          <p className="gw-oidc-state-hint" role="status">
            正在加载绑定的身份…
          </p>
        )}

        {view.kind === 'error' && (
          <div className="gw-oidc-state" role="alert">
            <p className="gw-oidc-state-title gw-oidc-state-title-error">加载登录方式失败</p>
            <p className="gw-oidc-state-hint">{errText(view.error)}</p>
            <button type="button" className="gw-oidc-btn gw-oidc-btn-ghost" onClick={() => void reload()}>
              重试
            </button>
          </div>
        )}

        {view.kind === 'ready' && view.identities.length === 0 && (
          <div className="gw-oidc-state">
            <p className="gw-oidc-state-title">还没有绑定外部身份</p>
            {/*
              空态文案按"还有没有别的登录方式"分叉：有密码的人不需要被催着设密码，
              没有密码的人则是**只剩外部身份**这一条路 —— 那句话才是他真正需要的下一步。
            */}
            <p className="gw-oidc-state-hint">
              {view.hasPassword
                ? '在登录页选择企业 SSO 完成一次登录后，这里会出现可绑定的身份。'
                : '当前账号只能通过外部身份登录，建议设置一个本地密码作为备用。'}
            </p>
          </div>
        )}

        {view.kind === 'ready' && view.identities.length > 0 && (
          <ul className="gw-oidc-list">
            {view.identities.map((id) => {
              // 服务端是权威（409 last_credential）；这里只避免用户白点一次
              const isLastCredential = !view.hasPassword && view.identities.length <= 1
              const label = id.emailAtLink ?? id.subject
              return (
                <li key={id.id} className="gw-oidc-item">
                  <div className="gw-oidc-item-main">
                    <span className="gw-oidc-item-name">{label}</span>
                    {/* title 让被截断的长 issuer 仍可悬停读到全值 */}
                    <span className="gw-oidc-item-issuer" title={id.issuer}>
                      {id.issuer}
                    </span>
                    <span className="gw-oidc-item-time">
                      绑定于 {fmtTime(id.linkedAt)} · 最近登录 {fmtTime(id.lastLoginAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="gw-oidc-btn gw-oidc-btn-danger"
                    disabled={isLastCredential}
                    title={isLastCredential ? '这是最后一个登录方式，无法解绑' : undefined}
                    // 列表里多个「解绑」同名按钮，读屏软件只会念出一串"解绑" ⇒ 带上身份的可见名
                    aria-label={`解绑 ${label}`}
                    onClick={() => void onUnlink(id)}
                  >
                    解绑
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

/* ============================== 注册 ============================== */

/**
 * 宿主 SDK 的入口（`pluginUi.ts` 优先取 `register`，没有才退回 `default`）。
 *
 * 返回注销函数是契约的一部分：热插拔/停用插件时宿主调用它摘掉插槽，**必须原样透传**
 * `registerSlot` 的返回值 —— 自己包一层空函数会让旧组件留在插槽上（重复挂载、双份请求）。
 */
export function register(host: PluginUiHost): () => void {
  return host.registerSlot('account-identities', IdentityPanel)
}

export default register
