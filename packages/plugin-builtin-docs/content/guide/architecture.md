# 架构

一句话：**一个不含业务知识的引擎 + 一组互相声明依赖的插件**。
页面、检索、登录、权限、AI 全是插件；引擎只负责装配它们。

## 分层

```text
core            契约与 token（Principal、DatabaseAdapter、GeeWikiManifest、事件）
 ├─ db-sqlite / db-postgres     数据库适配器（互斥，二选一）
 ├─ manager                     插件生命周期：启停、配置、迁移、热更新
 ├─ server                      组合根：内置插件注册表 + HTTP 装配
 └─ plugins/*                   一切业务功能（wiki / search / auth / authz /
                                org / oidc / llm / ai-* / builtin-docs …）
web               前端 SPA：hash 路由 + 插槽式插件 UI
```

## 依赖注入（cordis）

插件之间**不 import 实现，只声明依赖 token**：

- manifest 的 `geewiki.provides / requires` 是**依赖图上的 token**，决定启动顺序与
  卸载护栏（还有别人依赖你 ⇒ 拒绝卸载）；
- `ctx.provide('xxx-service', svc)` 才真正创建服务，`ctx.get('xxx-service')` 取用。
  两者名字必须一致——声明了 `provides` 却没有 provide，消费方只会拿到 `undefined`。

跨插件调用一律用**结构化类型**（各自声明"我需要的最小方法集"），不 import 对方包——
换掉实现方（比如换一个 policy 实现）不需要动消费方。

## 数据库

- `DatabaseAdapter`：`query / run / transaction` 的统一门面，SQLite 与 PostgreSQL
  共用同一套业务代码；两者在 manifest 上声明同一个 `conflictGroup: 'database-provider'`
  ⇒ **互斥**，同时启用会被管理器拒绝。
- 迁移：每个插件自带 `migrations/*.sql`，在 manifest 声明目录；启用与启动时按序执行，
  全部要求幂等（`CREATE TABLE IF NOT EXISTS` 风格）。

## 权限模型（policy-service 是唯一真源）

授权判定只有一处出口（`@geewiki/authz`），列表、检索、阅读、写路径全部问它：

- 页面档位 `private / org / public`，`public` 还要**发布**（`published_at`）才对匿名可见；
- 层级继承：子页默认与祖先取**交集**（收紧），可在「权限」里断开继承；
- 显式授予：对某页直接授某人 / 某组 `viewer / editor`，可带过期时间；
- 块级受限：正文里用 gated 注释标记圈出的段落按块计算可见性（标记写法见
  [[guide/special-structures|特殊结构]] 的「受限块」）；
- **失败关闭**：判据拿不到 ⇒ 一律拒绝，绝不因"没传主体 / 策略层缺席"而放行。

## 检索

`@geewiki/search` 维护 FTS5（trigram 分词，中文可用；非 SQLite 方言回退 LIKE）索引。
正文按块入库、按档位（tier）打标记；一次检索在**命中层**与**正文层**各做一次权限过滤。

## AI 链路

- `llm-service` 只定义"对话补全"契约，`@geewiki/openai` 提供 OpenAI 兼容 adapter；
  端点/密钥/模型统一在 llm 配置里。
- `ai-tool-service` 是工具总线：各插件注册工具（读页、检索、写页、跳转、插件管理…），
  `ai-assistant` 的 agent 循环按名字调用它们。
- `ai-journal` 记下 AI 的每一次写操作，支持按轮**一键回退**；记不下来的写操作直接不做。
- 内置助手只能触达**你权限范围内**的内容——AI 复用与人类完全相同的判据，没有后门。

## 前端

SPA 走 hash 路由，Markdown 用 marked（GFM + 换行即断行）渲染后经 DOMPurify 消毒；
插件通过**插槽**（页头 / 页脚 / 编辑器 / 底部助手坞等）贡献界面，按需加载。
