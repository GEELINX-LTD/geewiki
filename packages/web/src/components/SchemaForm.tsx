/**
 * SchemaForm —— 由插件配置 schema 自动生成的配置表单（管理台用）。
 *
 * 只消费服务端清洗后的 `{ uid, refs }` 载荷（经 describeRoot 转成字段树），
 * 不还原 Schema 实例（见 lib/configSchema.ts 顶部的安全说明）。
 * 支持的控件：开关 / 数字（尊重 min-max-step）/ 文本 / 多行文本 / 下拉枚举 /
 * 字段组 / 列表（可增删）/ JSON 编辑框（复杂或未知类型的兜底）。
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { getByPath, setByPath, type FieldDescriptor } from '../lib/configSchema'
import type { LlmProviderOption } from '../api'

/**
 * 表单级的附加信息（写一次字段的"已配置"状态、待清除项、服务商下拉选项）。
 *
 * 为什么用 context 而不是逐层传参：`Field` 是**递归**组件（字段组/列表都会再进入
 * `Field`），把这些只在叶子用得到的值一路透传下去，会让递归签名里塞进四个与
 * "渲染这一层"无关的参数。
 */
interface FormExtras {
  /** 写一次字段是否已配置（来自 GET /config 的 secrets） */
  secrets: Record<string, boolean>
  /** 本次保存要显式清除的写一次字段名 */
  clearSecrets: string[]
  onToggleClearSecret?: (name: string) => void
  /** 服务商下拉选项（缺失 = 拉取失败，退化为纯文本输入） */
  providerOptions?: LlmProviderOption[]
  /** 模型清单 / 思考强度档位的运行期状态（见 {@link LlmFormState}） */
  llm?: LlmFormState
}

/**
 * 模型接入表单的运行期状态（由插件页 `pages/GraphPage.tsx` 的节点弹窗持有，经 context 传给两个专用控件）。
 *
 * 为什么不在控件里自己发请求：模型清单与思考强度档位是**同一次** `GET /api/llm/providers`
 * 与 `POST /api/llm/models` 的结果，控件是可能重渲染的叶子；把请求放在页面层，
 * 才做得到"打开这个插件的配置时拉一次、改端点后手动刷新"，也才有个地方显示报错。
 */
export interface LlmFormState {
  /** 思考强度的候选档位（服务端给的 `effortPresets`；只是建议，字段本身可自由填写） */
  effortPresets?: string[]
  /** 已拉到的模型清单；`undefined` = 还没拉过 */
  models?: string[]
  modelsLoading?: boolean
  /** 拉取失败的**详细**说明（错误类别 + HTTP 状态 + 上游原文，已按行拼好） */
  modelsError?: string
  /** 按表单当前草稿重新拉取清单（不必先保存） */
  onFetchModels?: () => void
}

const FormExtrasContext = createContext<FormExtras>({ secrets: {}, clearSecrets: [] })

export interface SchemaFormProps {
  /** 根字段（describeRoot 的结果） */
  root: FieldDescriptor
  /** 当前配置值（对象） */
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** 服务端逐条校验错误：字段路径（点号连接）→ 消息列表 */
  errors?: Map<string, string[]>
  /** 写一次字段（role:'secret'）是否已配置：只报有无，值永不回显 */
  secrets?: Record<string, boolean>
  /** 本次保存要显式清除的写一次字段名（区别于"留空 = 不修改"） */
  clearSecrets?: string[]
  onToggleClearSecret?: (name: string) => void
  /** 服务商下拉选项（GET /api/llm/providers）；未提供时该字段退化为纯文本 */
  providerOptions?: LlmProviderOption[]
  /** 模型清单 / 思考强度档位（`role: 'llm-model'` / `'llm-effort'` 两个字段用） */
  llm?: LlmFormState
}

function labelOf(field: FieldDescriptor): string {
  return field.label === '[]' ? '条目' : field.label
}

export function SchemaForm(props: SchemaFormProps): ReactNode {
  const { root, value, onChange, errors } = props
  const extras: FormExtras = {
    secrets: props.secrets ?? {},
    clearSecrets: props.clearSecrets ?? [],
    onToggleClearSecret: props.onToggleClearSecret,
    providerOptions: props.providerOptions,
    llm: props.llm,
  }

  if (root.kind !== 'object' || !root.fields) {
    // 根不是对象：整体退化为 JSON 编辑
    return (
      <JsonField
        label={root.label}
        value={value}
        onChange={(next) => onChange((next ?? {}) as Record<string, unknown>)}
        note={root.note}
      />
    )
  }

  if (root.fields.length === 0) {
    // 零字段 schema：插件声明了 schema 但确实没有可配置项（`@geewiki/openai` 这类
    // "只提供协议支持、配置都在别处"的插件）。显示一句实话，不留一个空壳表单。
    return <p className="muted small">本插件没有可配置项。</p>
  }

  // 主表单 / 高级项的划分：schema 上的 `.collapse()` 决定归属（见 FieldDescriptor.collapse）
  const advancedFields = root.fields.filter((f) => f.collapse === true)
  const mainFields = root.fields.filter((f) => f.collapse !== true)

  return (
    <FormExtrasContext.Provider value={extras}>
      <div className="schema-form">
        {root.description && <p className="muted small">{root.description}</p>}
        {mainFields.map((field) => (
          <Field
            key={field.label}
            field={field}
            path={[field.label]}
            value={value}
            onChange={onChange}
            errors={errors}
          />
        ))}
        {/*
         * 带 `collapse` 标记的字段（超时 / 用量 / 额外请求体 / 环境变量兜底）收进折叠区。
         * 收起来只是不挡视线——它们仍在同一份配置里，展开就能改。
         */}
        {advancedFields.length > 0 && (
          <details className="schema-advanced">
            <summary>
              高级选项（{advancedFields.length} 项，一般不用改）
            </summary>
            {advancedFields.map((field) => (
              <Field
                key={field.label}
                field={field}
                path={[field.label]}
                value={value}
                onChange={onChange}
                errors={errors}
              />
            ))}
          </details>
        )}
      </div>
    </FormExtrasContext.Provider>
  )
}

function Field(props: {
  field: FieldDescriptor
  path: (string | number)[]
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  errors?: Map<string, string[]>
}): ReactNode {
  const { field, path, value, onChange, errors } = props
  const current = getByPath(value, path)
  const set = (next: unknown): void => onChange(setByPath(value, path, next))
  const messages = errors?.get(path.join('.')) ?? []
  const fieldErrors =
    messages.length > 0 ? (
      <div className="schema-errors">
        {messages.map((m, i) => (
          <p key={i} className="err-text small">
            {/* 最后一个 emoji 图标换掉：emoji 在不同平台字形/基线不一致，且无法继承
                currentColor（错误色靠 CSS 变量随主题变）。用 lucide 图标与之对齐。 */}
            <X className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
            {m}
          </p>
        ))}
      </div>
    ) : null

  const label = (
    <label className="schema-label">
      <span>
        {labelOf(field)}
        {field.required && <em className="required"> *</em>}
      </span>
      {field.description && <span className="muted small"> {field.description}</span>}
      {field.note && <span className="muted small"> （{field.note}）</span>}
    </label>
  )

  switch (field.kind) {
    case 'switch':
      return (
        <div className="schema-field">
          <label className="schema-checkbox">
            <input type="checkbox" checked={current === true} onChange={(e) => set(e.target.checked)} />
            <span>{labelOf(field)}</span>
          </label>
          {field.description && <span className="muted small"> {field.description}</span>}
          {fieldErrors}
        </div>
      )
    case 'number':
      return (
        <div className="schema-field">
          {label}
          <input
            type="number"
            value={typeof current === 'number' ? current : ''}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {fieldErrors}
        </div>
      )
    case 'text':
    case 'textarea':
      if (field.writeOnlySecret) {
        return (
          <WriteOnlySecretField
            field={field}
            name={path[path.length - 1] as string}
            current={typeof current === 'string' ? current : ''}
            set={set}
            label={label}
            fieldErrors={fieldErrors}
          />
        )
      }
      if (field.dynamicOptions === 'llm-models') {
        return (
          <ModelComboboxField
            field={field}
            current={typeof current === 'string' ? current : ''}
            set={set}
            label={label}
            fieldErrors={fieldErrors}
          />
        )
      }
      if (field.dynamicOptions === 'llm-efforts') {
        return (
          <EffortField
            field={field}
            current={typeof current === 'string' ? current : ''}
            set={set}
            label={label}
            fieldErrors={fieldErrors}
          />
        )
      }
      if (field.dynamicOptions === 'llm-providers') {
        return (
          <ProviderSelectField
            field={field}
            current={typeof current === 'string' ? current : ''}
            set={set}
            label={label}
            fieldErrors={fieldErrors}
          />
        )
      }
      return (
        <div className="schema-field">
          {label}
          {field.kind === 'textarea' ? (
            <textarea
              rows={4}
              value={typeof current === 'string' ? current : ''}
              onChange={(e) => set(e.target.value)}
            />
          ) : (
            <input
              type={field.secret ? 'password' : 'text'}
              autoComplete={field.secret ? 'new-password' : undefined}
              value={typeof current === 'string' ? current : ''}
              onChange={(e) => set(e.target.value)}
            />
          )}
          {fieldErrors}
        </div>
      )
    case 'select': {
      const options = field.options ?? []
      const matched = options.find((o) => JSON.stringify(o.value) === JSON.stringify(current))
      return (
        <div className="schema-field">
          {label}
          <select
            value={matched ? JSON.stringify(matched.value) : ''}
            onChange={(e) => {
              const picked = options.find((o) => JSON.stringify(o.value) === e.target.value)
              set(picked ? picked.value : undefined)
            }}
          >
            <option value="">（未设置）</option>
            {options.map((o) => (
              <option key={JSON.stringify(o.value)} value={JSON.stringify(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
          {fieldErrors}
        </div>
      )
    }
    case 'object': {
      return (
        <fieldset className="schema-group">
          <legend>
            {labelOf(field)}
            {field.description && <span className="muted small"> {field.description}</span>}
          </legend>
          {(field.fields ?? []).map((sub) => (
            <Field
              key={sub.label}
              field={sub}
              path={[...path, sub.label]}
              value={value}
              onChange={onChange}
              errors={errors}
            />
          ))}
          {fieldErrors}
        </fieldset>
      )
    }
    case 'list':
      return (
        <ListField
          field={field}
          path={path}
          value={value}
          onChange={onChange}
          errors={errors}
          header={label}
          footer={fieldErrors}
        />
      )
    case 'json':
      return (
        <div className="schema-field">
          {label}
          <JsonField
            label={labelOf(field)}
            value={current}
            onChange={(next) => set(next)}
            note={field.note}
          />
          {fieldErrors}
        </div>
      )
    case 'hidden':
      // S-13：hidden 字段**不渲染**（值仍由 schema 默认值填充，不提供编辑入口）
      return null
    case 'static':
      return (
        <div className="schema-field">
          {label}
          <span className="muted small">{JSON.stringify(current ?? field.default ?? null)}</span>
        </div>
      )
    default:
      return (
        <div className="schema-field">
          {label}
          <JsonField label={labelOf(field)} value={current} onChange={(next) => set(next)} note={field.note} />
          {fieldErrors}
        </div>
      )
  }
}

/**
 * **写一次、不可回读**的字段（schema `role: 'secret'`，如模型 API 密钥）。
 *
 * 语义由服务端保证（见 packages/manager/src/secrets.ts）：值不写进 plugins.*.json、
 * 任何响应都不回显。因此界面只有三种状态：
 * - 未配置 → 空输入框，填了就保存；
 * - 已配置 → 空输入框 + 占位提示"留空 = 不修改"，**永远不回显旧值**（要改只能填新的）；
 * - 待清除 → 勾选后输入框禁用，保存时经 `clearSecrets` 显式清除。
 *
 * 为什么要单独一个"清除"动作：如果把空串当成清除，那么用户每改一次同一表单里的
 * 别的字段（如模型名），都会顺手把密钥删掉 —— 而输入框看起来什么都没变。
 */
function WriteOnlySecretField(props: {
  field: FieldDescriptor
  name: string
  current: string
  set: (next: unknown) => void
  label: ReactNode
  fieldErrors: ReactNode
}): ReactNode {
  const extras = useContext(FormExtrasContext)
  const configured = extras.secrets[props.name] === true
  const pendingClear = extras.clearSecrets.includes(props.name)
  return (
    <div className="schema-field">
      {props.label}
      <input
        type="password"
        autoComplete="new-password"
        disabled={pendingClear}
        placeholder={configured ? '已配置（留空 = 不修改；填新值即替换）' : '未配置（填写后保存）'}
        value={pendingClear ? '' : props.current}
        onChange={(e) => props.set(e.target.value)}
      />
      {configured && extras.onToggleClearSecret && (
        <label className="schema-checkbox">
          <input
            type="checkbox"
            checked={pendingClear}
            onChange={() => extras.onToggleClearSecret?.(props.name)}
          />
          <span className="muted small">清除已保存的值（保存后生效）</span>
        </label>
      )}
      {props.fieldErrors}
    </div>
  )
}

/**
 * 服务商下拉（schema `role: 'llm-provider'`）：选项来自**运行期注册**的适配器插件。
 *
 * 不把选项写死在 schema 里是刻意的：装了 `@geewiki/deepseek` 就多一个选项，
 * 这件事不该需要改任何代码或配置。列表取不到（接口失败/未启用任何适配器）时
 * **退化为纯文本输入**并把话说清楚，而不是给一个只有"（自动）"一项的假下拉。
 */
function ProviderSelectField(props: {
  field: FieldDescriptor
  current: string
  set: (next: unknown) => void
  label: ReactNode
  fieldErrors: ReactNode
}): ReactNode {
  const extras = useContext(FormExtrasContext)
  const options = extras.providerOptions
  if (!options) {
    return (
      <div className="schema-field">
        {props.label}
        <input
          type="text"
          value={props.current}
          placeholder="如 openai（未取到服务商列表，可手工填写）"
          onChange={(e) => props.set(e.target.value)}
        />
        {props.fieldErrors}
      </div>
    )
  }
  const selected = options.find((o) => o.id === props.current)
  const unregistered = props.current !== '' && selected === undefined
  return (
    <div className="schema-field">
      {props.label}
      <select value={props.current} onChange={(e) => props.set(e.target.value)}>
        <option value="">（自动：使用第一个可用的服务商）</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}（{o.id}）
            {o.available ? '' : ' — 当前不可用'}
          </option>
        ))}
        {unregistered && (
          <option value={props.current}>{props.current}（未注册，可能是已停用的适配器）</option>
        )}
      </select>
      {options.length === 0 ? (
        <p className="muted small">
          尚未启用任何模型服务商插件：请在下方启用 <code>@geewiki/openai</code> 等适配器后回来选择。
        </p>
      ) : (
        selected && (
          <p className="muted small">
            {selected.description}
            {selected.defaults.baseUrl ? ` 默认端点：${selected.defaults.baseUrl}` : ''}
            {selected.defaults.model ? `；默认模型：${selected.defaults.model}` : ''}
          </p>
        )
      )}
      {props.fieldErrors}
    </div>
  )
}

/** 列表字段：条目用**稳定 key**（用数组下标作 key 时，删除中间项会让后续条目的输入框复用错位） */
function ListField(props: {
  field: FieldDescriptor
  path: (string | number)[]
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  errors?: Map<string, string[]>
  header: ReactNode
  footer: ReactNode
}): ReactNode {
  const { field, path, value, onChange, errors, header, footer } = props
  const current = getByPath(value, path)
  const items = Array.isArray(current) ? current : []
  const idsRef = useRef<string[]>([])
  // 与外部值同步：仅按长度补齐/截断。增删都经本组件内的按钮完成，
  // 对应 id 会被精确增删，因此不需要按内容做 diff。
  if (idsRef.current.length !== items.length) {
    const next = idsRef.current.slice(0, items.length)
    while (next.length < items.length) next.push(nextItemKey())
    idsRef.current = next
  }
  const ids = idsRef.current
  const removeAt = (index: number): void => {
    idsRef.current = ids.filter((__, i) => i !== index)
    onChange(setByPath(value, path, items.filter((__, i) => i !== index)))
  }

  return (
    <div className="schema-field">
      {header}
      <div className="schema-list">
        {items.map((_, index) => (
          <div key={ids[index]} className="schema-list-item">
            {field.item && (
              <Field
                field={{ ...field.item, label: `${labelOf(field)}[${index}]` }}
                path={[...path, index]}
                value={value}
                onChange={onChange}
                errors={errors}
              />
            )}
            <button className="btn small ghost" onClick={() => removeAt(index)}>
              删除
            </button>
          </div>
        ))}
        <button
          className="btn small"
          onClick={() => {
            const template = field.item?.default
            idsRef.current = [...ids, nextItemKey()]
            onChange(
              setByPath(value, path, [...items, template === undefined ? scalarPlaceholder(field.item) : template]),
            )
          }}
        >
          ＋ 添加条目
        </button>
      </div>
      {footer}
    </div>
  )
}

let itemKeySeq = 0
/** 列表条目的稳定 key 生成器（仅需组件生命周期内唯一） */
function nextItemKey(): string {
  itemKeySeq += 1
  return `item-${itemKeySeq}`
}

/** 新建列表条目时的初始值（按元素控件类型给出） */
function scalarPlaceholder(item?: FieldDescriptor): unknown {
  switch (item?.kind) {
    case 'number':
      return 0
    case 'switch':
      return false
    case 'text':
    case 'textarea':
    case 'select':
      return ''
    default:
      return {}
  }
}

/** JSON 编辑框：内部保留原始文本，允许中途输入非法 JSON */
function JsonField(props: {
  label: string
  value: unknown
  onChange: (next: unknown) => void
  note?: string
}): ReactNode {
  const [text, setText] = useState(() => (props.value === undefined ? '' : JSON.stringify(props.value, null, 2)))
  const [invalid, setInvalid] = useState(false)
  // 上一次由本框**自己**解析上报的值：用来区分"自身输入"与"外部变化"。
  // 自身输入不回填文本（否则每敲一个字符都会重置光标）；外部变化（切换插件、
  // 服务端返回新配置）必须回填，否则编辑框会停留在上一个插件的文本上。
  const lastEmitted = useRef<unknown>(undefined)
  useEffect(() => {
    if (Object.is(props.value, lastEmitted.current)) return
    lastEmitted.current = props.value
    setText(props.value === undefined ? '' : JSON.stringify(props.value, null, 2))
    setInvalid(false)
  }, [props.value])
  return (
    <div className="schema-json">
      {props.note && <p className="muted small">{props.note}</p>}
      <textarea
        rows={4}
        spellCheck={false}
        aria-label={props.label}
        value={text}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          if (next.trim() === '') {
            lastEmitted.current = undefined
            setInvalid(false)
            props.onChange(undefined)
            return
          }
          try {
            const parsed: unknown = JSON.parse(next)
            lastEmitted.current = parsed
            props.onChange(parsed)
            setInvalid(false)
          } catch {
            setInvalid(true)
          }
        }}
        placeholder="{ }"
      />
      {invalid && <p className="err-text small">JSON 语法错误（尚未提交）</p>}
    </div>
  )
}

/**
 * 模型名输入框（schema `role: 'llm-model'`）：**下拉 + 手填**同一个框。
 *
 * 用 `<input list>` + `<datalist>` 而不是 `<select>`：模型清单来自端点自己
 * （`POST /api/llm/models`），而清单永远可能不全——灰度模型、私有别名、刚上线的
 * 新版本都在清单之外。收成 select 会变成"清单里没有就用不了"，那比没有下拉更糟。
 *
 * 「获取模型」按**表单当前草稿**去拉（含没保存的 baseUrl / apiKey）：先填端点密钥、
 * 再挑模型是自然顺序，不该逼用户先保存一次才能看到有哪些模型。
 */
function ModelComboboxField(props: {
  field: FieldDescriptor
  current: string
  set: (next: unknown) => void
  label: ReactNode
  fieldErrors: ReactNode
}): ReactNode {
  const { llm } = useContext(FormExtrasContext)
  const listId = `llm-models-${props.field.label}`
  const models = llm?.models
  const notInList = models !== undefined && props.current !== '' && !models.includes(props.current)
  return (
    <div className="schema-field">
      {props.label}
      <div className="schema-inline">
        <input
          type="text"
          list={listId}
          value={props.current}
          placeholder={models === undefined ? '如 deepseek-chat（可点右侧按钮读取清单）' : '清单外的模型也可直接手填'}
          onChange={(e) => props.set(e.target.value)}
        />
        <button type="button" disabled={llm?.modelsLoading === true} onClick={() => llm?.onFetchModels?.()}>
          {llm?.modelsLoading === true ? '读取中…' : '获取模型'}
        </button>
      </div>
      <datalist id={listId}>
        {(models ?? []).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {models !== undefined && models.length > 0 && (
        <p className="muted small">
          清单里有 {models.length} 个模型；下拉只是建议，手填的值原样使用。
        </p>
      )}
      {notInList && (
        <p className="muted small">「{props.current}」不在刚取到的清单里，将按你填的名字请求。</p>
      )}
      {/* 失败详情整块显示（不塞进 placeholder）：网关的报错原文往往是定位的唯一线索 */}
      {llm?.modelsError && <pre className="probe-detail err-text">{llm.modelsError}</pre>}
      {props.fieldErrors}
    </div>
  )
}

/** 兜底档位：只在 `/api/llm/providers` 没拉到（或未返回该字段）时用；正常情况以服务端清单为准 */
const EFFORT_FALLBACK_PRESETS = ['off', 'low', 'medium', 'high']

/**
 * 思考强度（schema `role: 'llm-effort'`）：档位下拉 **+ 自定义**。
 *
 * 为什么不干脆是个自由文本框：绝大多数网关就是 off/low/medium/high 四档，
 * 给个下拉能少打错字；但收成封闭枚举会把"用自家网关的私有档位
 * （minimal / extra-high / enabled…）"变成一件要改代码的事。
 * 于是选了「下拉里带一项自定义…」——当前值不在档位表中时**自动**切到自定义，
 * 这样从配置里读回来的私有值不会被下拉框悄悄吞掉。
 */
function EffortField(props: {
  field: FieldDescriptor
  current: string
  set: (next: unknown) => void
  label: ReactNode
  fieldErrors: ReactNode
}): ReactNode {
  const { llm } = useContext(FormExtrasContext)
  const presets = llm?.effortPresets ?? EFFORT_FALLBACK_PRESETS
  /** 用户显式点了「自定义…」时强制显示输入框（此时值还是空的，不能靠"不在清单里"判断） */
  const [forced, setForced] = useState(false)
  const isPreset = props.current === '' || presets.includes(props.current)
  const showCustom = forced || !isPreset
  /**
   * `'off'` 与空串在语义上是**同一件事**（都不下发该参数，服务端解析时也归并为一者），
   * 但存量配置里存的是 `'off'`：直接当"未匹配"处理会让下拉显示成空白、
   * 并把一个本来正常的值误判成"自定义"。所以下拉里两者合并成第一项。
   */
  const selected = props.current === 'off' ? '' : props.current

  return (
    <div className="schema-field">
      {props.label}
      <select
        value={showCustom ? '__custom__' : selected}
        onChange={(e) => {
          const picked = e.target.value
          if (picked === '__custom__') {
            setForced(true)
            if (isPreset) props.set('')
            return
          }
          setForced(false)
          props.set(picked)
        }}
      >
        <option value="">（不下发思考参数）</option>
        {presets
          .filter((p) => p !== 'off')
          .map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        <option value="__custom__">自定义…（原样作为 reasoning_effort 下发）</option>
      </select>
      {showCustom && (
        <input
          type="text"
          autoFocus
          value={props.current}
          placeholder="如 minimal / extra-high（服务商自己的档位名）"
          onChange={(e) => props.set(e.target.value)}
        />
      )}
      <p className="muted small">
        留空或选 off 都不发该参数；自定义值原样作为 <code>reasoning_effort</code> 发给上游。
      </p>
      {props.fieldErrors}
    </div>
  )
}
