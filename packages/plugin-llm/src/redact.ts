/**
 * 密钥形态识别与脱敏。
 *
 * ⚠️ **本模块的 {@link detectSuspiciousCredential} 只用于脱敏相关判断，不再用于配置校验。**
 * 它是一条**黑名单启发式**，而黑名单永远补不全：`a1b2c3d4e5f60718293a4b5c6d7e8f90`（32 位 hex，
 * 不满足"≥40 字符"）、`ABCDEF1234567890ABCDEF1234567890`（全大写 32 位，被下面的
 * `UPPER_SNAKE_NAME` **主动豁免**）、`Xk9mQ2pL7vR4tN8w`（16 字符混合）都会漏判。
 * 而"漏判"在配置校验语境下的后果是**静默失败**：配置 200 落盘进本机的
 * `config/plugins.base.json`，系统只是降级成"没有 LLM"，用户看不出自己填错了。
 *
 * 因此 `apiKeyEnv` 的校验已改为**白名单**（见 `credentials.ts` 的 {@link isEnvVarName}：
 * 只接受惯例形态的环境变量名），密钥值天然不可能通过。
 *
 * 当前使用路径：
 * 1. {@link redact}：把日志/错误文本里的密钥片段替换为 `***`（本插件的主要用途）；
 * 2. {@link detectSuspiciousCredential}：仍保留给"判断某个字符串像不像密钥"的**辅助**
 *    场景（例如 `@geewiki/openai` 目前仍用它做自己的配置校验——该处**尚未**收敛到白名单，
 *    属已知遗留，见 plugin-llm 的批次记录）。
 *
 * 在**脱敏**语境下"保守优先"是对的：误伤会把正常日志改成噪声，而漏判只是少脱敏一处。
 * 这个取舍**不适用于校验**——校验里漏判等于放行密钥。
 */

/**
 * 密钥形态的正则**源**（不带锚点、不带 flags）——单一事实来源。
 * 检测用它会包一层 `^(?:…)$`（整串判定），脱敏用全局版本（在文本中查找）。
 */
export const SECRET_PATTERN_SOURCES: readonly string[] = [
  // 常见厂商前缀（OpenAI / Replicate / xAI / Groq / HuggingFace / 通用 pk-）
  '(?:sk|rk|xai|gsk|hf|pk)-[A-Za-z0-9_-]{12,}',
  // Google API key / OAuth access token / JWT（eyJ… 是 base64url 的 {"… 开头）
  '(?:AIza|ya29\\.|eyJ)[A-Za-z0-9._-]{16,}',
  // 长纯字母数字串（无分隔符）——典型的高熵密钥
  '[A-Za-z0-9]{40,}',
]

/** 脱敏长度下限：短于它的命中不替换（`sk-1` 之类会把日志读成噪声，且不可能是真密钥） */
export const MIN_REDACT_LENGTH = 16

/** 敏感头名：这些名字后面跟的一定是凭据，即便值本身"不像"密钥也要遮蔽其值 */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
]

/** 全大写 SNAKE 命名（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` …）：**一律不判可疑** */
const UPPER_SNAKE_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

/** 整串判定用的锚定正则（每个源派生一条） */
const DETECT_PATTERNS: readonly RegExp[] = SECRET_PATTERN_SOURCES.map((s) => new RegExp(`^(?:${s})$`))

/** 文本内查找用的全局正则（每个源派生一条；`g` 让 `replace` 覆盖全部命中） */
const REDACT_PATTERNS: readonly RegExp[] = SECRET_PATTERN_SOURCES.map((s) => new RegExp(s, 'g'))

/**
 * 头名 + 值：`authorization: Bearer x` / `"x-api-key":"abc"` / `api-key=abc` 都要遮蔽值。
 *
 * 三处细节都是踩过坑才写对的：
 * 1. 前置 `(?<![-\w])`：否则 `proxy-authorization` 会被从中间的 `authorization` 处切开；
 * 2. 值的三种形态分开捕获（双引号/单引号/裸值），替换时**保留原有引号**——丢掉引号会把
 *    JSON 日志改成非法 JSON，下游解析直接炸（比漏脱敏更早爆炸，但一样是缺陷）；
 * 3. 裸值允许 `Bearer`/`Basic`/`Token` 这类 scheme 前缀一并吃掉，否则只会遮住 scheme 本身
 *    而把真正的令牌留在后面。
 */
const HEADER_VALUE_PATTERN =
  /(?<![-\w])(authorization|proxy-authorization|x-api-key|api-key)\b(["']?)(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:[A-Za-z]+\s+)?[^\s,;}]+)/gi

/** 按值的引号形态替换，保留引号（见上） */
function maskHeaderValue(_m: string, name: string, quote: string, sep: string, value: string): string {
  const masked = value.startsWith('"') ? '"***"' : value.startsWith("'") ? "'***'" : '***'
  return `${name}${quote}${sep}${masked}`
}

/**
 * 判断字符串**本身**是否像密钥值（而不是像"存放密钥的环境变量名"）。
 *
 * ⚠️ **仅供脱敏相关的辅助判断使用，不要拿它做配置校验**（见文件头）：它是黑名单启发式，
 * 会漏判 32 位 hex / 全大写 32 位 / 16 字符混合这三类"语法上就是合法标识符"的密钥形态。
 * 配置校验请用 `credentials.ts` 的 {@link isEnvVarName}（白名单）。
 *
 * 保守优先（宁可漏判不可误伤）：全大写 SNAKE 命名直接放行，例如 `DEEPSEEK_API_KEY`、
 * `OPENAI_API_KEY`；URL（`http://127.0.0.1:8080/v1`）、模型名（`gpt-4o-mini`）、
 * 短串都不会命中——它们含非字母数字字符或不满足长度下限。
 */
export function detectSuspiciousCredential(value: string): boolean {
  const v = value.trim()
  if (v === '') return false
  // 环境变量名的标准形态：放行（真实密钥不会长成全大写 SNAKE）
  if (UPPER_SNAKE_NAME.test(v)) return false
  return DETECT_PATTERNS.some((re) => re.test(v))
}

/**
 * 脱敏：把文本中"像密钥"的片段替换为 `***`，并遮蔽敏感头名后面的值。
 *
 * 两条规则：
 * - 命中 {@link SECRET_PATTERN_SOURCES} 且**长度 ≥ {@link MIN_REDACT_LENGTH}** 的片段；
 * - `authorization` / `x-api-key` 等**头名**后面的值（无论值本身像不像密钥）。
 *
 * 输入若不是字符串（例如上游把 Error 对象塞进 message），会先 `String()` 归一化。
 */
export function redact(input: unknown): string {
  let out = typeof input === 'string' ? input : String(input)
  out = out.replace(HEADER_VALUE_PATTERN, maskHeaderValue)
  for (const re of REDACT_PATTERNS) {
    re.lastIndex = 0 // 全局正则带 lastIndex 状态，复用前必须复位
    out = out.replace(re, (m) => (m.length >= MIN_REDACT_LENGTH ? '***' : m))
  }
  return out
}
