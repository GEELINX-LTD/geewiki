# GeeWiki 插件平台：契约与当前限制

> 本文档面向项目维护者与后续接手者，回答两件事：**插件平台的契约是什么**（Manifest / API / 生命周期 / 验证纪律），以及**当前还剩下哪些限制与风险**。
>
> **本文档是重整的产物**：它由 `docs/plugin-platform-plan.md`（"实施批次方案 + 逐批实施流水"的混合体）与 `docs/review/plugin-freedom-audit.md`（平台自由度审计报告）中**仍然有效**的部分合并、去重、按当前代码口径逐条复核而成；两份原文件已在同一次重整中删除（逐批实施流水、审计过程与历史测试读数见 git 历史，批次读数的历史流水保留在 [changelog/implementation-log.md](./changelog/implementation-log.md)）。**不在本文档内的**：批次 B–H 的实施流水、历史测试读数、审计的命令附录——那些是过程记录，不是契约。
>
> 文档中的"实证"结论来自 `data/spike/` 下的探针脚本（`probe1-fork-update.mjs` / `probe1b-hooks.mjs` / `probe1c-hook-next.mjs` / `probe2-schemastery.mjs` / `probe2b-payload.mjs` / `probe3-load.mjs` / `addendum.mjs`）。**`data/` 被 `.gitignore` 排除，该目录随时可能被清理**，因此结论在此固化；复现方式见第 7 节。
>
> 现状与设计蓝图见 [architecture.md](./architecture.md)，阶段划分见 [roadmap.md](./roadmap.md)，容器化细节见 [deployment.md](./deployment.md)，**当前质量基线见 [../README.md](../README.md) 的「质量基线」段**。本文编号自成体系，不延续 architecture.md 的章节号。
>
> **编号提示**：第 2、3 节里出现的「批次 B–H」「C-5」「D-2」「S-n」「T-n」是原实施批次方案 / 实证记录的**内部编号**（`S-n` = schemastery 载荷规格，`T-n` = FTS5 分词器事实，`F-n` = 审计发现项，`L-n` = 已知限制）。对应的批次流水与审计过程已随本次重整删除；`F-n` / `L-n` 的**结论**保留在第 5 节，引用行号前请以当前源码为准。

## 1. 平台能力与当前状态

平台要补齐 6 项能力，另有"检索与问答"作为 AI 原生能力的首批（下表 ⑦）。"当前状态"按**当前代码口径**（HEAD 见仓库；数量与读数的当前口径见 README「质量基线」）。

| 编号 | 能力 | 当前状态 |
| --- | --- | --- |
| ① | 插件配置系统：manifest `configSchema` → 前端表单 + 持久化 + 热更新 | **已落地**：`configSchema` 采用 schemastery 3.18.0（`packages/core/src/index.ts` 的类型 + 内置插件均为 `Schema.object({...})`）；服务端校验 + 白名单裁剪 + 原子落盘 + 已激活插件 `fork.update()` 热更新（失败双向回滚）；管理台按 schema 自动生成表单，无 schema 插件退回 JSON 原文通道（不校验、不裁剪） |
| ② | 外部插件加载：`./plugins` 目录 + 清单发现 | **已落地**：`packages/manager/src/discovery.ts` 的 `loadExternalPlugins()` 发现并加载，`packages/server/src/index.ts` 的 `buildRegistry()` 把外部插件**并入同一注册表**；发现期问题经 `GET /api/plugins` 的 `issues` 字段可观测（见 §4.6）。**当前数量口径**：`packages/server/src/index.ts` 共 **25 条内置插件注册**（`source: 'builtin'`），`config/plugins.base.json` **默认启用 21 条**；**已注册未启用 4 条**：`@geewiki/echo`、`@geewiki/editor-plain`、`@geewiki/oidc`、`@geewiki/postgres` |
| ③ | 前端 Slot 插槽：插件向 Web 管理台贡献 UI | **宿主侧与后端链路均已落地**（详见 §4.8）。真源是 `packages/core/src/slots.ts`（浏览器安全子集，前端经 `@geewiki/core/slots` 子路径导入；`SLOT_NAMES` `:94`、`SlotName` `:123`、`SLOT_CARDINALITY` `:138`）——**前端手抄镜像已删除**（守卫 `packages/manager/test/slots.test.ts` + `packages/web/test/slotPropsMirror.test.ts` 仍在）。**当前 7 个内置插槽**：`app-header`(multi) / `app-footer`(multi) / `editor`(single) / `editor-toolbar`(multi) / `app-dock`(single) / `article-summary`(single) / `account-identities`(multi) |
| ④ | 治理补齐：`drainTimeout` 消费、`conflictGroup` 替换交互、`enable` 回滚作用域 | 三项**均已落地**：排空见 §5.3 L-1（粒度是**全站**在途请求，非 owner 级）；冲突组替换 = `POST /api/plugins/:name/replace` + 管理台顶替确认框（前置校验与前端交互已收紧为三类零副作用阶段拒绝：被顶替者真实激活层非 session → 409 `base_layer`；卸载集合内任一成员真实激活层非 session → 409 `base_layer` + `details.plugins`；目标无法承接依赖边 → 409 `provider_mismatch`）；`enable` 回滚改为全递归共用集合（原缺陷见 §5.3 的已失效条目说明） |
| ⑤ | 容器化：`docker compose up` 可用 | **已落地并实测**（`Dockerfile` / `docker-compose.yml` / [deployment.md](./deployment.md)）。残留的运行期口径见 §5.3 L-12 |
| ⑥ | PostgreSQL 适配 | **已落地**：真 PG 15 端到端验证通过（迁移失败 0、插件 20 active / 0 error）；`DatabaseAdapterAsync` 双轨 + 方言迁移目录双路径已就位。当时的"延期"论证已作废，不再保留 |
| ⑦ | 检索与问答（AI 原生能力） | **检索地基已落地并默认启用**：`@geewiki/search`（FTS5 + `trigram` + 短词 LIKE 兜底，见 §2.4；跨包契约见 §5.3 L-18）。**LLM 契约层已落地**（`@geewiki/llm`：注册表 + 稳定错误码 + 终止保证 + 密钥只存环境变量名 + 脱敏），厂商实现是独立插件 `@geewiki/openai`（已登记进 `defaultRegistry()` 与默认基础层清单）。**AI 界面全部由插件经插槽提供**，宿主不产 AI 节点。**现行 AI 端点**：`/api/ai/turn`、`/api/ai/assistant/capabilities`、`/api/ai/summary`、`/api/ai/summary/search`、`/api/ai/summary/capabilities`、`/api/ai/journal`、`/api/ai/journal/undo`。**未做 / 有意后置**：向量语义检索（§5.4 F18）、插件的进程内隔离模式（§5.4 F10） |

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
> **依赖前提**：schemastery 现已**正式声明为工作区依赖**——17 个包的 `package.json` 均为 `"schemastery": "3.18.0"`（含 `packages/core` / `packages/manager` / `packages/plugin-wiki` / `packages/plugin-echo`）；**cordis 4.0.0-rc.10 不依赖它**（其 `dependencies` 仅 `@standard-schema/spec` 与 `cosmokit`）。原稿"工作区尚未声明该依赖"的说法已过时，加依赖的待办已闭合。

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

> 编号约定：本节 `L-n` = Loader/ESM 的**实证事实**；§5.3 的 `L-n` = **已知限制**，两者编号独立，交叉引用时以节号为准。

**L-1 用 `pathToFileURL(absPath).href` 再 `import()`。**

- Linux + Node 22.23.2 下裸绝对路径对**普通路径**可以成功（`probe3-load.mjs` §A 实测成功）；
- 但当路径含 `#` / `?` 时，裸绝对路径按 URL 语义被截断，抛 `ERR_MODULE_NOT_FOUND`（`addendum.mjs` §1：`we#ird?.mjs` → `Cannot find module '.../ext-plugin/we'`），改用 `pathToFileURL()` 后成功。

结论：**统一走 `pathToFileURL()`**，不要依赖"裸路径在 Linux 能用"这一环境特性。

**L-2 同 URL 二次 import 命中缓存（同一实例）；改文件后用 `?v=<mtimeMs>` 拿到新模块。**

`probe3-load.mjs` §B 实测两次 import 同 URL 得到同一模块对象；§C 实测改文件后不带 query 仍是旧模块，带 `?v=mtime` 得到新模块。ESM 无 `require.cache`，**热重载只能靠 query 击穿缓存**（旧模块实例不会被回收，反复重载会累积，见 §5.3 L-6）。

> **限定（实测补充，勿与插件 UI 的结论混淆）**：以上是 **Node 侧**（后端动态加载外部插件）的事实。**浏览器侧**加载插件 UI bundle 时，query 击穿缓存这条路**已被实测否决**——dev 下给根相对 URL 加 `?v=` 会触发 Vite `injectQuery` 改写而 **500**；改用同源绝对 URL 后虽能加载，但 `rev` 变化产生新模块实例会导致**插槽条目翻倍**（实测 widget 2→4）。故插件 UI 的最终形态是 **URL 不带 query、`rev` 只作变更检测**（详见 §4.5 与 §5.3 L-6）。

**L-3 目录说明符直接 import 失败。**

`import(pathToFileURL(dir).href)` → `ERR_UNSUPPORTED_DIR_IMPORT`（`probe3-load.mjs` §D）。**必须解析到具体文件**，即入口解析顺序不能省。

**L-4 Node 22.18+ 可直接执行 TS，但仅限可擦除语法。**

本机 `v22.23.2` 实测：普通 TS 插件动态 import 成功（`probe3-load.mjs` §E）；但只要用到 `enum`，即抛 `SyntaxError code=ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，message 为 `TypeScript enum is not supported in strip-only mode`（`addendum.mjs` §2）。**外部 TS 插件应统一走 `tsx` loader**，避免用户踩"可用语法子集"的坑。

**L-5 插件导出形态沿用 cordis 约定。**

`mod.default ?? mod` 得到 `{name, apply(ctx, config)}`；`probe3-load.mjs` §F 实测动态 import 得到的模块可直接 `ctx.plugin(plugin, config)` 并正常 `dispose()`。

### 2.4 SQLite FTS5 与中文分词（本阶段实证）

> 编号约定：本节 `T-n` = **分词器 / FTS5 的实证事实**（Tokenizer）；§5.3 的 `L-n` = 已知限制，§2.3 的 `L-n` = Loader 事实，三者编号独立，交叉引用时以节号为准。

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

> **落实情况（重要，勿再按"当时不需要"理解）**：这两条初稿要求在中间某版曾被**判定为"不需要"**（依据是当时资产只来自 `publicDir`），**该裁决后来被推翻**——引入双资产根（`<插件目录>/dist` 优先）后，资产可能位于 `publicDir` 之外，故**挂载点与 proxy 现在都需要**，实现形态是"按名查根表 + 绝不 SPA fallback"。核对：`packages/web/vite.config.ts:24` 含 `'/plugins-ui'`；`packages/server/src/index.ts` 含 `servePluginUiAsset()`（`:386-434`）与 `/plugins-ui` 分支（`:448-451`）。详见 §4.3。

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

**契约歧义裁决汇总（本轮拍板，均标注"裁决"；复核点见 §4）**

前四项歧义均已裁决。逐条结论落在其本条目下，此处只做索引，避免两处各写一份而漂移：

| 歧义 | 裁决 | 落地位置 |
| --- | --- | --- |
| 清单双来源优先级 | **保持实现、改文档**：`package.json#geewiki` 优先，`geewiki.manifest.json` 兜底；二者同时存在时**整体取前者**（fallback 链，非字段合并） | 批次 B「发现规则」 |
| `layer` 字段语义 | **两个端点分别裁决（勿读成同义）**：`GET /api/plugins/:name/config` 的 `layer` = **持久化层**（对齐 D-5），同端点新增 `activeLayer` = 激活层（未激活 `null`）；`GET /api/plugins` 列表的 `PluginSnapshot.layer` **仍是激活层**，语义不变 | 批次 C「关键契约（端点）」+ 本节"契约歧义裁决汇总" |
| D-2 的 `internal/update` 中间件 | **接受实现偏离**：不要求中间件形态，行为等价即可；由批次 C 的 C-5 类双向回滚断言兜底。**原子写未降级**：已内联在 `writeList()`（`packages/manager/src/index.ts`，临时名带 pid + 随机后缀、`flag: 'wx'` 独占创建），保留为必须项 = 已满足。**警告**：不要再补注册落盘中间件（会双写） | D-2 |
| schemastery `bitset` | **暂保留降级为 JSON 编辑**（未满足 S-13 的多选 + 按位或 number） | §5.3 L-13 |


## 4. 插件 UI 入口表与静态层契约

本节是全仓**唯一**记录这些契约的地方（原 `docs/plugin-platform-plan.md` §9"事实核对记录"表已随该文件删除，本节是其中仍然有效的部分）。涉及行号时以当前源码为准。

### 4.1 `GET /api/plugins/ui`：响应形状与判定顺序

- **响应形状**：`{ ok: true, version: 1, revision, plugins: Record<插件名, { entry, css?, rev }>, skipped: [{ name, reason }] }`。
- **只列三条件同时满足者**：名字合法 ∩ 当前已激活 ∩ 声明了 `client` 且入口文件在某个候选根里**确实存在**。
- **`skipped` 的四个 `reason`**（互斥、每插件至多一条、按 name 排序）：`'inactive' | 'no_client' | 'entry_missing' | 'invalid_name'`；**判定顺序**：`invalid_name` > `inactive` > `no_client` > `entry_missing`。
- **空表仍 200，永不 404**。
- 响应头 `cache-control: no-store` + `ETag: "<revision>"`；`If-None-Match` 命中 → **304 无 body**。`stripEtagWeakness()`（`packages/manager/src/index.ts:2656`）只剥离可选 `W/` 与前后引号后**全等比较**，**不做 RFC 7232 列表 / 通配符解析**（刻意的简化，源码注释已写明）。
- **`client` 契约**：`geewiki.client?: { entry?: string; css?: string }`；`entry` / `css` 均为**单段文件名**（`PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`），`entry` 缺省 `client.js`，`css` 缺省不注入样式；声明非法（含 `/`、以 `.` 开头、空白等）→ `pluginUiEntryOf()` **整体视为未声明**且不抛错；**未声明 `client` 的插件永不进入口表**。`geewiki.entry` 是**后端**入口，与 `client` 不可混用。

### 4.2 `revision` / `rev` 的计算，与两个 304 短路缺陷

- `revision` = `sha1(JSON.stringify({ version: 1, plugins })).slice(0, 12)`；**`skipped` 不参与**、`plugins` 按键排序 ⇒ `revision` 与注册表顺序无关。
- `rev` = `sha1(`` `${mtimeMs}-${size}` ``)`.slice(0, 8)（与样式拼接），**只 stat 不读内容**。
- **缺陷一（`revision` 不含 `skipped`）**：当"未启用 / 无界面插件集合"变化时 `revision` 纹丝不动、304 命中 ⇒ 管理台**永远看不到** `skipped` 的变化。**修法**：`syncPluginUi` 加 `force` 参数（`const useEtag = !force && lastRevision !== undefined && isSettled()`）；管理台 `AdminPage.load()` 走 `syncPluginUi({ force: true })`（不带 `If-None-Match`），而 15s 可见期轮询仍走 304 短路。
- **缺陷二（`revision` 只是表内容哈希）**："启用 → 停用 → 再启用"会回到**同一个**值 ⇒ 若此前某次加载失败，304 会让宿主**永久**漏加载那个插件。**修法**：`isUiSettled(entries, loaded, failed)`（`packages/web/src/lib/pluginUiPlan.ts:599`；304 短路开关在 `packages/web/src/lib/pluginUi.ts:614-615`：`const useEtag = !force && lastRevision !== undefined && isSettled()`）——**未收敛时不带 `If-None-Match`**（强制取一次完整表重新对齐），并以 `rev` 为键**记忆加载失败**，把"已按同一 rev 失败过"视为已收敛，避免 15s 轮询对同一个坏产物反复 import 与重复告警（`rev` 变化后自然重新尝试）。
- 另：请求失败 / 非 2xx / JSON 解析失败 / 格式不可信时**既不加载也不卸载**（只 `console.debug`），避免网络抖动清空已加载 UI。

### 4.3 双资产根与静态层

- **URL 形态**：`/plugins-ui/<插件名>/<相对路径>`；入口与样式是单段文件名，**其它资源可嵌套子目录**（段数 ≤ `PLUGIN_UI_ASSET_MAX_DEPTH = 16`）。**插件名不编码**（scope 名 `@geewiki/wiki` 就是两段），**编码名一律 404**。
- **双资产根，顺序即优先级**：① `<插件目录>/dist`（外部插件自带产物）；② `<webDist>/plugins-ui/<名>`（内置与夹具）。**"用哪个根 / 入口在不在"只有一份实现**——`packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiHit`，被入口表 `buildPluginUiTable` 与静态层根表 `pluginUiRootsFor` **共同调用**（关键不变式：两处各算一遍就会出现"表里说就绪、资产却 404"或"`rev` 变了内容还是旧的"）。**遗留（改名未做，如实记录）**：`resolvePluginUiRoots` / `resolvePluginUiHit` / `BuildPluginUiTableOptions.webDist` / `pluginUiRootsFor` 的形参**仍叫 `webDist`**（`packages/manager/src/plugin-ui.ts:199` / `:217` / `:243` / `:337`），语义已是"第二候选根的内置根"。
- **静态层 `servePluginUiAsset`**（`packages/server/src/index.ts` 的 `servePluginUiAsset()`，当前在 `:1062`）：按段还原插件名 → **精确查根表** → 入口单段 / 资源嵌套相对路径校验 → **段比较**包含判定 → **绝不 SPA fallback**，缺失即 404 `application/json`（`sendNotFound()`，当前在 `:1027`）；`serveStatic()`（当前在 `:1160`）的 `/plugins-ui` 分支命中后直接 `return`。静态层按名查根**不按激活过滤**（刻意的：刚被停用的插件可能还有在途 import 要结算，给 404 只会制造无谓 console error）。
- **`isContained()` 用段比较，刻意不用 `startsWith`**：前缀比较会让 `/a/b-evil` 通过 `/a/b` 的检查。
- **`GEEWIKI_PLUGIN_UI_DIST` + `ServerOptions.pluginUiDist`，缺省回落 `webDist`**（prod 与既有行为不变）。**两个 `null` 语义不同**：`pluginUiDist: null` = "不使用内置根（只看插件自带产物）"；`webDist: null` = "不启用静态服务"。根 `dev` 脚本用 `GEEWIKI_PLUGIN_UI_DIST=packages/web/public`，`dev:server` / `start` 保持默认 `packages/web/dist`；启动日志**同时打印两个根**，二者相同时附注"（同静态产物根）"。
- dev 下 `packages/web/vite.config.ts:24` 的 `server.proxy` 有 `'/plugins-ui'`（资产可能来自 `plugins/<name>/dist`，位于 `publicDir` 之外，dev 下 Vite 不会提供它）；且 Vite 的 proxy 中间件排在 `publicDir` 之前，故这条会覆盖 `publicDir` 的默认静态服务。

### 4.4 静态层根表禁止缓存（提交 `a24241a`，决策）

`packages/server/src/index.ts` 的 `pluginUiRoots` **必须每请求现算**（现为 `servePluginUiAsset()` 内的 `roots.pluginUiRoots?.() ?? {}`（`packages/server/src/index.ts:1087`）与静态层根表闭包（`:1256`））。**理由（寿命必须一致）**：入口表每请求现算，根表若缓存则两者寿命不同 → "入口表说该插件就绪（并给出 `rev`），静态层却从**已消失的根**取文件 → 404"，而前端还会照表去 import 那个 404 资产。**触发条件**：同名入口文件在**两个候选根都存在**，随后高优先级那个根消失——`resolvePluginUiHit` 会回退到次优先根并在表里继续列出该插件，而缓存仍指着已消失的根（回归用例：删掉高优先级根的同名入口 → 同一资产必须 200 且回退为次优先根内容，并断言入口表 `rev` 等于此刻真正被服务的那个文件）。**注意**：保留"函数"形态是另一件事——它解开的是"http 条目早于外部插件发现"的注册顺序陷阱，与缓存无关。代价可控：`pluginUiRootsFor()` 只对声明了 `client` 的插件做几次 stat。

### 4.5 `?v=<rev>` 缓存击穿参数（实测证伪，最终方案未使用）与 `/* @vite-ignore */`

- **`/* @vite-ignore */` 并不能阻止 Vite 改写动态 import**。dev 之所以没踩坑，是因为 `pluginUiBase()` 返回的是**同源绝对 URL**（首字符 `h`），而 Vite 的 `injectQuery` 只对以 `.` / `/` 开头的 URL 追加参数。**因此"同源绝对 URL"是硬要求，不要改成相对路径**（源码侧依据 `packages/web/src/lib/pluginUiPlan.ts:24-26`）。
- 给 URL 加 `?v=` 的两条独立证伪：① 给**根相对** URL 加 `?v=` 在 dev 下会触发 Vite `injectQuery` 改写成 `?import&v=…` → **必然 500**（`This file is in /public…`）；② 即便改用**同源绝对 URL** 绕开改写，`rev` 变化会产生**新模块实例**，而 `registerSlot` 是 append、已加载集合只按插件名去重 → **插槽条目翻倍**（实测 widget **2→4**），且 ESM 无法从模块图卸载。
- **最终形态**：import URL **不带任何 query**，`rev` **只用于变更检测**；真正换代码的路径是 unload → load（**同一 URL 命中模块缓存** ⇒ **插件产物更新后需整页刷新才会生效**）。ESM 无法从模块图卸载这一条**仍是已知边界、不是待办**（`packages/web/src/lib/pluginUi.ts:47-50` 的「已知边界（决策，不是待办）」）。

### 4.6 `skipped` 的前端分级展示，及其与发现期 `issues` 的语义区别

- **分级（提交 `3bdcf4b`）**：`classifyUiSkips(skipped)`（`packages/web/src/lib/pluginUiPlan.ts:508`）按 `reason` 分级——`entry_missing` / `invalid_name` → `attention`，`inactive` / `no_client` → `normal`；配 `UI_SKIP_LABEL` / `UI_SKIP_HELP`（`:522` / `:530`，四值中文标签与解释，如 `entry_missing` → 「界面产物缺失」+「通常是发布时漏带 dist/ 目录」）。管理台（`packages/web/src/pages/GraphPage.tsx`，宿主路由 `plugins`「插件管理」）把 `attention` 渲染成 warning Card（标题「有 N 个插件的界面没能加载」，`:808-834`）、`normal` 渲染成默认收起的可折叠 `<details>`（`:837-853`）。**分级的理由**：`entry_missing` 是"作者声明了界面、产物却没跟上"的**真实故障**，必须显著；`inactive` / `no_client` 是**预期状态**，与故障同级用告警样式呈现只会让真正的故障淹没在噪声里。注：`packages/plugin-ops/ui/index.tsx` 是**「审计与运维」台面**（宿主路由 `audit`），**不是**插件管理界面；原审计引的 `packages/web/src/pages/AdminPage.tsx` 已删除。
- **读取路径**：`parseUiTable` 直接丢弃 `skipped`，故补了最小订阅式读取 `pluginUiState()`（`packages/web/src/lib/pluginUi.ts:319`）与 `subscribePluginUiState()`（`:308`；快照引用稳定、变更后才通知），管理台在 `packages/web/src/pages/GraphPage.tsx:328` 经 `useSyncExternalStore` 消费；**没有新写第二份 fetch**；解析侧 `readSkipped`（`packages/web/src/lib/pluginUiPlan.ts:437`）**刻意从宽**（`skipped` 坏掉绝不能让"加载 / 卸载"也判为不可信）。
- **两通路职责不同，不得混用**：`GET /api/plugins/ui` 的 `skipped` = "**插件在（已注册 / 已发现），但它的前端界面没加载**"（UI 产物就绪性的唯一机器可读出口；典型情形：清单声明了 `client` 却忘了跑 `build:fixtures` → `entry_missing`）；`GET /api/plugins` 的 `issues` = "**整个插件都没加载进来**"（发现 / 加载期失败：目录、清单、入口模块）。管理台告警块已把区别写死：「这些插件**已在注册表中**，但它们的**前端界面**没有出现在管理器里——与上面的'发现期问题'不同：那一类是整个插件都没加载进来，这一类是插件在、界面缺。」
- **`issues` 形状（`GET /api/plugins`）**：`ok(h, { plugins: manager.snapshot(), issues: manager.discoveryIssues() })`；`issues` 元素为 `DiscoveryIssue` = `{ code, dir, message }` 三字段，**没有 name 字段**（失败目录未必解析得出插件名）。`code` 八值枚举：`'missing_manifest'` / `'invalid_manifest'` / `'entry_not_found'` / `'invalid_plugin_path'` / `'invalid_plugin_dir'` / `'duplicate_plugin'` / `'invalid_module'` / `'load_failed'`。插件根目录不可读时记 `code: 'invalid_plugin_dir'`、`message: 插件根目录不可读，已跳过全部外部插件: …`。新增字段属**向后兼容**。

### 4.7 依赖阻止停用的专门说明块（提交 `3bdcf4b`）

后端 `409 has_dependents`（`details.dependents` 为依赖方名单）现被管理台捕获并弹出**专门说明块**（`packages/web/src/pages/GraphPage.tsx:911-949`，标题在 `:918`）——标题「无法停用「X」：还有插件在依赖它」+ 列出依赖方 + **两段可操作指引**（① 先在上表逐个停用依赖方再回来停用目标；② 若它是被同冲突组其它插件顶替，可在目标插件那行点「启用」走**冲突组替换**，会连同依赖方一起安全接管）。`dependentNamesOf()`（`packages/web/src/pages/GraphPage.tsx:142`，在 `:431` 捕获 `has_dependents` 时调用）**防御性**读取 `details`：形状不符退回空数组 → 走兜底文案，**不显示 `undefined`**。**刻意未实现自动级联停用**（破坏性操作）。

### 4.8 其它已核对事实

- **插槽名的单一真源**：`packages/core/src/slots.ts`（浏览器安全子集，前端经 `@geewiki/core/slots` 导入；此前 `web/src/lib/slots.tsx` / `pluginUiPlan.ts` / `SINGLE_OCCUPANCY_SLOTS` 的手抄镜像**已删除**——镜像漂移是静默故障，别再抄回去）。除 7 个内置名外，**插件自定义插槽名也合法**：须匹配 `PLUGIN_SLOT_NAME = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/`（**至少含一个 `/`**）；不可信来源用 `SlotName`，宿主自己固定的渲染点用 `BuiltinSlotName`（编译期挡住写错）。守卫为 `packages/manager/test/slots.test.ts` + `packages/web/test/slotPropsMirror.test.ts`。**后端插槽链路** = 清单 `geewiki.slots: SlotName[]` 由管理器在激活时登记 + 运行期 `ctx.get('slot').contribute(owner, slot, meta?)`，**无 `ctx.slot()` 方法糖**；提供者 `@geewiki/slot`（`packages/manager/src/slot-plugin.ts`）必须在管理器之前注册（根因见 §5.2 的 provide 时序陷阱）。`GET /api/plugins/slots` 读端点**刻意 public**、写端点 admin。前端只认 effective（被抑制者不得注册组件，因为后端在生效集合为空时会省略 `slots` 键）。
- **`packages/server/src/index.ts` 的 `/plugins-ui` 静态分支注释已过时**：注释写"交给前端 `?v=<rev>` 自行击穿缓存"，真实行为是 `cache-control: no-cache`，而前端**已彻底不使用 `?v=`**（见 §4.5）。**登记为待代码批清理项**。
- **`packages/web/tsconfig.json` 的 `types` 现为 `["vite/client", "node"]`**、`include` 增加 `test`（为让 `test/*.test.ts` 通过 `tsc --noEmit`）。**已知副作用**：`packages/web` 是浏览器侧代码，但类型检查**不再拦截 Node API 的误用**（在 `src/` 里 import `node:fs` 不再报错，真正的失败推迟到浏览器运行期）。
- **`build:fixtures` 现在的行为**（`packages/web/package.json`）：`rm -rf public/plugins-ui && vite build --config fixtures/vite.config.ts && FIXTURE_OUT=@geewiki-plugin/hello FIXTURE_OUT_DIR=../../../plugins/hello-geewiki/dist vite build --config fixtures/vite.config.ts`。① **先全清**（旧生成物残留正是"入口表说就绪、资产却 404"的成因，故不做增量）；② hello 夹具产物落 `plugins/hello-geewiki/dist/`（演示"插件自带产物根"）；③ **不再生成 `registry.json`**（入口表已由后端现算）。`FIXTURE_OUT_DIR` 的相对路径从 `fixtures/` 解析，故必须写成 `../../../plugins/hello-geewiki/dist`。
- **浏览器端到端验收脚本**：`scripts/acceptance/plugin-ui-cdp.mjs`（已入库，零依赖：Node 内置 WebSocket + 直连 CDP）。用法 `node scripts/acceptance/plugin-ui-cdp.mjs <页面 URL> [cdpPort] [--missing-asset=<文件路径>]`，需要 Chrome + 运行中实例 + 已构建插件产物，**故刻意不接入 `pnpm test`**。dev 与 prod 需各跑一遍（`?import` 改写只在 dev 出现）。**未验证项**：只在 **Chromium** 上实测过。
- **长连接出口的接口归属**：`HttpRouterService.trackStream?(res, owner?)` 与 `closeStreams?(owner?)` **都在服务接口上**；另有 `noteStreamRejected?()` 与 `HttpStreamStats`（`streams.active` / `streams.rejected`）。语义：**未登记 owner 的连接无法被定向回收**（显式后果，不是静默行为）。**仍然有效的一条实测证伪**：**不要**用"先 `res.writeHead(200, { 'content-type': 'text/event-stream' })` 再 `h.json(200, null)`"来实现"只记一次指标"——`writeHead` 后 `res.headersSent` 立即为 `true` 而 `writableEnded` 仍为 `false`，`json()` 会跳过 `writeHead` 却**仍无条件执行 `res.end(JSON.stringify(body))`**，给事件流追加字面 `null` **并立即终结流**（实测客户端正文 `event: status\ndata: {"type":"status"}\n\nnull`）。正解是用 `noteStatus()`（只记指标、不结束响应），它与 `json()` 共用同一记账点、由幂等守卫保证每请求只记一次。
- **`@geewiki/openai`**：已登记进 `defaultRegistry()`（`packages/server/src/index.ts`）与默认基础层清单，作为 `llm-service` 的一条真实路由（`conflictGroup: 'llm-provider'`）。`@geewiki/llm` 只有契约层：注册表 + 稳定错误码 + 终止保证 + 不重试 + 密钥只存环境变量名 + 脱敏；厂商实现永远是独立插件。

## 5. 当前限制与风险

本节合并了两份来源里**仍然成立**的风险条目：原平台自由度审计报告 §3.1（安全）/ §3.2（可靠性）/ §5（有意后置）/ §6（结论），以及原 `plugin-platform-plan.md` §5 的 L-* 已知限制（已按当前代码逐条复核取舍）。**已闭合的历史流水不再收录。**

### 5.1 安全

整体安全姿态**高于平均水平**：CSRF 三层闸门（`packages/plugin-auth/src/http.ts:93-134`，`Sec-Fetch-Site` + `Origin` + 自定义头 `x-gw-csrf`）、`SameSite=Lax`（`:64`）、登录失败限流（`packages/plugin-auth/src/index.ts:132`，429 + `login.rate_limited` 审计）、Markdown 消毒单点（`packages/web/src/lib/sanitize.ts`）、schemastery 刻意避开 `new Function`（`packages/manager/src/config-schema.ts:11`）、插件 UI 静态层四层防护 + 段比较 `isContained()` + `realpath`、外部插件 `realpathSync` 防穿越、看门狗熔断。以下是**仍存在的**问题：

| 级别 | 问题 | 证据 | 现状 / 建议 |
| --- | --- | --- | --- |
| **中** | **路由访问等级默认 `public`**：`register()` 第 4 参可省，省略即匿名可调；全仓 50+ 个 `.register(...)` 调用点全靠作者自觉 | `packages/core/src/index.ts:567-570`（`access?`，注释「省略等价于 `{access:'public'}`」） | **F11 审计钩子已落地并在工作**：启动时把未显式声明 `access` 的路由聚合成一条告警——当前实跑仍可见 `[geewiki] 1/18 条路由未显式声明访问等级，正按默认 'public'（匿名可调）运行：`；`GEEWIKI_STRICT_ROUTE_ACCESS=1` 时**拒绝启动**（`packages/server/src/index.ts:273-310`）。**仍建议**① 长期把默认改为 `user`，`public` 必须显式写 |
| **中** | **插件进程内无隔离、无资源配额**：插件与宿主同进程、同权限，可任意读写文件系统 / 发网络请求 / 死循环 / OOM。一个坏插件能拖垮整站 | 设计自认「插件平台内的插件本就能执行任意代码」（`packages/core/src/index.ts:1159`） | F14 已做 `runtime.applyTimeout`（缺省 30s + 晚到 fiber 回收）；F10 已做 `permissions` 清单 + 激活提示 + 快照下发 + 「用法 ⇒ 必须声明」守卫；**剩余风险收缩为「同进程同权限」这一条架构前提**——一个拿到 `fs:write` 的插件仍能改写宿主文件，那不是配置能解决的，只能靠进程边界。worker / 子进程隔离模式**有意后置**（§5.4） |
| **中** | **外部插件无发布者签名**：装进来的代码即得以全权限运行 | F17 已落地「安装 + 完整性校验」：`pnpm run install-plugin <目录\|.tgz\|https URL>` + `--verify`、`GET /api/plugins/integrity`（admin） | **仍缺远端注册表与发布者签名**。注意 `--verify` 的结果有三种，其中 `unsigned`（没有基线 ⇒ 无法判断）**刻意与 `ok` 分开**——把"无法判断"报成"通过"正是这类设施最容易退化成"看起来在防护、实际什么都没防"的方式 |
| **低** | 普通配置字段在 `GET /api/plugins/:name/config` **明文返回**（密钥字段已妥善处理：`role:'secret'` + 0600 + 不回显） | `packages/manager/src/secrets.ts`（头部注释明确边界）；§5.3 L-20 | 已充分记档，属可接受的产品取舍；若未来接多租户再收紧 |
| **低** | `config/secrets.json` 明文（0600）。威胁模型 = 能读宿主文件系统者即可读密钥 | `packages/manager/src/secrets.ts:15-19` 自述 | 已有 `apiKeyEnv` 作为更强路径，保持即可 |
| **低** | React Flow `proOptions={{ hideAttribution: true }}` 会在 console 打许可证提示 | `packages/web/src/components/PluginGraph.tsx:416`（原审计引的 `GraphPage.tsx:145` 已无此码） | 合规动作，非漏洞；可评估替换图表库 |

**未发现**：SQL 注入（全仓走参数化 `run(sql, params)`）、路径穿越（静态层有 `realpath` + 段比较守卫）、XSS 注入点（`dangerouslySetInnerHTML` 全部由 `sanitize.ts` 单点供给）、原型污染（`sanitizeSchemaPayload()` 剥离 `callback` / `preserve` / `constructor`）、依赖漏洞（`pnpm audit` 干净）。

### 5.2 可靠性

| 级别 | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| **中** | **ESM 模块实例永不回收** ⇒ 后端插件改码**必须重启进程**；前端插件产物更新**必须整页刷新** | `packages/web/src/lib/pluginUi.ts:47-50` 记为「已知边界（决策，不是待办）」；§5.3 L-6 | 开发迭代摩擦大；「热插拔」名不副实——只有**启停**是热的，**改码**不是 |
| **中** | **`provide` 时序陷阱**：插件 `apply` 未结算时 `provide` 的服务对其间创建的子插件**不可见**，`ctx.get` 返回 `undefined` 并**静默跳过** | `packages/core/src/index.ts:1147-1156`、`packages/manager/src/slot-plugin.ts` 文件头（含实测证据） | 极难排查的静默失效；也是当前 `slot` 必须做独立兄弟插件、顺序排 manager 之前的**根因** |
| **中** | **`slot` 的供应方归属曾被注释写成「由管理器提供」，与实现相反** | 已改正：提供者是独立插件 `@geewiki/slot` 且排在管理器之前，`packages/core/src/index.ts` 的 `SlotService` 文档已写明该时序与理由（`:1530-1538` 附近） | 属**已修复的注释缺陷**，保留登记以防回退——core 注释里写着「归属曾经写错过，别再改回去」（**已经踩过一次**） |
| **低** | 看门狗熔断粒度为**整站**：连续失败 ≥3 且会话非空 → 清 session + `exit(1)` | `packages/manager/src/watchdog.ts`（59 行） | 单个会话插件的故障会触发全站重启。作为安全网可接受，但缺「只回滚该插件」的中间档 |
| **低** | 排空粒度是**全站在途请求**（非 owner 级） | §5.3 L-1 | 卸载一个小插件要等全站请求结算，可能空转满 `drainTimeout` |

> 原审计的「无插件健康检查钩子」一条**已被 F12 推翻**（`module.health?()` 探针 + 带超时聚合 + `GET /api/plugins/health` + owner 请求数归因），不再收录。

### 5.3 已知限制条目（L-*）

> 编号沿用原 `plugin-platform-plan.md` §5 的 L-n，便于从 git 历史对照。**已失效、不再收录**：L-2（`enable` 回滚作用域缺陷——曾真实存在且外部插件可使其可达，已修复并改为全递归共用集合）、L-5（`./plugins` 仅为挂载点——发现逻辑早已落地，残留的"目录不可读"出口见 §4.6 的 `invalid_plugin_dir`）、L-8（详情页「← 返回列表」依赖历史栈——`history.back` / `goBack` / `navigate(-1)` 在 `packages/web/src` 已 **0 命中**）、L-9（PG 延期——已落地）、L-10（容器化 G1–G4——已修且含镜像重建实跑）、L-15（无厂商 adapter——已被 `@geewiki/openai` 推翻）、L-16（SSE 未做——现由 `@geewiki/ai-assistant` 的 `/api/ai/turn` 承担）。

**L-1 排空语义是全站在途请求，不是 owner 级。**
原 `@geewiki/http`（**已并入 `packages/server`**）的 `inflight()` / `drain()` 以整个路由服务为粒度：卸载任一插件时，等待的是**全站**尚未结算的请求（不含发起卸载的那次管理请求）。更精确的 **owner 级排空**（只等待被卸载插件自身路由注册的在途请求）列为后续工作。注意长连接**不占在途**（`trackStream` 的集合刻意不参与 `inFlight`），且流可以按 owner 定向回收。

**L-3 后端直接运行 TS。**
各包 `exports` 指向 `src/index.ts`，运行期依赖 devDependency `tsx`；这与生产镜像裁剪 devDependencies 存在张力。镜像侧的当前处理方式见 [deployment.md](./deployment.md)。

**L-4 未实现项。**
插件市场 / 远端注册表 / 发布者签名、插件前端类型检查、跨插件 `configSchema` 引用（schema 复用）均未实现（签名部分另见 §5.1）。

**L-6 ESM 重载的模块实例不会被回收。**
`?v=<mtime>` 每次都产生新模块实例（§2.3 实证），反复热重载会累积旧实例。当前不做回收；若未来出现高频重载场景需评估。插件 UI 侧的最终形态见 §4.5——import URL 不带任何 query，`rev` 只用于变更检测，**产物更新后需整页刷新才会生效**。

**L-7 React Flow 授权提示会打进 console。**
`packages/web/src/components/PluginGraph.tsx:416` 的 `proOptions={{ hideAttribution: true }}` 会让 React Flow 在 console 打印授权提示（原 plan 引的 `GraphPage.tsx:145` 已无此码）。这是**上游许可证提示，不是缺陷**；是否保留需按许可证条款决定（改回显示署名即可消除）。基线验收时已确认：除该提示外 console 无错误。**该条与其余 L-n 的语义不同**：其余是功能 / 架构限制，本条是法律与观感层面的取舍。

**L-11 外部插件的加载期故障不会阻断宿主启动。**
`loadExternalPlugins` 的设计原则是"加载失败 / 清单缺失 / 重名 / 路径越界只记为 issue 并跳过，绝不阻断宿主启动"。**列目录这唯一一处例外已收敛**（现记 `invalid_plugin_dir` 并跳过，见 §4.6）。此条保留用于强调"例外只应有一处"的边界：后续修复应保持该边界而不是顺带扩大。

**L-12 容器内默认基础层清单是构建期快照，不是运行期同步。**
`COPY --from=builder /src/config /app/config` 把**构建时**的 `config/plugins.base.json` 打进镜像。未挂载 `./config` 时，运行期对基础层的修改（如通过 REST 启停插件）写在容器可写层里，**容器重建即丢失并回退到构建期快照**；挂了卷则卷内容完全覆盖快照。**该取舍本身不是缺陷**，但排障时必须先分辨"当前看的是镜像快照还是卷内容"。

**L-13 schemastery `bitset` 暂保留降级为 JSON 编辑（裁决）。**
`packages/web/src/lib/configSchema.ts:218` 的 `case 'bitset':` 与其它无控件类型一起回落 `kind: 'json'`（配置表单对该类型回落到 JSON 文本编辑，附注「bitset 类型改以 JSON 编辑」）。理由：`bitset` 在当前两个内置插件（`packages/plugin-wiki` / `packages/plugin-echo`）的 `configSchema` 中**均未使用**；载荷侧信息（`bits` 名字→数字字面量映射）已在 §2.2 记录，未来实现时无需重新勘察。**影响面**：仅表现为该类型的配置项需要手工写数字，不产生错误数据（服务端仍按 schemastery 校验）。

**L-14 发现期 issue 的可观测性（已闭合，保留作契约锚点）。**
`GET /api/plugins` 返回机器可读的 `issues`（形状见 §4.6），管理台插件管理页渲染"外部插件发现期有 N 条问题（这些插件未加载）"的提示块。**与 `GET /api/plugins/ui` 的 `skipped` 职责不同**（见 §4.6 的对比）。当前后端在 `packages/manager/src/index.ts` 的 `discoveryIssues()`（`:834`）与路由 `:2360`；管理台 UI 在 `packages/web/src/pages/GraphPage.tsx:796`（`issues.map`；类型与状态在 `:303`）——原 plan 引的 `packages/web/src/pages/AdminPage.tsx:314` 已删除，`packages/plugin-ops/ui/index.tsx` 是「审计与运维」台面而非插件管理界面。

**L-17 向量 / 语义检索未做（有意后置），检索是纯字面匹配。**
当前检索链路为 **FTS5 trigram 子串匹配 + <3 字符的 LIKE 兜底**（见 §2.4），**没有任何 embedding、向量库或语义召回**。`packages/core/src/services.ts` 只有 `EmbeddingProvider` 接口、`EmbeddingServiceError`、`assertEmbeddingResult()` 校验器与 `probeEmbeddingProvider()` 探针，**没有查询接线**。**不做的理由是环境约束**：项目的立身之本是"离线 + 零重依赖 + 开箱即用"（默认只依赖一个 SQLite 文件）；本地跑 embedding 需要预烤模型权重 + ONNX Runtime WASM，两者都会把"`pnpm install` 即可运行"变成"先下载几百 MB 模型"；调用远端 embedding API 则与"没有 API key 也完整可用"的承诺冲突。**后果（如实登记）**：**同义改写、跨语言、模糊表述一律搜不到**（搜「怎么备份数据」不会命中「数据备份指南」）。当前只留接口位（`search-service` 是唯一检索入口，将来换实现不影响消费方）。

**L-18 `snippet` 是已转义的 HTML、`score` 只在同次查询内可比——跨包契约，消费方必须遵守。**
- `snippet` 由 `@geewiki/search` 的 `buildSnippet()`（`packages/plugin-search/src/index.ts:305`）**服务端转义**（正文先按原始下标切片、三段分别 HTML 转义、再拼进 `<mark>`），**只含 `<mark>` 一种标签**。⇒ 前端**不得二次转义**（会显示成字面 `&lt;mark&gt;`），也**不得**当纯文本插入页面（那样高亮会消失）。该设计的价值是：正文里的 `<script>` **不可能逃逸成真标签**。
- `score` 是 FTS 路**取负后的 BM25**（越大越相关）。**这不是归一化**——值域无界、量级随语料规模与查询词变化，故**只在同一次查询的结果内部可比**；LIKE 路恒为 `0`，**两种 `mode` 的 `score` 也不可比**。消费方不得跨查询、跨 `mode` 比大小，也不得把它当"百分比相关度"展示。
- 附：**自实现高亮而非用 FTS5 的 `snippet()`**——trigram 下后者的上限约 64 token（≈ 中文 64 字），太短且会把片段切得很碎（`packages/plugin-search/src/index.ts:170-178`）。

**L-19 `search` / `ask` 是 wiki 下的保留首段 slug。**
`#/wiki/search/<q>` 与 `#/wiki/ask/<q>` 占用 `search` / `ask` 两个**首段 slug**。**保留段共 4 项**，前端与后端各持一份**同为 `['search', 'ask', 'new', 'list']`**：`packages/web/src/lib/wikiRoute.ts:33` 的 `WIKI_RESERVED_FIRST_SEGMENTS` 与 `packages/plugin-wiki/src/index.ts:418` 的 `RESERVED_FIRST_SEGMENTS`（前端注释自认"待其批次对齐"）。⇒ 用户**不能再创建名为这四者之一的页面**（也不能建 `search/edit` 这类路径）；服务端 slug 校验**不会**拦截它们，冲突只在前端路由层显现。这是**主动付出的代价**：换取的是"可分享、刷新不丢"的 hash 子路由，而无需引入前端路由库或改动 Slot 机制。

**L-20 密钥的剩余边界：环境变量由运维设置；`redact` 是启发式且刻意不脱敏模型输出。**
- 配置里只存**环境变量名**（`apiKeyEnv`），**环境变量本身由运维在外部设置**——本系统不负责密钥的注入、轮转与保管。
- `GET /api/plugins/:name/config` 对**普通配置字段**仍**明文返回**；`apiKeyEnv` 只是变量名，故**不构成泄漏**——但若有人无视 `detectSuspiciousCredential` 的拦截把密钥值硬写进**其它**普通字段，它会明文出现在该端点响应里。
- `redact()` 是**启发式**（`packages/plugin-llm/src/redact.ts` 的三条正则源 + 头名遮蔽）：**未覆盖的密钥形态不会被脱敏**。设计取向是"**宁可漏判不可误伤**"——把 `DEEPSEEK_API_KEY` 这类变量名误判成密钥会让插件**无法激活**（配置明明是对的），而漏判只是少脱敏一处日志，故全大写 SNAKE 命名一律放行。
- **`text-delta`（模型输出）刻意不脱敏**：脱敏会**篡改模型输出内容**。若模型自己复述了密钥，它会被原样透传——这是有意的取舍，不是遗漏。

### 5.4 有意后置（"有意不做"，不是待办）

- **F10 的进程内隔离模式**：F10 已交付"`permissions` 清单 + 激活提示 + 快照下发 + 「用法 ⇒ 必须声明」守卫"；**可选的 worker / 子进程隔离模式未做**，属**有意后置**——它要把"同进程同权限"这条架构前提掀掉，成本与收益都远超"清单 + 提示"。
- **F18 的检索查询路径接线**：F18 已交付 `EmbeddingProvider` 契约 + `EmbeddingServiceError` + `assertEmbeddingResult()` 校验器 + `probeEmbeddingProvider()` 永不抛错的探针（`packages/core/src/services.ts`，14 例）。**刻意不带实现**：宿主不必背 `onnxruntime` / `transformers.js` 重依赖，也不绑死供应商。**查询路径接线仍后置**——需先定「向量存哪、维度变更怎么办」，与 §5.3 L-17 同一决策。
- **审计结论（原报告 §6）**：**F1–F21 全部落地，无剩余功能项**；`F18` 的查询路径接线与 `F10` 的隔离模式为**有意后置**。`F19`（PG）已落地，故原 `L-9`「PG 适配延期」应更新（本文档已按此处理）。原报告 §4 优化点 1 / 2 / 3 / 4 / 6 / 7 / 8 均已完成。

### 5.5 开发流程提示

- **未提交的重构批次（原审计"优化点 5"，⏸ 刻意未做，需人授权）**：仓库里曾累积一批规模可观的重构改动，把"提交它们"按语义拆成 5–10 个 commit 是更好的历史形态，但**它会改动仓库历史**，应由仓库所有者确认后执行；当时会话自始至终未提交任何改动。**教训**：大规模重构改动长期留在工作树里，会让"当前口径"与 HEAD 口径持续分叉——**报告读数时必须同时给出 HEAD 与取数时刻**。

## 6. 验证纪律

每一批交付必须同时满足：

1. `pnpm typecheck` **0 错**；
2. `pnpm test`（即 `pnpm -r --no-bail --if-present run test`）**全绿**，且包含该批新增用例。**当前读数以 [../README.md](../README.md) 的「质量基线」段为准，或直接实跑该命令**；本文不复制具体数字（原 plan §6 的读数 A–D 与 §9 的计数行已随批次流失效并删除）。
   - **注意命令里的 `--no-bail`**：此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行，故更早的"全量绿"读数可能是**部分**读数。这是**读数可靠性**修复，不是功能修复。
   - **报告任何读数都必须同时给出 HEAD 与取数时刻**；在并行批次活跃期，单次"全量失败"不足以判定缺陷（原 plan 记过一次 `error TS18003: No inputs were found` 只是读工作树时的中间态，随并行批次补齐 `test/` 自行消失）。
3. **隔离端口**的端到端冒烟（不得占用开发用的 3000 / 5173）；
4. 涉及 UI 的批次必须有**浏览器端到端验收**（真实渲染，而非接口断言）；
5. **每批先经独立 Reviewer 审查，再提交**；
6. 未经验证的假设必须在落地时补上验证结果，或改标注（不得以"已按源码核对"自居却留下已错位的行号——**引用行号前先核对当前源码**）；
7. **UI 交互类交付须对齐质量基线的口径**：console 零错误、无失败请求、真实 DOM 事件驱动，并在验收后清理测试数据。

## 7. 复现内核实证（第 2 节）

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

## 附录 A：已删除 / 已更名的对象（历史，勿再引用）

以下对象**已不存在**，本附录只在"历史"意义上登记它们；要追溯细节请看 git 历史。

- **`@geewiki/plugin-ai`（单体）**：已拆分 / 更名，其原目录与 `generate()` 接线点均不存在。
- **`@geewiki/ai-qa`、`@geewiki/ai-assist`**：已整包删除（P8 决策 22）。
- **`@geewiki/http`**：已并入 `packages/server`（排空 / 静态 / 路由实现都在那里）。
- **`wiki-ask` 插槽与 `#/wiki/ask/<q>` 子路由**：已随 P8 拆除（决策 17）；`'ask'` 仍留在保留首段里（解禁是单向不可回收的，见 §5.3 L-19）。当前 AI 对话的唯一入口是 `app-dock` 插槽。
- **已删除的 AI 端点**：`/api/ai/ask`、`/api/ai/stream`、`/api/ai/capabilities`、`/api/ai/assist`。**现行端点**见 §1 表 ⑦。
- **已删除的文档**：`docs/plugin-platform-plan.md`、`docs/review/plugin-freedom-audit.md`、`docs/changelog/test-ledger.md`（本文档与 [changelog/implementation-log.md](./changelog/implementation-log.md) 是其内容的去向）。
