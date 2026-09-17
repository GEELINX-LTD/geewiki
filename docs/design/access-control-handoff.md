# 访问控制实现进度与交接

> **本文件是状态交接，不是设计说明。** 设计与规格看 `docs/design/access-control.md`（**v8，2437 行**）。
> 用途：让下一任（人或 agent）能在不看历史对话的情况下接手剩余工作。
> **维护要求：每完成一个阶段、或发现一条规格错误，就把事实写进这里。** 对话上下文会被压缩，这里不会。
> **★ 最后一次全量更新：全部阶段已实现并合入 `main`（`main` = `5536bfa`）** —— 本文件里带 **★[已完成]** / **★[已过时]** 标记的小节是**实现过程的留痕**（保留原文，供追责与复盘），**不再是"待办"**。

## 一句话状态

**全部阶段已实现并合入 `main`。`main` = `ed2a3a9`（`merge(ops): P4 剩余四项 —— 反向展开、运维动作、过期邀请回收与运维界面`）。**
**已合入：P0 / P1 / 文档 v7→v8 / P1.5 / P2（含 M5 全部四项）/ P3a / P3b / P3c / P3d / P4（含剩余四项）** —— 即设计文档 §8.1 阶段表里的**全部阶段，无遗留分支**。
**设计文档已回写为 v8**：本轮把实现反馈的更正写进了 `access-control.md`（含一处**安全相关的方向性错误**订正、一条**新增的跨阶段不变量 §4.6**），见其 **§13.6**。

### ★ 本批（工作树**未提交**，基线 `98b4618`）：权限入口归并 + 编辑器两模式

> 上面那段"全部阶段已合入 `main`"是**历史结论**；本批是它**之后**的新改动，且**尚未提交**。接手者按本节读现状，
> 设计侧的追加记录见 `access-control.md` 文末的「**追加：权限入口的归并（本批）**」。

- **★ 编辑路径的正文口径改了（修的是一处权限事故，先读这条）**：编辑页此前拿到的是**投影后**的正文（受限段落变占位、`<!--gated:…-->` 标记被消费），"改一个标点再保存"会把段落标记写没 ⇒ **受限段落静默变公开**（实测复现：公开页 + org 受限段，保存后匿名访客读到该段全文）。修法：详情端点新增 **`GET /api/pages/:slug?content=raw`**（仅 `canEdit`；不可编辑者 **403 `raw_requires_edit`**；非法取值 **400 `invalid_content_mode`**；响应多一个 **`contentMode: 'raw'`** 自述口径），编辑页改用 `api.page(slug, { raw: true })`；客户端另有 `looksProjected()` 作为**第二道防线**（拦旧草稿：提示 + 保存前确认，两条出路）。设计侧详见 `access-control.md` 追加节 **§6**。
- **独立「权限治理」页从导航移除**（桌面标签、窄屏菜单、命令面板都移除）：`packages/web/src/App.tsx` 的导航常量改名 **`LEGACY_ROUTES`**（唯一条目 `id: 'access'`，`requires: 'manageVisibility'`），但**仍在 `known` 路由集合里**。`#/access/<slug>` 仍存在、但**重定向**到 `#/wiki/<slug>?access=1`（阅读页的「权限」对话框）—— 落点**刻意不是编辑页**：那个对话框对**所有有 `manageVisibility` 的人**可用，包括**没有正文编辑权**的人。`#/access`（无 slug）改为一页说明；`packages/web/src/pages/AccessPage.tsx` 按此重写（**文件与导出名保留**）。
- **编辑页改单栏**（`packages/web/src/pages/WikiPage.tsx` 的 `WikiEdit`）：原先与编辑区并排的预览面板去掉，预览改为「按访客视角预览」**对话框**。编辑器有**源码/实时渲染**两种模式与排版工具栏（见下条）。
- **★ 同批末按作者要求收掉的两处界面**（改前请先读这条，别照着旧描述找控件）：① 编辑页底部的「权限」区**已整体移除** —— 页面档位的入口只有页面自己的「权限」对话框（那里同时有例外授予与访问申请，是一处完整的治理界面）；编辑页只保留页面档位的**只读**值（工具栏锁按钮要靠它提示"这一段不能比页面更宽"）。随之删掉的是 `PERMISSION_SECTION_LABEL_ID`、`grantsOpen`/`canManageVisibility` 状态，以及 `PageAccessPanel` 的 `sections` 属性（唯一使用者就是那个对话框）。② 权限对话框里的**块级分区**（`BlocksSection`）从面板移除 —— 段落档位在编辑器里改；`BlocksSection.tsx` 与块授权端点**都保留**（界面收起、能力不删），要恢复加回面板渲染即可。「权限」按钮的文案也从 `权限…` 改成 `权限`（不带省略号）。
- **★ 同一回合内补回的功能缺口（重要：别以为"块级授权删干净了"）**：块级分区从权限面板移除后，**"授权给谁"一度没有任何界面**，而 `granted`（需单独授权）档的语义就是"默认谁都读不到、靠名单放人" ⇒ 那一档成了死档（作者设完，连他想给的同事也读不到）。现修：**授予与档位放在同一处** —— 编辑器工具栏锁菜单新增 **「授权给谁…」** → `packages/web/src/components/access/BlockGrantsDialog.tsx`，按 `ordinal` 换服务端块 id（`GET /api/pages/:slug/blocks`），增删走既有块授权端点。授予表单的唯一实现是 `packages/web/src/components/access/BlockGrantEditor.tsx`（对话框与 `BlocksSection` 共用）。两条契约后果已在界面里如实表达：块 id 只有**保存正文时**才生成（未保存的段落给的是"先保存正文，再继续授权"），未保存的改动会让**段落序号与上次保存的正文错位**（故对话框顶部显示该段摘要）。守卫 `packages/web/test/blockGrantsInEditor.test.ts`；端到端 `scripts/acceptance/editor-modes-cdp.mjs` 的 `L0a–L0e`。
- **授权对象填什么（作者问过"所谓的 id 是什么"）**：`subjectId` 是数据库 id 字符串 —— 用户 = `users.id`，用户组 = `groups.id`（`packages/plugin-authz/src/index.ts` 逐字比对）。名单端点 `GET /api/org/members|groups` **原本要管理员**（授权只要 `manageVisibility` ⇒ 出现过"有权授权却看不到名单"的人）；**本批已按作者要求放宽为"任何登录用户可读"**（`{ access: 'user' }`），放宽边界：读名单登录即可，**写**（成员角色 / 邀请 / 建组 / 组的成员增删）与 `GET /api/org/invitations` **仍只有管理员**（守卫 `packages/plugin-org/test/memberDirectory.test.ts`；端到端以**普通成员 alice** 复核：`editor-modes-cdp.mjs` 的 O1–O4）。`packages/web/src/lib/subjectDirectory.ts` 用三态处理（可列名单 / 403 无权限 / 读取失败），能列名单时**给下拉选择**并把人名显示出来，不能列时手填并说明去哪儿看 id —— 三种情形界面都必须能走通，别把它做成"只有管理员能用"。
- **编辑器两模式 + 排版工具栏**：**源码** / **实时渲染**（`packages/web/src/lib/editorModePlan.ts`，localStorage `gw.editor-mode.v1`，默认 `live`；就地渲染 `packages/web/src/components/editor/liveRender.ts`）；工具栏 `packages/web/src/components/editor/EditorToolbar.tsx`，格式动作是 `packages/web/src/lib/markdownActions.ts` 的纯函数（CodeMirror 路径与降级 `<textarea>` 共用）。**边界**：能渲染的是行内标记与图片，以及**整块**的表格 / 代码块 / 整块 HTML / 分隔线（见下条）；**段落内部的行内 HTML 标签仍按源码显示**；**实时渲染下不显示行号**；gated 标记不合法时**不做任何装饰**。
- **★ 同批末按作者反馈补的（第二件）：页面「权限」对话框里的授权对象也能**下拉选人**了**（反馈原文「权限按钮进去那个页面的还不能下拉选择用户」）。根因是**修一处漏一处**：名单端点 `GET /api/org/members|groups` 放宽为"任何登录用户可读"（`{ access: 'user' }`）时，只有**编辑器**的授权表单改成了成员下拉，而**页面「权限」对话框 →「例外授予（页级）」**（`packages/web/src/components/access/GrantsSection.tsx`）仍是手填「对象 id」，旁边甚至还留着放宽之前的理由（"成员/组列表需要组织管理员权限，本页不拉取它"）。修法不是再改一遍那一处，而是**把字段本体抽成唯一实现** `packages/web/src/components/access/GrantTargetFields.tsx`（类别 / 授权对象 / 角色 / 到期 + 手填出口 + 三态说明），`BlockGrantEditor`（段落授权）与 `GrantsSection`（页面授权）**共用**它；同时这一页的成功回执与授权名单也从"用户 id 42"改成 `describeSubject()` 的**人名/组名**（原始 id 以 `#42` 留在后面便于核对）。`lib/subjectDirectory.ts` 的文件头同步改掉"名单是 admin-only"这条**已过期**的前提（放宽 ≠ 三态可以塌成两态：未登录、端点被改回 admin、读取失败仍会落到手填那一支）。**守卫**：源码级 `packages/web/test/blockGrantsInEditor.test.ts`（新增一例：页面级授权必须 `<GrantTargetFields>` + `directory={directory}` + `loadSubjectDirectory()` 只调一次 + "本页不拉取它"不得再出现在源码里）；浏览器端到端 `scripts/acceptance/editor-modes-cdp.mjs` 新增 **M3–M5**（`?access=1` 对话框里 `#page-grant-subject` 必须是 `SELECT`、选项形如 `演示管理员 —— admin@example.com`、选中后控件值是**数字 id**、字段标签是「授权给谁」）⇒ **41/41 通过**；截图 `data/verify/shots/08-page-grant-dropdown.png`。⚠️ 验收脚本里**别点**「添加授权」——那是提交按钮（`GrantsSection` 的表单常驻，没有展开这一步），点了会拿空 id 提交并留下一条校验错误。
- **★ 同批末按作者反馈补的：实时渲染真的渲染块了**（反馈原文「当前实时预览部分无法渲染」，落点 `http://127.0.0.1:3100/#/wiki/home/edit`）。此前表格 / 代码块 / 原始 HTML **按源码显示**（只给底色）；现在 `Table` / `FencedCode` / `CodeBlock` / `HTMLBlock` / `HorizontalRule` 五类节点**整块换成渲染结果** —— 判据与范围对齐在 `packages/web/src/lib/liveRenderPlan.ts`（纯逻辑，`packages/web/test/liveRenderPlan.test.ts` 13 例），装饰在 `packages/web/src/components/editor/liveRender.ts`：内容走**阅读页同一条** `mdToHtml`（marked + DOMPurify）并套 `.md-body` 复用阅读页排版，**不另写一套表格渲染**（两条路径各画各的，实时渲染里看到的就不是发布稿了，而「看到发布稿」正是这个模式的目的）。**两条不可忘的实现约束**：① **必须是 `StateField` + `EditorView.decorations.from(field)`** —— CodeMirror 只允许**静态**装饰带块效果，插件路径连 `block: true` 都不许用（`@codemirror/view` 的 `emit()` 抛 `RangeError: Block decorations may not be specified via plugins`，判据是 facet 值 `typeof d === 'function'`）；**不要改回 `ViewPlugin.fromClass`**，改了是渲染表格时**直接抛异常**，不是「渲染不出来」。② **块装饰范围必须与行边界对齐**（`alignToLines()`），错开会吃掉相邻正文。**渲染块是只读投影**：点它 ⇒ `mousedown` 处理把光标送进这一块的源码，配合既有的「活动块显示源码」规则 ⇒ 渲染块消失、源码出现（编辑永远发生在源码上）；渲染块**落在受限区段里时会带上区段底纹类名**（整块被替换 ≠ 权限提示消失 —— 这是最危险的一条静默回归）。**顺带修掉三处行内漏网**：行内代码的反引号（`CodeMark`，只藏父节点是 `InlineCode` 的）、无序列表的 `-` / `*` / `+`（换成「•」；**有序列表的 `1.` 刻意不动** —— 那就是渲染后的样子）、任务列表的 `[ ]` / `[x]`（换成 ☐ / ☑）。**端到端**：`scripts/acceptance/editor-modes-cdp.mjs` 新增 **P0–P4**（这一页本身不含渲染块 → 在 org 区段里亲手打一个围栏代码块**和一张表格** → 断言 `pre>code` + `language-ts` 与真 `<table>`（3 行 / 2 表头）、围栏与 `| --- |` 都不再露出、渲染块带区段底纹 → 点击回源码 → **Ctrl+Z 一次撤回且区段原文完好**），**38/38 通过**；**本批读数（HEAD `98b4618` + 未提交工作树，取数 `2026-09-13T22:0x+08:00`）**：`pnpm typecheck` exit 0（17 包 Done、0 个 `error TS`）、`pnpm test` **1245/1245 通过 / 0 失败**、`pnpm build` exit 0、验收脚本 **38/38**。截图 `data/verify/shots/live-blocks2-architecture-table.png`、`live-blocks2-getting-started-code.png`、`live-blocks2-gated-code-block.png`，明细 `data/verify/editor-modes-cdp.out.json`。**仍未渲染**：段落内的行内 HTML 标签（有意，见上）。
- **段落档位在编辑器里改，不是新端点**：工具栏锁按钮 / 源码模式手写标记改的是**正文里的 gated 标记**，改写走 `packages/web/src/lib/editorBlocks.ts`（`applyBlockTiers` 整篇重建 + 自检：块数、每块文本、每块档位三条对不上就**放弃改动**）；服务端保存时仍由 `packages/plugin-wiki/src/blocks.ts` 重新解析，**同一条保存路径、同一份版本历史**。`packages/web/src/components/access/BlocksSection.tsx` **仍无档位改动控件**（这是对的：块档位就是正文的一部分），文案改为把作者指向编辑器的锁按钮。

### ★ 合并后的验证基线（`main` = `ed2a3a9`，**由编排者实际复跑**）

`pnpm typecheck` **exit 0（17 包全 Done）**；`pnpm test` **886 例 / 886 通过 / 0 失败**；`pnpm build` **exit 0**；
六条 e2e **共 325 项断言零失败**：`e2e-p1` **38 / 0**、`e2e-p15` **44 / 0**、`e2e-p2-org` **44 / 0**、`e2e-p2` **34 / 0**、`e2e-p3a`（SQLite）**85 / 0 / 0 跳过**、`e2e-p4` **80 / 0**。

> **例数对账（886 的来历）**：`5536bfa` 时为 870；M5 红链三态（`6defefc`）给 web +9 ⇒ 879；
> P4b 并入给 web +7（`packages/web/test/opsPage.test.ts`）⇒ **886**。逐包自洽。
>
> **早期基线已过时，不要引用**：文档 v8 那一轮记录的是 `main` = `5536bfa` / 870 例 / e2e 282 项；
> 更早的 843、831 等更不适用。**复核请以你自己当时的 `HEAD` 为准并把提交号写下来。**

### ★[已过时] 下一步：P3bcd 的 rebase —— **已完成**

`feat/p3bcd-block-acl` 已 rebase 并合入 `main`（合并提交 `7fa809f`：`merge(privacy): P3b/P3c/P3d 块级权限、版本恢复与编辑器视角切换`）。
下面的原文保留作留痕（它记录的"冲突需按语义合并、不要二选一"这条判断后来被证明是对的）：

### ★[已完成] P3a 修复轮（4 个提交 `a3d72b7` / `1d608a6` / `dee82cd` / `e941da5`）

- **C1/C2 已修**：`savePage` create 分支（`packages/plugin-wiki/src/index.ts:1001`）与 `deletePage`（`:1057`）
  各调一次 `resyncDescendantsReporting(slug)`；档位端点（`:1522`）也改用它。
- **扇出保留在提交之后，而非塞进同一事务** —— 实现者给出的理由（我判断成立）：
  `pageLevelOf` 走策略层（**另一条连接**读 `pages`），**PG 的 MVCC 下看不到本事务未提交的插入/删除**；
  不会死锁，但会**读到旧值，等于没修**。因此改为把失败**升级为一等可观测信号**：
  `ResyncReport{resynced, failed, error?}` + 审计 `acl.resync_failed` + 响应字段
  `index_tiers_resync_failed` / `index_tiers_resync_error`，与 `index_tiers_resynced` 并列
  —— **让"重算了 0 个子孙"与"扇出整个失败"可区分**。泄露窗口是毫秒级；真正的风险是**失败后永久泄漏**，后者已解决。
- **红-绿自检（最硬的证据）**：临时禁用两处扇出 ⇒ `K5/K6/K14/K15` 全红，`K6` 报响应体里出现 `KKK777LEAK`、
  `K15` 报 `DDD999LEAK`（通过 71 / 失败 4）；恢复后全绿。
- **★ 又抓到第三个 PG 专有缺陷（内容级）**：`deletePage` 里的 `DELETE FROM blocks_fts ...` **没有方言守卫**
  ⇒ **PostgreSQL 上删除任何页面都返回 500 且页面删不掉**（PG 事务一旦报错即 aborted、整体回滚）。
  `blocksIndexSupported` 在回填与 `savePage` 都用了，唯独这里漏了。**此前从未被发现，是因为 e2e 的阶段
  G/H/I/K 靠直读 SQLite 文件核对 tier、在 PG 下整体跳过** ⇒ `deletePage` 在 PG 上从没被端到端跑到过。
  已修，并新增**方言中立阶段 L** 覆盖扇出的 HTTP 可见面。
- **e2e 加固**：新增阶段 K（两条扇出顺序，含"先证明前置状态可读"的反假绿断言）；修正 H 阶段两处假绿
  （H1 原按"`tier=0` 的行数"断言 ⇒ 库里有合法 tier=0 块即假绿，改为按 `run()` 的 `changes` 并加 H0 前置；
  H3 原还原语句只在"所有块恰好都该是 1"时正确，改为按记录逐行还原）。
- **验收**：`pnpm test` 823/0；`e2e-p3a.sh` SQLite **85/0/0**、真 PG 15（新库 `geewiki_e2e_final`）**32/0/7 跳过**；
  跨阶段四条 38/44/44/34 全零失败。

## 对照最初的四项需求

| # | 需求 | 状态 |
|---|---|---|
| 1 | 权限管理 | ✅ 完成 |
| 2 | 团队/组织管理 | ✅ 完成 |
| 3 | 部分条目**或条目中的内容**需权限才能显示 | ✅ **条目级与内容级（块级）均已完成**（P3a 块模型与分层检索、P3b 块级授权与申请访问、P3c 版本与恢复、P3d 编辑器视角切换） |
| 4 | 未登录进站应有主页面 | ✅ 服务端门户 `/portal` 完成；✅ 前端导航能力驱动已完成（M5 **四项全部完成**，含红链三步态 —— 已合入 `main` 的 `6defefc`） |

## ★[已过时] 分支与 worktree 现状 —— **全部已合入，此表仅作留痕**

```
main                     953f41d   已合入 P0/P1/v7-doc/P1.5/P2/M5
feat/p3a-blocks-cont     289f0b4   worktree .wt-p3a2   ← P3a 全部实现完成；审查判不可合并，修复中
feat/p3bcd-block-acl     8a58db6   worktree .wt-p3bcd  ← P3b 基本完成；P3c/P3d/申请访问未做
feat/p3a-blocks          0f34e06   worktree .wt-p3a    ← 上面那条的祖先（旧），勿动
feat/p0-route-auth-guard / feat/p1-identity / feat/p15-oidc / feat/p2-org-visibility /
feat/p2-m5-frontend-ia              均已合入，worktree .wt-p0/.wt-p1/.wt-p15/.wt-p2/.wt-m5
```

**合并顺序与 rebase 计划**（原文留痕）：先合 **P3a（含修复）**，再把 **P3bcd rebase** 上去。
两者都改 `packages/plugin-wiki/src/index.ts`（P3a 补子孙 tier 重算、P3b 改保守重解析与写入路径），
**rebase 必有冲突，需按语义合并**——它们是两件不同的事，不要二选一。
**★ 结果：判断成立，已按语义合并完成**（P3a 于 `975fa61` 合入、P3bcd 于 `7fa809f` 合入）。

## ★[已完成] P3a 的两条 Critical 泄漏（审查端到端复现；**已修，此处保留作留痕**）

> **★ 现状（与下面原文的差别）**：两条 Critical **均已修**，且**第三条（P3c 的恢复路径）后来也被发现并修掉**。
> 修法、三条失效的完整记录、以及"为什么扇出必须在提交之后"的论证，**已回写进设计文档的 §4.6**（`access-control.md`，跨阶段不变量）。
> 订正提交：`a3d72b7`（Critical 1 + 2）、`9699aa7`（P3c 恢复路径）。
> **下面原文里那句"要求的修法"要按 §4.6 读**：最终**没有**把扇出放进同一事务 —— 因为 `pageLevelOf` 走策略层（**另一条连接**），
> **PG 的 MVCC 下看不到本事务未提交的行**，放进事务不会死锁但**会读到旧值、等于没修**。改为把失败**升级为一等可观测信号**
> （`ResyncReport` + 审计 `acl.resync_failed` + 响应字段 `index_tiers_resync_failed`）。

**根因链**：`blocks.tier` 是检索用的**物化派生列**，而读路径按 slug 前缀**实时算**有效档位。
两者一旦不同步 ⇒ **读路径 404、检索却命中并吐出正文片段**。当前实现只在"改档位"一条路径上做了子孙重算。

**Critical 1 —— `packages/plugin-wiki/src/index.ts:907-937`（`savePage` create 分支）**
只有本页 `syncBlocksForPage`，**无子孙扇出**。复现：建 `a/b`（public + published）→ 匿名读 200、搜 `total=1`；
再 `PUT /api/pages/a`（默认 org）→ 匿名读 `a/b` **404**，但匿名 `/api/search` 仍 **`total:1` 且响应体出现唯一词 `CHILDUNIQ777`**。
同刻 `blocks/verify` 报 `tier_mismatched:1, mismatched:0`。

**Critical 2 —— `packages/plugin-wiki/src/index.ts:991-1007`（`deletePage`）**
无扇出。复现：`a`=private、`a/b`=public + published + **`inherit=false`**（断链点）、`a/b/c`=public + published
→ 匿名读 `c` 200、搜得到；`DELETE /api/pages/a%2Fb` 后 → 匿名读 404，但匿名搜仍吐 `DEEPUNIQ999`。

**根因（已独立核实）**：`packages/plugin-authz/src/index.ts:261-271` 的 `effectiveRank`——
`ancestorsOf` **由近及远**；对**缺失**祖先 `continue`（不构成收紧）、对 `inherit !== 1` 才 `break`（断链）。
删掉断链点后更上层更严的祖先**重新开始压制**，rank 0→2，而 `blocks.tier` 仍为 0。
**`continue`/`break` 的不对称是刻意的，不要去改它**，只能补"档位变了要重算 tier"。

**要求的修法（原文留痕 —— 最终修法见本节开头的 ★ 现状）**：`savePage` create 分支与 `deletePage` 事务提交后各调一次 `resyncDescendantTiers(slug)`（与 `:1404` 同写法）；
并评估能否把扇出放进同一事务（当前扇出在提交**之后**且失败只 `console.warn` ⇒ 泄漏窗口 + 无自动修复，
`index_tiers_resynced=0` 与"没有子孙"不可区分）。
**e2e 必须补这两条顺序的断言**——现有脚本 G 阶段**只测了"改档位"**，所以它绿着而泄漏仍在。
> **★ 结果**：这两条断言已补（阶段 K，两条扇出顺序 + "先证明前置状态可读"的**反假绿**断言）；扇出的失败信号也已升级（见上）。
> 扇出的四个调用点：`savePage` create 分支、`deletePage`、**版本恢复**、改可见性（详见设计文档 §4.6）。

## ★[已完成] P3b/P3c/P3d 状态 —— **三阶段全部完成并合入**

已完成（5 个提交，`feat/p3bcd-block-acl`）：`0014_access_requests.sql` + `0016_block_grants.sql`（双方言，
含 `idx_block_grants_subject`）；`grantedBlockIds()` 真实查询（user 直授 + groupIds 组授、**按 `expires_at` 过滤**、
匿名/break-glass 返回空集、**激活期表存在性自检**）；投影授权分支；**保守重解析**（保留块 id、拆分继承授权、
合并/删除已授权块 409，全部在写入前拒绝）；块级治理与授予端点（3 个，含 `acl_revision` 递增与审计）。

**未完成（原文留痕 —— 列出的是当时的缺口，现已全部补齐）**：① 申请访问流程端点（表已建、端点未做，§8.2 P3b 第 6 条）；② **P3c 完全未开始**（`0017_version_blocks.sql`、
`blocks_json`/`acl_json`、"改权限也产生版本"、四位一体恢复、1MB 上限、老版本 `warnings:['block_acls_not_restored']`）；
③ **P3d 完全未开始**（标记高亮、「预览为匿名视角」开关）。
> **★ 现状**：① 已做（`4274bd8` 申请访问流程 —— 申请/待审/批准/拒绝/撤回）；② 已做（P3c：版本恢复 + `blocks_json`/`acl_json` + 1MB 上限 + 老版本 `warnings`，并在第二轮审查后发现**恢复路径漏扇出** ⇒ `9699aa7` 补上）；③ 部分已做 —— **「预览为匿名视角」开关已交付**，**CodeMirror 内的标记语法高亮 / 自动补全仍未做**（见下方「仍未做的项」）。

**★ 一条跨阶段的隐性依赖（P3b 执行者发现的）**：`syncBlocksForPage` 的"删光重建"会让 `block_grants`
被 `ON DELETE CASCADE` **静默清空** ⇒ P3b **必须**改写入路径。两个阶段各自看自己那一半都对，
**缺陷只存在于交界处**——这是"必须做跨阶段 e2e"的实证。

## ★[已完成] P4 状态（分支 `feat/p4-audit-ops`，worktree `.wt-p4`，基线 `d3a82a7`）—— **已合入 `main`（`5536bfa`）**

**已实现（4 个提交）**：

- `03c47f0` **越权尝试记录 + 审计查询**。`access.denied` 此前在 `AuditEntry` 的文档注释里被列为
  预期动作但**从未被写入**；现由 `packages/plugin-wiki/src/index.ts` 的 `recordAccessDenied` 独家写入，
  三处调用点（详情路由 404 分支、backlinks、links）。
  **关键判据：只在"页面存在、但对该主体不可见"时记录** —— 对外两条路径都返回 404（§2.3 不泄露存在性），
  但服务端内部分得清：「请求了不存在的页」只是普通 404，「请求了存在但无权看的页」才是越权尝试。
  `GET /api/admin/audit`（`access: admin`）用 `view` 把两类**分开**：`acl`（权限/配置变更，合规记录要留存）、
  `security`（越权尝试与特权访问，安全事件要告警）、`all`。
  **用显式白名单而非排除法** —— 排除法会把将来新增的动作默认归进 acl 视图；白名单让未分类的动作
  只出现在 `all` 里，漏分类是**可见的**。支持 action / targetKind / targetId / since / until 过滤，limit 上限 200。
- `3ce534d` **会话管理**：`GET /api/admin/sessions`（列出，带 `active|expired|revoked` 综合状态）、
  `POST /api/admin/sessions/:id/revoke`（定点吊销）、`POST /api/admin/users/:userId/sessions/revoke`（批量）。
  服务端吊销写 `revoked_at`；**`token_hash` 连哈希都不出接口**；重复吊销幂等**且不重复写审计**。
- `391aece` / `96780a1` **e2e `packages/plugin-authz/test/e2e-p4.sh`（37 项断言，全通过）+ 过期授权回收端点**
  `POST /api/admin/grants/purge`（**只做空间回收** —— 失效在判定时就发生；只在真回收了才写审计）。

**两条源码级守卫**（`packages/plugin-authz/test/audit-appendonly.test.ts`，由 `pnpm test` 覆盖）：
`audit_log` 无 UPDATE/DELETE（§8.2 P4 第 2 条）、`page_versions` 无保留策略清理（第 6 条）。
**做过红-绿自检**（探针 → 变红 → 删除 → 复绿）。

★★ **第 6 条按字面与既有合法代码冲突，已按真实意图落为"白名单 + 锚定"**：验收原文是
"代码中无删除 `page_versions` 行的路径"，但 `deletePage` 本来就要删掉**被删页自己的**版本 ——
那是页面生命周期级联，与 D11 反对的"保留策略清理"是两回事。按字面写会让守卫与既有代码冲突、
然后被人放宽，那等于没有守卫。现判据：只允许一处，且必须锚定在 `deletePage` 内。

**★ 三处"断言自己会骗人"的实例（本阶段踩到两次，值得记住）**：
① e2e 的 C1 第一版把四个 `grep -o | wc -l` 的结果**拼成字符串**再比 "4"（得到 "1111"），永不可能通过；
② 阶段 G 第一版造了两条 `subjectId` 相同的授予，而授予端点**按主体幂等 upsert** ⇒ 第二条覆盖第一条、
库里没有过期行、`purge` 恒返回 `expired=0` 也照样"通过"；
③ 阶段 G 还漏了"阶段 E 结尾批量吊销了所有会话 ⇒ `$JAR` 已失效"，会以"看起来对"的方式失败。

**已满足的验收标准**：第 1 条（ACL 变更入审计且不含正文）、第 2 条（守卫）、第 3 条（到期判定即时生效，
回收只是回收）、第 4 条（越权记录 + 两视图分开）、第 5 条（两个 verify 端点，P3a 已交付）、第 6 条（守卫）。

**未做（诚实列出；★ P4 已合入 `main`，下面这份未做清单已被下方「★ 仍未做的项」汇总，两处内容一致）**：
- **反向展开**（"谁能看这条"：直接授予 / 祖先链收紧 / 组织角色覆盖三条来源）—— 设计 §8.1 P4 行有此项
- **运维动作**：门户缓存清理提示（`s-maxage=300` ⇒ 收紧后需"清缓存 + 请求重新抓取"，§5.12）、
  `/sitemap.xml` 与匿名可见集合做集合差的核对入口、组织站点级设置接到界面
- `invitations.expires_at` 的回收（本轮只做了 `page_grants`；`invitations` 在 `packages/plugin-org`）
- **前端界面**：审计页与会话管理页都**只有后端端点**，未接界面
- PG 上验了审计闭环、两视图分离、会话列表；`grants/purge` 未在 PG 上跑（它与会话端点一样是纯 SQL，
  但 **PG 的 `COUNT(*)` 返回字符串**这一点在两条端点上都必须 `Number()` 强转，已在代码里处理）

## ★★ 与设计文档的差异（**回写已完成 → 见 `access-control.md` 的 §13.6**）

> **★ 本节原为"待回写的设计文档更正（累积清单）"，现已全部回写完毕。**
> 逐条落在了 **`docs/design/access-control.md` 的 §13.6「★ v8 修订记录」**（含改动清单与落点表），
> 就地订正的正文位置见 §12 的现状表第 22–26 行与 §13.6 的「就地补正清单」。
> **下面 10 条原文保留**，作为"当时发现了什么、以及各条的事实依据"的**留痕**（**不要丢**）——
> 但**规格以 `access-control.md`（v8）为准，不要以本节为准**（本节第 1 条里"未修的三处"已过时，见下）。

1. **§2.3 规则 B1 的方向写反了（安全相关）**：文档写 `effectiveBlockTier = min(block, page)`，但那句话的刻度是
   "**宽松度**"（越大越宽松），而 `tier` 列是"**限制等级**"（`b.tier <= :readerTier`，**越小越公开**）
   ⇒ 同一语义必须是 **`max`**。写反会让"页面 org + 块 public"的块拿到 tier 0，**匿名在搜索里就能搜到它**。
   以代码的 `effectiveIndexLevel` / `packages/plugin-authz` 的 `RANK_*` 为准（`RANK_PUBLIC=0 / RANK_ORG=1 / RANK_PRIVATE=2`，越右越窄）。
   **★ 这条错误已扩散到代码注释里，且共 4 处、只修了 1 处**：
   - ✅ 已修：`packages/plugin-search/migrations/0002_blocks_fts.sql:60-62`（提交 `1d608a6`，现在写着
     "用 `tier` 的刻度写就是 **`max`**"并解释了照文档写会让"页面 org + 块 public"的块拿到 `tier = 0`）
   - ❌ **未修的三处**：`packages/db-sqlite/src/migrations/0015_blocks.sql:41`、同文件 `:53`、
     `packages/db-postgres/migrations/0015_blocks.sql:29` —— 都还写着 `min(块档位, 页面有效档位)`。
     **风险**：后来的人读注释会以为实现写错了，去"修正"成 `min` ⇒ **直接造出泄漏**。
   - 参照：`packages/plugin-wiki/src/blocks.ts:224` 有一处**解释正确**的注释（说明为什么这里是 `max`）。
   > **★ 现状订正：上面这三处"未修"的已在提交 `ade59ef` 里全部订正**（只改注释、未动 SQL）。
   > **`ade59ef` 动了 2 个文件 / 3 处**（`packages/db-sqlite/src/migrations/0015_blocks.sql` 两处、
   > `packages/db-postgres/migrations/0015_blocks.sql` 一处），**第 4 处**（`packages/plugin-search/migrations/0002_blocks_fts.sql`）
   > 由更早的 `1d608a6` 修掉 —— 即**总计 4 处 / 3 个迁移文件**。
   > **★ 复核提醒**：这三个文件里**至今仍出现 `min(`**，但**全部是"解释为什么不是 `min`"的行文**（`blocks.ts:222` 同理）。
   > **复核命令**：`grep -rn "min(" packages/*/migrations/*.sql packages/*/src/migrations/*.sql` ⇒ 现为 **3 处命中，全部是解释性文字、无照抄形态**。
   > **⇒ 不要再把它们"改成 `max`"，那会把注释改瞎。**
2. **§3.6 的迁移落点是错的**：文档说写 `plugin-wiki/migrations/`，但 `@geewiki/wiki` 的迁移目录**只声明了 sqlite**
   ⇒ 照文档写，**PG 部署下 `blocks` 表根本不会被建出来**。实际落在 db 包、两侧成对。
3. **§9 R9（约 1558 行）写错**：把 `navOrder.test.ts（导航合并）` 列为"P2 必然触碰"——
   该文件测的是 `lib/navTree.ts` 的前后序，**与顶栏导航无关**（审查用 `git diff --stat` 证明其 diff 长度 0 行）。
4. **`tier` 必须内联在 `CREATE TABLE` 里**（不是另起 `ALTER ... ADD COLUMN`）：SQLite 没有"加列时若已存在则跳过"的语法
   ⇒ 独立 ALTER 会让迁移**无法重放**（P2 在 0012 上踩过并用守卫测试钉死）。
5. **config 脱敏的判据被放宽**：文档只写 break-glass，实现为 **break-glass 或 `orgRole ∈ {owner,admin}`**
   （否则登录为 owner 的管理员拿不到 config、配置表单无法回填；不重新打开匿名泄漏）。两条通道都堵
   （`/api/plugins` + `/api/session` 经 `PluginListFile.enabled[].config`），**未改 `snapshotOf()`**（改了会打瞎配置表单）。
   > **★ 补充（回写时补记）**：实现里的函数名是 `mayReadPluginConfig` / `withoutPluginConfig` / `withoutListConfig`
   > （`packages/manager/src/index.ts:1574` / `:1582` / `:1587`）—— **文档里原有的名字 `redactConfig` 在仓库里零命中**。
6. **`snippet()` 是静默失败**：设计写"不可用"，实测是**返回 `null` 而不报错**（我已用真 probe 验过）。
7. **§8.2 的 P2 验收标准 1–14 全是后端项**，没有前端 IA 条目 ⇒ M5 工作**没有设计文档层面的验收标准**。
   > **★ 现状**：已补 **P2 第 15 条**（前端 IA，含 ①–⑤ 与两项已知未完成项）。
8. **§4.3 低估了 P3a 的方言成本**：文档说"块模型与读路径裁剪两部分仍可两方言落地"——
   在这**三个** PG 缺陷修掉之前那句话不成立：① 写块靠捕获异常判"`blocks_fts` 不存在"，只匹配 SQLite 的
   `no such table:`（PG 文案是 `relation "blocks_fts" does not exist`）⇒ 每次写块都失败；② 缺 `RETURNING id`
   ⇒ PG 报 `violates foreign key constraint "blocks_page_id_fkey" / Key (page_id)=(0) is not present`；
   ③ **`deletePage` 里的 `DELETE FROM blocks_fts` 没有方言守卫 ⇒ PG 上删除任何页面返回 500 且删不掉**。
   建议补一句：*"块模型的 PG 可用性依赖 `RETURNING id`、索引表存在的方言判定、以及每一处 `blocks_fts` 语句的
   方言守卫——**这三点都不由类型系统保证，必须有真方言 e2e 兜底**。"*
   > **★ 现状**：①② 由 `96891db`、③ 由 `e941da5` 修掉；那句结论已**原样写入** §4.3 的「★ v8：P3a 的方言成本」。
9. **`blocks_fts` 只索引块文本** ⇒ **FTS 路不再按标题匹配**（LIKE 路仍匹配）。这是 §4.3 SQL 形态的直接后果，
   已有断言钉住。建议写进文档。
   > **★ 现状**：已写入 §4.3（含断言出处 `packages/plugin-search/test/search.test.ts:558`）。
10. **`系统状态`（服务健康/DB 方言/表清单）随 `管理 ▾` 下沉为管理员专属**——文档里 `grep 系统状态|服务健康`
    **零命中**，规格从未表态。**编排者裁定：维持管理员专属**（内容是运维细节，与所在分组的"运维台面"语义一致；
    `GET /api/health` 本身仍是公共端点，看门狗不受影响）。
    > **★ 现状**：裁定已写入 §6.6 的 ★ v8 小节（含"`GET /api/health` 内联处理、不过 `access` 闸门"这条边界）。

## 环境约束与教训（**必须遵守**）

- **沙箱只允许写 `/root/dev/geewiki` 之内** ⇒ worktree 必须建在仓库内（`.wt-<阶段>`）。
- **⛔ 派工必须写明"绝对不要创建 worktree 或分支"**。已发生过两次：执行者自己另建 worktree/分支，
  导致工作 split 在两条分支上、编排者差点在旧基线上继续（靠"报告里的提交号与 worktree tip 对不上"才发现）。
- **路径陷阱**：`edit`/`write` 按**会话工作区（主工作树）**解析相对路径 ⇒ 在 worktree 里干活**必须用绝对路径**。十三位执行者里踩过的占多数。
- **`subagent_implementer` / `subagent_general` 会继承对话上下文**，可能把自己当编排者转手派活（发生过：一行代码没写）⇒ 派工要写"你亲自写代码，禁止派发子代理/子会话/转交"。
- **job 型子代理无法用 `send_message` 插话**（报 `unavailable`）⇒ 只能事后核查。常驻子代理（reviewer/debugger/plan/docs/git）可以，但**不能用 `job_output` 阻塞等待**，只能等通知。
- **`interrupt_agent` 只停"当轮"**，不等于停止；用**文件 mtime** 确认原执行者真停了，别用轮数判断。
- **agent 会因上下文耗尽而中途收尾** ⇒ 派工时就把"按里程碑提交、跑不完就交代停在哪里"写死。
- **PG 隔离配方**：临时目录写 `plugins.base.json`，`@geewiki/postgres` 内联 `config` 用 `passwordEnv: "GEEWIKI_DB_PASSWORD"`；
  启动 `GEEWIKI_CONFIG_DIR=<tmp> GEEWIKI_DATA_DIR=<tmp> GEEWIKI_DB_PASSWORD=testpw GEEWIKI_PORT=<自选> node --import tsx packages/server/src/index.ts`。
  ⚠️ **必须轮询 `/api/health` 到 `"present":true` 才开始验收**（http 就绪即 200，迁移可能没跑完 —— 三位执行者栽在这里）。
- **PG 共享库 `geewiki_test` 已"中毒"**（留着先前运行的 owner 账号 ⇒ e2e 跳过 setup 直接登录 ⇒ 全线 401 假失败）⇒ 用干净库 **`geewiki_e2e_clean`**。
- **容器 `geewiki-pg-test`**：`postgres:15-alpine`，host `127.0.0.1` port **55432**，user `geewiki` / password `testpw`。
- **端口分段避让**：41xxx PG 验证 / 42xxx P1.5 / 43xxx P2 / 45xxx 合并验证 / 46xxx M5 合并 / 47xxx P3a / 48xxx M5 前端 / **50xxx P3bcd**
- **`plugin-search` 在 PG 上报** `迁移失败（已回滚）: 0001_search.sql error: syntax error at or near "VIRTUAL"` —— **预期行为**
  （插件有显式方言守卫 `packages/plugin-search/src/index.ts:307-320`）。根因是它用**裸字符串**声明 `migrations: './migrations'`（`:67`）
  ⇒ 在 `resolveMigrationsDirs` 里归入 `'default'` 键被所有方言命中；**最小修法一行**：`migrations: { sqlite: './migrations' }`。
- **FTS5 实测（编排者跑的真 probe）**：SQLite **3.53.4**（better-sqlite3 13.0.3）；`contentless_delete=1` 建表/删除/rowid 复用均 OK；
  **trigram 3 字符门槛真实**（2 字查询 `MATCH` 恒为空 ⇒ 短查询必须走 LIKE 兜底）；**`snippet()` 静默返回 `null` 而不报错**；
  **`tier` 过滤绝不能写在 FTS 表上**（contentless + `UNINDEXED` 会静默返回 0 行）。
- **SQL 括号陷阱**：`A OR B AND C` 的优先级是 `A OR (B AND C)` ⇒ 权限过滤条件必须加括号（P2 栽过一次）。
- **SQLite 没有 `ADD COLUMN IF NOT EXISTS`** ⇒ 给既有表加列的迁移**无法重放**（守卫测试已钉死，**不要放宽**）。
- **既有守卫测试有基于文本启发的**（如 `/\bADD\s+COLUMN\b/i` 判断迁移可重放）⇒ **注释里写这几个词会被误判**。
- **`/tmp` 在本沙箱跨 bash 调用不保留** ⇒ 日志要写在工作区内或同一条命令里消费。
- **主工作树默认没有 `node_modules`** ⇒ 在 main 上跑 typecheck/test 前需 `pnpm install --frozen-lockfile`。
- **`compress` 工具反复报错** `session event "user/message" carries an invalid replace surfaceOp`，但**压缩实际仍生效**（用 `acp_status` 核实）。
  ⚠️ **教训：不要把关键工作笔记只留在对话上下文里——压缩会吃掉它们（本文件就是这么产生的）。**
- **编排者（我）犯过的错**：① 指令里写过 `901`/`8192` 两个**不存在**的数值；② 任务书写成 `/api/slots`，真实是 `/api/plugins/slots`；
  ③ 要求补的 `details` 修复**原本无测试覆盖**；④ 任务书要求"同步更新 `navOrder.test.ts`" —— **错，该文件与顶栏导航无关**；
  ⑤ **检查脚本四次假阳性**（grep 命中注释、grep 模式路径写错、mN 引用过期）⇒ 关键结论一律二次确认。

### ★ 新增教训（来自 P2–P4 的实现与文档 v8 的回写，**与上面同等重要**）

- **★ 文档注释会成为错误的传播媒介**：§2.3 规则 B1 那个 `min` **正是从设计文档抄进 4 处代码注释的**，
  而"照注释去修正实现"会**直接造出内容泄漏**。⇒ **引用设计的注释必须写明"哪一份是权威、以及为什么"**，否则注释会先于代码老化。
- **★ "每个阶段各自看自己那一段都对"的缺陷只能靠跨阶段覆盖抓到**：跨阶段不变量漏扇出（失效 3 次）与
  `blocks_fts` 漏一处方言守卫，**都是交界处缺陷**。⇒ ① 凡新增一条写共享状态的路径，都要问"**谁还要跟着变**"；
  ② 凡是"只测自己那一半"的 e2e 阶段，**要显式声明它没覆盖交界面**。
- **★ "靠直读 SQLite 文件断言"的 e2e 阶段在 PG 下会整体跳过，而且不会告诉你**：
  `deletePage` 因此在 PG 上**从没被端到端跑到过**（⇒ PG 上删除任何页面 500 且删不掉）。
  ⇒ **每个这类阶段都要配一条方言中立（纯 HTTP）的替代断言**。
- **★ 类型系统拦不住方言问题**：`RETURNING id`、索引表存在性判定、每一处 `blocks_fts` 语句的守卫 ——
  **这三点都不由类型系统保证**（类型检查、单测、SQLite e2e 全绿而 PG 全废）⇒ **必须有真方言 e2e 兜底**。
- **★ 把"失败"与"什么都没做"设计成可区分的信号**：`index_tiers_resynced: 0` 曾同时表示"没有子孙"（正常）
  与"扇出整个失败"（永久泄漏）⇒ 遂有 `index_tiers_resync_failed` + 审计 `acl.resync_failed`。
  ⇒ **凡"计数为 0"的信号，都要问一句"0 是不是有两种含义"**。
- **★ 不要给判定层加 TTL 缓存**（`acl_revision` 那条"代际失效"从未实现、也**不必**实现 —— 判定每请求现查库）。
- **★ 遍历里"跳过"要用「整段落在里面」而不是「相交」，否则会在根节点上把整棵树截断**（本批实测，症状极具误导性）：`liveRender` 的树遍历对"已落在渲染块里"的节点 `return false`（含义是"不再往下走"），而判据若写成**相交**（`overlaps`），`Document` 根节点与任何渲染块都相交 ⇒ 根节点直接返回 false ⇒ **整棵树一个节点都走不到**。表现是"只要文里有一个渲染块，行内标记（`#`/`**`/反引号）就全部不再隐藏，而渲染块照常画出来"—— 看起来像另一套装饰坏了。正解：`isInsideCovered()`（`from >= c.from && to <= c.to`），并单独写一条注释说明它**不是** `isCovered` 的别名。
- **★ 用状态行判断「有没有未保存改动」会骗人**（本批实测）：编辑页那句「有未保存的改动」在**草稿自动保存（900ms 防抖）之后会被换成「草稿已自动保存（…）」**，于是"脏"与"已保存"在文本上不可区分 —— 端到端里据此断言会得到假绿/假红。判据改成**看正文**（探针字符串在不在、原文有没有回来）。
- **★ CDP 里发 ⌘Z 必须用 Ctrl（modifiers 2）**：CodeMirror 的 `Mod-` 在非 macOS 上就是 Ctrl，发 Meta 在 Linux 上**什么都不会发生**，而"撤销后正文没变"很容易被读成"符合预期"（`editor-modes-cdp.mjs` 的 H2 与 P4 两处都写着这条）。
  这条现在是**明文禁令**（见 `access-control.md` §9 R10 第 3 条与 §13.6 第 11 条）。

## 验证基线（复现用）

```bash
pnpm install --frozen-lockfile        # 主工作树默认没有 node_modules（本次复跑时已存在）
pnpm typecheck                        # 预期 exit 0（17 个包）—— ★ 已在 main@5536bfa 复跑：exit 0
pnpm test                             # ★ 已在 main@5536bfa 复跑：870 例 / 870 通过 / 0 失败
pnpm build                            # ★ 已在 main@5536bfa 复跑：exit 0

# e2e（真实起服务 + 真实 curl，pnpm test 不包含它们）—— ★ 以下断言数来自编排者记录，未由文档 v8 那一轮复跑
PORT=46101 bash packages/plugin-auth/test/e2e-p1.sh      # 38/38
bash packages/plugin-oidc/test/e2e-p15.sh                # 44/44（测试内 mock IdP）
PORT=46301 bash packages/plugin-org/test/e2e-p2-org.sh   # 44/44
PORT=46401 bash packages/plugin-authz/test/e2e-p2.sh     # 34/34（SQLite）
bash packages/plugin-wiki/test/e2e-p3a.sh                # P3a：SQLite 85/0/0；PG 下 G/H/I/K 整体跳过（靠直读 SQLite 文件），阶段 L 方言中立
bash packages/plugin-authz/test/e2e-p4.sh                # 37/37
```

**跨阶段回归是必须做的**：合并后**六条 e2e 共 282 项断言零失败**（`e2e-p1` 38 + `e2e-p15` 44 + `e2e-p2-org` 44 + `e2e-p2` 34 + `e2e-p3a` 85 + `e2e-p4` 37 = 282）。
`pnpm test` 是各包单测，**覆盖不到跨阶段的服务端到端**。
> **★ 一条方法论要求（来自 P3a 缺陷 ③ 的教训）**：**凡新增一个"靠直读 SQLite 文件断言"的 e2e 阶段，都要同时给出方言中立（纯 HTTP）的替代断言** ——
> 否则该阶段在 PG 下被**整体跳过**时，**不会有任何信号告诉你它没跑**（`deletePage` 因此在 PG 上从没被端到端跑到过）。
> 详见 `access-control.md` §4.3 的「★ v8：P3a 的方言成本」与 §4.6。

## 已知未完成的安全/质量项（非阻塞，应跟进）

- `packages/web/src/pages/WikiPage.tsx:341,487` 仍有两个**未按 `editContent` 收口**的「新建页面」按钮
- **能力不随角色变更刷新**：`capabilities` 只在 `loadAuth()` 写入；`denied`(403) 分支只跳转不刷新
  ⇒ 提升后不重载看不到新入口、降级后旧入口留着（外观层面的失败开放；服务端仍独立判定）
- `<SlotOutlet name="app-header" />` **零门控**（当前无插件贡献该槽，属潜在洞）
- 测试守卫窄缝：`packages/web/test/navPlan.test.ts:127-137` 的 `id` 计数正则；`navGate.test.ts:84-86` 以子串 `管理` 计数
- `packages/plugin-auth/src/index.ts:1278` 的 `clearLink()` 被重复调用且无 `writableEnded` 防护
- `packages/web/src/pages/AccountPage.tsx:63` 跳登录丢掉 `link=required`
- `packages/plugin-oidc/test/oidc.test.ts` 缺三块单测（`kid` 未命中强制刷新一次、`nbf` 边界、`jwks_empty` 失败关闭）
- `backlinks`/`links` 的可见性防护在**路由层**（`packages/plugin-wiki/src/index.ts:1217-1249` 两重检查），
  **服务方法本身仍只查 `pageExists`**（`:765-772`）—— 无当前消费者的不对称点
- `packages/db-postgres` 的 20 例是 **`fakePool()` 桩测试**（`packages/db-postgres/test/postgres.test.ts:98` 起），**不连真库**
- P3a 的扇出性能（子树 N 页 = N 次全表扫描）；检索不再覆盖 `page_grants` 与 owner/admin 覆盖（方向是"少给"，非泄漏）；
  `search/verify` 的 `tier_mismatch` 只做 NULL 计数代理 ⇒ 对"非 NULL 的陈旧 tier"完全盲
- `packages/plugin-wiki/src/blocks.ts:22` 曾声称"有源码级守卫测试钉住唯一写入路径"而**该测试不存在**（修复轮要求补上）；
  `0002_blocks_fts.sql:63` 引用的模块名 `blocksWriters` 不存在（实际是 `blocks.ts` 的 `syncBlocksForPage`）
  > **★ 现状（已核查）**：前半已由提交 **`1d608a6`**（`test(wiki): 补上 blocks.ts 声称的源码级守卫 + 修两处评审指出的瑕疵`）补上 —— 该提交新增 `packages/plugin-wiki/test/blocks.test.ts`（+113 行）并把夹具里**吞掉真错误的空 `catch {}`** 改成"只吞幂等性错误"（原因是：空 catch 会让坏掉的 `0002_blocks_fts.sql` 被静默跳过、**断言照绿，假绿比不测更糟**）。
  > **后半（`blocksWriters` 这个不存在的模块名）未再复核** —— 保留为待办，**定位请以 `blocks.ts` 的 `syncBlocksForPage` 为准**。

## ★ 仍未做的项（诚实清单，全部阶段合入之后）

> **★ 时效说明（回写当时的事实，务必连同日期一起读）**：本清单描述的是 **`main` = `5536bfa`** 的状态。
> **回写当时另有两条分支正在推进其中两项**（**未合入 `main`**，仅记录分支名与 tip，供接手者先查再动手）：
> - `feat/m5b-redlink-tristate` @ `94006ee`（*"feat(web): 出链红链三态 —— 「存在但无权查看」不得渲染成「不存在」"*）⇒ 对应下面第 1 项；
> - `feat/p4b-ops-ui` @ `aa59056`（*"feat(web): P4b-M4 审计与运维台面 —— 两类视图在界面上也分开"*）⇒ 对应下面第 5 项的**前端界面**部分。
> **⇒ 动手前先 `git log`/`git branch` 确认这两项是否已合入，避免重复劳动。**
>
> **★ 本批追记（基线 `98b4618`，工作树未提交）**：本清单里"CodeMirror 内的标记语法高亮 / 自动补全"**仍未做**；
> **`editor-toolbar-slots` 插件扩展点也仍未实现** —— 本批落地的排版工具栏是**宿主内置**的（由编辑页直接渲染，不是插件可贡献按钮的插槽），
> 两者**不是一回事**（详见下面新增的那条）。

- **M5 的红链三步态 `exists: 'hidden'`**（设计 §6.6 / §5.5 要求保留三步态以区分"不存在"与"存在但不可见"）—— 本批未实现
- **P4 的反向展开**（"谁能看这条"：直接授予 / 祖先链收紧 / 组织角色覆盖三条来源）—— 设计 §8.1 P4 行有此项
- **P4 的运维动作**：门户缓存清理提示（`s-maxage=300` ⇒ 收紧后需"清缓存 + 请求重新抓取"）、
  `/sitemap.xml` 与匿名可见集合做集合差的核对入口
- **`invitations.expires_at` 的回收**（本轮只做了 `page_grants`；`invitations` 在 `packages/plugin-org`）
- **前端界面**：审计页与会话管理页**都只有后端端点**，未接界面
- **CodeMirror 内的标记语法高亮 / 自动补全**（标记的书写体验部分）
- **`editor-toolbar-slots` 扩展点**（插件往编辑区贡献工具栏按钮）—— **仍未实现**。本批落地的**排版工具栏**是**宿主内置**的
  （`packages/web/src/components/editor/EditorToolbar.tsx`，由编辑页直接渲染），**不是**这个插件插槽；两者不要混为一谈
- 组织站点级设置接到界面

## 未验证项（诚实清单）

- **真实浏览器交互从未验证**：所有端到端都是 curl；前端只有类型检查、守卫测试与 SSR 测试
- **多实例部署必然失败**（OIDC 流程状态存进程内，**失败关闭方向**）
- **PG 上新端点的运行时端到端只覆盖了部分**：审计闭环、两视图分离、会话列表在 PG 上验过；
  **`grants/purge` 未在 PG 上跑**；P3a 的 G/H/I/K 阶段在 PG 下**整体跳过**（靠直读 SQLite 文件），
  只有**阶段 L** 是方言中立的
- **AI 两条端点的端到端不泄漏未验**（需要 LLM 配置；单测层面已覆盖主体透传与 SSE 建连时取主体）
- **D8 存量回填没有真实对象可验**（e2e 库是空的，回填无对象可作用）
- 移动条目后权限变化、第二个账号授权后立即可见 —— 未构造
- `plugin-org` / `plugin-authz` / **P3 新增的辅助函数** **无单元测试**，只由 e2e 覆盖
- PG 模式跳过了检索阶段（FTS 仅 SQLite，设计如此）与部分 e2e 阶段
