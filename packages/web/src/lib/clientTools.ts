/**
 * 客户端工具注册表 —— **宿主侧**的"哪些工具能在浏览器里跑"。
 *
 * ## 为什么必须有这张表（而不是让插件自己执行自己的工具）
 * 设计文档 §3.3 的安全红线：**客户端上报的「可调用集」只能收窄，绝不能扩权**。
 *
 * 无状态轮次协议里，客户端要告诉服务端"我这边有哪些工具"，而那份名单**必须来自宿主登记**。
 * 若由插件自己拼这个名字列表，一个插件就能声明 `admin.disable_plugin` 并让模型去调它——
 * 服务端只做"名字在不在交集里"的检查，而那个交集的第一项就成了攻击者可控的输入。
 *
 * 因此这里有两条硬规则，与 `pluginUi.ts` 的宿主包装拒绝注册未生效插槽是**同一条规则**：
 * 1. **只有经本表登记的名字才可调用**（`invokeClientTool` 对未登记的名字拒绝）；
 * 2. **名字全局唯一，重复即抛错**（不得静默覆盖——照 `LlmRouteDescriptor` 的先例）。
 *
 * ## 与 `AiToolRegistry`（`packages/plugin-ai-tools`）的分工
 * 两者同形但**不同层**，不合并：
 * - 服务端那张表在 node 里，描述符（name/description/parameters）进模型的工具表；
 * - 这张表在浏览器里，只有**处理器**——描述符必须由插件在**服务端**声明
 *   （`side: 'client'` 的贡献），否则模型看不到它、也就不会请求它。
 *
 * 换句话说：**服务端说"这个工具存在"，浏览器说"这个工具在我这儿怎么跑"**。
 * 两边的名字必须对上，但任何一边都不得单独定义"它存在"。
 *
 * ## P2 阶段这张表是空的
 * 首批客户端工具（`editor.*`）要等 P3 的编辑器句柄一起做。现在就把表建起来，
 * 是为了让 {@link AppDockSlotProps.invokeTool} 从第一天起就有真实语义
 * （对未登记名字**拒绝**），而不是先返回一个"以后再实现"的空 Promise——
 * 后者会让 P3 接入时无法区分"工具没登记"与"登记了但没实现"。
 */

/**
 * 客户端工具处理器。
 *
 * `args` 是 `unknown`：它来自**模型**（经服务端 SSE 回灌），也就是外部输入。
 * 每个处理器第一件事必须是校验，而不是相信类型。
 */
export type ClientToolHandler = (args: unknown) => Promise<unknown> | unknown

export interface ClientToolEntry {
  /** 扁平、稳定的工具名（与服务端 `ai-tool-service` 里 `side: 'client'` 的声明同名） */
  readonly name: string
  /** 登记方（插件名或 `'host'`），卸载时按它回收 */
  readonly source: string
  readonly execute: ClientToolHandler
}

const registry = new Map<string, ClientToolEntry>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** 订阅登记变化（React 侧用 `useSyncExternalStore`） */
export function subscribeClientTools(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 登记的客户端工具名（**已排序**）。
 *
 * 排序是必需的，不是美观问题：这份名单会经轮次协议上送服务端、参与构成发给模型的工具表。
 * 顺序不稳 ⇒ 每轮请求前缀都变 ⇒ 上游前缀缓存全失效（设计文档 §0.4 的同一条理由，
 * 那边管的是服务端工具表，这边管的是它的客户端子集）。
 */
export function clientToolNames(): readonly string[] {
  return [...registry.keys()].sort()
}

/** 引用稳定的快照（`useSyncExternalStore` 的 getSnapshot 必须是纯函数且引用稳定） */
let namesSnapshot: readonly string[] = Object.freeze([])
let namesDirty = true
function refreshSnapshot(): void {
  if (!namesDirty) return
  namesSnapshot = Object.freeze(clientToolNames())
  namesDirty = false
}

/** 订阅 + 快照的一体入口；`getSnapshot` 走缓存，避免每次渲染都返回新数组导致死循环 */
export function clientToolNamesSnapshot(): readonly string[] {
  refreshSnapshot()
  return namesSnapshot
}

/**
 * 登记一个客户端工具，返回**幂等**的注销函数。
 *
 * 重复名字**抛错**。为什么不像插槽那样"忽略并告警"：插槽允许同名多方（多占用插槽本就是
 * 叠加语义），而工具名是模型调用时的**唯一凭据**——两个处理器共用一个名字时，
 * "模型想调的那个"没有确定答案。
 */
export function registerClientTool(
  name: string,
  execute: ClientToolHandler,
  source = 'host',
): () => void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('[geewiki-client-tools] registerTool 的名字必须是非空字符串')
  }
  if (typeof execute !== 'function') {
    throw new Error(`[geewiki-client-tools] registerTool(${name}) 缺少处理器函数`)
  }
  const existing = registry.get(name)
  if (existing) {
    throw new Error(
      `[geewiki-client-tools] 客户端工具名 ${name} 已被 ${existing.source} 登记，${source} 不得重复登记` +
        '（名字是模型调用的唯一凭据，静默覆盖会让"模型想调的那个"没有确定答案）',
    )
  }
  registry.set(name, { name, source, execute })
  namesDirty = true
  emit()

  let done = false
  return () => {
    if (done) return
    done = true
    // 只删"还是我这条"：若已被 unregisterClientTools 清掉又被别人重新登记同一名字，
    // 迟到的 disposer 不该把新主人的工具删掉。
    const now = registry.get(name)
    if (now && now.source === source && now.execute === execute) {
      registry.delete(name)
      namesDirty = true
      emit()
    }
  }
}

/** 注销某登记方的全部客户端工具（插件卸载/重载时的统一出口） */
export function unregisterClientTools(source: string): void {
  let changed = false
  for (const [name, entry] of [...registry]) {
    if (entry.source === source) {
      registry.delete(name)
      changed = true
    }
  }
  if (changed) {
    namesDirty = true
    emit()
  }
}

/**
 * 执行一个**已登记**的客户端工具。
 *
 * 未登记的名字**拒绝**（抛错），而不是返回 `undefined`：
 * 调用方是服务端回灌来的模型请求，"这个名字不存在"与"它跑完没结果"必须可区分——
 * 前者说明客户端上送的可调用集与服务端认为的不一致（那是个真 bug），
 * 后者只是一个正常的返回值。
 */
export async function invokeClientTool(name: string, args: unknown): Promise<unknown> {
  const entry = registry.get(name)
  if (!entry) {
    throw new Error(
      `[geewiki-client-tools] 客户端工具 ${name} 未登记，拒绝调用（已登记：${clientToolNames().join(', ') || '（无）'}）`,
    )
  }
  return await entry.execute(args)
}

/** 只读诊断（测试与管理台用） */
export function clientToolSummary(): readonly { name: string; source: string }[] {
  return [...registry.values()]
    .map((e) => ({ name: e.name, source: e.source }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
