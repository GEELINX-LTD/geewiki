/**
 * 插件管理台的**展示层映射**（纯函数，无 React/DOM 依赖，便于单测）。
 *
 * 为什么单独抽一层：管理台原先直接把 `@geewiki/db-sqlite`、`http-service`、
 * `基础层`、`./src/migrations`、`plugins.base.json` 这类**实现细节**糊在主表格里，
 * 普通使用者读不懂（用户反馈"开发味太重"）。解法不是"删掉信息"，而是
 * **分层**：主行说人话，技术原文折叠进详情。映射规则集中在这里，
 * 这样"哪个词该给人看、哪个词该收进详情"是可单测的，而不是散在 JSX 里。
 *
 * ⚠️ 措辞准确性（本文件刻意纠了既有文案的一处错误）：
 * 既有的「会话层变更…**重启即失**」是**不准确**的。读 `packages/manager/src/index.ts` 的
 * `boot()` 可见：
 *   - 正常启动（无崩溃标记）会 `readList(sessionFile)` **重新装配会话层**（:640）；
 *   - 只有检测到崩溃标记（上次异常退出）时才「忽略会话层并回滚至基础层」并清空文件（:628-637）。
 * 因此**会话变更在正常重启后仍在，在异常崩溃恢复时才被丢弃**（这正是"自愈"的设计意图）。
 * 见 {@link SESSION_LAYER_HINT} 与 {@link PERSIST_HINT}。
 */

/** 插件状态：给人看的词。与后端 `active|inactive|error` 一一对应。 */
export type PluginStateCode = 'active' | 'inactive' | 'error'

export const STATE_TEXT: Record<PluginStateCode, string> = {
  active: '运行中',
  inactive: '未启用',
  error: '异常',
}

/** 主行里"所在层"的人话：使用者关心的是"重启后还在不在"，不是层的名字 */
export const LAYER_HUMAN: Record<'base' | 'session', string> = {
  base: '随启动加载',
  session: '临时启用',
}

/**
 * 技术详情里的原文措辞（保留"基础层/会话层"这两个内部术语，因为排障时需要对上日志与代码）。
 * 括号里补一句实际后果——这是把术语翻译成"会发生什么"。
 */
export const LAYER_TECH: Record<'base' | 'session', string> = {
  base: '基础层（基础清单里的条目，任何重启都会加载）',
  session: '会话层（临时条目，异常崩溃恢复时会被系统丢弃）',
}

/** 会话层一句话说明（放在"临时变更"区块的说明位置） */
export const SESSION_LAYER_HINT =
  '临时启用只写入会话清单，立即生效。**正常重启仍会保留**；若进程异常崩溃，系统在下次启动时自动丢弃这些临时变更、回滚到基础清单（自愈机制）。'

/** "应用并持久化"的后果说明（二次确认框里用） */
export const PERSIST_HINT =
  '把当前临时变更写进基础清单，此后**任何**重启都会加载它们，并且不再受自愈回滚影响。'

/** 来源：内置（随宿主发布）/ 外部（放在插件目录里被发现的） */
export const SOURCE_TEXT: Record<'builtin' | 'external', string> = {
  builtin: '内置',
  external: '外部',
}

/**
 * 去掉 npm scope 前缀，便于阅读：`@geewiki/db-sqlite` → `db-sqlite`。
 * 只剥**一层** scope；没有 scope 的名字原样返回（例如 `@geewiki-plugin/hello` →
 * `hello`，而 `foo` → `foo`）。
 *
 * 注意：这只是**回退显示名**。真正的可读名称应来自 manifest 的 `geewiki.displayName`
 * （见 {@link displayNameOf}）。
 */
export function plainName(name: string): string {
  const m = /^@[^/]+\/(.+)$/.exec(name)
  return m?.[1] ?? name
}

/** 插件信息里与展示相关的字段（结构上是 `PluginInfo` 的子集，便于测试构造） */
export interface DisplaySource {
  name: string
  /** manifest 的 `geewiki.displayName`（面向人的名称）；缺失时回退 {@link plainName} */
  displayName?: string
  /** manifest 的 `geewiki.description`（一句话说明） */
  description?: string
}

/**
 * 主行显示的名称：优先 manifest 的 `displayName`，否则回退到去 scope 的短名。
 * 空白字符串视为"未提供"（避免显示一个空标题）。
 */
export function displayNameOf(p: DisplaySource): string {
  const explicit = p.displayName?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  return plainName(p.name)
}

/** 一句话说明；未提供或空白时返回 undefined（调用方据此决定不渲染该行） */
export function descriptionOf(p: DisplaySource): string | undefined {
  const d = p.description?.trim()
  return d === undefined || d === '' ? undefined : d
}

/**
 * 把长标识符切成"可在分隔符处换行"的片段，供 React Flow 节点渲染。
 *
 * 为什么需要：节点的插件名（如 `@geewiki-plugin/hello`）**没有空格**，
 * 浏览器默认只在空格/连字符等断点折行，遇到超长标识符要么整体溢出、
 * 要么被 `break-all` 从**词中间**劈开——后者正是既有缺陷
 * （截图实测出现 `@geewiki-plugin/hel` + 换行 `lo`）。
 *
 * 做法：在分隔符（`@ / - _ .`）**之后**插入可断行机会，于是折行只发生在
 * 语义边界上；配合调用方按内容给宽度，常见名字根本不需要折行。
 *
 * 返回片段数组（分隔符保留在前一片段末尾），调用方在片段之间渲染 `<wbr />`。
 */
export function labelSegments(label: string): string[] {
  if (label === '') return []
  // 在分隔符后切分（零宽断言，不消耗字符，故分隔符留在前一片段末尾）。
  // **刻意不含 `@`**：若在 `@` 之后也给断点，`@geewiki-plugin/hello` 会变成
  // `['@', 'geewiki-', …]`，折行时可能把孤零零的 `@` 留在上一行——那不是语义边界。
  const parts = label.split(/(?<=[/\-_.])/)
  return parts.filter((s) => s !== '')
}

/**
 * 估算节点宽度（px）：按**最长片段**给宽度，使折行只可能发生在分隔符处，
 * 且不至于为超长名字撑出巨宽节点。
 *
 * 用 `ch` 估算而不是真实测量：节点在 React Flow 里由我们自己渲染，
 * 宽度必须**在渲染前**给出（用于布局坐标），无法等 DOM 测量。
 * 近似值偏大一点无妨（留白比截断好），故乘 8.2px/字符并留 28px 内边距。
 */
export function estimateNodeWidth(label: string, min = 150, max = 260): number {
  const segs = labelSegments(label)
  const longest = segs.reduce((m, s) => Math.max(m, s.length), 0) || label.length
  const raw = Math.round(longest * 8.2) + 28
  return Math.min(max, Math.max(min, raw))
}

/**
 * 状态徽章的语义色调（映射到 `ui/Badge` 的 tone，而不是直接给颜色）。
 * `warn` 用于"异常"是因为它是**需要关注**而非致命失败（插件失败不会拖垮宿主）。
 */
export function stateTone(state: PluginStateCode): 'ok' | 'neutral' | 'warn' {
  if (state === 'active') return 'ok'
  if (state === 'error') return 'warn'
  return 'neutral'
}
