/** 以真实运行期注册表核对已经生效的界面声明；不维护注册调用的副本。 */
import { slotContributors } from './slots'
import { registeredRoute } from './routes'
import type { SlotName, SuppressedOwners, UiTableEntry } from './pluginUiPlan'

export interface PluginUiRegistrationMismatch {
  readonly name: string
  readonly slots: readonly string[]
  readonly extNodes: readonly string[]
  readonly routes: readonly string[]
}

/** 调用方只传已经完成加载、版本仍对应的入口；未加载与等待中的入口不参与。 */
export function diagnosePluginUiRegistration(
  name: string,
  meta: UiTableEntry,
  suppressed: SuppressedOwners,
): PluginUiRegistrationMismatch | undefined {
  const missingNode = (node: SlotName): boolean =>
    suppressed.get(node)?.has(name) !== true && !slotContributors(node).includes(name)
  const slots = (meta.slots ?? []).filter(missingNode)
  const extNodes = (meta.extNodes ?? []).filter(missingNode)
  const routes = (meta.routes ?? []).filter(route => registeredRoute(route.id)?.source !== name).map(route => route.id)
  return slots.length + extNodes.length + routes.length > 0 ? { name, slots, extNodes, routes } : undefined
}
