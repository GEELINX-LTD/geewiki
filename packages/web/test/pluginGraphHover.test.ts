/**
 * 依赖图**悬停高亮**的源码守卫。
 *
 * 这一组判据来自一次真实返工：用户报"悬停依赖高亮没有用，而且在节点内移动鼠标会不断闪烁"。
 * 两个症状同源——节点标签上挂的原生 `title` tooltip 弹出在光标附近，抢走 `mouseout` ⇒
 * 悬停态丢失 ⇒ tooltip 收起 ⇒ 再次弹出，自激成闪烁，高亮也跟着丢。headless 量不到它
 * （headless 不渲染原生 tooltip），所以这件事**只能靠源码守卫钉住**，浏览器验收补不了。
 *
 * 同时钉住"高亮必须是正强调"：压暗只是背景，用户看不见"我被高亮了"就是没用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const graph = readFileSync(join(SRC, 'components', 'PluginGraph.tsx'), 'utf8')

test('确有效果物：读到的是依赖图画布源码（防路径写错导致 0===0）', () => {
  assert.ok(graph.length > 3000, `PluginGraph.tsx 读入异常（仅 ${graph.length} 字符）`)
  assert.match(graph, /export function PluginGraph/)
})

test('节点上不得挂原生 title tooltip（那是"移动鼠标就闪 + 高亮丢失"的根因）', () => {
  /*
   * 反面教材就是 `title={d.fullName}`：它同时是"信息不丢"的旧实现。
   * 检测范围放宽到节点组件体内任何 `title=`——因为再挂一次的理由总是同一个（"想看全名"），
   * 而真正的出口已经有两个：悬停时的提示面板与详情弹窗。
   */
  const nodeFn = graph.slice(graph.indexOf('function FlowNode'), graph.indexOf('/* ---------- 边'))
  assert.ok(nodeFn.length > 200, '应能抽出 FlowNode 的实现体')
  assert.doesNotMatch(nodeFn, /\btitle=/, 'FlowNode 里不得出现 title= —— 原生 tooltip 会与悬停高亮自激')
  assert.match(graph, /刻意不用原生 `title`/, '须保留"为什么不用原生 title"的注释，否则下一个人会顺手加回来')
})

test('高亮必须是正强调：链内要有强调环，不能只是"没被压暗"', () => {
  assert.match(graph, /d\.inChain \? 'ring-2 ring-accent/, '链内节点必须挂强调环（仅靠压暗别人等于没高亮）')
  assert.match(graph, /d\.inChain && <path[^>]*stroke-accent/, '链上的边必须加粗上强调色')
})

test('压暗程度必须足够（≥0.35 时链内链外一眼分不出来）', () => {
  const m = /const DIM_OPACITY = ([0-9.]+)/.exec(graph)
  assert.ok(m, '应能读到 DIM_OPACITY')
  const value = Number(m[1])
  assert.ok(value > 0 && value <= 0.35, `DIM_OPACITY 应 ≤0.35（当前 ${value}）`)
})

test('悬停态必须对伪 leave/enter 免疫（离开加防抖），且不得用原生 title 兜底', () => {
  assert.match(graph, /const leaveTimer = useRef/, '应有防抖定时器')
  assert.match(graph, /enterNode/, '进入节点应走 enterNode（负责取消待清空的定时器）')
  assert.match(graph, /leaveNode/, '离开应走 leaveNode（排 80ms 后再清空）')
  // 防抖窗口要短到察觉不到，长到能吃掉成对抖动
  const ms = /setTimeout\(\(\) => \{[^}]*setHovered\(null\)[^}]*\}, (\d+)\)/.exec(graph)
  assert.ok(ms, '应能读到防抖窗口时长')
  assert.ok(Number(ms[1]) >= 40 && Number(ms[1]) <= 200, `防抖窗口应在 40~200ms（当前 ${ms[1]}ms）`)
})

test('提示面板要给方向与全名（替代原生 tooltip 的那份信息）', () => {
  assert.match(graph, /font-mono text-2xs break-all text-muted">\{hovered\}/, '面板里应显示包名全称')
  assert.match(graph, /不含依赖它的/, '面板应写明"不含依赖它的"（否则用户会以为高亮漏了）')
  assert.match(graph, /不依赖任何插件——它是依赖链的起点/, '上游为空时要说实话，不能显示"高亮了 0 个"')
})
