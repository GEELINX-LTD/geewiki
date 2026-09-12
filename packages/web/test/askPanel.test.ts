/**
 * `AskPanel` 的**终态**守卫（源码级）—— 本批 R12 修掉的那个"永久卡在生成中"。
 * ============================================================================
 *
 * ## 为什么这条必须用源码级断言
 *
 * 缺陷的形态是"某个分支没把状态落回去"：`markAiStreamStarted()` 把 phase 置成 `streaming`，
 * 而"两条端点都 404"的回退分支只 `setNotice(...)`、忘了改 phase ⇒ 提交按钮的
 * `disabled={streaming}` 永远为真、按钮文案永远是「生成中…」，`{streaming && …}` 里的
 * 「停止生成」也永远挂着。真实浏览器取证：12 秒后仍然如此，`POST /api/ai/stream` 与
 * `POST /api/ai/ask` 都是 404，用户只能刷新页面。
 *
 * 这种"少写一行"的缺陷用渲染测试很难覆盖（要造出两条端点同时 404 的 fetch 桩、
 * 还要跑真实的 SSE reader 路径），而它的关键恰恰是**这个分支里必须有那两件事**：
 * 明确文案 + 落回非流式状态。本仓库对同类"声明点"问题一律用源码守卫
 * （见 `accessPage.test.ts` / `opsPage.test.ts` / `areaState.test.ts`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'components', 'AskPanel.tsx'), 'utf8')

test('反空洞：AskPanel.tsx 真的读进来了，且两条端点与「停止生成」都还在', () => {
  assert.ok(src.length > 5000, `AskPanel.tsx 读入异常（仅 ${src.length} 字符），路径可能不对`)
  assert.match(src, /export function AskPanel\(/, '应能看到 AskPanel 定义')
  assert.match(src, /api\.aiAskStream\(/, '应能看到流式端点调用')
  assert.match(src, /await api\.aiAsk\(/, '应能看到一次性端点的回退调用（下面要切片的就是它）')
  /*
   * 「停止生成」（上一批 T3）不得因为这次改动消失：它只在 `streaming` 时出现，
   * 而"落回 idle"的终态处理正好会让它在未启用场景下消失 —— 这是**正确**的
   * （没有在跑的流就没有可停的东西），但真正的流式场景必须仍然有它。
   */
  assert.match(src, /停止生成/, '「停止生成」按钮不得被删掉（真正的流式场景仍需要它）')
  assert.match(src, /type="button"/, '停止按钮必须是 type="button"（否则点它会顺带提交一次）')
})

test('R12：两条端点都 404 时进入**终态** —— 明确文案 + 落回非流式（按钮不能用永久 disabled）', () => {
  /*
   * 切片：从一次性端点的调用点往后取一段，覆盖它自己的 catch 分支。
   * `at > 0` 已由上面那条反空洞断言保证（`await api.aiAsk(` 确实存在）。
   */
  const at = src.indexOf('await api.aiAsk(')
  assert.ok(at > 0, '应能定位回退调用点')
  const fallback = src.slice(at, at + 1600)
  assert.ok(fallback.length > 200, `回退分支切片过短（${fallback.length} 字符），切片依据可能已失效`)

  // ① 终态文案：说清"未启用 + 怎么启用 + 没模型密钥也能用"
  assert.match(fallback, /AI_DISABLED_NOTICE/, '两条端点都 404 时应使用专门的"未启用"终态文案')
  assert.match(
    src,
    /请先在插件管理中启用 @geewiki\/ai（未配置模型密钥时将以检索结果与抽取式摘要作答）/,
    '文案必须给出下一步：启用 @geewiki/ai，并说明没模型密钥时也能以检索结果作答',
  )
  // ② 404 的判据是**机器可查的**（状态码），不是猜文案
  assert.match(src, /status === 404/, '404 判据必须来自 ApiError.status')
  // ③ **关键**：这个分支必须把 phase 从 streaming 落回去，否则按钮永久禁用
  assert.match(
    fallback,
    /phase: 'idle'/,
    '404 终态必须把 phase 落回 idle（只 setNotice 不改 phase ⇒ 永久「生成中…」）',
  )
  // ④ 落回 phase 时不得顺手清掉已经拿到的 sources（`{...s, phase}` 是展开，不是重建）
  assert.match(fallback, /\{\s*\.\.\.s,\s*phase: 'idle'\s*\}/, '应保留其余状态（sources/retrieval）')
})
