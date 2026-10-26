#!/usr/bin/env node
/** 真实浏览器执行临时插件，验证入口失败、回滚、重试和迟到结果。 */
import assert from 'node:assert/strict'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cookiePair, ensureAdminSession } from './lib/session.mjs'

const [baseUrl, cdpPort, output] = process.argv.slice(2)
const checks = []
const errors = []
const warnings = []
let ws
let send
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const name = id => `@gw-test/ui-${id}`

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

async function wait(expression, label) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await delay(60)
  }
  throw new Error(`等待失败：${label}`)
}

function passed(label) {
  checks.push(label)
  console.log(`ok ${label}`)
}

const sync = () => evaluate('window.__GEEWIKI_PLUGIN_UI__.sync({ force: true })')
const contributors = () => evaluate('window.__GEEWIKI_HOST__.slotContributors("app-header")')
const failures = () => evaluate('[...document.querySelectorAll("[data-plugin-ui-failed]")].map(e => e.dataset.pluginUiFailed)')
const count = id => evaluate(`window.__uiFixture.counts[${JSON.stringify(id)}]`)
const diagnostics = () => evaluate('window.__GEEWIKI_PLUGIN_UI__.diagnostics()')
const diagnostic = async id => (await diagnostics()).find(item => item.name === name(id))
const timeoutState = () => evaluate(`(() => {
  const host = window.__GEEWIKI_HOST__, owner = '${name('00-timeout')}';
  return {
    slot: host.slotContributors('app-header').filter(item => item === owner),
    ext: host.slotContributors('ui-card').filter(item => item === owner),
    themes: host.themeContributors.filter(item => item.owner === owner),
    markdown: host.markdownExtensions.filter(item => item.owner === owner),
    tools: host.clientTools.filter(item => item === 'fixture.timeout'),
    loaded: window.__GEEWIKI_PLUGIN_UI__.loaded().includes(owner),
    css: document.querySelectorAll('link[data-plugin-ui="' + owner + '"]').length,
  };
})()`)

try {
  const auth = await ensureAdminSession(baseUrl, { adminToken: '' })
  assert.equal(auth.ok, true, auth.note)
  assert.equal(auth.mode, 'session')
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let sequence = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const call = pending.get(message.id)
    if (call) {
      pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) call.reject(new Error(JSON.stringify(message.error)))
      else call.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(message.params.type)) {
      warnings.push(message.params.args.map(arg => arg.description ?? arg.value).join(' '))
    }
  }
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 45_000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  await send('Network.setCookie', { ...cookiePair(auth.session.cookie), url: baseUrl, httpOnly: true })
  await send('Page.navigate', { url: baseUrl })
  await wait('window.__GEEWIKI_PLUGIN_UI__?.loaded().includes("@gw-test/ui-healthy")', '正常插件已加载')
  await sync()
  assert.ok((await failures()).includes(name('00-timeout')), '挂起入口应有可见超时提示')
  assert.deepEqual(await timeoutState(), { slot: [], ext: [], themes: [], markdown: [], tools: [], loaded: false, css: 0 })
  assert.equal(await evaluate(`document.querySelector('[data-plugin-ui-failed="${name('00-timeout')}"]').dataset.errorKind`), 'timeout')
  assert.match(await evaluate(`document.querySelector('[data-plugin-ui-failed="${name('00-timeout')}"]').textContent`), /初始化超时/)
  assert.ok(await evaluate('window.__uiFixture.healthyAt - window.__uiFixture.timeoutRuns[0].started >= 14_000'))
  passed('真实挂起入口在上限后可见超时，六类注册回收，后续正常插件及同步恢复')
  for (const id of ['sync', 'async', 'top']) {
    assert.ok((await failures()).includes(name(id)), `${id} 必须有可见失败提示`)
    assert.ok(!(await contributors()).includes(name(id)), `${id} 的部分注册必须回滚`)
    assert.equal(await evaluate(`!!document.querySelector('link[data-plugin-ui="${name(id)}"]')`), false)
  }
  assert.ok((await contributors()).includes(name('healthy')))
  passed('同步、异步和模块求值异常均可见，部分注册和 CSS 没有残留，正常插件仍可用')
  assert.deepEqual(await diagnostic('missing'), { name: name('missing'), slots: ['app-footer'], extNodes: ['ui-card'], routes: ['fixture-missing'] })
  assert.ok((await contributors()).includes(name('missing')), '缺项不能回滚已工作的部分')
  assert.equal(await diagnostic('delayed'), undefined, 'awaited 异步入口完成的实际注册不可误报')
  assert.equal(await diagnostic('winner'), undefined)
  assert.equal(await diagnostic('suppressed'), undefined)
  const editors = await evaluate('window.__GEEWIKI_HOST__.slotContributors("editor")')
  assert.equal(editors.filter(owner => [name('winner'), name('suppressed')].includes(owner)).length, 1)
  passed('声明缺项分别列出插槽、扩展点和页面，保留正常部分，仲裁落败和异步入口不误报')
  assert.ok((await evaluate('window.__GEEWIKI_PLUGIN_UI__.deferred()')).includes(name('lazy')))
  assert.equal(await diagnostic('lazy'), undefined)
  passed('尚未加载的按需入口没有提前告警')
  for (let i = 0; i < 5; i++) await sync()
  assert.equal(await count('sync'), 1)
  assert.equal(await count('async'), 1)
  assert.equal(await count('healthy'), 1)
  assert.equal(await count('missing'), 1, '声明缺项不能导致自动重执行入口')
  assert.equal(await evaluate('window.__uiFixture.timeoutRuns.length'), 1, '超时版本也不应自动重试')
  passed('同一失败版本不会因重复同步而重跑入口，正常插件也不重复注册')

  await evaluate('location.hash = "#/plugins"')
  await wait('document.querySelectorAll("[data-plugin-ui-entry-failed]").length === 4', '管理台显示入口失败和超时')
  assert.match(await evaluate(`document.querySelector('[data-plugin-ui-entry-failed="${name('00-timeout')}"]').textContent`), /初始化超时/)
  passed('管理台区分已运行的插件、失败和超时的客户端界面')
  await wait('document.querySelectorAll("[data-plugin-ui-mismatch]").length === 2', '管理台列出声明缺项')
  await evaluate('window.__uiFixture.registerDynamic()')
  await wait('!document.querySelector(\'[data-plugin-ui-mismatch="@gw-test/ui-dynamic"]\')', '延迟注册后提示自动消失')
  assert.equal(await diagnostic('dynamic'), undefined)
  await evaluate('window.__uiFixture.disposeDynamicRoute()')
  assert.deepEqual(await diagnostic('dynamic'), { name: name('dynamic'), slots: [], extNodes: [], routes: ['fixture-dynamic'] })
  await evaluate('window.__uiFixture.registerDynamicRoute()')
  assert.equal(await diagnostic('dynamic'), undefined)
  await evaluate('window.__uiFixture.disposeDynamic()')
  await wait('!!document.querySelector(\'[data-plugin-ui-mismatch="@gw-test/ui-dynamic"]\')', '注销后提示自动出现')
  assert.deepEqual(await diagnostic('dynamic'), { name: name('dynamic'), slots: ['app-header'], extNodes: ['ui-card'], routes: ['fixture-dynamic'] })
  await evaluate('window.__uiFixture.registerDynamic()')
  assert.equal(await diagnostic('dynamic'), undefined)
  await evaluate('window.__uiDiagnosticsBefore = window.__GEEWIKI_PLUGIN_UI__.diagnostics(); void 0')
  await sync()
  assert.equal(await evaluate('window.__uiDiagnosticsBefore === window.__GEEWIKI_PLUGIN_UI__.diagnostics()'), true)
  passed('真实注册与注销即时更新诊断和管理台，路由单独变更生效，无变化时保持快照稳定')
  await evaluate('window.__GEEWIKI_PLUGIN_UI__.ensureSlot("account-identities")')
  assert.deepEqual(await diagnostic('lazy'), { name: name('lazy'), slots: ['account-identities'], extNodes: [], routes: [] })
  passed('按需入口实际加载后才核对声明')
  const toggle = async (id, enabled) => {
    const result = await auth.session.call('POST', `/api/plugins/${encodeURIComponent(name(id))}/${enabled ? 'enable' : 'disable'}`)
    assert.equal(result.status, 200, result.text)
  }
  await toggle('missing', false)
  await sync()
  assert.equal(await diagnostic('missing'), undefined)
  await toggle('missing', true)
  await sync()
  assert.ok(await diagnostic('missing'))
  assert.equal(await count('missing'), 2)
  passed('声明缺项随停用清除，重新启用后重新核对')
  await toggle('sync', false)
  await sync()
  assert.ok(!(await failures()).includes(name('sync')))
  await toggle('sync', true)
  await sync()
  assert.equal(await count('sync'), 2)
  assert.ok((await failures()).includes(name('sync')))
  passed('失败插件停用后清除提示，重新启用会重试并恢复失败提示')

  await evaluate('window.__uiFixture.recover.sync = true')
  await appendFile(join(process.env.GEEWIKI_UI_FIXTURE_DIR, 'sync/dist/client.js'), '\n/* fixture revision changed */\n')
  await sync()
  assert.equal(await count('sync'), 3)
  assert.ok(!(await failures()).includes(name('sync')))
  assert.ok((await contributors()).includes(name('sync')))
  assert.equal(await evaluate(`document.querySelectorAll('link[data-plugin-ui="${name('sync')}"]').length`), 1)
  passed('版本变化后重试成功，失败提示自愈且样式仅注入一次')

  await toggle('00-timeout', false)
  await sync()
  assert.ok(!(await failures()).includes(name('00-timeout')))
  await evaluate('window.__uiFixture.recoverTimeout = true')
  await toggle('00-timeout', true)
  await sync()
  const replacement = await timeoutState()
  assert.equal(replacement.loaded, true)
  assert.deepEqual(replacement.slot, [name('00-timeout')])
  assert.deepEqual(replacement.ext, [name('00-timeout')])
  assert.equal(replacement.themes.length, 1)
  assert.equal(replacement.markdown.length, 1)
  assert.equal(replacement.tools.length, 1)
  assert.equal(replacement.css, 1)
  assert.equal(await diagnostic('00-timeout'), undefined)
  assert.equal(await evaluate('window.__GEEWIKI_HOST__.invokeTool("fixture.timeout", {})'), 2)
  await evaluate('window.__uiFixture.timeoutRuns[0].release(); void 0')
  await wait('window.__uiFixture.timeoutRuns[0].lateCleanup === 1', '超时入口的迟到清理函数执行一次')
  assert.equal(await evaluate('window.__uiFixture.timeoutRuns[0].mutationsComplete'), true)
  assert.deepEqual(await timeoutState(), replacement, '旧宿主的注册、批量注销和旧 token 均不能影响新代次')
  assert.equal(await diagnostic('00-timeout'), undefined, '新代次页面注册也仍然存在')
  assert.equal(await evaluate('window.__GEEWIKI_HOST__.invokeTool("fixture.timeout", {})'), 2)
  passed('超时后重新启用可恢复，旧入口迟到注册和注销不影响六类新贡献，迟到清理仅执行一次')

  await toggle('00-timeout', false)
  await sync()
  await evaluate('window.__uiFixture.recoverTimeout = false')
  await toggle('00-timeout', true)
  await sync()
  assert.ok((await failures()).includes(name('00-timeout')))
  await evaluate('window.__uiFixture.timeoutRuns[2].reject = true; window.__uiFixture.timeoutRuns[2].release(); void 0')
  await wait('window.__uiFixture.timeoutRuns[2].rejected === true', '超时后的拒绝已发生')
  await sync()
  assert.deepEqual(await timeoutState(), { slot: [], ext: [], themes: [], markdown: [], tools: [], loaded: false, css: 0 })
  assert.ok((await failures()).includes(name('00-timeout')))
  passed('超时后的迟到拒绝被消费，提示保持正确，重复同步继续工作')

  for (const rejectLate of [false, true]) {
    await evaluate(`Object.assign(window.__uiFixture, { waiting: false, rejectLate: ${rejectLate} })`)
    await toggle('late', true)
    await evaluate('window.__uiPending = window.__GEEWIKI_PLUGIN_UI__.sync(); void 0')
    await wait('window.__uiFixture.waiting === true', '异步入口进入等待')
    assert.equal(await evaluate(`window.__GEEWIKI_PLUGIN_UI__.loaded().includes('${name('late')}')`), false)
    assert.equal(await diagnostic('late'), undefined, '入口等待期间不做声明缺项诊断')
    assert.equal(await evaluate('window.__GEEWIKI_HOST__.pluginName'), undefined, '异步等待期间全局 SDK 已还原')
    const settledBefore = await evaluate('window.__uiFixture.lateSettled ?? 0')
    await toggle('late', false)
    await evaluate(`window.__GEEWIKI_PLUGIN_UI__.unload('${name('late')}'); void 0`)
    await evaluate('window.__uiPending')
    await sync()
    // 不释放原 Promise 也应先恢复同步；再让旧入口结算，检验迟到成功和拒绝。
    await evaluate('window.__uiFixture.release(); void 0')
    await wait(`window.__uiFixture.lateSettled === ${settledBefore + 1}`, '已撤销入口迟到结算')
    assert.ok(!(await contributors()).includes(name('late')))
    assert.ok(!(await failures()).includes(name('late')))
    assert.equal(await evaluate(`!!document.querySelector('link[data-plugin-ui="${name('late')}"]')`), false)
  }
  assert.equal(await evaluate('window.__uiFixture.cleaned'), 1)
  passed('在途入口卸载立即结束等待，迟到成功和失败均不复活贡献或提示，清理执行一次')
  assert.deepEqual(errors, [])
  passed('没有未处理的 JavaScript 异常或 Promise 拒绝')
} catch (error) {
  console.error(error)
  if (send) {
    try {
      console.error('browser state', await evaluate('({ fixture: window.__uiFixture, loaded: window.__GEEWIKI_PLUGIN_UI__?.loaded(), failed: [...document.querySelectorAll("[data-plugin-ui-failed]")].map(e => ({name:e.dataset.pluginUiFailed,error:e.dataset.error})) })'))
      console.error('browser warnings', warnings)
    } catch { /* 保留原始失败 */ }
  }
  process.exitCode = 1
} finally {
  if (send) {
    try {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(output, 'plugin-ui-diagnostics.png'), Buffer.from(screenshot.data, 'base64'))
    } catch { /* 保留已有失败 */ }
  }
  await writeFile(join(output, 'results.json'), JSON.stringify({ ok: !process.exitCode, checks, errors, warnings }, null, 2))
  ws?.close()
}
