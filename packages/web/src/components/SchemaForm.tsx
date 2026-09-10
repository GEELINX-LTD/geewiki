/**
 * SchemaForm —— 由插件配置 schema 自动生成的配置表单（管理台用）。
 *
 * 只消费服务端清洗后的 `{ uid, refs }` 载荷（经 describeRoot 转成字段树），
 * 不还原 Schema 实例（见 lib/configSchema.ts 顶部的安全说明）。
 * 支持的控件：开关 / 数字（尊重 min-max-step）/ 文本 / 多行文本 / 下拉枚举 /
 * 字段组 / 列表（可增删）/ JSON 编辑框（复杂或未知类型的兜底）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { getByPath, setByPath, type FieldDescriptor } from '../lib/configSchema'

export interface SchemaFormProps {
  /** 根字段（describeRoot 的结果） */
  root: FieldDescriptor
  /** 当前配置值（对象） */
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** 服务端逐条校验错误：字段路径（点号连接）→ 消息列表 */
  errors?: Map<string, string[]>
}

function labelOf(field: FieldDescriptor): string {
  return field.label === '[]' ? '条目' : field.label
}

export function SchemaForm(props: SchemaFormProps): ReactNode {
  const { root, value, onChange, errors } = props

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

  return (
    <div className="schema-form">
      {root.description && <p className="muted small">{root.description}</p>}
      {root.fields.map((field) => (
        <Field
          key={field.label}
          field={field}
          path={[field.label]}
          value={value}
          onChange={onChange}
          errors={errors}
        />
      ))}
    </div>
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
