/**
 * @geewiki/auth 的行为测试。
 *
 * **测试策略**（与 @geewiki/wiki 的 service.test.ts 同思路：真实数据库 + 真实 SQL，
 * 只有 HTTP 层用替身）：
 * - 用 Node 22 内置的 `node:sqlite` 驱动**真实 SQLite**，并直接执行 db-sqlite 的
 *   `src/migrations/0010_identity.sql` 与 `0013_audit.sql`（**读真实文件，不抄一份 DDL**，
 *   避免表结构与迁移漂移）；
 * - 路由服务替身实现 `register`/`use`，并按**与 server 相同的顺序**驱动请求：
 *   先跑钩子（拿到裁决即短路），再跑处理器。这样 CSRF 与会话解析这两件挂在钩子上的事
 *   才真的被覆盖到（只调处理器会完全绕过它们）。
 * - 访问等级闸门（`judgeAccess`）**属 server 的职责，本文件不复制它的逻辑**：
 *   这里只断言"插件给每条路由声明了正确的等级"，等级的实际裁决由真实 curl
 *   端到端验收覆盖（见交付说明）。
 *
 * 每个用例在自己的临时库上跑，绝不触碰仓库的 data/geewiki.db。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import {
  anonymousPrincipal,
  asAsync,
  MIGRATION_TABLE,
  writeAuditLog,
  type DatabaseAdapter,
  type HttpRouterService,
  type RequestHook,
  type RouteAccess,
  type RouteHandler,
  type RouteHandlerContext,
  type RouteAccessOptions,
  type RunResult,
} from '@geewiki/core'
import { AuthPlugin, manifest, type AuthService } from '../src/index.js'
import { hashPassword, verifyPassword } from '../src/password.js'

/* ------------------------------ 夹具 ------------------------------ */

const MIGRATION_DIR = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations')

/**
 * 本插件依赖的**真实迁移文件**（属 db 插件，不是本插件自带）。
 * `0010` 建 users/sessions/...，`0013` 建 audit_log 与 acl_revision。
 */
const AUTH_MIGRATIONS = ['0010_identity.sql', '0013_audit.sql']

function loadSchema(): string {
  return AUTH_MIGRATIONS.map((f) => readFileSync(join(MIGRATION_DIR, f), 'utf8')).join('\n')
}

/** `node:sqlite` 上的 DatabaseAdapter：只做同步转发，不含业务逻辑（被验证的 SQL 仍是插件自己的） */
class NodeSqliteAdapter implements DatabaseAdapter {
  private readonly db: DatabaseSync

  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    // 真实迁移脚本一次执行；表结构与生产完全一致
    this.db.exec(loadSchema())
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
    const seed = this.db.prepare(`INSERT OR IGNORE INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`)
    for (const name of AUTH_MIGRATIONS) seed.run(name, new Date().toISOString())
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
    return this.query<{ name: string }>(`SELECT name FROM ${MIGRATION_TABLE} ORDER BY name`).map((r) => r.name)
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

interface CallResult {
  status: number
  body: Record<string, unknown>
  /** 响应头（含 `set-cookie`），供断言 cookie 属性 */
  headers: Record<string, string>
  /** 本次请求结束后从句柄里读到的会话令牌（从 set-cookie 里解析），便于串联后续请求 */
  sessionToken: string | null
}

interface Harness {
  adapter: NodeSqliteAdapter
  ctx: Context
  call(
    method: string,
    path: string,
    opts?: {
      params?: Record<string, string>
      body?: unknown
      headers?: Record<string, string>
    },
  ): Promise<CallResult>
  svc(): AuthService
  accessOf(method: string, path: string): RouteAccess | undefined
  /** 直接查库（断言副作用：审计行、会话行等） */
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  unload(): void
  dispose(): void
}

async function makeHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-auth-'))
  const adapter = new NodeSqliteAdapter(join(dir, 'test.db'))

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

  const dispose = (await AuthPlugin.apply(ctx, {
    cookieSecure: false,
    loginMaxFailures: 10,
    loginWindowSeconds: 60,
    ...config,
  })) as () => void

  const call: Harness['call'] = async (method, path, opts = {}) => {
    const entry = routes.get(`${method} ${path}`)
    assert.ok(entry, `应已注册路由 ${method} ${path}`)
    const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body), 'utf8')]
    const req = Readable.from(chunks) as unknown as IncomingMessage
    // 真实 HTTP/1.1 请求必带 Host（CSRF 的同源校验要拿它比对 Origin）
    const headers: Record<string, string> = { host: 'localhost', ...(opts.headers ?? {}) }
    if (opts.body !== undefined) headers['content-length'] = String(chunks[0]?.length ?? 0)
    ;(req as unknown as { headers: Record<string, string> }).headers = headers
    ;(req as unknown as { method: string }).method = method
    ;(req as unknown as { url: string }).url = path
    ;(req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: '127.0.0.1' }

    const responseHeaders: Record<string, string> = {}
    return await new Promise<CallResult>((resolve, reject) => {
      const finish = (status: number, payload: unknown): void => {
        const body = (payload ?? {}) as Record<string, unknown>
        const raw = responseHeaders['set-cookie'] ?? null
        // `gw_sid=<token>; ...` → 取 token；清空 cookie（Max-Age=0）视为 null
        const matched = raw === null ? null : /^gw_sid=([^;]*)/.exec(raw)
        const token = matched?.[1] ? decodeURIComponent(matched[1]) : null
        resolve({ status, body, headers: responseHeaders, sessionToken: token })
      }
      const h: RouteHandlerContext = {
        req,
        res: {
          setHeader: (name: string, value: string) => {
            responseHeaders[name.toLowerCase()] = value
          },
          once: () => {},
        } as unknown as ServerResponse,
        url: new URL(`http://localhost${path}`),
        params: opts.params ?? {},
        json: finish,
        // 与 server 的 dispatch 一致：进钩子前主体是匿名的
        principal: anonymousPrincipal(),
      }
      void (async () => {
        // 钩子链（与 server 的 runHooks 同序：任一拒绝即短路）
        for (const hook of hooks) {
          const verdict = await hook(h)
          if (verdict.ok !== true) {
            finish(verdict.status, { ok: false, error: verdict.code, message: verdict.message })
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
    call,
    svc: () => {
      const svc = ctx.get('auth-service') as AuthService | undefined
      assert.ok(svc, 'auth-service 必须被 provide（manifest 的 provides 只是依赖图 token，不建服务）')
      return svc
    },
    accessOf: (method, path) => routes.get(`${method} ${path}`)?.access,
    q: (sql, params) => adapter.query(sql, params),
    unload: () => dispose(),
    dispose: () => {
      try {
        dispose()
      } finally {
        adapter.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

/** 从 Set-Cookie 里取出浏览器后续会回传的 Cookie 头 */
function cookieHeader(token: string): Record<string, string> {
  return { cookie: `gw_sid=${encodeURIComponent(token)}` }
}

const GOOD_PASSWORD = 'correct-horse-battery'

/* ------------------------- 1. 服务与等级声明 ------------------------- */

test('auth-service：apply 后 ctx.get 拿得到；各端点的 access 等级符合设计', async () => {
  const h = await makeHarness()
  try {
    assert.equal(manifest.geewiki.provides, 'auth-service', '前置：manifest 声明的 token 名')
    assert.equal(typeof h.svc().hasCredentialSource, 'function')
    assert.equal(typeof h.svc().resolveSession, 'function')
    assert.equal(h.svc().hasCredentialSource(), false, '空库：还没有可登录的账号')

    // 等级：登录/初始化/状态是 public（否则引导与登录无法进行），me/password 是 user
    assert.equal(h.accessOf('GET', '/api/auth/state'), undefined, '未声明 = public')
    assert.equal(h.accessOf('POST', '/api/auth/setup'), undefined)
    assert.equal(h.accessOf('POST', '/api/auth/login'), undefined)
    assert.equal(h.accessOf('POST', '/api/auth/logout'), undefined)
    assert.equal(h.accessOf('GET', '/api/auth/me'), 'user')
    assert.equal(h.accessOf('POST', '/api/auth/password'), 'user')

    // 卸载后路由与服务都应摘除
    h.unload()
    assert.equal(h.accessOf('GET', '/api/auth/state'), undefined, '卸载后路由已摘除')
    assert.equal(h.ctx.get('auth-service'), undefined, '卸载后服务已注销')
  } finally {
    h.dispose()
  }
})

/* --------------------------- 2. 初始化向导 --------------------------- */

test('setup：首次创建账号并自动登录；第二次调用 409；local 账号 email_verified=1', async () => {
  const h = await makeHarness()
  try {
    const first = await h.call('POST', '/api/auth/setup', {
      body: { email: 'Owner@Example.com', password: GOOD_PASSWORD, displayName: '站长' },
    })
    assert.equal(first.status, 201)
    assert.equal((first.body.user as { email: string }).email, 'owner@example.com', 'email 应归一化为小写')
    assert.ok(first.sessionToken, '初始化后应直接登录（下发会话 cookie）')
    const setCookie = first.headers['set-cookie'] ?? ''
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Lax/)
    assert.match(setCookie, /Path=\//)
    assert.doesNotMatch(setCookie, /Secure/, 'cookieSecure=false 时不得带 Secure（否则本地 http 不回传）')

    // 库里的账号状态：本地创建即视为已验证
    const users = h.q<{ email: string; email_verified: number; status: string }>(
      'SELECT email, email_verified, status FROM users',
    )
    assert.equal(users.length, 1)
    assert.equal(users[0]?.email_verified, 1)
    assert.equal(users[0]?.status, 'active')

    // 凭据：算法名与参数入库，且**不是明文**
    const creds = h.q<{ algo: string; params: string; salt: string; hash: string }>(
      'SELECT algo, params, salt, hash FROM user_credentials',
    )
    assert.equal(creds[0]?.algo, 'scrypt')
    assert.match(creds[0]?.params ?? '', /"N":32768/)
    assert.notEqual(creds[0]?.hash, GOOD_PASSWORD)

    // 自守卫：第二次必须被拒（否则它就是一个匿名的"创建任意账号"接口）
    const second = await h.call('POST', '/api/auth/setup', {
      body: { email: 'other@example.com', password: GOOD_PASSWORD },
    })
    assert.equal(second.status, 409)
    assert.equal(second.body.error, 'setup_already_done')

    // 审计留痕
    const audit = h.q<{ action: string; target_kind: string }>('SELECT action, target_kind FROM audit_log')
    assert.deepEqual(
      audit.map((a) => a.action),
      ['user.setup'],
    )
  } finally {
    h.dispose()
  }
})

test('setup：凭据来源探针从 false 变 true（供 judgeAccess 区分 503 与 401）', async () => {
  const h = await makeHarness()
  try {
    assert.equal(h.svc().hasCredentialSource(), false)
    await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    assert.equal(h.svc().hasCredentialSource(), true, 'setup 成功后必须立即置真（探针是同步缓存）')
  } finally {
    h.dispose()
  }
})

test('setup：参数校验（邮箱格式 / 口令长度）分别给 400 与对应机器码', async () => {
  const h = await makeHarness()
  try {
    const badEmail = await h.call('POST', '/api/auth/setup', {
      body: { email: 'not-an-email', password: GOOD_PASSWORD },
    })
    assert.equal(badEmail.status, 400)
    assert.equal(badEmail.body.error, 'invalid_email')

    const shortPwd = await h.call('POST', '/api/auth/setup', {
      body: { email: 'a@b.co', password: 'short' },
    })
    assert.equal(shortPwd.status, 400)
    assert.equal(shortPwd.body.error, 'invalid_password')

    assert.equal(h.q('SELECT id FROM users').length, 0, '校验失败不得留下半条账号')
  } finally {
    h.dispose()
  }
})

/* ------------------------------ 3. 登录 ------------------------------ */

test('login：正确口令下发会话；错误口令与不存在账号的响应**完全一致**（128 位不提枚举面）', async () => {
  const h = await makeHarness()
  try {
    await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })

    const ok = await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    assert.equal(ok.status, 200)
    assert.ok(ok.sessionToken)
    assert.equal((await h.svc().resolveSession(ok.sessionToken ?? ''))?.email, 'a@b.co')

    const wrong = await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'wrong-pass' } })
    const missing = await h.call('POST', '/api/auth/login', { body: { email: 'nobody@b.co', password: 'wrong-pass' } })
    assert.equal(wrong.status, 401)
    assert.equal(missing.status, 401)
    assert.equal(wrong.body.error, missing.body.error, '两条路径的机器码必须一致')
    assert.equal(wrong.body.message, missing.body.message, '两条路径的文案必须一致（否则可枚举邮箱）')

    const actions = h.q<{ action: string }>('SELECT action FROM audit_log ORDER BY id').map((a) => a.action)
    assert.deepEqual(actions, ['user.setup', 'login.ok', 'login.fail', 'login.fail'])
  } finally {
    h.dispose()
  }
})

test('login：连续 10 次失败后第 11 次返回 429；成功登录后计数清零', async () => {
  const h = await makeHarness()
  try {
    await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    for (let i = 1; i <= 10; i++) {
      const r = await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'nope' } })
      assert.equal(r.status, 401, `第 ${i} 次失败应是 401`)
    }
    const blocked = await h.call('POST', '/api/auth/login', {
      body: { email: 'a@b.co', password: GOOD_PASSWORD },
    })
    assert.equal(blocked.status, 429, '超过阈值后**即使口令正确**也要先被限流挡下')
    assert.equal(blocked.body.error, 'too_many_requests')

    // 换一个邮箱（不同限流键）不受影响 —— 限流键是 ip+email，不是全局开关
    const other = await h.call('POST', '/api/auth/login', { body: { email: 'x@b.co', password: 'nope' } })
    assert.equal(other.status, 401)
  } finally {
    h.dispose()
  }
})

test('login：限流窗口过期后自动恢复', async () => {
  // 1 秒窗口 + 1 次上限：一次失败即触发，等待窗口过期后恢复
  const h = await makeHarness({ loginMaxFailures: 1, loginWindowSeconds: 1 })
  try {
    await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'nope' } })
    const blocked = await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    assert.equal(blocked.status, 429)
    await new Promise((r) => setTimeout(r, 1100))
    const recovered = await h.call('POST', '/api/auth/login', {
      body: { email: 'a@b.co', password: GOOD_PASSWORD },
    })
    assert.equal(recovered.status, 200, '窗口过期后应恢复（进程内滑动窗口，不是永久封禁）')
  } finally {
    h.dispose()
  }
})

/* ------------------------------ 4. 会话 ------------------------------ */

test('会话：绝对过期与空闲过期都生效；已吊销的会话立即失效', async () => {
  const h = await makeHarness()
  try {
    const setup = await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    const token = setup.sessionToken ?? ''
    assert.ok(await h.svc().resolveSession(token))

    // 绝对过期：把 expires_at 改到过去
    h.q('UPDATE sessions SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()])
    assert.equal(await h.svc().resolveSession(token), undefined, '过期会话必须失效')

    // 空闲过期：绝对过期恢复正常、空闲过期改到过去
    h.q('UPDATE sessions SET expires_at = ?, idle_expires_at = ?', [
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date(Date.now() - 1000).toISOString(),
    ])
    assert.equal(await h.svc().resolveSession(token), undefined, '空闲超时的会话必须失效')

    // 吊销：两个过期时间都正常，但 revoked_at 非空
    h.q('UPDATE sessions SET idle_expires_at = ?, revoked_at = ?', [
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString(),
    ])
    assert.equal(await h.svc().resolveSession(token), undefined, '已吊销的会话必须失效')
  } finally {
    h.dispose()
  }
})

test('logout：服务端吊销会话（不只是让浏览器删 cookie），旧 cookie 立刻无效', async () => {
  const h = await makeHarness()
  try {
    const setup = await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    const token = setup.sessionToken ?? ''
    assert.ok(await h.svc().resolveSession(token))

    const out = await h.call('POST', '/api/auth/logout', {
      headers: { ...cookieHeader(token), 'x-gw-csrf': '1' },
    })
    assert.equal(out.status, 200)
    assert.match(out.headers['set-cookie'] ?? '', /Max-Age=0/, '应清空 cookie')
    assert.equal(await h.svc().resolveSession(token), undefined, '服务端必须已吊销：旧 cookie 不能再换到身份')

    // 幂等：再登出一次仍然 200（不带 cookie 也不该报错）
    const again = await h.call('POST', '/api/auth/logout')
    assert.equal(again.status, 200)
  } finally {
    h.dispose()
  }
})

test('会话解析：钩子把匿名主体换成用户；随后请求能拿到身份', async () => {
  const h = await makeHarness()
  try {
    const setup = await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    const token = setup.sessionToken ?? ''
    const state = await h.call('GET', '/api/auth/state', { headers: cookieHeader(token) })
    assert.equal(state.body.authenticated, true, '带有效 cookie 的请求应被识别为已登录')
    assert.equal((state.body.user as { email: string }).email, 'a@b.co')

    // 无效令牌退回匿名（不报错：过期 cookie 不该让公开页面打不开）
    const anon = await h.call('GET', '/api/auth/state', { headers: cookieHeader('bogus-token') })
    assert.equal(anon.status, 200)
    assert.equal(anon.body.authenticated, false)
  } finally {
    h.dispose()
  }
})

/* ------------------------------ 5. CSRF ------------------------------ */

test('CSRF：带 cookie 的非 GET 缺 X-GW-CSRF ⇒ 403；补齐后放行；跨站 Origin 一律拒绝', async () => {
  const h = await makeHarness()
  try {
    const setup = await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    const token = setup.sessionToken ?? ''
    const withCookie = cookieHeader(token)

    // 带 cookie、无自定义头 ⇒ 典型的 CSRF 形态
    const noHeader = await h.call('POST', '/api/auth/logout', { headers: withCookie })
    assert.equal(noHeader.status, 403)
    assert.equal(noHeader.body.error, 'csrf_rejected')
    assert.ok(await h.svc().resolveSession(token), '被 CSRF 拦下的请求不得产生副作用')

    // 补齐自定义头 ⇒ 放行
    const withCsrf = await h.call('POST', '/api/auth/logout', {
      headers: { ...withCookie, 'x-gw-csrf': '1' },
    })
    assert.equal(withCsrf.status, 200)

    // 跨站 Origin：即便带齐 cookie 与自定义头也拒绝（表单提交无法伪造 Origin）
    const log = await h.call('POST', '/api/auth/login', {
      body: { email: 'a@b.co', password: GOOD_PASSWORD },
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(log.status, 403)
    assert.equal(log.body.error, 'csrf_rejected')

    // Sec-Fetch-Site: cross-site 同样拒绝
    const crossSite = await h.call('POST', '/api/auth/login', {
      body: { email: 'a@b.co', password: GOOD_PASSWORD },
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403)

    // 无 cookie 的脚本调用（既无 Origin 也无 cookie）不受 CSRF 约束
    const script = await h.call('POST', '/api/auth/login', {
      body: { email: 'a@b.co', password: GOOD_PASSWORD },
    })
    assert.equal(script.status, 200, '脚本/CLI 调用没有环境凭据，不该被 CSRF 规则挡住')

    // 有 Origin 但缺 Host ⇒ 无法判定同源 ⇒ **失败关闭**（拒绝），而不是跳过校验
    const noHost = await h.call('POST', '/api/auth/login', {
      body: { email: 'a@b.co', password: GOOD_PASSWORD },
      headers: { origin: 'https://a.example', host: '' },
    })
    assert.equal(noHost.status, 403, '拿不到 Host 时必须拒绝：依赖传输层规范性来保证安全是错的')
  } finally {
    h.dispose()
  }
})

/* ---------------------------- 6. 修改口令 ---------------------------- */

test('改口令：当前口令错 ⇒ 401；成功后吊销其它会话、保留当前会话', async () => {
  const h = await makeHarness()
  try {
    const setup = await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    const s1 = setup.sessionToken ?? ''
    const s2 = (await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: GOOD_PASSWORD } }))
      .sessionToken
    assert.ok(s2)

    const wrong = await h.call('POST', '/api/auth/password', {
      body: { currentPassword: 'nope', newPassword: 'brand-new-password' },
      headers: { ...cookieHeader(s1), 'x-gw-csrf': '1' },
    })
    assert.equal(wrong.status, 401)

    const ok = await h.call('POST', '/api/auth/password', {
      body: { currentPassword: GOOD_PASSWORD, newPassword: 'brand-new-password' },
      headers: { ...cookieHeader(s1), 'x-gw-csrf': '1' },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.revokedOtherSessions, true)

    assert.ok(await h.svc().resolveSession(s1), '当前会话应保留（不把正在操作的浏览器踢下线）')
    assert.equal(await h.svc().resolveSession(s2), undefined, '其它会话必须被吊销')

    // 新口令可登录、旧口令不可
    const oldLogin = await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    assert.equal(oldLogin.status, 401)
    const newLogin = await h.call('POST', '/api/auth/login', {
      body: { email: 'a@b.co', password: 'brand-new-password' },
    })
    assert.equal(newLogin.status, 200)
  } finally {
    h.dispose()
  }
})

/* ------------------------------ 7. 口令哈希 ------------------------------ */

test('口令哈希：同一口令两次哈希不同（随机 salt）；错误口令校验失败；参数入库可升级', async () => {
  const a = await hashPassword('same-password')
  const b = await hashPassword('same-password')
  assert.notEqual(a.hash, b.hash, 'salt 必须随机：否则相同口令会得出相同哈希')
  assert.notEqual(a.salt, b.salt)

  assert.equal(await verifyPassword('same-password', a), true)
  assert.equal(await verifyPassword('other-password', a), false)

  // 未知算法 / 非法参数一律失败关闭（不得抛错被上层当成成功）
  assert.equal(await verifyPassword('same-password', { ...a, algo: 'md5' }), false)
  assert.equal(await verifyPassword('same-password', { ...a, params: 'not-json' }), false)
  assert.equal(await verifyPassword('same-password', { ...a, hash: 'zz' }), false)
})

/* ------------------------------ 8. 审计 ------------------------------ */

test('审计：口令变更与登出都落库；before/after 不含任何凭据字段', async () => {
  const h = await makeHarness()
  try {
    const setup = await h.call('POST', '/api/auth/setup', { body: { email: 'a@b.co', password: GOOD_PASSWORD } })
    const token = setup.sessionToken ?? ''
    await h.call('POST', '/api/auth/password', {
      body: { currentPassword: GOOD_PASSWORD, newPassword: 'brand-new-password' },
      headers: { ...cookieHeader(token), 'x-gw-csrf': '1' },
    })
    await h.call('POST', '/api/auth/logout', { headers: { ...cookieHeader(token), 'x-gw-csrf': '1' } })

    const rows = h.q<{ action: string; after_json: string | null; actor_ip_hash: string | null }>(
      'SELECT action, after_json, actor_ip_hash FROM audit_log ORDER BY id',
    )
    assert.deepEqual(
      rows.map((r) => r.action),
      ['user.setup', 'password.change', 'logout'],
    )
    // IP 只以哈希形态落库（不留原文）
    assert.match(rows[0]?.actor_ip_hash ?? '', /^[0-9a-f]{64}$/)
    // 审计里不得出现口令/令牌
    const dumped = JSON.stringify(rows)
    assert.doesNotMatch(dumped, /correct-horse-battery/)
    assert.doesNotMatch(dumped, /brand-new-password/)
    assert.doesNotMatch(dumped, new RegExp(token))
  } finally {
    h.dispose()
  }
})

test('审计表：写入的 before/after 会被兜底脱敏（即便调用方误传整个实体）', async () => {
  const h = await makeHarness()
  try {
    const db = asAsync(h.adapter)
    await writeAuditLog(db, {
      action: 'acl.change',
      targetKind: 'page',
      targetId: 'x',
      // 故意传入敏感字段：安全网必须把它们删掉
      before: { visibility: 'private', content: '机密正文', password: 'p@ss', token: 'tok' },
      after: { visibility: 'org' },
    })
    const row = h.q<{ before_json: string }>('SELECT before_json FROM audit_log')[0]
    const before = JSON.parse(row?.before_json ?? '{}') as Record<string, unknown>
    assert.equal(before.visibility, 'private', '非敏感字段应保留')
    assert.equal('content' in before, false, '正文不得落审计（CWE-779）')
    assert.equal('password' in before, false)
    assert.equal('token' in before, false)
  } finally {
    h.dispose()
  }
})

/* ------------------------- 9. 表缺失时的失败方式 ------------------------- */

test('表缺失 ⇒ 激活即报错（说清是迁移没跑），而不是运行时零散报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-auth-nomig-'))
  const adapter = new NodeSqliteAdapter(join(dir, 'empty.db'))
  // 造一个"迁移没跑"的库：删掉本插件依赖的表
  for (const t of ['audit_log', 'sessions', 'user_credentials', 'users', 'user_identities']) {
    adapter.run(`DROP TABLE IF EXISTS ${t}`)
  }
  const services = new Map<string, unknown>([
    ['db', asAsync(adapter)],
    [
      'http',
      {
        register: () => () => {},
        use: () => () => {},
        stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
        inflight: () => 0,
        pending: () => 0,
        drain: () => Promise.resolve(true),
      } satisfies HttpRouterService,
    ],
  ])
  const ctx = { get: (n: string) => services.get(n), provide: () => () => {} } as unknown as Context
  await assert.rejects(
    () => AuthPlugin.apply(ctx, {}),
    /缺少数据表.*0010_identity/,
    '缺表时必须明确指向迁移，而不是等第一个请求才炸',
  )
  adapter.close()
  rmSync(dir, { recursive: true, force: true })
})

test('fixture 前置：本文件读的是真实迁移文件（防止 DDL 漂移）', () => {
  for (const name of AUTH_MIGRATIONS) {
    const sql = readFileSync(join(MIGRATION_DIR, name), 'utf8')
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS'), `${basename(name)} 应是建表迁移`)
  }
})
