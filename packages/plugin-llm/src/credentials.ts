/**
 * 凭据解析：**只从环境变量取值，配置里永远只存变量名**。
 *
 * 这是本插件最重要的一条边界：`plugins.base.json` 是**入库文件**，任何写进配置的密钥
 * 都会被提交进 git 历史。因此配置字段只接受"环境变量名"，而本模块负责：
 * 1. 缺名 / 空值 → `MISSING_CREDENTIAL`（降级路径的常见分支，必须能安全走通）；
 * 2. **值形态像密钥本身**（有人把 `sk-…` 直接填进了 `apiKeyEnv`）→ `INVALID_CREDENTIAL`，
 *    而不是拿这个"密钥"去查 env。否则会静默降级成"没有 LLM"，而明文密钥已经躺在入库
 *    配置里——既没报错也没保护，是最坏的一种失败。
 */
import { detectSuspiciousCredential } from './redact.js'

/** 凭据解析结果（不抛异常：调用方多半处在"降级"语境里） */
export type CredentialResult =
  | { ok: true; value: string }
  | { ok: false; code: 'MISSING_CREDENTIAL' | 'INVALID_CREDENTIAL' }

/**
 * 按环境变量名取凭据。
 *
 * @param apiKeyEnv **环境变量名**（不是密钥值）。未提供 → 视为未配置。
 */
export function resolveCredential(apiKeyEnv?: string): CredentialResult {
  const name = apiKeyEnv?.trim()
  if (!name) return { ok: false, code: 'MISSING_CREDENTIAL' }
  // 名字本身长得像密钥：拒绝去查 env，并明确报"凭据非法"（见文件头说明）
  if (detectSuspiciousCredential(name)) return { ok: false, code: 'INVALID_CREDENTIAL' }
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return { ok: false, code: 'MISSING_CREDENTIAL' }
  return { ok: true, value }
}
