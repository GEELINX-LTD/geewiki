/**
 * ★ F8：Markdown 渲染扩展注册表的用例。
 *
 * 这一层要防的是两类**不会报错**的失效：
 *
 * 1. **注册只增不减**。`marked.use()` 没有 `unuse`，插件产物更新后整页刷新会让同一扩展
 *    被再注册一次 —— tokenizer 被多次调用、renderer 被套娃，症状是"用久了渲染越来越怪"，
 *    日志干净。这里因此逐条钉住"撤销是真的撤销"（版本号 + 渲染结果都回到原样）。
 * 2. **插件绕开消毒**。给插件开放 HTML 生成最容易的翻车方式，是某天有人为了"方便"
 *    让扩展直接产出已渲染好的 DOM/HTML 挂进页面。本仓库的 node 测试环境**没有 DOM**
 *    （web 的用例都是纯逻辑，见 `test/` 下无 jsdom 依赖），所以这一条只能做**源码级**断言：
 *    `markdownExt.ts` 不得引入 react/dompurify、不得使用 `dangerouslySetInnerHTML`，
 *    且 `sanitize.ts` 必须是唯一调用 `DOMPurify.sanitize` 的地方。
 *    这些断言的**运行期**对应物由真机验证（DOMPurify 需要 DOM）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activeMarked,
  fenceExtension,
  markdownExtensions,
  markdownRegistryVersion,
  registerMarkdownExtension,
  unregisterMarkdownExtensions,
} from '../src/lib/markdownExt'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'src', 'lib')

/** 静默 console.warn 并在结束后还原（冲突用例要断言"告警发生了"） */
function captureWarn<T>(run: () => T): { value: T; warned: string[] } {
  const warned: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
  try {
    return { value: run(), warned }
  } finally {
    console.warn = orig
  }
}

const fence = (lang: string, code: string): string => activeMarked().parse(`\`\`\`${lang}\n${code}\n\`\`\``) as string

test('注册 → 出现在扩展表里且版本号 +1；撤销 → 回到原样且版本号再 +1', () => {
  const before = markdownRegistryVersion()
  const namesBefore = markdownExtensions().map((e) => e.name)

  const undo = registerMarkdownExtension('@t/md', fenceExtension('demo', (code) => `<div data-demo>${code}</div>`))
  assert.equal(markdownRegistryVersion(), before + 1, '生效的注册必须让版本号 +1（否则缓存不会失效）')
  assert.ok(markdownExtensions().some((e) => e.name === 'fence-demo'))
  assert.match(fence('demo', 'hello'), /data-demo/)

  undo()
  assert.equal(markdownRegistryVersion(), before + 2)
  assert.deepEqual(markdownExtensions().map((e) => e.name), namesBefore)
  assert.doesNotMatch(fence('demo', 'hello'), /data-demo/, '撤销后该渲染器必须真的不再生效')

  // 幂等：再调一次不该再改版本号
  const v = markdownRegistryVersion()
  undo()
  assert.equal(markdownRegistryVersion(), v)
})

test('同名扩展先注册者胜出，后来者被告警且**不影响版本号**', () => {
  const undoA = registerMarkdownExtension('@t/first', fenceExtension('dup', () => '<div id="first"></div>'))
  const v = markdownRegistryVersion()
  const { warned } = captureWarn(() =>
    registerMarkdownExtension('@t/second', fenceExtension('dup', () => '<div id="second"></div>')),
  )
  assert.equal(markdownRegistryVersion(), v, '被拒的注册不得让缓存失效（否则写错的插件会让我们每次重建 Marked）')
  assert.ok(warned.some((w) => w.includes('已被')), '冲突必须告警——静默顶替的症状是"我的渲染器变成了别人的"')
  assert.match(fence('dup', 'x'), /id="first"/, '先注册者必须仍然生效')
  undoA()
})

test('形态不合法的扩展被拒绝且不改变版本号', () => {
  const v = markdownRegistryVersion()
  const { warned } = captureWarn(() => {
    registerMarkdownExtension('@t/bad', { name: '', marked: {} })
    registerMarkdownExtension('@t/bad', null as never)
  })
  assert.equal(markdownRegistryVersion(), v)
  assert.equal(warned.length, 2, '两次非法输入都该告警（静默忽略会让插件作者以为注册成功了）')
})

test('fenceExtension 只接管自己的语言，其它围栏落回默认渲染', () => {
  const undo = registerMarkdownExtension('@t/fence', fenceExtension('mermaid', (code) => `<figure class="mermaid">${code}</figure>`))
  try {
    assert.match(fence('mermaid', 'graph TD'), /class="mermaid"/)
    // 关键：别的语言行为**一字不变**。若 renderer 覆盖写成"只要不是我的就返回空"，
    // 一个渲染插件会悄悄吃掉整篇文档的所有代码块。
    const js = fence('js', 'const a = 1')
    assert.match(js, /<pre><code/, '非目标语言必须仍由 marked 默认渲染')
    assert.match(js, /const a = 1/)
    assert.doesNotMatch(js, /mermaid/)
    // 语言名大小写与带额外 info 的围栏都要能识别
    assert.match(fence('MERMAID', 'x'), /class="mermaid"/, '语言名比对应大小写不敏感')
  } finally {
    undo()
  }
})

test('unregisterMarkdownExtensions：按 owner 成组撤销（插件卸载/热更新的统一出口）', () => {
  const a1 = registerMarkdownExtension('@t/owner-a', fenceExtension('a1', () => 'A1'))
  const a2 = registerMarkdownExtension('@t/owner-a', fenceExtension('a2', () => 'A2'))
  const b1 = registerMarkdownExtension('@t/owner-b', fenceExtension('b1', () => 'B1'))
  assert.equal(unregisterMarkdownExtensions('@t/owner-a'), undefined)
  const names = markdownExtensions().map((e) => e.name)
  assert.deepEqual(names.filter((n) => n === 'fence-a1' || n === 'fence-a2'), [], 'A 的扩展应全部撤销')
  assert.ok(names.includes('fence-b1'), '不得误伤别的 owner')
  /*
   * 撤销函数的**后置调用**必须安全：插件通常既拿到 undo、又在卸载钩子里调
   * unregisterXXX（两道保险）。若这里抛错，一次正常的卸载会变成一次崩溃。
   */
  a1()
  a2()
  b1()
  assert.equal(markdownExtensions().some((e) => e.name === 'fence-b1'), false)
})

test('activeMarked 按版本缓存实例：无变更复用，有变更重建', () => {
  const first = activeMarked()
  assert.equal(activeMarked(), first, '版本未变时应复用同一实例（避免每次渲染都重建 marked）')
  const undo = registerMarkdownExtension('@t/cache', fenceExtension('cachetest', () => 'C'))
  const second = activeMarked()
  assert.notEqual(second, first, '注册后必须重建，否则新扩展不会生效')
  undo()
  assert.notEqual(activeMarked(), second)
})

/* ==================== 安全边界（源码级：node 测试无 DOM） ==================== */

const read = (f: string): string => readFileSync(join(libDir, f), 'utf8')
/** 去注释，避免文档里提到的 `dangerouslySetInnerHTML` 被误判 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('安全边界：扩展注册表本身不碰 DOM、不引 React、不做任何消毒以外的注入', () => {
  const code = stripComments(read('markdownExt.ts'))
  for (const { re, what } of [
    { re: /from\s+['"]react['"]/g, what: 'React 导入' },
    { re: /from\s+['"]dompurify['"]/g, what: 'DOMPurify 导入' },
    { re: /dangerouslySetInnerHTML/g, what: 'dangerouslySetInnerHTML' },
  ]) {
    assert.equal(
      code.match(re),
      null,
      `markdownExt.ts 出现了 ${what}：扩展只能产出**字符串 HTML**，` +
        '注入 DOM 必须唯一地经过 sanitize.ts 的 mdToHtml（那里有 DOMPurify 收口）。' +
        '一旦允许扩展直接挂 DOM，插件就绕过了链接改写、附件标注、标题锚点这一整套后处理。',
    )
  }
})

test('安全边界：DOMPurify 只在 sanitize.ts 里出现（消毒出口唯一）', () => {
  const files = ['sanitize.ts', 'markdownExt.ts', 'markdownRender.ts', 'wikilink.ts']
  const users = files.filter((f) => /from\s+['"]dompurify['"]/.test(read(f)))
  assert.deepEqual(users, ['sanitize.ts'], 'DOMPurify 只能有一处调用点（新增一处 = 多了一条可绕过的注入路径）')
  assert.match(read('sanitize.ts'), /DOMPurify\.sanitize\(/, 'sanitize.ts 必须真的在消毒')
})

test('安全边界：mdToHtml 走注册表装配的实例，而不是全局 marked 单例', () => {
  const code = stripComments(read('sanitize.ts'))
  assert.match(code, /activeMarked\(\)/, 'mdToHtml 必须用 activeMarked()，否则插件注册的扩展根本不会生效')
  assert.equal(
    code.match(/from\s+['"]marked['"]/g),
    null,
    'sanitize.ts 不得直接 import marked —— 那会让人以为"改这个文件就能加扩展"，而真正的入口是注册表',
  )
  // 内置扩展必须在消毒出口就绪（显式副作用导入），否则"直接调 mdToHtml"的路径会漏掉 wikilink
  assert.match(code, /import\s+['"]\.\/wikilink['"]/, 'sanitize.ts 必须显式导入内置扩展 wikilink')
})
