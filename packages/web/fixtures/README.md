# 插槽机制夹具（fixture）

这是一份**过渡夹具**：在「插件自带客户端构建链」落地之前，用来端到端验证宿主侧插槽基础设施
（`packages/web/src/lib/slots.tsx`、`hostSdk.ts`、`pluginUi.ts` + `packages/web/public/host-sdk/*.js`）。

它**不是**产品代码，也**不是** `plugins/` 下真实插件的客户端入口；真实入口应由后端下发
（见 `packages/web/src/lib/pluginUi.ts` 顶部 TODO 与 `docs/plugin-platform-plan.md` D-8）。

## 构建

```bash
pnpm --filter @geewiki/web build:fixtures
```

产物（两份，同一份源码分别按两个插件名构建）：

- `packages/web/public/plugins-ui/@geewiki/wiki/client.{js,css}`
- `packages/web/public/plugins-ui/@geewiki-plugin/hello/client.{js,css}`

这两份产物是**生成物但随仓库提交**：好处是全新克隆后只跑 `pnpm build` 就能看到插槽效果，
不必先补一次夹具构建。修改夹具源码后重新执行 `build:fixtures` 即可覆盖。

`vite build` 会把 `public/` 原样拷进 `dist/`，所以 prod 模式（后端 3000 端口托管 dist）同样生效。

## 为什么目录名取这两个插件

宿主只加载「入口表里声明、且当前处于 active」的插件界面：

- `@geewiki/wiki`：base 层必然激活 → **开箱即可看到插槽内容**，不需要改动任何插件状态；
- `@geewiki-plugin/hello`：`plugins/hello-geewiki` 这个外部插件的状态取决于是否被启用，
  启用后刷新页面即可看到它的界面（这条路径顺带验证了「外部插件 → 前端插槽」的全链路）。

## 入口表

宿主不猜 URL：它读 `public/plugins-ui/registry.json`（由本目录的构建**自动生成**，
两个变体是先后两次构建，脚本读-改-写并清理指向已删除目录的陈旧条目）：

```json
{ "version": 1, "plugins": { "@geewiki/wiki": { "entry": "client.js", "css": "client.css" } } }
```

条目里的 `entry` / `css` 只允许**单段文件名**（宿主会校验，防路径穿越）。
之所以不用「拼约定 URL + 试探」，见 `packages/web/src/lib/pluginUi.ts` 顶部：dev 下 Vite 会给动态
import 注入 `?import` 并 500、缺失路径在 dev 返回 200+text/html（MIME 报错）、在 prod 返回 404
（Chrome 记为控制台 error）——三种都会污染控制台。正式方案里这份入口表由后端随插件清单下发。

## 夹具做了什么

| 组件 | 插槽 | 验证点 |
| --- | --- | --- |
| `CounterWidget`（`.gw-fixture-inc` / `.gw-fixture-count`） | `app-header` | hooks 可用 ⇒ 插件与宿主**共用同一个 React 实例**（双实例会报 `TypeError: Cannot read properties of null (reading 'useState')`） |
| `ThrowerWidget`（`.gw-fixture-throw`，点击后抛错） | `app-footer` | 单个插件 UI 抛错被错误边界隔离，其它插槽与宿主照常工作 |

手测/自动化断言可用的选择器：`[data-slot="app-header"]`、`[data-slot="app-footer"]`（带 `data-count`）、
`.gw-fixture-count`、`[data-fixture="thrower"]`、`.slot-error[data-error]`。

调试入口（过渡期，见 `pluginUi.ts`）：

```js
window.__GEEWIKI_HOST__          // 宿主 SDK：React / jsxRuntime / registerSlot / unregisterSlot / version
window.__GEEWIKI_PLUGIN_UI__.loaded()                    // 已加载界面的插件名
window.__GEEWIKI_PLUGIN_UI__.unload('@geewiki/wiki')     // 卸载某个插件的界面贡献
window.__GEEWIKI_PLUGIN_UI__.refresh()                   // 重新按插件清单 + 入口表对齐
window.__GEEWIKI_PLUGIN_UI__.base('@geewiki/wiki')       // 插件名 → 界面目录 URL（非法名返回 undefined）
```

## 已知边界

- ESM 模块一旦被 `import()` 就无法从模块图里卸载，`unload` 只回滚**插槽注册与 CSS**；
- 未做入口完整性/版本校验，也未与插件 fork 生命周期绑定（都记在 `pluginUi.ts` 的 TODO 里）；
- 夹具源码不在 `packages/web/tsconfig.json` 的 include 内，因此不参与 `pnpm typecheck`
  （构建由 Vite/esbuild 完成）。
