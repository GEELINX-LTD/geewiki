import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PAGE_SAVED_EVENT, anonymousPrincipal } from '@geewiki/core'
import type { DatabaseAdapterAsync, PageSavedEvent, Principal, WikiService } from '@geewiki/core'
import { PostgresDatabase, resolveConnection } from '@geewiki/postgres'
import { defaultRegistry, startServer } from '../src/index.js'
import { freePort } from './helpers.js'

const alice: Principal = {
  kind: 'user', userId: 1, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null,
}
const bob: Principal = { ...alice, userId: 2 }

test('真实 PostgreSQL：独立宿主的页面并发、授权与回滚', { timeout: 60_000 }, async (t) => {
  assert.ok(process.env.PGDATABASE, '必须显式设置 PGDATABASE（控制库）；测试账号需要建库权限')
  const port = Number(process.env.PGPORT ?? 5432)
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'PGPORT 必须是有效端口')
  const config = {
    host: process.env.PGHOST ?? '127.0.0.1', port,
    user: process.env.PGUSER ?? 'geewiki', passwordEnv: 'GEEWIKI_TEST_PG_PASSWORD',
    max: 5, connectionTimeoutMillis: 3_000,
  }
  // 插件配置要求带下划线的变量名；将标准 PGPASSWORD 只在测试进程内映射。
  const connectionEnv = { ...process.env, GEEWIKI_TEST_PG_PASSWORD: process.env.PGPASSWORD ?? '' }
  const admin = new PostgresDatabase(resolveConnection({ ...config, database: process.env.PGDATABASE }, connectionEnv))
  // 只对本次随机生成的标识符拼接 DDL；指定的控制库不做迁移或业务数据清理。
  const database = `gw_writes_${randomBytes(8).toString('hex')}`
  const control = new PostgresDatabase(resolveConnection({ ...config, database }, connectionEnv))
  const dir = mkdtempSync(join(tmpdir(), 'gw-postgres-writes-'))
  const oldDataDir = process.env.GEEWIKI_DATA_DIR
  const oldPassword = process.env.GEEWIKI_TEST_PG_PASSWORD
  const handles: Awaited<ReturnType<typeof startServer>>[] = []
  const saved: PageSavedEvent[] = []
  let created = false

  try {
    await admin.run(`CREATE DATABASE "${database}"`)
    created = true
    await admin.run(`ALTER DATABASE "${database}" SET statement_timeout = '10s'`)
    process.env.GEEWIKI_DATA_DIR = join(dir, 'data')
    process.env.GEEWIKI_TEST_PG_PASSWORD = connectionEnv.GEEWIKI_TEST_PG_PASSWORD
    const names = ['@geewiki/postgres', '@geewiki/http', '@geewiki/authz', '@geewiki/wiki']
    for (const index of [0, 1]) {
      const configDir = join(dir, `host-${index}`)
      mkdirSync(configDir)
      writeFileSync(join(configDir, 'plugins.base.json'), JSON.stringify({
        enabled: names.map((name) => name === '@geewiki/postgres'
          ? { name, config: { ...config, database } }
          : { name }),
      }))
      const httpPort = await freePort()
      const handle = await startServer({
        configDir, port: httpPort, host: '127.0.0.1', pluginsDir: null, webDist: null,
        registry: defaultRegistry(null, { port: httpPort, host: '127.0.0.1' })
          .filter((entry) => names.includes(entry.name)),
        requiredServices: ['http', 'db', 'policy-service', 'wiki-service'],
      })
      handles.push(handle)
      handle.app.on(PAGE_SAVED_EVENT, (event) => { saved.push(event) })
    }
    const [first, second] = handles
    assert.ok(first && second)
    const a = first.app.get('wiki-service') as WikiService
    const b = second.app.get('wiki-service') as WikiService
    const dbA = first.app.get('db') as DatabaseAdapterAsync
    const dbB = second.app.get('db') as DatabaseAdapterAsync
    for (const [id, name] of [[1, 'Alice'], [2, 'Bob']] as const) {
      await control.run(
        'INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)',
        [id, `${name.toLowerCase()}@example.test`, name, new Date().toISOString()],
      )
    }

    const read = async (wiki: WikiService, slug: string) => {
      const page = await wiki.get(slug, alice, { rawContent: true })
      assert.ok(page, `${slug} 应可读取`)
      assert.equal(page.contentMode, 'raw')
      assert.equal(typeof page.revision, 'string')
      return page
    }
    const snapshot = async (slug: string) => ({
      pages: await control.query('SELECT * FROM pages WHERE slug = ?', [slug]),
      versions: await control.query(
        'SELECT v.* FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = ? ORDER BY v.id', [slug],
      ),
      blocks: await control.query(
        'SELECT b.* FROM blocks b JOIN pages p ON p.id = b.page_id WHERE p.slug = ? ORDER BY b.id', [slug],
      ),
      links: await control.query('SELECT * FROM page_links WHERE source_slug = ? ORDER BY target_slug', [slug]),
    })
    const eventsFor = (slug: string) => saved.filter((event) => event.slug === slug)

    /** SHARE 不阻止读或 SELECT FOR UPDATE，但会阻止 INSERT/UPDATE。
     * 等两个真实后端均进入锁等待后释放，避免 Promise.all 碰巧串行而得到假绿。 */
    const contend = async <T,>(writes: [() => Promise<T>, () => Promise<T>]) => {
      let results: Promise<PromiseSettledResult<T>[]> | undefined
      try {
        await control.transaction(async (tx) => {
          await tx.run('LOCK TABLE pages IN SHARE MODE')
          results = Promise.allSettled(writes.map((write) => write()))
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const [row] = await admin.query<{ n: string }>(
              `SELECT COUNT(*) AS n FROM pg_stat_activity
               WHERE datname = ? AND wait_event_type = 'Lock'`, [database],
            )
            if (Number(row?.n) >= 2) return
            await delay(20)
          }
          assert.fail('两个独立写事务未同时进入 PostgreSQL 锁等待')
        })
        assert.ok(results)
        return await results
      } finally {
        // 断言失败也先释放表锁并等写事务结算，再清理宿主与数据库。
        if (results) await results
      }
    }

    await t.test('连接到真实 PostgreSQL，两个宿主持有不同的后端连接', async () => {
      const [[left], [right]] = await Promise.all([
        dbA.query<{ pid: number; name: string; version: string }>(
          'SELECT pg_backend_pid() AS pid, current_database() AS name, version() AS version',
        ),
        dbB.query<{ pid: number; name: string; version: string }>(
          'SELECT pg_backend_pid() AS pid, current_database() AS name, version() AS version',
        ),
      ])
      assert.ok(left && right)
      assert.equal(left.name, database)
      assert.equal(right.name, database)
      assert.notEqual(left.pid, right.pid)
      assert.match(left.version, /^PostgreSQL /)
      assert.equal(dbA.dialect, 'postgres')
      assert.equal(dbB.dialect, 'postgres')
    })

    await t.test('同基线更新只成功一次，冲突不增加历史、块、出链或事件', async () => {
      const slug = 'concurrent-update'
      const original = { title: '原题', content: '原文 [[original-target]]', expectedRevision: null }
      await a.saveAs(alice, slug, original)
      const baselineA = await read(a, slug)
      const baselineB = await read(b, slug)
      assert.equal(baselineA.revision, baselineB.revision)
      const candidates = [
        { title: 'Alice 修改', content: 'Alice 正文 [[alice-target]]', actor: alice },
        { title: 'Bob 修改', content: 'Bob 正文 [[bob-target]]', actor: bob },
      ] as const
      const results = await contend([
        () => a.saveAs(alice, slug, { ...candidates[0], expectedRevision: baselineA.revision }),
        () => b.saveAs(bob, slug, { ...candidates[1], expectedRevision: baselineB.revision }),
      ])
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      const success = results.find((result) => result.status === 'fulfilled')
      assert.ok(success?.status === 'fulfilled')
      assert.equal(success.value.version, 2)
      const conflict = results.find((result) => result.status === 'rejected')
      assert.ok(conflict?.status === 'rejected')
      assert.equal(conflict.reason.code, 'edit_conflict')
      const winner = candidates[results.findIndex((result) => result.status === 'fulfilled')]
      assert.ok(winner)
      const current = await read(b, slug)
      assert.equal(current.title, winner.title)
      assert.equal(current.content, winner.content)
      assert.equal(current.version, 2)
      assert.equal(typeof current.version, 'number')
      assert.equal(current.versions.length, 1)
      assert.equal(current.versions[0]?.title, original.title)
      const [history] = await control.query<{ content: string }>(
        'SELECT v.content FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = ?', [slug],
      )
      assert.equal(history?.content, original.content)
      assert.equal(current.versions[0]?.author?.id, winner.actor.userId)
      const blocks = await control.query<{ text: string; updated_by: number }>(
        'SELECT b.text, b.updated_by FROM blocks b JOIN pages p ON p.id = b.page_id WHERE p.slug = ?', [slug],
      )
      assert.ok(blocks.length > 0)
      for (const block of blocks) {
        assert.ok(block.text.includes(winner.actor.userId === 1 ? 'Alice' : 'Bob'))
        assert.equal(block.updated_by, winner.actor.userId)
      }
      assert.equal(eventsFor(slug).length, 2)
      assert.equal(eventsFor(slug)[1]?.actorId, winner.actor.userId)
      const links = await b.links(slug, alice)
      assert.deepEqual(links?.map((link) => link.slug), [winner.actor.userId === 1 ? 'alice-target' : 'bob-target'])
      const beforeRetry = await snapshot(slug)
      await assert.rejects(a.saveAs(alice, slug, {
        title: '过期重试', content: '不应写入 [[stale-target]]', expectedRevision: baselineA.revision,
      }), { code: 'edit_conflict' })
      assert.deepEqual(await snapshot(slug), beforeRetry)
      assert.equal(eventsFor(slug).length, 2)
    })

    await t.test('同名创建只成功一次，唯一约束冲突被翻译为 edit_conflict', async () => {
      const slug = 'concurrent-create'
      const results = await contend([
        () => a.saveAs(alice, slug, { title: 'Alice 新建', content: 'Alice 初稿 [[alice-new]]', expectedRevision: null }),
        () => b.saveAs(bob, slug, { title: 'Bob 新建', content: 'Bob 初稿 [[bob-new]]', expectedRevision: null }),
      ])
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      const conflict = results.find((result) => result.status === 'rejected')
      assert.ok(conflict?.status === 'rejected')
      assert.equal(conflict.reason.code, 'edit_conflict')
      const current = await read(a, slug)
      const aliceWon = results[0]?.status === 'fulfilled'
      assert.equal(current.content, aliceWon ? 'Alice 初稿 [[alice-new]]' : 'Bob 初稿 [[bob-new]]')
      assert.equal(current.version, 1)
      assert.equal(current.versions.length, 0)
      assert.equal(eventsFor(slug).length, 1)
      const beforeRetry = await snapshot(slug)
      await assert.rejects(b.saveAs(bob, slug, {
        title: '重复新建', content: '不应覆盖', expectedRevision: null,
      }), { code: 'edit_conflict' })
      assert.deepEqual(await snapshot(slug), beforeRetry)
    })

    await t.test('删除后重建相同内容，旧令牌不能写入新页面', async () => {
      const slug = 'recreated-page'
      const input = { title: '相同标题', content: '相同正文', expectedRevision: null }
      await a.saveAs(alice, slug, input)
      const oldPage = await read(a, slug)
      const [oldRow] = await control.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug])
      assert.equal(await b.removeAs(bob, slug), true)
      assert.equal(await a.exists(slug), false)
      await b.saveAs(bob, slug, input)
      // 连时间戳也相同，令牌仍须区分两次创建的页面身份。
      await control.run('UPDATE pages SET created_at = ?, updated_at = ? WHERE slug = ?',
        [oldPage.created_at, oldPage.updated_at, slug])
      const current = await read(b, slug)
      const [newRow] = await control.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug])
      assert.ok(oldRow && newRow)
      assert.notEqual(newRow.id, oldRow.id)
      assert.notEqual(current.revision, oldPage.revision)
      const before = await snapshot(slug)
      await assert.rejects(a.saveAs(alice, slug, {
        title: '旧编辑器', content: '不应覆盖重建页', expectedRevision: oldPage.revision,
      }), { code: 'edit_conflict' })
      assert.deepEqual(await snapshot(slug), before)
    })

    await t.test('真实策略服务拒绝只读主体保存或删除，匿名不能创建', async () => {
      const slug = 'read-only-page'
      await a.save(slug, { title: '只读授权', content: '可读但不可改', visibility: 'private' })
      await control.run(
        `INSERT INTO page_grants (page_slug, subject_kind, subject_id, role, granted_by, granted_at)
         VALUES (?, 'user', ?, 'viewer', ?, ?)`,
        [slug, String(bob.userId), alice.userId, new Date().toISOString()],
      )
      const visible = await b.get(slug, bob, { rawContent: true })
      assert.ok(visible, '先证明 viewer 授权能读取，避免把未创建误判成权限正确')
      assert.equal(visible.content, '可读但不可改')
      assert.equal(visible.revision, undefined)
      const before = await snapshot(slug)
      await assert.rejects(b.saveAs(bob, slug, { title: '越权修改', content: '不应写入' }), { code: 'forbidden' })
      await assert.rejects(b.removeAs(bob, slug), { code: 'forbidden' })
      await assert.rejects(a.saveAs(anonymousPrincipal(), 'anonymous-page', {
        title: '匿名创建', content: '不应写入', expectedRevision: null,
      }), { code: 'unauthorized' })
      assert.equal(await a.exists('anonymous-page'), false)
      assert.deepEqual(await snapshot(slug), before)
      assert.equal(eventsFor(slug).length, 1)
    })

    await t.test('写出链失败时页面、历史、块一起回滚，连接仍可继续保存', async () => {
      const slug = 'rollback-page'
      await a.saveAs(alice, slug, { title: '回滚前', content: '原文 [[before-target]]', expectedRevision: null })
      const baseline = await read(a, slug)
      const before = await snapshot(slug)
      await control.run(`CREATE FUNCTION reject_acceptance_link() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced-link-failure' USING ERRCODE = '23514'; END;
      $$`)
      await control.run(`CREATE TRIGGER reject_acceptance_link BEFORE INSERT ON page_links
        FOR EACH ROW WHEN (NEW.source_slug = 'rollback-page') EXECUTE FUNCTION reject_acceptance_link()`)
      try {
        await assert.rejects(b.saveAs(bob, slug, {
          title: '应回滚', content: '已改块 [[after-target]]', expectedRevision: baseline.revision,
        }), /forced-link-failure/)
        assert.deepEqual(await snapshot(slug), before)
        assert.equal(eventsFor(slug).length, 1)
      } finally {
        await control.run('DROP TRIGGER reject_acceptance_link ON page_links')
        await control.run('DROP FUNCTION reject_acceptance_link()')
      }
      const result = await b.saveAs(bob, slug, {
        title: '恢复保存', content: '有效修改 [[after-target]]', expectedRevision: baseline.revision,
      })
      assert.equal(result.outcome, 'updated')
      assert.equal(result.version, 2)
      assert.equal((await read(a, slug)).content, '有效修改 [[after-target]]')
      assert.equal(eventsFor(slug).length, 2)
    })
  } finally {
    try {
      await Promise.all(handles.map((handle) => handle.dispose()))
    } finally {
      try {
        await control.close()
        if (created) await admin.run(`DROP DATABASE "${database}" WITH (FORCE)`)
      } finally {
        try {
          await admin.close()
        } finally {
          if (oldDataDir === undefined) delete process.env.GEEWIKI_DATA_DIR
          else process.env.GEEWIKI_DATA_DIR = oldDataDir
          if (oldPassword === undefined) delete process.env.GEEWIKI_TEST_PG_PASSWORD
          else process.env.GEEWIKI_TEST_PG_PASSWORD = oldPassword
          rmSync(dir, { recursive: true, force: true })
        }
      }
    }
  }
})
