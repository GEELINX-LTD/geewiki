/**
 * @geewiki/wiki —— GeeWiki Wiki 核心插件
 *
 * 面向 DatabaseAdapter 编程（不依赖具体数据库实现），提供页面
 * 与版本历史的 REST API。每个页面正文更新前把旧内容写入
 * page_versions 快照（版本即历史），删除页面时级联清空历史。
 *
 * 挂载路由（经 @geewiki/http 路由服务）：
 *   GET    /api/pages         页面列表（摘要，含版本数）
 *   GET    /api/pages/:slug   页面详情（正文 + 版本历史）
 *   PUT    /api/pages/:slug   新建或更新（幂等 upsert）
 *   DELETE /api/pages/:slug   删除页面（含历史）
 *
 * 同时经 `ctx.provide('wiki-service', …)` 提供页面服务（契约见 WikiService）：
 * 方法集与上述四个端点一一对应，两者**共用同一份内部实现**（listPages/getPage/
 * savePage/deletePage），故同一入参下结果逐字段一致。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { closeAfterResponse, type DatabaseAdapter, type GeeWikiManifest, type HttpRouterService, type RouteHandlerContext } from '@geewiki/core'

export interface WikiConfig {
  /** 页面详情中返回的最近版本历史条数上限 */
  recentVersions?: number
}

/**
 * 配置 Schema（schemastery）：驱动管理台自动生成配置表单，并在配置热更新前做校验。
 * 同一实例也作为插件模块的 Config（cordis 据此自动校验并填默认值）。
 */
export const WikiConfigSchema = Schema.object({
  recentVersions: Schema.number()
    .default(10)
    .min(1)
    .max(100)
    .description('页面详情返回的最近版本历史条数上限'),
})

/* ======================= wiki-service 服务契约 ======================= */

/** 页面摘要（对应 GET /api/pages 的单项） */
export interface WikiPageSummary {
  slug: string
  title: string
  updated_at: string
  /** 版本号 = 历史快照数 + 1（与端点同口径） */
  version: number
}

/** 页面详情（对应 GET /api/pages/:slug 的响应体） */
export interface WikiPageDetail {
  slug: string
  title: string
  content: string
  created_at: string
  updated_at: string
  version: number
  /** 最近版本历史（条数受 config.recentVersions 限制，按 id 倒序） */
  versions: { id: number; saved_at: string }[]
}

export interface WikiSaveInput {
  title: string
  content: string
}

export interface WikiSaveResult {
  outcome: 'created' | 'updated' | 'unchanged'
  version: number
}

/**
 * `wiki-service` 服务契约（本插件经 `ctx.provide('wiki-service', svc)` 提供）。
 *
 * 存在的意义：让消费方**不必**直接 `SELECT` 本插件的 `pages` / `page_versions` 表——
 * 那会把表结构变成跨包隐式契约，并绕开本插件的"幂等保存 + 版本快照"语义
 * （保存时先快照旧正文；标题与正文都未变化时不写历史、不动 updated_at）。
 *
 * **为什么必须有它**：manifest 的 `geewiki.provides` 只是依赖图 token，**不会**创建
 * cordis 服务。此前本插件声明了 `provides: 'wiki-service'` 却从未 `ctx.provide`，
 * 于是任何按 `requires: ['wiki-service']` 依赖本插件的消费方 `ctx.get('wiki-service')`
 * 都会拿到 `undefined`（同类症状极难定位：调用方看到的只是"永远拿不到数据"）。
 *
 * **方法集与四个 REST 端点一一对应**（不引入端点之外的新语义）：
 *   list()   ↔ GET    /api/pages
 *   get()    ↔ GET    /api/pages/:slug
 *   save()   ↔ PUT    /api/pages/:slug
 *   remove() ↔ DELETE /api/pages/:slug
 *
 * 入参非法时抛错（而非静默返回空值）：`message` 以 `<code>: ` 开头，`code` 与端点的
 * 400/413 错误码同源（`invalid_slug` / `invalid_title` / `content_too_large`）。
 */
export interface WikiService {
  /** 页面摘要列表（按 updated_at 倒序，与端点同序） */
  list(): WikiPageSummary[]
  /** 页面详情；slug 不存在时返回 `undefined`（对应端点 404） */
  get(slug: string): WikiPageDetail | undefined
  /** 新建或更新（幂等 upsert）：标题与正文均未变化时 outcome='unchanged' 且不写历史 */
  save(slug: string, input: WikiSaveInput): WikiSaveResult
  /** 删除页面及其全部版本历史；返回是否确实删除（false 对应端点 404） */
  remove(slug: string): boolean
}

export const manifest: GeeWikiManifest = {
  name: '@geewiki/wiki',
  version: '0.1.0',
  geewiki: {
    provides: 'wiki-service',
    // 依赖以服务标识声明（非具体插件名）：数据库切换（SQLite→PG）对业务插件透明，
    // 依赖边由管理器按 provides 解析（deps.ts resolveDependency）
    requires: ['http-service', 'database-provider'],
    conflictGroup: undefined,
    migrations: undefined, // 表结构由 db-sqlite 的 0001 迁移建立（本插件在 db 之后激活）
    runtime: {
      supportsHotReload: true, // 无内部状态：可安全热插拔
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: WikiConfigSchema,
    // 客户端 UI 入口（`geewiki.client`）：声明后宿主会把本插件的界面产物加载进插槽
    // （入口表由后端 GET /api/plugins/ui 从活状态派生）。产物缺失只会被归入 skipped:
    // entry_missing，不产生任何请求噪声，故这里可以放心声明。
    client: { entry: 'client.js', css: 'client.css' },
  },
}

interface PageRow {
  id: number
  slug: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

/**
 * 读取并解析 JSON 请求体（上限 1MB，与 manager 的 readJsonBody 同范式）：
 * - 超限：暂停读取剩余请求体，以 `payload_too_large` 前缀的错误拒绝；
 *   响应由调用方经统一出口 `h.json(413, …)` 写出（保证计入 stats()，见看门狗探针）；
 * - 畸形 JSON：以 `invalid_json` 前缀错误拒绝（→ 400）。
 */
function readBody(h: RouteHandlerContext, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let rejected = false
    const chunks: Buffer[] = []
    h.req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        if (rejected) return // 已拒绝：忽略后续数据块
        rejected = true
        // 不再消费剩余请求体：交由调用方写出 413 后关闭连接（见 PUT 处理器）
        h.req.pause()
        rejectBody(new Error(`payload_too_large: 请求体过大（上限 ${limit} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    h.req.on('end', () => {
      if (rejected) return
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        rejectBody(new Error(`invalid_json: ${(err as Error).message}`))
      }
    })
    h.req.on('error', (err) => {
      if (!rejected) rejectBody(err)
    })
  })
}

/** slug 服务端校验正则（与前端 WikiPage 一致）：字母/数字开头，仅 a-z 0-9 . _ -，≤80 字符 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

/** slug 非法时的提示文案（端点与服务共用同一份文案） */
export const SLUG_HINT = '页面标识非法：须以字母或数字开头，仅含 a-z 0-9 . _ -，≤80 字符'

/**
 * slug 校验（服务层入口）：非法即抛错。消息以 `invalid_slug: ` 开头——
 * 沿用本插件"消息前缀即错误码"的既有约定（端点据前缀/码分流 400/413）。
 */
function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid_slug: ${SLUG_HINT}`)
}

/**
 * 归一化并校验标题/正文（**端点与服务共用的唯一实现**）。
 * 消息前缀保持既有约定：`invalid_title` → 400、`content_too_large` → 413。
 */
function normalizeSaveFields(title: unknown, content: unknown): WikiSaveInput {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  const body = typeof content === 'string' ? content : ''
  if (!trimmed) throw new Error('invalid_title: 标题不能为空')
  if (trimmed.length > 200) throw new Error('invalid_title: 标题过长（≤200 字符）')
  if (body.length > 500_000) throw new Error('content_too_large: 正文过长（≤500KB）')
  return { title: trimmed, content: body }
}

/** 从请求体提取 { title, content }：白名单字段，未知字段/超限一律 400 */
function parseSaveBody(body: unknown): WikiSaveInput {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b !== 'object' || Array.isArray(b)) {
    throw new Error('invalid_body: 请求体须为 JSON 对象')
  }
  const unknown = Object.keys(b).filter((k) => k !== 'title' && k !== 'content')
  if (unknown.length > 0) {
    throw new Error(`invalid_body: 未知字段: ${unknown.join(', ')}`)
  }
  return normalizeSaveFields(b.title, b.content)
}

export const WikiPlugin = {
  name: '@geewiki/wiki',
  /** cordis 约定：声明 Config 后由 cordis 负责校验与默认值填充 */
  Config: WikiConfigSchema,

  apply(ctx: Context, config: WikiConfig = {}) {
    const db = ctx.get('db') as DatabaseAdapter | undefined
    if (!db) throw new Error('@geewiki/wiki: 数据库服务不可用（@geewiki/db-sqlite 未激活）')
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/wiki: http 路由服务不可用（@geewiki/http 未激活）')
    const recentLimit = config.recentVersions ?? 10

    const cleanups: (() => void)[] = []

    /* ---------------------------------------------------------------------
     * 内部实现（端点与 wiki-service **共用**，单一真源）
     * 下面四个函数是全部业务语义所在；HTTP 处理器只负责参数解析/状态码翻译，
     * 服务方法只负责入参校验后转发——两条路径因此不可能行为漂移。
     * ------------------------------------------------------------------- */

    /** 页面摘要列表（按 updated_at 倒序；version = 历史快照数 + 1） */
    const listPages = (): WikiPageSummary[] =>
      db
        .query<PageRow>(
          `SELECT p.id, p.slug, p.title, p.created_at, p.updated_at,
                  (SELECT COUNT(*) FROM page_versions v WHERE v.page_id = p.id) AS version_count
             FROM pages p ORDER BY p.updated_at DESC`,
        )
        .map((r) => ({
          slug: r.slug,
          title: r.title,
          updated_at: r.updated_at,
          version: Number((r as unknown as { version_count: number }).version_count) + 1,
        }))

    /** 页面详情（正文 + 最近 recentLimit 条版本历史）；slug 不存在返回 undefined */
    const getPage = (slug: string): WikiPageDetail | undefined => {
      const page = db.query<PageRow>('SELECT * FROM pages WHERE slug = ?', [slug])[0]
      if (!page) return undefined
      const versions = db.query<{ id: number; saved_at: string }>(
        `SELECT id, saved_at FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT ?`,
        [page.id, recentLimit],
      )
      const totalVersions = (
        db.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', [page.id])[0] as unknown as { n: number }
      ).n
      return {
        slug: page.slug,
        title: page.title,
        content: page.content,
        created_at: page.created_at,
        updated_at: page.updated_at,
        version: totalVersions + 1,
        versions: versions.map((v) => ({ id: v.id, saved_at: v.saved_at })),
      }
    }

    /**
     * upsert：保存前把旧正文快照进 page_versions（版本即历史）。
     * 幂等：标题与正文均未变化时既不更新 updated_at、也不写历史。
     * 入参须已由 normalizeSaveFields 校验（服务与端点都走该校验）。
     */
    const savePage = (slug: string, input: WikiSaveInput): WikiSaveResult => {
      const now = new Date().toISOString()
      const outcome = db.transaction((): 'created' | 'updated' | 'unchanged' => {
        const existing = db.query<PageRow>('SELECT id, title, content FROM pages WHERE slug = ?', [slug])[0]
        if (!existing) {
          db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
            slug,
            input.title,
            input.content,
            now,
            now,
          ])
          return 'created'
        }
        // 幂等保存：标题与正文均未变化 → 不更新 updated_at、不写历史
        if (existing.title === input.title && existing.content === input.content) return 'unchanged'
        // 快照旧正文到版本历史，再更新页面
        db.run('INSERT INTO page_versions (page_id, content, saved_at) VALUES (?, ?, ?)', [
          existing.id,
          existing.content,
          now,
        ])
        db.run('UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?', [
          input.title,
          input.content,
          now,
          existing.id,
        ])
        return 'updated'
      })
      const version =
        (db.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = ?',
          [slug],
        )[0] as unknown as { n: number }).n + 1
      return { outcome, version }
    }

    /** 删除页面及其版本历史；返回是否确实删除（版本历史此处显式删除以防实现差异） */
    const deletePage = (slug: string): boolean =>
      db.transaction(() => {
        const page = db.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [slug])[0]
        if (!page) return false
        db.run('DELETE FROM page_versions WHERE page_id = ?', [page.id])
        db.run('DELETE FROM pages WHERE id = ?', [page.id])
        return true
      })

    /** 服务方法共用：卸载后任何仍持有 svc 引用的调用都应显式报错，而非返回空结果 */
    let disposed = false
    const assertLive = (): void => {
      if (disposed) {
        throw new Error('@geewiki/wiki: 插件已卸载，wiki-service 不可再调用（重新激活插件后再用）')
      }
    }

    /** 服务实例：契约见 {@link WikiService}（方法集与四个端点一一对应） */
    const svc: WikiService = {
      list: () => {
        assertLive()
        return listPages()
      },
      get: (slug) => {
        assertLive()
        return getPage(slug)
      },
      save: (slug, input) => {
        assertLive()
        assertValidSlug(slug)
        return savePage(slug, normalizeSaveFields(input?.title, input?.content))
      },
      remove: (slug) => {
        assertLive()
        assertValidSlug(slug)
        return deletePage(slug)
      },
    }

    /* ---------- GET /api/pages：列表 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages', (h) => {
        h.json(200, { pages: listPages() })
      }),
    )

    /* ---------- GET /api/pages/:slug：详情 + 最近版本历史 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug', (h) => {
        // 路由段存在即为字符串；`?? ''` 仅为类型收窄（无匹配行 → 404，与既有行为一致）
        const page = getPage(h.params.slug ?? '')
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${h.params.slug}` })
          return
        }
        h.json(200, page)
      }),
    )

    /* ---------- GET /api/pages/:slug/versions/:id：读取历史版本正文 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/versions/:id', (h) => {
        const page = db.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [h.params.slug])[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${h.params.slug}` })
          return
        }
        const version = db.query<{ id: number; content: string; saved_at: string }>(
          'SELECT id, content, saved_at FROM page_versions WHERE id = ? AND page_id = ?',
          [Number(h.params.id), page.id],
        )[0]
        if (!version) {
          h.json(404, { ok: false, error: 'not_found', message: `版本不存在: ${h.params.id}` })
          return
        }
        h.json(200, { id: version.id, content: version.content, saved_at: version.saved_at })
      }),
    )

    /* ---------- PUT /api/pages/:slug：upsert（保存时先快照旧正文，幂等：内容未变不产生新历史） ---------- */
    cleanups.push(
      router.register('PUT', '/api/pages/:slug', async (h) => {
        const slug = h.params.slug ?? ''
        if (!SLUG_RE.test(slug)) {
          h.json(400, {
            ok: false,
            error: 'invalid_slug',
            message: SLUG_HINT,
          })
          return
        }
        let save: WikiSaveInput
        try {
          save = parseSaveBody(await readBody(h))
        } catch (err) {
          const message = (err as Error).message
          if (message.startsWith('payload_too_large')) {
            // 请求体未读完且已暂停：经统一出口写出 413（计入 stats），随后关闭连接
            closeAfterResponse(h)
            h.json(413, { ok: false, error: 'payload_too_large', message })
            return
          }
          if (message.startsWith('content_too_large')) {
            // 正文过长与"请求体过大"是不同错误：按 error 分流的调用方不应混判
            h.json(413, { ok: false, error: 'content_too_large', message })
            return
          }
          h.json(400, { ok: false, error: 'invalid_body', message })
          return
        }
        const { outcome, version } = savePage(slug, save)
        h.json(200, { ok: true, slug, title: save.title, outcome, version })
      }),
    )

    /* ---------- DELETE /api/pages/:slug（版本历史依赖外键级联；此处显式事务删除以防实现差异） ---------- */
    cleanups.push(
      router.register('DELETE', '/api/pages/:slug', (h) => {
        const slug = h.params.slug ?? ''
        if (!deletePage(slug)) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, { ok: true, deleted: slug })
      }),
    )

    // 真正创建 cordis 服务：manifest 的 provides 只是依赖图 token，不会建服务。
    // 两者名字**必须一致**（'wiki-service'），否则消费方 ctx.get 拿到 undefined。
    const unprovide = ctx.provide('wiki-service', svc)

    console.log('[@geewiki/wiki] 已激活: GET /api/pages, GET/PUT/DELETE /api/pages/:slug, wiki-service 服务')
    return () => {
      // 先立"已卸载"标志：此后任何仍持有 svc 引用的调用都会显式报错而非返回空结果
      disposed = true
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      unprovide()
      console.log('[@geewiki/wiki] 已卸载: REST 路由全部摘除，wiki-service 已注销')
    }
  },
}
