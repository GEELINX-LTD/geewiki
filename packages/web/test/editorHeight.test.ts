/**
 * 编辑器高度与"编辑面撑满宿主"的守卫。
 *
 * 起因是一次真实缺陷：用户报「编辑器这里的最小高度太大了，中间有一大片空白」。
 * 实测（headless Chrome 量 `getBoundingClientRect`）根因是**两件事叠加**：
 *
 *   1. 下限太高：页面传 `minHeight="480px"`；
 *   2. **编辑面不跟随宿主高度** —— 宿主被 `min-height` 撑到 480px，而 `.cm-editor`
 *      由内容决定高度，实测只有 247px。于是边框只围住上半截，下面 233px 是
 *      **既不在编辑器边框内、点了也没有反应**的死区，看起来像布局坏了。
 *
 * 所以判据不能只钉"数值变小了"（那只是把死区变小，没消除），必须同时钉住
 * **`.cm-editor { min-height: inherit }`** 这条结构不变量 —— 它才是"没有死区"的成因。
 *
 * 另一条不变量是**唯一真源**：这个高度原本在三个地方各写一遍
 * （`MarkdownEditor` 默认 420、`MarkdownEditorLazy` 默认 420、`WikiPage` 传 480、
 * 页面骨架 `h-[420px]`），其中骨架与真编辑器**当时就已经不一致**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_EDITOR_MIN_HEIGHT } from '../src/lib/editorHeightPlan'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
/**
 * 剥注释：本仓库的注释里必然引述"旧写法"，不剥就会自己把自己判红
 * （本文件上面那段说明里就写着 `480px` / `420px`）。这是本仓库第 6 次踩这个坑。
 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const read = (rel: string): string => stripComments(readFileSync(join(SRC, rel), 'utf8'))

test('★ 编辑面必须撑满宿主（min-height: inherit），否则下方留下点不动的死区', () => {
  const ts = read('components/MarkdownEditor.tsx')
  const amp = /\n  '&':\s*\{([\s\S]*?)\n  '&\.cm-focused'/.exec(ts)
  assert.ok(amp, '未能在 baseTheme 里定位到 `&` 规则（判据失效即红，不要当成通过）')
  assert.match(
    amp[1] as string,
    /minHeight:\s*'inherit'/,
    '`.cm-editor` 必须 `min-height: inherit`：宿主只有 `min-height`，而编辑面高度由内容决定 ——' +
      '短文档下编辑面比宿主矮，边框只围住上半截，下面那片空白既不在编辑面内、点了也没有反应。' +
      '（实测：宿主 480px / 编辑面 247px ⇒ 233px 死区）',
  )
})

test('★ 高度下限只能有一个真源，三个消费方都不得再写死数值', () => {
  const consumers: Array<[string, string]> = [
    ['components/MarkdownEditor.tsx', '编辑面'],
    ['components/MarkdownEditorLazy.tsx', '懒加载骨架 + 降级 textarea'],
    ['pages/WikiPage.tsx', '页面加载骨架'],
  ]
  for (const [rel, what] of consumers) {
    const ts = read(rel)
    assert.match(ts, /DEFAULT_EDITOR_MIN_HEIGHT/, `${rel}（${what}）必须取 DEFAULT_EDITOR_MIN_HEIGHT`)
    assert.doesNotMatch(
      ts,
      /minHeight[:=]\s*['"]\d+px['"]/,
      `${rel}（${what}）不得再写死 minHeight 数值：这个值曾在三处各写一遍，` +
        '其中页面骨架（420px）与真编辑器（480px）当时就已经不一致 —— 骨架尺寸不对就是 CLS',
    )
    assert.doesNotMatch(
      ts,
      /h-\[\d+px\][^\n]*Skeleton|Skeleton[^\n]*h-\[\d+px\]/,
      `${rel}（${what}）的骨架高度不得用字面量类名：Tailwind 的任意值无法引用常量，` +
        '一旦改常量它就悄悄漂移（用定高 div 包一层，见 WikiPage 的写法）',
    )
  }
})

test('★ 下限本身要是"一个编辑器该有的最小高度"，不能又回到一大片空白', () => {
  const m = /^(\d+)px$/.exec(DEFAULT_EDITOR_MIN_HEIGHT)
  assert.ok(m, `DEFAULT_EDITOR_MIN_HEIGHT 必须是 px 字面量，实得 ${DEFAULT_EDITOR_MIN_HEIGHT}`)
  const px = Number(m[1])
  assert.ok(px >= 120, `${px}px 太小：编辑区至少要能舒服地写几行`)
  assert.ok(
    px <= 320,
    `${px}px 太大：短文档（如首页，实测内容高约 247px）下方会留一大片空白 —— ` +
      '这正是用户报的那个缺陷。注意下限**只是下限**，长文档会照常长高（已实测 2497px 情形）',
  )
})