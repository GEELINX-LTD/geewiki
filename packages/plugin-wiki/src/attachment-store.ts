/**
 * 附件上传（本批 M1）：**把请求体流式落盘**的那一层。
 *
 * 三件事必须在这一层做对，缺一条都会变成"平时看不出来、出事时很难查"的缺陷：
 *
 * 1. **边收边哈希边限制字节数**。上限**不能只靠 `Content-Length`**：那个头由调用方填写，
 *    可以缺失（chunked）、也可以谎报。真正的封顶是"累计读到的字节数"，一旦超过立刻
 *    `destroy()` 源流并抛 `payload_too_large` —— 于是"一个超大上传"的代价是常数内存，
 *    而不是"先落盘 10 GB 再判断"。
 * 2. **先写临时文件、后原子 `rename`**。直接往最终路径写的话，进程在写入中途退出（或被
 *    kill）会留下一个**半截文件而路径看起来是完整的** —— 内容寻址下这尤其危险：
 *    路径就是哈希，半截文件会永久冒充那份内容。`rename` 在同一文件系统内是原子的，
 *    所以"出现在最终路径上的文件"永远是完整字节。
 * 3. **幂等去重靠内容哈希**，不靠文件名：同一份字节第二次上传时目标路径已存在 ⇒
 *    `dedup: true` 并删掉临时文件。原始文件名只用于展示，不参与路径计算。
 *
 * ⚠️ **`rename` 不会以 `EEXIST` 报错**（POSIX 语义是"静默覆盖"），所以"目标已存在"这件事
 * 只能靠**rename 之前的一次 `exists` 检查**得出；`EEXIST` 分支仍然保留，是为了兼容
 * "目标是目录"或将来换成不允许覆盖的实现。若把去重判据写成"捕获 rename 的 EEXIST"，
 * 在 Linux 上那条分支**永远不会命中** ⇒ 每次上传都会静默覆盖同一路径，`dedup` 恒为 false。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { attachmentRelPath, assertExtAllowed } from './attachments.js'

/**
 * 附件存储层的错误。`code` 即端点要回的错误码（沿用仓库"消息前缀即错误码"的约定）：
 *
 * - `payload_too_large` ⇒ 413（调用方的输入问题）
 * - `storage_unavailable` ⇒ **503**（不是 500）。这一点是刻意的：磁盘只读/写满/无权限是
 *   **运维状态**，不是本服务故障。报 500 会让每个失败请求都计入 `stats().consecutiveFailures`，
 *   连续失败达到阈值就可能触发看门狗熔断 —— 于是"磁盘满了"被升级成"整站被熔断"。
 *   503 的表达更准确：**依赖不可用，服务本身是活的**。
 */
export class AttachmentStoreError extends Error {
  constructor(
    readonly code: 'payload_too_large' | 'storage_unavailable',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'AttachmentStoreError'
  }
}

/** 磁盘/文件系统的"运维状态"类错误码：消息里据此措辞（见 {@link asStoreError}）。 */
const STORAGE_ERRNO = new Set(['EROFS', 'ENOSPC', 'EACCES', 'EPERM', 'EDQUOT'])

/** 该错误是否属于"一眼可认出的运维故障码"（只读/满/无权限）。 */
export function isStorageErrno(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && STORAGE_ERRNO.has(code)
}

/**
 * 把存储层的任意失败翻译成 {@link AttachmentStoreError}。
 *
 * ★ **默认全部按 `storage_unavailable` 处理，而不是只认一份 errno 白名单。**
 * 两个理由，第二条是实测的：
 *
 * 1. 这一层只做"我们自己数据目录下的文件 IO"，所以**任何**失败在语义上都是"存储不可用"
 *    （运维状态）——把 errno 放进消息里足够定位。若让它冒成 500，就会计入
 *    `stats().consecutiveFailures`，"磁盘挂载出问题"会被升级成"整站被看门狗熔断"。
 * 2. ★ 实测：**只读文件系统上 `mkdir(…, { recursive: true })` 返回的是 `ENOENT`，不是 `EROFS`**
 *    （Node 的递归实现先 stat、再逐级创建，最终把第一次的 ENOENT 抛出来；同一路径上
 *    `mkdirSync` 不带 recursive 才是 EROFS，`writeFile` 也是 EROFS）。
 *    也就是说，按 errno 白名单判定会把**最常见的只读挂载**误报成 500 —— 而那正是本层
 *    最想避免的形态。
 */
function asStoreError(err: unknown, context: string): Error {
  if (err instanceof AttachmentStoreError) return err
  const code = (err as NodeJS.ErrnoException | null)?.code
  const detail = typeof code === 'string' ? `（${code}${isStorageErrno(err) ? '，已知的存储故障码' : ''}）` : ''
  const reason = err instanceof Error ? err.message : String(err)
  return new AttachmentStoreError('storage_unavailable', `附件存储不可用${detail}：${context} —— ${reason}`)
}

/** 创建附件与临时目录（幂等）。激活期的探针与每次上传都走它。 */
export async function ensureAttachmentDirs(dataDir: string, tmpDir: string): Promise<void> {
  try {
    await mkdir(join(dataDir, 'attachments'), { recursive: true })
    await mkdir(tmpDir, { recursive: true })
  } catch (err) {
    throw asStoreError(err, `${dataDir}/attachments`)
  }
}

/** 目标路径是否已存在（去重的**唯一判据**，见文件头第 3 条说明）。 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique constraint|duplicate key/i.test(msg)
}

/** 导出以便端点识别"并发下另一个同内容请求刚插入"这一种冲突（见 attachments 端点）。 */
export { isUniqueViolation }

export interface StoreStreamResult {
  /** 内容哈希（hex，64 位）。**原始文件名不参与**：去重与路径都只看它。 */
  sha256: string
  /** 实际写入的字节数（来自流，不是 `Content-Length`）。 */
  byteSize: number
  /** `true` = 该内容此前已在磁盘上（本次只是删掉了临时文件，没有产生第二份）。 */
  dedup: boolean
}

/**
 * 把 `src` 流式写入内容寻址路径。
 *
 * @param src 字节来源（HTTP 场景下就是 `h.req`）。
 * @param o.dataDir 数据目录（附件落在它的 `attachments/` 子目录下）。
 * @param o.tmpDir 临时目录（**必须与最终路径同一文件系统**，否则 `rename` 会退化成跨设备拷贝）。
 * @param o.maxBytes 字节上限：累计超出即中断并抛 `payload_too_large`。
 * @param o.ext 已过白名单的扩展名（落盘路径需要它；非法值由 `attachmentRelPath` 断言拒绝）。
 */
export async function storeStream(
  src: Readable,
  o: { dataDir: string; tmpDir: string; maxBytes: number; ext: string },
): Promise<StoreStreamResult> {
  // 先断言扩展名与目录：这些是"迟早要失败"的条件，不要等到收完几个 GB 的字节才失败
  assertExtAllowed(o.ext)
  await ensureAttachmentDirs(o.dataDir, o.tmpDir)

  const tmpPath = join(o.tmpDir, `att-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}.tmp`)
  const hash = createHash('sha256')
  let byteSize = 0

  const discardTmp = async (): Promise<void> => {
    // 删除失败只告警：临时目录里留一个文件不是"上传失败"的理由（且下次启动会重建目录）
    await rm(tmpPath, { force: true }).catch((err: unknown) => {
      console.warn(`[@geewiki/wiki] 临时文件清理失败（${tmpPath}）:`, err)
    })
  }

  const ws = createWriteStream(tmpPath)
  /*
   * 写流是**异步报错**的（打不开文件、磁盘满都在下一个 tick 才以 `error` 事件出现），
   * 而背压等待只监听 `drain` ⇒ 一旦写入失败，`await` 会**永久挂住**这个请求
   * （连接不结束、在途计数不归零、排空超时）。所以先接住一次性的错误事件，
   * 再让背压等待同时监听 `drain` 与 `error`。
   */
  let writeError: Error | null = null
  ws.on('error', (err: Error) => {
    writeError = err
  })
  const drain = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const cleanup = (): void => {
        ws.off('drain', onDrain)
        ws.off('error', onError)
      }
      ws.once('drain', onDrain)
      ws.once('error', onError)
    })
  try {
    /*
     * 用 `for await` 而不是 `src.pipe(ws)`：pipe 不做背压之外的任何判断，超限时也拿不到
     * "已经收了多少"。而 `for await` 天然逐块给出字节数，且**抛错时迭代器协议会自动
     * 销毁源流**（下面的显式 `destroy()` 是第二道保险：源流是 HTTP 请求时，不销毁会让
     * 客户端继续推数据）。
     */
    for await (const chunk of src) {
      if (writeError !== null) throw writeError
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      byteSize += buf.length
      if (byteSize > o.maxBytes) {
        throw new AttachmentStoreError(
          'payload_too_large',
          `附件超过上限（${o.maxBytes} 字节）`,
        )
      }
      hash.update(buf)
      // 背压：写缓冲满了就等 drain（同时把写入错误浮出来，见上）
      if (!ws.write(buf)) await drain()
    }
    // 关闭写流并等它真正落盘（`end` 回调里才拿得到写错误）
    await new Promise<void>((resolve, reject) => {
      ws.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
    if (writeError !== null) throw writeError
  } catch (err) {
    src.destroy()
    ws.destroy()
    await discardTmp()
    throw asStoreError(err, '写入临时文件失败')
  }

  const sha256 = hash.digest('hex')
  const rel = attachmentRelPath(sha256, o.ext)
  const finalPath = join(o.dataDir, 'attachments', rel)
  try {
    await mkdir(dirname(finalPath), { recursive: true })
    if (await exists(finalPath)) {
      // ★ 去重：同内容已有落盘文件 ⇒ 删掉刚写的临时文件，磁盘上只有一份
      await discardTmp()
      return { sha256, byteSize, dedup: true }
    }
    try {
      await rename(tmpPath, finalPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        await discardTmp()
        return { sha256, byteSize, dedup: true }
      }
      throw err
    }
  } catch (err) {
    await discardTmp()
    throw asStoreError(err, `落到 ${rel} 失败`)
  }
  return { sha256, byteSize, dedup: false }
}
