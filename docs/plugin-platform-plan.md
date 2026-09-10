# GeeWiki 插件化平台：实施批次方案与内核实证

> 本文档面向项目维护者与后续接手者，回答两个问题：**下一步按什么顺序做什么**，以及**底层内核行为已经被实验证实成什么样**。
>
> 文档中的"实证"结论来自 `data/spike/` 下的探针脚本（`probe1-fork-update.mjs` / `probe1b-hooks.mjs` / `probe1c-hook-next.mjs` / `probe2-schemastery.mjs` / `probe2b-payload.mjs` / `probe3-load.mjs` / `addendum.mjs`）。**`data/` 被 `.gitignore` 排除，该目录随时可能被清理**，因此结论在此固化；`data/spike/` 内另装有 `schemastery@3.18.0` 与 `cordis@4.0.0-rc.10`（工作区尚未声明 schemastery 依赖）作为独立验证环境。复现方式见第 8 节。
>
> 现状与设计蓝图见 [architecture.md](./architecture.md)，阶段划分见 [roadmap.md](./roadmap.md)（本文批次 B–F 对应 roadmap 的 Phase 3 / Phase 4 候选清单），容器化细节见 [deployment.md](./deployment.md)。本文编号自成体系，不延续 architecture.md 的章节号。

## 1. 背景与目标

GeeWiki 已具备"清单驱动装配 + 依赖图/冲突组 + 会话沙箱 + 迁移控制器 + 看门狗"的插件管理器（`packages/manager`），但插件的**可配置、可外部扩展、可贡献界面**这三条链路尚未打通。插件化平台需要补齐 6 项能力：

> **落地状态（本轮回填，按代码核对）**：①②**已落地**，③**只有宿主侧一半**，④ 的一半已落地、另一半仍是设计定稿，⑤ 已落地，⑥ 明确延期。逐条见下表与第 4 节各批次。

| 编号 | 能力 | 当前状态 |
| --- | --- | --- |
| ① | 插件配置系统：manifest `configSchema` → 前端表单 + 持久化 + 热更新 | **已落地**：`configSchema` 采用 schemastery 3.18.0（`packages/core/src/index.ts:72` 的类型 + 两个内置插件均为 `Schema.object({...})`）；服务端校验 + 白名单裁剪 + 原子落盘 + 已激活插件 `fork.update()` 热更新（失败双向回滚）；管理台按 schema 自动生成表单，无 schema 插件退回 JSON 原文通道（不校验、不裁剪） |
| ② | 外部插件加载：`./plugins` 目录 + 清单发现 | **已落地**：`packages/manager/src/discovery.ts` 的 `loadExternalPlugins()` 发现并加载，`packages/server/src/index.ts` 的 `buildRegistry()` 把外部插件**并入同一注册表**；内置插件仍由 `defaultRegistry()` 代码内置登记（4 个：`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/echo` / `@geewiki/wiki`）；发现期问题经 `GET /api/plugins` 的 `issues` 字段可观测（L-14） |
| ③ | 前端 Slot 插槽：插件向 Web 管理台贡献 UI | **部分落地（仅宿主侧）**：`window.__GEEWIKI_HOST__` 宿主 SDK + `packages/web/src/lib/slots.tsx` 的 `registerSlot` / `SlotOutlet`（含 ErrorBoundary）+ `/plugins-ui/<name>/client.js` 动态加载；插槽名白名单**仅 `app-header` / `app-footer`**。**未落地**：后端 `ctx.slot()` 注册链路、`editor-toolbar-slots` / `admin-page-slots`、Suspense 懒加载、fork 生命周期绑定（详见 `docs/architecture.md` §6） |
| ④ | 治理补齐：`drainTimeout` 消费、`conflictGroup` 替换交互、`enable` 回滚作用域 | 排空**已落地**（粒度是**全站**在途请求，非 owner 级，见 L-1）；冲突组仅有互斥拦截（替换交互 G-1 设计已定稿、代码未落地）；`enable` 回滚为调用帧局部（缺陷仍在，G-2 修法已定稿、代码未落地） |
| ⑤ | 容器化：`docker compose up` 可用 | **已落地并实测**（`Dockerfile` / `docker-compose.yml` / `docs/deployment.md`；G1–G4 的逐条状态见第 5 节 L-10） |
| ⑥ | PostgreSQL 适配（评估） | 未落地，`DatabaseAdapter` 目前为同步接口；**已裁决延期**（依据与前置条件见第 5 节 L-9） |

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
| `meta.hidden === true` | 不渲染，但保留默认值 |

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

**L-3 目录说明符直接 import 失败。**

`import(pathToFileURL(dir).href)` → `ERR_UNSUPPORTED_DIR_IMPORT`（`probe3-load.mjs` §D）。**必须解析到具体文件**，即入口解析顺序不能省。

**L-4 Node 22.18+ 可直接执行 TS，但仅限可擦除语法。**

本机 `v22.23.2` 实测：普通 TS 插件动态 import 成功（`probe3-load.mjs` §E）；但只要用到 `enum`，即抛 `SyntaxError code=ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，message 为 `TypeScript enum is not supported in strip-only mode`（`addendum.mjs` §2）。**外部 TS 插件应统一走 `tsx` loader**，避免用户踩"可用语法子集"的坑。

**L-5 插件导出形态沿用 cordis 约定。**

`mod.default ?? mod` 得到 `{name, apply(ctx, config)}`；`probe3-load.mjs` §F 实测动态 import 得到的模块可直接 `ctx.plugin(plugin, config)` 并正常 `dispose()`。

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

**原子写是必须项，且已满足（撤回上一版"未落地"的标注）**：D-2 的"`.tmp` + `rename` 原子替换"**已内联实现在既有的 `writeList()` 里**（`packages/manager/src/index.ts:178-184`：先 `writeFileSync(tmp)` 再 `renameSync(tmp, file)`），并有断言钉住"不留 `.tmp`"（`packages/manager/test/config.test.ts:162`：`assert.equal(existsSync(\`${env.baseFile}.tmp\`), false, '原子写不应留下 .tmp')`）。**只是没有独立成 `packages/manager/src/config-store.ts`**——该文件不再需要新建（见批次 C 文件表）。**结论：原子写保留为必须项，状态=已满足。**

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

- 后端新增 `/plugins-ui/<name>/client.js` 与 `/plugins-ui/<name>/client.css` 静态路由。注意现有静态托管把 root 锁死在 `webDist`（`packages/server/src/index.ts:350-397` 的 `serveStatic(root, ...)`，root 由 `:540-548` 解析后经 `:434` 传入），因此插件 UI 资源不能靠现有托管顺带覆盖，必须显式加挂载点；
- dev 模式在 `packages/web/vite.config.ts` 的 proxy（当前仅 `{'/api': 'http://127.0.0.1:3000'}`，见该文件 `:12`）里追加 `'/plugins-ui'` 转发到 `3000`。

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
| D-2 的 `internal/update` 中间件 | **接受实现偏离**：不要求中间件形态，行为等价即可；由批次 C 的 C-5 类双向回滚断言兜底。**原子写未降级**：已内联在 `writeList()`（`packages/manager/src/index.ts:178-184`），保留为必须项 = 已满足。**警告**：不要再补注册落盘中间件（会双写） | D-2 |
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

**G-1 `conflictGroup` 替换交互：新增独立端点 `POST /api/plugins/:name/replace`（设计已定稿、代码未落地）**

请求体：`{ config?: Record<string, unknown> }`（可选，作为目标插件替换激活时的配置）。

| 状态码 | 码值 | 含义 |
| --- | --- | --- |
| 200 | — | `{ok, plugin: PluginSnapshot, replaced: {name, config}, restarted: string[]}`——`replaced` 是被替换（停用）的旧插件，`restarted` 是被级联重启的依赖方列表 |
| 409 | `base_layer` | 旧插件不在 session 层（基础层插件不允许被替换下线） |
| 409 | `hot_reload_not_supported` | 目标插件不支持热重载 |
| 409 | `hot_dependency_not_supported` | 热链上存在不支持热重载的依赖方 |
| 400 | `load_failed` | 目标插件加载失败 |
| 400 | `migration_failed` | 目标插件迁移失败 |
| 500 | `replace_rollback_failed` | **新增错误码**：回滚（恢复旧插件与依赖方）也失败，需人工介入 |

⚠️ `replace_rollback_failed` **必须同步加入"错误码 → HTTP 状态"映射表**（否则会被当成未知错误码兜底成 500 但语义丢失）。

**流程**：

1. 目标插件**已激活** → 幂等返回（不重复替换）；
2. **无冲突方**（该 `conflictGroup` 内没有其它已激活插件）→ **降级走 `enable`**，不必走替换路径；
3. 否则前置校验三项：目标插件支持热重载、热链可用、**旧插件确实在 session 层**（在 base 层则 409 `base_layer`）；
4. 取旧插件的**依赖方传递闭包**——`packages/manager/src/deps.ts` **需新增 `collectDependentsClosure`**：现有 `collectDependents` 只查**直接**反向边，替换场景必须拿到**传递**闭包（否则孙依赖会被留在半激活状态）；
5. 与旧插件合并成待停用集合，按拓扑序**逆序卸载**（依赖方先卸、旧插件后卸）；
6. 激活目标插件；
7. 失败 → **先防御性卸载目标**（避免半激活污染），再恢复旧插件与依赖方；恢复也失败 → 500 `replace_rollback_failed`；
8. **成功时只写一次 session 清单**；失败则零落盘——**天然原子**（不在中途分多次落盘）。

**裁决**：采用"**级联停用并自动重启依赖方**"而非"有依赖方即拒绝"。理由：拒绝会让用户**永远无法完成同组替换**（同组互斥且真实依赖普遍存在）；而静默断供不可选。**代价已接受**：最坏情况出现 `N × drainTimeout` 的短暂中断（N = 被级联停用的插件数，`drainTimeout` 默认 5 秒）。**前端确认文案必须预告该中断**（让用户在点确认前知道会短暂不可用）。

**G-2 `enable` 回滚作用域缺陷：已确认缺陷 + 已定稿修法（设计已定稿、代码未落地）**

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
| `packages/core/src/index.ts:72` | `configSchema?: ConfigSchema`；`ConfigSchema` 定义在同文件 `:30`：`export type ConfigSchema = ReturnType<typeof Schema.any<any>>`（`:14` 为 `import type Schema from 'schemastery'`） |
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
| 修改（方案甲，已落地） | `packages/core/src/index.ts:30` + `:72` —— `ConfigSchema` 类型与 `configSchema?: ConfigSchema` |
| 修改（方案甲，已落地） | `packages/plugin-wiki/src/index.ts:27-33` / `packages/plugin-echo/src/index.ts:22-26` —— 字面量改写为 `Schema.object({...})` |
| 修改（**修正**，已落地） | `packages/manager/src/index.ts` —— `updateConfig` + 两个 REST 端点（注册在 `:1126` / `:1135`）；`snapshotOf` 携带 schema（**下发前剥离 `callback` / `preserve`，见 S-8**）。**原子写落在既有 `writeList()` 内**（`packages/manager/src/index.ts:178-184` 已内联 `.tmp` + `renameSync`），**未新建 `packages/manager/src/config-store.ts`** |
| 修改（已落地） | `packages/web/src/api.ts` —— 配置读写客户端（`getPluginConfig` 走 `GET`、`updatePluginConfig` 走 `PUT`，见 `:180-182`） |
| 新建（已落地） | 配置表单组件：`packages/web/src/components/SchemaForm.tsx` + 载荷解析 `packages/web/src/lib/configSchema.ts`（按 S-7…S-17 解析 refs 图渲染控件；**只渲染、不 hydrate**） |
| 修改（已落地） | `packages/web/src/pages/AdminPage.tsx` —— 有 schema 插件走 SchemaForm，无 schema 插件保留 JSON 原文编辑 |
| 修改（已落地） | `packages/core/package.json` / `packages/manager/package.json` / `packages/plugin-wiki/package.json` / `packages/plugin-echo/package.json` —— 均声明 `"schemastery": "3.18.0"`（此前工作区没有该依赖，见第 2.2 节 S-7…S-17 前提说明） |

**关键契约（端点）**

| 端点 | 成功 | 失败 |
| --- | --- | --- |
| `GET /api/plugins/:name/config` | `{ok, name, layer, activeLayer, config, schema}`：`layer` = **持久化层**，`activeLayer` = 激活层（未激活 `null`） | 404 插件不存在 |
| `PUT /api/plugins/:name/config` | 200 `{ok, config, hotUpdated, requiresRestart?}` | 400 `invalid_config`（附 schemastery 逐条错误）/ 400 `config_not_supported` / 409 `hot_update_failed`（返回**已回滚**的配置） |

**`layer` 字段语义已裁决（区分两个端点，勿读成两处同义）**

- **`GET /api/plugins/:name/config` 的 `layer` ＝ 持久化层**（本轮最终裁决，对齐 D-5）：它回答的是"**这份配置存在哪、重启后是否生效**"，取值为 `'base' | 'session'`——载体即 `config/plugins.base.json` / `config/plugins.session.json` 两个物理文件。**实现口径（已按源码校正，见本节末尾的"行号更正"）**：`configOf()` 的 `layer` 取自 `effectiveConfigLayerOf(name)`（`packages/manager/src/index.ts:477-480`，调用点在 `:370`）：`const inSession = this.session.enabled.find((e) => e.name === name); return inSession?.config !== undefined ? 'session' : 'base'`——即"**这份生效配置实际取自哪一层**"，会话条目存在但**没写 `config`** 时下沉到 `base`。落盘写入层则另由 `layerOf(name)`（`:465-467`，`session.enabled.some(...) ? 'session' : 'base'`）与 `persistConfig(name, config, layer)`（`:493-499`）决定。
- 同端点**新增 `activeLayer`** 表达激活层（该插件当前从哪一层被激活；**未激活为 `null`**）。**已落地并核对**：`Manager.configOf()` 的返回类型即 `{ name, layer: Layer, activeLayer: Layer | null, config, schema }`（`packages/manager/src/index.ts:346-352`，赋值 `activeLayer: managed?.layer ?? null` 在 `:364`）。注意与列表端点的类型差异：这里的 `layer` **非空**（从未持久化时落 `'base'`），而 `PluginSnapshot.layer` 可为 `null`。即 `GET /api/plugins/:name/config` 返回 `{ ok, name, layer, activeLayer, config, schema }`，两个维度分开表达，不再让一个字段兼两义。
- **`GET /api/plugins` 列表里的 `PluginSnapshot.layer` 语义不变，仍是激活层**（`layer: Layer | null`，见 `packages/manager/src/index.ts:124` / `:141` / `:192`，快照赋值在 `:249` / `:270` / `:325`）。**注意不要误把这条改动套到列表上**：UI 的徽标与操作分支正是读列表里的这个字段（`packages/web/src/pages/AdminPage.tsx:318` 按 `layer` 显示徽标、`:345` / `:350` 按 `layer === 'session' | 'base'` 渲染不同操作），改其语义会连带改前端。
- 曾把两个端点写成同一个"激活层"口径，属**歧义**，本版已按上面两条收敛：**配置端点看持久化层（+ `activeLayer`），列表端点看激活层。**

`updateConfig` 语义：

1. 插件**未激活** → 只落盘（写对应层级文件，D-5），返回 `requiresRestart: true`；
2. 插件**已激活** → 校验（`plugin.Config` / schemastery）→ 落盘 → `fork.update(newConfig)`；
3. 任一步失败 → 回滚进程内配置（必要时按 F-3 用旧配置再 `update()`）并返回 409，**落盘也需回滚或用临时文件提交**，避免"盘上是新的、进程是旧的"。

**`requiresRestart?` 字段状态（已落地，保留契约字段名）**：该字段**已实现**——`updateConfig` 的返回类型为 `{ config, hotUpdated, requiresRestart }`（`packages/manager/src/index.ts:386`），未发生热更新时返回 `{ config, hotUpdated: false, requiresRestart: true }`（`:417`），热更新成功时 `{ config, hotUpdated: true, requiresRestart: false }`（`:454`）。**文档须注明二者会同时出现**：响应里 `hotUpdated: false` **与** `requiresRestart: true` 是**同一情形的一对表达**（插件未激活 → 只落盘不热更新 → 需重启进程生效），前端据此提示"已保存，重启后生效"。不要把它读成两个独立开关或互斥状态。

**`400 config_not_supported` 的去向（配合 `docs/architecture.md` §5.7 的收敛）**：该错误码**不再由本路径产出**，仅保留在错误码映射表里（无 schema 插件改为接受原始 JSON：不校验、不裁剪），详见 `docs/architecture.md` §5.7。

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
| 新建（已落地） | entry 动态加载器 = `packages/web/src/lib/pluginUi.ts`：读 `/plugins-ui/registry.json` 入口表 → 只加载"表中有记录**且** `GET /api/plugins` 为 `active`"的插件 → `await import(/* @vite-ignore */ ...)` → 调用模块导出的 `register(host)`（或 default） |
| 修改（已落地） | `packages/web/src/main.tsx` —— 首个导入即 `import './lib/hostSdk'`（必须早于 shim 模块求值，见 `:1-3`），插件表就绪后调 `refreshPluginUi()` |
| 修改（已落地，**与初稿相反**） | `packages/web/index.html` —— **确实引入了 import map**（head 的第一个元素），但只映射 `react` 与 `react/jsx-runtime` 到 `/host-sdk/*.js`，**刻意不映射 `react-dom` / `react-dom/client`**（插件不得自带框架）。`packages/web/vite.config.ts` **未**追加 `'/plugins-ui'` proxy——不需要，见下方说明 |
| 修改（已落地） | `packages/web/src/App.tsx`（`app-header` 插槽注入点，见 `:58`）与 `packages/web/src/pages/AdminPage.tsx` |
| **未落地（也不需要）** | 初稿要求 `packages/server/src/index.ts` 新增 `/plugins-ui/<name>/client.js` 与 `client.css` 静态挂载点。**实现走了另一条更简单的路**：`/plugins-ui/**` 与 `/host-sdk/**` 都来自 `packages/web/public/`（Vite 的 `publicDir`）——dev 由 Vite 直接提供，`vite build` 时被原样复制进 `dist/`、再由后端静态托管；同源，故**既不需要 proxy，也不需要新挂载点** |
| 新建（已落地，**位置与初稿不同**） | 插件客户端 bundle 的构建配置在 **`packages/web/fixtures/vite.config.ts`**（`build.lib`：`entry` / `formats: ['es']` / `fileName: 'client'` / **显式 `cssFileName: 'client'`**），示例插件 UI 源码在 `packages/web/fixtures/src/`，产物落在 `packages/web/public/plugins-ui/`（初稿写 `plugins/<name>/client/vite.config.ts` 与 `plugins/<name>/dist/`） |

**入口表与产物生成**：`pnpm --filter @geewiki/web run build:fixtures` 连续构建两份 bundle（默认 fixture → `@geewiki/wiki`；`FIXTURE_OUT=@geewiki-plugin/hello` → `@geewiki-plugin/hello`），`packages/web/public/plugins-ui/registry.json` 的 `plugins` 表当前登记这两条。该目录**已被 `.gitignore` 排除**，且**不在 `pnpm build` 内**（`packages/web/package.json` 的 `build` 只是 `vite build`）——因此新克隆的仓库需先单独跑一次 `build:fixtures`，否则宿主只是"没有插件 UI 可加载"，不会报错。注意 `plugins/hello-geewiki/` 是**后端零依赖插件示例**（无 UI），与本批次的前端 fixture 是两回事。

**关键契约**：插槽名当前**只有 `app-header` / `app-footer`**（白名单；未在名单内的名字 `console.warn` 后忽略——初稿写的 `admin-page-slots` / `header-slots` **未提供**）；UI 入口 bundle 的 external 约定（D-4）与宿主实例来源（D-8）按"import map + 薄 shim"落地；`registerSlot(name, component)` 返回幂等的撤销函数；`pluginUiBase(name)` 先做路径段校验（段数 ≤2、拒绝 `.` / `..` 与非法字符）再把插件名映射为 `/plugins-ui/<name>/`；UI 资源 URL 统一为 `/plugins-ui/<name>/client.{js,css}`（dev 与 prod 完全一致，因为两侧都来自 `publicDir`）。

**验证方式**：单测（注册/撤销、ErrorBoundary 兜底）+ 浏览器端到端 + **单例证伪实验**（见 D-8 与下方风险）。**但"插件卸下后 UI 自动消失"这一条无法验收**——该行为没有接线（见下方风险 ①）。

**风险（已按实现更新）**：**React 单例共享仍是本批次最高风险点**（双实例 → `Invalid hook call`）。D-8 的证伪实验**已通过**（见第 3 节 S-18…S-22，实验代码在 `data/spike/slot-1/`），且**现已接入 `packages/web` 真实宿主**（`index.html` 的 import map + `packages/web/src/lib/hostSdk.ts` + `public/host-sdk/*.js` shim + `packages/web/src/lib/pluginUi.ts` 加载器 + `packages/web/fixtures/` 的两份示例 bundle）——初稿此处"尚未在真实宿主上接入"已过时。**仍然成立的风险**：

1. **未绑定 fork 生命周期**：加载/刷新入口是 `window.__GEEWIKI_PLUGIN_UI__.refresh()`（`packages/web/src/lib/pluginUi.ts:262-267`），插件停用/热更新**不会**自动刷新或撤销其 UI，需调用方手动触发；
2. **ESM 模块实例不回收**：卸载只做"注销插槽注册 + 移除插件 CSS"，已 import 的模块留在模块图中（`packages/web/src/lib/pluginUi.ts:193` 的注释已声明，与 L-6 同源）；
3. **插件 CSS 全局注入**：以 `<link data-plugin-ui=…>` 挂进文档，无样式隔离；
4. 插件 client bundle 仍应显式写 `cssFileName: 'client'`，理由是命名确定性而非"否则丢 CSS"（见 S-23）；
5. 文件头 TODO（`packages/web/src/lib/pluginUi.ts:27-30`）登记的三项剩余工作：入口表改为后端下发、按 fork 事件自动刷新、插件 UI 的版本与完整性校验。

> **为什么入口表是静态 JSON 而不是按约定路径探测**（源码头部 `:15-26` 记录的三条实测理由）：① dev 下直接 `import('/plugins-ui/...')` 会被 Vite 的 import-analysis 改写成 `import(__vite__injectQuery(url, 'import'))` 而返回 **500**；② dev 的 SPA fallback 对不存在的路径返回 **200 + text/html**，浏览器打出 `Failed to load module script ... MIME type of text/html`，该日志 JS 捕获不掉；③ prod 下不存在的路径直接 **404**，Chrome 会把任何 404 记为控制台 `log:error`。于是"先探测再 import"必然产生噪声或误判。

### 批次 E：PostgreSQL 适配（**已裁决延期**：以后做，不是不做）

**范围**：先出评估结论，再决定是否落地 `packages/db-pg/`。

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

## 5. 已知限制与待办

**L-1 排空语义是全站在途请求，不是 owner 级。**
`@geewiki/http` 的 `inflight()` / `drain()` 以整个路由服务为粒度：卸载任一插件时，等待的是**全站**尚未结算的请求（不含发起卸载的那次管理请求）。更精确的 **owner 级排空**（只等待被卸载插件自身路由注册的在途请求）列为后续工作。

**L-2 `enable` 失败回滚的作用域是调用帧局部（已确认缺陷，仍未修）。**
`enable()` 用 `activatedByThisCall` 记录"本次调用新激活的依赖"，失败时逆序回滚。该数组是**每递归帧局部**的（`packages/manager/src/index.ts:655` 的 `const activatedByThisCall: string[] = []` → `:660` 在递归 `await this.enable(dep)` **之后**才 push，而递归调用自带一个新数组）：依赖深度 ≥2 时，孙依赖由**子帧**的 `enable()` → `activateCore()` 成功激活并 `addToSession` **落盘**，子帧返回后它自己的数组即被丢弃 → 目标插件激活失败时，外层帧只能回滚自己记录的直接依赖，**孙依赖残留（仍处于激活态）且 session 清单已泄漏**。

**可达性要分两个条件说，不要合并成"暂不可达"，也不要写成"将来风险"**：

- **只看内置插件：不可达。** 内置注册表的最大依赖深度是 1（`@geewiki/wiki` requires `http-service` + `database-provider`，两者自身 requires 为空；`@geewiki/echo` requires `@geewiki/http`），构造不出 depth ≥2 的链。
- **引入外部插件：可达。** 批次 B 已落地，`packages/server/src/index.ts` 的 `buildRegistry()` 把外部插件**并入同一注册表**（`return { registry: [...builtin, ...discovered.plugins], issues: discovered.issues }`，见 §5.8 与 `packages/manager/src/discovery.ts`），外部插件的 `requires` 可以指向另一个外部插件，因此 A→B→C 这样的 depth ≥2 链**现在就能构造**。

即准确表述为"**缺陷已确认存在、修法已定稿、代码未落地；是否触发取决于注册表里有没有 depth ≥2 的依赖链**"。

**修法已定稿（代码未落地）**：公开 `enable` 作唯一回滚点 + private `enableInner(name, config, activated)` 跨帧共享同一个 `activated` 数组 + 激活成功后自登记 `activated.push(name)`（push 序即激活序，逆序回滚即合法卸载序）——见第 4 节批次 B 的 **G-2**。

**L-3 后端直接运行 TS。**
各包 `exports` 指向 `src/index.ts`，运行期依赖 devDependency `tsx`；这与生产镜像裁剪 devDependencies 存在张力。镜像侧的当前处理方式见 [deployment.md](./deployment.md)。

**L-4 未实现项。**
插件市场 / 签名校验、插件前端类型检查、跨插件 `configSchema` 引用（schema 复用）均未实现。

**L-5 `./plugins` 目前仅为挂载点。**
容器编排中 `./plugins` → `/app/plugins`（宿主路径可用 `GEEWIKI_HOST_PLUGINS_DIR` 覆盖）已就位，但**发现逻辑属批次 B**；**目录不存在**时不影响启动（`packages/manager/src/discovery.ts:132` 的 `existsSync(root)` 前置判断会直接返回空列表），但**目录存在却不可读**时会阻断启动——该例外见 L-10 的 **G2**。

**L-6 ESM 重载的模块实例不会被回收。**
`?v=<mtime>` 每次都产生新模块实例（§2.3 L-2 实证），反复热重载会累积旧实例。当前不做回收；若未来出现高频重载场景需评估。

**L-7 React Flow 授权提示会打进 console。**
`packages/web/src/pages/GraphPage.tsx:145` 的 `proOptions={{ hideAttribution: true }}` 会让 React Flow 在 console 打印授权提示。这是**上游许可证提示，不是缺陷**；是否保留需按许可证条款决定（改回显示署名即可消除）。基线验收时已确认：除该提示外 console 无错误。**该条与本节其余 L-n 的语义不同**：L-1…L-6 是功能/架构限制，本 L-n 是法律与观感层面的取舍。

**L-8 Wiki 详情页「← 返回列表」依赖浏览器历史栈。**
`packages/web/src/pages/WikiPage.tsx:174` 的「← 返回列表」用 `window.history.back()`（同文件 `:162` 的「← 返回」同样如此）。当历史栈里先有编辑页时，点击会**先退回编辑页**而非列表页。建议改为显式导航 `onNavigate('')`（该组件已持有 `onNavigate`，见 `:28`）。

**L-9 PostgreSQL 适配明确延期（裁决："以后做"，不是不做）。**
①**延期依据**：当前处于"插件平台能力补齐期"，数据库是既有能力、**不在关键路径上**——补齐插件平台（批次 B/C/D）才能让外部插件与数据库插件真正可插拔，此时做 PG 适配属于为尚未成形的使用场景提前付出成本。
②**两条已实测的"免费"保障**（延期不损失未来收益）：
  - `packages/db-sqlite/src/index.ts:171-175` 的 manifest 已声明 `provides: 'database-provider'` 且 `conflictGroup: 'database-provider'`；未来 `db-postgres` 声明**同一个组名**即可自动获得"同组全局互斥"保护，无需新增机制。
  - 环境变量统一 `GEEWIKI_` 前缀（`GEEWIKI_DATA_DIR` / `GEEWIKI_CONFIG_DIR` / `GEEWIKI_PLUGINS_DIR` / `GEEWIKI_WEB_DIST` 等），PG 实现沿用同一前缀即可，不存在命名体系分裂。
③**同步接口 `DatabaseAdapter` 的实际消费点已逐处核对，全仓仅 3 处**（这是"改动面可控"的量化依据）：
  - `packages/manager/src/index.ts:667-671` 的 `activateCore` 迁移调用（`db.migrate(entry.migrationsDir)`）；
  - `packages/server/src/index.ts:427` 健康检查的 `db.listTables()` / `db.appliedMigrations()`；
  - `packages/plugin-wiki/src/index.ts` 的业务调用（`ctx.get('db')` 取服务，`db.query` / `db.run` / `db.transaction` 合计 **8 处调用点**：5 处 `db.run(` + 2 处 `db.transaction(` + 1 处 `ctx.get('db')`；注意 `db.query(` 在该文件中为 0 处，与"13 处"的上游口径不符，**以本仓库实数为准**）。
④**接口决策**：新增 **`DatabaseAdapterAsync` + `isAsyncAdapter()` 双轨**（约 25–30 行），**不**把现有同步接口整体异步化。理由：整体异步化会毁掉 better-sqlite3 的同步优势（现有代码全部按同步写），并迫使现有测试（当前全仓 35 个单测，其中大量按同步语义断言）连带改写。
⑤**唯一防返工项**：把 `GeeWikiMeta.migrations` 从 `string` 扩为 `string | { default?: string; postgres?: string }`（`packages/core/src/index.ts:56` 当前为 `migrations?: string`，改造约 8 行、向后兼容）。**本次决定暂不改代码**，仅登记为**"批次 E 落地前置条件"**——理由：PG 已延期，且当前不存在任何 PG 插件，暂不存在需要双方言迁移路径的实例；提前改类型只会引入无消费方的字段。
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

**L-14 发现期 issue 的可观测性：接口侧已闭合，前端提示位待补（缺口收窄）。**
外部插件目录扫描会把失败/跳过记为 issue（`DiscoveryResult.issues`，见批次 B 的修正签名），日志里能看到（例：`[manager:discovery] 跳过插件目录 …（invalid_manifest）: … EACCES: permission denied`）。**本条曾被记为真实可观测性缺口**：在修复批之前，`GET /api/plugins` 只返回已注册条目（4 条内置），既不返回 issues、也不返回"有 N 个被跳过"的计数 → **API 与 UI 上完全看不出"有插件被跳过"**，即 L-11 / L-10-G2 修好之后残留的那半个问题：**不再崩溃，但也不可见**。**该半截已在修复批中闭合**（下条字段形状已按源码核对），本文保留此条作为"接口可见性"的契约锚点与前端待办的登记处。

- **裁决与现状**：曾记为**已知限制**并列入修复批——`GET /api/plugins` 带上机器可读的 `issues`。**现状：已落地并已核对源码**（见下条字段形状）。
- **字段形状（已回填，以源码为准）**：`GET /api/plugins` → `ok(h, { plugins: manager.snapshot(), issues: manager.discoveryIssues() })`（`packages/server/src/index.ts:1008`）；`issues` 元素类型为 `DiscoveryIssue`，即 `{ code, dir, message }` 三字段（`packages/manager/src/discovery.ts:28-41`）：`dir` 是**出问题的插件目录绝对路径**，`message` 是人类可读说明，`code` 为八值枚举 —— `'missing_manifest' | 'invalid_manifest' | 'entry_not_found' | 'invalid_plugin_path' | 'invalid_plugin_dir' | 'duplicate_plugin' | 'invalid_module' | 'load_failed'`。**没有 name 字段**（失败目录未必解析得出插件名）。管理器的 `discoveryIssues(): DiscoveryIssue[]` 在 `packages/manager/src/index.ts:310-311`，数据源是 `config.discoveryIssues`（`:250`，默认 `[]`）。该字段同时是"插件根目录不可读"的出口：`scanPluginDirs` 的 `readdirSync` 失败记 `code: 'invalid_plugin_dir'`、`message: 插件根目录不可读，已跳过全部外部插件: …`（`packages/manager/src/discovery.ts:180-190`）——与 L-10 的 G2 收敛为同一条路径。
- **兼容性提示**：`GET /api/plugins` 的响应体新增字段属**向后兼容**（前端当前不读该字段），但**前端"插件管理"页应增加"有插件被跳过"的提示位**，否则缺口只是从后端挪到前端。

## 6. 当前质量基线

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

**测试口径（本轮回填，已实跑）**：上述 UI 基线是**提交 `ed826b5` 的代码状态**；插件平台批次 A–D 落地后测试集合已扩张，且**当前全绿**——以 `pnpm --filter @geewiki/manager run test` 与 `pnpm --filter @geewiki/server run test` 实跑为准（两包的 `test` 脚本都是 `node --import tsx --test test/*.test.ts`）：

| 包 | 用例数 | 通过 | 失败 |
| --- | --- | --- | --- |
| `packages/manager` | **58**（5 个测试文件：`deps` 8 + `manager` 13 + `config` 21 + `discovery` 13 + `repo-paths` 3） | 58 | 0 |
| `packages/server` | **14**（`registry` 3 + `router` 11） | 14 | 0 |
| **合计** | **72** | **72** | **0** |

逐文件口径：

- `packages/manager/test/`：`deps.test.ts` 8 例、`manager.test.ts` 13 例、`config.test.ts` 21 例、`discovery.test.ts` 13 例、`repo-paths.test.ts` 3 例 —— 合计 **58**。
- `packages/server/test/`：`registry.test.ts` 3 例（`buildRegistry` 内置 4 + 外部合并 / `pluginsRoot` 为 `null` / 目录不可用）、`router.test.ts` 11 例（drain 空闲、在途、超时、多等待者、回归自计数；inflight 结算；404 与静态交接不计在途；REST 卸载两类；wiki 413 计入 stats；`ServerOptions.port` / `host`）—— 合计 **14**。

**已过时口径（保留以便追溯，勿再引用）**：本版之前此处记录的是"manager **39** 例 / **37** 过 / **2** 失败、server **11/11**"。那两个失败用例是**尚未随新契约更新的旧断言**，不是新代码缺陷，现均已改写：

- `packages/manager/test/config.test.ts`『updateConfig：未声明 schema → config_not_supported』——旧契约要求无 schema 插件改配置返回 400 `config_not_supported`；新裁决反转为"接受并保存原始 JSON"（见批次 C 与 `docs/architecture.md` §5.7）。**已改写**为新契约用例『updateConfig：未声明 schema → 按 JSON 原文透传（不校验、不裁剪），已激活同样热更新』（`packages/manager/test/config.test.ts:220`）。
- `packages/manager/test/config.test.ts`『REST：GET/PUT /api/plugins/:name/config 的状态码与响应形状』——旧断言 `assert.equal(got.body['layer'], null, '未激活 → 无层')`（`:305`）与最终裁决冲突：`layer` 现为**持久化层**（从未持久化时落 `'base'`，类型 `Layer` 非空），"未激活"改由 `activeLayer: null` 表达。**已改写**：文件头注释第 8 条明确"`layer`（持久化层）与 `activeLayer`（激活层）两个维度"，并新增用例『`configOf`：layer = 持久化层、`activeLayer` = 激活层（基础层激活 / 会话层激活 / 未激活三态）』（`:445`）。
- 另外新增了会话层叠加用例（『boot 叠加：基础层 + 会话层并存时，会话层配置作为覆盖层生效』）与外部插件发现用例（`discovery.test.ts` 13 例，含『`parsePluginManifest`：`package.json` 的 `geewiki` 键优先』`discovery.test.ts:54`、『`resolvePluginEntry`：显式 entry 优先，其后 `index.ts` → `index.js` → `src/index.ts`』）。

因此 `README.md` / `docs/roadmap.md` 中出现的 35/35 是**历史时点口径**，当前口径为 **72/72**（两处均已同步更新）。

**遗留项**：见第 5 节 **L-7**（React Flow 授权提示）与 **L-8**（详情页「← 返回列表」走 `history.back()`）。

**基线口径说明**：本节的 3 ms 是"客户端观测到的停用请求耗时"，不是服务端 P99；`data/geewiki.db` 为本地验收库，验收后页面已清空但库文件本身不参与版本控制。

## 7. 验证纪律

每一批交付必须同时满足：

1. `pnpm typecheck` **0 错**；
2. `pnpm test` **全绿**，且包含该批新增用例。**当前（本轮实跑）全绿：72/72** —— `packages/manager` **58**（`deps` 8 + `manager` 13 + `config` 21 + `discovery` 13 + `repo-paths` 3）+ `packages/server` **14**（`registry` 3 + `router` 11），逐文件口径见第 6 节。**历史时点**：基线提交 `ed826b5` 为 **35/35**（manager 24 + server 11）；其后修复批一度出现 manager **39 例 / 37 过 / 2 失败**（两条旧断言尚未随新契约更新：`layer` 语义反转、无 schema 插件改为接受原始 JSON），**现已全部改写完成**；
3. **隔离端口**的端到端冒烟（不得占用开发用的 3000 / 5173）；
4. 涉及 UI 的批次必须有**浏览器端到端验收**（真实渲染，而非接口断言）；
5. **每批先经独立 Reviewer 审查，再提交**；
6. 本文档中未经验证的假设必须在落地时补上验证结果，或改标注。**当前待验证项已收敛为**：①第 4 节批次 C 的 `configSchema` 契约迁移（方案甲/乙）**已按方案甲落地并核对源码**（`packages/core/src/index.ts:30` / `:72`、`packages/plugin-wiki/src/index.ts:27-33`、`packages/plugin-echo/src/index.ts:22-26`；`packages/core` / `packages/manager` / `packages/plugin-wiki` / `packages/plugin-echo` 四者均声明 `"schemastery": "3.18.0"`）；`layer`（持久化层）/ `activeLayer`、`requiresRestart`、发现期 `issues` 已**落地并核对源码**，原子写已内联在 `writeList()`（见 D-2）；批次 D 的**宿主侧** Slot 亦**已落地**（`packages/web/index.html` 的 import map + `packages/web/src/lib/hostSdk.ts` + `packages/web/public/host-sdk/` 薄 shim + `packages/web/src/lib/pluginUi.ts` 加载器 + `packages/web/fixtures/`），**但后端 `ctx.slot()` 注册链路、Suspense / use Hook 懒加载、fork 生命周期绑定均未落地**（见 `docs/architecture.md` §6）；②批次 B 的 **G-1 / G-2** 与批次 C 端点表中的**未落地部分**为设计定稿；③第 5 节 **L-10** 表格中 G1 / G2 / G3 均**已修且含镜像重建实跑**、G4 为决策已落地；**L-14 的 `issues` 形状已按源码回填，剩余待办只剩前端提示位**；④批次 E 整体延期（见 L-9），其 `GeeWikiMeta.migrations` 双路径改造登记为落地前置条件；⑤**`meta.role: 'password'` 脱敏输入框尚未实现**（`hidden` 语义已支持），见第 9 节。**已不再列为待验证**：清单双来源优先级（已裁决且有测试钉住，见批次 B）、Kysely 选型（已裁决"不建议引入"，见 L-9⑥）、`bitset` 控件（已裁决"暂保留降级"，见 L-13）、D-2 原子写（已内联在 `writeList()`，`packages/manager/src/index.ts:178-184`）；
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
| `conflictGroup` 替换交互 | 能力 ④ 列出待补 | 确认未实现：仅 `activateCore` / `enable` 的互斥拦截（抛 409 `conflict_group`），无替换交互 | 保持"待补" |
| 前端 Slot 单例共享 | 初版 D-4 写"宿主用 import map 暴露 react 单例" | **勘察证伪**：`react@19.2.8` 无任何 ESM 产物（`exports` 只有 `react-server`/`default`）、宿主产物已内联 react（`packages/web/dist/assets/index-DyngNpzw.js`）、dev 的 `?v=<hash>` 会造成实例分裂 | **改写**：D-4 保留其余结论并指向新增 **D-8**（宿主 `window.__GEEWIKI_HOST__` SDK + 薄 shim） |
| `configSchema` 承载方式 | 批次 C 直接按 schemastery 载荷渲染 | 初版核对时仓库现状是 **JSON Schema 风格字面量**：`packages/core/src/index.ts:49` 为 `Record<string, unknown>`，`packages/plugin-wiki/src/index.ts:37` / `packages/plugin-echo/src/index.ts:30` 用 `title` 键（schemastery 无此键） | 当时判定为**契约迁移开放项**（推荐方案甲）；**现已按方案甲落地**——`packages/core/src/index.ts:30`（`ConfigSchema = ReturnType<typeof Schema.any<any>>`）与 `:72`，`packages/plugin-wiki/src/index.ts:27-33`、`packages/plugin-echo/src/index.ts:22-26` 全部改为 `Schema.object({...})` |
| schemastery 载荷规格 | "`refs` 是数组 / 节点带 `uid` / 有 `Schema.fromJSON`" | 实测均为**否**：`refs` 是对象、节点无 `uid` 字段、反序列化只有构造函数入口（`src/index.ts:178-208`）；且反序列化会 `new Function` 执行 `callback`（`:197-202`） | 写入 **S-7 / S-8**，并把"前端不得 hydrate"列为安全红线 |
| uid 作为缓存键 | "同一 schema 重复序列化 uid 会变" | 需区分两种情形：**同一实例**重复 stringify 字节相同（`probe5.out` §B `uid=14/14 equal=true`）；**重新构造**同一 schema 才变（§A `uid1=4 uid2=9`） | 写入 **S-14**，表述按两种情况区分，跨请求用内容 hash / 插件版本号 |
| UI 资源 URL 前缀 | 初版批次 D 写 `/plugins/<name>/...` | 现有静态托管的 root 锁死 `webDist`（`packages/server/src/index.ts:350-397` 与 `:540-548`），需独立挂载点 | 统一为 **`/plugins-ui/<name>/client.{js,css}`**，dev 由 `packages/web/vite.config.ts` proxy 转发 3000 |
| 测试计数（一次实跑，**历史**） | 各文档写"单测 23/23" | 实跑 `pnpm -r --if-present run test`：**manager 24 + server 11 = 35/35**（`deps 8 + manager 13 + repo-paths 3`；`packages/server/test/router.test.ts` 11） | 当时已同步修正 `README.md`、`docs/roadmap.md`、本文第 7 节。**该 35/35 现降级为历史基线口径**，当前口径见下方"测试计数（三次实跑）"行 |
| 测试计数（二次实跑，**已过时**） | 上一行记录的 35/35（manager 24 + server 11） | 那一轮实跑曾变为 `packages/manager` **39 例 / 37 过 / 2 失败**（39 = deps 8 + manager 13 + repo-paths 3 + `config.test.ts` 8 + `discovery.test.ts` 7）、`packages/server` **11/11**；失败两条均为尚未随新契约更新的旧断言 | 该口径**已作废**：两条旧断言已改写（见第 6 节），当前为下一行的 72/72 |
| 测试计数（**三次实跑，当前口径**） | 上一行的"39 / 37 / 2" | **全绿 72/72**：`packages/manager` **58**（**5 个测试文件**：`deps` 8 + `manager` 13 + `config` 21 + `discovery` 13 + `repo-paths` 3）+ `packages/server` **14**（`registry` 3 + `router` 11）。**命令注意**：`pnpm -r` 在任一包失败即中止、不会跑到后面的包，故两包数字分别用 `pnpm --filter @geewiki/manager run test` 与 `pnpm --filter @geewiki/server run test` 取 | 写入第 6 节实跑表与第 7 节 item 2，并同步更新 `README.md`（`pnpm test` 行 + 当前实现状态）与 `docs/roadmap.md`（Phase 2 尾注 + Phase 3/4 状态）。**顺带纠正两处旧数**：① manager 是 **5 个测试文件**而非 4 个；② 旧口径给出的"deps 8 + manager 13 + repo-paths 3 + config 8 + discovery 7"里 config/discovery 两文件当时尚未增补完，现为 **config 21 + discovery 13** |
| `meta.role: 'password'` | 上一行/`docs/architecture.md` 曾按"已实现"记录 | **实为未实现**：`packages/web/src/lib/configSchema.ts:124` 除 `textarea` 外的 `role` 一律落 `kind: 'text'` 并附 `role=…` 注记，**无密码输入框**；`hidden` 则**确已支持**（`:102` → `kind: 'static'`，`packages/web/src/components/SchemaForm.tsx:235`） | 已把 `docs/architecture.md` §5.7 改为"`hidden` 已支持 + `role:'password'` 已知未落地"，**避免文档再次超前于代码** |
| UI 基线验收 | "4 路由可达、停用 3ms、console 无错误" | 对照 `data/spike/e2e/` 的 CDP 脚本与 DOM 快照确认：`/`、`#/wiki`、`#/plugins`、`#/graph` 四路由与 `#/graph` 的 **4 节点 + 3 边**（`react-flow__edge-path` 计数 3）均可复核 | 写入第 6 节"当前质量基线"；3 ms 标注为客户端观测口径 |
| React Flow 授权提示 | 未提及 | `packages/web/src/pages/GraphPage.tsx:145` 的 `proOptions={{ hideAttribution: true }}` 会触发上游许可证提示 | 写入 **L-7**（非缺陷，按许可证决定处理） |
| Wiki「返回列表」 | 未提及 | `packages/web/src/pages/WikiPage.tsx:174` 用 `window.history.back()`，历史栈已有编辑页时会先退回编辑页 | 写入 **L-8**（建议改显式 `onNavigate('')`） |
| schemastery 源码行号 | "`toJSON` 在 `src/index.ts:235-246`" | 逐个核对一致（`:235` 起、`:246` 结束）；`refs` 分支 `:183`、`new Function` 在 `:200`、`required` 判定 `:413-422`（抛错在 `:414`）、`merge(result, data)` 在 `:700`、默认值注入 `:791-797`、类型注册 `:803-839` | 已在 S-7…S-17 中按核对后的行号写入 |
| 变体 A（薄 shim）可运行性 | D-8 写作时的"待验证计划"（要求先跑半小时证伪实验） | **实验已跑通**：dev 与 prod 两种宿主下均渲染成功、`hooksWork:true`、点击三次计数 `0 → 3`；失败路径由阴性对照变体 C 证明可被检出 | 新增 **S-18 / S-22**，并把 D-8 的风险条目从"待证伪"改为"已通过 + 剩余未验证项" |
| import map 的可运行性 | "import map 方案不可行"（初版只给产物形态论据） | 变体 B 在当前仓内**跑得通**（结果与 A 完全一致，宿主 `<head>` 的 import map 生效）。不可行的论据仍是产物形态与 dev `?v=` 实例分裂，而非"加载失败" | 新增 **S-19**，明确 B 的失败论据不是运行期报错 |
| 阴性对照（双实例）可检出性 | 未提及 | 插件自带 react 时 `import()` 成功但渲染抛 `TypeError: Cannot read properties of null (reading 'useState')`（栈 `plugins-ui/c/client.js:395`），被 ErrorBoundary 接住、宿主不白屏 | 新增 **S-20**；同时暴露原始快照里该变体被 404 掩盖（**S-21**） |
| `cssFileName` 的作用 | "Vite 6 单入口时 CSS 默认文件名不稳定" | 实测未设该字段**不会丢 CSS**，而是以就近 `package.json` 的 `name` 命名（`geewiki-slot-spike.css`）；真实风险是命名不可预测 | **修正**：仍要求显式 `cssFileName: 'client'`，但理由改为"命名确定性"，见 **S-23** |
| 清单双来源优先级 | 本篇旧版写"同时存在时以独立清单为准——**未验证**" | **与实现相反**：`packages/manager/src/discovery.ts:77-102` 的 `parsePluginManifest` 是 fallback 链，`package.json#geewiki` 优先且命中即整体返回（独立清单完全不参与），仅在前者缺失时兜底；已有测试钉住（`packages/manager/test/discovery.test.ts:54`） | **裁决 = 改文档不改代码**，批次 B「发现规则」按实现重写 |
| `layer` 字段来源 | 端点契约只列了 `layer`，未定义语义 | 实现为**激活层**：`layer: Layer \| null`（`packages/manager/src/index.ts:124` / `:141` / `:192`，快照赋值 `:249` / `:270` / `:325`），未激活为 `null`；持久化层（写入目标层）另由 `layerOf()`（`:465-467`）与 `persistConfig()`（`:493-499`）决定，载体是 `config/plugins.base.json` / `config/plugins.session.json`。**行号更正**：本节旧稿把这两者写成 `:410-412` 与 `:422-427`，且把配置端点的 `layer` 记成 `layerOf()` 的值——实际配置端点走的是 `effectiveConfigLayerOf()`（`:477-480`，调用点 `:370`），两者只在"会话条目没写 `config`"这一种情况上不同 | **裁决**：写明"激活层"并把持久化层登记为"另一维度、当前不对外暴露"，需要时新增独立字段（见批次 C 端点节） |
| `internal/update` 中间件 | D-2 原文要求"落盘挂在该中间件上" | 实现未注册该中间件，直接 `await fiber.update(config)`；spike 实测该路径等价可用（apply 抛错 → `update()` 抛错且 `fork.config` 已改为新值，管理器据此显式回滚） | **裁决**：D-2 放宽为"不要求中间件形态，行为等价即可"，由批次 C 的 C-5 类双向回滚断言兜底。**派生项已闭合**：D-2 的"`.tmp` + `rename` 原子写"**已落地**——内联在 `packages/manager/src/index.ts:178-184` 的 `writeList()`，并有断言钉住（`packages/manager/test/config.test.ts:162`『原子写不应留下 .tmp』），详见本表"原子写落点"行 |
| `bitset` 控件 | S-13 要求"多选 + 按位或 number" | 未实现，当前配置表单对该类型降级为 JSON 文本编辑；该类型在两个内置插件的 `configSchema` 中均未使用 | **裁决**：暂保留降级，记入 **L-13**（无消费方，未来实现时载荷信息已齐备） |
| `DatabaseAdapter` 消费点数量 | 上游口径"wiki 插件 13 处 `query/run/transaction`" | 实测与口径不符：`packages/plugin-wiki/src/index.ts` 中 `db.query(` **0 处**、`db.run(` **5 处**、`db.transaction(` **2 处**，加 `ctx.get('db')` 1 处，合计 **8 处调用点**；另两处消费点为 `packages/manager/src/index.ts:667-671` 与 `packages/server/src/index.ts:427`，**全仓合计 3 处消费方** | 按仓库实数写入 **L-9③**（并标注与上游口径的差异），不按 13 处推算改造量 |
| PostgreSQL 延期与双轨接口 | 批次 E 为"评估优先" | 已核对：`packages/db-sqlite/src/index.ts:171-175` 确实声明 `provides: 'database-provider'` + `conflictGroup: 'database-provider'`；`packages/core/src/index.ts:56` 的 `migrations?: string` 确为单值 `string` | **裁决**：批次 E 明确延期（L-9），`DatabaseAdapterAsync` + `isAsyncAdapter()` 双轨，`migrations` 扩为 `string \| { default?, postgres? }` **登记为落地前置条件、本次不改代码** |
| 容器化缺口 G1–G4 | "G1 未在镜像/compose 固化（正在修）；G3 镜像内 `/app/config` 为空（正在修）；G2 待修；G4 决策不打进镜像" | **Docker 批次实跑口径（取代文本核对）**：G1 / G3 / G2 **均已修**——G1：镜像内固化 `GEEWIKI_PLUGINS_DIR=/app/plugins`，`-w /tmp` 仍发现 1 个外部插件，反证相对值 `plugins` 时发现根变 `/tmp/plugins`、0 个且不报错；G3：`COPY --from=builder /src/config /app/config`，镜像从零重建 `EXIT=0`、镜像内 `plugins.base.json` 存在（126 B）、不挂 config 卷不再是死壳；G2：列目录失败已降级为打印 `[manager:discovery] 跳过插件目录 …（invalid_manifest）: … EACCES: permission denied` 并跳过；G4 决策已写入 compose 挂载注释 | 写入 **L-10**（逐条状态表，G1/G3 标"已修（含镜像重建实跑）"）+ **L-11** / **L-12**；**表现口径修正**：G3 旧措辞"活着但不服务的死壳 / HEALTHCHECK 永久失败"改为**静默重启循环**（空 config → `REST API 未挂载` → `exit=0` → `restart: unless-stopped` 反复拉起） |
| 内置插件数量口径 | "4 条内置插件清单"（清单与注册表未区分） | 核对 `config/plugins.base.json`（126 B，`enabled` 仅 3 条：`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki`）与 `packages/server/src/index.ts` 的 `defaultRegistry()`（4 个内置条目，`@geewiki/echo` 已注册未启用） | **三口径分开写**：清单启用 **3 条** / 已注册 **4 条**（故 `GET /api/plugins` 显示 4 条内置）/ 挂载外部示例后列表 **5 条** |
| 外部插件源码改动的生效方式 | 契约写"改文件后重载生效（`?v=mtime` 路径）" | **该路径未实现**：同 URL 二次 `import()` 命中模块缓存（§2.3 L-2 实证），L-6 已声明不做模块实例回收 | **按实现改文档**：改源码后**需重启进程**；`?v=mtime` 标注为"未实现、不在本轮范围"（批次 B 验证方式） |
| `loadExternalPlugins` 签名 | `(pluginsDir: string, extraPaths: string[]): Promise<RegisteredPlugin[]>` | 实现为 `loadExternalPlugins(options: DiscoveryOptions): Promise<DiscoveryResult>`（`packages/manager/src/discovery.ts:153`），返回 `{plugins, issues}`，**无 `extraPaths`** | **按实现改文档**（返回 issues 是更好的设计：裸数组会丢"谁被跳过、为什么"，且 issues 是 L-14 可观测性的载体） |
| 发现/加载代码落点 | 契约写"新建 `packages/loader/` 包" | 实现全在 `packages/manager/src/discovery.ts`（228 行），**无新包** | **按实现改文档**：少一个包 = 少一条构建 / 依赖 / tsx 加载链 |
| 配置端点 `layer` 语义 | 两个端点被写成同一个"激活层"口径（歧义） | 最终裁决：`GET /api/plugins/:name/config` 的 `layer` = **持久化层**（对齐 D-5；**实现是 `effectiveConfigLayerOf()`，`packages/manager/src/index.ts:477-480`，调用点 `:370`**——本节旧稿误记为 `:410-412` 的 `layerOf()`），同端点**新增 `activeLayer`**（未激活 `null`）；`GET /api/plugins` 列表的 `PluginSnapshot.layer` **仍是激活层** | **裁决并分端点写明**（批次 C 端点节 + 契约歧义裁决汇总），避免被读成两处同义 |
| `requiresRestart?` 字段 | 契约字段，实现未产出 | **已实现**：`updateConfig` 返回 `{ config, hotUpdated, requiresRestart }`（`packages/manager/src/index.ts:386`），未热更新时 `{config, hotUpdated:false, requiresRestart:true}`（`:417`）、热更新成功 `{..., hotUpdated:true, requiresRestart:false}`（`:454`） | **保留契约字段名，不改文档**；补注"`hotUpdated:false` 与 `requiresRestart:true` 同时出现（同一情形的一对表达）" |
| 无 schema 插件的配置处理 | `docs/architecture.md` §5.7 承诺"退回 JSON 原文编辑框，不做结构化校验"，而初版实现一概 400 `config_not_supported`、前端提交不读 textarea | **已按承诺落地**：`Manager.updateConfig` 对无 schema 插件只要求顶层是 JSON 对象（否则 `throw new ManagerError('invalid_config', …未声明 configSchema，配置必须是 JSON 对象)`），**原样透传、不校验不裁剪**；前端保留 JSON 原文编辑框并提交解析后的内容 | 已把 `PUT` 失败码表中 400 `config_not_supported` 一行改为"**不再由该路径产出**（仅保留错误码映射）"，并注明"无 schema 插件不做校验与裁剪属已知取舍"；对应用例『updateConfig：未声明 schema → 按 JSON 原文透传（不校验、不裁剪），已激活同样热更新』（`packages/manager/test/config.test.ts:220`）与『updateConfig：未声明 schema 时配置形状必须是 JSON 对象（数组/标量 → `invalid_config` 且不改盘）』（`:252`） |
| `role:'password'` 脱敏 / `hidden` 字段 | 记为"未实现" | **部分已落地**：`hidden` **已支持**——`packages/web/src/lib/configSchema.ts:102` 对 `meta['hidden'] === true` 返回 `kind: 'static'`、note `隐藏字段（沿用默认值）`（`packages/web/src/components/SchemaForm.tsx:235` 渲染 static 分支），即**仅保留默认值、不渲染输入控件**；**`role:'password'` 尚未落地**——`:124` 把非 textarea 的 role 一律映射为 `kind: 'text'` 并附 `role=…` 注记，**没有密码输入框** | **`hidden` 改写为"已支持"并注明语义**；**`role:'password'` 记为未实现**（不按"已支持"写，避免文档再次超前于代码） |
| 路径守卫判定方式 | D-3 写"`resolve()` 后仍在插件目录内"（词法，不解析 symlink；`plugins/` 自身为 symlink 会误拒全量） | **已落地并核对**：两侧都先 `realpathSync` —— `realpathOrNull()`（`packages/manager/src/discovery.ts:115-118`）配合真实路径版"在目录内"判定（`:125-130`，任一侧 realpath 失败即判越界，宁保守勿放行）；symlink 子目录 `statSync` 是目录则纳入、解析失败或非目录则记 `code: 'invalid_plugin_dir'`（`:204-213`，`符号链接目标不是目录，已跳过` / `符号链接无法解析: …`） | **D-3 守卫描述已更新为"真实路径判定"**（第 3 节 D-3 + 批次 B 发现规则） |
| 发现期 `issues` 的可观测性 | 无此条目 | **缺口已闭合**：`GET /api/plugins` 现在返回 `{ plugins, issues }`（`packages/server/src/index.ts:1008`），`issues` 元素为 `DiscoveryIssue = { code, dir, message }`（`packages/manager/src/discovery.ts:28-41`，`code` 八值枚举，**无 name**）；根目录不可读也走同一条 issue 出口（`packages/manager/src/discovery.ts:180-190`，`插件根目录不可读，已跳过全部外部插件: …`） | 写入第 5 节 **L-14**（形状原样回填，不再标"待回填"） |
| 原子写落点 | D-2 要求"`.tmp` + `rename`"，并计划新建 `packages/manager/src/config-store.ts` | **已内联在既有 `writeList()`**（`packages/manager/src/index.ts:178-184`：`writeFileSync(tmp)` → `renameSync(tmp, file)`），断言见 `packages/manager/test/config.test.ts:162`（`'原子写不应留下 .tmp'`） | **撤回"未落地"标注**：原子写**保留为必须项 = 已满足**，**不新建** `config-store.ts`；并**警告不要补注册落盘中间件**（会双写） |
| 前端 Slot 的宿主接入 | 批次 D 风险段写"证伪实验已通过，但**尚未在 `packages/web` 真实宿主上接入**" | **已接入真实宿主**：`packages/web/index.html` 的 import map + `packages/web/src/lib/hostSdk.ts`（`HOST_SDK_VERSION = '0.1.0'`）+ `packages/web/public/host-sdk/{react.js,jsx-runtime.js}` 薄 shim + `packages/web/src/lib/pluginUi.ts` 加载器 + `packages/web/fixtures/` 两份示例 bundle；真实宿主下与 `@xyflow/react` 共存未见 `Invalid hook call`。**文件名更正**：初稿写 `packages/web/src/lib/host-sdk.ts`，实际是 **`hostSdk.ts`**（`public/host-sdk/` 是 shim 目录，两者不要混） | 批次 D 风险段已按此重写。**仍成立的边界**：未绑定 fork 生命周期（手动 `window.__GEEWIKI_PLUGIN_UI__.refresh()`）、ESM 模块不回收、CSS 全局注入、插件 UI 版本/完整性校验缺失（源码 TODO `packages/web/src/lib/pluginUi.ts:27-30`） |
| 是否引入 import map | 批次 D 涉及文件表写 "**不引入 import map**" | **实际引入了**：`packages/web/index.html` 的 head 首个元素即 `<script type="importmap">`，把 `react` → `/host-sdk/react.js`、`react/jsx-runtime` → `/host-sdk/jsx-runtime.js`；**刻意不映射 `react-dom` / `react-dom/client`**（插件不得自带框架）。这与 S-19 的结论一致——import map 本身跑得通，被否的是"宿主产物形态 + dev `?v=` 实例分裂"意义上的方案 | 批次 D 涉及文件表已按实现改写 |
| `/plugins-ui` 的托管方式 | 批次 D 涉及文件表要求"Vite proxy 追加 `'/plugins-ui'`"+"`packages/server/src/index.ts` 新增 `/plugins-ui/<name>/client.{js,css}` 静态挂载点" | **两者都没做，也不需要**：`/plugins-ui/**`（入口表 + 各插件 bundle）与 `/host-sdk/**` 都放在 `packages/web/public/`（Vite 的 `publicDir`）——dev 由 Vite 直接提供，`vite build` 时原样复制进 `dist/`、再由后端静态托管，天然同源。核对方式：`grep -rn "plugins-ui" packages/server/src/index.ts packages/web/vite.config.ts` **无任何命中** | 批次 D 涉及文件表已改为记录真实做法（少一个 proxy 配置、少一个服务端挂载点） |
| 插件 UI bundle 的构建位置 | 批次 D 涉及文件表写 `plugins/<name>/client/vite.config.ts` → 产物 `plugins/<name>/dist/client.js` | **实际在** `packages/web/fixtures/vite.config.ts`（`build.lib`：`entry` / `formats: ['es']` / `fileName: 'client'` / **显式 `cssFileName: 'client'`**），源码在 `packages/web/fixtures/src/`，产物落 `packages/web/public/plugins-ui/`；生成命令 `pnpm --filter @geewiki/web run build:fixtures`（**不在 `pnpm build` 内**，且产物目录被 `.gitignore` 排除） | 批次 D 涉及文件表已按实现改写；另注明 `plugins/hello-geewiki/` 是**后端零依赖插件示例（无 UI）**，与前端 fixture 是两回事 |
| 插槽名清单 | 批次 D 关键契约写"插槽名（如 `admin-page-slots` / `header-slots`）"，roadmap Phase 3 写 `header-slots` / `editor-toolbar-slots` / `admin-page-slots` | **实际白名单只有两个**：`packages/web/src/lib/slots.tsx:12` 的 `export type SlotName = 'app-header' \| 'app-footer'`（`SLOT_NAMES` 在 `:15`；未在名单内的名字在 `:62` 打印 `[geewiki-slot] 未知插槽名 "…"，已忽略（可用：app-header, app-footer）`）。且**没有**后端 `ctx.slot(name, component)` 注册链路 | 批次 D 关键契约与 `docs/roadmap.md` Phase 3 均已按实现改写；`ctx.slot()` 与另两个扩展点保留为未落地候选 |
| Slot 的生命周期绑定 | 批次 D 涉及文件表写加载器"生命周期绑定 fork" | **未绑定**：刷新入口是 `packages/web/src/lib/pluginUi.ts:262-267` 的 `window.__GEEWIKI_PLUGIN_UI__ = { refresh, unload, loaded, base }`，由调用方（`packages/web/src/main.tsx`）显式触发；`unloadPluginUi` 只做"注销插槽注册 + 移除 CSS"（`:193` 注释：ESM 模块本身无法从模块图中卸载） | 写入批次 D 风险段与 `docs/architecture.md` §6 的"已知边界"；源码 TODO（`:27-30`）已登记"入口表后端下发 / fork 事件自动刷新 / 版本与完整性校验"三项 |
