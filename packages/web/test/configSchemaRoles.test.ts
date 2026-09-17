/**
 * 配置 schema 载荷 → 表单字段描述：本批新增的两种角色。
 *
 * 为什么单独成文件：`describeRoot` 是"schema 驱动表单"的**唯一翻译层**，
 * 而 `role` 的取值直接决定用户能不能安全地填一个密钥（`secret` → 写一次、不可回读）
 * 以及服务商下拉是不是**运行期**的（`llm-provider` → 装了新适配器就多一个选项，
 * 不需要改任何代码）。这两条一旦在翻译层漏掉，界面上表现是"字段变成了普通文本框"——
 * 功能看着还在，安全属性却没了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConfigSchemaPayload } from '../src/api'
import { describeRoot, hasDynamicOptions } from '../src/lib/configSchema'

function payload(refs: ConfigSchemaPayload['refs']): ConfigSchemaPayload {
  return { uid: 0, refs }
}

const LLM_LIKE = payload({
  '0': {
    type: 'object',
    dict: {
      provider: 1,
      apiKey: 2,
      model: 3,
      extraBody: 4,
      apiKeyEnv: 5,
      reasoningEffort: 6,
      contextWindow: 7,
      timeoutMs: 8,
    },
  },
  '1': { type: 'string', meta: { role: 'llm-provider', description: '模型服务商' } },
  '2': { type: 'string', meta: { role: 'secret', description: 'API 密钥' } },
  '3': { type: 'string', meta: { role: 'llm-model', description: '模型名' } },
  '4': { type: 'string', meta: { role: 'textarea', description: '额外请求体', collapse: true } },
  '5': { type: 'string', meta: { role: 'password', description: '密码框语义（仅界面遮罩）', collapse: true } },
  '6': { type: 'string', meta: { role: 'llm-effort', description: '思考强度' } },
  '7': { type: 'number', meta: { description: '上下文窗口' } },
  '8': { type: 'number', meta: { description: '超时', collapse: true } },
})

test('role=secret：标记为"写一次、不可回读"，且用密码输入框', () => {
  const root = describeRoot(LLM_LIKE)
  const apiKey = root.fields?.find((f) => f.label === 'apiKey')
  assert.ok(apiKey)
  assert.equal(apiKey.writeOnlySecret, true, '服务端不回显 → 表单必须按"留空 = 不修改"渲染')
  assert.equal(apiKey.secret, true, '同时是密码输入框（避免肩窥与截图泄露）')
  assert.equal(apiKey.note, undefined, '已知角色不得再标 role=secret 的调试提示')
})

test('role=llm-provider：标记为动态下拉（选项来自运行期注册的适配器）', () => {
  const root = describeRoot(LLM_LIKE)
  const provider = root.fields?.find((f) => f.label === 'provider')
  assert.ok(provider)
  assert.equal(provider.dynamicOptions, 'llm-providers')
  assert.equal(provider.kind, 'text', '未取到选项时退化为文本输入，仍可手工填写')
  assert.equal(provider.note, undefined)
})

test('role=llm-model：模型名可以"清单下拉 + 手填"，不是封闭枚举', () => {
  const root = describeRoot(LLM_LIKE)
  const model = root.fields?.find((f) => f.label === 'model')
  assert.ok(model)
  assert.equal(model.dynamicOptions, 'llm-models')
  assert.equal(model.kind, 'text', '必须仍是文本输入：清单里没有的模型（灰度、私有别名）照样要能填')
  assert.equal(model.note, undefined, '已知角色不得留调试提示')
})

test('role=llm-effort：思考强度给档位候选，但值仍是自由文本', () => {
  const root = describeRoot(LLM_LIKE)
  const effort = root.fields?.find((f) => f.label === 'reasoningEffort')
  assert.ok(effort)
  assert.equal(effort.dynamicOptions, 'llm-efforts')
  assert.equal(effort.kind, 'text', '各家网关档位名不统一（minimal / extra-high），收成枚举等于禁掉自定义')
})

test('collapse：调优项被标记为"收进高级选项"，主表单字段不带此标记', () => {
  const root = describeRoot(LLM_LIKE)
  const byLabel = new Map((root.fields ?? []).map((f) => [f.label, f]))
  assert.equal(byLabel.get('timeoutMs')?.collapse, true, '超时属于高级项')
  assert.equal(byLabel.get('extraBody')?.collapse, true, '额外请求体属于高级项')
  assert.equal(byLabel.get('contextWindow')?.collapse, undefined, '上下文长度是主表单字段，不得被折起来')
  // 折叠只是"不显示在第一屏"：控件类型必须保持不变，展开后要能正常编辑
  assert.equal(byLabel.get('timeoutMs')?.kind, 'number')
  assert.equal(byLabel.get('extraBody')?.kind, 'textarea')
})

test('role=password 与 role=textarea 的既有语义不变（不得被本批改动带偏）', () => {
  const root = describeRoot(LLM_LIKE)
  const env = root.fields?.find((f) => f.label === 'apiKeyEnv')
  assert.equal(env?.secret, true, 'password = 界面遮罩（值仍会随配置返回，语义与 secret 不同）')
  assert.equal(env?.writeOnlySecret, undefined)
  const extra = root.fields?.find((f) => f.label === 'extraBody')
  assert.equal(extra?.kind, 'textarea')
})

test('未知 role 仍标注提示（改动前的诊断行为不得丢）', () => {
  const root = describeRoot(
    payload({
      '0': { type: 'object', dict: { weird: 1 } },
      '1': { type: 'string', meta: { role: 'no-such-role' } },
    }),
  )
  assert.equal(root.fields?.[0]?.note, 'role=no-such-role')
})

test('hasDynamicOptions：在字段树里递归识别（决定"要不要去拉服务商列表"）', () => {
  assert.equal(hasDynamicOptions(describeRoot(LLM_LIKE), 'llm-models'), true, '模型清单也要据此触发一次探测')
  assert.equal(hasDynamicOptions(describeRoot(LLM_LIKE), 'llm-efforts'), true)
  assert.equal(hasDynamicOptions(describeRoot(LLM_LIKE), 'llm-providers'), true)
  assert.equal(hasDynamicOptions(describeRoot(LLM_LIKE), 'llm-providers'), true)
  const nested = describeRoot(
    payload({
      '0': { type: 'object', dict: { group: 1 } },
      '1': { type: 'object', dict: { provider: 2 } },
      '2': { type: 'string', meta: { role: 'llm-provider' } },
    }),
  )
  assert.equal(hasDynamicOptions(nested, 'llm-providers'), true, '嵌套字段组里也要能找到')
  const listNested = describeRoot(
    payload({
      '0': { type: 'object', dict: { items: 1 } },
      '1': { type: 'array', inner: 2 },
      '2': { type: 'object', dict: { provider: 3 } },
      '3': { type: 'string', meta: { role: 'llm-provider' } },
    }),
  )
  assert.equal(hasDynamicOptions(listNested, 'llm-providers'), true, '列表元素里也要能找到')

  const plain = describeRoot(
    payload({
      '0': { type: 'object', dict: { model: 1 } },
      '1': { type: 'string', meta: { description: '模型名' } },
    }),
  )
  assert.equal(hasDynamicOptions(plain, 'llm-providers'), false, '普通插件不应触发多一次请求')
})
