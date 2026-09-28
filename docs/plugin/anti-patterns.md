# GeeWiki 插件反模式清单

> 这份清单只收**已在真实代码里踩过、或被源码注释明确警告过**的坑，不收理论风险。每条结构固定：**反模式 → ❌ 禁止 → ✅ 正确 → 为什么 → 权威出处**。
>
> 出处一律「路径 + 符号名」，不写行号（行号会漂移）。分类标签：**🔴 默认不安全**（fail-open，静默地把权限放开或数据弄丢）、**🟠 静默失败**（不报错的空白/失效）、**🟡 生命周期**、**🟣 前端契约**、**🔵 兼容与卫生**。

## 严重度总览（按严重度排序）

| 编号 | 一句话 | 严重度 | 类别 |
| --- | --- | --- | --- |
| AP-01 | `router.register()` 省略第 4 参 ⇒ 端点匿名可调 | 严重 | 🔴 |
| AP-02 | 事件订阅者抛错 ⇒ 一次成功的保存变 500，重试写两遍 | 严重 | 🔴 |
| AP-03 | 插件编辑器不接 `onUploadFiles` ⇒ 拖拽 0 请求，甚至丢掉未保存正文 | 严重 | 🔴 |
| AP-04 | 绕过宿主越权闸门（无归属注册 / 试图渲染被抑制的 `replace`） | 严重（一律拒收） | 🔴 |
| AP-08 | 谎报 `geewiki.provides` ⇒ 依赖方 `ctx.get()` 拿到 `undefined` 后静默失效 | 严重 | 🟠 |
| AP-25 | 指望宿主做版本兼容校验（它不做） | 高 | 🔵 |
| AP-14 | 相对 `GEEWIKI_PLUGINS_DIR` / 把空 `./config` 挂进容器 ⇒ 静默重启循环 | 高 | 🟠 |
| AP-15 | 脚手架的 `dist/` 被仓库根 `.gitignore` 忽略 ⇒ 干净检出后界面消失 | 高 | 🟠 |
| AP-05 | 把 `geewiki.permissions` 当安全边界 | 高 | 🔴 |
| AP-06 | 把 `RequestHook` 当全局鉴权层 | 高 | 🔴 |
| AP-07 | 密钥放普通 config 字段（会被明文回显）/ 私有端点写进提交 | 高 | 🔴 |
| AP-09 | `geewiki.slots` 与 bundle 里 `registerSlot()` 不一致 ⇒ 静默空白 | 高 | 🟠 |
| AP-10 | `geewiki.routes` 与 `registerRoute()` 不一致（两个方向都会坏） | 高 | 🟠 |
| AP-17 | `apply()` 里 `await` 外部 I/O ⇒ `load_timeout` 504，且 `fiber.config` 已被改写 | 高 | 🟡 |
| AP-18 | `provide()` 之前先 `ctx.plugin()` 创建子插件 ⇒ 时序陷阱（静默 `undefined`） | 高 | 🟡 |
| AP-19 | 不保存/不调用注册函数返回的注销函数（ESM 实例永不回收） | 高 | 🟡 |
| AP-21 | bundle 自带 `react` / `react-dom` | 高 | 🟣 |
| AP-11 | `capabilities` 声明了却不注册求解器 ⇒ 恒 `false` | 中 | 🟠 |
| AP-12 | 自定义扩展点名漏 `/`、或用了该节点不允许的模式 ⇒ 忽略并告警 | 中 | 🟠 |
| AP-13 | `geewiki.manifest.json` 无法承载 `configSchema` ⇒ 配置零校验 | 中 | 🟠 |
| AP-16 | 长连接不 `trackStream(res, owner)` ⇒ 逃逸定向回收 | 中 | 🟠 |
| AP-20 | 插件 CSS 全局注入、无隔离 ⇒ 一个插件改全站样式 | 中 | 🟣 |
| AP-22 | portal 类 `ui-*` 节点用 `wrap` ⇒ 必然静默失效 | 中 | 🟣 |
| AP-23 | 容器节点 `replace` 想删掉别人的贡献 / 在 Shadow Root 里搬挂载点 | 中 | 🟣 |
| AP-24 | `clientTools` 存成快照 / 工具名两侧不配对 | 中 | 🟣 |
| AP-26 | REST 路径里插件名不做 `encodeURIComponent` | 中 | 🔵 |

提交前请过 [`review-checklist.md`](review-checklist.md)；AP-04、AP-08、以及"依赖 server 内部实现"三项属于**一律拒收**。

---

## A 组 · 🔴 默认不安全类（fail-open）

### AP-01 `router.register()` 省略第 4 个参数 ⇒ 匿名可调

❌ 禁止

```ts
// 这样写，端点默认 access: 'public'，任何匿名访客都能调
const unregister = router.register('GET', '/api/my-note', (h) => {
  h.json(200, { items: [] })
})
```

✅ 正确

```ts
const unregister = router.register(
  'GET',
  '/api/my-note',
  async (h) => {
    // access 只回答"至少是什么身份"，逐对象判定仍要你自己做
    const principal = h.principal
    if (!principal || principal.kind === 'anonymous') {
      h.json(401, { ok: false, error: 'unauthorized', message: '需要登录' })
      return
    }
    h.json(200, { items: [] })
  },
  { access: 'user', owner: '@geewiki-plugin/my-note' }, // ★ 第 4 参 + 归因
)
```

**为什么**：`RouteAccess` 的取值是 `'public' | 'user' | 'admin'`，而 **`'public'` 是默认值**——`RouteAccessOptions` 的注释原文是"省略等价于 `{ access: 'public' }`"。这是 fail-open：忘记思考 = 公开。宿主只做**事后审计**（`unauditedRoutes()` 挑出 `explicit === false` 的路由，启动时聚合成**一条**告警；`GEEWIKI_STRICT_ROUTE_ACCESS=1` 时直接拒启），不会替你堵口。审计判据是 `HttpRouteInfo.explicit`——它区分的正是"作者写了 `access:'public'`"与"作者什么都没写"。

同时声明 `owner`：`HttpRouterService.ownerStats?()` 只统计登记了 `owner` 的路由，出问题时运维才能定位到你，而不是"未归因"。

> ⚠️ **本仓库的示例代码自身违规**：脚手架模板（`packages/manager/src/scaffold.ts`）生成的调用是 `router.register('GET', '/api/<name>', handler)`——因为模板里手写的 `RouterLike` 接口**只声明了 3 个形参**，写作者照着接口写就永远传不出第 4 参。`plugins/ui-demo/src/index.ts` 与 `plugins/hello-geewiki/index.ts` 同样是 3 参。也就是说：`pnpm run new:plugin` 生成的第一个端点就是匿名可调的。**照抄示例前先改掉这一处**；把默认改成 fail-closed 属于平台待办（台账见 `docs/agent/backlog.md`，该文件由并行任务落地，若尚不存在请以 `docs/plugin-platform.md` §5.1 的安全表为准）。

**权威出处**：`packages/core/src/index.ts` 的 `RouteAccess` / `RouteAccessOptions` / `HttpRouterService.register` / `HttpRouteInfo.explicit` / `unauditedRoutes`；`packages/manager/src/scaffold.ts` 的模板字符串与 `RouterLike`。

### AP-02 事件订阅者抛错 ⇒ 一次成功的保存变成 500

❌ 禁止

```ts
ctx.on(PAGE_SAVED_EVENT, async (event) => {
  await fetch('https://api.example.com/v1/embed', { method: 'POST', body: event.slug })
})
```

✅ 正确

```ts
const off = ctx.on(PAGE_SAVED_EVENT, (event) => {
  // ① 同步广播：不得 await；② 任何异常必须自己吞掉
  void (async () => {
    try {
      await enqueue(event)
    } catch (err) {
      ctx.logger?.warn(`[my-note] 索引失败：${(err as Error).message}`)
    }
  })()
})
```

**为什么**：cordis 的 `emit()` 是**同步派发且没有 per-listener 保护**——你的订阅者抛错会顺着 `ctx.emit` 冒回**发起端点**。后果不是"我的后台任务失败了"，而是"用户点保存，得到 500，可内容已经写进库了；用户再点一次就写了两遍"。此外 `await` 会把发起方的响应时间拖到你的外部调用上。平台侧的三条铁律（对所有订阅者成立）：一律同步广播不等待（`ctx.parallel` 只用于 `CACHE_PURGE_EVENT`）、订阅者必须自己吞异常并自行调度异步、**负载里不放正文与凭据**（事件是广播，要正文拿 `slug` 走 `wiki-service` 带主体读）。注意自动保存会让事件很密集，**平台不做去抖**。

**权威出处**：`packages/core/src/cordis-env.ts`（`Context.emit` / `Context.parallel` 声明与注释）、`packages/core/src/index.ts` 的 `PAGE_SAVED_EVENT` / `PageSavedEvent` 注释；`docs/plugin-platform.md` §2.1。

### AP-03 插件编辑器不接附件上传 ⇒ 拖文件 0 请求，甚至丢未保存正文

❌ 禁止

```tsx
// 占住单占用的 editor 插槽，却完全不处理 drop / paste
function MyEditor(props: EditorSlotProps) {
  return <textarea value={props.value} onChange={(e) => props.onChange(e.target.value)} />
}
// manifest: { extensions: [{ node: 'editor', mode: 'replace' }] }
```

✅ 正确

```tsx
function MyEditor(props: EditorSlotProps) {
  const canUpload = props.onUploadFiles !== undefined // 能力缺失用 undefined 表达，不是空函数
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault() // 不拦的话浏览器会导航到该文件，未保存正文一起没了
    if (!canUpload) return
    const snippet = await props.onUploadFiles!([...e.dataTransfer.files]) // 返回可直接插入的 Markdown 片段
    props.onEditorHandle?.({ /* … */ }) // 或直接拼进 onChange
  }
  return <textarea onDrop={onDrop} onPaste={onPaste} /* … */ />
}
```

**为什么**：`editor` 是**单占用**插槽——你一占住，内置编辑器根本不渲染。附件上传通道是宿主给的 `EditorSlotProps.onUploadFiles?(files: File[]): Promise<string[]>`；不接它，用户拖入/粘贴文件时**一个请求都不会发**，只会看到宿主兜底的提示（`EDITOR_SLOT_NO_UPLOAD_HINT`，内容是"当前编辑器由插件提供，它没有插入附件的能力……"）。宿主的兜底还包括 `preventDefault()` 拦住默认拖放动作（不拦就是一次浏览器导航，未保存的正文随之丢失），而**当插件自己已经 `preventDefault` 时宿主保持沉默**。
另外两条硬约束：`editor` 只允许 `extend`/`wrap`/`replace`，`replace` 会让无障碍责任整个转移给你；替换默认编辑器在管理台上必须是**使用者显式决定**（内置 `@geewiki/editor-plain` 就是"已注册但刻意不写进默认基础层"的例子）。

> ⚠️ **口径腐化提示**：`packages/server/src/index.ts` 的注册表注释与 `packages/web/src/lib/slots.tsx` 的注释里仍写着"`EditorSlotProps` 不含上传字段、内置编辑器独占上传"。这与类型定义不符（`onUploadFiles?` 确实存在），也与 `packages/web/src/pages/WikiPage.tsx` 不符（`EditorSlotOutlet` 与内置 `MarkdownEditor` 传的是同一个 `uploadFiles`）。以类型与本条为准；注释待修。

**权威出处**：`packages/core/src/index.ts` 的 `EditorSlotProps` / `EditorHandle`、`packages/core/src/slots.ts` 的 `SLOT_CARDINALITY`、`packages/web/src/lib/slots.tsx` 的 `EDITOR_SLOT_NO_UPLOAD_HINT` 与 `EditorSlotOutlet`。

### AP-04 绕过宿主越权闸门

❌ 禁止

```ts
// 把宿主的全局 SDK 存起来，跨插件/跨模块用 ⇒ 注册来源不再是"你"
const g = (globalThis as any).__GEEWIKI_GLOBAL_HOST__
g.registerExtension('ui-button', MyButton, { mode: 'replace' })

// 或者：发现"我注册了却没出现"，于是自己去 DOM 里把节点替换掉
document.querySelector('.app-header')?.insertAdjacentHTML('beforeend', myHtml)
```

✅ 正确

```ts
export function register(host) {
  // host 就是作用域宿主（PluginUiHost）：注册自动带上 host.pluginName，并过仲裁闸门
  const undoSlot = host.registerSlot('app-footer', FooterNote)
  const undoExt = host.registerExtension?.('shell-brand-text', BrandBadge, { mode: 'wrap' })
  return () => { undoSlot(); undoExt?.() }
}
```

**为什么**：`replace`/`wrap` 是**全局单占用**节点，归属由后端裁决（`modeCardinalityOf()` 让 replace/wrap 恒为 `'single'`，多方声明按激活顺序最早者胜出，其余进 `suppressed`）。前端的**两道闸门**在 `packages/web/src/lib/pluginUi.ts`：① 权威判据是 `GET /api/plugins/slots` 返回的 `suppressed`（被抑制者仍然是 `active`、bundle 照样加载，所以"已激活"不等于"该生效"）；② 次判据是入口表的生效集合（`meta.slots ∪ meta.extNodes`，逐字段判）。被拒绝的贡献**不抛错**——别用"我没看到 UI"推断闸门坏了。
`0.12.0` 起，加载期间 `window.__GEEWIKI_HOST__` **就是**按插件作用域的宿主（在此之前顶层拿到的是全局 SDK，来源恒为 `'host-sdk'`，其后果是"收不回 + 绕过闸门"，两者皆静默）。所以顶层形态和 `register(host)` 现在归属一致——你没有任何理由去够全局那份。直接操作宿主 DOM 塞东西同理：绕开了归属，插件卸载时**没有出口**，也一律拒收。

**权威出处**：`packages/web/src/lib/pluginUi.ts` 的 `PluginUiHost` / `createPluginUiHost` / `installPluginScope`；`packages/core/src/extensions.ts` 的 `modeCardinalityOf`；`packages/web/src/lib/hostSdk.ts` 的 `HOST_SDK_VERSION` 版本注记。

### AP-05 把 `geewiki.permissions` 当安全边界

❌ 禁止

```jsonc
{ "geewiki": { "permissions": ["net"], "configSchema": { "endpoint": "https://api.example.com/v1" } } }
// 然后认为："我声明了 net，所以宿主会管我；没声明 fs:read 的插件也读不到文件"
```

✅ 正确

```jsonc
{
  "geewiki": {
    // 诚实清单：你实际会做什么就写什么，宿主不拦，但管理台与评审会看
    "permissions": ["net", "env"],
    "description": "调用外部 embedding 接口为页面建索引（出站 + 读取 OPENAI_API_KEY）"
  }
}
```

**为什么**：`PluginPermission` 全集是 `fs:read | fs:write | env | net | process | secrets`（`PLUGIN_PERMISSIONS` 的数组顺序**就是危险度升序**，注意 `fs:write` 排在 `net` 之后——那是刻意的展示顺序，别顺手"修正"）。宿主的处理方式只有三件事：写进清单、在管理台和 `GET /api/plugins` 的 `PluginSnapshot.permissions` 里可见、激活时打印一行。**没有拦截、没有沙箱、没有资源配额**；未知取值只 `console.warn` 并忽略（不阻断激活）。插件与宿主**同进程同权限**，所以"我没声明 `fs:read`"既不阻止你读文件，也不构成对别人的保护。这条与"安全可控"的张力已在 `docs/plugin-platform.md` §5.1 登记为现状。
服务依赖请写 `requires`，不要塞进 `permissions`——后者是跨界声明，前者是依赖图。

**权威出处**：`packages/core/src/domain.ts` 的 `PluginPermission` / `PLUGIN_PERMISSIONS` / `sortPermissions`；`packages/manager/src/index.ts` 的 `readPluginPermissions`（未知项告警）、`PluginSnapshot.permissions` 注释。

### AP-06 把 `RequestHook` 当全局鉴权层

❌ 禁止

```ts
// 以为这样就能"兜住"自己忘记写 access 的路由
router.use(async ({ url }) => {
  if (url.pathname.startsWith('/api/my-note')) return requireLogin()
  return { ok: true }
})
```

✅ 正确

```ts
// 每条路由显式声明；钩子只负责它契约内的事（身份解析/全局策略）
router.register('GET', '/api/my-note', handler, { access: 'user', owner: '@geewiki-plugin/my-note' })
```

**为什么**：`RequestHook` **只对匹配到的路由执行**——未匹配的 `/api/*`、静态资源、SPA fallback 完全不过钩子。用它兜鉴权会造出一个更危险的假象："我加了全局钩子，所以安全"。它的契约也限制得很死：钩子串行执行、任一 `{ok:false}` 短路；**不得自己写响应**（只返回裁决）；抛错视同 500（不要用抛错表达拒绝）；返回值形态非法一律按**拒绝**处理。裁决类型 `RequestVerdict` 只允许 `401 | 403 | 503`。
另：`owner` 字段是**可观测性字段，不是安全边界**，别拿它做授权。

**权威出处**：`packages/core/src/index.ts` 的 `RequestHook` / `RequestVerdict` / `HttpRouterService.use` / `RouteAccessOptions.owner`。

### AP-07 密钥放普通 config 字段 / 私有端点写进提交

❌ 禁止

```jsonc
// config/plugins.base.json（会被复制、会被粘贴排障、会进备份）
{ "name": "@geewiki-plugin/my-note", "config": { "apiKey": "sk-live-…", "baseUrl": "https://example.com/llm/v1" } }
```

✅ 正确

```jsonc
// 配置里只放"变量名"或交给 role:'secret' 字段（落盘在 config/secrets.json，已被 .gitignore 忽略）
{ "name": "@geewiki-plugin/my-note", "config": { "apiKeyEnv": "MY_NOTE_API_KEY", "baseUrl": "https://api.example.com/v1" } }
```

**为什么**：`GET /api/plugins/:name/config` 对**普通字段明文返回**（`docs/plugin-platform.md` §5.1 的 L-20），`redact()` 是启发式的、且刻意不脱敏模型输出。密钥的正确出路有两条：只存环境变量名（`@geewiki/llm` 的 `apiKeyEnv` 就是这个范式），或在 `configSchema` 里把字段标成 `role: 'secret'`（写一次、不可回读，落 `config/secrets.json`，见 `packages/manager/src/secrets.ts` 文件头——它存在的原因正是"清单是被复制出去的东西"，历史上 `.dockerignore` 只排了 `plugins.session.json`，结果 `secrets.json` 被 `COPY config` 打进镜像层，已用探测构建实测）。
私有端点/私有模型名同理：`config/plugins.base.example.json` 里 `@geewiki/llm` 目前硬编码了一个私有端点与模型名，这与"不绑厂商"冲突，**不要沿用**；本系列文档与你的插件一律用 `https://api.example.com/v1` 这类占位符。

**权威出处**：`packages/manager/src/secrets.ts`（文件头）、`packages/manager/src/index.ts` 的 `configOf` / `secretFieldsOf` / `hydrateSecrets`；`docs/plugin-platform.md` §5.1（L-20）。

---

## B 组 · 🟠 静默失败类（不报错的空白与失效）

### AP-08 谎报 `geewiki.provides`

❌ 禁止

```jsonc
{ "geewiki": { "provides": "my-note-service", "requires": ["http-service"] } }
// 而 apply() 里只注册了路由，从来没有 ctx.provide('my-note-service', …)
```

✅ 正确

```jsonc
// 二选一：
// (a) 不对外提供服务 ⇒ 干脆不写 provides
{ "geewiki": { "requires": ["http-service"] } }
// (b) 确实提供 ⇒ 名字必须与 provide 的 token 完全一致，并在清理函数里注销
{ "geewiki": { "provides": "my-note-service" } }
```
```ts
export function apply(ctx, config) {
  const router = ctx.get('http')
  if (!router) throw new Error('@geewiki-plugin/my-note 需要 http 服务')
  const unreg = router.register('GET', '/api/my-note', handler, { access: 'user', owner: '@geewiki-plugin/my-note' })
  const unprovide = ctx.provide('my-note-service', service) // ★ 与 provides 同名
  return () => { unprovide(); unreg() }
}
```

**为什么**：`provides` **只是依赖图谱里的 token，不会创建任何 cordis 服务**。谎报之后，任何 `requires: ['my-note-service']` 的插件都会被解析成"依赖已满足"，然后 `ctx.get('my-note-service')` 拿到 `undefined` 并**静默跳过**——功能不可用，全程不报错。正确范式是"先补 `ctx.provide(...)` + 注销 + 导出契约类型，**再**恢复 `provides`"，参考 `packages/plugin-search/src/index.ts` 的 `ctx.provide('search-service', svc)`。

> ⚠️ **本仓库的示例代码自身违规（已核实）**：`plugins/ui-demo/package.json` 声明 `"provides": "ui-demo-service"`，而 `plugins/ui-demo/src/index.ts` 里**没有任何 `ctx.provide` 调用**（该文件唯一提到 `provide` 的地方是一句注释，讲的是 `@geewiki/http` 提供 `'http'`）；脚手架模板 `packages/manager/src/scaffold.ts` 生成的清单同样带 `provides: "<name>-service"` 而模板代码里不 `provide`。**正确做法请看 `packages/plugin-echo/src/index.ts`**：它曾经声明 `provides: 'echo-service'`，后来**刻意撤销**，注释里把"谎报的 token"这个后果写得很清楚。所以照抄 `ui-demo` / 脚手架清单时会继承这个反模式——照抄前请把 `provides` 删掉，或补上 `provide`。

**权威出处**：`packages/plugin-echo/src/index.ts`（撤销 provides 的注记）、`packages/plugin-search/src/index.ts` 的 `apply`、`packages/core/src/index.ts` 的 `GeeWikiMeta.provides`。

### AP-09 `geewiki.slots` 与 bundle 里的 `registerSlot()` 不一致

❌ 禁止

```jsonc
{ "geewiki": { "client": { "entry": "client.js" }, "slots": ["app-footer"] } }
```
```ts
export function register(host) {
  return host.registerSlot('app-header', Note) // 清单写的是 app-footer ⇒ 什么都不出现
}
```

✅ 正确

```bash
# 提交前自查三件套
curl -s localhost:3000/api/plugins/ui    | jq '.entries[] | select(.name=="@geewiki-plugin/my-note")'
curl -s localhost:3000/api/plugins/slots | jq '.slots[] | select(.owner=="@geewiki-plugin/my-note")'
curl -s localhost:3000/api/plugins       | jq '.issues'   # 发现期失败也在这里
```

**为什么**：入口表（`GET /api/plugins/ui`）是按清单字段决定加载与归属的，而实际渲染看的是 bundle 运行期注册到了哪个插槽。两边不一致**不会报错**：清单声明的那格是空的，你实际注册的那格因为不在生效集合里被闸门拦掉。自查方法：`GET /api/plugins/slots` 的 `slots`（`SlotAssignment`，含 `suppressed`）里应当出现你的插件名与目标插槽；`GET /api/plugins/ui` 的 `entries`/`skipped` 里应当能看到你的插件与它声明的 `slots`。同一份信息在管理台的插槽/冲突视图里也可见。

**权威出处**：`packages/manager/src/index.ts` 的 `slotAssignments` / `registerManifestSlots` / REST `GET /api/plugins/slots` 与 `GET /api/plugins/ui`；`packages/core/src/slots.ts` 的 `SLOT_NAMES`；`packages/core/src/index.ts` 的 `GeeWikiMeta.slots`。

### AP-10 `geewiki.routes` 与 `registerRoute()` 不一致（两个方向都会坏）

❌ 禁止

```ts
// 方向一：只注册不声明
host.registerRoute('dashboard', Dashboard)   // 清单 geewiki.routes 里没有 'dashboard'
```
```jsonc
// 方向二：只声明不注册
{ "geewiki": { "routes": [{ "id": "dashboard", "label": "看板", "group": "main" }] } }
// 而 bundle 里没有 host.registerRoute('dashboard', …)
```

✅ 正确

```jsonc
{ "geewiki": { "routes": [{ "id": "dashboard", "label": "看板", "group": "main", "order": 20, "requires": "my-note:read" }] } }
```
```ts
export function register(host) {
  const undo = host.registerRoute('dashboard', Dashboard) // id 与清单逐字一致
  return () => undo()
}
```

**为什么**：方向一是**冷启动直访 `#/<id>` 一片空白且不报错**——入口表靠清单声明把产物标为"不可推迟"；通过 `register(host)` 注册未声明的 id 会被宿主拒绝并告警，但用全局 SDK 注册就绕过检查（责任在插件）。方向二是渲染一个"插件页面未就绪"的占位并告警（**不是** notfound，所以你不会在路由层看到异常）。
另外三条：`label` 与 `group` **必须同时给出**才会出现导航项；`order` 缺省 `100`（排在宿主内置项之后）；`requires` 不填表示对所有访问者可见（含未登录）。id 语法是 `PLUGIN_ROUTE_ID = /^[a-z][a-z0-9-]*$/`（不含 `/`），且 `RESERVED_ROUTE_IDS` 里的 id 是**直接拒绝**而不是先到先得。

**权威出处**：`packages/web/src/lib/hostSdk.ts` 的 `registerRoute`；`packages/core/src/domain.ts` 的 `PLUGIN_ROUTE_ID` / `RESERVED_ROUTE_IDS`；`packages/core/src/index.ts` 的 `PluginRouteDecl`；`docs/plugin-platform.md` §4.1。

### AP-11 `capabilities` 声明了却不注册求解器

❌ 禁止

```jsonc
{ "geewiki": { "capabilities": [{ "name": "my-note:read", "label": "阅读笔记" }] } }
// 然后就等导航项/按钮自己出现
```

✅ 正确

```ts
const capsvc = ctx.get('capability-service')
const unreg = capsvc.provide({ name: 'my-note:read', resolve: ({ principal }) => principal.kind !== 'anonymous' })
// 并在清理函数里注销；配套路由：router.register('GET','/api/my-note', h, { access: 'user', capability: 'my-note:read' })
```

**为什么**：清单里的 `capabilities` 只是**声明**，判定逻辑必须由 `capability-service` 的求解器提供。缺求解器时该能力恒为 `false`，于是依赖它的导航项**永不出现**、`access`+`capability` 的路由恒被拒——管理器只在激活后打一条告警，界面上没有任何提示。`CapabilitySet` 的语义是"缺失即不具备"（必须 `=== true`）。插件自定义能力名必须含 `/` 或 `:`（`PLUGIN_CAPABILITY_NAME` 要求分段小写 kebab）。

**权威出处**：`packages/manager/src/capabilities.ts`、`packages/manager/src/capability-plugin.ts`（`CAPABILITY_SERVICE_NAME`）、`packages/core/src/domain.ts` 的 `PLUGIN_CAPABILITY_NAME` / `CapabilitySet`；`packages/core/src/services.ts` 的能力注册表契约。

### AP-12 自定义扩展点名漏 `/`，或用了该节点不允许的模式

❌ 禁止

```jsonc
{ "geewiki": { "extensions": [{ "node": "my-note-panel", "mode": "replace" }] } }        // 缺 / ⇒ 被当成笔误
{ "geewiki": { "extensions": [{ "node": "app-header", "mode": "replace" }] } }           // 该节点只允许 extend
{ "geewiki": { "slots": ["app-headr"] } }                                                // 笔误
```

✅ 正确

```jsonc
{
  "geewiki": {
    "extensions": [
      { "node": "my-note/panel", "mode": "extend" },  // 自定义扩展点：必须含 /，且只允许 extend
      { "node": "wiki-meta", "mode": "wrap" },        // 宿主节点：查模式目录后再写
      { "node": "app-header", "mode": "extend" }
    ]
  }
}
```

**为什么**：判据是**目录成员资格**，不是模糊匹配。`PLUGIN_SLOT_NAME` 要求至少一个 `/`；不含 `/` 又不在 `SLOT_NAMES` 里的名字被当作**笔误直接拒绝**（这样宿主才能区分"你想用一个新扩展点"和"你打错了 app-header"）。各节点允许的模式来自 `HOST_NODE_CATALOG`（`extModesOf()` 对未知节点返回 `[]`，`supportsExtMode()` 判具体模式）；**插件自定义扩展点只允许 `extend`**（`PLUGIN_ONLY_MODES`），宿主不为别人的扩展点背书 `replace`/`wrap`。
处理方式是 **忽略 + 告警，不阻断激活**——所以插件照样 `active`，只是你那块 UI 永远不出现。

**权威出处**：`packages/core/src/slots.ts` 的 `SLOT_NAMES` / `PLUGIN_SLOT_NAME` / `slotCardinalityOf`；`packages/core/src/extensions.ts` 的 `HOST_NODE_CATALOG` / `extModesOf` / `supportsExtMode` / `PLUGIN_ONLY_MODES`；`packages/manager/src/index.ts` 的 `registerManifestSlots`。

### AP-13 `geewiki.manifest.json` 承载不了 `configSchema`

❌ 禁止

```jsonc
// geewiki.manifest.json —— 想在这里放 configSchema
{ "geewiki": { "name": "my-note", "configSchema": { "limit": { "type": "number" } } } }
// 然后在插件里假定 config.limit 一定是 number
```

✅ 正确

```jsonc
// 需要结构化配置校验 ⇒ 用 package.json 的 geewiki 键（JSON 里塞不进 schemastery 实例）
{ "name": "@geewiki-plugin/my-note", "geewiki": { "name": "my-note", "configSchema": "<需要 TS 侧构造 schema 实例>" } }
```
```ts
// 拿不到 schema 校验时，插件自己兜住：非法值回退默认并在 apply 里告警
const limit = Number.isInteger(config.limit) && (config.limit as number) > 0 ? (config.limit as number) : 20
```

**为什么**：`configSchema` 的类型是 `ConfigSchema = ReturnType<typeof Schema.any>`，即**必须是 schemastery 实例**（`packages/plugin-wiki/src/index.ts` 的 `WikiConfigFields` 是范例）。JSON 文件只能表达字面量，表达不了实例，所以 `geewiki.manifest.json` 这条路**结构上无法承载 configSchema**。后果不是报错而是**退化**：管理台渲染成 JSON 原文编辑框、零校验，任何非法值都会原样送进你的 `apply(ctx, config)`。
规避顺序：需要校验 → 用 `package.json`（清单两种来源里 `package.json#geewiki` 优先）；不能校验 → 自己做防御式解析 + 在 README 里写清可填字段；`PluginSnapshot.configurable` 为 `false` 就是这个状态的机器可读信号。

**权威出处**：`packages/core/src/index.ts` 的 `ConfigSchema` / `GeeWikiMeta.configSchema`；`packages/manager/src/discovery.ts` 的 `parsePluginManifest`；`packages/manager/src/index.ts` 的 `configSchemaOf` / `PluginSnapshot.configurable`。

### AP-14 相对 `GEEWIKI_PLUGINS_DIR` / 把空 `./config` 挂进容器

❌ 禁止

```bash
# 部署（容器里没有 pnpm-workspace.yaml）
export GEEWIKI_PLUGINS_DIR=plugins                       # 相对路径 ⇒ 指向 process.cwd()
docker run -w /srv/app -v ./config:/app/config geewiki   # 宿主 config 是空目录
```

✅ 正确

```bash
export GEEWIKI_PLUGINS_DIR=/app/plugins                  # 绝对路径
# 首次部署前确保挂载目录里至少有一份基础清单
cp config/plugins.base.example.json ./config/plugins.base.json
docker compose up -d
curl -s localhost:3000/api/health | jq '.ok and .db.present'   # HEALTHCHECK 用的就是这个判据
```

**为什么**：两条都是**静默**的。① 相对路径经 `resolveProjectPath()` 解析，识别标记是仓库根存在 `pnpm-workspace.yaml`；部署树里没有它 ⇒ 回退 `process.cwd()` ⇒ 任何覆盖 WORKDIR 的启动方式（`docker run -w`、自定义 entrypoint）都会让插件发现指向别处——**不报错、0 个插件**（`Dockerfile` 里把 `GEEWIKI_PLUGINS_DIR` 写死成 `/app/plugins` 就是这个原因；开发树里相对路径倒是可用的，因为它以仓库根为基准）。② 挂载会**覆盖**镜像里的模板：宿主 `config/` 为空 ⇒ 读到空清单 ⇒ 没有任何插件被激活 ⇒ **HTTP 根本不监听** ⇒ `restart: unless-stopped` 变成静默重启循环。注意镜像**只 COPY `plugins.base.example.json`**（绝不 COPY 整个 `config/`，历史上那样做过，把 `secrets.json` 打进了镜像层）。
排障时先分辨"镜像模板 / 容器可写层 / 挂载卷"三者是哪一份。

**权威出处**：`packages/core/src/index.ts` 的 `resolveProjectPath` / `findRepoRoot`；`packages/server/src/index.ts` 的 `main`（`GEEWIKI_PLUGINS_DIR` 解析与启动打印）；`Dockerfile` 的 runtime ENV 注释；`docker-compose.yml` 的挂载警告与 `HEALTHCHECK` 判据；`docs/plugin-platform.md` §5.3（L-12）。

### AP-15 脚手架的 `dist/` 被仓库根 `.gitignore` 忽略 ⇒ 干净检出后界面消失

❌ 禁止

```bash
pnpm run new:plugin my-note --ui
git add -A && git commit -m "feat(plugin): my-note"       # 直接提交，没管 dist/
# ……同事拉代码 / CI 干净检出 / git clean -fdx 之后：后端在，界面没了，无任何报错
```

✅ 正确

```gitignore
# 按 CLI 打印的两行加进 .gitignore（例外必须逐插件开，否则会把别人的真构建产物也纳进来）
!plugins/my-note/dist/
!plugins/my-note/dist/**
```
```bash
git check-ignore -v plugins/my-note/dist/client.js   # 无输出才算过关
```

**为什么**：仓库根 `.gitignore` 有全局 `dist/` 规则，而 UI 资产的根目录被 `packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiRoots` 硬编码为 `<插件目录>/dist`。于是"手写产物不入库"的情形被平台接受为正常状态——**它不会警告你**。现成例子：`git ls-files plugins` 显示两个示例插件的 UI 产物**都不在版本控制里**（`plugins/ui-demo/README.md` 自己也写着 `dist/` 是"生成物，不随仓库提交；由 build:fixtures 产出"），所以干净检出后必须先跑 `pnpm --filter @geewiki/web run build:fixtures`。`scaffold.ts` 的 `gitignoreLinesFor()` 会打印该加哪两行、生成的 README 也会提示，但**它不会替你改 `.gitignore`**。
同一族的构建期陷阱：内置插件的界面产物 `packages/web/dist/plugins-ui/@geewiki/**` 是生成物，必须在 `vite build` **之前**由 `build:builtin-ui`/`build:fixtures` 产出，否则镜像只有外壳、界面凭空消失（`Dockerfile` 里有一段构建期回归守卫来堵这个洞）。

**权威出处**：`packages/manager/src/scaffold.ts` 的 `gitignoreLinesFor`；`packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiRoots`；仓库根 `.gitignore`；`packages/web/package.json` 的 `build:fixtures`；`Dockerfile` 的构建期守卫。

### AP-16 长连接不 `trackStream(res, owner)`

❌ 禁止

```ts
router.register('POST', '/api/my-note/stream', (h) => {
  h.res.writeHead(200, { 'content-type': 'text/event-stream' })
  keepWritingForever(h.res)                 // 既没 trackStream，也没在自己的 dispose 里收流
}, { access: 'user', owner: '@geewiki-plugin/my-note' })
```

✅ 正确

```ts
router.register('POST', '/api/my-note/stream', (h) => {
  h.res.writeHead(200, { 'content-type': 'text/event-stream' })
  const untrack = router.trackStream?.(h.res, '@geewiki-plugin/my-note') ?? (() => {})
  h.noteStatus?.(200)                        // 只记指标，不结束响应
  keepWritingForever(h.res)
  untrack()                                  // 连接自己收尾时注销
}, { access: 'user', owner: '@geewiki-plugin/my-note' })
```

**为什么**：长连接**刻意不计入** `inflight()`/`pending()`（处理器应同步返回、当拍结算；若计入，卸载时 `drain()` 会一直等到连接关闭，必然空转满 `drainTimeout` 并打印**假的**"排空超时"告警——本仓库曾因同类归因错误稳定误报）。代价是：不登记 `owner` 的连接**无法被定向回收**，只能等路由服务整体关停——契约里把这写成"逃逸定向回收是显式后果，不是静默行为"。反向的坑也真实存在：把 SSE 当普通请求算进在途数，就会造出假告警。并发上限是**持有者的策略**，路由服务不参与判定，被拒时请调 `noteStreamRejected()` 让运维看得见。

**权威出处**：`packages/core/src/index.ts` 的 `HttpRouterService.trackStream` / `closeStreams` / `noteStreamRejected` / `pending`；`packages/manager/src/index.ts` 的 `closeOwnStreams`。

---

## C 组 · 🟡 生命周期与状态

### AP-17 `apply()` 里 `await` 外部 I/O

❌ 禁止

```ts
export async function apply(ctx, config) {
  const models = await fetch(`${config.baseUrl}/models`).then((r) => r.json()) // 启动期出站
  ctx.provide('my-note-service', makeService(models))
}
```

✅ 正确

```ts
export function apply(ctx, config) {
  const service = makeService()
  const unprovide = ctx.provide('my-note-service', service)
  void service.warmUp(config.baseUrl).catch((err) => ctx.logger?.warn(`[my-note] 预热失败：${err.message}`))
  return () => { service.close(); unprovide() }
}
```

**为什么**：`apply()` 有默认 **30 秒**超时（`normalizeRuntime` 的 `applyTimeout`，常量 `DEFAULT_APPLY_TIMEOUT_SECONDS = 30`）。超时抛 `ManagerError('load_timeout', …)` → HTTP **504**，并且管理器会**回收幽灵 fiber**（晚到的 promise 成功后主动 `dispose()`）。更糟的是状态：`fiber.update()` 的实测语义是"apply 抛错时错误向上传播、插件进 FAILED 态，**但 `fiber.config` 已经是新值**"——调用方要回滚必须再 `update(旧配置)`。
真需要慢启动时逃生口是 `runtime.applyTimeout`（`<= 0` = 不超时），但请先想清楚：`applyTimeout` 是兜底，不是给你排慢启动的额度。另注：迁移在 apply **之前**执行，不受本超时约束。

**权威出处**：`packages/core/src/index.ts` 的 `normalizeRuntime` / `GeeWikiRuntime.applyTimeout`；`packages/manager/src/index.ts` 的 `withApplyTimeout`（含"定时器刻意不 `unref()`"的原因）与错误映射；`packages/core/src/cordis-env.ts` 的 `FiberLike.update` 实测语义。

### AP-18 `provide()` 之前先 `ctx.plugin()` 创建子插件

❌ 禁止

```ts
export async function apply(ctx) {
  await ctx.plugin(ChildPlugin)          // 子插件在这时创建
  ctx.provide('my-note-service', svc)    // 太晚了：子插件在 apply 未结算期间看不到它
}
```

✅ 正确

```ts
export function apply(ctx) {
  const unprovide = ctx.provide('my-note-service', svc) // ① 先对外承诺能力
  void ctx.plugin(ChildPlugin)                          // ② 再创建子插件
  return () => { unprovide() }
}
```

或者：把服务做成**独立兄弟插件**并排在依赖它的所有插件之前——这正是 `slot` 与 `capability-service` 的做法（`packages/manager/src/slot-plugin.ts`、`packages/manager/src/capability-plugin.ts`；组合根里 `app.plugin(slotPlugin)` → `app.plugin(capabilityPlugin)` 都在管理器之前）。

**为什么**：某插件的 `apply` 尚未结算时，它 `provide` 的服务**对期间创建的子插件不可见**，对方的 `ctx.get(...)` 直接拿到 `undefined` 并**静默跳过**后续逻辑。这条时序陷阱在平台侧造成过的真实事故是：外部插件 `ctx.get('slot')` 得 `undefined`，其运行期插槽贡献整批丢失而无任何提示。`PLUGIN_ACTIVATED_EVENT`（apply 已结算 = provide 可见性解开的那一刻）是依赖方延迟绑定的正规触发点。

**权威出处**：`packages/manager/src/slot-plugin.ts` 与 `packages/manager/src/capability-plugin.ts`（文件头写明了"最初写在管理器 apply 里"为什么不行）；`packages/server/src/index.ts` 的装载次序；`packages/core/src/index.ts` 的 `PLUGIN_ACTIVATED_EVENT`；`docs/plugin-platform.md` §5.2。

### AP-19 不保存/不调用注册函数返回的注销函数

❌ 禁止

```ts
export function apply(ctx, config) {
  ctx.get('http').register('GET', '/api/my-note', handler, { access: 'user' }) // 返回值丢掉了
  ctx.on(PAGE_SAVED_EVENT, listener)                                           // 返回值丢掉了
  host.registerSlot('app-footer', Footer)                                      // 前端同理
  // 没有返回清理函数
}
```

✅ 正确

```ts
export function apply(ctx, config) {
  const unreg = ctx.get('http').register('GET', '/api/my-note', handler, { access: 'user', owner: '@geewiki-plugin/my-note' })
  const off = ctx.on(PAGE_SAVED_EVENT, listener)     // cordis on() 返回 () => boolean
  return () => { off(); unreg() }                    // 返回值就是卸载函数：必须返回它
}
```
```ts
export function register(host) {
  const token = host.registerSlot('app-footer', Footer)
  return () => host.unregisterSlot('app-footer', token) // ★ 传 token！
}
```

**为什么**：ESM **模块实例永不回收**（`docs/plugin-platform.md` §5.2），所以模块级状态、已注册的监听器、已挂的 DOM 都不会因为"热更新"而重置。你不注销，下一次加载就是重复注册（`registerTool` 重名直接抛错，`invokeTool` 命中谁看运气）。前端那条尤其危险：`unregisterSlot(name)` **不传 token 等于清空该插槽**，会把别的插件贡献一起删掉。
卸载顺序上，管理器统一出口在卸载单个插件时会：先按 `owner` 定向收掉该插件的长连接 → `slots.release(name)` 撤掉它的贡献 → 按 `runtime.drainTimeout` 排空在途请求（全站语义的 `HttpRouterService.drain`，**插件粒度的在途请求排空尚未实现**，见 `drainBeforeUnload` 的注释）→ 最后 `fiber.dispose()`。`drainTimeout <= 0` 表示跳过排空。默认值是 **5 秒**。

**权威出处**：`packages/core/src/cordis-env.ts`（`Context.on` 返回注销函数）；`packages/core/src/index.ts` 的 `GeeWikiRuntime.drainTimeout` / `HttpRouterService.drain`；`packages/manager/src/index.ts` 的 `unloadPlugin` / `drainBeforeUnload`（**私有方法**，不是公开 API）；`packages/web/src/lib/hostSdk.ts` 的 `unregisterSlot`。

---

## D 组 · 🟣 前端契约与样式

### AP-20 以为插件 CSS 有隔离

❌ 禁止

```css
/* client.css —— 直接命中宿主类名，全站遭殃 */
button { border-radius: 999px; }
.app-header { background: #000; }
```

✅ 正确

```css
/* ① 类名自带插件前缀 ② 作用域尽量收窄 ③ 只覆盖 --gw-* 原始 token（配色走 registerTheme） */
.gwmy-note-card { border-radius: 8px; }
```
```ts
host.registerExtension('ui-button', MyButton, { mode: 'replace', shadow: true }) // 需要强隔离时
```

**为什么**：插件 CSS 是**全局注入**的，宿主**不做样式隔离**——这是脚手架生成的 `dist/client.css` 注释里明写的口径。需要强隔离只有两条路：`replace` + `shadow`（`0.11.0` 起，**仅对 `replace` 有意义**；在 `wrap`/`extend` 上传 `shadow` 会被忽略并告警），或自己 `host.createRoot` 建 Shadow DOM（宿主**不代管卸载**，必须在清理函数里 `root.unmount()`）。配色请用 `registerTheme`，它**只允许覆盖 `--gw-*` 原始 token**，语义 token `--color-*` 会被拒绝。请在 README 里写清你的 CSS 影响面（`review-checklist.md` 的建议项）。

**权威出处**：`packages/manager/src/scaffold.ts` 生成的 `client.css` 注释；`packages/web/src/lib/hostSdk.ts` 的 `registerExtension`（`opts.shadow`）/ `createRoot` / `registerTheme`；`docs/plugin-platform.md` §4.9。

### AP-21 bundle 自带 `react` / `react-dom`

❌ 禁止

```bash
npm i react react-dom        # 在插件前端源码目录里装一份 React
```

✅ 正确

```ts
// 用宿主那一份；需要 React 时从 host 取，JSX 走宿主的 jsxRuntime
const { React } = host
export function register(host) {
  return host.registerSlot('app-footer', () => host.React.createElement('span', null, 'hi'))
}
```

**为什么**：宿主通过 import map 把 `react`、`react/jsx-runtime`、`react-dom` 映射到**宿主那一份实例**。两份 React 的典型现象是 `TypeError: Cannot read properties of null (reading 'useState')`，以及 portal 丢事件、错误边界失效——**报错点离病因很远**，看着像宿主 bug。`plugins/../fixtures` 里的 `CounterWidget` 存在的意义就是证明"与宿主共用同一 React 实例"这件事成立。宿主还直接提供 `ReactDOM`/`ReactDOMClient`/`createPortal`/`createRoot`/`hydrateRoot`（`0.6.0` 起），不需要你自己引。

**权威出处**：`packages/web/src/lib/hostSdk.ts` 的 `React` / `jsxRuntime` / `ReactDOM` / `ReactDOMClient`；`packages/web/fixtures/src/index.tsx` 的 `CounterWidget` 注释；`docs/plugin-platform.md` §4.5。

### AP-22 portal 类 `ui-*` 节点用 `wrap`

❌ 禁止

```jsonc
{ "geewiki": { "extensions": [{ "node": "ui-dialog-content", "mode": "wrap" }] } }
```

✅ 正确

```jsonc
{ "geewiki": { "extensions": [{ "node": "ui-dialog-content", "mode": "replace" }] } }  // portal 类只允许 extend|replace
```

**为什么**：`PORTAL_UI_MODES = ['extend', 'replace']`，**不含 `wrap`**——portal 渲染出来的内容不在"被包装元素"的子树里，`wrap` 结构上必然静默失效（你包住的是一段空壳）。四个 portal 类节点是 `ui-dialog-content`、`ui-dropdown-menu-content`、`ui-confirm-dialog`、`ui-tooltip`，目录里有守卫断言"标了 portal 的节点不得含 wrap"。写扩展点前先查 `extModesOf(node)`。

**权威出处**：`packages/core/src/extensions.ts` 的 `PORTAL_UI_MODES` / `HOST_NODE_CATALOG` / `extModesOf`。

### AP-23 容器节点 `replace` 想删掉别人的贡献 / 在 Shadow Root 里搬挂载点

❌ 禁止

```tsx
// 以为 replace 掉 shell-header 就能把别人的 app-header 贡献清空
function MyShellHeader() { return <header>只有我</header> }
host.registerExtension('shell-header', MyShellHeader, { mode: 'replace' })

// 或者把自己的 Shadow DOM 里的一个 div 当成挂载点往外搬
host.registerExtension('shell-footer', (props) => <div ref={(el) => mountInto(myShadowEl, props.slots['app-footer'])} />)
```

✅ 正确

```tsx
// 保留宿主的 <header> 外壳与内层插槽出口，用 props.slots 搬运（宿主在绘制前 portal 过去）
function MyHeaderChrome(props) {
  return <div className="gwmy-note-chrome">{props.slots['app-header']}</div>
}
host.registerExtension('shell-header', MyHeaderChrome, { mode: 'wrap' })
```

**为什么**：`shell-header`/`shell-footer` 的 `<header>`/`<footer class="app-footer">` 外壳、以及内层 `app-header`/`app-footer` 出口**由宿主独占**，`replace` 删不掉其他插件的贡献（`nestedSlots` 声明了 `shell-header → ['app-header']`、`shell-footer → ['app-footer']`）。搬运通道是 `props.slots[插槽名]`（`display: contents` 挂载点），**落在 Shadow Root 内的挂载点会被忽略并告警一次**（判据 `isUsableMountTarget`）。
另注意宿主节点 id **一律不含 `/`**——所以没有 `shell-sidebar` 这个节点（宿主外壳里没这个元素，登记它就是静默失败）。

**权威出处**：`packages/core/src/extensions.ts` 的 `nestedSlots` / `nestedSlotsOf`；`packages/web/src/lib/slots.tsx` 的 `isUsableMountTarget`；`packages/web/src/lib/hostSdk.ts` 的 `registerExtension` 注释。

### AP-24 `clientTools` 存成快照 / 工具名两侧不配对

❌ 禁止

```ts
const tools = host.clientTools          // 存成快照 ⇒ 永远读到空数组（静默）
host.registerTool('summarize', fn)      // 服务端没有同名 side:'client' 声明 ⇒ 模型永远看不到它
```

✅ 正确

```ts
export function register(host) {
  const undo = host.registerTool('my-note:summarize', async (args) => ({ text: '…' }))
  const render = (props: AppDockSlotProps) => props.clientTools.includes('my-note:summarize') // 每次现读
  return () => undo()
}
```

**为什么**：`clientTools` 是 **getter**（且已排序以命中上游前缀缓存），把它拷一份出来就冻结在加载那一刻——插件**永远**看到空数组且不报错。工具名必须与服务端 `ai-tool-service` 里 `side: 'client'` 的同名声明配对，因为"客户端可调用集只能收窄不能扩权"；`registerTool` 重名**抛错**（不静默覆盖），`invokeTool` 未登记名字也是**抛错**而非返回 `undefined`。纯客户端工具的正规参考实现是"服务端只描述符、执行体在浏览器"：`@geewiki/ai-writing` / `@geewiki/ai-nav` 声明 `side: 'client'`，执行体在 `packages/web/src/lib/editorTools.ts`、`packages/web/src/lib/navTools.ts`。

**权威出处**：`packages/web/src/lib/hostSdk.ts` 的 `clientTools` / `registerTool` / `invokeTool`；`packages/web/src/lib/editorTools.ts`、`packages/web/src/lib/navTools.ts`。

---

## E 组 · 🔵 兼容与卫生

### AP-25 指望宿主做版本兼容校验

❌ 禁止

```jsonc
{ "name": "my-note", "version": "2.0.0", "geewiki": { "minGeewikiVersion": "0.6" } }
// 然后认为：老宿主会拒绝加载这个插件
```

✅ 正确

```ts
export function register(host) {
  const undos: Array<() => void> = []
  // ① 能力探测，而不是比版本号
  undos.push(host.registerSlot('app-footer', Footer))
  undos.push(host.registerExtension?.('shell-brand-text', Badge, { mode: 'wrap' }) ?? (() => {}))
  const html = host.renderMarkdown ? host.render(md) : `<pre>${escapeHtml(md)}</pre>` // 缺能力时优雅降级
  return () => undos.forEach((f) => f())
}
```

**为什么**：清单只有用于**展示**的 `version` 字段，宿主**不做最低版本判断、没有 semver 范围**（对照业界：VS Code 的 `engines.vscode`、Obsidian 的 `minAppVersion` + `versions.json`——本项目都没有）。写一个不存在的字段（如 `minGeewikiVersion`）不会报错，因为未知字段被忽略：**你的"版本闸门"不存在**。
可用的兼容手段只有三件：`host.version`（= `HOST_SDK_VERSION`，只当信息用）、**方法存在性探测**（`host.registerExtension?.(…)`，夹具就是这么写的——"探测能力而不是比版本号"）、以及 `props.propsVersion`（不匹配时**不要渲染**，让宿主默认生效）。`propsVersion` 的约定：只做加法不变，删字段或改语义**必须 +1**。详见 [`compatibility.md`](compatibility.md)。

**权威出处**：`packages/web/src/lib/hostSdk.ts` 的 `HOST_SDK_VERSION` / `GeeWikiHostSdk.version`；`packages/core/src/extensions.ts` 的 `propsVersion`；`packages/web/fixtures/src/index.tsx` 的特性探测写法。

### AP-26 REST 路径里插件名不做 `encodeURIComponent`

❌ 禁止

```bash
curl -X POST 'http://127.0.0.1:3000/api/plugins/@geewiki-plugin/my-note/enable'
```

✅ 正确

```bash
curl -X POST 'http://127.0.0.1:3000/api/plugins/%40geewiki-plugin%2Fmy-note/enable' \
  -H 'content-type: application/json' -d '{"config":{"limit":20}}'
```

**为什么**：包名形如 `@scope/name`，其中 `/` 会改变路由段结构——`/api/plugins/:name/enable` 的 `:name` 匹配不到，结果是 404 或匹配到别的路由。UI 资产路径同理，但规则**相反且更容易搞混**：`/plugins-ui/<插件名>/…` 里插件名**保持未编码**（`PLUGIN_UI_PREFIX` / `PLUGIN_UI_FILE_SEGMENT` / `isPluginUiEntryPath` 的判据是未编码形态；编码名一律不认——dev 环境会落到 Vite 的 SPA fallback 返回 200 + HTML，prod 静态层不解码直接 404，两种现象都不指向真因）。

**权威出处**：`packages/core/src/domain.ts` 的 `PLUGIN_UI_PREFIX` / `PLUGIN_UI_FILE_SEGMENT` / `isPluginUiEntryPath`；`packages/hello-geewiki/README.md` 的 curl 示例；`docs/plugin-platform.md` §4.3。

---

## 覆盖对照（本清单 ↔ 任务给定条目）

| 任务给定的条目 | 本清单条目 |
| --- | --- |
| 1 路由默认 public / 2 permissions 不强制 / 6 部署路径 / 9 editor 红线 / 12 密钥与私有端点 | AP-01 / AP-05 / AP-14 / AP-03 / AP-07 |
| 3 谎报 provides / 4 slots 不一致 / 7 manifest.json 丢 configSchema / 8 越权闸门与 CSS | AP-08 / AP-09（+AP-10） / AP-13 / AP-04（+AP-20） |
| 5 `encodeURIComponent` / 10 ESM 不回收 / 11 无 semver 校验 | AP-26 / AP-19 / AP-25 |
| 新增：订阅者抛错 / apply 慢启动 / provide 时序 / trackStream / RequestHook / gitignore dist / 自带 react / 容器节点 / portal wrap / clientTools 快照 | AP-02 / AP-17 / AP-18 / AP-16 / AP-06 / AP-15 / AP-21 / AP-23 / AP-22 / AP-24 |

## 尚未收录（有意留 TODO，需先核实再补条）

- **`mount` 类字段**：核实结论是 `GeeWikiClient` **没有** `assets`/`mount` 字段（只有 `entry?` / `css?`），因此"资源根 = UI 根本身"这条只能算**约定说明**，不构成反模式；若要收录需要一条"作者以为要声明资源清单"的正向说明，已并入 [`api-reference.md`](api-reference.md)。
- **`@geewiki/openai` 式 provider 的失败降级**（provider 路由返回 null 让下一个 provider 接手）值得单独成条，但需要逐行读 `packages/plugin-openai/src/index.ts` 确认失败语义后再写，本次未做。
- **`conflictGroup` 与 `provider_mismatch` 的误用**（替换者 `provides` 与被替换者不一致 ⇒ 409）宜与 AP-08 合并成一条完整的"提供方替换"条目，待与 [`review-checklist.md`](review-checklist.md) 一起定稿。
- 平台侧待办（把默认 `access` 改 fail-closed、权限强制、发布者签名等）的台账编号需等 `docs/agent/backlog.md` 落地后回填（该文件由并行任务建立）。
