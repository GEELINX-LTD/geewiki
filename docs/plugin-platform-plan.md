# GeeWiki 插件化平台：实施批次方案与内核实证

> 本文档面向项目维护者与后续接手者，回答两个问题：**下一步按什么顺序做什么**，以及**底层内核行为已经被实验证实成什么样**。
>
> 文档中的"实证"结论来自 `data/spike/` 下的探针脚本（`probe1-fork-update.mjs` / `probe1b-hooks.mjs` / `probe1c-hook-next.mjs` / `probe2-schemastery.mjs` / `probe2b-payload.mjs` / `probe3-load.mjs` / `addendum.mjs`）。**`data/` 被 `.gitignore` 排除，该目录随时可能被清理**，因此结论在此固化；`data/spike/` 内另装有 `schemastery@3.18.0` 与 `cordis@4.0.0-rc.10` 作为独立验证环境（**注**：`schemastery@3.18.0` 后来已在工作区正式声明——`packages/core` / `packages/manager` / `packages/plugin-wiki` / `packages/plugin-echo` 的 `package.json` 均为 `"schemastery": "3.18.0"`，见第 9 节；`data/spike/` 内的那份是初版核对时的独立安装）。复现方式见第 8 节。
>
> 现状与设计蓝图见 [architecture.md](./architecture.md)，阶段划分见 [roadmap.md](./roadmap.md)（本文批次 B–F 对应 roadmap 的 Phase 3 / Phase 4 候选清单），容器化细节见 [deployment.md](./deployment.md)。本文编号自成体系，不延续 architecture.md 的章节号。

## 1. 背景与目标

GeeWiki 已具备"清单驱动装配 + 依赖图/冲突组 + 会话沙箱 + 迁移控制器 + 看门狗"的插件管理器（`packages/manager`），但插件的**可配置、可外部扩展、可贡献界面**这三条链路尚未打通。插件化平台需要补齐 6 项能力（另有本阶段新增的第 ⑦ 项"检索与问答"，见下表末行与**批次 G**）：

> **落地状态（本轮回填，按代码核对）**：①②**已落地**，③**宿主侧已完整落地**（含后端下发入口表与生命周期自动同步；仅剩后端 `ctx.slot()` 与更多扩展点未做），④ 的一半已落地、另一半仍是设计定稿，⑤ 已落地，⑥ 明确延期。逐条见下表与第 4 节各批次。

| 编号 | 能力 | 当前状态 |
| --- | --- | --- |
| ① | 插件配置系统：manifest `configSchema` → 前端表单 + 持久化 + 热更新 | **已落地**：`configSchema` 采用 schemastery 3.18.0（`packages/core/src/index.ts:95` 的类型 + 两个内置插件均为 `Schema.object({...})`）；服务端校验 + 白名单裁剪 + 原子落盘 + 已激活插件 `fork.update()` 热更新（失败双向回滚）；管理台按 schema 自动生成表单，无 schema 插件退回 JSON 原文通道（不校验、不裁剪） |
| ② | 外部插件加载：`./plugins` 目录 + 清单发现 | **已落地**：`packages/manager/src/discovery.ts` 的 `loadExternalPlugins()` 发现并加载，`packages/server/src/index.ts` 的 `buildRegistry()` 把外部插件**并入同一注册表**；内置插件仍由 `defaultRegistry()` 代码内置登记（4 个：`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/echo` / `@geewiki/wiki`）；发现期问题经 `GET /api/plugins` 的 `issues` 字段可观测（L-14） |
| ③ | 前端 Slot 插槽：插件向 Web 管理台贡献 UI | **宿主侧已完整落地**：`window.__GEEWIKI_HOST__` 宿主 SDK + `packages/web/src/lib/slots.tsx` 的 `registerSlot` / `SlotOutlet`（含 ErrorBoundary）+ 按**后端下发的入口表**（`GET /api/plugins/ui`，由清单的 `geewiki.client` × 激活集合 × 产物存在性现算）动态加载 `/plugins-ui/<插件名>/<入口文件名>`；插槽名白名单**仅 `app-header` / `app-footer`**；**已绑定 fork 生命周期**（管理台动作即时、`visibilitychange` + 15s 轮询收敛，UI 随插件启停自动出现/消失）。**未落地**：后端 `ctx.slot()` 注册链路、`editor-toolbar-slots` / `admin-page-slots`、Suspense / use Hook 懒加载（详见 `docs/architecture.md` §6 的已知边界） |
| ④ | 治理补齐：`drainTimeout` 消费、`conflictGroup` 替换交互、`enable` 回滚作用域 | 三项**均已落地**：排空见 L-1（粒度是**全站**在途请求，非 owner 级）；冲突组替换 = `POST /api/plugins/:name/replace` + 管理台顶替确认框（G-1，提交 `42db76a`；前置校验与前端交互后经 `2227adf` / `b21534a` 收紧，见 G-1 的三类拒绝）；`enable` 回滚改为全递归共用集合（G-2，提交 `69cfeb2`） |
| ⑤ | 容器化：`docker compose up` 可用 | **已落地并实测**（`Dockerfile` / `docker-compose.yml` / `docs/deployment.md`；G1–G4 的逐条状态见第 5 节 L-10） |
| ⑥ | PostgreSQL 适配（评估） | ✅ **已落地**（后续批次）：真 PG 15 端到端验证通过；`DatabaseAdapterAsync` 双轨本已存在，方言迁移目录与 `migrations` 双路径已就位。当时的延期依据与前置条件见第 5 节 **L-9**（已附状态更新） |
| ⑦ | 检索与问答（AI 原生能力首批，**本阶段新增**） | **检索地基已落地并默认启用**（`@geewiki/search`：FTS5 + `trigram` + 短词 LIKE 兜底）；**LLM 契约层已落地**（`@geewiki/llm`，**有意不含厂商 adapter** ⇒ 无可用 provider）；**问答检索-only 已落地**（`@geewiki/ai`，**没有 API key 也完整可用**）；前端为**宿主原生 UI**（子路由 `#/wiki/search/<q>`、`#/wiki/ask/<q>`，**Slot 机制零改动**）。**未做**：厂商 adapter（L-15）、**真实**流式 SSE（L-16，有意——**出口地基已就绪，见下**）、向量/语义检索（L-17，有意后置）。**后续批次补充**：SSE 长连接出口与优雅排空的共存**已落地**（提交 `2273006`：`noteStatus` / `trackStream` / `closeStreams` + 五步 teardown），但**真实流式输出仍未接线**。交付与核对记录见**批次 G**，实证见 **§2.4** |

> **修正（本批，2026-09-14）**：上表 ③ 与 ⑦ 两行的"未落地 / 未做"半截已过时，按代码核对更正如下（逐条细节见批次 D 与批次 G 末尾的同名修正块）。
>
> - **③ 前端 Slot**：插槽名白名单**不再是"仅 `app-header` / `app-footer`"**，插槽贡献的后端链路也**已落地**（但形态不是 `ctx.slot(name, component)` 这样的方法糖——全仓没有 `ctx.slot()`，落地形态是"manifest `slots: SlotName[]` 由管理器在激活时登记 + 运行期 `ctx.get('slot').contribute(...)`"，详见 §9"后端插槽注册链路"行）。权威清单现为 `packages/core/src/index.ts:797` 的 `export type SlotName = 'app-header' | 'app-footer' | 'editor' | 'editor-toolbar' | 'wiki-ask'`（`SLOT_NAMES` 在 `:800`、基数表 `SLOT_CARDINALITY` 在 `:821`），浏览器侧镜像在 `packages/web/src/lib/slots.tsx:49`（`SLOT_NAMES` `:52`、`SINGLE_OCCUPANCY_SLOTS` `:157`）。后端链路：`interface SlotService`（`packages/core/src/index.ts:960`，`contribute` / `list` / `ownersOf` / `release`）→ 实现 `SlotRegistry`（`packages/manager/src/slots.ts:157`）+ 纯函数 `resolveSlots(contributions, activationOrder)`（单占用按**最早激活优先**裁决，其余进 `suppressed` 并记冲突）→ 独立插件 `slotPlugin`（`packages/manager/src/slot-plugin.ts`，名 `@geewiki/slot`，服务名 `slot`）在管理器**之前**注册（`packages/server/src/index.ts:1571`）→ 只读端点 `GET /api/plugins/slots`（`packages/manager/src/index.ts:1743`）返回 `{ slots: assignments, conflicts: assignments.filter(a => a.suppressed.length > 0) }`。**为什么 `slotPlugin` 必须独立且在前**：它的头注释记着实测踩过的坑——若由管理器在自己的 `apply` 里 provide，子插件 `apply` 早于管理器完成，`ctx.get('slot')` 取到 `undefined`，运行期 `contribute` 会被**静默跳过**。**仍为候选的**：`admin-page-slots`、Suspense / use Hook 懒加载。
> - **⑧ 前端 Slot 与旧问答 UI（P8 拆除，2026-09-15）**：上面 ③ 那条的"白名单"结论**第二次过时**。
> **真源现为 6 个**（`packages/core/src/index.ts` 的 `SlotName` / `SLOT_NAMES` / `SLOT_CARDINALITY`）：
> `app-header` / `app-footer`（零属性 multi）/ `editor`（单占用）/ `editor-toolbar`（multi）/
> `app-dock`（单占用，常驻底部输入条）/ `article-summary`（单占用，文章顶部折叠摘要）。
> **`wiki-ask` 已从白名单消失**（决策 17：`#/wiki/ask/<q>` 路由与那个插槽一起拆除，
> AI 对话的唯一入口是 `app-dock`），**`@geewiki/ai-qa` 整包删除**（决策 22）。
> 连带变化：`packages/web/src/lib/pluginUiPlan.ts` 的 `ON_DEMAND_SLOTS` 现为
> `['editor', 'editor-toolbar', 'app-dock', 'article-summary']`（上面 594 行那条写的是旧值）；
> `packages/web/src/lib/wikiRoute.ts` 不再解析 `ask`，但 **`'ask'` 仍留在
> `WIKI_RESERVED_FIRST_SEGMENTS` 里**（解禁是单向不可回收的：既有的 `#/wiki/ask` 分享链接会
> **静默**变成一个页面）；两条"无贡献也要补一句占位"的路线随之只剩 `SlotOutlet` 一条。
> **实测读数**（隔离实例 `GEEWIKI_PORT=3931`）：`GET /api/plugins/slots` 恰两条
> （`app-dock:single effective=['@geewiki/ai-assistant']`、`article-summary:single effective=['@geewiki/ai-summary']`），
> **`wiki-ask` 不在表里**；入口表 `plugins` 恰两键；三个旧端点与旧产物全部 **404**。
> 拆除面、两处被既有测试抓出的连带缺陷（`dockPlan.pageContextOf` 与
> `commandPlan.visitedSlugFromSub` 会把 `ask/foo` 当成真实页面 ⇒ 新增 `isUnreachableSlug` 收口）
> 见 [design/ai-plugin-architecture.md](./design/ai-plugin-architecture.md) §7.1 / §8.12。
> - **⑦ 检索与问答**：`@geewiki/ai` **已一分为二**——`@geewiki/ai-writing`（`displayName: 'AI 辅助写作'`，`packages/plugin-ai-writing/src/index.ts:74-96`，贡献 `editor-toolbar`）与 `@geewiki/ai-qa`（`displayName: 'AI 问答'`，`packages/plugin-ai-qa/src/index.ts:158-177`，贡献 `wiki-ask`）。**"没有 API key 也完整可用"这条产品承诺在问答侧被主动放弃**（详见批次 G 修正块与 `docs/design/ai-plugin-split.md`）；**AI 前端不再住在 `packages/web`**，改由插件自带 bundle 经插槽插入，宿主侧 `AskPanel.tsx` / `AssistToolbar.tsx` / `aiStreamPlan.ts` / `assistPlan.ts` 已删除；两条新插件与 `@geewiki/llm`、`@geewiki/openai` 同在 `config/plugins.base.json` 默认启用清单里，`defaultRegistry()` 按 `packages/server/src/index.ts:1456` / `:1465` 分两条登记。**数量口径本批不填**（见第 6 节，由读数批次回填）。

目标：在不引入子进程沙箱、不引入重前端构建链路的前提下，让第三方插件能以"放进目录即被发现、填表即被配置、注册即出现在管理台"的方式接入。

## 2. 已实证的内核技术事实

本节是全文最重要的部分：下列行为均已用真实脚本跑出结果，**不是文档推断**。每条结论后附产生它的探针与小节（`data/spike/probe*.mjs` §X）；对未直接跑出、仅由文档或推理传递的内容，显式标注「未验证」。

### 2.1 cordis（实装 `4.0.0-rc.10`）

**F-1 `Fork.update(config, noSave?)` 的语义是「dispose 旧实例 → apply 新实例」，不是原地改配置。**

实测调用序列（`probe1-fork-update.mjs` §A）：

```
apply#1 → update({a:2}) → dispose(来自 apply#1) → apply#2(新 config) → state=ACTIVE，fork.config={a:2}
```

后果：任何"改配置"都必须按**重启插件**来设计——apply 里的副作用会被拆掉重建，内存态一律丢失，`ctx.provide` 注册的服务在窗口期短暂不可用（`probe1b-hooks.mjs` §C 验证了 unprovide → 重新 provide 的完整链路）。

**F-2 非法配置抛 `ValidationError`，且不污染旧配置。**

- 类型：`ValidationError`，`instanceof TypeError === true`。
- message 形如 `invalid config:\n  - n 必须是 number (at n)`（schemastery 的中文校验消息被原样带入）。
- 抛出后 fork 仍是 `state=ACTIVE`、`fork.config` 仍为旧值；随后合法 `update()` 可正常继续（`probe1-fork-update.mjs` §C）。

**F-3 第二次 `apply` 抛错时，fork 停在 `FAILED`，且 `fork.config` 已是新值。**

实测（`probe1-fork-update.mjs` §D）：`update({v:2})` 抛错后 `state=FAILED`、`config={v:2}`。即**进程内配置与插件实际行为已经不一致**。管理器必须显式用旧配置再 `update()` 一次回滚，否则该插件无声失效（进程内声明新配置、实际仍跑旧逻辑，或直接不激活）。

**F-4 对已 dispose 的 fork 调用 `update()` 抛 `CordisError: cannot create effect on inactive context`，`code=INACTIVE_EFFECT`**（`probe1-fork-update.mjs` §F；常量亦见 `cordis/lib/index.js` 的 `INACTIVE_EFFECT` 定义）。管理器应在卸载后清空 fiber 引用，避免对已销毁 fiber 发更新。

**F-5 依赖方会被连带重启（inject 语义）。**

provider 热更新时，consumer 会先 `dispose` 再 `apply`（`probe1b-hooks.mjs` §D）：

```
provider dispose → consumer dispose → provider apply{v:2} → consumer apply#2
```

做排空/卸载时要把这个窗口算进去：**一次配置热更新实际影响的插件数 = 该插件 + 其全部活动依赖者**。

**F-6 `internal/update` 是 Koa 式中间件，且必须注册在 `fork.ctx` 上。**

- 签名 `(config, noSave, next)`；实测钩子收到的实参为 `object, boolean, function`（`probe1c-hook-next.mjs` §A、§B）。
- **不调用 `next()` 会静默吞掉重启**：`update()` 返回 `undefined`、无异常、`apply` 不再执行、`fork.config` 保持旧值（`probe1c` §A + 独立复现确认）。这一点很危险——落盘失败时若"忘记 next"，热更新会表现为"没有任何反应"。
- **注册在 root 上收不到**：把同一个钩子注册到 `app`（root Context）时，`fork.update()` 完全不触发该钩子，`apply#2` 照常执行、配置照常变更（独立复现）。这是因为 cordis 把 fork 级钩子挂在 `fiber._hooks['internal/update']` 上（`cordis/lib/index.js` 中 `internal/update` 仅在非 `global` 时挂到 fiber），只有 `fork.ctx.on(...)` 注册的钩子参与该 fork 的 `waterfall`。
- 中间件可**改写传入的 config 对象引用**并影响 `apply`（`probe1c` §C：注入 `injected: 'by-middleware'` 后 apply#2 收到该字段）；中间件抛错则不重启、配置不变（§D）；多中间件为洋葱模型（§E）。

**F-7 `plugin.Config = Schema` 让 cordis 自动校验并填满默认值。**

schemastery 暴露的 `[Symbol.for('standard-schema')]` 接口返回 `{value}` 或 `{issues:[{message,path}]}`，正是 cordis `resolveConfig` 期望的形状。实测 `app.plugin(plugin, {port: 3000})` 后：

- 插件 `apply` 直接收到**完整配置**（默认值已补齐），无需手写 `new Config()`；
- `fork.config` 为补齐后的完整对象；
- 非法值在 `plugin()` 与 `update()` 两条路径上都抛错（`probe2-schemastery.mjs` §8）。

**F-8 cordis 4 中 `ctx.set` 不可用，必须 `ctx.provide(name, value)`。**

`Error: cannot set property "x" without provide`；注销用 `provide()` 返回的 unprovide 函数（`probe1b-hooks.mjs` §C 实测 `provide → 热更新 → unprovide` 后 root 侧服务从 `{tag:'v1'}` → `{tag:'v2'}` → `undefined`）。仓库现有插件（`packages/db-sqlite`、`packages/plugin-wiki` 等）已按此写法。

### 2.2 schemastery（`3.18.0`）

**S-1 hydrate 等价**：`new Schema(JSON.parse(JSON.stringify(schema)))` 与原 schema 行为等价，可跨环境传递（`probe2-schemastery.mjs` §4）。

**S-2 校验与默认值**：`new Config(raw)` 合并默认值；类型错抛 `ValidationError`，message 形如 `$.port expected number but got abc`（`probe2` §2 对照；注意与 cordis 包装后的 F-2 消息形态不同——经 `plugin.Config` 走 cordis 时消息被重写为 `invalid config:\n  - ...`）。

**S-3 序列化载荷是引用图，前端必须自己实现 refs 解析。**

`JSON.stringify(schema)` 的形状为顶层 `{uid, refs}`；节点含 `dict` / `list` / `inner` / `sKey` / `value` 与 `meta.{default,description,role,required}`（`probe2b-payload.mjs` §1 实测：14 个 refs）。union 会拆成 `const` 子节点加 `list:[i,j]`，枚举选项值需从 `refs[n].value` 取（§2 的"字段 → 控件"映射演示了完整走法）。**前端要自己实现 refs 解析才能渲染表单**——没有开箱的"JSON Schema 直出"。

**S-4 序列化不幂等，不能做缓存键或变更检测。**

实测 `payload → new Schema(payload) → 再次序列化` 与原载荷**不相同**，`uid` 由 `28` 变为 `42`（`probe2b-payload.mjs` §3）。因此：schema 的缓存键、版本比对、变更检测都必须另找依据（如插件版本号、schema 源码哈希），不能拿序列化结果比对。

**S-5 `simplify` 是实例方法。**`schema.simplify(value)` 成功、`Schema.simplify(value)`（静态）抛 `TypeError: Schema.simplify is not a function`（`probe2` §5）。语义是剔除等于默认值的字段（`{host:'127.0.0.1', port:9090, enabled:true, mode:'simple', tags:['a','b'], limits:{}, nested:{level:1}}` → `{port:9090, tags:['a','b']}`），重新 hydrate 时默认值可回填（闭环）。

**S-6 不剔除未知字段。**`new Config({unknownField: 1})` 会保留该字段（`probe2` §2）。**配置白名单需业务侧自己做**：落盘前必须按 schema 声明的键裁剪，否则插件可以往自己的配置文件里塞任意内容。

**S-7…S-17 序列化载荷规格（批次 C 配置表单的输入契约）。**

> 编号来源：以下为对 `schemastery@3.18.0` **源码 + 独立探针**的实测（源码即 `data/spike/node_modules/schemastery/src/index.ts`，行号以该 3.18.0 版本为准；探针为 `probe4-payload-spec.mjs` / `probe5-identity.mjs` / `probe6-labels.mjs` / `probe7-graph.mjs`，产物 `data/spike/probe{4,5,6,7}.out`；均在 `data/spike/` 下、已被 gitignore）。
> **依赖前提**：工作区当前**没有 schemastery 依赖**（`require.resolve('schemastery/package.json')` 失败，`pnpm-lock.yaml` 无该包），**cordis 4.0.0-rc.10 也不依赖它**（其 `dependencies` 仅 `@standard-schema/spec` 与 `cosmokit`）。批次 C 需正式加依赖（见第 4 节批次 C 的涉及文件表与第 9 节核对记录）。

**S-7 载荷形状：`{ uid: number, refs: Record<uidString, Node> }`；`refs` 是对象不是数组。**

`Schema.prototype.toJSON()`（`src/index.ts:235-246`）产出顶层 `{uid, refs}`。嵌套 Schema 在被 stringify 时**只返回自己的 uid 数字**，并注册进同一张 `refs` 表。**节点上没有 `uid` 字段**——uid 不可枚举，仅作为 `refs` 的键存在。

**S-8 反序列化没有 `Schema.fromJSON`；且反序列化会执行载荷里的 callback 字符串（安全红线）。**

- 唯一入口是构造函数本身：`Schema(payload)` / `new Schema(payload)`，`refs` 分支在 `src/index.ts:178-208`。实测还原后可正常 `validate` / `simplify`（`probe4.out` §1：`revived type=object`，`validate({})` 返回 `$.name missing required value`）。
- **安全红线（必须遵守）**：反序列化会对节点的 `callback` 字符串执行 `new Function('return ' + s)()`（`src/index.ts:197-202`）。因此**前端绝不可对插件下发的载荷调用 `Schema(payload)`**——等价于任意 JS 执行。
- **正确做法**：前端**只按 `refs` 图渲染**，不 hydrate；服务端下发前**剥离 `callback` / `preserve`**，并把 `transform` 类型**降级为透传其 `inner`**；**校验与默认值填充一律留在后端**。

**S-9 节点字段全集（实测，`probe4.out` §6 的 `[node keys seen]`）。**

`type`、`meta`、`dict`(字段名→uid)、`inner`(uid)、`sKey`(uid，仅 dict 键 schema)、`list`(uid[])、`bits`(名字→数字字面量，仅 bitset)、`value`(仅 const)、`constructor`(类名字符串，仅 is)、`callback` + `preserve`(仅 transform)。**`builder` 不序列化。**

**S-10 `meta` 可用键；没有 `title` 概念。**

可用键：`default, required, disabled, collapse, badges, hidden, loose, role, extra, link, description, comment, pattern{source,flags}, max, min, step`，以及 `.extra(k, v)` 注入的任意自定义键（`probe6.out` 实测自定义键 `customKey` 原样出现在 `meta` 中）。
**没有 `title` 概念**——标签只能用父 `dict` 的键名；`meta.description` 可能是 locale 字典（含 `""` 兜底键）。

**S-11 类型枚举与控件判定顺序。**

类型注册处 `src/index.ts:803-839`，共 17 种：`is / any / never / const / string / number / boolean / bitset / function / array / dict / tuple / object / union / intersect / transform / lazy`。
**控件判定顺序：`meta.role` 优先 → `type` → 结构字段（`dict` / `inner` / `list` / `sKey` / `bits`）**。

**S-12 枚举（union of const）与判别联合。**

- `type === 'union'` 且 `list` 中每个分支都是 `const` 时才可当选项列表渲染；**混合联合（含非 const 分支）不可当枚举**。
- **取值在 `refs[branch].value`（不在 union 节点上）**；默认值在 `union.meta.default`；选项标签取 `refs[branch].meta.description ?? String(value)`。
- 判别联合：`union` 分支是 `object` 时，判别值在 `refs[branch].dict.type` 指向的 const 节点的 `value`（`probe5.out` §D：`dict: {type: 19, url: 20}`，`refs["19"] = {type:'const', value:'http'}`）。

**S-13 各类型的表单映射（其余分支）。**

| 类型 | 渲染方式 |
| --- | --- |
| `object` | 按 `dict` 渲染子字段 |
| `array` | 元素为 `refs[inner]` |
| `dict` | 值 `refs[inner]`、键 `refs[sKey]` |
| `tuple` | `refs[list[i]]` |
| `intersect` | 合并各分支 `dict` |
| `bitset` | `Object.keys(bits)` 作选项；提交值为选中位按位或的 **number** |
| `transform` / `lazy` | 透传 `inner` |
| `any` | JSON 编辑器 |
| `is` / `function` / `never` | 不可表单化 |
| `meta.hidden === true` | 不渲染（映射到 `kind: 'hidden'`，`SchemaForm` 的 `case 'hidden'` 直接 `return null`，**无说明行**），但保留默认值 |
| `meta.role === 'password'` | 字符串字段渲染密码输入框（`type="password"` + `autoComplete="new-password"`）；`textarea` 与 `password` 之外的 `role` 才退化为文本框并附 `role=…` 注记 |

**S-14 图结构陷阱与缓存键（渲染器必须处理的四件事）。**

- `refs` 的键序**不是拓扑序**（`sKey`、lazy 展开的子节点常排在父节点之后）；
- 节点可被多处引用（**DAG**，同一 uid 出现多次只存一份——`probe7.out` SHARED：`dict {a:2, b:2, c:4}`，`a===b` 为 true）；
- `lazy` 自引用时 `inner` 指向**自己**（`probe7.out` CYCLE：`{"s":{"uid":10,"refs":{"10":{"type":"lazy","inner":10}}}}`）→ **渲染必须做路径记忆 + 深度上限**，否则无限递归；
- **uid 不能当缓存键**：同一实例重复 `JSON.stringify` 字节相同（`probe5.out` §B：`uid=14/14 equal=true`），但**重新构造同一 schema 会得到不同 uid**（`probe5.out` §A：`uid1=4 uid2=9 payloadEqual=false`）。跨请求请用**内容 hash 或插件版本号**。

**S-15 默认值是自动注入的，无法区分"用户显式设置"。**

`meta.default` 对 `object` / `array` / `dict` / `tuple` / `bitset` 恒存在（`{}` / `[]` / `0`，由 `defineMethod` 自动注入，见 `src/index.ts:791-797`），**无法据此区分「用户显式设置的默认值」**。表单的"是否已自定义"状态需另找依据。

**S-16 `required` 判定发生在默认值填充之前。**

`src/index.ts:413-422`：对象缺失时先判 `schema.meta.required`（`:414` 抛 `missing required value`），再走默认值回填。因此 **`required` + `default` 同时存在时，对象缺失仍报 `missing required value`**（`probe7.out` REQUIRED：`refs["23"] = {type:'object', meta:{default:{}, required:true}}`，`validate({})` → `$.o missing required value`）。表单不能因为"有默认值"就推断该字段可省略。

**S-17 cordis 集成形状（与 F-7 呼应）。**

插件写 `plugin.Config = Schema` 后，`app.plugin(plugin, rawConfig)` 会**自动校验并填默认值**；`~standard.validate()` 返回 `{value}` 或 `{issues:[{message, path}]}`（`src/index.ts:216-233`），正是 cordis `resolveConfig` 期望的形状。

> 补充（与 S-6 同源、落在实现细节上）：校验不剔除未知字段的原因是 object resolver 用 `merge(result, data)`（`src/index.ts:700`，另见 `:732`）→ 白名单裁剪要自己做，参见 S-6。

### 2.3 外部插件加载（ESM）

> 编号约定：本节 `L-n` = Loader/ESM 的**实证事实**；第 5 节的 `L-n` = **已知限制**，两者编号独立，交叉引用时以节号为准。

**L-1 用 `pathToFileURL(absPath).href` 再 `import()`。**

- Linux + Node 22.23.2 下裸绝对路径对**普通路径**可以成功（`probe3-load.mjs` §A 实测成功）；
- 但当路径含 `#` / `?` 时，裸绝对路径按 URL 语义被截断，抛 `ERR_MODULE_NOT_FOUND`（`addendum.mjs` §1：`we#ird?.mjs` → `Cannot find module '.../ext-plugin/we'`），改用 `pathToFileURL()` 后成功。

结论：**统一走 `pathToFileURL()`**，不要依赖"裸路径在 Linux 能用"这一环境特性。

**L-2 同 URL 二次 import 命中缓存（同一实例）；改文件后用 `?v=<mtimeMs>` 拿到新模块。**

`probe3-load.mjs` §B 实测两次 import 同 URL 得到同一模块对象；§C 实测改文件后不带 query 仍是旧模块，带 `?v=mtime` 得到新模块。ESM 无 `require.cache`，**热重载只能靠 query 击穿缓存**（旧模块实例不会被回收，反复重载会累积，见第 5 节 L-6）。

> **限定（本批实测补充，勿与插件 UI 的结论混淆）**：以上是 **Node 侧**（后端动态加载外部插件）的事实。**浏览器侧**加载插件 UI bundle 时，query 击穿缓存这条路**已被实测否决**——dev 下给根相对 URL 加 `?v=` 会触发 Vite `injectQuery` 改写而 **500**；改用同源绝对 URL 后虽能加载，但 `rev` 变化产生新模块实例会导致**插槽条目翻倍**（实测 widget 2→4）。故插件 UI 的最终形态是 **URL 不带 query、`rev` 只作变更检测**（详见第 4 节批次 D 的证伪说明与第 5 节 L-6 补充）。

**L-3 目录说明符直接 import 失败。**

`import(pathToFileURL(dir).href)` → `ERR_UNSUPPORTED_DIR_IMPORT`（`probe3-load.mjs` §D）。**必须解析到具体文件**，即入口解析顺序不能省。

**L-4 Node 22.18+ 可直接执行 TS，但仅限可擦除语法。**

本机 `v22.23.2` 实测：普通 TS 插件动态 import 成功（`probe3-load.mjs` §E）；但只要用到 `enum`，即抛 `SyntaxError code=ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，message 为 `TypeScript enum is not supported in strip-only mode`（`addendum.mjs` §2）。**外部 TS 插件应统一走 `tsx` loader**，避免用户踩"可用语法子集"的坑。

**L-5 插件导出形态沿用 cordis 约定。**

`mod.default ?? mod` 得到 `{name, apply(ctx, config)}`；`probe3-load.mjs` §F 实测动态 import 得到的模块可直接 `ctx.plugin(plugin, config)` 并正常 `dispose()`。

### 2.4 SQLite FTS5 与中文分词（本阶段实证）

> 编号约定：本节 `T-n` = **分词器 / FTS5 的实证事实**（Tokenizer）；第 5 节的 `L-n` = 已知限制，§2.3 的 `L-n` = Loader 事实，三者编号独立，交叉引用时以节号为准。

**取证环境**：`better-sqlite3@13.0.3`（`packages/db-sqlite/package.json` 声明 `^13.0.3`，`pnpm-lock.yaml` 解析为 `13.0.3`），Node `v22.23.2`，取值时刻 `2026-09-10T23:2x +08:00`、HEAD `585dbac`。探针为一次性 `node -e` 脚本（未入库，见下方复现命令）。

**T-1 FTS5 由 `better-sqlite3` 的预编译包直接提供，无需 node-gyp。**

`db.pragma('compile_options')` 返回 **59** 项，其中含 **`ENABLE_FTS5`**；`select sqlite_version()` = **3.53.4**；`CREATE VIRTUAL TABLE … USING fts5(x, tokenize='trigram')` 直接建表成功。**这是"离线 + 零重依赖"成立的前提**——若 FTS5 缺失，就得让用户装编译工具链重新构建原生模块。

**T-2 FTS5 默认的 `unicode61` 分词器把连续 CJK 当成一个 token ⇒ 中文等于搜不到。**

同一段正文（`GeeWiki 是一个插件化知识库系统，支持全文检索与问答。`）下，`MATCH` 加引号短语查询的结果：

| 查询串 | 长度 | `unicode61` 命中 | 原因 |
| --- | --- | --- | --- |
| `"知识库"` | 3 | **0** | 整段 CJK 被切成一个 token，子串不匹配 |
| `"知识"` | 2 | **0** | 同上 |
| `"插件化知识库"` | 6 | **0** | 同上 |
| `"全文检索"` | 4 | **0** | 同上 |
| `"GeeWiki"` | 7 | **1** | 与 token **整体**相同才命中 |

因此**中文检索能否使用完全取决于 `tokenize` 参数**，默认值下"中文等于搜不到"——这是本仓最容易被误传的一点。

**T-3 解药是显式 `tokenize='trigram'`（切 3 字符片段）。**

同一正文、同一批查询改用 `trigram`：

| 查询串 | 长度 | `trigram` 命中 |
| --- | --- | --- |
| `"知识库"` | 3 | **1** |
| `"插件化知识库"` | 6 | **1** |
| `"全文检索"` | 4 | **1** |
| `"gee"` | 3 | **1**（大小写不敏感的子串匹配） |

**T-4 trigram 的硬缺口：查询串短于 3 字符时 `MATCH` 恒为空。**

| 查询串 | 长度 | `trigram` 命中 |
| --- | --- | --- |
| `"知识"` | 2 | **0** |
| `"检索"` | 2 | **0** |
| `"库"` | 1 | **0** |

索引切的是 **3 字符**片段，短于 3 字符的查询（中文 2 字词如「检索」、英文 2 字母）**在 `MATCH` 下恒为空**。⇒ **必须由插件层用 LIKE 兜底**（`@geewiki/search` 的 `mode: 'like'` 路径），且该路径**直接扫 `pages` 真源表而非 `pages_fts`**：短查询本就用不上 trigram 索引（实测 5000 行语料下裸表 3.0 ms vs 经 `pages_fts` 4.0 ms），且在**索引漂移**（迁移未跑全、触发器被删）时短查询仍能给出正确结果——"兜底"就该兜在真正的真源上。

**T-5 索引体积与正文同量级。**

5000 行语料实测（正文合计 **6.23 MB**）：建 `pages_fts`（external content + trigram + `rebuild`）后库文件从 **19.58 MB** 增至 **26.65 MB**，**增量 7.07 MB ≈ 1.14× 正文**。`packages/plugin-search/migrations/0001_search.sql` 内记录的仓库实测为 6.6 MB 语料 +7.9 MB（≈1.2×）；外部资料给出的量级是 1.7× 原文。**结论**：按"与正文同量级"（约 1.1–1.7×）做容量规划，不要按"索引很小"预期。

**T-6 external content + 三条触发器是同步的全部机制，且迁移不写事务。**

`pages_fts(title, content, content='pages', content_rowid='id', tokenize='trigram')` —— 索引**不复制正文**（省一份正文存储），靠 `pages_fts_ai` / `pages_fts_ad` / `pages_fts_au` 三条触发器与 `pages` 表同步（更新是"先 delete 旧值再 insert 新值"两步，缺一不可，否则旧词残留）；末尾 `INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')` 回填存量行。**不写 `BEGIN`/`COMMIT`**：`db.migrate()` 已把每个迁移文件包在单个事务里执行，脚本内再开事务会嵌套报错。全部语句幂等（`IF NOT EXISTS` / `rebuild` 可重放），可安全重跑。

**复现命令**（在仓库根执行，`<bsqlite>` = `node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3` 的 realpath）：

```bash
node -e "const D=require('<bsqlite>');const db=new D(':memory:');
console.log(db.pragma('compile_options').map(r=>r.compile_options).includes('ENABLE_FTS5'));
console.log(db.prepare('select sqlite_version() v').get().v);
for (const tok of ['unicode61','trigram']) { db.exec(\"CREATE VIRTUAL TABLE t_\"
+tok+\" USING fts5(x, tokenize='\"+tok+\"')\"); db.prepare('INSERT INTO t_'+tok+' VALUES(?)')
.run('GeeWiki 是一个插件化知识库系统，支持全文检索与问答。');
for (const q of ['知识库','检索','gee']) console.log(tok, q, db.prepare('SELECT count(*) c FROM t_'+tok+' WHERE t_'+tok+' MATCH ?').get('\"'+q+'\"').c); }"
```

## 3. 已拍板的技术决策

以下决策已经确认，实施时不再重新论证；若需推翻，必须在此处更新并说明理由。

**D-1 配置系统选型：`schemastery@3.18.0`。**
理由：与 koishi/cordis 解耦（不引入 koishi 运行时）、可跨环境序列化 + hydrate、与 cordis 的 standard-schema 对接已被 F-7 证实可用。前端 hydrate 后自行渲染表单，服务端靠 `plugin.Config` 校验。代价是 S-3/S-4 两条：前端必须实现 refs 解析，且不能用载荷做缓存键。

**D-2 热更新路径：`fork.update()`。落盘位置从"必须挂中间件"放宽为"不要求中间件形态，行为等价即可"。（已裁决：接受实现偏离）**
理由：update 是 cordis 唯一的一等公民热更新入口（F-1）；注册在 `fork.ctx`（F-6 证实 root 收不到）且**必须 `return next()`**，这是 F-6 的实证结论，仍然成立。失败必须显式回滚旧配置（F-3 的 `FAILED` + 新 config 状态不可接受）。

**裁决内容（裁决，非推断）**：**不要求**实现必须注册 `internal/update` 中间件。当前实现没有注册该中间件，而是直接 `await fiber.update(config)`，由管理器在 `catch` 里显式回滚。两种形态在本项目关心的行为上**等价**，因此接受该偏离，不为此返工。

**等价性的实测依据**：spike 已实测"apply 抛错 → `update()` 抛错，且 `fork.config` 已被改成新值"，即**失败时进程内配置确实处于"新值"状态**——这正是"必须显式回滚"的由来，与是否挂中间件无关（F-3）。管理器据此在失败分支用旧配置再 `update()` 一次（回落路径见批次 C 的 `updateConfig` 语义第 3 条）。

**采用"先落盘再 `await fiber.update()`"的动因（审查给出的理由，取代中间件方案）**：

- **F-6 记录的最大陷阱是"忘记 `return next()` → 静默吞掉重启"**：中间件形态一旦漏写 `next()`，插件会"看起来更新成功"而实际没重启，属于最难发现的一类静默故障。
- 现方案**先落盘、再 `await fiber.update()`**：落盘失败**同步抛错**，根本走不到 `update()`，因此**不存在"没写盘但插件以为改了"的静默态**——失败是显式、即时、可观测的。
- 管理器自持**盘 / 内存双向回滚**（`update()` 失败 → 用旧配置再 `update()` + 恢复磁盘旧值），覆盖面比"挂在中间件里落盘"**更全**：中间件只兜住 `update` 成功路径上的落盘，兜不住"落盘成功但 `update` 失败"这一半。

> ⚠️ **警告后来者：不要"照着 D-2 去补注册中间件"。** 现实现与中间件方案**不能并存**——一旦补注册 `internal/update` 落盘中间件，就会出现"管理器 `writeList()` 写一次 + 中间件再写一次"的**双写**，写序与失败回滚边界随之失控。D-2 的正确读法是"**行为契约**"（落盘 + 热更新 + 失败双向回滚），不是"实现配方"。

**该行为由行为侧测试兜底，不靠实现形态约定**：批次 C 的 **C-5 一类双向回滚断言**（409 后：进程内配置 = 旧值 **且** 磁盘清单 = 旧值）是该契约的验收口径。换言之，**契约钉在可观测行为上，而不是"有没有中间件"**——后续若有人改成中间件形态，只要 C-5 类断言仍绿即视为合规。

**原子写是必须项，且已满足（撤回上一版"未落地"的标注）**：D-2 的"`.tmp` + `rename` 原子替换"**已内联实现在既有的 `writeList()` 里**（`packages/manager/src/index.ts` 的 `writeList()`：先 `writeFileSync(tmp, …, { flag: 'wx' })` 再 `renameSync(tmp, file)`，临时名带 pid + 随机后缀），并有断言钉住"不留 `.tmp`"（`packages/manager/test/config.test.ts:162`：`assert.equal(existsSync(\`${env.baseFile}.tmp\`), false, '原子写不应留下 .tmp')`）。**只是没有独立成 `packages/manager/src/config-store.ts`**——该文件不再需要新建（见批次 C 文件表）。**结论：原子写保留为必须项，状态=已满足。**

**D-3 外部插件信任模型：进程内动态 `import`，信任边界＝管理员显式安装的本地目录。**
靠**路径守卫**防路径穿越：入口与 migrations 目录必须**经 `realpathSync` 求真实路径后**仍位于插件目录内；不引入子进程沙箱。理由：安全收益不抵 IPC 与状态同步成本——插件需要直接访问 `ctx`（DI 容器、事件总线、DB 服务），跨进程会把"插件即代码"退化成 RPC，且无法复用 cordis 的生命周期与依赖注入。

**守卫按真实路径判定（本轮加固裁决）**：

- 守卫判定改为 **`realpathSync`**，且**根目录与候选路径都要做**。原因：`resolve()` 只做词法规整，不解析符号链接——`plugins/` 内一个指向外部的 symlink 会绕过词法守卫。
- **`plugins/` 自身是 symlink 时不得全量误拒**：根目录也走 `realpathSync` 之后，比较基准是"根的真实路径"与"候选的真实路径"，二者同源，因此把整个插件目录做成 symlink 指向别处（常见于开发期）**不会**导致全部插件被拒。
- **symlink 插件目录不再被静默忽略**：子目录若为 symlink，**是目录则纳入发现**（按真实路径判定是否越界），**不是目录则记一条 issue**，不做无声跳过——与"失败隔离但可观测"的原则一致（配合 L-14）。
- 状态：**本轮加固，代码由修复批落地**；D-3 的旧措辞"`resolve` 后仍在插件目录内"即指上文的词法版本，已按本条更新为真实路径判定。

**D-4 前端插槽：构建期注册 + 运行期 slot；放弃 Module Federation，也不裸加载第三方 bundle。**
- **放弃 Module Federation**：其 singleton 共享存在未修复的多实例缺陷，且引入 `mf-manifest.json` + `remoteEntry.js` 双构建链路过重。
- **不采用 `React.lazy(() => import(url))` 直接加载第三方 bundle**：会导致双 React 实例（hooks 失效）。
- 采用：插件 bundle 把 `react` / `react-dom` / `react/jsx-runtime` 声明为 external；CSS 走 `<link>` 注入；**UI 入口生命周期绑定插件 fork**（fork 卸载即撤销注册与资源）。
- **单例共享机制已修正**：原文写的"宿主用 import map 暴露 react 单例"经勘察**不可行**，改用宿主 `window` SDK。见 **D-8**。

**D-5 配置持久化层级：与启用清单同层。**
插件名出现在 session 清单则配置写 session 文件，否则写 base 文件。理由：保持"配置属于哪一层"与"插件属于哪一层"同一个心智模型，避免出现"session 插件的配置写进 base、disable 后残留脏数据"的状态。

**D-6 PostgreSQL 适配方向：新增异步抽象 `DatabaseAdapterAsync`，不把现有同步 `DatabaseAdapter` 整体改异步。**
理由：现有同步接口的消费点只有 3 处（`packages/plugin-wiki/src/index.ts` 的 `ctx.get('db')`、`packages/server/src/index.ts:355` 健康检查、`packages/manager/src/index.ts:480` 迁移探测），better-sqlite3 的同步优势对现有代码零损耗；整体异步化会把改造成本摊到全部业务代码。驱动选 `pg`；**统一查询层可选 Kysely（尚未落地，标注为"待评估"）**。

**D-7 批次顺序：B 最优先。**
`configSchema` 与 `client` 两个契约不先冻结，批次 C / D 必然返工。

**D-8 前端 Slot 的单例共享：放弃 import map，改用宿主 `window.__GEEWIKI_HOST__` SDK。（修正 D-4 的共享机制）**

D-4 保留全部结论（放弃 Module Federation、不裸加载、external + CSS `<link>` + 生命周期绑定 fork），**只替换"宿主用 import map 暴露单例"这一条实现机制**。

**import map 方案已被勘察证伪**，三条独立理由：

| 编号 | 事实 | 复核点 |
| --- | --- | --- |
| ① | `react@19.2.8` 在磁盘上**没有任何 ESM 文件**。`node_modules/.pnpm/react@19.2.8/node_modules/react/index.js` 是 CJS wrapper（`module.exports = require('./cjs/react.production.js')`）；`package.json` 的 `exports` 只有 `react-server` / `default` 两个条件，**无 `import` / `module` 条件**；`jsx-runtime.js` 与 `react-dom@19.2.8` 的 `client.js` 同样是 CJS | 直接读取上述文件与 `package.json` |
| ② | 宿主构建产物**已经把 react 内联**：`packages/web/dist/assets/index-DyngNpzw.js` 内含字符串 `react.production.js` 与 `react-jsx-runtime.production.js`。现状下**没有可被 import map 复用的单例**；要共享必须把宿主改成 `external: ['react', ...]` 并另行产出 shim chunk，会波及 `@xyflow/react` 与 `packages/web/src/main.tsx`，回归面大 | `grep -c "react.production.js" packages/web/dist/assets/index-DyngNpzw.js`；`packages/web/vite.config.ts` 目前**没有任何** `rollupOptions` / `external` 配置 |
| ③ | dev 模式下 Vite 预构建产物 URL 带 `?v=<hash>`，与宿主实际加载的 URL 不是同一模块实例 → 仍会双 React（表现为 `Invalid hook call`） | Vite dep 预构建既有行为 |

**替代方案（D-8 正题）**：

- 宿主在 `packages/web/src/main.tsx` 顶部初始化一个 host SDK，挂到 `window.__GEEWIKI_HOST__`，暴露 `React`、`ReactDOM`、`jsxRuntime`、`registerSlot`；
- 插件客户端 bundle 仍把 `react` / `react-dom` / `react-dom/client` / `react/jsx-runtime` / `react/jsx-dev-runtime` 设为 external，但 **external 到一个薄 shim 模块**（运行时从 `window.__GEEWIKI_HOST__` 取宿主实例再 re-export）——插件开发者无需感知；
- dev / prod 行为一致，绕开 import map 的全部坑（无 ESM 产物、无 `?v=` 实例分裂、无需改宿主 external 面）。

**插件 UI 资源 URL 的统一约定**（两种模式 URL 完全一致）：

- 后端新增 `/plugins-ui/<name>/client.js` 与 `/plugins-ui/<name>/client.css` 静态路由。注意现有静态托管把 root 锁死在 `webDist`（`packages/server/src/index.ts` 顶层的 `serveStatic(root, req, res)`，其 `root` 由 `HttpPlugin` 插件的 `webDist` 配置项传入），因此插件 UI 资源不能靠现有托管顺带覆盖，必须显式加挂载点；
- dev 模式在 `packages/web/vite.config.ts` 的 proxy（当前仅 `{'/api': 'http://127.0.0.1:3000'}`，见该文件 `:12`）里追加 `'/plugins-ui'` 转发到 `3000`。

> **本批落实情况（重要，勿再按"当时不需要"理解）**：这两条初稿要求在中间某版曾被**判定为"不需要"**（依据是当时资产只来自 `publicDir`），**该裁决已被本批推翻**——引入双资产根（`<插件目录>/dist` 优先）后，资产可能位于 `publicDir` 之外，故**挂载点与 proxy 现在都需要**，实现形态是"按名查根表 + 绝不 SPA fallback"。核对：`packages/web/vite.config.ts:24` 含 `'/plugins-ui'`；`packages/server/src/index.ts` 含 `servePluginUiAsset()`（`:386-434`）与 `/plugins-ui` 分支（`:448-451`）。详见第 9 节"`/plugins-ui` 的托管方式"行。

**插件客户端 bundle 的构建方式**：`plugins/<name>/client/vite.config.ts` 用 `build.lib`（`entry`、`formats: ['es']`、`fileName: 'client'`），并**显式设置 `cssFileName: 'client'`**（Vite 6 单入口时 CSS 默认文件名不稳定），产物落在 `plugins/<name>/dist/client.js` + `client.css`。

**已知风险**：React 单例共享是整个批次 D 的**最高风险点**（双实例 → `Invalid hook call`）。
**最早证伪实验（半小时内可完成）**：用 lib-mode + external 手搭一个 hello bundle，在浏览器里动态 `import()` 它并渲染一个带 hooks 的组件，确认无报错。该实验失败则 D-8 需重做，不应继续投入批次 D 的其余部分。

**证伪实验已执行并通过**（实验代码在 `data/spike/slot-1/`；`data/` 被 `.gitignore:20` 忽略，故本节把结论与复核方式写死在文档里）：

| 标签 | 结论 | 证据（`data/spike/slot-1/` 内相对路径） |
| --- | --- | --- |
| **S-18 变体 A（D-8 薄 shim）可行** | 插件 bundle 用 `resolve.alias` 把 `react` / `react/jsx-runtime` 指向从 `globalThis.__GEEWIKI_HOST__` 取宿主实例再 re-export 的 shim（`plugin/shim/react.js`、`plugin/shim/jsx-runtime.js`），在 dev 与 prod 两种宿主下都渲染成功且 hooks 正常 | `plugin/vite.config.a.ts`；宿主自测输出 `dev3-dom.html` / `r3b-prod-dom.html` 中 `variantA` = `found:true, before:"0", after:"3", hooksWork:true, color:"rgb(1, 2, 3)", borderColor:"rgb(4, 5, 6)"` |
| **S-19 变体 B（import map）在当前仓内也"能跑"** | `external: ['react', 'react/jsx-runtime', ...]` + 宿主 `<head>` 里 import map 指向 `/host-sdk/*.js`，结果与变体 A 完全一致。**因此"import map 不可行"的论据不是"跑不起来"，而是 D-8 表中①②③的产物形态问题（无 ESM 产物、宿主已内联 react、dev 的 `?v=` 实例分裂）** | `plugin/vite.config.b.ts`；`host/index.html`（import map 位于任何 module script 之前，含注释说明该前置要求） |
| **S-20 变体 C（阴性对照）确实能测出双实例** | 插件自带 react（不 alias、不 external）时，模块 `import()` **可以成功**，但在宿主渲染中出现 `TypeError: Cannot read properties of null (reading 'useState')`，栈指向 `plugins-ui/c/client.js:395`，被宿主 ErrorBoundary 接住（`.slot-error` 渲染、`slotCount` 仍为 3），**宿主页面未白屏** | `plugin/vite.config.c.ts`；`r3-cdp3.out.json`（`boundaries:["Cannot read properties of null (reading 'useState')"]`、`found:false`）；完整栈见 `r3-cdp2.out.json` 与 `r3-prod-err.log` |
| **S-21 变体 C 在原始快照里是被 404 掩盖的** | `host/dist/` 里**只有** `plugins-ui/{a,b}`，`host/public/plugins-ui/c/client.js` 未被复制进 `dist`，静态服务器只托管 `dist`，故首次快照中变体 C 因 404 静默缺失（`loaded` 只有 `a`/`b`）。补拷 C 后重跑即复现 S-20。**教训：spike 结论必须核对产物是否真的在服务根下，404 与"没报错"在快照里长得一样** | 对比 `data/spike/slot-1/dev-dom.html`、`prod-dom.html`（无 `variantC` 键）与补拷后的 `r3b-prod-dom.html`、`r3-cdp3.out.json` |
| **S-22 单例的"同一实例"证据链** | 变体 A/B 的插件组件能在宿主渲染中持有 `useState` 状态并跨三次点击稳定累加到 `3`，且 `getComputedStyle` 只可能取到宿主 CSS 的值（`plugins-ui/*/client.css` 只定义颜色，未定义尺寸）；变体 C 在**同一个**宿主渲染路径上直接抛 `useState` 空指针。同一路径、同一测试脚本下"一个成功一个抛错"，即足以区分宿主实例与自带来实例 | `host/src/main.jsx` 的交互自测段（`for (const label of ['variantA','variantB','variantC'])`，点击 `.inc` 三次读 `.count`、再读 `getComputedStyle`）；`r3-cdp3.out.json` 与 `r3-cdp6.out.json` |

**实验条件（可复现命令，均在 `data/spike/slot-1/` 下）**：

- 宿主预构建版：`google-chrome --headless=new --dump-dom http://127.0.0.1:3602/`（`node static.mjs 3602` 托管 `host/dist`）；dev 版为 `host/` 下 `vite` dev server（3601），产物快照 `dev3-dom.html`。
- 交互复验脚本：`r3-cdp.mjs`（只读抓 console / 异常 / 网络失败）、`r3-cdp2.mjs`（直接 `import()` 变体 C 并注册）、`r3-cdp3.mjs`（注册后读 `.count` 与 `.slot-error`）、`r3-cdp4.mjs` / `r3-cdp5.mjs`（实例身份与插槽注册对照）、`r3-cdp6.mjs`（多变体对照 + 404 判别）。输出落在同目录 `r3-cdp*.out.json`；对照快照为 `r3-prod-dom.html`（C 不在服务根下）与 `r3b-prod-dom.html`。
- 宿主 react 版本：`window.__GEEWIKI_HOST__.React.version` = `19.2.8`（`r3-cdp.out.json`）。**插件 bundle 不导出 `version` / 不导出 hooks**（`r3-cdp6.out.json` 的 `version_export.a/b/c` 均为 `undefined`），所以"是不是同一实例"不能靠版本号对比，只能靠上面的渲染行为证据链。
- Vite 版本由仓库根解析：`/root/dev/geewiki/node_modules/.pnpm/vite@6.4.3_@types+node@26.5.0_tsx@4.23.13/node_modules/vite`（slot-1 自身 `node_modules` 只放 `react` / `react-dom` / `vite` 三个包，无独立 vite 版本）。

**S-23 `cssFileName` 的真实作用（修正"产物不稳"的说法）**：已按 `vite@6.4.3` 实测修正——未设 `cssFileName` 时 `build.lib` **不会**把 CSS 丢掉，而是以**就近 `package.json` 的 name** 命名（实验得到 `host/public/plugins-ui/def/geewiki-slot-spike.css`）。风险不在"丢文件"，而在"文件名取决于离产物多近的那个 `package.json`"，在 monorepo 里不可预测。**因此仍要求插件显式写 `cssFileName: 'client'`，把它当命名确定性措施而非"修 bug"。** 复核：`plugin/vite.config.def.mjs`（不设 `cssFileName`）的构建输出为 `geewiki-slot-spike.css`；`plugin/vite.config.a.ts`（设 `cssFileName: 'client'`）输出 `client.css` + `client.js`。

**契约歧义裁决汇总（本轮拍板，均标注"裁决"；复核点写入第 9 节）**

前四项歧义均已裁决。逐条结论落在其本条目下，此处只做索引，避免两处各写一份而漂移：

| 歧义 | 裁决 | 落地位置 |
| --- | --- | --- |
| 清单双来源优先级 | **保持实现、改文档**：`package.json#geewiki` 优先，`geewiki.manifest.json` 兜底；二者同时存在时**整体取前者**（fallback 链，非字段合并） | 批次 B「发现规则」 |
| `layer` 字段语义 | **两个端点分别裁决（勿读成同义）**：`GET /api/plugins/:name/config` 的 `layer` = **持久化层**（对齐 D-5），同端点新增 `activeLayer` = 激活层（未激活 `null`）；`GET /api/plugins` 列表的 `PluginSnapshot.layer` **仍是激活层**，语义不变 | 批次 C「关键契约（端点）」+ 本节"契约歧义裁决汇总" |
| D-2 的 `internal/update` 中间件 | **接受实现偏离**：不要求中间件形态，行为等价即可；由批次 C 的 C-5 类双向回滚断言兜底。**原子写未降级**：已内联在 `writeList()`（`packages/manager/src/index.ts`，临时名带 pid + 随机后缀、`flag: 'wx'` 独占创建），保留为必须项 = 已满足。**警告**：不要再补注册落盘中间件（会双写） | D-2 |
| schemastery `bitset` | **暂保留降级为 JSON 编辑**（未满足 S-13 的多选 + 按位或 number） | 第 5 节 L-13 |

## 4. 分批实施计划

### 批次 B：外部插件加载 + 契约冻结（最优先）

**范围**：从 `./plugins` 目录发现插件、加载模块、校验清单，并与内置注册表合并。

**涉及文件**

| 动作 | 路径 |
| --- | --- |
| 修改（**修正**） | `packages/manager/src/discovery.ts` —— 发现 + 加载 + 校验**全部落在该文件**（228 行）。**不新建 `packages/loader/` 包**：少一个包即少一条构建 / 依赖 / tsx 加载链 |
| 修改 | `packages/server/src/index.ts` —— `defaultRegistry()` 改为「内置条目 + 发现结果合并」（`buildRegistry()`，`:541-553`） |
| 修改（可选） | 根 `package.json` —— 若确需脚本入口再加；当前无 |

**关键契约（修正）**

```ts
loadExternalPlugins(options: DiscoveryOptions): Promise<DiscoveryResult>
// DiscoveryResult = { plugins: RegisteredPlugin[]; issues: DiscoveryIssue[] }
```

实现见 `packages/manager/src/discovery.ts:153`。**修正说明**：本文旧版写的是 `loadExternalPlugins(pluginsDir: string, extraPaths: string[]): Promise<RegisteredPlugin[]>`——**签名与实现不符**：① 参数是单个 options 对象，**没有 `extraPaths`**；② 返回 `{plugins, issues}` 而非裸数组。**返回 issues 是更好的设计**：裸数组会丢掉"哪些插件被跳过、为什么"，而 `issues` 正是可观测性的载体（见第 5 节 L-14）；契约按实现修正，不再要求裸数组。

- **发现规则**：`./plugins/*/` 每个子目录一个插件；清单取目录内 `package.json` 的 `geewiki` 键，或独立的 `geewiki.manifest.json`。
  **优先级已裁决（裁决，非推断）→ 保持实现、改文档**：`package.json` 的 `geewiki` 键**优先**，独立 `geewiki.manifest.json` 仅作**兜底**。
  依据：cordis / koishi 生态惯例就是把插件元数据放在 `package.json`；独立清单是留给"无法或不便改 `package.json`"的插件（如第三方只读目录、纯声明式插件）的退路。
  **两者都存在时的实际行为**（已核对实现与测试）：实现是 **fallback 链而非"合并"**——`packages/manager/src/discovery.ts:77-102` 的 `parsePluginManifest(pkg, standalone)` 先看 `package.json#geewiki` 是否为对象，是则**整体采纳并立即返回**（此时 `geewiki.manifest.json` 完全不参与，即使它存在、即使它字段更全）；只有 `package.json` 缺失或无 `geewiki` 键时才转向独立清单。任一路径下 name 缺失分别抛 `invalid_manifest`（`package.json` 的 `geewiki 清单缺少插件名（package.json.name）` / `geewiki.manifest.json 缺少 name 字段`），两者都没有则抛 `missing_manifest`。
  该优先级已被测试钉住：`packages/manager/test/discovery.test.ts:54`『`parsePluginManifest`：`package.json` 的 `geewiki` 键优先，其次独立 `geewiki.manifest.json`』（配套的缺清单/缺名称断言在同文件 `:74`）。**因此本条不再是开放项，调换优先级属于破坏性变更，需同时改实现与测试。**
- **入口解析顺序**：`geewiki.entry` → `index.ts` → `index.js` → `src/index.ts`（必须解析到具体文件，见 L-3）。
- **name 全局唯一**：与内置注册表及其它外部插件重复 → 告警并跳过（不阻断启动）。
- **路径守卫**：入口文件与 migrations 目录**经 `realpathSync` 求真实路径后**必须在插件目录内（根与候选都做），否则拒绝加载；symlink 子目录是目录则纳入、否则记 issue（D-3）。
- 加载仍走 `pathToFileURL().href` + `import()`（L-1）；TS 插件统一走 `tsx` loader（L-4）；导出取 `mod.default ?? mod`（L-5）。
- **生效方式（修正）**：外部插件**改源码后需重启进程**——同 URL 二次 `import()` 命中模块缓存（L-2 实证），L-6 已声明不做模块实例回收；契约旧文写的"改文件后热重载（`?v=mtime`）"**未实现，也不在本轮范围**。
- **发现期 issues 的上报（已落地，形状已回填）**：发现/加载失败记入 `DiscoveryResult.issues`，并**经由 `GET /api/plugins` 的 `issues` 字段对外可见**（`packages/server/src/index.ts:1008`），形状为 `{ code, dir, message }`（`packages/manager/src/discovery.ts:28-41`），`code` 为八值枚举。完整语义与"为什么这个字段是必要的"见第 5 节 **L-14**。
- **契约冻结内容**：`RegisteredPlugin` 结构、manifest 中 `configSchema` 的承载方式、插件 `client`（前端 UI 入口）字段的声明位置与加载约定。冻结后写入 `@geewiki/core` 类型。

**验证方式**：单元测试（发现规则、入口解析优先级、重名跳过、路径守卫拒绝越界路径、清单缺字段）+ 隔离端口端到端冒烟（起服务、确认外部插件出现在 `GET /api/plugins`、enable 成功）+ **外部插件改源码后的生效方式：重启进程**。

**修正（实测口径）**：本文旧版此处写"改文件后重载生效（`?v=mtime` 路径）"——**该路径未实现，也不在本轮实现**。外部插件改源码后**必须重启进程**：同 URL 二次 `import()` 命中模块缓存（§2.3 L-2 实证），且 L-6 已声明不做模块实例回收。故本批验收不含热重载，`?v=mtime` 仍只是"技术上可行但未接线"的备选路径。

**风险**：清单"双来源"的优先级**已裁决并已有测试覆盖**（`package.json#geewiki` 优先，见上文"发现规则"），剩余风险降级为"文档与实现的措辞漂移"；TS 插件的 loader 依赖 devDependency `tsx`，与生产镜像裁剪 devDependencies 存在张力（见第 5 节 L-3）。

**治理能力设计定稿（设计已定稿、代码未落地）**

以下两项属批次 B 的治理面：**设计已定稿，代码未落地**。它们被写进本批次是为了让实现批"照文档对齐代码"，不需要重新决策。

**G-1 `conflictGroup` 替换交互：`POST /api/plugins/:name/replace`（已落地：提交 `42db76a`；前置校验与前端交互另经 `2227adf` / `b21534a` 收紧）**

请求体：`{ config?: Record<string, unknown> }`（可选，作为目标插件替换激活时的配置）。

| 状态码 | 码值 | 含义 |
| --- | --- | --- |
| 200 | — | `{ok, plugin: PluginSnapshot, replaced: {name, config} \| null, restarted: string[]}`——`replaced` 是被替换（停用）的旧插件，**`replaced: null` 表示未发生替换**（目标已激活的幂等路径，或"无同组冲突"的降级路径），`restarted` 是被级联重启并接回的依赖方列表 |
| 409 | `base_layer` | 基础层（冷操作）拒绝：① 旧插件（被顶替者）真实激活层非 session → 不带 `details`；② 卸载集合内任一成员真实激活层非 session → **带 `details.plugins`**（基础层成员名单） |
| 409 | `provider_mismatch` | **新增错误码**：`requires` 的依赖边原本指向被顶替者，而目标无法承接（按名与 `provides` 都不命中） |
| 409 | `hot_reload_not_supported` | 目标插件不支持热重载 |
| 409 | `hot_dependency_not_supported` | 热链上存在不支持热重载的依赖方 |
| 400 | `load_failed` | 目标插件加载失败 |
| 400 | `migration_failed` | 目标插件迁移失败 |
| 500 | `replace_rollback_failed` | **新增错误码**：回滚（恢复旧插件与依赖方）也失败，需人工介入 |

**`replaced.config` 口径**：取自 `persistedConfigOf(旧插件名)`——即**已落盘的生效配置**（会话条目写了 `config` 就用它；**会话条目存在但没写 `config` 时不构成有效覆盖，回落基础层值**，见 `packages/manager/src/index.ts` 的 `persistedConfigOf()`），**不是**"会话条目里的原始 config 字段"。

⚠️ `replace_rollback_failed` 需要被 `fail()` 认识。**注意本仓库并没有显式的"错误码 → HTTP 状态映射表"**：`packages/manager/src/index.ts` 的 `fail()` 是 **if/else（三元嵌套）条件链**——`not_found`→404、`payload_too_large`→413、`replace_rollback_failed`→500、一组冲突类码（`conflict_group` / `hot_reload_not_supported` / `hot_dependency_not_supported` / **`provider_mismatch`** / `has_dependents` / `base_layer` / `hot_update_failed` / `migration_failed`）→409、其余 400。已落地版本在该条件链里新增 `replace_rollback_failed → 500` 与 `provider_mismatch → 409` 两个分支。**若在别处读到"错误码→HTTP 映射表"的措辞，按本行以条件链为准。**

**流程**：

1. 目标插件**已激活** → 幂等返回（不重复替换）；
2. **无冲突方**（该 `conflictGroup` 内没有其它已激活插件）→ **降级走 `enable`**，不必走替换路径；
3. 否则进入**前置校验**（全部在产生任何副作用之前，故拒绝路径零残留）：热能力校验 = 目标插件支持热重载 + 热链可用；随后**三类拒绝**——
   - ① **旧插件的真实激活层**必须是 session：判据是 `this.plugins.get(conflict)?.layer`（**真实激活层**），**不是 `layerOf()`**。两者语义不同：`layerOf()` 判的是"会话清单里有没有该条目"（它的语义是"配置的**写入**目标层"，别处依赖它）；而"同一插件同时出现在基础层与会话层清单"是本仓库明确支持的**叠加态**（会话层是叠加在基础层之上的覆盖层），此时插件实际以 **base 层**激活，`layerOf()` 会误报 session → 冷插件被热替换、旧插件仍留在基础层清单里、重启后每次启动都撞冲突组互斥。`disable()` 用的也是真实激活层，两处必须一致。非 session → 409 `base_layer`（不带 `details`）；
   - ② **整个卸载集合**（旧插件 ∪ 其活跃传递依赖方）中任一成员的真实激活层不是 session → 409 `base_layer`，**带 `details.plugins`**。含义：位于基础层的**活跃依赖方不可被热卸载**——卸载走 `deactivateCore`（它会**绕过** `disable()` 的 base_layer 守卫直接热卸载），而把依赖方接回时走 `enable()` 落的是**会话层**条目，于是基础层插件的持久化层会被静默改写成 session（此后对它的 `PUT /config` 会写进会话清单）。**拒绝优于"把它热卸载并在会话层重新落盘"**；
   - ③ **提供者覆盖**：新增纯函数 `findUncoveredRequires(registry, replaced, target, names)`（`packages/manager/src/deps.ts`）做校验，`names = [旧插件, ...待接回的依赖方]`——即**目标自身也在校验范围内**。判定：对某插件每个 `requires` token `t`，若 `resolveDependency(registry, t)?.name === replaced`（这条边当前指向被顶替者），则要求目标 `target` 能承接该 token —— 按插件名命中（`target === t`）或按服务标识命中（`target` 的 `provides === t`）；都不满足即违规 → 409 `provider_mismatch`，`details` = `{plugin, token, target, targetProvides, violations}`（`violations` 是全部违规项 `{plugin, token}[]`）。
   - ③′ **目标自洽**（独立一处校验）：目标自身 `requires` 中经 `resolveDependency` 解析后指向被顶替者的 token 也一律拒绝 → 409 `provider_mismatch`，`details` = `{plugin: 目标名, tokens, target, conflict}`。此处**不给"目标恰好 `provides` 同名 token"的豁免**：按名的边仍指向旧插件，目标激活后该依赖恒不满足。
   - **刻意取舍（宁可拒绝也不假报成功）**：依赖方**按具体插件名**依赖被顶替者时必然违规——按名的边无法由新插件承接，正解是依赖方改为依赖**服务标识**（`provides` token，本仓库推荐用法）。该取舍的对外影响就是**这一类替换会被 409 拒绝**，而不是返回 200 却留下无人提供的服务（见 `packages/manager/src/deps.ts` 的 `findUncoveredRequires` 头注释与 `packages/manager/src/index.ts` 的 `replace()` 注释）；
4. 取旧插件的**依赖方传递闭包**——已新增 `packages/manager/src/deps.ts` 的 `collectDependentsClosure(registry, names)`（BFS + visited，环安全，遍历整个注册表取安全超集，调用方与当前活跃集合取交集）：现有 `collectDependents` 只查**直接**反向边，替换场景必须拿到**传递**闭包（否则孙依赖会被留在半激活状态）；
5. 与旧插件合并成待停用集合，按拓扑序**逆序卸载**（依赖方先卸、旧插件后卸）；
6. 激活目标插件（`enableWithDeps` 传入 `skipDeps = {旧插件}`——目标与旧插件往往 `provides` 同一服务，旧插件卸载后若仍被解析为依赖会被重新拉起，进而撞上冲突组互斥）；
7. 按正向拓扑序把依赖方接回新提供者，并记入 `restarted`；失败 → **先防御性卸载目标**（避免半激活污染），再恢复旧插件与依赖方；恢复也失败 → 500 `replace_rollback_failed`；
8. **不是"全程仅一次落盘"**：卸载集合一次 `removeManyFromSession`、目标激活一次、每个接回的依赖方各一次，共 **1 + 1 + N** 次写会话清单（`replace()` 头注释原文："整个过程会多次写会话清单（卸载集合一次 + 目标 + 每个接回的依赖方）"）。每次都是 `writeList()` 的 **tmp + rename 原子替换**，因此任意时刻的清单文件都是自洽的；"失败不留痕"靠"调用前快照 + 回滚成功时写回"保证，而非靠"零落盘"。（**旧版此处写"成功时只写一次 session 清单、失败则零落盘——天然原子"，与实现相反，已按源码改正。**）

> ⚠️ **实现偏离（如实记录，措辞已按源码校准）**：落地版本在失败回滚路径上**做不到"零落盘"**——卸载集合先用一次 `removeManyFromSession` 落盘，随后激活目标与逐个接回依赖方都会各自原子落盘。因此回滚不是"零写"而是"**按调用前的条目顺序与原内容复原会话清单**"：`replace()` 在动手前用 `JSON.parse(JSON.stringify(this.session))` 快照会话清单（`packages/manager/src/index.ts`），回滚全部成功时把这个快照对象整体写回（`this.session = sessionBackup; writeList(...)`）。逐条 `enable` 恢复只会把条目按拓扑序追加回去，与原顺序（用户启用顺序）不一定一致，所以快照写回保证的是**条目顺序与内容**；**但文件格式会规范化**——`writeList()` 恒以 `${JSON.stringify(list, null, 2)}\n` 落盘，若清单文件此前是**人工编辑过的非规范格式**（自定义缩进、字段顺序颠倒、无末尾换行），写回后字节与原文件**不再相同**（语义相同、条目顺序相同）。**因此本文旧措辞"逐字节复原 / 逐字节一致"已降级为"按调用前的条目顺序与原内容复原；文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行"**（审查已用人工编辑的非规范清单复现该反例）。用例『replace：回滚按调用前的条目顺序逐字节复原会话清单（依赖方启用顺序与拓扑序相反时也成立）』（`packages/manager/test/config.test.ts:989`）钉住的是**该用例自己构造的规范格式文件**的前后字节相等（`:1023-1027` 的 `assert.equal(readFileSync(...), sessionBefore)`），不覆盖非规范输入——用例名沿用旧措辞，实际保证以上述准确措辞为准。
>
> 回滚未全部成功时抛 500 `replace_rollback_failed`。**该路径的真实语义（按源码核实）**：回滚循环已按正向激活序逐条尝试 `enable`，且失败项才进 `failures`；走到 500 时**整个卸载集合的会话条目都已从清单消失**——`removeManyFromSession(unloadSet)` 已把旧插件与依赖方整体摘除、目标的条目也已被 `removeFromSession(name)` 摘除，恢复失败的条目没有被重新写回。因此**内存中的 `this.session` 与磁盘上的清单文件始终一致、无分歧**（每次 `addToSession` 都是"改内存 + 立即 `writeList`"），与本文其他位置的"清单可能处于中间态、状态不确定"旧措辞不同：实际是"**已知的确定态：这几条插件不在清单里了**，message 里写明当前真实状态，需人工介入"。**无单测覆盖**：`replace_rollback_failed` 在 `packages/*/test/` 中**零命中**（`grep -rn "replace_rollback_failed" packages/*/test/` 无输出），该分支**仅代码路径 + 人工推演**——构造"回滚本身也失败"需要更细的注入点（例如让恢复期的 `enable` 稳定抛错），本轮未做，**登记为未验证项**。

**裁决**：采用"**级联停用并自动重启依赖方**"而非"有依赖方即拒绝"。理由：拒绝会让用户**永远无法完成同组替换**（同组互斥且真实依赖普遍存在）；而静默断供不可选。**代价已接受**：最坏情况出现 `N × drainTimeout` 的短暂中断（N = 被级联停用的插件数，`drainTimeout` 默认 5 秒）。**前端确认文案必须预告该中断**（让用户在点确认前知道会短暂不可用）——已在 `packages/web/src/pages/AdminPage.tsx:335` 落地。
>
> **后续收紧（`2227adf` / `b21534a`，与上面裁决不冲突）**：本裁决否掉的是"**只要有依赖方就拒绝**"；`2227adf` 新增的是**在依赖方可被安全接管时才允许替换**的前置校验，二者互补而非替代。具体三类拒绝见上文流程第 3 步：① 旧插件真实激活层非 session → 409 `base_layer`；② 卸载集合内任一成员真实激活层非 session → 409 `base_layer`（`details.plugins`）；③ 依赖边指向被顶替者而目标无法承接 → 409 `provider_mismatch`。**依赖方按具体插件名依赖被顶替者属于第 ③ 类，会被 409 拒绝**——这是刻意取舍：按名的边无法由新插件承接，返回 200 会留下无人提供的服务；正解是依赖方改为依赖服务标识（`provides` token）。`b21534a` 则补齐了前端三处如实呈现（短暂中断预告、依赖方按活跃过滤、无替换时的降级文案分叉）。

**G-2 `enable` 回滚作用域缺陷：已确认缺陷 + 已按定稿修法修复（提交 `69cfeb2`）**

**缺陷（已确认，非推断；批次 B 落地后已可达）**：`packages/manager/src/index.ts` 的 `activatedByThisCall` 是**每递归帧局部**的数组（`:655`），`directDependencies` 递归处 `:660` 在 `await this.enable(dep)` 返回**之后**才 push。依赖深度 ≥2 时，孙依赖已经由子帧的 `activateCore` 成功激活并 `addToSession` **落盘**，但子帧返回后该数组即被丢弃 → 目标插件激活失败时，**孙依赖残留（仍处于激活态）且 session 清单已泄漏**。
**可达性**：只看内置插件不可达（内置注册表最大依赖深度为 1）；**批次 B 已落地**，外部插件与内置插件并入同一注册表（`packages/server/src/index.ts` 的 `buildRegistry()`），外部插件即可构造 depth ≥2 的依赖链 → 该路径**现在可达**。详见第 5 节 **L-2**（本处是设计定稿，L-2 是"已知限制"视角）。

**裁决形态（修法已定稿）**：

- 公开 `enable(name, config?)` 只承担**唯一的 try/catch 回滚点**；
- 新增 private `enableInner(name, config, activated)`，**跨递归帧共享同一个 `activated` 数组**；
- 激活成功后**自登记** `activated.push(name)`——**push 序即激活序**，因此回滚时**逆序**遍历天然就是合法的卸载序（依赖方先卸）。

第 5 节 **L-2** 记录同一缺陷（本处是设计定稿，L-2 是"已知限制"视角）。

### 批次 C：配置系统

**范围**：`configSchema` → REST → 前端表单 → 持久化 → 热更新。

**契约迁移已落地（方案甲）——以下是落地前的现状记录，保留以便追溯**

本轮落地前，仓库的 `configSchema` 是 **JSON Schema 风格字面量**，不是 schemastery 实例：

| 复核点（落地前） | 当时的现状 |
| --- | --- |
| `packages/core/src/index.ts:49` | 类型定义为 `configSchema?: Record<string, unknown>`，注释写着"JSON Schema 格式的配置定义与校验" |
| `packages/plugin-wiki/src/index.ts:37` | 字面量 `{ type: 'object', properties: { recentVersions: { type: 'number', title: '版本历史返回条数' } } }` |
| `packages/plugin-echo/src/index.ts:30` | 字面量 `{ type: 'object', properties: { message: { type: 'string', title: 'Echo 消息' } } }` |

这两处用的 `title` 键**在 schemastery 中不存在**（S-10），即当时的字面量与 D-1 选定的 schemastery 载荷不是同一种东西。

**落地后的现状（已按源码核对）**：

| 复核点（落地后） | 当前代码 |
| --- | --- |
| `packages/core/src/index.ts:95` | `configSchema?: ConfigSchema`；`ConfigSchema` 定义在同文件 `:30`：`export type ConfigSchema = ReturnType<typeof Schema.any<any>>`（`:14` 为 `import type Schema from 'schemastery'`） |
| `packages/plugin-wiki/src/index.ts:27-33` / `:50` / `:124` | `WikiConfigSchema = Schema.object({ recentVersions: Schema.number().default(10).min(1).max(100).description('页面详情返回的最近版本历史条数上限') })`；同一实例既作 `manifest.geewiki.configSchema`（`:50`），也作插件模块的 `Config`（`:124`） |
| `packages/plugin-echo/src/index.ts:22-26` / `:42` / `:50` | `EchoConfigSchema = Schema.object({ message: Schema.string().default('hello from @geewiki/echo').description('GET /api/echo 返回的消息内容') })`；同样双用（`:42` 与 `:50`） |

**迁移决策（已采纳方案甲，未采纳方案乙）**：

- **方案甲（推荐并已落地）**：把 `packages/core` 的 `configSchema` 类型改为 schemastery `Schema`，并同步改写 `packages/plugin-wiki` / `packages/plugin-echo` 这两个内置插件。
  理由：**最简单**——两个都是自带插件，改写成本可控，且与 D-1（schemastery 选型）和 F-7（`plugin.Config` 自动校验）一致，不存在双轨维护。
  **破坏性影响**（均已处理）：① `packages/core/src/index.ts` 的类型变更；② 上述两个插件 `configSchema` 字面量改写为 `Schema.object({...})`；③ 需要**下行载荷剥离逻辑**（剥离 `callback` / `preserve`、降级 `transform`，见 S-8），落在 `sanitizeSchemaPayload()`。
- **方案乙（未采纳）**：双轨兼容（同时接受字面量与 `Schema`）。代价是双份渲染路径 + 双份校验语义，需另外定义"如何区分两者"。
- **兼容保留**：旧式 JSON Schema 字面量在运行期仍被视作"无 schema"（跳过结构化校验、只提供 JSON 编辑并打印一次告警），因此历史清单不会因这次迁移而失效。

**涉及文件（已落地，行号为核对后的当前位置）**

| 动作 | 路径 |
| --- | --- |
| 修改（方案甲，已落地） | `packages/core/src/index.ts:30` + `:95` —— `ConfigSchema` 类型与 `configSchema?: ConfigSchema`（**行号已按当前 HEAD 更正**：本批新增 `client?: GeeWikiClient` 后 `configSchema` 由 `:72` 移到 `:95`） |
| 修改（方案甲，已落地） | `packages/plugin-wiki/src/index.ts:27-33` / `packages/plugin-echo/src/index.ts:22-26` —— 字面量改写为 `Schema.object({...})` |
| 修改（**修正**，已落地） | `packages/manager/src/index.ts` —— `updateConfig` + 两个 REST 端点（注册在 `:1458` / `:1467`；**行号已按当前 HEAD 更正**，旧稿写 `:1126` / `:1135`）；`snapshotOf` 携带 schema（**下发前剥离 `callback` / `preserve`，见 S-8**）。**原子写落在既有 `writeList()` 内**（`packages/manager/src/index.ts` 的 `writeList()` 已内联 `.tmp` + `renameSync`），**未新建 `packages/manager/src/config-store.ts`** |
| 修改（已落地） | `packages/web/src/api.ts` —— 配置读写客户端（`getPluginConfig` 走 `GET`、`updatePluginConfig` 走 `PUT`，见 `:180-182`） |
| 新建（已落地） | 配置表单组件：`packages/web/src/components/SchemaForm.tsx` + 载荷解析 `packages/web/src/lib/configSchema.ts`（按 S-7…S-17 解析 refs 图渲染控件；**只渲染、不 hydrate**） |
| 修改（已落地） | `packages/web/src/pages/AdminPage.tsx` —— 有 schema 插件走 SchemaForm，无 schema 插件保留 JSON 原文编辑 |
| 修改（已落地） | `packages/core/package.json` / `packages/manager/package.json` / `packages/plugin-wiki/package.json` / `packages/plugin-echo/package.json` —— 均声明 `"schemastery": "3.18.0"`（此前工作区没有该依赖，见第 2.2 节 S-7…S-17 前提说明） |

**关键契约（端点）**

| 端点 | 成功 | 失败 |
| --- | --- | --- |
| `GET /api/plugins/:name/config` | `{ok, name, layer, activeLayer, config, schema}`：`layer` = **持久化层**，`activeLayer` = 激活层（未激活 `null`） | 404 插件不存在 |
| `PUT /api/plugins/:name/config` | 200 `{ok, config, hotUpdated, requiresRestart?}` | 400 `invalid_config`（附 schemastery 逐条错误）/ 400 `config_not_supported`（**不再由该路径产出**——`packages/manager/src` 中已无该错误码的抛出点；无 schema 插件改走"JSON 原文"通道，形状非法时抛 `invalid_config`）/ 409 `hot_update_failed`（返回**已回滚**的配置） |

> **路径里的插件名必须 URL 编码**：`:name` 只占**单个路径段**——路由层先按 `/` 切分、再逐段 `decodeURIComponent`（`packages/server/src/index.ts` 的路由匹配），因此 `GET /api/plugins/@geewiki/wiki/config` 会被切成 5 段而落 `404 not_found`，必须写成 `GET /api/plugins/%40geewiki%2Fwiki/config`（即 `encodeURIComponent(name)`）。包名含 `/` 的插件在 UI 上无影响（前端客户端已统一编码，见批次 C 文件表的 `packages/web/src/api.ts`），但 curl / CLI 手工调用会踩。

**`layer` 字段语义已裁决（区分两个端点，勿读成两处同义）**

- **`GET /api/plugins/:name/config` 的 `layer` ＝ 持久化层**（本轮最终裁决，对齐 D-5）：它回答的是"**这份配置存在哪、重启后是否生效**"，取值为 `'base' | 'session'`——载体即 `config/plugins.base.json` / `config/plugins.session.json` 两个物理文件。**实现口径（已按源码校正，见本节末尾的"行号更正"）**：`configOf()` 的 `layer` 取自 `effectiveConfigLayerOf(name)`（`packages/manager/src/index.ts` 的 `effectiveConfigLayerOf()`，调用点在同一文件的 `configOf()`）：它按"**这份生效配置实际取自哪一层**"计算——会话条目**没写 `config`** 时即下沉到 `base`（会话层是叠加层，条目存在但没有 `config` 不构成有效覆盖；叠加失败的场景另有回落判定）。落盘写入层则另由 `layerOf(name)` 与 `persistConfig(name, config, layer)` 决定（两者同在 `packages/manager/src/index.ts` 内，紧跟 `updateConfig()` 之后）。
- 同端点**新增 `activeLayer`** 表达激活层（该插件当前从哪一层被激活；**未激活为 `null`**）。**已落地并核对**：`Manager.configOf()` 的返回类型即 `{ name, layer: Layer, activeLayer: Layer | null, config, schema }`（`packages/manager/src/index.ts` 的 `configOf()`，赋值为 `activeLayer: managed?.layer ?? null`）。注意与列表端点的类型差异：这里的 `layer` **非空**（从未持久化时落 `'base'`），而 `PluginSnapshot.layer` 可为 `null`。即 `GET /api/plugins/:name/config` 返回 `{ ok, name, layer, activeLayer, config, schema }`，两个维度分开表达，不再让一个字段兼两义。
- **`GET /api/plugins` 列表里的 `PluginSnapshot.layer` 语义不变，仍是激活层**（`layer: Layer | null`，声明在 `packages/manager/src/index.ts` 的 `PluginSnapshot` 接口，赋值在 `snapshotOf()` 的 `layer: p?.layer ?? null`）。**注意不要误把这条改动套到列表上**：UI 的徽标与操作分支正是读列表里的这个字段（`packages/web/src/pages/AdminPage.tsx` 按 `layer` 显示徽标 `badge-${p.layer}`、并按 `p.layer === 'session' | 'base'` 渲染不同操作），改其语义会连带改前端。
- 曾把两个端点写成同一个"激活层"口径，属**歧义**，本版已按上面两条收敛：**配置端点看持久化层（+ `activeLayer`），列表端点看激活层。**

`updateConfig` 语义：

1. 插件**未激活** → 只落盘（写对应层级文件，D-5），返回 `requiresRestart: true`；
2. 插件**已激活** → 校验（`plugin.Config` / schemastery）→ 落盘 → `fork.update(newConfig)`；
3. 任一步失败 → 回滚进程内配置（必要时按 F-3 用旧配置再 `update()`）并返回 409，**落盘也需回滚或用临时文件提交**，避免"盘上是新的、进程是旧的"。

**`requiresRestart?` 字段状态（已落地，保留契约字段名）**：该字段**已实现**——`packages/manager/src/index.ts` 的 `updateConfig()` 返回类型即 `{ config, hotUpdated, requiresRestart }`；插件未激活（或运行期无热更新能力）时走"仅落盘"分支、提前返回 `{ config, hotUpdated: false, requiresRestart: true }`，`fiber.update()` 成功后在方法末尾返回 `{ config, hotUpdated: true, requiresRestart: false }`。**文档须注明二者会同时出现**：响应里 `hotUpdated: false` **与** `requiresRestart: true` 是**同一情形的一对表达**（插件未激活 → 只落盘不热更新 → 需重启进程生效），前端据此提示"已保存，重启后生效"。不要把它读成两个独立开关或互斥状态。

**`400 config_not_supported` 的去向（配合 `docs/architecture.md` §5.7 的收敛）**：该错误码**不再由任何代码路径产出**——`packages/manager/src` 中已无 `config_not_supported` 抛出点（`fail()` 只按具体错误码分派 HTTP 状态码，未列举的码一律 400，并不存在一张显式的"错误码映射表"）；无 schema 插件改为接受原始 JSON（不校验、不裁剪），仅在形状不是 JSON 对象时抛 `invalid_config`，详见 `docs/architecture.md` §5.7。

**验证方式**：单测（原子写、层级选择、校验失败、回滚、**双向回滚断言见下条 C-5**）+ 端到端（改配置 → 观察插件行为变化 → 重启后配置仍在）+ 未激活插件改配置只落盘（热更新不触发）。

**必须新增的测试 C-5（双向回滚断言——D-2 裁决的唯一验收依据）**：`PUT /api/plugins/:name/config` 触发 `fork.update()` 失败时，断言 **409 且"进程内配置 = 旧值"同时"磁盘清单 = 旧值"**。说明：本文多处引用的 "C-5" 是**本用例的描述性编号**（此前文档未定义该编号），落地时实现语义不可缩减，编号本身可调整。它兜住的是 D-2"不要求中间件形态、行为等价即可"这一裁决——**契约钉在可观测行为上，不钉在实现形态上**。

**风险**：F-5 的连带重启意味着"改一个 provider 的配置 = 重启它和它的全部依赖者"，需要在前端明确提示影响面；F-6 的"忘记 `next()` 静默失效"必须有测试覆盖。

### 批次 D：前端 Slot（依赖批次 B 冻结的 `client` 契约）

**范围**：插件向 Web 管理台贡献 UI。

**涉及文件（已落地，按实现核对；与初稿的差异已在"动作"列标出）**

| 动作 | 路径 |
| --- | --- |
| 新建（已落地） | `packages/web/src/lib/slots.tsx` —— `registerSlot` / `unregisterSlot` / `SlotOutlet`（`SlotOutlet` 外包 `SlotErrorBoundary`）；插槽名 `export type SlotName = 'app-header' \| 'app-footer'`，白名单常量 `SLOT_NAMES` |
| 新建（已落地，**文件名与初稿不同**） | `packages/web/src/lib/hostSdk.ts`（初稿写 `host-sdk.ts`）—— 宿主 SDK 初始化，挂 `window.__GEEWIKI_HOST__`（`React` / `jsxRuntime` / `registerSlot` / `unregisterSlot` / `version`），`HOST_SDK_VERSION = '0.1.0'`，见 D-8 |
| 新建（已落地） | 插件侧 react external 的**薄 shim 模块**：`packages/web/public/host-sdk/react.js` 与 `packages/web/public/host-sdk/jsx-runtime.js`（从 `window.__GEEWIKI_HOST__` 取宿主实例再 re-export，见 D-8） |
| 新建（已落地） | entry 动态加载器 = `packages/web/src/lib/pluginUi.ts`（不接触 DOM 的纯函数部分拆到 `packages/web/src/lib/pluginUiPlan.ts`，故可用 `node --test` 单测）→ 拉 `GET /api/plugins/ui` **后端下发的入口表**（带 `If-None-Match`，命中 304 即零动作）→ 按 `revision` / `rev` 差集先卸后装 → `await import(pluginUiBase(name) + '/' + entry)` → 调用模块导出的 `register(host)`（或 default）。**不再读静态 JSON `/plugins-ui/registry.json`，也不再自行拿 `GET /api/plugins` 的 `state` 与表对齐**（那是竞态源：两次请求之间插件状态可能变化，"表里有、列表里没"会被误判成卸载） |
| 修改（已落地） | `packages/web/src/main.tsx` —— 首个导入即 `import './lib/hostSdk'`（必须早于 shim 模块求值，见 `:1-3`），并在 `:21` 调 `startPluginUiSync()`（立即同步一次 + `visibilitychange` + 15s 可见期轮询）；旧入口 `refreshPluginUi()` 保留但已等价于 `syncPluginUi()` |
| 修改（已落地，**与初稿相反**） | `packages/web/index.html` —— **确实引入了 import map**（head 的第一个元素），但只映射 `react` 与 `react/jsx-runtime` 到 `/host-sdk/*.js`，**刻意不映射 `react-dom` / `react-dom/client`**（插件不得自带框架）。`packages/web/vite.config.ts` 的 `server.proxy` **已追加** `'/plugins-ui'` → 后端（见下方 L-502 的改写） |
| 修改（已落地） | `packages/web/src/App.tsx`（`app-header` 插槽注入点，见 `:58`）与 `packages/web/src/pages/AdminPage.tsx`——后者的 `load()`（`:83`）是**唯一集成点**：它是四条变更成功路径（act / confirmEnable / doReplace / saveConfig）的汇聚点，故只在该处 `void syncPluginUi()` 即可让插槽跟随启停 |
| **已落地（初稿判定"不需要"，现已推翻，见第 9 节）** | `packages/server/src/index.ts` 新增 `/plugins-ui/<插件名>/<相对路径>` 静态分支（入口/样式单段，其它资源可嵌套子目录）（`servePluginUiAsset`，按名查根、**绝不 SPA fallback**）。**不能只靠 `publicDir`**：插件 UI 资产有**双根**，第一优先根是 `<插件目录>/dist`（外部插件自带产物，Docker 里 `plugins/` 是 bind mount），位于 `packages/web/public/` **之外** → 因此**既需要** `packages/web/vite.config.ts` 的 `'/plugins-ui'` proxy（dev），**也需要**后端按名查根的挂载分支（prod）。`/host-sdk/**` 仍来自 `packages/web/public/`（`publicDir`）不变 |
| 新建（已落地，**位置与初稿不同**） | 插件客户端 bundle 的构建配置在 **`packages/web/fixtures/vite.config.ts`**（`build.lib`：`entry` / `formats: ['es']` / `fileName: 'client'` / **显式 `cssFileName: 'client'`**），示例插件 UI 源码在 `packages/web/fixtures/src/`，默认产物落 `packages/web/public/plugins-ui/<FIXTURE_OUT>/`；`FIXTURE_OUT_DIR` 可覆盖输出目录，`build:fixtures` 的第二遍用它把 hello 夹具产物直接落到 **`plugins/hello-geewiki/dist/`**（演示"插件自带产物根"）。初稿写 `plugins/<name>/client/vite.config.ts`，与此不同 |

**入口表与产物生成**（本段已按本轮落地改写）：**入口表不再是生成物**——旧的静态 JSON `packages/web/public/plugins-ui/registry.json` **已停用**，`build:fixtures` 也不再生成它；入口表改由 `GET /api/plugins/ui` 每请求从活状态现算（`GeeWikiManager.uiTable()` → `buildPluginUiTable`）。

`pnpm --filter @geewiki/web run build:fixtures` 现在做三件事：① **先 `rm -rf public/plugins-ui` 全清**（旧生成物残留正是"入口表说就绪、资产却 404"的成因，故不做增量）；② 构建默认 fixture → `packages/web/public/plugins-ui/@geewiki/wiki/`（该插件是基础层必然激活项，无需改动状态即可看到插槽）；③ 以 `FIXTURE_OUT=@geewiki-plugin/hello FIXTURE_OUT_DIR=../../../plugins/hello-geewiki/dist` 再构建一遍 → 产物落 **`plugins/hello-geewiki/dist/`**，演示"插件自带产物根"优先于 `<webDist>/plugins-ui/<名>` 这条双根链路。该目录**已被 `.gitignore` 排除**，且**不在 `pnpm build` 内**（`packages/web/package.json` 的 `build` 只是 `vite build`）——因此新克隆的仓库需先单独跑一次 `build:fixtures`，否则管理台上不会有示例插件 UI；此时宿主不会报错，只是入口表把这些插件记入 `skipped: entry_missing`（**这正是 `entry_missing` 作为"产物缺失唯一可见出口"的用途**）。注意 `plugins/hello-geewiki/` 是**后端零依赖插件示例**，自本轮起它**同时携带前端 UI 产物**（`geewiki.client` 已声明 + `build:fixtures` 把产物写进它的 `dist/`）。

**资产根配置拆分（提交 `88e0c58`，本节追加）**：上文与本批次其余段落里写的第二候选根 `<webDist>/plugins-ui/<名>`，其"内置根"**现已由独立配置项指定**——环境变量 **`GEEWIKI_PLUGIN_UI_DIST`** / `ServerOptions.pluginUiDist`（`packages/server/src/index.ts:607-614` 类型、`:723-734` 读取，`packages/manager/src/index.ts:307` 与 `:333` 消费），且**缺省 = `webDist`**（prod 与既有行为完全不变）。按新口径读作 `<pluginUiDist>/plugins-ui/<名>`。**拆分的动因是一次 dev 回归**：上一批为让插件 UI 免构建可用，把根 `package.json` 的 `dev` 脚本设为 `GEEWIKI_WEB_DIST=packages/web/public`，而该目录只有 `host-sdk/` 与 `plugins-ui/`、**没有 `index.html`** → app shell 的静态层与 SPA fallback 都取不到文件 → `curl :3000/` **404**（此前 200）。因此 `webDist` 恢复"只指前端产物根"的原语义，`pnpm dev` 改设 `GEEWIKI_PLUGIN_UI_DIST=packages/web/public`（`dev:server` / `start` 不动）。**双根优先级与 `resolvePluginUiHit` 作为唯一实现的不变式未改动**，改的只是"喂给它的内置根是哪个"。**红-绿**：变异"把交给 `buildRegistry` 的 `webDist` 换成 `pluginUiDist`"→ 首页断言红；关变异 → 绿；入库回归 2 例（分离后各司其职 / 未配置时回落 `webDist`）。**遗留**：`packages/manager/src/plugin-ui.ts` 的 `buildPluginUiTable` / `pluginUiRootsFor` / `resolvePluginUiHit` 形参**仍叫 `webDist`**（改名未做），语义是"第二候选根的内置根"。

**关键契约**：插槽名当前**只有 `app-header` / `app-footer`**（白名单；未在名单内的名字 `console.warn` 后忽略——初稿写的 `admin-page-slots` / `header-slots` **未提供**）；UI 入口 bundle 的 external 约定（D-4）与宿主实例来源（D-8）按"import map + 薄 shim"落地；`registerSlot(name, component)` 返回幂等的撤销函数；`pluginUiBase(name)` 先做路径段校验（1 段非 scope 名，或 2 段且首段为 `@` 开头的 scope 名；段内拒绝 `.` / `..` / 分隔符 / 空白与控制字符）再把插件名映射为**同源绝对 URL** `/plugins-ui/<name>`（**不带结尾斜杠、不带任何 query**）；**插件名不做 URL 编码**（`@geewiki/wiki` 就是两个路径段），编码名一律 404。

> **修正（本批，2026-09-14）**：本段首句"插槽名当前**只有 `app-header` / `app-footer`**"**已作废**，上表里两行的旧值同步过时（`packages/web/src/lib/slots.tsx` 行写死的 `SlotName = 'app-header' | 'app-footer'`、`hostSdk.ts` 行写死的 `HOST_SDK_VERSION = '0.1.0'`）。按代码更正：
>
> - **白名单现为 5 个**：`app-header` / `app-footer` / `editor` / `editor-toolbar` / `wiki-ask`。真源 `packages/core/src/index.ts:797`，基数表 `packages/core/src/index.ts:821`（`app-header` / `app-footer` / `editor-toolbar` = `multi`，`editor` / `wiki-ask` = `single`）。**`editor` 不是本批加的**——它随提交 `084dab4` 落地（该提交同时落地 `ctx.slot()` 契约，即本篇此前登记的"未落地"项），本批在它之上补 `editor-toolbar`（叠加位：内置编辑器在场时可用）与 `wiki-ask`（单占用面板位）。
> - **零属性裁决未被推翻**：只有 `app-header` / `app-footer` 保持零属性（`ZeroPropsSlotName`）；新插槽走**具名窄契约** props——`EditorToolbarSlotProps`（`packages/core/src/index.ts:887`：`mode` / `slug` / `docText` / `selection` / `readOnly?` / **可选** `insertAtCursor?` / `replaceSelection?`）与 `WikiAskSlotProps`（`:910`：`query` / `onAsk` / `openPage`）。两个"写回通道"是**可选方法而不是永远存在的空函数**——内置编辑器不在场时宿主不给，插件必须按"可能不存在"写（守卫用例 `packages/web/test/slotPropsMirror.test.ts` 的『EditorToolbarSlotProps：写回通道是可选方法（不是永远存在的空函数）』钉住）。
> - **镜像是必需的，不是选择**：浏览器侧不能 `import '@geewiki/core'`（core 顶层 `import 'node:fs'` 进不了浏览器 bundle），故 `packages/web/src/lib/slots.tsx:49` 是手工镜像；两端一致性由**源级守卫**钉住：`packages/manager/test/slots.test.ts` 用正则解析 `slots.tsx` 里的 `SLOT_NAMES` 字面量并与 core 逐元素比对（解析失败即红，不允许静默通过），`packages/web/test/slotPropsMirror.test.ts` 再比对 **core / `slots.tsx` / `pluginUiPlan.ts` 三处**（含顺序）、比对 `SINGLE_OCCUPANCY_SLOTS` 与 `SLOT_CARDINALITY` 的单占用集合、并逐字段比对 props 的字段名/可选性/`readonly`。**新增插槽必须同时改这三处**，否则守卫红。
> - **宿主 SDK 版本 `0.1.0` → `0.2.0`**（`packages/web/src/lib/hostSdk.ts:22`），新增成员 `renderMarkdown(markdown: string): string`（`:43`，实现即宿主那条消毒管线 `mdToHtml`，`:62`；`PluginUiHost` 侧的转发在 `packages/web/src/lib/pluginUi.ts:62` 与 `:435`）。**为什么这是宿主能力而不是插件自带**：消毒白名单是安全边界，一份实现才有审计点。**插件侧必须特性探测**（`typeof host.renderMarkdown === 'function'`）而不是比版本字符串——老宿主上没有这个函数，退化路径是"显示纯文本"而非抛错（`hostSdk.ts:18-19` 明文）。**⚠️ 命名更正**：`docs/design/ai-plugin-split.md` §4.4 写的 `host.markdownToHtml(md)` 落地时叫 **`renderMarkdown`**，以源码为准。
> - **懒加载判据从"slots 全为 editor"推广为"slots ⊆ ON_DEMAND_SLOTS"**：`ON_DEMAND_SLOTS = ['editor', 'editor-toolbar', 'wiki-ask']`（`packages/web/src/lib/pluginUiPlan.ts:110`），判据 `isLazyOnlyEntry()` 在 `:135`。**已知边界（本批范围外发现，已上报）**：manifest 只能声明 `slots: SlotName[]`，**表达不了"某个插槽贡献是懒的"**——`SlotContributionMeta.lazy` 只在运行期 `contribute()` 时可用，而运行期 contribute 本身要求先加载 bundle，对懒加载是循环依赖；故"既贡献 header 又懒贡献 editor"这类插件今天只能整包不推迟，真正的解法是让清单/入口表带上 per-slot 的 lazy 标志（需改 core 契约）。**一条实测踩过的配套要求**：进入编辑视图必须**同时**拉起两个按需插槽——`packages/web/src/pages/WikiPage.tsx:2371` 的 `ensureSlotLoaded('editor')` 与 `:2375` 的 `ensureSlotLoaded('editor-toolbar')`；只拉前者时工具条**静默空白**，而管理台侧一切看起来正常（无 404、无 console error），是本项目最难查的一类"看着没问题"。
> - **"该不该显示某个功能的入口"新增唯一正确判据** `pluginUiDeclaredFor(slot)`（`packages/web/src/lib/pluginUi.ts:190`，文档注释在 `:176-189`）。两条看起来更直接的判据都错：① 用"已注册的插槽组件"判 ⇒ **自锁**（懒加载插槽的组件只在进入视图后才加载，而入口按钮要在进入之前出现）——**本批实测踩过**：列表页的「AI 问答」入口恒不渲染；② 用 `GET /api/plugins` 的激活态 + 硬编码插件名判 ⇒ 把功能归属写死在宿主里，换名/换实现/第三方接管都会让入口静默错位（这正是 `packages/web/src/pages/WikiPage.tsx` 旧版 `stateOf('@geewiki/ai')` 的做法，本批删除）。入口表的 `slots` 字段是**后端仲裁后的生效集**（被抑制的单占用声明者不在其中），故它恰好回答"点进去之后真的有人渲染面板吗"。宿主侧四态选择（面板 / 载入中 / 加载失败 / 没有功能）由 `useWikiAskSlotState()`（`packages/web/src/lib/slots.tsx:434`，三源合一：`entry` / `failures` / `declared`）完成。

**入口表契约（本批冻结，逐条对齐源码）**：manifest 侧新增 `geewiki.client?: { entry?: string; css?: string }`（类型 `GeeWikiClient`，`packages/core/src/index.ts:53-61`；`GeeWikiMeta.client` 在 `:87`）——`entry` / `css` 都是**单段文件名**（匹配 `PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`），`entry` 缺省 `client.js`，声明非法时**整体视为未声明**（不抛错）；**未声明 `client` 的插件永不进入口表**。**注意 `geewiki.entry` 是后端入口、`client` 是前端入口，两者不可混用**（`packages/core/src/index.ts:51` 明文）。端点 `GET /api/plugins/ui` 响应 `{ ok, version: 1, revision, plugins: Record<插件名, { entry, css?, rev }>, skipped: [{ name, reason }] }`，`reason ∈ 'inactive' | 'no_client' | 'entry_missing' | 'invalid_name'`（互斥，每插件至多一条，按 name 排序）；`revision` 是对 `{ version, plugins }` 求 sha1 的前 12 位（**`skipped` 不参与**，`plugins` 按键排序，故与注册表顺序无关），`rev` 是入口（与样式，若有）`${mtimeMs}-${size}` 拼接入 sha1 的前 8 位（**只 stat 不读内容**）。响应头 `cache-control: no-store` + `ETag`，`If-None-Match` 命中 → **304**（实现只做"剥离可选 `W/` 与前后引号后全等比较"，**不做 RFC 7232 的列表/通配符解析**——这是刻意的简化，已在 `packages/manager/src/index.ts:1431-1432` 注释写明）；**空表仍 200，永不 404**。资产 URL 为 `/plugins-ui/<插件名>/<相对路径>`（入口/样式仍单段；**其它资源可嵌套子目录**，上限 `PLUGIN_UI_ASSET_MAX_DEPTH = 16`），静态层**绝不 SPA fallback**（缺失即 404 `application/json`）。

**验证方式**：单测（注册/撤销、ErrorBoundary 兜底、入口表纯函数与端点、静态层正负例）+ 浏览器端到端 + **单例证伪实验**（见 D-8 与下方风险）。初稿此处曾写"**但"插件卸下后 UI 自动消失"这一条无法验收**——该行为没有接线"：**该结论已过时**，本轮已接线（`AdminPage.load()` + `startPluginUiSync()`），并由入库的 CDP 验收脚本 `scripts/acceptance/plugin-ui-cdp.mjs` 在 dev 与 prod 两模式下实测（管理台启用 hello → UI 与 `<link>` 出现 → 停用 → 两者同时消失且计数回落）。

**风险（已按实现更新）**：**React 单例共享仍是本批次最高风险点**（双实例 → `Invalid hook call`）。D-8 的证伪实验**已通过**（见第 3 节 S-18…S-22，实验代码在 `data/spike/slot-1/`），且**现已接入 `packages/web` 真实宿主**（`index.html` 的 import map + `packages/web/src/lib/hostSdk.ts` + `public/host-sdk/*.js` shim + `packages/web/src/lib/pluginUi.ts` 加载器 + `packages/web/fixtures/` 的两份示例 bundle）——初稿此处"尚未在真实宿主上接入"已过时。**仍然成立的风险**：

1. ~~**未绑定 fork 生命周期**~~ → **已落地（本轮）**：初稿写"加载/刷新入口是手动 `window.__GEEWIKI_PLUGIN_UI__.refresh()`，插件停用/热更新**不会**自动刷新或撤销其 UI"。现状：该行为已接线——`syncPluginUi()`（幂等 + 单飞）由管理台 `AdminPage` 的 `load()`（变更成功路径汇聚点）+ `visibilitychange` + 15s 可见期轮询三条触发点驱动，`startPluginUiSync()` 在 `main.tsx:21` 启动；卸载会执行 disposers、移除 `<link data-plugin-ui=…>`，并以 `epoch` 防止"卸载后又被在途 import 复活"。**UI 随插件启停自动出现/消失**（管理台动作即时，外部变更如看门狗回滚 / CLI / 其它标签页 ≤15s）。行号更正：旧文引的 `pluginUi.ts:262-267` 已不存在（现为 `:216-223` 的 `syncPluginUi` 与 `:292-310` 的 `startPluginUiSync`）；调试入口 `window.__GEEWIKI_PLUGIN_UI__` 现为 `refresh / sync / unload / loaded / revision / base`（保留 `refresh` 以免破坏既有排障习惯）；
2. **ESM 模块实例不回收**（**仍是决策，不是待办**）：卸载只做"注销插槽注册 + 移除插件 CSS"，已 import 的模块留在模块图中（`packages/web/src/lib/pluginUi.ts:36-41` 已把它写成"已知边界（决策，不是待办）"，与 L-6 同源）。因此 `rev` 变化走 unload → load 后**同一 URL 命中模块缓存**——**插件产物更新后需整页刷新才生效**；未更新时重新 enable 会复用同一实例（`register` 重跑、不累积实例）；
3. **插件 CSS 全局注入**：以 `<link data-plugin-ui=…>` 挂进文档，v1 **不做样式隔离**（无 Shadow DOM、无前缀改写）。示例夹具以 `.gw-fixture-*` 前缀命名类名（`packages/web/fixtures/src/style.css`）作为**约定示范**，宿主侧**无强制手段**（仓库中不存在强制插件加前缀或禁用 `!important` 的机制）；
4. 插件 client bundle 仍应显式写 `cssFileName: 'client'`，理由是命名确定性而非"否则丢 CSS"（见 S-23）；
5. **入口/样式是单段文件名，其它产物资源可以是子目录**（**已落地，推翻本行旧结论**）：`entry` / `css` 必须匹配 `PLUGIN_UI_FILE_SEGMENT`（**刻意不放宽**），但 `plugins/<name>/dist` 里的**子目录资源（字体 / 图片 / 代码分割 chunk）现已支持**——走 `PLUGIN_UI_ASSET_PATH`（`packages/core/src/index.ts`）+ `PLUGIN_UI_ASSET_MAX_DEPTH = 16`，静态层做四层防护（精确查根表 / 形态与段数校验 / **段比较**包含判定 `isContained()` / `realpath` 挡符号链接逃逸），未知扩展名一律 `application/octet-stream`。故**不再需要**把资源内联进 bundle。**仍未做**：入口完整性 / 签名校验与版本协商（`packages/web/src/lib/pluginUi.ts:41`）。旧文引的源码 TODO `pluginUi.ts:27-30` 三项（入口表改由后端下发 / 按 fork 事件自动刷新 / 版本与完整性校验）**前两项已落地**，该 TODO 注释本身已被替换为"已知边界（决策，不是待办）"段落，勿再引用旧行号。

> **为什么入口表必须由后端下发、而不是"拼约定路径 + 探测"**（源码头部 `packages/web/src/lib/pluginUi.ts:22-26` 记录的三条实测理由）：① dev 下直接 `import('/plugins-ui/...')` 会被 Vite 的 import-analysis 改写为 `import(__vite__injectQuery(url, 'import'))` 而返回 **500**；② dev 的 SPA fallback 对不存在的路径返回 **200 + text/html**，浏览器打出 `Failed to load module script ... MIME type of text/html`，该日志 JS 捕获不掉；③ prod 下不存在的路径直接 **404**，Chrome 会把任何 404 记为控制台 `log:error`。于是"先探测再 import"必然产生噪声或误判。**本轮的解法**：产物缺失由后端归入 `skipped: entry_missing`，前端根本不会去 import 那些插件——三种噪声**结构性消失**（这三条理由因此仍然成立，但结论从"入口表用静态 JSON"升级为"入口表由后端现算"）。
>
> **两条已实测证伪的做法（排障时最容易误判，`packages/web/src/lib/pluginUiPlan.ts:17-26`）**：① **不要给 bundle URL 加 `?v=<rev>` 之类的 cache-busting query**——给**根相对** URL 加 query 在 dev 下会触发 Vite 的 `injectQuery` 改写（`?import&v=…`）→ **必然 500**（`This file is in /public…`）；即便改用同源绝对 URL 绕开改写，`rev` 一变就产生**新模块实例**，而 `registerSlot` 是 append、已加载集合只按插件名去重 → **插槽条目翻倍**（实测 widget 2→4），且 ESM 无法从模块图卸载。故 `rev` **只用于变更检测、不进 URL**。② **`/* @vite-ignore */` 并不能阻止 Vite 改写动态 import**——dev 之所以没踩坑，是因为 `pluginUiBase()` 返回的是**同源绝对 URL**（首字符 `h`），而 `injectQuery` 只对以 `.` / `/` 开头的 URL 追加参数；这个形态是**硬要求**，不要改成相对路径。
>
> **304 短路的一个真问题与修法**：`revision` 只是**表格内容**的哈希，"启用 → 停用 → 再启用"会回到**同一个**值；若此前某次加载失败，304 会让宿主**永久**漏加载那个插件。修法是 `isUiSettled(entries, loaded, failed)`（`pluginUiPlan.ts:201-219`）：**未收敛时不带 `If-None-Match`**（强制取一次完整表重新对齐），并以 `rev` 为键**记忆加载失败**、把"已按同一 rev 失败过"视为已收敛——避免 15s 轮询对同一个坏产物反复 import 与重复告警。

### 批次 E：PostgreSQL 适配（**已裁决延期**：以后做，不是不做）

**范围**：先出评估结论，再决定是否落地 `packages/db-pg/`。

**★ 状态更新（后续批次）：已落地，不再是延期项**（真 PG 端到端验证通过；见第 5 节 L-9 的状态更新块与 [review/plugin-freedom-audit.md](review/plugin-freedom-audit.md) 的 F19）。以下为当时的延期说明，**保留为决策记录**。

**状态：明确延期**——当前处于插件平台能力补齐期，DB 不在关键路径上。延期依据、已实测的两条"免费"保障、`DatabaseAdapter` 的 3 处实际消费点、双轨接口决策、唯一防返工项（`GeeWikiMeta.migrations` 扩为双路径，**登记为批次 E 落地前置条件，本次不改代码**）、以及明确不建议引入的两类依赖，全部记在 **第 5 节 L-9**（一条写全，避免两处各写一份而漂移）。**本批次以下内容保留为"落地时必须覆盖"的评估提纲。**

**评估必须覆盖的方言差异**：

- 占位符 `?` → `$n`；
- 自增主键（`INTEGER PRIMARY KEY AUTOINCREMENT` → `GENERATED ... AS IDENTITY` / `serial`）；
- upsert（`INSERT OR REPLACE` / `ON CONFLICT`）；
- **事务必须绑定单连接**（不能对整个 pool 开事务）；
- `pool.on('error')` **必须监听**（空闲连接被服务端断开会让进程崩）；
- `RunResult.lastInsertRowid` 在 pg 下需由 `RETURNING id` 补齐。

**验证方式**：评估文档（结论 + 适配矩阵）先行；若落地，用与 sqlite 相同的迁移脚本跑通插件迁移控制器与 wiki CRUD，并保证 `conflictGroup: database-provider` 互斥切换可用。

**风险**：同步 → 异步的接口分叉（D-6）会让业务代码出现两套调用风格；迁移脚本是否共用（SQL 方言差异）需在评估中给出明确结论。

### 批次 F：容器化

**范围**：多阶段镜像 + compose，使 `docker compose up` 可用。**已有在制品**，当前处理方式（builder/runtime 分阶段、运行期单独安装 `tsx`、权限归一化等）见 [deployment.md](./deployment.md)。本批次只需在插件平台能力落地后回归验证：外部插件挂载目录（容器内 `/app/plugins`）能被批次 B 的发现逻辑识别。

**集成缺口清单（本轮实测发现）**：G1–G4 的**完整描述与当前状态表**记在 **第 5 节 L-10**（G1 / G3 / G2 均已修、含镜像重建实跑；G4 为决策已落地），L-11 / L-12 记录由 G2 / G3 派生的两条补充结论，**L-14** 记录由 G2 暴露出的"issue 不可见"缺口。**本批次落地时必须以 L-10 的表格为验收清单**，不得只看"compose 能起来"就认为该批次完成。

**验证方式（补充）**：镜像重建后实跑三组场景——①不挂 `./config` 卷（验证默认基础层清单生效、`HEALTHCHECK` 不再永久 unhealthy）；②挂空 `./plugins`（验证 0 插件是**显式可见**的而非静默）；③`docker run -w /tmp` 覆盖工作目录（验证 G1 固化后插件发现根不漂移）。

### 批次 G：检索与问答（AI 原生能力首批）

**范围**：`@geewiki/search`（全文检索）、`@geewiki/llm`（LLM 服务契约层）、`@geewiki/ai`（检索增强问答的检索-only 形态）三个插件 + wiki 内宿主原生的检索/问答界面 + 一轮"服务提供一致性"平台修复。对应提交 `e6ddfbd`（search + llm）、`dc5885e`（前端）、`585dbac`（ai + 一致性修复 + 默认启用检索）。

**交付口径**（逐项已核对源码）：

| 项 | 结论 |
| --- | --- |
| 索引与迁移 | `packages/plugin-search/migrations/0001_search.sql`：FTS5 **external content** 虚表 `pages_fts` + 三条同步触发器 + `rebuild` 回填；由**管理器的迁移控制器**在激活前执行（`defaultRegistry()` 里 `migrationsDir: SEARCH_MIGRATIONS_DIR`），**不依赖 db-sqlite 自己的迁移**。触发器同步与"迁移内不写事务"的理由见 **§2.4 T-6** |
| 检索路径 | `MIN_TRIGRAM_LENGTH = 3`（`packages/plugin-search/src/index.ts:134`）：trim 后 ≥3 字符走 `pages_fts MATCH ?`（`mode: 'fts'`，按 BM25 排序）；**<3 字符走 LIKE 兜底**（`mode: 'like'`，**直接扫 `pages`**）。`MATCH` 的查询串经 `toFtsPhrase()` **整体加双引号**（内部引号翻倍）作**查询语法注入防护**——用户输入绝不按 FTS5 语法解释 |
| 查询语义 `queryMode`（`phrase` / `terms`，**已落地并提交 `04c45c3`**） | 缺省 `'phrase'`＝**整串字面短语**（搜索框语义，向后兼容）；`'terms'`＝把查询切成**词元**后以 ` OR ` 连接（**问句检索 / RAG 语义**）。切分：**CJK 连续片段取长度 3 的滑窗 3-gram**、**ASCII/数字片段按空白与常见标点切词且只保留长度 ≥3** 者（trigram 的 <3 字符硬约束所致）、去重且保序；**每个词元仍各自 `toFtsPhrase()` 后拼 OR**——切词与转义分开，注入防护仍只有一处实现。`terms` 切不出词元时（<3 字符、纯标点）**回退 LIKE**（不构造空 `MATCH`，它抛 `fts5: syntax error`）。`terms` 下 BM25 天然让"命中词元更多"的行排前；`snippet` 锚点改为**逐个词元试** |
| `mode` 的方向（**两个含义，勿混**） | **`mode` 现在有两个不同含义，分处响应与请求两侧**：① **响应字段 `mode`** = **实际走的那条路径**（`'fts'` / `'like'`，观测与测试用），HEAD `585dbac` 起即存在；② **请求参数 `mode`**（`'phrase'` / `'terms'`）= **本次请求的查询语义**，**已落地并提交 `04c45c3`**；同时**响应新增 `queryMode`** 回传该请求语义。⇒ **文档必须分别命名两侧**，不能笼统写"`mode` 是响应字段，不是请求参数"（那是 HEAD `585dbac` 的旧行为，现已不成立）。**另注**：`mode=terms` **未接入 Web UI**——搜索框保持短语语义 `phrase`，只有 `@geewiki/ai` 的问答走 `terms`（`packages/plugin-ai/src/index.ts:361`） |
| 端点语义 | **请求参数**：`q` / `limit` / `mode`。空查询 → **400 `invalid_query`**；非法 `limit` → **400 `invalid_limit`**（须为 1..100 的整数）；**非法 `mode`（非 `phrase` / `terms`）→ 400 `invalid_mode`**（**不静默降级**——把 `term` / `keywords` 这类拼错当 `phrase` 会表现为"问了却没结果"）。**`total` 是全量命中数，不受 `limit` 限制**，且工作树改为 **`COUNT(DISTINCT p.id)`**（`terms` 下 OR 会让同一行被多个词元命中，`COUNT(*)` 会按命中次数重复计入）；`snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`，前端不得二次转义）；`score` 是**取负后的 BM25**（越大越相关，**非归一化**、值域无界，**仅同次查询内可比**，LIKE 路恒 0） |
| 检索召回缺陷与修复（**已完成，提交 `04c45c3`**） | **机制**：`toFtsPhrase()` 把**整串**当一个 FTS5 字面短语 ⇒ 自然语言问句（「检索增强怎么做」）要求正文连续出现该整串，**恒为 0 命中**，`@geewiki/ai` 的检索地基因此不可用。**修复**：新增 `buildTermQuery(q): string[]` 与新 `SearchMode = 'phrase' \| 'terms'`，让 `@geewiki/ai` 改为 `search.search(query, { limit, mode: 'terms' })`。**状态**：**已提交**（`04c45c3`，改动 `packages/plugin-search/src/index.ts` +141 / `packages/plugin-ai/src/index.ts` +6 及两包测试 +173 / +45）。**已知代价（提交说明原文）**：terms 召回更宽，精确率天然低于短语检索，建议纳入后续检索质量评估。**未验证项**：端到端召回质量未经本文档作者复跑（无真实问答链路） |
| 单一实现 | `GET /api/search` 与 `search-service.search()` 走**同一份实现**（端点只做 HTTP 层），故同 `q` 同 `limit` 下逐字段一致；`search-service.contents(slugs)` 供 RAG 取正文（只含真实存在的 slug）。卸载后调用**显式抛错**而非返回空结果 |
| LLM 契约层 | `provides: 'llm-service'`、**不进任何 conflictGroup**、**有意不含任何厂商 adapter** ⇒ **当前无可用 provider**（只注册恒不可用的兜底路由 `null`）。契约核心：稳定错误码枚举（10 值）、调用方**按 code 分支不按 message**、`error` chunk **结构上无 message 字段**、**终止 chunk 恰一次且在末位**、**服务绝不重试**、重复 route 注册抛错 |
| 密钥安全 | 配置只存**环境变量名**（`apiKeyEnv`）⇒ 结构上杜绝密钥进入**会落盘入库**的 `config/plugins.base.json`；`detectSuspiciousCredential()` 命中则让**激活失败**（throw，而非 `process.exit(1)`）；`redact()` 与检测**共用同一组正则源**；**`text-delta` 刻意不脱敏**（脱敏会篡改模型输出） |
| 问答产品承诺 | **没有 API key 时也完整可用**：`200` 一律正常（含"未配置密钥"与"检索无结果"），**绝不用 4xx/5xx 表达"没有 key"**；降级为 `mode: 'retrieval-only'` + `degraded{reason,code,message}` + **完整 `sources`** + 零成本抽取式摘要；`400 empty_query` / `400 too_long`（`MAX_QUERY_LENGTH = 500`，`packages/plugin-ai/src/index.ts:98`） |
| 上下文截断 | `selectSources()`（`packages/plugin-ai/src/select.ts:44`）：`perSourceChars` 截断后逐条试放，不超 `totalContextChars` / `maxSourcesInContext`；**放不下就整条丢弃，绝不做尾部裁切**（半句话会诱导模型顺着编）；被丢弃者 `used: false` 且 `n: null`；`sources[].n` **只对 `used: true` 者从 1 起连续编号**（故类型是 `number | null`）。正文经 `search-service.contents()` 取，**不直连 `pages` 表** |
| 唯一接线点 | `generate()`（`packages/plugin-ai/src/index.ts:261`）是本阶段**唯一有意未接线**的函数（无 adapter ⇒ 必走降级）；接 adapter 时只需替换它，prompt 拼装已拆成纯函数（`prompt.ts` 的 `buildContext` / `buildMessages` / `SYSTEM_PROMPT`）并有单测 |
| 前端 | **宿主原生 UI**，走 hash 子路由 `#/wiki/search/<q>` 与 `#/wiki/ask/<q>`；**Slot 机制一行未改**（`packages/web/src/lib/slots.tsx` 零改动，"宿主不向插件传数据"的冻结裁决保持）。入口探测两路：`GET /api/plugins`（权威、**不产生 404**）+ `GET /api/ai/capabilities`（插件未启用时 404，**静默降级只 `console.debug`，绝不产生 console error**）。降级提示条是**信息性**的（`no_provider` / `missing_credential` → `level: 'info'`，`packages/web/src/lib/searchPlan.ts:77-86`） |

> **修正（本批，2026-09-14）——`@geewiki/ai` 拆分为 `@geewiki/ai-writing` + `@geewiki/ai-qa`，本表凡出现 `packages/plugin-ai/**` 的路径均已失效**。契约的权威文本是 `docs/design/ai-plugin-split.md`（含 §7「落地补充」= 实现期对该设计的五处改写）；实证脚本与逐条实测在 `scripts/acceptance/ai-split-e2e/README.md`。上表逐行的更正：
>
> | 上表行 | 更正 |
> | --- | --- |
> | 问答产品承诺 | **本批主动放弃该承诺**（问答侧）。旧形态在缺模型时返回 `mode: 'retrieval-only'` + `extract.ts` 的零成本抽取式摘要，用户读到的是"像是答案"的检索片段拼接——**宁可不出，也不能冒充**。现在缺模型 ⇒ **503 `model_unavailable`**、检索服务缺失 ⇒ **503 `search_unavailable`**、调用了模型而它失败 ⇒ **502 `generation_failed`**（带 `degraded.code`），`mode` 只剩 `rag` / `rag-partial` / `no-context`。**状态码按原因二分**：**503 = 前置条件不满足（根本没调用模型）**、**502 = 上游真的失败（调用了它）**——原先两者都记 502，于是"没配密钥"（该去补配置）与"服务商 429/超时"（该等一会儿）在界面与监控里长成同一个样子，而正确动作相反。**唯一保留的"没有 key 也能用"是辅助写作侧的对称改动**：它同样不再兜底，缺模型 ⇒ 503 + `mode:'unavailable'` + `text:null`。检索 0 命中**仍不是错误**：`200 mode:'no-context'` + `answer:null` + **不调用模型**（实测 `modelCalled:false`）。`400 empty_query` / `400 too_long` 不变，`MAX_QUERY_LENGTH = 500` 现在 `packages/plugin-ai-qa/src/index.ts:152`（旧 `packages/plugin-ai/src/index.ts:98` 失效） |
> | 唯一接线点 | **`generate()` 这个函数已不存在**（旧 `packages/plugin-ai/src/index.ts:261` 失效）。生成一律走 `llm.stream(...)`，消费点是两处：问答 `packages/plugin-ai-qa/src/index.ts`（并透传 `AbortSignal`，见 `:331` / `:348-350`）、辅助写作 `packages/plugin-ai-writing/src/assist.ts`（输出上限取"本动作预算"与统一配置 `maxOutputTokens` 的较小者；**采样温度不再由任何一层指定**，原先硬编码的 `0.3` 已删除，交回服务端默认值）。prompt 纯函数拆分随问答走：`packages/plugin-ai-qa/src/prompt.ts`（`buildContext` / `buildMessages` / `SYSTEM_PROMPT`） |
> | `mode` 的方向 | 问答走 `terms` 这条**判据未变**，**调用点换名**：`packages/plugin-ai-qa/src/index.ts:431` 的 `search.search(principal, query, { limit, mode: 'terms' })`（旧文写 `packages/plugin-ai/src/index.ts:361`，且旧签名**不带主体**——见下行的红线改动）。"search 侧 `mode` 是响应字段 / `queryMode` 是请求语义"的两侧命名与 `mode=terms` 未接入 Web UI 两条继续成立 |
> | 单一实现 | `search-service` 的两个入口**签名已变**：`search(principal, q, opts)` 与 `contents(principal, slugs)`（`packages/plugin-search/src/index.ts:191` / `:223`），`principal` 是**必填首参**且守卫**抛错而不是"当作匿名"**。上表"正文经 `search-service.contents()` 取，**不直连 `pages` 表**"这句因此升级为"**带主体**经 `contents()` 取"——理由与守卫位置见 `docs/design/access-control.md` §4.5 末尾的修正 |
> | 上下文截断 | 逻辑仍在（`selectSources()` 现在 `packages/plugin-ai-qa/src/select.ts:79`），且按 §4.5 第 2 条补齐了**块对齐**：`accumulateBlocks()`（`select.ts:58`）**整块累加**、放不下就停，**绝不跨可见性不同的块做字符裁切**（旧实现是对整页正文 `slice`，块级模型下那会把相邻不同档的块切进同一片段）。`used:false` / `n:null` / `n` 只对 `used:true` 连续编号 三条不变 |
> | 前端 | **本行整体作废**。`#/wiki/ask/<q>` 路由仍在宿主（路由真源），但**面板 DOM 全部来自插件 bundle**：`AskPanel.tsx` / `components/ai/AssistToolbar.tsx` / `lib/aiStreamPlan.ts` / `lib/assistPlan.ts` / `api.ts` 的 AI 类型与调用 / `styles.css` 的 `.ask-*` 已删除，宿主改为渲染两个 outlet。**"Slot 机制一行未改"这条本批被推翻**——新增 `editor-toolbar` / `wiki-ask` 两个插槽与对应 props，并按"具名窄契约"传数据（裁决边界见批次 D 修正块）。入口探测也换了：不再用 `GET /api/plugins` + 硬编码插件名，改用入口表的**声明 + 仲裁生效集**（`pluginUiDeclaredFor()`，`packages/web/src/lib/pluginUi.ts:190`） |
>
> **同时过时的三条本批之外的旧断言**（一并登记，避免下批再当"未做"处理）：① 第 3 项"默认启用检索的决策"里"`@geewiki/ai` 与 `@geewiki/llm` 仍是已注册未启用"——`config/plugins.base.json` 现在默认启用 `@geewiki/llm` / `@geewiki/openai` / `@geewiki/ai-writing` / `@geewiki/ai-qa`，**"没有可用 provider 所以问答恒降级"不再是清单决定的常态**；② L-15"无任何厂商 LLM adapter"（`packages/plugin-openai` 已在仓库与 `defaultRegistry()` 里，见 `packages/server/src/index.ts:1473`）；③ L-16"尚无任何插件向客户端持续写帧"与其中"② 硬/idle 超时未做、③ `close` 取消上游未做"两条——**均已落地**，逐条见下面的 L-15 / L-16 修正块。**本批未复核**（刻意不抄，交由读数批次回填）：测试与包数量、`pnpm typecheck` 全量结果、`GET /api/plugins` 的条数口径。

**本批的平台级修复（三件事，均与"服务提供一致性"或读数可靠性有关）**：

1. **服务提供一致性的三次修复**（同一类缺陷的三种表现，详见 `docs/architecture.md` §9.2 的映射表与修复记录）：
   - `@geewiki/wiki` **只声明不提供**——manifest 写了 `provides: 'wiki-service'` 却从未 `ctx.provide` ⇒ 依赖边被解析为"已满足"而 `ctx.get('wiki-service')` 恒为 `undefined`。**已补**真实 `ctx.provide('wiki-service', svc)`（`packages/plugin-wiki/src/index.ts:443`）。
   - `@geewiki/echo` **谎报 token**——声明 `provides: 'echo-service'` 但从未提供，且**全仓无消费方**（已 grep 核实）。**已撤掉**该字段（`packages/plugin-echo/src/index.ts:33`），而不是硬造一个无人使用的服务契约。
   - 新增三者**一律"声明 token + 显式 `ctx.provide` + 两者同名"**：`search` / `llm` / `ai`（`packages/plugin-search/src/index.ts:383`、`packages/plugin-llm/src/index.ts:117`、`packages/plugin-ai/src/index.ts:552`），源码注释里明文写"名字必须一致，否则消费方 `ctx.get` 拿到 `undefined`"。
   - **派生的文档契约**：`provides` token 与真实服务名**是两套命名空间**（`db-sqlite` 声明 `database-provider` 但提供 `'db'`；`http` 声明 `http-service` 但提供 `'http'`）——**消费方必须知道这层映射**，完整映射表见 `docs/architecture.md` **§9.2**。
2. **根 `package.json` 的 `test` 脚本加 `--no-bail`**。此前 `pnpm -r` 在**首个失败包处即中止**、后续包根本不执行 ⇒ 过去的"全量绿"读数可能是**部分**读数（一个红色包会把它后面所有包藏起来）。这是**读数可靠性**的修复，不是功能修复。
3. **默认启用检索的决策**：`config/plugins.base.json` 加入 `@geewiki/search`（第 4 条启用项）。**理由**：检索是**纯只读增强**、不需要任何凭据、不引入外部服务，属"开箱即用"能力的自然延伸；而 `@geewiki/ai` 与 `@geewiki/llm` **仍是已注册未启用**（与 `@geewiki/echo` 同形态），因为问答是否启用涉及运维对模型接入的取舍。启用后 `GET /api/plugins` 显示 **7** 条内置（注册 7 条 − 未启用 3 条 = 启用 4 条），挂载外部示例后为 **8** 条。

**验证方式**：见第 6 节"当前质量基线"（本批实跑口径）与第 9 节的事实核对记录。**本批新增的实证结论集中在 §2.4（FTS5 / 中文分词），新增的已知限制见 L-15…L-20。**

**未验证 / 待并行批次复核（状态已更新）**：① `rag` / `rag-partial` 两条路径**仅有"假 provider"的单测覆盖**（无真实模型链路），"能接上真实模型"这件事**尚未被证明**（见 L-15）；② 检索召回行为的缺陷修复**已落地并提交为 `04c45c3`**（`mode: 'terms'` 词元 OR + `@geewiki/ai` 一律走 terms；机制与修复形态见上表"检索召回缺陷与修复"行），**该修复的端到端召回质量未经本文档作者复跑验证**（无真实问答链路），用例数已由读数 C 复核为稳定值（`plugin-search` 32 / `plugin-ai` 25，见第 6.1 节）；③ **新增的待复核项**：并行批次正在写 `packages/plugin-openai/**`（OpenAI 兼容 adapter），取数时刻（`2026-09-11T00:38 +08:00`）**尚未提交**但已具形态——`src/{index,provider,sse,errors}.ts` + `test/{plugin,provider,sse,errors}.test.ts`，自带 **42** 例单测（见 §6.1 读数 D：8 个包 308/308）；`packages/server/src/index.ts` 的 `defaultRegistry()` 也已在**未提交**的工作树里登记 `@geewiki/openai`。**提交后须重跑并复核第 6.1 节与第 7 节 item 2**。

### 批次 H：SSE 长连接出口 + 管理台两项交互（提交 `2273006`、`3bdcf4b`）

**范围**：为后续 LLM 流式输出铺地基（长连接不得阻塞优雅排空，也不得把 JSON 写进事件流），以及管理台的两项交互补齐（展示 `skipped`、依赖阻止停用的专门说明）。

**交付口径（逐项已核对源码）**：

| 项 | 结论 |
| --- | --- |
| `noteStatus` 通路 | `RouteHandlerContext.noteStatus?(status): void`（`packages/core/src/index.ts:299`）——**仅记录指标、绝不碰响应**；与 `json()` **共用同一记账点**（`packages/server/src/index.ts:272-292` 的 `finish()`），由 `settledStats` 幂等守卫保证**每个请求只记一次**。做成**可选成员**以保持向后兼容（既有 4 处测试替身无需改动） |
| `trackStream` 通路 | `HttpRouterService.trackStream?(res): () => void`（`packages/core/src/index.ts:375`；实现 `packages/server/src/index.ts:170-178`）——登记长连接、返回**幂等**注销函数（`released` 布尔守卫）。底层是 `private readonly activeStreams = new Set<ServerResponse>()`（`packages/server/src/index.ts:128`），**该集合刻意不参与排空计数** |
| `closeStreams` 归属（**易错点**） | `closeStreams(): void`（`packages/server/src/index.ts:186-196`）**不在 `HttpRouterService` 接口上**——它是 `HttpRouter`（`packages/server/src/index.ts:106` 的 `class HttpRouter implements HttpRouterService`）的**具体类方法**，只在 `HttpPlugin.apply` 的 teardown 闭包内被调用。**其他包经 `ctx.get('http')` 拿不到它** |
| 长连接为何不占在途（诊断机理） | `dispatch` 只在 `isThenable(result)` 为真时才把 `exitHandler` 挂到 Promise 结算上（`packages/server/src/index.ts:358-371`）⇒ **处理器同步返回非 thenable 即可在同一 tick 内结算**，长连接的存活状态由提供方自持。**若把它算进在途**，卸载时 `drain()` 会空转满 `drainTimeout` 并打印**假的**排空超时告警 |
| teardown 五步 | `unprovide()` → `router.closeStreams()` → `await drain(drainTimeout×1000)` → `server.closeIdleConnections?.()`（Node 22 有；**只关空闲、保留在途**，**刻意不用 `closeAllConnections()`** 以免掐断测试里 undici 连接池的复用连接）→ `server.close()`（`packages/server/src/index.ts:627-654`）。排空超时告警**文案与语义一字未改** |
| **被实测证伪的设计设想** | "先 `res.writeHead(200, {'content-type':'text/event-stream'})` 再 `h.json(200, null)`"**不能**实现"只记指标而不结束响应"：`writeHead` 后 `res.headersSent` 立即为 `true` 而 `writableEnded` 仍为 `false`（**write-after-end 防护拦不住**），而 `json()` 的 `writeHead` 有条件（`if (!res.headersSent)`）**但 `res.end(JSON.stringify(body))` 无条件**（`packages/server/src/index.ts:294-307`）⇒ 给 SSE 流追加字面 `null` **并立即终结流**。**实测客户端正文**：`event: status\ndata: {"type":"status"}\n\nnull`。**故必须走 `noteStatus`** |
| 管理台：展示 `skipped` | 纯函数 `classifyUiSkips(skipped)`（`packages/web/src/lib/pluginUiPlan.ts:226`）按 severity 分两组：`entry_missing` / `invalid_name` → 红系显著告警块 `.ui-skips-attention`；`inactive` / `no_client` → 可折叠 `<details>` `.ui-skips-normal`。配 `UI_SKIP_LABEL` / `UI_SKIP_HELP`（`:240` / `:248`）。读取补了最小订阅式路径 `pluginUiState()` / `subscribePluginUiState()`（`packages/web/src/lib/pluginUi.ts:148` / `:159`），**没有新写第二份 fetch**；`readSkipped` **刻意从宽**（展示字段坏掉不得拖垮入口表关键路径） |
| 管理台：依赖阻止停用 | `409 has_dependents` 从"泛化错误"升级为**专门说明块** `.dependents-block`（`packages/web/src/pages/AdminPage.tsx:423-455`）：标题「无法停用 X：仍有插件在依赖它」+ 依赖方名单 + 两段可操作指引（逐个停用依赖方 / 走冲突组替换安全接管）。`dependentNamesOf()` 防御性读取 `details`（形状不符退回空数组 → 走"名单不可用"兜底，**不显示 `undefined`**）。**刻意未实现自动级联停用**（破坏性操作） |
| **顺带修掉的真实交互缺陷** | `buildPluginUiTable` 的 `revision` 只对 `{version, plugins}` 求 sha1（`packages/manager/src/plugin-ui.ts:255`），**不含 `skipped`** ⇒ "未启用/无界面插件集合"的变化**不改变 revision** ⇒ 管理台二次 `load()` 因 304 短路**永远看不到**这类变化。**修法**：`syncPluginUi` 加 `force` 参数（`packages/web/src/lib/pluginUi.ts`）——管理台走 `force`（不使用 `If-None-Match`），15s 可见期轮询仍走 304 短路 |
| 约束遵守 | **未改 Slot 机制**（`git diff -- packages/web/src/lib/slots.tsx` 为空，"宿主不向插件传数据"的冻结裁决保持）；零新增依赖 |

**验证方式**：`packages/server/test/sse-drain.test.ts`（**6 例**，含一条**负对照**：处理器返回永不 resolve 的 thenable → 排空确实等待并超时打印告警，证明主用例有判别力；两处**变异取证**：把长连接算进在途 → 用例红"实际 5004ms"；去掉 `closeStreams` → 用例红；变异均已还原）。`packages/server/test/router.test.ts` 的 **11 条一字未改**（`git diff --stat 2273006^ HEAD -- packages/server/test/router.test.ts` 输出为空）。管理台侧 `packages/web/test/pluginUiPlan.test.ts` **+9 例**（纯函数）。浏览器侧由并行验收批次实测（隔离实例 + CDP 真实指针事件），本文档作者**未复跑**。

**本批的平台级事实**：**本批只铺了地基**——出口机制（登记 / 记账 / 主动收流 / 排空共存）已就绪，但**真实的流式输出仍未接线**（尚无任何插件向客户端持续写帧；`packages/plugin-ai/src/index.ts:261` 的 `generate()` 仍是唯一接线点，硬超时 / idle 超时与 `res.on('close')` 取消上游两件亦未做）。详见 **L-16** 与 `docs/architecture.md` **§5.1.1**。

> 历史引用说明（2026-09-15 起）：本文件中引用 `packages/web/src/pages/AdminPage.tsx` 的行号与结构，
> 均为**合并前**记录。该文件已 `git mv` 为 `pages/GraphPage.tsx`（依赖图画布抽到 `components/PluginGraph.tsx`），
> 「插件管理」已并入依赖图页：点节点开弹窗看详情/改配置/启停。详见 `docs/architecture.md` §5.3b。

## 5. 已知限制与待办

**L-1 排空语义是全站在途请求，不是 owner 级。**
`@geewiki/http` 的 `inflight()` / `drain()` 以整个路由服务为粒度：卸载任一插件时，等待的是**全站**尚未结算的请求（不含发起卸载的那次管理请求）。更精确的 **owner 级排空**（只等待被卸载插件自身路由注册的在途请求）列为后续工作。

**L-2 `enable` 失败回滚的作用域曾是调用帧局部（已确认缺陷，已于提交 `69cfeb2` 修复）。**
`enable()` 用 `activatedByThisCall` 记录"本次调用新激活的依赖"，失败时逆序回滚。该数组是**每递归帧局部**的（`packages/manager/src/index.ts:655` 的 `const activatedByThisCall: string[] = []` → `:660` 在递归 `await this.enable(dep)` **之后**才 push，而递归调用自带一个新数组）：依赖深度 ≥2 时，孙依赖由**子帧**的 `enable()` → `activateCore()` 成功激活并 `addToSession` **落盘**，子帧返回后它自己的数组即被丢弃 → 目标插件激活失败时，外层帧只能回滚自己记录的直接依赖，**孙依赖残留（仍处于激活态）且 session 清单已泄漏**。

**可达性要分两个条件说，不要合并成"暂不可达"，也不要写成"将来风险"**：

- **只看内置插件：不可达。** 内置注册表的最大依赖深度是 1（`@geewiki/wiki` requires `http-service` + `database-provider`，两者自身 requires 为空；`@geewiki/echo` requires `@geewiki/http`），构造不出 depth ≥2 的链。
- **引入外部插件：可达。** 批次 B 已落地，`packages/server/src/index.ts` 的 `buildRegistry()` 把外部插件**并入同一注册表**（`return { registry: [...builtin, ...discovered.plugins], issues: discovered.issues }`，见 §5.8 与 `packages/manager/src/discovery.ts`），外部插件的 `requires` 可以指向另一个外部插件，因此 A→B→C 这样的 depth ≥2 链**现在就能构造**。

即准确表述为"**缺陷曾真实存在（是否触发取决于注册表里有没有 depth ≥2 的依赖链，外部插件使其可达），现已按定稿修法修复**"。

**修法（已落地，提交 `69cfeb2`）**：公开 `enable` 作唯一回滚点（实现在 `enableWithDeps`）+ private `enableInner(name, config, activated, skipDeps?)` 跨帧共享同一个 `activated` 数组 + 激活成功后自登记 `activated.push(name)`（push 序即激活序，逆序回滚即合法卸载序）——见第 4 节批次 B 的 **G-2**。

**L-3 后端直接运行 TS。**
各包 `exports` 指向 `src/index.ts`，运行期依赖 devDependency `tsx`；这与生产镜像裁剪 devDependencies 存在张力。镜像侧的当前处理方式见 [deployment.md](./deployment.md)。

**L-4 未实现项。**
插件市场 / 签名校验、插件前端类型检查、跨插件 `configSchema` 引用（schema 复用）均未实现。

**L-5 `./plugins` 目前仅为挂载点。**
容器编排中 `./plugins` → `/app/plugins`（宿主路径可用 `GEEWIKI_HOST_PLUGINS_DIR` 覆盖）已就位，但**发现逻辑属批次 B**；**目录不存在**时不影响启动（`packages/manager/src/discovery.ts:132` 的 `existsSync(root)` 前置判断会直接返回空列表），但**目录存在却不可读**时会阻断启动——该例外见 L-10 的 **G2**。

**L-6 ESM 重载的模块实例不会被回收。**
`?v=<mtime>` 每次都产生新模块实例（§2.3 L-2 实证），反复热重载会累积旧实例。当前不做回收；若未来出现高频重载场景需评估。

**L-6 补充（插件 UI 侧，本轮实测并已决策）**：`?v=` 参数**已从插件 UI 加载路径彻底移除**——给 bundle URL 加 query 不但解决不了回收，反而引入两个新问题（dev 下 Vite `injectQuery` 改写 → **必然 500**；同源绝对 URL 下 `rev` 变化产生新模块实例 → **插槽条目翻倍**，实测 widget 2→4，详见第 4 节批次 D 的证伪说明）。因此**最终形态**是：import URL **不带任何 query**，`rev` 仅用于变更检测；`rev` 变化走 unload → load 重装，但**同一 URL 命中模块缓存**，故**插件产物更新后需整页刷新才会生效**（重新 enable 未更新的插件则复用同一实例、`register` 重跑、不累积）。ESM 无法从模块图卸载这一条**仍是已知边界、不是待办**（`packages/web/src/lib/pluginUi.ts:36-41`）。

**L-7 React Flow 授权提示会打进 console。**
`packages/web/src/pages/GraphPage.tsx:145` 的 `proOptions={{ hideAttribution: true }}` 会让 React Flow 在 console 打印授权提示。这是**上游许可证提示，不是缺陷**；是否保留需按许可证条款决定（改回显示署名即可消除）。基线验收时已确认：除该提示外 console 无错误。**该条与本节其余 L-n 的语义不同**：L-1…L-6 是功能/架构限制，本 L-n 是法律与观感层面的取舍。

**L-8 Wiki 详情页「← 返回列表」依赖浏览器历史栈。**
`packages/web/src/pages/WikiPage.tsx:174` 的「← 返回列表」用 `window.history.back()`（同文件 `:162` 的「← 返回」同样如此）。当历史栈里先有编辑页时，点击会**先退回编辑页**而非列表页。建议改为显式导航 `onNavigate('')`（该组件已持有 `onNavigate`，见 `:28`）。

**★ 状态更新（后续批次）：L-9 已落地，不再是延期项。**

PostgreSQL 适配已实现并完成**项目首次真实 PG 端到端验证**（PostgreSQL 15.19 容器）。下面 ①–⑥ 是**当时的延期决策记录，逐字保留**（它记录了"为什么当时不做"以及当时的量化依据）；以下是**实际落地时与当时的判断不一致的地方**，这才是本块的价值所在：

- **双轨接口早就有了，缺的从来不是架构**：④里计划新增的 `DatabaseAdapterAsync` / `isAsyncAdapter()` / `asAsync()` **在本仓库里早已落地**（`packages/core/src/index.ts`），schema 也早已按方言分家（`packages/db-sqlite/src/migrations` 与 `packages/db-postgres/migrations` 同编号两套 DDL，后者 13 个文件）。真正缺的是**验证**——此前从未跑过一次真 PG。
- **③的"仅 3 处消费点"低估了**：实际**代码级**取用 `db` 服务的源文件有 **11 个**。真 PG 一跑就抓出 3 个真 bug，且都是"SQLite 全绿、PG 必炸"的类型：① `plugin-ai-journal` 的迁移用了 SQLite 专有的 `AUTOINCREMENT`（激活期整块失败）；② `plugin-builtin-docs` 按同步接口用 `db.query(...).map()`（PG 下 `is not a function`）；③ `plugin-ai-summary` 六处同步式调用（`db.query(...)[0]` 恒为 `undefined`，**不报错**）。
- **⑤的"唯一防返工项"判断正确**：`GeeWikiMeta.migrations` 确需扩为 `string | { default?: string; postgres?: string }`，现已落地（`plugin-ai-journal` 是第一个使用者：新增 `migrations-postgres/` 目录）。
- **④里"整体异步化会迫使现有测试连带改写"的担心是对的**，而双轨 + `asAsync` 的写法也让修 bug 保持在局部（每个消费点 `await asAsync(db).…`）。
- **⑥的两条"不建议引入"仍成立**：最终没有引入 Kysely，也没有引入迁移框架。
- **真 PG 验证读数**：迁移失败 **0**、插件 **20 active / 0 error**；`POST /api/auth/setup` 201 → `POST /api/auth/login` 200 → `PUT /api/pages/pg-e2e` 200（`created`）→ `GET` 读回正文逐字一致 → `psql` 直查确认落库。
- **新增两条类级守卫**（把这一类缺陷钉在 CI 里，因为单测跑在 SQLite 上、**永远不会**暴露它）：`packages/manager/test/migrations-dialect.test.ts`（SQLite 专有语法的迁移目录必须有 PG 版本或登记为 SQLite 专有；含 `db-sqlite` ↔ `db-postgres` 编号对应检查）、`packages/manager/test/db-dual-track.test.ts`（代码级取 `db` 的源文件必须用 `asAsync` 归一化）——当前 **11 个消费方全部合规**。

完整的落地说明见 [review/plugin-freedom-audit.md](review/plugin-freedom-audit.md) 的 §0.5「F19」。

---

**L-9 PostgreSQL 适配明确延期（裁决："以后做"，不是不做）。**
①**延期依据**：当前处于"插件平台能力补齐期"，数据库是既有能力、**不在关键路径上**——补齐插件平台（批次 B/C/D）才能让外部插件与数据库插件真正可插拔，此时做 PG 适配属于为尚未成形的使用场景提前付出成本。
②**两条已实测的"免费"保障**（延期不损失未来收益）：
  - `packages/db-sqlite/src/index.ts:171-175` 的 manifest 已声明 `provides: 'database-provider'` 且 `conflictGroup: 'database-provider'`；未来 `db-postgres` 声明**同一个组名**即可自动获得"同组全局互斥"保护，无需新增机制。
  - 环境变量统一 `GEEWIKI_` 前缀（`GEEWIKI_DATA_DIR` / `GEEWIKI_CONFIG_DIR` / `GEEWIKI_PLUGINS_DIR` / `GEEWIKI_WEB_DIST` 等），PG 实现沿用同一前缀即可，不存在命名体系分裂。
③**同步接口 `DatabaseAdapter` 的实际消费点已逐处核对，全仓仅 3 处**（这是"改动面可控"的量化依据）：
  - `packages/manager/src/index.ts:1076-1080` 的 `activateCore` 迁移调用（`db.migrate(entry.migrationsDir)`；**行号已按当前 HEAD 更正**，旧稿写 `:667-671`，已被本批及此前批次的改动推移）；
  - `packages/server/src/index.ts:544` 健康检查的 `db.listTables()` / `db.appliedMigrations()`（**行号已更正**，旧稿写 `:427`，`a24241a` 改动该文件后推移）；
  - `packages/plugin-wiki/src/index.ts` 的业务调用（`ctx.get('db')` 取服务，`db.query` / `db.run` / `db.transaction` 合计 **8 处调用点**：5 处 `db.run(` + 2 处 `db.transaction(` + 1 处 `ctx.get('db')`；注意 `db.query(` 在该文件中为 0 处，与"13 处"的上游口径不符，**以本仓库实数为准**）。
④**接口决策**：新增 **`DatabaseAdapterAsync` + `isAsyncAdapter()` 双轨**（约 25–30 行），**不**把现有同步接口整体异步化。理由：整体异步化会毁掉 better-sqlite3 的同步优势（现有代码全部按同步写），并迫使现有测试（当前全仓 **132** 个单测：`packages/web` 19 + `packages/manager` 91 + `packages/server` 22，其中大量按同步语义断言）连带改写。
⑤**唯一防返工项**：把 `GeeWikiMeta.migrations` 从 `string` 扩为 `string | { default?: string; postgres?: string }`（`packages/core/src/index.ts:72` 当前为 `migrations?: string`，改造约 8 行、向后兼容；**行号已更正**，旧稿写 `:56`）。**本次决定暂不改代码**，仅登记为**"批次 E 落地前置条件"**——理由：PG 已延期，且当前不存在任何 PG 插件，暂不存在需要双方言迁移路径的实例；提前改类型只会引入无消费方的字段。
⑥**明确不建议引入的两类依赖**：**不建议**引入 Kysely 之类的统一查询层（会迫使 `packages/plugin-wiki/src/index.ts` 的上述 8 处调用点全部重写，收益仅是"语法统一"）；**不建议**引入 node-pg-migrate / umzug 之类的迁移框架（消除不了 SQLite 与 PG 的双方言 DDL 分支——方言差异仍在每个迁移文件里，只是多了一层依赖）。

**L-10 容器化集成缺口：G1 / G3 / G2 均已修（含镜像重建实跑），G4 为决策已落地。**
以下 G1–G4 是本轮实测发现的容器化集成缺口。**核对时点与状态**（以本仓库当前工作树为准）。G1 / G3 的状态依据从旧的"文本核对"升级为 **Docker 批次实跑**（镜像从零重建、不挂 config 卷、`-w /tmp` 覆盖工作目录三组场景）；G2 的表现口径按实跑日志修正，并派生出 **L-14** 这条新的可观测性缺口：

| 编号 | 缺口 | 当前状态（本轮核对） |
| --- | --- | --- |
| **G1** | `GEEWIKI_PLUGINS_DIR` 未在镜像 / compose 固化 → 插件发现根只能靠 `WORKDIR /app` + `process.cwd()` 回退才恰好正确；一旦覆盖工作目录（`docker run -w`、自定义 entrypoint）就会**静默发现 0 个插件**（不报错） | **已修（含镜像重建实跑）**：`Dockerfile` 的 runtime 阶段 `ENV` 与 `docker-compose.yml` 的 `environment` 均已固化 `GEEWIKI_PLUGINS_DIR: /app/plugins`；`Dockerfile` 内附注释说明了"必须是绝对路径 + 覆盖 WORKDIR 会静默 0 插件"的原因；compose 侧注明与该注释对应。**实跑证据**：容器内以 `-w /tmp` 覆盖工作目录后**仍发现 1 个外部插件**；**反证**：显式传相对值 `GEEWIKI_PLUGINS_DIR=plugins` 时发现根变为 `/tmp/plugins`、发现 0 个插件且**不报错**（静默失败，正是固化绝对路径的原因） |
| **G3** | 镜像内 `/app/config` 为空 + `readList` 在文件缺失时返回 `{enabled: []}`（`packages/manager/src/index.ts:165-166`）且**没有"清单缺失 → 回退内置默认注册表"的路径** → 不挂 config 卷时**没有任何插件被激活 → HTTP 服务不监听**（`HttpPlugin` 的 `server.listen(...)` 在 `packages/server/src/index.ts:442`，它本身也是一个被激活的插件） | **已修（含镜像重建实跑）+ 表现口径修正**：`Dockerfile` 增加 `COPY --from=builder /src/config /app/config`，把仓库默认基础层清单打进镜像（`.dockerignore` 只排除 `config/plugins.session.json`，保留 `config/plugins.base.json`）。**实跑证据**：镜像从零重建 `EXIT=0`；镜像内 `/app/config/plugins.base.json` 存在（126 B）；**不挂 config 卷不再是死壳**。**口径修正（重要）**：旧措辞"活着但不服务的死壳 / `HEALTHCHECK` 永久失败"**不准确**——config 目录为空时的真实表现是日志打印 `REST API 未挂载`、进程**`exit=0`** 退出；`restart: unless-stopped` 确实不处理 unhealthy，但它**会处理退出**，因此真实表现是**静默重启循环**（`status=exited exit=0` → 被反复拉起），而非"挂着一个永久 unhealthy 的容器" |
| **G2** | `packages/manager/src/discovery.ts:133` 的 `listPluginDirs()` 用 `readdirSync` **未加 try**（仅前置 `existsSync(root)` 判断）：目录**存在但不可读**（EACCES）时异常会冒泡；而调用点在 `packages/server/src/index.ts:548` 的启动路径上、**不在 per-plugin 的 try 之内** → 启动失败 → 写 `crash.marker`（`packages/server/src/index.ts:620-624` 的 `startup:` 分支）并 `exit(1)`；配合 `restart: unless-stopped` 形成**崩溃循环，且每轮都会清空 session 层**（崩溃恢复路径见 `packages/manager/src/index.ts:461` 附近） | **代码侧已修（不再静默）**：容器内（uid 1000）实测会打印 `[manager:discovery] 跳过插件目录 …（invalid_manifest）: … EACCES: permission denied`，即列目录失败已降级为"记 issue 并跳过"，不再冒泡到启动路径。**但暴露新的可观测性缺口**：`GET /api/plugins` 仍**只返回 4 条内置插件**，API / UI 上看不出"有插件被跳过"——已登记为第 5 节 **L-14**，其修复（发现期 issues 随 `GET /api/plugins` 暴露）已列入当前修复批 |

> **口径澄清（三条内置/注册数量，勿混用）**：`config/plugins.base.json` 默认**只启用 3 条**（`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki`）；`@geewiki/echo` **已注册但默认未启用**（`packages/server/src/index.ts` 的 `defaultRegistry()` 共 **4 个内置条目**）——所以 `GET /api/plugins` 显示 **4 条内置**（清单启用 3 + 已注册未启用 1），挂载示例外部插件后列表为 **5 条**。凡涉及"内置插件清单"的表述必须区分：**清单启用 3 条 / 已注册 4 条 / 挂载外部示例后列表 5 条**。
| **G4** | 是否把 `plugins/` 打进镜像 | **决策**：**不打进镜像**。理由：compose 的绑定挂载会覆盖镜像内同路径内容，镜像里的插件反而不可见；而"镜像内有、宿主目录为空"会造成"看起来装了插件、实际 0 个"的更坏歧义。改为**文档明确"外部插件只来自挂载"**——`docker-compose.yml` 的 `./plugins:/app/plugins` 行已就此写明 |

**L-11 外部插件的加载期故障不会阻断宿主启动，但发现期（列目录）会。**
接 L-10 的 G2：`loadExternalPlugins` 的设计原则是"加载失败 / 清单缺失 / 重名 / 路径越界只记为 issue 并跳过，绝不阻断宿主启动"（`packages/server/src/index.ts:541-553` 注释与 `buildRegistry` 实现）。**唯一曾例外的是列目录这一步**（`listPluginDirs`）——现已按实跑口径修正为记 issue（`[manager:discovery] 跳过插件目录 …（invalid_manifest）: … EACCES: permission denied`），**该例外已收敛**。此条保留用于强调"例外只应有一处"的边界：后续修复应保持该边界而不是顺带扩大。**注**：issue 记了但**接口上看不见**，是另一条独立缺口，见 **L-14**。

**L-12 容器内默认基础层清单是构建期快照，不是运行期同步。**
接 L-10 的 G3：`COPY --from=builder /src/config /app/config` 把**构建时**的 `config/plugins.base.json` 打进镜像。未挂载 `./config` 时，运行期对基础层的修改（如通过 REST 启停插件）写在容器可写层里，**容器重建即丢失并回退到构建期快照**；挂了卷则卷内容完全覆盖快照（G4 同款覆盖语义）。**该取舍本身不是缺陷**，但排障时必须先分辨"当前看的是镜像快照还是卷内容"。

**L-13 schemastery `bitset` 暂保留降级为 JSON 编辑（裁决）。**
未满足 S-13 对 `bitset` 的期望控件（"`Object.keys(bits)` 作多选项，提交值为**选中位按位或的 `number`**"）。当前结论：**暂保留降级**——配置表单对该类型回落到 JSON 文本编辑，不在批次 C 内实现多选控件。理由：`bitset` 在当前两个内置插件（`packages/plugin-wiki` / `packages/plugin-echo`）的 `configSchema` 中**均未使用**，为一个无消费方的类型投入控件实现与测试不划算；载荷侧的信息（`bits` 名字→数字字面量映射）已在 S-13 记录，未来实现时无需重新勘察。**影响面**：仅表现为该类型的配置项需要手工写数字，不产生错误数据（服务端仍按 schemastery 校验）。

**L-14 发现期 issue 的可观测性：接口侧与前端提示位**均已闭合**（缺口已闭合）。**
外部插件目录扫描会把失败/跳过记为 issue（`DiscoveryResult.issues`，见批次 B 的修正签名），日志里能看到（例：`[manager:discovery] 跳过插件目录 …（invalid_manifest）: … EACCES: permission denied`）。**本条曾被记为真实可观测性缺口**：在修复批之前，`GET /api/plugins` 只返回已注册条目（4 条内置），既不返回 issues、也不返回"有 N 个被跳过"的计数 → **API 与 UI 上完全看不出"有插件被跳过"**，即 L-11 / L-10-G2 修好之后残留的那半个问题：**不再崩溃，但也不可见**。**该半截已在修复批中闭合**（下条字段形状已按源码核对），本文保留此条作为"接口可见性"的契约锚点与前端待办的登记处。

- **裁决与现状**：曾记为**已知限制**并列入修复批——`GET /api/plugins` 带上机器可读的 `issues`。**现状：已落地并已核对源码**（见下条字段形状）。
- **字段形状（已回填，以源码为准；行号已按当前 HEAD 更正）**：`GET /api/plugins` → `ok(h, { plugins: manager.snapshot(), issues: manager.discoveryIssues() })`——**实现在 `packages/manager/src/index.ts:1417`**（旧稿写的 `packages/server/src/index.ts:1008` **是错的**：该文件当前只有 803 行，且 `/api/plugins` 路由由 manager 的 `registerRoutes()` 注册，server 只负责把路由服务挂上）；`issues` 元素类型为 `DiscoveryIssue`，即 `{ code, dir, message }` 三字段（`packages/manager/src/discovery.ts:28-40`）：`dir` 是**出问题的插件目录绝对路径**，`message` 是人类可读说明，`code` 为八值枚举 —— `'missing_manifest' | 'invalid_manifest' | 'entry_not_found' | 'invalid_plugin_path' | 'invalid_plugin_dir' | 'duplicate_plugin' | 'invalid_module' | 'load_failed'`。**没有 name 字段**（失败目录未必解析得出插件名）。管理器的 `discoveryIssues(): DiscoveryIssue[]` 在 `packages/manager/src/index.ts:368-370`（旧稿写的 `:310-311` 已错位，那里现在是 `uiTable()` 相关代码），数据源是 `config.discoveryIssues`（`packages/manager/src/index.ts:151` 声明、`:291` 由构造参数默认 `[]`）。该字段同时是"插件根目录不可读"的出口：`scanPluginDirs` 的 `readdirSync` 失败记 `code: 'invalid_plugin_dir'`、`message: 插件根目录不可读，已跳过全部外部插件: …`（`packages/manager/src/discovery.ts:184-190`）——与 L-10 的 G2 收敛为同一条路径。
- **兼容性提示与前端提示位（已落地，本轮核对更正）**：`GET /api/plugins` 的响应体新增字段属**向后兼容**。当时登记为"**前端"插件管理"页应增加"有插件被跳过"的提示位**，否则缺口只是从后端挪到前端"——**该提示位实际已在代码里**，项登记有误：`packages/web/src/pages/AdminPage.tsx:314` 的 `.discovery-issues` 区块渲染 `issues`，标题为"外部插件发现期有 N 条问题（这些插件未加载）"，逐条展示 `code`（`<code className="chip">`）/ `dir`（`.muted.small`）/ `message`（`.err-text.small`），样式见 `packages/web/src/styles.css:179-183`；`docs/roadmap.md` 的 Phase 4 条目 `[ ] 发现期 issues 的前端提示位` 已同步改为 `[x]` 并回填落点。**结论：L-14 已完全闭合**，本条目保留作为接口可见性的契约锚点。
- **另有一个新的可观测性出口（本批新增，与 L-14 互补）**：插件 **UI 入口表**的 `GET /api/plugins/ui` 响应带 `skipped: [{ name, reason }]`，`reason ∈ 'inactive' | 'no_client' | 'entry_missing' | 'invalid_name'`——这是"**插件在目录里、也注册成功了，但界面没起来**"的唯一机器可读出口（典型情形：声明了 `client` 却忘了跑 `build:fixtures` → `entry_missing`）。它与 `GET /api/plugins` 的 `issues` **职责不同**：后者是**发现/加载期**的失败（目录、清单、入口模块），前者是**UI 产物就绪性**。**⚠️ 本条旧表述"前端当前同样不展示它（`skipped` 只向后端调用方暴露）"已过时**——管理台现已展示（提交 `3bdcf4b`）：按 `classifyUiSkips()` 分级，`entry_missing` / `invalid_name` 为红系显著告警块 `.ui-skips-attention`，`inactive` / `no_client` 为可折叠 `<details>` `.ui-skips-normal`（`packages/web/src/pages/AdminPage.tsx:385-421`）。该展示需要一条 `force` 同步路径，原因是 `revision` **不含 `skipped`**——详见本节"**一个真实交互缺陷与修法**"行与 `docs/architecture.md` §6。

**L-15 无任何厂商 LLM adapter（本阶段有意不做）。**
`@geewiki/llm` 只交付了**契约层**（route→provider 注册表 + 终止保证 + 无 key 降级 + 密钥安全），**不含 OpenAI / Anthropic 等任何真实 provider**，且只注册了一个恒不可用的兜底路由 `null`（`NULL_PROVIDER`）⇒ **`availableProviders()` 恒为空，问答恒走 `retrieval-only`**。
**后果（必须如实理解）**：`@geewiki/ai` 的 `rag` 与 `rag-partial` 两条路径**目前仅有"假 provider"的单测覆盖**（测试里注入一个假的 `LlmProvider` 驱动终止保证与部分文本分支），**无任何真实模型链路验证**——"能接上真实模型"这件事**尚未被证明**。
**接线位置是唯一的**：`packages/plugin-ai/src/index.ts:261` 的 `generate()`。将来 adapter 批次需在此补齐"按需中断/超时、token 计量口径、SSE 增量外发"三件事（见 L-16）。
**不做的理由**：产品价值"没有 API key 时整条链路依然完整可用"这条契约**不需要 adapter 就能验证**；而"流式 SSE + 宿主排空"是更难的一层，混批会让两类缺陷互相掩盖。

> **修正（本批，2026-09-14）**：本条的三处断言按当前工作树订正。**本条不再描述现状**，保留只为记录当初的取舍理由。
>
> - "**`availableProviders()` 恒为空，问答恒走 `retrieval-only`**" ⇒ 两点都失效：`@geewiki/openai` 已在仓库里并登记进 `defaultRegistry()`（`packages/server/src/index.ts:1473`）与默认基础层清单，`retrieval-only` 这一档**连同 `extract.ts` 一起删除**（缺模型现在是 503 显式不可用）。仓库里出现的 `retrieval-only` 字样只剩源码注释中的历史说明。
> - "**唯一接线点是 `packages/plugin-ai/src/index.ts:261` 的 `generate()`**" ⇒ 该目录与函数均已不存在（`git status` 记为 `packages/plugin-ai/**` → `packages/plugin-ai-writing/**` + `packages/plugin-ai-qa/**` 的重命名）。生成经 `llm.stream()`，两个消费点：`packages/plugin-ai-qa/src/index.ts`、`packages/plugin-ai-writing/src/assist.ts`。
> - "**`rag` / `rag-partial` 仅有假 provider 的单测覆盖、无真实模型链路验证**" ⇒ 问答侧的边界行为（正常生成 / 上游 429 / 上游 200 但零 token / 检索 0 命中 / SSE 帧序列）已由 `data/verify/ai-split-e2e/` 的两个脚本在真实 HTTP + 真实浏览器上钉住，但那里的模型是**假上游**（要钉的就是这些不可控边界，真实上游给不给 429 无法复现）；真实模型链路的核对记录在 `docs/design/ai-plugin-split.md` §6.3。**L-15 是否整体摘除由 adapter 批次回填**——本批不判 adapter 的落地状态。
> - **仍然成立的部分**：`@geewiki/llm` 只有契约层（注册表 + 稳定错误码 + 终止保证 + 不重试 + 密钥只存环境变量名 + 脱敏），厂商实现是独立插件；`text-delta` 刻意不脱敏（脱敏会篡改模型输出）。

**L-16 流式（SSE）未做，且这是有意的——它与排空（drain）语义耦合。**
**⚠️ 状态更新（提交 `2273006`）：本条的"出口那一层"已铺好地基，仍未接线的只是真实的流式输出。** 已落地：`RouteHandlerContext.noteStatus?(status)`（只记指标、不结束响应）、`HttpRouterService.trackStream?(res)`（登记长连接，**该集合不参与排空计数**）、`HttpRouter.closeStreams()`（**注意：不在 `HttpRouterService` 接口上，是具体类方法**）、以及 `HttpPlugin.apply` 的五步 teardown。下面"不做的理由"一段**描述的是修复前的处境**，保留以记录问题本身。
当前 `@geewiki/search` 与 `@geewiki/ai` 的所有端点都是**一次成型返回**，没有任何 SSE / chunked 流式出口。**这一点仍未改变**——`packages/plugin-ai/src/index.ts:261` 的 `generate()` 依旧是唯一接线点。
**不做的理由是技术性的，不是排期问题**：`@geewiki/http` 的 `inflight()` 以"处理器尚未结算"为在途判据，而**一条长连接会在其存活期间被永久计入在途计数**。于是卸载/关停时的 `drain(drainTimeout × 1000)` 会**空转满 `drainTimeout`**、并打印**假的排空超时告警**（告警说"还有 N 个在途请求未结算"，而那 N 个正是设计上就该长期存在的流）。这条与 **L-1**（排空粒度是全站）叠加后症状更难分辨。
**因此 SSE 出口必须与排空语义一起设计**，方案三条：① 流式响应**登记为"不阻塞排空"**（不进入 `inflight()` 的结算等待集合）——**✅ 已落地**（`trackStream` 的 `activeStreams` 集合刻意不参与 `inFlight`；长连接之所以天然不占在途，是因为 `dispatch` 只在 `isThenable(result)` 为真时才把 `exitHandler` 挂到 Promise 结算上，故同步返回非 thenable 的处理器当拍结算）；② 配**硬超时 / idle 超时**兜住真正卡死的流——**❌ 仍未做**；③ `res.on('close')` 即**取消上游**（`AbortSignal` 传到 provider，契约侧已有 `opts.signal` 与 `ABORTED` 错误码支撑）——**❌ 仍未做**。
**⚠️ 另一条必须记的实测结论**：**不要**用"先 `res.writeHead(200, {'content-type':'text/event-stream'})` 再 `h.json(200, null)`"来实现"只记一次指标"——实测证伪：`writeHead` 后 `res.headersSent` 立即为 `true` 而 `writableEnded` 仍为 `false`，`json()` 会跳过 `writeHead` 却**仍无条件执行 `res.end(JSON.stringify(body))`**，给事件流追加字面 `null` **并立即终结流**（实测客户端正文 `event: status\ndata: {"type":"status"}\n\nnull`）。正解是用 `noteStatus()`。详见 `docs/architecture.md` §5.1.1(b)。
**推论**：`LlmService.stream()` 的**异步迭代式契约本身已经是为流式准备的**（终止 chunk 恰一次且在末位），缺的只是 HTTP 出口那一层——这也是本阶段就能把契约层独立交付的原因。

> **修正（本批，2026-09-14）**：**真实流式输出已接线**，本条"仍未做"的口径作废（保留原文以记录当初的推理）。逐条更正：
>
> - **已有人持续写帧**：`@geewiki/ai-qa` 的 `POST /api/ai/stream`（`packages/plugin-ai-qa/src/index.ts:931` 注册；实现层 `packages/plugin-ai-qa/src/sse.ts`）事件序列 `status → delta* → done | error`，**终止帧恰一次且在末位**。实测帧序列：正常 `status, delta×3, done`（`terminalCount:1` / `terminalIsLast:true`）；检索 0 命中 `status, done`（`done.answer:null`，**不发 `error`**——不是错误）；中途上游失败 `status, error`。**所有前置判定一律在写 SSE 头之前以普通 JSON 返回**（401 / 400 / 503），实测 `A_stream` 的 `content-type` 是 `application/json` 且 `frames:null`，空 `q` 与未知字段都是 400 JSON——**绝不用 SSE 表达"根本没开始"**，否则客户端分流会乱。
> - **上面方案 ②（硬超时 / idle 超时）已落地**：`STREAM_HARD_TIMEOUT_MS = 120_000`（`sse.ts:30`）、`STREAM_IDLE_TIMEOUT_MS = 30_000`（`:38`）、并发上限 `MAX_CONCURRENT_STREAMS = 4`（`:46`）；三者是**代码常量、刻意不进 `configSchema`**（理由见 `sse.ts` 文件头：并发上限与超时是运维口径，不是用户可调的产品选项）。
> - **方案 ③（`close` 即取消上游）已落地**：`res.on('close')` → `ac.abort()`（`packages/plugin-ai-qa/src/index.ts:784-786`，仅在 `!writableEnded` 时），超时同样走 `abort()`（`:771`），插件卸载时**先 `abort()` 上游再 `end()` 连接**（`:304` 的注释记录了理由：只关连接不停上游 ⇒ 请求仍在跑并计费）。`AbortSignal` 经 `llm.stream({ signal })` 透传（`:331` / `:348-350`，刻意"没给 signal 就不传第二参"以免被误读为已支持取消）。
> - **出口地基没有被绕过**：流式处理器**同步返回非 thenable**（`packages/plugin-ai-qa/src/index.ts:931-936` 注册处的注释明文记录），故仍走"当拍结算、长连接不占排空在途"那条已验证的路；上面那条 `writeHead` + `h.json(200, null)` 的证伪结论继续有效。
> - **一处本篇批次 H 的行需按 HEAD 更正（非本批改动，此前未回填）**：`trackStream` 现在带 owner——`HttpRouterService.trackStream?(res, owner?)`（`packages/core/src/index.ts:749`）与 `closeStreams?(owner?)`（`:761`）**都在服务接口上**（批次 H 表里写的"`closeStreams` 不在 `HttpRouterService` 接口上、是具体类方法"已不成立），另新增 `noteStreamRejected?()`（`:772`）与 `HttpStreamStats`（`:670`，`streams.active` / `streams.rejected`）。语义：**未登记 owner 的连接无法被定向回收**（显式后果，不是静默行为），管理器卸载单插件时按 owner 收流（`packages/manager/src/index.ts:1468` 的 `router.closeStreams(name)`），路由服务自身关停时收全部（`packages/server/src/index.ts:1206`）；`@geewiki/ai-qa` 注册时传的是自己的插件名。
> - **仍未做（本批范围外，如实登记）**：硬/idle 超时的**注入式回归用例**是否覆盖到每一种触发条件，本批未复核；SSE 断连后的**客户端重连语义**（`Last-Event-ID` 之类）不存在——问答是"一次提问一条流"，重连即重新提问。

**L-17 向量 / 语义检索未做（有意后置），检索是纯字面匹配。**
当前检索链路为 **FTS5 trigram 子串匹配 + <3 字符的 LIKE 兜底**（见 §2.4），**没有任何 embedding、向量库或语义召回**。
**不做的理由是环境约束**：本项目的立身之本是"离线 + 零重依赖 + 开箱即用"（默认只依赖一个 SQLite 文件）。本地跑 embedding 需要**预烤模型权重 + ONNX Runtime WASM 运行时**，两者都会把"`pnpm install` 即可运行"变成"先下载几百 MB 模型"；调用远端 embedding API 则与"没有 API key 也完整可用"的产品承诺直接冲突。
**后果（如实登记）**：**同义改写、跨语言、模糊表述一律搜不到**（搜「怎么备份数据」不会命中「数据备份指南」）。当前只留接口位（`search-service` 是唯一检索入口，将来换实现不影响消费方）。

**L-18 `snippet` 是已转义的 HTML、`score` 只在同次查询内可比——两条都是跨包契约，消费方必须遵守。**
- `snippet` 由 `@geewiki/search` 的 `buildSnippet()` **服务端转义**（正文先按原始下标切片、三段分别 HTML 转义、再拼进 `<mark>`），**只含 `<mark>` 一种标签**。⇒ 前端**不得二次转义**（会显示成字面 `&lt;mark&gt;`），也**不得**当纯文本插入页面（那样高亮会消失）。该设计的价值是：正文里的 `<script>` **不可能逃逸成真标签**。
- `score` 是 FTS 路**取负后的 BM25**（越大越相关）。**这不是归一化**——值域无界、量级随语料规模与查询词变化，故**只在同一次查询的结果内部可比**；LIKE 路恒为 `0`，**两种 `mode` 的 `score` 也不可比**。消费方不得跨查询、跨 `mode` 比大小，也不得把它当"百分比相关度"展示。
- 附：**自实现高亮而非用 FTS5 的 `snippet()`**——trigram 下后者的上限约 64 token（≈ 中文 64 字），太短且会把片段切得很碎（`packages/plugin-search/src/index.ts:170-178`）。

**L-19 `search` / `ask` 是 wiki 下的保留首段 slug。**
`#/wiki/search/<q>` 与 `#/wiki/ask/<q>` 占用 `search` / `ask` 两个**首段 slug**，判据在 `packages/web/src/pages/WikiPage.tsx:37` 的 `allowedSecond`（`seg[1] === 'edit' || first === 'search' || first === 'ask'`）。⇒ 用户**不能再创建名为 `search` 或 `ask` 的页面**（也不能建 `search/edit` 这类路径）；服务端 slug 校验**不会**拦截它们，冲突只在前端路由层显现。这是**主动付出的代价**：换取的是"可分享、刷新不丢"的 hash 子路由，而无需引入前端路由库或改动 Slot 机制。

**L-20 密钥的剩余边界：环境变量由运维设置；`redact` 是启发式且刻意不脱敏模型输出。**
- 配置里只存**环境变量名**（`apiKeyEnv`），**环境变量本身由运维在外部设置**——本系统不负责密钥的注入、轮转与保管。
- `GET /api/plugins/:name/config` 对**普通配置字段**仍**明文返回**（该边界此前已记录，见 L-14 同批的 ③ 与 `docs/architecture.md` §5.7）；`apiKeyEnv` 只是变量名，故**不构成泄漏**——但若有人无视 `detectSuspiciousCredential` 的拦截把密钥值硬写进**其它**普通字段，它会明文出现在该端点响应里。
- `redact()` 是**启发式**（`packages/plugin-llm/src/redact.ts` 的三条正则源 + 头名遮蔽）：**未覆盖的密钥形态不会被脱敏**。设计取向是"**宁可漏判不可误伤**"——把 `DEEPSEEK_API_KEY` 这类变量名误判成密钥会让插件**无法激活**（配置明明是对的），而漏判只是少脱敏一处日志，故全大写 SNAKE 命名一律放行。
- **`text-delta`（模型输出）刻意不脱敏**：脱敏会**篡改模型输出内容**。若模型自己复述了密钥，它会被原样透传——这是有意的取舍，不是遗漏。

## 6. 当前质量基线

### 6.1 当前口径（SSE 出口与优雅排空共存批次落地后实跑）

**命令**：`pnpm -r --no-bail --if-present run test` 与 `pnpm -r --if-present run typecheck`。

**本小节给两个读数：读数 C = 已提交状态（HEAD `3bdcf4b`）；读数 D = 工作树含并行批次未提交的新包。二者都是真读数，差别只来自那一个未提交的包。**

**读数 C（已提交状态 HEAD `3bdcf4b`）——266/266，7 个包**

- **取值时刻 `2026-09-11T00:29 +08:00`**（测试与逐文件复核 `00:29`–`00:30`）。
- **HEAD `3bdcf4b`**（`feat(web): 管理台展示被跳过的插件 UI 入口，依赖阻止停用给专门说明`），工作树**在本读数开始时干净**。
- 相对读数 B 的 **251 → 266（+15）**，全部来自两个已提交批次：`packages/server` **24 → 30**（新增 `sse-drain` **6** 例，提交 `2273006`）、`packages/web` **38 → 47**（`pluginUiPlan` **19 → 28**，+9，提交 `3bdcf4b`）。

| 包 | 用例数 | 通过 | 失败 | 逐文件明细 |
| --- | --- | --- | --- | --- |
| `packages/manager` | **91** | 91 | 0 | `config` 36 + `deps` 10 + `discovery` 13 + `manager` 14 + `plugin-ui` 15 + `repo-paths` 3 |
| `packages/web` | **47** | 47 | 0 | `pluginUiPlan` **28** + `searchPlan` **19** |
| `packages/plugin-llm` | **33** | 33 | 0 | `service` 24 + `redact` 9 |
| `packages/plugin-search` | **32** | 32 | 0 | `search` 32 |
| `packages/server` | **30** | 30 | 0 | `router` **11** + `plugin-ui-static` **10** + `registry` **3** + `sse-drain` **6** |
| `packages/plugin-ai` | **25** | 25 | 0 | `ai` 25 |
| `packages/plugin-wiki` | **8** | 8 | 0 | `service` 8 |
| **合计（7 个包）** | **266** | **266** | **0** | — |

逐文件计数用 `node --import tsx --test <单文件>` 在各包目录下复跑核对：`packages/server/test/` 的 `router.test.ts` **11** / `plugin-ui-static.test.ts` **10** / `registry.test.ts` **3** / `sse-drain.test.ts` **6**（合 30 ✓）；`packages/web/test/` 的 `pluginUiPlan.test.ts` **28** / `searchPlan.test.ts` **19**（合 47 ✓）。

**读数 D（工作树，含并行批次未提交的 `packages/plugin-openai/**`）——308/308，8 个包**

- **取值时刻 `2026-09-11T00:38 +08:00`**（类型检查 `00:39`）。
- **代码状态 = 工作树**：HEAD 仍是 `3bdcf4b`，但工作树含并行批次对 `packages/plugin-openai/**`（**未跟踪**）、`packages/server/package.json`、`packages/server/src/index.ts`、`pnpm-lock.yaml` 的**未提交**改动。
- **读数 C 的七包在读数 D 中逐包完全相同**，唯一新增的是 `packages/plugin-openai` **42**（`errors` **7** + `plugin` **8** + `provider` **16** + `sse` **11**）。故 **8 个包、308/308**（fail 0 / skipped 0）。
- `pnpm typecheck`：**读数 D 时刻全量运行通过，11 个包全部 `Done`、0 个 `error TS`**。

> **注（并行批次，务必勿计入）**：`packages/plugin-openai`（OpenAI 兼容 LLM adapter，第一个真实 provider）截至取数时刻**尚未提交**。工作树中 `packages/server/src/index.ts` 的 `defaultRegistry()` 已加入 `@geewiki/openai` 条目（`provides` 无、`requires` 点名 `llm-service`、`conflictGroup: 'llm-provider'`、**只登记不入默认基础层清单**），但**该改动同样未提交**。**不得据此认为厂商 adapter 已落地**；该批次提交后必须重跑并复核本小节。

**⚠️ 一条必须记档的瞬态现象（避免把"读工作树"的中间态误判为缺陷）**：在**读数 C 时刻**（`00:29`），`pnpm -r --if-present run typecheck` 的**全量运行整体失败**，唯一原因是并行批次**当时**新建的 `packages/plugin-openai` 尚不完整——其 `tsconfig.json` 的 `include` 为 `["src","test"]` 而 `test/` 目录尚不存在，报 `error TS18003: No inputs were found in config file '/root/dev/geewiki/packages/plugin-openai/tsconfig.json'. Specified 'include' paths were '["src","test"]' and 'exclude' paths were '[]'.`，pnpm 随即以 `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @geewiki/openai@0.1.0 typecheck` 中止。当时以 `pnpm -r --if-present --filter '!@geewiki/openai' run typecheck` 复跑，**其余 10 个包全部 `Done`、0 个 `error TS`**（即已提交的代码状态是"10 个包 0 错误"）。该错误随并行批次补齐 `test/` 而**自行消失**：`00:39` 复跑即为 11 个包全绿。**这不是已提交代码的缺陷**，而是并行写入期的中间态——**报告任何读数都必须同时给出 HEAD 与取数时刻**。

没有 `test` 脚本的包：`packages/core`、`packages/db-sqlite`、`packages/plugin-echo`、`plugins/hello-geewiki`；`plugins/hello-geewiki` 亦无 `typecheck` 脚本。

#### 历史读数（均已过时，保留备查）

以下读数 A / B 记录的是一次并行批次的**中途状态**，其结论已由下述提交落地并被读数 C 取代。保留它们是为了说明"为什么两个读数都是真读数"以及用例数的演进路径。

- **读数 A（已提交状态）**：**取值时刻 `2026-09-10T23:24 +08:00`**（测试 `23:24:15`、类型检查 `23:24:46`），**HEAD `585dbac`**，工作树干净。**已过时**。
- **读数 B（工作树，含并行批次改动）**：**取值时刻 `2026-09-10T23:35 +08:00`**（测试 `23:35:15`、类型检查 `23:35:29`），**HEAD 仍是 `585dbac`**，但工作树含并行批次对 `packages/plugin-search/**` 与 `packages/plugin-ai/**` 的**未提交**改动。**该批次的改动随后落为提交 `04c45c3`**，故读数 B 的 `plugin-search` 32 / `plugin-ai` 25 已被读数 C 继承为**稳定值**，不再是"待复核"的不稳定读数。**已过时**。

**读数 A（HEAD `585dbac`，工作树干净）——242/242，7 个包**（**历史读数，已过时**）

| 包 | 用例数 | 通过 | 失败 | 逐文件明细 |
| --- | --- | --- | --- | --- |
| `packages/manager` | **91** | 91 | 0 | `config` 36 + `deps` 10 + `discovery` 13 + `manager` 14 + `plugin-ui` 15 + `repo-paths` 3 |
| `packages/web` | **38** | 38 | 0 | `pluginUiPlan` 19 + `searchPlan` **19** |
| `packages/plugin-llm` | **33** | 33 | 0 | `service` 24 + `redact` 9 |
| `packages/plugin-search` | **25** | 25 | 0 | `search` 25 |
| `packages/server` | **24** | 24 | 0 | `router` 11 + `plugin-ui-static` 10 + `registry` 3 |
| `packages/plugin-ai` | **23** | 23 | 0 | `ai` 23 |
| `packages/plugin-wiki` | **8** | 8 | 0 | `service` 8 |
| **合计（7 个包）** | **242** | **242** | **0** | — |

**读数 B（工作树含并行批次改动）——251/251**

**只有两个包变化，其余五包与读数 A 逐包相同**：

| 包 | 读数 A | 读数 B | 差值 |
| --- | --- | --- | --- |
| `packages/plugin-search` | 25 | **32** | **+7** |
| `packages/plugin-ai` | 23 | **25** | **+2** |
| 其余五包（manager / web / plugin-llm / server / plugin-wiki） | 91 / 38 / 33 / 24 / 8 | 91 / 38 / 33 / 24 / 8 | 0 |
| **合计** | **242** | **251** | **+9** |

`pnpm typecheck`（两次读数一致）：**`Scope: 10 of 11 workspace projects`，全部 `Done`，0 个 `error TS`**。第 11 个 workspace 项目是 `plugins/hello-geewiki`，**没有 `typecheck` 脚本**，被 `--if-present` 跳过。没有 `test` 脚本的包：`packages/core`、`packages/db-sqlite`、`packages/plugin-echo`、`plugins/hello-geewiki`。

> ⚠️ **读数 B 里的 `plugin-search` / `plugin-ai` 两行曾被标为"待并行批次落地后复核"的不稳定读数。该批次已落地为提交 `04c45c3`（词元 OR 检索修复），两行现已由读数 C 复核为稳定值（32 / 25）；本注保留以记录当时的判据。**

**相对读数 A 之前的 134/134 口径的三处结构性变化，勿混用**：

1. **测试覆盖的包从 3 个扩到 7 个**——本轮起 `packages/plugin-search`、`packages/plugin-llm`、`packages/plugin-ai`、`packages/plugin-wiki` 四个包**拥有单测**（此前只 web / manager / server 三包）。新增的 108 例 = manager 91 + server 24 之外的 `web` +19、`plugin-llm` +33、`plugin-search` +25、`plugin-ai` +23、`plugin-wiki` +8。
2. **根 `package.json` 的 `test` 脚本新加 `--no-bail`**——此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行，故更早的"全量绿"读数可能是**部分**读数。**这条对历史数字的解释力有影响**：过去某个包变红时，排在它后面的包不会被跑到，读数会"看起来更绿"。
3. **口径可复核性**：逐文件计数用 `node --import tsx --test <file>` 单独跑取 `# pass`；也可静态复核 `git show HEAD:<file> | grep -cE "^test\("`。

> ⚠️ **曾登记的"待并行批次复核"事项已闭合**：读数 A 的 `plugin-search` 25 / `plugin-ai` 23 与读数 B 的 32 / 25 是并行批次的中途状态；该批次已在提交 `04c45c3` 落地并复核（读数 C 的 32 / 25）。本注保留以记录当时的判据。

### 6.2 历史端到端验收基线

本节记录一次完整端到端验收结果，作为后续批次回归的比较基准。**验收时点**：治理批修复的未提交工作树，该修复随后落为提交 `ed826b5`（`fix(manager): consume drainTimeout on unload, unify 413 path, decouple cwd and add router tests`），即该提交的代码状态即本节口径。**手段**：headless Chrome（CDP）驱动运行中的应用，全部交互为**真实 DOM 事件**（原生 `click` 与 `input` 事件，非直接调用接口）；脚本与产物在 `data/spike/e2e/`（`cdp.mjs` / `wiki-ui.mjs` / `phase2.mjs` / `phase3.mjs` / `phase4.mjs` 及抓取的 DOM 快照，`data/` 已被 gitignore）。

**通过项**

| 项 | 结果 |
| --- | --- |
| 4 条路由可达并渲染正确 DOM | `/`、`#/wiki`、`#/plugins`、`#/graph` 全部通过 |
| `#/graph` 依赖图 | 渲染出 **4 个 `.flow-node`** + **3 条依赖边**（DOM 快照中 `react-flow__edge-path` 计数为 3）+ SVG 画布 |
| 新建 → 编辑 → 读取闭环 | **真实 DOM 事件驱动**的点击与输入；版本号 **v1 → v2** 递增、历史版本行出现；服务端 `GET /api/pages/<slug>` 交叉验证返回 `version: 2` |
| 插件管理交互 | **停用请求耗时 3 ms**（修复前约 **5000 ms**，原因是排空自计数）；REST 直接计时 0.7–1.2 ms；UI 状态与 `GET /api/plugins` 一致 |
| console 洁净度 | 无任何错误 / 未捕获异常，无失败请求，无 4xx / 5xx；无 React 告警（无 key 缺失、无受控组件告警） |
| 清理 | 测试页面已删除，`GET /api/pages` 复原为空，`config/plugins.base.json` md5 未变 |

**测试口径（本轮回填，已实跑）**：**⚠️ 本小节整节（含下表 134/134）已被 §6.1 的 242/242 取代，保留以便追溯。** 上述 UI 基线是**提交 `ed826b5` 的代码状态**；插件平台批次 A–D 落地后测试集合已扩张，且**当时全绿**——以 `pnpm test`（`pnpm -r --if-present run test`，**当时**实际跑到 `packages/web` / `packages/manager` / `packages/server` 三个包，各自的 `test` 脚本都是 `node --import tsx --test test/*.test.ts`）实跑为准。**本段按 HEAD `88e0c58` 取值**（下表同）：

| 包 | 用例数 | 通过 | 失败 |
| --- | --- | --- | --- |
| `packages/web` | **19**（1 个测试文件：`pluginUiPlan` 19） | 19 | 0 |
| `packages/manager` | **91**（6 个测试文件：`deps` 10 + `manager` 14 + `config` 36 + `discovery` 13 + `plugin-ui` 15 + `repo-paths` 3） | 91 | 0 |
| `packages/server` | **24**（3 个测试文件：`registry` 3 + `router` 11 + `plugin-ui-static` 10） | 24 | 0 |
| **合计** | **134** | **134** | **0** |

**`packages/web` 自本轮起首次拥有单测**——此前本节表格只有 manager / server 两行，且文档多处写"web 无测试"。它的测试入口是 `node --import tsx --test test/*.test.ts`（`packages/web/package.json` 的 `test` 脚本，`tsx` 作为 devDependency 提供 TS 装载）；之所以能跑，是因为可判定逻辑被挤进了不接触 `window` 的纯函数模块 `packages/web/src/lib/pluginUiPlan.ts`（`pluginUi.ts` 顶层就写 `window.__GEEWIKI_PLUGIN_UI__`，在 node 里 import 会直接 `ReferenceError: window is not defined`）。

逐文件口径：

- `packages/web/test/`：`pluginUiPlan.test.ts` 19 例（常量与后端契约一致、`isPluginUiName` 合法/非法名表、`pluginUiBase` 同源绝对 URL 与非法名返回 `undefined`、`parseUiTable` 整体/逐条不可信分支、`planUiSync` 差集与排序（含 `rev` 变化同时进出两数组）、`isUiSettled` 收敛判定）—— 合计 **19**。
- `packages/manager/test/`：`deps.test.ts` 10 例、`manager.test.ts` 14 例、`config.test.ts` 36 例、`discovery.test.ts` 13 例、`plugin-ui.test.ts` 15 例（入口表纯函数：双根优先级、存在性判定、`skipped` 四类原因、`revision` 稳定性、`rev` 随 `mtime`/大小变化）、`repo-paths.test.ts` 3 例 —— 合计 **91**。
- `packages/server/test/`：`registry.test.ts` 3 例（`buildRegistry` 内置 4 + 外部合并 / `pluginsRoot` 为 `null` / 目录不可用）、`router.test.ts` 11 例（drain 空闲、在途、超时、多等待者、回归自计数；inflight 结算；404 与静态交接不计在途；REST 卸载两类；wiki 413 计入 stats；`ServerOptions.port` / `host`）、`plugin-ui-static.test.ts` 10 例（`/plugins-ui` 静态层：命中与 MIME、未知插件、路径穿越、目录式路径、编码插件名、非单段文件名、**绝不 SPA fallback**，"高优先级根消失后回退次优先根且入口表 `rev` 等于此刻真正被服务的文件"的回归例，以及提交 `88e0c58` 新增的 2 例——**app shell 根与插件 UI 资产根分离后各司其职**（appRoot 只有 `index.html`、uiRoot 只有 `plugins-ui/<名>/client.js`，首页必须 200 且正文来自 webDist、资产必须 200 且正文来自 pluginUiDist、入口表 `rev` 指向 pluginUiDist 那份）与**未配置 `pluginUiDist` 时回落 `webDist`**（拆分不改变既有行为））—— 合计 **24**。

> **注意（本轮已闭合的历史口径）**：上一版此处曾警告"工作树中存在**未提交的并行批次**（新增 `packages/manager/test/plugin-ui.test.ts`、在 `config.test.ts` 追加 `GET /api/plugins/ui` 用例），那些用例不属于本节口径"——**该并行批次已提交**（`02dfb5f` / `4ca8ed7` / `a24241a`），其用例（manager 的 `plugin-ui` 15 例 + `config.test.ts` 追加的 3 例 + server 的 `plugin-ui-static` **当时 8 例**（提交 `88e0c58` 又 +2，见上表）+ web 的 19 例）**现已全部计入上表**，不再需要排除。若需静态复核，`git show HEAD:<file> | grep -cE "^test\("` 可与上表逐文件核对。

**已过时口径（保留以便追溯，勿再引用）**：上一版此处记录的是"manager **73** 例 / server **14** 例、合计 **87/87**"（**已过时**，87 = `deps` 10 + `manager` 14 + `config` 33 + `discovery` 13 + `repo-paths` 3 + `registry` 3 + `router` 11；当时 web 与 `plugin-ui` / `plugin-ui-static` 三个测试文件尚未计入）。再之前是"manager **67** 例 / server **14** 例、合计 **81/81**"，再之前"manager **39** 例 / **37** 过 / **2** 失败、server **11/11**"。那两个失败用例是**尚未随新契约更新的旧断言**，不是新代码缺陷，现均已改写：

- `packages/manager/test/config.test.ts`『updateConfig：未声明 schema → config_not_supported』——旧契约要求无 schema 插件改配置返回 400 `config_not_supported`；新裁决反转为"接受并保存原始 JSON"（见批次 C 与 `docs/architecture.md` §5.7）。**已改写**为新契约用例『updateConfig：未声明 schema → 按 JSON 原文透传（不校验、不裁剪），已激活同样热更新』（`packages/manager/test/config.test.ts:220`）。
- `packages/manager/test/config.test.ts`『REST：GET/PUT /api/plugins/:name/config 的状态码与响应形状』——旧断言 `assert.equal(got.body['layer'], null, '未激活 → 无层')`（`:305`）与最终裁决冲突：`layer` 现为**持久化层**（从未持久化时落 `'base'`，类型 `Layer` 非空），"未激活"改由 `activeLayer: null` 表达。**已改写**：文件头注释第 8 条明确"`layer`（持久化层）与 `activeLayer`（激活层）两个维度"，并新增用例『`configOf`：layer = 持久化层、`activeLayer` = 激活层（基础层激活 / 会话层激活 / 未激活三态）』（`:445`）。
- 另外新增了会话层叠加用例（『boot 叠加：基础层 + 会话层并存时，会话层配置作为覆盖层生效』）与外部插件发现用例（`discovery.test.ts` 13 例，含『`parsePluginManifest`：`package.json` 的 `geewiki` 键优先』`discovery.test.ts:54`、『`resolvePluginEntry`：显式 entry 优先，其后 `index.ts` → `index.js` → `src/index.ts`』）。

因此 `README.md` / `docs/roadmap.md` 中出现的 35/35 是**历史时点口径**；134/134 亦已作废，**当前口径为 §6.1 的 242/242**（当时 134/134 相对 132/132 的 +2 例来自提交 `88e0c58` 的 `plugin-ui-static` 回归用例）。**旧文残句（供检索）：15/15、35/35、72/72、81/81、87/87、132/132、134/134**（**全部为历史口径**，134/134 已被 242/242 取代）。

**遗留项**：见第 5 节 **L-7**（React Flow 授权提示）与 **L-8**（详情页「← 返回列表」走 `history.back()`）。

**基线口径说明**：本节的 3 ms 是"客户端观测到的停用请求耗时"，不是服务端 P99；`data/geewiki.db` 为本地验收库，验收后页面已清空但库文件本身不参与版本控制。

## 7. 验证纪律

每一批交付必须同时满足：

1. `pnpm typecheck` **0 错**；
2. `pnpm test` **全绿**，且包含该批新增用例。**本项有两个实测读数（见第 6.1 节）**：**读数 C（已提交状态 HEAD `3bdcf4b`，`2026-09-11T00:29 +08:00`）：266/266 全绿，覆盖 7 个包** —— `packages/manager` **91**（`config` 36 + `deps` 10 + `discovery` 13 + `manager` 14 + `plugin-ui` 15 + `repo-paths` 3）+ `packages/web` **47**（`pluginUiPlan` **28** + `searchPlan` **19**）+ `packages/plugin-llm` **33**（`service` 24 + `redact` 9）+ `packages/plugin-search` **32**（`search` 32）+ `packages/server` **30**（`router` **11** + `plugin-ui-static` **10** + `registry` **3** + `sse-drain` **6**）+ `packages/plugin-ai` **25**（`ai` 25）+ `packages/plugin-wiki` **8**（`service` 8）；**读数 D（工作树含并行批次未提交的 `packages/plugin-openai/**`，`2026-09-11T00:38 +08:00`）：308/308 全绿，覆盖 8 个包** —— 读数 C 的七包**逐包完全相同**，仅新增 `packages/plugin-openai` **42**（`errors` 7 + `plugin` 8 + `provider` 16 + `sse` 11）。逐文件口径见第 6.1 节；`pnpm typecheck`：**读数 D 时刻全量运行通过，11 个包 0 个 `error TS`**（读数 C 时刻同一命令曾因并行批次**当时**尚不完整的 `packages/plugin-openai` 报 `error TS18003: No inputs were found` 而整体失败，以 `--filter '!@geewiki/openai'` 复跑得 10 个包 0 错误；该错误随并行批次补齐 `test/` 自行消失——详见第 6.1 节的注）。**⚠️ `packages/plugin-openai` 尚未提交**，不得据此认为厂商 adapter 已落地。**历史读数（已过时，保留备查）**：读数 B（工作树含并行批次改动，`2026-09-10T23:35 +08:00`）251/251；读数 A（已提交状态 HEAD `585dbac`，`2026-09-10T23:24 +08:00`）242/242；两者的 `plugin-search` 25 / 32 与 `plugin-ai` 23 / 25 已随提交 `04c45c3` 收敛为 32 / 25。 **命令是 `pnpm -r --no-bail --if-present run test`——`--no-bail` 为本阶段新加**，此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行，故更早的"全量绿"读数可能是**部分**读数。**历史时点**：134/134（3 个包，**已过时**）；132/132（server 22，提交 `88e0c58` 前，**已过时**）；87/87（manager 73 + server 14，web 与 `plugin-ui*` 尚未计入，**已过时**）；81/81（manager 67 + server 14）；基线提交 `ed826b5` 为 **35/35**（manager 24 + server 11）；其后修复批一度出现 manager **39 例 / 37 过 / 2 失败**（两条旧断言尚未随新契约更新：`layer` 语义反转、无 schema 插件改为接受原始 JSON），**现已全部改写完成**；
3. **隔离端口**的端到端冒烟（不得占用开发用的 3000 / 5173）；
4. 涉及 UI 的批次必须有**浏览器端到端验收**（真实渲染，而非接口断言）；
5. **每批先经独立 Reviewer 审查，再提交**；
6. 本文档中未经验证的假设必须在落地时补上验证结果，或改标注。**当前待验证项已收敛为**：①第 4 节批次 C 的 `configSchema` 契约迁移（方案甲/乙）**已按方案甲落地并核对源码**（`packages/core/src/index.ts:30` / `:95`、`packages/plugin-wiki/src/index.ts:27-33`、`packages/plugin-echo/src/index.ts:22-26`；`packages/core` / `packages/manager` / `packages/plugin-wiki` / `packages/plugin-echo` 四者均声明 `"schemastery": "3.18.0"`）；`layer`（持久化层）/ `activeLayer`、`requiresRestart`、发现期 `issues` 已**落地并核对源码**，原子写已内联在 `writeList()`（见 D-2）；批次 D 的**宿主侧** Slot 亦**已落地**（`packages/web/index.html` 的 import map + `packages/web/src/lib/hostSdk.ts` + `packages/web/public/host-sdk/` 薄 shim + `packages/web/src/lib/pluginUi.ts` 加载器 + `packages/web/fixtures/`），**且本轮补齐了两项此前列为未落地者**：入口表**已改由后端下发**（`GET /api/plugins/ui`，见批次 D 与第 9 节）、**已绑定 fork 生命周期**（`AdminPage.load()` + `startPluginUiSync()`，UI 随插件启停自动出现/消失）；**仍未落地的只剩**后端 `ctx.slot()` 注册链路与 Suspense / use Hook 懒加载（见 `docs/architecture.md` §6 的已知边界）；②批次 B 的 **G-1 / G-2** 与批次 C 端点表中的**未落地部分**为设计定稿；③第 5 节 **L-10** 表格中 G1 / G2 / G3 均**已修且含镜像重建实跑**、G4 为决策已落地；**L-14 的 `issues` 形状已按源码回填，剩余待办只剩前端提示位**；④批次 E 整体延期（见 L-9），其 `GeeWikiMeta.migrations` 双路径改造登记为落地前置条件；⑤**`meta.role: 'password'` 脱敏输入框已实现**（表单侧 `type="password"`，但 API 返回的 `config` 仍是明文原值），`hidden` 语义已支持，见第 9 节。**已不再列为待验证**：清单双来源优先级（已裁决且有测试钉住，见批次 B）、Kysely 选型（已裁决"不建议引入"，见 L-9⑥）、`bitset` 控件（已裁决"暂保留降级"，见 L-13）、D-2 原子写（已内联在 `writeList()`，`packages/manager/src/index.ts`）；
7. **UI 交互类交付须对齐第 6 节的基线口径**：console 零错误、无失败请求、真实 DOM 事件驱动，并在验收后清理测试数据。

## 8. 复现内核实证（第 2 节）

`data/spike/` 被 `.gitignore` 排除，若该目录已被清理，可从零重建：

```bash
mkdir -p /tmp/geewiki-spike && cd /tmp/geewiki-spike
npm init -y && npm pkg set type=module
npm i cordis@4.0.0-rc.10 schemastery@3.18.0
# 按本文第 2 节各条的证据标注重建对应探针（fork.update 序列、internal/update 钩子、
# schemastery 载荷往返与载荷规格、ESM 动态加载与 ?v=mtime 缓存击穿）
node probe-xxx.mjs
```

要求：Node ≥ 22（本机实证版本 `v22.23.2`）；探针需在**独立目录**执行，避免污染工作区依赖。
S-7…S-17 的载荷规格另可用 `data/spike/probe4-payload-spec.mjs` / `probe5-identity.mjs` / `probe6-labels.mjs` / `probe7-graph.mjs` 直接复跑（对应产物 `probe{4,5,6,7}.out` 含原始载荷 JSON）。

## 9. 事实核对记录

本文在初版写作与后续增补中，均对照仓库代码 / 实跑结果复核了给定的技术事实，差异与补充如下（**以仓库代码 / 实跑结果为准**）：

| 项 | 给定说法 | 实跑结果 | 处理 |
| --- | --- | --- | --- |
| 裸绝对路径 import | "Linux 下裸绝对路径可用，但含 `#`/`?` 时失败" | 普通路径确实成功；含 `#`/`?` 时抛 `ERR_MODULE_NOT_FOUND` | 保留，并在 L-1 中写成"统一走 `pathToFileURL()`" |
| `internal/update` 注册在 root | "注册在 root 收不到" | 独立复现确认：root 钩子不触发，`apply#2` 照常执行 | 采纳（F-6） |
| `simplify` 是实例方法 | "`schema.simplify(value)`，不是 `Schema.simplify`" | 实跑确认静态调用抛 `TypeError: Schema.simplify is not a function` | 采纳（S-5） |
| `schemastery` 依赖 | 选型 `schemastery@3.18.0` | 初版核对时工作区 `packages/*` **尚未声明**该依赖，只在 `data/spike/` 独立环境中安装；**当前已正式声明**：`packages/core/package.json` / `packages/manager/package.json` / `packages/plugin-wiki/package.json` / `packages/plugin-echo/package.json` 均为 `"schemastery": "3.18.0"` | 第 2.2 节开头的"工作区尚未声明"已按现状修正；批次 C 的加依赖待办**已闭合** |
| `drainTimeout` 消费 | 能力 ④ 列出"`drainTimeout` 消费"待补 | **已落地**：`packages/manager/src/index.ts` 的统一卸载出口按 `runtime.drainTimeout` 排空 | 第 1 节状态改为"已落地"，与 roadmap Phase 4 的说明一致 |
| `conflictGroup` 替换交互 | 能力 ④ 列出待补 | **已落地**（提交 `42db76a`，后经 `2227adf` 补强前置校验、`b21534a` 补强前端交互）：`POST /api/plugins/:name/replace` + `collectDependentsClosure` + 管理台顶替确认框；隔离实例实测 200 替换 / 409 `conflict_group` 探测 / 409 `base_layer`（旧插件在基础层），浏览器 CDP 实测确认框与成功提示。**前置校验已收紧为三类拒绝**（均在零副作用阶段）：① 旧插件**真实激活层**（`managed.layer`，**非** `layerOf()`）非 session → 409 `base_layer`；② 卸载集合（旧插件 ∪ 活跃传递依赖方）内任一成员真实激活层非 session → 409 `base_layer` + `details.plugins`（`packages/manager/src/index.ts` 的 `const baseLayerMembers = unloadSet.filter((n) => this.plugins.get(n)?.layer !== 'session')`）；③ `requires` 的边经 `resolveDependency` 解析后指向被顶替者、而目标无法承接（目标插件名与 `provides` 均不命中）→ 409 **`provider_mismatch`**（纯函数 `packages/manager/src/deps.ts` 的 `findUncoveredRequires(registry, replaced, target, names)`，`details = {plugin, token, target, targetProvides, violations}`），**目标自身依赖被顶替者同样被拒**（`index.ts` 的 `const selfRequiresConflict = (m.requires ?? []).filter((t) => resolveDependency(this.config.registry, t)?.name === conflict)`，`details = {plugin, tokens, target, conflict}`，不给"目标恰好 provides 同名 token"的豁免） | 更新为已实现（G-1），并把"依赖方会被卸载并接回新提供者"的旧表述改三类拒绝口径；**对外影响已写明**：依赖方按**具体插件名**依赖被顶替者时该替换被 409 拒绝，正解是改为依赖服务标识（`provides`）；`fail()` 无显式映射表、`provider_mismatch` 在条件链里归 409 |
| 前端 Slot 单例共享 | 初版 D-4 写"宿主用 import map 暴露 react 单例" | **勘察证伪**：`react@19.2.8` 无任何 ESM 产物（`exports` 只有 `react-server`/`default`）、宿主产物已内联 react（`packages/web/dist/assets/index-DyngNpzw.js`）、dev 的 `?v=<hash>` 会造成实例分裂 | **改写**：D-4 保留其余结论并指向新增 **D-8**（宿主 `window.__GEEWIKI_HOST__` SDK + 薄 shim） |
| `configSchema` 承载方式 | 批次 C 直接按 schemastery 载荷渲染 | 初版核对时仓库现状是 **JSON Schema 风格字面量**：`packages/core/src/index.ts:49` 为 `Record<string, unknown>`，`packages/plugin-wiki/src/index.ts:37` / `packages/plugin-echo/src/index.ts:30` 用 `title` 键（schemastery 无此键） | 当时判定为**契约迁移开放项**（推荐方案甲）；**现已按方案甲落地**——`packages/core/src/index.ts:30`（`ConfigSchema = ReturnType<typeof Schema.any<any>>`）与 `:95`，`packages/plugin-wiki/src/index.ts:27-33`、`packages/plugin-echo/src/index.ts:22-26` 全部改为 `Schema.object({...})` |
| schemastery 载荷规格 | "`refs` 是数组 / 节点带 `uid` / 有 `Schema.fromJSON`" | 实测均为**否**：`refs` 是对象、节点无 `uid` 字段、反序列化只有构造函数入口（`src/index.ts:178-208`）；且反序列化会 `new Function` 执行 `callback`（`:197-202`） | 写入 **S-7 / S-8**，并把"前端不得 hydrate"列为安全红线 |
| uid 作为缓存键 | "同一 schema 重复序列化 uid 会变" | 需区分两种情形：**同一实例**重复 stringify 字节相同（`probe5.out` §B `uid=14/14 equal=true`）；**重新构造**同一 schema 才变（§A `uid1=4 uid2=9`） | 写入 **S-14**，表述按两种情况区分，跨请求用内容 hash / 插件版本号 |
| UI 资源 URL 前缀 | 初版批次 D 写 `/plugins/<name>/...` | 现有静态托管的 root 锁死 `webDist`（`packages/server/src/index.ts` 的 `serveStatic()` 与 `HttpPlugin` 的 `webDist` 配置项），需独立挂载点 | 统一为 **`/plugins-ui/<name>/client.{js,css}`**，dev 由 `packages/web/vite.config.ts` proxy 转发 3000 |
| 测试计数（一次实跑，**已过时**） | 各文档写"单测 23/23" | 实跑 `pnpm -r --if-present run test`：**manager 24 + server 11 = 35/35**（`deps 8 + manager 13 + repo-paths 3`；`packages/server/test/router.test.ts` 11） | 当时已同步修正 `README.md`、`docs/roadmap.md`、本文第 7 节。**该 35/35 为历史基线口径，已过时**，当前口径见下方"测试计数（五次实跑）"行 |
| 测试计数（二次实跑，**已过时**） | 上一行记录的 35/35（manager 24 + server 11） | 那一轮实跑曾变为 `packages/manager` **39 例 / 37 过 / 2 失败**（39 = deps 8 + manager 13 + repo-paths 3 + `config.test.ts` 8 + `discovery.test.ts` 7）、`packages/server` **11/11**；失败两条均为尚未随新契约更新的旧断言 | 该口径**已作废**：两条旧断言已改写（见第 6 节），当前为核对表"五次实跑"行的 87/87 |
| 测试计数（**三次实跑，已过时**） | 上一行的"39 / 37 / 2" | **全绿 72/72**：`packages/manager` **58**（**5 个测试文件**：`deps` 8 + `manager` 13 + `config` 21 + `discovery` 13 + `repo-paths` 3）+ `packages/server` **14**（`registry` 3 + `router` 11）。**命令注意**：`pnpm -r` 在任一包失败即中止、不会跑到后面的包，故两包数字分别用 `pnpm --filter @geewiki/manager run test` 与 `pnpm --filter @geewiki/server run test` 取 | 写入第 6 节实跑表与第 7 节 item 2，并同步更新 `README.md`（`pnpm test` 行 + 当前实现状态）与 `docs/roadmap.md`（Phase 2 尾注 + Phase 3/4 状态）。**顺带纠正两处旧数**：① manager 是 **5 个测试文件**而非 4 个；② 旧口径给出的"deps 8 + manager 13 + repo-paths 3 + config 8 + discovery 7"里 config/discovery 两文件当时尚未增补完，现为 **config 21 + discovery 13**。**该 72/72 已过时** |
| 测试计数（**四次实跑，已过时**） | 上一行的 72/72（manager 58） | 全绿 **81/81**：`packages/manager` **67**（`deps` 9 + `manager` 14 + `config` 28 + `discovery` 13 + `repo-paths` 3）+ `packages/server` **14**；新增 9 例 = W2 泄漏回归 1 + 替换相关 8（`collectDependentsClosure` 1 + `replace` 7） | 当时已同步第 6 节表、第 7 节 item 2、`README.md` 与 `docs/roadmap.md`。**该 81/81 已被下一行取代（已过时）** |
| 测试计数（**五次实跑，已过时**） | 上一行的 81/81（manager 67） | 全绿 **87/87**：`packages/manager` **73**（`deps` **10** + `manager` 14 + `config` **33** + `discovery` 13 + `repo-paths` 3）+ `packages/server` **14**（`registry` 3 + `router` 11）；相对 81/81 新增 **6** 例 = `deps` +1、`config` +5（`2227adf` 补强前置校验：`base_layer` 判据改真实激活层、卸载集合基础层成员拒绝、`provider_mismatch` 提供者覆盖 + 目标自洽，`b21534a` 为前端交互）。**命令**：`pnpm typecheck`（7 个包 0 错）+ 逐文件 `node --import tsx --test <file>`（manager 5 个测试文件 + server 2 个），取值时刻 2026-09-10T17:17 +08:00、代码状态 `b21534a` | **该 87/87 已过时**（当时刻意排除了"插件 UI 入口表"并行批次；该批次现已提交，故其用例已计入下一行）。同步落点：第 6 节表、第 7 节 item 2、`README.md`、`docs/roadmap.md`。**口径排除项（历史记录）**：取值时刻工作树内另有**未提交的并行批次**（实现"插件 UI 入口表由后端下发"）——新增 `packages/manager/src/plugin-ui.ts` 与 `packages/manager/test/plugin-ui.test.ts`，并在既有 `packages/manager/test/config.test.ts` 里追加 3 例 `GET /api/plugins/ui` 用例；那些用例当时一律未计入 87/87，只由 7 个测试文件的已提交版本（`b21534a`）构成 |
| 测试计数（**六次实跑，已过时**） | 上一行的 87/87（manager 73 + server 14，web 无测试） | 全绿 **132/132**，且**首次包含 `packages/web`**：`packages/web` **19**（1 个测试文件 `pluginUiPlan`）+ `packages/manager` **91**（**6 个测试文件**：`deps` 10 + `manager` 14 + `config` **36** + `discovery` 13 + `plugin-ui` **15** + `repo-paths` 3）+ `packages/server` **22**（**3 个测试文件**：`registry` 3 + `router` 11 + `plugin-ui-static` **8**）。相对 87/87 新增 **45** 例 = web +19、manager `plugin-ui` +15、manager `config` +3（`GET /api/plugins/ui` 端点的 304/空表/形状）、server +8（静态层正负例与双根回退回归）。**命令**：`pnpm test`（`pnpm -r --if-present run test`，落到三个包）+ 逐文件 `node --import tsx --test <file>`（1 + 6 + 3 = 10 个测试文件）+ `pnpm typecheck`（`Scope: 7 of 8 workspace projects`，全 `Done`，`error TS` 计数 **0**），代码状态 `a24241a`、工作树干净。**逐文件明细**：`plugins-ui-plan` 19 / `config` 36 / `deps` 10 / `discovery` 13 / `manager` 14 / `plugin-ui` 15 / `repo-paths` 3 / `plugin-ui-static` 8 / `registry` 3 / `router` 11，各自 `fail 0` | 同步第 6 节表与逐文件口径、第 7 节 item 2、`README.md`（`pnpm test` 行 + 实现状态）、`docs/roadmap.md`。**`packages/web` 的测试入口**是 `node --import tsx --test test/*.test.ts`（`packages/web/package.json` 的 `test` 脚本；可判定逻辑被挤进不接触 `window` 的 `packages/web/src/lib/pluginUiPlan.ts`），此前文档"web 无测试"/表格只有两包的口径**已作废**。**并行批次已提交**：`02dfb5f`（后端入口表）/ `4ca8ed7`（前端接入）/ `a24241a`（根表缓存修复），上一行的"口径排除项"至此闭合，不再需要排除。**该 132/132 已被下一行（七次实跑）的 134/134 取代**——提交 `88e0c58` 在 `plugin-ui-static.test.ts` 新增 2 例 |
| `meta.role: 'password'` | 曾按"已实现"记录，上一版又反转为"未实现" | **实际已实现**（上一版写反了）：`packages/web/src/lib/configSchema.ts:132` 对 `role === 'password'` 置 `secret: true`，`packages/web/src/components/SchemaForm.tsx:131-132` 据此渲染 `type={field.secret ? 'password' : 'text'}` + `autoComplete={field.secret ? 'new-password' : undefined}`；只有非 `textarea`、非 `password` 的 `role` 才退化为文本框并附 `role=…` 注记（`configSchema.ts:133`）。**边界**：脱敏只作用于表单输入框的呈现，`GET /api/plugins/:name/config` 返回的 `config` 仍是**明文原值**。`hidden` 则**确已支持**（`:106` → `kind: 'hidden'`，`packages/web/src/components/SchemaForm.tsx:210-212` 的 `case 'hidden': return null`，**连说明行都没有**） | 已把 `docs/architecture.md` §5.7 与 `README.md` 的已知限制改为"输入框脱敏已实现 + API 返回明文"口径；并纠正上一版把 `hidden` 写成 `kind: 'static'` 的错误（`kind: 'static'` 实为 `const` 节点的只读展示分支，`configSchema.ts:136`） |
| UI 基线验收 | "4 路由可达、停用 3ms、console 无错误" | 对照 `data/spike/e2e/` 的 CDP 脚本与 DOM 快照确认：`/`、`#/wiki`、`#/plugins`、`#/graph` 四路由与 `#/graph` 的 **4 节点 + 3 边**（`react-flow__edge-path` 计数 3）均可复核 | 写入第 6 节"当前质量基线"；3 ms 标注为客户端观测口径 |
| React Flow 授权提示 | 未提及 | `packages/web/src/pages/GraphPage.tsx:145` 的 `proOptions={{ hideAttribution: true }}` 会触发上游许可证提示 | 写入 **L-7**（非缺陷，按许可证决定处理） |
| Wiki「返回列表」 | 未提及 | `packages/web/src/pages/WikiPage.tsx:174` 用 `window.history.back()`，历史栈已有编辑页时会先退回编辑页 | 写入 **L-8**（建议改显式 `onNavigate('')`） |
| schemastery 源码行号 | "`toJSON` 在 `src/index.ts:235-246`" | 逐个核对一致（`:235` 起、`:246` 结束）；`refs` 分支 `:183`、`new Function` 在 `:200`、`required` 判定 `:413-422`（抛错在 `:414`）、`merge(result, data)` 在 `:700`、默认值注入 `:791-797`、类型注册 `:803-839` | 已在 S-7…S-17 中按核对后的行号写入 |
| 变体 A（薄 shim）可运行性 | D-8 写作时的"待验证计划"（要求先跑半小时证伪实验） | **实验已跑通**：dev 与 prod 两种宿主下均渲染成功、`hooksWork:true`、点击三次计数 `0 → 3`；失败路径由阴性对照变体 C 证明可被检出 | 新增 **S-18 / S-22**，并把 D-8 的风险条目从"待证伪"改为"已通过 + 剩余未验证项" |
| import map 的可运行性 | "import map 方案不可行"（初版只给产物形态论据） | 变体 B 在当前仓内**跑得通**（结果与 A 完全一致，宿主 `<head>` 的 import map 生效）。不可行的论据仍是产物形态与 dev `?v=` 实例分裂，而非"加载失败" | 新增 **S-19**，明确 B 的失败论据不是运行期报错 |
| 阴性对照（双实例）可检出性 | 未提及 | 插件自带 react 时 `import()` 成功但渲染抛 `TypeError: Cannot read properties of null (reading 'useState')`（栈 `plugins-ui/c/client.js:395`），被 ErrorBoundary 接住、宿主不白屏 | 新增 **S-20**；同时暴露原始快照里该变体被 404 掩盖（**S-21**） |
| `cssFileName` 的作用 | "Vite 6 单入口时 CSS 默认文件名不稳定" | 实测未设该字段**不会丢 CSS**，而是以就近 `package.json` 的 `name` 命名（`geewiki-slot-spike.css`）；真实风险是命名不可预测 | **修正**：仍要求显式 `cssFileName: 'client'`，但理由改为"命名确定性"，见 **S-23** |
| 清单双来源优先级 | 本篇旧版写"同时存在时以独立清单为准——**未验证**" | **与实现相反**：`packages/manager/src/discovery.ts:77-102` 的 `parsePluginManifest` 是 fallback 链，`package.json#geewiki` 优先且命中即整体返回（独立清单完全不参与），仅在前者缺失时兜底；已有测试钉住（`packages/manager/test/discovery.test.ts:54`） | **裁决 = 改文档不改代码**，批次 B「发现规则」按实现重写 |
| `layer` 字段来源 | 端点契约只列了 `layer`，未定义语义 | 实现为**激活层**：`layer: Layer \| null`（声明在 `packages/manager/src/index.ts` 的 `PluginSnapshot` 接口，赋值在 `snapshotOf()`），未激活为 `null`；持久化层（写入目标层）另由 `layerOf()` 与 `persistConfig()` 决定，载体是 `config/plugins.base.json` / `config/plugins.session.json`。**行号更正**：本节旧稿把这两者写成 `:410-412` 与 `:422-427`，且把配置端点的 `layer` 记成 `layerOf()` 的值——实际配置端点走的是 `effectiveConfigLayerOf()`（同为 `GeeWikiManager` 的私有方法），两者只在"会话条目没写 `config`"这一种情况上不同 | **裁决**：写明"激活层"并把持久化层登记为"另一维度、当前不对外暴露"，需要时新增独立字段（见批次 C 端点节） |
| `internal/update` 中间件 | D-2 原文要求"落盘挂在该中间件上" | 实现未注册该中间件，直接 `await fiber.update(config)`；spike 实测该路径等价可用（apply 抛错 → `update()` 抛错且 `fork.config` 已改为新值，管理器据此显式回滚） | **裁决**：D-2 放宽为"不要求中间件形态，行为等价即可"，由批次 C 的 C-5 类双向回滚断言兜底。**派生项已闭合**：D-2 的"`.tmp` + `rename` 原子写"**已落地**——内联在 `packages/manager/src/index.ts` 的 `writeList()`，并有断言钉住（`packages/manager/test/config.test.ts:162`『原子写不应留下 .tmp』），详见本表"原子写落点"行 |
| `bitset` 控件 | S-13 要求"多选 + 按位或 number" | 未实现，当前配置表单对该类型降级为 JSON 文本编辑；该类型在两个内置插件的 `configSchema` 中均未使用 | **裁决**：暂保留降级，记入 **L-13**（无消费方，未来实现时载荷信息已齐备） |
| `DatabaseAdapter` 消费点数量 | 上游口径"wiki 插件 13 处 `query/run/transaction`" | 实测与口径不符：`packages/plugin-wiki/src/index.ts` 中 `db.query(` **0 处**、`db.run(` **5 处**、`db.transaction(` **2 处**，加 `ctx.get('db')` 1 处，合计 **8 处调用点**；另两处消费点为 `packages/manager/src/index.ts:667-671` 与 `packages/server/src/index.ts:427`，**全仓合计 3 处消费方** | 按仓库实数写入 **L-9③**（并标注与上游口径的差异），不按 13 处推算改造量 |
| PostgreSQL 延期与双轨接口 | 批次 E 为"评估优先" | 已核对：`packages/db-sqlite/src/index.ts:171-175` 确实声明 `provides: 'database-provider'` + `conflictGroup: 'database-provider'`；`packages/core/src/index.ts:72` 的 `migrations?: string` 确为单值 `string`（行号已更正） | **裁决**：批次 E 明确延期（L-9），`DatabaseAdapterAsync` + `isAsyncAdapter()` 双轨，`migrations` 扩为 `string \| { default?, postgres? }` **登记为落地前置条件、本次不改代码** |
| 容器化缺口 G1–G4 | "G1 未在镜像/compose 固化（正在修）；G3 镜像内 `/app/config` 为空（正在修）；G2 待修；G4 决策不打进镜像" | **Docker 批次实跑口径（取代文本核对）**：G1 / G3 / G2 **均已修**——G1：镜像内固化 `GEEWIKI_PLUGINS_DIR=/app/plugins`，`-w /tmp` 仍发现 1 个外部插件，反证相对值 `plugins` 时发现根变 `/tmp/plugins`、0 个且不报错；G3：`COPY --from=builder /src/config /app/config`，镜像从零重建 `EXIT=0`、镜像内 `plugins.base.json` 存在（126 B）、不挂 config 卷不再是死壳；G2：列目录失败已降级为打印 `[manager:discovery] 跳过插件目录 …（invalid_manifest）: … EACCES: permission denied` 并跳过；G4 决策已写入 compose 挂载注释 | 写入 **L-10**（逐条状态表，G1/G3 标"已修（含镜像重建实跑）"）+ **L-11** / **L-12**；**表现口径修正**：G3 旧措辞"活着但不服务的死壳 / HEALTHCHECK 永久失败"改为**静默重启循环**（空 config → `REST API 未挂载` → `exit=0` → `restart: unless-stopped` 反复拉起） |
| 内置插件数量口径 | "4 条内置插件清单"（清单与注册表未区分） | 核对 `config/plugins.base.json`（126 B，`enabled` 仅 3 条：`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki`）与 `packages/server/src/index.ts` 的 `defaultRegistry()`（4 个内置条目，`@geewiki/echo` 已注册未启用） | **三口径分开写**：清单启用 **3 条** / 已注册 **4 条**（故 `GET /api/plugins` 显示 4 条内置）/ 挂载外部示例后列表 **5 条** |
| 外部插件源码改动的生效方式 | 契约写"改文件后重载生效（`?v=mtime` 路径）" | **该路径未实现**：同 URL 二次 `import()` 命中模块缓存（§2.3 L-2 实证），L-6 已声明不做模块实例回收 | **按实现改文档**：改源码后**需重启进程**；`?v=mtime` 标注为"未实现、不在本轮范围"（批次 B 验证方式） |
| `loadExternalPlugins` 签名 | `(pluginsDir: string, extraPaths: string[]): Promise<RegisteredPlugin[]>` | 实现为 `loadExternalPlugins(options: DiscoveryOptions): Promise<DiscoveryResult>`（`packages/manager/src/discovery.ts:153`），返回 `{plugins, issues}`，**无 `extraPaths`** | **按实现改文档**（返回 issues 是更好的设计：裸数组会丢"谁被跳过、为什么"，且 issues 是 L-14 可观测性的载体） |
| 发现/加载代码落点 | 契约写"新建 `packages/loader/` 包" | 实现全在 `packages/manager/src/discovery.ts`（228 行），**无新包** | **按实现改文档**：少一个包 = 少一条构建 / 依赖 / tsx 加载链 |
| 配置端点 `layer` 语义 | 两个端点被写成同一个"激活层"口径（歧义） | 最终裁决：`GET /api/plugins/:name/config` 的 `layer` = **持久化层**（对齐 D-5；**实现是 `effectiveConfigLayerOf()`，`packages/manager/src/index.ts` 的 `GeeWikiManager` 私有方法**——本节旧稿误记为 `layerOf()`），同端点**新增 `activeLayer`**（未激活 `null`）；`GET /api/plugins` 列表的 `PluginSnapshot.layer` **仍是激活层** | **裁决并分端点写明**（批次 C 端点节 + 契约歧义裁决汇总），避免被读成两处同义 |
| `requiresRestart?` 字段 | 契约字段，实现未产出 | **已实现**：`packages/manager/src/index.ts` 的 `updateConfig()` 返回 `{ config, hotUpdated, requiresRestart }`；未激活/无热更新能力的"仅落盘"分支返回 `{config, hotUpdated:false, requiresRestart:true}`，`fiber.update()` 成功后的分支返回 `{..., hotUpdated:true, requiresRestart:false}` | **保留契约字段名，不改文档**；补注"`hotUpdated:false` 与 `requiresRestart:true` 同时出现（同一情形的一对表达）" |
| 无 schema 插件的配置处理 | `docs/architecture.md` §5.7 承诺"退回 JSON 原文编辑框，不做结构化校验"，而初版实现一概 400 `config_not_supported`、前端提交不读 textarea | **已按承诺落地**：`Manager.updateConfig` 对无 schema 插件只要求顶层是 JSON 对象（否则 `throw new ManagerError('invalid_config', …未声明 configSchema，配置必须是 JSON 对象)`），**原样透传、不校验不裁剪**；前端保留 JSON 原文编辑框并提交解析后的内容 | 已把 `PUT` 失败码表中 400 `config_not_supported` 一行标注为"**不再由该路径产出**（`packages/manager/src` 中已无该错误码抛出点）"，并注明"无 schema 插件不做校验与裁剪属已知取舍"；对应用例『updateConfig：未声明 schema → 按 JSON 原文透传（不校验、不裁剪），已激活同样热更新』（`packages/manager/test/config.test.ts:220`）与『updateConfig：未声明 schema 时配置形状必须是 JSON 对象（数组/标量 → `invalid_config` 且不改盘）』（`:252`） |
| `role:'password'` 脱敏 / `hidden` 字段 | 记为"未实现" | **两者均已落地**：`hidden`——`packages/web/src/lib/configSchema.ts:106` 对 `meta['hidden'] === true` 返回 `kind: 'hidden'`，`packages/web/src/components/SchemaForm.tsx:210-212` 的 `case 'hidden': return null`，即**表单完全不渲染该字段、也没有任何说明行**，值仍由 schema 默认值参与校验与落盘（`kind: 'static'` 是另一个分支：只读展示静态文本，实际只用于 `const` 节点，`configSchema.ts:136`）；`role:'password'`——`configSchema.ts:132` 置 `secret: role === 'password'`，`SchemaForm.tsx:131-132` 渲染 `type="password"` + `autoComplete="new-password"`，**输入框已脱敏**，但 `GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（config 是普通 JSON 字段，不在传输层脱敏） | **两处均改为"已实现"并写清边界**：`hidden` 更正为 `kind: 'hidden'`（不渲染、无说明行），`role:'password'` 更正为"输入框脱敏、API 明文"；并删除代码中并不存在的 note 字符串"隐藏字段（沿用默认值）" |
| 路径守卫判定方式 | D-3 写"`resolve()` 后仍在插件目录内"（词法，不解析 symlink；`plugins/` 自身为 symlink 会误拒全量） | **已落地并核对**：两侧都先 `realpathSync` —— `realpathOrNull()`（`packages/manager/src/discovery.ts:115-118`）配合真实路径版"在目录内"判定（`:125-130`，任一侧 realpath 失败即判越界，宁保守勿放行）；symlink 子目录 `statSync` 是目录则纳入、解析失败或非目录则记 `code: 'invalid_plugin_dir'`（`:204-213`，`符号链接目标不是目录，已跳过` / `符号链接无法解析: …`） | **D-3 守卫描述已更新为"真实路径判定"**（第 3 节 D-3 + 批次 B 发现规则） |
| 发现期 `issues` 的可观测性 | 无此条目 | **缺口已闭合**：`GET /api/plugins` 现在返回 `{ plugins, issues }`（`packages/server/src/index.ts:1008`），`issues` 元素为 `DiscoveryIssue = { code, dir, message }`（`packages/manager/src/discovery.ts:28-41`，`code` 八值枚举，**无 name**）；根目录不可读也走同一条 issue 出口（`packages/manager/src/discovery.ts:180-190`，`插件根目录不可读，已跳过全部外部插件: …`） | 写入第 5 节 **L-14**（形状原样回填，不再标"待回填"） |
| 原子写落点 | D-2 要求"`.tmp` + `rename`"，并计划新建 `packages/manager/src/config-store.ts` | **已内联在既有 `writeList()`**（`packages/manager/src/index.ts` 的 `writeList()`：临时名带 pid + 随机后缀、`{ flag: 'wx' }` 独占创建 → `writeFileSync(tmp)` → `renameSync(tmp, file)`，catch 内 `unlinkSync(tmp)` 清理），断言见 `packages/manager/test/config.test.ts:162`（`'原子写不应留下 .tmp'`） | **撤回"未落地"标注**：原子写**保留为必须项 = 已满足**，**不新建** `config-store.ts`；并**警告不要补注册落盘中间件**（会双写） |
| 前端 Slot 的宿主接入 | 批次 D 风险段写"证伪实验已通过，但**尚未在 `packages/web` 真实宿主上接入**" | **已接入真实宿主**：`packages/web/index.html` 的 import map + `packages/web/src/lib/hostSdk.ts`（`HOST_SDK_VERSION = '0.1.0'`）+ `packages/web/public/host-sdk/{react.js,jsx-runtime.js}` 薄 shim + `packages/web/src/lib/pluginUi.ts` 加载器 + `packages/web/fixtures/` 两份示例 bundle；真实宿主下与 `@xyflow/react` 共存未见 `Invalid hook call`。**文件名更正**：初稿写 `packages/web/src/lib/host-sdk.ts`，实际是 **`hostSdk.ts`**（`public/host-sdk/` 是 shim 目录，两者不要混） | 批次 D 风险段已按此重写。**本批推翻了该行原列的两项"仍成立的边界"**：~~未绑定 fork 生命周期（手动 `window.__GEEWIKI_PLUGIN_UI__.refresh()`）~~ → **已绑定**（`AdminPage.load()` + `startPluginUiSync()`）；~~源码 TODO `packages/web/src/lib/pluginUi.ts:27-30` 登记三项剩余工作~~ → **前两项已落地，该 TODO 注释整体被"已知边界（决策，不是待办）"段落替换**。**仍然成立**：ESM 模块不回收（产物更新需整页刷新才生效）、CSS 全局注入（v1 无样式隔离）、插件 UI 版本/完整性校验缺失（现记于 `packages/web/src/lib/pluginUi.ts:41`） |
| 是否引入 import map | 批次 D 涉及文件表写 "**不引入 import map**" | **实际引入了**：`packages/web/index.html` 的 head 首个元素即 `<script type="importmap">`，把 `react` → `/host-sdk/react.js`、`react/jsx-runtime` → `/host-sdk/jsx-runtime.js`；**刻意不映射 `react-dom` / `react-dom/client`**（插件不得自带框架）。这与 S-19 的结论一致——import map 本身跑得通，被否的是"宿主产物形态 + dev `?v=` 实例分裂"意义上的方案 | 批次 D 涉及文件表已按实现改写 |
| `/plugins-ui` 的托管方式（**本批明确推翻的旧裁决**） | 批次 D 涉及文件表（初稿）要求"Vite proxy 追加 `'/plugins-ui'`"+"`packages/server/src/index.ts` 新增 `/plugins-ui/<name>/client.{js,css}` 静态挂载点" | **该旧裁决当时成立，现已作废**：当时 `/plugins-ui/**`（入口表 + 各插件 bundle）与 `/host-sdk/**` 都只来自 `packages/web/public/`（Vite 的 `publicDir`），故**确实既不需要 proxy、也不需要新挂载点**；当时的核对方式是 `grep -rn "plugins-ui" packages/server/src/index.ts packages/web/vite.config.ts` **无任何命中**。**推翻理由**：本批引入**双资产根**——插件 UI 资产的第一优先根是 `<插件目录>/dist`（外部插件自带产物；Docker 内 `plugins/` 是 bind mount，这是"安装即生效、无需重建 web 包"的唯一路径），它位于 `publicDir` **之外**：dev 下 Vite 既不会提供它，prod 下 `webDist` 单一根也取不到它。**故现在两者都需要**：`packages/web/vite.config.ts:24` 的 `server.proxy` 含 `'/plugins-ui'`；`packages/server/src/index.ts` 有 `/plugins-ui` 独立静态分支（`servePluginUiAsset`：按段还原插件名 → 精确查根表 → 入口单段 / 资源嵌套相对路径校验 → **段比较**包含判定（`isContained()`；**刻意不用 `startsWith`**——前缀比较会让 `/a/b-evil` 通过 `/a/b` 的检查） → **绝不 SPA fallback**）。**复核命令**：`grep -n "plugins-ui\|PLUGIN_UI" packages/web/vite.config.ts packages/server/src/index.ts` → **两文件均有命中**（与旧行的"无任何命中"相反）。`/host-sdk/**` 仍只来自 `publicDir`，这一点未变 | 批次 D 涉及文件表已改写为"**已落地（初稿判定"不需要"，现已推翻）**"；`docs/architecture.md` §6 的"静态资源的托管"段同步改写（原文"因此**既不需要 Vite proxy，也不需要后端新增挂载点**"已删） |
| 插件 UI bundle 的构建位置 | 批次 D 涉及文件表写 `plugins/<name>/client/vite.config.ts` → 产物 `plugins/<name>/dist/client.js` | **实际在** `packages/web/fixtures/vite.config.ts`（`build.lib`：`entry` / `formats: ['es']` / `fileName: 'client'` / **显式 `cssFileName: 'client'`**），源码在 `packages/web/fixtures/src/`；本批起产出**两处**：默认落 `packages/web/public/plugins-ui/<FIXTURE_OUT>/`（`FIXTURE_OUT` 默认 `@geewiki/wiki`），第二遍以 `FIXTURE_OUT_DIR=../../../plugins/hello-geewiki/dist` 落到 **`plugins/hello-geewiki/dist/`**（演示"插件自带产物根"优先）。生成命令 `pnpm --filter @geewiki/web run build:fixtures`（**不在 `pnpm build` 内**，产物目录被 `.gitignore` 排除；脚本**先 `rm -rf public/plugins-ui` 全清**再产出，且**不再生成** `registry.json`） | 批次 D 涉及文件表已按实现改写。**本批更正旧注**：`plugins/hello-geewiki/` 不再只是"后端零依赖插件示例（无 UI）"——`plugins/hello-geewiki/package.json` 与 `packages/plugin-wiki/src/index.ts:54` 的 manifest 本批均加了 `client: { entry: 'client.js', css: 'client.css' }`，hello 的前端产物即由 `build:fixtures` 写入其 `dist/` |
| 插槽名清单 | 批次 D 关键契约写"插槽名（如 `admin-page-slots` / `header-slots`）"，roadmap Phase 3 写 `header-slots` / `editor-toolbar-slots` / `admin-page-slots` | **实际白名单只有两个**：`packages/web/src/lib/slots.tsx:12` 的 `export type SlotName = 'app-header' \| 'app-footer'`（`SLOT_NAMES` 在 `:15`；未在名单内的名字在 `:62` 打印 `[geewiki-slot] 未知插槽名 "…"，已忽略（可用：app-header, app-footer）`）。且**没有**后端 `ctx.slot(name, component)` 注册链路 | 批次 D 关键契约与 `docs/roadmap.md` Phase 3 均已按实现改写；`ctx.slot()` 与另两个扩展点保留为未落地候选 |
| Slot 的生命周期绑定 | 批次 D 涉及文件表写加载器"生命周期绑定 fork" | **（旧记录，已过时）当时为"未绑定"**：刷新入口是 `window.__GEEWIKI_PLUGIN_UI__ = { refresh, unload, loaded, base }`（旧行号 `packages/web/src/lib/pluginUi.ts:262-267`，**该行号现已不存在**），由调用方 `packages/web/src/main.tsx` 显式触发；`unloadPluginUi` 只做"注销插槽注册 + 移除 CSS" | **本批已反转为"已绑定"**：`syncPluginUi()`（幂等 + 单飞，`packages/web/src/lib/pluginUi.ts:216-223`）由三个触发点驱动——管理台 `AdminPage` 的 `load()`（`packages/web/src/pages/AdminPage.tsx:83`，四条变更成功路径的汇聚点）、`visibilitychange`、可见期 15s 轮询（`startPluginUiSync({ intervalMs: 15000 })`，`:292-310`，在 `packages/web/src/main.tsx:21` 启动）；卸载执行 disposers + 移除 `<link data-plugin-ui=…>` + `epoch` 防"卸载后又被在途 import 复活"。调试入口现为 `refresh / sync / unload / loaded / revision / base`。**仍未变的边界**：`unloadPluginUi` 依旧只回滚插槽注册与 CSS（ESM 模块本身无法从模块图中卸载），故产物更新需整页刷新——这条已从"源码 TODO"升格为明写的**决策边界**（`packages/web/src/lib/pluginUi.ts:36-41`） |
| 替换回滚的"逐字节复原" | G-1 与 `README.md` / `docs/architecture.md` §5.4 写"把会话清单还原成调用前的**字节**"/"逐字节一致" | **措辞过强，已降级**：`replace()` 确实在动手前快照会话清单对象（`packages/manager/src/index.ts` 的 `const sessionBackup = JSON.parse(JSON.stringify(this.session)) as PluginListFile`），回滚全部成功时整体写回（同文件 `this.session = sessionBackup; writeList(this.config.sessionFile, this.session)`），因此**条目顺序与内容**与调用前一致；但 `writeList()` 恒以 `` `${JSON.stringify(list, null, 2)}\n` `` 落盘，**文件格式会被规范化**——若清单此前是人工编辑过的非规范格式（自定义缩进 / 字段顺序颠倒 / 无末尾换行），写回后**字节与原文件不再相同**（语义与条目顺序相同）。用例『replace：回滚按调用前的条目顺序逐字节复原会话清单（依赖方启用顺序与拓扑序相反时也成立）』钉住的是**该用例自构造的规范格式文件**的前后字节相等（`packages/manager/test/config.test.ts` 内 `assert.equal(readFileSync(env.sessionFile, 'utf8'), sessionBefore, '回滚后会话清单必须逐字节复原（含条目顺序），不能只保证语义等价')`），不覆盖非规范输入 | 已把 G-1"实现偏离"段、`README.md` 替换条目、`docs/architecture.md` §5.4 全部改为"按调用前的条目顺序与原内容复原；文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行"；**未验证项**：审查所用的非规范清单反例未在本轮留档复跑，结论依据为 `writeList()` 的实现形式 |
| 500 `replace_rollback_failed` 的状态语义与覆盖 | 旧文写"此时清单可能处于中间态 / 状态不确定，需人工介入"（`docs/architecture.md` §5.4 旧版同） | **按源码核实为确定态**：走到该分支前，`removeManyFromSession(unloadSet)`（`packages/manager/src/index.ts` 的 `replace()` 内）已把旧插件与依赖方整体摘除、`this.removeFromSession(name)`（同函数回滚段）已摘除目标条目，恢复失败的条目不会再写回；故**整个卸载集合的会话条目都已从清单消失**，且每次 `addToSession` 都是"改内存 + 立即 `writeList`"，**内存与磁盘始终一致、无分歧**。**无单测覆盖**：`grep -rn "replace_rollback_failed" packages/*/test/` **零命中**（该码仅出现在 `packages/manager/src/index.ts` 的 `replace()` 头注释、抛出点与 `fail()` 条件链三处） | 已把 G-1"实现偏离"段与 `docs/architecture.md` §5.4 改为"整个卸载集合的会话条目都已消失、内存与磁盘一致、需人工介入"，并**如实标注"仅代码路径 + 人工推演，无单测覆盖"**（构造"回滚本身也失败"需更细的注入点，登记为未验证项） |
| 替换失败语义"天然原子" | G-1 流程第 8 步旧版写"**成功时只写一次 session 清单**；失败则零落盘——**天然原子**" | **与实现相反**：`replace()` 头注释（`packages/manager/src/index.ts`）原文即"整个过程会多次写会话清单（卸载集合一次 + 目标 + 每个接回的依赖方），每次都是 tmp+rename 原子替换，因此任意时刻的清单文件都是自洽的；**不追求'全程仅一次落盘'**"。实际写盘次数 = 1（`removeManyFromSession`）+ 1（目标）+ N（接回的依赖方） | 第 8 步已按源码重写为"共 1 + 1 + N 次写会话清单，每次原子替换，任意时刻清单自洽；'失败不留痕'靠快照写回而非'零落盘'" |
| 插件 UI 入口的 manifest 字段（**本批新增**） | 本篇此前从未定义前端 UI 入口的声明字段（批次 D 的 `client` 契约一直停留为设计名） | **已冻结为 `geewiki.client?: { entry?: string; css?: string }`**（`GeeWikiClient` 在 `packages/core/src/index.ts:53-61`，`GeeWikiMeta.client` 在 `:87`）：`entry` / `css` 均为**单段文件名**（`PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`，`packages/core/src/index.ts:214`），`entry` 缺省 `client.js`，`css` 缺省不注入样式；声明非法（含 `/`、以 `.` 开头、空白等）→ `pluginUiEntryOf()` **整体视为未声明**且不抛错。**未声明 `client` 的插件永不进入口表**。**关键区分（文档此前易混）**：`geewiki.entry` 是**后端**入口（`index.ts` 等），与 `client` 不可混用（`packages/core/src/index.ts:51` 明文）。**已实际声明的插件**：`packages/plugin-wiki/src/index.ts:54` 与 `plugins/hello-geewiki/package.json` 均为 `client: { entry: 'client.js', css: 'client.css' }` | 第 4 节批次 D 新增"入口表契约"段；`docs/architecture.md` §7 的 Manifest 字段表新增 `geewiki.client` 一行、示例 JSON 增补该键；`README.md` 的 Slot 条目写明"未声明 `client` 的插件永不进入口表"与"`entry` ≠ `client`" |
| 插件 UI 入口表端点（**本批新增**） | 无此条目（旧形态是构建生成物 `/plugins-ui/registry.json`） | **`GET /api/plugins/ui`**（`packages/manager/src/index.ts:1423-1442`，数据源 `GeeWikiManager.uiTable()` 在 `:312-319`，每次调用**现算**）→ `{ ok: true, version: 1, revision, plugins: Record<插件名, { entry, css?, rev }>, skipped: [{ name, reason }] }`。**只列三条件同时满足者**：名字合法 ∩ 当前已激活 ∩ 声明了 `client` 且入口文件在某候选根里**确实存在**；`skipped` 的 `reason`（互斥、每插件至多一条、按 name 排序）= `'inactive' \| 'no_client' \| 'entry_missing' \| 'invalid_name'`，判定顺序 `invalid_name` > `inactive` > `no_client` > `entry_missing`。`revision` = `sha1(JSON.stringify({version:1, plugins})).slice(0,12)`（**`skipped` 不参与**、`plugins` 按键排序故与注册表顺序无关）；`rev` = `sha1(与样式拼接的 \`${mtimeMs}-${size}\`).slice(0,8)`，**只 stat 不读内容**。响应头 `cache-control: no-store` + `ETag: "<revision>"`；`If-None-Match` 命中 → **304 无 body**（`stripEtagWeakness()` `:1520-1523` 只剥离可选 `W/` 与前后引号后全等比较，**不做 RFC 7232 列表/通配符解析**——刻意的简化，已在 `:1431-1432` 注释写明）；**空表仍 200，永不 404** | 新增为第 4 节批次 D 的"入口表契约"段；`docs/architecture.md` §6 的加载器条目改写；`README.md` 的 Slot 条目与 `docs/roadmap.md` Phase 3 同步。**⚠️ 旧的"未验证项：`skipped` 只被后端测试与验收脚本消费、前端不展示它"已过时（提交 `3bdcf4b` 起管理台分级展示，见本节"管理台展示 `GET /api/plugins/ui` 的 `skipped`"行）**；同时须注意 `revision` **不含 `skipped`** 这一事实会与 304 短路相互作用，故管理台走 `force` 同步——详见本节"**一个真实交互缺陷与修法**"行 |
| 插件 UI 资产的 URL 形态与静态层（**本批新增**） | 旧文写"UI 资源 URL 统一为 `/plugins-ui/<name>/client.{js,css}`，dev 与 prod 完全一致，因为两侧都来自 `publicDir`" | **URL 形态**：`/plugins-ui/<插件名>/<相对路径>`（入口与样式是单段文件名 `PLUGIN_UI_FILE_SEGMENT`；**其它资源可嵌套子目录**，走 `PLUGIN_UI_ASSET_PATH`，段数 ≤ `PLUGIN_UI_ASSET_MAX_DEPTH = 16`）；**插件名不编码**（scope 名 `@geewiki/wiki` 就是两段），编码名一律 404。**双资产根、顺序即优先级**：① `<插件目录>/dist`（外部插件自带产物）② `<webDist>/plugins-ui/<名>`（内置与夹具）。**"用哪个根 / 入口在不在"只有一份实现**——`packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiHit`，被入口表 `buildPluginUiTable` 与静态层根表 `pluginUiRootsFor` **共同调用**（关键不变式：两处各算一遍就会出现"表里说就绪、资产却 404"或"`rev` 变了内容还是旧的"）。静态层 `servePluginUiAsset`（`packages/server/src/index.ts:386-434`）按段还原插件名 → **精确查根表** → 入口单段 / 资源嵌套相对路径校验 → **段比较**包含判定（`isContained()`；**刻意不用 `startsWith`**——前缀比较会让 `/a/b-evil` 通过 `/a/b` 的检查），**绝不 SPA fallback**，缺失即 404 `application/json`（`sendNotFound` `:370-374`）；`serveStatic` 的 `/plugins-ui` 分支在 `:448-451` 命中后直接 `return`。静态层按名查根**不按激活过滤**（刻意的：刚被停用的插件可能还有在途 import 要结算，给 404 只会制造无谓 console error） | 第 4 节批次 D 的"入口表契约"段与 `docs/architecture.md` §6"静态资源的托管"段；第 9 节"`/plugins-ui` 的托管方式"行改为**明确推翻旧裁决**（现在**需要** proxy 与按名查根的挂载分支，因为资产可能在 `publicDir` 之外） |
| 静态层根表**禁止缓存**（提交 `a24241a`，**本批新增决策**） | 初版实现把 `pluginUiRoots` 求值一次后**永久缓存** | **`packages/server/src/index.ts` 的 `pluginUiRoots` 必须每请求现算**（`:536` 的 `config.pluginUiRoots?.() ?? {}`）。**理由（寿命必须一致）**：入口表每请求现算，根表若缓存则两者寿命不同 → "入口表说该插件就绪（并给出 `rev`），静态层却从**已消失的根**取文件 → 404"，而前端还会照表去 import 那个 404 资产。**触发条件很具体**：同名入口文件在**两个候选根都存在**（`<pluginDir>/dist` 与 `webDist/plugins-ui/<名>`），随后高优先级那个根消失——`resolvePluginUiHit` 会回退到次优先根并在表里继续列出该插件，而缓存仍指着已消失的根（回归用例正是"删掉高优先级根的同名入口 → 同一资产必须 200 且回退为次优先根内容，并断言入口表 `rev` 等于此刻真正被服务的那个文件"，`packages/server/test/plugin-ui-static.test.ts` 内新增 1 例）。代价可控：`pluginUiRootsFor()` 只对声明了 `client` 的插件做几次 stat。**注意保留"函数"形态是另一件事**：它解开的是"http 条目早于外部插件发现"的**注册顺序陷阱**，与缓存无关 | 写入 `docs/architecture.md` §6 的"静态层根表禁止缓存"条目（含触发条件与理由）；代码处 `packages/server/src/index.ts:524-535` 有同义中文注释 |
| `?v=<rev>` 缓存击穿参数（**实测证伪，最终方案未使用**） | §2.3 与 L-6 曾把 `?v=<mtime>` 当作 ESM 热更新的手段；本批一度考虑把 `rev` 作为 query 加进插件 bundle URL | **两条独立证伪**：① 给**根相对** URL 加 `?v=` 在 dev 下会触发 Vite `injectQuery` 改写成 `?import&v=…` → **必然 500**（`This file is in /public…`）；② 即便改用**同源绝对 URL** 绕开改写，`rev` 变化会产生**新模块实例**，而 `registerSlot` 是 append、已加载集合只按插件名去重 → **插槽条目翻倍**（实测 widget **2→4**），且 ESM 无法从模块图卸载。**最终形态**：import URL **不带任何 query**，`rev` **只用于变更检测**；真正换代码的路径是 unload → load（同 URL 命中模块缓存 → **产物更新需整页刷新才生效**） | 写入 L-6 补充段、第 4 节批次 D 的证伪说明、`docs/architecture.md` §6 的"两条已实测证伪的做法"条目（这是排障时最容易误判的点） |
| `/* @vite-ignore */` 的作用（**实测纠正**） | 源码注释曾把 `await import(/* @vite-ignore */ …)` 当作"避免 Vite 改写"的手段（本篇旧文亦照抄该写法） | **`/* @vite-ignore */` 并不能阻止 Vite 改写动态 import**。dev 之所以没踩坑，是因为 `pluginUiBase()` 返回的是**同源绝对 URL**（首字符 `h`），而 Vite 的 `injectQuery` 只对以 `.` / `/` 开头的 URL 追加参数。**因此"同源绝对 URL"是硬要求，不要改成相对路径** | 写入第 4 节批次 D 的证伪说明与 `docs/architecture.md` §6（`packages/web/src/lib/pluginUiPlan.ts:24-26` 是源码侧依据） |
| 304 短路与 `isUiSettled`（**本批新增的修法**） | 无此条目（旧形态没有 304 短路，因为它读的是静态 JSON 文件） | **真问题**：`revision` 只是**表格内容**的哈希，"启用 → 停用 → 再启用"会回到**同一个**值；若此前某次加载失败，304 会让宿主**永久**漏加载那个插件（表内容一样、短路一直命中，界面永远起不来）。**修法**：`isUiSettled(entries, loaded, failed)`（`packages/web/src/lib/pluginUiPlan.ts:201-219`）——**未收敛时不带 `If-None-Match`**（强制取一次完整表重新对齐），并以 `rev` 为键**记忆加载失败**、把"已按同一 rev 失败过"视为已收敛，避免 15s 轮询对同一个坏产物反复 import 与重复告警（`rev` 变化后自然重新尝试）。另：请求失败 / 非 2xx / JSON 解析失败 / 格式不可信时**既不加载也不卸载**（只 `console.debug`），避免网络抖动清空已加载 UI | 第 4 节批次 D 的"304 短路"说明与 `docs/architecture.md` §6 同条目；web 侧 19 例单测直接钉住 `isUiSettled` 与 `parseUiTable` 的不可信分支 |
| `build:fixtures` 行为与产物落点（**本批变更**） | 旧文写"连续构建两份 bundle，`packages/web/public/plugins-ui/registry.json` 的 `plugins` 表登记这两条"；并称 `plugins/hello-geewiki/` 是"后端零依赖插件示例（**无 UI**）" | **脚本现在是**（`packages/web/package.json`）：`rm -rf public/plugins-ui && vite build --config fixtures/vite.config.ts && FIXTURE_OUT=@geewiki-plugin/hello FIXTURE_OUT_DIR=../../../plugins/hello-geewiki/dist vite build --config fixtures/vite.config.ts`。三处变更：① **先全清** `public/plugins-ui`（旧生成物残留正是"入口表说就绪、资产却 404"的成因，故不做增量）；② hello 夹具产物改落 **`plugins/hello-geewiki/dist/`**（演示"插件自带产物根"）；③ **不再生成 `registry.json`**（入口表已由后端现算）。`FIXTURE_OUT_DIR` 的相对路径从 `fixtures/` 解析，故必须写成 `../../../plugins/hello-geewiki/dist`（本批过程中修掉的真问题：早先写成会解析到 `packages/plugins/` 的路径）。**另**：`plugins/hello-geewiki/package.json` 的 `geewiki` 键本批加了 `client`，故 hello **现在有前端 UI** | 重写第 4 节批次 D 的"入口表与产物生成"段；第 9 节"插件 UI bundle 的构建位置"行更正了"hello 无 UI"的旧注；`README.md` 的仓库结构注与 `docs/architecture.md` §6 同步 |
| dev / prod 运行形态（**本批变更**） | 旧文写"dev 由 Vite 直接提供、prod 复制进 `dist`，dev 与 prod URL 形态完全一致" | **`packages/web/vite.config.ts` 的 `server.proxy` 新增 `'/plugins-ui'`**（`:24`，与既有 `/api` 同目标 `http://127.0.0.1:3000`；注意 Vite 的 proxy 中间件排在 `publicDir` 之前，故这条会覆盖 `publicDir` 的默认静态服务）。**根 `package.json` 的 `dev` 脚本后端段带 `GEEWIKI_WEB_DIST=packages/web/public`**，而 `dev:server` / `start` 保持默认 `packages/web/dist`。**必须加 proxy 的原因**：资产可能来自 `plugins/<name>/dist`，位于 `publicDir` 之外——dev 下 Vite 不会提供它 | 第 4 节批次 D 涉及文件表的两行（vite.config 与 server 挂载点）改写为"已落地"；`README.md` 的开发形态段、环境变量表 `GEEWIKI_WEB_DIST` 行、`docs/roadmap.md` Phase 2 的 server 条目同步。**本节措辞已被提交 `88e0c58` 取代**：其中"根 `package.json` 的 `dev` 脚本后端段带 `GEEWIKI_WEB_DIST=packages/web/public`"现为 `GEEWIKI_PLUGIN_UI_DIST=packages/web/public`（见本表"配置项职责拆分"行）；且 `packages/web/vite.config.ts:21` 的源码注释当时**仍写旧口径**（"dev 下后端以 `GEEWIKI_WEB_DIST=packages/web/public` 启动"）——**该项已由提交 `716ec92` 修正**（现写 `GEEWIKI_PLUGIN_UI_DIST=packages/web/public`，见 `packages/web/vite.config.ts:22-23`），不再是待清理项 |
| `packages/web/tsconfig.json` 的 `types`（**本批变更，已知副作用**） | 旧值为 `["vite/client"]` | 现为 **`["vite/client", "node"]`**，且 `include` 增加 `test`（为让 `test/*.test.ts`（用 `node:test` / `node:assert`）通过 `tsc --noEmit`）。**副作用（如实记录为已知限制）**：`packages/web` 是浏览器侧代码，但类型检查现在**不再拦截 Node API 的误用**（例如在 `src/` 里 import `node:fs` 不会再报错，真正的失败会推迟到浏览器运行期） | 写入 `README.md` 的已知限制第 ⑤ 条（仅文档记录，未改配置） |
| 插件 UI 的浏览器端到端验收（**本批新增工具**） | 无此条目 | **`scripts/acceptance/plugin-ui-cdp.mjs`（已入库，零依赖：Node 内置 WebSocket + 直连 CDP）**。用法 `node scripts/acceptance/plugin-ui-cdp.mjs <页面 URL> [cdpPort] [--missing-asset=<文件路径>]`，需要 Chrome + 一个运行中的实例 + 已构建的插件产物，**故刻意不接入 `pnpm test`**（后者只跑无浏览器、无网络的单测）。**dev 与 prod 需各跑一遍**（`?import` 改写只在 dev 出现）。覆盖：插槽渲染与宿主共用同一 React 实例（点 +1 三次得 3）、`loaded()` 内容、管理台启用 hello → UI 与 `<link>` 出现 → 停用 → 两者同时消失、产物改名后页面不白屏且零 console error / 零 404、页面内直接 `fetch(disable)` 后 ≤20s UI 自动消失、连续 `sync()` 幂等无重复注入 | 写入 `docs/architecture.md` §6 已知边界第 8 条与第 4 节批次 D 的"验证方式"段。**未验证项**：脚本本身**本轮未由本文档作者复跑**（需要 Chrome 与运行实例），其覆盖清单来自脚本头注释与提交说明；且实测**只在 Chromium** 上进行 |
| 事实核对记录中若干旧行号已失效（**本批更正**） | L-14 与 §9 多处引用 `packages/server/src/index.ts:1008`（`GET /api/plugins` 返回 issues）、`packages/manager/src/index.ts:310-311`（`discoveryIssues()`）、`packages/web/src/lib/pluginUi.ts:262-267`（调试入口）、`:27-30`（三项 TODO）、`:193`（unload 注释） | **逐条复核结果**：① `GET /api/plugins` 的 `ok(h, { plugins, issues })` 实际在 **`packages/manager/src/index.ts:1417`**（`packages/server/src/index.ts` 全文仅 **803** 行，旧引的 `:1008` 不可能存在；该路由由 manager 的 `registerRoutes()` 注册）；② `discoveryIssues()` 在 **`packages/manager/src/index.ts:368-370`**，数据源声明在 `:151`、构造默认值在 `:291`（旧引的 `:310-311` / `:250` 已错位）；③ `DiscoveryIssue` 在 **`packages/manager/src/discovery.ts:28-40`**（旧引 `:28-41`），根目录不可读的 issue 在 **`:184-190`**（旧引 `:180-190`）；④ `pluginUi.ts:262-267` 已不存在（现 `:216-223` `syncPluginUi`、`:292-310` `startPluginUiSync`），`:27-30` 的三项 TODO 已被"已知边界（决策，不是待办）"段落（`:36-41`）替换，`:193` 的 unload 注释现为 `:187` 附近 | 已就地更正 L-14 的字段形状条目、L-9③ 的两个消费点行号（`packages/manager/src/index.ts:667-671` → `:1076-1080`、`packages/server/src/index.ts:427` → `:544`）、§9 的"Slot 的生命周期绑定"行，以及各处以"已按源码核对/当前位置"自居却已错位的 `configSchema`（`:72` → `:95`）与 `migrations`（`:56` → `:72`）、配置端点（`:1126`/`:1135` → `:1458`/`:1467`）引用。**本文档其余历史行号未逐条重跑**（如 L-2 引的 `packages/manager/src/index.ts:655`/`:660`、L-10-G2 引的 `:461`、批次 C 的 `packages/web/src/api.ts:180-182` 等——其中 `activatedByThisCall` 标识符在当前源码中**已零命中**，与该缺陷已修复一致），引用时请以当前源码为准 |
| 源码注释与实现不符（**本批发现，留给后续代码批**） | `packages/server/src/index.ts` 的 `/plugins-ui` 静态分支注释写"与既有非 hashed 资产策略一致：交给前端的 `?v=<rev>` 自行击穿缓存" | **该注释已过时**：实际下发的响应头是 `cache-control: no-cache`，而前端**已彻底不使用** `?v=`（见上方证伪行）。注释是历史残留 | **本次只同步文档**（禁止改源码/配置）；已在 `docs/plugin-platform-plan.md` 与 `docs/architecture.md` 写明真实行为（`no-cache`，`rev` 不进 URL），并把该注释登记为**待代码批清理项** |
| 配置项职责拆分：`GEEWIKI_PLUGIN_UI_DIST`（**本批新增，提交 `88e0c58`**） | 此前 `webDist` **一个配置项同时承担两个职责**：① 前端产物根（app shell 与 `/assets/*`）；② **内置插件 UI 资产**的兜底根 `<root>/plugins-ui/<插件名>/` | **dev 首页 404 回归已复现并修复**：上一批为让插件 UI 免构建可用，把根 `package.json` 的 `dev` 脚本设为 `GEEWIKI_WEB_DIST=packages/web/public`——而 `packages/web/public/` 只有 `host-sdk/` 与 `plugins-ui/`、**没有 `index.html`**（核实命令 `ls packages/web/public/`），静态层与 SPA fallback 都取不到 app shell → `curl :3000/` 返回 **404**（改动前为 200）。**修法 = 拆出独立的「内置插件 UI 资产根」**：环境变量 `GEEWIKI_PLUGIN_UI_DIST` + `ServerOptions.pluginUiDist`（类型与注释 `packages/server/src/index.ts:607-614`，读取逻辑 `:723-734`），**缺省回落 `webDist`**（prod 与既有行为完全不变）；**两个 `null` 语义不同**（类型注释原文）：`pluginUiDist: null` = "不使用内置根（只看插件自带产物）"，`webDist: null` = "不启用静态服务"。`packages/manager/src/index.ts:307` 把 `pluginUiDist: config.pluginUiDist ?? config.webDist ?? null` 落入管理器配置，`:333` 的 `uiTable()` 把 `this.config.pluginUiDist` 喂给 `buildPluginUiTable`；`ManagerConfig.webDist`（`:152-162`）加 `@deprecated` 并写明过载史。根 `dev` 脚本改为 `GEEWIKI_PLUGIN_UI_DIST=packages/web/public`（`dev:server` / `start` 不动）。启动日志现在**同时打印两个根**，二者相同时附注"（同静态产物根）"——`packages/server/src/index.ts:743-746`：`` `[server] 插件 UI 内置资产根: ${pluginUiDist}${pluginUiDist === webDist ? '（同静态产物根）' : ''}` ``（与既有的 `[@geewiki/http] 静态资源目录: <绝对路径>` 成对，见 `:569`）。**红-绿证据要点**：变异"把交给 `buildRegistry` 的 `webDist` 换成 `pluginUiDist`"（精确复现 dev 回归形态）→ 首页断言**红**；关变异 → **绿**。**遗留（改名未做，如实记录）**：`packages/manager/src/plugin-ui.ts` 里 `buildPluginUiTable` / `pluginUiRootsFor` / `resolvePluginUiHit` 的形参**仍叫 `webDist`**（`:163` / `:207` / `:242` / `:265`），语义已是"第二候选根的内置根"；另 `packages/web/vite.config.ts:21` 的注释曾写"dev 下后端以 `GEEWIKI_WEB_DIST=packages/web/public` 启动"（**已过时**，现为 `GEEWIKI_PLUGIN_UI_DIST`）——**该项已由提交 `716ec92` 修正，遗留只剩上面那一项（形参改名未做）** | 第 4 节批次 D 的资产根段落追加该拆分；`docs/architecture.md` §6"静态资源的托管"段补"内置根由 `GEEWIKI_PLUGIN_UI_DIST` 指定、缺省 = `webDist`"与两个 `null` 的差异；`docs/deployment.md` 变量表新增该变量并说明**镜像内刻意不设**（缺省即 `GEEWIKI_WEB_DIST` `/app/packages/web/dist`，行为不变）；`README.md` 环境变量表补该变量、`GEEWIKI_WEB_DIST` 描述收窄为"仅前端产物根" |
| 测试计数（**七次实跑，已过时**） | 上一行的 132/132（web 19 + manager 91 + server 22） | 全绿 **134/134** = `packages/web` **19**（`pluginUiPlan` 19）+ `packages/manager` **91**（`deps` 10 + `manager` 14 + `config` 36 + `discovery` 13 + `plugin-ui` 15 + `repo-paths` 3）+ `packages/server` **24**（`registry` 3 + `router` 11 + `plugin-ui-static` **10**）。相对 132/132 新增 **2** 例，全部来自提交 `88e0c58` 的 `packages/server/test/plugin-ui-static.test.ts`：①『静态层：app shell 根与插件 UI 资产根分离后各司其职（回归：dev 首页 404）』②『静态层：未配置 pluginUiDist 时回落 webDist（拆分不改变既有行为）』。**命令**：`pnpm test`（`pnpm -r --if-present run test`，逐包汇总行 `packages/web test: # tests 19 / # pass 19 / # fail 0`、`packages/manager test: # tests 91 / # pass 91 / # fail 0`、`packages/server test: # tests 24 / # pass 24 / # fail 0`）+ 逐文件 `node --import tsx --test <file>`（1 + 6 + 3 = **10 个测试文件**）+ `pnpm typecheck`（`Scope: 7 of 8 workspace projects`，全 `Done`，`error TS` 计数 **0**），代码状态 `88e0c58`、工作树干净。**逐文件明细（本轮实跑）**：`pluginUiPlan` 19 / `deps` 10 / `manager` 14 / `config` 36 / `discovery` 13 / `plugin-ui` 15 / `repo-paths` 3 / `plugin-ui-static` 10 / `registry` 3 / `router` 11，各自 `fail 0` | 同步第 6 节表与逐文件口径、第 7 节 item 2、`README.md`（`pnpm test` 行 + 实现状态段）、`docs/roadmap.md` 的"当前口径"段。上一行（六次实跑 132/132）**标注为已过时但保留**，其明细仍可追溯 |
| 测试计数（**八次实跑，已过时**） | 上一行的 134/134（web 19 + manager 91 + server 24，三包） | 全绿 **242/242，覆盖 7 个包**：`packages/manager` **91** + `packages/web` **38**（`pluginUiPlan` 19 + `searchPlan` **19**）+ `packages/plugin-llm` **33**（`service` 24 + `redact` 9）+ `packages/plugin-search` **25**（`search` 25）+ `packages/server` **24** + `packages/plugin-ai` **23**（`ai` 23）+ `packages/plugin-wiki` **8**（`service` 8）。相对 134/134 新增 **108** 例，且**测试覆盖的包从 3 个扩到 7 个**（`plugin-search` / `plugin-llm` / `plugin-ai` / `plugin-wiki` 四个包**本轮起拥有单测**）。**命令**：`pnpm -r --no-bail --if-present run test`（**`--no-bail` 为本阶段新加**）+ `pnpm -r --if-present run typecheck`（`Scope: 10 of 11 workspace projects`，0 个 `error TS`；`plugins/hello-geewiki` 无该脚本）；取值时刻 **`2026-09-10T23:24 +08:00`**、HEAD **`585dbac`**、工作树干净；逐文件计数用 `node --import tsx --test <file>` 取 `# pass` | 写入 §6.1（新增"当前口径"小节，原 134/134 小节降为 §6.2"历史端到端验收基线"并标注被取代）、§7 item 2、批次 G、`README.md`（`pnpm test` / `pnpm typecheck` 两行 + 实现状态）、`docs/roadmap.md`（Phase 2 尾注）。**同时纠正两条口径性事实**：① 旧文"实际跑到 web / manager / server 三个包"**已作废**；② `pnpm -r` 在**首个失败包处中止**——这是 `--no-bail` 存在的原因，也意味着**更早的"全量绿"读数可能是部分读数**。**待并行批次复核**：此刻有并行批次在 `plugin-search` / `plugin-ai` 上修检索召回缺陷，落地后须重跑并复核这两行（25 / 23） |
| 检索端点是否有 `mode` **请求**参数 | 阶段说明写"端点 `GET /api/search?q=&limit=`（另有 `mode` 参数，见并行批次的最终状态）" | **两个状态，都不是"文档说错"，而是并行批次在两次取数之间落了改动**：① **HEAD `585dbac` 的已提交版本：没有 `mode` 请求参数**——处理器只读 `q` 与 `limit`（`packages/plugin-search/src/index.ts:349-372`），`mode` 是**响应字段**（回传实际走了 `'fts'` 还是 `'like'`）。② **工作树（并行批次未提交改动）：`mode` 已成为请求参数**——新增 `SearchMode = 'phrase' \| 'terms'`，端点读 `h.url.searchParams.get('mode')`，缺省 `'phrase'`，**非法值 400 `invalid_mode`**（不静默降级）；响应在既有 `mode` 之外**新增 `queryMode`** 字段 | **如实按两个状态写**：`docs/architecture.md` §9.3 与 `README.md` 均按**工作树**状态记录（`q` / `limit` / `mode` 三个请求参数 + `mode` / `queryMode` 两个响应字段 + 400 `invalid_mode`），并**显式标注"该修复在工作树已实现但尚未提交，HEAD `585dbac` 仍是旧行为"**。**教训**：`mode` 一词在本仓有**两个不同含义**（响应里的实际路径 vs 请求里的查询语义），文档必须分别命名，这也是新增 `queryMode` 字段的价值 |
| 检索召回缺陷：整串短语 vs 词元 OR（**已完成，提交 `04c45c3`**；本行原记"并行批次的修复进行中"） | 阶段说明写"已知：整串按 FTS5 短语匹配，自然语言问句需按词元检索（修复进行中/已修）"，并明确要求"**先不要**写'问答召回正常'之类的断言" | **机制已核实**：`toFtsPhrase()` 把**整串**当一个 FTS5 字面短语（搜索框语义）⇒ 自然语言问句（「检索增强怎么做」）要求正文里连续出现该整串，**恒为 0 命中**，`@geewiki/ai` 的检索地基因此不可用。**修复形态（已提交）**：新增 `buildTermQuery(q): string[]`——CJK 连续片段取**长度 3 的滑窗 3-gram**、ASCII/数字片段按空白与常见标点切词且**只保留长度 ≥3** 者（trigram 的 <3 字符硬约束所致）、去重且保序；词元各自 `toFtsPhrase()` 后以 ` OR ` 连接（**切词与转义分开，注入防护仍只有一处**）；`terms` 切不出词元时**回退 LIKE**（不构造空 `MATCH`）；`total` 相应改为 **`COUNT(DISTINCT p.id)`**（OR 会让同一行被多个词元命中，`COUNT(*)` 会重复计入）；`snippet` 锚点改为**逐个词元试**；`@geewiki/ai` 改为 `search.search(query, { limit, mode: 'terms' })`（`packages/plugin-ai/src/index.ts:361`）。**落地为提交 `04c45c3`**（`packages/plugin-search/src/index.ts` +141 / `packages/plugin-ai/src/index.ts` +6，两包测试 +173 / +45） | `docs/architecture.md` §9.3 记机制与修复方案（**原"工作树已实现、尚未提交"的标注已改为"已提交 `04c45c3`"**）；`README.md` 检索条目由"⚠️ 已知（修复进行中）"改为"✅ 已修复（提交 `04c45c3`）"；`docs/roadmap.md` Phase 3 该项由 `[ ]` 改为 `[x]` 并回填提交号与已知代价。**未验证项（仍成立）**：端到端召回质量**未经本文档作者复跑验证**（无真实问答链路）；**已知代价**：terms 召回更宽、精确率天然低于短语检索（提交说明原文），建议纳入后续检索质量评估；**`mode=terms` 未接入 Web UI**。相关用例数已由读数 C 复核为稳定值（`plugin-search` 32 / `plugin-ai` 25，不再是"不稳定读数"） |
| 测试计数（**九次实跑，当前口径＝工作树**） | 上一行（八次）的 242/242（`plugin-search` 25 + `plugin-ai` 23） | 全绿 **251/251** = `packages/plugin-search` **32**（+7）+ `packages/plugin-ai` **25**（+2），其余五包与八次口径**逐包相同**（manager 91 / web 38 / plugin-llm 33 / server 24 / plugin-wiki 8）。**命令**：`pnpm -r --no-bail --if-present run test`；取值时刻 **`2026-09-10T23:35:15+08:00`**；**代码状态 = 工作树（含并行批次对 `packages/plugin-search/**` 与 `packages/plugin-ai/**` 的未提交改动；HEAD 仍是 `585dbac`）**。`pnpm typecheck`（同理复跑）：`Scope: 10 of 11 workspace projects`、**0** 个 `error TS`，取值 `2026-09-10T23:35:29+08:00` | **两个读数都写进文档并标明差别来源**：`README.md` 的 `pnpm test` 行给"读数 A（HEAD `585dbac`，242/242）/ 读数 B（工作树，251/251）"，`docs/roadmap.md` 与 §6.1 / §7 item 2 同口径。**`plugin-search` / `plugin-ai` 两行属"待并行批次落地后复核"的不稳定读数**，其余五包已稳定。**该批次落地并提交后须重跑并复核这两行** |
| `better-sqlite3` 是否自带 FTS5 | 阶段说明写"预编译包已含 FTS5（`compile_options` 有 `ENABLE_FTS5`、SQLite 3.53.4），**无需 node-gyp**" | **实测确认**：`better-sqlite3@13.0.3` 的 `db.pragma('compile_options')` 含 **`ENABLE_FTS5`**（59 项之一），`select sqlite_version()` = **3.53.4**，`CREATE VIRTUAL TABLE … USING fts5(x, tokenize='trigram')` 直接成功 | **采纳**，写入 **§2.4 T-1**（并给出复现命令）。这是"离线 + 零重依赖"成立的前提 |
| FTS5 的 `unicode61` 与中文 | 阶段说明写"默认 `unicode61` 分词器把**连续 CJK 当成一个 token** ⇒ 中文等于搜不到（实测 `MATCH '知识库'` 0 命中）" | **实测确认**：同一段中文正文下 `MATCH '"知识库"'` / `'"知识"'` / `'"全文检索"'` / `'"插件化知识库"'` 全部 **0 命中**；只有整段与 token 相同时命中（`'"GeeWiki"'` → 1）。改用 `trigram` 后 `'"知识库"'` / `'"全文检索"'` / `'"gee"'` 均 **1 命中** | **采纳**，写入 **§2.4 T-2 / T-3**。这是"本仓最容易被误传的一点"，故在 `docs/architecture.md` §9.3 也以表格形式重述 |
| trigram 的 <3 字符硬缺口 | 阶段说明写"查询串 **<3 字符**时 `MATCH` 失效（中文 2 字词如「检索」是空结果）⇒ 插件层用 **LIKE 兜底**（走 `pages` 真源表而非索引，故索引缺失时短查询仍正确）" | **实测确认**：`trigram` 下 `MATCH '"知识"'` / `'"检索"'` / `'"库"'` 全部 **0 命中**（索引切的是 3 字符片段）。源码侧 `MIN_TRIGRAM_LENGTH = 3`（`packages/plugin-search/src/index.ts:134`）、`const useFts = q.length >= MIN_TRIGRAM_LENGTH`（`:255`），LIKE 路的 SQL 直接 `FROM pages`（`:296-301`）而非 `pages_fts`——与说明一致 | **采纳**，写入 **§2.4 T-4**；`docs/architecture.md` §9.3 记两条路径的 SQL 落点 |
| trigram 索引体积 | 阶段说明写"与正文**同量级**（实测 5000 行/6.6MB 语料增约 7.9MB；外部资料给的量级是 1.7× 原文）" | **本轮自测（5000 行、正文合计 6.23 MB）**：建索引后库文件 19.58 MB → 26.65 MB，**增量 7.07 MB ≈ 1.14× 正文**。仓库内记录的实测为 6.6 MB 语料 +7.9 MB（≈1.2×，见 `packages/plugin-search/migrations/0001_search.sql`）。三条数字**互不矛盾**，量级一致 | **采纳并按区间写**"约 1.1–1.7× 正文"（写入 **§2.4 T-5**），同时**给出本轮自测的三个原始数字**（19.58 / 26.65 / 7.07 MB）与其语料口径，避免把区间读成单点 |
| 服务名映射（`provides` token ≠ `ctx.provide` 名） | 阶段说明要求"核实一条**重要的映射事实**：manifest 的 `provides` token 与本插件 `ctx.provide` 的服务名并不总相同" | **核实成立**：`packages/db-sqlite/src/index.ts:174` 声明 `provides: 'database-provider'`，`:160` 却是 `ctx.provide('db', adapter)`；`packages/server/src/index.ts:66` 声明 `provides: 'http-service'`，`:575` 却是 `ctx.provide('http', router)`；而 **search / wiki / llm / ai 四者同名**（`packages/plugin-search/src/index.ts:64` ↔ `:383`、`packages/plugin-wiki/src/index.ts:108` ↔ `:443`、`packages/plugin-llm/src/index.ts:77` ↔ `:117`、`packages/plugin-ai/src/index.ts:107` ↔ `:552`）。`@geewiki/echo` 的 `provides: 'echo-service'` **已撤销**（`packages/plugin-echo/src/index.ts:33`，从未 provide 且全仓无消费方） | **采纳**：新增 **`docs/architecture.md` §9.2 服务名映射表**（`provides` token → 真实服务名 → 提供者插件 → 定义处行号 → 是否同名），并在 §7 的 `geewiki.provides` 字段说明处加警告与指针；`README.md` 的无障碍说明不涉及该细节，故只在架构文档登记 |
| 默认部署是否含检索 | 阶段说明写"`config/plugins.base.json` 现在**包含 `@geewiki/search`**；`@geewiki/ai` 与 `@geewiki/llm` 仍是**已注册未启用**" | **核实成立**：`config/plugins.base.json` 的 `enabled` 恰为 4 条（`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki` / `@geewiki/search`）；`packages/server/src/index.ts:667-707` 的 `defaultRegistry()` 恰为 **7** 条（另含 `echo` / `llm` / `ai` 三条已注册未启用） | **采纳**并**更新全部数量口径**：清单启用 **4** 条 / 已注册 **7** 条 / `GET /api/plugins` 显示 **7** 条内置 / 挂载外部示例后 **8** 条（旧口径 3 / 4 / 4 / 5 **已作废**）。落点：`README.md` 实现状态段与仓库结构注、`docs/architecture.md` §7 现状说明 + §9.1 表 |
| 发现期 issues 的前端提示位 | 阶段说明指出"roadmap 的 `[ ] 发现期 issues 的前端提示位` **已过时**——该横幅**已在代码里**，见 `packages/web/src/pages/AdminPage.tsx` 的 `.discovery-issues`" | **核实成立**：`packages/web/src/pages/AdminPage.tsx:314` `<section className="discovery-issues">`，条件 `issues.length > 0`，标题"外部插件发现期有 N 条问题（这些插件未加载）"，逐条渲染 `issue.code` / `issue.dir` / `issue.message`；样式 `packages/web/src/styles.css:179-183` | **采纳**：`docs/roadmap.md` 的 Phase 4 该条改为 **`[x]` 并回填落点**（标注"此前登记为未做，实际已在代码里"）；第 5 节 **L-14 标题与"兼容性提示"条目同步更正为已闭合**；`docs/architecture.md` §5.8 末句"前端管理页仍待补…提示位"改为已补 |
| `--no-bail` 的读数含义 | 阶段说明写"根 `package.json` 的 `test` 脚本加了 **`--no-bail`**（此前 `pnpm -r` 会在**首个失败包处中止**，后续包根本不执行 ⇒ 全量绿读数可能是**部分**读数）" | **核实成立**：根 `package.json` 的 `scripts.test` 现为 `pnpm -r --no-bail --if-present run test`。**含义**：旧行为下**一个红色包会把它后面所有包藏起来**，因此更早的"全量绿"数字**在解释力上有限**（不只是"数字旧了"） | **采纳**：写入批次 G 的平台修复第 2 条、§6.1 的结构性变化第 2 条、§7 item 2。**注意**：这是**读数可靠性**修复，不是功能修复 |
| 测试计数（**十次实跑，读数 C = 已提交状态口径**） | 上一行（九次）的 251/251（工作树口径，`plugin-search` 32 + `plugin-ai` 25） | 全绿 **266/266，覆盖 7 个包**：`packages/manager` **91** + `packages/web` **47**（`pluginUiPlan` **28** + `searchPlan` **19**）+ `packages/plugin-llm` **33**（`service` 24 + `redact` 9）+ `packages/plugin-search` **32**（`search` 32）+ `packages/server` **30**（`router` **11** + `plugin-ui-static` **10** + `registry` **3** + `sse-drain` **6**）+ `packages/plugin-ai` **25**（`ai` 25）+ `packages/plugin-wiki` **8**（`service` 8）。相对九次口径 **251 → 266（+15）**，全部来自两个已提交批次：`packages/server` **24 → 30**（新增 `sse-drain` **6** 例，提交 `2273006`）、`packages/web` **38 → 47**（`pluginUiPlan` **19 → 28**，+9，提交 `3bdcf4b`）。**命令**：`pnpm -r --no-bail --if-present run test`；取值时刻 **`2026-09-11T00:29 +08:00`**；**HEAD `3bdcf4b`**、工作树在本读数开始时干净；逐文件计数用 `node --import tsx --test <单文件>` 在各包目录下复跑核对（server 11/10/3/6、web 28/19） | 写入 §6.1（新增"读数 C"为当前口径，读数 A/B 降为"历史读数（均已过时，保留备查）"）、§7 item 2、`README.md`（实现状态段 + `pnpm test` 行）、`docs/roadmap.md`（"当前口径"段）。**同时把九次口径标注的两处"待并行批次复核"关闭**：`plugin-search` / `plugin-ai` 的 32 / 25 已随提交 `04c45c3` 收敛为稳定值 |
| `pnpm typecheck` 的两条读数：**读数 C 时刻整体失败（并行批次中间态）→ 读数 D 时刻全绿** | 旧文写"`pnpm -r --if-present run typecheck` 全部 `Done`、0 个 `error TS`" | **读数 C 时刻（`2026-09-11T00:29`）：不加过滤的全量运行失败，唯一原因是并行批次当时新建的 `packages/plugin-openai` 尚不完整**——其 `tsconfig.json` 的 `include` 为 `["src","test"]` 而 `test/` 目录尚不存在，报 `error TS18003: No inputs were found in config file '/root/dev/geewiki/packages/plugin-openai/tsconfig.json'. Specified 'include' paths were '["src","test"]' and 'exclude' paths were '[]'.`，pnpm 随即以 `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @geewiki/openai@0.1.0 typecheck: \`tsc --noEmit\`` 中止；改用 `pnpm -r --if-present --filter '!@geewiki/openai' run typecheck` 复跑 → 其余 10 个包全部 `Done`、0 个 `error TS`。**读数 D 时刻（`2026-09-11T00:39`）：并行批次已补齐 `src/index.ts` 与 `test/`，全量运行通过，11 个包全部 `Done`、0 个 `error TS`**——上述 `TS18003` **自行消失**，证明它只是"读工作树"在并行写入期的中间态，**不是已提交代码的缺陷** | 写入 §6.1（读数 C 的注与读数 D 的类型检查段）、§7 item 2、`README.md` 的 `pnpm typecheck` 行（**保留完整报错原文**作为"别把中间态误判为缺陷"的教训）。**教训**：报告任何读数都必须**同时给出 HEAD 与取数时刻**；在并行批次活跃期，单次"全量失败"不足以判定缺陷 |
| 测试计数（**十一次实跑，读数 D = 工作树口径**） | 上一行（十次）的 266/266（HEAD `3bdcf4b`，7 个包） | **308/308，覆盖 8 个包**：读数 C 的七包**逐包完全相同**（manager 91 / web 47 / plugin-llm 33 / plugin-search 32 / server 30 / plugin-ai 25 / plugin-wiki 8），**唯一新增**的是并行批次未提交的 `packages/plugin-openai` **42**（`errors` **7** + `plugin` **8** + `provider` **16** + `sse` **11**）。**命令**：`pnpm -r --no-bail --if-present run test`；取值时刻 **`2026-09-11T00:38 +08:00`**；**HEAD 仍是 `3bdcf4b`，但工作树含并行批次对 `packages/plugin-openai/**`（未跟踪）、`packages/server/package.json`、`packages/server/src/index.ts`、`pnpm-lock.yaml` 的未提交改动**（`packages/server/src/index.ts` 的 `defaultRegistry()` 已加入 `@geewiki/openai` 条目：无 `provides`、`requires` 点名 `llm-service`、`conflictGroup: 'llm-provider'`、只登记不入默认基础层清单）。逐文件计数用 `node --import tsx --test <单文件>` 在各包目录下复跑核对 | 写入 §6.1（读数 D）、§7 item 2、`README.md`（实现状态段 + `pnpm test` 行）。**⚠️ 如实标注**：`packages/plugin-openai` **尚未提交**，**不得据此认为厂商 adapter 已落地**；该批次提交后须重跑并复核本行、§6.1 与 §7 item 2 |
| SSE 长连接出口与排空共存（提交 `2273006`） | 无此条目（旧文只在 L-16 记"流式 SSE 未做，因与排空耦合"） | **已落地**：`RouteHandlerContext.noteStatus?(status)`（`packages/core/src/index.ts:299`，"**仅记录指标、不结束响应**"）、`HttpRouterService.trackStream?(res)`（`packages/core/src/index.ts:375`，返回**幂等**注销函数；`packages/server/src/index.ts:170-178`）、`HttpRouter.closeStreams()`（`packages/server/src/index.ts:186-196`）。**⚠️ 接口归属核实结论**：`noteStatus` 与 `trackStream` 在 `HttpRouterService` 接口上且为**可选成员**；而 **`closeStreams()` 不在接口上**——它是 `HttpRouter`（`packages/server/src/index.ts:106`）的**具体类方法/实现细节**，其他包经 `ctx.get('http')`（静态类型 `HttpRouterService`）拿不到它，只在 `HttpPlugin.apply` 的 teardown 闭包内（持有具体类实例）被调用。**长连接不占在途的机理**：`dispatch` 只在 `isThenable(result)` 为真时才把 `exitHandler` 挂到 Promise 结算上（`packages/server/src/index.ts:358-371`）⇒ **SSE 处理器同步返回非 thenable 即可在同一 tick 内结算**，连接存活由提供方自持。**teardown 现为五步**（`packages/server/src/index.ts:627-654`）：`unprovide()` → `closeStreams()` → `await drain(drainTimeout×1000)` → `server.closeIdleConnections?.()`（Node 22 有，**只关空闲、保留在途**；刻意**不用** `closeAllConnections()`，以免关掉测试里 undici 连接池的复用连接）→ `server.close()` | 新增 **`docs/architecture.md` §5.1.1**"长连接（SSE）出口与优雅排空的共存"；`README.md` 实现状态段 + 特性亮点 + 已知限制第 ⑦ 条 + 架构总览 ASCII；`docs/architecture.md` §9.7 的 SSE 行与 `docs/roadmap.md` Phase 3 的 SSE 条目同步改写为"**出口地基已就绪，真实流式仍未接线**" |
| **被实测证伪的设计设想**：`writeHead` + `h.json(200, null)` 可"只记指标而不结束响应"（提交 `2273006` 的动机） | 无此条目——这是一条**新登记的反面结论**，用于防止后人重犯 | **实测证伪**：`res.writeHead(200, { 'content-type': 'text/event-stream' })` 之后，`res.headersSent` **立即为 `true`** 而 `res.writableEnded` **仍为 `false`**——`json()` 开头那道 `if (res.writableEnded \|\| res.destroyed) return` 的 write-after-end 防护**拦不住**这种情况。而 `json()` 内的 `writeHead` 是**有条件**的（`packages/server/src/index.ts:298-300` 的 `if (!res.headersSent) res.writeHead(...)`），紧随其后的 **`res.end(JSON.stringify(body))` 却是无条件的**（`:301-306`）⇒ 会给 SSE 流**追加字面 `null` 并立即终结流**。**实测客户端正文**：`event: status\ndata: {"type":"status"}\n\nnull`。**故必须另开 `noteStatus` 这条"只记指标、绝不碰响应"的通路**；它与 `json()` **共用同一记账点**（`packages/server/src/index.ts:272-292`），由 `settledStats` 幂等守卫保证**每个请求只记一次**（长连接先 `noteStatus(200)`、随后异常收尾路径仍可能经 `json()` 再走一次，重复记账会让 `stats()` 总数虚高、看门狗连续失败计数被放大） | 写入 **`docs/architecture.md` §5.1.1(b)**（含实测正文原文）与 **`README.md`** 已知限制第 ⑦ 条；`docs/architecture.md` §9.7 的 SSE 行末尾加同款告诫。**这是本批最值得记档的一条**——它是一条"看起来很合理但结构性错误"的通路，后人极易重犯 |
| 长连接出口的测试证据（提交 `2273006`） | 无此条目（`packages/server` 此前只有 `router` 11 / `plugin-ui-static` 10 / `registry` 3） | **`packages/server/test/sse-drain.test.ts`，6 例，全部通过**。其中：① 一例是**负对照**——处理器返回**永不 resolve 的 thenable** → 排空**确实等待、超时并打印告警**（实测 `duration_ms 6064`、日志 `[@geewiki/http] 排空超时（5000ms，仍有 1 个请求在途），强制关闭监听`），**证明主用例（长连接不空转）有判别力**而非"恰好没触发"；② 一例回归 `json()` 终结流的坑（`noteStatus` 恰好记一次指标、响应体不得出现字面 `null`）；③ 一例覆盖 `trackStream` 注销**幂等**；④ 一例覆盖 `HttpPlugin.apply` 的真实 teardown（经 `startServer().dispose()`）；核心断言走的是**真实生产卸载路径**（REST `/disable` → `manager.disable()` → `deactivateCore` → `unloadPlugin` → `drainBeforeUnload` 生产排空代码 → `fiber.dispose()`）。**两处变异取证**：① 在 `trackStream` 里加 `inFlight++`（把长连接算进在途）→ 用例红，报"长连接不得阻塞排空（**实际 5004ms**）"——正是本特性要消灭的假超时；② teardown 去掉 `closeStreams` → 用例红。两处变异均已还原。**`packages/server/test/router.test.ts` 的 11 条一字未改**（复核命令 `git diff --stat 2273006^ HEAD -- packages/server/test/router.test.ts` → **输出为空**） | 写入 §6.1 读数 C 的逐文件明细与 `docs/architecture.md` §5.1.1(e)；`README.md` 的 `pnpm test` 行给出 `sse-drain` **6** 的落点 |
| 管理台展示 `GET /api/plugins/ui` 的 `skipped`（提交 `3bdcf4b`） | 本篇 L-14 的**末尾子条**曾写"`skipped` 只向后端调用方暴露，**前端当前同样不展示它**"；§9"插件 UI 入口表端点"行的"未验证项"亦写"**前端不展示它**" | **已落地，两处旧表述均已过时**：新增纯函数 `classifyUiSkips(skipped)`（`packages/web/src/lib/pluginUiPlan.ts:226`）按 `reason` **分级**——`entry_missing` / `invalid_name` → `attention`（**红系显著告警块** `.ui-skips-attention`，`packages/web/src/pages/AdminPage.tsx:385-402`），`inactive` / `no_client` → `normal`（**可折叠 `<details>`** `.ui-skips-normal`，默认收起、白底，`:404-421`）；配 `UI_SKIP_LABEL` / `UI_SKIP_HELP`（`:240` / `:248`，四值中文标签与解释，如 `entry_missing` → 「界面产物缺失」+「通常是发布时漏带 dist/ 目录」）。分级的理由（源码注释原文）：`entry_missing` 是"作者声明了界面、产物却没跟上"的**真实故障**，必须显著；`inactive` / `no_client` 是**预期状态**，与故障同级用告警样式呈现只会让真正的故障淹没在噪声里。读取路径：`pluginUi.ts` 原有 `parseUiTable` **直接丢弃** `skipped`（无对外可读入口），故补了最小订阅式读取 `pluginUiState()` / `subscribePluginUiState()`（`packages/web/src/lib/pluginUi.ts:148` / `:159`，快照引用稳定、变更后才通知），管理台经 `useSyncExternalStore` 消费（`AdminPage.tsx:96`），**没有新写第二份 fetch**；解析侧 `readSkipped` **刻意从宽**（`skipped` 坏掉绝不能让"加载/卸载"也判为不可信） | 新增 `docs/architecture.md` §6 的三条条目（"`skipped` 的前端呈现按严重度分级"、"`skipped` 与'发现期 issues'语义不同"、"订阅式读取路径"）；**L-14 末尾子条与 §9"插件 UI 入口表端点"行的"前端不展示它/未验证项"已就地更正为"已展示"** |
| `skipped` 与发现期 `issues` 的语义区别（提交 `3bdcf4b`） | 无此条目（两者此前未在同一处并列对比） | **两条通路职责不同，不得混用**：`GET /api/plugins/ui` 的 `skipped` = "**插件在（已注册/已发现），但它的前端界面没加载**"（UI 产物就绪性的唯一机器可读出口；典型情形：清单声明了 `client` 却忘了跑 `build:fixtures` → `entry_missing`）；`GET /api/plugins` 的 `issues` = "**整个插件都没加载进来**"（发现/加载期失败：目录、清单、入口模块，见 L-14）。管理台告警块的文案已把区别写死（`packages/web/src/pages/AdminPage.tsx:388-391` 原文）："这些插件**已在注册表中**，但它们的**前端界面**没有出现在管理器里——与上面的'发现期问题'不同：那一类是整个插件都没加载进来，这一类是插件在、界面缺。" | 写入 `docs/architecture.md` §6 的"`skipped` 与'发现期 issues'语义不同"条目（含管理台原文），与 L-14 的 `issues` 条目互为对照 |
| 依赖阻止停用的专门说明块（提交 `3bdcf4b`） | `docs/roadmap.md` Phase 4 的 `- [ ] 依赖阻止卸载弹窗提示（当前 409 文案展示）` **登记为未做**；`docs/architecture.md` §5.2 只写"阻止卸载并弹窗提示" | **已落地**：后端 `409 has_dependents`（`details.dependents` 为依赖方名单）此前只显示泛化错误；现管理台捕获该 code 并弹出**专门说明块** `.dependents-block`（`packages/web/src/pages/AdminPage.tsx:423-455`）——标题「无法停用 X：仍有插件在依赖它」+ 列出依赖方 + **两段可操作指引**（① 先在上表逐个停用依赖方再回来停用目标；② 若它是被同冲突组其它插件顶替，可在目标插件那行点「启用」走**冲突组替换**，会连同依赖方一起安全接管）。`dependentNamesOf()`（`AdminPage.tsx:13-21`）**防御性**读取 `details`：形状不符退回空数组 → 走"后端未返回名单，可在依赖图中查看指向它的边"的兜底文案，**不显示 `undefined`**。**刻意未实现自动级联停用**（破坏性操作，不属本批） | `docs/roadmap.md` 的该项由 `[ ]` 改为 `[x]` 并回填落点；`docs/architecture.md` §5.2 的"卸载时"条目改写为专门说明块 + 两段指引 + "刻意不实现自动级联停用" |
| **一个真实交互缺陷与修法**：`revision` 不含 `skipped` ⇒ 管理台二次 `load()` 永远看不到该类变化（提交 `3bdcf4b`） | 旧文只登记了**一个** 304 短路真问题（`isUiSettled`，见 §9"304 短路与 `isUiSettled`"行） | **第二个、性质不同的 304 短路真问题**：`buildPluginUiTable` 的哈希输入**只有 `{version, plugins}`**——`packages/manager/src/plugin-ui.ts:255` 的 `createHash('sha1').update(JSON.stringify({ version: 1, plugins })).digest('hex').slice(0, 12)`（注释 `:221` 明写 `skipped` 不参与、`plugins` 按键排序）。⇒ "**未启用 / 无前端界面**的插件集合"发生变化时（新装一个未启用插件、或某插件从未启用变为无界面），`revision` **纹丝不动** ⇒ 客户端带同一个 `If-None-Match` 请求、后端照旧回 **304**（服务端逻辑见 `packages/manager/src/index.ts:1457-1463`） ⇒ 管理台**永远看不到**这类变化。**与第一个问题的区别**：第一个是"已加载集合与 revision 脱钩"，本条是"**展示字段根本不在指纹里**"。**修法**：给 `syncPluginUi` 加 **`force`** 参数（`packages/web/src/lib/pluginUi.ts` 的 `PluginUiSyncRequest.force`）——`const useEtag = !force && lastRevision !== undefined && isSettled()`（`:333`），命中 304 直接 `return`（`:344`）；**管理台 `load()` 走 `syncPluginUi({ force: true })`**（`AdminPage.tsx:109`，不使用 `If-None-Match`），而 **`startPluginUiSync` 的 15s 可见期轮询仍走 304 短路**（`packages/web/src/lib/pluginUi.ts:400/404/412` 调无参 `syncPluginUi()`）——既保证展示字段新鲜度，又不牺牲空闲期零成本 | 写入 `docs/architecture.md` §6 的"**第二个 304 短路真问题：`revision` 不含 `skipped`**"条目（含哈希实现原文、`force` 的两条路径）。**这是本批最值得记档的第二条**——它是"展示字段不在缓存指纹里"这类缺陷的干净标本 |
| 插槽名清单（**本批第二次更正**，2026-09-14） | 本节此前一行的结论是"**实际白名单只有两个**"（`packages/web/src/lib/slots.tsx:12`），并据此把"后端插槽注册链路"与更多扩展点"保留为未落地候选" | **白名单结论已过时：现为 5 个**——`packages/core/src/index.ts:797`（真源）与 `packages/web/src/lib/slots.tsx:49`（镜像）逐字相同，`SLOT_NAMES` 分别在 `:800` / `:52`，基数表 `SLOT_CARDINALITY` 在 `packages/core/src/index.ts:821`（`editor` / `wiki-ask` = single，`app-header` / `app-footer` / `editor-toolbar` = multi）。`editor` 随提交 `084dab4` 落地，`editor-toolbar` + `wiki-ask` 是本批为"AI 界面归插件"新增的。**零属性裁决只对 `app-header` / `app-footer` 继续成立**（`ZeroPropsSlotName`，`packages/web/src/lib/slots.tsx:61`），新插槽走具名窄契约 props（见批次 D 修正块）。**为何保留两份声明**：core 顶层 `import 'node:fs'`，浏览器 bundle 不能 import core——镜像是被迫的，故一致性必须由守卫钉：`packages/manager/test/slots.test.ts` 解析 web 侧 `SLOT_NAMES` 字面量并与 core 逐元素比对（解析失败即红，不允许静默通过），`packages/web/test/slotPropsMirror.test.ts` 再比对 core / `slots.tsx` / `pluginUiPlan.ts` 三处（含顺序）与 props 的字段名/可选性/`readonly` ⇒ **新增插槽必须同时改这三处** | 第 1 节状态行与 ③ 行、批次 D"关键契约"、批次 D 涉及文件表两行（`slots.tsx` 的 2 名 `SlotName`、`hostSdk.ts` 的 `HOST_SDK_VERSION = '0.1.0'`）、`docs/roadmap.md` Phase 3 的 Slots 条目均已加"修正（本批，2026-09-14）"块；**本行原文保留**以显示该结论被两轮推翻的过程 |
| 后端插槽注册链路（**本批由"未落地"改为"已落地"**；⚠️ 落地形态不是 `ctx.slot()`） | 批次 D 与第 1 节都写"未落地：后端 `ctx.slot()` 注册链路" | **链路已落地，但全仓没有 `ctx.slot(name, component)` 这个方法**（grep 无 `ctx.slot(`）。落地形态是两种：**清单声明** `geewiki.slots: SlotName[]`（`packages/core/src/index.ts:142`，注释 `:131` 分工：`client` 声明"我有 UI 产物"、`slots` 声明"我要占用哪些位置"）由管理器在激活时登记（`packages/manager/src/index.ts:1343` 的 `contributeFromManifest(name, slot)`）、卸载时按 owner 回收（`:1434` 的 `release(name)`）；**运行期动态贡献**走 `ctx.get('slot').contribute(owner, slot, meta?)`。**为什么不做成方法糖**：owner 是"谁贡献的"这一**记账依据**（与 `HttpRouterService.trackStream(res, owner)` 同源），方法糖会把它藏起来，而冒用可被 `list()` 立刻看出。契约 `SlotService`（`packages/core/src/index.ts:960`）→ 实现 `SlotRegistry`（`packages/manager/src/slots.ts:157`）→ 纯函数 `resolveSlots(contributions, activationOrder)`（单占用**最早激活优先**，其余进 `suppressed` 并记 `SlotConflict`）→ 提供者是**独立插件 `@geewiki/slot`**（`packages/manager/src/slot-plugin.ts`，服务名 `slot`），**必须在管理器之前注册**（`packages/server/src/index.ts:1571`）。**`slot-plugin.ts` 文件头记录的实测证伪**：最初写法是"管理器在自己的 `apply` 里 `ctx.provide('slot', …)` 再 `boot()`"，后果是外部插件 `apply` 里 `ctx.get('slot')` 为 **`undefined`**、其运行期贡献被**静默跳过**（裁决表里查不到任何痕迹，与"本来就没贡献"无法区分）；机制是"**在一个插件 `apply` 尚未结算时 provide 的服务，对它在此期间创建的子插件不可见**"。⚠️ `packages/core/src/index.ts:949-953` 的 `SlotService` 注释仍写"为什么由**管理器**提供而不是单独一个插件"——**与实现相反**，本批未改代码注释（登记为待清理项） | 批次 D 新增修正块、第 1 节状态行改写、`docs/roadmap.md` Phase 3 的"后端注册链路"条目按此回填。**遗留项**：`packages/core/src/index.ts` 该段注释需改写为"独立插件在前、管理器在后" |
| 插槽仲裁的对外可见性（**本批新增**） | 无此条目（此前没有仲裁，也就没有"被抑制"这一说） | `GET /api/plugins/slots`（`packages/manager/src/index.ts:1743`）→ `{ ok, slots: SlotAssignment[], conflicts: SlotAssignment[] }`，其中 `SlotAssignment = { slot, cardinality, owners, effective, suppressed }`，`conflicts` 就是 `suppressed.length > 0` 的那些。**读端点刻意保持 public**（`packages/manager/src/index.ts:1717` 的注释记录了这条裁决），因为宿主前端要在**未登录的阅读页**判断"有没有人提供问答界面"——写端点（启用/停用）仍是 admin。**前端只认 `effective`**：`packages/web/src/lib/pluginUiPlan.ts:143` 定义 `SLOT_TABLE_PATH`，`:158` 明确"被抑制者不得注册组件"，`packages/web/src/lib/pluginUi.ts:406` 把它列为权威仲裁的**主判据**——**不能只靠入口表的 `slots` 字段**：该处注释记录了实测漏洞，后端在生效插槽集合为空时**直接省略 `slots` 键**，于是"声明了但被抑制"与"根本没声明插槽"在入口表里长得一模一样，被抑制者会蒙混过关（双注册的实际后果是两个编辑器 / 两个面板同时渲染）。入口表 `GET /api/plugins/ui` 的 `slots` 字段同样是**裁决之后的生效集**（实测：`editor-toolbar:multi effective=[@geewiki/ai-writing]`、`wiki-ask:single effective=[@geewiki/ai-qa]`，见 `data/verify/ai-split-e2e/result-backend.json` 的 `C_slots`） | 写入批次 D 修正块；`docs/design/ai-plugin-split.md` §4.4 记裁决规则 |
| **"该不该显示某功能入口"的判据（本批实测的自锁缺陷）** | 宿主此前用 `GET /api/plugins` + **硬编码插件名**（`WikiPage.tsx` 的 `stateOf('@geewiki/ai')`）判"问答功能在不在" | **两条判据都错，本批两条都换掉**：① 按"已注册的插槽组件"判 ⇒ **自锁**——懒加载插槽的组件只在进入视图后才加载，而按钮要在进入之前出现；实测第一版因此"列表页的『AI 问答』入口恒不渲染"。② 按激活态 + 硬编码名判 ⇒ 把功能归属焊死在宿主里，换名/换实现/第三方接管都静默错位。**新判据**：`pluginUiDeclaredFor(slot)`（`packages/web/src/lib/pluginUi.ts:190`，判据理由写在 `:176-189`）读入口表的**声明 × 裁决生效集**；宿主四态（面板 / 载入中 / 加载失败 / 没有功能）由 `useWikiAskSlotState()`（`packages/web/src/lib/slots.tsx:434`）合一 `entry` / `failures` / `declared` 三源 | 写入批次 D 修正块；`scripts/acceptance/ai-split-e2e/README.md` 的 `1a` / `1b` 两条检查即钉此判据（"按钮存在而 bundle 尚未被请求"） |
| 进入编辑视图必须拉起**两个**按需插槽（**本批实测**） | 无此条目（此前只有一个按需插槽 `editor`） | 进入编辑视图要同时 `ensureSlotLoaded('editor')`（`packages/web/src/pages/WikiPage.tsx:2371`）与 `ensureSlotLoaded('editor-toolbar')`（`:2375`）。**只拉前者的后果**：工具条位置**静默空白**——无 404、无 console error、管理台侧入口表与裁决全都正常，是"看着没问题"最难查的一类。问答视图同理只需 `ensureSlotLoaded('wiki-ask')`（`:319`） | 写入批次 D 修正块的懒加载段 |
| 内置插件的前端产物**为什么仍由 `@geewiki/web` 构建**（**本批新增决策**） | 无此条目（此前内置插件没有自己的前端产物，只有 fixture 与外部插件） | 两个 AI 插件的 UI 源码归插件自己（`packages/plugin-ai-writing/ui/{index.tsx,assistPlan.ts,style.css}`、`packages/plugin-ai-qa/ui/{index.tsx,askPlan.ts,sse.ts,style.css}`），**但构建编排在 `packages/web/package.json`**：`build:plugin-ui`（`:11`）以 `FIXTURE_ENTRY=../../plugin-ai-writing/ui/index.tsx` / `…ai-qa…` 跑两遍 `fixtures/vite.config.ts` 的 lib 配方，产物落 `packages/web/public/plugins-ui/@geewiki/{ai-assist,ai-qa}/client.{js,css}`；`build:fixtures`（`:10`）末尾串 `&& pnpm run build:plugin-ui`，两个插件包各自暴露 `"build:ui": "pnpm --filter @geewiki/web build:plugin-ui"`。**为什么不放 `<插件目录>/dist`**：`RegisteredPlugin.dir` **只对外部插件存在**（`packages/manager/src/deps.ts:31-33` 注释原文"外部插件的目录绝对路径（内置插件无此字段）"）⇒ 内置插件拿不到自带资产根。**为什么不在插件包内另起 vite**：要新增 vite/react devDeps（安装面），而那条根对内置插件本来就不生效 | 写入批次 D 修正块与 `docs/design/ai-plugin-split.md` §4.5 |
| AI 的两个 `capabilities` 端点是 **public**，其 `providers` 必须经脱敏（**本批补的守卫**） | 本篇只写过 `register` 的默认访问级别，没有把"AI 的能力探测端点匿名可读"当成一条需要防护的事实登记过 | **两个端点都是三参 `register` ⇒ 默认 `access: 'public'`**（`packages/plugin-ai-qa/src/index.ts:939`、`packages/plugin-ai-writing/src/index.ts:280`；默认值见 `packages/core/src/index.ts:501-504`"省略等价于 `{ access: 'public' }`"）。它们外发的 `providers[].label` / `.model` **不是静态字面量**——`@geewiki/openai` 的 `model` 是对管理员所设值的**实时 getter**（`packages/plugin-openai/src/provider.ts:145`），而 baseUrl 写成带 basic-auth 的形式（`https://user:sk-xxx@gateway/…` 是能工作的）就会把密钥带进匿名响应。**修法落在投影处而不是各端点里**：`listRouteInfos()` 的每个字段都过 `safeText()` ⇒ `redact()`（`packages/plugin-llm/src/availability.ts:59`，理由写在 `:29-45`），故两个插件共用一份脱敏。守卫：`packages/plugin-llm/test/degrade.test.ts:219`『listRouteInfos：label/model 里的形似密钥片段必须被脱敏（capabilities 是公开端点）』，断言 `info.label.includes('***')`（`:252`） | 写入批次 D / 批次 G 修正块与 `docs/design/access-control.md` §5.7 修正块 |
| 辅助写作的**块级权限红线**（**本批新增，含源级守卫**） | 无此条目（旧 `@geewiki/ai` 的辅助写作与问答在同一个包里，红线没有单独登记过） | **硬规则：辅助写作的上下文只来自请求体**（前端从编辑器缓冲区取出的 `selection` / `before`），服务端**不读页面正文、不查索引**——这样"用户看不到的受限段落"在结构上不可能进入模型上下文，比"记得过滤"强。`slug` **只用于一次编辑权限判定**，绝不用于取正文：`packages/plugin-ai-writing/src/assist.ts:233` 的 `resolveEditAccess` 是唯一消费点，接线在 `packages/plugin-ai-writing/src/index.ts:247-254`（`ctx.get('policy-service')` 取不到就 `return null` ⇒ `pageEditableFrom(null)` 为假 ⇒ **失败关闭 403**）。判定顺序被钉死：解析(400) → 有编辑能力(403) → 该页可编辑(403) → 降级投影(503) → 生成。**权限在降级之前**是刻意的：否则"没配密钥"会变成权限探测通道。**两处偏离设计文档，均为有意**：① 匿名与"已登录但无编辑权"给**同一个 403**（不分 401/403，少泄露优先），故契约里写的 401 在真实链路上不会出现；② `ASSIST_TEXT_MAX = 4000`（`assist.ts:46`）超限是 **400 `payload_too_large`**。**守卫（源码级，不是行为级）**：`packages/plugin-ai-writing/test/assist.test.ts` 的『守卫：assist.ts 不得出现任何"取正文/检索"的调用点』在去掉注释/字符串的源码里禁止 `search-service` / `wiki-service` / `contents(` / `retrieve(` / `getPage(` / `readPage(` / `loadPage(` / `pageContent` / `FROM pages` / `page_versions` / `blocks_fts`，并反向自证确实出现 `resolveEditAccess` 与 `canEdit`；第二条守卫用白名单正则限制 `slug` 出现的每一行，并断言 `resolveEditAccess(principal, slug)` 存在 | 写入 `docs/design/access-control.md` §4.5 修正块 |
| 问答的**两层主体过滤**与**状态码二分**（**本批新增**） | 设计文档 §4.5 的旧表述是 `contents(slugs, principal?)`——`principal` **可选、省略即匿名**；`docs/design/ai-plugin-split.md` §4.1 一度把"没有可用模型"记作 502 | **两处都按实现改正**：① `search-service` 的 `search` / `contents` 都改为**主体必填首参**（`packages/plugin-search/src/index.ts:191` / `:223`），且运行期守卫**抛错而不是"当作匿名"**（`~:226`）——当作匿名会静默少给（可发现），不过滤会静默多给（不可发现且是事故）。问答因此是**两层**都带主体：召回 `search(principal, query, { limit, mode:'terms' })`（`packages/plugin-ai-qa/src/index.ts:431`）+ 取正文 `contents(principal, slugs)`（`:438-441`）。② 状态码固定为 **503 = 前置条件不满足（根本没调用模型：`model_unavailable` / `search_unavailable`）/ 502 = 上游真的失败（`generation_failed` + `degraded.code`）**；实测 429 ⇒ `RATE_LIMIT`、上游 200 但零 token ⇒ `PROVIDER_ERROR`（判据用**文本是否为空**而不是 `usage.completionTokens`，因为用量字段可选） | 写入 `docs/design/access-control.md` §4.5 与 §5.7 的修正块；`scripts/acceptance/ai-split-e2e/README.md` 记实测值 |
| 宿主 SDK 新增 `renderMarkdown`（**本批，SDK `0.1.0` → `0.2.0`**） | 本节"前端 Slot 的宿主接入"行记 `HOST_SDK_VERSION = '0.1.0'` | 现为 **`0.2.0`**（`packages/web/src/lib/hostSdk.ts:22`）。新增 `renderMarkdown(markdown: string): string`（`:43`，实现即 `mdToHtml`，`:62`；插件侧经 `PluginUiHost.renderMarkdown` 拿到，`packages/web/src/lib/pluginUi.ts:62` 声明、`:435` 转发）。**消毒白名单仍是唯一实现、审计点仍只有一处**——插件拿到的是可直接 `dangerouslySetInnerHTML` 的串，往里再拼未消毒内容属插件违约。**插件侧必须特性探测**（`typeof host.renderMarkdown === 'function'`，`hostSdk.ts:18-19`），老宿主上退化为纯文本而不是抛错（`packages/plugin-ai-qa/ui/index.tsx:70-77` 就把它声明为可选能力）。**命名偏离**：`docs/design/ai-plugin-split.md` §4.4 写的是 `host.markdownToHtml(md)`，落地名为 `renderMarkdown` | 批次 D 修正块；设计文档 §4.4 以源码为准 |
