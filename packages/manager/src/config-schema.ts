/**
 * 插件配置 Schema 的服务端处理（架构 §5.7：配置校验 + 序列化下发）。
 *
 * 三件事：
 * 1. {@link isSchemaInstance}  —— 区分 schemastery Schema 与旧式 JSON Schema 字面量；
 * 2. {@link sanitizeSchemaPayload} —— 把 Schema 实例序列化为下发给前端的载荷，
 *    **剥离 callback / preserve / constructor**（见下方安全红线）；
 * 3. {@link validateConfig} / {@link pruneUnknownFields} —— 校验 + 填默认值 + 白名单裁剪。
 *
 * 安全红线：schemastery 的反序列化（`Schema(payload)`）会对节点里的 `callback`
 * 字符串执行 `new Function('return ' + source)()`。插件是不可信输入的一半，
 * 因此**绝不能**把带 callback 的载荷交给前端反序列化；本模块在下发前剥离它们，
 * 前端只按 refs 图渲染、不做反序列化。
 */
import type { ConfigSchema } from '@geewiki/core'
import { SECRET_ROLE } from './secrets.js'

/** 序列化载荷中的单个 schema 节点 */
export interface ConfigSchemaNode {
  type?: string
  meta?: Record<string, unknown>
  dict?: Record<string, number>
  list?: number[]
  inner?: number
  sKey?: number
  bits?: Record<string, number>
  value?: unknown
  [key: string]: unknown
}

/** 下发给前端的 schema 载荷（refs 是 uid 字符串到节点的映射，非数组） */
export interface ConfigSchemaPayload {
  uid: number
  refs: Record<string, ConfigSchemaNode>
}

/** 校验问题（对齐 schemastery/standard-schema 的形状） */
export interface ConfigIssue {
  message: string
  path?: (string | number)[]
}

/** 需要在下发前剥离的字段（callback 可执行任意 JS；preserve 无渲染意义；constructor 仅诊断用） */
const UNSAFE_NODE_FIELDS = ['callback', 'preserve', 'constructor'] as const

/** transform 降级时的 inner 链深度上限（防深链/自引用导致死循环） */
const TRANSFORM_DEPTH_LIMIT = 32

/** 判定是否 schemastery Schema 实例（实例是可调用函数且带 toJSON） */
export function isSchemaInstance(value: unknown): value is ConfigSchema {
  return typeof value === 'function' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
}

/**
 * 序列化 Schema 实例为可下发载荷：剥离不安全字段，并把 `transform`/`lazy` 节点降级为
 * 透传其 `inner`（S-8：transform 描述的是"变换后的值"，前端既无法编辑也无法反序列化
 * 它的 callback，原样下发会让载荷不自洽——`new Schema(payload)` 无法还原）。
 */
export function sanitizeSchemaPayload(schema: ConfigSchema): ConfigSchemaPayload {
  // toJSON 的静态类型是"Schema 引用图"，实际经 JSON.stringify 后是纯数据节点图（无函数、无实例）
  const payload = schema.toJSON() as unknown as ConfigSchemaPayload
  const refs: Record<string, ConfigSchemaNode> = {}
  for (const [uid, node] of Object.entries(payload.refs ?? {})) {
    const clean: ConfigSchemaNode = { ...node }
    for (const field of UNSAFE_NODE_FIELDS) delete clean[field]
    refs[uid] = clean
  }
  for (const [uid, node] of Object.entries(refs)) {
    if (node.type !== 'transform') continue
    const inner = passthroughInner(refs, node)
    // 完全透传 inner（含其 meta）：transform 自身的 meta 描述的是变换后的值，前端无法编辑
    if (inner) refs[uid] = { ...inner }
  }
  return { uid: payload.uid, refs }
}

/** 沿 `inner` 链找到第一个非 transform 节点（深度受限；成环/缺失返回 undefined） */
function passthroughInner(
  refs: Record<string, ConfigSchemaNode>,
  node: ConfigSchemaNode,
): ConfigSchemaNode | undefined {
  let current = node
  for (let depth = 0; depth < TRANSFORM_DEPTH_LIMIT; depth++) {
    const innerUid = current.inner
    if (typeof innerUid !== 'number') return undefined
    const next = refs[String(innerUid)]
    if (!next) return undefined
    if (next.type !== 'transform') return next
    current = next
  }
  return undefined
}

/** 结构化的 schema 视图（仅取校验/裁剪所需的引用面，避免依赖 schemastery 的运行期类型） */
interface SchemaLike {
  dict?: Record<string, SchemaLike>
  inner?: SchemaLike
  list?: SchemaLike[]
  /**
   * 节点的元信息（`role` / `description` / `default` …）；仅用于识别 `role: 'secret'`。
   * 用 `unknown` 而非具体形状：schemastery 的 `Meta<any>` 没有字符串索引签名，
   * 写成 `Record<string, unknown>` 会让整个 `SchemaLike` 转换被视为不安全的收窄。
   */
  meta?: unknown
}

/**
 * 声明为 `role: 'secret'` 的**顶层**字段名（写一次、不可回读）。
 *
 * 语义（由 `Manager` 落实，见 `secrets.ts` 的文件头）：
 * 值落盘到独立的密钥文件、**不写进 `plugins.*.json`**、任何 HTTP 响应都不回显，
 * 留空表示"不修改"，要改只能填一个新值。
 *
 * 只识别顶层字段是**有意的收窄**：密钥藏进数组/嵌套对象既没有真实用例，
 * 又会让"留空 = 不修改"这条语义变得无法判断（空数组 ≠ 未填写）。
 */
export function secretFieldNames(schema: ConfigSchema): string[] {
  const dict = (schema as SchemaLike).dict
  if (!dict) return []
  const out: string[] = []
  for (const [key, node] of Object.entries(dict)) {
    const role = (node.meta as { role?: unknown } | undefined)?.role
    if (role === SECRET_ROLE) out.push(key)
  }
  return out
}

/**
 * 校验配置并填入默认值。
 * @returns 成功时给出**已填默认值**的配置；失败时给出逐条问题（message 含 `$.path` 前缀）
 */
export function validateConfig(
  schema: ConfigSchema,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; issues: ConfigIssue[] } {
  try {
    // schemastery 实例可直接调用：resolve 后返回填好默认值的值，非法则抛 ValidationError
    return { ok: true, value: (schema as (v: unknown) => unknown)(raw) }
  } catch (err) {
    const path = (err as { options?: { path?: (string | number)[] } }).options?.path
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, issues: [{ message, path }] }
  }
}

/**
 * 白名单裁剪：schemastery 的 object resolver 不剔除未知字段，
 * 这里按 schema 声明的 `dict` 递归丢弃未声明键（数组按 inner 递归）。
 */
export function pruneUnknownFields(schema: ConfigSchema, value: unknown): unknown {
  return prune(schema as SchemaLike, value)
}

function prune(schema: SchemaLike, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const inner = schema.inner
    return inner ? value.map((item) => prune(inner, item)) : value
  }
  const dict = schema.dict
  if (!dict) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const child = dict[key]
    if (!child) continue // 未声明字段：丢弃
    out[key] = prune(child, item)
  }
  return out
}

/** 汇总校验问题为一行说明（用于 ManagerError.message 与日志） */
export function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((i) => i.message).join('; ')
}
