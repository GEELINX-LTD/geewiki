/**
 * `@geewiki/ai-tools` 的类型契约：**工具 = 「AI 能做的动作」的可贡献项**。
 *
 * ## 为什么要有这一层
 * 工具不是新发明，是**把插槽那套贡献机制复制到「动作」维度**（设计文档 §2）：
 * 插槽回答"界面往哪插"，工具回答"AI 能做哪些事"。两者同构，
 * 因此插槽那批实测教训逐条适用，尤其是下面两条。
 *
 * ## 教训一：提供者必须是排在消费者之前的**独立插件**
 * 实测（`packages/manager/src/slot-plugin.ts` 文件头）：在一个插件 `apply` 尚未结算时
 * `provide` 的服务，**对它在此期间创建的子插件不可见**。最初的写法是"管理器在 `apply`
 * 开头 provide、然后 `boot()` 激活插件"，结果是插件的 `ctx.get('slot')` 拿到 `undefined`，
 * 于是它**静默跳过**了自己的贡献——而服务端查不到任何痕迹，与"这个插件本来就没贡献"
 * 完全没法区分。
 *
 * 故本服务由独立的 `@geewiki/ai-tools` 插件提供，**注册顺序排在管理器之前**
 * （见 `packages/server/src/index.ts` 的 `slotPlugin` 前移处，两者同理）。
 *
 * ## 教训二：主体**不能**做成可选参数
 * `packages/plugin-wiki/src/index.ts` 的注释写得极重：「把主体做成可选参数，任何『忘了传』
 * 的调用点都会静默退化成『不过滤』——那是把一次编码疏忽变成全量泄漏。」
 *
 * 本层把这条落成**两处编译期约束**（`packages/plugin-ai-tools/test/principal.test.ts`
 * 用 `@ts-expect-error` 钉住，谁把它改成可选，`pnpm typecheck` 自己就红）：
 * 1. {@link AiToolHandler} 的第一个参数是**必填**的 `Principal`；
 * 2. {@link AiToolService.list} 也必须带主体——**无权使用的工具根本不进模型的工具表**。
 *
 * 第 2 条不是洁癖：只按执行时拒绝的话，模型会跟用户说「我帮你改这一页」，然后 403。
 * 那比"这个能力不存在"更伤体验，而且顺带泄露了"这个能力存在"。
 */
import type { Principal } from '@geewiki/core'

/** 本插件声明的服务名（`ctx.get('ai-tool-service')` 用它查找） */
export const AI_TOOL_SERVICE_NAME = 'ai-tool-service'

/**
 * 单个工具的**描述文本**预算（字符）。
 *
 * 它不参与正确性，只参与**模型的选择准确率**：工具到几十个时，真正的成本不是 token
 * 而是注意力稀释（设计文档 §0.4）。故超预算**不抛错、只登记**——一个描述写长了是观感问题，
 * 让它把整个知识库工具带下线才是真问题（与插槽"未知插槽名告警但不阻断激活"同一条取舍）。
 * 膨胀经 {@link AiToolDiagnostics.overBudget} 对管理台可见。
 */
export const TOOL_DESCRIPTION_BUDGET = 200

/**
 * 工具执行发生在哪一侧。
 *
 * `'server'` 在插件的 node 代码里跑；`'client'` 在插件的浏览器 bundle 里跑
 * （编辑框内容在浏览器里，`editor.*` 这类工具只能如此）。
 *
 * P1 只有 `'server'`，但字段**现在就定下来**：它是破坏性的必填字段，
 * 等 P3 再加会让所有既有贡献者一次性编译失败。
 */
export type AiToolSide = 'server' | 'client'

/**
 * 工具描述符——**它直接进模型的工具表**，故每个字段都是面向模型的措辞，不是给人看的名词。
 */
export interface AiToolDescriptor {
  /**
   * 工具名。扁平、稳定、可读，**不许用包名当名字**（`kb.search` 而不是 `@geewiki/ai-kb.search`）：
   * 名字进的是模型的工具表，前缀只是噪声。
   */
  readonly name: string
  /**
   * 给模型看的一句话说明：它要能回答「什么时候该调用我」。
   * 光写"检索知识库"不够——模型需要知道**查询词该怎么写**才不至于空手而归。
   */
  readonly description: string
  /**
   * 参数的 JSON Schema。**必须是 `type: 'object'`**（OpenAI 工具协议的要求），
   * 在 {@link AiToolService.contribute} 时校验——否则会先炸在上游的 400 上，
   * 而报错点离病因很远。
   */
  readonly parameters: Record<string, unknown>
  readonly side: AiToolSide
  /**
   * 写类工具：会产生副作用，因而**必须能产生逆操作**（mutation journal，设计文档 §4），
   * 并受自锁护栏约束（AI 不得停掉它自己依赖的插件）。
   */
  readonly mutating?: boolean
  /**
   * 可选：该工具**对该主体**是否可用。不声明 = 所有已登录用户可用。
   *
   * 只在 `list()` 里过滤，**不在执行时过滤**——执行时另有各域自己的权限判定
   * （如 `wiki-service.get(slug, principal)` 返回 `undefined` 表示无权）。
   * 两者不是重复：这里管"别把无权的能力摆到模型面前"，那里管"真调了也不放行"。
   */
  readonly available?: (principal: Principal) => boolean
}

/**
 * 这次结果**算不算依据**，以及算哪一家的依据。
 *
 * **这不是一个待扩展的枚举，而是一个必须写下来的判断**：需求 ⑥ 要求「知识库之外的问题
 * 可以答，但必须显著标注」，而那条标注不能靠模型自觉写一句话（提示层的「请标注」不算
 * 护栏，模型可以不听）。判据必须来自**代码手里的事实**——而"这次工具返回的到底是什么"
 * 只有工具自己知道。
 *
 * `'web'` 是随 `@geewiki/ai-web-search`（联网搜索）一起定义的——这正是上面那条
 * 「不为将来的 `web_search` 预留取值」的兑现：**取值由真正产生它的那个插件连同它的
 * 界面标注一起加**，而不是先写一个没人产生的枚举值让人误以为它已经被用上。
 *
 * 两档的区别不是"可信/不可信"，而是**出处在哪**——界面据此给出不同措辞的标注
 * （「这不是知识库内容」vs「依据的是公开网络资料」）。同名工具返回 0 条命中时
 * **不得**声明任何一档：跑了却没拿到资料，不算依据（与 `search_kb` 同一条判据）。
 */
export type AiToolGrounding = 'kb' | 'web'

/**
 * 工具执行结果。
 *
 * `content` 是**唯一**会进模型上下文的部分，它会成为一条 `tool` 角色的消息。
 * 因此它必须当**数据**看，不是指令——系统提示里要写明这一点（P2），
 * 因为插件写的文本不该获得指令权。
 */
export interface AiToolResult {
  /** 回灌进模型上下文的文本（建议 JSON 字符串：模型对结构化文本更稳） */
  readonly content: string
  /** 供界面展示的结构化附带物；**不进模型上下文** */
  readonly data?: unknown
  /**
   * 可选：本结果构成哪一家的依据。**不声明 = 不构成任何依据**（缺省从严）。
   *
   * 为什么是**逐次结果**而不是逐条描述符：`search_kb` 命中 0 条时它确实跑了，
   * 但一个字的资料都没给模型——按描述符声明的话这一轮会被判成"有依据"，
   * 而那正是最危险的一种：模型答得很像知识库，依据却是它自己的先验知识。
   * 判据挂在返回值上，就不会有这种偏差。
   *
   * 漏声明的后果是**多标一次**「未使用知识库资料」，即往"如实交代"的方向偏；
   * 反过来的偏差（该标没标）才是需求 ⑥ 要消灭的东西。
   */
  readonly grounding?: AiToolGrounding
  /**
   * 可选：随本次结果一起交给模型的**图片**（如 `read_page` 读到的正文里引用的图）。
   *
   * ## 为什么它不是 `content` 的一部分
   * OpenAI 兼容协议里 `image_url` 内容块**只允许出现在 `user` 消息上**，`tool` 角色的
   * messages 必须是纯文本。所以图片不可能"跟着 tool 消息走"——会话核心会把它们折成
   * 一条**紧随该轮工具结果之后的 `user` 消息**（见 `@geewiki/ai-assistant` 的 `loop.ts`）。
   *
   * ## 三条纪律
   * 1. **只读工具才该带图。** 图片进上下文是有成本的（一张 1280px 的图约一千多 token），
   *    而"检索/定位"类工具（`search_kb` / `list_pages`）的用途是找页面，不是看图。
   * 2. **宁可少给、不可超给。** 会话核心还有一道硬闸（条数 / MIME / base64 长度），
   *    但那是**兜底**，不是让调用方随便塞的理由：被兜底丢掉的图，模型会以为它已经看到了
   *    而实际没有——除非调用方在 `content` 里如实写出自己给了几张。
   * 3. **`content` 必须自述。** 给了图就要在 `content` 文本里写明给了几张、分别是什么
   *    （文件名 / 尺寸），因为**图本身不带任何文字**：线上那条 flush 出来的 user 消息
   *    只有一句固定的引导语。模型分不清"这页没图"与"图没给我"，全靠 `content` 里的这句话。
   */
  readonly images?: readonly AiToolImage[]
}

/**
 * 工具交给模型的一张图。
 *
 * 形态刻意与线协议（`TurnImage`）**同构**：`{ mime, data }`、`data` 是**不含 data: 前缀**的
 * base64。这样"浏览器上送的图"与"工具读出来的图"在会话核心里走同一条校验与折叠路径，
 * 不会出现两套"什么算合法图片"的判据。
 */
export interface AiToolImage {
  /** 图片 MIME。**必须命中 {@link AI_TOOL_IMAGE_MIME_WHITELIST}**，否则会被核心丢弃 */
  readonly mime: string
  /** base64（**不含** `data:<mime>;base64,` 前缀） */
  readonly data: string
}

/**
 * 能进模型的图片 MIME —— **本仓关于"什么算图片"的单一真源**。
 *
 * 为什么放在工具契约层而不是会话核心：它同时被三处需要——
 * ① 会话核心（线协议校验 + 工具结果的兜底校验）、② 工具实现（`read_page` 挑附件）、
 * ③ 浏览器界面（另有一份不能 import node 模块的镜像，见 `ui/imagePlan.ts`）。
 * 前两处都已经依赖本包，放在这里就不会多出第三份会漂移的名单。
 *
 * **刻意不含 `image/svg+xml`**：SVG 是"能被解释的文档"，同源内联时可带脚本
 * （附件层已因此把它排除在内联之外）。交给上游模型既没有收益，
 * 也让"这张图到底是不是图"变成一个需要解释的问题。
 */
export const AI_TOOL_IMAGE_MIME_WHITELIST: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/**
 * 工具交给模型的一张图的**字节**上限（1 MB）。
 *
 * 取值不是随手定的：base64 后长度 = `⌈bytes/3⌉ × 4`，1 MB ⇒ 约 1.33 M 字符，
 * 稳稳落在会话核心对单张图的字符上限（`MAX_IMAGE_BASE64_CHARS` = 11 M，≈8.25 MB）之内。
 * 也就是说：**按本值挑出来的图，一定过得了核心那道闸**，不会出现"工具以为给了、
 * 核心却丢了"的分叉。两者的关系由 `@geewiki/ai-assistant` 的守卫测试钉住。
 *
 * **核心那道闸在 2026-09-21 抬到 8.25 MB（用户上传原图直传），本值刻意不跟着抬**：
 * 工具图是模型**主动索取**的站内附件截图，不是用户手里的照片，1 MB 够它看清一张图表；
 * 抬大本值换来的只是"一次 `read_image` 多烧几倍 token"。要读更大的图，让模型多调一次。
 *
 * 工具侧应当在**取字节之前**用它（`WikiService.readAttachment` 的 `maxBytes`），
 * 而不是读进来再丢：一张 25 MB 的附件读进内存再判"太大"是纯粹的浪费。
 */
export const AI_TOOL_IMAGE_MAX_BYTES = 1_000_000

/**
 * 工具的执行体。**主体是第一个参数，不是可选项**——见文件头教训二。
 *
 * `args` 声明为 `unknown` 而不是泛型：它来自模型（也就是**外部输入**），
 * 每个 handler 的**第一件事必须是校验**，而不是相信类型。
 */
/**
 * 这次工具调用**属于哪一轮**。
 *
 * 为什么必须有它：写操作要能被回退，而回退的粒度是"一次用户提问"（决策 10）。
 * 一个改页面的工具如果不知道自己在哪一轮，它要么记不下可回退的日志，
 * 要么只能把所有改动塞进同一个"未知轮次"——那样"回退到这一轮之前"就没有落点。
 *
 * 两字段都可为 `null`（客户端没带轮次标识时）。**取值由调用方负责，
 * 但"能不能在 null 的情况下动手"由工具自己决定**——本仓的写工具应当是"记不下来就别改"。
 */
export interface AiToolContext {
  /** 决策 9 的本地会话 id；服务端只存 id，不存对话内容 */
  readonly conversationId: string | null
  /** 回退粒度：一次用户提问（不是一次 HTTP 回合——无状态协议下一次提问可能跨多个回合） */
  readonly turnId: string | null
}

/**
 * 工具执行体。
 *
 * 两个参数是**必填**的，这不是洁癖：
 * - `principal` 必填（P1 的裁决）——把主体做成可选，任何"忘了传"的调用点都会静默退化成
 *   "不过滤"，那是把一次编码疏忽变成一次全量越权；
 * - `context` 必填——同上，忘了它就等于"这次改动不可回退"，而那种缺陷在用户点回退之前
 *   **完全不报错**。只读工具可以直接忽略它（把参数命名为 `_context`），
 *   但"忽略"必须是一个**写下来的决定**，而不是一次遗忘。
 */
export type AiToolHandler = (
  principal: Principal,
  args: unknown,
  context: AiToolContext,
) => Promise<AiToolResult>

/** 一条工具贡献：描述符 + 执行体 */
export interface AiToolContribution {
  readonly descriptor: AiToolDescriptor
  readonly execute: AiToolHandler
}

/** 解析后的工具（注册表内部形态 + 交给会话核心的形态） */
export interface ResolvedTool {
  /** 贡献者（插件名）：卸载时按它定向回收，也用于确定性排序 */
  readonly owner: string
  readonly descriptor: AiToolDescriptor
  readonly execute: AiToolHandler
}

/** 超预算的描述（供管理台把"工具表膨胀"变可见） */
export interface AiToolBudgetEntry {
  readonly owner: string
  readonly name: string
  readonly length: number
}

export interface AiToolDiagnostics {
  /** 当前贡献的工具总数（**不过滤主体**——它描述的是注册表，不是某次会话） */
  readonly count: number
  /** 描述超 {@link TOOL_DESCRIPTION_BUDGET} 的条目 */
  readonly overBudget: readonly AiToolBudgetEntry[]
  /** 写类工具的名字（自锁护栏与回退 UI 都要看这份名单） */
  readonly mutating: readonly string[]
}

export interface AiToolService {
  /**
   * 登记一条工具，返回**幂等**的注销函数。
   *
   * **重复 `name` 必须抛错，不得静默覆盖**——照 `LlmRouteDescriptor` 的先例
   * （「稳定唯一标识；重复注册必须抛错」）。名字是模型调用时的唯一凭据，
   * 两个工具共用一个名字时，"模型想调的那个"根本没有确定答案。
   */
  contribute(owner: string, tool: AiToolContribution): () => void
  /**
   * 当前主体可用、且已按确定性顺序排好的工具表。**这就是要发给模型的那一份**。
   *
   * 必须带主体（见文件头教训二）。
   */
  list(principal: Principal): readonly ResolvedTool[]
  /**
   * 按名字查贡献者。
   *
   * 刻意返回**单个**而不是数组：`contribute` 已保证名字唯一，
   * 一个返回 `string[]` 的 `ownersOf()` 会诱使读者以为"同名多方"是可能的形态，
   * 从而写出处理不存在情况的代码。
   */
  ownerOf(name: string): string | undefined
  /** 注销某贡献者的**全部**工具（卸载统一出口按 owner 调用） */
  release(owner: string): void
  /** 注册表自身的状态（工具数量 / 描述膨胀 / 写类名单） */
  diagnostics(): AiToolDiagnostics
}
