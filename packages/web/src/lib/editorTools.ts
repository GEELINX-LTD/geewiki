/**
 * `editor.*` 客户端工具 —— **宿主侧**的编辑框动作。
 *
 * ## 为什么这些工具由宿主登记，而不是由插件自己执行
 * 设计文档 §9.1 的岔路（编辑框工具由谁登记）在这里定稿为 **(a) 宿主登记**，
 * 但理由与草图里那条"`ai-writing` 就没有存在理由了"不同、也不冲突：
 *
 * 工具在架构里本来就是**两半**（`packages/web/src/lib/clientTools.ts` 文件头）——
 * **服务端说"这个工具存在"**（描述符进模型的工具表），
 * **浏览器说"这个工具在我这儿怎么跑"**（处理器）。两半点名同一个名字，任何一半都不得单独
 * 定义"它存在"。于是 `ai-writing` 的职责是**声明描述符**（与 `@geewiki/ai-kb` 声明三条
 * 服务端工具完全同构），宿主的职责是**实现处理器**。决策 18 保留 `ai-writing` 与本节
 * 取 (a) 因此并不矛盾：插件是**契约的持有者**，宿主是**能力的持有者**。
 *
 * 为什么实现必须在宿主：编辑框句柄（`MarkdownEditorHandle`）与"此刻能不能写回"
 * 这两件事**只有宿主知道**。把句柄开给插件 SDK 会多开一个进程内可变状态的口子，
 * 而它换来的只是"让插件自己调一遍宿主函数"。
 *
 * ## 能力不存在用**可选字段**表达
 * 插件编辑器占住 `editor` 插槽时，宿主既没有选区也没有插入句柄（`EditorSlotProps`
 * 不含正文模型）。此时**不登记**那三条工具——于是它们不出现在 `clientTools` 里、
 * 也不进模型看到的工具表。这正是宿主 SDK 注释里那条纪律：
 * 「用可选字段表达'能力不存在'，比塞一个什么都不做的假函数诚实」。
 *
 * ## 写操作的回退（P4 落地）
 * 决策 3 要求写操作能"一键回退到某一轮之前"，由 P4 的 mutation journal 承接。
 * 浏览器这一侧的接法是**观察式**而不是**声明式**：会话核心（dock）在每一轮客户端工具调用
 * **前后各读一次正文**，发现真的变了才记一条 `editor` 域的日志。这样就不必再维护一份
 * "哪些客户端工具是写工具"的名单——那会是同一份事实的第三份镜像，而镜像会漂移。
 *
 * 回退时日志把 `editor` 域交给**客户端**执行（服务端没有这个域的 undoer）——那一步需要
 * "整篇设回原样"，故本文件额外登记一条 {@link RESTORE_DOC_TOOL}。它**刻意不在**
 * {@link EDITOR_TOOL_NAMES} 里：那份名单是**发给模型的工具表**的镜像，而 `restore_doc`
 * 只供宿主在回退时调用——模型不该拥有"把用户草稿整篇换掉"的手柄。
 */
import { registerClientTool } from './clientTools'

/**
 * 工具名清单。**这是与 `@geewiki/ai-writing` 服务端描述符的镜像**（浏览器侧不能 import
 * 那个包），一致性由 `packages/web/test/editorTools.test.ts` 读两侧源码逐字比对钉住。
 *
 * 顺序即登记顺序，也必须是**稳定**的：这份名单会经轮次协议上送服务端、参与构成发给模型的
 * 工具表，顺序不稳 ⇒ 每轮请求前缀都变 ⇒ 上游前缀缓存全失效
 * （`clientTools.ts` 的 `clientToolNames()` 已排序，这里再排一次是防"有人插一条到中间"）。
 */
export const EDITOR_TOOL_NAMES = [
  // 按名字排序（不是按读/写分组）：这份名单会经轮次协议上送服务端参与构成发给模型的工具表，
  // 顺序不稳 ⇒ 每轮请求前缀都变 ⇒ 上游前缀缓存全失效。排序规则与 clientToolNames() 一致。
  'editor.insert_text',
  'editor.read_doc',
  'editor.read_selection',
  'editor.replace_selection',
] as const

export type EditorToolName = (typeof EDITOR_TOOL_NAMES)[number]

/** 只有内置编辑器在场时才登记的三条（插件编辑器占住 `editor` 时宿主没有句柄） */
export const EDITOR_HANDLE_TOOL_NAMES: readonly EditorToolName[] = [
  'editor.read_selection',
  'editor.insert_text',
  'editor.replace_selection',
]

/**
 * `editor.read_doc` 单次返回的字符上限，与 `read_page` 同一条纪律：
 * **截断必须说出来**（`truncated` + `totalChars`），不能把"我没看到"
 * 伪装成"正文里没有"——探针 E4 正是这么骗过模型的。
 */
export const EDITOR_DOC_MAX_CHARS = 20000

/**
 * 编辑框此刻的能力快照。
 *
 * **所有读取都走函数而不是取值**：这些值每一帧都在变（`content` 每敲一个字就变），
 * 而工具处理器是在**模型调用时**才跑的。若在这里存快照，模型读到的会是"注册那一刻的正文"，
 * 而那是一个**看起来正常、其实错位**的结果。
 */
export interface EditorCapability {
  readonly slug: string
  /** 保存中：此时写入会被随后的保存覆盖，故拒绝（不是静默排队） */
  readonly readOnly: boolean
  readonly docText: () => string
  /** 无句柄时返回 `null`（插件编辑器路径），那三条工具也就不会登记 */
  readonly selection: (() => { readonly text: string; readonly from: number; readonly to: number } | null) | null
  readonly insertAtCursor?: (text: string) => void
  readonly replaceSelection?: (text: string) => boolean
  /**
   * 整篇设回给定文本（AI 回退用）。**可选**：没有它时 `editor.restore_doc` 不登记，
   * 回退会让那一条落进"需要在编辑页手动撤销"——用可选字段表达"这个能力此刻不存在"，
   * 与三条模型工具同一口径。
   */
  readonly setDoc?: (text: string) => void
}

/**
 * 回退专用、**不对模型开放**的客户端工具名。
 *
 * 单独一个常量而不是塞进 {@link EDITOR_TOOL_NAMES}：后者是发给模型的工具表的镜像
 * （与 `@geewiki/ai-writing` 的服务端描述符逐字比对）。`restore_doc` 没有服务端描述符，
 * 它永远不该出现在模型看到的工具表里——模型手里不该有"整篇覆盖用户草稿"的手柄。
 * 宿主可以在本地任意调用自己登记的工具（`host.invokeTool`），这条缝隙正是为此存在的。
 */
export const RESTORE_DOC_TOOL = 'editor.restore_doc'

/** 处理器收到的 `args` 来自**模型**（经服务端 SSE 回灌），也就是外部输入：先校验再使用 */
function requireText(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    throw new Error('参数必须是 JSON 对象，且含 text 字段')
  }
  const text = (args as Record<string, unknown>)['text']
  if (typeof text !== 'string') {
    throw new Error('参数 text 必须是字符串')
  }
  if (text === '') {
    throw new Error('参数 text 不得为空（空写入只会让用户困惑）')
  }
  return text
}

/** 写入前的统一闸门：能力不存在与只读要给出**不同**的错，否则用户无从知道该等还是该改**/
function refuseWrite(capability: EditorCapability, what: string): void {
  if (capability.readOnly) {
    throw new Error(`页面正在保存中，${what}已拒绝（等保存完成后再试，否则这次修改会被覆盖）`)
  }
}

/**
 * 登记本轮可用的 `editor.*` 工具，返回**幂等**的注销函数。
 *
 * 调用方必须保证同一时刻只有一处登记（`registerClientTool` 对重名**抛错**，
 * 不静默覆盖）——React 侧因此用 effect 的清理函数成对使用。
 */
export function registerEditorTools(capability: EditorCapability): () => void {
  const disposers: (() => void)[] = []

  disposers.push(
    registerClientTool('editor.read_doc', () => {
      const text = capability.docText()
      const truncated = text.length > EDITOR_DOC_MAX_CHARS
      return {
        slug: capability.slug,
        chars: text.length,
        truncated,
        text: truncated ? text.slice(0, EDITOR_DOC_MAX_CHARS) : text,
        ...(truncated
          ? { hint: `正文已截断到前 ${EDITOR_DOC_MAX_CHARS} 字符（全文 ${text.length} 字符）——不要据此断言后面没有某段内容` }
          : {}),
      }
    }),
  )

  if (capability.selection !== null) {
    const selectionOf = capability.selection
    disposers.push(
      registerClientTool('editor.read_selection', () => {
        const selection = selectionOf()
        return { selection, empty: selection === null }
      }),
    )
  }

  if (capability.insertAtCursor) {
    const insert = capability.insertAtCursor
    disposers.push(
      registerClientTool('editor.insert_text', (args: unknown) => {
        refuseWrite(capability, '插入')
        const text = requireText(args)
        insert(text)
        return { ok: true, insertedChars: text.length }
      }),
    )
  }

  if (capability.replaceSelection) {
    const replace = capability.replaceSelection
    const selectionOf = capability.selection
    disposers.push(
      registerClientTool('editor.replace_selection', (args: unknown) => {
        refuseWrite(capability, '替换选区')
        const text = requireText(args)
        const before = selectionOf?.() ?? null
        if (before === null) {
          throw new Error('当前没有选中任何文本，replace_selection 无从下手（要插入请用 editor.insert_text）')
        }
        const ok = replace(text)
        if (!ok) throw new Error('替换未生效：编辑器没有可用的选区')
        return { ok: true, replacedChars: before.text.length, insertedChars: text.length }
      }),
    )
  }

  /*
   * 回退入口：**只登记给宿主**（不在 EDITOR_TOOL_NAMES 里，故不进模型的工具表）。
   *
   * 参数来自宿主（不是模型），但仍然校验：这条路径的输入最终来自 mutation journal 的
   * `before` 字段，而那是一个经 HTTP 往返的字符串——按不可信输入处理。
   */
  if (capability.setDoc) {
    const setDoc = capability.setDoc
    disposers.push(
      registerClientTool(RESTORE_DOC_TOOL, (args: unknown) => {
        // 保存中就拒绝：这次回退会被随后的保存覆盖掉，静默放行等于骗用户说"撤好了"
        refuseWrite(capability, '回退')
        if (typeof args !== 'object' || args === null) throw new Error('参数必须是 JSON 对象，且含 text 字段')
        const text = (args as Record<string, unknown>)['text']
        if (typeof text !== 'string') throw new Error('参数 text 必须是字符串')
        setDoc(text)
        return { ok: true, chars: text.length }
      }),
    )
  }

  let done = false
  return () => {
    if (done) return
    done = true
    for (const dispose of disposers) dispose()
  }
}
