/**
 * 响应压缩中间件（gzip / brotli）。
 *
 * ## 为什么放在组合根这一层
 *
 * `packages/server/src/index.ts` 的 `createServer` 回调是**唯一**的请求入口：API 走
 * `router.dispatch`、静态产物走 `serveStatic`，两者收的是同一个 `res`。在这一层包一次
 * `res`，两类响应一起受益 —— 这正是本中间件存在的理由。
 *
 * 实测（本仓当前产物，改造前）：静态资源响应头**没有** `Content-Encoding`，
 * `index-*.js` **704 KB**、`MarkdownEditor-*.js` **547 KB** 原样发给每个冷启动用户；
 * `docs/deployment.md` 通篇没有反向代理（nginx/caddy/反代/gzip 零命中），
 * 也就是说**没有任何一层会替我们做这件事**。压缩后前者约为 1/3。
 *
 * ## 为什么可以整段缓冲（而不是流式管道）
 *
 * 全仓**只有一处**流式响应：`packages/core/src/sse.ts` 的 SSE（`text/event-stream`，
 * 逐帧 `res.write` + `flushHeaders`）。它**必须在 `writeHead` 当拍就被排除**，
 * 否则缓冲会让事件永远发不出去。除此之外所有路径都是"备好整块再 `res.end(data)`"
 * （静态是 `readFile` 全量读入，JSON 是 `JSON.stringify`），故缓冲是安全的。
 *
 * 而且**只有缓冲才知道真实体积**：体积阈值必须依据真实字节数，不能依据
 * `content-length` —— `packages/server/src/index.ts:701` 的 `json()` 根本不设它。
 * 反过来，静态路径**设了** `content-length`，于是那种情况可以在 `writeHead` 当拍
 * 就判定"小于阈值"而直接旁路，省掉一次无谓的缓冲。
 *
 * ## 零新依赖
 *
 * 用 Node 内置的 `node:zlib`。不引入 `compression` 之类的包：本中间件的全部逻辑
 * 就是"判断该不该压 + 调一次 `gzipSync`"，而边界条件（SSE、304、HEAD、
 * 已压缩类型、阈值、`no-transform`）必须逐条按本仓的实际写法来定，
 * 交给通用中间件反而要对齐它的默认行为。
 */
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

/**
 * 压缩体积下限（字节）。低于此值**不压缩**：gzip 头尾约 18 字节 + brotli 更多，
 * 对几百字节的 JSON 压缩后往往**更大**，纯粹是白费 CPU。
 *
 * 1 KiB 是保守取值：本仓绝大多数 API 响应（`{ok:true}` 之类）都在阈值以下，
 * 而真正值得压的（前端产物 704 KB / 547 KB、检索响应 21 KB）都远在其上。
 */
export const COMPRESSION_THRESHOLD = 1024

/** 本中间件支持的编码。顺序即**偏好顺序**（brotli 压缩率更好，但更耗 CPU）。 */
export type CompressionEncoding = 'br' | 'gzip'

/**
 * 可压缩的 `content-type` 前缀/形态。
 *
 * **白名单而非黑名单**：漏掉一个可压缩类型的代价是"少压了一个"（无功能影响），
 * 而误压一个已压缩类型的代价是"白烧 CPU + 体积可能变大"。故只列确定有收益的文本类。
 *
 * `text/event-stream` 虽然以 `text/` 开头，但它必须走 {@link NEVER_COMPRESS} 排除 ——
 * 它是流式的，缓冲会破坏 SSE 语义。
 */
const COMPRESSIBLE_TYPE =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|x-ndjson|wasm)|image\/svg\+xml)/

/**
 * 永不压缩的类型（优先于 {@link COMPRESSIBLE_TYPE} 判定）。
 *
 * - `text/event-stream`：SSE，逐帧写出 + `flushHeaders`，缓冲会让事件发不出去；
 * - 其余是本身已被压缩的格式，再压一次只会更大更慢。
 */
const NEVER_COMPRESS =
  /^(?:text\/event-stream|image\/(?:png|jpe?g|gif|webp|avif|x-icon)|font\/|application\/(?:zip|gzip|br|x-7z-compressed|x-rar-compressed|pdf)|video\/|audio\/)/

/** 无响应体的状态码：压缩它们没有意义（且规范禁止在 304 上带 `content-length`）。 */
function hasNoBody(statusCode: number): boolean {
  return statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200)
}

/**
 * 解析 `Accept-Encoding`，返回该客户端**实际可接受**的编码。
 *
 * 严格处理 `q=0`：RFC 9110 规定 `q=0` 表示**明确拒绝**该编码。若忽略它，
 * 客户端写 `Accept-Encoding: gzip;q=0` 时我们仍会压 gzip 发过去 —— 那是明确的协议违规。
 * `identity` 无需处理：不压即 identity。
 *
 * **偏好按客户端给的 q 值排**（RFC 9110 要求尊重客户端的偏好），q 相同时才用本中间件
 * 的偏好（brotli 压缩率更好）。故 `gzip;q=0.8, br;q=0.5` 选 gzip，
 * 而 `gzip, br`（同为默认 q=1）选 br。
 */
export function pickEncoding(header: string | undefined): CompressionEncoding | null {
  if (header === undefined || header === '') return null
  const quality = new Map<string, number>()
  for (const part of header.split(',')) {
    const segments = part.trim().split(';')
    const name = (segments[0] ?? '').trim().toLowerCase()
    if (name === '') continue
    let q = 1
    for (const param of segments.slice(1)) {
      const [rawKey, rawValue] = param.trim().split('=')
      if ((rawKey ?? '').trim().toLowerCase() !== 'q') continue
      const parsed = Number((rawValue ?? '').trim())
      // 非法 q 值按 0 处理（保守：宁可不压，也不要发出客户端可能解不开的编码）
      q = Number.isFinite(parsed) ? parsed : 0
    }
    quality.set(name, q)
  }
  /** 未显式列出的编码看通配符；都没有则视为不接受（保守） */
  const qOf = (name: CompressionEncoding): number =>
    quality.has(name) ? (quality.get(name) as number) : (quality.get('*') ?? 0)

  const candidates = (['br', 'gzip'] as const)
    .map((name, serverRank) => ({ name, q: qOf(name), serverRank }))
    .filter((candidate) => candidate.q > 0)
  if (candidates.length === 0) return null
  // q 降序；同 q 时 serverRank 升序（br 在前）
  candidates.sort((a, b) => b.q - a.q || a.serverRank - b.serverRank)
  return (candidates[0] as { name: CompressionEncoding }).name
}

/** 该 `content-type` 是否值得压缩（`undefined`/空视为不可压缩 —— 无从判断就不动它） */
export function isCompressibleType(contentType: string | undefined): boolean {
  if (contentType === undefined || contentType === '') return false
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (type === '') return false
  if (NEVER_COMPRESS.test(type)) return false
  return COMPRESSIBLE_TYPE.test(type)
}

/** 按指定编码压缩（同步）。同步是刻意的：调用点本来就持有整块 Buffer，异步只会多一层状态。 */
function compress(body: Buffer, encoding: CompressionEncoding): Buffer {
  if (encoding === 'br') {
    // 质量 5：静态产物是**不可变**的（带内容指纹、`immutable`），压缩成本每 URL 只付一次，
    // 但也不取 11 —— 那个档位的 CPU 代价与收益完全不成比例。
    return brotliCompressSync(body, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    })
  }
  return gzipSync(body, { level: 6 })
}

/** 把 `accept-encoding` 追加进 `vary`（已存在且已含该项时不重复追加） */
function withVary(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const existing = headers['vary']
  const current = Array.isArray(existing) ? existing.join(', ') : (existing ?? '')
  if (/(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(current)) return headers
  return { ...headers, vary: current === '' ? 'Accept-Encoding' : `${current}, Accept-Encoding` }
}

export interface CompressionOptions {
  /** 关掉压缩（测试或排障用）；默认开启 */
  enabled?: boolean
  /** 覆盖体积下限 */
  threshold?: number
}

/**
 * 就地为 `res` 装上压缩。**必须在 `router.dispatch` 之前调用**（两条路径共用同一个 `res`）。
 *
 * 状态机：
 * - `passthrough`：不可压缩类型 / SSE / 无体状态码 / 已知小于阈值 ⇒ **当拍**转发
 *   `writeHead`，此后 `write`/`end` 原样转发，不产生任何缓冲开销；
 * - `buffer`：可压缩 ⇒ **推迟** `writeHead`，把 `write` 的块攒起来，到 `end` 时
 *   按真实体积决定压不压，再一次性发出。
 *
 * 推迟 `writeHead` 是安全的：本仓的写法一律是"先 `setHeader`，再 `writeHead`，再 `end`"，
 * 而推迟让 `headersSent` 在 `end` 前保持 `false` —— 只会让
 * `if (!res.headersSent) res.setHeader(...)` 这类既有防御更宽松，不会更严格。
 */
export function installCompression(
  req: IncomingMessage,
  res: ServerResponse,
  options: CompressionOptions = {},
): void {
  if (options.enabled === false) return
  const threshold = options.threshold ?? COMPRESSION_THRESHOLD
  const encoding = pickEncoding(req.headers['accept-encoding'])

  const originalWriteHead = res.writeHead.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  const originalFlushHeaders = res.flushHeaders?.bind(res)

  type Mode = 'undecided' | 'passthrough' | 'buffer'
  let mode: Mode = 'undecided'
  let statusCode = 200
  let captured: OutgoingHttpHeaders = {}
  let chunks: Buffer[] = []
  let total = 0

  const toBuffer = (chunk: unknown, chunkEncoding?: BufferEncoding): Buffer =>
    Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, chunkEncoding ?? 'utf8')
        : Buffer.alloc(0)

  /** 当拍转发 `writeHead` 并转入旁路（此后零缓冲） */
  const passthroughHead = (status: number, headers: OutgoingHttpHeaders): void => {
    mode = 'passthrough'
    originalWriteHead(status, headers)
  }

  res.writeHead = function patchedWriteHead(
    this: ServerResponse,
    status: number,
    ...rest: unknown[]
  ): ServerResponse {
    /*
     * 已在旁路时无条件转发。这条分支是**必需的而非防御性的**：Node 的 `end()` 在没有
     * 显式 `writeHead` 时会调 `_implicitHeader()` → `this.writeHead(this.statusCode)`，
     * 而那一拍 `patchedEnd` 已经决定了旁路。若不转发，`_header` 就永远不被设置，
     * 客户端收到的是一个连状态行都没有的畸形响应（实测报 "Expected HTTP/"）。
     */
    if (mode === 'passthrough') {
      return (originalWriteHead as unknown as (...args: unknown[]) => ServerResponse)(status, ...rest)
    }

    statusCode = status
    // Node 的签名是 (status[, statusMessage][, headers])，逐个形态归一
    const maybeMessage = rest[0]
    const maybeHeaders = rest.length >= 2 ? rest[1] : maybeMessage
    const headerBag: OutgoingHttpHeaders =
      maybeHeaders !== null && typeof maybeHeaders === 'object'
        ? (maybeHeaders as OutgoingHttpHeaders)
        : {}
    // 与 setHeader 设过的合并：writeHead 的显式值优先（与 Node 自身语义一致）
    captured = { ...headerBag }

    const type = String(headerBag['content-type'] ?? res.getHeader('content-type') ?? '')
    // 无体状态码与不可压缩类型：响应与 Accept-Encoding 无关，连 Vary 都不必加
    if (hasNoBody(status) || !isCompressibleType(type)) {
      passthroughHead(status, headerBag)
      return this
    }

    /*
     * 从这里起响应都**与 Accept-Encoding 相关**（可能压，也可能因体积不足或 HEAD 而不压），
     * 故一律补 Vary —— 否则共享缓存会把某个客户端的变体发给另一个客户端。
     * 注意 `encoding === null`（客户端不接受任何压缩）时**也要补**：正是那种响应
     * 与压缩后的变体构成同一 URL 的两种表示。
     */
    const varied = withVary(headerBag)

    // 已带 content-encoding（例如将来有人自己压过）：不能压第二次
    if (headerBag['content-encoding'] !== undefined || res.getHeader('content-encoding') !== undefined) {
      passthroughHead(status, varied)
      return this
    }
    // 客户端不接受任何压缩
    if (encoding === null) {
      passthroughHead(status, varied)
      return this
    }
    // 静态路径会设 content-length：已知小于阈值时不必缓冲
    const declared = headerBag['content-length'] ?? res.getHeader('content-length')
    const declaredLength =
      typeof declared === 'string' ? Number(declared) : typeof declared === 'number' ? declared : NaN
    if (Number.isFinite(declaredLength) && declaredLength < threshold) {
      passthroughHead(status, varied)
      return this
    }
    /*
     * HEAD 请求不压：它没有响应体，压缩只会让 content-length 与真实 GET 不一致，
     * 而没有任何客户端依赖这个一致性。Vary 仍然补上（缓存语义仍需正确）。
     */
    if (req.method === 'HEAD') {
      passthroughHead(status, varied)
      return this
    }

    mode = 'buffer'
    return this
  } as typeof res.writeHead

  res.write = function patchedWrite(
    this: ServerResponse,
    chunk: unknown,
    chunkEncoding?: unknown,
    callback?: unknown,
  ): boolean {
    if (mode === 'passthrough') {
      return originalWrite(chunk as never, chunkEncoding as never, callback as never)
    }
    if (mode === 'buffer') {
      const buf = toBuffer(chunk, chunkEncoding as BufferEncoding | undefined)
      if (buf.length > 0) {
        chunks.push(buf)
        total += buf.length
      }
      if (typeof chunkEncoding === 'function') (chunkEncoding as () => void)()
      else if (typeof callback === 'function') (callback as () => void)()
      return true
    }
    // 未决定就走到了 write（没调 writeHead）：按不可压缩旁路，交回 Node 处理
    mode = 'passthrough'
    return originalWrite(chunk as never, chunkEncoding as never, callback as never)
  } as typeof res.write

  res.end = function patchedEnd(
    this: ServerResponse,
    chunk?: unknown,
    chunkEncoding?: unknown,
    callback?: unknown,
  ): ServerResponse {
    if (mode === 'passthrough') {
      return originalEnd(chunk as never, chunkEncoding as never, callback as never)
    }

    if (mode === 'undecided') {
      /*
       * 调用方没调 `writeHead`。Node 会在 `end()` 内部用 `_implicitHeader()` 补一个，
       * 而那一拍晚于"决定要不要缓冲"，故这里自己按隐式头判定一次：能压就显式
       * `writeHead` 再压，不能压就旁路（旁路后 `_implicitHeader` 会调到
       * patchedWriteHead 的转发分支，那条分支就是为此存在的）。
       */
      const implicit: OutgoingHttpHeaders = { ...res.getHeaders() }
      const type = String(implicit['content-type'] ?? '')
      const compressible =
        req.method !== 'HEAD' &&
        !hasNoBody(res.statusCode) &&
        implicit['content-encoding'] === undefined &&
        encoding !== null &&
        isCompressibleType(type)
      if (!compressible) {
        mode = 'passthrough'
        return originalEnd(chunk as never, chunkEncoding as never, callback as never)
      }
      mode = 'buffer'
      statusCode = res.statusCode
      captured = {}
    }

    const buf = toBuffer(chunk, chunkEncoding as BufferEncoding | undefined)
    if (buf.length > 0) {
      chunks.push(buf)
      total += buf.length
    }
    const body = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total)
    chunks = []

    // setHeader 设过的 + writeHead 传的（后者优先）
    const headers: OutgoingHttpHeaders = { ...res.getHeaders(), ...captured }

    if (encoding !== null && total >= threshold) {
      const payload = compress(body, encoding)
      delete headers['content-length']
      headers['content-encoding'] = encoding
      headers['content-length'] = payload.length
      originalWriteHead(statusCode, withVary(headers))
      return originalEnd(payload)
    }

    // 体积不足阈值：不压，但 Vary 仍要补（缓存必须按 Accept-Encoding 分桶）
    originalWriteHead(statusCode, withVary(headers))
    return originalEnd(body)
  } as typeof res.end

  /*
   * SSE 会先 writeHead（此时已因 text/event-stream 转入 passthrough），再 flushHeaders。
   * 这里仍守一道：万一将来有人在可压缩类型上调 flushHeaders，我们必须立刻放弃缓冲
   * 并把已攒的块发出去 —— 否则那些字节会永远卡在数组里。
   */
  if (originalFlushHeaders !== undefined) {
    res.flushHeaders = function patchedFlushHeaders(this: ServerResponse): void {
      if (mode === 'buffer') {
        const headers: OutgoingHttpHeaders = withVary({ ...res.getHeaders(), ...captured })
        originalWriteHead(statusCode, headers)
        if (total > 0) {
          const body = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total)
          chunks = []
          total = 0
          originalWrite(body)
        }
      }
      mode = 'passthrough'
      originalFlushHeaders()
    } as typeof res.flushHeaders
  }
}
