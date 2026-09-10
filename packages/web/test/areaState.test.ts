/**
 * 区域四态判定 + "界面不得渲染原始错误串" 的**源码级守卫**。
 *
 * 为什么要有源码级守卫（而不是只测 `resolveAreaState`）：
 * 本次修复的真实缺陷是"**同一个失败被三处矛盾呈现**"——
 * ① 侧栏直接印 `error` 串；② 页头挂一个印 `err` 的 chip；③ 卡片头用 `pages === null`
 * 判断"正在加载"，而失败时 `pages` 同样是 null，于是头部说"正在加载…"、正文说"出错了"。
 * 其中 ① ② 是**源码形态**问题（把原始串插进 JSX），单测测不到；只有扫源码才能防复发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAreaState } from '../src/lib/areaState'

/*
  源码根目录按**本测试文件自身的位置**推导，而不是依赖 cwd：
  测试既可能被 `pnpm --filter @geewiki/web test`（cwd=packages/web）跑，
  也可能被编排者在仓库根直接跑——用相对路径会在其中一种下 ENOENT。
*/
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

/* --------------------------- 四态与优先级 --------------------------- */

test('resolveAreaState：四态互斥，且**错误优先于加载**', () => {
  // 错误 + 加载同时成立时，必须返回 error：失败是已确定的事实，
  // 继续宣称"正在加载"会让用户一直等一个不会来的结果。
  assert.equal(resolveAreaState({ loading: true, hasError: true, isEmpty: true }), 'error')
  assert.equal(resolveAreaState({ loading: true, hasError: true, isEmpty: false }), 'error')
  assert.equal(resolveAreaState({ loading: false, hasError: true, isEmpty: false }), 'error')
  // 加载优先于空：数据还没到，不能说"确实没有"
  assert.equal(resolveAreaState({ loading: true, hasError: false, isEmpty: true }), 'loading')
  assert.equal(resolveAreaState({ loading: true, hasError: false, isEmpty: false }), 'loading')
  // 空与就绪
  assert.equal(resolveAreaState({ loading: false, hasError: false, isEmpty: true }), 'empty')
  assert.equal(resolveAreaState({ loading: false, hasError: false, isEmpty: false }), 'ready')
})

test('resolveAreaState 回归不变式：hasError 为真时**永不**返回 loading', () => {
  /*
    这是本次缺陷的直接回归用例。旧实现用 `pages === null` 判断"正在加载"，
    失败时它同样为 null ⇒ 头部显示"正在加载…"而正文显示错误态。
    把这条写成不变式后，任何把 loading 判断提到 error 之前的改动都会立刻变红。
  */
  for (const loading of [true, false]) {
    for (const isEmpty of [true, false]) {
      const state = resolveAreaState({ loading, hasError: true, isEmpty })
      assert.equal(state, 'error', `hasError 时不得返回 ${state}（loading=${loading} isEmpty=${isEmpty}）`)
    }
  }
})

/* ------------------------ 源码级守卫（防复发） ------------------------ */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

test('守卫：界面代码不得把原始错误串直接转成显示文本', () => {
  /*
    禁止的形态（都曾真实存在于本仓库）：
    - `setErr(e instanceof Error ? e.message : String(e))` —— 把原始 message 存进 state 再插进 JSX；
    - `` `${err.message}` `` —— 直接拼进提示文案。

    允许的形态：`errorLine(err)` / `cleanHint(...)`（都在 `lib/errorText.ts` 里清洗过），
    以及 `console.debug(..., e.message)`（只进控制台，不进界面）。
  */
  const forbidden: { re: RegExp; why: string }[] = [
    { re: /\?\s*e\.message\s*:\s*String\(e\)/, why: '应改用 errorLine(e)' },
    { re: /\?\s*err\.message\s*:\s*String\(err\)/, why: '应改用 errorLine(err)' },
    { re: /\$\{err\.message\}/, why: '原始串不得拼进界面文案，应改用 errorLine/cleanHint' },
    { re: /\$\{e\.message\}/, why: '原始串不得拼进界面文案，应改用 errorLine/cleanHint' },
  ]
  const hits: string[] = []
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // 注释行里的举例不算（本文件与 errorText.ts 的文档里就有反例说明）
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      for (const { re, why } of forbidden) {
        if (re.test(line)) hits.push(`${file}:${i + 1}  ${why}\n      ${trimmed}`)
      }
    })
  }
  assert.deepEqual(hits, [], `发现 ${hits.length} 处原始错误串直出：\n  ${hits.join('\n  ')}`)
})

test('守卫：错误人话化只有一个入口（errorText.ts）', () => {
  /*
    `describeError` / `errorLine` / `streamErrorText` 必须定义在 lib/errorText.ts。
    若有人另起一处"翻译层"，文案会开始漂移（同一失败在不同页面说不同的话）——
    这正是"一个失败多处呈现"的另一半根因。
  */
  const owner = readFileSync(join(SRC, 'lib/errorText.ts'), 'utf8')
  for (const fn of ['describeError', 'errorLine', 'streamErrorText', 'cleanHint']) {
    assert.ok(owner.includes(`export function ${fn}`), `${fn} 应定义在 lib/errorText.ts`)
  }
  const dupes: string[] = []
  for (const file of walk(SRC)) {
    if (file.endsWith(join('lib', 'errorText.ts'))) continue
    const src = readFileSync(file, 'utf8')
    for (const fn of ['describeError', 'errorLine']) {
      if (new RegExp(`function\\s+${fn}\\s*\\(`).test(src)) dupes.push(`${file} 重复定义了 ${fn}`)
    }
  }
  assert.deepEqual(dupes, [])
})
