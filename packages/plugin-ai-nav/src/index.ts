/**
 * `@geewiki/ai-nav` —— 页面跳转工具提供者：`open_page` / `scroll_to`。
 *
 * ## 这两条工具回答的是需求 ② 的后半句
 * 需求原文是「既能针对当前页面内容回答，**也能自行找其他页面**」。前半句由
 * `packages/plugin-ai-assistant/src/prompt.ts` 的当前页附注 + `read_page` 落；
 * 后半句光有检索还不够——`search_kb` 只能给出 slug，**用户还停在原地**。
 * 这两条让模型能把用户真正带到那一页、那个小节。
 *
 * ## 本插件只做**一半**的事（与 `@geewiki/ai-writing` 完全同构）
 * 工具是两半（`packages/web/src/lib/clientTools.ts` 文件头）：
 * **服务端说"这个工具存在"**（本文件的描述符进模型的工具表），
 * **浏览器说"它在我这儿怎么跑"**（`packages/web/src/lib/navTools.ts` 里宿主登记的同名处理器）。
 * 两半点名同一个名字，任何一半都不得单独定义"它存在"。
 *
 * 为什么跳转必须是客户端工具而不是服务端工具：**"跳到哪"是浏览器的事**。
 * 服务端没有 DOM、不知道当前渲染出了哪些小节，也没有权限替用户改地址栏。
 * 一条服务端版的 `open_page` 只能返回一句"请用户自己打开 X"——那不是能力，是说明。
 *
 * ## 为什么它们**不是** `mutating`
 * `mutating` 的含义是"会产生副作用、必须能产生逆操作"（mutation journal 的口径）。
 * 跳转与滚动**改的不是数据**：刷新一下就回到原处，也不需要"撤销"。
 * 把它们标成 mutating 会让回退 UI 上多出两条点了没反应的条目——
 * 那是一种**看起来很坏**的正常结果（`Readonly` 与 `mutating` 的分界见 §4.3）。
 */
import type { Context } from 'cordis'
import type { GeeWikiManifest, Principal } from '@geewiki/core'
import { AI_TOOL_SERVICE_NAME, type AiToolContribution, type AiToolService } from '@geewiki/ai-tools'

/**
 * 两条工具名。**这是宿主侧 `packages/web/src/lib/navTools.ts` 的镜像**
 * （服务端不能 import 浏览器模块，反之亦然），一致性由 `test/toolNames.test.ts`
 * 读两侧源码逐字比对钉住——照本仓既有的"镜像 + 守卫"文化。
 */
export const NAV_TOOL_NAMES = ['open_page', 'scroll_to'] as const

export type NavToolName = (typeof NAV_TOOL_NAMES)[number]

/**
 * `side: 'client'` 的工具执行体**不可能在服务端跑**。
 *
 * 那为什么还要填一个 `execute`：`AiToolContribution` 把它声明成必填，而"必填"在这里
 * 是**对的**——它逼着本插件显式写出"这一半不归我"，而不是留一个没填的洞让读者猜。
 * 真被调到即抛错：这是**代码错**（服务端不该执行客户端工具），不是用户输入错。
 */
function browserSide(name: NavToolName) {
  return (_principal: Principal, _args: unknown): never => {
    throw new Error(
      `[${manifest.name}] ${name} 是 side:'client' 工具，执行体在浏览器（宿主登记），` +
        '服务端不得执行它——出现这条说明工具表被错误地当成了可本地执行的服务端工具',
    )
  }
}

/*
 * 描述符要回答的是「**什么时候**该调用我」。两条里最要紧的措辞是 `open_page` 的
 * "不要用它来声称你已经看过了"：模型很容易把"我可以打开它"当成"我已经读过它"
 * ——那正是本仓最不能接受的一类失败（`search_kb` 的注释里记过同源的一条：
 * 静默截断把"我没看到"伪装成"资料里没有"）。
 */
function navTools(): readonly AiToolContribution[] {
  return [
    {
      descriptor: {
        name: 'open_page',
        description:
          '把用户**带到**某个知识库页面（浏览器会真的跳转过去）。用在你已经知道该看哪一页、' +
          '并且让用户直接看到它比复述内容更有用时。注意：调用它**不等于**你读过了那一页的内容' +
          '——要引用正文请同时用 read_page。',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: '页面标识，例如 home 或 guide/intro。从 list_pages / search_kb 的结果里取' },
          },
          required: ['slug'],
          additionalProperties: false,
        },
        side: 'client',
      },
      execute: browserSide('open_page'),
    },
    {
      descriptor: {
        name: 'scroll_to',
        description:
          '把用户滚到**当前页面**里的某个小节。用户问"某一段在哪""这一页讲了什么"而答案就在本页下文时用。' +
          'anchor 写小节标题或它的锚点 id 都行；写错时结果里会列出这一页真实存在的小节。',
        parameters: {
          type: 'object',
          properties: {
            anchor: { type: 'string', description: '小节标题（如"安装步骤"）或它的锚点 id（如 install-steps）' },
          },
          required: ['anchor'],
          additionalProperties: false,
        },
        side: 'client',
      },
      execute: browserSide('scroll_to'),
    },
  ]
}

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-nav',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 页面跳转工具',
    description: '把「打开某个页面 / 滚到某小节」两个动作作为工具提供给 AI 助手',
    // 纯贡献者，不 provide 任何服务（同 @geewiki/ai-kb / @geewiki/ai-writing）
    provides: undefined,
    requires: ['ai-tool-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 无内部状态：产物就是两条注册
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: undefined,
    // 没有 `client`：本插件**没有自己的界面产物**。留一个空的 client 声明会让
    // `GET /api/plugins/ui` 把它列进入口表，前端于是去请求一个不存在的 client.js ⇒ `entry_missing` 告警。
    slots: undefined,
  },
}

export const AiNavPlugin = {
  name: '@geewiki/ai-nav',

  apply(ctx: Context): () => void {
    /*
     * 服务缺失时**明确抛错**，不静默跳过 —— 与 `@geewiki/ai-kb` 同一条实测教训
     * （`packages/manager/src/slot-plugin.ts` 文件头）：手动 `ctx.get()` +
     * `if (!tools) return` 会让插件"看起来激活成功、实际什么都没贡献"，
     * 而服务端查不到任何痕迹，与"这个插件本来就没贡献"完全无法区分。
     */
    const tools = ctx.get(AI_TOOL_SERVICE_NAME) as AiToolService | undefined
    if (!tools) {
      throw new Error('@geewiki/ai-nav: ai-tool-service 不可用（@geewiki/ai-tools 未激活）')
    }
    for (const tool of navTools()) tools.contribute(manifest.name, tool)

    return () => {
      // 按 owner 定向回收：与管理器卸载插件时走的路径一致
      tools.release(manifest.name)
    }
  },
}
