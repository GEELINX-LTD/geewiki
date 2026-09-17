/**
 * 错误 → 人话（纯函数，便于单测）。
 *
 * 为什么要这一层：界面上直接出现 `ApiError.message`（后端中文文案）在多数情况下是可读的，
 * 但**不能假设它总是可读**——它可能带 API 路径（`not_found: /api/pages/x`）、可能带英文
 * （`Failed to fetch`）、也可能被将来某个分支塞进原始错误串。界面是最后一道关口，因此这里
 * 做两件事：
 *
 * 1. **按类别给出稳定的人话标题**（连不上服务 / 不存在 / 服务出错 / 其它），标题**永远不含**
 *    变量部分，便于用户形成稳定预期；
 * 2. 把原始文案作为 `hint` 时做**清洗**：去掉 API 路径、去掉英文堆栈形态、截断过长文本。
 *
 * `code` 与 `status` 只用于**分支**，不直接展示——展示的是人话。
 */
import { ApiError } from '../api'

export type ErrorKind = 'unreachable' | 'notFound' | 'unauthorized' | 'forbidden' | 'server' | 'client' | 'unknown'

export interface ErrorView {
  kind: ErrorKind
  /** 人话标题（稳定、不含变量） */
  title: string
  /** 补充说明（可为空字符串；已清洗，不含 API 路径/堆栈） */
  hint: string
  /** 是否值得给「重试」入口：参数类错误重试也不会成功，故为 false */
  retryable: boolean
}

/** 看起来像 API 路径的片段：`/api/...`，可带查询串 */
const API_PATH_RE = /\/api\/[A-Za-z0-9_\-./%:]*/g
/** 看起来像英文堆栈/内部错误的片段（避免把技术细节糊到用户脸上） */
const STACKISH_RE = /\b(?:TypeError|ReferenceError|SyntaxError|Error):\s?|at\s+\S+\s+\(|https?:\/\/\S+/g
/** 中日韩字符（含扩展 A 区、兼容表意文字、假名、谚文）：判断"这段话是不是给中文读者看的" */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const MAX_HINT = 140

/**
 * 清洗一段可能要展示给用户的原始文案。
 * 不做"智能改写"（那是臆造），只做**删除明显不该出现的部分**与截断。
 */
export function cleanHint(raw: unknown): string {
  const s = cleanSummary(raw)
  /*
    最后一道筛：**整段没有任何中日韩字符的解释文本，一律不当提示展示**。
    理由：本产品界面是中文，而"需要展示给用户的解释"必然含中文（我们自己的文案都是中文）；
    反过来，`Failed to fetch`、`Unknown error`、`ECONNREFUSED` 这类**纯技术串**没有中文，
    对用户零信息量，展示它们正是"开发味"。这不是"翻译"（那会臆造），只是**决定不显示**。
    保留含中文的混排（例如 "密钥无效 sk-…"），因为其中的中文部分是有用的。

    ⚠️ 本函数**不负责兜底**：真的一个中文都没有时它返回空串，由调用方决定要不要用
    {@link hintWithFallback}（`describeError` 就是这么做的 —— 早先没有这一层，
    于是服务端返回英文/技术串时错误提示只剩一个人话标题，用户与客服都拿不到任何线索）。
  */
  if (!CJK_RE.test(s)) return ''
  return s
}

/**
 * 清洗（剥 API 路径 / 英文堆栈 + 截断），但**不做中文筛选**。
 * 与 {@link cleanHint} 的唯一差别就是少了最后那道筛，供兜底文案使用。
 */
function cleanSummary(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let s = raw.replace(API_PATH_RE, '').replace(STACKISH_RE, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  // 清掉清洗后残留的分隔符噪声，例如 "not_found: " 或 "加载失败: "
  s = s.replace(/^[\s:：,，-]+/, '').replace(/[\s:：,，-]+$/, '')
  if (s.length > MAX_HINT) s = `${s.slice(0, MAX_HINT - 1)}…`
  return s
}

/**
 * 提示文案的**兜底**：优先给中文（`cleanHint`），没有中文时给 `错误详情：` + 已清洗摘要。
 *
 * 为什么需要兜底：`cleanHint` 为空时，错误提示就只剩一个稳定标题（"请求未被接受"），
 * 用户不知道发生了什么、客服也拿不到可复现的线索 —— 而服务端确实说了点什么。
 * 这里把**已清洗**（去掉 API 路径与堆栈形态、并按 MAX_HINT 截断）的那句话以
 * "错误详情：…"的形态交出来：既保住了"界面不出现路径/堆栈"的硬约束，
 * 又不再让信息凭空消失。可达性判据（`isUnreachable`）与 URL/堆栈清洗的优先级不变。
 */
export function hintWithFallback(raw: unknown): string {
  const cleaned = cleanHint(raw)
  if (cleaned !== '') return cleaned
  const summary = cleanSummary(raw)
  return summary === '' ? '' : `错误详情：${summary}`
}

/**
 * **排障用**的原始错误摘要 —— 只给 console 与 `data-*` 属性用，**绝不进界面文案**。
 *
 * 为什么需要它：有些失败（插件界面 bundle 加载失败）的原始串是唯一可用的线索
 * （"Failed to fetch dynamically imported module: …"），丢掉它，排障就只能靠猜。
 * 但它**不能**被渲染 —— 那正是 `cleanHint` 要拦的"开发味"。故这里把两种用途分开：
 * 给人看的走 {@link describeError} / {@link errorLine} / {@link cleanHint}，
 * 给排障看的走这里，并且调用点必须保证它只落在 console 或 `data-*` 上
 * （守卫见 `test/areaState.test.ts`：界面代码不得把原始错误串转成显示文本）。
 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

function isUnreachable(err: unknown): boolean {
  // fetch 在网络层失败时抛 TypeError（"Failed to fetch"）；ApiError 继承 Error 而非 TypeError，
  // 因此这个判据不会把"服务端返回的错误"误判成"连不上"。
  if (err instanceof TypeError) return true
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  return false
}

/**
 * 把任意 thrown 值映射成界面可用的 `ErrorView`。
 *
 * 分支顺序即优先级：**连不上服务**先判（它是环境问题，比业务状态更该先说），
 * 然后才是 HTTP 语义。
 *
 * 提示的兜底判据（本批 T6）：**只有"本来会剩空 hint"的分支**才走 {@link hintWithFallback}
 * （404 / 通用 4xx / 未知 —— 它们此前会在服务端给英文串时退化成"只剩一个标题"）。
 * 5xx、401、403 已经各自带一句稳定的中文下一步（"请稍后重试。""登录后才能继续。"…），
 * 那不是"只剩标题"，用兜底反而不如这句中文有用，故保持原样。
 */
export function describeError(err: unknown): ErrorView {
  if (isUnreachable(err)) {
    return {
      kind: 'unreachable',
      title: '连不上服务',
      hint: '请确认服务正在运行，然后重试。',
      retryable: true,
    }
  }
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return {
        kind: 'notFound',
        title: '内容不存在或已被删除',
        hint: hintWithFallback(err.message),
        retryable: true,
      }
    }
    if (err.status >= 500) {
      return {
        kind: 'server',
        title: '服务暂时出错',
        hint: cleanHint(err.message) || '请稍后重试。',
        retryable: true,
      }
    }
    /*
      401 / 403 **必须排在通用的 `>= 400` 之前**（P1 新增）。

      在此之前它们都落进 `client` 桶、显示成"请求未被接受"——对用户而言这是
      完全不可理解的信息：他既不知道要登录，也不知道是权限不够。
      这两类还要分别给出**不同的下一步**，故不能合并成一个 kind：
        401 → 去登录（`lib/authFailure.ts` 的统一出口会自动跳转，不会停在错误页）
        403 → 权限不足，要联系管理员（跳"无访问权限"页，见 pages/DeniedPage.tsx）

      `retryable: false`：401/403 重试同样的请求永远不会成功，给"重试"按钮是误导。
    */
    if (err.status === 401) {
      return {
        kind: 'unauthorized',
        title: '需要登录',
        hint: cleanHint(err.message) || '登录后才能继续。',
        retryable: false,
      }
    }
    if (err.status === 403) {
      return {
        kind: 'forbidden',
        title: '没有访问权限',
        hint: cleanHint(err.message) || '请联系管理员为你开通权限。',
        retryable: false,
      }
    }
    if (err.status >= 400) {
      return {
        kind: 'client',
        title: '请求未被接受',
        hint: hintWithFallback(err.message),
        // 参数/校验类错误：重试同样的请求不会成功，不该给"重试"按钮误导用户
        retryable: false,
      }
    }
  }
  return {
    kind: 'unknown',
    title: '出了点问题',
    hint: hintWithFallback(err instanceof Error ? err.message : err) || '请重试。',
    retryable: true,
  }
}

/**
 * 把任意 thrown 值压成**一行**可读文本（行内提示 / chip 用）。
 *
 * 为什么必须走这里而不是 `String(err)` / `err.message`：界面上任何位置直接渲染原始
 * message 都是泄漏点——它可能带 API 路径、英文、甚至内部实现细节。本仓库已多次出现
 * "页头挂一个 chip 直接印 message"的开发味实现，故把"压成一行"也收进这一层，
 * 让**所有**行内提示只有一个入口，无法绕过清洗。
 *
 * 形态：`标题` 或 `标题：已清洗的补充说明`。标题永远不含变量，便于用户形成稳定预期。
 */
export function errorLine(err: unknown): string {
  const view = describeError(err)
  return view.hint === '' ? view.title : `${view.title}：${view.hint}`
}
