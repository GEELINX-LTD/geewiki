/**
 * 附件（图片/文件上传）的**纯逻辑**——无 DOM、无 React、无网络，便于单测。
 * ============================================================================
 *
 * 这里只放"可以被断言"的东西：占位文本怎么生成、插什么语法、替换时怎么定位、
 * 破图兜底说什么话。真正的编排（CodeMirror 的 paste/drop、fetch、代理注入）在
 * `components/MarkdownEditor.tsx` 与 `api.ts`，故意分开——编排层在 node 里跑不起来，
 * 而"占位被用户中途输入顶走"这类**只在真机上偶发**的问题，只有纯函数能被稳定复现。
 *
 * ## 为什么"按文本查找"而不是"按偏移量替换"（本模块最重要的一条）
 *
 * 上传是异步的（截图粘贴最典型：占位插进去 → 网络往返 → 结果回来）。这段时间里
 * 用户**继续打字**是常态，而任何插入/删除都会让"插入时记下的偏移量"失效：
 * 用旧偏移量去替换，轻则替换错位置，重则把用户刚敲的一行吃掉。
 * 因此结果回来时**重新在文档里找那串占位文本**（`findUploadPlaceholder`），
 * 找不到就什么都不做（用户自己把它删了 —— 那是明确的意图，不该"补回来"）。
 *
 * ## 为什么占位串带序号
 *
 * 一次拖入 3 个文件 ⇒ 3 个占位同时在文档里。若占位文本完全相同，`indexOf` 只会命中
 * 第一个 ⇒ 后两个结果全部覆盖到同一处。序号由调用方单调递增给出（会话内唯一）。
 */

/** 附件读路径前缀（`GET /api/attachments/<id>`）。上传与展示两侧都以此为准。 */
export const ATTACHMENT_URL_PREFIX = '/api/attachments/'

/**
 * 图片扩展名（小写、含点）——决定插入 `![]()` 还是 `[]()`。
 *
 * 与后端"允许的扩展名白名单"（415 那一档）**不是一回事**：这里只是**渲染语法**的分流，
 * 不做拦截。后端允许而我们判成非图片（或反之）时，最坏结果是语法选得不合适，
 * 用户仍可手改一行 Markdown —— 而据此拒绝上传则是越权替后端做判断。
 */
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
]

/** 取小写扩展名（含点）；没有扩展名或为隐藏文件（`.gitignore`）时返回空串 */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  // dot === 0 ⇒ 整个名字以点开头（隐藏文件），不是扩展名
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}

/** 该文件名是否按图片语法插入 */
export function isImageFileName(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(fileExtension(name))
}

/**
 * 文件名 → Markdown 链接文本的转义。
 *
 * 只处理会**破坏语法**的字符：方括号（会提前闭合链接文本）与换行（会截断链接）。
 * 其余（空格、中文、括号）在 Markdown 的 `[]()` 里都是合法的，无需转义——
 * 过度转义会让用户看到一堆反斜杠。
 */
export function escapeLinkText(name: string): string {
  return name.replace(/[[\]]/g, (m) => `\\${m}`).replace(/[\r\n]+/g, ' ').trim()
}

/**
 * 上传成功后要插入正文的 Markdown 文本。
 *
 * `url` 用后端返回的**相对路径** `/api/attachments/<id>`：同源 cookie 自动携带，
 * 既不需要、也不允许在前端拼绝对地址或塞任何 token（写死绝对地址会在换域名/反代后
 * 指向错误的主机，而 token 进正文等于把凭据写进内容里，任何人都能看到）。
 */
export function attachmentMarkdown(name: string, url: string): string {
  const label = escapeLinkText(name)
  return isImageFileName(name) ? `![${label}](${url})` : `[${label}](${url})`
}

/** 上传中的占位标签（`![上传中…](uploading-1)`），也是"替换时按文本查找"的锚点 */
export const UPLOAD_PLACEHOLDER_LABEL = '上传中…'

/** 占位链接的伪 scheme：不是 `/api/attachments/`，因此不会被渲染层的附件规则误伤 */
export const UPLOAD_PLACEHOLDER_SCHEME = 'uploading-'

/** 生成第 `seq` 个占位（seq 由调用方单调递增，保证同一次会话内唯一） */
export function uploadPlaceholder(seq: number): string {
  return `![${UPLOAD_PLACEHOLDER_LABEL}](${UPLOAD_PLACEHOLDER_SCHEME}${seq})`
}

/** 判断一段文本是不是我们生成的占位（用于"替换结果为空"等自检与测试） */
export function isUploadPlaceholder(text: string): boolean {
  return (
    text.startsWith(`![${UPLOAD_PLACEHOLDER_LABEL}](${UPLOAD_PLACEHOLDER_SCHEME}`) &&
    text.endsWith(')')
  )
}

/** 文档内的一个区间（`to` 为开区间，与 CodeMirror 的 `{from,to}` 同语义） */
export interface DocRange {
  from: number
  to: number
}

/**
 * 在**当前**文档里按文本查找占位，返回可直接交给 CodeMirror 的区间；找不到返回 `null`。
 *
 * 找不到是**正常情形**（用户在上传期间把占位删了），调用方必须把它当成"不替换"，
 * 而不是退化成"插到光标处"—— 那会在用户完全没想到的位置冒出内容。
 */
export function findUploadPlaceholder(doc: string, placeholder: string): DocRange | null {
  const from = doc.indexOf(placeholder)
  return from < 0 ? null : { from, to: from + placeholder.length }
}

/** 失败文案的前缀（整行以 `>` 引用块插入，视觉上像一条"就地备注"而不是正常内容） */
export const UPLOAD_FAIL_PREFIX = '⚠️ 上传失败：'

/** 原因串最长展示长度（服务端文案可能很长；正文里的一行不该被它撑爆） */
export const UPLOAD_FAIL_REASON_MAX = 120

/**
 * 失败原因 → 单行文本。
 *
 * 必须**单行化**：正文是 Markdown，原因里若带换行会把引用块截断，
 * 后面半句会变成普通段落（看起来像正文内容，而不是"这条上传失败了"）。
 */
export function uploadFailureText(reason: string): string {
  const oneLine = reason.replace(/\s+/g, ' ').trim()
  const cut =
    oneLine.length > UPLOAD_FAIL_REASON_MAX
      ? `${oneLine.slice(0, UPLOAD_FAIL_REASON_MAX - 1)}…`
      : oneLine
  return `${UPLOAD_FAIL_PREFIX}${cut === '' ? '未知原因' : cut}`
}

/** 失败占位（替换掉那一行占位文本）；保留 File 供重试由编辑器层负责（见 MarkdownEditor） */
export function uploadFailureMarkdown(reason: string): string {
  return `> ${uploadFailureText(reason)}`
}

/**
 * 一批上传结束后的**状态行文案**（成功 / 失败 / 占位被删三种情形各自说清）。
 *
 * 抽成纯函数是为了让"到底播报了什么"可被断言：状态行是这条链路上**唯一**的可读反馈
 * （正文里的占位只说明"在上传"，说不出结论），措辞漂移就等于用户失去反馈。
 */
export function uploadSummaryText(inserted: number, failed: number, missing: number): string {
  const parts: string[] = []
  if (inserted > 0) parts.push(`已插入 ${inserted} 个附件`)
  if (failed > 0) parts.push(`${failed} 个失败（正文里已留下失败说明，可重试）`)
  if (missing > 0) parts.push(`${missing} 个占位已被删除，未插入`)
  return parts.length === 0 ? '没有需要插入的附件' : parts.join('；')
}

/* ------------------------------ 破图兜底（F4） ------------------------------ */

/** 附件图片的标记属性（渲染层注入，捕获阶段据此判断"这张图该不该兜底"） */
export const ATTACHMENT_MEDIA_ATTR = 'data-gw-attachment'

/** 附件所属页面 slug（已知时注入；「申请访问」入口要靠它提交申请） */
export const ATTACHMENT_SLUG_ATTR = 'data-gw-attachment-slug'

/** 已替换过的标记（同一个 `<img>` 的 error 可能触发多次，必须只替换一次） */
export const ATTACHMENT_BLOCKED_ATTR = 'data-gw-attachment-blocked'

/** 破图占位块的类名（样式在 `src/styles.css`，运行时注入的类名不参与构建期收集） */
export const ATTACHMENT_BLOCKED_CLASS = 'gw-attachment-blocked'

/**
 * 破图占位的主文案。
 *
 * ⚠️ **必须诚实**：浏览器对 `<img>` 的加载失败只给一个 `error` 事件，**不带状态码**，
 * 因此"无权"与"不存在"在这里**完全无法区分**。写成"你没有权限"是把猜测说成事实 ——
 * 附件可能只是被作者删了。这与服务端"越权一律回同一个 404"（防存在性探测）是同一条
 * 哲学：界面的说法不能比它掌握的证据更强。
 */
export const ATTACHMENT_BLOCKED_TEXT = '此处附件无权访问或被删除'

/** 为什么说不清是哪种：给愿意读的人一句解释，也避免文案被当成"系统出错了" */
export const ATTACHMENT_BLOCKED_REASON =
  '服务端对「不存在」与「无权访问」返回同一个 404（刻意不区分，防止用附件 id 探测它是否存在），因此这里无法判断属于哪一种。'

/** 「申请访问」入口的属性/文案（占位块里的按钮，由 `MarkdownBody` 的事件委托接住） */
export const ATTACHMENT_APPLY_ATTR = 'data-gw-apply-access'
export const ATTACHMENT_APPLY_TEXT = '申请访问'

/** 本机已记下待审申请时的文案（`lib/myAccessRequests.ts` 的 `recallRequest` 有值） */
export const ATTACHMENT_APPLY_PENDING_TEXT = '已提交申请，等待处理'

/** 是否为附件 URL（渲染层只对这一类做懒加载标记与破图兜底） */
export function isAttachmentUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.startsWith(ATTACHMENT_URL_PREFIX)
}

/**
 * 占位块的完整可读文案（读屏播报与测试共用同一份来源，避免两处措辞漂移）。
 * `hasApply` 为真时补一句"可以申请访问"，否则只说事实。
 */
export function blockedAttachmentText(hasApply: boolean): string {
  return hasApply
    ? `${ATTACHMENT_BLOCKED_TEXT}。可以申请访问。`
    : ATTACHMENT_BLOCKED_TEXT
}
