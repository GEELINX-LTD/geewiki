/**
 * 附件存储内核（M1）单元测试：纯函数 + 一个磁盘写入器，**零 HTTP**。
 *
 * 这一组用例钉的是"写错了不会报错、只会静默失守"的地方：
 *   - 扩展名白名单的判定口径（最后一个 `.`；`evil.php.png` 是图片、`x.php` 不是）
 *   - 落盘路径**永远**是可寻址的相对路径（`..`、绝对路径、空 sha 都进不去）
 *   - 超限必须**中断**（而不是收完再判断），且临时目录不留残渣
 *   - 同内容二次上传是幂等去重（磁盘上只有一份），且 `dedup` 判据不是靠 rename 的 EEXIST
 *   - `Content-Disposition` 不能出现响应头注入；`Content-Type` 不照抄客户端声明
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import {
  ATTACHMENT_EXT_WHITELIST,
  NO_SIZE_LIMIT,
  attachmentRelPath,
  attachmentUrl,
  dispositionKindOf,
  effectiveMime,
  formatDisposition,
  normalizeExt,
  resolveAttachmentPath,
} from '../src/attachments.js'
import { AttachmentStoreError, isStorageErrno, storeStream } from '../src/attachment-store.js'

/** 一个一次给出若干块的假请求体（用来精确控制"第几块超限"）。 */
function bodyOf(chunks: Array<string | Buffer>): Readable {
  return Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))))
}

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gw-att-'))
}

test('白名单：与规格逐项一致（且不含可执行的 html/js）', () => {
  assert.deepEqual([...ATTACHMENT_EXT_WHITELIST], [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.avif',
    '.svg',
    '.pdf',
    '.txt',
    '.md',
    '.csv',
    '.json',
    '.zip',
    '.docx',
    '.xlsx',
    '.pptx',
  ])
  // 这三类若进了白名单，等于给"同源可执行内容"开了一条路
  for (const bad of ['.html', '.htm', '.js', '.php', '.sh']) {
    assert.ok(!ATTACHMENT_EXT_WHITELIST.includes(bad), `${bad} 不该在白名单里`)
  }
  /*
   * 有意更新的既有守卫：这里原先断言 `DEFAULT_MAX_BYTES === 25 MiB`。2026-09-21 起
   * 附件的两道大小闸**出厂即不限**（用户要求"把附件上传的大小上限也去掉"），
   * 那个常量随之变成 `NO_SIZE_LIMIT = 0`。保留这一行是为了让"默认值变了"这件事
   * 留在测试里可见，而不是悄悄消失。
   */
  assert.equal(NO_SIZE_LIMIT, 0, '「不限」的表示值必须是 0——判据一律写成 limit > 0 && …')
})

test('normalizeExt：只取最后一个点，白名单外一律 null', () => {
  assert.equal(normalizeExt('x.php'), null)
  assert.equal(normalizeExt('evil.php.png'), '.png')
  assert.equal(normalizeExt('photo.PNG'), '.png') // 大小写归一化：同一份内容只有一个路径
  assert.equal(normalizeExt('a.tar.gz'), null) // 只看最后一段 ⇒ .gz 不在白名单
  assert.equal(normalizeExt('noext'), null)
  assert.equal(normalizeExt('trailing.'), null)
  assert.equal(normalizeExt(''), null)
  assert.equal(normalizeExt('.png'), '.png') // 点开头的隐藏文件：扩展名依然是 .png
  assert.equal(normalizeExt('报告 v2.pdf'), '.pdf')
  // 路径分隔符不影响判定（原始名不参与任何路径计算，这里只是确认它不会被当成扩展名的一部分）
  assert.equal(normalizeExt('../../etc/passwd'), null)
  assert.equal(normalizeExt('dir/a.csv'), '.csv')
})

test('attachmentRelPath：任何输入都不产生越界路径段', () => {
  const sha = 'a'.repeat(64)
  assert.equal(attachmentRelPath(sha, '.png'), `aa/aa/${sha}.png`)

  const badShas: unknown[] = [
    '',
    '..',
    '../../etc/passwd',
    '/etc/passwd',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64), // 大写 hex 不接受（同一份内容必须只有一个路径）
    `${'a'.repeat(60)}../..`,
    'z'.repeat(64),
    null,
    undefined,
    42,
  ]
  for (const bad of badShas) {
    assert.throws(() => attachmentRelPath(bad as string, '.png'), /invalid_sha256/)
  }

  const badExts: unknown[] = ['', '.', '..', 'png', '.PNG', '.html', '.php', '.png/../../x', null, 42]
  for (const bad of badExts) {
    assert.throws(() => attachmentRelPath(sha, bad as string), /invalid_ext/)
  }
})

test('resolveAttachmentPath：始终落在 <dataDir>/attachments 之内', () => {
  const sha = 'b'.repeat(64)
  const p = resolveAttachmentPath('/srv/data', sha, '.pdf')
  assert.equal(p, `/srv/data/attachments/bb/bb/${sha}.pdf`)
  // 断言"仍然在数据目录内"——用相对路径判据，而不是字符串前缀（前缀比较会被 /data-evil 骗过）
  for (const [s, e] of [
    ['../../../../etc/passwd', '.png'],
    ['c'.repeat(64), '../..'],
  ] as const) {
    assert.throws(() => resolveAttachmentPath('/srv/data', s, e))
  }
})

test('attachmentUrl：相对路径（同源 cookie 自动带）', () => {
  assert.equal(attachmentUrl(12), '/api/attachments/12')
})

test('dispositionKindOf：svg 默认强制下载', () => {
  assert.equal(dispositionKindOf('.png'), 'inline')
  assert.equal(dispositionKindOf('.pdf'), 'inline')
  assert.equal(dispositionKindOf('.svg'), 'attachment')
  assert.equal(dispositionKindOf('.svg', { inlineSvg: true }), 'inline')
  assert.equal(dispositionKindOf('.docx'), 'attachment')
  assert.equal(dispositionKindOf('.txt'), 'attachment')
})

test('formatDisposition：中文名走 RFC 5987，且不存在响应头注入', () => {
  const d = formatDisposition('attachment', '设计稿 v2.png')
  assert.match(d, /^attachment; filename="[^"]*"; filename\*=UTF-8''/)
  assert.ok(d.includes(encodeURIComponent('设计稿 v2.png')))

  // ★ 注入面：引号、反斜杠、CR/LF 都不能原样出现在 filename="…" 里
  const evil = formatDisposition('inline', 'a".txt\r\nX-Injected: 1')
  assert.ok(!evil.includes('\r'), '不得含 CR')
  assert.ok(!evil.includes('\n'), '不得含 LF')
  const asciiPart = /filename="([^"]*)"/.exec(evil)?.[1] ?? ''
  assert.ok(!asciiPart.includes('"'), 'ASCII 回退里不得出现裸引号')
  // filename* 里已被百分号编码，同样不含 CR/LF
  assert.ok(!/filename\*=UTF-8''[^;]*[\r\n]/.test(evil))
})

test('effectiveMime：以白名单为准，不信任客户端声明', () => {
  // 最关键的一条：把 .png 声明成 text/html 也**不可能**让它变成 HTML（存储型 XSS 的常见入口）
  assert.equal(effectiveMime('.png', 'text/html'), 'image/png')
  assert.equal(effectiveMime('.svg', 'text/html'), 'image/svg+xml')
  assert.equal(effectiveMime('.json', 'text/plain'), 'application/json; charset=utf-8')
  // 表里没有的扩展名：只接受"字面 MIME"，带参数/控制字符/多值一律丢弃
  assert.equal(effectiveMime('.unknown', 'image/tiff'), 'image/tiff')
  assert.equal(effectiveMime('.unknown', 'text/html; x="\r\nY: z"'), 'application/octet-stream')
  assert.equal(effectiveMime('.unknown', ''), 'application/octet-stream')
  assert.equal(effectiveMime('.unknown', 'not a mime'), 'application/octet-stream')
})

test('storeStream：正常写入 + 内容寻址路径 + 原子落盘', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    const bytes = Buffer.from('hello 附件世界', 'utf8')
    const res = await storeStream(bodyOf([bytes]), { dataDir, tmpDir, maxBytes: 1024, ext: '.txt' })
    assert.equal(res.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(res.byteSize, bytes.length)
    assert.equal(res.dedup, false)

    const file = resolveAttachmentPath(dataDir, res.sha256, '.txt')
    assert.deepEqual(await readFile(file), bytes)
    // 临时文件已清空（否则每次上传都会在 tmp 里留一份完整副本）
    assert.deepEqual(await readdir(tmpDir), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storeStream：超限即中断并抛 payload_too_large，tmp 目录不留残渣', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    const big = Buffer.alloc(4096, 0x41)
    await assert.rejects(
      () => storeStream(bodyOf([big, big, big]), { dataDir, tmpDir, maxBytes: 4096, ext: '.txt' }),
      (err: unknown) => {
        assert.ok(err instanceof AttachmentStoreError)
        assert.equal(err.code, 'payload_too_large')
        return true
      },
    )
    // 失败路径必须同时满足：没有最终文件（内容寻址路径上一个字节都不该出现）、tmp 里无残留
    assert.deepEqual(await readdir(join(dataDir, 'attachments')), [])
    assert.deepEqual(await readdir(tmpDir), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storeStream：实收字节数与声明不符 ⇒ length_mismatch，且**最终路径从未被创建**（X6）', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    const bytes = Buffer.from('声明 9999 字节，实发这么多', 'utf8')
    await assert.rejects(
      // 声明 9999、实收 bytes.length ⇒ 必须拒绝：一个被截断的文件在内容寻址下是一份
      // **全新的哈希**（路径自洽、byte_size 自洽、去重也挡不住），会静默破坏
      // "同一哈希 ⇒ 同一字节"这条不变式
      () => storeStream(bodyOf([bytes]), { dataDir, tmpDir, maxBytes: 1024 * 1024, ext: '.txt', expectedBytes: 9999 }),
      (err: unknown) => {
        assert.ok(err instanceof AttachmentStoreError)
        assert.equal(err.code, 'length_mismatch')
        assert.match(err.message, new RegExp(String(bytes.length)))
        assert.match(err.message, /9999/)
        return true
      },
    )
    // 关键断言：失败发生在 rename **之前** ⇒ 内容寻址目录里一个字节都不该出现，tmp 也无残留
    assert.deepEqual(await readdir(join(dataDir, 'attachments')), [])
    assert.deepEqual(await readdir(tmpDir), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storeStream：声明值一致时照常放行（对照面，防止"一律拒绝"式的假绿）', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    const bytes = Buffer.from('长度对得上', 'utf8')
    const res = await storeStream(bodyOf([bytes]), {
      dataDir,
      tmpDir,
      maxBytes: 1024,
      ext: '.txt',
      expectedBytes: bytes.length,
    })
    assert.equal(res.byteSize, bytes.length)
    assert.equal(res.dedup, false)
    assert.deepEqual(await readFile(resolveAttachmentPath(dataDir, res.sha256, '.txt')), bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storeStream：同内容二次上传 dedup=true，磁盘上只有一份文件', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    const bytes = Buffer.from('dedup-me-0011')
    const first = await storeStream(bodyOf([bytes]), { dataDir, tmpDir, maxBytes: 1024, ext: '.md' })
    const second = await storeStream(bodyOf([bytes]), { dataDir, tmpDir, maxBytes: 1024, ext: '.md' })
    assert.equal(first.dedup, false)
    assert.equal(second.dedup, true)
    assert.equal(second.sha256, first.sha256)
    assert.equal(second.byteSize, first.byteSize)

    // 磁盘上确实只有一份（按 sha 前缀目录递归数文件）
    const files: string[] = []
    const sub = join(dataDir, 'attachments', first.sha256.slice(0, 2), first.sha256.slice(2, 4))
    for (const f of await readdir(sub)) files.push(f)
    assert.deepEqual(files, [`${first.sha256}.md`])
    assert.deepEqual(await readdir(tmpDir), [])
    assert.equal((await stat(resolveAttachmentPath(dataDir, first.sha256, '.md'))).size, bytes.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storeStream：跨块边界也要正确累计（哈希与字节数都不能只看最后一块）', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    const chunks = ['abc', 'defgh', 'ij']
    const res = await storeStream(bodyOf(chunks), { dataDir, tmpDir, maxBytes: 100, ext: '.csv' })
    assert.equal(res.byteSize, 10)
    assert.equal(res.sha256, createHash('sha256').update('abcdefghij').digest('hex'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storeStream：非法扩展名在收流之前就被拒（不浪费一次上传）', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    let pulled = false
    const src = new Readable({
      read() {
        pulled = true
        this.push(null)
      },
    })
    await assert.rejects(
      () => storeStream(src, { dataDir, tmpDir, maxBytes: 1024, ext: '.php' }),
      /invalid_ext/,
    )
    assert.equal(pulled, false, '扩展名非法时不应读取任何字节')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isStorageErrno：认识运维故障码，不认识的不硬认', () => {
  for (const code of ['EROFS', 'ENOSPC', 'EACCES', 'EPERM', 'EDQUOT']) {
    assert.equal(isStorageErrno(Object.assign(new Error('x'), { code })), true, code)
  }
  for (const code of ['ENOENT', 'ENOTDIR', 'EEXIST', undefined]) {
    assert.equal(isStorageErrno(Object.assign(new Error('x'), { code })), false, String(code))
  }
  assert.equal(isStorageErrno(null), false)
})

test('storeStream：**任何**存储层失败都映射成 storage_unavailable（端点 ⇒ 503，不是 500）', async (t) => {
  /*
   * 为什么断言"任何"而不只是 EROFS/ENOSPC/EACCES：实测只读文件系统上
   * `mkdir(…, { recursive: true })` 返回的是 **ENOENT**（不是 EROFS），
   * 只按 errno 白名单判定会把最常见的只读挂载误报成 500 ⇒ 计入连续失败 ⇒ 可能熔断。
   */
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    // 把 attachments 做成一个**普通文件**：mkdir 必然失败（ENOTDIR / EEXIST）
    await writeFile(join(root, 'placeholder'), 'x')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'attachments'), 'not a directory')
    await assert.rejects(
      () => storeStream(bodyOf(['x']), { dataDir, tmpDir, maxBytes: 1024, ext: '.txt' }),
      (err: unknown) => {
        assert.ok(err instanceof AttachmentStoreError)
        assert.equal(err.code, 'storage_unavailable')
        return true
      },
    )
    if (process.getuid?.() === 0) t.diagnostic('以 root 运行：真正的只读挂载由 e2e 的 /sys 符号链接用例覆盖')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storeStream：写入目标不可写时不得挂死（必须带错误返回，供端点回 503）', async () => {
  /*
   * 回归守卫：写流的错误是**异步**的，若背压等待只监听 `drain`，
   * 一次 EROFS 就会把请求永久挂住（连接不结束、在途计数不归零、排空超时）。
   * 用一个"写入即报错"的假 tmp 目录触发这条路径（这里用只读文件系统不可移植，
   * 故改为把 tmpDir 指向一个**已存在的目录不可写形态**：文件占位）。
   */
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    // tmpDir 是一个**文件** ⇒ createWriteStream 打开即失败
    await writeFile(tmpDir, 'placeholder')
    await assert.rejects(
      () => storeStream(bodyOf([Buffer.alloc(64)]), { dataDir, tmpDir, maxBytes: 1024, ext: '.txt' }),
      (err: unknown) => {
        assert.ok(err instanceof AttachmentStoreError, `期望 AttachmentStoreError，实际 ${String(err)}`)
        assert.equal(err.code, 'storage_unavailable')
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ==================== 2026-09-21：附件大小闸默认「不限」 ==================== */

test('storeStream：maxBytes = 0 表示**不限**，比旧默认上限（25 MiB）更大的文件照样收', async () => {
  const root = await tmpRoot()
  try {
    const dataDir = join(root, 'data')
    const tmpDir = join(root, 'tmp')
    /*
     * 取 26 MiB —— 刻意**越过**旧的 25 MiB 默认值，否则这条用例证明不了"上限真的没了"。
     * 内容随机化没必要：sha256 逐块算，这里要的是"收得下、算得对、落得全"。
     */
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41)
    const res = await storeStream(bodyOf([big]), {
      dataDir,
      tmpDir,
      maxBytes: NO_SIZE_LIMIT,
      ext: '.zip',
      expectedBytes: big.length,
    })
    assert.equal(res.byteSize, big.length, '不限时也要如实回报实收字节数（元数据与审计要用）')
    assert.equal(res.sha256, createHash('sha256').update(big).digest('hex'))
    const st = await stat(resolveAttachmentPath(dataDir, res.sha256, '.zip'))
    assert.equal(st.size, big.length, '落盘字节数必须与回报一致')
    assert.deepEqual(await readdir(tmpDir), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('★ 出厂默认是「不限」，且每一道判据都自带 `> 0` 守卫（0 绝不能变成"拒收一切"）', () => {
  const src = (f: string): string =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', f), 'utf8')
  const index = src('index.ts')
  const store = src('attachment-store.ts')

  // ① 两个配置项的出厂默认值
  assert.match(index, /attachmentMaxBytes: Schema\.number\(\)\s*\.default\(NO_SIZE_LIMIT\)/)
  assert.match(index, /attachmentPageQuotaBytes: Schema\.number\(\)\s*\.default\(NO_SIZE_LIMIT\)/)
  // ② 三处比较各自的守卫形态（改写法可以，但守卫必须还在同一处）
  assert.match(store, /o\.maxBytes > 0 && byteSize > o\.maxBytes/, '流式计数的守卫')
  assert.match(index, /attachmentMaxBytes > 0 && declared > attachmentMaxBytes/, '单文件前置闸的守卫')
  assert.match(
    index,
    /attachmentPageQuotaBytes > 0 && usedBytes \+ declared > attachmentPageQuotaBytes/,
    '单页配额前置闸的守卫',
  )
  // ③ 事务内的**权威**判定（并发上传只有这里拦得住），守卫形态与前置闸一致
  assert.match(
    index,
    /attachmentPageQuotaBytes > 0 && total \+ i\.byteSize > attachmentPageQuotaBytes/,
    '写入事务里的配额判定丢了，或守卫被改没了',
  )
  /*
   * ④ 反面：不允许出现**裸**的单文件比较（守卫漏一次 = 默认配置下上传全挂）。
   * 按行判定：任何拿这两个配置值做上界的行，同一行里必须出现 `> 0`。
   */
  for (const [label, text] of [['index.ts', index], ['attachment-store.ts', store]] as const) {
    for (const line of text.split('\n')) {
      const code = line.trim()
      // 只看代码行：注释里出现 `declared > attachmentMaxBytes` 是在**解释**守卫，不是漏守卫
      if (code.startsWith('*') || code.startsWith('/*') || code.startsWith('//')) continue
      if (!/> (attachmentMaxBytes|attachmentPageQuotaBytes|o\.maxBytes)\b/.test(line)) continue
      assert.match(line, /> 0 &&|> 0\s*\?/, `${label} 里有一处裸的大小比较（缺 \`limit > 0\` 守卫）：${line.trim()}`)
    }
  }
})
