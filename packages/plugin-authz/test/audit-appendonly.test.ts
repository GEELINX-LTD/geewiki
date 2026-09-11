/**
 * 源码级守卫：审计日志与版本历史的「只增不删」。
 *
 * 覆盖设计文档 §8.2 的 P4 第 2 条与第 6 条：
 *   2. `audit_log` 无 UPDATE/DELETE 代码路径。
 *   6. 权限版本**不做清理**（D11：权限版本永久保留）。
 *
 * 两条都是**约定型不变量**：类型系统管不到，运行时也不报错 —— 删掉几行历史不会让任何
 * 断言变红。只能靠源码级扫描钉住，否则"某次重构顺手加了个清理"要等到真需要那份历史时
 * 才发现。
 *
 * ## 三个刻意的设计
 *
 * 1. **扫之前先抹掉注释**。否则解释性文字（例如本条规则的说明本身）里的
 *    `DELETE FROM audit_log` 会造成假阳性，而假阳性会逼着后来的人把守卫放宽 —— 那才是
 *    真正的损失。本仓已经有过一次"守卫正则要求带空格，于是漏掉了不带空格的写法"的教训。
 * 2. **带反空洞断言**。要求扫描确实覆盖了预期数量的文件、且确实找到了那条合法的
 *    `INSERT INTO audit_log`。否则"扫描范围写错导致 0 处违规"会和"真的干净"长得一模一样。
 * 3. **`page_versions` 的删除不是"零容忍"，而是"白名单 + 锚定"** —— 见下方 `page_versions`
 *    那条测试的说明。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

/** 递归收集源码与迁移（跳过 node_modules / dist / .wt-* worktree） */
function collect(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.wt-')) continue
    const full = join(dir, name)
    if (name.endsWith('.ts') || name.endsWith('.sql')) {
      out.push(full)
      continue
    }
    // 只下探目录：以 `.` 开头的一律跳过（.git / .tmp-* 等）
    if (name.startsWith('.')) continue
    collect(full, out)
  }
  return out
}

/**
 * 抹掉注释，只留真实代码/SQL。
 *
 * 块注释先行（`/* … *\/`），再处理行注释 `//`；`[^:]` 的前缀断言是为了不把
 * `https://…` 这类字面量里的 `//` 当成注释起点。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const FILES = [
  ...collect(join(REPO, 'packages')),
  ...collect(join(REPO, 'plugins')),
  ...collect(join(REPO, 'scripts')),
]

/** 返回命中处的 `文件:行号: 该行内容`（行号按**抹注释前后一致**的方式算：逐行处理） */
function scan(patterns: readonly RegExp[]): string[] {
  const hits: string[] = []
  for (const file of FILES) {
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n')
    const strippedLines = stripComments(raw).split('\n')
    for (let i = 0; i < strippedLines.length; i += 1) {
      const line = strippedLines[i] ?? ''
      if (patterns.some((re) => re.test(line))) {
        hits.push(`${file.slice(REPO.length + 1)}:${i + 1}: ${(lines[i] ?? '').trim()}`)
      }
    }
  }
  return hits
}

test('源码级守卫：扫描范围有效（反空洞）', () => {
  // 范围写错的守卫会"全绿"，而那比没有守卫更危险 —— 它给了一种虚假的安全感
  assert.ok(FILES.length >= 60, `扫描文件数偏少（${FILES.length}），范围可能写错了`)
  assert.ok(
    FILES.some((f) => f.endsWith('packages/core/src/audit.ts')),
    '扫描范围必须包含审计写入的唯一实现 packages/core/src/audit.ts',
  )
  assert.ok(
    FILES.some((f) => f.endsWith('packages/db-sqlite/src/migrations/0013_audit.sql')),
    '扫描范围必须包含 .sql 迁移（建表语句在那里）',
  )
})

test('源码级守卫：audit_log 只增不改不删（§8.2 P4 第 2 条）', () => {
  const hits = scan([/\bUPDATE\s+audit_log\b/i, /\bDELETE\s+FROM\s+audit_log\b/i])
  assert.deepEqual(
    hits,
    [],
    `审计日志是 append-only：不得存在改写/删除它的代码路径。发现:\n${hits.join('\n')}`,
  )
})

test('源码级守卫：audit_log 的唯一写入路径仍是 writeAuditLog（反空洞）', () => {
  const hits = scan([/\bINSERT\s+INTO\s+audit_log\b/i])
  assert.equal(
    hits.length,
    1,
    `audit_log 的 INSERT 应恰好一处（writeAuditLog 内）。实际 ${hits.length} 处:\n${hits.join('\n')}`,
  )
  assert.ok(
    hits[0]?.startsWith('packages/core/src/audit.ts:'),
    `唯一写入点应在 packages/core/src/audit.ts，实际在 ${hits[0] ?? '(无)'}`,
  )
})

test('源码级守卫：page_versions 不得被"保留策略"清理（§8.2 P4 第 6 条 / D11）', () => {
  /*
   * ⚠️ 这一条**不能**写成"零处 `DELETE FROM page_versions`"：验收标准原文是
   * "代码中无删除 `page_versions` 行的路径"，但 `deletePage` 本来就要删掉**被删页自己的**
   * 版本（那是页面的生命周期级联，与 D11 反对的"保留策略清理"是两回事）。
   * 按字面写会让守卫与既有合法代码冲突，然后被人放宽 —— 那就等于没有守卫。
   *
   * 所以判据是：**只允许一处，且必须锚定在 `deletePage` 里**。任何新增的删除点
   * （尤其是"保留最近 N 条 / 超过 N 天"这类）都会立刻红。
   */
  const hits = scan([/\bDELETE\s+FROM\s+page_versions\b/i])
  assert.ok(hits.length >= 1, '至少应有 deletePage 的级联删除；若为 0，说明扫描范围写错了')

  for (const hit of hits) {
    const rel = hit.split(':')[0] ?? ''
    const file = join(REPO, rel)
    const src = stripComments(readFileSync(file, 'utf8'))
    const lineNo = Number(hit.split(':')[1] ?? '0')
    const before = src.split('\n').slice(0, lineNo).join('\n')
    /*
     * 取"该行之前**最后一次** `const <name> = async …`"，即最近的外层**函数**定义。
     *
     * 为什么要限定 `= async`：本仓的函数一律写成 `const deletePage = async (…) => {`，
     * 而函数体内的局部常量（如 `const page = (await tx.query(…))[0]`）不带 `async`。
     * 若只匹配 `const <name> =`，就会把那个局部常量当成"所属定义" —— 本守卫的第一版
     * 正是这么写的，测试直接报 `expected 'deletePage', actual 'page'`。
     * 这个失败本身是好消息：它证明守卫**确实会检查**，而不是恒真。
     */
    const owners = [...before.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*async\b/g)]
    const owner = owners.at(-1)?.[1] ?? '(文件顶层)'
    assert.equal(
      owner,
      'deletePage',
      `page_versions 的删除只允许出现在 deletePage（页面生命周期级联）里；` +
        `这一处最近的所属定义是 \`${owner}\`，疑似"保留策略清理"（D11 明确禁止）:\n${hit}`,
    )
  }
})
