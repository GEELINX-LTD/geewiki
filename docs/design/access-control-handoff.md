# 访问控制实现进度与交接

> **本文件是状态交接，不是设计说明。** 设计与规格看 `docs/design/access-control.md`（v7，2077 行）。
> 用途：让下一任（人或 agent）能在不看历史对话的情况下接手剩余工作。

## 一句话状态

**P0 / P1 / P1.5 / P2（M1–M4，M5 部分）已实现并合入 `main`（`cfdafd0`）。
P3a–P3d（块级模型）与 P4（审计与运维闭环）一行代码都未写。**

## 对照最初的四项需求

| # | 需求 | 状态 |
|---|---|---|
| 1 | 权限管理 | ✅ 完成 |
| 2 | 团队/组织管理 | ✅ 完成 |
| 3 | 部分条目**或条目中的内容**需权限才能显示 | ⚠️ **条目级 ✅；内容级（块级）❌ 未做** |
| 4 | 未登录进站应有主页面 | ✅ 服务端门户 `/portal` 完成；⚠️ 前端导航能力驱动未完成 |

第 3 项的"条目中的内容"就是 P3a–P3d。第 4 项的前端部分见下方「P2 M5 剩余」。

## 已合入的提交

```
cfdafd0  merge(privacy): P2-M5（部分）能力下发、按钮条件化与真实 404
f2a876e  test(auth): e2e-p1 的两条断言按 P2 后的行为更新
fd785fd  test(oidc): 夹具改为加载全部迁移
c126e27  merge(privacy): P2 组织/团队与条目级可见性（M1–M4）
d048e2b  merge(oidc): P1.5 OIDC 双通道
40f63fd  docs: 设计文档 v7
f3990a9  merge(auth): P1 身份与登录
e708814  merge(security): P0 路由鉴权骨架
```

各阶段交付内容的详细清单，见对应的 merge 提交信息（每一个都写清了落地内容、验证证据、已知缺口与未验证项）。

## 验证基线（复现用）

```bash
pnpm install --frozen-lockfile        # 主工作树默认没有 node_modules
pnpm typecheck                        # 预期 exit 0（17 个包）
pnpm test                             # 预期 811 例全绿 / 0 失败

# 四条端到端（真实起服务 + 真实 curl，pnpm test 不包含它们）
PORT=46101 bash packages/plugin-auth/test/e2e-p1.sh      # 38/38
bash packages/plugin-oidc/test/e2e-p15.sh                # 44/44（测试内 mock IdP）
PORT=46301 bash packages/plugin-org/test/e2e-p2-org.sh   # 44/44
PORT=46401 bash packages/plugin-authz/test/e2e-p2.sh     # 34/34（SQLite）
```

**PostgreSQL 侧**：容器 `geewiki-pg-test`（`postgres:15-alpine`，`127.0.0.1:55432`，user `geewiki` / password `testpw`）。
隔离配方（**不要改仓库里被跟踪的 `config/`**）：

```
临时目录写 plugins.base.json，把 @geewiki/db-sqlite 换成
  { "name": "@geewiki/postgres",
    "config": { "host": "127.0.0.1", "port": 55432, "database": "geewiki_test",
                "user": "geewiki", "passwordEnv": "GEEWIKI_DB_PASSWORD" } }
启动：GEEWIKI_CONFIG_DIR=<tmp> GEEWIKI_DATA_DIR=<tmp> GEEWIKI_DB_PASSWORD=testpw \
      GEEWIKI_PORT=<自选> node --import tsx packages/server/src/index.ts
```

⚠️ **验收必须轮询 `/api/health` 到 `"present":true`** —— http 就绪即返回 200，但迁移可能还没跑完。
插件配置是**内联在清单文件 `enabled[]` 条目里**的（见 `packages/manager/src/index.ts:642-648` 的 `persistConfig`）。

## 剩余工作

### P2 M5 剩余 4 项（前端体验，非安全缺陷）

1. 导航改能力驱动 + 三处重复渲染合并为一处 —— 无权的「管理 ▾」**仍会渲染**
2. 侧边栏改吃可见集合
3. 命令面板动作按能力过滤
4. **红链三步态** —— 受限条目的站内链接仍会被渲染成"不存在"的红链，会让用户去创建已存在的页面。
   **这不是泄漏面**（服务端已把 `title` 裁剪为 `null`），是纯体验缺陷

### P3a —— 块模型落地 + 读路径改造 + FTS tier 切换

规格见设计文档 **§4.3 / §3.6 / §8.2 P3a**。落地要点：

- `0015_blocks.sql`：`blocks` 表含 `tier` 冗余列，**无默认值**（`DEFAULT 0` 是失败开放：漏算 tier 的块会以匿名等级进索引）
- `packages/plugin-search/migrations/0002_blocks_fts.sql`：`fts5(text, content='', contentless_delete=1, tokenize='trigram')`，**要求 SQLite ≥3.43**，且 `snippet()` 不可用
- 必须 `DROP TRIGGER` 旧的 `pages_fts_ai/ad/au`，同步改由**应用层**负责
- **两条已实测的坑**：① tier 过滤**不能写在 FTS 表上**（contentless + `UNINDEXED` 会静默返回 0 行），必须把 `tier` 冗余到 `blocks` 表上 JOIN 过滤；② **短查询 LIKE 路是独立的另一条 SQL**，必须单独改
- **本阶段的 FTS 部分仅 SQLite 适用**（设计文档 §4.3 ★v7 已逐条标注验收项）

### P3b / P3c / P3d

见 §2.3（规则 B1/B2）、§3.7（`block_grants`）、§3.5 与 §4.4（版本语义）、§8.2。
要点：`granted` 档不进等级索引（`tier` 写 `NULL`）；改权限**也必须产生新版本**；合并可见性不同的块 ⇒ 409 `block_merge_conflict`；删除已授权块 ⇒ 409 `block_grant_orphan`；旧标记 `role=editor` 必须**显式拒绝**而非静默忽略。

### P4 —— 审计与运维闭环

见 §8.1 P4 行与 §5.12。

## ★ 开工前必须先定的一件事

`§8.2` 的 **P3a 验收标准要用 `GET /api/admin/{search,blocks}/verify`**，而 `§8.1` 把这两个端点划给了 **P4**。
→ 要么把端点提前到 P3a，要么那条验收在 P3a 内无法执行。**先定这个，再开工 P3a。**

## 已知陷阱（下一任必看）

1. **`plugin-org` 与 `plugin-authz` 没有单元测试**，只有 shell e2e 脚本。e2e 是真起服务的、可信度不低，但改这两个包时没有快速回归网。
2. **PG 共享库 `geewiki_test` 已"中毒"**：里面留着先前运行创建的 owner 账号，`e2e-p2.sh` 的 PG 模式据此跳过 setup 直接登录 ⇒ 全线 401，表现为 17/20 的**假失败**。
   已备好干净库 **`geewiki_e2e_clean`**：`PG_DB=geewiki_e2e_clean GEEWIKI_E2E_PG=1 bash packages/plugin-authz/test/e2e-p2.sh` → 31/31。
3. **`plugin-search` 在 PG 上会报** `迁移失败（已回滚）: 0001_search.sql error: syntax error at or near "VIRTUAL"` —— 这是**预期行为**（插件有显式方言守卫，见 `packages/plugin-search/src/index.ts:307-320`）。
   根因是它用**裸字符串**声明 `migrations: './migrations'`（`:67`），在 `resolveMigrationsDirs` 里归入 `'default'` 键被所有方言命中。**最小修法是一行**：改成 `migrations: { sqlite: './migrations' }`。
4. **`db-postgres` 的 20 例测试是 `fakePool()` 桩测试**（`packages/db-postgres/test/postgres.test.ts:98` 起），只验 SQL 改写，**不连真库**。真正的 PG 验证必须真起服务。
5. **worktree 必须建在仓库内**（沙箱只允许写 `/root/dev/geewiki` 之内），命名 `.wt-<阶段>`。在 worktree 里干活**必须用绝对路径** —— `edit`/`write` 按会话工作区（主工作树）解析相对路径，用相对路径会把改动落错地方。
6. **派工时必须写明"你亲自写代码，禁止派发子代理/子会话/转交"** —— 会继承对话上下文的执行者（`subagent_implementer` / `subagent_general`）曾把自己当编排者转手派活，结果一行代码没写。
7. **`interrupt_agent` 只停"当轮"**，不等于停止。重派前用**文件 mtime** 确认原执行者真的停了，别用轮数判断（goal round 间隔可能只有 20–30 秒）。
8. **既有 worktree**：`.wt-p0` / `.wt-p1` / `.wt-p15` / `.wt-p2`。后三个的分支均已合入 main，可 `git worktree remove` 清理（清理后全文搜索不会再扫到重复文件）。

## 已知未完成的安全/质量项（非阻塞，但应跟进）

- `GET /api/plugins` 与 `GET /api/session` 对匿名仍会回显插件 `config`（**已由 P2 M4 处理**，此处保留以备回归核对）
- `packages/web/src/pages/AccountPage.tsx:63` 跳登录时丢掉 `link=required`，会话过期重登后确认绑定卡片不再出现（纯 UX）
- `packages/plugin-oidc/test/oidc.test.ts` 缺三块单测：`kid` 未命中强制刷新一次、`nbf` 边界、`jwks_empty` 失败关闭
- `packages/plugin-auth/src/index.ts:1278` 的 `clearLink()` 被重复调用且内部无 `writableEnded` 防护
- `MAX_VISIBLE_SLUGS = 16_000`（SQLite 3.32+ 绑定上限 32766 的一半，超限**显式抛错**而非静默截断）—— 已知的规模边界

## 未验证项（诚实清单）

- **真实浏览器交互从未验证**：所有端到端都是 curl；前端只有类型检查与守卫测试
- **多实例部署必然失败**（OIDC 流程状态存进程内，**失败关闭方向**）
- **AI 两条端点的端到端不泄漏未验**（需要 LLM 配置；单测层面已覆盖主体透传与 SSE 建连时取主体）
- **D8 存量回填没有真实对象可验**（e2e 库是空的，回填无对象可作用）
- 移动条目后权限变化、第二个账号授权后立即可见 —— 未构造
