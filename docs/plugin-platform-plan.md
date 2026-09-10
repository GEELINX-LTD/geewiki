# GeeWiki 插件化平台：实施批次方案与内核实证

> 本文档面向项目维护者与后续接手者，回答两个问题：**下一步按什么顺序做什么**，以及**底层内核行为已经被实验证实成什么样**。
>
> 文档中的"实证"结论来自 `data/spike/` 下的探针脚本（`probe1-fork-update.mjs` / `probe1b-hooks.mjs` / `probe1c-hook-next.mjs` / `probe2-schemastery.mjs` / `probe2b-payload.mjs` / `probe3-load.mjs` / `addendum.mjs`）。**`data/` 被 `.gitignore` 排除，该目录随时可能被清理**，因此结论在此固化；`data/spike/` 内另装有 `schemastery@3.18.0` 与 `cordis@4.0.0-rc.10`（工作区尚未声明 schemastery 依赖）作为独立验证环境。复现方式见第 8 节。
>
> 现状与设计蓝图见 [architecture.md](./architecture.md)，阶段划分见 [roadmap.md](./roadmap.md)（本文批次 B–F 对应 roadmap 的 Phase 3 / Phase 4 候选清单），容器化细节见 [deployment.md](./deployment.md)。本文编号自成体系，不延续 architecture.md 的章节号。

## 1. 背景与目标

GeeWiki 已具备"清单驱动装配 + 依赖图/冲突组 + 会话沙箱 + 迁移控制器 + 看门狗"的插件管理器（`packages/manager`），但插件的**可配置、可外部扩展、可贡献界面**这三条链路尚未打通。插件化平台需要补齐 6 项能力：

| 编号 | 能力 | 当前状态 |
| --- | --- | --- |
| ① | 插件配置系统：manifest `configSchema` → 前端表单 + 持久化 + 热更新 | 仅透传 JSON 原文（`POST /api/plugins/:name/enable` 携带 `config`），无校验、无表单、无热更新 |
| ② | 外部插件加载：`./plugins` 目录 + 清单发现 | 未实现。插件由 `packages/server/src/index.ts` 的 `defaultRegistry()` 代码内置登记（4 个：`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/echo` / `@geewiki/wiki`） |
| ③ | 前端 Slot 插槽：插件向 Web 管理台贡献 UI | 未实现（architecture §6 为目标态） |
| ④ | 治理补齐：`drainTimeout` 消费、`conflictGroup` 替换交互、`enable` 回滚作用域 | 排空**已落地**；冲突组仅有互斥拦截（无替换交互）；`enable` 回滚为调用帧局部（详见第 5 节） |
| ⑤ | 容器化：`docker compose up` 可用 | 已有在制品（`Dockerfile` / `docker-compose.yml` / `docs/deployment.md`），属并行工作进行中 |
| ⑥ | PostgreSQL 适配（评估） | 未落地，`DatabaseAdapter` 目前为同步接口 |

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

**D-2 热更新路径：`fork.update()`；落盘挂在 `fork.ctx` 的 `internal/update` 上。**
理由：update 是 cordis 唯一的一等公民热更新入口（F-1）。落盘用"`.tmp` + `rename` 原子替换"（koishi 同款），注册在 `fork.ctx`（F-6 证实 root 收不到），并且**必须 `return next()`**。失败必须显式回滚旧配置（F-3 的 `FAILED` + 新 config 状态不可接受）。

**D-3 外部插件信任模型：进程内动态 `import`，信任边界＝管理员显式安装的本地目录。**
靠**路径守卫**防路径穿越：入口与 migrations 目录必须 `resolve` 后仍位于插件目录内；不引入子进程沙箱。理由：安全收益不抵 IPC 与状态同步成本——插件需要直接访问 `ctx`（DI 容器、事件总线、DB 服务），跨进程会把"插件即代码"退化成 RPC，且无法复用 cordis 的生命周期与依赖注入。

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

## 4. 分批实施计划

### 批次 B：外部插件加载 + 契约冻结（最优先）

**范围**：从 `./plugins` 目录发现插件、加载模块、校验清单，并与内置注册表合并。

**涉及文件**

| 动作 | 路径 |
| --- | --- |
| 新建 | `packages/loader/`（发现 + 加载 + 校验，含 `package.json` / `tsconfig.json` / `src/index.ts`） |
| 修改 | `packages/server/src/index.ts` —— `defaultRegistry()` 改为「内置条目 + loader 合并」 |
| 修改 | 根 `package.json` —— 增脚本（如 `dev:plugins` / loader 相关入口） |

**关键契约**

```ts
loadExternalPlugins(pluginsDir: string, extraPaths: string[]): Promise<RegisteredPlugin[]>
```

- **发现规则**：`./plugins/*/` 每个子目录一个插件；清单取目录内 `package.json` 的 `geewiki` 键，或独立的 `geewiki.manifest.json`（二者取其一，同时存在时以独立清单为准——**未验证**，落地时需明确并测试）。
- **入口解析顺序**：`geewiki.entry` → `index.ts` → `index.js` → `src/index.ts`（必须解析到具体文件，见 L-3）。
- **name 全局唯一**：与内置注册表及其它外部插件重复 → 告警并跳过（不阻断启动）。
- **路径守卫**：入口文件与 migrations 目录 `resolve` 后必须在插件目录内，否则拒绝加载（D-3）。
- 加载仍走 `pathToFileURL().href` + `import()`（L-1）；TS 插件统一走 `tsx` loader（L-4）；导出取 `mod.default ?? mod`（L-5）。
- **契约冻结内容**：`RegisteredPlugin` 结构、manifest 中 `configSchema` 的承载方式、插件 `client`（前端 UI 入口）字段的声明位置与加载约定。冻结后写入 `@geewiki/core` 类型。

**验证方式**：单元测试（发现规则、入口解析优先级、重名跳过、路径守卫拒绝越界路径、清单缺字段）+ 隔离端口端到端冒烟（起服务、确认外部插件出现在 `GET /api/plugins`、enable 成功）+ 改文件后重载生效（`?v=mtime` 路径）。

**风险**：清单"双来源"（`package.json#geewiki` vs `geewiki.manifest.json`）若不明确优先级会造成线上歧义；TS 插件的 loader 依赖 devDependency `tsx`，与生产镜像裁剪 devDependencies 存在张力（见第 5 节 L-3）。

### 批次 C：配置系统

**范围**：`configSchema` → REST → 前端表单 → 持久化 → 热更新。

**现状与契约缺口（实现前必读）**

仓库**当前**的 `configSchema` 是 **JSON Schema 风格字面量**，不是 schemastery 实例：

| 复核点 | 现状 |
| --- | --- |
| `packages/core/src/index.ts:49` | 类型定义为 `configSchema?: Record<string, unknown>`，注释写着"JSON Schema 格式的配置定义与校验" |
| `packages/plugin-wiki/src/index.ts:37` | 字面量 `{ type: 'object', properties: { recentVersions: { type: 'number', title: '版本历史返回条数' } } }` |
| `packages/plugin-echo/src/index.ts:30` | 字面量 `{ type: 'object', properties: { message: { type: 'string', title: 'Echo 消息' } } }` |

注意这两处用的 `title` 键**在 schemastery 中不存在**（S-10），即现有字面量与 D-1 选定的 schemastery 载荷不是同一种东西。

**因此批次 C 存在一个契约迁移决策（开放项，待批次 C 拍板）**：

- **方案甲（推荐）**：把 `packages/core` 的 `configSchema` 类型改为 schemastery `Schema`，并同步改写 `packages/plugin-wiki` / `packages/plugin-echo` 这两个内置插件。
  理由：**最简单**——两个都是自带插件，改写成本可控，且与 D-1（schemastery 选型）和 F-7（`plugin.Config` 自动校验）一致，不存在双轨维护。
  **破坏性影响**：① `packages/core/src/index.ts:49` 的类型变更（消费方全部要跟着改）；② 上述两个插件 `configSchema` 字面量改写为 `Schema.object({...})` 形式；③ 需要新增**下行载荷剥离逻辑**（剥离 `callback` / `preserve`、降级 `transform`，见 S-8）。
- **方案乙**：双轨兼容（同时接受字面量与 `Schema`）。代价是双份渲染路径 + 双份校验语义，需另外定义"如何区分两者"，不推荐。

**涉及文件**

| 动作 | 路径 |
| --- | --- |
| 修改（方案甲） | `packages/core/src/index.ts:49` —— `configSchema` 类型改为 schemastery `Schema` |
| 修改（方案甲） | `packages/plugin-wiki/src/index.ts:37` / `packages/plugin-echo/src/index.ts:30` —— 字面量改写为 `Schema.object({...})` |
| 新建 | `packages/manager/src/config-store.ts`（原子写：`.tmp` + `rename`） |
| 修改 | `packages/manager/src/index.ts` —— `updateConfig` + 两个 REST 端点；`snapshotOf` 携带 schema（**下发前剥离 `callback` / `preserve`，见 S-8**） |
| 修改 | `packages/web/src/api.ts` —— 增配置读写客户端 |
| 新建 | 配置表单组件（按 S-7…S-17 解析 refs 图渲染控件；**只渲染、不 hydrate**） |
| 修改 | `packages/web/src/pages/AdminPage.tsx` —— 替换裸 JSON `textarea`（当前 `configText` / `configFor` 状态驱动的行内编辑） |
| 修改 | `package.json` / `packages/core/package.json` —— 正式声明 `schemastery@3.18.0` 依赖（当前工作区没有，见第 2.2 节 S-7…S-17 前提说明） |

**关键契约（端点）**

| 端点 | 成功 | 失败 |
| --- | --- | --- |
| `GET /api/plugins/:name/config` | `{ok, name, config, schema, layer}` | 404 插件不存在 |
| `PUT /api/plugins/:name/config` | 200 `{ok, config, hotUpdated, requiresRestart?}` | 400 `invalid_config`（附 schemastery 逐条错误）/ 400 `config_not_supported` / 409 `hot_update_failed`（返回**已回滚**的配置） |

`updateConfig` 语义：

1. 插件**未激活** → 只落盘（写对应层级文件，D-5），返回 `requiresRestart: true`；
2. 插件**已激活** → 校验（`plugin.Config` / schemastery）→ 落盘 → `fork.update(newConfig)`；
3. 任一步失败 → 回滚进程内配置（必要时按 F-3 用旧配置再 `update()`）并返回 409，**落盘也需回滚或用临时文件提交**，避免"盘上是新的、进程是旧的"。

**验证方式**：单测（原子写、层级选择、校验失败、回滚）+ 端到端（改配置 → 观察插件行为变化 → 重启后配置仍在）+ 未激活插件改配置只落盘（热更新不触发）。

**风险**：F-5 的连带重启意味着"改一个 provider 的配置 = 重启它和它的全部依赖者"，需要在前端明确提示影响面；F-6 的"忘记 `next()` 静默失效"必须有测试覆盖。

### 批次 D：前端 Slot（依赖批次 B 冻结的 `client` 契约）

**范围**：插件向 Web 管理台贡献 UI。

**涉及文件**

| 动作 | 路径 |
| --- | --- |
| 新建 | `packages/web/src/lib/slots.tsx` —— `registerSlot` / `SlotOutlet`（`SlotOutlet` 外包 ErrorBoundary） |
| 新建 | `packages/web/src/lib/host-sdk.ts` —— 宿主 SDK 初始化，挂 `window.__GEEWIKI_HOST__`（`React` / `ReactDOM` / `jsxRuntime` / `registerSlot`），见 D-8 |
| 新建 | 插件侧 react external 的**薄 shim 模块**（从 `window.__GEEWIKI_HOST__` 取宿主实例再 re-export，见 D-8） |
| 新建 | entry 动态加载器（按插件名从 `/plugins-ui/<name>/client.js` 加载其 UI bundle，生命周期绑定 fork） |
| 修改 | `packages/web/src/main.tsx` —— 顶部初始化 host SDK（D-8）；**不引入 import map** |
| 修改 | `packages/web/vite.config.ts` —— proxy 追加 `'/plugins-ui'` → `http://127.0.0.1:3000`（当前仅 `'/api'`） |
| 修改 | `packages/web/src/App.tsx` / `packages/web/src/pages/AdminPage.tsx` —— 注入点 |
| 修改 | `packages/server/src/index.ts` —— 新增 `/plugins-ui/<name>/client.js` 与 `client.css` 静态挂载点（带路径守卫；现有 `serveStatic` 把 root 锁死 `webDist`，见 `:350-397` 与 `:540-548`） |
| 新建 | `plugins/<name>/client/vite.config.ts` —— `build.lib`（`entry` / `formats: ['es']` / `fileName: 'client'` / **显式 `cssFileName: 'client'`**），产物 `plugins/<name>/dist/client.js` + `client.css` |

**关键契约**：插槽名（如 `admin-page-slots` / `header-slots`）；UI 入口 bundle 的 external 约定（D-4）与宿主实例来源（D-8）；`registerSlot(name, Component)` 的注册/撤销对；**插件 UI 资源 URL 统一为 `/plugins-ui/<name>/client.js` 与 `/plugins-ui/<name>/client.css`**（dev 与 prod 完全一致，dev 靠 Vite proxy 转到 3000），受路径守卫限制。

**验证方式**：单测（注册/撤销、ErrorBoundary 兜底）+ 浏览器端到端（插件 UI 出现在管理台、插件卸载后 UI 消失且主界面不白屏）+ **单例证伪实验先行**（lib-mode + external 手搭 hello bundle，浏览器动态 `import()` 后渲染带 hooks 的组件，确认无 `Invalid hook call`；见 D-8 与下方风险）。

**风险**：**React 单例共享是本批次最高风险点**（双实例 → `Invalid hook call`），必须先跑 D-8 的半小时证伪实验再铺开；`/plugins-ui` 在 dev 下依赖 Vite proxy 配置与后端监听地址一致（后端默认 `0.0.0.0:3000`）；插件 client bundle 的 CSS 文件名必须显式指定，否则 Vite 6 单入口下不稳定。

### 批次 E：PostgreSQL 适配（评估优先）

**范围**：先出评估结论，再决定是否落地 `packages/db-pg/`。

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

**范围**：多阶段镜像 + compose，使 `docker compose up` 可用。**已有在制品**，当前处理方式（builder/runtime 分阶段、运行期单独安装 `tsx`、`chmod -R a+rX` 等）见 [deployment.md](./deployment.md)。本批次只需在插件平台能力落地后回归验证：外部插件挂载目录（容器内 `/app/plugins`）能被批次 B 的发现逻辑识别。

## 5. 已知限制与待办

**L-1 排空语义是全站在途请求，不是 owner 级。**
`@geewiki/http` 的 `inflight()` / `drain()` 以整个路由服务为粒度：卸载任一插件时，等待的是**全站**尚未结算的请求（不含发起卸载的那次管理请求）。更精确的 **owner 级排空**（只等待被卸载插件自身路由注册的在途请求）列为后续工作。

**L-2 `enable` 失败回滚的作用域是调用帧局部。**
`packages/manager/src/index.ts` 的 `enable()` 用 `activatedByThisCall` 记录"本次调用新激活的依赖"，失败时逆序回滚。依赖深度 ≥2 时，孙依赖由被失败的子调用自己回滚——理论上存在孙依赖残留的可能。**当前内置注册表最大依赖深度为 1，该情形实际不可达**；外部插件引入更深依赖链后必须重新评估。

**L-3 后端直接运行 TS。**
各包 `exports` 指向 `src/index.ts`，运行期依赖 devDependency `tsx`；这与生产镜像裁剪 devDependencies 存在张力。镜像侧的当前处理方式见 [deployment.md](./deployment.md)。

**L-4 未实现项。**
插件市场 / 签名校验、插件前端类型检查、跨插件 `configSchema` 引用（schema 复用）均未实现。

**L-5 `./plugins` 目前仅为挂载点。**
容器编排中 `./plugins` → `/app/plugins`（宿主路径可用 `GEEWIKI_HOST_PLUGINS_DIR` 覆盖）已就位，但**发现逻辑属批次 B**，当前目录存在与否不影响启动。

**L-6 ESM 重载的模块实例不会被回收。**
`?v=<mtime>` 每次都产生新模块实例（§2.3 L-2 实证），反复热重载会累积旧实例。当前不做回收；若未来出现高频重载场景需评估。

**L-7 React Flow 授权提示会打进 console。**
`packages/web/src/pages/GraphPage.tsx:145` 的 `proOptions={{ hideAttribution: true }}` 会让 React Flow 在 console 打印授权提示。这是**上游许可证提示，不是缺陷**；是否保留需按许可证条款决定（改回显示署名即可消除）。基线验收时已确认：除该提示外 console 无错误。**该条与本节其余 L-n 的语义不同**：L-1…L-6 是功能/架构限制，本 L-n 是法律与观感层面的取舍。

**L-8 Wiki 详情页「← 返回列表」依赖浏览器历史栈。**
`packages/web/src/pages/WikiPage.tsx:174` 的「← 返回列表」用 `window.history.back()`（同文件 `:162` 的「← 返回」同样如此）。当历史栈里先有编辑页时，点击会**先退回编辑页**而非列表页。建议改为显式导航 `onNavigate('')`（该组件已持有 `onNavigate`，见 `:28`）。

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

**遗留项**：见第 5 节 **L-7**（React Flow 授权提示）与 **L-8**（详情页「← 返回列表」走 `history.back()`）。

**基线口径说明**：本节的 3 ms 是"客户端观测到的停用请求耗时"，不是服务端 P99；`data/geewiki.db` 为本地验收库，验收后页面已清空但库文件本身不参与版本控制。

## 7. 验证纪律

每一批交付必须同时满足：

1. `pnpm typecheck` **0 错**；
2. `pnpm test` **全绿**，且包含该批新增用例（当前基线：**35/35**，即 manager 24 + server 11；见 roadmap）；
3. **隔离端口**的端到端冒烟（不得占用开发用的 3000 / 5173）；
4. 涉及 UI 的批次必须有**浏览器端到端验收**（真实渲染，而非接口断言）；
5. **每批先经独立 Reviewer 审查，再提交**；
6. 本文档中未经验证的假设（如批次 B 的清单双来源优先级、批次 E 的 Kysely 选型）在落地时必须补上验证结果，或改标注；
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
| `schemastery` 依赖 | 选型 `schemastery@3.18.0` | 工作区 `packages/*` **尚未声明**该依赖，仅在 `data/spike/` 独立环境中安装 | 已在文档开头注明，批次 C 需正式加依赖 |
| `drainTimeout` 消费 | 能力 ④ 列出"`drainTimeout` 消费"待补 | **已落地**：`packages/manager/src/index.ts` 的统一卸载出口按 `runtime.drainTimeout` 排空 | 第 1 节状态改为"已落地"，与 roadmap Phase 4 的说明一致 |
| `conflictGroup` 替换交互 | 能力 ④ 列出待补 | 确认未实现：仅 `activateCore` / `enable` 的互斥拦截（抛 409 `conflict_group`），无替换交互 | 保持"待补" |
| 前端 Slot 单例共享 | 初版 D-4 写"宿主用 import map 暴露 react 单例" | **勘察证伪**：`react@19.2.8` 无任何 ESM 产物（`exports` 只有 `react-server`/`default`）、宿主产物已内联 react（`packages/web/dist/assets/index-DyngNpzw.js`）、dev 的 `?v=<hash>` 会造成实例分裂 | **改写**：D-4 保留其余结论并指向新增 **D-8**（宿主 `window.__GEEWIKI_HOST__` SDK + 薄 shim） |
| `configSchema` 承载方式 | 批次 C 直接按 schemastery 载荷渲染 | 仓库现状是 **JSON Schema 风格字面量**：`packages/core/src/index.ts:49` 为 `Record<string, unknown>`，`packages/plugin-wiki/src/index.ts:37` / `packages/plugin-echo/src/index.ts:30` 用 `title` 键（schemastery 无此键） | 批次 C 增列**契约迁移开放项**（推荐方案甲：类型改 `Schema` + 改写两个内置插件 + 载荷剥离） |
| schemastery 载荷规格 | "`refs` 是数组 / 节点带 `uid` / 有 `Schema.fromJSON`" | 实测均为**否**：`refs` 是对象、节点无 `uid` 字段、反序列化只有构造函数入口（`src/index.ts:178-208`）；且反序列化会 `new Function` 执行 `callback`（`:197-202`） | 写入 **S-7 / S-8**，并把"前端不得 hydrate"列为安全红线 |
| uid 作为缓存键 | "同一 schema 重复序列化 uid 会变" | 需区分两种情形：**同一实例**重复 stringify 字节相同（`probe5.out` §B `uid=14/14 equal=true`）；**重新构造**同一 schema 才变（§A `uid1=4 uid2=9`） | 写入 **S-14**，表述按两种情况区分，跨请求用内容 hash / 插件版本号 |
| UI 资源 URL 前缀 | 初版批次 D 写 `/plugins/<name>/...` | 现有静态托管的 root 锁死 `webDist`（`packages/server/src/index.ts:350-397` 与 `:540-548`），需独立挂载点 | 统一为 **`/plugins-ui/<name>/client.{js,css}`**，dev 由 `packages/web/vite.config.ts` proxy 转发 3000 |
| 测试计数 | 各文档写"单测 23/23" | 实跑 `pnpm -r --if-present run test`：**manager 24 + server 11 = 35/35**（`deps 8 + manager 13 + repo-paths 3`；`packages/server/test/router.test.ts` 11） | 已同步修正 `README.md`、`docs/roadmap.md`、本文第 7 节 |
| UI 基线验收 | "4 路由可达、停用 3ms、console 无错误" | 对照 `data/spike/e2e/` 的 CDP 脚本与 DOM 快照确认：`/`、`#/wiki`、`#/plugins`、`#/graph` 四路由与 `#/graph` 的 **4 节点 + 3 边**（`react-flow__edge-path` 计数 3）均可复核 | 写入第 6 节"当前质量基线"；3 ms 标注为客户端观测口径 |
| React Flow 授权提示 | 未提及 | `packages/web/src/pages/GraphPage.tsx:145` 的 `proOptions={{ hideAttribution: true }}` 会触发上游许可证提示 | 写入 **L-7**（非缺陷，按许可证决定处理） |
| Wiki「返回列表」 | 未提及 | `packages/web/src/pages/WikiPage.tsx:174` 用 `window.history.back()`，历史栈已有编辑页时会先退回编辑页 | 写入 **L-8**（建议改显式 `onNavigate('')`） |
| schemastery 源码行号 | "`toJSON` 在 `src/index.ts:235-246`" | 逐个核对一致（`:235` 起、`:246` 结束）；`refs` 分支 `:183`、`new Function` 在 `:200`、`required` 判定 `:413-422`（抛错在 `:414`）、`merge(result, data)` 在 `:700`、默认值注入 `:791-797`、类型注册 `:803-839` | 已在 S-7…S-17 中按核对后的行号写入 |
