/**
 * OIDC 协议客户端：发现文档、JWKS、PKCE、授权码交换与 **ID token 校验**。
 *
 * 三条设计约束（都来自设计文档 §7.4 / §7.5）：
 * 1. **零新依赖**：只用 `node:crypto` 与全局 `fetch`（与 `@geewiki/openai` 同款）。
 * 2. **`issuer` 只认配置值**：发现文档里的 `issuer` 仅用于**核对**（不一致即失败），
 *    **绝不**用它去替换配置值 —— 否则一个被劫持/配错的发现文档就能把校验目标换掉
 *    （OIDC mix-up / SSRF 面）。
 * 3. **失败关闭**：算法不在白名单、`kid` 找不到、任何一处声明不匹配，一律抛错。
 *
 * 本文件是**纯协议层**：不碰数据库、不碰会话、不认识 cookie。账号策略在 `@geewiki/auth`。
 */
import {
  constants,
  createPublicKey,
  createHash,
  randomBytes,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'

/**
 * JWK 的**结构**类型。
 *
 * **刻意不 import `JsonWebKey`**：这个名字在 `@types/node` 的大版本之间挪过位置
 * （22 从 `node:crypto` 导出，26 不再导出），而本仓库同时装着两个版本
 * （`packages/server` 解析到 26、本包解析到 22）—— 一旦 import，就会在其中一个下编译失败。
 * 我们只把它转交给 `createPublicKey`，所以声明成结构类型再断言即可，行为不变。
 */
interface JwkLike {
  kty?: unknown
  kid?: unknown
  use?: unknown
  alg?: unknown
  [key: string]: unknown
}

/** `createPublicKey` 的入参类型（用 `Parameters` 取，避免再次依赖具体导出名） */
type PublicKeyInput = Parameters<typeof createPublicKey>[0]

/** 只接受这三种签名算法（设计文档 §7.4 第 6 条）：`alg:none` 与 `HS*` 是算法混淆攻击的入口 */
const ALG_WHITELIST = new Set(['RS256', 'ES256', 'PS256'])

/** JWKS 缓存时长（设计文档 §7.4 第 5 条） */
const JWKS_TTL_MS = 15 * 60 * 1000

/** 允许的时钟漂移（秒）：`exp` / `iat` 校验用 */
const CLOCK_SKEW_SECONDS = 60

export class OidcError extends Error {
  constructor(
    /** 机器码（会进审计的 `reason`，**不含任何 token 内容**） */
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OidcError'
  }
}

export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

/** ID token 里我们用到的声明（其余字段忽略） */
interface IdTokenPayload {
  iss?: unknown
  sub?: unknown
  aud?: unknown
  exp?: unknown
  iat?: unknown
  nbf?: unknown
  nonce?: unknown
  email?: unknown
  email_verified?: unknown
  name?: unknown
  preferred_username?: unknown
}

/** 校验通过后的身份声明；`issuer` 已规范化 */
export interface VerifiedIdentity {
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean
  displayName: string | null
}

export interface OidcClientOptions {
  /** **已规范化**的 issuer（`new URL(x).href`） */
  issuer: string
  clientId: string
  /** 客户端密钥的**环境变量名**（空串 = public client，仅用 PKCE） */
  clientSecretEnv: string
  /** 请求的 scope（必须含 `openid`） */
  scopes: string[]
  /** 单次请求总超时（毫秒） */
  timeoutMs: number
  /** 注入 fetch（测试用）；默认用全局 fetch */
  fetchImpl?: typeof fetch
}

/** 一次授权请求所需的一次性参数 */
export interface AuthorizationRequest {
  state: string
  nonce: string
  codeChallenge: string
  redirectUri: string
}

/** PKCE 的 code_verifier 与它的 S256 challenge */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

/** 一次性随机串（state / nonce 共用） */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url')
}

export class OidcClient {
  private discovery: OidcDiscovery | null = null
  private keys: Map<string, KeyObject> | null = null
  private keysFetchedAt = 0

  constructor(private readonly opts: OidcClientOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  /** 规范化 issuer（与 `@geewiki/auth` 的 `normalizeIssuer` 同规则；两侧都由测试钉住） */
  static normalizeIssuer(issuer: string): string | null {
    const raw = issuer.trim()
    if (raw.length === 0) return null
    try {
      const url = new URL(raw)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      return url.href
    } catch {
      return null
    }
  }

  /**
   * 拉取并缓存发现文档。
   *
   * **发现文档的 `issuer` 必须与配置值一致**（规范化后逐字相等）—— 不一致说明配置写错、
   * 或者我们连到了别的 IdP。这条是"禁止从发现文档里取回 issuer"的落地方式：
   * 校验目标始终是配置值，发现文档只能**否决**，不能**改写**。
   */
  async ensureDiscovery(force = false): Promise<OidcDiscovery> {
    if (this.discovery && !force) return this.discovery
    const url = new URL('.well-known/openid-configuration', this.opts.issuer).href
    const res = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    if (!res.ok) {
      throw new OidcError('discovery_failed', `发现文档请求失败: HTTP ${res.status}`)
    }
    const doc = (await res.json()) as Record<string, unknown>
    const discovered = typeof doc.issuer === 'string' ? OidcClient.normalizeIssuer(doc.issuer) : null
    if (discovered !== this.opts.issuer) {
      throw new OidcError(
        'issuer_mismatch',
        `发现文档的 issuer (${String(doc.issuer)}) 与配置的 issuer (${this.opts.issuer}) 不一致`,
      )
    }
    const authorization_endpoint = doc.authorization_endpoint
    const token_endpoint = doc.token_endpoint
    const jwks_uri = doc.jwks_uri
    if (
      typeof authorization_endpoint !== 'string' ||
      typeof token_endpoint !== 'string' ||
      typeof jwks_uri !== 'string'
    ) {
      throw new OidcError('discovery_incomplete', '发现文档缺少 authorization_endpoint / token_endpoint / jwks_uri')
    }
    this.discovery = { issuer: discovered, authorization_endpoint, token_endpoint, jwks_uri }
    return this.discovery
  }

  /** 可用性探测（同步调用方拿到的是缓存结果；见 `@geewiki/auth` 的 `capabilities` 说明） */
  async probe(): Promise<{ available: boolean; reason: string | null }> {
    try {
      await this.ensureDiscovery(true)
      return { available: true, reason: null }
    } catch (err) {
      return { available: false, reason: err instanceof OidcError ? err.code : 'unreachable' }
    }
  }

  /** 组装授权端点 URL（`response_type=code` + PKCE S256 + state + nonce） */
  async buildAuthorizationUrl(input: AuthorizationRequest): Promise<string> {
    const d = await this.ensureDiscovery()
    const url = new URL(d.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.opts.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('scope', this.opts.scopes.join(' '))
    url.searchParams.set('state', input.state)
    url.searchParams.set('nonce', input.nonce)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.href
  }

  /**
   * 用授权码换 token。
   *
   * `client_secret` **只从环境变量读**（配置里只存变量名）—— 与 `@geewiki/openai` 的
   * `apiKeyEnv` 同一纪律：插件配置会落盘进 git 跟踪的文件，那里不能出现密钥值。
   */
  async exchangeCode(input: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<{ idToken: string }> {
    const d = await this.ensureDiscovery()
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.opts.clientId,
      // **PKCE 强制**：无论是不是 public client 都带上（设计文档 §7.4 第 4 条）
      code_verifier: input.codeVerifier,
    })
    const secret = this.opts.clientSecretEnv
      ? (process.env[this.opts.clientSecretEnv] ?? '')
      : ''
    /*
     * 配了环境变量名但该变量为空 ⇒ 失败关闭。
     * 若静默按 public client 继续，一个"忘了注入密钥"的部署会以**更弱的凭据**照常工作，
     * 而这种降级不会有任何症状 —— 正是最难发现的一类问题。
     */
    if (this.opts.clientSecretEnv && secret.length === 0) {
      throw new OidcError(
        'client_secret_missing',
        `环境变量 ${this.opts.clientSecretEnv} 未设置（配置里声明了 clientSecretEnv）`,
      )
    }
    if (secret.length > 0) form.set('client_secret', secret)

    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) {
      // 不回显上游响应体全文：它可能含 token 或客户端密钥回显
      throw new OidcError('token_exchange_failed', `token 端点返回 HTTP ${res.status}`)
    }
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new OidcError('token_response_invalid', 'token 端点响应不是合法 JSON')
    }
    const idToken = payload.id_token
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new OidcError('id_token_missing', 'token 响应里没有 id_token')
    }
    return { idToken }
  }

  /**
   * 校验 ID token 并提取身份声明。
   *
   * 校验顺序**刻意固定**：格式 → **算法白名单** → 取密钥 → **验签** → 再读载荷。
   * 先验签再读字段，"未经验证的 JSON"就永远不会被当作可信输入。
   */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<VerifiedIdentity> {
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new OidcError('id_token_malformed', 'ID token 不是三段式 JWS')
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

    let header: Record<string, unknown>
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      throw new OidcError('id_token_malformed', 'ID token 头部不是合法 JSON')
    }
    const alg = header.alg
    if (typeof alg !== 'string' || !ALG_WHITELIST.has(alg)) {
      // `alg: none` 与 `HS*` 都在这里被挡下；错误信息**回显算法名**（不是密钥，可安全记录）
      throw new OidcError('alg_not_allowed', `不接受的签名算法: ${String(alg)}`)
    }
    const kid = typeof header.kid === 'string' && header.kid.length > 0 ? header.kid : null
    const key = await this.getKey(kid)

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8')
    const signature = Buffer.from(signatureB64, 'base64url')
    const ok = this.verifySignature(alg, signingInput, signature, key)
    if (!ok) throw new OidcError('bad_signature', 'ID token 签名校验失败')

    let payload: IdTokenPayload
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as IdTokenPayload
    } catch {
      throw new OidcError('id_token_malformed', 'ID token 载荷不是合法 JSON')
    }

    /* ---- 声明校验（全部失败关闭） ---- */
    const iss = typeof payload.iss === 'string' ? OidcClient.normalizeIssuer(payload.iss) : null
    // 比对的是**配置值**，不是发现文档里的值
    if (iss !== this.opts.issuer) {
      throw new OidcError('iss_mismatch', `ID token 的 iss 与配置的 issuer 不一致`)
    }
    const aud = payload.aud
    const audiences = Array.isArray(aud) ? aud : [aud]
    if (!audiences.some((a) => a === this.opts.clientId)) {
      throw new OidcError('aud_mismatch', 'ID token 的 aud 不含本 client_id')
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < nowSec) {
      throw new OidcError('token_expired', 'ID token 已过期')
    }
    if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_SECONDS > nowSec) {
      throw new OidcError('token_iat_invalid', 'ID token 的 iat 在未来（超出允许漂移）')
    }
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > nowSec) {
      throw new OidcError('token_not_yet_valid', 'ID token 尚未生效')
    }
    // nonce 必须与会话内的一次性值逐字相等
    if (typeof payload.nonce !== 'string' || payload.nonce !== expectedNonce) {
      throw new OidcError('nonce_mismatch', 'ID token 的 nonce 不匹配')
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new OidcError('sub_missing', 'ID token 缺少 sub')
    }

    const email =
      typeof payload.email === 'string' && payload.email.trim().length > 0
        ? payload.email.trim().toLowerCase()
        : null
    const displayName =
      typeof payload.name === 'string' && payload.name.trim().length > 0
        ? payload.name.trim()
        : typeof payload.preferred_username === 'string' && payload.preferred_username.trim().length > 0
          ? payload.preferred_username.trim()
          : null

    return {
      issuer: iss,
      subject: payload.sub,
      email,
      emailVerified: payload.email_verified === true,
      displayName,
    }
  }

  /** 按算法选择校验参数（ES256 的 JWS 签名是 raw R||S，不是 DER —— 必须显式声明） */
  private verifySignature(
    alg: string,
    signingInput: Buffer,
    signature: Buffer,
    key: KeyObject,
  ): boolean {
    try {
      if (alg === 'PS256') {
        return cryptoVerify(
          'sha256',
          signingInput,
          { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
          signature,
        )
      }
      if (alg === 'ES256') {
        return cryptoVerify(
          'sha256',
          signingInput,
          { key, dsaEncoding: 'ieee-p1363' },
          signature,
        )
      }
      return cryptoVerify('sha256', signingInput, key, signature)
    } catch {
      // 密钥类型与算法不匹配等情况一律当作"验签失败"，不外抛 —— 调用方只需知道"不可信"
      return false
    }
  }

  /**
   * 取签名公钥。
   *
   * `kid` 未命中缓存时**强制刷新一次**再失败（设计文档 §7.4 第 5 条）—— IdP 轮换密钥后
   * 若不刷新，所有登录会持续失败直到缓存过期（15 分钟），而症状看起来像"IdP 挂了"。
   *
   * **已知边界（缓存按 `kid` 索引）**：若某个 IdP 在**更换密钥材料的同时复用同一个 `kid`**，
   * 缓存会一直命中那把旧密钥，表现为"所有登录都签名校验失败"，直到 15 分钟 TTL 到期。
   * 这不是我们能在客户端单方面区分的情况（`kid` 是唯一的查找键），且规范要求 `kid`
   * 标识密钥材料，所以合规的实现不会触发它。真遇到时把 `JWKS_TTL_MS` 调小即可。
   */
  private async getKey(kid: string | null): Promise<KeyObject> {
    const cached = this.lookupKey(kid)
    if (cached) return cached
    await this.refreshKeys()
    const fresh = this.lookupKey(kid)
    if (fresh) return fresh
    throw new OidcError('unknown_kid', `JWKS 里找不到 kid=${kid ?? '(无 kid)'} 的签名密钥`)
  }

  private lookupKey(kid: string | null): KeyObject | null {
    if (!this.keys) return null
    if (Date.now() - this.keysFetchedAt > JWKS_TTL_MS) return null
    if (kid !== null) return this.keys.get(kid) ?? null
    // 没带 kid 时只在"只有一个密钥"的情况下可用；多个密钥时无法判断用哪个 ⇒ 失败关闭
    if (this.keys.size === 1) return [...this.keys.values()][0] ?? null
    return null
  }

  private async refreshKeys(): Promise<void> {
    const d = await this.ensureDiscovery()
    const res = await this.fetchImpl(d.jwks_uri, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    if (!res.ok) throw new OidcError('jwks_failed', `JWKS 请求失败: HTTP ${res.status}`)
    const doc = (await res.json()) as { keys?: unknown }
    if (!Array.isArray(doc.keys)) throw new OidcError('jwks_invalid', 'JWKS 响应缺少 keys 数组')
    const next = new Map<string, KeyObject>()
    for (const raw of doc.keys) {
      if (typeof raw !== 'object' || raw === null) continue
      const jwk = raw as JwkLike
      if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) continue
      // `use` 声明为加密用途的密钥不用于验签
      if (typeof jwk.use === 'string' && jwk.use !== 'sig') continue
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' } as unknown as PublicKeyInput))
      } catch {
        // 单个密钥不可解析不应让整份 JWKS 失效；跳过并在下面按"是否有可用密钥"统一裁决
        continue
      }
    }
    if (next.size === 0) throw new OidcError('jwks_empty', 'JWKS 里没有可用的签名密钥')
    this.keys = next
    this.keysFetchedAt = Date.now()
  }
}
