# GeeWiki 访问控制、组织管理与公开门户 —— 设计构想

> **状态**：**v8 修订版**（= v7 修订版 **+ 全部阶段实现反馈驱动的订正** —— **本文档已无待决项**）。由两轮架构设计（v1 完整设计 + v2 修订版）合并而成，并经五轮评审纳入**十二项**已拍板决定（v2 的 D1–D4；v5 新锁定的 D7–D10；v3 的 D11 / D13 / D14；v4 的 D15 —— 另有 D5 / D6 由 §10.2 说明）。五轮修订依次是：① 把"**角色**"从**授权对象**里彻底摘掉（D13）；② 把 `owner`/`admin` 的**应急可见权**写成显式规则 + 审计（D14）；③ **D11 权限版本永久保留**；④ **块级第三档由"仅编辑者"改为"仅授权"**（D15）；⑤ **锁定 D7/D8/D9/D10 的默认值并定稿**。
> **★ 第六轮（v6）不是新的设计决策**：它由 **P0 阶段的落地实现 + 一轮独立代码审查**驱动（**不是**用户拍板），只做三类事 —— ① 把"**实现过程中自行定义、文档里从未写过**"的六项 API 形状（`RouteAccess` / `RequestVerdict` / `use?()` / `dispatch` 返回值 / `register()` 第 4 参 / `judgeAccess` 判定顺序）**回写为正式章节 §2.5**；② 订正 §8.2 里两条**按字面执行不通或自相矛盾**的 P0 验收（P0-1 命令的 URL 编码、P0-6 与 §8.1 的建表归属冲突）；③ 把审查**实测到**的 `config` 回显通道记入 **P2 交付项（第 14 条）** 与 **§12 第 19 条**。核心在 §2.0 与 §4.3，修订记录见 **§13.1（v3）/ §13.2（v4）/ §13.3（v5 定稿）/ §13.4（v6 实现反馈）/ §13.5（v7 实现反馈）/ §13.6（v8 实现反馈）**。
> **★ 第七轮（v7）同样不是新的设计决策**：它由 **P1 / P1.5 阶段的落地实现 + 一次 PostgreSQL 实机试跑** 驱动（**不是**用户拍板），只做三处**订正** —— ① §7.2 的 `link_ticket` **不落库**（HMAC 自包含票据；原文"存 DB"与 §7.6 的"迁移增量 0"不可兼得，两批实现者各自独立选了同一个解法）；② §4.3 补**明确的方言语义**（该 FTS 形态**仅支持 SQLite**、PG 下检索插件**显式拒绝激活**、PG 等价物是 `tsvector` + `pg_trgm` 且**列为非目标**）；③ 记录**进度事实**（P0 / P1 已合入 `main`，P1.5 / P2 正在 worktree 分支上实现）与一条**方法学事实**。修订记录见 **§13.5**。
> **★ 第八轮（v8）同样不是新的设计决策**：它由 **P2 / P3a / P3b / P3c / P3d / P4 的落地实现 + 多轮独立审查** 驱动（**不是**用户拍板），**不引入任何新的设计决策**，只做**订正与回写** —— ① **§2.3 规则 B1 的方向写反了**（**安全相关，本次最重要的一处**：按 `tier` 刻度必须写成 `max`，见 §2.3 与 §13.6 第 1 条）；② **§4.3 补 P3a 的方言成本** —— 三个**只在真实 PostgreSQL 上暴露**的缺陷（实现已修，但文档此前那句"块模型与读路径裁剪两部分仍可两方言落地"在修掉之前**不成立**，见 §13.6 第 2 条）；③ **新增 §4.6「跨阶段不变量：`blocks.tier` 的扇出」**（这条不变量在实现中**失效过三次**，三次均由审查端到端复现，见 §13.6 第 3 条）；④ 其余十条逐条补正（§3.6 / §4.3 / §6.6 / §8.2 / §9 R9 / §2.3 等，见 §13.6 第 4 条）。修订记录见 **§13.6**。

> **⚠️ 定稿 ≠ 已实现 ≠ 每句都已验证（★ v8 更新进度）**：**全部阶段 P0 / P1 / 文档 v7 / P1.5 / P2（含 M5 前三项）/ P3a / P3b / P3c / P3d / P4 均已实现并合入 `main`**（`main` = **`5536bfa`**，进度与验证基线见 §13.6）。**但"已实现"不等于"本文档的每一句都已被验证"** —— 文中由 **§13.5 / §13.6 明确标为"实现反馈 / 已在实现中核对"** 的条目以外，**其余结论仍属未验证（未实测 / 未跑代码）**；§12 保留的条目是**已知的"未验证 / 实现前需复核"项，不是待决项**。做维护性改动前须按 §12 与各章的「原文如此，实现前需复核」逐条复核（完整声明见 §13.3，v6 的声明见 §13.4，v7 的见 §13.5，v8 的见 §13.6）。
> **读者**：项目所有者（非权限系统专家）。所有专业术语首次出现时都会用一句白话解释。
> **素材来源**：① GeeWiki 后端/数据层现状调查；② 前端现状调查；③ 业界权限模型与游客首页调研（外部来源链接见第 11 节）；④ 两轮架构设计。
> **标注约定**：文中标 **「实测」** 的结论来自对仓库实际执行过的 SQLite 探测（用的是 `:memory:` 库，未触碰 `data/geewiki.db`）；标 **「原文如此，实现前需复核」** 的地方表示来源本身存在不确定或矛盾，**不要照着猜**。

---

## 0. 一句话定位

给一个**当前完全没有任何鉴权**的 wiki，补上「身份 → 组织 → 条目级可见性 → **内容块级**可见性 → 公开门户」这条主干链路，且不破坏现有的手写路由、插件契约与 26 个前端守卫测试文件。

### 0.1 现状摘要：最危险的五处

**① 写接口完全裸奔（今天就能被任意人改数据）**

- `PUT /api/pages/:slug`（`packages/plugin-wiki/src/index.ts:643-675`）与 `DELETE /api/pages/:slug`（`:679-687`）：任何人可增删改任何条目。服务端是 last-write-wins，**没有乐观锁、没有操作者记录**（`savePage` `:489-531`）。
- 管理台 11 个端点（`packages/manager/src/index.ts:1562-1673`）**匿名可调**，其中包括 `POST /api/plugins/:name/enable|disable|replace`（`:1603` / `:1652` / `:1638`）、`GET/PUT /api/plugins/:name/config`（`:1617` / `:1626`）、`POST /api/session/persist`（`:1662`）—— **任何人都能热卸载数据库插件**。这比条目被改更严重。

**② 请求上下文里没有"人"**

- `RouteHandlerContext { req, res, url, params, json, noteStatus? }`（`packages/core/src/index.ts:477-503`）没有 principal（身份主体）字段。
- 唯一的分发器 `HttpRouter.dispatch()`（`packages/server/src/index.ts:321-459`）是线性路由匹配，**没有任何前置钩子**；`HttpRouterService`（`packages/core/src/index.ts:558-623`）只有 `register/stats/inflight/pending/drain/trackStream/closeStreams/noteStreamRejected`，**没有 `use()` / `before()`**。
- 唯一可复用的请求级作用域是 `AsyncLocalStorage<RequestState>`（`packages/server/src/index.ts:131`），目前只用于在途排空。

> **★ v6 就地订正（P0 已落地；本节其余内容描述的仍是 P0 之前的状态）**：上面三处在 P0 已经改变 —— ① `RouteHandlerContext` 新增**可选**字段 `principal?: Principal`；② `HttpRouterService` 新增**可选**方法 `use?(hook: RequestHook): () => void`，且 `register()` 新增**可选第 4 参** `opts.access`（默认 `public`）；③ `dispatch()` 的返回类型放宽为 `boolean | Promise<boolean>`（变化的是"是否交给静态层"的**时机**，**语义不变**）。**这三处的确切形状、默认值与判定顺序见 §2.5** —— 它们是 P0 实现过程中**自行定义**的，v1–v5 的文档里**都没有写过**（丢失原因见 §12 第 19 条）。另：`AsyncLocalStorage<RequestState>` 依旧只用于在途排空，它**不是** principal 的载体（principal 走 `RouteHandlerContext.principal`）。

**③ 数据模型里也没有"人"**

- 全库仅 4 张业务表：`pages`（定义在 `packages/db-sqlite/src/migrations/0001_init.sql:4-11`）、`page_versions`、`page_links`、`pages_fts`。**没有 user / role / org / visibility / created_by 任何字段。**
- 条目层级**只靠 slug 里的斜杠**：`isValidSlug`（`packages/plugin-wiki/src/index.ts:242-298`），`SLUG_MAX_DEPTH=8`，保留首段 `search|ask|new|list`（`:258`）。

**④ 前端没有身份概念**

- `packages/web/src/api.ts:27-44` 的 `request()` 只设 `content-type`，**不带 Authorization、不带 `credentials`**；SSE 走裸 `fetch`（`:341-350`）。
- `packages/web/src/lib/errorText.ts:81-105` 把 401/403 归进通用 `client` 桶（文案"请求未被接受"），**没有全局 401 拦截、没有登录页**。
- `packages/web/src/App.tsx:112-114` 未知路由**静默回落 wiki**，**没有 404 页**。

**⑤ 未登录访客看到的就是准管理员界面**

- `#/wiki` 列表页带"新建页面"主按钮（`packages/web/src/pages/WikiPage.tsx:337-342`）。
- 详情页**无条件**显示"删除"（`:987-995`）与"编辑"（`:996-998`），版本历史含"恢复此版本"（`:1089-1098`）。
- 顶栏"管理 ▾"直通插件管理台（`packages/web/src/App.tsx:238-277`）。

### 0.2 必须一起堵的旁路（只堵详情页等于没堵）

| 旁路 | 位置 | 为什么会漏 |
|---|---|---|
| 全文检索 FTS 路 | `packages/plugin-search/src/index.ts:395-400` | 查询无任何可见性条件 |
| 全文检索 **LIKE 短查询兜底路** | `packages/plugin-search/src/index.ts:415-428` | 该路**直接扫 `pages` 表（不经过 `pages_fts`）**，是 v1 漏判的一处泄漏面 |
| 检索返回列 | `packages/plugin-search/src/index.ts:298` | `SELECT_COLUMNS` 直接含 `p.content` |
| 批量取全文 | `packages/plugin-search/src/index.ts:460-472`（`contents()`） | 任意 slug 取全文的裸接口，是 AI 路径的唯一入口 |
| AI 问答 | `packages/plugin-ai/src/index.ts:419`，端点 `:879` / `:903` / `:913` | 会把受限正文带进答案与 `sources` 帧 |
| SSE 长连接 | `packages/plugin-ai/src/index.ts:913` | `trackStream(res, owner)` 的 `owner` 是**插件名**（`packages/core/src/index.ts:591-611`），不是鉴权 |
| 版本历史 | `packages/plugin-wiki/src/index.ts:621-639` | **直接返回历史原文**：当前版本受限、翻旧版就能读，是这类系统的经典洞 |
| 反链 | `packages/plugin-wiki/src/index.ts:702-710` | 返回引用方的 `title` → 泄露受限条目的**标题与存在性** |
| 侧边栏 / 依赖图 | `packages/web/src/components/Sidebar.tsx`、`lib/navTree.ts`、`#/graph` | 吃的是**全量页面列表** |
| 前端红链判定 | `lib/markdownRender.ts` + `lib/wikilink.ts` + `components/PageLinks.tsx`（挂载 `WikiPage.tsx:1035`） | 以"目标是否在全量列表里"判定存活 → 会把"无权访问"**误判成"不存在"** |

### 0.3 目标（按优先级）

| # | 目标 |
|---|---|
| **G1** | **堵漏**：匿名不得写/删/改任何条目，不得调用任何管理台端点 |
| **G2** | **身份**：本地账号 + 会话 + 登录/登出/初始化闭环，服务端每请求解析 principal |
| **G3** | **组织**：单组织内的成员、角色与组，邀请可发给个人或组 |
| **G4** | **条目可见性**：`private/org/public` 三档 + 随位置实时继承 + 例外授予 |
| **G5** | **内容块级可见性**：条目内**每个内容块**有独立可见性，匿名/低权用户看到**显式占位**而非被遮罩的正文（用户已选定此方案） |
| **G6** | **门户**：未登录进站先看到面向访客的门户首页；无权分区**完全不出现**（不置灰、不显示锁） |
| **G7** | **一致性**：列表 / 详情 / 版本 / 反链 / 搜索 / RAG / 门户 / sitemap 共用**同一个裁剪函数** |

### 0.4 非目标（本期明确不做）

| # | 不做 | 备注 |
|---|---|---|
| **N1** | **多租户**：不做 org 切换 UI、不做跨 org 隔离 | 表结构保留 `org_id`（本期恒 1），见 §2.1 |
| **N2** | **Zanzibar / SpiceDB 类关系型授权引擎** | 触发条件（组嵌套深/宽、需要"谁能看这条"的反向展开、多租户成为主线）在本期均不成立 |
| **N3** | 实时协作、评论、通知 | — |
| **N4** | **全文索引的权限感知索引**（v1 的 N5） | **v2 已作废**：分层 tier 索引正是权限感知索引（§4.3） |
| **N5** | 把现有 hash 路由改成路径路由 | **部分作废**：门户新增真实路径 `/portal`（§6），但 SPA 侧不动（v1 的 N6） |
| **N6** | 可视化块选择器 / 结构化块编辑器 | 块级可见性用**内联标记**表达，CodeMirror 6 零改造（§4.1） |
| **N7** | ABAC（基于属性的授权）与策略引擎 | 表达力用不上，却会让"为什么这个人能看这条"变成一个要跑引擎才能回答的问题 |

---

## 1. 术语表（先看这个，后面不再解释）

| 术语 | 白话解释 |
|---|---|
| **principal（主体）** | "这次请求是谁发的"。可能是匿名访客、登录用户、或应急管理员令牌。设计上**永远返回一个 principal 对象**（匿名的也有对象），这样下游少一个"可能为空"的分支 |
| **RBAC** | 基于角色的访问控制：先给人分配角色（管理员/成员/访客），再用角色决定能做什么。**★ 本设计只用它的前半句**：角色**只**决定"能**做**什么"（能力），**不**参与"能**看**什么"（可见范围）—— 见 §2.0 |
| **能力（capability）** | "这个人能**动手**做什么"：能不能管成员、能不能建改内容、能不能改可见性、能不能写。它由**组织角色**（`org_members.role`）与**内容级授予档**（`grants.role` = `editor`/`viewer`）给出，**与"能看什么"是两条互不换算的轴**（§2.0） |
| **授权（grant）/ 授权对象（`subject_kind`）** | 把一份内容**额外**给某个具体的人或某个团队看。本设计的授权对象**只有两种**：`user`（具体的人）与 `group`（团队）。**角色不是授权对象**（★ v3 修订，见 §2.0）。表是 `page_grants` / `block_grants` |
| **可见性（visibility）** | 一条内容"默认谁能看"。**页面级**三档：`private`（仅被显式授权的人）/ `org`（组织成员）/ `public`（任何人）。**★ v4：块级**三档是 `public` / `org` / `granted`（`granted` = 仅授权，与页面级 `private` **语义相同、名字不同**，见 §2.2） |
| **继承（inherit）** | 子条目默认跟随父条目的可见性。本设计里**只有"收紧"向下继承，"放宽"不继承** |
| **块（block）** | 条目正文里一个自然段/标题/代码块/列表项等。本方案里**每个块可以有独立的可见性** |
| **tier（等级档位）** | 给内容打的"密级数字"：`0`=任何人可见、`1`=组织成员可见。检索时按"你的等级"过滤。**★ v4：取值域只剩 `0`/`1`** —— "仅授权"（`granted`）那一档**不是读者等级**，用 `NULL` 表示、不进入等级索引（§4.3） |
| **FTS** | Full-Text Search，全文检索。本项目用 SQLite 的 FTS5 扩展，`tokenize='trigram'`（按 3 字符切分，因此中文可检索） |
| **contentless 表** | FTS5 的一种形态：索引里**不存正文**，只存词元。省空间，但 `snippet()`（生成高亮摘要）不可用 |
| **投影（project）** | 按"这个人能看什么"把内容裁剪一遍再返回。**服务端裁剪是唯一的访问控制手段**，前端隐藏只是视觉装饰 |
| **404 vs 403** | 404 = "这东西不存在"；403 = "存在，但你没权限"。本设计对匿名访客**故意把无权也返回 404**，避免泄露"这里有个你看不到的东西" |
| **web cache deception** | 缓存欺骗：中间缓存（CDN/反代）把本该只给某个登录用户的响应缓存下来，再喂给别人 |
| **noindex / robots.txt** | 告诉搜索引擎"别收录"。**它们只约束自愿守规矩的爬虫，对 curl/脚本零约束 ⇒ 永远不是访问控制** |

---

## 2. 权限模型

### 2.0 ★ 两条正交的轴：角色管"能做什么"，可见性与授权管"能看什么"

**这是 v3 修订的核心，也是整套权限模型的"一句话规则"：**

> **角色决定"能做什么"；可见性与授权决定"能看什么"。两者不交叉。**

**为什么必须先把这一条讲清（这是一次概念订正）**：v2 把"角色"塞进了**授权对象**的位置（`page_grants.subject_kind = user|group|org_role`），于是同一件事有了两种说法 —— 页面级可以"授权给某个角色"，块级却只允许"授权给具体的人/组"。两层规则不一致，还会生出**无法解释的交叉规则**：比如"页面授权给 `viewer`，页面里某个块却授权给 `member`" —— 那个人到底能不能看？谁也说不出道理。v3 把角色**彻底移出授权对象**，页面级与块级因此**完全同构**（一套规则）。

**打个比方（一栋办公楼）**

- **角色 = 你工牌上的职能**。它回答"你能不能**动手**"：能不能给新人办入职（管成员）、能不能改房间布置（建改内容）、能不能决定这间房门口挂什么牌子（改可见性）、能不能写东西。
- **可见范围 = 每个房间门口挂的牌子**。它回答"你能不能**进去看**"：挂"公开"的任何人都能进；挂"公司内部"的本公司员工能进；挂"只给张三、李四"的只有这两人能进；挂"只给财务部"的则是财务部的人能进。

**两样东西不会互相换算**：工牌上写着"设备管理员"，**不等于**你自动能进那间"只给财务部"的房间；反过来，你被指名允许进某个房间，**也不会**因此获得"给这个房间换牌子"的权力。

**统一后的四档（页面级与块级完全同构）**

| 档 | 谁能看 | 怎么表达 |
|---|---|---|
| 公开 | 任何人，含未登录 | `visibility='public'` |
| 组织内 | 组织成员 | `visibility='org'`（**默认档，零操作**） |
| 授权给个人 | 指定的人 | `grants.subject_kind='user'` |
| 授权给团队 | 指定团队的人 | `grants.subject_kind='group'` |

**角色退回去只管能力**（不参与上面任何一档）：能不能管成员（`owner`/`admin`）、能不能建改内容（`member` 及以上）、能不能改可见性（`admin`，以及内容级授予档 `editor`）、能不能写（`viewer` **不能**写）。

**可见性是一条"由宽到窄"的阶梯（★ v4 补）**：`public`(0) < `org`(1) < `granted`(2) —— **越靠右越窄**，`granted` 是"**默认谁都不能看、靠授权放人**"的那一档（块级三档见 §2.2）。块级的有效可见性取 `max(page, block)`（§2.3 规则 B1）：**页面把上限压住，块只能在页面给定的范围内再收紧**。
> **★★ v8 订正**：本句原写作 `min(page, block)`，**方向写反了**。因为上面这个档位序是"**越靠右越窄**"（数值越大越窄）⇒ "取更窄的一方"是 **`max`**。
> 只有把刻度声明成"越大越**宽松**"时才是 `min`。同一语义在两套刻度下的写法为什么相反、以及写反会造出什么泄漏（"页面 org + 块 public" 的块拿到 `tier = 0` ⇒ 匿名搜得到），见 **§2.3 规则 B1 的 ★ v8 小节**。此处保留原文以留痕：`min(page, block)` 是**已作废的旧写法，不要照它实现**。

**唯一的例外，而且是刻意的**：组织 `owner`/`admin` **恒可看一切**（含 `private`），作为应急通道，**每次实际发生的覆盖式访问都写一条审计**（§2.3 规则 O1）。这不叫"角色参与可见性判定"，而是一条**显式的、留痕的、可事后追责的**管理员兜底规则 —— 它是**唯一**一处"有角色的人看到的比别人多"。

**一条顺带的收益**：反向排查"**谁能看这条**"变简单了 —— 现在只有三个来源：① 可见性档位（`public`/`org`/`private`）；② `user`/`group` 授权；③ `owner`/`admin` 应急覆盖。这消除了一整类反模式（见 §9 R10 新增第 9 条），也让 R10 第 4 条那条"只校验父子各自权限、不校验隶属关系"的邻接风险**减弱**（少了一层角色维度的组合）。

> **★ v4：这里原来记的"一处尚未收敛的边界"已经解决了** —— 原边界是"块级标记 `<!--gated:role=editor-->` 与 `block.visibility='private'`（"仅 editor 及以上"）用**能力**决定**可见性**，与本节这句话抵触"。**解决方式不是承认例外，而是把第三档换成纯授权驱动的"仅授权"档**：`block.visibility ∈ public|org|granted`（§2.2、§4.1）。**块级从此不再有任何一处按角色/能力定可见性。** 完整留痕见 §12 第 15 条。

### 2.1 角色清单（角色**只**承载能力，**不再**是授权对象）

> **★ v3 修订**：下面的表只回答"**这人能做什么**"。角色**不出现**在任何授权对象的位置上 —— `page_grants.subject_kind` 与 `block_grants.subject_kind` **都只有 `user | group`**（§2.0、§3.3、§3.7）。所以不存在"页面级能用角色授权、块级不能"这种两层不一致。

**组织级（存在 `org_members.role`，四档）**

| 角色 | 能力（**只**列能力，不含可见范围） |
|---|---|
| `owner` | 全部；组织设置；可转让；唯一不可被移除 |
| `admin` | 管理成员/组/邀请；管理内容可见性；查看审计；**不**能转让所有权 |
| `member` | 创建/编辑**自己所在空间及继承可达**的条目；可被授予内容级 Editor |
| `viewer` | **能登录、能看组织内（`org`）可见内容、不能写**（不能创建/编辑/删除条目，也不能改可见性）。**若要让某批人只能看某个子集，用团队授权（`grants.subject_kind='group'`），不要用角色** —— 角色回答"能不能写"，不回答"能看哪些"（§2.0） |

**`guest` 不是角色，而是"无组织角色"**（`org_members` 中无行）。理由：Guest 若做成"最低档角色"，仍会被组织级继承规则牵连，导致**外部协作者意外看到组织内容**。正确实现是"没有默认角色 ⇒ 只能通过显式授予获得访问"。

**内容级（存在 `page_grants.role` / `block_grants.role`，两档）**：`editor` / `viewer`。内容级授予**只放宽、不收紧**（收紧靠 `visibility` 与继承），避免"授予与限制互相打架"。

> **★ 别把两个 `role` 搞混**：`org_members.role` 是**组织角色**（能力，且**不是**授权对象）；`grants.role` 是**这一次授予给出的能力档**（`editor` = 能看且能改，`viewer` = 只能看）。**两者都不是"授权对象"** —— 授权对象是 `subject_kind` 那一列（`user`/`group`）。

**★ 一条连带的坑（必须写进产品文案）："只给所有 admin 看"不再能用角色表达。**

角色退出授权对象后，"这个页面 / 这个块只给管理层看"**不能**再写成"授权给 `admin` 角色"，只能**建一个团队、把要放进来的人手工加进去，再授权给这个团队**。这时有一个**真实存在的坑**：

> **团队成员是"手工维护的名单"。把某人提升为 `admin`（或 `owner`）不会自动把他加进那个团队。** 于是他"升了职却看不到该看的东西"，而系统不会报任何错。

**替代办法（既不引入角色，也不建团队）**：只用现成的两档 —— 「**组织内可见**」（`org`，零操作，代价是组织内所有人都能看）+「**私有兜底**」（设为 `private` 时 `owner`/`admin` 仍有应急可见权，见 §2.3 规则 O1，因此内容**不会永久锁死**）。

### 2.2 可见性字段：页面级三个 + 块级两个

**页面级（三个正交字段，不是枚举多选一）**

```ts
visibility: 'private' | 'org' | 'public'   // 谁默认能看
inherit: boolean                            // 是否向子树下传（默认 true）
published_at: string | null                 // 独立发布开关（默认 null = 未发布）
```

**块级（只有"收紧"能力，新增第三维）**

```ts
block.visibility: 'public' | 'org' | 'granted'   // ★ v4：第三档 = 仅授权（v2/v3 曾写作 'private' = 仅 editor 及以上，已废）
block.inherit: boolean = true                     // 子块（列表项/嵌套块）是否随父块收紧
```

**块级三档的含义（★ v4 重写："编辑者"这个概念已从块级彻底删除）**

| 档 | 谁能看 |
|---|---|
| `public` | 任何人（含未登录） |
| `org` | 组织成员 |
| `granted` | **默认谁都不能看，靠 `block_grants` 放人** |

- **"只想给自己看的运维备注" = 选 `granted` 档 + 授权给自己** —— 一次操作，不需要新概念、也不需要"编辑者"这种角色参与。
- **授权方向统一（页面级与块级语义一致）**：`page_grants` / `block_grants` **始终是"放宽"方向** —— 在 `granted` 档里它是**唯一入口**（没有授权就是谁都看不到）；在 `public`/`org` 档里它负责把**组织外的人**放进来。
- **为什么必须有 `granted` 这一档**（这是一条硬约束，不是偏好）：`*_grants` **只能放宽、不能收紧**（§2.1 内容级授予的"只放宽、不收紧"）。所以"**比组织内更窄**"必须有**一个档位**来表达 —— 一个块设成 `org` 之后组织成员都能看，**再授权给自己也不会让它变窄**。若没有 `granted`，"只给自己看的运维备注"在模型上**根本做不到**。
- **与页面级的差异（刻意保留，只有名字不同）**：页面级第三档仍叫 `private`（语义同样是"仅被显式授权的人"）。**两边语义一致、名字不同**：页面级保留 `private` 只是因为它在 v1/v2 里已用于页面，改名是无谓的迁移噪音；而**块级原本也叫 `private` 但语义被写成"仅 editor"，属于概念错位，故 v4 改名并改语义**。

**为什么"指定主体可见"不进 `visibility` 枚举**：枚举是互斥的，塞进去会让"公开 + 额外授权给某外部人"这种常见组合无法表达。授予是**多对多关系**（主体 × 条目 × **授予的能力档**），本质是关联表（`page_grants` / `block_grants`），不是枚举值。而"放宽必须独立开关且默认不继承"正好对应 `published_at`。
> **★ v4 补充**：`granted` 档**不违反**上面这条 —— 枚举里放的仍然是"**默认**谁都不能看"这一个值，**具体给谁看**依然完全由 `block_grants` 这张关联表回答。换句话说：`granted` 是"**把默认值设成没人**"，不是"把主体列表塞进枚举"。

### 2.3 继承与冲突裁决

**统一规则（三句话）**

1. **收紧向下继承、不可放宽**：`effective = most_restrictive(本条 visibility, 全部祖先 visibility)`。
2. **放宽必须显式且独立**：`public` 的**发布**由 `published_at` 控制，默认 `null`；`published_at` **不继承**。
3. **移动条目 = 重新计算，不拷贝 ACL**。反例：Notion 的语义是位置性的（页面移出子树时继承来的权限消失）；BookStack 曾出现"自定义权限未级联到章节与页面"的实际 bug（[BookStack #4835](https://github.com/BookStackApp/BookStack/issues/4835)）。根因都是"创建时拷贝一份 ACL"。

**页面级冲突裁决优先级（从高到低）**

```text
1. 组织 owner/admin 应急覆盖    → ★ 显式规则 O1：恒可看一切（含 private）；"能改"来自其角色能力；每次**实际发生的覆盖式访问**写一条审计
2. page_grants 显式授予        → 只放宽，不能突破 4/5 的收紧
   （★ v3：授权对象只有 user|group —— **没有**"按角色授予"这一档，见 §2.0）
3. 本条 visibility + 祖先收紧  → 交集（最严格优先）
4. published_at 发布闸门       → 未发布 ⇒ 非编辑者一律不可见
5. 默认拒绝                    → 兜底
```

**规则 O1（★ v3 新增）：`owner`/`admin` 的应急可见是显式规则，不是"默认放行"**

- **规则本身**：组织 `owner` 与 `admin` **恒可看一切** —— 含 `visibility='private'` 的页面、`blocks.visibility='granted'` 的块（★ v4 改词：原写作 `'private'`）、未 `published_at` 的内容、以及被祖先收紧到不可见的内容，**无论是否存在 `user`/`group` 授予**。
- **为什么必须有**：合规检查、离职交接、**误设私有需要救回**时必须有一条出路。**不保留这条规则，内容可能永久取不回来**（没有任何别的账号能看见它）。
- **它不是"角色参与可见性判定"**：角色仍然只决定"能不能动手"（`admin` 能不能改可见性、能不能管成员，是 §2.1 的事）；O1 只是**免掉"可见性"这一层的拒绝**。所以 §2.0 的"两条轴"没有被打破。
- **代价必须被接受，并且留痕**：每一次**实际发生**的**覆盖式访问**都要写一条审计记录 —— 建议 `audit_log.action='access.admin_override'`，字段含 `actor_id` / `target_kind`（`page`|`block`）/ `target_id` / `request_id`，**可事后追责**。
- **两个必须钉住的实现边界**：
  1. **只记"覆盖式"访问**：判据是"**若不看 O1，这次访问本来会被拒**"，**不是**"访问者是 owner/admin"。否则管理员的日常浏览会把审计表刷爆，真实信号被噪声淹没（与 §3.4 引的"日志太多本身也是弱点"同源）。
  2. **O1 只放宽可见性，不新增能力**："能改 / 能删 / 能改可见性"一律来自角色（§2.1）与内容级授予档（`grants.role`），O1 不替代它们。

**块级裁决顺序（B2）**

```text
1. 页面级判定 pageEffectiveRank(slug)      // 位置性，含祖先收紧 + published_at 闸门
   → level='none' ⇒ 整个页面 404（不再往下算）★ 见规则 B3
   （对 owner/admin，这一步**恒不返回 none** —— 应急覆盖在页面级就先生效，第 4 步是它的显式落点）
2. 块级收紧 effectiveBlockTier = max(block.visibility, page.visibility)   // ★ v8 订正：原写 min，方向反了（见规则 B1）
   // ★ v4 档位序（越右越窄）：public(0) < org(1) < granted(2)；页面级 private 与块级 granted 同为"最窄档"
3. block_grants 显式授予（subject_kind 只有 user|group）   // 只放宽到页面级上限，不能突破第 1 步；在 granted 档里是**唯一入口**
4. 组织 owner/admin 应急覆盖                // 恒可看；每次实际覆盖写审计（规则 O1）
5. 默认拒绝
```

**规则 B1：块只能更窄，不能更宽**（这是块级模型的关键约束）

> **★★ v8 订正（安全相关；本次修订最重要的一处）：下面这个公式原来写反了方向。**
> 原文只写 `min`，而 **`min` 只在"宽松度"刻度下成立**；"块只能更窄"这同一条语义，在 `tier` 那一列的刻度下**必须写成 `max`**。
> 更糟的是：**本文自己声明的档位序是"越右越窄"**（即数值越大越窄）—— 在那个刻度上 `min` **本来也该是 `max`**。
> 也就是说这里有两层错：**公式与它自己声明的刻度不符**，且**两处刻度方向本来就相反**。
> 这**不是措辞问题** —— 照原文（或照曾经的代码注释）写会**直接造出内容泄漏**，细节与真值表见下方「★ v8：两套刻度，方向相反」。

```text
① 窄度 / 限制等级刻度（★ 两处实现都用它："越窄数值越大"）
   档位序（★ v4，越右越窄）：public = 0  <  org = 1  <  granted = 2
                                                      （页面级对应档叫 private，同为最窄档）
   effectiveRank(block) / effectiveBlockTier(block)
       = max( block 档位, pageEffectiveRank(slug) )        ← 取更窄的一方 = 数值更大
   （注：另有一套"宽松度"刻度（越大越宽松）。只有在那套刻度下，"取更窄的一方"才表现为 min。）
② `blocks.tier` 这一列（§3.6）的取值域与①同刻度：0 = 匿名可见 < 1 = 仅组织成员（越小越公开）
   检索条件是 `b.tier <= :readerTier` ⇒ "更窄"同样是"更大" ⇒ 落列时也是 max
```

**为什么两套刻度的写法相反**：只有"取更严的一方"这条**语义**是不变的；
若把刻度声明成"**越大越宽松**"（宽松度），"更严"就表现为 `min`；若声明成"**越大越窄**"（窄度 / 限制等级），
就表现为 `max`。**⇒ "取最窄"与 `min` 之间没有任何必然联系 —— 把 `min` 当成这条规则的名字，等于把刻度当成了规则。**
两套刻度在本项目里**同时存在**（页面级的 `RANK_*` 与块级的 `tier` 都是窄度刻度，故都是 `max`），
因此**同一句话里出现两个刻度名时必须点明用的是哪一个**。

**★ v8：两套刻度，方向相反（含真值表）**

这一版的表述采用 **`packages/plugin-wiki/src/blocks.ts:220-234`** —— 它是**全仓最完整、也最自解释**的解释
（该处的小标题就是「为什么这里是 `max` 而不是文档写的 `min`」）：

| 页面 | 块 | `blocks.tier` | 含义 |
|---|---|---|---|
| public (0) | public (0) | **0** | 匿名可搜到 |
| public (0) | org (1) | **1** | 仅组织成员 |
| org (1) | public (0) | **1** | 页面本身就把匿名挡住了 |
| 任一侧无等级（`null`） | — | **`null`** | 等级分支永不命中，只能靠授权分支（§4.3） |

> **总结句（原文照抄）**：**"这不是两种规则，是同一条『只能更窄』的两种刻度。"**

**★ 写反的后果（这才是本处订正属"安全相关"的原因）**：把 `max` 写成 `min`，会让"**页面 org + 块 public**"的块
拿到 **`tier = 0`** ⇒ **匿名在站内搜索里就能搜到它** —— 表现为"**读路径 404、检索却命中**"的错位
（读路径按 slug 前缀**实时算**有效档位、检索按**物化的** `tier` 过滤；两者一旦不同步就是这个症状 —— 见 **§4.6**）。

**实现落点（权威，照它实现）**：

| 位置 | 内容 | 说明 |
|---|---|---|
| `packages/plugin-wiki/src/blocks.ts:235-239` | `tierFor(pageLevel: PageLevel, blockVisibility: BlockVisibility): BlockTier` | 先 `blockLevelOf(...)`；`pageLevel === null \|\| bl === null ⇒ null`；否则 `pageLevel > bl ? pageLevel : bl`（即 **`max`**） |
| `packages/plugin-wiki/src/blocks.ts:59` / `:209` | `type BlockTier = 0 \| 1 \| null` / `type PageLevel = 0 \| 1 \| null` | 列侧（限制等级）刻度的类型 |
| `packages/plugin-wiki/src/blocks.ts:212` | `blockLevelOf(visibility: BlockVisibility): BlockTier` | **块侧与读路径必须共用这一个判据**，否则会出现"搜得到但读不到"（检索漏过滤）或"读得到但搜不到"（检索过严） |
| `packages/plugin-authz/src/index.ts:127-129` | `RANK_PUBLIC = 0` / `RANK_ORG = 1` / `RANK_PRIVATE = 2` | **同为窄度刻度**（越窄数值越大）⇒ 故 `effectiveRank`（`:274-287`）内部用的也是 `Math.max`（源码原话：*"越窄档数值越大 ⇒ max 即『最严格优先』"*）。**不要因为名字叫 `RANK` 就以为它是宽松度刻度。** |

**★ 这条错误的扩散与订正（留痕，防复发）**：该错误**曾扩散到 4 处代码注释**（分布在 **3 个迁移文件**中），
**已全部订正**（都只改注释、**未动任何 SQL 语句**）：
- `packages/db-sqlite/src/migrations/0015_blocks.sql`（**两处**：`visibility` 列说明 + `tier` 列说明）与
  `packages/db-postgres/migrations/0015_blocks.sql`（**一处**）—— 由提交 **`ade59ef`** 订正；
- `packages/plugin-search/migrations/0002_blocks_fts.sql`（**一处**）—— 由**更早**的提交 **`1d608a6`** 订正
  （`1d608a6` 是 `ade59ef` 的祖先：先修检索侧那一处，再补齐 db 包的两侧）。

> **⚠️ 复核时不要误判**：这三个文件里**至今仍然出现 `min(`**，但**全部是"解释为什么不是 `min`"的行文**，不是照抄形态。
> 判读方法与复核命令见 **§13.6 第 1 条**；把那些解释性文字再"改成 `max`"一次，**等于把注释改瞎**。
> `packages/plugin-wiki/src/blocks.ts:222` 那句 `min(...)` 同理：它是**引用文档旧写法**以说明为什么代码用 `max`，**不是残留**。

**为什么不允许反过来**（形式化依据）：若允许 `page=private` 且 `block=public`，则匿名可见该块 ⇒ 必须能返回该块的标题与附件元数据 ⇒ **页面本身的存在性必然泄漏** ⇒ 与 §2.3"不泄露存在性"的约定直接矛盾。而"页面存在性"是**结构信息**（分类树、面包屑、侧边栏），它**无法在块粒度上被裁剪**。所以：**放宽只能发生在页面级**，全部可见性复杂度集中在页面层级（一套规则），块级只有收紧。

> **实现推论**：`block.visibility='public'` 在私有页面上是**合法的声明但惰性的**（不报错，但无效）。UI 必须提示"此块的实际可见性由页面决定"。
> **★ v4 同理**：`block.visibility='granted'` 在**公开页面**上也是合法的 —— 它把该块从"任何人可见"收紧成"只有被授权的人可见"，**这是收紧方向，规则 B1 允许**（页面上限是 public，块可以更窄）。换言之 `granted` 在任何页面上都有效，**不惰性**。

**规则 B3（重要边界）：页面级 = `none` 时，块级永不产生"部分可见"**

即 `level='summary'`（含显式占位）**只在页面本身可见（`org`/`public` 且已发布）时存在**。理由：若一个私有页面上有公开块，占位文案（"此处有 N 段需登录查看"）本身就确认了页面存在 ⇒ 必须禁止。这条把职责切得很干净：**页面级决定存在性，块级决定完整性**。

**块级治理规则（谁能在块上做什么）**

| 动作 | 需要 | 理由 |
|---|---|---|
| 用标记**收紧**某块 | `page.canEdit` | 收紧是安全方向，且标记在正文里**可见、可 diff、可审计** |
| **放宽**某块（`block=public` 而页面为 `org`） | `page.canManageVisibility` | 放宽是风险方向；且只对已公开页面有效 |
| 授予 `block_grants` | `page.canManageVisibility` | 与页面级授予同权 |

**具体例子（逐条对照）**

| 场景 | 结果 | 说明 |
|---|---|---|
| 公开父 `guides`(public) + 私有子 `guides/draft`(private) | 子**私有** | 交集 = private；祖先的 public 不放松它 |
| 私有父 `secret`(private) + 公开子 `secret/x`(public, published_at≠null) | 子**仍私有** | 交集 = private；要公开得先放宽 `secret` |
| 同上，但 `secret.inherit = false` | 子**公开** | "继承不可放宽"靠的是继承本身，**断链即断继承** |
| 匿名访问 `secret/x`（private 父） | **HTTP 404**，非 403 | 不泄露存在性（比 Confluence 更严格；Confluence 官方明说"无法隐藏页面存在性"） |
| 登录 `viewer` 访问 `guides/draft` | ~~**HTTP 403** + "申请访问"入口~~ → **★ v8 订正：实现是 HTTP 404**（见下方就地订正） | 原论证"登录用户已知组织存在该条目，403 不额外泄露"**未成立** |

> **★★ v8 订正（本表最后一行）：实现对**所有**主体一律返回 404，不区分"匿名 404 / 已登录 403"。**
> 源码原话（`packages/plugin-wiki/src/index.ts:2285-2290`）：*"详情读路径对**所有**主体一律返回 404，而非设计文档 §2.3 写的『匿名 404 / 已登录 403』—— 见 `getPage` 的注释与本文件 `:1268-1269`：**区分 404 与 403 就等于提供了一个存在性探测接口**。这个选择更严……"*
> - **为什么实现选了更严的一侧**：403 与 404 的字面差异**本身就是一个匿名可用的存在性探测接口**（同一 slug 试两次即可判定"存在但无权"）。原表第二行的论证漏掉了这一点 —— 它假设"登录用户已知组织存在该条目"，但**判据是响应码，攻击者不需要事先知道**。
> - **★ 代价（必须记下来，因为它影响一个产品流程）**：**"申请访问"失去了自然触发点** —— 用户拿到 404 时分不清"无权"还是"不存在"。
>   **⇒ 申请入口必须由前端在"已知 slug"的拒绝页 / 受限块占位文案上提供**（§8.2 P3b 第 6 条），**不能指望读路径给出 403**。
> - **服务端内部分得清两者**（对外压成同一个 404，对内用于审计）：只有"**页存在但无权看**"才算越权尝试并记 `access.denied`（`recordAccessDenied`，`packages/plugin-wiki/src/index.ts:1266-1272`，判据在 `:1272` 的 `pageExists(slug)`）；"请求了不存在的页"只是普通 404（`packages/plugin-wiki/src/index.ts:790-796`）。**把前者也记进来只会把有用信号淹没在噪声里。**
> - **⇒ §2.4 的"四条关键约束"第 2 条（`level='none'` 由调用方翻译成 404 或 404/403）也据此收窄：实现一律翻成 404。** 该条已在 §2.4 就地标注。
| `member` 对 `secret`（private，非自己空间） | 无 `page_grants` ⇒ **403** | 组织角色**不自动等于**内容权限 |
| 移动 `x`（有 3 条 `page_grants`）到别处 | grants **保留**（绑定在 slug 上，不随位置失效） | 这条要显式写进产品文案，否则用户会困惑 |
| 移动 `a/b`（private）到 `public-space/b` | **立即变 org/public** | 位置性实时计算（★ v8 订正：判定**每请求现查库、本就无缓存** ⇒ "无 TTL 窗口"是**因为根本没有缓存**，不是因为 `acl_revision` 触发了失效；`acl_revision++` 只是变更留痕/观测信号，见 §13.6 第 11 条） |

> **v2 订正**：v1 为层级准备了一个物化列 `ancestor_path`，**v2 已删除该列**（见 §3.3），祖先收紧改为**按 slug 前缀实时计算**。因此上面表格中"`ancestor_path` 重建后判定即刻变化"的说法已过时，正确表述是"按新的 slug 前缀实时重算"。

### 2.4 判定单点：函数签名

**这是整个设计的支点**：授权判定必须是**服务端、逐对象、每请求、集中单点**的。OWASP 的原话值得抄进架构文档：*"Remember an attacker only needs to find one way in. Even if just a single access control check is 'missed', the confidentiality and/or integrity of a resource can be jeopardized."*

```ts
/* ---- 身份解析（每请求一次） ---- */
// 返回匿名 principal 而非 undefined：让所有下游少一个可空分支
function principalFromRequest(req: IncomingMessage): Promise<Principal>

interface Principal {
  kind: 'anonymous' | 'user' | 'break-glass'
  userId: number | null
  orgId: number | null
  orgRole: 'owner' | 'admin' | 'member' | 'viewer' | null   // null = guest
                                                             // ★ v3：**只用于能力判定**，不参与可见性判定
                                                             // （唯一例外：owner/admin 的应急覆盖，见 §2.3 规则 O1）
  groupIds: readonly number[]                                // 已展开（subject_kind='group' 的授予判定直接用它）
  sessionId: string | null
}

/* ---- 核心判定（唯一真源） ---- */
type AccessLevel = 'none' | 'summary' | 'full'

interface PageAccess {
  slug: string
  level: AccessLevel          // none=404 语义; summary=看到标题+占位; full=完整正文
  canEdit: boolean
  canDelete: boolean
  canManageVisibility: boolean
  reason: 'owner' | 'admin' | 'grant' | 'org' | 'public' | 'inherited-denied' | 'default-deny'
  // ★ v3：这里**没有**"按角色授予"这一档 —— 'grant' 只对应 subject_kind='user'|'group'（角色不再是授权对象，§2.0）
  //        'owner' | 'admin' = 这次判定用了 §2.3 规则 O1 的应急覆盖（也是审计的写入信号）
  // ★ v4：`granted` 档（"仅授权"，§2.2）**不需要新的 reason 取值** —— 它只是"授权成为唯一入口"：
  //        被授权者看到 ⇒ 'grant'（唯一来源）；未被授权 ⇒ 'default-deny'；owner/admin ⇒ 'owner'|'admin'。
  //        这一档**不引入新的判定来源**，所以枚举保持不变（"能看"的来源永远只有 §2.0 的三个）。
  // 关键：把"裁剪后的载荷"也放在这里，禁止调用方自行决定裁多少
  project<T extends { content?: string }>(payload: T): T
}

function resolvePage(p: Principal, slug: string): Promise<PageAccess>       // 单条
function resolvePages(p: Principal, slugs: readonly string[]): Promise<Map<string, PageAccess>>  // 批量（列表/搜索用）
function visibleSlugs(p: Principal, q: { prefix?: string; levels?: AccessLevel[] }): Promise<string[]>
// ↑ 唯一允许被 list / search / backlinks / RAG / portal / sitemap 复用的出口

/* ---- 写侧 ---- */
function assertCanEdit(a: PageAccess): void   // 抛 PolicyError('forbidden')
function assertCanManage(p: Principal): void  // 组织级管理动作
```

**四条关键约束（是设计约束，不是实现细节）**

1. **`project()` 是载荷裁剪的唯一出口**。任何端点若自己拼 payload，就是第二个真源，必然漂移。落地方式：让 `WikiPageDetail` / `SearchHit` 的构造走 `access.project(...)`。
2. **`level='none'` 由调用方翻译成 404**（匿名）或 404/403（已登录）—— **★ v8 订正：实现一律翻成 404，不分主体**（区分 404 与 403 等于提供一个存在性探测接口；代价是"申请访问"失去自然触发点 ⇒ 入口改由前端在已知 slug 的拒绝页提供）。详见 §2.3 的 ★ v8 就地订正。策略层不认识 HTTP，保持可测。
3. **`reason` 必须回传**：它是审计与"为什么我看不到"产品文案的唯一数据源，也是排查越权/误拒的一手线索。
4. **★ v3：应急覆盖的审计信号只能来自 `reason`**，但**判据不是 `reason` 本身**。`reason='owner'|'admin'` 表示"这次判定用了规则 O1"；**写审计的判据是"覆盖救回了一次本来会被拒的访问"**，不是"访问者恰好是 owner/admin"（§2.3 规则 O1 的边界 1）。实现里若按 `reason` 无条件写审计，就等于把管理员的所有读操作都记成越权 —— **这是必须避免的误读**。

### 2.5 服务端路由鉴权：P0 已落地的 API 形状（**★ v6 新增，实现回写**）

> **这一节为什么存在**：P0 阶段**已经按本设计落地**（worktree 分支 `feat/p0-route-auth-guard`；基线提交 `bb43fc2`，另含一轮修复改动）。§8.1 的 P0 行、§0.1、§8.2 的 P0-5 / P0-6、§2.4 的 `Principal` 接口，实现都与文档**逐字段一致**；但**这套 API 的具体形状**（枚举取值、可选参数、返回值放宽、判定顺序）**文档里从来没有写过** —— 它是在实现过程中**自行定义**的。独立代码审查的结论与警告是：**"建议把这 6 项设计补进设计文档，否则 P1 会拿『文档没写』当理由改掉它们。"**
>
> 所以本节是**回写（write-back）**，**不是新决策** —— 它与 §13.1 / §13.2 / §13.3 那种"**用户拍板驱动**"的修订**性质不同**（见 §13.4）。本节所有形状都能从 §0.1 的缺口 + §2.4 的判定单点推出来；本节只是把**已经落地的形状固定下来**。
>
> **先讲清这是一层什么闸门（否则最容易误用）**：`access` 只回答"**这条路由至少需要什么身份**"，它挡的是"**整类端点被匿名调用**"（插件启停、条目写入）。它**不做**逐对象判定 —— "这个用户能不能看**这一条**数据"永远归 `policy-service`（§2.4）。**两者是纵深防御的两层，不是二选一**：注册了 `access:'user'` **不等于**这条路由的数据就安全了。实现内的原话是"它**不能替代**逐对象判定：两者是纵深防御的两层，不是二选一"。
>
> **行号约定**：本节 `文件:行号` 以 worktree `feat/p0-route-auth-guard` 的**工作区当前状态**为准（= 提交 `bb43fc2` + 一轮修复改动）。该 worktree 仍在演进 ⇒ **行号可能小幅漂移，定位请以函数 / 类型名为准**。

#### 2.5.1 六项 API 形状（逐条，附理由）

##### ① `RouteAccess` —— 粗粒度准入等级（三档枚举）

```ts
// packages/core/src/index.ts:487
export type RouteAccess = 'public' | 'user' | 'admin'
```

| 档 | 语义：**至少**需要什么身份 | 实现判据（`judgeAccess`） |
|---|---|---|
| `public` | 任何主体（**含匿名**） | 直接放行。**默认值** |
| `user` | 已登录用户，**或**应急通道 | `principal.kind === 'user'`（**已认证即可，不看角色**）**或** `'break-glass'` |
| `admin` | 管理员，**或**应急通道 | `principal.orgRole ∈ {owner, admin}` **或** `'break-glass'` |

- **三档刻意保持"粗"**：它够用就好，细粒度判定全在 §2.4 的单点函数里。**写细了会变成第二个真源**（与 §9 R2 是同一类风险：两处判定必然漂移）。
- **`user` 档不看角色是刻意的**：`viewer`（只读成员）也能通过 `user` 档 —— 它只保证"**不是匿名**"。"**谁能改哪一条**"必须由处理器另判（P0 对 `PUT /api/pages/:slug` 就是这么处理的：闸门挡匿名，逐条归属留待 P2 的 `policy-service`）。

##### ② `RequestVerdict` —— 钩子的裁决返回值

```ts
// packages/core/src/index.ts:598-600
export type RequestVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string }
```

- **为什么把 HTTP 状态码写进类型、而不是让钩子自己写响应**：钩子是**集中单点**，让它们只做"判定"、由路由服务**统一写响应**，才能保证错误信封一致（`{ ok:false, error, message, details }`）与 `stats()` 指标记账不被绕过 —— **这正是"只堵了详情页、旁路却还开着"这类事故的来源**（§0.2）。
- **状态码只开放三个语义明确的值**：`401` = 未认证（缺凭据或凭据无效）；`403` = 已认证但无权限；`503` = **系统尚未就绪**（如引导期没有任何凭据来源），**不是**"未认证"。
- **失败关闭**：只有显式 `{ ok: true }` 才放行。返回值**形态不合法**（非对象、缺 `ok`、状态码不在白名单内）一律**按拒绝处理**，机器码固定为 `hook_invalid_verdict`（`verdictDenial()`，`packages/server/src/index.ts:241-249`）。**不合法形态返回 403 而不是 500**：500 会被看门狗计入"服务连续失败"并可能在阈值处熔断，而这只是**某个插件的编程错误、不是服务不可用**。

##### ③ 可选 `use?(hook: RequestHook): () => void` —— 前置钩子链

```ts
// packages/core/src/index.ts:619
export type RequestHook = (h: RouteHandlerContext) => RequestVerdict | Promise<RequestVerdict>

// packages/core/src/index.ts:698 —— HttpRouterService 上的可选方法
use?(hook: RequestHook): () => void
```

**契约（逐条，与实现内注释同源，见 `packages/core/src/index.ts:602-620`）**：

1. 执行位置：**路由匹配成功之后、处理器执行之前**。按注册顺序**串行**执行。
2. 任一钩子返回 `ok:false` 即**短路** —— 后续钩子与处理器**都不再执行**。
3. 钩子**可以读取、也可以替换** `h.principal`。**这是 P1 会话解析的挂载点**：给匿名主体换上真实用户，再由 `access` 闸门统一裁决。
4. 钩子**不得自行结束响应**（不要调 `h.json` / `res.end`）：**只返回裁决**。否则错误信封与 `stats()` 记账会被绕过。
5. **钩子抛错视同 500**（由路由服务统一处理）—— **不要**用抛错表达"拒绝"，那是**静默失败面**。
6. 只用 `{ ok: true }` 表示"放行"；形态不合法按**拒绝**处理（见 ②）。

- **为什么签名带 `?`（可选实现）**：既有**测试替身**与第三方 `HttpRouterService` 实现无需立刻提供它，**不破坏向后兼容**（与 `noteStatus?` 同理）。⇒ 调用方必须写成 `router.use?.(...)` 或先判空。
- **注销函数幂等**：重复调用安全（`packages/server/src/index.ts:315-323`）。
- **没有钩子时走全同步快路径**：`dispatch` 内部按 `hooks.length === 0` 分流（`packages/server/src/index.ts:259` 的 `private readonly hooks: RequestHook[] = []`；分支在 `:603-609`）⇒ **默认（无钩子）时既有的"同步返回 `boolean`"语义逐字不变**。
- ⚠️ **它不是"全局中间件"** —— 适用边界见下面 **2.5.2 边界一**。

##### ④ `dispatch` 的返回类型放宽为 `boolean | Promise<boolean>`

```ts
// packages/server/src/index.ts:490
dispatch(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>
```

- **为什么放宽（这就是 B1 方案）**：钩子**可以是异步的**（P1 的会话解析要查库拿会话），此时**无法在当拍给出**"是否已接管响应"的结论。而 `dispatch` 的 `boolean` 返回值正是"**要不要交给静态资源层**"的信号 —— 而 **PG 适配器本质异步**（`resolvePrincipal` 接会话后必须 `await` 查库）⇒ **同步解析 principal 根本不可行**，只能把返回值放宽、让调用方 `await` 结算后再决定。
- **语义不变**：`true` = 已接管响应（含 API 404）；`false` = 无匹配路由且非 `/api` 前缀（静态资源层可尝试兜底）。调用方（`packages/server/src/index.ts:1053` 的 `createServer` 回调）用 `isThenable()` 分流 ⇒ **未注册钩子时仍是同步返回**，既有调用路径与测试行为**逐字不变**。
- **给 P1 的提醒（实现里已留 `TODO(p1)`，见 `packages/server/src/index.ts:637`）**：`resolvePrincipal` 目前是**同步**的（凭据来源只有环境变量 + 常量时间比较，没有任何跨 IO 查询），**接入会话查询后必须改为异步**、签名对齐 §2.4 的 `principalFromRequest(req): Promise<Principal>`。改造时有**两处连带影响**（不要只加个 `async` 就以为完事）：
  1. 该方法在 `dispatch` 里是**无条件调用**的（在 `hooks.length === 0` 分支**之外**）⇒ 一旦异步化，**默认（无钩子）路径也会变成异步**，那条"全同步、语义逐字不变"的快路径承诺需要**一并重做**；
  2. 异步接缝**已经留好**：`runHooks` 是 async 通路、`dispatch` 返回值已放宽、调用点已适配。

##### ⑤ `register()` 的可选第 4 参 `opts.access` —— **默认 `public`**（向后兼容）

```ts
// packages/core/src/index.ts:679-684
register(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  handler: RouteHandler,
  opts?: RouteAccessOptions,   // = { access?: RouteAccess }（:490-492），省略等价于 { access: 'public' }
): () => void
```

- **默认 `public` 是向后兼容的核心设计**：既有调用点只传 3 个实参，**行为完全不变**（这正是 §8.2 P0-3"`GET /api/pages` 行为完全不变"能够成立的前提）。**默认值若取 `user`，全仓所有读端点会在升级瞬间集体 401。**
- **等级绑在"路由"上，不是绑在"插件"上**：同一次 `registerRoutes()` 里可以逐端点声明不同等级（见下表）。

**P0 实际落地的等级分配（可直接作为 P1 的基线）**

| 端点 | 等级 | 位置（worktree） |
|---|---|---|
| `PUT /api/pages/:slug`、`DELETE /api/pages/:slug` | `user` | `packages/plugin-wiki/src/index.ts:680` / `:692` |
| 条目读端点（列表 / 详情 / 版本 / 反链 / 出链） | `public`（**未声明 = 默认**） | `packages/plugin-wiki/src/index.ts` |
| `GET /api/plugins`、`/api/plugins/graph`、`/api/plugins/slots`、`/api/plugins/ui` | `public`（**未声明**） | `packages/manager/src/index.ts:1574` / `:1578` / `:1584` / `:1594` |
| `GET /api/session` | `public`（**显式写出**，理由见下） | `packages/manager/src/index.ts:1619` |
| `POST /api/plugins/:name/enable` | `admin` | `packages/manager/src/index.ts:1620`（opts 在 `:1633`） |
| `GET` / `PUT /api/plugins/:name/config` | `admin` | `packages/manager/src/index.ts:1634` / `:1643` |
| `POST /api/plugins/:name/replace`、`/disable` | `admin` | `packages/manager/src/index.ts:1655` / `:1669` |
| `POST /api/session/persist` | `admin` | `packages/manager/src/index.ts:1679` |

- **读端点为什么保持 `public`（P0 的刻意选择，不是漏改）**：① 前端**插件探测**（`packages/web/src/pages/WikiPage.tsx` 据 `/api/plugins` 的 `state` 决定搜索 / AI 入口是否可用）与**插件 UI 加载**（`/api/plugins/ui`）都依赖它们，收紧会让**内容浏览**这一核心路径回归 —— 那不属于 P0 要堵的"整类端点被匿名调用"；② 读路径的裁剪需要**逐对象判定**（`policy-service`），属 P2 的范围。
- **`GET /api/session` 为什么是 `public` 而不是 `admin`**（这条最容易被后人"顺手修掉"）：管理台首屏 `AdminPage` 用 `Promise.all([api.plugins(), api.session(), api.slots().catch(() => null)])` 取数，**三个里只有 `api.session()` 没有 `.catch()`** —— 它一旦 401/503 就整体 reject ⇒ **插件列表根本不渲染**。而 P0 **不许改 `packages/web`**，且前端测试**全部 mock 掉了 `api` 模块**（⇒ **这个回归不会有测试变红**，属于极易漏掉的坑）。所以 P0 的契约是"**读端点行为与改动前逐字一致**"，收紧留给 P2、与读路径裁剪一起做。（就地留痕见 `packages/manager/src/index.ts:1614-1618`。）
- **代价（如实记录，已列入 P2）**：`GET /api/plugins` 与 `GET /api/session` 的响应里**含各插件的 `config`**，P0 **未裁剪** ⇒ 匿名可达的 `config` 回显通道。**交付项与真实向量见 §8.2 P2 第 14 条**（含"密钥值本身因 `apiKeyEnv`/`passwordEnv` 纪律不会泄漏，但 `baseUrl` 里内嵌的凭据会被逐字吐出"）。

##### ⑥ `judgeAccess` 的判定顺序与状态码选择（401 / 403 / 503 各自何时出现）

```ts
// packages/server/src/index.ts:213-229 —— 纯函数，便于单测
function judgeAccess(access: RouteAccess, principal: Principal, credentialSourceAvailable: boolean): AccessDenial | null
```

**判定顺序即优先级（每一步都是失败关闭，"不满足就拒"）：**

| 步 | 条件 | 结果 |
|---|---|---|
| 1 | `access === 'public'` | **放行**（与 P0 之前的行为完全一致） |
| 2 | `principal.kind === 'break-glass'` | **放行**（旁路整个权限体系；留痕在解析 principal 时已完成） |
| 3 | **没有任何凭据来源**（`GEEWIKI_ADMIN_TOKEN` 未配置） | **503** `bootstrap_required` |
| 4 | `principal.kind === 'anonymous'` | **401** `unauthorized`（"需要登录"） |
| 5 | `access === 'user'` | **放行**（已认证即可） |
| 6 | `principal.orgRole` 为 `owner` / `admin` | **放行** |
| 7 | 其余 | **403** `forbidden`（"需要管理员权限"） |

- **`credentialSourceAvailable` 的语义（P0 恒为"`GEEWIKI_ADMIN_TOKEN` 是否已配置"）**：第 3 步**必须排在第 4 步之前** —— 未配置令牌时，带着**任意**令牌头发请求必须得到 503，**绝不能因为"没配令牌"而滑进某个放行分支**（这是 §8.2 P0-5 的验收点）。
- **为什么"引导期"是 503 而不是 401**：401 的语义是"**你去登录**"，但引导期**根本没有可登录的东西**（P0 无用户表；P1 起是"库里没有任何 owner/admin"）。把两者混为一谈，会让前端把**运维问题**显示成"请重新登录"，并在登录页里**死循环**。
- **`403` 什么时候出现**：只可能在"**已认证 + 需要 `admin` + 角色不是 owner/admin**"这一种组合上。⇒ **P0 阶段 `403` 分支在生产里不可达**（`resolvePrincipal` 只会产出匿名或 break-glass，用户会话属 P1），实现的测试用例因此**用 `use()` 钩子注入一个 `kind:'user'`、`orgRole:'viewer'` 的主体**把这个分支钉成断言（`packages/server/test/route-auth.test.ts` 的用例"use()：kind:'user' 但角色不足 ⇒ 403 forbidden"），给 P1 留下回归保护。
- **拒绝时的错误信封统一为** `{ ok:false, error:<机器码>, message:<人读文案>, details:{ access:<被拒的等级> } }`（闸门处见 `packages/server/src/index.ts:693-694`；钩子拒绝处同形）。**§8.2 P0 的测试把 `details.access` 钉成了断言** —— 前端文案与告警匹配规则依赖它。
- **应急通道的留痕点**：`resolvePrincipal()`（`packages/server/src/index.ts:637`）在令牌校验通过时**立刻**调 `auditBreakGlassUse()`（`:180-186`），**不区分端点等级** —— 令牌本身的"使用"就要可追责。P0 的留痕**形态**（stdout 结构化行）与它的**取舍**见 §8.2 的 P0-6。

#### 2.5.2 两条必须写明的边界（P1 最容易踩）

**边界一：钩子链只对"匹配到的路由"生效。**

- `/api/*` **未匹配**的路径、**静态资源**、**SPA fallback** 全部**不过钩子**。原因在分发顺序上（`packages/server/src/index.ts:490-618`）：① 健康检查在**路由匹配之前**就 early-return；② 未匹配的 `/api/*` 直接走路由自己的 **API 404**（`json(404, { ok:false, error:'not_found', path })`，`:613-616`）；③ 其余 `return false` 交给静态资源层（`:617`）。**这三条路都不进入钩子链。**
- **P0 这样是对的**（与 §9 R6 一致：静态层不该被身份系统拖住），但**必须在文档里写明**，否则 P1 会误以为"**注册了会话钩子就等于全局已鉴权**"。正确的心智模型是：`use()` 是"**路由级**准入链"，**不是**"**全局**中间件"；真要覆盖静态资源与 SPA fallback，得另找挂载点，且必须先解决"静态层不该被拖住"这个前提。
- 已由测试钉住：`packages/server/test/route-auth.test.ts:382-398`（用例名"**注册钩子后：路由匹配与静态层交接的行为逐字不变**"）—— 断言注册钩子前后，非 `/api` 路径的静态层交接与未匹配 `/api/*` 的 404 **逐字一致**。
- 实现内的就地说明：`RequestHook` 契约**第 6 条**（`packages/core/src/index.ts:611-615`）与 `use?()` 的 ⚠️ 注释（`:688-691`）都已写明这条边界。

**边界二：健康检查 `/api/health` 刻意留在闸门之外。**

- `HEALTH_PATH = '/api/health'`（`packages/core/src/index.ts:367`）在 `dispatch` 里**早于路由匹配**就被处理并 `return true`（`packages/server/src/index.ts:538-568`）⇒ **它既不过钩子、也不受 `access` 闸门约束**（P0 之前就是这样，P0 未改）。
- **理由**：把健康检查纳入鉴权，会让"**权限没配好**"表现为"**服务不可用**" —— Docker `HEALTHCHECK` 与看门狗会因此误判，去重启 / 熔断一个其实完全正常的服务，**反而更难排障**。健康检查的语义是"**进程还活着**"，不是"**权限配好了**"；后者该由专门的就绪 / 运维端点表达（P1 起可考虑）。
- **代价（如实写在文档里）**：`/api/health` 是**匿名可探测**的，会回显 `ok` / `uptime` / `timestamp` / `db` 等**非敏感**运维信息。**不要**往它的响应里加任何身份相关或配置相关字段 —— 否则这个"闸门外"的端点会变成新的泄漏面（与 §5.9 的清单同源）。
- **P0 之前的文档完全没提这条** ⇒ 本条是 v6 补写的**边界说明**，不是新决策（§8.1 的 P0 行从未要求把健康检查纳入闸门）。

#### 2.5.3 本节与其它章节的关系

- **§0.1 ②**（"请求上下文里没有『人』"）已被 P0 部分推翻 ⇒ 该节已加**就地订正**。
- **§8.1 的 P0 行**列出本节的落地范围与涉及文件；**§8.2 的 P0 六条**是它的可测验收标准。
- **§9 R2**（权限判定必须逐调用传 `principal`）与本节**不冲突、且互补**：`access` 闸门是**粗粒度**的，R2 要求的"逐对象判定 + 服务层二次校验"**一条都不能少**。
- **§9 R6**（静态资源 / SSE 路径的鉴权覆盖）是"边界一"的另一面：钩子覆盖不到静态层，门户渲染分支因此**必须**放在 `serveStatic` 之前。
- **本节不引入新决策**：三档枚举、钩子、状态码语义都能从 §0.1 的缺口 + §2.4 的判定单点推出；本节只是把**已经落地的形状**固定下来。**若 P1 确有必要改动它们，请按 v6 的方式再留一次记录（§13.4 式），而不是静默改掉** —— 那正是本节存在的理由。

---

## 3. 数据模型

### 3.0 迁移约定（动手前必须先读）

- 新增表**必须双侧方言成对**：`packages/db-sqlite/src/migrations/000N_*.sql` ↔ `packages/db-postgres/migrations/000N_*.sql`。
- **序号建议双方言统一从 `0010` 起编**。原因（原文如此，实现前需复核）：SQLite 侧已用到 `0002_pages_updated_at_index.sql`，而 PG 侧只有 `0001_init.sql`（PG 把同一索引并进了 `0001`）⇒ **两侧序号已经不同步**，从 `0010` 起编可以避免"逐一对齐"的心理负担。
- 迁移文件内**不写 `BEGIN/COMMIT`** —— 控制器已逐文件包事务（`packages/db-sqlite/src/index.ts:77-101`）。
- 全部语句用 `IF NOT EXISTS`，保证 `db.migrate()` 幂等重放安全。
- **FTS 相关迁移的归属插件是 `@geewiki/search`，不是 db 插件**。它的文件在 `packages/plugin-search/migrations/`（现有 `0001_search.sql` 就是它）。定义 `pages` 表的是 `packages/db-sqlite/src/migrations/0001_init.sql`。**这直接影响 §4.3 的落地位置。**
  > **★ v7 补充（与上面第 1 条的边界，必须一起读）**："**必须双侧方言成对**"这条规则**只管 db 插件的迁移**（`packages/db-sqlite` ↔ `packages/db-postgres`）。**`@geewiki/search` 的迁移是 SQLite 专有的**（FTS5 语法，PG 上根本没有对应物）⇒ 它**没有也不该有 VIRTUAL TABLE** 的 PG 孪生文件；正确的姿势是**在 manifest 里按方言声明迁移目录**，让 PG 下直接跳过（`migrations: { sqlite: './migrations' }`）。现状是用裸字符串声明的 ⇒ PG 下会被执行并失败，见 **§4.3 的「★ v7：方言语义」**。
- 内置插件的迁移目录在 `defaultRegistry()` 硬编码（`packages/server/src/index.ts:938-1017`）。

### 3.1 `0010_identity.sql` —— 用户、凭据、会话、外部身份

```sql
-- 0010_identity.sql（P1 建全；P1.5 才写入 identities）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,       -- PG: GENERATED BY DEFAULT AS IDENTITY
  org_id        INTEGER NOT NULL DEFAULT 1,              -- 本期恒 1；为多租户预留
  email         TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active',        -- active|invited|disabled
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_email ON users(org_id, email);

-- ★ v2 新增：OIDC 骨架（P1 就建表，P1.5 才用）
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;  -- PG: BOOLEAN
-- 说明：本地账号创建即视为已验证（1）；OIDC 首次登录时按 IdP 的 email_verified 声明写入。
-- **不宣称任何安全保证**：本地账号能被创建本身就意味着该 email 已被占用，
-- 该标记只用于阻塞"未验证 email 触发的自动合并"（见第 7 节）。

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  algo          TEXT    NOT NULL,           -- 'scrypt' | 'argon2id'（存算法名，便于将来升级）
  params        TEXT    NOT NULL,           -- JSON: {N,r,p} 或 {m,t,p}
  salt          TEXT    NOT NULL,
  hash          TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    PRIMARY KEY,        -- 128bit 随机，token 只存**哈希**
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL,           -- sha256(raw token)，DB 泄露不可直接冒用
  created_at    TEXT    NOT NULL,
  last_used_at  TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,           -- 绝对过期（30d）
  idle_expires_at TEXT  NOT NULL,           -- 空闲过期（7d），每次使用滑动
  revoked_at    TEXT,                        -- 非 NULL = 已吊销（登出/改密/踢下线）
  user_agent    TEXT,
  ip_hash       TEXT                         -- 只存哈希：审计够用，避免存 IP 原文
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ★ v2 新增：外部身份（一个 user 可以有多个 identity）
CREATE TABLE IF NOT EXISTS user_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer        TEXT    NOT NULL,          -- OIDC iss，**原样存**（含尾部斜杠差异也算不同）
  subject       TEXT    NOT NULL,          -- OIDC sub
  email_at_link TEXT,                      -- 绑定时 IdP 声明的 email（快照，不参与判定）
  linked_at     TEXT    NOT NULL,
  last_login_at TEXT
);
-- 核心约束：同一 (issuer, sub) 全局唯一 ⇒ 一个 OIDC 身份只能绑一个本地用户
CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_issuer_sub ON user_identities(issuer, subject);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);
-- **注意：email 上没有唯一约束** —— 同一 IdP 下不同 sub 可能有相同 email；
-- 唯一性只由 (issuer, subject) 保证。
```

> **为什么 `email_verified` 与 `user_identities` 必须提前到 P1 建**（v2 的顺序修正）：若 P1 不建，P1.5 会需要一次额外的 `ALTER TABLE` + 一次 email 验证状态的回填。而**回填逻辑无法判断历史账号是否验证过**，只能全置 0 或全置 1，两者都会让"自动绑定"策略在过渡期行为不确定。

> **★ v7 核对（`link_ticket` 不落库的事实基础，与 §7.2 配套）**：本迁移**没有任何存 ticket 的表** —— 全仓 `grep -rn ticket packages/db-sqlite/src/migrations/ packages/db-postgres/migrations/` **零命中**。因此 §7.2 原写的"`link_ticket` 存 DB"**在 P1/P1.5 的边界内根本无处落库**，v7 已把那句改成"**HMAC 签名的自包含票据，不落库**"（理由与安全性论证见 §7.2 的 ★ v7 小节）。本节 DDL 与之一致，**无矛盾表述**：P1 建的表只有 `users` / `user_credentials` / `sessions` / `user_identities`（另有 §3.4 的 `audit_log` 等，见 §8.1 P1 行）。

### 3.2 `0011_org_team.sql` —— 组织、成员、组、邀请

```sql
-- 0011_org_team.sql
CREATE TABLE IF NOT EXISTS orgs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  visibility     TEXT    NOT NULL DEFAULT 'private',   -- 站点级默认：private|public
  created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id        INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT    NOT NULL,           -- owner|admin|member|viewer
  joined_at     TEXT    NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

CREATE TABLE IF NOT EXISTS groups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  created_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_org_name ON groups(org_id, name);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at   TEXT    NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id           TEXT    PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email        TEXT    NOT NULL,
  org_role     TEXT,                        -- NULL = guest 通道（无组织角色）。
                                            -- ★ 这一列是"入伙后拿到哪个角色（能力）"，**不是授权对象**，与 subject_kind 无关（§2.0、§12 第 17 条）
  group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,  -- 邀请即入组
  invited_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  token_hash   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  accepted_at  TEXT,
  created_at   TEXT    NOT NULL
);
```

> **为什么要支持"邀请到组"**：给组授权意味着"**任何人被加入/移出该组时自动获得/失去对应权限**"，不必逐个改授权。

### 3.3 `0012_page_acl.sql` —— 条目可见性字段 + 页面级例外授予

```sql
-- 0012_page_acl.sql（P2 落地，且 ★ P2 不动 FTS）
ALTER TABLE pages ADD COLUMN visibility    TEXT    NOT NULL DEFAULT 'private';
ALTER TABLE pages ADD COLUMN inherit       INTEGER NOT NULL DEFAULT 1;   -- PG: BOOLEAN
ALTER TABLE pages ADD COLUMN published_at  TEXT;
ALTER TABLE pages ADD COLUMN created_by    INTEGER;         -- 不加 FK：用户删除后条目留存
ALTER TABLE pages ADD COLUMN acl_revision  INTEGER NOT NULL DEFAULT 0;   -- 本条 acl 版本（★ v8 订正：原注释写"用于缓存失效"，实情是**全仓没有任何读取方**）
ALTER TABLE pages ADD COLUMN content_hash  TEXT;            -- ★ v2 新增：与 blocks 的一致性校验
CREATE INDEX IF NOT EXISTS idx_pages_visibility ON pages(visibility, published_at);

CREATE TABLE IF NOT EXISTS page_grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_slug    TEXT    NOT NULL,            -- 绑 slug 而非 page_id：条目删除重建后授予不悬空复活
  subject_kind TEXT    NOT NULL,            -- ★ v3：user|group（**不含 org_role** —— 角色只决定能力，不是授权对象，见 §2.0）
  subject_id   TEXT    NOT NULL,            -- userId / groupId（不再有 'member' 这类角色字面量）
  role         TEXT    NOT NULL,            -- editor|viewer
  granted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at   TEXT    NOT NULL,
  expires_at   TEXT                          -- 外部协作者到期自动失效
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_grants_unique
  ON page_grants(page_slug, subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_page_grants_subject
  ON page_grants(subject_kind, subject_id);
```

> **★ v5（D8 派生项，用户要求显式记录）：`pages.visibility` 有"两层默认值"，别搞混**
> - **DDL 层（数据库默认）= `'private'`** —— 故意保持**最严档、失败关闭**：任何"忘记设置可见性"的插入路径（将来的导入脚本、第三方插件、直接写库）都落到"仅被显式授权的人可见"，**不会**意外公开。
> - **应用层（新建条目的默认）= `'org'`** —— 通过产品界面 / API 新建条目时**显式写入** `'org'`（组织内可见），这是本产品的常态（D8 的存量回填也落在同一档）。
> - 两者**不冲突**，各自解决不同问题：DDL 默认守的是"没人管的写入路径"，应用默认守的是"人的日常体验"。**这是刻意的两层，不是自相矛盾**（在 §12 也已留痕）。
>
> **所以：新建的页面默认是"组织内可见"，不是"私有"。** 若只看到 DDL 里的 `DEFAULT 'private'` 就断言"这个产品新建页面默认私有"，那是**误读** —— 完整依据见 §10.1 D8、§8.1 P2、§8.2 P2 第 13 条。

**相对 v1 的三处删减（v2 订正，重要）**
1. **删 `ancestor_path`**：块级模型下判定必须逐块进行，`ancestor_path` 的批量预筛收益被 `blocks` 的 JOIN 吞掉，而它引入"物化副本漂移"的维护成本。祖先收紧改为**按 slug 前缀实时计算** —— `SLUG_MAX_DEPTH=8`（`packages/plugin-wiki/src/index.ts:242-298`）保证最多 7 次前缀查询，且这些前缀**走 `slug` 的唯一索引**。
   **缓解**：`policy-service` 内做**请求级 memo**（同请求内同前缀只查一次），把 N×8 次查询压到 ≤8 次。
2. **删 `space_slug`**：块级模型已经提供了"分区"的表达能力（`blocks` + 可见性），再引入 `space_slug` 会出现两套并行的分区概念。分区改为**约定 slug 首段**，不落列。
3. **删 `idx_pages_ancestor`**：随 `ancestor_path` 一起去掉。

**条目层级用 slug 前缀还是显式 `parent_id`？—— 结论：保留 slug 前缀为唯一真源**

理由（逐条绑定现有代码事实）：

1. **`SLUG_MAX_DEPTH=8` 已给深度封顶**（`packages/plugin-wiki/src/index.ts:242-298`）。父链最坏 8 跳，任何"父链展开"的复杂度都是常数级 —— 引入 `parent_id` 换来的收益（避免字符串前缀匹配）在这里不成立。
2. **`page_links` 刻意无 FK**（`packages/plugin-wiki/migrations/0001_page_links.sql`，允许指向不存在页面的"红链"）。若给 `pages` 加自引用 FK 与级联规则，就出现了"同一套层级概念里一部分有 FK 一部分没有"的不一致；维护者迟早会问"为什么 target_slug 不级联"。保持"层级 = slug 字符串"这一条心智模型，比多一张层级表更省信任成本。
3. **FTS5 的触发器直接读 `new.content` / `old.content`**（`packages/plugin-search/migrations/0001_search.sql`）。本设计必须给 `pages` 加列 —— 任何 `UPDATE pages` 都会触发 `pages_fts_au` 的 delete + insert 两步。**不给层级加表能显著减少这一改动面。**
4. **移动语义反而更简单**：移动 = 改 slug → 重算本条的祖先关系。若用 `parent_id`，移动子树需要"递归更新所有后代的祖先链"，而物化祖先路径正是这件事的副本（双写 = 双写不一致风险）。

**代价（诚实列出）**：判定必须两步（先算出祖先链，再逐条判定），不能一条 SQL 出结果；重命名祖先 slug **不会自动改后代**（现状亦如此），提供运维端点 `POST /api/admin/pages/rebuild-ancestry` 作为兜底并审计留痕。

### 3.4 `0013_audit.sql` —— 全局 ACL 版本号 + 审计日志

```sql
-- 0013_audit.sql
CREATE TABLE IF NOT EXISTS acl_revision (            -- 全局 ACL 版本（Zanzibar 风格）
                                                     -- ★ v8 订正：它是**变更留痕 / 观测信号**，
                                                     -- **不是**失效机制 —— 判定层无缓存，全仓无读取方
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  revision  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT    NOT NULL,
  actor_id     INTEGER,                     -- NULL = 系统/引导
  actor_ip_hash TEXT,
  action       TEXT    NOT NULL,            -- acl.change|page.publish|login.ok|login.fail|access.denied
                                            -- ★ v3 新增取值：access.admin_override（owner/admin 的应急覆盖式访问，见 §2.3 规则 O1）
  target_kind  TEXT    NOT NULL,            -- page|user|group|grant|session|org
  target_id    TEXT    NOT NULL,
  before_json  TEXT,                        -- **不含正文**
  after_json   TEXT,
  request_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);
-- append-only：不提供 UPDATE/DELETE 路径（应用层约定 + 迁移注释写明）
```

> **为什么不记正文**：OWASP 指出日志"太多"本身也是弱点（CWE-779）—— 敏感数据被无谓写进日志。审计日志只记**元数据与差异**。

### 3.5 `0014_access_requests.sql` —— 申请访问

```sql
-- 0014_access_requests.sql
CREATE TABLE IF NOT EXISTS access_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_slug    TEXT    NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message      TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending',   -- pending|approved|denied|withdrawn
  decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at   TEXT,
  created_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_req_pending
  ON access_requests(page_slug, user_id, status);
```

> 为什么要有这个表："申请访问"让用户不必去找管理员私聊，是一个**一等流程**。

### 3.6 `0015_blocks.sql` —— 内容块（块级模型的核心）

> **★★ v8 订正（两处，都会导致"迁移跑了但表没建"）**：
>
> **① 迁移落点是错的（原文如此 → 实情不同）**。本节原写作"属于 `@geewiki/wiki` 的迁移目录 `packages/plugin-wiki/migrations/`"。
> **照原文写，PostgreSQL 部署下 `blocks` 表根本不会被建出来**：`@geewiki/wiki` 的迁移目录**只声明了 sqlite** ——
> `packages/plugin-wiki/src/index.ts:112` 的 `WIKI_MIGRATIONS_DIR` 在 `packages/server/src/index.ts:1405` 被注册为
> `builtinMigrations(wikiManifest, { sqlite: WIKI_MIGRATIONS_DIR })`（**没有 `postgres` 键**）⇒ PG 下取不到目录、走"跳过迁移"分支。
> **实情**：`blocks` 的迁移落在 **db 包、两侧成对** ——
> `packages/db-sqlite/src/migrations/0015_blocks.sql` 与 `packages/db-postgres/migrations/0015_blocks.sql`
> （这也是双方言成对要求的正确落点，与 §3.0 的迁移约定一致）。
>
> **② `tier` 必须内联在 `CREATE TABLE` 里**，**不能**另起一条 `ALTER TABLE … ADD COLUMN`
> —— **SQLite 没有"加列时若已存在则跳过"的语法**，独立 `ALTER` 会让该迁移**无法重放**（第二次跑时
> `CREATE TABLE IF NOT EXISTS` 会跳过建表，而 `ALTER` 仍会执行并因"列已存在"报错）。
> 下面的 DDL 已按实情改正（`tier` 内联、且**不给默认值**）。

```sql
-- 0015_blocks.sql（落在 db 包、两侧成对：packages/db-sqlite/src/migrations/ 与 packages/db-postgres/migrations/）
--   ★ v8：不要写进 packages/plugin-wiki/migrations/ —— @geewiki/wiki 只声明 sqlite 目录，
--          PG 部署下会被整段跳过 ⇒ blocks 表不存在。
CREATE TABLE IF NOT EXISTS blocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,          -- 文档序，0 起连续；**块标识位是 (page_id, ordinal) 的解析结果**
  kind          TEXT    NOT NULL,          -- paragraph|heading|code|list|list_item|quote|table|html|gated
  text          TEXT    NOT NULL,          -- 该块的 Markdown 源（**未裁剪**，与 pages.content 同真源）
  visibility    TEXT    NOT NULL DEFAULT 'public',  -- ★ v4：public|org|granted（受规则 B1 约束；不再有"仅编辑者"）
  inherit       INTEGER NOT NULL DEFAULT 1,
  marker        TEXT,                      -- 来源标记原文（如 'org'/'granted'），NULL = 未标记
  content_hash  TEXT    NOT NULL,          -- sha256(text)：检测"文本变了但 ordinal 没变"
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  -- ★ v4 / ★ v8：检索用的密级冗余列（派生列，随页面可见性变化重算）
  --   取值域收敛为 { 0 = anon, 1 = org }；**`granted` 档的块不进入任何等级索引，此列写 NULL**（理由见 §4.3）
  --   ★ v8：**必须内联在这里**（不能另起 ALTER，见本节上方订正 ②）；
  --   且**故意不给默认值** —— `DEFAULT 0` 会让"忘了算 tier"的块以**匿名等级**进索引（若它其实是 org/granted，那就是**泄漏**）。
  --   无默认（NULL）的失败方向是"该块搜不到"，且由 §4.3 的一致性探针（`tier IS NULL` 计数）兜住。
  tier          INTEGER
);
-- 查询路径：按页取块（渲染/投影/RAG 全走这条）
CREATE INDEX IF NOT EXISTS idx_blocks_page_ordinal ON blocks(page_id, ordinal);
-- 治理查询："哪些块被单独收紧过"
CREATE INDEX IF NOT EXISTS idx_blocks_visibility ON blocks(visibility) WHERE visibility <> 'public';
-- 检索路径：等级分支 `b.tier <= ?` 走这条（§4.3 的 FTS 查询 JOIN 后用）
CREATE INDEX IF NOT EXISTS idx_blocks_tier ON blocks(tier);
-- 一致性探针（§4.3）：两个数必须相等，不等即有块被漏算
--   SELECT COUNT(*) FROM blocks WHERE tier IS NULL;                 -- 必须等于 ↓
--   SELECT COUNT(*) FROM blocks WHERE visibility = 'granted';
```

**`blocks` 与 `pages.content` 的关系（这是 v2 对 v1 思路的关键订正）**

- `pages.content` = **作者源快照**（原文，含标记）。CodeMirror 6 **零改造**，`PUT /api/pages/:slug` 的请求体**完全不变**。
- `blocks` = **解析出的结构化真源**。它**不是**"可有可无的缓存"——因为**块级授权必须钉在稳定的块身份上**，不能钉在一次解析结果上。
- **同一事务双写**：`savePage()`（`packages/plugin-wiki/src/index.ts:489-531`，已有 `adb.transaction` 用法见 `:491-513`）在**既有事务内**追加"解析 → 删旧 blocks → 插新 blocks"。
- **一致性校验**：`pages.content_hash = sha256(content)`。启动时自检 + `GET /api/admin/blocks/verify` 报告不一致数（应恒为 0）。**这是"双写漂移"的探针。**

### 3.7 `0016_block_grants.sql` / `0017_version_blocks.sql`

```sql
-- 0016_block_grants.sql（P3b）块级例外授予，比照页面级
CREATE TABLE IF NOT EXISTS block_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id     INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  page_slug    TEXT    NOT NULL,   -- 冗余存 slug：页面移动/重命名时 grant 不失效（块 id 稳定）
  subject_kind TEXT    NOT NULL,   -- user|group（★ v3：与页面级 page_grants **完全同构**；同样不含 org_role）
  subject_id   TEXT    NOT NULL,
  role         TEXT    NOT NULL,   -- editor|viewer
  granted_by   INTEGER, granted_at TEXT NOT NULL, expires_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_block_grants_unique ON block_grants(block_id, subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_block_grants_page ON block_grants(page_slug);
-- ★ v4 新增：按主体反查"这个人/这个组被授予了哪些块" —— 检索时要先拿这个集合（§4.3）。
--   与页面级的 idx_page_grants_subject 对齐；缺它则每次检索都退化成全表扫 block_grants。
CREATE INDEX IF NOT EXISTS idx_block_grants_subject ON block_grants(subject_kind, subject_id);
```

> **★ v3：`block_grants` 与 `page_grants` 现在完全同构** —— 同名的 `subject_kind`（只有 `user|group`）、同名的 `role`（`editor|viewer`）、同一条"只放宽、不收紧"。唯一差别是"挂在块上还是挂在页面上"。原 D12（"块级要不要支持角色主体"）因此**作废**：不是块级做了特殊选择，而是**页面级也去掉了角色**（§10.4、§2.0）。

```sql
-- 0017_version_blocks.sql（P3c）版本里带上块与权限快照
ALTER TABLE page_versions ADD COLUMN blocks_json TEXT;   -- 该版本的块集合快照（JSON 数组）
ALTER TABLE page_versions ADD COLUMN acl_json    TEXT;   -- ★ 该版本的页面级 acl 快照（visibility/published_at/inherit）
```

**为什么选"JSON 列"而不是 `page_version_blocks` 关联表**

| 维度 | (a) `blocks_json` 列 | (b) `page_version_blocks` 表 |
|---|---|---|
| 迁移 | `ALTER TABLE ADD COLUMN` ×1，**完全可逆** | `CREATE TABLE` + 回填 + 新索引 |
| "恢复此版本" | 读一行 → 反序列化（**无 JOIN**） | 多条 JOIN + 需重建块 id |
| 权限快照 | 同一 JSON 里一起存 | 需要再一张表或再一列 |
| 代价 | 逐块查询"这块改过几次"需 JSON 扫描 | 可 SQL 查询块级历史 |
| 本项目实际需求 | 主导场景是"看这版长什么样 + 恢复它" | 块级 diff 是**未提出**的需求 |

**PG 写法的两个要点**

- `blocks_json` 用 `TEXT` 而非 `JSONB`：业务代码只做整体读写、不做 JSON 查询，`TEXT` 让双方言 SQL **逐字相同**（`JSONB` 在 SQLite 侧无对应类型，会出现方言分支）。PG 侧 `ADD COLUMN` 无默认值 ⇒ 不加 `NOT NULL` ⇒ 既有无默认值的行保持 NULL。
- `blocks_json` 体积可能较大（数十 KB）：**必须在 `restoreVersion` 里做大小上限校验**（如 1MB），否则一次恢复可写入超限数据。用既有 413 语义（`packages/plugin-wiki/src/index.ts:296-324` 的"消息前缀即错误码"）。

---

## 4. 块级内容模型（用户已选定：每块独立权限与版本）

> 这一节回答四个硬问题：**① 块级如何同时保住 FTS / 版本历史 / AI RAG 三条既有链路；② 块身份怎么稳定；③ 分层索引怎么做；④ 版本与恢复的语义。**

### 4.1 作者格式（编辑器零改造）

**格式约定**：块边界用**空行分隔的标准 Markdown 块** + 一个行内指令标记：

```text
## 部署说明

任何人都能看到的公开部分。

<!--gated:org-->
内部拓扑与密钥轮换流程……
<!--/gated-->

<!--gated:granted-->
运维备注……
<!--/gated-->
```

- **CodeMirror 6 零改造**：标记就是普通文本，编辑器语法高亮是**可选的 P3d 增强**（不是前置条件）。
- 标记的**语义**（★ v4 改）：`gated:org` ⇒ 该区间的块 `visibility='org'`；`gated:granted` ⇒ `visibility='granted'`（**默认谁都看不到**）。
  **原文如此，实现前需复核**：v2/v3 写的是 `<!--gated:role=editor-->` ⇒ `visibility='private'`；v4 已把该语法与语义一并废弃，**解析器必须拒绝 `role=*` 形式的旧标记**（否则老文档里的 `role=editor` 会被静默忽略，作者以为收紧了、其实是公开的）。
- **使用说明（★ v4 新增，要写进编辑器帮助文案）**：
  - **"只想给自己看"** = 写 `<!--gated:granted-->`，**再把自己加进这个块的授权**（`block_grants`，`subject_kind='user'`）。两步都要做 —— 只写标记的结果是"**谁都看不到**"（包括作者自己；owner/admin 靠应急权能看，见 §2.3 规则 O1）。
  - "给组织成员看" = `<!--gated:org-->`；"给某个团队看" = `gated:granted` + 授权该团队；"给某个外部人看" = 保持 `public`/`org` 并单独授权给他（授权始终是**放宽**方向，§2.2）。
- **解析器归属**：`@geewiki/wiki` 内新增纯函数 `parseBlocks(content) → ParsedBlock[]`，**同一函数被服务端写入路径与前端预览共用**（前端需持镜像副本，见 §9 R3）。

### 4.2 块身份与授权保留规则（**保守重解析**）

**问题**：如果块的身份只用 `ordinal`（第几块），在文档开头插入一个段落就会让**所有** ordinal 后移 ⇒ 所有块级授权指向错误的块。**这种"静默错配"比丢失更危险。**

**解法**：保守重解析。规则必须写死并在测试里钉住：

| 编辑类型 | 授权保留？ | 判据 |
|---|---|---|
| 纯文本编辑（块数不变） | **保留** | `ordinal` 对应 + `kind` 相同 |
| 在某块后插入新块 | **保留**（后续块 ordinal 后移） | 按 `kind` 序列对齐 |
| 删除未授权的块 | 保留其余 | — |
| 移动块（引用式移动） | **保留** | `kind` 序列 + 文本哈希匹配 |
| **拆分**一个已授权块为两块 | **保留，且两块都继承授权**（安全方向） | 父块被视为"变成多个" |
| **合并**两个块（其中至少一个已授权，可见性不同） | **拒绝保存**：409 `block_merge_conflict`，要求用户先撤销授权 | 静默丢授权 = 静默放宽/收紧，不可接受 |
| **删除**一个已授权块 | **拒绝保存**：409 `block_grant_orphan`，要求先撤销授权 | 静默丢授权 = 审计断裂 |

> **设计原则**：授权丢失与授权误施都要**显式化**。宁可让用户多一次点击，也不接受"保存后某段悄悄变公开/变私有"。

### 4.3 分层 FTS 索引 —— 「实测」结论，含两个必须避开的坑

#### 实测环境与实测了什么

环境：`better-sqlite3@13.0.3`，SQLite **3.53.4**（探测用 `:memory:` 库）。

| 尝试的形态 | 结果 |
|---|---|
| `fts5(..., content='', contentless_delete=1, tokenize='trigram')` | ✅ 可建、可 `INSERT`、可 `DELETE WHERE rowid=?`、`MATCH` 正确、改写后旧词元不残留 |
| `fts5(text, tier UNINDEXED, content='', contentless_delete=1, ...)` 且 `WHERE tier <= ?` **写在 FTS 表上** | ❌ **静默返回 0 行**（contentless 表的 `UNINDEXED` 列不可读，`tier` 为 NULL ⇒ 谓词恒 NULL）。**这是最容易踩的坑：不报错，只是搜不到** |
| `fts5(..., content='blocks_fts_content', content_rowid='id', tokenize='trigram')` + 额外 `tier UNINDEXED` 列 | ✅ 可建，但需要额外一张内容表 ⇒ **内容存两遍**（页面原文 + 投影），空间翻倍 |
| tier 过滤**放在 JOIN 后的 `blocks` 表上** | ✅ **正确工作**（见下表） |
| `snippet()` 对该表 | **★ v8 订正：返回 `null`，而且不报错（静默失败）**（原写"返回空"，没有说清它**不抛错**）—— 本项目**不用**它（高亮自实现），**但这是一条须写入文档的约束** |

**实测的 tier 过滤正确性**（3 字元以上的中文查询）：

| 查询 | anon(tier≤0) | member(tier≤1) | editor(tier≤2) |
|---|---|---|---|
| 「拓扑图」（org 块） | **[]** | `[2]` | `[2]` |
| 「密钥轮换」（org 块） | **[]** | `[2]` | `[2]` |
| 「运维备注」（private 块） | **[]** | **[]** | `[3]` |
| 「知识库」（public 块） | `[1]` | `[1]` | `[1]` |

> **★ v4 对这张实测表的读法（数字不变，但不要照抄第三列）**：这张表是在 v2 档位模型（`0=anon / 1=org / 2=编辑者`）下实测的，**第三列 `editor(tier≤2)` 与"运维备注（private 块）"那一行属于已经作废的"仅编辑者"档**。
> v4 之后**仍然成立、也是这张表真正要证明的**是两条：① **tier 过滤放在 JOIN 后的 `blocks` 表上是正确的**；② **anon 列对 org 块恒为空**（`[]`）。
> 而"运维备注"那类块在 v4 下是 `granted` 档（`tier = NULL`）⇒ 它在 `member(tier≤1)` 列**同样是空**（与表中那一行的 `[]` 一致），**但命中它的唯一途径变成了授权分支**（见下）。**这里没有重新实测，只是把旧数字重新解释**；v4 的检索形态（等级分支 + 授权分支）**尚未实测，实现前需实测复核**。

#### 推荐形态（照抄）

```sql
-- packages/plugin-search/migrations/0002_blocks_fts.sql
-- 1) 块级索引表：contentless + contentless_delete，省掉一份正文（已实测可删可改）
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  text,
  content='',                    -- ★ 必须显式空串：contentless_delete=1 要求 contentless 表
  contentless_delete=1,          -- ★ 支持 DELETE WHERE rowid=?（要求 SQLite ≥3.43；本仓 3.53.4）
  tokenize='trigram'             -- 保持与 0001_search.sql 一致的中文可检索性
);
-- 2) rowid = blocks.id（应用层显式指定），tier 过滤走 JOIN blocks，见下
```

```sql
-- 检索（FTS 路，替换 packages/plugin-search/src/index.ts:395-400 的两条 SQL）
-- ★ v4：过滤条件由"一条等级谓词"改为"**等级分支 OR 授权分支**"（为何必须这样，见本节下方）
SELECT COUNT(DISTINCT b.page_id) AS n
  FROM blocks_fts f JOIN blocks b ON b.id = f.rowid
 WHERE blocks_fts MATCH ?
   AND ( b.tier <= ?                                    -- ① 等级分支：anon=0 / org=1
         OR b.id IN ( /* :grantedBlockIds */ ) )        -- ② 授权分支：本主体被显式授权的块（granted 档只能由此命中）

SELECT p.slug, p.title, p.updated_at, b.ordinal, f.rank AS score
  FROM blocks_fts f
  JOIN blocks b ON b.id = f.rowid
  JOIN pages  p ON p.id = b.page_id
 WHERE blocks_fts MATCH ?
   AND ( b.tier <= ? OR b.id IN ( /* :grantedBlockIds */ ) )
 ORDER BY f.rank LIMIT ?
```

**为什么给 `blocks` 加一个 `tier` 冗余列**：`tier` 是页面有效可见性与块可见性的**组合结果**（★ v8 订正：**`max(page, block)`**，不是原文写的 `min(page, block)` —— 理由见 §2.3 规则 B1 的 ★ v8 小节）。它随祖先可见性变化而变，所以是**派生列**（页面的可见性/`inherit`/`published_at` 一变，该页**及其全部子孙**的块都要重算 —— 这条扇出是**跨阶段不变量**，见 §4.6）。把它放在 `blocks` 上，FTS 查询就是一条 `AND b.tier <= ?`，**且这条路径已实测正确**。相对把 `tier` 放进 FTS 表（不可行）或建多张 FTS 表（跨表 `rank` 不可比），这是唯一同时满足"正确 + 单表 + 可比排名"的形态。

> **★ v8 新增：`blocks_fts` 只索引块文本 ⇒ FTS 路不再按标题匹配**（这是上面这条 SQL 形态的**直接后果**，必须写明，否则会被当成 bug）。
> 索引表定义只有一列 `text`（`packages/plugin-search/migrations/0002_blocks_fts.sql:37-42` 的 `fts5(text, content='', contentless_delete=1, tokenize='trigram')`），
> 而 FTS 路是 `WHERE f.blocks_fts MATCH ?`（`packages/plugin-search/src/index.ts:579` / `:588`）—— **`p.title` 只出现在 `SELECT` 里（`PAGE_COLUMNS`，`:440`），从不参与匹配**。
> **⇒ 只出现在标题里、正文块中没有的词，在 FTS 路上搜不到。**
> **而 LIKE 兜底路（< 3 字符短查询）仍然匹配标题**：`packages/plugin-search/src/index.ts:611` / `:619` 是
> `WHERE (p.title LIKE ? ESCAPE '\\' OR b.text LIKE ? ESCAPE '\\')` ⇒ **两条路的召回面不同**（这是 P3a 之前没有的差异）。
> **已被断言钉住**：`packages/plugin-search/test/search.test.ts:558` 的用例名就是「`snippet：截断补省略号；★ P3a 标题不再参与 FTS 匹配（只索引块文本）`」（断言 `:575`：*"块索引不含标题 ⇒ FTS 路搜不到『只出现在标题里』的词"*）。**⇒ 不要"顺手补上标题索引"** —— 那会改变 `rowid ↔ blocks.id` 的对齐前提（本文件 `:44-46`），进而破坏整个 tier 过滤形态。

#### ★ v7：方言语义 —— 这套 FTS 形态**仅支持 SQLite**（PG 下检索插件**显式拒绝激活**，不是静默恒空）

**结论先行**：`blocks_fts` 沿用 **FTS5**（`contentless + contentless_delete=1 + tokenize='trigram'`），**FTS5 是 SQLite 专有特性** ⇒ **本节整套设计（含 tier 分层可见性）只在 SQLite 部署下成立**。这是**已知且经过权衡的限制，不是遗漏**。

**PostgreSQL 部署下的行为（刻意的设计，不是 bug）**：`@geewiki/search` 在 `apply()` 里**用方言守卫提前拒绝激活**，而不是启动成功、检索恒为空。源码注释（原文引用，`packages/plugin-search/src/index.ts:308-312`）：

> 全文索引建立在 SQLite 专有的 FTS5 之上（`tokenize='trigram'`，中文子串检索的关键），**PostgreSQL 没有 FTS5**——PG 侧的等价物是 `tsvector` + 分词配置，属另一个工程（本批不做）。若在这里静默放行，会先炸在迁移脚本的语法上，**或更糟：启动成功但检索恒为空**。故提前拒绝并说清原因与替代方案。

判据用**方言**而非"同步/异步"（`:312-313`：*"将来若有同步的 PG 驱动，本插件同样不适用"*）；抛出的错误文案是 *"`@geewiki/search`: 当前数据库方言是 …，而本插件的全文索引依赖 SQLite 专有的 FTS5（trigram 分词器），暂不支持该方言。请改用 `@geewiki/db-sqlite`，或等待基于 tsvector 的 PG 检索实现。"*（`:314-319`）。

> **★ 一个必须说清的细节（本轮的实证发现）**：在 PG 上**实际触发拒绝的通常不是这段守卫** —— 迁移控制器排在激活**之前**（`packages/manager/src/index.ts:1162-1184` 的 5.5 步 → `:1204` 的 `ctx.plugin(...)`），所以插件往往**先死在迁移的语法错误上**（见下方"诊断体验"）。结论不变（**拒绝激活，不是静默恒空**），但排障时看到的报错来自迁移失败（`migration_failed`），而不是上面那句守卫文案。

**PG 侧若将来要实现（等价物与工作量）**：等价物是 **`tsvector` + `pg_trgm`**（`tsvector` 做词元检索、`pg_trgm` 补中文/短串的相似匹配）。但**光换检索引擎不够**：本节整套 **tier 分层可见性**（`blocks.tier` 派生列 + 等级分支 OR 授权分支 + `:grantedBlockIds` + contentless 表的应用层同步 + 一致性探针）都建立在 FTS5 的 `rowid` 与 `rank` 语义上，**必须在 PG 上重做一遍**（可能是 GIN 索引 + `ts_rank` + 不同的过滤计划）⇒ **工作量可能与 P3a 本体相当**。

**⇒ 明确列为非目标（本期不做）**：PG 部署下**没有全文检索**。块模型、逐块可见性、读路径裁剪（P3a 的非 FTS 部分）仍可在 PG 上落地，但"搜索"这一路在 PG 下**不可用**，且必须是**可诊断的拒绝**（现在的行为），不能退化成"能启动但搜不到"。
> **★★ v8 订正（这是本次修订第 2 重要的更正）：上一句里的"块模型、逐块可见性、读路径裁剪仍可在 PG 上落地"当时是**未经验证的乐观判断**，而且**是不成立的**。**
> 实情：**有三个缺陷只在真实 PostgreSQL 上暴露**，它们修掉之前，"块模型的非 FTS 部分能在 PG 上跑"这句话**是错的** ——
> 表现不是"功能缺失"，而是**写块全失败 / 新建保存 500 / 删除页面 500**。三者都由提交 **`96891db`**（前两条）与 **`e941da5`**（第三条）修掉，细节与逐条证据见下方「**★ v8：P3a 的方言成本**」。
> **★ 更重要的结论**：这三个缺陷**都不是类型系统能拦住的**（它们全是"SQL 文本与方言语义"层面的问题）⇒ **必须有真方言 e2e 兜底**（SQLite-only 的 e2e 会全绿而 PG 全废）。

**★ 诊断体验问题（非正确性问题，列为可选改进项，不阻塞任何阶段）**：迁移控制器**在插件激活之前**就会尝试执行 `packages/plugin-search/migrations/0001_search.sql`，而该脚本是 FTS5 语法（`CREATE VIRTUAL TABLE … USING fts5(…)`，`packages/plugin-search/migrations/0001_search.sql:17-21`）⇒ **在 PG 上必然失败回滚**，并在日志里留下那段 PG 语法错误堆栈。

- **实测记录（出处：编排者在容器 `geewiki-pg-test`（`postgres:15-alpine`）上把服务切到 PG 后取得；本轮修订只改文档、未亲自复现）**：
  ```
  [db-postgres] 迁移失败（已回滚）: 0001_search.sql error: syntax error at or near "VIRTUAL"
  ```
- **根因（已核实到行）**：迁移目录**按当前方言取**，先精确匹配方言键、再回退 `'default'`（`packages/manager/src/index.ts:1163-1164`、`:1168`）；而 `@geewiki/search` 的 manifest 把迁移目录声明为**裸字符串** `migrations: './migrations'`（`packages/plugin-search/src/index.ts:67`）⇒ 在 `resolveMigrationsDirs` 里归入 **`'default'` 键**（"所有方言共用"，`packages/manager/src/discovery.ts:100-108`）⇒ PG 下 `migrationsDirs['postgres'] ?? migrationsDirs['default']` **命中的正是 `'default'`** ⇒ 脚本照样被执行。
- **理想做法**：把声明改成**按方言**的形式 `migrations: { sqlite: './migrations' }` ⇒ PG 下取不到目录，走"**未声明该方言的迁移目录，跳过迁移**"分支（`packages/manager/src/index.ts:1179-1183`），日志里只剩一行告警、没有误导性的语法错误堆栈。**先例**：`@geewiki/wiki` 正是只声明 sqlite 目录的那一类（`packages/server/src/index.ts:1391` 只给了 `{ sqlite: WIKI_MIGRATIONS_DIR }`）⇒ PG 下跳过，行为干净。
- **⚠️ 由此订正本节上方的一句注释**：§4.3 的迁移示例里写着"**PG 侧不执行本文件**" —— 那是**目标行为**（控制器确实支持按方言跳过），但**当前不会自动成立**（见上一条根因）。要让这句话成真，必须先把 manifest 的迁移声明改成按方言的形式。已在该处就地标注。

**⇒ 对验收的影响**：§8.1 的 P3a 行与 §8.2 的 P3a 验收项**凡涉及 FTS / `blocks_fts` / `pages_fts` / `GET /api/search` 的，都已就地标注"仅 SQLite"**（PG 下这些项**不适用**，因为检索插件不会激活）。逐条清单见 §8.2 的 P3a 小标题下说明与 §13.5。

#### ★ v8：P3a 的方言成本 —— **三个只在真实 PostgreSQL 上暴露的缺陷**（**已修，但文档此前低估了这部分成本**）

**结论先行**：**"块模型与读路径裁剪这两部分可以两方言落地"这句话，在下面三个缺陷修掉之前是不成立的。**
三个缺陷都**不是**"PG 上少个功能"，而是**PG 上直接不可用**（写块恒为 0 条 / 新建保存 500 / 删除页面 500 且删不掉），
而且**两个方言下类型检查、单元测试、SQLite e2e 全都照样全绿** —— 它们只在**真 PostgreSQL**上暴露。

| # | 缺陷（现象） | 根因（逐条已验证到行） | 修法 | 订正提交 |
|---|---|---|---|---|
| 1 | **每次写块都失败，`blocks` 恒为 0 条** | 写块时靠**捕获异常**判断"`blocks_fts` 不存在"，而只匹配 SQLite 的文案 `no such table:`，PG 的文案是 **`relation "blocks_fts" does not exist`** ⇒ 异常没被识别、**每次写块都抛** | **事务外按方言判定**（不能"捕获后继续"：**PG 的事务在任一语句报错后即进入 aborted 状态**，后续语句一律失败）⇒ 必须在进事务**之前**得出布尔值 | `96891db` |
| 2 | **新建 / 保存页面 500**：PG 报 `insert or update on table "blocks" violates foreign key constraint "blocks_page_id_fkey"` / `Key (page_id)=(0) is not present in table "pages"` | `INSERT INTO blocks` **缺 `RETURNING id`** ⇒ PG 驱动拿不到新 id（退化为 `0`）⇒ 依赖块 id 的后续写入全部以 `page_id = 0` 落地 | SQL 里加 **`RETURNING id`**，并对拿不到 id 的情况**响亮失败**（`blocks_writer_no_rowid`） | `96891db` |
| 3 | **PostgreSQL 上删除任何页面返回 500，且页面删不掉** | `deletePage` 里的 **`DELETE FROM blocks_fts ...` 没有方言守卫** ⇒ PG 上必然抛 `relation "blocks_fts" does not exist` ⇒ **PG 事务报错即整体回滚** ⇒ 删除失败 | 与其它 `blocks_fts` 语句一样，**每一处**都加方言守卫（用同一个方言判定结果） | `e941da5` |

**★ 缺陷 3 为什么长期没被发现（必须记住这条方法论教训）**：e2e 的**阶段 G/H/I/K 靠直读 SQLite 文件**核对 `tier`（`packages/plugin-wiki/test/e2e-p3a.sh:79` 的 `node_db()`），因此**在 PG 下整体跳过**（跳过点：`:319` G、`:342` H、`:369` I、`:397` K；文件头 `:293` 就写着 *"G/H/I/K 都靠直读 SQLite 文件核对 tier ⇒ 在 PG 下整体跳过"*）⇒ **`deletePage` 在 PG 上从来没有被端到端跑到过**。
**修法与补测**：新增**方言中立**的 e2e **阶段 L**（`:292`：*"阶段 L：扇出在两种方言下都要跑通（纯 HTTP 断言，不读 SQLite 文件）"*），其中 **L8** 覆盖删除路径、**L9** 断言 `tier_mismatched=0`（`:310` / `:313`）；该阶段由提交 `dee82cd` 补入。

> **★ 结论性提示（建议直接引用这句话）**：
> *"块模型的 PG 可用性依赖 `RETURNING id`、索引表存在的方言判定、以及每一处 `blocks_fts` 语句的方言守卫 —— **这三点都不由类型系统保证，必须有真方言 e2e 兜底**。"*
>
> **★ 由此派生的两条要求（写进后续任何阶段的验收）**：
> 1. **凡新增一处 `blocks_fts` 语句，都要问一句"它在 PG 上会不会被执行"** —— 守卫是**逐处**的，不是全局的；
> 2. **凡新增一个"靠直读 SQLite 文件断言"的 e2e 阶段，都要同时给出方言中立（纯 HTTP）的替代断言**，否则该阶段在 PG 下被整体跳过时，**不会有任何信号告诉你它没跑**（这正是缺陷 3 藏了整整一个阶段的原因）。

#### ★ v4：第三档 `granted` 无法用 `tier` 表达 —— 检索改形

`blocks.tier` 的原取值域是 `0=anon, 1=org, 2=private(编辑者)`。v4 把第三档换成 `granted`（"**默认谁都不能看，靠 `block_grants` 放人**"，§2.2）之后，它**不再是"读者等级"，而是逐块的 ACL** —— 处在同一个"读者等级"的人里，只有**被显式授权的那几个人**能看。**等级数字表达不了"具体是谁"**，所以 `tier` 无法承载这一档。

| 档 | `blocks.tier` | 检索时怎么命中 |
|---|---|---|
| `public` | `0` | 等级分支 `b.tier <= :readerTier`（anon 也命中） |
| `org` | `1` | 等级分支 `b.tier <= :readerTier`（member 命中、anon 不命中） |
| `granted` | **`NULL`** | **只能靠授权分支** `b.id IN (:grantedBlockIds)` |

**★ 明确选择：`granted` 档写 `NULL`（不用哨兵数字）。理由按重要性排序：**

1. **取值域保持干净**：`tier` 的域严格是 `{0, 1}`，"读者等级"这个概念里不再塞进一个假档位。用哨兵（如 `9`/`99`）会让人以为它是"更高级别"，迟早有人写出 `tier <= 99` 这种把私有块放给所有人的查询。
2. **`NULL <= ?` 恒不为真 ⇒ 失败关闭**：在等级分支里 `NULL` 的比较结果是 `NULL`，`WHERE` 视为不成立 ⇒ **`granted` 档的块永远不会被等级分支命中**，**只能**由显式的授权分支放进来。方向上是对的：这里写错代码的后果是"**搜不到**"，不是"**泄漏**"。
3. **与本节那条 NULL 实测坑不是一回事（必须区分，别混）**：实测结论里的坑说的是 **contentless FTS 表上的 `UNINDEXED` 列**（把 `tier` 写在 FTS 表上）不可读、恒为 `NULL` ⇒ 谓词恒不成立**且不报错**。而这里的 `tier` 是 **`blocks` 表上的普通列**，`NULL` 是我们**主动写入并刻意使用**的语义（"不属于任何读者等级"），可读、可判、能用 `IS NULL` 精确查询。**两者只是都出现 `NULL` 这个词，机制完全不同。**
4. **代价（诚实列出）**：原来的 `INTEGER NOT NULL DEFAULT 0` 有一个好处 —— 任何"忘记算 tier"的写入会**响亮地失败**。改成可为 `NULL` 之后，"忘记算 tier" = 该块**静默地搜不到**（仍然是失败关闭方向，不会泄漏），因此**必须配一条一致性探针**（纳入既有 verify 端点）：
   ```sql
   SELECT COUNT(*) FROM blocks WHERE tier IS NULL;                  -- 必须等于 ↓
   SELECT COUNT(*) FROM blocks WHERE visibility = 'granted';
   ```
   两个数不相等 ⇒ 有块被漏算，`GET /api/admin/search/verify` 报警（与 §3.6 的 `content_hash` 探针、§4.3 的 blocks/blocks_fts 探针同一风格：**把静默错误变成显式告警**）。
   > **顺带把默认值也改成"失败关闭"**：`DEFAULT 0` 意味着"忘了算 tier"的块会**以匿名等级进入索引**（若它其实是 `org`/`granted`，那就是**泄漏**）。v4 因此把该列的默认值改为**无默认（`NULL`）** —— 已在 §3.6 的 DDL 注释里写明理由。

**`:grantedBlockIds` 从哪来（★ 必须写清，避免第二真源）**：由 `policy-service` 提供 —— "**该主体在本次检索范围内（同一组 slug / 同一页）被显式授予的块 id 集合**"，通常很小。授权段落的**判定**仍然只走 §2.4 那个单点函数，**不允许**在 SQL 里另写一套授权判定逻辑。

**这条改动的代价与前提（实现前需按真实规模复核）**

1. **每次检索前要先查一次授权块集合**：`SELECT block_id FROM block_grants WHERE (subject_kind='user' AND subject_id=?) OR (subject_kind='group' AND subject_id IN (...))`。
   **★ 前置依赖（本次自检发现的缺口，已补）**：`block_grants` **原本没有** `(subject_kind, subject_id)` 索引（§3.7 原先只有 `(block_id, subject_kind, subject_id)` 唯一索引与 `(page_slug)`）—— 这条查询会退化成全表扫。**v4 已在 §3.7 补上 `idx_block_grants_subject`**，与页面级既有的 `idx_page_grants_subject` 对齐。
2. **`IN` 列表会随"该主体被授权的块数"增长**：若某主体被授予的块极多（例如把某个组授予了几千个块、或一个成员被逐块授权），`IN` 列表会很长 —— **这是已知的可扩展性边界，实现前需按真实规模复核**。等价改法（**不改语义**）：把授权分支换成 `EXISTS (SELECT 1 FROM block_grants g WHERE g.block_id = b.id AND (...))`，让数据库用索引逐行判定，避免构造大 `IN` 列表。
3. **召回不损失（这正是采纳它的理由）**：授权段落**仍然搜得到** —— 被授权的用户能搜到自己被授权的块，不会像"只索引匿名层"（v1 D5）那样出现"我记得文档里有这句话，但搜不出来"。**这与用户已拍板的 D10 精神一致**（索引越全，登录用户召回越好；安全性由过滤保证）。
4. **与本节实测结论不冲突（已确认）**：那条结论是"**tier 过滤必须放在 JOIN 后的 `blocks` 表上，不能写进 FTS 表**"。v4 只是在同一个 `WHERE` 里**多加一个 `OR` 分支** —— 过滤条件依然**全部落在 `blocks`（普通表）上**，FTS 表仍然是纯 contentless 索引。机制不变，**不冲突**。

#### 触发器 / 重建策略（**必须放在 `@geewiki/search` 的迁移里**）

```sql
-- 3) 先摘掉旧的 pages 触发器，再建块级触发器
--    ★ 旧触发器必须显式 DROP：否则 pages 的每次 UPDATE 仍会去写老的 pages_fts（既浪费又漂移）
DROP TRIGGER IF EXISTS pages_fts_ai;
DROP TRIGGER IF EXISTS pages_fts_ad;
DROP TRIGGER IF EXISTS pages_fts_au;

-- ★ 为什么不给 blocks 建触发器：
--   blocks_fts 是 contentless 表，与 blocks 的同步涉及"tier 重算"这一业务逻辑
--   （不是纯 SQL 能表达的），因此**由应用层在同一事务内维护**。
--   这是与 0001 的关键差异，必须在迁移注释里写明，否则后人会以为"忘了建触发器"。

-- 4) 保留老表作为回滚锚点（PG 侧不执行本文件——FTS5 是 SQLite 专有，
--    与 0001_search.sql 的能力守卫同源，见 packages/plugin-search/src/index.ts 的 dialect 拒绝）
-- ★ v7 订正：「PG 侧不执行本文件」是**目标行为**、但**当前不会自动成立**：
--    @geewiki/search 用裸字符串声明迁移目录（migrations: './migrations'）⇒ 归入 'default' 键
--    ⇒ PG 下照样执行，必然以 syntax error at or near "VIRTUAL" 失败回滚。
--    修法（可选、不阻塞）：改成 migrations: { sqlite: './migrations' }。详见本节「★ v7：方言语义」。
-- ALTER TABLE pages_fts RENAME TO pages_fts_legacy;   -- 仅当需要回滚时执行
```

**重建与一致性校验**（沿用 `0001_search.sql` 的既有先例 `INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')`）：

- `pages_fts` 是 external-content（`content='pages'`）表，**`rebuild` 命令可用**；`blocks_fts` 是 contentless 表，**`rebuild` 语义不同** —— 所以块级重建由**应用层在事务内**做：`DELETE FROM blocks_fts WHERE rowid IN (该页所有块 id)` → 逐块 `INSERT`。
- **一致性探针（新增端点）**：`GET /api/admin/search/verify` → 比对 `blocks` 与 `blocks_fts` 的行数差与抽样命中数。**这是 P3a 的强制验收项**（因为它替代了触发器的自动同步保证）。

#### tier 方案相对 v1 的 D5 取舍：代价消除与新增代价

| | v1 D5（索引原文 + 检索时过滤） | v2 tier 方案（contentless + tier 过滤） |
|---|---|---|
| 匿名泄漏 | 安全（有过滤） | 安全（**实测**） |
| 登录用户召回 | **受损**（"搜不到受限片段"） | ✅ **无损失**（member 能搜到 org 块；★ v4 起**被授权者也能搜到 `granted` 块**，靠授权分支） |
| 索引体积 | 1× | **1×**（contentless 不存正文；实测 tiny 语料下 `dbstat` 显示 16KB 全是页开销，**真实倍数需在你自己的语料上量**：`SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'blocks_fts%'` 对比 `SELECT SUM(length(text)) FROM blocks`。既有的 `0001_search.sql` 注释给出参照："5000 行 / 6.6MB 语料增约 7.9MB" ⇒ trigram 索引约 1.2× 语料） |
| 新增要求 | 无 | **SQLite ≥ 3.43**（`contentless_delete=1`）→ 必须写进 `packages/db-sqlite/package.json` 的 `better-sqlite3` 版本下限，并加一条启动自检（`sqlite_version()` 解析），否则**老版本会静默建表失败或行为异常** |
| 新增要求 | 无 | **`snippet()` 不可用**（★ v8 订正：**实测是返回 `null` 且不报错 —— 静默失败**；若用了它又没防护，**高亮会静默变空**，而"不专门断言高亮内容"的测试**发现不了**。⇒ 高亮必须自实现，或从 `blocks.text` 取原文后自行标记。本项目的落地见 `packages/plugin-search/src/index.ts:386`、`:1131`，断言见 `packages/plugin-wiki/test/e2e-p3a.sh:213` 的 C6） |

**结论：采纳 tier 方案**（它同时达成 v1 D5 的安全目标并消除召回损失，代价是两条已实测的工程约束）。**若索引体积实测不可接受**，退路是只索引 `tier=0`（匿名）行 —— 即回到 v1 D5 的取舍，但**列为运维开关**（配置项），**不是默认**。
> **★ v5（D10）在此定稿**：**默认形态 = 全密级收录（`tier ≤ 1`）**；"只索引匿名层（`tier = 0`）"是**非默认的运维开关**，只有在**自有语料上实测索引体积不可接受**时才考虑打开（测量方法见上表）。**不要**把它当成初始配置，也不要在打开它之后仍宣称"登录用户无召回损失"。
> **★ v4 注**：上表的"无损失"在 v4 之后依赖**两个分支**（等级分支 + 授权分支，见本节上方）。**若将来真把索引收窄成"只索引 `tier=0` 行"**，那么 `org` 块与 `granted` 块**都不在索引里**，授权分支也救不回召回 —— 也就是说，**这个运维开关与"授权段落可搜"是互斥的**，届时要一起重新评估（不要在开启该开关后仍宣称"授权段落搜得到"）。

### 4.4 版本与恢复语义

**这是"每块独立版本"的落点，也是最容易做错的地方。**

```text
restoreVersion(slug, versionId, principal):
  1. 要求 page.canEdit(slug)
  2. ★ 要求 principal 对版本内每个块都有 ≥ 该版本声明的 visibility
        （否则 403，details.blockedOrdinals 列出违规块的 ordinal）
  3. 单事务：
       a. DELETE FROM blocks WHERE page_id = ?
       b. 按 blocks_json 重建 blocks（**沿用快照里的 visibility/inherit**）
       c. UPDATE pages SET content = ?, content_hash = ?, updated_at = ?,
                          visibility = ?, published_at = ?, inherit = ?   -- ← 来自 acl_json
       d. INSERT INTO page_versions(...) 快照"恢复前"的状态（可再恢复回来）
       e. acl_revision++  → blocks_fts 重建该页行
          -- ★ v8 订正：这里的箭头**不是因果链**。`acl_revision++` 只是留痕（无读取方）；
          --   `blocks_fts` 的重建由**应用层显式调用**触发，且必须在事务**提交之后**（§4.6）
  4. 返回新版本 id 与 outcome
```

**★ 新增硬规则（v1 没有，块级模型下必须）**：**任何 `visibility` / `published_at` / `inherit` / `block.visibility` / grant 的变更，都必须产生一条新的 `page_versions`**（`content` 不变、`blocks_json` 与 `acl_json` 变化）。

理由：既然版本快照含权限，那么"改权限不产生版本"会让版本历史里的权限快照与实际权限脱节，"恢复此版本"就会恢复出**错误的权限**（可能是放宽）。

代价：版本表增长变快。**★ v3（D11）：不做保留策略 —— 权限版本与正文版本一样永久保留**（用户决定三；代价与缓解方向见 §10.4 D11 与 §9 R16）。

**老版本（`blocks_json IS NULL`）的恢复语义**：**只恢复 `content`**（Markdown → 重新解析出块），**不恢复任何块级权限**（因为快照里没有），并在响应里带 `warnings: ['block_acls_not_restored']` + 前端显式提示"该版本早于块级权限功能，块级权限未恢复"。**绝不猜测**老版本的权限。

**大小上限**：`blocks_json` 超 1MB 的版本恢复 ⇒ 413（沿用 `packages/plugin-wiki/src/index.ts:296-324` 的消息前缀错误码机制）。

**★ v3：下面这一条已消解（D11 改为永久保留）。** 「区分正文版本与权限版本」的标记列（`kind: 'content' | 'acl'`）**不再需要** —— 该列当初的**唯一目的**就是给"只清理权限版本"的保留策略做区分，现在不清理了，因而不必加。**原文保留在下面作为留痕**：

> **（v2 原文，已消解）一条需要实现时补的字段**（原文如此，实现前需复核）：D11 要区分"正文版本"与"权限版本"才能只清理后者，而 v2 只给了 `blocks_json` / `acl_json` 两列，**没有给出区分两者的标记列**。实现 P3c 时需要补一个（例如 `kind: 'content' | 'acl'`），或按"`content` 与上一版本相同"来判定。

> **注意（勿反向误读）**：消解的是"**区分用途**"，不是"区分能力"。`blocks_json IS NULL` 的既有语义仍然是"**该版本早于块级功能**"（§4.4 老版本恢复语义），**不能**被复用来表示"这是权限版本" —— 将来若真要给版本分类，必须另加字段或另定判据（见 §9 R16 的缓解方向）。

### 4.5 AI RAG 的新契约

```ts
contents(
  slugs: readonly string[],
  principal?: Principal,          // 省略 = 匿名（失败关闭）
): ReadonlyMap<string, ContentView>

interface ContentView {
  text: string                    // 该主体可见块的拼接文本（块间 '\n\n'）
  blocks: readonly { ordinal: number; kind: string; text: string }[]  // 供 sources 帧与引用定位
  gatedCount: number              // 被裁剪掉的块数（**不含内容**，仅计数）
  maxVisibleTier: number          // ★ v4：可见块里 `tier` 的最大值（域 {0,1}）—— 它**不反映** `granted` 档的可见块
                                  //   （那些块 tier 为 NULL）。因此它只是**诊断用**指标，判定一律走 policy-service。
}
```

**`principal` 必须是可选参数** —— 理由与影响面（已 grep 确认）：

| 位置 | 影响 |
|---|---|
| `packages/plugin-search/src/index.ts:127`（接口）、`:460-472`（实现） | 加可选参；**省略 ⇒ 按匿名投影**（失败关闭，历史行为对公开页完全一致） |
| `packages/plugin-ai/src/index.ts:438` | **唯一的生产调用点**，加 principal；同时改用新的返回结构 |
| `packages/plugin-search/test/search.test.ts:610,612,616,621,629,632,649,655,684` | **9 处调用**。全部传的是公开页（行为不变）⇒ **测试无需改动**，这正是"可选参数"的价值 |
| `docs/architecture.md`、`docs/plugin-platform.md` | 契约文档需同步（**必改**，否则文档与实现漂移）。原表引用的 `docs/plugin-platform-plan.md` 已在本轮文档重整中合并进 `docs/plugin-platform.md` |

**四条硬约束**

1. **`sources` 帧与答案同源**：`packages/plugin-ai/src/index.ts:438` 现在一次性调 `search.contents(...)`，`selectSources()`（`packages/plugin-ai/src/select.ts:41`）再截断。改后**必须复用同一次 `contents()` 调用的返回对象**派生 `sources`（`blocks[].ordinal` 直接作为引用定位）—— **不得二次查询**，否则会出现"答案提到、sources 里没有"或反之。
2. **★ 分块（chunking）必须块对齐，绝不跨块合并可见性不同的内容**：`selectSources()` 的 `perSourceChars` 截断（`packages/plugin-ai/src/select.ts:44`，既有约定"放不下就整条丢弃，绝不做尾部裁切"）在块级下要改为：**按块累积**，遇到 `tier` 变化的边界即分新 chunk。原因：若把 public 块与 org 块拼成一个 chunk 再截断，匿名上下文里可能残留 org 文本 —— **这是块级模型下新的泄漏面**。
3. **`gatedCount` 的正确用法**：它是"**存在但你看不到**"的唯一合法信号。`packages/plugin-ai/src/select.ts` 可据此产生一句**高层提示**："该问题的答案可能位于 3 个需要更高权限的内容块中。" —— **对权限不足的主体，只说"需要更高权限"，绝不透露块的内容、标题或计数以外的任何信息**；对匿名主体，`gatedCount > 0` **也不得出现**（否则等于确认存在受限内容），此时退化为"未在知识库中找到"。
4. **`SearchHit` 增 `blocks` 字段**（块级命中定位）：`packages/plugin-search/src/index.ts:83-98` 的 `SearchHit { slug, title, content, ... }` 中 `content` 必须**删除**（它就是泄漏源），改为 `blocks: { ordinal, kind, text }[]` + `gatedCount`。**这是一处破坏性契约变更**：需 grep 全部消费方（`packages/web/src/lib/searchPlan.ts`、`packages/web/src/components/SearchView.tsx`、`packages/plugin-ai`）。


> **修正（本批，2026-09-14）——AI 拆分为 `@geewiki/ai-assist` + `@geewiki/ai-qa` 后，本节的路径与一处契约形状需更正**（决策本身不变，改的是落点与一处更严的签名）。
>
> **① 上表的路径全部失效，按此更正**：`packages/plugin-ai/src/index.ts:438`（"唯一的生产调用点"）→ **`packages/plugin-ai-qa/src/index.ts:431`（召回）与 `:438-441`（取正文）**；`packages/plugin-ai/src/select.ts:41` / `:44` → **`packages/plugin-ai-qa/src/select.ts:79`（`selectSources()`）与 `:58`（`accumulateBlocks()`）**；`docs/plugin-platform.md` 那一行也已改写（原 `plugin-platform-plan.md` 的批次流水见 git 历史）。
>
> **⚠️ 后续演进（本块现为历史留痕）**：`@geewiki/ai-qa` 整包与 `plugin-ai-qa/**` 全部路径
> 已于 P8 删除（决策 22），故上面给出的落点**现在也已失效**，只作决策留痕；
> 当前 AI 侧由 `@geewiki/ai-assistant` 承担（见 [ai-plugin-architecture.md](./ai-plugin-architecture.md)）。
>
> **② `contents()` 的 `principal` 不是"可选参数"——本节的这条裁决被实现推翻，且是往更严的方向推翻。** 现签名 **`contents(principal: Principal, slugs: readonly string[]): Promise<ReadonlyMap<string, ContentView>>`**（`packages/plugin-search/src/index.ts:223`），`search` 同样以主体为首参（`:191`）。理由与本节自己的泄漏逻辑一致：**可选参数会把"忘传主体"变成一个静默的、只表现为"少给内容"的 bug**（可发现但难归因），而必填 + 运行期守卫**抛错而不是"当作匿名"**（`~:226-231` 的注释原话："当作匿名会静默少给内容（可发现），而'不过滤'会静默多给（不可发现且是安全事故）"）把这一类缺陷变成编译期报错 + 响亮失败。上表"省略 ⇒ 按匿名投影（失败关闭）"那一行因此作废：**没有"省略"这条路径了**。
>
> **③ `ContentView` 的形状已按本节落地**（`packages/plugin-search/src/index.ts:162-175`：`text` / `blocks` / `gatedCount` / `maxVisibleTier`，且注释明写 `maxVisibleTier` **仅诊断用**、判定一律走 `policy-service`）；约束 4 也已落地——**`SearchHit.content` 已删除**，改为 `blocks: readonly SearchBlockRef[]` + `gatedCount`（`:92-111`），且 `gatedCount` **对匿名主体恒为 0**（`:558` 附近：非 0 等于向匿名确认"这里存在你看不到的内容"，属存在性泄漏）。
>
> **④ 约束 2（分块必须块对齐）已落地**：`accumulateBlocks()`（`packages/plugin-ai-qa/src/select.ts:58-70`）**按整块累加、遇到预算不够就停**，绝不从块中间截断，因此"public 块与 org 块拼成一个 chunk 再截断"这条新泄漏面在结构上不成立。**唯一残余**：当**单块自身**就超预算时取该块前缀（`select.ts:68-69`）——切的是**同一块内部**，不跨可见性边界，故与本节约束不冲突，但值得记档。
>
> **⑤ 约束 1（`sources` 与答案同源）已落地**：问答只调一次 `contents()`，`sources` 与进上下文的文本都从**同一返回对象**派生（`selectFrom()` 走 `RetrievalStage` 的同一份 `contents`），无二次查询。
>
> **⑥ 约束 3（`gatedCount` 的合法用法）**：**信号已就位、下游尚未消费**。`selectSources()` 会汇总出 `Selection.gatedTotal`（`select.ts:42` 声明其语义、`:98` 累加），但**问答响应体与界面目前都不读它**——"答案可能位于 N 个需要更高权限的内容块中"这句高层提示**尚未接线**。已核实的部分是"不许泄漏"这一半（匿名一律 0，故不会出现存在性泄漏）；未落地的部分是"可以提示"这一半。⚠️ 登记为**待办**，不要当成已完成。
>
> **⑦ 新增一条本节的兄弟红线：辅助写作（`@geewiki/ai-assist`）根本不读正文，因此没有"RAG 泄漏面"可堵。** 它的上下文**只来自请求体**（前端从编辑器缓冲区取出的 `selection` / `before`，`packages/plugin-ai-assist/src/assist.ts` 文件头的硬规则 1），服务端**不查 `search-service`、不读 `pages` / `blocks`**——受限块"进入模型上下文"这件事在**代码路径层面**就不成立，比"记得按主体过滤"强一档（过滤会漏，路径不存在不会漏）。**`slug` 只用于一次编辑权限判定**：唯一消费点是 `assist.ts:233` 的 `deps.resolveEditAccess(principal, slug)`，接线在 `packages/plugin-ai-assist/src/index.ts:247-254`——`ctx.get('policy-service')` 取不到即 `return null`，经 `pageEditableFrom(null)` 判假 ⇒ **失败关闭 403**（`@geewiki/authz` 被卸载也放行不了）。判定顺序钉死为 **解析(400) → 有编辑能力(403) → 该页可编辑(403) → 降级投影(503) → 生成**；**权限在降级之前**是刻意的：否则"没配密钥"会退化成一条权限探测通道（无编辑权者能从响应差异里分辨"这个 slug 存不存在 / 我能不能问"）。**两处对设计契约的有意偏离**：(a) 匿名与"已登录但无编辑权"给**同一个 403**，不分 401——区分两者等于把响应变成"你是否已登录"的探测口，代价是契约里写的 401 在真实链路上不会出现；(b) 输入超长是 **400 `payload_too_large`**（`ASSIST_TEXT_MAX = 4000`，`assist.ts:46`、检查 `:153`、消息 `:158`），不是 413。**守卫是源码级的**（`packages/plugin-ai-assist/test/assist.test.ts`）：『守卫：assist.ts 不得出现任何"取正文/检索"的调用点』在剥掉注释与字符串的源码里禁止 `search-service` / `wiki-service` / `contents(` / `retrieve(` / `getPage(` / `readPage(` / `loadPage(` / `pageContent` / `FROM pages` / `page_versions` / `blocks_fts`，并反向自证 `resolveEditAccess` 与 `canEdit` 确实在场（防"整段被删空也算通过"）；第二条守卫用白名单正则约束**每一行出现 `slug` 的代码**，并断言 `resolveEditAccess(principal, slug)` 是 `slug` 的唯一消费点。**验收边界（别误读）**：`data/verify/ai-split-e2e/` 用的是 owner 会话，**不覆盖这条 403 线**（脚本注释明文：少了 `authz` 会按设计失败关闭 403，但那不是它要测的东西）——这条红线目前由上述两条源级守卫 + 行为用例守，**尚无 HTTP 层端到端用例**。


### 4.6 ★ v8 新增：跨阶段不变量 —— 写了 `pages` 的档位，就要补齐子孙 `tier`

> **这一节为什么存在**：它与 §4.3 的 tier 方案是**同一件事的两半**，但**它是"跨阶段"的** ——
> 每个阶段（P3a / P3b / P3c / P4）各自看自己那一段时**都看不出问题**，缺陷**只存在于交界处**。
> 实情是：**这条不变量在实现中失效过三次，三次都由审查端到端复现**。所以它被提成一条**独立的、显著的不变量**，而不是留在 §9 R13 里当一条"风险提示"。

**不变量（一句话，可直接抄进任何后续阶段的验收）**：

> **`blocks.tier` 是物化派生列。凡写了 `pages.visibility` / `inherit` / `published_at` 的代码路径，
> 都必须在该事务提交之后，调用子孙 `tier` 重算（"扇出"）。新增一条写档位的路径，就应触发"补扇出"这个动作。**

**★ 为什么"新增一条写档位的路径就应触发补扇出"，是本条最需要记住的一句**：
漏扇出的后果**不是**"索引陈旧"这种可用性问题，而是 **`blocks.tier` 比实际档位更宽** ⇒
**读路径 404、检索却命中并吐出正文片段**（内容泄漏）。失效方向上恰好落在"**少限制**"那一侧，**不是失败关闭**。

#### 失效过的三次（三次都由审查端到端复现，不是推测）

| # | 路径 | 场景（审查的复现） | 订正提交 |
|---|---|---|---|
| 1 | **P3a `savePage` 的 create 分支**（新建祖先） | 建 `a/b`（public + published）⇒ 匿名读 200、搜 `total=1`；再 `PUT /api/pages/a`（默认 org）⇒ 匿名读 `a/b` **404**，但匿名 `/api/search` 仍 **`total:1`，响应体里出现唯一词 `CHILDUNIQ777`**；同刻 `blocks/verify` 报 `tier_mismatched:1` | `a3d72b7` |
| 2 | **P3a `deletePage`**（删掉 `inherit = 0` 的断链点） | `a` = private、`a/b` = public + published + **`inherit=false`**（断链点）、`a/b/c` = public + published ⇒ 匿名读 `c` 200 且搜得到；`DELETE /api/pages/a%2Fb` 后 ⇒ 匿名读 404，但匿名搜**仍吐 `DEEPUNIQ999`** | `a3d72b7` |
| 3 | **P3c 新增的版本恢复路径** | 恢复版本会写回 `pages.visibility` / `published_at` / `inherit`，但未补扇出 ⇒ 同样的"读 404、搜命中" | `9699aa7`（提交信息：*"否则读路径 404 而检索仍吐正文"*；并注明*"是 P3c 实现时就漏的，非 rebase 所致"*） |

**★ 第 2 条的根因（`continue` / `break` 的不对称，是刻意的，不要去改它）**：
`packages/plugin-authz/src/index.ts:274-287` 的 `effectiveRank`——`ancestorsOf` **由近及远**；
对**缺失**祖先 `continue`（不构成收紧）、对 `inherit !== 1` 才 `break`（断链）。
**删掉断链点后，更上层更严的祖先重新开始压制**（rank 0 → 2），而 `blocks.tier` 仍为 `0` ⇒ 错位。
**⇒ 只能补"档位变了要重算 tier"，不能去动那个不对称。**

#### 为什么扇出必须在**事务提交之后**（这是本节的第二个关键结论）

`pageLevelOf`（`packages/plugin-wiki/src/index.ts:646`，经 `:659` 委派给策略层的 `effectiveIndexLevel`）
走**策略层**，而策略层用的是**另一条数据库连接**读 `pages`。
**PostgreSQL 的 MVCC 下，另一条连接看不到本事务未提交的行** ⇒

- 放进同一个事务**不会死锁**，但会**读到旧值** ⇒ **等于没修**（这是最危险的一种"看起来修了"）；
- 因此实现把扇出放在**提交之后**（自己再开一个事务）。源码原话：*"⚠️ 必须在调用方的事务提交之后跑：`pageLevelOf` 走策略层（另一条连接），PG 下看不到未提交的祖先改动，在事务内算会拿到旧祖先值 —— 那正是本函数要修的东西。故它自己开一个事务。"*

**⇒ 由此得出的必然推论：扇出会失败，而失败必须是一等可观测信号。**
提交后执行的代价是"**提交成功但扇出失败**"这个窗口客观存在（**且失败方向上就是永久泄漏**，因为它不会自愈），
所以实现把失败**升级为可观测信号**，而不是 `console.warn` 了事：

| 信号 | 落点 | 作用 |
|---|---|---|
| `ResyncReport`（`packages/plugin-wiki/src/index.ts:185`：`{ resynced: number; failed: boolean; error?: string }`） | 扇出函数的返回类型（类型在 `:185`，挂在 `WikiSaveResult.indexTiersResync`，`:201`） | 让调用方拿到结构化的结果 |
| 审计动作 **`acl.resync_failed`** | 写入于 `packages/plugin-wiki/src/index.ts:1921`；已白名单进审计的 `acl` 视图（`packages/plugin-authz/src/index.ts:699`） | 失败留痕、可告警 |
| 响应字段 **`index_tiers_resync_failed`** / `index_tiers_resync_error`，与 `index_tiers_resynced` 并列 | `packages/plugin-wiki/src/index.ts:1588-1591`（版本恢复）、`:1681-1685`（`PUT` 保存）、`:2106-2110`（改可见性） | **让"重算了 0 个子孙"与"扇出整个失败"可区分** |

> **★ 为什么"可区分"是必需的**：`index_tiers_resynced: 0` 有**两种完全不同的含义** ——
> ① 该页本来就没有子孙（正常）；② 扇出整个失败了（异常）。
> 没有 `index_tiers_resync_failed` 时**这两者不可区分**，于是"永久泄漏"会被读成"没事"。

**扇出的四个调用点（实现，全部在提交之后）**：

| 调用点 | 位置 | 对应上文哪次失效 |
|---|---|---|
| `savePage` 的 **create 分支**（仅 `outcome === 'created'`） | `packages/plugin-wiki/src/index.ts:1131`（`savePage` 定义在 `:1015`） | 失效 #1 |
| `deletePage`（`if (deleted)`） | `packages/plugin-wiki/src/index.ts:1201`（`deletePage` 定义在 `:1170`） | 失效 #2 |
| **版本恢复** `POST /api/pages/:slug/versions/:id/restore` | `packages/plugin-wiki/src/index.ts:1571`（路由注册于 `:1347`） | 失效 #3 |
| **改可见性** `PUT /api/pages/:slug/visibility` | `packages/plugin-wiki/src/index.ts:2086`（路由注册于 `:1975`） | 这一条本来就有（e2e 阶段 G 一直测的就是它） |

- 扇出本体：`resyncDescendantTiers`（`packages/plugin-wiki/src/index.ts:1883`）与带报告的包装 `resyncDescendantsReporting`（`:1909`）—— **两者都是 `apply()` 内部的闭包，未导出**；**对外导出的类型是 `ResyncReport`**。定位请以这三个名字为准。
- **兜底修复入口**：`POST /api/admin/blocks/resync`（注册于 `packages/plugin-wiki/src/index.ts:3176`，实现定义在 `:3218`）—— **探针只负责报警，这个端点负责把它重算回去**（提交 `2b5f13d`：*"让『可重算』从承诺变成事实"*）。

#### ★ 这条不变量的验证方式（**必须能覆盖四条路径，只测一条会假绿**）

- **必须覆盖**：① 改档位（原有）、② 新建祖先、③ 删除断链点（`inherit=false`）、④ 版本恢复。
- **★ 实证教训**：e2e 阶段 G **只测了"改档位"**一条 ⇒ **它绿着而泄漏仍在**（这正是前两次失效长期未被发现的原因）。
- **★ 实证证据（红-绿自检，最硬的一种）**：临时禁用两处扇出 ⇒ e2e 的 `K5/K6/K14/K15` 全红，其中 `K6` 报响应体里出现 `KKK777LEAK`、`K15` 报 `DDD999LEAK`（通过 71 / 失败 4）；恢复后全绿。**⇒ 断言确实有判别力，不是"看起来在测"。**
- **方言中立要求**：阶段 L 用**纯 HTTP 断言**（不读 SQLite 文件），因此**在 PG 下也照样跑** —— 见 §4.3 的「★ v8：P3a 的方言成本」里缺陷 3 的教训（靠直读 SQLite 文件断言的阶段在 PG 下会**整体跳过**，且**不会有任何信号告诉你它没跑**）。

---

## 5. 泄漏面封堵清单

> **判定**：任何"能返回受限信息"的路径都必须先经 `policy-service`。**"先取全量再后过滤"是本项目的头号反模式** —— `total_count` / 高亮 / 分页语义会全部泄漏。
> 下表 5.1–5.12 中，标 **（v2 修订）** 的以 v2 为准。

### 5.1 条目列表
`packages/plugin-wiki/src/index.ts:601-604`（端点）→ `listPages()` `:388-400`（SQL 在 `:391-393`，**全表无 WHERE**）
**改法**：`listPages(principal)` → 先 `visibleSlugs(principal, { levels:['full','summary'] })`，SQL 加 `WHERE slug IN (...)`，并按 `level` 决定返回 `title` 还是 `title + gated` 标记；`content` 已裁掉是好事，但 `title` 本身对 `none` 级不可返回。

### 5.2 条目详情
`packages/plugin-wiki/src/index.ts:608-617` → `getPage()` `:403-425`（**全字段含 content + versions[]**）
**改法**：`getPage(slug, principal)` → `resolvePage()`；`level='none'` 返回 `undefined`（端点 404），`level='summary'` 走 `access.project()` 把 `content` 换成占位投影，`versions` 数组整体省略。

### 5.3 版本历史（**v2 修订：块级下更严**）
`packages/plugin-wiki/src/index.ts:621-639`（`GET /api/pages/:slug/versions/:id`，当前 `SELECT id, content, saved_at FROM page_versions`）
**改法**：① 判父条目 `canEdit`；② 返回值新增 `blocks` 与 `acl` 字段（来自 `blocks_json` / `acl_json`）；③ **`content` 仍返回原文**（编辑者看历史必须是原文，否则无法编辑/比较），但**非 `canEdit` 主体一律 404** —— 历史**不对普通读者开放**。
> 为什么不再用 v1 的"投影历史"方案：块级下历史里含 `blocks_json` 权限信息，**投影它等于泄漏 ACL 结构**。

### 5.4 反链（泄露标题）
`packages/plugin-wiki/src/index.ts:702-710`（backlinks）→ 返回引用方的 `title`
**改法**：反链结果按 `resolvePages(principal, sourceSlugs)` 过滤；`none` 级的引用方**整条不出现**（不是"标题打码"）。

### 5.5 出链（**v2 修订：新增字段**）
`packages/plugin-wiki/src/index.ts:714-722`（links）
**改法**：`WikiOutlink` 增 `exists: boolean | 'hidden'`；**新增** `visibleBlocks: number`（该目标页对当前主体可见的块数）—— 它让前端能在**不泄漏任何内容**的前提下区分"完全无权"与"部分可见"。

### 5.6 搜索三路（**v2 修订：v1 漏判了 LIKE 兜底路**）
> **★ v7（方言语义，先说清适用范围）**：本节的三条路**全部由 `@geewiki/search` 提供** ⇒ **仅 SQLite 部署下存在**；PG 下该插件**显式拒绝激活**、`GET /api/search` 不存在（见 §4.3 的「★ v7：方言语义」）。**也就是说：PG 部署下本节讨论的泄漏面不存在，代价是"没有检索"** —— 这是已知的非目标，不是遗漏。
`packages/plugin-search/src/index.ts`：FTS 路 `:395-400`、**LIKE 短查询兜底路 `:415-428`**、`SELECT_COLUMNS` `:298`、`contents()` `:460-472`

- **FTS 路**：改 `JOIN blocks_fts` + `JOIN blocks b ON b.id = f.rowid` + **`AND ( b.tier <= ? OR b.id IN (:grantedBlockIds) )`**（★ v4 改形：两个分支，形态与理由见 §4.3）。
- **★ LIKE 兜底路（v1 未识别）**：该路的官方注释明说"**直接扫 `pages` 表（不经过 `pages_fts`）**……兜底就该兜在真正的真源上"（`:415-420` 附近注释）。它在块级模型下**会直接读出 `pages.content` 原文** ⇒ **短查询（<3 字元，中文 2 字词如「检索」）会成为匿名泄漏通道**。**这是 v1 §5.6 的漏判，必须修。**
  **改法**：LIKE 路改为扫 `blocks` 表（**★ v4：`text LIKE ? AND ( tier <= ? OR b.id IN (:grantedBlockIds) )`** —— 与 FTS 路同形，两个分支缺一不可），并**显式标注一处权衡退化**：兜底不再兜在"页面真源"上，而兜在 `blocks` 上 ⇒ 若 `blocks` 与 `pages.content` 漂移，短查询会漏行。缓解：`content_hash` 自检 + 启动时告警，把"静默漏行"变成"显式不一致"。
  > **★ v4 提醒（最容易漏的一处）**：短查询 LIKE 路是**独立的一条 SQL**，v4 的两个分支**必须同样改到这里**。只改 FTS 路会让 `granted` 块在**2 字元中文短查询**下永远搜不到（漏召回，不泄漏）—— 属于"静默功能缺失"，测试必须单独覆盖（见 §8.2 P3a 第 5 条与新增第 11 条）。
- **`SELECT_COLUMNS` `:298`**：`p.content` 必须**移除**，改为按块聚合。
- **`contents()` `:460-472`**：改为 `blocks` 聚合投影（§4.5）。

### 5.7 AI 问答（RAG 带正文进答案与 `sources` 帧）
`packages/plugin-ai/src/index.ts:419`（`ctx.get('search-service')`）、端点 `:879`（`POST /api/ai/ask`）、`:903`（GET 变体）、`:913`（`POST /api/ai/stream` SSE）
**改法**：`ask`/`stream` 端点接受 `principal`；检索结果在**进入 prompt 之前**过滤；SSE 的 `sources` 帧只发可见条目的 `{slug,title}`；**`stream` 的鉴权必须在建立连接时完成**（`trackStream(res, owner)` 的 `owner` 是插件名 `packages/core/src/index.ts:591-611`，**不是鉴权**，不能复用）。


> **修正（本批，2026-09-14）——本节的行号与包名全部失效，且"改法"三条已按更严的形态落地。**
>
> **① 落点更正**：`packages/plugin-ai/src/index.ts:419` / `:879` / `:903` / `:913` 随拆分失效（该目录已不存在）。现在是 **`@geewiki/ai-qa`**（`packages/plugin-ai-qa/src/index.ts`）：`POST /api/ai/ask` `:897`、`GET /api/ai/ask` `:922`、`POST /api/ai/stream` `:931`、`GET /api/ai/capabilities` `:939`；服务契约 `ask(principal, q, opts?)` 的 **`principal` 是必填首参**（`:204`，注释 `:201-202`："漏传在编译期即报错，运行期还会在 `retrieve` 里经 search-service 的守卫再兜一道"）。
>
> **② "检索结果在进入 prompt 之前过滤"落地为两层，且都在 SQL 层**：召回 `search.search(principal, query, { limit, mode: 'terms' })`（`:431`）+ 取正文 `search.contents(principal, hits.map(h => h.slug))`（`:438-441`）。**两层都必须带主体**——只过滤正文会泄漏"哪些 slug 存在"（命中列表本身），只过滤召回则 `contents()` 会把不可见页的正文交出来。`search-service` 侧的主体守卫**抛错而不是"当作匿名"**（`packages/plugin-search/src/index.ts:223` 附近），故"忘传主体"不可能静默通过。
>
> **③ "SSE 的鉴权必须在建立连接时完成"已落地**：流式路径在进入任何帧之前判 `h.principal`，缺失即 **普通 JSON `401 {ok:false,error:'unauthorized'}`**（`packages/plugin-ai-qa/src/index.ts:652-656`），且注释把两条理由都写在了那里——(a) 主体一次定下、整个流沿用，否则"连接建立后权限被撤销"会留下"流仍按旧权限推送"的窗口；(b) `trackStream(res, owner)` 的 `owner` 是**插件名**、用于在途排空，**不是鉴权**（该签名现在是 `trackStream?(res, owner?)`，`packages/core/src/index.ts:749`；本节旧文引的 `packages/core/src/index.ts:591-611` 已移位）。**所有前置判定一律在写 SSE 头之前以普通 JSON 返回**：实测缺模型时 `POST /api/ai/stream` 回 **503 + `content-type: application/json`、零事件帧**（`data/verify/ai-split-e2e/result-backend.json` 的 `A_stream`）；空 `q` 与未知字段是 400 JSON。
>
> **④ 状态码按原因二分**（本节与 §4.5 都没写过这条，实现期补上）：**503 = 前置条件不满足**（`model_unavailable` / `search_unavailable` / 辅助写作的 `unavailable`，**模型根本没被调用**）vs **502 = 上游真的失败**（`generation_failed` + `degraded.code`，实测 429 ⇒ `RATE_LIMIT`、上游 200 但零 token ⇒ `PROVIDER_ERROR`）。**"上游正常结束但一个字符都没给"判为失败**，判据是文本是否为空而不是 `usage.completionTokens`（用量字段可选）。检索 0 命中**仍不是错误**：`200 mode:'no-context'` + `answer:null` + 不调用模型。
>
> **⑤ `GET /api/ai/capabilities`（与辅助写作的 `GET /api/ai/assist/capabilities`）是 `access: 'public'`，其外发的模型路由信息必须脱敏——本批补上了这条守卫。** 两个端点注册时都用三参形式 ⇒ 默认 public（`packages/core/src/index.ts:501-504`："省略等价于 `{ access: 'public' }`"；注册点 `packages/plugin-ai-qa/src/index.ts:939`、`packages/plugin-ai-assist/src/index.ts:280`）。它们把 descriptor 的字段**直接抄给调用方**，而 **`label` / `model` 不是静态字面量**——`@geewiki/openai` 的 `model` 是对管理员所设值的**实时 getter**（`packages/plugin-openai/src/provider.ts:145`），于是外发的是"管理员在后台填进去的字符串"；只要某个适配器的 `label` 取自可配的 baseUrl，而该 URL 带 basic-auth（`https://user:sk-xxx@gateway/…` 是能工作的写法），密钥就会**匿名**出现在响应里。**修法在投影处、不在各端点里**：`listRouteInfos()` 的每个字段都过 `safeText() = redact()`（`packages/plugin-llm/src/availability.ts:59`，理由记在 `:29-45`），两个插件共用同一份。守卫：`packages/plugin-llm/test/degrade.test.ts:219`『listRouteInfos：label/model 里的形似密钥片段必须被脱敏（capabilities 是公开端点）』，断言 `info.label.includes('***')`（`:252`）。**为什么保留 public 而不是收紧为 admin**：前端要在未登录页给出"AI 能不能用"的可执行提示（"去模型接入填密钥" / "启用全文检索"），收紧会让内容浏览路径回归——这条裁决记在 `packages/manager/src/index.ts:1714-1720`。**顺带闭合本节 §5.11 的前端连带项（AI 这一条线）**：入口可用性不再探测 `GET /api/plugins` + 硬编码插件名（`WikiPage.tsx` 的 `stateOf('@geewiki/ai')` 已删），改读**入口表 + 插槽仲裁**（`pluginUiDeclaredFor()`，`packages/web/src/lib/pluginUi.ts:190`），故"收紧管理端点后普通用户页插件探测 403 ⇒ AI 按钮恒灰"这个连锁不再适用于 AI 入口。**仍开放**：其它仍按硬编码插件名探测的功能入口未一并改造。


### 5.8 图与导航
`packages/web/src/components/Sidebar.tsx`（吃全量列表）、`packages/web/src/lib/navTree.ts`、`#/graph` → `GraphPage`
**改法**：侧边栏与图均消费 `visibleSlugs` 的结果；`GraphPage` 若走 `/api/pages` 则自动受 §5.1 保护，需确认它没有第二条取数路径。

### 5.9 静态资源与 SSE 路径的鉴权覆盖（**当前完全无覆盖**）
`packages/server/src/index.ts:634-680`（`serveStatic`，`:651` 的 SPA fallback `/` → `index.html`）
**改法**：
- **API 一律 `Cache-Control: no-store, private`**（含 401/403）。
- **静态资源维持现状**（`:666-668`，hashed 资产 `immutable` / HTML `no-cache`）—— 因为 app shell **不含任何身份相关数据**（数据都是客户端 fetch 的）。
- **门户走独立渲染分支**（见 §6），由**服务端裁剪后再渲染 HTML**，其 `Cache-Control` 必须由**渲染时的 principal 决定**。**这是 web cache deception 的关键防线。**
- **SSE**：`packages/plugin-ai/src/index.ts:913` 在建立连接时判定 principal，**不足即 401/403 且不写任何事件帧**（`noteStatus()` 记指标后直接 `res.end()`）。

### 5.10 门户**存在但不许搜索引擎收录**（**v2 整节翻转**）
**改法**（详见 §6）：`robots.txt` `Disallow: /` + 响应头 `X-Robots-Tag: noindex, nofollow` + 从非门户页面移除 `packages/web/index.html:54` 那唯一的静态 `<meta name="description">`（避免误导）+ **不提交 sitemap**（但**保留** `/sitemap.xml` 端点作为**运维核对清单**）。

### 5.11 管理台（**最高危**）
`packages/manager/src/index.ts:1562`（`GET /api/plugins`）、`:1566`（graph）、`:1572`（slots）、`:1582`（ui）、`:1602`（session）、`:1603`（**enable**）、`:1617`/`:1626`（config 读写）、`:1638`（**replace**）、`:1652`（**disable**）、`:1662`（**session/persist**）
**改法**：全部 `register(..., { access:'admin' })`；`POST enable/disable/replace` + `PUT config` + `persist` **额外**要求 `X-GW-CSRF` 头与 `Origin` 校验，并写审计（`actor/action/target/before/after`）。
> **注意最容易漏的连带改动**：`GET /api/plugins` 被前端当作"插件是否 active"的探测源（`packages/web/src/pages/WikiPage.tsx:249-252`）。收紧为 admin 后**普通用户页面上的插件探测会 403** ⇒ 会出现"控制台一片红 + AI 按钮恒灰"。**必须同步改前端**（§8 的前端项）。

> **落地后的两处偏离（本批核对，行号已整体位移）**：① 上面那串行号是设计时的快照，现管理端点整体后移（`GET /api/plugins` 在 `packages/manager/src/index.ts` 更靠后处，读端点里 **`GET /api/plugins/slots` 与 `GET /api/plugins/ui` 刻意保持 `access:'public'`** —— 它们是"这个界面有没有人渲染"的只读投影，收紧就会把公开内容页的入口判断一起打死；裁决理由记在 `packages/manager/src/index.ts:1714-1720`）。所以"全部 `access:'admin'`"这句**只对写端点与配置端点成立**。② 上面"注意最容易漏的连带改动"里担心的那条连锁**已在 AI 这条线上闭合**：前端不再用 `GET /api/plugins` + 硬编码插件名判功能入口，改读入口表 + 插槽仲裁（`pluginUiDeclaredFor()`，`packages/web/src/lib/pluginUi.ts:190`），详见 §5.7 修正块。**仍开放**：其它仍以硬编码插件名探测的功能入口未一并改造（本节不代为宣布完成）。

### 5.12 `GET /sitemap.xml` 的定位变更（**v2 新增**）
即使不收录，也**必须保留**该端点并让它复用 `visibleSlugs` —— 它的价值从"给爬虫"变成**"给运维做泄漏核对"**（用它与匿名可见集合做集合差，必须为空）。这是一条**可自动化的安全回归测试**。

---

## 6. 门户与缓存策略

### 6.1 门户路径：`/portal`（**v2 纠正了 v1 的 `/` 与 `/p/*`**）

**为什么要改**：`packages/server/src/index.ts:651` 的 SPA fallback 把 `/` 映射到 `index.html`；而 `packages/server/src/index.ts:533` 已有明确的先例注释 —— "**与普通静态资源的关键差别：绝不回退 index.html**"。让门户占用 `/portal` 这个**真实路径**，可以完全避开与 SPA fallback 的纠缠。

**顺带修掉 v1 的一处自相矛盾**：v1 提出 `/` 与 `/p/*` 做服务端渲染，却又要求"复用 `ui/*` 与 tokens"—— 而块级渲染**必须复用前端渲染管线**（否则占位文案与 Markdown 渲染会出现两套实现），这只有走 SPA 才自然。所以：

| 形态 | 路径 | 渲染方式 |
|---|---|---|
| **访客门户首页** | `GET /portal` | **服务端渲染**（可分享、带 noindex），只展示 `visibleSlugs(anonymous)` 的公开投影 |
| **公开条目** | `#/wiki/<slug>` | **SPA 渲染**，复用全部既有渲染管线（`packages/web/src/pages/WikiPage.tsx:697-1132`、`MarkdownBody` 挂载于 `:1016`） |
| `/p/*` | — | **不再使用** |
| 登录后工作台 | `#/home` / `#/wiki/*` | SPA |

**服务端需要新增**：`serveStatic`（`packages/server/src/index.ts:634-680`）**之前**插入门户渲染分支，**绝不回退 index.html 给门户的 404**。前端新增 `packages/web/portal.html` 作为**第二个 Vite 入口**（复用 `styles/tokens.css` 与 `ui/*` 原语 ⇒ 复用无障碍与对比度守卫测试）。

### 6.2 不许收录：三件套（**不是三选一**）

| 手段 | 具体 | 为什么不能少 |
|---|---|---|
| `robots.txt` | `User-agent: *` / `Disallow: /` | 覆盖"愿意守规矩的爬虫"的**全站**抓取。成本≈0 |
| 响应头 `X-Robots-Tag` | `/portal` 与公开条目返回 `X-Robots-Tag: noindex, nofollow, noarchive` | **唯一能覆盖非 HTML 响应与"已被收录页面的重新抓取"的手段**。meta robots 只对 HTML 的 `<head>` 有效；`noarchive` 额外抑制快照 |
| `<meta name="robots">` | `/portal` 的 HTML `<head>` 内 `noindex, nofollow` | 防御纵深 + 对不读响应头的爬虫；**并且**要**移除** `packages/web/index.html:54` 那条静态 `<meta name="description">`（它现在被 SPA shell 复用，会误导） |

**不提交 sitemap**：`sitemap.xml` 是**收录的加速器**，与"不许收录"直接冲突。但**保留 `/sitemap.xml` 端点**（复用 `visibleSlugs`），定位改为**运维泄漏核对工具**（§5.12）。这一条是本方案的巧妙点：安全回归测试的价值保留了，收录加速的副作用去掉了。

### 6.3 OG / canonical：**保留，与不收录不冲突**

- **冲突分析**：`noindex` 只影响**搜索引擎的索引与排名**；OG 标签面向**社交平台爬虫（Twitter/X、Slack、微信、Discord）**，它们**不遵守** `noindex` 语义（它们做的是"临时抓取生成预览卡片"，不是"建索引"）。两者是**不同的消费方与不同的机制** ⇒ 保留 OG 不产生收录风险。
- **保留 OG/canonical 的收益**：内网/群聊里分享链接时能看到标题与摘要（这是知识库的核心传播路径）；`canonical` 让"同一页面多个入口 URL"在将来若改变收录策略时行为确定。
- **一条约束**：OG 的 `og:description` **必须来自同一裁剪函数**（匿名投影的前 N 字），**不得**直接取 `pages.content` —— 否则 OG 就是第二个泄漏面（爬虫拿到的描述里含受限片段）。
- **不建议**更激进的做法（如 `/portal` 返回 401）：那会让门户失去"存在"的价值。

### 6.4 写死的一条（建议直接抄进 `docs/architecture.md`）

> **`noindex` / `robots.txt` / `X-Robots-Tag` 不是访问控制，永远不是。** 它们只约束**自愿遵守的爬虫**，对任何直接 HTTP 客户端（curl、脚本、恶意爬虫）**零约束**。因此：
> 1. **服务端裁剪**（`policy-service` 的 `project()`，逐对象逐请求）是**唯一**的访问控制手段；
> 2. **`Cache-Control` 按 principal 分流**是**唯一**防止"匿名响应被缓存后喂给登录用户"（web cache deception）的手段。
> 这两条**在任何收录策略下都不得省略**，包括"全站 noindex"。

### 6.5 缓存策略的最终形态（noindex 场景）

```text
# 匿名渲染（无 gw_sid cookie）
GET /portal           → Cache-Control: public, max-age=60, s-maxage=300
X-Robots-Tag: noindex, nofollow, noarchive

# 检测到 gw_sid cookie（无论有效与否 —— ★ 判 cookie 存在性，不判会话有效性）
GET /portal           → Cache-Control: private, no-store
X-Robots-Tag: noindex, nofollow, noarchive
Vary: Cookie          ← ★ 新增：让任何中间缓存不把两者混用

# 所有 /api/*（含 401/403/404）
                      → Cache-Control: no-store, private
```

**三处关键决定**

1. **判"cookie 存在性"而非"会话有效性"**：判定有效性要查库（每请求 IO），而存在性判断是纯 header 解析。安全性上后者更保守（拿到任意垃圾 cookie 也走 `no-store`）。
2. **`Vary: Cookie`** 是 `public` 与 `private` 之间的**正确性锚点**：即便某中间缓存忽略了 `no-store`，`Vary` 也保证不会跨身份复用。
3. **`s-maxage=300` 允许 CDN 缓存匿名门户 5 分钟** ⇒ **权限收紧后需要"清缓存 + 请求重新抓取"的运维动作**（P4 交付项）。若不接受这个窗口，把 `s-maxage` 设为 `0`（门户渲染很便宜）。

### 6.6 前端 IA 增量（相对 v1 的增补）

| 项 | 改法 |
|---|---|
| 块占位渲染 | `MarkdownBody` / `renderMarkdownBody`（`packages/web/src/lib/markdownRender.ts`）新增一种节点：`{ kind:'gated', count:N, minVisibility:'org'\|'granted' }`（★ v3：原名 `minRole`，因为它的取值是**可见性档位**、不是角色，故改名，见 §12 第 16 条；★ v4：取值域随块级三档改为 `'org'\|'granted'`）→ 渲染为"🔒 此处有 N 段内容需登录查看" + 申请入口；**措辞不得包含块内容/标题/字数以外的信息** |
| 预览为匿名视角 | 编辑器预览（`packages/web/src/pages/WikiPage.tsx:1135-1140` 的 `renderMarkdownBodyForPreview`、挂载于 `:1670`）新增"预览为匿名/组织成员视角"开关 —— 否则作者无法自查块级可见性（**这是块级模型唯一的可用性救生圈**，P3d 交付）。**★ 本批已取代**：内嵌预览改为「按访客视角预览」**对话框**（按钮按需打开，视角开关仍在），上列"内嵌预览"的位置与 `:1135-1140` / `:1670` 行号引用**已过期** —— 详见文末「追加：权限入口的归并（本批）」 |
| 块级共享面板 | 条目详情页新增"内容块"面板：列出被收紧的块（`ordinal` + 摘要 + 可见性 + 单独授予），供 `canManageVisibility` 者治理 |
| 红链 | v1 的三步态 `exists: false \| true \| 'hidden'` 不变，**新增** `visibleBlocks`（§5.5）用于区分"部分可见" |
| `系统状态`（服务健康 / DB 方言 / 表清单） | **★ v8 新增：随 `管理 ▾` 下沉为管理员专属** |

> **★ v8：`系统状态` 的归属（规格从未表态，本次裁定并留痕）**
> - **事实**：`grep -rn "系统状态\|服务健康" docs/` 在**本文档里零命中** —— 该界面**从未被设计文档规定过**（它是既有实现里的一个对话框，见 `packages/web/src/App.tsx:401`、`:548-551`）。因此"它该给谁看"**不是实现偏离文档，而是文档缺口**。
> - **裁定（编排者）：维持管理员专属**。理由：它的内容是**运维细节**（服务健康、DB 方言、表清单），与所在分组的"**运维台面**"语义一致（实现内的原话见 `packages/web/src/App.tsx:126-128`：*"「系统状态」对话框与这两项同处一个下拉，因此它**也随之下沉为管理员可见**。它是运维台面…"*）。
> - **★ 一个必须写清的边界**：**`GET /api/health` 本身仍然是公共端点**，看门狗不受影响 —— `HEALTH_PATH = '/api/health'`（`packages/core/src/index.ts:379`）在 `packages/server/src/index.ts:583` **内联处理**，**不经过 `router.register`**，因此**根本不进 §2.5 的 `access` 闸门**（与 §2.5.2 边界二 一致）。**"界面管理员专属"与"端点公共"是两件事，不要混。**
> - **若将来要让所有人看到服务健康**：改的是**界面门控**，**不要**顺手把 `/api/health` 改窄（那会打断看门狗）。

---

## 7. OIDC 双通道（本地账号 + 企业 SSO）

### 7.1 账号模型

```text
users (本地账号，唯一)
  └─ user_identities (0..N 个外部身份)
       ├─ (iss://idp.example.com, sub=abc123)   ← 唯一索引
       └─ (iss://other-idp, sub=xyz)
```

- **一个 user 可以有多个 identity**（多 IdP、或同一 IdP 换了 sub 后重新绑定）。
- **一个 identity 只能属于一个 user**（`idx_identities_issuer_sub` 唯一约束保证）。
- `issuer` **原样存**（含尾部斜杠差异视为不同 issuer）—— 但注意 OIDC 规范允许 issuer 带/不带尾部斜杠，**判定时必须用 `new URL(issuer).href` 规范化后再比对**，否则同一个 IdP 会产生两条 identity。

### 7.2 同一 email 的合并/冲突策略：**禁止自动绑定**

| 场景 | 处理 |
|---|---|
| OIDC 首登，`(issuer,sub)` **未绑定**，email **不存在** | 按 `provisioning_mode` 决定：`auto` ⇒ 建用户 + 绑定；`invite_only`（默认）⇒ 需存在该 email 的未消费邀请，否则 403 `no_invitation`；`off` ⇒ 403 |
| OIDC 首登，`(issuer,sub)` 未绑定，email **已存在**（本地账号） | **绝不自动合并**。返回 409 `identity_link_required` + 一次性 `link_ticket`（5 分钟、绑当前 OIDC 身份、**HMAC 签名的自包含票据，不落库** —— ★ v7 订正，理由与安全论证见下方 ★ v7 小节）。用户必须在**已登录的本地会话**里确认绑定（`POST /api/auth/identities/link`），或先用本地密码登录再走绑定页 |
| 用户想解绑 | 允许，但**至少保留一种登录方式**（不能解绑掉最后一个 identity 且无密码）⇒ 409 `last_credential` |

**为什么禁止自动绑定**（两条都是账号接管）：

1. 若 IdP 的 email 未验证（`email_verified: false`）或 IdP 被攻破 ⇒ **任意 OIDC 账号可接管任意本地账号**（含 owner）。
2. 反向：本地恶意用户可用自己的 email 预先占位，等真实用户通过 OIDC 登录时"被合并"进攻击者的账号。

**唯一的例外仍不例外**：当 `email_verified=true`（IdP 声明）**且**目标本地账号的 `email_verified=1` 时，也**仍然要求手动确认** —— 因为 `email_verified` 只是 IdP 的**声明**，不是我们独立验证的事实。

#### ★ v7：`link_ticket` **不落库** —— HMAC 签名的自包含票据（订正"存 DB"的旧表述）

**结论先行**：票据就是一张**服务端签了名的纸条** —— `base64url(JSON 载荷) + '.' + base64url(HMAC-SHA256)`。服务端**只验签、不存任何一行**；票据自己携带 `(iss, sub, exp)`，验得过就说明"这是本服务在 5 分钟内签发的、针对这个 OIDC 身份的一次性凭据"。

**为什么旧表述必须改**：v6 及更早的 §7.2 要求"**存 DB**"，但 §7.6 把本阶段的**迁移增量定为 0**（`user_identities` 已在 P1 建表），而 §3.1 的 `0010_identity.sql` 里**根本没有存 ticket 的表**（已 grep 确认，零命中，见 §3.1 的 ★ v7 核对）。**两条要求不可兼得**；P1.5 的两个独立实现者各自独立选了同一个解法 —— **不新增表，改用签名票据**。

**实现（出处：P1.5 worktree `.wt-p15`，尚未合入 `main`；行号取自核对当时的该工作区状态）**

| 事项 | 落点 |
|---|---|
| 载荷类型 `LinkTicketPayload` = `{ iss, sub, email, emailVerified, displayName, exp }` | `.wt-p15/packages/plugin-auth/src/oidc.ts:71-81` |
| 有效期 `TICKET_TTL_MS = 5 * 60 * 1000` | `.wt-p15/packages/plugin-auth/src/oidc.ts:84` |
| 承载 cookie 名 `LINK_COOKIE = 'gw_link'` | `.wt-p15/packages/plugin-auth/src/oidc.ts:93` |
| 签发 `signLinkTicket(payload, secret)` | `.wt-p15/packages/plugin-auth/src/oidc.ts:96-100` |
| 校验 `verifyLinkTicket(token, secret, now)` —— **任一处不合法返回 `null`（失败关闭）**；顺序是"格式 → 签名（恒时比较）→ 载荷形状 → 过期"（**先验签名再解析载荷**，不把未验证的 JSON 当可信输入） | `.wt-p15/packages/plugin-auth/src/oidc.ts:102-147` |
| 密钥：`GEEWIKI_OIDC_TICKET_SECRET`（≥16 字符）生效，**未配置则每进程随机**（`randomBytes(32)`） | `.wt-p15/packages/plugin-auth/src/index.ts:476-478` |
| cookie 属性 `Path=/; HttpOnly; SameSite=Lax`（生产加 `Secure`）⇒ **前端 JS 读不到** | `.wt-p15/packages/plugin-auth/src/http.ts:59-69` |
| 票据**从不出现在 URL / 查询串**里（放进去会经 `Referer`、浏览器历史、反代日志与截图泄漏） | `.wt-p15/packages/plugin-auth/src/oidc.ts:86-92` 的注释 |

**安全性论证：不落库与落库"等价"** —— 这是本改法能被接受的关键，请勿跳过：

绑定端点**同时**要求两件事（都在一次请求内强制）：

1. **持有有效 ticket**（从 `gw_link` cookie 读，验签 + 未过期）；
2. **以「目标本地账号」的会话登录** —— `const userId = h.principal?.userId ?? null`，为 `null` 直接 **401**（`.wt-p15/packages/plugin-auth/src/index.ts:1262-1266`）。

⇒ **攻击者拿自己的 ticket 一点用都没有**：票据里绑的是**他自己的** `(iss, sub)`，而第 2 道要求的是**受害者的本地会话**。他签不出受害者的票据（没有密钥），也过不了受害者的会话闸门。**所以"ticket 可能被他人重放"这条顾虑不成立** —— 重放一张**自己签发**的票据，最多只能把自己的身份绑到自己已登录的账号上（等于什么都没做）。落库版的存在意义是"服务端能记住票据被消费过"，而本设计里"**能不能绑**"从来不由票据单独决定，**两道门缺一不可** ⇒ 两种存法**安全性等价**。

**"一次性"由唯一索引兜底**：`idx_identities_issuer_sub`（§3.1）—— 重放或并发下第二次 `INSERT` 会撞唯一约束，代码如实报冲突并**不放行**。实现里的原话：*"**唯一索引就是『一次性』的实现**"*（`.wt-p15/packages/plugin-auth/src/index.ts:1299-1310`）。

**为什么不新增迁移**：P1.5 的边界是"**迁移增量 = 0**"（§7.6）。落库至少要新增一张表，连带**两侧方言成对迁移**（§3.0）**加上一条过期行清理任务** —— 全都超出该阶段的范围，且与"P1.5 只叠加在 P1 之上"的定位相冲突。

**代价（诚实列出，两条都是失败关闭方向）**：

1. **进程重启 ⇒ 有效期内（≤5 分钟）的票据失效**：用户重走一次 SSO 即可，**拒绝而非放行**。
2. **多实例部署下票据不通用**：除非显式配置 `GEEWIKI_OIDC_TICKET_SECRET`（同一密钥即可跨实例）。**绝不用固定默认值兜底** —— 那等于把"猜不到密钥"这条保证换成"读源码就知道"（`.wt-p15/packages/plugin-auth/src/index.ts:470-475` 的注释原话）。

> **类型说明**：以上结论来自**只读查阅 P1.5 的实现源码**（该分支尚在演进 ⇒ **行号可能小幅漂移，定位请以函数 / 常量名为准**）。§7.6 的"迁移增量 0"与 §3.1 的 DDL 均**无需改动**。本轮**未运行任何代码、未跑该端点的端到端流程** —— 详见 §13.5 的未验证项。

### 7.3 OIDC 首次登录的 provisioning

```ts
provisioning_mode: 'off' | 'invite_only' | 'auto'   // 默认 'invite_only'
allowed_email_domains?: string[]                     // 额外门禁（如 ['example.com']）
```

- **默认 `invite_only`**：与本产品"默认私有"的安全姿态一致；管理员签发邀请即完成"谁能进"的决策。
- `auto` 需**显式开启 + 通常配合 `allowed_email_domains`**；在 `docs/` 里明确写"开启 `auto` 等价于把入站访问控制交给 IdP"。
- 首登创建的用户**默认无组织角色**（= Guest 语义）⇒ **OIDC 登录成功 ≠ 获得任何内容权限**，这是重要防线。

### 7.4 `issuer` / `sub` 唯一约束与安全校验（每条都是必须）

1. `(issuer, subject)` 唯一索引（**DB 层**，非应用层）。
2. `issuer` 必须**精确匹配**已配置值（禁止"从发现文档里取回" —— 那是 SSRF/混淆攻击面）。
3. `aud` 必须包含本 client_id；`exp`/`iat` 校验（允许 ±60s 时钟漂移）；`nonce` 必须匹配会话内一次性值。
4. **PKCE（S256）必须启用**；`state` 一次性、绑定会话。
5. **JWKS 缓存**：用 `node:crypto` 的 `createPublicKey` 从 JWK 构造，缓存 15 分钟，`kid` 未命中时**强制刷新一次**再失败。
6. 签名算法**白名单**（只接受 `RS256`/`ES256`/`PS256`），**拒绝 `alg: none` 与 HS\***（防算法混淆）。
7. 登录失败（任一环节）⇒ 记 `audit_log`（`action='login.fail'`，**不含 token 内容**）⇒ 统一错误文案，**不区分**"email 不存在"与"密码错误"。

### 7.5 在"无外部依赖 / 离线可用"承诺下的开关设计

| 层面 | 设计 |
|---|---|
| 依赖 | **零新依赖**：`node:crypto`（JWKS→公钥、签名校验）+ 全局 `fetch`（token 端点、发现文档）。与既有 `@geewiki/openai`（同样只用 fetch）一致 |
| 开关 | `@geewiki/oidc` **只登记、不写进 `config/plugins.base.json`** —— 与 `@geewiki/echo`/`@geewiki/llm`/`@geewiki/ai`/`@geewiki/openai` **完全同形态**（`packages/server/src/index.ts:973-1017` 的注释反复说明这个模式："只登记、不写进默认基础层清单，即'已注册但未启用'，由使用者在管理台按需热启用"） |
| 未启用时 | **`/api/auth/oidc/*` 端点不存在（404）**，登录页不渲染 SSO 按钮（前端通过 `GET /api/auth/capabilities` 探测，形态照抄 `packages/web/src/pages/WikiPage.tsx:249-287` 既有的"插件是否 active"两路探测法） |
| 离线可用 | ① 未启用 ⇒ 零影响；② 已启用但 IdP 不可达 ⇒ **前端不渲染 SSO 按钮**（`capabilities` 里带 `oidc: {available:false, reason:'unreachable'}`），本地密码通道**不受任何影响**；③ 已有会话与已建立的 SSE 连接**不依赖 IdP**（我们自己的 cookie session）⇒ **IdP 挂掉不会导致任何人掉线** |
| 配置校验 | schemastery `Config`：`issuer` 必填且必须 HTTPS（`http://localhost` 例外）；缺 `issuer` ⇒ 插件拒绝激活（`packages/plugin-auth` 侧留出 provider 注册表，形态照抄 `llm-service` 的路由注册表 + "无 provider 也能装载并给出可迭代的降级流"） |

### 7.6 增量工作量与阶段归属

| 项 | 内容 | 量级 |
|---|---|---|
| `packages/plugin-oidc` | OIDC 客户端（发现/JWKS/PKCE/state/nonce/回跳）+ 路由注册 | **M** |
| `packages/plugin-auth` 增量 | provider 注册表、绑定/解绑端点、`link_ticket` 流程、`capabilities` 端点 | **S**（叠加在 P1 之上） |
| 迁移增量 | **0**（`user_identities` 已在 P1 建表） | — |
| 前端增量 | 登录页 SSO 按钮 + 绑定引导页 + `capabilities` 探测 | **S** |
| **合计** | | **M** |

**放在哪：`P1.5`（独立阶段，可并行开发，不得阻塞 P1）**

理由：P1 的价值是"堵住匿名写/管理端点 + 有身份"，**OIDC 对这两个目标零贡献**。把 OIDC 塞进 P1 会让 P1 的验收标准里混入"需要外部 IdP 才能验证"的项 —— 而本项目**没有可用的测试 IdP**，验收会卡住。P1.5 可以（也应该）用一个本地 mock IdP（测试内的最小 JWKS + token 签发器）完成验收。

---

## 8. 分阶段实施计划

### 8.0 相对 v1 的三处顺序修正（先讲这个）

1. **★ P2 不改 FTS**。v1 把"`pages` 增列 + FTS 改造"都放在 P2 —— **错序**。修正：P2 只加 `pages` 列并在**查询层**过滤（`WHERE slug IN visible`），`pages_fts` 保持原样（external content 触发器不动）；FTS 改造**一次性推到 P3a** 与块模型一起做。收益：P2 的迁移**不触碰任何触发器**（v1 §9 R1 的最大风险在 P2 消失），且 P3a 只有一个"搜索后端切换"的原子 PR。
2. **P2 的一条结论必须提前到 P1**：`users.email_verified` 与 `user_identities` 表。理由见 §3.1 的说明。
3. **版本/权限一致性的规则必须提前到 P2**，不能等到 P3c。理由：`page_versions` 的权限快照列在 P3c 才加，但 **P2 的页面级权限变更就已经需要"可回溯"**（审计要求）。P2 先落"每次 ACL 变更写一条 audit + 一条 version（`acl_json` 先只存页面级）"，P3c 只是给同一机制补 `blocks_json`。

### 8.1 阶段表

| 阶段 | 范围 | 涉及文件:行号 / 新增插件 | 量级 | 测试影响 |
|---|---|---|---|---|
| **P0** | 钩子表 + 路由 `access` 声明 + break-glass + `bootstrap_required`。**★ v5（D7）落地方式**：break-glass 令牌取 `GEEWIKI_ADMIN_TOKEN`，**环境变量未设置即整个通道禁用**（不是"默认令牌"）；**每次使用留痕**，`actor` 记为 **break-glass 来源**（`principal.kind='break-glass'`，§2.4）。**★ v6（实现反馈）**：P0 **已落地**（worktree `feat/p0-route-auth-guard`，基线提交 `bb43fc2` + 一轮修复改动），实际 API 形状见 **§2.5**；**★ v7：该分支已合入 `main`（合并提交 `e708814`）**。**★ 注意：P0 不新增任何表 / 迁移** ⇒ 留痕在 P0 只有 **stdout 结构化行**（`auditBreakGlassUse()`）；`audit_log` 建表归 **P1**（`0013_audit.sql`）、审计闭环归 **P4** —— 取舍与风险见 §8.2 P0-6 | `packages/core/src/index.ts:487-492,502-518,544-580,598-620,679-698`；`packages/server/src/index.ts:135-249,490-618,637-694`；`packages/manager/src/index.ts:1574-1683`；`packages/plugin-wiki/src/index.ts:649-692` | **S** | 管理端点测试需补 token（**已落地为 `adminHeaders()`**，见 §8.2 P0-4） |
| **P1** | 身份/会话/本地密码 + **`email_verified` + `user_identities` 建表** + 登录/登出/初始化向导。**★ v7：已合入 `main`**（合并提交 `f3990a9`，分支 `feat/p1-identity`，基线 `e708814`，tip `4b19e7b`） | 迁移 `0010_identity.sql`、`0013_audit.sql`；新增 `packages/plugin-auth`（`provides:'auth-service'`）；`packages/server/src/index.ts:938-1017` 登记；`config/plugins.base.json`；前端 `lib/authStore.ts`、`packages/web/src/api.ts:27-44`、`lib/errorText.ts:81-105` | **M** | `packages/web/test/errorText.test.ts` 必改 |
| **P1.5** | **OIDC 通道**：授权码 + PKCE、`(issuer,sub)` 绑定、`provisioning_mode`、手动绑定流。**★ v7：正在实现中** —— worktree `.wt-p15`、分支 `feat/p15-oidc`（**堆叠在 P1 的 tip `4b19e7b` 上**）⇒ 本行内容以 §7.2 的 ★ v7 小节为准（`link_ticket` 已改为**不落库**） | 新增 `packages/plugin-oidc`（`provides` **无** —— 只往 `auth-service` 注册 provider，**与 `@geewiki/openai` 同形态**：`packages/server/src/index.ts:1000-1017` 的注释明说"只往 llm-service 注册一条路由，故**无 provides**"）；`packages/plugin-auth` 增绑定端点 | **M** | 仅新增 |
| **P2** | 组织/成员/组/邀请 + **页面级**可见性 + 继承 + `page_grants` + 全量**读路径**加 principal + 门户 `/portal` + 导航 IA + 404/403。**★ v7：正在实现中** —— worktree `.wt-p2`、分支 `feat/p2-org-visibility`（**基线 `f3990a9`**）。**★ v5（D8）新增上线步骤**：**存量条目一次性回填 `visibility='org'`**（见 §8.2 P2 第 13 条） | 迁移 `0011_org_team.sql`、`0012_page_acl.sql`；**新增数据回填**（D8：`UPDATE pages SET visibility='org' WHERE …`，属上线动作、**不是 DDL 默认值**，§3.3）；新增 `packages/plugin-org`、`packages/plugin-authz`（`policy-service`）；`packages/plugin-wiki/src/index.ts:388-425,601-722`；`packages/plugin-search/src/index.ts:478` 与查询层过滤；前端 §6.6 各项 | **L** | 最大（导航/详情按钮/wiki 服务契约） |
| **P3a** | **块模型落地 + 读路径改造 + FTS tier 切换**（原子 PR）。**★ v7：其中"FTS tier 切换"部分仅 SQLite 适用** —— `blocks_fts` 是 FTS5（SQLite 专有），PG 部署下 `@geewiki/search` **显式拒绝激活**⇒ 检索不可用；~~块模型与读路径裁剪两部分仍可两方言落地~~ **★ v8 订正：这句话当时是未经验证的乐观判断，且不成立** —— 有三个**只在真 PostgreSQL 上暴露**的缺陷（写块靠异常判表存在 / 缺 `RETURNING id` / `deletePage` 的 `DELETE FROM blocks_fts` 无方言守卫），修掉之前 PG 上「写块恒 0 条 / 新建保存 500 / 删除页面 500」；现已由 `96891db` / `e941da5` 修掉，但**这三点都不由类型系统保证**，详见 §4.3 的「★ v8：P3a 的方言成本」。另：**块模型与读路径裁剪两部分仍可两方言落地**。详见 §4.3 的「★ v7：方言语义」与 §8.2 P3a 的逐条标注 | 迁移 `0015_blocks.sql`（**★ v8 订正落点：落在 db 包、两侧成对** —— `packages/db-sqlite/src/migrations/` 与 `packages/db-postgres/migrations/`，**不是** `packages/plugin-wiki/migrations/`，见 §3.6 的 ★ v8 订正）+ `packages/plugin-search/migrations/0002_blocks_fts.sql`；`packages/plugin-wiki` 的 `parseBlocks` + `savePage` 事务（`:489-531`）；`packages/plugin-search/src/index.ts:290-478`；`packages/plugin-ai/src/index.ts:438`、`packages/plugin-ai/src/select.ts:41-44` | **L** | `packages/plugin-search/test/search.test.ts`（`SearchHit.content` 删除，另含 ★ v8 的"标题不参与 FTS 匹配"断言 `:558`）、`packages/plugin-ai/test/*` |
| **P3b** | **块级权限 + `block_grants` + 例外授予 + 申请访问** | 迁移 `0016_block_grants.sql`；`policy-service` 的块级判定；条目详情页"内容块"治理面板 | **M** | 新增为主 |
| **P3c** | **块级版本与恢复** | 迁移 `0017_version_blocks.sql`；`packages/plugin-wiki/src/index.ts:621-639`（读历史）+ 恢复端点 | **M** | `packages/plugin-wiki/test/service.test.ts` |
| **P3d** | **块级编辑器体验**：标记语法高亮/自动补全、块级可见性侧栏、"预览为匿名视角" | `packages/web/src/components/MarkdownEditor*.tsx`、`packages/web/src/pages/WikiPage.tsx:1135-1140,1670` | **S–M** | `packages/web/test/designSystem.test.ts`、`contrastPlan.test.ts` |
| **P4** | 审计闭环 + 反向展开 + 缓存/重新抓取运维动作 + **授权/邀请到期清理**（★ v3：**不含**权限版本清理 —— D11 已改为永久保留） + 会话管理 | v1 不变；新增 `GET /api/admin/search/verify`、`GET /api/admin/blocks/verify` | **M** | 仅新增 |

**依赖关系**：P0 → P1 → P2 → P3a → P3b → P3c → P3d → P4（**严格串行**：每阶段都建立在前一阶段的 principal 与 policy 之上）。
**可并行**：P0 的"钩子表 + 路由声明"与 P1 的"用户/会话表迁移"可并行开发（不冲突），合流点在 P1 的 `resolvePrincipal`；**P1.5 可与 P2 并行，但不得阻塞 P1 上线**。

> **★ 本批现状（见文末「追加：权限入口的归并（本批）」）**：P3d 的"预览为匿名视角"**已交付**，但形态是**「按访客视角预览」对话框**（不再是内嵌预览，故 P3d 行里的 `WikiPage.tsx:1135-1140,1670` 行号引用**已过期**）；**标记语法高亮 / 自动补全**与**块级可见性侧栏**本批**仍未做** —— 本批交付的是**宿主内置的排版工具栏**（不是 `editor-toolbar-slots` 插件插槽）与**工具栏锁按钮**式的段落档位入口。

### 8.2 各阶段可测验收标准

**P0**

1. 无 token 时：`curl -X PUT /api/pages/x` → 503 `bootstrap_required`；`POST /api/plugins/%40geewiki%2Fdb-sqlite/disable` → 503。
   - **★ v6 订正（原写法按字面跑不通）**：原文写的是 `POST /api/plugins/@geewiki/db-sqlite/disable`。这个路径会被切成 **5 段** —— 插件名里的 `/` 被当成路径分隔符（`api` / `plugins` / `@geewiki` / `db-sqlite` / `disable`），而注册路由 `/api/plugins/:name/disable` 只有 **4 段**；路由匹配要求**段数相等**（`packages/server/src/index.ts:579-593`），于是它**根本不匹配任何路由**，直接落入"未匹配的 `/api/*`"分支 ⇒ 返回的是**路由自己的 API 404**（`{"ok":false,"error":"not_found","path":"…"}`，`:613-616`），**不是 503**。审查已**逐字复现**这一点。
   - **正确写法是 URL 编码**：`POST /api/plugins/%40geewiki%2Fdb-sqlite/disable` —— 它是 **4 段**，分发时逐段 `decodeURIComponent` 还原出 `:name = '@geewiki/db-sqlite'`（`:570-578`），因此**命中路由** ⇒ **503 `bootstrap_required`**（**审查实测**；本次 v6 修订未亲自复现，见 §13.4 的未验证项）。
   - **要记住的教训**：**插件名必须 URL 编码**。否则"段数不匹配 → **404**"很容易被误判成"**鉴权失效 / 端点不存在**"，排障时会走偏很远（404 看起来像"路由没了"，实际是"路径切段方式不对"）。
   - （**同一 P0-1 里的 `PUT /api/pages/x` 命令，审查确认逐字可跑、结论正确，不改。**）
2. 配 token 后：同样请求带 token → 成功；不带 → 401。
3. `GET /api/pages`、`GET /api/pages/:slug` **行为完全不变**（现有只读能力零回归）。
4. 现有测试全绿：`pnpm -r test`（尤其 `packages/server/**/*.test.ts` 的 router 用例、`packages/manager/**` 的 REST 用例需补 token）。
   > 建议在测试工具里提供 `withAdmin()` helper。
   > **★ v6 实现反馈**：实际落地为 `packages/server/test/helpers.ts` 的 `adminHeaders(extra)` 与 `ADMIN_TOKEN` 常量（**名字与建议的 `withAdmin()` 不同，语义一致**：构造带 `x-gw-admin-token` 的请求头，须与已设置的 `GEEWIKI_ADMIN_TOKEN` 配套使用）。**该 helper 刻意不放进模块顶层自动生效** —— 否则会给所有 import 它的测试**隐式开启应急通道**，让"未配置令牌时必须 503"这类用例静默变成**假通过**。
5. **（★ v5 新增，D7）未设置 `GEEWIKI_ADMIN_TOKEN` ⇒ 令牌通道完全不可用**：不设该环境变量时，带任意 `Authorization`/令牌头请求管理端点 ⇒ **仍 503 `bootstrap_required`**（或按未初始化处理），**绝不因为"没有配令牌"而放行**；显式设置后才进入"带 token 成功 / 不带 401"两种结果。
6. **（★ v5 新增，D7；★ v6 下调口径）break-glass 使用留痕**：用令牌成功调用一次管理端点 ⇒ **P0 阶段仅 stdout 留痕** —— 固定前缀的结构化行 `[audit] action=access.break_glass actor=break-glass method=… path=… remote=… at=…`（`auditBreakGlassUse()`，`packages/server/src/index.ts:180-186`），并在源码留 **`TODO(audit-service)`**；`actor` 记为 **break-glass 来源**（`principal.kind='break-glass'`）。
   - **★ v6 为什么要下调：原文与 §8.1 自相矛盾。** 原文要求"**`audit_log` 新增一行**"，但 §8.1 把 `0013_audit.sql` 划给 **P1**，而 P0 的范围是"**不新增任何表 / 迁移**"（`packages/server/src/index.ts:175-179` 的注释同样这么写）⇒ **P0 里根本没有 `audit_log` 表，这一条在 P0 内不可满足**。v6 把口径改成"**P0 仅 stdout 留痕（+ `TODO(audit-service)`）；持久化审计表在 P1 建立（`0013_audit.sql`），P4 做审计闭环**"，**§8.1 的 P0 行同步改词** ⇒ 两处不再互相矛盾。
   - **★ 这个取舍的风险（必须写明，别让它悄悄消失）**：stdout 留痕**只活在容器日志里** ⇒ **日志轮转（或容器重建）之后，应急令牌的使用将无迹可查**。也就是说 P0 → P1 之间的这段时间，"谁用应急令牌做了什么"**不可事后追责**，只能靠日志系统的保留 / 采集策略兜住（若运维把日志集中收集并长期保留，风险才降级）。**⇒ 上线 P0 时必须确认日志保留与采集策略，并把这条风险写进发布说明。**
   - 验收（P0 内可测）：用令牌调用一次受保护端点 ⇒ stdout 出现**恰好一行** `[audit] action=access.break_glass …`（含 `method` / `path` / `remote` / `at`）；**不带令牌或带错令牌的请求不产生该行**（留痕只发生在"认证通过"那一刻）。
   - 验收（P1 起接续）：`audit_log` 建表后，同一事件改写入审计表（`action='access.break_glass'`），可保留一条 stdout 作为冗余。

**P1**

1. 未登录访问 `GET /api/auth/me` → 401，前端跳 `#/login`。
2. 登录后 `Set-Cookie: gw_sid=...; HttpOnly; SameSite=Lax` 存在；`document.cookie` 读不到。
3. 登出后**原 cookie 立即失效**（吊销 `revoked_at`，非仅客户端删 cookie）—— 用 curl 带旧 cookie 验证。
4. 跨站表单 POST（无 `X-GW-CSRF`）→ 403。
5. 连续 10 次错误口令 → 429。
6. 登录/登出后 `pagesStore` 缓存被清（`invalidatePages()` 被调用，可用测试断言 store revision 变化）。
7. 现有 26 个前端测试文件全绿（新增 authStore 单测；`packages/web/test/errorText.test.ts` 需扩展 401/403 的 `kind` 断言）。
8. **（v2 新增）** `user_identities` 唯一索引存在且 `(issuer,sub)` 重复插入报错；`users.email_verified` 默认 0、本地创建置 1。

**P1.5** —— 见 §7.4 的七条安全校验，外加：mock IdP 下完成首登 `invite_only` 拒绝（403 `no_invitation`）、email 已存在时 409 `identity_link_required`、解绑最后一个凭据 409 `last_credential`、IdP 不可达时本地密码通道不受影响。

**P2**（v1 十条 + v2 一条 + v3 一条 + v5 一条 + **v6 一条** + **★ v8 一条**）

1. **继承**：`public` 父 + `private` 子 ⇒ 匿名 `GET /api/pages/:child` → **404**；`GET /api/pages` 不含该 slug。
2. **不可放宽**：`private` 父 + `public,published` 子 ⇒ 匿名仍 404。
3. **断链**：父 `inherit=false` ⇒ 子按自身 `visibility` 生效。
4. **移动**：把私有条目移入公开空间 ⇒ 匿名立即可见（★ v8 订正：原因是**判定层没有决策缓存、每请求现查库**，故天然**无 TTL 窗口**；原写的"`acl_revision` 缓存已失效"**不成立** —— 没有任何代码读 `acl_revision`，见 §13.6 第 11 条）。
5. **（v2 改写）** 搜索不泄漏：**查询层 `WHERE slug IN visible` 生效**（原第 5 条与 FTS 相关的部分推到 P3a）。
6. **反链不泄漏**：私有条目引用公开条目 ⇒ 公开条目的 backlinks **不含**私有条目标题。
7. **版本不泄漏**：匿名 `GET /api/pages/:slug/versions/:id` 对受限条目 → 404。
8. **门户**：匿名 `GET /portal` 返回真 HTML（`content-type: text/html`），含公开条目链接；受限条目不在其中；**响应头含 `cache-control: public, ...`**；带任意 `gw_sid` cookie 再请求 → **`cache-control: private, no-store`**。
9. **sitemap 与读取路径一致**：`GET /sitemap.xml` 的 URL 集合**等于**匿名 `visibleSlugs` 的公开子集（可写自动化断言：两者做集合差，必须为空）。
10. **PG 与 SQLite 双跑**：`pnpm --filter @geewiki/server test` 在两种 `DATABASE` 配置下均通过（`COUNT(*)` 需 `Number()` 强转，参照 `packages/plugin-wiki/src/index.ts:419-422`）。
11. **（v2 新增）** **`pages_fts` 的触发器未被本阶段修改**（grep 断言）。
12. **（★ v3 新增，决定二）** **应急覆盖留痕**：构造一个 `private` 且**无任何 grant** 的条目 —— owner/admin 访问 ⇒ 可见，且 `audit_log` 新增一行 `action='access.admin_override'`（含 `actor_id`/`target_kind`/`target_id`）；**反例（边界 1）**：owner/admin 访问一条本来就 `org` 可见的条目 ⇒ **不产生**该行。两向都要断言，否则审计表会被日常浏览刷爆（§2.3 规则 O1）。
13. **（★ v5 新增，D8）存量条目回填**：在**升级前的旧库**（条目只有 slug/title/content、没有 `visibility` 列）上跑一次 P2 上线步骤 ⇒ 断言：
    - ① **回填后每一条存量条目的 `visibility` 都是 `org`**（`SELECT COUNT(*) FROM pages WHERE visibility <> 'org'` 为 0，除非该行被**显式**改过）；
    - ② **没有任何存量条目被批量设成 `public`**：`SELECT COUNT(*) FROM pages WHERE visibility='public' AND published_at IS NOT NULL` **不因回填而增加**（`public` 只能由管理员显式发布，D8）；
    - ③ **回填是上线动作、不是 DDL 默认值**：只跑 `0012_page_acl.sql`（`ADD COLUMN … DEFAULT 'private'`）而**不跑回填**时，存量条目的 `visibility` 应为 `private`（**这正是 D8 要避免的"全站条目瞬间消失"**）—— 两条命令的先后关系必须写进发布手册；
    - ④ 匿名访问任一回填后的存量条目 ⇒ 按 `org` 规则处理（**匿名 = 404**，因为 `org` 档只对组织成员可见；**不是**"能看"）—— 这一点必须测准，别把 `org` 误当"公开"。
14. **（★ v6 新增，依据 = P0 独立代码审查的实测；★ v8 按实现订正判据）插件 `config` 回显泄漏 —— 路由层脱敏**：**无资格的主体**调用相关端点时，响应里**不含**任何插件的 `config` 字段。**两条路径都必须覆盖**（见下）。
    - **★★ v8 订正：判据被放宽了，而且放宽是有据的**。原文只写"**非 break-glass 主体**"，**实现是 `break-glass` 或 `orgRole ∈ {owner, admin}`** ——
      `packages/manager/src/index.ts:1574-1579` 的 `mayReadPluginConfig(h: RouteHandlerContext): boolean`：
      `if (!p) return false`（拿不到主体 ⇒ 失败关闭）→ `if (p.kind === 'break-glass') return true` → `return p.orgRole === 'owner' || p.orgRole === 'admin'`。
      **为什么必须放宽**（源码注释 `:1564-1573` 的原话大意）：写下文档原文时（P1 阶段）**还没有真实角色** —— 角色的持久化位置 `org_members` 是 P2 才建的；
      现状下**若只认 break-glass，登录为 owner 的管理员也会拿不到 `config`，管理台的配置表单将无法回填**。
      **放宽不重新打开匿名泄漏**（匿名与普通成员的 `orgRole` 不是这两个值），故这是对原文的**有据收窄**。
      **⇒ 判据以 `mayReadPluginConfig` 为准；不要按字面只认 break-glass 去"修"它。**
    - **先纠正一处此前的错误认知**：曾怀疑 `GET /api/plugins` 的 `config` 会泄漏 **LLM API key 与数据库密码**。审查用**真实服务实测后推翻**：本项目有成文的**密钥纪律** —— `apiKeyEnv` / `passwordEnv` **只接受环境变量「名」**，填**密钥值本身**会导致插件**激活失败**（`packages/plugin-openai/src/index.ts:116-119` 的 `isEnvVarName` 白名单闸门；`packages/db-postgres/src/index.ts:126` 的 `assertEnvNameLooksLikeName('passwordEnv', …)`；测试 `packages/db-postgres/test/secret-discipline.test.ts`）⇒ **密钥值不会出现在响应里**。
    - **但存在一个真实的、更窄的通道**：`config` 是**原样回显运维填写的任意字符串字段**。审查实测：真实密钥 `sk-live-…` **未**泄漏，而 `baseUrl` 里内嵌的 `hunter2` **泄漏 1 次** ⇒ `baseUrl` 若写成 `https://user:pass@gateway/v1` 会被**逐字吐出**。附带泄漏：**环境变量名、模型名、内网端点拓扑**。**风险等级 Low–Medium。**
    - **交付物**：**路由层**的脱敏 —— 对**无资格主体**（判据见上方 ★ v8 订正）**去掉 `config` 字段**（或替换为公开子集）。
      **★ v8 落地记录**：实现里没有名叫 `redactConfig` 的函数，实际是两个路由层工具函数 ——
      `withoutPluginConfig(snapshot: PluginSnapshot): Omit<PluginSnapshot, 'config'>`（`packages/manager/src/index.ts:1582`，剥单个插件快照）
      与 `withoutListConfig(file: { enabled: readonly { name: string; config?: unknown }[] }): unknown`（`:1587`，剥 `enabled[].config`），
      配合判据函数 `mayReadPluginConfig`（`:1574`）。**⇒ 定位请以这三个名字为准，"`redactConfig`"在仓库里零命中。**
      **注意：P0 的 `GET /api/session` 是 `public`、`GET /api/plugins` 也仍是 `public`** ⇒ **这个回显通道当时是匿名可达的**（P0 的刻意取舍见 §2.5 ⑤）。
    - **必须同时覆盖两条路径（只改一条会漏）**：
      1. `GET /api/plugins`（`packages/manager/src/index.ts:1574`）；
      2. **`GET /api/session`**（`:1619`）—— 它经 `manager.sessionState()`（`packages/manager/src/index.ts:449-451`）返回 `PluginListFile.enabled[].config`，结构见同文件 `:129-136`。**审查明确警告："只改 `/api/plugins` 会漏掉第二条。"**
    - **不能改 `snapshotOf()`**（`packages/manager/src/index.ts:394-417`）：它被 `enable` / `replace` 的响应**复用**（`ok(h, { plugin: snapshot })`，`:1629`），在那里裁剪会把**管理台的配置表单一起打瞎**（表单读的正是这个 snapshot 里的 `config`）。**⇒ 裁剪必须做在路由层，不能做在快照函数里。**
    - **待排查项（标注清楚：不要当成已确认）**：`packages/manager/src/index.ts:413` 的 `error: p?.error ?? undefined` 是**插件激活失败的字符串**，**可能**含运维填入的连接信息。审查**未实测到泄漏** ⇒ 按"**待排查**"处理，先别写进交付范围。
    - **为什么不能更早做（P0 不做的理由）**：① P0 的契约是"**读端点行为与改动前逐字一致**"（§8.1 P0 行），且 **P0 不许改 `packages/web`** —— 裁剪 `config` 会改变管理台首屏的取数结果（配置表单依赖 snapshot 的 `config`），属**读路径改造**，必须与 §5 的读路径裁剪一起在 P2 做；② 现实约束：`GET /api/session` 在 P0 **刻意保持 `public`**（理由见 §2.5 ⑤ —— `AdminPage` 的 `Promise.all` 里**只有它没有 `.catch()`**）⇒ **收紧它时必须同时处理那个 `Promise.all`**，否则管理台首屏直接白屏。
    - **运维缓解建议（在修复之前）**：**不要把凭据内嵌进 `baseUrl`（或任何配置值）**，改用环境变量；`config` 里只写**变量名**。已经内嵌过的，按"**已泄漏**"处理（轮换凭据）。
15. **（★ v8 新增：补上"前端 IA"这一整类验收标准 —— 原文 1–14 条全是后端项）**：**这是一个明确的设计文档缺口**。P2 的前端信息架构工作（内部称 **M5**，分支 `feat/p2-m5-frontend-ia`）**在本文档里原本没有任何验收条目**，其规格来源是**实现者留下的 TODO**，而不是设计文档 ⇒ 交付时"做没做完"没有文档层面的判据。v8 把它补成可测条目（依据 = §6.6 的表格 + §2.1 的角色能力 + 本次实现反馈）：
    - **① 导航与入口由能力驱动，不由"是否登录"驱动**：`capabilities` 决定"新建页面 / 编辑 / 删除 / 版本恢复 / 管理 ▾ / 成员管理"等入口是否渲染；**未登录访客不得看到准管理员界面**（§0.1 ⑤ 的回归断言：`#/wiki` 无"新建页面"主按钮、详情页无"删除/编辑"、顶栏无"管理 ▾"直通）。
    - **② 降级与提升必须刷新入口**：登录 / 登出 / 角色变更后 `capabilities` 与 `pagesStore` 同步失效（★ **未完成项**：`capabilities` 目前只在 `loadAuth()` 写入，`denied`(403) 分支只跳转不刷新 ⇒ 提升后不重载看不到新入口、降级后旧入口留着；**这是外观层面的失败开放，服务端仍独立判定**）。
    - **③ `系统状态`（服务健康 / DB 方言 / 表清单）维持管理员专属**（★ v8 裁定，见 §6.6 的 ★ v8 小节）；`GET /api/health` **本身仍是公共端点**，看门狗不受影响。
    - **④ 红链三步态 `exists: false | true | 'hidden'`**：设计原文（§6.6、§5.5）要求保留三步态以区分"不存在"与"存在但不可见"。**★ 实情：`'hidden'` 这一步态在本批 M5 里仍未实现**（列为本阶段未做项，见 §13.6）。
    - **⑤ 守卫测试**：新 UI 必须过 `packages/web/test/navGate.test.ts` 与 `packages/web/test/navPlan.test.ts`（顶栏导航的真正守卫），以及 `contrastPlan.test.ts` / `designSystem.test.ts`（复用 `ui/*` 与 tokens、禁 px 字面量与裸色值）。**★ 注意**：原文 §9 R9 曾把 `navOrder.test.ts` 误列为"必然触碰"，**它其实与顶栏导航无关**（见 §9 R9 的 ★ v8 订正）。
    - **★ 未验证项（诚实标注）**：上述 ①–⑤ 是**回写时按设计与实现反馈整理的判据**，**本条不声称已逐条跑过**；其中 ② 与 ④ 是**已知未完成项**。真实浏览器交互**从未验证**（全部端到端都是 `curl`）。

**P3a**（★ v7：本阶段部分验收项**仅 SQLite 适用**）

> **★ v7 —— 本阶段验收项的方言适用范围（逐条已就地标注，**不要漏读**）**：P3a 的 FTS 部分**仅 SQLite 适用**。PG 部署下 `@geewiki/search` **显式拒绝激活**（理由见 §4.3 的「★ v7：方言语义」）⇒ 凡走 `GET /api/search` / `blocks_fts` / `pages_fts` 的验收项**在 PG 上无法执行、且不适用**（这是设计边界，不是待修缺陷）。**逐条清单**：
> - **仅 SQLite**：第 **3**（部分，见该条）、**4**、**6**、**9**、**11①** 条；
> - **LIKE 路 SQL 本身与方言无关，但端到端依赖 `@geewiki/search` 插件（PG 下不激活）⇒ 实际也只在 SQLite 下可执行**：第 **5**、**11②③④** 条；
> - **间接依赖 `search-service`**：第 **7**、**8** 条（RAG）；
> - **探针 SQL 方言无关、但报警端点归属待定**：第 **10** 条；
> - **两方言同样适用**：第 **1**、**2** 条。

1. `PUT /api/pages/:slug` 请求体**与 P2 完全一致**（无新字段）—— CodeMirror 零改造的证据（可用既有前端 e2e 断言请求体形状不变）。
2. 保存含 `<!--gated:org-->` 的正文后：`SELECT ordinal, visibility FROM blocks WHERE page_id=?` 的可见性分布正确；`pages.content_hash = sha256(content)` 校验通过。
3. **一致性探针**：`GET /api/admin/blocks/verify` 返回 `{ mismatched: 0 }`；`GET /api/admin/search/verify` 返回 `{ missing: 0, extra: 0 }`。
   **★ v7：本条部分仅 SQLite** —— `search/verify` 的 `{missing, extra}` 比对的是 `blocks` 与 `blocks_fts`（§4.3）⇒ **仅 SQLite 适用**（PG 下该虚表根本不存在）；`blocks/verify` 的 `{mismatched}`（`content_hash` / `tier` 一致性）不依赖 FTS ⇒ **两方言都适用**。
   **★ 待复核（本轮不臆断）**：§4.3 又把 `tier` 探针的"报警"也挂在 `GET /api/admin/search/verify` 上（§4.3 「代价（诚实列出）」第 4 条）—— 若该端点确实由 `@geewiki/search` 提供，则 PG 下**连 `tier` 探针的报警都没有落点**（"静默漏算"的告警会缺失）⇒ 实现前须把该端点（或至少 `tier` 探针）放到一个**方言无关**的位置。**另有一处顺序问题（v7 自检发现）**：§8.1 把这两个 verify 端点列在 **P4** 的交付项里，而本阶段的验收标准（本条）**现在就要用它们** ⇒ 要么把它们提前到 P3a，要么本条的验收标准在 P3a 内不可执行。
4. **匿名不泄漏（FTS 路）**：org 块的唯一词做匿名 `GET /api/search` ⇒ `total=0`；member ⇒ `total=1`（**实测形态已在 §4.3 验证**）。**★ v7：仅 SQLite 适用**（FTS 路 = FTS5；PG 下检索插件不激活）。
5. **匿名不泄漏（LIKE 路，★ v1 漏判的那条）**：用 **2 字元**中文词（trigram 缺口）重复上条 ⇒ 同样 `total=0`。**这一条必须单独测**，因为它走的是完全不同的 SQL。**★ v7：该 SQL 本身与方言无关，但整条端到端依赖 `@geewiki/search` 插件 ⇒ 实际也只在 SQLite 下可执行**（PG 下插件拒绝激活、`GET /api/search` 不存在）。
6. **改写不残留**：把 org 块文本从"A"改为"B"后，匿名搜"A" `total=0`、搜"B" `total=0`、member 搜"B" `total=1`（对应实测的"改写后旧词元不残留"）。**★ v7：仅 SQLite 适用**（"旧词元不残留"针对的正是 `blocks_fts` 的词元表 ⇒ FTS5 专有）。
7. **RAG 不泄漏**：匿名 `POST /api/ai/ask` 询问只有 org 块才有的信息 ⇒ 答案与 `sources` 均不含；`gatedCount` **不出现**在匿名响应里。**★ v7：间接仅 SQLite** —— 本条不写 FTS SQL，但 RAG 经 `search-service`（`packages/plugin-ai/src/index.ts:438`）取内容，而该服务在 PG 下不存在 ⇒ PG 上只能验证"检索不可用"，**验证不了"检索结果被过滤"**。
8. **RAG 分块边界**：构造 public 块紧邻 org 块且总长逼近 `perSourceChars` 的场景 ⇒ 匿名上下文**不含** org 文本的任何片段（**这是块级新增的泄漏面，必须专测**）。**★ v7：同第 7 条**（间接依赖 `search-service`）。
9. `pages_fts` 的旧触发器已 DROP（grep 断言），且 `pages` 的 UPDATE 不再写 `pages_fts`（性能断言：改可见性的 UPDATE 不放大索引写）。**★ v7：仅 SQLite 适用**（`pages_fts` 与它的三条触发器都是 FTS5 对象，PG 上从不创建）。
10. **（★ v4 新增，D15）`tier` 一致性探针**：`SELECT COUNT(*) FROM blocks WHERE tier IS NULL` **等于** `SELECT COUNT(*) FROM blocks WHERE visibility='granted'`（两个数不等 ⇒ 有块被漏算，`GET /api/admin/search/verify` 必须报警）；且**不存在** `DEFAULT 0` 造成的"匿名等级"漏算块（§3.6、§4.3）。
    **★ v7：探针 SQL 本身与方言无关**（两条都是 `blocks` 普通列上的 `COUNT(*)`），**但报警的落点是不是方言无关，取决于第 3 条那个待复核项**：若报警只挂在 `GET /api/admin/search/verify` 上，则 PG 部署下这条"把静默错误变成显式告警"的机制会**整体缺失**。**实现前须定该端点归属；本轮不臆断。**
11. **（★ v4 新增，D15）授权段落可检索（两条 SQL 都要测）**：把某块标成 `<!--gated:granted-->` 并授予用户 A ⇒ ① **A 用 FTS 路搜该块的唯一词 ⇒ 能命中**；② **A 用 2 字元中文短查询（LIKE 路）搜同样的词 ⇒ 同样命中**（★ 只改 FTS 路会漏掉这条）；③ **未授权用户 B（含匿名）在两条路上都 ⇒ `total=0`**；④ **A 搜一个未授权给他的 `granted` 块 ⇒ `total=0`**。这是"授权=放宽、且不牺牲召回"的核心回归测试。**★ v7：① 仅 SQLite 适用**（FTS 路）；**②③④ 的 LIKE 路 SQL 与方言无关，但整条依赖 `@geewiki/search` 插件 ⇒ 同样只在 SQLite 下可执行**（同第 5 条）。

**P3b**

1. **规则 B1**：`page.visibility='private'` + `block.visibility='public'` ⇒ 匿名对该块 404（不出现"部分可见"）；且保存时前端提示"实际可见性由页面决定"。
2. **规则 B2**：`page.visibility='org'` + `block.visibility='public'` + 匿名 ⇒ 该块 **404**（页面级仍决定存在性）。
3. **grant 放宽上限**：对 org 页面上的 `block.visibility='granted'` 块（★ v4 改词：原写作 `'private'`）授予某用户 `viewer` ⇒ 该用户可见该块；但**不能让该块对匿名可见**。**再补一条（★ v4）**：`page.visibility='public'` 页面上的 `granted` 块，**未授权者（含匿名）也看不到它** —— 证明"授权是放宽方向、`granted` 是收紧档"两件事同时成立。
4. **合并/删除已授权块** ⇒ 409 `block_merge_conflict` / `block_grant_orphan`（§4.2 表格逐行可测）。
5. **拆分已授权块** ⇒ 两块都继承授权（安全方向）。
6. **申请访问闭环**：匿名/无权用户申请 → 批准 → 无需重新登录即可见（★ v8 订正：原因是**判定层没有任何决策缓存**（`packages/plugin-authz` 每请求现查库），**不是**因为 `acl_revision` 触发了失效 —— 它只是版本标记与观测信号。**保留的禁令：一旦给判定层加 TTL 缓存，这条性质立刻失效。** 见 §13.6 第 11 条）。

**P3c**

1. **恢复正文 + 权限四位一体**：改块级权限 → 恢复旧版本 ⇒ `blocks.visibility`、`pages.visibility`、`published_at`、`inherit` **全部**回到该版本。
2. **★ 权限变更产生了新版本**：只改 `visibility` 不改正文 ⇒ `page_versions` 新增一行（`content` 不变、`acl_json` 变），可据此恢复回去。
3. **无权不可恢复**：构造一个版本（含 `private` 块），让只有 `canEdit` 无 `canManageVisibility` 的主体恢复 ⇒ 403 + `details.blockedOrdinals` 非空。
4. **老版本兼容**：`blocks_json IS NULL` 的版本恢复 ⇒ 只恢复 `content`，响应含 `warnings: ['block_acls_not_restored']`。
5. **大小上限**：`blocks_json` 超 1MB 的版本恢复 ⇒ 413。

**P3d**

1. "预览为匿名视角"开关下，org 块渲染为占位且**不渲染块内任何文本**（DOM 断言：受限唯一字符串在 `document.body.textContent` 中出现 0 次）。
2. 新 UI 通过 `packages/web/test/contrastPlan.test.ts` 与 `designSystem.test.ts`（复用 `ui/*` 与 tokens，**禁 px 字面量与裸色值**）。

**P4**

1. 每条 ACL 变更在 `audit_log` 有一行，含 `actor/action/target/before/after`，**`before_json`/`after_json` 不含正文**（断言 JSON 里无 `content` 键）。
2. `audit_log` 无 UPDATE/DELETE 代码路径（grep 断言）。
3. 过期 `page_grants` 到期后判定立即变化（无需人工清理即生效；清理任务只是回收）。**★ v3：这类到期清理（`page_grants.expires_at` / `invitations.expires_at`）保留**，与"权限版本保留策略"无关。
4. 越权尝试（匿名连续请求受限 slug 20 次）产生可查询的 `access.denied` 记录，且**不计入 `audit_log` 的权限变更视图**（两类分开）。
5. **（v2 新增）** 两个 verify 端点（`/api/admin/search/verify`、`/api/admin/blocks/verify`）均返回 0 不一致。
6. **（★ v3 新增，D11）** **权限版本不做清理**：代码中**无**删除 `page_versions` 行的路径（grep 断言）；只改 `visibility` 而产生的那一行（`content` 不变、`acl_json` 变）在任何时候都仍可查到并据此恢复回去。
   > **★★ v8 订正：本条按字面无法执行，实现已按真实意图落为"白名单 + 锚定"。**
   > - **为什么按字面写不行**：`deletePage` 本来就要删掉**被删页自己的**版本行 —— 那是**页面生命周期级联**，与 D11 反对的"**保留策略清理**"是**两回事**。
   >   **按字面写会让守卫与既有合法代码直接冲突，然后被人放宽 —— 那等于没有守卫。**
   > - **实际判据（`packages/plugin-authz/test/audit-appendonly.test.ts:121` 起）**：**只允许一处 `DELETE FROM page_versions`，且必须锚定在 `deletePage` 内**。
   >   扫描正则 `/\bDELETE\s+FROM\s+page_versions\b/i`（`:131`）；`hits.length >= 1` 作为**前置断言**（`:132`，防止"扫描范围写错导致恒为空"的假绿）；
   >   再断言**其所属函数名必须是 `deletePage`**（`:153-154`；锚定正则要求 `= async`，`:143-146` 说明了理由）。
   > - **⇒ 建议把文档本条也改成这个口径**（原文保留在上面以留痕）：**判据 = "白名单 + 锚定"，而不是"零处"**。新增任何一个 `DELETE FROM page_versions` 点都会让守卫变红，正是我们要的。

---

## 9. 风险与反模式清单

### R1 —— 改 `pages` 表要动 FTS 触发器与双方言迁移（v1 视为最高风险）
`pages_fts` 是 **external content** 表（`packages/plugin-search/migrations/0001_search.sql`：`content='pages', content_rowid='id'`），三条触发器 `pages_fts_ai/ad/au` 挂在 `pages` 上。给 `pages` 加列时：
- 任何 `UPDATE pages`（即便只改 `visibility`）都会触发 `pages_fts_au` 的 **delete + insert 两步**（该文件注释："两步缺一不可，否则旧词会残留"）→ 频繁改可见性会**放大索引写放大**。
- 迁移必须**双方言成对**，且两侧序号已不同步 ⇒ 建议统一从 `0010` 起编。
- PG 侧 `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` 在大表上有锁风险（本期数据量小，可接受，但要写进迁移注释）。
- **v2 缓解**：P2 不碰 FTS（§8.0 修正 1），风险从 P2 推迟并集中到 P3a 一个原子 PR。
- **★ v7 补充**：本条的"双方言成对"**不适用于 FTS 部分** —— `@geewiki/search` 的迁移是 FTS5 专有语法，**没有 PG 孪生文件**，靠"按方言声明迁移目录"在 PG 下跳过（§3.0 的 ★ v7 补充、§4.3 的「★ v7：方言语义」）。**R1 在 PG 部署下真正剩下的风险只有"给 `pages` 加列"本身**（触发器/索引那部分在 PG 上不存在）。

### R2 —— cordis 服务是全局单例 → 权限判定必须逐调用传 `principal`
`ctx.provide('wiki-service', svc)`（`packages/plugin-wiki/src/index.ts:726`）提供的是**进程级单例**，`WikiService.list()/get()/save()/remove()`（`:141-154`）**均无 principal 入参**。若只在路由层判定而服务方法签名不变，任何新消费者调 `svc.get(slug)` 都拿到**未裁剪**的数据。
- **缓解（三段式）**：(1) 服务方法**显式加 `principal` 参数**（编译期强制）；(2) 服务实现内部**再次**校验（纵深防御：路由层判一次、服务层判一次）；(3) 在 `AsyncLocalStorage`（`packages/server/src/index.ts:131` 已有 `requestScope`）里放 principal，服务实现发现 `principal === undefined` 时**抛错而非放行**（失败关闭）。
- **反模式**：`if (principal) { 过滤 }` —— 这会把"忘了传"变成"全量返回"。**必须**是 `if (!principal) throw`。
- **★ v6 交叉引用**：P0 落地的 `access` 闸门（**§2.5**）是**粗粒度**的 —— 它只保证"**不是匿名**"，**不能替代**本条的逐对象判定与服务层二次校验。闸门 + 逐调用 `principal` 是**两层纵深防御**，别用前者替代后者（实现内的原话："两者是纵深防御的两层，不是二选一"）。

### R3 —— `packages/core` 不能进浏览器包
`packages/core/src/index.ts` 顶层 `import 'node:fs'`。因此 `Principal`/`Capability`/`PageVisibility` 等类型若要前后端共用，**必须**在 `packages/web/src/lib/` 持镜像副本（先例：`PLUGIN_UI_PREFIX`、`SLOT_NAMES`，`packages/core/src/index.ts:376-381,630-640`），且**必须有源码级守卫测试**钉住两处一致（参照 `packages/web/test/pluginUiPlan.test.ts`）。
- **风险**：镜像副本漂移 → 前端认为"有权限"、后端认为"没权限"，表现为**神秘的 403**。
- **验证**：新增 `packages/web/test/capabilityMirror.test.ts`，读两侧源文件做字符串比对。

### R4 —— `owner` / `layer` 命名已被占用
- `owner`：插件生命周期（`SlotContribution.owner` `packages/core/src/index.ts:719-720`）、`trackStream(res, owner)`（`:591-611`）。本设计一律用 **`principal` / `actor` / `subject_kind`**。
- `layer`：插件清单层级 `base|session`。
- **风险**：一旦有人图省事写了 `page.owner` 或 `grant.layer`，会在 grep 时与插件生命周期混淆，无法区分"是条目所有者还是插件的 owner"。
- **验证**：grep 断言新增代码中不得出现 `owner:`/`layer:` 作为条目/权限字段。

### R5 —— 前端共享缓存 `pagesStore` 需按身份失效
`packages/web/src/lib/pagesStore.ts` 是**模块级全局缓存**（`:9-10,:14`：刻意不引 react-query，一次拉全量并共享），字段 `PageSummary`（`packages/web/src/api.ts:165-170`）/`PageDetail`（`:177-181`）**无 owner/visibility/角色字段**。
- **风险**：登录 → 拉全量 → 登出 → 缓存仍在 → 下一个身份（或匿名）看到**上一个身份的列表**。SSE 流若不中止会继续推送旧身份的内容。
- **缓解**：`login()`/`logout()`/角色变更/`acl_revision` 变化 ⇒ **必须** `invalidatePages()`（`:97`）；SSE 用 `AbortController` 主动中止；`api.ts` 的 401 拦截里**先清 store 再跳转**。
  > **★ v8 订正**：上面列举的触发条件里，**`acl_revision` 变化这一条在实现中不存在**（前端全仓**没有任何** `acl_revision` 引用，服务端也不下发它给列表接口）⇒ 前端的 `pagesStore` **不会**因权限变更自动失效。实际落地的触发点是**显式失效**：`login()` / `logout()`（`packages/web/src/lib/authStore.ts:168` 一带）与**写操作之后**（保存 / 删除 / 恢复版本，`packages/web/src/pages/WikiPage.tsx:846, :871, :1439`）、以及 `packages/web/src/lib/pagesStore.ts:128`。**⇒ 这条缓解仍然必须保留**（`login`/`logout` 后不清缓存就是"下一个身份看到上一个身份的列表"），但**不要指望 `acl_revision` 帮你失效**。

### R6 —— SSE 与静态资源路径的鉴权覆盖
- SSE（`packages/plugin-ai/src/index.ts:913`）走**裸 fetch**（`packages/web/src/api.ts:341-350`）→ 不加 `credentials` 就是**永远匿名**（且静默，不报错）。
- `trackStream(res, owner)` 的 `owner` 是**插件名**（`packages/core/src/index.ts:591-611`），**不是鉴权**。
- `serveStatic`（`packages/server/src/index.ts:634-680`）在 `dispatch` **返回 false** 时才接手（`:768-771`）→ 静态资源**完全绕过**任何 API 层钩子。若门户渲染分支走错地方（放在 `serveStatic` 之后），会出现"**服务端渲染了受限内容、`Cache-Control` 却是公开缓存**"的致命组合。
- **缓解**：门户渲染分支必须**在 `serveStatic` 之前**、且 `Cache-Control` 由 principal 决定。
- **★ v6 交叉引用（这条边界已写成正式契约）**：P0 注册的 `use()` 钩子链**只对"匹配到的路由"生效** ⇒ 静态资源与 SPA fallback **永远不过钩子**，`/api/*` 未匹配路径走路由自己的 **API 404**、也不进钩子链（见 **§2.5.2 边界一**）。⇒ "**注册了会话钩子**"**不等于**"**静态层已被鉴权**"。本节的门户渲染分支仍然**必须**在 `serveStatic` 之前，这一点不因 P0 引入了钩子而有任何放松。

### R7 —— 路由与 slug 保留段的双重约束
- 后端 `RESERVED_FIRST_SEGMENTS = search|ask|new|list`（`packages/plugin-wiki/src/index.ts:242-298`）。
- 前端 `packages/web/src/lib/wikiRoute.ts:23,49-66` 是**同白名单的镜像**，`packages/web/test/wikiRoute.test.ts` 钉住一致性。
- 门户路径 `/portal` 是**服务端真实路径**，不进 hash 路由白名单；但**上线前必须确认 `portal` 不是任何现有 slug 的首段**（查 `SELECT slug FROM pages WHERE slug LIKE 'portal/%'`）。若冲突，改用 `/pub/*` 或 `/s/*`（Outline 用 `/s/`）。
- **风险**：门户路由与既有 slug 抢路径 → 某些页面**永远打不开**。

### R8 —— PG / SQLite 方言差异的既知坑
- `COUNT(*)` 在 PG 返回字符串 ⇒ **必须 `Number()` 强转**（`packages/plugin-wiki/src/index.ts:419-422` 已有先例）。
- **事务内必须用传入的 `tx`**（`packages/core/src/index.ts:242-251`）：PG 连接池下用适配器自身方法会静默失效。会话创建、邀请接受、grant 变更都是多表事务。
- `BOOLEAN`（PG）vs `INTEGER 0/1`（SQLite）：`pages.inherit` 建议**统一用 `TEXT 'true'/'false'`** 或在适配层收敛，**不要**在业务 SQL 里写 `WHERE inherit = 1`。
- `INSERT ... RETURNING id`：SQLite 与 PG 行为不同 → 统一用 `RunResult.lastInsertRowid`（`packages/core/src/index.ts:170-178`）。

### R9 —— 现有前端守卫测试的连锁改动
26 个测试文件 314 例（`packages/web/test/`）。P2 必然触碰：`contrastPlan.test.ts`（新增 403/占位/锁图标需过对比度）、`designSystem.test.ts`（新页面必须复用 `ui/*` 与 tokens）、~~`navOrder.test.ts`（导航合并）~~、`errorText.test.ts`（新增 kind）、`pageMeta.test.ts`、`wikiRoute.test.ts`。
> **★ v8 订正：`navOrder.test.ts` 不属于"必然触碰"（原文写错了）**。该文件测的是 **`packages/web/src/lib/navTree.ts` 的"上一篇 / 下一篇"顺序**（`packages/web/test/navOrder.test.ts:11` 的 import 即 `buildNavTree, flattenPages, neighborsOf`；用例名如"`neighborsOf：第一项无上一篇、最后一项无下一篇`"），**与顶栏导航没有任何关系**。审查用 `git diff --stat` 证明它在 P2 的改动里**diff 长度 0 行**。
> **顶栏导航真正的守卫是** `packages/web/test/navGate.test.ts` 与 `packages/web/test/navPlan.test.ts`（另见 `navTree.test.ts`）。**⇒ 原文那一项应从"必然触碰"名单里划掉；要盯的是 `navGate` / `navPlan` 两个文件。**
- **缓解**：P2 拆两个 PR —— **PR-A：纯后端（判定 + 迁移 + 读路径）**，无前端改动，可独立验收；**PR-B：前端 IA**。这样后端的安全价值能先落地，前端测试的连锁改动被隔离在一个 PR 里。

### R10 —— 授权反模式（本项目具体化的"绝不要做"清单）

1. **靠不可猜测的 slug 当权限**（CWE-639）：slug 是用户可读可猜的，**永远不能**作为访问控制依据。
2. **搜索"先取全量再后过滤"**：`total`/`highlight`/`score`/分页语义全部泄漏。必须在 SQL 层就 `WHERE ... IN (...)`。
3. **权限缓存设 TTL 而不做变更失效**：必然出现"撤销后仍可见"的窗口。用 `acl_revision`。
   > **★ v8 订正（这条反模式的判断不变，但"解法"写错了）**：本项目**根本没有决策缓存** —— `packages/plugin-authz` **每请求现查库**，全仓**没有任何代码读 `acl_revision`**（§13.6 第 11 条）。所以"撤销后仍可见"这个窗口在本项目里**不存在**，也**不需要**靠 `acl_revision` 去消除。
   > **★ 真正要守的禁令是它反面那一句：不要给判定层加 TTL 缓存。** 一旦有人为了性能在判定层加缓存，"撤销后仍可见"会立刻复活，而那时 `acl_revision` **帮不上忙**（没有失效机制）。原文里"用 `acl_revision`"属于**过度声明**，保留在此仅作留痕。
4. **只校验父与子各自的权限、不校验隶属关系**：Outline 的 [GHSA-rg4j-pmch-w6pm](https://github.com/outline/outline/security/advisories/GHSA-rg4j-pmch-w6pm)（CVE-2026-43889，*"Unauthorized Document Publication via Mixed collectionId+documentId Share"*）正是这个形态。在本设计里对应"移动条目"与"跨 slug 前缀的 grant"两条路径。**★ v3 注**：角色退出授权对象后，这条反模式的**组合维度少了一层**（不再有"父页按角色授权、子块按角色授权不同"的交叉）⇒ 剩余真正要盯的只有"**跨 slug 前缀的 grant**"这一条路径。
5. **前端校验当判定**：前端隐藏按钮**只是体验**，判定一律在服务端。
6. **把 `noindex`/`robots.txt` 当访问控制**：它们只做 SEO 去重。
7. **给 `owner`/`layer` 起新语义**（R4）。
8. **用"唯一 ID 猜不到"替代权限**：OWASP 明确说"generally not sufficient by itself"（CWE-639）。
9. **把"角色"当授权对象**（★ v3 新增）：`page_grants` / `block_grants` 的 `subject_kind` **只允许 `user|group`**。一旦允许 `org_role`，就会生出"页面给 `viewer`、页面里某个块给 `member`"这类**无法解释的交叉规则**（用户只会问"我到底能看还是不能看"），并且反向排查"谁能看这条"要多考虑一层角色继承。
   **正确形态**：可见范围只有三个来源 —— 可见性档位（页面 `public`/`org`/`private`，块 `public`/`org`/`granted`）+ `user`/`group` 授权 + `owner`/`admin` 应急覆盖（§2.0）。角色只决定能力。D12 已因此**作废**（§10.4）。
   **★ v4 补**：这条反模式**也包括"把角色/能力当可见性档位"** —— v3 的 `editors`（块级 `private` 被写成"仅 editor 及以上"）与 v4 的 `granted` 就是同一个问题的**两次修正**：第一次是把角色从**授权对象**位置摘掉（D13），第二次是把角色从**可见性档位**位置摘掉（D15）。**一句话原则：`visibility` 的每一档都只能描述"默认给谁看"，不能描述"谁有能力"。**

### R11 —— 块身份漂移：编辑一次就丢块级授权（v2 新增）
**风险**：若块身份只用 `ordinal`，在文档开头插入一个段落就会让**所有** ordinal 后移 ⇒ 所有块级 grant 指向错误的块（**静默错配，比丢失更危险**）。
**缓解**：§4.2 的保守重解析规则（按 `kind` 序列对齐 + `content_hash` 检测 + 合并/删除已授权块时拒绝保存 409）。
**验证**：专门的"编辑保权"测试矩阵（插入/删除/移动/拆分/合并 × 有授权/无授权）。
**残余风险**：一次大范围重排（如把整篇文档从"先结论后细节"改成"先细节后结论"）会触发多轮拒绝保存 —— **这是刻意的**（让用户显式确认），但必须在 UI 文案上讲清楚"为什么保存被拒绝"，否则会被当成 bug。

### R12 —— FTS 与 `blocks` 的同步不再由触发器保证（v2 新增）
**风险**：`blocks_fts` 是 contentless 表，其同步是**应用层职责**（因为涉及 tier 重算）。任何"绕过 `savePage()` 直接改 `blocks` 的代码路径"（如 P3c 的恢复、P4 的清理任务、将来的批量导入）都会造成索引漂移。
> **★ v3 注**：D11 改为永久保留后，P4 的清理任务**只剩授权/邀请到期清理**（`page_grants.expires_at` / `invitations.expires_at`），**不再有版本清理**。上面这个例子因此只对"将来的块级清理任务或批量导入"有意义 —— 举例本身保留不改，因为"绕过 `savePage()` 写 `blocks`"这条约束与清理策略无关。
**缓解**：① **所有块写入必须收敛到 `blocksWriters` 单一模块**（grep 断言：除该模块外无 `INSERT INTO blocks`）；② 强制 `GET /api/admin/search/verify` 探针 + 启动自检；③ 自检发现不一致时**显式告警**（而不是静默返回错误结果）。
> **这是 R1 的形态变化**：风险从"迁移期触发器变更"变成"运行期应用层同步" —— **长期风险更高**，因为它在每次写入时都存在。

### R13 —— 块级 tier 重算的扇出（v2 新增；★ v8 显著加强：**它是跨阶段不变量**，见 §4.6）
`blocks.tier = max(pageEffectiveVisibility, block.visibility)`（★ v8 订正：原写 `min`，方向反了 —— 理由见 §2.3 规则 B1）。**页面祖先可见性一变，该页及其全部子孙的块 `tier` 都要重算**；若一次变更影响 N 个页面（如把某祖先目录设为 `private`），会触发 N×M 次 `blocks.tier` 更新 + `blocks_fts` 的 delete/insert。
> **★ v4**：档位序为 `public(0) < org(1) < granted(2)`，重算的**写入值**是"有效档位为 `public`/`org` ⇒ 写 `0`/`1`；**有效档位为 `granted` ⇒ 写 `NULL`**"（§4.3）。注意 `max()` 比较的是**档位序**（3 值域；★ v8：该刻度是"越窄数值越大"，故取更窄的一方是 `max`），而**落到列上**时 `granted` 折成 `NULL` —— 两件事不要混：**判定用档位序，索引列用 `0/1/NULL`**。
> **★★ v8：这条风险已经"实际发生过三次"，不再是理论风险** —— 三次都由审查**端到端复现**（匿名 `/api/search` 返回了本该受限的唯一词），根因、提交号与修法见 **§4.6**。缺扇出的后果**不是**"索引陈旧"这种可用性问题，而是**内容泄漏**（读路径 404、检索却命中并吐出正文片段）。
**缓解**：① 祖先变更时**批量重算**（不要逐页开事务）—— ★ v8 订正：**不能把扇出塞进"写档位"的那个事务**，必须在**该事务提交之后**跑，理由见 §4.6（`pageLevelOf` 走另一条连接、PG 的 MVCC 下看不到未提交的行）；② `tier` **惰性重算**（`blocks.tier` 只作为**索引用的物化**，判定一律走 §2.4 的单点函数）—— ★ v8 订正：原文说"由 `acl_revision` 失效后异步重建"，**该因果不成立**，见下条；③ 在 `acl_revision` 上做**代际标记**，避免重复重算同一页 —— **★ v8 订正：这条"代际标记"从未实现、也不必实现，因为根本没有缓存需要失效**（全仓**没有任何代码读 `acl_revision` 来做判定**；`packages/plugin-authz` 没有决策缓存，每请求现查库）。**保留此句只为留痕；真正要守的禁令是"不要给判定层加 TTL 缓存"**（§4.5、§9 R10 第 3 条）。
**验证**：把 8 层深的祖先链设为 private ⇒ 断言子树下所有页面的块 `tier` 全部更新且 `blocks_fts` 命中数对 anon 归零。**★ v8 补**：仅测"改档位"这一条路径**不够** —— 必须同时覆盖**新建祖先**、**删除断链点（`inherit=false`）**、**版本恢复**三条路径，否则会出现"脚本绿着而泄漏仍在"（§4.6）。

### R14 —— 语义检索（向量）被块级权限反噬（v2 新增，未来风险）
`packages/plugin-ai` 现在只有"检索-only"形态。**若将来引入 embedding / 向量库**：向量是按块计算的，而块级权限是**逐主体**的 ⇒ "同一个块对不同主体不同可见性"会让**向量库无法做静态可见性标注**。
**缓解（写进架构决策，避免将来踩）**：① **向量入库前必须过与 FTS 相同的 tier 投影**（即"入库的是投影，不是原文"）；② 检索结果**必须**再过一次 `policy-service`（纵深防御）；③ 明确记录：**"不引入按主体的向量副本"**（成本不可接受），因此**向量层的召回损失是接受项** —— 这条与 FTS 的 tier 方案（无召回损失）会形成**能力不对等**，需在文档里说明。

### R15 —— `blocks` 引入后的"正文真源"二元性（v2 新增）
`pages.content`（Markdown 原文）与 `blocks`（结构化）是**同一事实的两种表示**，存在漂移可能（解析器升级、bug、直接改库）。
**缓解**：① `content_hash` 探针（§3.6）；② **解析器版本号入库**（`blocks.parser_version`，或复用 `content_hash` 的算法前缀）—— 解析器升级后可用它识别"哪些块的表示是旧版本解析结果"；③ 明确**唯一写入路径**（R12 的 `blocksWriters`）；④ **文档层面**：`docs/architecture.md` 必须写清"`pages.content` 是作者源快照、`blocks` 是结构化真源、两者同事务双写"，否则下一位维护者会问"到底哪个是真的"。

### R16 —— `page_versions` 无上界增长（★ v3 新增，D11 的直接后果）

**风险**：D11 已拍板**权限版本永久保留**（§10.4），而 §4.4 的硬规则是"**任何** `visibility` / `published_at` / `inherit` / `block.visibility` / grant 的变更都必须产生一条新的 `page_versions`"。两条合起来的后果是：**每一次权限微调都永久占一行**，且该行携带一份 `blocks_json`（可能数十 KB）。

**具体到单篇文档**：若某篇大文档被反复调整可见性（例如一整节内容在 `org`/`private` 之间来回切换，或在块级治理面板上逐个块试可见性），**该文档的版本表增长速度会明显快于它的正文变更速度** —— 正文可能几个月没动，版本行却一直在涨。

**用户判断（决定三的依据）**："*实际使用中不会很频繁*" —— 即权限变更的**日常频率低**，因此**接受**这个代价，**不动保留策略**。

**缓解方向（前提是不动保留策略）**：将来可考虑"**仅当块集合真正变化时才写 `blocks_json`，权限单独变化时只写 `acl_json`**"（省掉同一行里那份可能数十 KB 的 JSON 副本）。
**但必须注意**：这条缓解**需要额外的区分手段** —— 现有语义里 `blocks_json IS NULL` 表示"**该版本早于块级功能**"（§4.4 的老版本恢复语义），**不能复用**来表示"这是权限版本、块集合未变"。实现前需**重新设计**一个字段或判据（例如给 `page_versions` 加一列，或在应用层按 `content` 与上一版本比较）。**本文不替你定，只记录方向。**

**验证**：不必专门写测试（这是**接受项**）；但建议加一条**运维探针**：按页统计"版本行数 / `blocks_json` 总字节数"，取前 N 名进管理台 —— 用来观察"是否真的不频繁"，也为将来重新评估留数据。

---

## 10. 决策清单（★ v5：已全部拍板，无待决项）

### 10.1 已拍板（十二项，本设计按此执行，不再讨论）

| # | 决策 | 对本设计的影响 |
|---|---|---|
| **D1** | **单组织**，数据模型预留 `org_id` | 与 v1 一致；`org_id` 恒 1，表结构带列 |
| **D2** | **本地账号密码 + OIDC 两者都要** | **推翻 v1**；新增 P1.5；`user_identities` + `email_verified` **提前到 P1 建表**；见 §7 |
| **D3** | **完整块级内容模型**（每块独立权限与版本） | **推翻 v1**；§4 整节；P3 裂解为 P3a–P3d；v1 §6 的"推荐 A 方案（内联标记 + 服务端投影，不做 blocks 表）"作废 |
| **D4** | **门户存在但不许搜索引擎收录** | **推翻 v1**；§5.10 / §6 翻转；门户路径改 `/portal`；sitemap 定位改为运维核对工具 |
| **D7** | **保留 `GEEWIKI_ADMIN_TOKEN`（break-glass 应急通道），但生产默认关闭**：**环境变量未设置即禁用**；每次使用写审计（actor 记为 break-glass 来源） | ★ **v5 拍板（原为 §10.3 的待表态项）**；§8.1 P0 补落地方式、§8.2 P0 补"未设置环境变量 ⇒ 令牌通道完全不可用"断言。推荐理由：应急通道**必须有**（否则 P1 出问题就锁死全站），但长期开启等于绕过整个权限体系 |
| **D8** | **存量条目默认可见性：P2 上线时一次性回填为 `org`（组织内可见）**；`public` 仍必须由管理员**显式发布**（`published_at` 独立开关），**不会被批量设置** | ★ **v5 拍板（原为 §10.3 的待表态项）**；§8.1 P2 新增**迁移/回填步骤**、§8.2 P2 新增断言。推荐理由：避免升级当天全站条目瞬间"消失"引发恐慌。**注意这是"上线动作"，不是 DDL 默认值**（两者关系见 §3.3） |
| **D9** | **搜索密级 2 档**（匿名 / 组织成员）—— **不给"登录了但没有组织角色的人"（guest）单开一档** | ★ **v5 拍板**；§10.4 D9 的两个选项与后果分析**保留**（那是决策依据）。推荐理由：单组织下 guest 的块级可见性是边缘情形，且 guest 仍可通过 `user`/`group` 授权获得访问；2 档还保住"同一张索引表 ⇒ `rank` 可跨行比较 ⇒ 一条 SQL 正确排序"的技术硬好处 |
| **D10** | **索引全密级收录（`tier ≤ 1`，匿名 + 组织成员）**；"**只索引匿名层（`tier = 0`）**"保留为**运维开关，不是默认** | ★ **v5 拍板**；§4.3 已就地标注该开关的**非默认**属性与"与『授权段落可搜』互斥"。推荐理由：这是本方案相对 v1 的**核心收益** —— 同时达成安全目标并消除登录用户的召回损失；索引体积的真实倍数需先在自有语料上实测再决定是否收紧开关 |
| **D11** | **权限版本永久保留**（取消"最多 50 条或 90 天"的清理策略；正文版本与权限版本一视同仁） | ★ **v3 升级为已拍板（决定三）**；§4.4 删掉保留策略、§8.1 的 P4 删掉权限版本清理（**授权/邀请到期清理保留**）、§8.2 P4 新增第 6 条断言；§12 第 7 条的"标记列"标注**已消解**；新增风险 **R16**（无上界增长）。依据：用户"*D11 权限改动记录永久保留就好，实际使用中不会很频繁*" |
| **D13** | **授权对象只有 `user` / `group`（把"角色"从授权对象里彻底摘掉）** | ★ **v3 新增（决定一）**；**推翻 v2** 的 `page_grants.subject_kind = user\|group\|org_role`；页面级与块级**完全同构**（§2.0 新增、§2.1、§2.3、§2.4、§3.3、§3.7）；**D12 随之作废**（§10.4）；§9 R10 新增第 9 条。依据：用户评审"又是角色又是组的，理论上就分公开、授权给个人、授权给团队就可以了" |
| **D14** | **`owner`/`admin` 保留"能看所有私有内容"的应急权，且每次覆盖式访问写审计** | ★ **v3 新增（决定二）**；写成**显式规则**（§2.3 规则 O1），**不是"默认放行"**；审计建议 `action='access.admin_override'`。依据：合规、离职交接、误设私有需要救回 —— **不保留则内容可能永久取不回来** |
| **D15** | **块级第三档由"仅编辑者"改为"仅授权"**：`block.visibility ∈ public\|org\|granted`（`granted` = 默认谁都不能看，靠 `block_grants` 放人）；**"编辑者"概念从块级彻底删除** | ★ **v4 新增（决定四）**；§2.2 三档语义重写、§2.3 档位序 `public(0)<org(1)<granted(2)`、§4.1 标记 `role=editor` → `granted`、§3.6 DDL + `tier` 取值域收敛为 `{0,1}`（`granted` 写 `NULL`）、**§4.3 检索改形为"等级分支 OR 授权分支"**、§3.7 补 `idx_block_grants_subject`、§5.6 两条 SQL 同步、§9 R10 第 9 条加注、§12 第 15 条**标注已解决**。依据：见 §13.2 |

### 10.2 已被 v2 实质处理、无需再拍板的两项

| # | v1 的问题 | v2 的处理 |
|---|---|---|
| **D5** | FTS 索引存原文还是公开投影 | 被 §4.3 的 **tier 方案**取代：索引里只放 contentless 的词元 + `blocks.tier` 过滤，既安全又**无登录用户召回损失**。退路（只索引匿名层）降级为**运维开关**（★ v5 D10 确认：**非默认**） |
| **D6** | "无权条目"在正文链接里怎么表现 | 块级下"部分可见"是一等公民 ⇒ **必须**区分三态（`exists: false \| true \| 'hidden'`，§5.5）；v1 的"P2 灰锁 → P3 再收紧"路径不变 |

### 10.3 ★ v5：已全部拍板（原「沿用 v1 推荐、但你还没表态的两项」—— 保留作决策留痕）

> **这一节现在没有待表态项了，但故意不删**：下面两条是**决策留痕**（v1 的推荐原文 + 当时"视为待定"的理由），用户已在 **v5 定稿**时按推荐值拍板 ⇒ 正式条目见 **§10.1 的 D7 / D8**。保留原表是为了让后人看到"这两条曾经悬空过、以及当时的取舍理由"。

| # | 问题 | v1 推荐 | 状态 |
|---|---|---|---|
| **D7** | Break-glass token 是否长期保留 | **保留但生产默认关闭**（`GEEWIKI_ADMIN_TOKEN` 未设置即禁用），且**所有使用记录进审计**。应急通道必须有（否则 P1 出问题就锁死全站），但长期开启等于绕过整个权限体系 | ★ **v5 已拍板**：**按推荐值采纳** ⇒ 见 **§10.1 D7**、§8.1 P0、§8.2 P0 |
| **D8** | 现有可读 wiki 的存量条目默认可见性 | **P2 上线时一次性设为 `org` 可见**（而非 `private`）。目的是避免升级当天全站条目瞬间"消失"引发恐慌。`public` 必须由管理员**显式发布**，不会被批量设置 | ★ **v5 已拍板**：**按推荐值采纳** ⇒ 见 **§10.1 D8**、§8.1 P2、§8.2 P2、§3.3（与 DDL 默认值的关系） |

---

### 10.4 ★ 决策详解：D9 / D10（★ v5 已拍板）+ D11（已拍板）+ D12（已作废）

> **D9 与 D10 已在 v5 定稿时按推荐值拍板**（正式条目见 §10.1）。下面每一项先用生活化的类比讲清楚"到底在纠结什么"，再给选项与后果 —— **这些选项与后果分析是决策依据，全部保留、不删**；每项末尾另加"★ v5 采纳入结论"说明最终选了哪个、为什么。
> **D11 与 D12 都已经有结论了**：D11 = **已拍板（决定三：永久保留）**；D12 = **已作废**（决定一，即 §10.1 的 D13）。两者都保留在下面**只为留痕** —— D11 的"为什么改权限必须产生版本"那段解释**仍然成立且重要**，D12 的原文则**不要照着实现**。

#### D9 —— 检索密级分几档？2 档还是 3 档？【★ v5 已拍板：**2 档**】

**【问题】** 全文检索的索引要按"读者等级"分几层？具体说：**是分成"匿名 / 组织成员"两档，还是要额外给"登录了但没有组织角色的人"单开一档（匿名 / 访客 / 组织成员）？**

**【为什么会有这个问题】** 打个比方：搜索索引就像图书馆的**目录卡片柜**。不同读者能看的书不一样，所以卡片柜得按"读者等级"分层——这样匿名读者去查目录时，根本翻不到内部资料的卡片。

我们给每个内容块打一个**密级数字 `tier`**：`0` = 任何人都能看、`1` = 组织成员能看、`2` = 只有编辑者能看。检索时用"你的等级"去过滤。
> **★ v4 注**：上面这句里的 `2 = 只有编辑者能看` **已经作废**（D15）—— 第三档改为 `granted`（"仅授权"），而且它**不是读者等级**，因此**不占 tier 档位**（`tier` 只留 `0`/`1`，见 §4.3）。**D9 问的"读者等级分几档"与它无关**（问的是"登录了但没有组织角色的人算不算单独一档"），选项与结论都不受影响。

问题在于：**"登录了、但没有任何组织角色"的人（我们叫他 guest / 访客）到底算几级？** 他显然不该和匿名一样（他登录了），但也不该和组织正式成员一样（他没有角色）。

**【选项 A：2 档（匿名 / 组织成员）】** guest 与匿名看到的一样多。

- **后果**：实现简单，而且有一个**技术上的硬好处**——所有索引行都在**同一张索引表**里，搜索引擎给出的"相关度分数"（`rank`）是**可以互相比较**的，所以"按相关度排序"一条 SQL 就正确完成。
- **代价**：guest 登录了却不多看到任何东西，体验上有点奇怪。

**【选项 B：3 档（匿名 / 访客 / 组织成员）】** guest 单独一层。

- **后果**：表达更精确。
- **代价**：不同档位是**不同的索引行**，它们的相关度分数**跨档不可比**（分数是在各自那一层里算出来的）。要做到正确排序，必须"**每一档分别查询，再在应用层把结果合并重新排序**"——查询次数、延迟、代码复杂度都上升。

**【推荐：2 档】← ★ v5 采纳**

- **理由**：在**单组织**场景下，guest 的块级可见性是**边缘情形**；而且 guest 本来就可以通过 `page_grants`（单独授权）或"只读层级"获得访问，不必靠 tier 实现。
  > **★ v3 措辞澄清**：这里的"只读层级"**不是**一个角色档位 —— 在 §2.0 的统一模型里，guest 的访问只有三个来源：`public`/`org` 可见性、`user`/`group` 授权、以及（对 `owner`/`admin` 的）应急覆盖。原文保留不改，但**不要**据此设计出一个"guest 角色档"。
- **退路（重要）**：将来若 guest 场景变成主线，**再加一档的代价很小** —— 因为 `tier` 是 `blocks` 表上的**冗余列**，加档只影响这一列的取值域和重算逻辑，**不需要改 FTS 表结构**。（这正是当初选择"把 tier 放在 `blocks` 上而不是放进 FTS 表"的额外收益；后者已被实测证明会静默失效，见 §4.3。）
- **★ v5 采纳结论（决策依据保留在上，结论如下）**：**采纳选项 A（2 档：匿名 / 组织成员）**，guest 与匿名看到的一样多。① 依据就是上面那条推荐理由；② 还额外拿到一个**技术硬好处** —— 所有索引行在**同一张索引表**里，`rank` 可跨行比较，排序一条 SQL 完成（选项 B 需要"每档分别查 + 应用层合并重排"）；③ 代价（"guest 登录了却不多看到东西"）被判定为**可接受**；④ 退路保留：将来若 guest 成为主线，**加第三档的代价很小**（只动 `blocks.tier` 的取值域，不改 FTS 表结构）。
  > **与 v4/D15 的关系（别误读）**：这里说的"档"是**读者等级**（`tier`），不是块级可见性档。D15 让 `granted` 档**不占 tier 档位**，所以"D9 选 2 档"仍然成立 ⇒ **`tier` 的最终取值域就是 `{0, 1}`**（§4.3）。

#### D10 —— 索引里放哪些密级的内容？【★ v5 已拍板：**全密级收录（`tier ≤ 1`）**】

**【问题】** 建索引的时候，把**哪些等级**的内容写进索引：**全部（匿名 + 组织成员）**，还是**只写匿名层**？

**【为什么会有这个问题】** 还是图书馆的比方：**内部资料要不要也做目录卡片？**

- 做了，馆员能查到内部资料，但卡片柜变大了；
- 不做，卡片柜最小，可馆员也查不到内部资料——只能靠记忆去书架上翻。

技术和安全上，这两者是**对立**的：索引越多内容，体积越大；索引越少，能搜到的越少。

**【选项 A：只索引匿名层（`tier=0`）】**

- **后果**：索引最小、最安全——**索引里根本没有受限内容**，就算过滤代码写漏了也不会泄漏。
- **代价**：**组织成员登录后搜不到受限内容**：搜索体验明显退化（"我明明记得文档里有这句话，但搜不出来"）。这正是 v1 最早的 D5 取舍。

**【选项 B：全索引（`tier ≤ 1`，匿名 + 组织成员）】**

- **后果**：匿名搜不到受限内容（靠 tier 过滤，**已实测正确**）；组织成员能搜到全部该看的，**没有召回损失**。
- **代价**：索引体积变大。**实测说明**：contentless 形态下不额外存正文，只有索引本身；既有 `0001_search.sql` 的注释给出参照 —— "5000 行 / 6.6MB 语料增约 7.9MB"（即 trigram 索引约 **1.2× 语料**）。另外需要 **SQLite ≥ 3.43**（`contentless_delete=1` 的要求）。

**【推荐：全索引（`tier ≤ 1`），并把"只索引匿名层"作为运维开关】← ★ v5 采纳**

- **理由**：这正是本方案相对 v1 的**核心收益**——同时达成安全目标并消除登录用户的召回损失。
- **但有一个前提**：**索引体积的真实倍数需要在你自己的语料上实测**再决定是否收紧开关。测量方法已在 §4.3 给出：`SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'blocks_fts%'` 对比 `SELECT SUM(length(text)) FROM blocks`。
- **★ v5 采纳结论**：**采纳选项 B（全密级收录 `tier ≤ 1`）**，"只索引匿名层（`tier = 0`）"作为**运维开关保留、但不是默认值**（§4.3 已就地标注）。
  ① 收益：匿名搜不到受限内容（靠 tier 过滤，已实测正确），而组织成员**没有召回损失**；
  ② 代价与前提：索引体积会变大（contentless 形态不额外存正文，参照既有 `0001_search.sql` 注释"5000 行 / 6.6MB 语料增约 7.9MB"≈ 1.2× 语料；**真实倍数需在自有语料上实测**），且需要 **SQLite ≥ 3.43**（`contentless_delete=1`）；
  ③ **该开关不与安全矛盾，只与召回矛盾**：开启它等于回到 v1 D5 的取舍。**★ 并且它与 v4 的"授权段落可搜"互斥**（`granted` 块也不在索引里了），详见 §4.3 取舍表下的 v4 注。

#### D11 —— "权限改动"的记录留多久？【★ 已拍板（v3，决定三）：**永久保留**】

> **★ v3 结论：采纳选项 A（永久保留）；选项 B（最多 50 条或 90 天）作废。**
>
> - **用户原话**："*D11 权限改动记录永久保留就好，实际使用中不会很频繁*"。
> - 即：**取消一切"权限版本清理"策略**，`page_versions` **全量永久保留** —— 正文版本与权限版本**一视同仁**。
> - **连带影响**：§4.4 删掉保留策略表述；§8.1 的 P4 范围删掉"权限版本过期清理"（**`page_grants.expires_at` / `invitations.expires_at` 的到期清理照旧保留** —— 那是外部协作者授权过期，与版本保留策略无关）；§4.4 的"区分版本类型的标记列"标注为**已消解**（§12 第 7 条）；新增风险 **R16**（`page_versions` 无上界增长）。
> - 注意：本项**不是**"v2 推荐被推翻"，而是**把 v2 的选项 A 正式拍板**。

**【问题】** 我们新增了一条规则：**改权限也必须产生一个新版本**。那么这些"权限版本"要保留多久？

**【为什么会有这个问题】** 打个比方：这就像**监控录像保留多久**。

先说为什么必须有这条规则（**这条理由在 v3 之后完全不变，仍然成立且重要**）。因为我们的版本快照里**同时包含正文和权限**（`blocks_json` + `acl_json`）。如果改权限不产生版本，就会出现这种事故：

> 你在 3 月把某段内容设成"仅编辑者可见"，6 月觉得太严又放开成"组织可见"。现在你想"恢复到 3 月那一版"——如果 3 月那次**权限变更没有留版本**，系统会把**当时的正文**配上**现在的权限**还给你，结果可能是**把本该受限的内容放开了**。

所以"改权限必须产生版本"是**安全必需**的。它的副作用是：`page_versions` 会长得很快 —— 每次调可见性 +1 行，而每行还背着可能数十 KB 的 `blocks_json`。

**【选项 A：永久保留】← ★ v3 采纳**

- **后果**：审计最完整，可以回溯到任何时点的**权限状态**（不只是正文）；"恢复到 3 月那一版"能把正文与权限**一起**还原，不留"权限状态已被清理、想恢复也恢复不了"的窗口。
- **代价**：表无限膨胀（见 §9 **R16**）。用户已判断**实际使用中权限变更不频繁**，因此**接受**这个代价，**不动保留策略**。

**【选项 B：权限版本最多保留 50 条或 90 天；正文版本永久保留】← ★ v3 作废**

- **后果**：表可控。**注意：正文版本仍然永久保留，正文绝不会丢**——被清理的只是"正文没变、只有权限变了"的那些行。
- **作废理由**：① 一旦清理权限版本，"恢复到某次权限变更之前"就**不可能**了，而 §4.4 的版本语义要求权限**可回溯**；② 这条策略本身还需要**区分"正文版本"与"权限版本"**的额外手段 —— 而 v2 只给了 `blocks_json` / `acl_json` 两列，**没有**标记列（§12 第 7 条，现已无需补）。
- **（原文如此，实现前需复核）**：原推荐这一档的理由是"权限状态的回溯价值随时间快速衰减、而它占用空间最大"。v3 用"实际变更频率低"对冲了空间担忧 —— 这是**用户的运行经验判断，不是实测数据**。若将来发现某篇大文档被反复调可见性导致版本表增速异常，处理方向见 §9 R16（**前提仍是不动保留策略**）。

#### D12 —— 块级授权发给"具体的人"，还是发给"某个岗位"？【★ 已作废（v3 修订，见 §10.1 的 D13）】

> **★ v3 修订结论：D12 已作废 —— 问题本身消失了，不是"块级选了选项 B"。**
>
> - **用户决定（决定一）**：授权对象里**彻底不要角色**。用户原话大意："*D12 感觉有点诡异啊，又是角色又是组的，理论上就分公开、授权给个人、授权给团队就可以了*"。
> - **问题比原 D12 描述的更大**：不只是"块级要不要支持角色"，**页面级也不该有**。原设计把"角色"塞进了**授权对象**的位置（`page_grants.subject_kind = user|group|org_role`），这是**概念错位** —— 它会让"页面级能用角色、块级不能用"两层规则不一致，并生出"页面授权给 `viewer`、某个块授权给 `member`"这类**无法解释的交叉规则**。解决方式因此**不是**"块级去掉角色"，而是"**页面级也去掉**"。
> - **统一后的形态**：`page_grants` 与 `block_grants` 的 `subject_kind` **都只有 `user|group`**（§2.0、§3.3、§3.7）。
> - **因此 D12 整个消失**：不用再讨论"块级要不要支持角色"，因为**页面级也不支持**。下面的"选项 A / 选项 B / 推荐"因此**全部作废** —— 它们都在"页面级可以按角色授权"这个错误前提下推理。
> - **代价的重新定位**：原文把"想让所有 member 都能看这个块，要多建一个组"列为**块级的代价**；v3 之后这是**全局**的代价（页面级同样如此），并且多了一个坑：**团队成员是手工维护的名单，把某人提升为 `admin` 不会自动把他加进那个团队**（§2.1 已写明）。
> - 原文保留在下面（留痕），其中"页面级授权支持的授权对象有三种"一句**在 v3 后已不成立**。

**（以下为 v2 原文，留痕用；不要按它实现）**

**【问题】** 给单个内容块**单独授权**时，能不能授权给**一个角色**（比如"所有组织成员"），而不是授权给具体的人/组？

**【为什么会有这个问题】** 页面级授权（`page_grants`）支持的授权对象（`subject_kind`）有三种：`user`（具体人）、`group`（组）、`org_role`（角色，比如"所有 member"）。块级授权（`block_grants`）**要不要照抄这三种**？

打个比方：这就像**一条密级的通知，是发给"张三、李四"（具体的人），还是发给"财务部全体"（某个岗位/部门）**。

**【选项 A：块级也支持角色主体】**

- **后果**：表达力更强（"这个块让所有 admin 看"）。
- **代价**：会出现**交叉规则**——比如"页面给 viewer 看，但页面里某个块只给 member 看"。这时判定顺序会变得**难以解释**（用户会问："我到底能看还是不能看？"），而且"谁能看这个块"的反向排查要同时考虑**角色继承**与**块级例外**两层。

**【选项 B：不支持角色主体，只允许 `user` / `group`】**

- **后果**：规则简单、可解释 —— **页面级用角色（粗），块级只做"具体主体的例外授予"（细）**。
- **代价**："想让所有 member 都能看这个块"要**多一步操作**：先建一个组，把 member 加进去，再授给这个组。

**【推荐：选项 B（不支持 `org_role`）】**

- **理由**：组织角色是**页面级概念**（回答"谁能看这个页面"）；让块级再接受角色主体，会制造"页面给 viewer、块给 member"这类交叉规则，判定顺序会变得难以解释。**块级只做具体主体的例外授予。**
- **注意**：`group` 这条路已经能覆盖"想给一群人"的需求，所以代价只是"多一步建组"。本设计的 `block_grants.subject_kind` 已按此写为 `user|group`（见 §3.7）。

---

## 11. 外部来源（均经实际访问）

### 11.1 各家产品的权限与继承模型

- Confluence 页面限制（含 View 继承与"必须同时满足"的交集语义原文）
  - [Page restrictions | Confluence DC 9.3](https://confluence.atlassian.com/conf93/page-restrictions-1502349912.html)
  - [Page Restrictions（含官方示例）](https://ja.confluence.atlassian.com/pages/viewpage.action?pageId=59806414&navigatingVersions=true)
  - [Make a Space Public | Confluence DC 10.0](https://confluence.atlassian.com/conf100/make-a-space-public-1627456472.html)
- Notion
  - [Sharing & permissions](https://www.notion.com/help/sharing-and-permissions)
  - [Add members, admins, guests & groups](https://www.notion.com/help/add-members-admins-guests-and-groups)
  - [权限层级与"最强胜"验证实录](https://dev.classmethod.jp/articles/check-permission-setting-on-notion/)
- GitBook
  - [Permissions and inheritance](https://gitbook.com/docs/collaborate/member-management/permissions-and-inheritance.md)
  - [Roles](https://gitbook.com/docs/collaborate/member-management/roles.md)
  - [Site audience](https://gitbook.com/docs/publish/site-audience.md)
  - [Publish a docs site（缓存/索引残留的官方承认）](https://gitbook.com/docs/publish/publish-a-docs-site.md)
- Outline
  - [Sharing](https://docs.getoutline.com/s/guide/doc/sharing-LG2sGOLIpl)
  - [Groups](https://docs.getoutline.com/s/guide/doc/groups-Jy1rROTFmN)
  - [Collections](https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV)
  - [API（Shares / AccessRequests / Events）](https://www.getoutline.com/developers)
  - [GHSA-rg4j-pmch-w6pm（越权发布漏洞）](https://github.com/outline/outline/security/advisories/GHSA-rg4j-pmch-w6pm) · [CVE-2026-43889](https://app.opencve.io/cve/CVE-2026-43889)
- BookStack / Wiki.js
  - [BookStack #4835 权限未级联](https://github.com/BookStackApp/BookStack/issues/4835)
  - [Wiki.js Discussion #6998 page rules](https://github.com/requarks/wiki/discussions/6998)

### 11.2 授权模型（Zanzibar / ReBAC）

- [Zanzibar: Google's Consistent, Global Authorization System（USENIX ATC 2019 原论文）](https://www.usenix.org/system/files/atc19-pang.pdf) —— *本环境无法解析 PDF；文中引用其内容（Table 1 语法示例、zookie、Leopard 实测数据）均来自下面的逐段导读*
- [论文系统导读（含语法、Table 1、Leopard、zookie 实测数据）](https://github.com/AviAvni/database-learning-path/blob/master/topics/40-security-attack-graphs/reading-zanzibar.md)
- [SpiceDB Schema Language](https://authzed.com/docs/spicedb/concepts/schema) · [SpiceDB 的 Zanzibar 概念](https://authzed.com/docs/spicedb/concepts/zanzibar) · [SpiceDB GitHub](https://github.com/authzed/spicedb) · [关系过期（Writing Relationships that Expire）](https://authzed.com/docs/spicedb/concepts/expiring-relationships)
- [OpenFGA Modeling](https://openfga.dev/docs/modeling)

### 11.3 安全工程

- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet) —— **本设计最重要的外部依据**：前端校验绝不可作为判定依据；必须服务端、逐对象、每请求、集中单点
- [OWASP Top 10 2021 A01: Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/)
- [OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/v42)
- [PortSwigger — Web cache deception](https://portswigger.net/web-security/web-cache-deception) · [Gotta Cache 'em all（Black Hat USA 2024）](https://portswigger.net/research/gotta-cache-em-all) · [OWASP wstg#1008](https://github.com/OWASP/wstg/issues/1008)

### 11.4 搜索 / SEO

- [Block Search Indexing with noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing)
- [Robots Meta Tags Specifications](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- [Control the content you share with Google](https://developers.google.com/search/docs/crawling-indexing/control-what-you-share)
- [Remove your site info from Google](https://developers.google.com/search/docs/crawling-indexing/remove-information)
- [Flexible Sampling Guidelines](https://developers.google.com/search/docs/appearance/flexible-sampling)（"先给一部分"的官方模式）
- [Subscription and paywalled content（`isAccessibleForFree`）](https://developers.google.com/search/docs/appearance/structured-data/paywalled-content)

---

## 12. 整理本文时发现的前后矛盾与不确定处

> 这一节是**刻意保留**的：两轮设计与用户决定之间存在张力，不应被悄悄抹平。**★ v5 定稿时已逐条核对**（**★ v6 追加第 18 / 19 两行**）—— 下表给出每一条的现状。**注意区分两类**：标"**已解决**"的是**曾经的矛盾/张力，已有结论**；标"**需复核**"的是**技术上的未验证项（不是待决项）**，实现前必须实测/复核。
>
> | 条目 | 现状 |
> |---|---|
> | 1（v1 否决块级模型 vs 用户选择） | **已解决**（D3；风险由 §4.3/§4.4/§4.5 接住，R11–R15 是新增风险） |
> | 2（v1 仅本地密码 vs 用户要 OIDC） | **已解决**（D2；新增 P1.5） |
> | 3（v1 门户可收录 vs 用户不许收录） | **已解决**（D4；§5.10/§6 翻转） |
> | 4（`ancestor_path` 表述不一致） | **已解决**（该列已删，§2.3 末尾有订正说明） |
> | 5（版本历史读取策略 v1/v2 冲突） | **已解决**（以 v2 为准：非 `canEdit` 一律 404） |
> | 6（D5–D8 未被同等处理） | **已解决**（v5：D7/D8 已拍板；D5 由 §4.3 tier 方案取代；D6 由 D3 覆盖） |
> | 7（D11 缺"区分版本类型"字段） | **已解决**（v3：永久保留 ⇒ 不再需要该标记列） |
> | 8（`901`/`8192` 两个数值不存在） | **已解决（且是任务提示词自身的错误，文档无误）** |
> | 9（"用户说 D9–D12 看不懂"无对应消息） | **已解决**（D9–D12 现已全部有结论：D11/D12 v3、D9/D10 v5） |
> | 10（索引命名 v1/v2 不一致） | **已解决**（本文采用 v2 命名） |
> | 11（`0010_identity.sql` 的 `ALTER` 略冗余） | **未解决（可选简化，不影响语义）** —— 非技术风险，留给实现者选择 |
> | 12（迁移序号不同步） | **需复核**（原文如此；本文按建议从 `0010` 起编） |
> | 13（v1 附录的三处订正） | **有效**（三条均仍成立） |
> | 14（v2 默认页面级可按角色授权） | **已解决**（v3/D13） |
> | 15（块级"仅编辑者可见"让能力定可见性） | **已解决**（v4/D15） |
> | 16（`minRole` 命名） | **已解决**（v3 改名 `minVisibility`；v4 值域改 `'org'\|'granted'`） |
> | 17（`invitations.org_role` 命名保留） | **不是矛盾**（说明性留痕，保留不改名） |
> | 18（`pages.visibility` 两层默认值） | **不是矛盾**（v5 说明性留痕，保留；见本条正文） |
> | 19（P0 实现自行定义了文档未写的 API 形状） | **已解决**（v6：已回写为 §2.5；过程与根因见本条正文） |
> | 20（`link_ticket` 要求"存 DB" vs §7.6 的"迁移增量 0"） | **已解决**（v7：改为 **HMAC 签名的自包含票据，不落库**；安全性与落库等价、代价已写明 —— §7.2 的 ★ v7 小节，事实基础见 §3.1 的 ★ v7 核对） |
> | 21（§4.3 写"PG 侧不执行本文件" vs PG 实跑仍执行） | **已解决（且暴露了一个可选的诊断体验改进项）**（v7：控制器确按方言取目录，但 `@geewiki/search` 用裸字符串声明 ⇒ 归入 `'default'` 键 ⇒ PG 上照样执行并失败；修法 `{ sqlite: './migrations' }`，**不阻塞任何阶段** —— §4.3 的 ★ v7 小节） |
> | 22（§2.3 规则 B1 的 `min` 方向写反） | **已解决（★ v8，安全相关）** —— 按 `tier` 刻度订正为 **`max`**，并说明"同一语义在两套刻度下方向相反"；该错误曾扩散到 4 处代码注释、已全部订正。见 §2.3 与 §13.6 第 1 条 |
> | 23（§4.3 低估 P3a 的方言成本） | **已解决（★ v8）** —— 补记**三个只在真 PostgreSQL 上暴露**的缺陷（`96891db` / `e941da5` 已修）。见 §4.3 的「★ v8：P3a 的方言成本」与 §13.6 第 2 条 |
> | 24（跨阶段不变量：`blocks.tier` 的扇出） | **已解决（★ v8）** —— 失效过三次，提为独立小节 **§4.6**，并记录四个调用点与"必须在提交之后"的理由。见 §13.6 第 3 条 |
> | 25（`acl_revision` 的"代际失效"是过度声明） | **已解决（★ v8）** —— 全仓无读取方；结论（被批准者免重登即可见）仍成立但**理由不同**；**保留"不要给判定层加 TTL 缓存"这条禁令**。见 §13.6 第 11 条 |
> | 26（其余九条就地补正） | **已解决（★ v8）** —— §3.6 迁移落点与 `tier` 内联、§9 R9 `navOrder`、§8.2 P2-14 脱敏判据、§4.3 `snippet()` 静默 `null`、§4.3 标题不参与 FTS 匹配、§8.2 P2 新增第 15 条（前端 IA）、§6.6 `系统状态` 归属、§2.3 一律 404、§8.2 P4-6 守卫口径。逐条见 §13.6 第 4 条 |
>
> 也就是说：**定稿后本节不再含"待拍板"类条目**，只剩第 11 条（可选简化）与第 12 条（需复核）这类**实现期事项**，外加 **v6 新增的第 19 条**（**实现回写留痕，已解决，不是待决项**）、**v7 新增的第 20 / 21 条**（**实现反馈订正，均已解决**）与 **★ v8 新增的第 22–26 条**（**实现反馈订正，均已解决**；其中第 22 条**是安全相关的方向性错误**，第 24 条提为独立小节 **§4.6**）。

1. **v1 明确否决了块级模型，而用户选择了它。** v1 §6.3 的结论是"**推荐 A 方案**（内联标记 + 服务端投影裁剪），B 方案（blocks 表）列为 P4+ 可选演进"，并给出了理由：B 会**同时炸掉** FTS5 external content 触发器、版本历史、AI RAG 三条链路。用户选择了 B（完整块级模型）⇒ **v2 §6 整节重写**，v1 §6 与 §9-D3 作废。本文档以 v2 为准。**风险没有消失，只是被 v2 的具体方案接住了**（§4.3 的 tier 设计 + §4.4 的版本语义 + §4.5 的 RAG 契约），而 R11–R15 是这套方案**新增**的风险。
2. **v1 推荐"仅本地密码"，用户要 OIDC** ⇒ v1 D2 作废，v2 新增 P1.5（§7）。
3. **v1 推荐"门户公网可收录"，用户不许收录** ⇒ v2 §5.10 整节翻转，门户路径从 v1 的 `/` + `/p/*` 改为 `/portal`（§6.1），v1 §7.1/§7.2 的页面清单相应作废。
4. **`ancestor_path` 的表述不一致。** v2 §3.2 明确"**删 `ancestor_path`**"，但 v2 §2.3「移动条目」一节仍写着"重算页面的 `ancestor_path` **等价物**（现在改为实时按 slug 前缀算）"；而 v1 §2.3 的例子表里还有一行"`ancestor_path` 重建后判定即刻变化"，v2 没有逐条重写那张表。**已在本文 §2.3 末尾加订正说明**：该列已删除，祖先收紧按 slug 前缀实时计算。
5. **版本历史的读取策略，v1 与 v2 冲突。** v1 §5.3 要求"即便允许读历史，历史正文也必须过**同一投影函数**"；v2 §5.3 改为"**非 `canEdit` 主体一律 404**，历史不对普通读者开放"，并说明理由是"历史里含 `blocks_json` 权限信息，投影它等于泄漏 ACL 结构"。本文以 v2 为准。
6. **D5 / D6 / D7 / D8 在 v2 里没有被同等处理。** v2 §9 只显式处理了 D1–D4（已拍板）与 D9–D12（新待定），并说明 D6"前半已由 D3 决定"。**D5 是被 §4.3 的 tier 方案实质取代的**（不是被否决）；**D7 / D8 在 v2 中完全未提及** ⇒ 本文把它们列为"沿用 v1 推荐、尚未表态"（§10.3）。（★ v5：**D7/D8 已按推荐值拍板**，见 §10.1；§10.3 已改为决策留痕。）
   **★ v3 注**：D11 已由**决定三**拍板（永久保留，§10.1 / §10.4），D12 已由**决定一**作废（§10.4）。
   **★ v5：本条已完全解决** —— D9/D10 也已拍板（§10.1）⇒ **§10.4 已无待拍板项**（该节现在只有"已拍板"与"已作废"两类留痕）。
7. **D11 缺一个"区分版本类型"的字段。** 见 §4.4 与 §10.4 的说明。
   **★ v3：已由本次修订消解（决定三）。** 那个 `kind: 'content' | 'acl'` 标记列的**唯一目的**就是"只清理权限版本"时能把两类版本分开；D11 改为**永久保留**后**不再需要清理**，该列因此**不必加**。**原文保留在上面**（不删），以说明"这条需求曾经存在、以及它绑定在哪条保留策略上"。**注意勿反向误读**：消解的是"字段的用途"，不是"区分能力" —— `blocks_json IS NULL` 的既有语义仍是"**该版本早于块级功能**"（§4.4），**不能**被复用成"这是权限版本"（详见 §9 R16 的缓解方向）。
8. **⚠️ 任务描述里提到的两个数值在所有素材中都不存在**：`901` 与 `8192`。已对 v1（880 行）、v2（708 行）与三份调查报告全文 grep，**零命中**。本文因此**没有写入这两个值**。如果它们来自别处，请提供出处后再补。已核对存在的相邻数值有：`1MB`（`blocks_json` 恢复大小上限，v2 §3.5 / §8.2 P3c-5）、`1_000_000` 字节（现有请求体上限，`packages/plugin-wiki/src/index.ts:204-233` 的 `readBody`）、`50 条或 90 天`（权限版本保留，v2 §3.5 / D11）**——★ v3：该策略已作废，D11 改为永久保留，此处保留原值只为说明"它确实在素材里存在过"**。
   **★ v5 定稿说明：这两个数值（`901` / `8192`）是任务提示词自身的错误，本文档没有错**。文中从未出现它们，也没有任何设计依赖它们；上面列出的相邻数值（`1MB`、`1_000_000` 字节）才是文档里真实存在的约束。**本条无须再处理**，保留下来只为记录"曾经有人问过这两个值"。另注：`50 条或 90 天` 已随 D11 作废（v3）。
9. **"用户说 D9–D12 看不懂"在原会话转录里没有对应的独立用户消息**，该表述只出现在任务提示词本身。D9–D12 的定义确实存在（v2 §9「剩余待定」表），本文 §10.4 已按要求给出通俗详解。
   **★ v3 注**：四项里已有两项落地 —— D11 已拍板（永久保留）、D12 已作废。
   **★ v5：四项全部有结论** —— D9 = 2 档、D10 = 全密级收录（§10.1、§10.4）⇒ 本条**已完全解决**（§10.4 不再有待拍板项）。
10. **索引命名在 v1 与 v2 之间不一致**：v1 §3.1 用的是 `idx_grants_unique` / `idx_grants_subject`，v2 §3.4 改名为 `idx_page_grants_unique` / `idx_page_grants_subject`。**本文采用 v2 的命名**（更明确）。
11. **`0010_identity.sql` 里 `CREATE TABLE users` 紧跟 `ALTER TABLE users ADD COLUMN email_verified` 略冗余**：若 P1 是新建该表，更自然是把列直接写进 `CREATE TABLE`。v2 保持 ALTER 形式是自洽的（它假设 P1 建表时一起做），此处记录为**可选简化**，不影响语义。
    **★ v5：未解决，但不是待决项** —— 它是**实现期的编码风格选择**（跟着新表一起建列，或保留 `ALTER`），两条路语义一致、都通过验收；**不需要用户拍板**，留给实现者。
12. **迁移序号已不同步（原文如此，实现前需复核）**：SQLite 侧有 `0002_pages_updated_at_index.sql`，PG 侧只有 `0001_init.sql`。本文按 v2 建议统一从 `0010` 起编。
    **★ v5：需复核（已实测确认事实、未确定最终编号）** —— 两处目录的现有编号已用 `ls` 核实确如本条所述；是否最终从 `0010` 起编取决于双方言迁移控制器的实现，**实现前复核**。
13. **v1 附录记录的三处订正依然有效**：① Web API 客户端路径是 `packages/web/src/api.ts`（不是 `lib/api.ts`）；② FTS5 的建表与三条触发器在 `packages/plugin-search/migrations/0001_search.sql`，**改造 FTS 的归属插件是 `@geewiki/search`，不是 db 插件**；③ 双方言迁移序号已不同步。
14. **★ v3：v2 默认了"页面级可以按角色授权"，本次修订把它整个删掉。** v2 的 `0012_page_acl.sql` 把 `page_grants.subject_kind` 写成 `user|group|org_role`，而 §10.4 的 D12 只讨论"**块级**要不要照抄这三种" —— 也就是说，v2 把"**角色可以当授权对象**"当成了**前提**，从未讨论过它本身对不对。用户评审时指出这是**概念错位**（原话大意："又是角色又是组的，理论上就分公开、授权给个人、授权给团队就可以了"）⇒ **页面级与块级统一为 `user|group`**。
    **已由本次修订解决**（新增 §2.0、§2.1、§2.3 规则 O1、§2.4、§3.3、§3.7、§9 R10 第 9 条、§10.1 的 D13、§10.4 的 D12 标注作废）。
    **刻意保留**：v2 D12 的原文推理（"页面级用角色（粗），块级只做'具体主体的例外授予'（细）"）**不删**，作为对照材料；但**不要按它实现**。
15. **★ v3 修订发现的**新**张力：块级的"仅编辑者可见"仍然让"能力"决定"可见性"。（★ v4：已解决，见条目末尾。）** §2.0 定的规则是"角色决定能做什么；可见性与授权决定能看什么，两者不交叉"，但本文原本有两处原文与之直接抵触：
    - §2.2：`block.visibility: 'public' | 'org' | 'private'`，注释写作 "**private = 仅 editor 及以上**"；
    - §4.1：块标记 `<!--gated:role=editor-->` ⇒ 该块 `visibility='private'`（§3.6 的 `blocks.marker` 示例值也正是 `'role=editor'`）。
    这两处都是**用能力（是不是 editor）在决定可见性**。v3 当时记录了两个可能的收敛方向：
    - **方向 ①（放宽 §2.0 的措辞）**：明确承认"**编辑者可见**"是可见性档位里**唯一**允许的能力型例外，`gated:role=editor` 语法保留。
    - **方向 ②（收紧块级语义）**：把块级那档的语义改为"**仅被显式授予该块的人可见**"（即只有 `block_grants` 能给出），标记语法相应改名。
    **★ v4：已由决定四解决 —— 采纳的是方向 ②，且比它更彻底。** 解决方式**不是**"承认一个能力型例外"，而是**把第三档换成纯授权驱动的"仅授权"档**：
    - `block.visibility ∈ public | org | granted`，`granted` = **默认谁都不能看，靠 `block_grants` 放人**（§2.2）；
    - 标记语法 `<!--gated:role=editor-->` → **`<!--gated:granted-->`**，解析器**必须拒绝** `role=*` 旧标记（§4.1）；
    - 由此**块级不再有任何一处按角色/能力定可见性**，"编辑者"这个概念从块级彻底删除。
    **为什么必须"加一个档"而不是"删掉第三档"**（这是本次决策的关键约束）：`*_grants` **只能放宽、不能收紧** ⇒ 没有 `granted` 这一档，"**只给自己看的运维备注**"就**没有档位可表达**（块设成 `org` 之后，再授权给自己也不会让它变窄）。详见 §13.2。
    > **关联发现（v4 自检）**：新的检索路径要按主体反查 `block_grants`，而该表**原本没有** `(subject_kind, subject_id)` 索引 ⇒ 已在 §3.7 补 `idx_block_grants_subject`。
    > **原文留痕**：上面两条被改掉的原文（`'private'` = 仅 editor / `gated:role=editor`）仍按原样记在本条内，**已不成立，不要按它们实现**。
16. **★ v3：`minRole` 已改名 `minVisibility`（§6.6）。** 块占位节点原写作 `{ kind:'gated', count:N, minRole:'org' }`，而它的取值是**可见性档位**（`'org'`）而不是角色 —— 正是 v3 要消除的那类概念混淆，故改名并在 §6.6 就地标注。**留痕以免与旧讨论对不上。**（同源问题见第 15 条；**v4 后两条都已处理**：本条 v3 改名，第 15 条 v4 换档；另注意第 15 条里 `minVisibility` 的取值域在 v4 已变为 `'org'|'granted'`。）
17. **★ v3：`invitations.org_role` 这个名字保留（说明，非矛盾）。** §3.2 里除授权表之外还有一处 `org_role` —— `invitations.org_role`（"接受邀请后获得哪个组织角色"）。它描述的是**能力**（入伙后是不是 admin/member），**不是授权对象**，与决定一无关，因此**保留不改名**（已在 §3.2 的 DDL 注释里就地写明）。在此留痕，以免后人 grep `org_role` 时误以为它是残留。
18. **★ v5：`pages.visibility` 的两层默认值看起来矛盾，其实是刻意的（说明，非矛盾）。** §3.3 的 DDL 写 `DEFAULT 'private'`（**失败关闭**：没人管的写入路径落到最严档），而应用层新建条目的默认是 `'org'`（**本产品的常态**，也是 D8 给存量条目回填的档）。已把这两层的关系写清在 §3.3 的 v5 注里，并在此留痕 —— 因为**只看 DDL 很容易误读成"新建页面默认私有"**，而那是错的。这也是 D8 的派生项（见 §13.3）。

19. **★ v6：P0 实现过程中自行定义了文档未写的 API 形状（"文档缺口 → 实现补齐 → 回写文档"）。** 本条**不是"矛盾"，而是一次缺口记录** —— 沿用本节"**刻意保留张力**"的风格：把**过程与根因**写下来，避免同类丢失再发生。
    - **事实**：P0 依赖的"**钩子机制**"与"**路由 `access` 声明**"**确实都是文档要求过的**（`§8.1` 的 P0 行、`§0.1`、`§8.2` 的 P0-5 / P0-6、`§2.4` 的 `Principal` 接口，实现与它们**逐字段一致** —— 审查已逐项核对）；**但这套 API 的具体形状文档里没有**：`RouteAccess` 三档枚举、`RequestVerdict`、可选 `use?(hook): () => void`、`dispatch` 返回类型放宽为 `boolean | Promise<boolean>`、`register()` 的可选第 4 参 `opts.access`（默认 `public`）、`judgeAccess` 的判定顺序与 401 / 403 / 503 的选择 ⇒ **全部由实现在过程中自行定义**。
    - **风险（审查的结论，原话大意）**：*"建议把这 6 项设计补进设计文档，否则 **P1 会拿『文档没写』当理由改掉它们**。"* 这不是纯理论风险：这些形状里有若干条**看起来像实现细节、实际是安全契约** —— `access` 默认 `public` 的**向后兼容前提**、**503 必须早于 401** 的引导期语义、钩子返回值不合法必须**失败关闭**、`dispatch` 返回值放宽是**异步身份解析的唯一可行路径**（B1）。
    - **v6 的处理**：**新增 §2.5**（六项形状 + 两条边界）把它们补成正式章节；并在 **§8.1 P0 行**、**§0.1 ②** 就地标注"实现已落地"。
    - **为什么它当初会丢（根因，必须记下来）**：**章节重排**。v1 设计里"**路由鉴权插入**"原本是 **§4**；定稿合并时 **§4 被"块级内容模型"占用**（即现 §4），而那一节的内容**没有被迁移到别处**（也没有被显式声明作废）⇒ 它作为"**没进最终文档的一节**"静默消失，只在 §8.1 / §0.2 的行文里留下"**钩子表 + 路由 `access` 声明**"这样一句**没有形状的短语**。风险因此被延后到**实现期**才暴露（实现者只能自行定义形状）。
      > **来源说明（诚实标注）**：本条里"v1 的 §4 是路由鉴权插入方案"出自**本轮修订的任务简报与独立代码审查结论**；仓库内**没有 v1 设计稿存档**（`docs/design/` 只有 `access-control.md`，`git log --all -- docs/design/` 只有一条新增提交 `261cea1`）⇒ **该因果无法在仓库内核验**，此处按"审查结论"记录，**不要当成已实测事实**。
    - **与既有 18 条的关系（已逐条核对，无重复）**：不是第 6 条（那讲的是 **D5–D8 决策**未获同等处理）、不是第 13 条（那讲的是 **v1 附录的三处订正**）；本条讲的是"**章节迁移过程中的内容丢失**"，是**新的一类** —— 特点是"**丢了的东西没进 §12，因为当时没人知道它丢了**"。**故不合并，只在此交叉引用。**
    - **可复用的一条经验**：**合并 / 重排章节时必须逐节核对"目标编号是否已被占用、原内容是否已迁移"**，并给被并掉的节留一条**显式的作废或迁移指针**。本条就是缺这一步的代价（代价最终落在 P0 的实现者与审查者身上）。

20. **★ v7：§7.2 要求 `link_ticket`"存 DB"，而 §7.6 把本阶段的迁移增量定为 0 —— 两条要求不可兼得。** 这是一条**真矛盾**（不是缺口），只是**直到 P1.5 开始实现才暴露**。
    - **事实**：§3.1 的 `0010_identity.sql` 里**没有存 ticket 的表**（`grep -rn ticket packages/db-sqlite/src/migrations/ packages/db-postgres/migrations/` **零命中**）；§7.6 又明写"迁移增量 **0**（`user_identities` 已在 P1 建表）"。要落库就得**新增一张表** + **两侧方言成对迁移**（§3.0）+ **一条过期行清理任务** —— 全都超出该阶段范围。
    - **实现怎么解的（两个独立实现者得出同一结论）**：**不新增表**，改用 **HMAC 签名的自包含票据**（`base64url(JSON 载荷) + '.' + base64url(HMAC-SHA256)`），服务端只验签、**不落任何一行**。
    - **为什么这样也安全（v7 的关键论证）**：绑定端点**同时**要求"**持有有效 ticket**"**且**"**以目标本地账号的会话登录**"（`.wt-p15/packages/plugin-auth/src/index.ts:1262-1266` 的 `h.principal?.userId ?? null` ⇒ 为 `null` 即 401）⇒ **攻击者拿自己的 ticket 也没用，他过不了第二道**。"ticket 被重放"这条顾虑**不成立**；"一次性"另由 `idx_identities_issuer_sub` 唯一索引兜底。完整论证见 **§7.2 的 ★ v7 小节**。
    - **v7 的处理**：把 §7.2 那句"**存 DB**"改为"**HMAC 签名的自包含票据，不落库**"，并补上安全意识论证、代价（进程重启 / 多实例）与"为什么不新增迁移"。**§7.6 与 §3.1 均无需改动**（它们本来就没有 ticket 表）。
    - **可复用的一条经验**：**"存 DB"这类实现细节一旦与阶段边界（迁移增量 = 0）冲突，冲突会在实现期才炸出来** —— 因为写设计稿时没人去数"这张表要不要迁移"。凡是文档里写"存 DB / 落库 / 加一列"的地方，都应同时注明**它属于哪次迁移**。

21. **★ v7：§4.3 写着"PG 侧不执行本文件"，而 PG 实跑时它照样被执行并失败。** 本条是**文档与实机行为的不一致**，暴露的是一个**诊断体验**问题（**不是正确性问题**）。
    - **实测记录（出处：编排者在容器 `geewiki-pg-test`（`postgres:15-alpine`）上把服务切到 PG）**：`[db-postgres] 迁移失败（已回滚）: 0001_search.sql error: syntax error at or near "VIRTUAL"`。
    - **根因（已核实到行）**：迁移控制器**确实**支持按方言取目录（`packages/manager/src/index.ts:1163-1164`、`:1168` 的 `migrationsDirs[dialect] ?? migrationsDirs['default']`），但 `@geewiki/search` 把迁移目录声明为**裸字符串** `migrations: './migrations'`（`packages/plugin-search/src/index.ts:67`）⇒ 在 `resolveMigrationsDirs` 里归入 **`'default'` 键**（"所有方言共用"，`packages/manager/src/discovery.ts:100-108`）⇒ PG 下命中的正是 `'default'` ⇒ FTS5 语法的脚本照样执行、必然失败回滚。
    - **为什么值得记**：失败发生在插件激活**之前**（迁移控制器是 5.5 步、`ctx.plugin` 在 `:1204`）⇒ 排障者看到的是**迁移语法错误**，而**不是** `@geewiki/search` 那句写得很清楚的方言拒绝文案（`packages/plugin-search/src/index.ts:308-319`）。日志会把人引向"迁移写错了"，而不是"这个插件在 PG 上就是不支持"。
    - **修法（可选，不阻塞任何阶段）**：把声明改成**按方言**的形式 `migrations: { sqlite: './migrations' }` ⇒ PG 下取不到目录，走"**未声明该方言的迁移目录，跳过迁移**"分支（`packages/manager/src/index.ts:1179-1183`），日志只剩一行告警。**先例**：`@geewiki/wiki` 正是只声明 sqlite 目录的那一类（`packages/server/src/index.ts:1391`）。
    - **v7 的处理**：在 §4.3 新增「**★ v7：方言语义**」小节（含 `tsvector` + `pg_trgm` 等价物与"**列为非目标**"的结论），并在 §4.3 那句"PG 侧不执行本文件"旁**就地标注**它是**目标行为而非当前事实**。

22. **★ v8：§2.3 规则 B1 的方向写反了（安全相关 —— 本次修订最重要的一处）。** 文档写 `effectiveBlockTier(block) = min(block.visibilityRank, pageEffectiveRank(slug))`，而**按 `tier` 这一列的刻度必须是 `max`**。
    - **两套刻度**：`blocks.tier` 的语义是**限制等级**（检索条件 `b.tier <= :readerTier`，**越小越公开** ⇒ "更窄" = **更大**），而文档那句的刻度是**宽松度**（越大越宽松 ⇒ "更窄" = `min`）。**方向相反，所以同一语义写法相反。**
    - **★ 而且文档是自相矛盾的**：§2.3 自己声明的档位序写的是"**越右越窄**"（数值越大越窄）—— 在那个刻度上 `min` **本来也该是 `max`**。**⇒ 这里有两层错**（公式与自声明的刻度不符 + 两套刻度方向相反），不是单纯笔误。
    - **写反的后果（为什么是安全相关）**：`max` 写成 `min` 会让"**页面 org + 块 public**"的块拿到 **`tier = 0`** ⇒ **匿名在站内搜索里就能搜到它** ⇒ "**读路径 404、检索却命中**"（§4.6）。
    - **扩散与订正**：这条错误曾扩散到 **4 处代码注释**（分布在 **3 个迁移文件**）——`packages/db-sqlite/src/migrations/0015_blocks.sql`（两处）、`packages/db-postgres/migrations/0015_blocks.sql`（一处）由 `ade59ef` 订正；`packages/plugin-search/migrations/0002_blocks_fts.sql`（一处）由**更早**的 `1d608a6` 订正（`1d608a6` 是 `ade59ef` 的祖先）。**全部只改注释、未动 SQL 语句。**
    - **★ 复核结论（v8 本轮重新 grep 过，方法与结果见 §13.6 第 1 条）**：**没有"照抄形态"的残留**。三个迁移文件里至今仍出现 `min(`，但**全部是"解释为什么不是 `min`"的行文**；`packages/plugin-wiki/src/blocks.ts:222` 那句同理（引用旧写法以说明代码为何用 `max`）。**⇒ 不要把它们再"改"一次，那会把注释改瞎。**
    - **权威实现**：`packages/plugin-wiki/src/blocks.ts:235-239` 的 `tierFor(pageLevel, blockVisibility)`，真值表在 `:220-234`（该处小标题即"为什么这里是 `max` 而不是文档写的 `min`"）。**注意 `packages/plugin-authz/src/index.ts:127-129` 的 `RANK_*` 也是窄度刻度**（故 `:274-287` 的 `effectiveRank` 内部用 `Math.max`），**不要因为名字叫 `RANK` 就以为它是宽松度刻度**。

23. **★ v8：§4.3 低估了 P3a 的方言成本 —— 三个只在真实 PostgreSQL 上暴露的缺陷。** 原文那句"块模型与读路径裁剪两部分仍可两方言落地"在修掉这三个缺陷之前**不成立**。三个缺陷的共同特征是：**类型检查、单元测试、SQLite e2e 全都照样全绿**。
    - ① **写块靠捕获异常判断"`blocks_fts` 不存在"**，只匹配 SQLite 的 `no such table:`，PG 的文案是 `relation "blocks_fts" does not exist` ⇒ **每次写块都失败、`blocks` 恒为 0 条**。修法必须**事务外按方言判定**（PG 的事务在任一语句报错后进入 aborted 状态，"捕获后继续"不成立）。
    - ② **缺 `RETURNING id`** ⇒ PG 报 `insert or update on table "blocks" violates foreign key constraint "blocks_page_id_fkey"` / `Key (page_id)=(0) is not present in table "pages"` ⇒ **新建 / 保存页面 500**。
    - ③ **`deletePage` 里的 `DELETE FROM blocks_fts` 没有方言守卫** ⇒ **PostgreSQL 上删除任何页面返回 500 且页面删不掉**（PG 事务报错即整体回滚）。
    - **订正**：①② 由 `96891db`、③ 由 `e941da5` 修掉。**③ 此前从未被发现，是因为 e2e 的阶段 G/H/I/K 靠直读 SQLite 文件核对 `tier`、在 PG 下整体跳过**（`packages/plugin-wiki/test/e2e-p3a.sh:293`、跳过点 `:319/:342/:369/:397`）⇒ `deletePage` 在 PG 上**从没被端到端跑到过**；已补**方言中立**的阶段 L（`:292`，含删除路径 L8 与 `tier_mismatched=0` 的 L9）。
    - **结论性提示（可直接引用）**：*"块模型的 PG 可用性依赖 `RETURNING id`、索引表存在的方言判定、以及每一处 `blocks_fts` 语句的方言守卫 —— **这三点都不由类型系统保证，必须有真方言 e2e 兜底**。"* 详见 §4.3 的「★ v8：P3a 的方言成本」。

24. **★ v8：跨阶段不变量 —— 写了 `pages` 的档位，就要补齐子孙 `tier`（实现中失效过三次）。** `blocks.tier` 是**物化派生列**；凡写了 `pages.visibility` / `inherit` / `published_at` 的路径，都必须在**该事务提交之后**调用子孙 `tier` 重算。
    - **三次失效**：P3a 的 `savePage` create 分支（新建祖先，`a3d72b7`）、`deletePage`（删掉 `inherit=false` 的断链点，`a3d72b7`）、P3c 的**版本恢复路径**（`9699aa7`）。前两次由审查端到端复现（匿名 `/api/search` 返回了本该受限的唯一词），第三次由第二轮审查发现。
    - **为什么必须在提交之后**：`pageLevelOf` 走策略层（**另一条数据库连接**），**PG 的 MVCC 下看不到本事务未提交的行** ⇒ 放进事务**不会死锁**，但会**读到旧值、等于没修**。
    - **⇒ 失败必须升级为一等可观测信号**：`ResyncReport` + 审计 `acl.resync_failed` + 响应字段 `index_tiers_resync_failed`（让"重算了 0 个子孙"与"扇出整个失败"可区分）。
    - **⇒ 教训（原话）**：*"新增一条写档位的路径，就应触发『补扇出』这个动作 —— 这是跨阶段不变量，而每个阶段只看自己那一段时必然漏。"* 完整小节见 **§4.6**；与 §9 R13 互为引用。

25. **★ v8：`acl_revision` **没有任何读取方** —— 文档与代码注释里"判定单点按 `acl_revision` 做代际失效"属**过度声明**。**
    - **事实**：`packages/plugin-authz` **没有决策缓存**（每请求现查库），全仓**没有任何代码读 `acl_revision` 来做判定**（它只被**递增**、被**回显**、被测试**断言递增**）。代码自己的注释已经把实情写对了（`packages/plugin-wiki/src/index.ts:2469-2472`）。
    - **结论仍成立、但理由不同**：被批准者**无需重新登录即可见** —— **不是**因为"版本涨了触发失效"，而是因为"**本来就没有缓存可失效**"。
    - **★ 保留真正那条禁令**：**不要给判定层加 TTL 缓存**（一旦加了，"撤销后仍可见"的窗口立刻复活，而 `acl_revision` **帮不上忙**）。原文里"用 `acl_revision`"属过度声明，保留作留痕。
    - 已就地订正：§2.3 例子表、§3.3 / §3.4 的 DDL 注释、§4.4 的恢复步骤、§8.2 P2-4 / P3b-6、§9 R5、§9 R10 第 3 条、§9 R13。

26. **★ v8：其余九条就地补正（逐条索引）。** 均为**实现反馈订正**，各自已写在对应章节，此处只做索引，避免两处维护：
    | # | 事项 | 落点 |
    |---|---|---|
    | ① | **§3.6 的迁移落点是错的**：`@geewiki/wiki` 只声明 sqlite 迁移目录（`packages/server/src/index.ts:1405`）⇒ 照原文写，**PG 部署下 `blocks` 表根本不会被建出来**；实际落在 **db 包、两侧成对** | §3.6 的 ★ v8 订正①；§8.1 P3a 行 |
    | ② | **`tier` 必须内联在 `CREATE TABLE` 里**：SQLite 没有"加列时若已存在则跳过"的语法 ⇒ 独立 `ALTER` 会让迁移**无法重放** | §3.6 的 ★ v8 订正②与 DDL |
    | ③ | **§9 R9 把 `navOrder.test.ts` 列为"P2 必然触碰"是错的**：它测的是 `packages/web/src/lib/navTree.ts` 的上一篇/下一篇顺序，**与顶栏导航无关**（审查用 `git diff --stat` 证明 diff 长度 0 行）；顶栏的真正守卫是 `navGate` / `navPlan` | §9 R9 的 ★ v8 订正 |
    | ④ | **config 脱敏的判据被放宽**（且有据）：实现为 **break-glass 或 `orgRole ∈ {owner, admin}`**（`mayReadPluginConfig`，`packages/manager/src/index.ts:1574`）；两条通道都堵（`/api/plugins` + `/api/session` 经 `PluginListFile.enabled[].config`）；**不能改 `snapshotOf()`**（改了会打瞎配置表单） | §8.2 P2 第 14 条 |
    | ⑤ | **`snippet()` 是静默失败**：实测**返回 `null` 而不报错** ⇒ 用了它又没防护，**高亮会静默变空**，不专门断言高亮内容就发现不了 | §4.3 实测表 + §4.3 的 D5 取舍表 |
    | ⑥ | **§8.2 的 P2 验收 1–14 全是后端项** ⇒ M5 那批工作**没有设计文档层面的验收标准**（规格来源是实现者的 TODO）；已补 P2 第 15 条 | §8.2 P2 第 15 条（新增） |
    | ⑦ | **`blocks_fts` 只索引块文本** ⇒ **FTS 路不再按标题匹配**（LIKE 短查询路仍匹配标题）；已由断言钉住（`packages/plugin-search/test/search.test.ts:558`） | §4.3 的 ★ v8 小节 |
    | ⑧ | **`系统状态`（服务健康 / DB 方言 / 表清单）随 `管理 ▾` 下沉为管理员专属** —— 文档里 `grep 系统状态\|服务健康` **零命中**，规格从未表态；**裁定维持管理员专属**；`GET /api/health` **仍是公共端点**（内联处理、不过闸门，看门狗不受影响） | §6.6 的 ★ v8 小节 |
    | ⑨ | **§2.3 的"匿名 404 / 已登录 403"与实现有偏差** —— 实现对**所有主体一律 404**；代价是"申请访问"失去自然触发点，申请入口必须由前端在**已知 slug** 的拒绝页提供 | §2.3 例子表的 ★ v8 订正；§2.4 约束第 2 条 |
    | ⑩ | **§8.2 的 P4 第 6 条按字面无法执行**（`deletePage` 本就要删被删页自己的版本）⇒ 实现落成"**白名单 + 锚定**" | §8.2 P4 第 6 条 |

---

## 13. 交付确认

- 本文档为**唯一产出**：`docs/design/access-control.md`。
- **未修改任何现有文件、未改动任何代码。**
- 文中标 **「实测」** 的结论来自对仓库实际执行过的只读 SQLite 探测（使用 `:memory:` 库，未触碰 `data/geewiki.db`）。
- **★ v6 补充**：上面三条描述的是 **v1–v5 的写作过程**。**v6（本次修订）同样是纯文档改动**（只改本文件、**未动任何代码**）；但 v6 的**依据不再是用户决策**，而是 **P0 阶段的落地实现 + 一轮独立代码审查** —— 详见 §13.4。另需说明：v6 期间仓库里**已经存在 P0 的实现代码**（worktree 分支 `feat/p0-route-auth-guard`），它是本轮**核对的对象**，不是本文档的产出。
- **★ v7 补充**：**v7 同样是纯文档改动**（只改本文件、**未动任何代码**）；依据是 **P1 / P1.5 阶段的落地实现 + 一次 PostgreSQL 实机试跑**，**仍不是用户决策**。本轮**只读**查阅了实现源码（其中 P1.5 的源码在 worktree `.wt-p15` 里，尚未合入 `main`），**没有运行任何代码、没有执行任何 SQL、没有跑任何迁移、没有复现 PG 试跑** —— 详细的范围与未验证项见 **§13.5**。另需说明：v7 期间仓库里 P0 与 P1 **已合入 `main`**，P1.5 / P2 **正在各自的 worktree 分支上演进** ⇒ 本轮引用的行号**取自核对当时的工作区状态**，可能小幅漂移。
- **★ v8 补充**：**v8 同样是纯文档改动**（只改本文件与当时的一次性交接稿 —— 该交接稿**已删除**，其中仍然有效的工程约定与教训见 `docs/development.md`；**未动任何代码、未动任何迁移**）；依据是 **P2 / P3a / P3b / P3c / P3d / P4 的落地实现 + 多轮独立审查**，**仍不是用户决策**。与 v6 / v7 的**关键差别**：v8 这一轮**真的跑了验证命令**（`pnpm typecheck` / `pnpm test` / `pnpm build`，结果见 §13.6 的验证基线），并在**合入 `main` 的实现**上**逐条复核了所有新增断言的出处（文件:行号）**；**但没有跑 e2e**（e2e 的数字按当时交接稿（已删除）的编排者记录引用，**未由本轮复跑**）。详细范围与未验证项见 **§13.6**。另：v8 期间 **P0–P4 全部已合入 `main`**（`main` = `5536bfa`）⇒ 本轮引用的行号取自 **`main` 的提交状态**，不再有"worktree 未定型"的问题。

### 13.1 ★ v3 修订记录（本次修订；依据 = 用户的三项决定）

- **依据 · 决定一（把"角色"从授权对象里彻底摘掉）** —— 用户评审原话大意："*D12 感觉有点诡异啊，又是角色又是组的，理论上就分公开、授权给个人、授权给团队就可以了*"。
  - 统一为：`page_grants.subject_kind` 与 `block_grants.subject_kind` **都只有 `user|group`**；页面级与块级**完全同构**。
  - 改动位置：**新增 §2.0**；§2.1；§2.2（一处措辞）；§2.3（两处裁决列表 + 新规则 O1）；§2.4（`Principal.orgRole` / `grant` reason 注释 + 第 4 条约束）；§3.2（`invitations.org_role` 就地说明，保留不改名）；§3.3（DDL）；§3.7（DDL + "完全同构"说明）；§6.6（`minRole` → `minVisibility`）；§9 R10（第 4 条加注 + **新增第 9 条**）；§10.1（**新增 D13**）；§10.4（**D12 标注已作废**，原文留痕）；§12（新增第 14、16、17 条）；§1 术语表。
- **依据 · 决定二（`owner`/`admin` 保留"能看所有私有内容"的应急权，每次访问写审计）**。
  - 写成**显式规则**（§2.3 **规则 O1**），**不是"默认放行"**：owner/admin 恒可看一切（含 `private`）；每次**实际发生的覆盖式访问**写一条审计，建议 `action='access.admin_override'`，含 `actor_id`/`target_kind`/`target_id`/`request_id`，可事后追责。
  - 理由（用户给出）：**合规、离职交接、误设私有需要救回；不保留则内容可能永久取不回来。**
  - 改动位置：§2.0（作为"唯一例外"点明）、§2.3（规则 O1 + 两个实现边界）、§2.4（第 4 条约束）、§3.4（`audit_log.action` 取值枚举补 `access.admin_override`）、§8.2（**P2 新增第 12 条验收**：覆盖式访问留痕 + "非覆盖式不写"的反例）、§10.1（**新增 D14**）。
- **依据 · 决定三（D11 改为"权限版本永久保留"）** —— 用户原话："*D11 权限改动记录永久保留就好，实际使用中不会很频繁*"。
  - `page_versions` **全量永久保留**，正文版本与权限版本一视同仁；**取消**"最多 50 条或 90 天"的清理策略。
  - 改动位置：§4.4（删保留策略 + "标记列"标注已消解）；§8.1（P4 范围改为"**授权/邀请到期清理**"，**不含**版本清理 —— `page_grants.expires_at` / `invitations.expires_at` 的到期清理**保留**）；§8.2（P4 新增第 6 条断言）；§9（**新增 R16**，含不动保留策略的缓解方向）；§10.1（**D11 升级为已拍板**）；§10.4（D11 标注已拍板，原文留痕）；§12（第 7 条标注已消解、第 8 条加注）。
- **由决定一自然导出、并已一并写入的推论**：① "只给所有 admin 看"不再能用角色表达 ⇒ 建团队再授权，**且团队成员是手工名单，把某人提升为 admin 不会自动把他加进该团队**（§2.1）；② 反向排查"谁能看这条"只剩**三个来源**（可见性档位 + `user`/`group` 授权 + owner/admin 应急覆盖），R10 第 4 条的邻接风险减弱；③ `viewer` 语义写清（能登录、能看 `org`、**不能写**；要限制子集用团队授权）。
- **本次未替你决定的两件事（已在 §12 留痕）**：§12 第 15 条（块级"仅编辑者可见"仍让能力决定可见性）→ **已由 v4 解决**（§13.2）；§10.4 的 **D9–D10** → **已由 v5 拍板**（2 档 / 全密级收录，见 §13.3）。**两者均已无待决项。**
- **★ 未验证项（诚实声明）**：本次修订是**纯文档改动**（`edit` 工具），**未运行任何代码、未验证任何 DDL / 端点 / 迁移**。本次已实际做过的核对只有两项：① 全仓库 grep 确认 `page_grants` / `block_grants` / `subject_kind` / `minRole` / `gated` 在 `*.ts`/`*.tsx`/`*.sql` 里**零命中**（⇒ 本文属未实现的设计稿，本次改动不会与代码冲突）；② 全仓库 grep `org_role` **只命中本文件**。文中既有的 `文件:行号` 引用**沿用原文、本次未逐条复核**。

### 13.2 ★ v4 修订记录（依据 = 用户的第四项决定：块级第三档改为"仅授权"）

- **用户的过程与原话**：
  1. 用户先说：「*仅编辑者可看就是授权给当前的用户即可，不用单独实现*」—— 即**去掉"编辑者"这个概念**。
  2. 我方指出一条**约束**（这是本次决策的关键，必须留在文档里）：现有设计里 `*_grants`（`page_grants` / `block_grants`）**只能放宽**（把组织外的人放进来），**不能收紧**。因此"**比组织内更窄**"必须**有一个档位**来表达，否则"只给自己看的运维备注"**做不到** —— 一个块设成 `org` 之后组织成员都能看，**再授权给自己也不会让它变窄**。
  3. 用户拍板：**加一个"仅授权"档**。
- **最终形态（块级可见性三档，完全不含角色概念）**：`block.visibility ∈ 'public' | 'org' | 'granted'`
  | 档 | 谁能看 |
  |---|---|
  | `public` | 任何人（含未登录） |
  | `org` | 组织成员 |
  | `granted` | **默认谁都不能看，靠 `block_grants` 放人** |
  - "只想给自己看的运维备注" = 选 `granted` 档 + 授权给自己。
  - **授权方向统一**：`*_grants` **始终是"放宽"方向** —— 在 `granted` 档里它是**唯一入口**，在 `public`/`org` 档里它把组织外的人放进来。页面级与块级语义一致。
  - **"编辑者"概念彻底删除**，**块级不再有任何按角色/能力定可见性的地方**。
- **改动清单**：
  - §1 术语表：`tier` 定义收敛为 `0`/`1`（`granted` 不入等级索引）。
  - §2.0：`<!--gated:role=editor-->` 那条"尚未收敛的边界"改为**已解决**声明；**新增可见性阶梯** `public(0) < org(1) < granted(2)` 与"页面压上限、块只能更窄"。
  - §2.2：块级 `visibility` 取值与注释重写（删除"仅 editor 及以上"）；三档含义表；"授权始终是放宽方向、在 `granted` 里是唯一入口"；**为什么必须有 `granted` 这一档**；与页面级 `private` 的**同名异名说明**（语义相同、名字不同，只有块级改名）；补"`granted` 不违反『主体列表不进枚举』"。
  - §2.3：规则 O1 与块级裁决顺序同步改词；**新增档位序** `public(0)<org(1)<granted(2)`；规则 B1 的公式补档位序；**补"`granted` 在任何页面上都有效、不惰性"**（它是收紧方向）。
  - §2.4：`reason` 枚举**确认无需新增取值** —— `granted` 档"能看"的唯一来源就是 `'grant'`，未被授权是 `'default-deny'`，owner/admin 是 `'owner'|'admin'`；**不引入新的判定来源**。
  - §3.6：`blocks.visibility` DDL 注释 → `public|org|granted`；`blocks.marker` 示例 → `'granted'`；**`blocks.tier` 取值域收敛为 `{0,1}`、`granted` 写 `NULL`**，并把 `DEFAULT 0` 改为**无默认**（理由：`DEFAULT 0` 会让"忘了算 tier"的块以**匿名等级**进索引 ⇒ 泄漏；`NULL` 的失败方向是"搜不到"）。
  - §3.7：**新增 `idx_block_grants_subject (subject_kind, subject_id)`** —— 检索的新授权分支要按主体反查，缺它则每次检索全表扫（与页面级 `idx_page_grants_subject` 对齐）。
  - §4.1：标记 `<!--gated:role=editor-->` → **`<!--gated:granted-->`**；保留 `gated:org`；**解析器必须拒绝 `role=*` 旧标记**（否则老文档里的旧标记被静默忽略 ⇒ 作者以为收紧了、其实是公开的）；补使用说明（"只给自己看"= `granted` + 把自己加进该块授权，**两步都要做**）。
  - §4.3（**本次最关键的技术改动**）：说明第三档**无法用 `tier` 表达**（它是逐块 ACL，不是读者等级）；**明确选择 `NULL` 而非哨兵数字**并给出四条理由（域干净 / `NULL <= ?` 恒不为真 ⇒ 失败关闭 / **与 contentless FTS 表那条 NULL 实测坑不是一回事** / 代价 + 一致性探针）；检索改形为 **`AND ( b.tier <= :readerTier OR b.id IN (:grantedBlockIds) )`**；`:grantedBlockIds` 由 `policy-service` 提供、**判定仍走单点函数**；写明**代价与前提**（每次检索先查一次授权集合、`IN` 列表随授权块数增长 ⇒ 已知可扩展性边界，等价改法为 `EXISTS` 子查询）；**确认与"tier 过滤必须放在 `blocks` 表上"那条实测结论不冲突**（只是同一 `WHERE` 里多一个 `OR` 分支）；旧实测表**重新解释而不重测**（第三列属已废档位）。
  - §4.5：`maxVisibleTier` 标注为**诊断用**指标（它不反映 `granted` 档的可见块）。
  - §5.6：**FTS 路与 LIKE 短查询路两条 SQL 都改为两个分支**，并提示"只改 FTS 路会让 `granted` 块在 2 字元中文短查询下永远搜不到"（漏召回，不泄漏，属静默功能缺失）。
  - §6.6：块占位节点取值域 → `'org'|'granted'`。
  - §8.2：P3a **新增第 10 条**（`tier IS NULL` 计数 == `visibility='granted'` 计数的探针）、**新增第 11 条**（授权段落可检索：FTS 路 + LIKE 路都要测，含未授权者与匿名的反向断言）；P3b 第 3 条改词并补"公开页面上的 `granted` 块对未授权者仍不可见"。
  - §9 R10 第 9 条加注：该反模式**也包括"把角色/能力当可见性档位"**，v3 的 `editors` 与 v4 的 `granted` 是同一问题的两次修正；原文由决定四解决。§9 R13 补"判定用档位序（3 值域）、索引列用 `0/1/NULL`"的区分。
  - §10.1：**新增 D15**；§10.4 D9 的 `2 = 只有编辑者能看` 标注作废并说明"D9 问的读者等级与 `granted` 无关"；§12 **第 15 条标注"已由决定四解决"**（保留原文与两个曾考虑的方向）。
- **连带影响 / 需要在实现时注意**：
  1. **`granted` 档下"谁都看不到"是默认状态**，作者若只写标记不授权，**连自己都看不到**（owner/admin 靠应急权 O1 可看）⇒ UI 必须提示，否则会被当成 bug（§4.1）。
  2. **旧标记 `role=editor` 必须被解析器显式拒绝**（不是静默忽略）—— 这是从 v2/v3 升上来的**存量文档**唯一的兼容风险点。
  3. **`blocks.tier` 从 `NOT NULL DEFAULT 0` 变成可为 `NULL` 且无默认** ⇒ 失去"忘记算 tier 会响亮失败"的保护，**必须**靠 §8.2 P3a 第 10 条的探针兜住。
  4. **索引体积与 D10 无关**：`granted` 块仍然进 `blocks_fts`（只是靠授权分支命中）⇒ **没有额外索引体积增长**；反之，若将来启用"只索引 `tier=0`"运维开关，**授权段落也会一起搜不到**（§4.3 取舍表下的 v4 注）。
  5. **`page.visibility='private'` 完全不受影响** —— 页面级第三档的名字与语义都不变（"仅被显式授权的人"）。**v4 只动块级。**
- **仍未解决 / 待拍板**：§10.4 的 **D9–D10** ~~仍待拍板~~ → **★ v5 已拍板**（见 §13.3）；`page_versions` 无上界增长（§9 R16）的缓解方向仍是"仅记录方向、未定"。
- **★ 未验证项（诚实声明，同 §13.1）**：v4 是**纯文档改动**，**未运行任何代码、未执行任何 SQL、未实测 v4 的检索形态（"等级分支 OR 授权分支"尚未实测）**，也未验证 `NULL` 在 `blocks.tier` 上的实际查询计划。本次实际做过的核对只有：① 全仓库 grep `role=editor` / `minRole` 已随本次改动从本文件清除（仅剩刻意留痕处）；② `block_grants` 的索引清单是**逐个读 §3.7 的 DDL 原文核对**得出（发现缺 `(subject_kind, subject_id)` 索引）。**v4 的检索 SQL 与 `NULL` 取值必须在实现前实测复核**（§4.3 已就地标注）。

### 13.3 ★ v5 定稿记录（依据 = 用户的第五项决定：锁定 D7/D8/D9/D10 的默认值并定稿）

- **决定内容（全部按文档原有推荐值拍板）**：
  | # | 决定 | 落点 |
  |---|---|---|
  | **D7** | **保留 `GEEWIKI_ADMIN_TOKEN`，但生产默认关闭**（未设置环境变量即禁用）；每次使用写审计，`actor` 记为 break-glass 来源 | §10.1 D7、§8.1 P0（落地方式）、§8.2 P0 新增第 5/6 条 |
  | **D8** | **P2 上线时把存量条目一次性回填为 `org`**；`public` 仍须管理员**显式发布**，不会被批量设置 | §10.1 D8、§8.1 P2（新增回填步骤）、§8.2 P2 新增第 13 条、§3.3（与 DDL 默认值的关系） |
  | **D9** | **搜索密级 2 档**（匿名 / 组织成员），不给 guest 单开一档 | §10.1 D9、§10.4 D9（选项与后果分析原样保留 + 末尾"★ v5 采纳结论"） |
  | **D10** | **索引全密级收录（`tier ≤ 1`）**；"只索引匿名层（`tier = 0`）"是**非默认的运维开关** | §10.1 D10、§10.4 D10、§4.3 结论下的 v5 定稿注、§10.2 D5 行 |
- **改动清单**：① 头部状态行改为 **v5 定稿版**（12 项已拍板 + "本文档已无待决项" + "**定稿 ≠ 已实现**"的显式警告）；② §10 标题改为"决策清单（已全部拍板）"、§10.1 由 8 行扩为 **12 行**（新增 D7–D10）；③ §10.2 的 D5 行标注"运维开关**非默认**"；④ **§10.3 不删**，改为"**已全部拍板**"的指针 + 推荐原文留痕；⑤ §10.4 标题与 D9/D10 标记改为**已拍板**，两处选项分析**完整保留**，各补一段"★ v5 采纳结论（选了哪个、为什么）"；⑥ §4.3 标注"只索引 `tier=0`"**非默认**；⑦ §8.1 的 P0/P2 两行分别补 D7 落地方式与 D8 回填步骤；⑧ §8.2 的 P0 补第 5/6 条（未设环境变量 ⇒ 令牌通道完全不可用；break-glass 使用留痕）、P2 补第 13 条（回填的四向断言）；⑨ §3.3 新增"`pages.visibility` 两层默认值"说明；⑩ §12 增加**逐条核对状态表**并对第 6/8/9/11/12 条就地标注；⑪ 新增 **§12 第 18 条**（两层默认值为说明性留痕）。
- **★ 派生项（用户要求标明，这是 D8 的自然推论，**未经单独拍板**）**：`pages.visibility` 的**两层默认值** ——
  - **DDL 默认 = `'private'`**（失败关闭：任何"忘记设置"的写入路径落到最严档）；
  - **应用层新建条目默认 = `'org'`**（团队内部可见，本产品常态；也是 D8 回填的档）。
  两层**不冲突**，已在 **§3.3 的 v5 注**里写清，并在 **§12 第 18 条**留痕，以免后人只看 DDL 就误以为"新建页面默认私有"。
- **§12 逐条核对结果**：17 条全部核对，**无一条被删除**。已解决：1/2/3/4/5/6/7/8/9/10/14/15/16；非矛盾说明：17，以及 v5 新增的 18；**仍未解决但不属待决项**：11（可选简化，实现期风格选择）、12（迁移最终编号需复核）。其中**第 8 条特别说明：`901` / `8192` 是任务提示词自身的错误，文档无误**（文档从未写入这两个值）。
- **★ 定稿声明（必须与"已拍板"一起读）**：
  1. 本文档是**设计稿**，**尚未实现**：文中所有表、DDL、端点、SQL、测试断言都**没有落到代码里**，本次五轮修订**全是纯文档改动**（只用 `edit` 工具），**未运行任何代码、未执行任何 SQL、未跑任何迁移**。
     > **★ v7 就地订正**：本句描述的是 **v5 定稿当时**的状态。到 **v7** 时，**P0 与 P1 已合入 `main`**（合并提交 `e708814` / `f3990a9`），**P1.5 / P2 正在实现中** —— 因此"没有任何表/端点落到代码里"**已不再成立**（`0010_identity.sql` / `0013_audit.sql` 与 `packages/plugin-auth` 均已存在；见 §8.1 各行与 §13.5）。
  2. 因此本定稿的含义是"**设计层面已无待决项**"，**不是**"已实现/已验证"。文中的"待决策项"已清零，但"**未验证项**"仍在，典型如：块级检索的 **"等级分支 OR 授权分支" 形态未实测**、`blocks.tier` 用 **`NULL`** 的实际查询计划未验证、**索引体积倍数需在自有语料上实测**、**迁移序号是否从 `0010` 起编**。
  3. **实现前必须按 §12 与各章的「原文如此，实现前需复核」逐条复核**；凡本文标"（原文如此，实现前需复核）"处，**不要照着猜**。
  4. 全文既有 `文件:行号` 引用**沿用原始调查与两轮设计、五轮修订均未逐条复核**（仅抽查过 3 处：`packages/plugin-wiki/src/index.ts:274` 的 `isValidSlug`、同文件 `:672` 的 `savePage(...)` 调用、`packages/server/src/index.ts:131` 的 `AsyncLocalStorage<RequestState>`）。
  5. 本次修订事实核对（仅此两项）：① 全仓库 grep 确认 ACL 相关标识在 `*.ts`/`*.tsx`/`*.sql` 中**零命中**（⇒ 未实现，改动不会与代码冲突）；② `ls` 核实双方言迁移目录的现有编号与 §12 第 12 条所述一致。
     > **★ v7 就地订正**：第 ① 项是 **v5 当时**的事实。到 **v7** 时 P0 / P1 已落地（`packages/plugin-auth` 等已存在），只是**本设计里的 ACL 标识仍未落地**：`page_grants` / `block_grants` 两张表与相关端点**全仓零命中**（`subject_kind` 目前只出现在 `packages/core/src/index.ts:526` 的一句注释里）⇒ P2 / P3 的这部分仍属未实现（P2 正在 `.wt-p2` 上实现，见 §13.5）。

### 13.4 ★ v6 修订记录（依据 = **P0 实现 + 独立代码审查**，**不是**新的用户决策）

- **本次修订的性质（务必与 §13.1–§13.3 区分）**：**v3 / v4 / v5 都是"用户拍板驱动"的修订**（分别依据用户的第三、四、五项决定）。**v6 不是** —— 它由 **P0 阶段的落地实现 + 一轮独立代码审查**驱动，**没有引入任何新的设计决策**，只做三类事：
  1. **回写**：把"实现已定义、文档里从未写过"的 API 形状补成正式章节（**§2.5**）；
  2. **订正**：修掉两条**按字面执行不通 / 自相矛盾**的 P0 验收（**§8.2 P0-1、P0-6**）；
  3. **记账**：把审查**实测到**的泄漏通道记入 P2 交付项（**§8.2 P2 第 14 条**）与 §12（**第 19 条**）。
- **改动清单（五项）**：

  | # | 改动 | 落点 |
  |---|---|---|
  | 1 | **新增 §2.5「服务端路由鉴权：P0 已落地的 API 形状」** —— 六项形状（`RouteAccess` 三档 / `RequestVerdict` / 可选 `use?()` / `dispatch` 返回类型放宽 / `register()` 第 4 参默认 `public` / `judgeAccess` 判定顺序与 401·403·503）+ **两条边界**（钩子链**只对匹配到的路由**生效；`/api/health` **刻意在闸门之外**）+ P0 各端点的等级分配表 | **新增 §2.5**（§2 末尾，§2.4 之后）；§0.1 ② 就地订正；§8.1 P0 行；§9 R2 / R6 交叉引用 |
  | 2 | **订正 §8.2 P0-1 的命令**：`POST /api/plugins/@geewiki/db-sqlite/disable` → `POST /api/plugins/%40geewiki%2Fdb-sqlite/disable`（未编码是 **5 段** ⇒ 不匹配 **4 段**路由 ⇒ 得到 **API 404** 而不是 503） | §8.2 P0-1 |
  | 3 | **解决 P0-6 与 §8.1 的自相矛盾**：`audit_log` 建表在 P1、P0 不建表 ⇒ 原"新增一行"在 P0 **不可满足**。口径下调为"**P0 仅 stdout 留痕 + `TODO(audit-service)`**；P1 建表、P4 闭环"，并写明风险（**日志轮转后应急令牌的使用无迹可查**） | §8.2 P0-6；§8.1 P0 行同步改词 |
  | 4 | **P2 新增第 14 条**：**路由层** `redactConfig(principal)`，**两条路径都要覆盖**（`GET /api/plugins`、`GET /api/session`），**不能改 `snapshotOf()`**；含审查实测的真实向量（`baseUrl` 内嵌凭据被**逐字回显**；密钥值本身因 `apiKeyEnv` / `passwordEnv` 纪律**不会**泄漏）、风险等级（Low–Medium）、**运维缓解建议**，以及一条**待排查项**（`:413` 的 `error` 字段） | §8.2 P2 第 14 条（并改 P2 小标题计数） |
  | 5 | **§12 新增第 19 条**：记录"**文档缺口 → 实现补齐 → 回写文档**"的过程与**根因（章节重排：v1 的 §4 是路由鉴权插入方案，定稿时 §4 被块级内容模型占用、内容未迁移 ⇒ 静默丢失）** | §12 第 19 条 + 现状表追加第 18 / 19 行 |

- **本次修订的核对方式（与前几轮不同）**：v6 **读了实现源码（只读，未改动）**来核对，而不是只读旧文档。核对覆盖：`packages/core/src/index.ts`、`packages/server/src/index.ts`、`packages/manager/src/index.ts`、`packages/plugin-wiki/src/index.ts`、`packages/server/test/route-auth.test.ts`、`packages/server/test/helpers.ts`，以及**密钥纪律**的旁证（`packages/plugin-openai/src/index.ts:116-119`、`packages/db-postgres/src/index.ts:126`、`packages/db-postgres/test/secret-discipline.test.ts`）。
- **★ 未验证项（诚实声明）**：
  1. 本节与 §2.5 新写的 **worktree 行号**取自核对当时的**工作区状态**（提交 `bb43fc2` **+ 一轮尚未提交的修复改动**）。该 worktree 仍在演进 ⇒ **行号可能小幅漂移**，定位请以**函数 / 类型名**为准。
  2. P0 的"实测"结论（**URL 未编码 ⇒ API 404**、**编码后 ⇒ 503 `bootstrap_required`**、**`/api/health` 不过闸门**、**`baseUrl` 内嵌凭据会被回显**）来自**本轮独立代码审查的复现记录 + 实现自身的测试**；**本次 v6 修订没有亲自把服务跑起来复现**（本次约束：只改文档）⇒ 凡本节新写的状态码行为，**以 §8.2 的 P0 验收为准，实现前请按 §12 与各章标注复核**。
  3. §12 第 19 条里"**v1 的 §4 是路由鉴权插入方案**"**无法在仓库内核验**（无 v1 存档），已在该条就地标注来源。
  4. `packages/manager/src/index.ts:413` 的 `error` 字段是否泄漏连接信息 ⇒ **待排查**（审查未实测到），**不要当成已确认**。
- **★ 不变的要求（继承 §13.3 第 3 条）**：本文其余仍标「**原文如此，实现前需复核**」的地方，**本次修订一条都没有验证过**，**不要照着猜**。v6 的范围**严格限于上面五项**；§12 的既有 18 条**一条都没有被删除**（只增补与就地标注）。

### 13.5 ★ v7 修订记录（依据 = **P1 / P1.5 实现反馈 + 一次 PostgreSQL 实机试跑**，**不是**新的用户决策）

- **本次修订的性质（务必与 §13.1–§13.3 区分）**：**v3 / v4 / v5 都是"用户拍板驱动"的修订**（用户的第三、四、五项决定）；**v6 是"P0 实现 + 独立代码审查"驱动**；**v7 同样不是用户决策驱动** —— 它由 **P1 / P1.5 阶段的落地实现**与**一次 PostgreSQL 实机试跑**驱动，**没有引入任何新的设计决策**，只做三处**订正**（一处表述、一处补章、一处记账）。
- **改动清单（三项）**：

  | # | 改动 | 落点 |
  |---|---|---|
  | 1 | **§7.2 的 `link_ticket` 由"存 DB"改为"HMAC 签名的自包含票据，不落库"** —— 原文与 §7.6 的"迁移增量 0"**不可兼得**（§3.1 里没有存 ticket 的表）；补**安全性论证**（绑定同时要求"持有有效 ticket"**且**"以目标账号的本地会话登录"⇒ 与落库**等价**，"被重放"的顾虑不成立）、**"一次性"由 `idx_identities_issuer_sub` 唯一索引兜底**、**为什么不新增迁移**、以及两条**失败关闭**方向的代价 | **§7.2** 表格行 + **新增 §7.2 的 ★ v7 小节**；**§3.1** 的 ★ v7 核对；**§12 第 20 条** |
  | 2 | **§4.3 补"明确的方言语义"** —— `blocks_fts` 沿用 FTS5 ⇒ **全文检索仅支持 SQLite**（**已知且经权衡的限制，不是遗漏**）；PG 部署下 `@geewiki/search` **显式拒绝激活**（**不是静默恒空**，判据用方言、文案见源码）；PG 等价物是 `tsvector` + `pg_trgm`，且整套 tier 分层可见性要在 PG 上重做 ⇒ **明确列为非目标**；另记一个**诊断体验问题**（迁移控制器在激活前仍会执行 FTS5 语法的迁移脚本 ⇒ PG 上必然失败回滚、日志里是 PG 语法错误而不是那句方言拒绝文案）⇒ **可选改进项，不阻塞任何阶段**；并据此把 §8.2 P3a 的 FTS 相关验收项**逐条标注"仅 SQLite"** | **§4.3 新增 ★ v7 小节**；**§4.3** 迁移示例的"PG 侧不执行本文件"就地订正；**§8.1 P3a 行**；**§8.2 P3a**（小标题 + 第 3/4/5/6/7/8/9/10/11 条逐条标注）；**§12 第 21 条** |
  | 3 | **记录进度事实与方法学事实**（简短，不喧宾夺主） | **头部状态行**（v7 + 进度）；**§8.1** 的 P0 / P1 / P1.5 / P2 / P3a 五行；**§13 的 ★ v7 补充**；本节的下面两段 |

- **进度事实（v7 核对当时）**：
  - **P0 已合入 `main`** —— 合并提交 **`e708814`**（分支 `feat/p0-route-auth-guard`，基线 `bb43fc2` + 一轮修复改动）。
  - **P1 已合入 `main`** —— 合并提交 **`f3990a9`**（分支 `feat/p1-identity`，基线 `e708814`，tip `4b19e7b`；29 文件 / +3617 −23，改动文件与 `main` 无交集）。**P1 的落地记录称"791 例测试全绿"** ⇒ ★ 本轮**未复跑测试**，且仓库的提交信息与既有文档里**没有**这个数字 ⇒ 按"**实现方报告**"记录，**不要当成已核验事实**。
  - **P1.5（OIDC）正在 `.wt-p15`、分支 `feat/p15-oidc` 上实现**（**堆叠在 P1 的 tip `4b19e7b` 上**）。核对当时该工作区**有未提交改动**（含**尚未跟踪的新文件** `packages/plugin-auth/src/oidc.ts` 与 `packages/plugin-oidc/`）⇒ **它尚未定型**。
  - **P2（组织与条目可见性）正在 `.wt-p2`、分支 `feat/p2-org-visibility` 上实现**（**基线 `f3990a9`**；核对当时有 1 处未提交改动）。
  - 两个 worktree 的分支名与 HEAD 已用 `git -C <worktree> rev-parse --abbrev-ref HEAD` 逐个核对（`.wt-p15` @ `4b19e7b`、`.wt-p2` @ `f3990a9`）。
- **★ 方法学事实（必须留痕，属已知风险）**：**P1 阶段的"独立代码审查 agent 未在合理时间内返回结论"** —— 也就是说，**P1 并没有完成过一次独立的对抗性审查**。最终由**编排者直接核实**了以下关键安全项：
  1. 会话令牌**只存 `sha256`**（不落明文）；
  2. cookie 属性（`HttpOnly` + `SameSite=Lax` + 生产 `Secure`）；
  3. **CSRF 的 Host 头缺陷已修为"失败关闭"**；
  4. 口令与应急令牌的比较使用 **`timingSafeEqual`**；
  5. 登出为**服务端吊销**（`revoked_at`，**不是**仅客户端删 cookie）；
  6. 既有测试断言**只增不减**。
  **⚠️ 但这不等于一次完整的对抗性审查** —— 它是**逐项核对清单**，覆盖的是"实现方声称做了什么"，**不覆盖"还有哪些没想到的路径"**。本条**作为已知风险留痕**：P1 的读路径与边界条件**缺少一次独立的对抗性视角**，建议在 P2 阶段补一次（或至少在 P2 的验收标准里显式覆盖 P1 留下的边界）。
- **本次修订的核对方式（与 v6 同源、但对象不同）**：v7 **读了实现源码（全部只读，未改动任何代码）**，而不是只读旧文档。覆盖：`.wt-p15/packages/plugin-auth/src/oidc.ts`、`.wt-p15/packages/plugin-auth/src/index.ts`、`.wt-p15/packages/plugin-auth/src/http.ts`、`packages/db-sqlite/src/migrations/0010_identity.sql`、`packages/plugin-search/src/index.ts`、`packages/plugin-search/migrations/0001_search.sql`、`packages/manager/src/index.ts`、`packages/manager/src/discovery.ts`、`packages/server/src/index.ts` 的内置插件注册表段，以及 `git log` / `git rev-parse` / `git status`（含四个 worktree）。另外核对了"迁移目录按方言取"这条链路的**三个环节**（manifest 声明 → `resolveMigrationsDirs` → 控制器的方言回退），因此 §4.3 那段诊断体验问题的**根因是逐行核实过的**，不是推测。
- **★ 未验证项（诚实声明）**：
  1. 本轮**没有运行任何代码 / 测试、没有执行任何 SQL、没有跑任何迁移**（约束：只改文档）。**"791 例测试全绿"未复跑**（见上）。
  2. **PG 的失败日志来自编排者的实机试跑**（容器 `geewiki-pg-test`，`postgres:15-alpine`），v7 只做了**根因核实**（读源码 + 读迁移脚本），**没有亲自再跑一次**复现那条 `syntax error at or near "VIRTUAL"` ⇒ 该日志文本以编排者的记录为准；行号级的根因解释是本轮**独立核实**的。
  3. **P1.5 的源码行号取自"未提交的工作区状态"**（`.wt-p15` @ `4b19e7b` **+ 若干未提交改动**，`oidc.ts` 甚至尚未被 git 跟踪）⇒ **行号可能明显漂移，定位请以函数 / 常量名（`signLinkTicket` / `verifyLinkTicket` / `TICKET_TTL_MS` / `LINK_COOKIE`）为准**。
  4. **§8.2 P3a 第 3 / 10 条有一处待复核**：`tier` 一致性探针的报警被 §4.3 挂在 `GET /api/admin/search/verify` 上，而该端点**是否随 `@geewiki/search`（仅 SQLite）提供**文档里从未写明 ⇒ 若是，则 **PG 部署下"静默漏算"的告警没有落点**。本轮**不臆断**，已就地标为待复核。
  5. 全文既有的 `文件:行号` 引用**仍未逐条复核**（继承 §13.3 第 4 条）；v7 只核对了**本次新增内容所引用的行号**。
  6. v7 **未修改 §12 的任何既有条目**（第 1–19 条原文保持），只**新增第 20 / 21 条**并在其现状表里追加两行。

### 13.6 ★ v8 修订记录（依据 = **P2 / P3a–P3d / P4 实现反馈 + 多轮独立审查**，**不是**新的用户决策）

- **本次修订的性质（务必与 §13.1–§13.3 区分）**：**v3 / v4 / v5 是"用户拍板驱动"**；**v6 是"P0 实现 + 独立代码审查"驱动**；**v7 是"P1 / P1.5 实现 + 一次 PG 实机试跑"驱动**；**v8 与它们都不同** —— 它由 **P2 / P3a / P3b / P3c / P3d / P4 的落地实现 + 多轮独立审查**驱动，**没有引入任何新的设计决策**，只做**订正与回写**。
- **★ 本轮最重要的判断**：这次修订里**只有一条属"安全相关的方向性错误"**（第 1 条），**其余都是"文档与实现不一致"或"文档低估了成本"**。**⇒ 不要把它们当成同等严重的事**；但也**不要因为它只错了一处就轻视** —— 那处错误的方向恰好落在"**匿名能搜到本该受限的内容**"上。

#### 改动清单（四项 + 十一条就地补正）

| # | 改动 | 落点 |
|---|---|---|
| 1 | **§2.3 规则 B1 的方向写反 ⇒ 按 `tier` 刻度订正为 `max`**（**安全相关**）：补**真值表**（照抄 `packages/plugin-wiki/src/blocks.ts:220-234`）与"**这不是两种规则，是同一条『只能更窄』的两种刻度**"这句总结；说明**两套刻度方向相反**、**写反会让"页面 org + 块 public"的块拿到 `tier = 0`** ⇒ 匿名在站内搜索里搜得到；给出**权威实现落点**（`tierFor` / `blockLevelOf` / `BlockTier` / `PageLevel` / `RANK_*` 同为窄度刻度）；记录该错误**曾扩散到 4 处代码注释、已全部订正**并给出**复核命令与"不要误判"的判读方法** | **§2.3 规则 B1**（重写）；§2.0 阶梯句；§2.3 的 B2 裁决顺序第 2 步；§4.3 的 `tier` 冗余列段；§9 R13；§12 第 22 条 |
| 2 | **§4.3 补 P3a 的方言成本**：新增小节「**★ v8：P3a 的方言成本**」—— **三个只在真实 PostgreSQL 上暴露**的缺陷（① 写块靠捕获异常判 `blocks_fts` 存在、只匹配 SQLite 文案；② 缺 `RETURNING id`；③ `deletePage` 的 `DELETE FROM blocks_fts` 无方言守卫），逐条给**现象 / 根因 / 修法 / 订正提交**；记录缺陷 ③ **为何长期未被发现**（e2e 阶段 G/H/I/K 直读 SQLite 文件、PG 下整体跳过）；补**结论性提示**与**两条派生要求** | **§4.3 新增 ★ v8 小节**；§4.3 的"列为非目标"句就地订正；**§8.1 P3a 行**；§12 第 23 条 |
| 3 | **新增 §4.6「跨阶段不变量 —— 写了 `pages` 的档位，就要补齐子孙 `tier`」**：提为**独立小节**（不再只当 §9 R13 的一条风险）；含**不变量的一句话表述**、**失效过的三次**（含审查复现的具体 slug 与泄漏词 `CHILDUNIQ777` / `DEEPUNIQ999`）、**`continue`/`break` 不对称的根因**、**为什么扇出必须在提交之后**（`pageLevelOf` 走另一条连接、PG MVCC）、**失败升级为一等可观测信号的三件套**（`ResyncReport` / `acl.resync_failed` / `index_tiers_resync_failed`）、**四个调用点**、**验证必须覆盖四条路径**与**红-绿自检证据** | **新增 §4.6**（§4.5 之后）；§4.3 两处；§9 R13（显著加强 + 交叉引用）；§12 第 24 条 |
| 4 | **其余十条逐条补正**（含一条"实现偏离"的措辞订正） | 见下方"就地补正清单"与 **§12 第 26 条** |

#### 就地补正清单（第 4 项的展开）

1. **§3.6 的迁移落点是错的**：`@geewiki/wiki` 的迁移目录**只声明了 sqlite**（`packages/plugin-wiki/src/index.ts:112` 的 `WIKI_MIGRATIONS_DIR` → `packages/server/src/index.ts:1405` 的 `builtinMigrations(wikiManifest, { sqlite: … })`）⇒ 照原文写，**PG 部署下 `blocks` 表根本不会被建出来**。实际落在 **db 包、两侧成对**（`packages/db-sqlite/src/migrations/0015_blocks.sql` 与 `packages/db-postgres/migrations/0015_blocks.sql`）。
2. **`tier` 必须内联在 `CREATE TABLE` 里**（不是另起 `ALTER TABLE … ADD COLUMN`）：SQLite 没有"加列时若已存在则跳过"的语法 ⇒ 独立 `ALTER` 会让迁移**无法重放**。§3.6 的 DDL 已按实情改正（该列已从 `ALTER` 移到 `CREATE TABLE` 内，并保留"故意不给默认值"的理由）。
3. **§9 R9 写错**：把 `navOrder.test.ts（导航合并）` 列为"P2 必然触碰" —— 该文件测的是 `packages/web/src/lib/navTree.ts` 的**上一篇/下一篇顺序**（`packages/web/test/navOrder.test.ts:11`），**与顶栏导航无关**（审查用 `git diff --stat` 证明其 diff 长度 **0 行**）。**顶栏导航真正的守卫是 `packages/web/test/navGate.test.ts` 与 `navPlan.test.ts`。**
4. **config 脱敏的判据被放宽（有据）**：文档只写 break-glass，实现为 **break-glass 或 `orgRole ∈ {owner, admin}`**（`packages/manager/src/index.ts:1574-1579` 的 `mayReadPluginConfig`）。**理由**：写文档原文时（P1）还没有真实角色，`org_members` 是 P2 才建的；只认 break-glass 会让**登录为 owner 的管理员拿不到 `config`、配置表单无法回填**；放宽**不重新打开匿名泄漏**。**两条通道都必须堵**：`GET /api/plugins` 与 `GET /api/session`（后者经 `PluginListFile.enabled[].config`）；且**不能改 `snapshotOf()`**（改了会打瞎配置表单）⇒ 裁剪做在**路由层**（`withoutPluginConfig` `:1582` / `withoutListConfig` `:1587`）。**另记**：文档里的函数名 `redactConfig` 在仓库里**零命中**，定位请用上述三个真实名字。
5. **`snippet()` 是静默失败**：文档写"不可用"，实测是**返回 `null` 而不报错** ⇒ 若实现里用了它且没防护，**高亮会静默变空**，**测试不专门断言高亮内容就发现不了**。
6. **§8.2 的 P2 验收 1–14 全是后端项** ⇒ M5 那批工作**没有设计文档层面的验收标准**（其规格来源是**实现者留下的 TODO**）。已补 **P2 第 15 条**（前端 IA，含 ①–⑤ 与已知未完成项）。
7. **`blocks_fts` 只索引块文本** ⇒ **FTS 路不再按标题匹配**（**LIKE 短查询路仍匹配标题**）。这是 §4.3 SQL 形态的直接后果，已被断言钉住（`packages/plugin-search/test/search.test.ts:558`、`:575`）。
8. **`系统状态`（服务健康 / DB 方言 / 表清单）随 `管理 ▾` 下沉为管理员专属** —— 文档里 `grep 系统状态\|服务健康` **零命中**（规格从未表态，属**文档缺口**而非实现偏离）。**编排者裁定：维持管理员专属**（内容是运维细节，与所在分组的"运维台面"语义一致）。**`GET /api/health` 本身仍是公共端点**（`HEALTH_PATH` 在 `packages/server/src/index.ts:583` 内联处理、**不过 `access` 闸门**），看门狗不受影响。
9. **§2.3 的"匿名 404 / 已登录 403"与实现有偏差**：实现对**所有主体一律 404**（区分 404/403 等于提供一个**匿名可用的存在性探测接口**）。这个选择**更严**，但**代价是"申请访问"失去自然触发点**（用户拿到 404 时分不清"无权"还是"不存在"）⇒ 申请入口必须由前端在**已知 slug** 的拒绝页 / 受限块占位文案上提供。
10. **§8.2 的 P4 第 6 条按字面无法执行**：原文要求"代码中**无**删除 `page_versions` 行的路径"，但 `deletePage` 本就要删掉**被删页自己的**版本（**页面生命周期级联**，与 D11 反对的"保留策略清理"是两回事）。**按字面写会让守卫与既有合法代码冲突、然后被人放宽 —— 那等于没有守卫。** 实现落成"**白名单 + 锚定**"：只允许**一处**、且必须**锚定在 `deletePage` 内**（`packages/plugin-authz/test/audit-appendonly.test.ts:121` 起；扫描正则 `:131`、前置断言 `:132`、锚定断言 `:153-154`）。
11. **（实现偏离，措辞订正）`acl_revision` 全仓无读取方** ⇒ 文档与代码注释里"判定单点按 `acl_revision` 做**代际失效**"属**过度声明**。`packages/plugin-authz` **没有决策缓存、每请求现查库** ⇒ 结论（**被批准者无需重新登录即可见**）**仍然成立，但理由不同**：**不是**"版本涨了触发失效"，而是"**本来就没有缓存可失效**"。**保留真正那条禁令：不要给判定层加 TTL 缓存。** 已订正 §2.3 例子表、§3.3 / §3.4 DDL 注释、§4.4 恢复步骤、§8.2 P2-4 / P3b-6、§9 R5（前端 `pagesStore` 其实**不会**因权限变更自动失效 —— 触发点是 `login`/`logout` 与写操作之后的**显式失效**）、§9 R10 第 3 条、§9 R13。

#### 进度事实（v8 核对当时）

- **`main` = `5536bfa`**（提交信息：`merge(ops): P4 审计与运维闭环 —— 越权告警、会话管理与过期回收`）。
- **已合入 `main`**：**P0 / P1 / 文档 v7 / P1.5 / P2（含 M5 前三项）/ P3a / P3b / P3c / P3d / P4** —— 即**本文档 §8.1 阶段表里的全部阶段**。
- **★ 仍未做的项（诚实列出，不是"已完成"）**：
  1. **M5** 的**红链三步态 `exists: 'hidden'`**（设计 §6.6 / §5.5 要求保留，本批未实现）；
  2. **P4** 的**反向展开**（"谁能看这条"：直接授予 / 祖先链收紧 / 组织角色覆盖三条来源）；
  3. **P4** 的**运维动作**：门户缓存清理提示（`s-maxage=300` ⇒ 收紧后需"清缓存 + 重新抓取"）、`/sitemap.xml` 与匿名可见集合的**集合差核对入口**；
  4. **`invitations.expires_at` 的回收**（本轮只做了 `page_grants`；`invitations` 在 `packages/plugin-org`）；
  5. **审计页与会话管理页的前端界面** —— 两者**都只有后端端点**，未接界面；
  6. **CodeMirror 内的标记语法高亮 / 自动补全**（P3d 的标记书写体验部分）。

#### 验证基线（★ v8 本轮**实际复跑**的三条；e2e 未复跑）

| 命令 | 结果 | 谁跑的 |
|---|---|---|
| `pnpm typecheck` | **exit 0**（**17 个包**，全部有 `typecheck` 脚本） | **v8 本轮实测** |
| `pnpm test` | **870 例 / 870 通过 / 0 失败**（各包 `# pass` 求和） | **v8 本轮实测** |
| `pnpm build` | **exit 0** | **v8 本轮实测** |
| 六条 e2e **共 282 项断言零失败**：`e2e-p1` **38** / `e2e-p15` **44** / `e2e-p2-org` **44** / `e2e-p2` **34** / `e2e-p3a` **85 / 0 / 0**（SQLite）/ `e2e-p4` **37** | — | **未由 v8 复跑**，按**当时交接稿（已删除）的编排者记录**引用 |

> **⚠️ e2e 那一行必须这样读**：它**不是**本轮核验过的事实，而是**编排者的记录**（与 §13.5 处理"791 例"的方式一致）。**⇒ 需要复现时按 `docs/development.md`「验收与验证纪律」的"验证基线（复现用）"跑**。

#### ★ 方法学事实（本次新增，必须留痕）

- **★ 两条"只在交界处存在"的缺陷，同一个成因**：跨阶段不变量漏扇出（第 3 项，失效三次）与 `blocks_fts` 的方言守卫漏一处（第 2 项，缺陷 ③）**都是"每个阶段各自看自己那一段都对"的缺陷**。
  **⇒ 可复用的两条经验**：① **凡新增一条写共享状态的路径，都要问"谁还要跟着变"**；② **凡新增一个"靠直读 SQLite 文件断言"的 e2e 阶段，都要同时给出方言中立（纯 HTTP）的替代断言** —— 否则该阶段在 PG 下被整体跳过时，**不会有任何信号告诉你它没跑**（这正是缺陷 ③ 藏了整整一个阶段的原因）。
- **★ "断言自己会骗人"的实例（本批踩到多次）**：`index_tiers_resynced: 0` 有**两种含义**（没有子孙 / 扇出整个失败），**没有 `index_tiers_resync_failed` 就不可区分** ⇒ 已把失败升级为可观测信号（§4.6）。同类的还有：e2e 阶段 H 曾按"`tier=0` 的行数"断言（**库里有合法的 `tier=0` 块即假绿**）、夹具的空 `catch {}` 会吞掉真错误而**照绿**（`1d608a6`）。
- **★ 文档注释本身会成为错误的传播媒介**：第 1 条那处错误**正是从本文档抄进 4 处代码注释的**，而"照注释去修正实现"会**直接造出泄漏**。
  **⇒ 可复用的经验**：**引用设计的注释必须写明"哪一份是权威、以及为什么"**，否则注释会先于代码老化。

#### 本次修订的核对方式（与 v6 / v7 同源，但范围更大）

- **只读**通读了 `main`（`5536bfa`）上的实现：`packages/plugin-wiki/src/blocks.ts`、`packages/plugin-wiki/src/index.ts`、`packages/plugin-authz/src/index.ts`、`packages/manager/src/index.ts`、`packages/plugin-search/src/index.ts` 及其迁移、`packages/plugin-search/test/search.test.ts`、`packages/plugin-authz/test/audit-appendonly.test.ts`、`packages/plugin-wiki/test/e2e-p3a.sh`、`packages/web/src/App.tsx`、`packages/web/test/navOrder.test.ts`、`packages/db-sqlite/src/migrations/0015_blocks.sql`、`packages/db-postgres/migrations/0015_blocks.sql`。
- **全仓 grep 复核**：`min(`（含 `Math.min` / `least(`）在迁移与源码里的**全部**出现处；`acl_revision` 的**每一处**出现并逐条分类（列定义 / 递增 / 回显 / 注释 —— **无一处是"读取后用于判定"**）；`snippet(`；`系统状态|服务健康`；`redactConfig|mayReadPluginConfig|withoutPluginConfig|withoutListConfig`；`resync|ResyncReport|index_tiers_resync_failed`；`RANK_PUBLIC|RANK_ORG|RANK_PRIVATE`。
- **跑过三条命令**（见上表）并**核对 git 历史**（`ade59ef` / `1d608a6` 的改动范围与先后关系、`96891db` / `e941da5` / `a3d72b7` / `9699aa7` / `2b5f13d` 的存在性）。
- **★ 只改两个文档文件、未动任何代码**（约束与本轮任务书一致）。

#### ★ 未验证项（诚实声明）

1. **e2e 未复跑**（见上表）。六条 e2e 的断言数与"零失败"结论**来自当时交接稿（已删除）的记录**，**不是本轮核验的事实**。
2. **PG 侧的运行时端到端只覆盖了部分**：三个方言缺陷的**修法与根因**是本轮**读源码 + 读提交信息**核实过的，但**本轮没有起 PG 实例复现**（约束：只改文档）；`grants/purge` 等端点**未在 PG 上跑过**（见 `docs/development.md`「验收与验证纪律」的验证盲区清单）。
3. **真实浏览器交互从未验证**：所有端到端都是 `curl`；前端只有类型检查、守卫测试与 SSR 测试。§8.2 新增的 P2 第 15 条（前端 IA）因此**不是"已验证的验收"**，而是**回写整理的判据**，其中两项**已知未完成**（`capabilities` 不随角色变更刷新、红链 `'hidden'` 未实现）。
4. **`plugin-org` / `plugin-authz` 与 P3a / P3c 新增的辅助函数无单元测试**，**只由 e2e 覆盖**。
5. **多实例部署必然失败**（OIDC 流程状态存进程内，**失败关闭方向**）—— 设计层面已记录，**未验证**。
6. **全文既有的 `文件:行号` 引用仍未逐条复核**（继承 §13.3 第 4 条、§13.5 第 5 条）；v8 只核对了**本次新增内容所引用的行号**。
7. **v8 未修改 §12 的任何既有条目**（第 1–21 条原文保持），只**新增第 22–26 条**并在其现状表里追加五行。

---

## 追加：权限入口的归并（本批）

> **★ 本批 = 基线上 `98b4618` 的未提交工作树。** 改动全部落在 `packages/web`（另有验收脚本 `scripts/acceptance/editor-modes-cdp.mjs`），**无迁移、无端点、无服务端解析规则变更**；本节这几段文档补写也是本批的一部分。
> 本节是**追加记录**：上面 §1–§13 的历史一律不改动，本节只记本批把"权限入口"与"编辑体验"改成了什么样、以及上面哪几条因此被取代。
> **核验方式**：本节每条事实都来自**逐行读工作树里的源文件**（文件路径随文给出）；**没有**跑 typecheck / test / 浏览器。

### 1. 独立的「权限治理」页从导航移除，路由保留为兜底

- `packages/web/src/App.tsx` 的导航常量改为 **`LEGACY_ROUTES`**（唯一条目 `id: 'access'`，`label: '权限治理（已并入页面）'`，`requires: 'manageVisibility'`）。它**不再出现在任何导航里**（桌面标签、窄屏菜单、命令面板都移除），但**仍在 `known` 路由集合内**（`[WIKI_ITEM, ...ADMIN_NAV, ...LEGACY_ROUTES].some(...)`），故 `#/access/...` 仍被 App 认识、不会掉进未知路由。
- `#/access/<slug>` **仍存在但重定向**到 **`#/wiki/<slug>?access=1`**，由阅读页打开「权限…」对话框（`packages/web/src/pages/AccessPage.tsx`）。
- **落点为什么不是编辑页**：阅读页的权限对话框对**所有有 `manageVisibility` 的人**可用 —— 包括**没有正文编辑权**的人（只负责治理的成员）。一律送去编辑页会把这类人挡在门外（编辑页要 `canEdit`），那才是真的功能倒退。查询串 `?access=1` 是**可分享的地址**，不是一次性的跳转副作用。
- `#/access`（无 slug）改为一页说明（标题「权限设置已并入页面本身」，列出三处入口 + 无 `manageVisibility` 时的 warn 说明）。**`packages/web/src/pages/AccessPage.tsx` 与导出名 `AccessPage` 刻意保留**（避免深链与既有引用出现第二个去处）。
- **本文档 §1–§13 里没有"独立权限治理页"这一条设计条目**（本节写入前 `grep 权限治理` 在本文档零命中）—— 本批把它从导航移除，与 §6.6 的"权限跟着动作走"口径一致，不是对某条规格的偏离。

### 2. ~~编辑页新增「权限」区~~ —— **本批末按作者要求已移除**（页面档位的入口只有页面自己的「权限」对话框）

- `packages/web/src/pages/WikiPage.tsx` 的 `WikiEdit` 内新增 `<section aria-labelledby={PERMISSION_SECTION_LABEL_ID}>`（`PERMISSION_SECTION_LABEL_ID` 在 `packages/web/src/lib/domIds.ts`）：页面档位**就地**复用既有 `VisibilitySection`（谁能读 / 是否继承 / 是否发布），旁边一条说明指向"段落档位写在正文里"，按钮「例外授予与访问申请」打开 `PageAccessPanel`。
> **★ 后续订正（同批，作者验收时提出）**：编辑页底部的「权限」区**整体移除**。理由是它把**页面档位**这一"这条目对谁可见"的治理动作放进了**编辑**上下文，而完整的治理界面（档位 + 例外授予 + 访问申请）本来就在页面自己的「权限」对话框里 —— 两处入口既重复，又制造了"同一屏两个可编辑档位控件"的风险（各有本地状态，而"只发改动过的字段"的部分更新会让后者拿旧基线发出反向 patch）。
>
> 移除范围：`WikiEdit` 里的 `<section aria-labelledby={PERMISSION_SECTION_LABEL_ID}>`、「例外授予与访问申请」对话框、`canManageVisibility` / `grantsOpen` 状态，以及 `lib/domIds.ts` 的 `PERMISSION_SECTION_LABEL_ID`；`PageAccessPanel` 的 `sections` 属性随之删掉（它唯一的使用者就是那个对话框，留着是死接口）。**编辑页仍保留**页面档位的**只读**值（`pagePerm`）：工具栏锁按钮要靠它给出"这一段不能比页面更宽"的提示。段落档位不受影响 —— 它一直在**正文**里，由工具栏的锁按钮改写。
>
> **★ 紧接着补回的一处功能缺口（同一个验收回合内）**：块级分区从面板移除后，**"授权给谁"没有任何界面了** —— 而 `granted`（需单独授权）档的语义正是"默认谁都读不到，靠名单放人"。于是作者把一段设成"需单独授权"之后，**连他想给的同事也读不到**，那一档成了死档。
>
> 修法：**把授予放到档位旁边** —— 编辑器工具栏的锁菜单新增「授权给谁…」，打开 `BlockGrantsDialog`（`packages/web/src/components/access/BlockGrantsDialog.tsx`），列出**光标所在那一段**的现有授权并可增删。链路：编辑器（**不发请求**，只交出 `{ ordinal, excerpt }`）→ 宿主 `WikiEdit` → 对话框按 `ordinal` 在 `GET /api/pages/:slug/blocks` 里换成服务端块 id → `BlockGrantEditor` 执行 `POST/DELETE /api/pages/:slug/blocks/:blockId/grants`。
>
> 两条契约后果都在界面里如实表达（不静默）：① **块 id 只有保存正文时才有**，所以"刚写好还没保存"的段落拿到的是「先保存正文，再继续授权」这条出路，而不是一个必然 404 的按钮；② 手上**未保存的改动会让段落序号与上次保存的正文错位**，故对话框顶部永远显示该段摘要（第一行），让作者确认"要授权的就是这一段"。
>
> **★ 授权对象怎么选（作者反馈"所谓的 id 是什么"）**：`subjectId` 是**数据库 id 的字符串形式** —— `subjectKind='user'` ⇒ `users.id`，`subjectKind='group'` ⇒ `groups.id`（判定侧逐字比对：`packages/plugin-authz/src/index.ts` 用主体的 `userId` 与所属组的 id 列表去命中）。而 `GET /api/org/members` / `GET /api/org/groups` **曾经要求管理员**，授权却只要 `manageVisibility` ⇒ 出现过**"有权授权但看不到名单"**的人。**本批已放宽：任何登录用户都能读这两份名单**（`{ access: 'user' }`，`packages/plugin-org/src/index.ts`）——**能看到名单，才谈得上按名单授权**；放宽的边界是"读名单登录即可、**写**（成员角色 / 邀请 / 建组 / 组的成员增删）与 `GET /api/org/invitations` 仍只有管理员"，守卫见 `packages/plugin-org/test/memberDirectory.test.ts`。故界面按三态走（`packages/web/src/lib/subjectDirectory.ts`）：能列名单 ⇒ **下拉选择成员/用户组**（显示"姓名 —— 邮箱"），并把已有授权显示成"爱丽丝（用户 2）"；确知被拒（401/403，放宽后通常只剩未登录或运维把端点改回 admin 的情形）⇒ 手填 id 并说明"看不到名单，id 可在「管理 → 组织」里看到或向管理员索取"；其它失败 ⇒ 手填 + 如实报错（**不谎称没权限**）。有名单时也保留"改用手填 id"的出口（要授权的人可能不在名单里）。**★ 字段只有一份实现**：`packages/web/src/components/access/GrantTargetFields.tsx`（类别 / 授权对象 / 角色 / 到期），**段落授权与页面授权共用**——这条是补出来的：放宽名单端点时只改了编辑器那一份，页面「权限」对话框里的「例外授予（页级）」仍是手填「对象 id」，旁边还留着放宽之前的理由"成员/组列表需要组织管理员权限，本页不拉取它"（作者反馈："权限按钮进去那个页面的还不能下拉选择用户"）。两处各修一遍必然再漂一次，故字段本体只留一份，两处都从这里取（源码级守卫在 `packages/web/test/blockGrantsInEditor.test.ts`，浏览器端到端在验收脚本 M3–M5）。
>
> 授予表单**只有一份实现**：`BlockGrantEditor` 同时被对话框与 `BlocksSection`（只读总览，当前无界面渲染它）使用 —— 两份必然漂移，而漂移的后果是"两处授权结果不一致"。守卫见 `packages/web/test/blockGrantsInEditor.test.ts`（含一条既有约定的机器检查：**编辑器不得值导入 `api`、不得 `fetch`**）。
>
> 同期另一处：权限对话框里的**块级分区**（`BlocksSection`：逐块档位与逐块授权名单）从面板移除。段落档位就是正文里的标记，改它在编辑器里；而"给某一段单独授权"要先把那段标成 `granted` 才有意义 —— 那件事也发生在编辑器里。**代码与端点都保留**（`components/access/BlocksSection.tsx`、`GET /api/pages/:slug/blocks` 与块授权端点），要恢复只需把它加回面板渲染。

- ~~打开该对话框时**显式传 `sections={['grants','requests']}`**；`PageAccessPanel` 因此新增**可选的 `sections` 属性**~~（该属性已随编辑页权限区一并删除，见上方订正）。
- 三种兜底各有**可见**文案、不静默：新建页（还没落库）/ 无 `manageVisibility`（"正文仍可编辑"）/ 正在读取档位。

### 3. 段落档位在编辑器里改 —— **不是新端点**

- 工具栏的锁按钮（`packages/web/src/components/editor/EditorToolbar.tsx`）与源码模式下手写的标记，改的都是**正文里的 gated 标记**；改写走 `packages/web/src/lib/editorBlocks.ts` 的 `applyBlockTiers` / `setBlockTier` / `setRegionTier`。
- 它采用**整篇重建 + 自检**：重建后重新解析，**块数不变、每块文本一字不变、每块档位等于目标值**，任一条不成立就**放弃改动并返回错误**（"宁可不改，也不留一份自己都不确定的标记结构给服务端"）。正文原本就有解析问题、或存在**空的**受限区段时，同样直接拒绝改写。
- **服务端没有新端点**：保存正文时仍由 `packages/plugin-wiki/src/blocks.ts` 重新解析标记，`syncBlocksForPage` 仍是 `blocks` 的唯一写入路径。故段落档位与正文**同一条保存路径、同一份版本历史**（§4.1 的"标记就是普通文本、CodeMirror 零改造"这条设计前提不变）。
- `packages/web/src/components/access/BlocksSection.tsx` **仍然没有档位改动控件** —— 这是对的（块档位就是正文的一部分，凭一个按钮改写正文会绕开草稿、冲突检测与版本校验）；它的文案把作者指向**编辑器的锁按钮**。**★ 同批末：该组件已不再被任何界面渲染**（见上方订正的第二段），文件与它依赖的端点都保留。§6.6「块级共享面板」与 §8.1 P3b 行里的「内容块」治理面板因此**仍是只读清单**：**改块档位要改正文**。

### 4. 相邻改动：编辑区改单栏 + 编辑器两模式（一并记在这里）

- 编辑页原先的**左右分屏预览已去掉**（写的地方窄、看的地方也窄），预览改为「按访客视角预览」**对话框**：渲染的是**真的**投影后 HTML（含可见性判定与视角切换、"该视角下 N 段内容被遮蔽"），与编辑器的**就地渲染**不是一回事 —— 就地渲染不会替你算可见性。
- 编辑器两模式：**源码** / **实时渲染**（`packages/web/src/lib/editorModePlan.ts`；localStorage 键 `gw.editor-mode.v1`，默认 `live`；就地渲染实现在 `packages/web/src/components/editor/liveRender.ts`）。模式只影响**编辑区怎么画**，不影响正文内容与保存结果（装饰全是 `Decoration`）。
- **边界（必须照实读）**：能渲染的是**行内标记与图片**，以及**整块**的表格 / 围栏与缩进代码块 / 整块 HTML / 分隔线 —— 块内容由 `mdToHtml`（marked + DOMPurify）渲染并套 `.md-body`，与阅读页**同一套**，故"实时渲染里看到的就是发布稿"；渲染块是**只读投影**（点它即把光标送进这一块的源码）；**段落内部的行内 HTML 标签按源码显示**（逐个替换会丢掉标签之间的内容）；**整块被替换 ≠ 权限提示消失** —— 落在受限区段里的渲染块会带上区段的底纹类名。**实现上不可改回 `ViewPlugin`**：块装饰只能由**静态**装饰提供（`StateField` + `EditorView.decorations.from(field)`，判据是 facet 值 `typeof d === "function"`），插件路径会抛 `RangeError: Block decorations may not be specified via plugins`；块装饰范围还必须与**行边界**对齐（`packages/web/src/lib/liveRenderPlan.ts` 的 `alignToLines()`）。**实时渲染模式下不显示行号**（软换行的段落会占好几屏、行号却只递增一次，"会撒谎"）；正文 gated 标记不合法时**不做任何装饰**（该看到的是标记报错）。**排版工具栏**（15 个格式动作 + 撤销/重做 + 附件 + 段落权限锁按钮）的动作是 `packages/web/src/lib/markdownActions.ts` 的纯函数，CodeMirror 路径与降级 `<textarea>` 共用；降级态**不渲染**模式切换、撤销/重做与段落权限控件，并用一行可见文案说明降级了什么。

### 5. 本批取代/未动的清单（对着上面的章节读）

- **被取代**：§6.6 的「预览为匿名视角」行所描述的**内嵌编辑器预览**（含其 `WikiPage.tsx:1135-1140` / `:1670` 行号引用）—— 现为「按访客视角预览」对话框（已在 §6.6 该行与 §8.1 表下就地标注）。§8.1 的 P3d 行写的"编辑器预览"同理；而该行里并列的**块级可见性侧栏**本批**也没做**（做的是工具栏锁按钮 + 弹窗里的只读块清单，见下条）。
- **未被取代、只是确认**：§6.6「块级共享面板」/ §8.1 P3b 的「内容块」面板仍是只读（见上）；§4.1 的标记语法与 `parseBlocks` 契约一行未改。
- **本批未做**：`editor-toolbar-slots` 这类**插件扩展点**（本批的工具栏是**宿主内置**的，不是插件可贡献按钮的插槽）；标记的**语法高亮 / 自动补全**；块档位的"侧栏"形态（现在是工具栏锁按钮 + 弹窗里的只读清单）。




### 6. ★ 编辑路径的正文口径：新增 `?content=raw`（本批修掉的一处**权限事故**）

**事故（改前，实测复现）**：详情接口返回的是**按读者投影后**的正文 —— 受限段落被换成占位文案、`<!--gated:org-->` 这类标记被消费掉。编辑页此前用的正是这份正文，于是最普通的一次操作（打开编辑页 → 改一个标点 → 保存）会把标记写没：

```
改前：公开页 + <!--gated:org--> 段 → 编辑者改一个标点后保存
结果：库里的标记消失；页面本就是 public + published ⇒ 匿名访客直接读到该受限段落全文
```

**为什么它一直没被发现**：投影对**读者**是正确的（这正是 §2.4 约束 1 要的），而"作者的正文来源"从来没被单独审视过 —— 两条路径共用同一个端点，且共用时看起来毫无异常（都是一段 Markdown）。

**修法（本批）**：详情端点新增显式口径 `GET /api/pages/:slug?content=raw`。

- **权限**：必须是 `canEdit`。不可编辑者 ⇒ **显式 403 `raw_requires_edit`**（不是 404 —— 只读用户可能读得到这一页，对他说"页面不存在"是撒谎；也不是静默降级成投影，那会让调用方以为拿到了原文）。`content` 参数取其它值 ⇒ **400 `invalid_content_mode`**，同样不静默。
- **不新增暴露面**：能编辑这一页的人本来就能从版本快照端点（`GET /api/pages/:slug/versions/:id`，同样要求 `canEdit`）读到含标记的原文。
- **响应自述口径**：原文模式下多一个 `contentMode: 'raw'`（`WikiPageDetail.contentMode`）。两种正文长得几乎一样，而**拿错口径的后果不对称**：把投影当原文存回去会毁标记，故响应必须自己说清是哪种。
- **编辑页只走原文**：`packages/web/src/pages/WikiPage.tsx` 的 `WikiEdit.load()` 用 `api.page(slug, { raw: true })`；`packages/web/src/test/editContentSource.test.ts` 用源码级守卫钉住这一点（不得用默认口径填充正文），服务端用例见 `packages/plugin-wiki/test/service.test.ts` 的「★ 原文模式」。
- **第二道防线（客户端）**：`looksProjected()`（`packages/web/src/lib/gatedPreview.ts`，与占位文案同源）识别"手上的正文里有服务端占位"，编辑区给 `role="alert"` 提示、保存前拦一次并给出两条出路（「重新加载原文」/「仍然保存」）。它覆盖的是**修复之前留下的 localStorage 草稿**与用户粘贴这类路径 —— 那些正文里已经没有标记了，服务端无从判断是"作者有意删除"还是"被投影吃掉"，所以只能在编辑侧拦。

**验收**：`scripts/acceptance/editor-modes-cdp.mjs`（浏览器端到端，22 项，含"改档位只动这一段/⌘Z 一次还原/匿名视角不泄露受限段"）；`packages/web/test/editContentSource.test.ts`、`packages/plugin-wiki/test/service.test.ts`（原文模式四条断言）。
