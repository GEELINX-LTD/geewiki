# 实现记录台账（自 README 迁出）

> **这一页是什么**：GeeWiki 逐批次的实现记录——每批的用户原话、暴露的问题、做法与验证读数。
>
> **注意口径**：本页是**历史快照**，其中的读数、插件数量、行号在被写下的那一刻成立，之后可能已过时。
> 需要当前读数请看 [../README.md](../../README.md) 的「质量基线」段，或直接实跑 `pnpm -r --no-bail --if-present run test` / `pnpm run typecheck`。
>
> **一条文档教训（来自已删除的 `docs/changelog/test-ledger.md`）**：那份"测试读数台账"原本是 README「快速开始」命令表里 `pnpm test` 那一行的**表格单元格**——每轮追加新读数、旧读数也保留，最后单格约 6900 字节、整行约 8500 字节。两件事必须记住：① 单元格正文里含**未转义的 `|`**，而 Markdown 表格正是用它分列 ⇒ 这一行被解析成 **5 列**、出现在只有 2 列的表格里——**这行本来就是坏掉的**，不只是"太长"；② 台账的读写成本随批次数线性增长，而其中**只有最后一组读数有效**。整改办法是"正文逐字迁出 + 源头只留当前读数与指针"，本文档与 README 已按此办。

---

**边界说明（本文档的口径）**：本文档是**历史流水**——它记录的是**写下当时**的读数与口径，之后可能已过时；历史正文条目**保留**（那是它的价值）。
凡提 `@geewiki/ai-qa` / `wiki-ask` / `#/wiki/ask` / `POST /api/ai/stream` 的段落均已过时（这些对象已随 AI 插件化重构整包/整体删除），当前口径见 [../README.md](../../README.md) 与 [../plugin-platform.md](../plugin-platform.md)。

**当前实现状态**

- **补上响应压缩（gzip / brotli）（2026-09-20）**：用户原话「开始实现吧」，承接上一轮实测出的
  「全仓无响应压缩中间件」。
  - **先纠正上一轮我自己的举证方向**：我当时拿 `q=架构&limit=100` 的 21688 字节说事，暗示"检索响应太肥"。
    复核发现**该读数与 `limit` 无关**（该查询只有 2 条命中，`blocks` 把命中页的 99 + 19 个块全带回来），
    即 21 KB 是常态而非极端值 —— 而 21 KB 在局域网上根本不算问题。**真正的成本在别处**：实测静态资源
    响应头**没有** `Content-Encoding`，`index-*.js` **721 KB**、`MarkdownEditor-*.js` **547 KB** 原样发给
    每个冷启动用户；而 `docs/deployment.md` 通篇**没有反向代理**（`nginx|caddy|traefik|反代|gzip|brotli`
    零命中），也就是说**没有任何一层会替我们做这件事**。
  - **做法**：新增 `packages/server/src/compression.ts`（用 Node 内置 `node:zlib`，**零新依赖**），
    在 `packages/server/src/index.ts` 的 `createServer` 回调里、`router.dispatch` **之前**装一次 ——
    API 与静态产物共用同一个 `res`，在这一层包一次两类响应一起受益。
  - **为什么可以整段缓冲**：全仓**只有一处**流式响应（`packages/core/src/sse.ts` 的 SSE，逐帧
    `res.write` + `flushHeaders`），它必须在 `writeHead` 当拍就被排除；其余路径一律"备好整块再 `res.end(data)`"。
    而且**只有缓冲才知道真实体积**：阈值必须依据真实字节数，不能依据 `content-length` ——
    `index.ts` 的 `json()` 根本不设它（静态路径设了，故那种情况可在 `writeHead` 当拍判"小于阈值"而直接旁路）。
  - **边界条件（逐条按本仓实际写法定，故没引 `compression` 之类的通用包）**：体积下限 1 KiB（几百字节的
    JSON 压完往往更大）；`Accept-Encoding` 的 `q=0` 视为**明确拒绝**（否则是协议违规），偏好按客户端 q 值排、
    同 q 才用 brotli；`Vary: Accept-Encoding` 对**所有可压缩类型**都补（含客户端不接受压缩的那种 ——
    正是它与压缩后的变体构成同一 URL 的两种表示）；HEAD / 304 / 无体状态码 / 已带 `content-encoding` /
    图片字体等已压缩格式一律旁路。
  - **我自己的测试抓到两个真 bug**（这正是写测试的价值，两条都曾让用例变红）：
    ① `Vary` 漏补 —— 原先在 `encoding === null` 时就提前旁路，导致"客户端不接受压缩"的响应没有 `Vary`；
    ② **未调 `writeHead` 直接 `end` 的响应变成畸形 HTTP**（客户端报 `Expected HTTP/`）—— 根因是 Node 的
    `end()` 会在内部调 `_implicitHeader()` → `this.writeHead(this.statusCode)`，那一拍晚于"决定要不要缓冲"，
    补丁若不转发则 `_header` 永远不被设置，客户端收到连状态行都没有的响应。修法是 `writeHead` 在
    已旁路时无条件转发，且 `end` 在 `undecided` 时自己按隐式头判定一次。
  - **验证读数**：`@geewiki/server` **98/98**（新增 `packages/server/test/compression.test.ts` **19/19**：
    纯函数 + 真实 HTTP；用裸 `node:http` 而**非** `fetch` —— undici 会自动解压并隐去 `content-encoding`，
    用它就永远看不到线上到底发了什么）、`pnpm typecheck` 全仓 **exit 0**、改动文件 eslint **0 error**。
    真实服务端到端实测（隔离临时目录 + 随机空闲端口 + 新代码）：
    `index-AnaLJdtq.js` **721322 B → gzip 226880 B（3.18×）/ br 207637 B（3.47×）**，
    `index.html` → gzip 2348 B，`/api/search?q=架构` **21709 B → 8547 B（2.54×）**；
    `Accept-Encoding: identity` 时原样 721322 B 但 `Vary` 仍在；gzip 响应 `gunzip` 回来是合法 JSON。
  - **未做（有意）**：`SearchHit.blocks` 的投影裁剪（压缩已把它从 21 KB 降到 8.5 KB，再上 `?fields=`
    等于新增一套契约协商，收益很小）；`/api/search` 限流（该端点是 `access: 'public'` 的**设计意图**，
    且限流只在"暴露到公网"时才有意义 —— 而部署文档显示连 TLS 都没有，那种情况下 TLS 与认证的优先级
    远高于给搜索端点限流）。压缩**不做开关**：反代（nginx/caddy）对已带 `Content-Encoding` 的响应
    默认不会二次压缩，故应用层压着是安全的。

- **修掉上一批自己引入的「死路按钮」（2026-09-19）**：用户原话「修掉」，指的是上一轮"还有什么可加强的点"
  里实测出的**我自己的回归**——上一批刚加的「改用分词匹配」引导按钮，对相当多的查询点了等于没点。
  - **症状**：短查询 0 命中时界面给出「改用分词匹配」按钮，用户点了 → 重新请求 → 拿回**一模一样**的
    0 命中，且界面不给任何解释。连带那句空结果文案也在最需要它的时候骗人：原文写「换「分词」再试一次，
    或缩短到 2–4 个字走短查询兜底」，但查询已经 ≤3 字时**两条建议都无效**。
  - **根因**（`packages/plugin-search/src/index.ts:482`）：
    `const useFts = queryMode === 'terms' ? terms.length > 0 : q.length >= MIN_TRIGRAM_LENGTH`
    —— `q.length < 3` 时两种模式**都回退 LIKE**（同一条 SQL）；`q.length === 3` 且无空白时
    `buildTermQuery` 只切出原串本身一个词元，`toFtsPhrase(t) OR` 与 `toFtsPhrase(q)` **是同一个 MATCH 表达式**。
    实测：`架 / 架构 / 功能 / 特殊 / 演示 / 欢迎 / 功能介 / 特殊结 / 演示站 / 快速开` 两种模式**逐字段完全相同**；
    单个拉丁词同理（`markdown / wiki / OIDC / demo / architecture`）。我测的 10 个查询里 **9 个**是这种情况。
  - **做法（判据放服务端，界面不重复推导切词规则）**：新增 `modesConverge(q)` 纯函数
    （`packages/plugin-search/src/index.ts`，紧邻 `useFts`），与真实检索路径**共用同一批原语**
    （`buildTermQuery` / `MIN_TRIGRAM_LENGTH`）。若让前端自己镜像切词规则，规则一改界面就会重新开始骗人
    且**没有任何测试会失败**。契约 `SearchResult` 增 `modesConverge: boolean`
    （`packages/core/src/services.ts`），端点回传该字段（`GET /api/search` 响应体）。
    前端把原先的 `suggestTermsOnEmpty(mode, total)` 换成 `emptySearchPlan(mode, total, modesConverge)`
    → `'switch-terms' | 'no-match'`，并新增 `emptySearchHint(plan, mode)`：**按钮与文案从同一个 plan 派生**
    （先前是两处各判一次，判据一变就会出现"给了按钮却说了反话"的自相矛盾界面）。
  - **删掉一条错建议**：`缩短到 2–4 个字走短查询兜底` 整句移除。实测缩短**不会**增加命中：
    `版本管理权`→`版本`(like,4) 但 `版本管`(fts,0)；`插件热插拔`→`插件`(like,3) 但 `插件热`(fts,0)。
  - **验证读数**：`packages/plugin-search` **46/46**（新增 4 条 `modesConverge` 用例：同路 / 分叉 /
    **与 `buildTermQuery` 同源**（钉住"判据不是另写一份切词规则"）/ 端点回传）、`@geewiki/web` **905/905**、
    `@geewiki/ai-kb` **23/23**、全仓 `pnpm test` 无失败、`pnpm typecheck` exit 0、改动文件 eslint 0 error。
    浏览器端到端 `scripts/acceptance/search-mode/run.ts` **26/26**（新增 4 项死路防线用例：
    短查询 0 命中不给按钮、文案不提 2–4 个字、文案不提"分词"、手动切换条仍在）。
  - **两处连带修复（都是既有断言被新字段打到）**：① `packages/plugin-search/test/search.test.ts:718`
    对空查询返回值的 `deepEqual` 必须补 `modesConverge: true`（**这正是上一批记录里预告过的那个断言**）；
    ② `packages/plugin-ai-kb/test/kb.test.ts` 的 `searchStub` 需补该字段。两处都是类型系统与断言
    各自抓到的，说明"契约加字段"的影响面确实被这两层覆盖住了。
  - **遗留（本轮未动，待定）**：① 检索响应 **96.8% 是没人读的 `blocks`**（实测 `q=架构&limit=100`
    完整 21688 字节、去掉 blocks 489 字节），且响应头**无 `Content-Encoding`**（全仓无响应压缩中间件）；
    ② `GET /api/search` **匿名可打、无限流**（连打 30 次无节流），短查询走 `blocks JOIN pages` 全表 LIKE。
    两项都涉及取舍（契约裁剪 vs 压缩、限流阈值），未擅自动手。

- **检索界面的「匹配方式」开关（2026-09-19）**：用户原话「好的把这部分优化一下」，指的是上一轮
  咨询里"还缺什么功能"的回答——本轮落地的不是新功能，而是**把后端已有、界面没接的查询语义接出来**。
  - **要修的症状**：同一句话，**AI 助手搜得到、人在搜索框里敲却 0 命中**。根因不是检索坏了，而是
    后端有**两种问法**（`packages/plugin-search/src/index.ts:477` `const queryMode = opts?.mode ?? 'phrase'`）：
    `phrase` 把**整串**包成一个 FTS5 短语（`toFtsPhrase`），要求正文里**逐字连续出现**——问句几乎
    不可能满足，于是**恒为 0 命中**；`terms` 切成词元后 OR（`buildTermQuery`），才有召回。
    `packages/plugin-ai-kb/src/index.ts:262` 显式传了 `mode: 'terms'`，而宿主 `api.search` **根本没有
    mode 参数**（改造前 `packages/web/src/api.ts:1116` 只拼 `q` 与 `limit`）⇒ 同一个后端，两条路径行为相反。
    服务端早已有回归用例钉住这个现象：`packages/plugin-search/test/search.test.ts:985` 的
    「短语路 0 命中，词元路 ≥1——核心回归」。
  - **做法**：查询语义做成**可见、可切换的一等公民**，而不是"悄悄帮用户换一个再搜一遍"。
    `packages/web/src/lib/searchPlan.ts` 新增 `SearchQueryMode = 'phrase' | 'terms'`、`detectQueryMode`
    （缺省值推导）、`QUERY_MODE_OPTIONS` / `queryModeNote` / `queryModeOption`（文案）、
    `suggestTermsOnEmpty`（0 命中是否该引导）；`api.search(q, { limit, mode })` 把 `&mode=` 拼进请求；
    `SearchView.tsx` 加 `aria-pressed` 切换按钮组 + 结果区「问法」标注 + 空结果里的「改用分词匹配」引导按钮。
  - **两条刻意的取舍（都写进了注释与守卫测试）**：① **只引导、不自动重试**——0 命中时给按钮，用户点了
    才换语义。静默重试会让用户以为自己搜的就是原串（结果集变了却毫无提示），违背本仓"失败语义诚实"的纪律；
    守卫测试 `packages/web/test/searchModeUi.test.ts` 用 `setMode(` 的**调用点计数**（恰 3 处）+ 正则反查
    effect 内自动切换来钉死这条。② **语义随查询串复位**——提交新检索时按新串重新推导缺省，用户上一次的
    手动选择**不跨查询保留**（否则"这次为什么又是分词"无法解释）；`setLimit` 与 `setMode` 必须同生同死，
    否则新关键词会带着上一轮的 limit 取数。
  - **`detectQueryMode` 的判据与一个自我纠正**：含空白 / 问号叹号 / 问句引导词 / 长度 ≥10 码点 → `terms`，
    其余留 `phrase`（短关键词的精确语义**不因本批变宽**，这是硬约束）。初版把 `介绍|说明|解释|总结`
    直接当问句信号，自查时发现会误伤「说明书模板」「插件平台介绍」「总结报告」这类**正常的精确关键词**
    ⇒ 收紧为「动词 + 一下」（`REQUEST_PHRASES`）并补了反例用例。长度按**码点**计（`[...q].length`），
    否则 BMP 外的汉字是代理对、`.length` 会算成 2 个。
  - **浏览器验收（新增 `scripts/acceptance/search-mode/run.ts`）与它当场抓到的认知错误**：单测与源码守卫
    证明不了"浏览器里点一下，结果真的从 0 变出来"——而那正是本批的全部价值，故按本仓纪律（验收脚本
    不进 `pnpm test`）补了 CDP 验收，同 p3 款隔离（复制 `config/` 与 `db` 到临时目录、随机空闲端口、
    只装本次链路插件）。**21/21 通过**，含"0 命中后静置 1.5s 无第二个 `/api/search`"（钉住只引导不重试）、
    "点一次只发一个请求"（钉住 `disabled={busy}`）、"全程无 console error / 4xx"。
    - **它第一版就把我写错的前提打红了 6 项**：我原以为「编辑后怎么保存」需要用户手动切「分词」，
      实测该串**含「怎么」⇒ `detectQueryMode` 自动判 `terms`**，零点击即有命中。**是测试前提错了，不是代码错**。
      修正后脚本改为覆盖**两条路径**：自动（问句零点击）与手动（`版本管理权` 实测 phrase 0 / terms 2）。
    - 由此得到一条**产品层面的事实**，值得记档：**手动开关是兜底而非唯一入口**——问句类查询在缺省路径上
      已被自动推导接住，真正需要用户点的是"不含问句特征、但整串逐字不连续"的短词组合。
    - 另一个坑：hash 路由下 `Page.navigate` 到同/近 URL 只做**同文档导航**，组件状态原样留着，
      "空状态 → 引导按钮"根本不出现 ⇒ 需要新文档时先落 `about:blank`；而**复位逻辑恰恰只能在
      应用内导航（组件不卸载）时验到**，用换 URL 重新挂载会绕过 `useState` 初值那段代码、验了个空。
  - **读数**：`pnpm --filter @geewiki/web test` **902/902 绿**（新增 6 条纯逻辑 + 5 条源码守卫）、
    `pnpm typecheck` **全仓 exit 0**、`npx eslint` 改动文件 **0 error**、CDP 验收 **21/21**。
    后端未改一行——本轮只是接线。
  - **一个命名坑（值得记档）**：请求侧的 `'phrase' | 'terms'` 与响应侧的 `SearchMode = 'fts' | 'like'`
    **是两回事**（"我们怎么问的" vs "服务端怎么答的"），两者会出现在同一轮检索里。宿主里因此
    **刻意用了不同的类型名** `SearchQueryMode`，避免"改了请求侧却去读响应侧"的错配。界面上两者同时显示：
    「问法 精确匹配（整串连续）」与「服务端走 LIKE 短查询兜底」。
- **本机配置不再进 git，也不再进镜像（2026-09-19）**：用户看到工作树里 `config/plugins.base.json` 的
  `reasoningEffort` 被改过（那是他在设置页设的 `xhigh`），原话「这部分配置项不应该上传到git啊，
  你再检查一下其他插件的配置项有没有给上传到git了，这是很危险的行为」。
  - **审计结论（先回答"有没有"）**：**没有任何密钥进过 git**——工作树与历史都没有。被跟踪的配置清单
    **全库只有 `config/plugins.base.json` 一个**；`config/secrets.json`（模型 API key 的真实落盘位置，
    权限 0600）与 `config/plugins.session.json` 一直都被 `.gitignore` 排除；`git log --diff-filter=A`
    里从未出现过 `secrets.json` / `.env` / 任何本地覆盖层；被跟踪文件里的"密钥形状"命中全是占位符与
    测试夹具（README 的 `sk-REPLACE_WITH_YOUR_KEY`、测试里的 `sk-x`）。
  - **但同一轮查出一个真问题，比 base.json 严重**：`Dockerfile` 用
    `COPY --from=builder /src/config /app/config` 把**整个 `config/` 目录**打进镜像，而 `.dockerignore`
    当时**只排除了 `plugins.session.json`**。构建上下文是**开发者的本机目录**，里面有 `secrets.json`。
    已用探测构建实测：修复前 `/cfg/secrets.json` 确实躺在上下文里（`-rw-------`，70 字节）
    ⇒ **`docker compose up -d --build` 会把模型 API key 打进镜像层随镜像一起分发**，而 Dockerfile 里
    那句"构建上下文里只有 plugins.base.json"的注释是**假的**。（现存镜像侥幸没中：`geewiki:bc` /
    `geewiki:latest` 构建于 9/10，早于 `secrets.json` 的创建时间 9/14；`ghcr.io/geelinx-ltd/geewiki`
    是 CI 从干净检出构建的。三者的 `/app/config` 均已实测确认无 `secrets.json`。）
  - **根因**：`plugins.base.json` 同时是"随版本发布的默认值"和"运行期可写文件"。
    `Manager.persistConfig()` 按插件所在层选目标文件（`layerOf()`：不在会话层就写 base），
    内置插件全在 base 层 ⇒ **在设置页改任何已有插件的配置都会重写这个被跟踪的文件**（不需要点"持久化"）。
  - **做法**：`config/plugins.base.example.json`（**入库**）= 随版本发布的默认值（逐字等于原先 HEAD 的内容）；
    `config/plugins.base.json`（**不入库**）= 本机 live 文件，首次写入时生成。
    `packages/manager/src/index.ts` 新增 `exampleManifestPathOf()` / `readBaseList()`：live 缺失时读
    example 装配，**启动不写盘**（启动写盘会让只读挂载的部署直接启动失败）；写入永远只写 live 文件。
    文件名走**派生**而不是新增配置项——`ManagerConfig` 的构造点遍布测试与宿主，加一个必填字段
    等于要求每个构造点都知道这条约定。`.gitignore` 与 `.dockerignore` 都改成**默认拒绝 `config/*`**、
    只放行模板（逐个拉黑意味着"下次新增一个本机配置文件时默认泄漏"，这次就是被它咬的）；
    `Dockerfile` 改成只 COPY 那一个模板文件。
  - **验证**：探测构建（用真 `.dockerignore`）：修复前 `/cfg` 含 `secrets.json`；修复后只含
    `plugins.base.example.json`，三个本机文件全部被排除。**容器场景实测**：用一个只放模板的配置目录起
    真服务 ⇒ 日志 `[manager] 未找到 plugins.base.json：按随版本发布的默认值 plugins.base.example.json 装配`，
    21 条内置插件照常激活、HTTP 正常监听，且**启动后该目录里仍只有模板**（"启动不写盘"不是嘴上说的）。
  - **守卫 6 条**（`packages/manager/test/base-manifest.test.ts`）：文件名派生；live 缺失 ⇒ 按模板装配
    且不写盘；live 存在 ⇒ 以它为准（本机改动不被模板盖掉）；首次写入 ⇒ 生成 live 且模板逐字不变；
    `git ls-files` 事实断言（三个本机文件不得被跟踪、模板必须入库）；按语义求值 `.gitignore` /
    `.dockerignore`（每个本机文件都必须被排除、模板必须放行）。**后两条不只查 `git ls-files` 是有意的**：
    规则被删掉时索引仍然绿，直到有人 `git add -A` 才变红——那时已经晚了。守卫已做**反向验证**：
    临时在 `.dockerignore` 追加一条 `!config/secrets.json`，该用例立刻变红并点名"会进入构建上下文"；
    移除后文件校验和与实验前逐字一致。
  - **顺带订正两处过时口径**：实施日志下面那条"`@geewiki/postgres` 的 `password` 会明文落进清单"
    **已不成立**（`packages/db-postgres/src/index.ts` 的 schema 现在只有 `connectionStringEnv` /
    `passwordEnv`，文件头注写明"不提供任何明文字段"）；`docs/plugin-platform.md` 的 L-12 描述的
    `COPY /src/config` 已改。`docs/README.md`、`docs/architecture.md`、`docs/roadmap.md` 的"真源"口径
    与 `README.md` 的目录说明一并从 live 文件改成模板。
  - **同一批的收尾：`scripts/` 里的验收脚本也要能读"干净检出"**。它们原先是直接
    `readFileSync(config/plugins.base.json)`；live 文件不入库后，**最需要它们能跑的环境（CI、新克隆、
    Docker 构建）恰好只有 example**，会 ENOENT。新增 `scripts/lib/base-list.ts`
    （`resolveBaseListPath()` / `readBaseListText()` / `readBaseList()`，与 manager 的
    `exampleManifestPathOf` **同口径**：同目录、同主名、`.example.json`），9 个验收脚本 +
    `scripts/create-plugin.ts` 生成文案改用它；隔离模式（`cpSync(config → 临时目录)` → 改副本 →
    用副本起实例）一字未动。两个 `.mjs` 经核对只读写**自己刚写的**临时夹具，不读仓库清单，故未改。
  - **读数**：`pnpm test` **2284/2284**（26 个测试包，0 fail；`packages/manager` 270 → **276**）；
    `pnpm typecheck` **exit 0**（含 `tsc -p tsconfig.scripts.json` 这一段——`pnpm -r typecheck`
    **不覆盖 `scripts/`**，只跑前者会漏掉它）；`eslint` 改动文件与 `scripts/` 均 0 error。

- **模型的思考过程进了对话面板，默认折起（2026-09-19）**：用户原话「我想优化一下，把模型思考过程放进去，当然要折叠起来」。
  - **问题不是"没显示"，是"在适配器那层就被丢了"**：统一配置里 `reasoningEffort: 'xhigh'` 早就在下发
    `reasoning_effort`，上游（DeepSeek V4 Flash）**一直在吐 `reasoning_content`**，而
    `plugin-openai` 的 `deltaOf()` 只读 `choices[0].delta.content` ⇒ 思考内容一个字节都没往上走。
    用户在界面上看到的代价是一段几十秒的静默期，只有一句"正在思考…"。
  - **做法（一条链，每一段都有它非如此不可的理由）**：
    - `LlmChunk` 新增 `reasoning-delta`，**与 `text-delta` 并列而不复用它**：正文要进
      `LlmMessage[]` 回传给上游，思考**不该**进（多数网关拒收带 `reasoning_content` 的 assistant 消息，
      个别会把上一轮的思考当成新指令）。复用一条流就只能在"喂给模型"和"不喂给模型"之间二选一。
    - 适配器认两个字段名（`reasoning_content` / `reasoning`，与探测路径 `probe.ts` 的 `reasoningOf()`
      同一组）；`null`/空串**不产 chunk**（流式中间帧的常态是"字段在、值为 null"，那不是空思考）。
    - `plugin-llm` 的 `sanitizeNonTerminal` 是**白名单**——必须显式放行。漏写这一行**不会报错、
      不会有测试变红**，只会让"模型明明在思考、界面一个字都不显示"，所以补了一条专测它的用例。
    - `loop.ts` 把思考**只往外发、不入账**（只有 `text` 拼进转录）；服务端那侧它同样算"进展"
      （`watchdog.kick()` 在它之前执行）——这一点要紧：一个正常思考很久的回合**不会**被空闲计时器砍掉。
    - 服务端发**新中间帧** `thinking`（`SSE_EVENT_THINKING`，与 `tool` 一样**刻意不进 core**）。
      **不能复用 `delta` 加个字段**：帧名是客户端唯一的分流依据，复用会让没更新过的界面
      **把思考当正文渲染成答案**；而新帧名对旧界面就是一条 `invalid` 帧，按既有约定静默忽略。
    - 界面：`DockState.thinking` + 一个默认折起的块（复用工具行的样式语言与同一个 chevron 类）。
      `status` 帧**刻意不清它**——一次提问可能跨多个 HTTP 回合，在那里清空等于把第一轮的思考整段抹掉；
      清空只发生在"新的提问"（`withUserMessage`）。
  - **验证**：单测 **+5**（`@geewiki/ai-assistant` 236 → **241**；另在 `plugin-openai` 加了一条覆盖
    "两个字段名 + null 帧 + 先思考后正文"的用例）；真 LLM 打 `POST /api/ai/turn` 的帧名统计是
    `thinking×20 / delta×15 / tool×2 / status×1 / done×1`，`done.messages` 里**没有**任何思考内容。
  - **真浏览器验收 7/7**（`node data/verify/ai-thinking/run.mjs`，真 LLM，Chrome `--remote-debugging-port=9481`）：
    流式期间思考块出现（摘要「正在思考…（11 字）」）⇒ **默认折起**（`.gw-dock-think-body` 不存在）
    ⇒ 点开确有正文（287 字）⇒ 再点收回 ⇒ 回合结束后摘要变「思考过程（841 字）」⇒ 答案照常渲染。
  - **踩坑记录（给下一次）**：`app-dock` 在 `ON_DEMAND_SLOTS` 里、且**只有登录态才渲染**
    （`AppDock.tsx` 的决策 5）。而登录若用页面里的 `fetch` 完成，`location` 没变、React 的登录 store
    不会自己重取 ⇒ **只改 hash 的导航不会重新加载文档**，面板一秒都不出现（我第一次跑就卡在这里，
    报的却是"面板没出现"这种看起来像功能没做好的症状）。验收脚本必须先过 `about:blank` 再进目标页——
    `data/verify/ai-refresh/undo-turn.mjs` 早就这么写了。
  - **读数**：`pnpm test` **2278/2278**（26 个测试包，0 fail；`packages/web` 890、`@geewiki/ai-assistant` 241、
    `@geewiki/openai` 73、`@geewiki/llm` 94、`core` 68）、`pnpm -r typecheck` **27 Done / 0 error TS**、
    改动文件 `eslint` **0 error**（3 条既有 warning 与本次无关）。

- **SSO 的界面归还给提供者插件（本批，2026-09-16）**：用户原话「此页面有sso的内容，sso相关插件是没启动的，
  这部分前端应该属于扩展内容，应当由这部分的插件来提供」。
  - **问题**：账号页把「外部身份（SSO）」的界面（绑定确认卡片、"在登录页选择企业 SSO…"的空态、解绑列表）
    **写死在宿主里**，而 `@geewiki/oidc` 在基础层清单里根本没启用（`inactive`）⇒ 任何部署都会看到一个
    **指向不存在功能的界面**。归属结论：身份端点（`/api/auth/identities*`）由核心 `@geewiki/auth` 提供
    （机制，始终可用），而**界面**属于"谁提供外部身份谁负责"。
  - **做法**：宿主新增插槽 **`account-identities`**（三处镜像 `slots.tsx` / `pluginUiPlan.ts` /
    core 的 `SlotName` 同步，core 里基数 `multi`——多个 IdP 各占一行并不矛盾）；账号页只留**核心那件事**
    （「本地口令」状态），SSO 面板整块搬进新产物 `packages/plugin-oidc/ui/`（`client.js` 7.4 KB）。
    插槽位是**按需加载**（`ON_DEMAND_SLOTS`）：只有账号页会为它下载产物，匿名读者与其它页面不受影响。
    没装提供者时出口渲染 `null` —— 宿主连"外面有 SSO 这回事"都不再提。
  - **提示归路由、路由归宿主**：插件一度需要读 `window.location.hash` 取 `?link=required`，而宿主守则
    明令禁止插件碰路由（`pluginUi.test.ts` 的产物断言）。改成宿主读、当 **prop** 传
    （`AccountIdentitiesSlotProps.linkPending`）⇒ 这条纪律**不需要任何例外**，`@geewiki/oidc` 因此被
    纳进同一份产物守卫（`PLUGIN_UI_SOURCES` + `PLUGIN_STYLE_RELS`），它的 CSS/token/动效约定一并受检。
    "点掉「稍后再说」"的状态留在插件内部：宿主每次 re-render 都传 `true` 也不会把卡片翻回来。
  - **顺带修掉一个断掉的流程（由拆分的那个子任务发现）**：`LoginPage` 在需要绑定时写
    `window.location.hash = '/account'`——**把 `link=required` 丢了**，于是 SSO 回跳后确认卡片
    **永远不显示**（用户被带到账号页却没有任何可确认的东西）。现在改成 `'/account?link=required'`。
    这条不是本次要求的一部分，是核对"提示从哪来"时暴露的既有缺陷。
  - **验证**：真浏览器 **4/4**（`data/verify/account-sso/run.mjs`）：① 关态（=用户现状）账号页**无任何
    SSO 文案**、核心「本地口令」仍在；② 用假配置临时启用 ⇒ 插件自己的面板出现（"外部身份 / 通过企业
    SSO（OIDC）登录的方式…"）；③ 停用后回到关态。脚本收尾已还原（`config/plugins.session.json` 为
    `{enabled: []}`，没留痕迹）。
  - **守卫**：`packages/web/test/accountSlot.test.ts` **3 例**（账号页代码里不得再出现 SSO/外部身份/
    绑定解绑 API；插槽名三处镜像一致 + 在按需清单里；提示必须由宿主传、插件不得读 `location`）
    ⇒ web 785 例；`pluginUi.test.ts` 名单扩到三个插件后 16 例全过。
  - **读数**：`pnpm test` **1904/1904**（24 个测试包，0 fail；`packages/web` **785**、`@geewiki/oidc` **17**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 回退之后正文自动刷新（2026-09-16）**：用户原话「现在是回退后不会自动刷新」。
  与上一批"AI 改完不刷新"**同一个根因的另一半**：回退走的是服务端撤销执行体（正文按快照改回去了），
  而页面上那份正文是详情组件取来的数据——没人通知它。
  - **做法**：复用上批建立的那条缝隙（`geewiki:content-changed`），把广播抽成共用的
    `notifyHostChanged(slugs, source)`（工具写完 → `source='tool'`，回退完 → `source='undo'`，
    source 只用于诊断）。回退路径在**服务端真的撤掉了东西**时广播（`report.undone.length > 0`）——
    全部冲突时库根本没变，重取一次纯属打断阅读。受影响的页面由纯函数
    `undoneSlugs(records)` 从**本轮记录**取（撤销报告里只有给人看的一句话，不携带结构化目标；
    记录自带 `target`，判据在本地就是完整的），已撤过的记录跳过，取不到 slug 时返回 `null` ⇒
    宿主按"不知道是哪一页"处理（重取当前页）。
  - **守卫**：`test/uiDockContent.test.ts` **+2 例**（`undoneSlugs` 的去重 / 跳过已撤 / 无目标 ⇒ `null`；
    回退后必须广播且**不该在什么都没撤时也刷**）⇒ 12 例；既有的事件名镜像守卫里的 `source` 断言
    跟着改成带来源后缀的形状。
  - **真浏览器验收 5/5**（`data/verify/ai-refresh/undo-turn.mjs`，真 LLM）：让 AI 用 `page.update` 改当前页
    ⇒ 正文自动出现改动 ⇒ 点 dock 里的「回退到这一轮之前」⇒ **正文自动变回原文**（`window` 哨兵证明
    全程没有页面重载）⇒ 并且**库里也确认撤回了**（不只是界面）。脚本结尾恢复原文。
  - **我这次又踩了那个已经记在案上的坑**：只跑 `pnpm --filter @geewiki/web build:plugin-ui`
    只把产物写进 `packages/web/public/`，而服务端托管的是 **`packages/web/dist/`**
    （插件 UI 资产根缺省回落 webDist）⇒ 浏览器拿到的是**旧 bundle**，于是第一次跑验收
    "库里撤回了、界面没动"——看起来像功能没修好。补一次完整的 `pnpm --filter @geewiki/web build`
    后 5/5 通过。**结论：改插件 UI 后必须跑完整 build，否则验收在验旧产物。**
  - **读数**：`pnpm test` **1901/1901**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **236**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 助手的空闲计时器从未被重置 + 「继续」按钮根本不存在（2026-09-16）**：用户看了上一批的截图，两条反馈都对：
  「首先没有继续这个按钮，其次，模型服务是有反应的」。两条都是我的错，且第二条指向一个**真 bug**。
  - **真 bug：`watchdog.kick()` 从未被调用过**。`kick()` 是重置空闲计时器的**唯一** API，而本插件里
    只有 `createIdleWatchdog(...)` 与 `clear()` ⇒ 计时器只在回合开始时上弦一次，**任何超过 30 秒的回合
    都会被判成"空闲"并中止**，哪怕上游一直在正常吐字、哪怕我们正忙着跑工具。用户那次一轮跑了 9 个工具
    （读页面 + 检索）总时长过 30 秒 ⇒ 被砍；而我上一批据此写下"模型服务一直没有响应"的结论，
    是把**自己没接上的信号**当成了别人的问题（用户当场指出上游有反应）。
    修法：路由的事件回调里 `watchdog.kick()`——loop 每有一件事发生（开始吐字、工具开始/结束）都会走那里，
    这正是"有没有进展"的权威信号；工具执行期间上游一个字节都不发，只在上游分片处重置是不够的。
  - **中止文案不再替用户断定原因**：`idle_timeout` 改成「本轮长时间没有任何进展（上游没有响应，或某个工具卡住了），
    已中止（本回合已执行 N 个工具，结果都还在）。可以直接点下面的「继续」接着做。」——两种可能都说，
    因为空闲判据分不出是上游卡还是工具卡。
  - **「继续」按钮真的加上了**：中止后就地渲染（`state.error.code === 'ABORTED' && !streaming`），
    点了以**用户消息**的形式发「继续」（与在输入框里敲字完全同一条路径、同样留痕，不做"隐藏的重发"）；
    `send(preset?)` 新增可选参数→同一实现，且点按钮**不清空**用户正在输入的内容。
  - **时限从"写死的选项"改成配置项**：那两个时限此前只从 `apply(ctx, config, options)` 的**第三参**读，
    而管理器激活插件时只传两个参数 ⇒ 那两个选项在生产里**根本到不了插件**，生效的永远是核心默认 30s/120s。
    现在它们是 `AiAssistantConfig` 的字段（`streamIdleTimeoutMs` / `streamHardTimeoutMs`，带范围与说明，
    可在配置界面里改），取值三级：**配置项** > 插件选项（程序化装配） > 核心默认。
    本部署在 `config/plugins.base.json` 里放宽成 **空闲 90s / 硬限 300s**（实测这台网关确实慢）。
  - **验收**（`data/verify/ai-refresh/long-turn.mjs`）：同一个"读 8 篇再总结"的请求，改之前**30.002 秒**被
    `idle_timeout` 砍掉（日志 `轮次=1 工具=0`），改之后**跑到 200 秒**才以上游自身失败收尾
    （`PROVIDER_ERROR`，`本轮中止` 计数为 0）——即看门狗不再把"慢"当成"死"。
    这台实例的模型网关当前确实不稳（`PROVIDER_ERROR`／早前见过上游 500），所以"整轮成功"这一条
    当场没能复现；能复现的是"不再被空闲超时误杀"。
  - **守卫**：`test/uiDockContent.test.ts` **+2 例**（路由必须调 `watchdog.kick()`——这条 bug 的守卫；
    中止后的「继续」按钮必须真的存在、真的发「继续」、且不清空输入）⇒ 10 例；
    `test/loop.test.ts` 的空中文案断言同步更新（不再把锅扣给上游）⇒ 35 例；
    既有的 `uiDockScroll.test.ts` 那条 `send()` 签名守卫一并订正（签名多了可选参数）。
  - **读数**：`pnpm test` **1899/1899**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **234**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 轮次中止的"原因"必须说清楚（2026-09-16）**：用户截图问「这是什么情况」——
  那一轮跑了 10 个读工具（`read_page`×5、`list_pages`、`search_kb`×3）后，界面只有一行红字
  「本轮已取消（超时或客户端断开）」。查下来是**四条完全不同的路径共用了一句文案**
  （空闲超时 30s / 硬超时 120s / 客户端断开 / 插件卸载），用户看不出发生了什么、也不知道下一步该做什么。
  - **做法**：`createIdleWatchdog` 的 `onTimeout` 现在带 `'idle' | 'hard'`（core，向后兼容——
    老调用方写 `() => …` 仍然合法）；`@geewiki/ai-assistant` 用 `ac.abort('idle_timeout' | 'hard_timeout' | 'client_disconnect' | 'shutdown')`
    把原因放进 `AbortSignal.reason`；`loop.ts` 新增 `TurnAbortReason` 与 **唯一**的文案映射
    `abortMessageOf(reason, toolCount)`，两处 abort 分支共用它。四句文案各给**下一步**：
    空闲超时说"上游没响应、不是你的操作问题，可以点「继续」接着做"；硬限说"这次要读/搜的东西比较多，
    可以把要求拆小一点，或点「继续」"；断开说"服务端会同时停止调用上游，不会继续消耗额度"；卸载说明是运维动作。
    未知原因退回原来那句（不变成空白）。文案里还带上**本回合已执行 N 个工具，结果都还在**
    ——中止不等于白干，这是用户当时最该知道的一件事。
  - **可观测性**：中止时服务端补一条 warn，把"界面上一句话"变成"日志里能查的答案"：
    `[@geewiki/ai-assistant] 本轮中止: reason=client_disconnect 轮次=1 工具=0 用时=13ms（硬限 120000ms / 空闲 30000ms）`
    （实测输出，触发方式是真发起一轮再断开客户端）。
  - **守卫**：`packages/plugin-ai-assistant/test/loop.test.ts` **+2 例**（四种原因各给可执行文案、
    且都不得退回那句模糊话；真的 abort 时 outcome 用的是映射后的文案）⇒ 该文件 35 例。
  - **读数**：`pnpm test` **1897/1897**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **232**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 改完当前文章后正文自动刷新（2026-09-16）**：用户原话「让ai修改当前文章后，不会刷新」。
  查下来是**两个各自独立、都必须修的缺陷**——只修任何一个都不会好：
  - **① 服务端从来没告诉过浏览器"这一回合发生了写操作"**。`LoopOutcome.pendingMutatingTools`
    原实现是从**该帧里模型发起、还没执行的调用**（`partial.pending`）里筛写工具，而"模型调用写工具
    之后直接收尾"是最常见的形态 —— 收尾那一帧没有 pending，于是这份名单**恒为空**。
    真帧实测（`data/verify/ai-refresh/diag-sse.mjs` 直接 POST `/api/ai/turn` 打印 SSE）：
    `toolCalls: null, mutatingTools: []`，而库里**已经改了**。
    修法：字段改名 `mutatingTools`（语义变成"本回合**执行过**的写工具名"），并在**调用处按描述符累加**
    （跨轮、去重；服务端与客户端的写工具都登记），早退路径也带上当时已累积的值。
  - **② 客户端没有人负责"通知宿主正文过期"**。插件 UI 与宿主是**两份独立构建**（插件 bundle 只外置
    react 系）⇒ 只能走 `window` 上的 DOM 事件这条缝隙。新增宿主侧
    `packages/web/src/lib/contentEvents.ts`（`geewiki:content-changed`、**防御式**解析、
    订阅返回退订函数），详情页订阅后**重取正文**；插件侧新增纯函数
    `affectedSlugs(toolResults, mutatingTools)`（三态：`null`=没有成功的写操作 / `[]`=改了但不知道是哪一页 /
    具体 slug 列表）并在**两处回合边界**（工具轮结束 + 整轮结束）广播。
    详情页的分流：**当前页或"不知道是哪一页"⇒ 重取正文**；改的是别的页 ⇒ 只失效列表缓存
    （无谓重取会让阅读位置跳动）。编辑路由压根不渲染详情组件，所以不存在冲掉草稿的问题。
  - **一条方法教训（本批最值钱的）**：第一版客户端判据用 `done.toolCalls` 找写工具，
    **本地单测全绿**（用例喂的是"我以为的帧形状"），真回合里却是"AI 改了库、屏幕不动"
    —— 改成只读 `toolResults` 后才暴露出服务端那份名单**本来就是空的**。
    **结论：凡是"形状类"的判据，必须用真帧验一次**，别用自己构造的形状自证。
  - **守卫**：`packages/plugin-ai-assistant/test/uiDockContent.test.ts` **8 例**
    （含"最终帧 `toolCalls: null` + 一条成功的 `page.update` 结果"这个**真实形状**的回归用例、
    事件名与宿主逐字比对的镜像守卫、两处广播点与 `null` 不广播的源码守卫）；
    `test/loop.test.ts` **+2 例**（写工具跑完后模型直接收尾 ⇒ 名单仍必须含它；读工具不进名单且去重）
    —— 顺带发现夹具 `fakeTool` **从不设 `mutating`**，这条路径此前在单测里从未被走到；
    `packages/web/test/contentEvents.test.ts` **5 例**（畸形事件不改崩、非字符串项被丢掉、
    订阅/退订、详情页的"当前页 vs 别的页"分流规则）。
  - **真浏览器验收 9/9**（`data/verify/ai-refresh/run.mjs`）：① 确定性半边——库里改完正文后广播事件 ⇒
    正文自动出现新内容，且 **`window` 哨兵证明没有发生页面重载**；反向对照（改别的页 ⇒ 当前正文不被重取）；
    ② 整条链——在 dock 里让真 LLM 用 `page.update` 改当前页 ⇒ 屏幕上**自动**出现改动。
    脚本结尾把 demo 页正文恢复原样（不留标记）。
  - **读数**：`pnpm test` **1895/1895**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **230**、
    `packages/web` **782**）、`pnpm -r typecheck` **27 Done / 0 error TS**。
- **导航批：层级折叠 · 左栏隐藏（含继承）· 同层拖动排序（2026-09-16）**：用户三条原话——
  「优化当前的"全部页面"，要求文章之间如果有父子关系的，就缩进折叠」、
  「对于文章可以选择在左边栏隐藏，其中父级隐藏，子级也都不显示，隐藏的文章在"全部页面"中将颜色标为灰色来方便辨析」、
  「在"全部页面"可以拖动调整文章顺序」。**侧栏本来就是**按 slug 层级缩进折叠的树（`lib/navTree.ts` 的 `buildNavTree`），
  所以三件事都落在**「全部页面」列表页**（`#/wiki/list`，此前是一张扁平表格）。
  - **数据层（两张新表，方言中立）**：`packages/plugin-wiki/migrations/0003_page_nav_state.sql` 建
    `page_nav_state(slug, hidden, updated_at)` 与 `page_nav_order(parent, item, position)`。
    **为什么顺序不是"每页一个 sort_key"**：同层里混着**没有页面的分组**（层级由 slug 决定，本实例的 `guide`、`demo` 就是），
    分组没有可写序号的地方 —— 那样一来分组永远排不了序，还会在"排过的在前"规则下被整体挤到同层最下面。
    顺序因此**按父级存一整串**，`item` 既可以是页面 slug，也可以是分组路径（形状一致，"直接子级"判据 `parentOf(item) == parent` 对两者是同一条规则）。
    两张表都**不放进 `pages`**：它们不参与可见性判定（策略层真源仍是 `visibility/published_at` 与块 `tier`），
    而加列要同时改 sqlite/postgres 两份建表并影响所有 `SELECT * FROM pages`。
  - **隐藏的语义（关键设计）**：**只写自己那一行，继承在读时推导**（`markHidden` 逐层传下去）。
    于是"父级隐藏 ⇒ 子级也不显示"成立，而**取消父级隐藏时子级自动恢复**——级联写会把这个信息永久丢掉。
    隐藏**不影响可见性**：被隐藏的页照样直链可读（验收里有一次 `GET /api/pages/demo%2Fparent` = 200）、照样被检索命中，
    只是不进侧栏与"上一篇/下一篇"（后者是用户选的口径）。列表页**刻意不剪枝**：隐藏项以灰色 + 「已隐藏」显示出来，
    否则用户再也点不到那个"取消隐藏"；被父级带下来的行标「随父级隐藏」且**不给开关**（它的状态不由自己决定）。
  - **端点（两个，沿用既有写入门控）**：`POST /api/pages/:slug/hidden`（`requireCap(…, 'canEdit')`，与 PUT/DELETE 完全同口径：
    无主体 401、非法 slug 400、看不见 404 不泄露存在性、不够格 403）；`POST /api/pages/order`（`{parent, items}`，
    逐个**页面项**走 `requireCap`；**分组项跳过逐页判定**——`guide` 这类路径没有页面，`resolvePage` 对它只会 404，
    而它只是一层目录的位置，暴露面为零，故只要求已登录）。`GET /api/pages` 现在一并下发 `nav_order`（与 `pages` 同一次请求，
    避免"顺序是旧的、隐藏是新的"这种中间态）。
  - **客户端**：`lib/navTree.ts` 新增 `navOrderMap` / `compareNodes(a,b,order)`（顺序表里的按位次在前，没记录的按段名在后）/
    `pruneHidden`（**纯分组被剪空后整条丢掉**，否则侧栏会渲染出空的展开项）/ `navRows`（按折叠状态展平成行 + 携带
    `siblings/index/parent` 供排序用）/ `moveWithinSiblings`。侧栏只在**剪枝后**的树上渲染并统一由 `countPages` 报数；
    详情页的"上一篇/下一篇"走**同一棵树、同一份顺序**（`flattenPages` 跳过隐藏 ⇒ 翻页自动跳过）。列表页新增「导航」列：
    行内「隐藏/取消隐藏」（`aria-pressed`）、`↑`/`↓`（**拖动的键盘等价物**）、以及 HTML5 拖动；
    **拖动只接受同层**（`drag.parent !== row.parent` 直接拒绝）——跨层拖放等于把页面挪到别组，而层级是 URL 的一部分。
  - **真浏览器验收 21/21**（`data/verify/nav-tree/run.mjs`，真实例、脚本末尾**恢复原状**）：缩进三档（12/30/48px）、
    折叠后该父级的子级行消失且父级仍在、父级隐藏后子级标「随父级隐藏」且**没有开关**、侧栏条目 22 → 20（父级与子级同时消失）、
    直链仍 200、取消隐藏后侧栏恢复、`↓` 使 `architecture` 从下标 1 → 2、**刷新后仍是 2**（站点级）、
    跨层级 `POST /api/pages/order` 得 400 `invalid_order_not_a_sibling`、隐藏后"下一篇"跳过它（`#/wiki/deploy`），
    收尾把隐藏与顺序都恢复成基线。实况图 `data/verify/nav-tree/list-hidden.png`。
  - **单测**：`packages/plugin-wiki/test/nav.test.ts` **6 例**（upsert 幂等、页面不存在不写悬挂行、分组项可排序、
    整组重写不留同位、三种拒绝且拒绝时不改数据、重开实例后仍在）；`packages/web/test/navHidden.test.ts` **12 例**
    （顺序表语义、继承只读推导、剪枝含"剪空的纯分组"、翻页跳过、`moveWithinSiblings` 边界、顺序与隐藏互不干扰）；
    `packages/web/test/navListUi.test.ts` **4 例**源码守卫（列表页不得剪枝 + 灰色 + 两种隐藏文案、开关只给非继承行、
    拖动判同层 + ↑↓ 可访问名、侧栏与翻页都按剪枝树）。
  - **两条量取教训**：① 侧栏的**折叠分组不渲染子级**（`NodeRow` 只在展开时渲染 `<ul>`），所以"侧栏里有没有这一页"
    必须先**全部展开**再取样——第一版脚本因此在折叠态下误判"侧栏看不到 demo/parent"（它只是藏在没展开的 `demo` 里）；
    ② `node:sqlite` 返回的是 **null 原型对象**，`assert.deepEqual` 拿它跟对象字面量比会判不等（字段看起来都一样）⇒ 比字符串。
    夹具另有一坑：`DatabaseAdapter.migrate()` 收的是**目录**（适配器自己去读 .sql），夹具第一版写成了"收 `{name, sql}[]`"⇒
    绑参时报 `Provided value cannot be bound to SQLite parameter 1`（报错点离原因很远）。
  - **读数**：`pnpm test` **1880/1880**（24 个测试包，0 fail；`packages/web` **777**、`packages/plugin-wiki` **120**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 助手：卡片表面修回外壳内（2026-09-16，用户报"对话框是透明的"）**：用户截图反馈「这对话框现在样式不对啊，
  怎么是透明的，要跟展开的风格契合」。上一个批次把两个输入行合并时留下**两处只有量才能发现的错**，本批一并修掉：
  - **① 输入行被留在了外壳之外**。合并时我把新输入行替换在旧 `.gw-dock-bar-clip` 的位置——那本来就是
    **外壳的兄弟节点**，于是卡片表面（我同时把描边/底色/模糊/圆角搬到了 `.gw-dock-shell`）盖不到它：
    量出来 `shell=[653,829]`（只到裁剪盒）而输入行在 `[829,884]`，视觉上就是"面板透明、输入行单独一个框"。
    修法：把输入行挪进外壳。**这个错顺序检查抓不到**（外壳 → 裁剪盒 → 输入行的先后顺序完全正确），
    所以守卫 ⑥ 补了一条真正的**配对检查**（`closeIndexOf` 数 `div/section/form` 找到外壳的闭合位置，
    断言输入行在它之内），并做了反向对照（把外壳的闭合挪回输入行之前 ⇒ ⑥ 变红）。
  - **② `grid-template-rows` 的两条轨道**会**一起被插值**。写成 `0fr auto → 1fr auto` 之后，
    逐帧量到第二行（输入行）中途被撑到 **98.5px** 再缩回 55px（`getComputedStyle(shell).gridTemplateRows`
    逐帧打成 `"43.28px 98.5px"` 这种样子）⇒ 输入行在动画里上下移动 **43px**。根因是 `fr` 轨道在有 `auto`
    兄弟轨道、且容器高度由内容决定时，过渡期间多出来的空间被 `auto` 那条吃掉。修法：网格**只留一条轨道**
    （裁剪盒），输入行改为**绝对定位**钉在卡片底边（`left/right/bottom: 0`），卡片用
    `padding-bottom: 55px` 给它留位（守卫会解析这两个数并断言相等）。
  - **复测读数**：展开与收起两个方向，输入行 top / 底边 / 输入框 top 波动 **43px → 0px**、始终可见（55px）；
    外壳盒子 `[653,884]` 高 231 = 裁剪盒 174 + 输入行 55（表面覆盖到输入行）；`root.top` 单调；
    裁剪盒 `scrollTop` 全程 0。深色模式实况截图 `data/verify/dock-ui/style-dark.png`（表头 / 空态 / 分隔线 /
    输入行同属**一张卡**）、风格量取 `data/verify/dock-ui/style-probe.mjs`（打印各层计算样式与 token 解析值）。
  - **读数**：`pnpm test` **1858/1858**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **220**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 助手：收起态与展开态的输入框合并成同一个盒子（2026-09-16）**：用户原话「感觉整体动画的衔接还是有问题，
  感觉收起的输入框和展开的是两个东西」——**那句话字面上就是对的**：收起态是 `.gw-dock-bar` 里的 input、
  展开态是面板底部 `.gw-dock-form` 里的 input，连占位文案都不同（「问 AI 助手…」vs「问关于「slug」或整个知识库…」）。
  为掩盖这段交接，前面几批堆了三处补丁：输入条常驻 DOM、裁剪盒高度插值、展开时把它抬 19px 去对齐面板里那一行
  （`--dock-row-lift`）。补丁再多也改不掉"有两个盒子"：交接期间两个框一收一放，看起来就是换了一个东西。
  - **做法（结构改动）**：把输入行移出面板、成为卡片（`.gw-dock-shell`）的**第二个网格行**：
    `.gw-dock-shell { grid-template-rows: 0fr auto }` → 展开态 `1fr auto`。卡片钉在屏幕底边（根是
    `position: fixed; bottom: 16px`），所以第一行（裁剪盒 = 表头 + 对话流）长大时**卡片向上长，
    第二行一动不动**。整个界面只剩**一个** `<form className="gw-dock-row">`、**一个** `<input>`、一份占位文案。
    `inert` 也随之从外壳挪到**裁剪盒**上——输入行住在外壳里，收起态恰恰是它最该能打字的时候（点它才展开）。
    卡片的表面（描边/底色/模糊/圆角/投影）统一挪到外壳，输入行自己不再画一层（两层描边正是"两个东西"的观感来源），
    只在展开态加一条上分隔线。**删除**：`.gw-dock-bar`、`.gw-dock-bar-clip`、`.gw-dock-form`、
    `--dock-row-lift`、以及"两个输入行各写一份 55px 高度"的隐患（现在是一份共用高度）。
  - **逐帧实测（`data/verify/dock-ui/flicker.mjs`，页面内 rAF 录制）**：展开与收起两个方向，
    **输入行的 top / 底边 / 输入框 top 全程波动 0px**、始终可见（55px）；`root.top` 单调（653..827）；
    裁剪盒 `scrollTop` 全程 0。中途帧截图 `data/verify/dock-ui/mid-open.png`（110ms 处：表头与空态文案在上方
    长出来，输入行留在卡片底部，**同一张卡**）。另外两条既有验收也重跑通过：
    `autoscroll.mjs`（自动置底 + 回看时不被拽走）与 `toolrun.mjs`（工具摘要收成一行、点开/收回）——都 `全部通过`。
  - **守卫**：`uiDockMotion.test.ts` 按新结构重写并补强（**12 例**）：⑥ 现在直接钉"**只有一个输入框**"（源码里
    `className="gw-dock-input"` 恰好一次、`<form` 恰好一个、旧类名不得回流）+ 输入行必须在裁剪盒**之外**、
    卡片表面必须在外壳上；② `inert` 必须在裁剪盒上且**外壳不得 inert**；⑧/⑨ 输入行任何状态都可交互、
    ref 挂在唯一输入行上；⑦ reduced-motion 清单枚举同步；⑩ 几何过渡必须走 `--ease-move`（重写，原第 ⑩ 条
    在改写过程中被误删——它钉的是"宽度/揭幕走 `--ease-move`、`--ease-standard` 只给颜色与淡入"）；
    ⑪ 变成**防回流**：`--dock-row-lift` / `.gw-dock-bar*` / `.gw-dock-form` 在代码里不得再出现（注释除外）。
  - **读数**：`pnpm test` **1858/1858**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **220**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 助手：展开/收起不再"下半部分先消失再出现"（2026-09-16）**：用户原话「当前 dock 展开时，
  下半部分会先消失再出现，收起时也是，这是可以优化的吗」。
  - **先量再改**：逐帧取样必须在**页面内**用 rAF 录制（经 CDP 每帧来回一次要十几毫秒，240ms 的动画根本采不到），
    探针 `data/verify/dock-ui/flicker.mjs` 记录每帧的 root/clip/panel/form/bar 矩形与
    "**输入行可见高度**"（收起态 `.gw-dock-bar` 与展开态 `.gw-dock-form` 在两个不同的裁剪盒里，取两者的最大值）。
    实测确认：展开动画的**第 1~3 帧输入行谁都不在**——`bar` 已随 `.gw-dock-bar-clip` 被裁掉，
    而 `form` 还在裁剪盒下方（`form=[854,909]` vs `clip=[681,820]`）⇒ 底部空约 50ms。
  - **根因是方向**：网格行 `0fr → 1fr` 让裁剪盒**顶边先出现**、内容照常锚在裁剪盒顶部 ⇒ 只有面板**上半部分**
    先露出来；而输入行在面板的**底部**，要等裁剪盒长到最后才轮到它。底部 dock 正确的手感是"从输入行往上长出来"。
  - **修法（纯 CSS）**：`.gw-dock-clip` 改成 `display:flex; flex-direction:column; justify-content:flex-end`
    （锚到**底边**，被裁掉的是上面的历史内容），并给 `.gw-dock-clip > .gw-dock-panel` 加 `flex: none`——
    flex 子项默认 `flex-shrink:1`，不写这句面板会被挤成裁剪盒的高度，揭幕就变成"整块挤扁"。
  - **复测读数**：展开与收起的"输入行谁都不在"帧数 **3/25 → 0/25**，`root.top` 仍**单调**（无回弹）；
    交接期两行同时在场的重叠约 50ms（`clip h=37` 时 bar=26 / form=26）——是**交叉交接**而不是空档。
    动画中途的实况截图 `data/verify/dock-ui/mid-open.png`（110ms 处：卡片已长出一截，输入行始终在）。
  - **守卫**：`packages/plugin-ai-assistant/test/uiDockMotion.test.ts` 新增 ⑫（裁剪盒必须 flex 纵向锚底 + 面板 `flex: none`），
    并做了**反向对照**（删掉 `justify-content: flex-end` ⇒ 只有 ⑫ 变红）。
  - **两条量取教训**：① 清空帧缓冲与"点击触发"是两次 CDP 往返（十几毫秒），而录制器 ~16ms 才采一帧
    ⇒ 两者之间可能一帧都没有，导致数组里全是"已收起"、分析找不到翻转点（第一版白跑一次，现已先歇 200ms 再点）；
    ② 收起方向的量取前**必须轮询确认已展开**——脚本每次都会重新加载页面，dock 必然从收起态开始。
  - **读数**：`pnpm test` **1858/1858**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **220**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 助手：工具活动收成一行（2026-09-16）**：用户原话「当前回答完后，所有工具的使用都会堆积在下面，感觉不好」。
  改前 `renderThread` 把本回合的每个工具调用平铺成一行 `<li>`（`<ul class="gw-dock-tools">`）堆在回答下方——
  一轮里查两次知识库、搜一次网络、改一次页面，底部就是四五条**过程信息**，而回答结束后用户要看的是结论。
  - **做法**：新增组件 `ToolRun`（`ui/index.tsx`）+ 纯函数 `toolRunSummary`（`ui/dockPlan.ts`）。默认只剩一行
    「本次用了 N 个工具：list_pages、web_search」（同名工具名字只写一遍、**次数仍报 N**），点开才铺明细。
    三条行为约束写进注释与守卫：① **流式期间照旧铺开**——那时这堆活动就是"它在干活"的进度指示器，收起来反而像卡住；
    ② **一轮结束（`streaming` 落回 false）就收起，并把"手动展开"一起复位**——否则用户上一轮展开过一次，
    之后每一轮都铺开，堆积又回来了；③ 开合是**受控**的（`aria-expanded` 与渲染一致），不用 `<details>` 的原生开合
    （它与"流式结束自动收起"会打架）。有失败时摘要行变红并点名数量（`…（其中 1 个失败）`）——否则收起后用户永远看不出出过问题。
  - **图标**：新增 `ChevronIcon`（向右的折角，展开时由 CSS 转 90°，只做 transform、不换第二个图标），
    并把它登记进既有的图标守卫（那份清单是**枚举**不是"至少包含"）；`prefers-reduced-motion` 里同步关掉这条过渡。
  - **真浏览器验收 15/15**（`data/verify/dock-ui/toolrun.mjs`，会真的问一个"先查知识库"的问题把 `list_pages` 逼出来）：
    回合进行中明细铺开（进度可见）⇒ **回答完成后只剩一行**且明细**不在 DOM 里**（`aria-expanded=false`、箭头指右）
    ⇒ 点开有 1 行明细（工具名 + 状态 + 摘要）⇒ 再点收回。
  - **两条量取教训**：① "流式"不能用"此刻有没有工具正在执行"来判断（工具跑得快时永远取不到样本 ⇒ 假红），
    它是**整个回合**的状态；② 展开明细会让内容变高、而对话区是**自动置底**的 ⇒ toggle 会被滚上去，
    第二次点击必须**重新量坐标**，沿用旧坐标会点空（本脚本第一版就是这么假红的，反倒反证了自动置底在生效）。
  - **读数**：`pnpm test` **1857/1857**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **219**，新增 `uiDockToolRun.test.ts` **6 例**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **AI 助手：发送消息后自动置底（2026-09-16）**：用户原话「当前的 AI 助手中，我发送新消息时，不会自动置底，
  每次都要手动滑到最下面」。**根因是这块能力从来没有过**——`packages/plugin-ai-assistant/ui/index.tsx` 里
  **一处滚动相关代码都没有**（grep `scroll` 只命中一条"焦点交接必须 `preventScroll`"的注释），消息追加进
  `.gw-dock-thread` 之后没有任何东西去改变它的 `scrollTop`。
  - **做法**：判据写成纯函数 `isAtBottom({scrollTop, scrollHeight, clientHeight}, eps = STICK_BOTTOM_EPS = 24)`
    放进 `ui/dockPlan.ts`（边界才测得住），组件侧只做三件事：① 对话区挂 `threadRef` 并在**自身 `onScroll`** 里
    更新 `pinnedRef`（贴底 ⇒ 继续跟随，往上翻 ⇒ 停止跟随）；② 内容增长时若仍贴底就把 `scrollTop` 设到底
    （依赖是"几个数字拼成的内容指纹"`messages.length:answer.length:activities.length:journal.length:streaming:error`，
    **不能把 `state` 整个放进依赖**——每帧新对象等于每帧都滚一次）；③ `send()` **强制**把 `pinnedRef` 置回 true：
    用户刚提的问题必须看得见，这正是本次返工的起因。
  - **为什么容差是 24px 而不是 0**：滚动位置是小数、长内容里浏览器还留一两像素，用 `=== 0` 判定会把"明明在底部"
    算成"用户滚上去了"，表现为**流式回答不再跟随**；也不能太大（超过半屏就会把"往上翻了一屏"误判成仍在底部而强行拽下去）。
  - **硬约束（写进注释与守卫）**：自动置底**只能滚对话区自己**，绝不能用 `window.scrollTo` / `scrollIntoView`——
    面板住在 `.gw-dock-clip`（`overflow: hidden`）里，`scrollIntoView` 会为了把元素带进视野去滚**裁剪盒**，
    把展开动画的揭幕起点拽到底部（动画批正是这么发现 `scrollTop≈200` 的）。另外不得引入 `smooth` 滚动：
    流式每帧滚一次会互相打断。
  - **真浏览器验收 13/13**（`data/verify/dock-ui/autoscroll.mjs`，会真的发两次提问）：先在 `localStorage` 里种一段
    **20 条消息的长历史**（否则一次短问答撑不出滚动条，`scrollHeight === clientHeight` 会让所有"delta≈0"的判据**空转**——
    第一版脚本就是这么连报多个假绿的），再从历史面板点进去 ⇒ 可滚 **2957px**；随后：发送后 `delta=0`、
    回答流式长出来持续跟随、**往上翻到 `delta=720` 后再发新消息，被带回 `delta=0`**（用户报的那条）、
    往上翻后跟随随之关闭（停在那儿不被拽走）。
  - **两条量取教训**：① 合成 Enter 键（`Input.dispatchKeyEvent`）在本环境**没有**让表单提交 ⇒ 要验"发送后"的行为
    必须**点发送按钮**，并在点之前核对输入框真的拿到了文本（否则整个脚本会静默空转，还会被误读成"bug 复现了"）；
    ② 程序化 `.focus()` **不触发** React 的 `onFocus` ⇒ 打开 dock（收起态那条输入条靠 `onFocus` 展开）必须用**真鼠标点击**。
    另外 `Runtime.evaluate` 只回 `exceptionDetails` 时不能再静默取 `value`——注入脚本的转义错误就是这样被吞掉的
    （现已改成抛错）。
  - **守卫**：`packages/plugin-ai-assistant/test/uiDockScroll.test.ts` **7 例**——`isAtBottom` 的边界（含"内容还没超出视口"
    与"容差被改动"）、对话区必须挂 `threadRef` + 在 `onScroll` 里用 `isAtBottom`、`send()` 必须强制恢复跟随、
    跟随效果必须同时看"面板展开"与"贴底"、禁 `window.scrollTo`/`scrollIntoView`/`smooth`、内容指纹不得整体依赖 `state`。
  - **读数**：`pnpm test` **1851/1851**（24 个测试包，0 fail；`packages/plugin-ai-assistant` **213**）、
    `pnpm -r typecheck` **27 Done / 0 error TS**。
- **阅读页「本页目录」改为真正跟随下滑（本批，2026-09-16）**：用户原话「文章中的本页目录要求随用户下滑，能够一直显示在右侧，
  方便导航」。**根因不是样式写漏，而是 sticky 一直没生效**——组件里 `position: sticky` 早就有，但
  `position: sticky` 只能在自己的**包含块**内部滑动，包含块就是那层 `<aside>`；而右栏容器 `.gw-reader-rail` 是
  `flex flex-col`，**flex 纵轴不拉伸**（`align-items: stretch` 只管横轴）⇒ `<aside>` 留在内容高度（真浏览器实测 **516px**，
  与目录自身等高），rail 却被栅格行拉到 **8818px**（= 正文高度）⇒ 目录**一格都滑不动**：滚 1800px 后它的顶边跑到 **−1645**，
  仍在文档流里被推走。祖先链的 `overflow` 全部是 visible（唯一非 visible 的是 nav 自己的 `overflow-y-auto`）⇒
  **这不是 overflow 问题，是高度问题**。修法一行：包含块 `<aside className="hidden xl:block"` → 加 **`xl:grow`**，
  让它吃掉 rail 的剩余高度。
  - **真浏览器验收 14/14**（`data/verify/toc/sticky.mjs`）：滚过首屏后在 7 个滚动位置（15%/30%/50%/70%/85%/97%）目录一律贴住
    视口 **72px**（= `--spacing-header` 56 + 16，与 `focus.css` 的 `scroll-margin-top` 同源）；滚到底仍**完整可见**；
    视口矮到 420px 时目录自身限高可滚（h=332 ≤ 视口）；1280px 以下仍回落成正文上方的折叠块（既有降级路径）。
    高亮**双向**跟随：用真滚轮逐帧滚 ⇒ `三条最常踩的坑 → 列表 → 引用与分隔线`，往回滚回到 `行内速查表`。
  - **两条量取教训（本批踩到，值得记）**：① **不能用 `scrollTop = y` 瞬时大跳来验高亮**——hook 用 `IntersectionObserver`，
    它只在"进入/离开判定带"的**过渡**上报；一次跳 3000px 时某标题可能上一帧还在判定带下方、下一帧已在带上方，
    中间没有任何采样点 ⇒ 浏览器根本不产生过渡 ⇒ 回调不触发。第一版脚本因此报了三处**假红**（看起来"高亮卡死"），
    真滚轮一测就是好的；步长还必须**明显小于判定带高度**（带高 ≈ 视口 − 80 − 65% ≈ 235px，改用 150px 步长）。
    ② 目录 `href` 里的锚点是 **URL 编码**的，与 DOM 的 `id` 直接比较会出现"看起来完全一样却判不等"的假红 ⇒ 比较前必须
    `decodeURIComponent`。
  - **守卫**：`packages/web/test/readingLayout.test.ts` 新增 1 例——sidebar 的 `<aside>` 必须 `grow`（含"包含块为什么必须撑高"
    的注释，防下一个人把 `grow` 当装饰删掉）+ nav 的四个 sticky 前提（sticky / `top` 用 `--spacing-header` / 自身限高 / 自身可滚）。
  - **读数**：`pnpm test` **1844/1844**（24 个测试包，0 fail；`packages/web` **761**）、`pnpm -r typecheck` **27 Done / 0 error TS**。
- **插件依赖图大改：管理面合并 + 可读性 + 真·临时停用（2026-09-15）**：用户提了四件事——
  「依赖图线交织看不清」「插件管理与依赖图合二为一，点节点在弹窗里看详情改参数」「临时启用/临时停用要有两个颜色」
  「悬停节点高亮一整条依赖链，只向前不向后」。逐条落地与证据：
  - **① 线不再交织**：交叉的来源不是分层（那早就做了"被依赖方在左"），而是**层内顺序**——原先直接沿用注册表顺序。
    新增纯函数层 `packages/web/src/lib/pluginGraphPlan.ts`：**重心法（barycenter）排序 + 贪心相邻交换**，
    目标函数取**可见交叉对数**（横向区间不重叠的边对不计）。真实注册表（26 节点 / 47 边 / 4 列）实测：
    **注册表顺序 151 对 → 重心法 105 → 加强精修 77**（单独用精修是 80，两步互补）。之所以强调"可见"：
    第一版用"全部边对"当目标，怎么调都是 181——那几十对是判据噪声（横向根本不相交、肉眼永远看不到）。
  - **② 合二为一**：删掉插件表格与「插件管理」导航项，**图即管理台**——点任一节点弹出详情/配置弹窗
    （技术详情、依赖、迁移目录、SchemaForm / JSON 原文、保存、测试连接、启用/停用/重试一个不少）。
    `pages/AdminPage.tsx` 已 `git mv` 为 `pages/GraphPage.tsx`（画布抽到 `components/PluginGraph.tsx`，
    @xyflow/react 仍留在懒加载 chunk 里，不进主包）；旧链接 `#/plugins` 在**路由解析处**改写成 `#/graph`（书签不失效）。
    用户可见文案随之改口（如附件上传提示"请在「依赖图」页改用内置编辑器"）。
  - **③ 两个新颜色**：`tokens.css` 新增 `--gw-session`（青，**临时启用**=会话层）与 `--gw-suspended`
    （紫，**临时停用**），各自 bg/line/ink 三件套 + 深色态 + `@theme` 注册 + 4b 契约块（插件可用）。
    分档函数 `pluginToneOf`（优先级：临时停用 > 异常 > 运行中按层分），文案与"重启后还在不在"的说明收在
    `TONE_TEXT` / `TONE_HINT` 一份，图例/节点徽章/弹窗三处共用（不再有三种叫法）。
  - **④ 悬停只向前高亮**：`upstreamClosure` 只沿"我依赖谁"的方向（图上向左）传递，**下游一律不亮**
    （那是"停用它会影响谁"，另一个问题）；链外节点与边降到 40%，链上的边加粗；画布右上角给一句方向说明。
    真浏览器判据（`data/verify/plugins-ui/graph.mjs`，18/18 PASS）：悬停 `@geewiki/auth` ⇒ 链 3 个节点全亮、
    **下游 `@geewiki/org` / `@geewiki/oidc` 的不透明度 = 0.4**、暗掉的正是链外那 23 个。
  - **真·临时停用（后端能力，不是只上色）**：此前 `disable()` 对基础层插件直接 409 `base_layer`，
    界面上那句"先临时停用或改清单"是一句**做不到**的提示。现在基础层插件可就地停用：**只登记在内存**
    （`GeeWikiManager` 的 `runtimeDisabled`），**不写任何清单** ⇒ **重启后照基础清单恢复**
    （用户口径："立即停止，若没有另行持久化，重启后仍启用"）。三条不变量：不落盘；**激活即清登记**
    （清除点放在 `activateCore` 成功处，boot/enable/拉依赖/替换全自动覆盖）；**持久化即删除**
    （`persistSession()` 先把条目从基础清单移除、成功后才清登记，顺序反了会留下"标记没了、清单也没改"的假持久化）。
    重新启用走**恢复**路径（按 base 层激活、不写会话条目——否则成"两层同名条目"叠加态并显示成"临时启用"）。
    证据：`packages/manager/test/runtime-disable.test.ts` **7 例**；`scripts/acceptance/plugin-runtime-disable/run.ts`
    **11/11** 真进程验收（含"两个清单文件逐字节未变"与"真重启后恢复"）。
    该验收脚本第一版**假绿**：`pnpm` 只是包装，`kill(pnpm)` 杀不掉真正监听端口的孙进程 ⇒ "重启"成了"同一进程继续服务"
    （表现为重启后仍报 `runtimeDisabled=true`，看着像后端不落盘失效）。修法：`detached: true` + 杀**进程组**，
    并在停服后反空洞确认端口真的不再响应。
  - **悬停高亮的返工（同批，用户实测反馈"高亮没有用 + 鼠标在节点内移动不断闪烁"）**：两个症状**同源**——
    节点标签上挂的原生 `title` tooltip 会弹出在光标附近，抢走 `mouseout` ⇒ 悬停态丢失 ⇒ tooltip 收起 ⇒ 再次弹出，
    自激成"一动就闪"，高亮也跟着丢。**去掉原生 `title`**，包名全称改由悬停时的提示面板 + 详情弹窗承载（都在远离光标处）。
    注意：这件事 **headless 量不到**——headless 不渲染原生 tooltip，所以当时那套 CDP 判据一路全绿而用户一用就坏；
    因此补了**源码守卫** `packages/web/test/pluginGraphHover.test.ts`（6 例：节点内不得出现 `title=`、链内必须有强调环、
    `DIM_OPACITY ≤ 0.35`、离开必须有防抖、面板必须给全名与"不含依赖它的"、上游为空时必须说实话）。
    同批三处改进：① **正强调**——链内节点加 `ring-2 ring-accent/70` + 抬投影、链上边加粗到 3.5px 上强调色（原先只有
    "把别人压暗"，用户根本看不见"我被高亮了"）；② 压暗 0.4 → **0.28**（边 0.22）；③ 去掉 26 个节点**同时过渡**的
    动画（移动鼠标时每次悬停切换都让全图重放 150ms 过渡，是"闪"的第二个来源），并给离开加 **80ms 防抖**作为第二道防线。
    另外量到一件真事：`SQLite 数据库` 这类**上游为空**的节点，悬停后暗掉 25/25 个、链里只有它自己 ⇒ 看起来像"什么都没高亮"；
    现在提示面板会明说"不依赖任何插件——它是依赖链的起点"，且它自己也带强调环。
  - **连线逻辑改进：传递归约（同批，用户要求"前置依赖已经依赖了重复的依赖，当前节点就不要再连这条线"）**：
    新增 `transitiveReduction(ids, edges)`（`packages/web/src/lib/pluginGraphPlan.ts`）——**绕开边自身**看端点是否
    还能由长度 ≥2 的路径到达，能则这条线是重复的，不画。真实注册表实测：**接口 47 条 → 画线 33 条**（少 14 条），
    而**可见交叉从 77 直降到 16**（原注册表顺序 151）——被删掉的正是那些横穿全图的"长线"，它们本来就是交叉的主要来源。
    四条边界：① **只影响画线**，详情弹窗里的"它依赖"仍列全部直接依赖（那是契约数据，不是观感）；
    ② 路径长度必须 ≥2，否则两条平行边会互相判成冗余而全消失；③ 含环安全（纯环无冗余边，逐边判据不死循环）；
    ④ **删掉的是"当前"的重复线**——上游一旦被停用，这条直达线自己就回来了（归约按实时拓扑重算）。
    单测 4 例（含"可达性逐点完全不变"这条最硬的判据与平行边/环的边界）；浏览器判据在脚本里**独立算一遍归约**，
    而不是"只要比接口少就算过"（后者对"少画了不该少的线"毫无判别力）。
  - **用户实测返工二：临时停用不进「临时变更」，且停用后启不回来（同批）**：
    ① **卡片空态判据只看了会话层**（`sessionChanges.length === 0`）⇒ 临时停用一个基础层插件后，卡片显示
    "当前没有临时变更"，而下面又列着它（自相矛盾）。修法：空态、标题项数（"临时变更（N 项）"）、
    `canPersist` 三处都把两种临时变更算上；卡片说明按情况补上"临时停用不写任何文件、重启恢复"；
    停用成功的提示按层分流（基础层**不说**"已保存"，它什么都没写）。
    ② **顺带揪出一个真 bug（会把人锁死的那种）**：`@geewiki/org` 这类**不支持热插拔**的插件
    （`hotReloadable=false`，基础层里还有 `auth`/`db-sqlite`/`http`）**没有活跃依赖方**，因此能被临时停用，
    可重新启用时撞上 `hot_reload_not_supported` ⇒ **409，只能重启才能起来**——临时停用成了单向陷阱。
    修法：**恢复路径豁免两条热插拔守卫**（`restoringBase` 判定提前到守卫之前）——它们要防的是"把从未在本进程
    跑过的冷插件热装上来"，而恢复是"回到本进程本来就有的状态"；守卫对真正的新启用仍然生效（单测有反例钉住）。
    ③ 顺带修一处**渲染缺陷**：面向用户的说明字符串里带 markdown 记号（`**正常重启仍会保留**`），
    JSX 不做 markdown 解析 ⇒ 界面上原样显示星号（真浏览器截图里看见的）。
    证据：沙箱实例（复制配置与用户库、端口 3317）走**完整 UI 路径** 17/17——点节点 → 停用 → 卡片列出它（带徽章、
    标题项数、后果说明）→ 再点开启用 → 同一进程内恢复成功、层仍是 base、无会话条目、卡片回到空态；
    新增源码守卫 `pluginTempChanges.test.ts` **6 例**（空态判据必须含两种变更、`canPersist`、提示按层分流、
    用户字符串不得含 `**`）。
  - **读数**：`pnpm test` **1843/1843**（24 个测试包，0 fail；`packages/web` 732 → **750**（本批新增 `pluginGraphPlan.test.ts` **12** 例、
    `pluginGraphHover.test.ts` **6** 例）、`packages/manager` 135 → **142**（新增 `runtime-disable.test.ts` **7** 例））；
    `pnpm -r typecheck` **27 Done / 0 error TS**。真浏览器验收 **22/22**（含"节点上不得有原生 title""链内每个节点都带强调环"
    "链外不得带环""下游被压到 0.28"）。
    文档：`docs/architecture.md` 新增 §5.3b（合并与可读性）与 §5.3 的"真·临时停用"小节，并**修正**了 9.6 里
    "停用必然 409 `base_layer`"的过时结论；`AdminPage.tsx` 的历史行号引用加了合并说明。

- **AI 联网搜索（`@geewiki/ai-web-search`）**：新增**一个内置插件**（`packages/plugin-ai-web-search/`），向 AI 工具总线注册一条**只读**工具 `web_search`（`side: 'server'`，无 `mutating`），让助手能查站外的公开资料——此前它只有 `@geewiki/ai-kb` 那三条站内工具，查不到时**没有别的路**。**优先适配 AnySearch**：默认打 `https://api.anysearch.com` 的 `POST /v1/search`（信封 `{code, message, data}`），且**未配密钥即可用**——AnySearch 支持匿名额度（按来源 IP 计），故密钥（`role: 'secret'`，落 gitignored 的 `config/secrets.json`，入库配置与 HTTP 响应都不留值）**不是启用前提**，配了才把额度提到账号档。
  **"优先适配"落在提供方接口上、不落在工具上**：`src/types.ts` 的 `WebSearchProvider` 把"给模型看什么"（工具层的 JSON 形状、参数校验、依据声明）与"怎么问出去"（AnySearch 的 HTTP 细节、信封、错误分类）切开，加第二家只需新增一个文件 + 一个分支，工具的契约一字不改。未知 `provider` 取值**激活期抛错**——静默回落到默认提供方会让"日志说 AnySearch、配置写着别家"没有任何地方会报错。超时**不重试**（叠一次就是双倍等待并放大配额消耗）、`redirect: 'error'`（跟随重定向等于把密钥发给另一台主机）、上游错误文本**有界 + JSON 引用**（它是外部可控字符串，会进模型上下文）。
  **一条随本包一起定义的契约扩展（`AiToolGrounding` 由 `'kb'` 扩成 `'kb' | 'web'`）**：`@geewiki/ai-tools` 的类型注释当初就写着"刻意不为将来的 `web_search` 预留取值——那时该由那个插件连同它的界面标注一起定义"，本批兑现它。链路从"一个布尔"变成"一份出处清单"：`runAgentLoop` 累加 `LoopOutcome.groundingSources`（本回合声明过的**全部**出处），而 `grounded` **仍只认 `'kb'`**；界面按账分流——**只有**联网依据时渲染新的 `.gw-dock-webgrounded`（"依据的是公开网络资料，请点开来源自行核实"），两档都无才渲染原来的"这不是知识库内容 / 来自模型自身的知识"。**为什么不继续用布尔**：联网答案若落进 `grounded === false`，界面会把它说成"来自模型自身的知识"——**有出处与没出处被混为一谈**，比不打标更误导。不变量 `grounded === groundingSources.includes('kb')` 被验收脚本在两个真实回合上各断言一次。
  **一个只有真调上游才会发现的缺陷（本批修）**：AnySearch 的检索应答**默认就带 `content`**（清洗后的页面正文，一次可能几十万字符）。只靠"给提供方 0 配额"是不够的——那依赖每个提供方都老实照做，而正文一旦漏进模型上下文，代价是**整个上下文窗口**。故工具层对**已拿到的结果**再剥一次（与提供方实现无关），并有单测钉死"上游回了 content 也必须被删掉"。
  **判据与边界**：`grounding: 'web'` **只在真的拿到 ≥1 条结果时声明**——0 命中/超时/上游 5xx/参数不合法一律不声明（跑了却没拿到资料不算依据，与 `search_kb` 0 命中同一条）；工具**不自己判权限**（可见性由工具总线按主体过滤，再写一份就是第二份会漂移的实现）、**不落库**（无迁移、无端点、无状态）；搜索结果是**外部输入**，只剥控制字符与限总量，**不做"像不像注入"的过滤**（那既拦不住改写过的注入，又会静默删掉正文）。
  **读数**（取数 `2026-09-15`，工作树含本批未提交改动）：新增 **1 个包、1 个内置插件、1 条基础层启用**——`pnpm -r` 作用域 **27 个包 / 28 个 project**，内置注册表 **24 个**（`grep -c "source: 'builtin'" packages/server/src/index.ts`），`config/plugins.base.json` **启用 20 条**（`@geewiki/ai-web-search` 紧随 `ai-kb` 之后）；`pnpm test` **1787/1787**（**24** 个测试包，0 fail；新增 `plugin-ai-web-search` **32** 例，`plugin-ai-assistant` 179 → **187** 例——依据分档的新用例）；`pnpm -r typecheck` **27 个 project 全 Done、0 error TS**。客户端插件产物已重建（`pnpm --filter @geewiki/web build:plugin-ui` **以及一次完整的 `pnpm --filter @geewiki/web build`**——`pnpm start` 托管的是 `dist/`，只跑前者时 `public/` 里的新产物**不会**进 `dist/`，表现为"源码改了、浏览器还是旧的"）。
  **真 endpoint 验收**（`node --import tsx scripts/acceptance/web-search/run.ts`：复制 `config/` 与 `data/geewiki.db` 到临时目录起**独立实例**、插一个口令已知的真 `user` 主体、真上游、真 `POST /api/ai/turn`）**PASS**：能力表 `tools=list_pages, read_page, search_kb, web_search`；问「AnySearch 是做什么的」时模型**真的调用了 `web_search`**（工具描述能被选中）、回答里给出可点的来源链接、`done` 帧 `grounded=false` 且 `groundingSources=["web"]`；问「知识库里有哪些页面」时调 `list_pages` 且 `groundingSources=[]`（**地图不算依据**）。
：新增**一个内置插件**（`packages/plugin-builtin-docs/`），把"描述本项目自身"的 5 篇文章（`home` / `guide/architecture` / `guide/features` / `guide/markdown-demo` / `guide/special-structures`）作为**真实 wiki 页面**在首次部署时写入，此后三条规则：**只读**（任何主体，含 owner，都不能编辑/删除/改可见性）、**随版本同步**（正文带版本戳 `DOCS_VERSION=20260916`，与库中戳记不等才刷，相等时零写入）、**可隐藏**（配置 `hidden: true` ⇒ 策略层对所有主体判 `level='none'`，列表/检索/阅读一律视同不存在，页面本体不删）。三条规则的判据**都不在本包、也不在 wiki**，全部收敛在 `@geewiki/authz` 的 `buildAccess`（唯一授权出口）——它每次判定**现取** `builtin-docs-service`（懒取 + 结构化类型，不 import 本包、不写进 requires，缺席⇒无覆盖），对"记账页"强制 `canEdit/canDelete/canManageVisibility=false`，`hidden` 时置 `level='none'`。
  **为何只读判据在策略层而不是 wiki 里加"锁页"**：写路由、AI 写工具（先问 `canEdit`）、前端按钮（读 `capabilities`）、列表与检索（`visibleSlugs`）**全部消费同一个 `buildAccess`**，在此设一条规则即全链生效；在 wiki 写路径再设私有守卫就是第二份判据，必然漂移（与 §2.0 那条分工红线同源）。
  **接管护栏以记账表为权威**：`builtin_docs_state` 里 `page:<slug>` 行存在 ⇔ 这一页是插件建的。**slug 撞名**（用户先建了 `home`）⇒ 跳过并告警、**不记账**，用户的同名页不受锁、不受隐藏、永不被同步改写或删除；只有记账页会被版本同步与孤儿清理。**版本戳只在全部对齐成功后才盖**，中途抛错留旧戳 ⇒ 下次启动整体重试（save/remove 幂等）；同步失败**不阻断服务器启动**（辅助功能，`console.error` 后继续激活）。**建档走 `wiki.save(slug, {visibility:'public', published:true})`、清理走 `wiki.remove()`**——服务层不带授权正是系统写方要的形状，本包绝不 SELECT/INSERT 别人的表。
  **为此扩展了 `wiki-service` 契约**（本批唯一的既有包改动）：① `WikiSaveInput` 增可选 `visibility / published`，**仅创建分支生效、仅跨插件服务路径能传**（HTTP 的 `parseSaveBody` 白名单不含它们 ⇒ 用户改档位仍只有带 `canManageVisibility` 的专用端点一条路；实测 `PUT /api/pages/:slug` 带 `visibility` 仍回 400），缺省仍是 `'org'`（D8 两层默认不动），且创建分支的 `pageLevelOf` self 三元组跟着 input 走（否则块 `tier` 按错误档位算 = 检索与读路径当场漂移）；② `WikiService` 增 `exists(slug)`——**与可见性无关**的存在性探测，是"方法集与端点一一对应"的**第一个例外**（它没有安全端点形态：HTTP 暴露就等于给出 slug 存在性探测；`get()` 对看不见的既有页面回 `undefined`，回答不了"这个 slug 是不是被用户占了"）；**第二个例外是下一条里的 `resyncTiers(slugs)`**（服务的是物化列 `blocks.tier` 的一致性，不是读写语义）。`ai-kb` 的全量 `WikiService` 替身随之补了 `exists` 与 `resyncTiers`。
  **真实冒烟揪出两处真旁路，本批一并修掉**（隔离数据目录 + 注册账号 + break-glass 的实例上逐条实测）：① **`PUT/DELETE /api/pages/:slug` 原本是仅有的两个不问策略层的写端点**——`access:'user'` 只是"不是匿名"的粗闸门（路由注释自己就写着"不区分谁能改哪一条"），任何登录主体（含 owner 与 break-glass）都能改写/删除**任何人**的页面，连只有 O1 够得着的 private 页也照删。这是先于本批存在的产品缺陷，但内置文档的只读依赖它：两条路由补 `requireCap`（判 `canEdit`/`canDelete`，与 `requireManage` 完全同口径——`level==='none'` ⇒ 404 不泄露存在性、看得见但不够格才 403），判据仍只来自 `policy-service` 这一个出口，**不为内置文档另设守卫**；**新建（slug 不存在）不过这道门**，建档权仍是 `access: 'user'` 本身（冒烟实测：owner 建/改/删自己的页照常 200，文档页一律 403）。② **检索命中层读的是物化列 `blocks.tier`**（search 的命中谓词不再求 `visibleSlugs` 交集，见 `plugin-search` 文件内注释）——`hidden` 开关不写库、只改判据，没人触发重算就会"读路径收紧、检索仍命中"，正是 §9 R13 警告的泄漏级漂移。修法三处：`@geewiki/authz` 的 `effectiveIndexLevel` 现问同一份覆盖（hidden ⇒ `null` ⇒ 块 tier 写 NULL）；`WikiService` 契约加**第二个端点配对例外 `resyncTiers(slugs)`**（第一个是 `exists`；为什么不复用 admin 端点 `POST /api/admin/blocks/resync`——它是 `access:'admin'`，系统写方没有也不该有 admin 主体）；`@geewiki/builtin-docs` 每次激活重同步记账页——**刻意排进 `setImmediate` 而不是 apply 里直刷**：cordis 把 fiber 的 `provide` 提交在 apply 返回之后，apply 期间 authz 的懒取拿到 undefined ⇒ 覆盖静默缺席 ⇒ tier 按"无覆盖"刷回去，白刷且无任何错误可查（夹具的 provide 是同步 Map、结构上测不出这个时序；真实实例上以"隐藏后搜索仍命中"暴露）。修复后闭环实测：`hidden` 双向翻动 ⇒ 检索 hits `[] ↔ ['guide/architecture','home']` 即时跟上。
  **正文即 Markdown 文件，且写成了可当参考用的对照页**（同日返工，`DOCS_VERSION` 20260915 → **20260916**）：① **正文从 TS 模板字符串搬进 `packages/plugin-builtin-docs/content/<slug>.md`**（slug 里的 `/` 就是子目录：`content/guide/markdown-demo.md`），`src/catalog.ts` 退化成只登记 slug/标题/顺序的装载器，目录解析与 `migrations` 同款（相对本文件取 `../content`）。动机是实测踩出来的：对照页里**反引号、`\|`、`${}` 密集出现**，写在模板字符串里每处都要转义，抄错一个反引号就是构建失败；真实文件还能让 diff 只显示改了哪一句。② `guide/markdown-demo` 从 1268 字符重写为 **6972 字符**的《Markdown 语法参考》——每一节都是**源码 ↔ 效果**（行内速查表 / 标题与锚点 / 段落换行 / 列表 / 表格 / 代码 / 引用与分隔线 / 链接五种写法 / 图片与附件 / 内联 HTML 白名单 / 不支持清单 / 完整页面骨架），并补上原先写错的"站内图片没有可靠托管语法"（实际支持：上传附件 ⇒ `![名](/api/attachments/<id>)`，权限跟页面走、无权限显示占位 + 申请入口）。**对照里的每条都先用真 `marked`（gfm+breaks）与真 `parseBlocks` 跑过**再写进文档：`---` 紧贴文字会变 Setext 二级标题、表格里裸 `|` 会撕列（行内代码里也要写 `\|`）、4 反引号可包住 3 反引号来演示围栏、缩进代码块要 4 空格、DOMPurify 默认白名单里确有 `kbd/sub/sup/mark/abbr/details/summary` 而 `script`/`iframe` 不在——都验证过。
  **卸载补刷 tier**：`hidden` 期间刷出来的 `tier = NULL` 会留在块上，卸载后判据虽已撤，页面却"能读、搜不到"。卸载路径也排一次 `resyncTiers`（静默，wiki 可能已先卸载），新增 1 例回归测试（`plugin-builtin-docs` 13 → **14** 例）。
  **读数**（取数 `2026-09-15`，工作树含本批未提交改动）：新增 **1 个包、1 个内置插件、1 条基础层启用**——`pnpm -r` 作用域 **26 个包 / 27 个 project**，内置注册表 **23 个**（`grep -c "source: 'builtin'" packages/server/src/index.ts` = **23**），`config/plugins.base.json` **启用 19 条**（`@geewiki/builtin-docs` 紧随 `wiki` 之后）；`pnpm test` **1747/1747**（23 个测试包，0 fail；新增 `plugin-builtin-docs` 14 例、`plugin-wiki` 的 `managed-save.test.ts` 7 例）；`pnpm -r typecheck` **26 个 project 全 Done、0 error TS**。行为测试沿用 `slug-hierarchy` 夹具（`node:sqlite` 真迁移 + **真 authz + 真 wiki**，只替 http）——只读/隐藏/接管/同步/卸载五条**都靠真策略层跑出来**，`@geewiki/authz` 自身无行为测试基建，本批的实现恰好被这副夹具真覆盖。**唯一逃生门是卸载内置文档插件**（判据随 `unprovide` 整体消失 ⇒ 文档页变回普通可编辑页，重装后按戳续同步）；隐藏 ≠ 卸载（隐藏只是判据，数据不动）。

- **已完成（Phase 0-2）**：pnpm monorepo 共 **25 个包**（`ls -d packages/*/`；另有工作区项目 `plugins/hello-geewiki`，故 `pnpm -r` 的作用域是 **26 个** project。**旧读数「13 个包 / 14 个 project」是 AI 插件化重构之前的口径**，P0–P8 期间新增了 `plugin-ai-tools` / `ai-journal` / `ai-kb` / `ai-summary` / `ai-pages` / `ai-assistant` / `ai-nav` / `ai-admin` 等，并在 P8 删掉了 `plugin-ai-qa`）；`pnpm dev` 一条命令同时启动后端 http://127.0.0.1:3000 与前端开发服务器 http://localhost:5173（生产形态 `pnpm build` 后用 `pnpm start`，由后端静态托管前端产物）；**22 个内置插件已由代码内注册表静态登记**（P8 读数，`grep -c "source: 'builtin'" packages/server/src/index.ts` = **22**；旧读数 17 个是 AI 插件化重构之前的口径）（`defaultRegistry()`：`@geewiki/db-sqlite`、**`@geewiki/postgres`**、`@geewiki/http`、`@geewiki/echo`、**`@geewiki/editor-plain`**、`@geewiki/auth`、`@geewiki/org`、`@geewiki/authz`、`@geewiki/oidc`、`@geewiki/llm`、`@geewiki/search`、`@geewiki/wiki`、**`@geewiki/ai-writing`**、**`@geewiki/ai-qa`**、**`@geewiki/openai`**、**`@geewiki/ai-tools`**、**`@geewiki/ai-kb`**；其中默认基础层清单 `config/plugins.base.json` **共启用 18 条**——除既有的 `db-sqlite` / `http` / `auth` / `org` / `authz` / `wiki` / `search` 外，还有 **AI 六件套 `@geewiki/llm` / `@geewiki/openai` / `@geewiki/ai-tools` / `@geewiki/ai-kb` / `@geewiki/ai-writing` / `@geewiki/ai-qa`**（后两者是 P1 新增的**工具总线**与**知识库工具**）（四件套出厂即启用不会误导用户：没有密钥时模型侧**明确报不可用**，而不是假装能用；完整清单以该文件为准），`postgres` / `echo` / `editor-plain` 等仍属**已注册未启用**；**P1 批复测**（真实出厂配置 + 隔离数据目录起实例；该次传 `pluginsDir: null`，故**不含外部插件**，`GET /api/plugins`）返回 **17 条内置**（上一读数为 15 条内置 + 2 条外部 = 17 条，外部那两条为 `plugins/` 下的 `@geewiki-plugin/hello`、`@geewiki-plugin/ui-demo`，均 `inactive`），`issues` 为空，其中 `state:'active'` 恰为 **13 条**（基础层 13 条全部生效），`inactive` 四条：`@geewiki/echo` / `@geewiki/editor-plain` / `@geewiki/oidc` / `@geewiki/postgres`；同一实例 `GET /api/plugins/ui` 的 `plugins` **只有两个键**：`@geewiki/ai-writing: ["editor-toolbar"]` 与 `@geewiki/ai-qa: ["wiki-ask"]`（"界面由插件贡献"这条链路的实际入口表内容；**P1 新增的两个插件既不贡献插槽、也没有前端产物，故入口表一个键都没多**——工具总线是纯服务端注册表）。**旧读数 12 条 = 10 内置 + 2 外部已被本批与相邻批次（auth/org/authz/oidc/editor-plain 入库）取代**）；Web 管理台含 `#/wiki`、`#/graph` 两个主路由（**`#/plugins` 已于"插件依赖图合并批"并入 `#/graph`**，老链接在路由解析处改写，书签仍可用；该批之前是 `#/wiki`、`#/plugins`、`#/graph` 三个）；wiki 下的 hash 子路由共 **6 态**（`packages/web/src/lib/wikiRoute.ts` 的 `WikiRoute`）：`#/wiki`（**主页文章**，约定 slug `home`）、`#/wiki/list`（列表）、`#/wiki/new`、`#/wiki/<slug>`（详情，支持分层 slug）、`#/wiki/<slug>/edit`、`#/wiki/search/<q>`（宿主原生检索 UI）。**`#/wiki/ask/<q>` 已在 P8 拆除**（决策 17：对话的唯一入口是常驻的 `app-dock`），故是 6 态而非原来的 7 态；`'ask'` 仍留在 `WIKI_RESERVED_FIRST_SEGMENTS` 里（解禁是单向不可回收的，理由见 `lib/wikiRoute.ts` 的 JSDoc），另有 `⌘K` / `/` 唤起的**命令面板**（`packages/web/src/components/CommandPalette.tsx`）与**侧边栏页树**（`components/Sidebar.tsx`）；**单元测试全绿，一次实跑读数**（命令 `pnpm -r --no-bail --if-present run test`，逐包逐文件明细见下表 `pnpm test` 行）：**1715/1715，22 个包，0 fail**（**P8 读数，取数 `2026-09-15`，工作树含未提交改动**；旧读数 1478/1478 是 AI 插件化重构中途的口径，已被 P6 的 1817 与本次的 1715 相继取代——**数字下降不是倒退**：P8 删掉了 `@geewiki/ai-qa` 整包 **101 例**与两条已失效的样式守卫，只新增 `isUnreachableSlug` 一条），命令与逐包明细见下表 `pnpm test` 行；被本批取代的历史读数依次为 746/746（9 个包）、1274/1274、1276/1276（13 个包）——数量上升是因为本批把 AI 拆成两个插件并补了守卫测试，同时删掉了宿主侧的 AI 界面测试 36 条）。`pnpm typecheck`：**25 个 workspace project 全部 `Done`、0 个 `error TS`**（Exit 0；**P8 读数，取数 `2026-09-15`**；旧读数 20 个 project 是 AI 插件化重构中途的口径；作用域 `Scope: 25 of 26 workspace projects`，`plugins/hello-geewiki` 无该脚本被 `--if-present` 跳过；`@geewiki/web` 那条现在串了两个 tsc——`tsc --noEmit && tsc --noEmit -p tsconfig.plugin-ui.json`，第二个专门覆盖插件 `ui/` 目录里的界面源码）。**两条必须记档的瞬态现象（都不是已提交代码的缺陷，是"读工作树"在并行写入期遇到的中间态）**：① `2026-09-11T20:14:53` 首次跑 `pnpm test` 时**整体失败**——`[ERR_PNPM_RECURSIVE_FAIL]` / `Summary: 1 fails, 8 passes` / `packages/web: [ERROR] @geewiki/web@0.1.0 test: node --import tsx --test test/*.test.ts Exit status 1`；**紧接着单独复跑 `packages/web` 即 314/314 全绿**，原因是并行批次当时正在写 `test/editorPaneRegions.test.ts`，故报告读数时**须同时给出 HEAD 与取数时刻**。② 更早一轮（`00:29`，HEAD `3bdcf4b`）同一命令曾因当时新建的 `packages/plugin-openai` 的 `tsconfig.json` 声明了 `include: ["src","test"]` 而 `test/` 尚未创建，报 `error TS18003: No inputs were found in config file '/root/dev/geewiki/packages/plugin-openai/tsconfig.json'. Specified 'include' paths were '["src","test"]' and 'exclude' paths were '[]'.` 并整体失败；该错误随该目录补齐而自行消失。卸载统一出口已消费 `runtime.drainTimeout`（优雅排空在途 HTTP 请求，超时强制卸载）并在 `requiresCachePurge` 时广播缓存清理事件；**SSE 长连接出口已与排空共存，且真实流式输出已接线**（`packages/server/src/index.ts`：`HttpRouter.trackStream(res, owner)` 登记的长连接**按 owner 分组**、`activeStreams` 不计入在途、`closeStreams(owner?)` 在卸载时定向回收、`noteStatus()` 只记指标不结束响应、teardown 走 `unprovide()` → `closeStreams()` → `await drain()` → `server.closeIdleConnections?.()` → `server.close()` 五步；提交 `2273006`）。
- **插件平台已落地（Phase 3 的既有四条链路）**：
  - **配置系统（schema 驱动）**：manifest 的 `geewiki.configSchema` 采用 [schemastery](https://github.com/shigma/schemastery) 3.18.0；`GET` / `PUT /api/plugins/:name/config` 提供读写，服务端做校验 + 白名单裁剪 + **原子落盘**（先写 `<文件>.tmp` 再 `rename`）；已激活插件经 `fork.update()` 热更新，失败时把进程内配置与磁盘清单**双向回滚**并返回 409。管理台按 schema 自动生成表单（开关 / 数字 / 文本 / 多行 / 枚举 / 字段组 / 列表；`meta.role: 'password'` 渲染为密码输入框），**未声明 schema 的插件退回 JSON 原文编辑框**（不校验、不裁剪）。
  - **外部插件加载**：启动时扫描 `./plugins/<name>/`（`GEEWIKI_PLUGINS_DIR` 可覆盖），清单取子目录 `package.json` 的 `geewiki` 键（优先）或独立 `geewiki.manifest.json`，与内置插件**并入同一注册表、完全同权**；单个插件的清单缺失 / 入口缺失 / 路径越界 / 重名 / 加载抛错都只记一条 issue 并跳过，不阻断宿主启动；发现期问题经 `GET /api/plugins` 的 `issues` 字段对外可见（`{code,dir,message}`，`code` 为八值枚举）。零依赖示例见 `plugins/hello-geewiki/`。
  - **冲突组替换（顶替交互）**：同 `conflictGroup` 的插件除互斥拦截外，可经 `POST /api/plugins/:name/replace` 顶替：先卸载组内已激活的旧插件（连同它当前活跃的传递依赖方），再热激活目标插件，并把依赖方接回新提供者（`skipDeps` 阻止旧插件被当依赖重新拉起）。**前置校验在三类情形下直接拒绝**（均在产生任何副作用之前，故拒绝路径零残留）：① 旧插件（将被顶替者）的**真实激活层**不是 session → 409 `base_layer`（判据是 `managed.layer`，不是 `layerOf()`；同名条目同时在两层清单的叠加态下它以 base 层激活，属冷操作）；② **卸载集合内任一成员**（旧插件 ∪ 其活跃传递依赖方）的真实激活层不是 session → 409 `base_layer`，响应 `details.plugins` 列出基础层成员（活跃的基础层插件不可热卸载，否则接回时会把它在会话层重新落盘、静默改写其持久化层）；③ 被顶替者自身或任一待接回的依赖方，其 `requires` 里的 token 经 `resolveDependency` 解析后指向被顶替者，而目标无法承接（目标的插件名或 `provides` 均不命中）→ 409 `provider_mismatch`（响应 `details` 带 `plugin` / `token` / `target` / `targetProvides` / `violations`）；目标自身依赖它要顶替的插件同样被拒（`details.tokens`，不自洽）。**对外影响**：依赖方**按具体插件名**依赖被顶替者时替换必然被 409 拒绝——按名的边无法由新插件承接，正解是依赖方改为依赖**服务标识**（`provides` token）；这是刻意取舍（宁可 409，也不返回 200 却留下无人提供的服务）。失败会回滚旧插件与依赖方，并**按调用前的条目顺序与原内容复原会话清单**（文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行，故人工编辑过的非规范格式不会被逐字节保留）；回滚也失败时返回 500 `replace_rollback_failed`（该路径下整个卸载集合的会话条目都已消失、内存与磁盘一致，需人工介入；仅代码路径 + 人工推演，**无单测覆盖**）。管理台在启用撞上冲突时弹出顶替确认框（列出被顶替者与**当前活跃的**依赖方，并预告"被卸载插件会短暂不可用约几秒"），用户确认后走该端点；若响应 `replaced: null`（无冲突降级）则提示"冲突已解除，已直接启用（未发生替换）"。
  - **前端 Slot（宿主侧插槽 + 后端下发入口表）**：宿主经 `window.__GEEWIKI_HOST__` 暴露 React 单例与 `registerSlot` / `unregisterSlot`，插件 UI bundle 从 `/plugins-ui/<插件名>/<入口文件名>`（默认 `client.js`）动态加载并注册组件；插槽名是白名单，当前共 **6 个**（`packages/core/src/index.ts` 的 `SLOT_NAMES`：`app-header` / `app-footer` / `editor` / `editor-toolbar` / `app-dock` / `article-summary`）——`app-header` / `app-footer` 是**零属性（不传任何数据）的 multi 插槽**，`editor` / **`app-dock`** / **`article-summary`** 是**带数据的 single（单占用）插槽**，`editor-toolbar` 是带数据的 multi 插槽。**P8 把 `wiki-ask` 拆掉了**（决策 17），白名单因此 **7 → 6**（旧的「共 3 个」与「共 6 个」分别是更早两批的口径，都不含 `article-summary`）（props 见 `EditorSlotProps`：`value` / `mode: 'create'|'edit'` / `slug` / `readOnly?` / `onChange` / `onSave` / `onCancel`，是**宿主唯一向插件传数据的通道**；基数表见同文件 `SLOT_CARDINALITY`：两个 app-* 为 `multi`、`editor` 为 `single`，冲突时由宿主确定性裁决并在 `GET /api/plugins/slots` 的 `suppressed` / `conflicts` 里可见）；未知插槽名告警并忽略，插槽外层包 ErrorBoundary——插件组件抛错只丢该插槽，主界面不白屏。**后端侧插槽注册链路也已落地**：插件可经 `ctx.get('slot')`（服务名 `'slot'`，实现类 `SlotRegistry` 在 `packages/manager/src/slots.ts:157`）拿到 `SlotService` 做运行期 `contribute(owner, slot, meta?)`（返回幂等注销函数）/ `ownersOf(slot)` / `list` / `release`，或直接在清单里写 `slots: ['editor']` 做**声明式**贡献（激活时自动登记，`@geewiki/editor-plain` 即此形态）。**哪些插件的 UI 该加载由后端下发**：插件在清单里声明 `geewiki.client`（`{ entry?, css? }`，均为**单段文件名**，`entry` 缺省 `client.js`；**未声明 `client` 的插件永不进入口表**——注意它与**后端**入口 `geewiki.entry` 不是一回事）。宿主读 `GET /api/plugins/ui`（每请求由"注册表 × 激活集合 × 产物 stat"现算，只列 active ∩ 声明 `client` ∩ 入口实际存在者，条目形状为 `{ entry, css?, rev, slots }`（`slots` 是该插件声明的插槽名数组），`skipped` 记 `inactive` / `no_client` / `entry_missing` / `invalid_name`；带 `no-store` + `ETag`，`If-None-Match` 命中即 **304**，空表仍 200）；前端按整表 `revision` 与逐插件 `rev` 的差集**先卸后装**，并由管理台动作（即时）+ `visibilitychange` + 15s 可见期轮询自动收敛——**UI 随插件启停自动出现/消失**（外部变更 ≤15s）。资产按**双根**解析：`<插件目录>/dist` 优先、`<GEEWIKI_PLUGIN_UI_DIST>/plugins-ui/<名>` 兜底（该变量**缺省 = `GEEWIKI_WEB_DIST`**，故既有部署行为不变）。**静态资产已支持子目录**：`/plugins-ui/<插件名>/<相对路径>` 走独立分支，相对路径由 `PLUGIN_UI_ASSET_PATH`（`packages/core/src/index.ts:411`）校验——逐段 `[A-Za-z0-9][A-Za-z0-9._-]*`、**≤ `PLUGIN_UI_ASSET_MAX_DEPTH` = 16 段**，`..` / `.env` / 空段 / 绝对路径 / 反斜杠 / 尾随斜杠 / 任何 `%` 编码一律非法（**因此不解码也不存在 `%2e%2e` 这类陷阱**）；服务端另做**四层包含防护**（按段还原插件名再查根表 → 路径段形态 → 词法 `relative()` 包含（刻意不用 `startsWith`）→ `realpath` 后再比一次挡软链逃逸），并**绝不回退 `index.html`**（缺失即 404 JSON，否则会被 SPA fallback 掩盖成 200 `text/html`），MIME 按扩展名分级、带内容指纹的资产长缓存 + `immutable`、无指纹的 `no-cache`、`ETag` 支持 304。**边界见下方"已知限制"。**
- **检索与问答已落地（本阶段新增的 AI 原生能力）**：
  - **全文检索 `@geewiki/search`**（`packages/plugin-search/`，提交 `e6ddfbd`）：`provides: 'search-service'`、`requires: ['database-provider','http-service']`、**不进任何冲突组**、自带迁移 `migrations/0001_search.sql`（FTS5 external content 表 `pages_fts` + 三条同步触发器 + `rebuild` 回填；由管理器的迁移控制器在激活前执行，`migrationsDir = SEARCH_MIGRATIONS_DIR`）。**默认部署即启用**（`config/plugins.base.json` 第 4 条）——纯只读增强、不需要任何凭据。端点 `GET /api/search?q=&limit=&mode=` → `{ok, query, mode:'fts'|'like', queryMode:'phrase'|'terms', total, hits:[{slug,title,snippet,score,updated_at}]}`；**空查询 → 400 `invalid_query`、非法 `limit` → 400 `invalid_limit`**（`limit` 须为 1..100 的整数）、**非法 `mode` → 400 `invalid_mode`**；**`total` 是全量命中数，不受 `limit` 限制**（用 `COUNT(DISTINCT p.id)` 统计，同一行被多个词元命中只计一次）；响应里有两个方向不同的字段——**`mode`** 回传**实际走的那条路径**（`'fts'` / `'like'`，观测用）、**`queryMode`** 回传**本次请求的查询语义**（`'phrase'` 整串字面短语 / `'terms'` 词元 OR，`mode` 参数缺省 `'phrase'`）；`snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`，前端**不得二次转义**）；`score` 是**取负后的 BM25**（越大越相关，**不是归一化**，值域无界，**仅同一次查询内可比**，LIKE 路恒为 0）。
  - **✅ 已知并已修复：整串按 FTS5 短语匹配，自然语言问句需按词元检索（修复已落地，提交 `04c45c3`）**。`mode` 缺省为 `'phrase'`——把**整串**当作一个 FTS5 字面短语，这正是搜索框语义（搜什么就要求正文里连续出现什么）；但**自然语言问句**（如「检索增强怎么做」）几乎不可能逐字连续出现在正文里，按短语匹配**恒为 0 命中**，问答的检索地基等于不可用。**修复方案**：新增 `mode: 'terms'`——把查询切成**词元**后以 **OR** 连接（CJK 连续片段取 **3-gram 滑窗**、ASCII 按空白与标点切词且只保留 **≥3 字符**者；每个词元**仍各自加引号当字面量**，注入防护的实现只有一处），并让 `@geewiki/ai`（**现为 `@geewiki/ai-qa`**）的问答**一律走 `terms`**；`terms` 切不出词元时（<3 字符、纯标点）**回退 LIKE**，不构造空 `MATCH`。**状态：该修复已落地并提交**（`04c45c3`）——`packages/plugin-search/src/index.ts` 新增 `mode: 'terms'`（词元 OR 切分 + 字面量引号，注入防护仍只有一处），`packages/plugin-ai-qa/src/index.ts:431` 的问答改为 `search.search(principal, query, { limit, mode: 'terms' })`（**本批起首参必须是主体**，见下方权限红线）。**注意 `mode=terms` 未接入 Web UI**（`packages/web/src/api.ts:465-469` 的 `search()` 只传 `q` 与 `limit`，搜索框保持短语语义 `phrase`，`queryMode` 已随响应下发备用）——**本批实测**：对同一问句「检索增强怎么做」，`GET /api/search?q=…`（缺省）返回 `{"mode":"fts","queryMode":"phrase","total":0}`，加 `&mode=terms` 才返回 `{"mode":"fts","queryMode":"terms","total":1}`；已知代价是 terms 召回更宽、精确率天然低于短语检索，建议纳入后续检索质量评估。**本批复测**：`plugin-search` **42**、`plugin-ai-qa` **122**、`plugin-ai-writing` **52**（旧读数里的 `plugin-ai` 包已拆分为后两者，其"65"与"84"两个历史值一并作废）。
  - **FTS5 与中文检索的关键事实（本仓最易被误传的一点，均已在 `better-sqlite3@13.0.3` 上实测复验）**：① `better-sqlite3` 的**预编译包已含 FTS5**（`compile_options` 含 `ENABLE_FTS5`，内置 SQLite **3.53.4**，`tokenize='trigram'` 可直接建表 ⇒ **无需 node-gyp**）；② FTS5 默认的 `unicode61` 分词器把**连续 CJK 当成一个 token** ⇒ `MATCH '"知识库"'` **0 命中**，中文等于搜不到；③ 故**必须显式 `tokenize='trigram'`**（中文 ≥3 字子串可命中；`MATCH '"全文检索"'` 命中，`'"知识库"'` 命中）；④ **trigram 的硬缺口**：查询串 **<3 字符**时 `MATCH` 恒为空（中文 2 字词如「检索」、英文 2 字母都是空结果）⇒ 插件层用 **LIKE 兜底**，且该路径**直接扫 `pages` 真源表而非索引**，故索引缺失/漂移时短查询仍给出正确结果；⑤ 索引体积与正文**同量级**（自测：5000 行、正文合计 6.23 MB → 索引使库文件增长 7.07 MB，约 **1.14×** 正文；`migrations/0001_search.sql` 记录的仓库内实测为 6.6 MB 语料 +7.9 MB）。
  - **LLM 服务契约层 `@geewiki/llm`**（`packages/plugin-llm/`，同批提交 `e6ddfbd`）：`provides: 'llm-service'`、**不进任何 conflictGroup**（它是 route→provider 注册表，互斥应由各 adapter 自己声明）。**本批起已含第一个真实厂商 adapter**（`@geewiki/openai`，OpenAI 兼容端点；它只往注册表注册路由、不 `provides`），故"有没有可用 provider"取决于**是否备好凭据**（适配器默认已启用）——**实测**：默认部署下 `GET /api/ai/capabilities` 返回 `{"available":false,"degraded":true,"providers":[{"route":"null",…},{"route":"openai",…}]}`，两条路由均 `available:false` ⇒ 问答与辅助写作**明确不可用**（`503`），不再有「降级但看起来像答案」的第三条路。契约要点：**稳定错误码枚举**（`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` / `TIMEOUT` / `NETWORK` / `PROVIDER_ERROR` / `ABORTED`）；调用方**按 code 分支、绝不按 message 文本分支**（`error` chunk 在**结构上就没有 message 字段**）；**终止 chunk 恰一次且在末位**由包装器保证（消费方可无判空 `for await`）；**服务本身绝不重试**。**密钥安全（本批口径）**：统一配置里的 `apiKey` 是 **`role: 'secret'` 写一次字段**——值由管理器单独落盘到 **gitignored 的 `config/secrets.json`（0600）**、**绝不写进 `config/plugins.*.json`**，且任何 HTTP 响应都不回显（`GET /config` 只回 `secrets: { apiKey: true }`；落盘前由 `Manager.absorbSecrets` 摘掉、只在交给插件的那一刻注水，见 `packages/manager/src/secrets.ts`）；**环境变量仍是可选兜底**（`apiKeyEnv`，界面填写的密钥优先），白名单闸门 `isEnvVarName`（全大写 + 至少一个下划线，`packages/plugin-llm/src/credentials.ts:57`）与 schema `.pattern(ENV_VAR_NAME_FIELD_RE)` 继续堵死"把密钥值填进变量名字段"这条路；配套 `redact`（日志/响应脱敏）。**本批同时修掉一个实测缺陷**：`fork.update`（管理台"保存配置"）会 dispose 再 apply，原先会让 `llm-service` 换掉整个注册表、把适配器已注册的路由丢掉（插件仍显示 active、服务商列表却为空）——现在注册表是**每 ctx 单例**、只就地更新设置引用（`packages/plugin-llm/src/state.ts`）。**唯一的例外是数据库插件**——`@geewiki/postgres` 除 `passwordEnv` 外还提供一个 **`password` 明文密码字段**（`.role('password')`，schema 自述"仅本地开发"），它会**明文写进入库的 `config/plugins.*.json`**；生产请只用 `passwordEnv` / `connectionStringEnv`（详见「如何用 PostgreSQL」与已知限制 ③⑪）。
  - **【已过时 · P8 已整包删除本插件，决策 22】保留下方原文以存史** —— **AI 问答 `@geewiki/ai-qa`**（`packages/plugin-ai-qa/`，显示名「AI 问答」；由原 `@geewiki/ai`「智能问答」的问答那一半**重写**而来）：`provides: 'ai-qa-service'`、`requires: ['http-service','search-service','llm-service']`（**按服务 token 依赖，非插件名**）、**不进任何冲突组**。端点 `POST` / `GET /api/ai/ask`（`{q, limit?}`）、`POST /api/ai/stream`（SSE 逐帧）、`GET /api/ai/capabilities`。**产品裁决改了：没有可用模型就是不可用，绝不用检索片段冒充答案。** 旧形态靠 `mode:'retrieval-only'` + 零成本抽取式摘要兑现「没有 API key 也完整可用」，用户看到的仍然是一段「像答案」的文本 —— 这正是「AI 问答不好用」的第一来源；`extract.ts` 与该形态连同其测试一并删除。**状态码现在能说真话（固定口径，写进 `src/index.ts` 与 `src/types.ts` 文件头）：503 = 前置条件不满足**（`model_unavailable` / `search_unavailable` / `unavailable`，**根本没调用模型** ⇒ 处置动作是去「模型接入」配置或等检索回来）、**502 = 上游真的失败**（`generation_failed` + `degraded.code` ⇒ 处置动作是稍后重试）。把两者混成一个码是本批修掉的真缺陷：没配密钥与网关抽风在界面与监控里原本长成同一个样子。检索 **0 命中是 200 `mode:'no-context'` + `answer:null`**（事实，不是失败）。 **顺序即语义：先判模型 → 再检索 → 再看有没有资料 → 最后才生成**——把「没有模型」放在检索之前是刻意的（反正答不出来，就不白跑一次检索、也不在响应里附来源诱导前端「显示点什么」）；权限红线是 `search-service` 的 `search(principal,…)` 与 `contents(principal,…)` **两处都带主体**（命中层与正文层各过滤一次，漏一处就是标题/正文泄漏）。`[n]` 引用由提示词约束（`src/prompt.ts`：只依据资料 / 资料不足要明说「知识库资料不足，无法回答」/ 不编造 / Markdown 先结论），`sources[].n` 只对 `used:true` 者连续编号；`totalContextChars` 默认 0 = 由 `contextWindow − maxOutputTokens − 提示词余量` 推导（`src/budget.ts`）。流式：**所有前置判定（401 / 400 / 429 / 503）在写 SSE 头之前以普通 JSON 返回**，流内只有 `status`(rag|no-context + sources) → `delta` → `done`|`error`；`MAX_QUERY_LENGTH=500`（`src/index.ts:152`）、硬超时 **120s** / idle **30s** / 并发上限 **4**（`src/sse.ts:30`、`:38`、`:46`），超时值刻意不进 `configSchema`（只留测试注入口）。**本批实测**（`scripts/acceptance/ai-split-e2e/run.mjs` → `result-backend.json`，配一个**确定性假 OpenAI 兼容上游**，因此 429 / 空产出 / 正常流每次读数一致）：无凭据 ⇒ `A_ask.status=503` + `error=model_unavailable` + 响应体**没有 `answer` 字段** + `A_stream` **不是 event-stream** + **上游调用数 0**；补上密钥 ⇒ `B_ask.status=200` `mode=rag`、答案**逐字等于**模型输出、`sources=[{n:1, slug:rag-e2e, used:true}]`、提示词含 `[n]` 规则与「资料不足」条款；上游 429 ⇒ `502` + `RATE_LIMIT`；**上游 200 但一个 token 都没给** ⇒ `502` + `PROVIDER_ERROR`（空文本不是答案，判据用 `text === ''` 而非 `usage.completionTokens`，后者可选）；0 命中 ⇒ `200 no-context` 且**模型未被调用**；SSE 帧序列恒为 `status → delta* → done|error` 且终止帧恰一次、400 全是普通 JSON 不带 SSE 头。
  - **【部分过时 · `wiki-ask` 插槽与 `#/wiki/ask/<q>` 路由已随 P8 拆除；`@geewiki/ai-qa` 已整包删除】保留下方原文以存史** —— **AI 界面改由插件贡献（本批的归属修正）**：宿主 `packages/web/` 里**不再有问答面板与辅助写作工具条**——`components/AskPanel.tsx`、`components/ai/AssistToolbar.tsx`、`lib/aiStreamPlan.ts`、`lib/assistPlan.ts`、`api.ts` 的全部 AI 类型与 `aiAsk`/`aiCapabilities`/`aiAssist`/`aiAskStream` 四个方法、`lib/searchPlan.ts` 的 `REASON_NOTICE`/`degradedNotice`/`answerRenderer`、`lib/errorText.ts` 的 `streamErrorText`、以及 `styles.css` 的 `.ask-*` 一整套（原先与 `.search-*` 写成合并选择器，已拆开）**一并删除**；界面现在住在各插件的 `ui/`（`packages/plugin-ai-qa/ui/{index.tsx,sse.ts,askPlan.ts,style.css}`、`packages/plugin-ai-writing/ui/{index.tsx,assistPlan.ts,style.css}`），经**两个新增插槽**插入宿主：`wiki-ask`（**单占用**，问答面板）与 `editor-toolbar`（**多占用**，工具条按钮组）。插槽白名单因此从 2 个变 **6 个**：`packages/core/src/index.ts` 的 `SlotName = 'app-header' | 'app-footer' | 'editor' | 'editor-toolbar' | 'wiki-ask' | 'app-dock'`（**最后一个 `app-dock` 是 P2a 新增的常驻输入条**，见下方「AI 插件化重构」段）（宿主侧镜像 `packages/web/src/lib/slots.tsx:49`。**镜像由测试钉住，两处**：`packages/manager/test/slots.test.ts` 比对 core ↔ web，`packages/web/test/slotPropsMirror.test.ts` 比对 core / `slots.tsx` / `pluginUiPlan.ts` **三处逐元素相等（含顺序）**，并校验 `SLOT_CARDINALITY` 的键与 `SLOT_NAMES` 相等）。宿主只保留**自己的资产**：路由 `#/wiki/ask/<q>`（地址是宿主的，不是插件的）、`[data-slot="wiki-ask"]` 出口、以及没有贡献者时一句**中性占位**（可见文案是「问答功能未启用」，悬停 title 补一句「没有插件提供问答界面（`wiki-ask` 插槽无贡献者）」，`packages/web/src/pages/WikiPage.tsx:876-878`）——**不写插件名、不猜原因**：为什么不可用只有插件知道，宿主替它解释就是替别人的功能编造理由。**对称的一半也要说清**：入口按钮的可见文案「AI 问答」是宿主画的**功能名**（`:870-874` 的注释即这条裁决："用哪个模型、缺什么配置"是插件的知识，点进面板由它自己说），所以准确口径是"宿主不写插件名/模型名"，**不是"宿主零 AI 文案"**。界面**源码在插件包、构建仍由 `@geewiki/web` 编排**（`packages/web/package.json` 的 `build:plugin-ui` → `packages/web/public/plugins-ui/<插件名>/client.js|client.css`）；这不是洁癖而是必要：内置插件在管理器里**没有 `dir`**（`packages/manager/src/deps.ts` 只给外部插件挂资产根），所以「从插件目录直接发资产」那条资产根对内置插件不可用。宿主 SDK 新增 `renderMarkdown`（全仓只留一份 marked/DOMPurify 实现），插件用 `typeof host.renderMarkdown === 'function'` 特性探测、缺席则退回纯文本。**两条踩过的教训已写进代码注释**：① 入口可见性只能按入口表的**声明 + 仲裁**判（`pluginUiDeclaredFor`，`slots` 字段是后端裁决后的**生效集**）——按「已注册组件」判在懒加载插槽下会**自锁**（按钮永远不出现，除非它已经出现过；本批第一版就是这样，列表页的「AI 问答」入口恒不渲染）；② 懒加载集合 `ON_DEMAND_SLOTS = ['editor', 'editor-toolbar', 'wiki-ask', 'app-dock']`（`packages/web/src/lib/pluginUiPlan.ts:110`），进编辑视图必须同时拉起 `editor` 与 `editor-toolbar`，漏后者得到的是**一片静默空白**（管理台看着一切正常）。**本批实测**（`scripts/acceptance/ai-split-e2e/cdp-ui.mjs` → `result-ui.json`，真 Chrome + CDP，**19/19 全过**）：入口出现时插件 bundle **尚未被请求**（懒加载 + 声明判据不自锁）、进入问答视图后 `.ask-card` 确实出现在 `[data-slot="wiki-ask"]` 内、面板 CSS 作为独立样式表加载、宿主自身不产任何 `.ask-*` 节点、回答经 markdown 渲染成块级元素、点参考资料由**宿主**导航到该页（插件不碰 `location`）、编辑页工具条由插件渲染且写回按钮经宿主回调真的写进 CodeMirror 缓冲区、**改清单 + 重启后入口消失而 web 与两个插件 bundle 的 SHA 逐字节不变**、停用后是宿主中性占位（不出现插件面板也不点名插件）、全程 0 条 console error。
  - **平台一致性修复（同批）**：`@geewiki/wiki` 补了真实的 `ctx.provide('wiki-service', svc)`（此前是"只声明 token 不提供服务"）；`@geewiki/echo` **撤掉了** `provides: 'echo-service'`（无消费方，属谎报 token）；根 `package.json` 的 `test` 脚本加了 **`--no-bail`**（此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行 ⇒ 过去的"全量绿"读数可能是**部分**读数）。
- **AI 插件化重构（P8 已完成 —— 拆除旧问答 UI + 删除 `@geewiki/ai-qa`）**：
  **决策 17 + 决策 22 一起落地**，本批**只做减法**，`pnpm test` 从 1817 降到 1715 是预期的。
  **① `wiki-ask` 插槽与 `#/wiki/ask/<q>` 路由一起拆除**：AI 对话的**唯一入口**是常驻底部的
  `app-dock`。拆它的理由与决策 18 拆掉四个写作按钮是同一条 ——「同一个功能有两条界面路径时，
  两条都会漂移」：dock 与问答页各有一套输入、各自维护会话，用户在哪个里面问、答案去哪找，
  两处都答不上来。**拆干净的证据**（隔离实例实测，读数见设计文档 §8.12）：
  `packages/core/src/index.ts` 的 `SlotName` / `SLOT_NAMES` / `SLOT_CARDINALITY`、
  `packages/web/src/lib/slots.tsx`（另有 `SlotComponentMap` / `AnySlotComponent` /
  `SINGLE_OCCUPANCY_SLOTS` 与 6 个导出 `wikiAskEntry` / `wikiAskEntrySnapshot` /
  `useWikiAskSlot` / `WikiAskSlotState` / `useWikiAskSlotState` / `WikiAskSlotOutlet`）、
  `packages/web/src/lib/pluginUiPlan.ts`（第四处镜像 + `ON_DEMAND_SLOTS`）、
  `packages/web/src/pages/WikiPage.tsx`（ask 视图整块、`ensureSlotLoaded('wiki-ask')`、
  列表页「AI 问答」入口按钮、`WikiList` 的 `onAsk` prop）、
  `packages/web/src/lib/pageMeta.ts`（`WIKI_SUB_LABEL` 的 `ask` 条目）全部清空；
  `GET /api/plugins/slots` 实测**已无 `wiki-ask`**，`GET /api/plugins/ui` 的 `plugins`
  **恰两键**（`@geewiki/ai-assistant: ['app-dock']`、`@geewiki/ai-summary: ['article-summary']`），
  `packages/web/dist/` 与 `packages/web/public/plugins-ui/` 全量 grep 四处关键词 **0 命中**。
  **② `@geewiki/ai-qa` 整包删除**（决策 22）：拆掉那个插槽之后它的三样东西全部无家可归 ——
  `ui/`（唯一去处就是该插槽）、`provides: 'ai-qa-service'`（全仓**零消费方**）、
  `/api/ai/ask` 与 `/api/ai/stream`（唯一入口就是那个面板）；而它的能力已分别被
  `ai-kb`（检索）、`ai-assistant`（会话）、`ai-summary`（摘要检索）接走，
  设计文档 §7 早就写着「`ai-qa` **重写为** `ai-assistant`」。实测三个旧端点
  （`/api/ai/ask` / `/api/ai/stream` / `/api/ai/capabilities`）**全部 404**，
  旧产物 `/plugins-ui/@geewiki/ai-qa/client.js` 也 404；`POST /api/ai/turn` 与
  `GET /api/ai/summary` 不受影响。插槽白名单因此 **7 → 6 个**，内置插件注册表 **23 → 22 个**、
  默认基础层启用 **19 → 18 条**。
  **③ 一条刻意留下的不对称：`'ask'` 仍是 slug 保留段，但不再是路由。** 解禁是**单向不可回收的** ——
  一旦放开，历史上被拒的 `ask/…` 会变成合法，而既有的 `#/wiki/ask` 分享链接会**静默**从
  「问答页」变成一个页面。实测 `PUT /api/pages/ask` 与 `PUT /api/pages/ask%2Ffoo` 仍是
  **400 `invalid_slug`**「首段不能是 search/ask/new/list」。两条反向断言钉住决策本身：
  `packages/web/test/wikiRoute.test.ts`（`ask` 在保留段里）与
  `packages/web/test/slotPropsMirror.test.ts`（`wiki-ask` 不得回到白名单）。
  **④ 两处被既有测试当场抓出的连带缺陷（不是事后自查发现的）**：删掉解析分支后
  `#/wiki/ask/foo` 会落到详情页分支 ⇒ `detail + slug='ask/foo'`，而两个下游把它当成
  「用户正看着一篇真实存在的文章」——`packages/web/src/lib/dockPlan.ts` 的 `pageContextOf`
  会告诉模型「当前页是 ask/foo」（模型随后去读一个不存在的页），
  `packages/web/src/lib/commandPlan.ts` 的 `visitedSlugFromSub` 会把它记进「最近访问」。
  两处的症状都是**安静的错**：不报错，只是上下文指向空气。修法**收在一处** ——
  `packages/web/src/lib/wikiRoute.ts` 新增 `isUnreachableSlug(slug)`（首段是否保留段），
  两个消费者共用，而不是各写一个会随保留段增减而漂移的 `startsWith('ask')` 特判。
  另一处是 `packages/plugin-llm/test/degrade.test.ts` 的双向守卫：它原先读
  `plugin-ai-qa/src/types.ts` 的 `AskErrorCode` 核实 `search_unavailable`「不是消失了、
  而是归了另一套词汇」，ai-qa 删除后它**该失败**——守卫跟着**词**搬家而不是跟着文件搬家，
  改指 `@geewiki/ai-assistant` 的 `tools_unavailable`（检索变成贡献工具之后，缺的不再是
  一个检索服务，而是**必需的那几条工具**）。
  **上文凡提到「`@geewiki/ai-qa` / `wiki-ask` 插槽 / `#/wiki/ask/<q>` 路由 /
  `POST /api/ai/ask` / `POST /api/ai/stream` / `.ask-*` 类名」的段落均已过时**，
  它们记录的是本批之前的口径，保留以存史。设计真源见
  [docs/design/ai-plugin-architecture.md](../design/ai-plugin-architecture.md)
  §0 决策 22 / §7.1 / §8.12 / §9.0。
- **AI 助手对话区改版（2026-09-15，用户实测反馈三条：历史显示不正常 / 滚动条突兀 / 消息之间空白很大）**：
  三条反馈对应**三个独立的根因**，另外顺带修掉一个"注释写了、代码没做"的重复显示。
  **① 历史面板被 flex 挤扁（"显示不正常"的真因）**：它原本是一个**裸 `<ul>`**（只有
  `max-height` + `border-bottom`），而它带 `overflow: auto` ⇒ `min-height` 自动变 0 ⇒
  被同一列里的 `.gw-dock-thread` 压到只剩 **40px**：三段历史**只看得见一条**，另外两条要靠
  列表自己那条内嵌滚动条去翻（实测 `data/verify/dock-ui/before.json`）。改后是一个真面板
  （`.gw-dock-history-panel`，`flex: none` + 标题 + 背景圆角），每条带**相对时间与消息条数**
  （标题常常长得差不多，没有时间就分不清哪段是刚才的），当前正在看的那段高亮。
  实测高度 40 → **151px**，三条全部可见、无内嵌滚动条。
  **② 滚动条是浏览器默认那条**：改前实测占 **15px** 宽，深色面板里就是一整条浅色高对比带
  还带上下箭头按钮。改后 `scrollbar-width: thin` + `::-webkit-scrollbar` 双写法（标准属性在
  新版 Chromium 上优先，两侧观感一致）、8px 轨道透明、滑块用**契约块里的语义色**
  （`color-mix(in srgb, var(--color-ink) 22%, transparent)`）并随主题变化、`::-webkit-scrollbar-button`
  关掉箭头。实测 15 → **10px**（`thin` 的固有宽度），滚动条自身不再是视觉噪音。
  **③ 空白很大的真因是 `white-space: pre-wrap` 继承进了 markdown**：它写在 `.gw-dock-msg` 上，
  而 markdown 渲染结果就在它的子元素里 —— marked 生成的 `<ul>\n<li>…</li>\n<li>…</li>\n</ul>`
  中，标签之间的换行在 `pre-wrap` 下会**各自生成一个空行盒**。实测一条三行的列表
  `<ul>` 高 **147px**、单项 **49px** 而文字只有 **21px**。`pre-wrap` 只对**流式期间的纯文本**
  有意义（那里确实要保留换行），已下移到 `.gw-dock-text`，`.gw-dock-md` 显式回到 `normal`。
  顺带补齐了 markdown 排版：宿主的 `.md-body` 那套是给整页阅读用的，面板里同一尺度会显得空，
  故块间距统一压到 `0.6em`、标题 `0.9em/0.45em`，并补上**表格**样式（模型很爱用表格罗列页面，
  而插件此前**完全没有** table 规则）。实测列表项 49 → **21px**，`<ul>` 147 → **67px**，
  消息间 flex gap 8 → 6px。**④ 同批修掉的重复显示**：`renderThread` 里那句注释写着
  "tool：不单独成段……**只在没有活动记录时**留一行痕迹"，而代码是**无条件**推那一行 ——
  于是每次工具调用都显示两遍（对话流一条灰字「工具 X 已返回」+ 活动列表一条「X 完成」）。
  现已按注释兑现：活动列表里已有的 `toolCallId` 不再单独成行（活动列表只覆盖最后一轮，
  更早轮次的痕迹仍留在流里，位置信息不丢）。
  **守卫与红-绿**：`packages/plugin-ai-assistant/test/uiDock.test.ts` 新增 **7 例**
  （`relativeTime` 档位边界与时钟回拨 2 例 + CSS 三条 + 重复显示一条 + 正向对照），
  **四条守卫逐条做了红-绿**（变异后恰好只红那一条，复原并校验 hash 一致）。
  两条实现期教训已写进测试注释：① CSS 规则匹配**不能用正则**（嵌套 `@media` 下会漏，
  已改成真括号扫描器）；② 守卫锚点**不能选注释**（`readCode` 会剥注释 ⇒ 锚点恒为 -1，
  第一版就因此恒红），范围也不能是全文件（新注释里**正写着**被守卫的那句话 ⇒ 删掉代码仍绿，
  即本仓记档过四次的"被守卫的东西出现在被扫描的文本里"）。
  **读数**：`pnpm test` **1726/1726 绿**（22 个包全部 `# fail 0`，较上一读数 +7）；
  `pnpm typecheck` **25** 个 project 全 Done、0 个 `error TS`。**真实模型端到端实测**
  （`data/verify/dock-ui/live.mjs`：CDP 打真字、点真「发送」、走 `POST /api/ai/turn`）：
  2 条消息 / 间距 6px / 滚动条 10px / **`toolLines: 0` 而 `toolActivities: 1`**（去重生效）/
  回答 535 字并正确渲染成带边框表头的表格 / 会话已落盘（`历史（1）`）。
  **一条实测技巧**：CDP 的 `Input.dispatchKeyEvent` 发 Enter **不会**产生"回车提交表单"这个
  默认动作 —— 文字进了输入框却没有任何请求（`msgCount: 0`）。要点按钮就用真实指针事件。
  **另发现一条待裁决的问题（本批未改）**：问「知识库里有哪些页面」时模型调 `list_pages`、
  答案完全正确，界面却盖了「这不是知识库内容 / 来自模型自身的知识，请自行核实」——
  因为 `list_pages` **刻意不声明 `grounding: 'kb'`**（`packages/plugin-ai-kb/src/index.ts:218`
  的理由是"地图不是依据"，防的是"先列一遍页面、再凭空写答案"被算成有依据）。
  判据方向是对的，代价就是这类**假阴性**：回答明明来自知识库却被指为模型自身知识。
  可行的收紧是**按"这一轮有没有用过工具"分档措辞**（用过非依据工具 vs 完全没用工具），
  但那是改一条已记档的语义，等裁决再动。
- **底部对话条展开/收起动画（2026-09-15，用户实测反馈「展开和收起没有动画，非常生硬」）**：
  根因是面板被**条件挂载**（`{open && (<section className="gw-dock-panel">…)}`）——
  元素一卸载就没有可插值的起点，两个方向都只能瞬间完成，**改动画的时长与曲线都无从下手**。
  改法：面板**常驻 DOM**，收起态交给 CSS 折叠——`.gw-dock-shell` 是
  `display: grid; grid-template-rows: 0fr`，展开态 `.gw-dock-open .gw-dock-shell` 覆盖成
  `1fr`。选 `0fr → 1fr` 而不是 `max-height`：插值的是**轨道尺寸**、终值取"内容自然高度"，
  因此不必猜一个"够大的 max-height"（猜小了截断，猜大了前 80% 的时间看不出在动、最后几帧
  突然窜完——那比没有动画更难看）。同一时间还动了容器宽度（`440 → 680`）与卡片本身
  （`opacity` 0→1、`translateY(6px)`→`none`）：只动高度会显得卡片"被压扁"。
  **折叠 ≠ 卸载 ⇒ 收起态必须 `inert` + `aria-hidden`**：DOM 还在，不给 inert 的话
  「历史（N）」「新对话」「收起」「发送」这些看不见的按钮仍然进 Tab 序列，键盘用户会掉进
  一块空白里的焦点陷阱（实测 `link.focus()` 后 `document.activeElement` 仍是 `BODY`）。
  三处"看着在动、其实会跳"的细节一并修掉：**①** 网格项 `.gw-dock-clip` 上不许有
  `padding/border/margin`——它们不受 `min-height: 0` 约束，`0fr` 塌不到 0（收起后留一条亮线
  或一道缝）；**②** 卡片投影与"面板↔输入条之间那道 8px 缝"从面板挪到**裁剪盒之外**的
  `.gw-dock-shell`（`overflow: hidden` 会把面板自己的外投影裁得一干二净，卡片会突然没有影子；
  并让投影从全透明**淡入**，否则展开第一帧先是一道 0 高盒子配 32px 模糊的灰印）；
  **③** `.gw-dock-bar`（55px）与 `.gw-dock-form`（原 `height: auto` ≈45px）**不是同一个盒子**，
  展开那一瞬间底行会自己缩 10px——`55px` 直接提到两者的共用规则里。
  **宿主侧一处契约补齐**：`--ease-standard` 原先只在 `tokens.css` 的 `@theme inline` 里，而
  那份**不进产物**，插件 CSS 引用它会静默回退；已补进第 4b 节"插件产物可引用的宿主变量"
  契约块（`packages/web/src/styles/tokens.css`）——曲线是宿主的设计决定，插件不该各抄一份。
  **守卫**：新增 `packages/plugin-ai-assistant/test/uiDockMotion.test.ts` **7** 例源码守卫
  （面板不得条件挂载 / 收起态两属性绑同一元素 / 折叠机制 / 网格项不得带 padding·border·margin /
  投影必须在裁剪盒之外 / 两种状态同盒 / "减少动效"覆盖三个动效选择器），并对第 ⑤ 条做了
  **反向对照**（把 `box-shadow` 写回面板 ⇒ 恰好只红那一条）。
  **真浏览器量取**（`node data/verify/dock-ui/motion.mjs`，真 Chrome + CDP，按帧采样
  **可见高度**）**17/17 PASS**：展开 **12** 个中间帧（`32ms/11.5px → 48ms/49.5px → 65ms/94px
  → 81ms/130px → 98ms/156.6px → 115ms/177px`，终值 **232.5px**）、收起 **12** 个中间帧
  （`27ms/220.9px → 44ms/182.8px → 61ms/138.3px → 78ms/102.6px → 94ms/75.8px → 111ms/55.4px`，
  终值 **0**）、容器宽度过渡到 **680**、展开后 `box-shadow` 是
  `rgba(0, 0, 0, 0.16) 0px 10px 32px`、收起态是 `rgba(0, 0, 0, 0) 0px 0px 0px`、
  `prefers-reduced-motion: reduce` 下三个动效全部 `none / 0s` 且展开**无中间帧**；
  截图 `motion-opening.png` / `motion-open-settled.png` / `motion-closing.png`（同目录）。
  **一条量取教训（脚本第一版因此假红/假绿）**：面板常驻后收起态**仍有满高**
  （232.5px，只是被裁掉），拿 `.gw-dock-panel` 的 `getBoundingClientRect().height` 当判据会
  读出"收起态也 232px"；判据必须是**轨道（可见）高度**。同理收起态点开 dock 要点
  **`.gw-dock-bar .gw-dock-input`**——面板里那个同名输入框在 DOM 里更靠前且被 inert 挡着，
  `querySelector` 会先命中它（本仓没有别处依赖这个选择器，已确认）。
  读数：`pnpm test` **1799/1799**（24 个包 0 fail；`plugin-ai-assistant` 187 → **199**）、
  `pnpm -r typecheck` **27 Done / 0 error**（含 `tsconfig.plugin-ui.json` 那条）。
- **头部三个动作改成纯图标（2026-09-15，用户要求「把历史、新对话、收起都以图标来显示，不要文字」）**：
  历史 / 新对话 / 收起从文字链接（`.gw-dock-link`，靠下划线表达可点）改成 **26×26 图标按钮**
  （`.gw-dock-icon`，图形 16×16 与宿主顶栏图标同规格；可点性改由**悬停底色**表达，历史面板
  开着时用同一块底色常驻 + `aria-expanded`——状态不能只靠颜色表达）。`.gw-dock-link` 已删
  （留成死规则会让人以为还有文字链接）。
  图标**自己画**（新增 `packages/plugin-ai-assistant/ui/icons.tsx`，按 lucide 的几何：
  24 网格 / 2px 描边 / 圆头圆角）：插件界面的构建只把 **react 系说明符**外置
  （`packages/web/fixtures/vite.config.ts:111`），所以插件里 `import 'lucide-react'` 的后果是
  **把一份图标实现打进插件 bundle**，并让插件包的依赖清单多一条真实边（插件的质量门会查
  "用了没声明的依赖"）；三个图标不值得这条边。**语义上按钮才是控件、图标只是装饰**，
  故三个 svg 都 `aria-hidden="true"`（共用一份 `BASE` 属性对象，漏不掉）。
  **两条不能随文字一起丢的东西**：① 图标按钮没有可见文字 ⇒ `aria-label` 是**唯一**的可访问名
  来源（缺了读屏只念"按钮"），三个按钮各带 `aria-label` + `title`（悬停提示）；
  ② 历史的**条数**原本长在文字里（「历史（3）」），现在视觉上是图标右上角的小角标、
  可访问名里照旧念「历史（3）」（角标自己 `aria-hidden`，否则念两遍；0 条时不渲染角标，
  可访问名仍是「历史（0）」）。
  **守卫**：新增 `packages/plugin-ai-assistant/test/uiDockIcons.test.ts` **5 例**
  （三个按钮都必须是 `gw-dock-icon` 且**按钮里已无可见文字** / `aria-label` + `title` 齐全 /
  条数仍在可访问名里且角标 `aria-hidden` / 每个 svg 都走同一份 `BASE` /
  悬停底色 · `:focus-visible` · "减少动效"清单），第 ① 条做了**反向对照**（把「收起」二字加回去
  ⇒ 恰好只红那一条）。**写这条守卫时踩的坑**：判定"按钮里有没有文字"起初写
  `block.replace(/<[^>]*>/g, '')`，而 `onClick={() => setOpen(false)}` 里的 `=>` 自带一个 `>`，
  那条正则会在箭头处把"标签"截断，于是 `aria-label="收起"` 这类**属性值**被当成可见文字
  （假红报「按钮里有文字：setOpen(false)}aria-label="收起"」）——现在是一个真正的 JSX 文本节点
  扫描（跳过标签、引号里的属性值、`{…}` 表达式，含嵌套）。
  **真浏览器量取**（同一支脚本，当时 **21/21 PASS**）：三个按钮的 `aria-label` 实测为
  `历史（2） / 新对话 / 收起`、`textContent` 长度 `1,0,0`（只有角标那个数字）、三个 svg 的
  `aria-hidden` 全为 `true`、点历史图标 ⇒ `aria-expanded="true"` + 面板出现 + 常驻底色类生效；
  动画两个方向、宽度过渡、投影与 `prefers-reduced-motion` 全部照旧通过
  （面板满高 232.5 → **239**，多出的 6.5px 就是头部从文字行变成 26px 图标按钮的高度）。
  截图 `data/verify/dock-ui/motion-icons-history.png`（含角标与展开的历史面板）。
- **点 dock 外部即收起（2026-09-15，用户要求「当点击 dock 外的时候直接收起，而不是一定要点收起按钮」）**：
  判据只有一条——事件目标在不在**根节点**（`.gw-dock`，带 `ref={rootRef}`）之内。**用根节点而不是面板**：
  面板、输入条、历史面板都挂在根节点下，任何一个都不该被算成"外部"（挂在面板上的话，点一下输入条
  就自己收起了）。挂 **`pointerdown` 而非 `click`**：`click` 只在按下与抬起**落在同一个元素**时触发，
  拖选文字时它的 target 可能是两者的**共同祖先**（有可能就是根节点自己）⇒ "在面板里拖选"被误判成内部；
  按下时就判，语义最干净（按下哪边就是要操作哪边）。监听挂**捕获阶段**（`addEventListener(..., true)`）：
  宿主或插件内部任何 `stopPropagation` 都不该让"点外部"失效——收起是 dock 自己的事，
  不该依赖别人把事件放行。**只在展开时挂 + 一定 cleanup**：收起态挂着不但白多一个全局监听，
  还会让每次页面点击都白调一次 `setOpen(false)`；忘 cleanup 则每次开合多留一个监听
  （`setOpen(false)` 幂等，症状只是"偶发怪异"，不会崩——所以必须有守卫挡着）。
  **顺带补 Esc**（同一件事的键盘对应物）：没有它，键盘用户只能 Tab 到"收起"图标才能关面板。
  **收起后不要把焦点还给输入条**：两个输入框的 `onFocus` 就是"展开"，还焦点等于 Esc 无效
  （刚收起就又展开）——这条也写进了守卫，免得后来者"顺手加上去"。
  守卫 `test/uiDockDismiss.test.ts` **3 例**（判据挂在根节点而非面板 / 捕获阶段 + 只在展开时挂 + cleanup /
  收起路径里不许出现 `.focus()`），两条主守卫各做了**反向对照**（去掉根节点 `ref` ⇒ 只红第 ① 条；
  删掉 cleanup ⇒ 只红第 ② 条）。真浏览器 **25/25 PASS**（同一支脚本新增 4 项）：点页面正文 ⇒ 收起；
  **反向对照**点面板标题 ⇒ 不收起；Esc ⇒ 收起；收起后点输入条仍能再展开（监听没粘死）。
  截图 `data/verify/dock-ui/motion-outside-collapsed.png`。
- **底部对话条"丝滑 / 焦点 / 抽搐"三连修（2026-09-15，用户实测反馈「dock展开收起不够丝滑」
  「点击展开后，焦点并没有在上面，还要再点一下才能输入」「点击收起后会抽搐一下」）**：
  三个症状对应三个根因，都不是"曲线好不好看"这种玄学：
  ① **抽搐 = 收起态输入条原先是条件挂载的**（`{!open && <form …>}`）。卸载让根盒子在那一瞬间少 63px
     （55px 输入条 + 8px 缝），而根是 `position: fixed; bottom: 16px` **钉住底边**的 ⇒ 顶边瞬移 63px。
     改成 `.gw-dock-bar-clip` 常驻 + 高度插值（55 ↔ 0），与面板的 0 ↔ 满高**同时**发生，
     根盒子总高于是单调（实测 63 → 72 → 102 → 137 … → 247）。投影按面板那套挪到裁剪盒上
     （`overflow: hidden` 会裁掉子元素的投影，否则收起态输入条突然没影子），0 高那侧显式淡成全透明。
     **判据也得跟着换**：当时的量取只看 `.gw-dock-shell` 的高度——那一项自始至终单调，所以用户看见
     抽搐、脚本却全绿。现在采样器同时记**根盒子**的顶边，判据是"单调 + 无反向 + 峰值速度 ≤ 1.8px/ms"
     （峰值按 ≥16ms 滑窗算：rAF 相邻帧有时只隔 5~9ms，按单帧算会假红）。
  ② **焦点没落上 = 收起态与展开态是两个不同的 input**：点收起态那个 ⇒ 它 `onFocus` 把 `open` 置真
     ⇒ 它随即被收进 `inert` 的裁剪盒 ⇒ 浏览器把焦点甩到 `body`。现在展开时显式把焦点交给面板里那个
     输入框，且必须 `focus({ preventScroll: true })`——**`overflow: hidden` 的盒子照样能被 focus 滚动**：
     不带这个选项时浏览器为了"把输入框带进视野"把裁剪盒滚到底（实测 `scrollTop≈200`），于是整段动画
     露出的是面板**底部**（输入行）而不是从顶部一帧帧揭幕，而且每一帧还会追着焦点元素重滚，看起来就是抖。
     真浏览器判据两条：动画期间"面板顶必须始终贴着裁剪盒顶"（越界 **0** 帧）、展开后 `scrollTop === 0`。
  ③ **不够丝滑 = 宿主那两条曲线都是给 150ms 的颜色·小位移调的**。`--ease-standard`（0.2, 0, 0.13, 1）
     在 25% 的时间里走完 50% 的距离、峰值速度 2.9× 平均（184px 位移 ⇒ 单帧 37px）；`--ease-out`
     更陡（峰值 6.2×、83%）。用在抽屉上就是"一冲一顿"。故在 `tokens.css` 的 4b 契约块新增第三条
     **`--ease-move: cubic-bezier(0.15, 0.08, 0.5, 1)`**（峰值 1.6× ⇒ 单帧 20.4px，降 44%；
     25/50/75% 时间走 35/70/92% 距离——起步仍然跟手，尾巴不再"爬"），抽屉的几何过渡（容器宽度、
     面板高度、输入条高度）全走它，颜色/淡入仍用 `--ease-standard`。**反向对照**：把 `--ease-move`
     换回旧曲线 ⇒ 峰值 2.07/2.09px/ms、单帧 35px，判据立刻红（量取脚本内置 `REVERSE_EASE=1`
     开关，可原地复现）。顺带删掉面板的 `translateY(6px)`：盒子已经在做几何动画，内容再滑一次是
     "同一件事动两遍"，且两条曲线不同 ⇒ 收尾错拍、显抖。
     同批还补掉一处**两个输入行同时在场**的重影：收起态输入条的静止位置比展开态表单低 19px
     （= 8px 外壳下边距 + 10px 面板下内边距 + 1px 面板下边框），原先这段动画里两个输入行会同时可见、
     错开 19px 且占位文案还不同。现在展开时输入条一边被裁一边抬 19px 接上表单（收起草反过来），
     判据是"任意一帧两个输入行的可见高度不许同时超过 8px"（实测 0 帧重叠，过渡期间位移正好 19px）。
     这 19px 写成插件本地变量 `--dock-row-lift`，**刻意不用 `--gw-` 前缀**——那个前缀在本仓是"宿主
     token"的记号，占了会撞 `pluginUi.test.ts` 的 token 契约守卫（本批真被它拦了一次）；另有一条守卫
     把三项从 CSS 里解析出来相加、与这个值核对，改了任一项就会红。
  守卫：`uiDockMotion.test.ts` 7 → **11** 例（新增"输入条常驻 + 高度插值""焦点交接 + preventScroll"
  "几何过渡走 `--ease-move`""`--dock-row-lift` 与三项对齐"）。
  真浏览器量取 **34/34 PASS**（新增揭幕方向、重影、`scrollTop`、根盒子峰值速度四组）。
  读数：`pnpm test` **1806/1806**（24 个包 0 fail）、`pnpm -r typecheck` **27 Done / 0 error**。
- **深色模式适配修复（2026-09-15，用户实测反馈「深色模式下显示有问题，或者说没适配」）**：
  查下来是**三个独立的缺陷**叠在一起，其中一个还是排查过程中我自己引入的。
  **① 插件样式引用的 `--color-*` 压根不在产物里（主因）**：语义色写在 `tokens.css` 的
  `@theme inline` 里，而 `inline` 的语义是「把值内联进生成的工具类」——变量**声明本身不输出**
  （实测改动前的 `packages/web/dist/assets/index-*.css`：`--color-line` / `--color-sunken` /
  `--color-ink` / `--color-muted` / `--color-warn*` / `--color-danger-ink` **一个都没有**；
  只有恰好被某条工具类捎带上的 `--color-surface` / `--color-header*` 与尺度档留了下来）。
  宿主界面不受影响（工具类里是 `var(--gw-ink)` 真值），**只有插件产物**会中招 ——
  `ai-summary` 的摘要条 `background: var(--color-sunken)` 整条声明失效（背景全透明、边框退回
  `currentColor`，即用户截图里那条「没有样式的摘要行」）；`ai-assistant` 的 `var(--color-sunken, #f9fafb)`
  这类**浅色回退值**在深色下渲染成白块。修法是 `tokens.css` 新增**第 4b 节**：一段**不分层的普通
  `:root`** 把插件可引用的名字无条件输出（`@theme` 产物在 `layer theme` 里，不分层规则优先级更高；
  值仍只指向 `--gw-*`，故深浅色自动跟随、契约块一行都不用改）。**两条试过且不成立的错路**：
  `@theme static inline` 与 `@theme static` 在本仓这份 Tailwind 下会把自定义色工具类**一起弄没**
  （`.text-ink` 直接不再生成）；把 `@theme` 整份抄一遍则立刻有**两份会漂的名单**。
  **② dock 的颜色是猜的**：`ui/style.css` 原先写着「插件拿不到主题变量，故用 `currentColor`
  与半透明黑推导」——**那个前提是错的**。`background: color-mix(in srgb, Canvas 92%, transparent)`
  里的 `Canvas` 是浏览器**系统色**，深色下解出 Chrome 自己的中性灰 `rgb(18,18,18)`，与本仓深色底
  （`--gw-bg` = `#0b131d`，带蓝调的近黑）并排就是"没适配"的观感。已全部改写为宿主语义变量，
  并且**一个回退值都不留**——回退值在变量存在时不生效、缺失时给出一个**只有浅色主题正确**的值，
  于是"深色下变白块"永远等不到一条会红的测试。
  **③ 排查途中我自己造的一个坑（值得单独记）**：给 `tokens.css` 写说明注释时写了
  `packages/plugin-*/ui/style.css`，其中的 `*/` **提前闭合了注释**，剩下的注释文本被当成 CSS 解析，
  紧随其后的 `@theme inline` 被**整块丢弃** ⇒ 症状是"自定义颜色工具类全部消失"，与"构建失败"
  毫无相似之处。**同一个坑在本仓是第二次**（源码守卫也栽在"被守卫的东西出现在被扫描的文本里"）。
  **④ 顺带扫出并修掉一个两种主题下都存在的真缺陷**：`WikiPage.tsx` 的「全部页面 →」链接用了
  `text-accent-ink`——那是"**实心** accent 底上的字色"（浅色下白、深色下近黑），这一处**连 accent
  底都没有** ⇒ 浅色 **1.07:1**、深色 ≈ **1:1**，即该链接在两种主题下都等于看不见（深色截图里它整条
  消失，浅色侧由 axe 标为 serious）。这个陷阱本仓**早已记档**（`components/Sidebar.tsx:108` 的注释
  就写着"配 `bg-accent` 才对"），只是这一处漏了。**修法与守卫**：`packages/web/test/pluginUi.test.ts`
  新增**四条**守卫并逐条做了红-绿 —— ①插件引用的语义 token 必须落在**非 `@theme` 块**里
  （带反向对照：`@theme` 内独有名必须够多，否则守卫在自欺）；②插件样式**不得写 `var()` 回退值**；
  ③`tokens.css` 注释必须闭合干净；④拿**构建产物**复核自定义色工具类真的在。
  **读数**：`pnpm test` **1719/1719 绿**（**22 个包全部 `# fail 0`**，较上一读数 +4 = 新增的四条守卫）；
  `pnpm typecheck` **25** 个 project 全 Done、0 个 `error TS`；`packages/web` build 与 `build:plugin-ui` 通过。
  **浏览器实测**（CDP + 真实实例，`data/verify/dark-mode/`）：改前 `.gw-summary` 背景 `rgba(0,0,0,0)`、
  边框 `currentColor`，`.gw-dock-bar` 背景 `rgb(18,18,18)`（Chrome 灰）；改后深色下 `.gw-summary` 背景
  `rgb(28,39,51)`（`--gw-surface-sunken`）、边框 `rgb(38,50,67)`（`--gw-line`）、`.gw-dock-bar` 背景
  `rgb(19,28,39)`（`--gw-surface`）、主按钮 `rgb(59,130,246)`（accent）配 `rgb(11,19,29)`（accent-ink）；
  浅色下同样成立。**axe `color-contrast` 两个主题各扫一遍，违规数均为 0**（改前浅色 1 条 serious）。
  **顺序上的一个实操坑**：`build:plugin-ui` 只写 `packages/web/public/plugins-ui/`，而服务端发的是
  `packages/web/dist/`——**必须先 `build:plugin-ui` 再 `build`**，否则改了插件 CSS 而页面纹丝不动
  （本次实际被它骗过一轮：宿主样式已是新的、dock 还是旧的）。
- **AI 能力拆分与归属修正（本批）**：原 `@geewiki/ai`「智能问答」名不副实——它同时装着「检索增强问答」和「编辑器辅助写作」两件事，而**问答界面长在宿主 web 里**。本批按能力拆成 `@geewiki/ai-writing`（「AI 辅助写作」，保留 `/api/ai/assist` 与工具条）与新建的 `@geewiki/ai-qa`（「AI 问答」），并把两块界面都搬出宿主、改由插件经新增插槽贡献（`editor-toolbar` 多占用 / `wiki-ask` 单占用）；设计、契约与五处**实现期对本设计的改写**记在 [docs/design/ai-plugin-architecture.md](../design/ai-plugin-architecture.md)（落地偏差：503/502 分工、零字符 `done` 判 502、上游失败文案不再罗列路由清单、入口可见性按声明而非已加载组件、宿主镜像守卫随界面迁走——**留下的判据是「谁消费，谁守镜像」**）。**为什么"改名"要拆成两个插件**：一个既做问答又做写作、没有模型就冒充答案的插件，无论叫什么都会继续误导；问答要的是「模型 + 引用 + 明确不可用」，写作要的是「上下文只来自请求体 + 编辑权判定」，两者的权限边界与失败语义都不同。**两条验收脚本**（都起隔离实例 + **确定性假 OpenAI 兼容上游**，因此读数每次一致；不改写历史快照）：`scripts/acceptance/ai-split-e2e/run.mjs`（后端契约，读数 `result-backend.json`）与 `cdp-ui.mjs`（**真浏览器 + CDP**，19 条断言，读数 `result-ui.json`），踩过的坑记在 `scripts/acceptance/ai-split-e2e/README.md`。本批**顺带修掉的真缺陷**：`packages/web/src/lib/pluginUi.ts` 的入口可见性判据按"已注册组件"而非"入口表声明"（懒加载下自锁；现已是 `pluginUiDeclaredFor`，`:190`，读的是裁决后的 `slots` 生效集）、非法 `limit` 被 `retrieve()` 的 catch-all 吞成 503 `search_unavailable`（契约里它该是 400 `invalid_limit`）、`listRouteInfos` 未过 `redact` 而 `capabilities` 是 public 端点且 `descriptor.model` 是对用户设置的实时 getter（⇒ 匿名请求方可镜像管理台配置）、辅助写作在上游一个字符都没给时仍返回 200 + 空文本。
- **AI 插件化重构（P3 已完成）**：`@geewiki/ai-assist` 已**改名并改造为 `@geewiki/ai-writing`**，且**决策 18 把它的四个按钮整份拆掉了**——续写 / 改写 / 润色 / 摘要、`POST /api/ai/assist` 端点、`editor-toolbar` 插槽贡献、整份前端产物（`ui/index.tsx` 399 行 + `assistPlan.ts` 248 行 + `style.css`）与对应测试**全部删除**。理由是"同一件事有两条界面路径时，两条都会漂移"：AI 现在只有 `app-dock` 输入条一个入口。本插件因此**没有任何 HTTP 端点、没有前端产物、不 provide 服务**，只剩一个职责——向工具总线声明四条 `editor.*` 客户端工具描述符（`packages/plugin-ai-writing/src/index.ts`）。**上文凡提到"AI 辅助写作 / `POST /api/ai/assist` / 编辑页工具条"的段落均已过时**，它们记录的是本批之前的口径，保留以存史。**执行体在宿主**（`packages/web/src/lib/editorTools.ts`，编辑态由 `WikiEdit` 按有无编辑框句柄决定登记哪几条）：工具本来就是"服务端说它存在、浏览器说它怎么跑"两半，故宿主登记处理器**不等于**插件失去存在理由，设计文档 §9.1 已按此定稿。**本批实测**（`node --import tsx scripts/acceptance/p3-editor-tools/run.ts`，真实上游 + 真实 `POST /api/ai/turn`，**PASS**）：模型先调 `editor.read_doc` 读草稿、再调 `editor.insert_text`，**编辑框真的从 `"# 草稿\n\n这里只有半句话"` 变成 `"# 草稿\n\n这里只有半句话—— 到此为止。"`**；客户端上报 `admin.disable_plugin` / `@geewiki/llm.rotate_key` 这类**未声明的名字不进模型看到的工具表**（交集收窄是安全属性）；只上报 `editor.read_doc` 时写工具**不在**工具表里。**一条协议事实**：服务端只执行 `side:'server'` 的工具，`side:'client'` 的调用原样交回、回合以 `finishReason:'tool_calls'` 收尾 ⇒ "一次提问"是**多个 HTTP 回合**（本次 2 个），上限 8 与 `ui/dockPlan.ts:37` 同值。**顺带修掉两个 P2b 留下的真缺陷**（都是把 `@geewiki/ai-assistant` 纳进 `web/test/pluginUi.test.ts` 的循环后立刻变红暴露的）：① dock 的 `fetch` 漏了 `x-gw-csrf: 1` 与 `credentials: 'same-origin'`——服务端在带会话 cookie 时强制校验 CSRF 头，漏了它的表现是**每个登录用户的每一次提问都 401**（P2b 的验收脚本从 node 发请求、自己带头，**根本没走这个浏览器传输**）；② dock 的 `.gw-dock-input { outline: none }` 去掉原生焦点环却没补替代品（WCAG 2.4.7），已补 `:focus-within` 与 `:focus-visible`。**读数更正**：全仓 `pnpm test` **1590/1590 绿**（18 个包全部 `# fail 0`）、`pnpm typecheck` **21** 个 project 全 Done；**用例数比上一读数 1614 少 24 是因为删掉了已不存在的界面与端点**（`assist.test.ts` / `uiToolbar.test.ts` / 旧的 `plugin.test.ts` 整份），同期新增 `plugin-ai-writing` 15 例 + `web/test/editorTools.test.ts` 13 例。另：`AppDockSlotProps.page.kind` 已从六个值**收窄到 `'view' | 'edit'`**（core + `slots.tsx` 镜像同步）——宿主从来只产出这两种，留着另外四个是**契约比实现对得宽**，插件会为永不出现的 kind 写没法被测的分支。设计真源见 [docs/design/ai-plugin-architecture.md](../design/ai-plugin-architecture.md) §8.7 / §9.1。
- **AI 插件化重构（P5 已完成）**：本批落三件事，**前两件不需要模型密钥**。
  **① 页面跳转工具**：新增 `@geewiki/ai-nav`（纯贡献者，零端点、零前端产物），贡献两条
  `side:'client'` 描述符 `open_page` / `scroll_to`——需求 ② 的后半句「也能自行找其他页」
  光有检索不够：`search_kb` 只能给出 slug，**用户还停在原地**。处理器在宿主
  `packages/web/src/lib/navTools.ts`（`registerNavTools`，由 `AppDock` 在**登录分支**里登记/注销——
  未登录却登记会让服务端看到一份浏览器其实执行不了的可调用集）。两条都**不是 `mutating`**：
  跳转与滚动改的不是数据，标了会让回退 UI 多出两条点了没反应的条目。
  **② 管理台工具**：新增 `@geewiki/ai-admin`（纯贡献者），贡献 `plugin.list` /
  `plugin.read_config` / `plugin.set_enabled` / `plugin.set_config` 四条服务端工具，
  **仅所有者/管理员可见**（两层：`available` 不进工具表 + 执行体再拒一次）。
  它是 `checkSelfLock` 的**第一个真实消费者**，而**顺序即语义**：护栏必须在**调用管理器之前**
  跑完——`page.update` 可以"先写后记"，但**停用一个插件不是**（当场生效且没有逆操作，
  等 `journal.record()` 来拦就晚了，它只会拒绝**记录**）。自锁名单因此从四个扩到**五个**，
  新增 `@geewiki/ai-admin` 自己：它**不在助手的依赖链上**，但停了它，AI 就
  **再也没有能力把任何插件开回来**——这份常量的判据从来是「AI 还有没有下一次机会」，
  不是"依赖链"这个机制（决策 19）。**回退执行体也过自锁**：名单会扩容，
  一条历史记录不该成为绕过当前红线的通行证。
  **③ 知识库之外的显著标注**（需求 ⑥ / 决策 4）：工具结果新增 `grounding?: 'kb'`
  （`AiToolResult`），会话核心据**逐次返回**算出 `grounded` 随 `done` 帧下发，界面渲染
  「这不是知识库内容」的琥珀色标注。判据**挂在返回值上而不是描述符上**——
  `search_kb` 0 命中时它跑了却一个字都没给模型；按描述符声明的话，模型凭先验知识写的答案
  会**不带任何标注**地显示出来。`list_pages` 同理刻意不声明（目录信息不是资料）。
  另外两条必须记住的边界：**只有 `side:'server'` 的工具能贡献它**（客户端工具的结果由浏览器
  直接回灌，服务端看不到 `AiToolResult`）；**一次提问的多个 HTTP 回合必须取或**——
  第二个回合的服务端看不到第一回合执行过的工具，只看最后一回合会把"先 read_page 再改编辑框"
  这种最常见的用法**全部误标**。标注**渲染在正文之前并随会话落盘**（刷新一次就消失的警告
  比没有警告更坏），且系统提示里原来那句"你必须先说明这不是知识库内容"**已删除**——
  留着会双重标注，两句话不一致时用户不知道该信哪句；现在的分工是
  **模型只管把答案说好，标注由代码保证**。
  **④ §0.2 的判据终于落地**：`@geewiki/ai-assistant` 新增
  `REQUIRED_TOOL_NAMES = ['search_kb']`，`GET /api/ai/assistant/capabilities` 的
  `available` 与 `POST /api/ai/turn`（**写 SSE 头之前**返回 `503 tools_unavailable`）
  都要求必需工具集齐全。理由就是 §0.2 那条：停掉 `@geewiki/ai-kb` 会让助手
  **静默变成通用聊天机器人**——它照样流畅地回答，只是答案不再来自知识库。
  **⑤ 顺带修掉一个 P4 遗留的真缺陷**：`DoneData.mutatingTools` 声明了、服务端一直在发，
  而 `parseTurnEvent` **从没读它** ⇒ 恒 `undefined` ⇒ 消费者按"一个写工具都没有"处理 ⇒
  **`recordClientMutation` 一次都没被调用过**：编辑框的改动从来没进过日志，也就从来不可回退。
  整条链路不报错、类型全对、P4 的 33 条判据也全过（那个脚本走 journal HTTP 端点，
  不经过这个解码器）。**漏读一个必填字段消费者会当场炸，漏读一个可选字段则什么都不会发生**
  ——只有"服务端 done 帧的每个字段都必须在客户端被解析"这条守卫能发现它，已随修复落地。
  **本批实测**（`node --import tsx scripts/acceptance/p5-nav-admin/run.ts`，**全部通过，含真实上游**）：
  工具表 9 条（4 管理台 + 3 知识库 + 2 跳转）；伪造的客户端工具名**不进交集**；
  非管理员看不到任何管理台工具；自锁拦住五个节点且**五个全部仍在活动**；
  停用 `@geewiki/echo` 真的生效并留下 `recordId=1`；基础层插件被拒且提示去处；
  知识库**外**的问题 `done.grounded === false`、知识库**内**的 `=== true`。
  **读数**：全仓 `pnpm test` **1774/1774 绿**（**22 个包全部 `# fail 0`**）、
  `pnpm typecheck` **作用域 25 个项目全部 Done、0 个 `error TS`**、`packages/web` build 通过；
  内置插件注册表 **20 个**、默认基础层清单启用 **18 条**（新增 `ai-nav` / `ai-admin`）；
  UI 产物 `ai-assistant/client.js` **33.73 kB（gzip 10.76 kB）**、`client.css` 5.00 kB。
  **上文所有更早的"15 / 17 个内置插件""启用 11 / 13 条""1478/1590 测试"读数均已被本段取代**，
  它们记录的是各批次当时的口径，保留以存史。设计真源见
  [docs/design/ai-plugin-architecture.md](../design/ai-plugin-architecture.md) §8.10。
- **AI 插件化重构（P6 已完成）**：需求 ③④ 落地——**每篇文章自动生成摘要、按摘要检索、
  以折叠卡显示在文章最上方**。新增第六个 AI 插件 `@geewiki/ai-summary`（`plugin-ai-summary/`），
  以及平台层的两样新东西：**第七个插槽 `article-summary`**（单占用，props 只有
  `{slug, title}`）与**第二个平台事件 `PAGE_SAVED_EVENT`**。
  **触发链**：`@geewiki/wiki` 在 `savePage` 的**事务提交之后**用 `ctx.emit`（同步、不等待）
  广播保存事件；订阅者必须自己吞异常、自己去抖——保存的成败与快慢**不得**取决于一个模型调用
  有多慢（与 `CACHE_PURGE_EVENT` 的"不等待就等于没清"恰好相反）。`unchanged` **不广播**；
  **负载里刻意没有正文**（事件是广播，所有订阅者都收得到）。
  **摘要按哪一份正文写**（本批最需要说清的裁决）：按**页面自身档位**对应的投影写，且只对
  `public` / `org` 两档写——`effectiveIndexLevel` 为 `null` 的页面（`private` / 仅逐人授权）
  **不生成摘要**。用"某个真实用户"的身份去读会让**摘要的保密性**依赖"读路径将来不放宽"，
  而那是一条迟早会松的依赖；失败关闭。组织档用的是 `userId: 0` / `orgRole: 'member'` 的
  投影主体（该组织里**权限最小**的那种成员，owner/admin 有应急覆盖会读到更多）。
  **过期用内容哈希判、不用时间戳**：两者都只到毫秒，而"保存完立刻生成"很常见 ⇒
  时间戳方案会让**刚生成的摘要随机地被标成过期**；哈希顺带把"内容没变但行被更新过"正确判成没过期。
  **按摘要检索有意不走 FTS5**（一页一条、上限 300 字符 ⇒ `LIKE` 扫描 + JS 精排）：
  这样**方言中立**（PG 上照样工作，不需要 `@geewiki/search` 那种"非 sqlite 直接抛错"的守卫），
  代价（条目到十万量级要换真索引）记在迁移文件里。片段取 **2-gram**（那一边的 3 是 FTS5
  `trigram` 的硬限制，这里走 LIKE、长度自己定；中文的关键概念常是两个字）。
  **摘要必须长得像提问**：系统提示明写"把关键概念连同同义的说法都写进去"，因为本仓探针实测过
  同一个问句对**真实正文**检索 `total=0`、对一段自然语言概述 `total=1`。
  **折叠卡**：新插槽 `article-summary`，渲染在 `<h1>` **之前**（"文章最上方"的字面要求），
  用原生 `<details>`/`<summary>`（折叠语义与读屏播报交给浏览器），
  **`available === false` ⇒ 整张卡片不渲染**——一张永远转不出结果的折叠卡会让读者
  **学会不再看摘要**，连带真有摘要的页面一起被忽略；因为这条只存在于一个 if 分支里
  （没有任何可观测产出），行为测试抓不到"改成显示『暂不可用』"，故由 `pluginUi.test.ts`
  按源码钉住。bundle 只有 **3.70 kB（gzip 1.51 kB）**。
  **本批实测**（`node --import tsx scripts/acceptance/p6-summary/run.ts`，**全部通过，含真实上游**）：
  保存一页 ⇒ 摘要**自动**落库（事件 → 去抖 → 真实上游，`model=DeepSeek V4 Flash`、`audience=org`）；
  改正文 ⇒ 去抖窗口内 `stale:true` 且**旧摘要仍在**；去抖过后自动重算回 `false`；
  自然语言问句「怎么做回滚演练」按摘要检索 `total:1` 命中（而这三个字正文里一个都没有
  ——模型把「回滚、回退」「部署、发布、上线」都写进了摘要）；
  匿名读组织内页面的摘要 **404**、匿名重算 **401**；
  第二个实例（基础层里没有 `llm`/`openai`，即**默认部署的样子**）`available:false` + 一句原因、
  匿名 POST 401（权限先于模型）、登录后 POST **503**。
  **读数**：全仓 `pnpm test` **1817/1817 绿**（**23 个包全部 `# fail 0`**）、
  `pnpm typecheck` 作用域 **26 个**工作区项目全部 Done、0 个 `error TS`；
  内置插件注册表 **23 个**、基础层启用 **19 条**。
  **上文所有更早的"20 个内置插件""启用 18 条""1774 测试"读数均已被本段取代。**
  设计真源见 [docs/design/ai-plugin-architecture.md](../design/ai-plugin-architecture.md) §8.11。
- **AI 插件化重构（P4 已完成）**：新增**两个内置插件**，都进默认基础层清单（启用 14 → **16** 条）：
  - **`@geewiki/ai-journal`**（`packages/plugin-ai-journal/`，`provides: 'ai-journal-service'`）——AI 变更日志与回退。
    一张表 `ai_mutations`（自带迁移 `0001_ai_mutations.sql`）+ 四个端点（`POST/GET /api/ai/journal`、
    `POST /api/ai/journal/undo`、`POST /api/ai/journal/undo/ack`），全部**要求登录主体**（匿名 401）。
    回退粒度是 `turnId` = **一次用户提问**（不是一次 HTTP 回合），由客户端生成并透传。
    `requires: ['http-service', 'database-provider']`——**刻意不依赖 llm / ai-tools**：它是被工具调用的下游，
    反过来依赖调用方会成环。撤销执行体**按域注册**（`registerUndoer(owner, domain, handler)`），
    journal 自身**不认识任何业务域**（认识业务域就变成第二个 wiki，两份判据必然漂移）。
  - **`@geewiki/ai-pages`**（`packages/plugin-ai-pages/`，纯贡献者）——本仓**第一条 mutating 工具** `page.update`。
    `requires: ['ai-tool-service', 'wiki-service', 'policy-service', 'ai-journal-service']`。
    **`wiki-service.save()` 不带主体**（授权在 HTTP 处理器里），所以工具必须自己向 `policy-service`
    要一次 `resolvePage(p, slug).canEdit`——`policy-service` 是那份判据的唯一出口，不是"又抄了一份"。
    **已知结构性风险（记档未修）**：判据与写入是两次先后调用，中间有竞态窗口；彻底修法是给
    `wiki-service` 加接主体的写方法 `saveAs(principal, slug, input)`。
    **写工具的两条硬纪律**：① 拿不到轮次标识就**拒绝动手**（"记不下来就别改"，决策 3）；
    ② 内容没变就不写、也不记日志（不留一条点了没反应的可回退条目）。
- **工具契约因此变了一次**（P4）：`AiToolHandler` 加**必填**第三参 `AiToolContext { conversationId, turnId }`
  ——原来的 `(principal, args)` 让执行体根本不知道自己在哪一轮，而写操作的日志必须回答这个问题，
  否则所有变更只能塞进同一个"未知轮次"，"回退到这一轮之前"就没有落点。
  只读工具显式忽略它（参数名写 `_context`）：**"忽略"必须是一个写下来的决定，而不是一次遗忘**。
  `TurnRequest` 相应接收 `conversationId` / `turnId`（**线上格式里可选**：只读问答不需要它们），
  dock 逐句生成 `turnId` 并以**参数**（不是 state）传进 `runTurn`——`setState` 是异步的，
  用 state 会让第二句用上一句的轮次，把改动记进错的那一轮且**不报错**。
- **本批实测读数**：全仓 `pnpm test` **1656/1656 绿**（**20 个包全部 `# fail 0`**；较 P3 的 1590 增 66 =
  `plugin-ai-journal` 49 + `plugin-ai-pages` 16 + `plugin-ai-assistant` +1）、`pnpm typecheck` **23** 个 project 全 Done。
  journal 的用例集跑的是**真 better-sqlite3 临时库 + 真迁移**（含 `WHERE undone_at IS NULL` 的部分索引），
  不是内存假库。另有一条既有守卫当场生效：`packages/server/test/builtin-migrations.test.ts` 抓到
  "manifest 声明了 `migrations` 而注册表没给 `migrationsDirs`"。
- **仍未做**：`page.update` 之外的页面管理工具（建页 / 删页 / 改可见性，归 P5 的 `ai-admin`）。
- **✅ 已在 P4 尾补完：回退 UI + 一条可见性红线 + 端到端验收**（设计真源 §8.9）。三件事：
  - **回退入口**（`packages/plugin-ai-assistant/ui/index.tsx`）：对话区**每一轮一个**「回退到这一轮之前」，只列还没撤干净的轮次；结果说明里**逐条列出没撤的原因**（只报"回退成功"的界面等于说谎）。写操作的判定权在**服务端**——`done` 帧新增 `mutatingTools`（按描述符的 `mutating` 算），因为浏览器手里只有名字，让它去猜就是第二份会漂移的判据。草稿的记录是**观察式**的：dock 在客户端工具调用前后各读一次正文，真变了才记一条 `editor` 域日志（读工具不会产生记录，也就不会误撤用户自己的输入）。
  - **冲突检测改为"探针优先于客户端自报"**。第一版把"现在是什么"完全交给浏览器——而回退请求也来自浏览器，于是一份过期的快照就能把别人的编辑静默覆盖掉。新增 `MutationProbe`（按域注册）：`page` 域由 `@geewiki/ai-pages` 注册、走**带编辑权判据的原文读路径**；`editor` 域没有探针（草稿在浏览器里），调用方自报是唯一来源，不自报就按**冲突**处理（"不知道" ≠ "没变过"）。
  - **一条权限红线**：AI 的"读-改-写"会把 `<!--gated:org-->` 受限段落**静默变成公开**（投影把标记吃掉 ⇒ 整篇写回时标记没了 ⇒ `blocks` 重算成 public）。修法是判据收进 `wiki-service` 内部（`wantRaw` 必须同时看调用方要什么**与** `canEdit`），加上 `gatedRewriteRefusal()` 的**结构护栏**（比结构不比内容：允许改区段里的文字，拒绝改变"哪些内容受哪种限制"）。
- **一个单测全绿、端到端才抓到的真缺陷（值得记档）**：`svc.get = async (slug, principal) => getPage(slug, principal)` —— 接口上加了 `rawContent`、`getPage` 里也实现了，**唯独这个包装层只转两个参数**。于是**跨插件调用方（`read_page` / `page.update`）永远拿到投影正文**，而 HTTP 路径照常拿到原文；两条路径行为不一致**且不报错**。抓到它的是 `scripts/acceptance/p4-undo/run.ts` 的第一次运行，不是任何一条单测。守卫已补（`packages/plugin-wiki/test/rawContentGuard.test.ts`）。
- **端到端验收**：`node --import tsx scripts/acceptance/p4-undo/run.ts`（**不需要模型密钥，因此不做 SKIP**——回退是存储与事务的事）**33 条判据全过**：回退到某轮之前（正文逐字还原）、重复回退不重复执行、**他人改过即拒绝**、**客户端谎报"没变过"仍然拒撤**（反向对照证明不是"一律拒绝"）、没有编辑权即拒（换成有权限的主体后同一条能撤）、`editor` 域交回浏览器 + `ack` 单独一趟、自锁护栏。**一条踩到的机件事实**：读者的正文来自 **`blocks` 表**而不是 `pages.content`（`projectPageContentFor` 优先用块，只有该页一块都没有时才回落解析正文），所以"模拟别人改一页"必须走 `wiki.save` —— 直接 `UPDATE pages SET content` 的后果是"库里变了、读者看不到"，本脚本第一版因此假红过。
- **两条"安静地不对"的坑（回退 UI 初版）**：① 服务端 `TurnGroup.pending` 是**条数**不是数组，初版写成数组 ⇒ `pending.length` 恒为 `undefined`，**回退入口一个都不显示且不报错**（条目在 `records` 里）；② journal 的 `MutationInput.owner` **必填**，初版漏了 ⇒ `400 invalid_body`，表现是"编辑框的改动没进日志"。
- **读数（P4 尾实测）**：全仓 `pnpm test` **1696/1696 绿**（**20 个包全部 `# fail 0`**）、`pnpm typecheck` **23** 个 project 全 Done；`ai-assistant/client.js` **30.50 kB（gzip 9.55 kB）**。
  自锁护栏（`checkSelfLock` / `PROTECTED_AI_NODES`）已实现并接在 journal 的记录路径上
  （受保护节点 ⇒ **403 `protected_node`**，不是 400），但**启停工具本身要到 P5（`ai-admin`）才存在**。
  设计真源见 [docs/design/ai-plugin-architecture.md](../design/ai-plugin-architecture.md) §8.8。
- **尚未实现 / 已知限制**：**Phase 3 余项（本批逐条实测后真正仍未落地的）**——`admin-page-slots` 扩展点（仍为候选；**同批候选里的 `editor-toolbar-slots` 已落地**，本批以 `editor-toolbar` 之名进白名单并由 `@geewiki/ai-writing` 消费，故不再是候选）；**第三方编辑器组插件**（Milkdown / TipTap）——`editor` 插槽目前只有内置 `@geewiki/editor-plain`（纯 `<textarea>`）一个真实消费者；**其它厂商 LLM adapter**（Anthropic 等）——目前只有 OpenAI 兼容一个；**向量 / 语义检索**（有意后置）。**Phase 4 的 PostgreSQL 适配已不再是"未实现"**：`packages/db-postgres/`（包名 **`@geewiki/postgres`**，**不是**旧文里的 `@geewiki/db-pg`）已实现异步适配器并登记进内置注册表，`@geewiki/wiki` 也已适配异步 `DatabaseAdapter`；但它**默认不启用**，且与 `@geewiki/search` **不兼容**（见下方 ⑬）。**本批同时从前一版删除的已落地项**（均实测复核）：LLM 厂商 adapter、`editor` 插槽链路、插件级子目录静态资源、后端 `ctx.slot()` 注册链路、PostgreSQL 适配、SSE 流式输出。**检索与问答侧的边界另见下条 ⑥–⑫。** 另有 **16 条已知限制**：① **Slot 仍无 Suspense + use Hook 懒加载**——远端 bundle 仍由加载器显式 `import()`（`packages/web/src/lib/pluginUi.ts:241`），"不白屏"靠 ErrorBoundary 而非 Suspense Fallback；且 **ESM 模块实例不回收**——`rev` 变化走 unload → load、同一 URL 命中模块缓存，故**插件产物更新后需整页刷新才生效**（`packages/web/src/lib/pluginUi.ts:45-46`、`:88`，刻意的取舍）；插件 CSS 以 `<link data-plugin-ui=…>` 全局注入、**不做样式隔离**（`:217`；示例夹具以 `.gw-fixture-*` 前缀命名类名作为约定示范，宿主侧无强制手段）。**注意两条路径不是一回事**：插件**入口与样式名**仍必须是**单段文件名**（`client.entry` / `client.css`，校验用 `PLUGIN_UI_FILE_SEGMENT`），但 bundle 内部引用的**子目录资产已能经服务端取到**（`PLUGIN_UI_ASSET_PATH`，见上方「前端 Slot」一节）；② **排空粒度仍是全站**在途 HTTP 请求，非 owner 级——`packages/server/src/index.ts:272` 的注释明示"按插件（owner）粒度排空属于后续工作：当前不做请求来源归属，一次卸载会等待所有插件的在途请求"；**但长连接（SSE）已按 owner 分组定向回收**（`activeStreams` 按 owner 分组 / `trackStream(res, owner)` / `closeStreams(owner?)`），故插件级卸载不会漏收自己开的流；③ 密码字段的脱敏**只覆盖表单输入框的呈现**——`meta.role: 'password'` 已渲染为 `type="password"` + `autoComplete="new-password"` 输入框，但 `GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（config 是普通 JSON 字段，不在传输层做脱敏）。**本批实测**：对 `@geewiki/postgres` 发 `PUT /api/plugins/%40geewiki%2Fpostgres/config` body `{"config":{"password":"PLAINTEXT_TEST_SECRET_123"}}`，响应体即**回显该明文**，随后 `GET` 该端点**原样回读**；再调 `POST /api/session/persist`，该明文**落进入库的 `config/plugins.base.json`**；④ 浏览器侧验收脚本 `scripts/acceptance/plugin-ui-cdp.mjs` 与 `scripts/acceptance/ai-split-e2e/cdp-ui.mjs`（零依赖，Node 内置 WebSocket + 直连 CDP）**刻意不接入 `pnpm test`**——它们需要 Chrome、一个运行中的实例与已构建的插件产物（后者还多一个前置：**必须先 `pnpm --filter @geewiki/web build`**，`packages/web/dist` 是上一版时测的是旧宿主，症状是"没有 `[data-slot="wiki-ask"]`"这种假产品缺陷）；且其**实测只在 Chromium 上进行**（import map 的浏览器基线为 Chrome / Edge 89+、Safari 16.4+、Firefox 108+，本项目不提供降级路径）；⑤ `packages/web/tsconfig.json` 的 `types` 同时含 `vite/client` 与 `node`（为让 `test/*.test.ts` 通过类型检查），因此**若在 `packages/web` 的源码里误用 Node API，类型检查不再拦截**；⑥ **默认部署下没有可用 provider ⇒ 问答与辅助写作明确不可用**——`llm-service` 注册了恒不可用的兜底路由 `null`（`packages/plugin-llm/src/service.ts:50-52`），`@geewiki/openai` **现已默认启用**（在 `config/plugins.base.json` 里）但仍需运维在外部备好凭据，所以开箱状态下两条路由都是 `available:false`。**后果的口径本批改了**：问答返回 **503 `model_unavailable`**、辅助写作返回 **503 `mode:'unavailable'` + `text:null`**，不再有 `retrieval-only` 抽取式摘要那条「看起来像答案」的路（裁决与理由见上方 AI 两条与 [docs/design/ai-plugin-architecture.md](../design/ai-plugin-architecture.md)）。**「未做真实模型链路验证」这条限制已摘除**：本批用**确定性假 OpenAI 兼容上游**跑通 rag 生成、429、空产出、0 命中四条链路并留下读数（`data/verify/ai-split-e2e/result-backend.json`：`B_ask.mode=rag` 且答案逐字等于模型输出、`B_ask429=502/RATE_LIMIT`、`B_askEmpty=502/PROVIDER_ERROR`、`B_askNoContext=200/no-context/模型未被调用`）；**仍未核实项只剩「接真实厂商」**（真凭据下的行为与假上游一致属合理外推，但没有实测过）；⑦ **流式（SSE）已交付，但超时/取消是"插件自管"而非"宿主通用能力"**——`POST /api/ai/stream`（`packages/plugin-ai-qa/src/index.ts:931`）以 `event: status | delta | done | error` 逐帧下发（事件名常量在 `packages/plugin-ai-qa/src/sse.ts:49-52`），增量解析与渲染现在也在插件里（`packages/plugin-ai-qa/ui/sse.ts` + `ui/index.tsx`，经 `wiki-ask` 插槽插入宿主）；出口机制同前（`HttpRouterService.trackStream?()` 登记的长连接**不参与排空计数**、`RouteHandlerContext.noteStatus?()` 只记指标不结束响应、teardown 走 `unprovide()` → `closeStreams()` → `await drain()` → `server.closeIdleConnections?.()` → `server.close()` 五步主动收流，提交 `2273006`）。**硬超时 / idle 超时 / `res.on('close')` 取消上游三件也都已落地**，但实现位置在 **`@geewiki/ai-qa` 内部**而非宿主层：`packages/plugin-ai-qa/src/index.ts:769-771` `idleMs` / `hardMs` / `onTimeout: () => ac.abort()`、`:784` `h.res.on('close', …)`（客户端断开即 abort 上游）、`:863` 超时日志，常量 `STREAM_IDLE_TIMEOUT_MS = 30_000` / `STREAM_HARD_TIMEOUT_MS = 120_000` / `MAX_CONCURRENT_STREAMS = 4`（`packages/plugin-ai-qa/src/sse.ts:38` / `:30` / `:46`）且**刻意不进 `configSchema`**（只留测试注入口）。**本批另把一条口径钉死：所有前置判定（401 / 400 / 429 / 503，含检索不可用）一律在写 SSE 头之前以普通 JSON 返回**，流内只表达「已经开始生成之后」的事——`firstIsStatus` 因此是结构保证而非约定（`stream.test.ts` 里两条守卫分别钉「检索不可用走 JSON 503」与「现存全部流路径的首帧都是 status」）。⇒ **真正仍缺的是宿主级的通用长连接治理**：`@geewiki/http` 不提供任何通用超时/背压/心跳，每个要写流的插件都得自己实现这一套（`trackStream` / `closeStreams` 只解决"卸载时收得掉"，不解决"卡住时断得开"）。**一处务必记档的实测结论**：**不要**用"先 `res.writeHead(200, {'content-type':'text/event-stream'})` 再 `h.json(200, null)`"去"只记一次指标"——`writeHead` 后 `res.headersSent` 立即为 `true` 而 `writableEnded` 仍为 `false`，`json()` 会跳过 `writeHead` 却**仍无条件执行 `res.end(JSON.stringify(body))`**，给事件流追加字面 `null` **并立即终结流**（实测客户端正文 `event: status\ndata: {"type":"status"}\n\nnull`）；正解是用 `noteStatus()`。另注：`closeStreams()` **不在 `HttpRouterService` 接口上**，它是 `HttpRouter` 具体类的实现细节（`packages/server/src/index.ts:222`），其他包经 `ctx.get('http')` 拿不到它。详见 [docs/architecture.md](../architecture.md) §5.1.1；⑧ **向量 / 语义检索未做（有意后置）**——离线 + 零重依赖前提下不现实（本地 ONNX 需预烤模型与 ORT WASM 运行时），当前只留接口位，检索是**纯字面**匹配（FTS5 trigram + LIKE 兜底），因此**同义改写、跨语言、模糊表述都搜不到**；⑨ `snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`）⇒ 前端**不得二次转义**（否则显示成字面 `&lt;mark&gt;`），也**不得**当纯文本插入页面；`score` **只在同一次查询内可比**（非归一化、值域无界，跨查询与跨 `mode` 比大小无意义）；⑩ **wiki 下有 4 个保留首段**——`search` / `ask` / `new` / `list` 都不能再作页面 slug 的首段（前端镜像 `packages/web/src/lib/wikiRoute.ts:31` 的 `WIKI_RESERVED_FIRST_SEGMENTS`，后端有 `RESERVED_FIRST_SEGMENTS` 与之对齐并有守卫测试）；**旧文只列 `search` / `ask` 两项，本批订正为 4 项**；⑪ **密钥**——统一配置里的 `apiKey` 是 `role: 'secret'` 字段：**写一次、不可回读**，值落在 gitignored 的 `config/secrets.json`（0600），任何响应都不回显（`GET /api/plugins/:name/config` 只回 `secrets: { apiKey: true }`）；也可改用 `apiKeyEnv` 走环境变量（界面填写的优先）。**边界如实记录**：`config/secrets.json` 是**明文**文件，威胁模型与同目录的 SQLite 库一致——能读宿主机文件系统的人就能读到密钥；要更强就用环境变量注入。`GET /api/plugins/:name/config` 对**普通配置字段**仍**明文返回**（该边界见 ③）；**但务必注意 `@geewiki/postgres` 的 `password` 是明文密码字段**（与 `passwordEnv` 并存，schema 自述"仅本地开发；生产请改用 passwordEnv"），它会明文落进入库清单——**生产请只用 `connectionStringEnv` / `passwordEnv`，把值放进环境变量**；⑫ `@geewiki/llm` 的 `redact` 是**启发式**——未覆盖的密钥形态不会被脱敏（宁可漏判不可误伤，全大写 SNAKE 命名一律放行，见 `packages/plugin-llm/src/redact.ts` 的 `UPPER_SNAKE_NAME` 主动豁免），且 `text-delta`（模型输出）**刻意不脱敏**（`packages/plugin-llm/src/service.ts:107`，脱敏会篡改模型输出内容）；**该启发式已不再用于配置校验**——`apiKeyEnv` 改用 `credentials.ts` 的白名单 `isEnvVarName`，因为黑名单对 `a1b2c3d4e5f60718293a4b5c6d7e8f90`（32 位 hex）、`ABCDEF1234567890ABCDEF1234567890`（全大写 32 位）、`Xk9mQ2pLvR4tN8w`（16 字符混合）三种随机密钥形态**一条都拦不住**；⑬ **PostgreSQL 与全文检索不兼容**——`@geewiki/search` 的索引建立在 SQLite 专有的 FTS5（`tokenize='trigram'`）之上，**PG 没有 FTS5**；插件在 `apply()` 里**显式抛错拒绝**而不是静默降级（`packages/plugin-search/src/index.ts:305-320`，报错原文含 `@geewiki/search: 当前数据库方言是 ${dialect}，而本插件的全文索引依赖 SQLite 专有的 FTS5（trigram 分词器），暂不支持该方言。请改用 @geewiki/db-sqlite，或等待基于 tsvector 的 PG 检索实现。`）⇒ **切到 PostgreSQL 后 `/api/search` 与 `@geewiki/ai-qa` 的问答都不可用**（问答现在会**明确 503 `search_unavailable`**，不会悄悄退化成「无来源的自由生成」）（PG 侧 `tsvector` 检索属另一个工程，本批未做）；⑭ **无真实屏幕阅读器实测**——无障碍侧只有自动化检查（对比度 / 标题层级 / 编辑区区域的可计算断言，见 `packages/web/test/contrastPlan.test.ts`、`headingPlan.test.ts`、`editorPaneRegions.test.ts` 与 `lib/contrastPlan.ts`），**没有用 NVDA / VoiceOver / TalkBack 等真实读屏软件做过人工验证**；浏览器侧端到端验收 `scripts/acceptance/plugin-ui-cdp.mjs` 同样**只在 Chromium 上跑过**（见 ④）；⑮ **开发期临时产物无清理机制**——`data/` 下堆积着历次批次的验证残留（`data/verify/` 下 25 个子目录，另有 `shots*/`、`spike/`、`a11y-*/`、`docbatch/`、`*.html` 快照、`npm-cache/` 等），**没有任何清理脚本或定期回收**；`data/` 已被 `.gitignore` 排除、不影响仓库体积，但会持续占用本机磁盘；⑯ **实时渲染是"就地渲染"，不是渲染器**——能渲染的：**行内标记与图片**，以及**整块**的表格 / 围栏与缩进代码块 / 整块 HTML（`HTMLBlock`）/ 分隔线（内容走阅读页**同一条** `mdToHtml` 管线并按 `.md-body` 复用阅读页排版，故实时渲染里看到的就是发布稿；点这些块即回到源码）；**段落内部的行内 HTML 标签**（`<span>` 这类）仍按源码显示——逐个换成 widget 会连标签之间的内容一起丢掉。**该扩展必须用 `StateField` + `EditorView.decorations.from(field)` 提供装饰，不能改回 `ViewPlugin`**：CodeMirror 禁止插件路径提供块装饰（`@codemirror/view` 的 `emit()`：`if (disallowBlockEffectsFor[index]) throw new RangeError("Block decorations may not be specified via plugins")`，判据是 facet 值 `typeof d === "function"`），改回去会在渲染表格时**直接抛异常**；块装饰的范围还必须与**行边界**对齐（`packages/web/src/lib/liveRenderPlan.ts` 的 `alignToLines()`），错开会吃掉相邻正文。**实时渲染模式下不显示行号**（软换行的段落会占好几屏、行号却只递增一次，"会撒谎"），正文里的 gated 标记不合法时**不做任何装饰**（此时该看到的是标记报错，见 `packages/web/src/components/editor/liveRender.ts`）；编辑器增强 chunk 加载失败而**降级为纯文本 `<textarea>`** 时只保留排版工具栏，**没有**模式切换、段落权限控件与撤销/重做按钮（界面上一行可见文案说明降级了什么，见 `packages/web/src/components/MarkdownEditorLazy.tsx`）。**容器镜像与 Compose 编排已可用**（多阶段 `Dockerfile` + `docker compose up -d --build`，见 [docs/deployment.md](../deployment.md)）。详见 [docs/roadmap.md](../roadmap.md) 与 [docs/plugin-platform-plan.md](../plugin-platform.md)（**注意：这两份文档的若干段落尚未跟上本批口径**）。
