/**
 * `@geewiki/ai-web-search` 的类型与配置契约。
 *
 * ## 为什么这里有一层 `WebSearchProvider`
 *
 * 需求是"给 AI 一个联网搜索工具"，而**提供搜索能力的是外部服务**：AnySearch、以及将来
 * 可能换上的其它服务商。如果工具直接写 AnySearch 的 HTTP 细节，那么"换一家"就等于
 * 改工具、改错误文案、改返回给模型的 JSON 形状——模型看到的东西跟着服务商一起漂移，
 * 而工具描述是**已经进过模型工具表**的契约。
 *
 * 故切成两层，**切在哪一条缝上是有讲究的**：
 * - 工具层（`src/index.ts`）只认 {@link WebSearchProvider}：它负责"给模型看什么"，
 *   包括那个必须稳定的 JSON 形状与参数校验；
 * - 提供方层（`src/anysearch.ts`）只负责"怎么把一次检索问出去、怎么把应答翻译成
 *   {@link WebSearchResponse}"，HTTP 状态、信封、密钥、超时全烂在这一层里。
 *
 * "优先适配 AnySearch"就落在这一层：它是**第一个**实现，且是默认实现；加第二家时
 * 只需新增一个文件 + 一个分支，工具的契约一字不改。
 *
 * ## 一条不能忘的边界：搜索结果是**外部输入**
 *
 * 命中的标题/摘要/正文都来自公开互联网，也就是**任何人都能写的内容**。它们会进模型
 * 上下文，因此必须当**数据**看，绝不能被当成指令（`@geewiki/ai-tools` 的
 * `AiToolResult.content` 注释写着同一条）。本层只做两件力所能及的事：清洗控制字符
 * （见 {@link sanitizeText}）、并在结果里**显式标注来源性质**；真正的指令权边界
 * 由系统提示与"工具结果不是指令"这条约定兜住。
 */
import Schema from 'schemastery'

/* ============================== 归一化形状 ============================== */

/** 一条搜索结果。字段全是**字符串**，因为它们的来源是外部服务，不是我们的类型系统。 */
export interface WebSearchHit {
  readonly title: string
  readonly url: string
  /** 摘要。提供方不给就没有这个键。 */
  readonly snippet?: string
  /** 清洗后的页面正文。**只有调用方显式要求**（`includeContent`）时才可能有。 */
  readonly content?: string
}

/** 一次检索请求（已由工具层校验过形态）。 */
export interface WebSearchQuery {
  readonly query: string
  /** 期望条数。提供方可能给出更少。 */
  readonly maxResults?: number
  /** 检索地区。`cn` = 中文/国内源优先，`intl` = 国际源优先。 */
  readonly zone?: 'cn' | 'intl'
  /** 语言提示（如 `zh-CN` / `en`）。 */
  readonly language?: string
  /** 垂直领域标签（AnySearch 的动态能力目录给出）。 */
  readonly tag?: string
  /** 垂直领域的结构化参数。 */
  readonly params?: Readonly<Record<string, string | number | boolean>>
  /** 是否附带清洗后的页面正文（更大、更慢）。 */
  readonly includeContent?: boolean
  /** 附带正文时，全部结果正文合计的字符上限。 */
  readonly maxContentChars?: number
}

/** 一次检索的归一化应答。 */
export interface WebSearchResponse {
  readonly results: readonly WebSearchHit[]
  /** 上游报的命中总数（可能远大于 `results.length`）。 */
  readonly totalResults: number
  readonly searchTimeMs: number
  readonly requestId?: string
  /**
   * 本次调用是否带了 API 密钥。
   *
   * 它**不进模型上下文**（只进给人看的 `data`），用途是诊断：匿名额度被打满时
   * 报错形态与"密钥失效"完全不同，而两者从结果里看不出区别。
   */
  readonly authenticated: boolean
}

/** 搜索提供方。加第二家时实现它即可，工具层不动。 */
export interface WebSearchProvider {
  /** 提供方标识（进日志与 `data`，不进模型上下文）。 */
  readonly id: string
  /** 该提供方的配置是否可用于发起请求（如 baseUrl 是否合法）。 */
  available(): boolean
  search(query: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchResponse>
}

/* ============================== 文本清洗 ============================== */

/**
 * 把外部文本降级成**可以安全塞进 JSON 与模型上下文**的形态。
 *
 * 三件事，各有各的理由：
 * 1. **剥掉控制字符**（除换行/制表）。它们是终端与日志的注入面，而模型读到的
 *    `\u0000` 一类噪声纯属污染；Unicode 的行分隔符 `\u2028/\u2029` 则**转成真换行**
 *    （见下面实现里的注释：直接删会把两个词粘成一个，那是静默的语义改变）。
 * 2. **不发散空白**：连续空行折叠成一段。搜索摘要常带整块模板文本，留着只会挤占上下文。
 * 3. **不是转义、不是过滤**：文字内容**原样保留**（包括看起来像指令的句子）。
 *    本函数不做"像不像注入"的判断——那种黑名单既拦不住改写过的注入，又会静默删掉
 *    用户真正需要的内容（例如一篇讲提示注入的文章）。指令权边界靠"工具结果不是指令"
 *    这条约定，不靠正则。
 */
export function sanitizeText(value: string, options: { readonly keepNewlines?: boolean } = {}): string {
  const stripped = value
    /*
     * Unicode 的行分隔符先**转成真换行**，再走下面统一的空白处理。
     *
     * 不能直接删：`密钥\u2028换行` 删掉它就成了 `密钥换行`——两个词被粘成一个，
     * 而这是**静默的语义改变**（模型读到的是另一句话）。转成 `\n` 后，单行形态会把
     * 它折叠成空格、`keepNewlines` 形态会保留成段落，两种形态都保住了词边界。
     */
    .replace(/[\u2028\u2029]/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\r\n?/gu, '\n')
  const collapsed = options.keepNewlines === true
    ? stripped.replace(/\n{3,}/gu, '\n\n').replace(/[ \t]+$/gmu, '')
    : stripped.replace(/\s+/gu, ' ').trim()
  return collapsed.trim()
}

/* ============================== 配置 ============================== */

/**
 * 配置已由 schema 填好默认值；`ReturnType` 而非手写 interface，是为了让默认值与类型
 * **只有一个来源**（手写一份 interface 就会出现"加了字段忘了补类型"的静默漂移）。
 */
export const WebSearchConfigSchema = Schema.object({
  provider: Schema.string()
    .default('anysearch')
    .description('搜索提供方。当前实现：anysearch（AnySearch 公开检索 API）'),
  baseUrl: Schema.string()
    .default('https://api.anysearch.com')
    .description('提供方 API 根地址（留空用默认值；只接受 http/https）'),
  /**
   * **写一次、不可回读**的密钥字段（`role: 'secret'`，见 `@geewiki/manager` 的
   * `absorbSecrets` / `hydrateSecrets`）：值落盘到 gitignored 的 `config/secrets.json`，
   * **绝不写进入库的 `config/plugins.*.json`**，任何 HTTP 响应都不回显。
   *
   * **留空是可用状态，不是缺失状态**：AnySearch 支持匿名调用（额度按来源 IP 计），
   * 所以"没配密钥"不该让工具消失——这正是它比"密钥必填"更该有的形态。
   */
  apiKey: Schema.string()
    .default('')
    .role('secret')
    .description('AnySearch API 密钥（留空 = 用匿名额度，无需注册即可用；填了按账号额度计。保存后不再回显）'),
  maxResults: Schema.number()
    .default(5)
    .min(1)
    .max(20)
    .description('单次检索返回的条数上限。模型只能在这个上限内请求更多（条数越多，工具结果越挤占上下文）'),
  includeContent: Schema.boolean()
    .default(false)
    .description(
      '检索结果是否保留上游返回的页面正文。开 = 模型能直接读到正文（更占上下文，但不必再点开链接）；关 = 只给标题与摘要',
    ),
  maxContentChars: Schema.number()
    .default(8000)
    .min(500)
    .max(200000)
    .description('附带正文时，全部结果正文合计的字符上限（超出按顺序截断并在结果里写明）'),
  zone: Schema.string()
    .default('')
    .description('检索地区：留空 = 提供方默认；cn = 中文/国内源优先；intl = 国际源优先'),
  language: Schema.string()
    .default('')
    .description('语言提示（如 zh-CN、en）。留空 = 不指定'),
  timeoutMs: Schema.number()
    .default(20000)
    .min(1000)
    .max(120000)
    .collapse()
    .description('单次检索的 HTTP 超时（毫秒）。超时即失败，**不重试**（重试会把一次超时叠成双倍等待，并放大配额消耗）'),
})

export type WebSearchConfig = ReturnType<typeof WebSearchConfigSchema>
