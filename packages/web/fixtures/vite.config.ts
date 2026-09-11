import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * 夹具插件的客户端构建（变体 B：react 系说明符全部 external，运行期由宿主 import map 解析）。
 *
 * 默认输出到 `public/plugins-ui/<FIXTURE_OUT>/`（dev 下后端以 public 为 webDist 提供，
 * prod 由 `vite build` 把 publicDir 拷进 dist）。
 *
 * `FIXTURE_OUT_DIR` 可覆盖输出目录：`build:fixtures` 用它把第二份产物直接落到
 * `plugins/hello-geewiki/dist/`，演示"外部插件自带 UI 产物"这条链路（插件目录优先于
 * `<webDist>/plugins-ui/<名>`，见 packages/manager/src/plugin-ui.ts 的双根解析）。
 *
 * FIXTURE_OUT 默认取 `@geewiki/wiki`（它是 base 层必然激活的插件，因此无需改动任何插件状态
 * 就能看到插槽效果）；可用环境变量覆盖成别的插件名，例如外部插件 `@geewiki-plugin/hello`。
 *
 * 注：本构建**不再**生成 `/plugins-ui/registry.json` —— 入口表已改由后端
 * `GET /api/plugins/ui` 从活状态派生（见 packages/manager/src/plugin-ui.ts）。
 */
const out = process.env.FIXTURE_OUT ?? '@geewiki/wiki'
/**
 * 客户端入口源文件（相对本目录）。默认 `./src/index.tsx`（插槽演示夹具）；
 * `FIXTURE_ENTRY` 可指向别的入口——`@geewiki/editor-plain` 的编辑器界面用 `./editor/index.tsx`。
 *
 * 为什么参数化而不是再写一份 config：两份只差 entry 与 outDir，复制等于把
 * "react 必须 external、publicDir 必须关掉、NODE_ENV 必须 define"这几条踩过的坑再抄一遍，
 * 迟早抄漏其中一条。
 */
const entry = process.env.FIXTURE_ENTRY ?? './src/index.tsx'
const outDir = process.env.FIXTURE_OUT_DIR
const resolve = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // 关键：默认 outDir 就在 publicDir（packages/web/public）**内部**，
  // 若不禁用 publicDir，Vite 会把 publicDir 拷进 outDir → 产物目录自我复制成
  // public/plugins-ui/<名>/plugins-ui/<名>/... 的无限嵌套（目录体积暴涨）。
  // 覆盖到插件目录（plugins/<name>/dist，位于仓库其它位置）时同理必须禁用。
  publicDir: false,
  // lib 模式不会替换 process.env.NODE_ENV；react 若被打进产物会因此抛 `process is not defined`
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: outDir ? resolve(outDir) : resolve(`../public/plugins-ui/${out}`),
    emptyOutDir: true,
    target: 'esnext',
    lib: {
      entry: resolve(entry),
      formats: ['es'],
      fileName: () => 'client.js',
      // 不显式指定时 Vite 会回退读 package.json 的 name，夹具目录没有 package.json 会直接构建失败
      cssFileName: 'client',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    },
  },
})
