/** 显式 UI 入口的结算等待；模块导入不在此处，Promise 本身也不会被取消。 */
export const PLUGIN_UI_ENTRY_TIMEOUT_MS = 15_000

export class PluginUiEntryTimeoutError extends Error {
  constructor() {
    super('插件界面入口等待超过 15 秒，已回收注册；请检查初始化或重新启用插件。')
    this.name = 'PluginUiEntryTimeoutError'
  }
}

/**
 * 上限或卸载只结束宿主等待；继续消费原 Promise 的结算，避免迟到拒绝变成未处理异常。
 * 每条出口都清掉计时器和 abort 监听，abort 发生在调用前也不能漏接原 Promise 的拒绝。
 */
export function awaitPluginUiEntry<T>(
  entry: Promise<T>,
  signal: AbortSignal,
  timeoutMs = PLUGIN_UI_ENTRY_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      complete()
    }
    const abort = (): void => finish(() => reject(new DOMException('插件界面加载已撤销', 'AbortError')))
    // 先接成功和拒绝，再检查已经撤销的 signal；迟到结果不会产生额外的拒绝链。
    entry.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
    if (signal.aborted) abort()
    else {
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(() => reject(new PluginUiEntryTimeoutError())), timeoutMs)
    }
  })
}
