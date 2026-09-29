# GeeWiki 插件开发总入口

> 读者有两类：人类插件作者，以及替人类写插件的 AI agent。本篇只回答三个问题：**该不该写这个插件**、**该写哪一种形态**、**该读哪一篇**。
>
> 契约的唯一真源是 `docs/plugin-platform.md` 与源码。本篇**不复述**那 86KB 的散文，只做导航与决策；速查表见 [`api-reference.md`](api-reference.md)。

- 配套文档：[`quickstart.md`](quickstart.md)（从零到跑通）、[`api-reference.md`](api-reference.md)（契约速查）、[`anti-patterns.md`](anti-patterns.md)（静默失败陷阱）、[`compatibility.md`](compatibility.md)（兼容性政策）、[`review-checklist.md`](review-checklist.md)（收录/合并门槛）
- 上游真源：[`../plugin-platform.md`](../plugin-platform.md)（插件契约事实真源）、[`../architecture.md`](../architecture.md)、[`../README.md`](../README.md)（docs 事实真源表纪律）

---

## 1. 动手前必须记住的三条原则

这三条来自 `README.md` 与 `docs/architecture.md` 的产品理念。它们不是口号——每一条在源码里都有对应的**代价**，而代价通常落在插件作者身上。

### 原则一：万物皆插件，内置与第三方走同一套接口

内核是 cordis 插件图（`docs/plugin-platform.md` §2.1），宿主自身的能力（数据库、HTTP、鉴权、组织、Wiki、搜索、LLM）全部由内置插件提供。你写的外部插件和 `@geewiki/wiki` 在清单字段、激活流程、依赖裁决上**没有区别**——外部插件目录里只需要一个 `package.json` 的 `geewiki` 键，不需要安装成依赖（`pnpm-workspace.yaml` 的 `packages` 只含 `packages/*`，`plugins/` 刻意不是 workspace 包）。

**代价**：正因为同构，宿主**不为你兜底**。清单没写的东西就是没声明，声明与运行期行为不一致宿主只告警不阻断（见 [`anti-patterns.md`](anti-patterns.md) 的「静默」系列条目）。同时你也**拿不到任何内部特权**：想读正文得走 `ctx.get('wiki-service')` 带主体读，而不是开后门。

### 原则二：极致轻量，不绑厂商

运行期依赖只有一个纯 `node:http`，SQLite 走内建 `node:sqlite`（`docs/architecture.md`）。对插件的含义是：外部插件**不是** workspace 包，没有安装步骤，入口 TS 由宿主进程的 tsx loader 直接执行；pnpm 严格布局下 Node **不会**向上解析到宿主依赖，所以真要第三方库只能在该插件目录内自带 `node_modules`（口径见 `packages/hello-geewiki/README.md`）。前端 bundle 不得自带 `react`/`react-dom`——宿主通过 import map 把 `react`、`react/jsx-runtime`、`react-dom` 映射到宿主那一份实例，自带两份 React 会让 portal/错误边界静默崩（现象见 `packages/web/fixtures/src/index.tsx` 的 `CounterWidget` 注释）。

**代价**：没有依赖解析、没有锁文件、没有构建产物校验。你引入的每一克重量都由宿主进程直接承担，所以 `apply()` 有默认 30 秒超时（`normalizeRuntime`，`packages/core/src/index.ts`）。

厂商中立是硬要求：**不要**在插件清单或默认配置里写死某家私有端点或模型名。LLM 一律经 `llm-service` 抽象（参考实现 `packages/plugin-openai/src/index.ts`：它是 `llm-service` 的"路由"而非 provider，端点/模型名全部来自配置）。本文档系列的示例统一用 `https://api.example.com/v1` 占位。

### 原则三：安全可控 —— 但当前靠"可审计"，不靠"强制"

平台的安全模型是**声明 + 可见 + 可回归**，而不是沙箱：

- `geewiki.permissions`（`packages/core/src/domain.ts` 的 `PLUGIN_PERMISSIONS`）是**诚实清单**，宿主**不做拦截**；
- `router.register()` 的访问等级**默认 `'public'`**（`RouteAccess`，`packages/core/src/index.ts`），漏写第 4 参的端点匿名可调；
- 插件与宿主**同进程、同权限**，无沙箱、无资源配额（`docs/plugin-platform.md` §5.1）。

**代价（对你）**：审计责任在作者侧。显式写 `access`、显式写 `permissions`、显式写 `slots`——这三处"显式"是 [`review-checklist.md`](review-checklist.md) 的硬性 gate。**代价（对用户）**：清单只能保证"知道"，不能保证"没做"。这不是文档措辞问题，是架构现状，已登记在 `docs/plugin-platform.md` §5.1。

> 这三条与理念冲突之处的完整列表见本文末尾 [§7 诚实清单](#7-诚实清单现状与理念的冲突处)。

---

## 2. 动手前先自查：这个需求真的需要新插件吗

GeeWiki 的能力绝大多数本身就是插件，因此"新写一个插件"经常不是最优解。**逐项勾选，全部为"否"才继续。**

内置清单的真源有两个，二者**数量不相等**（不要在任何文档里写死数字，按下面命令现算）：

| 问题 | 真源 |
| --- | --- |
| 哪些插件**可被启用**（注册表） | `packages/server/src/index.ts` 的 `defaultRegistry()` 返回数组 |
| 哪些插件**默认就启用** | `config/plugins.base.example.json` 的 `enabled`（注意同目录 `plugins.base.json` 是本机现状，不能当口径） |
| 本机**此刻**的激活态 | `curl -s localhost:3000/api/plugins \| jq -r '.plugins[] \| [.state, .layer, .name] \| @tsv'` |

已注册但**刻意不写进默认基础层**的插件（要用得显式启用）：`@geewiki/postgres`（与 `@geewiki/db-sqlite` 同属 `conflictGroup: "database-provider"`，切库是显式决策）、`@geewiki/editor-plain`（替换默认编辑器，必须使用者显式决定）、`@geewiki/oidc`（需外部 IdP）、`@geewiki/echo`（契约示例）。以 `defaultRegistry()` 为准。

```
[ ] 1. 需求已被 defaultRegistry() 里某个内置插件覆盖？→ 只需配置/启用，不需要写代码。
[ ] 2. 只是想在界面上加一小块？→ 现有插槽与宿主节点目录（api-reference 的表）里可能已有落点。
[ ] 3. 只是想让某个已有区域长得不一样？→ 扩展点 mode 有 extend / wrap / replace 三档，先试 extend。
[ ] 4. 只是想改一份文案/配色？→ geewiki.locales + host.t()，或 registerTheme（只能覆盖 --gw-* 原始 token）。
[ ] 5. 想在已有插件的行为上加一小块？→ 在该插件的包内改（若它是内置包且改动属于它的职责边界），比新建一个包更好维护。
[ ] 6. 想加一种"提供方"（LLM/搜索/嵌入/登录/数据库）？→ 已有 *_service 抽象 + conflictGroup 约定，照着参考实现写一个 provider/路由插件，而不是新造一套服务。
[ ] 7. 以上都不是，确实需要一个新扩展点？→ 继续，并且先读 anti-patterns.md 的「静默」系列。
```

如果你需要的是**新的宿主扩展点**（现有 `HOST_NODE_CATALOG` 里没有落点），这属于宿主改动而不是插件改动：需要在 `packages/core/src/slots.ts`（插槽）或 `packages/core/src/extensions.ts`（宿主节点目录）登记，并同步 props 契约与 `propsVersion`。这条路要走 `review-checklist.md` 的宿主改动部分。

---

## 3. 分层导航：我要做什么 → 该读哪一篇

| 我要做的事 | 形态 | 主要落点 | 先读 |
| --- | --- | --- | --- |
| 加一个只读 JSON 接口 | 后端 | `ctx.get('http').register(...)` | [`quickstart.md` §2](quickstart.md)，然后**必读** [`anti-patterns.md` #1](anti-patterns.md) |
| 给某个已有区域加一小块 UI | 前端 bundle | `geewiki.slots` / `geewiki.extensions` + `host.registerSlot` | [`api-reference.md` §宿主 SDK](api-reference.md)、参考 `plugins/ui-demo/` |
| 在别人的按钮/输入框外面套一层 | 前端 bundle | `registerExtension(node, C, { mode: 'wrap' })` | [`api-reference.md` §宿主节点目录](api-reference.md)、[`anti-patterns.md` #8](anti-patterns.md) |
| 换掉默认编辑器 | 前端 bundle | `extensions: [{ node: 'editor', mode: 'replace' }]` | **必读** [`anti-patterns.md` #9](anti-patterns.md)（附件上传红线） |
| 加一个自己的页面 + 导航项 | 前端 bundle | `geewiki.routes` + `host.registerRoute(id, Comp)` | [`anti-patterns.md` #4](anti-patterns.md)（漏声明 ⇒ 点导航项空白无报错） |
| 换掉管理台的配置表单 | 前端 bundle | `registerExtension('ui-dialog-content', …, { mode: 'replace', shadow: true })` | 参考 `packages/web/fixtures/src/index.tsx` |
| 加一种登录方式（OIDC 类） | 后端 | `auth-service.registerOidcProvider()` + `conflictGroup: "oidc-provider"` | `packages/plugin-oidc/src/index.ts`；服务契约在 `packages/core/src/services.ts` |
| 加一家 LLM 供应商 | 后端 | 注册进 `llm-service` 的路由（不自建 provider） | `packages/plugin-openai/src/index.ts` |
| 加一种嵌入/语义检索后端 | 后端 | `EMBEDDING_SERVICE_NAME` + `probeEmbeddingProvider()` | `packages/core/src/services.ts` |
| 换搜索后端 | 后端 | `SearchService` 契约 + `conflictGroup: "search-provider"` | `packages/plugin-search/src/index.ts`（注意 SQLite FTS5 方言限制与 `geewiki.migrations` 对象形态） |
| 换数据库后端 | 后端 | `conflictGroup: "database-provider"` + `migrations: { default, postgres }` | `packages/plugin-postgres/src/index.ts` |
| 加一个 AI 工具（服务端执行） | 后端 | `ai-tool-service` 注册 | 内置 `@geewiki/ai-tools` |
| 加一个 AI 工具（浏览器执行） | 前端 bundle | `host.registerTool()` + 服务端声明 `side: 'client'` | [`api-reference.md` §宿主 SDK](api-reference.md)（名字必须两侧配对） |
| 加主题配色 | 前端 bundle | `host.registerTheme()` | 只能覆盖 `--gw-*` 原始 token；`--color-*` 语义 token 会被拒绝 |
| 扩展 Markdown 渲染 | 前端 bundle | `host.registerMarkdownExtension()` | 产物仍过 DOMPurify，**不能**借此执行脚本 |
| 加多语言文案 | 清单 | `geewiki.locales` + `host.t('plugin.<短名>.<键>')` | `F15` 命名空间口径见 [`api-reference.md`](api-reference.md) |
| 把插件分发给别人安装 | 打包 | `pnpm run install-plugin` + `.geewiki-integrity.json` | [`quickstart.md` §分发与完整性](quickstart.md) |
| 提 PR / 申请收录 | — | — | [`review-checklist.md`](review-checklist.md) |

---

## 4. 最小可运行路径（60 秒版）

完整可复制执行的版本在 [`quickstart.md`](quickstart.md)，这里只给骨架：

```bash
pnpm install
pnpm run new:plugin my-note --ui          # 生成 plugins/my-note/
# ↓ 关键：脚手架的 UI 产物在 plugins/my-note/dist/，而仓库根 .gitignore 全局忽略 dist/
#    按 CLI 打印的两行例外加进 .gitignore，否则一次干净检出后界面静默消失
# ↓ 把 "@geewiki-plugin/my-note" 写进 config/plugins.base.json 的 enabled（外部插件不会自动启用）
pnpm run dev
curl -s localhost:3000/api/my-note
```

四条最容易踩的红线（详解在 `anti-patterns.md`）：

1. `router.register()` **必须显式写第 4 参** `{ access }`——脚手架生成的示例本身就漏了，它跑出来的端点是匿名可调的。
2. 外部插件目录 `GEEWIKI_PLUGINS_DIR` 在部署环境里**必须是绝对路径**（Docker 场景已写死 `/app/plugins`，见 `Dockerfile`）。
3. 改后端代码要**重启进程**，改前端产物要**整页刷新**——ESM 模块实例永不回收。
4. `geewiki.slots` 声明与 bundle 里 `registerSlot()` 的名字必须完全一致，不一致是**静默空白**，不是报错。

---

## 5. 生命周期、契约、API 参考去哪查

| 你要查的东西 | 去处 |
| --- | --- |
| 清单字段、类型、默认值、宿主 SDK 方法、错误码、宿主节点目录 | [`api-reference.md`](api-reference.md)（速查索引，每条给权威出处链接） |
| 生命周期时序（`boot`/`enable`/`replace`/`disable`、apply 超时、崩溃归因与回滚） | [`api-reference.md` §生命周期](api-reference.md) → 真源 `packages/manager/src/index.ts`、`packages/manager/src/watchdog.ts` |
| 内核实证（cordis fiber 生命周期与热替换实测、schemastery、外部 ESM 加载、FTS5） | [`../plugin-platform.md`](../plugin-platform.md) §2、§7 |
| 界面平台机制（入口表、`revision`/`rev` 与 304、双资产根、动态 import、`skipped` 与 `issues` 的区别、依赖阻止停用） | [`../plugin-platform.md`](../plugin-platform.md) §4（尤其 §4.1–§4.6） |
| 界面扩展平台 P4–P10（扩展点/模式/越权闸门/错误边界/主题/Markdown/i18n） | [`../plugin-platform.md`](../plugin-platform.md) §4.9 |
| 当前限制与风险（`L-*` 编号） | [`../plugin-platform.md`](../plugin-platform.md) §5.1–§5.5 |
| 写文档/提 PR 时的验证纪律 | [`../plugin-platform.md`](../plugin-platform.md) §6，[`../README.md`](../README.md) 的事实真源表 |

一句话口径：**`api-reference.md` 告诉你"叫什么、什么形状"；`plugin-platform.md` 告诉你"为什么这样、边界在哪"。**

---

## 6. 收口：反模式、兼容性、收录门槛

- [`anti-patterns.md`](anti-patterns.md) —— 静默失败陷阱条目化（每条：反模式 → ❌ → ✅ → 为什么）。这些不是理论，绝大多数在本仓库真实踩过并被记进源码注释。
- [`compatibility.md`](compatibility.md) —— **本项目没有 semver 兼容校验**（清单只有用于展示的 `version`）。该篇给出可执行政策：宿主 SDK 版本怎么探测、插件该声明什么、破坏性变更怎么通告、内置与外部插件的差异待遇、以及明确的**不支持项**清单。
- [`review-checklist.md`](review-checklist.md) —— 三层门槛（硬性 gate / 建议项 / 一律拒收）。仿 Fastify：文档差、无测试、无 example 一律不收。

**动手前读 `anti-patterns.md`，提交前过 `review-checklist.md`。** 顺序反过来的成本是：你要靠线上排障才知道自己踩了哪条。

---

## 7. 诚实清单：现状与理念的冲突处

以下是写作时逐条回源码核实过的现状。它们与"安全可控 / 不绑厂商 / 万物皆插件"存在张力，**如实列出，不做美化**。整改台账（若已存在）见 `docs/agent/backlog.md`；本节只描述现状。

| # | 现状 | 与理念的冲突 | 作者当下该怎么做 |
| --- | --- | --- | --- |
| 1 | `router.register()` 省略第 4 参 ⇒ `access: 'public'`，匿名可调；启动只聚合成一条告警（`GEEWIKI_STRICT_ROUTE_ACCESS=1` 才拒启） | 与安全可控正面冲突（fail-open 默认值） | 每条路由显式声明 `access`；把审计清单变更当成 PR 的一部分（反模式 #1） |
| 2 | `geewiki.permissions` **不被宿主强制**，未知取值只告警不阻断 | "可控"退化为"可评审" | 诚实声明；不要把它当能力开关（反模式 #2） |
| 3 | `geewiki.provides` 只是依赖图 token，**不创建 cordis 服务**；谎报 ⇒ 依赖方 `ctx.get()` 拿到 `undefined` 后静默失效 | 插件间契约不可验证 | `provide()` 与 `provides` 必须同名同存（反模式 #3；口径见 `packages/plugin-echo/src/index.ts`） |
| 4 | `geewiki.slots` 与 bundle 实际注册不一致 ⇒ **静默空白，无报错**；只声明 `routes` 不 `registerRoute` 同理（有占位但仍是你的问题） | 万物皆插件的可组合性缺自证手段 | 提交前用 `GET /api/plugins/slots` 与 `GET /api/plugins/ui` 自查（反模式 #4） |
| 5 | `geewiki.manifest.json` 无法承载 schemastery 的 `configSchema` | 无 `package.json` 的场景丢掉配置校验 | 需要结构化配置就用 `package.json`（反模式 #7） |
| 6 | **无 semver 范围/兼容校验**：清单 `version` 只用于展示，宿主不做最低版本判断 | 生态无版本协商 ⇒ 升级即赌 | 特性探测 + 优雅降级（反模式 #11、[`compatibility.md`](compatibility.md)） |
| 7 | 插件 CSS **全局注入、无隔离** | 一个插件能改全站样式 | 类名加前缀；强隔离用 `replace` + `shadow` 或 `host.createRoot`（反模式 #8） |
| 8 | ESM 模块实例**永不回收** | 热更新语义不完整（`docs/plugin-platform.md` §5.2） | 不要依赖模块级状态被重置（反模式 #10） |
| 9 | 插件与宿主同进程同权限，**无沙箱、无资源配额** | "安全可控"的边界 | 在 README 里写清你的插件会做什么；`applyTimeout` 只能兜住启动阶段 |
| 10 | 外部插件**无发布者签名**：`install-plugin` 只做完整性基线（sha256），`unsigned` 不等于 `ok` | 分发链路可信度不足 | 自己出签名/校验说明；不要把"没报错"当"没被改过" |
| 11 | ~~出厂模板 `config/plugins.base.example.json` 硬编码了私有端点与模型名~~ **已修正为通用占位符**（台账见 `docs/agent/backlog.md`）；但 `@geewiki/llm` 的 `baseUrl`/`model` **没有环境变量间接层**，只能写在清单里 | 曾经的"不绑厂商"冲突（且它是文档示例的来源） | 本系列示例一律用 `https://api.example.com/v1` 占位；你自己的私有端点**不要**写进随版本发布的清单 |
| 12 | 外部插件不是 workspace 包 ⇒ 不参与 `pnpm -r` 的 `test`/`typecheck`/`build` | 外部插件的质量门禁天然弱一档 | 自己在插件目录内备好 `test/` 与运行说明（[`review-checklist.md`](review-checklist.md) 硬性项） |
