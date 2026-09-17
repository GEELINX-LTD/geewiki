/**
 * `@geewiki/ai-journal` —— AI 变更日志与回退（设计文档 §4，决策 3 + 10 + 11 + 13 + 14）。
 *
 * ## 它是什么，不是什么
 * **是**：一张表 + 一个回退执行器 + 一组端点。记下"AI 改了什么、改之前是什么"，
 * 并在用户要求时按轮倒序撤销。
 * **不是**：它不认识任何业务域。页面怎么改回去要问 `wiki-service`，草稿怎么改回去
 * 只有浏览器知道——所以撤销执行体**按域注册**（{@link UndoHandler}），
 * 由各域自己的插件提供。journal 一旦认识业务域，它就变成第二个 wiki，
 * 而**两份判据必然漂移**（本仓为这条付过代价：`packages/plugin-wiki/src/index.ts` 记的
 * "正文里看不到、附件却能下载"）。
 *
 * ## 为什么粒度是"一次提问"而不是"一次 HTTP 回合"
 * 无状态轮次协议下一次提问可能横跨多个 HTTP 回合（P3 实测：2 个）。
 * 用户心里的"那一轮"是**他问的那一句话**，不是协议回合数。所以 `turnId` 由**客户端**生成
 * 并在整段提问里保持不变，服务端原样存。
 *
 * ## 撤销的两种执行位置
 * - **服务端**：该域注册了 `UndoHandler`（如页面正文走 `wiki-service.save`）；
 * - **客户端**：没注册（如编辑器草稿），journal 把它作为 `clientSteps` 返回，
 *   由浏览器执行逆操作后回报 `markUndone`。
 *
 * 分成两种不是妥协：草稿**本来就不在服务器上**，硬要搬到服务端来撤销，
 * 等于让服务端持有用户没保存的东西——那比"回退不了"严重得多。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { asAsync } from '@geewiki/core'
import type {
  DatabaseAdapter,
  DatabaseDialect,
  GeeWikiManifest,
  HttpRouterService,
  Principal,
  RouteHandlerContext,
} from '@geewiki/core'
import {
  AI_JOURNAL_SERVICE_NAME,
  type AiJournalService,
  type JournalQuery,
  type MutationInput,
  type MutationRecord,
  type RollbackReport,
  type TurnGroup,
  type MutationProbe,
  type ProbeOutcome,
  type UndoHandler,
} from './types.js'
import { checkSelfLock, groupByTurn, planRollback } from './plan.js'

const MIGRATIONS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** SQLite 方言的迁移目录（`migrations/`） */
export const JOURNAL_MIGRATIONS_DIR = join(MIGRATIONS_ROOT, 'migrations')
/**
 * ★ F19：PostgreSQL 方言的迁移目录（`migrations-postgres/`）。
 *
 * **为什么必须按方言分目录**：`migrations/0001_ai_mutations.sql` 用的是
 * `INTEGER PRIMARY KEY AUTOINCREMENT` —— SQLite 专有语法，PostgreSQL 会在
 * `AUTOINCREMENT` 上直接报 `syntax error`（实测）。而本插件是**自己调 `db.migrate()`**
 * 的（见 apply 里的注释），调用点只有"一个目录"这个概念，方言得由**调用方**自己分。
 * 不分的话，PG 部署上这个插件会在激活期整块失败，而报错是数据库抛的原始语法错误。
 */
export const JOURNAL_MIGRATIONS_DIR_POSTGRES = join(MIGRATIONS_ROOT, 'migrations-postgres')

/** 按当前适配器方言挑选迁移目录 */
export function journalMigrationsDirFor(dialect: DatabaseDialect): string {
  return dialect === 'postgres' ? JOURNAL_MIGRATIONS_DIR_POSTGRES : JOURNAL_MIGRATIONS_DIR
}

/** 写入路径与回退路径（都由本插件提供；回退 UI 在 dock 里） */
export const JOURNAL_RECORD_PATH = '/api/ai/journal'
export const JOURNAL_UNDO_PATH = '/api/ai/journal/undo'

const MAX_TEXT_CHARS = 200_000
const MAX_ID_CHARS = 200

/** 撤销执行体的注册表：按域，重复注册抛错（照 `LlmRouteDescriptor` / `AiToolService` 的先例） */
class UndoerRegistry {
  private readonly byDomain = new Map<string, { handler: UndoHandler; owner: string }>()

  register(owner: string, domain: string, handler: UndoHandler): () => void {
    const existing = this.byDomain.get(domain)
    if (existing !== undefined) {
      throw new Error(
        `[${manifest.name}] 域 ${domain} 已有撤销执行体（${existing.owner}），${owner} 不得重复注册` +
          '——同一域两份撤销实现时，"改回去"没有确定答案',
      )
    }
    this.byDomain.set(domain, { handler, owner })
    return () => {
      const now = this.byDomain.get(domain)
      if (now !== undefined && now.owner === owner && now.handler === handler) this.byDomain.delete(domain)
    }
  }

  get(domain: string): UndoHandler | undefined {
    return this.byDomain.get(domain)?.handler
  }

  release(owner: string): void {
    for (const [domain, entry] of [...this.byDomain]) {
      if (entry.owner === owner) this.byDomain.delete(domain)
    }
  }

  domains(): readonly string[] {
    return [...this.byDomain.keys()].sort()
  }
}

/**
 * 探针注册表：与 {@link UndoerRegistry} 同构（按域、重名抛错、按 owner 回收）。
 *
 * 没有把两者合成一个泛型类：它们的**失败语义不同**——重复的撤销执行体会让
 * "改回去"没有确定答案（必须抛错），而重复的探针同样如此，但两者的错误文案要
 * 分别说清是"怎么改回去"还是"现在是什么"。共用一份泛型换来的只是少 30 行。
 */
class ProbeRegistry {
  private readonly byDomain = new Map<string, { probe: MutationProbe; owner: string }>()

  register(owner: string, domain: string, probe: MutationProbe): () => void {
    const existing = this.byDomain.get(domain)
    if (existing !== undefined) {
      throw new Error(
        `[${manifest.name}] 域 ${domain} 已有当前值探针（${existing.owner}），${owner} 不得重复注册` +
          '——同一域两份探针时，"目标现在是什么"没有确定答案',
      )
    }
    this.byDomain.set(domain, { probe, owner })
    return () => {
      const now = this.byDomain.get(domain)
      if (now !== undefined && now.owner === owner && now.probe === probe) this.byDomain.delete(domain)
    }
  }

  get(domain: string): MutationProbe | undefined {
    return this.byDomain.get(domain)?.probe
  }

  release(owner: string): void {
    for (const [domain, entry] of [...this.byDomain]) {
      if (entry.owner === owner) this.byDomain.delete(domain)
    }
  }

  domains(): readonly string[] {
    return [...this.byDomain.keys()].sort()
  }
}

/* ============================== 行与列的映射 ============================== */

interface JournalRow {
  id: number
  conversation_id: string
  turn_id: string
  owner: string
  tool: string
  domain: string
  target: string
  before: string | null
  after: string | null
  at: string
  undone_at: string | null
}

function toRecord(row: JournalRow): MutationRecord {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    owner: row.owner,
    tool: row.tool,
    domain: row.domain,
    target: row.target,
    before: row.before,
    after: row.after,
    at: row.at,
    undoneAt: row.undone_at,
  }
}

/* ============================== 请求体解析 ============================== */

function str(value: unknown, field: string, max = MAX_ID_CHARS, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  if (!allowEmpty && value.trim() === '') throw new Error(`${field} 不得为空`)
  if (value.length > max) throw new Error(`${field} 过长（${value.length} > ${max}）`)
  return value
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串或 null`)
  if (value.length > MAX_TEXT_CHARS) throw new Error(`${field} 过长（${value.length} > ${MAX_TEXT_CHARS}）`)
  return value
}

/** 解析一条记录入参。**未知字段一律拒绝**（同 turn 端点口径：静默忽略会让契约悄悄漂移） */
export function parseMutationInput(raw: unknown): MutationInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('请求体必须是 JSON 对象')
  const body = raw as Record<string, unknown>
  const allowed = ['conversationId', 'turnId', 'owner', 'tool', 'domain', 'target', 'before', 'after']
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) throw new Error(`未知字段: ${unknown.join(', ')}`)
  const input: MutationInput = {
    conversationId: str(body['conversationId'], 'conversationId'),
    turnId: str(body['turnId'], 'turnId'),
    owner: str(body['owner'], 'owner'),
    tool: str(body['tool'], 'tool'),
    domain: str(body['domain'], 'domain', 64),
    target: str(body['target'], 'target', 512),
    before: nullableText(body['before'], 'before'),
    after: nullableText(body['after'], 'after'),
  }
  /*
   * 自锁护栏在**记录前**就拦：一条"停用 llm"的变更连记都不该记下——
   * 记了它就得为"要不要回退一条从未生效的变更"设计语义，而那是纯粹的自找麻烦。
   * 真被拦下时抛错，由调用方转成 403（不是 400：这不是格式问题，是**不允许**）。
   */
  const violation = checkSelfLock([input.target])
  if (violation !== null) throw new SelfLockError(violation.reason)
  return input
}

/** 踩到自锁红线。与"格式不对"分开，端点据此回 **403** 而不是 400 */
export class SelfLockError extends Error {}

/* ============================== 插件 ============================== */

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-journal',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 变更日志',
    description: '记录 AI 的每一次写操作，并支持按轮回退到某一轮之前（他人改过则拒绝）',
    provides: AI_JOURNAL_SERVICE_NAME,
    // `database-provider` 是存储；`http-service` 是端点。
    // **不依赖 llm / ai-tools**：它是被工具调用的下游，反过来依赖它们会成环。
    requires: ['http-service', 'database-provider'],
    conflictGroup: undefined,
    migrations: { default: './migrations', postgres: './migrations-postgres' },
    runtime: {
      supportsHotReload: true, // 无内部状态：数据在表里，注册表随实例
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: undefined,
    slots: undefined,
  },
}

export const AiJournalPlugin = {
  name: '@geewiki/ai-journal',

  /**
   * **为什么是 async**（★ F19）：`apply` 里要 `await` 迁移 —— PG 适配器的 `migrate`
   * 返回 Promise，不 await 就会出现"迁移还在跑、路由已经挂上"的竞态。cordis 支持
   * 异步 apply（管理器会 await 它，并受 `runtime.applyTimeout` 约束），故这里改成
   * 异步是安全的；同步实现返回的卸载函数语义不变。
   */
  async apply(ctx: Context): Promise<() => void> {
    /*
     * 注意两套名字：manifest 的 `requires` 用**服务标识**（`http-service` / `database-provider`），
     * 而 `ctx.get()` 取的是服务实例注册名（`http` / `db`）。两者不同源，写错的表现是
     * `undefined` + 静默不可用——本仓已为此记档（ai-qa 的文件头注释）。
     */
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/ai-journal: http 服务不可用（@geewiki/http 未激活）')
    const db = ctx.get('db') as DatabaseAdapter | undefined
    if (!db) throw new Error("@geewiki/ai-journal: db 服务不可用（database-provider 未激活）")

    /*
     * 迁移由本插件自己跑（与 `@geewiki/wiki` 同一条理由）：内置插件的迁移目录在组合根
     * `defaultRegistry()` 里硬编码，而 manifest 的 `migrations` 字段只对外部插件生效。
     * 自己跑同样安全：`db.migrate()` 以 `_migrations` 表去重，天然幂等、可重放。
     */
    // ★ F19：两个都修掉才成立 ——
    // ① **按方言选目录**：SQLite 的 DDL（`AUTOINCREMENT`）在 PG 上是语法错误；
    // ② **必须 await**：`db` 这里按同步接口取，而 PG 适配器的 `migrate` 返回 Promise，
    //    不 await 就会出现"迁移还在跑，路由已经挂上、第一条查询已经发出"的竞态。
    //    `asAsync` 正是为这种双轨场景准备的归一化入口（见 core 的 `DatabaseAdapterAsync`）。
    await asAsync(db).migrate(journalMigrationsDirFor(db.dialect ?? 'sqlite'))

    const undoers = new UndoerRegistry()
    const probes = new ProbeRegistry()
    const now = (): string => new Date().toISOString()

    const insert = (input: MutationInput): number => {
      const result = db.run(
        `INSERT INTO ai_mutations
           (conversation_id, turn_id, owner, tool, domain, target, before, after, at, undone_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          input.conversationId,
          input.turnId,
          input.owner,
          input.tool,
          input.domain,
          input.target,
          input.before,
          input.after,
          now(),
        ],
      )
      return Number(result.lastInsertRowid ?? 0)
    }

    const list = (query: JournalQuery = {}): readonly MutationRecord[] => {
      const where: string[] = []
      const params: unknown[] = []
      if (query.conversationId !== undefined) {
        where.push('conversation_id = ?')
        params.push(query.conversationId)
      }
      if (query.turnId !== undefined) {
        where.push('turn_id = ?')
        params.push(query.turnId)
      }
      if (query.pendingOnly === true) where.push('undone_at IS NULL')
      const limit = Math.min(Math.max(query.limit ?? 500, 1), 2000)
      const sql =
        'SELECT * FROM ai_mutations' +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        // 升序：调用方（`planRollback`）要的是**发生顺序**，它自己会倒过来。
        // 反过来在这里排序会让"倒序"这条不变量散落在两处。
        ' ORDER BY id ASC LIMIT ?'
      return db.query<JournalRow>(sql, [...params, limit]).map(toRecord)
    }

    const markUndone = (ids: readonly number[], _detail: string): number => {
      let changed = 0
      for (const id of ids) {
        const result = db.run('UPDATE ai_mutations SET undone_at = ? WHERE id = ? AND undone_at IS NULL', [
          now(),
          id,
        ])
        changed += Number(result.changes ?? 0)
      }
      return changed
    }

    /**
     * 解析"每条记录的目标现在实际是什么"。
     *
     * **优先级：服务端探针 > 调用方自报**。顺序不能反——页面的当前值必须用带权限判据的
     * 那条读路径（`rawContent`）去读，让浏览器先读一遍再上报等于多出第二条读路径，
     * 而两条判据必然漂移。调用方自报只服务**浏览器里的域**（草稿），那是它的唯一来源。
     *
     * 这段逻辑放在 `rollbackTo` 里而不是 HTTP 端点里：端点只是一个入口，
     * 而"谁说了算"是回退的语义。放在端点里会让**服务级调用完全绕过探针**——
     * 那正是"测试全绿但线上不生效"的标准形状。
     */
    const resolveCurrent = async (
      records: readonly MutationRecord[],
      principal: Principal,
      currentOf?: (record: MutationRecord) => string | null | undefined,
    ): Promise<{
      valueOf: (record: MutationRecord) => string | null | undefined
      reasonOf: (record: MutationRecord) => string | undefined
    }> => {
      const probed = new Map<number, ProbeOutcome>()
      for (const record of records) {
        const probe = probes.get(record.domain)
        if (probe === undefined) continue
        try {
          probed.set(record.id, await probe(record, principal))
        } catch (err) {
          // 探针自己炸了 ⇒ "不知道"（按冲突处理），绝不是"没被改过"
          probed.set(record.id, {
            reason:
              `读取 ${record.domain}:${record.target} 的当前值时出错（${err instanceof Error ? err.message : String(err)}）` +
              '——无法确认它没被改过，故不能回退这一条',
          })
        }
      }
      return {
        valueOf: (record) => {
          const outcome = probed.get(record.id)
          // 有探针就以探针为准：它的 `value` 缺席（undefined）是**结论**，不是"没问过"
          if (outcome !== undefined) return outcome.value
          return currentOf?.(record)
        },
        reasonOf: (record) => probed.get(record.id)?.reason,
      }
    }

    const rollbackTo = async (
      principal: Principal,
      conversationId: string,
      turnId: string,
      currentOf?: (record: MutationRecord) => string | null | undefined,
    ): Promise<RollbackReport> => {
      const records = list({ conversationId, turnId })
      const resolved = await resolveCurrent(records, principal, currentOf)
      const plan = planRollback(records, resolved.valueOf, resolved.reasonOf)
      const undone: { record: MutationRecord; detail: string }[] = []
      const failed: { record: MutationRecord; detail: string }[] = []
      const clientSteps: { record: MutationRecord; expected: string | null }[] = []

      for (const record of plan.steps) {
        const handler = undoers.get(record.domain)
        if (handler === undefined) {
          /*
           * 没有服务端执行体 ⇒ 交给客户端。**这不是失败**：草稿本来就不在服务器上。
           * 但也不能静默当成"撤好了"——它只是"还没撤"，故不进 `undone`。
           */
          clientSteps.push({ record, expected: record.after })
          continue
        }
        try {
          const outcome = await handler(record, principal)
          if (outcome.ok) {
            markUndone([record.id], outcome.detail)
            undone.push({ record, detail: outcome.detail })
          } else {
            failed.push({ record, detail: outcome.detail })
          }
        } catch (err) {
          failed.push({ record, detail: err instanceof Error ? err.message : String(err) })
        }
      }

      return { conversationId, turnId, undone, failed, clientSteps, conflicts: plan.conflicts, alreadyUndone: plan.alreadyUndone }
    }

    const service: AiJournalService = {
      async record(input) {
        return insert(input)
      },
      async list(query) {
        return list(query)
      },
      async turns(conversationId): Promise<readonly TurnGroup[]> {
        return groupByTurn(list({ conversationId }))
      },
      registerUndoer(owner, domain, handler) {
        return undoers.register(owner, domain, handler)
      },
      registerProbe(owner, domain, probe) {
        return probes.register(owner, domain, probe)
      },
      rollbackTo,
      async markUndone(ids, detail) {
        return markUndone(ids, detail)
      },
    }
    const unprovide = ctx.provide(AI_JOURNAL_SERVICE_NAME, service)

    /* ------------------------------ 端点 ------------------------------ */

    const cleanups: (() => void)[] = []

    /*
     * 主体闸门：变更日志是**按用户**的东西（决策 12 的会话按用户隔离、决策 11 的
     * "只撤 AI 自己做的改动"）。匿名主体没有会话、也没有任何 AI 写操作能归属于它，
     * 放行只会让这张表多出一批无法归属的记录。`break-glass` 放行（应急通道本就能读全库）。
     */
    const gate = (h: RouteHandlerContext): Principal | null => {
      const principal = h.principal
      if (principal === undefined || principal.kind === 'anonymous') {
        h.json(401, { ok: false, error: 'unauthorized', message: 'AI 变更日志只对登录用户开放' })
        return null
      }
      return principal
    }

    cleanups.push(
      router.register('POST', JOURNAL_RECORD_PATH, async (h) => {
        if (gate(h) === null) return
        let body: unknown
        try {
          body = await readJsonBody(h)
        } catch (err) {
          h.json(400, { ok: false, error: 'invalid_body', message: err instanceof Error ? err.message : '' })
          return
        }
        let input: MutationInput
        try {
          input = parseMutationInput(body)
        } catch (err) {
          // 自锁红线是 **403**（不允许），格式问题是 **400**——两者该做的事相反
          const code = err instanceof SelfLockError ? 403 : 400
          h.json(code, {
            ok: false,
            error: err instanceof SelfLockError ? 'protected_node' : 'invalid_body',
            message: err instanceof Error ? err.message : '',
          })
          return
        }
        const id = insert(input)
        h.json(200, { ok: true, id })
      }, { access: 'user' }),
    )

    cleanups.push(
      router.register('GET', JOURNAL_RECORD_PATH, (h) => {
        if (gate(h) === null) return
        const conversationId = h.url.searchParams.get('conversationId') ?? undefined
        if (conversationId === undefined) {
          h.json(400, { ok: false, error: 'missing_conversation', message: '必须给 conversationId（会话按用户隔离）' })
          return
        }
        h.json(200, { ok: true, turns: groupByTurn(list({ conversationId })) })
      }, { access: 'user' }),
    )

    cleanups.push(
      router.register('POST', JOURNAL_UNDO_PATH, async (h) => {
        const principal = gate(h)
        if (principal === null) return
        let body: Record<string, unknown>
        try {
          const raw = await readJsonBody(h)
          if (typeof raw !== 'object' || raw === null) throw new Error('请求体必须是 JSON 对象')
          body = raw as Record<string, unknown>
        } catch (err) {
          h.json(400, { ok: false, error: 'invalid_body', message: err instanceof Error ? err.message : '' })
          return
        }
        let conversationId: string
        let turnId: string
        let snapshots: Record<string, string | null>
        try {
          conversationId = str(body['conversationId'], 'conversationId')
          turnId = str(body['turnId'], 'turnId')
          const raw = body['snapshots'] ?? {}
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error('snapshots 必须是对象（键是 "域:目标"，值是当前内容）')
          }
          snapshots = raw as Record<string, string | null>
        } catch (err) {
          h.json(400, { ok: false, error: 'invalid_body', message: err instanceof Error ? err.message : '' })
          return
        }
        /*
         * 这里只负责把 `snapshots` 变成 `currentOf` 回调；**探针的优先级在 `rollbackTo` 里**
         * （域的所有者注册的探针说了算，`snapshots` 只补那些没有服务端读路径的域）。
         *
         * `currentOf` 的判据：**没给的目标返回 `undefined`**（不是 null！）——
         * `planRollback` 据此判"不知道"，而"不知道"按冲突处理。
         * 用 null 顶替会让"没提供"看起来像"现在是空的"。
         */
        const report = await rollbackTo(principal, conversationId, turnId, (record) => {
          const key = `${record.domain}:${record.target}`
          return Object.prototype.hasOwnProperty.call(snapshots, key) ? snapshots[key] : undefined
        })
        h.json(200, { ok: true, ...report })
      }, { access: 'user' }),
    )

    /*
     * 客户端执行完 `clientSteps` 之后回报。**单独一个端点**而不是让 undo 端点猜：
     * "服务器撤了"与"浏览器撤了"是两件事，混淆它们会让报告说谎
     * （用户看到"已回退"，而草稿其实没动）。
     */
    cleanups.push(
      router.register('POST', `${JOURNAL_UNDO_PATH}/ack`, async (h) => {
        if (gate(h) === null) return
        let body: Record<string, unknown>
        try {
          const raw = await readJsonBody(h)
          if (typeof raw !== 'object' || raw === null) throw new Error('请求体必须是 JSON 对象')
          body = raw as Record<string, unknown>
        } catch (err) {
          h.json(400, { ok: false, error: 'invalid_body', message: err instanceof Error ? err.message : '' })
          return
        }
        const ids = Array.isArray(body['ids']) ? body['ids'].map((v) => Number(v)).filter((n) => Number.isFinite(n)) : []
        if (ids.length === 0) {
          h.json(400, { ok: false, error: 'invalid_body', message: 'ids 必须是非空数字数组' })
          return
        }
        h.json(200, { ok: true, changed: markUndone(ids, String(body['detail'] ?? '')) })
      }, { access: 'user' }),
    )

    return () => {
      for (const cleanup of cleanups) cleanup()
      undoers.release(manifest.name)
      unprovide()
    }
  },
}

/* ============================== 请求体读取 ============================== */

/**
 * 读 JSON 请求体（1MB 上限）。与 `@geewiki/wiki` / `@geewiki/ai-qa` 的同名实现保持一致的契约：
 * 超限以 `payload_too_large:` 前缀拒绝（调用方写 413 后关连接），畸形 JSON 以 `invalid_json:` 前缀拒绝。
 */
function readJsonBody(h: RouteHandlerContext, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const req = h.req
    req.on('data', (chunk: Buffer) => {
      const buf = chunk
      size += buf.length
      if (size > limit) {
        req.pause()
        reject(new Error(`payload_too_large: 请求体超过 ${limit} 字节`))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text) as unknown)
      } catch {
        reject(new Error('invalid_json: 请求体不是合法 JSON'))
      }
    })
    req.on('error', (err: Error) => reject(err))
  })
}

/*
 * 契约类型与纯函数**从入口再导出**：`@geewiki/ai-pages` 这类消费方只 import 本包入口，
 * 不该被迫记住内部文件划分（`types.js` / `plan.js` 是实现细节）。
 * 从入口导出也让"这个包对外承诺什么"集中在一处可见。
 */
export * from './types.js'
export { checkSelfLock, describe, groupByTurn, planRollback, PROTECTED_AI_NODES } from './plan.js'
export type { Principal }
