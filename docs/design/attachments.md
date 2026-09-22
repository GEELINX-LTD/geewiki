# GeeWiki 附件上传能力 —— 设计构想

> **状态**：附件能力的**设计基线 + 与实现一致的现状说明**。代码已落地（**未提交**），本文 §2–§9、§11 描述**当前实现**；仍未做的项见 **§10.0** 的状态总览。
> **读者**：项目所有者（非权限系统专家）+ 实现者 + 评审者。专业术语首次出现时用一句白话解释。
> **行号时效（必读）**：本文所有 `路径:行号` 均为**书写时的快照**，实现此后已前移（例如上传端点标注 `:3124`，实际已在 `:4397` 附近）。**定位一律以符号名为准**（如 `createHash('sha256')`、`MIME_BY_EXT`、`ATTACHMENT_EXT_WHITELIST`、`WikiConfigSchema`），**不要把行号当判据**；标「已核实」也不代表行号仍然对得上。
> **素材来源**：① 对仓库当前源码的逐处核对（本文所有标 **「已核实」** 的条目都带 `路径:行号`，可直接 grep 复核）；② `docs/design/access-control.md`（已定稿）确立的权限模型与块级模型，以及 `docs/development.md`（**工程约定与教训的唯一真源**：沙箱、迁移、PG 方言、验收纪律等）；③ 仓库既有文档（`README.md`、`docs/deployment.md`、`docs/architecture.md`）。
> **标注约定（本文严格三分，不要混读）**：
> - **「已核实」** = 我**实际读过**这段源码 / 跑过这条命令，结论就是该处代码的字面行为；
> - **「设计决策」** = 本文拍板、实现按此执行（**不是现状**）；
> - **「未决」** = 实现前必须确认（见 §10，每条给候选方案与取舍）。
> 三者之外的句子都是推论，**不要把推论当成事实**。
> **术语沿用既有用语**：档位 / 继承取最窄 / 受限段落 / 块级 tier / 只做空间回收 / 失败关闭 / 唯一真源 / 投影 / 404 vs 403 / principal（主体）。见 §1。

---

## 0. 一句话定位

给一个**已经完成"身份 → 组织 → 条目级可见性 → 内容块级可见性"主干**的 wiki，补上"图片与通用附件"这条**支线**：文件落磁盘（不进数据库 BLOB）、下载复用既有的页面 ACL 与块级 tier 判定、**不新增依赖**、且**不成为新的泄露面**。

### 0.1 现状摘要：附件能力今天为零（五处「已核实」事实）

| # | 事实 | 位置 | 为什么它决定了设计 |
|---|---|---|---|
| 1 | **全文检索 multipart/FormData 的解析代码为零** | `grep -rn "multipart\|FormData\|busboy" --include=*.ts --include=*.tsx packages/ plugins/` ⇒ **0 命中**（2025-09 实测，仓库根下） | 上传体的形态（原始字节 / base64-JSON / 引入 multipart 解析器）是**本设计的第一决策**，见 §4.2 与 U1 |
| 2 | 请求体读取是**手写**的，且只支持 JSON | `packages/plugin-wiki/src/index.ts:390` `function readBody(h: RouteHandlerContext, limit = 1_000_000): Promise<unknown>`，`end` 时 `JSON.parse`（`:412`） | 二进制上传**不能**复用 `readBody`（它会把二进制当 UTF-8 丢给 `JSON.parse`） |
| 3 | 正文有硬上限，1MB 的请求体上限是**默认值而非约定** | `packages/plugin-wiki/src/index.ts:495` `if (body.length > 500_000) throw new Error('content_too_large: 正文过长（≤500KB）')`；`readBody` 默认 `1_000_000`；版本快照 `MAX_SNAPSHOT_BYTES = 1_000_000`（`:1352`） | 附件**必须走独立通道**：塞进 JSON 会同时撞上 1MB body 上限与 base64 的 +33% |
| 4 | 静态资源层**完全不经鉴权** | `packages/core/src/index.ts:624-627`（`RequestHook` 契约第 6 条：钩子**只对匹配到的路由执行**；静态资源与 SPA fallback「**完全不经钩子**」）；`packages/server/src/index.ts:969` `serveStatic()` | 附件**绝不能**放到 `webDist` 之类的静态根下，否则任何人可直取文件（§4.7） |
| 5 | 仓库**从不设** `X-Content-Type-Options: nosniff` | `grep -rn "nosniff\|X-Content-Type" packages/*/src` ⇒ **0 命中**（唯一的安全响应头是 `plugin-auth` 的 `set-cookie`） | 附件下载会是**第一个**需要按内容类型做安全头的地方；这既是新工作，也无既有先例可抄（§4.6） |
| 6 | **实现已完成（未提交）**：三个纯层文件 + 端点/表/迁移/测试 | `packages/plugin-wiki/src/attachments.ts`（纯函数层）、`packages/plugin-wiki/src/attachment-store.ts`（流式落盘层）、`packages/web/src/lib/attachmentPlan.ts`（前端纯逻辑层）；`packages/plugin-wiki/src/index.ts` 配置 schema + `attachments` 表写入事务 + **四个端点**（上传 `:3124`、下载 `:3328`、列表 `:3474`、删除 `:3537`，行号仍可能随收尾变动）；`packages/db-sqlite/src/migrations/0018_attachments.sql` 与 `packages/db-postgres/migrations/0018_attachments.sql`（成对）| `git status`；`grep -n "router.register('GET', '/api/attachments/:id'" packages/plugin-wiki/src/index.ts`。**测试（我实跑）**：`node --import tsx --test packages/plugin-wiki/test/attachments.test.ts` ⇒ **16 pass / 0 fail**；`... packages/web/test/attachmentUploadPlan.test.ts` ⇒ **19 pass / 0 fail**；e2e 脚本 `packages/plugin-wiki/test/e2e-attachments.sh`（含 `cmp` 级比对与标定用例 D8a）**我未运行** | ⇒ §2–§9、§11 与实现一致；**仍需跟进的是「未做项」**（GC/全库配额/Range/限流/超时/管理 UI 等，见 §10.0）|

补充两条同样「已核实」的约束：

- **HTTP 层没有请求体超时**：`packages/server/src/index.ts` 里唯一的 `setTimeout` 是排空定时器（`:501`），**没有** `server.headersTimeout` / `requestTimeout` / `req.setTimeout`。⇒ 慢速上传的防线必须由附件实现自己建（§5.4）。
- **写路径的地基是 `checkCsrf`**：`packages/plugin-auth/src/http.ts:108-145` `checkCsrf(req, hasSessionCookie)`（三道判据：`Sec-Fetch-Site` / `Origin` / 自定义头 `x-gw-csrf: 1`，见 `:20` `CSRF_HEADER`），由 `packages/plugin-auth/src/index.ts:716-718` 注册为前置钩子，顺序是**先 CSRF 后会话**。⇒ 上传是状态变更方法，**天然经这道闸门**（因为它走 `router.register`，是"匹配到的路由"）。

### 0.2 目标（按优先级）

| # | 目标 |
|---|---|
| **G1** | **可用**：作者能在编辑器里插入图片与通用附件，读者能在正文里看到 / 下载到 |
| **G2** | **不泄露**：受限段落里的附件，对看不到该段落的主体**不可下载**，且**不泄露"这里有个你看不到的文件"** |
| **G3** | **单一真源**：下载判定**复用** `policy-service`（`resolvePage` / `grantedBlockIds`）与 `packages/plugin-wiki/src/blocks.ts` 的 `blockLevelOf`，**绝不新写第二套判定** |
| **G4** | **零新增依赖**：上传体的解析不引入新包（见 §4.2 与 U1） |
| **G5** | **空间可回收**：孤儿附件**可发现**，且回收是显式运维动作 —— 与"**只做空间回收，不自动删数据**"（§8.4）一致 |
| **G6** | **可测**：判定逻辑是纯函数、可单测；越权下载有 e2e 负向断言（§9） |

### 0.3 非目标（本期明确不做）

| # | 不做 | 备注 |
|---|---|---|
| **N1** | **协作编辑**（多人同时编辑正文 / 附件） | 与既有 wiki 一致：保存是 last-write-wins，无乐观锁（见 `access-control.md` §0.1 对 `savePage` 的说明） |
| **N2** | **对象存储**（S3 / MinIO / OSS） | 明确选了**磁盘**；位置在 `GEEWIKI_DATA_DIR` 之下（§2） |
| **N3** | **附件内容的全文检索** | 只检索**文件名**（可选）与**正文里的引用**；不解析 PDF/Office 正文，不建 FTS 索引 |
| **N4** | **附件版本化** | 覆盖 = 上传一份**新**附件（内容寻址 ⇒ 新 sha256 ⇒ 新文件），旧附件按孤儿回收；**不**进 `page_versions` 快照（U7） |
| **N5** | **图片处理**（缩略图 / 压缩 / 转码 / EXIF 清洗） | 不做任何图像处理；⇒ 上传者相机里的 GPS 会随原图保留（§5.12 残余风险） |
| **N6** | **病毒扫描 / 内容魔数校验** | 本期不做（U4：若做，需自带魔数表，约 30 行常量，仍零依赖） |
| **N7** | **音视频与大文件分发** | 不做 Range / 断点续传 / 转码；**单文件默认不限**（2026-09-21，原默认 25 MiB，§6） |
| **N8** | **公开门户（`/portal`）的附件直链** | 门户是服务端匿名渲染；附件 URL 在匿名可见的页面上自然可用，**但不额外**为门户做 CDN / 签名直链 |
| **N9** | **附件级 ACL（逐个文件授权）** | 附件的可见性**完全继承**"页面档位 + 引用它的块档位"；不新造 `attachment_grants` 表 |

### 0.4 本文与既有文档的关系

| 既有文档 | 关系 |
|---|---|
| `docs/design/access-control.md` | **权限模型的唯一真源**。本文 §4.3 的判定算法是它的**消费方**：页面档位走 §2.3 的继承与冲突裁决，块级走 §2.2 的三档（`public` / `org` / `granted`）与 §4.6 的跨阶段不变量 |
| `docs/development.md` | **工程约束的唯一真源**（沙箱、迁移、PG 方言、验证基线、验收纪律等）。本文的实现交付必须遵守其**全部**条目 |
| `docs/deployment.md` §5 | 备份与持久化的既有承诺；附件目录必须被纳入（§2.6） |

---

## 1. 术语表（先看这个，后面不再解释）

| 术语 | 白话解释 |
|---|---|
| **附件（attachment）** | 一条**元数据行**：它描述"某个物理文件被挂在某一页上"。URL 里用的是它的标识（本文建议不可枚举的 `public_id`（§3.1）；**M1 实际用自增整数 `id`** —— 差异见 §4.2 与 U19） |
| **物理文件 / blob** | `data/attachments/` 下的一个文件，名字就是内容的 sha256（§2.2）。**同一份字节全局只有一份** |
| **内容寻址（content-addressed）** | 文件的"名字"由内容算出来，不由用户决定。于是同一份文件天然去重、且**永不改变**（改了内容就是另一个名字） |
| **引用点（ref）** | "正文里某一**块**写了这个附件的 URL"。引用点是**正文的派生物**，与 `page_links` 同款；**判定时由正文投影直接得出**（§4.3.1） |
| **档位** | 沿用既有用语：页面级 `private` / `org` / `public`；块级 `public` / `org` / `granted`（`access-control.md` §2.2） |
| **继承取最窄** | 子条目默认跟随父条目；**只有收紧向下继承，放宽不继承**（`access-control.md` §2.3）。本文里附件还要在此基础上再叠一层"块只更窄" |
| **块级 tier** | `blocks.tier` 这一列：`0`=匿名可见、`1`=组织内可见、`NULL`=不属于任何读者等级（只能靠授权分支命中）。**刻度方向是"限制等级"：越小越公开** |
| **受限段落** | 正文里被 `<!--gated:org-->` … `<!--/gated-->` 圈起来的区段；读者看不到时，服务端把它替换成**显式占位**而不是遮罩 |
| **失败关闭（fail-closed）** | 任何"拿不准"的情形一律按**拒绝**处理（少给，不多给） |
| **404 vs 403** | 404 = "这东西不存在"；403 = "存在，但你没权限"。本设计对**读路径**一律 404（不泄露存在性），与 `access-control.md` §2.3 一致 |
| **只做空间回收** | 既有运维哲学：显式清理动作**只回收磁盘**，从不承担"让某个东西失效"的语义（失效在判定时就已发生）。出处：`packages/plugin-authz/src/index.ts:865-881`、`packages/plugin-org/src/index.ts:928-949` |
| **孤儿附件（orphan）** | 物理文件还在磁盘上、但**没有任何元数据行**指向它，或元数据行已不指向任何页面（§8.1） |

---

## 2. 存储布局

### 2.1 为什么是磁盘而不是数据库 BLOB（「设计决策」D1）

**决策**：物理文件落在文件系统，数据库只存元数据。

**理由**：

1. **既有数据目录已经是"运行时文件"的家**（`data/geewiki.db`、`data/crash.marker`，见 `README.md:66` 与 `packages/db-sqlite/src/index.ts:151-155` 的注释），附件目录放进去不引入新的运维概念；
2. **SQLite 的 BLOB 会把库文件撑大**，而库文件是所有备份/冷备的**原子单位**（`docs/deployment.md:202` 的冷备是 `cp -a data config`）：把 100 MiB 图片塞进 `geewiki.db` 会让每次备份都拖上这些字节；
3. **大 body 会占住 SQL 连接**：往 SQLite 写 10 MiB BLOB 是**单写者**（better-sqlite3 是同步驱动）——一次上传就阻塞全站写；文件系统则没有这个问题；
4. **PG 侧同样成立**：`bytea` 会带来 WAL 膨胀与 `pg_dump` 体积暴涨。

**代价（诚实列出）**：数据库与文件**不再是一个原子单位** —— 崩溃可能留下"有行无文件"或"有文件无行"。§2.5 与 §8 处理这两种不一致。

### 2.2 目录结构（「设计决策」D2）

```
$GEEWIKI_DATA_DIR/            # 默认 ./data（packages/core/src/index.ts:373 的 DEFAULT_DATA_DIR）
├── geewiki.db                # 既有：SQLite 库（packages/core/src/index.ts:376 DEFAULT_DB_FILENAME）
├── geewiki.db-wal / -shm     # 既有：WAL 模式附带文件（docs/deployment.md:175）
├── crash.marker              # 既有：崩溃自愈标记（docs/deployment.md:176）
└── attachments/              # 本能力新增（唯一新增的顶层项）
    ├── <sha256[0:2]>/<sha256[2:4]>/<sha256><ext>   # 正式对象，两级分片（见下）
    ├── tmp/                                        # 上传中的临时文件（必须同文件系统，见下）
    └── .quarantine/                                # 可选：行已删、物理文件待回收（§8.2）
```

**两级分片（`aa/bb/<sha256><ext>`）的理由**：单目录放十万个文件时，`readdir` 与许多文件系统（含 ext4 的 htree、overlayfs）都会退化。两级各取 2 个十六进制字符 ⇒ 每级最多 256 个目录、最坏 65536 个叶子目录，均匀且不会出现"某一级过热"。（**「设计决策」**；备选是单层 `aa/` 或不分片，取舍见 U10。）

**`tmp/` 必须与正式对象同文件系统**：上传完成后用 `rename()` **原子**落到正式路径。跨越文件系统的 `rename` 会 `EXDEV` 失败；因此**不要**把 `tmp/` 放到 `/tmp`（容器的 `/tmp` 常是 tmpfs，是本沙箱里的一条既有教训；工程约定见 `docs/development.md`「环境、沙箱与运行约束」："`/tmp` 在本沙箱跨 bash 调用不保留"）。

**扩展名来自白名单、写在文件名尾部**，但**物理身份是 sha256 前缀部分** —— 扩展名只服务于两件事：① 让运维 `ls` 时能认出类型；② 让 `content-type` 有**单一真源**（§4.6）。**同一份字节不可能有两种扩展名**：扩展名由"服务端从内容推导的白名单类型"决定（§4.2 的 `kind`），不是由用户文件名决定。

### 2.3 文件名策略（「设计决策」D3）：内容哈希 + 白名单扩展名，**禁止**用用户文件名做路径

**规则（三条，缺一不可）**：

1. **物理路径的每一个字节都由服务端算出**：`join(root, sha256.slice(0,2), sha256.slice(2,4), sha256 + ext)`。其中 `sha256` 是**服务端对收到的字节流算的**（`node:crypto` 的 `createHash('sha256')`——零依赖），`ext` 只能取自**代码里的白名单常量**（§6.2）。
2. **用户提供的 `filename` 永不参与路径**，只作为 `original_name` 落库、**仅供展示**（列表与下载时的显示名）。落库前必须：去控制字符（`\x00-\x1f\x7f`）、去路径分隔符（`/`、`\`）、截断到 200 字符、为空则回退 `${sha256前8位}${ext}`。
3. **写盘前做词法 + 真实路径双重包含校验**（可直接复用既有实现）：`packages/server/src/index.ts:959-963` 的

   ```ts
   function isContained(parent: string, child: string): boolean {
     const rel = relative(parent, child)
     return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
   }
   ```

   **刻意不用 `startsWith`**（该处注释写明理由：前缀字符串比较会让 `/a/b-evil` 通过 `/a/b` 的检查）。再对 `realpath` 结果复核一次以挡住**符号链接逃逸** —— 这两层正是 `packages/server/src/index.ts:852-862` 给插件 UI 资产写的"四层安全模型"的第 3、4 层，**同一套判据不要写第二遍**（建议提取为 `packages/core` 的共享工具，见 U11）。

**为什么这条是硬规则**：用户文件名是**不可信输入直接拼路径**的经典入口（`../../etc/passwd`、`..%2f`、绝对路径、`NUL`、超长名、Windows 保留名）。内容寻址把这整类问题**从设计上消掉**：路径里不存在任何用户可控字节。

### 2.4 幂等去重与"物理共享 / 逻辑隔离"（「设计决策」D4）

- **物理层**：内容相同 ⇒ sha256 相同 ⇒ 路径相同 ⇒ **天然去重**。第二次上传同一份字节**不写第二个文件**（`rename` 到已存在的目标路径在 POSIX 下是幂等覆盖；实现上更稳的是先 `stat` 目标、存在即跳过写入直接删 `tmp`）。
- **逻辑层**：**每一页有自己的元数据行**。同一张图被 A 页与 B 页分别上传 ⇒ 两行 `attachments`（同一 `sha256`，不同 `page_id`），URL 不同（各自的 `id`），**可见性各自独立判定**。
- **删除语义**：删一行**只删行**；只有当"同一 `sha256` 的**最后一行**"被删（或行已进入回收态）时，物理文件才进入 `.quarantine/`（§8.2）。⇒ **磁盘不会因为一次误删而丢掉别页在用的图**。

**为什么不做"引用计数列"**：`refcount` 是**第二个真源**，任何一次漏减/漏加都会让文件永久留着或提前消失；而 `SELECT COUNT(*) FROM attachments WHERE sha256 = ?` 是**必然正确**的（代价是一次索引查询，`idx_attachments_sha` 覆盖）。这与仓库既有口味一致：能算出来的东西不物化（对比 `blocks.tier` 是**必须**物化的例外，因为它要进 FTS 检索 —— `packages/db-sqlite/src/migrations/0015_blocks.sql:60-70` 有完整论证）。

### 2.5 与 `data/` 下既有文件的关系（「已核实」+「设计决策」）

| 既有项 | 关系 |
|---|---|
| `geewiki.db` / `-wal` / `-shm` | **互不引用**：附件目录不放在库文件的任何路径语义里；`crash.marker` 机制不受影响 |
| `crash.marker` | 崩溃自愈**不清理** `attachments/`（它是数据，不是缓存）。⇒ 崩溃后可能留下 `tmp/` 里的半截文件，由 §8.1 的清扫步骤处理 |
| `data/spike/**` | 是历史探测脚本的落地目录（**「已核实」**：存在 `data/spike/review2/*.ts`），与附件无关；**注意** `data/` 整体在 `.gitignore` 里（**「已核实」**：`.gitignore` 的 `data/`），因此附件目录**默认不入库**，无需改 `.gitignore` |
| 插件 UI 产物目录（`packages/web/public/plugins-ui/`、各插件 `dist/`） | **完全无关，且必须保持无关**：那是**可执行前端资产**的托管路径（`packages/server/src/index.ts:849-870`），把附件放进去等于给出一个无鉴权的直链（§4.7） |

### 2.6 备份与迁移注意点（「设计决策」D5）

1. **冷备必须同时覆盖两者**：`docs/deployment.md:202` 的既有冷备是 `docker compose stop && cp -a data config /path/to/backup/`。`attachments/` 在 `data/` 之下 ⇒ **现有命令自动覆盖**（这是把它放在 `data/` 而非别处的直接好处）。文档需在 `docs/deployment.md` §5 的表里补一行 `./data/attachments/`（**这是实现交付项之一**）。
2. **热备会出现"库与文件不一致的窗口"**：`docs/deployment.md:181-200` 的热备走 SQLite backup API，**只备库**。⇒ 热备份恢复后可能出现"有行无文件"。**决策**：不为此实现两阶段提交，而是把不一致**做成可观测信号**（§8.1 的 `missing_file` 计数），并在文档里明确：**要保证一致就使用冷备**。
3. **迁移（换机器 / 换 `GEEWIKI_DATA_DIR`）**：附件用**绝对路径**（`resolveProjectPath` 的语义：相对路径以**仓库根**为基准，`packages/core/src/index.ts` 的 `resolveProjectPath`），因此换目录时必须**整体搬 `data/`**，不能只搬库文件。⇒ 在启动时做一次**存在性自检**（目录不存在就 `mkdir -p`；只读或 `EACCES` 时**不静默**，见 §5.10）。
4. **PG 部署**：`GEEWIKI_DATA_DIR` 在 PG 模式下**仍然只有一个**（`packages/db-sqlite/src/index.ts:154` 是 SQLite 侧的实现，PG 侧不读它建库），所以附件目录在 PG 部署下**不随库走**。⇒ 两种方言下附件与数据的关系**不同**，这是**必须在部署文档里写清**的一条（也是 U8 的一部分）。

---

## 3. 数据模型

### 3.0 迁移约定（动手前必须先读，全部「已核实」）

1. **双方言成对**：宿主表由 `packages/db-sqlite/src/migrations/` 与 `packages/db-postgres/migrations/` **两侧成对**建立（编号对齐，`0010`–`0017` 皆如此）。
2. **`@geewiki/wiki` 自带一个"单目录、双方言共用"的迁移目录**：`packages/plugin-wiki/src/index.ts:112` `export const WIKI_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')`，由 `apply()` **自己**执行：`:562` `await adb.migrate(WIKI_MIGRATIONS_DIR)`（理由写在 `:104-110`：manifest 的 `migrations` 字段对内置插件走注册表路径、历史上曾漏配 ⇒ 自己应用同样安全，`_migrations` 表天然幂等）。该目录现有 `0001_page_links.sql`、`0002_page_versions_page_id_index.sql`。
   **该目录里的 SQL 必须双方言都能跑**（因为它不分方言）。`0002` 就是范例：一条 `CREATE INDEX IF NOT EXISTS`，并在头注释里写清"**实测该索引已存在**（`packages/db-sqlite/src/migrations/0001_init.sql:21` / `packages/db-postgres/migrations/0001_init.sql:37`），本文件是幂等空操作"，以及"**不写 `BEGIN`/`COMMIT`**（`db.migrate()` 已把每个文件包在事务里，脚本内再开事务会嵌套报错）"。
3. **反过来，注册表路径的声明是"只声明了 sqlite"**：`packages/server/src/index.ts:1405` `migrationsDirs: builtinMigrations(wikiManifest as GeeWikiManifest, { sqlite: WIKI_MIGRATIONS_DIR })`。历史教训（`packages/db-sqlite/src/migrations/0015_blocks.sql:8-14` 的头注释）：**照 `access-control.md` §3.6 把 `blocks` 写进 `plugin-wiki/migrations/` 会让 PG 部署下这张表根本不被建出来** ⇒ 最终落在 db 包、两侧成对。**⇒ 本设计选落点时必须显式回答"PG 上会不会被建出来"。**
4. **守卫测试会强制这件事**：`packages/server/test/builtin-migrations.test.ts` 的判据 A/B/C/D —— 其中 `MANIFEST_MIGRATION_FALLBACKS = { '@geewiki/postgres': ['postgres'], '@geewiki/wiki': ['sqlite'] }`（`:44-48`），且判据 C 要求"manifest 补上声明后必须把回退项删掉"，判据 A 还要求"注册表里至少覆盖 4 个迁移目录"（`:104-110`）。
5. **幂等与重放的硬约束**：SQLite **没有** `ADD COLUMN IF NOT EXISTS` ⇒ 给既有表加列的迁移**无法重放**（工程约定见 `docs/development.md`「数据库与迁移约定」，守卫测试已钉死，**不要放宽**）；新表用 `CREATE TABLE IF NOT EXISTS` 则安全。**并且**：既有守卫测试用**文本启发**（如 `/\bADD\s+COLUMN\b/i`）判断可重放 ⇒ **注释里写这几个词会被误判**（工程约定见 `docs/development.md`「数据库与迁移约定」）。
6. **两条方言差异**：PG 的 `COUNT(*)` 返回**字符串**（必须 `Number()` 强转，工程约定见 `docs/development.md`「PostgreSQL 方言差异」）；PG 下 `RETURNING id` 是插入自增主键的**唯一**可行方式（缺它 PG 报 `violates foreign key constraint`，工程约定见 `docs/development.md`「PostgreSQL 方言差异」）。

### 3.1 附件元数据表 `attachments`（「设计决策」D6）

**实际落地的表结构（下述为真源）**

出处：`packages/db-sqlite/src/migrations/0018_attachments.sql:30-46`（PG 版 `packages/db-postgres/migrations/0018_attachments.sql`，逐条对照，差异只有自增主键写法与部分索引语法）：

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 外键到 pages(id)：删页时元数据随 CASCADE 一起走，不留孤儿行
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- 冗余的人类可读列（审计/排障）。**不参与任何判定** —— 判定用 pages.slug 现值联查。
  page_slug     TEXT    NOT NULL,
  -- 内容哈希：落盘路径的一半，也是幂等去重的唯一键
  sha256        TEXT    NOT NULL,
  -- 已过白名单的扩展名（含前导点、小写）：落盘路径的另一半，并决定响应头
  ext           TEXT    NOT NULL,
  byte_size     INTEGER NOT NULL,
  -- 由扩展名推出的 MIME（**不信任上传时的 Content-Type 声明**）
  mime          TEXT    NOT NULL,
  -- 原始文件名：**只用于展示**（Content-Disposition），从不参与路径拼接
  original_name TEXT    NOT NULL,
  uploader_id   INTEGER,          -- 老数据/系统导入可能为 NULL ⇒ 可空
  created_at    TEXT    NOT NULL,
  UNIQUE (page_id, sha256)        -- 同页同内容只一行（并发下的最后一道）
);
CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments(page_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha  ON attachments(sha256);
```

**与本文初稿的差异（逐条，全部以实现为准）**：

| 项 | 本文初稿 | **实际落地（真源）** | 为什么 |
|---|---|---|---|
| 对外标识 | `public_id TEXT NOT NULL UNIQUE`（不可枚举） | **只有自增 `id`**（URL 里就是它） | 见 §4.2 的分歧与 **U19**（严重度中低；**若将来要加 `public_id`，现在是最低成本时点**） |
| 归属列 | `page_id` + `page_slug`（可空） | 同两列，但 **`page_id NOT NULL` + `page_slug NOT NULL`** | 附件**必属于一页**；无"未挂载"状态 |
| 块级关系 | `block_id` + `last_gate` | **都没有** | **U22 决议**：判定改为"重跑投影"，不需要把块关系物化（见 U22） |
| 体积列名 | `bytes` | **`byte_size`** | 实现命名（配额求和 SQL 里用的就是它：`SELECT COALESCE(SUM(byte_size), 0) …`，`packages/plugin-wiki/src/index.ts:3074`、`:3197`） |
| 上传者外键 | `REFERENCES users(id) ON DELETE SET NULL` | **无外键、可空 `uploader_id`** | 与仓内其它可空 actor 列同风格；审计留痕在 `audit_log` |
| 删页语义 | `ON DELETE SET NULL`（保留行、成为可发现孤儿） | **`ON DELETE CASCADE`**（行随页走） | 迁移头注 `:13-15` 的明确理由：外键指向 `id` 而非 slug ⇒ 级联天然正确、**不需要"改 slug 时同步改引用"**，也**不留孤儿行**；"磁盘上有文件而库里没有行"由 **GC 判据**处理（§8.1），"库里有行而文件不在"由下载的 `blob_missing` 报出 |
| 软删 | `deleted_at`（软删、判定视同不存在） | **没有软删列** | `DELETE` 直接删元数据行（§4.5），物理文件留给 GC |
| 去重约束 | 靠应用层 | **`UNIQUE (page_id, sha256)`** | 迁移头注 `:20-24`：应用层"先查后插"在竞态下可能双双通过，**唯一约束是并发下的最后一道**；刻意**不是** `UNIQUE(sha256)`（不同页可共享同一份字节、元数据各记一行） |

**落点（已落地）**：见 §3.5。

**引用判定路线（引用表与快照列均不采用）**：不建 `attachment_refs` 表、不存 `last_gate` 快照列。判定与渲染共用唯一真源 `projectBlocks` —— **下载时重跑一次正文投影**，判据是"投影后的正文里是否含该附件 URL"（`projectPageContentFor`，`packages/plugin-wiki/src/blocks.ts:840`；调用点 `packages/plugin-wiki/src/index.ts:3447`）。因此"引用消失 / 块被删 ⇒ URL 不在投影里 ⇒ 404"（失败关闭，比"保住最窄档"更严），也不存在"引用表与正文不同步"的窗口。代价：每次下载多一次块查询 + 一次投影，且**不做投影缓存**（§4.3.1）。详见 U22。

### 3.4 外键与删页语义

**实际采用 `ON DELETE CASCADE`**（`packages/db-sqlite/src/migrations/0018_attachments.sql:13-15` 的头注）：

| 关系 | **实际落地** | 理由 |
|---|---|---|
| `attachments.page_id → pages(id)` | **`NOT NULL` + `ON DELETE CASCADE`** | 外键指向 **`id` 而不是 slug** ⇒ 级联天然正确，**不需要"改 slug 时同步改引用"**这类额外逻辑，也**不留孤儿行**。⇒ **"磁盘上有文件而库里没有行"** 由 §8.1 的 GC 判据负责（该判据已被写进迁移头注 `:26-28`：「附件目录里出现'数据库里没有的文件'是**可检测**的（GC 的判据），反过来'库里有一行而文件不在'由下载路径的 `blob_missing` 显式报出」） |
| `attachments.block_id → blocks(id)` | **没有这一列** | **U22 决议**：不物化块关系 |
| `attachments.uploader_id → users(id)` | **无外键**（可空整数列） | 审计留痕在 `audit_log`（§8.3） |

**一条「已核实」的实现事实**：**全仓不存在页面改名路径** —— `savePage` 按 slug upsert，全仓无 `UPDATE pages SET slug`（迁移头注 `:16-19` 与下载端点的注释 `packages/plugin-wiki/src/index.ts:3410-3412` 都写了这条）。⇒ **`page_slug` 冗余列不会陈旧**，"移动条目后判定跟着旧 slug 走"这个风险**当前不成立**。

**但纪律不变**：判定一律按 `pages.slug` 的**现值**联查（下载端点就是这么写的：`SELECT a.…, p.slug AS live_slug, p.content AS page_content FROM attachments a JOIN pages p ON p.id = a.page_id`，`packages/plugin-wiki/src/index.ts:3414-3422`），`attachments.page_slug` **只作审计/排障的人类可读冗余**（迁移头注 `:4`：「**不参与任何判定**」）。⇒ **若将来真加了改名路径，判定不会跟着陈旧**（现值联查已经站在正确的一边）；源码级守卫可钉住"判定路径读的是 `pages.slug`、不是 `attachments.page_slug`"（U13，**仍建议补**）。

### 3.5 迁移文件归属与命名（「设计决策」D10）

**决策（已落地）**：**两侧成对，落在 db 包**：

```
packages/db-sqlite/src/migrations/0018_attachments.sql      ← 已存在（3779 字节）
packages/db-postgres/migrations/0018_attachments.sql        ← 已存在（3776 字节）
```

**理由（这是 §3.0 第 1/3 条的直接推论；实现方的迁移头注 `:2-8` 独立给出了同一条）**：

1. `attachments` 的**外键目标是 `pages(id)`**，而 `pages` 由**宿主迁移**建立（`packages/db-sqlite/src/migrations/0001_init.sql:4-11`）。把建表语句与它引用的目标放在**同一个迁移集**里，是 `0015_blocks.sql:10-13` 给出的既有理由。
2. **决定性的一条**：`plugin-wiki` 自带的迁移目录在组合根**只声明了 sqlite**（`packages/server/src/index.ts:1405` 的 `{ sqlite: WIKI_MIGRATIONS_DIR }`）⇒ 把本文件放进 `packages/plugin-wiki/migrations/` 的话，**PostgreSQL 部署下这张表根本不会被建出来**，附件功能整个不可用（且报错要到运行时才出现：`no such table: attachments`）。落在 db 包、两侧成对 ⇒ 没有这种理解分歧。（实现方的头注 `:2-8` 就是这么写的。）
3. 编号 `0018` 是宿主迁移的下一个空位（现有最大 `0017_version_blocks.sql`）。

**方言事实（实现确认，写进文档以免后人当 bug）**：

- PG 版的自增主键用 **`INTEGER GENERATED BY DEFAULT AS IDENTITY`**（`packages/db-postgres/migrations/0018_attachments.sql:30`），**不是 `BIGSERIAL`** —— 该文件 `:22-23` 的注释写明"本仓 PG 迁移**一律用** `GENERATED BY DEFAULT AS IDENTITY`（0001/0010/0011/0012/0013/0014/0015/0016 全是这一形态）"。**新增迁移照抄这个形态**。
- 两侧都**不写 `BEGIN`/`COMMIT`**（`db.migrate()` 逐文件包事务），全部 `IF NOT EXISTS` ⇒ 可重放。

**迁移交付项（三条，**均已落地**）**：

- `0018_attachments.sql` × 2（双方言，成对）；
- **幂等重放**（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`；不写 `BEGIN`/`COMMIT`）；
- **新库与老库都能跑**：`_migrations` 表去重 + 附件目录 `mkdir -p`（`ensureAttachmentDirs`，`packages/plugin-wiki/src/attachment-store.ts:81-88`）。

**未做/仍建议的**：`packages/db-*/test` 的**迁移幂等用例**（本文 §9.1 第 12 条）我**没有核实是否已覆盖 `0018`**；`plugin-wiki/migrations/` 那条备选路径**未被采用**，故无需动 `packages/server/test/builtin-migrations.test.ts:44-48` 的回退清单。

### 3.6 索引与查询形态

**实际落地的两条索引**（`packages/db-sqlite/src/migrations/0018_attachments.sql:48-52`）：

```sql
-- 页面附件清单（GET /api/pages/:slug/attachments 与配额求和都走它）
CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments(page_id);
-- 跨页查同一份内容（GC 判据："还有没有元数据指向这个文件"）
CREATE INDEX IF NOT EXISTS idx_attachments_sha  ON attachments(sha256);
```

| 查询 | 走哪条 | 频次 |
|---|---|---|
| 下载判定取行（按 `id`） | 主键 + `JOIN pages p ON p.id = a.page_id`（`packages/plugin-wiki/src/index.ts:3414-3422`） | 每下载一次 |
| 块级判定 | **无索引可走**：判定靠"重跑投影"（读该页的 `blocks` 行 + 投影），走 `idx_blocks_page_ordinal`（既有） | 每下载一次 |
| 列表（按页） | `idx_attachments_page` | 打开编辑器/治理面板 |
| 每页配额求和 | `idx_attachments_page` + `SELECT COALESCE(SUM(byte_size), 0)`（`packages/plugin-wiki/src/index.ts:3074`、`:3197`） | 每次上传 |
| 去重（同页同内容） | **`UNIQUE (page_id, sha256)`**（主键索引）+ `idx_attachments_sha` | 每次上传 |
| GC 判据（"还有没有元数据指向这个文件"） | `idx_attachments_sha` | 运维（**端点尚未实现**） |

**注意**：**不要**给 `sha256` 加 UNIQUE（同一份字节可以在多页各有一行，§2.4 —— 这也是迁移头注 `:22-24` 明确写的）。

---

## 4. 接口契约

### 4.1 通用约定（全部「已核实」）

| 约定 | 出处 |
|---|---|
| 信封：成功 `{ ok: true, ... }`；失败 `{ ok: false, error, message, details? }` | `packages/web/src/api.ts:1-4` 的注释；服务端写法见 `packages/plugin-wiki/src/index.ts` 全部 `h.json(...)` 调用 |
| 路由注册与档位：`router.register(method, path, handler, { access })`，第 4 参省略即 `public` | `packages/server/src/index.ts:337-359`（`:347` 默认值）、`packages/core/src/index.ts:691-696` |
| 档位判定顺序（失败关闭，逐条） | `packages/server/src/index.ts:251-268` 的 `judgeAccess`：`public` 放行 → 应急主体放行 → **无凭据来源 503 `bootstrap_required`**（必须在 401 之前）→ 匿名 401 `{error:'unauthorized'}` → `user` 放行 → `owner`/`admin` 放行 → 其余 403 `{error:'forbidden'}` |
| 读路径的存在性语义：**不存在与无权同值**（一律 404） | `packages/plugin-wiki/src/index.ts:705-712`（`const getPage = async (slug, principal)` 在 `:705`，其后注释：区分开就等于提供"这个 slug 存不存在"的探测接口） |
| 路径参数：路由段在匹配前 `decodeURIComponent`（故 `a%2Fb` 能作为 slug 命中） | `packages/server/src/index.ts:599-608` |
| 状态变更方法必有 CSRF 闸门（三道判据；带会话 cookie 时必须 `x-gw-csrf: 1`） | `packages/plugin-auth/src/http.ts:108-145`（头名 `:20`）、钩子注册顺序 `packages/plugin-auth/src/index.ts:716-718` |
| 前端已统一带该头与 cookie | `packages/web/src/api.ts:71-79`（`'x-gw-csrf': '1'`）、`:81-88`（`credentials: 'same-origin'`） |
| 413 的统一收尾：`h.json(413, …)` + `closeAfterResponse(h)`（声明 `Connection: close` 并在响应刷出后销毁未读完的请求体） | `packages/core/src/index.ts:636-647`；用例 `packages/plugin-wiki/src/index.ts:1395`、`1639` |
| 错误码风格：机器码 snake_case，中文 `message`；`payload_too_large` / `content_too_large` / `invalid_body` / `not_found` / `forbidden` / `unauthorized` 均已在用 | `packages/plugin-wiki/src/index.ts` 全文（例如 `:495`、`:1640`、`:1645`、`:1648`） |

**附件相关端点的档位选择（「设计决策」D11）**：

| 端点 | `access` | 为什么 |
|---|---|---|
| 上传 `PUT /api/attachments/:slug` | **`user`** | 与所有写路径一致（`PUT /api/pages/:slug` 的注册在 `:1622`、以 `}, { access: 'user' }),` 收尾于 `packages/plugin-wiki/src/index.ts:1706`）；具体"这个人能不能改这一页"由 `policy-service` 的 `canEdit` 逐对象判定 —— **粗粒度闸门不能替代逐对象判定**（`packages/core/src/index.ts:490-497` 的注释正是这么写的） |
| 下载 `GET /api/attachments/:publicId` | **`public`** | 与详情读路径一致（`GET /api/pages/:slug` **不传**第 4 参 ⇒ `public`，`packages/plugin-wiki/src/index.ts:1279`）。**匿名必须能下载公共页的图**；无权由 §4.3 的逐对象判定给 404 |
| 列表 `GET /api/pages/:slug/attachments` | **`public`** + 逐对象判定 | 同详情读路径 |
| 删除 `DELETE /api/attachments/:publicId` | **`user`** | 写路径；逐对象要求 `canEdit`（或 `canDelete`） |

### 4.2 `PUT /api/attachments/:slug?name=<urlencoded>` —— 上传

> **路径与动词**：`PUT /api/attachments/:slug?name=<urlencoded>`（`packages/plugin-wiki/src/attachments.ts:6`）—— `Content-Type` 即文件 MIME、请求体即字节；查询参数用 `name`（不是 `filename`）。**评审要点**见下方"路径语义"。

**请求**

| 项 | 值 |
|---|---|
| 方法 / 路径 | `PUT /api/attachments/:slug?name=<urlencoded 文件名>`（`:slug` 可含 `/`，写成 `a%2Fb`；路由段在匹配前 `decodeURIComponent`，`packages/server/src/index.ts:599-608`） |
| `access` | `user` |
| `Content-Type` | **原始字节流**：`application/octet-stream`，或白名单内类型（`image/png` 等）。**不是** `multipart/form-data`（理由见下） |
| 请求体 | **文件字节本身**（流式读取，不整体进内存） |
| 查询参数 | `name`（**必填**：它决定扩展名 ⇒ 决定白名单是否通过、落盘扩展名、响应 `content-type`）；`block`（可选，块 ordinal 归属提示，仅落 `attachments.block_id` 的候选） |
| 必带头 | 浏览器场景：`x-gw-csrf: 1`（`packages/web/src/api.ts:75` 已统一带）+ 会话 cookie |
| 上限 | **默认不限**（2026-09-21：`attachmentMaxBytes` 出厂默认 0 = 不限，见 §6.1）。配成正数时才生效：`content-length > attachmentMaxBytes` **立即 413**（省流量）；实际字节数**边读边计数**，超限同样 413（§5.7）。两道判据一律写成 `limit > 0 && …` —— 反过来写会让「没配限额」变成「拒收一切」。⇒ M1 的实现是 `packages/plugin-wiki/src/attachment-store.ts:141-153` 的 `for await (const chunk of src)` 累加计数 |
| 落盘 | **先写 `<attachments>/tmp/att-<pid>-<ts>-<rand>.tmp`，收完再原子 `rename`**（同文件系统）。M1 的 `storeStream`（`packages/plugin-wiki/src/attachment-store.ts:114-189`）：`createWriteStream(tmpPath)`（`:133`）→ 边收边 `hash.update`（`:150`）→ `ws.end()` 等真正落盘（`:155-157`）→ `exists(finalPath)` 判去重（`:170`）→ `rename`（`:176`）；出错时 `src.destroy()` + `ws.destroy()` + 删 tmp（`:159-162`） |

**路径语义（评审要点，非阻塞）**：`PUT /api/attachments/:slug` 表达的是"**替换 `:slug` 这个资源**"，而实际上 `:slug` 只是**归属页**、真正的资源是"该页下新增的某个附件"。⇒ 两次不同内容的上传到同一 slug 是同一 URL、不同 body，**服务端并不把 URL 当资源身份**（它只是存下字节）。两条可选改进：① 改成 `POST`（集合语义更准）；② 真正的幂等 PUT：`PUT /api/attachments/:slug/:sha256`（**内容寻址让哈希天然就是幂等键**，但那要求前端先算哈希 —— `crypto.subtle.digest` 是浏览器内置，零依赖）。**保留现状也可接受**（服务端本来就按内容哈希去重，`§4.2` 的响应 `deduplicated` 已经把幂等表达清楚了）⇒ 记为 **U18**。

**为什么用原始字节流而不是 multipart（「设计决策」D4'，§0.1 事实 1 的直接推论）**

- 仓库里 **multipart 解析代码为 0 行**（实测 grep 0 命中）；要么引入 `busboy` 一类解析器（**新增依赖**，违反 G4），要么手写 —— 而 multipart 的边界解析（`--boundary`、CRLF 处理、header 折叠、嵌套、超长 boundary）是**公认的高危手写面**，本项目一贯避免手写协议解析（对照：路由是手写的、但 HTTP 解析交给了 `node:http`）。
- 原始字节流让**"体积上限"有唯一真源**（一个计数器），不需要在"声明长度 / 分段头 / 实际字节"三个数之间对账。
- **一条已核实并采纳的论据**：Node 的 `Request.formData()` 路线（undici）**会把整份请求体缓冲进内存**且**没有 per-file 上限** ⇒ "一个匿名请求就能把进程内存打满"；而 multipart 是**没有上限声明的格式**（`packages/plugin-wiki/src/attachments.ts:7-12`）。⇒ 这条论据比本文的"零依赖 + 高危手写面"更硬，建议评审者以它为准。
- 代价：HTML `<form enctype="multipart/form-data">` 不能直接提交 ⇒ 前端必须用 `fetch` 发原始 body（可行，见 §7.1；`packages/web/src/api.ts:81-88` 的 `request()` 只支持 JSON，**上传要单独走一条 `fetch`**）。备选方案与取舍见 **U1**。

**成功响应**

```
200 OK
{ "ok": true,
  "attachment": { "id": 42, "url": "/api/attachments/42",
                  "name": "架构图.png", "mime": "image/png", "ext": ".png",
                  "bytes": 20481, "sha256": "<64 hex>",
                  "page": "guides/arch", "dedup": false } }
```

- **响应形状（「已核实」）**：`attachmentUrl(id: number)` 返回 `/api/attachments/${id}`（`packages/plugin-wiki/src/attachments.ts:152-154`）、去重标志位叫 `dedup`（`StoreStreamResult.dedup`，`packages/plugin-wiki/src/attachment-store.ts:96-103`）。⇒ URL 标识即自增 `id`、去重标志即 `dedup`。
- **与 M1 的分歧（评审点，严重度：中低，建议改）**：本文建议 URL 用**不可枚举的 `public_id`**（`randomBytes(16).toString('base64url')`），M1 用的是**自增整数 `id`**。取舍要诚实：
  - **整数 id 的实际风险确实不高** —— 判定是逐请求的，且"无权"与"不存在"返回**同一个 404**（§4.3.1 第 ⑥ 步）⇒ 枚举不构成存在性预言机，也拿不到任何本来拿不到的东西；
  - **不可枚举 id 的收益是"纵深防御"**：① 附件 URL 会**落进正文文本**（§7.3），一旦将来某条读路径漏判，猜不到的 URL 不会把"漏判"放大成"批量抓取"；② 不泄露"全库有多少附件"这一结构信息。
  - **代价**：多一列 `public_id`（UNIQUE）+ 一处生成逻辑。
  - ⇒ **建议**：加 `public_id`；若实现方判断不值，**必须**在 §4.3 的判定与 e2e（§9.2）上更用力地钉住"无权与不存在同形"。记为 **U19**。
- **幂等**：同一页 + 同一 `sha256`（且扩展名相同）已存在 ⇒ 返回 **201** 且 `dedup: true`（返回 **201**，用 `dedup` 表达"这次是否真的新建了行"，与 `PUT /api/pages/:slug` 用 `outcome` 表达 created/updated/unchanged 同一种做法）。**行层面的幂等靠 `UNIQUE (page_id, sha256)`**（§3.1/§3.6），**落盘层面的幂等**靠"rename 前一次 `exists`"（`packages/plugin-wiki/src/attachment-store.ts:212-215`）⇒ **网络重试不会产生第二份物理文件、也不会产生第二行**。**同一页 + 同一内容但扩展名不同 ⇒ 409 `attachment_conflict`**（`:3245-3253`）。
  **M1 的一条实测级经验（`packages/plugin-wiki/src/attachment-store.ts:17-20`，已核实并采纳）**：`rename` 在 POSIX 下**不会以 `EEXIST` 报错**（静默覆盖）⇒ "目标已存在"这件事**只能靠 `rename` 之前的一次 `exists` 检查**得出；若把去重判据写成"捕获 `rename` 的 `EEXIST`"，在 Linux 上那条分支**永不命中** ⇒ 每次上传都静默覆盖同一路径、`dedup` 恒为 false。
- **`sha256` 出现在响应里是刻意的**：它是幂等去重的凭据，也是运维排障的锚点。但它**不构成本设计的 URL**（§4.3 只认 `:publicId` / `:id`）⇒ 拿到哈希不能下载（**必须**保持这条纪律，否则内容寻址会变成一个"知道内容即可取"的通道）。

**错误码（全表，逐条来自上传端点的实际分支 `packages/plugin-wiki/src/index.ts:3124-3330`）**

| 状态 | `error` | 触发条件（实现里的实际分支） |
|---|---|---|
| 400 | `invalid_slug` | `:3126-3129`：`isValidSlug(slug)` 不通过（`packages/plugin-wiki/src/index.ts:242-298`） |
| **415** | **`unsupported_media_type`** | `normalizeExt(name)` 返回 `null`，或该扩展名不在 `attachmentAllowedExt`（= 内置白名单 ∩ 配置）里 —— 即"扩展名第一步就判"的那个分支（`packages/plugin-wiki/src/index.ts` 的 `PUT /api/attachments/:slug`；搜 `unsupported_media_type` 即可定位）。**为什么是 415**：RFC 9110 §15.5.16 的 415 就是"源服务器拒绝服务该请求，因为**载荷的格式不受支持**"，正是本分支的语义；而前端 `packages/web/src/api.ts` 的 `uploadAttachment` 注释与 e2e 断言**早已按 415 写**（前端没有 `errorText` 映射，界面直接展示服务端的 `message`）⇒ 三处口径一致，故以 415 为准 |
| 404 | `not_found` | `:3195`（页面不存在）与 `:3200` 一类的页面级不可见分支（**不区分"不存在"与"无权"**，与详情读路径同款） |
| 409 | **`attachment_conflict`** | `:3245-3253`：**同一页 + 同一 `sha256` 但扩展名不同**（"同一内容的扩展名不能中途改变"）。⇒ 这是 409 在本能力里的**唯一用法**；删除端点**不产生 409**（见 §4.5） |
| 413 | **`length_required`** | `:3205-3213`：**请求没带可解析的 `Content-Length`（例如 chunked）⇒ 直接拒绝**（并 `closeAfterResponse(h)`）。⇒ 本能力**要求显式长度** —— 这更保守（也更好算配额） |
| 413 | `payload_too_large` | **仅在 `attachmentMaxBytes > 0` 时才可能发生**（默认 0 = 不限，2026-09-21）。① `:3181-3189` 声明的 `Content-Length` 超 `attachmentMaxBytes`（**先于读体**拒绝）；② 实际字节数超上限（存储层抛 `payload_too_large`，`packages/plugin-wiki/src/attachment-store.ts:144-149`）。⇒ 统一用既有码（与 `packages/plugin-wiki/src/index.ts:1640`、`:2005` 同款） |
| 413 | `page_quota_exceeded` | **仅在 `attachmentPageQuotaBytes > 0` 时才可能发生**（默认 0 = 不限，2026-09-21）。① `:3191-3207` 用声明长度做的**前置预检**；② `:3260-3266` 写入事务里的**权威判定**（`SELECT COALESCE(SUM(byte_size),0) …`）。⇒ 键名与默认值见 §6.1（`attachmentPageQuotaBytes`，**默认 0 = 不限**） |
| 401 | `unauthorized` | 闸门（`judgeAccess`）：未登录且存在凭据来源 |
| 403 | `forbidden` | 已认证但对该页**没有编辑能力**（`resolvePage(...).canEdit === false`）；或 `judgeAccess` 的 owner/admin 判定未过 |
| 403 | `csrf_rejected` | 三道 CSRF 判据之一未过（`packages/plugin-auth/src/http.ts:108-145`） |
| 503 | `storage_unavailable` | 落盘/建目录失败（`:3222-3240` 把存储层异常统一映射为 503）。理由：**任何**存储失败都是**运维状态**而不是服务故障，报 500 会计入 `stats().consecutiveFailures` 并可能触发看门狗熔断 ⇒ "磁盘满了"被升级成"整站被熔断"（`packages/plugin-wiki/src/attachment-store.ts:58-80`；**含"只读挂载下 `mkdir({recursive:true})` 返回 `ENOENT` 而非 `EROFS`"这条实测**，见 §5 T9） |
| 503 | `bootstrap_required` | 闸门第 3 步（无任何凭据来源），由 `judgeAccess` 给出 |
| **201** | （成功） | **成功也回 201**（含幂等命中的 `dedup: true`）—— 见 §4.2 的响应小节 |

**不存在的错误码**：`invalid_name`（展示名的清洗**不产生错误**：`name` 只用来取扩展名与展示）、`invalid_block`（**没有 `block` 查询参数**，因为不物化块关系 —— U22）、`incomplete_body`（**不存在这个码**：该语义的码是 **`length_mismatch`**，已实现，见下一段 —— 名字取"与声明长度不符"这个**判据**，而不是"体不完整"这个**猜测**）、`repo_quota_exceeded`（**全库配额未实现**）。`unsupported_media_type` 是扩展名分支的真实错误码（415，见上表）。

**X6 长度校验（响应体完整性）**：**"声明的 `Content-Length` 与实际收到的字节数不符"会被拒绝**。实现落在**存储层、`rename` 之前**：`packages/plugin-wiki/src/attachment-store.ts` 的 `storeStream()` 新增可选入参 `expectedBytes`（HTTP 场景由 PUT 处理器传 `declared`），读完请求体后若 `byteSize !== expectedBytes` ⇒ 抛 `AttachmentStoreError('length_mismatch')` ⇒ 端点回 **400 `length_mismatch`**。**为什么必须校验**：落盘路径是内容寻址的，被截断的文件在内容寻址下是一份**全新的哈希** —— 它路径自洽、`byte_size` 自洽、下载也吐得回来，"同一哈希 ⇒ 同一字节"这条不变式会被**静默**破坏，而发现时机是"用户某天打开这张图，下半截是灰的"；去重挡不住它（去重比的正是哈希）。**为什么放在 `rename` 之前**：失败时只有临时文件存在、走既有的 `discardTmp()`，**最终路径从未被创建** —— "不留残留"靠的是"不发生"，而不是事后删文件（事后删会**误删 `dedup` 场景下别页正在引用的那份内容**）。
**实测（真机 / 裸 socket 核对）**：用裸 socket 发 `Content-Length: 102400` 但只发 51200 字节再半关闭 ⇒ **Node 的 HTTP 解析器在进入任何路由之前就回了 `400 Bad Request`**（处理器一行都没跑，因此也谈不上"安静落盘"）。也就是说，**在 Content-Length 分帧下，"少发字节"这件事根本到不了处理器** —— Node 已经把这条不变式守住了。⇒ 本条校验的定位是**纵深防御**（反代重新分帧、将来换 HTTP/2/其它 `h.req` 来源、代码挪动后基准错位），而不是"补一个真实可达的漏洞"；它的单元测试用内存 `Readable` 直接覆盖（`packages/plugin-wiki/test/attachments.test.ts`），端到端那一侧断言的是**可观察的事实**：截断请求 ⇒ 400 且 `attachments/` 与 `tmp/` **零残留**（`packages/plugin-wiki/test/e2e-attachments.sh` 的 X6 段）。

### 4.3 `GET /api/attachments/:publicId` —— 下载（**权限判定必须按本节算法**）

> **命名说明**：本文用 `:publicId` 表示"URL 里的那个标识"。**实际用的是自增整数 `id`**（`attachmentUrl(id: number)`，`packages/plugin-wiki/src/attachments.ts:152-154`）⇒ 读本节时把它当成 `:id` 即可；两者对算法**没有影响**（算法只要求"能唯一定位一行"），差异与取舍见 §4.2 的分歧条目与 U19。

#### 4.3.1 判定算法（「设计决策」D12 —— 本节是全篇最重要的规格）

> **先读这条**：本节写的是**六步算法（备选路线）**。**落地实现选了另一条等价但更省的路线** —— **不建引用表，而是在下载时重跑一次正文投影**，判据是"**投影后的正文里是否含这个 URL**"（`projectPageContentFor`，**已上移到 `packages/plugin-wiki/src/blocks.ts:840`**，调用点 `packages/plugin-wiki/src/index.ts:3447`）。
> **U22 已决议采纳该路线**（理由：**最抗漂移** —— 判定与渲染共用唯一真源 `projectBlocks`，不存在第二套可漂移规则）。⇒ **本节是"备选实现"**；引用表 `attachment_refs` 与 `last_gate` 快照列**均不采用**。
> **当前形态**：越权**一律 404 且响应体与"不存在"逐字节相同**（`attachmentNotFound`，`:3363`），缓存为 `private, no-cache, no-transform`（`:3520`）。
> **读本节时请把"引用表"读成"投影判据"、"403"读成"404"**：判定所需的语义（页面可见性 → 块级 tier/授权 → 失败关闭）完全一致。

**输入**：`principal`（必由路由层解析，绝不接受空值 —— 见 `packages/plugin-wiki/src/index.ts:597-603` 的 `requirePrincipal`）、`publicId`。
**输出**：`allow | not_found`（**没有 403 分支**：读路径一律 404，`access-control.md` §2.3）。

```
① 取行：SELECT * FROM attachments WHERE public_id = ? AND deleted_at IS NULL
   无行                       ⇒ 404 not_found            （没有软删，行被删就是这个分支）
② 归属页判定：
   page := SELECT id, slug, visibility, inherit, published_at FROM pages WHERE id = row.page_id
   page 不存在（page_id 为 NULL 的孤儿，或页面已删） ⇒ 404 not_found
   access := policy-service.resolvePage(principal, page.slug)
   access.level === 'none'    ⇒ 404 not_found            （**不是 403**）
③ 读者等级（与正文投影逐字同口径）：
   const anonymous = principal.kind === 'anonymous'
   const tier: ReaderTier = anonymous ? 0 : 1
   —— 出处：packages/plugin-wiki/src/index.ts:358（projectPageContent 里就是这两行）
   granted := await policy-service.grantedBlockIds(principal)   // 匿名 ⇒ 空集（policy 实现保证）
④ 引用点判定（**只看本页的引用点** —— 见下方"跨页复用"说明）：
   refs := SELECT block_id FROM attachment_refs WHERE attachment_id = row.id AND page_id = page.id
   visibleRefs := 0
   for each r in refs:
       b := SELECT id, visibility, tier FROM blocks WHERE id = r.block_id
       if b 不存在                              → 该引用点视为不可见（失败关闭）
       else if blockLevelOf(b.visibility) === null:      // 'granted' 档
                可见 ⟺ b.id ∈ granted
       else if blockLevelOf(b.visibility) <= tier       → 可见
       else                                             → 不可见
       if 可见: visibleRefs += 1
⑤ 放行条件：
   if refs 非空:   放行 ⟺ visibleRefs > 0
   if refs 为空:   放行 ⟺ gateAllowsLastGate(row.last_gate, tier, granted 无关)
                   其中 gateAllowsLastGate:
                     NULL / 'public' → 放行（从未被引用，或只被公共段落引用过）
                     'org'           → 放行 ⟺ tier >= 1
                     'granted'       → **一律不放行**（见下方说明）
⑥ 不满足 ⇒ 404 not_found（**不要**因为"页面可见但块不可见"而返回 403）
```

**关于第 ⑤ 步里 `last_gate = 'granted'` 一律不放行**：`granted` 档的可见性来自 `block_grants`（逐人/逐组的块级授予）。引用点消失后，"谁被授予过"这条信息也随之失去挂靠对象（`block_grants` 行随块 `CASCADE` 消失，`0016_block_grants.sql` 的块外键）。⇒ **无法可靠重建"谁曾经有权"**，故取**失败关闭**：只有显式重新引用（保存一次正文）才恢复可见。这是"宁可少给"的方向。

**关于"跨页复用"（第 ④ 步只查本页引用）**：物理文件全局去重、逻辑行按页隔离（§2.4）⇒ 同一张图被 A 页（受限段落）与 B 页（公共）分别上传时是**两行**，各判各的。**A 页的行不会因为 B 页公开而放开**。`attachments.page_id` 是"这一行属于哪一页"，判定只在这一页内做 —— 这条纪律同时消除了"内容相同 ⇒ 可见性互相污染"的相关性泄露。

**关于"上传后、保存前"的窗口**：此时 `refs` 为空、`last_gate` 为 NULL ⇒ 按页面可见性放行。**这不是放宽**：文件尚未出现在任何正文里，它对读者的可见面**等于页面本身**（与"作者把图直接挂在页面级"完全等价）。真正的收紧发生在**第一次保存**（正文里出现该 URL 后，投影判据即生效）。

#### 4.3.2 判定实现的三条纪律（「设计决策」D13）

1. **必须复用 `policy-service`**，不得自行查 `pages.visibility` / `page_grants`：`packages/plugin-authz/src/index.ts:1-24` 的模块注释写明它是**唯一真源**（"只要有一条读路径自己拼 payload、自己决定裁多少，它就是第二个真源，迟早与这里漂移"）。用到的两个方法签名（「已核实」）：
   - `resolvePage(p: Principal, slug: string): Promise<PageAccess>`，`PageAccess = { slug, level: 'none'|'summary'|'full', canEdit, canDelete, canManageVisibility, reason, project<T>(payload: T): T }`（`packages/plugin-authz/src/index.ts:54-68`、`:87-91`）；
   - `grantedBlockIds(p: Principal): Promise<readonly number[]>`（`:118`，P3b 起为真实查询：user 直授 + group 组授、**按 `expires_at` 过滤**、匿名/break-glass 返回空集）。
2. **必须复用 `blockLevelOf`**（`packages/plugin-wiki/src/blocks.ts:212-215`）：
   ```ts
   export function blockLevelOf(visibility: BlockVisibility): BlockTier {
     if (visibility === 'granted') return null
     return visibility === 'public' ? 0 : 1
   }
   ```
   **不要**在附件模块里重写"哪个档位对应哪个读者"的映射 —— 那是 §4.6 那条跨阶段不变量的第二条腿。
3. **判定是纯函数 + 一次策略调用**，便于单测（§9.1）：把 `{ row, page, refs, blocksById, granted, tier }` 作为输入，输出 `allow | not_found`。⇒ 纯函数里**不碰 IO**，IO 由调用方（路由处理器）完成。

#### 4.3.3 `plugin-wiki` 里是否**存在**可复用的公开函数？（「已核实」的回答）

| 需求 | 现状 | 结论 |
|---|---|---|
| 页面可见性判定 | ✅ `policy-service.resolvePage` / `resolvePages` / `visibleSlugs`（`packages/plugin-authz/src/index.ts:87-119`；服务名由 `:1264` 的 `ctx.provide('policy-service', svc)` 提供，`packages/plugin-wiki/src/index.ts:288` 的 `requires: ['http-service','database-provider','policy-service']` 是依赖边） | **可直接复用，无需抽取** |
| 块级授权集合 | ✅ `policy-service.grantedBlockIds`（`:118`） | **可直接复用，无需抽取** |
| 某块的档位 → 读者等级 | ✅ `blockLevelOf` 已 `export`（`packages/plugin-wiki/src/blocks.ts:212`） | **可直接复用** |
| **"某主体能不能看某一页的某一块"的现成公开函数** | **已上移并导出** —— `export async function projectPageContentFor(...)` 在 **`packages/plugin-wiki/src/blocks.ts:840`**（`packages/plugin-wiki/src/index.ts:364` 的注释说明"实现已**上移**到 `./blocks.js` 的 `projectPageContentFor`"），调用点：详情 `packages/plugin-wiki/src/index.ts:801`、**附件下载判定 `:3447`** | **直接复用整页投影**：附件判定与正文渲染走的是**同一个函数** —— 这比"单块查询"更强（不会出现"单块判可见、整页投影不可见"这类两套口径的偏差） |

> **归属提醒**：附件端点落在**哪个插件**是 U2（未决）。若落在 `@geewiki/wiki`（推荐：它与 `blocks` / `pages` / `policy-service` 同包，且已有 `readBody`、`closeAfterResponse`、`requirePrincipal` 等现成范式），则上述抽取是**同包内**改造；若新开 `@geewiki/attachments` 插件，则 `blockVisibleTo`、`requirePrincipal`、`isContained` 这三处都要**跨包**复用 ⇒ 抽取成本更高，且 `packages/core` 能否放（它不能进浏览器包，见 `access-control.md` §9 R3）需要单独讨论。

### 4.4 `GET /api/pages/:slug/attachments` —— 列表

| 项 | **实际落地**（`packages/plugin-wiki/src/index.ts:3474` 起） |
|---|---|
| 路径 / 档位 | `GET /api/pages/:slug/attachments`；**注册时未传第 4 参** ⇒ 闸门档位是默认的 `public`，而**逐对象要求 `canEdit`**（见下） |
| 入参校验 | `isValidSlug(slug)` 失败 ⇒ **400 `invalid_slug`**（`:3584`） |
| 逐对象判定 | `resolvePage(...).level === 'none'`（页面不可见）⇒ **404 `not_found`**（`:3590`）；**可见但无编辑权 ⇒ 403 `forbidden`『没有编辑该条目的权限，附件清单不对外提供』**（`:3600`） |
| 一处设计选择 | **附件清单不对外提供** —— 它要求 `canEdit`，因此**读者拿不到"这一页有哪些附件"的清单**。清单本身会泄露"这一页有多少附件、都叫什么名字"，而这些信息在正文里未必都可见。⇒ **以实现为准**；若将来要给读者看，必须**逐行**跑 §4.3 的判定（不能只按页面档位）。 |
| 分页 | **无分页**：`SELECT … FROM attachments WHERE page_id = ? ORDER BY id DESC`（`:3610-3624`）一次性返回。⇒ U10 的"游标分页"**未实现**（页级附件量受每页配额约束，当前可接受） |
| 成功响应（实际形状） | `{ ok: true, slug, attachments: [{ id, name, url, ext, mime, size, sha256, uploaderId, createdAt }] }`；成功响应把入口的 `no-store` 覆盖为 **`private, no-cache`**（无字节流，故**不带** `no-transform`，`:3624-3625`） |
| 「管理视角」 | `?scope=manage` **未实现**（不需要：本端点已经要求 `canEdit`） |
| `referenced` 字段 | **不存在**：它依赖 `attachment_refs` 表，而该表已决议不建（**U22**）⇒ §8.1 的"无引用行"判据目前**没有持久化载体**（见 §8.1 第 4 行） |

### 4.5 `DELETE /api/attachments/:id` —— 删除

| 项 | **实际落地**（`packages/plugin-wiki/src/index.ts:3537` 起，注销于 `:3716`） |
|---|---|
| 路径 / 档位 | `DELETE /api/attachments/:id`，`{ access: 'user' }` |
| 入参校验 | `id` 非正整数 ⇒ **400 `invalid_id`**（`:3662-3665`）。注意与**下载**端点的差别：下载对非法 id 走 **404**（"非法输入"也回"没有可给你的东西"），删除走 **400**（它要求一个明确的操作对象） |
| 逐对象判定 | 行不存在 ⇒ `attachmentNotFound`（**404**）；`resolvePage(...).level === 'none'`（页面级无权）⇒ `recordAccessDenied(…, 'no_read_access')` + **404**；**`!access.canEdit` 且非上传者本人 ⇒ `recordAccessDenied(…, 'no_edit_access')` + **404**（`:3694-3705`）。⇒ **读/写两套语义在这里被统一成"一律 404"** |
| 权限判据 | **`canEdit` 或上传者本人**（`:3688-3690`：`p.userId === row.uploader_id`）—— 本人删自己传错的附件不需要额外的编辑权 |
| 语义 | **硬删元数据行**：`await adb.run('DELETE FROM attachments WHERE id = ?', [id])`（`:3706`），响应 `200 { ok: true, deleted: <id> }`；成功响应把入口的 `no-store` 覆盖为 `private, no-cache`（`:3707-3708`） |
| 磁盘文件 | **不动，留给 GC**（`:3642-3646` 的注释）：落盘路径**内容寻址**，同一份字节可能被他页（乃至同页另一条记录）共享 ⇒ 删除时顺手 `unlink` 会让别处正在引用的附件变成**跨页**破图，且极难归因。⇒ 回收由 GC 负责（**未实现**，见 §8.1/§8.2） |
| 二次删除 | 行已被删 ⇒ 走 `!row` 分支 ⇒ **404 `attachmentNotFound`**（**不再有**"幂等 200 + `already_deleted`"这套语义，因为不再是软删） |
| 409 | **本端点不产生 409**。⇒ **正文引用不阻止删除**：删除只删元数据行、不删磁盘文件，不存在"删了会让别处破图"的问题（破图风险被 GC + 内容寻址化解）。**409 在本能力里的实际用法在别处**：上传时"**同页同 sha 但扩展名不同**"⇒ `409 attachment_conflict`（`packages/plugin-wiki/src/index.ts:3245-3253`） |

### 4.6 响应头取值与理由（「设计决策」D14）

| 头 | 取值 | 理由 / 出处 |
|---|---|---|
| `content-type` | **由服务端的 `ext → mime` 常量表给出**（M1 的 `MIME_BY_EXT`，`packages/plugin-wiki/src/attachments.ts:73-90`）；**绝不**用 `original_name` 的扩展名推断 | 客户端声明 + 嗅探 = 经典的"改名绕过"（T2）。**单一真源**：`ext` 由白名单决定（§6.2），`mime` 由 `ext` 决定。**但 M1 的 `effectiveMime` 留了一条"回退到客户端声明值"的分支**（`packages/plugin-wiki/src/attachments.ts:201-207`：表里查不到 `ext` 时，若声明值匹配 `MIME_LITERAL_RE` 就用它）⇒ 见下方 **一条真实的漂移陷阱** |
| `x-content-type-options` | **`nosniff`**（**四个端点一律发，含 304 与错误响应**；仓库首次使用，见 §0.1 事实 5） | 阻止浏览器忽略我们的 `content-type` 去嗅探内容。**这是"改名成 .png 的 HTML 不会被执行"的第二道保障**（第一道是白名单 + 服务端推导类型）。实现位置：四个端点在处理器入口就设（`packages/plugin-wiki/src/index.ts:3158-3159`（上传）/ `:3398-3399`（下载）/ `:3586-3587`（列表）/ `:3658-3659`（删除））⇒ 因此**错误分支不会漏**（`h.json` 只写 `content-type`，不带 nosniff）；e2e 有两条对应断言：`packages/plugin-wiki/test/e2e-attachments.sh:268`（400 错误也带）、`:328`（下载响应带） |
| `content-disposition` | 光栅图片（`png/jpeg/gif/webp/avif`）：`inline`；**其余一律 `attachment`**；文件名用 RFC 5987 形态 `filename*=UTF-8''<pct-encoded>` + ASCII 回退 | `inline` 是 `<img src>` 能内嵌显示的前提（见下"为什么图片必须 inline"）；非图片一律强制下载，**顺带覆盖 SVG 与所有文档类型**。**M1 已实现且与本文一致（「已核实」）**：`formatDisposition(kind, name)`（`packages/plugin-wiki/src/attachments.ts:175-187`）= `filename="<ASCII 回退>"` + `filename*=UTF-8''<pct>`，其中回退值把非可见 ASCII 与 `"`/`\` 一律换成 `_`、截断 200 字符，并把 `'()*` 手工百分号编码（RFC 5987 的 attr-char 不含它们，而 `encodeURIComponent` 不转义）。⇒ **这正是本文要求的"必须清洗"**。补充一条 Node 侧实测：v22.23.2 下 `res.setHeader('content-disposition', 'x\r\ny')` **会抛 `ERR_INVALID_CHAR`**（实测）—— 因此不清洗不是"注入成功"，而是**稳定 500**；仍然必须清洗 |
| `content-length` | 物理文件字节数（`stat` 结果） | 与 `bytes` 列交叉核对（§8.1 探针） |
| `etag` | 强验证器：`"<sha256>"`（内容寻址 ⇒ 内容永不改变） | 让读者的浏览器可**条件请求**（`If-None-Match` ⇒ 304）。**注意**：304 只在**判定通过后**才可能发生 ⇒ 权限收紧后客户端重新验证会拿到 404，**不会**靠 304 继续用旧内容 |
| `cache-control` | **成功：`private, no-cache, no-transform`**（下载，`packages/plugin-wiki/src/index.ts:3520`）；**错误：`no-store`**（四个端点的入口默认值，成功分支显式覆盖）。 | 三条理由：① **不许共享缓存**（CDN / 反代）—— 响应随身份变化，`public` 会造成 `access-control.md` 里的 web cache deception；② **必须每次回源判定** —— 仓库有**明文禁令**"不要给判定层加 TTL 缓存"（`access-control.md` §9 R10 第 3 条与 §12 第 25 条；工程约定见 `docs/development.md`「PostgreSQL 方言差异」）⇒ `no-cache`（允许存、**复用前必须回源校验**）正是这条禁令在客户端缓存上的对应物；③ `no-cache` + `etag` 在"同一读者、短时间多次打开同一页"的实际场景下仍然省流（304 无响应体）。**为什么不是 `no-store`（实现方的说明）**：内容寻址 + sha256 ETag ⇒ 304 复用**不可能复用错内容**，要禁止的只是"**不校验就复用**"；`no-store` 关掉的是性能，`no-cache` 关掉的才是"撤销后仍可见"那个窗口（`:3512-3517`）。**错误响应为什么必须 `no-store`**：`h.json` 不带 `cache-control`，而 404 这类错误响应浏览器是**可以启发式缓存**的 ⇒ 会把"授权前拿到的 404"在授权后继续复用（`:3038-3050`）。**`no-transform` 只用在下载**（它在传字节流，代理压缩/改写会破坏 ETag 语义）；列表/删除/上传的成功响应不需要它 |
| `content-security-policy` | **`default-src 'none'; sandbox`** | **专治 SVG / 被直接导航打开的活动内容**（§5.3）：即使某个 `image/svg+xml` 被用户直接打开（顶层导航），CSP `sandbox` 会把它放进唯一源（unique origin）、禁脚本执行；`default-src 'none'` 阻断其子资源加载。**零依赖**，是本设计拒绝"引入 SVG 消毒库"的前提。**实现的对应物**：`.svg` 必须走 `attachment`（下载）而不是内联 —— `dispositionKindOf(ext, { inlineSvg })` 默认返回 `attachment`，只有配置 `attachmentInlineSvg=true` 才允许内联（`packages/plugin-wiki/src/attachments.ts:162-165`），且注释明写"打开它需要运维**同时**配上 CSP"（`:159-161`）。⇒ **与本文同向，但把"是否内联 SVG"变成了配置项**（本文 U3 建议的是"不进白名单"） |
| `accept-ranges` | **不发送**（不支持 Range） | 见 N7 与 U6：不支持就**不要**声明。收到 `Range` 请求时按规范**忽略**并返回完整 200 |
| `vary` | `cookie`（保守起见） | 判定随会话变化；虽然 `cache-control: private` 已经限制到私有缓存，`vary: cookie` 让"同一 URL、不同会话"在私有缓存里也不会串味 |

**一处必须由评审者裁定的分歧（`content-disposition` 的 `inline` 集合）**：M1 的 `INLINE_EXTS` 是 `['.png','.jpg','.jpeg','.gif','.webp','.avif','.pdf']`（`packages/plugin-wiki/src/attachments.ts:99`）—— **它把 `.pdf` 也算作可内联**。本文的 D14 只允许**光栅图片**内联。取舍：
- **支持 PDF 内联的理由**：浏览器内置阅读器体验好，PDF 是 wiki 场景的高频附件；
- **反对的理由**：PDF 是**活动文档**（可含 JavaScript、表单、外部引用），内联在**同源**下打开意味着它就运行在本站的源上（`<iframe>`/顶层导航）；PDF 阅读器的 JS 能力与沙箱行为**跨浏览器差异大**，属"难以给出统一保证"的一类。
- **建议**：**要么**把 `.pdf` 移出 `INLINE_EXTS`（下载后本地打开），**要么**为下载端点补 `content-security-policy`（`sandbox` 对 PDF 阅读器的影响同样需要**真浏览器验证**，§9.3 B5/B8）。⇒ 记为 **U20**（与 U3 同族，都属"哪些类型可内联"这一个安全边界）。

**一条真实的漂移陷阱（评审点，严重度：高——但当前不可达，实现方须加守卫）**

M1 把"**哪些扩展名允许**"（`ATTACHMENT_EXT_WHITELIST`，`packages/plugin-wiki/src/attachments.ts:38-55`）与"**扩展名 → MIME**"（`MIME_BY_EXT`，同文件 `:73-90`）写成了**两张独立的表**。我实测比对过：**今天两张表的键集合逐项相同（各 16 项：`.png .jpg .jpeg .gif .webp .avif .svg .pdf .txt .md .csv .json .zip .docx .xlsx .pptx`）**，因此那条"回退到客户端声明"的分支**当前不可达**。

**但它一旦漂移就是一个存储型 XSS**：假设将来有人往白名单加一项（例如 `.odt`）却忘了给 `MIME_BY_EXT` 补条目 —— 此时 `effectiveMime('.odt', 'text/html')` 的表查找落空、回退分支命中，而 `MIME_LITERAL_RE`（`:190`）**允许 `text/html`**（它只校验 `type/subtype` 的字面形态，不管它危不危险）⇒ 攻击者上传一个声明 `text/html` 的文件，响应就以 `text/html` 下发，配 `inline` 或直接导航即**同源脚本执行**。这与本仓库反复记录的失效形态是同一个（工程约定见 `docs/development.md`「文档纪律：注释与真源」：*"文档注释会成为错误的传播媒介"*、两个真源迟早漂移）。

**两条零成本修法（任选其一，建议两条都做）**：

1. **让回退值永远是 `application/octet-stream`**（删掉"用声明值"那一步）—— 声明值本来就不该被信任；
2. **加一条源码级守卫测试**：断言 `new Set(ATTACHMENT_EXT_WHITELIST)` 与 `Object.keys(MIME_BY_EXT)` **集合相等**（这既杀死今天那条不可达分支，也把"加白名单忘了加 MIME"变成**可见的失败**）。⇒ 与本仓库既有守卫测试的口味完全一致（对照 `packages/plugin-authz/test/audit-appendonly.test.ts`、`packages/server/test/builtin-migrations.test.ts` 的判据 A–D）。

**为什么图片必须 `inline`**：正文里的 `![](/api/attachments/<id>)` 最终由 `marked` → `DOMPurify.sanitize` → `innerHTML` 渲染（链路见 §4.7 与 §7.3），**`<img>` 需要 `inline` 才内嵌显示**；若图片也强制 `attachment`，所有图都会变成下载提示而不是图片。**⇒ 因此"哪些类型可以 inline"是一个安全边界**：本文主张只有**光栅图片**（不含 SVG、不含 HTML、**不含 PDF**）可以 inline。

### 4.7 为什么**不能**用静态目录直接托管（「已核实」事实 + 「设计决策」）

**事实（三条，各自独立足够否决）**：

1. **静态层完全不经鉴权**：`RequestHook` 契约第 6 条明写 —— 钩子"**只对匹配到的路由执行**"，静态资源与 SPA fallback "**完全不经钩子**"（`packages/core/src/index.ts:624-627`）；`serveStatic()` 在 `dispatch()` 返回 `false` 时才被调用（`packages/server/src/index.ts:1138-1157`），它只做"路径包含校验 + 读文件 + 写响应"（`:969-1010`），**没有任何 principal 概念**。⇒ 放到静态根下 = **全世界可读**，第 4.3 节的判定算法**根本不会被调用**。
2. **静态层按扩展名给 `content-type`**：`STATIC_MIME` 表里 `.svg` ⇒ `image/svg+xml`、`.html` ⇒ `text/html; charset=utf-8`（`packages/server/src/index.ts:800`、`:805`）。⇒ 一个 `x.svg` 会在**本服务的源**上被当作可执行文档打开（脚本可读 `document.cookie` 之外的**同源**能力：发同源请求、读 `localStorage` 之外…… **注意**：会话 cookie 是 `HttpOnly`（`packages/web/src/api.ts:67-69` 的注释），所以偷不到会话令牌，但**同源脚本可以以受害者身份发请求**（等于绕过 CSRF 头吗？—— 不：CSRF 头是自定义头，同源脚本**能**设置它 ⇒ **是的，可以绕过 CSRF 闸门**）。这是最严重的一条。
3. **静态层有"长缓存 + immutable"分支**：`/assets/` 前缀下 `cache-control: public, max-age=31536000, immutable`（`packages/server/src/index.ts:945-947`）⇒ 一旦某个受限附件落进共享缓存，**权限收紧后它还在缓存里**（与 §4.6 的 `private, no-cache` 正好相反）。

**结论（「设计决策」D15）**：附件**只能**经 `router.register` 注册的 API 端点输出（⇒ 天然经过 `judgeAccess` 闸门、天然经过 CSRF/会话钩子链、天然可写 §4.6 的头）。**绝不**把 `data/attachments/` 加到 `webDist`、`pluginUiRoots` 或任何静态根里。**实现时要在 `serveStatic` 的调用点附近留一条注释**说明这条禁令（否则后来的人"顺手加一个静态根"就打开了这个洞）。

---

## 5. 威胁模型

**读法**：每条给「**攻击者能做什么 → 我们的对策 → 残余风险**」。标 **[P0]** 的是必须在第一版实现里堵住的；标 **[P1]** 的可以跟进但有明确触发条件。

### T1 路径穿越（[P0]）

- **攻击者能做什么**：`filename=../../../../etc/cron.d/x`、`..%2f..%2f`、绝对路径 `/etc/passwd`、Windows 保留名 `CON`、含 `\0` 的名字、超长名（撞 `ENAMETOOLONG`）、符号链接（若目录里预先存在一个指向外部的软链）。
- **对策**：§2.3 的三条规则（内容寻址 ⇒ 用户输入不进路径；写盘前 `isContained` 词法校验（复用 `packages/server/src/index.ts:959-963`）+ `realpath` 复核；创建时用 `O_EXCL`（`fs.open(path, 'wx')`）避免跟随已存在的软链）。
- **残余风险**：**几乎为零**（路径里不存在用户可控字节）。唯一残留是"运维手工往 `data/attachments/` 里放软链" —— 属运维事故，不在威胁模型内。

### T2 MIME 嗅探与双扩展名（[P0]）

- **攻击者能做什么**：把 `evil.html` 改名 `evil.png.html` 上传；用 `Content-Type: image/png` 声明但发 HTML 字节；上传 `.svg` 后诱导他人**直接打开 URL**（顶层导航 ⇒ 同源执行）。
- **对策**：① **类型不取客户端**：`Content-Type` 请求头**只用于校验是否属于白名单类别**，落库的 `ext`/`mime` 由服务端按"声明的类别 + 白名单"推导（若声明与白名单不符 ⇒ 415）；② 文件名**不用**用户提供的字符串（§2.3）⇒ 双扩展名无处落脚；③ 响应 `nosniff`；④ 非光栅图片一律 `content-disposition: attachment`；⑤ SVG 另加 CSP（T3）。
- **残余风险**：**字节内容与声明类型不一致**（`image/png` 声明 + HTML 字节）。浏览器对 `<img>` 不会执行非图片字节（解密失败即破图），`nosniff` 又挡住"按 HTML 解释"，因此在**内嵌**路径上残余风险低；**直接导航**打开时浏览器会按 `content-type: image/png` 处理、解析失败 ⇒ 显示破图，**不会**执行 HTML（这正是 `nosniff` 的价值）。真正的内容魔数校验列为 U4。

### T3 SVG 内嵌脚本（[P0]）

- **攻击者能做什么**：上传含 `<script>` 的 SVG；该 SVG 作为同源文档被打开时可发同源请求（**能带 `x-gw-csrf: 1`** ⇒ 绕过 CSRF 闸门）、读取同源响应（若页面把数据渲染进 DOM）。
- **对策（缺一不可）**：① SVG **默认不进白名单**（推荐；见 U3）；② 若允许：`content-disposition: attachment`（不能内嵌）+ `content-security-policy: default-src 'none'; sandbox` + `nosniff` + 只允许光栅图片 `inline`。
- **残余风险**：① CSP `sandbox` 在**老浏览器**上可能不被支持（现代浏览器均支持；本项目的目标浏览器基线未在仓库中声明 ⇒ 属未验证项）；② 用户**下载到本机后**打开 SVG 是用户本机的事（不在服务端边界内）；③ 若"允许 SVG 内嵌"（U3 选 B），残余风险显著上升（内嵌 `<img>` 中的 SVG **不执行脚本**是浏览器行为，但**直接打开**会）。

### T4 超大文件与慢速上传（[P0] / [P1]）

- **攻击者能做什么**：① 反复上传 1 GiB 把磁盘打满；② 用极慢的 body（每 30 秒 1 字节）占住连接与 `tmp` 文件（slowloris 变体）；③ 并发 200 个上传把 fd / 句柄耗尽。
- **对策**：① 单文件上限（**默认 0 = 不限**，2026-09-21；原默认 25 MiB）+ 每页/全库配额（§6.3，同样默认不限）+ **边读边计数**（不信任 `Content-Length`）；② 上传超时 `req.setTimeout(uploadTimeoutMs)`（**必须显式请求，因为 HTTP 层没有任何超时** —— §0.1 事实 6）+ 超时/异常时**必须删 `tmp` 文件**（`finally` 里删，且 `unlink` 失败只记日志）；③ 并发上传闸门：进程内计数器（`Map<owner, count>` 或单个 `let inflight`），超限返回 **429 `too_many_uploads`**（或 503，见 U8）。
- **残余风险**：① **多实例部署下进程内计数器无效**（但仓库既有的"多实例必然失败"结论已存在 —— 工程约定见 `docs/development.md`「环境、沙箱与运行约束」：OIDC 状态存进程内，方向是失败关闭；附件同理，**在部署文档里写明"附件能力不支持多实例共享目录"**）；② 配额是**软约束**：并发上传可在配额检查与落盘之间超发（§5.11、U5）。

### T5 multipart 解析边界（[P0]，**本设计的对策是"不引入"**）

- **攻击者能做什么**（若引入 multipart）：构造畸形 boundary、超长 header、`filename` 里带 CRLF、嵌套 multipart、把 `Content-Length` 与分段头对不上、用 `boundary` 做正则灾难（ReDoS）。
- **对策**：**原始字节流上传 ⇒ 该攻击面整体不存在**（§4.2 D4'）。前端用 `fetch` + 原始 body（§7.1）。
- **残余风险**：① 不能直接用 HTML 表单上传（前端必须发原始 body）；② `filename` 改走 query 参数 ⇒ **query 参数必须清洗**（§2.3 规则 2 已覆盖，且它是"只用于展示"的字段）；③ 若将来为了"第三方集成方便"引入 multipart，**U1 的候选对比必须重做**，不得"顺手加一个依赖"。

### T6 `Content-Length` 伪造（[P0]）

- **攻击者能做什么**：① 声明 `Content-Length: 10` 实发 2 GiB（chunked 或直接多写）；② 声明 2 GiB 实发 10 字节（占住我们对"上限预检"的信任，然后断开）；③ 不发 `Content-Length`（chunked）。
- **对策（X6 已补第 ③ 条）**：① **上限预检用声明值**（声明就超限 ⇒ 立即 413，省流量），**实际大小以计数器为准**（存储层的 `for await` 累加计数：超限 ⇒ `payload_too_large` ⇒ 413）；② **缺 `Content-Length`（如 chunked）⇒ 直接拒绝 413 `length_required`**（并 `closeAfterResponse`）—— 本能力**要求显式长度**（更保守，也让配额预检有意义）；③ **"声明与实际不符"会拒绝**：`storeStream()` 读完体后比对 `byteSize` 与 `expectedBytes`，不符 ⇒ `400 length_mismatch`，且**失败发生在 `rename` 之前**（最终路径从未创建 ⇒ 零残留）。⇒ 本节的**残余风险**：**"少发字节"不能安静落盘**（纵深防御；实测中 Content-Length 分帧下的截断请求由 Node 解析器直接 400，见 §4.2 末尾）；**多发/谎报偏小的字节**由计数器与分帧共同挡住。
- **残余风险**：声明 1 字节实发 10 MiB 的请求会被读到**计数器上限**才拒（有上限兜底，代价是那 10 MiB 的带宽）—— 这是**无法避免的**（HTTP 无"边读边验证声明"的机制）。

### T7 受限段落附件泄露（[P0] —— **本设计的核心威胁**）

- **攻击者能做什么**：① 读者从别处得知/猜到（或从**曾经可见**的版本、从**另一页的引用**、从**搜索结果快照**）某个附件的 URL，直接 `GET` 拿文件，而正文里那段是受限的；② 作者把图放在受限段落，以为"看不见就等于拿不到"。
- **对策**：§4.3 的判定：页面可见性（`policy-service`）→ 该附件 URL 是否在读者的**可见投影**里（`blockLevelOf` + `grantedBlockIds` + `projectBlocks`）→ 不在投影里 ⇒ **失败关闭**（404）；**未授权一律 404**（不泄露存在性）；判定与渲染共用同一个 `projectBlocks` ⇒ **没有"正文已收紧、判定还没更新"的窗口**。
- **残余风险（三条，都要写进实现交付说明）**：
  1. **"曾经有权的人"**：他在有权时下载过 / 浏览器缓存过，就永远有那份字节（服务端不可撤回）。这与既有权限模型一致（`access-control.md` 对"已泄露的内容不可追回"没有承诺），但**必须在下线/收紧流程里说明**；
  2. **同一份内容同时被公共页引用**：此时该字节本来就在公共页可见 ⇒ 不算泄露（但"这两处指向同一文件"这个**相关性**本身是信息 —— 见 T7 的 U3/U9 讨论）；
  3. **附件 URL 曾出现在受限段落、之后引用被删** ⇒ 投影里不再有它 ⇒ 永久 404，直到作者重新引用并保存 —— 这是**失败关闭的代价**，需在编辑器 UI 里给出可理解的提示（§7.4）。

### T8 孤儿附件（[P0] 的"磁盘无限增长"面）

- **攻击者能做什么**：① 反复"上传后不保存正文"制造无引用文件（每次 10 MiB）；② 删页/删块制造元数据孤儿；③ 反复上传同一份字节（去重 ⇒ 不涨磁盘，但涨行数）。
- **对策**：§8.1 的孤儿发现（`attachments` 行 vs 磁盘文件双向比对）+ §8.2 的运维端点 + 每页/全库配额。
- **残余风险**：**孤儿不会自动消失**（这是刻意的：见 §8.4）。⇒ 需要一个**约定**：把 `POST /api/admin/attachments/purge` 挂进运维例行流程（或至少让 `GET /api/admin/attachments/orphans` 的计数进监控）。

### T9 磁盘满 / 只读（[P0]）

- **攻击者能做什么**：把磁盘写满（⇒ 附件写失败，**并且** SQLite 写入也会开始失败 ⇒ 全站不可写）。只读挂载或权限错误（`EACCES`/`EROFS`）⇒ 任何上传都失败。
- **对策**：① **存储层的任何失败都映射成 503 `storage_unavailable`**（不按 errno 白名单区分）：`packages/plugin-wiki/src/attachment-store.ts:74-80` 的 `asStoreError` **默认全部按 `storage_unavailable` 处理**，`errno` 只写进消息便于定位；`STORAGE_ERRNO`（`:50`：`EROFS`/`ENOSPC`/`EACCES`/`EPERM`/`EDQUOT`）只用于在消息里标注"已知的存储故障码"。**两条理由（第二条是实测，很关键）**：(a) 这一层只做"我们自己数据目录下的文件 IO"，**任何**失败在语义上都是运维状态；冒成 500 会计入 `stats().consecutiveFailures` ⇒ "磁盘挂载出问题"被升级成"整站被看门狗熔断"（`:33-37`）；(b) **实测：只读文件系统上 `mkdir(…, { recursive: true })` 返回的是 `ENOENT`，不是 `EROFS`**（Node 的递归实现先 stat、再逐级创建，最终把第一次的 ENOENT 抛出来；同一路径上 `mkdirSync` 不带 recursive 才是 `EROFS`，`writeFile` 也是 `EROFS`）⇒ **按 errno 白名单判定会把最常见的只读挂载误报成 500**，而那正是本层最想避免的形态（`:63-72`）。**细节只进日志，不进响应体**（不泄露绝对路径）；② **失败时不得留下半截文件**（`catch` 里 `src.destroy()` + `ws.destroy()` + 删 tmp，`attachment-store.ts:196-201`）与**不得写入元数据行**（先落盘成功、再插行）；③ 启动/激活期自检：`ensureAttachmentDirs`（`:81-88`）幂等建目录并把它也包成 `storage_unavailable`（`packages/plugin-wiki/src/index.ts:642-646` 在激活期调用并把失败写成一条显式日志："附件目录不可用…（上传将返回 503 storage_unavailable）"）；照 `docs/deployment.md:130` 的 `touch /app/data/.w && rm` 范式；是否暴露进 `/api/health` 仍见 U9（**未做**）。
- **残余风险**：磁盘水位没有自动阈值告警（建议运维侧加；也可在孤儿端点里一并返回 `disk_free` —— 需要 `statfs`，Node 内置只支持 `fs.statfs`（Node 18.15+，**本环境 Node v22.23.2 支持**），可选）。

### T10 审计与滥用配额（[P1]）

- **攻击者能做什么**：① 用上传/下载当"免费文件托管"（把 wiki 当图床）；② 上传-删除-上传循环制造审计噪声（把审计表写满）。
- **对策**：① 复用 `writeAuditLog`（`packages/core/src/audit.ts:96-113`）与 `audit_log` 表（`packages/db-sqlite/src/migrations/0013_audit.sql`），新增动作 `attachment.upload` / `attachment.delete` / `attachment.purge`，`target_kind = 'attachment'`；
  **一个必须知道的坑（「已核实」）**：`redactForAudit` 会按**键名**静默删除敏感键（`FORBIDDEN_AUDIT_KEYS`，`packages/core/src/audit.ts:45-59`，含 `content` / `body` / `hash` / `token` / `secret` 等）。⇒ 审计里**不要**用 `hash` 作键名（会被静默吞掉，排障时会以为"没记"）；用 `sha256` 是可以的（不在禁列）。`original_name` 也不在禁列，但**它是用户输入** ⇒ 建议只记长度与前 32 字符（避免把别人的文件名里的敏感词写进审计）；
  ② 配额（§6.3）本身就是反滥用（"图床"被每页 100 MiB 卡住）；③ **只在真的有副作用时写审计**（与 `grants/purge` 的既有纪律一致：`packages/plugin-authz/src/index.ts:865-881` 的注释块末句"每 N 分钟记一条'回收了 0 条'只会把审计淹掉"，实现上的闸门在 `:904`）。
- **残余风险**：没有按用户/按时间的上传速率限制（只有并发闸门）。若需要，加"每用户每小时 N 次"会引入**内存态计数**（多实例失效）或**新的计数表** ⇒ 列 U14。

### T11 图片元数据泄露（[P1]，N5 的直接后果）

- **攻击者能做什么**：从**公共页**下载图片，读 EXIF 里的 GPS / 设备序列号 / 作者名（作者上传了未清洗的原图）。
- **对策**：**本期不做**（N5：不做任何图像处理，因为清洗 EXIF 需要`零依赖手写 JPEG/PNG 段解析`或引入 `sharp` —— 后者是**重量级原生依赖**，与 G4 冲突）。
- **残余风险**：**明确接受**，但必须在**编辑器 UI 的提示**里写一句"上传的图片会原样发布，含相机元数据"（一句文案的成本，换来作者知情）。⇒ 列为实现交付项。

### T12 跨站请求与"附件 URL 被当作 CSRF 的跳板"（[P1]）

- **攻击者能做什么**：用 `<img src="http://wiki/api/attachments/xxx">` 让受害者浏览器发起**带 cookie** 的 GET（这正是 CSRF 的形态之一）。下载是 GET ⇒ 无状态变更 ⇒ **无害**。但**上传**是 POST/PUT ⇒ 有状态变更。
- **对策**：上传经 `checkCsrf` 三道判据（`packages/plugin-auth/src/http.ts:108-145`）；**注意第 3 条只在"带会话 cookie"时要求自定义头**（该函数注释解释了这个边界是刻意的：脚本/break-glass 天然免疫）。⇒ 我们的上传端点**不需要也不应该**自己加 CSRF 逻辑（那会变成第二个真源）。
- **残余风险**：`Sec-Fetch-Site` 在**老浏览器/命令行**缺失时该条判据被跳过（函数注释已声明这是刻意的），靠第 2、3 条兜底。

---

## 6. 限制与配置

### 6.1 配置项（插件配置 · `schemastery` Schema）与常量（「设计决策」D16）

**既有写法（「已核实」）**：`packages/plugin-wiki/src/index.ts:123-129`：

```ts
export const WikiConfigSchema = Schema.object({
  recentVersions: Schema.number().default(10).min(1).max(100).description('页面详情返回的最近版本历史条数上限'),
})
```

并在 `manifest.geewiki.configSchema` 上声明（`:300`）。管理台按 schema 渲染表单（`packages/web/src/api.ts` 的 `ConfigSchemaPayload` 等即为此）。

**附件配置面（五项已落地，见 `packages/plugin-wiki/src/index.ts` 的 `WikiConfigSchema`；定位以符号名为准，行号见文首说明）**：

| 配置键 | Schema | 默认值 | 状态 |
|---|---|---|---|
| `attachmentMaxBytes` | `Schema.number().min(0)`，**`.default(NO_SIZE_LIMIT)` = 0 ⇒ 不限**（2026-09-21） | **0 = 不限**（真源：`packages/plugin-wiki/src/attachments.ts` 的 `NO_SIZE_LIMIT`）。~~原默认 `DEFAULT_MAX_BYTES` = 25 MiB~~（`packages/plugin-wiki/src/attachments.ts:59-60`） | ✅ 2026-09-21 改为**出厂不限**（用户要求「把附件上传的大小上限也去掉」）。**原口径**：`min(1).max(200*1024*1024)`、默认 25 MiB，上界硬编码的理由是「并发上传打满内存/磁盘」——但字节是**流式写盘**的（`storeStream` 逐块写 + 背压），打不满内存，真实代价只有磁盘 ⇒ 闸门交给运维：**设成正数即恢复限额**。`.max()` 随之删除：默认既是「不限」，再给配置值设上界就自相矛盾 |
| `attachmentPageQuotaBytes` | `Schema.number().min(0)`，**`.default(NO_SIZE_LIMIT)` = 0 ⇒ 不限**（2026-09-21；原默认 200 MiB） | 0 = 不限 | ✅ 已落地。这就是"每页配额"。上传端点在读体**之前**用声明长度预检（`packages/plugin-wiki/src/index.ts:3191-3207`，超限 ⇒ **413 `page_quota_exceeded`**），权威判定在写入事务里（`:3074-3079`） |
| `attachmentAllowedExt` | `Schema.array(Schema.string())` | `[...ATTACHMENT_EXT_WHITELIST]`（16 项） | ✅ **已落地**（`:163-172`）。**只能收窄、不能放宽**：`apply` 里取**交集**（`:628-632`），"放宽会让 `.html` 这类同源可执行内容进得来，而落盘路径的 `attachmentRelPath` 断言仍按内置白名单校验 ⇒ 要么静默失败、要么（更糟）被绕过"；**收窄只影响新的上传**（已收录附件的**下载不查这个集合**，否则一改配置历史附件会集体 404）。⇒ 这条配置**不违反** §6.2 的"白名单是安全边界"原则（它只能收紧），**已验证的 schemastery 数组写法是 `Schema.array(Schema.string())`** |
| `attachmentInlineSvg` | `Schema.boolean()` | `false` | ✅ **已落地**（`:173-176`，描述里写明"默认关闭：同源内联 SVG 可执行脚本 = 存储型 XSS，除非另配 CSP"）。语义在 `dispositionKindOf(ext, { inlineSvg })`（`packages/plugin-wiki/src/attachments.ts:162-165`，**尚未被下载端点接上**，见下） |
| `attachmentProvider` | `Schema.union([Schema.const('builtin'), Schema.const('none')])` | `'builtin'` | ✅ **已落地**：附件**字节存储**由谁提供。`'builtin'` = 本插件自带的本地实现（内容寻址，向后兼容）；`'none'` = 本插件**不再注册**内置实现，改用别处 `ctx.provide('attachment-service', …)` 提供的实现（换 S3/WebDAV 不必改 wiki 源码）。**为什么不自动探测"别人提供了没有"**：cordis 服务在提供者的 `apply()` 结算前对其它插件不可见（`ctx.get` 返回 undefined 且**静默**）⇒ 自动探测会在激活顺序变化时悄悄退回内置实现或悄悄拿不到服务；显式配置让这件事在配置里可见 |
| `repoQuotaBytes`（全库配额） | —— | —— | ❌ **未实现**（本文建议；见 §6.3 与 U5） |
| `maxConcurrentUploads` | —— | —— | ❌ **未实现**（本文建议；T4） |
| `uploadTimeoutMs` | —— | —— | ❌ **未实现**（本文建议；注意 HTTP 层**没有任何超时**，§0.1 事实 6） |
| `attachmentDir` | —— | —— | ❌ **未实现**（不需要：目录来源由调用方解析 —— `attachmentsRoot`/`attachmentsTmpDir` 在 `apply` 里算出（`packages/plugin-wiki/src/index.ts:608-622`）并作为参数传给 `storeStream`/`ensureAttachmentDirs`，见 `packages/plugin-wiki/src/attachment-store.ts:81-88`、`:114-120`） |

**一处需要核对的接线**：`attachmentInlineSvg` **已进 schema、语义已实现，但下载端点的 `dispositionKindOf` 调用是否真的把该配置传进去了，我**没有**逐字核对（我看到的是 `content-disposition: formatDisposition(dispositionKindOf(row.ext, { inlineSvg: … }), …)` 的形态）⇒ **实现者/评审者请确认这条接线**（若忘传，`.svg` 会永远走 `attachment` —— 那是**更保守**的方向，不是漏洞，但会让配置项看起来"没生效"）。

**刻意**不**做成配置的三项（每项都有理由）**：

1. **扩展名白名单 = 代码常量**（§6.2）。理由：**白名单是安全边界**，而插件配置是**热改**的（`POST /api/plugins/:name/config` ⇒ 立即生效 —— 见 `packages/core/src/index.ts` 的 `supportsHotReload` 语义）；把安全边界交给"运维在界面上填的字符串数组"= 允许一次误操作把 `.html` 加进去，且**没有守卫测试能发现**。写成常量后可被源码级守卫测试钉住（照 `packages/plugin-wiki/test/blocks.test.ts` 的既有做法）。**M1 与本文完全一致**（`ATTACHMENT_EXT_WHITELIST` 是 `readonly string[]` 常量，且注释写明"白名单的失败方向是'少收几种文件'"）。
2. **`tmp` 目录名 / 分片层级 = 常量**。它们与磁盘布局绑定，改了要迁移，不是"配置"。**M1 一致**（分片在 `attachmentRelPath` 里写死，`:131-139`）。
3. **`nosniff` / `content-disposition` 策略 = 常量**（但给 `.svg` 开了一个**配置口子** `attachmentInlineSvg` —— **建议把该开关的默认值保持 `false`，并在打开时强制要求 CSP**）。

**两道大小闸默认不限之后，仍然拦得住大文件的四道闸（2026-09-21，评审必读）**：

| 闸 | 位置 | 症状 |
|---|---|---|
| 磁盘余量 | 内置 provider 写盘（`storeStream`）| 写满 ⇒ `storage_unavailable` ⇒ **503**（不是 500：那会计入连续失败并可能触发熔断） |
| **反代的 body 上限** | 部署层，**本仓管不着** | nginx `client_max_body_size` **默认 1 MB** ⇒ 大附件在**进入 Node 之前**就被 413（且响应不是本服务那个带 `error` 字段的形状）。⇒ 要真的传大文件，反代必须显式放宽；Caddy/Traefik 的默认值各不相同，**未在本仓实测** |
| `Content-Length` 必须存在 | 上传端点入口 | 缺它 ⇒ **413 `length_required`**。不限大小之后它的理由**换了**：不再是"上限无法前置判定"，而是"无法与实收字节数对照"（`length_mismatch` ⇒ 400） |
| 扩展名白名单 | `assertExtAllowed`（收流之前）| 白名单外 ⇒ **415**，且**不收一个字节** |

⇒ **仍未实现**的三项在"不限大小"之后代价变高：**并发上传闸门**（U14 / `maxConcurrentUploads`）、**上传超时**（U8）、**全库配额**（U5 `repoQuotaBytes`）。今天一个已登录用户可以不间断地往磁盘里写；把这三项补上之前，"不限"只对**已鉴权**流量安全（匿名流量在网关层就要 401）。

**配置校验的边界**：`attachmentMaxBytes` 必须 ≤ `pageQuotaBytes` ≤ `repoQuotaBytes`（0 = 不限，任何非 0 值都视为"设了闸"）（不满足时**启动即报错并拒绝激活**，而不是静默按更小的那个跑 —— 与仓库"失败关闭 + 可观测"的口味一致）。

### 6.2 扩展名白名单（M1 的实际清单就是当前真源）

**M1 的清单就是当前真源（「已核实」）**：`ATTACHMENT_EXT_WHITELIST`（`packages/plugin-wiki/src/attachments.ts:38-55`），**16 项**：

| 类别 | 扩展名（M1 实际） | `content-disposition`（M1 实际） | 与本文初稿的差异 |
|---|---|---|---|
| **光栅图片** | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.avif` | `inline` | 一致 |
| **矢量图** | **`.svg`**（**在白名单里**） | `.svg` ⇒ **`attachment`**（默认；`attachmentInlineSvg=true` 才 `inline`） | **分歧 3**：本文 U3 建议"默认不进白名单"。M1 的选择是"**收进来但强制下载**" —— 这条其实**更接近 U3 的候选 B**，且注释把理由写足了（同源内联 SVG 可带 `<script>` ⇒ 必须走下载）。⇒ **可接受**，但**必须**保证：① 默认 `attachmentInlineSvg` 为 `false`；② 一旦有人打开它，`content-security-policy` 必须同时存在（本文 §4.6 的 D14） |
| **文档** | `.pdf` `.txt` `.md` `.csv` **`.json`** | `inline`（**含 `.pdf`**）；其余 `attachment` | **分歧 4**：`.pdf` 被列入 `INLINE_EXTS`（见 §4.6 的 U20）；**`.json` 在白名单里**。`.json` 的风险低于 `.html`（`nosniff` + `application/json` 下浏览器不会当脚本执行，且它不在 `INLINE_EXTS` ⇒ 强制下载），**但它是"可被程序当数据加载"的类型** ⇒ 建议保留"强制下载"这条现状即可，别把它加进 `INLINE_EXTS` |
| **归档** | `.zip` | `attachment` | 一致 |
| **办公文档** | `.docx` `.xlsx` `.pptx` | `attachment` | M1 **不含** `.odt/.ods/.odp` ⇒ **以 M1 为准**（少收比多收安全；要加再单独加） |
| **禁用（M1 注释明确列出）** | `.html` `.htm`（同源 HTML 可执行脚本）、`.php` `.js` `.mjs` `.sh` 等可执行/可被解释的扩展名、**无扩展名 / 以点开头（隐藏文件）/ 以点结尾** | — | 一致（M1 的注释 `:34-36` 与 `:105-108` 把这几类逐条写明，并解释了"黑名单永远列不全，漏一个就是 RCE"） |

**`ext → mime` 映射表**：M1 的 `MIME_BY_EXT`（`packages/plugin-wiki/src/attachments.ts:73-90`）就是它；**不要**复用 `packages/server/src/index.ts:799-821` 的 `STATIC_MIME`（那份还含 `.html`/`.js`/`.wasm`，是静态资产的映射，语义不同）。⇒ 见 §4.6 那条**漂移陷阱**：两张表必须由守卫测试钉住键集合相等。

**大小写与规范化（M1 的规则更明确，采纳之）**：`normalizeExt(rawName)`（`packages/plugin-wiki/src/attachments.ts:112-118`）取**最后一个 `.` 之后**的片段并 `.toLowerCase()`，命中白名单才返回；否则 `null`。⇒ 语义是：
- `evil.php.png` ⇒ `.png`（**接受**：用户看到的是图片 ⇒ 按图片处理；这条比"一律拒绝多扩展名"更符合直觉，且**安全上等价** —— 生效的永远是最后一个扩展名）；
- `x.php` ⇒ `null`（拒）；`x` / `x.` / `''` ⇒ `null`（拒）；`A.PNG` ⇒ `.png`（归一）。

### 6.3 配额与并发（「设计决策」D18）

- **求和口径**：`SELECT COALESCE(SUM(bytes),0) FROM attachments WHERE page_id = ? AND deleted_at IS NULL`（走 `idx_attachments_page`）；全库同理（**全库求和是 O(行数)** ⇒ 用 `idx_attachments_sha` 也不行；建议对全库配额做**进程内缓存 + TTL**（例如 30 秒）或**只在写入前抽查**，并在 U5 里给出取舍）。
- **判定时机**：**读体之前**用 `Content-Length` 预检（413 `page_quota_exceeded`；`repo_quota_exceeded` **未实现** —— 全库配额不存在，见 §10.0），**落盘之前/写入事务里**再核一次（防并发超发；实现是 `writeAttachmentRow` 里的 `SELECT COALESCE(SUM(byte_size),0) …`，`packages/plugin-wiki/src/index.ts:3107`）。
- **并发**：进程内计数（`maxConcurrentUploads`），超限 429。**不引入锁表 / 分布式信号量**（多实例不在本能力承诺内，见 T4）。
- **PG 的坑**：`SELECT SUM(bytes)` 在 PG 下**可能返回字符串**（`bigint` 的既有坑，工程约定见 `docs/development.md`「PostgreSQL 方言差异」）⇒ **必须 `Number()` 强转**。

---

## 7. 前端交互

### 7.1 编辑器内三条路径（「设计决策」D19）

| 路径 | 触发 | 实现要点 |
|---|---|---|
| **拖拽** | 拖文件到 CodeMirror 编辑区 | CodeMirror 6 的 `EditorView.domEventHandlers({ drop })`（**不需要拖放高亮库**）。编辑器当前**没有**注册 drop 处理器，但**已有** `dropCursor()` 扩展（`packages/web/src/components/MarkdownEditor.tsx:32`）⇒ drop 会**默认插入文件名文本**，因此处理器**必须 `preventDefault()`**，否则会出现"文字里冒出一个本地文件名"的怪状态 |
| **粘贴** | 在编辑区 `Ctrl/Cmd+V` 粘贴图片（截图） | `domEventHandlers({ paste })`：`e.clipboardData.files` 非空 ⇒ `preventDefault()` + 上传。**不要**拦所有粘贴：含文本的粘贴必须保持默认行为 |
| **工具栏** | 点"插入图片/附件"按钮 | 新增一个 `<input type="file" accept="<白名单>">`（视觉隐藏）或命令面板项。**CodeMirror 的 keymap 已有先例**（`Mod-s` / `Mod-b` / `Mod-f`，`packages/web/src/components/MarkdownEditor.tsx:230-245`）⇒ 建议同时给一个 `Mod-Shift-I` 之类的快捷键（U15） |

**三条路径共用的上传函数**（「设计决策」）：

```ts
// 不能走 api.ts 的 request()：它只发 JSON（packages/web/src/api.ts:81-88）
await fetch(`/api/attachments/${encodeURIComponent(slug)}?name=${encodeURIComponent(file.name)}`, {
  method: 'PUT',                    // 路径与动词以 M1 为准（§4.2）；语义松紧见 U18
  headers: { 'content-type': file.type || 'application/octet-stream', 'x-gw-csrf': '1' },
  body: file,                       // 原始字节：file 本身就是 Blob，零转换
  credentials: 'same-origin',
})
```

- **`x-gw-csrf: 1` 必须带**（有会话 cookie 时服务端强制要求，§4.1）；
- **`content-type` 用 `file.type`**：服务端会按白名单校验"声明的类别"（T2 对策①）；`file.type` 为空时退回 `application/octet-stream`（服务端按 `filename` 的扩展名判定，**仍然只作白名单校验、不作路径**）；
- **零依赖**：`File` / `Blob` 直接作为 `fetch` 的 body，不需要 FormData（这正是 D4' 换来的好处）。

### 7.2 上传中的占位与失败重试（「设计决策」D20 —— **已实现**）

**M1 的 `packages/web/src/lib/attachmentPlan.ts` 已经把这一节的全部要求做成了可单测的纯函数**（「已核实」，190 行）：

| M1 的实现 | 位置 | 与本文的关系 |
|---|---|---|
| 占位串 `![上传中…](uploading-<seq>)`（伪 scheme `uploading-`，**刻意不是** `/api/attachments/`，避免被附件规则误伤） | `attachmentPlan.ts:79-88`（`UPLOAD_PLACEHOLDER_LABEL` / `UPLOAD_PLACEHOLDER_SCHEME` / `uploadPlaceholder(seq)`） | 满足 D20 的"立即插入占位" |
| **按文本查找占位**而不是按偏移量替换：`findUploadPlaceholder(doc, placeholder)` 返回 `{from,to}` / `null` | `:112-115` | **真机上的关键**：上传期间用户继续打字会让偏移量失效；理由写在文件头 `:11-20`（"用旧偏移量去替换，轻则替换错位置，重则把用户刚敲的一行吃掉"）。**找不 ⇒ 什么都不做**（用户自己删了占位就是明确意图） |
| 占位**带序号** | `:86-88` + 文件头 `:22-27` | 一次拖入 3 个文件时，占位若完全相同 ⇒ `indexOf` 只命中第一个 ⇒ 后两个结果全盖到同一处 |
| 失败态：`> ⚠️ 上传失败：<单行化 + 截断 120 字符的原因>` | `:118-142`（`UPLOAD_FAIL_PREFIX` / `UPLOAD_FAIL_REASON_MAX` / `uploadFailureText` / `uploadFailureMarkdown`） | 满足 D20 的"失败留可见标记"；**"原因必须单行化"**（换行会把引用块截断、后半句变成正文） |
| 一批结束的**状态行文案**：`已插入 N 个附件；M 个失败（正文里已留下失败说明，可重试）；K 个占位已被删除，未插入` | `:144-155`（`uploadSummaryText(inserted, failed, missing)`） | 满足 D23 的"`role="status"` 播报"；三种结局**各自说清**，其中 `missing`（占位被用户删掉）是第三种状态 |
| 插入语法：图片 `![名](url)`、非图片 `[名](url)`；链接文本只转义 `[`/`]`/换行 | `:72-78`（`attachmentMarkdown` / `escapeLinkText`） | 满足 D21；M1 的"**过度转义会让用户看到一堆反斜杠**"是一条好判据（`：68-71`） |
| 前端图片扩展名表 `.svg` **包含**在 `IMAGE_EXTENSIONS` 里，且注释明确"与后端白名单**不是一回事** —— 这里只分流渲染语法，不做拦截" | `:31-40` | **与本文的 U15 建议一致**（"镜像 + 守卫测试"，不要试图共享模块）；M1 的注释还给出了正确的失败方向（"据此拒绝上传则是越权替后端做判断"） |

⇒ **本节要求已被 `attachmentPlan.ts` 全部覆盖，并以三处细化**（按文本替换、失败原因单行化、第三种结局 `missing`）。实现以该文件的函数为准，本文只保留"必须做到什么"的清单。

### 7.3 插入的 Markdown 形态（「设计决策」D21）

```markdown
![架构图](/api/attachments/42)
[季度报表.pdf](/api/attachments/57)
```

- **用绝对路径 `/api/attachments/<id>`**（不带 host）：正文要能在**不同部署地址**下都可用；
- **`alt` 文本用清洗后的 `original_name`**（去扩展名亦可）：`marked` 会把它渲染成 `alt`，对读屏与破图态都重要；
- **`sha256` 不进 URL**：URL 里的标识**只有一个** —— 现行实现是自增整数 `id`（`packages/plugin-wiki/src/attachments.ts:163` 的 `attachmentUrl(id)`）；"换成不可枚举标识"的取舍与提议见 §4.2 与 U19；
- **一个必须核对的既有行为**：正文渲染的后处理**只改写 `a[href]`**（`packages/web/src/lib/markdownRender.ts:81` 的 `holder.querySelectorAll('a[href]')`），**不碰 `img[src]`** ⇒ 图片链接**不会被**误判成"站内页面链接"而改写成 `#/wiki/...`（**现状正确，但这是巧合而非契约** ⇒ 建议补一条单测钉住它，见 §9.1）；
- **`<img>` 能带 cookie**：会话走 `HttpOnly` cookie（`packages/web/src/api.ts:67-69` 的注释）⇒ `<img src="/api/attachments/<id>">` 会**自动带 cookie**（同源），因此**受限附件对有权读者能直接显示**，无需签名 URL 或 blob 下载。推论：`<img>` 的加载失败（403/404）**没有可读的错误信息** ⇒ 这正是 §7.4 "不能显示破图"的原因；
- **`DOMPurify` 默认会保留 `img src`**（「已核实」：`packages/web/src/lib/sanitize.ts:13-16` 的 `mdToHtml` 用 `DOMPurify.sanitize(raw)` **不带配置**；DOMPurify 3.4.15 的 `DEFAULT_DATA_URI_TAGS = ['audio','video','img','source','image','track']`（`node_modules/.pnpm/dompurify@3.4.15/node_modules/dompurify/dist/purify.cjs.js:743`）与 `IS_ALLOWED_URI`（`:325`）允许 http/https/**相对路径**）⇒ 我们的相对 URL 与 `data:` URI 图片**都会保留**。**这是既有行为，本设计不改消毒链路**（`markdownRender.ts:1-33` 明写"消毒链路是唯一出口"，本设计不改消毒链路）——但 `data:` 图片会被保留这一点**对附件设计有影响**：作者可以**内联** base64 图片绕过附件端点（⇒ 那些图片**不受任何附件判定约束**，且会撑大正文撞 500KB 上限）。⇒ 见 U16。

### 7.4 正文渲染时的失败态：**显示占位文案，不是破图**（「设计决策」D22）

**问题**：读者打开一页，正文里有一张他无权下载的附件（或该附件已被回收）⇒ `<img>` 只会显示**破图图标**，读者不知道发生了什么，而且破图本身**暴露了"这里有一些你看不到的内容"**（比"完全不出现"更差）。

**决策（三层）**：

1. **服务端先裁剪**：正文投影（`projectBlocks`，`packages/plugin-wiki/src/blocks.ts:751`）会把"读者看不到的块"替换成**显式占位**：

   ```ts
   const suffix = reader.anonymous ? '需登录查看' : '需更高权限查看'
   out.push(`> 🔒 此处有 ${gatedRun} 段内容${suffix}`)   // :782-784
   ```

   ⇒ **受限段落里的附件链接根本不会到读者手里**（它们在被遮蔽的块文本里）—— 这是第一层，也是最关键的一层。
2. **到了浏览器才失败的两种情况**：① 页面**可见**、附件**不可见/已不在**（实际成因：**该 URL 已不在读者的可见投影里**，例如引用被删、块被收窄、或元数据行已被删除）；② 网络/存储故障。两种情况都不能显示破图。
3. **前端的失败态**（「设计决策」）：给 `<img>` 加 `onError`（在 `MarkdownBody` 的事件委托容器上 `capture` 阶段监听 `error` 事件，因为 DOM 是 `innerHTML` 注入的、React 管不到子树 —— 既有做法见 `packages/web/src/components/MarkdownBody.tsx:100-106` 的注释与 `:117-149` 的复制按钮**事件委托**范式）⇒ 把该 `<img>` 替换成：

   ```
   > 🔒 此处有一张图片，你没有查看权限或它已被移除
   ```

   **措辞必须与 `projectBlocks` / `gatedPreview` 的既有文案**同族（`需登录查看` / `需更高权限查看`），并且**不区分**"无权限"与"已删除"（区分就等于给出存在性预言机）。
   **纯前端替换只是体验，不是安全**（`access-control.md` §9 R10 反模式 5）：真正的边界在 §4.3 的服务端判定。

**可测量的判据**：e2e 里"越权下载返回 404"（服务端）+ 前端守卫测试里"渲染失败态不出现 `src` 原值"（§9.1）。

**本节已实现（「已核实」，`packages/web/src/lib/attachmentPlan.ts:158-190`）**，两处细节：

| M1 | 位置 | 说明 |
|---|---|---|
| `data-gw-attachment` / `data-gw-attachment-slug` 标记属性（渲染层注入，捕获阶段据此判断"这张图该不该兜底"） | `:160-166` | 对应本文 §7.4 第 3 点的"事件委托 + 捕获阶段" |
| `data-gw-attachment-blocked`：**同一个 `<img>` 的 `error` 可能触发多次 ⇒ 必须只替换一次** | `:168-169` | 本文没写这条幂等要求 |
| 占位文案 **`此处附件无权访问或被删除`** + 解释 `ATTACHMENT_BLOCKED_REASON` | `:178-186` | **措辞诚实**：它明确写出"浏览器对 `<img>` 的加载失败只给一个 `error` 事件、**不带状态码** ⇒ 403 与 404 在这里**完全无法区分**，写成'你没有权限'是把猜测说成事实"。⇒ **采纳这条文案与理由**（与 D22 的"不区分无权与已删"同向，但把"为什么无法区分"这个证据层面的原因写清了） |
| `data-gw-apply-access` + 文案 `申请访问` / `已提交申请，等待处理` | `:188-190` | 破图占位里可以放"申请访问"入口（复用既有访问申请流程，`packages/plugin-wiki/src/index.ts:2368` 的 `POST /api/pages/:slug/access-requests`）⇒ 把"看不到"变成"有下一步动作"。**建议保留** |

### 7.5 可访问性要求（「设计决策」D23）

| 要求 | 具体 | 既有依据 |
|---|---|---|
| **键盘可达（三条路径都要）** | 工具栏按钮必须是真 `<button>`（可 Tab / Enter / Space）；拖拽路径**必须有**键盘替代（否则纯键盘用户无法上传）；CodeMirror 内的命令要有 keymap 项 | CodeMirror 的 `EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel })` 既有做法（`packages/web/src/components/MarkdownEditor.tsx:224`，注释解释了"可访问名称必须落在真正可聚焦的 `.cm-content` 上"）；外层容器**刻意不带** ARIA（`packages/web/src/components/MarkdownEditor.tsx:285-297`，注释原话"no ARIA is better than bad ARIA"） |
| **`role="status"` 播报上传结果** | 上传中 / 成功 / 失败都写进一个 `role="status"`（隐式 `aria-live="polite"`）的元素。**不要**用 `aria-live="assertive"`（上传成功不是紧急事件） | 仓库既有 15+ 处 `role="status"` 用法（`packages/web/src/pages/WikiPage.tsx:530-534`、`packages/web/src/lib/newPageGate.tsx:107,146` 等），文案风格可直接照抄 |
| **目标尺寸** | 工具栏按钮热区 ≥ 24×24 CSS px（WCAG 2.2 SC 2.5.8 最低 24px；建议与既有按钮一致，取 32px 高） | 仓库没有专门的目标尺寸规范 ⇒ 建议按既有按钮组件尺寸（`text-note` 级按钮） |
| **图片的 `alt`** | 插入 Markdown 时**默认填** `original_name`；`alt` 为空时（作者删掉了）前端失败态仍要有文字占位 | 见 §7.3 |
| **对比度** | 失败态的提示文案用既有 token（`text-warn-ink` 一类），不要引入新颜色 | `packages/web/src/pages/WikiPage.tsx:534` 的 `text-note text-warn-ink` 是既有用法 |
| **真浏览器验证** | 上述每一条都**必须**在真实浏览器里用键盘 + 读屏验证（§9.3）—— 仓库既有诚实声明："**真实浏览器交互从未验证**"（工程约定见 `docs/development.md`「验收与验证纪律」） | — |

---

## 8. 清理与运维

### 8.1 孤儿附件的发现（「设计决策」D24 —— **GC 未实现**）

**GC / 孤儿回收端点尚未实现**（属后续工作）。`DELETE /api/attachments/:id` **只删元数据行、不删磁盘文件**（`packages/plugin-wiki/src/index.ts:3642-3646`：内容寻址下同一份字节可能被他页共享，顺手 `unlink` 会造成**跨页破图**且极难归因）⇒ **当前磁盘只增不减**，这是本能力**最该跟进的一项**。

**实际可用的判据只有"文件系统 ↔ 表"两个方向**（迁移头注 `packages/db-sqlite/src/migrations/0018_attachments.sql:26-28` 把这两条写成了设计的一部分）：

| # | 形态 | 判据（SQL / 文件系统） | 归属 | 实现状态 |
|---|---|---|---|---|
| 1 | **有文件无行**（`untracked_file`） | 遍历磁盘上的对象文件（`data/attachments/aa/bb/<sha><ext>`），`SELECT COUNT(*) FROM attachments WHERE sha256 = ?` 为 0（走 `idx_attachments_sha`） | **可回收**（正常也可能是故障：落盘成功但插行失败） | 判据已确定（迁移头注写明"'数据库里没有的文件'是**可检测**的（GC 的判据）"）；**端点未做** |
| 2 | **有行无文件**（`blob_missing`） | 行在，但 `resolveAttachmentPath(...)` 指向的文件 `stat` 失败 | **故障**（崩溃/误删/热备份恢复） | ✅ **已实现**：下载端点显式报 **404 `blob_missing`**（`packages/plugin-wiki/src/index.ts:3455-3463`），且"元数据在、文件不在"是可诊断状态而不是 500；尺寸与 `byte_size` 不符时**只 warn 不拦**（`:3464-3470`） |
| 3 | **`tmp/` 残留** | `tmp/` 下 mtime 明显偏旧的文件 | **故障残留**（超时/崩溃）⇒ 可直接删（它从未进入正式路径、不涉及任何判定） | 存储层已保证正常路径会删 tmp（`discardTmp`，`packages/plugin-wiki/src/attachment-store.ts:141-146`）；**扫 tmp 的端点未做**（且**上传超时也还没有**，见 §10.0） |
| 4 | **无引用行**（`unreferenced`） | 行存在，但**正文里没有任何地方引用它** | **正常**（作者传了没插、或把引用删了） | **这条判据没有持久化载体**：它需要知道正文引用，而本能力**不建派生表**（U22）⇒ 若将来要做这条清理，只能(a)现场扫正文（会造出第二个解析实现，**不推荐**）或(b)重新引入派生表（有漂移风险）。⇒ **建议先不做这条**，只做上面第 1、3 条（它们不依赖正文） |

**一条纪律（不变）**：**不要**在运维端点里"现场重新解析全部正文"来推断引用（那会造出第二个解析实现 ⇒ 漂移；与 `blocks/verify` 探针的既有分工一致：探针比的是"重新解析结果 vs 库里的行"，而 `blocks` 的行由 `syncBlocksForPage` 单点维护）。

### 8.2 运维端点（「设计决策」D25 —— **均未实现**，本节是待做规格）

**两个端点，一读一写，全部 `access: 'admin'`，路径照既有惯例（`/api/admin/...`）** —— **两者目前都不存在**（`grep -c "orphan\|purge" packages/plugin-wiki/src/index.ts` ⇒ 仅 1 处命中，且那是既有的 `block_grant_orphan` 注释）：

| 端点 | 语义 | 响应（建议形状） |
|---|---|---|
| `GET /api/admin/attachments/orphans` | **只读发现**：返回 §8.1 实际可用判据（`untracked_file` / `blob_missing` / `tmp_stale`）的计数与（分页的）明细；**不删任何东西、不留任何状态** | `{ ok: true, untracked_file: n, blob_missing: n, tmp_stale: n, items: [...], disk_free: …? }` |
| `POST /api/admin/attachments/purge` | **只做空间回收**：删掉"没有任何元数据行指向"的物理文件（+ 陈旧 tmp），返回 `{ ok: true, removed, freed_bytes, remaining, at }` | 与 `POST /api/admin/grants/purge`（`packages/plugin-authz/src/index.ts:880-881` 注册、`:904` 的"真回收才写审计"闸门）、`POST /api/org/invitations/purge`（`packages/plugin-org/src/index.ts:949` 注册、`:975` 同款闸门）**同款形状** |

**必须逐条对齐的既有纪律（「已核实」的三条）**：

1. **明确声明"这不是让什么失效的手段"**：`grants/purge` 的注释原话是"⚠️ **这不是'让过期授权失效'的手段** —— 失效在**判定时**就已经发生"；`invitations/purge` 同款。⇒ 附件版的对应句要按**实际语义**写（**已无软删列**，见 §4.5）：**"行没了"在 `DELETE FROM attachments` 提交的那一刻就已生效**（判定与列表都查不到它），而**磁盘上的字节**没有任何判定语义 —— `purge` **纯粹是磁盘回收**。
   为什么非要把这层区分写进注释与响应：一旦它被当成"失效开关"，就会派生出"GC 没跑 ⇒ 删掉的附件仍可下载"这种最糟的误解 —— 而那是**失败开放**方向。
2. **只在真的回收了东西时才写审计**：`if (expired > 0) { … writeAuditLog(…) }`（`packages/plugin-authz/src/index.ts:904`，动作码 `admin.grants_purge` 在 `:906`）。空跑没有副作用，每 N 分钟记一条"回收了 0 条"只会把审计淹掉。⇒ 附件版：`if (removed > 0)`（动作码建议 `attachment.purge`，`target_kind = 'attachment'`）。
3. **响应里同时给"本次回收数"与"还剩多少"**（`{ expired, remaining }` 的既有形状）⇒ 附件版给 `{ removed, freed_bytes, remaining }`。

**`purge` 只删文件，不删行**：**行不该由 GC 删** —— GC 的职责是"删磁盘上的多余字节"，行是业务数据、已由 `DELETE` 端点管理（实际表结构也没有 `deleted_at`，§3.1）。这也符合"只做空间回收"的原始语义：它回收的是**空间**，不是**记录**。

### 8.3 审计（「设计决策」D26 —— **只有 `attachment.upload` 与 `access.denied` 已落地**）

**复用既有 `audit_log` 表**（**不新表**），动作与目标：

| `action` | `target_kind` / `target_id` | `after` 里放什么 | 什么时候写 |
|---|---|---|---|
| `attachment.upload` | ✅ **已实现** | `attachment` / `String(outcome.id)` | `{ page: <slug>, sha256, ext, byte_size, mime }` | **只在真的新增了元数据行时写**（`packages/plugin-wiki/src/index.ts:3314-3325`）；**幂等重放（`dedup`）不重复留痕**（理由在 `:3314-3318`：与"下载不写审计"同一条 —— 高频重复事件会把审计表冲垮）。实现方逐字引用了本文 T10 的坑：**字段名必须是 `sha256` 而不是 `hash`**，否则被 `redactForAudit` 静默删掉（`:3316-3320`，对照 `packages/core/src/audit.ts:45-59`） |
| `attachment.delete` | ❌ **未实现**（建议补） | `attachment` / `<id>` | 建议 `{ page: <slug>, uploaderId }`（**不要**整条 `original_name`） | 目前成功删除**不写审计**（`:3706` 只做 `DELETE FROM attachments` + 响应）⇒ **"谁删了哪个附件"当前查不到**。⇒ 这是本能力审计面**唯一的功能缺口**（`access.denied` 侧已覆盖越权删除尝试） |
| `attachment.purge` | ❌ **未实现**（GC 未做） | `attachment` / `attachments` | `{ removed, freed_bytes, remaining, at }` | 运维回收**真删了东西**时（§8.2） |
| `access.denied` | ✅ **已实现**（复用既有 `recordAccessDenied`） | **`page`** / `<slug>`（**不是** `attachment`） | `{ reason, principalKind }`（`reason` ∈ `no_read_access` / `attachment_gated` / `no_edit_access`） | 下载与删除的越权分支（`packages/plugin-wiki/src/index.ts:3429`、`:3469`、`:3681`、`:3698`）。`target_kind` 是 **`page`** 而非 `attachment` —— 因为复用的是既有函数（**不造第二个真源**，这比"字段更贴切"更重要）；附件特有的原因已由 `after.reason` 分出 |

**为什么复用而不新表**：① `audit_log` 已经是"ACL 与安全事件"的统一去处（`0013_audit.sql` 的表注释定义了 action / target_kind 约定）；② 新表会让 `GET /api/admin/audit` 的两视图（`acl` / `security`，工程约定见 `docs/development.md`「验收与验证纪律」）看不到附件动作 ⇒ 运维要在两个地方查；③ **分类要显式**：`attachment.upload` / `attachment.delete` 属 `acl` 视图（合规记录），`access.denied` 属 `security` 视图（越权尝试要告警）。该端点用**显式白名单**而非排除法（工程约定见 `docs/development.md`「验收与验证纪律」记录的理由："白名单让未分类的动作只出现在 `all` 里，漏分类是**可见的**"）⇒ **必须把新动作加进白名单**，否则它们只在 `all` 视图可见（这是**刻意的可见失败**，但实现时要记得加）。

**不要记进审计的东西**：附件**字节**绝不入审计；`original_name` 只记清洗后的摘要（§T10 的坑）；**不要**用 `content`/`body`/`hash`/`token` 作键名（`redactForAudit` 会静默吞掉，`packages/core/src/audit.ts:45-59`）。

**已核实的一处缺口（**建议补**）**：`GET /api/admin/audit` 的**显式白名单**里**没有** `attachment.upload` —— `ACL_ACTIONS`（`packages/plugin-authz/src/index.ts:715-746`）与 `SECURITY_ACTIONS`（`:708-714`，含 `access.denied`）都不含它。⇒ **上传动作目前只在 `all` 视图可见，`acl` 视图看不到**。这正是 `docs/development.md`「验收与验证纪律」说的"用显式白名单而非排除法 ⇒ 漏分类是**可见的**"那种失败：**不会报错，但要有人去加**（补法是往 `ACL_ACTIONS` 里加一行 `'attachment.upload'`；若将来补上删除审计，`'attachment.delete'` 与 `'attachment.purge'` 同处理）。⇒ 这一条已记入 §10.0 的"仍未做"。

### 8.4 与"只做空间回收"哲学的一致性检查表（「设计决策」D27）

| 既有做法 | 附件版对应 | 一致？ |
|---|---|---|
| 过期授予**在判定时**失效，不依赖清理任务（`packages/plugin-authz/src/index.ts:314`，另一处同款在 `:561`：`if (r.expires_at !== null && … && r.expires_at <= now) continue // 已过期 ⇒ 视同没有`） | **行被删 ⇒ 判定与列表都查不到它**（无软删列，`DELETE FROM attachments` 一提交即生效）；**磁盘字节没有任何判定语义**，GC 纯粹回收空间 | ✅ |
| `purge` 只回收空间，响应给 `{expired, remaining}` | `purge` 只回收磁盘，响应给 `{removed, freed_bytes, remaining}` | ✅ |
| **只在真回收了才写审计** | 同 | ✅ |
| **删页不自动删数据**（`page_grants` 用 slug 不用外键，避免"删除后重建同 slug 时授予悬空复活"） | **删页只把 `page_id` 置 NULL**（`ON DELETE SET NULL`），行留下成为可发现孤儿（§3.4） | ✅ |
| 不提供 `UPDATE`/`DELETE` 路径的 append-only 表（`audit_log`，有源码级守卫测试） | 附件**必须**有删除路径（作者要能删）⇒ 不适用；但**物理文件的删除只有一条路径**（`purge`），并建议源码级守卫钉住"只有 purge 删物理文件" | 需新建守卫（§9.1） |

---

## 9. 测试策略

### 9.1 纯逻辑单测（`node --test` + `tsx`，与仓库一致）

> **测试状态（我实跑过两条）**：已落地两份单测 —— `packages/plugin-wiki/test/attachments.test.ts`（**16 pass / 0 fail**，我实跑）与 `packages/web/test/attachmentUploadPlan.test.ts`（**19 pass / 0 fail**，我实跑）。覆盖到的：白名单清单本身（`attachments.test.ts:41` 的 `deepEqual` 钉住 16 项顺序与内容）、白名单负例（`:61`）、`normalizeExt` / `attachmentRelPath` / `formatDisposition` / `effectiveMime` 等纯函数、以及"目标不可写时**不得挂死**（必须带错误返回，供端点回 503）"这条（`:16` 号用例）。**下表是"应当覆盖"的全量清单**；其中**第 6、7、10、11b、12 条未核实是否已覆盖**（尤其第 6 条：判定现在是"投影判据"，对应的单测应围绕 `projectPageContentFor` + URL 匹配，而不是 `last_gate` 表驱动）。

| # | 被测 | 断言要点 |
|---|---|---|
| 1 | **文件名与路径生成**（纯函数） | 给定 `sha256` + `ext` ⇒ 路径恰为 `aa/bb/<sha><ext>`；`ext` 不在白名单 ⇒ 抛错；`sha256` 非 64 位十六进制 ⇒ 抛错 |
| 2 | **`original_name` 清洗**（纯函数） | 含 `\r\n` / `\0` / `../` / 超长 / 空 ⇒ 清洗结果不含控制字符与路径分隔符；空 ⇒ 回退 `<sha256前8位><ext>` |
| 3 | **扩展名白名单判定**（纯函数） | 大小写归一（`A.PNG` ⇒ `.png`）；取**最后一个 `.` 之后**（`evil.php.png` ⇒ `.png` **接受**；`a.png.html` ⇒ `.html` ⇒ 拒）；无扩展名 / 以点开头 / 以点结尾 ⇒ 拒；`.svg` / `.json` 按 §6.2 的最终清单断言 |
| 4 | **上限判定**（纯函数） | `Content-Length` 预检、计数器上限、`实际 < 声明`、缺 `Content-Length` |
| 5 | **配额求和口径**（纯函数 + 桩） | `Number()` 强转（PG 返回字符串的既有坑，工程约定见 `docs/development.md`「PostgreSQL 方言差异」） |
| 6 | **下载判定纯函数**（`§4.3.1` 的六步） | 表驱动，至少覆盖：页面 `none` ⇒ 404；`public` 页 + 引用点 `org` 块 + 匿名 ⇒ 404；`org` 页 + 引用点 `granted` 块 + 被授予者 ⇒ 放行；引用点全为 `granted` + 未被授予 ⇒ 404；`refs` 为空 + `last_gate='org'` + 匿名 ⇒ 404；`refs` 为空 + `last_gate='granted'` ⇒ **任何人都不放行**；`refs` 为空 + `last_gate=NULL` + 页面 public ⇒ 放行；**块行不存在** ⇒ 该引用点不可见（失败关闭） |
| 7 | **引用点提取正则**（纯函数） | 只认 `/api/attachments/<22 位 base64url>` 与绝对 URL 形态；不误抓 `![](other)`；**不误抓代码块里的示例**（U12） |
| 8 | **`img[src]` 不被链接改写碰到**（前端守卫） | 断言 `packages/web/src/lib/markdownRender.ts` 的 `rewriteBodyLinks` **只**遍历 `a[href]`（现状是巧合，需钉住 —— §7.3） |
| 9 | **消毒链路不动**（前端守卫） | `mdToHtml` 仍是 `DOMPurify.sanitize(raw)` 无配置（`packages/web/src/lib/sanitize.ts:13-16`），且 `marked`/`dompurify` 版本未变 |
| 10 | **源码级守卫：物理文件只有一条删除路径** | 照 `packages/plugin-authz/test/audit-appendonly.test.ts` 的做法（正则扫源码，钉住唯一写入/删除点） |
| 11 | **源码级守卫：白名单常量不外泄** | `.html` / `.js` / `.wasm` 不得出现在白名单常量里；**`.svg` 的 `inline` 判据默认必须为 `false`**（U3/§6.2） |
| 11b | **源码级守卫：两张表的键集合相等**（U21） | 断言 `new Set(ATTACHMENT_EXT_WHITELIST)` 与 `Object.keys(MIME_BY_EXT)` **集合相等**（M1 今天恰好相等，各 16 项 —— 这条守卫把"加白名单忘了加 MIME"变成**可见的失败**，堵住 §4.6 那条不可达但致命的回退分支） |
| 12 | **迁移幂等** | 两个 `0018_*` 各跑两次不报错；**不得**出现 `ADD COLUMN`（文本启发守卫会误判注释，工程约定见 `docs/development.md`「数据库与迁移约定」）；`packages/server/test/builtin-migrations.test.ts` 全绿 |

### 9.2 e2e（真实起服务 + 真实 `curl`，与既有六条 e2e 同款）

> **测试状态**：脚本已落地 —— `packages/plugin-wiki/test/e2e-attachments.sh`。**我没有运行它**（只读了它的断言），因此"全绿"是**转述实现方的说法**，不是我的实测。**它的负向断言很严**，两条值得单独指出：
> ① **状态码 404 + 与"不存在"响应体 `cmp` 逐字节相同**（`e2e-attachments.sh:129`、`:363-366`），并且有 **D8a 标定用例**：先用**真实的** not-found 响应标定比对模板 —— 防的是"比对恒真"这种假绿（正是 `docs/development.md`「验收与验证纪律」记的三类"断言自己会骗人"之一）；
> ② 响应头断言用**真实 GET 的 `-D`**（`:93`、`:102`），因为**路由服务按 method 精确匹配、方法联合类型里没有 `HEAD`**（`packages/core/src/index.ts:692`）⇒ `curl -I` 会落到 `/api` 的 404（脚本头 `:22-23` 把这个实测结论写成了注释）。
> 另有：`cmp` 断言"下载字节与上传字节逐字节一致"（`:327` D1b）、删除侧同款 `cmp`（`:480`、`:491`）、`cache-control` **不含 `max-age`**（`:338-339`）。
> **一条必须遵守的纪律（工程约定见 `docs/development.md`「验收与验证纪律」）**：**凡"靠直读 SQLite 文件断言"的 e2e 阶段，都要同时给出方言中立（纯 HTTP）的替代断言** —— 否则该阶段在 PG 下被整体跳过时**不会有任何信号**。请核对 `e2e-attachments.sh` 是否有靠直读库文件的阶段（我未逐行核对）。

**必须包含的负向断言（越权下载）—— 这是本能力的验收核心**：

| # | 场景 | 断言 |
|---|---|---|
| E1 | 公共页 + 公共块的附件 | 匿名 `GET` ⇒ **200**，`content-type` = 服务端推导值，含 `nosniff`，`content-disposition: inline`（图片） |
| E2 | **受限段落（`gated:org`）里的附件，匿名下载** | ⇒ **404**（不是 403，不是 200）；**且响应体里不出现"存在"的任何线索**（不含 `attachment` 字样、与"不存在的标识"响应体**逐字节相同**） |
| E3 | 同上，**组织成员**（已登录）下载 | ⇒ 200 |
| E4 | **`granted` 档块里的附件**：未被授予者 ⇒ 404；被授予者 ⇒ 200；**授予过期后**（`expires_at` 过去）⇒ 404（复用既有"判定时即失效"的口径） |
| E5 | **引用消失后不放宽**：把图从受限段落删掉并保存 ⇒ 匿名 **404**（机制：**URL 不在投影里 ⇒ 404**）；重新插入**公共**段落并保存 ⇒ 匿名 **200** |
| E6 | **页面收紧后**：页面从 `public` 改成 `org` ⇒ 匿名对**本来能下的**附件 ⇒ 404（`private, no-cache` 不能让它靠缓存活着） |
| E7 | 删页 ⇒ 附件 URL ⇒ 404；`attachments` 行仍在且 `page_id IS NULL`（孤儿可发现） |
| E8 | **非上传者且无 `canEdit` 的人删除 ⇒ 404**（与下载逐字节相同的信封，审计记 `no_edit_access`）；**上传者本人可直接删**（200 `{ok:true, deleted}`）；删后下载 ⇒ 404；**没有"仍被引用 ⇒ 409"这回事**（删除只删元数据行、不删磁盘文件，见 §4.5） |
| E9 | 上传 413：`Content-Length` 声明超限 ⇒ 413 **且连接被关**（`closeAfterResponse` 行为）；实发超限 ⇒ 413 |
| E10 | 上传 415：`.html` / 无扩展名 / 多扩展名 ⇒ 415 |
| E11 | 上传 403：已登录但对该页无 `canEdit` ⇒ 403；匿名 ⇒ 401 |
| E12 | 幂等：同页同字节传两次 ⇒ 第二次 **200** + `deduplicated: true`，且**只有一个物理文件**、**只有一行** |
| E13 | **去重不串权限**：同一字节在 A 页（受限段落）与 B 页（公共）各上传一次 ⇒ **两行、两个 URL**；匿名只能下 B 页那一个 |
| E14 | 配额：超每页配额 ⇒ 413 `page_quota_exceeded`（**已实现**）；超全库 ⇒ 413 `repo_quota_exceeded`（**未实现**，待做） |
| E15 | （**GC 未实现**，本行是待做验收）`DELETE` ⇒ 行消失、**下载立即 404**（判定与列表都查不到它，**磁盘文件仍在**）；将来 `purge` 落地后 ⇒ 物理文件消失、`{removed, freed_bytes, remaining}` 形状正确、`removed=0` 时**不写审计**、`removed>0` 时审计里出现 `attachment.purge` |
| E16 | `tmp` 残留：中途断开上传 ⇒ **不留** `tmp` 文件、**不留**元数据行 |
| E17 | **方言中立（纯 HTTP）**：E2/E4/E6/E9 必须在真实 PostgreSQL 上也跑（教训见 `docs/development.md`「验收与验证纪律」："靠直读 SQLite 文件断言的阶段在 PG 下整体跳过，而且不会告诉你"） |
| E18 | 反向假绿断言（照阶段 K 的做法）：先证明**前置状态可读**（有权者能下到 200），再断言无权者 404 —— 否则"上传根本没成功"也会让"404"通过（假绿） |

**e2e 必须避免的三类"断言自己会骗人"**（`docs/development.md`「验收与验证纪律」的三个实例）：① 把多个计数**拼成字符串**再比较；② 造了会被 upsert 覆盖的夹具（导致"过期"场景实际不存在）；③ 前置步骤（如批量吊销会话）让后续请求以"看起来对"的方式失败。

### 9.3 必须真实浏览器验证的项（**不能**用 curl 代替）

| # | 验证什么 | 为什么 curl 不行 |
|---|---|---|
| B1 | **拖拽**上传（drop 事件 + `preventDefault` 确实阻止了 CodeMirror 插入文件名） | 依赖真实 DataTransfer 与 CodeMirror 默认行为 |
| B2 | **粘贴截图**上传 | 依赖真实剪贴板（`clipboardData.files`） |
| B3 | **`<img>` 真的显示出来**（`content-disposition: inline` + cookie 自动携带） | 浏览器行为 |
| B4 | **失败态是占位文案而不是破图**（`onError` 委托确实命中 `innerHTML` 注入的子树） | React 管不到这棵子树（`packages/web/src/components/MarkdownBody.tsx:86-99` 的注释说明"命令式注入"是刻意的） |
| B5 | **SVG 直接打开时不执行脚本**（若 U3 允许 SVG：`content-disposition: attachment` 是否会触发下载而非导航；CSP sandbox 是否生效） | 只能真浏览器验证；**这是 U3 的判据** |
| B6 | **键盘走完三条路径** + 读屏播报（`role="status"`） | 无障碍只能实测（仓库明确记录"真实浏览器交互从未验证"，工程约定见 `docs/development.md`「验收与验证纪律」） |
| B7 | **大文件上传时的进度/挂起观感**（占位是否及时出现） | 时序与观感 |
| B8 | `nosniff` 生效（改名成 `.png` 的 HTML 直接打开是破图而不是渲染） | 浏览器行为 |

---

## 10. 未决问题（实现前必须确认）

> 格式：**编号 · 问题 · 候选方案 · 取舍 · 本文建议**。标 **阻塞** 的条目会阻塞实现开工。

### 10.0 状态总览（哪些已不属于"未决"）

> **背景**：本节的条目横跨"设计阶段"与"实现完成"两个时点，用下表把状态分清，避免把已定/已修的东西当"未决"读。

| 类别 | 条目 | 说明 |
|---|---|---|
| **已决（不再是未决）** | **U1**（上传体形态 ⇒ 原始字节流 `PUT`）、**U2**（落点 ⇒ `@geewiki/wiki`）、**U22**（判定路线 ⇒ **重跑投影**） | U1/U2 由实现直接选定；U22 见该条 |
| **已修** | **U23**（403 ⇒ **一律 404** + 与"不存在"逐字节相同的信封）、**U24**（`max-age=300` ⇒ **`private, no-cache, no-transform`**） | 当前形态见 §4.3.1 / §4.5 / §4.6 |
| **仍未做（真实待办）** | **全库配额 `repoQuotaBytes`**（每页配额 `attachmentPageQuotaBytes` 已实现，但 2026-09-21 起**默认 0 = 不限**）、**Range**（U6）、**上传限流**（U14）**与并发闸门**、**上传超时**（U8 —— HTTP 层无任何超时，见 §0.1 事实 6）、**GC / 孤儿回收端点**（`DELETE` 只删元数据行，磁盘文件留给 GC）、**`data:` URI 图片旁路**（U16）、**附件管理 UI**（列表/删除界面）与**降级 textarea、插件编辑器插槽不支持上传**（U15 的一部分）、**U21 的两表守卫测试 + `effectiveMime` 回退分支**（`packages/plugin-wiki/src/attachments.ts:201-207` 未改） | 逐条详见对应小节；GC 部分另见 §8.1/§8.2 |
| **明确保留（当前就是对的）** | **`GET /api/attachments/<非数字>` 仍原样回显参数**（`packages/plugin-wiki/src/index.ts:3401-3404`；而 `attachmentNotFound` 那条路径**只回数值 id**，`:3363-3365`） | 这属"**非法输入**"分支：任何非正整数都走这里，与"某个真实 id 是否存在"无关 ⇒ **不是**存在性预言机 ⇒ 保留，不必改 |
| **一条实测结论（写下来免得被当成 bug）** | **路由服务按 method 精确匹配，方法联合类型里没有 `HEAD`**（`packages/core/src/index.ts:692`：`'GET' \| 'POST' \| 'PUT' \| 'DELETE' \| 'PATCH'`）⇒ **`curl -I`（HEAD）实测 404**（落到 `/api` 的 404），**不是附件端点坏了** | 因此**响应头断言必须用真实 `GET` 的 `-D`**（e2e 即如此：`packages/plugin-wiki/test/e2e-attachments.sh:93`、`:102`；脚本头 `:22-23` 把这个实测结论写成了注释） |

### U1 上传体的形态（**阻塞**）

| 候选 | 优点 | 代价 |
|---|---|---|
| **A. 原始字节流**（`content-type` + 原始 body；本文 §4.2 采用） | 零依赖；流式、不占内存；上限只有一个真源；攻击面最小 | 不能用 HTML `<form>`；前端要绕过 `api.ts` 的 JSON `request()`；第三方集成方要自己拼 body |
| **B. base64 塞进 JSON**（复用 `readBody`） | 与既有所有端点**形状一致**；前端零新增代码路径 | **+33% 体积**（10 MiB 文件 ⇒ 13.4 MiB body ⇒ 必须把 `readBody` 的 1MB 默认上限抬高到 ~14MB 并**全量进内存**；`packages/plugin-wiki/src/index.ts:390`） |
| **C. multipart + `busboy`** | 与浏览器 `<form>` / 常见集成天然兼容 | **新增依赖**（违反 G4）；且 multipart 解析是 T5 那整类攻击面 |

**建议**：**A**。若第三方集成兼容性是硬需求，**先做 A，再单独评估 C**（C 的引入必须走"候选对比 + 理由"的流程，不能顺手加）。
**需要谁拍板**：项目所有者（因为 A 会让"用 HTML 表单给 wiki 传图"这条路不存在）。

### U2 附件端点落在哪个插件（**阻塞**）

| 候选 | 优点 | 代价 |
|---|---|---|
| **A. 落在 `@geewiki/wiki`**（建议） | 与 `pages` / `blocks` / `policy-service` 同包；已有 `readBody`、`closeAfterResponse`、`requirePrincipal`、`isContained`（跨包则需要抽取）等现成范式；`requires: ['policy-service']` 已声明（`packages/plugin-wiki/src/index.ts:288`） | 该包会变大（体积不是问题：它是服务端插件，不进浏览器包） |
| **B. 新开 `@geewiki/attachments` 插件** | 职责清晰；可独立启停 | 需要跨包复用 `blockVisibleTo`（§4.3.3 的抽取）、`requirePrincipal`、`isContained`；`@geewiki/core` 不能进浏览器包（`access-control.md` §9 R3）⇒ 抽取落点要再讨论；还要处理"wiki 未激活时附件插件怎么办"（**失败关闭**：拒绝注册路由） |
| **C. 放在 `@geewiki/http`（server 包）** | 与静态层最近 | ❌ **不建议**：`@geewiki/http` 刻意不 import 任何身份实现（`packages/server/src/index.ts:1097-1110` 的注释），把业务语义塞进去会破坏那条分层 |

**建议**：**A**。理由：最大复用、最小抽取、依赖边已存在。

### U3 是否允许 SVG（**阻塞**：白名单里有没有它）

| 候选 | 优点 | 代价 / 残余风险 |
|---|---|---|
| **A. 不允许**（建议） | 攻击面直接消失（T3 的主要来源）；白名单更小更好解释 | 作者不能用矢量图（可用 PNG 替代；现代截图/导出都支持 PNG） |
| **B. 允许，强制下载**（`content-disposition: attachment` + CSP sandbox + nosniff） | 满足"通用附件"的完整语义 | 不能内嵌显示（`<img>` 需要 `inline`）⇒ **SVG 在正文里永远显示不出来**，只能下载 —— 实际体验**接近 A**，却多留了一条"直接导航"的路径 ⇒ **收益低、风险高于 A** |
| **C. 允许 + 内嵌 + 服务端消毒 SVG** | 体验最好 | 需要 SVG 消毒（剥离 `script`/`on*`/`foreignObject`/外部引用）⇒ **必须新依赖**（后端无 DOM；`jsdom` + `dompurify` 是重依赖）或手写 XML 白名单（高危手写面）⇒ 违反 G4 |

**建议**：**A**（P0 先禁；有明确需求再评估 C，并单独走依赖评审）。**判据**：B5（真浏览器验证）若做，可先支持"只有内嵌 SVG 才能满足的场景"。

### U4 是否做内容魔数（magic bytes）校验

- **候选**：A. 不做（本文现状）；B. 对光栅图片做 8~12 字节头校验（PNG `\x89PNG\r\n\x1a\n`、JPEG `\xff\xd8\xff`、GIF `GIF8`、WEBP `RIFF….WEBP`、AVIF `ftypavif`）。
- **取舍**：B 是**零依赖**的（约 30 行常量 + 前若干字节比对），能挡住"声明 image/png 实为 HTML"（T2 的残余风险）；代价是"扩展名与内容不一致时误拒"（例如某些工具导出的 `.webp` 头不规范），需要**失败关闭**（拒）还是**警告放行**的取舍。
- **建议**：**B 作为 P1 跟进**（先 A 上线，把 T2 的残余风险写进交付说明）。理由：内嵌路径上风险已经被 `nosniff` + 非图片强制下载压住。

### U5 配额是硬约束还是软约束

- **候选**：A. 软（读体前预检 + 落盘前核一次，允许并发超发）；B. 硬（落盘前用"预留-提交"两阶段或一张配额表 + 行锁）；C. 请求级串行化（配额检查与落盘在同一临界区）。
- **取舍**：B 在 SQLite 上是单写者、可行但复杂；在 PG 上需要 `SELECT … FOR UPDATE` 或 `SERIALIZABLE`。A 简单但并发下可超发 `maxConcurrentUploads × attachmentMaxBytes`（按 M1 的默认值 = 4 × 25 MiB = **100 MiB** 的越界上界）。〔2026-09-21：默认已是**不限**，这条越界上界不复存在——配额只在运维显式设值时才是判据，而"不设值 ⇒ 磁盘是唯一下限"就是那次改动的口径。〕
- **建议**：**A**，并把"越界上界 = 并发上限 × 单文件上限"写进交付说明 —— 它是有界的、可解释的。

### U6 下载是否支持 Range

- **候选**：A. 不支持（本文：不发 `accept-ranges`，忽略 `Range` 返 200 全量）；B. 支持单区间。
- **取舍**：B 让 PDF 阅读器与大图查看器体验更好；但需要处理 `If-Range`、多区间、与 ETag 的交互，且**服务端要按区间读文件**（`fs.createReadStream({start, end})`，不难但要把"判定 → 区间"的顺序做对）。
- **建议**：**A**（N7 已把音视频与大文件列为非目标）。⇒ 若将来支持，**必须**在"判定通过之后"才解析区间（否则区间边界会成为探测面）。

### U7 附件是否进入 `page_versions` 快照

- **候选**：A. **不进**（本文：版本只存正文；附件是内容寻址、按行归属）；B. 进（把引用到的 `id` 列表一并存进版本的 `blocks_json`/`acl_json` 旁边）。
- **取舍**：A 简单；但"恢复旧版本"后，旧版本里引用的附件若已被回收 ⇒ 破图（需要 §7.4 的失败态表现）。B 能在恢复时提示"该版本引用了 N 个已不在的附件"（照既有 `warnings: ['block_acls_not_restored']` 的做法，语义见 `docs/design/access-control.md` §4.4「版本与恢复语义」）。
- **建议**：**A + 一条警告**：恢复路径若检测到"旧版本里引用的 `id` 已不在"，在响应的 `warnings` 里加 `attachments_missing`（**零迁移成本**：恢复时对旧正文跑一次 §7.3 的正则即可，不需要存快照）。

### U8 慢速上传的超时与并发闸门归属

- **候选**：A. 附件模块自己 `req.setTimeout`（本文）；B. 在 `@geewiki/http` 里加全局 `server.requestTimeout`（影响全站）；C. 交给反向代理。
- **取舍**：A 只影响附件（对全站零风险），但**每个**新建的流式端点都要记得加；B 是"一处收口"但会改变全站行为（**可能打断既有 SSE 长连接** —— SSE 在 `dispatch` 里被 `trackStream` 登记，长时间无字节是**正常**的 ⇒ B 有真实回归风险）；C 依赖部署环境。
- **建议**：**A 为默认，B 单独评估**（若做，必须给 SSE 开豁免，而"按路径豁免"会让规则复杂）。⇒ 建议同时在 `@geewiki/http` 的文档注释里**记一条**："流式端点各自负责超时"。

### U9 健康检查是否暴露附件目录状态

- **候选**：A. 不暴露（`/api/health` 形状不动）；B. 在 `db` 之外加一个 `attachments: { dir, writable, objects }` 字段。
- **取舍**：既有形状被 Dockerfile 的 `HEALTHCHECK` 判据依赖（`packages/server/src/index.ts` 的健康处理注释：`j.ok===true && j.db && j.db.present===true`）⇒ **只加字段是安全的**（既有判据不变）。但"暴露绝对路径"会泄露部署细节 ⇒ 只给 `present`/`writable`，**不给路径**。
- **建议**：**B（只加布尔字段）**，并在启动时做一次可写性自检（照 `docs/deployment.md:130` 的 `touch/rm` 范式）。

### U10 列表分页与目录分片层级

- **候选**：分页 A. 偏移量（`?offset=`）；B. `created_at` + `id` 复合游标（本文倾向）。分片 A. 两级（本文）；B. 一级 `aa/`；C. 不分片。
- **取舍**：偏移量在"边删边翻"时会漏/重；游标需要复合比较（`WHERE (created_at, id) < (?, ?)`，两方言语法差异需核对 ⇒ 可用 `created_at < ? OR (created_at = ? AND id < ?)` 的等价写法，**两方言通吃**）。分片层级影响 `ls` 与备份工具的可读性。
- **建议**：**B（游标）+ 两级分片**。若运维强偏好"能一眼看到所有文件"，改为一级。

### U11 `isContained` / `requirePrincipal` 等工具是否抽到 `packages/core`

- **候选**：A. 各自复制（危险：第二份实现会漂移，而漂移的方向是**路径校验变松**）；B. 抽到 `packages/core`（注意：core **不能进浏览器包**，`access-control.md` §9 R3；但这些都是**服务端**工具 ⇒ 可行）；C. 附件落在 `@geewiki/wiki` 时**不抽**（同包内 import `server` 包的工具又不行 —— `packages/plugin-wiki` 不应依赖 `@geewiki/server`）。
- **建议**：**B**（把 `isContained` 与 `requirePrincipal` 抽到 `packages/core`，两处调用点改 import）。这**会改到既有文件**（`packages/server/src/index.ts`、`packages/plugin-wiki/src/index.ts`）⇒ 属于实现阶段的改造，**本文档只记录该前置项**；若实现者想避开，可退化为"在附件模块内复制并在注释里写明出处与守卫测试"，但**必须**有第 9.1 表的第 10 条那种源码级守卫。

### U12 引用点提取的边界

- **问题**：正文里的 `/api/attachments/<id>` 可能是**示例文本**（作者在代码块里写文档），也可能被写成 HTML `<img src>`。
- **候选**：A. 只在**非 `code` / 非 `html` 块**里提取（`parseBlocks` 已经给出 `kind`：`'code'` / `'html'`，`packages/plugin-wiki/src/blocks.ts:36-48`）；B. 全部块都提取；C. 只认 Markdown 图片/链接语法（`![](…)` / `[](…)`），不认裸文本 URL。
- **取舍**：A/C 更精确（不会把示例当引用 ⇒ 不会让一个"从未真正使用"的附件被判为已引用）；但它们都**可能漏掉**真实引用 ⇒ 漏掉的后果是**引用点为空按 `last_gate` 判定**（失败关闭，安全）或**从未被引用按页面级**（**放宽**，需注意！）。B 最保守（宁可多记引用）。
- **建议**：**B + 记录 `kind`**（引用点不另立表 —— §3.2 的 `attachment_refs` 未采用，`kind` 随投影判据现算，用于治理展示）。理由：**引用点漏记的方向是放宽，多记的方向是收紧** ⇒ 多记更安全。这条与 §4.4 的 `referenced` 字段语义要一致（治理面板可能显示"这段引用是在代码块里"）。

### U13 `page_slug` 冗余列的守卫

- **问题**：判定必须走 `pages.slug` 的**当前值**，而 `page_slug` 是上传时的快照。两者会漂移（页面移动/重命名没有"重命名"端点 —— 移动 = 改 slug，见 `access-control.md` §2.3 规则 3）。
- **候选**：A. 正文保存时顺手更新 `page_slug`（随正文保存刷新）；B. 干脆**不存** `page_slug`（治理查询多一次 JOIN）；C. 存但加源码级守卫（判定路径不得读它）。
- **建议**：**A + C**（两者成本都低；B 会让孤儿发现查询变复杂）。

### U14 上传速率限制

- **问题**：并发闸门（U/§6.3）不等于速率限制（"每小时 100 次"）。
- **候选**：A. 不做（本文）；B. 进程内滑动窗口（多实例失效）；C. 新表 `upload_counters`。
- **建议**：**A**（配额已经能防"图床化"）。若做，选 C（避免重蹈"进程内状态在多实例下失效"）—— 但那会引入一张纯运维表，需要单独论证。

### U15 编辑器的入口细节

- 是否加 toolbar 按钮（当前编辑器**没有**工具栏，只有 keymap，`packages/web/src/components/MarkdownEditor.tsx:192-266`）；是否加 `Mod-Shift-I` 快捷键；`accept` 属性是否与白名单**同源**（避免前端 accept 与后端白名单漂移 ⇒ 建议从一份共享常量生成，**但 `packages/core` 不能进浏览器包**（`access-control.md` §9 R3）⇒ 只能**镜像 + 守卫测试**，这正是 `gatedPreview.ts` / `slugRules.ts` / `pluginUiPlan.ts` 的既有做法，`packages/web/src/lib/gatedPreview.ts:10-13` 有完整说明）。
- **建议**：镜像 + 守卫测试（**与仓库既有惯例一致**，不要试图共享模块）。

### U16 正文里的 `data:` URI 图片（**既有行为带来的旁路**）

- **问题（「已核实」）**：`mdToHtml` 用 `DOMPurify.sanitize(raw)` **无配置**（`packages/web/src/lib/sanitize.ts:13-16`），而 DOMPurify 3.4.15 的默认 `DATA_URI_TAGS` 含 `img`（`node_modules/.pnpm/dompurify@3.4.15/node_modules/dompurify/dist/purify.cjs.js:743`）⇒ 作者可以内联 `data:image/png;base64,…` 图片，**完全绕过附件能力**（不受任何附件判定约束、不受配额约束、只会撞 500KB 正文上限）。
- **候选**：A. 接受（它是既有行为，改它会动消毒链路 —— 而 `markdownRender.ts:1-33` 明写"消毒链路是唯一出口"，本设计不改消毒链路）；B. 在**服务端保存路径**上拒绝含 `data:` 图片的正文（**新增校验**，不动前端消毒）；C. 改 DOMPurify 配置禁掉（**动消毒链路**，风险最高）。
- **取舍**：A 的代价是"配额可被绕过"（500KB × 页数仍然是有限的）；B 的代价是新增一条保存校验（有误伤风险：作者真的想内联一个小图标）；C 不建议。
- **建议**：**A + 在文档与编辑器提示里写明**（"内联 base64 图片不进入附件管理，且会撞正文 500KB 上限"）。若配额是硬需求 ⇒ 选 B（服务端校验，前端给可读的 400 文案）。

### U17 附件 URL 的 host 形态与门户

- **问题**：正文里写相对 URL `/api/attachments/<id>`（本文 §7.3）。门户（`/portal`）是**服务端匿名渲染**（`access-control.md` §6.1），它渲染的 HTML 里 `<img src="/api/attachments/…">` 同样可用（同源、带 cookie）。但若门户将来支持**绝对 URL 分享**（OG 图等），附件 URL 的 host 从哪来（`Host` 头 vs 配置）需要定。
- **建议**：**保持相对 URL**；门户侧若要 OG 图，用**独立**的、明确限定为"匿名可见页面的首个附件"的固定规则，并在那里**重新判定**（不要复用 URL 拼接）。
- **M1 已就这条给了判断（采纳）**：`attachmentUrl(id)` 用相对路径，理由是"它天然同源，于是 `<img src>` 会自动带上该域的 cookie —— 若下发绝对 URL，站点换域名/挂在子路径下时就会指向别处（或丢掉凭据）"（`packages/plugin-wiki/src/attachments.ts:146-154`）。

### U18（新增）上传端点的路径语义：`PUT /api/attachments/:slug` 还是 `POST` / `PUT …/:sha256`

- **背景（「已核实」）**：M1 的 `packages/plugin-wiki/src/attachments.ts:6` 定了 `PUT /api/attachments/:slug?name=<urlencoded>`。
- **候选**：**A. 保持 M1 现状**（`PUT`，语义略松）；**B. 改 `POST`**（"往某页的附件集合里新增一个成员"，语义最准）；**C. `PUT /api/attachments/:slug/:sha256`**（**内容寻址让哈希天然就是幂等键** ⇒ PUT 的"替换"语义严格成立；代价是前端要先算哈希，浏览器有内置 `crypto.subtle.digest`，零依赖）。
- **取舍**：A 与 B 的实际行为完全一样（服务端本来按内容哈希去重，`dedup` 已经表达了幂等），差别只是**契约的可读性**；C 最严格但要求前端多一步（且大文件算哈希要读一遍字节 —— 我们**无论如何都要在服务端读一遍算哈希**，前端再算一遍是重复劳动）。
- **建议**：**A 或 B**（不必做 C）。若选 A，请在端点注释里写清"URL 里的 `:slug` 是**归属页**、不是资源身份；资源身份是内容哈希（`dedup` 字段即其体现）" —— 否则后来的人会以为这个 PUT 是幂等的而依赖它。

### U19（新增）URL 标识：不可枚举 `public_id` vs 自增整数 `id`

- **背景（「已核实」）**：实现用 `attachmentUrl(id: number)`（`packages/plugin-wiki/src/attachments.ts:152-154`）；本文建议 `randomBytes(16).toString('base64url')`。
- **取舍**：见 §4.2 的分歧条目（诚实版：整数 id 的实际风险**不高** —— 判定逐请求、无权与不存在同 404；不可枚举 id 的收益是**纵深防御**与不泄露总量）。
- **建议**：**加 `public_id`**；若不改，则必须在 §9.2 里用最严的 e2e 钉住"无权与不存在的响应**逐字节相同**"（E2 已有这条断言）。
- **严重度**：中低。**这是当前分歧里最不影响安全、最影响"以后能不能改"的一条**（一旦附件 URL 进了正文，改标识就要做全文迁移 ⇒ **现在改成本最低**）。

### U20（新增）`.pdf` 是否允许内联

- **背景（「已核实」）**：M1 的 `INLINE_EXTS` 含 `.pdf`（`packages/plugin-wiki/src/attachments.ts:99`）；本文 D14 只允许光栅图片内联。
- **取舍**：见 §4.6 的分歧小节（PDF 是活动文档、跨浏览器沙箱行为不一致）。
- **建议**：**移出 `INLINE_EXTS`**（下载后本地打开），或**为下载端点补 CSP 并做真浏览器验证**（§9.3 B5/B8）。**严重度：中**（取决于是否被当作"PDF 一律可信"）。

### U22 判定路线：**下载时重跑投影**（已决）

- **决议**：**采纳"下载时重跑投影"** —— 判据是"**该附件 URL 是否出现在该主体的可见投影里**"，实现为 `projectPageContentFor(...)`（`packages/plugin-wiki/src/blocks.ts:840`；`packages/plugin-wiki/src/index.ts:364` 的注释说明实现上移到 `./blocks.js`），调用点 `packages/plugin-wiki/src/index.ts:3447`（下载判定）与 `:801`（getPage 详情）。
- **理由（决定性的一条）**：**最抗漂移** —— 判定与渲染共用**唯一真源** `projectBlocks`，因此**不存在**"第二套可漂移的可见性规则"；引用被删 / 块被删 ⇒ 投影里没有该 URL ⇒ **失败关闭**；且不需要派生表、不需要回填、不需要 `last_gate` 快照（本文原方案恰恰引入了"必须与正文同步"的第二个真源，而漏同步的方向是泄漏）。
- **由此产生的两处作废**：**引用表 `attachment_refs` 与 `last_gate` 快照列均不采用**（`grep -rn "attachment_refs" packages/` ⇒ **0 命中**）；`attachments` 表因此**没有** `block_id` / `last_gate` 列（实际表结构见 §3.1）；`attachments.page_id` 的外键是 **`ON DELETE CASCADE`**（§3.4）。
- **代价（诚实列出，仍成立）**：每次下载多一次块查询 + 一次投影。**不做投影缓存**（`packages/plugin-wiki/src/index.ts:3381-3392` 的注释给出了理由：`pages.acl_revision` 只在 ACL 变更时自增，而**块可见性还会随正文编辑与 `block_grants.expires_at` 变化**，这些都不改 `acl_revision` ⇒ 要正确缓存就得再引入一套失效键，而"撤销后仍可见的窗口"正是本仓明令禁止给判定加 TTL 缓存的原因）。
- **验收要求**：该路线的安全性**完全依赖**"投影是唯一的可见性判据"这一条 ⇒ **§9.2 的 E2/E4/E5/E6 一条都不能少**。其中 **E5（"引用消失后不放宽"）表现为 404**（§9.2 已按此措辞）。

### U23 403 `attachment_gated` 与 404 的选择

- **决议**：**一律 404**，响应体与"不存在"**逐字节相同**（唯一信封 `attachmentNotFound`，`packages/plugin-wiki/src/index.ts:3363`）。**审计照记真实原因**（`after.reason` = `no_read_access` / `attachment_gated` / `no_edit_access`），因为"对外无差别是为了不把信息交给请求方；审计是内部的，它必须记下真实原因"（`:3357-3358`、`:3466-3469`、`:3698-3700`）。
- **验证方式**：e2e `packages/plugin-wiki/test/e2e-attachments.sh` 用 `cmp -s` 逐字节比对越权响应与"不存在"响应（`:363-366` 的 **D8a 标定用例**：先用**真实的** not-found 响应标定比对模板，防止"比对恒真"的假绿）；`DELETE` 侧同款 `:480`、`:491`。⇒ 这条负向断言现在是**可证伪的**。

### U24 下载响应的缓存窗口

- **决议**：**`private, no-cache, no-transform`**（`packages/plugin-wiki/src/index.ts:3520`）。含义是"**每次复用前必须回源校验**" ⇒ 撤权后下一次请求即落 404；`ETag`（`"<sha256>"`）保留 ⇒ 未变时 304，效率不损。
- **为什么不是 `no-store`（实现方的说明，采纳）**：内容寻址 + sha256 ETag ⇒ 304 复用**不可能复用错内容**，要禁止的只是"**不校验就复用**"。`no-store` 关掉的是性能，`no-cache` 关掉的才是那个窗口（`:3512-3517`）。
- **错误响应的缓存**：四个端点入口默认 `cache-control: no-store`，成功分支显式覆盖为 `private, no-cache` —— 防"浏览器启发式缓存 404 ⇒ 授权后仍复用旧 404"。

### U21（新增）两张表的漂移守卫（白名单 ↔ MIME 表）

- **背景（「已核实」）**：M1 的 `effectiveMime` 有一条"扩展名不在 MIME 表里时**回退到客户端声明值**"的分支（`packages/plugin-wiki/src/attachments.ts:201-207`）；今天两张表键集合相同（各 16 项）⇒ 分支不可达，但**一旦漂移就是存储型 XSS**（详见 §4.6 的漂移陷阱小节）。
- **候选**：**A. 回退值恒为 `application/octet-stream`**；**B. 加源码级守卫测试**断言两表键集合相等；**C. 两者都做**。
- **建议**：**C**（成本是几行）。**严重度：高（但当前不可达）** —— 这正是本仓库记录过两次的失效形态（两个真源迟早漂移）。

---

## 11. 决策清单（本文已拍板，按此执行）

| # | 决策 | 落点 |
|---|---|---|
| **D1** | 物理文件落**磁盘**，不进数据库 BLOB | §2.1 |
| **D2** | 目录 = `<GEEWIKI_DATA_DIR>/attachments/`，内含 `aa/bb/` 分片、`tmp/`、`.quarantine/`；`tmp/` 必须同文件系统 | §2.2 |
| **D3** | 文件名 = **内容哈希 + 白名单扩展名**；**用户文件名永不参与路径** | §2.3 |
| **D4** | 物理层内容寻址去重 + **逻辑层按页隔离**；不做 `refcount` 列（能算的不物化） | §2.4 |
| **D4'** | 上传体 = **原始字节流**（不引入 multipart） | §4.2（与 U1 联动） |
| **D5** | 备份：冷备天然覆盖；热备会有"库与文件不一致窗口" ⇒ 做成可观测信号，不追求两阶段提交 | §2.6 |
| **D6** | 表 `attachments`（字段见 §3.1）；URL 里的标识 = 自增 `id`（取舍见 U19） | §3.1 |
| **D6a** | `sha256` **不构成 URL**（响应可回显，但下载只认 URL 里的标识 —— M1 用 `:id`，本文建议 `:public_id`，见 U19） | §4.2 |
| **D9** | 外键：`attachments.page_id → pages(id)` = **`NOT NULL` + `ON DELETE CASCADE`**；无 `block_id` 列；`uploader_id` 无外键 | §3.4 |
| **D10** | 迁移：`packages/db-sqlite/src/migrations/0018_attachments.sql` + `packages/db-postgres/migrations/0018_attachments.sql`（成对；理由与备选见 §3.5） | §3.5 |
| **D11** | 档位：上传/删除 `user`；下载/列表 `public` + 逐对象判定 | §4.1 |
| **D12** | 下载判定 = **"下载时重跑投影，看投影后的正文里是否含该 URL"**（`projectPageContentFor`，`packages/plugin-wiki/src/blocks.ts:840`；调用点 `packages/plugin-wiki/src/index.ts:3447`）—— 语义等价、零漂移、失败关闭更彻底（见 **U22**；§4.3.1 的六步算法为备选）；越权**一律 404 且与"不存在"逐字节相同**（见 D28） | §4.3.1 |
| **D28** | **越权一律 404**（唯一信封 `attachmentNotFound`，`packages/plugin-wiki/src/index.ts:3363`），**下载与删除同口径**；**审计照记真实原因**（`no_read_access` / `attachment_gated` / `no_edit_access`） | §4.3.1 / §4.5 |
| **D29** | **缓存策略** —— 成功 `private, no-cache[, no-transform]`（下载带 `no-transform`），**错误一律 `no-store`**；用 `ETag = "<sha256>"` 提供 304 复用；**刻意不用 `no-store` 于成功响应**（关掉的是性能而不是那个窗口） | §4.6 |
| **D30** | **`nosniff` 全覆盖**（四个端点、含 304 与错误响应），在处理器入口统一设置 | §4.6 |
| **D31** | **附件清单（列表端点）不对外提供** —— 要求 `canEdit`，无编辑权 ⇒ **403 `forbidden`**（读者拿不到"这一页有哪些附件"的清单） | §4.4 |
| **D13** | 判定**必须复用** `policy-service` 与 `blockLevelOf`；**不新写第二套** | §4.3.2 |
| **D14** | 响应头：服务端推导 `content-type`（见 U21：回退值**不得**用客户端声明）+ `nosniff` + 图片 `inline`/其余 `attachment`（`.pdf` 是否 inline 见 U20）+ `private, no-cache` + `etag` + CSP `default-src 'none'; sandbox`；**不发 `accept-ranges`** | §4.6 |
| **D15** | 附件**只能**经 API 端点输出，**绝不**加入任何静态根 | §4.7 |
| **D16** | 上限走**配置**（`schemastery`；2026-09-21 起 `attachmentMaxBytes` / `attachmentPageQuotaBytes` **默认都是 0 = 不限**，M1 曾定 25 MiB / 200 MiB；`attachmentInlineSvg` = false，其余键名见 §6.1）；**白名单与安全头走代码常量** | §6.1 |
| **D17** | 扩展名白名单（**以 M1 的 16 项清单为准**，见 §6.2：图片/`.svg`/文档/`.json`/`.zip`/Office；禁 HTML/JS/可执行/无扩展名） | §6.2 |
| **D18** | 配额：每页 + 全库；并发闸门；**PG 的 `SUM` 必须 `Number()`** | §6.3 |
| **D19** | 前端三条路径共用 `fetch` 原始 body（带 `x-gw-csrf: 1`）+ 拖拽必须 `preventDefault` | §7.1 |
| **D20** | 上传中占位 → 成功替换 → 失败留可见标记可重试 | §7.2 |
| **D21** | 插入形态 `![alt](/api/attachments/<标识>)`（M1 实际是 `![alt](/api/attachments/<id>)`，`packages/web/src/lib/attachmentPlan.ts:72-78`） | §7.3 |
| **D22** | 失败态显示**占位文案**（措辞与 `projectBlocks` 同族），**不显示破图**、**不区分"无权"与"已删"** | §7.4 |
| **D23** | 可访问性：键盘可达三条路径、`role="status"` 播报、目标尺寸、`alt` 默认填 | §7.5 |
| **D24** | 孤儿发现 = 文件系统 ↔ 表两个方向（§8.1 表） | §8.1 |
| **D25** | 运维：`GET /api/admin/attachments/orphans`（只读）+ `POST /api/admin/attachments/purge`（**只做空间回收**，响应形状对齐 `grants/purge`） | §8.2 |
| **D26** | 审计复用 `audit_log`；四个动作；**不加新表**；新动作必须进 `GET /api/admin/audit` 的**显式白名单** | §8.3 |
| **D27** | 与"只做空间回收"哲学逐条对齐（§8.4 表）；物理文件只有 `purge` 一条删除路径（源码级守卫） | §8.4 |

