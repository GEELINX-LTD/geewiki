# 0004. ESLint 刻意不用 type-aware 规则

- 状态：`accepted`（回填：`eslint.config.js` 顶部注释明写了这条决定）
- 记录日期：2026-09-28
- 关联：ADR-0008（不引入格式化器）、ADR-0002（运行期形态决定了类型检查是独立门禁）

## 技术背景

`pnpm lint` = `eslint . --max-warnings 0`，是 CI 的第一道门禁，也是 husky `pre-commit`
（`lint-staged.config.mjs` 对暂存的 `ts/tsx` 跑 `eslint --fix`）的实现。

ESLint 在这里有两种活法：只做语法/模式级检查，或者开 `projectService` 做**带类型的**检查
（`no-floating-promises`、`no-misused-promises`、`strict-boolean-expressions` 这一类）。

## 考虑选项

| 选项 | 为什么不选 |
|---|---|
| **全量 type-aware** | 要为 28 个包建 project service，CI 时间成倍涨；而本仓真正反复出错的东西并不在这一类里 |
| **只对 core 开 type-aware** | 混合配置最难维护：同一份代码两种严格度，报错“在我这里不复现” |
| **只用非类型规则 + 用测试补** | 见下方决策 |

## 决策结果

**只用非类型规则集。** `eslint.config.js` 顶部注释原话是「只用**能抓到真实缺陷**的规则集，
刻意不做 type-aware（typeChecked 会为 28 个包建 project service，成倍增加 CI 时间）」。
实际启用的自定义项很少：`no-explicit-any`（warn）、`no-empty`（显式 `allowEmptyCatch`）、
`no-unused-vars`（`argsIgnorePattern: '^_'`）、`no-constant-condition`（`checkLoops: false`）、
`preserve-caught-error`，外加 TS 文件上的 `ban-ts-comment`（禁 `@ts-nocheck`）与 Web 目录的 react-hooks。

**类型层面的正确性由 `pnpm typecheck`（`tsc -b`）负责**，不在 lint 里重复。

## 后果

**正面**

- lint 快，可以放进 `pre-commit` 而不让人想绕过钩子。
- 规则集小 ⇒ 每条都能说清「它抓的是本仓哪一类历史缺陷」，不是抄一份流行配置。

**负面 / 风险（如实）**

- **拿不到 promise 类检查**。未处理的 rejection、把 async 函数当同步回调传给 `addEventListener`
  这类问题，lint **不会**报你，只能靠 review 与运行时表现。
- **`allowEmptyCatch` 是一条真盲区**：`catch {}` 静默通过。吞异常在本仓是安全问题（审计写入失败必须可见），
  所以它靠人审 + 少数几条读源码文本的守卫测试兜，而不是靠 lint。
- **`--max-warnings 0` 让 warn 也是红**，于是「`no-explicit-any` 只是 warn」这句话没有意义：
  多一个 any 作业就红。目前全仓仍有既有 error（`pnpm lint` 现算，不写死数字），
  改文件时会撞上「我没碰过的行也是红的」——按 `CONTRIBUTING.md` 的口径**如实报告，别顺手修别人的**。
- **`scripts/acceptance/` 不在类型门禁范围内**：`tsconfig.scripts.json` 的 `exclude` 里有它，
  注释写明那是一次性 CDP 验收脚本、首次检查有 16 处既有错误。改了验收脚本，类型门禁不会替你把关。
- **需要 `eslint-disable` 时必须带原因注释**。现存 6 处（`packages/core/src/index.ts`、
  `packages/core/src/cordis-env.ts`、`packages/manager/src/deps.ts`、`packages/manager/src/plugin-ui.ts`、
  `packages/plugin-ai-web-search/src/types.ts`、`packages/web/src/lib/pluginUiPlan.ts`）
  每一条都写了「为什么必须禁」，照这个格式写。Web 组件里的 `react-hooks/exhaustive-deps`
  是**另一类**（依赖表是刻意的，注释要解释重建编辑器的代价），别混着学。

**想改这条**：先拿证据说明「哪些类型级规则真能抓到本仓的历史缺陷」，并给出 CI 时间预算，再开新 ADR。

## 证据与参考

- `eslint.config.js`（顶部注释与规则集）、`tsconfig.scripts.json`（`exclude` 及其注释）
- `package.json`（`lint` / `lint:fix`）、`lint-staged.config.mjs`、`.github/workflows/ci.yml`
- `CONTRIBUTING.md` §4（代码风格）、`docs/agent/conventions.md` §9
