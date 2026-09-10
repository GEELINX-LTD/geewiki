# @geewiki-plugin/hello —— 外部插件示例

本目录演示 GeeWiki **外部插件**的最小约定（宿主启动时扫描 `<仓库根>/plugins/*/`，
详见 [docs/architecture.md](../../docs/architecture.md) 第 5.8 节）：

| 约定 | 本示例的做法 |
| --- | --- |
| 清单 | `package.json` 顶层 `geewiki` 键（也可改用独立的 `geewiki.manifest.json`） |
| 入口 | `geewiki.entry: "index.ts"`；缺省时按 `index.ts` → `index.js` → `src/index.ts` 探测 |
| 模块形态 | 默认导出 cordis 插件对象 `{ name, apply }`，`apply` 返回卸载函数 |
| 依赖 | **零依赖**：不 import 任何包，只经 `ctx.get('http')` 使用宿主提供的路由服务 |
| 热插拔 | `runtime.supportsHotReload: true`：可在管理台「插件管理」页启用/停用，即时生效 |

启用后会挂载 `GET /api/hello`，停用后该路由立即摘除：

```bash
curl -X POST 'http://127.0.0.1:3000/api/plugins/%40geewiki-plugin%2Fhello/enable' -H 'content-type: application/json' -d '{"config":{"greeting":"你好"}}'
curl http://127.0.0.1:3000/api/hello
curl -X POST 'http://127.0.0.1:3000/api/plugins/%40geewiki-plugin%2Fhello/disable'
```

补充说明：

- 插件目录**不是** pnpm workspace 包，无需安装步骤；入口里的 TypeScript 由宿主进程的 tsx loader 直接执行。
- 若插件需要第三方依赖，请在该目录内自带 `node_modules`（pnpm 的严格布局下 Node 不会向上解析到宿主的依赖）。
- 入口与 `geewiki.migrations` 目录必须位于插件目录内，任何 `../` 越界都会被拒绝并跳过该插件。
- 本示例未声明 `configSchema`，因此管理台对它只提供 JSON 原文配置编辑框；声明 schemastery `Schema` 后会自动生成表单（见 `packages/plugin-echo/src/index.ts`）。
