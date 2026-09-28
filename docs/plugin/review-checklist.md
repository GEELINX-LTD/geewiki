# GeeWiki 插件收录 / 合并门槛（评审清单）

> 一句话：**文档差、无测试、无 example 的插件，一律不收。**
>
> 参照 Fastify 的收录纪律：不看功能多惊艳，先看它能不能被别人安全地维护。本项目**宿主不做任何强制**（没有沙箱、没有版本协商、声明不被拦截，见 [`compatibility.md`](compatibility.md)），所以这份清单是**唯一**的质量闸门——它靠人跑，不靠运行时兜底。

- 硬性 gate **缺一不收**；建议项不影响收录但必须写进评审意见；一律拒收项**不看后续理由**。
- 每条给「为什么」（挂产品理念或真实故障后果）与「如何验证」（命令或界面位置）。
- 契约形状查 [`api-reference.md`](api-reference.md)；设计边界与限制查 [`../plugin-platform.md`](../plugin-platform.md)；症状解释查 [`anti-patterns.md`](anti-patterns.md)（下文用 `AP-xx` 引用）。

## 怎么用

- **作者**：开 PR 前自己全过一遍，把 Tier 1 的勾选结果原样贴进 PR 描述（模板见文末）。
- **评审者**：不必信勾选，按"如何验证"抽查；Tier 1 任一条不成立 ⇒ 直接 `request changes`，不进入实现细节讨论。
- **适用面**：`plugins/*` 外部插件的收录与更新，以及内置包（`packages/*`）的插件相关改动。内置包改动另需 `pnpm test` / `pnpm run typecheck` 全绿（它们**在** `pnpm -r` 的门禁里，外部插件不在）。

---

## Tier 1 · 硬性 gate（缺一不收）

### G-01 清单字段合法：`name` / `version` / `geewiki`

- [ ] `package.json` 有 `name`、`version`，且有 `geewiki` 键；`geewiki` 内用到的每个字段都在 [`api-reference.md`](api-reference.md) §清单 里有对应条目。

**为什么**：清单是宿主唯一能读懂的东西。`version` 缺失会被发现层按 `'0.0.0'` 处理（`parsePluginManifest`，`packages/manager/src/discovery.ts`）——不报错，于是你发布的所有版本在诊断日志里长得一样，出问题无法归因。写了不存在的字段（如 `geewiki.assets`、`minHostVersion`）等于没写，还会给后来人一个假的安心感（[`compatibility.md`](compatibility.md) §2.1）。

**如何验证**：

```bash
node -e "const p=require('./plugins/my-note/package.json');console.log(p.name,p.version,Object.keys(p.geewiki||{}))"
pnpm run dev && curl -s localhost:3000/api/plugins | jq '.plugins[] | select(.name=="@geewiki-plugin/my-note") | {name,state,version}'
```

### G-02 `apply()` 返回注销函数（可卸载证明）

- [ ] `apply()` / `register()` 返回一个函数，并且该函数真正调用（而非空函数占位）了你做过的**每一项**注册。

**为什么**：ESM 模块实例**永不回收**（`docs/plugin-platform.md` §5.2），热替换是"新建一个 fiber 顶上"而不是"清掉旧的"。不返回 disposer ⇒ 停用后贡献收不回、再启用贡献翻倍（`AP-19`）。返回空函数更糟：它通过了所有"有没有返回函数"的静态检查，只在用户第二次启用的时候坏。

**如何验证**：管理台里停用→再启用两轮，然后

```bash
curl -s localhost:3000/api/plugins/slots | jq '{slots, extensions, conflicts}'
```

你插件相关的贡献条数必须回到第一轮的数值（该端点还一并给 `undeclared`、`routes`、`routeConflicts`、`unresolvedCapabilities`，一次拿全）。真实范式看 `plugins/hello-geewiki/index.ts`：`apply()` 返回的 disposer 里调 `unregister()`——注意 **`register()` 的返回值就是注销函数**，没有也不需要别的 `unregister` 方法。

### G-03 ★ 每条路由都显式声明 `access`（本清单最容易出事的一条）

- [ ] 全插件内**每一次** `http.register(...)` 都传了第 4 参 `{ access: '...' }`，包括看起来"只是查个状态"的 GET。

**为什么**：`HttpRouterService.register(method, path, handler, opts?)` 的 `opts.access` **默认 `'public'`**（`packages/core/src/index.ts`）——省略第 4 参与"我故意做成匿名可调"在源码里长得**一模一样**：评审看不出来，运行期也毫无痕迹，启动只聚合成一条告警（`STRICT_ROUTE_ACCESS_ENV = 'GEEWIKI_STRICT_ROUTE_ACCESS'`，`packages/server/src/index.ts`，设 `=1` 才拒启）。这与"安全可控"理念正面冲突，且后果落在部署者身上：数据匿名可读。`access` 本身也只是粗粒度等级，**逐对象判定仍要你在处理器里做**。

**如何验证**：

```bash
# 1) 静态：找出所有没传第 4 参的调用点
rg -n --multiline --dotall "register\(\s*'(GET|POST|PUT|DELETE|PATCH)'[^)]*\)" plugins/my-note | grep -v access
# 2) 运行期：严格模式起一次，拒启即说明有漏网
GEEWIKI_STRICT_ROUTE_ACCESS=1 pnpm run dev
# 3) 枚举：http 服务面的 routes() 快照里，你每条路由的 explicit 必须为 true
#    （该字段专门区分"作者写了 { access: 'public' }"与"作者什么都没写"，见 HttpRouteInfo）
rg -n "routes\?\(\)|explicit" packages/core/src/index.ts   # 字段定义与审计口径
```

全仓基线：`packages/server/test/route-access-audit.test.ts`（`auditRouteAccess`）。收录时顺手确认新增公开路由没有悄悄扩大暴露面。

### G-04 `slots` / `extensions` / `routes` / `clientTools` 声明与 bundle 实际注册**双向一致**

- [ ] 清单声明的每个名字，bundle 里都有对应的 `host.registerSlot` / `registerExtension` / `registerRoute` / `registerTool`；反之 bundle 注册的每个名字都在清单里。

**为什么**：不一致是**静默空白**，不是报错。宿主按清单决定"要不要加载你的 bundle、要不要渲染这个格子"，按运行期注册决定"格子里放什么"——两边对不上时，前端根本不 import 你的产物（`AP-09`、`AP-10`）。`clientTools` 名字两侧不配对时，AI 侧点了工具什么也不会发生（`AP-24`）。同一族的陷阱：**该节点不允许的模式会被静默忽略**（如对 `app-header` 声明 `replace`），而声明仍留在裁决表里 ⇒ 你只看得到"清单里有我"，看不到"页面上没有我"（见 [`compatibility.md`](compatibility.md) §9）。

**如何验证**：

```bash
curl -s localhost:3000/api/plugins/slots | jq '{slots, extensions, conflicts, undeclared, routeConflicts}'
curl -s localhost:3000/api/plugins/ui | jq            # UI 产物被发现了吗？有没有进 skipped
```

界面：管理台插件页看该插件的 `skipped` / `issues`（两者语义不同，见 [`../plugin-platform.md`](../plugin-platform.md) §4.6）。

### G-05 有 `test/`，且 `node:test` + tsx 真能跑

- [ ] 插件目录内有 `test/*.test.ts`，用 `node:test` + `node:assert`（**本仓库不用 vitest / jest**），并且在**仓库根**能跑通。

**为什么**：`plugins/*` **不是** workspace 包（`pnpm-workspace.yaml` 的 `packages` 只含 `packages/*`），`plugins/*/package.json` 也没有 `scripts` ⇒ 外部插件**不参与** `pnpm -r` 的 `test` / `typecheck` / `build`，CI 完全看不见它。没有自带测试的插件，等于把回归责任转嫁给每个下载它的人（`index.md` §7 第 12 条）。

**如何验证**：

```bash
# 约定口径见各内置包 "test": "node --import tsx --test test/*.test.ts"
node --import tsx --test plugins/my-note/test/*.test.ts
pnpm run typecheck && pnpm run lint     # lint 是 --max-warnings 0，告警也算失败
```

最低覆盖要求：清单解析后每个声明项都有断言；每条路由有 200/401/403 级别判定；错误路径（依赖服务缺失、配置为空）有断言。

### G-06 有可运行 example

- [ ] README 里给出**照抄即可跑通**的最短路径：启用（写进 `enabled`）→ 启动 → 一条 `curl` 或一个界面动作 → 预期输出。

**为什么**：外部插件不会自动启用，且 `GEEWIKI_PLUGINS_DIR` 相对路径会静默解析到 `process.cwd()` ⇒ "不报错、0 个插件"（`AP-14`）；脚手架的 UI 产物在 `plugins/<name>/dist/`，会被仓库根 `.gitignore` 吃掉 ⇒ 干净检出后界面消失（`AP-15`）。这三件事任何一件都会让"跑不通"被误判成"你的插件有 bug"。评审者只会按 README 走一遍，走不通就是不收。

**如何验证**：干净工作区执行 `pnpm install && pnpm run new:plugin my-note --ui` 后，照 README 逐条执行，输出与 README 一致。

### G-07 涉及建表：SQLite / Postgres 迁移成对提供

- [ ] 要么提供与 SQLite 迁移**文件名一一对应**的 `migrations-postgres/`，要么在守卫的 `SQLITE_ONLY` 清单里登记原因，并且运行期真的拒非 sqlite 方言。

**为什么**：方言不匹配在 `pnpm test` 里**测不出来**，只在真连 PG 时炸。本仓库真实炸过一次：`[db-postgres] 迁移失败（已回滚）: 0001_ai_mutations.sql error: syntax error at or near "AUTOINCREMENT"`（原始 SQLite 迁移在 `packages/plugin-ai-journal/migrations/`）。

**如何验证**：

```bash
pnpm --filter @geewiki/manager run test     # 静态守卫：packages/manager/test/migrations-dialect.test.ts
```

写法口径见 `migrations?: string | { default?: string; postgres?: string }`（`packages/core/src/index.ts`）；守卫的判据与豁免路径（`SQLITE_ONLY` + 原因 + 运行期拒非 sqlite 方言）看 `packages/manager/test/migrations-dialect.test.ts` 本身的注释。

### G-08 README 说明依赖与权限

- [ ] README 明确写：运行期依赖（含该插件目录内自带的 `node_modules`）、会读/写哪些路径、会访问哪些外部域名、以及 `geewiki.permissions` 声明的每一项**实际用来做什么**。

**为什么**：插件与宿主**同进程同权限、无沙箱、无配额**（[`../plugin-platform.md`](../plugin-platform.md) §5.1）。既然宿主不做拦截，"可审计"就是唯一的安全机制，而可审计性只存在于 README 与清单里。pnpm 严格布局下外部插件的第三方依赖只能自带（口径见 `packages/hello-geewiki/README.md`），不写出来等于让装机的人靠猜。

**如何验证**：评审者拿 README 的依赖清单与实际 import 对比：

```bash
rg -n "from '[^.]" plugins/my-note --glob '!*/dist/**'      # 裸说明符依赖
find plugins/my-note -maxdepth 2 -name node_modules -type d
```

### G-09 ★ 密钥走 schema `meta.role === 'secret'`

- [ ] 所有密钥/令牌/密码类字段在 `configSchema` 里带 `meta: { role: 'secret' }`；没有把凭据放进任何普通 config 字段，也没有落盘或写进 README。

**为什么**：这是**明文泄露**，不是风格问题。`GET /api/plugins/:name/config` 会返回存储态的完整配置；只有被判为 secret 的字段折叠成"有/无"（`Record<string, boolean>`，`secretPresenceOf`），**其余字段原样回显**。判据是顶层 `node.meta.role === SECRET_ROLE`（`SECRET_ROLE = 'secret'`，`packages/manager/src/secrets.ts`；`secretFieldNames`，`packages/manager/src/config-schema.ts`）。判定是**顶层字段级**——嵌在对象深处的凭据会被当普通字符串返回。secret 字段落盘进独立的 `secrets.json`（`config/secrets.json`，已 gitignore），而普通配置落在 **git 跟踪**的 `config/plugins.*.json`。同类先例：`packages/db-postgres/test/secret-discipline.test.ts`（因此移除了明文 `password` 字段；同类做法是只接受环境变量名，如 `apiKeyEnv`）。

**如何验证**：

```bash
# 1) schema 侧：每个凭据字段旁边必须有 role: 'secret'
rg -n "password|token|secret|apiKey|api_key" plugins/my-note --glob '!*/dist/**'
# 2) 运行期：用管理员会话请求该端点，确认凭据不出现在响应里（只出现 "<redacted>"）
curl -s --cookie "$ADMIN_COOKIE" localhost:3000/api/plugins/my-note/config | jq
# 3) 落盘侧：确认凭据只在 secrets.json，git 跟踪的配置里没有它
git status --porcelain config/
```

### G-10 无真实私有端点、无真实凭据

- [ ] 代码、清单、默认配置、README、测试夹具里的外部端点一律用 `https://api.example.com/v1` 占位；真实端点/租户名/凭据一个都不进仓库。

**为什么**：这是"不绑厂商"理念最容易破功的地方，而且真实泄露过一次进**文档示例源头**：`config/plugins.base.json` 里 `@geewiki/ops` 的默认 `baseUrl` 与 `model` 是一个具体厂商端点（`index.md` §7 第 11 条）。清单默认值是会被别人整段抄走的东西。

**如何验证**：

```bash
rg -n "https?://" plugins/my-note --glob '!*/dist/**'      # 逐条确认要么是 example.com 要么是用户自填
```

LLM 一律经 `llm-service` 抽象，端点/模型名来自配置，不自建 provider（范式：`packages/plugin-openai/src/index.ts` 只做 route→provider 路由）。

### G-11 `provides` 不谎报

- [ ] 清单 `geewiki.provides` 里每个名字，代码里都有同名的 `ctx.provide(name, impl)`，且**在依赖方解析之前**完成。

**为什么**：`provides` 只是依赖图上的 token，**不会**创建 cordis 服务。只声明不 provide ⇒ 依赖方 `ctx.get()` 拿到 `undefined` 然后静默失效——报错点离原因很远，且通常在另一插件里（`AP-08`；`index.md` §7 第 3 条）。这属于"污染别人的插件"，比自己的 bug 严重一档。

**如何验证**：

```bash
rg -n "provide\(" plugins/my-note                     # 与清单 provides 逐项对名
pnpm run dev && curl -s localhost:3000/api/plugins/graph | jq   # 依赖图：边与你的声明是否一致
```

子插件创建顺序的红线见 `AP-18`（先 `ctx.plugin()` 后 `provide()` 会坏）。

### G-12 未使用保留路由 id

- [ ] `geewiki.routes` 与 `host.registerRoute()` 用的 id 都不撞 `RESERVED_ROUTE_IDS`，并且 id 满足 `PLUGIN_ROUTE_ID`（`^[a-z][a-z0-9-]*$`）。

**为什么**：保留字命中是**直接拒绝**，不是先到先得（`packages/core/src/domain.ts` 的注释原话），而插件之间的路由 **id** 冲突才是先激活者胜出、落败方进 `conflicts`（`resolveRouteDecls`，`packages/manager/src/routes.ts`；前端 `registerRoute`，`packages/web/src/lib/routes.tsx` 同样拒保留字）。当前保留字（**以常量为准**，以 `node --import tsx -e "import('./packages/core/src/domain.ts').then((m) => console.log(m.RESERVED_ROUTE_IDS))"` 现算）：`wiki` `plugins` `graph` `access` `org` `login` `setup` `invite` `denied` `account` `notfound`。`audit` **已移出**，由 `@geewiki/ops` 自行声明（守卫 `packages/web/test/opsOwnership.test.ts`）。集合增删不会有版本信号 ⇒ 把集合抄进你插件的测试里，宿主升级后重跑即可发现漂移（[`compatibility.md`](compatibility.md) §6.2）。

**如何验证**：

```bash
# 在仓库根执行：现算保留字集合（不要把集合写死进代码或文档）
node --import tsx -e "import('./packages/core/src/domain.ts').then((m) => console.log(m.RESERVED_ROUTE_IDS))"
curl -s localhost:3000/api/plugins/slots | jq '.routeConflicts'   # 路由 id 冲突与落败方
```

### G-13 只用文档化契约，不碰未声明的内部符号

- [ ] 服务端只依赖 `@geewiki/core` 导出的类型/常量 + `ctx.get('<服务名>')`；前端只用 [`api-reference.md`](api-reference.md) §宿主 SDK 列出的成员。

**为什么**：内置包的 `exports` 直指 `./src/index.ts`、没有独立版本 ⇒ 依赖内部符号**等于绑定主干**（`docs/agent/backlog.md` `F21`/`F22`，均**未处理**）。守卫 `packages/web/test/hostSdkSurface.test.ts` 守的是**成员存在性、getter 形态、以及版本演进说明不许删**，不守行为与签名。

**如何验证**：

```bash
rg -n "from '@geewiki/" plugins/my-note      # 出现 core/extensions、core/slots 之外的包路径 ⇒ 追问理由
pnpm run typecheck
```

---

## Tier 2 · 建议项（不收/不拒，但必须写进评审意见）

### S-01 自带 CI

- [ ] 插件自带最小工作流：`node --import tsx --test` + `typecheck` + lint。

**为什么**：外部插件在 `pnpm -r` 之外，CI 门禁**不会**自动覆盖它（`index.md` §7 第 12 条）；`.github/workflows/ci.yml` 覆盖的是内置包。
**如何验证**：`.github/workflows/`（或插件自带配置）存在，且日志里能看到跑过 `test/*.test.ts`。

### S-02 声明 `runtime.supportsHotReload` 之前实测过 drain

- [ ] 默认值是 `false`（`normalizeRuntime`，`packages/core/src/index.ts`）；写 `true` 前跑过"热替换不丢状态、不残留订阅、排空不超时"。

**为什么**：`applyTimeout` 默认 30 秒、`drainTimeout` 默认 5 秒，热替换失败会带着新配置留下（见 S-04）。声称支持热重载而实际不支持，症状是"改了配置像没改"，比明确不支持更难排查。
**如何验证**：管理台里连续两次改配置并观察 `[manager]` 排空日志；顺带记录实测宿主版本（`/api/plugins` 不返回宿主版本 ⇒ 记 SHA + 日期）。

### S-03 长连接调 `trackStream(res, owner)`，并且**不要**把 SSE 算进 `inflight`

- [ ] 每个 SSE / 长连接登记进路由服务；没有自己维护"在途请求"计数把长连接计进去。

**为什么**：长连接**故意不计入** `inflight()` / `pending()`（`HttpRouterService`，`packages/core/src/index.ts`）——处理器应当同步返回，连接随后由持有者写帧。若把它算进在途数，`drain()` 会一直等到连接关闭，必然空转满 `drainTimeout` 并打印**假的**"排空超时"告警；本仓库在 REST 卸载路径上稳定误报过一次（回归用例在 server 包 `router.test.ts`，`AP-16`）。
**如何验证**：开一条 SSE，停用插件，日志应出现"定向回收流"而不是"排空超时"。

### S-04 事件订阅者自行 `try/catch`

- [ ] 每个 `ctx.on(...)` 回调内部自兜异常。

**为什么**：`ctx.emit` 是同步广播，你的异常会**顺着原路冒回发起端点**。最坏后果不是 500 而是数据事故：保存成功、正文**已经写库**，用户看到 500 再点一次 ⇒ **写两遍**。口径见 `packages/core/src/index.ts` 的事件契约与 `AP-02`。
**如何验证**：在订阅回调里临时 `throw`，保存一篇文档看响应；修复后同一夹具应返回 200 且页面正常。

### S-05 `apply()` 内不 `await` 外部 I/O

- [ ] 网络/慢查询一律挪到首用、定时器或后台任务；`apply()` 只做注册。

**为什么**：顶到 30 秒 `applyTimeout` 会返回 504 `load_timeout`，而**此时 `fiber.config` 已经是新值** ⇒ 回滚需要再发一次带旧值的 `update`；`AP-17`。
**如何验证**：把依赖服务指到一个黑洞地址（如 `10.255.255.1`）跑 `apply()`，确认 30 秒前 `apply()` 已结算、`/api/plugins` 里没有 `load_timeout`。

### S-06 界面贡献有错误边界

- [ ] 自己的组件异常不塌整页；`replace` 贡献尤其要有兜底。

**为什么**：`replace` 模式下宿主默认实现不渲染，你崩了那一块就是空的；键盘可达性与无障碍责任已转移给你（`registerExtension` 的 docblock 明说）。
**如何验证**：临时在组件里 `throw`，确认宿主错误边界可见提示、其余界面可操作；同时确认 `wrap` 里你调了 `props.default`。

### S-07 CSS 影响面说明

- [ ] README 说明会注入哪些全局样式；类名带插件前缀（本仓库约定如 `.gw-fixture-*`，示例 `.gw-my-note-*`）；需要强隔离才用 `replace` + `shadow: true`。

**为什么**：插件 CSS 以 `<link data-plugin-ui>` **全局注入**，无前缀改写（`AP-20`）。另外硬编码颜色被守卫拦：`packages/web/test/pluginCssGuard.test.ts` 连 `plugins/*/dist/client.css` 一起扫，只用 `--gw-*` token。
**如何验证**：`pnpm --filter @geewiki/web run test`；界面切换主题确认无残留固定色；打开其它页面确认样式没串。

### S-08 文案走宿主 i18n

- [ ] 用 `host.t()` + `geewiki.locales`（键空间 `plugin.<短名>.*`），不自带字典。

**为什么**：自带字典会让"同一个界面里宿主说一套、插件说另一套"，而且没人能看到完整待翻译清单（`hostSdk.ts` 的 0.9.0 条目）。
**如何验证**：切一次语言，插件文案随动；命名空间口径见 [`api-reference.md`](api-reference.md)。

### S-09 请求归因与路径编码

- [ ] `register()` 的 `opts.owner` 填插件名；URL 里出现插件名时用 `encodeURIComponent`。

**为什么**：`ownerStats()` 只统计声明了 `owner` 的路由，未声明的进"未归因"桶——错误归因比没有归因更危险（`packages/core/src/index.ts`）；插件名含特殊字符时路径会错（`AP-26`）。
**如何验证**：跑一次带流量的请求后看 `ownerStats()` 快照里你的桶。

---

## Tier 3 · 一律拒收（不进入讨论）

### R-01 绕过宿主越权闸门

**症状**：直接改 `globalThis.__GEEWIKI_HOST__`、自己往 DOM 塞节点、或直接 import 宿主内部模块注册贡献。
**闸门**：`packages/web/src/lib/pluginUi.ts`（`createPluginUiHost`、`pluginUiDeclaredFor`、`pluginUiFailedFor`、`installPluginScope`、`syncPluginUi`、`ensureSlotLoaded`）。
**为什么**：这套闸门是"清单声明 = 唯一授权来源"，也是**归属**与**收口**的唯一依据——0.12.0 之前走"模块求值期直接调全局 SDK"的贡献来源恒为 `'host-sdk'`，插件停用后贡献收不回、且**不过**闸门（`hostSdk.ts` 的 0.12.0 条目）。绕过它的插件无法被停用，也无法被诊断（`AP-04`）。
**如何验证**：`rg -n "__GEEWIKI_HOST__|querySelector|insertBefore|appendChild" plugins/my-note/src` 出现即追问；停用后 `GET /api/plugins/slots` 必须干净。

### R-02 依赖 server / web 内部实现，而不是 `@geewiki/core` 契约

**症状**：`import` 内置包的深层路径、复用宿主的私有辅助函数、按内部符号行为写逻辑。
**为什么**：`exports` 指向源码 ⇒ 内部重构即破坏你的插件，而**这个破坏不是破坏性变更**（因为没有版本协商，`F21`/`F22`，均**未处理**）。理念是"内置与第三方走同一套接口"，走内部路径就是给自己开后门（`index.md` §1 原则一）。
**如何验证**：`rg -n "from '@geewiki/" plugins/my-note`；只允许 `@geewiki/core` 及 `core/extensions` / `core/slots` 这类已文档化的导出面（口径见 [`api-reference.md`](api-reference.md)）。

### R-03 谎报 `geewiki.provides`

**为什么**：污染别人的依赖图——依赖方 `ctx.get()` 拿 `undefined` 后静默失效，故障现象出现在**第三方插件**里，你无法通过自家测试复现（`AP-08`）。这不是 bug，是损害他人。
**如何验证**：`rg -n "provide\(" plugins/my-note` 与清单逐项对名；`GET /api/plugins/graph` 看边是否真实成立。

### R-04 bundle 自带 `react` / `react-dom`

**为什么**：宿主通过 import map 让两侧共用**同一份** React / react-dom 实例（守卫 `packages/web/test/hostSdkSurface.test.ts` 会断言 import map 的每条映射存在、指向 `/host-sdk/` 下真实存在的 shim）。自带两份 React 的典型现场是 `Cannot read properties of null (reading 'useState')`，以及 portal / 错误边界静默崩（`AP-21`；现场记录见 `packages/web/fixtures/src/index.tsx` 的 `CounterWidget` 注释）。
**如何验证**：

```bash
rg -n "\"react\"|\"react-dom\"" plugins/my-note/package.json
rg -n "from ['\"]react" plugins/my-note --glob '!*/dist/**'   # 必须走 host.React / host.jsxRuntime
find plugins/my-note -path '*node_modules/react*' -maxdepth 4
```

### R-05 把 `RequestHook` 当全局鉴权层

**症状**：在 `http.use(hook)` 里写会话校验，并认为"没过了钩子的请求就不存在"。
**为什么**：契约第 6 条明确——钩子**只对匹配到的路由执行**；未匹配的 `/api/*`、静态资源、SPA fallback **完全不过钩子**（`packages/core/src/index.ts` 的 `RequestHook` / `use`）。把它当鉴权层会做出"看起来有闸、实际能绕"的授权模型：资源不在路由表里时直接放行，而 SPA 的静态层永远放行（`AP-06`）。
**如何验证**：构造一个不在任何路由表里的 `/api/<不存在>` 与一个静态资源路径，带不带会话都试一次，确认行为符合预期；鉴权必须逐端点用 `access` + 处理器内对象级判定。

---

## PR 描述模板（作者复制）

```markdown
## Tier 1 自检
- [ ] G-01 清单字段合法（发现日志已确认 name/version）
- [ ] G-02 apply() 返回真实 disposer（停用/启用两轮，贡献条数不变）
- [ ] G-03 每条路由显式 access（GEEWIKI_STRICT_ROUTE_ACCESS=1 能启动）
- [ ] G-04 声明与注册双向一致（/api/plugins/slots + /api/plugins/ui 截图或输出）
- [ ] G-05 测试：node --import tsx --test plugins/<name>/test/*.test.ts 全绿
- [ ] G-06 README 最短路径可照抄跑通（附命令与实际输出）
- [ ] G-07 迁移双方言 / 已登记 SQLITE_ONLY 并带原因
- [ ] G-08 README 写明依赖 + 权限用途 + 网络域名
- [ ] G-09 凭据全部 meta.role === 'secret'（config 端点响应里为 <redacted>）
- [ ] G-10 无真实私有端点/凭据（示例用 api.example.com/v1）
- [ ] G-11 provides 与 ctx.provide() 同名同存
- [ ] G-12 路由 id 不撞保留字（集合现算，并写进插件测试）
- [ ] G-13 只依赖 @geewiki/core 契约 + 文档化 SDK 成员

## Tier 2 状态（逐条：已做 / 未做 + 原因）
S-01 CI：…  S-02 supportsHotReload 实测：…  S-03 trackStream：…  S-04 订阅 try/catch：…
S-05 apply 无外部 I/O：…  S-06 错误边界：…  S-07 CSS 影响面：…  S-08 i18n：…  S-09 owner/编码：…

## 兼容声明
- 实测宿主：日期 ____ / 主干 SHA ____（宿主侧无版本号读数，见 compatibility.md §7）
- 用到的新宿主能力 + 各自的降级路径：____
```

---

## 已知门禁缺口（评审者必须人工补位，别当成"CI 绿了"）

| 缺口 | 现状 | 对策 |
| 外部插件不进 CI | `plugins/*` 不是 workspace 包、`plugins/*/package.json` 无 `scripts` ⇒ `pnpm -r` 跑不到它们 | 按 G-05/S-01 人工跑；插件自带 CI 是 S-01 |
| 无宿主版本协商 / 无宿主版本读数 | 清单无 `minHostVersion`，`/api/plugins` 不返回宿主版本（`docs/agent/backlog.md` `F22`，**P2/未处理**） | README 写"实测日期 + SHA"（[`compatibility.md`](compatibility.md)） |
| 无 `CHANGELOG.md` | 仓库根没有该文件；唯一历史文档 `docs/changelog/implementation-log.md` 自称**历史快照**、`docs/README.md` 标其"非当前口径" | 评审不假设"变更会被通告"；契约现状只看 [`../plugin-platform.md`](../plugin-platform.md) |
| 无签名发布者 | `install-plugin` 只给完整性基线（`ok` / `drift` / `unsigned` / `missing`），`unsigned` ≠ `ok` | 收录时人工核对作者与来源（`docs/roadmap.md` "外部插件签名"） |
| 权限不强制 | `PLUGIN_PERMISSIONS` 只声明不拦截，未知值只告警 | 按 G-08 核对 README 与代码实际行为一致 |
