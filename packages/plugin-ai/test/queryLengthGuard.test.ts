/**
 * **两处 `MAX_QUERY_LENGTH` 的对齐 + 边界一致性守卫**（本文件存在的唯一理由）。
 *
 * 背景：同一个"问句长度上限"有**两份真源**——
 * `packages/plugin-search/src/index.ts`（`/api/search`）与
 * `packages/plugin-ai/src/index.ts`（`/api/ai/ask`、`/api/ai/stream`）。
 * 两边注释**互相指认**并声称"刻意保持一致"，但**没有任何机制保证**：
 *
 * - search 侧注释原文：*"与 `@geewiki/ai` 的 `MAX_QUERY_LENGTH = 500` **刻意保持一致**……
 *   这里不复用对方的常量：search 是下层（ai 依赖 search-service），下层不能反向依赖上层，
 *   故两处各自持有该数值并在注释里互相指认。"*
 * - 两处 400 错误码都是 `too_long`，注释都写"与对方保持一致口径"。
 *
 * **为什么不能靠 import 复用**：注释已给出架构理由（下层不能反向依赖上层）。故本守卫用
 * **源码级**比对（仓库既有先例：`packages/web/test/degradedReason.test.ts` 的跨包 union 守卫、
 * `breadcrumb.test.ts` 的"单一渲染点"守卫、`manager/test/slots.test.ts` 的插槽白名单守卫）。
 *
 * **漂移的两种表现，都很隐蔽**：
 *
 * 1. **上限不等**：同一句话从 `/api/search` 与 `/api/ai/ask` 进来会有**不同结果**，
 *    而两边错误码**都叫 `too_long`**——用户与排障者都无从分辨是哪一侧拒的。
 * 2. **边界不等（`>` vs `>=`）**：即使上限数值相同，只要一侧写成 `>=`，**恰好等于上限**
 *    的那条查询就会在一侧通过、另一侧被拒（off-by-one）。这类分歧比数值不等更难发现，
 *    因为它只在**一个点**上表现不同。
 *
 * **还有一条方向性安全约束**：ai 的 `q` 会被**转发进** `search.search(q, …)`。因此
 * `ai > search` 是**危险的**——长度落在两者之间的查询会先通过 ai 的护栏，再在 search 层
 * 抛 `RangeError`，而路由层对同步抛错统一转 **500**（"服务器故障"语义，与"调用方传太长"不符；
 * search 侧注释专门记录了这个陷阱）。**`ai === search` 同时满足意图与安全方向。**
 *
 * **守卫如何避免"空洞通过"**（本仓库出现过空洞断言的教训，故逐条显式防御）：
 * - 正则**必须命中**，否则立即失败（正则失效即守卫失效，绝不能退化成"没解析到就不比较"）；
 * - 解析出的值**必须是字面量正整数**——`undefined === undefined` 这类恒真比较被显式排除；
 * - 断言每侧**真的把常量用在比较里**（≥1 处），防"常量还在、护栏已被改成硬编码字面量"；
 * - 断言上限**远小于 Node 的请求行上限 16 KiB**，防护栏被抬到实际上不可达的数值（那样 GET
 *   `/api/search` 的护栏形同不存在，因为请求根本到不了 handler）。
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

const SEARCH_REL = 'packages/plugin-search/src/index.ts'
const AI_REL = 'packages/plugin-ai/src/index.ts'

/** Node 的 `--max-http-header-size` 默认值（16 KiB）；请求行计入其内 */
const NODE_MAX_HEADER_SIZE = 16 * 1024

function read(rel: string): string {
  const p = join(ROOT, rel)
  assert.ok(existsSync(p), `守卫依赖的源文件应存在：${rel}（若已迁移，请同步更新本测试的路径常量）`)
  return readFileSync(p, 'utf-8')
}

/**
 * 抽出 `export const MAX_QUERY_LENGTH = <字面量数字>`。
 *
 * 刻意只认**字面量**（不接受表达式/引用）：本守卫的全部意义就是比对两个具体数值，
 * 若某侧改成 `= OTHER_CONST` 则必须**显式失败**提醒维护者，而不是静默跳过比对。
 */
function extractMaxQueryLength(source: string, label: string): number {
  const m = /export const MAX_QUERY_LENGTH\s*=\s*([^\n]+)/.exec(source)
  assert.ok(m, `${label}：未找到 \`export const MAX_QUERY_LENGTH =\`（正则失效即守卫失效）`)
  const raw = (m[1] as string).trim()
  assert.match(
    raw,
    /^\d+$/,
    `${label}：MAX_QUERY_LENGTH 必须是**字面量非负整数**，实测为 \`${raw}\`。` +
      '若确实要改成表达式/引用其它常量，请同步改写本守卫，不要让它退化成不比较。',
  )
  const value = Number.parseInt(raw, 10)
  assert.ok(Number.isInteger(value) && value > 0, `${label}：MAX_QUERY_LENGTH 必须是正整数，实测为 ${raw}`)
  return value
}

/** 该文件里所有与 MAX_QUERY_LENGTH 的比较运算符（用于边界一致性断言） */
function comparisonOperators(source: string): string[] {
  return [...source.matchAll(/([<>]=?)\s*MAX_QUERY_LENGTH/g)].map((h) => h[1] as string)
}

const searchSource = read(SEARCH_REL)
const aiSource = read(AI_REL)

const searchLimit = extractMaxQueryLength(searchSource, SEARCH_REL)
const aiLimit = extractMaxQueryLength(aiSource, AI_REL)

test('两处 MAX_QUERY_LENGTH 数值相等（注释宣称的"刻意保持一致"必须真的成立）', () => {
  assert.equal(
    aiLimit,
    searchLimit,
    `${AI_REL} 的 MAX_QUERY_LENGTH=${aiLimit} 与 ${SEARCH_REL} 的 ${searchLimit} 不一致：` +
      '同一个问句从 /api/search 与 /api/ai/ask 进来会有不同结果，而两侧错误码都叫 too_long，无从分辨。',
  )
})

test('ai 的上限不得高于 search（方向性安全约束：ai 会把 q 转发进 search.search）', () => {
  assert.ok(
    aiLimit <= searchLimit,
    `${AI_REL} 的上限(${aiLimit}) 高于 ${SEARCH_REL} 的(${searchLimit})：` +
      '长度落在两者之间的查询会先通过 ai 护栏，再在 search 层抛 RangeError，被路由层转成 500——' +
      '那是"服务器故障"语义，与"调用方传太长"不符。',
  )
})

test('两侧都真的把常量用在比较里（防"常量还在、护栏已改成硬编码"）', () => {
  for (const [rel, source] of [
    [SEARCH_REL, searchSource],
    [AI_REL, aiSource],
  ] as const) {
    const ops = comparisonOperators(source)
    assert.ok(
      ops.length >= 1,
      `${rel}：未找到任何与 MAX_QUERY_LENGTH 的比较（上限常量成了死约——护栏可能已被改成硬编码字面量）`,
    )
  }
})

test('所有比较都是严格 `>`（否则恰好等于上限的查询会一侧通过、一侧被拒）', () => {
  for (const [rel, source] of [
    [SEARCH_REL, searchSource],
    [AI_REL, aiSource],
  ] as const) {
    for (const op of comparisonOperators(source)) {
      assert.equal(
        op,
        '>',
        `${rel}：发现 \`${op} MAX_QUERY_LENGTH\`，而两侧必须统一用严格 \`>\`。` +
          '用 `>=` 会让"恰好等于上限"的查询在一侧通过、另一侧被拒（off-by-one），' +
          '这类分歧只在单点暴露，比数值不等更难发现。',
      )
    }
  }
})

test('上限必须远小于 Node 请求行上限 16 KiB（否则 GET /api/search 的护栏不可达）', () => {
  assert.ok(
    searchLimit < NODE_MAX_HEADER_SIZE,
    `${SEARCH_REL} 的上限 ${searchLimit} 未小于 Node 的 --max-http-header-size 默认值 ${NODE_MAX_HEADER_SIZE}：` +
      'GET /api/search 把 q 放在**请求行**里，超长请求在到达 handler 之前就会被 Node 拒绝，' +
      '该护栏将形同不存在（且用户拿到的是连接层错误而非 400 too_long）。',
  )
})
