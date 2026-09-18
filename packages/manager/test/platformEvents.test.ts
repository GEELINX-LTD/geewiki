/**
 * 平台事件契约的**结构守卫**（F7）。
 *
 * ## 它防的是什么
 * `packages/core/src/index.ts` 定义了一批 `*_EVENT` 常量。定义一个**没有发射点**的事件，
 * 是本仓库已经记过档的那条教训——"**谎报的 token**"：
 * 订阅者会照它写代码、类型检查会通过、单测会通过（订阅逻辑本身是对的），
 * 而线上**永远不会触发**。作者以为功能已经接上，用户看到的是"什么都没有发生"，
 * 且没有任何日志能把这两件事区分开。
 *
 * 所以这条守卫不看"订阅者写得对不对"，只看一件更基本的事：
 * **每个声明出来的事件，在仓库里都至少有一个地方真的发它**。
 *
 * ## 反向也要管
 * 反过来，如果有人直接写 `ctx.emit('geewiki/xxx')` 字符串字面量而不到 core 里定义契约，
 * 订阅者就无从知道它的负载形状。故同时断言：发射点的第一个实参必须是**常量名**
 * （不是字符串字面量）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function findRepoRoot(start: string): string {
  let cur = start
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(cur, 'pnpm-workspace.yaml'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  throw new Error(`未能从 ${start} 向上找到仓库根`)
}

const repoRoot = findRepoRoot(here)

/** 递归收集 `packages/<name>/src` 下的全部 .ts/.tsx 文件 */
function sourceFiles(): string[] {
  const out: string[] = []
  const packagesDir = join(repoRoot, 'packages')
  for (const name of readdirSync(packagesDir)) {
    const src = join(packagesDir, name, 'src')
    if (!existsSync(src) || !statSync(src).isDirectory()) continue
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry)) out.push(full)
      }
    }
    walk(src)
  }
  return out
}

const CORE_FILE = join(repoRoot, 'packages/core/src/index.ts')

/** 从 core 里解析出「常量名 → 事件字符串」 */
function declaredEvents(): { name: string; value: string }[] {
  const src = readFileSync(CORE_FILE, 'utf8')
  const re = /export const ([A-Z][A-Z0-9_]*_EVENT)\s*=\s*'([^']+)'/g
  const out: { name: string; value: string }[] = []
  for (const m of src.matchAll(re)) out.push({ name: m[1] as string, value: m[2] as string })
  assert.ok(
    out.length > 0,
    '未能从 core 解析出任何 *_EVENT 常量（正则失效即红，不允许静默通过）',
  )
  return out
}

test('平台事件：命名一律带 `geewiki/` 前缀（cordis 总线是全局的，必须命名空间化）', () => {
  for (const { name, value } of declaredEvents()) {
    assert.match(
      value,
      /^geewiki\//,
      `${name} = ${JSON.stringify(value)} 缺少 geewiki/ 前缀：第三方插件可能挂在同一个 Context 上`,
    )
  }
})

test('平台事件：**每个声明出来的事件都至少有一个发射点**（防"谎报的 token"）', () => {
  const files = sourceFiles()
  const contents = files.map((file) => readFileSync(file, 'utf8'))
  const all = contents.join('\n')

  const orphan: string[] = []
  for (const { name } of declaredEvents()) {
    // 发射形态：ctx.emit(EVENT, …) 或 ctx.parallel(EVENT, …)（缓存清理用的是后者）
    const emitted = new RegExp(`ctx\\.(emit|parallel)\\(\\s*${name}\\b`).test(all)
    if (!emitted) orphan.push(name)
  }
  assert.deepEqual(
    orphan,
    [],
    `以下事件在 core 里声明了契约、却**没有任何地方发射**：${orphan.join(', ')}\n` +
      '定义一个没有发射点的事件正是本仓库记过档的"谎报的 token"：订阅者会照它写代码、' +
      '测试会通过、线上永远不触发。要么补上发射点，要么把它从契约里删掉。',
  )
})

test('平台事件：发射点必须用**常量名**，不得写字符串字面量（订阅者无从得知负载形状）', () => {
  const files = sourceFiles().filter((f) => !f.endsWith('core/src/index.ts'))
  const offenders: string[] = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    // ctx.emit('geewiki/...') —— 直接写字符串，绕过契约
    if (/ctx\.(emit|parallel)\(\s*'geewiki\//.test(src)) {
      offenders.push(file.replace(`${repoRoot}/`, ''))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件直接以字符串字面量发射平台事件（应改用 core 导出的常量）：${offenders.join(', ')}`,
  )
})

test('平台事件：负载不含正文/凭据类字段（事件是广播，订阅者可能本不该看到）', () => {
  /*
   * 这是一条**启发式**守卫，不是证明：core 里事件负载接口的字段名不得出现这些字样。
   * 它拦不住"换个名字照样泄漏"，但能拦住最容易犯的那一类（顺手把 content/token 传出去）。
   */
  const src = readFileSync(CORE_FILE, 'utf8')
  const forbidden = ['content', 'token', 'password', 'secret', 'cookie', 'rawToken']
  for (const _event of declaredEvents()) {
    // 找到该事件负载接口（以事件名派生的 Interface 命名，如 UserLoginEvent）
    const ifaceMatch = new RegExp(`export interface (\\w*Event) \\{([\\s\\S]*?)\\n\\}`).exec(src)
    assert.ok(ifaceMatch, '未能解析出示例事件接口（结构变化即红）')
  }
  // 逐个事件接口检查字段名
  for (const m of src.matchAll(/export interface (\w*Event) \{([\s\S]*?)\n\}/g)) {
    const [, ifaceName, body] = m as unknown as [string, string, string]
    for (const bad of forbidden) {
      assert.ok(
        !new RegExp(`readonly \\w*${bad}\\w*\\s*[?:]`, 'i').test(body),
        `${ifaceName} 的负载字段含 "${bad}" 字样：事件是**广播**，正文/凭据不得进负载。\n` +
          '需要正文的订阅者应拿 slug 经 wiki-service **带主体**去读（读路径只有一条，权限判定只在一处）。',
      )
    }
  }
})
