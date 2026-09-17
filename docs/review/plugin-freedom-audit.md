# GeeWiki 复盘与「万物插件化」自由度审计

> 审计时间：2026-09-16 ｜ 审计对象：工作树（HEAD `98b4618` + 201 项未提交改动）
> 审计目标：判读项目距离「**极致灵活 · 万物可靠插件实现 · 最大自由度**」还差什么
> 方法：全仓 typecheck/test 实跑 + 扩展点穷举 + 契约归属核查（所有结论附 `文件:行号` 证据）

---

## 0. 一句话结论

**工程质量与文档纪律属同规模项目的第一梯队**（1904 项测试 0 失败、typecheck 27 项目全绿、无已知依赖漏洞、安全红线有守卫测试钉住）。

但距你的目标，卡点不在工程质量，而在**一个单一根因**：

> **GeeWiki 的扩展点是「编译期枚举」，不是「运行期注册」。**

宿主对「插件能在哪里出现」有一套**写死的、多处镜像的白名单**；对「插件能成为什么」有一套**分散在各插件里的契约**。于是插件生态的自由度上限 = 宿主作者**预先枚举**的那些格子，而不是插件作者**能想到**的东西。

这个根因可解，且改造成本可控（见 §6）。下面给出全部证据、风险与演进路线。

---

## 0.5 整改进度（滚动更新）

| 项 | 状态 | 落地内容 |
| --- | --- | --- |
| 工程卫生：git 索引废弃重命名 | ✅ 已修 | 清掉索引里 15 条指向不存在目录的 `plugin-ai-assist`/`plugin-ai-qa` 条目；工作树现在一致 |
| 工程卫生：`undefined/` 垃圾目录 | ✅ 已删 | 92 KB 空 SQLite 残留 |
| **A1 插槽白名单闭合** | ✅ 已解 | **F1 动态插槽**：插件可自定义扩展点（名字须含 `/`） |
| **A2 插件无法注册路由** | ✅ 已解 | **F2 页面路由**：清单声明 + 运行期注册组件 |
| **A3 SDK 不导出 react-dom** | ✅ 已解 | **F6**：映射 `react-dom` / `react-dom/client`（共用宿主实例）+ `createPortal` / `createRoot` |
| **B1 契约归属倒挂** | ✅ 已解 | **F3**：4 个服务契约（`AuthService`/`SearchService`/`WikiService`/`LlmService`）及全部闭包类型搬进 `core/src/services.ts` + `core/src/llm.ts`，实现包改为转出 |
| **B2 附件存储无接口** | ✅ 已解 | **F4**：`AttachmentService` 入 core；`createFsAttachmentService` 为内置实现；`attachmentProvider:'none'` 可关掉以让外部实现顶替 |
| **B3 编辑器插槽是二等公民** | ✅ 已解 | **F5**：`EditorSlotProps` 增 5 个可选属性（上传/档位/段落授权/选区/句柄）+ 新增 `EditorHandle` 契约 |
| **B4 能力集合闭合且真源在前端** | ✅ 已解 | **F9**：能力名归一到 `core/src/domain.ts`；`CapabilityService` 入 core + manager 注册表；`RouteAccessOptions.capability` 支持插件自定义能力闸门 |
| **C2 Markdown 管线无扩展点** | ✅ 已解 | **F8**：`markdownExt.ts` 注册表 + 独立 `Marked` 实例（撤销是真的撤销），宿主 SDK 暴露注册入口 |
| **§3.1 路由默认 public（审计键）** | ✅ 已解 | **F11**：32 处隐式公开路由全部显式化；`routes()` 枚举 + 启动审计 + `GEEWIKI_STRICT_ROUTE_ACCESS=1` 拒启；全量路由守卫 |
| **§3.1 插件无权限声明** | ✅ 部分解 | **F10**：`permissions` 清单 + 激活提示 + 快照下发 + 「用法 ⇒ 必须声明」守卫；**隔离模式未做**（见 §0.5） |
| **A4 插件 UI 只能带单段入口名** | ✅ 已解 | **F13**：`entry`/`css` 支持分层路径；`PLUGIN_UI_PREFIX`/`FILE_SEGMENT` 归一到 `@geewiki/core/domain`（web 侧副本删除，判据升级为引用同一性） |
| **§3.2 插件无健康可见性** | ✅ 已解 | **F12**：`module.health?()` 探针 + 带超时的聚合 + `GET /api/plugins/health`；`owner` 请求数归因 |
| **C1 平台事件仅 2 个** | ✅ 已解 | **F7**：`PAGE_CREATED/DELETED`、`USER_LOGIN`、`SEARCH_PERFORMED`、`ATTACHMENT_UPLOADED`、`PLUGIN_ACTIVATED/DEACTIVATED` 契约入 core（**刻意删掉无发射点的 `PAGE_RENAMED`**）|
| **C3 无主题/品牌插件化** | ✅ 已解 | 同上表 **F16** 行 |
| **优化点 3 README 拆分** | ✅ 已解 | **1122 行 / 224 KB → 273 行 / 49 KB**；流水账迁 `docs/changelog/implementation-log.md`、测试台账迁 `test-ledger.md`、PG 小节并入 `docs/deployment.md` |
| **优化点 4 文档改「结论优先」** | ✅ 已解 | 新增 `docs/README.md` 索引 + 四条文档纪律；修正 4 处过时读数（1904→2105、22→24、18→21、`db-pg`→`postgres`）|
| **优化点 5 提交那 201 项重构** | ⏸ **刻意未做（需人授权）** | 它会**改动仓库历史**（按语义拆 5–10 个 commit）。本会话自始至终未提交任何改动，HEAD 仍 `98b4618` |
| **优化点 1 插槽镜像膨胀** | ✅ 已解 | **单一真源化**：新增 `@geewiki/core/slots` 浏览器安全子路径，web 侧 3 份手抄镜像归零 |
| **优化点 2 矛盾注释** | ✅ 已解 | `packages/manager/src/slots.ts` 文件头原先站在「不放独立插件」的反面，已改为只回答「**注册表实现**放哪」并显式声明「顺序问题不是回避理由」；`docs/roadmap.md:67` 那条过时指控（称 core 仍写「由管理器提供」）改为「已清理」 |
| **优化点 7 `db-sqlite` 零覆盖** | ✅ 已解 | 新增 `packages/db-sqlite/test/sqlite.test.ts`（9 例）+ `test` 脚本 + `tsconfig` include `test`；覆盖迁移幂等/失败迁移同事务回滚/未就绪报错/事务回滚/插件 apply 失败不留半注册服务 |
| **优化点 8 插槽 props 无自助入口** | ✅ 已解 | `SLOT_PROPS_SCHEMA` 入浏览器安全的 `core/src/slots.ts`，经 `GET /api/plugins/slots` 的 `props` 字段下发（外部插件是裸 JS，无 TS 类型可查）；`packages/core/test/slot-props-schema.test.ts` 按各项自带的 `contract` 锚点做**顶层字段名+可选性双向比对**，漂移即红 |
| **§3.2 `apply()` 无超时** | ✅ 已解 | **F14**：`runtime.applyTimeout`（缺省 30s，`<=0` 关闭）+ 超时后**主动回收晚到的 fiber**（防「幽灵插件」）；错误码 `load_timeout` → HTTP 504；`packages/manager/test/apply-timeout.test.ts` 8 例 |
| **C3 无主题 / 品牌插件化** | ✅ 已解 | **F16**：`lib/pluginTheme.ts` 覆盖注册表（只放行 `--gw-*` 原始 token）+ 宿主 SDK `registerTheme`/`unregisterThemes`（SDK **0.7.0 → 0.8.0**）；深浅两模式**分段注入**以免浅色值泄漏进深色；`packages/web/test/pluginTheme.test.ts` 12 例 |
| **F18 向量检索（L-17 后置）** | ✅ **接口已落地；查询路径接线仍后置** | **F18**：`EmbeddingProvider` 契约 + `EmbeddingServiceError` + **`assertEmbeddingResult()` 校验器** + **`probeEmbeddingProvider()` 永不抛错的探针**（`packages/core/src/services.ts`）；14 例。**刻意不带实现**：宿主不必背 `onnxruntime`/`transformers.js` 重依赖，也不绑死供应商。查询路径接线需先定「向量存哪、维度变更怎么办」，与 L-17 同一决策 |
| **F21 插件脚手架** | ✅ 已解 | **F21**：`packages/manager/src/scaffold.ts`（纯函数生成 + 拒绝覆盖）→ `pnpm run new:plugin <名字> [--ui] [--dry-run]`；**12 例守卫把生成物送回真管线**（真 `parsePluginManifest` + 真 `loadExternalPlugins` 端到端发现并 import） |
| **优化点 6 `tmp/` 清理** | ✅ 已解（`undefined/` 早在首轮已删） | `packages/manager/src/maintenance.ts`（纯判据 + 四道安全闸门）→ `pnpm run clean:tmp [--yes] [--all] [--older-than N]`，**默认 dry-run**；11 例含**符号链接逃逸拒绝**。`tmp/` 实测 1.9 GB / 147 项 |
| **F15 i18n 体系** | ✅ **机制已解**（宿主与插件共用一套 catalog），见 §0.5「F15」 | core 契约（`domain.ts`）+ 管理器聚合 + `GET /api/i18n[/:locale]`（public）+ 宿主 SDK `t`/`getLocale`（0.9.0）+ 前端 `lib/i18n.ts`。**未做**：宿主存量界面的全量抽键（机械改造） |
| **F17 插件市场 / 远程安装** | ✅ **核心已解（安装 + 完整性校验）**，见 §0.5「F17」 | `pnpm run install-plugin <目录\|.tgz\|https URL>` + `--verify`；`GET /api/plugins/integrity`（admin）。**未做**：远端注册表与发布者签名 |
| **F19 PostgreSQL 适配** | ✅ **已解，并完成项目首次真实 PG 端到端验证** | 见 §0.5「F19」。三处真 bug 被真实 PG 抓出并修掉；新增两条类级守卫；`F19` 从此不再只是「有意延期」 |
| **F20 备份 / 恢复** | ✅ 已解 | `packages/manager/src/backup.ts` + `pnpm run backup` / `pnpm run restore` + `POST|GET /api/backup`（admin）。数据库走 **`VACUUM INTO`**（一致性、可热做、产物自包含无 WAL 边车）；**恢复只能停机走 CLI，刻意不做成路由**。14 例 |
| **`scripts/` 从未被类型检查** | ✅ 已修（本轮顺带发现） | 新增 `tsconfig.scripts.json` 并接进根 `typecheck`。首次检查即暴露 **16 处既有错误**（`scripts/acceptance/**` 的一次性验证 runner + web 源码在 NodeNext 下的扩展名问题）；**`scripts/acceptance` 被有意、有期限地排除**并在配置里写明原因与收口方法 |
| **文档引用指向不存在的文件** | ✅ 已修（本轮顺带发现） | `theme.ts` 与 `index.html` 都写「见 `test/theme.test.ts`」，而该文件**不存在**——守卫实际在 `packages/web/test/designSystem.test.ts`；两处已更正。这类缺陷会让后来者找不到守卫，进而误以为没有、或重新加一份重复的 |

### F1 动态插槽（已落地）

- `packages/core/src/index.ts`：内置 7 个改名为 `BuiltinSlotName`；`SlotName` 放宽为 `BuiltinSlotName | (string & {})`；新增 `PLUGIN_SLOT_NAME`（`/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/`，**必须含 `/`**）、`isBuiltinSlotName` / `isPluginSlotName` / `slotCardinalityOf`、`SlotDeclaration`。
- **判据设计**：内置名一律不含 `/`，含 `/` 的一定是插件扩展点 ⇒ 开放键空间**没有**牺牲"内置名笔误仍被拒绝"这条可见性。
- `SlotService` 新增 `define(owner, slot, meta?)` 与 `declarations()`；`SlotRegistry` 分离存储"声明"与"贡献"（卸载贡献者不会误删别人开的扩展点）。
- 宿主 SDK `0.4.0` 新增 `PluginSlotOutlet` / `slotContributors` / `useSlotEntries` —— **插件第一次可以自己开扩展点**，别的插件往里贡献。
- 诊断：`GET /api/plugins/slots` 新增 `declarations` 与 `undeclared`（后者专门暴露"命名空间拼错"这一**开放键空间新引入**的失败模式）。
- **修正了一处既有缺陷**：`slotAssignments()` 原先没把声明表传给 `resolveSlots`，会让 `single` 声明静默失效。
- 镜像守卫**换了一种钉法**：`SlotName` 放宽后原先"靠调用链触发 TS2345"的隐式编译器守卫会**静默失效**，改为 `slots.tsx` 里的 `Expect<A extends B>` 显式双向编译期断言 + 源码级运行期守卫。

### F6 react-dom / portal（已落地）

- `index.html` 的 import map 新增 `react-dom` → `/host-sdk/react-dom.js`、`react-dom/client` → `/host-sdk/react-dom-client.js`。
- 新增两个 shim（`packages/web/public/host-sdk/react-dom*.js`），逐条枚举具名导出（ESM 无法动态转发）。
- 宿主 SDK `0.6.0` 新增 `ReactDOM` / `ReactDOMClient` / `createPortal` / `createRoot` / `hydrateRoot`。
- **关键收益**：`createRoot` + shadow DOM 是既有限制「插件 CSS 全局注入、只靠 `.gw-fixture-*` 前缀约定」的**逃生口**——插件可以做真正的样式隔离。
- 新增 `packages/web/test/hostSdkSurface.test.ts`：钉住「import map 条目 ↔ shim 文件存在 ↔ shim 读取的 SDK 字段 ↔ 具名导出」这条四处副本的链（任一处漏改都是插件整体不可用或调用时才炸）。

### F2 页面路由（已落地）

- `packages/core/src/index.ts`：新增 `PLUGIN_ROUTE_ID`、`RESERVED_ROUTE_IDS`（11 个宿主保留首段）、`PluginRouteDecl`；`GeeWikiManifest.routes`。
- `packages/manager/src/routes.ts`（新）：`collectRouteDecls` / `resolveRouteDecls`（保留 id 直接拒绝；同 id 按激活顺序最早者胜出、其余进 `routeConflicts`）/ `effectiveRoutesByOwner`。
- 路由声明**进入口表**（`PluginUiTableEntry.routes`）——这是必须的：它是"要不要推迟加载该插件产物"的判据之一。否则"只贡献按需插槽 + 一个页面"的插件会被整个推迟，**用户点导航项看到空白页且不报错**。
- `packages/web/src/lib/routes.tsx`（新）：组件注册表（`registerRoute` / `unregisterRoutes` / 错误边界 / 按 owner 回收）。
- `App.tsx`：`known` 判定与页面分派都接入插件路由；主导航（`group: 'main'`）与「管理 ▾」（`group: 'admin'`）都合并插件项，判据与内置项**同一个 `visibleDests`**。
- **「已声明未注册」有独立占位**（`PluginRoutePendingPage`），刻意**不落 `notfound`**：那会把"插件坏了"误导成"地址不存在"。
- 未知能力键 ⇒ **丢弃并告警**（失败关闭），绝不当"无要求"放行。
- 宿主 SDK `0.5.0` 新增 `registerRoute` / `unregisterRoutes`。

### F3 契约下沉（已落地）

**B1「语义倒挂」已消除**：原先四个服务契约声明在**实现它们的插件包**里，于是"想替换某个服务，必须先依赖被替换的那个包"。现在四个契约都在 `@geewiki/core`。

| 契约 | 原声明位置 | 现在真源 | 一并搬走的类型闭包 |
|---|---|---|---|
| `SearchService` | `plugin-search/src/index.ts:202` | `packages/core/src/services.ts` | `SearchBlockRef` / `SearchHit` / `SearchResult` / `ContentView` / `SearchMode` |
| `AuthService` | `plugin-auth/src/index.ts:189` | `packages/core/src/services.ts` | `AuthUser` / `OidcAuthOutcome` / `OidcClaims` / `OidcProvider` / `OidcProviderInfo`（后三者原在 `plugin-auth/src/oidc.ts`） |
| `WikiService` | `plugin-wiki/src/index.ts:404` | `packages/core/src/services.ts` | `WikiPageSummary` / `WikiPageDetail` / `WikiSaveInput` / `WikiSaveResult` / `WikiNavOrder` / `WikiBacklink` / `WikiOutlink` / `ResyncReport` |
| `LlmService` | `plugin-llm/src/types.ts:330` | **`packages/core/src/llm.ts`**（新文件，443 行） | 整个 `types.ts`（18 个导出）+ `tools.ts` 的 4 个工具调用类型 + `credentials.ts` 的 `CredentialResult` |

- **执行方式（实测后的定稿）**：不是新建 `@geewiki/contracts` 包，而是搬进 core 的**两个模块** —— `services.ts`（服务契约，**非**浏览器安全）与 `llm.ts`（LLM 契约）。原方案的多一个包、多一层版本协调、多一份构建配置，全都不必要。
- **向后兼容**：实现包一律改为**转出**，既有 `import { WikiService } from '@geewiki/wiki'` 等调用点零改动、零迁移成本。
- **`VersionListRow` 的处理（易错点，记下来）**：它是 `plugin-wiki` 的**内部 DB 行类型**（`interface`，未导出），但恰好声明在契约段中间（原 331–350 行）。搬运时**必须排除**并留在实现包 —— 它不是契约，跟着搬会把它变成 core 的公开面。最终它被移到契约段之后，仍是包内私有。
- **实现包的"运行期"部分原样留下**：`resolveCredential`（读环境变量）、`assembleToolCalls`（流式增量拼装）留在 `@geewiki/plugin-llm`。**类型与实现分离**正是本次的目的 —— 只有类型是契约。
- **一个守卫被正确地打红了**：`packages/plugin-llm/test/degrade.test.ts` 原本从 `src/types.ts` 正则抽取 `LlmErrorCode` 的成员集合。契约搬走后它当场失配（`未找到 \`export type LlmErrorCode =\` 声明`）—— 这是守卫**在该响的时候响了**，不是被搬运打破的。修法是把它改读**真源** `packages/core/src/llm.ts`，并**新增一条更强的守卫**：本包的 `types.ts` **不得再本地定义**这些契约名（比对"内容相等"在刚抄完一份时是通过的，只在漂移后才红；钉"不得本地定义"才在构造上排除了第二份真源）。
- **验证**：全仓 `typecheck` 27 项目 exit 0；全量测试 **1962 用例 / 0 失败 / exit 0**（较改造前 1961 多 1 例 = 新增的转出守卫；日志 `data/verify/test-f3.log`）。

### F5 编辑器等价契约（已落地）

**B3「editor 插槽是二等公民」已消除**：原先插件编辑器替换内置编辑器时会**静默丢掉四项能力**（附件上传、段落档位、段落授权、选区/写回）。现在 `EditorSlotProps` 补齐了这些**可选**通道。

| 新增可选属性 | 原内置编辑器独有之处 | 接线 |
|---|---|---|
| `onUploadFiles?(files: File[]): Promise<string[]>` | `WikiPage.tsx` 的 `onUploadFiles={uploadFiles}` | 与内置路径**同一个** `uploadFiles`（不存在第二套上传实现 ⇒ 限流/审计/错误文案不会分叉） |
| `blockTiers?: { pageVisibility: PageVisibility \| null } \| null` | `blockTiers={{ pageVisibility: pagePerm?.visibility ?? null }}` | 同一事实源 |
| `onManageBlockGrants?(block: { ordinal, excerpt })` | `onManageBlockGrants={setGrantBlock}` | 同一出口。**缺了它，把一段设成"需单独授权"后再没有任何界面能放人进来** |
| `onSelectionChange?(selection \| null)` | `onSelectionChange={setEditorSelection}` | 新 state `pluginEditorSelection` |
| `onEditorHandle?(handle: EditorHandle \| null)` | `handleRef={editorHandleRef}` | 新 state `pluginEditorHandle` |

- **新增 `EditorHandle` 契约**（core + web 镜像）：`insertAtCursor(text)` / `replaceSelection(text): boolean` / `setDoc?(text)`。这是"插件编辑器能被**其它插件的** `editor-toolbar` 写入"的唯一路径 —— 宿主自己不知道插件编辑器的光标在哪，只有插件能实现它。`setDoc` 标为**可选**（AI 回退用；不实现则该编辑器上不登记"回退"工具，而不是给一个无效实现）。
- **能力缺失仍用 `undefined` 表达，不用假函数**：这一条是既有裁决，F5 没有推翻它。插件**没交句柄**时，工具栏的 `insertAtCursor`/`replaceSelection` 与 AI 工具的写回通道**照旧留空**；`editorToolLiveRef` 的判据从「谁占着插槽」改为「**有没有句柄**」——这才是能力的真实来源。
- **`EditorSlotOutlet` 的拖放拦截改为条件式**：原先无条件 `preventDefault` + 提示"编辑器不支持上传"。现在以 `props.onUploadFiles !== undefined` 为判据 —— 宿主**提供了**上传就放行事件让插件编辑区接住（否则插件永远收不到那次拖放），**没提供**才拦截并给可见提示。三条路径（dragover / drop / paste）都要放行，漏一条即静默失效。
- **`PageVisibility` 下沉到 `packages/core/src/domain.ts`**（**浏览器安全**子路径 `@geewiki/core/domain`，零 node/cordis 依赖）。原先它只定义在 `web/src/api.ts:1344`，而 `blockTiers` 是**跨端**契约 —— 在两边各写一份就是两份真源，而档位这类白名单一旦漂移，失败形态是**静默越权**（多认一个值 = 放行一个不该放行的档位），不是编译错误。web 的 `api.ts` 改为转出。该模块也是 **F9（能力注册表）** 中 `AuthCapabilities` 的预定落点。
- **过时注释一并改掉**（原注释自称"插槽路径没有上传能力，这是本批明确的边界"）—— 留着它就是下一轮的最强误导。
- **新增守卫**：`packages/web/test/attachmentUploadPlan.test.ts` 增加一条，钉住「以 `props.onUploadFiles` 为判据 + 三条路径各自放行」。这条防的是**最难人工发现**的一类回归：只加了 props 忘了改拦截 —— 界面完全正常，用户拖入文件却毫无反应，且**没有任何报错**。
- **验证**：全仓 `typecheck` exit 0；全量测试 **1963 用例 / 0 失败 / exit 0**（较 F3 后 +1；日志 `data/verify/test-f5.log`）。

### F4 附件 provider 接口（已落地，消除 B2）

**B2 的形态**：附件字节存储硬编码在 `plugin-wiki/src/attachment-store.ts`（`node:fs` + sha256 内容寻址），全仓**没有** attachment-service。后果是"换对象存储（S3/WebDAV）"只有两条路 —— 改 wiki 源码，或整体替换 wiki（**连带丢掉页面 ACL 与块级投影**）。后者尤其糟：附件端点上方那一整套判定时序（块级授权、正文引用、`expires_at`、`ETag` 逐请求现算）都住在 wiki 里，换存储不该把它们一起推倒。

- **契约落在 `packages/core/src/services.ts`**（与 F3 同一落点，非浏览器安全）：`AttachmentService`（`ready` / `put` / `get` / `remove`）+ `StoredAttachment`（`sha256`/`byteSize`/`dedup`）+ `StoredBlob`（`size` + `open()`）+ `AttachmentServiceError` / `AttachmentServiceErrorCode`。
- **边界刻意划在「字节」上**：元数据（`attachments` 表的 `sha256`/`ext`/`mime`/`byte_size`/`original_name`）与"谁能看这个附件"的判定**仍完全属于 wiki**。所以一个 S3 实现既不必理解块级授权、也不必碰 `attachments` 表 —— 这正是"接口划错地方就会把 ACL 一起拖下水"的反面。
- **`get()` 返回 `StoredBlob{size, open()}` 而不是直接给 `Readable`**：响应头要 `Content-Length`，而"取长度"与"开流"若分成两次，两者之间文件可能就没了。端点的 `stat` + `createReadStream` 两步因此收敛成一次探测。
- **`get()` 对缺失对象返回 `undefined` 而不是抛错**：`blob_missing` 是**可诊断状态**（元数据在、字节不在），端点据此回 404 并打日志；抛错会把它变成一个需要调用方解析 errno 的 500。
- **错误类必须搬进 core —— 这条最容易漏，且失败是静默的**。错误类是契约的一部分：若 `AttachmentStoreError` 留在 wiki 包，替换实现要么依赖被替换的包（语义倒挂），要么自己造一个同名类 —— 而后者会让端点的 `err instanceof AttachmentStoreError` **静默失配**，于是存储层报的 413 / 400 / 503 **全部退化成 500**，并计进 `stats().consecutiveFailures`（"磁盘满了"于是被升级成"整站被看门狗熔断"）。现在 `attachment-store.ts` 用 `export { AttachmentServiceError as AttachmentStoreError }` 转出**同一个类对象**，`instanceof` 与 `code` 分类天然一致，旧名保持可用。
- **内置实现不是特权实现**：`createFsAttachmentService({dataDir, tmpDir})` 实现该契约；`StoreStreamResult` 由本地 interface 收敛为 `type StoreStreamResult = StoredAttachment`（形状就是契约的一部分，本地再来一份会在字段增删时静默漂移）。
- **替换路径显式化**：`WikiConfigSchema` 新增 `attachmentProvider: 'builtin' | 'none'`（默认 `'builtin'`）。设 `'none'` 时 wiki **不再注册**内置实现，改用 `ctx.get('attachment-service')` 拿到的那个 —— 换 S3 不需要改 wiki 源码。**为什么不做自动探测**：cordis 服务在提供者 `apply()` 结算前对其它插件不可见（`ctx.get` 返回 `undefined` 且**静默**），自动探测会在激活顺序变化时悄悄退回内置实现或悄悄拿不到服务；显式配置让这件事在配置里**可见**。
- **消费一律逐请求现取**（`attachmentService()` 内每次 `ctx.get`），不在激活期存快照 —— 提供者可能晚到、也可能被热替换，存快照会把"服务晚到"永久固化成"附件永远 503"。
- **新增守卫 `packages/plugin-wiki/test/attachment-service.test.ts`（4 例）**：① 钉**类对象同一性** `assert.equal(AttachmentStoreError, AttachmentServiceError)` —— 有人为省一次跨包 import 把类搬回本地时立刻红；② `ready → put → get → remove` 全链路（含幂等去重、`dedup:true`、tmp 不留残渣、`open()` 字节与 `size` 一致）；③ `get` 缺失返回 `undefined` 不抛错；④ 超限 / 长度不符各自抛对 `code`，且**最终内容路径下不留任何对象**。
- **验证**：`pnpm run typecheck` 27 项目 exit 0（`grep -c "error TS"` = 0）；全量测试 **1967 用例 / 1967 通过 / 0 失败 / exit 0**（较 F4 前 +4）；日志 `data/verify/tc-f4.log`、`data/verify/test-f4-final.log`。
- **仍未做**：真正的 S3/WebDAV 插件（属"新增插件"，不是接口工作）。接口、内置实现、替换开关、守卫四件已齐，新增实现只需提供同一 token。

### F12 插件健康检查 + 请求数归因（已落地；配额强制未做）

**问题形态**（§3.2「低」）：插件"激活成功"只说明 `apply()` 没抛错，**不说明它现在是好的** —— 模型供应商连不上、迁移漏了一张表、外部 API 挂了，都发生在激活之后。没有探针时，运维只能从用户的报错里反推是哪个插件坏了。

- **探针挂在插件模块上（`module.health?()`），不另开服务** —— 这是一个刻意的设计选择。插件模块对象本来就被管理器持有（`entry.module`），而健康检查是**拉取式**的、由 REST 请求触发，于是它天然不需要任何"注册期可见性"，也就**绕开了 slot-plugin 记录的那个陷阱**（插件 `apply` 期 `ctx.get` 拿不到尚未结算的服务）。再开一个 `health-service` 只会**为了对称**而引入一处必然踩坑的注册时序。
- **三条判据都是刻意的**：① 只探测 `active` 插件（去调未激活插件的探针会把"没在跑"报成"坏了"）；② **超时由宿主强制**（缺省 2s，独立于插件实现）；③ **`ok:false` 与 `error` 严格分开** —— 前者是"插件说它坏了"（去看它的 `detail`），后者是"我们没能问到它"（去看宿主日志）。混在一起会让运维做错方向的动作。
- **探针缺失不是不健康**：`health` 留空。报成 `ok:true` 是**撒谎**（我们并没有验证过），报成 `ok:false` 是误报 —— `undefined` 是唯一诚实的取值。
- **形态校验：本设施唯一会骗人的地方**。返回 `undefined` / `{}` / `'ok'` / `{ok: 1}` 的探针（写错、忘了 return、被 `any` 放过去）一旦不校验，就会以"有 `health` 字段"的形态出现在报告里，消费方很容易读成健康。现在一律报 `error`，与"自报 `ok:false`"和"超时"三者互不混淆。
- **★ 测试抓到一个真 bug（值得记）**：第一版给超时定时器加了 `timer.unref()`，理由是"探针卡住时不让定时器把进程吊着"。后果是**超时永远不触发** —— `unref()` 让定时器不再阻止事件循环退出，于是在"除了这个探针没有别的待处理工作"的场景（单测、空闲实例）下事件循环直接结束，`Promise.race` **永不 settle**。现象是 node:test 报 `Promise resolution is still pending but the event loop has already resolved` 这种极难定位的形态。**超时保护本身不能依赖任何外部工作来驱动。**
- **请求数归因（`RouteAccessOptions.owner` + `HttpRouterService.ownerStats()`）**：`router.register()` 由各插件在自己的 `apply` 里直接调用，而路由服务**拿不到"当前是谁在注册"**（`ctx.get('http')` 对所有调用方返回同一个对象）—— 所以按插件归因只能靠自觉声明。它是**可观测性**字段，不是安全边界（插件可以填别人的名字），宿主不用它做任何判定。
- **计数放在闸门之前**：被 401/403 拒绝的请求**同样计入** —— "某个插件的端点正被大量匿名请求打"恰恰最该被看见，只统计成功请求会把它藏起来（守卫里就有一条"一次放行 + 一次被拒 = 2"的断言）。
- **未声明 owner 的路由不归因**，不硬塞给某个插件：错误归因比没有归因更危险（会让运维去查一个根本无关的插件）。
- **新增守卫（`packages/manager/test/health.test.ts` 7 例 + `packages/server/test/route-access-audit.test.ts` +1 例）**：只探 active（断言未激活插件的探针**调用次数为 0**）；卡死 ⇒ `timedOut` 且整体不被拖住；抛错 ⇒ `error` 且不拖累其它插件；无探针 ⇒ 三个字段全空；形态非法 ⇒ `error` 且无健康结论；逐个隔离；报告覆盖全部注册插件。端到端：`ownerStats()` 枚举、计数含被拒请求、owner 不重复。
- **明确未做的部分（如实记录，不含糊带过）**：
  - **内存 / CPU 按插件归因** —— 插件与宿主**同进程、同权限**（§3.2 已知限制），`process.memoryUsage()` 只能给出整进程读数，无法归属到插件。没有隔离就没有归因，这是架构级前提而不是实现难度。
  - **配额强制**（超过阈值即拒）—— 本轮只交付**计数**。强制执行需要先确定"超限怎么办"（429？还是停用插件？后者与"自动级联停用"一样是破坏性动作，审计报告 §5 已明确列为**有意不做**），那是一个产品决策而不是实现细节。
  - **owner 的推广** —— 目前只有 manager 自己的 5 条路由声明了 `owner`（作为示范用法）。其余内置插件未逐个声明，因为逐条补 90+ 处属于机械改动、且不改也不影响正确性（只是不归因）。
- **验证**：`pnpm run typecheck` 27 项目 exit 0（`grep -c "error TS"` = 0）；全量测试 **2019 用例 / 2019 通过 / 0 失败 / exit 0**（F12 前 2011，+8）；日志 `data/verify/tc-f12.log`、`data/verify/test-f12.log`。

### F13 插件 UI 入口分层路径（已落地，消除 A4）

**A4 的形态**：`geewiki.client.entry` / `.css` 必须是**单段文件名**（`PLUGIN_UI_FILE_SEGMENT` 不含 `/`）。而产物形态是插件自己的事 —— 多入口或分目录输出时入口很自然落在 `ui/index.js`。此时插件只有两条路：把产物摊平去迁就宿主，或者**声明不了自己的 UI**（`pluginUiEntryOf` 对非法名返回 `undefined`；症状是"插件激活了但界面完全不加载"，日志里只有一条"没有产物"）。

- **先核实，避免做多余的字段**：我原本准备照报告建议加 `client.assets: {root, dir}`。核实后发现**静态层早就支持子目录**（`packages/server/test/plugin-ui-assets.test.ts` 已端到端覆盖 SVG / JS chunk / 字体 / PNG / 路径穿越 / 符号链接逃逸），且 **MIME 表已含 `woff`、`woff2`、`wasm`、`map`**（`packages/server/src/index.ts:954` 起），未知扩展名给 `application/octet-stream` 而绝不回退 `text/html`。因此"资源根"就是 UI 根本身，`assets` 字段会**多一处可以与实际产物不一致的地方** —— 不加，并把理由写进 `GeeWikiClient` 的文档（避免下一个人再提一遍）。
- **真正的缺口只有一个**：清单不能声明分层入口。判据从"必须单段"放宽为"单段 **或** 分层路径"，由新增的 `isPluginUiEntryPath()`（`core/src/domain.ts`）判定，复用 `PLUGIN_UI_ASSET_PATH` 的逐段规则与深度上限。
- **放宽的是限制，不是防护**：逐段必须以 `[A-Za-z0-9]` 开头，故 `..`、`.`、空段、绝对路径、`%` 编码、空格、反斜杠**全部不匹配** ⇒ 失败方向与改动前一致：**整体视为未声明（不加载）**，而不是"加载到别处去"。真正的路径防护仍在静态层（段比较 `isContained()` + realpath + 严格不折叠空段）。守卫用例逐项钉住这 12 种危险形态，并专门写明"若有人把判据换成'含 `/` 就放行'，`../secret.txt` 会被拼进 `join(root, entry)`"。
- **`css` 用同一条判据**：入口合法但样式是穿越路径 ⇒ **整条声明作废**，不留"入口可用但样式名是穿越路径"这种半可信状态。
- **顺带消灭两处镜像**：`packages/web/src/lib/pluginUiPlan.ts` 原先自带 `PLUGIN_UI_PREFIX` 与 `PLUGIN_UI_FILE_SEGMENT` 的**同名副本**（理由是"web 进不了 `@geewiki/core`，顶层 `import 'node:fs'`"）。那个理由在 F5/F9 之后**已经不成立** —— 现在有浏览器安全子路径 `@geewiki/core/domain`。两个常量与四条路径规则一并搬进 `domain.ts`，core 根**转出**以保持既有 import 可用。web 侧的测试判据也从"内容相等"升级为**引用同一性**（副本无法伪装成同一个对象；"内容相等"在有人刚抄完一份时是通过的，只在漂移发生后才红）。
- **新增守卫（`packages/server/test/plugin-ui-entry-path.test.ts`，3 例）**：① 分层 entry/css 放行 + 单段向后兼容 + 缺省值不变；② 12 种危险形态整体视为未声明（含深度超限、编码变形、Windows 反斜杠）；③ **端到端**：声明 `ui/index.js` 的插件，入口 / 分层样式 / 同目录 sourcemap 都经 `/plugins-ui` 取到且 MIME 正确，入口表**原样下发分层路径**（否则前端会去请求 `client.js`），穿越请求仍 404。
- **一次真实回归被抓住并修正**：`packages/manager/test/plugin-ui.test.ts` 有一条用例把 `'a/b.js'` 列在"应被剔除"里 —— 它钉的正是 A4 这条限制。已从该列表移除并补上"分层入口与分层样式都合法且原样保留"的断言，而不是把测试改成"什么都接受"。
- **验证**：`pnpm run typecheck` 27 项目 exit 0（`grep -c "error TS"` = 0）；全量测试 **2011 用例 / 2011 通过 / 0 失败 / exit 0**（F13 前 2008，+3）；日志 `data/verify/tc-f13.log`、`data/verify/test-f13.log`。

### F11 全路由访问等级审计守卫（已落地）

**问题形态**（§3.1「中」）：`register()` 的 `access` 可省，省略即 `public`（匿名可调）。96 个调用点里 **32 处**没写 —— 而"**忘了写**"与"**故意公开**"在源码里长得一模一样：两种情况的 `access` 都是 `'public'`，评审看不见、运行期也毫无痕迹。

- **逐个显式化（32 处）**：`register(..., { access: 'public' })`。绝大多数按**当前实际行为**标注，其中 **`plugin-ai-journal` 的 4 条收紧为 `'user'`** —— 它的 `gate()` 本来就把匿名拒成 401，所以这是**可证明等价**的收紧（且从"处理器里拒绝"提到"进处理器之前拒绝"，失败更早、不做无用功）。
- **一个必须记录的更正（差点改错）**：`plugin-wiki` 的读端点（页面列表/详情/版本/附件/backlinks/links）**保持 `public` 是有意的** —— 它的 `requirePrincipal`（`plugin-wiki/src/index.ts:731`）**只拒绝"完全没有 Principal"，不拒绝匿名**，匿名访客拿到的是 `anonymousPrincipal` 然后走逐对象策略过滤（源码注释明说「读端点保持 public」）。把它们的 `access` 收紧成 `'user'` 会**真的破坏匿名阅读**。我原本按"处理器里调了 requirePrincipal ⇒ 等价于 user"推断，读了实现才发现相反 —— 这类推断必须以实现为准。
- **`HttpRouterService.routes?()` + `HttpRouteInfo`（core）**：暴露 `{method, path, access, capability?, explicit}` 的只读快照（**不含处理器**，它不是"拿到别人处理器的入口"）。`path` 保留 `:param` 原始形态，诊断清单才能与源码逐字对照。
- **`explicit` 是审计的关键字段**：它区分"作者写了 `{ access: 'public' }`"与"作者什么都没写" —— 没有它审计无从谈起，因为两种情况运行期完全等价。
- **启动审计 `auditRouteAccess()` + `purgeRouteAccessEnv`**：`GEEWIKI_STRICT_ROUTE_ACCESS=1` 时**拒绝启动**（抛错并带上完整清单），默认则聚合成**一条**告警（不是每条一行 —— 噪声会把告警训练成背景音）。它跑在**管理器结算之后**：路由是在各插件 `apply` 里注册的，放早了会审计到空表，于是"审计通过"与"什么都没审计"无法区分。
- **新增守卫（`packages/server/test/route-access-audit.test.ts`，7 例）**：① 对**全量默认注册表**（`buildRegistry` + `startServer`）做审计，且**先断言枚举到的路由数 ≥20 再断言没有未声明的** —— 少了前一条，一次把枚举写坏的改动会让审计断言**空集通过**；② 覆盖面与 `:param` 原始形态；③~⑦ `auditRouteAccess` 的四种行为（静默/聚合告警/严格拒启/不提供 `routes()` 时静默跳过）。
- **仍需决定（已记录，未擅自改）**：`GET /api/plugins` 与 `GET /api/plugins/graph` 是**管理诊断**端点，目前 public。收紧为 `admin` 看起来合理，但前端在引导期会调 `/api/plugins/{ui,slots}`（必须 public），而这两个的调用点是否会早于登录我没有完全确认 —— 未经确认就改访问等级属于"顺手改语义"，故留作显式决定。
- **验证**：`pnpm run typecheck` exit 0；全量测试 **2002 用例 / 0 失败**（`data/verify/test-f11.log`）。

### F10 插件权限清单（已落地，隔离模式未做）

**问题形态**（§3.1「中」）：插件与宿主同进程、同权限，可任意读写文件系统 / 发网络请求 / 死循环 / OOM。manifest 里**没有任何字段**表达"这个插件要碰什么"。

- **只声明服务模型覆盖不到的"环境面"**：`PluginPermission = fs:read | fs:write | env | net | process | secrets`。数据库/HTTP/LLM 这些由 `requires` 表达**已经够了** —— 把服务依赖也抄进来会让清单失去信息量（"一份什么都包含的清单，评审时等于什么都没说"）。
- **`PLUGIN_PERMISSIONS` 按危险度升序**（`fs:read → env → net → fs:write → process → secrets`），消费方直接按序渲染/打印，于是"这个插件要什么"一眼扫过去就是从轻到重。
- **宿主不做强制，这一点在类型文档里写死**：它是**声明**，价值是①评审（装第三方插件前一眼看到）、②可见（激活时打印 + `GET /api/plugins` 下发）、③可回归（下有守卫）。把它写成"闸门"会给使用者一个错误的保证。
- **非法取值被拒绝并告警**（`readPluginPermissions`）：静默接受任意字符串会让 `fs:raed`、`FS:read`、`filesystem` 都变成清单里"看起来已经声明过"的项，而没有任何消费方能认出它们。与"能力名必须含 `/`"同一类设计：把拼写错误变成可见的。
- **激活时打印，且无声明时一行都不打**：20 个内置插件若每个都打一行"权限:（无）"，真正有声明的那几行会被淹掉。快照路径**不打日志**（管理台轮询会刷屏）。
- **10 个内置插件按核实过的用法声明**（`db-sqlite`/`db-postgres`/`wiki`/`builtin-docs`/`auth`/`oidc`/`llm`/`openai`/`ai-web-search`/`http`）。
- **核心守卫：声明必须与实际用法一致（源码级）**。一个真的 import 了 `node:fs`、读 `process.env`、发起 `fetch(` 的插件，清单里必须声明对应权限 —— **这条让声明随代码演进自动回归**（有人给插件加了文件读写却忘了改清单，会变红）。
  - 扫描必须**排除 `import type` 行**：实测 `plugin-auth` / `plugin-org` / `plugin-ai-assistant` 只用了 `node:http` 的**类型**（`IncomingMessage` / `ServerResponse`），却被"引用了 node:http"误判成发起网络请求。误判的代价是"为了过测试而多声明"，那与漏声明一样是在往清单里灌水。
- **新增守卫（`packages/manager/test/permissions.test.ts`，6 例）**：快照下发（排序/去重/空数组而非 `undefined`）；非法取值与非法形态各告警一次且保留合法项；权限集合封闭有序；**用法 ⇒ 声明**（源码级，含"审计到 ≥8 个包"的非空断言）；`permissions` 不得被当判据用（它不是闸门，别给这个错觉）。
- **明确未做：隔离模式**（报告建议的"worker/子进程隔离供不受信插件选用"）。这是架构级改动（插件与宿主共享 `ctx`、服务、数据库句柄，换执行环境等于换掉整个插件运行模型），不是本轮能诚实交付的；已在此记录为**未做**，而不是含糊带过。
- **验证**：`pnpm run typecheck` exit 0；全量测试 **2008 用例 / 0 失败**（`data/verify/test-f10.log`）。

### F8 Markdown 渲染器注册表（已落地，消除 C2）

**C2 的形态**：Markdown 渲染管线**没有任何扩展点**。`packages/web/src/lib/markdownRender.ts` 只导出固定函数（`decorateAttachmentMedia` / `buildBlockedAttachment` / `renderMarkdownBody` / `codeTextFromButton`），`sanitize.ts` 的 `mdToHtml` 是一条写死的 `marked.parse → DOMPurify` 直线。插件想渲染 ` ```mermaid ` 或自定义块语法，唯一办法是 import `marked` 单例自己 `marked.use(...)`。

- **为什么不能继续用全局 `marked.use()`（本项的技术理由）**：`marked.use()` **只增不减** —— marked 没有 `unuse`。而插件 UI 产物更新后要整页刷新、模块会重新求值，于是**同一扩展被再 push 一次**：tokenizer 被多次调用、renderer 被套娃。这**不报错**，只是"用久了渲染越来越怪"，日志干净。这与插槽/路由/能力面对的是同一个问题，故用同一种解法：**保留自己的注册表，按版本重建一个独立的 `Marked` 实例**，而不是改全局单例 —— 撤销于是是**真的**撤销（重建成原样），而不是"再叠一层抵消"。
- **`markdownExt.ts`（新）**：`MarkdownExtension{name, marked}`、`registerMarkdownExtension(owner, ext)`（返回幂等 undo）、`unregisterMarkdownExtensions(owner)`（按 owner 成组撤销，插件卸载/热更新的统一出口）、`markdownExtensions()`（诊断）、`markdownRegistryVersion()`、`activeMarked()`（按版本缓存实例）、`fenceExtension(lang, render)`（围栏语言的便捷形态）。
- **同名冲突先注册者胜出 + 告警**（与插槽/路由/能力同向），且**被拒的注册不让版本号 +1** —— 否则一个写错名字的插件会让我们每帧重建 `Marked`。
- **`fenceExtension` 用 marked 的 `renderer.code` 覆盖 + 返回 `false` 落回默认**：只有语言匹配时接管，其余代码块行为**一字不变**。这一条很关键 —— 若写成"不是我的语言就返回空"，一个渲染插件会悄悄吃掉整篇文档的所有代码块。语言比对大小写不敏感。
- **`wikilink.ts` 改造成注册表的第一个内置扩展**（原先它直接 `marked.use()`）：导出 `WIKILINK_EXTENSION`，`registerWikilink()` 只是把它写进注册表。这既证明机制可用，也让"内置扩展"与"插件扩展"走**同一条装配路径**。
- **`sanitize.ts`**：`mdToHtml` 改用 `activeMarked().parse(...)`，并新增**显式的副作用导入 `import './wikilink'`**。改造前这一步是隐式的（只有 `markdownRender.ts` 导入了 wikilink），于是"直接调用 `mdToHtml` 而不经过 markdownRender"的路径会**静默地**把 `[[x]]` 原样输出。现在把依赖写在消毒出口，使"消毒出口 = 全部扩展就绪"成为结构性保证。
- **宿主 SDK 暴露**：`registerMarkdownExtension(ext)` / `unregisterMarkdownExtensions(owner)` / `markdownExtensions`（getter，同 `clientTools` 的理由：插件登记发生在 sdk 构造之后）。`HOST_SDK_VERSION` 0.6.0 → **0.7.0**。
- **安全边界（最重要的一条）**：扩展产出的是 **HTML 字符串**，**照旧**经 `sanitize.ts` 的 DOMPurify 收口 —— 注册表**不提供任何绕过消毒的路径**。因此这里**只允许贡献 marked 扩展**，不允许贡献"已渲染好的 HTML/DOM"：后者会同时绕过 DOMPurify 与全部后处理（链接改写、附件标注、标题锚点、复制按钮）。
- **新增守卫 `packages/web/test/markdownExt.test.ts`（9 例）**：撤销是真的撤销（版本号 + 渲染结果双确认）；同名冲突先到先得且**不改版本号**；非法形态被拒并告警；`fenceExtension` **只接管自己的语言**（断言 `js` 围栏仍走 marked 默认渲染且不含自定义标记）；按 owner 成组撤销且**撤销函数后置调用安全**；`activeMarked()` 按版本缓存/重建。
  - 其中 3 例是**安全边界源码级断言**（本仓库 node 测试环境**没有 DOM** —— web 的用例都是纯逻辑，无 jsdom 依赖，所以 DOMPurify 跑不起来）：`markdownExt.ts` 不得引 react/dompurify、不得用 `dangerouslySetInnerHTML`；`DOMPurify` 只能出现在 `sanitize.ts` 一处；`mdToHtml` 必须走 `activeMarked()` 且不得直接 `import marked`。这三条钉的是"某天有人为了方便让扩展直出 HTML"这一最难在评审中发现的退化。
- **验证**：`pnpm run typecheck` 27 项目 exit 0（`grep -c "error TS"` = 0）；全量测试 **1995 用例 / 1995 通过 / 0 失败 / exit 0**（F8 前 1986，+9）；日志 `data/verify/tc-f8.log`、`data/verify/test-f8.log`。
- **仍未做**：真正的渲染插件（如 mermaid/chart）属"新增插件"，接口与守卫已齐；**运行期**消毒验证依赖真机（node 无 DOM），已在报告与本文件中标注为已知边界。

### F9 能力注册表（已落地，消除 B4）

**B4 的形态**：能力的三个键**编译期闭合**，而且真源在**前端包**里。`AuthCapabilities` 在 `plugin-auth/src/index.ts` 与 `web/src/api.ts` 各有一份接口，`web/src/lib/navPlan.ts` 里还有第三份名字数组（`NAV_CAPABILITIES`）；`NavCapability = keyof AuthCapabilities`；`RouteAccess` 只有 `public|user|admin`。后果是插件**无法**让自己的导航项/路由要求一个新能力 —— 键不存在 ⇒ `caps?.[key] === true` 恒假 ⇒ 那个入口**永远不出现、且没有任何日志**。而能力值只能由 `plugin-auth` 按 `orgRole` 推导，插件没有任何地方能贡献"我这类用户算不算有 X 能力"。

- **名字与值拆开，各归其位**：**名字**的单一真源是 `packages/core/src/domain.ts`（内置三个 `BUILTIN_CAPABILITIES` + 插件用 `PLUGIN_CAPABILITY_NAME` 命名空间声明）；**值**的内置部分由 `builtinCapabilitiesOf(principal)`（从 plugin-auth 收上来的**角色语义唯一真源**）给出，插件部分由注册的求解器给出，两者在 `CapabilityService.snapshot()` 里合成一张表。
- **`/` 是命名空间的分界线**（与 F1 插槽同一约定，必须含 `/`）。这一条保住了**拼写错误的可见性**：把内置名拼成 `edtiContent` 既不匹配内置名、也不满足 `a/b` 语法 ⇒ 仍然走告警分支。若改成"任意字符串都算合法能力名"，一次拼写错误就会变成一次**静默放行**。
- **`CapabilitySet = Readonly<Record<string, boolean>>`（开放键）而不是固定三字段接口** —— 接口形式会把刚要打开的扩展点重新钉死。代价是取值可能 `undefined`，但消费方**本来就**必须写 `caps?.[key] === true`（失败关闭），所以这不是新增负担，而是让那条已被遵守的规则成为类型上唯一自然的写法。
- **`RouteAccessOptions.capability` 是第二层闸门**，与 `access` 并存而不合并：`access` 回答"至少是什么身份"（宿主拥有的规则），`capability` 回答"具不具备这个具体能力"（**注册它的插件**拥有的规则）。合并成一个联合会让人以为"写个字符串就行"，而真实语义是"某个插件承诺会算这个值"。
- **能力闸门失败关闭**：探针未接线（`ctx.get` 拿不到服务）时一律 403 `capability_required`。未接线意味着"没人能判定"，此时放行等于把闸门拆掉 —— 而 `capability` 是插件**显式要求**的。顺序上 `access` 的 401 先于能力的 403（"你先登录"必须比"你能力不足"更早说，否则用户永远不知道该去登录）。
- **`snapshot(undefined)` 刻意不调用任何求解器**：`Principal` 的设计原则是"没有空主体，只有 `kind:'anonymous'`"。把 `undefined` 透传给插件求解器，等于要求每个作者处理一个**设计上不存在**的输入 —— 而漏处理时的默认分支常写成"不是已知用户就 true"，那是一次越权。边界收在宿主侧，直接判否（真正的匿名主体是合法 `Principal`，会正常走求解器路径）。
- **求解器抛错 ⇒ 该能力为 `false`**（逐个 try/catch）。若 `catch` 后判 `true`，一次插件异常就变成一次越权且毫无症状；若让快照整体失败，则"某个插件的能力算不出来"会升级成"所有人都拿不到能力表"，前端藏起全部入口。
- **新失效形态已配可见性**：F9 引入了"**声明了却没有注册求解器**"（能力恒 `false`）。判据 `unresolvedCapabilities(declared, registered)` 与插槽的 `undeclared` 同构，经 `GET /api/plugins/slots` 的 `unresolvedCapabilities` 字段暴露。

#### F9 过程中踩到的真实设计缺陷（重要，勿重蹈）

**第一版把 `ctx.provide('capability-service', …)` 写在管理器自己的 `apply` 里 —— 错的。** 这与仓库早已记录并修正过的 slot 问题**同源**：在一个插件 `apply` 尚未结算时 `provide` 的服务，对它在此期间创建的子插件**不可见**；而 `boot()` 正是在管理器的 `apply` 内部激活各插件。

实测症状与 slot 那次一模一样：测试插件在自己的 `apply` 里 `ctx.get('capability-service')` 拿到 **`undefined`**，它的能力注册被**静默跳过** —— 表现是一道**永远 403 的闸门**和一份**干净得可疑的日志**（没有任何报错能把它与"这个插件本来就没注册"区分开）。

修法与 `slot-plugin.ts` / `db-sqlite` / `http` 完全一致：新增 `packages/manager/src/capability-plugin.ts`（`{ name: '@geewiki/capability', apply }`，`provide` + 卸载时 `unprovide`），并在组合根 `packages/server/src/index.ts` 里 **`await app.plugin(capabilityPlugin)` 排在 `PluginManagerPlugin` 之前**。管理器改为"优先用兄弟插件暴露的那一份（`ctx.get(CAPABILITY_SERVICE_NAME)`），拿不到则自建兜底"——与 `slots` 的写法逐字同构。

> **可复用的判据**：只要一个服务需要在**插件 apply 期**被 `ctx.get` 到（而不是仅在请求热路径上），它就必须由**排在管理器之前的独立兄弟插件**提供。`credentialSourceProbe` / `capabilityProbe` 这类**逐请求** `ctx.get` 不受此限 —— 这正是它们能直接写在 `server` 里的原因。

- **新增守卫（17 + 2 例）**：
  - `packages/manager/test/capabilities.test.ts`（11 例）：内置名与不含 `/` 的名字被拒绝；同名最早激活者胜出并进 `conflicts`；**求解器抛错判否**；**`undefined` 主体不调用求解器**（断言调用次数为 0）；同名先到先得 + `release` 按 owner 成组撤销；`unresolvedCapabilities` 能报出"声明了但没求解器"。
  - `packages/web/test/navPlan.test.ts`（+2 例）：插件命名空间的能力键被接受；**放宽键空间没有牺牲拼写错误的可见性**（`adminster` / `reviewapprove` 仍被丢弃）。
  - `packages/core/test/slots-browser-safe.test.ts`（+4 例）：`src/domain.ts` 的浏览器安全（零 `node:*`/cordis/schemastery、不得 import `./index.js`）；`domain.ts` 必须导出能力名真源；**web 与 plugin-auth 不得再本地定义 `AuthCapabilities`**。
  - `packages/server/test/route-auth.test.ts`（+2 例，走**真实注册路径**）：具备能力放行 / 不具备 403 `capability_required` **且处理器未执行**；`access` 与 `capability` 两层，匿名的 401 先于能力的 403。
- **验证**：`pnpm run typecheck` 27 项目 exit 0（`grep -c "error TS"` = 0）；全量测试 **1986 用例 / 1986 通过 / 0 失败 / exit 0**（F9 前 1967，+19）；日志 `data/verify/tc-f9.log`、`data/verify/test-f9-final.log`。
- **仍未做**：能力无 UI 侧管理界面（`declarations()` 已备好数据，端点字段已暴露）；真实的插件用能力闸门保护自己的 API（属"新增插件"，接口与守卫已齐）。

### 优化点 1：插槽镜像膨胀 → 单一真源（已落地）



**§6 阶段一第 4 条曾写"必须先治"** —— 因为 F1/F2 会继续往镜像上加东西（F5 补 `EditorSlotProps` 就要再动一次）。现在治完了。

- **根因不是"手滑"，是结构**：`packages/web` 完全不依赖 `@geewiki/core`，因为 `core/src/index.ts` 顶层 `import 'node:fs'/'node:path'/'node:url'`，进不了浏览器 bundle。于是"同一份白名单"只能靠手抄 + 源码级正则守卫钉住。
- **镜像实数：4 处**（§4 当时记的是 2 处）——`core/src/index.ts` 的白名单、`web/src/lib/slots.tsx` 的两份（`SlotName` 联合 + `SLOT_NAMES` 数组）、`web/src/lib/pluginUiPlan.ts` 的第三份，外加 `slots.tsx` 的 `SINGLE_OCCUPANCY_SLOTS`（重复了 core 的**基数**事实）。守卫 2 处（`manager/test/slots.test.ts`、`web/test/slotPropsMirror.test.ts`）。
- **治法**：新增 `packages/core/src/slots.ts` —— 一份**零依赖**（无 `node:*`/cordis/schemastery）的纯常量模块，装 `BuiltinSlotName` / `SlotName` / `PLUGIN_SLOT_NAME` / `SLOT_NAMES` / `SLOT_CARDINALITY` / `SlotDeclaration` / `isBuiltinSlotName` / `isPluginSlotName` / `slotCardinalityOf`。`core/src/index.ts` 改为 `export * from './slots.js'` + `import type { SlotDeclaration, SlotName }`（`export *` 只转出、**不会**把名字带进本文件作用域，故这两个必须另引）。
- `packages/core/package.json` 新增 `"./slots": "./src/slots.ts"`；`packages/web` 新增依赖 `"@geewiki/core": "workspace:*"`；web 两个文件改为 `import ... from '@geewiki/core/slots'` 后**转出**，本地定义全删。
- **`SINGLE_OCCUPANCY_SLOTS` 从字面量改为现算**：`SLOT_NAMES.filter((n) => SLOT_CARDINALITY[n] === 'single')` —— 漂移从"要靠测试发现"变成"构造上不可能"。
- **守卫判据升级**：从"两侧**内容**相等"改为"**引用同一性**"（`web.SLOT_NAMES === core.SLOT_NAMES`）。同一性严格更强 —— 副本**无法伪装成同一个对象**；而"内容相等"在有人刚抄完一份时是**通过**的，只在漂移发生后才红（那时线上已经出过事故）。`slots.tsx` 求值期需要 `window`、node 下 import 不了，故对它只做源码级"不得本地定义白名单"断言。
- 新增 `packages/core/test/slots-browser-safe.test.ts`（5 例）钉住两条**永远**不能破的约束：`slots.ts` 不得引入 `node:*`/cordis/schemastery，且不得 import 本包 `index.ts`（那会把 `node:fs` 拖回来）。这两条**运行期测不出**（Node 下两边都能跑），只能源码级断言。
- **判据设计踩过两个坑，记下来免得下次再踩**：①「数组里出现内置插槽名」会误伤 `pluginUiPlan.ts` 的 `ON_DEMAND_SLOTS`（那是 web **自己的子集选择**，合法列出 editor/app-dock）；②「不得出现 `'app-header'` 字面量」会误伤 `slots.tsx` 的 `ZeroPropsSlotName`（web **自己的窄化**）。最终判据是「不得本地 `export` **定义**」——`export { X } from …` 转出不含 `=`，不会被误伤。
- manager 侧的 `PENDING_WEB_SYNC` 记账清单**删除**：它存在的理由是"core 先加、web 后跟"这个中间状态，而单一真源让该状态在构造上不存在。这是断言强度**升高**后的删除，不是放宽。
- **副产物 1**：`@geewiki/core/slots` 确立了「契约放 core 的浏览器安全子路径」这条模式 —— 正是 §5 的 **F3（契约下沉）** 需要的落点，`core/src/sse.ts` 已有同形状的先例（它只因 `import type { ServerResponse } from 'node:http'` 而未开子路径）。
- **副产物 2（实测，直接改变 F3 的成本估计）**：**类型导入会被完全擦除**，所以 web 侧根本不需要"镜像"这套机器 —— `import type { EditorSlotProps } from '@geewiki/core/slots'` 是零运行期耦合的。据此 F3 **不需要**新建 `@geewiki/contracts` 包（原方案），把契约**搬进 core 的浏览器安全模块**即可。
  - 但**不能**从 core 的**根** `@geewiki/core` 取类型：实测 `tsc` 会把 `index.ts` 整条类型链拉进来，随即在 web 的 tsconfig（DOM lib）下炸：
    `../core/src/cordis-env.ts(38,13): error TS2451: Cannot redeclare block-scoped variable 'Context'.`
    根因是 cordis 的全局 `Context` 与 DOM lib 的 `Context` 撞名。
  - 于是约束收紧为：**共享契约类型必须住在"零 cordis / 零 node 依赖"的模块里**（`slots.ts` 已经满足，其守卫 `slots-browser-safe.test.ts` 正是钉这条的）。F3 的执行方式因此从"新建包"变为"**搬家到已有的浏览器安全模块**"，成本显著低于原估。
  - 这一步尚未执行（web 侧 `EditorSlotProps` 等 props 仍是手抄镜像，由 `packages/web/test/editorSlotProps.test.ts` 守卫），但路径已实测可行。

---

### F14 `apply()` 超时保护（已落地；审计 §3.2 唯一无缓解措施的可靠性项）

**要防的失效**：`apply()` 是插件自己的代码。一个死循环、或一个永不 settle 的 `await`，会让 `ctx.plugin()` **永远不返回**——而激活跑在**进程启动路径**上，故障形态因此是「进程既没起来、也没报错、也不退出」，日志停在上一个插件。这是最难远程诊断的一类故障：**没有任何错误可以看**。

- **声明**：`GeeWikiRuntime.applyTimeout?: number`（**秒**，缺省 30，`<= 0` = 不超时）。与 `drainTimeout` 方向不同：后者约束**卸载**（等在途请求结算），本项约束**加载**（等 apply 结算）。缺省值由 `DEFAULT_APPLY_TIMEOUT_SECONDS` 给出（`packages/core/src/index.ts`），并进入 `normalizeRuntime()`。
- **为什么 30 秒是「刻意宽松」**：正常的 `apply` 只做「注册服务 + 挂路由」，量级是毫秒；迁移另有独立路径（`geewiki.migrations`，在 apply **之前**执行，**不受本超时约束**）。所以只有真正卡死的插件才会撞上它——把缺省值调小只会误伤冷启动抖动。
- **超时后的处置分两步，缺一不可**（`packages/manager/src/index.ts` 的 `loadPluginModule()`）：
  1. 立刻抛 `ManagerError('load_timeout')`，与 `load_failed` 走**同一条单点回滚路径**；
  2. **接住那个已经没人等的 promise**：若它最终成功了，主动 `dispose()` 掉那个 fiber。
     不做第 2 步会得到**比超时更糟**的东西——一个**幽灵插件**：管理器认为它没激活，它却已经把服务/路由/插槽装进了容器，且**再无句柄可回收**。晚到的 promise 若**失败**则吞掉（原始错误已由超时错误代表，再抛会变成无人认领的 `unhandledRejection`）。
- **定时器刻意不 `unref()`**：本仓库刚在 F12 踩过——`unref()` 后空闲场景下事件循环直接结束，`Promise.race` 永不 settle，超时**反而永不触发**。正确做法是在正常路径上显式 `clearTimeout`（`finally`）。
- **一处顺带修掉的既有缺陷**：`activateCore` 的 `catch` 原先把**所有**错误一律包成 `load_failed`。超时会被它抹掉 code，REST 层只能按 400 回，运维看不到"是超时"。现已改为「已是 `ManagerError` 则原样上抛」。
- **REST 映射**：`load_timeout` → **504**（服务端等待插件结算超时，不是客户端请求有问题）；其余未列出的 code 仍是 400。
- **守卫**：`packages/manager/test/apply-timeout.test.ts`（8 例）——缺省值/逃生口互不干扰、正常插件不受影响、卡死有限返回且记为 `error`、慢插件在 `applyTimeout:0` 下照常完成、同一慢插件给小超时被判超时（对照组）、**晚到成功的 fiber 被 dispose**、**晚到失败的 promise 不产生 unhandledRejection**、热启用路径抛出带 `code` 的 `ManagerError`。

### 优化点 7 `db-sqlite` 补单测（已落地）

**要防的失效**：`db-sqlite` 是**默认后端**（`config/plugins.base.json` 里人人都在用），却曾是唯一**没有 `test` 脚本**的运行时关键包；而**延期**的 `db-postgres` 反而有 400 行测试。**覆盖分布与风险分布刚好相反**——出问题时影响面最大的那个组件，是没人替它检查的那个。

- 新增 `packages/db-sqlite/test/sqlite.test.ts`（9 例）+ `test` 脚本 + `tsconfig.json` 的 `include` 补 `test`（与 `db-postgres` 对齐；补之前测试**不会被 typecheck**）。
- 钉住的四类不变量：① 迁移**真跑**（`appliedMigrations()` 与**动态读取**的随包 `.sql` 文件数比对——新增迁移不会让断言失效，只会让它**有意义**）；② **迁移登记与迁移本身同事务**（失败迁移既不留表、也不留登记行，否则下次启动跳过它，得到一个**永远缺一张表**且无任何报错的库）；③ 未 `open()` / 已 `close()` 一律**明确报错**而非静默空结果（静默空数组会被上层当成"这张表是空的"，走进完全错误的业务分支），而 `appliedMigrations()`/`listTables()` 这类**清单查询刻意降级为空**（供健康检查在未就绪时调用）；④ `apply()` 失败**不留半注册的 `db` 服务**。

### 优化点 8 插槽 props 的自助描述（已落地）

**要防的失效**：外部插件是**裸 JS**（`plugins/hello-geewiki/index.ts` 的模板风格里 TS 类型"只作注释"），作者手上没有 `EditorSlotProps` 这类类型可查，"我这个插槽会收到什么属性"只能靠读宿主源码。

- `SLOT_PROPS_SCHEMA`（`packages/core/src/slots.ts`，**浏览器安全**，与白名单/基数同一处）覆盖全部 7 个内置插槽；经 `GET /api/plugins/slots` 的 **`props`** 字段下发。
- **刻意不是 JSON Schema**：这些 props 里有**回调**（`onSave`/`onUploadFiles`/`openPage`…），JSON Schema 根本表达不了函数类型。硬套一层只会得到"看起来标准、实际缺一半"的契约——比一份诚实的自定义描述更坏。精确类型由每一项自带的 **`contract`** 锚点（接口名 + 文件）给出，**冲突时以接口为准**。
- **一致性不靠纪律，靠判据**：`packages/core/test/slot-props-schema.test.ts`（6 例）按 `contract` 去源码解析接口，比对**顶层字段名 + 可选性**，**双向**——接口加了字段而 schema 没跟 ⇒ 红；schema 写了接口里没有的 ⇒ 红（下发一份**不存在**的契约比缺字段更坏：作者会照着写，然后运行时收到 `undefined`）。
  - 解析必须**按花括号深度切分**而不是按行：`blockTiers?: { … } | null` 这类跨行嵌套类型会让按行解析把内层字段误当顶层（既有 `slotPropsMirror.test.ts` 用的就是按行近似，故它对 `app-dock` 的嵌套 `page` 会多报 `slug`/`kind`——这里**没有**沿用那个近似）。
- **如实记录一处既有不对称**：`account-identities` 是唯一"**前端包才是真源**"的带 props 插槽（`AccountIdentitiesSlotProps` 在 `packages/web/src/lib/slots.tsx`），其 `contract.file` 因此指向 web 而非 core；有独立测试钉住这一点，将来它若搬进 core，那条测试会红并提示**同时改锚点**，而不是删测试。

### 优化点 2 清理矛盾注释（已落地）

- `packages/manager/src/slots.ts` 文件头原先写着「为什么放在 manager 而不是单独一个插件……另起一个插件反而要……多出一个谁先谁后的启动顺序问题」——**这句话站在已被推翻的立场上**，与 `manager/src/slot-plugin.ts` 文件头（记着实测证据：提供者**必须**是排在管理器之前的独立插件）直接冲突。
- 已改为只回答「**注册表实现**放哪」（放 manager，因为归属与回收挂在插件生命周期上），并显式说明它**不**回答「服务提供者放哪」，且把「顺序问题」从"反对理由"改写为"**必须正面解决的真实约束**"。
- `docs/roadmap.md:67` 那条 ⚠️（称 core 仍写「由管理器提供而不是单独一个插件」）**已过时**——core 的 `SlotService` 注释早已改为「归属曾经写错过，别再改回去」并指向 `slot-plugin.ts`。已改为「已清理」并注明所引旧行号已失效。
- 说明为什么这类清理值得做：审计 §3.1 的该条风险不在于"注释不好看"，而在于**后来者会照错误注释改回去**——core 注释里那句「已经踩过一次」正说明这条路径已经走通过一次。

---

### F16 主题 / 品牌插件化（已落地，消除 C3 的一半）

**要防的失效**：插件能改的是**界面组件**，却改不了**整站观感** —— 想做品牌/换配色只能改宿主的 `tokens.css`。这与「万物插件」的定位不符：配色是插件平台里最典型的可替换能力之一。

- **`packages/web/src/lib/pluginTheme.ts`**（新文件，**不覆盖既有的 `theme.ts`** —— 后者管的是**用户偏好** `system/light/dark`，两者正交）：`registerTheme(owner, contribution)` / `unregisterThemes(owner)` / `themeContributors()` / `themeTokens()`，产物由**纯函数** `buildThemeCss()` 生成，DOM 注入是唯一副作用且**在无 DOM 环境下静默跳过**（本仓库 node 测试不引 jsdom）。
- **只放行 `--gw-*`（原始 palette），拒绝语义 token `--color-*`**。理由来自 `tokens.css` 的两段式设计：语义 token **只指向** `--gw-*`，改原始值能让语义 token、工具类、深浅两套主题**全部自动跟随**；改 `--color-*` 则同时绕过两段式并可能改坏布局类 token。
- **★ 本项最容易做错的地方是层叠顺序，已专门处理**：`:root` 与 `.dark` 的**特异性相同**（都是 (0,1,0)），而插件样式表**后注入** ⇒ 天真的 `:root{…}` 写法会把内置的深色值盖掉，症状是「深色模式下主题突然变浅」，**且只在配了主题的部署里出现**。故生成的四段**镜像内置结构**：`:root.light` / `:root.dark` 各一段，外加两个带 `:not(.light):not(.dark)` 的 `@media (prefers-color-scheme: …)` 段（与 `theme.ts` 的 `system` 模式约定对应）。单测里有两条专门钉「只给 light 不得生成任何深色段」及其反向。
- **冲突裁决：按当前贡献者集合、注册顺序在前者胜**（与 `markdownExt` 的先到先得、插槽的最早激活者胜出同一取向 —— 插件激活顺序不由用户控制，"后到者胜"会让配色随加载时序漂移）。**但裁决是每次求值现算的**：撤销先注册者后，仍加载着的后来者**会接管**该 token。这一点**与 `markdownExt` 刻意不同**（后者在注册时就拒绝了重名）；选这个方向的理由：A 卸载后它设的品牌色本就该消失，而 B 当初明确要过这个颜色，此时让 B 生效才符合直觉；永久判死会让 B 在"A 已卸载"下依然不生效且无从补救。
  - ⚠️ **一个我自己写错又改回来的地方**：文件头初稿声称"被挡下的后来者不会接管"，而代码实际行为是**会**接管（裁决现算）。测试当场抓到了这个不一致 —— 已按**实际正确的语义**改文档并补一条专门的用例，而不是改代码去迁就文档。
- **注入面 = CSS 注入面**：token 值是被拼进样式表的，一个 `;` 就能闭合声明并追加任意规则。`isSafeTokenValue()` 拒绝 `; { } < > \` `/*` `*/` `url(` `expression(` 与换行/制表符，长度上限 200（`\` 单独列出是因为 CSS 转义能拼出 `;`，如 `\3b`）。单测从「危险值被拒」与「产物里不含危险字符 + 花括号配平」两个方向夹住。
- **宿主 SDK**：`registerTheme` / `unregisterThemes` / `themeContributors`（后者是 **getter** —— `sdk` 是模块加载期构造的单例，快照会让插件永远读到空数组且不报错，与 `clientTools`/`markdownExtensions` 同一裁决）；`HOST_SDK_VERSION` **0.7.0 → 0.8.0**。既有守卫 `hostSdkSurface.test.ts` 已同步扩展（版本演进说明必须保留 0.7.0/0.8.0，且 `registerTheme` 与 `themeContributors` 必须成对存在、后者必须是 getter）。
- **守卫**：`packages/web/test/pluginTheme.test.ts`（12 例）——深浅不互相泄漏（含 `:not(.light):not(.dark)` 的结构性断言）、只放行 `--gw-*`、危险值被拒且产物零危险字符、合法值不误伤（`rgb()/hsl()/oklch()/var()/calc()`）、先注册者胜且冲突可见、撤销后的接管语义、撤销幂等、`unregisterThemes` 清全部、形态非法整条拒绝、无 DOM 下不抛错、注入 id 固定。
- **明确未做**：管理台的"主题编辑器"界面；把主题也做成**清单声明**（那样纯品牌插件无需执行 JS 即可生效，是目前更弱的一环 —— 现在必须由插件客户端 bundle 调 `registerTheme`）。

### F18 向量 / 语义检索的提供方契约（接口已落地；查询路径接线仍后置）

**要防的失效**：`roadmap` 的 **L-17 把语义检索有意后置**，而"后置"最容易悄悄变成"没有" —— 一旦检索侧硬编码某个具体实现，后来者就只能去改它。

- **`packages/core/src/services.ts`** 新增：`EMBEDDING_SERVICE_NAME`、`EmbeddingProvider`（`ready()` / `dim` / `model` / `embed(texts)`）、`EmbeddingResult`、`EmbeddingServiceError`（4 个 code：`provider_unavailable`→503、`invalid_input`→400、`rate_limited`→503、`provider_malformed`→502）、**`assertEmbeddingResult()`** 校验器、**`probeEmbeddingProvider()`** 探针。
- **刻意只定接口、不带实现**（与报告的建议一致）：宿主因此不必背 `onnxruntime` / `transformers.js` 这类重依赖（与「仅 SQLite 即可跑」的极致轻量目标直接冲突），也不绑死任何供应商。
- **三条写进契约文档的消费纪律**：① **逐请求 `ctx.get()`，不缓存快照** —— 服务在提供者 `apply` 结算前对子插件不可见（`ctx.get` 返回 `undefined` 且**静默**），缓存会把"提供者晚到"永久固化成"永远没有语义能力"（与 F9 踩过的是同一个陷阱）；② **`dim` 必须随向量持久化** —— 换 provider 就换维度，只存向量不存维度要到算相似度时才发现对不上，而那时数据早已写入；③ **没有提供者不是错误，是"能力不存在"** —— 必须走显式路径（拒绝该 mode / 隐藏入口），**不要**退化成字面检索后假装成功。
- **为什么是批量 `embed(texts)`**：远程 embedding 的主要成本是**往返延迟**而非算力；单文本接口会把 N 段文档变成 N 次往返，且提供方**无法**在内部合并（看不到尚未发生的调用）。
- **`assertEmbeddingResult()` 为什么值得存在**：这是整条链路里**最不能出错**的一环，因为提供方返回的向量会直接进索引，而**写入那一刻不会报任何错**。`NaN` 一旦混进去，之后每次相似度计算都是 `NaN`，排序还会安静地退化成"原序"（JS 里 `NaN` 参与的比较恒为 false，`sort` 于是保持原样，看起来像"结果没被改动"）——**没有错误、没有日志、结果只是"看起来有点怪"**。校验器把数量不符/维度不齐/含非有限数三种偏差变成带坐标的可读错误。
- **`probeEmbeddingProvider()` 为什么不抛错，以及为什么参数是"传值"而不是"传 ctx"**：每个消费方都要重复这四步而其中三步**默认写法都是错的**（服务没注册时天真写法直接 TypeError 把"没配语义能力"变成 500；形态不对运行期才暴露；`ready()` 抛错会因一次网络抖动让检索端点 500 并计进看门狗连续失败）。参数设计成"直接传当次 `ctx.get(...)` 的结果"而非 `ctx`，是为了让"**逐请求取**"这件事在调用点**显式可见**。探针**不做超时**：超时时长属于消费方的请求预算（检索端点与后台索引任务的预算不同），需要时由消费方 `Promise.race`。
- **守卫**：`packages/core/test/embedding-contract.test.ts`（14 例）——含"`NaN`/`Infinity`/字符串数字一律拒"、"空批量必须显式给正整数 `dim`"、"声明 `dim` 与实际不符即拒"、"探针接住 `ready()` 抛错并带出原始错误"、"探针在无提供者这种**正常状态**下返回 `available:false` 而非抛错"。
- **明确未做（本轮边界）**：**查询路径的接线**。要把 `mode: 'semantic'` 真正接进检索，先得定「向量存哪（SQLite 无向量类型，需 BLOB + 手算余弦还是扩展）」「维度变更怎么办（重嵌入全量 vs 记 model 版本并存多套）」——**这两个决策与 L-17 是同一个**，不该由接口工作顺手拍定。故本轮交付的是"能力边界 + 可发现性"，而非"语义检索可用了"。

---

### F21 外部插件脚手架（已落地）

**要防的失效**：在此之前"写一个外部插件"的入口是**照抄 `plugins/hello-geewiki/`**。抄一份的代价不只是麻烦——清单里每个字段（`entry`/`provides`/`requires`/`runtime`/`client`/`slots`）都有各自的约定，抄漏一个的表现是**插件静默不工作**（前端产物不加载、插槽是空的、热插拔被拒），而**没有任何报错**指向"清单少了一行"。

- **`packages/manager/src/scaffold.ts`**：`scaffoldFiles(spec)` 是**纯函数**（生成内容、不碰文件系统，故可脱离 IO 单测），`writeScaffold(root, spec)` 负责写盘且**拒绝覆盖已存在且非空的目录**——脚手架跑在"我以为这里是空的"上是最危险的操作（作者的半成品会被静默盖掉）。
- **CLI**：`pnpm run new:plugin <名字> [--ui] [--no-hot] [--display …] [--desc …] [--dir …] [--dry-run]`（`scripts/create-plugin.ts`，只做参数解析与打印，业务逻辑全在受测的库里）。名字走**严格白名单**（`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`）而非"过滤危险字符"——它会进 URL、进静态层路径解析、进包名，后者总会漏。
- **生成物是"手写零构建"的**：外部插件不是 workspace 包、不能有自己的依赖（见 `plugins/hello-geewiki/README.md`），故模板**不引入任何构建工具链**；`--ui` 生成的手写 `dist/client.js` 直接用 `window.__GEEWIKI_HOST__` 与 `host.React.createElement`（不引 JSX 编译）。作者要上框架时再自行接 vite —— 那是"这个插件自己的工程决定"，不该由模板替他定。
- **默认不声明 `permissions`**：本模板零 Node 内置依赖（只用 `ctx` 提供的服务），而 `permissions` 的语义是"我要碰哪些跨界能力"（F10）。用不到却写上，会让评审看到一份**不诚实**的清单——那正是 F10 想消灭的东西。README 里写清了什么时候该补。

#### ★ 生成器踩到的一个真实坑（值得留档）

模板的说明文字里要写出那条 `.gitignore` 通配例外，而那段字面量里含有**块注释的结束序列**（`plugins` 后的星号紧跟斜杠）。它把 `/** … */` **提前闭合**了，于是后面那些"看起来是注释"的文本**变成了代码**，运行时抛 `ReferenceError: dist is not defined`。

**这正是"scripts/ 从未被类型检查"的直接后果**——tsc 会当场报出来，而 `tsx` 只在执行到那一行时才炸。修法是把那段字面量从注释里拿掉（改述），并把 `scripts/` 纳入类型检查（见下）。生成器自己的注释把生成器弄坏，是这一项第一次跑起来时**真实发生**的事。

#### 生成物落 `dist/` 带来的连带问题（已显式处理）

外部插件的 UI 根被**硬编码**为 `<插件目录>/dist`（`plugin-ui.ts` 的 `resolvePluginUiRoots` ①），而仓库 `.gitignore` 有全局 `dist/` ⇒ **手写的零构建前端产物提交不进去**。这不是理论风险：作者会看到文件在磁盘上、界面也正常，直到一次干净检出才发现界面消失。

- 故另有 `gitignoreLinesFor(name)` 产出**逐插件**两行例外（`!plugins/<name>/dist/` 与内容行），CLI 生成 UI 时会**显式提示**要加它们；
- 为什么不能是一条覆盖全部插件的通配：`plugins/ui-demo/dist` 与 `plugins/hello-geewiki/dist` 是**真正的构建产物**、刻意不入库，通配会把它们一并纳入，等于把"生成物不入库"这条约定悄悄废掉；
- 单测里有一条**前提断言**：钉住"全局 `dist/` 忽略仍在、且仓库里不存在通配例外"。若将来 UI 根改成可声明，那条用例会红并提示这里可以简化 —— 挂了钩子而不是留一句 TODO。

#### 守卫方式：把生成物送回**真实管线**

不做"模板文本快照"（那种测试只会在改模板时碍事），而是：
- 清单交给真的 `parsePluginManifest()` 解析（不是 `JSON.parse` 后自己看字段）；
- 目录交给真的 `loadExternalPlugins()` 扫描、并对生成的 `index.ts` 做**真的 `import()`**，断言零 issue 且模块有 `apply`；
- `--ui` 变体额外断言 `client.entry`/`css` **文件真实存在**，且清单 `slots` 与 `client.js` 里实际 `registerSlot(...)` 的名字**集合完全一致**（两种不一致都不报错：声明了不注册 ⇒ 插槽永远空着；注册了没声明 ⇒ 按需加载的判定看不到它）；
- 后端入口**剥离注释后**断言零 `import`/`require`/`@geewiki/` —— 剥注释是必须的，因为模板的说明文字里就有"不 import 任何包（包括 `@geewiki/core`）"这句话本身（不剥注释的粗暴断言会误报，而**误报的守卫会被下一次改动顺手删掉，比没有守卫更糟**）。

### 优化点 6 `tmp/` 清理（已落地）

`undefined/` 早在首轮已删；本轮补的是"给 `tmp/` 加清理脚本"。实测 `tmp/` **1.9 GB / 147 项**（多是各批次验证留下的 Chrome profile）。

- **`packages/manager/src/maintenance.ts`**：`planCleanup()` 是**纯判据**（哪些条目该删），IO 外壳（读目录 / 真删）分开——与 `watchdog.ts` 的"纯决策 + IO 外壳"同构。CLI：`pnpm run clean:tmp [--yes] [--all] [--older-than N]`。
- **四道安全闸门**：① **默认 dry-run**（需 `--yes` 才动手）；② **`tmp` 必须是仓库内的真实目录**——若它被换成指向仓库外的符号链接，`readdir + rmSync` 就会删到仓库外，而这一切在删除**之前**不会有任何报错。判据用 `relative()` 后的包含关系而非 `startsWith`（`/repo-evil` 会通过 `startsWith('/repo')`），两侧都先 `realpathSync`；③ **太新的条目默认保留**（验证脚本常常正在往 `tmp/` 里写东西，"上来就全删"的症状是几十分钟后才出现的诡异失败）；④ **只删 `tmp/` 的条目，不删 `tmp/` 自己**。
- **"不碰 `data/`"靠接口没有这个口子保证**，不是靠自觉：本模块根本不接受这些路径参数。另外 `tmp/` 与 `data/` 只差一个字而后者是真实数据，故 CLI 输出里**显式写出**"明确不碰：data/、config/、.pnpm-store/、.npm-cache/"——让执行者在按下 `--yes` 之前就能确认自己删的是哪一个。
- 测试 11 例，重点在闸门而非"能不能删"：**符号链接逃逸必须被拒**、**受害者文件必须原样存在**、目录名不是 `tmp` 时拒绝（本模块不是通用删除工具）、只删计划内条目、`formatBytes` 不吐 `NaN`。

### `scripts/` 此前从未被类型检查（本轮发现并修复）

- 新增 `tsconfig.scripts.json` 并接进根 `typecheck`（`pnpm -r … && tsc --noEmit -p tsconfig.scripts.json`）。
- **首次检查即暴露 16 处既有错误**：主要是 `scripts/acceptance/**` 的一次性验证 runner（`p1-tools` / `p4-undo` / `p6-summary` / `plugin-runtime-disable`），以及一处 web 源码在 NodeNext 下的相对导入扩展名问题。
- **`scripts/acceptance` 被有意、有期限地排除**，并在配置文件里写明原因与收口方法。理由：它们是各批次的临时 runner、不在产品路径上、也不参与 `pnpm test`；把它们一并整改属于**另一个独立决定**（修好，还是按批次归档删除），不该由本轮顺手拍定。
- 为什么这条值得做：F21 CLI 那个"注释提前闭合"的 bug，`tsc` **会当场报出来**，而 `tsx` 只在执行到那一行时才炸——**新增覆盖本身就是最便宜的收益**。

### F20 备份 / 恢复（已落地）

交付：`packages/manager/src/backup.ts`（库）· `pnpm run backup` · `pnpm run restore` · `POST|GET /api/backup`（`admin`）· 14 例守卫。

#### 为什么"把目录拷一份"是错的

默认后端是 SQLite 且开着 **WAL**。运行中的库由「主文件 + `-wal` + `-shm`」三者共同构成，朴素拷贝有两种坏结果：
1. **撕裂快照**——`cp` 期间还有提交在写，主文件与 WAL 不是同一时点，恢复出来是**没人见过**的状态；
2. **陈旧边车**——即便主文件拷对了，把旧的 `-wal` 一起带过去，SQLite 下次打开会**重放不属于该快照的帧**。

故数据库走 **`VACUUM INTO`**（SQLite ≥ 3.27）：由引擎自己保证一致性、对运行中的库安全、产物**自包含不带边车**。实测取证：源目录有 `s.db`/`s.db-wal`/`s.db-shm`，快照只有一个 `snap.db`；冒烟测试里恢复出的库能正常 `select` 出原表与原行。

#### 快照能力是**注入**的 —— 因此不需要任何新依赖

`better-sqlite3` 在 pnpm 严格隔离下**只从 `packages/db-sqlite` 可解析**（根目录 `require.resolve` 是 MODULE_NOT_FOUND）。两种做法被否掉：往根 `devDependencies` 再加一个原生模块（要多一次安装）；拼 `.pnpm/better-sqlite3@x.y.z/…` 的真实路径（依赖安装布局的内部细节）。最终：

- **服务端**（`Manager.createBackup`）：管理器**已经**握着 `db` 服务，`db.run('VACUUM INTO ?', [dest])` 实测可用（带绑定参数）——接线在服务端而非库内，故管理器不 import 任何驱动。
- **CLI**（`scripts/backup.ts`）：`createRequire(<packages/db-sqlite/package.json>)` 把**解析基准**换成那个包，拿到的正是它已声明并安装的那一份驱动。既不新增依赖，也不碰 `.pnpm` 内部路径。
- 驱动缺失时**明确报错并拒绝退化成"直接拷 .db"**——那正是本项存在的理由。

#### ★ 冒烟测试抓到的两个真 bug（都已修，且都是"看起来成功"那类）

1. **`record()` 把清单键算成了"相对仓库根"而不是"相对备份目录"**：备份目录缺省就在仓库里（`<仓库根>/backups/`），于是键被写成 `backups/geewiki-backup-…/data/geewiki.db`，恢复端再也找不到 `data/geewiki.db`。**5 条用例同时红**才把它逼出来。
2. **CLI 只把 `GEEWIKI_DATA_DIR` 用于定位库，却仍然扫整个 `<仓库根>/data`**：第一次冒烟备份了 **5566 个文件 / 352 MB**（真实的 `data/` 里躺着 308 MB 历史验证残留），而"库"来自那个小测试目录——一个自相矛盾的备份，却报告成功。修法是让数据/配置目录**可注入**，并进一步把清单键改成**逻辑路径**（见下）。

#### 清单键是**逻辑**路径 —— 备份因此可以在布局不同的机器上恢复

物理落点可配置（`GEEWIKI_DATA_DIR`），但清单不该跟着变形：键固定用 `data/…`、`config/…`，恢复端再按自己的配置展开回物理位置。于是「在一台机器上备份、在另一台布局不同的机器上恢复」才是可能的。**这条有专门的用例**：源仓库数据在 `<root>/store/`，目标仓库数据在 `<other>/data/`，往返一次内容一致，且清单里不出现 `store/`。

#### 另外三条刻意的判据

- **`data/` 的排除规则**：`*.db`（由快照替代）、`*.db-wal`/`-shm`/`-journal`、`*.tmp`（附件是"先写 tmp 再 rename"，拷到写了一半的 `att-*.tmp` 会表现为"某个附件打不开"）。
- **清单最后才写**：中途失败留下的是**没有清单**的半成品目录，而 `readBackupManifest` 会明确拒绝它。"半成品看起来像完整备份"比"备份失败"严重得多。
- **不假装完整**：PG 部署（或没有 db 服务时）不产出数据库文件，清单里 `database.included=false` 并写明改用 `pg_dump`。**绝不在 `included:false` 的同时把 `.db` 拷进去**——那是最坏的组合：既不完整又装作有。

#### 恢复：三条纪律 + 为什么它只能走 CLI

**恢复要在服务器正拿着库和附件读写的时候替换文件，等价于"边跑边换引擎"。** 备份可以热做，恢复不行——所以它刻意不是路由，而是一个要求先停服、再在终端里显式敲下去的动作。三条纪律各有专门用例：

1. **先校验再动手**：逐文件 sha256 比对，不符即拒绝（覆盖了就回不去了）；
2. **清单里的路径必须落在其基准目录内**：清单是普通文件、可能被改过。用例构造的是"被改过的清单 + 与之匹配的正确哈希"——此时校验会通过，**只有**路径包含性检查能拦住它，这正是该用例单独存在的原因；
3. **覆盖前把原 `data/` 移到 `<数据目录>.pre-restore-<时间戳>/` 而不是删**——恢复这个动作本身就会让事情变好或变坏，留一份原状是唯一能救回来的东西。

CLI 另外提供 `--verify-only`（只校验不写入）与 `--list`（列出已有备份；**坏清单显式列出**而不是静默跳过，跳过会让"备份丢了"表现为"列表里没有它"）。

#### 一处如实记录的限制

`restore` 要求**先停服**，这一点靠文档与 CLI 提示约束，**代码无法强制**（进程无法可靠判断"另一个进程是不是正拿着这个库"）。把它做成路由并加锁是可行的下一步，但那是"热恢复"这个更大的话题，本轮不做。

### 优化点 3 + 4 文档拆分与「结论优先」（已落地）

**改动前**：`README.md` **1122 行 / 224,294 字节**，其中**第 7–840 行是一整块无标题的变更流水账**（「当前实现状态」，逐批追加，含用户原话、问题、做法与当时的验证读数），把 `## 快速开始` 挤到了第 841 行。审计列的「26 行超 1000 字符」里有 19 行在这块流水账内。

**改动后**：`README.md` **272 行 / 约 47 KB**，结构为 快速开始 · 特性亮点 · 技术栈 · 架构总览 · 仓库结构 · 文档导航 · 许可证。

| 去向 | 内容 | 方式 |
| --- | --- | --- |
| `docs/changelog/implementation-log.md` | README 第 7–840 行（834 行 / 约 166 KB） | **逐字迁出**，含开头那段已过时的「当前状态」行 |
| `docs/changelog/test-ledger.md` | 第 870 行**表格单元格里的历次测试读数台账**（约 6900 字节） | **逐字迁出** |
| `docs/deployment.md` §7 | README 的「如何用 PostgreSQL」小节（49 行） | 并入已有的 PG 章节，README 留 6 行指引 |
| `docs/README.md` | 新增：结论优先的文档索引 + 四条文档纪律 | 新文件 |

#### ★ 这一行不是「太长」，是**坏掉的**

第 870 行是「快速开始」命令表里 **`pnpm test` 那一行的表格单元格**。它被一轮轮追加到单格约 6900 字节，而**格内含未转义的 `|`**——Markdown 正是用 `|` 分列。于是这一行被解析成 **5 列**，出现在一张只有 2 列的表格里。**它在渲染上本来就是残缺的**，只是没有人注意到，因为没有人从头读完一个 8469 字节的表格行。

台账里每一轮都写着「上一读数已被本行取代」，却因为「维持台账连续性」都保留着——于是**读它的成本随批次数线性增长，而其中只有最后一组有效**。迁出后 README 那一行只留当前读数 + 取数方式 + 指向台账的链接。

#### 顺带修掉的三处过时读数（同类问题，一并清算）

| 位置 | 原写 | 实测 | 取数方式 |
| --- | --- | --- | --- |
| README 命令表 | `pnpm test` **1904/1904** | **2105/2105（25 个包）** | 仓库根 `pnpm test` 的 `# pass` 汇总 |
| README 仓库结构注 | 内置插件 **22 个** / 基础层启用 **18 条** | **24 / 21** | `grep -c "source: 'builtin'" packages/server/src/index.ts`；`config/plugins.base.json` 的 `enabled` 长度 |
| README AI 插件段 | AI 插件共 **九个**，全部默认启用 | **十个** | `ls -d packages/plugin-ai-*/`；`enabled` 里 `ai-*` 计 10 |
| `docs/deployment.md` §7 | 「`@geewiki/db-pg` 插件**尚在路线图中**，当前应用仍使用 SQLite」 | `packages/db-postgres` **已实现**（20 例单测），真实包名 **`@geewiki/postgres`** | `packages/db-postgres/package.json` 的 `name` |

**为什么值得单独列出来**：这几处都是「文档写着 A、仓库实际是 B」，而**过时的数字比没有数字更坏——它让人以为已核对过**。这正是新加的文档纪律第 4 条：文档里出现具体读数时**必须同时给出取数方式**，让它可被重新验证。

顺带一处**口径诚实性**修正：新 README 初稿把 `F1`–`F21` 枚举完写「均已落地」，而 `F15`/`F17`/`F19` 并未做。已改为显式列出**尚未落地的三项**并注明 `F19` 属 roadmap 里**有意延期**（`L-9`）——这正是本项要根治的那类不精确。

#### 内容保全的验证方式

拆分是**搬家不是重写**，每一步都用断言卡住边界而不是靠肉眼：

- 迁出前断言 `README.md` 第 1 行是 `# GeeWiki`、第 9 行是 `**当前实现状态**`、第 841 行是 `## 快速开始`；PG 小节断言起于 `### 如何用 PostgreSQL`、止于 `## 特性亮点`；台账行断言以 `` | `pnpm test` | `` 开头。**边界一旦漂移，脚本当场失败**，不会悄悄切错位置。
- 内容用 `'\n'.join(...)` **原样搬运**（含台账里那些未转义的 `|`），不做任何改写。
- 字节账可对：迁出 166,837 + 9,546 字节，源文件 224,294 字节。
- 迁完后抽查关键标记仍在（`万物皆插件，积木式搭建` 在 README；`SSO 的界面归还给提供者插件` 在 implementation-log；`L-1…L-20` 在 README 与 docs/README.md）。
- 断链检查：README 与 docs/README.md 的全部相对链接逐个 `os.path.exists`，**0 断链**。
- 全仓确认**没有任何测试读仓库 README**（`scaffold.test.ts` 里的 `README.md` 是脚手架自身生成物），故本次改动对测试无影响；仍按惯例跑了全量 typecheck + test。

### F19 PostgreSQL 适配（已落地，并完成**首次真实 PG 端到端验证**）

**为什么这件事此前一直没做**：`L-9` 把 PG 适配记为「有意延期」，理由是 `DatabaseAdapter` 是同步接口、需要异步双轨。而**双轨其实早已在 core 里落地**（`DatabaseAdapterAsync` / `isAsyncAdapter` / `asAsync`，core:444/471），schema 也早已按方言分家（`packages/db-sqlite/src/migrations` 与 `packages/db-postgres/migrations` 同编号两套 DDL）。真正缺的不是架构，是**验证**：仓库里从来没跑过一次真 PG。

本轮用 Docker 起了 **PostgreSQL 15.19**，把应用真的跑在上面。**结果：一次就抓出三个真 bug**，全都是"在 SQLite 上全绿、在 PG 上必炸"的类型。

#### 环境与验证方式（可复现）

```bash
docker run -d --name gw-pg-verify -e POSTGRES_PASSWORD=… -e POSTGRES_USER=geewiki \
  -e POSTGRES_DB=geewiki -p 55432:5432 postgres:15
# 配置：把 plugins.base.json 的 @geewiki/db-sqlite 换成 @geewiki/postgres
#   （host 127.0.0.1 / port 55432 / passwordEnv GW_PG_PASSWORD），search 暂不启用
GEEWIKI_CONFIG_DIR=… GEEWIKI_DATA_DIR=… GEEWIKI_PORT=3101 GW_PG_PASSWORD=… pnpm start
```

#### 抓到并修掉的三个真 bug

| # | 症状（真实日志原文） | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `[db-postgres] 迁移失败（已回滚）: 0001_ai_mutations.sql error: syntax error at or near "AUTOINCREMENT"` | `@geewiki/ai-journal` 自己调 `db.migrate(单一目录)`，方言无处可分；其 SQL 用 SQLite 专有的 `INTEGER PRIMARY KEY AUTOINCREMENT` | 新增 `packages/plugin-ai-journal/migrations-postgres/0001_ai_mutations.sql`（`INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`）；调用点改为 `await asAsync(db).migrate(journalMigrationsDirFor(db.dialect))`；清单声明 `migrations: { default, postgres }` |
| 2 | `[@geewiki/builtin-docs] 加载失败: db.query(...).map is not a function` | 按**同步**接口取 `db`（`ctx.get('db') as DatabaseAdapter`），而 PG 适配器的 `query` 返回 **Promise** ⇒ `.map`/`[0]` 失效 | 在**获取点**归一化为异步执行器（`const db = asAsync(dbRaw)`），迁移与全部查询 `await`；`SyncDeps.db` 类型由 `DatabaseAdapter` 收紧为 `DatabaseExecutor` |
| 3 | `db.query(...)[0]` 恒为 `undefined`（未报错，只在日志外表现为数据缺失） | 同 #2，`@geewiki/ai-summary` 有 6 处同步式调用（含跨行 `.map()`） | 同上：`apply` 改 async，`readStored`/`store` 改 async 并补 `await`，调用点同步更新 |

**#2 为什么类型检查没拦住**：`as DatabaseAdapter` 这句**断言本身在撒谎**——PG 适配器的 `query`/`run` 返回 Promise，而同步接口说它返回数组/结果。断言一写，编译器就闭嘴了。**这正是修法要在获取点归一化的原因**：归一化之后 `db.query()` 的类型就是 `Promise<…>`，忘写 `await` 会直接是类型错误。

#### 一条顺带发现的「观测故障」（在默认 SQLite 路径上）

真 PG 启动时看到 `[@geewiki/wiki] 附件服务尚未就绪：上传将返回 503 storage_unavailable`，而**默认 SQLite 部署也一样**（每次启动都打）。实测判定它**不是功能故障**（`GET /api/attachments/<不存在>` 返回 **404** 而非 503 ⇒ 请求期服务可见），而是**观测故障**：

- 探针走了 `attachmentService()`（内部 `ctx.get('attachment-service')`），而 cordis 里**插件在自己的 `apply` 结算前看不到自己刚 `provide` 的服务** ⇒ 探针**必然抛错**；
- 于是探针**真正的用途**（检查附件目录可写）**从未执行**——它在 `ready()` 之前就抛了；"数据目录只读"这个它专程要报的场景反而报不出来；
- 报警文案还**硬编码**归因到 `attachmentProvider:none`，而取值是 `builtin` ⇒ 把操作者引向一个本来就正确的配置项。

修法：探针打在**本插件刚建出的那个对象**上（`builtinAttachment.ready()`），不再经过 `ctx.get`；错误消息改为报**实际生效的配置值**。修后实测：假警报 **0**；且用"同名文件占位使目录建不出来"构造真故障时，探针**正确报出** `EEXIST`（证明它现在真的在做那件事），wiki 仍照常激活。

#### 新增的两条类级守卫

| 守卫 | 钉住的判据 |
| --- | --- |
| `packages/manager/test/migrations-dialect.test.ts`（6 例） | 用了 SQLite 专有语法的迁移目录，必须有 `migrations-postgres/`（**文件名一一对应**）或登记进 `SQLITE_ONLY`（须写明理由）。含：`CREATE VIRTUAL TABLE`/`USING fts5`（第一版判据漏了这两条，导致 `plugin-search` 被判为"干净"的**假阴性**——它才是真正的 SQLite 专有插件）；`db-sqlite` ↔ `db-postgres` 的**编号对应**检查（防"给 SQLite 加了表、忘了 PG"）；`SQLITE_ONLY` 登记**不得过期** |
| `packages/manager/test/db-dual-track.test.ts`（2 例） | 凡是**在代码里**取 `ctx.get('db')` 的源文件，必须出现 `asAsync`。先断言枚举到的消费方 ≥8 且含预期成员，避免判据写坏后**空集通过**。当前 11 个消费方全部合规 |

两条守卫都**先剥注释再断言**：解释"旧写法错在哪"的注释里必然引述旧代码/旧消息，不剥注释就会把解释当违规（F21 的脚手架守卫踩过同一个坑）。

#### ★ 本轮第二次踩到「块注释提前闭合」

写 `migrations-dialect.test.ts` 时，我在 JSDoc 里写了带通配符的路径，其中的**星号紧跟斜杠**提前闭合了块注释，后面的文本变成代码、esbuild 报 `Expected ";" but found "migrations"`。更值得记的是：**第一次修完之后，我在解释这件事的注释里又把它写了进去，于是它再次闭合。** 结论写进了守卫注释：在块注释里描述这个序列要**拆开写**。

#### 端到端验证读数（真实 PostgreSQL 15.19）

| 步骤 | 读数 |
| --- | --- |
| 启动与迁移 | `db-postgres` 13 个迁移全部应用；**迁移失败 0**；插件 **20 active / 0 error**（配置里 `search` 未启用、`db-sqlite` 被替换） |
| 建管理员 | `POST /api/auth/setup` → **201** |
| 登录 | `POST /api/auth/login` → **200** |
| 建页 | `PUT /api/pages/pg-e2e` → **200**（`outcome: created`, `version: 1`） |
| 读回 | `GET /api/pages/pg-e2e` 返回的正文与写入**逐字一致** |
| 落库确认 | `psql -c "select slug,title from pages where slug='pg-e2e'"` → `pg-e2e | PG 端到端验证` |
| 内置文档 | `GET /api/pages` 列出 `builtin-docs` 在 PG 上创建的文档（证明 #2 修复后该插件真的在工作） |

#### 一处操作教训（与代码无关，但会误导读数）

验证时我一度把**残留进程**当成了"修复无效"：`pkill -f "…server/src/index.ts"` 自杀（模式匹配到自己的命令行，exit 143），而真正的服务跑在 **bwrap 的独立 PID 命名空间**里，`pgrep` 根本看不到它 —— 于是新进程 `EADDRINUSE` 静默失败，我却在用**旧代码进程**的读数下结论。改用受管后台任务 + **每次换端口**后才拿到可信读数。另：`/tmp` 是每个命令私有的 tmpfs，跨命令传 cookie 必须落在仓库内。

### F17 插件安装与完整性校验（已落地；★ 边界：这是完整性，不是签名）

交付：`packages/manager/src/plugin-install.ts`（库）· `pnpm run install-plugin <来源>` / `--verify` · `GET /api/plugins/integrity`（admin，`Manager.verifyPluginIntegrity()`）· 守卫 18 例。

#### 先厘清这一项**不做**什么，再说什么做了

`F17` 的完整形态是「插件市场 / 远程安装」，而那需要**发布者签名与公钥信任链** —— 本仓库没有，本轮也**不冒充**它。本模块给的是：

- **能回答**：相对"装进来那一刻"的基线，这个插件的文件**被改过吗**（`ok` / `drift`）。
- **不能回答**：这个插件**是谁发布的、可信吗**。

这个区分不是措辞洁癖：若把它当成签名校验，就会得到一个**假安全感** —— 能改写插件文件的人同样能改写随包落地的完整性基线。真正让"装进来的东西可被审计"的另一半是 **F10 的 `permissions` 清单**（声明要碰哪些跨界能力）。因此 `verify` 的三种结果里，**`unsigned`（没有基线 ⇒ 无法判断）刻意与 `ok` 分开** —— 把"无法判断"报成"通过"，正是这类设施最容易退化成"看起来在防护、实际什么都没防"的方式。

#### 安装：三种来源，两道防线

```bash
pnpm run install-plugin ./some-plugin          # 目录（开发期）
pnpm run install-plugin ./dist/foo-1.0.0.tgz   # 压缩包
pnpm run install-plugin https://…/foo.tgz      # URL（**仅 https**）
pnpm run install-plugin ./foo --dry-run|--name|--force
pnpm run install-plugin --verify [--json]
```

- **只接受 `https://`**：明文 http 意味着包在路上任何人都能替换。`classifySource` 直接拒绝 `http://`。
- **不新增依赖**：仓库里没有可解析的 JS tar 实现（`tar`/`tar-stream` 都不可用），故用系统 `tar`，并在它**之外**加两道自己的防线：
  1. 解包**前**用 `tar -tzf` 列出条目，**逐条拒绝**绝对路径与含 `..` 段的条目；
  2. 解包**后**走一遍目录树，拒绝**符号链接与非普通文件**。
  理由是：越界条目在解包时是否被拦下取决于具体 tar 实现与版本，而"包里有没有这种条目"是我们自己就能判定的**确定事实**；符号链接则让"目录内的文件"在运行时指向目录外（`tar -tzf` 只看名字，看不见它）。
  两种危险包都由 GNU tar 的 `-P` **真实构造**出来做用例（绝对路径、`../`、符号链接各一条），不是纸上谈兵。
- **失败不留痕**：解包到 `pluginsRoot` 下的 `.gw-install-*` 暂存区，成功才 `rename` 到目标（同文件系统 ⇒ 原子，目标位置不会出现"解包到一半"的插件目录）；`installPlugin` 的整体包在 `try/finally` 里，**失败必清暂存区**。
- **覆盖要先说**：目标已存在时默认拒绝（原目录一字不动）；`--force` 时把原目录**移到 `<目录>.replaced-<时间戳>`** 而不是删。
- **`dir` 来源是复制而不是搬走**：用户点了一个目录，不该在安装后把它挪空。
- **基线最后写**：中途失败留下的是**没有基线**的目录，会以 `unsigned` 暴露出来，而不是"看起来已校验"的假象。

#### 两个被测试抓出来的真 bug（都在"看起来正常"的路径上）

1. **`dir` 来源会把空的暂存目录装进去**。首版把"暂存根"与"内容根"混为一个字段：对目录来源，`contentRoot` 是用户的目录而 `stagingRoot` 是刚建的空临时目录，于是 `rename(stagingRoot, target)` 把**空目录**装到了目标位置。修法是把两个概念分开（`contentRoot` / `stagingRoot`），目录来源先在暂存区里复制一份再搬。
2. **被拒绝的安装会泄漏 `.gw-install-*`**。"目标已存在 → 拒绝"这条提前退出原本写在清理暂存区的 `try/finally` **之外**，于是每次被拒绝都留一个暂存目录 —— 它被 `mkdtemp` 建成 `.gw-install-*`、又被发现流程忽略（以 `.` 开头），所以**不会报任何错**，只会一路堆积。用例（"拒绝后 `pluginsRoot` 里只剩 `demo`"）把它抓了出来。

#### 刻意不做进 `GET /api/plugins` 的原因

完整性校验要对每个插件的每个文件算 sha256，而 `GET /api/plugins` 是**前端会轮询的热端点**（插件探测与 UI 入口表都读它）。放进热路径等于给每次轮询加一次全量磁盘读，故走独立的 admin 端点与 CLI（**按需**动作）。

同理，`Manager.verifyPluginIntegrity()` 在未配置 `pluginsDir` 时**明确回"未配置"并附说明**，而不是猜一个目录 —— 猜错会让"没有插件"与"看错地方了"这两种完全不同的情况长得一模一样。

#### 未做（如实记录）

远端注册表 / 发布者签名与信任链 / 安装前的权限变更提示（今天只能装完再看 `permissions`）/ 依赖安装（外部插件本就**不能**有自己的依赖）。

### F15 i18n 体系（机制已落地；★ 边界：宿主存量界面**未**全量抽键）

审计的原文是「**宿主 + 插件共用一套 message catalog**」，重点在「共用」。本轮交付的正是这个机制，而不是"把界面翻译成英文"：

| 层 | 落点 | 内容 |
| --- | --- | --- |
| 契约 | `packages/core/src/domain.ts`（**浏览器安全**） | `LOCALE_CODE`/`isLocaleCode`、`DEFAULT_LOCALE`、`baseLanguageOf`、`fallbackChain`、`HOST_MESSAGE_PREFIX`/`PLUGIN_MESSAGE_PREFIX`/`pluginMessagePrefixOf`、`MESSAGE_KEY`/`isMessageKey`/`messageKeyOwner`、`interpolate`、`resolveMessage`、`missingKeys`、`mergeCatalogs` |
| 声明 | `GeeWikiMeta.locales?: Record<string, string>` | 语言 → 相对插件目录的 JSON 路径（**声明式**：可选语言必须可枚举） |
| 聚合 | `packages/manager/src/i18n.ts` + `Manager.i18nAvailable()` / `i18nCatalogs()` | 读插件 catalog、按命名空间合并、下发**整条回退链** |
| 接口 | `GET /api/i18n`（public）/ `GET /api/i18n/:locale`（public） | 语言清单 + 各语言合并后的插件文案 + `issues` |
| 宿主 SDK | `packages/web/src/lib/hostSdk.ts` → **0.9.0** | `t(key, params)` / `getLocale()` |
| 前端 | `packages/web/src/lib/i18n.ts` + `src/locales/{zh-CN,en}.json` | 宿主文案打包、插件文案走接口、语言偏好存 `localStorage` |
| 示范接入 | `main.tsx`（初始化 + `<html lang>`）、`NotFoundPage`（改用 `t()`） | 让机制**真的在跑**，而不是一段没人调用的死代码 |

#### 三条裁决（都有守卫）

1. **命名空间是强制的，不是约定。** 宿主键一律 `host.`，插件只能写 `plugin.<短名>.`。理由不是洁癖：**不限制的话，任何插件都能改写宿主界面上的任意文案** —— 一个把「确认删除」改成「继续」的插件能骗用户点下去。越权键在**服务端装载时被拒绝并报告**，客户端不重复一份判据（重复的判据只会多一处会漂移的地方）。
2. **解析结果永不为空串。** 缺失时返回**键名本身**并标记 `missing`：空串会让界面**静默缺一块**，而键名一眼可见，且 `missingKeys()`/`catalogStats()` 能把缺口汇总成"翻译进度"——这正是"未翻译完"能被观测的前提。
3. **下发整条回退链，而不是只下发请求的那一种。** 回退发生在客户端，若只给请求语言，一个只填了 `en` 的插件在 `zh-CN` 用户那里会退化成键名；而且回退逻辑只应在 core 的 `fallbackChain` 里**实现一处**，不该前后端各写一份。

#### 两道路径/资源防护（清单是第三方提供的文件）

- **路径穿越**：`locales` 的值经 `isInsideDir` 校验，`../../../secret.json` 被拒绝 —— 否则把任意文件当文案读走，并经**公开**端点原样下发。
- **超大文件**：读取**前**先看体积（上限 2 MiB），超限即拒绝并报 issue，而不是先读进内存再判断。
- 两类问题都走 `issues` **显式暴露**，不静默跳过：跳过的表现是"某插件界面莫名其妙全是键名"，而没有任何线索指向清单里那一行。

#### 测试抓到的两个「我以为测到了」

1. manager 用例只请求了 `zh-CN`，而回退链是 `['zh-CN','zh']` —— 另外三个语言的坏文件**压根没被读到**，用例却"过了"。修法是按各自语言分别装载后取并集，并把这条陷阱写在注释里。
2. web 用例断言 `resolveInitialLocale() === DEFAULT_LOCALE`，实际拿到 `en` —— 因为 Node 里 `navigator.language` 是 `en-US`，而链上确实能找到 `en`（我们有英文文案）。**程序是对的、断言是错的**：它测的其实是"Node 有没有 navigator"。改成断言真正的不变量——**选出的语言必须落在我们确实有文案的语言集合里**（否则首屏会整片变成键名）。

#### 未做（如实记录）

- **宿主存量界面的全量抽键**：`App.tsx` 与 10 个页面里的中文是硬编码的，全量抽出是一次机械但浩大的改造。本轮只接入外壳与一个示范页面，**没有**做全量，因此**不要**把本轮读成"界面已国际化"。
- 复数/性别等 ICU 规则、日期与数字格式化（`Intl` 可直接用，但需要与 catalog 的分工约定）、翻译工作流（导出待译清单 → 回收译文）。

---

### 「审计与运维」从宿主页面搬成插件 `@geewiki/ops`（已落地；F2 页面路由的**第一个真实使用者**）

用户反馈「当前的审计与运维功能性和表现形式上都很差」，并先问了一句「这个审计与运维是由插件实现的吗」。
查下来答案是**一半一半**，而这条分界线恰好就是问题本身：

- **表现形式 = 宿主页面**：`packages/web/src/pages/OpsPage.tsx`（536 行），路由 id `audit` 写死在
  `App.tsx` 的 `ADMIN_NAV` 与 `core` 的 `RESERVED_ROUTE_IDS` 里；
- **功能 = 全部来自插件**：页面调的 8 个端点分属 `@geewiki/auth`（会话列表/吊销）、
  `@geewiki/authz`（审计查询/授权回收/反向展开/sitemap 核对/清缓存指引）、
  `@geewiki/org`（邀请回收）。

于是"功能性差"的**硬证据**是：插件侧早已实现好的四个能力，界面上**零入口**（grep 确认前端没有任何引用）——

| 端点 | 归属插件 |
| --- | --- |
| `GET /api/admin/search/verify` | `@geewiki/search` |
| `GET /api/admin/blocks/verify` | `@geewiki/wiki` |
| `POST /api/admin/blocks/resync` | `@geewiki/wiki` |
| `POST /api/admin/users/:userId/sessions/revoke` | `@geewiki/auth` |

还有两处"数据拿到了但没显示"：`AuditEntry.before` / `.after`（`api.ts:1504-1505`）——
**权限变更"到底改了什么"的答案**，界面一个字没渲染；以及 `SessionEntry` 的
`createdAt` / `userAgent` / `ipHash`。另外 `api.auditLog` 支持
`action / targetKind / targetId / since / until / limit / offset`，界面只用了 `view` +
写死的 `limit: 50` —— 过滤、时间范围、分页一个都没用上。

#### 落地位置

- **新包 `packages/plugin-ops/`**：`src/index.ts`（清单声明 `routes: [{ id: 'audit', label: '审计与运维',
  requires: 'administer', group: 'admin' }]`，服务端只有一个空 `apply`，`provides` 刻意留空）、
  `ui/index.tsx`（页面，五个分区）、`ui/api.ts`（自带 fetch + `x-gw-csrf: '1'`）、
  `ui/plan.ts`（纯判据层，零 import、可在 node 直测）、`ui/style.css`（`.gw-ops-*`，只用宿主
  `--color-*` 语义变量、一个回退值都不写）。
- **宿主侧三处必须同时删**（只删一边的后果都是**静默**的，故由
  `packages/web/test/opsOwnership.test.ts` 逐条钉住）：`ADMIN_NAV` 的入口、
  `App.tsx` 的 `active === 'audit'` 分派分支、`RESERVED_ROUTE_IDS` 里的 `'audit'`
  （留着它 ⇒ 插件那条声明会被 `resolveRouteDecls` 按"保留 id"**整条拒绝**）。
- **组合根登记**：`packages/server/src/index.ts` 加 import + 注册表条目；
  `config/plugins.base.json` 在 `@geewiki/authz` **之后**启用（它 `requires` auth/org/authz，
  而基础层清单的顺序就是激活顺序）。
- **构建**：`build:plugin-ui` 加一段；`tsconfig.plugin-ui.json` 的 `include` 加 `plugin-ops/ui`。

#### 关键取舍

- **插件 UI 一律自带 CSS**：宿主 Tailwind 只扫 `packages/web/src`，而**外部插件**（`plugins/<name>/`）
  根本不在仓库那个位置 —— 依赖宿主工具类不可移植。故 `style.css` 用 `.gw-ops-*` 前缀 +
  宿主 `--color-*` 语义变量（与 `@geewiki/ai-assistant` 同一做法）。
- **不需要任何新的宿主能力**：`registerRoute` 早已在宿主 SDK 里（`hostSdk.ts:144`，SDK `0.9.0`），
  CSRF 只是一个静态头 `x-gw-csrf: '1'`。
- **危险操作改成"就地确认条"而不是模态**：模态会盖住被操作的那一行，而本页的破坏性动作
  全是针对具体对象的。
- **`busy` 从全局单键改为按动作的键**：此前任何一个动作在跑，页面上**所有**按钮都禁用
  （一次全库重算会冻住整页）。
- **`view: 'all'` 仍然禁用**：两类审计必须各自取数（服务端白名单是真源），前端取 `all`
  再分类等于把那套白名单抄第二份。

#### 验证读数（取数方式一并给出）

- `pnpm run typecheck`：27 个项目 + `scripts/` + `plugin-ops`，`grep -c 'error TS'` = **0**，exit 0
  （日志 `data/verify/tc-users2.log`）。
- `pnpm run test`：**2210 例 / 2210 通过 / 0 失败**，exit 0（日志 `data/verify/test-users2.log`）。
  本轮新增 `packages/plugin-ops/test/opsPlan.test.ts`（26 例，纯判据）+ `opsUi.test.ts`（12 例，
  源码级不变量）+ `packages/web/test/opsOwnership.test.ts`（4 例，归属）；`opsPage.test.ts` 已删
  （它钉的页面不在宿主里了）。
- 搬迁时被**测试抓到的两处真实后果**（都已修）：① `orgPage.test.ts` 里钉
  `purgeInvitations` 的那条断言 —— 该方法的归属变了，已改成"宿主里不得再有一份 + 插件里有"；
  ② 宿主 `api.ts` 的 8 个方法 + 7 个类型成了死代码（逐名 grep 外部引用为 0），已整块删除。
- **运行期实测**（`curl` 真实服务）：`GET /api/plugins/ui` 的 `plugins["@geewiki/ops"]` =
  `{entry:"client.js", css:"client.css", rev:"f32aa3f2", routes:[{id:"audit", label:"审计与运维",
  requires:"administer", group:"admin"}]}`；`GET /api/plugins/slots` 的 `routes` =
  `[{owner:"@geewiki/ops", route:{id:"audit",…}}]`、`routeConflicts: []`；
  `/plugins-ui/@geewiki/ops/{client.js,client.css}` 均 200。
- **渲染实测**（headless Chrome 挂真实组件 + 打桩 fetch，五个分区各渲染一份）：
  五分区全部 `渲染=ok`，`table` 3 张、`[role=tab]` 25 个（5 分区 × 5 标签）、
  变更明细 `private → org` 真的画出来了、分页文案 `第 1 / 3 页` 与 `共 120 条` 正确；用户列解析为 `张三` / `zhang@example.com · #1`（无显示名时退回邮箱 `li@example.com` / `#2`），查不到的 id 显示 `#404` + 「不在当前成员列表（可能已退出或被删除）」，匿名显示「（匿名）」+「无用户身份」—— 三种「解析不出来」互相可区分。
  产物 `client.js` **41.35 kB / gzip 9.90 kB**、`client.css` **5.33 kB**（加入用户目录后的最终读数）。

#### 用户定位（追加一问：「方便定位用户」）

原状：操作者/用户列只有 `#12` —— 端点的响应里只有 `actorId` / `userId`，没有用户名。
改法是**前端映射**，而不是改两个插件的响应契约：

- 新增 `fetchMembers()` → `GET /api/org/members`（`@geewiki/org`，`access: 'user'`，
  返回 `{userId, email, displayName, role}`），在 `OpsRoute` 里取一次、建
  `buildUserIndex()` 索引，审计表与会话表共用。
- `resolveUser(userId, index)` 产出**两行**：主标签 = 显示名 → 邮箱 → `#id` 依次回退；
  次要小字 = `邮箱 · #id`。**邮箱必须一起显示** —— 只给显示名的话，"同名的人"仍分不出来；
  `#id` 也必须留着，排障时要在日志里 grep 那个数字。
- **三种"解析不出来"必须可区分**：`null` ⇒ `（匿名）/ 无用户身份`；查得到 ⇒ 人；
  查不到 ⇒ `#id` + **明说**"不在当前成员列表（可能已退出或被删除）"。
  最后一种最容易做错：只显示 `#12` 与"根本没做解析"长得一模一样，而那正是要消灭的状态。
- 目录**取不到时不挡路**（审计/会话数据本身仍有用），但走 `onError` 弹横幅 ——
  否则每行都显示"不在当前成员列表"，而那个说法在"目录没加载出来"时是**错的**。

为什么不改后端：那要同时动 `@geewiki/authz`（audit）与 `@geewiki/auth`（sessions）两个包的
响应契约，而那两个端点还有别的消费者；本页面本来就要展示成员，多取一次比多加两个字段更省事。
**它解决不了的那一类**：审计是长期台账，而成员表只反映当下 —— 已退出/被删除的用户永远解析
不出来，那时显示 `#id` 是如实呈现。真正的修法是写入审计时存身份快照（`actorEmail` 冗余列），
那是一次 schema 迁移，不在本轮。

**顺带清掉的死代码**：搬迁之后，宿主 `packages/web/src/api.ts` 里的 8 个方法
（`auditLog` / `sessions` / `revokeSession` / `purgeGrants` / `purgeInvitations` /
`accessExplain` / `sitemapAudit` / `cachePlan`）与 7 个类型（`AuditEntry` / `AuditResponse` /
`SessionEntry` / `SessionsResponse` / `AccessExplainResponse` / `SitemapAuditResponse` /
`CachePlanResponse`）**外部引用数全为 0**（逐名 grep 确认）—— 留着就是"同一份端点契约两个实现"，
而两者漂移是静默的。已整块删除。

#### 未做（如实记录）

- 落成插件后 `@geewiki/ops` **可以被停用**。这是「万物皆插件」的应有之义，但也意味着
  "停用之后就没地方看审计了"。（用户明确表示这一条不用管。）
- 审计端点**没有按操作者筛选**的参数（只有 `view/action/targetKind/targetId/since/until/limit/offset`），
  故"看某个人做过什么"目前只能翻页找。那是一次后端契约变更，留作显式决定。


---

## 1. 健康度实测（客观读数）

### 1.0 最新读数（F1–F21 全部落地 + 优化点 1/2/3/4/6/7/8）

| 指标 | 读数 | 证据 |
| --- | --- | --- |
| 类型检查 | **27 个项目 + `scripts/`（新纳入）全部通过、0 个 `error TS`** | `pnpm run typecheck`，exit 0（`data/verify/tc-final-f15.log`） |
| 单元测试 | **2162 例 / 25 个包 / 0 失败** | `pnpm run test`，exit 0（`data/verify/test-final-f15.log`） |
| 测试文件 | **166** 个 `*.test.ts`（审计基线 140） | `find packages -name "*.test.ts"` |
| 参与测试的包 | **25**（基线 24）——`db-sqlite` 首次加入 | 为它补了 `test` 脚本 |
| **PostgreSQL 端到端** | **首次真实验证**（PG 15.19）：20 个插件全 active、0 迁移失败；登录→建页→读回→`psql` 落库确认全通 | 见 §0.5「F19」的可复现命令 |
| **README 体量** | **273 行 / 48.9 KB**（审计基线 **1122 行 / 224.3 KB**） | `wc -lc README.md`；拆分见 §0.5「优化点 3+4」 |

**本批净增**：`manager` **+37**（F21 脚手架 12 + 优化点 6 清理 11 + F20 备份恢复 14）· `core` +14（F18）· `web` +13（F16）· `db-sqlite` +9（此前**为 0**）。累计自审计基线 1904 → **2105**。

> **两条过程记录（都值得留档）**：
> 1. F18 的测试里有一个**隐含 `any`**（`async (texts) => …`）—— `tsx --test` **不做类型检查**，所以测试全绿而 `tsc` 报 `TS7006`。这是"测试绿 ≠ 类型正确"的实例，也是每步都坚持**同时**跑 `typecheck` 与 `test` 的原因。
> 2. F21 的脚手架第一版在**文档注释**里写出了含有块注释结束序列的字面量，把注释提前闭合、后面的文本变成代码并抛 `ReferenceError` —— 而这正是本轮给 `scripts/` 加上类型检查后才**当场报出来**的那类错误。

测试分布（例数，本批）：`web` 837 · `plugin-ai-assistant` 236 · **`manager` 238** · `plugin-wiki` 124 · `plugin-llm` 93 · `server` 79 · `plugin-openai` 72 · `core` 54 · `plugin-ai-journal` 49 · `plugin-search` 42 · `plugin-ai-summary` 38 · `plugin-ai-pages` 34 · `plugin-ai-admin` 33 · `plugin-ai-web-search` 32 · `plugin-ai-kb` 23 · `db-postgres` 20 · `plugin-auth` 18 · `plugin-oidc` 17 · `plugin-ai-tools` 17 · `plugin-ai-writing` 15 · `plugin-builtin-docs` 14 · **`db-sqlite` 9** · `plugin-authz` 4 · `plugin-ai-nav` 4 · `plugin-org` 3。

### 1.1 审计当日基线（F1/F2 落地**之前**）

> 下列读数为审计当日的基线，保留用于对照"整改前 → 现在"的位移。

| 指标 | 读数 | 证据 |
| --- | --- | --- |
| 类型检查 | **27 个项目全部 Done、0 个 `error TS`** | `pnpm run typecheck`，exit 0 |
| 单元测试 | **1904 例 / 24 个包 / 0 失败** | `pnpm run test`，exit 0 |
| 测试文件 | 140 个 `*.test.ts` | `find packages -name "*.test.ts"` |
| 源码规模 | `packages/*/src` ≈ 63.3K 行；`packages/*/test` ≈ 41.2K 行 | `wc -l` |
| 包数量 | 28 个 workspace 包（27 个参与 typecheck） | `pnpm-workspace.yaml` |
| 依赖漏洞 | **No known vulnerabilities found** | `pnpm audit --audit-level=high` |
| 技术债标记 | 全仓仅 3 处 `TODO/FIXME`，且都已在注释中说明「为何不做」 | `grep -rn TODO` |

测试分布（例数，基线）：`web` 785 · `plugin-ai-assistant` 236 · `manager` 144 · `plugin-wiki` 120 · `plugin-llm` 92 · `plugin-openai` 72 · `server` 66 · `plugin-ai-journal` 49 · `plugin-search` 42 · `plugin-ai-summary` 38 · `plugin-ai-pages` 34 · `plugin-ai-admin` 33 · `plugin-ai-web-search` 32 · `core` 26 · `plugin-ai-kb` 23 · `db-postgres` 20 · `plugin-auth` 18 · `plugin-ai-tools` 17 · `plugin-oidc` 17 · `plugin-ai-writing` 15 · `plugin-builtin-docs` 14 · `plugin-ai-nav` 4 · `plugin-authz` 4 · `plugin-org` 3。

**判断**：`plugin-ai-*` 系列合计 **520** 例，`web` 785 例——测试厚度集中在「AI 编排」与「宿主界面」两处，与当前演进重心一致。~~`db-sqlite` 无 `test` 脚本（`--if-present` 跳过），是唯一没有单测的运行时关键包。~~ **✅ 已修（优化点 7）**：`db-sqlite` 现有 9 例并加入 `--if-present` 的执行集合，**覆盖分布与风险分布相反**这一状态已消除。

---

## 2. 目标对齐度：距「极致灵活 / 万物插件 / 最大自由度」的差距

### 2.1 根因：扩展点是「编译期枚举」而非「运行期注册」

项目已经**正确**地把很多能力做成了注册表（路由、插槽贡献、AI 工具、外部插件发现）。问题只出在**注册表的键空间被写死**：

- 插槽名是 `union` 类型 + 数组白名单 → 插件**不能发明**新的挂载点。
- 前端路由/导航是宿主源码里的数组 → 插件**不能占位**新的页面。
- 授权能力是写死的 interface → 插件**不能声明**新的权限能力。

「注册表」是好机制；只要把「键」的合法性从**编译期枚举**改成**运行期注册 + 命名空间**，自由度会立刻从「7 个格子」变成「无限个格子」。这是本次审计最核心的一条。

---

### 2.2 A 级阻碍 —— 直接封死自由度（前端扩展面闭合）

#### A1. 插槽白名单闭合，且同一份事实有 **4 份镜像** ✅ **已解（F1，见 §0.5）**

`SlotName` 是 7 项的字面量联合，`SLOT_NAMES` 数组在 4 处独立重复：

| # | 位置 | 用途 |
| --- | --- | --- |
| 1 | `packages/core/src/index.ts:881`（`SlotName`）/ `:896`（`SLOT_NAMES`）/ `:919`（`SLOT_CARDINALITY`） | 后端真源 |
| 2 | `packages/web/src/lib/slots.tsx:50`（`SlotName`）/ `:68`（`SLOT_NAMES`）/ `:227`（`SINGLE_OCCUPANCY_SLOTS`） | 浏览器渲染 |
| 3 | `packages/web/src/lib/pluginUiPlan.ts:75`（`SlotName`）/ `:84`（`SLOT_NAMES`） | 按需加载判定 |
| 4 | `packages/web/src/lib/pluginUiPlan.ts:134`（`ON_DEMAND_SLOTS`） | 懒加载策略 |

**后果**：① 插件无法定义自己的扩展点，只能把界面塞进宿主预留的 7 个位置之一；② 宿主自己加一个插槽，要跨 3 个包改 ≥4 处 + 2 个类型联合，并维护 2 个源码级守卫测试（`packages/manager/test/slots.test.ts`、`packages/web/test/slotPropsMirror.test.ts`）。

`packages/web/src/lib/pluginUiPlan.ts:70` 的注释自己承认了这一点：「这是同一份白名单的**第四处**」。

> 注：镜像**本身是被迫且合理的**——`core` 顶层 `import 'node:fs'`，进不了浏览器 bundle。问题不在镜像，而在**键空间闭合**。

#### A2. 插件无法注册路由 / 导航 / 页面 —— 做不出「一个完整的功能模块」 ✅ **已解（F2，见 §0.5）**

宿主 SDK 的全部能力（`packages/web/src/lib/hostSdk.ts:31`，`HOST_SDK_VERSION = '0.3.0'`）只有 6 项：
`React`、`jsxRuntime`、`registerSlot`、`unregisterSlot`、`renderMarkdown`、`registerTool` / `unregisterTools` / `invokeTool` / `clientTools`。

**没有** `registerRoute` / `registerNav` / `registerPage` / `registerSettingsSection` 之类对插件开放的入口。
（注：全仓唯一的 `registerRoutes` 在 `packages/manager/src/index.ts:1810`，是**管理器给自己挂 `/api/plugins*` REST 端点**的内部函数，不对外、也不接受插件传路由，故与「插件能否注册路由」无关。）

而宿主的页面与导航是**写死的源码数组**：
- `packages/web/src/App.tsx:185` `WIKI_ITEM`、`:199` `ADMIN_NAV`、`:240` `LEGACY_ROUTES`
- `packages/web/src/App.tsx:276` 用 `[WIKI_ITEM, ...ADMIN_NAV, ...LEGACY_ROUTES].some(...) || isAuthRoute(root)` 做「已知路由」判定，**未知路由直接落 `notfound`**
- `packages/web/src/pages/` 共 10 个固定页面（`WikiPage.tsx` 3510 行、`GraphPage.tsx` 1530 行、`OpsPage.tsx` 536 行…）

**后果（这是最痛的）**：一个插件想做「独立的看板 / 图谱工具 / 报表 / 自定义管理台」，**做不到**。它没有 URL，因此：刷新丢失状态、无法被链接分享、无法被书签收藏、无法被其他页面跳转、无法用浏览器后退。它只能挤进 `app-dock` 或某个插槽当「浮层」。路线图自己在 `docs/roadmap.md:67` 记着 `admin-page-slots`「**仍未提供**」。

#### A3. 宿主 SDK 不导出 `react-dom` → 插件无法 portal / 无法自建根

`packages/web/src/lib/hostSdk.ts:34-35` 只暴露 `React` 与 `jsxRuntime`；import map 只映射 `react` / `react/jsx-runtime`（`packages/web/src/lib/hostSdk.ts:18-20` 说明「必须在任何插件 bundle 被动态 import 之前挂载」）。

**后果**：插件不能 `createPortal` 到 body、不能挂载自己的 DOM 根、不能做全屏模态（只能用宿主给的插槽高度）。对「编辑器 / 画布 / 全屏工具」这类插件是硬约束。

#### A4. 插件 UI 只能带 `entry` + `css` 两个**单段文件名**

`packages/core/src/index.ts:427` 的 `PLUGIN_UI_FILE_SEGMENT` **拒绝**含 `/` 的入口名；`GeeWikiClient` 只有 `entry?` / `css?`（`packages/core/src/index.ts:89-97`）。

虽然静态层的 `PLUGIN_UI_ASSET_PATH`（`packages/core/src/index.ts:447`，≤16 段）**允许**子目录，但清单层不声明「资源根」，所以字体/图片/wasm/sourcemap 只能内联进 bundle。路线图 `docs/roadmap.md:80` 自认：「**不支持任意资源目录、也不支持子目录资源**」。

**后果**：稍重的插件（CodeMirror / 图形库 / 本地模型）bundle 会失控膨胀，且无 `Content-Type` 外的缓存策略定制。

---

### 2.3 B 级阻碍 —— 「万物插件」的可替换性不完整

#### B1. 契约归属不统一：一半在 `core`，一半在**被替换的那个插件里**

| 契约 | 声明位置 | 能否被第三方等价替换 |
| --- | --- | --- |
| `DatabaseAdapter` | `packages/core/src/index.ts:233` | ✅ 可（`db-postgres` 已是第二实现） |
| `HttpRouterService` | `packages/core/src/index.ts:749` | ✅ 可 |
| `SlotService` | `packages/core/src/index.ts:1163` | ✅ 可 |
| `Principal` / `RouteAccess` | `packages/core/src/index.ts:565,580` | ✅ 可 |
| `AuthService` | `packages/plugin-auth/src/index.ts:187` | ⚠️ 替换者须依赖 `@geewiki/auth` |
| `SearchService` | `packages/plugin-search/src/index.ts:191` | ⚠️ 替换者须依赖 `@geewiki/search` |
| `WikiService` | `packages/plugin-wiki/src/index.ts:399` | ⚠️ 替换者须依赖 `@geewiki/wiki` |
| `LlmService` | `packages/plugin-llm/src/types.ts:330` | ⚠️ 替换者须依赖 `@geewiki/llm` |

**后果**：想「用同一个插槽换掉 wiki 内核」（比如换成面向文档库/代码仓的实现），必须 `import` 你要替换掉的那个包来拿类型——**语义上倒挂**，且该包的内部改动会沿着类型面传导给所有替换者。这正是 `plugin-platform-plan.md` 里 `provides` 冲突组机制想支持、但契约位置没跟上的场景。

#### B2. 附件存储**完全没有服务接口**，硬编码在 `plugin-wiki` 内部

- 实现：`packages/plugin-wiki/src/attachment-store.ts`（272 行，直接 `node:fs` 落盘 + sha256 寻址）
- 全仓 grep `provide('attach*` / `attachment-service` **零命中**

**后果**：想接 S3 / MinIO / WebDAV / 对象存储，只能 fork `plugin-wiki`。这是「万物插件」清单里明确缺失的一格，且 `docs/design/attachments.md` 已有 1451 行设计——**设计在，扩展点不在**。

#### B3. `editor` 插槽是**二等公民**：插件编辑器必然丢功能

`packages/web/src/pages/WikiPage.tsx:3148-3195` 显示：无插件贡献 `editor` 时，宿主用内置 `MarkdownEditorLazy`，它独有 **附件上传**（`:3179`）、**段落级权限标记**（`:3187` `blockTiers`）、**段落授权管理**（`:3192` `onManageBlockGrants`）、**选区回调**（`:3180`）。

而 `EditorSlotProps`（`packages/core/src/index.ts:952-970`）**没有**这些字段。`WikiPage.tsx:3154` 的注释确认：「这条路径**没有**工具栏/模式/段落权限控件」；`:3176` 确认「插件的编辑区接口**不含上传**」。

**后果**：注释里的「`editor` 是单占用替换位（插件编辑器与内置编辑器二选一）」在能力上**不成立**——换成插件编辑器意味着**静默丢失**附件与段落权限两个已发布功能。这是「插件优先」原则的实质违反。

#### B4. 授权能力闭合，且真源在**前端包**而非 `core`

`AuthCapabilities`（`packages/web/src/api.ts:712`）只有三个字段：`editContent` / `administer` / `manageVisibility`；导航判据是 `NavCapability = keyof AuthCapabilities`（`packages/web/src/lib/navPlan.ts:27`）。

`RouteAccess`（`packages/core/src/index.ts:565`）也只有 `'public' | 'user' | 'admin'` 三档。

**后果**：插件无法声明「我需要 `canAudit` 这个能力」，也无法为自己端点要求自定义权限——只能二选一：任意登录用户可调，或管理员可调。同时**能力真源在 web 包**，`core` 不认识它，插件作者引不到统一类型。

---

### 2.4 C 级阻碍 —— 可挂钩面太窄（插件「接不进去」）

#### C1. 全仓只有 **2 个**平台事件

```
packages/core/src/index.ts:461  CACHE_PURGE_EVENT = 'geewiki/cache-purge'
packages/core/src/index.ts:481  PAGE_SAVED_EVENT   = 'geewiki/page-saved'
```

使用方：`packages/plugin-ai-summary/src/index.ts:354`（订阅）、`packages/plugin-wiki/src/index.ts:1696`（广播）、`packages/manager/src/index.ts:1617`（广播）。

**缺失的钩子**（全部零命中）：`page.created` / `page.deleted` / `page.renamed`、`user.login` / `user.created`、`search.performed`、`attachment.uploaded`、`plugin.activated` / `plugin.deactivated`、`request.received`。

注意：cordis **已内置**事件总线（`ctx.on` / `ctx.emit` / `ctx.parallel` 已在用），能力是现成的，**只是没有把事件定义成公共契约**。这是投入产出比最高的一格。

#### C2. Markdown 渲染管线**无扩展点**

`packages/web/src/lib/markdownRender.ts` 导出的是固定函数（`decorateAttachmentMedia`、`buildBlockedAttachment`、`renderMarkdownBody`、`codeTextFromButton`），无 `registerRenderer` / directive / 自定义 block 机制。

**后果**：插件无法提供「mermaid 图 / 时序图 / 数学公式 / 自定义围栏 / 内嵌组件 / 第三方语法」。这类需求只能改宿主源码。

#### C3. 无 i18n、无主题插件化

- i18n：全仓无 `i18n` / `useTranslation` 体系，界面中文硬编码。**仍待办（F15）**。
- 主题：`packages/web/src/styles/tokens.css`（307 行）与 `styles.css` 已把样式收敛成 design token（79 处 `--gw*`/`:root`），**基础设施已在**，但没有「插件可注册主题」的入口。✅ **已解（F16，见 §0.5）**：`lib/pluginTheme.ts` 覆盖注册表 + 宿主 SDK `registerTheme`（SDK 0.8.0）。之所以能低成本接上，正是因为 `tokens.css` 的**两段式**设计 —— 语义 token 只指向 `--gw-*`，于是插件改原始值即可让深浅两套主题与全部工具类自动跟随。

对「团队内部 Wiki」这不算致命，对「最大自由度」是明显缺口——且两者都已有现成地基，接上成本低。

---

## 3. 风险与漏洞

### 3.1 安全

整体安全姿态**高于平均水平**：CSRF 三层闸门（`packages/plugin-auth/src/http.ts:93-134`，`Sec-Fetch-Site` + `Origin` + 自定义头 `x-gw-csrf`）、`SameSite=Lax`（`:64`）、登录失败限流（`packages/plugin-auth/src/index.ts:132`，429 + `login.rate_limited` 审计）、Markdown 消毒单点（`packages/web/src/lib/sanitize.ts`）、schemastery 刻意避开 `new Function`（`packages/manager/src/config-schema.ts:11`）、插件 UI 静态层四层防护 + 段比较 `isContained()` + `realpath`、外部插件 `realpathSync` 防穿越、看门狗熔断。以下是**仍存在的**问题：

| 级别 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| **中** | **路由访问等级默认 `public`**：`register()` 第 4 参可省，省略即匿名可调。53 个 `.register('...')` 调用点全靠作者自觉 | `packages/core/src/index.ts:567-570`（`access?`，注释「省略等价于 `{access:'public'}`」） | ① 启动时**全路由审计**：枚举注册表，未显式声明 `access` 的路由打印告警/拒绝激活（可加 `GEEWIKI_STRICT_ROUTE_ACCESS=1`）；② 长期把默认改为 `user`，`public` 必须显式写 |
| **中** | **插件进程内无隔离、无资源配额**：插件与宿主同进程、同权限，可任意读写文件系统 / 发网络请求 / 死循环 / OOM。一个坏插件能拖垮整站 | 设计自认「插件平台内的插件本就能执行任意代码」（`packages/core/src/index.ts:1159`）；~~`apply` 无超时保护（grep 零命中）~~ | ① ~~`apply` 加超时~~ ✅ **已做（F14）**：`runtime.applyTimeout` 缺省 30s + 晚到 fiber 回收；② 提供 worker/子进程隔离模式供不受信插件选用（**未做**）；③ ~~manifest 增 `permissions` 声明并在激活时提示~~ ✅ **已做（F10）**。⇒ **剩余风险已收缩为「同进程同权限」这一条架构前提**：超时与权限声明把「静默拖垮」和「不知情放权」两个问题各解决一半，但一个拿到 `fs:write` 的插件仍能改写宿主文件——那不是配置能解决的，只能靠进程边界 |
| **中** | **外部插件无签名 / 完整性校验**：`plugins/` 目录下任何代码即得以全权限运行 | `packages/manager/src/discovery.ts` 只做路径与清单校验 | 提供可选 `plugins.lock.json`（sha256 + 来源），严格模式拒绝未登记插件 |
| **低** | 普通配置字段在 `GET /api/plugins/:name/config` **明文返回**（密钥字段已妥善处理：`role:'secret'` + 0600 + 不回显） | `docs/plugin-platform-plan.md` L-20；`packages/manager/src/secrets.ts`（头部注释明确边界） | 已充分记档，属可接受的产品取舍；若未来接多租户再收紧 |
| **低** | `config/secrets.json` 明文（0600）。威胁模型 = 能读宿主文件系统者即可读密钥 | `packages/manager/src/secrets.ts:15-19` 自述 | 已有 `apiKeyEnv` 作为更强路径，保持即可 |
| **低** | React Flow `proOptions={{hideAttribution:true}}` 会在 console 打许可证提示 | `docs/plugin-platform-plan.md` L-7 | 合规动作，非漏洞；可评估替换图表库 |

**未发现**：SQL 注入（全仓走参数化 `run(sql, params)`）、路径穿越（静态层有 `realpath` + 段比较守卫）、XSS 注入点（`dangerouslySetInnerHTML` 全部由 `sanitize.ts` 单点供给）、原型污染（`sanitizeSchemaPayload()` 剥离 `callback`/`preserve`/`constructor`）、依赖漏洞（`pnpm audit` 干净）。

### 3.2 可靠性

| 级别 | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| **中** | **ESM 模块实例永不回收** → 后端插件改码**必须重启进程**；前端插件产物更新**必须整页刷新** | `packages/plugin-platform-plan.md` L-2 / L-4 / L-6；`packages/web/src/lib/pluginUi.ts:36-41` 记为「已知边界（决策，不是待办）」 | 开发迭代摩擦大；「热插拔」名不副实——只有**启停**是热的，**改码**不是 |
| **中** | **`provide` 时序陷阱**：插件 `apply` 未结算时 `provide` 的服务对其间创建的子插件**不可见**，`ctx.get` 返回 `undefined` 并**静默跳过** | `packages/core/src/index.ts:1147-1156`、`packages/manager/src/slot-plugin.ts` 文件头（含实测证据） | 极难排查的静默失效；也是当前 `slot` 必须做独立兄弟插件、顺序排 manager 之前的**根因** |
| **中** | **同一事实的注释互相矛盾**：core 说「slot 由管理器提供」，`slot-plugin.ts` 说「必须是独立插件」 | `docs/roadmap.md:67` 自认「**代码注释待清理**」 | 后来者会照错误注释改回去（core 注释里已写「归属曾经写错过，别再改回去」，说明**已经踩过一次**） |
| **低** | 看门狗熔断粒度为**整站**：连续失败 ≥3 且会话非空 → 清 session + `exit(1)` | `packages/manager/src/watchdog.ts`（59 行） | 单个会话插件的故障会触发全站重启。作为安全网可接受，但缺「只回滚该插件」的中间档 |
| **低** | 排空粒度是**全站在途请求**（非 owner 级） | `docs/plugin-platform-plan.md` L-1 | 卸载一个小插件要等全站请求结算，可能空转满 `drainTimeout` |
| **低** | 无「插件健康检查」钩子：插件只能靠抛错被动进入失败计数 | 全仓无 `healthCheck` | 依赖不可用（如 LLM provider 掉线）时插件无法主动降级上报 |

### 3.3 工程 / 流程风险

| 级别 | 问题 | 证据 |
| --- | --- | --- |
| **高（当下）** | **工作树有 201 项未提交改动，且 git 索引里残留一次已废弃的重命名**：索引暂存了 `packages/plugin-ai-assist/*` 与 `packages/plugin-ai-qa/*` 共 15 个文件，但**这两个目录在磁盘上不存在** | `git ls-files --stage \| grep -c plugin-ai-assist` → 15；`ls packages/plugin-ai-assist` → No such file or directory |
| **中** | `README.md` **224 KB / 1122 行，其中 26 行超 1000 字符** | `wc -c README.md`、`awk 'length>1000'` |
| **中** | 文档「修正块」层层叠加，同一段落后接 3–4 个「**修正（本批）**」，读者需自行判定哪句有效 | `grep -c 修正 docs/roadmap.md` → 8；`docs/roadmap.md:10` 单行内 6 次「修正」 |
| **低** | 仓库根有 92 KB 的垃圾目录 `undefined/data/`（因 `data/` 被 gitignore 而在 `git status` 中**不可见**，极易被忽略） | `du -sh undefined` → 92K；`git check-ignore undefined/` 无输出 |
| **低** | `tmp/` 占用 **2.0 GB**、`data/` 286 MB、`.pnpm-store` 220 MB、`.npm-cache` 201 MB | `du -sh` |
| **低** | `db-sqlite` 是默认数据库后端却**无单测**（无 `test` 脚本） | `pnpm test` 输出中不含该包 |
| **低** | **主 chunk 触发项目自设的"真实告警"**：`packages/web` 主包 **701.71 kB / gzip 221.72 kB**，而 `vite.config.ts` 的注释明确说删掉 `chunkSizeWarningLimit` 是为了「恢复 Vite 默认阈值作为**真实告警**（超过就是又一次依赖进错包）」—— 现在构建确实在报警。**与本次镜像单一真源化无关**（本次只净增约 1 kB 常量模块；且实测产物含 `account-identities` 却**不含** `geewiki/cache-purge`，证明 core 的 `index.ts`/`node:fs` 没被拖进浏览器）。需单独排查是哪条依赖没被拆出主包 | `pnpm --filter @geewiki/web build` 输出；`grep -c "geewiki/cache-purge" packages/web/dist/assets/index-*.js` → 0 |

---

## 4. 优化点（不改架构即可做）

1. ~~**消除插槽镜像**：把 `SLOT_NAMES` / `SlotName` 生成一份 `.d.ts` 或 JSON，由 `core` 产出、web 构建期消费。~~ **✅ 已做（见 §0.5「优化点 1」）**，且用了比"生成物"更干净的解法：**子路径导出**而非代码生成 —— 生成物需要"再生成一次"的纪律与守卫，子路径让两侧拿到的是**同一个对象**，漂移在构造上不可能。
2. ~~**清掉那 3 处矛盾注释**（`docs/roadmap.md:67` 自己已登记）。~~ **✅ 已做（见 §0.5「优化点 2」）**：真正还活着的矛盾只有 `packages/manager/src/slots.ts` 的文件头（core 侧那句早已改对）；roadmap 里那条「称 core 仍写错」的指控本身也过时了，一并更正。<br>**教训**：这类"文档说 A 处矛盾、实际矛盾在 B 处"的漂移，本身就是"同一事实多份表示"的又一次体现。
3. ~~**`README.md` 拆分**：主 README 压到 < 300 行，把架构/批次实录移到 `docs/`。~~ **✅ 已做，见 §0.5**：**1122 行 / 224 KB → 272 行 / 约 47 KB**；流水账迁 `docs/changelog/implementation-log.md`，测试台账迁 `docs/changelog/test-ledger.md`，PG 小节并入 `docs/deployment.md`。
4. ~~**文档改为「结论优先」**：每个决策块只保留「当前有效结论 + 一行理由」，「历史修正」移入 `docs/changelog/`。~~ **✅ 已做，见 §0.5**：新增 `docs/README.md`（「我想知道 X → 看哪一篇」索引 + 四条文档纪律）；顺带修正三处**过时读数**（1904→2105、内置插件 22→24、启用 18→21）与 `docs/deployment.md` 里称 `@geewiki/db-pg` 尚在路线图的说法。
5. **提交那个 201 项的重构**：先 `git reset` 清掉索引里废弃的 `plugin-ai-assist`/`plugin-ai-qa` 暂存条目，再按语义分 5–10 个 commit 落地。
6. ~~**删 `undefined/`，给 `tmp/` 加清理脚本**（已在 `.gitignore`，仅占磁盘）。~~ **✅ 已做（见 §0.5「优化点 6」）**：`undefined/` 首轮已删；本轮补 `pnpm run clean:tmp`（**默认 dry-run** + 四道安全闸门，含符号链接逃逸拒绝）。**顺带**发现并修复「`scripts/` 从未被类型检查」，首次检查即暴露 16 处既有错误。
7. ~~**`db-sqlite` 补单测**：它是默认后端，却零覆盖。~~ **✅ 已做（见 §0.5「优化点 7」）**：9 例 + `test` 脚本 + tsconfig 补 `include: ["test"]`。
8. ~~**给插槽各写一个 `SlotProps` 的 JSON Schema**~~ **✅ 已做，但形态与原建议不同（见 §0.5「优化点 8」）**：落地的是**自定义描述表** `SLOT_PROPS_SCHEMA` + 每项自带的 `contract` 锚点，不是 JSON Schema。原建议不可行的原因已在 §0.5 记明——**这些 props 里有回调，JSON Schema 表达不了函数类型**，硬套会得到"看起来标准、实际缺一半"的契约。落地时补了一条原建议没提但必需的东西：**源码级一致性守卫**（否则这份描述会在下次接口演进时静默过期，重复优化点 1 的老路）。

---

## 5. 可增加的功能点（按 ROI 排序）

### 第一梯队 —— 直接决定「万物插件」能否成立

| # | 功能 | 解决的问题 | 落点 |
| --- | --- | --- | --- |
| F1 | **动态插槽注册（插件自定义扩展点）** | A1 | 插槽名改为 `string` + 命名空间前缀（`<plugin>:<name>`），宿主保留内置 7 个为「已知插槽」，未知插槽由**贡献者自己**提供渲染出口 |
| F2 | **路由 / 导航 / 页面注册 API** | A2 | 宿主 SDK 加 `registerRoute({id, label, capability, component})`；`App.tsx` 的 `WIKI_ITEM`/`ADMIN_NAV` 改为「内置项 + 注册项」合并；插件页面走 `/plugins-ui/<name>/page.js` 懒加载 |
| F3 | **契约下沉**：把契约移入 `core` 的**浏览器安全子路径**（原方案是新建 `@geewiki/contracts` 包，已由实测替代 —— 见 §0.5「副产物 2」） | B1 | `AuthService` / `SearchService` / `WikiService` / `LlmService` 契约移出实现包 |
| F4 | ✅ **附件存储 provider 接口**（`attachment-service`，见 §0.5） | B2 | 契约已入 core，内置 fs 实现可被 `attachmentProvider:'none'` 关掉；新增 S3/WebDAV 插件**只剩写实现** |
| F5 | **补齐 `EditorSlotProps` 到内置编辑器同等能力**（上传、段落档位、选区） | B3 | 把 `onUploadFiles` / `blockTiers` / `onManageBlockGrants` / `selection` 纳入契约（全部可选，保持向后兼容） |
| F6 | **`react-dom` 与 portal 支持** | A3 | import map 增加 `react-dom`，宿主 SDK 暴露 `createPortal` |

### 第二梯队 —— 让插件「接得进、可观测、可治理」

| # | 功能 | 解决的问题 |
| --- | --- | --- |
| F7 | **平台事件契约化**：`page.created/deleted/renamed`、`user.login`、`search.performed`、`attachment.uploaded`、`plugin.activated/deactivated` | C1（总线已内置，只需定义契约） |
| F8 | ✅ **Markdown 渲染器注册表**（见 §0.5） | C2 | `markdownExt.ts` 注册表 + 独立 `Marked` 实例（可撤销）；宿主 SDK `registerMarkdownExtension` |
| F9 | ✅ **能力注册表**（见 §0.5） | B4 | 能力名已归一（内置 ∪ 插件 `a/b` 命名空间）；`capability-service` 注册求解器；`register(..., { capability })` 是第二层闸门 |
| F10 | ✅ **插件权限清单 + 激活时提示**（见 §0.5；**可选隔离模式未做**，已注明） | 安全（§3.1 中） |
| F11 | ✅ **全路由访问等级审计守卫**（见 §0.5） | 安全（§3.1 中） |
| F12 | ✅ **健康检查钩子** + 请求数归因（见 §0.5；**内存/CPU 归因与配额强制未做**，已注明） | §3.2 低 |
| F13 | ✅ **插件 UI 入口支持分层路径**（见 §0.5；`assets` 字段经论证**不需要**） | A4 |

### 第三梯队 —— 产品力增强

| # | 功能 |
| --- | --- |
| F14 | ~~**`apply` 超时保护**（防止插件卡死 boot）~~ ✅ **已落地，见 §0.5** |
| F15 | **i18n 体系**（宿主 + 插件共用一套 message catalog） |
| F16 | ~~**主题 / 品牌插件化**（`tokens.css` 已是现成地基，开放 token 覆盖 API 即可）~~ ✅ **已落地，见 §0.5**（未做：主题的清单声明路径、管理台编辑器） |
| F17 | ~~**插件市场 / 远程安装**~~ ✅ **核心已落地**（安装 + 完整性校验 + admin 端点），见 §0.5。**未做**：远端注册表与发布者签名 |
| F18 | **向量 / 语义检索**（roadmap L-17 已后置；建议先定 `EmbeddingProvider` 接口，让插件提供，避免宿主背重依赖）—— ✅ **接口 + 校验器 + 探针已落地，见 §0.5**；⚠️ **查询路径接线仍后置**（需先定向量存储与维度变更策略，与 L-17 同一决策） |
| F19 | ~~**PostgreSQL 适配**（roadmap L-9）~~ ✅ **已落地并完成真实 PG 端到端验证**，见 §0.5。双轨（`DatabaseAdapterAsync`/`asAsync`）与方言迁移目录**本已存在**，缺的是验证；真 PG 一次抓出 3 个真 bug |
| F20 | ~~**备份 / 恢复**（`data/` + `config/` 的一致性快照）~~ ✅ **已落地，见 §0.5**。形态：备份 = **服务端能力**（`POST /api/backup`，admin）+ CLI `pnpm run backup`；恢复 = **只能走 CLI**（`pnpm run restore`） |
| F21 | ~~**插件模板脚手架**（`pnpm create geewiki-plugin`，当前靠照抄 `plugins/hello-geewiki/`）~~ ✅ **已落地，见 §0.5**。形态与原建议略有不同：落地为**仓库内 CLI** `pnpm run new:plugin`（外部插件本就住在 `<仓库根>/plugins/`，作者不必装一个可发布包）。若将来出现仓库外的第三方作者，再把同一份纯函数包成 `create-geewiki-plugin` 即可 |

---

## 6. 建议演进路线

### 阶段一：先让「格子」可以自己长出来（不破兼容）

1. **F1 动态插槽**（最高优先）：`SlotName` 从联合类型放宽为 `BuiltinSlotName | (string & {})`，内置 7 个保持类型安全，未知名不再拒绝而是登记为「插件自定义插槽」，由贡献者自己在宿主提供的通用出口渲染。
2. **F2 路由/导航注册**：`App.tsx` 的三处数组改为「内置 + 注册项」合并，让插件第一次拥有自己的 URL。
3. **F6 react-dom / portal**。
4. 同步**消除镜像**（优化点 1）——F1 之后镜像数量会从 4 处继续膨胀，必须先治。

### 阶段二：让「万物」真的可替换

5. ~~**F3 契约下沉** + **F4 附件 provider** + **F5 编辑器等价契约**。~~ **✅ 三项均已完成**（F3/F4/F5，见 §0.5）。F3 的执行方式经实测修正为「搬进 core 已有模块」，不是新建 `@geewiki/contracts` 包（见 §0.5「副产物 2」）。
6. ~~**F9 能力注册表**：把 `AuthCapabilities` 从 `web` 移到 `core` 并允许注册。~~ **✅ 已完成**（见 §0.5）。
7. ~~**F7 事件契约化** + **F8 Markdown 注册表**。~~ **✅ 两项均已完成**（F7 见 §0.5，F8 见 §0.5）。

### 阶段三：让插件「可靠」

8. ~~**F10 权限清单**~~ ✅ + ~~**F11 路由审计**~~ ✅ + **F12 健康检查** ✅（配额强制未做）+ ~~**F14 apply 超时**~~ ✅ **已完成（见 §0.5）**。
9. **F13 资源根**。
10. 解决 ESM 不回收：至少给外部插件一条**显式重启 / 重建 fiber** 的受控路径，让「改码生效」不必靠整进程重启。

### 阶段四：产品力

11. ~~**F15–F21 择机**~~ → 进度：**F14/F16/F18（接口）/F20/F21 已完成**；**无剩余功能项**：F1–F21 全部落地（`F18` 的查询路径接线与 `F10` 的隔离模式为**有意后置**，见各自 §0.5 小节）。`F19` 已于本轮落地（见 §0.5），故 `L-9` 里「PG 适配延期」这条**应当更新**。§4 优化点 **1/2/3/4/6/7/8 均已完成**；优化点 **5**（提交那 200+ 项重构）**刻意未做** —— 它会改动仓库历史，应由人确认后执行。

---

## 7. 附录：本次审计的核对命令

```bash
pnpm run typecheck          # → 27 projects Done, 0 error TS, exit 0
pnpm run test               # → 1904 tests / 24 packages / 0 fail, exit 0
pnpm audit --audit-level=high   # → No known vulnerabilities found
grep -rn "SLOT_NAMES" packages/*/src            # → 4 处镜像
grep -rn "registerRoute\|registerNav" packages/*/src   # → 仅 manager 内部 registerRoutes（非插件 API）
grep -rhn "ctx.provide(" packages/*/src        # → 13 个服务；无 attachment-service
grep -rn "_EVENT =" packages/core/src          # → 仅 2 个平台事件
git ls-files --stage | grep -c "plugin-ai-assist\|plugin-ai-qa"   # → 15（磁盘上不存在）
```

**一句话建议**：先做 **F1 + F2**。这两项之后，「万物插件」才第一次在**架构上**成立——在此之前，无论再写多少插件，它们都只能活在宿主预先挖好的那 7 个坑里。
