# 0002. 后端运行期直接跑 TypeScript

- 状态：`accepted`（回填：这是本仓最底层的事实之一，改动会立刻波及全部包）
- 记录日期：2026-09-28
- 关联：ADR-0001（依赖图）、ADR-0007（外部插件加载）、ADR-0009（最小部署）

## 技术背景

除 `@geewiki/web`（要打包给浏览器）之外，其余包都是「源码即发布物」：
`packages/*/package.json` 的 `exports` 直接指向 `./src/index.ts`，`tsconfig.base.json` 是
`noEmit: true` 且 `declaration: false` —— **没有构建产物可言**。

问题是：Node 不认 TypeScript，那这些源码在开发、测试、生产容器里分别怎么被执行？

## 考虑选项

| 选项 | 为什么不选 |
|---|---|
| 先编译再跑（`tsc` 出 `dist/`） | 28 个包要维护项目引用与构建顺序；`exports` 得改成双指向；开发期多一层「我改的是源码还是产物」的困惑 |
| `ts-node` 一类带类型检查的加载器 | 每个入口都做一次全量类型检查，启动慢到不能接受（类型检查已经有 `pnpm typecheck` 这个专职门禁） |
| **运行期由 tsx 转译** | 见下方决策 |

## 决策结果

**运行期用 `tsx` 转译，不做构建步骤。** 三个入口都是同一形态：

- `package.json` 的 `dev:server` 与 `start` 同为 `tsx packages/server/src/index.ts`；
- 生产 `Dockerfile` 的 `CMD ["tsx", "/app/src/index.ts"]`（基础镜像 `node:26-bookworm-slim`，builder / runtime 两段同基础镜像）；
- 测试用 `node --import tsx --test test/*.test.ts`（各包 `package.json` 的 `test` 脚本），
  根 `test` 脚本另有 `--experimental-strip-types`，与前者**是两条执行路径**——这是「本地能过、CI 红」的经典来源。

类型检查是**独立门禁**（`pnpm typecheck` → `tsc -b`），不参与运行期。

## 后果

**正面**

- 声明期类型与运行期实现**不可能漂移**：`exports` 指的就是那份 TS，跨包 import 直接拿到真实类型。
- 改完即跑。`pnpm dev` = `dev:server` + `dev:web` 两条 watch，后端**零构建**。
- 外部插件因此可以就是**一个 `.ts` 文件**：`packages/manager/src/discovery.ts` 的 `ENTRY_CANDIDATES`
  第一个候选就是 `index.ts`，`loadExternalPlugins()` 用 `import(url)` 直接吃源码。
  这条不是开发便利，是**外部插件机制的前提**（详见 ADR-0007）。

**负面 / 风险（如实）**

- **生产镜像里跑着 tsx**，转译发生在用户机器上：首个请求更慢、常驻内存更高，且 tsx 自身成为生产依赖。
- **启动失败点会指向 `src/*.ts` 的真实行**，而不是产物行——排障时别按 `dist/` 找。
- **「改了没生效」这类问题不再有构建失败来暴露**，只能靠重启进程与看 `[plugin]` 日志。
  热更新因此是例外而不是常态（`normalizeRuntime` 默认 `supportsHotReload: false`）。
- **内置插件是静态 `import`**（`packages/server/src/index.ts` 顶部逐个 import 各插件模块，
  再由 `defaultRegistry()` 组装成 manifest + module 配对），**只有外部插件是动态 `import`**。
  所以「运行期跑 TS」并不等于「内置插件可插拔」：删一个内置插件要改代码，动配置只能停用。

## 证据与参考

- `package.json`（`dev:server` / `start` / `test` / `typecheck`）、`Dockerfile`（`FROM` 两处、`CMD`）
- `tsconfig.base.json`（`noEmit`、`declaration: false`、`module: NodeNext`）
- `packages/server/src/index.ts`（静态 import + `defaultRegistry()`）、`packages/manager/src/discovery.ts`
- `docs/adr/0001-cordis-plugin-graph-and-node-http.md`、`docs/adr/0007-two-layer-manifest-and-watchdog.md`
