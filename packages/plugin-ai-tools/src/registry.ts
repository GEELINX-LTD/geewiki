/**
 * `AiToolService` 的实现：一张 `name → {owner, tool}` 的表。
 *
 * 与 `SlotRegistry`（`packages/manager/src/slots.ts`）同形，但有一处**刻意的差异**：
 * 插槽允许同名多方贡献（多占用插槽本就如此），工具**不允许**——名字是模型调用时的
 * 唯一凭据，两个工具共用一个名字时"模型想调的那个"没有确定答案，故重复即抛错。
 * 因此这里的内部结构是**单层 Map**，而不是插槽那样的 `Map<owner, Map<name, …>>`。
 * 卸载时的"按 owner 回收"退化成一次全表过滤——表很小（数十项），不值得为它加一层索引。
 */
import type { Principal } from '@geewiki/core'
import {
  TOOL_DESCRIPTION_BUDGET,
  type AiToolBudgetEntry,
  type AiToolContribution,
  type AiToolDiagnostics,
  type AiToolService,
  type ResolvedTool,
} from './types.js'

/**
 * 工具名白名单：字母/数字/下划线/点/连字符，且不以数字或符号开头。
 *
 * 校验它不是为了整洁——工具名会原样进上游的 `tools[].function.name`，
 * 带空格或中文的名字会让上游 400，而 400 的报错文本里通常只有"invalid request"，
 * 定位成本极高。宁可在这里用一条明确的错误拦住。
 */
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * 确定性字符串比较：**按 UTF-16 码元序**，不用 `localeCompare`。
 *
 * `localeCompare` 的结果取决于 ICU 的 locale 数据，而这里比的是工具名——
 * 顺序的唯一用途是**让同一次会话里每一轮的工具表字节序一致**，从而命中上游的前缀缓存
 * （设计文档 §0.4：上游是 vLLM，支持前缀缓存）。用 locale 相关的比较，
 * 等于把缓存命中率押在一个可能随环境变化的排序上。
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function assertOwner(owner: string): void {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error('@geewiki/ai-tools: contribute() 的 owner 必须是非空字符串（卸载要按它回收）')
  }
}

function assertContribution(owner: string, tool: AiToolContribution): void {
  const d = tool?.descriptor
  if (!d || typeof d.name !== 'string' || d.name.length === 0) {
    throw new Error(`@geewiki/ai-tools: ${owner} 贡献的工具缺少 name`)
  }
  if (!TOOL_NAME_RE.test(d.name)) {
    throw new Error(
      `@geewiki/ai-tools: ${owner} 的工具名 ${JSON.stringify(d.name)} 非法——` +
        '只允许字母/数字/下划线/点/连字符且不以数字或符号开头（它要原样进上游的 tools[].function.name）',
    )
  }
  if (typeof d.description !== 'string' || d.description.length === 0) {
    throw new Error(`@geewiki/ai-tools: 工具 ${d.name} 缺少 description（模型靠它判断何时调用）`)
  }
  /*
   * `parameters.type` 必须是 `'object'`：OpenAI 工具协议要求参数 schema 是对象 schema。
   * 不校验的话，错误会先出现在上游的 400 上，而那句报错离病因（某个插件的 schema 写错）
   * 隔了整整一层网络。
   */
  const params = d.parameters
  if (!params || typeof params !== 'object' || params['type'] !== 'object') {
    throw new Error(
      `@geewiki/ai-tools: 工具 ${d.name} 的 parameters 必须是 { type: 'object', … }（上游工具协议要求）`,
    )
  }
  if (d.side !== 'server' && d.side !== 'client') {
    throw new Error(`@geewiki/ai-tools: 工具 ${d.name} 的 side 必须是 'server' 或 'client'`)
  }
  if (typeof tool.execute !== 'function') {
    throw new Error(`@geewiki/ai-tools: 工具 ${d.name} 缺少 execute`)
  }
}

export class AiToolRegistry implements AiToolService {
  private readonly byName = new Map<string, { owner: string; tool: AiToolContribution }>()

  /**
   * 登记一条工具，返回**幂等**的注销函数。
   *
   * 重复 `name` 抛错（见文件头）。**先校验后写入**：校验失败时表必须保持原样，
   * 否则一次失败的贡献会留下半条记录。
   */
  contribute(owner: string, tool: AiToolContribution): () => void {
    assertOwner(owner)
    assertContribution(owner, tool)

    const name = tool.descriptor.name
    const existing = this.byName.get(name)
    if (existing) {
      throw new Error(
        `@geewiki/ai-tools: 工具名 ${name} 已被 ${existing.owner} 占用，${owner} 不得重复贡献` +
          '（名字是模型调用的唯一凭据，静默覆盖会让"模型想调的那个"没有确定答案）',
      )
    }
    this.byName.set(name, { owner, tool })

    if (tool.descriptor.description.length > TOOL_DESCRIPTION_BUDGET) {
      // 告警而**不抛**：描述写长了是观感/准确率问题，让整个知识库工具带下线才是真问题
      // （取舍同插槽的"未知插槽名告警但不阻断激活"）。膨胀经 diagnostics() 对管理台可见。
      console.warn(
        `[ai-tools] 工具 ${name}（${owner}）的描述 ${tool.descriptor.description.length} 字符，` +
          `超过 ${TOOL_DESCRIPTION_BUDGET} 字符预算——工具多时这会稀释模型的选择准确率`,
      )
    }

    let done = false
    return () => {
      if (done) return
      done = true
      // 只删"还是我这条"的记录：若已被 release(owner) 清掉又被别人重新注册同一名字，
      // 迟到的 disposer 不该把新主人的工具删掉。
      const now = this.byName.get(name)
      if (now && now.owner === owner) this.byName.delete(name)
    }
  }

  list(principal: Principal): readonly ResolvedTool[] {
    const out: ResolvedTool[] = []
    for (const entry of this.byName.values()) {
      const filter = entry.tool.descriptor.available
      // 无权使用的工具**不进工具表**：只按执行时拒绝的话，模型会先跟用户承诺"我帮你做"，
      // 然后 403——那比"这个能力不存在"更伤体验，还泄露了能力存在（见 types.ts 文件头）。
      if (filter && !filter(principal)) continue
      out.push({ owner: entry.owner, descriptor: entry.tool.descriptor, execute: entry.tool.execute })
    }
    // 确定性排序：owner 字典序 → 工具名字典序（设计文档 §0.4）。注册顺序不得影响结果。
    out.sort(
      (a, b) =>
        compareCodeUnits(a.owner, b.owner) || compareCodeUnits(a.descriptor.name, b.descriptor.name),
    )
    return out
  }

  ownerOf(name: string): string | undefined {
    return this.byName.get(name)?.owner
  }

  release(owner: string): void {
    for (const [name, entry] of [...this.byName]) {
      if (entry.owner === owner) this.byName.delete(name)
    }
  }

  /**
   * 清空整张表。
   *
   * **刻意不在 {@link AiToolService} 接口上**——它是具体类的 teardown 方法，
   * 不是消费方该有的能力（同 `HttpRouter.closeStreams()`：不在 `HttpRouterService`
   * 接口上，只在具体类上）。唯一的调用点是本插件 disposer 里服务撤销之后那一步。
   */
  releaseAll(): void {
    this.byName.clear()
  }

  diagnostics(): AiToolDiagnostics {
    const overBudget: AiToolBudgetEntry[] = []
    const mutating: string[] = []
    for (const [name, entry] of this.byName) {
      const len = entry.tool.descriptor.description.length
      if (len > TOOL_DESCRIPTION_BUDGET) overBudget.push({ owner: entry.owner, name, length: len })
      if (entry.tool.descriptor.mutating === true) mutating.push(name)
    }
    overBudget.sort((a, b) => compareCodeUnits(a.name, b.name))
    mutating.sort(compareCodeUnits)
    return { count: this.byName.size, overBudget, mutating }
  }
}
