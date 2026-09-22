# GeeWiki 输入条图片输入 —— 设计说明与现状

> **状态**：图片输入能力**已实现**（代码在本工作区内，未提交）。本文 §2–§8 描述**当前实现**；仍未做的项集中在 §9。
> **读者**：项目所有者（非 LLM 专家）+ 实现者 + 评审者。专业术语首次出现时用一句白话解释。
> **定位一律以符号名为准**（如 `MAX_IMAGES_PER_MESSAGE`、`trimConversationImages`、`serializeMessage`、`IMAGE_SAVE_TOOL_NAME`），**不要把行号当判据**。
> **标注约定**：
> - **「已核实」** = 实际读过源码 / 跑过命令，结论就是该处代码的字面行为；
> - **「设计决策」** = 本文拍板、实现按此执行；
> - **「未做」** = 明确不在本批范围内（见 §9）。
>
> 相邻文档：附件本体（上传 / 下载 / 权限判定）的真源是 [attachments.md](./attachments.md)；
> AI 插件化（工具总线 / 客户端工具两半结构）的真源是 [ai-plugin-architecture.md](./ai-plugin-architecture.md)。

---

## 0. 一句话定位

给"只认文字"的输入条加一条**图片通道**：从剪贴板/拖拽/文件选择进入 → **原样**读成 data URL
（2026-09-21 起**不压缩**，见 §4）→ 随轮次请求发给上游模型（多模态）→ 存进本地对话历史；并给模型一条 **`image.save`** 工具，
让它在用户要求时把图**存进知识库某个页面的附件**。

**第二批（同日）补上了反方向**：模型现在也能**读**文章里已有的图（`read_image`，见 §11）——
在此之前它只看得到 `![说明](/api/attachments/42)` 这一行文字。

用户原话（2026-09-20）：

> 当前在dock栏还无法输入图片给ai，加一下此功能

随后与用户确认的三条口径（**这三条决定了全部形状**）：

| # | 问题 | 用户选择 |
|---|---|---|
| D1 | 图片怎么送到模型 | **多模态直发**（`image_url` + data URL 内容块），不走"先上传成附件再给 URL" |
| D2 | 是否随对话历史保存 | **保存**（localStorage） |
| D3 | 模型能不能把图存到服务器 | **要**——"比如说用户要求把图片插入进文章的时候" |

**第三批（2026-09-21）：把浏览器那一次压缩去掉。** 用户原话：

> 我希望照片上传后不会被压缩

当时确认的两条口径：范围＝**AI 助手 dock 的贴图**（wiki 附件那条链路**本来就不压**，无需改动）；
策略＝**完全不压、原图上传**（在看清代价之后选的）。代价与连带改动记在三处：
§2 第 2/3 跳（上传路径）、§4（那组必须同时成立的数字）、§6（落盘改用本地副本）。
未实测的风险面集中在 §9 L11–L13。

---

## 1. 为什么不能只做 D1（"直发"与"存起来"是两件事）

D1 让模型**看得见**图，但那只活在这一次请求里：上游不存储我们的会话，服务端也不存
（`done.messages` 是**回灌**，不是服务器上的记录）。所以"看得见"与"存得住"是两条独立的路径，
D3 必须另做一条工具。

反过来，**只做 D3 是不成立的**：附件下载端点的权限判据来自页面 ACL（[attachments.md](./attachments.md) §2），
而**上游 LLM 不是本站主体**——给它一个 `/api/attachments/<id>` 的 URL，它取不到图（没有 cookie），
而且**不会报错**，只会凭文字猜。那正是"看起来接上了、其实模型是瞎的"这一类缺陷。
**「已核实」** `packages/plugin-ai-assistant/src/loop.ts` 的 `toLlmMessages` 把图片折成
`data:${mime};base64,${data}` 的 data URL，正是因为这条路径不经过任何鉴权。

---

## 2. 一张图从剪贴板到模型：七跳（全部「已核实」）

| # | 位置 | 做什么 | 失败形态（这条链路上的"静默丢"很不均匀） |
|---|---|---|---|
| 1 | `ui/index.tsx` 的 `addFiles` | 三个入口（选择 / 粘贴 / 拖拽）**汇成一条** | 三条各自实现 ⇒ "截图能粘进来、拖进来不行" |
| 2 | `prepareImageFile` | 校验 MIME → **原样**读成 data URL（不缩放、不重编码）→ 按 `IMAGE_MAX_BASE64_CHARS` 判一次，超了**当场拒绝并说清是哪张、有多大**；大于 `IMAGE_PREVIEW_KEEP_BYTES` 才另生成一份**本地副本**（只进 localStorage） | 判据落在 `file.size` 而不是**真正发出去的载荷**上 ⇒ 用户看到图挂上了、发出去模型说没看到 |
| 3 | `DockImage { url, name?, preview? }` | 界面形态：`url` 是**原图** data URL，可直接进 `<img src>`；`preview` 只是落盘用的副本，**永不进请求体** | 副本混进 `url` ⇒ 用户以为传的是原图，模型收到的是 1280 的糊图 |
| 4 | `trimConversationImages`（在 `withUserMessage` 里） | 整段转录最多留 `MAX_CONVERSATION_IMAGES` 张图，**新的留下** | 不裁 ⇒ 请求体随图片数线性增长，几轮后 413 |
| 5 | `buildTurnBody` / `toWireMessages` | 折成线上形态 `{mime, data}`（`toTurnImages`） | 漏折 ⇒ data URL 前缀进请求体，服务端 400 |
| 6 | `parseTurnBody` / `parseImages`（服务端） | 只认 `role:'user'`、白名单 MIME、base64 形状与长度 | 只判形状不判 role ⇒ 上游 400，报错点离病因很远 |
| 7 | `toLlmMessages` → `serializeMessage`（`@geewiki/openai`） | 有图才把 `content` 折成内容块数组；无图**保持字符串** | 无脑折数组 ⇒ 存量调用方（问答/写作/摘要）前缀缓存全失效 |

**第 7 跳的取舍值得单说**：`LlmMessage.content` 仍然是 `string`，图片是**它旁边的可选字段**
`images?: readonly LlmImagePart[]`（`packages/core/src/llm.ts`）。**「设计决策」**刻意没把
`content` 改成"字符串 | 内容块数组"——那是一次破坏性契约变更，会让每个读 `content` 的存量消费方
都要改类型，而它们本来就不发图片。代价是多了一个可选字段要维护。

---

## 3. 契约：一条工具的两半

`image.save` 是典型的**客户端工具**（`packages/web/src/lib/clientTools.ts` 文件头）：

- **服务端说"它存在"**：`packages/plugin-ai-pages/src/index.ts` 贡献描述符，`side: 'client'`。
  名字常量 `IMAGE_TOOL_NAMES = ['image.save']`。
- **浏览器说"它在我这儿怎么跑"**：`ui/imageSave.ts` 的 `registerImageSaveTool(host)` 把执行体
  登记进宿主工具表，名字常量 `IMAGE_SAVE_TOOL_NAME`。

两半点名同一个名字，**任何一半缺席模型都看不到它**：`resolveTurnTools`
（`src/tools.ts`）只认"服务端已注册 ∩ 客户端声明会执行"的交集。

### 3.1 为什么执行体必须在浏览器（两个各自独立的理由）

1. **图片字节只在用户那一侧。** 用户完全可能在这一轮说"把刚才那张图存进 xx 页"，
   而那张图在**上一轮**的消息里；服务端手上的请求体只覆盖当前这一回合。
2. **上传端点本身就是权限判据的所在地。** 浏览器带着会话 cookie 走既有的
   `PUT /api/attachments/:slug`（`canEdit` + CSRF），与编辑页上传附件**完全同一条路径**——
   不新增"AI 专用的写入通道"，也就不存在第二套权限判据。

### 3.2 为什么 `image.save` **不是** `mutating`

它只**新增**一条附件行，不改动任何既有内容。用户真正要的"插进文章"由 `page.update` 落笔，
而那一条已经在变更日志里、可回退。标成 `mutating` 会让回退 UI 上多出一条点了没反应的条目
（与 `open_page` / `scroll_to` 不是 `mutating` 是同一条判据）。

### 3.3 一次"把图插进文章"的实际过程

```
用户：把这张图插进 guides/deploy 的「拓扑」一节
  → 模型调 image.save({ slug: 'guides/deploy', index: 1, alt: '部署拓扑' })
  → 工具 PUT 附件、返回 { url, markdown: '![部署拓扑](/api/attachments/42)', message }
  → 模型调 page.update({ slug, content })   ← 这一步才改正文，且在变更日志里
```

**「设计决策」**没有把两步合成一条工具：`image.save` 是"存资源"、`page.update` 是"改内容"，
两者的权限、幂等性、可回退性都不同；合成一条会造出一个"半成功"的状态
（附件存了、正文没改），而那种状态没有可回退的记录。

---

## 4. 上限：一组必须同时成立的数字

| 常量 | 值 | 在哪一层 | 防什么 |
|---|---|---|---|
| `IMAGE_MIME_WHITELIST` / `IMAGE_MIME_WHITELIST`（服务端） | png / jpeg / webp / gif | 两侧 | **刻意不含 SVG**：它是能被解释的文档，同源内联时可带脚本（附件层已因此不内联它） |
| `IMAGE_PREVIEW_KEEP_BYTES` | 512 KB | 客户端 | **只为本地副本**：小于它就不生成副本（一张 80 KB 的 PNG 转 JPEG 会变大、还丢透明通道） |
| `IMAGE_PREVIEW_MAX_EDGE` / `IMAGE_PREVIEW_JPEG_QUALITY` | 1280 px / 0.82 | 客户端 | 副本的尺寸——**只为 localStorage 与刷新后的显示**，与模型看到的那一份无关 |
| `MAX_IMAGES_PER_TURN` / `MAX_IMAGES_PER_MESSAGE` | 4 | 两侧镜像 | 单条消息塞几十张图 |
| `IMAGE_MAX_BASE64_CHARS` / `MAX_IMAGE_BASE64_CHARS` | 11M 字符（≈8.25 MB） | 两侧镜像 | "一张图吃掉整个预算"；**不压图之后，这是唯一的尺寸判据** |
| `MAX_CONVERSATION_IMAGES` | 4（**曾经是 8**） | 客户端 | **整段转录**的图（无状态协议每轮重发全部历史） |
| `MAX_BODY_BYTES` | 48 MB（**曾经是 16 MB**） | 服务端 | 总量；且**必须**存在（body 是整体缓冲后 `JSON.parse`） |

两条不等式由 `test/uiDockImage.test.ts` 的守卫钉住：

```
4 × 11M = 44M ≤ 48M      单条消息的图
4 × 11M = 44M ≤ 48M      整段对话的图
```

**这组数字在 2026-09-21 整体抬高过，因为用户要求「照片上传后不要被压缩」**（原话见 §0 之后）。
三点要害，任一条单独改都会让"不压缩"变成一句空话：

- **上传路径不再有第二次编码**。`prepareImageFile` 读出来是什么字节就发什么字节，
  于是尺寸判据只剩 `IMAGE_MAX_BASE64_CHARS` 一条——它必须按"手机相机原图直传"取值
  （JPEG 原图常见 2~5 MB、高分辨率 PNG 截图能到 8 MB），所以是 11M 字符 ≈ 8.25 MB。
  守卫 `② ★ 数字自洽` 直接钉住这一点：**解出来不足 8 MB 就是假承诺**。
- **单图 ×11 倍、总闸 ×3 倍 ⇒ 整段张数必须 8→4**。4 张原图 ≈ 当年 8 张压缩图的字节量，
  请求体的量级没变（44M ≤ 48M），代价变成"一轮里最多 4 张"。
- **没有选"抬总闸、保住 8 张"**：`8 × 11M = 88M` 的请求体要在服务端**整体缓冲**后再
  `JSON.parse`（`packages/plugin-ai-assistant/src/index.ts`），而 `MAX_CONCURRENT_STREAMS`(4)
  路并发就是几百 MB 的驻留缓冲。而且多贴几张原图并不会让模型更看得清——
  视觉模型收到大图自己会重采样（§9 L11），不压图的收益只在"人回看时清晰"，
  不在"模型多看出一点"。


**为什么 `MAX_CONVERSATION_IMAGES` 是"丢掉最旧的"而不是"报错"**：旧图被丢掉时**文字仍在**，
对话看起来仍然完整；而"不能再发图了"的报错会让用户以为功能坏了。这是一条**有损**取舍，
写在这里而不是埋在实现里：被丢掉的图在**当前这段转录的内存形态**里没有第二份（`image.save` 读的就是
这段转录；落盘那份是副本、且只服务于刷新后的显示，见 §6），所以它既不会再发给模型，
也不能再被存进知识库。真想留住某张图时，正确动作是**当场**让助手存下来。

**为什么裁在 `withUserMessage` 而不是"上送边界"**（「已核实」）：`applyTurnEvent` 的 `done` 分支
用 `messages: d.messages` **整个替换**本地转录。上送时才裁的话，服务端回灌的那份会把图丢掉、
而界面还留着，两边从此不一致——且不报错。

---

## 5. 校验：每一层只判它判得动的

- **服务端不解码 base64。** 判据是**字符数**与**形状**（`/^[A-Za-z0-9+/]+={0,2}$/`），
  不是"解码后是不是真的图片"：解一次 8 MB 的 base64 只为看看它合不合法，
  那正是拒绝服务最省事的入口。真正的类型判定落在**扩展名白名单**上（附件层）。
- **只允许 `role:'user'` 附图**（`parseMessage`）。assistant / tool 带图是协议上没有的形态，
  放行它会在上游 400，而报错点离病因很远。
- **`<img src>` 只吃 data URL 形态**：`splitDataUrl` 拒绝非 base64 的 data URL
  （`data:text/html,<script>…`）。`dataUrlToBlob` 再判一次白名单——它是"什么能变成上传字节"
  的最后一跳，而它的输入可能来自被改过的 `localStorage`。

---

## 6. 落盘：localStorage 的配额与降级

- 键空间沿用 `geewiki.ai.dock.v1`（按用户隔离，见 `dockPlan.ts`）。
- **「已核实」**读回来的每条消息都过 `normalizeDockImages`：坏数据一律丢弃，**绝不抛**
  （隐私模式与部分企业策略下访问 `localStorage` 会抛而不是返回 null）。
- **落盘写的是副本，不是原图**（`imagesForStorage`，2026-09-21）。`url` 是原图（2~8 MB 很常见），
  而 localStorage 通常只有 5 MB —— 把原图写进去的结局不是"存下来了"，是**配额降级把整段历史的图
  全丢掉**。所以 `saveConversation` 落盘前把每条消息的图换成 `preview`（没有副本就按原样存），
  存储形态仍是 `{url, name}`：读侧（`normalizeDockImages`、消息气泡、`image.save`）都不认识
  "副本"这个概念，`preview` 字段本身**绝不写进存储**。
  代价说清楚：**刷新之后**那一格里是副本，于是刷新后的 `image.save` 存的也是副本——
  这与"原图直传"之前逐字相同，不是新增的退化；要在刷新后还拿到原图，就在这一轮里当场存。
  由 `test/uiDockImage.test.ts` 的 `④ ★★ 落盘走副本、上送走原图` 钉住两侧。
- **配额降级**：`saveConversation` 在写入失败时**只丢图片、不丢文字**（`withoutImages`）。
  这是**第二道**降级（第一道是上面的"原图让位给副本"）。
  反过来（整段存不下就放弃）会让用户刷新后发现整段对话都没了，而"图没了、话还在"是一个可用形态。

---

## 7. 界面：三条硬约束

1. **三个入口一条路。** 文件选择、`onPaste`、拖拽都只调 `addFiles`（源码守卫数 `void addFiles(` 出现 3 次）。
   粘贴只在**真有图片**时 `preventDefault`——无条件拦截会把正常文字粘贴吃掉，而那个 bug
   与图片毫无关系，看起来像输入框坏了。
2. **预览条住在面板里，不在输入行里。** `.gw-dock-row` 是绝对定位的 55px 盒子、
   `.gw-dock-shell` 用 55px 下内边距给它让位（见 `style.css` 里那段实测说明）。
   往那个盒子塞图会撑破高度，连带弄坏"收起/展开是同一个盒子"这条不变量。
3. **拖拽悬停用 `data-dragging` 属性 + `rootRef` 上的 `addEventListener`，不用 JSX 属性。**
   原因不是偏好：`test/uiDockDismiss.test.ts` 与 `test/uiDockMotion.test.ts` 用源码文本
   **逐字**钉住了 `.gw-dock` 与 `.gw-dock-shell` 的起始标签，改 JSX 属性会当场弄红两条既有守卫。

---

## 8. 文件索引

| 文件 | 角色 |
|---|---|
| `packages/core/src/llm.ts` | `LlmImagePart` + `LlmMessage.images?`（契约；`tool` 角色也允许带图，见 §11） |
| `packages/core/src/services.ts` | `WikiAttachmentBytes` + `WikiService.readAttachment`（§11.3） |
| `packages/plugin-openai/src/provider.ts` | `serializeMessage`：有图才折内容块数组；`serializeMessages`：工具图片的 flush（§11.3） |
| `packages/plugin-wiki/src/index.ts` | `resolveAttachmentAccess` —— 下载端点与 `readAttachment` **共用**的判据 |
| `packages/plugin-ai-tools/src/types.ts` | `AiToolImage` + `AI_TOOL_IMAGE_MIME_WHITELIST` + `AI_TOOL_IMAGE_MAX_BYTES`（"什么算图片"的单一真源） |
| `packages/plugin-ai-kb/src/index.ts` | `read_page`（只数不取）/ `read_image` / `attachmentIdsIn` |
| `packages/plugin-llm/src/{types,index}.ts` | 转出 `LlmImagePart` |
| `packages/plugin-ai-assistant/src/types.ts` | 线上契约 `TurnImage` + 三个上限常量 + `parseImages` + `isAcceptableImage` |
| `packages/plugin-ai-assistant/src/index.ts` | `MAX_BODY_BYTES`（48 MB） |
| `packages/plugin-ai-assistant/src/loop.ts` | `toLlmMessages`（折 data URL + 挂工具图片）、`admitToolImages` |
| `packages/plugin-ai-assistant/ui/imagePlan.ts` | 纯逻辑：形态互转、上限、`trimConversationImages`、`parseImageSaveArgs` |
| `packages/plugin-ai-assistant/ui/imageSave.ts` | `image.save` 的浏览器执行体 |
| `packages/plugin-ai-assistant/ui/index.tsx` | 三个入口、压缩、预览条、消息里的图、登记工具 |
| `packages/plugin-ai-assistant/ui/style.css` | `.gw-dock-attach*` / `.gw-dock-msg-img*` / `[data-dragging]` |
| `packages/plugin-ai-pages/src/index.ts` | `image.save` 的服务端描述符（`side:'client'`） |
| `packages/plugin-ai-assistant/test/uiDockImage.test.ts` | 本功能的守卫（镜像 / 边界 / 源码） |
| `packages/plugin-ai-pages/test/imageTool.test.ts` | 描述符的守卫（名字 / side / 非 mutating / 匿名） |

---

## 9. 未做 / 已知限制

| # | 限制 | 后果与说明 |
|---|---|---|
| L1 | **没有跑过真实上游的视觉调用** | 全部验收停在"请求体正确"这一层。配置里的模型是否支持视觉、`detail` 缺省时的行为，**未实测**。若上游是纯文本模型，行为取决于对方网关（可能 400，也可能忽略 `image_url`） |
| L2 | **没有跑过浏览器端到端验收** | 剪贴板 / 拖拽 / 本地副本的生成只能在真浏览器里验；本批未跑 CDP 脚本（仓库既有脚本需要 Chrome 与已构建产物） |
| L3 | **图片是有损保留的** | 超过 `MAX_CONVERSATION_IMAGES`(**4**，曾经是 8) 之后旧图从转录里消失（文字保留），见 §4；落盘那一份另有两级降级（§6） |
| L4 | **SVG 不接受** | 见 §4；理由是它能带脚本，而不是"渲染不出来" |
| L5 | **模板 `image.save` 的 `index` 数的是整段对话**，不是单条消息 | 上界 `MAX_IMAGE_INDEX = 40` 只是防"模型填一个荒唐的数"；真范围按实际张数判 |
| L6 | **`image.save` 需要目标页的编辑权** | 没有编辑权时上传端点返回 404/403，工具把服务端的 `message` 原样回给模型 |
| L7 | **上传附件本身不可回退** | 它只新增一条附件行（§3.2）；"回退"覆盖的是 `page.update` 改的正文。孤儿附件由附件层的 GC 话题承接（[attachments.md](./attachments.md) §10，**同样未做**） |
| L8 | **没有图片编辑 / 标注 / OCR** | 只做"送进去 + 存起来" |
| L9 | ~~没有"当前模型支不支持图像输入"的前置判据~~ **已解决**（§11.8） | LLM 设置里的「支持图像输入」是一处开关、三处生效。**但它只是"人声明它支持"**：本仓不替你验证，打开而实际不支持时症状是上游 400 |
| L10 | **图片只在"当前回合"内可见于上下文** | 工具交上来的图不进权威转录（§11.5），所以下一轮提问时模型已经看不到它了——需要再看一次就得重新调 `read_image`。这是刻意的：进转录就意味着每轮重发与 localStorage 膨胀 |
| L11 | **原图 ≠ 模型看得更清** | 视觉模型收到大图后**自己会重采样**到它的输入尺寸（各家都有固定的 patch 预算）。所以"不压缩"买到的两样是**人回看时清晰**（消息气泡、`image.save` 存进知识库的那份字节）与**不做不可逆的有损变换**，而**不是**"模型多看出一点"。上游具体重采样到什么尺寸**未实测**（同 L1）。**代价要说清**：多数网关按图片尺寸 / tile 数计 token，原图往往**更贵**（同样未实测）——不压图买的是保真，不是省钱 |
| L12 | **不压图之后，上游那道闸我们看不见** | 本地只剩 `IMAGE_MAX_BASE64_CHARS` 一条尺寸判据（超了挂图时就当场拒绝）。各家 OpenAI 兼容网关对**单请求体**与**单图**另有上限，**具体值未实测**：本地放行、上游 400 是这次改动直接引入的风险面，症状是"图挂上了、回合报错、错误文案来自上游" |
| L13 | **原图直传的三项成本** | ① 服务端把请求体**整体缓冲**后 `JSON.parse`，最坏 4 路并发 × 48 MB ≈ 200 MB 驻留（§4）；② 一段对话最多 4 张图（曾经是 8）；③ **EXIF 方向不再被那次重编码顺手纠正**——手机竖拍的照片可能按传感器方向呈现（**未实测**，与 L1 同批验）。另外 HEIC/HEIF 仍被 MIME 白名单挡在门外（同 §4 的白名单，不是这次改的） |

---

## 10. 验证读数

- `pnpm run typecheck`：**26 个工作区项目全 Done，0 个 `error TS`**。
- `pnpm test`：**26 个包全部 `# fail 0`**，合计 **2475** 条（`@geewiki/ai-assistant` 266、
  `@geewiki/ai-pages` 40、`@geewiki/web` 976、`@geewiki/manager` 290、`@geewiki/plugin-wiki` 133、
  `@geewiki/ai-kb` 32、`@geewiki/openai` 76）。
- 新增守卫文件 2 个：`test/uiDockImage.test.ts`（22 条）、`test/imageTool.test.ts`（6 条）。
- 第二批另在既有测试文件里加了 12 条：`plugin-openai/test/provider.test.ts` 三条（flush 的
  形态 / 时机 / 末尾），`plugin-ai-assistant/test/loop.test.ts` 三条（图挂在 tool 消息上且
  不进转录 / 与线协议同一份校验 / 超限少给必说），`plugin-ai-kb/test/kb.test.ts` 六条
  （`attachmentIdsIn` / 只数不取 / `read_image` 的各条拒绝路径）。
- **两个既有守卫被有意更新**（不是绕过）：`test/uiDockContent.test.ts` 的「继续」按钮正则
  （`send()` 里多了一段清理待发图片的块）与 `test/uiDockIcons.test.ts` 的图标枚举
  （新增 `ImageIcon` / `RemoveIcon`）。两处都补了注释说明为什么这次变更是正当的。

---

## 11. 第二批：文章里的图（`read_image`）

### 11.1 问题

`read_page` / `search_kb` 交给模型的是**页面正文的 Markdown 文本**。文章里的图在正文里
就是这一行：

```
![部署拓扑](/api/attachments/42)
```

模型看到的是文字，不是像素。**把 URL 递给它也白搭**：附件下载的判据是页面 ACL + 块级投影，
而上游 LLM 不是本站主体（没有 cookie）——这与我当初不给 dock 图片用附件 URL 是**同一条理由**。

### 11.2 为什么不能"让工具把图作为结果返回"

OpenAI 兼容协议里 `image_url` 内容块**只允许出现在 `user` 消息上**，`tool` 角色的 messages
必须是纯文本。所以图片不可能直接躺在 tool 消息的 `content` 里。

### 11.3 方案（照搬 DSH 的分层）

DSH 的 `read_image` 工具与它的 `flushToolImages`（`packages/llm/llm-deepseek/src/serialize.ts`）
把这件事拆得很干净，本批照此实现：

| 层 | 说什么 | 落在哪 |
|---|---|---|
| 工具 | "我读到了一张图" | `AiToolResult.images`（`@geewiki/ai-tools`） |
| 会话核心 | "这条**工具结果**带着图" | `LlmMessage.images` + `role:'tool'` |
| 适配器 | "chat-completions 表达不了，我折成一条 user 消息" | `plugin-openai` 的 `serializeMessages` |

- **新工具 `read_image(id)`**（`@geewiki/ai-kb`）：模型**按需**调用。
  `read_page` 改成**只数不取**——只说"正文里引用了 N 张图片，要看用 read_image 传它的 id"。
  这与 DSH 的 `read_file`（文本）/ `read_image`（图）是同一种分工。
- **取字节**走新的 `WikiService.readAttachment(principal, id, { maxBytes })`：
  判据与 `GET /api/attachments/:id` 是**同一份实现**（`resolveAttachmentAccess`）。
  抽这一个函数是刻意的——两处各写一遍必然漂移，而漂移方向一旦是"放宽"，
  就是"正文里看不到的段落，附件却能读"且**不会报错**。
- **flush**：`serializeMessages` 把 tool 消息的图**攒起来**，在**下一条非 tool 消息之前**
  折成一条 user 消息（引导语 `TOOL_RESULT_IMAGE_TEXT`）。三条判据都有测试钉住：
  ① tool 消息只发字符串；② 一轮里多条 tool 消息必须**相邻**（中间插一条 user 会把
  `assistant.tool_calls` 的配对拆开）；③ 循环结束后要再 flush 一次，否则"最后一步是读图"
  这种最常见的形态会把图丢掉。

### 11.4 第一版做错了什么（记档）

第一版在**会话核心**里直接拼了一条"系统附注 + 图片"的 user 消息插进请求。
那**在线上是对的**，但分层是错的：它把"这个协议表达不了工具带图"这件**适配器的事**
写进了会话核心，于是会话核心的语义里凭空多出一种"不是用户说的 user 消息"。
DSH 的分层是：**内部模型说事实，适配器说方言**。改过来之后会话核心不再知道任何协议细节。

### 11.5 图片不进转录

转录（`TurnMessage[]`）是权威的，会随 `done.messages` 回给客户端、被原样存下、下一轮原样带回。
base64 图片进去就会：① 在界面上显示成"用户发过的图"；② 每轮重发一遍把请求体撑爆；
③ 挤爆 localStorage 配额。所以它只活在**发给上游那一份**里，用 `toolCallId` 索引
（`loop.ts` 的 `toLlmMessages(messages, toolImages)`）。

### 11.6 上限（两道上限，且**少给必须说出来**）

| 常量 | 值 | 在哪 |
|---|---|---|
| `AI_TOOL_IMAGE_MIME_WHITELIST` | png / jpeg / webp / gif | `@geewiki/ai-tools`（**本仓关于"什么算图片"的单一真源**，线协议与工具侧共用） |
| `AI_TOOL_IMAGE_MAX_BYTES` | 1 MB | 同上；base64 后 ≈1.33 M 字符 ≤ 核心的 11 M。**刻意不跟着"原图直传"抬高**：那是模型**自己截的屏**，不是用户的照片，1 MB 早就够用 |
| `MAX_TOOL_IMAGES_PER_RESULT` | 4 | `loop.ts` |
| `MAX_TURN_TOOL_IMAGES` | 8 | `loop.ts` |

`admitToolImages` 把两道上限一起算，**并且把"少给了几张"写进工具结果的文本里**。
第一版把单条上限写在 `sanitizeToolImages` 里，超过 4 张时**静默**丢掉——而工具已经在自己的
`content` 里写了"已附上 6 张"，模型据此以为看全了。这与 `truncateResult` 是同一条纪律：
**少给可以，静默少给不行**。

### 11.7 权限：拒绝回复是 `id` 的纯函数

`read_image` 对五类拒绝（不存在 / 页面无权 / 只出现在你看不到的受限段落里 / 字节缺失 /
超过体积上限）回**同一句话**。这不是措辞讲究：附件 id 是连续整数、可枚举，一旦按原因分叉，
这条工具就成了存在性/受限探测接口（下载端点当初把 403 改成 404 正是为此）。

守卫的判据不是"措辞里不许出现某些词"，而是**这句话里不能携带原因**：工具在拒绝路径上
只有 `id` 一个输入，所以只要证明"回复是 id 的纯函数"，就证明了它**在结构上无法**按原因分叉。

### 11.8 能力开关：`supportsVision`（同日第三批）

第一版**没有**"当前模型支不支持图像输入"的判据，只能靠工具描述里写一句"要求模型支持图像输入"。
那不够：模型看不到图时，`read_image` 会调、会拿到一张自己读不懂的图，然后**凭文件名编内容**——
这条链路上没有任何一处会报错。

DSH 的做法是查路由的 `inputModalities`（`assertImageCapableRoute`），而**本仓没有模态元数据**：
`LlmRouteDescriptor` 里没有这一项，OpenAI 兼容协议也没有任何字段能问出这件事（`/models`
只回 id 列表，真正的模态信息在服务商文档里）。既然探测不到，就**让配模型的人说清楚**——
他本来就知道自己接的是哪个模型。

**一处开关（LLM 设置 →「支持图像输入」），三处生效：**

| 生效点 | 不声明时的行为 |
|---|---|
| 输入条的图片按钮 | **不渲染**（`capabilities` 端点的 `vision` 字段下发；界面缺省从严） |
| `read_image` 工具 | **不进模型的工具表**；`read_page` 的提示同时改成"你看不到这些图，不要臆测" |
| `POST /api/ai/turn` | 客户端仍塞了图 ⇒ **400 `vision_unsupported`** + 一句可执行的指引 |

**缺省为什么是 `false`**：猜错的代价不对称。猜"支持"而实际不支持 ⇒ 上游 400、**整轮失败**；
猜"不支持"而实际支持 ⇒ 少一个入口，且设置里就写着怎么打开。与 `LlmMessage.images` 的
"只认 data URL"、附件的"扩展名白名单"是同一条纪律。

**为什么由插件自己问、而不是让宿主把能力塞进插槽 props**：这是"本插件自己那条链路的配置"，
不是宿主才有的事实（路由、身份、客户端工具名单才是）。宿主契约每加一个字段要同步三处镜像
与两条守卫，为一件插件内部的事付那个代价不划算。

### 11.9 未做

- **上游到底收不收图仍未实测**（§9 的 L1）。开关只表达"人声明它支持"，
  本仓**不替你验证**这一点：打开开关而模型其实不支持时，症状是上游 400。
- **开关不随模型自动变化**：换了模型要重新确认这一项。做成"按模型记忆"需要一张
  模型→能力表，而那张表没有任何权威来源，只会变成一个会过期的猜测。
