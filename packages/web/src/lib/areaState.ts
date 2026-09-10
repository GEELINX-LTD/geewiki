/**
 * 区域状态判定（纯函数，便于单测）。
 *
 * ## 为什么需要它
 *
 * 一个区域（列表 / 详情 / 侧栏）的「加载中 / 出错 / 空 / 就绪」必须是**互斥**的四选一。
 * 此前 `WikiList` 的卡片头部用 `pages === null` 判断"正在加载"，而**请求失败时 `pages`
 * 同样是 null** ⇒ 同一屏上头部说「正在加载…」、正文说「服务暂时出错」，自相矛盾。
 *
 * 根因不是"忘了判断错误"，而是**用"数据是否存在"去猜状态**。数据不存在有至少两种原因
 * （还在路上 / 已经失败），用同一个值表达两种含义必然产生矛盾。所以状态要由**状态本身**
 * 决定，而不是由数据的形状反推。
 *
 * ## 优先级：错误 > 加载 > 空 > 就绪
 *
 * **有错误就说明白，不要说"正在加载"**。理由：错误是**已确定的事实**，而"正在加载"是
 * 一种**推测**；在已经知道失败的情况下继续宣称"正在加载"，会让用户一直等一个不会来的结果。
 *
 * 「正在重试」**不靠本函数表达**：重试中的反馈由 `ErrorState` 的 `retrying` 属性承担
 * （按钮转圈、不可重复点）。这样错误区域不会因为一次重试就闪回骨架屏，用户也不会丢失
 * "刚刚失败了什么"的上下文。
 *
 * `isEmpty` 只在请求**成功返回之后**才可信——失败时它必然也是"空"，这正是不能用它
 * 反推状态的原因。
 */
export type AreaState = 'error' | 'loading' | 'empty' | 'ready'

export function resolveAreaState(input: {
  /** 是否正在请求（重试也算） */
  loading: boolean
  /** 是否已有错误（非空即视为有错） */
  hasError: boolean
  /** 是否确实没有数据（**仅在请求成功后才可信**） */
  isEmpty: boolean
}): AreaState {
  if (input.hasError) return 'error'
  if (input.loading) return 'loading'
  if (input.isEmpty) return 'empty'
  return 'ready'
}
