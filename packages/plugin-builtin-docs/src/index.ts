/**
 * `@geewiki/builtin-docs` —— 内置产品文档（只读 · 版本同步 · 可隐藏）
 *
 * 首次部署时把"关于本项目自身"的文章（架构 / 功能 / Markdown 演示 / 特殊结构）
 * 作为**真实页面**写入 wiki，此后：
 *
 *   - **只读**：判据不在本包，在 `@geewiki/authz` —— 它每次判定现取本包 provide 的
 *     `builtin-docs-service`，对记账页强制 `canEdit/canDelete/canManageVisibility=false`。
 *     本包**不**在 wiki 里加"锁"：policy-service 是授权判据的唯一出口（§2.0 分工），
 *     在写路径上再设一道私有守卫就是第二份判据，必然漂移。
 *   - **版本同步**：正文带版本戳（`DOCS_VERSION`），与库里戳记不等才同步 ⇒ 项目更新后
 *     服务器启动过程自动把文档刷成最新，比对相等时零写入。
 *   - **可隐藏**：配置 `hidden` ⇒ 策略层对所有主体判 `level='none'`，列表/检索/阅读
 *     一律视同不存在；页面本体从未被删，关掉即恢复。
 *
 * 三条边界（与仓库红线逐条对齐）：
 *
 *   1. **写只经 wiki-service**：建档走 `save()`（块同步、反链重建、版本快照都在它
 *      的事务里），删除走 `remove()`——服务层不带授权（授权发生在 HTTP 处理器与
 *      策略层），系统写方要的正是这个"无主体"形态。绝不 SELECT/INSERT 别人的表。
 *   2. **接管护栏以记账表为权威**：`page:<slug>` 行存在 ⇔ 这一页是我们建的。
 *      slug 撞名（用户先建了 `home`）⇒ 跳过并告警，用户的页面不受锁、不受隐藏、
 *      永远不会被同步改写或删除。"目录里有这个名字"**不是**接管凭证。
 *   3. **同步失败不阻断启动**：文档是辅助功能，它写坏了不能让整台服务器起不来；
 *      失败则不落版本戳 ⇒ 下次启动自动重试（save/remove 均幂等，重试安全）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { asAsync } from '@geewiki/core'
import type { DatabaseAdapter, DatabaseExecutor, GeeWikiManifest } from '@geewiki/core'
import { BUILTIN_DOCS } from './catalog.js'
import {
  BuiltinDocsConfigSchema,
  DOCS_VERSION,
  PLUGIN_NAME,
  STATE_KEY_PAGE_PREFIX,
  STATE_KEY_VERSION,
  type BuiltinDocsService,
} from './types.js'

/** 迁移目录（`CREATE TABLE builtin_docs_state`，方言中立）。registry 回退也用它 */
export const DOCS_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/* ============================== wiki-service 的最小结构需求 ============================== */

/**
 * `wiki-service` 的**最小结构需求**（结构化类型，不 import `@geewiki/wiki`——
 * 同 ai-summary 对它的消费先例）。只声明本包用到的三个方法；
 * 入参/返回按**结构**而非命名类型书写，wiki 的其余演化对本包透明。
 */
interface WikiServiceLike {
  save(
    slug: string,
    input: {
      title: string
      content: string
      /** 仅创建分支生效、仅服务路径可传（wiki 的 svc.save 有运行期校验） */
      visibility?: 'private' | 'org' | 'public'
      published?: boolean
    },
  ): Promise<{ outcome: 'created' | 'updated' | 'unchanged' }>
  remove(slug: string): Promise<boolean>
  /** 与可见性无关的存在性探测（接管护栏用它；wiki-service 里注明了为什么它是契约例外） */
  exists(slug: string): Promise<boolean>
  /** 按策略层当前判定重算给定页的块 tier（隐藏开关物化到检索命中层用；见其契约注释） */
  resyncTiers(slugs: readonly string[]): Promise<number>
}

/* ============================== 同步引擎 ============================== */

interface SyncDeps {
  /**
   * ★ F19：这里要的是**异步执行器**（`DatabaseExecutor`），不是同步的 `DatabaseAdapter`。
   *
   * 原因是一个实测出来的真 bug：PostgreSQL 适配器的 `query`/`run` 返回 **Promise**，
   * 而同步接口的签名说它返回数组/结果。于是
   * `db.query(...)[0]` 与 `db.query(...).map(...)` 在 SQLite 上完全正常，
   * 在 PG 上分别得到 `undefined` 和 **`db.query(...).map is not a function`** ——
   * 后者是内置文档插件在 PG 部署上的真实报错（整块激活失败）。
   * 类型在这里挡住它，比在 PG 上撞见它便宜得多。
   */
  db: DatabaseExecutor
  wiki: WikiServiceLike
  /** 记账页集合（活的引用：同步会就地增删，policy 消费面读的也是它） */
  managed: Set<string>
  isDisposed: () => boolean
}

interface SyncReport {
  created: number
  updated: number
  unchanged: number
  removed: string[]
  skipped: string[]
}

/** 中止哨兵：卸载竞态下跳出循环用，外层据此**静默**收手（这不是失败） */
class SyncAborted extends Error {
  constructor() {
    super('builtin_docs_sync_aborted')
  }
}

/**
 * 版本键控同步。比对相等 ⇒ 零写入立刻返回；不等 ⇒ 逐篇对齐 + 孤儿清理 + 盖戳。
 *
 * 盖戳放在**全部成功之后**：中途抛错（内容坏了、库异常）留下旧戳，下次启动整体重试。
 * 重试安全性由幂等保证：managed 页重放 save 得 `unchanged`，新建页重放前会先过
 * exists/记账双判据。
 */
async function syncDocs(deps: SyncDeps): Promise<SyncReport> {
  const { db, wiki, managed } = deps
  const report: SyncReport = { created: 0, updated: 0, unchanged: 0, removed: [], skipped: [] }
  const abortIfDisposed = (): void => {
    if (deps.isDisposed()) throw new SyncAborted()
  }

  const stored = (await db.query<{ value: string }>('SELECT value FROM builtin_docs_state WHERE key = ?', [
    STATE_KEY_VERSION,
  ]))[0]?.value
  if (stored === String(DOCS_VERSION)) return report // 快路径：戳相等，一个字节都不写

  const upsert = async (key: string, value: string): Promise<void> => {
    // ON CONFLICT 语法 SQLite(≥3.24) 与 PostgreSQL 通用——与迁移文件同一条方言中立纪律
    await db.run(
      'INSERT INTO builtin_docs_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    )
  }

  /*
   * 逐篇对齐。建档用 public + 已发布：发布闸门只约束 public 档（authz decideNormally），
   * "创建为 public 却不发布"对所有人（含作者自己）都是不可见——原子的事必须一次做完。
   */
  const catalogSlugs = new Set<string>()
  for (const doc of BUILTIN_DOCS) {
    catalogSlugs.add(doc.slug)
    abortIfDisposed()
    if (managed.has(doc.slug)) {
      const res = await wiki.save(doc.slug, { title: doc.title, content: doc.content })
      report[res.outcome] += 1
      continue
    }
    // 未记账 ⇒ 只有"库里根本没有这一页"才允许建档；有 ⇒ 撞名，用户的内容不可侵犯
    if (await wiki.exists(doc.slug)) {
      report.skipped.push(doc.slug)
      console.warn(
        `[${PLUGIN_NAME}] slug "${doc.slug}" 已被既有页面占用，内置文档不接管用户内容：跳过这一篇（本版本戳内不再重试）`,
      )
      continue
    }
    const res = await wiki.save(doc.slug, { title: doc.title, content: doc.content, visibility: 'public', published: true })
    report[res.outcome] += 1
    managed.add(doc.slug)
    upsert(`${STATE_KEY_PAGE_PREFIX}${doc.slug}`, new Date().toISOString())
  }

  /*
   * 孤儿清理：记账了但目录已删（上一版有、这一版移除的文档）。
   * `wiki.remove` 不带授权正是系统写方的合法路径（授权在路由层与策略层）。
   * 先删页再删记账行：中途崩溃留下"有记账无页面"的残行，下次同步照样把它当孤儿清掉，
   * 反向（有页面无记账）才会变成没人管的僵尸页——顺序不能反。
   */
  for (const slug of [...managed]) {
    abortIfDisposed()
    if (catalogSlugs.has(slug)) continue
    await wiki.remove(slug)
    managed.delete(slug)
    await db.run('DELETE FROM builtin_docs_state WHERE key = ?', [`${STATE_KEY_PAGE_PREFIX}${slug}`])
    report.removed.push(slug)
  }

  abortIfDisposed()
  // 见函数头：只有全部对齐成功才盖戳。skipped 也算"已处理"（用户占名的页在每个版本戳
  // 内只试一次；用户哪天删了自己的同名页，下一次版本 bump 会自然补上这一篇）
  await upsert(STATE_KEY_VERSION, String(DOCS_VERSION))
  return report
}

/* ============================== 插件 ============================== */

export const BuiltinDocsPlugin = {
  name: PLUGIN_NAME,
  /**
   * async apply：同步引擎要 await wiki-service（其契约全异步，pg 适配器本质异步）。
   * manager 的 `await ctx.plugin(...)` 会等激活完成（含 async apply）⇒ 服务器开始
   * 接流量时文档已就位，不存在"首访无文档"的窗口。
   */
  async apply(ctx: Context, rawConfig: unknown = {}) {
    const config = BuiltinDocsConfigSchema(rawConfig ?? {})
    const dbRaw = ctx.get('db') as DatabaseAdapter | undefined
    if (!dbRaw) throw new Error(`${PLUGIN_NAME}: database-provider 不在（requires 已声明，正常不会发生）`)
    /*
     * ★ F19：**在获取点就归一化成异步执行器**，而不是在后面每一处 `asAsync(db)`。
     *
     * 这不是风格问题，是**让编译器替我们挡住这一整类 bug**：
     * 原来是 `const db = ctx.get('db') as DatabaseAdapter`，而 `as DatabaseAdapter`
     * 恰恰在**撒谎**——PG 适配器的 `query`/`run` 返回 Promise。于是
     * `db.query(...)[0]`（得到 `undefined`）与 `db.query(...).map(...)`
     * （**`is not a function`**，实测就是这一处的报错）都能通过类型检查，
     * 只在真 PG 上炸。归一化之后，`db.query()` 的类型就是 `Promise<...>`，
     * **忘写 `await` 会直接是类型错误**，不会再溜到运行时。
     */
    const db = asAsync(dbRaw)
    // 迁移：await 必填（PG 下不 await 就是"迁移还在跑、文档同步已经开始"的竞态）
    await db.migrate(DOCS_MIGRATIONS_DIR)
    const wiki = ctx.get('wiki-service') as WikiServiceLike | undefined
    if (!wiki) throw new Error(`${PLUGIN_NAME}: wiki-service 不在（requires 已声明，正常不会发生）`)

    /*
     * 记账页集合：激活时读一次，此后同步引擎就地增删。
     * authz 的 `isManagedPage` 每次判定都现问这个 Set——它是内存查询，
     * 支撑得起"每页每主体一次"的调用频率（列表页也不会放大：判定是批量循环里做的）。
     */
    const managed = new Set<string>(
      // ★ F19：`await` 必填。PG 适配器返回 Promise，`Promise.map` 不存在 ⇒
      // 实测报错就是这一处：`db.query(...).map is not a function`（整块激活失败）。
      (
        await db.query<{ key: string }>('SELECT key FROM builtin_docs_state WHERE key LIKE ?', [
          `${STATE_KEY_PAGE_PREFIX}%`,
        ])
      ).map((r) => r.key.slice(STATE_KEY_PAGE_PREFIX.length)),
    )

    const service: BuiltinDocsService = {
      isManagedPage: (slug) => managed.has(slug),
      isHidden: () => config.hidden,
    }
    // 真正创建 cordis 服务（manifest 的 provides 只是依赖图 token，不会建服务——同名纪律见 wiki 契约注释）
    const unprovide = ctx.provide('builtin-docs-service', service)

    let disposed = false
    try {
      // 归一化成异步执行器再交出去：调用点全部 await，两种驱动都能跑（见 SyncDeps.db 的注释）
      const r = await syncDocs({ db, wiki, managed, isDisposed: () => disposed })
      const touched = r.created + r.updated + r.unchanged
      if (touched > 0 || r.removed.length > 0) {
        console.log(
          `[${PLUGIN_NAME}] 文档同步完成（版本 ${DOCS_VERSION}）：新建 ${r.created}、更新 ${r.updated}、` +
            `未变 ${r.unchanged}` +
            (r.removed.length > 0 ? `、删除 ${r.removed.join(', ')}` : '') +
            (r.skipped.length > 0 ? `、跳过 ${r.skipped.join(', ')}` : ''),
        )
      }
    } catch (err) {
      if (err instanceof SyncAborted) {
        console.warn(`[${PLUGIN_NAME}] 同步途中插件被卸载，本轮中止（版本戳未更新，下次激活重试）`)
      } else {
        // 见文件头边界 3：辅助功能不阻断启动；不盖戳 ⇒ 下次启动整体重试
        console.error(`[${PLUGIN_NAME}] 文档同步失败（不影响其它功能，下次启动将重试）:`, err)
      }
    }

    /*
     * 每次激活都重同步记账页的块 tier——**快路径（版本相等）也要做**，因为它服务的是
     * 另一件事：`hidden` 开关不写库、只改判据，而检索命中层读的是物化列 `blocks.tier`
     * （search 的命中谓词不看 visibleSlugs 交集，见其文件内注释）。配置热更新的真实
     * 形态是重新 activate（日志"已卸载→已激活"两行），这里把 tier 刷成与当前
     * `hidden` 一致，检索侧立即跟上；重算幂等（tier 只由策略层当前判定决定）。
     *
     * ★ 为什么挪进 `setImmediate` 而不是在 apply 里直刷（真实实例冒烟暴露的坑）：
     * cordis 把 fiber 的 provide **提交在 apply 返回之后**——apply 还在跑时，别的
     * fiber（这里是 authz 的 `builtinDocs()`）`ctx.get('builtin-docs-service')` 拿到
     * undefined，策略层的隐藏覆盖整段静默缺席，tier 会按"无覆盖"的旧判据刷回去，
     * 等于白刷且**没有任何错误可查**（真实实例上曾以"隐藏后搜索仍命中"的形态暴露，
     * 而 fixture 的 provide 是同步 Map、测不出这个时序）。挪出一个宏任务轮次后
     * provide 已全局可见，两种 ctx 形态下都成立。
     *
     * ★ 卸载路径也要刷（`silent`）：判据随 `unprovide` 消失后，记账页就是普通页面了，
     * 但它们身上还留着"隐藏期间刷出来的 `tier = NULL`"——不补刷就会**页面能读、检索搜不到**。
     * 卸载路径静默：wiki 可能已经先被卸载（测试夹具就是这个顺序），失败没有可行动作。
     */
    const scheduleTierResync = (silent: boolean): void => {
      if (managed.size === 0) return
      setImmediate(() => {
        if (silent) {
          void wiki.resyncTiers([...managed]).catch(() => {
            /* 见上：卸载路径的补偿性重刷，失败无需动作 */
          })
          return
        }
        // 激活路径：本插件已卸载就别再刷了（此时 wiki 往往也已注销，只会白报一行错）
        if (disposed) return
        void wiki
          .resyncTiers([...managed])
          .catch(
            (err: unknown) =>
              // 刷不动 tier 不影响文档可读性（读路径走策略层现判），只可能让检索
              // 暂时按旧档位命中——下次激活/保存会再刷，故告警不升级。
              console.error(`[${PLUGIN_NAME}] 记账页 tier 重同步失败（检索可能暂按旧档位，下次激活重试）:`, err),
          )
      })
    }

    scheduleTierResync(false)

    console.log(
      `[${PLUGIN_NAME}] 已激活: builtin-docs-service（${BUILTIN_DOCS.length} 篇内置文档，版本 ${DOCS_VERSION}，` +
        `隐藏: ${config.hidden ? '是' : '否'}）`,
    )
    return () => {
      disposed = true
      unprovide()
      // 判据已撤 ⇒ 把 tier 刷回"无覆盖"的判定（否则隐藏期间留下的 NULL 会让它们搜不到）
      scheduleTierResync(true)
      // 页面本体**不删**：隐藏与卸载只让判据消失，数据是无辜的（重装后按版本戳续同步）
      console.log(`[${PLUGIN_NAME}] 已卸载: builtin-docs-service 注销，文档页解除只读/隐藏覆盖`)
    }
  },
}

export const manifest: GeeWikiManifest = {
  /*
   * 字面量而不是 PLUGIN_NAME：本仓的守卫测试直接读源码比对插件名与目录名
   * （见 @geewiki/ai-summary 的同款注释）——写成常量会让守卫认不出来，
   * 而"守卫认不出来"的表现是它**保持绿色**，这比红更糟。
   */
  name: '@geewiki/builtin-docs',
  version: '0.1.0',
  geewiki: {
    // ★ F10：跨界能力声明（宿主不强制，用于评审与可观测）
    permissions: ['fs:read'],
    displayName: '内置文档',
    description: '内置描述本项目的只读文档（架构 / 功能 / Markdown / 特殊结构），随版本自动同步，可隐藏',
    // 这个 provide 不是"为不存在的消费方设计接口"：@geewiki/authz 是真实消费方，
    // 只读与隐藏两条规则都靠它在判据出口实施（见 plugin-authz 的 buildAccess）。
    provides: 'builtin-docs-service',
    // 刻意不 require http——本插件**没有任何端点**：文档就是 wiki 页面，
    // 读走 wiki 的 GET，管理走 manager 的启停与配置。攻击面为零个新端点。
    requires: ['database-provider', 'wiki-service'],
    conflictGroup: undefined,
    // 迁移是方言中立的键值表 ⇒ 对所有 dialect 生效。registry 里给 sqlite 回退目录。
    migrations: './migrations',
    // 热更新是真需求：`hidden` 开关改完立即生效（authz 每次判定现取本服务，
    // 重新 activate 后拿到的就是带新 config 的对象）。
    runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 5 },
    configSchema: BuiltinDocsConfigSchema,
    client: undefined,
  },
}
