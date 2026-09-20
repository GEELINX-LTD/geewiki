/**
 * dock 的**图片纯逻辑层**：形态、转换、上限、参数解析。
 *
 * ## 为什么单独一层
 * 与 `dockPlan.ts` 同一条理由：凡是"能在没有 DOM、没有网络的情况下判定的东西"
 * 都要能从组件里抽出来，否则它只能靠真浏览器验收。这里的每一条判据（data URL 拆解、
 * 参数校验、压缩尺寸计算）都能被 `node --test` 直接钉住。
 *
 * ## 两个形态，一次转换
 * - **界面形态** `{url}`：data URL，可直接喂给 `<img src>`，也直接进 `localStorage`；
 * - **线上形态** `{mime, data}`（服务端 `TurnImage`）：校验友好的裸 base64。
 *
 * 转换只发生在**上送边界**（`toTurnImages`）与**接收边界**（`fromTurnImages`）。
 * 让两者共用同一个 data URL 拼接格式，就不会出现"存的是 png、发出去变成 jpeg"这种
 * 只在图片上才看得见的漂移。
 */

/** 界面里的图片形态。`url` 是 **data URL**（`data:image/png;base64,…`） */
export interface DockImage {
  readonly url: string
  /** 可选：原始文件名。只用于展示与上传时的 `name` 参数，不参与任何判定 */
  readonly name?: string
}

/** 线上形态（与服务端 `TurnImage` 逐字段一致，镜像守卫钉住） */
export interface TurnImageWire {
  readonly mime: string
  readonly data: string
}

/**
 * 单条消息最多带几张图。
 *
 * 与 `packages/plugin-ai-assistant/src/types.ts` 的 `MAX_IMAGES_PER_MESSAGE`
 * 是**一份事实的两半**（浏览器不能 import 服务端模块），由 `test/uiDockImage.test.ts`
 * 读两侧源码逐字比对。漂移的症状是"界面允许选 4 张、服务端在第 5 张上 400"。
 */
export const MAX_IMAGES_PER_TURN = 4

/**
 * `image.save` 的 `index` 上界。数的是**整段对话**里图片的出现顺序（不是单条消息的 4 张）：
 * 用户完全可能在这一轮说"把上一轮那张图存起来"。真正的范围判定按实际张数来（见
 * `pickConversationImage`），这个上界只是防模型填一个荒唐的数。
 */
export const MAX_IMAGE_INDEX = 40

/**
 * 重编码后的长边上限（px）。
 *
 * 1280 是"够模型看清"与"localStorage 装得下"之间的取舍点：截图里的正文在这个尺寸下
 * 仍可读，而一张 4K 截图（~5 MB）压完通常落在 150~350 KB。
 */
export const IMAGE_MAX_EDGE = 1280

/** JPEG 重编码质量。0.82 是肉眼与体积的常见折点，再高体积涨得比清晰度快 */
export const IMAGE_JPEG_QUALITY = 0.82

/**
 * 小于这个字节数的原图**不重编码**。
 *
 * 为什么不是"一律重编码"：一张 80 KB 的 PNG 截图重编码成 JPEG 会变大、还会丢透明通道，
 * 而它本来就在预算内。判据是**字节数**而不是尺寸——用户真正在意的是"传得上去"。
 */
export const IMAGE_KEEP_BYTES = 400 * 1024

/** 允许的图片 MIME（与服务端 `IMAGE_MIME_WHITELIST` 是镜像；刻意不含 `image/svg+xml`） */
export const IMAGE_MIME_WHITELIST: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * 单张图 base64 载荷的字符上限（与服务端 `MAX_IMAGE_BASE64_CHARS` 是镜像）。
 *
 * 1.4M 字符 ≈ 1 MB 二进制。它比"压缩目标"宽、比"请求体上限"窄：
 * 客户端在 {@link toTurnImage} 与 `prepareImageFile` 两处据此提前拒绝，
 * 用户当场看到"这张图太大"，而不是发出去之后收一个 400。
 */
export const IMAGE_MAX_BASE64_CHARS = 1_400_000

/**
 * **整段对话**里保留的图片张数上限。
 *
 * ## 为什么必须有这一条（否则功能会自己在几轮之后坏掉）
 * 无状态轮次协议里，客户端每轮都要把**整段转录**发上去（服务端是唯一真源，
 * 它只回灌、不存储）。转录里带图 ⇒ 请求体随对话里的图片数**线性增长**：
 * 每张压缩后约 0.2~0.5 MB，而回合端点的请求体上限是有限的。不设上限的结局是
 * "聊到第十张图时突然 413"，而那时用户完全不知道自己做错了什么。
 *
 * ## 为什么是"丢掉最旧的"而不是"报错"
 * 旧图被丢掉时**文字仍在**，对话看起来仍然完整；而一个"不能再发图了"的报错
 * 会让用户以为功能坏了。这是一条**有损**的取舍，必须写在这里而不是埋在实现里：
 * 被丢掉的图在浏览器侧也没有第二份副本（`image.save` 读的就是这段转录），
 * 因此它既不会再发给模型，也不能再被存进知识库。
 * 用户真想留住某张图时，正确的动作是**当场**让助手 `image.save` 存下来。
 *
 * 8 × {@link IMAGE_MAX_BASE64_CHARS} ≈ 11 MB，与 `MAX_BODY_BYTES` 的关系见
 * `@geewiki/ai-assistant` 的 `src/index.ts`（那边留了余量给文本与工具结果）。
 */
export const MAX_CONVERSATION_IMAGES = 8

/** 把线上形态拼成界面形态。**唯一一处**拼接 data URL 的地方 */
export function dataUrlOf(mime: string, data: string): string {
  return `data:${mime};base64,${data}`
}

/**
 * 拆解一条 data URL。
 *
 * 只接受 `data:<mime>;base64,<载荷>`。**不接受非 base64 的 data URL**
 * （`data:text/html,<script>…` 形态）：那是把任意文本当图片传进 `<img src>` 的入口，
 * 而这里根本没有"非图片 data URL"的正当用途。
 */
export function splitDataUrl(url: string): TurnImageWire | null {
  const m = /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url)
  if (m === null) return null
  const mime = m[1]
  const data = m[2]
  if (mime === undefined || data === undefined) return null
  return { mime: mime.toLowerCase(), data }
}

/** 一条界面图片 → 线上形态；形态不认识时返回 `null`（调用方据此跳过它，而不是发一条坏载荷） */
export function toTurnImage(img: DockImage): TurnImageWire | null {
  const split = splitDataUrl(img.url)
  if (split === null) return null
  if (!IMAGE_MIME_WHITELIST.includes(split.mime)) return null
  // 超预算的图在这里就丢掉：发出去只会换来一个 400，而报错点离"这张图太大"很远
  if (split.data.length > IMAGE_MAX_BASE64_CHARS) return null
  return split
}

export function toTurnImages(images: readonly DockImage[]): TurnImageWire[] {
  const out: TurnImageWire[] = []
  for (const img of images) {
    const wire = toTurnImage(img)
    if (wire !== null) out.push(wire)
  }
  return out
}

/** 线上形态 → 界面形态（`done.messages` 回灌时用） */
export function fromTurnImages(raw: unknown): DockImage[] {
  if (!Array.isArray(raw)) return []
  const out: DockImage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const mime = o['mime']
    const data = o['data']
    if (typeof mime !== 'string' || typeof data !== 'string') continue
    if (!IMAGE_MIME_WHITELIST.includes(mime)) continue
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue
    out.push({ url: dataUrlOf(mime, data) })
  }
  return out
}

/** 从 `localStorage` 读回来的任意值里挑出合法图片（坏数据一律丢弃，绝不抛） */
export function normalizeDockImages(raw: unknown): DockImage[] {
  if (!Array.isArray(raw)) return []
  const out: DockImage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const url = o['url']
    if (typeof url !== 'string') continue
    if (splitDataUrl(url) === null) continue
    const name = o['name']
    out.push(typeof name === 'string' && name !== '' ? { url, name } : { url })
  }
  return out
}

/**
 * 一段对话里**全部**图片，按出现顺序（老 → 新）。
 *
 * 为什么是整段而不是"最后一条"：用户完全可能说「把刚才那张图存进 xx 页」——
 * 那是在**下一轮**才说的，而那时图片在更早的一条消息里。
 */
export function conversationImages(messages: readonly { readonly role: string; readonly images?: readonly DockImage[] }[]): DockImage[] {
  const out: DockImage[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const img of m.images ?? []) out.push(img)
  }
  return out
}

/**
 * 把整段转录里的图片裁到 `max` 张（**新的留下、旧的让位**），返回新数组。
 *
 * 只动 `images` 字段，**从不改文字**——旧图被丢掉之后那句话仍然读得通
 * （"这张图里的流程对吗"少了图会显得突兀，丢掉半句提问却会让对话彻底变形）。
 *
 * 用结构化泛型而不是 import `DockMessage`：`DockMessage` 在 `ui/sse.ts`，
 * 而 `sse.ts` 已经 import 本文件（反向 import 会成环）。
 */
export function trimConversationImages<T extends { readonly role: string; readonly images?: readonly DockImage[] }>(
  messages: readonly T[],
  max = MAX_CONVERSATION_IMAGES,
): T[] {
  let budget = max
  let changed = false
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const m = out[i]
    if (m === undefined) continue
    const imgs = m.images ?? []
    if (imgs.length === 0) continue
    if (budget <= 0) {
      // `as T`：对象展开泛型后 TS 不接受它仍等于 `T`（"可能被实例化成别的子类型"），
      // 而这里覆盖的正是约束里声明的那个可选字段，是安全的。
      out[i] = { ...m, images: undefined } as T
      changed = true
      continue
    }
    if (imgs.length > budget) {
      out[i] = { ...m, images: imgs.slice(imgs.length - budget) } as T
      budget = 0
      changed = true
      continue
    }
    budget -= imgs.length
  }
  return changed ? out : [...messages]
}

/**
 * 按 1 起的序号取图；`index` 为 `null` 时取**最新**一张。
 *
 * 默认取最新而不是"必须给序号"：模型看得到图、但数不准"这是第几张"。
 * 绝大多数用法只有一张图，此时任何序号都是噪声。
 */
export function pickConversationImage(images: readonly DockImage[], index: number | null): DockImage | null {
  if (images.length === 0) return null
  if (index === null) return images[images.length - 1] ?? null
  if (!Number.isInteger(index) || index < 1 || index > images.length) return null
  return images[index - 1] ?? null
}

/** 插入正文时用的 Markdown 图片引用 */
export function imageMarkdown(url: string, alt: string): string {
  // `alt` 里的 `]` 会提前闭合标签；`(`/`)` 在 URL 位置没有歧义问题，但 alt 有
  const safeAlt = alt.replace(/[[\]]/g, ' ')
  return `![${safeAlt}](${url})`
}

/**
 * 解析 `image.save` 的参数。
 *
 * 与 `page.update` 的 `parseUpdateArgs` 同一条纪律：参数来自模型（外部输入），
 * **第一件事就是校验**，形状不对返回一句给人看的话，不猜、不兜底。
 */
export interface ImageSaveArgs {
  readonly slug: string
  /** 1 起的序号；`null` = 用最新一张 */
  readonly index: number | null
  readonly name: string
  readonly alt: string
}

export function parseImageSaveArgs(args: unknown): ImageSaveArgs | string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return '参数必须是对象 { slug, index?, name?, alt? }'
  }
  const raw = args as Record<string, unknown>
  const slug = raw['slug']
  if (typeof slug !== 'string' || slug.trim() === '') return 'slug 必须是非空字符串'
  if (slug.length > 512) return 'slug 过长'
  let index: number | null = null
  if (raw['index'] !== undefined && raw['index'] !== null) {
    const n = raw['index']
    /*
     * 上界是**整段对话**的图片数（不是单条消息的 4 张）：`index` 数的是这次对话里
     * 全部图片的出现顺序——用户完全可能在这一轮说"把上一轮那张图存起来"。
     * 给一个宽松的上界只是防"模型填了一个荒唐的数"，真正的范围判定在
     * `pickConversationImage` 里（按实际张数）。
     */
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_IMAGE_INDEX) {
      return `index 必须是 1~${MAX_IMAGE_INDEX} 的整数（省略表示最新一张）`
    }
    index = n
  }
  const name = typeof raw['name'] === 'string' ? raw['name'].slice(0, 120) : ''
  const alt = typeof raw['alt'] === 'string' ? raw['alt'].slice(0, 200) : ''
  return { slug: slug.trim(), index, name, alt }
}

/**
 * 等比缩放到长边不超过 `maxEdge`。
 *
 * 原图已经够小时**原样返回**（连 1px 都不放大）：放大只会让文件更大、也更模糊。
 * 非有限值一律退回 `1×1`，避免 `canvas.width = NaN` 这种"画布静默变成 0 宽"的失败。
 */
export function scaleToFit(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 }
  }
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) }
  const k = maxEdge / longest
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** 人类可读的字节数（附件列表与错误提示用） */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * data URL → `Blob`（上传附件时作为裸 body）。
 *
 * 走 `atob` 而不是 `fetch(dataUrl)`：后者在部分浏览器上会被 CSP 的 `connect-src` 拦掉，
 * 表现为"上传按钮点了没反应"，而错误信息里完全看不出与图片有关。
 */
export function dataUrlToBlob(url: string): Blob | null {
  const split = splitDataUrl(url)
  if (split === null) return null
  /*
   * 白名单要在这里**再判一次**（`toTurnImages` 已经判过）：本函数是"什么能变成上传字节"
   * 的最后一跳，而它的调用方拿到的图可能来自 `localStorage` 里被改过的旧数据。
   * 放行非图片 MIME 会构造出 `image.html` 这样的文件名——服务端按扩展名会拒（415），
   * 但那条判据不该是唯一的一条。
   */
  if (!IMAGE_MIME_WHITELIST.includes(split.mime)) return null
  let binary: string
  try {
    binary = atob(split.data)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: split.mime })
}

/** 上传附件时的文件名：优先用原名，否则按 MIME 给一个确定的后缀 */
export function fileNameFor(img: DockImage): string {
  const split = splitDataUrl(img.url)
  const ext = split === null ? 'png' : split.mime === 'image/jpeg' ? 'jpg' : split.mime.slice('image/'.length)
  if (img.name !== undefined && img.name.trim() !== '') {
    // 服务端按**最后一个点之后**判扩展名；名字里没有点就补一个，否则会被判成"没有扩展名"
    return /\.[a-z0-9]+$/i.test(img.name) ? img.name : `${img.name}.${ext}`
  }
  return `image.${ext}`
}
