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
 */
import type { Context } from 'cordis'
import { type DatabaseAdapter, type GeeWikiManifest, type HttpRouterService, type RouteHandlerContext } from '@geewiki/core'

export interface WikiConfig {
  /** 页面详情中返回的最近版本历史条数上限 */
  recentVersions?: number
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
    configSchema: {
      type: 'object',
      properties: {
        recentVersions: { type: 'number', title: '版本历史返回条数' },
      },
    },
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

/** 读取并解析 JSON 请求体（超限/畸形抛错，由路由层统一 500/400 处理） */
function readBody(req: RouteHandlerContext['req'], limit = 1_000_000): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('request_body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        rejectBody(new Error(`invalid_json: ${(err as Error).message}`))
      }
    })
    req.on('error', rejectBody)
  })
}

/** slug 服务端校验正则（与前端 WikiPage 一致）：字母/数字开头，仅 a-z 0-9 . _ -，≤80 字符 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

/** 从请求体提取 { title, content }：白名单字段，未知字段/超限一律 400 */
function parseSaveBody(body: unknown): { title: string; content: string } {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b !== 'object' || Array.isArray(b)) {
    throw new Error('invalid_body: 请求体须为 JSON 对象')
  }
  const unknown = Object.keys(b).filter((k) => k !== 'title' && k !== 'content')
  if (unknown.length > 0) {
    throw new Error(`invalid_body: 未知字段: ${unknown.join(', ')}`)
  }
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  const content = typeof b.content === 'string' ? b.content : ''
  if (!title) throw new Error('invalid_title: 标题不能为空')
  if (title.length > 200) throw new Error('invalid_title: 标题过长（≤200 字符）')
  if (content.length > 500_000) throw new Error('invalid_content: 正文过长（≤500KB）')
  return { title, content }
}

export const WikiPlugin = {
  name: '@geewiki/wiki',

  apply(ctx: Context, config: WikiConfig = {}) {
    const db = ctx.get('db') as DatabaseAdapter | undefined
    if (!db) throw new Error('@geewiki/wiki: 数据库服务不可用（@geewiki/db-sqlite 未激活）')
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/wiki: http 路由服务不可用（@geewiki/http 未激活）')
    const recentLimit = config.recentVersions ?? 10

    const cleanups: (() => void)[] = []

    /* ---------- GET /api/pages：列表 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages', (h) => {
        const rows = db.query<PageRow>(
          `SELECT p.id, p.slug, p.title, p.created_at, p.updated_at,
                  (SELECT COUNT(*) FROM page_versions v WHERE v.page_id = p.id) AS version_count
             FROM pages p ORDER BY p.updated_at DESC`,
        )
        h.json(200, {
          pages: rows.map((r) => ({
            slug: r.slug,
            title: r.title,
            updated_at: r.updated_at,
            version: Number((r as unknown as { version_count: number }).version_count) + 1, // 版本 = 历史快照数 + 1
          })),
        })
      }),
    )

    /* ---------- GET /api/pages/:slug：详情 + 最近版本历史 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug', (h) => {
        const page = db.query<PageRow>('SELECT * FROM pages WHERE slug = ?', [h.params.slug])[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${h.params.slug}` })
          return
        }
        const versions = db.query<{ id: number; saved_at: string }>(
          `SELECT id, saved_at FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT ?`,
          [page.id, recentLimit],
        )
        const totalVersions = (
          db.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', [page.id])[0] as unknown as { n: number }
        ).n
        h.json(200, {
          slug: page.slug,
          title: page.title,
          content: page.content,
          created_at: page.created_at,
          updated_at: page.updated_at,
          version: totalVersions + 1,
          versions: versions.map((v) => ({ id: v.id, saved_at: v.saved_at })),
        })
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
            message: '页面标识非法：须以字母或数字开头，仅含 a-z 0-9 . _ -，≤80 字符',
          })
          return
        }
        let save: { title: string; content: string }
        try {
          save = parseSaveBody(await readBody(h.req))
        } catch (err) {
          h.json(400, { ok: false, error: 'invalid_body', message: (err as Error).message })
          return
        }
        const now = new Date().toISOString()
        const outcome = db.transaction((): 'created' | 'updated' | 'unchanged' => {
          const existing = db.query<PageRow>('SELECT id, title, content FROM pages WHERE slug = ?', [slug])[0]
          if (!existing) {
            db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
              slug,
              save.title,
              save.content,
              now,
              now,
            ])
            return 'created'
          }
          // 幂等保存：标题与正文均未变化 → 不更新 updated_at、不写历史
          if (existing.title === save.title && existing.content === save.content) return 'unchanged'
          // 快照旧正文到版本历史，再更新页面
          db.run('INSERT INTO page_versions (page_id, content, saved_at) VALUES (?, ?, ?)', [
            existing.id,
            existing.content,
            now,
          ])
          db.run('UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?', [
            save.title,
            save.content,
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
        h.json(200, { ok: true, slug, title: save.title, outcome, version })
      }),
    )

    /* ---------- DELETE /api/pages/:slug（版本历史依赖外键级联；此处显式事务删除以防实现差异） ---------- */
    cleanups.push(
      router.register('DELETE', '/api/pages/:slug', (h) => {
        const slug = h.params.slug ?? ''
        const deleted = db.transaction(() => {
          const page = db.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [slug])[0]
          if (!page) return false
          db.run('DELETE FROM page_versions WHERE page_id = ?', [page.id])
          db.run('DELETE FROM pages WHERE id = ?', [page.id])
          return true
        })
        if (!deleted) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, { ok: true, deleted: slug })
      }),
    )

    console.log('[@geewiki/wiki] 已激活: GET /api/pages, GET/PUT/DELETE /api/pages/:slug')
    return () => {
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      console.log('[@geewiki/wiki] 已卸载: REST 路由全部摘除')
    }
  },
}
