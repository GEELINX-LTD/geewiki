/**
 * 「查询语义可切换」的接线不变量（源码级守卫）。
 *
 * 与 `homeUi.test.ts` / `navListUi.test.ts` 同一条理由：下面每一条都是"改起来很容易顺手破坏、
 * 跑起来又不报错"的类型。纯逻辑（`detectQueryMode` / `suggestTermsOnEmpty` / 文案）由
 * `searchPlan.test.ts` 覆盖；服务端两种语义的行为由 `packages/plugin-search` 的测试覆盖。
 *
 * 这里钉的是**中间那一层**——界面到底有没有把语义传给后端、有没有让用户看得见、以及
 * **有没有偷偷自动重试**。最后一条尤其重要：本批修的缺陷是"问句在 phrase 下恒 0 命中"，
 * 一个很自然但错误的"修法"是搜不到就自动换 terms 重搜一遍。那会让用户以为自己搜的就是
 * 原串（结果集变了却没有任何提示），违背本仓"失败语义诚实"的既定纪律。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

/**
 * 去掉注释后再断言，避免命中"解释这条规则"的注释本身。
 * `(^|[^:])` 那一段是为了**不误伤 `https://`** —— 否则把 URL 里的 `//` 当成行注释起点，
 * 会把后半行代码一起删掉，守卫就变成了永远通过的空断言。
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const searchView = codeOnly(readFileSync(join(SRC, 'components', 'SearchView.tsx'), 'utf8'))
const apiTs = codeOnly(readFileSync(join(SRC, 'api.ts'), 'utf8'))

test('查询语义真的传给了后端（不是只在界面上摆了个开关）', () => {
  assert.match(
    searchView,
    /\.search\(checked\.value,\s*\{\s*limit,\s*mode\s*\}\)/,
    'SearchView 必须以 { limit, mode } 调用 api.search —— 只传 limit 就是本批要修的原缺陷',
  )
  assert.match(apiTs, /&mode=\$\{opts\.mode\}/, 'api.search 必须把 mode 拼进 /api/search 的查询串')
  assert.match(apiTs, /opts\.mode === undefined \? '' :/, 'mode 缺省时不拼参数（缺省语义归后端定义，前端不复制）')
})

test('语义随查询串复位：提交新检索时重新猜缺省，不把上一次的手动选择带过去', () => {
  assert.match(
    searchView,
    /const next = detectQueryMode\(query\)/,
    '新查询串必须重新推导缺省语义（否则"这次为什么又是分词"无法解释）',
  )
  assert.match(searchView, /setMode\(next\)/, '推导结果要写回 state')
  assert.match(searchView, /setLimit\(PAGE_FIRST\)/, '同一分支里 limit 也要复位（两者必须同生同死）')
  assert.match(searchView, /useState<SearchQueryMode>\(\(\) => detectQueryMode\(query\)\)/, '首帧就用推导值，不能先硬编码 phrase 再纠正')
})

test('两个语义在界面上可见、可切换，且用 aria-pressed 表达当前态', () => {
  assert.match(searchView, /QUERY_MODE_OPTIONS\.map\(/, '选项必须来自共享常量（不在组件里手抄一份）')
  assert.match(searchView, /aria-pressed=\{mode === o\.id\}/, '切换按钮必须暴露按下态（读屏用户唯一的"现在是哪个模式"）')
  assert.match(searchView, /queryModeOption\(mode\)\.hint/, '当前语义的说明文字必须随选择变化')
  assert.match(searchView, /queryModeNote\(mode\)/, '结果区必须显示"这一轮是怎么问的"，否则模式差异无法解释')
})

test('0 命中时**只引导、不自动重试**——setMode 只能由用户动作或查询变更触发', () => {
  const calls = searchView.match(/setMode\(/g) ?? []
  assert.equal(
    calls.length,
    3,
    'setMode 应恰有三处：查询变更复位、模式切换按钮、空结果的引导按钮；' +
      '多出来的那处极可能是"搜不到就自动换 terms 重搜"，那会静默改变用户的问题语义',
  )
  assert.match(searchView, /onClick=\{\(\) => setMode\(o\.id\)\}/, '模式切换必须挂在用户点击上')
  assert.match(searchView, /suggestTermsOnEmpty\(mode, data\.total\)/, '空结果引导必须走共享判据')
  assert.match(searchView, /onClick=\{\(\) => setMode\('terms'\)\}/, '引导按钮由用户点击后才换语义')
  // 反向：不得出现"在 effect 里自动切到 terms"的写法
  assert.ok(
    !/useEffect\([\s\S]*?setMode\('terms'\)[\s\S]*?\}, \[/.test(searchView),
    'effect 内不得自动切换语义（静默重试会让用户以为搜的就是原串）',
  )
})

test('空结果引导只在精确匹配时出现（反向引导是骗人的）', () => {
  // 判据本身在 searchPlan.test.ts 里覆盖；这里钉住界面**没有**绕过它自己写条件
  assert.ok(
    !/mode === 'phrase' && data\.total === 0/.test(searchView),
    '界面不得自己重写"该不该引导"的条件——必须走 suggestTermsOnEmpty',
  )
})
