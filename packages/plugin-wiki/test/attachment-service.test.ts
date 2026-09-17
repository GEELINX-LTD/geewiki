/**
 * `attachment-service` 契约（★ F4）的守卫。
 *
 * 这一组用例钉的**不是**"字节写没写对"（那是 `attachments.test.ts` 的 storeStream 系列），
 * 而是"换成另一个实现之后还成不成立" —— 即**契约本身**的三条不可静默失守的性质：
 *
 * 1. `createFsAttachmentService` 真的实现了 `AttachmentService`
 *    （`ready` / `put` / `get` / `remove` 四条，且 `get` 的长度与开流来自同一次探测）。
 * 2. **错误类是同一个对象**：实现方抛的错，端点的 `err instanceof AttachmentStoreError`
 *    必须命中。若替换实现自己造一个同名类，`instanceof` 会**静默**失配 ⇒ 存储层的
 *    413/400/503 全部退化成 500，并计进 `stats().consecutiveFailures`（磁盘满 → 整站熔断）。
 *    这类缺陷在"只测内置实现"的测试里**测不出来**，只能靠钉"类对象同一性"。
 * 3. `get()` 对"元数据在、字节不在"返回 `undefined` 而**不是抛错** ——
 *    端点据此回 404 `blob_missing`（可诊断状态），而不是让调用方去猜一个流错误。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AttachmentServiceError, type AttachmentService } from '@geewiki/core'
import {
  AttachmentStoreError,
  createFsAttachmentService,
} from '../src/attachment-store.js'
import { resolveAttachmentPath } from '../src/attachments.js'

function bodyOf(bytes: Buffer): Readable {
  return Readable.from([bytes])
}

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gw-atsvc-'))
}

test('错误类同一性：AttachmentStoreError 就是 core 的 AttachmentServiceError', () => {
  /*
   * 这条断言看着"同义反复"，但它**恰好是**替换实现最容易踩的坑：
   * `attachment-store.ts` 用 `export { AttachmentServiceError as AttachmentStoreError }`
   * 转出（而不是本地 `class AttachmentStoreError`），所以两侧拿到的是**同一个类对象**。
   * 一旦有人为了"省一次跨包 import"把类搬回本地，这条会红 —— 而那正是需要被拦住的时刻。
   */
  assert.equal(AttachmentStoreError, AttachmentServiceError)
})

test('createFsAttachmentService：ready → put → get → remove 全链路', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    const svc: AttachmentService = createFsAttachmentService({ dataDir, tmpDir })

    // ready 建目录（幂等）：调用两次不应抛
    await svc.ready()
    await svc.ready()

    const bytes = Buffer.from('attachment-service 契约', 'utf8')
    const stored = await svc.put(bodyOf(bytes), { maxBytes: 1024, ext: '.txt' })
    assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(stored.byteSize, bytes.length)
    assert.equal(stored.dedup, false)

    // 同一内容再放一次：幂等去重，磁盘上不产生第二份；tmp 不留残渣
    const again = await svc.put(bodyOf(bytes), { maxBytes: 1024, ext: '.txt' })
    assert.equal(again.sha256, stored.sha256)
    assert.equal(again.dedup, true)
    assert.deepEqual(await readdir(tmpDir), [])

    // get：size 与 open() 来自同一次探测（端点据此写 Content-Length 并伺服字节）
    const blob = await svc.get(stored.sha256, '.txt')
    assert.ok(blob, '已 put 的对象必须能取到')
    assert.equal(blob.size, bytes.length)
    const chunks: Buffer[] = []
    for await (const c of blob.open()) chunks.push(c as Buffer)
    assert.deepEqual(Buffer.concat(chunks), bytes)

    // remove 幂等：删两次都成功
    await svc.remove(stored.sha256, '.txt')
    await svc.remove(stored.sha256, '.txt')
    assert.equal(await svc.get(stored.sha256, '.txt'), undefined)

    // 落盘位置仍在 `<dataDir>/attachments/` 之内（契约搬走了，寻址口径没变）
    assert.equal(
      resolveAttachmentPath(dataDir, stored.sha256, '.txt').startsWith(join(dataDir, 'attachments')),
      true,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createFsAttachmentService：get 对缺失对象返回 undefined（不抛错）', async () => {
  const root = await tmpRoot()
  try {
    const svc = createFsAttachmentService({ dataDir: join(root, 'data'), tmpDir: join(root, 'tmp') })
    const missing = 'a'.repeat(64)
    assert.equal(await svc.get(missing, '.txt'), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createFsAttachmentService：超限与长度不符各自抛对应 code', async () => {
  const root = await tmpRoot()
  try {
    const svc = createFsAttachmentService({ dataDir: join(root, 'data'), tmpDir: join(root, 'tmp') })

    await assert.rejects(
      () => svc.put(bodyOf(Buffer.alloc(4096, 0x41)), { maxBytes: 1024, ext: '.txt' }),
      (err: unknown) => err instanceof AttachmentServiceError && err.code === 'payload_too_large',
    )

    await assert.rejects(
      () =>
        svc.put(bodyOf(Buffer.from('12', 'utf8')), { maxBytes: 1024, ext: '.txt', expectedBytes: 5 }),
      (err: unknown) => err instanceof AttachmentServiceError && err.code === 'length_mismatch',
    )

    // 两次失败都不该在最终内容路径下留下任何对象（临时文件也已由存储层清掉）
    assert.deepEqual(await readdir(join(root, 'data')), ['attachments'])
    assert.deepEqual(await readdir(join(root, 'data', 'attachments')), [])
    assert.deepEqual(await readdir(join(root, 'tmp')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* --------------------- 激活期探针：cordis 时序陷阱 --------------------- */

/**
 * ★ 活捉一个真回归（2026 轮次）：激活期探针**曾经走 `ctx.get` 去拿本插件刚
 * `provide` 出去的服务**，而 cordis 里插件在**自己的 `apply` 结算之前**看不到它。
 *
 * 后果有两个，都在**默认可用的路径**上（不是边界情况）：
 * 1. 每次启动都打一条**假警报**（"上传将返回 503 storage_unavailable"），并把它归因到
 *    一个取值本来就是 `builtin` 的配置项 —— 操作者会被引去检查一个本来就对的配置；
 * 2. 探针**真正的用途**（检查附件目录可写）**从未执行**：它在 `ready()` 之前就抛了。
 *    于是"数据目录只读"这个它专程要报的场景反而不会被报出来。
 *
 * 它不是功能故障（请求期服务已可见，实测 `GET /api/attachments/<不存在>` 返回 404 而非 503），
 * 而是**观测故障**：一条永远响、且指向错误方向的警报。
 *
 * 这一组用例把"探针不能走 ctx.get"这条**判据**钉住，而不是只钉住"这次的写法"。
 */
test('★ 附件探针：插件在【自己的 apply 里】ctx.get 不到自己刚 provide 的服务（时序陷阱本体）', async () => {
  const { Context } = await import('cordis')
  const app = new Context()
  const SERVICE = 'geewiki-attachment-probe-test-service'
  const observed: { duringApply: unknown; afterSettle: unknown } = {
    duringApply: undefined,
    afterSettle: undefined,
  }

  const plugin = {
    name: 'provides-and-reads-own-service',
    apply(ctx: InstanceType<typeof Context>) {
      // 与本插件 F4 的写法完全同构：先 provide，再在同一个 apply 里 get
      ctx.provide(SERVICE, { ready: async () => {} })
      observed.duringApply = ctx.get(SERVICE)
    },
  }
  await app.plugin(plugin as never)
  observed.afterSettle = app.get(SERVICE)

  // 这条断言就是"不能走 ctx.get"的**根据**：apply 期间为 undefined
  assert.equal(
    observed.duringApply,
    undefined,
    '若 cordis 改成 apply 内即可见，本用例会红——那时探针可以简化，但必须先看清这一点',
  )
  // 而结算之后是可见的 —— 这正是请求期"逐请求现取"能工作的原因
  assert.notEqual(observed.afterSettle, undefined, '结算后必须可见，否则逐请求现取也不成立')
})

test('★ 附件探针：探针打的是【本插件刚建出的那个对象】，不得走 attachmentService()', async () => {
  // 源码级判据。行为级只能证到"没打错"，源码级才能证到"没走错路"——
  // 而这条路径的错误恰恰是**静默**的：它不报错，只是每次都报警、且从不做真检查。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  // 探针必须存在，且必须打在内置实现对象上
  assert.match(src, /void builtinAttachment\s*\n?\s*\.ready\(\)/, '探针必须打在 builtinAttachment 上')
  // 探针**不得**再走 attachmentService()（它经过 ctx.get，在 apply 里必然拿不到）
  const probeBlock = src.slice(src.indexOf('if (builtinAttachment) {'))
  const probeEnd = probeBlock.indexOf('// `attachmentProvider')
  assert.ok(probeEnd > 0, '找不到探针代码块的结束标记')
  const probe = probeBlock.slice(0, probeEnd)
  assert.equal(
    /attachmentService\(\)/.test(probe),
    false,
    '激活期探针不得调用 attachmentService()：它在 apply 里必然抛错，会让探针永不生效',
  )
  // 且外层不得再用 try/catch 吞掉同步抛出（那正是旧写法误报的来源）
  assert.equal(
    /try\s*\{[^}]*builtinAttachment/.test(probe),
    false,
    '探针不需要 try/catch：走 builtinAttachment 不会同步抛错',
  )
})

test('★ 附件探针：错误消息必须报实际配置值，不得断言一个没核对过的原因', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  // 只在**函数体**里断言，不扫全文件：旧消息在注释里被引述是**好事**（它解释了为什么改），
  // 扫全文件会把它当违规。判据必须能区分"代码里写了"与"注释里提到"——
  // 分不清的守卫会产生误报，而**误报的守卫会被下一次改动顺手删掉，比没有守卫更糟**。
  const start = src.indexOf('const attachmentService = (): AttachmentService => {')
  assert.ok(start > 0, '找不到 attachmentService 函数')
  // **先剥注释再断言**：解释"旧写法错在哪"的注释里必然引述旧消息，
  // 不剥注释就会把解释当成违规（F21 的脚手架守卫踩过同一个坑，规则相同）。
  const body = src
    .slice(start, src.indexOf('\n    }', start))
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  assert.equal(
    body.includes('attachmentProvider:none'),
    false,
    '该断言会把操作者引向一个本来就正确的配置项',
  )
  assert.match(body, /本插件 attachmentProvider=\$\{String\(config\.attachmentProvider\)\}/)
})
