/**
 * **`DegradedReason` 两侧对齐 + 可达性守卫**（本文件存在的唯一理由）。
 *
 * 背景：`DegradedReason` 有两份真源——后端 `packages/plugin-ai/src/types.ts`（权威）
 * 与前端 `packages/web/src/api.ts` 的**手抄镜像**（web 不能 import 后端包：core 顶层
 * `import 'node:fs'`，进浏览器会炸）。手抄会漂移，而漂移的两种表现都很隐蔽：
 *
 * 1. **镜像缺成员** ⇒ 后端新加一个 reason，前端 `REASON_NOTICE` 漏了它，
 *    用户看到的是回退的通用文案（有 `Record<>` 编译期保护，但仍需集合断言兜底）。
 * 2. **成员不可达（死枚举）** ⇒ 声明的 reason **永远不会被产生**。
 *    这正是本文件要防的真实缺陷：`'empty_query'` 在两侧都被声明为降级原因，
 *    但 `makeDegraded('empty_query', …)` **全仓一次都没被调用过**——它其实只是
 *    HTTP 400 错误码，被误抄进了降级枚举。死成员还会误导读者（旧注释写着
 *    "本插件自身产生的原因：…、查询为空"，而那是假的）。
 *
 * 为什么不能只靠 TypeScript：union 类型**运行时不存在**，无法 import 比较；
 * 而"某个字符串是否被产生过"是**调用点**问题，类型系统根本不表达。
 * 故本守卫用**源码级**比对（仓库既有先例：`breadcrumb.test.ts` 的"单一渲染点"守卫、
 * `areaState.test.ts` 的"禁止 `e.message` 拼接"守卫）。
 *
 * 守卫如何避免"空洞通过"：
 * - 显式断言两侧都**解析出了非空集合**（正则写坏 ⇒ 立即红，不会退化成 0===0）；
 * - 显式断言集合规模 ≥ 9（成员被删空 ⇒ 红）；
 * - 可达性断言**双向**：既要求每个成员可达，也要求 `CODE_TO_REASON` 的值集合
 *   不超出枚举（防"映射出一个未声明的 reason"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const ROOT = findRepoRoot(fileURLToPath(import.meta.url))

const BACKEND_TYPES_REL = 'packages/plugin-ai/src/types.ts'
const BACKEND_DEGRADE_REL = 'packages/plugin-ai/src/degrade.ts'
const BACKEND_INDEX_REL = 'packages/plugin-ai/src/index.ts'
const FRONTEND_API_REL = 'packages/web/src/api.ts'

function read(rel: string): string {
  const p = join(ROOT, rel)
  assert.ok(existsSync(p), `守卫依赖的源文件应存在：${rel}（若已迁移，请同步更新本测试的路径常量）`)
  return readFileSync(p, 'utf-8')
}

/**
 * 从源码文本里抽出 `type DegradedReason = | 'a' | 'b' …` 的成员集合。
 *
 * 只认**字面量成员**（`| 'x'`）。刻意不解析 TS AST：本仓库既有守卫都是文本级，
 * 保持一致；代价是要显式断言"解析结果非空且规模合理"（见上面第 1/2 条）。
 */
function extractReasonUnion(source: string, label: string): Set<string> {
  const m = /export type DegradedReason\s*=([\s\S]*?)(?:\n\n|\nexport |\n\/\*\*)/.exec(source)
  assert.ok(m, `${label}：未找到 \`export type DegradedReason =\` 声明（正则失效即守卫失效）`)
  const body = m[1] as string
  const members = new Set<string>()
  for (const hit of body.matchAll(/'([a-z_]+)'/g)) members.add(hit[1] as string)
  assert.ok(members.size > 0, `${label}：解析出的成员集合为空（正则失效即守卫失效）`)
  return members
}

const backendReasons = extractReasonUnion(read(BACKEND_TYPES_REL), BACKEND_TYPES_REL)
const frontendReasons = extractReasonUnion(read(FRONTEND_API_REL), FRONTEND_API_REL)

test('DegradedReason：两侧都解析出合理的成员规模（防空跑）', () => {
  assert.ok(
    backendReasons.size >= 9,
    `后端应有 ≥9 个降级原因，实际 ${backendReasons.size}：${[...backendReasons].join(', ')}`,
  )
  assert.equal(
    frontendReasons.size,
    backendReasons.size,
    '前端镜像与后端成员数应一致（不一致说明已漂移）',
  )
})

test('DegradedReason：前端镜像与后端成员集合逐个相等（手抄漂移守卫）', () => {
  const onlyBackend = [...backendReasons].filter((r) => !frontendReasons.has(r))
  const onlyFrontend = [...frontendReasons].filter((r) => !backendReasons.has(r))
  assert.deepEqual(
    { onlyBackend, onlyFrontend },
    { onlyBackend: [], onlyFrontend: [] },
    `两侧已漂移：仅后端有 ${JSON.stringify(onlyBackend)}，仅前端有 ${JSON.stringify(onlyFrontend)}。` +
      `改 ${BACKEND_TYPES_REL} 必须同步改 ${FRONTEND_API_REL}。`,
  )
})

test('DegradedReason：每个成员都必须可达（要么来自 CODE_TO_REASON，要么有 makeDegraded 调用点）', () => {
  const degradeSrc = read(BACKEND_DEGRADE_REL)
  const indexSrc = read(BACKEND_INDEX_REL)

  // ① CODE_TO_REASON 映射出来的值（LlmErrorCode → reason）
  const mapped = new Set<string>()
  const mapBlock = /export const CODE_TO_REASON[\s\S]*?=\s*\{([\s\S]*?)\n\}/.exec(degradeSrc)
  assert.ok(mapBlock, `${BACKEND_DEGRADE_REL}：未找到 CODE_TO_REASON 映射表（正则失效即守卫失效）`)
  for (const hit of (mapBlock[1] as string).matchAll(/:\s*'([a-z_]+)'/g)) mapped.add(hit[1] as string)
  assert.ok(mapped.size >= 8, `CODE_TO_REASON 应解析出 ≥8 个目标 reason，实际 ${mapped.size}`)

  // ② 直接调用点：makeDegraded('<reason>', …
  const called = new Set<string>()
  for (const hit of indexSrc.matchAll(/makeDegraded\(\s*'([a-z_]+)'/g)) called.add(hit[1] as string)

  const unreachable = [...backendReasons].filter((r) => !mapped.has(r) && !called.has(r))
  assert.deepEqual(
    unreachable,
    [],
    `以下降级原因**永远不会被产生**（死枚举成员）：${JSON.stringify(unreachable)}。` +
      `若它其实是 HTTP 错误码（例如 empty_query），应从 DegradedReason 里删除、只留在 h.json 的错误码里。`,
  )

  // 反向断言：映射出的 reason 不得超出枚举（防"映射出未声明的值"）
  const mappedNotDeclared = [...mapped].filter((r) => !backendReasons.has(r))
  assert.deepEqual(
    mappedNotDeclared,
    [],
    `CODE_TO_REASON 映射出了未在 DegradedReason 中声明的值：${JSON.stringify(mappedNotDeclared)}`,
  )
})

test('DegradedReason：REASON_NOTICE 覆盖全部成员（前端文案不得漏项）', () => {
  const planSrc = read('packages/web/src/lib/searchPlan.ts')
  const notice = /const REASON_NOTICE[\s\S]*?=\s*\{([\s\S]*?)\n\}/.exec(planSrc)
  assert.ok(notice, 'searchPlan.ts：未找到 REASON_NOTICE（正则失效即守卫失效）')
  const keys = new Set<string>()
  for (const hit of (notice[1] as string).matchAll(/^\s{2}([a-z_]+):\s*\{/gm)) keys.add(hit[1] as string)

  const missing = [...frontendReasons].filter((r) => !keys.has(r))
  assert.deepEqual(
    missing,
    [],
    `REASON_NOTICE 缺少以下降级原因的文案：${JSON.stringify(missing)}（用户会看到通用回退文案）`,
  )
})
