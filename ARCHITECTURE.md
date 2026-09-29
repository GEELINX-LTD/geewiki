# 架构约束地图（给 agent 与新贡献者）

这份文档**不是** [docs/architecture.md](docs/architecture.md)。那份约 123 KB 的文件是**设计真源**，
讲"系统为什么长成这样"；这份文件只讲**边界**：分层是什么、依赖能往哪走、哪些线不许越过、
以及**每条线现在到底靠什么守着**。

长会话里做改动前先看这份；要改行为，再去读真源对应章节。

- 设计真源（分层、插件管理器、插槽、Manifest、REST 面）→ [docs/architecture.md](docs/architecture.md)
- 工程约定与坑（迁移、方言、验收纪律）→ [docs/development.md](docs/development.md)
- 插件契约与当前限制/风险 → [docs/plugin-platform.md](docs/plugin-platform.md)
- CI 与分支保护 → [docs/ci-cd.md](docs/ci-cd.md)
- 贡献流程 → [CONTRIBUTING.md](CONTRIBUTING.md)
- 编号决策日志 → [docs/adr/](docs/adr/README.md)

> 本文引用代码一律用**路径 + 符号名**，不写行号——行号会漂移，
> [docs/architecture.md](docs/architecture.md) 里已经有一段"历史引用说明：行号不再对应"的自认腐化。

---

## 1. 一页速览：运行期形态

| 事实 | 说明 | 出处 |
| --- | --- | --- |
| 一个进程 | HTTP 服务、插件装配、DB 访问全在同一个 Node 进程里，**无子进程、无 worker 隔离** | [docs/plugin-platform.md](docs/plugin-platform.md) 的 D-3 与「当前限制与风险」 |
| 纯 `node:http` | 无任何 Web 框架。`packages/server/src/index.ts` 顶层 `import { createServer } from 'node:http'`；全仓各包 `package.json` 里查不到 express/fastify/koa/hono | 见 [ADR-0001](docs/adr/0001-cordis-plugin-graph-and-node-http.md) |
| 路由也是自己写的 | 路由服务是一个**注册表插件**：`@geewiki/http` **不是独立包**，manifest 定义在 `packages/server/src/index.ts` 的 `httpRegistryEntry` | [docs/architecture.md](docs/architecture.md)「分层架构」 |
| 服务端包**无构建步骤** | 除 `@geewiki/web` 外，每个包的 `exports` 直指 `./src/index.ts`，运行期由 tsx 转译（`pnpm dev` / `pnpm start` / 生产镜像 `CMD ["tsx", "/app/src/index.ts"]`） | 见 [ADR-0002](docs/adr/0002-serve-typescript-at-runtime.md) |
| 内核是 cordis 插件图 | `cordis@^4.0.0-rc.10`（依赖注入 + 事件总线 + 插件生命周期）；类型面缺口由 `packages/core/src/cordis-env.ts` 自包含补齐 | [docs/architecture.md](docs/architecture.md)「技术栈选型」 |
| 数据库是互斥插件 | `@geewiki/db-sqlite` 与 `@geewiki/postgres` 同属冲突组 `database-provider`，**冷切换**（两者都 `supportsHotReload: false`） | [docs/architecture.md](docs/architecture.md)「数据库即互斥插件」 |
| 前端是 Vite SPA | `@geewiki/web`（React 19 + hash 路由），插件 UI 经 `window.__GEEWIKI_HOST__` 宿主 SDK 注册进**插槽** | [docs/architecture.md](docs/architecture.md)「前端 UI 插槽机制」 |

产品理念（每条不变量都要挂到这里之一）：**万物皆插件积木式搭建** / **极致轻量** /
**高可扩展** / **安全可控** —— 见 [README.md](README.md) 与
[docs/architecture.md](docs/architecture.md)「总览与设计哲学」。

---

## 2. 包与目录↔包名映射

包清单的真源是 `ls -d packages/*/`（[docs/README.md](docs/README.md)「事实的真源」），
**本文不写包数量**。以下是**目录名 ≠ 包名**的易错映射，用各 `packages/*/package.json` 的
`name` 字段核对过：

| 目录 | 包名 | 备注 |
| --- | --- | --- |
| `packages/db-postgres/` | `@geewiki/postgres` | **目录名与包名不一致**（目录带 `db-` 前缀，包名不带） |
| `packages/db-sqlite/` | `@geewiki/db-sqlite` | 默认数据库 |
| `packages/plugin-ai-kb/` | `@geewiki/ai-kb` | 其余 `plugin-*` 同规律：去掉 `plugin-` 前缀 |
| `packages/plugin-auth/` | `@geewiki/auth` | 同理 |
| `packages/plugin-builtin-docs/` | `@geewiki/builtin-docs` | 同理 |

例外说明：插件包之间是**有横向依赖**的（见 §4），不要按"插件一律互不相识"的假设改代码。

---

## 3. 分层与依赖方向

```
                    ┌─────────────────────────────────────────────┐
  浏览器            │  @geewiki/web  (Vite SPA / React 19)         │
                    │  只依赖 @geewiki/core 的浏览器安全子路径      │
                    └───────────────▲─────────────────────────────┘
                                    │ REST + 插件 UI bundle（宿主 SDK）
  ─────────────────────────────────  │  进程边界  ─────────────────────────────
                                    │
  宿主进程   ┌──────────────────────┴──────────────────────────────┐
             │  @geewiki/server   node:http · 路由表 · 内置插件注册表 │
             │                    (@geewiki/http = httpRegistryEntry)│
             └───────▲──────────────────────────▲──────────────────┘
                     │                          │ 引导加载
             ┌───────┴────────┐        ┌────────┴──────────────┐
             │ @geewiki/      │        │ 插件（@geewiki/*）     │
             │ manager        │        │ auth/authz/oidc/org/  │
             │ 装配·冲突组·    │        │ wiki/search/llm/ai-*/ │
             │ 会话层·迁移·    │        │ ops/echo/editor-plain │
             │ 看门狗·插槽表   │        └────────▲──────────────┘
             └───────▲────────┘                 │
                     │                          │
             ┌───────┴──────────────────────────┴──────────────┐
             │  数据层插件：@geewiki/db-sqlite · @geewiki/postgres │
             │  （冲突组 database-provider，同一时刻只能有一个）    │
             └───────────────────────▲─────────────────────────┘
                                     │
             ┌───────────────────────┴─────────────────────────┐
             │  @geewiki/core  契约 + 常量 + 插槽表 + 迁移描述     │
             │  不依赖任何 @geewiki 包（只依赖 schemastery）       │
             └─────────────────────────────────────────────────┘
```

依赖方向：**server → manager → {db 插件, 业务插件} → core**。箭头指向"被依赖方"。
`@geewiki/server` 的 `dependencies` 里出现全部 workspace 包（它要注册内置插件），
所以**方向是单向的**：没有任何非 server 包真实 import `@geewiki/server`。

### 3.1 实测到的横向依赖（不是违规，但要知道）

「插件只准依赖 `@geewiki/core`」**不完全成立**。各包 `dependencies` 里真实存在的插件间依赖：

| 依赖方 | 被依赖方 |
| --- | --- |
| `@geewiki/ai-admin` | `@geewiki/ai-journal`、`@geewiki/ai-tools` |
| `@geewiki/ai-assistant` | `@geewiki/ai-tools`、`@geewiki/llm` |
| `@geewiki/ai-kb` | `@geewiki/ai-tools`、`@geewiki/search` |
| `@geewiki/oidc` | `@geewiki/auth` |
| `@geewiki/openai` | `@geewiki/llm` |

（上表来自各 `package.json` 的 `dependencies`，**不完整**——以命令为准：
`grep -n "@geewiki/" packages/plugin-*/package.json`。）

这些依赖都是**同族能力包**（工具总线、鉴权、LLM 适配、检索），不是"绕过契约去摸内部实现"。
真正的红线是 §5 的 INV-1。

### 3.2 core 的三个浏览器安全子路径

`@geewiki/core` 的 `exports` 除 `"."` 之外还有：

| 子路径 | 文件 | 为什么单独切出来 |
| --- | --- | --- |
| `@geewiki/core/slots` | `packages/core/src/slots.ts` | **浏览器安全**：零 `node:*`、零 cordis 类型。守卫 `packages/core/test/slots-browser-safe.test.ts` |
| `@geewiki/core/extensions` | `packages/core/src/extensions.ts` | 同上，界面扩展节点的目录与基数 |
| `@geewiki/core/domain` | `packages/core/src/domain.ts` | 纯领域类型 |

`packages/core/src/services.ts` **不是**浏览器安全的（要 `node:http` 类型），
所以**前端不要从 core 的根 `index.ts` 取类型**：core 根会带进 cordis 的全局 `Context`，
与 DOM 的 `Context` 撞名。契约之所以住在 core 而不是实现它的插件包里，理由写在
`packages/core/src/services.ts` 文件头：让契约实现者被替换时，"替换者依赖被替换者"的语义倒挂不成立。

---

## 4. 硬不变量

| # | 不变量 | 挂在哪个理念 | 现在的保证手段 | 强度 |
| --- | --- | --- | --- | --- |
| INV-1 | 插件包**不得** import `@geewiki/server` / `@geewiki/manager` / db 插件的内部实现 | 高可扩展（能换实现）、安全可控 | 仅评审 + 注释自觉 | 🟡 口头 |
| INV-2 | `@geewiki/core` **不得**依赖任何 `@geewiki/*` 包 | 万物皆插件（被所有人依赖、自己不依赖业务） | 事实上成立；无机器检查 | 🟡 口头 |
| INV-3 | `packages/core/src/slots.ts` / `extensions.ts` 必须**浏览器安全**（零 `node:*`、零 cordis） | 极致轻量、高可扩展 | `packages/core/test/slots-browser-safe.test.ts` | 🟢 机器 |
| INV-4 | 注册路由**必须显式写 `access`**——见下面的醒目警告 | 安全可控 | 启动期审计告警 + `GEEWIKI_STRICT_ROUTE_ACCESS=1` 可拒启；`packages/server/test/route-access-audit.test.ts` | 🟠 半强制 |
| INV-5 | 用了 SQLite 专有语法的迁移，必须有**文件名一一对应**的 `migrations-postgres/` 版本，或登记为 SQLite 专有（登记不等于免检，必须配套运行期拒接非 sqlite 方言）。**注意：“SQLite 禁用 `ADD COLUMN`”是误传**——它是重放策略的分类器，不是禁令（见 ADR-0003） | 极致轻量（默认零外部依赖）、不锁死 | `packages/manager/test/migrations-dialect.test.ts`（`★ F19` 那条）、`packages/manager/test/db-dual-track.test.ts`、`packages/server/test/builtin-migrations.test.ts` | 🟢 机器 |
| INV-6 | `pnpm-workspace.yaml` 的 `storeDir` / `cacheDir` **必须相对路径** | 极致轻量（开箱即用不破） | 仅评审；违反的后果是 CI / Docker / Dependabot 一起坏 | 🟡 口头 |
| INV-7 | `editor` 插槽替换有**红线**（见 §6） | 安全可控、万物皆插件 | 部分机器（props 契约守卫）+ 大量注释 + 默认清单不含编辑器 | 🟠 半强制 |
| INV-8 | 密钥不落盘、不回显；`config/secrets.json` 权限 `0600` | 安全可控 | `packages/manager/test/secrets.test.ts`、`packages/db-postgres/test/secret-discipline.test.ts` | 🟢 机器 |
| INV-9 | 审计日志**只追加**，不覆盖既有行 | 安全可控 | `packages/plugin-authz/test/audit-appendonly.test.ts`（源码级守卫） | 🟢 机器 |
| INV-10 | CI 作业名 `lint` / `typecheck` / `test` / `build` **不得改名** | 安全可控 | GitHub ruleset `main-protection` 的 required checks；**不在本仓库文件里** | 🟠 外部状态 |
| INV-11 | 插件**不得**在热路径上放阻塞逻辑；会话层插件必须能冷启动 | 安全可控 | 会话层看门狗探针 + 熔断（`packages/manager/src/watchdog.ts` 的 `decideWatchdog`） | 🟢 机器 |
| INV-12 | 契约（服务接口/插槽/扩展目录）一律**下沉到 core**，不下沉就等同"替换者依赖被替换者" | 万物皆插件 | 仅评审 | 🟡 口头 |

强度图例：🟢 有守卫测试（改错就红）· 🟠 有一半机器手段，另一半靠人 · 🟡 **纯靠自觉与评审**。

### 4.1 ⚠️ INV-4 展开：路由默认 `access: 'public'`，漏写就是匿名可调

> **这是本仓库最危险的一条默认值。**
> `HttpRouterService.register(method, path, handler, opts?)` 的第 4 参**可省略**，
> 省略等价于 `{ access: 'public' }`（注释原文见 `packages/core/src/index.ts` 的
> `RouteAccessOptions`：「省略等价于 `{ access: 'public' }`」）。
> 于是"作者忘了写"与"作者故意公开"在运行期**完全等价**，源码里长得一模一样。

现有缓解（都不是硬强制）：

- `HttpRouteInfo.explicit` 字段区分两者：`access: 'public'` + `explicit: false`
  = "作者没想过这件事"。
- `unauditedRoutes(routes)`（`packages/core/src/index.ts` 导出的纯函数）过滤出未显式声明的路由；
  `packages/server/src/index.ts` 在启动时把它们聚合成**一条**告警。
- 设 `GEEWIKI_STRICT_ROUTE_ACCESS=1`（常量 `STRICT_ROUTE_ACCESS_ENV`）则**直接拒启**。
  默认不设，因为历史上存量太多。
- 覆盖审计：`packages/server/test/route-access-audit.test.ts`。

三条容易误解的语义，改动前先读：

1. `access` 是**粗粒度**闸门（public / user / admin），**不能替代逐对象判定**——后者归
   policy-service（`docs/design/access-control.md`）。
2. `capability` 是第二层闸门（★ F9），判定权在插件自己，经 capability-service `provide()`。
3. `owner` 只是可观测性字段（★ F12 按登记方聚合计数），**不是安全边界**。
4. `HttpRouterService.use?(hook)` **不是全局中间件**：只对匹配到的路由执行，
   静态资源与 SPA fallback 不过钩子。想"拦截一切"的中间件思路在这里不成立。

**给 agent 的操作性要求**：新增任何 `register(...)` 调用点，必须显式写第 4 参，
哪怕就是 `{ access: 'public' }`——那表示这是评审过的决定。

### 4.2 INV-6 展开：为什么相对路径不许改

`pnpm-workspace.yaml` 里 `storeDir: .pnpm-store`、`cacheDir: .npm-cache` 旁边的注释已经写明：
绝对路径会让**所有环境写宿主 `/root`**。代价曾经很实在：CI 与 Dockerfile 里加过
`sed` 删这两行的补丁，而 Dependabot 不能执行 `sed`，直接报
`Dependabot encountered an error performing the update`。
实验数据（哪些覆盖方式有效/无效）见 [docs/ci-cd.md](docs/ci-cd.md) 的 pnpm store 章节：
`.npmrc` 的 `store-dir` / `storeDir` **无效**、`npm_config_store_dir` 拼法**无效**、
`PNPM_CONFIG_STORE_DIR` / `PNPM_CONFIG_CACHE_DIR` **有效**且优先级高于 `pnpm-workspace.yaml`、
`pnpm config set --location project` 会**写进入库文件**（禁止使用）。

---

## 5. INV-7 展开：`editor` 插槽的红线

这条目前**主要藏在注释里**，改动前必须读：

1. **宿主职责绝不进插槽**。`packages/web/src/pages/WikiPage.tsx` 的注释原文：
   「**宿主职责刻意留在插槽外面**：草稿落盘、脏值判定、未保存离开拦截、保存冲突检测、
   字段校验全部由本组件继续负责」，插件只拿到 `value` / `onChange` / `onSave` / `onCancel` 几个出口。
   理由：换编辑器不该丢掉草稿保护与冲突检测。
2. **不存在第二套保存实现**。同一文件的注释：「`onSave` 指向同一个 `save()`——不存在第二套保存实现」。
   插件编辑器想"自己存"就是绕过权限、版本、审计三套宿主逻辑。
3. **props 契约的权威在 core**：`packages/core/src/slots.ts` 的 `SLOT_PROPS_SCHEMA.editor` 带
   `contract: { interface: 'EditorSlotProps', file: 'packages/core/src/index.ts' }`——
   **冲突时以接口为准**。守卫：`packages/core/test/slot-props-schema.test.ts`
   按 `contract` 比对顶层字段名与可选性；web 侧镜像由
   `packages/web/test/editorSlotProps.test.ts` 与 `packages/web/test/slotPropsMirror.test.ts` 钉住。
4. **可选 prop 的"缺省"是有语义的**，不要当"传了也没用"。`SLOT_PROPS_SCHEMA.editor` 里
   `onUploadFiles` 的描述：「★ F5：附件上传。缺省 = 宿主**不支持**该编辑器上传（宿主会同时关掉它自己的
   拖放/粘贴拦截），不是"传了也白传"」。
5. **不要让插件默认占用 `editor`**。`packages/web/src/lib/slots.tsx` 的 X1 兜底段落写明：
   上传通道进契约之前，"不要让任何插件默认占用 `editor` 插槽"，
   `config/plugins.base.example.json` 的默认清单里没有 `@geewiki/editor-plain`，理由就是这个。
   （宿主侧只保留"拦住默认拖放 + 给一句可见提示"的兜底，因为不拦就会丢数据。）
6. **宿主侧的判据必须用假值，不是 `=== null`**。`packages/web/src/pages/WikiPage.tsx` 的注释：
   `useEditorSlot()` 无插件时返回 `undefined`，写 `=== null` 会让某个按钮**永不渲染**，
   看起来却像布局问题。
7. **懒加载失败要静默**。进入编辑视图时对 `editor` 与 `editor-toolbar` 各做一次
   `ensureSlotLoaded(...)` 并 `catch`；漏掉 `editor-toolbar` 的后果是工具条**静默空白**。

---

## 6. 不变量的机器强制现状（老实说）

**上面 12 条里，真正"改错就红"的只有 INV-3 / INV-5 / INV-8 / INV-9 / INV-11。**
依赖方向类（INV-1、INV-2、INV-12）目前**零机器强制**——仓库里**既没有**
`eslint-plugin-boundaries`，**也没有** `dependency-cruiser`（两者都不在依赖树里）。
`eslint.config.js` 的 ignores 也不涉及依赖方向；它刻意只做非类型感知的规则（见
[ADR-0004](docs/adr/0004-eslint-no-type-aware.md)）。

这不是"忘了做"，而是**没人写过那条规则**。将来该由谁承担，按目标形态列在这里：

| 不变量 | 目标形态 | 为什么现在没做 |
| --- | --- | --- |
| INV-1 / INV-2 / INV-12 | `dependency-cruiser` 的 `forbidden` 规则（`packages/plugin-*/src/**` → 禁 `@geewiki/server`、`@geewiki/manager`、db 插件内部路径；`packages/core/src/**` → 禁 `@geewiki/plugin-*`），或 `eslint-plugin-boundaries` 的 element types + 允许的依赖矩阵 | 引入新工具要过 CI 时间预算这道账；且 §3.1 那批合法的插件间依赖需要先写成 allowlist，否则首跑就是一屏 error（**同 ADR-0004 的教训**：全量硬门禁必须配清零方案） |
| INV-4（默认 public） | 单测级守卫：扫源码找 `register(` 三实参调用点，或让 `route-access-audit` 从告警升级为 CI 失败 | 存量调用点多；仓库先例是"告警 + 可选拒启"（`GEEWIKI_STRICT_ROUTE_ACCESS`）而非直接红 |
| INV-6 | 一条读 `pnpm-workspace.yaml` 文本的守卫测试（断言两键是相对路径） | 没写；成本极低，**建议优先补** |
| INV-7 | 契约部分已有守卫；"宿主职责不外移"无法静态检查，只能靠 ADR + Review | —— |
| INV-10 | 不在仓库能力范围内（GitHub ruleset 状态） | 已在 [docs/ci-cd.md](docs/ci-cd.md) 记录 required checks 清单 |

**给 agent 的提醒**：不要因为"这些不变量居然没被检查"就顺手越过它们。
上面每一条 🟡 都对应一次架构决策；要改就写 ADR（[docs/adr/](docs/adr/README.md)），
并在 PR 里说明兼容性影响。

---

## 7. 该去哪读细节

| 我要…… | 去这里 |
| --- | --- |
| 看分层/插件管理器/插槽机制/Manifest 规范/部署模型的完整设计 | [docs/architecture.md](docs/architecture.md)（总览与设计哲学 · 技术栈选型 · 分层架构 · 数据库即互斥插件 · 插件管理器子系统 · 前端 UI 插槽机制 · Manifest 规范 · 部署模型） |
| 看插件接口契约、生命周期、**当前限制与风险**（含"同进程同权限"的老实说明） | [docs/plugin-platform.md](docs/plugin-platform.md)（已拍板决策 D-1…D-8 在其决策章节；限制与风险在 §5） |
| 看权限/可见性/块级授权的完整设计 | [docs/design/access-control.md](docs/design/access-control.md) |
| 看附件能力的完整设计 | [docs/design/attachments.md](docs/design/attachments.md) |
| 看 AI 能力层（工具总线 + 单入口） | [docs/design/ai-plugin-architecture.md](docs/design/ai-plugin-architecture.md) |
| 看界面扩展（插槽之外的节点目录/三种模式） | [docs/design/ui-extension-platform.md](docs/design/ui-extension-platform.md) |
| 看块级归属、dock 贴图 | [docs/design/block-attribution.md](docs/design/block-attribution.md) · [docs/design/dock-images.md](docs/design/dock-images.md) |
| 看"当初为什么这么选" | [docs/adr/](docs/adr/README.md) |
| 看迁移约定、方言差异、验收纪律 | [docs/development.md](docs/development.md) |
| 看 CI 作业、镜像与 tag 规则、分支保护 | [docs/ci-cd.md](docs/ci-cd.md) |
| 看能力现状与有意不做的东西 | [docs/roadmap.md](docs/roadmap.md) |
| 看历史流水（**不是当前口径**） | [docs/changelog/implementation-log.md](docs/changelog/implementation-log.md) |
