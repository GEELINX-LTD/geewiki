/**
 * `@geewiki/ai-assistant` 的客户端界面：**常驻底部输入条**（挂在宿主的 `app-dock` 插槽）。
 *
 * ## 形态（决策 1）
 * 收起时是一条贴视口底居中的输入条；聚焦或发送后**向上展开**对话区。
 * 对话区含：消息流、工具活动、历史入口（近 10 段）。
 *
 * ## 四条决定了本组件形状的约束
 *
 * 1. **服务端是转录的唯一真源**。客户端不自己拼 `messages`——每一轮的权威转录随
 *    `done.messages` 回来，原样存下、下一轮原样带回。自己拼就是第二份实现，
 *    而它漂移的表现是"模型看到的对话与用户看到的不一样"，且不会报错。
 *
 * 2. **`finishReason === 'tool_calls'` 不是结束**。服务端把控制权交回来，
 *    客户端要执行客户端工具、补消息、再发一轮。把它当结束，界面会在工具执行期间
 *    显示"已完成"，然后突然又冒出一段新回答。
 *
 * 3. **markdown 只在 `done` 之后渲染，且必须经宿主的 `renderMarkdown`**。
 *    流式期间每个 token 都跑一遍消毒既慢又会在半截表格/代码块上抖动；
 *    而消毒白名单是宿主一处的安全边界，插件只 `dangerouslySetInnerHTML`。
 *    宿主 SDK 不提供该能力时退回纯文本，**绝不**把模型文本直接注入 DOM。
 *
 * 4. **本地会话按用户隔离**（决策 12）。`props.userId` 是宿主下发的身份——
 *    插件不自己查 `GET /api/auth/me`，那会有"身份与渲染时刻不一致"的窗口，
 *    表现是把上一个用户的对话写到新用户键下。
 *
 * ## 路由不在本组件手里
 * 打开页面经 `openPage(slug)`；本文件**不出现** `location.hash` / `window.location`。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './style.css'
import { ChevronIcon, CollapseIcon, HistoryIcon, NewChatIcon } from './icons.js'
import {
  applyTurnEvent,
  buildTurnBody,
  errorLine,
  groundingAfterDone,
  runClientTools,
  defaultTransport,
  initialDockState,
  isAtBottom,
  toolRunSummary,
  loadConversations,
  MAX_CLIENT_ROUNDS,
  saveConversation,
  ackRestored,
  collectSnapshots,
  defaultJournalTransport,
  affectedSlugs,
  undoneSlugs,
  mutatingCalls,
  readDocText,
  readJournal,
  recordClientMutation,
  relativeTime,
  runRestoreSteps,
  undoHeadline,
  undoTurn,
  type JournalRecordView,
  type JournalTransport,
  type JournalTurnView,
  type GroundingLedger,
  titleOf,
  toolResultMessages,
  TURN_PATH,
  withUserMessage,
  type DockConversation,
  type DockMessage,
  type DockState,
  type MiniStore,
  type PageHint,
  type TurnTransport,
} from './dockPlan.js'
import { createTurnDecoder, type DoneData, type ToolActivityView, type TurnEvent } from './sse.js'

/* ============================== 宿主 SDK ============================== */

interface PluginUiHost {
  readonly pluginName: string
  readonly version?: string
  registerSlot(name: string, component: (props: AppDockSlotProps) => unknown): () => void
  renderMarkdown?(markdown: string): string
}

/**
 * `app-dock` 插槽的 props（`@geewiki/core` 的 `AppDockSlotProps` 镜像）。
 *
 * 与 `packages/web/src/lib/slots.tsx` 的同名接口**必须逐字段一致**——
 * 浏览器侧不能 import core（那里顶层 `import 'node:fs'`），一致性由
 * `test/uiDock.test.ts` 的源码级守卫钉住：漂移的症状是"宿主不传该字段、
 * 插件读到 undefined 且不报错"。
 */
interface AppDockSlotProps {
  readonly page: {
    readonly slug: string
    readonly kind: 'view' | 'edit' | 'list' | 'search' | 'graph' | 'admin'
  } | null
  readonly clientTools: readonly string[]
  readonly userId: number | null
  openPage(slug: string): void
  invokeTool(name: string, args: unknown): Promise<unknown>
}

/* ============================== 宿主能力 ============================== */

let markdownRenderer: ((markdown: string) => string) | null = null

/** 测试注入口：让用例不必构造宿主 SDK 就能验证渲染分支 */
export function setMarkdownRenderer(fn: ((markdown: string) => string) | null): void {
  markdownRenderer = fn
}

/**
 * 取 `localStorage`；不可用时退化为**内存实现**。
 *
 * 隐私模式与部分企业策略下访问 `localStorage` 会**抛异常**（不是返回 null）。
 * 为了"历史记录存不下"把整个输入条崩掉是最不划算的一种失败——对话本身不需要它。
 */
function resolveStore(): MiniStore {
  try {
    const ls = globalThis.localStorage
    if (ls) {
      const probe = '__geewiki_dock_probe__'
      ls.setItem(probe, '1')
      ls.removeItem(probe)
      return ls
    }
  } catch {
    /* 落到内存实现 */
  }
  const memory = new Map<string, string>()
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => {
      memory.set(k, v)
    },
  }
}

/* ============================== 组件 ============================== */

/** 一次回合里，模型请求客户端工具时，本次对话**最多**来回几轮（与服务端的 maxRounds 是两件事） */
const CLIENT_TOOL_TIMEOUT_NOTE = '（这一轮没能收尾：模型反复请求客户端工具，已停止）'

function newId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `c${Date.now().toString(36)}${rand}`
}

export interface AskDockOptions {
  /** 注入传输（测试用）；省略即 `fetch` */
  readonly transport?: TurnTransport
  /** 注入存储（测试用）；省略即 `localStorage` 或内存实现 */
  readonly store?: MiniStore
  /** 注入变更日志传输（测试用）；省略即 `fetch` */
  readonly journalTransport?: JournalTransport
}

export function AskDock(props: AppDockSlotProps & AskDockOptions): ReactNode {
  const transport = props.transport ?? defaultTransport
  const store = useMemo(() => props.store ?? resolveStore(), [props.store])
  const journalTransport = props.journalTransport ?? defaultJournalTransport

  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [state, setState] = useState<DockState>(initialDockState)
  /** 会话 id 在**挂载时**定下：刷新＝开新对话（决策 9），历史要显式进入 */
  const [conversationId, setConversationId] = useState(newId)
  const [history, setHistory] = useState<DockConversation[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  /** 这段对话里**还没撤**的轮次（回退 UI 的输入） */
  const [journal, setJournal] = useState<JournalTurnView[]>([])
  const [undoing, setUndoing] = useState('')
  const [undoNote, setUndoNote] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  /** 已经结束的对话才值得存；用一个 ref 记住"本轮是否已落库"，避免每帧都写 localStorage */
  const savedRef = useRef(false)
  /**
   * 依据账的**权威副本**（需求 ⑥），只在三处写：新提问时清零、读到 `done` 帧时累加、
   * 打开历史会话时载入。
   *
   * 为什么不能只靠 `state`：`runTurn` 在流读取的回调里 `setState`，而同一个 tick 之后
   * 就要落盘——那时 `state` 还是旧值，刚落下的标注会存不进 `localStorage`，
   * 表现是"刷新之后标注没了"。而**渲染仍然读 state**，ref 只是给 `runTurn` 与落盘用；
   * 不在渲染期反向同步它，是因为 `send()` 会在 React 重渲染**之前**就调 `runTurn`，
   * 那样同步反而会把上一问的账带进新的一问。
   */
  const ledgerRef = useRef<GroundingLedger>({ sawGrounding: false, anyGrounded: false, anyWeb: false, notGrounded: [], webGrounded: [] })

  /**
   * 内容指纹：消息数 + 流式正文长度 + 工具活动数 + 回退条目数 + 是否在生成。
   *
   * 用**几个数字拼成的一个原始值**当依赖，而不是把 `state` 整个放进依赖数组：
   * `state` 每帧都是新对象，放进去等于"每帧都滚一次"（流式期间每来一个字就滚，白干且抖）。
   * 这几个量恰好覆盖了对话区高度会变的全部来源（追加消息、正文变长、工具活动行出现、
   * 回退区块出现、思考中提示出现/消失、**思考块出现与展开**）。
   */
  const threadKey = `${state.messages.length}:${state.answer.length}:${state.thinking.length}:${state.activities.length}:${journal.length}:${state.streaming ? 1 : 0}:${state.error?.code ?? ''}`

  /*
   * 自动置底。三件事必须同时成立才对：
   *   ① 面板是展开的（收起时对话区被裁成 0 高，滚了也没意义，还会把 scrollTop 算成 0）；
   *   ② 用户此刻是"贴底"的（或刚刚发过消息 —— `send()` 会把 `pinnedRef` 置回 true）；
   *   ③ 滚的是**对话区自己**（`threadRef`），绝不能用 `window.scrollTo` /
   *      `scrollIntoView`：面板住在 `.gw-dock-clip`（`overflow: hidden`）里，
   *      `scrollIntoView` 会为了"把元素带进视野"去滚**裁剪盒**——展开动画期间会把揭幕
   *      起点拽到底部（动画批就是这么发现 `scrollTop≈200` 的），这里的焦点交接也因此用
   *      `focus({ preventScroll: true })`。
   */
  useEffect(() => {
    if (!open) return
    if (!pinnedRef.current) return
    const el = threadRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
  }, [threadKey, open])

  /** 展开面板、或切进一段历史会话 ⇒ 用户要看的是"最新"，回到最新并把跟随重新打开 */
  const stickToBottom = useCallback(() => {
    pinnedRef.current = true
    const el = threadRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    setHistory(loadConversations(store, props.userId))
  }, [store, props.userId])

  // 卸载即取消上游：用户关掉页面后不该继续烧 token
  useEffect(() => () => abortRef.current?.abort(), [])

  const pageHint: PageHint | null = props.page !== null ? { slug: props.page.slug } : null

  const persist = useCallback(
    (messages: readonly DockMessage[]) => {
      if (messages.length === 0) return
      const next = saveConversation(store, props.userId, {
        id: conversationId,
        title: titleOf(messages),
        updatedAt: Date.now(),
        messages,
        /*
         * 标注随回答一起落盘（需求 ⑥）。下标是**相对 `messages`** 的，而 `messages`
         * 只会向后追加（它是服务端下发的权威转录），故下标不会漂移。
         * 越界条目在读回来时会被丢弃（见 `loadConversations`）。
         *
         * 读 ledger 而不是读 state：`runTurn` 里刚 `setState` 的值在这个 tick 还读不到，
         * 而落盘恰好就在同一个 tick 之后——读 state 会让刚落的那条标注存不进去。
         *
         * `webGrounded` 必须一起存：两条标注是同一件事的两个档，只存一档的话，
         * 刷新之后"依据的是公开网络资料"那条会消失，而用户会把它读成有知识库出处。
         */
        notGrounded: ledgerRef.current.notGrounded,
        webGrounded: ledgerRef.current.webGrounded,
      })
      setHistory(next)
    },
    [store, props.userId, conversationId],
  )

  /**
   * 刷新"这段对话里哪些轮次改过东西、还没撤"。
   *
   * 只留 `pending` 非空的轮次：已经撤过的再显示一个按钮，用户点了会得到
   * "已经撤过了"——那是一个**看起来坏了**的正常结果，不该出现在界面上。
   */
  const refreshJournal = useCallback(async (): Promise<void> => {
    const turns = await readJournal(journalTransport, conversationId)
    setJournal(turns.filter((t) => t.pending > 0))
  }, [journalTransport, conversationId])

  useEffect(() => {
    void refreshJournal()
  }, [refreshJournal])

  /**
   * 回退到某一轮**之前**。
   *
   * 三步是分开的三件事，任何一步失败都**如实说出来**：
   * ① 服务端撤它认识的域（页面正文……），冲突检测也在这一步（探针优先，客户端不报快照）；
   * ② 浏览器撤它自己的域（编辑框草稿）——服务端没有 `editor` 域的读路径，故交回这里；
   * ③ 回报"浏览器撤完了"，让日志把那些记录标成已撤销。
   * 少了第③步，用户再点一次会**重复执行**同一批逆操作（对"设回旧值"看不出问题，
   * 对"删除刚创建的东西"就是灾难）。
   */
  const undo = useCallback(
    async (turnId: string): Promise<void> => {
      setUndoing(turnId)
      setUndoNote('')
      /*
       * 浏览器必须先交出**只有它知道**的那部分当前值（编辑框草稿），
       * 否则 `editor` 域的记录会因为"拿不到当前值"被当作冲突拒掉——
       * 表现为用户点了「回退」却没有反应（服务端是对的，是这里少报了一步）。
       * 页面的当前值**不由这里报**：服务端有探针，客户端报了也不算数。
       */
      const turn = journal.find((t) => t.turnId === turnId)
      const snapshots = await collectSnapshots(turn?.records ?? [], props.invokeTool)
      const report = await undoTurn(journalTransport, conversationId, turnId, snapshots)
      const { restored, failed } = await runRestoreSteps(report.clientSteps, props.invokeTool)
      await ackRestored(journalTransport, restored)
      const lines = [undoHeadline(report)]
      for (const reason of report.conflicts) lines.push(`· 没撤：${reason}`)
      for (const detail of report.failed) lines.push(`· 失败：${detail}`)
      for (const detail of failed) lines.push(`· 草稿没能还原：${detail}`)
      if (report.undone.length > 0 || restored.length > 0) {
        lines.push('（回退本身也能撤销：编辑框里按一次 ⌘Z。）')
      }
      setUndoNote(lines.join('\n'))
      /*
       * ★ 回退完了必须**通知宿主**（2026-09-16，用户报"回退后不会自动刷新"）。
       *
       * 回退走的是服务端的撤销执行体（页面正文已按快照改回去了），而页面上的正文是
       * `WikiDetail` 手里那份取来的数据——没有人告诉它，用户就得手动刷新。
       * 与"工具写完"完全同一条缝隙（`geewiki:content-changed`），只是来源不同。
       *
       * 只在**服务端真的撤掉了东西**时广播：全部冲突（`report.undone` 为空）时库没变，
       * 重取一次纯属打断阅读。受影响的页面取自本轮记录（见 `undoneSlugs` 的注释）。
       */
      if (report.undone.length > 0) notifyHostChanged(undoneSlugs(turn?.records ?? []), 'undo')
      setUndoing('')
      await refreshJournal()
    },
    [journalTransport, conversationId, props.invokeTool, refreshJournal, journal],
  )

  /** 跑一轮（含"模型要客户端工具 → 执行 → 再跑一轮"的循环） */
  const runTurn = useCallback(
    async (
      messages: readonly DockMessage[],
      round: number,
      /**
       * 这一**句**提问的轮次标识：由 `send()` 生成，并在本句引发的所有 HTTP 回合里
       * 原样传下去。刻意做成参数而不是 state —— `setState` 是异步的，
       * `setTurnId(x)` 之后紧接着的 `runTurn` 仍在旧闭包里，会用**上一句**的 turnId，
       * 于是第二句的改动被记进第一轮，回退时张冠李戴（而且不报错）。
       */
      turnId: string,
    ): Promise<void> => {
      if (round >= MAX_CLIENT_ROUNDS) {
        setState((s) => ({
          ...s,
          streaming: false,
          partial: true,
          error: { code: 'too_many_rounds', message: CLIENT_TOOL_TIMEOUT_NOTE },
        }))
        persist(messages)
        return
      }
      const ac = new AbortController()
      abortRef.current = ac
      const res = await transport(
        TURN_PATH,
        buildTurnBody({ messages, clientTools: props.clientTools, round, page: pageHint, conversationId, turnId }),
        ac.signal,
      )
      if (ac.signal.aborted) return

      if (res.kind === 'network') {
        setState((s) => ({ ...s, streaming: false, error: { code: 'network', message: res.message } }))
        persist(messages)
        return
      }
      if (res.body === null) {
        /*
         * 前置条件失败（401/400/413/429/503）以**普通 JSON** 返回——
         * 界面上它必须是一句可执行的话，而不是一个"生成中"卡住的流。
         */
        const failure = safeJson(res.text ?? '')
        setState((s) => ({
          ...s,
          streaming: false,
          error: {
            code: failure?.error ?? `http_${res.status}`,
            message: failure?.message ?? `请求失败（HTTP ${res.status}）`,
          },
        }))
        persist(messages)
        return
      }

      const decoder = createTurnDecoder()
      const textDecoder = new TextDecoder()
      let done: DoneData | null = null
      let errored = false
      const handle = (ev: TurnEvent): void => {
        setState((s) => applyTurnEvent(s, ev))
        if (ev.event === 'done') {
          done = ev.data
          // 与 `applyTurnEvent` 共用同一个纯函数（两份实现漂移的表现是"屏幕上有标注、刷新后没有"）
          ledgerRef.current = groundingAfterDone(ledgerRef.current, ev.data)
        }
        if (ev.event === 'error') errored = true
      }
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done: finished, value } = await reader.read()
          if (finished) break
          for (const ev of decoder.push(textDecoder.decode(value, { stream: true }))) handle(ev)
        }
        for (const ev of decoder.flush()) handle(ev)
      } catch (err) {
        if (!ac.signal.aborted) {
          setState((s) => ({
            ...s,
            streaming: false,
            error: { code: 'stream_broken', message: err instanceof Error ? err.message : String(err) },
          }))
        }
        return
      }
      if (ac.signal.aborted) return

      if (errored || done === null) {
        setState((s) => ({ ...s, streaming: false }))
        persist(messages)
        return
      }

      const finished: DoneData = done
      if (finished.finishReason === 'tool_calls') {
        const calls = finished.toolCalls ?? []
        /*
         * 写操作前后各存一份草稿快照 —— **观察式**，不是按名字猜。
         * 哪些调用是写操作的判定权在服务端（`done.mutatingTools`，来自描述符的
         * `mutating` 字段）；浏览器只负责"如果它真改了东西，就记下来"。
         * 读工具不会让草稿变化 ⇒ 不会产生记录，也就不会在回退时误撤用户自己的输入。
         */
        const writable = mutatingCalls(calls, finished.mutatingTools)
        const docBefore = writable.length > 0 ? await readDocText(props.invokeTool) : null
        const results = await runClientTools(calls, props.invokeTool)
        /*
         * 中间回合也要广播：写工具（如 page.update）多半在这一支里跑完——
         * 模型下一轮还要基于结果说话，但**用户眼前的正文已经该刷新了**，
         * 不必等整轮结束（等待期间看着旧正文正是用户报的那个现象）。
         */
        notifyHostIfMutated(finished)
        if (writable.length > 0 && docBefore !== null) {
          const docAfter = await readDocText(props.invokeTool)
          if (docAfter !== null && docAfter !== docBefore) {
            await recordClientMutation(journalTransport, {
              conversationId,
              turnId,
              tool: writable.map((c) => c.name).join(','),
              target: props.page?.slug ?? '',
              before: docBefore,
              after: docAfter,
            })
          }
        }
        const next = [...finished.messages, ...toolResultMessages(calls, results)]
        await runTurn(next, round + 1, turnId)
        return
      }

      setState((s) => ({ ...s, streaming: false }))
      persist(finished.messages)
      // 整轮结束时再广播一次（最后一轮里也可能有写操作）
      notifyHostIfMutated(finished)
      // 服务端工具（如 page.update）在这一回合里可能刚改过东西 ⇒ 刷新回退入口
      void refreshJournal()
    },
    [transport, props.clientTools, props.invokeTool, pageHint, persist, conversationId, journalTransport, refreshJournal],
  )

  const send = useCallback((preset?: string) => {
    /*
     * `preset` 给"中止后点继续"这类**按钮**用：它与用户在输入框里敲下同一句话走**完全同一条**
     * 路径（同样会作为一条用户消息进转录、同样会被持久化）——不做"隐藏的重发"，
     * 否则用户回看会话时不知道那一轮是怎么发起的。
     */
    const text = (preset ?? input).trim()
    if (text === '' || state.streaming) return
    if (preset === undefined) setInput('')
    setOpen(true)
    /*
     * **强制**置回贴底：用户刚提了问题，答案马上要在下面长出来。
     * 若此刻处于"用户往上翻过"的状态而不强制，新问题会落在视野外——
     * 那正是用户报的"每次都要手动滑到最下面"。
     */
    pinnedRef.current = true
    queueMicrotask(stickToBottom)
    abortRef.current?.abort()
    const seeded = withUserMessage({ ...state, messages: state.messages }, text)
    setState(seeded)
    /*
     * 依据账清零**必须在这里做**，不能等 `setState` 生效：下面那行 `runTurn` 在重渲染
     * 之前就开跑了，届时 ref 里还是**上一问**的账——新问题会继承旧结论，
     * 表现为"这次明明查了知识库却还挂着未使用资料的标注"。
     */
    ledgerRef.current = {
      sawGrounding: false,
      anyGrounded: false,
      anyWeb: false,
      notGrounded: seeded.notGrounded,
      webGrounded: seeded.webGrounded,
    }
    savedRef.current = false
    // 新的提问 ⇒ 新的轮次 id。**逐句**换，而不是逐回合换（见 runTurn 的注释）。
    void runTurn(seeded.messages, 0, newId())
  }, [input, state, runTurn])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    // 取消必须**显式落态**，否则界面永远停在"生成中"、按钮永远禁用
    setState((s) => ({ ...s, streaming: false }))
    persist(state.messages)
  }, [persist, state.messages])

  const startNew = useCallback(() => {
    abortRef.current?.abort()
    setState(initialDockState())
    setConversationId(newId())
    setHistoryOpen(false)
    setOpen(true)
  }, [])

  const openHistory = useCallback((conversation: DockConversation) => {
    abortRef.current?.abort()
    /*
     * 历史会话的标注**从落盘数据里恢复**（需求 ⑥）：不恢复的话，刷新页面再点进同一段对话，
     * 同一条回答就掉了标注——用户会把它读成有出处的，而那正是这个标注要防的误读。
     * 两个档都必须恢复：只恢复 `notGrounded` 的话，「依据的是公开网络资料」那条会消失，
     * 而它对应的回答同样"不是知识库内容"。
     * `sawGrounding/anyGrounded/anyWeb` 留 false：这段对话已经结束，不需要再算"这一问"的账。
     */
    setState({
      ...initialDockState(),
      messages: conversation.messages,
      notGrounded: conversation.notGrounded,
      webGrounded: conversation.webGrounded,
    })
    ledgerRef.current = {
      sawGrounding: false,
      anyGrounded: false,
      anyWeb: false,
      notGrounded: conversation.notGrounded,
      webGrounded: conversation.webGrounded,
    }
    // 载入历史会话 ⇒ 直接给到最新一条（否则用户点进去还停在会话开头）
    pinnedRef.current = true
    queueMicrotask(stickToBottom)
    setConversationId(conversation.id)
    setHistoryOpen(false)
    setOpen(true)
  }, [])

  const toolsLabel = state.tools.length > 0 ? `可用工具 ${state.tools.length} 个` : ''

  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 对话区（真正的滚动容器）——自动置底只能滚它，不能滚页面（见下面那段长注释） */
  const threadRef = useRef<HTMLDivElement | null>(null)
  /**
   * 现在是否"贴底跟随"。
   *
   * 初值 true：第一次展开面板、第一条消息落下时就该看到最新内容。
   * 之后只由**对话区自己的 `onScroll`** 改写——用户往上翻 ⇒ false（停止跟随），
   * 翻回底部 ⇒ 自动恢复跟随。`send()` 会**强制**置回 true：用户刚提的问题必须看得见，
   * 这正是本次返工的起因（原话："我发送新消息时，不会自动置底，每次都要手动滑到最下面"）。
   */
  const pinnedRef = useRef(true)
  /** 面板里的输入框：展开后焦点要**自己**落进来（见下面的 effect） */
  const inputRef = useRef<HTMLInputElement | null>(null)

  /*
   * 点外部 / 按 Esc 收起（2026-09-15，用户要求「当点击 dock 外的时候直接收起，
   * 而不是一定要点收起按钮」）。
   *
   * 判据只有一条：事件目标在不在**根节点**之内——用根节点而不是面板，因为面板、输入条、
   * 历史面板都挂在根节点下，它们任何一个都不该被算成"外部"。
   *
   * 为什么用 `pointerdown` 而不是 `click`：`click` 只在按下与抬起**落在同一个元素**时触发，
   * 在面板里拖选文字、在面板外松手就不会触发（这部分是好事），但拖选时 `click` 的 target
   * 可能是两者的**共同祖先**（有可能就是根节点自己）⇒ "在面板里拖选"被误判成内部。
   * 按下时就判，语义最干净：按下哪边，就是要操作哪边。
   *
   * 为什么挂**捕获阶段**（第三个参数 true）：宿主或插件内部任何 `stopPropagation` 都不该让
   * "点外部"失效——收起是 dock 自己的事，不该依赖别人把事件放行。
   *
   * 只在展开时挂：收起态挂着不但白多一个全局监听，还会让每次页面点击都白调一次
   * `setOpen(false)`。Esc 是同一件事的**键盘对应物**：没有它，键盘用户只能 Tab 到"收起"图标
   * 才能关掉这块面板。
   *
   * ⚠️ 收起后**不要把焦点还给输入行**：它的 `onFocus` 就是"展开"（见 `.gw-dock-row` 里
   * 那处 `onFocus={() => setOpen(true)}`），还焦点等于 Esc 无效（刚收起就又展开）。
   * 这也是"点外部"不会误伤自己的原因：按下点在根节点之外，焦点落在被点的元素上。
   */
  /*
   * 展开后把焦点放进输入框（2026-09-15 加，2026-09-16 第三批改写）。
   *
   * **它当初存在的原因已经消失了**：那时收起态的输入框在 `.gw-dock-bar` 里、展开态的
   * 在面板的 `.gw-dock-form` 里，是两个元素；用户点收起态那个 ⇒ 它 `onFocus` 把 `open`
   * 置真 ⇒ 它随即被收进 `inert` 的裁剪盒，浏览器把焦点甩到 `body` ⇒ 必须显式交接。
   * 现在只有**一个** `.gw-dock-row`（在裁剪盒之外、两个状态都在原地），点它不会丢焦点，
   * 交接也就不存在了。
   *
   * 保留它，是为了覆盖"不是点输入行打开的"那几条路径（`send` / `startNew` / `openHistory`
   * 里的 `setOpen(true)`，以及将来可能的快捷键）：那时焦点还在别处，展开后应当直接能打字。
   *
   * 两条边界：
   *   · 只在 `open` 变真时做（`if (!open) return`）——收起时绝不能碰焦点，
   *     否则会跟上面"点外部收起"的还焦点禁令打架；
   *   · 必须在 effect（DOM 已提交）里做，不能在渲染里：`inert` 是**同一次提交**里摘掉的，
   *     早一帧 focus 会被 inert 挡掉（元素还是不可聚焦的）。
   *
   * ⚠️ `preventScroll: true` 仍然保留：`.gw-dock-thread` 与 `.gw-dock-clip` 都是
   * `overflow: hidden/auto` 的盒子，而这类盒子**照样能被 focus 滚动**。不带这个选项时，
   * 浏览器为了"把输入框带进视野"会把裁剪盒滚到底（实测 scrollTop≈200），
   * 动画期间露出来的就不是本该揭开的内容，而且每一帧追着焦点重滚一次，看着就是抖。
   * 输入框在固定定位的 dock 里本来就完全可见，抑制掉没有代价。
   */
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current
      if (root === null) return
      const target = e.target
      if (target instanceof Node && root.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`gw-dock${open ? ' gw-dock-open' : ''}`} data-slot="app-dock">
      {/*
       * 面板**常驻 DOM**（2026-09-15 改版：展开/收起动画）。
       *
       * 改前是 `{open && (<section …/>)}`：元素被**卸载**，于是没有任何可插值的起点，
       * 展开与收起只能瞬间完成——用户的评价是「展开和收起没有动画，非常生硬」。
       * 改后收起态由 CSS 折叠（`.gw-dock-shell` 的 `grid-template-rows: 0fr`），
       * 展开时过渡到 `1fr`，两个方向因此都有动画。判据与守卫见
       * `test/uiDockMotion.test.ts`。
       *
       * 收起态**必须** `inert`：折叠只是几何变化，DOM 还在，不给 inert 的话
       * 「历史（N）」「新对话」「收起」「发送」这些看不见的按钮仍然进 Tab 序列——
       * 键盘用户会掉进一块空白里的焦点陷阱。`aria-hidden` 是同一件事对读屏的表述。
       */}
      <div className="gw-dock-shell">
        {/*
         * 这一层是**纯裁剪盒**，别往它身上加 padding/border/margin：网格项要能从
         * `1fr` 真的塌到 0，而 padding 与 border 不受 `min-height: 0` 约束，
         * 多 1px 边框收起后就留一条 1px 亮线。卡片的 padding/border/圆角/投影
         * 全部留在 `.gw-dock-panel` 上（它被这一层裁掉）。
         */}
        <div className="gw-dock-clip" inert={!open} aria-hidden={!open}>
          <section className="gw-dock-panel" aria-label="AI 对话">
            <header className="gw-dock-head">
              <span className="gw-dock-title">AI 助手</span>
              {toolsLabel !== '' && <span className="gw-dock-meta">{toolsLabel}</span>}
              <span className="gw-dock-spacer" />
              {/*
               * 三个头部动作是**纯图标**（2026-09-15 用户要求「都以图标来显示，不要文字」）。
               * 图标按钮没有可见文字，因此 `aria-label` 是**唯一**的可访问名来源——缺了它
               * 读屏只会念"按钮"；`title` 是给看得见的人的悬停提示。历史的条数不能随文字一起
               * 丢掉：视觉上是右上角的小角标，可访问名里照旧念「历史（3）」（角标自己
               * `aria-hidden`，否则与 aria-label 重复朗读）。`aria-expanded` 让"历史面板开着"
               * 这个状态不止靠颜色表达。判据见 `test/uiDockIcons.test.ts`。
               */}
              <button
                type="button"
                className={`gw-dock-icon${historyOpen ? ' gw-dock-icon-on' : ''}`}
                onClick={() => setHistoryOpen((v) => !v)}
                aria-label={`历史（${history.length}）`}
                aria-expanded={historyOpen}
                title="历史对话"
              >
                <HistoryIcon />
                {history.length > 0 && (
                  <span className="gw-dock-count" aria-hidden="true">
                    {history.length}
                  </span>
                )}
              </button>
              <button type="button" className="gw-dock-icon" onClick={startNew} aria-label="新对话" title="新对话">
                <NewChatIcon />
              </button>
              <button
                type="button"
                className="gw-dock-icon"
                onClick={() => setOpen(false)}
                aria-label="收起"
                title="收起"
              >
                <CollapseIcon />
              </button>
            </header>

            {historyOpen && (
              /*
               * 历史面板（改版，2026-09-15）。
               *
               * 改前是一个**裸 `<ul>`**：没有容器、没有标题，而且作为 flex 子项被
               * `.gw-dock-thread` 挤到只剩 40px —— 三段历史只看得见一条，另外两条要靠
               * 列表自己那条内嵌滚动条去翻。用户的原话是「当前的历史显示不正常」。
               *
               * 改后：有标题、有背景与圆角的真面板；`flex: none` 保证它拿到自己需要的高度；
               * 每条带**相对时间与消息条数**（标题常常长得差不多，没有时间就分不清哪段是刚才的）；
               * 当前正在看的那段高亮（否则点进去之后无法确认"我在哪一段里"）。
               */
              <div className="gw-dock-history-panel">
                <div className="gw-dock-history-head">
                  <span>最近对话</span>
                  {/*
                    这句是**语义**不是装饰：会话（含工具调用与回退记录）只存在这台设备的
                    localStorage 里，换浏览器就没有了。用户有权在点进去之前知道这件事。
                  */}
                  <span className="gw-dock-history-hint">只存在这台设备上</span>
                </div>
                <ul className="gw-dock-history">
                  {history.length === 0 && <li className="gw-dock-empty">还没有历史对话</li>}
                  {history.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`gw-dock-history-item${c.id === conversationId ? ' gw-dock-history-item-active' : ''}`}
                        onClick={() => openHistory(c)}
                      >
                        <span className="gw-dock-history-title">{c.title}</span>
                        <span className="gw-dock-history-meta">
                          {relativeTime(c.updatedAt)} · {c.messages.length} 条消息
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div
              className="gw-dock-thread"
              role="log"
              aria-live="polite"
              ref={threadRef}
              /*
               * 只在**用户自己**滚动时更新跟随状态：贴底 ⇒ 继续跟随，往上翻 ⇒ 停止跟随。
               * 程序化置底同样会触发一次 scroll 事件，读出来还是"贴底"，所以这里不会自我否定。
               */
              onScroll={(e) => {
                pinnedRef.current = isAtBottom(e.currentTarget)
              }}
            >
              {state.messages.length === 0 && state.answer === '' && (
                <p className="gw-dock-empty">
                  问点什么吧。我会先判断要不要查知识库——需要查的时候自己去查，并告诉你查到了哪些页面。
                </p>
              )}
              {renderThread(state)}
              {/*
                占位提示只在"**什么都还没到**"时出现（一个字节的思考都还没收到）。
                一旦思考开始流入，那句话已经由 `ThinkingRun` 的摘要行负责
                （"正在思考…（N 字）"）——两处同时显示就是两句一样的字。
              */}
              {state.streaming && state.answer === '' && state.activities.length === 0 && state.thinking === '' && (
                <p className="gw-dock-thinking">正在思考…</p>
              )}
              {state.partial && state.finishReason === 'rounds' && (
                <p className="gw-dock-warn">这次没查完（达到轮次上限），可以换个更具体的问法。</p>
              )}
              {state.partial && state.finishReason === 'length' && (
                <p className="gw-dock-warn">回答被长度上限截断了。</p>
              )}
              {state.error !== null && (
                <p className="gw-dock-error" role="alert">
                  {errorLine(state.error.code, state.error.message)}
                </p>
              )}
              {/*
                中止后的**就地继续**入口（2026-09-16）。
                起因：文案里写着"可以点「继续」接着做"，而界面上根本没有那个按钮
                ——我把用户上一轮**自己发的一条消息**（右对齐气泡）当成了按钮。
                现在它是一个真的按钮，且与在输入框里敲"继续"走同一条路径。
              */}
              {state.error !== null && !state.streaming && state.error.code === 'ABORTED' && (
                <div className="gw-dock-error-actions">
                  {/* 只用插件自己的类名：焦点环由 CSS 的 `.gw-dock-btn:focus-visible` 负责 */}
                  <button type="button" className="gw-dock-btn gw-dock-btn-primary" onClick={() => send('继续')}>
                    继续
                  </button>
                </div>
              )}

              {/*
                回退入口：**每一轮一个**（决策 3 / 设计文档 §5.1）。
                只列"改过东西且还没撤"的轮次——已经撤过的再摆一个按钮，用户点了会得到
                "已经撤过了"，那是一个看起来像坏了的正常结果。
              */}
              {journal.length > 0 && (
                <section className="gw-dock-undo" aria-label="可回退的改动">
                  <p className="gw-dock-undo-title">这次对话改过这些东西，可以回退：</p>
                  <ul className="gw-dock-undo-list">
                    {journal.map((turn) => (
                      <li key={turn.turnId} className="gw-dock-undo-item">
                        <span className="gw-dock-undo-what">
                          {turn.pending} 处 · {describeTargets(turn.records.filter((r) => r.undoneAt === null))}
                        </span>
                        <button
                          type="button"
                          className="gw-dock-btn gw-dock-btn-small"
                          disabled={undoing !== ''}
                          onClick={() => void undo(turn.turnId)}
                        >
                          {undoing === turn.turnId ? '正在回退…' : '回退到这一轮之前'}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {undoNote !== '' && (
                    <p className="gw-dock-undo-note" role="status">
                      {undoNote}
                    </p>
                  )}
                </section>
              )}
            </div>


          </section>
        </div>

      {/*
       * ---------- 唯一的输入行（2026-09-16 第三批） ----------
     *
     * 用户原话："感觉收起的输入框和展开的是两个东西。"——**它们字面上就是两个元素**：
     * 收起态是 `.gw-dock-bar` 里的输入框、展开态是面板底部的 `.gw-dock-form` 里的输入框，
     * 连占位文案都不同（「问 AI 助手…」vs「问关于「slug」或整个知识库…」）。
     * 之前为了让这段交接不露馅，堆了三处补丁：常驻 DOM + 裁剪盒高度插值 + 把输入条抬 19px
     * 去对齐面板里的那一行（`--dock-row-lift`）。补丁再多也改不了"有两个盒子"这件事：
     * 交接期间两个框同时在收缩/淡入，看起来就是换了一个东西。
     *
     * 现在合成**一个** `.gw-dock-row`，把它放在卡片（`.gw-dock-shell`）内部、裁剪盒**之外**：
     *   · 卡片用 `grid-template-rows: 0fr auto`——第一行是裁剪盒（0 → 内容高），第二行是它；
     *     卡片钉在屏幕底边（根是 `position: fixed; bottom: 16px`），第一行长大时卡片向上长，
     *     第二行**一动不动**；
     *   · 于是"收起态那个输入框"与"展开态那个输入框"是同一个 DOM 节点：焦点不丢、
     *     不会有 19px 落差、也就不存在交接（`--dock-row-lift` 已删除）；
     *   · 面板只负责往上长（表头 + 对话流），切到 `inert` 的也只剩裁剪盒这一层，
     *     输入行必须始终可交互，所以 `inert` 从外壳挪到了裁剪盒上。
     */}
          <form
            className="gw-dock-row"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <input
              ref={inputRef}
              className="gw-dock-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setOpen(true)}
              placeholder={props.page !== null ? `问关于「${props.page.slug}」或整个知识库…` : '问关于知识库的任何问题…'}
              aria-label="对 AI 助手提问"
            />
            {state.streaming ? (
              // type="button" 是**必需**的：它坐在 form 里，默认会被当成提交
              <button type="button" className="gw-dock-btn" onClick={stop}>
                停止
              </button>
            ) : (
              <button type="submit" className="gw-dock-btn gw-dock-btn-primary" disabled={input.trim() === ''}>
                发送
              </button>
            )}
          </form>
      </div>
    </div>
  )
}

/* ======================= 内容变更广播（跨插件缝隙） ======================= */

/**
 * 宿主「内容变更」事件的**字面量镜像**（宿主侧定义在
 * `packages/web/src/lib/contentEvents.ts` 的 `CONTENT_CHANGED_EVENT`）。
 *
 * 为什么两边各写一份字面量而不是共享常量：插件 UI 是**独立构建**的产物，
 * 外部化只有 react 系，import 宿主模块会失败或打进第二份模块。
 * 于是"事件名与 detail 形状"就是这个契约的全部，由
 * `test/uiDockContent.test.ts` 与宿主文件逐字比对（同一模式见工具名镜像守卫）。
 */
const CONTENT_CHANGED_EVENT = 'geewiki:content-changed'

/**
 * 服务端写工具跑完后通知宿主失效。
 *
 * 用户报的缺陷：让 AI 改当前这篇文章，库里已经变了，但页面上还是旧正文（得手动刷新）。
 * 宿主侧订阅这个事件后会重取正文（见 `packages/web/src/pages/WikiPage.tsx` 的订阅处）。
 *
 * 用 `window` 上的 DOM 事件是刻意的：这是**插件与宿主之间唯一的缝隙**，
 * 宿主不需要认识 AI 助手，插件也不需要认识宿主的 store。
 */
/**
 * 广播"内容变了"（工具写完、回退完都走这里）。
 *
 * `slugs` 为 `null` 表示"变更发生但不知道具体是哪一页"⇒ 也广播（宿主按当前页处理）。
 * 宿主侧的订阅与理由见 `packages/web/src/lib/contentEvents.ts`。
 */
function notifyHostChanged(slugs: readonly string[] | null, source: string): void {
  if (slugs === null) return
  window.dispatchEvent(
    new CustomEvent(CONTENT_CHANGED_EVENT, {
      detail: { slugs, source: `@geewiki/ai-assistant:${source}` },
    }),
  )
}

function notifyHostIfMutated(done: {
  toolResults?: readonly ToolActivityView[] | null
  mutatingTools?: readonly string[]
}): void {
  /*
   * 判据只读 `toolResults`（执行结果）——**不要**读 `toolCalls`：最终 done 帧的 `toolCalls`
   * 可以是 `null`（那一轮模型没再发起调用），写操作只记录在结果里。这一条真踩过：
   * 只看 toolCalls 时 AI 改了库、屏幕却不动（见 `dockPlan.ts` 的 affectedSlugs 注释）。
   */
  const slugs = affectedSlugs(done.toolResults ?? [], done.mutatingTools)
  // `null` = 这一回合没有成功的写操作（读页面不算）⇒ 不发信号，避免无谓重取
  notifyHostChanged(slugs, 'tool')
}

/* ============================== 渲染 ============================== */

function safeJson(text: string): { error?: string; message?: string } | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const o = parsed as Record<string, unknown>
    return {
      ...(typeof o['error'] === 'string' ? { error: o['error'] } : {}),
      ...(typeof o['message'] === 'string' ? { message: o['message'] } : {}),
    }
  } catch {
    return null
  }
}

/** 正文：流式期间纯文本，结束后（有宿主消毒管线时）走 markdown */
function Body(props: { readonly text: string; readonly rich: boolean }): ReactNode {
  if (props.rich && markdownRenderer !== null) {
    // 宿主那条 marked → DOMPurify 管线是**唯一**的消毒实现（见文件头第 3 条）
    return <div className="gw-dock-md" dangerouslySetInnerHTML={{ __html: markdownRenderer(props.text) }} />
  }
  return <div className="gw-dock-text">{props.text}</div>
}

/** 把一轮里的目标压成一行可读的说明（`page.update home` × 2 → "page.update home（2 次）"） */
function describeTargets(records: readonly JournalRecordView[]): string {
  const counts = new Map<string, number>()
  for (const r of records) {
    const label = `${r.tool || r.domain} ${r.target}`.trim()
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${label}（${n} 次）` : label)).join('、')
}

/**
 * 本回合的工具活动：**一行摘要 + 按需展开**。
 *
 * 起因（用户原话）："当前回答完后，所有工具的使用都会堆积在下面，感觉不好"。
 * 改前是每个调用一行 `<li>` 平铺在回答下方——一轮里查两次知识库、搜一次网络、改一次页面，
 * 底部就堆四五条。它们是**过程信息**，而回答结束后用户要看的是结论。
 *
 * 三条行为约束：
 *   ① **流式期间照旧铺开**：那时这堆活动就是"它在干活"的进度指示器，收起来反而让人以为卡住了；
 *   ② **一轮结束（`streaming` 落回 false）就收起**，并把"手动展开"一起复位——
 *      否则用户上一轮展开过一次，之后每一轮都铺开，堆积又回来了；
 *   ③ 展开/收起是**受控**的（不用 `<details>` 的自动行为）：`aria-expanded` 必须与实际渲染一致，
 *      而 `<details>` 的原生开合与 React 状态会在"流式结束后自动收起"这一步上打架。
 */
function ToolRun({
  activities,
  streaming,
}: {
  activities: readonly ToolActivityView[]
  streaming: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (streaming) setExpanded(false)
  }, [streaming])
  if (activities.length === 0) return null
  const showList = expanded || streaming
  const failed = activities.filter((a) => a.ok === false).length
  return (
    <div className="gw-dock-tools">
      <button
        type="button"
        className={`gw-dock-tools-toggle${failed > 0 ? ' gw-dock-tools-toggle-bad' : ''}`}
        aria-expanded={showList}
        onClick={() => setExpanded(!showList)}
      >
        <span
          className={`gw-dock-tools-chevron${showList ? ' gw-dock-tools-chevron-open' : ''}`}
          aria-hidden="true"
        >
          <ChevronIcon />
        </span>
        {toolRunSummary(activities)}
      </button>
      {showList && (
        <ul className="gw-dock-tools-list">
          {activities.map((a) => (
            <li key={a.id} className={`gw-dock-tool${a.ok === false ? ' gw-dock-tool-bad' : ''}`}>
              <span className="gw-dock-tool-name">{a.name}</span>
              <span className="gw-dock-tool-state">
                {a.ok === null ? '正在执行…' : a.ok ? '完成' : '失败'}
              </span>
              {a.summary !== '' && <span className="gw-dock-tool-summary">{a.summary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 模型的思考过程：**一行摘要 + 按需展开**（默认收起）。
 *
 * 为什么默认收起（用户原话："把模型思考过程放进去，当然要折叠起来"）：
 * 推理型模型的思考常常比答案本身长好几倍，摊开来会把真正的回答挤出屏幕——
 * 那时用户要读的结论在下面，得先滑过一大段草稿。收成一行，需要复盘时再点开。
 *
 * 与上面 `ToolRun` 有意**不同的一点**：工具行在流式期间自动展开（那是在"等结果"，
 * 让用户看见在干什么），思考行**流式期间也保持收起**，只在摘要上标"正在思考…"。
 * 理由是两者体量差着一个数量级：工具的展开是三五行，思考的展开是几千字。
 *
 * 展开状态**由用户自己掌控**（不在流式结束时自动收起）：用户点开就是想看着它想，
 * 读完一半被折叠回去比不展开更烦人。
 */
function ThinkingRun({
  text,
  streaming,
}: {
  text: string
  streaming: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (text === '') return null
  // 字符数按**原始长度**报（不做词数估算）：它只用来说明"这段有多长"，不参与任何判定
  const label = streaming ? `正在思考…（${text.length} 字）` : `思考过程（${text.length} 字）`
  return (
    <div className="gw-dock-think">
      <button
        type="button"
        className="gw-dock-think-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={`gw-dock-tools-chevron${expanded ? ' gw-dock-tools-chevron-open' : ''}`}
          aria-hidden="true"
        >
          <ChevronIcon />
        </span>
        {label}
      </button>
      {expanded && (
        // 纯文本（与流式正文同一个 `Body`）：思考里全是 markdown 符号和缩进，
        // 按 markdown 渲染会把"它只是在列提纲"错读成排版好的回答。
        <div className="gw-dock-think-body">
          <Body text={text} rich={false} />
        </div>
      )}
    </div>
  )
}

function renderThread(state: DockState): ReactNode {
  const nodes: ReactNode[] = []
  /*
   * 活动列表里已经有的工具调用，不再单独留一行"工具 X 已返回"。
   *
   * 这里原先是**无条件**推那一行，而上面那句注释（"只在没有活动记录时留一行痕迹"）
   * 从写下起就没有兑现过 —— 于是每一次工具调用都显示两遍：
   * 对话流里一条灰字「工具 list_pages 已返回」，下面活动列表里再来一条
   * 「list_pages 完成」。用户对这块界面的原话是"很多消息之间的空白区域很大，
   * 看上去非常低效"，重复行正是其中一部分。
   *
   * 保留的语义：活动列表只覆盖**最后一轮**（`status` 帧会重置它），
   * 所以先前那些轮次的工具痕迹仍以灰字留在对话流里 —— 位置信息不丢。
   */
  const activityIds = new Set(state.activities.map((a) => a.id))
  state.messages.forEach((m, i) => {
    if (m.role === 'user') {
      nodes.push(
        <div className="gw-dock-msg gw-dock-msg-user" key={`u${i}`}>
          {m.content}
        </div>,
      )
      return
    }
    if (m.role === 'assistant') {
      if (m.content.trim() !== '') {
        nodes.push(
          <div className="gw-dock-msg gw-dock-msg-ai" key={`a${i}`}>
            {/*
              需求 ⑥ 的标注：这一条回答**没有知识库依据**。按账目分流：
              有网络依据的走另一条（它确实有出处，只是不在本知识库里），
              两档都没有才是「来自模型自身的知识」。
              它渲染在**正文之前**——放在底下等于让用户先读完再发现没有出处，
              而这条标注的全部意义就是"读之前先知道该用什么标准读它"。
            */}
            {state.webGrounded.includes(i) ? (
              <WebGroundedNotice />
            ) : (
              state.notGrounded.includes(i) && <UngroundedNotice />
            )}
            {/* 历史里的回答是已经收完的，可以直接走 markdown */}
            <Body text={m.content} rich />
          </div>,
        )
      }
      return
    }
    // tool：活动列表里已经有它就不再单独成段（同一件事显示两遍是纯浪费），否则留一行痕迹
    if (m.toolCallId !== undefined && activityIds.has(m.toolCallId)) return
    nodes.push(
      <div className="gw-dock-msg gw-dock-msg-tool" key={`t${i}`}>
        工具 {m.name ?? '（未命名）'} 已返回
      </div>,
    )
  })
  /*
   * 工具活动**收成一行**（用户原话："回答完后，所有工具的使用都会堆积在下面，感觉不好"）。
   * 具体行为见下面 `ToolRun` 的注释；这里只负责把它挂进对话流。
   */
  if (state.activities.length > 0) {
    nodes.push(<ToolRun activities={state.activities} streaming={state.streaming} key="activities" />)
  }
  /*
   * 思考过程摆在**工具活动之后、正文之前**：它和工具活动一样是"过程"，
   * 而正文是"结果"。顺序上它对应用户实际看到的时序（先想、再查、再答）。
   */
  if (state.thinking !== '') {
    nodes.push(<ThinkingRun text={state.thinking} streaming={state.streaming} key="thinking" />)
  }
  // 正在累积的正文：**纯文本**（半截 markdown 渲染会抖动，见文件头第 3 条）
  if (state.answer !== '' && state.streaming) {
    nodes.push(
      <div className="gw-dock-msg gw-dock-msg-ai" key="streaming">
        <Body text={state.answer} rich={false} />
      </div>,
    )
  }
  return nodes
}

/**
 * 「这不是知识库内容」的显著标注（需求 ⑥ / 决策 4）。
 *
 * 措辞刻意说**"没有引用知识库资料"**而不是"这是错的"：模型完全可能是对的，
 * 我们知道的只是**它这次没有依据**。把"没有出处"说成"不可信"是另一种不诚实，
 * 而用户真正需要的是那个能自己判断的事实。
 *
 * 它同时也说清了**下一步该做什么**（让 AI 去查、或把答案写进知识库）——
 * 一个只报告问题、不给出口的警告会被用户学会忽略。
 */
function UngroundedNotice(): ReactNode {
  return (
    <p className="gw-dock-ungrounded" role="status">
      <span className="gw-dock-ungrounded-tag">这不是知识库内容</span>
      <span className="gw-dock-ungrounded-text">
        本次回答没有引用知识库里的任何资料，来自模型自身的知识，请自行核实。
        可以让它「去查一下知识库」，或把结论补进相关页面。
      </span>
    </p>
  )
}

/**
 * 「依据的是公开网络资料」的显著标注（`groundingSources` 含 `'web'`）。
 *
 * 为什么不复用上面那条：这两句话的**事实不同**，用户该做的事也不同。
 * 上面那条说"模型凭自己的知识答的"，这条说"模型查了网、给了来源"——
 * 把后者说成前者，等于把模型给出的链接说成是它编的（需求 ⑥ 要消灭的正是这一种误读）；
 * 反过来把前者说成后者，则是替一段没有出处的回答背书。
 *
 * 措辞给出**出口**：点开链接自己核实（链接由 `web_search` 的资料与提示词共同保证
 * 会写在正文里）。这一档说明来源**不在本知识库里**，故不能说成"有知识库依据"，
 * 也不能暗示答案错了——查到公开资料是一个被允许、且往往正确的行为。
 */
function WebGroundedNotice(): ReactNode {
  return (
    <p className="gw-dock-webgrounded" role="status">
      <span className="gw-dock-webgrounded-tag">依据的是公开网络资料</span>
      <span className="gw-dock-webgrounded-text">
        本次回答来自公开网络资料，不是本知识库的内容。请点开正文里的来源链接自行核实；
        也可以让它「去查一下知识库」，或把结论补进相关页面。
      </span>
    </p>
  )
}

/* ============================== 注册 ============================== */

export function register(host: PluginUiHost): () => void {
  // 特性探测，**不比版本字符串**（老宿主上没有这个函数，退化路径是纯文本而不是抛错）
  markdownRenderer = typeof host.renderMarkdown === 'function' ? host.renderMarkdown.bind(host) : null
  return host.registerSlot('app-dock', AskDock)
}

export default register
