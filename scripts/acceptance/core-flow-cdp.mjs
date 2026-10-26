#!/usr/bin/env node
/** 核心浏览器回归，零依赖 CDP；由 run-core-flow.mjs 提供隔离实例。 */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureAdminSession } from './lib/session.mjs'

const [baseUrl, cdpPort, output] = process.argv.slice(2)
const results = []
const sockets = []
const errors = []
const delay = (ms) => new Promise((res) => setTimeout(res, ms))
let browser
let page
let targetId

async function connect(url) {
  const ws = new WebSocket(url)
  sockets.push(ws)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
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
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true })
  }
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 15_000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return send
}

async function evaluate(expression) {
  const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

async function wait(expression, label) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await delay(60)
  }
  throw new Error(`等待失败：${label}`)
}

async function click(expression) {
  await wait(`(() => { const e = ${expression}; return e && !e.disabled })()`, '按钮可点击')
  const point = await evaluate(`(async () => {
    const element = ${expression};
    element.scrollIntoView({ block: 'center' });
    const deadline = Date.now() + 5000;
    let previous, stable = 0;
    while (Date.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const r = element.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const ready = r.width > 0 && r.height > 0 && element.contains(hit)
        && previous && Math.abs(previous.x - x) < 0.1 && Math.abs(previous.y - y) < 0.1;
      stable = ready ? stable + 1 : 0;
      if (stable >= 3) return { x, y };
      previous = { x, y };
    }
    throw new Error('按钮位置未稳定或被遮挡');
  })()`)
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point })
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point })
}

function button(text, scope = 'document') {
  return `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`
}

async function fill(selector, text) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
  await page('Input.insertText', { text })
}

function passed(name) {
  results.push({ name, ok: true })
  console.log(`ok ${name}`)
}

try {
  const auth = await ensureAdminSession(baseUrl, { adminToken: '' })
  assert.equal(auth.ok, true, auth.note)
  assert.equal(auth.mode, 'session')
  const session = auth.session
  const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
  browser = await connect(version.webSocketDebuggerUrl)
  targetId = (await browser('Target.createTarget', { url: 'about:blank' })).targetId
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  page = await connect(targets.find((target) => target.id === targetId).webSocketDebuggerUrl)
  await page('Page.enable')
  await page('Page.bringToFront')
  await page('Runtime.enable')
  await page('Network.enable')
  await page('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await page('Page.navigate', { url: `${baseUrl}/#/login?redirect=%2Fwiki%2Fnew` })
  await wait('document.querySelector(\'input[name="email"]\') !== null', '登录表单')
  await fill('input[name="email"]', session.email)
  await fill('input[name="password"]', session.password)
  await click(button('登录', 'document.querySelector("form")'))
  const editor = '.cm-content[contenteditable="true"]'
  await wait(`document.querySelector(${JSON.stringify(editor)}) !== null`, '新建编辑器')
  passed('登录会话可进入新建编辑器')
  const slug = 'core-flow'
  await fill('#gw-page-slug', slug)
  await fill('#gw-page-title', '核心流程初稿')
  await fill(editor, '初稿正文 core-initial')
  await click(button('保存'))
  await wait(`location.hash === '#/wiki/${slug}' && document.body.innerText.includes('core-initial')`, '新建后阅读')
  passed('浏览器创建并阅读页面')

  await evaluate(`location.hash = '#/wiki/${slug}/edit'`)
  await wait(`document.querySelector(${JSON.stringify(editor)}) !== null`, '编辑原文')
  await fill(editor, '我的编辑 core-local-draft')
  const raw = await session.call('GET', `/api/pages/${slug}?raw=1`)
  assert.equal(raw.status, 200)
  assert.equal((await session.call('PUT', `/api/pages/${slug}`, {
    title: '另一人修改', content: '他人正文 core-remote', expectedRevision: raw.json.revision,
  })).status, 200)
  await click(button('保存'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('服务端内容已被更新') === true`, '服务端冲突提示')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent.includes('core-local-draft')`), true)
  assert.equal((await session.call('GET', `/api/pages/${slug}`)).json.content, '他人正文 core-remote')
  passed('过期保存被拒绝，编辑内容和远端正文均保留')

  // 冲突确认期间又发生一次修改，旧确认不得覆盖第三人的提交。
  const second = await session.call('GET', `/api/pages/${slug}?raw=1`)
  await session.call('PUT', `/api/pages/${slug}`, {
    title: '第三人修改', content: '第三人正文 core-third', expectedRevision: second.json.revision,
  })
  await click(button('仍然覆盖保存', 'document.querySelector(\'[role="dialog"]\')'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('服务端内容已被更新') === true`, '二次冲突提示')
  assert.equal((await session.call('GET', `/api/pages/${slug}`)).json.content, '第三人正文 core-third')
  await click(button('仍然覆盖保存', 'document.querySelector(\'[role="dialog"]\')'))
  await wait(`location.hash === '#/wiki/${slug}' && document.body.innerText.includes('core-local-draft')`, '确认覆盖后阅读')
  passed('再次修改仍被拒绝，按最新状态确认后保存成功')

  const latest = await session.call('GET', `/api/pages/${slug}`)
  const history = latest.json.versions
  assert.ok(history.length >= 3)
  const oldest = history[history.length - 1]
  // 从真实版本地址进入预览，使用产品的恢复按钮与确认框。
  await evaluate(`location.hash = '#/wiki/${slug}?v=${oldest.id}'`)
  await wait(`document.body.innerText.includes('core-initial') && ${button('恢复此版本')} !== undefined`, '历史预览')
  await click(button('恢复此版本'))
  await wait(`document.querySelector('[role="dialog"]') !== null`, '恢复确认')
  await click(button('恢复此版本', 'document.querySelector(\'[role="dialog"]\')'))
  await wait("document.body.innerText.includes('已恢复到该版本')", '恢复成功提示')
  await click(button('返回最新'))
  await wait(`location.hash === '#/wiki/${slug}' && document.body.innerText.includes('core-initial')`, '恢复后正文')
  const restored = await session.call('GET', `/api/pages/${slug}`)
  assert.equal(restored.json.title, '核心流程初稿')
  assert.equal(restored.json.content, '初稿正文 core-initial')
  assert.equal(restored.json.version, latest.json.version + 1)
  passed('历史预览与确认恢复同步还原标题正文并追加版本')
  assert.deepEqual(errors, [])
  passed('全程无浏览器未捕获异常')
} catch (error) {
  results.push({ name: '核心流程', ok: false, error: String(error) })
  console.error(error)
  if (page) {
    try {
      const screenshot = await page('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(output, 'failure.png'), Buffer.from(screenshot.data, 'base64'))
      await writeFile(join(output, 'failure.html'), await evaluate('document.documentElement.outerHTML'))
    } catch { /* 保留原始失败 */ }
  }
  process.exitCode = 1
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors }, null, 2))
  if (browser && targetId) await browser('Target.closeTarget', { targetId })
  for (const socket of sockets) socket.close()
}
