/**
 * 配置 schema 载荷 → 表单字段描述（纯函数，与 React 解耦）。
 *
 * 载荷形态（由服务端经 sanitizeSchemaPayload 下发）：`{ uid, refs }`，
 * refs 是 **uid 字符串 → 节点** 的映射（不是数组），节点上没有 uid 字段。
 * 字段间引用（dict 的值 / list 的元素 / inner / sKey）全部是数字 uid。
 *
 * 安全约定：前端**只读图渲染**，绝不把载荷还原成 Schema 实例
 * （schemastery 的反序列化会执行节点里的 callback 源码字符串）。
 *
 * 判定顺序：meta.role 优先 → node.type → 结构字段（dict / inner / list）。
 */
import type { ConfigSchemaNode, ConfigSchemaPayload } from '../api'

/** 表单控件种类（`hidden` = 不渲染，仅保留默认值，见 S-13） */
export type FieldKind =
  | 'switch'
  | 'number'
  | 'text'
  | 'textarea'
  | 'select'
  | 'object'
  | 'list'
  | 'json'
  | 'static'
  | 'hidden'
  | 'unsupported'

export interface SelectOption {
  /** 原始取值（const 节点的 value，可能是字符串/数字/布尔） */
  value: unknown
  /** 展示标签（const 节点的 description，缺省取 String(value)） */
  label: string
}

export interface FieldDescriptor {
  kind: FieldKind
  /** 字段名（父 dict 的键名；数组元素为 [i]） */
  label: string
  /** 说明文字（meta.description，可能是 locale 字典） */
  description?: string
  /** 是否必填（meta.required） */
  required?: boolean
  /** 默认值（meta.default；object/array 由 schemastery 自动注入 {} / []） */
  default?: unknown
  /* number 专用 */
  min?: number
  max?: number
  step?: number
  /* select 专用 */
  options?: SelectOption[]
  /* object 专用 */
  fields?: FieldDescriptor[]
  /* list 专用 */
  item?: FieldDescriptor
  /** 降级为 JSON 编辑的原因（用于界面提示） */
  note?: string
  /** 敏感值（meta.role === 'password'）：用密码输入框，不明文回显 */
  secret?: boolean
  /**
   * **写一次、不可回读**（meta.role === 'secret'）：
   * 值由服务端单独保管，`GET /config` 恒返回空串 + `secrets[label]` 报"是否已配置"。
   * 界面语义：留空 = 不修改，填新值 = 替换，另有显式的"清除"动作。
   */
  writeOnlySecret?: boolean
  /** 选项由**运行期数据**决定（模型服务商 / 模型清单 / 思考强度档位） */
  dynamicOptions?: DynamicOptions
  /**
   * 收进折叠的「高级选项」区（schema 上的 `.collapse()`）。
   *
   * 它是**渲染期**的分组，不是数据形状：配置项嵌进嵌套对象会被 cordis 按 schema
   * 裁掉未声明的顶层键，等于让存量部署里的该项静默失效——所以"少显示几项"必须由
   * 界面来做，不能靠改配置结构。
   */
  collapse?: boolean
}

/** 动态选项来源（schema `meta.role` 的取值 → 数据源） */
export type DynamicOptions = 'llm-providers' | 'llm-models' | 'llm-efforts'

/** 字符串字段的角色 → 控件/数据源；其余角色只在界面标注 `role=…` 提示 */
const KNOWN_ROLES = new Set(['textarea', 'password', 'secret', 'llm-provider', 'llm-model', 'llm-effort'])

/**
 * `role` → 动态选项来源。
 *
 * 三者都**不是**封闭枚举：服务商来自运行期注册的插件，模型清单来自端点自己，
 * 思考强度只是建议档位——所以下拉之外一律还能手填（见 SchemaForm 里的三个专用控件）。
 */
const ROLE_DYNAMIC_OPTIONS: Record<string, DynamicOptions> = {
  'llm-provider': 'llm-providers',
  'llm-model': 'llm-models',
  'llm-effort': 'llm-efforts',
}

/** 最大递归深度（schema 允许 lazy 自引用与 DAG 共享，必须设上限） */
const MAX_DEPTH = 8

/** 取说明文字：meta.description 可能是 locale 字典（含 "" 兜底键） */
export function describeText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const dict = value as Record<string, unknown>
    const fallback = dict[''] ?? dict['zh-CN'] ?? Object.values(dict)[0]
    if (typeof fallback === 'string') return fallback
  }
  return undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把载荷节点描述为表单字段。
 * @param refs  载荷的 refs 表
 * @param uid   节点 uid
 * @param label 字段标签（父 dict 的键名）
 */
export function describeNode(
  refs: Record<string, ConfigSchemaNode>,
  uid: number,
  label: string,
  seen: ReadonlySet<number> = new Set<number>(),
  depth = 0,
): FieldDescriptor {
  const node = refs[String(uid)]
  if (!node) return { kind: 'unsupported', label, note: `schema 节点缺失（uid=${uid}）` }
  const meta = node.meta ?? {}
  const description = describeText(meta['description'])
  const base: FieldDescriptor = {
    kind: 'json',
    label,
    description,
    required: meta['required'] === true,
    default: meta['default'],
    collapse: meta['collapse'] === true || undefined,
  }

  // S-13：hidden 字段**不渲染**（仅保留 schema 默认值），不是只读展示
  if (meta['hidden'] === true) return { ...base, kind: 'hidden' }
  if (seen.has(uid) || depth > MAX_DEPTH) {
    return { ...base, kind: 'json', note: '递归或共享的 schema 节点，改以 JSON 编辑' }
  }
  const nextSeen = new Set(seen).add(uid)
  const child = (childUid: number, childLabel: string): FieldDescriptor =>
    describeNode(refs, childUid, childLabel, nextSeen, depth + 1)

  const role = typeof meta['role'] === 'string' ? meta['role'] : undefined

  switch (node.type) {
    case 'boolean':
      return { ...base, kind: 'switch' }
    case 'number':
      return {
        ...base,
        kind: 'number',
        min: asNumber(meta['min']),
        max: asNumber(meta['max']),
        step: asNumber(meta['step']),
      }
    case 'string': {
      // role=password → 密码输入框（否则密钥会明文回显在管理台）
      // role=secret   → 密码输入框 **且**服务端不回显（写一次、不可回读）
      // role=llm-provider → 下拉，选项来自运行期注册的适配器（不写死在 schema 里，
      //                     否则"装了 @geewiki/deepseek 就多一个选项"必须改代码）
      const writeOnly = role === 'secret'
      return {
        ...base,
        kind: role === 'textarea' ? 'textarea' : 'text',
        secret: role === 'password' || writeOnly,
        writeOnlySecret: writeOnly || undefined,
        dynamicOptions: role !== undefined ? ROLE_DYNAMIC_OPTIONS[role] : undefined,
        note: role && !KNOWN_ROLES.has(role) ? `role=${role}` : undefined,
      }
    }
    case 'const':
      return { ...base, kind: 'static' }
    case 'any':
      return { ...base, kind: 'json' }
    case 'object': {
      const dict = node.dict ?? {}
      return {
        ...base,
        kind: 'object',
        fields: Object.entries(dict).map(([key, childUid]) => child(childUid, key)),
      }
    }
    case 'array': {
      if (node.inner === undefined) return { ...base, kind: 'json', note: '数组缺少元素 schema' }
      return { ...base, kind: 'list', item: child(node.inner, '[]') }
    }
    case 'union': {
      const list = node.list ?? []
      const branches = list.map((u) => refs[String(u)])
      if (list.length > 0 && branches.every((b) => b?.type === 'const')) {
        return {
          ...base,
          kind: 'select',
          options: list.map((u) => {
            const b = refs[String(u)]
            return { value: b?.value, label: describeText(b?.meta?.['description']) ?? String(b?.value) }
          }),
        }
      }
      return { ...base, kind: 'json', note: '联合类型（非枚举）改以 JSON 编辑' }
    }
    case 'transform':
    case 'lazy': {
      if (node.inner === undefined) return { ...base, kind: 'json' }
      const inner = child(node.inner, label)
      // transform 的取值经 callback 变换，表单只编辑其内层原值
      return { ...inner, description: description ?? inner.description }
    }
    case 'dict':
    case 'tuple':
    case 'intersect':
    case 'bitset':
    case 'is':
    case 'function':
    case 'never':
      return { ...base, kind: 'json', note: `${node.type} 类型改以 JSON 编辑` }
    default:
      return { ...base, kind: 'json', note: node.type ? `未知类型 ${node.type}` : '缺少类型标记' }
  }
}

/** 描述根节点（配置对象） */
export function describeRoot(schema: ConfigSchemaPayload): FieldDescriptor {
  return describeNode(schema.refs, schema.uid, '配置')
}

/* ---------------------------- 取值读写辅助 ---------------------------- */

/** 按路径读取配置值 */
export function getByPath(root: Record<string, unknown>, path: readonly (string | number)[]): unknown {
  let current: unknown = root
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[key]
  }
  return current
}

/** 不可变写入：返回沿路径复制后的新配置对象（未改动的分支保持同一引用） */
export function setByPath(
  root: Record<string, unknown>,
  path: readonly (string | number)[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return (value ?? {}) as Record<string, unknown>
  const [head, ...rest] = path as (string | number)[]
  const key = String(head)
  const clone: Record<string, unknown> = { ...root }
  const current = clone[key]
  if (rest.length === 0) {
    if (value === undefined) delete clone[key]
    else clone[key] = value
    return clone
  }
  if (typeof head === 'number' || Array.isArray(current)) {
    const list = Array.isArray(current) ? [...current] : []
    const idx = Number(head)
    const nested = (list[idx] ?? {}) as Record<string, unknown>
    list[idx] = setByPath(nested, rest, value)
    clone[key] = list
    return clone
  }
  clone[key] = setByPath((current ?? {}) as Record<string, unknown>, rest, value)
  return clone
}

/**
 * 该字段树里是否存在某个动态选项来源（管理台据此决定"要不要去拉一次服务商列表"）。
 *
 * 放在纯函数层而不是 React 组件里：组件只负责渲染，不负责判断要不要发请求 ——
 * 否则"哪个角色需要联网"这条信息会散落在组件与载荷两处。
 */
export function hasDynamicOptions(root: FieldDescriptor, kind: DynamicOptions): boolean {
  if (root.dynamicOptions === kind) return true
  if (root.item && hasDynamicOptions(root.item, kind)) return true
  return (root.fields ?? []).some((f) => hasDynamicOptions(f, kind))
}
