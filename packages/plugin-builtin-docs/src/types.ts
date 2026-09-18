/**
 * `@geewiki/builtin-docs` 的常量、配置 schema 与对外形状。
 *
 * 与仓库其它插件同一条约定：测试专用注入口不进 `configSchema`；配置面每一项都要
 * 回答得出"什么时候该改它"。
 */
import Schema from 'schemastery'

/* ============================== 名字与版本 ============================== */

/**
 * manifest 名以**字面量**写（`src/index.ts`），这里是日志前缀与工具外的第二处引用。
 * 见 `@geewiki/ai-summary` 里关于"守卫测试直接读源码比对"的说明——同一条理由。
 */
export const PLUGIN_NAME = '@geewiki/builtin-docs'

/**
 * 文档正文的**同步版本号**。
 *
 * 部署时与库里的戳记（`builtin_docs_state['docs_version']`）比对：不等才同步。
 * ★ 改了 `content/*.md`（或 `catalog.ts` 的 slug/标题登记表）里任何一篇，**必须 bump 这里**——
 * 否则新正文永远不会写进已部署的库（比对只看这个数字，不看内容，见 index.ts 同步引擎）。
 * 用日期式整数（`20260731` 风格）而不是语义版本：它不参与任何比较语义，
 * 只是一个"变没变"的戳，日期还能让人一眼看出文档上次随项目更新是什么时候。
 */
export const DOCS_VERSION = 20260918

/** 状态表里版本戳的 key */
export const STATE_KEY_VERSION = 'docs_version'
/** 记账行的前缀：`page:<slug>` 存在 ⇔ 这一页是本插件创建的（保护与删除的权威判据） */
export const STATE_KEY_PAGE_PREFIX = 'page:'

/* ============================== 配置 ============================== */

/**
 * 配置面只有一项。
 *
 * `hidden` 是唯一有真实使用者的开关（"想隐藏这批文档的人"——需求原文）。
 * 文档可见性（public + 发布）**刻意不做配置项**：文档的存在意义就是被读，
 * 含匿名读者；给一个没人会调、调错的后果是"文档对所有人消失"（发布闸门）的开关，
 * 是配置面膨胀而不是灵活性。
 */
export const BuiltinDocsConfigSchema = Schema.object({
  /**
   * 隐藏全部内置文档：策略层对**所有主体**（含 owner）判定 `level='none'` ⇒
   * 列表、检索、阅读页一律视同不存在。关掉即恢复，页面本体从未被删。
   */
  hidden: Schema.boolean().default(false),
})
export type BuiltinDocsConfig = ReturnType<typeof BuiltinDocsConfigSchema>

/* ============================== 文档目录 ============================== */

/** 一篇内置文档（写入 `wiki-service.save` 的输入形状） */
export interface BuiltinDoc {
  /** 合法 slug（`content.test.ts` 逐条钉住，撞保留段直接红） */
  slug: string
  title: string
  content: string
}

/* ============================== 对外服务形状 ============================== */

/**
 * `builtin-docs-service`：`@geewiki/authz` 的**结构化消费面**（它刻意不 import 本包）。
 *
 * - `isManagedPage`：以**记账表**为准，不是目录清单——slug 撞名时用户的同名页面
 *   未被接管，判据必须是"确实是我们建的"；
 * - `isHidden`：当前配置的隐藏开关。
 *
 * 两个方法都要求**同步且廉价**（策略层每次判定都会调用）。实现是内存 Set + 布尔闭包，
 * 记账表只在激活与同步时读一次。
 */
export interface BuiltinDocsService {
  isManagedPage(slug: string): boolean
  isHidden(): boolean
}
