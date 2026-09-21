/**
 * @geewiki/wiki 的 `wiki-service` 服务契约测试。
 *
 * **本批要钉住的核心问题**：manifest 的 `geewiki.provides` 只是**依赖图 token**，
 * 不会创建 cordis 服务。此前的缺陷是本插件声明了 `provides: 'wiki-service'`
 * 却从未 `ctx.provide` —— 于是任何按 `requires: ['wiki-service']` 依赖本插件的消费方
 * `ctx.get('wiki-service')` 都会拿到 `undefined`，症状是"永远拿不到数据"这类极难定位的
 * 表现（与 `search-service` 曾经的问题同型）。
 *
 * **测试策略**（与 @geewiki/search 的集成测试同思路：真实数据库 + 真实 SQL，只有 HTTP 层用替身）：
 * - 用 Node 22 内置的 `node:sqlite` 驱动**真实 SQLite**，并直接执行 db-sqlite 的
 *   `src/migrations/0001_init.sql`（**读真实文件，不抄一份 DDL**，避免表结构漂移）；
 *   之所以不用 `@geewiki/db-sqlite`：本包未声明该依赖，而本批不允许改 pnpm-lock.yaml。
 *   适配器只做"同步 API 转发"，不含业务逻辑，故不会把要验证的东西替掉。
 * - 服务方法与四个端点**共用同一份内部实现**，故本文件同时断言两者的结果逐字段一致
 *   （这正是"单一实现"的可执行证据）。
 * - 跨插件可见性单独用**真实 cordis + 真实 ctx.plugin()** 覆盖（替身 ctx 只能证明同 ctx 内）。
 *
 * 每个用例在自己的临时库上跑，绝不触碰仓库的 data/geewiki.db。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import { Context as CordisContext } from 'cordis'
import type { DatabaseAdapter, HttpRouterService, RouteHandler, RouteHandlerContext, RunResult } from '@geewiki/core'
import {
  anonymousPrincipal,
  asAsync,
  MIGRATION_TABLE,
  PAGE_SAVED_EVENT,
  type PageSavedEvent,
  type Principal,
} from '@geewiki/core'
import { AuthzPlugin } from '@geewiki/authz'
import { SLUG_HINT, WikiPlugin, manifest, type WikiService } from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

/**
 * db-sqlite 的真实迁移（**读真实文件，不抄一份 DDL**）：
 * `0001_init.sql` 建 pages / page_versions；`0012_page_acl.sql` 给 pages 补上 P2 的
 * 可见性列并建 `page_grants` —— 本插件自 P2 起在提供任何内容前都要过策略层，
 * 而策略层要读这几列，缺了它每个用例都会炸。
 */
/**
 * 夹具用的主体：**已登录的组织成员**。
 *
 * 为什么不用匿名：新建条目一律写成 `visibility='org'`（两层默认值的应用层那一半），
 * 匿名看不到它 —— 用匿名主体会让每个"建完再读"的用例都变成 404。
 * 用 member 既贴近真实用法，又顺带钉住"org 档对成员可见、不需要 published_at"。
 */
const MEMBER: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}
/**
 * 夹具用的**第二个**主体：无管理权、且对目标条目**没有**访问权的普通成员。
 *
 * 为什么需要它：申请访问的语义是"**你没权限 → 申请 → 别人批准**"，所以申请人不能是
 * `MEMBER`（`MEMBER` 对 org 档条目天然有读权限，`already_has_access` 会把申请挡掉）。
 * `userId` 必须在 `users` 表里真实存在 —— `access_requests.user_id` 有外键，否则插入报
 * `FOREIGN KEY constraint failed`（报错点在 SQL 层，离"夹具缺种子"很远）。
 */
const APPLICANT: Principal = {
  kind: 'user',
  userId: 2,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}
/**
 * 夹具用的**审批人**主体：组织 owner。
 *
 * 为什么审批人必须是 owner（而不能是 `MEMBER`）：`canManageVisibility` 的判据是
 * `canEdit && (orgRole === 'member' || isAdminRole(p))`（`packages/plugin-authz/src/index.ts:379`），
 * 而申请访问的用例**必须**把目标页设成 `private`（否则 `MEMBER` 和 `APPLICANT` 同属
 * 组织成员、都对 `org` 档有读权限，`already_has_access` 会把申请挡掉）。页面一旦是
 * `private`，`MEMBER` 自己也 `level === 'none'` ⇒ `canEdit` 为假 ⇒ 批不了。
 * 只有 admin 档（owner/admin）能对 `private` 页行使 `canManageVisibility`。
 */
const OWNER: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'owner',
  groupIds: [],
  sessionId: null,
}
/**
 * ★ 夹具的 schema 来源：**读 db-sqlite 迁移目录下的全部 `.sql`，按文件名序**。
 *
 * **为什么从"白名单常量"改成"读全目录"**：此前这里逐个列出 `0001 / 0010 / 0012 / 0015`，
 * 于是每次有新迁移落地、而新表又恰好被本插件的某条路径读到，夹具就会集体报
 * `no such table: xxx` —— 这已经发生过**三次**（P1 合并时缺 `0011_org_team.sql`、
 * P3a 时缺 `blocks_fts`、P3b 时缺 `block_grants`）。逐次补白名单是治标；
 * 读全目录才是治本：**新增迁移不会再破这个夹具**。
 *
 * 顺序与 `db.migrate()` 的 `readdirSync().sort()` **同序**（文件名前缀即依赖顺序：
 * `0010` 建 users → `0012` 的 `page_grants.granted_by` 才引得到；`0015` 建 blocks →
 * `0016` 的 `block_grants.block_id` 才引得到）。同款做法见
 * `packages/plugin-oidc/test/oidc.test.ts` 与 `packages/plugin-wiki/test/slug-hierarchy.test.ts`。
 */
const DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations')
const DB_MIGRATION_PATHS = readdirSync(DB_MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => join(DB_MIGRATIONS_DIR, f))

/**
 * `blocks_fts` 属 `@geewiki/search`（SQLite 专有，见设计文档 §4.3 ★v7），
 * **不在 db-sqlite 的迁移目录里**，故单独补一条 —— 它是 `savePage` 双写的另一半，
 * 缺了它每个保存用例都会以 `no such table: blocks_fts` 挂掉（P3a 时正是如此）。
 */
const BLOCKS_FTS_SQL_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'plugin-search',
  'migrations',
  '0002_blocks_fts.sql',
)
/** 夹具要建的全部 schema：db-sqlite 全量迁移（按文件名序）+ search 的块索引表 */
const SCHEMA_SQL_PATHS = [...DB_MIGRATION_PATHS, BLOCKS_FTS_SQL_PATH] as const

/**
 * `node:sqlite`（Node 内置）上的 DatabaseAdapter 实现。
 *
 * 只做同步转发：`query`/`run` 把参数按顺序绑定，`transaction` 用 BEGIN/COMMIT/ROLLBACK。
 * 不含任何业务逻辑——被验证的 SQL 与事务语义仍是插件自己的。
 */
class NodeSqliteAdapter implements DatabaseAdapter {
  private readonly db: DatabaseSync

  constructor(filename: string, schemaSql: string) {
    this.db = new DatabaseSync(filename)
    // 真实迁移脚本（多语句）一次执行；表结构与生产完全一致
    this.db.exec(schemaSql)
    // 迁移登记表（与 db-sqlite 同名同构）：schemaSql 已建好 db-sqlite 的内容，
    // 故登记为"已应用"，wiki 的自带迁移才会被当作增量应用。
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
    const seed = this.db.prepare(`INSERT OR IGNORE INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`)
    // 只登记本夹具实际执行过的脚本
    for (const p of SCHEMA_SQL_PATHS) seed.run(basename(p), new Date().toISOString())
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const r = this.db.prepare(sql).run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number | bigint }
  }

  /**
   * 与 db-sqlite 同语义的迁移执行：按文件名序应用**未登记**的脚本，每个脚本一个事务。
   * wiki 现在会应用自己的迁移（`page_links`），故夹具必须真的会迁移。
   */
  migrate(directory?: string): void {
    if (!directory) throw new Error('本夹具需要显式迁移目录（wiki 传的是 WIKI_MIGRATIONS_DIR）')
    const applied = new Set(this.appliedMigrations())
    for (const name of readdirSync(directory)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (applied.has(name)) continue
      const sql = readFileSync(join(directory, name), 'utf8')
      this.transaction(() => {
        this.db.exec(sql)
        this.db
          .prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`)
          .run(name, new Date().toISOString())
      })
    }
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

interface Harness {
  adapter: NodeSqliteAdapter
  /** 插件的 ctx（用于断言 provide 出来的 wiki-service） */
  ctx: Context
  /** 底层服务表：db/http 由夹具预置，wiki-service 由插件 provide 进去 */
  services: Map<string, unknown>
  /** 调用某个已注册端点（path 形如 '/api/pages'，params 为路径参数） */
  call(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
    /**
     * 可选的主体覆盖。默认 `MEMBER`（已登录成员）。
     *
     * 为什么需要它：申请访问的语义是"**甲申请、乙批准**"，一条用例里必须能切换主体 ——
     * 否则测不出"申请人看不到、审批人看得到"以及"批准后申请人立刻可见"。
     * 生产里主体由 `@geewiki/auth` 的钩子填充；夹具手工驱动处理器，故在此显式传入。
     */
    principal?: Principal,
  ): Promise<{ status: number; body: Record<string, unknown> }>
  /** 直接取服务（顺带断言它确实被 provide 出来了） */
  svc(): WikiService
  /** 路由是否仍注册（卸载后应为 false） */
  hasRoute(method: string, path: string): boolean
  unload(): void
  dispose(): void
}

/**
 * 建一个隔离的 wiki 环境：真实 SQLite + 真实初始迁移 + 路由服务替身。
 * `provide` 按 cordis 的**同 ctx** 语义实现（provide→get 立即可见、注销后回到 undefined）。
 *
 * `asyncDb: true` 时把同一个真实 SQLite 适配器经 **`asAsync`（core 的真实实现）** 包成
 * 异步适配器再交给插件——于是 `isAsyncAdapter()` 为真、插件内部走异步分支
 * （`asAsync` 成为直通）。这是"异步驱动下 wiki 是否可用"的回归守卫：
 * PostgreSQL 无法在单测里起，但它与这里**走的是同一条代码路径**（含 asAsync 的
 * BEGIN/COMMIT 显式事务）。
 */
async function makeHarness(
  config: { recentVersions?: number; asyncDb?: boolean; pgBigintAsString?: boolean } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiki-'))
  const adapter = new NodeSqliteAdapter(
    join(dir, 'test.db'),
    [
      ...SCHEMA_SQL_PATHS.map((p) => readFileSync(p, "utf8")),
      /*
       * ★ 种子一个用户。
       *
       * 为什么夹具需要它：`page_grants.granted_by` 与 `block_grants.granted_by` 都有
       * `REFERENCES users(id)`，而两个授予端点都会把 `principal.userId` 写进该列。
       * 夹具的 `MEMBER.userId = 1` 在库里必须真实存在，否则第一次授予就报
       * `FOREIGN KEY constraint failed` —— 报错点在 SQL 层，离“夹具缺种子”这个原因很远。
       * 生产里不会有这个问题（登录主体必然对应真实用户行）。
       */
      `INSERT INTO users (id, email, display_name, created_at)
       VALUES (1, 'member@example.com', 'Member', '2026-01-01T00:00:00Z');`,
      /*
       * ★ P3b：第二个用户 —— 申请访问用例里的「申请人」。
       * `access_requests.user_id` 有 `REFERENCES users(id)`，`APPLICANT.userId = 2`
       * 必须真实存在，否则申请插入报 `FOREIGN KEY constraint failed`。
       */
      `INSERT INTO users (id, email, display_name, created_at)
       VALUES (2, 'applicant@example.com', 'Applicant', '2026-01-01T00:00:00Z');`,
    ].join('\n'),
  )

  const routes = new Map<string, RouteHandler>()
  const routerService: HttpRouterService = {
    register: (method, path, handler) => {
      routes.set(`${method} ${path}`, handler)
      return () => routes.delete(`${method} ${path}`)
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => 0,
    pending: () => 0,
    drain: () => Promise.resolve(true),
  }
  /*
   * `pgBigintAsString: true` 模拟真实 `pg` 驱动的行为：**int8（COUNT(*)）以字符串返回**
   * （node-postgres 为避免 JS number 精度丢失而如此设计），而 better-sqlite3 返回数字。
   * 于是"只在一驱动下出错"的类型问题（version 变成 "01"）才能被单测抓到——
   * 单纯用 sqlite 跑，两条路径都返回数字，测不出任何差异。
   */
  const dbValue =
    config.asyncDb === true || config.pgBigintAsString === true ? asAsync(adapter) : adapter
  const dbForPlugin =
    config.pgBigintAsString === true
      ? (() => {
          const base = dbValue as ReturnType<typeof asAsync>
          const stringifyCounts = <T,>(rows: T[]): T[] =>
            rows.map((r) => {
              if (r === null || typeof r !== 'object') return r
              const o = { ...(r as unknown as Record<string, unknown>) }
              // pg 只对 int8 这样处理；本插件里唯一被当作数字消费的聚合列就是这两个
              for (const k of ['n', 'version_count']) if (k in o) o[k] = String(o[k])
              return o as unknown as T
            })
          return {
            ...base,
            query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
              stringifyCounts(await base.query<T>(sql, params)),
          } as ReturnType<typeof asAsync>
        })()
      : dbValue
  const services = new Map<string, unknown>([
    ['db', dbForPlugin],
    ['http', routerService],
  ])
  const ctx = {
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => {
        // 与 cordis 一致：注销把名字摘掉，后续 get 回到 undefined
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as Context
  /*
   * **先装真实的策略层**（不造假替身）：wiki 的读路径自 P2 起在提供任何内容之前
   * 都要向 `policy-service` 要判定，而可见性规则本身也该在这个夹具里被真跑 ——
   * 用替身会把"权限真的接线了没有"这件事一并测掉。
   */
  const disposeAuthz = (await (AuthzPlugin.apply as (c: Context) => Promise<unknown>)(ctx)) as () => void
  const disposeWiki = (await WikiPlugin.apply(ctx, { recentVersions: 10, ...config })) as () => void
  const dispose = (): void => {
    disposeWiki()
    disposeAuthz()
  }

  const call = (
    method: string,
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
    principal: Principal = MEMBER,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    /*
     * 路径可以带查询串（形如 `/api/pages/:slug?content=raw`）：**路由查表用路径部分**，
     * 查询串进 `h.url`。为什么需要：原文模式（`?content=raw`）是同一路由的另一种正文口径，
     * 没有它就只能为"带参数的同一路由"另造一条路由名，那是把契约写歪。
     */
    const [routeKey = path] = path.split('?')
    const handler = routes.get(`${method} ${routeKey}`)
    assert.ok(handler, `应已注册路由 ${method} ${path}`)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(chunks) as unknown as IncomingMessage
    ;(req as unknown as { headers: Record<string, string> }).headers =
      body === undefined ? {} : { 'content-length': String(chunks[0]?.length ?? 0) }
    return new Promise((resolve, reject) => {
      const h: RouteHandlerContext = {
        req,
        /*
         * `res` 替身：只实现处理器真正用到的少数成员。
         *
         * ★ P3c 补 `headersSent` / `setHeader`：413（快照超限）路径会经
         * `closeAfterResponse()` 声明 `Connection: close` 并在 `finish` 时销毁请求体 ——
         * 缺这两个成员时，那条用例会在替身上抛 `h.res.setHeader is not a function`，
         * 报错点离"替身不完整"这个原因很远（与夹具缺种子同一类问题）。
         */
        res: {
          headersSent: false,
          setHeader: () => {},
          once: () => {},
        } as unknown as ServerResponse,
        url: new URL(`http://localhost${path}`),
        params,
        /*
         * ★ P2：路由上下文必须带主体。生产里由 @geewiki/auth 的钩子填充，而本夹具
         * 手工驱动处理器（只跑处理器、不跑钩子），所以在这里显式给一个已登录成员。
         * 读路径**保持 public**，匿名访客拿到的是 anonymousPrincipal —— 本夹具刻意
         * 不用匿名，因为新建条目一律写成 `visibility='org'`，匿名看不到它。
         *
         * ★ P3b：主体可由调用方覆盖（见 `call` 的第 5 参），用于"甲申请、乙批准"这类
         * 需要一条用例里切换身份的流程。
         */
        principal,
        json: (status, payload) => resolve({ status, body: payload as Record<string, unknown> }),
      }
      void Promise.resolve(handler(h)).catch(reject)
    })
  }

  return {
    adapter,
    ctx,
    services,
    call,
    svc: () => {
      const svc = ctx.get('wiki-service') as WikiService | undefined
      assert.ok(svc, 'wiki-service 必须被 provide（manifest 的 provides 只是依赖图 token，不建服务）')
      return svc
    },
    hasRoute: (method, path) => routes.has(`${method} ${path}`),
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

/* ------------------ 1. 服务存在性与契约（本批核心） ------------------ */

test('wiki-service：apply 后 ctx.get 拿得到，四个方法与 manifest 的 provides 一致', async () => {
  const h = await makeHarness()
  try {
    // 探针反证：manifest 声明的 provides 不会自己变成 cordis 服务——
    // 若插件里漏掉 ctx.provide，这里拿到的是 undefined（这正是本批要修的症状）
    assert.equal(manifest.geewiki.provides, 'wiki-service', '前置：manifest 声明的 token 名')
    assert.ok(h.services.has('wiki-service'), 'provide 应把服务登记进 ctx')
    const svc = h.svc()
    for (const m of ['list', 'get', 'save', 'remove'] as const) {
      assert.equal(typeof svc[m], 'function', `wiki-service.${m} 应是函数`)
    }
    assert.deepEqual((await svc.list(MEMBER)), [], '空库应返回空列表')
    assert.equal((await svc.get('nope', MEMBER)), undefined, '不存在的 slug 返回 undefined（对应端点 404）')
  } finally {
    h.dispose()
  }
})

test('wiki-service：save 新建 → 读取 → 列表；内容未变时 outcome=unchanged 且不写历史', async () => {
  const h = await makeHarness()
  try {
    const svc = h.svc()

    // 新建
    /*
     * `indexTiersResync` 是 P3a 新增的**加法式**字段（仅 `outcome === 'created'` 时出现）：
     * 新建的页可能成为已有页的祖先 ⇒ 子孙的 `blocks.tier` 要重算。这里没有子孙，
     * 故 `resynced: 0` 且 `failed: false` —— 两者必须分开，因为 `0` 单独看是歧义的
     * （既可能"没有子孙"，也可能"扇出整个失败"，后者是内容泄漏级）。
     */
    assert.deepEqual((await svc.save('getting-started', { title: '入门', content: '第一版' })), {
      outcome: 'created',
      version: 1,
      indexTiersResync: { resynced: 0, failed: false },
    })
    const created = (await svc.get('getting-started', MEMBER))
    assert.ok(created, 'save 后应能读到')
    assert.equal(created.title, '入门')
    assert.equal(created.content, '第一版')
    assert.equal(created.version, 1, '新建页面版本号为 1')
    assert.deepEqual(created.versions, [], '新建不产生历史')

    // 幂等：标题与正文都没变 → unchanged，且不新增历史、版本号不变
    assert.deepEqual((await svc.save('getting-started', { title: '入门', content: '第一版' })), {
      outcome: 'unchanged',
      version: 1,
    })
    const afterNoop = (await svc.get('getting-started', MEMBER))
    assert.equal(afterNoop?.version, 1, 'unchanged 不应推进版本号')
    assert.deepEqual(afterNoop?.versions, [], 'unchanged 不应写历史快照')
    assert.equal(afterNoop?.updated_at, created.updated_at, 'unchanged 不应改 updated_at')

    // 更新：旧正文进历史，版本号 +1
    assert.deepEqual((await svc.save('getting-started', { title: '入门', content: '第二版' })), {
      outcome: 'updated',
      version: 2,
    })
    const updated = (await svc.get('getting-started', MEMBER))
    assert.equal(updated?.content, '第二版')
    assert.equal(updated?.version, 2)
    assert.equal(updated?.versions.length, 1, '更新应留下一条历史')
    // 历史里存的是**旧**正文（版本即历史）
    const versionId = updated?.versions[0]?.id
    assert.equal(
      h.adapter.query<{ content: string }>('SELECT content FROM page_versions WHERE id = ?', [versionId])[0]?.content,
      '第一版',
      '历史快照应是更新前的旧正文',
    )

    // 列表：摘要字段与排序（单条时只校验字段形状）
    // 导航批（2026-09-16）起摘要多了 `nav_hidden`：这里显式写进期望值，
    // 让"列表会下发隐藏状态"这件事本身也被钉住（同级的**顺序**不走摘要，见 GET /api/pages 的 nav_order）
    assert.deepEqual((await svc.list(MEMBER)), [
      {
        slug: 'getting-started',
        title: '入门',
        updated_at: updated?.updated_at,
        version: 2,
        nav_hidden: false,
      },
    ])

    // 标题变化也应记为更新（即使正文相同）
    assert.equal((await svc.save('getting-started', { title: '入门（改名）', content: '第二版' })).outcome, 'updated')
  } finally {
    h.dispose()
  }
})

test('wiki-service：remove 删除页面与历史；不存在的 slug 返回 false', async () => {
  const h = await makeHarness()
  try {
    const svc = h.svc()
    await svc.save('temp', { title: '临时', content: 'a' })
    await svc.save('temp', { title: '临时', content: 'b' }) // 产生一条历史
    assert.equal(h.adapter.query('SELECT id FROM page_versions').length, 1, '前置：应有一条历史')

    assert.equal((await svc.remove('temp')), true, '删除存在的页面应返回 true')
    assert.equal((await svc.get('temp', MEMBER)), undefined, '删除后 get 应返回 undefined')
    assert.deepEqual((await svc.list(MEMBER)), [], '删除后列表应为空')
    assert.equal(h.adapter.query('SELECT id FROM page_versions').length, 0, '版本历史应一并清除')

    assert.equal((await svc.remove('temp')), false, '删除不存在的页面应返回 false（对应端点 404）')
  } finally {
    h.dispose()
  }
})

test('wiki-service：非法入参抛错，消息前缀与端点的错误码同源', async () => {
  const h = await makeHarness()
  try {
    const svc = h.svc()
    // 非法 slug
    assert.rejects(async () => (await svc.save('bad slug!', { title: 't', content: 'c' })), /^Error: invalid_slug: /)
    // 空标题（含仅空白）
    assert.rejects(async () => (await svc.save('ok-slug', { title: '   ', content: 'c' })), /^Error: invalid_title: /)
    // 标题过长
    assert.rejects(async () => (await svc.save('ok-slug', { title: 'x'.repeat(201), content: 'c' })), /^Error: invalid_title: /)
    // 正文过长（与端点同为 500KB 上限）
    assert.rejects(
      async () => (await svc.save('ok-slug', { title: 't', content: 'y'.repeat(500_001) })),
      /^Error: content_too_large: /,
    )
    // 非法 remove 入参同样拒绝
    assert.rejects(async () => (await svc.remove('../etc')), /^Error: invalid_slug: /)
    assert.deepEqual((await svc.list(MEMBER)), [], '校验失败不得留下任何落库副作用')
  } finally {
    h.dispose()
  }
})

/* ---------- 2. 服务与端点同源（单一实现的可执行证据） ---------- */

test('wiki-service 与 REST 端点结果逐字段一致（服务只是把同一实现包成 HTTP）', async () => {
  const h = await makeHarness()
  try {
    const svc = h.svc()

    // 经端点写入 → 服务读取
    const put = await h.call('PUT', '/api/pages/:slug', { slug: 'via-http' }, { title: 'HTTP 写入', content: 'v1' })
    assert.equal(put.status, 200)
    assert.equal(put.body['outcome'], 'created')
    const viaHttp = await svc.get('via-http', MEMBER)
    assert.deepEqual(
      viaHttp,
      {
        slug: 'via-http',
        title: 'HTTP 写入',
        content: 'v1',
        created_at: viaHttp?.created_at,
        updated_at: viaHttp?.updated_at,
        /*
         * ★ 0024：块级归属随详情下发（区间 + 谁 + 什么时候）。
         * `updatedAt` 与上面两个时间戳同款自回填（它是"这次保存"的时刻）。
         * 值得断言的不是那个时刻，而是**作者名被真的查了出来**（`Member` 来自 users 表，
         * 是读写两条路径接上的证据）：写入时只落了 `updated_by = 1`。
         */
        blocks: [
          {
            start: 0,
            end: 2,
            gated: false,
            updatedAt: viaHttp?.blocks?.[0]?.updatedAt ?? null,
            author: { id: 1, displayName: 'Member' },
          },
        ],
        version: 1,
        versions: [],
        // ★ P2：详情新增能力标志；MEMBER 对该条目有管理权，故档位字段一并下发。
        // 新建条目默认 `org`（应用层显式写），未发布。
        capabilities: { canEdit: true, canDelete: true, canManageVisibility: true },
        visibility: 'org',
        inherit: true,
        published: false,
      },
      '端点写入的内容，服务应逐字段读到',
    )

    // 经服务写入 → 端点读取（同一实现，两条路径必须等价）
    await svc.save('via-svc', { title: '服务写入', content: 'v1' })
    const detail = await h.call('GET', '/api/pages/:slug', { slug: 'via-svc' })
    assert.equal(detail.status, 200)
    assert.deepEqual(Object.keys(detail.body).sort(), [
      // ★ 0024：块级归属（区间 + 谁 + 什么时候）—— 它是详情响应的**契约字段**
      'blocks',
      // ★ P2：详情新增能力标志与档位字段（有管理权时才带档位）
      'capabilities',
      'content',
      'created_at',
      'inherit',
      'published',
      'slug',
      'title',
      'updated_at',
      'version',
      'versions',
      'visibility',
    ])
    assert.equal(detail.body['content'], 'v1')
    assert.equal(detail.body['version'], 1)

    // 列表：服务的 list() 与端点 pages 数组逐字段一致（含顺序）
    const list = await h.call('GET', '/api/pages')
    assert.deepEqual(list.body['pages'], (await svc.list(MEMBER)))

    // 幂等语义在两条路径上一致：端点 unchanged ⇔ 服务 unchanged
    const putSame = await h.call('PUT', '/api/pages/:slug', { slug: 'via-svc' }, { title: '服务写入', content: 'v1' })
    assert.equal(putSame.body['outcome'], 'unchanged')
    assert.equal((await svc.save('via-svc', { title: '服务写入', content: 'v1' })).outcome, 'unchanged')

    // 删除：端点在服务删除后应 404（两条路径共享同一状态）
    assert.equal((await svc.remove('via-http')), true)
    const gone = await h.call('GET', '/api/pages/:slug', { slug: 'via-http' })
    assert.equal(gone.status, 404)
    assert.equal(gone.body['error'], 'not_found')
  } finally {
    h.dispose()
  }
})

test('端点既有错误语义未被本次重构改变（invalid_slug 400 / 未知字段 400 / 正文超限 413）', async () => {
  const h = await makeHarness()
  try {
    const badSlug = await h.call('PUT', '/api/pages/:slug', { slug: '../etc/passwd' }, { title: 't', content: 'c' })
    assert.equal(badSlug.status, 400)
    assert.equal(badSlug.body['error'], 'invalid_slug')
    // 断言与端点共用同一份 SLUG_HINT（不再硬编码文案：规则升级文案必然变化，
    // 硬编码会让"文案改了"被误报成"语义坏了"。本用例要守的是状态码+错误码+文案同源）
    assert.equal(badSlug.body['message'], SLUG_HINT)

    const unknownField = await h.call('PUT', '/api/pages/:slug', { slug: 'ok' }, { title: 't', content: 'c', nope: 1 })
    assert.equal(unknownField.status, 400)
    assert.equal(unknownField.body['error'], 'invalid_body')

    const tooLong = await h.call('PUT', '/api/pages/:slug', { slug: 'ok' }, { title: 't', content: 'y'.repeat(500_001) })
    assert.equal(tooLong.status, 413)
    assert.equal(tooLong.body['error'], 'content_too_large')

    const notFound = await h.call('DELETE', '/api/pages/:slug', { slug: 'missing' })
    assert.equal(notFound.status, 404)
    assert.equal(notFound.body['error'], 'not_found')
  } finally {
    h.dispose()
  }
})

/* ------------------ 3. 卸载语义（不留"仍可调用但已失效"） ------------------ */

test('wiki-service：卸载后 ctx.get 回到 undefined、路由摘除、旧引用调用显式报错', async () => {
  const h = await makeHarness()
  try {
    const svc = h.svc() // 卸载前先拿到引用（模拟"消费方仍持有旧引用"）
    await svc.save('p', { title: 't', content: 'c' })
    assert.equal(h.hasRoute('GET', '/api/pages'), true, '前置：卸载前路由已注册')

    h.unload()

    assert.equal(h.ctx.get('wiki-service'), undefined, '卸载后服务应注销')
    assert.equal(h.hasRoute('GET', '/api/pages'), false, '卸载后路由应摘除')
    assert.equal(h.hasRoute('PUT', '/api/pages/:slug'), false, '卸载后写路由也应摘除')
    assert.equal(h.adapter.query('SELECT id FROM pages').length, 1, '数据仍在（卸载不删数据）')

    // 旧引用不得静默返回空结果，而应显式报错
    assert.rejects(async () => (await svc.list(MEMBER)), /插件已卸载，wiki-service 不可再调用/)
    assert.rejects(async () => (await svc.get('p', MEMBER)), /插件已卸载，wiki-service 不可再调用/)
    assert.rejects(async () => (await svc.save('p', { title: 't', content: 'c' })), /插件已卸载，wiki-service 不可再调用/)
    assert.rejects(async () => (await svc.remove('p')), /插件已卸载，wiki-service 不可再调用/)
  } finally {
    h.dispose()
  }
})

test('真实 cordis：wiki-service 对兄弟插件可见，卸载后注销', async () => {
  // 为什么单独写一例：上面的 harness 用替身 ctx，只能证明"同 ctx 内 provide→get"。
  // 而消费方会是**另一个插件**（各自跑在 ctx.plugin() 的子 fiber 里）。
  // 这里用真实 cordis + 真实 ctx.plugin() 装配，证明跨插件可见性在生产路径上成立。
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiki-cordis-'))
  // 与其他夹具同源：0010（page_grants 的外键目标）+ 0012（P2 的可见性列）都必须加载，
  // 否则真实 cordis 那条路径上策略层会以"缺少可见性列"显式拒绝启动
  const adapter = new NodeSqliteAdapter(
    join(dir, 'test.db'),
    [
      ...SCHEMA_SQL_PATHS.map((p) => readFileSync(p, "utf8")),
      /*
       * ★ 种子一个用户。
       *
       * 为什么夹具需要它：`page_grants.granted_by` 与 `block_grants.granted_by` 都有
       * `REFERENCES users(id)`，而两个授予端点都会把 `principal.userId` 写进该列。
       * 夹具的 `MEMBER.userId = 1` 在库里必须真实存在，否则第一次授予就报
       * `FOREIGN KEY constraint failed` —— 报错点在 SQL 层，离“夹具缺种子”这个原因很远。
       * 生产里不会有这个问题（登录主体必然对应真实用户行）。
       */
      `INSERT INTO users (id, email, display_name, created_at)
       VALUES (1, 'member@example.com', 'Member', '2026-01-01T00:00:00Z');`,
      /*
       * ★ P3b：第二个用户 —— 申请访问用例里的「申请人」。
       * `access_requests.user_id` 有 `REFERENCES users(id)`，`APPLICANT.userId = 2`
       * 必须真实存在，否则申请插入报 `FOREIGN KEY constraint failed`。
       */
      `INSERT INTO users (id, email, display_name, created_at)
       VALUES (2, 'applicant@example.com', 'Applicant', '2026-01-01T00:00:00Z');`,
    ].join('\n'),
  )
  try {
    const routes = new Map<string, RouteHandler>()
    const routerService: HttpRouterService = {
      register: (method, path, handler) => {
        routes.set(`${method} ${path}`, handler)
        return () => routes.delete(`${method} ${path}`)
      },
      stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
      inflight: () => 0,
      pending: () => 0,
      drain: () => Promise.resolve(true),
    }

    const root = new CordisContext()
    root.provide('db', adapter)
    root.provide('http', routerService)

    // 生产路径：管理器就是 `await ctx.plugin(module, config)` 逐插件激活。
    // **先装真实的策略层**（不造假替身）：wiki 的读路径在 P2 起会向它要判定，
    // 用替身会把"权限规则真的接线了没有"这件事测掉。
    const authzFork = root.plugin(AuthzPlugin)
    await authzFork
    const fork = root.plugin(WikiPlugin, { recentVersions: 10 })
    await fork

    const svc = root.get('wiki-service') as WikiService | undefined
    assert.ok(svc, '真实 cordis 下 root.get 也应拿到 wiki-service')

    // 兄弟插件：模拟未来的消费方在自己的 apply 里 ctx.get('wiki-service')
    let seenBySibling: unknown = 'NOT_RUN'
    const sibling = {
      name: '@geewiki-test/wiki-consumer',
      apply(ctx: Context) {
        seenBySibling = ctx.get('wiki-service')
        return () => {}
      },
    }
    const siblingFork = root.plugin(sibling)
    await siblingFork // 生产里依赖插件先激活，故这里也 await 完成后再看
    assert.notEqual(seenBySibling, undefined, '兄弟插件必须能 ctx.get 到 wiki-service')
    assert.equal(seenBySibling, svc, '兄弟插件拿到的应是同一个服务实例')

    // 兄弟插件经服务写入，宿主侧端点能读到（跨插件经服务操作同一份数据）
    await svc.save('cross-plugin', { title: '跨插件', content: '正文' })
    assert.equal(adapter.query('SELECT COUNT(*) AS n FROM pages')[0]?.['n'], 1)

    // 卸载后对所有人注销
    await siblingFork.dispose()
    await fork.dispose()
    await authzFork.dispose()
    assert.equal(root.get('wiki-service'), undefined, '卸载后服务应注销')
    assert.equal(routes.has('GET /api/pages'), false, '卸载后路由应摘除')
  } finally {
    adapter.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------------- 能力边界：异步数据库必须显式拒绝 ---------------------- */

/**
 * 为什么值得单测：wiki 的 ~15 处 db 调用是**同步**写法。若拿异步适配器（PostgreSQL）
 * 静默放行，插件会正常启动、但每个接口都读不到数据 —— "能启动但全是空的"是最难排查的
 * 一类故障。故这里钉住"必须抛错、且错误里要给出可执行指引"。
 */
/*
 * 本用例守护**本批的核心契约变更**：`@geewiki/wiki` 从"异步适配器下拒绝启动"
 * 改为"两种驱动都能跑"。
 *
 * 为什么用真实 SQLite + `asAsync` 而不是手写异步替身：PG 起不了单测，但
 * `asAsync(sync)` 产出的正是 `isAsyncAdapter() === true` 的适配器，且其
 * `transaction` 走 **BEGIN/COMMIT/ROLLBACK 显式语句**——与 PG 版"必须用传入的 tx"
 * 是同一条代码路径。手写替身会绕过真实实现，测不出真问题。
 */
test('异步数据库适配器：wiki 正常激活并走通全部读写（不再拒绝启动）', async () => {
  const h = await makeHarness({ asyncDb: true })
  try {
    // 前置：确实拿到了异步适配器（否则本用例会退化成"又测了一遍同步路径"）
    const db = h.services.get('db') as { kind?: string; dialect?: string }
    assert.equal(db.kind, 'async', '前置：交给插件的必须是异步适配器')
    assert.equal(db.dialect, 'sqlite', '方言由 asAsync 从同步适配器继承')

    // 写入 → 读回（走 asAsync 的异步 query/run）
    const put = await h.call('PUT', '/api/pages/:slug', { slug: 'async-p' }, { title: '异步', content: 'v1' })
    assert.equal(put.status, 200)
    assert.equal(put.body['outcome'], 'created')

    const got = await h.call('GET', '/api/pages/:slug', { slug: 'async-p' })
    assert.equal(got.status, 200)
    assert.equal(got.body['title'], '异步')
    assert.equal(got.body['content'], 'v1')

    // 更新 → 版本历史（事务：快照旧正文 + 更新页面 + 重建出链，三步须同生共死）
    const put2 = await h.call('PUT', '/api/pages/:slug', { slug: 'async-p' }, { title: '异步', content: 'v2' })
    assert.equal(put2.body['outcome'], 'updated')
    assert.equal(put2.body['version'], 2, '第二次保存应产生 1 条历史 ⇒ version=2')

    // 反向链接（依赖事务内重建的 page_links）
    await h.call('PUT', '/api/pages/:slug', { slug: 'async-q' }, { title: '目标', content: '目标' })
    await h.call('PUT', '/api/pages/:slug', { slug: 'async-p' }, { title: '异步', content: '见 [目标](/wiki/async-q)' })
    const bl = await h.call('GET', '/api/pages/:slug/backlinks', { slug: 'async-q' })
    assert.equal(bl.status, 200)
    assert.deepEqual(
      (bl.body['backlinks'] as { slug: string }[]).map((b) => b.slug),
      ['async-p'],
      '异步路径下反向链接也必须建得起来（证明事务内的 rebuildLinks 生效）',
    )

    // 服务方法同样可用（与端点共用实现）
    assert.ok((await h.svc().get('async-p', MEMBER)), '异步适配器下 wiki-service 也应可用')
  } finally {
    h.dispose()
  }
})

/*
 * 本用例守护**只在 PostgreSQL 下才会暴露**的类型缺陷（真实 PG 实测发现）：
 * `pg` 把 `COUNT(*)`（int8）作为**字符串**返回，而 better-sqlite3 返回数字。
 * 修复前 `version: totalVersions.n + 1` 在 PG 下退化为**字符串拼接**：
 * 新建 → `"0"+1 = "01"`、更新 → `"1"+1 = "11"`，即响应里的 version 静默变成字符串。
 *
 * 为什么必须专门模拟：用 sqlite 跑，两条路径都返回数字，**测不出任何差异**——
 * 这正是"能启动、能返回、但契约悄悄变了"的那类故障。
 */
test('pg 把 COUNT(*) 返回为字符串时，version 仍是数字（PG 实测发现的类型缺陷）', async () => {
  const h = await makeHarness({ pgBigintAsString: true })
  try {
    const put = await h.call('PUT', '/api/pages/:slug', { slug: 'v' }, { title: 'V', content: 'v1' })
    assert.equal(put.status, 200)
    assert.equal(put.body['version'], 1, 'version 必须是数字 1，而不是字符串 "01"')
    assert.equal(typeof put.body['version'], 'number', 'version 的类型必须是 number')

    const got = await h.call('GET', '/api/pages/:slug', { slug: 'v' })
    assert.equal(got.body['version'], 1)
    assert.equal(typeof got.body['version'], 'number', '详情里的 version 也必须是 number')

    // 更新一次 → 应有 1 条历史 ⇒ version = 2（修复前会是字符串 "11"）
    const put2 = await h.call('PUT', '/api/pages/:slug', { slug: 'v' }, { title: 'V', content: 'v2' })
    assert.equal(put2.body['version'], 2, 'version 必须是数字 2，而不是字符串 "11"')
    assert.equal(typeof put2.body['version'], 'number')

    const got2 = await h.call('GET', '/api/pages/:slug', { slug: 'v' })
    assert.equal(got2.body['version'], 2)
    assert.equal(typeof got2.body['version'], 'number')

    // 列表里的 version 同样必须是数字（该处原本已有 Number()，一并钉住防回归）
    const list = await h.call('GET', '/api/pages')
    const item = (list.body['pages'] as { version: unknown }[])[0]
    assert.equal(typeof item?.version, 'number', '列表里的 version 也必须是 number')
    assert.equal(item?.version, 2)

    // 服务方法与端点共用实现，故同样必须是数字
    const svcDetail = await h.svc().get('v', MEMBER)
    assert.equal(typeof svcDetail?.version, 'number')
  } finally {
    h.dispose()
  }
})

test('同步与异步两条路径：同一操作的响应逐字段一致（避免"只在一种驱动下对"）', async () => {
  const sync = await makeHarness()
  const asyn = await makeHarness({ asyncDb: true })
  try {
    const body = { title: '两驱动', content: '正文 [x](/wiki/nowhere)' }
    const a = await sync.call('PUT', '/api/pages/:slug', { slug: 'dual' }, body)
    const b = await asyn.call('PUT', '/api/pages/:slug', { slug: 'dual' }, body)
    assert.deepEqual(b.body, a.body, 'PUT 响应应逐字段一致（outcome/version 等）')

    const ga = await sync.call('GET', '/api/pages/:slug', { slug: 'dual' })
    const gb = await asyn.call('GET', '/api/pages/:slug', { slug: 'dual' })
    /*
     * created_at/updated_at 含时间戳，逐字段比对时用同步侧的值回填（两次独立运行，时刻必然不同）。
     *
     * ★ 0024：`blocks[].updatedAt` 是**同一个道理**下的第三处时间戳 —— 它是块级归属的时刻，
     * 也来自 `new Date().toISOString()`，故一并抹平再比。不抹平的话这条用例会以
     * "两个时刻差 2 毫秒"的形式失败，而那**不是**要验的东西（要验的是两条驱动路径
     * 给出的**字段与取值形态**一致：区间、gated、作者 id 与名字）。
     */
    const nullBlockTimes = (body: Record<string, unknown>): Record<string, unknown> => ({
      ...body,
      blocks: ((body['blocks'] as { updatedAt: string }[] | undefined) ?? []).map((x) => ({
        ...x,
        updatedAt: null,
      })),
    })
    assert.deepEqual(
      nullBlockTimes({ ...(gb.body as Record<string, unknown>), created_at: null, updated_at: null }),
      nullBlockTimes({ ...(ga.body as Record<string, unknown>), created_at: null, updated_at: null }),
      '详情响应除时间戳外应逐字段一致',
    )

    const la = await sync.call('GET', '/api/pages')
    const lb = await asyn.call('GET', '/api/pages')
    assert.deepEqual(
      (lb.body['pages'] as { updated_at: string }[]).map((p) => ({ ...p, updated_at: null })),
      (la.body['pages'] as { updated_at: string }[]).map((p) => ({ ...p, updated_at: null })),
      '列表响应除时间戳外应逐字段一致',
    )
  } finally {
    sync.dispose()
    asyn.dispose()
  }
})


/* =====================================================================
 * 反向链接（page_links）：抽取 → 存储 → 端点 的完整链路
 *
 * 抽取纯函数的边界用例在 links.test.ts；这里守的是**存储与端点语义**：
 * 重建而非追加、删除无遗留、404 语义。
 * =================================================================== */

/** 参数化路由按**模式**登记（`/api/pages/:slug`），故 path 传模式、实参走 params */
const P = '/api/pages/:slug'

/**
 * `node:sqlite` 返回的行是 **null 原型对象**，而 `assert.deepEqual`（strict）会比较原型，
 * 故断言前转成普通对象。生产路径经 `JSON.stringify` 不受影响，这里纯属测试比较细节。
 */
const plain = <T,>(rows: T[]): T[] => rows.map((r) => ({ ...r }))

test('backlinks：保存时按正文重建出链；改掉正文后旧边消失（重建而非追加）', async () => {
  const h = await makeHarness()
  try {
    await h.call('PUT', P, { slug: 'src' }, { title: '源页', content: '见 [甲](/wiki/a1) 与 [[a2]]' })
    await h.call('PUT', P, { slug: 'a1' }, { title: '甲页', content: '甲' })
    await h.call('PUT', P, { slug: 'a2' }, { title: '乙页', content: '乙' })

    const out1 = await h.call('GET', `${P}/links`, { slug: 'src' })
    assert.equal(out1.status, 200)
    assert.deepEqual(
      (out1.body['links'] as { slug: string }[]).map((l) => l.slug),
      ['a1', 'a2'],
    )
    assert.deepEqual(plain((await h.call('GET', `${P}/backlinks`, { slug: 'a1' })).body['backlinks'] as {
      slug: string
      title: string
    }[]), [{ slug: 'src', title: '源页' }])

    // 改掉正文：不再指向 a1
    await h.call('PUT', P, { slug: 'src' }, { title: '源页', content: '只链 [[a2]]' })
    assert.deepEqual(
      (await h.call('GET', `${P}/backlinks`, { slug: 'a1' })).body['backlinks'],
      [],
      '改掉出链后旧边必须被清掉',
    )
    assert.deepEqual(plain((await h.call('GET', `${P}/backlinks`, { slug: 'a2' })).body['backlinks'] as {
      slug: string
      title: string
    }[]), [{ slug: 'src', title: '源页' }])
  } finally {
    h.dispose()
  }
})

test('backlinks：删除页面时两侧都清（不留遗留边）', async () => {
  const h = await makeHarness()
  try {
    await h.call('PUT', P, { slug: 'p' }, { title: '引用方', content: '[目标](/wiki/t)' })
    await h.call('PUT', P, { slug: 't' }, { title: '目标页', content: '目标' })

    // 删引用方 → 目标的反向链接空
    await h.call('DELETE', P, { slug: 'p' })
    assert.deepEqual((await h.call('GET', `${P}/backlinks`, { slug: 't' })).body['backlinks'], [])

    // 重建引用方；再删目标 → 引用方的出链也应空（目标侧的边被清）
    await h.call('PUT', P, { slug: 'p' }, { title: '引用方', content: '[目标](/wiki/t)' })
    await h.call('DELETE', P, { slug: 't' })
    assert.deepEqual((await h.call('GET', `${P}/links`, { slug: 'p' })).body['links'], [])
  } finally {
    h.dispose()
  }
})

test('backlinks：指向尚未创建的页面是合法的（title 为 null）', async () => {
  const h = await makeHarness()
  try {
    await h.call('PUT', P, { slug: 'host' }, { title: '宿主', content: '[未来页](/wiki/ghost)' })
    assert.deepEqual(
      plain((await h.call('GET', `${P}/links`, { slug: 'host' })).body['links'] as {
        slug: string
        title: string | null
      }[]),
      // ★ P2：出链新增 `exists` 三步态 —— ghost 不存在 ⇒ false（红链，可引导创建）。
      // 注意它**不是** 'hidden'：那表示"存在但你看不到"，两者绝不可混（否则红链功能失效）
      [{ slug: 'ghost', title: null, exists: false }],
    )
    // ghost 不存在 → 其 backlinks 是 404（"页面不存在"与"存在但没人链接"必须可区分）
    assert.equal((await h.call('GET', `${P}/backlinks`, { slug: 'ghost' })).status, 404)
  } finally {
    h.dispose()
  }
})

test('backlinks：不存在的页面返回 404，与详情端点同语义', async () => {
  const h = await makeHarness()
  try {
    for (const suffix of ['/backlinks', '/links']) {
      const r = await h.call('GET', `${P}${suffix}`, { slug: 'nope' })
      assert.equal(r.status, 404, `${suffix} 应为 404`)
      assert.equal(r.body['error'], 'not_found')
    }
  } finally {
    h.dispose()
  }
})

test('backlinks：wiki-service 的两个新方法与端点结果一致', async () => {
  const h = await makeHarness()
  try {
    await h.call('PUT', P, { slug: 'x' }, { title: '甲', content: '[乙](/wiki/y)' })
    await h.call('PUT', P, { slug: 'y' }, { title: '乙', content: '乙' })
    const svc = h.svc()
    // ★ P2：出链新增 `exists` 字段（§5.5 的三步态）；"存在且可见" 即 true
    assert.deepEqual(plain((await svc.links('x', MEMBER))!), [{ slug: 'y', title: '乙', exists: true }])
    assert.deepEqual(plain((await svc.backlinks('y', MEMBER))!), [{ slug: 'x', title: '甲' }])
    assert.equal((await svc.links('nope', MEMBER)), undefined)
    assert.equal((await svc.backlinks('nope', MEMBER)), undefined)
  } finally {
    h.dispose()
  }
})

/* ------------------------------ 块级授予端点（P3b） ------------------------------ */

/**
 * 这一组钉三件事：**治理视图不泄漏正文**、**授予闭环可用**、**组合式越权口被堵住**。
 *
 * 第三条尤其值得单独测：只校验"页可管"与"块存在"而不校验**隶属关系**，会留下
 * "拿 A 页的 slug 配 B 页的 blockId"的绕过（§9 R10 第 4 条引的正是这种形态）。
 * 这类洞单看每一处校验都是对的，只有把两个参数**组合**起来才暴露。
 */
test('P3b：块级治理视图不返回正文，且 granted 块的 tier 为 null', async () => {
  const h = await makeHarness()
  try {
    const put = await h.call(
      'PUT',
      '/api/pages/:slug',
      { slug: 'bp1' },
      { title: 'A', content: '公开段\n\n<!--gated:granted-->\n运维备注A\n<!--/gated-->' },
    )
    assert.equal(put.status, 200)

    const list = await h.call('GET', '/api/pages/:slug/blocks', { slug: 'bp1' })
    assert.equal(list.status, 200)
    const blocks = list.body['blocks'] as Array<Record<string, unknown>>
    assert.equal(blocks.length, 2)
    for (const b of blocks) {
      assert.ok(!('text' in b), '治理视图**不得**返回块正文（否则它是 granted 块的读取旁路）')
    }
    const granted = blocks.find((b) => b['visibility'] === 'granted')
    assert.ok(granted, '应有一个 granted 块')
    assert.equal(granted['tier'], null, 'granted 档不进等级索引 ⇒ tier 必须是 null')
    assert.deepEqual(granted['grants'], [], '尚未授予时授权列表为空')
  } finally {
    h.dispose()
  }
})

test('P3b：块级授予闭环（授予 → 可见 → 撤销），且组合式越权口被封', async () => {
  const h = await makeHarness()
  try {
    for (const slug of ['bp1', 'bp2']) {
      const put = await h.call(
        'PUT',
        '/api/pages/:slug',
        { slug },
        { title: slug, content: `公开段\n\n<!--gated:granted-->\n备注-${slug}\n<!--/gated-->` },
      )
      assert.equal(put.status, 200)
    }
    const listOf = async (slug: string): Promise<Array<Record<string, unknown>>> => {
      const r = await h.call('GET', '/api/pages/:slug/blocks', { slug })
      assert.equal(r.status, 200)
      return r.body['blocks'] as Array<Record<string, unknown>>
    }
    const grantedOf = async (slug: string): Promise<Record<string, unknown>> => {
      const b = (await listOf(slug)).find((x) => x['visibility'] === 'granted')
      assert.ok(b, `${slug} 应有一个 granted 块`)
      return b
    }

    const a = await grantedOf('bp1')
    const post = await h.call(
      'POST',
      '/api/pages/:slug/blocks/:blockId/grants',
      { slug: 'bp1', blockId: String(a['id']) },
      { subjectKind: 'user', subjectId: '7', role: 'viewer' },
    )
    assert.equal(post.status, 200)
    assert.ok(Number(post.body['acl_revision']) >= 1, '变更后 acl_revision 必须递增（代际失效）')

    const after = await grantedOf('bp1')
    const grants = after['grants'] as Array<Record<string, unknown>>
    assert.equal(grants.length, 1)
    assert.equal(grants[0]?.['subjectKind'], 'user')
    assert.equal(grants[0]?.['subjectId'], '7')

    // ★ 组合式越权口：拿 bp1 的 slug（自己有管理权）配 bp2 的 blockId
    const bBlock = await grantedOf('bp2')
    const cross = await h.call(
      'POST',
      '/api/pages/:slug/blocks/:blockId/grants',
      { slug: 'bp1', blockId: String(bBlock['id']) },
      { subjectKind: 'user', subjectId: '9', role: 'viewer' },
    )
    assert.equal(cross.status, 404, '不得用 A 页的 slug 操作 B 页的块')
    assert.deepEqual((await grantedOf('bp2'))['grants'], [], 'B 页的块不应被加上授权')

    // ★ D13：角色不是授权对象
    const badKind = await h.call(
      'POST',
      '/api/pages/:slug/blocks/:blockId/grants',
      { slug: 'bp1', blockId: String(a['id']) },
      { subjectKind: 'org_role', subjectId: 'member', role: 'viewer' },
    )
    assert.equal(badKind.status, 400)
    assert.equal(badKind.body['error'], 'invalid_subject_kind')

    // 撤销
    const del = await h.call('DELETE', '/api/pages/:slug/blocks/:blockId/grants/:grantId', {
      slug: 'bp1',
      blockId: String(a['id']),
      grantId: String(grants[0]?.['id']),
    })
    assert.equal(del.status, 200)
    assert.deepEqual((await grantedOf('bp1'))['grants'], [])
  } finally {
    h.dispose()
  }
})

/* ------------------ P3b：申请访问（★ 本批） ------------------ */

/** 建一个 `private` 页：`APPLICANT`（普通成员）对它没有访问权，只有 admin 档能管。 */
async function makePrivatePage(h: Harness, slug: string, content: string): Promise<void> {
  const put = await h.call('PUT', '/api/pages/:slug', { slug }, { title: slug, content }, OWNER)
  assert.equal(put.status, 200)
  const vis = await h.call('PUT', '/api/pages/:slug/visibility', { slug }, { visibility: 'private' }, OWNER)
  assert.equal(vis.status, 200)
}

test('P3b：申请访问闭环 —— 甲申请、乙批准，批准后甲**无需重新登录**即可见', async () => {
  const h = await makeHarness()
  try {
    await makePrivatePage(h, 'req1', 'secret-A')

    // 前置状态断言：申请人此刻**读不到**。没有这一条，"批准后能读"可能本来就是绿的（假绿）。
    const before = await h.call('GET', '/api/pages/:slug', { slug: 'req1' }, undefined, APPLICANT)
    assert.equal(before.status, 404, '前置状态必须是"读不到"，否则下面的"批准后可见"是假绿')

    // 申请
    const apply = await h.call(
      'POST',
      '/api/pages/:slug/access-requests',
      { slug: 'req1' },
      { message: '请给我看', role: 'viewer' },
      APPLICANT,
    )
    assert.equal(apply.status, 200)
    assert.equal(apply.body['status'], 'pending')
    const reqId = Number(apply.body['id'])
    assert.ok(reqId >= 1, '申请响应必须带 id（客户端要用它撤回）')

    // 同一人重复申请 ⇒ 409（唯一键 (page_slug,user_id,status)）
    const dup = await h.call('POST', '/api/pages/:slug/access-requests', { slug: 'req1' }, {}, APPLICANT)
    assert.equal(dup.status, 409)
    assert.equal(dup.body['error'], 'already_requested')

    // 已有权限的人申请 ⇒ 409（否则待审列表会被无意义条目灌满）
    const ownerApply = await h.call('POST', '/api/pages/:slug/access-requests', { slug: 'req1' }, {}, OWNER)
    assert.equal(ownerApply.status, 409)
    assert.equal(ownerApply.body['error'], 'already_has_access')

    // 匿名不能申请（判据是"已登录的真实用户"）
    const anon = await h.call(
      'POST',
      '/api/pages/:slug/access-requests',
      { slug: 'req1' },
      {},
      anonymousPrincipal(),
    )
    assert.equal(anon.status, 401)

    // 审批人看到待审列表
    const list = await h.call('GET', '/api/pages/:slug/access-requests', { slug: 'req1' }, undefined, OWNER)
    assert.equal(list.status, 200)
    const reqs = list.body['requests'] as Array<Record<string, unknown>>
    assert.equal(reqs.length, 1)
    assert.equal(Number(reqs[0]?.['userId']), 2, '申请人应是 APPLICANT')
    assert.equal(reqs[0]?.['message'], '请给我看')
    assert.equal(reqs[0]?.['status'], 'pending')

    // 批准
    const approve = await h.call(
      'POST',
      '/api/pages/:slug/access-requests/:id/approve',
      { slug: 'req1', id: String(reqId) },
      { role: 'viewer' },
      OWNER,
    )
    assert.equal(approve.status, 200)
    assert.ok(
      Number(approve.body['acl_revision']) >= 1,
      '批准必须递增 acl_revision —— 代际失效（不是 TTL）正是"无需重新登录"的机制',
    )

    // ★ 核心验收：申请人**无需重新登录**即可见（同一条会话、同一个 principal 值）
    const after = await h.call('GET', '/api/pages/:slug', { slug: 'req1' }, undefined, APPLICANT)
    assert.equal(after.status, 200, '批准后申请人无需重新登录即可见')
    assert.equal(after.body['content'], 'secret-A')

    // 待审列表清空（该条已不是 pending）
    const list2 = await h.call('GET', '/api/pages/:slug/access-requests', { slug: 'req1' }, undefined, OWNER)
    assert.deepEqual(list2.body['requests'], [])

    // 重复裁决 ⇒ 409（不是静默成功）
    const again = await h.call(
      'POST',
      '/api/pages/:slug/access-requests/:id/approve',
      { slug: 'req1', id: String(reqId) },
      {},
      OWNER,
    )
    assert.equal(again.status, 409)
    assert.equal(again.body['error'], 'request_not_pending')
  } finally {
    h.dispose()
  }
})

test('P3b：拒绝 → 仍不可见且**可再次申请**；撤回仅限本人；跨页裁决 404', async () => {
  const h = await makeHarness()
  try {
    await makePrivatePage(h, 'req2', 'secret-B')
    await makePrivatePage(h, 'req3', 'secret-C')

    // 甲在 req2 上申请并被拒
    const a1 = await h.call('POST', '/api/pages/:slug/access-requests', { slug: 'req2' }, {}, APPLICANT)
    assert.equal(a1.status, 200)
    const id1 = Number(a1.body['id'])
    const deny = await h.call(
      'POST',
      '/api/pages/:slug/access-requests/:id/deny',
      { slug: 'req2', id: String(id1) },
      undefined,
      OWNER,
    )
    assert.equal(deny.status, 200)

    // 拒绝**不动**授权 ⇒ 仍然读不到
    const stillBlocked = await h.call('GET', '/api/pages/:slug', { slug: 'req2' }, undefined, APPLICANT)
    assert.equal(stillBlocked.status, 404, '拒绝不应让申请人获得任何访问权')

    /*
     * ★ 唯一键含 `status` 的意义：被拒之后**可以再次申请**（情形会变）。
     * 若唯一键只有 (page_slug,user_id)，这里会撞唯一约束而永远申请不了。
     */
    const again = await h.call('POST', '/api/pages/:slug/access-requests', { slug: 'req2' }, {}, APPLICANT)
    assert.equal(again.status, 200, '被拒之后必须能再次申请')
    const id2 = Number(again.body['id'])
    assert.notEqual(id2, id1, '应是一条新请求，而不是复用旧行')

    // 撤回只能撤自己的：OWNER 撤 APPLICANT 的 ⇒ 404（不泄露"这里有一条别人的申请"）
    const foreign = await h.call(
      'POST',
      '/api/pages/:slug/access-requests/:id/withdraw',
      { slug: 'req2', id: String(id2) },
      undefined,
      OWNER,
    )
    assert.equal(foreign.status, 404)
    // 本人撤回 ⇒ 200
    const own = await h.call(
      'POST',
      '/api/pages/:slug/access-requests/:id/withdraw',
      { slug: 'req2', id: String(id2) },
      undefined,
      APPLICANT,
    )
    assert.equal(own.status, 200)
    // 撤回后待审列表为空
    const list = await h.call('GET', '/api/pages/:slug/access-requests', { slug: 'req2' }, undefined, OWNER)
    assert.deepEqual(list.body['requests'], [])

    // ★ 组合式越权：拿 req2 的申请 id 去 req3 上批 —— 必须 404
    const a3 = await h.call('POST', '/api/pages/:slug/access-requests', { slug: 'req3' }, {}, APPLICANT)
    assert.equal(a3.status, 200)
    const id3 = Number(a3.body['id'])
    const cross = await h.call(
      'POST',
      '/api/pages/:slug/access-requests/:id/approve',
      { slug: 'req2', id: String(id3) },
      {},
      OWNER,
    )
    assert.equal(cross.status, 404, '不得用 A 页的申请 id 去批 B 页的申请')
    // 且 req3 的申请**仍是 pending**（越权尝试不得产生副作用）
    const list3 = await h.call('GET', '/api/pages/:slug/access-requests', { slug: 'req3' }, undefined, OWNER)
    assert.equal((list3.body['requests'] as unknown[]).length, 1)

    // 非 admin 档对 private 页没有 canManageVisibility ⇒ 连列表都看不到（404，不是 403）
    const memberList = await h.call('GET', '/api/pages/:slug/access-requests', { slug: 'req3' }, undefined, MEMBER)
    assert.equal(memberList.status, 404)
  } finally {
    h.dispose()
  }
})

/* ------------------ P3c：块级版本与恢复（★ 本批） ------------------ */

test('P3c：改权限**必须**产生新版本；恢复四位一体（正文 + 块级权限 + visibility + published_at + inherit）', async () => {
  const h = await makeHarness()
  try {
    const content = '公开A\n\n<!--gated:org-->\n机密B\n<!--/gated-->'
    const put = await h.call('PUT', '/api/pages/:slug', { slug: 'vc1' }, { title: 'V1', content }, OWNER)
    assert.equal(put.status, 200)

    const versionsOf = async (): Promise<Array<{ id: number }>> => {
      const r = await h.call('GET', '/api/pages/:slug', { slug: 'vc1' }, undefined, OWNER)
      assert.equal(r.status, 200)
      return r.body['versions'] as Array<{ id: number }>
    }
    const blocksOf = async (): Promise<Array<Record<string, unknown>>> => {
      const r = await h.call('GET', '/api/pages/:slug/blocks', { slug: 'vc1' }, undefined, OWNER)
      assert.equal(r.status, 200)
      return r.body['blocks'] as Array<Record<string, unknown>>
    }
    /*
     * 页面档位**没有 GET 端点**（只有 `PUT /visibility`）⇒ 用可观测行为断言档位：
     * `org` 档普通成员读得到、`private` 档读不到。这比读一个字段更接近"用户实际看到什么"。
     */
    const applicantCanRead = async (): Promise<boolean> => {
      const r = await h.call('GET', '/api/pages/:slug', { slug: 'vc1' }, undefined, APPLICANT)
      return r.status === 200
    }

    const before = { versions: (await versionsOf()).length, blocks: await blocksOf() }
    assert.equal(await applicantCanRead(), true, '新建条目应用层默认是 org ⇒ 普通成员可读')
    assert.equal(before.blocks.length, 2)
    assert.equal(before.blocks[1]?.['visibility'], 'org', '受限块是 org 档')

    /*
     * ★ 只改 `visibility`、**完全不碰正文** ⇒ 必须仍产生一条新版本。
     * 否则版本里的权限快照会与实际权限脱节，「恢复此版本」就会恢复出**错误的（可能是放宽的）权限** ——
     * 这正是 0017 迁移里那条规则的由来。
     */
    const vis = await h.call(
      'PUT',
      '/api/pages/:slug/visibility',
      { slug: 'vc1' },
      { visibility: 'private' },
      OWNER,
    )
    assert.equal(vis.status, 200)
    const afterChange = await versionsOf()
    assert.equal(
      afterChange.length,
      before.versions + 1,
      '改权限**必须**产生新版本（content 不变、只有 acl_json/blocks_json 变）',
    )

    // 此刻是 private ⇒ 普通成员读不到（前置状态，防下面的"恢复后能读"假绿）
    const blockedNow = await h.call('GET', '/api/pages/:slug', { slug: 'vc1' }, undefined, APPLICANT)
    assert.equal(blockedNow.status, 404)

    /*
     * 最新那条版本 = **改档位之前**的状态（约定："先快照旧的，再改"）⇒ 恢复它应当回到 org。
     */
    const restoreTarget = afterChange[0]?.id
    assert.ok(restoreTarget, '应能取到版本 id')
    const restore = await h.call(
      'POST',
      '/api/pages/:slug/versions/:id/restore',
      { slug: 'vc1', id: String(restoreTarget) },
      undefined,
      OWNER,
    )
    assert.equal(restore.status, 200)
    assert.deepEqual(restore.body['warnings'], [], '新版本恢复不应有 warnings')

    // ★ 四位一体之一：页面 visibility 回来了（用"普通成员又能读"作为可观测证据）
    assert.equal(await applicantCanRead(), true, '恢复必须包含页面 visibility（回到 org ⇒ 成员可读）')
    // ★ 之一：块级权限回来了（含 ordinal 与 visibility）
    const restoredBlocks = await blocksOf()
    assert.equal(restoredBlocks.length, 2)
    assert.equal(restoredBlocks[1]?.['visibility'], 'org', '恢复必须包含块级可见性')
    assert.equal(Number(restoredBlocks[1]?.['ordinal']), 1)
    // ★ 之一：正文回来了
    const detail = await h.call('GET', '/api/pages/:slug', { slug: 'vc1' }, undefined, APPLICANT)
    assert.equal(detail.status, 200, '恢复回 org 后，普通成员应当又能读到')
    /*
     * 注意期望值是**去掉 gated 标记**后的形态：标记是**语法**（区段分隔符），不是内容 ——
     * `ParsedBlock.text` 的注释即此意，读路径返回的是块投影而非 `pages.content` 原文。
     * 所以这里断言"标记被剥掉、正文在"，而不是断言与 `pages.content` 逐字相等。
     */
    assert.equal(detail.body['content'], '公开A\n\n机密B', '恢复必须包含正文（gated 标记按语法剥掉）')

    // ★ 恢复**本身**也记一条版本 ⇒ 可逆
    assert.equal((await versionsOf()).length, afterChange.length + 1, '恢复本身应产生一条版本（使其可逆）')
  } finally {
    h.dispose()
  }
})

test('P3c：老版本只恢复正文并带 warnings；含 granted 块的版本对 member 403；超大快照 413；非 canEdit 读历史 404', async () => {
  const h = await makeHarness()
  try {
    const content = '公开A\n\n<!--gated:org-->\n机密B\n<!--/gated-->'
    await h.call('PUT', '/api/pages/:slug', { slug: 'vc2' }, { title: 'V2', content }, OWNER)
    const pageId = Number(
      (h.adapter.query('SELECT id FROM pages WHERE slug = ?', ['vc2']) as Array<{ id: number }>)[0]?.id,
    )
    assert.ok(pageId >= 1)

    /* ---- ① 老版本（blocks_json IS NULL）：只恢复正文 + warnings ---- */
    const legacy = h.adapter.run(
      'INSERT INTO page_versions (page_id, content, saved_at) VALUES (?, ?, ?)',
      [pageId, '这是块级功能之前的正文', '2026-01-01T00:00:00Z'],
    )
    const legacyId = Number(legacy.lastInsertRowid)
    assert.ok(legacyId >= 1)
    const r1 = await h.call(
      'POST',
      '/api/pages/:slug/versions/:id/restore',
      { slug: 'vc2', id: String(legacyId) },
      undefined,
      OWNER,
    )
    assert.equal(r1.status, 200)
    assert.deepEqual(
      r1.body['warnings'],
      ['block_acls_not_restored'],
      '老版本恢复必须**显式告知**块级权限未恢复，绝不猜测当时的权限',
    )
    const afterLegacy = await h.call('GET', '/api/pages/:slug', { slug: 'vc2' }, undefined, OWNER)
    assert.equal(afterLegacy.body['content'], '这是块级功能之前的正文')

    /* ---- ② 非 canEdit 读历史 ⇒ 404（历史含 ACL 结构，投影它等于泄漏） ---- */
    /*
     * 用**匿名**而不是 `APPLICANT`：`APPLICANT` 是组织成员，对 `org` 档页面**本来就有
     * `canEdit`** ⇒ 他读历史返回 200 是正确的（历史对**编辑者**开放）。要验的是
     * "没有编辑权的人"这条闸门，所以取一个明确无编辑权的主体。
     */
    const anonRead = await h.call(
      'GET',
      '/api/pages/:slug/versions/:id',
      { slug: 'vc2', id: String(legacyId) },
      undefined,
      anonymousPrincipal(),
    )
    assert.equal(anonRead.status, 404, '非 canEdit 一律 404（不能靠 403/404 之差探测历史）')

    /* ---- ③ 含 granted 块的版本：member（rank 1）不得恢复 ⇒ 403 + blockedOrdinals ---- */
    await h.call(
      'PUT',
      '/api/pages/:slug',
      { slug: 'vc3' },
      { title: 'V3', content: '公开\n\n<!--gated:granted-->\n仅授权可见\n<!--/gated-->' },
      OWNER,
    )
    // 触发一次权限变更以留下含 granted 块的版本
    await h.call('PUT', '/api/pages/:slug/visibility', { slug: 'vc3' }, { visibility: 'org' }, OWNER)
    const v3versions = await h.call('GET', '/api/pages/:slug', { slug: 'vc3' }, undefined, OWNER)
    const v3id = (v3versions.body['versions'] as Array<{ id: number }>)[0]?.id
    assert.ok(v3id, 'vc3 应有版本')
    const asMember = await h.call(
      'POST',
      '/api/pages/:slug/versions/:id/restore',
      { slug: 'vc3', id: String(v3id) },
      undefined,
      MEMBER,
    )
    assert.equal(asMember.status, 403, '含 granted 块的版本：普通 member 不得恢复')
    const blocked = (asMember.body['details'] as Record<string, unknown>)['blockedOrdinals'] as number[]
    assert.deepEqual(blocked, [1], '应列出违规块的 ordinal')
    // owner 可以（admin 档 rank 2）
    const asOwner = await h.call(
      'POST',
      '/api/pages/:slug/versions/:id/restore',
      { slug: 'vc3', id: String(v3id) },
      undefined,
      OWNER,
    )
    assert.equal(asOwner.status, 200, 'owner 属 admin 档，应能恢复含 granted 块的版本')

    /* ---- ④ 超大快照 ⇒ 413（不是截断） ---- */
    const huge = JSON.stringify([{ o: 0, k: 'paragraph', t: 'x'.repeat(1_100_000), v: 'public', i: 1, m: null }])
    const bigRow = h.adapter.run(
      'INSERT INTO page_versions (page_id, content, saved_at, blocks_json, acl_json) VALUES (?, ?, ?, ?, ?)',
      [pageId, 'x', '2026-01-01T00:00:00Z', huge, '{"visibility":"org","inherit":1,"published_at":null,"page_grants":[],"block_grants":[]}'],
    )
    const bigId = Number(bigRow.lastInsertRowid)
    const r4 = await h.call(
      'POST',
      '/api/pages/:slug/versions/:id/restore',
      { slug: 'vc2', id: String(bigId) },
      undefined,
      OWNER,
    )
    assert.equal(r4.status, 413, '快照超限必须显式 413，绝不能截断后恢复出残缺正文')
    assert.equal(r4.body['error'], 'snapshot_too_large')
  } finally {
    h.dispose()
  }
})

/*
 * ------------------ P3c 恢复路径的 tier 扇出（★ 独立审查查出的 Critical） ------------------
 *
 * 恢复会写 `pages` 的**档位列**（`visibility` / `inherit` / `published_at`），因而会改掉本页的
 * **有效档位**；而子孙的 `blocks.tier` 是**物化派生列**（`pageLevelOf` 只决定本页）。
 * 漏掉扇出的后果是**内容泄漏级**：把祖先从 public **恢复成 private** 后，子页的读路径已 404，
 * 但它的 `tier` 仍是旧值 `0` ⇒ **匿名 `/api/search` 仍命中并吐出正文片段**；
 * 反方向（放宽）则退化为"搜不到但读得到"。
 *
 * **为什么既有用例抓不到**：它们只断言被恢复的那一页本身，没有子页。
 * 这里断言**子页的 `blocks.tier`** —— 它是检索判定的直接输入，也是根因所在。
 */
test('P3c：恢复祖先的档位必须重算子孙的 blocks.tier（否则读路径已 404 而检索仍吐正文）', async () => {
  const h = await makeHarness()
  try {
    const tierOf = (slug: string): unknown => {
      const rows = h.adapter.query<{ tier: unknown }>(
        'SELECT b.tier AS tier FROM blocks b JOIN pages p ON p.id = b.page_id WHERE p.slug = ? ORDER BY b.ordinal',
        [slug],
      )
      assert.ok(rows.length > 0, `${slug} 应有块行`)
      return rows[0]?.['tier']
    }
    const setVis = async (slug: string, body: Record<string, unknown>): Promise<void> => {
      const r = await h.call('PUT', '/api/pages/:slug/visibility', { slug }, body, OWNER)
      assert.equal(r.status, 200, `${slug} 设可见性 ${JSON.stringify(body)} 应成功`)
    }

    /* ---- ① 造出「祖先曾是 private」的那个版本快照 ---- */
    // 建页 ⇒ 应用层默认 org
    assert.equal(
      (await h.call('PUT', '/api/pages/:slug', { slug: 'anc' }, { title: 'A', content: '祖先正文' }, OWNER)).status,
      200,
    )
    // org → private（这一步快照的是 org）
    await setVis('anc', { visibility: 'private' })
    /*
     * private → public + 已发布：**这一步快照的是 private 状态**（约定"先快照旧的，再改"）。
     * 下面要恢复的就是它 ⇒ 恢复后祖先应当回到 private。
     */
    await setVis('anc', { visibility: 'public', published: true })

    const privateVersionId = h.adapter.query<{ id: number }>(
      `SELECT v.id AS id FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE p.slug = ? AND v.acl_json LIKE '%"visibility":"private"%' ORDER BY v.id`,
      ['anc'],
    )[0]?.id
    assert.ok(privateVersionId, '应存在一条 visibility=private 的版本快照（前置）')

    /* ---- ② 子页 public + 已发布 ⇒ 有效档位 public ⇒ tier 0（匿名可搜） ---- */
    assert.equal(
      (
        await h.call(
          'PUT',
          '/api/pages/:slug',
          { slug: 'anc/child' },
          { title: 'C', content: '子页公开正文 CHILDMARK' },
          OWNER,
        )
      ).status,
      200,
    )
    await setVis('anc/child', { visibility: 'public', published: true })
    assert.equal(
      tierOf('anc/child'),
      0,
      '前置：祖先与子页都是 public + 已发布 ⇒ 子页 tier 应为 0（匿名可搜）—— 先证明前置，否则"变 null"可能是假绿',
    )

    /* ---- ③ 把祖先恢复到 private ⇒ 子页的读路径与检索**必须同时**被遮蔽 ---- */
    const restore = await h.call(
      'POST',
      '/api/pages/:slug/versions/:id/restore',
      { slug: 'anc', id: String(privateVersionId) },
      undefined,
      OWNER,
    )
    assert.equal(
      restore.status,
      200,
      `恢复应成功；实际响应: ${JSON.stringify(restore.body)}（node 的 assert 对 null/undefined 打印为空，故显式带上响应体）`,
    )
    // 数组必须用 deepEqual：`assert.equal` 比的是引用，`[] == []` 恒为假
    assert.deepEqual(restore.body['warnings'], [], '新版本恢复不应有 warnings')

    // 读路径：祖先变 private ⇒ 子页对匿名 404
    const anonRead = await h.call(
      'GET',
      '/api/pages/:slug',
      { slug: 'anc/child' },
      undefined,
      anonymousPrincipal(),
    )
    assert.equal(anonRead.status, 404, '祖先恢复成 private 后，子页读路径应对匿名 404')

    // ★ 检索判定的直接输入：子孙的 tier 必须跟着变成 null
    assert.equal(
      tierOf('anc/child'),
      null,
      '★ 恢复必须重算子孙 tier：否则读路径 404 而匿名检索仍按旧档位命中并吐正文（内容泄漏级）',
    )

    /* ---- ④ 扇出的可观测性：必须回传"确实重算了子孙"而不是沉默 ---- */
    assert.equal(restore.body['index_tiers_resync_failed'], false, '扇出不应失败')
    assert.ok(
      Number(restore.body['index_tiers_resynced']) >= 1,
      '应至少重算 1 个子孙（0 与"扇出失败"是两件处置不同的事，故两者都要断言）',
    )
  } finally {
    h.dispose()
  }
})


/* ------------------ ★ 原文模式：编辑路径的正文口径（本批） ------------------ */

/**
 * 回归守卫：**投影后的正文不能当原文用**。
 *
 * 背景（实测复现过的事故）：默认详情接口返回的是**按读者投影**后的正文 ——
 * `<!--gated:org-->` 这类标记被消费掉、受限段落对看不到的人变成占位。编辑页此前用的就是
 * 这份正文，于是"打开编辑页 → 改一个标点 → 保存"会把标记写没，受限段落**静默变成公开**
 * （复现路径：公开页 + org 受限段，保存后匿名访客能读到该段全文）。
 *
 * 故本批新增 `?content=raw`：把库里的原文交给**可编辑者**。这里钉住四件事：
 *   1. 默认口径仍然是投影（读者的正文里没有标记）—— 不能因为修编辑路径而改变读路径；
 *   2. 可编辑者拿得到原文（含标记），且响应自述 `contentMode === 'raw'`；
 *   3. 可读但不可编辑者拿不到原文，且是**显式 403**（不是 404：对他说"页面不存在"是撒谎）；
 *   4. 非法取值显式 400，不静默按投影处理（静默会让调用方以为拿到了原文）。
 */
test('★ 原文模式：?content=raw 只给可编辑者，默认口径仍是投影（投影事故的回归守卫）', async () => {
  const h = await makeHarness()
  try {
    const content = '公开A\n\n<!--gated:org-->\n机密B ORGRAW7788\n<!--/gated-->\n\n结尾'
    const put = await h.call('PUT', '/api/pages/:slug', { slug: 'raw1' }, { title: 'R', content }, OWNER)
    assert.equal(put.status, 200)

    // 1. 默认口径：投影后的正文（标记被消费）
    const proj = await h.call('GET', '/api/pages/:slug', { slug: 'raw1' }, undefined, OWNER)
    assert.equal(proj.status, 200)
    assert.equal(
      String(proj.body['content']).includes('<!--gated'),
      false,
      '默认口径必须是投影后的正文（读者的正文里不该出现标记）',
    )
    assert.equal(proj.body['contentMode'], undefined, '默认口径不应自称 raw')

    // 2. 可编辑者拿得到原文
    const raw = await h.call('GET', '/api/pages/:slug?content=raw', { slug: 'raw1' }, undefined, OWNER)
    assert.equal(raw.status, 200)
    assert.equal(raw.body['contentMode'], 'raw', '响应必须自述正文口径')
    assert.ok(String(raw.body['content']).includes('<!--gated:org-->'), '原文必须含标记')
    assert.ok(String(raw.body['content']).includes('ORGRAW7788'), '原文必须含受限段正文')

    /*
     * 3. 可读但不可编辑者：显式 403（不是 404，也不是静默降级成投影）。
     *
     * 这样的主体在模型里是**真实存在**的一类：`viewer` 例外授予给出 `level: 'full'`
     * 但 `canEdit: false`（见 plugin-authz 的 `decideNormally`：`canEdit: grant === 'editor'`）。
     * 组织成员**不能**拿来当反例 —— 他们对 `org` 档条目本来就有编辑权（`canEdit: true`）。
     */
    const granted = await h.call(
      'POST',
      '/api/pages/:slug/grants',
      { slug: 'raw1' },
      { subjectKind: 'user', subjectId: '2', role: 'viewer' },
      OWNER,
    )
    assert.equal(granted.status, 200, `前置：给用户 2 一条 viewer 授予（实际 ${granted.status}）`)
    const viewerRead = await h.call('GET', '/api/pages/:slug', { slug: 'raw1' }, undefined, APPLICANT)
    assert.equal(viewerRead.status, 200, '前置：viewer 授予下读得到这一页')
    const viewerCaps = viewerRead.body['capabilities'] as Record<string, unknown> | undefined
    assert.equal(viewerCaps?.['canEdit'], false, '前置：viewer 授予没有编辑权')
    const denied = await h.call('GET', '/api/pages/:slug?content=raw', { slug: 'raw1' }, undefined, APPLICANT)
    assert.equal(denied.status, 403, '可读但不可编辑者请求原文必须被拒')
    assert.equal(denied.body['error'], 'raw_requires_edit')
    assert.equal(denied.body['content'], undefined, '拒绝时不得带出任何正文')

    // 4. 非法取值：400（不静默按投影处理）
    const bad = await h.call('GET', '/api/pages/:slug?content=projected', { slug: 'raw1' }, undefined, OWNER)
    assert.equal(bad.status, 400)
    assert.equal(bad.body['error'], 'invalid_content_mode')
  } finally {
    h.unload()
  }
})


/* ============================== PAGE_SAVED_EVENT ============================== */

/*
 * 保存事件是"摘要跟着正文走"（需求 ③）的**唯一触发点**。它有三条契约，
 * 每一条失效的方式都是静默的：
 *  ① 内容没变时**不**广播 —— 否则每点一次保存都要花一次模型调用；
 *  ② 负载里**没有正文** —— 它是广播，所有订阅者（包括本不该看到这一页的插件）都收得到；
 *  ③ 订阅者抛错**不得**让保存失败 —— 一次已经写进库的保存返回 500，调用方重试就写两遍。
 *
 * 这里必须用**真实 cordis**（`ctx.emit` / `ctx.on` 是真实事件总线）：
 * 上面那套替身 ctx 连 `.on` 都没有——第一次写这几条用例时就撞上了这一点。
 */
async function makeEventHarness(): Promise<{
  root: Context
  adapter: NodeSqliteAdapter
  svc: WikiService
  dispose(): Promise<void>
}> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiki-evt-'))
  const adapter = new NodeSqliteAdapter(join(dir, 'test.db'), SCHEMA_SQL_PATHS.map((p) => readFileSync(p, 'utf8')).join('\n'))
  const routes = new Map<string, RouteHandler>()
  const routerService: HttpRouterService = {
    register: (method, path, handler) => {
      routes.set(`${method} ${path}`, handler)
      return () => routes.delete(`${method} ${path}`)
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => 0,
    pending: () => 0,
    drain: () => Promise.resolve(true),
  }
  const root = new CordisContext()
  root.provide('db', adapter)
  root.provide('http', routerService)
  const authzFork = root.plugin(AuthzPlugin)
  await authzFork
  const fork = root.plugin(WikiPlugin, { recentVersions: 5 })
  await fork
  return {
    root,
    adapter,
    svc: root.get('wiki-service') as WikiService,
    async dispose() {
      await fork.dispose()
      await authzFork.dispose()
      adapter.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('PAGE_SAVED_EVENT：真的写入时广播，内容未变时不广播', async () => {
  const h = await makeEventHarness()
  try {
    const seen: PageSavedEvent[] = []
    h.root.on(PAGE_SAVED_EVENT, (e: unknown) => seen.push(e as PageSavedEvent))

    await h.svc.save('evt', { title: '事件', content: '第一版' })
    assert.equal(seen.length, 1, '新建必须广播一次')
    assert.equal(seen[0]?.slug, 'evt')
    assert.equal(seen[0]?.outcome, 'created')
    assert.equal(seen[0]?.title, '事件')
    assert.equal(typeof seen[0]?.updatedAt, 'string', '负载必须带保存后的 updated_at（订阅者据此判版本）')
    assert.equal(seen[0]?.actorId, null, '经服务调用没有可归属的用户 ⇒ null，而不是编一个 id')

    // 一模一样地再存一次 ⇒ unchanged ⇒ 不广播（否则每次点保存都花钱重算摘要）
    await h.svc.save('evt', { title: '事件', content: '第一版' })
    assert.equal(seen.length, 1, 'unchanged 不得广播')

    await h.svc.save('evt', { title: '事件', content: '第二版' })
    assert.equal(seen.length, 2)
    assert.equal(seen[1]?.outcome, 'updated')
  } finally {
    await h.dispose()
  }
})

test('PAGE_SAVED_EVENT：负载里**不得**带正文', async () => {
  const h = await makeEventHarness()
  try {
    let payload: Record<string, unknown> | null = null
    h.root.on(PAGE_SAVED_EVENT, (e: unknown) => {
      payload = e as Record<string, unknown>
    })
    await h.svc.save('evt-body', { title: '事件', content: '机密正文' })
    assert.notEqual(payload, null)
    assert.deepEqual(
      Object.keys(payload as unknown as Record<string, unknown>).sort(),
      ['actorId', 'outcome', 'slug', 'title', 'updatedAt'],
      '负载的键是契约的一部分：多一个 content 就等于把正文广播给所有订阅者',
    )
  } finally {
    await h.dispose()
  }
})

test('PAGE_SAVED_EVENT：订阅者抛错**不得**让保存失败', async () => {
  const h = await makeEventHarness()
  try {
    h.root.on(PAGE_SAVED_EVENT, () => {
      throw new Error('订阅者故意抛错')
    })
    // 不抛、且内容真的写进去了（不是"看起来成功但回滚了"）
    await h.svc.save('evt-boom', { title: '事件', content: '正文' })
    const page = await h.svc.get('evt-boom', MEMBER)
    assert.equal(page?.content, '正文')
  } finally {
    await h.dispose()
  }
})


/* =====================================================================
 * ★ 0024 块级归属：**读侧对谁说什么**
 *
 * 这一组用例只有一件事要守：作者名对**谁**显示、对**谁**收着，以及"查不到"该怎么回。
 * 三档的分界写在 `blockAuthorFor` 的注释里，此处把它变成可执行的证据：
 *   · 登录主体（含普通成员）⇒ 真名 —— `GET /api/org/members` 本就对登录用户开放，
 *     显示真名不新增任何可枚举面；
 *   · 匿名访客 ⇒ `displayName: null`（界面显示「另一位成员」），与版本列表对匿名同款；
 *   · 没有可归属的主体 ⇒ `author: null`（界面**不显示任何归属**）。
 *
 * 为什么值得单独一组：这三档的差别**只体现在一个字段的取值上**，写错任何一档都不会报错，
 * 而错的方向要么是"匿名也能看到同事真名"（旁路），要么是"明明记了、却说得像没记"
 * （界面说假话）。两者都不会让任何既有用例变红。
 * ===================================================================== */

test('★ 0024：块级归属对登录主体回真名，对匿名回 displayName: null', async () => {
  const h = await makeHarness()
  try {
    // MEMBER（users.id = 1，display_name = 'Member'）经 HTTP 写入 ⇒ 块归到他名下
    const put = await h.call(
      'PUT',
      '/api/pages/:slug',
      { slug: 'attr' },
      { title: '归属', content: '第一段' },
      MEMBER,
    )
    assert.equal(put.status, 200)

    const asMember = await h.call('GET', '/api/pages/:slug', { slug: 'attr' }, undefined, MEMBER)
    const memberBlocks = asMember.body['blocks'] as Array<Record<string, unknown>>
    assert.equal(memberBlocks.length, 1)
    assert.deepEqual(memberBlocks[0]?.['author'], { id: 1, displayName: 'Member' }, '登录主体看真名')

    // 匿名要能看到这一页：设成 public + 已发布（未发布的 public 对任何人都不可见）
    const vis = await h.call(
      'PUT',
      '/api/pages/:slug/visibility',
      { slug: 'attr' },
      { visibility: 'public', published: true },
      OWNER,
    )
    assert.equal(vis.status, 200)

    const asAnon = await h.call(
      'GET',
      '/api/pages/:slug',
      { slug: 'attr' },
      undefined,
      anonymousPrincipal(),
    )
    assert.equal(asAnon.status, 200)
    const anonBlocks = asAnon.body['blocks'] as Array<Record<string, unknown>>
    assert.deepEqual(
      anonBlocks[0]?.['author'],
      { id: 1, displayName: null },
      '匿名访客只拿到 id：留 null 而不是抹掉 author —— 界面据此显示「另一位成员」，' +
        '那与「没有记录」是两件事',
    )
    // 区间与正文同源（客户端据此逐段对齐；对不上就整页不显示归属）
    assert.equal(
      (asAnon.body['content'] as string).slice(
        Number(anonBlocks[0]?.['start']),
        Number(anonBlocks[0]?.['end']),
      ),
      '第一段',
    )
  } finally {
    h.dispose()
  }
})

test('★ 0024：跨插件代调用写入的块 ⇒ author 为 null（无归属，而不是"未记录"的假记录）', async () => {
  const h = await makeHarness()
  try {
    // 服务路径不带主体（导入脚本 / 内置文档同步就是这条路径）
    await h.svc().save('attr-svc', { title: '服务写入', content: '一段正文' })

    const got = await h.call('GET', '/api/pages/:slug', { slug: 'attr-svc' }, undefined, MEMBER)
    const blocks = got.body['blocks'] as Array<Record<string, unknown>>
    assert.deepEqual(blocks[0]?.['author'], null, '没有可归属的主体 ⇒ null')
    /*
     * ★ 时间**是知道的**，不知道的只是"谁" —— 两者不是同一件事，契约必须能分开表达。
     *
     * 这个"半截信息"（有时刻、没作者）由**界面**兜住：`lib/blockMetaPlan.ts` 的
     * `blockMetaText` 在 `author === null` 时返回 `null` ⇒ 这一段**不显示任何标签**，
     * 而不是显示「最后由 编辑 · 3 天前」这种缺主语的话（用例见
     * `packages/web/test/blockMetaPlan.test.ts`）。
     */
    assert.equal(typeof blocks[0]?.['updatedAt'], 'string', '块确实是在这次写入里创建的 ⇒ 时刻可得')
    // 反空洞：正文与区间照常下发（"没有归属"不等于"这一页没有块信息"）
    assert.equal((got.body['content'] as string).slice(0, 2), '一段')
  } finally {
    h.dispose()
  }
})

test('★ 0024：受限块被裁剪后，占位段不下发作者（归属只覆盖读者看得见的段）', async () => {
  const h = await makeHarness()
  try {
    const content = ['公开段。', '', '<!--gated:granted-->', '运维备注。', '<!--/gated-->'].join('\n')
    const put = await h.call(
      'PUT',
      '/api/pages/:slug',
      { slug: 'attr-gated' },
      { title: '遮蔽', content },
      MEMBER,
    )
    assert.equal(put.status, 200)

    const asMember = await h.call('GET', '/api/pages/:slug', { slug: 'attr-gated' }, undefined, MEMBER)
    const blocks = asMember.body['blocks'] as Array<Record<string, unknown>>
    const gated = blocks.filter((b) => b['gated'] === true)
    assert.equal(gated.length, 1, '受限块应被合并成一个占位段')
    assert.equal(gated[0]?.['author'], null)
    assert.equal(gated[0]?.['updatedAt'], null)
    // 占位段**不得**泄露"它代表几个块"（分段方式是结构信息）
    assert.deepEqual(Object.keys(gated[0] ?? {}).sort(), ['author', 'end', 'gated', 'start', 'updatedAt'])
    // 可见段的归属照旧
    const visible = blocks.filter((b) => b['gated'] === false)
    assert.deepEqual(visible[0]?.['author'], { id: 1, displayName: 'Member' })
  } finally {
    h.dispose()
  }
})
