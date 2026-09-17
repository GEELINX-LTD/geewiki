/**
 * ★ F15：**插件文案目录的聚合**（宿主与插件共用一套 message catalog 的服务端半边）。
 *
 * ## 分工
 * - **宿主自己的文案**随前端产物打包（`packages/web/src/locales/*.json`），不经过这里 ——
 *   它是首屏就要用的文本，多一次往返只会让界面先闪一段键名。
 * - **插件的文案**由本模块从各插件目录读取、按命名空间合并，经 `GET /api/i18n/:locale` 下发。
 *
 * ## 为什么返回整条**回退链**的 catalog，而不是只返回请求的那一种
 * 缺失时的回退发生在**客户端**（`resolveMessage`）。若只下发请求语言，客户端手里就没有
 * `zh-CN` 的插件译文，一个只填了 `en` 的插件在 `zh-CN` 用户那里会退化成键名 ——
 * 而正确行为是回退到 DEFAULT。一次把链条上的语言都取回来，既避免多次往返，
 * 也让"回退"这件事只有**一处**实现（core 的 `fallbackChain`），不会前后端各写一份。
 *
 * ## 两道防护（都在用例里）
 * 1. **路径穿越**：`locales` 的值是相对于插件目录的路径。清单是可以被第三方提供的文件，
 *    若直接 `join(dir, value)` 就信任它，`../../../../etc/passwd` 会把任意文件当文案读走，
 *    并经公开接口下发。故逐条 `isInsideDir` 校验。
 * 2. **超大文件**：一个插件可以声明指向一个几 GB 的文件。读取前先看体积，
 *    超过上限就拒绝并报 issue —— 而不是先读进内存再判断。
 *
 * 两类问题都走 `issues` 显式暴露，**不静默跳过**：跳过的后果是"某插件的界面莫名其妙全是键名"，
 * 而没有任何线索指向"它的 locales 路径写错了"。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  DEFAULT_LOCALE,
  fallbackChain,
  isLocaleCode,
  mergeCatalogs,
  type MessageCatalog,
} from '@geewiki/core'
import { isInsideDir } from './discovery.js'
import type { RegisteredPlugin } from './deps.js'

/** 单个 catalog 文件的体积上限（文案是纯文本；2 MiB 已远超任何合理的界面文案量） */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024

export interface LocaleDecl {
  readonly plugin: string
  /** 语言 → 已校验为"插件目录内的绝对路径" */
  readonly locales: Readonly<Record<string, string>>
}

export interface CatalogIssue {
  /** 机器可读的分类（与 `DiscoveryIssue` 同风格） */
  readonly code:
    | 'invalid_locale'
    | 'invalid_path'
    | 'path_escapes_plugin'
    | 'missing_file'
    | 'too_large'
    | 'invalid_json'
    | 'not_an_object'
    | 'plugin_dir_unknown'
    /** 键被 `mergeCatalogs` 拒绝（越权命名空间或键名非法） */
    | 'key_rejected'
    /** 同一个键被多个插件提供（短名撞车），先到者保留 */
    | 'key_conflict'
  readonly plugin: string
  readonly locale: string
  readonly message: string
}

/**
 * 从注册表收集各插件的文案声明。
 *
 * 只接受**确实落在插件目录内**的路径；`dir` 未知（理论上有，例如测试里构造的替身条目）
 * 时报 `plugin_dir_unknown` 而不是猜一个目录。
 */
export function collectLocaleDecls(entries: readonly RegisteredPlugin[]): {
  decls: LocaleDecl[]
  issues: CatalogIssue[]
} {
  const decls: LocaleDecl[] = []
  const issues: CatalogIssue[] = []
  for (const entry of entries) {
    const declared = entry.manifest.geewiki.locales
    if (declared === undefined) continue
    const plugin = entry.name
    const dir = entry.dir
    if (dir === undefined) {
      issues.push({
        code: 'plugin_dir_unknown',
        plugin,
        locale: '',
        message: '该插件声明了 locales，但注册表里没有它的目录，无法定位文案文件',
      })
      continue
    }
    const locales: Record<string, string> = {}
    for (const [locale, relPath] of Object.entries(declared)) {
      if (!isLocaleCode(locale)) {
        issues.push({
          code: 'invalid_locale',
          plugin,
          locale,
          message: `语言标记不合法（应为 zh / zh-CN / en / pt-BR 这类形态）：${JSON.stringify(locale)}`,
        })
        continue
      }
      if (typeof relPath !== 'string' || relPath === '' || isAbsolute(relPath)) {
        issues.push({
          code: 'invalid_path',
          plugin,
          locale,
          message: `locales["${locale}"] 必须是相对插件目录的非空路径：${JSON.stringify(relPath)}`,
        })
        continue
      }
      const abs = resolve(dir, relPath)
      // 清单是**第三方提供的文件**：`../../…` 会把任意文件当文案读走并经公开接口下发
      if (!isInsideDir(resolve(dir), abs)) {
        issues.push({
          code: 'path_escapes_plugin',
          plugin,
          locale,
          message: `locales["${locale}"] 指向插件目录之外（${relPath}），已拒绝`,
        })
        continue
      }
      locales[locale] = abs
    }
    decls.push({ plugin, locales })
  }
  return { decls, issues }
}

/** 某个语言下，所有插件都**声明过**的语言集合（含宿主内置语言，它总是可选） */
export function availableLocales(decls: readonly LocaleDecl[]): string[] {
  const set = new Set<string>([DEFAULT_LOCALE])
  for (const d of decls) for (const locale of Object.keys(d.locales)) set.add(locale)
  return [...set].sort()
}

export interface ResolvedCatalogs {
  /** 实际下发的语言（请求语言的回退链） */
  readonly chain: readonly string[]
  /** 语言 → 合并后的 catalog（**只含插件贡献**；宿主文案在前端产物里） */
  readonly catalogs: Readonly<Record<string, MessageCatalog>>
  readonly issues: readonly CatalogIssue[]
}

/** 读取并合并某个语言下全部插件的 catalog */
export function loadCatalogsFor(
  decls: readonly LocaleDecl[],
  requested: string,
  options: { readonly maxBytes?: number } = {},
): ResolvedCatalogs {
  const chain = fallbackChain(requested)
  const maxBytes = options.maxBytes ?? MAX_CATALOG_BYTES
  const catalogs: Record<string, MessageCatalog> = {}
  const issues: CatalogIssue[] = []
  const rejected: { owner: string; key: string; reason: string }[] = []
  const conflicts: string[] = []

  for (const locale of chain) {
    const contributions: { owner: string | null; catalog: MessageCatalog }[] = []
    for (const decl of decls) {
      const path = decl.locales[locale]
      if (path === undefined) continue
      if (!existsSync(path)) {
        issues.push({ code: 'missing_file', plugin: decl.plugin, locale, message: `文案文件不存在：${path}` })
        continue
      }
      const size = statSync(path).size
      if (size > maxBytes) {
        issues.push({
          code: 'too_large',
          plugin: decl.plugin,
          locale,
          message: `文案文件 ${size} 字节，超过上限 ${maxBytes}（读取前即拒绝，不先进内存）`,
        })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch (err) {
        issues.push({
          code: 'invalid_json',
          plugin: decl.plugin,
          locale,
          message: `文案文件不是合法 JSON（${path}）：${(err as Error).message}`,
        })
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        issues.push({
          code: 'not_an_object',
          plugin: decl.plugin,
          locale,
          message: `文案文件顶层必须是「键 → 文案」的对象（${path}）`,
        })
        continue
      }
      contributions.push({ owner: decl.plugin, catalog: parsed as MessageCatalog })
    }
    // `mergeCatalogs` 负责强制命名空间：插件只能写 plugin.<短名>.* ，越权键会被拒绝并报告
    const merged = mergeCatalogs(contributions)
    for (const r of merged.rejected) rejected.push({ owner: r.owner, key: r.key, reason: r.reason })
    for (const c of merged.conflicts) conflicts.push(c)
    catalogs[locale] = merged.merged
  }

  for (const r of rejected) {
    issues.push({
      code: 'key_rejected',
      plugin: r.owner,
      locale: requested,
      message: `键 ${JSON.stringify(r.key)} 被拒绝：${r.reason}`,
    })
  }
  for (const key of conflicts) {
    issues.push({
      code: 'key_conflict',
      plugin: '(多个)',
      locale: requested,
      message: `键 ${JSON.stringify(key)} 被多个插件提供，先到者保留（插件短名撞车？）`,
    })
  }
  return { chain, catalogs, issues }
}

/** 供 CLI/管理台做"翻译进度"体检：列出各语言已提供的键数 */
export function catalogStats(
  decls: readonly LocaleDecl[],
): { locale: string; plugins: number; keys: number; issues: number }[] {
  return availableLocales(decls).map((locale) => {
    const resolved = loadCatalogsFor(decls, locale)
    const keys = Object.values(resolved.catalogs).reduce((n, c) => n + Object.keys(c).length, 0)
    return {
      locale,
      plugins: decls.filter((d) => d.locales[locale] !== undefined).length,
      keys,
      issues: resolved.issues.length,
    }
  })
}

/**
 * 把回退链上的插件 catalog 摊平成单层对象（**前者优先**：链上更靠前的语言覆盖靠后的）。
 * 宿主侧只需要"某个键的文案是什么"，不必关心它来自哪个插件或哪个语言。
 */
export function flattenFor(resolved: ResolvedCatalogs): MessageCatalog {
  const out: Record<string, string> = {}
  // 倒序 assign：链首（最优先）最后写入，从而覆盖后面的
  for (const locale of [...resolved.chain].reverse()) Object.assign(out, resolved.catalogs[locale] ?? {})
  return out
}
