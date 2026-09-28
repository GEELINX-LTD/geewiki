// pre-commit 只做一件事：对**本次已暂存**的 TS/JS 文件跑 eslint --fix。
//
// 为什么只有 eslint、不加 prettier / 不加 `eslint .` 全仓跑：
//  1. 本仓没有 formatter（见 CONTRIBUTING.md §5），突然引入会一次性改动上百文件；
//  2. 全仓跑会把别人未暂存的代码也报错，pre-commit 变成共享工作树的拦路石；
//  3. lint-staged 只把命令作用于 staged 文件（命令行参数由它拼接），
//     未暂存的改动由 lint-staged 自己 stash/恢复，不会被 `git add` 进本次提交。
//
// 不加 --max-warnings：仓库现存 warning 不该阻断提交（error 才阻断）。
export default {
  '*.{ts,tsx}': ['eslint --fix --no-warn-ignored'],
  '*.{js,mjs,cjs}': ['eslint --fix --no-warn-ignored'],
}
