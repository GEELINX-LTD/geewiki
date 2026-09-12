/**
 * 版本元数据与块级 diff 的**契约守卫**（源码级）。
 *
 * 这些断言守的不是"某段逻辑算得对"，而是**响应体里允许出现什么** —— 那类错误
 * 在单元测试里最难发现：字段多一个 `text`，所有既有断言照样全绿，而它泄露的是
 * 用户在正文里**看不到**的受限段落内容。
 *
 * 之所以能做源码级断言：本仓库的响应体是在处理器里**显式列举**字段构造的
 * （没有"把行对象整个 spread 出去"的写法）。那正是这条守卫成立的前提 ——
 * 一旦有人改成 spread，下面的窗口切片会抓不到字段、守卫随之失效，
 * 所以每个用例都带**反空洞断言**（先证明自己读到了目标代码）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { redactForAudit } from '@geewiki/core'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/** 取出 `from` 起、到下一个 `cleanups.push(` 之前的那段（= 一个端点的处理器体）。 */
function endpointBlock(from: string): string {
  const start = SRC.indexOf(from)
  assert.notEqual(start, -1, `反空洞：源码里应能定位到 ${from}`)
  const end = SRC.indexOf('cleanups.push(', start)
  assert.notEqual(end, -1, `反空洞：${from} 之后应还有下一个端点（用于界定切片）`)
  const block = SRC.slice(start, end)
  assert.ok(block.length > 300, `反空洞：切片过短（${block.length}），守卫会退化成恒真`)
  return block
}

/**
 * 取出某个端点**响应体字面量**的那一段（最后一个 `h.json(200, {` 起、到该端点切片末尾）。
 *
 * 为什么必须只取这一段：把整个处理器拿来正则匹配会误伤**实现代码** ——
 * 例如 diff 端点里 `t: String(b.t)` 是为了拿旧文本做比较，那不是响应字段。
 * 真正要守的是"**回给调用方的对象里有什么**"，所以只看 200 响应的字面量。
 */
function responseBlock(endpointFrom: string): string {
  const body = endpointBlock(endpointFrom)
  const start = body.lastIndexOf('h.json(200, {')
  assert.notEqual(start, -1, `反空洞：${endpointFrom} 应有 h.json(200, …) 响应`)
  const block = body.slice(start)
  assert.ok(block.length > 100, `反空洞：响应切片过短（${block.length}）`)
  return block
}

test('版本列表端点：回 number / origin / change，且不回正文', () => {
  const body = endpointBlock("router.register('GET', '/api/pages/:slug/versions',")
  // 必须有的字段（契约）
  for (const field of ['number:', 'origin:', 'change:', 'hasMore', 'saved_at:', 'author:']) {
    assert.ok(body.includes(field), `版本列表响应应包含 ${field}`)
  }
  // 不得回正文原文（列表是元数据，正文走单版本快照端点）。
  // 反空洞：先证明"切片里确实有 content 这个词可用"——否则下面那条否定断言可能
  // 只是因为切片里根本没有 content，属恒真。（`content:` 在 change 的计数里出现。）
  assert.ok(/\bcontent:\s/.test(body), '反空洞：切片里应有 content 相关字段可供否定断言')
  assert.ok(!/\bcontent:\s*v\.content\b/.test(body), '版本列表**不得**回正文原文')
})

test('★ 块级 diff 端点：绝不回块文本（安全硬规则）', () => {
  const body = endpointBlock("router.register('GET', '/api/pages/:slug/versions/:id/diff',")
  const response = responseBlock("router.register('GET', '/api/pages/:slug/versions/:id/diff',")
  /*
   * 只允许出现结构字段。逐个断言"不得出现"的形态 —— 包括：
   *   - `t:`（快照里块文本的字段名）
   *   - `text:`（更直白的写法）
   *   - `content:`（整个正文）
   * 左侧加词边界，避免把 `unchangedCount`/`comparedVersionId` 这类合法名字误伤。
   */
  for (const forbidden of [/\bt:\s/, /\btext:\s/, /\bcontent:\s/]) {
    assert.ok(
      !forbidden.test(response),
      `diff 响应**不得**包含块文本或正文（命中 ${String(forbidden)}）—— 那会让能编辑本页的人通过 diff 读到自己在正文里看不到的受限段落`,
    )
  }
  // 反向自证：把 `t` 加进响应就必须让这条断言变红（证明它不是恒真）
  assert.ok(
    /\bt:\s/.test(body.replace(response, '')),
    '反空洞：实现代码里确实出现了 `t:`（用于比较），说明这条守卫真的能分辨"响应"与"实现"',
  )
  /*
   * ★ 上面这三条 `不得出现` 的断言有一个**前提**：响应体是显式列举字段的字面量。
   *   一旦有人改成 `h.json(200, { ...something })`，被 spread 的字段不在切片里出现，
   *   守卫就**静默失效**（字段真的泄了却全绿）。所以这里把前提本身钉住。
   *   （原先还有一条 `!/\bbytes:\s*Number\(v\.bytes\)/` 的否定断言 —— 源码里从无该
   *   表达式，属恒真，已删；它的意图由上面的字段清单与这条 spread 守卫共同覆盖。）
   */
  assert.ok(
    !response.includes('...'),
    'diff 响应体必须是**显式列举字段**的字面量：出现 spread 会让"不得含块文本"的守卫静默失效',
  )
  // 反空洞：同时确认它确实在构造差异（否则"没有文本"只是因为什么都没写）
  for (const field of ['added', 'removed', 'modified', 'unchangedCount', 'no_previous', 'snapshot_incomplete']) {
    assert.ok(body.includes(field), `diff 端点应包含 ${field}`)
  }
})

test('块级 diff 按 ordinal 归并（而非内容哈希配对）', () => {
  const body = endpointBlock("router.register('GET', '/api/pages/:slug/versions/:id/diff',")
  /*
   * `lcsPairs` 按 (kind, contentHash) 配对：对"文本未动、只改了一档可见性"的块，
   * 两侧哈希相同 ⇒ 它不认为是同一块，会显示成"删一块 + 加一块"。
   * 这里钉住我们选的是 ordinal 归并。
   */
  assert.ok(body.includes('prevByOrdinal'), 'diff 应使用按 ordinal 的归并表')
  assert.ok(!body.includes('lcsPairs'), 'diff **不应**改用 lcsPairs（会把可见性变更误报成增删）')
})

test('版本号 number 由窗口函数算出，不在应用层用偏移量推', () => {
  const body = endpointBlock("router.register('GET', '/api/pages/:slug/versions',")
  assert.ok(body.includes('ROW_NUMBER() OVER (ORDER BY v.id DESC)'), 'number 必须来自 ROW_NUMBER（游标翻页后偏移量无从得知）')
  assert.ok(body.includes('total + 1 - Number(v.rn)'), 'number = total + 1 - rank')
})

test('游标分页用 before 而非 OFFSET（并发保存不跳条）', () => {
  const body = endpointBlock("router.register('GET', '/api/pages/:slug/versions',")
  assert.ok(body.includes("searchParams.get('before')"), '应支持 before 游标')
  assert.ok(body.includes('invalid_cursor'), '非法游标应显式 400（不静默取默认）')
  assert.ok(!/OFFSET\s+\?/i.test(body), '**不得**用 OFFSET 分页（并发保存时会跳条/重复）')
})

test('作者显示名对普通成员置空（不开口子枚举组织成员）', () => {
  const body = endpointBlock("router.register('GET', '/api/pages/:slug/versions',")
  assert.ok(body.includes('viewerIsAdmin'), '应有"查看者是否管理员"的判据')
  assert.ok(
    body.includes('viewerIsAdmin || Number(v.author_id) === viewer.userId'),
    'displayName 仅对本人与 owner/admin 下发，其余置 null',
  )
})

test('★ 恢复历史版本产生的快照必须标 origin=content（两条分支都要）', () => {
  /*
   * 背景（真机实测过的缺陷）：`snapshotAclVersion` 原先把 INSERT 里的 `origin` 写成
   * 字面量 `'acl'`，而它的调用点里有**两条是"恢复历史版本"** —— 那两条在写完快照后
   * 紧接着 `UPDATE pages SET content = …`，改的就是正文。错标成 `'acl'` 的后果是
   * 界面告诉用户"这次只动了权限"，恰好说反。
   *
   * 现在改为**参数传入**（`origin: VersionOrigin = 'acl'`），所以守卫也要跟着改：
   * 断言的重点从"字面量是什么"变成"**哪些调用点传了 content**"。
   */
  const calls = SRC.match(/snapshotAclVersion\([^)]*\)/g) ?? []
  assert.ok(calls.length >= 8, `反空洞：snapshotAclVersion 调用点应至少有 8 处（实际 ${calls.length}）`)

  const contentCalls = calls.filter((c) => c.includes("'content'"))
  assert.equal(
    contentCalls.length,
    2,
    `恰好两条恢复分支传 'content'（实际 ${contentCalls.length} 条：${contentCalls.join(' | ')}）`,
  )
  for (const call of contentCalls) {
    assert.ok(call.includes('tx'), `恢复分支的调用应带事务参数：${call}`)
  }
  /*
   * 反空洞：确认这两处**真的是恢复路径**，而不是随便两处被贴上了 'content'
   * （否则守卫可以被"给任意两个调用点加参数"骗过）。
   */
  for (const marker of ['恢复前记一条', '恢复前先记一条']) {
    assert.ok(SRC.includes(marker), `反空洞：应有恢复路径的注释标记「${marker}」`)
  }
  // 默认值仍必须是 'acl'：改权限的路径不该被迫逐个传参，也就不会有人漏传成 content
  assert.match(
    SRC,
    /origin: VersionOrigin = 'acl',/,
    "snapshotAclVersion 的 origin 默认值必须是 'acl'（受控枚举，不让调用方随手写字符串）",
  )
  // 受控枚举真的存在（而不是让调用方传裸字符串）
  assert.match(SRC, /export const VERSION_ORIGINS = \['content', 'acl'\] as const/, 'origin 取值必须是受控枚举')
})

test('两处版本写入点都写了 origin（content / acl）', () => {
  const inserts = SRC.match(/INSERT INTO page_versions[^`]*/g) ?? []
  assert.equal(inserts.length, 2, `page_versions 的写入点应恰好 2 处（实际 ${inserts.length}）`)
  for (const sql of inserts) {
    assert.ok(sql.includes('origin'), `每个写入点都必须写 origin：${sql}`)
  }
  // savePage 的快照恒为正文改动
  assert.ok(SRC.includes("'content')`"), "savePage 的快照 INSERT 应写入 origin='content'")
  /*
   * `snapshotAclVersion` 的 INSERT 现在用**占位符**（值由参数传），所以这里断言的是
   * "它没有再把来源写死成字面量" —— 那正是原缺陷的形态。
   */
  const snapshotInsert = inserts.find((s) => s.includes('blocks_json, acl_json, saved_by, title, origin'))
  assert.ok(snapshotInsert !== undefined, '反空洞：应能定位到 snapshotAclVersion 的 INSERT')
  assert.ok(
    !/origin\)\s*VALUES[\s\S]*'acl'/.test(snapshotInsert),
    "snapshotAclVersion 不得再把 origin 写死成 'acl' 字面量（恢复路径改正文，会被说成只动权限）",
  )
})

test('★ 审计安全网：content_hash 这类"带前缀的哈希"必须被脱敏删掉', () => {
  /*
   * 实测踩过的缺陷：`page.delete` 的审计 `after` 里落进了整串 sha256（`content_hash`），
   * 而相邻注释声称"不记 hash"。根因是 `redactForAudit` 的匹配是 `key.toLowerCase()`
   * 的**精确相等**（不含子串）—— 于是 `hash` 被禁，`content_hash` 却漏了过去。
   *
   * 这里直接打安全网本身（而不是只看 `page.delete` 那一处）：任何调用方不慎把整个
   * 行对象塞进 `before`/`after`，都不该让内容指纹落进长期留存的审计表。
   */
  const redacted = redactForAudit({
    title: '审计页', // 非敏感键必须原样保留（否则这条测试会因为"全删"而假绿）
    versions: 0,
    bytes: 25,
    content_hash: 'e38dd1ff023bade9d98db3537bdb9a595699ff249417503453bbfce933c305d4',
    // 嵌套与数组两条路径都要覆盖：脱敏是逐层递归的
    nested: { CONTENT_HASH: 'y', keep: 'ok' },
    list: [{ content_hash: 'z', keep: 1 }],
  }) as Record<string, unknown>

  const flat = JSON.stringify(redacted)
  assert.ok(!flat.includes('content_hash'), 'content_hash 必须被删掉')
  assert.ok(!flat.includes('CONTENT_HASH'), '大小写变体同样要删（匹配走 toLowerCase）')
  assert.ok(!flat.includes('e38dd1ff'), '哈希值本身不得出现在序列化结果里')
  // 反向自证：非敏感字段必须活着，证明这条断言不是"整个对象被清空"造成的假绿
  assert.equal(redacted.title, '审计页', '非敏感字段应原样保留')
  assert.equal(redacted.bytes, 25, '非敏感字段应原样保留')
  assert.equal((redacted.nested as Record<string, unknown>).keep, 'ok', '嵌套层的非敏感字段应保留')
  assert.equal((redacted.list as Record<string, unknown>[])[0]!.keep, 1, '数组元素的非敏感字段应保留')
})

test('page.delete 的审计不再写入 content_hash（源码级）', () => {
  const block = endpointBlock("router.register('DELETE', '/api/pages/:slug',")
  // 反空洞：先证明切片里有那个 after 字面量
  assert.ok(block.includes('action: \'page.delete\''), '反空洞：应定位到 page.delete 的审计写入')
  assert.ok(!block.includes('content_hash'), 'page.delete 的审计不得再引用 content_hash')
  assert.ok(!block.includes('contentHash'), 'page.delete 的审计不得再引用 contentHash')
  // 但"被删了什么"的可读摘要必须还在（别把有用的信息一起删了）
  for (const field of ['title:', 'versions:', 'bytes:', 'created_at:']) {
    assert.ok(block.includes(field), `page.delete 的审计应保留 ${field}`)
  }
})

test('迁移双方言成对：0021 给 page_versions 加 origin', () => {
  const sqlite = readFileSync(join(here, '..', '..', 'db-sqlite', 'src', 'migrations', '0021_version_origin.sql'), 'utf8')
  const pg = readFileSync(join(here, '..', '..', 'db-postgres', 'migrations', '0021_version_origin.sql'), 'utf8')
  for (const [name, sql] of [
    ['sqlite', sqlite],
    ['postgres', pg],
  ] as const) {
    assert.match(sql, /ALTER TABLE page_versions ADD COLUMN origin TEXT;/, `${name} 侧应加 origin 列`)
    // 反空洞：确认读到的是真文件而不是空串
    assert.ok(sql.length > 300, `${name} 侧迁移文件过短（${sql.length}）`)
  }
})
