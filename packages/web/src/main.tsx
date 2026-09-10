// 这一行必须是第一个导入：public/host-sdk/*.js（import map 的目标）在模块求值期就读取
// window.__GEEWIKI_HOST__，任何插件 bundle 被动态 import 之前都必须完成挂载。
import './lib/hostSdk'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App'
import { refreshPluginUi } from './lib/pluginUi'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 加载已激活插件的客户端界面：按约定 URL `/plugins-ui/<插件名>/client.js` 尝试 import，
// 未提供界面的插件会被静默跳过（见 lib/pluginUi.ts 的过渡说明与 TODO）。
void refreshPluginUi()
