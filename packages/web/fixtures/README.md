# 插槽机制夹具（fixture）

这是一份**演示/验收夹具**：用来端到端验证宿主侧插槽基础设施
（`packages/web/src/lib/slots.tsx`、`hostSdk.ts`、`pluginUi.ts` + `packages/web/public/host-sdk/*.js`）。

它**不是**产品代码。它同时演示两条产物路径：

| 构建 | 输出位置 | 演示的链路 |
| --- | --- | --- |
| 第一次（`FIXTURE_OUT=@geewiki/wiki`，默认） | `packages/web/public/plugins-ui/@geewiki/wiki/` | **宿主侧约定根**：dev 由后端以 `public` 为 webDist 提供、prod 由 `vite build` 拷进 `dist/` |
| 第二次（`FIXTURE_OUT=@geewiki-plugin/hello` + `FIXTURE_OUT_DIR=../../../plugins/hello-geewiki/dist`） | `plugins/hello-geewiki/dist/` | **插件自带产物根**：外部插件把自己的 UI 产物放在插件目录里（Docker 下 `plugins/` 是 bind mount，这是"安装即生效、无需重建 web 包"的路径） |

## 构建

```bash
pnpm --filter @geewiki/web build:fixtures
```

脚本会先清空 `packages/web/public/plugins-ui/`（避免上一版留下的陈旧产物让入口表与实际文件不一致），
再做上面两次构建。

产物是**生成物，且不随仓库提交**：

- `packages/web/public/plugins-ui/` —— 由 `.gitignore` 的 `packages/web/public/plugins-ui/` 一行排除
  （`git ls-files packages/web/public/` 只列出 `host-sdk/react.js` 与 `host-sdk/jsx-runtime.js`）；
- `plugins/hello-geewiki/dist/` —— 由 `.gitignore` 的 `dist/` 一行排除。

因此全新克隆后需先执行上面的 `build:fixtures`，管理台上才会有示例插件 UI；缺失时宿主不会报错，
只是没有插件 UI 可加载。修改夹具源码后重新执行 `build:fixtures` 即可覆盖。

## 入口表（后端下发）

宿主**不读任何静态 JSON**，而是请求 `GET /api/plugins/ui`——由后端从**活状态**派生：
注册表（谁声明了 `geewiki.client`）× 当前激活集合 × 产物是否真的存在（双资产根，插件目录优先）。

```json
{
  "ok": true, "version": 1, "revision": "1ab05a4e258c",
  "plugins": { "@geewiki/wiki": { "entry": "client.js", "css": "client.css", "rev": "e9cbef75" } },
  "skipped": [{ "name": "@geewiki-plugin/hello", "reason": "inactive" }]
}
```

条目里的 `entry` / `css` 只允许**单段文件名**（宿主会校验，防路径穿越）。
`skipped` 的 `reason` 取值：`inactive` / `no_client` / `entry_missing` / `invalid_name` ——
**`entry_missing` 是"产物缺失"的唯一可见出口**：产物没构建时插件根本不进表，前端也就不会去
`import` 一个不存在的 URL，因此**不产生 404 与控制台错误**。

之所以不用「拼约定 URL + 试探」，见 `packages/web/src/lib/pluginUiPlan.ts` 顶部：dev 下非绝对 URL 的
动态 import 会被 Vite 注入 `?import` 并 500、缺失路径在 dev 返回 200+text/html（MIME 报错）、
在 prod 返回 404（Chrome 记为控制台 error）——三种都会污染控制台。

## 夹具做了什么

| 组件 | 插槽 | 验证点 |
| --- | --- | --- |
| `CounterWidget`（`.gw-fixture-inc` / `.gw-fixture-count`） | `app-header` | hooks 可用 ⇒ 插件与宿主**共用同一个 React 实例**（双实例会报 `TypeError: Cannot read properties of null (reading 'useState')`） |
| `ThrowerWidget`（`.gw-fixture-throw`，点击后抛错） | `app-footer` | 单个插件 UI 抛错被错误边界隔离，其它插槽与宿主照常工作 |

自动化断言可用的选择器：`[data-slot="app-header"]`、`[data-slot="app-footer"]`（带 `data-count`）、
`.gw-fixture-count`、`.gw-fixture-label`、`[data-fixture="thrower"]`、`.slot-error[data-error]`、
`link[data-plugin-ui="<插件名>"]`。

调试入口（见 `pluginUi.ts` 末尾）：

```js
window.__GEEWIKI_HOST__          // 宿主 SDK：React / jsxRuntime / registerSlot / unregisterSlot / version
window.__GEEWIKI_PLUGIN_UI__.loaded()                    // 已加载界面的插件名
window.__GEEWIKI_PLUGIN_UI__.sync()                      // 拉一次入口表并让界面与之对齐（幂等、单飞）
window.__GEEWIKI_PLUGIN_UI__.revision()                  // 最近一次成功解析的整表指纹
window.__GEEWIKI_PLUGIN_UI__.unload('@geewiki/wiki')     // 卸载某个插件的界面贡献
window.__GEEWIKI_PLUGIN_UI__.base('@geewiki/wiki')       // 插件名 → 界面目录 URL（非法名返回 undefined）
```

## 端到端验收脚本

`scripts/acceptance/plugin-ui-cdp.mjs`（零依赖，入库，**不接入 `pnpm test`**——它需要 Chrome
与跑起来的实例）：

```bash
# prod（pnpm build && pnpm start 之后）
node scripts/acceptance/plugin-ui-cdp.mjs http://127.0.0.1:3000 9451 \
  --missing-asset=$PWD/plugins/hello-geewiki/dist/client.js

# dev（必须单独跑一遍：Vite 的 ?import 改写只在 dev 出现）。用隔离端口，别占用开发用的 3000/5173：
GEEWIKI_PORT=3313 GEEWIKI_WEB_DIST=$PWD/packages/web/public GEEWIKI_PLUGINS_DIR=$PWD/plugins \
  pnpm start &
GEEWIKI_DEV_PORT=5273 GEEWIKI_DEV_API=http://127.0.0.1:3313 pnpm --filter @geewiki/web exec vite &
node scripts/acceptance/plugin-ui-cdp.mjs http://127.0.0.1:5273 9452 \
  --missing-asset=$PWD/plugins/hello-geewiki/dist/client.js
```

## 已知边界

- ESM 模块一旦被 `import()` 就无法从模块图里卸载，`unload` 只回滚**插槽注册与 CSS**；
  因此**产物更新后需要整页刷新**才生效（给 URL 加 `?v=<rev>` 做缓存击穿已被实测证伪，见
  `pluginUi.ts` 与 `pluginUiPlan.ts` 顶部说明）；
- 未做入口完整性/签名校验与版本协商；
- `plugins/<插件名>/dist/` 里的字体/图片等**子目录资源**当前不支持（只服务单段文件名）；
- 夹具源码不在 `packages/web/tsconfig.json` 的 include 内，因此不参与 `pnpm typecheck`
  （构建由 Vite/esbuild 完成）。
