/**
 * `@geewiki/ai-admin` —— 管理台工具：让 AI 在**护栏**约束下启停插件、读写插件配置。
 *
 * ## 为什么这一批是"最后做"的
 * 决策 2 把「管理台（启停插件、改配置）」放进本轮边界，但它是**唯一一类能削弱 AI 自身能力**
 * 的工具：停掉 `@geewiki/ai-tools` 等于把工具总线拆了，停掉 `@geewiki/llm` 等于让助手失语。
 * 所以它必须排在护栏落地**之后**——`checkSelfLock` 是 P4 的产物，本插件是它的第一个真实消费者
 * （P4 的注释里就写着"启停工具本身要到 P5 才存在，届时 `targetsOf(args)` 由那个工具交出目标名"）。
 *
 * ## 三道护栏，顺序即语义
 * 一次 `plugin.set_enabled` 要依次穿过：
 * 1. **主体**——非 owner/admin（且非 break-glass）**连工具都看不到**（`available`），
 *    真调了在执行体里再拒一次。两层不是重复：`available` 管"别把无权的能力摆到模型面前"，
 *    执行体管"真调了也不放行"。
 * 2. **自锁**（决策 13）——目标落在 `PROTECTED_AI_NODES` 里就**拒绝动手**。
 *    **这一条必须在调用管理器之前判**：等 `journal.record()` 来拦就晚了，
 *    那时插件已经被停掉了（`journal` 只会拒绝**记录**，不会回滚已经发生的事）。
 * 3. **可回退**——没有轮次标识就不动手（"记不下来就别改"，与 `page.update` 同一条）。
 *
 * 第 2 条的顺序是本插件里最容易写错、也最贵的一处：`page.update` 可以"先写后记"
 * （因为回退是幂等的整篇正文），但**停用一个插件不是**——它当场生效且没有逆操作。
 *
 * ## 为什么工具名是 `plugin.*` 而不是 `admin.*`
 * 名字直接进模型的工具表（`TOOL_DESCRIPTION_BUDGET = 200` 是注意力预算）。
 * `plugin.` 是**对象**前缀，模型看到名字就知道操作对象；`admin.` 是**权限**前缀，
 * 而权限已经由 `available` 决定了，写在名字里是噪声。
 */
import type { Context } from 'cordis'
import type { GeeWikiManifest, Principal } from '@geewiki/core'
import {
  AI_TOOL_SERVICE_NAME,
  type AiToolContext,
  type AiToolContribution,
  type AiToolResult,
  type AiToolService,
} from '@geewiki/ai-tools'
import {
  AI_JOURNAL_SERVICE_NAME,
  checkSelfLock,
  type AiJournalService,
  type MutationRecord,
  type ProbeOutcome,
  type UndoOutcome,
} from '@geewiki/ai-journal'
import {
  decodePluginState,
  encodePluginState,
  isAdminPrincipal,
  managerCodeOf,
  nothingChanged,
  parseName,
  parseSetConfig,
  parseSetEnabled,
  refusalForCode,
} from './plan.js'

export {
  decodePluginState,
  encodePluginState,
  isAdminPrincipal,
  managerCodeOf,
  nothingChanged,
  parseName,
  parseSetConfig,
  parseSetEnabled,
  refusalForCode,
  type PluginStateSnapshot,
} from './plan.js'

/** 四条工具名（**已排序**：顺序不稳 ⇒ 每轮请求前缀都变 ⇒ 上游前缀缓存全失效） */
export const ADMIN_TOOL_NAMES = [
  'plugin.list',
  'plugin.read_config',
  'plugin.set_config',
  'plugin.set_enabled',
] as const

export type AdminToolName = (typeof ADMIN_TOOL_NAMES)[number]

/** 回退时用的域标识（journal 按域挑撤销执行体） */
export const PLUGIN_DOMAIN = 'plugin'

/* ============================== 管理器服务的窄口 ============================== */

/**
 * 本插件用到的管理器能力的**结构性最小面**。
 *
 * 为什么用结构类型而不是 `import type { GeeWikiManager } from '@geewiki/manager'`：
 * 那会把整个管理器类拖进本包的依赖（它带着 HTTP、文件清单、插件加载器），
 * 而这里真正用到的只有五个方法。结构类型同时让测试可以注入一个几十行的替身，
 * **不必启动一个真管理器**——而"不必启动真管理器"正是这些判据能被逐条钉死的前提。
 *
 * 形状照抄 `packages/plugin-ai-pages/src/index.ts` 的 `WikiServiceLike`（同一条取舍）。
 */
export interface ManagerLike {
  snapshot(): readonly {
    readonly name: string
    readonly displayName?: string
    readonly description?: string
    readonly state: 'active' | 'inactive' | 'error'
    readonly layer: 'base' | 'session' | null
    readonly requires: readonly string[]
    readonly configurable: boolean
    readonly error?: string
  }[]
  enable(name: string, config?: Record<string, unknown>): Promise<unknown>
  disable(name: string): Promise<void>
  configOf(name: string): {
    readonly config: Record<string, unknown>
    readonly layer: 'base' | 'session' | null
    readonly activeLayer: 'base' | 'session' | null
    readonly secrets: Record<string, boolean>
  }
  updateConfig(name: string, raw: unknown): Promise<{ readonly config: Record<string, unknown> }>
}

/* ============================== 工具实现 ============================== */

/**
 * 统一的"没改任何东西"的结果。
 *
 * 措辞里**必须有**"没有改动任何东西"（由 `nothingChanged` 保证、且幂等）：
 * 模型读到一句干巴巴的错误时会倾向重试或换参数，而读到"什么都没变"它才会停下来
 * 如实告诉用户。这句话是这一层能给出的最重要的信息。
 */
function refused(reason: string, data: Record<string, unknown> = {}): AiToolResult {
  return { content: nothingChanged(reason), data: { refused: true, ...data } }
}

function missingTurnContext(): AiToolResult {
  /*
   * 与 `page.update` 同一条：没有轮次标识时这次改动会变成"改了但说不清是哪一轮改的"，
   * 也就是**不可回退**。一个不报错的不可逆操作是最坏的一类缺陷。
   */
  return refused(
    '这次请求没有带上会话/轮次标识，无法记录一条可回退的变更，因此**没有改动任何东西**。' +
      '请让用户从页面底部的助手输入条重新发起这次操作（那里会自动带上标识）。',
    { refused: 'missing_turn_context' },
  )
}

/**
 * 把一次管理器调用折算成工具结果：成功 → 一句说明 + 一条 journal 记录；失败 → 可读的拒绝。
 *
 * 抽出来是因为四条工具里有三条走同一条路（**先做、再记**），
 * 而"别忘了记"这件事在四个地方各写一遍时迟早会漏一处——漏了的表现是
 * "AI 改了但用户点不了回退"，而它在用户去点之前完全不报错。
 */
async function withJournal(
  journal: AiJournalService,
  context: AiToolContext,
  tool: string,
  target: string,
  before: string,
  after: string,
  apply: () => Promise<string>,
): Promise<AiToolResult> {
  if (context.turnId === null || context.conversationId === null) return missingTurnContext()
  let detail: string
  try {
    detail = await apply()
  } catch (err) {
    const code = managerCodeOf(err)
    const message = err instanceof Error ? err.message : String(err)
    return refused(code === null ? `操作失败：${message}` : refusalForCode(code, message, target), {
      error: code ?? 'failed',
    })
  }
  /*
   * 日志在**生效之后**记（与 `page.update` 同口径）：反过来会在写入失败时留下一条
   * 声称改过的记录，而回退它会把插件"还原"成一个它从未变成的样子。
   */
  const recordId = await journal.record({
    conversationId: context.conversationId,
    turnId: context.turnId,
    owner: manifest.name,
    tool,
    domain: PLUGIN_DOMAIN,
    target,
    before,
    after,
  })
  return {
    content: `${detail}变更已记录（#${recordId}），用户可以在对话里要求回退。`,
    data: { target, recordId },
  }
}

function adminTools(ctx: Context, journal: AiJournalService): readonly AiToolContribution[] {
  /*
   * ★ 管理器**必须在执行时取**，不能在 `apply` 时取。
   *
   * `PluginManagerPlugin.apply` 的顺序是 `await manager.boot()`（本插件就在这一步被激活）
   * **然后**才 `ctx.provide('manager', …)`。于是在 `apply` 里 `ctx.get('manager')`
   * 必然拿到 `undefined`——而按本仓纪律那会抛错，插件根本激活不了。
   * 这不是"暂时拿不到"，是**结构上拿不到**：管理器不可能在自己结算之前把自己提供出去。
   *
   * 执行发生在很久之后（用户提问时），那时服务早就在了。
   */
  const manager = (): ManagerLike | undefined => ctx.get('manager') as ManagerLike | undefined

  const needManager = (): AiToolResult | ManagerLike =>
    manager() ?? refused('管理器服务不可用（@geewiki/manager 未激活），管理台操作无法执行。', { error: 'no_manager' })

  /** 三条写工具共用的前置判定：主体 → 自锁。**顺序不能反**（自锁那条必须在动手之前判） */
  const gate = (principal: Principal, name: string): AiToolResult | null => {
    if (!isAdminPrincipal(principal)) {
      // 与 `available` 同一判据、同一句话：能走到这里说明工具表被绕过了
      return refused('只有组织所有者或管理员才能让 AI 改动插件状态，本次**没有改动任何东西**。', {
        error: 'forbidden',
      })
    }
    const violation = checkSelfLock([name])
    if (violation !== null) {
      /*
       * ★ 决策 13 的落点。**必须在调管理器之前判**：
       * 停用是当场生效且没有逆操作的，等 journal 来拦就晚了——
       * 它只会拒绝**记录**，不会把已经停掉的插件开回来。
       */
      return refused(`${violation.reason}本次**没有改动任何东西**。`, {
        error: 'self_lock',
        node: violation.node,
      })
    }
    return null
  }

  return [
    /* ---------------------------- plugin.list（只读） ---------------------------- */
    {
      descriptor: {
        name: 'plugin.list',
        description:
          '列出全部插件及其状态（启用/停用/出错）、所在层（base=基础层，改它要重启；session=会话层，可热改）与依赖。' +
          '要启停或改配置前先看它——名字是**包名**（如 @geewiki/echo），不是显示名。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        side: 'server',
        available: isAdminPrincipal,
      },
      execute: async (principal: Principal): Promise<AiToolResult> => {
        const mgr = needManager()
        if ('content' in mgr) return mgr
        const rows = mgr.snapshot().map((p) => ({
          name: p.name,
          ...(p.displayName === undefined ? {} : { displayName: p.displayName }),
          state: p.state,
          layer: p.layer,
          requires: [...p.requires],
          configurable: p.configurable,
          ...(p.error === undefined ? {} : { error: p.error }),
        }))
        void principal
        return {
          content: JSON.stringify({
            total: rows.length,
            plugins: rows,
            note: 'layer=base 的插件不能通过 AI 停用或改配置（要改基础层清单并重启）。',
          }),
          data: { total: rows.length },
        }
      },
    },

    /* ---------------------------- plugin.read_config（只读） ---------------------------- */
    {
      descriptor: {
        name: 'plugin.read_config',
        description:
          '读取某个插件**当前生效**的配置。密钥类字段只会告诉你"有没有配"，绝不返回原值。' +
          '要改配置必须先读它：写配置是**整份替换**，不是打补丁——漏掉一个字段就等于把它删了。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '插件包名，如 @geewiki/search' } },
          required: ['name'],
          additionalProperties: false,
        },
        side: 'server',
        available: isAdminPrincipal,
      },
      execute: async (_principal: Principal, args: unknown): Promise<AiToolResult> => {
        const name = parseName(args)
        if (typeof name !== 'string') return refused(name.error, { error: 'invalid_arguments' })
        const mgr = needManager()
        if ('content' in mgr) return mgr
        let info: ReturnType<ManagerLike['configOf']>
        try {
          info = mgr.configOf(name)
        } catch (err) {
          const code = managerCodeOf(err)
          const message = err instanceof Error ? err.message : String(err)
          return refused(code === null ? `读取失败：${message}` : refusalForCode(code, message, name), {
            error: code ?? 'failed',
          })
        }
        return {
          content: JSON.stringify({
            name,
            layer: info.layer,
            activeLayer: info.activeLayer,
            config: info.config,
            // 只报有无，绝不返回值——与管理器 REST 层同一口径
            secrets: info.secrets,
            note: '写回时必须给出**完整**的 config（可以在这个对象上改），否则缺失的字段会被重置成默认值。',
          }),
          data: { name, layer: info.layer },
        }
      },
    },

    /* ---------------------------- plugin.set_enabled（写） ---------------------------- */
    {
      descriptor: {
        name: 'plugin.set_enabled',
        description:
          '启用或停用某个插件（会话层热生效）。用户说"把这个插件关掉""打开某某功能"时用。' +
          '基础层的插件停不了（会明确告诉你原因）；AI 自身依赖链上的插件（llm / ai-tools / ai-assistant / ai-journal / ai-admin）一律拒绝。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '插件包名，如 @geewiki/echo' },
            enabled: { type: 'boolean', description: 'true=启用，false=停用。**必填**，不要省略' },
          },
          required: ['name', 'enabled'],
          additionalProperties: false,
        },
        side: 'server',
        mutating: true,
        available: isAdminPrincipal,
      },
      execute: async (principal: Principal, args: unknown, context: AiToolContext): Promise<AiToolResult> => {
        const parsed = parseSetEnabled(args)
        if ('error' in parsed) return refused(parsed.error, { error: 'invalid_arguments' })
        const { name, enabled } = parsed
        const blocked = gate(principal, name)
        if (blocked !== null) return blocked
        const mgr = needManager()
        if ('content' in mgr) return mgr

        const row = mgr.snapshot().find((p) => p.name === name)
        if (row === undefined) return refused(refusalForCode('not_found', name, name), { error: 'not_found' })
        const before = encodePluginState({ kind: 'enabled', value: row.state === 'active' })
        if (row.state === 'active' === enabled) {
          /* 幂等：状态没变就不动手、也不记日志。记一条"点了没反应"的记录只会污染回退入口 */
          return {
            content: `${name} 当前${enabled ? '已经是启用状态' : '本来就没有启用'}，无需改动（未记录）。`,
            data: { target: name, unchanged: true },
          }
        }
        return withJournal(journal, context, 'plugin.set_enabled', name, before, encodePluginState({ kind: 'enabled', value: enabled }), async () => {
          if (enabled) {
            await mgr.enable(name)
            return `已启用 ${name}。`
          }
          await mgr.disable(name)
          return `已停用 ${name}。`
        })
      },
    },

    /* ---------------------------- plugin.set_config（写） ---------------------------- */
    {
      descriptor: {
        name: 'plugin.set_config',
        description:
          '写入某个插件的配置（**整份替换**，不是补丁）。必须先 plugin.read_config 拿到当前配置，在它上面改，再整份写回。' +
          '配置不合法时插件会拒绝，且不会改动任何东西。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '插件包名，如 @geewiki/search' },
            config: { type: 'object', description: '**完整**的新配置对象（不是补丁）' },
          },
          required: ['name', 'config'],
          additionalProperties: false,
        },
        side: 'server',
        mutating: true,
        available: isAdminPrincipal,
      },
      execute: async (principal: Principal, args: unknown, context: AiToolContext): Promise<AiToolResult> => {
        const parsed = parseSetConfig(args)
        if ('error' in parsed) return refused(parsed.error, { error: 'invalid_arguments' })
        const { name, config } = parsed
        const blocked = gate(principal, name)
        if (blocked !== null) return blocked
        const mgr = needManager()
        if ('content' in mgr) return mgr

        const row = mgr.snapshot().find((p) => p.name === name)
        if (row === undefined) return refused(refusalForCode('not_found', name, name), { error: 'not_found' })
        /*
         * `before` 取的是**当前生效**的配置（`configOf`），不是快照里那份。
         * 快照的 `config` 是路由层剥过密钥之后的形态，拿它当回退基准会把密钥字段抹掉。
         */
        const before = encodePluginState({ kind: 'config', value: mgr.configOf(name).config })
        const after = encodePluginState({ kind: 'config', value: config })
        if (before === after) {
          return { content: `${name} 的配置与给定内容一致，无需修改（未写入、未记录）。`, data: { target: name, unchanged: true } }
        }
        return withJournal(journal, context, 'plugin.set_config', name, before, after, async () => {
          const result = await mgr.updateConfig(name, config)
          return `已更新 ${name} 的配置（${JSON.stringify(result.config).length} 字符）。`
        })
      },
    },
  ]
}

/* ============================== 回退执行体与探针 ============================== */

/**
 * `plugin` 域的撤销执行体。
 *
 * **判据是"他现在是不是管理员"**，而不是"他曾经是不是"——与 `ai-pages` 的 `undoPage`
 * 同一条（journal 的 `UndoHandler` 注释把这条写死了：能回退的前提是他现在有写权限）。
 * 一个被降权的用户点回退应当失败，那不是 bug，是权限在起作用。
 */
export function makePluginUndoer(manager: () => ManagerLike | undefined) {
  return async (record: MutationRecord, principal: Principal): Promise<UndoOutcome> => {
    if (!isAdminPrincipal(principal)) return { ok: false, detail: '你现在没有管理员权限，无法回退插件变更' }
    const mgr = manager()
    if (mgr === undefined) return { ok: false, detail: '管理器服务不可用，无法回退插件变更' }
    /*
     * ★ 回退**也要过自锁**。理由不是对称美学：这条记录可能是在
     * `PROTECTED_AI_NODES` 扩容**之前**写下的（例如 ai-admin 是 P5 才加进名单的），
     * 一条历史记录不该成为绕过当前红线的通行证。
     */
    const violation = checkSelfLock([record.target])
    if (violation !== null) return { ok: false, detail: `${violation.reason}（这条历史变更同样不可回退）` }

    const want = decodePluginState(record.before)
    if (want === null) {
      return { ok: false, detail: `这条记录的内容认不出来（${record.before === null ? '空' : '格式不符'}），无法安全回退` }
    }
    try {
      if (want.kind === 'enabled') {
        if (want.value) {
          await mgr.enable(record.target)
          return { ok: true, detail: `已重新启用 ${record.target}` }
        }
        await mgr.disable(record.target)
        return { ok: true, detail: `已再次停用 ${record.target}` }
      }
      await mgr.updateConfig(record.target, want.value)
      return { ok: true, detail: `已把 ${record.target} 的配置还原` }
    } catch (err) {
      const code = managerCodeOf(err)
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, detail: code === null ? message : refusalForCode(code, message, record.target) }
    }
  }
}

/**
 * `plugin` 域的探针：**现在**这个插件的状态/配置是什么。
 *
 * 判据必须与写入时**完全同形**（同一个 `encodePluginState`），否则冲突检测会恒报冲突
 * ——而"总是拒绝回退"与"从来不检查冲突"一样糟：用户会以为回退坏了。
 */
export function makePluginProbe(manager: () => ManagerLike | undefined) {
  return async (record: MutationRecord, principal: Principal): Promise<ProbeOutcome> => {
    if (!isAdminPrincipal(principal)) {
      return { reason: '你现在没有管理员权限，读不到插件的当前状态——无法确认它有没有被别人改过' }
    }
    const mgr = manager()
    if (mgr === undefined) return { reason: '管理器服务不可用，无法确认插件的当前状态' }
    const want = decodePluginState(record.after)
    if (want === null) return { reason: '这条记录的"变更后"内容认不出来，无法与当前状态比对' }
    try {
      if (want.kind === 'enabled') {
        const row = mgr.snapshot().find((p) => p.name === record.target)
        if (row === undefined) return { reason: `${record.target} 已不在插件注册表里` }
        return { value: encodePluginState({ kind: 'enabled', value: row.state === 'active' }) }
      }
      return { value: encodePluginState({ kind: 'config', value: mgr.configOf(record.target).config }) }
    } catch (err) {
      return { reason: `读取 ${record.target} 的当前状态失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

/* ============================== 插件 ============================== */

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-admin',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 管理台工具',
    description: '让 AI 助手在护栏约束下查看、启停插件并读写插件配置（仅所有者/管理员可用）',
    // 纯贡献者，不 provide 任何服务（同 ai-kb / ai-writing / ai-nav）
    provides: undefined,
    /*
     * `ai-journal-service` 是**写操作的地基**，与 `ai-pages` 同一取舍：
     * 日志缺席时这几条工具不该存在，而不是照改然后留下一批不可回退的改动。
     *
     * ⚠️ **刻意不声明 `manager`**：管理器是引导期直接 `app.plugin()` 装载的，
     * 它不在注册表里、也就没有 `provides` 可供依赖解析匹配。声明它只会让本插件
     * 因为"依赖无法解析"而激活失败——而真正的取用发生在执行期（见 `manager()` 的注释）。
     */
    requires: ['ai-tool-service', 'ai-journal-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 无内部状态：产物是四条注册 + 一个撤销执行体
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: undefined,
    slots: undefined,
  },
}

export const AiAdminPlugin = {
  name: '@geewiki/ai-admin',

  apply(ctx: Context): () => void {
    /*
     * 服务缺失时**明确抛错**，不静默跳过 —— 与 `@geewiki/ai-kb` 同一条实测教训
     * （`packages/manager/src/slot-plugin.ts` 文件头）。
     */
    const tools = ctx.get(AI_TOOL_SERVICE_NAME) as AiToolService | undefined
    if (!tools) throw new Error('@geewiki/ai-admin: ai-tool-service 不可用（@geewiki/ai-tools 未激活）')
    const journal = ctx.get(AI_JOURNAL_SERVICE_NAME) as AiJournalService | undefined
    if (!journal) throw new Error('@geewiki/ai-admin: ai-journal-service 不可用（@geewiki/ai-journal 未激活）')

    const manager = (): ManagerLike | undefined => ctx.get('manager') as ManagerLike | undefined

    for (const tool of adminTools(ctx, journal)) tools.contribute(manifest.name, tool)
    const releaseUndoer = journal.registerUndoer(manifest.name, PLUGIN_DOMAIN, makePluginUndoer(manager))
    const releaseProbe = journal.registerProbe(manifest.name, PLUGIN_DOMAIN, makePluginProbe(manager))

    return () => {
      releaseProbe()
      releaseUndoer()
      // 按 owner 定向回收：与管理器卸载插件时走的路径一致
      tools.release(manifest.name)
    }
  },
}
