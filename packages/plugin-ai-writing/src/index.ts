/**
 * `@geewiki/ai-writing` —— 编辑框工具提供者：`editor.read_doc` / `editor.read_selection` /
 * `editor.insert_text` / `editor.replace_selection`。
 *
 * ## 本插件只做**一半**的事，这是设计而不是未完成
 * 工具在架构里是两半（`packages/web/src/lib/clientTools.ts` 文件头）：
 * **服务端说"这个工具存在"**（本文件贡献的四条描述符，进模型的工具表），
 * **浏览器说"这个工具在我这儿怎么跑"**（`packages/web/src/lib/editorTools.ts` 里宿主登记的
 * 同名字处理器）。两半点名同一个名字，**任何一半都不得单独定义"它存在"**。
 *
 * 于是本插件的职责与 `@geewiki/ai-kb` 声明三条服务端工具**完全同构**：
 * 它是契约的持有者，宿主是能力的持有者。这也是设计文档 §9.1 那条岔路的答案 ——
 * 取"(a) 宿主登记处理器"并不让本插件失去存在理由，因为描述符**本来就必须由插件声明**
 * （`clientTools.ts`：描述符必须由插件在服务端以 `side: 'client'` 贡献，
 * 否则模型看不到它、也就不会请求它）。
 *
 * ## 为什么写工具必须声明 `mutating`
 * `editor.insert_text` / `editor.replace_selection` 会改用户的东西，因此是 `mutating: true`：
 * 自锁护栏、回退 UI、诊断都要看这份名单（`AiToolDiagnostics.mutating`）。
 *
 * **P3 的明确边界**：它们目前**没有** mutation journal 兜底（P4 才做）。
 * 之所以可以先行，是因为它们改的是**编辑框里的草稿**而非已保存的正文——
 * 用户不点「保存」就什么都不会落库，草稿本身还有编辑器的撤销栈。
 *
 * ## 决策 18 拆掉了什么
 * 原先的续写 / 改写 / 润色 / 摘要四个按钮、`POST /api/ai/assist` 端点、`editor-toolbar`
 * 插槽贡献与整份前端产物**全部删除**：它们是"插件自带一套 UI"的形态，
 * 与"AI 只有一个入口（`app-dock` 的输入条）"矛盾——同一件事有两条界面路径时，
 * 两条都会漂移。本插件现在没有任何 HTTP 端点、不贡献任何插槽、**没有 `client`**。
 */
import type { Context } from 'cordis'
import type { GeeWikiManifest, Principal } from '@geewiki/core'
import { AI_TOOL_SERVICE_NAME, type AiToolContribution, type AiToolService } from '@geewiki/ai-tools'

/**
 * 四条工具名。**这是宿主侧 `packages/web/src/lib/editorTools.ts` 的镜像**（服务端不能
 * import 浏览器模块，浏览器模块也不会进 node bundle），一致性由
 * `test/toolNames.test.ts` 读两侧源码逐字比对钉住——照本仓既有的"镜像 + 守卫"文化
 * （`api.ts` 的 `DegradedReason`、`searchPlan.ts` 的 `MAX_QUERY_LENGTH` 都是这样钉的）。
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

/** 会改用户东西的两条：`mutating` 让它们在自锁护栏与回退 UI 里可见 */
export const EDITOR_MUTATING_TOOL_NAMES: readonly EditorToolName[] = [
  'editor.insert_text',
  'editor.replace_selection',
]

/**
 * `side: 'client'` 的工具**执行体不可能在服务端跑**——它必须由浏览器侧的宿主处理器实现。
 *
 * 那为什么还要填一个 `execute`：`AiToolContribution` 把它声明成必填，而"必填"在这里是
 * **对的**——它逼着本插件显式写出"这一半不归我"，而不是留一个没填的洞让读者猜。
 * 真被调到即抛错：这是**代码错**（服务端不该执行客户端工具），不是用户输入错，
 * 所以不能静默返回一个"未实现"的字符串让模型以为成功了。
 */
function browserSide(name: EditorToolName) {
  return (_principal: Principal, _args: unknown): never => {
    throw new Error(
      `[${manifest.name}] ${name} 是 side:'client' 工具，执行体在浏览器（宿主登记），` +
        '服务端不得执行它——出现这条说明工具表被错误地当成了可本地执行的服务端工具',
    )
  }
}

/*
 * 描述符要回答的是「**什么时候**该调用我」，不是"我是什么"（`@geewiki/ai-tools` 的
 * `TOOL_DESCRIPTION_BUDGET = 200` 是注意力预算，超了只告警不抛错）。
 * 四条里措辞最要紧的是 `editor.read_doc` 与 `search_kb` 的分工：**编辑框里的草稿不在
 * 知识库里**，`search_kb` 永远搜不到它——不写清这一点，模型会去搜知识库然后说"没找到"。
 */
function editorTools(): readonly AiToolContribution[] {
  return [
    {
      descriptor: {
        name: 'editor.read_doc',
        description:
          '读取用户**当前正在编辑**的正文草稿（含未保存的改动）。这与 search_kb / read_page 不同：' +
          '草稿不在知识库里，检索搜不到它。要针对"用户正在写的东西"作答时用这个。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        side: 'client',
      },
      execute: browserSide('editor.read_doc'),
    },
    {
      descriptor: {
        name: 'editor.read_selection',
        description: '读取用户在编辑框里**当前选中的文本**。没有选中时结果为空。改写、润色类请求先调它。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        side: 'client',
      },
      execute: browserSide('editor.read_selection'),
    },
    {
      descriptor: {
        name: 'editor.insert_text',
        description:
          '把文本**插入编辑框光标处**（有选区时替换该选区）。用户说"加上""补一句""在这儿写"时用。' +
          '只改草稿：用户仍可撤销，也需要自己点保存。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '要插入的 Markdown 文本，不得为空' } },
          required: ['text'],
          additionalProperties: false,
        },
        side: 'client',
        mutating: true,
      },
      execute: browserSide('editor.insert_text'),
    },
    {
      descriptor: {
        name: 'editor.replace_selection',
        description:
          '用新文本**替换用户选中的那段**。用户说"把这段改成""重写选中的部分"时用。' +
          '没有选中任何文本时它会失败——那时应该改用 editor.insert_text。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '替换后的 Markdown 文本，不得为空' } },
          required: ['text'],
          additionalProperties: false,
        },
        side: 'client',
        mutating: true,
      },
      execute: browserSide('editor.replace_selection'),
    },
  ]
}

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-writing',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 编辑框工具',
    description: '把「读草稿 / 读选区 / 插入 / 替换选区」四个编辑框动作作为工具提供给 AI 助手',
    // 纯贡献者，不 provide 任何服务（同 @geewiki/ai-kb）。当前零消费方，
    // 为不存在的消费方设计接口 = 凭空造一份没测试的契约。
    provides: undefined,
    requires: ['ai-tool-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 无内部状态：产物就是四条注册
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: undefined,
    /*
     * ★ 没有 `client`：本插件的前端产物已随决策 18 删除。
     * 留一个空的 client 声明会让 `GET /api/plugins/ui` 把它列进入口表，
     * 前端于是去请求一个不存在的 `client.js` ⇒ `entry_missing` 告警。
     */
    slots: undefined,
  },
}

export const AiWritingPlugin = {
  name: '@geewiki/ai-writing',

  apply(ctx: Context): () => void {
    /*
     * 服务缺失时**明确抛错**，不静默跳过 —— 与 `@geewiki/ai-kb` 同一条实测教训
     * （`packages/manager/src/slot-plugin.ts` 文件头）：手动 `ctx.get()` +
     * `if (!tools) return` 会让插件"看起来激活成功、实际什么都没贡献"，
     * 而服务端查不到任何痕迹，与"这个插件本来就没贡献"完全无法区分。
     */
    const tools = ctx.get(AI_TOOL_SERVICE_NAME) as AiToolService | undefined
    if (!tools) {
      throw new Error('@geewiki/ai-writing: ai-tool-service 不可用（@geewiki/ai-tools 未激活）')
    }
    for (const tool of editorTools()) tools.contribute(manifest.name, tool)

    return () => {
      /*
       * 按 owner 定向回收，而不是逐个收集 `contribute` 返回的 disposer。
       * 两者都可用（disposer 幂等），但 owner 回收是**权威**的那一条：
       * 它与管理器卸载插件时走的路径一致，且不依赖"每加一条都记得收进数组"这个纪律。
       */
      tools.release(manifest.name)
    }
  },
}
