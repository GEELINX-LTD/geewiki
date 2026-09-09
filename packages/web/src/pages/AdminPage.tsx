import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, type ListEntry, type PluginInfo, type SessionState } from '../api'

function fmtError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const STATE_LABEL: Record<PluginInfo['state'], string> = { active: '运行中', inactive: '未启用', error: '异常' }
const LAYER_LABEL: Record<string, string> = { base: '基础层', session: '会话层' }

export function AdminPage(): ReactNode {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')

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
      return
    }
    setConfigFor(p.name)
    setConfigText(p.config ? JSON.stringify(p.config, null, 2) : '')
  }

  const confirmEnable = (p: PluginInfo): void => {
    let config: Record<string, unknown> | undefined
    const text = configText.trim()
    if (configFor === p.name && text) {
      try {
        config = JSON.parse(text) as Record<string, unknown>
      } catch {
        setNotice({ kind: 'err', text: `配置不是合法 JSON: ${text.slice(0, 60)}…` })
        return
      }
    }
    void act('enable', () => api.enable(p.name, config), `已启用 ${p.name}`)
    setConfigFor(null)
  }

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
                onConfigText={setConfigText}
                onOpenConfig={() => openConfig(p)}
                onEnable={() => confirmEnable(p)}
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
  onConfigText: (v: string) => void
  onOpenConfig: () => void
  onEnable: () => void
  onDisable: () => void
}): ReactNode {
  const { p, busy, configOpen, configText, onConfigText, onOpenConfig, onEnable, onDisable } = props
  const rowBusy = busy === `enable:${p.name}` || busy === `disable:${p.name}`
  const hot = p.hotReloadable
  return (
    <>
      <tr className={p.state === 'error' ? 'row-error' : ''}>
        <td>
          <div className="plugin-name">{p.name}</div>
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
              <>
                <button className="btn small primary" disabled={busy !== ''} onClick={onOpenConfig} title="启用并可选配置（JSON）">
                  {p.state === 'error' ? '重试' : '启用'}
                </button>
                <button className="btn small ghost" disabled={busy !== ''} onClick={onOpenConfig} title="展开配置编辑">
                  ⚙
                </button>
              </>
            )}
            {p.state === 'active' && p.layer === 'session' && (
              <button className="btn small danger" disabled={busy !== '' || rowBusy} onClick={onDisable}>
                停用
              </button>
            )}
            {p.state === 'active' && p.layer === 'base' && (
              <span className="muted small" title="基础层插件由清单管理；先在会话层启用副本再停用，或改清单后重启">清单托管</span>
            )}
          </div>
        </td>
      </tr>
      {configOpen && (p.state === 'inactive' || p.state === 'error') && (
        <tr className="config-row">
          <td colSpan={8}>
            <div className="config-editor">
              <label>
                启用配置（JSON，可留空）· 冷插件（非热）不支持会话层启用，请加入 plugins.base.json 后重启
              </label>
              <textarea
                rows={4}
                value={configText}
                onChange={(e) => onConfigText(e.target.value)}
                placeholder={'{\n  \n}'}
                spellCheck={false}
              />
              <div className="config-actions">
                <button className="btn small primary" disabled={busy !== ''} onClick={onEnable}>
                  确认启用 {p.name}
                </button>
                <button className="btn small ghost" onClick={onOpenConfig}>取消</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
