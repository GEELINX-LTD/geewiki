# 0008. 不引入代码格式化工具，风格唯一来源是 .editorconfig

- 状态：`accepted`（回填：`eslint.config.js` 顶部注释与 `CONTRIBUTING.md` §4 都明写了这条决定）
- 记录日期：2026-09-28

## 技术背景

本仓 28 个包、`.ts` / `.tsx` 约十五万行，**没有 prettier，也没有 biome**——不是遗漏，而是刻意的：

- `eslint.config.js` 顶部注释：「不做纯风格偏好（缩进/引号/分号交给 `.editorconfig` 与各包既有写法）」。
- 风格事实的唯一载体是 [`.editorconfig`](../../.editorconfig)：UTF-8、LF、2 空格、去行尾空格、文件末尾换行。
- ESLint 规则集只收**能发现缺陷**的规则，不收排版规则（与 [ADR-0004](./0004-eslint-no-type-aware.md) 同源：CI 预算花在能出问题的地方）。

这条决定在引入门禁后变得**更容易被误改**，所以必须写下来：

- `pnpm run lint` = `eslint . --max-warnings 0`；
- 提交门禁 `lint-staged` 对**已提交的 `.ts` / `.tsx`** 跑 `eslint --fix`（见 `lint-staged.config.mjs`）。

也就是说：现在仓库里**已经有一个会改写文件的钩子**了。如果此时再叠一个 formatter，
一次 `git commit` 就可能同时被两套工具改写，而它们的规则并不等价（prettier 会重排换行，
ESLint 的 `--fix` 不会），结果是 diff 里混进大量与本次改动无关的排版变化——
在这种"文档与代码都要同步"的仓库里，那会让 review 直接失去可读性。

## 考虑选项

- **加 prettier + eslint-config-prettier**：生态最广、编辑器无脑可用。代价是全仓一次性重排（约十五万行）、
  之后每次 `git blame` 断在这里，且与"ESLint 只管缺陷"的分层冲突。
- **加 biome**：快、单工具。但它是"格式化 + lint"二合一，装上就等于绕过本仓刻意收窄的 ESLint 规则集，
  而且它不认 `.editorconfig`，风格事实会变成两个真源。
- **加 GitHub action 做格式检查**（不改代码，只报错）：不破坏历史，但会让每个 PR 被排版意见淹没，
  而项目要评审的是「文档与代码是否一致」。
- **维持现状**：机器不校验排版，靠 `.editorconfig` 与评审。

## 决策结果

**维持现状：不加任何格式化工具。**排版由 `.editorconfig` 约束（依赖编辑器自觉），
ESLint 负责可修复的少量排版项（`--fix`），`lint` 门禁的语义严格限定为「质量」而非「排版」。

## 后果

### 正面

- 历史 blame 不被排版改动冲掉，review 看到的 diff 就是真实改动。
- 风格事实只有一个真源，与「文档地图 + 事实真源表」的整体纪律一致。
- 新增 formatter 的隐性成本（全仓重排、CI 时间、编辑器配置漂移）归零。

### 负面 / 风险（如实）

- **`.editorconfig` 没有任何机器校验**。编辑器不装对应插件就会静默产出 4 空格或 CRLF 的文件，
  而 CI 是绿的——因为 ESLint 不管这些。这是本决定**最大的敞口**。
- 排版类反馈推迟到 review 阶段，评审者可能提出本该机器拦下的意见。
- 与多数开源项目的默认习惯不同：贡献者带着 prettier 配置进来会立刻冲突。
  已在 `CONTRIBUTING.md` §4 显式写明「仓库里没有、也不用去找」。
- `lint-staged` 的 `eslint --fix` 已经是一个"会改你文件的钩子"。
  **不要因为"反正已经有钩子了"就往里加 formatter** —— 那正是本 ADR 要拦的动作。

## 关联

- 代码：`.editorconfig`、`eslint.config.js`（顶部注释）、`lint-staged.config.mjs`、`package.json` 的 `lint` / `precommit`
- 文档：`CONTRIBUTING.md` §4（代码风格）、§9（CI 与 PR）
- 相关：[ADR-0004](./0004-eslint-no-type-aware.md)（ESLint 刻意不用 type-aware）、
  [ADR-0005](./0005-pnpm-relative-store-and-cache-dirs.md)（同类"CI 预算"取舍）
