import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * 插件客户端 UI 的构建配置（变体 B：react 系说明符全部 external，运行期由宿主 import map 解析）。
 *
 * 这一份 config 同时服务两类入口，**刻意不复制第二份**：
 * 1. `packages/web/fixtures/**` 下的夹具（默认入口 `./src/index.tsx`）；
 * 2. **插件自带的界面源码**（`FIXTURE_ENTRY` 指到 `../../plugin-ai-{assist,qa}/ui/index.tsx`）。
 *
 * 为什么不各写一份 config：两份只会差 `entry` 与 `outDir`，而"react 必须 external、
 * publicDir 必须关掉、NODE_ENV 必须 define、CSS 必须叫 client.css"这几条都是**踩过坑**才对的
 * （见下面每条注释）。复制等于把踩坑清单再抄一遍，迟早抄漏一条。
 *
 * 默认输出到 `public/plugins-ui/<FIXTURE_OUT>/`（dev 下后端以 public 为 webDist 提供，
 * prod 由 `vite build` 把 publicDir 拷进 dist）。宿主按 `/plugins-ui/<插件名>/client.js`
 * 取产物（`resolvePluginUiRoots` 的第二候选根），所以 **`FIXTURE_OUT` 必须逐字等于插件名**
 * ——对不上就是"构建成功但没人加载"的静默故障，故下面有一道形状校验。
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
 * 客户端入口源文件（相对本目录，也可指到仓库其它位置）。默认 `./src/index.tsx`（插槽演示夹具）；
 * `@geewiki/editor-plain` 用 `./editor/index.tsx`，两个 AI 插件用各自包里的 `ui/index.tsx`。
 */
const entry = process.env.FIXTURE_ENTRY ?? './src/index.tsx'
const outDir = process.env.FIXTURE_OUT_DIR
const resolve = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * **产物名与插件名的一致性校验**（只在"入口不在 fixtures 目录里"时启用）。
 *
 * 症状值得单独说明：宿主取 UI 的键是**插件名**，构建输出的目录名也是插件名。两者对不上时
 * 构建照样成功、`client.js` 照样产出，但入口表里的路径指向另一个目录 ⇒ 前端
 * `entry_missing` 跳过加载 ⇒ 用户视角是"这个插件的界面凭空不见了"。
 * 这类"构建绿、功能没上线"的故障必须在这里变红。
 *
 * 判据用**入口所属包的 `package.json` 的 `name`**，不是路径字符串：改名时包名会跟着改，
 * 而拼出来的目录名不会 ⇒ 正是这里要抓的漂移。夹具目录没有 package.json，故只在入口
 * 落在 fixtures 之外时才校验（夹具的 `FIXTURE_OUT` 可以故意指向别的插件名，那是设计）。
 */
function assertPluginNameMatchesEntry(entryPath: string, outName: string): void {
  if (entryPath.startsWith(pathResolve(HERE))) return // 夹具自己的入口：不校验
  let dir = dirname(entryPath)
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      let name = ''
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }
        name = typeof parsed.name === 'string' ? parsed.name : ''
      } catch (err) {
        throw new Error(
          `[plugin-ui] 无法解析 ${pkgPath}（入口 ${entryPath} 所属包）：${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (name !== outName) {
        throw new Error(
          `[plugin-ui] FIXTURE_OUT="${outName}" 与入口所属包名 "${name}" 不一致：` +
            `宿主按插件名解析 /plugins-ui/<名>/client.js，对不上会**静默不加载**。` +
            `把 FIXTURE_OUT 改成 "${name}"。`,
        )
      }
      return
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`[plugin-ui] 入口 ${entryPath} 之外找不到 package.json，无法校验产物名与插件名一致`)
}

assertPluginNameMatchesEntry(resolve(entry), out)

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
    // 运行期由宿主的 import map 提供（`hostSdk` 注入 react 与 jsxRuntime）。
    // 打进来会有两个后果：① 两份 React 实例 ⇒ hooks 报"invalid hook call"；② 体积翻倍。
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    },
  },
})
