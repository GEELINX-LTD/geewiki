/**
 * 主题（浅色 / 深色 / 跟随系统）
 * ============================================================================
 *
 * 三态而非两态：`system` 是**默认**，此时跟随 `prefers-color-scheme`（用户没表态就
 * 尊重操作系统设置——这是 Docusaurus / VitePress 等参考实现的默认行为）；
 * `light` / `dark` 是用户的显式选择，持久化到 localStorage。
 *
 * **避免白闪（FOUC）的关键**：本模块只负责"读取与切换"，首帧的**应用**必须由
 * `index.html` 里的**内联同步脚本**完成——React 要等 bundle 下载执行后才渲染，
 * 那时用户已经看到一帧白底了。内联脚本在 `<head>` 里同步执行，早于任何绘制。
 * 因此这里的 `readStoredTheme()` 与内联脚本读的是**同一个 key**，
 * 且有单测钉住两者一致（见 `test/designSystem.test.ts`——**不是** `test/theme.test.ts`，
 * 后者从来不存在，本注释与 index.html 的同类说明曾长期指向一个不存在的文件）。
 *
 * 存储键名改动会同时影响内联脚本与这里——两处必须同步（单测覆盖）。
 */
import { useCallback, useEffect, useState } from 'react'

/** localStorage 键名（与 index.html 内联脚本中的字面量必须一致） */
export const THEME_STORAGE_KEY = 'geewiki-theme'

export type ThemeChoice = 'system' | 'light' | 'dark'
/** 实际生效的外观（system 已被解析） */
export type ResolvedTheme = 'light' | 'dark'

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** 读取用户选择；无存储/值非法/存储被禁用（隐私模式）时回退 system */
export function readStoredTheme(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeChoice(raw) ? raw : 'system'
  } catch {
    // Safari 隐私模式等场景下 localStorage 可能抛异常——不影响功能，回退默认
    return 'system'
  }
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    /* 存不下就算了：本次会话仍然生效，只是刷新后回到系统偏好 */
  }
}

/** 把选择落到 `<html>` 的 class 上（CSS 的 `.dark` / `.light` 分支据此生效） */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  if (choice !== 'system') root.classList.add(choice)
  // 让浏览器原生控件（滚动条、表单控件）也跟着切换
  root.style.colorScheme = choice === 'system' ? '' : choice
}

/** 解析 system → 实际外观 */
export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== 'system') return choice
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export interface UseThemeResult {
  /** 用户的选择（含 system） */
  choice: ThemeChoice
  /** 当前实际外观 */
  resolved: ResolvedTheme
  setChoice: (next: ThemeChoice) => void
  /** 在 浅 ↔ 深 之间切换（把 system 视为其当前解析值，切到相反的一侧） */
  toggle: () => void
}

export function useTheme(): UseThemeResult {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStoredTheme())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredTheme()))

  // 选择变化 → 落盘 + 应用 + 重算实际外观
  useEffect(() => {
    applyTheme(choice)
    setResolved(resolveTheme(choice))
  }, [choice])

  // 仅在 system 模式下跟随操作系统切换（用户显式选了浅/深就不该被系统覆盖）
  useEffect(() => {
    if (choice !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setResolved(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [choice])

  const setChoice = useCallback((next: ThemeChoice) => {
    storeTheme(next)
    setChoiceState(next)
  }, [])

  const toggle = useCallback(() => {
    setChoiceState((prev) => {
      const next: ThemeChoice = resolveTheme(prev) === 'dark' ? 'light' : 'dark'
      storeTheme(next)
      return next
    })
  }, [])

  return { choice, resolved, setChoice, toggle }
}
