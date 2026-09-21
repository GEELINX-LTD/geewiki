# GeeWiki 块级归属（这一段最后由谁、什么时候编辑） —— 设计说明

> **用户原话**：「我希望能显示块在什么时候由哪一位用户编辑能标识出来」
>
> 本文是实现**之后**补写的设计真源，记录的是**当前**实现口径：表结构与写入规则（§3/§4）、
> 服务端投影与下发的形状（§5/§6）、阅读页的两道翻译（§7）与界面约束（§8）。
> 逐批历史见 [../changelog/implementation-log.md](../changelog/implementation-log.md)，
> 块模型的**权限**那一半（可见性 / tier / 授权 / 投影）见
> [access-control.md](./access-control.md) §2.2 / §3.6 / §4 —— 本文只加**归属**，不改权限。

## 0. 一句话定位

**每个内容块记住"最后一次改动它的主体"（`blocks.updated_by` + `blocks.updated_at`），
阅读页把这句话挂在每一段上（悬停/聚焦时显示「最后由 X 编辑 · 3 天前」）。**

只记**最后一次**：这不是块级历史，也不打算成为块级历史（§10）。

### 0.1 用户已拍板的三条（本文的输入，不再讨论）

| 裁决 | 选定 | 当时的其它选项 |
| --- | --- | --- |
| 显示位置 | **阅读页**每段悬停显示 | 编辑页 / 版本对比对话框 / 治理面板 |
| 粒度 | **只记最后一次**（覆盖式） | 完整块级历史（新表 + 每次保存写一行） |
| 作者名的可见范围 | **登录用户看真名，匿名访客看「另一位成员」** | 一律只显示「某位成员」 |

第三条之所以成立：`GET /api/org/members` 本来就是 `{access:'user'}`（登录才能读），
对**已登录**主体显示真名**不新增可枚举面**；而对匿名读者，「另一位成员」与
版本列表的既有口径（`packages/web/src/lib/authorText.ts` 的 `HIDDEN_AUTHOR`）逐字一致。

## 1. 术语表（先看这个）

| 词 | 含义 |
| --- | --- |
| **块（block）** | `parseBlocks()` 按**空行**切出来的一段（`packages/plugin-wiki/src/blocks.ts`）。它同时是权限单位、索引单位，现在也是归属单位 |
| **单元 / 区间（unit）** | 服务端投影时，某个可见块在**投影后正文**里占据的 `[start, end)` 字符区间 |
| **段（segment）** | 前端把单元对齐到**实际渲染的那份 Markdown** 之后的产物（区间可能因为标题被剥掉而平移） |
| **组（group）** | 渲染后**共用同一个 DOM 节点**的若干连续段（松列表 / 链接引用定义，见 §7.2）。归属只能按组给 |
| **盖章** | 写入时把 `updated_at` + `updated_by` 一起写成"这次 + 这个人" |
| **占位段** | 连续受限块合并成的那一行 `> 🔒 此处有 N 段内容…`。它不是任何人的作品，**没有归属** |

## 2. 现状缺口（动手前的实测）

- `blocks` 自 0015 起就有 `created_at` / `updated_at`，但**没有作者列**；
  0019 给 `page_versions` 补 `saved_by` 时已经把这件事写进迁移注释：
  「'谁编辑了正文'在本仓库里查不到」。
- 0019 补的是**页级**（每次保存的触发者，进版本时间线）。页级字段回答不了
  "这一段是谁写的" —— 一页里这一段和那一段可以不是同一个人改的。
- 更坏的是 `updated_at` 的**旧语义**：`syncBlocksForPage` 的 UPDATE 分支当时
  **无条件**写 `updated_at = now`，于是复用旧 id 的块即使一个字都没改，时间戳也被刷新。
  那个值只能说"这一页被保存过"，拿它当"这一段最近被编辑于"就是撒谎。

## 3. 数据模型：`0024_block_author.sql`

两侧方言成对（`packages/db-sqlite/src/migrations/0024_block_author.sql` +
`packages/db-postgres/migrations/0024_block_author.sql`），语句同形：

```sql
ALTER TABLE blocks ADD COLUMN updated_by INTEGER;
```

### 3.1 一列，三条约定

与 0019 `page_versions.saved_by` **逐条一致**（不是巧合，是同一件事的块级版本）：

1. **无外键**——用户被删除后条目与历史必须留存，外键会把"删用户"变成"删内容归属"；
   因此 id 可能指向一个已不存在的账号，读侧按"查不到就当未知"处理（`blockAuthorFor`）。
2. **允许 NULL**——`syncBlocksForPage` 是**跨插件服务路径**（内置文档同步、AI 代写、
   存量回填都经过它），这类写入没有可归属的主体；写 NULL 比编一个假 id 诚实。
3. **与 `updated_at` 同一时刻写入**——所以读侧把「谁 + 什么时候」当成一条改动来用是成立的。

### 3.2 ★ `blocks.updated_at` 的语义收紧（本次的契约变更）

`updated_at`：**"这个块的文本真的变了"**（此前 = "这一页被保存过"）。

规则落在 `syncBlocksForPage` 里：复用旧 id 的块，用旧行的 `contentHash` 与新块的
`contentHash` 比对——

- **相同 ⇒ 两列都不写**（保留原值），只重写 ordinal / kind / text / visibility /
  inherit / marker / content_hash / tier；
- **不同 ⇒ 两列一起写成"这次 + 这个人"**；新插入的块同样带这两列。

判据是 `contentHash` 而不是"复用了旧 id"：`planBlockSync` 的三种配对
（LCS 配对 / 同序号配对 / 新插入）后两种都会复用旧 id 却带着新文本 ⇒ "复用"推不出"没改"。

### 3.3 与 0019 的对照

| | `page_versions.saved_by`（0019） | `blocks.updated_by`（0024） |
| --- | --- | --- |
| 粒度 | 每次保存一条历史 | 每个块**覆盖式**一行 |
| 记的是 | 本次改动的**触发者** | 最后一次**改动这个块文本**的主体 |
| 时间列 | `saved_at`（同刻写入） | `updated_at`（同刻写入，语义已收紧） |
| 读侧 | 版本时间线，`authorText()` 三档 | 阅读页逐段标签，`blockAuthorFor()` 三档（§6.1） |

### 3.4 刻意**不回填**

本迁移之前写入的块行：`updated_at` 是最后一次页面保存的时刻（**可能晚于**该块真实的
最后改动），`updated_by` 为 NULL ⇒ 读侧**不显示归属**，直到该块下次真的被改动。

没有可靠来源可以回填出一个正确的作者——编一个比留空更坏。这与 0019 对历史行的处置同款。

## 4. 写入路径

唯一写块路径是 `syncBlocksForPage()`（`packages/plugin-wiki/src/blocks.ts`），
本批新增**必填**参数 `actorId: number | null`。

- **必填**（不是可省略的可选参数）：与 `existing` / `syncIndex` 同一条纪律——
  让每个调用点**显式写下**"这次是谁改的"。`null` 是合法答案（存量回填、跨插件代调用、
  导入脚本），但它必须是一个**写下来的决定**，而不是一次遗忘：漏传在**编译期**报错。
- 5 个调用点（全在 `packages/plugin-wiki/src/index.ts`）：
  - `savePage()` 的新建分支 / 更新分支 → `actorId ?? null`（`savePage` 的签名末位本来就收它）；
  - 存量回填 → `null`（无主体）；
  - **两条"恢复版本"路径 → 真实 `actorId`**：恢复是一次**真实的改动**（内容确实变了），
    所以它盖的是"恢复操作者 + 恢复时刻"，而不是把归属留在被恢复的那一版上。

## 5. 服务端投影：单元与区间

`projectBlocks()` 是**服务端投影的唯一出口**（受限块的 text 必须在序列化前消失）。
本批让它顺手算出每个可见块在投影后正文里的区间：

```ts
interface ProjectedUnit { start: number; end: number; gated: boolean; updatedAt: string | null; updatedById: number | null }
interface ProjectedContent { text: string; gatedCount: number; units: ProjectedUnit[] }
```

### 5.1 恒等式（整个功能的地基）

可见块用 `'\n\n'` 拼起来（分隔符**算在单元之间**），于是：

```
units.map((u) => text.slice(u.start, u.end)).join('\n\n') === text
```

这条恒等式**必须**成立——它一旦不成立，就说明"区间"与"正文"不是同一份东西，
此后任何"逐段归属"都是猜的。前端拿到区间后还会**自己再验一次**（§7.1）。

### 5.2 占位单元

连续受限块被合并成**一行**占位（`> 🔒 此处有 N 段内容需登录查看` / `…需更高权限查看`），
它是一个单元，但 `gated: true` 且归属恒为 `null`。**不下发"它代表几个块"**——
那会泄露"这里被拆成了几段"这种结构信息。

### 5.3 为什么不下发 `ordinal`

单元数组里**没有** ordinal。前端要的是"渲染出来的第 N 段对应哪句话"，
而 ordinal 是**存储序**（受限块被合并、被剥离的标题都可能让它与渲染序错位）——
下发一个会被误用的序号，等于给未来的自己埋一个错位标签。

## 6. 读路径：谁能看到谁的名字

`GET /api/pages/:slug` 的响应（`WikiPageDetail`，契约在 `packages/core/src/services.ts`）
新增 `blocks`：

```ts
blocks?: { start: number; end: number; gated: boolean; updatedAt: string | null
           author: { id: number; displayName: string | null } | null }[]
```

- **区间与同一响应里的 `content` 逐字同源**（区间由 `projectBlocks` 在拼接处算出）。
- **`?content=raw`（原文模式）不下发 `blocks`**：原文含 gated 标记，块与渲染段的对应
  关系已被标记打乱，给了也没法用；编辑者界面本来就有块档位控件
  （`GET /api/pages/:slug/blocks`），不需要这条。
- 作者名用**一条**查询按 id 批量取回（`SELECT id, display_name FROM users WHERE id IN (…)`），
  不是每块一次。

### 6.1 `blockAuthorFor()` 与 `authorFor()` 的差异

`authorFor()`（版本列表，0019）按"自己 / owner·admin 看真名、其余 `displayName: null`"三档；
块级归属用的是新的 `blockAuthorFor(viewer, authorId, displayName)`，**只有两档**：

| 主体 | 下发 | 界面（`authorText.ts`） |
| --- | --- | --- |
| 登录用户 | `{ id, displayName: 真名 }` | 真名 |
| 匿名访客 | `{ id, displayName: null }` | **「另一位成员」** |
| `updated_by` 为 NULL / 账号已删 | `null` | **不显示任何标签** |

为什么块级**不**沿用"自己/管理员才看真名"：那条规则是为了**防枚举**（版本列表配合
其它字段可以拼出"谁活跃、什么时候活跃"的画像）；而块级标签是**阅读页正文的一部分**，
读者本来就在看这段文字，藏起作者名只会让功能失去意义，而 `GET /api/org/members`
对登录用户本来就可读（§0.1 第三条）。匿名那一档仍然收走名字——与版本列表逐字一致。

### 6.2 载荷裁剪（不新增旁路）

详情对象照旧在**序列化的唯一出口**过 `access.project(...)`：`level !== 'full'` 时
`blocks` 一并置空（与 `versions` 同款）。也就是说**看不到正文的主体也拿不到块区间**——
否则区间本身就是"这一页有几段、哪几段被挡"的结构信息。

## 7. 阅读页：从区间到标签

服务端的区间是相对 `GET /api/pages/:slug` 的 `content` 的；阅读页真正渲染的那份
Markdown 却不是它。于是要两道翻译，都在**纯函数**里完成
（`packages/web/src/lib/blockMetaPlan.ts`：无 DOM、无 React、无网络）——
本仓的 node 测试环境**没有 DOM**，只有纯函数才能被逐条钉住。

### 7.1 第一道：区间随"剥掉重复标题"平移

`stripDuplicateLeadingTitle(content, title)` 会删掉与页面标题重复的首个一级标题
（连同它后面的一个空行）⇒ 区间必须整体平移，而被删掉的那一段**不给标签**。

`alignBlockSegments(full, shown, units)` **不 import** 那个具体变换，而是把它**量出来**：
算公共前缀与公共后缀 ⇒ 得到"被删掉的一段" `[from, to)`，并要求

- 删掉的长度**恰好**等于两串长度差，且
- `full.slice(0, from) + full.slice(to) === shown`（逐字还原）。

两条都过，才把区间平移过去（与删除区间**相交**的段整段丢弃——裁剪出来的区间不再落在块
边界上，末端恒等式会立刻失败，那等于把"这里对不齐"翻译成一次错位显示）。
验证不过 ⇒ 返回 `null`。末尾再用 §5.1 那条恒等式在 `shown` 上复验一次。

### 7.2 第二道：块 → DOM 节点（**为什么不是"一块一个节点"**）

服务端的块是**空行分隔**的，而 Markdown 的渲染并不总是一块一个节点。两种真实形态：

- **松列表**（`- 甲` / 空行 / `- 乙`）在 CommonMark 里是**一个** `<ul>`（loose list），
  分成两块各自渲染却会变成**两个** `<ul>`；
- **链接引用定义**（`[x]: /wiki/y` 单独占一段）自己渲染成**空串**，而 `[x]` 的解析要用到它。

这两种情况下"每块一份 HTML 拼起来 = 整份 HTML"不成立 ⇒ **怎么切都切错了**。

做法（`planBlockGroups(markdown, segments, renderText, html)`）：从左到右**贪心合并**，
每一组都用"是不是整份 HTML 的下一段"来验证——记 `pos` 为已确认的 HTML 前缀长度，
对候选组 `[i..j]` 把它渲染出来，若正好出现在 `html` 的 `pos` 处就**确认**这一组，
否则把 `j` 往后扩一段再试。全部确认完且 `pos` 恰好走到 `html` 末尾 ⇒ 这份切分是**被证明过的**
（`html` 被逐字切成了这些组的 HTML）。常见情况每组只渲染一次，总次数被"段数 × 2"量级封顶。

**渲染为空串的段**（引用定义）不能自己成组：它被收进 `context`，作为**所有后续组**的渲染
前缀带着走，自己不占组、不参与归属。

> **踩坑记档（本功能唯一的真缺陷）**：第一版把空的定义段并进"第一个渲染非空的组"，
> 于是**定义在中间、被后面的段消费**时（定义在第 2 段、`[x]` 出现在第 5 段）整页失去归属。
> Node 单测**没抓到**——它们用的是"定义紧跟消费段"的理想形态；浏览器验收抓到了。
> 结论：这类"顺序敏感"的形态，单测要**同时**钉住理想形态与错位形态。

### 7.3 失败即整份回退（少给可以，给错不行）

三条闸门，任一不过就**原样返回整份 HTML**（正文一字不变，只是没有标签）：

1. `alignBlockSegments()` 返回 `null`；
2. `planBlockGroups()` 证明不了切分；
3. 段数 > `MAX_ATTRIBUTED_SEGMENTS`（400，防"超长页面 × 贪心渲染"的开销）。

回退是**静默**的（页面看不出异常），所以必须有 §9 的浏览器验收盯住"逐段包裹真的发生了"。

## 8. 界面

标签**不是**独立的一行，而是浮在该段右上角：

- `.gw-block { position: relative }`——包裹层**不设** margin / padding / border，
  保证包裹前后排版逐像素一致（本仓正文排版靠后代选择器，多一层 DOM 会不会弄坏间距
  只有量真实盒模型才算数 ⇒ 列为浏览器验收项）；
- `.gw-block-meta`：绝对定位右上、默认 `visibility: hidden` + `opacity: 0`（否则每段都
  顶着一行标签）；`:hover` 与 `:focus-within` 时显示（键盘可达）；
- `@media (hover: none)`（触屏）：**常显**——触屏没有悬停态，藏起来等于没有这个功能；
- 文案：`最后由 ${authorText(author)} 编辑 · ${relativeTime(updatedAt)}`，
  `title` 属性给绝对时间（`absoluteTime`）。**复用** `authorText.ts` / `timePlan.ts`
  的既有真源，不另造措辞。

## 9. 验证

**单测**（`pnpm test`，node 环境无 DOM）：

- `packages/web/test/blockMetaPlan.test.ts`：区间对齐的三种结局、用**真函数**
  `stripDuplicateLeadingTitle` 造 `shown`、分组（松列表合成一组 / 文末与中间的定义段
  不占组且带着走 / 切分必须覆盖整份 HTML / 对调区间必须 `null`）、文案四档，
  以及两条 **CSS 源码守卫**（标签默认 hidden 且包裹层不设 margin/padding/border；
  `@media (hover: none)` 分支里必须常显——注意要扫描**所有** media 分支）；
- `packages/plugin-wiki/test/blocks.test.ts`：新建盖章 / 只改第二段时第一段**不动** /
  插入新段后旧段归属不变 / `actorId: null` ⇒ NULL / 投影单元恒等式与占位无归属 /
  `parseBlocks` 降级路径归属为 null；
- `packages/plugin-wiki/test/service.test.ts`：登录看真名 / 匿名 `displayName: null` /
  跨插件 `svc.save()` ⇒ `author: null` 但 `updatedAt` 有值 / 受限占位段的 `author`
  与 `updatedAt` 均 `null`、且键清单**只允许**五个键。

**浏览器端到端**（`scripts/acceptance/block-attribution-cdp.mjs`，零依赖 CDP）：
自播种三页（A 三段两次保存 / B 松列表 + 链接引用定义 / C 开头重复 H1），断言
"接口层归属逐段差异"、"每个 `.md-body` 直接子元素都是 `.gw-block`"（证明逐段包裹
真的发生、而不是整份回退）、标签文案与 `title`、**真 CSS `:hover`** 下标签出现、
松列表仍是**一个** `<ul>`、引用定义渲染成真链接、console 零 error、无失败请求。

> **环境坑（记档）**：headless Chrome 默认匹配 `@media (hover: none)`，
> 而 `Emulation.setEmulatedMedia({features:[{name:'hover'…}]})` 与
> `--blink-settings=primaryHoverType=…` **都不生效**（Chrome 151 实测）。
> 桌面悬停那一支必须在**非 headless** 浏览器里跑：`Xvfb :99 -screen 0 1280x900x24`
> + `DISPLAY=:99 google-chrome --no-sandbox --remote-debugging-port=9470 …`
> （Xvfb 在带 nvidia EGL 的机器上可能于 `InitExtensions` 崩溃，加
> `-extension GLX` 与 `__EGL_VENDOR_LIBRARY_FILENAMES=<mesa 的 egl_vendor.d>` 可绕过）。
> 脚本自己会先断言 `matchMedia('(hover: hover)')`，不满足则退出 2 并打印启动参数。
> 触屏那一支由 CSS 源码守卫覆盖，不需要浏览器。

## 10. 未做 / 已知限制

1. **没有块级历史**（用户选定："只记最后一次"）。被覆盖掉的作者信息**不再存在**——
   想知道"这一段被谁改过几轮"，只有页级版本时间线（0019）与
   `GET /api/pages/:slug/versions/:id/diff` 的块级结构差异。
2. **只有阅读页有标签**：编辑页、版本预览（历史快照）、导出/打印都没有。
   历史快照刻意**不传** `segments`——那份正文的作者是"当时"，与当前归属不是一回事。
3. **`updated_at` 的历史口径**：0024 之前的行，时间戳是最后一次页面保存（§3.4），
   而 `updated_by` 为 NULL ⇒ 不显示。也就是说这个功能**从这一版起才准确**。
4. **跨插件代调用（`wiki-service.save()`）写 NULL**：AI 代写、内置文档同步落在
   "无主体"那一档，阅读页看不到归属（而不是记到"某个人"头上）。
5. **不覆盖的渲染形态**：切分证明不了时整页回退（§7.3）——这是**有意的**，
   但意味着某些极端 Markdown 形态下"这一页就是没有标签"，且没有提示。
6. **标签是"最后改动者"而不是"作者"**：读者看到的是最后一个动过这一段文本的人，
   与"这段话最初是谁写的"无关（语义受 §3.2 的收紧定义约束）。

## 11. 文件索引

| 位置 | 作用 |
| --- | --- |
| `packages/db-sqlite/src/migrations/0024_block_author.sql`、`packages/db-postgres/migrations/0024_block_author.sql` | 加 `blocks.updated_by` |
| `packages/plugin-wiki/src/blocks.ts` | `syncBlocksForPage()` 盖章规则、`ProjectableBlock`、`ProjectedUnit` / `ProjectedContent`、`projectBlocks()` 的区间、`projectPageContentFor()` 取两列 |
| `packages/plugin-wiki/src/index.ts` | 5 个调用点的 `actorId`、`blockAuthorFor()`、`getPage()` 组装 `blocks` |
| `packages/core/src/services.ts` | `WikiPageDetail.blocks` 契约与语义注释 |
| `packages/web/src/api.ts` | 前端 `PageDetail.blocks` 类型 |
| `packages/web/src/lib/blockMetaPlan.ts` | `alignBlockSegments()` / `planBlockGroups()` / `blockMetaText()` / `blockMetaTitle()`（纯逻辑） |
| `packages/web/src/lib/markdownRender.ts` | `renderMarkdownBody({segments})` → `applyBlockSegments()`（包裹与注标签，失败整份回退） |
| `packages/web/src/components/MarkdownBody.tsx` | `useRenderedMarkdown` 透传 `segments` |
| `packages/web/src/pages/WikiPage.tsx` | 阅读页算出 `blockSegments`（历史预览不传） |
| `packages/web/src/styles/markdown.css` | `.gw-block` / `.gw-block-meta` 与三种可见性档 |
| `packages/web/test/blockMetaPlan.test.ts`、`packages/plugin-wiki/test/blocks.test.ts`、`packages/plugin-wiki/test/service.test.ts` | 单测 |
| `scripts/acceptance/block-attribution-cdp.mjs` | 浏览器端到端验收 |
