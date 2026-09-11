#!/usr/bin/env node
/**
 * 独立的最小 OIDC Provider —— **只给端到端验收用**（`test/e2e-p15.sh` 起它）。
 *
 * 为什么不用测试里的那个 MockIdp 类：`e2e-p15.sh` 要起**真实服务进程**并用 curl 走完整流程，
 * 那时 mock IdP 必须是**另一个进程**（同进程无法被测服务访问到，也没法单独关掉来测降级）。
 * 两者共用同一套协议行为（授权码 + PKCE + RS256 真签），但这里是零依赖的纯 JS。
 *
 * 环境变量（都带默认值，脚本按需覆盖）：
 *   MOCK_IDP_PORT     监听端口（默认 42911）
 *   MOCK_IDP_EMAIL    ID token 里的 email
 *   MOCK_IDP_SUB      ID token 里的 sub
 *   MOCK_IDP_ISS      覆盖 iss 声明（测 iss 不匹配）
 *   MOCK_IDP_AUD      覆盖 aud 声明（测 aud 不匹配）
 *   MOCK_IDP_ALG      覆盖签名算法（如 none / HS256，测算法白名单）
 *   MOCK_IDP_EXP_OFFSET  exp 相对当前的秒数偏移（负数测过期）
 *
 * 就绪时会往 stdout 打一行 `MOCK_IDP_READY <issuer>`，脚本据此等待。
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.MOCK_IDP_PORT ?? 42911)
const issuer = `http://127.0.0.1:${port}/`

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = publicKey.export({ format: 'jwk' })
// **kid 由公钥内容派生**：真实 IdP 轮换密钥时会换 kid，服务端据此刷新 JWKS。
// 若像本脚本初版那样复用固定 kid，服务端缓存里那把旧密钥会被一直命中，
// 于是所有签名都验不过 —— 那是**脚本不真实**，不是服务端的缺陷。
const KID = createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex').slice(0, 16)

/** code → 本次授权请求的上下文 */
const pending = new Map()
/** 最近一次 /token 收到的参数（脚本要断言 PKCE 真的生效） */
let lastTokenRequest = null

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function mintIdToken(claims) {
  const alg = process.env.MOCK_IDP_ALG ?? 'RS256'
  const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid: KID }))
  const payload = b64url(JSON.stringify(claims))
  const input = `${header}.${payload}`
  const sig =
    alg === 'none'
      ? ''
      : alg.startsWith('HS')
        ? // HS256 用的是一个"对称密钥"——这里刻意用一个可预测的值：
          // 我们要验的是**服务端拒绝 HS\***，而不是这个签名的强度
          createHash('sha256').update(input).digest('base64url')
        : cryptoSign('sha256', Buffer.from(input, 'utf8'), privateKey).toString('base64url')
  return `${input}.${sig}`
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', issuer)

  if (url.pathname === '/.well-known/openid-configuration') {
    json(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}authorize`,
      token_endpoint: `${issuer}token`,
      jwks_uri: `${issuer}jwks`,
    })
    return
  }

  if (url.pathname === '/jwks') {
    json(res, 200, { keys: [{ ...publicJwk, kid: KID, use: 'sig', alg: 'RS256' }] })
    return
  }

  // 授权端点：不发页面，直接"用户已同意"并带 code 回跳（真浏览器里那一步是人点同意）
  if (url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    const codeChallenge = url.searchParams.get('code_challenge')
    const nonce = url.searchParams.get('nonce')
    if (!redirectUri || !state || !codeChallenge) {
      json(res, 400, { error: 'invalid_request' })
      return
    }
    const code = `code-${Math.random().toString(36).slice(2)}`
    pending.set(code, { codeChallenge, nonce })
    const back = new URL(redirectUri)
    back.searchParams.set('code', code)
    back.searchParams.set('state', state)
    res.writeHead(302, { location: back.href })
    res.end()
    return
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const params = Object.fromEntries(form)
      lastTokenRequest = params
      const ctx = pending.get(params.code ?? '')
      if (!ctx) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      // **真校验 PKCE**：客户端没发 verifier 或发错 ⇒ 这里失败
      const challenge = createHash('sha256').update(params.code_verifier ?? '').digest('base64url')
      if (challenge !== ctx.codeChallenge) {
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE failed' })
        return
      }
      const now = Math.floor(Date.now() / 1000)
      const claims = {
        iss: process.env.MOCK_IDP_ISS ?? issuer,
        sub: process.env.MOCK_IDP_SUB ?? 'e2e-user-1',
        aud: process.env.MOCK_IDP_AUD ?? 'geewiki-e2e',
        exp: now + Number(process.env.MOCK_IDP_EXP_OFFSET ?? 300),
        iat: now,
        nonce: ctx.nonce,
        email: process.env.MOCK_IDP_EMAIL ?? 'sso@example.com',
        email_verified: true,
        name: 'SSO User',
      }
      json(res, 200, { id_token: mintIdToken(claims), token_type: 'Bearer' })
    })
    return
  }

  // 脚本用它检查 PKCE 是否真的送出（不属于 OIDC 协议，仅验收用途）
  if (url.pathname === '/__last-token-request') {
    json(res, 200, { params: lastTokenRequest })
    return
  }

  json(res, 404, { error: 'not_found' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`MOCK_IDP_READY ${issuer}`)
})
