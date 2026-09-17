/**
 * ★ F15：i18n 契约的守卫（宿主与插件**共用**一套 catalog 的那一半）。
 *
 * 这里钉的不是"能不能查出一条文案"，而是三条**会让机制悄悄失效**的性质：
 * 1. **命名空间是强制的**：《一个插件能改写宿主界面文案》不是洁癖问题 ——
 *    它意味着"把『确认删除』改成『继续』"可以由任意插件完成。
 * 2. **解析结果永不为空串**：空串让界面静默缺一块；键名则一眼可见，且可被 `missingKeys` 汇总。
 * 3. **回退链是确定的**：`pt-BR` → `pt` → `zh-CN` → `zh`，顺序不能靠"碰巧"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LOCALE,
  baseLanguageOf,
  fallbackChain,
  interpolate,
  isLocaleCode,
  isMessageKey,
  mergeCatalogs,
  messageKeyOwner,
  missingKeys,
  pluginMessagePrefixOf,
  resolveMessage,
} from '../src/domain.js'

/* --------------------------- 语言标记与回退 --------------------------- */

test('★ F15：只接受形态合法的语言标记（它会进 URL 与语言码比较）', () => {
  for (const ok of ['zh', 'zh-CN', 'en', 'pt-BR', 'zh-Hant', 'es-419']) {
    assert.equal(isLocaleCode(ok), true, `${ok} 应当合法`)
  }
  for (const bad of ['', 'ZH', 'zh_CN', 'zh-CN-', '../etc', 'zh CN', 'x', 'toolong']) {
    assert.equal(isLocaleCode(bad), false, `${JSON.stringify(bad)} 应当被拒绝`)
  }
})

test('★ F15：回退链的顺序是确定的，且末尾覆盖 DEFAULT 的基语言', () => {
  assert.deepEqual(fallbackChain('pt-BR'), ['pt-BR', 'pt', DEFAULT_LOCALE, baseLanguageOf(DEFAULT_LOCALE)])
  // `zh` 自己就应该只落到 zh → zh-CN（去重、保持顺序）
  assert.deepEqual(fallbackChain('zh'), ['zh', DEFAULT_LOCALE])
  // 默认语言本身不该在链里重复出现
  const chain = fallbackChain(DEFAULT_LOCALE)
  assert.deepEqual(chain, [DEFAULT_LOCALE, baseLanguageOf(DEFAULT_LOCALE)])
  assert.equal(new Set(chain).size, chain.length, '链上不得有重复')
})

test('★ F15：基语言切分只认第一个 `-`', () => {
  assert.equal(baseLanguageOf('zh'), 'zh')
  assert.equal(baseLanguageOf('zh-CN'), 'zh')
  assert.equal(baseLanguageOf('zh-Hant-TW'), 'zh')
})

/* ------------------------------ 键空间 ------------------------------ */

test('★ F15：键的语法与归属判定', () => {
  assert.equal(isMessageKey('host.app.title'), true)
  assert.equal(isMessageKey('plugin.demo.panel.title'), true)
  // 键里**只出现短名**，不带 scope：`pluginMessagePrefixOf('@scope/demo')` 给出的是
  // `plugin.demo.`，所以 `plugin.@scope/demo.x` 这种写法本就不该合法（写了也匹配不上任何前缀）。
  assert.equal(isMessageKey('plugin.@scope/demo.x'), false)
  for (const bad of ['app.title', 'host.', 'host..a', 'Host.a', 'host.a b']) {
    assert.equal(isMessageKey(bad), false, `${JSON.stringify(bad)} 应当不合法`)
  }
  assert.deepEqual(messageKeyOwner('host.nav.wiki'), { kind: 'host' })
  assert.deepEqual(messageKeyOwner('plugin.demo.panel'), { kind: 'plugin', plugin: 'demo' })
  assert.equal(messageKeyOwner('nonsense'), undefined)
})

test('★ F15：插件前缀取短名（键里不放 @scope/）', () => {
  assert.equal(pluginMessagePrefixOf('demo'), 'plugin.demo.')
  assert.equal(pluginMessagePrefixOf('@geewiki-plugin/demo'), 'plugin.demo.')
  assert.equal(pluginMessagePrefixOf('@t/with-ui'), 'plugin.with-ui.')
})

test('★ F15：插件【不能】提供宿主或别人的键 —— 越权键必须被拒绝并报告', () => {
  const r = mergeCatalogs([
    { owner: null, catalog: { 'host.nav.wiki': '知识库' } },
    {
      owner: '@geewiki-plugin/demo',
      catalog: {
        'plugin.demo.title': '演示',
        // 这三条都必须被拒：改宿主、改别人、键名非法
        'host.nav.wiki': '点我删除',
        'plugin.other.title': '别人的文案',
        'no.prefix': 'x',
      },
    },
  ])
  assert.equal(r.merged['plugin.demo.title'], '演示')
  assert.equal(r.merged['host.nav.wiki'], '知识库', '宿主文案不得被插件覆盖')
  assert.equal(r.merged['plugin.other.title'], undefined, '不得替别的插件提供文案')
  assert.equal(r.rejected.length, 3)
  assert.deepEqual(
    r.rejected.map((x) => x.key).sort(),
    ['host.nav.wiki', 'no.prefix', 'plugin.other.title'],
  )
  // 拒绝理由要指得出"为什么"，否则作者只能猜
  assert.match(r.rejected.find((x) => x.key === 'host.nav.wiki')!.reason, /plugin\.demo\./)
})

test('★ F15：宿主也只能写 host.*（同一把尺子，不给自己开后门）', () => {
  const r = mergeCatalogs([{ owner: null, catalog: { 'plugin.demo.title': '越权的宿主键' } }])
  assert.equal(r.merged['plugin.demo.title'], undefined)
  assert.match(r.rejected[0]!.reason, /host\./)
})

test('★ F15：同一键被两家提供时先到者保留，并记为冲突（短名撞车）', () => {
  const r = mergeCatalogs([
    { owner: 'a/demo', catalog: { 'plugin.demo.x': '第一' } },
    { owner: 'b/demo', catalog: { 'plugin.demo.x': '第二' } },
  ])
  assert.equal(r.merged['plugin.demo.x'], '第一')
  assert.deepEqual(r.conflicts, ['plugin.demo.x'])
})

/* ------------------------------ 解析 ------------------------------ */

test('★ F15：回退命中顺序为 精确 → 基语言 → 默认语言 → 默认的基语言', () => {
  const catalogs = {
    'zh-CN': { 'host.a': '简中' } as Record<string, string>,
    zh: { 'host.b': '通用中文' },
    'pt-BR': { 'host.c': 'brasil' },
  }
  assert.equal(resolveMessage(catalogs, 'pt-BR', 'host.c').text, 'brasil')
  // pt-BR 没有 host.b，但基语言 zh 有 —— 这一步证明"基语言"确实在链上
  assert.equal(resolveMessage(catalogs, 'pt-BR', 'host.b').text, '通用中文')
  // 都找不到时落回 DEFAULT_LOCALE
  assert.equal(resolveMessage(catalogs, 'pt-BR', 'host.a').text, '简中')
  assert.equal(resolveMessage(catalogs, 'pt-BR', 'host.c').locale, 'pt-BR')
})

test('★ F15：缺失时返回【键名本身】而不是空串，并标记 missing', () => {
  const r = resolveMessage({}, 'en', 'host.nope.here')
  assert.equal(r.text, 'host.nope.here')
  assert.equal(r.missing, true)
  assert.equal(r.locale, null)
  assert.notEqual(r.text, '', '空串会让界面静默缺一块，这是本契约最要紧的一条')
})

test('★ F15：空字符串不算命中（否则会退化成"静默缺一块"）', () => {
  const r = resolveMessage({ en: { 'host.x': '' } }, 'en', 'host.x')
  assert.equal(r.missing, true)
  assert.equal(r.text, 'host.x')
})

test('★ F15：missingKeys 汇总缺口（翻译进度可观测）', () => {
  const catalogs = { 'zh-CN': { 'host.a': 'A', 'host.b': 'B' } }
  assert.deepEqual(missingKeys(catalogs, 'zh-CN', ['host.a', 'host.b', 'host.c']), ['host.c'])
})

test('★ F15：插值替换已知参数；未知参数【保留原样】而不是变成 undefined/空', () => {
  assert.equal(interpolate('你好 {name}', { name: '世界' }), '你好 世界')
  assert.equal(interpolate('共 {n} 条', { n: 3 }), '共 3 条')
  // 未提供：保留 `{name}`，一眼能看出是漏传参数
  assert.equal(interpolate('你好 {name}', {}), '你好 {name}')
  assert.equal(interpolate('你好 {name}'), '你好 {name}')
  assert.equal(interpolate('{a}{b}', { a: 1, b: 2 }), '12')
  // 不是标识符形态的花括号不该被当成占位符
  assert.equal(interpolate('{} {1} {中文}', {}), '{} {1} {中文}')
  // 同一次调用里的重复参数都要替换（全局正则）
  assert.equal(interpolate('{x}-{x}', { x: 'y' }), 'y-y')
})

test('★ F15：解析后再插值（而不是先插值再查找）', () => {
  const r = resolveMessage({ en: { 'host.greet': 'Hi {name}' } }, 'en', 'host.greet', { name: 'Ada' })
  assert.equal(r.text, 'Hi Ada')
  assert.equal(r.locale, 'en')
})
