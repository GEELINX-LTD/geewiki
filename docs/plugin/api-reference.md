# GeeWiki 插件契约速查（API Reference）

> **本文件是索引/速查，不是事实真源。** 真源是源码符号与 [`docs/plugin-platform.md`](../plugin-platform.md)。本文件只做"叫什么、什么形状、默认值是什么、去哪核实"的表格化收敛；与源码冲突时**以源码为准并回来修本文件**。
>
> 三条阅读规则：① 出处一律「路径 + 符号名」，不写行号；② 会腐化的读数（内置插件数、测试数、SDK 版本号）**只给现算命令**；③ "可选/未标注"是本文件承认的未知，不是插件可以乱写的空间。
>
> 相关：[`index.md`](index.md)（导航）· [`anti-patterns.md`](anti-patterns.md)（陷阱）· [`compatibility.md`](compatibility.md)（版本政策）· [`review-checklist.md`](review-checklist.md)（门槛）

目录：[1 清单](#1-清单geewikimanifest--geewikimeta) · [2 runtime 与默认值](#2-geewikiruntime--normalizeruntime) · [3 服务端插件本体](#3-服务端插件本体与-ctx-面) · [4 服务名表](#4-服务名表ctxget-的-token) · [5 HTTP 路由面](#5-http-路由面httprouterservice) · [6 插槽与宿主节点目录](#6-插槽与宿主节点目录) · [7 事件](#7-事件契约) · [8 前端 bundle 与宿主 SDK](#8-前端-bundle-契约与宿主-sdk) · [9 生命周期与错误码](#9-生命周期与错误码) · [10 参考实现](#10-参考实现走读) · [11 自检与诊断](#11-自检与诊断命令) · [12 本文件缺项](#12-本文件缺项todo)

---

## 1. 清单：`GeeWikiManifest` / `GeeWikiMeta`

```ts
interface GeeWikiManifest { name: string; version: string; geewiki: GeeWikiMeta }
```

`version` **仅用于展示**（宿主不做兼容校验，见 AP-25）。`name` 建议 `@scope/name`，REST 路径里要 `encodeURIComponent`（AP-26）。
出处：`packages/core/src/index.ts` 的 `GeeWikiManifest`。

清单两种来源（`packages/manager/src/discovery.ts` 的 `parsePluginManifest`，前者**优先**）：

| 来源 | 规则 | 能承载 |
| --- | --- | --- |
| `package.json` 顶层 `geewiki` 键 | 推荐；`version` 缺失回退 `'0.0.0'`；`name` 缺失报 `invalid_manifest` | 全部字段，含 `configSchema`（schemastery 实例只能在 TS 侧构造） |
| `geewiki.manifest.json` | 存在时其内容读 `standaloneRecord['geewiki']`（**JSON 里也要套一层 `geewiki`**） | **不含** `configSchema` ⇒ 配置退化为 JSON 原文编辑（AP-13） |
| 两者都无 | `DiscoveryError('missing_manifest')`，该目录被跳过 | — |

`GeeWikiMeta` 字段全集（顺序按源码）：

| 字段 | 类型 | 口径 | 出处（`packages/core/src/index.ts` 除注明外） |
| --- | --- | --- | --- |
| `displayName` | `string?` | 面向人的短名；缺失时界面**回退 `name`** | `GeeWikiMeta.displayName` / `PluginSnapshot.displayName` |
| `description` | `string?` | 一句话说明；缺失时界面**隐藏说明区**，不得用包名/`provides`/`conflictGroup` 冒充 | `GeeWikiMeta.description` |
| `provides` | `string?` | **只是依赖图 token，不创建 cordis 服务**（AP-08） | `GeeWikiMeta.provides`；反例见 `packages/plugin-echo/src/index.ts` |
| `requires` | `string[]?` | 依赖 token（拓扑排序用）；服务依赖写这里，不写 `permissions` | `safeTopological`、`packages/manager/src/index.ts` |
| `conflictGroup` | `string?` | 互斥组；内置约定值如 `database-provider` / `search-provider` / `llm-provider` / `embedding-provider` / `oidc-provider` | `ManagerError('conflict_group')`（→409） |
| `migrations` | `string \| { default?, postgres? }?` | 方言键对应 `DatabaseAdapter.dialect`；目录取不到 ⇒ **告警后跳过**（不阻断激活）；目录必须在插件目录内（`../` 被拒） | `resolveMigrationsDirs`（`packages/manager/src/discovery.ts`）、`MIGRATION_TABLE = '_migrations'` |
| `entry` | `string?` | **后端**入口，仅外部插件；缺省按候选顺序试探 | `resolvePluginEntry`、`ENTRY_CANDIDATES = ['index.ts','index.js','src/index.ts']` |
| `runtime` | `GeeWikiRuntime?` | 见 §2 | `normalizeRuntime` |
| `client` | `GeeWikiClient?` | `{ entry?: string; css?: string }` — **没有 `assets`/`mount` 字段**，资源根 = UI 根本身；`entry` 可单段名（缺省 `'client.js'`）或分层路径（`ui/index.js`），判据 `isPluginUiEntryPath`，非法形态**整体视为未声明 ⇒ 不加载** | `GeeWikiClient`、`PLUGIN_UI_*` |
| `locales` | `Record<string,string>?` | 语言 → 相对插件目录的 JSON 路径；越界被拒；唯一允许插件覆盖的宿主键是 `OVERRIDABLE_HOST_KEYS = ['host.app.title']`；插件键必须落在 `plugin.<短名>.` 命名空间 | `packages/core/src/domain.ts`（F15）、`localeDecls` |
| `slots` | `SlotName[]?` | ★ **严格等价于 `extensions: [{ node, mode: 'extend' }]`**，不能表达 `wrap`/`replace`；非弃用字段 | `registerManifestSlots`（`packages/manager/src/index.ts`） |
| `extensions` | `ExtDeclaration[]?` | `{ node: SlotName; mode?: ExtMode }`，`mode` 缺省 `'extend'`；非法节点名/不允许的模式 ⇒ **忽略并告警，不阻断激活**（AP-12） | `packages/core/src/extensions.ts` |
| `routes` | `PluginRouteDecl[]?` | 见下表；★ 必须声明，否则冷启动直访 `#/<id>` 空白无报错（AP-10） | `PluginRouteDecl`、`routeResolution` |
| `capabilities` | `CapabilityDecl[]?` | 自定义能力名必须含 `/` 或 `:`（`PLUGIN_CAPABILITY_NAME`）；声明了却没注册求解器 ⇒ 恒 `false`（AP-11） | `packages/core/src/domain.ts`、`packages/manager/src/capabilities.ts` |
| `permissions` | `PluginPermission[]?` | **诚实清单，宿主不强制**（AP-05）；未知取值拒绝并告警 | `packages/core/src/domain.ts`、`readPluginPermissions` |
| `configSchema` | `ConfigSchema?` | = `ReturnType<typeof Schema.any<any>>`，即 **schemastery 实例**；给普通对象则视为"无 schema"（JSON 原文编辑 + 一次告警） | `ConfigSchema`、`configSchemaOf`、`PluginSnapshot.configurable` |

`PluginRouteDecl`（`geewiki.routes` 元素，F2）：

| 字段 | 默认 | 口径 |
| --- | --- | --- |
| `id` | — | 必须匹配 `PLUGIN_ROUTE_ID = /^[a-z][a-z0-9-]*$/`（不含 `/`）；`RESERVED_ROUTE_IDS` 里的 id **直接拒绝**（`audit` 已移出，由 `@geewiki/ops` 自己声明） |
| `label` + `group` | 无 | **必须同时给出**才会出现导航项；`group` 取 `'main' \| 'admin'` |
| `order` | `100` | 排在宿主内置项之后 |
| `requires` | 无 | 不填 = 对所有访问者可见（**含未登录**） |

出处：`packages/core/src/index.ts` 的 `PluginRouteDecl`、`packages/core/src/domain.ts` 的 `PLUGIN_ROUTE_ID` / `RESERVED_ROUTE_IDS`。id 冲突时**先激活者胜出**，后者整条声明被忽略并在诊断端点可见。

---

## 2. `GeeWikiRuntime` / `normalizeRuntime`

```ts
interface GeeWikiRuntime { supportsHotReload?: boolean; requiresCachePurge?: boolean; drainTimeout?: number; applyTimeout?: number }
function normalizeRuntime(r?: GeeWikiRuntime): NormalizedRuntime  // 逐字段 ?? 兜底
```

| 字段 | 默认 | 语义 | 失败后果 |
| --- | --- | --- | --- |
| `supportsHotReload` | `false` | 仅显式 `true` 才允许热操作（enable/disable/replace） | `ManagerError('hot_reload_not_supported')` → **409**；例外：恢复"基础层临时停用"的插件不受此限 |
| `requiresCachePurge` | `false` | 卸载/替换后是否走 `ctx.parallel(CACHE_PURGE_EVENT)` | 未 purged 的缓存残留（无报错） |
| `drainTimeout` | `5`（秒） | 卸载前等在途请求结算的上限 | 超时**强制卸载**并告警；`<= 0` = 跳过排空 |
| `applyTimeout` | `30`（秒，`DEFAULT_APPLY_TIMEOUT_SECONDS`） | `apply()` 结算上限；**迁移在此之前执行、不受本超时约束** | `ManagerError('load_timeout')` → **504**，且幽灵 fiber 被回收、`fiber.config` 已是新值（AP-17）；`<= 0` = 不超时 |

出处：`packages/core/src/index.ts` 的 `GeeWikiRuntime` / `NormalizedRuntime` / `normalizeRuntime`、`packages/manager/src/index.ts` 的 `withApplyTimeout`（定时器**刻意不 `unref()`** 的原因见其注释）。

其它全局常量（`packages/core/src/index.ts`）：`DEFAULT_PORT = 3000`、`DEFAULT_DATA_DIR = './data'`（相对路径以**仓库根**为基准，见 `resolveProjectPath`）、`DEFAULT_DB_FILENAME = 'geewiki.db'`、`HEALTH_PATH = '/api/health'`、`MIGRATION_TABLE = '_migrations'`。

---

## 3. 服务端插件本体与 `ctx` 面

```ts
type GeeWikiPlugin = {
  name: string
  Config?: schemastery 实例          // 也可写在 manifest.geewiki.configSchema
  apply(ctx: Context, config: Record<string, unknown>): (() => void) | void
}
```

★ **`apply` 的返回值就是卸载函数**（`review-checklist.md` 硬性项）；返回 `void` 的插件不可卸载。外部插件**不 import 任何包**（含 `@geewiki/core`），用 `interface` 手写契约（范式见 `plugins/ui-demo/src/index.ts` 的 `RouterLike` / `ContextLike`）。

`ctx` 上插件可见的面（`packages/core/src/cordis-env.ts` 对 cordis `4.0.0-rc.10` 的 `Context` 声明合并）：

| 成员 | 签名 | 关键语义 / 陷阱 |
| --- | --- | --- |
| `ctx.db` | `DatabaseAdapter` | 带 `dialect`（`migrations` 的方言键与之对应）；**必须逐次取，不要缓存快照** |
| `ctx.get(name, strict?)` | `unknown`（重载 `get('db')`） | 拿不到返回 `undefined` **而不抛错** ⇒ 取到就必须判空并 `throw`（见脚手架模板的 `if (!router) throw`）；`provide` 时序会造成期间创建的子插件拿到 `undefined`（AP-18） |
| `ctx.provide(name, value?, check?)` | `() => void`（注销函数） | 与 `geewiki.provides` **同名同存**（AP-08） |
| `ctx.plugin(plugin, config?)` | `FiberLike & PromiseLike<FiberLike>` | 子插件；`FiberLike { dispose(): Promise<void>; uid: number \| null; state: number; config?: unknown; update?(config, noSave?): Promise<void> }` |
| `fiber.update(config, noSave?)` | `Promise<void>` | 校验失败抛 `ValidationError` 且旧配置不被污染；**apply 抛错时 `fiber.config` 已是新值** ⇒ 回滚要再 `update(旧配置)` |
| `ctx.on(name, listener)` | `() => boolean` | 返回的是**注销函数**（AP-19） |
| `ctx.emit(name, ...args)` | `void` | **同步派发、无 per-listener 保护**；订阅者抛错会冒回发起端点（AP-02） |
| `ctx.parallel(name, ...args)` | `Promise<void>` | 逐个 `allSettled`；平台内**只**用于 `CACHE_PURGE_EVENT` |

出处：`packages/core/src/cordis-env.ts`（文件头：本文件**不得 import cordis 任何类型**，声明合并有解析竞态）、`docs/plugin-platform.md` §2.1。

---

## 4. 服务名表（`ctx.get()` 的 token）

下表 token 均来自 `ctx.provide(...)` 的实际调用点（字面量未内联的给常量名，值以该文件为准）。

| token | 契约类型 | 提供者（`ctx.provide` 所在符号） |
| --- | --- | --- |
| `'db'` | `DatabaseAdapter` | `packages/db-sqlite/src/index.ts`、`packages/db-postgres/src/index.ts`（同属 `conflictGroup: "database-provider"`） |
| `'http'` | `HttpRouterService` | `packages/server/src/index.ts` |
| `'manager'` | 管理器实例 | `packages/manager/src/index.ts` |
| `'slot'`（`SLOT_SERVICE_NAME`） | `SlotService` | `packages/manager/src/slot-plugin.ts`（★ 独立兄弟插件，必须排在管理器之前，AP-18） |
| `'capability-service'`（`CAPABILITY_SERVICE_NAME`） | 能力注册表 | `packages/manager/src/capability-plugin.ts`（同上；`packages/manager/src/index.ts` 里注明了**不能**在管理器 `apply` 里 provide） |
| `'wiki-service'` | `WikiService` | `packages/plugin-wiki/src/index.ts` |
| `'attachment-service'` | `AttachmentService` | `packages/plugin-wiki/src/index.ts`（内置实现；错误类 `AttachmentServiceError` 必须住 core，否则替换者自造同名类 ⇒ `instanceof` **静默失配**） |
| `'search-service'` | `SearchService` | `packages/plugin-search/src/index.ts`（`search(principal, q, {limit,mode})` / `contents(principal, slugs)`，**`principal` 是必填首参**） |
| `'auth-service'` | `AuthService` | `packages/plugin-auth/src/index.ts`（`registerOidcProvider(provider)` 同 id 重复**抛错**；`createLocalUser` **不做鉴权，绝不可直连 HTTP**） |
| `'org-service'` | 组织/成员契约 | `packages/plugin-org/src/index.ts` |
| `'policy-service'` | 可见性策略 | `packages/plugin-authz/src/index.ts` |
| `LLM_SERVICE_KEY` | LLM 适配面 | `packages/plugin-llm/src/index.ts`（provider 以"路由"形式挂进来，见 `packages/plugin-openai/src/index.ts`） |
| `EMBEDDING_SERVICE_NAME`（值 `'embedding-service'`） | `EmbeddingService` / `EmbeddingProvider` | 契约与 `probeEmbeddingProvider()` / `assertEmbeddingResult()` 在 `packages/core/src/services.ts`（语义检索按 `docs/roadmap.md` 的 L-17 **有意后置**，core 只定接口不带实现） |
| `AI_TOOL_SERVICE_NAME` | 工具注册面 | `packages/plugin-ai-tools/src/index.ts`（`side: 'client'` 的声明必须与浏览器侧 `host.registerTool` 同名配对，AP-24） |
| `'builtin-docs-service'` | 内置文档 | `packages/plugin-builtin-docs/src/index.ts` |
| `AI_JOURNAL_SERVICE_NAME` | 日志型工具 | `packages/plugin-ai-journal/src/index.ts` |

> ⚠️ `'echo-service'` **不存在**：`packages/plugin-echo/src/index.ts` 从未 `provide`，其清单也刻意不写 `provides`。写 `requires: ['echo-service']` 会被解析成"依赖已满足"，然后 `ctx.get` 拿到 `undefined`（AP-08）。

`requires` token 写法：内置包用**包名**（`@geewiki/http`，见 `packages/plugin-echo/src/index.ts`），外部示例用**服务名**（`'http-service'`，见 `plugins/ui-demo/package.json`）。两种写法的解析规则真源是 `packages/manager/src/index.ts` 的依赖解析与 `graph()`；本文件不下结论（见 §12）。

出处：`packages/core/src/services.ts`（服务契约的**单一真源**，含 `SearchService` / `AuthService` / `WikiService` / `AttachmentService` / `EmbeddingService`；**非浏览器安全**，前端不要 import）。

---

## 5. HTTP 路由面（`HttpRouterService`）

```ts
register(method: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH', path: string,
         handler: RouteHandler, opts?: RouteAccessOptions): () => void   // ★ 第 4 参可省 ⇒ access:'public'
```

| 成员（`?` = 可选，向后兼容） | 签名 | 语义 / 陷阱 |
| --- | --- | --- |
| `register` | 见上 | `path` 支持 `:param`；返回注销函数；`opts.owner` 是**可观测性字段，非安全边界**（AP-06） |
| `use?(hook)` | `(hook: RequestHook) => () => void` | 串行、任一 `ok:false` 短路；**不得自己写响应**；抛错视同 500；返回形态非法按**拒绝**处理；★**只对匹配到的路由执行** ⇒ 不构成全局鉴权（AP-06） |
| `routes?()` | `() => readonly HttpRouteInfo[]` | `HttpRouteInfo { method; path; access; capability?; explicit: boolean; owner? }`；`explicit` 区分"作者写了 public"与"作者什么都没写"；`unauditedRoutes()` 挑 `!explicit`；`GEEWIKI_STRICT_ROUTE_ACCESS=1` 时启动**拒启** |
| `ownerStats?()` | `() => readonly RouteOwnerStats[]` | 只统计登记了 `owner` 的路由；未归因的不出现（**错误归因比没有归因更危险**） |
| `stats()` / `inflight()` / `pending()` | — | 看门狗探针数据源；长连接**不计入** |
| `drain(timeoutMs)` | `(ms: number) => Promise<boolean>` | 全站语义；`false` = 仍有请求在执行；插件粒度排空未实现 |
| `trackStream?(res, owner?)` | `(res, owner?) => () => void` | SSE 等长连接单独登记；不登记 `owner` ⇒ **逃逸定向回收**（显式后果，AP-16） |
| `closeStreams?(owner?)` | `(owner?: string) => void` | 不传关全部；管理器卸载单插件时按 owner 收 |
| `noteStreamRejected?()` | `() => void` | 并发上限是**持有者的策略**，被拒时自行上报 |

`RouteAccess = 'public' | 'user' | 'admin'`（**默认 `public`**，AP-01）；`RouteAccessOptions { access?; capability?; owner? }`——`access` 与 `capability` 是**两层**（身份 vs 能力），都通过才放行。
`RouteHandlerContext { req; res; url: URL; params: Record<string,string>; json(status, body); noteStatus?(status); principal? }`——读 `principal` **必须失败关闭**（拿不到按匿名处理）；`noteStatus` 只记指标、不结束响应。
`Principal { kind: 'anonymous'|'user'|'break-glass'; userId; orgId; orgRole: 'owner'|'admin'|'member'|'viewer'|null; groupIds; sessionId }`；`breakGlassPrincipal()` 受 `GEEWIKI_ADMIN_TOKEN` 控制（**未设置则完全禁用**，无默认令牌；`orgRole` 刻意 `null` ⇒ 按 `orgRole` 授权的下游默认拒绝）。

出处：`packages/core/src/index.ts` 的 `HttpRouterService` / `RouteAccess` / `RouteAccessOptions` / `RequestHook` / `RequestVerdict` / `RouteHandlerContext` / `Principal` / `unauditedRoutes`。

---

## 6. 插槽与宿主节点目录

★ **两条最容易搞错的口径**：

1. `geewiki.slots: ['editor']` **等价于** `extensions: [{ node: 'editor', mode: 'extend' }]`——`slots` 字段**不能表达 `wrap`/`replace`**，要换实现必须写 `extensions`。
2. "能否被插件 `replace`"**不是插槽的属性**，而是 `extensions.ts` **模式目录**的属性；基数（单/多占用）在 `slots.ts` 的 `SLOT_CARDINALITY`。两列都要看。

### 6.1 内置插槽（`packages/core/src/slots.ts` 的 `SLOT_NAMES` / `SLOT_CARDINALITY`，模式来自 `packages/core/src/extensions.ts` 的 `HOST_NODE_CATALOG`）

| 插槽 | 基数 | 允许模式 | props 契约 | 说明 |
| --- | --- | --- | --- | --- |
| `app-header` | multi | `extend` | **零 props**（`zeroProps`） | 零属性是刻意的隔离裁决，勿要求宿主传数据 |
| `app-footer` | multi | `extend` | **零 props** | 同上 |
| `editor` | **single** | `extend`/`wrap`/`replace` | `EditorSlotProps` | 唯一向插件传数据的通道；**无索引签名**，加字段必须显式改类型且只允许 `?`（AP-03） |
| `editor-toolbar` | multi | `extend` | `EditorToolbarSlotProps` | 无写回通道时 `insertAtCursor?`/`replaceSelection?` **不存在**（不是空函数） |
| `app-dock` | **single** | `extend`/`wrap`/`replace` | `AppDockSlotProps` | `page: {slug; kind:'view'\|'edit'} \| null`；`invokeTool` 未登记名必须拒绝 |
| `article-summary` | **single** | `extend`/`wrap`/`replace` | `ArticleSummarySlotProps { slug; title }` | 插件**不得**自行解析 `location.hash` |
| `account-identities` | multi | `extend` | 契约在 `packages/web/src/lib/slots.tsx` 的 `AccountIdentitiesSlotProps` | core 的 `SLOT_PROPS_SCHEMA` 用 `contract` 指向它（既有不对称） |

各节点的 `propsVersion` 见 `HOST_NODE_CATALOG`；插件在 `props.propsVersion` 收到，**不匹配时不要渲染**（让宿主默认生效）。约定：只做加法不变，删字段/改语义必须 **+1**。
零属性以外的 props 规格也经 `GET /api/plugins/slots` 的 `props` 字段下发（`SlotPropsSpec` / `SlotPropSpec`），供无 TS 的外部插件自助查询；守卫测试 `packages/core/test/slot-props-schema.test.ts`、`packages/web/test/slotPropsMirror.test.ts`。
**能力缺失一律用 `undefined` 表达，不用空实现。**

### 6.2 自定义扩展点

| 规则 | 判据 |
| --- | --- |
| 必须含 `/` | `PLUGIN_SLOT_NAME = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/`；不含 `/` 又不在 `SLOT_NAMES` ⇒ **按笔误拒绝并告警**（AP-12） |
| 宿主节点 id 一律不含 `/` | 命名判据本身；一旦宿主名含 `/` 就无法区分笔误与新扩展点 |
| 未声明的自定义插槽默认基数 `multi` | `slotCardinalityOf(slot, declared?)` |
| 插件自定义扩展点**只允许 `extend`** | `PLUGIN_ONLY_MODES`——宿主不为别人的扩展点背书 `replace`/`wrap` |
| 出口组件 | `host.PluginSlotOutlet`，props `{ name, props?, single? }` |

### 6.3 宿主节点目录（`HOST_NODE_CATALOG`，`extModesOf()` / `supportsExtMode()`）

| 组 | 节点 | 允许模式 |
| --- | --- | --- |
| shell | `shell-brand`、`shell-brand-text`（只换字样，保留宿主链接/图标）、`shell-theme-toggle`、`shell-command-palette`、`shell-status-dialog` | `extend`/`wrap`/`replace` |
| shell（容器） | `shell-header`（`nestedSlots: ['app-header']`）、`shell-footer`（`['app-footer']`） | `extend`/`wrap`/`replace`；★外壳与内层出口**宿主独占**，`replace` 删不掉别人的贡献（AP-23） |
| page（元素级，不做整页替换） | `wiki-meta`、`wiki-actions`、`wiki-toc`、`graph-toolbar`、`account-profile` | `extend`/`wrap`/`replace` |
| ui（非 portal） | `ui-badge`、`ui-button`、`ui-card`、`ui-empty-state`、`ui-error-notice`、`ui-error-state`、`ui-input`、`ui-textarea`、`ui-loading-state`、`ui-skeleton`、`ui-spinner` | `extend`/`wrap`/`replace` |
| ui（portal） | `ui-dialog-content`、`ui-dropdown-menu-content`、`ui-confirm-dialog`、`ui-tooltip` | `extend`/`replace`，**不含 `wrap`**（AP-22） |
| ✗ 不存在 | `shell-sidebar` | 宿主外壳里没有这个元素，登记了就是静默失败 |

`replace`/`wrap` **恒单占用**（`modeCardinalityOf()`）：多方声明按激活顺序**最早者胜出**，其余进 `suppressed` 并在 `GET /api/plugins/slots` 可见——**被抑制者仍 `active`、bundle 照样加载**。判据真源 = 后端仲裁（主）+ 入口表生效集合（次），前端闸门在 `packages/web/src/lib/pluginUi.ts`（AP-04）。

出处：`packages/core/src/slots.ts`（浏览器安全真源、零 `node:*`）、`packages/core/src/extensions.ts`、`packages/core/src/index.ts` 的 `SlotService` / `SlotContribution` / `SlotContributionMeta`（`lazy` 未给 `importPath` 时回退 `client.entry`）、`docs/plugin-platform.md` §4.9–§4.10。

`SlotService`（`ctx.get('slot')`）成员：`contribute(owner, slot, meta?)`、`extend(owner, node, mode, meta?)`（未知节点/不允许的模式/自定义点上的 replace|wrap ⇒ **拒绝并告警，不抛**）、`define(owner, slot, meta?)`、`declarations()`、`list(slot?)`、`ownersOf(slot)`、`release(owner)`；均返回 `() => void`（`define`/`contribute`/`extend`）。同一 `(owner, node)` **只有一条**记录，重复登记覆盖 `mode` 并告警。

---

## 7. 事件契约

| 常量 | 事件名 | 负载 |
| --- | --- | --- |
| `CACHE_PURGE_EVENT` | `geewiki/cache-purge` | — （唯一走 `ctx.parallel` 的） |
| `PAGE_SAVED_EVENT` | `geewiki/page-saved` | `PageSavedEvent { slug; title; updatedAt; outcome: 'created'\|'updated'; actorId: number\|null }`（**无 `'unchanged'`**） |
| `PAGE_CREATED_EVENT` | `geewiki/page-created` | — |
| `PAGE_DELETED_EVENT` | `geewiki/page-deleted` | `PageDeletedEvent { slug; actorId }` |
| `USER_LOGIN_EVENT` | `geewiki/user-login` | `UserLoginEvent { userId; method: 'password'\|'oidc'\|'session' }`（`method` **不得**用于安全判定） |
| `SEARCH_PERFORMED_EVENT` | `geewiki/search-performed` | `SearchPerformedEvent { query; hits; actorId }` |
| `ATTACHMENT_UPLOADED_EVENT` | `geewiki/attachment-uploaded` | `AttachmentUploadedEvent { id(sha256 hex); slug; name; size; mime; actorId }` |
| `PLUGIN_ACTIVATED_EVENT` | `geewiki/plugin-activated` | `PluginLifecycleEvent { name; provides; error? }`；发射时机 = apply 已结算 = **provide 可见性解开的那一刻**（依赖方延迟绑定的正规触发点） |
| `PLUGIN_DEACTIVATED_EVENT` | `geewiki/plugin-deactivated` | 同上 |

**没有 `page-renamed`**——wiki 无重命名操作，定义无发射点的事件等于"谎报的 token"（与 AP-08 同源）。
订阅者三铁律：一律 `ctx.emit` 同步广播不等待 / 订阅者**必须自己吞掉全部异常**并自行 `void (async () => …)()` / 负载不放正文与凭据。平台**不做去抖**。
出处：`packages/core/src/index.ts`（事件常量与 `PageSavedEvent` 等类型的注释）。

---

## 8. 前端 bundle 契约与宿主 SDK

两种入口形态（同一归属语义）：

```ts
export function register(host): () => void          // 推荐：宿主注入作用域宿主，返回值 = 卸载函数
(globalThis as any).__GEEWIKI_HOST__                 // 顶层形态：0.12.0 起它「就是」作用域宿主（P13）
```

作用域宿主类型 `PluginUiHost`（`packages/web/src/lib/pluginUi.ts`）= 完整 SDK + **`readonly pluginName: string`**（全局 SDK 上没有这个字段，可用于自检归属，见 `packages/web/fixtures/src/index.tsx`）+ 过闸门的 `registerSlot`/`registerExtension`。
现算 SDK 版本：`grep -n HOST_SDK_VERSION packages/web/src/lib/hostSdk.ts`（本文件不写死读数）。

| SDK 成员 | 首个可用版本 | 签名与要点 |
| --- | --- | --- |
| `React` / `jsxRuntime` | ≤ 0.3.x（源码未逐条标注） | **宿主那一份**实例；自带第二份 React ⇒ `useState` of null（AP-21） |
| `registerSlot(name, component)` | ≤ 0.3.x | 返回注销 token |
| `unregisterSlot(name, token?)` | ≤ 0.3.x | ★ **不传 token = 清空该插槽**（含别人的贡献，AP-19） |
| `renderMarkdown(md): string` | ≤ 0.3.x | 与宿主同一条 marked→DOMPurify 管线；消毒白名单是安全边界单点 |
| `registerTool(name, execute)` / `unregisterTools(source)` / `invokeTool(name, args)` / `clientTools` | ≤ 0.3.x | 重名**抛错**；`invokeTool` 未登记**抛错**；`clientTools` 是 **getter，必须每次现读**（AP-24） |
| `PluginSlotOutlet` / `slotContributors(name)` / `useSlotEntries(name)` | **0.4.0** | 插件自定义扩展点出口，props `{ name, props?, single? }` |
| `registerRoute(id, component)` / `unregisterRoutes(source)` | **0.5.0** | `id` **必须先写进 `geewiki.routes`**（AP-10） |
| `ReactDOM` / `ReactDOMClient` / `createPortal` / `createRoot` / `hydrateRoot` | **0.6.0**（F6） | `createRoot` 宿主**不代管卸载**，必须自己在清理函数里 `root.unmount()` |
| `registerMarkdownExtension(ext)` / `unregisterMarkdownExtensions(owner)` / `markdownExtensions` | **0.7.0** | 产出 HTML 字符串、照旧过 DOMPurify ⇒ **无法**借此执行脚本 |
| `registerTheme({name, light, dark})` / `unregisterThemes(owner)` / `themeContributors` | **0.8.0** | **只能覆盖 `--gw-*` 原始 token**，`--color-*` 被拒；同 token 注册在前者胜 |
| `t(key, params?)` / `getLocale()` | **0.9.0**（F15） | 键必须写在自己命名空间 `plugin.<短名>.…`；**缺失返回键名本身**，绝不返回空串 |
| `registerExtension(node, component, opts?)` | **0.10.0**（P4） | `opts.mode` 缺省 `'extend'`；渲染失败宿主**回退默认实现** |
| ↳ `opts.shadow` | **0.11.0**（P9） | **仅 `replace` 有意义**；在 `wrap`/`extend` 上传会被忽略并告警 |
| ↳ 加载期 `window.__GEEWIKI_HOST__` = 作用域宿主 | **0.12.0**（P13） | 在此之前顶层来源恒为 `'host-sdk'` ⇒ 收不回 + 绕过闸门（AP-04） |
| `version` | — | 只当信息用；**兼容判定靠特性探测**（AP-25、[`compatibility.md`](compatibility.md)） |

特性探测的推荐写法（**探测能力而不是比版本号**）：`host.registerExtension?.(node, Comp, { mode: 'wrap' }) ?? (() => {})`。
UI 产物构建：外部插件的 UI 根被硬编码为 `<插件目录>/dist`（`resolvePluginUiRoots`，`packages/manager/src/plugin-ui.ts`），而 `dist/` 被仓库根 `.gitignore` 全局忽略 ⇒ 必须加逐插件例外（AP-15）。示例插件产物用 `pnpm --filter @geewiki/web run build:fixtures` 生成（脚本见 `packages/web/package.json` 的 `build:fixtures`，该脚本会先 `rm -rf public/plugins-ui`）。
静态层根表**禁止缓存**，入口表走 `revision` + `rev` 与 304 短路，动态 import 需 `/* @vite-ignore */` ⇒ 改前端产物后请**整页刷新**。出处：`docs/plugin-platform.md` §4.2–§4.5。

---

## 9. 生命周期与错误码

| 阶段 | 符号 | 要点 |
| --- | --- | --- |
| 注册 | `defaultRegistry` / `buildRegistry`（`packages/server/src/index.ts`） | 注册序 ≠ 激活序；外部插件经 `loadExternalPlugins` 合并，`issues` 透出到 `GET /api/plugins` |
| 装载次序 | `main` → `app.plugin(slotPlugin)` → `app.plugin(capabilityPlugin)` → `app.plugin(PluginManagerPlugin, …)` | ★ 前两者**必须**在管理器之前（AP-18） |
| 引导 | `GeeWikiManager.boot` | 读双层清单（`plugins.base.json` + `plugins.session.json`）→ `safeTopological` 拓扑排序 → 逐个激活；**单个失败不阻断宿主**、错误可查询 |
| 加载 | `loadPluginModule`（**私有**） → `withApplyTimeout` | `await import(pathToFileURL(entryAbs).href)` 后取 `mod.default ?? mod`；`apply` 超时 → `load_timeout`（504） |
| 清单登记 | `registerManifestSlots` | `slots`/`extensions` 在此进 `SlotService`；非法值忽略并告警 |
| 激活完成 | `emitPluginActivated` → `PLUGIN_ACTIVATED_EVENT` | 此刻 `provide` 对外可见 |
| 卸载 | `unloadPlugin`（**私有**）：`closeOwnStreams(name)` → `slots.release(name)` → `drainBeforeUnload(name)` → `fiber.dispose()` | 顺序刻意：先收流、撤贡献，再排空，最后 dispose；`drainBeforeUnload` 按 `normalizeRuntime().drainTimeout` 调 `HttpRouterService.drain`（**插件粒度的在途请求排空尚未实现**） |
| 停用 | `disable(name)` | 基础层插件走**进程内临时停用**（`runtimeDisabled: true`，不写清单，重启后仍启用）；会话层条目被移除 |
| 热替换 | `replace(name, config, …)` | 原子换 provider + 自动回滚；失败 → `replace_rollback_failed`（500）；被顶替者属基础层 → `base_layer`（409） |
| 持久化 | `persistSession()` | 会话层合并进基础层 |
| 全量清理 | `disposeAll()` | 逐个 `unloadPlugin`，错误聚合上抛 |
| 看门狗 | `startWatchdog` / `watchdogTick` + `decideWatchdog`（`packages/manager/src/watchdog.ts`） | `{action:'none'\|'rollback'\|'meltdown'}`；试用期回滚**只绑最近一次会话层激活的插件**在其 `gracePeriodMs`（默认 5000）内造成的 5xx；`meltdown` 仅在会话层非空且连续失败达 `meltdownThreshold`（默认 3）时清会话退出；两者都落 `crash.marker` ⇒ 下次启动**忽略会话层、回退基础层** |

`ManagerError.code` → HTTP（`fail(h, err)`，`packages/manager/src/index.ts`）：

| code | HTTP |
| --- | --- |
| `not_found` | 404 |
| `payload_too_large` | 413 |
| `load_timeout` | **504** |
| `replace_rollback_failed` | 500 |
| `conflict_group`、`hot_reload_not_supported`、`hot_dependency_not_supported`、`provider_mismatch`、`has_dependents`、`base_layer`、`hot_update_failed`、`migration_failed` | **409** |
| 其余 | 400 |

`DiscoveryIssue.code`（`packages/manager/src/discovery.ts`）：`missing_manifest`、`invalid_manifest`、`entry_not_found`、`invalid_plugin_path`、`invalid_plugin_dir`、`duplicate_plugin`、`invalid_module`、`load_failed`。单个插件失败只记 issue 并跳过，**绝不阻断宿主启动**（唯一例外 `invalid_plugin_dir` 已收敛，见 `docs/plugin-platform.md` §5.3 L-11）。
`IntegrityStatus`（`packages/manager/src/plugin-install.ts`）：`ok` \| `drift` \| `unsigned` \| `missing`——**`unsigned` 不等于通过**。
`AttachmentServiceError.code`：`payload_too_large`→413、`length_mismatch`→400、`storage_unavailable`→**503**（避免磁盘满升级成看门狗熔断）。

管理器注册的 REST 面（同一文件，节选）：

| 端点 | access | 备注 |
| --- | --- | --- |
| `GET /api/plugins` | public | 非 owner/admin/break-glass **看不到 `config`**；含 `issues` |
| `GET /api/plugins/graph` | public | `PluginGraph { nodes, edges }` |
| `GET /api/plugins/slots` | public | 裁决/冲突/`suppressed`/`props`；**必须每次现算，不走 304** |
| `GET /api/plugins/ui` | public | 入口表（`entries` / `skipped` / `revision`） |
| `GET /api/session`、`GET /api/i18n` | public | — |
| `POST /api/plugins/:name/enable\|disable\|replace`、`GET\|PUT /api/plugins/:name/config`、`GET /api/backup`、`GET /api/plugins/integrity` | admin | `:name` 需 `encodeURIComponent`（AP-26） |

响应信封：成功 `{ ok: true, ...body }`（`ok(h, body)` 辅助函数）。

---

## 10. 参考实现走读

| 参考 | 值得抄什么 | 值得**避开**什么 |
| --- | --- | --- |
| `plugins/ui-demo/`（`package.json` + `src/index.ts` + `dist/` 产物） | 外部插件完整形态：`requires: ['http-service']`、`client: {entry:'client.js',css:'client.css'}`、`slots: ['app-header','app-footer']`、`extensions: [{node:'shell-brand-text',mode:'wrap'}]`、`apply(ctx)` 里 `ctx.get('http')` 缺失即 `throw`、**返回注销函数** | ① `provides: 'ui-demo-service'` 但代码里没有 `ctx.provide` ⇒ **AP-08**；② `RouterLike.register` 只声明 3 参 ⇒ 生成的路由匿名可调 ⇒ **AP-01**；③ `dist/` 不入库 ⇒ 干净检出需先 `build:fixtures` ⇒ **AP-15** |
| `plugins/hello-geewiki/`（`index.ts` + `README.md`） | 零依赖最小后端：`entry: 'index.ts'`、config `greeting`/`uppercase`、未声明 `configSchema` ⇒ 管理台只给 JSON 原文编辑框；README 给了带编码插件名的 curl 与"需要第三方库须自带 `node_modules`"的口径 | 同样是 3 参注册（AP-01） |
| `packages/web/fixtures/src/index.tsx` | 前端产物的**真实源码**：`export function register(host): () => void`、特性探测 `host.registerExtension?.(...)`、顶层形态用 `hostAtEval?.pluginName` 判身份、自带最小 `PluginUiHost` 声明（不依赖宿主源码路径）、`CounterWidget` 证同一 React 实例、`ThrowerWidget` 验错误边界 | — |
| `packages/plugin-echo/src/index.ts` | **`provides` 的正确处理**：刻意撤销 `provides`，注释写清"谎报的 token"后果；`runtime: {supportsHotReload: true, requiresCachePurge: false, drainTimeout: 5}`；`requires: ['@geewiki/http']` | — |
| `packages/plugin-search/src/index.ts` | `ctx.provide('search-service', svc)` + 注销 + 导出契约类型；`requires: ['wiki-service','llm-service']`；`conflictGroup: "search-provider"`；`migrations: { default: 'migrations', postgres: 'migrations/postgres' }`（**FTS5 依赖 SQLite ⇒ postgres 方言下无迁移，由插件在 apply 里显式拒绝**） | — |
| `packages/plugin-openai/src/index.ts` | provider 的正确形态：**注册进 `llm-service` 的"路由"**而不是自建 provider；端点/模型名全部来自配置（默认值一律用 `https://api.example.com/v1` 这类占位，**不要沿用仓库里那个私有端点**） | — |
| `packages/manager/src/scaffold.ts` | 脚手架生成物即"最小契约"：`package.json` + `index.ts` + `dist/client.js` + `dist/client.css`(仅 `--ui`) + `README.md`；`gitignoreLinesFor(name)` 给出该加的两行例外 | 生成的清单与代码**同时**继承 AP-01 与 AP-08 |

内置清单的两个真源：可启用集合看 `defaultRegistry()`（`packages/server/src/index.ts`），默认启用集合看 `config/plugins.base.example.json` 的 `enabled`（同目录 `plugins.base.json` 是本机现状，**不可当口径**）。二者数量**不相等**：已注册未写入默认基础层的至少有 `@geewiki/postgres`、`@geewiki/editor-plain`、`@geewiki/oidc`、`@geewiki/echo`。数量与全集一律现算，勿写死。

---

## 11. 自检与诊断命令

```bash
# 清单被发现了什么、为什么没加载
curl -s localhost:3000/api/plugins | jq -r '.plugins[] | [.state, .layer, .source, .name] | @tsv'
curl -s localhost:3000/api/plugins | jq '.issues'                       # 发现期失败（装了但没加载）
# 插槽/扩展点裁决：我的贡献在不在？被谁抑制了？
curl -s localhost:3000/api/plugins/slots | jq '.slots, .conflicts, .suppressed'
# 前端入口表：UI 产物有没有被发现、被推迟了吗
curl -s localhost:3000/api/plugins/ui  | jq '.entries, .skipped'
# 路由访问等级审计（未显式声明的会被聚合成一条启动告警）
GEEWIKI_STRICT_ROUTE_ACCESS=1 pnpm run dev:server   # 有未声明 access 的路由 ⇒ 直接拒启
# 完整性（F17）：ok / drift / unsigned / missing
curl -s localhost:3000/api/plugins/integrity | jq '.reports[] | {name, status}'
# 产物是否被 git 忽略（无输出才算过关）
git check-ignore -v plugins/<name>/dist/client.js
```

健康检查判据（`HEALTH_PATH`）：`ok === true && db.present === true`——只判 HTTP 200 会误判（数据目录不可写时 `db-sqlite` 激活失败但接口仍返回 200）。

---

## 12. 本文件缺项（TODO）

| 缺项 | 原因 | 建议处置 |
| --- | --- | --- |
| `requires` 里 `'http-service'` 与 `'@geewiki/http'` 两种写法的**解析规则**（是否等价、谁做别名） | 只观察到两处事实，未读依赖解析实现 | 由 Explore/Implementer 确认后在本节补一行；确认前**照抄同类插件的写法**（内置用包名、外部示例用服务名） |
| `LLM_SERVICE_KEY` / `AI_TOOL_SERVICE_NAME` / `AI_JOURNAL_SERVICE_NAME` 的**字面量值** | 只核到常量名与 provide 调用点 | 用 `grep -n "AI_TOOL_SERVICE_NAME ="` 等现算；不要在文档里抄成字面量 |
| `LlmRouteContext` / `registerProvider` / `llmServiceFrom` 的完整签名 | 本轮未逐行读 `packages/core/src/llm.ts` | 写 LLM provider 前先读该文件；本节刻意不列 |
| `ThemeContribution` / `MarkdownExtension` / `ResolvedRoute` / `CapabilityState` 字段 | 只核到 SDK 侧入口，未逐字段读 | 需要时读 `packages/web/src/lib/{themes,markdownExtension}.ts`、`packages/core/src/capability*.ts` |
| `mount`/`assets` 类"资源清单"字段 | 核实结论：`GeeWikiClient` **只有** `entry?`/`css?`，资源根 = UI 根 | 已按事实写在 §1；若将来新增字段需同步本表 |
| `@geewiki/openai` 式 provider 的失败降级语义 | 未逐行读 `packages/plugin-openai/src/index.ts` | 待与 `anti-patterns.md` 的"提供方替换"合并条目 |
| 平台侧待办（默认 `access` 改 fail-closed、权限强制、发布者签名）的**台账编号** | 台账 `docs/agent/backlog.md` 与 `docs/adr/` 由并行任务落地 | 落地后把编号回填到 `anti-patterns.md` AP-01/AP-05/AP-14 的"待办"处 |
