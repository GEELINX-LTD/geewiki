/**
 * `llm-service` 的**每 ctx 单例**（含"现读"设置与密钥引用）。
 *
 * 为什么必须是单例 —— 这是本批实测出来的一个真实缺陷：
 * cordis 的 `fork.update(config)`（管理台"保存配置"走的路径）语义是 **dispose + 重新 apply**。
 * 若每次 apply 都 `createLlmService()` 新建一个注册表，那么"在管理台改了模型配置"之后：
 * 1. 新服务实例里**一条适配器路由都没有**（适配器插件不会被连带重启，它把路由注册在旧实例上）；
 * 2. 管理台于是显示"服务商列表为空"，而插件状态仍然是 active ——
 *    一个"看起来都正常、实际全不可用"的分裂态。
 *
 * 实测证据（隔离端口上的冒烟）：`PUT /api/plugins/@geewiki%2Fllm/config` 返回
 * `hotUpdated: true`，随后 `GET /api/llm/providers` 的 `providers` 变成空数组，
 * 而 `GET /api/plugins` 里 `@geewiki/openai` 仍是 active。
 *
 * 解法：把**注册表实例**与"设置/密钥的现读引用"一起挂在 ctx 上（WeakMap，不污染 ctx 对象），
 * 每次 apply 只**就地更新引用**，服务实例本身不变。由此：
 * - 适配器注册的路由跨配置更新存活；
 * - 适配器经 `settings()` / `resolveApiKey()` 现读到的是**新**配置（它们本来就是现读函数）；
 * - 卸载时（真卸载，不是 update）由 disposer 注销自己的路由与内置兜底路由，
 *   注册表干干净净，下次启用沿用同一实例即可。
 */
import type { Context } from 'cordis'
import type { CredentialResult } from './credentials.js'
import { FALLBACK_SETTINGS, createLlmService } from './service.js'
import type { LlmCredentialSource, LlmService, LlmSettings } from './types.js'

/** 密钥解析器（`createApiKeyResolver` 的返回值形状） */
export interface ApiKeyResolver {
  resolve: () => CredentialResult
  source: () => LlmCredentialSource
}

/** 每 ctx 的 llm 运行期状态 */
export interface LlmState {
  /** 注册表实例：跨 `fork.update` 存活 */
  readonly service: LlmService
  /** 现读设置的引用（每次 apply 就地替换 `current`） */
  readonly settingsRef: { current: LlmSettings }
  /** 现读密钥解析器的引用（每次 apply 就地替换） */
  readonly apiKeyRef: { current: ApiKeyResolver }
  /**
   * 内置兜底路由的注销函数（`null` = 未注册）。
   *
   * 需要这本账的原因：`fork.update` 会先 dispose 再 apply，无条件 `register()` 会撞上
   * 契约的"重复 route 必须抛错"；而注册表实例是**跨 update 存活**的，所以谁注册的必须谁注销。
   */
  nullRouteUnregister: (() => void) | null
}

/** ctx → 状态（WeakMap：不往 ctx 对象上挂属性，ctx 回收后自动释放） */
const STATES = new WeakMap<object, LlmState>()

/** 取（或首次创建）该 ctx 的 llm 状态。创建时闭包只读引用，故后续就地替换即生效。 */
export function ensureLlmState(ctx: Context): LlmState {
  const key = ctx as unknown as object
  const existing = STATES.get(key)
  if (existing) return existing

  const settingsRef: { current: LlmSettings } = { current: FALLBACK_SETTINGS }
  const apiKeyRef: { current: ApiKeyResolver } = {
    current: {
      resolve: () => ({ ok: false, code: 'MISSING_CREDENTIAL' }),
      source: () => 'none',
    },
  }
  const service = createLlmService({
    settings: () => settingsRef.current,
    resolveApiKey: () => apiKeyRef.current.resolve(),
    credentialSource: () => apiKeyRef.current.source(),
  })
  const state: LlmState = { service, settingsRef, apiKeyRef, nullRouteUnregister: null }
  STATES.set(key, state)
  return state
}
