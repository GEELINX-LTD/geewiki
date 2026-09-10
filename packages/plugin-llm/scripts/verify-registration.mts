/**
 * 登记形态核实脚本（开发工具，**不参与 `pnpm test`**——它需要组合根的注册表，而
 * `@geewiki/server` 反向依赖本包，不宜作为本包依赖引入）。
 *
 * 用途：确认 `@geewiki/llm` 在**真实组合根注册表**（`defaultRegistry()`）里的登记形态与
 * 运行时契约成立——单测用的是手写 provider 与裸 `createLlmService`，这里用的是组合根
 * 真正导出的条目，能覆盖"import 路径写错 / manifest 形状漏字段 / 模块契约不符"这类
 * 单测看不见的问题。
 *
 * 用法：pnpm --filter @geewiki/llm exec tsx scripts/verify-registration.mts
 *
 * 注意：`scripts/` 不在本包 tsconfig 的 `include` 内（故不参与 typecheck）；组合根入口用
 * **相对本文件**的动态 import 解析，因此脚本可从任意 cwd 运行。
 */
import { Context } from 'cordis'
import { LLM_SERVICE_KEY } from '../src/index.js'
import type { LlmChunk, LlmService } from '../src/index.js'

/** 组合根源码（相对本文件定位，避免写死绝对路径） */
const SERVER_ENTRY = new URL('../../server/src/index.ts', import.meta.url).href

interface RegistryEntry {
  name: string
  manifest: { geewiki: Record<string, unknown> }
  module: { name: string; apply: unknown; Config?: unknown }
  source?: string
  migrationsDir?: string
}

const { defaultRegistry } = (await import(SERVER_ENTRY)) as {
  defaultRegistry: (webDist: string | null, defaults?: Record<string, unknown>) => RegistryEntry[]
}

const reg = defaultRegistry(null, {})
const llm = reg.find((p) => p.name === '@geewiki/llm')

console.log('注册表条目数:', reg.length)
console.log('注册表全部名字:', reg.map((p) => p.name).join(', '))
if (!llm) {
  console.log('结论: 失败（@geewiki/llm 未登记）')
  process.exit(1)
}

const meta = llm.manifest.geewiki
console.log('  provides:', String(meta['provides']))
console.log('  requires:', JSON.stringify(meta['requires']))
console.log('  conflictGroup:', JSON.stringify(meta['conflictGroup']))
console.log('  runtime:', JSON.stringify(meta['runtime']))
console.log('  configSchema 存在:', Boolean(meta['configSchema']))
console.log(
  '  module.name:',
  llm.module.name,
  '| apply 类型:',
  typeof llm.module.apply,
  '| 有 Config:',
  Boolean(llm.module.Config),
)
console.log('  source:', String(llm.source), '| migrationsDir:', String(llm.migrationsDir))

// 运行时：把注册表里的模块装进真实 Context，走一遍"无 key 降级"
const ctx = new Context()
const fork = ctx.plugin(llm.module, { maxTokens: 256, temperature: 0.3 })
await fork
const svc = ctx.get(LLM_SERVICE_KEY) as LlmService | undefined
if (!svc) {
  console.log('结论: 失败（llm-service 未提供）')
  process.exit(1)
}
console.log(
  '  listProviders:',
  JSON.stringify(svc.listProviders().map((d) => ({ route: d.route, label: d.label, available: d.available() }))),
)
console.log('  availableProviders 数量:', svc.availableProviders().length)

const chunks: LlmChunk[] = []
for await (const c of svc.stream({ messages: [{ role: 'user', content: '你好' }] })) chunks.push(c)
console.log('  无 key 时 stream() 产出:', JSON.stringify(chunks))

await fork.dispose()
console.log('  dispose 后 ctx.get:', String(ctx.get(LLM_SERVICE_KEY)))
console.log('结论: 通过')
