/**
 * ★ F15：插件文案目录聚合的守卫。
 *
 * 这一层的两个失效都不是"报错"型的，所以必须静态钉住：
 * 1. **路径穿越**：`locales` 的值来自**第三方提供的清单**。若直接 `join(dir, value)`，
 *    `../../../../etc/passwd` 会把任意文件当文案读走，并经 `GET /api/i18n/:locale`
 *    （**public** 端点）原样下发。
 * 2. **静默跳过**：路径写错时若只跳过不报告，表现是"某插件的界面莫名其妙全是键名"，
 *    而没有任何线索指向清单里那一行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisteredPlugin } from '../src/deps.js'
import {
  MAX_CATALOG_BYTES,
  availableLocales,
  catalogStats,
  collectLocaleDecls,
  flattenFor,
  loadCatalogsFor,
} from '../src/i18n.js'

function sandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'gw-i18n-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 造一个"插件"注册表条目（只需要本模块用到的字段） */
function entry(dir: string, name: string, locales: Record<string, string>): RegisteredPlugin {
  return {
    name,
    manifest: { name, version: '1.0.0', geewiki: { displayName: name, locales } },
    module: { name, apply: () => {} },
    dir,
  } as unknown as RegisteredPlugin
}

function writeCatalog(dir: string, rel: string, content: unknown): void {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

/* ------------------------------ 声明收集 ------------------------------ */

test('★ F15：locales 路径不得逃出插件目录（清单是第三方提供的文件）', () => {
  const env = sandbox()
  try {
    const pluginDir = join(env.root, 'plugin')
    mkdirSync(pluginDir, { recursive: true })
    // 就在插件目录外放一个"绝密文件"，验证它读不到
    writeFileSync(join(env.root, 'secret.json'), JSON.stringify({ 'host.x': 'SECRET' }), 'utf8')
    writeCatalog(pluginDir, 'locales/zh-CN.json', { 'plugin.demo.a': 'A' })

    const { decls, issues } = collectLocaleDecls([
      entry(pluginDir, '@geewiki-plugin/demo', {
        'zh-CN': 'locales/zh-CN.json',
        en: '../../../secret.json',
        'zh-TW': '/etc/passwd',
        'x!!': 'locales/zh-CN.json',
      }),
    ])
    // 合法的留下了
    assert.deepEqual(Object.keys(decls[0]!.locales), ['zh-CN'])
    const codes = issues.map((i) => i.code).sort()
    assert.deepEqual(codes, ['invalid_locale', 'invalid_path', 'path_escapes_plugin'])
    assert.match(issues.find((i) => i.code === 'path_escapes_plugin')!.message, /插件目录之外/)
  } finally {
    env.cleanup()
  }
})

test('★ F15：声明了 locales 但注册表没有插件目录时，报 plugin_dir_unknown 而不是猜一个', () => {
  const env = sandbox()
  try {
    const e = entry(join(env.root, 'nowhere'), '@geewiki-plugin/demo', { en: 'locales/en.json' })
    const { issues } = collectLocaleDecls([{ ...e, dir: undefined } as unknown as RegisteredPlugin])
    assert.deepEqual(issues.map((i) => i.code), ['plugin_dir_unknown'])
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 装载与合并 ------------------------------ */

test('★ F15：合并多家插件文案，并下发整条回退链', () => {
  const env = sandbox()
  try {
    const a = join(env.root, 'a')
    const b = join(env.root, 'b')
    writeCatalog(a, 'locales/zh-CN.json', { 'plugin.alpha.t': '甲' })
    writeCatalog(b, 'locales/zh-CN.json', { 'plugin.beta.t': '乙' })
    writeCatalog(b, 'locales/en.json', { 'plugin.beta.t': 'B' })

    const { decls } = collectLocaleDecls([
      entry(a, '@geewiki-plugin/alpha', { 'zh-CN': 'locales/zh-CN.json' }),
      entry(b, '@geewiki-plugin/beta', { 'zh-CN': 'locales/zh-CN.json', en: 'locales/en.json' }),
    ])
    const resolved = loadCatalogsFor(decls, 'en')
    assert.deepEqual(resolved.chain, ['en', 'zh-CN', 'zh'], 'en 的链应含默认语言（缺译时回退）')
    assert.equal(resolved.catalogs['en']!['plugin.beta.t'], 'B')
    // alpha 没有 en 译文，但它的 zh-CN 仍在链上 —— 前端因此能回退而不是显示键名
    assert.equal(resolved.catalogs['zh-CN']!['plugin.alpha.t'], '甲')
    assert.deepEqual(resolved.issues, [])

    // flattenFor：链首优先（en 覆盖 zh-CN）
    const flat = flattenFor(resolved)
    assert.equal(flat['plugin.beta.t'], 'B')
    assert.equal(flat['plugin.alpha.t'], '甲')
  } finally {
    env.cleanup()
  }
})

test('★ F15：坏文件逐类报 issue，而不是静默跳过', () => {
  const env = sandbox()
  try {
    const dir = join(env.root, 'p')
    writeCatalog(dir, 'locales/bad-json.json', '{ not json')
    writeCatalog(dir, 'locales/array.json', [1, 2, 3])
    writeCatalog(dir, 'locales/huge.json', JSON.stringify({ 'plugin.p.big': 'x'.repeat(MAX_CATALOG_BYTES + 10) }))
    const { decls } = collectLocaleDecls([
      entry(dir, '@geewiki-plugin/p', {
        'zh-CN': 'locales/bad-json.json',
        en: 'locales/array.json',
        fr: 'locales/huge.json',
        de: 'locales/missing.json',
      }),
    ])
    // 注意：一次装载只会走**请求语言的回退链**，所以四类坏文件要分别按它们所在的语言装载，
    // 取并集才能看到全部 issue（第一版只请求了 zh-CN，链上根本没有 en/fr/de，
    // 于是另外三个坏文件压根没被读到 —— 这类"我以为测到了"的假象由本行注释钉住）。
    const codes = new Set<string>()
    for (const locale of ['zh-CN', 'en', 'fr', 'de']) {
      for (const issue of loadCatalogsFor(decls, locale).issues) codes.add(issue.code)
    }
    assert.equal(codes.has('invalid_json'), true)
    assert.equal(codes.has('not_an_object'), true)
    assert.equal(codes.has('too_large'), true)
    assert.equal(codes.has('missing_file'), true)
    // 每一类都要能被区分开 —— 只报"读失败"会让作者不知道改哪里
    for (const locale of ['zh-CN', 'en', 'fr', 'de']) {
      assert.equal(loadCatalogsFor(decls, locale).issues.every((i) => i.message.length > 0), true)
    }
  } finally {
    env.cleanup()
  }
})

test('★ F15：越权的键（改宿主/改别人）会在装载时被拒绝并出现在 issues 里', () => {
  const env = sandbox()
  try {
    const dir = join(env.root, 'p')
    writeCatalog(dir, 'locales/zh-CN.json', {
      'plugin.p.ok': '好',
      'host.nav.wiki': '点我删除',
    })
    const { decls } = collectLocaleDecls([entry(dir, '@geewiki-plugin/p', { 'zh-CN': 'locales/zh-CN.json' })])
    const resolved = loadCatalogsFor(decls, 'zh-CN')
    assert.equal(resolved.catalogs['zh-CN']!['host.nav.wiki'], undefined, '插件不得覆盖宿主文案')
    const rejected = resolved.issues.filter((i) => i.code === 'key_rejected')
    assert.equal(rejected.length, 1)
    assert.match(rejected[0]!.message, /host\.nav\.wiki/)
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 语言清单 ------------------------------ */

test('★ F15：可选语言集合含默认语言；catalogStats 给出翻译进度', () => {
  const env = sandbox()
  try {
    const dir = join(env.root, 'p')
    writeCatalog(dir, 'locales/en.json', { 'plugin.p.a': 'A', 'plugin.p.b': 'B' })
    const { decls } = collectLocaleDecls([entry(dir, '@geewiki-plugin/p', { en: 'locales/en.json' })])

    const locales = availableLocales(decls)
    assert.equal(locales.includes('zh-CN'), true, '默认语言必须始终可选（宿主自带文案）')
    assert.equal(locales.includes('en'), true)

    const stats = catalogStats(decls)
    const en = stats.find((s) => s.locale === 'en')!
    assert.equal(en.keys, 2)
    assert.equal(en.plugins, 1)
    const zh = stats.find((s) => s.locale === 'zh-CN')!
    assert.equal(zh.keys, 0, 'zh-CN 下该插件没有译文（翻译进度可观测）')
  } finally {
    env.cleanup()
  }
})
