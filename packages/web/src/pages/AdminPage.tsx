import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, type ConfigIssue, type ListEntry, type PluginInfo, type SessionState } from '../api'
import { SchemaForm } from '../components/SchemaForm'
import { describeRoot, type FieldDescriptor } from '../lib/configSchema'

function fmtError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 把后端 invalid_config 的逐条问题按字段路径归并（供表单就地展示） */
function issuesToMap(issues: readonly ConfigIssue[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const issue of issues) {
    const key = (issue.path ?? []).join('.')
    map.set(key, [...(map.get(key) ?? []), issue.message])
  }
  return map
}

/**
 * 解析"JSON 原文"配置编辑框（未声明 configSchema 的插件走这条通道）。
 * 空文本视为 `{}`；非对象（数组/标量）与语法错误都给出明确提示且**不发请求**。
 */
function parseConfigText(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, message: `配置不是合法 JSON: ${(err as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '配置必须是 JSON 对象（不能是数组或标量）' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

const STATE_LABEL: Record<PluginInfo['state'], string> = { active: '运行中', inactive: '未启用', error: '异常' }
const LAYER_LABEL: Record<string, string> = { base: '基础层', session: '会话层' }
const SOURCE_LABEL: Record<string, string> = { builtin: '内置', external: '外部' }

/** 配置编辑器状态：descriptor 为 null 表示插件未声明 schema（退回 JSON 编辑框） */
interface ConfigEditorState {
  name: string
  loading: boolean
  descriptor: FieldDescriptor | null
  value: Record<string, unknown>
  /** 配置的持久化层（存在哪个清单里）；null = 尚未得知 */
  layer: 'base' | 'session' | null
  /** 插件的激活层（未激活为 null） */
  activeLayer: 'base' | 'session' | null
}

export function AdminPage(): ReactNode {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')
  const [editor, setEditor] = useState<ConfigEditorState | null>(null)
  const [configErrors, setConfigErrors] = useState<Map<string, string[]>>(new Map())

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.plugins(), api.session()])
      setPlugins(p.plugins)
      setSession(s)
    } catch (err) {
      setNotice({ kind: 'err', text: `加载失败: ${fmtError(err)}` })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>, successMsg: string) => {
      setBusy(label)
      setNotice(null)
      try {
        await fn()
        setNotice({ kind: 'ok', text: successMsg })
        await load()
      } catch (err) {
        setNotice({ kind: 'err', text: fmtError(err) })
      } finally {
        setBusy('')
      }
    },
    [load],
  )

  const openConfig = (p: PluginInfo): void => {
    if (configFor === p.name) {
      setConfigFor(null)
      setEditor(null)
      return
    }
    setConfigFor(p.name)
    setConfigErrors(new Map())
    setConfigText(p.config ? JSON.stringify(p.config, null, 2) : '')
    setEditor({ name: p.name, loading: true, descriptor: null, value: p.config ?? {}, layer: null, activeLayer: null })
    // 拉取清洗后的 schema 载荷与当前生效配置；插件未声明 schema 时退回 JSON 编辑
    void api
      .pluginConfig(p.name)
      .then((res) => {
        setEditor({
          name: p.name,
          loading: false,
          descriptor: res.schema ? describeRoot(res.schema) : null,
          value: res.config ?? {},
          layer: res.layer ?? null,
          activeLayer: res.activeLayer ?? null,
        })
        // JSON 原文通道以服务端值回填（descriptor 分支由 SchemaForm 自己渲染值）
        if (!res.schema) setConfigText(JSON.stringify(res.config ?? {}, null, 2))
      })
      .catch((err: unknown) => {
        setEditor({ name: p.name, loading: false, descriptor: null, value: p.config ?? {}, layer: null, activeLayer: null })
        setNotice({ kind: 'err', text: `读取配置失败: ${fmtError(err)}` })
      })
  }

  const confirmEnable = (p: PluginInfo): void => {
    let config: Record<string, unknown> | undefined
    if (editor?.name === p.name && editor.descriptor) {
      config = editor.value
    } else if (configFor === p.name && configText.trim()) {
      // 与"保存配置"共用同一套解析+报错逻辑（无 schema 插件走 JSON 原文）
      const parsed = parseConfigText(configText)
      if (!parsed.ok) {
        setNotice({ kind: 'err', text: parsed.message })
        return
      }
      config = parsed.value
    }
    void act('enable', () => api.enable(p.name, config), `已启用 ${p.name}`)
    setConfigFor(null)
    setEditor(null)
  }

  /** 保存配置（PUT /config）：已激活插件热更新，未激活仅落盘（requiresRestart） */
  const saveConfig = useCallback(
    async (p: PluginInfo): Promise<void> => {
      if (!editor || editor.name !== p.name) return
      setBusy('config')
      setNotice(null)
      setConfigErrors(new Map())
      try {
        // 无 schema 插件提交的是 JSON 编辑框解析结果（而不是服务端返回的原值，
        // 否则用户编辑会被静默丢弃）；解析失败时已提前 return，不发请求
        let payload = editor.value
        if (!editor.descriptor) {
          const parsed = parseConfigText(configText)
          if (!parsed.ok) {
            setNotice({ kind: 'err', text: parsed.message })
            return
          }
          payload = parsed.value
        }
        const res = await api.updatePluginConfig(p.name, payload)
        setNotice({
          kind: 'ok',
          text: res.hotUpdated
            ? `已保存并热更新 ${p.name} 的配置`
            : `已保存 ${p.name} 的配置（${res.requiresRestart ? '插件未激活，配置已落盘，重新启用后生效' : '下次启动生效'}）`,
        })
        await load()
      } catch (err) {
        if (err instanceof ApiError && err.code === 'invalid_config') {
          const details = err.details as { issues?: ConfigIssue[] } | undefined
          setConfigErrors(issuesToMap(details?.issues ?? []))
        }
        setNotice({ kind: 'err', text: fmtError(err) })
      } finally {
        setBusy('')
      }
    },
    [configText, editor, load],
  )

  const counts = plugins
    ? plugins.reduce(
        (acc, p) => {
          acc[p.state]++
          return acc
        },
        { active: 0, inactive: 0, error: 0 } as Record<PluginStateKey, number>,
      )
    : null

  type PluginStateKey = 'active' | 'inactive' | 'error'

  const sessionChanges = session?.session.enabled ?? []
  const canPersist = sessionChanges.length > 0

  return (
    <div className="page">
      <div className="page-head">
        <h1>插件管理</h1>
        <div className="page-actions">
          {notice && <span className={`notice ${notice.kind}`}>{notice.text}</span>}
          <button className="btn" onClick={() => void load()} disabled={busy !== ''}>
            ↻ 刷新
          </button>
        </div>
      </div>

      {counts && (
        <div className="stat-bar">
          <span className="stat active">● {counts.active} 运行中</span>
          <span className="stat inactive">○ {counts.inactive} 未启用</span>
          {counts.error > 0 && <span className="stat err">✕ {counts.error} 异常</span>}
          <span className="stat hint">热操作作用于会话层，立即生效、无需重启</span>
        </div>
      )}

      <section className="card">
        <table className="table">
          <thead>
            <tr>
              <th>插件</th>
              <th>版本</th>
              <th>状态</th>
              <th>所在层</th>
              <th>热插拔</th>
              <th>提供服务</th>
              <th>依赖</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {plugins === null && (
              <tr>
                <td colSpan={8} className="empty">加载中…</td>
              </tr>
            )}
            {plugins?.map((p) => (
              <PluginRow
                key={p.name}
                p={p}
                busy={busy}
                configOpen={configFor === p.name}
                configText={configText}
                editor={editor?.name === p.name ? editor : null}
                configErrors={configErrors}
                onConfigText={setConfigText}
                onEditorChange={(next) => setEditor((prev) => (prev ? { ...prev, value: next } : prev))}
                onOpenConfig={() => openConfig(p)}
                onEnable={() => confirmEnable(p)}
                onSaveConfig={() => void saveConfig(p)}
                onDisable={() =>
                  void act('disable', () => api.disable(p.name), `已停用 ${p.name}（会话变更已保存）`)
                }
              />
            ))}
          </tbody>
        </table>
      </section>

      <section className="card session-card">
        <div className="session-head">
          <h2>会话变更（Session Layer）</h2>
          <div className="session-actions">
            <button className="btn primary" disabled={!canPersist || busy !== ''} onClick={() => void act('persist', api.persist, '已应用并持久化：会话变更合并进基础层')}>
              应用并持久化
            </button>
          </div>
        </div>
        <p className="muted">
          会话层变更即时生效、重启即失；<strong>应用并持久化</strong> 将当前会话变更合并入
          <code>plugins.base.json</code> 并清空会话。
        </p>
        {sessionChanges.length === 0 ? (
          <p className="empty">当前无未持久化的会话变更</p>
        ) : (
          <ul className="session-list">
            {sessionChanges.map((e) => (
              <li key={e.name}>
                <code>{e.name}</code>
                {e.config && Object.keys(e.config).length > 0 && <span className="muted"> {JSON.stringify(e.config)}</span>}
                <span className="badge badge-session">会话层</span>
              </li>
            ))}
          </ul>
        )}
        {session && session.bootErrors.length > 0 && (
          <div className="boot-errors">
            <h3>启动错误（bootErrors）</h3>
            {session.bootErrors.map((e, i) => (
              <p key={i} className="err-text">✕ {e}</p>
            ))}
          </div>
        )}
        {session && session.base.enabled.length > 0 && (
          <details className="base-details">
            <summary>基础层清单 plugins.base.json（{session.base.enabled.length}）</summary>
            <ul className="session-list">
              {session.base.enabled.map((e: ListEntry) => (
                <li key={e.name}>
                  <code>{e.name}</code>
                  {e.config && Object.keys(e.config).length > 0 && <span className="muted"> {JSON.stringify(e.config)}</span>}
                  <span className="badge badge-base">基础层</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  )
}

function PluginRow(props: {
  p: PluginInfo
  busy: string
  configOpen: boolean
  configText: string
  editor: ConfigEditorState | null
  configErrors: Map<string, string[]>
  onConfigText: (v: string) => void
  onEditorChange: (next: Record<string, unknown>) => void
  onOpenConfig: () => void
  onEnable: () => void
  onSaveConfig: () => void
  onDisable: () => void
}): ReactNode {
  const { p, busy, configOpen, configText, editor, configErrors, onConfigText, onEditorChange, onOpenConfig, onEnable, onSaveConfig, onDisable } = props
  const hot = p.hotReloadable
  return (
    <>
      <tr className={p.state === 'error' ? 'row-error' : ''}>
        <td>
          <div className="plugin-name">
            {p.name}
            {p.source && (
              <span className={`badge ${p.source === 'external' ? 'badge-external' : 'badge-builtin'}`} title="插件来源">
                {SOURCE_LABEL[p.source]}
              </span>
            )}
          </div>
          {p.migrations && <div className="muted small">迁移: {p.migrations}</div>}
        </td>
        <td>{p.version}</td>
        <td>
          <span className={`badge badge-${p.state}`}>
            {p.state === 'active' ? '●' : p.state === 'error' ? '✕' : '○'} {STATE_LABEL[p.state]}
          </span>
          {p.state === 'error' && p.error && <div className="err-text small">{p.error}</div>}
        </td>
        <td>{p.layer ? <span className={`badge badge-${p.layer}`}>{LAYER_LABEL[p.layer]}</span> : <span className="muted">—</span>}</td>
        <td>
          <span className={`badge ${hot ? 'badge-hot' : 'badge-cold'}`}>{hot ? '热' : '冷'}</span>
        </td>
        <td>{p.provides ? <code className="chip">{p.provides}</code> : <span className="muted">—</span>}</td>
        <td>
          {p.requires.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <div className="chips">{p.requires.map((r) => <code key={r} className="chip">{r}</code>)}</div>
          )}
        </td>
        <td>
          <div className="row-actions">
            {(p.state === 'inactive' || p.state === 'error') && (
              <button className="btn small primary" disabled={busy !== ''} onClick={onOpenConfig} title="启用并可选配置">
                {p.state === 'error' ? '重试' : '启用'}
              </button>
            )}
            <button
              className="btn small ghost"
              disabled={busy !== ''}
              onClick={onOpenConfig}
              title={p.configurable ? '配置（按 schema 生成表单）' : '配置（JSON 原文）'}
            >
              ⚙
            </button>
            {p.state === 'active' && p.layer === 'session' && (
              <button className="btn small danger" disabled={busy !== ''} onClick={onDisable}>
                停用
              </button>
            )}
            {p.state === 'active' && p.layer === 'base' && (
              <span className="muted small" title="基础层插件由清单管理；先在会话层启用副本再停用，或改清单后重启">清单托管</span>
            )}
          </div>
        </td>
      </tr>
      {configOpen && (
        <tr className="config-row">
          <td colSpan={8}>
            <div className="config-editor">
              <label>
                配置
                {editor?.descriptor
                  ? '（由插件 configSchema 自动生成；保存即校验并热更新已激活插件）'
                  : '（JSON 原文：该插件未声明 schemastery configSchema，字段原样透传）'}
              </label>
              {editor && !editor.loading && (
                <p className="muted small">
                  持久化层：{editor.layer ? LAYER_LABEL[editor.layer] : '—'}（重启后仍生效）
                  {editor.activeLayer ? `；激活层：${LAYER_LABEL[editor.activeLayer]}` : '；当前未激活，保存仅落盘'}
                  {p.state === 'active' && !p.hotReloadable && '；该插件声明为冷插件，保存会重启其 fiber'}
                </p>
              )}
              {editor?.loading ? (
                <p className="muted small">读取配置中…</p>
              ) : editor?.descriptor ? (
                <SchemaForm
                  root={editor.descriptor}
                  value={editor.value}
                  onChange={onEditorChange}
                  errors={configErrors}
                />
              ) : (
                <textarea
                  rows={4}
                  value={configText}
                  onChange={(e) => onConfigText(e.target.value)}
                  placeholder={'{\n  \n}'}
                  spellCheck={false}
                />
              )}
              <div className="config-actions">
                <button
                  className="btn small primary"
                  disabled={busy !== '' || editor?.loading}
                  onClick={onSaveConfig}
                  title="校验（声明 schema 时）并落盘；已激活插件立即热更新，未激活插件重新启用后生效"
                >
                  保存配置
                </button>
                {(p.state === 'inactive' || p.state === 'error') && (
                  <button className="btn small" disabled={busy !== '' || editor?.loading} onClick={onEnable}>
                    启用 {p.name}
                  </button>
                )}
                <button className="btn small ghost" onClick={onOpenConfig}>
                  取消
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
