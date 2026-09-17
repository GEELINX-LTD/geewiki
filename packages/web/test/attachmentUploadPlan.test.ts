/**
 * 附件上传（M4）——**纯逻辑**用例 + 源码守卫。
 *
 * 两组断言，缺一不可：
 *
 * 1. **行为**：占位文本怎么生成、替换时怎么定位（尤其是"上传期间用户继续输入"这一情形）、
 *    图片与非图片的语法分流、失败说明的形态、破图占位的措辞。
 * 2. **源码级守卫**：本批有三处"写错了也能跑、但真机上一定出事"的地方 ——
 *    ① `uploadAttachment` 漏掉 `x-gw-csrf: 1` ⇒ 服务端在带会话 cookie 时直接拒绝，
 *       而失败现场是"点了一下没反应"；② drop 处理器漏掉 `preventDefault()`
 *       ⇒ 浏览器**导航到被拖入的文件**，用户丢掉整页正在编辑的内容；
 *    ③ `request<T>` 被顺手改成支持 File ⇒ 既有 JSON 端点的行为全变。
 *    这三条都只能在源码层面钉住（单测跑不到 fetch 头与 DOM 事件）。
 *
 * 反空洞：每组负向断言前都先证明"确实读到了目标代码"（长度、关键行），
 * 否则一次路径写错就会让"0 处违规"退化成"0 个文件"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ATTACHMENT_BLOCKED_REASON,
  ATTACHMENT_BLOCKED_TEXT,
  ATTACHMENT_URL_PREFIX,
  IMAGE_EXTENSIONS,
  attachmentMarkdown,
  blockedAttachmentText,
  fileExtension,
  findUploadPlaceholder,
  isAttachmentUrl,
  isImageFileName,
  isUploadPlaceholder,
  uploadFailureMarkdown,
  uploadFailureText,
  uploadPlaceholder,
  uploadSummaryText,
} from '../src/lib/attachmentPlan'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 读源码并把注释剥掉（与 `designSystem.test.ts` 同款写法，避免把说明文字当成违规命中） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function readCode(rel: string): string {
  return codeOnly(readFileSync(join(SRC, rel), 'utf8'))
}

/* ============================ 一、占位与替换 ============================ */

test('占位：`![上传中…](uploading-<n>)`，且**不含**附件 URL 前缀（不会被渲染层误伤）', () => {
  assert.equal(uploadPlaceholder(1), '![上传中…](uploading-1)')
  assert.equal(uploadPlaceholder(42), '![上传中…](uploading-42)')
  assert.ok(isUploadPlaceholder(uploadPlaceholder(7)), '自己生成的占位必须被 isUploadPlaceholder 认出')
  assert.ok(
    !uploadPlaceholder(1).includes(ATTACHMENT_URL_PREFIX),
    '占位不得长得像真附件：否则破图兜底/懒加载标记会把它当真图处理',
  )
  // 反面：真附件图片与普通图片都不是占位
  assert.equal(isUploadPlaceholder('![图](/api/attachments/3)'), false)
  assert.equal(isUploadPlaceholder('普通文字'), false)
})

test('替换：上传期间用户继续输入，仍按**文本**命中（偏移量已失效）', () => {
  const ph = uploadPlaceholder(3)
  const inserted = `开头\n${ph}\n结尾`
  const originalFrom = inserted.indexOf(ph)
  // 用户在占位**之前**敲了一行 —— 插入时记下的任何偏移量都会右移
  const typed = `用户刚敲的一行\n${inserted}`

  const range = findUploadPlaceholder(typed, ph)
  assert.ok(range !== null, '文本还在，就必须找得到')
  assert.notEqual(
    range.from,
    originalFrom,
    '反空洞：偏移量确实变了 —— 否则本用例根本没测到"按文本查找"',
  )
  assert.equal(typed.slice(range.from, range.to), ph, '区间必须**恰好**覆盖占位，不多不少')

  const result = typed.slice(0, range.from) + attachmentMarkdown('图.png', '/api/attachments/9') + typed.slice(range.to)
  assert.ok(result.includes('用户刚敲的一行'), '用户输入的内容必须原样保留')
  assert.ok(result.includes('开头') && result.includes('结尾'), '上下文不得被吃掉')
  assert.ok(!result.includes('uploading-'), '占位必须被替换干净')
  assert.ok(result.includes('![图.png](/api/attachments/9)'), '插入的文本必须原样落位')
})

test('替换：占位已被用户删除 ⇒ 返回 null（**不得**退化成"插到光标处"）', () => {
  const ph = uploadPlaceholder(5)
  const typed = '用户把占位删了，只留下这行字'
  assert.equal(findUploadPlaceholder(typed, ph), null)
})

test('替换：多个占位各归其位（序号唯一，互不串台）', () => {
  const a = uploadPlaceholder(1)
  const b = uploadPlaceholder(2)
  const doc = `${a}\n\n${b}`
  const ra = findUploadPlaceholder(doc, a)
  const rb = findUploadPlaceholder(doc, b)
  assert.ok(ra !== null && rb !== null)
  assert.notEqual(ra.from, rb.from, '两个占位必须落在不同位置')
  // 先替换第二个（模拟"第二个文件先传完"），第一个仍必须完整可用
  const step1 = doc.slice(0, rb.from) + '[b.pdf](/api/attachments/2)' + doc.slice(rb.to)
  const ra2 = findUploadPlaceholder(step1, a)
  assert.ok(ra2 !== null, '替换掉一个占位后，另一个仍要能被找到')
  assert.equal(step1.slice(ra2.from, ra2.to), a)
})

/* ============================ 二、语法与扩展名分流 ============================ */

test('语法分流：图片用 `![]()`，其它类型用 `[]()`', () => {
  const url = '/api/attachments/12'
  assert.equal(attachmentMarkdown('架构图.png', url), `![架构图.png](${url})`)
  assert.equal(attachmentMarkdown('需求文档.pdf', url), `[需求文档.pdf](${url})`)
  assert.equal(attachmentMarkdown('data.zip', url), `[data.zip](${url})`)
})

test('扩展名分流：白名单内的图片扩展名（大小写不敏感）', () => {
  for (const ext of IMAGE_EXTENSIONS) {
    assert.equal(isImageFileName(`x${ext}`), true, `${ext} 应判为图片`)
    assert.equal(isImageFileName(`x${ext.toUpperCase()}`), true, `${ext} 的大写形式同样是图片`)
  }
  for (const name of ['a.pdf', 'a.zip', 'a.md', 'a.txt', 'a.svgz', '无扩展名', 'a.', '.gitignore']) {
    assert.equal(isImageFileName(name), false, `${name} 不应判为图片`)
  }
  // `.jpeg` 与 `.jpg` 都要在（同一种格式的两种写法，漏一个就会把照片插成普通链接）
  assert.ok(IMAGE_EXTENSIONS.includes('.jpg') && IMAGE_EXTENSIONS.includes('.jpeg'))
})

test('扩展名边界：`fileExtension` 不把隐藏文件名当扩展名', () => {
  assert.equal(fileExtension('a.PNG'), '.png', '统一小写，便于比较')
  assert.equal(fileExtension('.gitignore'), '', '整个名字以点开头是隐藏文件，不是扩展名')
  assert.equal(fileExtension('a.'), '', '尾随的点后面没有内容')
  assert.equal(fileExtension('无扩展名'), '')
})

test('文件名转义：方括号会被转义、换行被拍平（否则会**破坏** Markdown 语法）', () => {
  assert.equal(attachmentMarkdown('a[b].png', '/api/attachments/1'), '![a\\[b\\].png](/api/attachments/1)')
  assert.equal(attachmentMarkdown('两\n行.pdf', '/api/attachments/2'), '[两 行.pdf](/api/attachments/2)')
  // 空格、中文、圆括号不必转义（过度转义会让用户看到一堆反斜杠）
  assert.equal(attachmentMarkdown('我的 报告(终).pdf', '/u'), '[我的 报告(终).pdf](/u)')
})

/* ============================ 三、失败说明与状态行 ============================ */

test('失败说明：单行引用块，长原因被截断、空原因有兜底', () => {
  const md = uploadFailureMarkdown('文件太大')
  assert.ok(md.startsWith('> '), '失败说明是引用块：视觉上"就地一条备注"，不会被当正文读')
  assert.ok(md.includes('⚠️ 上传失败：'))

  // 服务端文案可能带换行 ⇒ 必须拍平成一行，否则引用块被截断，后半句会变成正文段落
  const multi = uploadFailureText('第一行\n第二行')
  assert.ok(!multi.includes('\n'), '失败说明必须单行')
  assert.ok(multi.includes('第一行 第二行'))

  const long = uploadFailureText('x'.repeat(500))
  assert.ok(long.length < 200, `超长原因必须截断（实际 ${long.length} 字符）`)
  assert.ok(long.endsWith('…'), '截断要有可见标记，不能悄悄丢内容')

  assert.ok(uploadFailureText('   ').includes('未知原因'), '拿不到原因时不能出现空荡荡的"上传失败："')
})

test('状态行：成功/失败/占位被删三种情形都说清楚，且不出现"0 个"式噪声', () => {
  assert.equal(uploadSummaryText(2, 0, 0), '已插入 2 个附件')
  assert.ok(uploadSummaryText(0, 1, 0).includes('1 个失败'))
  assert.ok(uploadSummaryText(1, 1, 0).includes('已插入 1 个附件'))
  assert.ok(uploadSummaryText(1, 1, 0).includes('1 个失败'))
  assert.ok(uploadSummaryText(0, 0, 2).includes('占位已被删除'))
  assert.ok(!uploadSummaryText(1, 0, 0).includes('0 个'), '没有失败就别提失败')
  assert.equal(uploadSummaryText(0, 0, 0), '没有需要插入的附件')
})

/* ============================ 四、破图占位文案 ============================ */

test('破图文案：「不存在」与「无权访问」同款措辞，**不得**把猜测写成"你没有权限"', () => {
  assert.equal(ATTACHMENT_BLOCKED_TEXT, '此处附件无权访问或被删除')
  /*
    这是本批最重要的一条文案约束：浏览器对 `<img>` 的失败只给一个不带状态码的 error 事件，
    而服务端对越权与不存在都回同一个 404（防存在性探测）⇒ 两者在前端完全同形。
    任何断言式的措辞都是在把猜测说成事实。
  */
  const all = `${ATTACHMENT_BLOCKED_TEXT} ${ATTACHMENT_BLOCKED_REASON} ${blockedAttachmentText(true)}`
  for (const forbidden of ['没有权限', '权限不足', '你没有', '无权访问（403', '已被删除。']) {
    assert.ok(!all.includes(forbidden), `破图文案不得出现断言式措辞「${forbidden}」：${all}`)
  }
  // 但"说不清是哪一种"这件事必须说出来，否则用户以为系统坏了
  assert.ok(ATTACHMENT_BLOCKED_REASON.includes('无法判断'), '要如实说明"分不出是哪一种"')
  assert.ok(ATTACHMENT_BLOCKED_REASON.includes('不存在') && ATTACHMENT_BLOCKED_REASON.includes('无权访问'))
})

test('破图文案：有申请入口时才提"可以申请访问"', () => {
  assert.ok(!blockedAttachmentText(false).includes('申请'), '没有入口就别提申请（点了没用的按钮更糟）')
  assert.ok(blockedAttachmentText(true).includes('可以申请访问'))
  assert.ok(blockedAttachmentText(true).startsWith(ATTACHMENT_BLOCKED_TEXT), '主文案必须逐字保留')
})

test('附件 URL 判定：只认**同源相对路径**，外链/占位/外站伪前缀都不算', () => {
  assert.equal(isAttachmentUrl('/api/attachments/3'), true)
  assert.equal(isAttachmentUrl('/api/attachments/3?x=1'), true)
  assert.equal(isAttachmentUrl('https://cdn.example.com/api/attachments/3'), false, '绝对地址不是本站附件')
  assert.equal(isAttachmentUrl('uploading-1'), false)
  assert.equal(isAttachmentUrl(''), false)
  assert.equal(isAttachmentUrl(null), false)
  assert.equal(isAttachmentUrl(undefined), false)
})

/* ============================ 五、源码守卫 ============================ */

test('守卫：上传的 fetch **必须**带 x-gw-csrf，且走裸 body（不经过 JSON.stringify）', () => {
  const api = readCode('api.ts')
  const from = api.indexOf('async function uploadRaw<T>(')
  const to = api.indexOf('export function uploadAttachment(', from)
  assert.ok(from > 0 && to > from, '应能定位到 uploadRaw → uploadAttachment 这段实现')
  const region = api.slice(from, to)
  // 反空洞：先证明真读到了那段代码
  assert.ok(region.length > 400, `守卫区间过短（${region.length} 字符），定位可能失效`)
  assert.ok(region.includes('fetch('), '守卫区间里必须有真正的 fetch 调用')

  assert.ok(region.includes("'x-gw-csrf': '1'"), '裸 PUT 同样会被 CSRF 拦截：这个头绝不能漏')
  assert.ok(region.includes('credentials: \'same-origin\''), '会话在 HttpOnly cookie 里，必须带凭据')
  assert.ok(region.includes("method: 'PUT'"), '上传是 PUT')
  assert.ok(region.includes('body: file'), 'body 就是文件本身（裸 body）')
  assert.ok(
    region.includes("'content-type': file.type || 'application/octet-stream'"),
    'Content-Type 就是文件 MIME，缺失时兜底为 octet-stream',
  )
  assert.ok(!region.includes('JSON.stringify'), '上传路径不得把 File 塞进 JSON.stringify（那只会得到 {}）')
  // 错误处理与 request 一致：非 2xx 抛 ApiError + 认证失败走全局出口
  assert.ok(region.includes('throw new ApiError('), '非 2xx 必须抛 ApiError')
  assert.ok(region.includes('notifyAuthFailure('), '401/403 必须走同一个全局出口')
})

test('守卫：`request<T>` 的既有实现未被改动（JSON 与非 JSON 两条路必须分开）', () => {
  const api = readCode('api.ts')
  const from = api.indexOf('async function request<T>(')
  assert.ok(from > 0, '应能找到 request<T>')
  const region = api.slice(from, from + 700)
  // 反空洞
  assert.ok(region.length > 300)
  assert.ok(region.includes('await fetch(path, {'), '守卫区间应是 request 的 fetch 本体')
  assert.ok(
    region.includes('body: body !== undefined ? JSON.stringify(body) : undefined'),
    'request<T> 的 JSON 体行为必须原样保留（本批不得改它）',
  )
  assert.ok(region.includes('headers: requestHeaders(body !== undefined)'))
  assert.ok(region.includes("credentials: 'same-origin'"))
  assert.ok(region.includes('throw new ApiError('))
  assert.ok(region.includes('notifyAuthFailure(res.status, f.error, path)'))
})

test('守卫：编辑器的 drop **必须** preventDefault（否则浏览器会导航到被拖入的文件）', () => {
  const ed = readCode('components/MarkdownEditor.tsx')
  const from = ed.indexOf('drop: (event, instance) =>')
  assert.ok(from > 0, '应能找到 drop 处理器')
  const region = ed.slice(from, from + 700)
  assert.ok(region.includes('preventDefault()'), 'drop 必须拦下浏览器默认行为（导航走 = 丢掉整页编辑内容）')
  assert.ok(region.includes('dataTransfer'), '要从 dataTransfer 取文件')
  assert.ok(region.includes('posAtCoords'), '拖放必须按落点插入，而不是插到光标处')
  const pasteAt = ed.indexOf('paste: (event) =>')
  assert.ok(pasteAt > 0, '应能找到 paste 处理器（截图粘贴路径）')
  assert.ok(ed.slice(pasteAt, pasteAt + 400).includes('clipboardData'), '粘贴要从 clipboardData 取文件')
  assert.ok(ed.includes('onUploadFiles'), '编辑器要暴露 onUploadFiles 给父组件')
})

test('守卫：破图兜底用**捕获阶段**的 window error 监听（资源错误不冒泡）', () => {
  const body = readCode('components/MarkdownBody.tsx')
  assert.match(
    body,
    /window\.addEventListener\('error', [A-Za-z]+, true\)/,
    '必须 capture: true —— `<img>` 的 error 不冒泡，冒泡阶段收不到',
  )
  assert.match(body, /window\.removeEventListener\('error', [A-Za-z]+, true\)/, '卸载时要摘掉监听')
  assert.ok(body.includes('ATTACHMENT_MEDIA_ATTR'), '只兜附件图（外链图挂了是另一回事）')
  assert.ok(body.includes('buildBlockedAttachment('), '要用占位块替换掉那张破图')

  const render = readCode('lib/markdownRender.ts')
  assert.match(render, /export function decorateAttachmentMedia\(/, '渲染层要有并列的附件后处理')
  assert.ok(render.includes("img.setAttribute('loading', 'lazy')"), '附件图必须懒加载')
  assert.ok(render.includes('ATTACHMENT_MEDIA_ATTR'), '要打上 data-gw-attachment 供兜底识别')
  assert.ok(
    render.indexOf('decorateAttachmentMedia(holder') > render.indexOf('mdToHtml(markdown)'),
    '附件后处理必须在**消毒之后**（消毒前跑会被 DOMPurify 摘掉属性，白标）',
  )
})

test('守卫：破图占位块的样式已注册，且只用 token（不写死颜色）', () => {
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
  const at = css.indexOf('.gw-attachment-blocked {')
  assert.ok(at > 0, 'styles.css 应有 .gw-attachment-blocked 规则')
  const region = css.slice(at, css.indexOf('.md-body table', at) > at ? css.indexOf('.md-body table', at) : at + 1600)
  assert.ok(region.length > 300, `守卫区间过短（${region.length} 字符），定位可能失效`)
  assert.ok(region.includes('var(--gw-'), '样式必须引用设计 token')
  assert.ok(region.includes('.gw-attachment-blocked-apply'), '「申请访问」按钮要有自己的样式（含 :focus-visible）')
  assert.ok(region.includes(':focus-visible'), '键盘焦点必须可见（WCAG 2.4.7）')
  assert.equal(
    /#[0-9a-fA-F]{3,8}\b/.test(region),
    false,
    '不得写死颜色：深浅色模式下会有一半不成立',
  )
})

test('守卫：编辑页接上了上传，且"新建页面"给出可执行提示而不是静默失败', () => {
  const page = readCode('pages/WikiPage.tsx')
  assert.ok(page.includes('onUploadFiles={uploadFiles}'), '编辑器必须接上上传入口')
  assert.ok(page.includes('uploadAttachment(slug, file)'), '页面侧负责真正上传')
  assert.ok(page.includes('attachmentMarkdown(file.name, r.url)'), '插入文本由共享的纯函数生成')
  const guard = page.indexOf('if (isNew) {')
  assert.ok(guard > 0, '应存在"新建页面还没有 slug"的前置判断')
  assert.ok(
    page.includes('请先保存页面，再插入附件'),
    '无 slug 时必须给一句可执行的提示（附件端点按页面 slug 定位，空 slug 挂不上）',
  )
  // 失败提示必须可见：状态是 state 且渲染进 JSX
  assert.ok(page.includes('setUploadNotice(') && page.includes('{uploadNotice !== null &&'), '上传结果必须有可见提示')
})

test('守卫：插件编辑器路径必须拦住默认拖放，并给出可见提示（X1 兜底）', () => {
  /*
   * 这条守的是**真机上抓到的那次数据丢失**：插件占了 `editor` 插槽时内置编辑器根本不渲染，
   * 而 `EditorSlotProps` 契约里**当时**没有上传通道 ⇒ 用户拖入文件时 0 个请求、无提示，
   * 浏览器还会把窗口**导航到那个文件**，正在编辑的正文一起丢（target 数 6→7）。
   * 兜底只能靠源码级守卫钉住：`preventDefault()` 与 `role="status"` 都"删掉也能跑"，
   * 而删掉之后的表现恰好是"没有任何表现"——这正是最难靠人工发现的一类回归。
   *
   * ★ F5 之后契约**有了** `onUploadFiles`，但兜底路径**仍然必要**：它守的是"宿主没提供上传通道"
   * 这一情形（例如宿主降级、或将来某个部署裁剪掉附件功能）。判据随之变成"提供才放行"，
   * 见紧随其后的那条守卫。
   */
  const slots = readCode('lib/slots.tsx')
  const from = slots.indexOf('export function EditorSlotOutlet(')
  assert.ok(from > 0, '应能找到 EditorSlotOutlet（结构变了即红）')
  const region = slots.slice(from)
  assert.ok(region.length > 400, `EditorSlotOutlet 区域过短（解析写坏？实际 ${region.length} 字符）`)

  // ① 拖放的默认行为必须被拦下（三条路径：dragover / drop / paste）
  assert.ok(region.includes('onDragOver={onDragOver}'), '拖入过程就要接住（dragover 不拦 ⇒ drop 根本不会来）')
  assert.ok(region.includes('onDrop={onDrop}'), '落点处必须接住 drop')
  assert.ok(region.includes('onPaste={onPaste}'), '粘贴截图是同一类输入，必须一并接住')
  assert.equal(
    (region.match(/preventDefault\(\)/g) ?? []).length,
    3,
    'dragover / drop / paste 三条路径**各自**都要 preventDefault（漏一条就是"浏览器导航走"）',
  )
  assert.ok(region.includes('dataTransfer') && region.includes('clipboardData'), '要从两个 dataTransfer 来源取文件')

  // ② 提示必须可见且可被播报：role="status" + 真的渲染进 DOM（不是 console）
  assert.ok(region.includes('role="status"'), '提示必须是实时区域（role="status"），不能只 console')
  assert.ok(region.includes('data-editor-upload-hint'), '提示要暴露状态供真机验收观察')
  assert.ok(!region.includes('title='), '不得只靠 title（鼠标悬停才可见，读屏与触屏都拿不到）')
  assert.ok(region.includes('setUploadBlocked(true)'), '提示必须由 state 驱动渲染')

  // ③ 文案要给出**可执行的下一步**，且不承诺做不到的事
  const hint = slots.match(/export const EDITOR_SLOT_NO_UPLOAD_HINT =\s*\n?\s*'([^']+)'/)
  assert.ok(hint !== null, '应存在导出的兜底文案常量（界面与测试共用同一份来源）')
  const text = hint[1] as string
  // 入口是合并后的那一页（原先的「插件管理」与「依赖图」各占一项，已合二为一），
  // 而该页**后来改名为「插件管理」**，文案随之指向新名字
  assert.ok(text.includes('插件管理'), '文案要指出下一步去哪（「插件管理」页）')
  assert.ok(text.includes('内置编辑器'), '文案要点名该换成哪个编辑器')
  assert.ok(!text.includes('已上传') && !text.includes('已插入'), '兜底提示不得暗示上传成功')
})

test('★ F5：宿主提供了 onUploadFiles 时不再拦截拖放/粘贴（上传交给插件编辑区）', () => {
  /*
   * 上一条守卫的前提是"宿主没有上传通道"。F5 之后 `EditorSlotProps` **有了** `onUploadFiles`
   * （审计 B3），于是同一个出口有了两种正确行为，判据必须跟着变：
   * - 宿主提供了上传 ⇒ **放行**事件，让插件编辑区接住（拦下来反而让插件永远收不到那次拖放）；
   * - 宿主没提供 ⇒ 维持原来的拦截 + 可见提示。
   *
   * 这条最容易发生的回归是"只加了 props 忘了改拦截"：界面看起来完全正常，
   * 用户拖入文件却毫无反应（事件被外层 preventDefault 吃掉了，插件拿不到），
   * 而且**没有任何报错**——属于最难人工发现的一类。
   */
  const slots = readCode('lib/slots.tsx')
  const from = slots.indexOf('export function EditorSlotOutlet(')
  assert.ok(from > 0, '应能找到 EditorSlotOutlet（结构变了即红）')
  const region = slots.slice(from)
  assert.match(
    region,
    /const uploadSupported = props\.onUploadFiles !== undefined/,
    '拦截与否必须以「宿主是否提供 onUploadFiles」为判据，不能无条件拦',
  )
  assert.equal(
    (region.match(/if \(uploadSupported\) return/g) ?? []).length,
    3,
    'dragover / drop / paste 三条路径都要在提供上传时放行（漏一条 ⇒ 插件编辑器收不到那次拖放，且无任何报错）',
  )
})
