import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { awaitPluginUiEntry, PluginUiEntryTimeoutError } from '../src/lib/pluginUiEntry'

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('入口正常结算和拒绝都原样传递，并移除撤销监听', async () => {
  const controller = new AbortController()
  assert.equal(await awaitPluginUiEntry(Promise.resolve('ready'), controller.signal), 'ready')
  const failure = new Error('entry failed')
  await assert.rejects(awaitPluginUiEntry(Promise.reject(failure), controller.signal), error => error === failure)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('永不结算的入口按等待上限返回可识别超时，迟到成功不再改变结果', async () => {
  const controller = new AbortController()
  const entry = pending<string>()
  await assert.rejects(awaitPluginUiEntry(entry.promise, controller.signal, 10), PluginUiEntryTimeoutError)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  entry.resolve('too late')
  await delay(0)
})

test('超时后的迟到拒绝被消费，不成为未处理异常', async () => {
  const controller = new AbortController()
  const entry = pending<void>()
  await assert.rejects(awaitPluginUiEntry(entry.promise, controller.signal, 10), PluginUiEntryTimeoutError)
  entry.reject(new Error('late rejection'))
  await delay(0)
})

test('停用可立即结束等待，清理长计时器和监听，并消费后续拒绝', async () => {
  const controller = new AbortController()
  const entry = pending<void>()
  const waiting = awaitPluginUiEntry(entry.promise, controller.signal, 60_000)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  entry.reject(new Error('disabled entry rejection'))
  await delay(0)
})

test('调用前已撤销，也先接住原 Promise 的拒绝', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(awaitPluginUiEntry(Promise.reject(new Error('already aborted')), controller.signal), { name: 'AbortError' })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await delay(0)
})
