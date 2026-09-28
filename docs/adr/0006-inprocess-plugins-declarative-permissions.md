# 0006. 插件同进程运行 + 声明式权限（权限是审计语义，不是安全边界）

- 状态：accepted
- 记录日期：2026-09-28
- 说明：本条为**回填**。`geewiki.permissions` 字段、未知取值的告警文案、审计里的权限展示
  都已经写在代码里并有测试钉住（`packages/manager/test/permissions.test.ts`），但「权限表是
  给谁看的」这句话一直没成文——而它恰恰是最容易被误读的一句。落地部分按已提交代码写，
  意图部分是据代码内注释复核。

## 技术背景

GeeWiki 的插件与宿主跑在**同一个 Node 进程**里（ADR-0001、ADR-0009）。一个插件的 `apply()`
拿到的是真的 `Context`、真的 `HttpRouterService`、真的数据库句柄——它想读 `/etc/passwd`
不需要任何"越权"动作，`import('node:fs')` 就行。

这意味着一件不太好听的事：**在这个模型里不存在能挡住插件的机制**。任何"权限校验"都只能
建立在插件自觉之上。那么还要不要权限声明？要，但目的必须定准——不是拦截，而是：

1. **让运维在装之前看得见**。管理台里一个插件写了 `geewiki.permissions: ['fs:write', 'secrets']`，
   这就是"它打算碰文件系统和密钥"的公开承诺；管理员据此决定装不装。
2. **让事后审计有对象**。出事后能回答"这个实例上一共装了哪些声明要 `net` 的插件"。
3. **让拼写错误可见**。这一条在代码注释里被反复强调（`readPluginPermissions` 标 ★ F10）：
   静默接受任意字符串会让 `fs:raed`、`FS:read`、`filesystem` **看起来像"已经声明过了"**，
   于是声明表里堆满永远不会被任何消费方认出的项，而作者以为自己做对了。

## 考虑选项

- **A. 不做权限声明**，只在文档里写"第三方插件请自行审计"。最诚实，但管理台是瞎的：
  运维无法在装之前区分"只读 wiki 的插件"和"要读 secrets 的插件"。
- **B. 进程/容器隔离，权限是真边界**。安全上最正确，代价是 cordis 的同步图解析模型直接作废
  （跨进程不能共享 `Context`）、每个插件一个进程、部署形态从"一个容器"变成"一组容器"，
  与 ADR-0009 的最小部署正面冲突。
- **C. 权限只声明不拦截，未知取值静默收下**。实现最省事。但声明表会腐化成装饰，
  而且腐化的方式是**看不出来的那种**。
- **D. 权限只声明不拦截，未知取值拒绝并告警；把它当管理台展示与审计语义来卖（选中）**。
  承认它不是安全边界，同时把它能提供的价值（可见性、可审计、拼写可见）做实。

## 决策结果

选 D。**权限是管理台展示与审计语义，不是安全边界。** 落地形态（可复核）：

- **权限词表是封闭枚举**：`packages/core/src/domain.ts` 的 `PLUGIN_PERMISSIONS`，
  六项按**危险度升序**排（数组顺序即排序键，不是巧合）：
  `fs:read` → `env` → `net` → `fs:write` → `process` → `secrets`。
  配套 `isPluginPermission()` 做类型守卫，`sortPermissions()` 按同一顺序输出，
  未知取值排在最后。数组内容与顺序被 `packages/manager/test/permissions.test.ts`
  逐字钉住（新增/改名/换序都会红）。
- **读取即校验**：`packages/manager/src/index.ts` 的 `readPluginPermissions()`。
  `geewiki.permissions` 缺失是**合法**的（返回空数组，与写 `[]` 同义——绝大多数插件不需要
  跨界能力，强制每个插件写空数组只会制造噪声）；不是数组 ⇒ 告警并当作没声明；
  数组里的未知取值 ⇒ 逐条 `console.warn` 并**丢弃该项**，文案直接把合法取值列出来。
  注意丢弃的语义：**只是这一项不进声明表，插件照常激活**。
- **展示端消费的就是这份数组**：`packages/manager/src/index.ts` 的 `PluginSnapshot.permissions`
  透出到 `GET /api/plugins`，管理台与日志直接用它（顺序即"从轻到重"）。
- **路由命名空间是宿主独占的**：`packages/core/src/domain.ts` 的 `RESERVED_ROUTE_IDS`
  列出宿主保留的 `/plugins/<id>` 首段；`packages/manager/src/routes.ts` 的 `resolveRouteDecls()`
  在激活前解析并校验冲突。历史上 `/plugins/audit` 属保留清单，后来整页所有权移交给
  `@geewiki/ops`（`packages/plugin-ops/src/index.ts`：它只贡献**前端页面**与其路由 id `audit`，
  不注册任何服务端路由，数据来自 `@geewiki/auth` / `@geewiki/authz` / `@geewiki/org` 已有的端点）。
  移出保留清单时宿主的 `ADMIN_NAV` 条目与页面分派分支**必须一起删**，否则会出现
  "两个东西都声称拥有 `audit`"（`packages/web/src/App.tsx` 里有这条注释）。
- **每个路由自带访问级别**：`packages/server/src/index.ts` 的 `HttpRouter` 以
  `access` 作为分级判据，取值是 `packages/core/src/index.ts` 的 `RouteAccess`，
  **只有三档**：`public` / `user` / `admin`（`admin` 的判据是 `principal.orgRole` 为
  `owner` 或 `admin`，应急通道 `break-glass` 亦可通行）。鉴权在派发时统一做。

## 后果

**正面**

- 运维在装插件前就能看到它的自我声明，且声明是**有词表的**：六项封闭枚举 + 排序，
  比"自由文本备注"可比较、可聚合、可告警。
- 拼写错误变成可见事件而不是静默腐化。这是本条实际收益最大的一项，因为它挡的是
  "看起来正确但其实什么都没声明"这类故障。
- 权限词表封闭 ⇒ 想加一项必须改 `packages/core/src/domain.ts` 并动那条测试，
  天然形成一次评审。
- 与同进程模型零冲突：不引入 IPC、不引入序列化边界，cordis 的同步 `ctx.get()` 照旧。

**负面 / 风险（如实）**

- **权限完全不拦截任何事**——这句话必须写在最前面。没有沙箱、没有进程隔离、没有资源配额、
  没有 syscall/模块级钩子。声明 `[]` 的插件照样能 `import('node:fs')` 读任意文件；
  没声明 `net` 的插件照样能 `fetch()` 出去。权限表**不能**用来向任何人承诺"这个插件
  接触不到你的密钥"。真要边界只能选 B（进程隔离），而那是另一条 ADR。
- **未知权限值只告警不阻断**：拼错的项被丢掉后插件正常激活，运行时行为一点不变。
  结果是"声明写错了"这件事只有去翻 stdout 才知道；管理台上看到的是一个权限比作者本意
  **更少**的插件——这比反向错误（多显示权限）更危险，因为它让人放心。
  可选的收紧：未知取值直接拒绝激活，或把告警透成 `GET /api/plugins` 的 issue 字段。
- **省略 `access` 等价于公开**：`router.register` 的第 4 参可省，省略即 `access: 'public'`
  （匿名可调，见 `packages/core/src/index.ts` 的 `RouteAccessOptions`——`register()` 的可选第 4 参，
  注释原文「省略等价于 `{ access: 'public' }`」）。全仓几十个调用点全靠
  作者自觉。`GEEWIKI_STRICT_ROUTE_ACCESS=1`（`packages/server/src/index.ts` 的
  `STRICT_ROUTE_ACCESS_ENV` 与 `auditRouteAccess()`）只是把这个默认值收紧成
  "不写就拒绝启动"，给"不受信插件 / 合规环境"用；它**不是**审批流程，也不会去判断
  某个端点到底该不该公开。已实测的写法样本：`packages/plugin-llm/src/availability.ts`
  的注释就直说两个 capabilities 端点用的是三参形式 ⇒ 默认 public ⇒ 未登录可读模型清单。
- **词表粒度粗且不可组合**：`fs:read` 不区分"读 attachments 目录"和"读任意路径"，
  `net` 不区分"出站到我配置的 LLM"和"出站到我本机"。它描述的是**类别**，不是范围，
  所以拿它做白名单是没有意义的。
- **没有声明与行为一致性的校验**：没有任何东西检查"声明了 `env` 的插件是不是真的只读了
  它说的那几个变量"。声明与实现的一致性完全靠 review。
- 冲突组的先到先得（`resolveRouteDecls()`）意味着**后激活者静默拿不到路由**，
  插件作者要从日志里发现，而不是从启动失败里发现。

## 重新评估触发条件

- 出现"多租户 + 不可信插件"的需求 ⇒ 权限模型必须重做（只能走进程隔离，选项 B），
  本条改 `superseded`。
- 给权限加上范围（`fs:read:<路径>`）或加了拦截点 ⇒ 需要新 ADR 说明词表语义变更，
  并在本条追加链接。
