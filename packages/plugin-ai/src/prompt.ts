/**
 * Prompt 拼装（**纯函数**，无 IO、无 Date/Math.random，同输入必同输出）。
 *
 * 为什么单独成文件：这是"检索结果 → 喂给模型的文本"的唯一入口，也是接入 adapter 后
 * 最需要被钉住形态的地方（引用编号、资料边界、禁止编造）。做成纯函数就能在没有
 * provider、没有网络的情况下把它测到底。
 *
 * 本批**不发送**这里产出的 messages（尚无 adapter），但形态已定稿，接线时直接可用。
 */
import type { LlmMessage } from '@geewiki/llm'

/**
 * 系统提示词。四条要求都对应一类真实失败模式：
 * - "只依据资料"：否则模型会拿预训练知识回答，用户无法核对来源；
 * - "资料不足必须明说"：否则会编造，而知识库场景里编造比拒答更糟；
 * - "引用标 [n]"：让回答可回溯到 sources 里的具体条目；
 * - "不要编造链接/路径"：模型很爱补一个看起来合理的 URL，而本站的 slug 是可校验的。
 */
export const SYSTEM_PROMPT = [
  '你是 GeeWiki 知识库的问答助手。',
  '只依据用户提供的「资料」回答问题，不要使用资料之外的知识。',
  '如果资料不足以回答，必须明确说明"资料不足，无法回答"，不要猜测。',
  '引用资料时在句末标注来源编号，格式为 [n]（n 为资料前的编号，可多个如 [1][3]）。',
  '不要编造链接、URL、文件路径或资料中不存在的事实。',
  '回答使用与提问相同的语言，简洁直接，不要复述整个资料。',
].join('\n')

/** 进入上下文的一条资料：`n` 与 sources 里 `used:true` 的编号严格一致 */
export interface ContextSource {
  /** 引用编号（从 1 连续） */
  n: number
  slug: string
  title: string
  /** 已按 perSourceChars 截断的正文 */
  text: string
}

export interface BuildContextOptions {
  /** 是否在每条资料前加 `[n] 标题（slug）` 标题行（默认 true） */
  includeTitle?: boolean
}

/**
 * 把已选中的资料拼成上下文文本。
 *
 * 形态固定为：
 * ```
 * [1] 标题（slug）
 * 正文…
 *
 * [2] …
 * ```
 * **只接受已选中的资料**——被截断策略丢弃的条目不在这里出现（调用方负责区分），
 * 这样"prompt 里出现的 [n]"与"sources 里 used:true 的 n"天然一一对应。
 */
export function buildContext(sources: readonly ContextSource[], opts: BuildContextOptions = {}): string {
  const includeTitle = opts.includeTitle ?? true
  return sources
    .map((s) => {
      const heading = includeTitle ? `[${s.n}] ${s.title}（${s.slug}）\n` : `[${s.n}]\n`
      return `${heading}${s.text}`
    })
    .join('\n\n')
}

/**
 * 组装发给模型的 messages（system + user 两条）。
 *
 * 资料为空时**仍然**产出合法的 messages：把"没有检索到资料"如实写进 user 内容，
 * 让模型有机会按 system 要求回答"资料不足"。绝不产出一条"看起来有资料"的空上下文
 * ——那正是诱导编造的形态。
 */
export function buildMessages(
  query: string,
  sources: readonly ContextSource[],
  opts: BuildContextOptions = {},
): LlmMessage[] {
  const context = buildContext(sources, opts)
  const body =
    sources.length === 0
      ? `资料：（本次检索没有命中任何资料）\n\n问题：${query}`
      : `资料：\n${context}\n\n问题：${query}`
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: body },
  ]
}
