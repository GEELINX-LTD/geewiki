/**
 * 密码哈希：`scrypt`（`node:crypto`，**零新依赖**）。
 *
 * 设计依据见 docs/design/access-control.md：密码存储用 scrypt，参数与算法名**都入库**
 * （`user_credentials.algo` / `.params`），以便将来无痛升级到 argon2id —— 升级时按
 * 每条凭据自己记录的算法校验，登录成功后可就地重算为新算法。
 *
 * **禁止任何自研哈希**（含"自己拼 salt 再 sha256"这类）：scrypt 的内存硬化正是
 * 为了抵抗 GPU 暴力破解，sha256 系列没有这个性质。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

export interface ScryptParams {
  /** CPU/内存代价（必须是 2 的幂） */
  N: number
  /** 块大小 */
  r: number
  /** 并行度 */
  p: number
  /** 派生密钥长度（字节） */
  keylen: number
}

/** 默认参数：N=2^15, r=8, p=1（约 33.5 MiB 内存、单次约几十毫秒） */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1, keylen: 64 }

export const SCRYPT_ALGO = 'scrypt'

/**
 * scrypt 的 `maxmem` 必须**显式给足**。
 *
 * Node 的默认上限是 32 MiB，而 N=2^15、r=8 需要 `128 * N * r` ≈ 33.5 MiB ——
 * 不显式放宽会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`（且错误信息不提"内存不足"，
 * 只报参数非法，极易误判成参数写错）。
 */
function maxmemFor(params: ScryptParams): number {
  return Math.max(64 * 1024 * 1024, 256 * params.N * params.r)
}

/** 入库形态的凭据（与 `user_credentials` 表逐列对应） */
export interface StoredCredential {
  algo: string
  /** JSON 序列化的 {@link ScryptParams} */
  params: string
  /** hex */
  salt: string
  /** hex */
  hash: string
}

/**
 * 密码规范化：先做 Unicode NFKC。
 *
 * 理由：同一个"看起来一样"的密码在不同输入法/平台下可能产生不同的码点序列
 * （如全角与半角、组合字符与预组合字符）。规范化让"用户以为一样"就等于"哈希一样"，
 * 避免出现"明明输对了却登不上"的不可解释故障。
 */
function normalize(password: string): string {
  return password.normalize('NFKC')
}

/** 生成随机 salt 并派生哈希 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<StoredCredential> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(normalize(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  })
  return {
    algo: SCRYPT_ALGO,
    params: JSON.stringify(params),
    salt: salt.toString('hex'),
    hash: derived.toString('hex'),
  }
}

function parseParams(raw: string): ScryptParams | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ScryptParams>
    const { N, r, p, keylen } = parsed
    if (
      typeof N !== 'number' ||
      typeof r !== 'number' ||
      typeof p !== 'number' ||
      typeof keylen !== 'number' ||
      !Number.isInteger(N) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      !Number.isInteger(keylen) ||
      N < 2 ||
      r < 1 ||
      p < 1 ||
      keylen < 16 ||
      keylen > 256
    ) {
      return null
    }
    return { N, r, p, keylen }
  } catch {
    return null
  }
}

/**
 * 校验密码。**任何异常路径一律返回 `false`**（失败关闭）：算法未知、参数非法、
 * salt/hash 非法 hex 都不得"抛出去被上层当成成功"，也不得因为解析失败而跳过比较。
 *
 * 比较用 `timingSafeEqual`（定长），避免逐字节短路比较泄漏前缀匹配长度。
 */
export async function verifyPassword(password: string, stored: StoredCredential): Promise<boolean> {
  if (stored.algo !== SCRYPT_ALGO) return false
  const params = parseParams(stored.params)
  if (!params) return false
  const expected = Buffer.from(stored.hash, 'hex')
  const salt = Buffer.from(stored.salt, 'hex')
  if (expected.length === 0 || salt.length === 0) return false
  let derived: Buffer
  try {
    derived = await scryptAsync(normalize(password), salt, expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: maxmemFor(params),
    })
  } catch {
    return false
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * 定时补偿用的"假校验"。
 *
 * 登录失败路径上，若"账号不存在"直接返回、而"账号存在但密码错"要先算一次 scrypt，
 * 两者的响应耗时会有数量级差异 ⇒ 攻击者可据此**枚举出哪些 email 已注册**。
 * 因此在"账号不存在"时也跑一次同等代价的 scrypt，把两条路径的耗时拉平。
 */
export async function dummyVerify(password: string): Promise<void> {
  try {
    await scryptAsync(normalize(password), Buffer.alloc(16), DEFAULT_SCRYPT_PARAMS.keylen, {
      N: DEFAULT_SCRYPT_PARAMS.N,
      r: DEFAULT_SCRYPT_PARAMS.r,
      p: DEFAULT_SCRYPT_PARAMS.p,
      maxmem: maxmemFor(DEFAULT_SCRYPT_PARAMS),
    })
  } catch {
    /* 补偿失败不影响判定：本函数只为拉平耗时 */
  }
}
