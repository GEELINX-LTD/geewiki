/**
 * `editor.*` 客户端工具测试（P3 宿主侧）。
 *
 * 这里要钉住的核心事实是**"能力不存在"必须是"工具不在名单里"，而不是"调用时静默失败"**：
 * 插件编辑器占住 `editor` 插槽时宿主没有句柄，此时那三条工具**根本不登记**——
 * 于是它们既上送不到服务端、也进不了模型看到的工具表，模型压根不会去调。
 * 与之相对的错误形态是"登记一个什么都不做的假函数"，它会让模型以为改成功了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientToolNames, invokeClientTool } from '../src/lib/clientTools'
import {
  EDITOR_DOC_MAX_CHARS,
  EDITOR_TOOL_NAMES,
  registerEditorTools,
  type EditorCapability,
} from '../src/lib/editorTools'

/** 一个"完整的"编辑框：四条工具全都该登记 */
function fullCapability(overrides: Partial<EditorCapability> = {}): {
  capability: EditorCapability
  writes: string[]
} {
  const writes: string[] = []
  const capability: EditorCapability = {
    slug: 'demo',
    readOnly: false,
    docText: () => '正文',
    selection: () => ({ text: '选中的', from: 0, to: 3 }),
    insertAtCursor: (text) => {
      writes.push(`insert:${text}`)
    },
    replaceSelection: (text) => {
      writes.push(`replace:${text}`)
      return true
    },
    ...overrides,
  }
  return { capability, writes }
}

test('能力齐全时四条工具全部登记，注销后全部消失', () => {
  const { capability } = fullCapability()
  const off = registerEditorTools(capability)
  assert.deepEqual(clientToolNames(), [...EDITOR_TOOL_NAMES].sort())
  off()
  assert.deepEqual(clientToolNames(), [])
})

/*
 * 本文件里最重的一条：**插件编辑器路径下不得出现写工具**。
 * 登记的判据是"宿主有没有句柄"，而不是"当前有没有选区"——后者会让工具随光标闪烁。
 */
test('没有句柄（插件编辑器路径）时只登记 editor.read_doc 一条', () => {
  const off = registerEditorTools({
    slug: 'demo',
    readOnly: false,
    docText: () => '正文',
    selection: null,
  })
  assert.deepEqual(clientToolNames(), ['editor.read_doc'])
  off()
})

test('没有句柄时 editor.insert_text 是"未登记"而不是"登记了但不动"', async () => {
  const off = registerEditorTools({
    slug: 'demo',
    readOnly: false,
    docText: () => '正文',
    selection: null,
  })
  await assert.rejects(
    () => invokeClientTool('editor.insert_text', { text: 'x' }),
    /未登记/,
    '写工具必须在名单外——登记假函数会让模型以为改成功了',
  )
  off()
})

test('editor.read_doc 每次调用读的是**当时**的正文，不是登记那一刻的快照', async () => {
  let text = '第一版'
  const off = registerEditorTools({
    slug: 'demo',
    readOnly: false,
    docText: () => text,
    selection: null,
  })
  assert.equal((await invokeClientTool('editor.read_doc', {}) as { text: string }).text, '第一版')
  text = '第二版'
  assert.equal(
    (await invokeClientTool('editor.read_doc', {}) as { text: string }).text,
    '第二版',
    '存快照的话模型读到的会是"注册那一刻的正文"——一个看起来正常、其实错位的结果',
  )
  off()
})

/*
 * 截断必须**说出来**：同 `read_page` 的纪律。探针 E4 的病因正是静默截断——
 * 模型把"我没看到"当成了"资料里没有"。
 */
test('editor.read_doc 超长时截断并在结果里写明', async () => {
  const long = 'x'.repeat(EDITOR_DOC_MAX_CHARS + 500)
  const off = registerEditorTools({
    slug: 'demo',
    readOnly: false,
    docText: () => long,
    selection: null,
  })
  const result = (await invokeClientTool('editor.read_doc', {})) as {
    text: string
    chars: number
    truncated: boolean
    hint?: string
  }
  assert.equal(result.chars, long.length, 'chars 报的是全文长度，不是截断后的长度')
  assert.equal(result.text.length, EDITOR_DOC_MAX_CHARS)
  assert.equal(result.truncated, true)
  assert.match(result.hint ?? '', /不要据此断言/)
  off()
})

test('editor.read_selection 无选区时给 null，不抛错（"没选中"是正常状态）', async () => {
  const off = registerEditorTools(fullCapability({ selection: () => null }).capability)
  assert.deepEqual(await invokeClientTool('editor.read_selection', {}), { selection: null, empty: true })
  off()
})

test('editor.insert_text 把文本交给句柄', async () => {
  const { capability, writes } = fullCapability()
  const off = registerEditorTools(capability)
  const result = (await invokeClientTool('editor.insert_text', { text: '新增' })) as {
    ok: boolean
    insertedChars: number
  }
  assert.deepEqual(writes, ['insert:新增'])
  assert.deepEqual(result, { ok: true, insertedChars: 2 })
  off()
})

/*
 * `args` 来自**模型**，也就是外部输入。三个拒绝分支对应三种会被静默吞掉的错误输入：
 * 不是对象 / text 不是字符串 / text 为空。
 */
test('editor.insert_text 拒绝畸形参数，且拒绝发生在写入之前', async () => {
  const { capability, writes } = fullCapability()
  const off = registerEditorTools(capability)
  await assert.rejects(() => invokeClientTool('editor.insert_text', null), /JSON 对象/)
  await assert.rejects(() => invokeClientTool('editor.insert_text', { text: 42 }), /必须是字符串/)
  await assert.rejects(() => invokeClientTool('editor.insert_text', { text: '' }), /不得为空/)
  assert.deepEqual(writes, [], '三次畸形输入一次都不该碰到句柄')
  off()
})

/*
 * 保存中写入会被随后的保存覆盖 —— 这是**静默丢修改**，必须拒绝并说明"等保存完成"，
 * 而不是无声吞掉。
 */
test('保存中拒绝写入，且理由与"能力不存在"可区分', async () => {
  const { capability, writes } = fullCapability({ readOnly: true })
  const off = registerEditorTools(capability)
  await assert.rejects(() => invokeClientTool('editor.insert_text', { text: 'x' }), /正在保存中/)
  await assert.rejects(() => invokeClientTool('editor.replace_selection', { text: 'x' }), /正在保存中/)
  assert.deepEqual(writes, [])
  off()
})

test('editor.replace_selection 在无选区时拒绝，并指向 editor.insert_text', async () => {
  const { capability, writes } = fullCapability({ selection: () => null })
  const off = registerEditorTools(capability)
  await assert.rejects(
    () => invokeClientTool('editor.replace_selection', { text: 'x' }),
    /没有选中任何文本.*insert_text/s,
  )
  assert.deepEqual(writes, [], '无选区时不得落到句柄上（那会变成一次静默的插入）')
  off()
})

test('editor.replace_selection 报出被替换与写入的字符数', async () => {
  const { capability, writes } = fullCapability()
  const off = registerEditorTools(capability)
  const result = await invokeClientTool('editor.replace_selection', { text: '改后的' })
  assert.deepEqual(writes, ['replace:改后的'])
  assert.deepEqual(result, { ok: true, replacedChars: 3, insertedChars: 3 })
  off()
})

test('句柄说替换没生效时报错，不谎报成功', async () => {
  const off = registerEditorTools(fullCapability({ replaceSelection: () => false }).capability)
  await assert.rejects(() => invokeClientTool('editor.replace_selection', { text: 'x' }), /替换未生效/)
  off()
})

test('注销是幂等的，重复调用不会误删后登记的同名工具', () => {
  const first = fullCapability()
  const off = registerEditorTools(first.capability)
  off()
  off()
  const second = fullCapability()
  const off2 = registerEditorTools(second.capability)
  assert.deepEqual(clientToolNames(), [...EDITOR_TOOL_NAMES].sort())
  off2()
})
