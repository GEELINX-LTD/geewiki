<!--
勾选前先自己跑命令，别照抄别人的绿。
本清单每项都对应一次真实踩过的坑（见 CONTRIBUTING.md §9 / §11）。
填法：勾选项打 [x]，需要读数的地方写命令与实际输出，不要留空、不要写"同上"。
本模板不预填任何"已验证全绿"的结论——那必须是你在本分支上跑出来的。
-->

## 改动范围

- 涉及的包 / 目录：
- 是否跨包（用 `grep -rn "<被改符号>" packages plugins` 自查，命中是否超出本包）：☐ 否 ☐ 是
- 若跨包：命中的其它包，以及为什么必须一起改：
- 是否涉及架构取舍（需要写一篇 ADR，流程见 [docs/adr/README.md](../docs/adr/README.md)）：☐ 否 ☐ 是 → 编号 / 文件名：

## ⚠ 新增或改动 HTTP 路由：access 级别必须显式声明

**本模板唯一一条"漏了会静默扩大攻击面"的项，所以放最前面。**
`router.register(method, path, handler)` **省略第 4 个参数 = `access: 'public'`**，也就是未登录即可读写。

- [ ] 每条新增 / 改动的路由都写了第 4 个参数（`'public'` / `'user'` / `'admin'`）
- [ ] `auditRouteAccess()`（`packages/server/src/index.ts`，它把未声明清单聚合为**一条**告警）的输出里不含本次新增的路由
- [ ] 以 `GEEWIKI_STRICT_ROUTE_ACCESS=1 pnpm start` 启动，日志无「未声明 access 级别」告警
- [ ] 若有意新增 public 端点：在下方「需要评审人注意的点」单独写一段说明（否则默认按「漏了鉴权」处理，会被要求补）

## 本地门禁（贴命令与实际输出，不要只打勾）

```
pnpm lint        # eslint . --max-warnings 0：警告也算失败
pnpm typecheck   # 全工作区；不带 --filter
pnpm test
```

- [ ] `pnpm lint` 通过（有 warning 就是失败）
- [ ] `pnpm typecheck` 通过；**注意盲区**：`tsconfig.scripts.json` 有意排除 `scripts/acceptance/`（那些是一次性验收 runner，首跑有 16 处既有错误，至今未纳入检查）——改动落在里面时类型门禁**不会**报你，只能自己跑 `tsc` 或直接实跑
- [ ] `pnpm test` 全绿。测试文件数现算，别照抄任何文档里的数字：
      `find packages plugins -name '*.test.ts' | wc -l` = ______
- [ ] 新增行为带回归用例；纯重构在下方写明「不需要新测试」的理由
- [ ] `git status --porcelain config` 为空（`config/` 全部 gitignore，配置不进 git）

## 涉及数据库（建表 / 加列 / 索引）

- [ ] 同一变更在 `packages/db-sqlite/src/migrations/` 与 `packages/db-postgres/migrations/` **成对新增**
- [ ] `pnpm --filter @geewiki/manager test` 通过——其中 `migrations-dialect.test.ts` 会抓「只加了一边」；加列类迁移的重放由 `packages/plugin-wiki/test/slug-hierarchy.test.ts` 的 `isAddColumn` 分类处理
- [ ] 需要真库的双向迁移：`GEEWIKI_E2E_PG=1 pnpm --filter @geewiki/postgres test` 的输出（**CI 没有 PG service，PG 侧一律是本地跑**，所以这里的读数只能由你提供）
- [ ] 未手写 `AFTER` / `ALGORITHM` / `LOCK` 等 MySQL-only 子句

## 涉及前端 / UI

- [ ] `pnpm --filter @geewiki/web run build:fixtures` 有输出（无输出说明 `build` 脚本被静默跳过）
- [ ] `pnpm build`（真实前端产物）+ `pnpm start` 后用 `scripts/acceptance/*.mjs` 验过（**零依赖 CDP 脚本，不是 Playwright**；需要本机 Chrome 开 `--remote-debugging-port`）
- [ ] **dev(5173) 与 prod(3000) 各跑一遍**：Vite dev 的 `?import` 重写只在 dev 生效，只跑 dev 的通过说明不了生产可用
- [ ] 未新增 npm 依赖（UI 依赖会进外部插件 bundle；确实需要 → 写进「取舍与替代方案」并说明代价）
- [ ] 未把可下沉 core 的跨层契约留在 web（INV-12）
- [ ] 改了交互 / 视觉：附截图或录屏
- [ ] 截图 / 复制 / 导出类：同一渲染逻辑不写第二份实现（「单一真源」纪律；同一纪律在权限判定侧的表述见 `docs/design/attachments.md` 的 G3）
- [ ] 涉及加载 / 就绪 / 错误态：每种状态各给一次读数（成功 / 加载 / 空 / 失败 / 无权限），**不写「已验证全绿」**；前端结论按 `docs/development.md` 的口径标注——「门禁没覆盖 ⇒ 结论默认未验证」，没跑过真实浏览器就写「未在真实浏览器验证」

## 涉及 AI（提示词 / 工具 / 上下文组装 / 流式）

- [ ] `pnpm --filter @geewiki/ai-journal test` 通过——但要知道它的边界：该包只有 `plan.test.ts` / `plugin.test.ts` 两个**单测**，**仓内没有跑真实模型的自动化 e2e**，所以「CI 绿」证明不了模型行为
- [ ] 改动真的打到线上模型行为时：给**人工读数**（请求 / 响应 / journal 记录任选其一，能看出判断依据的那种），并如实写是否产生费用
- [ ] 改了注入路径 / 工具契约：按 [docs/design/ai-plugin-architecture.md](../docs/design/ai-plugin-architecture.md) 的 **§7「影响面清单（改这些，别漏）」**逐项核对
- [ ] 改了提示词或工具清单：journal 里能看到「为什么这么做」——记录的是判断，不只是结果
- [ ] 未绕过冲突组 / 工具注册表去直接调某个厂商的模型

## 涉及配置

- [ ] 新增配置项同步写进 `config/plugins.base.example.json`；**默认值变更在「取舍与替代方案」里单独写一句**（管理员磁盘上的旧配置不会跟着变）
- [ ] 密钥类字段只用 `meta.role === 'secret'`（落盘 `config/secrets.json`，0600）；**`git diff` 不含明文**、响应里只回「是否已配置」
- [ ] `apiKeyEnv` 填的是**环境变量名**，不是密钥值（填错会把密钥原文写进 config JSON 并出现在 GET 响应里）

## 文档

- [ ] 行为 / API / 配置 / 目录结构变化同步了对应文档，**不只是代码注释**
- [ ] 文档地图（[docs/README.md](../docs/README.md)）与实际文件树一致；新增 / 改名 / 删除文档同步全仓引用
- [ ] 新增事实文档填了「最后核查」与取数方式；写进文档的具体读数都带命令
- [ ] 没有新增会腐化的硬编码计数（包数 / 测试数 / 行号）
- [ ] README 与 `docs/` 有实质不一致时一并改正（发现即修，见 `docs/agent/conventions.md`）

## 是否需要 ADR

- [ ] 需要：换依赖 / 换框架 / 改数据模型 / 改权限模型 / 改公开 API / 引入或取消构建步骤 / **新增一类对外行为**——一篇 ADR 对应一个决策，写完把编号填进上面的「改动范围」
- [ ] 不需要：加功能、修 bug、纯重构、文档、依赖小版本升级
- [ ] 破坏性变更（含「权限声明从展示变成约束」）已按 [docs/plugin/compatibility.md](../docs/plugin/compatibility.md) 的版本政策登记 major；发布说明在**打 tag 时**由 `gh release create --generate-notes` 生成（**本仓没有根 `CHANGELOG.md`**；`docs/changelog/implementation-log.md` 是历史日志，不是当前口径）

## 取舍与替代方案

写你考虑过但放弃的方案，以及为什么。**不写不等于没得选**——评审人问「为什么不 X」而 PR 里没写，就会来回多一轮。

-

## 已知风险与遗留

显式列出你知道但没在本 PR 处理的问题，每条给证据（文件 + 符号名）与「为什么这次不做」。没有就写「无」。

-

## 需要评审人注意的点

-
