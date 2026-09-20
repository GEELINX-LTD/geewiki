/**
 * `image.save` 的**浏览器侧执行体**：把用户贴在输入条里的图片存进知识库附件。
 *
 * ## 为什么这一半在浏览器（而不是服务端）
 * 工具在架构里本来就是**两半**（`packages/web/src/lib/clientTools.ts` 文件头）：
 * **服务端说"这个工具存在"**（描述符在 `@geewiki/ai-pages`，进模型的工具表），
 * **浏览器说"它在我这儿怎么跑"**（本文件登记到宿主的客户端工具表）。
 *
 * 执行体必须在浏览器，有两个各自独立的理由，缺一个都不成立：
 * 1. **图片字节只在这里**。它是用户从剪贴板/文件选择器拿到的，存在本地转录里；
 *    服务端手上的那份是**这一轮**的请求体，而用户完全可能下一轮才说"把刚才那张存起来"。
 * 2. **上传端点的权限判据在 HTTP 层**（`canEdit` + CSRF）。浏览器带着会话 cookie 走
 *    同一条 `PUT /api/attachments/:slug`，与编辑页上传附件**完全同一条路径**——
 *    不新增一个"AI 专用的写入通道"，也就不存在第二套权限判据。
 *
 * ## 它不是 `mutating`
 * 上传只**新增**一条附件行，不改动任何既有内容。用户真正要的"插进文章"由
 * `page.update` 落笔，而那一条已经在变更日志里、可回退（见 `@geewiki/ai-pages`）。
 * 把本工具也标成 mutating 会让回退 UI 上多出一条点了没反应的条目——
 * 与 `open_page` / `scroll_to` 不是 mutating 是同一条判据。
 */
import {
  conversationImages,
  dataUrlToBlob,
  fileNameFor,
  imageMarkdown,
  parseImageSaveArgs,
  pickConversationImage,
  type DockImage,
} from './imagePlan.js'

/** 工具名。**必须与 `@geewiki/ai-pages` 服务端描述符里的名字逐字一致**（由镜像守卫钉住） */
export const IMAGE_SAVE_TOOL_NAME = 'image.save'

/**
 * 附件上传端点前缀（与 `packages/web/src/api.ts` 的 `ATTACHMENT_URL_PREFIX` 是同一条路径）。
 * 插件产物不能 import 宿主模块，故这里是一份**字面量镜像**。
 */
export const ATTACHMENT_UPLOAD_PATH = '/api/attachments/'

/**
 * 当前对话里全部图片（按出现顺序，老 → 新）。
 *
 * 用模块级变量而不是 props：登记进宿主工具表的是**一个稳定函数**（`registerTool`
 * 不接受每次渲染都换的新函数），而它需要在被调用时读到**此刻**的转录。
 * 组件在转录变化时调用 {@link setConversationImages} 更新它。
 */
let imagesRef: readonly DockImage[] = []

export function setConversationImages(messages: readonly { readonly role: string; readonly images?: readonly DockImage[] }[]): void {
  imagesRef = conversationImages(messages)
}

/** 测试/诊断用：此刻工具会看到的图片 */
export function currentConversationImages(): readonly DockImage[] {
  return imagesRef
}

/**
 * 执行体。返回的对象会被 `runClientTools` 序列化成 `tool` 消息回灌给模型，
 * 因此每个字段都是**写给模型看的**：`message` 是它下一轮该照着做的话，
 * `markdown` 是可以直接放进 `page.update` 的正文片段。
 */
export async function executeImageSave(args: unknown): Promise<unknown> {
  const parsed = parseImageSaveArgs(args)
  if (typeof parsed === 'string') {
    return { ok: false, error: 'invalid_arguments', message: `参数不合法：${parsed}。请修正后重试。` }
  }

  const images = imagesRef
  const picked = pickConversationImage(images, parsed.index)
  if (picked === null) {
    return {
      ok: false,
      error: 'no_image',
      message:
        images.length === 0
          ? '这次对话里没有任何图片，无法保存。请让用户先把图片粘进输入条或拖进来，再发一次。'
          : `index=${String(parsed.index)} 超出范围：这次对话一共有 ${images.length} 张图。`,
    }
  }

  const blob = dataUrlToBlob(picked.url)
  if (blob === null) {
    return { ok: false, error: 'bad_image', message: '图片数据无法解析，**没有保存任何东西**。' }
  }

  const name = parsed.name !== '' ? parsed.name : fileNameFor(picked)
  const path = `${ATTACHMENT_UPLOAD_PATH}${encodeURIComponent(parsed.slug)}?name=${encodeURIComponent(name)}`
  let res: Response
  try {
    res = await fetch(path, {
      method: 'PUT',
      /*
       * `x-gw-csrf: 1` 一个都不能少（与 `defaultTransport` 同一条红线）：
       * 带会话 cookie 的写请求服务端**强制**校验它，漏了的表现是每次上传都 401。
       * `content-type` 如实给图片类型——服务端按**扩展名**判定，但这个头会进
       * 响应与审计，撒谎没有收益。
       */
      headers: { 'content-type': blob.type || 'application/octet-stream', 'x-gw-csrf': '1' },
      body: blob,
      credentials: 'same-origin',
    })
  } catch (err) {
    return { ok: false, error: 'network', message: `上传失败：${err instanceof Error ? err.message : String(err)}` }
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* 非 JSON（反向代理的错误页）——下面的分支按状态码给话 */
  }
  if (!res.ok) {
    const f = (data ?? {}) as { error?: unknown; message?: unknown }
    return {
      ok: false,
      error: typeof f.error === 'string' ? f.error : `http_${res.status}`,
      message: typeof f.message === 'string' ? f.message : `上传失败（HTTP ${res.status}）`,
    }
  }

  const attachment = ((data ?? {}) as { attachment?: unknown }).attachment
  const a = (attachment ?? {}) as { url?: unknown; id?: unknown }
  const url = typeof a.url === 'string' ? a.url : ''
  if (url === '') {
    return { ok: false, error: 'bad_response', message: '服务端说上传成功，但没有返回附件地址。' }
  }
  const alt = parsed.alt !== '' ? parsed.alt : (picked.name ?? '图片')
  const markdown = imageMarkdown(url, alt)
  return {
    ok: true,
    url,
    markdown,
    message:
      `图片已存进 ${parsed.slug} 的附件里（${url}）。` +
      `要插进正文，请用 page.update 把这一行写到你选好的位置：${markdown}`,
  }
}

/**
 * 登记进宿主工具表。
 *
 * 宿主 SDK 上**没有** `registerTool` 时（老宿主）静默跳过，而不是抛错：
 * 那样这条能力就"不存在"，模型也不会看到它（描述符虽在服务端，但没有浏览器处理器时
 * 宿主不会把它报进 `clientTools`，`resolveTurnTools` 自然把它挡在工具表外）。
 * 这与 `renderMarkdown` 的特性探测同一条取舍：老宿主上退化，不是崩掉。
 */
export function registerImageSaveTool(host: {
  registerTool?(name: string, execute: (args: unknown) => Promise<unknown> | unknown): () => void
}): () => void {
  if (typeof host.registerTool !== 'function') return () => {}
  return host.registerTool(IMAGE_SAVE_TOOL_NAME, executeImageSave)
}
