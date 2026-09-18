/**
 * ★ F15：宿主侧 i18n —— **与插件共用同一套 message catalog**。
 *
 * ## 这一层做什么、不做什么
 * - **做**：把宿主的文案目录（随前端产物打包的 `src/locales/*.json`）与**插件贡献的**文案
 *   （经 `GET /api/i18n/:locale` 下发）合成同一张查询表，并用 core 的 `resolveMessage`
 *   做回退与插值。宿主与插件因此**走的是同一条解析路径** —— 这就是"共用一套 catalog"的落点。
 * - **不做**：不改存量界面。宿主现有界面的中文是**硬编码**的，全量抽键是一次机械但浩大的改造，
 *   本轮**没有**做。
 *   已接入的是外壳（`<html lang>`、语言切换）与一个示范页面（`NotFoundPage`），
 *   目的是让机制**真的在跑**而不是一段没人调用的死代码。
 *
 * ## 三条裁决
 * 1. **宿主文案随产物打包、不走接口**：首屏就要用，多一次往返只会让界面先闪一段键名。
 *    插件文案走接口，因为它的内容由插件目录决定，打不进宿主 bundle。
 * 2. **语言选择存在 `localStorage`，不进服务端**：它是**展示偏好**，不是身份或权限。
 *    存服务端会让"换台机器"与"换个人"变成同一个问题，也会给匿名首访加一次写请求。
 * 3. **插件文案的前缀由 core 强制**（`plugin.<短名>.`）。客户端这里不再校验 ——
 *    服务端 `mergeCatalogs` 已经拒绝过越权键，前端重复一份判据只会多一处会漂移的地方。
 */
import {
  DEFAULT_LOCALE,
  fallbackChain,
  isLocaleCode,
  mergeCatalogs,
  resolveMessage,
  type MessageCatalog,
} from '@geewiki/core/domain'
import en from '../locales/en.json'
import zhCN from '../locales/zh-CN.json'

/** 宿主自带文案（随产物打包） */
const HOST_CATALOGS: Readonly<Record<string, MessageCatalog>> = {
  'zh-CN': zhCN as MessageCatalog,
  en: en as MessageCatalog,
}

/** 语言偏好在本机的存储键 */
export const LOCALE_STORAGE_KEY = 'geewiki.locale'

/**
 * 插件贡献的文案（语言 → catalog），由 `loadPluginCatalogs()` 从接口填充。
 * **初始为空**：首帧绝不等网络 —— 宿主文案已足够渲染外壳，插件文案到了再通知重渲染。
 */
let pluginCatalogs: Record<string, MessageCatalog> = {}

/** 当前语言；`null` 表示还没初始化（`initI18n` 会从存储/浏览器语言里定一个） */
let currentLocale: string = DEFAULT_LOCALE

type Listener = () => void
const listeners = new Set<Listener>()

/** 快照版本号：`useSyncExternalStore` 要求 `getSnapshot` 返回**引用稳定**的值 */
let snapshotVersion = 0

function emit(): void {
  snapshotVersion += 1
  for (const l of listeners) l()
}

export function subscribeI18n(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 供 `useSyncExternalStore` 用：单调递增的版本号（数值比对象更适合做快照） */
export function i18nSnapshot(): number {
  return snapshotVersion
}

export function getLocale(): string {
  return currentLocale
}

/** 可选语言：宿主自带的那些 ∪ 服务端报告的那些（去重、排序、默认语言恒在最前） */
let serverLocales: string[] = []
export function availableLocales(): string[] {
  const set = new Set<string>([...Object.keys(HOST_CATALOGS), ...serverLocales])
  set.add(DEFAULT_LOCALE)
  return [...set].sort((a, b) => (a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b)))
}

/**
 * 某一刻生效的查询表：宿主文案 + 插件文案，按语言合并。
 *
 * 合并顺序上**插件在后**是有意的：两者命名空间不重叠（`host.` vs `plugin.<短名>.`），
 * 所以顺序其实无关紧要 —— 但把"插件不能覆盖宿主"这件事做成**结构上不可能**，
 * 比依赖"我们记得别撞键"要可靠。
 */
function catalogsNow(): Record<string, MessageCatalog> {
  const out: Record<string, MessageCatalog> = {}
  for (const locale of Object.keys(HOST_CATALOGS)) out[locale] = { ...HOST_CATALOGS[locale] }
  for (const [locale, catalog] of Object.entries(pluginCatalogs)) {
    out[locale] = { ...(out[locale] ?? {}), ...catalog }
  }
  return out
}

/**
 * 取文案。**永远返回非空字符串**（最差是键名本身）—— 见 core 的 `resolveMessage`：
 * 空串会让界面**静默缺一块**，而键名在界面上一眼就能看出是漏了文案。
 */
export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  return resolveMessage(catalogsNow(), currentLocale, key, params).text
}

/** 带诊断信息的取值（管理台、语言体检用）：能知道命中了哪种语言、是否缺口 */
export function tDetailed(key: string, params?: Readonly<Record<string, string | number>>) {
  return resolveMessage(catalogsNow(), currentLocale, key, params)
}

/** 把语言写到 `<html lang>`：屏幕阅读器与浏览器断词据此工作，漏了会让中文被按英文断词 */
function applyDocumentLang(locale: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}

/**
 * 拉取插件文案。**失败不抛错**：文案拉不到只应让插件那部分显示为键名，
 * 而不是把整页渲染带崩（这是首屏路径上的一条网络请求）。
 */
export async function loadPluginCatalogs(locale: string): Promise<{ ok: boolean; issues: number }> {
  try {
    const res = await fetch(`/api/i18n/${encodeURIComponent(locale)}`, { headers: { accept: 'application/json' } })
    if (!res.ok) return { ok: false, issues: 0 }
    const body = (await res.json()) as { catalogs?: Record<string, MessageCatalog>; issues?: unknown[] }
    const catalogs = body.catalogs ?? {}
    // 服务端已经按命名空间合并并下发了整条回退链；这里只做"覆盖式替换"，
    // 避免第二次 `setLocale` 时旧的插件文案残留在别的语言下。
    pluginCatalogs = catalogs
    emit()
    return { ok: true, issues: Array.isArray(body.issues) ? body.issues.length : 0 }
  } catch {
    return { ok: false, issues: 0 }
  }
}

/** 切换语言：写存储 → 刷新 `<html lang>` → 拉插件文案 → 通知订阅者 */
export async function setLocale(locale: string): Promise<void> {
  if (!isLocaleCode(locale)) return
  currentLocale = locale
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // 隐私模式下 localStorage 会抛；语言偏好丢失可以接受，不该让切换整个失败
  }
  applyDocumentLang(locale)
  emit()
  await loadPluginCatalogs(locale)
}

/**
 * 选定初始语言，优先级：
 * ① 本机存储的选择（用户的显式决定，最高）→ ② `navigator.languages` 里第一个能匹配上的
 * （精确匹配 `zh-CN`，或基语言匹配 `zh`）→ ③ `DEFAULT_LOCALE`。
 *
 * 不自动信任 `navigator.language` 的**任意**取值：它可能是一个我们没有任何译文的语言，
 * 那样首屏会整片变成键名。只有当它能落到一条我们**确实有宿主文案**的语言上才采用。
 */
export function resolveInitialLocale(): string {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored !== null && isLocaleCode(stored)) return stored
  } catch {
    // 同上：读不到就继续用后面的判据
  }
  const known = new Set([...Object.keys(HOST_CATALOGS), ...serverLocales])
  const candidates =
    typeof navigator === 'undefined'
      ? []
      : [...(navigator.languages ?? []), navigator.language].filter((x): x is string => typeof x === 'string')
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate
    for (const base of fallbackChain(candidate)) if (known.has(base)) return base
  }
  return DEFAULT_LOCALE
}

/**
 * 初始化：定初始语言 → 写 `<html lang>` → 拉插件文案与可选语言列表。
 * 在 `main.tsx` 里调用一次（渲染之前），且**不阻塞渲染**。
 */
export function initI18n(): void {
  currentLocale = resolveInitialLocale()
  applyDocumentLang(currentLocale)
  void (async () => {
    try {
      const res = await fetch('/api/i18n', { headers: { accept: 'application/json' } })
      if (res.ok) {
        const body = (await res.json()) as { locales?: string[] }
        if (Array.isArray(body.locales)) serverLocales = body.locales.filter((l) => isLocaleCode(l))
      }
    } catch {
      // 服务端不可用时就只有宿主自带的语言；这是可接受的降级
    }
    await loadPluginCatalogs(currentLocale)
  })()
}

/**
 * 插件能否提供合法文案？供守卫用（也是"共用一套键空间"的判据实现处）。
 * 客户端不做强制，只做检查 —— 强制在服务端的 `mergeCatalogs`。
 */
export function checkPluginCatalog(pluginName: string, catalog: MessageCatalog): string[] {
  return mergeCatalogs([{ owner: pluginName, catalog }]).rejected.map((r) => `${r.key}: ${r.reason}`)
}
