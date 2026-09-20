/**
 * `@geewiki/ai-assistant` —— AI 助手会话核心。
 *
 * ## 它在整个 AI 架构里的位置（设计文档 §1 的 L1）
 * ```
 * L3  app-dock 插槽 ← 本插件的 UI bundle（输入条 → 向上展开对话区）
 * L2  工具提供者     ← ai-kb / ai-summary / ai-writing / …（各自 requires ai-tool-service）
 * L1  本插件         ← agent loop + SSE + 系统提示 + 预算；★ 不含任何检索逻辑
 * L0  ai-tools / llm ← 先于本插件激活
 * ```
 *
 * 「不含任何检索逻辑」是本插件最重要的边界：`search_kb` / `read_page` / `list_pages`
 * 都是 `@geewiki/ai-kb` 贡献的**工具**。换一个知识库实现、加一个网络检索工具，
 * 本文件一行都不用改。
 *
 * ## 三个端点
 * - `POST /api/ai/turn`   —— 无状态回合（SSE）。**不 async、不返回 Promise**（见下）
 * - `GET  /api/ai/assistant/capabilities` —— 界面用来判断"该不该显示输入条"
 *
 * ## 为什么本插件**不** provide 服务
 * `@geewiki/ai-qa` 有 `ai-qa-service`（它替换了更早的 `ai-service`，有历史包袱）。
 * 本插件是全仓唯一一个"会话核心"，当前**没有任何消费方**。为一个不存在的消费方
 * 先设计一套接口，等于凭空立一份**没有测试、也没有真实调用点**的契约——
 * 它会在第一次真被使用时才发现形状不对，而那时它已经有很多"看起来能用"的假象。
 * 真出现消费方（例如第二个界面形态、或服务端定时任务要复用 agent loop）时再加。
 */
import type { Context } from 'cordis'
import type { RouteHandlerContext } from '@geewiki/core'
import {
  MAX_CONCURRENT_STREAMS,
  SSE_EVENT_DONE,
  SSE_EVENT_ERROR,
  SSE_EVENT_STATUS,
  SSE_EVENT_THINKING,
  SSE_EVENT_TOOL,
  createFrameWriter,
  createIdleWatchdog,
  writeSseHead,
  type TurnDoneEvent,
  type TurnFinishReason,
} from './sse.js'
import { STREAM_HARD_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '@geewiki/core'
import type { HttpRouterService, GeeWikiManifest } from '@geewiki/core'
import { redact, type LlmService } from '@geewiki/llm'
import { AI_TOOL_SERVICE_NAME, type AiToolService } from '@geewiki/ai-tools'
import { AiAssistantConfigSchema, parseTurnBody, type AiAssistantConfig } from './types.js'
import { resolveTurnTools } from './tools.js'
import { runAgentLoop } from './loop.js'

/* ============================== 端点与常量 ============================== */

export const TURN_PATH = '/api/ai/turn'
export const ASSISTANT_CAPABILITIES_PATH = '/api/ai/assistant/capabilities'

/**
 * **必需工具集**（决策 8 的判据，设计文档 §0.2）。
 *
 * 为什么只有 `search_kb` 一条：它是"答案有没有知识库依据"的**最低入口**。
 * `list_pages` / `read_page` 能让回答更准，但缺了它们助手仍可能通过检索拿到依据；
 * 缺了 `search_kb` 则**一条依据都拿不到**——那时它已经不是一个知识库助手了。
 *
 * 用一个数组而不是一个布尔，是为了让 `missing[]` 能指名道姓地说缺哪一条
 * （该去启用哪个插件是用户唯一能采取的行动）。
 */
export const REQUIRED_TOOL_NAMES: readonly string[] = ['search_kb']

/**
 * 请求体上限。
 *
 * 16 MB 是**被图片撑上去的**：无状态轮次协议每轮都要重发整段转录，转录里带图
 * ⇒ 请求体随对话里的图片数增长。取值与另外三个常量是一组：
 * `MAX_IMAGE_BASE64_CHARS`(1.4 MB) × `MAX_IMAGES_PER_MESSAGE`(4) ≈ 5.6 MB（单条消息的图），
 * 客户端 `MAX_CONVERSATION_IMAGES`(8) × 1.4 MB ≈ 11.2 MB（整段对话的图），
 * 余下的留给文本与工具结果（`maxRounds` 40 × `maxToolResultChars` 8000 = 320 KB）。
 *
 * 仍然**必须有**这道闸：没有它，一个匿名请求就能拿任意大的 body 把进程内存打满
 * （body 是整体缓冲后 `JSON.parse` 的）。它与逐图上限不是重复——
 * 那条挡"一张图吃掉整个预算"，这条挡"总量"。
 */
const MAX_BODY_BYTES = 16_000_000

/**
 * 测试专用注入口。**刻意不进 `configSchema`**——照 `@geewiki/ai-qa` 的先例：
 * 这三个值是"协议治理参数"，不是用户该调的业务配置。放进配置面板会让它们看起来
 * 可以随便改，而把并发上限调大或把超时关掉，破坏的是整个进程的稳定性。
 */
export interface AiAssistantPluginOptions {
  readonly streamHardTimeoutMs?: number
  readonly streamIdleTimeoutMs?: number
  readonly maxConcurrentStreams?: number
}

/* ============================== 请求体读取 ============================== */

/**
 * 读取并解析 JSON 请求体（上限 {@link MAX_BODY_BYTES}）。
 *
 * 与 `@geewiki/ai-qa` / `@geewiki/plugin-wiki` 的同名函数逐字同源：超限时**暂停**
 * 读取剩余请求体并由调用方写 413 后关连接；畸形 JSON 以 `invalid_json` 前缀的错误拒绝。
 * 三份实现长得一样不是好兆头，但把它们抽成共享工具属于平台层的事（会牵动三个包），
 * 不在本批范围内——这里保持与既有两份**逐字一致**，将来抽取时一眼能认出来。
 */
function readBody(h: RouteHandlerContext, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let rejected = false
    const chunks: Buffer[] = []
    h.req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        if (rejected) return
        rejected = true
        h.req.pause()
        rejectBody(new Error(`payload_too_large: 请求体过大（上限 ${limit} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    h.req.on('end', () => {
      if (rejected) return
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        rejectBody(new Error(`invalid_json: ${(err as Error).message}`))
      }
    })
    h.req.on('error', (err) => {
      if (!rejected) rejectBody(err)
    })
  })
}

/* ============================== 清单 ============================== */

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-assistant',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 助手',
    description: '常驻的 AI 对话入口：自己决定要不要查知识库、查什么，并把过程与来源如实展示',
    // 依赖以**服务标识**声明：数据库/检索实现切换对业务插件透明，依赖边由管理器按 provides 解析
    requires: ['http-service', 'llm-service', 'ai-tool-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true,
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: AiAssistantConfigSchema,
    // UI 产物：由 `@geewiki/web` 的 `build:plugin-ui` 编排构建到 public/plugins-ui/<包名>/
    client: { entry: 'client.js', css: 'client.css' },
    // 常驻底部输入条。**单占用**——两个助手同时启用时按"最早激活优先"裁决（同 `editor`）
    slots: ['app-dock'],
  },
}

/* ============================== 插件 ============================== */

export const AiAssistantPlugin = {
  name: manifest.name,
  apply(ctx: Context, config: AiAssistantConfig = {}, options: AiAssistantPluginOptions = {}) {
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/ai-assistant: http-service 不可用（@geewiki/http 未激活）')

    const cfg = {
      maxRounds: config.maxRounds ?? 40,
      maxToolResultChars: config.maxToolResultChars ?? 8_000,
      maxHistoryMessages: config.maxHistoryMessages ?? 40,
    }
    const maxStreams = options.maxConcurrentStreams ?? MAX_CONCURRENT_STREAMS
    /*
     * 三级取值：**配置项**（唯一能在部署里改的通道，见 types.ts 的说明）> 插件选项
     * （程序化装配时才用得上；管理器只传两个参数，所以它在生产里恒为 undefined）> 核心默认值。
     */
    const hardTimeoutMs = config.streamHardTimeoutMs ?? options.streamHardTimeoutMs ?? STREAM_HARD_TIMEOUT_MS
    const idleTimeoutMs = config.streamIdleTimeoutMs ?? options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS

    /** 已卸载标记。热重载期间仍持有本闭包的调用据此**显式拒绝**，而不是静默少给东西 */
    let disposed = false

    /**
     * 在途长连接的登记表：**同时**是并发计数器、持有者自清句柄、上游中止入口。
     *
     * 三件事用同一个 Map 而不是三个结构：它们必须**一起**增删。分成三处维护时，
     * 漏掉一处就会留下一条永远不消失的计数（表现为并发上限被慢慢吃掉，
     * 而没有任何报错）。这是 `@geewiki/ai-qa` 的既有形态，照搬。
     */
    const activeStreams = new Map<import('node:http').ServerResponse, () => void>()

    const llm = (): LlmService | undefined => ctx.get('llm-service') as LlmService | undefined
    const toolService = (): AiToolService | undefined =>
      ctx.get(AI_TOOL_SERVICE_NAME) as AiToolService | undefined

    /**
     * 生成**之前**的降级判定。返回非 null 表示"我们根本没调用模型"，
     * 调用方必须以普通 JSON 503 返回（在写任何 SSE 头之前）。
     *
     * 与 `@geewiki/ai-qa` 同源的口径：**503 = 前置条件不满足；502 = 上游真的失败了**。
     * 混成一个码会让界面与监控把"没配密钥"和"服务商挂了"当成同一件事，而它们该做的事相反。
     */
    const preGenerationDegraded = (): { reason: string; code: string | null; message: string } | null => {
      const svc = llm()
      if (!svc) {
        return { reason: 'no_provider', code: null, message: 'llm-service 不可用（@geewiki/llm 未激活）' }
      }
      if (svc.availableProviders().length === 0) {
        return {
          reason: 'no_provider',
          code: 'NO_ADAPTER',
          message: '没有可用的模型路由（未配置密钥或未注册服务商）',
        }
      }
      return null
    }

    const cleanups: Array<() => void> = []

    /* ---------------------------- 能力探测 ---------------------------- */

    cleanups.push(
      router.register('GET', ASSISTANT_CAPABILITIES_PATH, (h: RouteHandlerContext) => {
        const svc = llm()
        const pre = preGenerationDegraded()
        const tools = toolService()
        /*
         * 工具表**按主体取**：能力探测不能泄露当前主体看不见的工具名。
         * 没有主体（未登录）时返回空表，而不是拿一个伪造的匿名主体去查——
         * 伪造主体会让"探测结果"看起来像真的，而它其实什么都没查。
         */
        const principal = h.principal
        const toolNames = principal && principal.kind !== 'anonymous'
          ? resolveTurnTools(tools, principal, []).names
          : []
        const missing: string[] = []
        if (!svc) missing.push('llm-service')
        else if (pre !== null) missing.push('model_route')
        if (!tools) missing.push('ai-tool-service')
        /*
         * ★ 决策 8 的判据（设计文档 §0.2）：`available` **不能只看模型**。
         *
         * 只看模型的话，停掉 `@geewiki/ai-kb` 之后这个端点照样回答 `available: true`，
         * 而助手已经静默退化成一个通用聊天机器人了——用户从响应里看不出任何区别。
         * 这正是旧版 `mode:'retrieval-only'` 被删掉时反对的那件事，只是换了个位置发生。
         */
        const missingTools = REQUIRED_TOOL_NAMES.filter((n) => !toolNames.includes(n))
        for (const n of missingTools) missing.push(`tool:${n}`)
        h.json(200, {
          ok: true,
          // 「能对话」与「是个知识库助手」是两件事，这里回答的是后者
          available: pre === null && missingTools.length === 0,
          degraded: pre,
          tools: toolNames,
          /*
           * 当前模型收不收图 —— 界面据此决定**要不要显示图片按钮**。
           *
           * 为什么要下发而不是让浏览器猜：这是 LLM 设置里的一项显式声明，
           * 猜错的代价不对称（见 `LlmSettings.supportsVision`）。界面拿到 false 时
           * 不显示入口，用户就不会经历"贴了图、发出去、才发现发不了"。
           */
          vision: svc?.settings().supportsVision === true,
          missing,
        })
      }, { access: 'public' }),
    )

    /* ---------------------------- 回合 ---------------------------- */

    /**
     * 一个回合（`POST /api/ai/turn`）。**必须同步返回**：`@geewiki/http` 的 dispatch 只在
     * "处理器返回 thenable"时才把结算挂到 Promise 上；长连接若占用在途计数，卸载本插件时
     * 排空会一直等到连接关闭，必然空转满 `drainTimeout` 并打印**假的**"排空超时"告警。
     *
     * 阶段划分（**顺序即语义**）：
     * 1. 主体判定 + 读体 + 校验 + 全部前置条件 —— 都在任何 SSE 帧写出**之前**，
     *    失败一律普通 JSON（401/400/413/429/503）。**绝不用 SSE 表达"根本没开始"**：
     *    一旦写了头，状态码永远是 200，客户端的失败分流就没了依据；
     * 2. 登记长连接 + 写头；
     * 3. `status` 帧（工具表先落地）→ `delta`* / `tool`*；
     * 4. 终结：`done` 或 `error` **恰一帧**。
     */
    const handleTurn = (h: RouteHandlerContext): void => {
      void (async () => {
        /*
         * ★ 主体：决策 5 规定**只有登录用户**能用助手（匿名不渲染输入条）。
         * 界面不渲染只是"看不见"，服务端这道判定才是**真正**的那道——
         * 一个不渲染的组件拦不住任何东西。
         *
         * `break-glass`（应急通道）**放行**：它是管理员在事故中的旁路身份，
         * 拒绝它会让"用助手帮忙排查故障"在最需要的时候恰好不可用；
         * 而它本来就能读全库（见 `packages/core/src/index.ts` 的旁路规则），
         * 助手不会给它任何新能力。
         */
        const principal = h.principal
        if (!principal || principal.kind === 'anonymous') {
          h.json(401, {
            ok: false,
            error: 'unauthorized',
            message: 'AI 助手只对已登录用户开放',
            degraded: null,
          })
          return
        }

        let parsed: ReturnType<typeof parseTurnBody>
        try {
          parsed = parseTurnBody(await readBody(h))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (message.startsWith('payload_too_large:')) {
            h.json(413, { ok: false, error: 'payload_too_large', message, degraded: null })
            return
          }
          h.json(400, {
            ok: false,
            error: 'invalid_json',
            message: `请求体不是合法 JSON：${redact(message)}`,
            degraded: null,
          })
          return
        }
        if (!parsed.ok) {
          h.json(parsed.status, { ok: false, error: parsed.error, message: parsed.message, degraded: null })
          return
        }

        /*
         * 读体是 await 过的：这段时间里插件可能已被卸载。
         * 这个判定**不是死代码**——若跳过它，就会给一个已卸载的插件登记长连接，
         * 而 teardown 的 `closeStreams(owner)` 已经跑过了 ⇒ 连接悬着直到超时。
         */
        if (disposed) {
          h.json(503, {
            ok: false,
            error: 'unavailable',
            message: '插件已卸载，AI 助手不可用（重新激活后再试）',
            degraded: null,
          })
          return
        }
        if (activeStreams.size >= maxStreams) {
          // 并发上限是本插件的策略，路由服务不参与判定，故由这里主动上报
          router.noteStreamRejected?.()
          h.json(429, {
            ok: false,
            error: 'too_many_streams',
            message: `并发对话已达上限（${maxStreams}），请稍后重试`,
            degraded: null,
          })
          return
        }
        const noModel = preGenerationDegraded()
        if (noModel !== null) {
          h.json(503, { ok: false, error: 'model_unavailable', message: noModel.message, degraded: noModel })
          return
        }
        const llmSvc = llm()
        if (!llmSvc) {
          // preGenerationDegraded 已经覆盖；这里是给类型收窄用的第二道，不会真的走到
          h.json(503, { ok: false, error: 'model_unavailable', message: 'llm-service 不可用', degraded: null })
          return
        }

        /*
         * ★ 模型没声明支持看图时，**客户端仍塞了图就明确拒绝**（2026-09-20）。
         *
         * 为什么不在这一层"宽容地丢掉图片继续跑"：用户贴了图、看到回答里只字不提，
         * 会以为模型没认真看；而真正的原因（这个模型收不了图）一个字都没说出来。
         * 明确 400 + 一句可执行的指引，是这条链路上唯一诚实的处理。
         *
         * 输入条那一侧会据此**不显示图片按钮**（能力由 `capabilities` 端点下发），
         * 所以这条错误只在"设置被改小之后旧页面还开着"这类窗口里出现。
         */
        if (!llmSvc.settings().supportsVision && parsed.value.messages.some((m) => (m.images?.length ?? 0) > 0)) {
          h.json(400, {
            ok: false,
            error: 'vision_unsupported',
            message:
              '当前模型未声明支持图像输入（LLM 设置里的「支持图像输入」没有打开），' +
              '所以这次请求里的图片无法交给它。请去掉图片后重发，或让管理员打开该开关。',
            degraded: null,
          })
          return
        }

        // 工具表在写头**之前**定下来：它是 `status` 帧的内容，而 status 必须是首帧
        const table = resolveTurnTools(toolService(), principal, parsed.value.clientTools)

        /*
         * ★ 决策 8 / 设计文档 §0.2：**必需工具集缺席 ⇒ 明确不可用，不偷偷降级**。
         *
         * 知识库检索变成"贡献工具"之后，停掉 `@geewiki/ai-kb` 会让助手**静默变成通用
         * 聊天机器人**——它照样流畅地回答，只是答案不再来自知识库。那正是旧版
         * `mode:'retrieval-only'` 被删掉时反对的「冒充答案」的另一种形态：
         * 用户从一段通顺的文字里分辨不出它有没有依据。
         *
         * 判据放在**写 SSE 头之前**，于是它以普通 JSON 返回（503），
         * 客户端那条"前置条件失败 ⇒ 一句可执行的话"的路径原样生效。
         */
        const missingRequired = REQUIRED_TOOL_NAMES.filter((n) => !table.names.includes(n))
        if (missingRequired.length > 0) {
          h.json(503, {
            ok: false,
            error: 'tools_unavailable',
            message:
              `知识库工具不可用（缺少 ${missingRequired.join('、')}），助手现在只能凭自身知识作答，` +
              '因此不再冒充"查过知识库"。请让管理员启用 @geewiki/ai-kb 后重试。',
            degraded: {
              reason: 'tools_missing',
              code: null,
              message: `必需工具集不齐：缺少 ${missingRequired.join('、')}`,
            },
            missing: missingRequired,
          })
          return
        }

        const ac = new AbortController()
        const watchdog = createIdleWatchdog({
          idleMs: idleTimeoutMs,
          hardMs: hardTimeoutMs,
          /*
           * 把"哪一种超时"一路带到 `signal.reason`：用户看到的文案与运维看到的日志
           * 都据此区分（空闲＝上游长时间没产出；硬限＝这一轮就是太长了）。两条的下一步建议不同。
           */
          onTimeout: (kind) => ac.abort(kind === 'idle' ? 'idle_timeout' : 'hard_timeout'),
        })
        const writer = createFrameWriter(h.res)
        // 登记中止函数（而非仅登记 res）：卸载时**先 abort 上游再收连接**，
        // 否则连接虽被关闭、上游请求仍在跑并计费
        activeStreams.set(h.res, () => ac.abort('shutdown'))
        let untrack: (() => void) | undefined
        const started = Date.now()
        try {
          h.noteStatus?.(200) // 只记指标、不结束响应（json() 会 res.end，长连接不能用）
          writeSseHead(h.res)
          untrack = router.trackStream?.(h.res, manifest.name)
          // 客户端断连 → 立刻取消上游（用户关掉页面后不该继续烧 token）
          h.res.on('close', () => {
            if (!h.res.writableEnded) ac.abort('client_disconnect')
          })

          writer.write({
            event: SSE_EVENT_STATUS,
            data: {
              round: parsed.value.round,
              tools: table.names,
              clientToolsAccepted: table.clientToolsAccepted,
            },
          })

          const outcome = await runAgentLoop(
            {
              llm: llmSvc,
              principal,
              /*
               * 轮次上下文原样透传给工具。拿不到时是 `null`（**不是**空串）：
               * 写工具据此明确拒绝动手，而不是造一个假轮次把变更记到别处。
               */
              context: {
                conversationId: parsed.value.conversationId ?? null,
                turnId: parsed.value.turnId ?? null,
              },
              tools: table.offered,
              messages: parsed.value.messages,
              page: parsed.value.page,
              maxRounds: cfg.maxRounds,
              maxToolResultChars: cfg.maxToolResultChars,
              maxHistoryMessages: cfg.maxHistoryMessages,
              signal: ac.signal,
            },
            (ev) => {
              /*
               * ★ 每一处**我们自己的进展**都要重置空闲计时器。
               *
               * 这一行是真 bug 的修复（2026-09-16，用户："模型服务是有反应的"）：`kick()`
               * 此前**从未被调用过**，于是计时器只在回合开始时上弦一次——**任何超过 30 秒的回合
               * 都会被判成"空闲"**，哪怕上游一直在正常吐字、哪怕我们正忙着跑工具。
               * 用户那次是一轮跑了 9 个工具（读页面 + 检索），总时长过 30 秒 ⇒ 被砍。
               *
               * 语义应当是"什么进展都没有"：工具执行期间上游一个字节都不发，
               * 所以只在上游分片处重置是不够的。loop 每有一件事发生（开始吐字、工具开始/结束）
               * 都会走这里，正是"有没有进展"的权威信号。
               */
              watchdog.kick()
              if (ev.type === 'delta') {
                writer.write({ event: 'delta', data: { text: ev.text } })
                return
              }
              /*
               * 思考帧：**中间帧**，认识它的界面折起来显示，不认识的按 `invalid` 静默忽略。
               * 它同样算"进展"——上面那句 `watchdog.kick()` 已经涵盖了它，
               * 这一点很要紧：模型可能想很久才吐第一个正文字，那段时间若不重置空闲计时器，
               * 一个正常思考的回合会被当成卡死砍掉（正是这个计时器 2026-09-16 那次真 bug 的形态）。
               */
              if (ev.type === 'reasoning') {
                writer.write({ event: SSE_EVENT_THINKING, data: { text: ev.text } })
                return
              }
              if (ev.type === 'tool-start') {
                writer.write({
                  event: SSE_EVENT_TOOL,
                  data: { id: ev.id, name: ev.name, side: ev.side, arguments: ev.arguments, ok: null, summary: '' },
                })
                return
              }
              const a = ev.activity
              writer.write({
                event: SSE_EVENT_TOOL,
                data: { id: a.id, name: a.name, side: a.side, arguments: a.arguments, ok: a.ok, summary: a.summary },
              })
            },
          )

          /*
           * 中止**必须留一条日志**：用户看到的是界面上一句"本轮已中止"，而"到底是什么原因"
           * 只能从这里查（本批之前四条路径共用一句模糊文案，用户只能来问）。
           */
          if (outcome.error?.code === 'ABORTED') {
            console.warn(
              `[@geewiki/ai-assistant] 本轮中止: reason=${String(ac.signal.reason)} 轮次=${outcome.rounds} 工具=${outcome.toolResults.length} 用时=${Date.now() - started}ms（硬限 ${hardTimeoutMs}ms / 空闲 ${idleTimeoutMs}ms）`,
            )
          }
          if (outcome.error !== null) {
            /*
             * 已经生成过一部分之后失败：只能以 `error` 帧收尾（前置条件归前置条件，
             * 流内只说"开始生成之后"发生的事）。`message` 已经在 loop 里按 code 现推并脱敏。
             */
            writer.write({ event: SSE_EVENT_ERROR, data: { code: outcome.error.code, message: outcome.error.message } })
          } else {
            const finishReason: TurnFinishReason = outcome.finishReason
            const done: TurnDoneEvent = {
              event: SSE_EVENT_DONE,
              data: {
                messages: outcome.messages,
                answer: outcome.answer,
                finishReason,
                toolCalls: outcome.pendingToolCalls,
                mutatingTools: outcome.mutatingTools,
                grounded: outcome.grounded,
                // 依据的**出处清单**（`grounded` 只说"是不是知识库依据"，标注的措辞由它决定）
                groundingSources: outcome.groundingSources,
                toolResults: outcome.toolResults,
                usage: outcome.usage,
                // 两档"没能好好回答"必须让用户看见，不能糊成一句正常回答
                partial: finishReason === 'length' || finishReason === 'rounds',
                rounds: outcome.rounds,
                elapsedMs: Date.now() - started,
              },
            }
            writer.write(done)
          }
        } catch (err) {
          // 自身代码炸了：仍要以终止帧收尾（协议要求 done/error 恰一帧），message 必须脱敏
          console.error('[@geewiki/ai-assistant] 回合处理异常:', err)
          writer.write({
            event: SSE_EVENT_ERROR,
            data: {
              code: 'PROVIDER_ERROR',
              message: redact(err instanceof Error ? err.message : String(err)),
            },
          })
        } finally {
          // 无论走哪条路径都必须完成清理：定时器、路由登记、并发计数、响应收尾
          watchdog.clear()
          untrack?.()
          activeStreams.delete(h.res)
          writer.end()
        }
      })()
    }

    cleanups.push(
      router.register('POST', TURN_PATH, (h: RouteHandlerContext) => {
        // **不 async、不返回 Promise**：见 handleTurn 的注释
        handleTurn(h)
      }, { access: 'public' }),
    )

    console.log(
      `[@geewiki/ai-assistant] 已激活: POST ${TURN_PATH}、GET ${ASSISTANT_CAPABILITIES_PATH}（始终无状态回合，${maxStreams} 路并发上限，硬超时 ${hardTimeoutMs}ms / 空闲 ${idleTimeoutMs}ms）`,
    )

    return () => {
      // 先立"已卸载"标志：此后任何仍持有本闭包的调用都会显式拒绝，而不是静默少给东西
      disposed = true
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      /*
       * 收流顺序：**先 abort 上游，再关连接**。
       * 反过来的话，客户端会立刻看到一个正常结束的流，而上游请求仍在跑并计费。
       */
      const closers = [...activeStreams.values()]
      activeStreams.clear()
      closers.forEach((abort) => abort())
      router.closeStreams?.(manifest.name)
    }
  },
}
