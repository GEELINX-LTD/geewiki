/**
 * `lib/editorModePlan.ts` —— 编辑器的两种模式（源码 / 实时渲染）与它们的持久化。
 * ============================================================================
 *
 * 这个模块只有 5 个短函数，但它决定"下次进编辑页看到的是哪一档"，而且**必须失败关闭**：
 * 读存储失败、存的是脏数据、乃至 `window.localStorage` **取值本身就抛**（Safari 隐私模式），
 * 都必须静默回落到默认档（实时渲染），绝不能把编辑页一起带走 —— 作者面对"编辑器打不开"
 * 只会以为内容丢了。
 *
 * 注入方式：模块每次调用都现取 `window.localStorage`（不在模块顶层缓存），
 * 所以测试只要换掉 `globalThis.window` 即可，不需要 mock 框架（同 `test/myAccessRequests.test.ts`）。
 *
 * 另一条不能松的口子：**键名带版本后缀**（`gw.editor-mode.v1`）。存的是档位字符串本身、
 * 不写别的键 —— 换形状时直接换 key，不必写迁移，也不必猜旧值是什么意思。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EDITOR_MODE_KEY,
  EDITOR_MODE_OPTIONS,
  editorModeLabel,
  isEditorMode,
  readStoredMode,
  storeMode,
  type EditorMode,
} from '../src/lib/editorModePlan'

/* ---------------------------- 注入工具 ---------------------------- */

interface FakeStorage {
  map: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
}

/** 装一个只有 localStorage 的 window（模块只用到这一面） */
function installWindow(localStorage: unknown): void {
  ;(globalThis as unknown as { window?: unknown }).window = { localStorage }
}

function uninstallWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window
}

/* ---------------------------- 读取与默认值 ---------------------------- */

test('没有 window（SSR / 本进程）⇒ 默认「实时渲染」，读写都不抛', () => {
  assert.equal(typeof window, 'undefined', '前置条件：本进程没有 window')
  assert.equal(readStoredMode(), 'live', '默认落在一档上：本项目的编辑页主要给写文档的人用')
  assert.doesNotThrow(() => storeMode('source'))
})

test('window 存在但没有 localStorage（或被禁用）⇒ 默认「实时渲染」', () => {
  installWindow(undefined)
  try {
    assert.equal(readStoredMode(), 'live')
    assert.doesNotThrow(() => storeMode('source'))
  } finally {
    uninstallWindow()
  }
})

test('window.localStorage **取值本身就抛**（Safari 隐私模式）⇒ 默认「实时渲染」，且写不抛', () => {
  ;(globalThis as unknown as { window?: unknown }).window = {
    get localStorage(): unknown {
      throw new Error('SecurityError: 隐私模式下禁止访问 localStorage')
    },
  }
  try {
    assert.equal(readStoredMode(), 'live', '连取值都在 try 里 —— 这不是可以"外面兜一层"的地方')
    assert.doesNotThrow(() => storeMode('source'))
  } finally {
    uninstallWindow()
  }
})

test('getItem 抛（存储被禁用 / 配额）⇒ 默认「实时渲染」，绝不把页面搞崩', () => {
  installWindow({
    getItem(): string | null {
      throw new Error('SecurityError')
    },
    setItem(): void {},
  })
  try {
    assert.equal(readStoredMode(), 'live')
  } finally {
    uninstallWindow()
  }
})

test('存的是脏数据 ⇒ 默认「实时渲染」（不认识的值一律不当档位用）', () => {
  for (const raw of [null, '', 'dark', 'SOURCE', 'Source', 'live ', ' true', '{}']) {
    const s = fakeStorage(raw === null ? {} : { [EDITOR_MODE_KEY]: raw })
    installWindow(s)
    try {
      assert.equal(readStoredMode(), 'live', `脏数据 ${JSON.stringify(raw)} 应回落到默认档`)
    } finally {
      uninstallWindow()
    }
  }
})

test('存了合法档位 ⇒ 原样读回来（用户的选择要跨会话记住）', () => {
  for (const mode of ['source', 'live'] as const) {
    const s = fakeStorage({ [EDITOR_MODE_KEY]: mode })
    installWindow(s)
    try {
      assert.equal(readStoredMode(), mode)
    } finally {
      uninstallWindow()
    }
  }
})

/* ---------------------------- 写入 ---------------------------- */

test('storeMode：只写 `gw.editor-mode.v1` 这一个键，存的就是档位字符串本身', () => {
  const s = fakeStorage()
  installWindow(s)
  try {
    assert.equal(EDITOR_MODE_KEY, 'gw.editor-mode.v1', '键名带版本后缀：将来形状变了可直接换 key，不必写迁移')
    storeMode('source')
    assert.deepEqual([...s.map.keys()], ['gw.editor-mode.v1'], '不能顺手写别的键，也不能改拼法')
    assert.equal(s.map.get('gw.editor-mode.v1'), 'source', '存的是档位本身，不是 JSON 包装')
    assert.equal(readStoredMode(), 'source', '写完立刻读得回来')

    storeMode('live')
    assert.equal(s.map.get('gw.editor-mode.v1'), 'live', '切换档位是覆盖写，不是追加')
    assert.equal(s.map.size, 1)
    assert.equal(readStoredMode(), 'live')
  } finally {
    uninstallWindow()
  }
})

test('setItem 抛 ⇒ storeMode 静默降级（只是刷新后回到默认，不能把编辑器一起带走）', () => {
  const s = fakeStorage()
  installWindow({
    getItem: s.getItem,
    setItem(): void {
      throw new Error('QuotaExceededError')
    },
  })
  try {
    assert.doesNotThrow(() => storeMode('source'))
  } finally {
    uninstallWindow()
  }
})

/* ---------------------------- 类型与文案 ---------------------------- */

test('isEditorMode：只有 \'source\' / \'live\' 两个字面量算数（其余一律不算）', () => {
  assert.equal(isEditorMode('source'), true)
  assert.equal(isEditorMode('live'), true)
  for (const bad of ['SOURCE', 'Source', 'source ', '', 'dark', null, undefined, 0, 1, true, {}, []]) {
    assert.equal(isEditorMode(bad), false, `${JSON.stringify(bad)} 不是合法档位`)
  }
})

test('editorModeLabel：两档各自的中文短名；未知取值回落成自身（界面不显示 undefined）', () => {
  assert.equal(editorModeLabel('live'), '实时渲染')
  assert.equal(editorModeLabel('source'), '源码')
  assert.equal(editorModeLabel('weird' as EditorMode), 'weird')
})

test('EDITOR_MODE_OPTIONS：两档都在、默认档排第一、标签与 label 同源', () => {
  assert.deepEqual(
    EDITOR_MODE_OPTIONS.map((o) => o.id),
    ['live', 'source'],
  )
  assert.equal(new Set(EDITOR_MODE_OPTIONS.map((o) => o.id)).size, 2, 'id 不得重复（下拉项会撞车）')
  for (const o of EDITOR_MODE_OPTIONS) {
    assert.ok(o.label.length > 0 && o.hint.length > 0, '选项文案不能是空的')
    assert.equal(o.label, editorModeLabel(o.id), '文案只有一处真源，界面不能各写一份')
  }
  assert.equal(
    EDITOR_MODE_OPTIONS[0]?.id,
    'live',
    '第一项就是默认档（读不到存储时回落到它），改顺序会让"默认"和"首项"对不上',
  )
})
