/**
 * dock 图片输入的守卫（2026-09-20）。
 *
 * 这一批把**图片**加进了一条原本只跑文本的链路：剪贴板/拖拽/文件选择 → 浏览器压缩 →
 * data URL（localStorage + `<img src>`）→ 上送前折成 `{mime,data}` → 服务端校验 →
 * 上游 provider 折成 `image_url` 内容块。
 *
 * 每一跳都有"看起来能跑、其实静默丢掉"的失败形态，故这份用例按**边界**分组：
 *  ① 两个形态的互转（`data:<mime>;base64,…` ⇄ `{mime,data}`）——只有 base64 图片能过；
 *  ② 条数与 MIME 白名单的**两侧镜像**（浏览器与服务端各存一份，不能漂移）；
 *  ③ 上送边界：线上消息里**不得**出现 data URL 前缀；
 *  ④ 落盘：存不下时丢图保文字（不是整段放弃）；
 *  ⑤ 源码守卫：三个附件入口共用一条处理路径、工具名两半点名一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dataUrlOf,
  dataUrlToBlob,
  fileNameFor,
  fromTurnImages,
  humanBytes,
  IMAGE_KEEP_BYTES,
  IMAGE_MAX_BASE64_CHARS,
  IMAGE_MIME_WHITELIST,
  imageMarkdown,
  MAX_CONVERSATION_IMAGES,
  MAX_IMAGES_PER_TURN,
  MAX_IMAGE_INDEX,
  normalizeDockImages,
  parseImageSaveArgs,
  scaleToFit,
  splitDataUrl,
  toTurnImages,
  trimConversationImages,
} from '../ui/imagePlan.js'
import {
  buildTurnBody,
  initialDockState,
  loadConversations,
  saveConversation,
  titleOf,
  visionOf,
  withUserMessage,
  type MiniStore,
} from '../ui/dockPlan.js'
import { AI_TOOL_IMAGE_MAX_BYTES, AI_TOOL_IMAGE_MIME_WHITELIST } from '@geewiki/ai-tools'
import {
  IMAGE_MIME_WHITELIST as SERVER_MIME,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGES_PER_MESSAGE,
  parseTurnBody,
} from '../src/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(HERE, '..', rel), 'utf8')
const readRepo = (rel: string): string => readFileSync(join(HERE, '..', '..', rel), 'utf8')

/** 一张 1×1 PNG 的 base64 头。用真前缀而不是 `AAAA`：它同时验证 base64 形状判据 */
const PNG_DATA = 'iVBORw0KGgoAAAANSUhEUg'
const PNG_URL = dataUrlOf('image/png', PNG_DATA)

/* ===================== ① 两个形态的互转 ===================== */

test('① data URL ⇄ 线上形态：只有 `data:<mime>;base64,…` 能过', () => {
  assert.deepEqual(splitDataUrl(PNG_URL), { mime: 'image/png', data: PNG_DATA })
  assert.equal(dataUrlOf('image/png', PNG_DATA), PNG_URL)

  /*
   * 非 base64 的 data URL **必须**被拒。`data:text/html,<script>…` 是"把任意文本
   * 当图片塞进 `<img src>`"的入口，而这里根本没有非图片 data URL 的正当用途。
   */
  assert.equal(splitDataUrl('data:text/html,<script>alert(1)</script>'), null, '非 base64 的 data URL 不得通过')
  assert.equal(splitDataUrl('data:image/png;base64,aGk%20'), null, '带百分号转义（非裸 base64）不得通过')
  assert.equal(splitDataUrl('https://example.com/a.png'), null, 'http(s) 地址不是附件形态')
  assert.equal(splitDataUrl(''), null)
})

test('① `toTurnImages` 只放行白名单 MIME，且不放大写', () => {
  assert.deepEqual(toTurnImages([{ url: PNG_URL }]), [{ mime: 'image/png', data: PNG_DATA }])
  // svg 不在白名单：它能内联脚本，服务端与浏览器两侧都刻意不收
  assert.deepEqual(toTurnImages([{ url: dataUrlOf('image/svg+xml', 'PHN2Zz4=') }]), [], 'svg 不得进模型上下文')
  assert.deepEqual(toTurnImages([{ url: 'data:text/html;base64,PGI+' }]), [], '非图片 MIME 不得进模型上下文')
  assert.deepEqual(toTurnImages([{ url: 'not-a-url' }]), [], '坏数据跳过而不是抛错')
})

test('① `fromTurnImages` / `normalizeDockImages` 只收合法项（坏数据绝不抛）', () => {
  assert.deepEqual(fromTurnImages([{ mime: 'image/jpeg', data: 'aGk=' }]), [{ url: dataUrlOf('image/jpeg', 'aGk=') }])
  assert.deepEqual(fromTurnImages([{ mime: 'image/svg+xml', data: 'aGk=' }]), [], 'svg 在接收方向上也不收')
  assert.deepEqual(fromTurnImages([{ mime: 'image/png', data: 'not base64!' }]), [])
  assert.deepEqual(fromTurnImages('nope'), [])

  assert.deepEqual(normalizeDockImages([{ url: PNG_URL, name: '架构图.png' }]), [{ url: PNG_URL, name: '架构图.png' }])
  assert.deepEqual(normalizeDockImages([{ url: PNG_URL, name: '' }]), [{ url: PNG_URL }], '空名字不该变成一个字段')
  assert.deepEqual(normalizeDockImages([{ url: 'javascript:alert(1)' }]), [])
  assert.deepEqual(normalizeDockImages(null), [])
})

/* ===================== ② 两侧镜像 ===================== */

test('② ★ 镜像守卫：图片条数与 MIME 白名单在浏览器/服务端两侧逐字一致', () => {
  assert.equal(
    MAX_IMAGES_PER_TURN,
    MAX_IMAGES_PER_MESSAGE,
    '界面允许的张数必须等于服务端愿意收的张数（漂移的症状：界面让选 4 张、第 5 张 400）',
  )
  assert.deepEqual([...IMAGE_MIME_WHITELIST], [...SERVER_MIME], '两边的 MIME 白名单必须一致')
  // 源码级：确认真的是两处**独立**的字面量，而不是靠 import 蒙对（浏览器 import 不了服务端模块）
  assert.match(read('src/types.ts'), /export const MAX_IMAGES_PER_MESSAGE = 4\b/)
  assert.match(read('ui/imagePlan.ts'), /export const MAX_IMAGES_PER_TURN = 4\b/)
})

test('② `visionOf` 从严：任何不符合预期的形态都回 false（猜错的代价不对称）', () => {
  assert.equal(visionOf({ vision: true }), true)
  for (const bad of [null, undefined, 0, 'true', {}, { vision: false }, { vision: 'true' }, []]) {
    assert.equal(visionOf(bad), false, `${JSON.stringify(bad)} 必须回 false`)
  }
})

test('② ★ 工具侧的图片上限必须装得进核心的 base64 上限（否则工具以为给了、核心却丢了）', () => {
  const base64Len = Math.ceil(AI_TOOL_IMAGE_MAX_BYTES / 3) * 4
  assert.ok(
    base64Len <= MAX_IMAGE_BASE64_CHARS,
    `${AI_TOOL_IMAGE_MAX_BYTES} 字节 base64 后是 ${base64Len} 字符，超过核心上限 ${MAX_IMAGE_BASE64_CHARS}`,
  )
  assert.deepEqual(
    [...AI_TOOL_IMAGE_MIME_WHITELIST],
    [...SERVER_MIME],
    '工具侧与线协议必须是**同一份** MIME 白名单（真源在 @geewiki/ai-tools）',
  )
})

test('② ★ 数字自洽：单图上限 × 条数必须装得进请求体，且两侧镜像一致', () => {
  assert.equal(IMAGE_MAX_BASE64_CHARS, MAX_IMAGE_BASE64_CHARS, '单图 base64 上限两侧必须一致')
  const declared = /const MAX_BODY_BYTES = ([\d_]+)/.exec(read('src/index.ts'))?.[1]
  assert.ok(declared !== undefined, '读不到 MAX_BODY_BYTES（改名了？这条守卫要跟着改）')
  const body = Number(declared.replace(/_/g, ''))
  /*
   * 这三条是**一组**数字，任何一条单独改都会造出一个"界面说已发出、服务端 413"的窗口：
   * 单条消息的图、整段对话的图，都必须装得进请求体。
   */
  assert.ok(
    MAX_IMAGES_PER_TURN * IMAGE_MAX_BASE64_CHARS <= body,
    `单条消息的图（${MAX_IMAGES_PER_TURN} × ${IMAGE_MAX_BASE64_CHARS}）装不进请求体上限 ${body}`,
  )
  assert.ok(
    MAX_CONVERSATION_IMAGES * IMAGE_MAX_BASE64_CHARS <= body,
    `整段对话的图（${MAX_CONVERSATION_IMAGES} × ${IMAGE_MAX_BASE64_CHARS}）装不进请求体上限 ${body}`,
  )
})

/* ===================== ③ 上送边界 ===================== */

test('③ ★ `buildTurnBody`：界面 data URL 折成 `{mime,data}`，请求体里不得出现 data URL 前缀', () => {
  const body = buildTurnBody({
    messages: [{ role: 'user', content: '这张图里的流程对吗', images: [{ url: PNG_URL, name: 'a.png' }] }],
    clientTools: [],
    round: 0,
    page: null,
    conversationId: 'c1',
    turnId: 't1',
  })
  const first = body.messages[0]
  assert.deepEqual(first?.images, [{ mime: 'image/png', data: PNG_DATA }], '线上图片只有 mime+data 两个字段')
  // 字段集**逐字**比对：多出 `url`/`name` 就是"界面形态漏进了请求体"，服务端会因未知字段 400
  const wire = JSON.parse(JSON.stringify(first)) as Record<string, unknown>
  assert.deepEqual(Object.keys(wire).sort(), ['content', 'images', 'role'], '线上用户消息只带 role/content/images')
  assert.ok(
    !JSON.stringify(body).includes('data:image/'),
    '整个请求体里不得出现 data URL 前缀（服务端只认 {mime,data}，前缀会被 400 掉）',
  )
})

test('③ 服务端校验：只收白名单 MIME 的 base64，且只认 user 角色上的 images', () => {
  const ok = parseTurnBody({
    messages: [{ role: 'user', content: '', images: [{ mime: 'image/png', data: PNG_DATA }] }],
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok ? ok.value.messages[0]?.images : null, [{ mime: 'image/png', data: PNG_DATA }])

  const badMime = parseTurnBody({ messages: [{ role: 'user', content: 'x', images: [{ mime: 'image/svg+xml', data: 'aGk=' }] }] })
  assert.equal(badMime.ok, false, 'svg 必须被服务端拒绝')

  const badData = parseTurnBody({ messages: [{ role: 'user', content: 'x', images: [{ mime: 'image/png', data: 'not base64!' }] }] })
  assert.equal(badData.ok, false, '非 base64 载荷必须被拒绝')

  const onAssistant = parseTurnBody({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo', images: [{ mime: 'image/png', data: PNG_DATA }] },
    ],
  })
  assert.equal(onAssistant.ok, false, '只有用户能附图（助手消息带 images 是协议外的形态）')

  const tooMany = parseTurnBody({
    messages: [{ role: 'user', content: 'x', images: Array.from({ length: 5 }, () => ({ mime: 'image/png', data: PNG_DATA })) }],
  })
  assert.equal(tooMany.ok, false, `超过 ${MAX_IMAGES_PER_MESSAGE} 张必须 400`)
})

test('③ `withUserMessage` 只在真有图时挂 `images`；纯图会话标题是「图片」', () => {
  const withImg = withUserMessage(initialDockState(), '看这张', [{ url: PNG_URL }])
  assert.equal(withImg.messages[0]?.images?.length, 1)

  const noImg = withUserMessage(initialDockState(), '只有文字')
  assert.equal(noImg.messages[0]?.images, undefined, '没有图时不该挂一个空数组')

  assert.equal(titleOf(withUserMessage(initialDockState(), '', [{ url: PNG_URL }]).messages), '图片')
  assert.equal(titleOf(initialDockState().messages), '新对话')
})

/* ===================== ④ 落盘 ===================== */

test('④ ★ 配额降级：整段存不下时丢图片、保文字（而不是整段放弃）', () => {
  let stored: string | null = null
  const store: MiniStore = {
    getItem: () => stored,
    setItem: (_key, value) => {
      // 模拟 localStorage 配额：超过阈值就抛（真实实现抛 QuotaExceededError）
      if (value.length > 400) throw new Error('QuotaExceededError')
      stored = value
    },
  }
  const images = [{ url: dataUrlOf('image/png', 'A'.repeat(600)) }]
  const returned = saveConversation(store, 1, {
    id: 'c1',
    title: '看这张',
    updatedAt: 1,
    messages: [{ role: 'user', content: '你好', images }],
    notGrounded: [],
    webGrounded: [],
  })
  assert.equal(returned[0]?.messages[0]?.images?.length, 1, '返回给界面的那次保存仍带着图（本轮不受影响）')

  const back = loadConversations(store, 1)
  assert.equal(back.length, 1, '整段对话必须活下来')
  assert.equal(back[0]?.messages[0]?.content, '你好', '文字必须留下')
  assert.equal(back[0]?.messages[0]?.images, undefined, '图片是被降级丢掉的那一半')
})

test('④ ★ 整段对话最多保留 MAX_CONVERSATION_IMAGES 张图：新的留下、旧的丢图但文字保留', () => {
  let state = initialDockState()
  for (let i = 1; i <= MAX_CONVERSATION_IMAGES + 2; i += 1) {
    state = withUserMessage(state, `第 ${i} 张`, [{ url: PNG_URL }])
  }
  const withImages = state.messages.filter((m) => (m.images?.length ?? 0) > 0)
  assert.equal(withImages.length, MAX_CONVERSATION_IMAGES, '保留的张数必须正好等于上限')
  assert.equal(state.messages[state.messages.length - 1]?.images?.length, 1, '最新那张必须在')
  assert.equal(state.messages[0]?.images, undefined, '最旧那张的图被丢掉')
  assert.equal(state.messages[0]?.content, '第 1 张', '图丢了，那句话必须还在')
})

test('④ `trimConversationImages`：只动 images、不改文字；未超限时返回等值的新数组', () => {
  const msgs = [
    { role: 'user', content: 'a', images: [{ url: PNG_URL }, { url: PNG_URL }] },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c', images: [{ url: PNG_URL }, { url: PNG_URL }] },
  ]
  const trimmed = trimConversationImages(msgs, 3)
  assert.equal(trimmed[0]?.images?.length, 1, '从最新往回数满 3 张，最旧那条只留最后 1 张')
  assert.equal(trimmed[0]?.content, 'a')
  assert.equal(trimmed[2]?.images?.length, 2)
  const untouched = trimConversationImages(msgs, 4)
  assert.deepEqual(untouched, msgs)
  assert.notEqual(untouched, msgs, '返回的是新数组（调用方可能就地改）')
})

test('④ 超预算的单图在上送边界被丢掉（不静默发出一个注定 400 的载荷）', () => {
  const over = { url: dataUrlOf('image/png', 'A'.repeat(IMAGE_MAX_BASE64_CHARS + 4)) }
  assert.deepEqual(toTurnImages([over]), [], '超预算的图不得进请求体')
  const exact = { url: dataUrlOf('image/png', 'A'.repeat(IMAGE_MAX_BASE64_CHARS)) }
  assert.equal(toTurnImages([exact]).length, 1, '正好等于上限是允许的')
})

/* ===================== ⑤ 参数与工具面 ===================== */
test('⑤ `parseImageSaveArgs`：形状不对就拒绝，不猜不兜底', () => {
  assert.equal(typeof parseImageSaveArgs(null), 'string')
  assert.equal(typeof parseImageSaveArgs({}), 'string')
  assert.equal(typeof parseImageSaveArgs({ slug: '  ' }), 'string')
  assert.equal(typeof parseImageSaveArgs({ slug: 'a', index: 0 }), 'string', 'index 从 1 起')
  assert.equal(typeof parseImageSaveArgs({ slug: 'a', index: MAX_IMAGE_INDEX + 1 }), 'string')
  assert.deepEqual(parseImageSaveArgs({ slug: ' a ', index: 2, alt: '图' }), { slug: 'a', index: 2, name: '', alt: '图' })
  assert.deepEqual(parseImageSaveArgs({ slug: 'a' }), { slug: 'a', index: null, name: '', alt: '' })
})

test('⑤ `imageMarkdown` 不会让 alt 提前闭合标签', () => {
  assert.equal(imageMarkdown('/api/attachments/7', 'a]b'), '![a b](/api/attachments/7)')
  assert.equal(imageMarkdown('/api/attachments/7', '架构图'), '![架构图](/api/attachments/7)')
})

test('⑤ `scaleToFit` / `humanBytes` / `fileNameFor` / `dataUrlToBlob` 的边界', () => {
  assert.deepEqual(scaleToFit(800, 600), { width: 800, height: 600 }, '没超过长边就原样（绝不放大）')
  assert.deepEqual(scaleToFit(2560, 1440), { width: 1280, height: 720 })
  assert.deepEqual(scaleToFit(1440, 2560), { width: 720, height: 1280 })
  assert.deepEqual(scaleToFit(Number.NaN, 10), { width: 1, height: 1 }, 'NaN 不得变成 0 宽画布')

  assert.equal(humanBytes(512), '512 B')
  assert.equal(humanBytes(2048), '2.0 KB')
  assert.equal(humanBytes(IMAGE_KEEP_BYTES), '400.0 KB')
  assert.equal(humanBytes(-1), '0 B')

  assert.equal(fileNameFor({ url: PNG_URL }), 'image.png')
  assert.equal(fileNameFor({ url: dataUrlOf('image/jpeg', 'aGk=') }), 'image.jpg')
  assert.equal(fileNameFor({ url: PNG_URL, name: '截图' }), '截图.png', '原名没有扩展名时要补一个（服务端按最后一个点判）')
  assert.equal(fileNameFor({ url: PNG_URL, name: '截图.png' }), '截图.png')

  const blob = dataUrlToBlob(PNG_URL)
  assert.ok(blob !== null)
  assert.equal(blob?.type, 'image/png')
  assert.equal(dataUrlToBlob('data:text/html;base64,PGI+'), null)
})

test('⑤ ★ 工具名的两半点名同一个名字（服务端声明 ∩ 浏览器执行体）', () => {
  assert.match(read('ui/imageSave.ts'), /export const IMAGE_SAVE_TOOL_NAME = 'image\.save'/)
  assert.match(readRepo('plugin-ai-pages/src/index.ts'), /export const IMAGE_TOOL_NAMES = \['image\.save'\] as const/)
  assert.match(readRepo('plugin-ai-pages/src/index.ts'), /name: 'image\.save'/, '服务端必须真的贡献这条描述符')
  // 浏览器这一半必须真的登记进宿主工具表，否则描述符在、处理器不在 ⇒ 模型看不到它
  assert.match(read('ui/index.tsx'), /registerImageSaveTool\(host\)/, 'register() 必须登记 image.save 的执行体')
  // 上传端点与编辑页共用同一条路径（插件产物不能 import 宿主模块，故是字面量镜像）
  assert.match(read('ui/imageSave.ts'), /ATTACHMENT_UPLOAD_PATH = '\/api\/attachments\/'/)
  assert.match(
    readRepo('web/src/lib/attachmentPlan.ts'),
    /export const ATTACHMENT_URL_PREFIX = '\/api\/attachments\/'/,
    '附件端点前缀必须与宿主一致（那边是真源，这边是不能 import 的字面量镜像）',
  )
  assert.match(readRepo('web/src/api.ts'), /ATTACHMENT_URL_PREFIX/, '宿主上传必须真的用那条前缀')
})

/* ===================== ⑥ 源码守卫：三个入口一条路 ===================== */

test('⑥ ★ 选择 / 粘贴 / 拖拽三个入口都必须走同一条 `addFiles`', () => {
  const ui = read('ui/index.tsx')
  assert.match(ui, /const files = Array\.from\(e\.target\.files \?\? \[\]\)/, '文件选择入口')
  assert.match(ui, /onPaste=\{\(e\) => \{\s*const files = imageFilesFromDataTransfer\(e\.clipboardData\)/, '粘贴入口')
  assert.match(ui, /const onDrop = \(e: DragEvent\)/, '拖拽入口')
  assert.equal(
    (ui.match(/void addFiles\(/g) ?? []).length,
    3,
    '三个入口各自实现必然漂移（症状："截图能粘进来、拖进来不行"），必须只调 addFiles',
  )
  /*
   * 粘贴只在**真有图片**时拦截：无条件 `preventDefault()` 会把正常的文字粘贴吃掉，
   * 而那个 bug 只在粘贴文字时出现、与图片毫无关系，看起来像输入框坏了。
   */
  assert.match(ui, /if \(files\.length === 0\) return/, '没有图片时必须放行，不能吃掉文字粘贴')
})

test('⑥ 待发图片的预览条住在面板里，而不是那个固定 55px 的输入行里', () => {
  const ui = read('ui/index.tsx')
  const stripAt = ui.indexOf('className="gw-dock-attach-strip"')
  const panelAt = ui.indexOf('className="gw-dock-panel"')
  const rowAt = ui.indexOf('className="gw-dock-row"')
  assert.ok(stripAt > 0, '找不到待发图片条')
  /*
   * `.gw-dock-row` 是绝对定位的 55px 盒子、`.gw-dock-shell` 用 55px 下内边距给它让位。
   * 把图塞进那个盒子会撑破高度，连带弄坏"收起/展开是同一个盒子"这条不变量。
   */
  assert.ok(stripAt > panelAt && panelAt > 0, '预览条必须在面板之内')
  assert.ok(stripAt < rowAt || rowAt < panelAt, '预览条不得出现在输入行里面')
})

test('⑥ 提交按钮的禁用判据同时看文字与图片', () => {
  const ui = read('ui/index.tsx')
  assert.match(
    ui,
    /disabled=\{input\.trim\(\) === '' && pendingImages\.length === 0\}/,
    '只发图不写字也必须能提交',
  )
})

test('⑥ 压缩之后仍超预算的图必须当场拒绝（而不是挂上去、发出去、模型说没看到）', () => {
  const ui = read('ui/index.tsx')
  assert.match(
    ui,
    /wire\.data\.length > IMAGE_MAX_BASE64_CHARS/,
    'prepareImageFile 必须在压完之后按 base64 长度判一次',
  )
  assert.match(ui, /return `这张图太大/, '拒绝时必须给一句给人看的话')
})

test('⑥ ★ 拖进**非图片**文件也必须拦下默认行为（否则浏览器会导航去打开它、页面状态全丢）', () => {
  const ui = read('ui/index.tsx')
  const at = ui.indexOf('const onDrop = (e: DragEvent)')
  assert.ok(at > 0, '找不到 onDrop')
  const body = ui.slice(at, at + 900)
  assert.match(body, /if \(!dragHasFiles\(e\.dataTransfer\)\) return/, '只有认不出文件拖放时才放行')
  const preventAt = body.indexOf('e.preventDefault()')
  const pickAt = body.indexOf('imageFilesFromDataTransfer')
  assert.ok(preventAt > 0 && pickAt > preventAt, '必须先按"这是文件拖放"拦默认行为，再去挑图片')
})
