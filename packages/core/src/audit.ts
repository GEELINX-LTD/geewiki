/**
 * 审计日志（`audit_log` 表）的共享写入设施 —— 见 docs/design/access-control.md §3.4。
 *
 * **为什么放在 core 而不是某个插件里**：`audit_log` 表由 **db 插件的迁移**（`0013_audit.sql`）
 * 建立、属于核心基础设施，而不是某一个业务插件的表。写入方至少有两处且分属不同包
 * （server 写 `access.break_glass`，plugin-auth 写 `login.ok` / `login.fail` / 密码变更），
 * 放任何一侧都会让另一侧产生跨包反向依赖。
 *
 * **本文件刻意不 import `./index.js`**：`index.ts` 会 re-export 本文件，若这里再反向
 * import 其类型就会形成循环依赖（ESM 能跑但初始化顺序敏感）。故只声明**结构化**的
 * 最小执行器接口 —— `DatabaseExecutor` 天然满足它。
 */

import { createHash } from 'node:crypto'

/** 写入审计所需的最小能力（`DatabaseExecutor` 结构化满足） */
export interface AuditExecutor {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>
}

/**
 * 审计条目。
 *
 * `before` / `after` **只放元数据与差异**：不得出现页面正文、密码、令牌或任何凭据值。
 * 写入前会再过一道 {@link redactForAudit} 兜底（删掉敏感键名），但那是安全网、
 * 不是许可 —— 调用方仍必须自己保证不传正文（OWASP CWE-779：日志过量且含敏感数据
 * 本身就是弱点）。
 */
export interface AuditEntry {
  /** 机器码：`acl.change` | `page.publish` | `login.ok` | `login.fail` | `access.denied` | `access.admin_override` | `access.break_glass` … */
  action: string
  /** `page` | `user` | `group` | `grant` | `session` | `org` */
  targetKind: string
  targetId: string
  /** 操作者用户 id；`null` = 系统/引导 */
  actorId?: number | null
  /** 操作者 IP 哈希（见 {@link auditIpHash}） */
  actorIpHash?: string | null
  before?: unknown
  after?: unknown
  requestId?: string | null
}

/** 兜底脱敏：这些键名一律不写进审计（大小写不敏感、逐层递归） */
const FORBIDDEN_AUDIT_KEYS = new Set([
  'content',
  'body',
  'password',
  'currentpassword',
  'newpassword',
  'token',
  'tokenhash',
  'hash',
  /*
   * `content_hash`：**正文的派生物**，与 `hash` 同类。
   *
   * 为什么必须逐个列出而不是靠 `hash` 兜住：匹配是 `key.toLowerCase()` 的**精确相等**，
   * 不含子串 —— 于是 `content_hash` / `block_hash` 这类"带前缀的哈希"会**漏过去**。
   * 实测踩过：`page.delete` 的审计 `after` 里落进了整串 sha256（注释却声称"不记 hash"）。
   *
   * 记内容指纹看着无害，实际有两个问题：① 审计表长期留存，指纹可用于比对"某份内容
   * 是否曾在库里出现过"，属内容侧信息；② 与"审计记**动作**、不记**内容派生物**"的
   * 既有纪律相悖（连 `hash` 都禁）。需要按指纹比对时应由备份/取证侧自行计算。
   */
  'content_hash',
  'salt',
  'secret',
  'apikey',
  'authorization',
  'cookie',
])

/**
 * 递归删除敏感键，返回可安全序列化的副本。
 *
 * 这是**安全网**：即便调用方不慎把整个实体传进 `before`/`after`，正文与凭据也不会落盘。
 * 它**不**替代调用方的自律 —— 审计的价值在于"记了什么"，而不在于"删得干净"。
 */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth_limit]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_AUDIT_KEYS.has(key.toLowerCase())) continue
    out[key] = redactForAudit(val, depth + 1)
  }
  return out
}

function serializeForAudit(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(redactForAudit(value))
  } catch {
    // 循环引用等序列化失败不得让审计写入整体失败：退化为标记，仍留下"发生过这件事"的记录
    return JSON.stringify({ _unserializable: true })
  }
}

/**
 * 写入一条审计记录。**失败会抛错** —— 由调用方决定是"让操作失败"还是"仅记日志"。
 * 审计与业务在同一事务里时应让它抛（审计写不进去就不该提交）；纯旁路留痕时应捕获。
 *
 * 占位符统一用 `?`：两个适配器各自负责方言转换（PG 适配器内部把 `?` 转成 `$n`），
 * 业务 SQL 因此**不出现方言分支**。
 */
export async function writeAuditLog(exec: AuditExecutor, entry: AuditEntry): Promise<void> {
  await exec.run(
    `INSERT INTO audit_log
       (at, actor_id, actor_ip_hash, action, target_kind, target_id, before_json, after_json, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      new Date().toISOString(),
      entry.actorId ?? null,
      entry.actorIpHash ?? null,
      entry.action,
      entry.targetKind,
      entry.targetId,
      serializeForAudit(entry.before),
      serializeForAudit(entry.after),
      entry.requestId ?? null,
    ],
  )
}

/**
 * IP 的审计哈希。
 *
 * **它只是"不落明文"，不是强匿名**：IPv4 空间只有 2^32，无盐 sha256 可被穷举还原。
 * 本函数的目标是让审计表与日志里**不出现可读的 IP 原文**（满足"最小化留存"的姿态），
 * 而不是宣称攻击者拿到库也还原不出 IP。若要强不可逆，需引入 per-install 密钥做 HMAC
 * —— 那属于 P4 的审计闭环（密钥管理不在 P1 范围）。
 */
export function auditIpHash(ip: string | null | undefined): string | null {
  if (!ip) return null
  return createHash('sha256').update(ip).digest('hex')
}
