/**
 * `@geewiki/ai-journal` 的**纯函数核心**：撤销规划、冲突检测、轮次分组、自锁护栏。
 *
 * 这个文件里没有一行 IO，这是刻意的：回退是**破坏性**操作，而它出错的方式很安静——
 * 少撤一条（AI 说改了其实没改）、多撤一条（把别人的编辑一起覆盖）。两者都不报错，
 * 只是数据不对了。所以"该撤哪些、顺序如何、哪一条有冲突"必须住在能被单测逐条钉死的
 * 纯函数里，插件那一层只负责把它接到数据库与 HTTP 上。
 */
import type { MutationRecord, RollbackConflict, RollbackPlan, TurnGroup } from './types.js'

/* ============================== 自锁护栏（决策 13） ============================== */

/**
 * AI **绝不能**停掉它自己依赖链上的节点。
 *
 * 为什么这条必须是硬编码的常量而不是配置项：它保护的是"AI 还有没有下一次机会"。
 * 一条 `disable_plugin('@geewiki/llm')` 执行成功的后果是**助手从此不能说话**，
 * 用户也没法再命令它把 llm 开回来——**这不是"做错了一件事"，是失去了纠错能力**。
 * 一个可以关掉的护栏等于没有护栏。
 */
export const PROTECTED_AI_NODES: readonly string[] = [
  '@geewiki/ai-assistant',
  '@geewiki/ai-tools',
  '@geewiki/llm',
  '@geewiki/ai-journal',
  /*
   * ★ `@geewiki/ai-admin` 是 **P5 补的第五个**（设计文档 §4.4 当时只列了四个）。
   *
   * 它不在助手的**依赖链**上（是兄弟贡献者），按字面读那句"自身依赖链"它确实不必在里面。
   * 但这份常量的判据从来不是"依赖链"这个机制，而是它上面那句：
   * **「保护的是 AI 还有没有下一次机会」**。停掉 `ai-admin` 之后助手仍然能说话、
   * 仍然能改页面——但它**再也没有能力把任何插件开回来了**，包括刚才被停掉的那个。
   * 用户只能去管理台手动收拾，而"我明明可以让它自己改回来"正是决策 13 要保住的东西。
   *
   * 这是对原文的**有据收窄**（与 `mayReadPluginConfig` 放宽到 owner/admin 同一种修正）：
   * 按依赖链读会漏掉这一类"不依赖它、但没了它就没了纠错能力"的节点。
   */
  '@geewiki/ai-admin',
]

export interface SelfLockViolation {
  readonly node: string
  readonly reason: string
}

/**
 * 判断一次写操作是否踩到自锁红线。
 *
 * **护栏在工具层，不在提示层**（设计文档 §4.4）：提示里写「请不要停用 llm」不算护栏——
 * 模型可以不听，而这条红线的代价是不可逆的。所以它在**执行前**用代码拦。
 *
 * `targets` 由工具自己交出来（`targetsOf(args)`），而不是让护栏去解析各家参数：
 * 参数形状是工具的知识，护栏猜不出来；而工具谎报的后果是它自己被拒绝，不是护栏失效。
 */
export function checkSelfLock(targets: readonly string[]): SelfLockViolation | null {
  for (const node of targets) {
    if (PROTECTED_AI_NODES.includes(node)) {
      return {
        node,
        reason:
          `${node} 是 AI 助手自身依赖链上的节点，停用它会让助手（以及你自己）失去继续工作的能力，` +
          '且用户将无法再命令你把它们恢复——这条红线不可绕过，请改用管理台手动操作',
      }
    }
  }
  return null
}

/* ============================== 撤销规划与冲突检测 ============================== */

/**
 * 规划一次回退：给一组记录与"当前值快照"，算出该撤哪些、按什么顺序、哪些有冲突。
 *
 * ## 三条判据
 * 1. **倒序**：后做的先撤。正序撤会把中间态覆盖成错的终态
 *    （A 改 x→y、B 改 y→z；正序撤 A 会先把 z 写成 x，B 的撤销随后又写 y ⇒ 终态 y，错的）。
 * 2. **冲突即拒绝那一条**：当前值与记录的 `after` 不一致 ⇒ 说明别人动过它。
 *    强行撤销就是**把别人的编辑覆盖掉**，而那正是决策 11 要防的事。
 * 3. **已撤销的不再撤**：`undoneAt !== null` 的记录进 `alreadyUndone`。
 *    没有这一条，点两次「回退」就会把第一次的逆操作**再执行一遍**——
 *    对"把正文设回旧值"这类幂等操作看不出问题，对"删除刚创建的东西"就是灾难。
 */
export function planRollback(
  records: readonly MutationRecord[],
  currentOf: (record: MutationRecord) => string | null | undefined,
  reasonOf?: (record: MutationRecord) => string | undefined,
): RollbackPlan {
  const steps: MutationRecord[] = []
  const conflicts: RollbackConflict[] = []
  const alreadyUndone: MutationRecord[] = []

  // 倒序：`records` 按插入顺序（即发生顺序）给出
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i] as MutationRecord
    if (record.undoneAt !== null) {
      alreadyUndone.push(record)
      continue
    }
    const actual = currentOf(record)
    /*
     * `undefined` = 调用方**没提供**这个目标的当前值（比如客户端只报了它自己那几个目标）。
     * 这种"不知道"必须按**冲突**处理，不能按"一致"处理：
     * 猜"一致"就是拿别人的编辑去赌一次静默覆盖，而猜错的代价不可逆。
     * 这与 `read_page` 那条纪律同源——"不知道"不能被当成"没有"。
     */
    if (actual === undefined) {
      /*
       * `reasonOf` 是给**知道得更多的人**留的口子：域的所有者（如页面）能把
       * "读不到" 拆成"你没有编辑权"、"页面已被删"这类可执行的原因。
       * 没有它时退到下面这条通用文案——通用文案不算错，只是不够可操作，
       * 而"不够可操作"远好过"猜成一致然后静默覆盖"。
       */
      const custom = reasonOf?.(record)
      conflicts.push({
        record,
        expected: record.after,
        actual,
        reason:
          custom ??
          `没有拿到 ${record.domain}:${record.target} 的当前值，无法确认它没被改过——拒绝回退这一条（不会强行覆盖）`,
      })
      continue
    }
    if (actual !== record.after) {
      conflicts.push({
        record,
        expected: record.after,
        actual,
        reason:
          `${record.domain}:${record.target} 在 AI 改完之后又被改动过（记录的是 ${describe(record.after)}，现在是 ${describe(actual)}）` +
          '——回退它会连别人的修改一起覆盖，故拒绝这一条',
      })
      continue
    }
    steps.push(record)
  }

  return { steps, conflicts, alreadyUndone }
}

/** 把值压成一句可读的说明（冲突文案要用，长正文不能整段进消息） */
export function describe(value: string | null | undefined, limit = 40): string {
  if (value === undefined) return '（未提供）'
  if (value === null) return '（不存在）'
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (oneLine === '') return '（空）'
  return oneLine.length <= limit ? `「${oneLine}」` : `「${oneLine.slice(0, limit)}…」（共 ${value.length} 字符）`
}

/**
 * 把一批记录按 `turnId` 分组，保持"最近的一轮在最前"。
 *
 * 回退 UI 要的就是这份形状：用户看到的是"第几轮 AI 动过什么"，
 * 而不是一串扁平记录——扁平列表给不出"回退到这一轮之前"这个动作的落点。
 */
export function groupByTurn(records: readonly MutationRecord[]): readonly TurnGroup[] {
  const groups = new Map<string, MutationRecord[]>()
  for (const record of records) {
    const list = groups.get(record.turnId)
    if (list === undefined) groups.set(record.turnId, [record])
    else list.push(record)
  }
  const out: TurnGroup[] = []
  for (const [turnId, list] of groups) {
    const pending = list.filter((r) => r.undoneAt === null).length
    out.push({
      turnId,
      conversationId: list[0]?.conversationId ?? '',
      records: list,
      pending,
      at: list.reduce((min, r) => (r.at < min ? r.at : min), list[0]?.at ?? ''),
      /**
       * 该轮**最早**一条记录的 id，只用来决胜排序。
       *
       * **为什么不能只用 `at`**：`new Date().toISOString()` 只有毫秒分辨率，
       * 而两轮提问完全可能落在同一毫秒里（测试一次连发三条就复现了）。
       * 打平时排序退化成"插入顺序"，于是**最近的一轮可能排在下面**——
       * 而"回退到最近一轮之前"正是这个列表最主要的用法。
       * id 由 AUTOINCREMENT 保证单调，是这里唯一可靠的先后判据。
       *
       * **必须是"最早"而不是"最大"**：这一列回答的是"这一轮**什么时候开始**的"，
       * 与 `at` 同一个语义。取最大 id 会把它变成"什么时候结束的"，
       * 于是一轮内部跨越了另一轮时（记录交错）排序会给出相反的答案——
       * 第一版就是这么写的，被 `turns` 那条用例抓住。
       */
      seq: list.reduce((min, r) => (r.id < min ? r.id : min), list[0]?.id ?? 0),
      tools: [...new Set(list.map((r) => r.tool))],
    })
  }
  // 最近的一轮在最前：先比 `at`（ISO8601 字典序即时间序），打平则比单调的 `seq`
  return out.sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1))
}
