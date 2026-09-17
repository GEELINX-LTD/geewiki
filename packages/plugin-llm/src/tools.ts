/**
 * 工具调用（function calling）的类型与**唯一一份拼装实现**。
 *
 * 为什么要单列一个文件：`types.ts` 是"统一配置 + 降级 + 密钥安全"的契约面，
 * 而工具调用是另一件事（模型产出的结构化动作），且它有一份**必须只有一处**的
 * 拼装逻辑（见 {@link assembleToolCalls}）——放在同一个文件里会让两者互相淹没。
 *
 * 三条设计口径：
 * 1. **不替服务端补默认值**。`toolChoice` 不填就是**不下发** `tool_choice`，
 *    与 `temperature` 同一条理由（见 `types.ts` 的 `LlmRequest`）。
 * 2. **arguments 是原样文本，不是解析后的对象**。模型产出的 JSON 可能是坏的、
 *    可能被长度截断；在本层解析等于把一个"上游给了半截东西"的事实
 *    变成一次含糊的抛错。解析是**调用方**的事，而且调用方必须自己处理坏 JSON。
 * 3. **本层不校验 `parameters` 是不是合法 JSON Schema**。它是调用方（工具提供者）
 *    自己写的，校验器属于工具注册表那一层。
 */

/*
 * ★ F3：工具调用的**类型**已下沉到 `@geewiki/core`（真源 `packages/core/src/llm.ts`）。
 * 这里只转出类型；`assembleToolCalls` 是**运行期**实现，留在本包。
 */
export type { LlmToolCall, LlmToolCallDelta, LlmToolChoice, LlmToolDef } from '@geewiki/core'
import type { LlmToolCall, LlmToolCallDelta } from '@geewiki/core'

/**
 * 把流式片段拼装成完整调用。
 *
 * **本函数是拼装逻辑的唯一实现**：每个消费者自己写一遍 `acc[index].args += …` 时，
 * "首帧的 id/name 要不要覆盖后续帧"「空片段算不算」这类细节必然漂移，
 * 而漂移的表现是"偶尔把工具结果配错调用"——不报错、只是答案变怪。
 *
 * 两条具体口径：
 * - `id` / `name` **取首个非空值**，不是"首个片段的值"：上游常把 id 放在首帧、
 *   而首帧的 `arguments` 是空串；但也见过 id 出现在第二帧的形态。用"非空"判据两种都对。
 * - **丢掉没有 name 的调用**：没有名字的调用无法执行，也无法向模型解释。
 *   宁可少一个（调用方会发现模型说了要调工具却没有可执行的调用），也不给一个空名字的壳。
 *
 * 坏 JSON / 被截断的 arguments **原样保留**：本函数不做解析，
 * "这次调用能不能用"由调用方在 `JSON.parse` 失败时决定。
 */
export function assembleToolCalls(deltas: readonly LlmToolCallDelta[]): readonly LlmToolCall[] {
  const byIndex = new Map<number, { id: string; name: string; args: string }>()
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) && delta.index >= 0 ? delta.index : 0
    let slot = byIndex.get(index)
    if (slot === undefined) {
      slot = { id: '', name: '', args: '' }
      byIndex.set(index, slot)
    }
    if (slot.id === '' && typeof delta.id === 'string' && delta.id !== '') slot.id = delta.id
    if (slot.name === '' && typeof delta.name === 'string' && delta.name !== '') slot.name = delta.name
    if (typeof delta.argumentsDelta === 'string') slot.args += delta.argumentsDelta
  }
  return [...byIndex.entries()]
    // 按 index 升序：模型产出调用的顺序就是 index 顺序，执行顺序应与之相同
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => ({ id: slot.id, name: slot.name, arguments: slot.args }))
    .filter((call) => call.name !== '')
}
