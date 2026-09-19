/**
 * @geewiki/oidc —— 企业 SSO（OIDC 授权码 + PKCE）适配器。
 *
 * 它是**叶子插件**：只往 `auth-service` 注册一条 provider（并把 `/api/auth/oidc/*` 两条路由
 * 挂上），不对外提供新服务（故 `provides: undefined`）—— 形态与 `@geewiki/openai`
 * 往 `llm-service` 注册一条路由完全一致。声明 `conflictGroup: 'oidc-provider'`：
 * 同组互斥，使"将来接第二个 IdP adapter"这件事由既有的冲突组机制保证，而不是靠约定。
 *
 * **只登记、不写进随版本发布的默认清单 `config/plugins.base.example.json`**（与
 * `@geewiki/echo`/`llm`/`ai`/`openai` 同形态："已注册但未启用"）。这是"无外部依赖 / 离线可用"
 * 承诺的落地方式（设计文档 §7.5）：
 * - 未启用 ⇒ `/api/auth/oidc/*` 这两条路由**根本不存在**（404），前端不渲染 SSO 按钮；
 * - 已启用但 IdP 不可达 ⇒ `capabilities.oidc.available=false`，**本地密码通道完全不受影响**；
 * - 已有会话与已建立的 SSE 连接不依赖 IdP（我们自己的 cookie session）⇒ IdP 挂掉不掉线。
 *
 * 四件必须记住的边界：
 * 1. **账号策略不在本包**：谁能建号、绑定与解绑的裁决、票据的签发校验全在 `@geewiki/auth`。
 *    本包只做"把 IdP 的声明验证好，然后交给它"。
 * 2. **流程状态（state / nonce / code_verifier）存在进程内**，不落库 —— 本阶段
 *    **迁移增量为 0** 是硬约束（设计文档 §7.6）。代价：多实例部署下回跳会失败
 *    （`state` 在另一个进程里找不到）⇒ **失败关闭**（拒绝登录），不是放行。
 * 3. **`redirect_uri` 必填、且不从前端传入**：它必须与 IdP 侧注册值逐字一致，
 *    从请求头推导（`Host`）等于把重定向目标交给可伪造的输入。
 * 4. **协议环节的失败也要落审计**（设计文档 §7.4 第 7 条）：签名、`iss`、`aud`、`exp`、
 *    `nonce`、算法白名单这些校验发生在本包，故本包直接写 `audit_log`。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import {
  asAsync,
  auditIpHash,
  writeAuditLog,
  type AnyDatabaseAdapter,
  type GeeWikiManifest,
  type HttpRouterService,
  type RouteHandlerContext,
} from '@geewiki/core'
import {
  LINK_COOKIE,
  serializeCookie,
  type AuthService,
  type OidcProvider,
  type OidcClaims,
} from '@geewiki/auth'
import { OidcClient, OidcError, createPkcePair, randomToken } from './client.js'

export type { OidcClientOptions, VerifiedIdentity } from './client.js'
export { OidcClient, OidcError, createPkcePair } from './client.js'

/* ============================== 配置 ============================== */

export interface OidcConfig {
  /** IdP 的 issuer（必填；生产必须 HTTPS，`http://localhost` 例外） */
  issuer?: string
  /** 在 IdP 注册的 client_id（必填） */
  clientId?: string
  /** 客户端密钥的**环境变量名**（不是密钥值；留空 = public client，仅用 PKCE） */
  clientSecretEnv?: string
  /** 请求的 scope（必须含 `openid`） */
  scopes?: string[]
  /** 回跳地址（必填；必须与 IdP 侧注册值逐字一致） */
  redirectUri?: string
  /** 注册表键（同组内唯一） */
  providerId?: string
  /** 登录页 SSO 按钮的展示名 */
  label?: string
  /** 单次上游请求总超时（毫秒） */
  timeoutMs?: number
  /** 可用性探测间隔（秒）；0 = 只在激活时探测一次 */
  probeIntervalSeconds?: number
}

/**
 * 环境变量名白名单（与 `@geewiki/openai` 的 `apiKeyEnv`、`@geewiki/db-postgres` 的
 * `passwordEnv` 同一条形态）：全大写 + **必须含至少一个下划线**。
 *
 * 与那些包的实现逐字等价，但**刻意不 import**：让 OIDC 插件依赖数据库插件或 LLM 插件是
 * 错误的耦合方向。跨包同义常量由源码级守卫测试钉住（与既有先例同处理方式）。
 */
const ENV_VAR_NAME_FIELD_RE = /^$|^(?=[A-Z0-9_]*_)[A-Z_][A-Z0-9_]{0,127}$/

export const OidcConfigSchema = Schema.object({
  issuer: Schema.string()
    .required()
    .description('IdP 的 issuer（如 https://idp.example.com；必须与 IdP 发现文档里的 issuer 一致）'),
  clientId: Schema.string().required().description('在 IdP 注册的 client_id'),
  clientSecretEnv: Schema.string()
    .default('')
    .pattern(ENV_VAR_NAME_FIELD_RE)
    .description('客户端密钥的**环境变量名**（如 OIDC_CLIENT_SECRET；此处不要填密钥本身；留空 = public client）'),
  scopes: Schema.array(Schema.string())
    .default(['openid', 'email', 'profile'])
    .description('请求的 scope（必须含 openid）'),
  redirectUri: Schema.string()
    .required()
    .description('回跳地址（必须与 IdP 侧注册值逐字一致，如 https://wiki.example.com/api/auth/oidc/callback）'),
  providerId: Schema.string().default('oidc').description('provider 注册表键（同 id 重复注册会报错）'),
  label: Schema.string().default('企业 SSO').description('登录页按钮的展示名'),
  timeoutMs: Schema.number().default(10000).min(1000).max(120000).description('单次上游请求总超时（毫秒）'),
  probeIntervalSeconds: Schema.number()
    .default(60)
    .min(0)
    .max(3600)
    .description('IdP 可用性探测间隔（秒）；0 = 只在激活时探测一次'),
})

/* ============================== Manifest ============================== */

export const manifest: GeeWikiManifest = {
  name: '@geewiki/oidc',
  version: '0.1.0',
  geewiki: {
    // ★ F10：跨界能力声明（宿主不强制，用于评审与可观测）
    permissions: ['env', 'net'],
    displayName: '企业 SSO（OIDC）',
    description: '接入 OIDC 身份源（授权码 + PKCE），与本地账号密码并存；未启用时零影响',
    // 无 provides：它只往 auth-service 注册一条 provider 与两条路由，不对外提供新服务。
    // 但**界面归它**：账号页的 `<SlotOutlet name="account-identities" />` 由本插件的
    // client.js 填充 —— 反过来说，没装本插件时用户不会看到一个讲企业 SSO、却无处可点的空态。
    provides: undefined,
    // 按**服务 token**依赖：auth-service（策略与账号）、http-service（挂路由）、
    // database-provider（协议环节的失败审计要写 audit_log）
    requires: ['auth-service', 'http-service', 'database-provider'],
    conflictGroup: 'oidc-provider',
    migrations: undefined,
    runtime: {
      // 纯内存流程状态 + 无状态请求：热插拔安全（在途的 SSO 流程会失效，那是失败关闭）
      supportsHotReload: true,
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: OidcConfigSchema,
    /*
     * 客户端产物与插槽（照 `@geewiki/ai-assistant` 的写法）。
     *
     * `slots` 必须显式声明：宿主 `registerSlot` 有一道越权拦截 —— 清单的 `slots` 没列出该
     * 插槽名时，插件的注册被**静默忽略**（不报错，表现是"界面凭空消失"）。而这块界面
     * 只可能来自"能提供外部身份"的插件，正好是清单该声明的东西。
     *
     * `entry` / `css` 的文件名必须与 `packages/web/fixtures/vite.config.ts` 的
     * `fileName: () => 'client.js'` + `cssFileName: 'client'` 逐字对应：对不上同样是静默不加载。
     */
    client: { entry: 'client.js', css: 'client.css' },
    slots: ['account-identities'],
  },
}

/* ============================== 小工具 ============================== */

/**
 * issuer 形态校验（设计文档 §7.5）：必填、必须 HTTPS，**`http://localhost` 例外**。
 *
 * 例外不是"图方便"：本地开发与测试用的 mock IdP 只能跑在 http 上，而把"允许 http"
 * 做成一个总开关，等于在生产上留一把忘记关的钥匙。只放行 `localhost` / `127.0.0.1`
 * 让例外的作用域与"本机"绑定。
 */
export function validateIssuer(raw: string): string | null {
  const normalized = OidcClient.normalizeIssuer(raw)
  if (normalized === null) return null
  const url = new URL(normalized)
  if (url.protocol === 'https:') return normalized
  const host = url.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return normalized
  return null
}

/** 允许前端指定的回跳目标：只接受站内绝对路径，防止开放重定向 */
export function sanitizeRedirect(raw: string | null): string {
  if (raw === null || raw.length === 0) return '/'
  // `//evil.com` 与 `/\evil.com` 都会被浏览器当作协议相对 URL ⇒ 必须挡掉
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

/* ============================== 插件本体 ============================== */

interface FlowState {
  nonce: string
  codeVerifier: string
  redirect: string
  createdAt: number
}

/** 流程状态的最长存活时间：与授权码本身的有效期同量级（10 分钟足够走完一次回跳） */
const FLOW_TTL_MS = 10 * 60 * 1000

export const OidcPlugin = {
  name: '@geewiki/oidc',
  Config: OidcConfigSchema,

  async apply(ctx: Context, config: OidcConfig = {}) {
    /* ---------- 配置校验：写错就让激活失败，不降级 ---------- */
    const rawIssuer = (config.issuer ?? '').trim()
    if (rawIssuer.length === 0) {
      throw new Error('@geewiki/oidc: 缺少必填配置 issuer（IdP 的 issuer URL）')
    }
    const issuer = validateIssuer(rawIssuer)
    if (issuer === null) {
      throw new Error(
        `@geewiki/oidc: issuer 必须是 HTTPS URL（http 仅允许 localhost / 127.0.0.1 用于本地测试）：${rawIssuer}`,
      )
    }
    const clientId = (config.clientId ?? '').trim()
    if (clientId.length === 0) throw new Error('@geewiki/oidc: 缺少必填配置 clientId')
    const redirectUri = (config.redirectUri ?? '').trim()
    if (redirectUri.length === 0) throw new Error('@geewiki/oidc: 缺少必填配置 redirectUri')
    const scopes = config.scopes ?? ['openid', 'email', 'profile']
    if (!scopes.includes('openid')) {
      throw new Error('@geewiki/oidc: scope 必须包含 openid（OIDC 授权请求的硬要求）')
    }
    const clientSecretEnv = (config.clientSecretEnv ?? '').trim()
    if (clientSecretEnv.length > 0 && !ENV_VAR_NAME_FIELD_RE.test(clientSecretEnv)) {
      // 回显字段名而不回显值：填进去的"值"很可能就是密钥本身
      throw new Error(
        '@geewiki/oidc: clientSecretEnv 里填的看起来是**密钥值本身**而不是环境变量名。' +
          '本字段只接受**环境变量名**（全大写 + 至少一个下划线，如 OIDC_CLIENT_SECRET；留空 = public client）。' +
          '插件配置会落盘进入库的 config/plugins.*.json，填密钥等于把密钥提交进 git 历史。',
      )
    }

    const auth = ctx.get('auth-service') as AuthService | undefined
    if (!auth || typeof auth.registerOidcProvider !== 'function') {
      throw new Error(
        '@geewiki/oidc: auth-service 不可用或版本过旧（@geewiki/auth 未激活）。' +
          '本插件依赖它的 provider 注册表与账号策略。',
      )
    }
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/oidc: http 路由服务不可用（@geewiki/http 未激活）')
    const rawDb = ctx.get('db') as AnyDatabaseAdapter | undefined
    if (!rawDb) throw new Error('@geewiki/oidc: 数据库服务不可用（协议环节的失败要落审计）')
    const db = asAsync(rawDb)

    const client = new OidcClient({
      issuer,
      clientId,
      clientSecretEnv,
      scopes,
      timeoutMs: config.timeoutMs ?? 10000,
    })

    /* ---------- 协议环节的失败审计（设计文档 §7.4 第 7 条） ---------- */
    const auditFailure = (reason: string, ipHash: string | null): void => {
      void writeAuditLog(db, {
        action: 'login.fail',
        targetKind: 'user',
        targetId: '(oidc)',
        actorIpHash: ipHash,
        // **绝不写 token 内容**：`reason` 是机器码，不含声明值
        after: { via: 'oidc', reason },
      }).catch((err: unknown) => {
        console.error('[@geewiki/oidc] 审计写入失败:', err)
      })
    }

    /* ---------- 可用性探测（同步读缓存，供 capabilities） ---------- */
    const probeState: { available: boolean; reason: string | null } = {
      available: false,
      reason: 'unconfigured',
    }
    let probing = false
    const probe = async (): Promise<void> => {
      if (probing) return
      probing = true
      try {
        const result = await client.probe()
        probeState.available = result.available
        probeState.reason = result.reason
      } finally {
        probing = false
      }
    }
    await probe()

    /* ---------- 注册 provider ---------- */
    const provider: OidcProvider = {
      id: config.providerId ?? 'oidc',
      label: config.label ?? '企业 SSO',
      startPath: '/api/auth/oidc/start',
      available: () => probeState.available,
      reason: () => probeState.reason,
    }
    const unregisterProvider = auth.registerOidcProvider(provider)

    /* ---------- 流程状态（进程内，见文件头第 2 条） ---------- */
    const flows = new Map<string, FlowState>()
    const sweepFlows = (): void => {
      const cutoff = Date.now() - FLOW_TTL_MS
      for (const [key, flow] of flows) {
        if (flow.createdAt < cutoff) flows.delete(key)
      }
    }

    /* ---------- 响应辅助 ---------- */
    const redirect = (h: RouteHandlerContext, location: string): void => {
      // noteStatus 只记指标、不碰响应（json() 会 res.end，故不能用于此）
      h.noteStatus?.(302)
      const res = h.res
      if (res.writableEnded || res.destroyed) return
      if (!res.headersSent) res.writeHead(302, { location })
      res.end()
    }

    /**
     * 失败出口：同样做内容协商（见回跳里的说明）。
     * `status` 由调用点给出 —— 协议层失败（签名/声明不匹配）算 400，
     * 上游不可用算 502，两者对运维的指向完全不同。
     */
    const frontendError = (h: RouteHandlerContext, code: string, status = 400): void => {
      if ((h.req.headers.accept ?? '').includes('application/json')) {
        h.json(status, { ok: false, error: code, message: 'SSO 登录未完成' })
        return
      }
      redirect(h, `/#/login?oidc_error=${encodeURIComponent(code)}`)
    }

    const secureCookie = process.env.NODE_ENV === 'production'

    /**
     * 路由清理函数。
     *
     * **必须真的收进插件返回的清理函数**：两条路由都承载登录入口，卸载后若仍然可达，
     * 会变成一个"指向已注销 provider 的悬空入口"（点进去 500 而不是 404）。
     */
    const cleanups: (() => void)[] = []

    /* ---------- GET /api/auth/oidc/start ---------- */
    cleanups.push(
      router.register(
        'GET',
        '/api/auth/oidc/start',
        async (h) => {
          // 点一次就现探一次：IdP 恢复后无需等下一个探测周期
          await probe()
          if (!probeState.available) {
            h.json(503, {
              ok: false,
              error: 'oidc_unavailable',
              message: `SSO 通道当前不可用（${probeState.reason ?? 'unreachable'}）`,
            })
            return
          }
          sweepFlows()
          const state = randomToken(16)
          const nonce = randomToken(16)
          const { codeVerifier, codeChallenge } = createPkcePair()
          flows.set(state, {
            nonce,
            codeVerifier,
            redirect: sanitizeRedirect(h.url.searchParams.get('redirect')),
            createdAt: Date.now(),
          })
          let url: string
          try {
            url = await client.buildAuthorizationUrl({ state, nonce, codeChallenge, redirectUri })
          } catch (err) {
            const code = err instanceof OidcError ? err.code : 'authorization_build_failed'
            auditFailure(code, auditIpHash(h.req.socket.remoteAddress ?? null))
            h.json(502, { ok: false, error: code, message: '无法发起 SSO 登录，请稍后再试' })
            return
          }
          redirect(h, url)
        },
        // OIDC 回跳是浏览器导航，不可能带我们的 CSRF 头或会话（它正是要**建立**会话）
        { access: 'public' },
      ),
    )

    /* ---------- GET /api/auth/oidc/callback ---------- */
    cleanups.push(
      router.register(
        'GET',
        '/api/auth/oidc/callback',
        async (h) => {
          const ipHash = auditIpHash(h.req.socket.remoteAddress ?? null)
          // IdP 明确回报的错误（用户取消、授权被拒）—— 不是攻击，但仍是"没登进来"
          const idpError = h.url.searchParams.get('error')
          if (idpError !== null && idpError.length > 0) {
            auditFailure(`idp_${idpError}`.slice(0, 64), ipHash)
            frontendError(h, 'idp_error')
            return
          }
          const state = h.url.searchParams.get('state')
          if (state === null || state.length === 0) {
            auditFailure('state_missing', ipHash)
            frontendError(h, 'state_invalid')
            return
          }
          const flow = flows.get(state)
          // **一次性**：无论后续成功与否都先消费掉，重放同一 state 不可能发生
          flows.delete(state)
          if (!flow) {
            auditFailure('state_unknown', ipHash)
            frontendError(h, 'state_invalid')
            return
          }
          const code = h.url.searchParams.get('code')
          if (code === null || code.length === 0) {
            auditFailure('code_missing', ipHash)
            frontendError(h, 'code_missing')
            return
          }
          let identity: OidcClaims
          try {
            const { idToken } = await client.exchangeCode({
              code,
              codeVerifier: flow.codeVerifier,
              redirectUri,
            })
            identity = await client.verifyIdToken(idToken, flow.nonce)
          } catch (err) {
            const reason = err instanceof OidcError ? err.code : 'oidc_failed'
            console.error('[@geewiki/oidc] 回跳处理失败:', reason)
            auditFailure(reason, ipHash)
            frontendError(h, reason)
            return
          }

          const outcome = await auth.authenticateOidc(identity, h.req)
          /*
           * **内容协商**：回跳既是浏览器导航（要 302 回前端），也可能被 API 客户端
           * （curl / 脚本 / 集成测试）直接调用。后者如果只拿到 302，就无法观察
           * "为什么没登进来"——而这些恰恰是安全验收项。
           * 故：`Accept: application/json` ⇒ 用 JSON + 恰当的状态码作答；
           * 否则一律 302 回前端的登录页（**票据无论哪条路径都只走 HttpOnly cookie**）。
           */
          const wantsJson = (h.req.headers.accept ?? '').includes('application/json')
          switch (outcome.kind) {
            case 'login': {
              h.res.setHeader('set-cookie', outcome.setCookie)
              if (wantsJson) {
                h.json(200, { ok: true, user: outcome.user, expiresAt: outcome.expiresAt })
                return
              }
              // 登录成功后回跳到用户最初想去的站内路径（已经过 sanitizeRedirect）
              redirect(h, `/#${flow.redirect}`)
              return
            }
            case 'link_required': {
              /*
               * 票据**只经 HttpOnly cookie 交付**，绝不放进 URL 或响应体：查询串会经 Referer、
               * 浏览器历史、反代日志与截图泄漏，响应体则会进入前端状态与错误上报。
               * 前端因此看不到票据，只能"带着 cookie"调用 `POST /api/auth/identities/link`。
               */
              h.res.setHeader(
                'set-cookie',
                serializeCookie(LINK_COOKIE, outcome.ticket, {
                  maxAgeSeconds: 300,
                  secure: secureCookie,
                }),
              )
              if (wantsJson) {
                h.json(409, {
                  ok: false,
                  error: 'identity_link_required',
                  message: '该邮箱已有本地账号，请先登录后确认绑定',
                  details: { email: outcome.email },
                })
                return
              }
              redirect(h, '/#/login?link=required')
              return
            }
            case 'no_invitation':
              if (wantsJson) {
                h.json(403, {
                  ok: false,
                  error: 'no_invitation',
                  message: '没有该邮箱的待接受邀请',
                  details: { email: outcome.email },
                })
                return
              }
              frontendError(h, 'no_invitation')
              return
            case 'denied':
              if (wantsJson) {
                h.json(403, { ok: false, error: outcome.reason, message: 'SSO 登录被拒绝' })
                return
              }
              frontendError(h, outcome.reason)
              return
          }
        },
        { access: 'public' },
      ),
    )

    /* ---------- 周期探测 ---------- */
    const intervalSeconds = config.probeIntervalSeconds ?? 60
    const timer =
      intervalSeconds > 0
        ? setInterval(() => {
            void probe()
          }, intervalSeconds * 1000)
        : null
    // 不因这个定时器让进程无法退出
    timer?.unref()

    console.log(
      `[@geewiki/oidc] 已注册 provider ${provider.id}（issuer ${issuer}，client ${clientId}，` +
        `回跳 ${redirectUri}，凭据环境变量 ${clientSecretEnv || '(public client，仅 PKCE)'}，` +
        `当前${probeState.available ? '可用' : `不可用：${probeState.reason ?? 'unreachable'}`}）`,
    )

    return () => {
      if (timer) clearInterval(timer)
      flows.clear()
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      unregisterProvider()
      console.log(`[@geewiki/oidc] 已卸载: provider ${provider.id} 与 /api/auth/oidc/* 路由已摘除`)
    }
  },
}

/** 与 `@geewiki/auth` 的 `LINK_COOKIE` 对齐的再导出，便于测试与文档引用 */
export { LINK_COOKIE }
