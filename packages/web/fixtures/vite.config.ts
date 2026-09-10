import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/**
 * 夹具插件的客户端构建（变体 B：react 系说明符全部 external，运行期由宿主 import map 解析）。
 *
 * 输出到 `public/plugins-ui/<FIXTURE_OUT>/`，于是：
 * - dev：Vite dev server 直接以静态文件提供；
 * - prod：`vite build` 会把 publicDir 内容原样拷进 `dist/`，由后端静态层提供。
 *
 * FIXTURE_OUT 默认取 `@geewiki/wiki`（它是 base 层必然激活的插件，因此无需改动任何插件状态
 * 就能看到插槽效果）；可用环境变量覆盖成别的插件名，例如外部插件 `@geewiki-plugin/hello`。
 */
const out = process.env.FIXTURE_OUT ?? '@geewiki/wiki'
const resolve = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const uiRoot = resolve('../public/plugins-ui')
const registryFile = join(uiRoot, 'registry.json')

/**
 * 生成宿主读取的**入口表** `/plugins-ui/registry.json`（见 packages/web/src/lib/pluginUi.ts 的说明）。
 * 两个夹具变体是先后两次构建，所以这里读-改-写，并顺手清掉指向已删除目录的陈旧条目。
 */
function registryPlugin(): Plugin {
  return {
    name: 'geewiki-fixture-registry',
    closeBundle() {
      let data: { version: number; plugins: Record<string, { entry: string; css?: string }> } = { version: 1, plugins: {} }
      try {
        data = JSON.parse(readFileSync(registryFile, 'utf8')) as typeof data
      } catch {
        /* 首次构建：没有旧表 */
      }
      data.version = 1
      data.plugins = data.plugins ?? {}
      for (const key of Object.keys(data.plugins)) {
        if (!existsSync(join(uiRoot, key))) delete data.plugins[key]
      }
      data.plugins[out] = { entry: 'client.js', css: 'client.css' }
      mkdirSync(uiRoot, { recursive: true })
      writeFileSync(registryFile, `${JSON.stringify(data, null, 2)}\n`)
    },
  }
}

export default defineConfig({
  plugins: [registryPlugin()],
  esbuild: { jsx: 'automatic' },
  // 关键：本构建的 outDir 就在 publicDir（packages/web/public）**内部**，
  // 若不禁用 publicDir，Vite 会把 publicDir 拷进 outDir → 产物目录自我复制成
  // public/plugins-ui/<名>/plugins-ui/<名>/... 的无限嵌套（目录体积暴涨）。
  publicDir: false,
  // lib 模式不会替换 process.env.NODE_ENV；react 若被打进产物会因此抛 `process is not defined`
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(`../public/plugins-ui/${out}`),
    emptyOutDir: true,
    target: 'esnext',
    lib: {
      entry: resolve('./src/index.tsx'),
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
