# 快速上手：从零到跑通一个外部插件

> 本篇只干一件事：**给你一条能整段复制执行的路径**，从 `pnpm run new:plugin` 到"接口能访问、界面能看见、改动能生效"。
>
> 机制解释与全部限制在别处：契约事实真源是 [`../plugin-platform.md`](../plugin-platform.md)，"该不该写这个插件、该写哪一种形态"见 [`index.md`](index.md)。本篇**不复述**那 86KB 的散文，只在需要动手的地方给最短指令 + 权威出处的链接。
>
> 本系列的其余篇目（`api-reference.md`、`anti-patterns.md`、`compatibility.md`、`review-checklist.md`，同目录）写作时可能尚未落地，点不开就先读 [`../plugin-platform.md`](../plugin-platform.md)。
>
> 本篇所有命令与字段均以源码为准；引用一律「路径 + 符号名」，不写行号（行号会漂）。**现状与产品理念冲突处如实写出，不做美化**——这些坑会让"文件在磁盘上、界面却消失"这种事真的发生。

---

## 0. 前置条件（现算，别抄读数）

| 要求 | 真源字段 | 你现在自己算 |
| --- | --- | --- |
| Node ≥ 22 | 根 `package.json` 的 `engines.node` | `node -v` |
| pnpm 11.x | 根 `package.json` 的 `packageManager`（`pnpm@…` 钉了具体版本） | `pnpm -v` |
| 依赖已装 | 锁文件 | `pnpm install` |

```bash
node -v && pnpm -v && pnpm install
```

两点与"插件开发"直接相关的结构事实：

- **外部插件不是 workspace 包**：`pnpm-workspace.yaml` 的 `packages` 只含 `packages/*`，`plugins/` 刻意不在里面。所以插件**没有自己的安装步骤、没有锁文件、不能声明依赖**——入口 TS 由宿主进程的 `tsx` 直接执行（口径见 `plugins/hello-geewiki/README.md`）。真要第三方库，只能在该插件目录内自带 `node_modules`。
- **仓库根的 `dev` 脚本是 POSIX shell 写法**（用了 `&` 与 `$!`）。Linux/macOS 直接跑；**Windows 请开两个终端**分别跑 `pnpm run dev:server` 与 `pnpm run dev:web`。

---

## 1. 第一步：生成骨架，并把产物当成"最小契约"

```bash
pnpm run new:plugin my-note --ui          # 带前端
pnpm run new:plugin my-note               # 纯后端
pnpm run new:plugin my-note --ui --dry-run  # 先看内容，不落盘（推荐先跑这个）
```

真源：CLI 在 `scripts/create-plugin.ts`（只做参数解析与终端输出），生成逻辑在 `packages/manager/src/scaffold.ts`（纯函数 `scaffoldFiles` + 写盘 `writeScaffold`）。

### 1.1 全部参数

| 参数 | 作用 | 备注 |
| --- | --- | --- |
| `<插件名>` | 目录名、URL 片段、包名后缀 | 唯一位置参数；只接受一个 |
| `--ui` | 额外产出 `dist/client.js` + `dist/client.css` | 手写零构建产物 |
| `--no-ui` | 显式关闭 UI 产物 | 默认就是关 |
| `--no-hot` | **不**声明 `runtime.supportsHotReload` | 默认声明为 `true`；关掉意味着热启停会被拒（见 §6） |
| `--display <名字>` | 清单 `geewiki.displayName` | 缺省用插件名 |
| `--desc <说明>` | 清单 `geewiki.description` | 缺省生成一句 `<名字> —— GeeWiki 外部插件` |
| `--dir <目录>` | 插件根目录 | 缺省 `<仓库根>/plugins` |
| `--dry-run` | 只打印将写入的文件内容 | 带 `--ui` 时也会打印 `.gitignore` 例外提示 |
| `-h` / `--help` | 打印用法 | — |

**插件名规则**（`validatePluginName`）：`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`，且长度 ≤ 40。即"小写字母开头、小写字母/数字组成、单连字符分段"（`my-notes` ✅，`My_Notes` / `my--notes` / `-foo` ❌）。这是**白名单**而不是"过滤掉危险字符"——因为这个名字会进 URL（`/plugins-ui/…`）、进静态层路径解析、进包名，过滤式校验总会漏。

**包名规则**（`packageNameOf`）：`@geewiki-plugin/<插件名>`。这个名字就是清单与依赖图里用的插件名。

**目标目录已存在且非空 ⇒ 直接拒绝覆盖**（`writeScaffold` 的守卫），空目录允许。

### 1.2 真实产出（`--ui` 形态；不带 `--ui` 就没有 `dist/`）

```
plugins/my-note/
├── package.json      # 清单在顶层 geewiki 键
├── index.ts          # 后端入口：默认导出 { name, apply }
├── README.md         # 作者第一眼会看到的坑说明（由模板生成）
└── dist/             # 仅 --ui：手写、零构建的前端产物
    ├── client.js
    └── client.css
```

注意它**没有**的东西，都是刻意的：没有 `ui/` 目录、没有 `vite.config.ts`、没有 `tsconfig.json`、没有任何依赖声明。脚手架**不生成 `ui/` 目录**——插件自带 UI 产物根被硬编码为 `<插件目录>/dist`（`packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiRoots` 第一候选根），所以产物必须落在 `dist/` 下，才会"装插件即生效、无需重建 web 包"。要上框架/TSX 是你自己的工程决定，模板不替你定。

### 1.3 ⚠️ 生成之后**第一件事**：处理 `dist/` 被全局忽略

这是本 guide 最重要的一条实操坑，值得单独一节。

- 仓库根 `.gitignore` 有一条全局 `dist/`；
- 你的 UI 产物**手写**在 `plugins/my-note/dist/`；
- 后果：**它不会进版本库**。你在本地看到文件、界面也正常，直到某次**干净检出**或 `git clean -fdx` 之后，插件界面**静默消失**——没有报错、没有 issue，`GET /api/plugins/ui` 只是把它挪进 `skipped`（原因 `entry_missing`）。

脚手架 CLI 在 `--ui` 时会打印它自己认为**唯一不可省**的提示（`printGitignoreHint` / `gitignoreLinesFor`），把这两行加到**仓库根** `.gitignore` 末尾：

```gitignore
!plugins/my-note/dist/
!plugins/my-note/dist/**
```

**不要**图省事写一条覆盖所有插件的通配例外：`plugins/ui-demo/dist` 与 `plugins/hello-geewiki/dist` 是**真正的构建产物、刻意不入库**，通配例外等于把"生成物不入库"这条约定悄悄废掉。例外必须**逐插件**开。

自查（跑一遍就懂现状）：

```bash
git check-ignore -v plugins/my-note/dist/client.js   # 有输出 ⇒ 仍被忽略，例外没生效
git ls-files plugins                                  # 看两个示例插件：dist/ 一个文件都不在库里
```

后一条命令的现状：两个示例插件的 UI 产物**根本不入库**，克隆下来是空的。要看示例界面得先重新产出：

```bash
pnpm --filter @geewiki/web run build:fixtures
```

### 1.4 逐行读解生成的清单（这就是最小契约）

`--ui` + 默认参数生成的 `package.json`（`manifestJson`）：

```jsonc
{
  "name": "@geewiki-plugin/my-note",   // 发现流程取的插件名就是它（parsePluginManifest）
  "version": "0.1.0",                  // 只用于展示；缺省时宿主按 0.0.0 处理
  "private": true,
  "type": "module",                    // 必须是 ESM：宿主用 dynamic import 加载
  "description": "…",
  "geewiki": {
    "displayName": "my-note",
    "description": "…",
    "provides": "my-note-service",     // ⚠️ 模板这一处照抄即错，见 §1.5
    "requires": ["http-service"],      // 依赖图 token，不是 ctx.get 的服务名！见下
    "runtime": {                       // 三个值都是显式写出的，语义见 §6
      "supportsHotReload": true,
      "requiresCachePurge": false,
      "drainTimeout": 5
    },
    "entry": "index.ts",
    "slots": ["app-footer"],           // 仅 --ui：必须与 bundle 里 registerSlot 的名字逐字一致
    "client": { "entry": "client.js", "css": "client.css" }  // 仅 --ui：相对 dist/
  }
}
```

三个容易误解的点：

1. **`requires` 写的是依赖图 token，`ctx.get()` 用的是真实服务名**。模板 `requires: ['http-service']` 是 `@geewiki/http` 的 `provides` 值，而取服务要写 `ctx.get('http')`。把两者混为一谈的症状是"依赖顺序对了但服务拿到 undefined"。
2. **模板刻意不写 `permissions`**。`geewiki.permissions` 的语义是"我要碰哪些跨界能力"（`node:fs` / `process.env` / 网络…，取值见 `packages/core/src/domain.ts` 的 `PLUGIN_PERMISSIONS`）。模板零依赖所以零声明——**用不到却写上，就是一份不诚实的清单**；真用了 Node 内置就得补上。另外要知道：宿主**不做拦截**，这份清单是"可评审"而不是"被强制"（见 [`index.md` §7](index.md)）。
3. **`slots` 与 bundle 里的 `registerSlot(...)` 必须一致**。声明了却不注册 ⇒ 该插槽永远空着**且无人报错**；注册了却没声明 ⇒ 宿主按需加载的判定看不到它（换成 `editor` 一类按需插槽就是"界面永远不加载"）。提交前用 `GET /api/plugins/slots` 与 `GET /api/plugins/ui` 自查（§5）。

### 1.5 ⚠️ 模板里有两处"照抄即错"，必须自己改

**A. `provides: '<插件名>-service'` 是谎报的 token —— 照抄即错。**

已逐文件核实：脚手架模板 `manifestJson` 会声明 `provides: '<n>-service'`，而模板生成的 `index.ts`（`indexTs`）的 `apply()` **从未调用 `ctx.provide()`**。两个示例插件同样如此：`plugins/ui-demo/package.json` 声明 `ui-demo-service`、`plugins/hello-geewiki/package.json` 声明 `hello-service`，而它们的 `apply()` 都没有 provide。

为什么这很糟：清单的 `provides` **只是依赖图 token，不会创建任何 cordis 服务**。谎报之后，任何按 `requires: ['my-note-service']` 依赖你的插件都会被解析成"依赖已满足"，而它实际 `ctx.get('my-note-service')` 恒为 `undefined` —— 症状是**功能静默不可用，不报错**。仓内正确的口径写在 `packages/plugin-echo/src/index.ts` 的清单注释里（该插件曾写 `provides: 'echo-service'`，**已刻意撤销**）。

二选一，别留半成品：

```ts
// ✅ 方案一：不需要对外提供能力 ⇒ 删掉清单里的 provides（推荐，绝大多数插件属于此类）

// ✅ 方案二：确实要对外提供 ⇒ 真 provide，并在 dispose 里注销；两边名字必须完全一致
apply(ctx) {
  const disposeRouter = /* … router.register(…) */
  ctx.provide('my-note-service', myApi)      // 名字 == 清单 provides
  return () => { disposeRouter(); /* 同时撤销服务 */ }
}
```

自查：`curl -s localhost:3000/api/plugins/graph | jq` 看依赖图里你的 token 是否真的有 provider；更硬的办法是在依赖方 `ctx.get(...)` 后打印类型。

**B. 模板的路由注册漏了访问等级 ⇒ 匿名可调。**

模板生成的是 `router.register('GET', '/api/my-note', handler)` ——**没有第 4 参**。`router.register()` 的访问等级**默认 `'public'`**（`RouteAccess`，`packages/core/src/index.ts`），也就是匿名可调，启动时只聚合成一条告警（只有设 `GEEWIKI_STRICT_ROUTE_ACCESS=1` 才拒启）。两个示例插件的 `register` 同样漏了这一参，**别照抄**。显式补上，取值按接口性质定（管理类接口用 `'admin'`）：

```ts
const unregister = router.register('GET', '/api/my-note', handler, { access: 'admin' })
```

除此之外，模板这几处是对的、值得照抄：`apply()` 里**逐次 `ctx.get`**（缓存到模块级变量会把"服务晚到"永久固化成 undefined）、**缺服务立刻抛错**（静默降级会让插件"看起来在跑、实际什么也没做"）、**返回卸载函数并撤销路由**（不撤销的话插件停用后端点仍然存在）。

---

## 2. 清单的两种来源（以及 JSON 清单的契约缺口）

| 来源 | 形状 | 优先级 |
| --- | --- | --- |
| `package.json` 顶层 `geewiki` 键 | `{ name, version, geewiki: { … } }` | **优先**（`parsePluginManifest` 先看它） |
| `geewiki.manifest.json` | `{ name, version, geewiki: { … } }` | 前者的 `geewiki` 键缺失时才用 |

两者都要顶层 `name`，缺了就报 `invalid_manifest`。缺 `version` 时宿主按 `0.0.0` 处理。**同一目录只应有一个真源**——两个都在时生效的是 `package.json#geewiki`，另一份是死文件。

> ⚠️ **契约缺口（现状，如实写）**：`geewiki.manifest.json` 是纯 JSON，**无法承载 schemastery 的 `configSchema`**（那是代码，不是 JSON）。于是走 JSON 清单的插件**没有结构化配置校验**：管理台退化成一坨 JSON 原文编辑，宿主对该插件的配置只校验"必须是 JSON 对象"这一条形状约束，字段一律原样透传（`packages/manager/src/index.ts` 里 `configSchema` 缺失时走 `invalid_config` 的那条分支）。
>
> **规避建议**：需要结构化配置校验（表单、范围校验、未知字段裁剪 `pruneUnknownFields`）时，**用 `package.json#geewiki`**。这是当前唯一能带 `configSchema` 的清单形态。

---

## 3. 宿主是怎么"发现"你的插件的

真源：`packages/manager/src/discovery.ts`（`loadExternalPlugins()`、`scanPluginDirs()`、`resolvePluginEntry()`、`parsePluginManifest()`）。

1. **扫目录**：遍历 `GEEWIKI_PLUGINS_DIR`（缺省 `<仓库根>/plugins`）下的子目录，按名排序。**以 `.` 或 `_` 开头的目录被忽略**（`scanPluginDirs`）——所以 `plugins/_scratch/`、`plugins/.backup/` 里的插件永远不会被发现（反过来，这是你临时"停掉但不删"一个目录的合法手段）。符号链接指向目录**纳入扫描**；符号链接目标不是目录 ⇒ 记 `invalid_plugin_dir`；根目录本身不可读（EACCES 等）**只记一条 issue 并返回空列表**，绝不抛异常（抛出去会被组合根当成启动崩溃：写 `crash.marker` + `exit(1)`，在容器里变成重启循环）。
2. **读清单**：`package.json#geewiki` 优先，否则 `geewiki.manifest.json`；都没有 ⇒ `missing_manifest`。
3. **重名判定**：与内置插件或已发现的外部插件同名 ⇒ `duplicate_plugin`，跳过该目录（外部插件不得覆盖内置）。
4. **定入口**：候选顺序 = 清单 `geewiki.entry`（若有）→ `ENTRY_CANDIDATES`，即 `index.ts` → `index.js` → `src/index.ts`；逐个 `existsSync && isFile()` 命中即用。词法检查 `isInsideDir` 之后**还要用真实路径复核** `isInsideDirReal`（两侧都先 `realpathSync`）——插件目录内的符号链接指向目录外 ⇒ 拒绝加载（`invalid_plugin_path`）。全部候选都不存在 ⇒ `entry_not_found`。
5. **迁移目录**：`geewiki.migrations` 声明了就必须位于插件目录内（越界抛 `invalid_plugin_path`）；目录不存在**只告警**（见 §8）。
6. **加载**：`await import(pathToFileURL(入口).href)`，取 `mod.default ?? mod`；没有 `apply` 方法 ⇒ `invalid_module`。其余加载期异常 ⇒ `load_failed`。

任何一步失败都**只跳过该插件、记一条 issue，不阻断宿主启动与其余插件**。

### 3.1 `DiscoveryIssue.code` 全集（8 个）与怎么读

```bash
curl -s localhost:3000/api/plugins | jq '.issues'
```

（`/api/plugins` 的 `issues` 字段就是这些；管理台插件页同样显示它。**先看这里，再看日志**。）

| code | 触发 | 常见处置 |
| --- | --- | --- |
| `missing_manifest` | 既无 `package.json#geewiki` 也无 `geewiki.manifest.json` | 补清单（注意还得有顶层 `name`） |
| `invalid_manifest` | 清单 JSON 解析失败 / 缺 `name` | 校验 JSON；补 `name` |
| `entry_not_found` | `entry` 与 `index.ts`/`index.js`/`src/index.ts` 全部不存在 | 对齐 `geewiki.entry` 与实际文件名 |
| `invalid_plugin_path` | 入口或迁移目录越出插件目录（`../` 或符号链接穿越） | 把文件放进插件目录内；去掉越界 symlink |
| `invalid_plugin_dir` | 插件根不可读 / 符号链接目标不是目录 | 修目录权限（容器里常见：绑定挂载属主不匹配） |
| `duplicate_plugin` | 与内置插件或先前发现的外部插件重名 | 换包名（`@geewiki-plugin/<唯一名>`） |
| `invalid_module` | 入口没导出带 `apply` 的 cordis 插件对象 | 默认导出 `{ name, apply }` |
| `load_failed` | 加载期抛出的其它异常（含 import 期语法错误） | 看 `message`；`index.ts` 有 import 期副作用时最容易命中 |

### 3.2 `GEEWIKI_PLUGINS_DIR` 为什么"部署时必须是绝对路径"（按真实机制解释）

不是"就是得写绝对路径"，机制在 `packages/core/src/index.ts` 的 `resolveProjectPath` / `findRepoRoot`：

- **开发树里**：相对路径以**仓库根**为基准，而仓库根的识别标记是 `pnpm-workspace.yaml`（`WORKSPACE_MARKER`），向上最多找 `MAX_ROOT_LOOKUP_DEPTH = 8` 层。所以开发时 `GEEWIKI_PLUGINS_DIR=plugins` 这种相对写法是能用的。
- **部署树里**：镜像里没有 `pnpm-workspace.yaml` ⇒ `findRepoRoot` 返回 `undefined` ⇒ **回退 `process.cwd()`**。于是任何覆盖工作目录的启动方式（`docker run -w`、自定义 entrypoint）都会让插件发现**静默指向别处**：不报错、不报 issue、就是 0 个插件。这就是 `Dockerfile` 把 `GEEWIKI_PLUGINS_DIR=/app/plugins` 写死成绝对路径的原因（`GEEWIKI_CONFIG_DIR=/app/config` 同理；`GEEWIKI_DATA_DIR` / `GEEWIKI_WEB_DIST` 同一个解析器）。
- 另外要知道：**插件不打进镜像**，只来自挂载（`docker-compose.yml` 把 `./plugins` 挂到 `/app/plugins`）。

```bash
# 启动日志会打印解析结果，先核对这一行再说"插件不见了"
# [server] 外部插件目录: /app/plugins
docker compose logs geewiki | grep 外部插件目录
```

> ⚠️ **姊妹坑（Docker 高发）**：把**空目录**挂到 `/app/config` 会**遮蔽镜像里的模板** `plugins.base.example.json`。缺了默认清单 ⇒ 读到空清单 ⇒ 没有任何插件被激活 ⇒ HTTP 不监听 ⇒ 进程以退出码 0 结束，再被 `restart: unless-stopped` 反复拉起 —— **静默重启循环，对外完全不服务**。读取回退规则见 `packages/manager/src/index.ts` 的 `readBaseList` / `exampleManifestPathOf`。处置：首次启动前把模板复制进挂载目录（见 `../deployment.md`）。

---

## 4. 启用它：外部插件**不会自动启用**

发现 ≠ 启用。三条路径，按"要不要重启"选：

| 路径 | 写哪里 | 是否入库 | 重启后 |
| --- | --- | --- | --- |
| **基础层（本机 live）** | `config/plugins.base.json` 的 `enabled` | ❌ 不入库（`.gitignore` 默认拒绝整个 `config/`；保存一次配置就会重写它） | 仍在（冷操作） |
| **随版本发布的默认值** | `config/plugins.base.example.json`（入库模板；自建分发/团队默认用它） | ✅ | 仍在 |
| **会话层（临时）** | 管理台点启用 → 落 `config/plugins.session.json` | ❌ | 按基础层清单决定去留 |

基础层与会话层是**叠加**关系：管理器启动时读 base（live 文件缺失则回退同名 `.example.json` 模板）+ session，合并出启用集合。分层对**热操作**的约束是硬性的：基础层的插件走"改清单 + 重启"的冷操作，热启停/热替换会被 `base_layer` 拒（§6）。

基础层启用长这样（`enabled` 条目可以直接内联该插件的配置）：

```jsonc
{
  "enabled": [
    // …内置插件条目…
    {
      "name": "@geewiki-plugin/my-note",
      "config": { "greeting": "hi", "baseUrl": "https://api.example.com/v1" }
    }
  ]
}
```

> **不绑厂商（硬要求）**：清单与默认配置里**不要**写死某家私有端点或模型名；本文与仓内文档示例统一用 `https://api.example.com/v1` 之类占位符。出厂模板 `config/plugins.base.example.json` 里 `@geewiki/llm` 的默认配置**已经是占位符**（此前硬编码私有端点与模型名，已登记并修正，见 `docs/agent/backlog.md`）。注意边界：`baseUrl` 与 `model` **只能写在清单里，没有环境变量间接层**（换端点就得改配置），只有密钥走 `apiKeyEnv`／`role: 'secret'`（见 `docs/deployment.md`）。LLM 一律经 `llm-service` 抽象（参考 `packages/plugin-openai/src/index.ts`）。

---

## 5. 跑通并验证（每条都给预期现象）

```bash
pnpm run dev                    # Linux/macOS：一条命令起 server + web
# Windows：两个终端
#   终端 1: pnpm run dev:server
#   终端 2: pnpm run dev:web
```

`dev` 会带上 `GEEWIKI_PLUGIN_UI_DIST=packages/web/public`（内置插件 UI 的兜底根）。**你的插件不需要它**：插件自带 `<插件目录>/dist` 是 UI 产物的**第一候选根**，优先级更高，所以改 UI 不用重建 web 包。服务默认监听 `3000`（`GEEWIKI_PORT` 覆盖）。

下面每条命令都假定插件叫 `my-note`、包名 `@geewiki-plugin/my-note`。没有 `jq` 就肉眼看 JSON。

| # | 命令 | 通过的现象 | 不通过先看什么 |
| --- | --- | --- | --- |
| 1 | `curl -s localhost:3000/api/my-note` | `200`，body 含 `service`、`greeting`、`timestamp` | 404 ⇒ 插件没激活（步骤 2）或路由没注册（看启动日志有没有 `[my-note] 已激活`） |
| 2 | `curl -s localhost:3000/api/plugins \| jq -r '.plugins[] \| select(.name=="@geewiki-plugin/my-note") \| [.state,.layer,.version] \| @tsv'` | 一行：`active` + `base`/`session` | 空输出 ⇒ 没被发现（`issues`）或没启用（§4）；`state` 是 `error` ⇒ 看同一条的 `error` 字段 |
| 3 | `curl -s localhost:3000/api/plugins \| jq '.issues'` | `[]` | 见 §3.1 的 code 表 |
| 4 | `curl -s localhost:3000/api/plugins/graph \| jq` | 依赖图里有你的节点与 `requires` 边 | 边指向的 token 没有 provider ⇒ §1.5 A |
| 5 | `curl -s localhost:3000/api/plugins/ui \| jq '.plugins, .skipped'` | `plugins` 含你的插件，给出 `entry` 与 `rev` | 落在 `skipped` ⇒ 看原因：`inactive`（没启用）/ `no_client`（清单没写 `client`）/ `entry_missing`（**产物不见了，回 §1.3**）/ `invalid_name` |
| 6 | 用第 5 步的 `entry` 拼出资产 URL 再取（别手写路径）：<br>`curl -sI "localhost:3000/plugins-ui/@geewiki-plugin/my-note/client.js"` | `200` 且 `content-type` 是 JS | 404 ⇒ 产物路径/根不对；入口表说有、资产 404 属于运维级问题，见 `../plugin-platform.md` §4 |
| 7 | `curl -s localhost:3000/api/plugins/slots \| jq` | 你声明的插槽归属正确，`conflicts` 为空，你没进 `suppressed` | 被 `suppressed` ⇒ 单占用插槽（`replace`/`wrap`）有别的插件先赢了 |
| 8 | 浏览器打开站点（dev 下前端端口见 `dev:web` 的 vite 输出） | 页脚出现 `my-note：来自外部插件`（类名 `my-note-footer`）；管理台「插件管理」列表出现该插件 | 后端接口通、界面没变化 ⇒ 十有八九是 §1.3 或 §6 的刷新/产物问题 |

`/api/plugins`、`/api/plugins/ui`、`/api/plugins/slots`、`/api/plugins/graph` 这几个**读端点**当前是 `public`（前端探测依赖它们）；**写端点与配置读写是 `admin`**。

---

## 6. 迭代节奏：热更新的边界在哪（必须讲透）

| 你改了什么 | 生效需要什么 | 为什么 |
| --- | --- | --- |
| `index.ts`（后端源码） | **重启宿主进程** | ESM 模块实例**永不回收**：热启停能让插件立即起停，但改**源码**时旧实例仍在内存里（`docs/plugin-platform.md` §5.2） |
| `dist/client.js` / `client.css` | **整页浏览器刷新** | 同 URL 会命中浏览器模块缓存；入口表的 `rev` 变了会重新 import，但取的还是缓存里那份 |
| 清单字段（`requires` / `client` / `slots` / `runtime` / `migrations`） | **重启** | 清单在启动期解析 |
| 插件**配置**（管理台改） | 一般不需重启，但**看插件是否响应配置变更** | 配置重放按插件实现；宿主只保证校验（有 `configSchema` 才真校验，见 §2） |
| 启停（管理台） | 需 `supportsHotReload: true`，否则 409 | 见下 |

### 6.1 两个 409 码不是一回事，别混

| code | 含义 | 处置 |
| --- | --- | --- |
| `hot_reload_not_supported` | 该插件**未声明** `runtime.supportsHotReload: true` —— 它只支持"持久化安装 + 进程重启"（冷操作） | 要么接受重启，要么在插件里显式声明 `supportsHotReload: true`（前提是你确认它真能安全起停），要么改基础层清单后重启 |
| `base_layer` | 被顶替者或整个卸载集合里有**基础层**成员 —— 与"你是否声明了热插拔"**无关**，属冷操作 | 按错误消息里给出的文件名去编辑基础层清单（`plugins.base.json`）后**重启进程**；别指望热替换基础层插件 |

注意一个已知陷阱：不支持热插拔的插件**能被临时停用**（若无活跃依赖方），但重新启用会撞 `hot_reload_not_supported` ⇒ "停了只能重启才能起来"。宿主对"回到本进程本来就有的状态"的恢复路径做了豁免（`packages/manager/src/index.ts` 的 `restoringBase` 分支），但你写插件时别把 `supportsHotReload: false` 的插件设计成"一停就废"。

### 6.2 错误码 → HTTP（排障时按码不看文案）

真源：`packages/manager/src/index.ts` 的 REST 错误出口。

| HTTP | code |
| --- | --- |
| 404 | `not_found` |
| 413 | `payload_too_large` |
| 504 | `load_timeout`（服务端等 `apply()` 结算超时 —— **不是**客户端的错） |
| 500 | `replace_rollback_failed`（回滚也没成功：状态不确定，需人工介入） |
| 409 | `conflict_group`、`has_dependents`、`hot_dependency_not_supported`、`provider_mismatch`、`hot_update_failed`、`migration_failed`、`base_layer`、`hot_reload_not_supported` |
| 400 | 其余（含 `invalid_config`） |

`conflict_group` 的常见现场：同一 `conflictGroup`（如 `database-provider`、`oidc-provider`、`search-provider`）已有激活者 —— 换 provider 是**显式决策**，不是并发启用。

### 6.3 `runtime` 的默认值与两个逃生口

`normalizeRuntime`（`packages/core/src/index.ts`）的规范化缺省值：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `supportsHotReload` | `false` | 保守缺省：没说能热插拔就不能热插拔 |
| `requiresCachePurge` | `false` | 是否在启停后请求缓存清理 |
| `drainTimeout` | `5`（秒） | 停用前等待在途请求排空 |
| `applyTimeout` | `30`（秒，`DEFAULT_APPLY_TIMEOUT_SECONDS`） | `apply()` 结算上限；超时抛 `load_timeout` 并走单点回滚，同时回收"超时后才结算成功"的幽灵 fiber |

两个必须知道的点：

- **`applyTimeout <= 0` 是"不超时"的逃生口**（冷启动本来就慢的插件用它，别去调小全局缺省）。
- **迁移在 `apply()` 之前执行，不受 `applyTimeout` 约束**；迁移失败是 `migration_failed`（409）。

写 `apply()` 的纪律（模板已内置）：逐次 `ctx.get`、缺服务立刻抛错、返回撤销一切的卸载函数。

### 6.4 崩溃自愈与 `crash.marker`（现象 + 应对）

看门狗在运行期探活（`packages/manager/src/watchdog.ts` 的 `decideWatchdog`），两种动作：

- `rollback`：**最近启用的会话层插件**在试用期（`gracePeriodMs`，缺省 5000ms）内出现连续健康探针失败 ⇒ 回滚它（撤掉那条会话层条目）。
- `meltdown`（熔断）：连续失败达到阈值（`meltdownThreshold`，缺省 3）**且会话层非空** ⇒ 清空会话层并以非零退出码结束，靠容器 `restart` 策略自愈回基础层。

崩溃标记文件是 `<GEEWIKI_DATA_DIR>/crash.marker`（`packages/server/src/index.ts` 的 `crashMarkerFile`）。

对你的含义：

1. **纯基础层故障不会触发熔断**（判据里要求会话层非空）。所以把宿主搞崩的不是"熔断误杀"，而是**根本不自愈** —— 改坏基础层清单得手动改回。
2. 会话层是安全的试验场：装进来玩崩了会被熔断清掉并重启，**不会**污染基础层。这就是"先在会话层验证，再写进基础层"的理由。
3. 一个在启动期就抛异常的插件被发现流程挡住（记 issue、跳过），**不该**把宿主拖崩；如果你发现"装了就起不来"，先看 `issues`，再怀疑 `index.ts` 有没有 import 期副作用（`load_failed`）。

---

## 7. 分发给别人：`install-plugin` 与完整性基线

README 里这些命令一直没有参数说明，这里补齐。真源：`scripts/install-plugin.ts`（CLI）+ `packages/manager/src/plugin-install.ts`（实现）。

```bash
pnpm run install-plugin ./some-plugin            # 从目录安装（开发期常用）
pnpm run install-plugin ./dist/foo-1.0.0.tgz     # 从压缩包安装
pnpm run install-plugin https://host/foo.tgz     # 从 URL 安装（仅 https）
pnpm run install-plugin ./foo --dry-run          # 只规划，不动任何插件目录
pnpm run install-plugin ./foo --name bar         # 指定目标目录名
pnpm run install-plugin ./foo --force            # 覆盖已存在的同名插件
pnpm run install-plugin --verify                 # 校验全部已安装插件的完整性
pnpm run install-plugin --verify --json          # 同上，机器可读
```

| 参数 | 行为 | 必须知道的细节 |
| --- | --- | --- |
| `<来源>`（位置参数，只一个） | 目录 / `.tgz`/`.tar.gz` / URL | `classifySource` **直接拒绝 `http://`**（只准 https）：明文通道上任何人都能换掉你的包 |
| `--name <目录名>` | 目标目录名 | 缺省用清单里的插件短名；目录名要过白名单 `^[a-z0-9][a-z0-9._-]*$`，且解析后必须真落在插件目录内 |
| `--force` | 覆盖同名插件 | 旧目录是**改名**为 `<目录>.replaced-<时间戳>`，**不是删除**（可自行回滚/清理，别指望它回收空间） |
| `--dry-run` | 打印计划（`describePlan`） | 规划本身**会**下载/解包到暂存区；CLI 用 `cleanupPlan` 负责清理，所以正常结束时你**不该**看到 `.gw-install-*` 残留（异常退出会留，手工清掉） |
| `--verify` | 逐个插件比对基线 | 见下面的四态；`--json` 给脚本用 |

**安装链路做的事**：`tar -tzf` 先列条目并**逐条判越界** → 解包（`--no-same-owner --no-same-permissions`，不把打包者的 uid/gid 与权限带进本机）→ `assertNoSymlinks` 走一遍目录树（**拒绝符号链接与特殊文件**：链接会让"插件目录之外"的文件被当成插件内容）→ 校验清单（复用发现流程的 `parsePluginManifest`）→ 落地 `.geewiki-integrity.json`（逐文件 sha256 + `rootHash`）。

**基线统计口径**：`SKIP_NAMES` 跳过 `node_modules` / `.git` / `.geewiki-integrity.json`；**符号链接不计入基线**（用 `lstatSync`）。

`--verify` 的**四态**（`IntegrityStatus`）：

| status | 含义 | 你该怎么做 |
| --- | --- | --- |
| `ok` | 与安装基线逐文件一致 | 无需动作 |
| `drift` | 相对基线有改动（CLI 会列 `changed` / `added` / `removed`） | 先确认是自己改的还是被人改的；重新安装或重建基线 |
| `unsigned` | **没有基线 ⇒ 无法判断** | **不等于通过**。把 `unsigned` 当通过，正是那种"看起来在防护、实际什么都没防"的实现 |
| `missing` | 目录本身不存在 | 目录被删/挂载没挂上 |

> ⚠️ **基线坏掉 ≠ `unsigned`**：基线 JSON 解析失败、`formatVersion` 不匹配、缺 `files` ⇒ 抛 `MaintenanceError`，**整个 `--verify` 直接失败**，不会被静默降级成 `unsigned`。这时先修/删那个 `.geewiki-integrity.json`，别把"命令报错"读成"插件被改了"。

> **边界（不冒充）**：这是**完整性**，不是**签名**。它能回答"相对安装那一刻被改过吗"，**不能**回答"这是谁发布的、可信吗"——能改写插件文件的人也能改写随包落地的基线。外部插件**无发布者签名**是现状（[`index.md` §7](index.md) 第 10 条）。

两个实操提醒：

1. 这个 CLI 走仓库根的 `scripts/`（要 `tsx`），是**开发/打包侧**的工具；生产容器里通常没有仓库根脚本，运行期只需把插件目录放进挂载点。它的插件目录取 `GEEWIKI_PLUGINS_DIR`（相对值以**仓库根**为基准解析）。
2. 装完仍**不会自动启用**（§4）。CLI 自己也会打印这句提示。

---

## 8. 要建表：双方言必须成对

GeeWiki 是**双数据库轨道**（SQLite 走内建 `node:sqlite`，另一轨是 Postgres）。需要自己的表就必须成对提供两套迁移：

```
plugins/my-note/
├── migrations/            # SQLite 方言
└── migrations-postgres/   # Postgres 方言
```

清单里声明（`resolveMigrationsDirs` 与内置插件共用同一套解析规则）：

```jsonc
"migrations": { "default": "migrations", "postgres": "migrations-postgres" }
// 或单一通用目录："migrations": "migrations"（键为 'default'，所有方言共用）
```

规则与红线：

- 声明的目录必须位于插件目录内，越界 ⇒ `invalid_plugin_path`；目录**不存在只告警**并忽略（症状是"表不存在"的运行期错误，而不是启动失败 —— 别把告警当噪声）。
- 守卫测试：`packages/manager/test/migrations-dialect.test.ts`、`packages/manager/test/db-dual-track.test.ts`。跑 `pnpm --filter @geewiki/manager run test` 确认没把两边写歪。
- 迁移在 `apply()` **之前**执行、不受 `applyTimeout` 约束；失败 ⇒ `migration_failed`（409）。
- 外部插件**不参与** `pnpm -r` 的 `test` / `typecheck` / `build`（不是 workspace 包）——质量门禁得你自己在插件目录内备好（`review-checklist.md` 的硬性项，若尚未落地就先照 §8 这两条自查）。

---

## 9. 排障表（现象 → 根因 → 处置）

| 现象 | 最可能根因 | 处置 |
| --- | --- | --- |
| 后端接口通了，**界面无变化** | ① `dist/` 产物实际不存在（被 `.gitignore` 吃掉，§1.3）；② 清单 `slots` 与 bundle 里 `registerSlot` 的名字不一致（**静默空白，无报错**）；③ 浏览器命中模块缓存 | `curl -s localhost:3000/api/plugins/ui \| jq '.plugins, .skipped'`；`git check-ignore -v plugins/<n>/dist/client.js`；`ls -l plugins/<n>/dist`；整页刷新 |
| **插件不出现在** `/api/plugins` 的 `plugins` 里 | 发现阶段就被跳过 | `jq '.issues'`（§3.1）；确认目录名不是 `.`/`_` 开头；确认 `config/plugins.base.json` 或会话层里有它（§4）；核对启动日志 `[server] 外部插件目录:` 的绝对路径 |
| `issues` 里有 code | 见 §3.1 的逐码处置 | 先 `jq '.issues'` 拿 `code` + `message` + `dir`，再按表处置 |
| 改了后端代码**不生效** | ESM 实例永不回收 | **重启宿主进程**（热启停不解决源码变更）；确认日志里出现新的 `[<名>] 已激活` |
| 改了 `client.js` **不生效** | 同 URL 命中浏览器模块缓存 | **整页刷新**（硬刷新）；必要时核对入口表 `rev` 是否真的变了 |
| 409 `hot_reload_not_supported` | 未声明 `supportsHotReload: true` | 接受重启／显式声明（确认插件真能安全起停）／改基础层清单后重启（§6.1） |
| 409 `base_layer` | 被顶替者或卸载集合含**基础层**成员（与热插拔声明无关） | 按错误消息里的文件名编辑基础层清单并重启（§6.1） |
| Docker 下 **HTTP 不监听** / 反复重启却对外不服务 | 空的 `./config` 挂载遮蔽了镜像内模板 ⇒ 空清单 ⇒ 无插件激活 ⇒ 进程退出码 0 + `restart` 循环（§3.2） | 把 `plugins.base.example.json` 复制成挂载目录里的 `plugins.base.json`；同时确认 `GEEWIKI_PLUGINS_DIR` 是绝对路径、`./plugins` 挂载非空（`../deployment.md`） |
| **干净检出 / `git clean -fdx` 后 UI 产物丢失** | 全局 `dist/` 忽略规则（§1.3） | 加逐插件 `.gitignore` 例外；示例插件的产物用 `pnpm --filter @geewiki/web run build:fixtures` 重新产出 |
| 配置**改不动 / 改了零校验**（表单是 JSON 原文） | 走的是 `geewiki.manifest.json`，无法承载 `configSchema`（§2） | 改回 `package.json#geewiki` 并声明 `configSchema`；注意无 schema 时宿主只校验"必须是 JSON 对象"，其余字段原样透传 |
| 依赖方 `ctx.get('xxx-service')` 恒为 `undefined`，却"依赖已满足" | 上游只写了清单 `provides`、从没 `ctx.provide()`（§1.5 A；脚手架模板与两个示例插件都是这样） | 删掉谎报的 token，或真 provide + dispose 注销、两边同名 |
| 我的接口**匿名就能访问** | `router.register()` 漏写第 4 参 ⇒ `access: 'public'`（§1.5 B） | 每条路由显式写 `access`；用 `GEEWIKI_STRICT_ROUTE_ACCESS=1` 让漏写在开发期就拒启 |
| 装了 `node_modules` 却 `Cannot find module` | 外部插件不是 workspace 包，pnpm 严格布局下不会向上解析宿主依赖 | 在该插件目录内自带 `node_modules`；或干脆只用 Node 内置 + `ctx` 服务（推荐） |
| 界面 bundle 里 React 报 hook / portal 怪错 | bundle 自带了第二份 `react` | 删掉自带 React：宿主 import map 已把 `react` / `react/jsx-runtime` / `react-dom` 映射到宿主实例；没有 JSX 就用 `host.React.createElement` |

---

## 10. 跑通之后

- 决策与导航：[`index.md`](index.md)（该不该写、写哪种形态、读哪篇）
- 契约事实真源：[`../plugin-platform.md`](../plugin-platform.md)（清单/生命周期/界面平台/已知限制 `L-*`）
- 部署与环境变量：[`../deployment.md`](../deployment.md)；开发工作流：[`../development.md`](../development.md)
- 提交前：`review-checklist.md`（同目录，若尚未落地，至少自查本篇 §1.5 两处、§2 清单形态、§8 双方言）；静默失败陷阱合集在 `anti-patterns.md`（同目录，若尚未落地，本篇 §1.3/§1.5/§5/§6 就是它的实操版）
- 宿主 SDK 全量方法：`packages/web/src/lib/hostSdk.ts`；插槽清单与 props 契约：`packages/core/src/slots.ts`（经 `GET /api/plugins/slots` 的 `props` 字段下发，不必引 TS）

**动手前把 §1.5 的两处改掉、§1.3 的例外加上，再开始写业务代码** —— 这三处"照抄模板"留下的坑，症状全是静默的。
