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

export type ErrorKind = 'unreachable' | 'notFound' | 'server' | 'client' | 'unknown'

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
const MAX_HINT = 140

/**
 * 清洗一段可能要展示给用户的原始文案。
 * 不做"智能改写"（那是臆造），只做**删除明显不该出现的部分**与截断。
 */
export function cleanHint(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let s = raw.replace(API_PATH_RE, '').replace(STACKISH_RE, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  // 清掉清洗后残留的分隔符噪声，例如 "not_found: " 或 "加载失败: "
  s = s.replace(/^[\s:：,，-]+/, '').replace(/[\s:：,，-]+$/, '')
  if (s.length > MAX_HINT) s = `${s.slice(0, MAX_HINT - 1)}…`
  /*
    最后一道筛：**整段没有任何中日韩字符的解释文本，一律不当提示展示**。
    理由：本产品界面是中文，而"需要展示给用户的解释"必然含中文（我们自己的文案都是中文）；
    反过来，`Failed to fetch`、`Unknown error`、`ECONNREFUSED` 这类**纯技术串**没有中文，
    对用户零信息量，展示它们正是"开发味"。这不是"翻译"（那会臆造），只是**决定不显示**。
    保留含中文的混排（例如 "密钥无效 sk-…"），因为其中的中文部分是有用的。
  */
  if (!/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return ''
  return s
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
        hint: cleanHint(err.message),
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
    if (err.status >= 400) {
      return {
        kind: 'client',
        title: '请求未被接受',
        hint: cleanHint(err.message),
        // 参数/校验类错误：重试同样的请求不会成功，不该给"重试"按钮误导用户
        retryable: false,
      }
    }
  }
  return {
    kind: 'unknown',
    title: '出了点问题',
    hint: cleanHint(err instanceof Error ? err.message : err) || '请重试。',
    retryable: true,
  }
}

/**
 * 流式问答的**内部错误码 → 人话**。
 *
 * 这些码（`LlmErrorCode`）是给程序分支用的稳定标识，**不该出现在界面上**——用户读到
 * "RATE_LIMIT"/"PROVIDER_ERROR" 既不懂也不知道能做什么。原实现直接把 `{code}` 印在答案区，
 * 属于典型的"开发味"。
 *
 * 与 `describeError` 的分工：那个处理**HTTP 层**失败（有无 status），这个处理**已成功建流、
 * 但生成过程中失败**的情况——此时没有 HTTP 状态可依，只有 LLM 契约的错误码。
 * 两者都给 `{title, hint}`，便于同一套 `ErrorState` 渲染。
 */
export function streamErrorText(code: string): { title: string; hint: string } {
  switch (code) {
    case 'RATE_LIMIT':
      return { title: '模型服务限流了', hint: '稍等片刻再试，或换用其它模型服务。' }
    case 'TIMEOUT':
      return { title: '模型响应超时', hint: '问题可能太长或服务较慢，重试或缩短问题都会好些。' }
    case 'CONTEXT_WINDOW_EXCEEDED':
      return { title: '内容超出模型可处理长度', hint: '把问题问得更具体一些，或减少引用的资料。' }
    case 'AUTH':
    case 'INVALID_CREDENTIAL':
      return { title: '模型服务拒绝了凭据', hint: '请检查管理台里该插件的密钥配置是否正确。' }
    case 'MISSING_CREDENTIAL':
      return { title: '还没有配置模型密钥', hint: '配置后即可获得模型生成的回答；当前只能用检索结果。' }
    case 'NO_ADAPTER':
      return { title: '没有可用的模型服务', hint: '请先在管理台启用并配置一个模型插件。' }
    case 'NETWORK':
      return { title: '连接模型服务失败', hint: '检查网络或服务地址后重试。' }
    case 'ABORTED':
      return { title: '回答已取消', hint: '可以重新提问。' }
    default:
      return { title: '回答生成失败', hint: '请重试；若持续失败，请到管理台查看该模型插件的状态。' }
  }
}
