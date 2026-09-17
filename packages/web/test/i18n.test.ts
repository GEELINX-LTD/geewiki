/**
 * ★ F15：宿主侧 i18n 的守卫。
 *
 * 这一组钉的是**"共用一套 catalog"能否长期成立**，而不是某条文案写得好不好：
 * 1. **语言之间键集必须一致**：`en` 少一个键不会报错，只会让英文用户看到键名 ——
 *    而"键集不齐"是译文最容易发生的漂移，必须由测试而不是由人眼来发现。
 * 2. **源码里用到的键必须真的存在**：`t('host.nofound.title')` 这种拼错不会报错，
 *    界面上只会显示这串键名，而写代码的人多半不会去点那个页面。
 * 3. **未知键返回键名而不是空串**：这条与 core 的契约一致，在这里再钉一次是因为
 *    **界面上的表现**才是它真正要防的东西（空串 = 静默缺一块）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOCALE, isMessageKey } from '@geewiki/core/domain'
import en from '../src/locales/en.json' with { type: 'json' }
import zhCN from '../src/locales/zh-CN.json' with { type: 'json' }
import {
  LOCALE_STORAGE_KEY,
  availableLocales,
  checkPluginCatalog,
  getLocale,
  resolveInitialLocale,
  setLocale,
  t,
} from '../src/lib/i18n'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_SRC = join(HERE, '..', 'src')

const hostKeys = Object.keys(zhCN as Record<string, string>)

/* ------------------------------ 文案目录 ------------------------------ */

test('★ F15：宿主每一种语言的键集必须完全一致（少一个键只会让用户看到键名）', () => {
  const enKeys = Object.keys(en as Record<string, string>)
  assert.deepEqual(
    [...enKeys].sort(),
    [...hostKeys].sort(),
    'en 与 zh-CN 的键集不一致：缺的那个键会让英文界面直接显示键名（不会报错，也不会有人发现）',
  )
})

test('★ F15：宿主文案键必须是合法的 host.* 键，且不得为空串', () => {
  for (const key of hostKeys) {
    assert.equal(isMessageKey(key), true, `${key} 不是合法的 message key`)
    assert.equal(key.startsWith('host.'), true, `${key} 必须以 host. 开头（命名空间是强制的）`)
    assert.notEqual((zhCN as Record<string, string>)[key], '', `${key} 的中文文案不得为空串`)
    assert.notEqual((en as Record<string, string>)[key], '', `${key} 的英文文案不得为空串`)
  }
})

test('★ F15：源码里出现的每一个 host.* 键都必须存在于文案目录（防拼错）', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(name)) files.push(full)
    }
  }
  walk(WEB_SRC)

  const used = new Set<string>()
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\bt\(\s*'(host\.[a-zA-Z0-9.-]+)'/g)) used.add(m[1]!)
  }
  // 先断言"确实扫到了用法"：正则写坏时下面的断言会空集通过
  assert.ok(used.size > 0, '没有在源码里扫到任何 t(\'host.…\') 用法——判据可能已失效')

  const missing = [...used].filter((k) => !hostKeys.includes(k))
  assert.deepEqual(
    missing,
    [],
    '以下键被源码使用但不在文案目录里：界面会直接显示这串键名，而写代码的人多半不会点那个页面。\n  - ' +
      missing.join('\n  - '),
  )
})

/* ------------------------------ 取值行为 ------------------------------ */

test('★ F15：默认语言为默认常量；未知键返回键名本身（不是空串）', () => {
  assert.equal(getLocale(), DEFAULT_LOCALE)
  assert.equal(t('host.notfound.title'), (zhCN as Record<string, string>)['host.notfound.title'])
  const unknown = 'host.this.key.does.not.exist'
  assert.equal(t(unknown), unknown)
  assert.notEqual(t(unknown), '')
})

test('★ F15：切换语言后取到另一种文案；非法语言码被忽略', async () => {
  await setLocale('en')
  assert.equal(getLocale(), 'en')
  assert.equal(t('host.notfound.title'), (en as Record<string, string>)['host.notfound.title'])

  assert.equal(availableLocales().includes('zh-CN'), true)
  assert.equal(availableLocales().includes('en'), true)

  // 非法语言码不该改变当前语言（它会进 URL 与回退链计算）
  await setLocale('../../etc/passwd')
  assert.equal(getLocale(), 'en')

  await setLocale(DEFAULT_LOCALE)
  assert.equal(t('host.notfound.title'), (zhCN as Record<string, string>)['host.notfound.title'])
})

test('★ F15：初始语言必须落在我们【确实有宿主文案】的语言上', () => {
  /*
   * 这一条**刻意不假设运行时的全局环境**：Node 22 起可能带 `localStorage`（未启用后端时读它会抛），
   * 而 `navigator.language` 在 Node 里通常是 `en-US`。第一版写成断言"等于 DEFAULT_LOCALE"，
   * 于是它测的其实是"Node 有没有 navigator" —— 而程序当时的行为是正确的
   * （`en-US` → 链上找到 `en`，我们确实有英文文案，采用它）。
   *
   * 真正该钉的不变量是：**选出来的语言必须是宿主真的带了文案的那几种之一**。
   * 若轻信 `navigator.language` 的任意取值，首屏会整片变成键名。
   */
  const chosen = resolveInitialLocale()
  assert.equal(
    availableLocales().includes(chosen),
    true,
    `选出的 ${chosen} 不在我们有文案的语言集合里（首屏会整片变成键名）`,
  )
  assert.equal(LOCALE_STORAGE_KEY.length > 0, true)
})

test('★ F15：本机存过的选择优先于浏览器语言（用户的显式决定最高）', async () => {
  // 存储不可用的运行时（隐私模式 / Node 未启用 webstorage）下这条前提不成立，直接跳过
  let storageWorks = true
  try {
    globalThis.localStorage.setItem('gw.i18n.probe', '1')
    globalThis.localStorage.removeItem('gw.i18n.probe')
  } catch {
    storageWorks = false
  }
  if (!storageWorks) return

  await setLocale('en')
  assert.equal(resolveInitialLocale(), 'en', '存过的选择必须优先于 navigator.language')
  await setLocale(DEFAULT_LOCALE)
  assert.equal(resolveInitialLocale(), DEFAULT_LOCALE)
})

/* ------------------------------ 与插件共用 ------------------------------ */

test('★ F15：宿主与插件共用一套键空间 —— 插件不得提供宿主键', () => {
  // 客户端这一层只做检查（强制在服务端的 mergeCatalogs），但判据必须与那里一致
  const bad = checkPluginCatalog('@geewiki-plugin/demo', { 'host.nav.wiki': '点我删除' })
  assert.equal(bad.length, 1)
  assert.match(bad[0]!, /host\.nav\.wiki/)

  const good = checkPluginCatalog('@geewiki-plugin/demo', { 'plugin.demo.title': '演示' })
  assert.deepEqual(good, [])
})
