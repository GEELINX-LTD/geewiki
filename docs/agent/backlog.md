# 理念违背整改台账（agent backlog）

> **这是一份「现状快照」，不是路线图。** 它记录的是**当前代码/文档与产品理念（README.md、docs/architecture.md）
> 对不上或存在风险的地方**，逐条给出可验证的事实与最小改法。
>
> - **核实日期**：2026-09-28（UTC）
> - **核实基准 HEAD**：`64ff6fa`（2026-09-22）。**注意**：本轮任务书里写的基准是 `ed2a3a9`，
>   `ed2a3a9` 是 `64ff6fa` 的祖先，两者相差 **111 个提交**；本台账所有事实以 **`64ff6fa`** 为准。
> - **本轮处理策略**：**文档如实写清 + 单列本台账**，**不改动任何运行时代码行为**。
>   因此下面凡是「改代码」的建议都只是**建议**，落地由后续批次决定。
> - **条目生命周期（重要）**：某条修好后**删除该条目**，并把结论写进对应的真源文档
>   （`docs/plugin-platform.md` 的「当前限制与风险」、`docs/development.md`、`docs/deployment.md`…）。
>   **台账只放未修的事**；否则它会变成第二个腐化源。
> - **严重度定义**：
>   - **P0** = 生产环境会静默失去访问控制保护，或部署即不可用；
>   - **P1** = 需要特定触发条件才出问题，或文档/门禁与事实不符会误导决策；
>   - **P2** = 摩擦、口径陈旧、生态可用性缺口。
> - **引用写法**：一律「路径 + 符号名」；行号只作为**辅助注**（形如「截至 `64ff6fa` 约第 N 行，会漂移」），
>   不作为定位依据（见 `docs/agent/conventions.md` 文档纪律）。

**图例（状态）**：`未处理` / `部分已缓解`（已有缓解机制但问题主体仍在）/ `本轮已修（文档）`（本轮只补文档，行为未变）/ `本轮处理`（本轮由并行的其他 agent 或 Implementer 落地）。

---

## P0

### F1 · 路由访问等级默认 `public`（fail-open 默认值）

- **严重度**：**P0**
- **违背**：「安全可控」——默认值把「忘记写权限」变成「匿名可调用」，而不是失败。
- **现状事实**：
  - 类型声明：`packages/core/src/index.ts` 的 `RouteAccess = 'public' | 'user' | 'admin'`，
    以及 `RouteAccessOptions.access?`（可选）——注释自己写明「**省略等价于 `{ access: 'public' }`**」
    （截至 `64ff6fa` 约在第 805 / 809 行，会漂移）。
  - 落地实现：`packages/server/src/index.ts` 注册路由处 `access: opts?.access ?? 'public'`，
    并带一条注释说明「默认 public：只传 3 个实参的既有调用点（以及全部现存插件）行为完全不变」——
    即这是**为兼容性刻意保留的 fail-open**。
  - **已有强制机制（本轮复核结论：不是「零强制」，而是「半强制」）**：
    - `packages/core/src/index.ts` 的 `HttpRouteInfo` 带 `access` / `explicit` / `owner` 三字段，
      其中 `explicit` 的注释本身就是判据原文：「`access: 'public'` + `explicit: false` =
      "作者没想过这件事"，需要被点名；`explicit: true` = "作者明确选择了公开"」。
    - 同文件 `export function unauditedRoutes(routes: readonly HttpRouteInfo[]): readonly HttpRouteInfo[]`
      —— 把「未点名」抽成可复用判据，而不是散落在告警文案里。
    - `packages/server/src/index.ts` 的 `auditRouteAccess(router, env)` 在启动时把这些路由聚合成
      **一条告警**（文案 `[geewiki] N/M 条路由未显式声明访问等级，正按默认 'public'（匿名可调）运行：`），
      并在 `env[STRICT_ROUTE_ACCESS_ENV] === '1'`（即 `GEEWIKI_STRICT_ROUTE_ACCESS`）**抛错拒绝启动**；
      组合根无条件调用 `auditRouteAccess(routerForAudit)`。
    - 守卫：`packages/server/test/route-access-audit.test.ts` 存在（直接用 `unauditedRoutes()` 断言越界清单）。
  - **但默认值一行未改**：`access: opts?.access ?? 'public'` 仍是 fail-open ⇒ 上面四件全部是
    **事后审计 + 运维可选开关**，没有一件能在「作者漏写第 4 参」的当下阻止危险路由上线。
- **严重度依据（本轮改写，原写法「完全没有强制」不准确）**：保留 **P0**，但依据改为
  「**默认值 fail-open 未变，强制只存在于事后可审计与运维可选开关**」——默认部署不会设
  `GEEWIKI_STRICT_ROUTE_ACCESS=1`，此时漏写权限的路径确实匿名可调，仍符合 P0 定义
  「生产环境会静默失去访问控制保护」；缓解机制降低的是「无人发现」的概率，不是失守本身。
- **影响**：新增路由的作者只要漏写第 4 参，该路由就**匿名可调**；单靠一条启动告警极易被忽略。
  写操作类路由（`POST` / `PUT` / `DELETE`）一旦 fail-open，等于直接对外暴露写接口。
- **建议改法（最小改动优先）**：
  1. **先做只读审计**：在 `auditRouteAccess()` 里把「未显式声明」按 **HTTP 方法**与 **owner 包**分组，
     输出「写操作里有几条匿名可调」——先量化影响面，再谈默认值。
  2. **默认值改 fail-closed**（`?? 'user'`），并保留 `GEEWIKI_STRICT_ROUTE_ACCESS` 之外的过渡开关；
     影响面评估口径：内置注册条目 **25 条**（`grep -c "source: 'builtin'" packages/server/src/index.ts`）、
     默认启用 **21 条**（`config/plugins.base.example.json` 的 `enabled`），全仓 `.register(` 调用点上百处
     （`grep -rn "router\.register(" packages/*/src`）——**逐条标注 `public` 是必要成本**。
  3. 更便宜的中间态：只把**写方法**（非 `GET`/`HEAD`）的默认值改成 `user`，读路由维持现状。
- **验证方式**：临时设 `GEEWIKI_STRICT_ROUTE_ACCESS=1` 启动一次，`[geewiki] N/M 条路由未显式声明…`
  里的 **N 必须为 0**；再跑 `packages/plugin-auth/test/e2e-p1.sh`（匿名访问受保护路由须 401/403）。
  改默认值后需补守卫单测：断言 `register()` 省略 `access` 时解析结果不是 `public`。
- **风险与兼容性**：**破坏性**。所有未显式声明的既有路由（含全部现存插件与只传 3 个实参的调用点）
  行为改变 ⇒ 匿名读接口可能对未登录用户返回 401。必须配套一次性全仓标注 + 迁移说明（`docs/deployment.md` 排障节）。
- **状态**：`部分已缓解`（F11 审计 + STRICT 开关 = **半强制**已落地；默认值未改 ⇒ 问题主体仍在）。
  另见 `docs/plugin-platform.md`「当前限制与风险」表中同一问题（记为「中」）。

### F2 · 插件权限是纯声明，宿主完全不强制

- **严重度**：**P0**
- **违背**：「安全可控」——`permissions` 清单给了「已管控」的错觉，实际零拦截。
- **现状事实**：
  - `packages/core/src/domain.ts`：`export type PluginPermission`
    （取值 `fs:read` | `fs:write` | `env` | `net` | `process` | `secrets`）+
    `export const PLUGIN_PERMISSIONS = [...] as const`（数组顺序 = 危险度升序）+
    `isPluginPermission()` / `sortPermissions()`。
  - `packages/core/src/index.ts` 的 manifest 字段 `permissions?: PluginPermission[]` 注释自认：
    宿主**不做强制**（同进程、同权限），且「未知取值会被**拒绝并告警**（不阻断激活）」。
  - 告警点：`packages/manager/src/index.ts` 的 `[manager:permissions] 插件 ${owner} 声明了未知权限 …，已忽略`。
  - 无沙箱、无资源配额：`docs/plugin-platform.md`「当前限制与风险」已如实登记
    「插件与宿主同进程、同权限……一个坏插件能拖垮整站」，并把 worker / 子进程隔离**有意后置**。
- **影响**：一个声明了 `fs:write` 的插件依然能改写宿主任意文件；不声明任何权限的插件同样能读写文件、
  发网络请求、死循环、OOM。**权限清单目前只有「告知人」的作用，没有「拦住代码」的作用。**
- **建议改法（最小改动优先，按成本递增）**：
  1. **零风险**：在管理台插件详情 / `GET /api/plugins` 快照里把「权限=声明，不强制」写成人人看得见的
     提示（现在只在类型注释里），README 的「安全可控」一节同步加一句边界说明；
  2. 宿主侧提供**受控代理 API**（`ctx.fs` / `ctx.net` 之类），并让 ESLint 或运行期约定引导插件不走
     Node 原生 `fs` / `fetch`——**只有走代理的插件，权限声明才有意义**；
  3. 事后审计：把已声明权限与实际调用次数记进审计日志（复用 `writeAuditLog`），至少做到「声明与使用不匹配」可见；
  4. 真正的进程边界（worker / 子进程）——**成本高，维持后置**。
- **验证方式**：第 1 步可用文档 + 快照字段守卫单测验证；
  第 2/3 步落地后补断言单测：未声明 `net` 的插件调用受控网络代理 ⇒ 被拒 + 审计留痕。
- **风险与兼容性**：第 1 步无风险（纯文案/展示）。第 2、3 步会让**存量插件失能**（它们目前直接用 `fs` / `fetch`），
  必须做成「只告警不拦截」的过渡期。**在做出真实强制之前，README 与所有对外表述都不应暗示权限已被执行。**
- **状态**：`未处理`（现状为有意设计，但产品文案口径未同步收缩）。

### F3 · `provides` 只是依赖图 token，谎报后功能静默失效

- **严重度**：**P0**
- **违背**：「安全可控」+ 插件平台的可预期性（静默失败是文档纪律明令要消灭的类别）。
- **现状事实**：
  - `packages/manager/src/deps.ts`：`requires` 的每一项先按插件名匹配、再按 `provides` 服务标识匹配
    （`registry.filter((p) => p.manifest.geewiki.provides === dep)`）——**`provides` 的全部语义就是依赖图里的一个 token**。
  - 没有任何地方依据 `provides` 去 `ctx.provide(...)` 创建 cordis 服务。
  - `packages/plugin-echo/src/index.ts` 的文件头注释把这条讲得很清楚：manifest 的 `provides` 只是
    **依赖图谱 token**，不会创建任何 cordis 服务；任何按 `requires: ['echo-service']` 依赖它的插件都会被
    解析成「依赖已满足」，而实际 `ctx.get('echo-service')` **恒为 `undefined`**
    ——症状是功能静默不可用、**不报错**。
- **影响**：插件作者照 README「声明能力标识」的说明填了 `provides` 却没在 `apply()` 里真的 provide 服务，
  依赖方的启动检查全部通过，故障推迟到运行期某次静默 no-op。排查成本极高。
- **建议改法（最小改动优先）**：
  1. 启动期加一条校验：对每个被 `requires` 命中的 `provides` token，检查 owner 是否在 `apply()` 中
     真实 provide 过该标识（cordis fiber 结算后可查）；查不到就输出一条**启动告警**（对齐 F1 的做法：聚合一条）；
  2. `docs/plugin-platform.md` 的 Manifest 表里把「`provides` 不创建服务」从源码注释提升为**成文契约**（本轮已在
     `docs/agent/conventions.md` 落了提示，正式契约位应在 plugin-platform）。
- **验证方式**：把 `packages/plugin-echo` 的 `apply()` 里真实 `ctx.provide('echo-service', …)` 注释掉，
  加一个 `requires: ['echo-service']` 的夹具插件 ⇒ 启动日志必须出现新告警（当前：什么都不说）。
- **风险与兼容性**：新增告警为**非阻断** ⇒ 兼容；若在解析阶段直接拒绝启动则会打断既有部署（不建议）。
- **状态**：`未处理`。

### F4 · 空 `config` 挂载 ⇒ 空清单 ⇒ HTTP 不监听 ⇒ 静默重启循环（退出码 0）

- **严重度**：**P0**
- **违背**：「极致轻量」不等于「静默失败」；Docker 部署的主要路径上有一个踩了就静默的坑。
- **现状事实**：
  - 触发条件（**已在 `docker-compose.yml` 的注释与 `docs/deployment.md` 中如实写明**）：
    把 `GEEWIKI_CONFIG_DIR` 指向不存在/空目录（常见于把宿主空目录 bind 进 `/app/config` 遮蔽了镜像内置模板）。
  - 症状（`docs/deployment.md` 原文记录）：日志里只剩一行
    `[@geewiki/manager] http 路由服务不可用：REST API 未挂载`，**进程退出码 0**，
    被 `restart: unless-stopped` 反复拉起 ⇒ 端口永不监听、无错误堆栈。
  - 镜像内置真源：`/app/config/plugins.base.json`（当前默认启用 21 条，口径见 `config/plugins.base.example.json`）。
- **影响**：容器状态显示 `Up`、健康检查失败但**没有任何一条日志说明原因**；
  排障者会先怀疑网络/端口，而真因是「配置目录被遮蔽 ⇒ 清单为空 ⇒ manager 没有 http 服务」。
- **建议改法（最小改动优先）**：
  1. 启动期判定「清单为空**且**镜像/默认模板本应存在」⇒ 直接 **fail-fast**：打印明确原因并以非 0 退出，
     让 `restart:` 策略在日志里暴露问题（改动集中在 manager 启动装配处）；
  2. 更保守：至少把 `REST API 未挂载` 从 `logger.warn` 升级为带修复指引的 error（写明
     「`GEEWIKI_CONFIG_DIR` 指向的目录没有清单文件；容器内请检查是否被空卷遮蔽，模板在 `/app/config/plugins.base.json`」）。
- **验证方式**：`GEEWIKI_CONFIG_DIR=/tmp/nope pnpm run start` ⇒ 期望非 0 退出 + 一条含 `plugins.base.json`
  字样的错误；compose 场景下 `docker compose ps` 应显示 restarting 而不是 `Up`。
  可加守卫单测：空清单 + 无模板 ⇒ 启动结果带明确错误码（复用 `packages/manager/test/`）。
- **风险与兼容性**：`plugins: []`（**有意**全关插件）是合法配置，**不能被误判为错误** ⇒
  fail-fast 的判据必须是「清单文件缺失 / 目录不可读」，而不是「enabled 为空」。
- **状态**：`未处理`（现状：文档已写明，行为仍静默）。

---

## P1

### F5 · `geewiki.slots` 声明与实际 `registerSlot` 不一致 ⇒ 界面静默空白

- **严重度**：**P1**（触发需前端插件声明错误，但症状完全静默）
- **违背**：「高可扩展」的可用性面 + 消灭静默失败。
- **现状事实**：
  - `packages/core/src/index.ts` 的 manifest 有 `slots?: SlotName[]`（供依赖图/管理台展示）。
  - 前端产物侧另有 `registerSlot()` 声明；两侧一致性由 `packages/manager/src/slots.ts` 的
    `effectiveSlotsByOwner` / `conflictsOf` 汇总，经 `GET /api/plugins/slots` 下发（**能查询，不等于会校验**）。
  - 单占用插槽冲突时**激活顺序最早者胜出**，其余进 `conflicts` 列表（README 已写）。
- **影响**：manifest 写了 `slots` 但 bundle 没 `registerSlot`（或名字拼错）⇒ 该位置**什么都不渲染、不报错**；
  作者只能靠人肉翻管理台发现。
- **建议改法（最小改动）**：入口表构建时（`packages/manager/src/plugin-ui.ts` 的 `buildPluginUiTable` 路径）
  比对 manifest `slots` 与 bundle 侧收集到的 slot 名，差集写入 `skipped`/`conflicts` 附带原因，
  复用既有的分级渲染（`classifyUiSkips` ⇒ attention 级 warning Card），**前端无需新增界面**。
- **验证方式**：夹具插件声明 `slots: ['wiki.sidebar@1']` 但 bundle 不注册 ⇒
  `GET /api/plugins/slots` 或入口表 `skipped` 必须出现该差集（当前：静默）。
- **风险与兼容性**：只新增 skipped 原因项 ⇒ 低风险；注意别把「bundle 尚未加载完成」误报成不一致。
- **状态**：`未处理`。

### F6 · 4 个安全/运维相关环境变量此前查无文档

- **严重度**：**P1**（本轮已补文档，行为未变）
- **违背**：「安全可控」依赖「可配置且可发现」；文档纪律要求配置项有唯一权威出处。
- **现状事实**（语义均已回源码核实；**核实前 README.md 与 docs/deployment.md 的环境变量表里都没有这四个**）：
  | 变量 | 消费者（符号） | 语义 | 默认 |
  | --- | --- | --- | --- |
  | `GEEWIKI_ADMIN_TOKEN` | `packages/server/src/index.ts` 的 `ADMIN_TOKEN_ENV` / `envAdminToken()` | break-glass 令牌；头 `x-gw-admin-token` 或 `Authorization: Bearer <token>`；**未设置 = 整条通道禁用**（无回退值，空串也算未启用）；每次使用打 stdout 结构化行 + `writeAuditLog({ action: 'access.break_glass' })`；未配令牌时受保护端点返回 **503 `bootstrap_required`**（不是 401） | 未设置（禁用） |
  | `GEEWIKI_STRICT_ROUTE_ACCESS` | 同文件 `STRICT_ROUTE_ACCESS_ENV` + `auditRouteAccess()` | `1` ⇒ 存在未显式声明 `access` 的路由时**拒绝启动** | 未设置（只告警） |
  | `GEEWIKI_BACKUP_DIR` | `packages/manager/src/index.ts` 的 `createBackup()`（restore 路径同样读一次） | 备份/恢复的默认输出目录 | `<仓库根>/backups` |
  | `GEEWIKI_OPENAI_DEBUG` | `packages/plugin-openai/src/provider.ts` 的 `configLogEnabled()` | **默认开启**；设为 `0` 才关闭上游错误诊断日志 | 开启 |
- **影响**：运维不知道有 break-glass 通道（既可能漏配，也可能配了不知道有审计）；
  不知道 `GEEWIKI_OPENAI_DEBUG` **默认在打诊断日志**，等于默认多一个日志出口。
- **建议改法**：见任务三第 5 条——**本轮已把四者写进 README.md 与 docs/deployment.md 的变量表**
  （`GEEWIKI_ADMIN_TOKEN` 标注为 break-glass + 风险）。
- **验证方式**：`grep -c 'GEEWIKI_ADMIN_TOKEN\|GEEWIKI_STRICT_ROUTE_ACCESS\|GEEWIKI_BACKUP_DIR\|GEEWIKI_OPENAI_DEBUG' README.md docs/deployment.md` ⇒ 均 ≥ 4。
- **风险与兼容性**：无（纯文档）。
- **状态**：`本轮已修（文档）`（**本轮复核：上一轮标为「已修」时并未真正落地**——动手前
  `grep -c 'GEEWIKI_ADMIN_TOKEN\|GEEWIKI_STRICT_ROUTE_ACCESS\|GEEWIKI_BACKUP_DIR\|GEEWIKI_OPENAI_DEBUG' README.md docs/deployment.md`
  返回 `README.md:0`、`docs/deployment.md:0`；本轮才把四个变量真正写进两处表格）。
  另注：本条表中 `GEEWIKI_ADMIN_TOKEN` 那行的「未配令牌时受保护端点返回 503」应读作
  「**完全没有凭据来源**时才 503 `bootstrap_required`」（`judgeAccess` 的判据是
  `credentialSourceAvailable`，P1 起还包含库里是否有可登录账号）；已有账号时未配 break-glass
  令牌走正常 401/403，**不会** 503。**修好复核后请删除本条**。

### F7 · `GEEWIKI_OPENAI_DEBUG` 默认开启诊断日志

- **严重度**：**P1**（与 F6 同源，但这是**行为**问题，不随文档补齐而消失）
- **违背**：「安全可控」的默认值取向（安全默认应当是「显式开启才多说话」）。
- **现状事实**：`packages/plugin-openai/src/provider.ts` 的 `configLogEnabled()` 实现为
  `process.env['GEEWIKI_OPENAI_DEBUG'] !== '0'` —— 即**只有显式设成 `'0'` 才关闭**；
  其它任何取值（含未设置）都在上游请求失败时输出诊断日志。
- **影响**：上游错误日志可能包含请求上下文（模型名、上游 baseUrl、错误体）；
  在共享日志聚合环境里属于「默认外泄面 > 预期」。
- **建议改法（最小改动）**：把判据反转为默认关（`=!= '1'`），或在 README「接入模型」一节显著标注默认开
  ——**取向由维护者定**，但「默认开 + 文档此前没写」这个组合必须先消掉（F6 已消掉文档部分）。
- **验证方式**：默认环境（不设变量）触发一次上游 4xx，确认是否落日志与内容项；反转默认后单测
  `configLogEnabled()` 的三种取值（未设置 / `'0'` / `'1'`）。
- **风险与兼容性**：反转默认会让排障习惯改变（需要显式设 `=1`）⇒ 属**行为变更**，本轮**不做**，仅登记。
- **状态**：`未处理`。

### F8 · 出厂配置模板写死私有端点与私有模型名

- **严重度**：**P1**
- **违背**：「不绑厂商」、对外可复用性（模板是私有部署的第一道门）。
- **现状事实**：`config/plugins.base.example.json` 的 LLM 条目里直接写着
  `"baseUrl": "https://example.com/llm/v1"` 与 `"model": "DeepSeek V4 Flash"`。
  该文件是**随版本发布的示例**（口径真源之一，见 `docs/README.md`「事实的真源」）；
  本机 live 文件 `config/plugins.base.json` 不入库（`docs/deployment.md` 已说明），
  `config/secrets.json` 也被 `.gitignore` 忽略。
- **影响**：新克隆按示例填写会先打到一个**不属于自己**的端点；
  若仓库公开，则等于对外披露自建代理端点与内部模型命名。
- **建议改法（最小改动）**：示例改为厂商中性占位（`https://api.openai.com/v1` + `gpt-4o-mini` 之类
  或直接用 `<你的 OpenAI 兼容端点>` 占位）＋ 一行注释指向 `apiKeyEnv` 兜底路径；
  同时在 `docs/deployment.md`「接入模型」保留一句「示例端点仅为占位」。
- **验证方式**：`grep -n 'zhigu' config/*.json README.md docs/*.md` 应无命中；
  `pnpm typecheck` / `pnpm test` 不受影响（纯 JSON 值）。
- **风险与兼容性**：`plugins.base.example.json` 是**数量口径真源** ⇒ 只改端点/模型字符串、
  不动 `enabled` 列表，就不影响任何计数类断言。**本轮不改**（任务书禁止改 config 模板）。
- **状态**：`未处理`。

### F9 · 版本与阶段元数据严重滞后（`description` 仍写「Phase 0 骨架」）

- **严重度**：**P1**
- **违背**：对外一致性、「事实只有一个真源」。
- **现状事实**：根 `package.json` 的 `description` = 「GeeWiki —— AI-Native 插件化知识库系统（**Phase 0 骨架**）」、
  `version` = `0.1.0`、`private: true`；`docs/roadmap.md` 阶段总览写 Phase 0/1/2 ✅、Phase 3 ✅ 主体完成（P0–P8）、
  Phase 4 ✅ 主体完成。仓库根**无 `CHANGELOG.md`**，唯一历史文档是
  `docs/changelog/implementation-log.md`（约 242 KB，且 `docs/README.md` 标其「**非当前口径**」）。
- **影响**：任何从 `package.json` / 包清单读「这是什么、到什么阶段」的工具或新人，
  读到的都是三年前的口径。
- **建议改法**：① `description` 去掉「Phase 0 骨架」，改为能力描述；
  ② 根 `CHANGELOG.md`（Keep a Changelog 风格）只写**用户可感知**的变更，implementation-log 明确降级为「开发流水（非口径）」；
  ③ 版本号策略写进 `docs/development.md`（配合 F21 的 npm 发布问题一起定）。
- **验证方式**：`grep -n 'Phase 0' package.json` 无命中；`test -f CHANGELOG.md`；
  `docs/README.md` 文档地图新增该条目（挂纪律第 6 条）。
- **风险与兼容性**：`version` 跳号会影响 Docker 镜像 tag 与 `pnpm` 锁文件无关（`private: true`）⇒ 低风险。
- **状态**：`未处理`。

### F10 · 文档地图不完整：`docs/README.md` 漏登 4 篇（正违反其自身纪律第 6 条）

- **严重度**：**P1**
- **违背**：自家「事实真源」纪律第 6 条（新增/改名/删除文档必须同步全仓引用）。
- **现状事实**：`docs/` 实际有 **14 篇** .md，`design/` 实为 **6 篇**
  （`access-control` / `ai-plugin-architecture` / `attachments` / `block-attribution` / `dock-images` / `ui-extension-platform`），
  但 `docs/README.md` 的「文档地图」代码块只列到 `design/` 的 3 篇，
  **完全没提 `docs/ci-cd.md`**，「我想……」表里也没有 CI/CD 一行。
- **影响**：读者不知道有 CI/CD 真源（于是去猜 CI 跑了什么）、不知道有 3 篇定稿设计。
- **建议改法**：**本轮已重做**（任务三第 1 条）——地图按实际文件树重建，并补本轮新增的
  `agent/`、`plugin/`、`adr/` 与根 `CONTRIBUTING.md` / `ARCHITECTURE.md` 的角色定位（真源 vs 索引）。
- **验证方式**：把 `docs/README.md` 地图里出现的相对路径逐个 `test -e`；反向 `find docs -name '*.md'`
  每一篇都能在地图中找到。**这两条应固化成一条 docs 门禁**（本轮 Implementer 正在补的门禁里加一条最合适）。
- **风险与兼容性**：无。
- **状态**：`本轮已修（文档）`。复核后删除本条，把「地图必须与文件树一致」这条**留在 `docs/development.md` 文档纪律**
  与门禁里即可。

### F11 · 写死读数已腐化（CI 注释、验收基线）

- **严重度**：**P1**
- **违背**：`docs/README.md` 纪律第 5 条（具体读数必须给出取数方式；「过时的数字比没有数字更坏」）。
- **现状事实**：
  - `.github/workflows/ci.yml` 的 step **名称**写「单元测试（node:test，**177 个测试文件**）」，
    实际 `find packages -name '*.test.ts' -not -path '*/node_modules/*'` = **198**。
    ⚠️ 该 step 名同文件注释明确说明「会被分支保护规则引用为必需状态检查」——
    **本轮只改 `name:` 里的数字说法为不带数字的表述，不改作业名 lint/typecheck/test/build**。
  - `docs/development.md` §4.7「验证基线（复现用）」末段记录「`main` = `ed2a3a9` …
    `pnpm typecheck` exit 0（**17 包**全 Done）；`pnpm test` **886 / 886** 通过；六条 e2e **共 325 项断言**」
    ——现状是 **28 个包**、**8 个 e2e 脚本**（见 F15），该组读数整段过期。
  - `docs/ci-cd.md` §6「未纳入 CI 的部分（诚实清单）」**已如实登记** e2e 与 acceptance 不进 CI
    （并说明 type-aware ESLint / React Compiler 规则也不进 CI）——这一处**不需要修**。
- **建议改法**：**本轮已把上述两处改为「以命令输出为准」**并保留方法论（命令 + HEAD + 时刻）；
  后续新增读数一律按纪律第 5 条写。
- **验证方式**：`grep -rn "177 个测试文件\|886 / 886\|17 个包" .github docs README.md` 应无命中。
- **风险与兼容性**：`ci.yml` 只动注释文字 ⇒ 零风险（已用 `git diff` 复核）。
- **状态**：`本轮已修（文档）`。

### F12 · 无规范强制门禁：无 CONTRIBUTING、无 commitlint / hooks / formatter / 覆盖率门禁

- **严重度**：**P1**
- **违背**：「规范可机器执行」。
- **现状事实**：仓库根只有 `README.md` 一个 .md（**无 `CONTRIBUTING.md`**）；
  根 `package.json` devDependencies 只有 `@eslint/js`、`@types/*`、`eslint`、`eslint-plugin-react-hooks`、
  `globals`、`tsx`、`typescript`、`typescript-eslint`——**没有 commitlint / husky / lint-staged / prettier / 覆盖率工具**；
  唯一硬门禁是 `pnpm lint`（`eslint . --max-warnings 0`）+ `pnpm typecheck` + `pnpm test` + `pnpm build`。
  风格唯一来源是 `.editorconfig`（utf-8 / LF / space 2 / trim trailing / final newline）。
- **建议改法**：本轮 Implementer 在独立 worktree 补 commitlint + husky + lint-staged + docs 门禁；
  本文档体系补 `CONTRIBUTING.md`（agent A）。**注意**：加 formatter 会与存量代码冲突（当前无 prettier 配置），
  建议**只加编辑期约定 + lint 门禁，不引入全仓重排**。
- **验证方式**：门禁落地后：提交一条 `bad message` 应被 commit-msg hook 拒；`docs/` 改动未同步
  `docs/README.md` 应被 docs 门禁拒。
- **风险与兼容性**：hooks 只影响本地提交流程；CI 侧新增检查需要同步分支保护的 required checks
  （见 `docs/ci-cd.md` §7 的 `main-protection` ruleset）。
- **状态**：`本轮处理`（不在本代理范围）。

### F13 · 覆盖率与规范类文档此前无 agent 落点（无 AGENTS.md）

- **严重度**：**P1**（本轮部分处置）
- **违背**：「规范可机器执行」+ 文档体系面向 AI agent 的可发现性。
- **现状事实**：核实前仓库**无** `AGENTS.md` / `CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md` /
  `.github/instructions/`；面向 agent 的唯一入口是 `docs/README.md`（面向人类索引，不含硬性执行约定）。
- **本轮已做**：新增根 `AGENTS.md`，并在 `docs/README.md` 地图登记。**入口层只有一个文件**——
  它只放「读代码读不出来」的东西（命令陷阱、隐性契约、文档纪律），细则一律链接到
  `docs/agent/conventions.md`，不复述（避免同一规范两处维护）。
- **明确不做的部分（用户于本轮决定）**：`CLAUDE.md` 与 `.github/instructions/*` **不建**。
  理由：它们的内容与 `AGENTS.md` 同源，复制一份就是第 2、第 3 个真源——正是本仓要治的病；
  而主流代理已能读 `AGENTS.md`。**如果将来发现某个代理确实只读 `CLAUDE.md`**，
  再加一个只含单行 `@AGENTS.md` 的转发文件（而不是复述内容）。
- **验证方式**：`test -f AGENTS.md && grep -c 'docs/agent/conventions.md' AGENTS.md`（应 ≥ 1）。
- **风险与兼容性**：无运行时影响。
- **状态**：`部分完成（入口已建；CLAUDE.md / instructions 按决定不做）`。

### F14 · `docs/plugin-platform.md` 大量以「路径:行号」引用代码（含第三方库行号）

- **严重度**：**P2**（不影响行为，但直接制造腐化）
- **违背**：自家文档纪律——行号会漂移。
- **现状事实**：`grep -cE '\.ts:[0-9]+' docs/plugin-platform.md` = **30 处**
  （集中在该文件中段的安全表、插件 UI 表、检索契约节）。
  已确认漂移的一例：表格里的 `packages/core/src/index.ts:567-570`（指 `access?`），真实位置在
  `RouteAccessOptions.access?`（截至 `64ff6fa` 约第 809 行）。
  **另需注意**：这 30 处中有相当一部分形如 `src/index.ts:235-246`，指的是**第三方库 schemastery 的内部源码**
  ——本仓库无法保证其行号稳定，只能改成「符号名 + 行为描述」。
- **建议改法**：**本轮已把全部 30 处改写为「路径 + 符号名」**，只改引用写法、不动契约语义
  （agent B 正在写 `docs/plugin/*` 并索引该文件，语义必须稳定）。
- **验证方式**：`grep -cE '\.ts:[0-9]+' docs/plugin-platform.md` ⇒ **0**；
  `git diff --stat docs/plugin-platform.md` 复核语义未变。
- **风险与兼容性**：低；但改写时必须逐条确认符号名真实存在（本轮已回源码核对）。
- **状态**：`本轮已修（文档）`。

### F15 · 8 个 e2e shell 与 CDP 界面验收完全不在 CI

- **严重度**：**P2**
- **违背**：「规范可机器执行」。
- **现状事实**：
  - e2e shell 共 **8 个**：`packages/plugin-auth/test/e2e-p1.sh`、
    `packages/plugin-authz/test/e2e-p2.sh`、`packages/plugin-authz/test/e2e-p4.sh`、
    `packages/plugin-oidc/test/e2e-p15.sh`、`packages/plugin-org/test/e2e-p2-org.sh`、
    `packages/plugin-wiki/test/e2e-p3a.sh`、`packages/plugin-wiki/test/e2e-attachments.sh`、
    `packages/plugin-wiki/test/e2e-version-meta.sh`。
  - `scripts/acceptance/` 下有 `*_cdp.mjs`（block-attribution / editor-modes / plugin-ui /
    theme-header / ui-extension）与多个 `pN-*/` 目录（需真实浏览器 + 运行中的服务）。
  - `.github/workflows/ci.yml` 的 jobs 只有 `lint` / `typecheck` / `test` / `build` / `docker-build`(PR) /
    `publish`——**不含任何 e2e 或 acceptance**。
  - `docs/ci-cd.md` §6 已**如实登记**这一事实；`docs/development.md` §4.6/§4.8 也如实保留「真实浏览器交互从未验证」
    （本轮在该处补了指向脚本位置的链接）。
- **影响**：PG 路径、附件、版本元数据、OIDC 全流程、真实浏览器交互**没有门禁**，全靠人工跑。
- **建议改法（最小改动优先）**：
  1. 先在 CI 加**一条** PG job（service container 起 `postgres:15-alpine`），跑 1~2 个最有代表性的 e2e
     （建议 `e2e-p2.sh` + `e2e-attachments.sh`），验证端口/隔离配方在 CI 里成立；
  2. acceptance 继续留在 CI 外（`docs/ci-cd.md` §6 的理由成立），但把「每个 release 前手工跑一遍并归档结果 JSON」
     写进发布清单。
- **验证方式**：CI 出现 e2e job 且绿色；`docs/ci-cd.md` §6 同步删除已进 CI 的条目。
- **风险与兼容性**：e2e 需要固定端口与 PG 容器，**并发作业会互抢端口**（`docs/development.md` §1 已记录
  「多实例必败」）⇒ 必须给每个 job 独立端口段或使用 `PORT` 注入。
- **状态**：`未处理`。

### F16 · 覆盖不均：两个包完全没有测试

- **严重度**：**P2**
- **违背**：「规范可机器执行」。
- **现状事实**：`packages/plugin-echo`、`packages/plugin-editor-plain` 的 `package.json`
  **没有 `test` 脚本**，且**不存在 `test/` 目录**。
  各包 `*.test.ts` 数量分布（`find packages -name '*.test.ts' -not -path '*/node_modules/*'`，合计 198）
  高度不均：`web` 89、`manager` 24、`server` 10、`plugin-wiki` 11、`plugin-ai-assistant` 14、`core` 6、
  `plugin-llm` 7、`plugin-openai` 5、`db-*` 各 2，
  而 `plugin-ai-admin` / `plugin-ai-kb` / `plugin-ai-nav` / `plugin-auth` / `plugin-oidc` /
  `plugin-org` / `plugin-search` **各只有 1 个**。
  根 `package.json` 无覆盖率配置（无 `--experimental-test-coverage`、无阈值门禁）。
- **建议改法**：不做全仓补测（成本高），改为：
  ① 给两个零测试的包各补一个最小守卫（echo 的 `provides` 契约——正好配合 F3；editor-plain 的注册/卸载）；
  ② 在 CI 增加**覆盖率报告**（不设阈值，先可见），阈值只对未来新增代码生效。
- **验证方式**：`node --import tsx --test packages/plugin-echo/test/*.test.ts` 可跑；
  CI 输出里能看到覆盖率数字。
- **风险与兼容性**：无。
- **状态**：`未处理`。

### F17 · `docs/development.md` §2 的迁移目录落点写的是**不存在的路径**

- **严重度**：**P2**（本台账**新增**条目，不在原清单里）
- **违背**：「事实真源」纪律——文档给出不可用路径。
- **现状事实**：`docs/development.md` §2（数据库与迁移约定）写的 SQLite 落点是
  `packages/db-sqlite/migrations`——**该目录不存在**；真实落点是
  `packages/db-sqlite/src/migrations/`（17 个 .sql），与 `packages/db-postgres/migrations/`（16 个 .sql）成对。
  正确的落点在 `docs/README.md`「事实的真源」表里是对的（`packages/db-sqlite/src/migrations/`）——
  **同一事实两处口径不一致**。
  插件侧唯一显式双目录样本：`packages/plugin-ai-journal/migrations` + `packages/plugin-ai-journal/migrations-postgres`。
- **建议改法**：把 §2 的落点改成 `packages/db-sqlite/src/migrations/`（**本轮不改**，因该文件由任务三第 3 条
  限定只动 §4.6/§4.7；留给下一次 §2 维护时一并处理）。
- **验证方式**：`test -d packages/db-sqlite/migrations` ⇒ 应为真；
  或 `grep -n 'db-sqlite/migrations' docs/development.md` 无命中。
- **风险与兼容性**：无（纯文档）。
- **状态**：`未处理`（**待确认**：是否授权本代理顺手改这一行）。

### F18 · `docs/development.md` §1 的端口分段表已被实际脚本突破

- **严重度**：**P2**（本台账**新增**条目）
- **违背**：纪律第 5 条（写死区间会腐化）。
- **现状事实**：§1 记录的分段为「41xxx PG 验证 / 42xxx P1.5 / 43xxx P2 / 45xxx 合并验证 /
  46xxx M5 合并 / 47xxx P3a / 48xxx M5 前端 / 50xxx P3bcd」，
  但各 e2e 脚本 `PORT="${PORT:-…}"` 的**实际默认值**已经用到 3xxxx 与 5xxxx：
  39311（auth/p1）、42911+42912（oidc 假 IdP + 宿主）、43111（authz p2）、43201（org）、
  47111（wiki p3a）、47112（attachments）、47121（version-meta）、53501（authz p4）、
  55432（PG 测试容器 `geewiki-pg-test`，`postgres:15-alpine`，127.0.0.1）。
- **建议改法**：把「分段表」降级为**建议**，并规定「端口以各脚本 `PORT:-` 默认值为准，新增脚本先 `grep`
  避让」——`docs/agent/conventions.md` 已按此写法落地。
- **验证方式**：`grep -rhoE 'PORT="\$\{PORT:-[0-9]+\}"' packages/*/test/*.sh | sort -n | uniq` 无重复端口。
- **风险与兼容性**：无。
- **状态**：`本轮已在 conventions 层规避`，`docs/development.md` §1 本体未改。

### F19 · 「真实浏览器交互从未验证」与 architecture 的实跑记录**并存**

- **严重度**：**P2**（本台账**新增**条目）
- **违背**：纪律第 4 条（不要让正确与错误口径在同一体系内并存）。
- **现状事实**：`docs/development.md` §4.6 与 §4.8 都写着「真实浏览器交互**从未验证**」，
  但 `docs/architecture.md` 记录了多次真实 Chromium 的 CDP 验收实跑与断言数
  （例如 `scripts/acceptance/ui-extension-cdp.mjs` **28/28 全绿**、P4–P12 端到端 **36/36 全绿**、
  `scripts/acceptance/ai-split-e2e/cdp-ui.mjs` **19/19**）。
  两者其实不矛盾（前者的意思是「**这些验证不进 CI、不会自动跑**」），但**字面读起来互相打脸**。
- **建议改法**：把 §4.6/§4.8 的措辞收缩为准确表述：「**CDP 验收不进 CI、不在 `pnpm test` 内 ⇒
  任何前端交互结论默认未经门禁验证，必须在结论处标注**」，而不是「从未验证」。
  **本轮只做任务书指定的改动**（§4.6 保留原句 + 增加脚本位置指向），措辞收缩留给下一轮确认。
- **验证方式**：`grep -n '从未验证' docs/development.md` 的上下文应已限定为「门禁/CI 未覆盖」。
- **风险与兼容性**：低；但这是**口径收紧**，会改变读者对既有验收记录的解读 ⇒ 建议维护者确认。
- **状态**：`未处理`（**待确认**措辞收紧）。

---

### F27 · `main` 分支保护有后门：admin 的 `bypass_mode: always`

- **严重度**：**P1**（需要特定触发条件——由仓库管理员直接 `git push`——才出问题）
- **违背**：「安全可控」的治理侧：门禁若可被最高权限者无声绕过，四条必需检查实际只是**对非管理员生效**。
- **现状事实**（仓库文档 + GitHub 实况**两边都核**）：
  - 仓库侧：`docs/ci-cd.md` §7「main 分支保护（已启用）」记录 ruleset `main-protection`
    （target: branch、enforcement: active）含四条规则 `deletion` / `non_fast_forward` /
    `pull_request`（**批准人数 0**）/ `required_status_checks`（必需检查 `lint`、`typecheck`、`test`、`build`），
    并明写：「**管理员豁免**：ruleset 的 bypass 列表里放了 `RepositoryRole` = admin，`bypass_mode: always`，
    因此仓库管理员仍可直接推 `main`（API 返回的 `current_user_can_bypass` 为 `always`）」，
    给出的理由是「不改变本仓库既有的直推习惯」。
  - 实况侧（本轮只读 API 复核，未做任何写入）：
    `gh api /repos/GEELINX-LTD/geewiki/rulesets` ⇒ `[{"bypass":null,"enforcement":"active","name":"main-protection"}]`；
    `gh api /repos/GEELINX-LTD/geewiki/rulesets/23638645 --jq '{name,enforcement,bypass_actors,_current:.current_user_can_bypass}'`
    ⇒ `{"bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],"_current":"always","enforcement":"active","name":"main-protection"}`
    ⇒ ruleset id **`23638645`**，`bypass_actors` 与 `current_user_can_bypass` 与 `docs/ci-cd.md` §7 的记载一致
    （API 只回 `actor_id: 5` 这个数字，角色名以 `docs/ci-cd.md` 的「admin」记载为准）。
  - 叠加效应：`pull_request` 规则的**批准人数是 0** ⇒「管理员直推 + 无需批准 + 可 bypass checks」
    三者合起来 = `main` 可在**零评审、零门禁**下被改写（仅 `deletion` / `non_fast_forward` 仍然拦得住）。
- **影响**：本仓库 CI 是**唯一**门禁层（无 commitlint / 无 git hook / 无覆盖率门禁，见 F12），一旦绕过，
  `docs/ci-cd.md` 承诺的「合入必须过 lint / typecheck / test / build」对管理员不成立；且这条豁免是
  长期 `always` 而非 `pull_request` 式临时豁免，**事后无留痕**。
- **建议改法（最小改动优先）**：
  1. 收窄 bypass（二选一）：`bypass_actors: []`（最严），或把 `bypass_mode` 由 `always` 改 `pull_request`
     并把 `actor_type` 限定到专门的 release 角色——即「只在通过 PR 合入时豁免 checks，直推仍然被拦」；
  2. 若必须保留直推能力：至少把 `pull_request.required_approving_review_count` 从 `0` 提到 `1`，
     让「零评审直推」与「有评审合入」可区分；
  3. 无论选哪个，同步改 `docs/ci-cd.md` §7 的口径：现文把它写成**设计**，应写成
     **已知后门 + 收敛计划**（否则文档替后门背书）。
- **验证方式**：`gh api /repos/GEELINX-LTD/geewiki/rulesets/23638645 --jq '.bypass_actors'` 应读回 `[]`
  或 `bypass_mode != "always"`；再以管理员身份推一个未过 checks 的提交到 `main`，应被拒绝。
- **风险与兼容性**：会**结束既有的直推习惯**（文档明写这是当初放开的唯一理由）；紧急回滚需改走
  `revert` PR 或临时开 bypass。属 GitHub 端仓库设置变更，**不在本仓库代码/文档范围内**，
  本轮**不擅自**调用 `gh api -X PATCH`。
- **状态**：`未处理`（**需 GitHub 端操作，本仓库改不到**；本轮只把事实、复核命令与两种最小改法写清）。

### F28 · 脚手架与两个官方示例自己谎报 `provides`（F3 的作者侧传播渠道）

- **严重度**：**P1**（它本身不是安全失守，但它是 F3（P0）的**教学级传播渠道**：
  新插件几乎全部从脚手架或示例起步，照抄即静默失效）
- **违背**：「万物皆插件」的可信度——示例与脚手架是平台的事实文档，它们示范了「清单可以说谎」。
- **现状事实**（`provide` 的每一处命中逐个核对，命令见「验证方式」）：
  - 脚手架：`packages/manager/src/scaffold.ts` 的 `manifestJson()` 固定生成
    ``provides: `${spec.name}-service` ``（它上一行注释还专门解释「依赖图的 token 不是 cordis 服务名：
    `http-service` 是 `@geewiki/http` 的 provides 值」），而模板生成的 `apply(ctx, config)` 只做
    `ctx.get('http')` + `router.register('GET', '/api/<name>', …)` + 返回 `unregister`——
    **没有 `ctx.provide`**；该文件里 `provide` 的唯一命中是给 `RouterLike` 的那句注释
    （「`@geewiki/http` 经 `ctx.provide('http', …)` 提供」）。
  - `plugins/hello-geewiki/package.json`：`"provides": "hello-service"` + `"requires": ["http-service"]`；
    该插件**没有 `src/` 目录**，入口是 `plugins/hello-geewiki/index.ts`，其中 `provide` 的唯一命中也是注释。
  - `plugins/ui-demo/package.json`：`"provides": "ui-demo-service"`；`plugins/ui-demo/src/index.ts`
    同样只有注释命中（`registerSlot("app-header"/"app-footer")` 只出现在前端产物
    `plugins/ui-demo/dist/client.js` 里，与 `provides` 无关）。
  - 为什么是「谎报」而非「多余声明」：依赖解析按 `packages/manager/src/deps.ts` 的
    `const providers = registry.filter((p) => p.manifest.geewiki.provides === dep)` 判等——
    **`provides` 只参与依赖图匹配，不创建任何 cordis 服务** ⇒ 声明了 `x-service` 而
    `ctx.get('x-service')` 仍是 `undefined`。
  - **正对照**（同一仓库里已有正确做法）：`packages/plugin-echo/src/index.ts` 注释写明
    「这里**刻意不声明 `provides`**（曾写 `provides: 'echo-service'`，已撤销）」、
    「本插件从未 `ctx.provide('echo-service', …)`，所以那是一个**谎报的 token**」、
    「将来若确需对外提供能力：按 @geewiki/search 的范式补 `ctx.provide(...)` + dispose 注销 +
    导出服务契约类型，再恢复 provides」——**同一个坑内置示例插件已经踩过并写死了教训，
    但脚手架和 `plugins/` 下两个示例仍留在坑里。**
- **影响**：任何照 `pnpm run new:plugin` 产物或照 `plugins/ui-demo` 抄的作者都会得到
  「清单声称提供 `x-service`、实际没人提供」的插件；第三方若 `requires: ["x-service"]`，
  依赖图判定其已满足、`ctx.get` 拿到 `undefined` ⇒ 静默 no-op（F3 正是这条链路的 P0 版本）。
  同时它把「清单是契约」悄悄削弱成「清单是愿望」。
- **建议改法（最小改动优先）**：三处各删一行 `provides`（`scaffold.ts` 的 `manifestJson()`、
  `plugins/hello-geewiki/package.json`、`plugins/ui-demo/package.json`）——两个示例都只消费 `http`，
  没有对外提供服务的需求，**删比补更诚实**（补 `ctx.provide` 必须按 `@geewiki/echo` 注释里那三件事
  做齐：`ctx.provide` + dispose 注销 + 导出契约类型，才有资格声明 `provides`）。
  若确要保留，脚手架模板就必须真的示范 `ctx.provide(…)` + 卸载注销，否则注释教的是
  「不 provide 也能声明」。
- **验证方式**：改前 `grep -n 'ctx\.provide' packages/manager/src/scaffold.ts plugins/hello-geewiki/index.ts plugins/ui-demo/src/index.ts`
  应只剩注释命中；改后 `grep -rn '"provides"' plugins/*/package.json packages/manager/src/scaffold.ts`
  的每个命中都必须能在同插件源码里找到对应的真实 `ctx.provide(`。回归：`pnpm --filter @geewiki/manager test`。
- **风险与兼容性**：删 `provides` 会让任何以 `requires: ["hello-service"]` / `["ui-demo-service"]`
  声明依赖的外部插件在装载时报「依赖找不到」——这是**把静默失效变成显式失败**，方向正确但属行为变更；
  `plugins/*` 是对外示例，改清单要同步 `docs/plugin/api-reference.md` 的对照表
  （该行现已把「`provides: 'ui-demo-service'` 但代码里没有 `ctx.provide`」标注为反模式 AP-08，
  `docs/plugin/anti-patterns.md` 亦已点名）。
- **状态**：`未处理`（**待授权**：涉及 `packages/manager/src/scaffold.ts` 与两个 `package.json`）。
  **交叉引用 F3**（同一机制的权威描述与 P0 定级理由；本条只记「示例与脚手架在传播它」）。

---

## P2

### F20 · 外部插件的 JSON 清单无法承载 schemastery `configSchema`

- **严重度**：**P2**
- **违背**：「高可扩展」的开发者体验（外部插件作者的第一道坑）。
- **现状事实**：
  - `packages/core/src/index.ts` 的 `GeeWikiManifest['geewiki']` 有 `configSchema?: ConfigSchema`，
    且**必须是 schemastery 实例**（如 `Schema.object({…})`）；该字段注释自认：
    「若插件给的是普通对象（旧式 JSON Schema 字面量），管理器视为『无 schema』，
    仅提供 JSON 原文编辑、不做校验，并打印一次告警」。
  - 告警点：`packages/manager/src/index.ts` 的 `configSchemaOf(entry)`
    （`[manager] 插件 ${name} 的 configSchema 不是 schemastery Schema（旧式 JSON Schema 字面量？）`）；
    无 schema 时 `updateConfig()` 只校验「必须是 JSON 对象」
    （`throw new ManagerError('invalid_config', \`${name} 未声明 configSchema，配置必须是 JSON 对象\`)`）；
    快照字段 `configurable: this.configSchemaOf(entry) !== undefined` 决定管理台渲染表单还是 JSON 框。
  - 外部插件清单解析在 `packages/manager/src/discovery.ts` 的 `parsePluginManifest(pkg, standalone)`：
    清单来源二选一（`package.json` 顶层 `geewiki` 键优先 / 独立 `geewiki.manifest.json`），
    二者都是**纯 JSON ⇒ 无法承载 schemastery 实例**（实例是运行时对象）。
  - 注意：`configSchemaOf()` **优先**取 cordis 模块上的 `module.Config`——
    即外部插件若用 `.ts`/`.js` 入口（候选见 `ENTRY_CANDIDATES = ['index.ts', 'index.js', 'src/index.ts']`）
    **在代码里声明 `Config`**，就仍有校验。**只有「只给 JSON 清单、代码里没有 Config」这条路会退化成零校验。**
- **影响**：以「纯 JSON 清单」方式发布的外部插件，配置校验能力弱于内置插件，
  且差异只在一次启动告警里体现。
- **建议改法（最小改动优先）**：
  1. **文档**：在插件作者文档里把「`Config` 必须写在入口模块里（JSON 清单里的 `configSchema` 只用于展示）」
     写成显式契约（本轮已在 `docs/agent/conventions.md` 落一条提示；正式契约位建议 `docs/plugin-platform.md`）；
  2. **代码（后续）**：支持一个受限的声明子集（type/enum/required/default/role:'secret'）在 JSON 清单里
     由管理器**编译成** schemastery 实例，兼顾「零构建分发」与校验能力。
- **验证方式**：夹具插件只给 JSON `configSchema` ⇒ 启动日志出现该告警 + `GET /api/plugins/:name/config`
  的 `configurable` 为 `false`；补子集编译后同一夹具应变成 `true` 且非法值被拒。
- **风险与兼容性**：子集编译器要防止「看起来像 JSON Schema、语义却不同」的静默误解析 ⇒
  未知关键字必须**显式报错**而不是忽略。
- **状态**：`未处理`（现状有告警，非纯静默）。

### F21 · 包 `exports` 直指 `src/index.ts`，与「将来 npm 发布」不兼容

- **严重度**：**P2**
- **违背**：「可复用」（外部消费者需要构建产物，而不是源码）。
- **现状事实**：**全部 27 个可发布包**的 `exports` 都指向 `./src/index.ts`（运行期由 tsx 直跑 TS；
  `@geewiki/web` 无 `exports`）；全部包 `type: module`；根 `package.json` `private: true`、
  `packageManager: pnpm@11.7.0`、`engines.node >=22`。
- **影响**：任何想 `npm i @geewiki/core` 的第三方消费者会拿到 .ts 源码，需要自备 tsx/编译；
  类型与运行时代码没有构建产物边界。
- **建议改法**：**先做决定并写下来**（这是最省事的修法）：
  A. 明确「本仓库只随 monorepo 使用，包永不单独发布」⇒ 在 `docs/architecture.md` 与 `CONTRIBUTING.md`
     写明，并把 `exports: ./src/index.ts` 标注为有意的极简取舍；
  B. 若打算发布 ⇒ 增加构建步骤（tsup/tsc 出 `dist/` + `types`），`exports` 用 `development`/`import`
     条件区分源码态与发布态。
- **验证方式**：A 路径 ⇒ 文档有明确声明；B 路径 ⇒ `pnpm build` 产出 `dist/` 且
  `node -e "import('@geewiki/core')"` 在不带 tsx 的干净目录里可成功。
- **风险与兼容性**：B 是较大的工程改动（28 个包 + CI build + Docker 镜像路径），不要顺手做。
- **状态**：`未处理`（**需产品/架构决策**）。

### F22 · 无宿主版本协商；SDK 兼容只靠 `HOST_SDK_VERSION` 特性探测

- **严重度**：**P2**
- **违背**：「高可扩展」的长期演进面。
- **现状事实**：`grep -rn "minHostVersion\|hostVersion\|engines" packages/core/src/index.ts packages/core/src/domain.ts`
  ⇒ **无命中**（manifest 没有最低宿主版本声明字段，也没有协商）。
  前端只有 `packages/web/src/lib/hostSdk.ts` 的 `export const HOST_SDK_VERSION = '0.12.0'`
  （挂在 SDK 对象的 `version` 字段上），由插件自行做特性探测；
  守卫测试 `packages/web/test/hostSdkSurface.test.ts` 用正则
  `/export const HOST_SDK_VERSION = '(\d+)\.(\d+)\.(\d+)'/` 解析该常量。
- **影响**：新版宿主删改 SDK 方法 ⇒ 老插件**运行期 TypeError**，启动阶段没有任何拦截或提示。
- **建议改法（最小改动优先）**：先做**可见性**——`GET /api/plugins` 快照与管理台里展示每个外部插件声明的
  兼容范围（哪怕字段暂时缺省），并在 manifest 增加 `minHostVersion?: string`（**只告警不阻断**，
  与 F1/F3 的「非阻断告警」取向一致）；后端 SDK 侧对应地把 `@geewiki/core` 的导出面做一层
  导出面快照守卫测试（对齐 `hostSdkSurface.test.ts` 的做法）。
- **验证方式**：夹具插件声明 `minHostVersion: '99.0.0'` ⇒ 启动日志/管理台出现不兼容告警；
  `HOST_SDK_VERSION` 变更时守卫测试必须要求显式确认。
- **风险与兼容性**：新增 manifest 字段 ⇒ 老插件不带该字段按「未知 ⇒ 不告警」处理，避免噪声；
  **未知字段不得拒绝清单**（对齐现有「未知权限只告警」的宽松取向）。
- **状态**：`未处理`。

### F23 · 热更新边界散落在多篇文档，没有单一成文小节

- **严重度**：**P2**（对原清单 ⑰ 的**修正表述**：内容其实**有**写，问题是**分散**）
- **违背**：文档可用性（结论集中原则）。
- **现状事实**：相关表述分散在三处——
  `docs/architecture.md`（「默认不支持热加载：热操作仅对显式声明者开放——插件须在 manifest 中设置
  `runtime.supportsHotReload: true`」）、`README.md`（「`supportsHotReload: false` 的插件（两个数据库插件）
  连启用也是冷的」）、`docs/plugin-platform.md`（「**ESM 模块实例永不回收** ⇒ 后端插件改码**必须重启进程**；
  前端插件产物更新**必须整页刷新**」，并把 `packages/web/src/lib/pluginUi.ts` 的
  「已知边界（决策，不是待办）」引为依据）。
- **建议改法**：在 `docs/plugin-platform.md` 增设一节「热操作能力矩阵」（列：manifest 声明 /
  启停是否热 / 改码是否热 / 前端产物是否需整页刷新），其它三处改为链接该节（挂纪律第 6 条）。
  **建议由正在写 `docs/plugin/` 的 agent 或下一轮统一收敛**，本代理不重复建表以免制造第二个真源。
- **验证方式**：`grep -rn "必须重启进程\|整页刷新" README.md docs/*.md` ⇒ 除能力矩阵那一节外均为链接。
- **风险与兼容性**：无（纯文档）。
- **状态**：`未处理`。

### F24 · 部分命令与扩展点缺参数级说明

- **严重度**：**P2**（对原清单 ⑱ 的**精确化**：三个对象情况不同）
- **违背**：「高可扩展」的作者体验。
- **现状事实**：
  - `pnpm run install-plugin`（= `tsx scripts/install-plugin.ts`）：根 README「常用命令」表里只有一行名字，
    **无参数说明**；真正的用法（`<目录 | .tgz | https URL>` + `--verify`）散在 `docs/plugin-platform.md` 里。
  - `pnpm run clean:tmp`（= `tsx scripts/clean-tmp.ts`）：README 一行，**无参数/行为说明**。
  - `slot.define()`（自定义扩展点）：README 有一句「名字必须至少含一段 `/`」，
    但 **`grep -rn "slot.define" docs/*.md` ⇒ 无命中**；声明表只在源码注释里
    （`packages/manager/src/slots.ts` 的 `slot.define()` 注释、`packages/core/src/slots.ts` 的自定义扩展点声明）。
- **建议改法**：`docs/plugin-platform.md`（或 `docs/plugin/`）加一节「自定义扩展点：`slot.define()` 的名字规则、
  基数、冲突与卸载行为」；README 的常用命令表给 `install-plugin` / `clean:tmp` 各补一行最小用法
  （或统一指向插件作者文档）。
- **验证方式**：`grep -rn "slot.define" docs/` 有命中；`pnpm run install-plugin`（无参）的报错文案
  自带 usage 行（若脚本没有 usage 提示，属代码改动，登记不改）。
- **风险与兼容性**：无。
- **状态**：`未处理`。

### F25 · `docs/plugin-platform.md` 的「当前限制与风险」表与本台账职责重叠

- **严重度**：**P2**（本台账**新增**条目，属于「避免台账变腐化源」的收尾事项）
- **违背**：「事实只有一个真源」。
- **现状事实**：`docs/plugin-platform.md` 已有一张「当前限制与风险」表，用「中/低」分级记录了
  路由默认 public、插件无隔离、`config/secrets.json` 明文（0600）、ESM 永不回收、`provide` 时序陷阱等
  ——与 F1 / F2 / F7 / F22 / F23 **话题重合**。
- **建议改法**：确定分工——**plugin-platform 记「设计边界与有意不做」，本台账只记「未修的整改项 + 最小改法 +
  验证方式」**，并在两处互相加一行链接（本台账已在此条声明；plugin-platform 侧的指向行本轮已加）。
  条目修好后：plugin-platform 保留结论，本台账删除条目。
- **验证方式**：两处不再有同一条目的**重复整改建议**（只保留一处）。
- **风险与兼容性**：无。
- **状态**：`本轮已加指向行`。

### F29 · 「插件编辑器不能上传附件」的过期表述仍有四处（F5 落地后未回收）

- **严重度**：**P2**（纯注释/文档与代码不符，不改行为，但会误导下一个改附件链路的人）
- **违背**：「事实真源」纪律——正确口径已存在于类型与守卫测试，旧口径仍留在注释里。
- **现状事实**：
  - **正确的一侧**（现行行为）：
    - 契约：`packages/web/src/lib/slots.tsx` 的 `export interface EditorSlotProps` 含
      `onUploadFiles?(files: File[]): Promise<string[]>`；`packages/core/src/index.ts` 的镜像声明同名同签名；
      `packages/core/src/slots.ts` 的 `SLOT_PROPS_SCHEMA.editor` 带
      `contract: { interface: 'EditorSlotProps', file: 'packages/core/src/index.ts' }`，其 `props`
      里就有 `onUploadFiles`，描述原文：「★ F5：附件上传。缺省 = 宿主**不支持**该编辑器上传
      （宿主会同时关掉它自己的拖放/粘贴拦截），不是"传了也白传"」。
    - 宿主接线：`packages/web/src/pages/WikiPage.tsx` 的 `uploadFiles`（`useCallback`）
      **同一个函数**同时传给 `EditorSlotOutlet`（`onUploadFiles={uploadFiles}`）与内置
      `MarkdownEditorLazy` ⇒ 插件编辑器与内置编辑器走**同一条**上传通道。
    - 兜底语义：`packages/web/src/lib/slots.tsx` 的 `EditorSlotOutlet` 以
      `const uploadSupported = props.onUploadFiles !== undefined` 决定
      `onDragOver` / `onDrop` / `onPaste` 是放行还是 `event.preventDefault()`，后者同时显示
      `EDITOR_SLOT_NO_UPLOAD_HINT`（**必须拦**：不拦则浏览器导航到被拖入的文件，连未保存正文一起丢）。
      守卫：`packages/web/test/attachmentUploadPlan.test.ts` 同时钉住 `onUploadFiles={uploadFiles}`
      与 `uploadSupported` 判据。
  - **过期的一侧**（四处）：
    1. `packages/server/src/index.ts` 的 `@geewiki/editor-plain` 注册注释：仍写「**内置编辑器是唯一
       支持附件拖拽/粘贴上传的编辑器**」「`editor` 插槽的契约 `EditorSlotProps`…**不含任何上传字段**」
       「在补上上传能力（契约加字段 + 两端镜像 + 守卫测试）之前不得默认占用 `editor`」——
       它给的**理由**已假：加字段 / 两端镜像 / 守卫测试这三件事**都已做完**。
    2. `packages/web/src/lib/slots.tsx` 里 `EditorSlotOutlet` 自己的 docblock：写「{@link EditorSlotProps}
       里**没有**上传通道：`value`/`mode`/`slug`/`readOnly`/`onChange`/`onSave`/`onCancel` 七个字段」
       「那需要把上传通道加进 `EditorSlotProps`…属于契约演进，不在本次修复范围」——
       与同文件下方的 `uploadSupported` 实现**自相矛盾**（本台账**新增**，原清单未列此处）。
    3. `docs/design/attachments.md` §10 的「仍未做（真实待办）」行仍列「**降级 textarea、
       插件编辑器插槽不支持上传**（U15 的一部分）」⇒ **本轮直接改这一处**。
    4. 行为侧残留（**不是文案问题，故不并入本轮改法**）：`packages/web/fixtures/editor/index.tsx`
       （`@geewiki/editor-plain` 的前端产物源）自带一份局部 `interface EditorSlotProps`，只声明
       `value`/`mode`/`slug`/`readOnly`/`onChange`/`onSave`/`onCancel` 七个字段，`PlainTextEditor`
       也只解构这七个，且没有 drop/paste 上传 ⇒ 这个示例编辑器**确实**不消费 `onUploadFiles`。
       所以「出厂配置下内置编辑器是唯一真能上传的」这个**结论仍成立**，只是原因从
       「契约不支持」变成「这个实现没接」。
- **影响**：读注释的人会以为「要支持插件编辑器上传得先做契约演进」⇒ 重复已完成的劳动，
  或继续以错误理由禁用 `editor` 默认占用；读 `attachments.md` 的人会把它继续登记成真实待办。
- **建议改法（最小改动优先，**只改文字、不改行为**）**：
  1. `packages/server/src/index.ts` 的 editor-plain 注释：把「唯一支持上传 / 契约不含上传字段」改为
    「契约已有 `onUploadFiles`（见 `SLOT_PROPS_SCHEMA.editor`）；本编辑器的 UI 产物
    （`packages/web/fixtures/editor/index.tsx`）尚未消费该通道 ⇒ 默认不占用 `editor` 的理由是
    **实现未接**，不是**契约不支持**」。**（改 `.ts` 注释 ⇒ 待授权）**
  2. `packages/web/src/lib/slots.tsx` 的 `EditorSlotOutlet` docblock 同向改写。
    **（改 `.tsx` 注释 ⇒ 待授权）**
  3. `docs/design/attachments.md` 的「仍未做」行：把「插件编辑器插槽不支持上传」改为
    「契约已含 `onUploadFiles`；剩余待办 = 内置/示例编辑器实现尚未消费该通道」。**（本轮已改）**
  4. （另案，不属本条）给 `packages/web/fixtures/editor/index.tsx` 真的接上 `onUploadFiles`——
    那是**行为**改动。
- **验证方式**：`grep -n '不含任何上传字段\|没有上传通道' packages/server/src/index.ts packages/web/src/lib/slots.tsx`
  与 `grep -n '插槽不支持上传' docs/design/attachments.md` 改后应无命中；行为回归
  `pnpm --filter @geewiki/web test`（`attachmentUploadPlan.test.ts`、`editorSlotProps.test.ts` 应继续全绿）。
- **风险与兼容性**：零（纯注释/文档）。**唯一陷阱**：不要把 1/2 两处的结论整段删掉——
  「默认不启用 `@geewiki/editor-plain`」这个决定仍然有效，变的只是理由。
- **状态**：`部分已缓解`——第 3 处本轮已改（文档）；第 1、2 处涉及 `.ts`/`.tsx` 注释，**待授权**；
  第 4 处是行为，另案。交叉引用 **F5**（`geewiki.slots` 与 bundle 不一致）与
  `docs/plugin/anti-patterns.md`（该文档已按真相写法标注「注释待修」）。

### F30 · `GEEWIKI_KEEP_TMP` 有码无表（验收脚本专用开关，两处真源表都没有）

- **严重度**：**P2**
- **违背**：「事实真源」纪律（有码无表）。
- **现状事实**：本轮全量枚举 `GEEWIKI_*` 并在补齐 F6 那 4 个变量之后，**唯一**仍「代码有读、
  README / `docs/deployment.md` 两处真源表都没有」的是
  `scripts/acceptance/search-mode/run.ts` 的 `if (process.env['GEEWIKI_KEEP_TMP'] === '1')`（唯一消费者）。
  另有刻意分层的前缀 `GEEWIKI_TEST_*` / `GEEWIKI_LLM_*` / `GEEWIKI_E2E_*`（测试与联调专用），
  不进部署表属正常，不算本条范围。
- **影响**：想「保留验收临时目录」的人只能靠读脚本源码发现这个开关；而只读表格的读者会把表当穷举
  （表相邻处本轮已加「非穷举 + 指向本台账」的说明行）。
- **建议改法**：在 `docs/development.md` §4.6「验收脚本在哪」段末补一行
  「`GEEWIKI_KEEP_TMP=1` 让 `scripts/acceptance/search-mode/run.ts` 保留临时目录（仅验收用，
  故不进部署表）」，而**不是**把它塞进 README / deployment 的部署变量表（语义层不同）。
- **验证方式**：`grep -n 'GEEWIKI_KEEP_TMP' docs/development.md` 有命中。
- **风险与兼容性**：无（纯文档）。
- **状态**：`未处理`（本轮未动 §4.6 该段以免与任务四的改动挤在同一处；一行即可落地）。

---

## 未能复现

### F26 · `GEEWIKI_TRUST_PROXY` / 健康检查恒 fail —— **未能复现**（原清单 ⑩）

原清单称：「`docker-compose.yml` 健康检查读 `GEEWIKI_TRUST_PROXY=/tmp/loopback_ca.crt`，但全仓找不到该变量的消费者」。

核实结果（截至 `64ff6fa`，2026-09-28）：**前提不成立**。

```
rg -n --hidden -g '!**/node_modules/**' -g '!.git/**' -g '!**/dist/**' 'TRUST_PROXY'   → exit 1（零命中）
rg -n 'loopback_ca|trustProxy|trust_proxy'                                             → 零命中
git log --all -S'TRUST_PROXY'                                                          → 无任何提交
```

另外：`docker-compose.yml` 中**没有**该变量，健康检查沿用 `Dockerfile` 的 `HEALTHCHECK`
（直连 `http://127.0.0.1:${GEEWIKI_PORT}/api/health`，要求 `j.ok === true && j.db && j.db.present === true`）。

**结论**：不存在「有文档无码 / 残留变量 / 健康检查恒 fail」的问题，**无需整改、也不要把它补进任何环境变量表**。

**留一手（如果线上真的观察到容器 unhealthy）**，按下面顺序验证，而不是去找 `GEEWIKI_TRUST_PROXY`：

```bash
docker compose ps                                    # healthy / unhealthy / restarting
docker compose logs --tail=200 <service>             # 先看是否有 F4 的「REST API 未挂载」
docker inspect --format '{{json .State.Health}}' <container> | head -c 2000   # 取最后一次探测输出
docker exec <container> node -e "fetch('http://127.0.0.1:'+(process.env.GEEWIKI_PORT||3000)+'/api/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"
# 期望 {"ok":true,"db":{"present":true,…}}；db.present=false ⇒ 迁移未落（见 docs/development.md §1 的轮询配方）
```

- **状态**：`未能复现`（若上述运行时验证真的复现 unhealthy，请把结论按 F4 或新开条目登记）。

---

## 汇总

| 编号 | 一句话 | 严重度 | 违背理念 | 状态 |
| --- | --- | --- | --- | --- |
| F1 | 路由 `access` 省略即 `public`（fail-open 默认） | **P0** | 安全可控 | 部分已缓解 |
| F2 | 插件权限纯声明、宿主不强制（无沙箱/无配额） | **P0** | 安全可控 | 未处理 |
| F3 | `provides` 只是依赖图 token，谎报后功能静默失效 | **P0** | 安全可控 / 可预期 | 未处理 |
| F4 | 空 config 挂载 ⇒ 空清单 ⇒ 不监听 ⇒ 退出码 0 重启循环 | **P0** | 安全可控 / 可运维 | 未处理（文档已写明） |
| F5 | `geewiki.slots` 与 bundle `registerSlot` 不一致 ⇒ 静默空白 | P1 | 高可扩展 | 未处理 |
| F6 | 4 个安全/运维环境变量此前查无文档 | P1 | 安全可控 | 本轮已修（文档） |
| F7 | `GEEWIKI_OPENAI_DEBUG` 默认开启诊断日志 | P1 | 安全可控 | 未处理 |
| F8 | 出厂模板写死私有端点与私有模型名 | P1 | 不绑厂商 | 未处理 |
| F9 | `description` 仍写「Phase 0 骨架」、`0.1.0`、无根 CHANGELOG | P1 | 对外一致性 | 未处理 |
| F10 | `docs/README.md` 文档地图漏登 4 篇 | P1 | 事实真源纪律 | 本轮已修（文档） |
| F11 | 写死读数腐化（CI 注释 177、§4.7 基线） | P1 | 事实真源纪律 | 本轮已修（文档） |
| F12 | 无 CONTRIBUTING / commitlint / hooks / formatter / 覆盖率门禁 | P1 | 规范可机器执行 | 本轮处理 |
| F13 | 此前无任何面向 agent 的文档入口 | P1 | 规范可机器执行 | 本轮处理 |
| F14 | plugin-platform 以「路径:行号」引用代码 30 处 | P2 | 事实真源纪律 | 本轮已修（文档） |
| F15 | 8 个 e2e shell 与 CDP 界面验收完全不在 CI | P2 | 规范可机器执行 | 未处理 |
| F16 | 覆盖不均：2 个包零测试、多包仅 1 个测试文件 | P2 | 规范可机器执行 | 未处理 |
| F17 | development.md §2 迁移落点写的是不存在的路径 | P2 | 事实真源纪律 | 未处理（**待确认**） |
| F18 | development.md §1 端口分段表已被实际脚本突破 | P2 | 事实真源纪律 | conventions 层已规避 |
| F19 | 「真实浏览器交互从未验证」与 architecture 实跑记录并存 | P2 | 事实真源纪律 | 未处理（**待确认**） |
| F20 | JSON 清单无法承载 `configSchema` ⇒ 配置退化零校验 | P2 | 高可扩展 | 未处理（有告警） |
| F21 | 包 `exports` 直指 `src/index.ts`，与 npm 发布不兼容 | P2 | 可复用 | 未处理（**需决策**） |
| F22 | 无宿主版本协商，SDK 兼容只靠 `HOST_SDK_VERSION` 探测 | P2 | 高可扩展 | 未处理 |
| F23 | 热更新边界散落三篇文档，无单一能力矩阵 | P2 | 文档可用性 | 未处理 |
| F24 | `install-plugin` / `clean:tmp` / `slot.define()` 参数级说明缺位 | P2 | 高可扩展 | 未处理 |
| F25 | plugin-platform 风险表与本台账职责重叠 | P2 | 事实真源纪律 | 本轮已加指向行 |
| F26 | `GEEWIKI_TRUST_PROXY` 残留 ⇒ **未能复现** | — | — | 未能复现 |
| F27 | ruleset `main-protection` 给 admin 开 `bypass_mode: always` 后门 | P1 | 安全可控 | 未处理（**需 GitHub 端操作**） |
| F28 | 脚手架 + 两个官方示例自己谎报 `provides`（传播 F3） | P1 | 安全可控 / 可预期 | 未处理（**待授权**） |
| F29 | 「插件编辑器不能上传附件」的四处过期表述（F5 落地后未回收） | P2 | 事实真源纪律 | 部分已缓解（文档 1 处已改） |
| F30 | `GEEWIKI_KEEP_TMP` 有码无表（验收脚本开关） | P2 | 事实真源纪律 | 未处理 |

**分布（不含 F26）**：**P0 4 条 / P1 11 条 / P2 14 条，共 29 条**。
其中本轮新增 4 条：F27 / F28（P1）、F29 / F30（P2）——F27+F28+F29 使分布为 4 / 11 / 13 = 28，
F30 是按「有码无表一并登记」的要求追加的第 4 条（故 P2 到 14）。
其中 `本轮已修（文档）` 4 条（F6 / F10 / F11 / F14）、`本轮处理`（他人，不在本代理范围）2 条（F12 / F13）、
`本轮已加指向行 / conventions 层已规避` 2 条（F25 / F18）、**`未处理` 15 条**、
其中 **3 条需要维护者决策或授权**（F17 是否顺手改文档、F19 措辞是否收紧、F21 发布策略）。
