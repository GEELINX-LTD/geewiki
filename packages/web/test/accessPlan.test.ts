/**
 * **权限治理的纯逻辑**（M1-M3）—— 单测。
 * ============================================================================
 *
 * 这些函数看着像"文案表"，但每一条错误都对应一次真实的误操作：
 * - `resyncNotice` 把"扇出失败（内容泄漏级）"说成"该页没有子孙块" ⇒ 管理员以为一切正常；
 * - `conflictText` 把 `already_has_access` 说成 `already_requested` ⇒ 用户白等一轮；
 * - `blockVisibilityOptions` 漏掉收敛 ⇒ 界面给出一个"比页面更宽"的块档位选项。
 *
 * 所以下面既断言"有文案"，也断言**分支之间可区分**（互相不同的文本），
 * 并用**真实枚举值**参数化（手写几个假档位名会让测试与生产取值脱节）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOCK_VISIBILITIES,
  CONFLICT_CODES,
  PAGE_VISIBILITIES,
  PAGE_VISIBILITY_OPTIONS,
  blockVisibilityOptions,
  conflictText,
  expiresAtFromLocal,
  isWiderThanPage,
  narrowingHint,
  parseAccessRoute,
  resyncNotice,
  subjectIdError,
  visibilityLabel,
} from '../src/lib/accessPlan'

/* ========================= 一、三档文案全覆盖 ========================= */

test('档位选项：三档与真实枚举一一对应，label/hint 都非空且互不相同', () => {
  // 反空洞：先证明枚举与选项都抽到了东西
  assert.equal(PAGE_VISIBILITIES.length, 3, `页面档位枚举应有 3 档（实际 ${PAGE_VISIBILITIES.length}）`)
  assert.equal(PAGE_VISIBILITY_OPTIONS.length, 3, '三档必须都有文案')

  assert.deepEqual(
    PAGE_VISIBILITY_OPTIONS.map((o) => o.id),
    [...PAGE_VISIBILITIES],
    '选项顺序与枚举必须一致（窄 → 宽），界面据此渲染 radio',
  )
  const labels = new Set(PAGE_VISIBILITY_OPTIONS.map((o) => o.label))
  const hints = new Set(PAGE_VISIBILITY_OPTIONS.map((o) => o.hint))
  assert.equal(labels.size, 3, '三档 label 不得重复（复制粘贴漂移会让用户选错档）')
  assert.equal(hints.size, 3, '三档 hint 不得重复')
  for (const o of PAGE_VISIBILITY_OPTIONS) {
    assert.ok(o.label.trim().length > 0, `${o.id} 的 label 不能为空`)
    assert.ok(o.hint.trim().length >= 20, `${o.id} 的 hint 应说清"谁能读"（实际 ${o.hint.length} 字）`)
  }
})

test('档位文案：每一档都说清匿名与成员各自能否读到', () => {
  const byId = new Map(PAGE_VISIBILITY_OPTIONS.map((o) => [o.id, o]))
  const privateHint = byId.get('private')?.hint ?? ''
  const orgHint = byId.get('org')?.hint ?? ''
  const publicHint = byId.get('public')?.hint ?? ''

  for (const [id, hint] of [
    ['private', privateHint],
    ['org', orgHint],
    ['public', publicHint],
  ] as const) {
    assert.match(hint, /匿名/, `${id} 档必须说明匿名访客能不能读`)
    assert.match(hint, /成员/, `${id} 档必须说明组织成员能不能读`)
  }
  // 各档的差别必须写出来（否则三档文案等于同一句）
  assert.match(orgHint, /匿名访客读不到/, 'org 档的关键信息是"匿名读不到"')
  assert.match(privateHint, /都读不到/, 'private 档的关键信息是"谁都读不到（除单独授权）"')
})

test('档位文案：public 档必须提到「发布」（否则匿名其实读不到）', () => {
  const publicHint = PAGE_VISIBILITY_OPTIONS.find((o) => o.id === 'public')?.hint ?? ''
  assert.match(
    publicHint,
    /发布/,
    'public 档只有配上「已发布」才对匿名可见；文案不提发布就是在教用户做错事',
  )
})

/* ===================== 二、扇出（tier 重算）结果 ===================== */

test('resyncNotice：失败分支是 danger，且同时点出「检索」与「内容泄漏级」', () => {
  const r = resyncNotice({ index_tiers_resynced: 0, index_tiers_resync_failed: true })
  assert.equal(r.tone, 'danger', '扇出失败必须用危险态（不能用"已保存"的平静语气）')
  assert.match(r.text, /检索/, '必须说明"检索仍可能按旧档位命中"')
  assert.match(r.text, /内容泄漏级/, '必须点明严重级别（读路径安全、检索路径泄漏）')
  assert.match(r.text, /运维/, '必须给出下一步（前端没有重算端点，只能指路运维）')
  // 不得声称"已同步成功"
  assert.doesNotMatch(r.text, /已同步|同步成功/, '失败时不得出现任何"已同步"的措辞')
})

test('resyncNotice：三个分支互相可区分（0 与失败绝不能合并）', () => {
  const failed = resyncNotice({ index_tiers_resynced: 0, index_tiers_resync_failed: true })
  const zero = resyncNotice({ index_tiers_resynced: 0, index_tiers_resync_failed: false })
  const many = resyncNotice({ index_tiers_resynced: 7, index_tiers_resync_failed: false })

  assert.equal(zero.tone, 'ok')
  assert.equal(many.tone, 'ok')
  assert.equal(new Set([failed.text, zero.text, many.text]).size, 3, '三条文案必须互不相同')
  assert.match(many.text, /并同步了 7 个子孙块的检索档位/)
  assert.match(zero.text, /没有子孙块需要同步/)
  // 同一个 resynced=0，仅凭 failed 就必须给出不同的结论
  assert.notEqual(zero.tone, failed.tone)
  assert.doesNotMatch(zero.text, /泄漏/, '"没有子孙块"不是泄漏，不能吓唬人')
})

/* ========================= 三、冲突码 → 人话 ========================= */

test('conflictText：M3 要求的四条文案逐字正确', () => {
  assert.equal(conflictText('already_requested'), '你已经提交过申请了，请等待处理。')
  assert.equal(
    conflictText('already_has_access'),
    '你已经有这条内容的访问权限了，无需申请（请刷新页面）。',
  )
  // 申请提交语境：这里的 404 指**页面**不存在 ⇒ 无法申请（显式传语境，见下面的语境用例）
  assert.equal(conflictText('not_found', 'apply'), '这条内容不存在，无法申请。')
  assert.equal(
    conflictText('request_not_pending'),
    '这条申请已被处理（可能在你打开页面后被他人裁决），列表已刷新。',
  )
})

test('conflictText：`not_found` 按**语境**分文案（同一个码在两类端点上指的不是同一个对象）', () => {
  /*
   * 缺陷（本批 R2）：后端三处 404 的含义不同 ——
   * - `POST /api/pages/:slug/access-requests`（申请提交）的 404 是**页面**不存在；
   * - approve / deny / withdraw 的 404 是 `申请不存在: <id>`，即**这条申请**不存在
   *   （已被他人裁决或撤回）。
   * 原先三个调用点共用一句"这条内容不存在，无法申请。"：管理员点「批准」失败时，
   * 界面把动作说成了"申请"、把对象说成了"内容" —— 两句都错，用户会去怀疑页面被删了。
   */
  const submit = conflictText('not_found', 'apply')
  const act = conflictText('not_found', 'request')
  assert.ok(submit !== null && act !== null, '两种语境都必须有文案')
  assert.notEqual(submit, act, '两种语境的文案必须不同 —— 否则这个参数等于没传')

  // 申请提交语境：说"页面不存在 ⇒ 无法申请"，且**不得**说成"申请已不存在"
  assert.match(submit as string, /不存在/)
  assert.match(submit as string, /无法申请/)
  assert.doesNotMatch(submit as string, /申请已不存在/, '提交语境下的 404 不是"申请不存在"')

  // 裁决/撤回语境：说"这条申请已不存在 + 可能被他人处理 + 列表已刷新"，且**不得**说成"无法申请"
  assert.match(act as string, /这条申请已不存在/)
  assert.match(act as string, /他人裁决|他人处理/)
  assert.match(act as string, /列表已刷新/)
  assert.doesNotMatch(act as string, /无法申请/, '裁决语境下把动作说成"申请"是错的（动作是批准/拒绝/撤回）')
  assert.doesNotMatch(act as string, /这条内容不存在/, '裁决语境下的对象是"申请"，不是"内容"')

  // 默认语境是 apply（老调用点不传参数时不会静默变成另一种话）
  assert.equal(conflictText('not_found'), submit)
})

test('conflictText：语境只影响确实要说两种话的码 —— 其余码两种语境下逐字相同', () => {
  for (const code of CONFLICT_CODES) {
    if (code === 'not_found') continue // 唯一的例外，见上一条
    assert.equal(
      conflictText(code, 'request'),
      conflictText(code, 'apply'),
      `${code} 在两个语境下说的是同一件事，不该分叉（分叉就要各写一份断言）`,
    )
  }
  // 未知码在**任何**语境下都返回 null（不臆造文案）
  assert.equal(conflictText('boom', 'request'), null)
  assert.equal(conflictText('', 'apply'), null)
})

test('conflictText：7 个码全部有文案，且互不相同（无占位式重复）', () => {
  const codes = [
    'already_requested',
    'already_has_access',
    'request_not_pending',
    'not_found',
    'forbidden',
    'unauthorized',
    'invalid_subject_kind',
  ] as const
  const texts: string[] = []
  for (const code of codes) {
    const t = conflictText(code)
    assert.ok(t !== null && t.trim() !== '', `${code} 必须有专门文案（否则用户只能看到通用提示）`)
    texts.push(t as string)
  }
  assert.equal(texts.length, 7)
  assert.equal(new Set(texts).size, 7, '7 条文案必须互不相同 —— 不同码的下一步动作不同')
  // 与实现里的表保持一致（防止"表里加了码、测试没跟上"）
  assert.deepEqual([...CONFLICT_CODES].sort(), [...codes].sort())
})

test('conflictText：未知码返回 null（**不臆造文案**）', () => {
  for (const unknown of ['', 'boom', 'NOT_FOUND', 'not_found ', 'invalid_role', 'last_owner']) {
    assert.equal(conflictText(unknown), null, `${JSON.stringify(unknown)} 不该有文案 —— 调用方应回退到通用错误提示`)
  }
})

/* ======================= 四、块的档位收敛（B1） ======================= */

test('blockVisibilityOptions：页面的每一档都至少留下一个选项（结果非空）', () => {
  for (const page of PAGE_VISIBILITIES) {
    const opts = blockVisibilityOptions(page, BLOCK_VISIBILITIES)
    assert.ok(opts.length > 0, `页面档位 ${page} 下必须仍有可比它更窄的块档位可选`)
  }
})

test('blockVisibilityOptions：结果绝不含比页面更宽的档位（用真实枚举参数化）', () => {
  assert.ok(BLOCK_VISIBILITIES.length >= 3, '反空洞：块档位枚举应至少有 3 档')
  for (const page of PAGE_VISIBILITIES) {
    for (const opt of blockVisibilityOptions(page, BLOCK_VISIBILITIES)) {
      assert.ok(
        (BLOCK_VISIBILITIES as readonly string[]).includes(opt),
        `${opt} 必须是真实存在的块档位（不得凭筛选"造"出取值）`,
      )
      assert.equal(
        isWiderThanPage(opt, page),
        false,
        `页面 ${page} 下不该出现更宽的块档位 ${opt}（规则 B1：块只能更窄）`,
      )
    }
  }
})

test('blockVisibilityOptions：边界 —— private 只剩 granted，public 保留全部，org 去掉 public', () => {
  assert.deepEqual(blockVisibilityOptions('private', BLOCK_VISIBILITIES), ['granted'])
  assert.deepEqual(blockVisibilityOptions('org', BLOCK_VISIBILITIES), ['granted', 'org'])
  assert.deepEqual(blockVisibilityOptions('public', BLOCK_VISIBILITIES), [...BLOCK_VISIBILITIES])
})

test('blockVisibilityOptions：未知页面档位 ⇒ 空集（失败关闭，不猜宽窄）', () => {
  assert.deepEqual(blockVisibilityOptions('top-secret', BLOCK_VISIBILITIES), [])
  assert.deepEqual(blockVisibilityOptions('', BLOCK_VISIBILITIES), [])
  // 未知**块**档位被丢掉（无法判断宽窄 ⇒ 宁可不展示）
  assert.deepEqual(blockVisibilityOptions('org', ['org', 'private', 'role=editor']), ['org'])
})

/* ========================= 五、每块的可见性说明 ========================= */

test('narrowingHint：授权档（tier === null）必须说清"变宽也不会一并放行"', () => {
  const hint = narrowingHint({ visibility: 'granted', tier: null }, 'public')
  assert.match(hint, /授权档/)
  assert.match(hint, /只有被单独授权的人可读/)
  assert.match(hint, /变宽也不会一并放行/)
})

test('narrowingHint：块比页面宽时点明"由页面决定"，否则说"取更窄的一方"', () => {
  const wider = narrowingHint({ visibility: 'public', tier: 1 }, 'org')
  assert.match(wider, /比页面档位/)
  assert.match(wider, /不会突破页面上限/)
  const narrower = narrowingHint({ visibility: 'org', tier: 1 }, 'org')
  assert.match(narrower, /取两者中更窄的一方/)
  const grantedOnPublic = narrowingHint({ visibility: 'granted', tier: null }, 'private')
  assert.match(grantedOnPublic, /授权档/)
})

test('visibilityLabel：已知值给中文短名，未知值原样回显（不猜）', () => {
  assert.equal(visibilityLabel('public'), '公开')
  assert.equal(visibilityLabel('org'), '组织内')
  assert.equal(visibilityLabel('private'), '私有')
  assert.equal(visibilityLabel('granted'), '授权档')
  assert.equal(visibilityLabel('weird'), 'weird')
})

/* ========================== 六、治理路由解析 ========================== */

test('parseAccessRoute：#/access 是首页，带 slug 时归一化编码与未编码两种写法', () => {
  assert.deepEqual(parseAccessRoute(''), { kind: 'home' })
  assert.deepEqual(parseAccessRoute('/'), { kind: 'home' })
  assert.deepEqual(parseAccessRoute('guide/intro'), { kind: 'page', slug: 'guide/intro' })
  assert.deepEqual(
    parseAccessRoute('guide%2Fintro'),
    { kind: 'page', slug: 'guide/intro' },
    '编码过的分层 slug 必须与未编码写法归一（否则同一个页面解析出两个 slug）',
  )
})

test('parseAccessRoute：坏转义不抛错（退回原串）', () => {
  assert.deepEqual(parseAccessRoute('%E0%A4%A'), { kind: 'page', slug: '%E0%A4%A' })
})

/* ========================== 七、表单校验辅助 ========================== */

test('subjectIdError：非空、≤128（与服务端校验一致）', () => {
  assert.ok(subjectIdError('') !== null)
  assert.ok(subjectIdError('   ') !== null, '纯空白视为空')
  assert.equal(subjectIdError(' 42 '), null, '两侧空白应被容忍（trim 后合法）')
  assert.equal(subjectIdError('a'.repeat(128)), null)
  assert.ok(subjectIdError('a'.repeat(129)) !== null)
})

test('expiresAtFromLocal：三态可判别 —— 空=不过期、合法=ISO、非法=拦下', () => {
  assert.deepEqual(expiresAtFromLocal(''), { ok: true, iso: null })
  const ok = expiresAtFromLocal('2030-01-02T03:04')
  assert.equal(ok.ok, true)
  /*
   * 只断言"是同一时刻的 ISO 串"，**不断言字面量前缀**：`datetime-local` 给的是本地时间，
   * 转成 ISO（UTC）后小时数会随运行环境的时区变化 —— 写死前缀会让测试在非 UTC+8 的
   * 机器上红，而那不是产品缺陷（实测本机为 +08:00）。
   */
  if (ok.ok && ok.iso !== null) {
    assert.equal(new Date(ok.iso).getTime(), new Date('2030-01-02T03:04').getTime())
    assert.match(ok.iso, /Z$/, '提交给服务端的应是 ISO（UTC）串')
  } else {
    assert.fail('合法的 datetime-local 值应被接受')
  }
  assert.deepEqual(expiresAtFromLocal('不是一个时间'), { ok: false })
})
