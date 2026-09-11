/**
 * @geewiki/oidc 的行为与**安全反例**测试。
 *
 * 测试策略（沿用 @geewiki/auth 的 test/auth.test.ts 的思路：真实数据库 + 真实 SQL +
 * 真实 HTTP，只有路由服务用替身）：
 * - **真实 SQLite**（Node 22 内置 `node:sqlite`），直接执行 db-sqlite 的**全部真实迁移文件**
 *   （读真文件，不抄 DDL）。**刻意不做"只挑几个"的白名单**，理由见下方 `allMigrations()`；
 * - **真实 mock IdP**：一个监听 127.0.0.1 的 `node:http` 服务，提供发现文档、JWKS 与
 *   token 端点，用 `node:crypto` 真签 RS256。**不用打桩的 fetch** —— 那样会把
 *   "发现文档解析 / JWKS 构造公钥 / 表单编码" 这些真正容易写错的环节跳过。
 * - **真实验签路径**：反例 token 由测试自己铸造（`alg:none`、HS256、错 iss/aud/exp/nonce），
 *   走的是与生产完全相同的 `verifyIdToken`。
 *
 * 设计文档 §8.2 的 P1.5 验收标准要求"mock IdP 下完成首登 invite_only 拒绝、email 已存在时
 * 409 identity_link_required、解绑最后一个凭据 409 last_credential、IdP 不可达时本地密码
 * 通道不受影响"，这四条都在下面各自的用例里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import {
  anonymousPrincipal,
  asAsync,
  MIGRATION_TABLE,
  type DatabaseAdapter,
  type HttpRouterService,
  type RequestHook,
  type RouteAccess,
  type RouteAccessOptions,
  type RouteHandler,
  type RouteHandlerContext,
  type RunResult,
} from '@geewiki/core'
import { AuthPlugin, LINK_COOKIE, type AuthService } from '@geewiki/auth'
import { OidcPlugin, sanitizeRedirect, validateIssuer } from '../src/index.js'
import { OidcClient } from '../src/client.js'

/* ============================== 夹具 ============================== */

/**
 * JWK 的结构类型。**刻意不用 `@types/node` 的 `JsonWebKey`**：该导出在 22 与 26 之间
 * 位置不同，而本仓库两个版本并存（见 `src/client.ts` 的同类说明）。
 */
type Jwk = Record<string, unknown>

const MIGRATION_DIR = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations')

/**
 * 本夹具应用的迁移 = db-sqlite 迁移目录下的**全部** `.sql`，与 `db.migrate()` 的
 * `readdirSync().sort()` 同序（同 `packages/plugin-wiki/test/slug-hierarchy.test.ts`）。
 *
 * **为什么不用白名单**：这里原先写死 `['0010_identity.sql', '0013_audit.sql']`，于是 P2 把
 * `@geewiki/auth` 的 `resolveOrgRole` 接成真查 `org_members` 之后，本夹具自建的库缺
 * `0011_org_team.sql` 建的表，**8 个用例以 `no such table: org_members` 集体失败**。
 * 那是**夹具与迁移集的集成缺口**（生产不受影响 —— 迁移控制器会跑全量迁移），但排查成本不低。
 *
 * 改成"全量 + 按文件名序"之后，**以后再加迁移不会重演**：只要新迁移能在
 * `0001 → 0002 → 0010 → 0011 → 0012 → 0013` 这条链上跑通，它就自动被本夹具覆盖。
 */
const MIGRATIONS = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

function loadSchema(): string {
  return MIGRATIONS.map((f) => readFileSync(join(MIGRATION_DIR, f), 'utf8')).join('\n')
}

class NodeSqliteAdapter implements DatabaseAdapter {
  private readonly db: DatabaseSync

  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    this.db.exec(loadSchema())
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
    const seed = this.db.prepare(
      `INSERT OR IGNORE INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`,
    )
    for (const name of MIGRATIONS) seed.run(name, new Date().toISOString())
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const r = this.db.prepare(sql).run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number | bigint }
  }

  migrate(): void {
    /* 本夹具已应用全部所需迁移；插件自身无迁移 */
  }

  listTables(): string[] {
    return this.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((r) => r.name)
  }

  appliedMigrations(): string[] {
    return this.query<{ name: string }>(
      `SELECT name FROM ${MIGRATION_TABLE} ORDER BY name`,
    ).map((r) => r.name)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}

/* ------------------------------ mock IdP ------------------------------ */

interface PendingAuthorization {
  codeChallenge: string
  claims: Record<string, unknown>
  /** 记录 token 端点实际收到的参数，供断言（例如"客户端确实发了 code_verifier"） */
  lastTokenRequest?: Record<string, string>
}

/**
 * 最小 OIDC Provider。
 *
 * 只实现授权码流所需的三样：发现文档、JWKS、token 端点。**token 端点会真的校验 PKCE** ——
 * 这样"我们的客户端有没有正确实现 PKCE"才是被测到的，而不是被测掉的。
 */
class MockIdp {
  readonly keys: { kid: string; privateKey: KeyObject; publicJwk: Jwk }
  private readonly server: Server
  private readonly pending = new Map<string, PendingAuthorization>()
  issuer = ''
  /** 令 token 端点直接返回错误（测"上游不可用"） */
  failToken = false
  /** 令发现文档返回错误的 issuer（测 mix-up 防护） */
  discoveryIssuerOverride: string | null = null
  /** 测试自行指定 id_token 的铸造方式（反例用） */
  mintOverride: ((claims: Record<string, unknown>) => string) | null = null
  /** token 端点最近一次收到的 `code_verifier`（断言"客户端确实实现了 PKCE"） */
  lastVerifierSeen: string | null = null
  /** 该 verifier 是否与授权请求发出的 challenge 匹配 */
  lastVerifierChallengeMatches = false

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicJwk = publicKey.export({ format: 'jwk' }) as Jwk
    this.keys = { kid: 'test-key-1', privateKey, publicJwk }

    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: this.discoveryIssuerOverride ?? this.issuer,
            authorization_endpoint: `${this.issuer}authorize`,
            token_endpoint: `${this.issuer}token`,
            jwks_uri: `${this.issuer}jwks`,
          }),
        )
        return
      }
      if (url.pathname === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            keys: [{ ...this.keys.publicJwk, kid: this.keys.kid, use: 'sig', alg: 'RS256' }],
          }),
        )
        return
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          const params: Record<string, string> = {}
          for (const [k, v] of form) params[k] = v
          if (this.failToken) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          const state = this.pending.get(params.code ?? '')
          if (!state) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          state.lastTokenRequest = params
          // **真校验 PKCE**：客户端没发 verifier 或发错 ⇒ 这里就失败
          this.lastVerifierSeen = params.code_verifier ?? null
          const challenge = createHashS256(params.code_verifier ?? '')
          this.lastVerifierChallengeMatches = challenge === state.codeChallenge
          if (challenge !== state.codeChallenge) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE failed' }))
            return
          }
          const idToken = this.mintOverride
            ? this.mintOverride(state.claims)
            : this.mintIdToken(state.claims)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }))
        })()
        return
      }
      res.writeHead(404).end()
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address() as AddressInfo
    // 归一化后的 issuer 形如 http://127.0.0.1:PORT/
    this.issuer = `http://127.0.0.1:${addr.port}/`
  }

  pend(code: string, codeChallenge: string, claims: Record<string, unknown>): void {
    this.pending.set(code, { codeChallenge, claims })
  }

  tokenRequestFor(code: string): Record<string, string> | undefined {
    return this.pending.get(code)?.lastTokenRequest
  }

  mint(claims: Record<string, unknown>): string {
    return this.mintIdToken(claims)
  }

  /** 用私钥真签一个 RS256 ID token */
  mintIdToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.keys.kid }),
      'utf8',
    ).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const input = Buffer.from(`${header}.${payload}`, 'utf8')
    const sig = cryptoSign('sha256', input, this.keys.privateKey).toString('base64url')
    return `${header}.${payload}.${sig}`
  }

  /** 用任意算法/密钥铸造 token（反例用：`alg:none`、HS256…） */
  mintUnsigned(claims: Record<string, unknown>, alg: string): string {
    const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid: this.keys.kid }), 'utf8').toString(
      'base64url',
    )
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const sig =
      alg === 'none' ? '' : Buffer.from('not-a-real-signature').toString('base64url')
    return `${header}.${payload}.${sig}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function createHashS256(input: string): string {
  // 与 PKCE 规范一致：BASE64URL(SHA256(ASCII(code_verifier)))，无填充
  return createHash('sha256').update(input).digest('base64url')
}

/* ------------------------------ harness ------------------------------ */

interface CallResult {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
  sessionToken: string | null
  /** 302 的 Location（非 302 时为 null） */
  location: string | null
}

interface Harness {
  adapter: NodeSqliteAdapter
  ctx: Context
  idp: MockIdp
  issuer: string
  call(
    method: string,
    path: string,
    opts?: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> },
  ): Promise<CallResult>
  /** 路由是否已注册（用于"未启用 ⇒ 端点不存在"的断言） */
  has(method: string, path: string): boolean
  svc(): AuthService
  loadOidc(config?: Record<string, unknown>): Promise<void>
  unloadOidc(): void
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  dispose(): void
}

async function makeHarness(authConfig: Record<string, unknown> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-oidc-'))
  const adapter = new NodeSqliteAdapter(join(dir, 'test.db'))
  const idp = new MockIdp()
  await idp.listen()

  const routes = new Map<string, { handler: RouteHandler; access?: RouteAccess }>()
  const hooks: RequestHook[] = []
  const routerService: HttpRouterService = {
    register: (method, path, handler, opts?: RouteAccessOptions) => {
      routes.set(`${method} ${path}`, { handler, access: opts?.access })
      return () => routes.delete(`${method} ${path}`)
    },
    use: (hook) => {
      hooks.push(hook)
      return () => {
        const i = hooks.indexOf(hook)
        if (i >= 0) hooks.splice(i, 1)
      }
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => 0,
    pending: () => 0,
    drain: () => Promise.resolve(true),
  }

  const services = new Map<string, unknown>([
    ['db', asAsync(adapter)],
    ['http', routerService],
  ])
  const ctx = {
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => {
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as Context

  const disposeAuth = (await AuthPlugin.apply(ctx, {
    cookieSecure: false,
    ...authConfig,
  })) as () => void

  let disposeOidc: (() => void) | null = null

  const call: Harness['call'] = async (method, path, opts = {}) => {
    // 拆查询串时**必须保留 `?`**：`new URL('http://x' + pathname + search)` 少了它就会拼成
    // `...callbackcode=X`，处理器读到的 searchParams 全空 —— 症状是"所有回跳都报 state 无效"
    const queryAt = path.indexOf('?')
    const pathname = queryAt < 0 ? path : path.slice(0, queryAt)
    const search = queryAt < 0 ? '' : path.slice(queryAt)
    const entry = routes.get(`${method} ${pathname}`)
    assert.ok(entry, `应已注册路由 ${method} ${pathname}`)
    // 真实的请求体必须写进流里：夹具忘了这一步的症状是"所有带 body 的端点都报参数不合法"
    const chunks: Buffer[] =
      opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body), 'utf8')]
    const req = Readable.from(chunks) as unknown as IncomingMessage
    const headers: Record<string, string> = { host: 'localhost', ...(opts.headers ?? {}) }
    if (opts.body !== undefined) headers['content-length'] = String(chunks[0]?.length ?? 0)
    ;(req as unknown as { headers: Record<string, string> }).headers = headers
    ;(req as unknown as { method: string }).method = method
    ;(req as unknown as { url: string }).url = path
    ;(req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: '127.0.0.1' }

    const responseHeaders: Record<string, string> = {}
    let statusWritten = 0
    let location: string | null = null
    return await new Promise<CallResult>((resolve, reject) => {
      const finish = (status: number, payload: unknown): void => {
        const raw = responseHeaders['set-cookie'] ?? null
        const matched = raw === null ? null : /^gw_sid=([^;]*)/.exec(raw)
        const token = matched?.[1] ? decodeURIComponent(matched[1]) : null
        resolve({
          status,
          body: (payload ?? {}) as Record<string, unknown>,
          headers: responseHeaders,
          sessionToken: token,
          location,
        })
      }
      const resState = { writableEnded: false, destroyed: false, headersSent: false }
      const resImpl = {
        get writableEnded() {
          return resState.writableEnded
        },
        get destroyed() {
          return resState.destroyed
        },
        get headersSent() {
          return resState.headersSent
        },
        setHeader: (name: string, value: string) => {
          responseHeaders[name.toLowerCase()] = value
        },
        writeHead: (status: number, hdrs?: Record<string, string>) => {
          statusWritten = status
          resState.headersSent = true
          if (hdrs) {
            for (const [k, v] of Object.entries(hdrs)) responseHeaders[k.toLowerCase()] = v
          }
          location = responseHeaders['location'] ?? null
        },
        end: (payload?: string) => {
          resState.writableEnded = true
          // 302（redirect）走的是 writeHead + end，没有 JSON 体
          if (statusWritten !== 0 && payload === undefined) {
            finish(statusWritten, {})
            return
          }
          let body: unknown = {}
          if (typeof payload === 'string' && payload.length > 0) {
            try {
              body = JSON.parse(payload)
            } catch {
              body = { raw: payload }
            }
          }
          finish(statusWritten === 0 ? 200 : statusWritten, body)
        },
        once: () => {},
      }
      const res = resImpl as unknown as ServerResponse

      const h: RouteHandlerContext = {
        req,
        res,
        url: new URL(`http://localhost${pathname}${search}`),
        params: opts.params ?? {},
        json: (status, payload) => {
          if (res.writableEnded) return
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(payload ?? {}))
        },
        noteStatus: () => {},
        principal: anonymousPrincipal(),
      }
      void (async () => {
        for (const hook of hooks) {
          const verdict = await hook(h)
          if (verdict.ok !== true) {
            h.json(verdict.status, { ok: false, error: verdict.code, message: verdict.message })
            return
          }
        }
        await entry.handler(h)
      })().catch(reject)
    })
  }

  return {
    adapter,
    ctx,
    idp,
    get issuer() {
      return idp.issuer
    },
    call,
    has: (method, path) => routes.has(`${method} ${path}`),
    svc: () => {
      const svc = ctx.get('auth-service') as AuthService | undefined
      assert.ok(svc, 'auth-service 必须被 provide')
      return svc
    },
    loadOidc: async (config = {}) => {
      disposeOidc = (await OidcPlugin.apply(ctx, {
        issuer: idp.issuer,
        clientId: 'geewiki-test',
        redirectUri: 'http://localhost/api/auth/oidc/callback',
        probeIntervalSeconds: 0,
        ...config,
      })) as () => void
    },
    unloadOidc: () => {
      disposeOidc?.()
      disposeOidc = null
    },
    q: (sql, params) => adapter.query(sql, params),
    dispose: () => {
      try {
        disposeOidc?.()
        disposeAuth()
      } finally {
        adapter.close()
        void idp.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

/* ------------------------------ 通用步骤 ------------------------------ */

const GOOD_PASSWORD = 'correct-horse-battery'

/** 建本地账号（首个账号，走 setup） */
async function setupLocal(h: Harness, email = 'boss@example.com'): Promise<void> {
  const r = await h.call('POST', '/api/auth/setup', {
    body: { email, password: GOOD_PASSWORD, displayName: 'Boss' },
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
}

/** 走一次完整的"前半程"：调 /start 拿 state 与 PKCE challenge */
async function startFlow(
  h: Harness,
  redirect = '/',
): Promise<{ state: string; nonce: string; codeChallenge: string; location: string }> {
  const r = await h.call('GET', `/api/auth/oidc/start?redirect=${encodeURIComponent(redirect)}`)
  assert.equal(r.status, 302, JSON.stringify(r.body))
  assert.ok(r.location, '应 302 到 IdP')
  const url = new URL(r.location)
  return {
    state: url.searchParams.get('state') ?? '',
    nonce: url.searchParams.get('nonce') ?? '',
    codeChallenge: url.searchParams.get('code_challenge') ?? '',
    location: r.location,
  }
}

/** 走一次完整的回跳；`claims` 缺省字段会自动补上 */
async function callback(
  h: Harness,
  flow: { state: string; nonce: string; codeChallenge: string },
  claims: Record<string, unknown> = {},
  opts: { accept?: string } = {},
): Promise<CallResult> {
  const code = `code-${Math.random().toString(36).slice(2)}`
  h.idp.pend(code, flow.codeChallenge, {
    iss: h.issuer,
    sub: 'user-1',
    aud: 'geewiki-test',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce: flow.nonce,
    email: 'newbie@example.com',
    email_verified: true,
    name: 'Newbie',
    ...claims,
  })
  return await h.call('GET', `/api/auth/oidc/callback?code=${code}&state=${flow.state}`, {
    headers: { accept: opts.accept ?? 'application/json' },
  })
}

/* ============================== 用例 ============================== */

test('未装载 @geewiki/oidc 时 /api/auth/oidc/* 端点不存在（404 语义）', async () => {
  const h = await makeHarness()
  try {
    assert.equal(h.has('GET', '/api/auth/oidc/start'), false)
    assert.equal(h.has('GET', '/api/auth/oidc/callback'), false)
    // 本地密码通道完全正常
    await setupLocal(h)
    const login = await h.call('POST', '/api/auth/login', {
      body: { email: 'boss@example.com', password: GOOD_PASSWORD },
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
  } finally {
    h.dispose()
  }
})

test('装载后 capabilities 反映可用性；未装载时 reason=disabled', async () => {
  const h = await makeHarness()
  try {
    const before = await h.call('GET', '/api/auth/state')
    assert.deepEqual(before.body.oidc, { available: false, reason: 'disabled' })

    await h.loadOidc()
    const after = await h.call('GET', '/api/auth/state')
    const oidc = after.body.oidc as Record<string, unknown>
    assert.equal(oidc.available, true)
    assert.equal(oidc.startPath, '/api/auth/oidc/start')

    // 注册表可列出，且 repeat 注册同 id 抛错
    assert.equal(h.svc().listOidcProviders().length, 1)
    assert.throws(
      () => h.svc().registerOidcProvider({ id: 'oidc', label: 'x', startPath: '/x', available: () => true, reason: () => null }),
      /重复注册/,
    )
  } finally {
    h.dispose()
  }
})

test('/start 302 到 IdP，且强制 PKCE S256 + state + nonce', async () => {
  const h = await makeHarness()
  try {
    await h.loadOidc()
    const flow = await startFlow(h, '/wiki/secret')
    const url = new URL(flow.location)
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('client_id'), 'geewiki-test')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 40)
    assert.ok(flow.state.length >= 16)
    assert.ok(flow.nonce.length >= 16)
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost/api/auth/oidc/callback')
  } finally {
    h.dispose()
  }
})

test('auto 模式：首登建号 + 建会话 + 写 user_identities + 审计；且真的用了 PKCE', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await h.loadOidc()
    const flow = await startFlow(h)
    const r = await callback(h, flow)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.sessionToken, '应下发会话 cookie')
    assert.match(r.headers['set-cookie'] ?? '', /HttpOnly/)
    assert.match(r.headers['set-cookie'] ?? '', /SameSite=Lax/)

    const users = h.q<{ id: number; email: string; email_verified: number }>(
      'SELECT id, email, email_verified FROM users',
    )
    assert.equal(users.length, 1)
    assert.equal(users[0]?.email, 'newbie@example.com')
    assert.equal(Number(users[0]?.email_verified), 1)

    const idents = h.q<{ issuer: string; subject: string }>(
      'SELECT issuer, subject FROM user_identities',
    )
    assert.equal(idents.length, 1)
    // **规范化后入库**：issuer 带尾部斜杠
    assert.equal(idents[0]?.issuer, h.issuer)
    assert.equal(idents[0]?.subject, 'user-1')

    assert.ok(await waitForAudit(h, 'user.create'), '应留下 user.create 审计')
    assert.ok(await waitForAudit(h, 'login.ok'), '应留下 login.ok 审计')

    // 第二次登录（同一身份）直接放行，不再建号
    const flow2 = await startFlow(h)
    const r2 = await callback(h, flow2)
    assert.equal(r2.status, 200, JSON.stringify(r2.body))
    assert.equal(h.q('SELECT id FROM users').length, 1)
    assert.equal(h.q('SELECT id FROM user_identities').length, 1)
  } finally {
    h.dispose()
  }
})

test('auto 模式 + 域名白名单：不匹配则拒绝', async () => {
  const h = await makeHarness({
    oidcProvisioningMode: 'auto',
    oidcAllowedEmailDomains: ['corp.example'],
  })
  try {
    await h.loadOidc()
    const flow = await startFlow(h)
    const r = await callback(h, flow, { email: 'someone@elsewhere.com' })
    assert.equal(r.status, 403, JSON.stringify(r.body))
    assert.equal(r.body.error, 'email_domain_not_allowed')
    assert.equal(h.q('SELECT id FROM users').length, 0)
  } finally {
    h.dispose()
  }
})

test('invite_only（默认）且邀请表不存在 ⇒ 403 no_invitation（P1.5 验收项）', async () => {
  const h = await makeHarness()
  try {
    await h.loadOidc() // 默认 invite_only；invitations 属 P2，此库中没有该表
    const flow = await startFlow(h)
    const r = await callback(h, flow)
    assert.equal(r.status, 403, JSON.stringify(r.body))
    assert.equal(r.body.error, 'no_invitation')
    assert.equal(h.q('SELECT id FROM users').length, 0)
    assert.ok(await waitForAudit(h, 'login.fail'), '应留下 login.fail 审计')
  } finally {
    h.dispose()
  }
})

test('provisioning off ⇒ 拒绝建号', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'off' })
  try {
    await h.loadOidc()
    const flow = await startFlow(h)
    const r = await callback(h, flow)
    assert.equal(r.status, 403, JSON.stringify(r.body))
    assert.equal(r.body.error, 'provisioning_off')
  } finally {
    h.dispose()
  }
})

test('email 已存在 ⇒ 409 identity_link_required，票据只在 HttpOnly cookie 里（P1.5 验收项）', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await setupLocal(h, 'boss@example.com')
    await h.loadOidc()
    const flow = await startFlow(h)
    const r = await callback(h, flow, { email: 'boss@example.com', sub: 'boss-sub' })
    assert.equal(r.status, 409, JSON.stringify(r.body))
    assert.equal(r.body.error, 'identity_link_required')

    // 票据只在 cookie 里，**不在** URL 也不在响应体
    const cookie = r.headers['set-cookie'] ?? ''
    assert.match(cookie, new RegExp(`^${LINK_COOKIE}=`))
    assert.match(cookie, /HttpOnly/)
    assert.equal(r.location, null, 'JSON 路径不应 302')
    assert.equal(JSON.stringify(r.body).includes(cookie.split(';')[0] ?? '___'), false)

    // 未登录时不能确认绑定
    const anon = await h.call('POST', '/api/auth/identities/link', {
      headers: { cookie: `${LINK_COOKIE}=${extractLinkTicket(cookie)}` },
    })
    assert.equal(anon.status, 401)

    // 登录后确认绑定 ⇒ 200，且 user_identities 多一行挂到**已有**账号上
    const login = await h.call('POST', '/api/auth/login', {
      body: { email: 'boss@example.com', password: GOOD_PASSWORD },
    })
    assert.equal(login.status, 200)
    const ticket = extractLinkTicket(cookie)
    const link = await h.call('POST', '/api/auth/identities/link', {
      headers: { cookie: `gw_sid=${login.sessionToken}; ${LINK_COOKIE}=${ticket}`, 'x-gw-csrf': '1' },
    })
    assert.equal(link.status, 200, JSON.stringify(link.body))
    const idents = h.q<{ user_id: number; subject: string }>(
      'SELECT user_id, subject FROM user_identities',
    )
    assert.equal(idents.length, 1)
    assert.equal(idents[0]?.subject, 'boss-sub')
    assert.equal(
      Number(idents[0]?.user_id),
      Number((h.q<{ id: number }>('SELECT id FROM users LIMIT 1')[0]?.id ?? 0)),
    )
    // 票据 cookie 被清掉（Max-Age=0）
    assert.match(link.headers['set-cookie'] ?? '', /Max-Age=0/)
  } finally {
    h.dispose()
  }
})

test('绑定票据：篡改 / 过期 / 被他人占用 一律拒绝', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await setupLocal(h, 'boss@example.com')
    await h.loadOidc()
    const login = await h.call('POST', '/api/auth/login', {
      body: { email: 'boss@example.com', password: GOOD_PASSWORD },
    })
    const sid = login.sessionToken

    // ① 篡改签名
    const flow = await startFlow(h)
    const bad = await callback(h, flow, { email: 'boss@example.com' })
    const ticket = extractLinkTicket(bad.headers['set-cookie'] ?? '')
    const tampered = `${ticket.slice(0, -3)}xyz`
    const r1 = await h.call('POST', '/api/auth/identities/link', {
      headers: { cookie: `gw_sid=${sid}; ${LINK_COOKIE}=${tampered}`, 'x-gw-csrf': '1' },
    })
    assert.equal(r1.status, 400, JSON.stringify(r1.body))
    assert.equal(r1.body.error, 'link_ticket_invalid')

    // ② 没有票据
    const r2 = await h.call('POST', '/api/auth/identities/link', {
      headers: { cookie: `gw_sid=${sid}`, 'x-gw-csrf': '1' },
    })
    assert.equal(r2.status, 400)
    assert.equal(r2.body.error, 'link_ticket_missing')

    // ③ 该身份已绑定到别人 ⇒ 409（用第二个本地账号 + 同一张票据）
    const flow2 = await startFlow(h)
    const good = await callback(h, flow2, { email: 'boss@example.com', sub: 'shared-sub' })
    const goodTicket = extractLinkTicket(good.headers['set-cookie'] ?? '')
    const okLink = await h.call('POST', '/api/auth/identities/link', {
      headers: { cookie: `gw_sid=${sid}; ${LINK_COOKIE}=${goodTicket}`, 'x-gw-csrf': '1' },
    })
    assert.equal(okLink.status, 200, JSON.stringify(okLink.body))
    // 再拿同一张票据（未过期）确认 ⇒ 幂等 200 alreadyLinked
    const again = await h.call('POST', '/api/auth/identities/link', {
      headers: { cookie: `gw_sid=${sid}; ${LINK_COOKIE}=${goodTicket}`, 'x-gw-csrf': '1' },
    })
    assert.equal(again.status, 200)
    assert.equal(again.body.alreadyLinked, true)
  } finally {
    h.dispose()
  }
})

test('解绑：最后一个登录方式 ⇒ 409 last_credential；有口令时可解绑（P1.5 验收项）', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await setupLocal(h, 'boss@example.com')
    await h.loadOidc()
    const flow = await startFlow(h)
    const r = await callback(h, flow, { email: 'boss@example.com', sub: 'boss-sub' })
    const ticket = extractLinkTicket(r.headers['set-cookie'] ?? '')
    const login = await h.call('POST', '/api/auth/login', {
      body: { email: 'boss@example.com', password: GOOD_PASSWORD },
    })
    const sid = login.sessionToken
    const link = await h.call('POST', '/api/auth/identities/link', {
      headers: { cookie: `gw_sid=${sid}; ${LINK_COOKIE}=${ticket}`, 'x-gw-csrf': '1' },
    })
    assert.equal(link.status, 200)
    const identId = Number(h.q<{ id: number }>('SELECT id FROM user_identities')[0]?.id ?? 0)

    // 造一个"只有身份、没有口令"的账号来测 last_credential
    const onlySso = h.q<{ id: number }>('SELECT id FROM users LIMIT 1')[0]?.id ?? 0
    h.adapter.run('DELETE FROM user_credentials WHERE user_id = ?', [onlySso])
    const blocked = await h.call('POST', '/api/auth/identities/unlink', {
      body: { identityId: identId },
      headers: {
        cookie: `gw_sid=${sid}`,
        'content-type': 'application/json',
        'x-gw-csrf': '1',
      },
    })
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error, 'last_credential')

    // 有口令后可以解绑
    const { hashPassword } = await import('../../plugin-auth/src/password.js')
    const cred = await hashPassword(GOOD_PASSWORD)
    h.adapter.run(
      `INSERT INTO user_credentials (user_id, algo, params, salt, hash, updated_at) VALUES (?,?,?,?,?,?)`,
      [onlySso, cred.algo, cred.params, cred.salt, cred.hash, new Date().toISOString()],
    )
    const ok = await h.call('POST', '/api/auth/identities/unlink', {
      body: { identityId: identId },
      headers: {
        cookie: `gw_sid=${sid}`,
        'content-type': 'application/json',
        'x-gw-csrf': '1',
      },
    })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(h.q('SELECT id FROM user_identities').length, 0)
  } finally {
    h.dispose()
  }
})

test('ID token 校验：alg:none 与 HS256 必须被拒（算法混淆防护）', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await h.loadOidc()
    for (const alg of ['none', 'HS256']) {
      const flow = await startFlow(h)
      h.idp.mintOverride = (claims) => h.idp.mintUnsigned(claims, alg)
      const r = await callback(h, flow)
      assert.equal(r.status, 400, `alg=${alg} 应被拒: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.error, 'alg_not_allowed', `alg=${alg}`)
    }
    h.idp.mintOverride = null
    assert.equal(h.q('SELECT id FROM users').length, 0, '反例不得建号')
  } finally {
    h.dispose()
  }
})

test('ID token 校验：错 iss / 错 aud / 过期 exp / 错 nonce 必须被拒', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await h.loadOidc()
    const cases: { name: string; claims: Record<string, unknown>; error: string }[] = [
      { name: 'iss 指向别的 IdP', claims: { iss: 'http://127.0.0.1:1/' }, error: 'iss_mismatch' },
      { name: 'aud 不含本 client', claims: { aud: 'someone-else' }, error: 'aud_mismatch' },
      {
        name: 'exp 已过期',
        claims: { exp: Math.floor(Date.now() / 1000) - 3600 },
        error: 'token_expired',
      },
      { name: 'nonce 不匹配', claims: { nonce: 'not-the-nonce' }, error: 'nonce_mismatch' },
      {
        name: 'iat 在未来',
        claims: { iat: Math.floor(Date.now() / 1000) + 3600 },
        error: 'token_iat_invalid',
      },
    ]
    for (const c of cases) {
      const flow = await startFlow(h)
      const r = await callback(h, flow, c.claims)
      assert.equal(r.status, 400, `${c.name}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.error, c.error, c.name)
    }
    assert.equal(h.q('SELECT id FROM users').length, 0)
  } finally {
    h.dispose()
  }
})

test('issuer 尾部斜杠差异视为同一个 IdP（规范化）；发现文档 issuer 不一致则拒绝', async () => {
  const h = await makeHarness()
  try {
    // 发现文档返回一个不同的 issuer ⇒ 激活后的第一次探测就会失败（capabilities 不可用）
    h.idp.discoveryIssuerOverride = 'http://evil.example/'
    await h.loadOidc()
    const state = await h.call('GET', '/api/auth/state')
    const oidc = state.body.oidc as Record<string, unknown>
    assert.equal(oidc.available, false)
    assert.equal(oidc.reason, 'issuer_mismatch')
    // /start 也不放行
    const start = await h.call('GET', '/api/auth/oidc/start')
    assert.equal(start.status, 503)
    assert.equal(start.body.error, 'oidc_unavailable')

    // 恢复正确值 ⇒ 自动恢复可用（每次 /start 现探一次）
    h.idp.discoveryIssuerOverride = null
    const flow = await startFlow(h)
    assert.ok(flow.state)
  } finally {
    h.dispose()
  }
})

test('state 一次性：未知 state 与重放同一 state 都被拒', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await h.loadOidc()
    const unknown = await h.call('GET', '/api/auth/oidc/callback?code=x&state=nope', {
      headers: { accept: 'application/json' },
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error, 'state_invalid')

    const flow = await startFlow(h)
    const first = await callback(h, flow)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    // 重放同一 state
    const code2 = 'code-replay'
    h.idp.pend(code2, flow.codeChallenge, {
      iss: h.issuer,
      sub: 'user-1',
      aud: 'geewiki-test',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      nonce: flow.nonce,
      email: 'newbie@example.com',
    })
    const replay = await h.call('GET', `/api/auth/oidc/callback?code=${code2}&state=${flow.state}`, {
      headers: { accept: 'application/json' },
    })
    assert.equal(replay.status, 400)
    assert.equal(replay.body.error, 'state_invalid')
  } finally {
    h.dispose()
  }
})

test('PKCE：token 端点确实收到了匹配的 code_verifier', async () => {
  const h = await makeHarness({ oidcProvisioningMode: 'auto' })
  try {
    await h.loadOidc()
    const flow = await startFlow(h)
    const r = await callback(h, flow)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // mock IdP 会**真校验** PKCE（verifier 缺失或不匹配就拒绝换 token）；
    // 能走到 200 且它记录下了匹配的 verifier，说明我们的客户端确实实现了 PKCE
    assert.ok(h.idp.lastVerifierSeen, 'token 端点应收到 code_verifier')
    assert.equal(h.idp.lastVerifierChallengeMatches, true, 'code_verifier 必须与 challenge 匹配')
  } finally {
    h.dispose()
  }
})

test('IdP 不可达：capabilities 降级为 unreachable，本地密码通道不受影响（P1.5 验收项）', async () => {
  const h = await makeHarness()
  try {
    await setupLocal(h, 'boss@example.com')
    // 用错误的端口当 issuer ⇒ 探测必定失败
    await h.loadOidc({ issuer: 'http://127.0.0.1:1/' })
    const state = await h.call('GET', '/api/auth/state')
    const oidc = state.body.oidc as Record<string, unknown>
    assert.equal(oidc.available, false)
    assert.ok(typeof oidc.reason === 'string' && oidc.reason.length > 0)

    // **本地口令登录必须完全正常**
    const login = await h.call('POST', '/api/auth/login', {
      body: { email: 'boss@example.com', password: GOOD_PASSWORD },
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    assert.ok(login.sessionToken)
    // 会话可用
    const me = await h.call('GET', '/api/auth/me', {
      headers: { cookie: `gw_sid=${login.sessionToken}`, 'x-gw-csrf': '1' },
    })
    assert.equal(me.status, 200)
  } finally {
    h.dispose()
  }
})

test('纯函数：validateIssuer 与 sanitizeRedirect 的失败关闭行为', () => {
  assert.equal(validateIssuer('https://idp.example.com'), 'https://idp.example.com/')
  assert.equal(validateIssuer('http://localhost:8080'), 'http://localhost:8080/')
  assert.equal(validateIssuer('http://127.0.0.1:9/'), 'http://127.0.0.1:9/')
  // 非 localhost 的 http、非 http(s) 协议、空值一律拒绝
  assert.equal(validateIssuer('http://idp.example.com'), null)
  assert.equal(validateIssuer('javascript:alert(1)'), null)
  assert.equal(validateIssuer(''), null)

  assert.equal(sanitizeRedirect(null), '/')
  assert.equal(sanitizeRedirect('/wiki/a'), '/wiki/a')
  // 开放重定向防护
  assert.equal(sanitizeRedirect('//evil.com'), '/')
  assert.equal(sanitizeRedirect('/\\evil.com'), '/')
  assert.equal(sanitizeRedirect('https://evil.com'), '/')
})

/* ------------------------------ 小工具 ------------------------------ */

/**
 * 等待某个审计动作落库。
 *
 * **必须轮询**：`writeAuditLog` 是 fire-and-forget 的（刻意的设计 —— 审计表损坏不该
 * 导致"谁都无法登录"），所以响应发出时它可能还没写完。
 */
async function waitForAudit(h: Harness, action: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = h.q<{ action: string }>('SELECT action FROM audit_log')
    if (rows.some((r) => r.action === action)) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 10))
  }
}


function extractLinkTicket(setCookie: string): string {
  const m = new RegExp(`${LINK_COOKIE}=([^;]*)`).exec(setCookie)
  assert.ok(m, `set-cookie 里应有 ${LINK_COOKIE}: ${setCookie}`)
  return decodeURIComponent(m[1] ?? '')
}
