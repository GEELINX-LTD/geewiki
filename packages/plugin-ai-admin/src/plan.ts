/**
 * `@geewiki/ai-admin` 的**纯函数核心**：参数校验、状态快照的编解码、护栏判据。
 *
 * 这个文件里没有一行 IO，理由与 `@geewiki/ai-journal` 的 `plan.ts` 同源：
 * 这里每一个判断错了都**不会报错**，只会让 AI 改错东西——
 * 停掉一个不该停的插件、把配置写成一个"看起来对"的残缺对象、
 * 或者让一条本该可回退的变更**记不下来**。所以判据必须住在能被单测逐条钉死的地方。
 */
import type { Principal } from '@geewiki/core'

/* ============================== 权限判据 ============================== */

/**
 * 管理台能力的判据：**与管理器 REST 路由的 `access: 'admin'` 同一条**。
 *
 * 刻意与 `packages/manager/src/index.ts` 的 `mayReadPluginConfig()` 写成同一个形状
 * （`break-glass` 直通，其余看 `orgRole`）：两条判据漂移的表现是
 * "AI 能改、但用户自己在管理台上看不到"（或反过来），而两者都不会报错。
 *
 * ⚠️ 它同时用在**两处**：`available`（把无权的能力挡在模型的工具表之外）
 * 与执行体（真调了也不放行）——这不是重复，见 `AiToolDescriptor.available` 的注释。
 */
export function isAdminPrincipal(p: Principal): boolean {
  if (p.kind === 'break-glass') return true
  return p.orgRole === 'owner' || p.orgRole === 'admin'
}

/* ============================== 参数解析 ============================== */

/** 工具参数来自**模型**（外部输入），一律先校验再用——`parse*` 返回字符串即"拒绝的理由" */
export function parseName(args: unknown): string | { readonly error: string } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { error: '参数必须是 JSON 对象' }
  const raw = (args as Record<string, unknown>)['name']
  if (typeof raw !== 'string' || raw.trim() === '') return { error: 'name 必须是非空字符串（插件包名，如 @geewiki/echo）' }
  const name = raw.trim()
  if (name.length > 200) return { error: 'name 过长' }
  return name
}

export function parseSetEnabled(args: unknown): { name: string; enabled: boolean } | { readonly error: string } {
  const name = parseName(args)
  if (typeof name !== 'string') return name
  const raw = (args as Record<string, unknown>)['enabled']
  /*
   * `enabled` **必须显式给**，不默认成 true：默认值在这里是有害的——
   * 模型漏了这个字段时，"默认启用"与"默认停用"都是我们替它猜的，
   * 而猜错的方向分别是"意外拉起一个插件"和"意外停掉一个插件"。
   */
  if (typeof raw !== 'boolean') return { error: 'enabled 必须是布尔值（true=启用，false=停用），不能省略' }
  return { name, enabled: raw }
}

export function parseSetConfig(
  args: unknown,
): { name: string; config: Record<string, unknown> } | { readonly error: string } {
  const name = parseName(args)
  if (typeof name !== 'string') return name
  const raw = (args as Record<string, unknown>)['config']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'config 必须是一个 JSON 对象（**完整**的新配置，不是补丁——先读一次再改）' }
  }
  const config = raw as Record<string, unknown>
  /*
   * 密钥字段的**值**不该经这里进来（见 `role: 'secret'` 的口径：只报有无、不回显）。
   * 这里不做拦截（管理器自己会 `absorbSecrets` 落到 secrets.json），
   * 但把这个事实写下来：模型在 `plugin.read_config` 里永远看不到密钥的原值，
   * 于是它也不可能"顺手把密钥原样写回去"——那条路本来就不通。
   */
  return { name, config }
}

/* ============================== 状态快照 ============================== */

/**
 * 一条可回退的插件状态快照。
 *
 * **为什么要有这个联合而不是直接存裸值**：mutation journal 的 `before` / `after`
 * 是**文本快照**，而"把插件变回去"对两种变更的形态完全不同——
 * 启停要的是一个布尔，改配置要的是整份配置。回退执行体拿到一段文本时，
 * 必须能**确定**它描述的是哪一种；靠"猜它像 JSON 对象还是像 true"迟早在
 * `config` 恰好是个布尔形状时出错，而那时错误会静默地作用到错误的操作上。
 *
 * 编码里带 `kind` 判别位，这件事就变成可判定的。
 */
export type PluginStateSnapshot =
  | { readonly kind: 'enabled'; readonly value: boolean }
  | { readonly kind: 'config'; readonly value: Record<string, unknown> }

export function encodePluginState(snapshot: PluginStateSnapshot): string {
  return JSON.stringify(snapshot)
}

/** 解不出来一律回 `null`（**不抛**：它来自数据库，可能是上一版代码写的、也可能被手改过） */
export function decodePluginState(text: string | null): PluginStateSnapshot | null {
  if (text === null || text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (o['kind'] === 'enabled' && typeof o['value'] === 'boolean') {
    return { kind: 'enabled', value: o['value'] }
  }
  if (o['kind'] === 'config' && o['value'] !== null && typeof o['value'] === 'object' && !Array.isArray(o['value'])) {
    return { kind: 'config', value: o['value'] as Record<string, unknown> }
  }
  return null
}

/* ============================== 管理器错误的翻译 ============================== */

/**
 * 管理器抛出的 `ManagerError` 带着机器可读的 `code`，但**它的 message 是写给管理台的**
 * （"请编辑基础层清单 plugins.base.json 后重启进程"）。工具结果直接进模型上下文，
 * 模型需要的是"**我该改做什么**"，而不是一段面向运维的指引。
 *
 * 这里把 code 翻成模型能据以改主意的一句话；**认不出的 code 原样透出**
 * （编一个"友好的"说法会让真正的故障变得不可诊断——`ManagerError` 会新增 code，
 * 而这份映射表不会同时更新）。
 */
export function refusalForCode(code: string, message: string, name: string): string {
  switch (code) {
    case 'base_layer':
      /*
       * 措辞必须是"**停用**"，不能连"改配置"一起说：管理器只在 `disable()` 上抛这个码，
       * `updateConfig()` 对基础层插件是**允许**的（它热更新 + 落盘到 base 清单）。
       * 一句笼统的"不能停用或改配置"会把模型引到错误的结论上——
       * 它于是再也不会去改一个其实改得动的配置。
       */
      return (
        `${name} 属于**基础层**，不能通过 AI 停用——基础层的启停要改 ` +
        '`config/plugins.base.json` 并重启进程，请让管理员在管理台上手动操作。'
      )
    case 'has_dependents':
      return `${name} 还有别的插件在依赖它，停用会让那些插件一起下线。请先处理依赖方（或改用同冲突组的替换），本次**没有改动任何东西**。`
    case 'not_active':
      return `${name} 当前本来就没有启用，无需停用。`
    case 'not_found':
    case 'unknown_plugin':
      return `没有找到名为 ${name} 的插件。先用 plugin.list 看看实际有哪些（名字是包名，如 @geewiki/echo）。`
    case 'invalid_config':
      return `这份配置没有通过 ${name} 的校验：${message}。本次**没有改动任何东西**，请把参数改对后重试。`
    default:
      return `${name} 的操作失败（${code}）：${message}`
  }
}

/** 从任意抛错里取出管理器的 code（不是 `ManagerError` 时回 null） */
export function managerCodeOf(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** 拒绝时必须让模型看到的那句话（它决定了模型下一轮是重试还是改道） */
export const NOTHING_CHANGED = '本次**没有改动任何东西**。'

/**
 * 给一句拒绝补上"没有改动任何东西"。
 *
 * **幂等**：`refusalForCode` 里有几条已经自己写了这句话（`has_dependents` / `invalid_config`），
 * 而调用方不该知道哪几条写了、哪几条没写——那是一条必然漂移的隐性契约
 * （新加一个 code 时不会有人记得补这句话，而漏了它的后果是模型以为改动生效了，
 * 于是它要么重复尝试、要么去描述一个并不存在的状态）。
 * 所以这里统一补，且只在缺席时补。
 */
export function nothingChanged(text: string): string {
  return text.includes(NOTHING_CHANGED) ? text : `${text}${NOTHING_CHANGED}`
}
