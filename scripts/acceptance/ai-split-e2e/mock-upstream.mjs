/**
 * 共享的**假 OpenAI 兼容上游**（`POST /v1/chat/completions`，SSE 分帧）。
 *
 * 为什么做成模块：两个验收脚本（`run.mjs` 验后端契约、`cdp-ui.mjs` 验浏览器侧）都需要一个
 * **确定性**的模型。用真模型跑验收会得到"今天通了明天红"的抖动读数；而这里要钉的恰恰是
 * 边界行为 —— 429、"成功但零 token"、以及正常流式 —— 只有假上游能每次都给出同一个结果。
 *
 * 模式经 `GET /__mode?m=ok|429|empty` 切换：
 * - `ok`    ⇒ 三个 content 增量 + usage（答案文本含 `[1]`，用于钉引用渲染）
 * - `429`   ⇒ 上游限流（期望：非 NO_ADAPTER 的上游失败 ⇒ 502）
 * - `empty` ⇒ **HTTP 200 但一个 token 都没有**（期望：判为失败 ⇒ 502，绝不冒充生成结果）
 *
 * `requests` 累积每次请求体：既用于断言提示词形状，也用于证明
 * "检索 0 命中 / 前置条件不满足时**根本没有调用模型**"。
 */
import { createServer } from 'node:http'

export const ANSWER = '检索增强问答先用全文检索召回相关片段，再交给模型生成带 [1] 引用的答案。'

export function startMockUpstream(port) {
  const state = { mode: 'ok', requests: [] }
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/__mode')) {
      state.mode = new URL(req.url, 'http://x').searchParams.get('m') ?? 'ok'
      res.writeHead(200).end('ok')
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      state.requests.push(raw)
      if (state.mode === '429') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'Rate limit reached' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (state.mode === 'empty') {
        res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 0 } }) + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const frames = [
        { choices: [{ delta: { content: ANSWER.slice(0, 20) } }] },
        { choices: [{ delta: { content: ANSWER.slice(20, 36) } }] },
        { choices: [{ delta: { content: ANSWER.slice(36) } }] },
        { choices: [], usage: { prompt_tokens: 132, completion_tokens: 39 } },
      ]
      let i = 0
      const tick = () => {
        if (i >= frames.length) {
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.write('data: ' + JSON.stringify(frames[i++]) + '\n\n')
        setTimeout(tick, 20)
      }
      tick()
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state })))
}
