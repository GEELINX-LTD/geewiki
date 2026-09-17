/**
 * **编辑器里给段落授权**（★ 本批补的功能缺口）—— 源码级守卫。
 * ============================================================================
 *
 * ## 守的是什么（一次真实的功能缺口）
 *
 * 块档位的第三档 `granted`（需单独授权）= **默认谁都读不到，靠例外授予放人**。
 * 曾经"授权名单"只长在权限对话框的「块级授权」分区里；那一块按作者要求在验收时移除后，
 * `granted` 就成了**设得出来、却没人能授权**的死档：作者把一段设成"需单独授权"，
 * 然后没有任何界面能指定授权给谁 —— 连他想给的同事也读不到。
 *
 * 修法：把**授予**放到**档位**旁边（编辑器工具栏的锁菜单 →「授权给谁…」），
 * 由宿主（`WikiEdit`）弹 `BlockGrantsDialog` 执行请求。本文件钉住这条链路的每一段。
 *
 * ## 为什么是源码级
 *
 * 这条链路的关键约束都是**声明点**问题：编辑器不得发网络请求、宿主必须把两个回调都接上、
 * 授予表单只能有一份实现。真渲染要拉起 CodeMirror + Radix + fetch 才验得到同一件事，
 * 而端到端那部分已经在 `scripts/acceptance/editor-modes-cdp.mjs` 里用真浏览器验过了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

/** 剥掉块注释、行注释与 JSX 注释（负向断言必须先剥：注释里就有那个字面量） */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

function read(...parts: string[]): { raw: string; code: string } {
  const raw = readFileSync(join(SRC, ...parts), 'utf8')
  return { raw, code: codeOnly(raw) }
}

const editor = read('components', 'MarkdownEditor.tsx')
const toolbar = read('components', 'editor', 'EditorToolbar.tsx')
const lazy = read('components', 'MarkdownEditorLazy.tsx')
const page = read('pages', 'WikiPage.tsx')
const dialog = read('components', 'access', 'BlockGrantsDialog.tsx')
const grantEditor = read('components', 'access', 'BlockGrantEditor.tsx')
/** 授权字段本体（类别/对象/角色/到期）—— 段落授权与页面授权**共用**这一份 */
const grantFields = read('components', 'access', 'GrantTargetFields.tsx')
/** 页面「权限」对话框里的「例外授予（页级）」 */
const grants = read('components', 'access', 'GrantsSection.tsx')
const directory = read('lib', 'subjectDirectory.ts')
const blocks = read('components', 'access', 'BlocksSection.tsx')

test('编辑器**不自己发请求**：授予走宿主回调（既有约定：编辑器只负责编辑区）', () => {
  for (const [name, file] of [
    ['MarkdownEditor.tsx', editor],
    ['EditorToolbar.tsx', toolbar],
  ] as const) {
    /*
     * 允许 `import type { BlockVisibility } from '../../api'`（类型在编译期被擦除，运行时不产生依赖），
     * 禁止**值导入**：`import { api } from '../../api'` 才是"编辑器自己发请求"的入口。
     */
    assert.doesNotMatch(
      file.code,
      /^\s*import\s+(?!type\b)[^\n]*from '[^']*\/api'/m,
      `${name} 不得**值导入** api（编辑器发请求会绕开宿主的鉴权/缓存/错误文案；只允许 import type）`,
    )
    assert.doesNotMatch(file.code, /\bapi\./, `${name} 不得调用 api.*`)
    assert.doesNotMatch(file.code, /\bfetch\(/, `${name} 不得直接 fetch`)
  }
})

test('锁菜单有「授权给谁…」，且它的可用性由宿主回调决定', () => {
  assert.match(toolbar.code, /授权给谁/, '锁菜单里必须有「授权给谁…」入口（否则 granted 档没人能授权）')
  assert.match(
    toolbar.code,
    /onManageBlockGrants !== null &&/,
    '入口必须按回调是否存在决定渲染：没有回调时不该出现一个点了没反应的按钮',
  )
  // 「需单独授权」时文案要说清"现在没人读得到" —— 这是这一档最容易误解的地方
  assert.match(toolbar.code, /current === 'granted'/, 'granted 档下必须有专门文案（现在没有授权对象能读到它）')
  // 编辑器把 { ordinal, excerpt } 交出去；ordinal 是与服务端换块 id 的唯一纽带
  assert.match(editor.code, /onManageBlockGrants\?: \(block: \{ ordinal: number; excerpt: string \}\) => void/)
  assert.match(editor.code, /onManageGrantsRef\.current\?\.\(\{ ordinal: block\.ordinal, excerpt:/, '必须交出 ordinal 与摘要')
  // 降级路径（无正文模型）不提供入口，且**不是**悄悄少一个按钮：它有可见说明（见 MarkdownEditorLazy 的降级文案）
  assert.match(lazy.code, /onManageBlockGrants=\{null\}/, '降级编辑器必须显式不提供该入口')
})

test('宿主把两端都接上：编辑器回调 → 对话框，且用页面档位决定提示', () => {
  assert.match(page.code, /onManageBlockGrants=\{setGrantBlock\}/, 'WikiEdit 必须把「授权给谁…」接到状态上')
  assert.match(page.code, /<BlockGrantsDialog/, 'WikiEdit 必须渲染 BlockGrantsDialog（执行请求的是宿主）')
  assert.match(page.code, /ordinal=\{grantBlock\?\.ordinal \?\? 0\}/, '对话必须收到当前段的 ordinal')
  assert.match(page.code, /onSaveFirst=\{async \(\) => \{/, '必须给"先保存再授权"这条出路（块是保存时解析出来的）')
})

test('对话框按 ordinal 换服务端块 id，并对"还没保存"给出出路', () => {
  assert.match(dialog.code, /blocks\?\.find\(\(b\) => b\.ordinal === ordinal\)/, '块 id 只能按 ordinal 查（前端不认服务端 id）')
  assert.match(dialog.code, /先保存正文，再继续授权/, '块不存在时必须给可执行的下一步，而不是一句"未找到"')
  assert.match(dialog.code, /slug === ''/, '新页面（还没有 slug）要被单独处理')
  // 块不存在有两种真实原因，说错归因比不说更坏
  assert.match(dialog.code, /还没保存的段落还不能授权/, '必须说明"未保存的段落不能授权"这一契约顺序')
  assert.match(dialog.code, /序号与上次保存的正文错位/, '必须覆盖第二种原因（未保存改动导致序号错位）')
})

test('授予表单只有**一份**实现：对话框与块总览共用 BlockGrantEditor', () => {
  assert.match(dialog.code, /<BlockGrantEditor/, '对话框必须复用共享的授予编辑区')
  assert.match(blocks.code, /<BlockGrantEditor/, '块总览也必须复用同一份（两份必然漂移，而漂移后果是两处授权结果不一致）')
  for (const [name, file] of [
    ['BlockGrantsDialog.tsx', dialog],
    ['BlocksSection.tsx', blocks],
  ] as const) {
    assert.doesNotMatch(file.code, /api\.addBlockGrant/, `${name} 不得自己实现"添加授权"（那份逻辑属于 BlockGrantEditor）`)
    assert.doesNotMatch(file.code, /api\.removeBlockGrant/, `${name} 不得自己实现"撤销授权"`)
  }
  // 共享实现里才允许出现这两个调用
  assert.match(grantEditor.code, /api\.addBlockGrant\(/, 'BlockGrantEditor 负责添加')
  assert.match(grantEditor.code, /api\.removeBlockGrant\(/, 'BlockGrantEditor 负责撤销')
  // 表单控件的 id 必须可区分：同一页会有多个块，重复 id 会让 label 指向第一个输入框
  assert.match(grantEditor.code, /idPrefix/, '表单 id 必须带前缀')
  assert.match(dialog.code, /idPrefix=\{`block-grant-\$\{block\.id\}`\}/, '对话框按块 id 给前缀')
  assert.match(blocks.code, /idPrefix=\{`blocks-section-\$\{b\.id\}`\}/, '块总览按块 id 给前缀（与对话框不同前缀，避免同页重复 id）')
})

test('`granted` 档下"没有授权对象"这件事必须被说出来', () => {
  assert.match(
    grantEditor.code,
    /需单独授权.*档.*没有人能读到它/s,
    'granted 且名单为空时必须明说"现在没有人能读到它" —— 否则作者会以为设完就完事了',
  )
})

test('授权对象：能列名单就给选择、列不了就手填并**说明 id 是什么**', () => {
  /*
   * 这条守的是真实反馈："授权时，所谓的 id 是什么"。
   * `subjectId` 是数据库 id（`users.id` / `groups.id`，判定侧逐字比对，见 plugin-authz），
   * 名单端点 `GET /api/org/members|groups` 原本要求**管理员**（现已按作者要求放宽为
   * "任何登录用户可读"），但授权只要 `manageVisibility` —— 所以"有权授权却看不到名单"
   * 曾经是一类真实存在的人。放宽之后**退路仍要留着**：未登录、或运维把端点改回 admin 时，
   * 界面必须还能走手填这条路，而不是把入口藏掉或谎称没有权限。
   */
  assert.match(directory.code, /api\.orgMembers\(\)/, '名单来自组织端点（不是另造一份）')
  assert.match(directory.code, /e\.status === 401 \|\| e\.status === 403/, '被拒要单独识别（403 = 没权限，不是失败）')
  assert.match(directory.code, /kind: 'available'/, '三态之一：能列名单')
  assert.match(directory.code, /kind: 'forbidden'/, '三态之二：没权限（手填 + 说明原因）')
  assert.match(directory.code, /kind: 'failed'/, '三态之三：读失败（**不得**谎称没权限）')
  // 解析不到名字时不许编造
  assert.match(
    directory.code,
    /\$\{kindWord\} id \$\{subjectId\}/,
    '拿不到名字时要写清是"用户 id N / 用户组 id N"，不能编一个名字或留空',
  )
  assert.match(directory.code, /const kindWord = subjectKind === 'group' \? '用户组' : '用户'/, 'kindWord 必须按类别取词')
  /*
   * 字段本体在 `GrantTargetFields`（**唯一实现**）：有名单用 select，没名单用输入框。
   * 这些断言曾经对着 `BlockGrantEditor` 的源码 —— 抽出去之后必须跟着搬，否则它们会
   * "因为找不到就静默失效"（`assert.match` 不会：它找不到就红，这正是我们要的）。
   */
  assert.match(
    grantFields.code,
    /const pickable = directory !== null && directory\.kind === 'available'/,
    '"可选"只能由三态里的 available 推出来（forbidden / failed 都必须退回手填）',
  )
  assert.match(grantFields.code, /pickable && !manualId \?/, '有名单 → 下拉选择')
  assert.match(grantFields.code, /placeholder=\{draft\.subjectKind === 'group' \? '用户组 id（数字）' : '用户 id（数字）'\}/, '手填时要说清填的是数字 id')
  assert.match(grantFields.code, /要授权的人不在名单里？改用手填 id/, '有名单时也要留手填出口（要授权的人可能不在名单里）')
  assert.match(grantFields.code, /directoryUnavailableHint\(directory\)/, '名单不可用时要把"为什么列不出来"就地写清')
  assert.match(grantEditor.code, /describeSubject\(g\.subjectKind, g\.subjectId, directory\)/, '名单里已有授权要显示成人名/组名')
})

test('页面级授权（「权限」对话框）与段落授权共用同一份字段：这一页也要能**下拉选人**', () => {
  /*
   * 守的是一次真实的漂移（作者反馈："权限按钮进去那个页面的还不能下拉选择用户"）：
   * 名单端点放宽为"任何登录用户可读"之后，编辑器那一份改成了下拉，而
   * 「权限」对话框 →「例外授予（页级）」仍是手填「对象 id」，旁边还留着放宽之前的那条理由。
   * 两处各修一遍必然再漂一次，所以这里同时钉住"共用一份实现"和"那一页自己别再画一个输入框"。
   */
  assert.match(grants.code, /<GrantTargetFields/, '页面级授权必须用共享字段（不许自己再画一组输入框）')
  assert.match(grants.code, /idPrefix="page-grant"/, '页面级字段要有自己的 id 前缀（同页可能同时挂着段落授权，label htmlFor 会串台）')
  assert.match(grants.code, /directory=\{directory\}/, '页面级授权必须把名单传下去')
  const loads = (grants.code.match(/loadSubjectDirectory\(\)/g) ?? []).length
  assert.equal(loads, 1, `名单应只取一次（实际 ${loads} 次）`)
  assert.doesNotMatch(
    grants.code,
    /本页不拉取它|成员\/组列表需要组织管理员权限/,
    '放宽之前的那条理由（"列表需要管理员权限，本页不拉取"）不得再出现在源码里',
  )
  assert.doesNotMatch(grants.code, /<Input[\s\S]{0,200}?对象 id/, '页面级授权不该再有手填「对象 id」的输入框')
  assert.match(
    grants.code,
    /describeSubject\(r\.subject_kind, r\.subject_id, directory\)/,
    '已授予的那一行要显示成人名/组名（原始 id 留作核对即可）',
  )
  assert.match(grants.code, /describeSubject\(draft\.subjectKind, draft\.subjectId\.trim\(\)/, '成功回执里也要用名字')
})

test('对话框在**问 id 的地方**回答"id 是什么"', () => {
  assert.match(dialog.code, /users\.id/, '必须说明是账号 id（users.id）')
  assert.match(dialog.code, /groups\.id/, '必须说明是用户组 id（groups.id）')
  assert.match(dialog.code, /directoryUnavailableHint\(directory\)/, '名单不可用时要给出"去哪儿看 id"的指引')
})

test('名单只取一次并传下去（不是每块各拉一次）', () => {
  const loads = (blocks.code.match(/loadSubjectDirectory\(\)/g) ?? []).length
  assert.equal(loads, 1, `块总览应只加载一次名单（实际 ${loads} 次）—— 几十块会打出几十个同样的请求`)
  assert.match(blocks.code, /directory=\{directory\}/, '块总览必须把名单传给共享编辑区')
  assert.match(dialog.code, /directory=\{directory\}/, '对话框必须把名单传给共享编辑区')
})
