/**
 * 端点地址拼接（单独成模块：`provider.ts` 与 `probe.ts` 都要用，
 * 放任何一方都会造成两者互相 import 的环）。
 */

/** 把端点根地址与路径拼起来（容忍尾斜杠） */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return `${base}${path}`
}
