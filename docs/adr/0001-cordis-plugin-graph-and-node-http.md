# 0001. 依赖图交给 cordis，HTTP 只留 `node:http` 一层

- 状态：`accepted`（回填：两条决策都已落地很久，作者不为「当初是否集体拍过板」编造故事）
- 记录日期：2026-09-28
- 关联：ADR-0002（运行期形态）、ADR-0007（清单与生命周期）、ADR-0009（单进程部署）

## 技术背景

一个 Wiki 的能力天然是碎片的：存储、鉴权、组织、条目、版本、附件、检索、编辑、AI、审计、运维、UI 壳……
它们要能被**拆开卖**（只跑核心 + 存储的极简站，和 AI/附件/组织全开的团队站是同一套代码）。

拆的前提是：

- 启动时能按依赖顺序装配，**循环依赖要当场报错**而不是运行到一半炸；
- 某个能力没启用时，「缺哪一环」要能定位到**具体节点**，而不是「启动失败」；
- 每个能力的 HTTP 面是自己声明的，不是集中登记出来的。

## 考虑选项

| 选项 | 为什么不选 |
|---|---|
| **自建容器 + 自研事件总线** | 要手写依赖解析与循环检测。这套逻辑既难写对，也不是产品差异点 |
| **全家桶 Web 框架**（自带 ORM / 鉴权 / 静态资源） | 会替「哪些是必需能力」预先做决定；`require` 的传递闭包把轻量目标吃掉 |
| **框架无关但引入 Web 框架**（只做路由层） | 中间件栈会把「这个端点是谁挂的」重新变成人肉考古 |

## 决策结果

1. **插件图用 cordis**。类型合并、生命周期、节点级错误与循环检测交给它。
   组合根是 `packages/server/src/index.ts`，内置插件由其中的 `defaultRegistry()` 给出
   （每条都是 manifest + module 的配对，含 `provides` token 与 `source: 'builtin'`）。
2. **HTTP 用 `node:http` 手写一层**。同一文件顶层 `import { createServer } from 'node:http'`，
   全仓各包 `package.json` 里查不到 express / fastify / koa / hono。
3. 路由由**插件自己声明并挂载**（`ctx.get('http')` + `router.register`），所以「哪个能力提供哪些端点」
   是读代码可得的事实，不需要查中心注册表。

## 后果

**正面**

- `config/plugins.base.json` 的开关是真的开关，不是界面装饰。
- 缺依赖时报错指向具体节点，不是一坨栈。
- 端点归属可枚举 ⇒ `packages/server/src/index.ts` 的 `auditRouteAccess()` 才有可能存在（见 ADR-0006）。

**负面 / 风险（如实）**

- **横切能力全部手写**：ETag、Range、压缩、静态服务、表单解析、SSE 自心跳与背压，全在
  `packages/server/src/index.ts` / `packages/server/src/compression.ts` 里自己实现。
  这类代码是「别人早踩过」的雷区，本仓用安全评审与 e2e 补，成本比「装个框架」高，只是成本不在同一个环节。
- **cordis 停在 rc 线**（`packages/core/package.json` 依赖 `^4.0.0-rc.10`）。rc 意味着 API 可能动，
  而 cordis 在依赖图最底层，它一动就是全部插件的事。`packages/core/src/index.ts` 是全仓唯一的对外契约出口，
  正是为了把这个风险关在一个文件里。
- **cordis 的报错词汇会直接暴露给插件作者**。文档得替它解释一遍，这是持续的维护税。

## 证据与参考

- `packages/server/src/index.ts`：组合根、`defaultRegistry()`、`auditRouteAccess()`、`STRICT_ROUTE_ACCESS_ENV`
- `packages/core/src/index.ts`（re-export cordis 的 `Scope` / `DisposableScope`）、`packages/core/src/domain.ts`
- `ARCHITECTURE.md` 第 1 / 3 节、`docs/architecture.md`、`docs/plugin-platform.md`
