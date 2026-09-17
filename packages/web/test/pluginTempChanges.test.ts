/**
 * 「临时变更」卡片与两种"临时"状态的源码守卫。
 *
 * 来自两次真实返工：
 *   ① 用户报"插件临时停用后不会显示在临时变更中"——空态判据只看了会话层条目
 *      （`sessionChanges.length === 0`），把"进程内临时停用"这种同样没写进基础清单的变更漏掉了；
 *   ② 面向用户的说明字符串里带 markdown 记号（`**正常重启仍会保留**`），而 JSX 不做 markdown 解析
 *      ⇒ 界面上原样显示星号（真浏览器截图里看到的）。
 *
 * 这两类问题都**不改变类型**，typecheck 看不见；浏览器验收又容易被选择器写错而假绿，
 * 所以这里直接钉源码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const page = readFileSync(join(SRC, 'pages', 'GraphPage.tsx'), 'utf8')
const display = readFileSync(join(SRC, 'lib', 'pluginDisplay.ts'), 'utf8')

/** 抽出 `<CardHeader title="临时变更" …>` 之后的卡片体（到下一条 `{/* ----------` 注释为止） */
function tempChangesCard(): string {
  const start = page.indexOf('{/* ---------- 临时变更')
  const end = page.indexOf('{/* ---------- 确认对话框', start)
  assert.ok(start > 0 && end > start, '应能定位到「临时变更」卡片区块')
  return page.slice(start, end)
}

test('确有效果物：抽到的是「临时变更」卡片（防定位失败导致 0===0）', () => {
  const card = tempChangesCard()
  assert.ok(card.length > 400, `卡片区块过短（${card.length} 字符）`)
  assert.match(card, /runtimeDisabled\.map/, '卡片里应渲染临时停用名单')
})

test('空态判据必须同时考虑两种临时变更（用户报的 bug 就是这个）', () => {
  const card = tempChangesCard()
  const m = /sessionChanges\.length === 0([^?]*)\?/.exec(card)
  assert.ok(m, '应能读到空态三元条件')
  // `m[1]` 在 noUncheckedIndexedAccess 下是 `string | undefined`：用 `?? ''` 兜底，
  // 取不到时断言会以"空串不匹配"失败，仍然指向真正的原因
  assert.match(
    m[1] ?? '',
    /runtimeDisabled\.length === 0/,
    '空态条件必须同时要求 runtimeDisabled 为空，否则"临时停用后卡片说没有变更"会复发',
  )
})

test('临时停用的行必须带徽章与后果说明，且不能被空态吞掉', () => {
  const card = tempChangesCard()
  assert.match(card, /<Badge tone="suspended">临时停用<\/Badge>/, '名单行应有「临时停用」徽章')
  assert.match(card, /重启后照基础清单恢复|照基础清单恢复/, '名单行应说明重启后的后果')
  // 标题带项数：让"有变更"这件事在折叠/扫读时也成立
  assert.match(card, /sessionChanges\.length \+ runtimeDisabled\.length/, '标题项数应把两种变更都算上')
})

test('「应用并持久化」的可用性必须把临时停用也算进去', () => {
  const m = /const canPersist = ([^\n]+)/.exec(page)
  assert.ok(m, '应能读到 canPersist')
  assert.match(m[1] ?? '', /runtimeDisabled\.length > 0/, '只判会话层时，纯临时停用态下按钮会是灰的（用户点不动）')
})

test('停用成功的提示必须区分两种层（冷层什么都没保存，不能说"已保存"）', () => {
  const m = /setNotice\(\{[\s\S]{0,400}?已停用[\s\S]{0,400}?\}\)/.exec(page)
  assert.ok(m, '应能读到停用成功后的提示')
  assert.match(m[0], /p\.layer === 'session'/, '提示应按层分流')
  assert.match(m[0], /未写盘|重启后恢复/, '基础层必须明说"没写盘、重启恢复"')
})

test('面向用户的字符串不得带 markdown 记号（JSX 不解析 markdown，会原样显示星号）', () => {
  for (const name of ['SESSION_LAYER_HINT', 'PERSIST_HINT']) {
    const m = new RegExp(`${name} =\\n?\\s*'([^']*)'`).exec(display)
    assert.ok(m, `应能读到 ${name}`)
    assert.doesNotMatch(m[1] ?? '', /\*\*/, `${name} 里不得出现 ** —— 它会被当 JSX 文本原样渲染（要用 <strong>）`)
  }
})
