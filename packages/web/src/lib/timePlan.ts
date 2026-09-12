/**
 * timePlan —— 「多久以前」的**纯函数**（无 DOM、无 React、无网络）。
 *
 * 为什么单独一个模块：版本时间线要显示相对时间（"3 分钟前"），而绝对时间仍要能拿到
 * （悬停/`title` 里给完整时间戳）。把两者都收在这里，页面只负责排版。
 *
 * ★ 为什么用 `Intl.RelativeTimeFormat` 而不是手写"x 秒前"：
 *   手写版本要自己处理"刚刚 / 1 分钟前 / 昨天 / 上周"这些**语言相关**的边界，
 *   而它恰好是浏览器已经实现好、且跟随系统语言的部分。这里只决定**选哪个单位**。
 *
 * ★ 为什么不做"昨天/前天"这类日历日判断：
 *   那需要时区与"今天几点算一天"的约定，而本仓库的全部时间戳都是 **UTC ISO 串**
 *   （服务端 `new Date().toISOString()`）。用固定时长阈值（<45 秒 / <45 分钟 / <22 小时…）
 *   是**与语言和时区无关**的近似，不会在跨时区时突然说错话。文案上也不写"昨天"
 *   这种会因时区而错的词，而写"1 天前"。
 */

/** 相对时间的阈值表：单位与"从多少秒起改用这个单位"。取的是各单位的常见口语拐点。 */
/*
 * 单位表：**从大到小**，取第一个"够得着"的档。
 *
 * ★ 刻意**没有 `second` 档**：`< JUST_NOW_SECONDS` 已被「刚刚」接管，于是 45–59 秒这一段
 *   必须是「1分钟前」—— 留着秒档会让它输出「45秒钟前」，那不是中文（实测踩过）。
 *   换句话说，"永远不显示秒级相对时间"是**这张表**保证的，不是靠窗口常量碰巧成立的。
 */
const UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: 'year', seconds: 365 * 24 * 3600 },
  { unit: 'month', seconds: 30 * 24 * 3600 },
  { unit: 'day', seconds: 24 * 3600 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
]

/**
 * 「刚刚」的窗口（秒）：小于它一律说「刚刚」。
 *
 * 为什么是 60 而不是 45：单位表里没有秒档，45–59 秒会落进分钟档并被 `floor` 成「0分钟前」，
 * 而"0分钟前"是句废话、"1分钟前"又对 46 秒这个量级明显夸大。所以这一段的正确说法就是
 * 「刚刚」—— 于是窗口直接取 60，与"1 分钟"的边界重合，不留缝。
 *
 * 名字刻意叫 MAX：用 `<` 比较时"45 秒算不算"这种边界问题，靠名字就能读对。
 */
export const MAX_JUST_NOW_SECONDS = 60

/**
 * 「昨天」的上界（秒）。
 *
 * ★ 这是**时长**档，不是日历日：真正判断"昨天"要引入时区与"几点算一天"的约定，
 *   而本仓库的时间戳全是 UTC ISO 串。用 24–48 小时这个窗口是**与语言和时区无关**的近似，
 *   代价是"今天凌晨 1 点改的、现在下午 3 点"会被说成"1天前"而不是"昨天"。
 *   这个取舍是刻意的：宁可少一点口语感，也不要因时区而说错话。
 */
export const YESTERDAY_SECONDS = 48 * 3600

let cached: Intl.RelativeTimeFormat | null = null

function rtf(): Intl.RelativeTimeFormat {
  /*
   * 构造器不便宜（要加载语言数据），模块级缓存一次。
   *
   * ★ 用 `numeric: 'always'` 而**不是** `'auto'`：实测 `'auto'` 会把 2 天前说成「前天」、
   *   400 天前说成「去年」——读起来自然，但**对手头这个用途丢了精度**。
   *   版本记录要回答"什么时候改的"，"前天"不如"2天前"准；而"去年"更是把 400 天
   *   和 300 天混成同一句话。`'always'` 给「2天前」「1年前」，既自然又能排序比较。
   *   注意「刚刚」与「昨天」不依赖这个开关 —— 那两档是本模块自己判的
   *   （< 60 秒 / 24–48 小时），因为它们要的是**时长语义**而不是"第几天"。
   */
  if (cached === null) cached = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'always' })
  return cached
}

/**
 * 相对时间（纯函数，`now` 必须由调用方传入 —— 这样单测不依赖真实时钟）。
 *
 * - 无法解析的时间串 ⇒ 原样返回（**不猜**：宁可显示原始串，也不显示一个编出来的时间）
 * - 未来时间（时钟漂移/服务端时间略快）⇒ 返回「刚刚」，不显示"in 3 minutes"这种怪话
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso)
  const ms = t.getTime()
  if (!Number.isFinite(ms)) return iso
  const diffSeconds = Math.round((now.getTime() - ms) / 1000)
  if (diffSeconds < MAX_JUST_NOW_SECONDS) return '刚刚'
  // 24–48 小时这一档说「昨天」：这是唯一用了"天"这个词的口语档，其余天数一律给"N天前"
  if (diffSeconds >= 24 * 3600 && diffSeconds < YESTERDAY_SECONDS) return '昨天'
  for (const { unit, seconds } of UNITS) {
    if (diffSeconds < seconds) continue
    /*
     * 向下取整 + 下限 1，两个都在防"读数越档"：
     * - `floor`（而不是 `round`）：59 分 59 秒必须说「59分钟前」，`round` 会给出
     *   「60分钟前」—— 那既不是 60 分钟档该有的说法，也和"1小时前"自相矛盾。
     *   同理 23 小时 59 分不能读成「24小时前」。
     * - `max(1, …)`：45–59 秒落进分钟档时 `floor(46/60) === 0`，会给「0分钟前」。
     */
    const amount = Math.max(1, Math.floor(diffSeconds / seconds))
    // 负数 = 过去（Intl 的口径：-3 + 'day' ⇒ "3 天前"）
    return rtf().format(-amount, unit)
  }
  return '刚刚'
}

/** 绝对时间：与仓库既有写法一致（`zh-CN` + 24 小时制），供 `title` 悬停显示。 */
export function absoluteTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
