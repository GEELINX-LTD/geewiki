/**
 * 模型可用性的**统一投影**。
 *
 * ## 为什么在 `@geewiki/llm`
 * 「有没有能用的模型」这件事只有本包答得准（注册表、`available()`、恒不可用的兜底路由
 * 都在它手里）。原先这份逻辑长在 `@geewiki/ai` 内部（`safeProviders` / `safeAvailable` /
 * `preGenerationDegraded` 三个局部函数）；本批把 AI 拆成辅助写作与问答两个插件后，
 * 两处都要用同一份判据——各写一份的后果是两个界面对"模型到底可用不可用"给出不同答案，
 * 而那正是用户感知最强的那句提示。
 *
 * ## 两条来自既有实现的纪律
 * 1. `available()` / `availableProviders()` **抛错不得拖垮状态投影**：一律视为不可用
 *    （与 llm-service 内部口径一致）。一个坏适配器不该让能力查询 500。
 * 2. 生成前的"必然降级"判定与真正跑完生成后的结论**必须一致**：`availableProviders()` 为空时
 *    选路必然产出 `NO_ADAPTER`，故 {@link noModelDegraded} 可以提前给出同样的 code/reason。
 */
import { degradedFromCode, makeDegraded, type Degraded } from './degrade.js'
import { redact } from './redact.js'
import type { LlmRouteDescriptor, LlmService } from './types.js'

/** 一条模型路由的对外描述（与各 AI 插件 `capabilities` 端点里的元素逐字段一致） */
export interface ModelRouteInfo {
  route: string
  label: string
  vendor: string
  model: string
  available: boolean
}

/**
 * 外发前的脱敏：`makeDegraded` 是 `redact` 在降级链路上的出口，但 `capabilities` **不走降级**，
 * 它直接把 descriptor 的字段抄给调用方——于是那条"唯一出口"的纪律在这里本来是不成立的。
 *
 * 为什么必须在**这里**堵住（而不是在各插件的端点里）：
 * - 这些 descriptor 的 `label`/`model` **不是静态字面量**。`@geewiki/openai` 的 `model` 是
 *   对用户设置的**实时 getter**（`plugin-openai/src/provider.ts`），也就是说这里外发的
 *   是**管理员在后台填进去的字符串**；
 * - 两个 `capabilities` 端点目前是 `access: 'public'`（注册时用的是三参形式 ⇒ 默认 public），
 *   未登录即可读 ⇒ 匿名请求方在镜像管理台配置；
 * - 只要有任何一个适配器把 `label` 取自用户可配的 baseUrl，而那个 URL 里带 basic-auth
 *   （`https://user:sk-xxx@gateway/…` 是能工作的写法），密钥就会**匿名**出现在响应里。
 * 现在这份列表整体经 `redact`：正常的模型名/厂商名逐字不变（脱敏只吃形似密钥的片段），
 * 形似密钥的部分变成 `***`。
 */
function safeText(value: string): string {
  return redact(value)
}

/** `available()` 抛错 ⇒ 视为不可用（不抛） */
export function safeAvailable(available: (() => boolean) | undefined): boolean {
  try {
    return available?.() === true
  } catch {
    return false
  }
}

/** 全部已注册路由（含不可用者）→ 可安全外发的描述列表 */
export function listRouteInfos(llm: LlmService | undefined): ModelRouteInfo[] {
  let routes: readonly LlmRouteDescriptor[]
  try {
    routes = llm?.listProviders() ?? []
  } catch {
    return []
  }
  // `available()` 也包一层：descriptor 的 getter 可能抛（`safeAvailable` 已处理）
  return routes.map((d) => ({
    route: safeText(String(d.route ?? '')),
    label: safeText(String(d.label ?? '')),
    vendor: safeText(String(d.vendor ?? '')),
    model: safeText(String(d.model ?? '')),
    available: safeAvailable(() => d.available()),
  }))
}

/** 是否存在可用路由（`availableProviders()` 抛错视为没有） */
export function hasAvailableModel(llm: LlmService | undefined): boolean {
  try {
    return (llm?.availableProviders()?.length ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * 生成前的"必然降级"投影；**可用时返回 null**。
 *
 * @param tail 追加到 message 末尾的说明（各插件的下游语义不同：问答会说"检索结果不受影响"，
 *             辅助写作没有检索可说）
 */
export function noModelDegraded(llm: LlmService | undefined, tail = ''): Degraded | null {
  if (!llm) {
    return makeDegraded('no_provider', null, 'llm-service 不可用（@geewiki/llm 未激活）' + tail)
  }
  if (hasAvailableModel(llm)) return null
  const routes = listRouteInfos(llm)
  const hint =
    routes.length === 0
      ? '当前没有已注册的模型路由'
      : `已注册 ${routes.length} 个路由但均不可用：${routes.map((r) => `${r.label}(${r.route})`).join('、')}`
  return degradedFromCode('NO_ADAPTER', `模型不可用（NO_ADAPTER）：${hint}${tail}`)
}
