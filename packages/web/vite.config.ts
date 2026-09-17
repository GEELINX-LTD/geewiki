import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// Tailwind CSS v4 的官方 Vite 插件：v4 是 CSS-first 配置（`@import "tailwindcss"` + `@theme`），
// 不需要 tailwind.config.js，也不需要单独的 postcss 配置。见 src/styles/index.css。
import tailwindcss from '@tailwindcss/vite'

// 端口与代理目标可用环境变量覆盖，默认值就是 `pnpm dev` 的常用组合（5173 → 3000）。
// 覆盖能力是给**验收脚本**用的：验收纪律要求跑在隔离端口上、不得占用开发用的 3000/5173
// （见 scripts/acceptance/plugin-ui-cdp.mjs）。
const apiTarget = process.env['GEEWIKI_DEV_API'] ?? 'http://127.0.0.1:3000'
const devPort = Number(process.env['GEEWIKI_DEV_PORT'] ?? 5173)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 开发模式：前端 dev server 把 /api 与 /plugins-ui 代理到 GeeWiki 后端
  server: {
    // 显式监听通配地址（Linux 上 '::' 为双栈），为保证 localhost 在 IPv4/IPv6 解析下都可访问：
    // 默认写法在某些环境下只绑定 IPv6 回环 [::1]，导致只走 IPv4 的浏览器访问 http://127.0.0.1:5173/ 被拒绝。
    host: '::',
    port: devPort,
    proxy: {
      '/api': apiTarget,
      // 插件 UI 资产也交给后端：产物可能来自 `<插件目录>/dist`（在 publicDir 之外），且
      // 「内置插件 UI 资产根」与「前端产物根」是两个独立配置项，只有后端知道该按哪个根提供。
      // dev 下 `pnpm dev` 设 GEEWIKI_PLUGIN_UI_DIST=packages/web/public（内置夹具免构建即可用），
      // GEEWIKI_WEB_DIST 保持默认 packages/web/dist——那里才有 index.html，保证首页与 /assets/* 可用
      // （二者曾合并到 webDist 并指向 public，而 public 无 index.html → SPA fallback 失败、首页 404）。
      // 注意 Vite 的 proxy 中间件排在 publicDir 之前，故 /plugins-ui 前缀统一由后端提供——
      // 实测其 404 是后端的 {"ok":false,"error":"not_found"}，而非 Vite 的 index.html 回退。
      '/plugins-ui': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    /*
      这里曾写 `chunkSizeWarningLimit: 800` —— 那是**掩盖**警告而不是解决问题：
      当时主包 832 kB（gzip 266 kB），把阈值抬到 800 kB 之后构建不再提示，但匿名读者
      依然要下载整包。把 `@xyflow/react`（依赖图）拆成独立 chunk 后主包回落到 709 kB，
      故删掉这行、恢复 Vite 默认阈值继续当**真实告警**。

      ## ★ 709 kB 的实测构成（别把它当成"又有依赖进错包"）
      原文写着"超过就是又一次依赖进错包"——**这条诊断已经实测证伪**，留着会让人去追
      一个不存在的错包。当前主 chunk 的构成（用下面的办法量的）：

        · 本项目源码 112 个模块，以及 react / react-dom / scheduler
        · radix 的若干原语（dialog / dropdown / tooltip 及其传递依赖）
        · marked + dompurify（`hostSdk.renderMarkdown` 需要，首屏即用）
        · lucide-react **84 个图标模块**
        · **不含** `@xyflow/react`、`@codemirror/*`、`@lezer/*` —— 它们分别在
          `GraphPage-*.js`(239 kB) 与 `MarkdownEditor-*.js`(564 kB) 两个懒加载 chunk 里

      即：主包偏大是**这个 app shell 的真实体量**（React 19 + 组件库 + 一个 Markdown
      渲染器 + 一个富应用的壳），不是放错位置。真要再压，得动**首屏加载面**
      （把壳里某几块也改成懒加载），那是产品决定，且会多出请求与闪烁风险。

      ## 怎么重新量（改这条注释前请先量）
      ```bash
      cd packages/web && npx vite build --sourcemap
      # 主 chunk 的 .map 里 sources 列表 = 该 chunk 实际包含的模块，按包分组即可
      ```
      注意：**别用 esbuild 的 metafile 做这件事** —— 不加 `--splitting` 时它会把动态
      `import()` 全部内联，量出来的是一个 1.5 MB 的假主包（实测踩过）。
    */
  },
  base: '/',
})
