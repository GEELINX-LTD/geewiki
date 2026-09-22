/**
 * `@geewiki/ai-assistant` 的**回合契约**：一次请求 = 一个回合，服务端**不持有跨回合状态**。
 *
 * ## 为什么是无状态轮次（而不是"服务端跑完整循环"）
 * 编辑框内容在浏览器里，`editor.*` 这类工具只能在客户端执行（设计文档 §3.3），
 * 于是"服务端独占整个循环"这条最省事的路走不通。三条可选路里选了最保守的一条：
 *
 * - ❌ 服务端持有会话状态 —— 违反本仓纪律（服务是全局单例、不持有请求上下文。
 *   `packages/plugin-wiki/src/index.ts` 的 `WikiService` 注释把这条写得很重）；
 * - ❌ 给 SSE 加一条上行通道 —— 等于自造一个双向协议，还要额外治理它的生命周期；
 * - ✅ **无状态轮次**：客户端把完整 `messages` 带上，服务端跑完**能自己跑的那部分**，
 *   把权威转录（`messages`）与待办调用一起回给客户端；客户端补齐后发起下一回合。
 *
 * 好处是现有的 `activeStreams` / abort / teardown 全部照用，没有新的连接形态。
 *
 * ## 两条**安全红线**（都有测试钉住，别当成风格问题）
 *
 * ### 1. 客户端不得注入 `system` 消息
 * `messages` 来自浏览器，是**外部输入**。系统提示由服务端**唯一**持有；
 * 若允许客户端塞一条 `role:'system'`，任何人都能用一句"忽略以上所有指令"把
 * 工具纪律、引文纪律、权限措辞全部改写掉——而这条注入**不改任何一行业务代码**就能生效。
 * 故 `role` 只接受 `'user' | 'assistant' | 'tool'`，出现 `'system'`（或任何未知角色）即 400。
 *
 * ### 2. 客户端上报的"可调用集"只能**收窄**，绝不能扩权
 * 见 `resolveTurnTools()`：服务端只认「注册表里确有 ∧ 该 owner 插件当前激活 ∧
 * 客户端声明它会执行」三者交集。一个没注册的名字被声明一万次也不会进工具表。
 */
import { AI_TOOL_IMAGE_MIME_WHITELIST } from '@geewiki/ai-tools'
import type { LlmToolCall } from '@geewiki/llm'
import Schema from 'schemastery'

/* ============================== 常量 ============================== */

/**
 * 单回合 `messages` 的条数上限。
 *
 * 这个值防的不是 token（`maxHistoryMessages` 管那个），而是**畸形请求**：
 * 一个几万条的数组会让每一轮的 JSON 序列化与校验都变慢，而真正的对话永远到不了这个量级。
 */
export const MAX_TURN_MESSAGES = 200

/**
 * 单条消息的字符上限。同样防畸形请求：正文由插件产出的工具结果回灌而成，
 * 正常情况下 `maxToolResultChars` 已经把它截住了；这里兜的是"客户端自己造了一条巨型消息"。
 */
export const MAX_MESSAGE_CHARS = 64_000

/** 客户端声明的客户端工具名条数上限（多到这个量级说明调用方在乱报，直接截断而不是 400） */
export const MAX_CLIENT_TOOLS = 64

/** 单条消息最多带几张图。防的是"一个请求塞进几十张图"把上游与内存都打满 */
export const MAX_IMAGES_PER_MESSAGE = 4

/**
 * 单张图片的 base64 **字符**上限（11M 字符 ≈ 8.25 MB 字节）。
 *
 * 为什么按字符而不是按字节：线上传输的就是 base64，而校验发生在解析前——
 * 字符数是**不解码**就能判定的量。解一次 8 MB 的 base64 只为"看看它是不是合法 base64"，
 * 那正是拒绝服务最省事的入口。
 *
 * **为什么是 8.25 MB 这个量级**（2026-09-21）：浏览器那侧**不再压缩照片**（用户要求，
 * 见 `docs/design/dock-images.md` §4），所以这一闸是"一张图能不能进来"的**唯一**判据。
 * 按"手机相机原图直传"取值：JPEG 原图常见 2~5 MB，高分辨率 PNG 截图能到 8 MB。
 * 再往上就不是"照片"而是"任意大的载荷"了，而 body 是整体缓冲后 `JSON.parse` 的。
 *
 * 取值不是随手定的：它与**另外两道闸**构成一组自洽的数字——
 * `MAX_IMAGES_PER_MESSAGE`(4) × 本值 ≈ 44 M 字符 ≤ `MAX_BODY_BYTES`(48 MB)，
 * 而客户端 `MAX_CONVERSATION_IMAGES`(4) × 本值同样 ≈ 44 M ≤ 48 MB。
 * 三者的关系由 `test/uiDockImage.test.ts` 的镜像守卫钉住；
 * 改任意一个而不同步另外两个，症状是"某张图在某一层被 413/400，而界面说它已发出"。
 *
 * 上游还有一道**本仓管不着**的闸：各家 OpenAI 兼容网关对单请求体 / 单图另有上限，
 * 具体值未实测（`docs/design/dock-images.md` §9 L12）。撞上了表现为上游 400。
 *
 * 浏览器侧的镜像常量是 `ui/imagePlan.ts` 的 `IMAGE_MAX_BASE64_CHARS`。
 */
export const MAX_IMAGE_BASE64_CHARS = 11_000_000

/**
 * 允许的图片 MIME 白名单。
 *
 * **真源在 `@geewiki/ai-tools` 的 `AI_TOOL_IMAGE_MIME_WHITELIST`**（2026-09-20）：
 * 这份名单现在有**三个**消费方——本层（线协议 + 工具结果校验）、工具实现
 * （`read_page` 挑正文里的图）、浏览器界面（另一份不能 import node 模块的镜像）。
 * 前两个都依赖 `@geewiki/ai-tools`，所以真源放那里；这里保留同名导出，
 * 是为了让"线协议的判据"仍然能在本文件里一眼读到，而不是散在依赖树里。
 *
 * **刻意不含 `image/svg+xml`**：SVG 是"能被解释的文档"，同源内联时可带脚本
 * （附件层已因此把它排除在内联之外）。交给上游模型既没有收益，也让"这张图到底是不是图"
 * 变成一个需要解释的问题。`image/gif` 保留：动图的第一帧对模型仍然有意义。
 */
export const IMAGE_MIME_WHITELIST: readonly string[] = AI_TOOL_IMAGE_MIME_WHITELIST

/** 裸 base64 的形态：字母表 + 至多两个 `=` 补齐。**不做长度必须是 4 的倍数的断言**（宽松处只此一项） */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/* ============================== 消息 ============================== */

/** 允许出现的角色。**刻意不含 `'system'`**——见文件头红线 1 */
export type TurnRole = 'user' | 'assistant' | 'tool'

/**
 * 随一条用户消息发给模型的图片。
 *
 * 形态是 `{mime, data}`（**不带 `data:` 前缀的裸 base64**）而不是一整条 data URL：
 * 校验必须能**分别**判定"这是不是白名单里的图片类型"与"载荷是不是合法 base64"，
 * 而从一整条 data URL 里反解这两件事，等于在本层再写一个 URL 解析器。
 * 折成 data URL 是**下游**（`loop.ts` 的 `toLlmMessages`）的事——那是唯一需要上游形态的地方。
 */
export interface TurnImage {
  readonly mime: string
  readonly data: string
}

/**
 * 往返于客户端与服务端之间的一条消息。
 *
 * **结构上与 `LlmMessage` 对齐**（`role` / `content` / `toolCalls` / `toolCallId`），
 * 另加一个 `name`：它是**给人看的**（界面上"调用了 search_kb"需要一个名字），
 * 转成 `LlmMessage` 时被丢弃——上游只要 `toolCallId` 就能配对，多带一个字段没有收益。
 */
export interface TurnMessage {
  readonly role: TurnRole
  readonly content: string
  /**
   * `role:'user'` 时：随这条消息一起发的图片（多模态）。
   *
   * 它**随转录原样往返**：`done.messages` 把用户那条连图一起回给客户端，
   * 客户端原样存下、下一轮原样带回（与"服务端是转录唯一真源"同一条纪律）。
   * 只允许出现在 user 上——模型与工具都不会"附图"。
   */
  readonly images?: readonly TurnImage[]
  /** `role:'assistant'` 时：本轮模型请求的全部工具调用（含服务端已执行的） */
  readonly toolCalls?: readonly LlmToolCall[]
  /** `role:'tool'` 时：对应哪一个调用（原样往返 `LlmToolCall.id`） */
  readonly toolCallId?: string
  /** `role:'tool'` 时：工具名。**只用于展示**，不进上游请求 */
  readonly name?: string
}

/**
 * 用户当前正在看的那一页（需求②「针对当前页回答」的落点）。
 *
 * **只有 slug 与标题，没有正文** —— 正文必须经 `read_page` 带主体去读。
 * 会话核心不含任何检索/读页逻辑（设计文档 §1），页面上下文在这里只是一个指路牌；
 * 若在这里把正文传进来，就等于给了一条**绕过 `wiki-service` 权限判定**的正文入口
 * （它来自浏览器，服务端无从校验"这个主体真的能看这一页"）。
 */
export interface TurnPage {
  readonly slug: string
  readonly title?: string
}

/** 解析并校验通过的请求体 */
export interface TurnRequest {
  readonly messages: readonly TurnMessage[]
  /** 客户端声明「这些客户端工具我能执行」。**只用于收窄**，不构成授权 */
  readonly clientTools: readonly string[]
  /** 回合序号（客户端自增，仅用于回显与日志，不参与任何判定） */
  readonly round: number
  /** 当前页指路牌；不在阅读页时为 null */
  readonly page: TurnPage | null
  /**
   * 决策 9 的本地会话 id（对话内容在浏览器里，服务端只存 id）。
   *
   * **可选**：不带它时服务端照常工作，只是写工具的变更**无处归属、因而不可回退**——
   * 那种情况由写工具自己明确拒绝（"记不下来就别改"），而不是在这里 400。
   * 为什么不做成必填：这条端点的只读用途（纯问答）本来就不需要轮次标识，
   * 为它强制一个字段会让所有只读调用点都要先造一个假 id。
   */
  readonly conversationId?: string
  /**
   * 回退粒度：**一次用户提问**（决策 10），不是一次 HTTP 回合。
   *
   * 无状态轮次协议下一次提问可能横跨多个回合（P3 实测 2 个），而用户心里的"那一轮"
   * 是他问的那一句话。故由**客户端**在整段提问里保持不变，服务端原样透传给工具。
   */
  readonly turnId?: string
}

/** 解析失败的结果。状态码与错误码的形状与 `@geewiki/ai-qa` 的 `parseAskBody` 同源 */
export interface TurnParseFailure {
  readonly ok: false
  readonly status: 400
  readonly error: 'invalid_body'
  readonly message: string
}

export type TurnParseResult = { readonly ok: true; readonly value: TurnRequest } | TurnParseFailure

/* ============================== 解析 ============================== */

const ROLES: readonly string[] = ['user', 'assistant', 'tool']

/**
 * 请求体里**允许出现**的键。多一个键就 400。
 *
 * 为什么对多余字段这么严：这个端点的入参直接决定"模型看到什么"，
 * 一个被拼错的名字（`message` / `msgs` / `histroy`）静默忽略的表现是
 * **模型一本正经地回答一个空对话**——排查方向会完全跑偏。宁可 400 并点名。
 */
const ALLOWED_KEYS: readonly string[] = ['messages', 'clientTools', 'round', 'page', 'conversationId', 'turnId']

/** 页面 slug 的长度上限。与 `@geewiki/wiki` 的 slug 规则同量级——它只是指路牌，不参与寻址 */
const MAX_SLUG_CHARS = 512
const MAX_TITLE_CHARS = 1_024
/** 会话 id / 轮次 id 的长度上限（它们只是标识，不该被塞进正文） */
const MAX_ID_CHARS = 200

function unknownKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !ALLOWED_KEYS.includes(k))
}

function parseToolCall(raw: unknown, where: string): LlmToolCall | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${where} 必须是对象`
  const obj = raw as Record<string, unknown>
  const id = obj['id']
  const name = obj['name']
  const args = obj['arguments']
  if (typeof id !== 'string') return `${where}.id 必须是字符串`
  if (typeof name !== 'string' || name === '') return `${where}.name 必须是非空字符串`
  if (typeof args !== 'string') return `${where}.arguments 必须是字符串（原样 JSON 文本，本层不解析）`
  return { id, name, arguments: args }
}

/**
 * 一张图的**形状**是否合规：MIME 命中白名单 ∧ base64 形态 ∧ 长度上限。
 *
 * 单独导出是因为它有**两个**判据完全相同的调用点：
 * ① 线协议（浏览器上送的图，不合规就 400）；② 工具结果里附带的图
 * （`loop.ts` 校验插件交上来的图，不合规就丢掉）。两处各写一遍必然漂移——
 * 而漂移的方向若是"工具那条更松"，就等于绕过了线协议的全部校验。
 *
 * **不解码**：解一次 1 MB 的 base64 只为验证它合不合法，那正是拒绝服务最省事的入口。
 */
export function isAcceptableImage(mime: unknown, data: unknown): boolean {
  if (typeof mime !== 'string' || !IMAGE_MIME_WHITELIST.includes(mime)) return false
  if (typeof data !== 'string' || data === '' || data.length > MAX_IMAGE_BASE64_CHARS) return false
  return BASE64_RE.test(data)
}

/**
 * 解析一条消息的图片数组。
 *
 * 逐项校验 MIME 白名单与 base64 形态，**不解码**（理由见 `MAX_IMAGE_BASE64_CHARS`）。
 * 形态不对一律 400：这是一条从浏览器来的、会原样转发给上游的载荷，
 * "宽容地包一层"只会把一个畸形请求变成上游的 400，报错点离病因更远。
 */
function parseImages(raw: unknown, where: string): TurnImage[] | string {
  if (!Array.isArray(raw)) return `${where}.images 必须是数组`
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    return `${where}.images 过多（${raw.length} > ${MAX_IMAGES_PER_MESSAGE}）`
  }
  const out: TurnImage[] = []
  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return `${where}.images[${i}] 必须是对象 { mime, data }`
    }
    const o = item as Record<string, unknown>
    const mime = o['mime']
    const data = o['data']
    if (typeof mime !== 'string' || !IMAGE_MIME_WHITELIST.includes(mime)) {
      return `${where}.images[${i}].mime 不支持：${String(mime)}（只接受 ${IMAGE_MIME_WHITELIST.join(' / ')}）`
    }
    if (typeof data !== 'string' || data === '') return `${where}.images[${i}].data 必须是非空 base64 字符串`
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      return `${where}.images[${i}].data 过大（${data.length} > ${MAX_IMAGE_BASE64_CHARS}）`
    }
    if (!BASE64_RE.test(data)) return `${where}.images[${i}].data 不是合法 base64`
    out.push({ mime, data })
  }
  return out
}

function parseMessage(raw: unknown, index: number): TurnMessage | string {
  const where = `messages[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${where} 必须是对象`
  const obj = raw as Record<string, unknown>
  const role = obj['role']
  if (typeof role !== 'string') return `${where}.role 必须是字符串`
  if (role === 'system') {
    /*
     * 单独给 system 一条**专门的**错误文案，而不是混进"角色非法"里。
     * 这是一条被主动拦下的注入尝试，不是一个拼写错误——两者的排查方向完全不同。
     */
    return `${where}.role 不得为 'system'：系统提示由服务端持有，客户端消息不参与指令层`
  }
  if (!ROLES.includes(role)) return `${where}.role 非法：${role}（只接受 ${ROLES.join(' / ')}）`

  const content = obj['content']
  if (typeof content !== 'string') return `${where}.content 必须是字符串`
  if (content.length > MAX_MESSAGE_CHARS) {
    return `${where}.content 超长（${content.length} > ${MAX_MESSAGE_CHARS}）`
  }

  const message: {
    role: TurnRole
    content: string
    images?: TurnImage[]
    toolCalls?: LlmToolCall[]
    toolCallId?: string
    name?: string
  } = {
    role: role as TurnRole,
    content,
  }

  if (obj['images'] !== undefined) {
    /*
     * 只允许 user 附图。assistant/tool 带图是**协议上没有的形态**：
     * 上游只接受 user 消息的多模态内容，放行它会在上游 400，而报错点离病因很远。
     */
    if (role !== 'user') return `${where}.images 只允许出现在 role:'user' 上（只有用户会附图）`
    const images = parseImages(obj['images'], where)
    if (typeof images === 'string') return images
    if (images.length > 0) message.images = images
  }

  if (obj['toolCalls'] !== undefined) {
    if (role !== 'assistant') return `${where}.toolCalls 只允许出现在 role:'assistant' 上`
    const rawCalls = obj['toolCalls']
    if (!Array.isArray(rawCalls)) return `${where}.toolCalls 必须是数组`
    const calls: LlmToolCall[] = []
    for (const [i, rawCall] of rawCalls.entries()) {
      const parsed = parseToolCall(rawCall, `${where}.toolCalls[${i}]`)
      if (typeof parsed === 'string') return parsed
      calls.push(parsed)
    }
    if (calls.length > 0) message.toolCalls = calls
  }

  if (obj['toolCallId'] !== undefined) {
    if (role !== 'tool') return `${where}.toolCallId 只允许出现在 role:'tool' 上`
    if (typeof obj['toolCallId'] !== 'string' || obj['toolCallId'] === '') {
      return `${where}.toolCallId 必须是非空字符串（缺了它上游无法把结果配回调用）`
    }
    message.toolCallId = obj['toolCallId']
  }
  if (role === 'tool' && message.toolCallId === undefined) {
    return `${where}：role:'tool' 必须带 toolCallId`
  }

  if (obj['name'] !== undefined) {
    if (typeof obj['name'] !== 'string') return `${where}.name 必须是字符串`
    message.name = obj['name']
  }

  return message
}

/** 只保留字符串项并去重，且**不改判定**——它在服务端只参与收窄（红线 2） */
function parseClientTools(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue
    seen.add(item)
    if (seen.size >= MAX_CLIENT_TOOLS) break
  }
  return [...seen]
}

/**
 * 解析页面指路牌。
 *
 * 非法值一律折算成 `null` 而**不是** 400：它是**附加线索**，不是这一轮的必要输入。
 * 为了一个拼错的标题把整轮对话打回，代价（用户重问一次）远大于收益
 * （少一次"针对当前页"的提示）。这与 `messages` 的严格恰好相反——那里拼错的表现
 * 是"模型对着空对话一本正经地回答"，必须炸；这里拼错只是少一条提示。
 */
function parsePage(raw: unknown): TurnPage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const slug = obj['slug']
  if (typeof slug !== 'string' || slug === '' || slug.length > MAX_SLUG_CHARS) return null
  const title = obj['title']
  const page: { slug: string; title?: string } = { slug }
  if (typeof title === 'string' && title !== '' && title.length <= MAX_TITLE_CHARS) page.title = title
  return page
}

/**
 * 校验一个回合请求。**入参是外部输入**，因此这里做的是"信任边界"上的工作：
 * 每个字段都必须被显式检查过，而不是相信 TypeScript 的类型。
 */
export function parseTurnBody(raw: unknown): TurnParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'invalid_body', message: 'body 必须是 JSON 对象' }
  }
  const body = raw as Record<string, unknown>

  const extra = unknownKeys(body)
  if (extra.length > 0) {
    return { ok: false, status: 400, error: 'invalid_body', message: `未知字段: ${extra.join(', ')}` }
  }

  const rawMessages = body['messages']
  if (!Array.isArray(rawMessages)) {
    return { ok: false, status: 400, error: 'invalid_body', message: 'messages 必须是数组' }
  }
  if (rawMessages.length === 0) {
    return { ok: false, status: 400, error: 'invalid_body', message: 'messages 不得为空' }
  }
  if (rawMessages.length > MAX_TURN_MESSAGES) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_body',
      message: `messages 过多（${rawMessages.length} > ${MAX_TURN_MESSAGES}）`,
    }
  }

  const messages: TurnMessage[] = []
  for (const [i, rawMessage] of rawMessages.entries()) {
    const parsed = parseMessage(rawMessage, i)
    if (typeof parsed === 'string') {
      return { ok: false, status: 400, error: 'invalid_body', message: parsed }
    }
    messages.push(parsed)
  }

  const round = body['round']
  if (round !== undefined && (typeof round !== 'number' || !Number.isInteger(round) || round < 0)) {
    return { ok: false, status: 400, error: 'invalid_body', message: 'round 必须是非负整数' }
  }

  /*
   * 轮次标识：形状不对就 400。
   *
   * 它们**决定写操作能不能被回退**，所以一个拼错的名字（`conversation` / `turn`）
   * 不该被静默忽略——那会变成"日志里多出一批无处归属的记录"，而用户要到点回退时才发现。
   * 但"没带"是允许的：那时写工具会明确拒绝动手（见 `TurnRequest` 的注释），不是 400。
   */
  const conversationId = body['conversationId']
  if (conversationId !== undefined && (typeof conversationId !== 'string' || conversationId.trim() === '')) {
    return { ok: false, status: 400, error: 'invalid_body', message: 'conversationId 必须是非空字符串' }
  }
  if (typeof conversationId === 'string' && conversationId.length > MAX_ID_CHARS) {
    return { ok: false, status: 400, error: 'invalid_body', message: `conversationId 过长（> ${MAX_ID_CHARS}）` }
  }
  const turnId = body['turnId']
  if (turnId !== undefined && (typeof turnId !== 'string' || turnId.trim() === '')) {
    return { ok: false, status: 400, error: 'invalid_body', message: 'turnId 必须是非空字符串' }
  }
  if (typeof turnId === 'string' && turnId.length > MAX_ID_CHARS) {
    return { ok: false, status: 400, error: 'invalid_body', message: `turnId 过长（> ${MAX_ID_CHARS}）` }
  }

  return {
    ok: true,
    value: {
      messages,
      clientTools: parseClientTools(body['clientTools']),
      round: typeof round === 'number' ? round : 0,
      page: parsePage(body['page']),
      // 只在真的给了的时候带上：`undefined` 与 `''` 是两件事，后者已被上面 400 掉
      ...(typeof conversationId === 'string' ? { conversationId } : {}),
      ...(typeof turnId === 'string' ? { turnId } : {}),
    },
  }
}

/* ============================== 配置 ============================== */

export interface AiAssistantConfig {
  /** agent loop 的**最大轮次**（一次请求内模型最多被调用几次） */
  maxRounds?: number
  /** 单条工具结果进上下文前的字符上限。**超限必须明说**（同 `read_page` 的截断纪律） */
  maxToolResultChars?: number
  /** 送往模型的历史消息条数上限（从头截断，保留最近的那些） */
  maxHistoryMessages?: number
  /**
   * 流式看门狗的**空闲**时限（毫秒）。这么久没有任何进展就中止本轮。
   *
   * 为什么它必须是配置项而不是内部常量：慢网关需要更宽的容忍度，而"多慢算正常"因部署而异
   * ——实测某次请求"第一个 token 都没在 30 秒内回来"，用户看到中止提示而网关并没死。
   */
  streamIdleTimeoutMs?: number
  /** 流式看门狗的**硬**时限（毫秒）：单次请求的总时长上限，不论是否有进展 */
  streamHardTimeoutMs?: number
}

export const AiAssistantConfigSchema = Schema.object({
  maxRounds: Schema.number()
    .default(40)
    .min(1)
    .max(64)
    .description('一次请求内最多调用模型几次（agent loop 上限）。太小则工具刚查到一半就被打断；太大则一个跑偏的问题会烧很多轮'),
  maxToolResultChars: Schema.number()
    .default(8_000)
    .min(500)
    .max(40_000)
    .description('单条工具结果进上下文的字符上限。超限会被截断并在结果里注明——不注明等于把「我没看到」伪装成「资料里没有」'),
  maxHistoryMessages: Schema.number()
    .default(40)
    .min(2)
    .max(200)
    .description('送往模型的历史消息条数上限（保留最近的部分）'),
  /*
   * 流式看门狗的两个时限（2026-09-16 从"写死的选项"改成配置项）。
   *
   * 为什么必须能配：它们此前只从 `apply(ctx, config, options)` 的**第三参**读，而管理器激活插件时
   * 只传两个参数（`module.apply(ctx, config)`）⇒ 那两个选项在生产里**根本到不了插件**，
   * 实际生效的永远是核心默认值 30s / 120s。实测症状：慢网关上"第一个 token 都没在 30 秒内回来"
   * 就被判成空闲中止（日志 `reason=idle_timeout 轮次=1 工具=0 用时=30002ms`）。
   *
   * 分工不变：`streamIdleTimeoutMs` 抓"上游卡住"（工具执行期间上游不发字节，但路由会在**每个进展
   * 事件**上调 `watchdog.kick()`，所以长工具阶段不会被误判）；`streamHardTimeoutMs` 抓"这一轮太长"。
   */
  streamIdleTimeoutMs: Schema.number()
    .default(30_000)
    .min(5_000)
    .max(600_000)
    .description('流式看门狗的**空闲**时限（毫秒）：这么久没有任何进展（上游无响应且没有工具在跑）就中止本轮'),
  streamHardTimeoutMs: Schema.number()
    .default(120_000)
    .min(10_000)
    .max(1_800_000)
    .description('流式看门狗的**硬**时限（毫秒）：单次请求的总时长上限，不论是否有进展'),
})
