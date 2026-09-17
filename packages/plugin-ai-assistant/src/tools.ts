/**
 * 工具表的**收窄**——本插件唯一一处决定"这一轮模型能看到哪些工具"的地方。
 *
 * ## 红线：客户端上报的能力只能收窄，绝不能扩权
 * `clientTools` 来自浏览器，是**外部输入**。设计文档 §3.3 把它写成三者交集：
 *
 * ```
 * 服务端已有声明 ∩ 该 owner 插件当前激活 ∩ 模型确实请求了这个名字
 * ```
 *
 * - **「服务端已有声明」**由 `AiToolRegistry.list(principal)` 保证：不在注册表里的名字，
 *   客户端声明一万次也不会出现在结果里；
 * - **「该 owner 插件当前激活」**由管理器的卸载出口保证：卸载时按 owner 调
 *   `release(owner)`，所以 `list()` 里不可能留下已卸载插件的工具；
 * - **「模型确实请求了这个名字」**在 `loop.ts` 里执行前再查一次表——模型会臆造名字。
 *
 * 这与 `packages/web/src/lib/pluginUi.ts` 的宿主包装**拒绝注册未生效插槽**是同一条规则
 * （宿主只认"声明 × 仲裁生效集"）。两条规则存在的理由也一样：一个只靠"调用方守规矩"
 * 的契约，会在某次重构里被一个善意的默认值悄悄放宽。
 *
 * ## 为什么服务端工具不需要客户端声明
 * 它们在**服务端**执行，客户端声明与否都不改变"谁执行"这件事。要求客户端把它们也报一遍
 * 只会制造一个**必须与真源保持同步的第二份清单**——而两份清单必然漂移，
 * 漂移的表现是"某个工具突然不再出现在工具表里，没有任何报错"。
 */
import type { Principal } from '@geewiki/core'
import type { AiToolService, ResolvedTool } from '@geewiki/ai-tools'

/** 收窄后的工具表 */
export interface ToolTable {
  /** **这一轮真正交给模型的那一份**（已按主体过滤、已按确定性顺序排好） */
  readonly offered: readonly ResolvedTool[]
  /** 工具名（含顺序）。帧里的 `status.tools` 直接用它——顺序稳定才能进前缀缓存 */
  readonly names: readonly string[]
  /**
   * 客户端声明里**被采纳**的那些（即：确实注册了、且 side 为 `client`、且主体可用）。
   *
   * 单独回给客户端是为了让"我声明了但没生效"这件事**可见**：
   * 静默丢弃会让插件作者以为自己接上了，直到某天发现模型从来不调它。
   */
  readonly clientToolsAccepted: readonly string[]
}

/**
 * 按主体取工具表，再按"客户端声明的可执行集"收窄。
 *
 * `tools` 为 `undefined`（`@geewiki/ai-tools` 未激活）时返回**空表**而不是抛错：
 * 没有工具总线时，会话核心退化成一个普通的聊天助手——这仍然是可用形态，
 * 而抛错会让整个端点 503。这个取舍与 `@geewiki/ai-kb` 不同（它缺服务时**必须**抛错，
 * 因为它存在的唯一理由就是提供工具），差别在于"没有它还能不能干活"。
 */
export function resolveTurnTools(
  tools: AiToolService | undefined,
  principal: Principal,
  declaredClientTools: readonly string[],
): ToolTable {
  if (!tools) return { offered: [], names: [], clientToolsAccepted: [] }

  const all = tools.list(principal)
  const declared = new Set(declaredClientTools)

  const offered: ResolvedTool[] = []
  const accepted: string[] = []
  for (const tool of all) {
    if (tool.descriptor.side === 'server') {
      offered.push(tool)
      continue
    }
    // 客户端工具：**没被声明就不进表**（模型不会去调一个没人能执行的工具）
    if (declared.has(tool.descriptor.name)) {
      offered.push(tool)
      accepted.push(tool.descriptor.name)
    }
  }

  return { offered, names: offered.map((t) => t.descriptor.name), clientToolsAccepted: accepted }
}
