import { useEffect, useState, type ReactNode } from 'react'
import { MoreMenu, type MenuItem } from './components/MoreMenu'
import { titleForRoute } from './lib/pageMeta'
import { SlotOutlet } from './lib/slots'
import { useDocumentTitle } from './lib/useDocumentTitle'
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

/** 产品主入口：知识库（用户日常用的就是它） */
const PRIMARY_TABS: MenuItem[] = [{ id: 'wiki', label: '知识库', icon: '📚' }]

/**
 * 次级入口：面向运维/开发的台面。收进下拉而不是与「知识库」平级，
 * 避免产品界面看起来像一个开发者控制台（用户反馈："开发味太重"）。
 */
const ADMIN_ITEMS: MenuItem[] = [
  { id: 'plugins', label: '插件管理', icon: '🧩' },
  { id: 'graph', label: '依赖图', icon: '🕸️' },
]

export function App(): ReactNode {
  const route = useRoute()
  const root = route.split('/')[0] ?? 'wiki'
  const known = [...PRIMARY_TABS, ...ADMIN_ITEMS].some((t) => t.id === root)
  const active = known ? root : 'wiki'

  /** 路由级基线标题；详情页拿到页面数据后会覆盖成真实标题（见 WikiDetail） */
  useDocumentTitle(titleForRoute(route === '' ? 'wiki' : route))

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
          <span className="brand-logo" aria-hidden="true">📚</span>
          <span className="brand-name">GeeWiki</span>
          <span className="brand-tag">AI-Native 插件化知识库</span>
        </div>
        <nav className="tabs">
          {PRIMARY_TABS.map((t) => (
            <button key={t.id} className={`tab${active === t.id ? ' active' : ''}`} onClick={() => nav(t.id)}>
              <span className="tab-icon" aria-hidden="true">{t.icon}</span>
              {t.label}
            </button>
          ))}
          <MoreMenu items={ADMIN_ITEMS} active={active} onNavigate={nav} label="管理" icon="⚙️" />
        </nav>
        {/*
          注意：这个「● 服务健康」链接指向的是原始 JSON 端点 /api/health，属于**开发者向**的
          便利入口。本批**有意保留**（改动范围被限定在 6 项去开发痕迹修复内，未获授权顺手删除）。
          它和页脚那串技术栈自述属于同一类"开发味"，建议在下一批（设计系统）里一并处置：
          要么移除，要么改成不暴露实现细节的状态呈现。
        */}
        <a className="gh-link" href="/api/health" target="_blank" rel="noreferrer" title="健康检查 /api/health">
          ● 服务健康
        </a>
        {/* 插件插槽：已激活插件可在此贡献界面（见 lib/slots.tsx 与 lib/pluginUi.ts） */}
        <SlotOutlet name="app-header" />
      </header>
      <main className="app-main">{body}</main>
      {/*
        页脚只作为 app-footer 插槽的宿主：没有插件贡献界面时整条**不占位**
        （见 styles.css 里针对 data-count="0" 的规则），避免留下一条空白横条。
        产品自身不再在此罗列内核/框架/数据库等技术栈——那些属于开发者文档，不属于产品界面。
      */}
      <footer className="app-footer">
        <SlotOutlet name="app-footer" />
      </footer>
    </div>
  )
}
