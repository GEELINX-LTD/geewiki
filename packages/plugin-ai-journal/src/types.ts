/**
 * `@geewiki/ai-journal` 的类型契约与**纯函数核心**。
 *
 * ## 这个子系统为什么必须新建（决策 3 + 10 + 11 + 14）
 * 「AI 的写操作能一键回退到某一轮之前」听上去是个 UI 需求，实际是**存储与事务**问题。
 * 设计文档 §4.1 逐域查过：四个域各自的"历史"机制都不是工具调用粒度——
 * 编辑框草稿**完全没有历史**（浏览器内存）、页面版本是**保存**粒度、插件配置**没有历史**、
 * 插件启停只有"失败回滚"。所以没有任何一处能借力，只能自建。
 *
 * ## 为什么核心是纯函数
 * 回退是**破坏性**操作，而它出错的方式很安静：少撤一条（AI 说改了其实没改）、
 * 多撤一条（把别人的编辑一起覆盖）。这两件事都不报错，只是数据不对了。
 * 因此"该撤哪些、顺序如何、哪一条有冲突"必须住在**不碰 IO 的纯函数**里，
 * 由单测逐条钉死；插件那一层只负责把它接到数据库与 HTTP 上。
 *
 * ## 冲突：拒绝那一条，而不是拒绝整次回退（设计文档 §4.3）
 * 文档原话：「不一致 ⇒ **拒绝该条回退并说明原因**，不静默跳过、不强制覆盖」。
 * 于是 `planRollback` 的产物里**同时**有 `steps`（能撤的）与 `conflicts`（撤不了的），
 * 而调用方必须把两者**都**呈现出来——只报"回退成功"而把冲突咽下去，
 * 正是"静默跳过"的另一种写法。
 */

import type { Principal } from '@geewiki/core'

/** 服务名（`ctx.get('ai-journal-service')` 用它查找） */
export const AI_JOURNAL_SERVICE_NAME = 'ai-journal-service'

/**
 * 一条变更的记录入参。
 *
 * `before` / `after` 是**文本快照**而不是结构化 diff：逆操作要的是"把它变回去"，
 * 而各域的"变回去"形态完全不同（页面是整篇正文、编辑器是整段草稿、插件启停是一个布尔）。
 * 用文本快照把它们统一起来，代价是存储更大，换来的是**这个子系统不需要理解任何业务域**。
 */
export interface MutationInput {
  /** 决策 9 的本地会话 id（服务端只存 id，不存对话内容） */
  readonly conversationId: string
  /** ★ 决策 10 的回退粒度就是它：**一次用户提问**，而不是一次 HTTP 回合 */
  readonly turnId: string
  /** 哪个插件做的 */
  readonly owner: string
  /** 工具名 */
  readonly tool: string
  /**
   * 域。服务器据此挑撤销执行体：
   * - 有注册执行体的域（如 `page`）由服务端**直接执行**撤销；
   * - 没有的域（如 `editor`，草稿在浏览器里）作为**客户端步骤**返回给调用方执行。
   */
  readonly domain: string
  /** 目标标识（页面 slug / 编辑器 docId / 插件名） */
  readonly target: string
  /** 变更前的内容；`null` = 此前不存在（撤销就是删除） */
  readonly before: string | null
  /** 变更后的内容；`null` = 变更后不存在。**冲突检测拿它与当前值比对** */
  readonly after: string | null
}

export interface MutationRecord extends MutationInput {
  readonly id: number
  readonly at: string
  /** 已撤销的时刻；`null` = 未撤销。已撤销的记录**不参与**再次回退 */
  readonly undoneAt: string | null
}

/** 撤销执行体的结果 */
export interface UndoOutcome {
  readonly ok: boolean
  /** 给人看的一句话（成功时说明做了什么，失败时说明为什么） */
  readonly detail: string
}

/**
 * 服务端撤销执行体。**按域注册**，由 `@geewiki/ai-journal` 保存。
 *
 * 为什么是"按域注册"而不是"journal 自己认识每种域"：journal 一旦认识业务域，
 * 它就变成了第二个 wiki / 第二个管理器，而**两份判据必然漂移**——
 * 本仓已经为这条付过代价（`packages/plugin-wiki/src/index.ts` 记的
 * "正文里看不到、附件却能下载"）。
 *
 * ★ **`principal` 是必填的第二个参数，不是可选的**：回退**本身是一次写操作**，
 * 而"谁在回退"决定了他能不能改这一页。本仓的定式是"把主体做成可选参数，
 * 任何忘了传的调用点都会静默退化成不过滤"（`plugin-wiki/src/index.ts` 的 P2 注释），
 * 所以这里让它在**编译期**就炸：撤销执行体拿不到主体就没法写。
 *
 * 反过来说也重要：**能回退的前提是"他现在有写权限"**，而不是"他曾经有"。
 * 一个被吊权的用户点回退，应当失败——那不是 bug，是权限在起作用。
 */
export type UndoHandler = (record: MutationRecord, principal: Principal) => Promise<UndoOutcome>

/** 探针的答复：要么给值，要么给一个"我说不出"的原因 */
export interface ProbeOutcome {
  /** 当前值（`null` = 目标确实不存在了，与 `undefined` 是两回事） */
  readonly value?: string | null
  /** `value` 缺席时给人的原因。缺省时上层用通用文案 */
  readonly reason?: string
}

/**
 * 某个域的"**现在实际是什么**"探针。**按域注册**，与 {@link UndoHandler} 同一套归属规则。
 *
 * 为什么需要它、以及为什么不能由浏览器自报：冲突检测的输入是"目标此刻的值"，
 * 而**只有域的所有者知道该去哪儿读它、以及读不到时意味着什么**。
 * 页面的当前值要用**能拿到原文的那条读路径**（`rawContent`）去读——那条路径自己带权限判据；
 * 若改由客户端先读一遍再上报，就出现了第二条读路径，而两条判据必然漂移
 * （本仓为这条付过代价：`plugin-wiki/src/index.ts` 记的"正文里看不到、附件却能下载"）。
 *
 * 浏览器里的域（编辑框草稿）没有服务端探针，那条路由调用方经
 * `rollbackTo` 的 `snapshots` 自报——**这是例外，不是默认**。
 */
export type MutationProbe = (record: MutationRecord, principal: Principal) => Promise<ProbeOutcome>

/** 一次回退里发给客户端的步骤（域没有服务端执行体时） */
export interface ClientUndoStep {
  readonly record: MutationRecord
  /** 该域当时的"变更后"值——客户端据此做与 `after` 的一致性判断 */
  readonly expected: string | null
}

/** 一条被拒绝的回退 */
export interface RollbackConflict {
  readonly record: MutationRecord
  /** 记录里写的"AI 改完之后"的值 */
  readonly expected: string | null
  /** 调用方报上来的"现在实际是"的值。`undefined` = 调用方没提供该目标的当前值 */
  readonly actual: string | null | undefined
  /** 拒绝原因（给人看） */
  readonly reason: string
}

export interface RollbackPlan {
  /** 能撤的记录，**已是撤销顺序**（倒序：后做的先撤） */
  readonly steps: readonly MutationRecord[]
  /** 撤不了的记录与原因。调用方**必须**把它呈现出来 */
  readonly conflicts: readonly RollbackConflict[]
  /** 已经被撤销过的记录（幂等：重复回退同一轮不应重复执行逆操作） */
  readonly alreadyUndone: readonly MutationRecord[]
}

/**
 * 把一批记录按 `turnId` 分组后的形状（回退 UI 的输入）。
 *
 * 用户看到的是"第几轮 AI 动过什么"，而不是一串扁平记录——扁平列表给不出
 * "回退到这一轮之前"这个动作的落点。分组逻辑在 `plan.ts` 的 `groupByTurn`。
 */
export interface TurnGroup {
  readonly turnId: string
  readonly conversationId: string
  readonly records: readonly MutationRecord[]
  /** 该轮里**还没撤销**的条数；0 = 这一轮已经撤干净了（UI 应据此禁用按钮） */
  readonly pending: number
  /** 该轮最早一条的时间（用来排序：一轮里的记录时间几乎相同，取最早最稳） */
  readonly at: string
  /** 该轮**最早**一条记录的 id。仅用于排序决胜：毫秒时间戳会打平，id 不会 */
  readonly seq: number
  /** 该轮涉及的工具名（去重后按首次出现排序） */
  readonly tools: readonly string[]
}

/* ============================== 服务契约 ============================== */

export interface JournalQuery {
  readonly conversationId?: string
  /** 只取某一轮 */
  readonly turnId?: string
  /** 只取未撤销的 */
  readonly pendingOnly?: boolean
  readonly limit?: number
}

/** 回退执行报告（端点回给调用方的东西） */
export interface RollbackReport {
  readonly conversationId: string
  readonly turnId: string
  /** 服务端**已执行**的撤销 */
  readonly undone: readonly { readonly record: MutationRecord; readonly detail: string }[]
  /** 服务端执行失败的（**不是**冲突：冲突根本没执行） */
  readonly failed: readonly { readonly record: MutationRecord; readonly detail: string }[]
  /** 需要**客户端**执行的撤销步骤（域没有服务端执行体，如浏览器里的草稿） */
  readonly clientSteps: readonly ClientUndoStep[]
  readonly conflicts: readonly RollbackConflict[]
  readonly alreadyUndone: readonly MutationRecord[]
}

export interface AiJournalService {
  /** 记一条变更，返回记录 id。**只记不改**——它不执行任何业务动作 */
  record(input: MutationInput): Promise<number>
  list(query?: JournalQuery): Promise<readonly MutationRecord[]>
  /** 按轮分组的投影（回退 UI 的输入） */
  turns(conversationId: string): Promise<readonly TurnGroup[]>
  /**
   * 注册某个域的服务端撤销执行体（重复注册同一域**抛错**，不静默覆盖）。
   *
   * `owner` 由调用方交出自己的 `manifest.name`（**不是**由本服务猜）——照
   * `SlotService.contribute(owner, …)` 的先例：卸载时要按 owner 回收注册，
   * 而一个插件拿不到另一个插件的名字，猜错的表现是"泄漏的注册没人回收"。
   */
  registerUndoer(owner: string, domain: string, handler: UndoHandler): () => void
  /**
   * 注册某个域的**当前值探针**（重复注册同一域**抛错**）。
   *
   * 与 `registerUndoer` 分开两件事：**"它现在是什么"与"怎么改回去"是两个知识**。
   * 合起来会逼着想只提供其中一个的域提供另一个（页面两者都有，草稿只有后者）。
   */
  registerProbe(owner: string, domain: string, probe: MutationProbe): () => void
  /**
   * 回退到某一轮**之前**。
   *
   * `currentOf` 由调用方给：只有它知道去哪儿读"现在实际是什么"
   * （页面要问 wiki-service、草稿在浏览器里）。journal 自己去读会变成第二份权限判据。
   */
  rollbackTo(
    principal: Principal,
    conversationId: string,
    turnId: string,
    /**
     * 调用方自报的当前值。**只对该域没有服务端探针时才被采用**（探针优先，
     * 见实现里的 `resolveCurrent`）；两者都没有即为"不知道"，按冲突处理。
     * 没有它就完全依赖探针——页面域就是这样：只有服务端知道怎么读原文。
     */
    currentOf?: (record: MutationRecord) => string | null | undefined,
  ): Promise<RollbackReport>
  /** 客户端执行完 `clientSteps` 后回报（把那些记录标成已撤销） */
  markUndone(ids: readonly number[], detail: string): Promise<number>
}
