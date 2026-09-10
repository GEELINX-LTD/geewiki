/**
 * 凭据解析：**只从环境变量取值，配置里永远只存变量名**。
 *
 * 这是本插件最重要的一条边界：`plugins.base.json` 是**入库文件**，任何写进配置的密钥
 * 都会被提交进 git 历史。因此配置字段只接受"环境变量名"，而本模块负责：
 * 1. 缺名 / 空值 → `MISSING_CREDENTIAL`（降级路径的常见分支，必须能安全走通）；
 * 2. **不是环境变量名的形态**（有人把 `sk-…`、32 位 hex 之类的密钥值直接填进了
 *    `apiKeyEnv`）→ `INVALID_CREDENTIAL`，而不是拿这个"密钥"去查 env。否则会静默降级成
 *    "没有 LLM"，而明文密钥已经躺在入库配置里——既没报错也没保护，是最坏的一种失败。
 *
 * **为什么是白名单而不是"像不像密钥"的黑名单**：黑名单永远补不全，而漏判的恰恰是最好
 * 认的形态——`a1b2c3d4e5f60718293a4b5c6d7e8f90`（32 位 hex）、
 * `ABCDEF1234567890ABCDEF1234567890`（全大写 32 位）、`Xk9mQ2pL7vR4tN8w`（16 字符混合）
 * 全都**语法上就是合法标识符**，纯语法规则无法区分它们与真名字。反过来，只接受
 * **惯例形态的环境变量名**（全大写 + 至少一个下划线）则让密钥值天然不可能通过：
 * 随机密钥极少长成 `OPENAI_API_KEY` 这样带下划线的全大写名字；即便真长成那样，
 * 它也仍然是一个"可用的变量名"，不会造成"填错了却毫无提示"的静默失败。
 */

/**
 * 环境变量名的**语法形态**：字母或下划线开头，后接字母/数字/下划线，长度上限 128。
 *
 * 这是"它是不是一个标识符"的下限判定；**实际接受**的形态见
 * {@link ENV_VAR_NAME_CONVENTION_RE}（惯例形态）与 {@link isEnvVarName}。
 */
export const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * 环境变量名的**惯例形态**：全大写 + 至少一个下划线（`OPENAI_API_KEY`、`_X`、`A1_B2`）。
 *
 * 要求下划线是刻意的：它是把"随机密钥"挡在门外的关键一条——无分隔符的整串随机字符
 * （32 位 hex、全大写 32 位、16 字符混合）都不含下划线，而人写的变量名几乎总带下划线
 * （仓库内所有真实取值都是这个形态：`OPENAI_API_KEY`、`GEEWIKI_TEST_PLUGIN_KEY`…）。
 * 代价是 `PATH` 这类单词式名字不被接受——对该字段而言这是可接受的收紧（见 {@link isEnvVarName}）。
 */
export const ENV_VAR_NAME_CONVENTION_RE = /^[A-Z_][A-Z0-9_]{0,127}$/

/**
 * 配置字段校验用的**单一**正则：空串（= 未配置）或惯例形态的变量名。
 *
 * 为什么必须单独写一条：schemastery 的 `.pattern()` 只接受一个正则，且**会对默认值一并
 * 校验**——写成"不接受空串"会让 `default('')` 直接抛错、插件连默认配置都无法激活。
 */
export const ENV_VAR_NAME_FIELD_RE = /^$|^(?=[A-Z0-9_]*_)[A-Z_][A-Z0-9_]{0,127}$/

/**
 * 该值是否可作为 `apiKeyEnv` 字段使用。
 *
 * - 空串/纯空白 → `true`（语义是"未配置"，是必须能安全走通的降级路径）；
 * - 其余必须是**惯例形态**的环境变量名（见 {@link ENV_VAR_NAME_CONVENTION_RE}）。
 *
 * **残留缺口（如实记录）**：一个"全大写且含下划线"的随机串仍能通过——任何纯语法规则都
 * 无法彻底区分"名字"与"恰好像名字的密钥"。真正的兜底是字段语义、表单描述，以及
 * "密钥只放环境变量、不进配置"这条运维约定；本函数的作用是把**绝大多数的误填**从
 * "静默落盘且不报错"变成"显式拒绝"。
 */
export function isEnvVarName(value: string): boolean {
  const v = value.trim()
  if (v === '') return true
  return ENV_VAR_NAME_RE.test(v) && ENV_VAR_NAME_CONVENTION_RE.test(v) && v.includes('_')
}

/** 凭据解析结果（不抛异常：调用方多半处在"降级"语境里） */
export type CredentialResult =
  | { ok: true; value: string }
  | { ok: false; code: 'MISSING_CREDENTIAL' | 'INVALID_CREDENTIAL' }

/**
 * 按环境变量名取凭据。
 *
 * @param apiKeyEnv **环境变量名**（不是密钥值）。未提供 / 空 → 视为未配置。
 */
export function resolveCredential(apiKeyEnv?: string): CredentialResult {
  const name = apiKeyEnv?.trim()
  if (!name) return { ok: false, code: 'MISSING_CREDENTIAL' }
  // 不是变量名的形态：拒绝去查 env，并明确报"凭据非法"（见文件头说明）。
  // 注意这里**不能**退化成 MISSING_CREDENTIAL——那正是"填错了却看不出"的静默失败。
  if (!isEnvVarName(name)) return { ok: false, code: 'INVALID_CREDENTIAL' }
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return { ok: false, code: 'MISSING_CREDENTIAL' }
  return { ok: true, value }
}
