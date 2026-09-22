/**
 * 附件上传（本批 M1）：**零 IO、零 HTTP 的纯函数层**。
 *
 * ## 为什么是"裸 body PUT"而不是 multipart
 *
 * 上传走 `PUT /api/attachments/:slug?name=<urlencoded>`，`Content-Type` 即文件 MIME、
 * 请求体即字节。**不采用 multipart/form-data**，理由是可实测的：
 * Node v22 的 `Request.formData()` 路线虽然可用，但 undici 会**把整份请求体缓冲进内存**
 * （`maxBytes` 类上限只管单个 part 之外的场景），且**没有 per-file 上限** —— 即"一个匿名
 * 请求就能把进程内存打满"。而 multipart 又是**没有上限声明的格式**，手写解析器等于自己
 * 实现一遍边界状态机（历史上绝大多数上传漏洞都出在这一层）。
 * 裸 body 的上限则可以被 `Content-Length` 与流式计数双重收紧。**2026-09-21 起两道闸默认都
 * 不设上限**（见 {@link NO_SIZE_LIMIT}），但"`Content-Length` 必须存在"仍然成立 ——
 * 它守的从来不只是体积，还有"实收字节数 vs 声明值"的对照（`length_mismatch`）。
 *
 * ## 磁盘上只有内容寻址的路径
 *
 * 落盘路径**从不由用户输入拼接**：`${sha256 前 4 位分两级目录}/${sha256}${ext}`，
 * 其中 `sha256` 由字节现算、`ext` 必须命中白名单。原始文件名**只进
 * `attachments.original_name` 显示列**，不参与任何路径计算 —— 于是
 * "文件名里带 `../` / 绝对路径 / NUL"这类输入在结构上无从影响落盘位置。
 *
 * ## 为什么扩展名要白名单而不是黑名单
 *
 * 黑名单（"禁止 .php/.jsp/..."）永远列不全，且一旦将来某个反代/容器把上传目录当可执行
 * 内容服务，漏一个扩展名就是 RCE。白名单的失败方向是"少收几种文件"，可接受。
 * 取名用**最后一个 `.` 之后**的片段：`evil.php.png` ⇒ `.png`（用户看到的是图片，
 * 那么它就该按 png 处理）；`x.php` ⇒ `null`（拒绝）。
 */

import { join } from 'node:path'

/**
 * 允许的附件扩展名（含前导点，全小写）。
 *
 * 覆盖：位图、矢量图、文档、纯文本、归档、Office OOXML。
 * **刻意不含**：`.html`/`.htm`（同源 HTML 可执行脚本）、`.php`/`.js`/`.mjs`/`.sh` 等
 * 可执行或可被解释的扩展名 —— 即便当前部署不做脚本解释，把可执行内容收进知识库也没有收益。
 */
export const ATTACHMENT_EXT_WHITELIST: readonly string[] = [
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
]

const WHITELIST_SET: ReadonlySet<string> = new Set(ATTACHMENT_EXT_WHITELIST)

/**
 * 「**不设上限**」的表示值（2026-09-21）。
 *
 * 两个配置项 `attachmentMaxBytes`（单文件）与 `attachmentPageQuotaBytes`（单页总量）
 * 的默认值都是它：**0 = 不限**，于是磁盘余量成为附件上传的唯一下限。
 * 历史默认是 25 MiB / 200 MiB —— 那是"上限"还由代码兜底的年代留下的值。
 *
 * ## 为什么计数逻辑保留着，而不是删干净
 *
 * 它是**运维不改代码就能重新设闸**的唯一入口。一个完全不限的上传端点迟早会撞上
 * 磁盘写满（`storage_unavailable` ⇒ 503），那时需要的是"立刻收口"的阀门，
 * 而不是第二次改代码发版。删掉这条计数还会连带删掉两道与它同在一处的防线：
 * `expectedBytes`（实收 vs 声明）对照，以及超限时**中断流**（不是收完再判）+ 临时文件清理。
 *
 * ★ `0` 只表示"不限"，**不表示"拒收一切"**：判据一律写成 `limit > 0 && size > limit`。
 * 写成 `size > limit` 会让默认值变成"任何非空文件都被拒"，而失败形态是"上传全挂"，
 * 比反向的错更难排查（配置里什么都没写，界面却什么都传不上去）。
 */
export const NO_SIZE_LIMIT = 0

/** `sha256` 的形态：只有 **小写 hex 的 64 位** 才是合法输入（大写/短/长一律拒绝）。 */
const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * 扩展名白名单表 —— `effectiveMime` 的唯一真源。
 *
 * **为什么不信任客户端声明的 `Content-Type`**：它完全由调用方填写，把 `.png` 声明成
 * `text/html` 或把 `.svg` 声明成 `image/png` 都不需要任何特殊工具。响应头若照抄声明值，
 * 一次上传就能构造出**同源 HTML**（`text/html` + 正文里的 `<script>`）＝ 存储型 XSS。
 * 因此 MIME 一律由**扩展名**（已过白名单）推出，声明值只在表里查不到时兜底。
 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * `Content-Disposition` 用 `inline` 的扩展名（其余一律 `attachment`，即"下载"）。
 *
 * **`.svg` 刻意不在表内、且另有强制**：同源伺服的内联 SVG 里可以带 `<script>`，
 * 浏览器会把它当成文档执行 —— 这是一条完整的存储型 XSS 路径（除非另配 CSP）。
 * 所以它必须走 `attachment`（下载），把"打开它"变成一个需要用户显式确认的动作。
 */
const INLINE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf'])

/**
 * 从原始文件名取扩展名（**只取最后一个 `.` 之后**），未命中白名单返回 `null`。
 *
 * - `'evil.php.png'` ⇒ `'.png'`（用户看到的是图片 ⇒ 按图片处理）
 * - `'x.php'` ⇒ `null`（拒绝）
 * - `'x'` / `'x.'` / `''` ⇒ `null`（没有可判定的扩展名）
 * - 大小写不敏感（`'A.PNG'` ⇒ `'.png'`）：落盘路径与响应头都用归一化后的小写形式，
 *   避免"同一份内容因大小写产生两个路径"。
 *
 * 入参为 `unknown` 之外的类型时不抛错、直接返回 `null`（查询串缺参时是 `null`）。
 */
export function normalizeExt(rawName: string): string | null {
  if (typeof rawName !== 'string') return null
  const dot = rawName.lastIndexOf('.')
  if (dot < 0) return null
  const ext = rawName.slice(dot).toLowerCase()
  return WHITELIST_SET.has(ext) ? ext : null
}

/**
 * 断言扩展名可用（含前导点、命中白名单）。
 *
 * 单独导出是因为它有**两个**调用点，而两处都必须收紧到同一条判据：
 * {@link attachmentRelPath}（拼路径时）与落盘写入器（收流之前先拒，别白收一遍字节）。
 */
export function assertExtAllowed(ext: string): void {
  if (typeof ext !== 'string' || !WHITELIST_SET.has(ext)) {
    throw new Error(`invalid_ext: 扩展名不在白名单内（收到 ${JSON.stringify(ext)}）`)
  }
}

/**
 * 内容寻址的**相对**路径：`${sha 前 2}/${sha 第 3-4}/${sha}${ext}`。
 *
 * 两级目录（每级最多 256 项）是为了避免"单目录几十万文件"—— 那会让 `readdir` 与备份
 * 遍历都退化成线性扫描。
 *
 * **两个参数都先断言**（`sha256` 必须是 64 位小写 hex；`ext` 必须命中白名单）：
 * 这是"路径从不由用户输入拼接"这条保证的落点。少了断言，一个 `'../../etc/passwd'`
 * 形状的 `sha256` 就能把写入引到数据目录之外——而白名单/正则都在这一层，不在调用方。
 * 非法输入**抛错**而不是返回 `null`：调用方拿不到路径就没法读盘，失败必须是显式的。
 */
export function attachmentRelPath(sha256: string, ext: string): string {
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw new Error(`invalid_sha256: 内容哈希必须是 64 位小写 hex（收到 ${JSON.stringify(sha256)}）`)
  }
  assertExtAllowed(ext)
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${ext}`
}

/** 附件的绝对落盘路径：`<dataDir>/attachments/<两级目录>/<sha><ext>`。 */
export function resolveAttachmentPath(dataDir: string, sha256: string, ext: string): string {
  return join(dataDir, 'attachments', attachmentRelPath(sha256, ext))
}

/**
 * 附件的对外 URL（**相对路径**）。
 *
 * 用相对路径是刻意的：它天然同源，于是 `<img src>` 会自动带上该域的 cookie ——
 * 若下发绝对 URL，站点换域名/挂在子路径下时就会指向别处（或丢掉凭据）。
 */
export function attachmentUrl(id: number): string {
  return `/api/attachments/${id}`
}

/**
 * 把扩展名归一化成 `Content-Disposition` 的处置方式。
 *
 * `attachmentInlineSvg` 配置为 `true` 时才允许 `.svg` 内联（默认关闭）：
 * 打开它需要运维**同时**配上 CSP，否则见 {@link INLINE_EXTS} 的说明。
 */
export function dispositionKindOf(ext: string, opts: { inlineSvg?: boolean } = {}): 'inline' | 'attachment' {
  if (ext === '.svg') return opts.inlineSvg === true ? 'inline' : 'attachment'
  return INLINE_EXTS.has(ext) ? 'inline' : 'attachment'
}

/**
 * 生成 `Content-Disposition`：**RFC 5987 的 `filename*=UTF-8''…` + 一个 ASCII 回退**。
 *
 * 为什么两段都要有：`filename*` 是唯一能无损表达中文名的形式，但极老的客户端只认
 * `filename`。回退值必须**只含 ASCII 且不含引号/反斜杠/控制字符** —— 否则文件名里的
 * `"` 会提前闭合引号、`\r\n` 会变成**响应头注入**（`formatDisposition('inline', 'a".txt\r\nX: y')`
 * 若原样拼接就是一个可被上传者控制的响应头）。
 */
export function formatDisposition(kind: 'inline' | 'attachment', name: string): string {
  const raw = typeof name === 'string' ? name : ''
  // ASCII 回退：非可见 ASCII 一律换成 '_'，并单独处理引号与反斜杠（它们能破坏引号包裹）
  const ascii = raw
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 200)
  const encoded = encodeURIComponent(raw)
    // RFC 5987 的 attr-char 不含这四个字符，而 encodeURIComponent 不会转义它们
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const fallback = ascii.length > 0 ? ascii : 'attachment'
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/** 合法的 MIME 形态（**不含参数**）：只允许 `type/subtype` 的字面集合，用于兜底值净化。 */
const MIME_LITERAL_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

/**
 * 由扩展名推出响应 `Content-Type` —— **以白名单为准，不信任客户端声明**。
 *
 * 顺序是刻意的：白名单扩展名**永远**走 {@link MIME_BY_EXT}（于是 `.png` 无论被声明成
 * 什么都不可能变成 `text/html`）；只有在扩展名没有对应表项时才回退到声明值，且回退值
 * 必须先过 {@link MIME_LITERAL_RE}（拒绝 `text/html; x="\r\n…"` 这类带参数/带控制字符的值）。
 * 两者都不可用时给 `application/octet-stream`（配合 `X-Content-Type-Options: nosniff`，
 * 浏览器只会下载、不会猜类型）。
 */
export function effectiveMime(ext: string, declared: string): string {
  const known = MIME_BY_EXT[ext.toLowerCase()]
  if (known !== undefined) return known
  const d = typeof declared === 'string' ? declared.trim().toLowerCase() : ''
  if (MIME_LITERAL_RE.test(d)) return d
  return 'application/octet-stream'
}
