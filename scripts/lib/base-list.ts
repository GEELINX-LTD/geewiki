/**
 * 基础层清单（`plugins.base.json`）的**共享读取口径**：scripts 侧唯一一份回退逻辑。
 *
 * ## 为什么需要回退
 * 基础层清单是**运行期可写**文件：在管理台保存一次插件配置就会重写它。它一旦入库，
 * 后果有两个：① 每个人的本机设置（模型端点、开关、超时）会以"改动"的形式出现在别人的
 * `git status` 里，并随时可能被 `git add -A` 提交；② "随版本发布的默认启用清单"与
 * "我这台机器的现状"变成同一个文件，升级时无法区分该保留谁的。
 *
 * 因此 `config/plugins.base.json` 已改为**不入库的本机 live 文件**（也在 .gitignore 里），
 * 随版本发布的默认值由同目录的 `config/plugins.base.example.json` 承载。
 * 代价是：**干净检出**（CI、新克隆、Docker 构建上下文）里只有 example、没有 live，
 * 脚本若直接 `readFileSync(config/plugins.base.json)` 就会在最需要它跑起来的环境里 ENOENT。
 *
 * 故这里与 `packages/manager/src/index.ts` 的 `readBaseList` 保持同一口径：
 *   - live 文件存在 → 用 live（本机现状优先，语义不变）；
 *   - live 缺失、example 存在 → 用 example（随版本发布的默认值）；
 *   - 两者都不存在 → 抛可操作的错误，并同时点名两个绝对路径。
 *
 * 注意本模块**只负责读取**：写入永远只写 live 文件，example 是只读模板、进程永不改写它。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 基础层清单条目：脚本只关心启用集合与各自的 config */
export interface BaseListEntry {
  name: string
  config?: unknown
}

/** 基础层清单：脚本侧只用到 `enabled` */
export interface BaseList {
  enabled: BaseListEntry[]
}

/**
 * 随版本发布的默认清单文件名：`plugins.base.json` → `plugins.base.example.json`。
 *
 * 与 `packages/manager/src/index.ts` 的 `exampleManifestPathOf` 同口径（同目录、同主名、
 * 加 `.example` 后缀）——两边必须一致，否则"运行期按 example 装配"与"脚本按 example 读取"
 * 会指向不同文件。
 */
export function exampleBaseListPath(liveFile: string): string | null {
  return liveFile.endsWith('.json') ? `${liveFile.slice(0, -'.json'.length)}.example.json` : null
}

/**
 * 解析**本次要读**的清单文件（绝对路径）：live → example → 抛错。
 *
 * `configDir` 既可以是仓库的 `config/`，也可以是验收脚本复制出来的临时 `config/` 副本 ——
 * 两种场景的目录形状一致（同目录下 live + example），所以同一份逻辑都适用。
 */
export function resolveBaseListPath(configDir: string): string {
  const liveFile = resolve(configDir, 'plugins.base.json')
  if (existsSync(liveFile)) return liveFile
  const exampleFile = exampleBaseListPath(liveFile)
  if (exampleFile !== null && existsSync(exampleFile)) return exampleFile
  // 两个都没有：不能只说"缺文件"，否则在干净检出里读者不知道该补哪一个。两个绝对路径都点名。
  const exampleHint = exampleFile ?? '（无法由 live 路径派生出 .example.json）'
  throw new Error(
    `找不到基础层清单：本机 live 文件不存在（${liveFile}），随版本发布的默认值也不存在（${exampleHint}）。` +
      ' 请确认仓库 config/ 目录完整——干净检出应当带有 plugins.base.example.json。',
  )
}

/** 读清单**原文**（回退口径见 {@link resolveBaseListPath}）；需要逐字节比对时用它 */
export function readBaseListText(configDir: string): string {
  return readFileSync(resolveBaseListPath(configDir), 'utf8')
}

/** 读并解析清单（回退口径见 {@link resolveBaseListPath}） */
export function readBaseList(configDir: string): BaseList {
  return JSON.parse(readBaseListText(configDir)) as BaseList
}
