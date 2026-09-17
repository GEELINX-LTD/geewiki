/**
 * 插件页面路由**组件注册表**的单元测试（F2）。
 *
 * 不渲染任何东西（`node --test` 下没有 DOM）：这里测的是注册表的校验与记账语义——
 * 而"注册表记账错了"恰恰是最难在界面上看出来的那类缺陷（页面能开，但卸载插件后
 * 它还留在导航里；或者另一个插件把它的页面顶掉了，用户只看到"内容变了"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerRoute,
  registeredRoute,
  routeEntries,
  routeIds,
  unregisterRoutes,
  type PluginRouteProps,
} from '../src/lib/routes'
import { RESERVED_ROUTE_IDS, PLUGIN_ROUTE_ID } from '../src/lib/pluginUiPlan'

const Dummy = (_props: PluginRouteProps): null => null

/** 每个用例前后清场：注册表是模块级单例，跨用例残留会让断言互相干扰 */
function clean(...sources: string[]): void {
  for (const s of sources) unregisterRoutes(s)
}

test('registerRoute：合法 id 注册后可见，注销函数幂等', () => {
  clean('t1')
  const off = registerRoute('board', Dummy, 't1')
  assert.deepEqual(routeIds(), ['board'])
  assert.equal(registeredRoute('board')?.source, 't1')
  off()
  off() // 幂等
  assert.deepEqual(routeIds(), [])
  clean('t1')
})

test('registerRoute：宿主保留 id 一律拒绝（插件不得覆盖内置页面）', () => {
  clean('t2')
  for (const id of RESERVED_ROUTE_IDS) {
    const off = registerRoute(id, Dummy, 't2')
    assert.equal(registeredRoute(id), undefined, `保留路由 ${id} 不得被插件注册`)
    off()
  }
  assert.deepEqual(routeIds(), [])
  clean('t2')
})

test('registerRoute：id 语法非法一律拒绝（含 `/`、大写、空串）', () => {
  clean('t3')
  for (const id of ['a/b', 'Board', '', 'a_b', '1board', '-x']) {
    const off = registerRoute(id, Dummy, 't3')
    assert.equal(registeredRoute(id), undefined, `非法 id ${JSON.stringify(id)} 不得注册`)
    off()
  }
  assert.deepEqual(routeIds(), [])
  clean('t3')
})

test('registerRoute：不同来源抢同一个 id ⇒ 先到先得，后来者被拒（不静默顶替）', () => {
  clean('first', 'second')
  const offA = registerRoute('board', Dummy, 'first')
  const offB = registerRoute('board', Dummy, 'second')
  assert.equal(registeredRoute('board')?.source, 'first')
  offB() // 空操作：它压根没注册成功
  assert.equal(registeredRoute('board')?.source, 'first', '后来者的注销函数不得误删先到者')
  offA()
  assert.deepEqual(routeIds(), [])
  clean('first', 'second')
})

test('registerRoute：同一来源重复注册同名 id 视为同一条（重载不泄漏）', () => {
  clean('t5')
  const offA = registerRoute('board', Dummy, 't5')
  const offB = registerRoute('board', Dummy, 't5')
  assert.equal(routeEntries().length, 1, '同一来源重复注册不得产生两条')
  // 第一个注销函数此时**不应**删掉后来的那条（它已被取代）
  offA()
  assert.equal(registeredRoute('board')?.source, 't5', '旧注销函数不得删掉新登记的条目')
  offB()
  assert.deepEqual(routeIds(), [])
  clean('t5')
})

test('unregisterRoutes：按来源一次性回收该插件的全部页面（卸载统一出口）', () => {
  clean('multi', 'other')
  registerRoute('board', Dummy, 'multi')
  registerRoute('report', Dummy, 'multi')
  registerRoute('canvas', Dummy, 'other')
  assert.deepEqual(routeIds(), ['board', 'canvas', 'report'])
  unregisterRoutes('multi')
  assert.deepEqual(routeIds(), ['canvas'], '只回收该来源的，不得误伤别的插件')
  clean('multi', 'other')
})

test('routeEntries：按 id 排序（快照稳定，供 useSyncExternalStore 用）', () => {
  clean('t7')
  registerRoute('zzz', Dummy, 't7')
  registerRoute('aaa', Dummy, 't7')
  const snap = routeEntries()
  assert.deepEqual(
    snap.map((e) => e.id),
    ['aaa', 'zzz'],
  )
  // 引用稳定性：未变更时必须返回同一个对象（否则 React 会无限重渲染）
  assert.equal(routeEntries(), snap, 'routeEntries() 必须返回稳定引用')
  clean('t7')
})

test('PLUGIN_ROUTE_ID 镜像与保留清单：与 core 的判据同形', () => {
  // 与 core 的 RESERVED_ROUTE_IDS / PLUGIN_ROUTE_ID 逐元素一致由
  // slotPropsMirror.test.ts 的源码级守卫负责；这里只锁住"本模块在运行期用的是它"。
  assert.equal(PLUGIN_ROUTE_ID.test('board'), true)
  assert.equal(PLUGIN_ROUTE_ID.test('a/b'), false)
  assert.ok(RESERVED_ROUTE_IDS.includes('wiki'))
})
