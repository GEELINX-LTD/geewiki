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
import { startPluginUiSync } from './lib/pluginUi'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 加载已激活插件的客户端界面，并建立与 fork 生命周期的自动同步：入口表由后端下发
// （GET /api/plugins/ui），启动时同步一次，之后由「管理台动作后 + 页面变可见 + 15s 轮询」跟随
// 插件启停；未提供界面或产物缺失的插件由后端归入 skipped，前端不会去 import，故零控制台噪声。
// 详见 lib/pluginUi.ts。
startPluginUiSync()
