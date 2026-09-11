/**
 * 认证失败出口的决策测试（`lib/authFailure.ts`）。
 *
 * 这层决定"要不要跳、跳到哪"，写错的表现是**用户被莫名其妙地弹走**
 * （把 CSRF 配置错误显示成"你无权访问"、或把未登录显示成"系统未初始化"），
 * 而这类问题在浏览器里很难复现，所以判据必须用单测钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authFailureAction, normalizeRedirect } from '../src/lib/authFailure'

test('401 ⇒ 去登录，并带上回跳地址', () => {
  const a = authFailureAction(401, 'unauthorized', '#/wiki/getting-started')
  assert.deepEqual(a, { kind: 'login', redirect: '/wiki/getting-started' })
})

test('503 bootstrap_required ⇒ 去初始化（**不是**去登录，否则引导期会死循环）', () => {
  assert.deepEqual(authFailureAction(503, 'bootstrap_required', '#/wiki'), { kind: 'setup' })
  // 其它 503 不是"未初始化"，不该跳初始化向导
  assert.equal(authFailureAction(503, 'internal', '#/wiki'), null)
})

test('403 forbidden ⇒ 去无权限页；403 csrf_rejected **刻意不跳**（那是客户端构造问题，不是权限问题）', () => {
  assert.deepEqual(authFailureAction(403, 'forbidden', '#/wiki'), { kind: 'denied' })
  assert.deepEqual(authFailureAction(403, 'hook_invalid_verdict', '#/wiki'), { kind: 'denied' })
  assert.equal(
    authFailureAction(403, 'csrf_rejected', '#/wiki'),
    null,
    '把 CSRF 失败显示成"你无权访问"会把排查方向指向完全错误的地方',
  )
})

test('非认证类失败一律不跳（把 404 / 500 也弹走会让用户丢失正在做的事）', () => {
  assert.equal(authFailureAction(404, 'not_found', '#/wiki'), null)
  assert.equal(authFailureAction(500, 'internal', '#/wiki'), null)
  assert.equal(authFailureAction(400, 'invalid_body', '#/wiki'), null)
  assert.equal(authFailureAction(200, 'ok', '#/wiki'), null)
})

test('normalizeRedirect：只接受站内 hash 路由（挡住 //evil.com 之类的外部地址）', () => {
  assert.equal(normalizeRedirect('/wiki/foo'), '/wiki/foo')
  assert.equal(normalizeRedirect('#/wiki/foo'), '/wiki/foo')
  // 外部地址：写回 location.hash 会变成协议相对 URL ⇒ 必须退回默认页
  assert.equal(normalizeRedirect('//evil.example/x'), '/wiki')
  assert.equal(normalizeRedirect('https://evil.example'), '/wiki')
  assert.equal(normalizeRedirect('javascript:alert(1)'), '/wiki')
  assert.equal(normalizeRedirect(''), '/wiki')
  assert.equal(normalizeRedirect(undefined as unknown as string), '/wiki')
})

test('normalizeRedirect：登录页/初始化页自身不能作为回跳目标（否则登录成功后又跳回登录页）', () => {
  assert.equal(normalizeRedirect('/login'), '/wiki')
  assert.equal(normalizeRedirect('/login?redirect=%2Fwiki'), '/wiki')
  assert.equal(normalizeRedirect('/setup'), '/wiki')
  assert.equal(normalizeRedirect('/setup?x=1'), '/wiki')
})
