/**
 * 纯展示格式化（不依赖 DOM / React，可被 node:test 直接单测）。
 *
 * 之所以单独成模块：展示逻辑最容易出现"边界值没考虑"的问题（0 秒、负数、
 * 非有限数、超大值），把它们放在纯函数里用单测钉住，比在组件里靠肉眼检查可靠。
 */

/** 秒 → 人话（"3 天 4 小时" / "12 分钟" / "45 秒"）；非法输入回退"未知" */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '未知'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分钟`
  if (m > 0) return `${m} 分钟`
  return `${s} 秒`
}
