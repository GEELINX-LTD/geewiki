// GeeWiki 代码风格门禁（ESLint 扁平配置）
//
// 设计原则：
//   1. 只启用能发现**真实缺陷**的规则（未使用变量、未定义引用、误用 promise 等），
//      不做纯风格偏好（缩进/引号/分号交给 .editorconfig 与各包既有写法）。
//   2. 不使用类型感知（type-aware）规则：`recommendedTypeChecked` 需要为 28 个包
//      建立 project service，CI 时间会成倍增长，收益有限。
//   3. 忽略产物目录；`packages/web/src/lib` 是源码，**不**在忽略之列。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      // 前端产物（vite build 生成，源码在 packages/web/src 与 fixtures/）
      'packages/web/public/**',
      // 运行时状态与本机缓存
      'tmp/**',
      'data/**',
      'logs/**',
      '.pnpm-store/**',
      '.npm-cache/**',
      '.pnpm-cache/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // 服务端与浏览器代码同仓，两者全局变量都放行
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // 以 _ 前缀显式表达「有意保留但未使用」（回调签名、解构占位等）
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // 中文注释与 UI 文案里会合法地出现全角空格（U+3000），不应视为异常字符
      'no-irregular-whitespace': [
        'error',
        { skipComments: true, skipStrings: true, skipTemplates: true, skipRegExps: true },
      ],
      // `interface X extends Y {}` 是本仓表达「语义别名」的既有写法
      // （如 ResolvedCapability extends OwnedCapabilityDecl），显式放行
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
    },
  },
  {
    // React Hooks 规则：只启用经典子集。
    // 插件 v7 的 configs.recommended 会引入 React Compiler 新规则
    // （set-state-in-effect / refs / immutability），在本仓存量代码上新增 52 个
    // error，需要重构 UI 才能收敛，故不启用；rules-of-hooks 能捕获条件调用 Hook
    // 这类真实缺陷，exhaustive-deps 降为 warning 不阻断合入。
    files: ['**/*.tsx', '**/*.jsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 测试与验收脚本：允许更宽松的写法
    files: ['**/test/**/*.{ts,tsx,mjs,js}', 'scripts/**/*.{ts,mjs,js}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
