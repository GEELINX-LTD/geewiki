// 这一行必须是第一个导入：public/host-sdk/*.js（import map 的目标）在模块求值期就读取
// window.__GEEWIKI_HOST__，任何插件 bundle 被动态 import 之前都必须完成挂载。
import './lib/hostSdk'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
// 样式入口：tokens（@theme 设计 token）→ 旧样式（整体收进 legacy 层）→ 旧变量桥接。
// 层序与新旧共存策略见该文件头部注释。
import './styles/index.css'
import { App } from './App'
import { TooltipProvider } from './ui/Tooltip'
import { startPluginUiSync } from './lib/pluginUi'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      TooltipProvider 挂在 React 根：Radix 的 Tooltip.Root **要求**祖先里有 Provider，
      否则直接抛 "Tooltip must be used within TooltipProvider"（实测：管理台整页白屏、
      控制台只有一条 Uncaught）。放在根上还让同一次悬停路径内的多个 tooltip 共享
      `delayDuration` 的开关延迟（Radix 的设计语义），而不是各自计时。
    */}
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </StrictMode>,
)

// 加载已激活插件的客户端界面，并建立与 fork 生命周期的自动同步：入口表由后端下发
// （GET /api/plugins/ui），启动时同步一次，之后由「管理台动作后 + 页面变可见 + 15s 轮询」跟随
// 插件启停；未提供界面或产物缺失的插件由后端归入 skipped，前端不会去 import，故零控制台噪声。
// 详见 lib/pluginUi.ts。
startPluginUiSync()
