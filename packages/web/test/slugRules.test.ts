/**
 * **后端规则对齐守卫**（本文件存在的唯一理由）。
 *
 * 背景：`packages/web` 不能 import `@geewiki/wiki`（不是依赖）也不能 import
 * `@geewiki/core`（core 顶层 `import 'node:fs'`，进浏览器会炸），所以
 * `lib/slugRules.ts` 只能是后端规则的**手抄镜像**。手抄就会漂移——
 * 而且这次的漂移极其隐蔽：后端放开路径式 slug 后，前端仍用旧正则，
 * 结果"用户在表单里填 `guide/intro` 被前端拒掉"，同时**所有前端测试都是绿的**
 * （因为旧测试恰好断言 `a/b` 非法）。
 *
 * 这个守卫怎么做到"不空洞通过"：
 * 1. 它**真的 import 后端源码模块**（`packages/plugin-wiki/src/index.ts`），
 *    拿到真实的 `isValidSlug` 与常量——不是读文本、不是再抄一遍；
 * 2. 用**同一份案例语料**喂给后端与前端镜像，逐条断言结论一致；
 * 3. 另行断言四个常量（长度/深度/保留首段/保留第二段）逐个相等。
 *
 * 因此：后端改规则而前端没跟 ⇒ 行为或常量比对立刻红。反过来，如果哪天有人
 * 把语料删空、或写成 `assert.ok(true)`，第 2 组用例会因"语料必须覆盖各类边界"
 * 的显式断言而失败（见 `CASES` 的长度与分类断言）——避免"零案例也算通过"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  RESERVED_FIRST_SEGMENTS,
  RESERVED_SECOND_SEGMENT,
  SLUG_MAX_DEPTH,
  SLUG_MAX_LENGTH,
  isValidSlug as isValidSlugMirror,
} from '../src/lib/slugRules'

/* --------------------------- 定位并导入后端模块 --------------------------- */

/** 从当前文件向上找到含 `pnpm-workspace.yaml` 的目录（不依赖测试文件被放在哪一层） */
function findRepoRoot(from: string): string {
  let dir = dirname(from)
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('未能从测试文件位置向上找到仓库根（pnpm-workspace.yaml）')
}

interface BackendSlugModule {
  isValidSlug: (slug: unknown) => boolean
  SLUG_MAX_LENGTH: number
  SLUG_MAX_DEPTH: number
  RESERVED_FIRST_SEGMENTS: ReadonlySet<string>
  RESERVED_SECOND_SEGMENT: string
}

const BACKEND_SRC_REL = 'packages/plugin-wiki/src/index.ts'

const backendPath = join(findRepoRoot(fileURLToPath(import.meta.url)), BACKEND_SRC_REL)

/**
 * 后端源文件必须存在。若哪天它被改名/搬走，这里**显式失败**而不是静默跳过——
 * 否则"找不到后端"会退化成"守卫不生效"，正是我们要防的那类沉默。
 */
test('对齐守卫：后端规则源文件存在且可导入', async () => {
  assert.ok(
    existsSync(backendPath),
    `后端规则单一事实来源应存在：${backendPath}（若已迁移，请同步更新本测试的 BACKEND_SRC_REL）`,
  )
  const mod = (await import(pathToFileURL(backendPath).href)) as unknown as BackendSlugModule
  assert.equal(typeof mod.isValidSlug, 'function', '后端应导出 isValidSlug')
  assert.ok(mod.RESERVED_FIRST_SEGMENTS instanceof Set, '后端应导出 RESERVED_FIRST_SEGMENTS 集合')
})

/* --------------------------------- 语料 --------------------------------- */

/**
 * 覆盖各类边界的案例语料。`why` 只用于失败信息，方便一眼看出是哪类规则漂移。
 * **必须**覆盖：合法扁平 / 合法分层 / 空段 / 首尾斜杠 / 点段 / 保留首段 /
 * 保留第二段 / 深度边界 / 长度边界 / 非法字符 / 空串 / 非字符串。
 */
const CASES: readonly { slug: unknown; why: string }[] = [
  { slug: 'a', why: '单字符合法' },
  { slug: 'getting-started', why: '典型扁平 slug' },
  { slug: 'a.b_c-d', why: '允许 . _ -' },
  { slug: '9lives', why: '数字开头合法' },
  { slug: 'guide/intro', why: '**分层（本次漂移的核心案例）**' },
  { slug: 'guide/sub/deep', why: '多层' },
  { slug: 'Guide/Intro', why: '大写分层' },
  { slug: '.a', why: '以点开头非法' },
  { slug: '-a', why: '以连字符开头非法' },
  { slug: '_a', why: '以下划线开头非法' },
  { slug: 'a b', why: '含空格非法' },
  { slug: 'a//b', why: '连续斜杠（空段）非法' },
  { slug: '/a', why: '前导斜杠非法' },
  { slug: 'a/', why: '尾随斜杠非法' },
  { slug: '/', why: '单独斜杠非法' },
  { slug: '..', why: '点段非法' },
  { slug: 'a/..', why: '含点段非法' },
  { slug: 'a/./b', why: '含单点段非法' },
  { slug: 'search', why: '保留首段非法' },
  { slug: 'ask/x', why: '保留首段（分层）非法' },
  { slug: 'new/x', why: '保留首段（分层）非法' },
  { slug: 'list/x', why: '保留首段（分层）非法' },
  { slug: 'guide/edit', why: '保留第二段非法' },
  { slug: 'a/edit/b', why: 'edit 只在第二段被禁，第三段合法' },
  { slug: '', why: '空串非法' },
  { slug: 'a'.repeat(SLUG_MAX_LENGTH), why: '恰好上限长度合法' },
  { slug: 'a'.repeat(SLUG_MAX_LENGTH + 1), why: '超长非法' },
  { slug: 'a/'.repeat(SLUG_MAX_DEPTH - 1) + 'a', why: '恰好上限深度合法' },
  { slug: 'a/'.repeat(SLUG_MAX_DEPTH) + 'a', why: '超深非法' },
  { slug: 42, why: '非字符串非法' },
  { slug: null, why: 'null 非法' },
  { slug: undefined, why: 'undefined 非法' },
  { slug: {}, why: '对象非法' },
]

test('对齐守卫：语料本身必须覆盖各类边界（防"零案例也算通过"）', () => {
  assert.ok(CASES.length >= 30, `语料过少（${CASES.length} 条）会削弱守卫强度`)
  const accepted = CASES.filter((c) => isValidSlugMirror(c.slug))
  const rejected = CASES.filter((c) => !isValidSlugMirror(c.slug))
  assert.ok(accepted.length >= 8, '语料必须含足量**合法**案例')
  assert.ok(rejected.length >= 15, '语料必须含足量**非法**案例')
  for (const must of ['guide/intro', 'a//b', 'guide/edit', 'a/./b']) {
    assert.ok(
      CASES.some((c) => c.slug === must),
      `语料必须包含关键案例 ${must}`,
    )
  }
})

/* ------------------------------ 行为逐条比对 ------------------------------ */

test('对齐守卫：前端镜像与后端 isValidSlug 在同一语料上结论逐条一致', async () => {
  const mod = (await import(pathToFileURL(backendPath).href)) as unknown as BackendSlugModule
  const mismatches: string[] = []
  for (const { slug, why } of CASES) {
    const expected = mod.isValidSlug(slug)
    const actual = isValidSlugMirror(slug)
    if (expected !== actual) {
      mismatches.push(
        `  ${JSON.stringify(slug)}（${why}）：后端 ${expected}，前端镜像 ${actual}`,
      )
    }
  }
  assert.equal(
    mismatches.length,
    0,
    `前后端 slug 规则已漂移，共 ${mismatches.length} 条不一致：\n${mismatches.join('\n')}\n` +
      `→ 请同步 packages/web/src/lib/slugRules.ts（单一事实来源：${BACKEND_SRC_REL}）`,
  )
})

/* ------------------------------- 常量比对 ------------------------------- */

test('对齐守卫：四个常量与后端逐个相等', async () => {
  const mod = (await import(pathToFileURL(backendPath).href)) as unknown as BackendSlugModule
  assert.equal(SLUG_MAX_LENGTH, mod.SLUG_MAX_LENGTH, 'SLUG_MAX_LENGTH 漂移')
  assert.equal(SLUG_MAX_DEPTH, mod.SLUG_MAX_DEPTH, 'SLUG_MAX_DEPTH 漂移')
  assert.equal(RESERVED_SECOND_SEGMENT, mod.RESERVED_SECOND_SEGMENT, 'RESERVED_SECOND_SEGMENT 漂移')
  assert.deepEqual(
    [...RESERVED_FIRST_SEGMENTS].sort(),
    [...mod.RESERVED_FIRST_SEGMENTS].sort(),
    'RESERVED_FIRST_SEGMENTS 漂移',
  )
})
