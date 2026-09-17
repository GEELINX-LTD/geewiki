/**
 * 插槽（slot）契约的**浏览器安全**子集 —— 全文唯一真源。
 *
 * ## 为什么这是一个独立文件，而不是留在 `index.ts` 里
 * 这份白名单有**两个**消费者，其中一个在浏览器里：
 * - 后端（`@geewiki/manager`）用它登记贡献、裁决冲突；
 * - 前端（`@geewiki/web`）用它渲染 `<SlotOutlet>`、判断"这个插槽名认不认识"。
 *
 * 而 `index.ts` 顶层 `import 'node:fs'` / `'node:path'` / `'node:url'`，**进不了浏览器 bundle**。
 * 在本次改造之前，代价是前端手抄镜像 —— 而且不止一份：
 * `web/src/lib/slots.tsx`（第二份）、`web/src/lib/pluginUiPlan.ts`（第三份）、
 * `slots.tsx` 的 `SINGLE_OCCUPANCY_SLOTS`（第四份，重复了这里的基数事实），
 * 再靠两处源码级正则守卫测试钉住它们。镜像漂移的表现是**静默的**：后端登记了贡献、
 * 前端把它当未知插槽忽略 ⇒ 插件"激活了、管理台表里也有、界面上什么都没有"，
 * 而日志一片干净。（本仓库已踩过同形状的坑：`DegradedReason` 镜像、`PLUGIN_UI_FILE_SEGMENT` 副本。）
 *
 * 现在前端经 **`@geewiki/core/slots`** 子路径导入本文件（`packages/core/package.json`
 * 的 `exports` 里声明），镜像全部删除。
 *
 * ## 本文件的两条硬约束
 * 1. **不得引入任何 `node:*`、cordis 或 schemastery 依赖** —— 它要能被 Vite 打进浏览器。
 *    由 `packages/core/test/slots-browser-safe.test.ts` 以源码级断言钉住。
 * 2. **不得 import 本包的 `index.ts`**（那会把 `node:fs` 拖回来）—— 同上守卫。
 *
 * 只放「前后端都要用的纯常量与纯函数」；任何依赖宿主服务或 Node 能力的东西留在 `index.ts`。
 */

/**
 * 宿主暴露给插件的**具名内置插槽**。
 *
 * - `app-header` / `app-footer`：**零属性**插槽，可多方贡献（多）。
 * - `editor`：**带数据的单占用**插槽（见 `EditorSlotProps`）。
 * - `editor-toolbar`：编辑页工具条（**多**占用），见 `EditorToolbarSlotProps`。
 *   与 `editor` 的关键差别：它**不替换**编辑区——宿主的内置编辑器照常在场，插件只是往
 *   编辑页注入自己的按钮组。**当前无占用者**：原先占它的 `@geewiki/ai-assist` 已随决策 18
 *   改成 `@geewiki/ai-writing`，而那四个写作按钮被整份删除（AI 只有 `app-dock` 一个入口，
 *   同一件事有两条界面路径时两条都会漂移）。插槽本身保留：它是有守卫测试的公开契约，
 *   删一个没人用的插槽会让"以后想加回编辑页按钮"变成一次契约变更。
 * - `app-dock`：**常驻底部输入条**（**单**占用），见 `AppDockSlotProps`。它**不挂在
 *   某条路由上**——渲染点在 `App.tsx` 的 `<main>` 之外，与 `app-header`/`app-footer` 同一
 *   位置，因此**切页不重挂**，会话状态天然存活。它是 AI 对话的**唯一入口**。
 *
 *   这里原先还有一个 `wiki-ask`（问答面板位，单占用，搭在 `#/wiki/ask/<q>` 路由上）。
 *   **P8 已拆除**（决策 17）：同一个功能有两条界面路径时两条都会漂移——dock 与问答页
 *   各有一套输入、各自维护会话，用户在哪个里面问、答案去哪找，两处都答不上来。
 *   拆除面见设计文档 §7.1，`'ask'` 仍保留为 slug 保留段（解禁是单向不可回收的）。
 * - `article-summary`：**文章标题下方的折叠摘要位**（**单**占用），见 `ArticleSummarySlotProps`。
 *   它是用户需求 ④（"摘要以折叠形式显示"）的落点，**不是对话框的一部分**——
 *   不挂在 dock 上是因为它与"当前这次对话"无关：它是这一页的属性，随页面渲染、随页面消失。
 *   **位置（2026-09-17 起）**：需求 ④ 的原话是"文章最上方"，落地时插槽曾渲染在 `<h1>`
 *   **之前**；用户看过之后要求挪到**标题下面**，故现在是"标题之后、正文之前"。
 *   插槽契约本身没变（宿主仍只传 `slug` / `title`），变的只是宿主里的挂载点。
 *
 *   **它为什么不能是零属性**：摘要属于**这一页**，而"当前是哪一页"的路由真源在宿主。
 *   与 `app-dock` 的 `page` 同一个理由（插件拿不到路由）。
 *
 *   **它与 `app-dock` 的次序差别值得记**：dock 需要"当前页"是为了**对话上下文**，
 *   而摘要位需要它是因为**它本身就是那一页的渲染结果**——后者在页面上只能出现一次，
 *   在列表页则压根不存在。
 * - `account-identities`：账号页的「外部身份（SSO）」区，由**提供者插件**贡献
 *   （当前是 `@geewiki/oidc`）。端点（`/api/auth/identities*`）是核心 auth 的机制，
 *   但界面属于"谁提供外部身份谁负责"——写死在宿主里会让没装提供者的部署看到一个
 *   讲企业 SSO 的空态（2026-09-16 用户指出）。
 *
 * 为什么后面这几个插槽也走"具名窄契约"而不是零属性：它们必须能读写宿主持有的状态
 * （选区 / 插入点 / 查询串 / 路由 / 当前页），而"宿主不向插件传数据"那条裁决针对的是
 * **任意宿主状态**，不是具名字段。零属性插槽的裁决对 header/footer 继续成立。
 */
export type BuiltinSlotName =
  | 'app-header'
  | 'app-footer'
  | 'editor'
  | 'editor-toolbar'
  | 'app-dock'
  | 'article-summary'
  | 'account-identities'

/**
 * **插件自定义插槽名**的语法。
 *
 * ## 为什么要求「至少一段 `/`」——这条不是风格，是判据
 * 内置插槽名（{@link BuiltinSlotName}）**一律不含 `/`**。于是：
 * - 含 `/` 且语法合法的名字 ⇒ 一定是插件自定义扩展点，永远不会与内置名碰撞；
 * - 不含 `/` 却不在 {@link SLOT_NAMES} 里 ⇒ **依然按"拼错了"拒绝并告警**
 *   （`app-headr` 不会被悄悄当成一个新插槽）。
 *
 * 若允许"任意字符串都是合法插槽名"，上面第二条判据就消失了：内置名的笔误不再有任何反馈，
 * 表现为"界面莫名其妙少了一块"。用 `/` 把两个命名空间切开，是这个设计里唯一一处
 * 让"开放键空间"与"拼写错误的可见性"同时成立的做法。
 */
export const PLUGIN_SLOT_NAME = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/

/** 内置插槽白名单（顺序即文档顺序）。名字非法/未声明时忽略并告警，不阻断激活。 */
export const SLOT_NAMES: readonly BuiltinSlotName[] = [
  'app-header',
  'app-footer',
  'editor',
  'editor-toolbar',
  'app-dock',
  'article-summary',
  'account-identities',
]

/** 是否内置插槽（编译期枚举的那 7 个）。 */
export function isBuiltinSlotName(name: unknown): name is BuiltinSlotName {
  return typeof name === 'string' && (SLOT_NAMES as readonly string[]).includes(name)
}

/** 是否**语法合法**的插件自定义插槽名（不校验它是否真的被某个插件声明过）。 */
export function isPluginSlotName(name: unknown): name is string {
  return typeof name === 'string' && PLUGIN_SLOT_NAME.test(name)
}

/**
 * 任意插槽标识 = 内置 ∪ 插件自定义。
 *
 * `(string & {})` 而不是裸 `string`：前者在 IDE 里**保留内置名字面量补全**，
 * 同时允许任意字符串通过编译（插件自定义名无法在编译期枚举）。
 *
 * 用在**不可信来源**（插件 bundle、REST 入参）的一侧；宿主自己的固定渲染点
 * 一律用 {@link BuiltinSlotName}，这样"宿主把插槽名写错"仍被编译器挡住。
 */
export type SlotName = BuiltinSlotName | (string & {})

/**
 * 插槽的**占用基数**：`multi` 允许多个插件同时贡献，`single` 全局同一时刻只生效一个。
 *
 * 为什么需要它：`editor` 是"同一时刻只能有一个"的资源（两个编辑器同时渲染没有意义），
 * 而 `app-header`/`app-footer` 天然可叠加（多个插件各挂一个小部件）。
 * 光靠插件级 `conflictGroup` **不足以**表达这件事：
 * - `conflictGroup` 是**整个插件**级互斥，而某插件可能只是"顺便"贡献了 editor
 *   （主体功能是别的）——此时要求它跟别的编辑器插件互斥，会连带禁掉它的主体功能；
 * - 若两个 active 插件都不在同组却都贡献 `editor`，宿主必须能**确定性地**裁决并**可见地**
 *   报告冲突，而不是静默随便挑一个。
 * 故：`conflictGroup` 是**声明式**推荐做法（把互斥意图写进 manifest），
 * 基数裁决是**兜底**（作者忘了声明时的确定性行为 + 显式诊断）。
 */
export const SLOT_CARDINALITY: Readonly<Record<BuiltinSlotName, 'single' | 'multi'>> = Object.freeze({
  'app-header': 'multi',
  'app-footer': 'multi',
  editor: 'single',
  'editor-toolbar': 'multi',
  // 常驻输入条：**两个同时存在不是丰富，是坏掉**——屏幕底部叠两条一模一样的输入框。
  // 与 `editor` 同属"单占用"，裁决规则也一样（按激活顺序最早者胜出）。
  'app-dock': 'single',
  // 摘要在同一页上出现两份同样是坏掉（同一段文字说两遍，且两份可能互相矛盾——
  // 它们来自两次不同的生成）。单占用在这里不只是"重复"，是**不一致**。
  'article-summary': 'single',
  // 外部身份：一个部署通常只接一个 IdP；但同一账号页上并列展示多个提供者的绑定入口
  // 也不矛盾（各自一行、各自解绑），故 `multi`——真要互斥应由插件自己声明 conflictGroup。
  'account-identities': 'multi',
})

/**
 * 一条**插件自定义扩展点**的声明（`slot.define()` 的产物）。
 *
 * 为什么需要显式的"声明"这一步：基数（`single` / `multi`）无法从名字推断，
 * 而它决定了裁决规则。默认 `multi`（绝大多数扩展点是"叠加"语义）；
 * 只有插件明确声明 `single` 才会走到"最早激活者胜出 + 冲突可见"那条路径。
 */
export interface SlotDeclaration {
  /** 声明者（插件名）。用于诊断："这个扩展点是谁开的"。 */
  readonly owner: string
  /** 占用基数，默认 `'multi'` */
  readonly cardinality: 'single' | 'multi'
  /** 面向人的说明（可选，管理台展示） */
  readonly description?: string
}

/**
 * 求某插槽的占用基数。
 *
 * 内置插槽取 {@link SLOT_CARDINALITY} 的固定表；插件自定义插槽取声明值，
 * **未声明即 `multi`**——"没说过要独占"按可叠加处理，是更安全的默认
 * （判错方向会把本来能共存的多个贡献抑制掉，且用户看不出原因）。
 */
export function slotCardinalityOf(
  slot: string,
  declared?: SlotDeclaration,
): 'single' | 'multi' {
  if (isBuiltinSlotName(slot)) return SLOT_CARDINALITY[slot]
  return declared?.cardinality ?? 'multi'
}

/* ===================== ★ 优化点 8：插槽 props 的自助描述 ===================== */

/**
 * 单个插槽属性的**自助描述**。
 *
 * 存在理由：外部插件是**裸 JS**（见 `plugins/hello-geewiki/index.ts` 的模板风格，
 * TS 类型在那里"只作注释"），作者手上没有 `EditorSlotProps` 这类类型可查，
 * 于是"我这个插槽会收到什么属性"只能靠读宿主源码——这是插件平台最低的一道门槛。
 *
 * 本描述经 `GET /api/plugins/slots` 的 `props` 字段下发，作者无需引 TS 即可自助。
 */
export interface SlotPropSpec {
  readonly name: string
  /**
   * 类型的**人类可读形态**（如 `string`、`'create' | 'edit'`、`readonly string[]`）。
   *
   * ⚠️ 这**不是** JSON Schema 的 `type` 关键字，本结构也**不是** JSON Schema。理由：
   * 这些插槽的 props 里有**回调**（`onSave` / `onUploadFiles` / `openPage` …），
   * 而 JSON Schema 根本表达不了函数类型。硬套一层 JSON Schema 只会得到一份
   * "看起来标准、实际缺一半"的契约——比一份诚实的自定义描述更坏。
   * 需要精确类型时，请按 {@link SlotPropsSpec.contract} 去读那个权威接口。
   */
  readonly type: string
  /** 省略即**必填**（与 TS 的 `?:` 同向） */
  readonly optional?: boolean
  readonly description: string
}

/** 一个内置插槽的 props 全貌 */
export interface SlotPropsSpec {
  /** 该插槽的插件组件**不接收任何属性**（宿主只负责把它渲染出来） */
  readonly zeroProps: boolean
  /**
   * props 契约的**权威 TS 接口**及其所在文件（相对仓库根）。
   *
   * 这是本描述的"最终解释权"所在：描述给人快速上手，**冲突时以接口为准**。
   * 同时也是守卫的锚点——`packages/core/test/slot-props-schema.test.ts` 会按它
   * 把接口的**顶层字段名与可选性**逐条比对，任何一侧漂移都会当场变红。
   */
  readonly contract?: { readonly interface: string; readonly file: string }
  readonly props: readonly SlotPropSpec[]
}

/**
 * 内置插槽的 props 描述表（★ 优化点 8）。
 *
 * ## 为什么它住在 `slots.ts` 而不是 `index.ts`
 * 与白名单/基数的理由完全相同：这里必须**浏览器安全**（零 `node:*` / 零 cordis），
 * 否则 web 侧要么抄一份镜像、要么进不了 bundle。放在这里，宿主可以把同一份事实
 * 既下发给外部插件，又给管理台渲染。
 *
 * ## 为什么它需要守卫（而不是"记得同步"）
 * 本项天然是一份**派生描述**，会随接口演进而过期。§4 优化点 1 的教训就是
 * "同一事实的多份表示靠纪律同步必然漂移"——所以这里配了一条源码级守卫
 * （`packages/core/test/slot-props-schema.test.ts`），把"记得同步"变成"不同步就红"。
 */
export const SLOT_PROPS_SCHEMA: Readonly<Record<BuiltinSlotName, SlotPropsSpec>> = Object.freeze({
  // 两个页眉/页脚插槽是**零属性**的：它们只表达"这里有个位置"，没有任何上下文可传。
  // 零属性是**有意的窄契约**，不是"还没设计"——见 slots.tsx 的 ZeroPropsSlotName。
  'app-header': { zeroProps: true, props: [] },
  'app-footer': { zeroProps: true, props: [] },
  editor: {
    zeroProps: false,
    contract: { interface: 'EditorSlotProps', file: 'packages/core/src/index.ts' },
    props: [
      { name: 'value', type: 'string', description: '当前正文（受控值）' },
      { name: 'mode', type: "'create' | 'edit'", description: '新建态还是编辑既有页面' },
      { name: 'slug', type: 'string', description: '当前页面的 slug（新建态下可能是占位值）' },
      { name: 'readOnly', type: 'boolean', optional: true, description: '只读展示；插件编辑器应禁用输入而非忽略它' },
      { name: 'onChange', type: '(value: string) => void', description: '正文变更回写；不调用则宿主读不到内容' },
      { name: 'onSave', type: '() => void', description: '请求保存当前正文' },
      { name: 'onCancel', type: '() => void', description: '放弃编辑并返回' },
      {
        name: 'onUploadFiles',
        type: '(files: File[]) => Promise<string[]>',
        optional: true,
        description:
          '★ F5：附件上传。缺省 = 宿主**不支持**该编辑器上传（宿主会同时关掉它自己的拖放/粘贴拦截），不是"传了也白传"',
      },
      {
        name: 'blockTiers',
        type: '{ readonly pageVisibility: PageVisibility | null } | null',
        optional: true,
        description: '★ F5：当前页面的可见性档位，供编辑器展示/联动段落授权；缺省 = 无此信息',
      },
      {
        name: 'onManageBlockGrants',
        type: '(block: { readonly ordinal: number; readonly excerpt: string }) => void',
        optional: true,
        description: '★ F5：请求打开某段的授权管理',
      },
      {
        name: 'onSelectionChange',
        type: '(selection: EditorToolbarSelection | null) => void',
        optional: true,
        description: '★ F5：上报选区（驱动 editor-toolbar）；null = 无选区',
      },
      {
        name: 'onEditorHandle',
        type: '(handle: EditorHandle | null) => void',
        optional: true,
        description: '★ F5：交出命令式句柄（insertAtCursor / replaceSelection / setDoc），宿主据此驱动工具栏与 AI 回退',
      },
    ],
  },
  'editor-toolbar': {
    zeroProps: false,
    contract: { interface: 'EditorToolbarSlotProps', file: 'packages/core/src/index.ts' },
    props: [
      { name: 'mode', type: "'create' | 'edit'", description: '与 EditorSlotProps.mode 同义' },
      { name: 'slug', type: 'string', description: '当前页面 slug' },
      { name: 'docText', type: 'string', description: '当前正文纯文本（供预览/统计）' },
      {
        name: 'selection',
        type: 'EditorToolbarSelection | null',
        description: '当前选区（0 基字符偏移）；null = 无选区或编辑器未上报',
      },
      { name: 'readOnly', type: 'boolean', optional: true, description: '只读态' },
      {
        name: 'insertAtCursor',
        type: '(text: string) => void',
        optional: true,
        description: '在光标处插入；**缺省 = 编辑器未实现写回**，此时请隐藏"插入"类工具而不是调用空函数',
      },
      {
        name: 'replaceSelection',
        type: '(text: string) => boolean',
        optional: true,
        description: '替换当前选区，返回是否成功；缺省同上',
      },
    ],
  },
  'app-dock': {
    zeroProps: false,
    contract: { interface: 'AppDockSlotProps', file: 'packages/core/src/index.ts' },
    props: [
      {
        name: 'page',
        type: '{ readonly slug: string; readonly kind: "view" | "edit" }',
        description: '当前页面上下文：slug + 处于阅读态还是编辑态',
      },
      { name: 'clientTools', type: 'readonly string[]', description: '宿主登记在客户端可用的工具名清单' },
      { name: 'userId', type: 'number | null', description: '当前用户 id；null = 匿名' },
      { name: 'openPage', type: '(slug: string) => void', description: '要求宿主跳转到某页面' },
      { name: 'invokeTool', type: '(name: string, args: unknown) => Promise<unknown>', description: '调用宿主登记的工具' },
    ],
  },
  'article-summary': {
    zeroProps: false,
    contract: { interface: 'ArticleSummarySlotProps', file: 'packages/core/src/index.ts' },
    props: [
      { name: 'slug', type: 'string', description: '当前文章 slug（摘要插件据此取正文）' },
      { name: 'title', type: 'string', description: '当前文章标题' },
    ],
  },
  'account-identities': {
    zeroProps: false,
    // ⚠️ 这一项的契约**不在 core**：它是唯一"前端包是真源"的带 props 插槽，
    // 因此 contract 指向 slots.tsx。这是既有的不对称，如实记录而不是假装统一。
    contract: { interface: 'AccountIdentitiesSlotProps', file: 'packages/web/src/lib/slots.tsx' },
    props: [{ name: 'linkPending', type: 'boolean', optional: true, description: '外部身份绑定流程进行中（用于禁用重复点击）' }],
  },
})
