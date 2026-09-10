import { useEffect, useState, type ReactNode } from 'react'
import { AdminPage } from './pages/AdminPage'
import { GraphPage } from './pages/GraphPage'
import { WikiPage } from './pages/WikiPage'

/** 简易 hash 路由：location.hash = '#/wiki/getting-started' → route = 'wiki/getting-started' */
function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, ''))
  useEffect(() => {
    const onChange = (): void => setRoute(window.location.hash.replace(/^#\/?/, ''))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

const TABS: { id: string; label: string; icon: string }[] = [
  { id: 'wiki', label: '知识库', icon: '📚' },
  { id: 'plugins', label: '插件管理', icon: '🧩' },
  { id: 'graph', label: '依赖图', icon: '🕸️' },
]

export function App(): ReactNode {
  const route = useRoute()
  const root = route.split('/')[0] ?? 'wiki'
  const active = TABS.some((t) => t.id === root) ? root : 'wiki'
  /** 统一 hash 跳转：规范化首尾斜杠，避免产生 '#/wiki/'（尾斜杠）或 '#/'（空路由）这类 URL */
  const nav = (id: string): void => {
    const clean = id.replace(/^\/+/, '').replace(/\/+$/, '')
    window.location.hash = clean ? `/${clean}` : '/wiki'
  }

  let body: ReactNode
  if (active === 'wiki') body = <WikiPage sub={route.slice('wiki'.length).replace(/^\/+/, '')} onNavigate={(path) => nav(`wiki/${path}`)} />
  else if (active === 'plugins') body = <AdminPage />
  else body = <GraphPage />

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand" onClick={() => nav('wiki')} role="button" tabIndex={0}>
          <span className="brand-logo">📚</span>
          <span className="brand-name">GeeWiki</span>
          <span className="brand-tag">AI-Native 插件化知识库</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab${active === t.id ? ' active' : ''}`} onClick={() => nav(t.id)}>
              <span className="tab-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <a className="gh-link" href="/api/health" target="_blank" rel="noreferrer" title="健康检查 /api/health">
          ● 服务健康
        </a>
      </header>
      <main className="app-main">{body}</main>
      <footer className="app-footer">
        GeeWiki · cordis 插件化内核 · React 19 管理台 · SQLite（可切换 PostgreSQL）
      </footer>
    </div>
  )
}
