/**
 * 响应压缩中间件契约测试：node:test + 真实 HTTP server。
 * 运行：pnpm --filter @geewiki/server test（根 pnpm test 一并执行）
 *
 * 为什么用裸 `node:http` 而不是 `fetch`：undici 的 `fetch` **会自动解压** gzip/brotli
 * 并隐去 `content-encoding`，用它就永远看不到"线上到底发了什么"。压缩中间件的全部
 * 契约恰恰在那些被 fetch 抹掉的字节里（编码头、真实 content-length、Vary），
 * 故这里一律用 `http.request` 取原始响应体。
 *
 * 覆盖：
 * 1. 纯函数 `pickEncoding`：q 值偏好、q=0 拒绝、通配符、非法 q；
 * 2. 纯函数 `isCompressibleType`：白名单命中与 SSE/已压缩类型排除；
 * 3. 端到端：可压缩大响应确实被压、可解回原文、Vary 补齐、content-length 改为压缩后长度；
 * 4. 阈值：小响应不压（避免压完更大）；
 * 5. SSE：**不被压缩且首帧在 end 之前到达**（这是本中间件最大的风险面 —— 缓冲会吞掉事件）；
 * 6. HEAD / 304 / 不可压缩类型 / 已带 content-encoding 的旁路；
 * 7. `enabled: false` 与阈值覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import {
  COMPRESSION_THRESHOLD,
  installCompression,
  isCompressibleType,
  pickEncoding,
} from '../src/compression.js'
import { freePort } from './helpers.js'

/* ------------------------------ 纯函数 ------------------------------ */

test('pickEncoding：尊重客户端 q 值偏好，同 q 时才偏好 brotli', () => {
  assert.equal(pickEncoding(undefined), null)
  assert.equal(pickEncoding(''), null)
  assert.equal(pickEncoding('gzip'), 'gzip')
  assert.equal(pickEncoding('br'), 'br')
  // 同 q（都缺省为 1）⇒ 本中间件偏好 brotli
  assert.equal(pickEncoding('gzip, br'), 'br')
  assert.equal(pickEncoding('gzip, deflate, br'), 'br')
  // 客户端明确把 gzip 排在前面 ⇒ 听客户端的
  assert.equal(pickEncoding('gzip;q=0.8, br;q=0.5'), 'gzip')
  assert.equal(pickEncoding('br;q=0.5, gzip;q=0.8'), 'gzip')
  // 大小写与空白不敏感
  assert.equal(pickEncoding('  GZIP ; q=1 '), 'gzip')
})

test('pickEncoding：q=0 是明确拒绝，不得发出该编码', () => {
  assert.equal(pickEncoding('gzip;q=0'), null)
  assert.equal(pickEncoding('gzip;q=0, br;q=0'), null)
  // br 被拒但 gzip 可用 ⇒ 退到 gzip，而不是发 br
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip')
  // 通配符拒绝一切
  assert.equal(pickEncoding('*;q=0'), null)
  // 通配符接受 ⇒ 用本中间件偏好
  assert.equal(pickEncoding('*'), 'br')
})

test('pickEncoding：无法识别的编码与非法 q 值都不算"可接受"', () => {
  assert.equal(pickEncoding('deflate'), null)
  assert.equal(pickEncoding('identity'), null)
  // 非法 q 值按 0 处理（保守：不发客户端可能解不开的编码）
  assert.equal(pickEncoding('gzip;q=abc'), null)
  assert.equal(pickEncoding('gzip;q='), null)
})

test('isCompressibleType：文本类可压，SSE 与已压缩格式排除', () => {
  assert.equal(isCompressibleType('application/json'), true)
  assert.equal(isCompressibleType('application/json; charset=utf-8'), true)
  assert.equal(isCompressibleType('text/html; charset=utf-8'), true)
  assert.equal(isCompressibleType('text/css'), true)
  assert.equal(isCompressibleType('text/javascript'), true)
  assert.equal(isCompressibleType('application/javascript'), true)
  assert.equal(isCompressibleType('image/svg+xml'), true)
  assert.equal(isCompressibleType('APPLICATION/JSON'), true)
  // SSE 以 text/ 开头但必须排除 —— 缓冲会破坏流式语义
  assert.equal(isCompressibleType('text/event-stream; charset=utf-8'), false)
  assert.equal(isCompressibleType('text/event-stream'), false)
  // 已压缩 / 二进制：再压只会更大更慢
  assert.equal(isCompressibleType('image/png'), false)
  assert.equal(isCompressibleType('image/jpeg'), false)
  assert.equal(isCompressibleType('image/webp'), false)
  assert.equal(isCompressibleType('font/woff2'), false)
  assert.equal(isCompressibleType('application/zip'), false)
  assert.equal(isCompressibleType('application/pdf'), false)
  assert.equal(isCompressibleType('video/mp4'), false)
  // 无从判断就不动它
  assert.equal(isCompressibleType(undefined), false)
  assert.equal(isCompressibleType(''), false)
  assert.equal(isCompressibleType('application/octet-stream'), false)
})

/* ------------------------------ 端到端夹具 ------------------------------ */

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** 取原始字节：不用 fetch（它会自动解压，掩盖真实线上行为） */
function rawRequest(
  base: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const url = new URL(base)
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: '/',
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

async function withServer(
  handler: Handler,
  run: (base: string) => Promise<void>,
  options: { enabled?: boolean; threshold?: number } = {},
): Promise<void> {
  const port = await freePort()
  const server = createServer((req, res) => {
    installCompression(req, res, options)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** 一段足够大且高度可压的 JSON（远在阈值之上） */
const BIG_PAYLOAD = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({ i, text: '重复内容重复内容重复内容' })),
})

const headerOf = (res: RawResponse, name: string): string | undefined => {
  const value = res.headers[name]
  return Array.isArray(value) ? value.join(', ') : value
}

/* ------------------------------ 端到端 ------------------------------ */

test('可压缩的大响应：gzip 压缩、可解回原文、Vary 补齐、content-length 为压缩后长度', async () => {
  const raw = Buffer.byteLength(BIG_PAYLOAD)
  assert.ok(raw > COMPRESSION_THRESHOLD, '夹具必须大于阈值，否则本用例证明不了压缩发生')

  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(BIG_PAYLOAD)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), 'gzip')
      assert.match(headerOf(res, 'vary') ?? '', /accept-encoding/i)
      // content-length 必须是压缩后的长度，否则客户端会截断/挂起
      assert.equal(Number(headerOf(res, 'content-length')), res.body.length)
      assert.ok(res.body.length < raw, `压缩后(${res.body.length})应小于原文(${raw})`)
      assert.equal(gunzipSync(res.body).toString('utf8'), BIG_PAYLOAD)
    },
  )
})

test('客户端同时接受 br 与 gzip 时发 brotli（同 q 下压缩率更好）', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(BIG_PAYLOAD)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip, br' } })
      assert.equal(headerOf(res, 'content-encoding'), 'br')
      assert.equal(brotliDecompressSync(res.body).toString('utf8'), BIG_PAYLOAD)
    },
  )
})

test('客户端不接受任何压缩时不加编码头，且 Vary 仍补齐（缓存须按 Accept-Encoding 分桶）', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(BIG_PAYLOAD)
    },
    async (base) => {
      const res = await rawRequest(base)
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.match(headerOf(res, 'vary') ?? '', /accept-encoding/i)
      assert.equal(res.body.toString('utf8'), BIG_PAYLOAD)
    },
  )
})

test('阈值以下的小响应不压缩（压完反而更大）', async () => {
  const small = JSON.stringify({ ok: true })
  assert.ok(Buffer.byteLength(small) < COMPRESSION_THRESHOLD)

  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(small)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.equal(res.body.toString('utf8'), small)
    },
  )
})

test('静态路径那种"已知 content-length 且小于阈值"的响应当拍旁路，体积原样', async () => {
  const body = Buffer.from('body{}', 'utf8')
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/css', 'content-length': body.length })
      res.end(body)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.equal(Number(headerOf(res, 'content-length')), body.length)
      assert.deepEqual(res.body, body)
    },
  )
})

test('大静态产物（带 content-length）确实被压缩，且 length 改写为压缩后值', async () => {
  const body = Buffer.from('a{color:red}\n'.repeat(500), 'utf8')
  assert.ok(body.length > COMPRESSION_THRESHOLD)

  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/css', 'content-length': body.length })
      res.end(body)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), 'gzip')
      assert.equal(Number(headerOf(res, 'content-length')), res.body.length)
      assert.ok(res.body.length < body.length)
      assert.deepEqual(gunzipSync(res.body), body)
    },
  )
})

test('SSE 不被压缩，且首帧在 end 之前就到达客户端（缓冲没有吞掉事件）', async () => {
  let releaseSecond: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })

  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.flushHeaders?.()
      res.write('data: first\n\n')
      void gate.then(() => {
        res.write('data: second\n\n')
        res.end()
      })
    },
    async (base) => {
      const url = new URL(base)
      const seen = await new Promise<{ headers: Record<string, string | string[] | undefined>; text: string }>(
        (resolve, reject) => {
          // 若中间件把 SSE 缓冲了，首帧永远不来 ⇒ 这里必须自己兜底超时，否则用例会挂死
          const guard = setTimeout(() => reject(new Error('SSE 首帧未在 3s 内到达：疑似被缓冲')), 3000)
          const req = request(
            { hostname: url.hostname, port: url.port, path: '/', method: 'GET' },
            (res) => {
              let text = ''
              res.setEncoding('utf8')
              res.on('data', (chunk: string) => {
                text += chunk
                // 首帧一到就放行第二帧：证明此刻响应**尚未结束**
                if (text.includes('first')) releaseSecond()
              })
              res.on('end', () => {
                clearTimeout(guard)
                resolve({ headers: res.headers, text })
              })
            },
          )
          req.on('error', (err) => {
            clearTimeout(guard)
            reject(err)
          })
          req.end()
        },
      )
      assert.equal(seen.headers['content-encoding'], undefined, 'SSE 不得被压缩')
      assert.match(String(seen.headers['content-type'] ?? ''), /text\/event-stream/)
      assert.ok(seen.text.includes('first'), '首帧必须到达')
      assert.ok(seen.text.includes('second'), '次帧必须到达')
    },
  )
})

test('HEAD 请求不压缩（无响应体），但 Vary 仍补齐', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': BIG_PAYLOAD.length })
      res.end()
    },
    async (base) => {
      const res = await rawRequest(base, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.match(headerOf(res, 'vary') ?? '', /accept-encoding/i)
      assert.equal(res.body.length, 0)
    },
  )
})

test('304 无响应体：不带 content-length，也不压缩', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(304, { etag: 'W/"x"', 'cache-control': 'no-cache' })
      res.end()
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(res.status, 304)
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.equal(headerOf(res, 'content-length'), undefined)
      assert.equal(res.body.length, 0)
    },
  )
})

test('不可压缩类型（图片）原样发出，即使体积很大', async () => {
  const body = Buffer.alloc(4096, 7)
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length })
      res.end(body)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.deepEqual(res.body, body)
    },
  )
})

test('已带 content-encoding 的响应不压第二次', async () => {
  const body = Buffer.from('already-encoded-payload'.repeat(100), 'utf8')
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(body)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), 'gzip')
      assert.deepEqual(res.body, body)
    },
  )
})

test('分多次 write 的响应也能正确压缩（攒齐后一次压）', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"items":[')
      res.write(BIG_PAYLOAD)
      res.end(']}')
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), 'gzip')
      assert.equal(gunzipSync(res.body).toString('utf8'), `{"items":[${BIG_PAYLOAD}]}`)
    },
  )
})

test('未调 writeHead 直接 end 的响应仍是合法 HTTP，且照样被压缩', async () => {
  /*
   * 这条路径曾经真的坏过：Node 的 `end()` 会在内部调 `_implicitHeader()` →
   * `this.writeHead(this.statusCode)`，若补丁在那一拍不转发，`_header` 永远不被设置，
   * 客户端收到连状态行都没有的响应（实测报 "Expected HTTP/"）。故这里既断言
   * 压缩生效，也断言响应本身仍然可解析。
   */
  await withServer(
    (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(BIG_PAYLOAD)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(res.status, 200)
      assert.equal(headerOf(res, 'content-encoding'), 'gzip')
      assert.equal(gunzipSync(res.body).toString('utf8'), BIG_PAYLOAD)
    },
  )
})

test('enabled: false 时完全不压缩', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(BIG_PAYLOAD)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.equal(res.body.toString('utf8'), BIG_PAYLOAD)
    },
    { enabled: false },
  )
})

test('阈值可覆盖：调高后原本会压的响应不再压', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(BIG_PAYLOAD)
    },
    async (base) => {
      const res = await rawRequest(base, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(headerOf(res, 'content-encoding'), undefined)
      assert.equal(res.body.toString('utf8'), BIG_PAYLOAD)
    },
    { threshold: Number.MAX_SAFE_INTEGER },
  )
})
