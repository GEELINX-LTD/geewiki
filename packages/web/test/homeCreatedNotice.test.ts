/**
 * **主页创建后的档位提醒** —— 源码级守卫。
 * ============================================================================
 *
 * ## 缺陷形态（本次任务）
 *
 * 新页面的默认档位是 **`org` 且未发布**（`packages/plugin-wiki/src/index.ts:1141-1142`
 * 的 `VALUES (?, ?, ?, ?, ?, 'org', 1, 0, ?)`，`:2133-2135` 说明 `public` 档**必须同时
 * 发布**才对匿名可见）。主页是站点的**默认落点**，所以"建完主页就跳走"的后果是：
 * 匿名访客打开站点看到「主页当前不可访问」的中性面板（那是设计好的、刻意不区分
 * "不存在"与"无权"的文案），而**没有任何地方告诉创建者这是档位问题**。
 *
 * ## 为什么必须是源码级断言
 *
 * 判据与文案都在 `WikiPage.tsx` 的渲染与保存路径里，没有可单独调用的纯函数：
 * ① 提示是否**只在** `outcome === 'created'` 分支出现（`updated` 是"覆盖了已存在的页"，
 *    口径完全不同，混进去就是把"新建"说成"覆盖"）；
 * ② 提示是否**可见**（`role="status"`，不是只挂 `title`）；
 * ③ 提示是否带得走下一步（指路「权限」档位与「已发布」开关）。
 * 这三条都只能对着声明点断言。
 *
 * ## 反空洞
 *
 * 每条负向断言之前都先断言"能读到目标文件、且文件里有可定位的目标串"，避免因路径写错
 * 或正则失配而恒真。断言切片用 `indexOf` 且**显式**判断 `>= 0`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

/** 剥掉块注释与行注释（注释里会引用被禁的写法，会让负向断言假阳性） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const raw = readFileSync(join(SRC, 'pages', 'WikiPage.tsx'), 'utf8')
const wiki = codeOnly(raw)

test('主页创建提示：文案与可访问性齐备，且指向「权限」的档位与发布开关', () => {
  // 反空洞①：文件真的读进来了
  assert.ok(raw.length > 5000, `WikiPage.tsx 内容异常短（${raw.length} 字符），疑似读错文件`)

  // 反空洞②：文案本身存在的（原文逐字照抄，改文案时这条会红，提醒同步断言）
  const NOTICE = '主页已创建。它当前只对组织内可见'
  assert.ok(raw.includes(NOTICE), '找不到主页创建提示的文案')

  /*
    断言必须落在**渲染块**里，而不是赋值点：文案在 `setHomeCreatedNotice('…')` 里也出现一次，
    按"第一次命中"切片会切到保存回调，`role="status"` 自然找不到（这正是本测试第一版踩的坑）。
    故锚点取渲染判据 `{homeCreatedNotice !== null &&`。
  */
  const renderAt = wiki.indexOf('{homeCreatedNotice !== null &&')
  assert.ok(renderAt >= 0, '找不到渲染判据（提示压根没有渲染点）')
  const block = wiki.slice(renderAt, renderAt + 900)

  // 渲染块里渲染的必须是**这个** state（而不是别的提示串了台）
  assert.match(block, /\{homeCreatedNotice\}/, '渲染块没有渲染 homeCreatedNotice（提示与 state 对不上）')
  assert.match(block, /role="status"/, '提示缺少 role="status"：必须能被屏幕阅读器播报')

  // 提示必须给出**下一步动作**：去「权限」把档位设为公开 + 打开发布
  // （文案在赋值处，动作词一并落在赋值的字符串里 —— 故对文案本体断言）
  const noticeAt = wiki.indexOf(NOTICE)
  assert.ok(noticeAt >= 0, '剥离注释后找不到文案，说明它只写在注释里（反空洞失败）')
  const noticeLiteral = wiki.slice(noticeAt, noticeAt + 200)
  assert.match(noticeLiteral, /「权限」/, '提示没有指路页面上的「权限」入口')
  // ★ 按钮文案是「权限」而**不带省略号**（作者要求）：省略号读起来像"还有没显示出来的东西"
  assert.doesNotMatch(noticeLiteral, /「权限…」/, '入口名不带省略号')
  assert.match(noticeLiteral, /档位设为公开/, '提示没说清要把档位设为公开')
  assert.match(noticeLiteral, /已发布/, '提示没说清要打开「已发布」开关')
})

test('主页创建提示：只认服务端 outcome，且只在「创建主页」这条路径上生效', () => {
  // 反空洞：判据串确实存在（`api.ts:414` 的 SaveResult.outcome 三态）
  const guardAt = wiki.indexOf("r.outcome === 'created'")
  assert.ok(guardAt >= 0, "找不到 `r.outcome === 'created'` 判据")

  // 提示的设置点必须在 outcome 判据之后的同一小窗口内 ⇒ 两者是同一个分支
  const setAt = wiki.indexOf('setHomeCreatedNotice(')
  assert.ok(setAt >= 0, '找不到 setHomeCreatedNotice 调用（提示压根没接线）')
  assert.ok(
    setAt > guardAt && setAt - guardAt < 1200,
    'setHomeCreatedNotice 不在 `outcome === \'created\'` 分支内：提示会跑到覆盖路径上',
  )

  // 同一条路径还必须要求 createHomeMode（否则普通新建也会显示"主页已创建"）
  const branchAt = wiki.lastIndexOf('createHomeMode', guardAt)
  assert.ok(branchAt >= 0 && guardAt - branchAt < 200, '该分支没有同时要求 createHomeMode')

  /*
    负向：`outcome === 'updated'` 那侧不得出现这条提示。
    做法：取"更新/覆盖"关键字与提示设置点，断言提示**不在**覆盖提示的邻域里，
    反之亦然 —— 两条提示必须各在各的分支。
  */
  assert.doesNotMatch(
    wiki.slice(setAt, setAt + 600),
    /outcome === 'updated'|已存在.*覆盖|覆盖.*已存在/,
    "创建提示与「覆盖已存在页面」的口径混在同一段里",
  )
})

test('主页创建提示：常驻可关，且不提供第二次保存（避免覆盖刚写的那一版）', () => {
  const setAt = wiki.indexOf('setHomeCreatedNotice(')
  assert.ok(setAt >= 0, '反空洞：找不到设置点')

  // 必须有渲染点（否则设置了个永远不显示的 state）
  const renderAt = wiki.indexOf('{homeCreatedNotice !== null &&')
  assert.ok(renderAt >= 0, '提示没有渲染点（设了 state 却从不显示）')

  // 必须给离场动作：主页已经建好了，留在"新建页面"表单上没有意义
  assert.match(wiki.slice(renderAt, renderAt + 800), /前往主页/, '提示没有给出离场动作')

  // 保存按钮必须被这条提示禁用（不然再点一次保存 = 覆盖刚写的那一版）
  const saveBtnAt = wiki.indexOf('disabled={homeCreatedNotice !== null}')
  assert.ok(saveBtnAt >= 0, '保存按钮没有被「主页已创建」禁用')
})
