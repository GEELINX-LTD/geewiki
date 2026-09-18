/**
 * **写一次、不可回读**的配置字段（schema `meta.role === 'secret'`）的落盘存储。
 *
 * 为什么需要这个文件（而不是把密钥写进 `plugins.base.json` / `plugins.session.json`）：
 * `plugins.base.json` 是**入库文件**，密钥写进去等于提交进 git 历史；
 * 而"只接受环境变量名"的旧方案把"填一个 API key"变成了
 * "先去 shell 里 export、再重启进程"，正是本次要消掉的复杂度。
 *
 * 于是取第三条路：密钥由管理器**单独**落盘到本文件，并且：
 * 1. **不进版本库**：文件名在 `.gitignore` 里（`config/secrets.json`），与运行期数据同级；
 * 2. **不进配置**：任何写入 `plugins.*.json` 的路径都先剥掉这些字段（见 `Manager.absorbSecrets`）；
 * 3. **不回显**：任何 HTTP 响应都不带值，只带"是否已配置"（`secrets: { apiKey: true }`）；
 * 4. **文件权限 0600**：只有运行本进程的用户可读（同机其它用户读不到）。
 *
 * 明确的边界（如实记录，不做过度承诺）：它是**明文**文件，威胁模型与同目录下的
 * SQLite 数据库一致 —— 能读到宿主机文件系统的人就能读到密钥。要更强的姿态，
 * 请改用 `apiKeyEnv` 走编排平台的 secret 注入（那条路径依然完整保留）。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 密钥字段在 schema 里的标记（`Schema.string().role('secret')`） */
export const SECRET_ROLE = 'secret'

/** 密钥文件权限：仅属主可读写 */
export const SECRETS_FILE_MODE = 0o600

/** 密钥存储：插件名 → 字段名 → 值 */
export type SecretStore = Record<string, Record<string, string>>

/**
 * 读取密钥文件。
 *
 * - 文件不存在 → 空存储（**正常状态**：还没配过任何密钥）；
 * - 文件损坏 → **抛错**，不静默当空。静默会让"密钥其实还在、只是读不出来"表现为
 *   "插件突然不可用"，且没有任何线索；抛错则在激活/写配置时就暴露出来，并指明文件路径。
 */
export function readSecretFile(file: string): SecretStore {
  if (!existsSync(file)) return {}
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`密钥文件读取失败 ${file}: ${(err as Error).message}`, { cause: err })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `密钥文件不是合法 JSON（${file}）：${(err as Error).message}。` +
        '该文件由管理器写入，正常不会被手工编辑；如确认内容已损坏，可删除它并重新填写密钥。',
      { cause: err },
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`密钥文件结构非法（${file}）：顶层必须是"插件名 → 字段 → 值"的对象`)
  }
  const out: SecretStore = {}
  for (const [plugin, fields] of Object.entries(parsed as Record<string, unknown>)) {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error(`密钥文件结构非法（${file}）：插件 ${plugin} 的值必须是对象`)
    }
    const entry: Record<string, string> = {}
    for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`密钥文件结构非法（${file}）：${plugin}.${field} 必须是字符串`)
      }
      entry[field] = value
    }
    out[plugin] = entry
  }
  return out
}

/**
 * 原子写入密钥文件（先写 `.tmp` 再 rename，同 `writeList` 的取舍与临时名规则）。
 *
 * 存储为空时**删除文件**而不是留一个 `{}`：空文件会让人误以为"密钥还在里面"。
 * 权限用 `mode` 创建 + 落位后再 `chmod` 一次（rename 保留临时文件的模式，
 * 但目标已存在时某些文件系统会保留旧 inode 的权限）。
 */
export function writeSecretFile(file: string, store: SecretStore): void {
  const plugins = Object.keys(store).filter((p) => Object.keys(store[p] ?? {}).length > 0)
  if (plugins.length === 0) {
    try {
      unlinkSync(file)
    } catch {
      // 删除失败（不存在/权限）不得让一次"清空密钥"的配置保存失败
    }
    return
  }
  const kept: SecretStore = {}
  for (const plugin of plugins) kept[plugin] = store[plugin] as Record<string, string>

  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let ownsTmp = false
  try {
    writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: SECRETS_FILE_MODE })
    ownsTmp = true
    renameSync(tmp, file)
    ownsTmp = false
    try {
      chmodSync(file, SECRETS_FILE_MODE)
    } catch {
      // 某些平台/文件系统不支持 chmod（如 Windows 挂载）：权限收紧失败不应让保存失败
    }
  } catch (err) {
    if (ownsTmp) {
      try {
        unlinkSync(tmp)
      } catch {
        // 清理失败不得掩盖原始错误
      }
    }
    throw new Error(`密钥文件写入失败 ${file}: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * 在存储上设置/清除一个密钥（**纯函数**，不碰磁盘）。
 *
 * @param value 非空字符串 = 设置（两侧空白裁掉：粘贴密钥时常带换行）；`null` = 清除
 * @returns 是否发生变化（无变化时调用方不必落盘，避免每次保存配置都重写文件）
 */
export function setSecret(store: SecretStore, plugin: string, field: string, value: string | null): boolean {
  const current = store[plugin]?.[field]
  if (value === null) {
    if (current === undefined) return false
    const next = { ...store[plugin] }
    delete next[field]
    if (Object.keys(next).length === 0) delete store[plugin]
    else store[plugin] = next
    return true
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === current) return false
  store[plugin] = { ...store[plugin], [field]: trimmed }
  return true
}
