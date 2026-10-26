import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPluginUiHost } from '../src/lib/pluginUi'
import { diagnosePluginUiRegistration } from '../src/lib/pluginUiDiagnostics'
import { registerSlotByName, unregisterSlot } from '../src/lib/slots'
import { registerRoute, unregisterRoutes } from '../src/lib/routes'
import type { GeeWikiHostSdk } from '../src/lib/hostSdk'
import type { SuppressedOwners, UiTableEntry } from '../src/lib/pluginUiPlan'

const name = '@test/ui-diagnostics'
const component = () => null
const sdk = { renderMarkdown: (s: string) => s } as GeeWikiHostSdk
const meta: UiTableEntry = {
  entry: 'client.js', rev: 'r', slots: ['app-header'], extNodes: ['ui-card'], routes: [{ id: 'diagnostic-page' }],
}

function fixture(entry = meta, suppressed: SuppressedOwners = new Map()) {
  const disposers: Array<() => void> = []
  const host = createPluginUiHost({ name, sdk, meta: entry, suppressed, disposers })
  return {
    host,
    diagnose: () => diagnosePluginUiRegistration(name, entry, suppressed),
    cleanup: () => { for (const off of disposers) off() },
  }
}

test('诊断读取三种真实注册，不把另一 owner 的贡献算作自己的', () => {
  const f = fixture()
  const offNode = registerSlotByName('app-header', component, '@test/other')
  const offExt = registerSlotByName('ui-card', component, '@test/other')
  const offRoute = registerRoute('diagnostic-page', component, '@test/other')
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.deepEqual(f.diagnose(), { name, slots: ['app-header'], extNodes: ['ui-card'], routes: ['diagnostic-page'] })
    f.host.registerSlot('app-header', component)
    f.host.registerExtension('ui-card', component)
    f.host.registerRoute('diagnostic-page', component) // 被真实注册表拒绝，不得算成功。
    assert.deepEqual(f.diagnose(), { name, slots: [], extNodes: [], routes: ['diagnostic-page'] })
    offRoute()
    f.host.registerRoute('diagnostic-page', component)
    assert.equal(f.diagnose(), undefined)
  } finally {
    console.warn = originalWarn
    f.cleanup(); offNode(); offExt(); offRoute()
  }
})

test('模式化插槽注册可满足 slots 声明，顶层与显式入口共享同一注册事实', () => {
  const f = fixture({ entry: 'client.js', rev: 'r', slots: ['app-header'] })
  try {
    f.host.registerExtension('app-header', component)
    assert.equal(f.diagnose(), undefined)
  } finally { f.cleanup() }
})

test('被抑制节点不算缺项，未注册的生效节点仍被指出', () => {
  const f = fixture(meta, new Map([['app-header', new Set([name])]]))
  try {
    assert.deepEqual(f.diagnose(), { name, slots: [], extNodes: ['ui-card'], routes: ['diagnostic-page'] })
  } finally { f.cleanup() }
})

test('无声明的兼容插件不因为没有组件而被诊断', () => {
  const f = fixture({ entry: 'client.js', rev: 'r' })
  assert.equal(f.diagnose(), undefined)
})

test('被运行期模式规则拒绝的注册不能满足声明', () => {
  const f = fixture({ entry: 'client.js', rev: 'r', slots: ['app-header'] })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    f.host.registerExtension('app-header', component, { mode: 'replace' }) // multi 插槽不允许 replace。
    assert.deepEqual(f.diagnose(), { name, slots: ['app-header'], extNodes: [], routes: [] })
  } finally { console.warn = originalWarn; f.cleanup() }
})

test('注销同一节点的一条注册时，其余贡献仍满足声明；最后一条回收后才出现缺项', () => {
  const f = fixture({ entry: 'client.js', rev: 'r', slots: ['app-header'] })
  try {
    const one = f.host.registerSlot('app-header', component)
    const two = f.host.registerSlot('app-header', component)
    one()
    assert.equal(f.diagnose(), undefined)
    two()
    assert.deepEqual(f.diagnose(), { name, slots: ['app-header'], extNodes: [], routes: [] })
    one(); two()
    f.host.registerSlot('app-header', component)
    assert.equal(f.diagnose(), undefined)
  } finally { f.cleanup() }
})

test('按 owner 批量注销同样反映真实缺项，再次注册即可自愈', () => {
  const f = fixture()
  try {
    f.host.registerSlot('app-header', component)
    f.host.registerExtension('ui-card', component)
    f.host.registerRoute('diagnostic-page', component)
    assert.equal(f.diagnose(), undefined)
    f.host.unregisterSlot('app-header')
    f.host.unregisterRoutes(name)
    assert.deepEqual(f.diagnose(), { name, slots: ['app-header'], extNodes: [], routes: ['diagnostic-page'] })
    f.host.registerSlot('app-header', component)
    f.host.registerRoute('diagnostic-page', component)
    assert.equal(f.diagnose(), undefined)
  } finally { f.cleanup(); unregisterSlot('app-header'); unregisterRoutes(name) }
})
