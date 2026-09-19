/**
 * `app-dock` 的**宿主侧挂载点**（常驻底部输入条）。
 *
 * ## 为什么要有这个中间层，而不是在 `App.tsx` 里直接写 `<AppDockSlotOutlet/>`
 * 三件事必须在渲染出口**之前**发生，且只有宿主知道何时发生：
 *
 * 1. **登录判定（决策 5）**：只有登录用户才渲染 dock。这不是"隐藏 UI"那么轻——
 *    它是"**匿名读者一个字节的 AI bundle 都不下载**"的机械前提（见下面第 2 点）。
 * 2. **按需加载**：`app-dock` 归 `ON_DEMAND_SLOTS`，宿主必须在**真正要渲染它**时才
 *    `ensureSlotLoaded('app-dock')`。若把这一步提到无条件执行的模块初始化里，
 *    匿名读者照样下载整套聊天 bundle——那正是设计文档 §5.2 想避免的事。
 * 3. **页面上下文**：需求 ② 要求"针对当前页回答"，而路由真源在宿主。把
 *    `route → page` 的翻译收在这里，`App.tsx` 只负责把 route 递进来。
 *
 * 加上把登录身份（`userId`）一并下发——插件据此给本地会话分键，自己查会有"身份与渲染时刻
 * 不一致"的窗口（见 core 的 `AppDockSlotProps.userId` 注释）。
 *
 * 这些事都收在一个组件里，是因为它们**必须同生同死**：任何一处被单独挪走
 * （例如把 `ensureSlotLoaded` 挪到 App 顶层、或把登录判定挪进插件），上面那条
 * "匿名零下载"的保证就断了，而且不会有任何测试或报错告诉你。
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import { pageContextOf } from '../lib/dockPlan'
import { homePageSlug } from '../lib/homePlan'
import { useHome } from '../lib/homeStore'
import { registerNavTools } from '../lib/navTools'
import { ensureSlotLoaded } from '../lib/pluginUi'
import { AppDockSlotOutlet } from '../lib/slots'
import { invokeClientTool, subscribeClientTools, clientToolNamesSnapshot } from '../lib/clientTools'
import { useAuth } from '../lib/authStore'
import { useSyncExternalStore } from 'react'

/** 订阅客户端工具登记（`getSnapshot` 走 `clientTools.ts` 的引用稳定缓存） */
function useClientTools(): readonly string[] {
  return useSyncExternalStore(subscribeClientTools, clientToolNamesSnapshot, () => clientToolNamesSnapshot())
}

export interface AppDockProps {
  /** 宿主路由串（`App.tsx` 的 `useRoute()` 结果，如 `'wiki/guides/intro'`） */
  readonly route: string
  /** 打开某个页面（宿主路由；`App.tsx` 负责拼 `wiki/` 前缀） */
  openPage(slug: string): void
}

/**
 * 常驻输入条的宿主挂载点。
 *
 * **未登录时返回 `null`，且不触发 `ensureSlotLoaded`** —— 这是决策 5 的落点，
 * 也是"匿名不加载 AI bundle"这条验收判据的唯一实现位置。
 */
export function AppDock(props: AppDockProps): ReactNode {
  const auth = useAuth()
  const loggedIn = auth.user !== null

  useEffect(() => {
    if (!loggedIn) return
    /*
     * 加载失败**不在这里报错**：`AppDockSlotOutlet` 会渲染出插件界面加载失败的提示
     * （`useSlotLoadFailures('app-dock')` 与出口共用同一个 store）。在这里再报一次
     * 只会得到两条一模一样的告警。
     */
    void ensureSlotLoaded('app-dock').catch(() => {})
  }, [loggedIn])

  /*
   * 跳转类客户端工具（`open_page` / `scroll_to`）的**宿主侧一半**。
   *
   * 为什么登记在这里而不是 `App.tsx`：它必须与"插件界面在不在"同生同死。
   * dock 没渲染（未登录）时登记它们，会让服务端看到一份浏览器**其实执行不了**的
   * 可调用集——模型于是会去调一个必定失败的工具，而用户看到的是"AI 说要跳转，没反应"。
   *
   * 依赖是 `loggedIn` 与 `openPage`：前者决定这段能力在不在，后者是 `App.tsx` 的路由函数
   * （`openPage` 每次渲染都是新引用，故这个 effect 会频繁重跑——`registerClientTool`
   * 的 disposer 是幂等的，重跑一次就是"注销旧的、登记新的"，代价是一张 Map 的两次操作）。
   */
  useEffect(() => {
    if (!loggedIn) return
    return registerNavTools({ openPage: props.openPage })
  }, [loggedIn, props.openPage])

  // hooks 必须在任何提前 return 之前调用（React 的调用顺序约束）
  /*
   * `#/wiki`（`route === 'wiki'`）的"当前页"是**站点设置的那一篇**，不再是编译期常量，
   * 因此这里订阅同一份设置缓存（与 `WikiPage`、`#/wiki` 的落点同源，见 `lib/homePlan.ts`）。
   *
   * 顺带一个副作用是好的：dock 在所有**已登录**页面上常驻，于是这次订阅通常早就把主页
   * 设置取回来了——用户随后走到 `#/wiki` 时正文不必再等它（见 `homeStore` 头注里的代价说明）。
   */
  const home = useHome()
  const page = useMemo(() => pageContextOf(props.route, homePageSlug(home.home)), [props.route, home.home])
  const clientTools = useClientTools()

  if (!loggedIn) return null

  return (
    <AppDockSlotOutlet
      page={page}
      clientTools={clientTools}
      // `loggedIn` 已保证非空；仍写成可选链是防"退出登录的那一帧"（auth 先变、渲染后到）
      userId={auth.user?.id ?? null}
      openPage={props.openPage}
      invokeTool={invokeClientTool}
    />
  )
}
