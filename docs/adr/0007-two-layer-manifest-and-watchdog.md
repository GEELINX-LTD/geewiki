# 0007. 插件清单分两层（JSON 说「这是什么」/ TS 说「怎么跑」）+ 崩溃看门狗回滚

- 状态：accepted
- 记录日期：2026-09-28
- 关联：ADR-0001（cordis 依赖图）、ADR-0002（运行期直接跑 TS）、ADR-0006（同进程插件与声明式权限）、
  ADR-0009（单进程最小部署，崩溃标记的部署侧后果）；相关专题文档：
  [兼容性口径](../plugin/compatibility.md)、[反模式 AP-19](../plugin/anti-patterns.md)、
  [插件平台总览](../plugin-platform.md)

## 技术背景

一个插件的元信息有两类，性质完全不同：

- **"这是什么"**：名字、版本、要什么权限、占哪些插槽、注册哪些路由、运行时要求（能不能热替换、
  要不要清缓存、排空预算多少）。这些必须在**不执行任何插件代码**的前提下就能读到——管理台要在
  装之前展示权限，装配期要按 `requires`/`conflictGroup` 排序，权限声明（ADR-0006）一旦只有
  跑起来才知道就等于没有。
- **"怎么跑"**：`apply(ctx, config)` 本体、配置 schema、健康探针。这些**天然是代码**——
  GeeWiki 的配置校验用 schemastery（`packages/core/src/index.ts` 的 `ConfigSchema`，
  定义为 `ReturnType<typeof Schema.any<any>>`），一个校验器是一个可调用对象，
  序列化不进 JSON。

如果只有一层，两个方向都堵：只做 JSON 就写不出 `configSchema`，只能退化成"配置不做结构化校验"；
只做 TS 就得**先 import 再决定要不要 import**——读权限要先执行对方的代码，一个只想看看权限的管理台
被第三方模块的顶层副作用绑架。

第二个问题是运行期风险。插件与宿主同进程（ADR-0006），一次装错不是"某个功能坏了"而是
"整个实例起不来 / 反复崩"。而最容易出事的正是**临时试用的那次启用**：管理员刚点了 enable，
进程开始循环崩溃，人已经下班了。所以需要一个不依赖插件自身良心的自愈路径。

## 考虑选项

- **A. 单层 JSON 清单**（入口、配置 schema 全部用 JSON 表达，宿主侧解释执行）。声明侧最干净，
  但 schemastery 的 `ConfigSchema` 是函数对象，JSON 放不进去；`apply` 更是没法用 JSON 写。
- **B. 单层 TS 模块**（一切从模块默认导出读，包括权限和运行时要求）。写起来最省，
  但"读声明"必须先执行第三方代码 ⇒ 权限声明失去审计意义，管理台列表页要为每个插件付一次
  import 的代价与风险。
- **C. 两层：JSON 声明 + TS 实现，声明可选地冗余一份运行期能力（选中）**。宿主只 import
  它已经决定要装配的东西；崩溃自愈交给一个独立于插件的外部判据（HTTP 层的连续失败计数）＋
  一个跨进程的落盘标记。
- **D. C 再加运行期沙箱与自动回滚全部插件**。安全上最完整，但与 ADR-0006 已明确放弃的
  隔离模型正面冲突，且"自动回滚基础层"意味着系统会在无人知情时改变自己的装配集。

## 决策结果

选 C：**清单分两层，JSON 只做声明、TS 模块只承担执行；自愈靠两个插件管不着的外部判据**
（进程外的崩溃标记 + HTTP 层的连续失败计数）。落地形态（可复核）：

### 声明层：JSON，两个来源

`packages/core/src/index.ts` 的 `GeeWikiManifest`（`{ name; version; geewiki: GeeWikiMeta }`）
就是这份声明，`geewiki` 里放着 `runtime?` / `configSchema?` / `permissions?` / `slots?` / `routes?` /
`client?` / `entry?` / `migrations?`。文件来源二选一（同一文件头注释写明）：扩展 `package.json`
的顶层 `geewiki` 键，或独立的 `geewiki.manifest.json`。读取者是 `packages/manager/src/discovery.ts`
的 `parsePluginManifest(pkg, standalone)`——package.json 内嵌优先，否则读独立清单，
缺 `name` 抛 `DiscoveryError('invalid_manifest', …)`；`version` 不是字符串时静默按 `'0.0.0'` 处理。

入口解析也在这一层：`ENTRY_CANDIDATES`（同为 `discovery.ts` 导出的常量）是
`['index.ts', 'index.js', 'src/index.ts']`，`resolvePluginEntry(dir, entry?)` 按
`[声明的 entry, ...ENTRY_CANDIDATES]` 依次试，全都不存在 ⇒ `entry_not_found` issue。

### 实现层：TS 模块

`loadExternalPlugins()`（`discovery.ts`）在声明读完、决定装配之后才
`await import(pathToFileURL(entryAbs).href)`，取 `mod.default ?? mod`，条目 `source: 'external'`；
单个插件 import 失败只记 issue，不拖垮整轮发现。

运行期要求用 `GeeWikiRuntime` 声明（`packages/core/src/index.ts`），四个可选字段：
`supportsHotReload?`、`requiresCachePurge?`、`drainTimeout?`、`applyTimeout?`。全部经
`normalizeRuntime(runtime?)` 归一化后使用，默认值是：`supportsHotReload: false`、
`requiresCachePurge: false`、`drainTimeout: 5`、`applyTimeout: DEFAULT_APPLY_TIMEOUT_SECONDS`（30）。
两个超时的分工在字段注释里写死：`drainTimeout` 约束**卸载**，`applyTimeout` 约束**加载**，
`applyTimeout <= 0` 表示不超时。加载侧的执行点在 `packages/manager/src/index.ts` 的
`loadPluginModule()`：超时抛 `ManagerError('load_timeout', …)`，并把稍后才结算的"幽灵 fiber"
补一次 `dispose()`，避免超时后它悄悄活下来。

热授权链同样只看声明：`packages/manager/src/deps.ts` 的 `checkHotChain()` 要求链上每一项的
`manifest.geewiki.runtime?.supportsHotReload === true`，否则整条链拒绝热操作（409
`hot_reload_not_supported`）。样本：`plugins/hello-geewiki/package.json` 与
`plugins/ui-demo/package.json` 声明 `supportsHotReload: true`；`packages/plugin-auth/src/index.ts`
声明 `false`（承载登录态）；`packages/plugin-ai-web-search/src/index.ts` 把 `drainTimeout` 抬到 25
（一次在途检索要盖得住）。

真实形状是 `packages/manager/src/deps.ts` 的 `RegisteredPlugin`——`module` 上要求
`apply(ctx, config?)`，`Config?` 与 `health?` 可选。（注：`GeeWikiPluginDefinition` 这个名字
在本仓**不存在**，全仓 grep 无命中；本文按 `RegisteredPlugin.module` 写。）

### 配置 schema 的取值顺序

`packages/manager/src/index.ts` 的 `configSchemaOf(entry)` 决定一个插件的配置能不能被结构化校验，
顺序是：**先看 TS 侧** `entry.module.Config`（过 `isSchemaInstance`）⇒ **再看 JSON 侧**
`entry.manifest.geewiki.configSchema`（同样过 `isSchemaInstance`）⇒ 都不是 schemastery 实例就
只告警一次（"…已跳过结构化校验与表单生成，仅提供 JSON 原文编辑"）并返回 `undefined`。
判据在 `packages/manager/src/config-schema.ts` 的 `isSchemaInstance`：
要求 `typeof value === 'function'` 且 `value.toJSON` 也是函数。它的下游是
`configurable`、`getConfig`、`updateConfig`、`secretFieldsOf`、加载前校验填默认值、会话层配置叠加。

### 装配状态也是两层

`config/plugins.base.json` 是**本机 live 文件**（运行期可写，被 `.gitignore` 的 `config/*` 排除；
入库的是 `config/plugins.base.example.json`——只读、随版本发布的默认值），
`config/plugins.session.json` 是会话层（当前内容 `{"enabled": []}`）。
`readBaseList(liveFile)` 在 live 缺失时回退 example 文件并打一行日志；
`writeList(file, list)` 是原子写（`wx` 旗标 + 随机 tmp 名 + rename）。**写入永远只写 live**；
`persistSession()` 负责把会话条目提升进 Base。管理文件头对这套的定位是一句话：
"临时操作仅落 Session；`persistSession()` 把会话合并进 Base；看门狗熔断时清空会话自愈"。

### 崩溃标记与看门狗

两个独立机制，覆盖两种故障。

**崩溃标记**跨进程边界，回答"上次是不是没正常退出"。写标记方是 `packages/server/src/index.ts`：
未捕获异常/未处理拒绝走 `writeCrashMarker(crashMarkerFile, '<kind>: …')`，启动期抛错走
`writeCrashMarker(crashMarkerFile, 'startup: …')`。读取方是 `packages/manager/src/index.ts` 的
`boot()`：标记存在 ⇒ 打日志"检测到崩溃标记…本次启动忽略会话层（Session），回滚至基础层（Base）"，
把 `this.session` 置空、**同时把空清单落盘**、然后 `removeCrashMarker()`。正常收尾
（`disposeAll()` 成功尾部）也会删标记，所以标记的含义是"上次没走到优雅停机"，不是"上次报过错"。

**看门狗**是纯函数 + 定时器，判据不来自插件自己。`packages/manager/src/watchdog.ts` 的
`decideWatchdog(input)` 返回三种取值：`{action:'none'}`、`{action:'rollback', name}`、
`{action:'meltdown'}`。rollback 条件：`consecutiveFailures > 0 && sessionNonEmpty && inGrace`
（`inGrace` 要求最近一次启用仍处于 active 且 `now - lastEnabledAt <= gracePeriodMs`）；
meltdown 条件：`consecutiveFailures >= meltdownThreshold && sessionNonEmpty`。
调用方 `watchdogTick()` 的失败计数来自 HTTP 层：`this.ctx.get('http')` 拿 router 再读
`router.stats().consecutiveFailures`；默认 `gracePeriodMs: 5000`、`meltdownThreshold: 3`。
rollback 只调 `this.disable(decision.name)`；meltdown 直接
`writeList(sessionFile, { enabled: [] })` 后 `process.exit(1)`。
`watchdog.ts` 文件头记着修复前的教训：全局无差别归因会误伤，纯基础层故障不该触发熔断。

## 后果

**正面**

- 读声明不执行代码：权限、运行时要求、插槽/路由清单在 import 之前就拿得到，管理台与
  装配排序都不必为"看一眼"付 import 的代价和风险，权限声明（ADR-0006）因此才有审计价值。
- 失败被限制在发现阶段之外：`loadExternalPlugins()` 单个条目失败只记 issue，
  一个坏插件不会让整轮发现归零。
- "临时试用"有边界：会话层写 `plugins.session.json`，基础层文件不因试用而变脏；
  `persistSession()` 是把试用期表现变成正式装配的唯一出口。
- 崩溃自愈不需要插件配合：判据是 HTTP 层的连续失败计数和一个进程外的标记文件；
  插件即使 `apply()` 直接抛错、根本没机会写任何注销函数，回滚照样成立。
- 归因是有意识的窄化：meltdown 必须 `sessionNonEmpty`，日常基础层抖动不会把整个实例关掉；
  rollback 只针对最近一次会话启用，且只在 `gracePeriodMs` 窗口内动手。
- 默认值全部偏保守：`normalizeRuntime` 缺省 `supportsHotReload: false` ⇒ 热更新是显式争取来的
  例外（呼应 ADR-0002），不是白拿的默认。

**负面 / 风险（如实）**

- **JSON 那半层带不动 schemastery，而它是静默降级。** `configSchemaOf` 的顺序是先
  `module.Config` 后 `manifest.geewiki.configSchema`，但 JSON 文件里写不出 schemastery 实例
  （`isSchemaInstance` 要求 `typeof value === 'function'`），所以只在 JSON 里写 `configSchema`
  必然判 false ⇒ 返回 `undefined` ⇒ 只剩一次 `console.warn` 加管理台 JSON 原文编辑框：
  **不校验、不裁剪、不生成表单、`secretFieldsOf` 也就无从知道哪些字段是密钥**。
  声明层看起来"能写 configSchema"，实际上只有 TS 侧写才有意义——这是本条最大的认知陷阱。
  好消息是这条降级不是无声故障（`configurable` 会因此变 false，界面上看得见）；
  坏消息是告警只打一次、且在 stdout。
- **`requiresCachePurge` 的下游在生产代码里找不到订阅者。** 定义处是
  `packages/core/src/index.ts` 的 `GeeWikiRuntime`；读取处确实存在——
  `packages/manager/src/index.ts` 的 `purgeCaches()` 读 `normalizeRuntime(...).requiresCachePurge`，
  为真时 `await this.ctx.parallel(CACHE_PURGE_EVENT, name)`。但除 core 的定义、manager 的广播、
  以及 `packages/manager/test/manager.test.ts` 的两条用例（一条验证广播发生/不发生，
  一条验证 `parallel` 不会因单个监听器抛错而跳过其余）之外，
  **全仓 grep `CACHE_PURGE_EVENT` / `geewiki/cache-purge` 没找到任何生产环境的事件订阅者**。
  也就是说：把它设成 `true` 目前只是"请求了一次没人应答的广播"。这个字段的实际收益为零，
  直到有人真的去订阅 `packages/core/src/index.ts` 的 `CACHE_PURGE_EVENT`。
- **热更新不回收内存，只是不再用。** `unloadPlugin()` 的收尾是
  `closeOwnStreams` → `slots.release(name)` → `drainBeforeUnload` → `fiber.dispose()`，
  释放的是宿主登记的资源（长连接、插槽贡献、cordis 实例）。但 ESM 模块实例不会被回收：
  `loadExternalPlugins()` 走的是 `await import(pathToFileURL(entryAbs).href)`，同一 URL 命中模块
  缓存，**换代码的路径只有重启进程**（前端侧同理，新产物必须整页刷新才生效，见
  `packages/server/src/index.ts` 的注释）。`docs/plugin-platform.md` 的风险表把这条写成
  "ESM 模块实例永不回收"；`docs/plugin/anti-patterns.md` 的 AP-19 也据此要求插件自己保存并调用
  注册函数返回的注销函数。结论：`supportsHotReload: true` 买的是"不必重启就能换配置/换启停"，
  **不是**"改了代码不用重启"，也不是内存归还。
- **卸载函数漏写没有任何运行期检测。** 本仓代码不校验 `apply()` 的返回值：卸载路径直接
  `await managed.fiber.dispose()`（`packages/manager/src/index.ts`），而 cordis 内部是
  `if (typeof dispose === "function")` 才调用（cordis `4.0.0-rc.10` 的实现细节，升依赖时要复核）
  ——**不是函数就静默跳过**，两边都不会因为漏写
  disposer 而报错。唯一的守门是脚手架自检：
  `packages/manager/test/scaffold.test.ts` 用 `assert.match(code, /return \(\) => \{/, 'apply 必须返回卸载函数')`
  钉住**新生成的模板**，已有插件一个都不查。所以漏写 disposer 的后果是插件"卸了但还在"：
  它自己起的定时器、模块内状态、`Context.on` 的监听全都留在进程里（宿主只回收**自己登记过**的
  东西——长连接走 `closeOwnStreams()`、插槽贡献走 `slots.release()`），而且没有任何地方会报错。
  这比热更新不回收内存更糟，因为它骗人。
- **看门狗的粒度是"最近一次会话启用"，不是"肇事件"。** rollback 的输入只有一个候选
  `lastEnabledName`，判据是 `router.stats().consecutiveFailures` 这种全局 HTTP 症状。
  于是三种边界情形：① 回滚窗口只有 `gracePeriodMs`（默认 5 秒）——慢发作的故障（内存爬升、
  定时任务错位）出窗口后看门狗不再动手；② 若真正坏的是基础层插件、而恰好有个会话插件在窗口内
  且会话层非空，被 disable 的是那个无辜的会话插件；③ meltdown 的补救是清空整个会话层后
  `process.exit(1)`，靠 supervisor 拉一个干净的进程——它不回滚基础层，也不回滚任何已经
  `persistSession()` 提升过的东西，更不回滚数据库迁移（迁移只前进，见 ADR-0003 的双轨）。
  崩溃标记那条路同理更粗：它不看是谁弄的，直接放弃整个会话层，把基础层清单当作已知好的点。
- **完全没有版本/兼容校验。** 对 `semver`、`compareVersions`、`parseVersion` 三个名字在
  `packages/manager/src`、`packages/core/src`、`packages/server/src`、`scripts` 下 grep ⇒ **零命中**：
  `version` 在发现阶段只用来打日志，
  非字符串还悄悄变 `'0.0.0'`；宿主不校验"这个插件要求哪个宿主版本"。唯一的版本信号在前端：
  `packages/web/src/lib/hostSdk.ts` 的 `HOST_SDK_VERSION`（当前 `'0.12.0'`，作为 SDK 对象的
  `version` 字段暴露）；`docs/plugin/compatibility.md` 的结论先行一句
  "**宿主不做任何兼容校验**"，`docs/plugin/anti-patterns.md` 更把「指望宿主做版本兼容校验」列为
  高危反模式（AP-25）。后果：一个为老宿主写的插件会加载并崩在运行期，
  而不是被一句清晰的"不兼容"挡住——也就是说，兼容性靠 ADR-0006 说的"作者自觉 + 人工 review"。
- 两层清单的一致性靠人维持：声明说 `entry: 'index.js'` 而目录里只有 `index.ts` 时，
  失败发生在发现阶段（`entry_not_found`），这是好的一面；坏的一面是 JSON 侧的 `runtime`
  写错（比如把 `supportsHotReload` 拼错）不会报错，只会按 `normalizeRuntime` 的保守默认走，
  表现为"热更新莫名 409"。

## 重新评估触发条件

- 出现真实的 `CACHE_PURGE_EVENT` 订阅者，或决定删掉 `requiresCachePurge` 字段 ⇒ 本条负面第二条作废。
- 决定给 `configSchema` 加 JSON 可表达的子集（受限 DSL）并在 `configSchemaOf` 里编译成
  schemastery ⇒ 需要新 ADR，本条降级为部分有效。
- 运行期开始校验 `apply()` 返回值类型、或把 `scaffold.test.ts` 那条断言升级为加载期硬校验 ⇒
  负面第四条作废。
- 引入宿主/插件版本协商（manifest 加 `geewiki.requires` 宿主版本并要求 semver 判定）⇒
  本条与 `docs/plugin/compatibility.md` 一起改写。
- 看门狗改成"逐插件健康判定"（用 `RegisteredPlugin.module.health` 而不是全局
  `consecutiveFailures`）⇒ 粒度相关的三条负面全部重写。
