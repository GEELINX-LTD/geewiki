/**
 * `@geewiki/postgres` 的**密钥纪律**守卫。
 *
 * 本文件存在的理由：本插件的配置会经 `PUT /api/plugins/:name/config` +
 * `POST /api/session/persist` **落盘**到 `config/plugins.*.json` —— 那是**被 git 跟踪**的文件。
 * 因此"配置里存在一个能被填进表单的密钥字段"就等于给"把密钥提交进版本库"开了一个入口。
 *
 * 曾经存在的缺陷：schema 里同时有 `passwordEnv`（环境变量**名**，正确）与 `password`
 * （`.role('password')` 明文字段）。后者会被原样落盘，与 `@geewiki/llm` / `@geewiki/openai`
 * 早已确立的 `apiKeyEnv` 纪律（只接受变量名）直接冲突；"文档里写一句警告"不足以阻止落盘。
 * 现已**从契约层移除**该字段，本文件把该不变量钉成断言。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PostgresConfigSchema } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

/** 与 manager 的 validateConfig 同口径：schemastery 实例可直接调用，非法即抛 */
function validate(raw: unknown): { ok: boolean; message?: string } {
  try {
    void (PostgresConfigSchema as unknown as (v: unknown) => unknown)(raw)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

const dictOf = (schema: unknown): Record<string, unknown> =>
  (schema as { dict?: Record<string, unknown> }).dict ?? {}

/** 去掉注释：注释里提到某个写法不等于代码里用了它（本仓库踩过：守卫被自己的说明文字绊红） */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

/* ------------------------------ 不变量 ------------------------------ */

test('密钥纪律：PG 配置 schema 不声明任何明文字段', () => {
  const dict = dictOf(PostgresConfigSchema)
  // 覆盖度自证：解析不到字段就等于守卫空转（"没有明文字段"会假通过）
  assert.ok(Object.keys(dict).length > 0, '未解析到 schema 字段，structural 判定失效')
  assert.equal(
    'password' in dict,
    false,
    'schema 里不得存在明文 password 字段：它的值会随配置落盘进 git 跟踪的 config/plugins.*.json',
  )
})

test('密钥纪律：环境变量名字段在**校验层**就拒绝密钥值（不止激活时才拒）', () => {
  const secrets = [
    'a1b2c3d4e5f60718293a4b5c6d7e8f90', // 32 位 hex —— @geewiki/llm 那次黑名单漏判的形态
    'ABCDEF1234567890', // 全大写但无下划线
    'Xk9mQpL7vR4', // 短随机混合
    'my-secret-password', // 含小写与连字符
  ]
  for (const field of ['passwordEnv', 'connectionStringEnv'] as const) {
    for (const bad of secrets) {
      const r = validate({ [field]: bad })
      // 断言"校验层"拒绝：schema pattern 覆盖配置读写路径，故非法值在 PUT 时即被拒、**不会落盘**
      assert.equal(r.ok, false, `${field} 必须在 schema 层拒绝疑似密钥值: ${bad}`)
    }
  }
})

test('密钥纪律：空串与合法环境变量名必须被接受（否则默认配置本身就校验失败）', () => {
  // 注意 `A` 这类**不含下划线**的全大写单词是**故意**不接受的：白名单要求"必须含至少一个下划线"，
  // 正是为了把"全大写随机串"这类密码形态挡在外面（见 ENV_VAR_NAME_RE 的注释）。
  for (const good of ['', 'A_B', 'A_', '_X', 'GEEWIKI_DB_PASSWORD', 'PG_PASSWORD']) {
    const r = validate({ passwordEnv: good })
    assert.equal(r.ok, true, `passwordEnv 应接受 ${JSON.stringify(good)}${r.ok ? '' : `：${r.message}`}`)
  }
})

/* ------------------------------ 跨包行为对齐 ------------------------------ */

test('跨包对齐：本包字段白名单与 @geewiki/llm 的 ENV_VAR_NAME_FIELD_RE **行为**一致', () => {
  const src = readFileSync(join(REPO_ROOT, 'packages', 'plugin-llm', 'src', 'credentials.ts'), 'utf8')
  const matched = /export const ENV_VAR_NAME_FIELD_RE = (\/.*\/)\s*$/m.exec(src)
  // 正则失效时**必须失败**，绝不能退化成"没解析到就不比较"
  assert.ok(matched, '未能在 packages/plugin-llm/src/credentials.ts 解析出 ENV_VAR_NAME_FIELD_RE')
  const literal = matched[1]
  if (literal === undefined) assert.fail('ENV_VAR_NAME_FIELD_RE 的正则字面量捕获组为空')
  const reference = new RegExp(literal.slice(1, -1))

  const corpus = [
    '', 'A', 'A_B', 'GEEWIKI_DB_PASSWORD', 'PG_PASSWORD', '_X', 'A_',
    'lower_case', 'a_b', '0123_456',
    'ABCDEF1234567890', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'Xk9mQpL7vR4',
    'my-secret-password', 'WITH SPACE_X', 'A-B_C', `${'X'.repeat(129)}_`,
  ]
  // 语料覆盖度自证：两个方向都要有足够样本，否则"一致"可能只是都在拒/都在放行少数几个
  const refAccepts = corpus.filter((v) => reference.test(v)).length
  const refRejects = corpus.length - refAccepts
  assert.ok(refAccepts >= 5, `语料需覆盖足够"接受"样本（当前 ${refAccepts}）`)
  assert.ok(refRejects >= 6, `语料需覆盖足够"拒绝"样本（当前 ${refRejects}）`)

  for (const value of corpus) {
    const ours = validate({ passwordEnv: value }).ok
    assert.equal(
      ours,
      reference.test(value),
      `对 ${JSON.stringify(value)} 的判定与 @geewiki/llm 的 ENV_VAR_NAME_FIELD_RE 不一致（本包 ${ours}）`,
    )
  }
})

/* ------------------------------ 仓库级不变量 ------------------------------ */

test('仓库级：没有任何插件的 configSchema 声明 role(password) 明文字段', () => {
  const hits: string[] = []
  const pkgs = join(REPO_ROOT, 'packages')
  for (const entry of readdirSync(pkgs)) {
    const srcDir = join(pkgs, entry, 'src')
    if (!existsSync(srcDir)) continue
    for (const file of walk(srcDir)) {
      if (stripComments(readFileSync(file, 'utf8')).includes("role('password')")) {
        hits.push(relative(REPO_ROOT, file))
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    `以下文件声明了 role('password') 明文字段：${hits.join(', ')}。` +
      '该字段的值会随配置落盘进**被 git 跟踪**的 config/plugins.*.json；' +
      '请改用"环境变量名"字段（见 packages/plugin-llm/src/credentials.ts 的 ENV_VAR_NAME_FIELD_RE）。',
  )
})
