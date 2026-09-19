/**
 * ★ F21：外部插件脚手架。
 *
 * ## 为什么需要一个生成器
 * 在此之前，"写一个外部插件"的入口是**照抄 `plugins/hello-geewiki/`**。抄一份的代价不只是
 * 麻烦：清单里的每个字段（`entry` / `provides` / `requires` / `runtime` / `client` / `slots`）
 * 都有各自的约定与陷阱，抄漏一个的表现是**插件静默不工作**（前端产物不加载、插槽是空的、
 * 热插拔被拒），而没有任何报错指向"清单少了一行"。把这些约定固化进模板，
 * 是让"万物插件"对**新作者**成立的前提。
 *
 * ## 生成物为什么是"手写零构建"的
 * 外部插件**不是 workspace 包、不能有自己的依赖**（见 discovery 的文件头与
 * `plugins/hello-geewiki/README.md`）——它们由宿主进程的 `tsx` 直接执行，
 * 只应使用 Node 内置 + `ctx` 提供的服务。所以脚手架刻意**不引入任何构建工具链**：
 * 前端产物是一份手写的 `dist/client.js`，直接使用 `window.__GEEWIKI_HOST__`。
 * 作者要上框架/TSX 时再自行接 vite（那是"这个插件自己的工程决定"，不该由模板替他定）。
 *
 * ## 一个必须显式处理的坑：`dist/` 被 .gitignore 全局忽略
 * 外部插件的 UI 根被硬编码为 `<插件目录>/dist`（见 `plugin-ui.ts` 的 `resolvePluginUiRoots` ①），
 * 而本仓库的 `.gitignore` 有全局 `dist/` —— 于是**手写的、零构建的前端产物一提交就没了**。
 * 这不是理论风险：作者会看到文件在磁盘上、界面也正常，直到一次干净检出才发现界面消失。
 * 故 {@link scaffoldFiles} 之外另有 {@link gitignoreLinesFor}，由 CLI 显式告知/写入例外规则；
 * 单测里有一条专门钉住"生成的 UI 文件在默认 .gitignore 下会被忽略"这个前提，
 * 一旦上游改了 UI 根的位置，那条用例会红并提示这里可以简化。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 生成一个插件所需的全部输入 */
export interface ScaffoldSpec {
  /** 插件**目录名**（也是 URL 片段与包名后缀）：小写 kebab，如 `my-notes` */
  readonly name: string
  /** 面向人的短名（清单 `geewiki.displayName`） */
  readonly displayName: string
  /** 一句话说明（清单 `geewiki.description`） */
  readonly description: string
  /** 是否生成自带前端 UI（默认 `true` 更符合"演示一条完整链路"的期望，但 CLI 可关） */
  readonly withUi: boolean
  /** 是否声明可热插拔（`runtime.supportsHotReload`）。默认 `true`。 */
  readonly hotReload: boolean
}

/** 一个待写入的文件（路径相对插件目录，用 `/` 分隔以便跨平台断言） */
export interface ScaffoldFile {
  readonly path: string
  readonly content: string
}

/**
 * 目录名合法性。
 *
 * 与 `pluginUiNameFromSegments` 一脉相承：这个名字会进 URL（`/plugins-ui/<name>/…`）、
 * 进静态层路径解析、进包名，所以必须是**严格的白名单字符集**而不是"过滤掉危险字符"——
 * 后者总会漏。上限 40 字符：再长不是名字，是句子。
 */
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** 校验插件名，返回**人话**的错误（CLI 直接打印它） */
export function validatePluginName(name: unknown): string | undefined {
  if (typeof name !== 'string' || name === '') return '插件名不能为空'
  if (name.length > 40) return `插件名过长（${name.length} > 40）`
  if (!NAME_PATTERN.test(name)) {
    return (
      `插件名 ${JSON.stringify(name)} 不合法：只允许「小写字母开头、由小写字母/数字组成、` +
      '以单连字符分段」（如 my-notes）。它会进 URL 与文件路径，故不做字符替换、只做白名单。'
    )
  }
  return undefined
}

/** 把插件名转成包名（与 hello 示例同一约定） */
export const packageNameOf = (name: string): string => `@geewiki-plugin/${name}`

/**
 * 该插件 UI 产物需要从 `.gitignore` 里**显式放行**的行（见文件头那段坑说明）。
 *
 * 为什么是"每个插件两行"而不是一条覆盖全部插件的通配例外：仓库里 `plugins/ui-demo/dist`
 * 与 `plugins/hello-geewiki/dist` 是**真正的构建产物**、刻意不入库；一条通配例外会把它们
 * 一并纳入，等于把"生成物不入库"这条约定悄悄废掉。例外必须**逐插件**开。
 *
 * ⓘ 注意：本注释刻意**不写出那条通配例外本身**——它的字面量里含有块注释的结束序列
 * （`plugins` 后的星号与随后的斜杠），写进 `/** … *​/` 里会把注释提前闭合，
 * 后果是后面那些"看起来是注释"的文本**变成代码**并抛 `ReferenceError`。
 * 生成器自己的注释把生成器弄坏，是这一项第一次跑起来时真实发生的事。
 */
export function gitignoreLinesFor(name: string): string[] {
  return [`!plugins/${name}/dist/`, `!plugins/${name}/dist/**`]
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** 生成清单（`package.json` 顶层 `geewiki` 键，与 hello 示例同形） */
function manifestJson(spec: ScaffoldSpec): string {
  const geewiki: Record<string, unknown> = {
    displayName: spec.displayName,
    description: spec.description,
    // 依赖图的 token 不是 cordis 服务名：`http-service` 是 `@geewiki/http` 的 provides 值
    provides: `${spec.name}-service`,
    requires: ['http-service'],
    runtime: {
      supportsHotReload: spec.hotReload,
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    entry: 'index.ts',
  }
  if (spec.withUi) {
    /*
     * `slots` 必须是"本插件真的会占用的位置"。它与 `client.js` 里实际调用的
     * `registerSlot(...)` **必须一致**：声明了却不注册 ⇒ 该插槽永远空着且无人报错；
     * 注册了却没声明 ⇒ 宿主按需加载的判定看不到它（这里 `app-footer` 不属按需集合，
     * 但换成 `editor` 一类就会出现"界面永远不加载"）。
     * 生成器只生成一种组合，故由单测钉住这层一致性。
     */
    geewiki.slots = ['app-footer']
    geewiki.client = { entry: 'client.js', css: 'client.css' }
  }
  return json({
    name: packageNameOf(spec.name),
    version: '0.1.0',
    private: true,
    type: 'module',
    description: `${spec.displayName} —— GeeWiki 外部插件`,
    /*
     * 刻意**不声明 permissions**：本模板零 Node 内置依赖（只用 `ctx` 提供的服务），
     * 而 `permissions` 的语义是"我要碰哪些跨界能力"（F10）。用不到却写上，
     * 会让评审看到一份不诚实的清单——那正是 F10 想消灭的东西。
     * 真要用 `node:fs` / `process.env` 时再按需补，清单字段的含义见 core 的 PluginPermission。
     */
    geewiki,
  })
}

/** 后端入口（零依赖：只用 `ctx` 服务，不 import 任何包） */
function indexTs(spec: ScaffoldSpec): string {
  const pkg = packageNameOf(spec.name)
  return `/**
 * ${spec.displayName} —— 后端入口。
 *
 * 本文件**不是 workspace 包的一部分**，由宿主进程的 tsx 直接执行：
 * - 不 import 任何包（包括 \`@geewiki/core\`）：外部插件不得有自己的依赖；
 * - 需要宿主能力时一律经 \`ctx.get('服务名')\` 取，服务名见清单的 \`requires\`
 *   （注意 \`requires\` 里写的是**依赖图 token**，真实服务名可能是另一个，
 *   例如 \`http-service\` → \`ctx.get('http')\`）；
 * - 默认导出 cordis 插件对象 \`{ name, apply }\`，\`apply\` 返回卸载函数。
 *
 * TypeScript 类型在这里**只作注释**（宿主用 tsx 直跑，不做类型检查），
 * 所以下面用 interface 描述契约、而不是 import 类型。
 */

/** 宿主注入的 HTTP 路由服务（\`@geewiki/http\` 经 \`ctx.provide('http', …)\` 提供） */
interface RouterLike {
  register(method: string, path: string, handler: (h: RouteContextLike) => void): () => void
}

interface RouteContextLike {
  json(status: number, body: unknown): void
}

interface ContextLike {
  get(name: string): unknown
}

interface PluginConfig {
  /** 示例配置项：改了它就能在管理台看到"配置热更新"这条链路 */
  greeting?: string
}

const plugin = {
  name: '${pkg}',

  apply(ctx: ContextLike, config: PluginConfig = {}) {
    /*
     * 逐次 \`ctx.get\`，不要缓存到模块级变量：服务在提供者 \`apply\` 结算前可能还不可见，
     * 缓存会把"服务晚到"永久固化成"永远是 undefined"。缺服务时**立刻抛错**，
     * 让激活失败可见——静默降级会让插件看起来在跑、实际什么也没做。
     */
    const router = ctx.get('http') as RouterLike | undefined
    if (!router) {
      throw new Error('${pkg}: http 路由服务不可用（清单的 requires 需要 http-service）')
    }

    const unregister = router.register('GET', '/api/${spec.name}', (h) => {
      h.json(200, {
        service: '${pkg}',
        greeting: config.greeting ?? 'hello from ${spec.name}',
        timestamp: new Date().toISOString(),
      })
    })

    console.log('[${spec.name}] 已激活: GET /api/${spec.name}')

    // 返回卸载函数：路由必须被撤销，否则插件被停用后端点仍然存在
    return () => {
      unregister()
      console.log('[${spec.name}] 已卸载: GET /api/${spec.name}')
    }
  },
}

export default plugin
`
}

/**
 * 前端产物（**手写、零构建**）。
 *
 * 宿主以 `import()` 加载它并调用 `register(host)`（命名导出或 default 均可），
 * 返回值作为卸载清理函数。插件**不得自带框架**：`react` / `react/jsx-runtime` /
 * `react-dom` 都由宿主的 import map 映射到同一份实例（自带一份会让 portal 丢事件）。
 * 没有 JSX 编译，故直接用 `host.React.createElement`。
 */
function clientJs(spec: ScaffoldSpec): string {
  const pkg = packageNameOf(spec.name)
  return `/**
 * ${spec.displayName} —— 前端产物（手写、无需构建）。
 *
 * 宿主加载本文件后调用 \`register(host)\`，其返回值是卸载清理函数。
 * 契约与可用 API 见 packages/web/src/lib/hostSdk.ts（宿主 SDK）。
 *
 * ⚠️ 本文件位于 \`dist/\`，而仓库的 .gitignore 全局忽略 \`dist/\`。
 * 若本插件是**手写产物**（不是构建出来的），需要把下面两行加到仓库根 .gitignore 的末尾：
 *   ${gitignoreLinesFor(spec.name).join('\n *   ')}
 * 否则一次干净检出后界面会消失（文件在磁盘上，但从未进版本库）。
 */
export function register(host) {
  // 该插槽名必须与本插件 package.json 里 \`geewiki.slots\` 的声明一致
  const undo = host.registerSlot('app-footer', () => {
    return host.React.createElement(
      'span',
      { className: '${spec.name}-footer', title: '${pkg}' },
      '${spec.displayName}：来自外部插件',
    )
  })
  return () => {
    undo()
  }
}
`
}

/** 前端样式（全局注入，故类名必须自带前缀避免撞车） */
function clientCss(spec: ScaffoldSpec): string {
  return `/*
 * ${spec.displayName} —— 前端样式。
 *
 * ⚠️ 插件 CSS 是**全局注入**的（宿主不做样式隔离），所以类名一律自带插件前缀，
 * 否则会污染宿主界面。需要强隔离时用 host.createRoot + shadow DOM。
 */
.${spec.name}-footer {
  font-size: 12px;
  opacity: 0.75;
}
`
}

/** README：把"抄模板时最容易踩的坑"写进作者第一眼会看到的地方 */
function readme(spec: ScaffoldSpec): string {
  const pkg = packageNameOf(spec.name)
  const _uiBlock = spec.withUi
    ? `
## 前端

- 产物：\`dist/client.js\` + \`dist/client.css\`（**手写、无需构建**）；
- 宿主加载后调用 \`register(host)\`，返回值用于卸载清理；
- 可用的宿主 API 见 \`packages/web/src/lib/hostSdk.ts\`（插槽 / 路由 / 工具 /
  Markdown 扩展 / 主题 token / react-dom）；
- **不得自带 react**：import map 已把 \`react\` / \`react/jsx-runtime\` / \`react-dom\`
  映射到宿主实例，自带一份会让 portal 丢事件。

> ⚠️ **必须做的一步**：\`dist/\` 被仓库 .gitignore 全局忽略。手写产物要入库，
> 请把下面两行加进根 \`.gitignore\` 的**末尾**（例外必须逐插件开，
> 否则会把 ui-demo / hello-geewiki 的真构建产物一并纳入）：
>
> \`\`\`
${gitignoreLinesFor(spec.name)
  .map((l) => l)
  .join('\n')}
> \`\`\`
`
    : ''
  return `# ${spec.displayName}

${spec.description}

> 由 \`pnpm run new:plugin ${spec.name}${spec.withUi ? ' --ui' : ''}\` 生成。
> 包名 \`${pkg}\`。

## 结构

\`\`\`
plugins/${spec.name}/
├── package.json   # 清单在顶层 \`geewiki\` 键（也可改用独立的 geewiki.manifest.json）
├── index.ts       # 后端入口：默认导出 \`{ name, apply }\`
└── README.md${spec.withUi ? '\n└── dist/          # 前端产物（手写，见下方「前端」）' : ''}
\`\`\`

## 启用

外部插件**不会**自动启用，需要写进配置清单。两种方式：

- **本机持久化（基础层 live 清单）**：把 \`{ "name": "${pkg}" }\` 加进 \`config/plugins.base.json\` 的 \`enabled\`
  （该文件是**本机**状态、不入库；若本机还没有它，从 \`config/plugins.base.example.json\` 复制一份）；
- **临时（会话层）**：在管理台里启用（重启后按基础层决定是否回来）。

> 想让某个外部插件成为**随版本发布的默认值**（例如自建分发），改的是入库的
> \`config/plugins.base.example.json\`，而不是本机那份 live 清单。

## 验证

\`\`\`bash
pnpm run dev            # 启动宿主（GEEWIKI_PLUGINS_DIR 缺省即 <仓库根>/plugins）
curl -s localhost:3000/api/${spec.name}
\`\`\`

发现失败的原因会以 \`issues\` 出现在 \`GET /api/plugins\` 里
（\`missing_manifest\` / \`entry_not_found\` / \`invalid_module\` 等），先看那里再看日志。

## 三条硬约束

1. **不能有自己的依赖**：外部插件不是 workspace 包，由宿主 tsx 直跑；
   只用 Node 内置 + \`ctx\` 提供的服务。真要 import 第三方库，得在该目录内自带
   \`node_modules\`（见 \`plugins/hello-geewiki/README.md\`）。
2. **不 import 任何包**（包括 \`@geewiki/core\`）：需要宿主类型时用 interface 描述契约。
3. **跨界能力必须声明**：用到 \`node:fs\` / \`process.env\` / 网络等，要在清单里补
   \`geewiki.permissions\`（取值见 \`packages/core/src/domain.ts\` 的 \`PLUGIN_PERMISSIONS\`）。
   本模板零依赖，故**刻意没有**声明任何权限——用不到却写上是不诚实的清单。

## 已知边界

- **后端改代码要重启进程**：ESM 模块实例不回收（\`docs/plugin-platform.md\` L-6），
  热插拔能让插件启停立即生效，但改的是**源码**时旧实例仍在内存里；
- **前端产物更新要整页刷新**：同 URL 命中模块缓存，\`rev\` 变化会重新加载但取的还是缓存里那份；
- 插件与宿主**同进程同权限**（无隔离），坏插件能拖垮整站——故 \`runtime.supportsHotReload\`
  这类声明是给运维看的，不是安全边界。

## 更多

- 宿主 SDK：\`packages/web/src/lib/hostSdk.ts\`
- 插件平台机制与全部已知限制：\`docs/plugin-platform.md\`
- 一个更完整的后端示例：\`plugins/hello-geewiki/\`；带前端构建的示例：\`plugins/ui-demo/\`
`
}

/**
 * 生成插件的**全部文件内容**（纯函数：不碰文件系统，故可脱离 IO 单测）。
 *
 * 返回顺序稳定（清单 → 入口 → 前端 → README），便于 CLI 按顺序展示。
 */
export function scaffoldFiles(spec: ScaffoldSpec): ScaffoldFile[] {
  const invalid = validatePluginName(spec.name)
  if (invalid) throw new Error(invalid)
  const files: ScaffoldFile[] = [
    { path: 'package.json', content: manifestJson(spec) },
    { path: 'index.ts', content: indexTs(spec) },
  ]
  if (spec.withUi) {
    // UI 根被 plugin-ui.ts 硬编码为 <插件目录>/dist，故产物必须落在 dist/ 下
    files.push({ path: 'dist/client.js', content: clientJs(spec) })
    files.push({ path: 'dist/client.css', content: clientCss(spec) })
  }
  files.push({ path: 'README.md', content: readme(spec) })
  return files
}

export interface WriteResult {
  /** 插件目录绝对路径 */
  readonly dir: string
  /** 已写入的相对路径（`/` 分隔） */
  readonly written: readonly string[]
  /** 需要作者自行加入 .gitignore 的例外行（无 UI 时为空） */
  readonly gitignoreLines: readonly string[]
}

/**
 * 把生成物写进 `<pluginsRoot>/<name>/`。
 *
 * **拒绝覆盖已存在且非空的目录**：脚手架跑在"我以为这里是空的"上是最危险的一种操作
 * （作者的半成品会被静默盖掉）。空目录允许（`mkdir -p` 之后的常见状态）。
 */
export function writeScaffold(pluginsRoot: string, spec: ScaffoldSpec): WriteResult {
  const dir = join(pluginsRoot, spec.name)
  // 先校验再碰磁盘：名字非法时不该留下半个目录
  const files = scaffoldFiles(spec)
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`目标目录已存在且非空，拒绝覆盖: ${dir}（请换一个插件名，或先手动清空）`)
  }
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const file of files) {
    const abs = join(dir, ...file.path.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, file.content, 'utf8')
    written.push(file.path)
  }
  return {
    dir,
    written,
    gitignoreLines: spec.withUi ? gitignoreLinesFor(spec.name) : [],
  }
}
