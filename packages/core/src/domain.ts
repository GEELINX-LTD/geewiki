/**
 * **跨端共享的领域取值**（★ F3/F5：前端与后端必须看到**同一份**的枚举与白名单）。
 *
 * 为什么单独一个模块、而且必须**浏览器安全**：
 * 这些取值同时出现在 ① 服务端契约（`services.ts` 里 `EditorSlotProps.blockTiers` 的档位刻度）、
 * ② 前端类型（`web/src/api.ts` 的页面/块档位）、③ 插件 UI 的 props。
 * 三处各写一遍就是三份真源 —— 而"档位"这类白名单一旦漂移，失败形态是
 * **静默越权**（多认一个值 = 放行一个本不该放行的档位），不是编译错误。
 *
 * 约束（与 `slots.ts` 相同，由 `packages/core/test/slots-browser-safe.test.ts` 一并钉住）：
 * **零 `node:*` / 零 cordis / 零 schemastery 依赖**，且不得 import 本包的 `index.ts`
 * （那条链会把 `node:fs` 拖回浏览器 bundle）。前端经 `@geewiki/core/domain` 子路径 `import type`。
 */

/**
 * 页面档位。真源在后端 `packages/plugin-wiki/src/index.ts` 的
 * `VISIBILITIES = ['private', 'org', 'public']`（白名单，服务端不认识别的值）。
 * 这里的刻度是**宽松度**：private（最窄）< org < public（最宽）。
 */
export type PageVisibility = 'private' | 'org' | 'public'

/** 全部页面档位，按**宽松度**升序（与 `VISIBILITIES` 同集合、同序） */
export const PAGE_VISIBILITIES: readonly PageVisibility[] = ['private', 'org', 'public']

/* ============================ ★ F9：能力名 ============================ */

/**
 * **内置能力**：由组织角色推导、服务端与前端都必须认识的那三个。
 *
 * 它们**不是**白名单的全部 —— 这是 F9 要改掉的东西。原先这个集合是**编译期闭合**的
 * （`AuthCapabilities` 恰好三个键，`NavCapability = keyof AuthCapabilities`），
 * 于是插件想让自己导航项要求一个新能力（例如 `review/approve`）时**做不到**：
 * 键不存在 ⇒ `caps?.[key] === true` 恒为假 ⇒ 那个入口**永远不出现、且没有任何日志**。
 * 插件作者会去查"注册为什么没生效"，而真正的问题是"这个能力根本没有地方能声明"。
 *
 * 现在它是「内置 ∪ 插件声明」：内置的在这里（封闭，用于角色推导），
 * 插件声明的走 {@link PLUGIN_CAPABILITY_NAME} 的命名空间（必须含 `/`）。
 */
export type BuiltinCapability = 'editContent' | 'administer' | 'manageVisibility'

/**
 * 全部内置能力。
 *
 * **顺序即契约**（与 `plugin-auth` 的角色推导、`web` 的导航校验同序），
 * 故用 `as const` 元组而不是 `Set`：消费方要按稳定顺序展示/比对。
 */
export const BUILTIN_CAPABILITIES = ['editContent', 'administer', 'manageVisibility'] as const

/**
 * **插件声明的能力名**：与插槽（`slots.ts` 的 `PLUGIN_SLOT_NAME`）同一条约定 ——
 * **必须含 `/`**。
 *
 * 为什么坚持斜杠：它把"内置名"与"插件名"切成两个不可能相撞的命名空间。
 * 于是"把内置名拼错"（`edtiContent`）仍然是一个**能被发现**的错误（不匹配任何一侧），
 * 而不是被当成某个插件的自定义能力静默放行 —— 后者会让一次拼写错误变成一次越权。
 */
export const PLUGIN_CAPABILITY_NAME = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/

/** 能力名：内置的三个，或任意插件声明的（含 `/`）名字 */
export type CapabilityName = BuiltinCapability | (string & {})

/** 该字符串是否是一个**内置**能力名 */
export function isBuiltinCapability(value: string): value is BuiltinCapability {
  return (BUILTIN_CAPABILITIES as readonly string[]).includes(value)
}

/** 该字符串是否是一个语法合法的**插件**能力名（必须含 `/`） */
export function isPluginCapability(value: string): value is CapabilityName {
  return PLUGIN_CAPABILITY_NAME.test(value)
}

/** 该字符串是否是可接受的能力名（内置 ∪ 插件命名空间） */
export function isCapabilityName(value: string): value is CapabilityName {
  return isBuiltinCapability(value) || isPluginCapability(value)
}

/**
 * **一次下发给某个主体的能力快照**：能力名 → 是否具备。
 *
 * 为什么是"开放键的映射"而不是固定三字段的接口：能力名现在可扩展（见上），
 * 接口形式会把扩展点重新钉死。代价是取值可能 `undefined` —— 但消费方**本来就**
 * 必须写成 `caps?.[key] === true`（失败关闭），所以这里不是新增负担，
 * 而是把一条**已经被遵守**的规则变成类型上唯一自然的写法。
 *
 * ⚠️ **缺失即不具备**（一律用 `=== true` 判定，绝不用 `!== false`）：
 * 未登录 / 加载中 / 能力键拼错 三种情况都必须落到"不显示、不放行"。
 */
export type CapabilitySet = Readonly<Record<string, boolean>>


/**
 * 一个能力的**声明**（清单里的静态部分，★ F9）。
 *
 * 为什么声明与求解器分开：声明是**可发现性**（管理界面能列出"这个插件引入了哪些能力"，
 * 诊断端点能报"谁声明了什么"），求解器是**判定**（运行期注入的同步函数）。
 * 两者分离的代价是一个真实且不易发现的失效形态 —— **声明了却没有注册求解器** ⇒
 * 该能力对所有主体恒为 `false` ⇒ 依赖它的导航项/路由**永远不出现、且没有报错**。
 * 这个形态由 manager 在激活后主动告警（见 `packages/manager/src/capabilities.ts`）。
 */
export interface CapabilityDecl {
  /** 必须落在插件命名空间（含 `/`），否则声明被拒绝并告警 */
  readonly name: CapabilityName
  /** 面向用户的名字；缺省回退到 `name` */
  readonly label?: string
  readonly description?: string
}

/* ==================== ★ F10：插件权限声明 ==================== */

/**
 * 插件声明自己会用到的**跨界能力**（★ F10）。
 *
 * ## 这份清单声明的到底是什么
 * 是"**这个插件要碰宿主进程之外/之下的东西**"，而不是"它被允许碰"。宿主**不做强制**
 * （插件与宿主同进程、同权限，这是当前架构的既知事实 —— 见审计报告 §3.2 与设计文档
 * 自认的「插件本就能执行任意代码」）。所以它的价值有三条，且都是真的：
 *
 * 1. **评审**：装一个第三方插件前，能一眼看到它要写文件、读环境变量、发外网请求。
 * 2. **可见**：`GET /api/plugins` 会带上声明，激活时也会打印一行。
 * 3. **可回归**：声明与实际用法的一致性由测试守卫（见下方 `requires` 推导）。
 *
 * ## 为什么只列"服务模型覆盖不到"的那些
 * 插件通过 `requires` 声明服务依赖（`database-provider` / `http-service` / `llm-service` …），
 * 那些**已经**表达了它的数据面与网络面。本清单只补服务表达不了的**环境面**：
 * 文件系统、环境变量、外网、进程、密钥。
 *
 * 把服务依赖也塞进来会让清单变成"把 requires 抄一遍"，从而失去信息量 ——
 * 一份什么都包含的清单，评审时等于什么都没说。
 */
export type PluginPermission =
  /** 读宿主文件系统（读配置、读内置文档、读插件目录…） */
  | 'fs:read'
  /** 写宿主文件系统（写数据目录、落盘附件、改配置…） */
  | 'fs:write'
  /** 读进程环境变量（`process.env`）—— 编排层的注入口，常含凭据 */
  | 'env'
  /** 对外发起网络请求（fetch / http(s) 客户端 / 监听端口） */
  | 'net'
  /** 影响进程生命周期（`process.exit` / 信号）—— 看门狗熔断属于此类 */
  | 'process'
  /** 读取 `config/secrets.json` 里的明文密钥 */
  | 'secrets'

/**
 * 全部权限取值（顺序即**危险度**升序：越靠后越难在事后收拾）。
 *
 * 顺序是有用的：`GET /api/plugins` 与管理台按这个顺序展示，于是"这个插件到底要什么"
 * 一眼扫过去就是从轻到重。用数组而不用 `Set`，因为消费方需要稳定顺序。
 */
export const PLUGIN_PERMISSIONS = [
  'fs:read',
  'env',
  'net',
  'fs:write',
  'process',
  'secrets',
] as const

/** 该字符串是否是一个已定义的权限取值 */
export function isPluginPermission(value: string): value is PluginPermission {
  return (PLUGIN_PERMISSIONS as readonly string[]).includes(value)
}

/** 权限的安全排序（未知取值排最后，不打乱已知项的相对顺序） */
export function sortPermissions(perms: readonly string[]): string[] {
  const rank = new Map<string, number>(PLUGIN_PERMISSIONS.map((p, i) => [p, i]))
  return [...new Set(perms)].sort((a, b) => (rank.get(a) ?? PLUGIN_PERMISSIONS.length) - (rank.get(b) ?? PLUGIN_PERMISSIONS.length))
}

/* ==================== ★ F13：插件 UI 资产路径规则 ==================== */

/**
 * 插件客户端 UI 资产的 URL 前缀：`<前缀>/<插件名>/<相对路径>`。
 *
 * ★ F13：从 core 根搬到这里（**浏览器安全**模块）—— 前端经
 * `@geewiki/core/domain` 直接取用，不再自己抄一份。理由见 `isPluginUiEntryPath` 的说明。
 *
 * 插件名**保持未编码**（`@geewiki/wiki` 就是两段），编码名一律不认——编码后
 * dev 下会落 Vite 的 SPA fallback（200 + text/html）、prod 下静态层不解码必 404。
 *
 * 原首行文档（保留以对照）：
 * 插件客户端 UI 资产的 URL 前缀：`<前缀>/<插件名>/<文件名单段>`。
 *
 * 插件名**保持未编码**（`@geewiki/wiki` 就是两段），编码名一律不认——编码后
 * dev 下会落 Vite 的 SPA fallback（200 + text/html）、prod 下静态层不解码必 404。
 *
 * 注意：`packages/web` 不 import 本包（core 顶层依赖 node:fs，不能进浏览器 bundle），
 * 前端在 `packages/web/src/lib/pluginUi.ts` 持有**同名副本**并互相注释指认；
 * 两侧行为由测试表的同一组用例钉住。
 */
export const PLUGIN_UI_PREFIX = '/plugins-ui'

/**
 * UI 资产**文件名**的单段校验（入口表与静态层共用同一张规则）：
 * 以字母/数字开头，其后允许字母、数字、`.`、`_`、`-`。
 *
 * 因此 `client.js`、`client.css`、`client-a1b2.js` 合法，而 `..`、`.env`、
 * `a/b.js`、`x y.js`、空串非法。无 `g` 标志，`test()` 无 lastIndex 状态。
 */
export const PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * UI 资产**相对路径**校验（`<PLUGIN_UI_PREFIX>/<插件名>/<本规则>`）：
 * 一个或多个 {@link PLUGIN_UI_FILE_SEGMENT} 形态的段，以 `/` 连接。
 *
 * 为什么需要它、而不是放宽 `PLUGIN_UI_FILE_SEGMENT`：后者是**入口表**
 * （`client.entry` / `client.css`）与静态层**共用**的"单段文件名"规则——
 * `packages/manager/src/plugin-ui.ts` 用它校验清单声明，`packages/web` 持有同名副本，
 * 两侧各有测试钉住"含 `/` 即非法"。改它的语义会让入口表也接受带斜杠的入口名
 * （那是另一件事，且是回归）。故此处**新增**一条更宽的规则，两者并存、各自表述意图。
 *
 * 安全语义（这是本规则存在的**主要**理由）：段必须以字母/数字开头，故 `..`、`.env`、
 * `.` 这类段天然非法；空段（`a//b`）、绝对路径（`/a`）、反斜杠（Windows 分隔符）、
 * 尾随斜杠、以及 `%`（任何百分号编码）也一律非法。
 * ⇒ 消费方**无需解码**即可安全使用：不解码，就没有 `%2e%2e`、`..%2f`
 * 与双重编码这一整类陷阱，也没有"先解码再校验"的顺序依赖。
 *
 * 无 `g` 标志，`test()` 无 lastIndex 状态。
 */
export const PLUGIN_UI_ASSET_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

/**
 * 资产相对路径的**最大段数**（含文件名）。纯粹是输入体积的兜底：
 * 真实产物（Vite 的 `assets/js/chunk-x.js`）远达不到这个深度。
 */
export const PLUGIN_UI_ASSET_MAX_DEPTH = 16

/**
 * ★ F13：插件 UI **入口/样式**的相对路径语法 —— 单段文件名**或**分层路径。
 *
 * ## 为什么不再要求单段
 * 原先 `geewiki.client.entry` / `.css` 必须满足 {@link PLUGIN_UI_FILE_SEGMENT}
 * （**不含 `/`**）。而产物形态是插件自己的事：用 Vite/Rollup 做多入口或分目录输出时，
 * 入口很自然落在 `ui/index.js`、样式落在 `styles/main.css`。此时插件只有两条路——
 * 把产物摊平（改构建配置去迁就宿主），或者**声明不了自己的 UI**（静默不加载，
 * 因为 `pluginUiEntryOf` 对非法名一律返回 `undefined`，日志里只有一条"没有产物"）。
 *
 * 第二条是审计报告 A4 记录的形态：**限制本身没有任何安全理由** ——
 * 静态资源层（`PLUGIN_UI_ASSET_PATH`）**早就**支持子目录，且四层防护
 * （段比较 `isContained()` + realpath + 严格不折叠空段 + 拒编码名）都在它那一侧。
 * 入口名多几个 `/` 不改变任何一条。
 *
 * ## 安全边界没有被放松
 * 判据复用 `PLUGIN_UI_ASSET_PATH`：每一段必须以 `[A-Za-z0-9]` 开头，因此
 * `..`、`.`、空段、绝对路径（`/x`）、含空格与 `%` 的段**全部不匹配**。
 * 于是 `entry: '../../etc/passwd'` 与 `entry: '/etc/passwd'` 都会被整体丢弃
 * （与改动前"非法即视为未声明"的失败方向一致：**不加载**，而不是加载到别处去）。
 * 深度上限与静态层同源（{@link PLUGIN_UI_ASSET_MAX_DEPTH}）。
 */
export function isPluginUiEntryPath(value: string): boolean {
  if (PLUGIN_UI_FILE_SEGMENT.test(value)) return true
  if (!value.includes('/')) return false
  return PLUGIN_UI_ASSET_PATH.test(value) && value.split('/').length <= PLUGIN_UI_ASSET_MAX_DEPTH
}

/* ============================== i18n（★ F15） ============================== */

/**
 * ★ F15：**宿主与插件共用一套 message catalog**。
 *
 * ## 为什么"共用一套"是这一项的重点，而不是"把界面翻译成英文"
 * 如果把 i18n 做成"前端自己搞一套、插件各自搞一套"，结果是：同一个界面里
 * 宿主说"知识库"、插件说"Wiki"，而且没有任何一处能看到**全部**待翻译的文案。
 * 所以本模块只定义**机制**：键的命名空间、回退链、缺失报告。谁提供文案都可以。
 *
 * ## 两条关键裁决（都在下面的实现里，且有守卫）
 *
 * **① 命名空间是强制的，不是约定。** 宿主文案键一律以 `host.` 开头，插件只能写自己
 * `plugin.<短名>.` 前缀下的键。这不是洁癖：若不限制，**任何插件都能覆盖宿主界面上的任意文案** ——
 * 一个"把'确认删除'改成'继续'"的插件能骗用户点下去。冲突在**装载时就拒绝并报告**，
 * 而不是靠"大家自觉别撞"。
 *
 * **② 回退链的最后一站是键本身，绝不留空。** 缺失时返回键名（如 `host.nav.wiki`）
 * 而不是空串或 `undefined`：空串会让界面**静默缺一块**，而键名在界面上一眼就能看出是漏了文案，
 * 同时 `missingKeys()` 能把缺口汇总给译者。这条对"未翻译完"的状态尤其重要 ——
 * 它让"翻译进度"变成可观测的，而不是靠人肉比对。
 */

/** 语言标记的实用子集：`zh`、`zh-CN`、`en`、`pt-BR`、`zh-Hant`。**不接受**任意字符串 */
export const LOCALE_CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/

export function isLocaleCode(value: string): boolean {
  return LOCALE_CODE.test(value)
}

/** 宿主内置文案的语言，同时也是回退链的终点 */
export const DEFAULT_LOCALE = 'zh-CN'

/** 取基语言（`pt-BR` → `pt`）；没有基语言时返回原值 */
export function baseLanguageOf(locale: string): string {
  const i = locale.indexOf('-')
  return i === -1 ? locale : locale.slice(0, i)
}

/**
 * 按优先级列出回退链（**去重、保持顺序**）：
 * `pt-BR` → `pt` → `DEFAULT_LOCALE` → 基语言（若不同）。
 *
 * 最后一站的基语言是刻意的：`DEFAULT_LOCALE` 是 `zh-CN`，若只回退到它，
 * 一个只填了 `zh` 的目录就会在缺 `host.*` 时直接落到键名 —— 而 `zh` 与 `zh-CN`
 * 在绝大多数人的认知里是同一份文案。
 */
export function fallbackChain(locale: string): string[] {
  const out: string[] = []
  const push = (v: string): void => {
    if (v !== '' && !out.includes(v)) out.push(v)
  }
  push(locale)
  push(baseLanguageOf(locale))
  push(DEFAULT_LOCALE)
  push(baseLanguageOf(DEFAULT_LOCALE))
  return out
}

/** 宿主文案键的强制前缀 */
export const HOST_MESSAGE_PREFIX = 'host.'
/** 插件文案键的强制前缀（后面必须紧跟插件的短名） */
export const PLUGIN_MESSAGE_PREFIX = 'plugin.'

/**
 * 插件短名 → 它可用的键前缀。
 * 用**短名**而不是全名：键里不该出现 `@scope/` 这种在标识符里别扭的字符，
 * 而插件名里的 scope 已经由管理器负责唯一性（重名会在装载时被报为冲突）。
 */
export function pluginMessagePrefixOf(pluginName: string): string {
  const i = pluginName.lastIndexOf('/')
  const short = i === -1 ? pluginName : pluginName.slice(i + 1)
  return `${PLUGIN_MESSAGE_PREFIX}${short}.`
}

/** 键的完整语法：`host.a.b` 或 `plugin.<短名>.a.b`（小写字母数字与 `.`/`-`，段内不得为空） */
export const MESSAGE_KEY =
  /^(?:host|plugin\.[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/

export function isMessageKey(value: string): boolean {
  return MESSAGE_KEY.test(value)
}

/** 键的归属：宿主、某个插件（短名）、或非法 */
export function messageKeyOwner(key: string): { kind: 'host' } | { kind: 'plugin'; plugin: string } | undefined {
  if (!isMessageKey(key)) return undefined
  if (key.startsWith(HOST_MESSAGE_PREFIX)) return { kind: 'host' }
  const rest = key.slice(PLUGIN_MESSAGE_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0) return undefined
  return { kind: 'plugin', plugin: rest.slice(0, dot) }
}

/** 一份 catalog：键 → 文案模板（`{name}` 为占位符） */
export type MessageCatalog = Readonly<Record<string, string>>

/** 插值占位符：`{name}`（**只认标识符形态**，避免把 `{}` 这类文本误当占位符） */
export const MESSAGE_PARAM = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

/**
 * 占位符替换。**这不是 HTML 模板**：不转义、不解析标记 —— 文案是纯文本，
 * 要展示富文本请由调用方自己走消毒链（宿主对 Markdown 的处理见 `sanitize.ts`）。
 *
 * 未提供的参数**保留原样**（`{name}`）而不是替换成 `undefined` 或空串：
 * 前者一眼能看出是漏传参数，后者会静默产出一句读不通的话。
 */
export function interpolate(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (params === undefined) return template
  return template.replace(MESSAGE_PARAM, (whole, name: string) => {
    const v = params[name]
    return v === undefined ? whole : String(v)
  })
}

export interface ResolveResult {
  /** 最终用于展示的文本：**任何情况下都不是空串**（最差是键名本身） */
  readonly text: string
  /** 实际命中该文案的语言；未命中时为 `null` */
  readonly locale: string | null
  readonly key: string
  /** 是否为缺口（`true` 时 `text === key`） */
  readonly missing: boolean
}

/**
 * 在"语言 → catalog"的映射里按键解析文案。
 *
 * 回退顺序由 {@link fallbackChain} 决定；**任何一层都没命中就返回键名并标记 `missing`**。
 * 返回值带 `locale`/`missing` 而不是只给字符串，是为了让调用方（管理台、`--verify` 式的体检）
 * 能统计翻译进度，而不是只能看到界面上冒出几个键名。
 */
export function resolveMessage(
  catalogs: Readonly<Record<string, MessageCatalog>>,
  locale: string,
  key: string,
  params?: Readonly<Record<string, string | number>>,
): ResolveResult {
  for (const candidate of fallbackChain(locale)) {
    const raw = catalogs[candidate]?.[key]
    if (typeof raw === 'string' && raw !== '') {
      return { text: interpolate(raw, params), locale: candidate, key, missing: false }
    }
  }
  return { text: key, locale: null, key, missing: true }
}

/** 在给定语言下**完全无法解析**的键（缺口汇总，供管理台与译者用） */
export function missingKeys(
  catalogs: Readonly<Record<string, MessageCatalog>>,
  locale: string,
  keys: readonly string[],
): string[] {
  return keys.filter((k) => resolveMessage(catalogs, locale, k).missing)
}

export interface MergeCatalogsResult {
  /** 合并后的 catalog（键 → 文案） */
  readonly merged: MessageCatalog
  /** 被**拒绝**的条目：越权的键或非法键（含原因），必须显式暴露而不是静默丢弃 */
  readonly rejected: readonly { readonly key: string; readonly owner: string; readonly reason: string }[]
  /** 同一命名空间内的重复键（先到者保留） */
  readonly conflicts: readonly string[]
}

/**
 * 合并多家 catalog，**强制命名空间**。
 *
 * @param contributions 每一条注明**谁提供的**（宿主用 `null`）。用 `owner` 而不是直接合并 `Record`
 *   是有意的：没有 owner 就无法判断"这个键该不该由它提供"，也就不可能拒绝越权。
 */
export function mergeCatalogs(
  contributions: readonly { readonly owner: string | null; readonly catalog: MessageCatalog }[],
): MergeCatalogsResult {
  const merged: Record<string, string> = {}
  const rejected: { key: string; owner: string; reason: string }[] = []
  const conflicts: string[] = []

  for (const { owner, catalog } of contributions) {
    const label = owner ?? '(宿主)'
    const allowed = owner === null ? HOST_MESSAGE_PREFIX : pluginMessagePrefixOf(owner)
    for (const [key, value] of Object.entries(catalog)) {
      if (!isMessageKey(key)) {
        rejected.push({ key, owner: label, reason: '键名不符合语法（应为 host.* 或 plugin.<短名>.*）' })
        continue
      }
      if (!key.startsWith(allowed)) {
        rejected.push({
          key,
          owner: label,
          reason:
            owner === null
              ? '宿主文案键必须以 host. 开头'
              : `插件只能提供 ${allowed} 前缀下的键（否则可覆盖宿主或其它插件的界面文案）`,
        })
        continue
      }
      if (typeof value !== 'string') {
        rejected.push({ key, owner: label, reason: '文案必须是字符串' })
        continue
      }
      if (key in merged) {
        conflicts.push(key)
        continue
      }
      merged[key] = value
    }
  }
  return { merged, rejected, conflicts }
}
