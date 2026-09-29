# GeeWiki 插件兼容性政策

> 本篇回答一个本项目**目前没有机制回答**的问题：**我这个插件，在哪个宿主版本上能用？**
>
> 结论先行：**宿主不做任何兼容校验**。所以兼容责任 100% 落在作者侧，本篇把它写成可执行的政策——判据、写法、必做动作、拒收条件。

- 现状与理念冲突处的总表见 [`index.md`](index.md) §7；本篇只讲"兼容"这一维。
- 契约形状（清单字段、SDK 方法签名、宿主节点目录、错误码）以 [`api-reference.md`](api-reference.md) 为准；**为什么这样设计**、边界与已知限制以 [`../plugin-platform.md`](../plugin-platform.md) 为准。本篇不复述这两处的散文，只给政策。

---

## 1. 一句话政策：本项目没有版本协商，兼容靠特性探测

| 问题 | 现状答复 |
| 清单能声明"我需要宿主 ≥ x.y.z"吗 | **不能**。`GeeWikiManifest` 没有 `minHostVersion` / `engines` 一类字段 |
| 宿主会拒绝加载"不兼容"的插件吗 | **不会**。宿主不比较任何版本号（它也没有可比的版本号） |
| 清单里的 `version` 有兼容语义吗 | **没有**。它只用于展示与发现日志（缺省时按 `'0.0.0'` 处理，见 `parsePluginManifest`，`packages/manager/src/discovery.ts`） |
| 破坏性变更后有 API 迁移工具吗 | **没有**，代码不会自动迁移，也没有弃用期告警 |
| 那作者怎么知道自己能不能跑 | 三条判据，见 §3（**唯一**手段） |

一句话：**"能加载"不等于"能用"，"没报错"不等于"没问题"。** 提交前用 [`review-checklist.md`](review-checklist.md) 自证，别指望宿主替你把关。

---

## 2. 为什么没有照抄 VS Code / Obsidian 那套（以及将来怎么补）

| 产品 | 做法 | 生效前提 |
| VS Code | `engines.vscode` 声明宿主版本范围，安装期由市场与客户端裁决 | 有中心分发市场、有版本化的发布产物、有安装这一步 |
| Obsidian | manifest 的 `minAppVersion` + 市场侧 `versions.json` 版本映射表 | 有官方市场持有那份映射表，并按它筛选/提示 |

GeeWiki 缺的正是这些前提（`docs/architecture.md` 的"不绑厂商 + 极致轻量"直接排除了它们）：

- **插件按目录发现**：`packages/manager/src/discovery.ts` 的 `parsePluginManifest` 扫出 `package.json` 的 `geewiki` 键即成为候选，激活靠 `config/plugins.base.json` 的 `enabled` 白名单。**没有"安装"这一步**，也就没有安装期可以执行版本裁决的时刻。
- **`plugins/` 下的外部插件不是 workspace 包**（见 `pnpm-workspace.yaml`），因此不参与 `pnpm -r` 的 `test` / `typecheck` / `build`，也没有锁文件与产物校验。
- **所有包 `private: true`，无 npm 发布通道**，没有分发市场来执行版本协商（该状态登记在 `docs/agent/backlog.md` 的 `F21`，标注为**需决策**）。
- **无沙箱、无签名发布者**：`pnpm run install-plugin` 的完整性基线只给 `ok` / `drift` / `unsigned` / `missing`（`manager.verifyPluginIntegrity`，`packages/manager/src/index.ts`），**签名与发布者身份目前不成立**（`docs/roadmap.md` "外部插件签名"一节）。

诚实结论：**在没有分发通道之前，把 `minHostVersion` 写进清单也只是一行没人读的数据**——照抄字段而不解决裁决点，只会给作者一个假的安心感。因此本项目当前选择"如实告知无协商 + 把探测判据写清"。

### 2.1 政策：协商机制落地那天，作者该做什么（现在别写）

- **现在**：只写 §3 的探测判据，**不要**提前加 `minHostVersion` 字段——未知字段在外部插件侧会被清单解析忽略，写了等于没写，还会让人误以为有保护。
- **将来**：一旦清单出现版本字段（整改登记在 `docs/agent/backlog.md` 的 `F22`，状态**未处理**，最小改法是"先做可见性 + 只告警不阻断"），按下面两条写：
  1. 只填你**实测过的最低宿主版本**，不要填"看起来安全的"更宽范围——范围越宽，静默失效越晚暴露。
  2. 字段是**兜底**，不是替代：仍然保留 §3 的探测与降级路径，因为该字段本身按只告警设计，不会替你阻断。

---

## 3. 三条兼容判据（作者唯一能用的东西）

优先级：判据 ② **高于** ①；③ 用于界面贡献。

### ① SDK / 宿主版本可读，但**只用于自我诊断**

- 前端：`packages/web/src/lib/hostSdk.ts` 的 `export const HOST_SDK_VERSION = '0.12.0'`，作为 SDK 对象的 `version` 字段暴露，插件侧读 `host.version`。
- 服务端**没有**对应常量（`grep -rn "minHostVersion\|hostVersion\|engines" packages/core/src/index.ts packages/core/src/domain.ts` ⇒ 无命中，见 `F22`）。服务端唯一间接信号：`ctx.get('<服务名>')` 在位与否，或从 `http` / `db` 服务面上取方法。

版本→特性映射由 `hostSdk.ts` 顶部的 **"## 版本"** 注释块维护（下表按该注释块抄录，**该注释块是真源**，以它为准）。它也是宿主自己的递增纪律：加方法升 minor，老方法的签名与语义不改。

| 起于 | 新增能力 |
| 0.2.0 | `renderMarkdown` |
| 0.3.0 | `registerTool` / `invokeTool`（客户端工具） |
| 0.4.0 | `PluginSlotOutlet` / `slotContributors` / `useSlotEntries`（插件可自开扩展点） |
| 0.5.0 | `registerRoute` / `unregisterRoutes`（插件自有页面与 URL） |
| 0.6.0 | `ReactDOM` / `ReactDOMClient` / `createPortal` / `createRoot` |
| 0.7.0 | `registerMarkdownExtension` |
| 0.8.0 | `registerTheme` / `unregisterThemes` |
| 0.9.0 | `t` / `getLocale`（与宿主共用 message catalog） |
| 0.10.0 | `registerExtension`（`wrap` / `replace`，界面扩展平台 P4） |
| 0.11.0 | `registerExtension` 的 `opts.shadow`（P9） |
| 0.12.0 | 加载期间的**作用域宿主**（P13）、作用域宿主独有新字段 `pluginName` |

**为什么不要按版本字符串比大小**（这条写在 `hostSdk.ts` 的注释里，是宿主自己的口径）：

- 本项目与 `@cordis` 都停在 rc 线上，没有语义化承诺——版本号能推导出"有这个方法"，推导出"行为没变"。
- 未来若引入真正的协商字段，字符串比大小会和它打架。
- 唯一正当用法：把版本号打进自己的日志/诊断面板，出问题时能说清"我在哪个宿主上炸的"。

```js
// ✅ 只做记录与提示，不做门禁
console.info(`[my-plugin] running on host SDK ${host.version}`)
```

### ② 用之前判存在（主力判据）

```js
export default {
  name: '@geewiki-plugin/my-note',
  apply(ctx) {
    const http = ctx.get('http')
    // 判存在：宿主没有这个面时**降级**，而不是抛错让整插件激活失败
    if (typeof http?.register !== 'function') {
      console.warn('[@geewiki-plugin/my-note] http 面不可用，已跳过路由注册')
      return () => {}                       // 仍然必须返回注销函数，见 §4
    }
    // register() 的返回值**就是**注销函数（HttpRouterService.register，packages/core/src/index.ts）
    const unregister = http.register('GET', '/api/my-note', handler, { access: 'user' })
    return () => unregister()               // access 缺省即 'public' ⇒ 必须显式写
  },
}
```

这套写法（`ctx.get('http')` 判空 + `register()` 返回注销函数 + `apply()` 返回 disposer）就是仓库里那个外部示例的骨架，见 `plugins/hello-geewiki/index.ts`。

前端同一写法（这是 `hostSdk.ts` 注释里给的原文示例）：

```js
export function setup(host) {
  // ❌ 不要：if (host.version >= '0.7.0') —— 字符串比大小不可靠
  if (typeof host.registerMarkdownExtension !== 'function') return      // ✅ 退化路径：什么都不做
  const off = host.registerMarkdownExtension('my-note', myRule)
  return () => off?.()                                                  // 见 §4
}
```

判据 ② 的降级动作只有三种正当形态：**不注册该功能** / **显示纯文本或占位** / **显式告知用户"当前宿主不支持"**。第三种必须能在管理台或界面上看见——静默把功能吃掉，等价于制造静默空白（见 [`anti-patterns.md`](anti-patterns.md) AP-09/AP-10 一族）。

### ③ `props.propsVersion`（界面贡献专用）

宿主渲染你的组件时会注入 `props.propsVersion`，来源是 `packages/core/src/slots.ts` 的 `SLOT_PROPS_SCHEMA` / `packages/core/src/extensions.ts` 的 `HOST_NODE_CATALOG`，由 `packages/web/src/lib/slots.tsx` 传下去（内置插槽与宿主节点目前**都是 1**，所以你现在写的是"未来护栏"）。props **形状**变更会走这个号，与 SDK 版本是**两条独立轴**，不要混用。

```jsx
export default function SummaryCard(props) {
  if ((props.propsVersion ?? 1) > 1) return null          // 宿主给了我不认识的形状：让位
  return <div className="gw-my-note-card">{props.title ?? ''}</div>
}
```

---

## 4. 作者侧兼容清单（硬性，逐条自查）

| # | 必须做 | 为什么 | 验证 |
| 1 | 新宿主能力用之前判 `typeof host.<方法> === 'function'` / `ctx.get(...)` 非空 | 宿主不校验版本，缺方法直接运行期 `TypeError` | 见 §7 判定实验 |
| 2 | 把 `host.clientTools` / `host.markdownExtensions` / `host.themeContributors` **每次读 getter**，不要存快照 | 这三个是活值 getter（`packages/web/src/lib/hostSdk.ts`），存快照会**永远读到空数组**（源码原话） | [`anti-patterns.md`](anti-patterns.md) AP-24 |
| 3 | 保存**每个**注册函数返回的注销函数，并在 `apply()` 返回的 disposer 里全部调用 | ESM 模块实例**永不回收**（`docs/plugin-platform.md` §5.2），不注销 ⇒ 停用后贡献收不回、再启用贡献翻倍 | 停用→启用两轮后查 `GET /api/plugins/slots` |
| 4 | 只用文档化成员（速查在 [`api-reference.md`](api-reference.md)） | `hostSdkSurface.test.ts`（`packages/web/test/`）只守**成员在不在**，不守类型；私有符号改了不会通知你 | [`api-reference.md`](api-reference.md) §前端 SDK 面 |
| 5 | 前端 bundle **不得**自带 `react` / `react-dom` | import map 让两侧共用宿主那一份实例；两份 React ⇒ portal/错误边界静默崩（`packages/web/fixtures/src/index.tsx` 的 `CounterWidget` 注释记着现场） | [`anti-patterns.md`](anti-patterns.md) AP-21 |
| 6 | 清单未声明的东西**不存在**：`slots` / `extensions` / `routes` / `clientTools` 声明与运行期注册必须双向一致 | 不一致是**静默空白**，宿主只告警不阻断 | `GET /api/plugins/slots`、`GET /api/plugins/ui` |
| 7 | 外部插件目录在部署环境写**绝对路径** | 相对路径静默解析到 `process.cwd()` ⇒ "不报错、0 个插件"（`Dockerfile` 写死 `GEEWIKI_PLUGINS_DIR=/app/plugins`） | `curl -s localhost:3000/api/plugins \| jq '.plugins[].name'`；[`anti-patterns.md`](anti-patterns.md) AP-14 |
| 8 | 涉及建表就 SQLite/Postgres 双方言成对提供 | 方言不匹配只在真连 PG 时炸（`AUTOINCREMENT` 在 PG 是语法错误），`pnpm test` 拦不住 | `pnpm --filter @geewiki/manager run test`（守卫 `packages/manager/test/migrations-dialect.test.ts`）；迁移时序与失败语义见 [`../architecture.md`](../architecture.md) §5.5「数据迁移与版本一致性（迁移控制器）」 |

---

## 5. 内置插件与外部插件的**待遇差**（决定你的兼容风险等级）

| 维度 | 内置包（`packages/*`） | 外部插件（`plugins/*`） |
| 发现方式 | `packages/server/src/index.ts` 的 `defaultRegistry()` 里显式 import | `parsePluginManifest` 扫目录读 `package.json` 的 `geewiki` 键 |
| 是否 workspace 包 | 是（`pnpm-workspace.yaml` 的 `packages/*`） | **否** ⇒ 不参与 `pnpm -r` 的 `test`/`typecheck`/`build`，没有 CI 兜底 |
| 入口形态 | `package.json` 的 `exports` 直指 `./src/index.ts`；运行期由宿主进程 tsx loader 直跑 TS | 同样由 tsx 直跑，但需自带依赖（pnpm 严格布局下 Node **不会**向上解析宿主依赖） |
| 独立版本 | **无**：`version` 随主干一起动 | 有（可缺失，缺失按 `'0.0.0'`） |
| 依赖内部符号的后果 | **等于绑定主干**：内部重构会在同一棵树里当场暴露，CI 能看见 | 同一后果，但**没有任何门禁**，只能在别人升级宿主后由用户发现 |
| 部署形态 | 随 monorepo 构建；Web UI 产物由 `pnpm --filter @geewiki/web run build:plugin-ui` 产出 | 不打进镜像（`Dockerfile` 里 `/app/plugins` 是挂载点）；`dist/` 需给仓库根 `.gitignore` 加例外（[`anti-patterns.md`](anti-patterns.md) AP-15） |
| 兼容结论 | 只 import `@geewiki/core` 导出的类型/常量，别 import 别的内置包内部文件 | 只依赖清单字段 + `@geewiki/core` 契约 + 宿主 SDK；**这就是"万物皆插件"的代价** |

> 内置包的 `exports` 指向源码这一点本身是已知待决策项（`F21`）：它意味着内置插件对内部符号的依赖**没有版本隔离**，将来若走发布通道即为破坏性变更。

---

## 6. 三处"看起来像契约、其实不是"

### 6.1 权限声明不是兼容契约的一部分

`PLUGIN_PERMISSIONS`（`packages/core/src/domain.ts`）全集是：

```
['fs:read', 'env', 'net', 'fs:write', 'process', 'secrets']
```

三点必须知道：

1. **顺序即管理台展示顺序，且是有意排的**（越靠后越危险：`fs:write` 在 `net` 之后）。文档与代码里**不要"顺手修正"成字典序**。
2. 宿主**不拦截**：声明与否都不影响你实际能不能 `fs` / `fetch`；未知取值只告警不阻断。
3. 因此它**不是**能力开关，也**不是**兼容契约。**若将来改为强制执行，对所有现存插件都是破坏性变更**——本篇把它写成政策的意义在于：**任何把 `permissions` 当"我需要的能力声明给宿主去授予"的插件设计，现在就该拒绝**，而不是等到强制执行那天集体失效。做法见 [`anti-patterns.md`](anti-patterns.md) AP-05；同进程同权限、无沙箱无配额的现状见 [`../plugin-platform.md`](../plugin-platform.md) §5.1。

### 6.2 路由 id 与访问等级不是版本化的

- 保留字 `RESERVED_ROUTE_IDS`（`packages/core/src/domain.ts`）是一组**宿主保留的页面 id**：`wiki` `plugins` `graph` `access` `org` `login` `setup` `invite` `denied` `account` `notfound`（以该常量的当前值为口径，**不要写死在代码里**，也不要拿本文当计数真源）。命中保留字是**直接拒绝**，不是先到先得；`audit` **已移出**，改由 `@geewiki/ops` 自己声明（守卫 `packages/web/test/opsOwnership.test.ts`）。
- 插件之间的路由 **id** 冲突才是先激活者胜出，落败方进 `conflicts`（`resolveRouteDecls`，`packages/manager/src/routes.ts`）。
- 保留字集合的**增删**不会有任何版本信号。对策：把集合抄进你自己插件的 README 与测试，宿主升级后重跑一次测试即可发现漂移。现算口径（仓库根执行，别把集合写死进代码）：

  ```bash
  node --import tsx -e "import('./packages/core/src/domain.ts').then((m) => console.log(m.RESERVED_ROUTE_IDS))"
  ```

  运行期则看 `GET /api/plugins/slots` 的 `routes` / `routeConflicts` 字段。
- `router.register()` 省略第 4 个参数 ⇒ `access: 'public'` 匿名可调；`GEEWIKI_STRICT_ROUTE_ACCESS=1` 才拒启（`STRICT_ROUTE_ACCESS_ENV`，`packages/server/src/index.ts`）。这条与兼容无关但与"能不能挂这个路径"同源，见 [`review-checklist.md`](review-checklist.md) 硬性 gate 第一条。

### 6.3 `GeeWikiClient` 只有 `{ entry?, css? }`

没有 `assets` 字段（`packages/core/src/index.ts` 里该类型定义末尾写着"无 assets 字段"）。含义：

- **UI 资源根就是 UI 根**：入口文件同目录及其子目录的产物无需声明即可服务，URL 形态 `/plugins-ui/<未编码插件名>/<相对路径>`。
- 未知扩展名给 `application/octet-stream`，**绝不**回退 `text/html`。
- **后果**：你不需要"注册资源清单"，但也**没有任何机制**告诉你某个 URL 已失效。写死 URL 的插件（尤其把 `css` 指向 `dist/client.css` 同时又在代码里 `import` 另一个 chunk 的做法）要自己负责回归。

---

## 7. 破坏性变更：谁通知你，以及**通告通道本身还不完整**

| 通道 | 你能拿到什么 | 现状与限度 |
| [`../plugin-platform.md`](../plugin-platform.md) | 契约事实真源：已拍板决策（§3）、UI 与扩展平台机制（§4）、当前限制与 `L-*`（§5）、验证纪律（§6） | **最全**，但它是"现状文档"不是"变更流"，不保证按发布节奏更新 |
| [`../roadmap.md`](../roadmap.md) | 下一步打算动哪些扩展点、签名、静态资源注入 | 计划，**不是承诺**；"当前读数"一节自称唯一读数 |
| [`../agent/backlog.md`](../agent/backlog.md) | 未修整改项 + 最小改法 + 验证方式（编号 `F*`） | 与本节最相关的：`F22`（无宿主版本协商，**P2/未处理**）、`F21`（`exports` 指向源码 vs 发布，需决策）、`F23`（热更新边界散落，无单一能力矩阵，**P2/未处理**） |
| [`../changelog/implementation-log.md`](../changelog/implementation-log.md) | 开发流水 | 自我定位为**历史快照**；`docs/README.md` 明确标它"**非当前口径**" ⇒ **不要**把它当变更通知源 |
| 根 `CHANGELOG.md` | **不存在** | 建 Keep a Changelog 风格根文件的计划在 backlog 的发布收尾条目里（**未处理**）；`package.json` 的 `version` 目前也无发布语义（`private: true`） |

**政策（在通道补齐之前，作者自己承担回归）**：

- 宿主 SDK 面由 `packages/web/test/hostSdkSurface.test.ts` 守卫。它**实际**做的事：从 `index.html` 解析 import map 并断言每条裸说明符（`react`、`react/jsx-runtime`、`react-dom` 等）都有映射、且指向 `/host-sdk/` 下**真实存在**的 shim 文件；断言 SDK 接口字段与对象成员成对存在；解析 `HOST_SDK_VERSION` 并断言 major 为 `0`、**版本号不许回退**（注释原话：回退版本号会让插件的特性探测失去意义）；断言"版本演进说明"里每个能力条目仍在（改动历史是插件作者的唯一依据）；断言 `themeContributors` / `markdownExtensions` 必须是 getter。
- 结论：**它守形状、守不倒退，不守行为与签名** ⇒ 不能替代 §3 的探测。反过来它给了你一条硬保证：`hostSdk.ts` 里的版本演进表不会悄悄被删。
- 每个 minor 之后跑一次冒烟：命令口径见 [`api-reference.md`](api-reference.md) §自检与诊断命令（含清单发现、插槽裁决、UI 入口表、路由访问等级审计、完整性基线）。
- 你自己的插件 README 必须写"**在哪个宿主版本上实测过**"——本项目没有别的地方能查到这件事。

### 7.1 判定实验（三步，唯一可信的结论来源）

```bash
# 1. 起当前主干
pnpm install && pnpm run dev
# 2. 看宿主认为你存在吗（外部插件必须先进 enabled 白名单）
curl -s localhost:3000/api/plugins | jq '.plugins[] | select(.name=="@geewiki-plugin/my-note")'
curl -s localhost:3000/api/plugins/ui   # UI 产物有没有被发现/被推迟
curl -s localhost:3000/api/plugins/slots | jq '{conflicts, undeclared, routeConflicts}'   # 被抑制/未声明/路由冲突
```

3. 判定：三项都正常 ⇒ 兼容；`state` 正常但 `slots` / `extensions` 里没有你的贡献 ⇒ **声明与运行期不一致**（不是宿主不兼容）；`conflicts` / `routeConflicts` 里有你 ⇒ 单占用节点被别人占了，或你用了该节点不允许的模式（§9）；加载期报 `window.__GEEWIKI_HOST__ 未初始化` ⇒ 时序问题，不是版本问题（bundle 在宿主 SDK 挂载前被求值，见 `hostSdk.ts` 顶部注释）。

**"我没报错"不等于"我兼容"**——本项目大多数不兼容的表现是静默空白（[`anti-patterns.md`](anti-patterns.md) B 组整组）。

---

## 8. 明确不支持项清单（提 PR / 申请收录时按此判定）

以下能力**不存在**，不要在插件里假设它们存在，也不要在文档/README 里宣称它们存在：

| 不支持 | 现状事实 | 你要怎么做 |
| 沙箱 / 进程内隔离 | 插件与宿主同进程同权限（[`../plugin-platform.md`](../plugin-platform.md) §5.1）；worker 隔离**有意后置**（§5.4） | 在 README 写清你会读什么、写什么、访问哪个域 |
| 资源配额 / CPU / 内存上限 | 无 | 自己节流；`applyTimeout`（默认 30 秒，`normalizeRuntime`，`packages/core/src/index.ts`）只兜启动阶段 |
| semver 范围 / 最低宿主版本协商 | 无（§1、`F22`） | §3 探测 + 优雅降级 |
| npm / 市场发布通道 | 无（`private: true`，`F21`） | 分发靠目录挂载 + `pnpm run install-plugin` 完整性基线 |
| CSS 默认隔离 | 插件 CSS 以 `<link data-plugin-ui>` **全局注入**，无前缀改写 | 类名加插件前缀约定（如 `.gw-my-note-*`）；需要强隔离用 `replace` + `shadow: true`（0.11.0 起，见 §9）或 `host.createRoot`；禁止硬编码颜色（守卫 `packages/web/test/pluginCssGuard.test.ts`，会连 `plugins/*/dist/client.css` 一起扫）；[`anti-patterns.md`](anti-patterns.md) AP-20 |
| ESM 实例回收 | 模块实例永不回收，产物更新需整页刷新（§5.2） | 不要依赖模块级状态被重置（AP-19/AP-20 一族）；注销函数全部自己调 |
| 内置插件独立版本 | 无（随主干） | 别把内置包的 `version` 当契约 |
| `GeeWikiClient.assets` | 字段不存在 | §6.3 |
| `geewiki.manifest.json` 承载 `configSchema` | 承载不了 schemastery 结构化 schema | 要结构化配置就用 `package.json`（AP-13） |

---

## 9. 插槽与扩展点的兼容面（作者最容易踩的一节）

**一句话记法：清单的 `slots` 字段是"只追加"的简写，永远表达不了 `replace`。**

- `geewiki.slots: ['editor']` **严格等价于** `extensions: [{ node: 'editor', mode: 'extend' }]`；运行期对应 `host.registerSlot(name, C)` ≡ `host.registerExtension(node, C, { mode: 'extend' })`（`hostSdk.ts` 对 `registerSlot` 的原文说明）。
- "能不能被 `replace` / `wrap`"**不是插槽的属性**，而是 `packages/core/src/extensions.ts` 的 `HOST_NODE_CATALOG` 的**模式目录**属性；"能同时有几个贡献者"是 `packages/core/src/slots.ts` 的 `SLOT_CARDINALITY`。两张表都在 core，但**是两个独立维度**，不要互相推导。
- 因此：**想替换必须用 `extensions`，同时该节点必须在模式目录里允许 `replace`**。对 `app-header` 声明 `replace` 的后果是**忽略并告警**，不是报错也不是拒启：管理器侧写"该节点只允许 `[...]`（宿主节点目录是唯一判据）"（`packages/manager/src/slots.ts`），前端侧写 `[geewiki-slot] 节点 "app-header" 不允许 replace 模式（允许：["extend"]），已忽略`（`packages/web/src/lib/slots.tsx`）。而且**被拒的声明仍留在裁决表里** ⇒ 你会同时看到"清单里有我"与"页面上没有我"，这是最费时间的一类排查。

内置插槽的当前模式与基数（**以 `HOST_NODE_CATALOG` 与 `SLOT_CARDINALITY` 的当前值为准**，速查表在 [`api-reference.md`](api-reference.md) §插槽与宿主节点目录）：

| 插槽 | 允许模式 | 基数 | 兼容性含义 |
| `app-header` | `extend` | multi | 只能追加；别人的贡献不会被你挤掉，你也替换不了页头 |
| `app-footer` | `extend` | multi | 同上 |
| `editor-toolbar` | `extend` | multi | 同上 |
| `account-identities` | `extend` | multi | 同上 |
| `editor` | `extend` / `wrap` / `replace` | **single** | 可替换；`replace` 后附件上传等责任转移到你（红线见 AP-03） |
| `app-dock` | `extend` / `wrap` / `replace` | **single** | 可替换，单占用 |
| `article-summary` | `extend` / `wrap` / `replace` | **single** | 可替换，单占用 |

可 `replace` 的插槽恰好就是三个单占用插槽——这不是巧合：多占用节点上"替换"语义无法定义（谁被替换？）。

配套政策：

1. **默认用 `extend`**：唯一对其它插件零副作用的模式；能 `wrap` 满足就不要 `replace`（`wrap` 保留宿主默认实现，不可能弄丢宿主控件）。
2. **`replace` 只在单占用节点上用**，并且要在 README 里声明"我接管了该节点"，让用户知道键盘可达性与无障碍责任已转移。
3. **portal 类 `ui-*` 节点（`ui-dialog-content`、`ui-dropdown-menu-content`、`ui-confirm-dialog`、`ui-tooltip`）不支持 `wrap`**：模式目录对它们只开 `extend` / `replace`（portal 内容渲染在包装器之外，`wrap` 会静默无效，AP-22）。
4. **自定义扩展点名必须含 `/`**（`PLUGIN_SLOT_NAME`，`packages/core/src/slots.ts`）；自定义插槽基数默认 `multi`，要单占用得显式 `slot.define()` 声明。名字里带版本号的自定义扩展点（`my/app-v2`）是自拆兼容的常见做法——**不要这么做**，改 props 形状时带上 `propsVersion` 让贡献者自己判。
5. 改 `HOST_NODE_CATALOG` / `SLOT_CARDINALITY` / props 形状属于**宿主改动**：必须同步 `propsVersion` 并同步文档。

---

## 10. 提交前自查 + 已知缺项

- [ ] 我在代码里读的是 `host.version` 或 `host.<方法>` 存在性，不是硬编码版本比较（§3）
- [ ] 我为每个新能力写了降级路径，降级结果**对用户可见**（§3 三种正当形态之一）
- [ ] 我保存并调用了全部注销函数（§4）
- [ ] 我的清单声明与运行期注册双向一致（§4）
- [ ] 我的插件 README 写了"实测宿主版本"，以及 §8 要求写清的读写与网络行为
- [ ] 我没有把 `permissions` 当能力开关（§6.1）
- [ ] 我的路由 id 不撞 §6.2 的保留字集合，且每条路由显式声明 `access`
- [ ] 我完整过了一遍 [`review-checklist.md`](review-checklist.md)

**已知缺项**：宿主侧没有"宿主版本号"这个对外读数（`GET /api/plugins` 不返回宿主版本），也没有 `CHANGELOG.md`；这意味着"我的插件实测于哪个宿主"只能靠 git SHA 或日期描述。写 README 时建议同时给出日期与主干 SHA（示例：`实测于 2026-09-28 / HEAD ed2a3a9`）。
