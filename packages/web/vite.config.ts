import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 端口与代理目标可用环境变量覆盖，默认值就是 `pnpm dev` 的常用组合（5173 → 3000）。
// 覆盖能力是给**验收脚本**用的：验收纪律要求跑在隔离端口上、不得占用开发用的 3000/5173
// （见 scripts/acceptance/plugin-ui-cdp.mjs）。
const apiTarget = process.env['GEEWIKI_DEV_API'] ?? 'http://127.0.0.1:3000'
const devPort = Number(process.env['GEEWIKI_DEV_PORT'] ?? 5173)

export default defineConfig({
  plugins: [react()],
  // 开发模式：前端 dev server 把 /api 与 /plugins-ui 代理到 GeeWiki 后端
  server: {
    // 显式监听通配地址（Linux 上 '::' 为双栈），为保证 localhost 在 IPv4/IPv6 解析下都可访问：
    // 默认写法在某些环境下只绑定 IPv6 回环 [::1]，导致只走 IPv4 的浏览器访问 http://127.0.0.1:5173/ 被拒绝。
    host: '::',
    port: devPort,
    proxy: {
      '/api': apiTarget,
      // 插件 UI 资产也交给后端：产物可能来自 `<插件目录>/dist`（在 publicDir 之外），
      // 只有后端知道该按哪个根提供。dev 下后端以 GEEWIKI_WEB_DIST=packages/web/public 启动，
      // 于是内置夹具也走同一条链路——dev/prod 只差"内置资产根指向 public 还是 dist"。
      // 注意 Vite 的 proxy 中间件排在 publicDir 之前，故这条会覆盖 publicDir 的默认静态服务。
      '/plugins-ui': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  base: '/',
})
