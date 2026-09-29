// 提交信息门禁：Conventional Commits（@commitlint/config-conventional）。
//
// 取值依据是本仓**真实历史**（`git log --pretty=format:%s -100` 实测，不是抄别处的枚举）：
//   feat / fix / docs / refactor / test / ci / chore
//   其中 chore 包含 dependabot 的 `chore(deps): bump ...`（历史 5 条，必须放行）；
//   `merge(docker): ...` 在历史里真实出现过，所以 merge 也要进枚举；
//   `Merge pull request #10 ...` 与 `Revert "fix(web): ..."` 由 commitlint 内置 ignores 跳过，
//   不需要为了它们放宽任何规则。
//
// 刻意**不加** subject 中文强制正则：commitlint 的规则是 JS 正则，没有可靠的 Unicode 词类，
// 真加上会把 dependabot 的英文 subject 全拦下（本仓有 5 条 chore(deps)）。
// 「subject 用中文、scope 用包名/域名」靠 .github/pull_request_template.md 与 CONTRIBUTING.md §4 约定。
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 前 11 个是 config-conventional 默认集合，merge 是本仓实测补充
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'refactor',
        'test',
        'ci',
        'chore',
        'build',
        'perf',
        'style',
        'revert',
        'merge',
      ],
    ],
    // scope 只用 config-conventional 默认的 lower-case，**不做枚举**：
    // 枚举会随包增删腐化（正是文档纪律反对的写死读数）；
    // 也**不用** kebab-case：历史里有 `fix(wiki,web):` 这种复合 scope，kebab-case 会误杀。
    // 中文按字符数算，100 足够容纳「type(scope): 一句话说明」的写法。
    'header-max-length': [2, 'always', 100],
    // 正文 / footer 里的长 URL 、长中文说明不该被拦。依据是本仓真实历史：
    // `refactor(ai)!: 把 plugin-ai 拆成 plugin-ai-* 十个包` 的 BREAKING CHANGE footer
    // 超 100 字符，被 config-conventional 默认规则判为 footer-max-line-length（实测唯一一条误伤）。
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    // 同理：本仓 subject 是中文，但里面经常夹 LLM / AI / API / UI 等英文缩写。
    // 依据是本仓真实历史：`feat(llm): LLM 契约实现与适配器` 被默认 subject-case 判为
    // sentence-case/start-case（实测第二条误伤）。中文没有大小写，这条规则对本仓无意义。
    'subject-case': [0],
  },
}
