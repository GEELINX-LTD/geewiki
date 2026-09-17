/**
 * 对话区自动置底的守卫（用户实测："发送新消息时不会自动置底，每次都要手动滑到最下面"）。
 *
 * 分两层钉住：
 *   ① **纯函数** `isAtBottom` 的边界（贴底/差一点点/翻上去一屏，以及容差为什么不能随意改）；
 *   ② **源码**：对话区必须有 ref 与 `onScroll`、`send()` 必须强制恢复跟随、
 *      跟随效果必须同时看"面板展开"与"此刻贴底"，且**只能滚对话区自己**——
 *      用 `window.scrollTo` / `scrollIntoView` 会去滚 `.gw-dock-clip` 那个裁剪盒，
 *      把展开动画的揭幕起点拽到底部（动画批踩过：裁剪盒 scrollTop≈200）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAtBottom, STICK_BOTTOM_EPS } from '../ui/dockPlan.js'

const SRC = join(import.meta.dirname, '..', 'ui')
const component = readFileSync(join(SRC, 'index.tsx'), 'utf8')
const plan = readFileSync(join(SRC, 'dockPlan.ts'), 'utf8')

const metrics = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight })

test('贴近底部（含几像素误差）算"贴底"；真翻上去不算', () => {
  assert.equal(isAtBottom(metrics(600)), true, '刚好滚到底')
  assert.equal(isAtBottom(metrics(590)), true, '差 10px 仍是贴底（浏览器会留小数与 1px 误差）')
  assert.equal(isAtBottom(metrics(600 - STICK_BOTTOM_EPS)), true, '正好等于容差仍是贴底')
  assert.equal(isAtBottom(metrics(600 - STICK_BOTTOM_EPS - 1)), false, '超出容差即视为用户翻上去了')
  assert.equal(isAtBottom(metrics(0)), false, '内容比视口高、停在顶部时不算贴底')
})

test('内容还没超出视口时恒为贴底（首帧不该被判定成"用户滚上去了"）', () => {
  assert.equal(isAtBottom(metrics(0, 200, 400)), true, '内容比视口短：没有可滚空间')
  assert.equal(isAtBottom(metrics(0, 0, 0)), true, '还没渲染')
})

test('容差必须是个"小但不为零"的常量（0 会让流式回答不再跟随，太大则会把用户拽下去）', () => {
  assert.equal(STICK_BOTTOM_EPS, 24)
  const eps = /export const STICK_BOTTOM_EPS = (\d+)/.exec(plan)?.[1]
  assert.equal(eps, '24', '容差被改动了？先读 dockPlan.ts 里那段说明再改')
})

test('对话区必须挂 ref，且在自身 onScroll 里更新跟随状态', () => {
  assert.match(component, /const threadRef = useRef<HTMLDivElement \| null>\(null\)/, '对话区需要 ref 才能滚它')
  assert.match(component, /ref=\{threadRef\}/, 'ref 必须真的挂在对话区上')
  /*
   * ⚠️ 不能用 `[\s\S]{0,900}?>` 去截"开始标签"——箭头函数的 `=>` 本身就带一个 `>`，
   * 会在 `onScroll={(e) =>` 处提前截断（本文件第一版就是这么假红的，和 README 里
   * "JSX 属性位不能写花括号注释、属性里的 `=>` 自带一个 `>`"是同一条教训）。直接按注释位置切片。
   */
  const at = component.indexOf('className="gw-dock-thread"')
  const block = at < 0 ? '' : component.slice(at, at + 1200)
  assert.match(block, /onScroll=\{\(e\) => \{[\s\S]*?isAtBottom\(e\.currentTarget\)/, 'onScroll 必须用 isAtBottom 判定（别写成 === 0）')
})

test('send() 必须**强制**恢复跟随：用户翻上去时发消息，答案仍要出现在视野里', () => {
  /*
   * 签名带了可选参数（`preset?`，给"中止后点继续"那个按钮用），所以正则不能写死 `()`；
   * 但**下面要钉的语义没变**：一进来就强制置回贴底。
   */
  const send = /const send = useCallback\(\(preset\?: string\) => \{[\s\S]*?\n  \}, \[/.exec(component)?.[0] ?? ''
  assert.ok(send.length > 100, '应能读到 send()（签名：useCallback((preset?: string) => {…})）')
  assert.match(send, /pinnedRef\.current = true/, 'send() 必须强制置回贴底')
})

test('跟随效果必须同时看"面板展开"与"此刻贴底"，且只滚对话区自己', () => {
  const effect = /useEffect\(\(\) => \{\s*if \(!open\) return[\s\S]*?\}, \[threadKey, open\]\)/.exec(component)?.[0] ?? ''
  assert.ok(effect.length > 100, '应能读到自动置底的 effect')
  assert.match(effect, /if \(!pinnedRef\.current\) return/, '不贴底时必须一动不动（回看旧回答时不能被拽走）')
  assert.match(effect, /threadRef\.current/, '必须滚对话区自己')
  assert.match(effect, /el\.scrollTop = el\.scrollHeight/, '置底写法应直接设 scrollTop（不要 smooth：流式期间会互相打架）')
  for (const forbidden of ['window.scrollTo', 'scrollIntoView', 'scrollTo({']) {
    assert.ok(!effect.includes(forbidden), `跟随效果里不得出现 ${forbidden}：那会去滚 .gw-dock-clip 裁剪盒，破坏展开动画`)
  }
  assert.ok(!/behavior: 'smooth'/.test(component), '不得引入 smooth 滚动：流式每帧滚一次时会互相打断')
})

test('内容指纹必须只由"几个数字"拼成 —— 不能把 state 整个放进依赖', () => {
  const key = /const threadKey = `([^`]+)`/.exec(component)?.[1] ?? ''
  assert.ok(key.includes('state.messages.length'), '消息数要计入')
  assert.ok(key.includes('state.answer.length'), '流式正文长度要计入（否则回答长出来时不会跟随）')
  assert.ok(key.includes('state.activities.length'), '工具活动行要计入')
  assert.match(key, /journal\.length/, '回退区块要计入（它出现会把内容顶高）')
  // 只在**这个** effect 的范围里查（整文件里 `const [state, setState] = useState(...)` 也含 `[state,`）
  const followDeps = /\}, \[([^\]]*)\]\)/.exec(component.slice(component.indexOf('const threadKey'), component.indexOf('const stickToBottom')))?.[1] ?? ''
  assert.equal(followDeps, 'threadKey, open', `跟随效果的依赖只能是内容指纹与 open（当前 "${followDeps}"）`)
})
