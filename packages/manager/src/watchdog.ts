/**
 * 看门狗决策的纯函数实现（与 IO/定时器解耦，便于单元测试）。
 *
 * 归因语义（修复前：全局 consecutiveFailures 无差别归因到会话插件，
 * base 插件一次 500 即可误伤试用期内的会话插件）：
 * - 试用期回滚：仅绑定"最近一次会话层激活"的插件（lastEnabled）——
 *   在该插件激活后的 gracePeriodMs 窗口内出现任何 5xx，即判定为其引发并回滚；
 *   窗口外或无会话激活时不回滚。
 * - 熔断：仅在会话层存在变更（清单非空）时，连续失败达阈值才清空会话退出；
 *   纯基础层故障不触发熔断（重启无益，属宿主应报告的持久故障）。
 */
export type WatchdogDecision =
  | { action: 'none' }
  | { action: 'rollback'; name: string }
  | { action: 'meltdown' }

export interface WatchdogInput {
  /** 路由层全局连续失败计数（≥500 响应） */
  consecutiveFailures: number
  /** 熔断连续失败阈值（默认 3） */
  meltdownThreshold: number
  /** 会话插件试用期（毫秒，默认 5000） */
  gracePeriodMs: number
  /** 决策时刻（epoch ms） */
  now: number
  /** 最近一次会话层激活的插件名；无则 null */
  lastEnabledName: string | null
  /** 最近一次会话层激活时刻；无则 null */
  lastEnabledAt: number | null
  /** 该插件当前仍处于活动状态 */
  lastEnabledActive: boolean
  /** 会话层存在变更（清单 enabled 非空） */
  sessionNonEmpty: boolean
}

/** 单次看门狗决策：none / rollback（最近会话插件试用期回滚）/ meltdown（清会话退出） */
export function decideWatchdog(input: WatchdogInput): WatchdogDecision {
  const { lastEnabledName, lastEnabledActive, lastEnabledAt, now, gracePeriodMs } = input
  const inGrace =
    lastEnabledName !== null &&
    lastEnabledActive &&
    lastEnabledAt !== null &&
    now - lastEnabledAt <= gracePeriodMs
  // 试用期回滚优先：失败发生在最近会话插件激活后的窗口内 → 归因于它。
  // 附加约束：会话层必须存在内容（persist 提升/清空后不再有"待试用"会话插件，故障归因失效）
  if (
    input.consecutiveFailures > 0 &&
    input.sessionNonEmpty &&
    inGrace &&
    lastEnabledName !== null
  ) {
    return { action: 'rollback', name: lastEnabledName }
  }
  // 熔断：仅当会话层存在变更且连续失败达阈值（会话内容物被判定有害 → 清空自愈）
  if (input.consecutiveFailures >= input.meltdownThreshold && input.sessionNonEmpty) {
    return { action: 'meltdown' }
  }
  return { action: 'none' }
}
