/**
 * **写一次、不可回读的配置字段**（schema `role: 'secret'`）的端到端测试。
 *
 * 为什么这组用例必须存在：它是本批唯一的**新增安全属性** ——
 * "界面能填密钥" 与 "密钥绝不进入库文件/绝不回显" 这两件事必须同时成立，
 * 而后者靠的是一串容易被后续改动悄悄破坏的机制（吸收 → 独立落盘 → 边界注水 → 读出脱敏）。
 * 用例逐条钉死这四步，任何一步回退都会立刻变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from 'schemastery'
import { GeeWikiManager } from '../src/index.js'
import { secretFieldNames } from '../src/config-schema.js'
import type { RegisteredPlugin } from '../src/deps.js'
import { readSecretFile, setSecret, writeSecretFile } from '../src/secrets.js'

interface Env {
  dir: string
  baseFile: string
  sessionFile: string
  secretsFile: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-secrets-'))
  return {
    dir,
    baseFile: join(dir, 'plugins.base.json'),
    sessionFile: join(dir, 'plugins.session.json'),
    secretsFile: join(dir, 'secrets.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 收到配置的假插件（apply 时记录，便于断言"插件真的拿到了密钥"） */
function makePlugin(name: string): { entry: RegisteredPlugin; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = []
  const schema = Schema.object({
    endpoint: Schema.string().default('https://example.test/v1'),
    apiKey: Schema.string().default('').role('secret'),
  })
  const plugin = {
    name,
    Config: schema,
    apply(_ctx: Context, config: Record<string, unknown> = {}) {
      seen.push({ ...config })
      return () => undefined
    },
  }
  return {
    seen,
    entry: {
      name,
      module: plugin as unknown as RegisteredPlugin['module'],
      manifest: {
        name,
        version: '0.1.0',
        geewiki: {
          displayName: '密钥测试插件',
          description: '测试用',
          requires: [],
          runtime: { supportsHotReload: true, requiresCachePurge: false },
          configSchema: schema,
        },
      },
    },
  }
}

function makeManager(env: Env, registry: RegisteredPlugin[]): GeeWikiManager {
  writeFileSync(env.baseFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
  writeFileSync(env.sessionFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
  return new GeeWikiManager(new Context(), {
    registry,
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
    crashMarkerFile: undefined,
  })
}

/* ------------------------- 纯函数：字段识别与存储 ------------------------- */

test('secretFieldNames：只认 role: secret 的顶层字段', () => {
  const schema = Schema.object({
    plain: Schema.string().default(''),
    password: Schema.string().default('').role('password'),
    apiKey: Schema.string().default('').role('secret'),
    extra: Schema.object({ inner: Schema.string().default('').role('secret') }),
  })
  assert.deepEqual(secretFieldNames(schema), ['apiKey'], 'password 只是界面遮罩，嵌套字段有意不收（语义无法判定）')
  assert.deepEqual(secretFieldNames(Schema.object({})), [])
})

test('setSecret：设置 / 重复设置（无变化）/ 清除 / 清空后删掉插件条目', () => {
  const store: Record<string, Record<string, string>> = {}
  assert.equal(setSecret(store, 'p', 'apiKey', '  sk-a  '), true, '两侧空白应被裁掉（粘贴常带换行）')
  assert.deepEqual(store, { p: { apiKey: 'sk-a' } })
  assert.equal(setSecret(store, 'p', 'apiKey', 'sk-a'), false, '同值不得报告"有变化"（免得每次保存都重写文件）')
  assert.equal(setSecret(store, 'p', 'apiKey', ''), false, '空串不是"清除"（清除走 null）')
  assert.equal(setSecret(store, 'p', 'apiKey', null), true)
  assert.deepEqual(store, {}, '清空后不得留下空对象条目')
  assert.equal(setSecret(store, 'p', 'apiKey', null), false, '重复清除无变化')
})

test('密钥文件：0600 落盘、空存储删文件、损坏时抛错而不是当空', () => {
  const env = makeEnv()
  try {
    writeSecretFile(env.secretsFile, { '@geewiki/llm': { apiKey: 'sk-a' } })
    assert.equal(statSync(env.secretsFile).mode & 0o777, 0o600, '密钥文件必须仅属主可读写')
    assert.deepEqual(readSecretFile(env.secretsFile), { '@geewiki/llm': { apiKey: 'sk-a' } })

    writeSecretFile(env.secretsFile, {})
    assert.equal(existsSync(env.secretsFile), false, '存储为空 → 删文件（不留一个让人误会的 {}）')
    assert.deepEqual(readSecretFile(env.secretsFile), {}, '不存在 = 空存储（正常状态）')

    writeFileSync(env.secretsFile, '{ 坏 JSON', 'utf8')
    assert.throws(() => readSecretFile(env.secretsFile), /不是合法 JSON/, '损坏必须显式抛错')
    writeFileSync(env.secretsFile, '[]', 'utf8')
    assert.throws(() => readSecretFile(env.secretsFile), /结构非法/)
  } finally {
    env.cleanup()
  }
})

/* ------------------------- 管理器：吸收 / 注水 / 脱敏 ------------------------- */

test('保存密钥：值进密钥文件，plugins.*.json 里只有普通字段；插件拿到的是带密钥的配置', async () => {
  const env = makeEnv()
  const { entry, seen } = makePlugin('@test/secret-plugin')
  const manager = makeManager(env, [entry])
  try {
    await manager.enable('@test/secret-plugin', { endpoint: 'https://api.example.test/v1', apiKey: 'sk-live-123' })

    const persisted = JSON.parse(readFileSync(env.baseFile, 'utf8')) as {
      enabled: { name: string; config?: Record<string, unknown> }[]
    }
    const sessionPersisted = JSON.parse(readFileSync(env.sessionFile, 'utf8')) as {
      enabled: { name: string; config?: Record<string, unknown> }[]
    }
    const files = JSON.stringify([persisted, sessionPersisted])
    assert.equal(files.includes('sk-live-123'), false, '密钥绝不能出现在任何清单文件里（base 是入库文件）')
    assert.equal(existsSync(env.secretsFile), true, '密钥应落到独立的密钥文件')
    assert.deepEqual(readSecretFile(env.secretsFile), { '@test/secret-plugin': { apiKey: 'sk-live-123' } })

    assert.equal(seen[0]?.['apiKey'], 'sk-live-123', '交给插件的那一份配置必须带密钥（否则功能直接不可用）')
    assert.equal(seen[0]?.['endpoint'], 'https://api.example.test/v1', '普通字段照常传递')
  } finally {
    env.cleanup()
  }
})

test('读出脱敏：GET 配置只报"是否已配置"，绝不回显值', async () => {
  const env = makeEnv()
  const { entry } = makePlugin('@test/secret-plugin')
  const manager = makeManager(env, [entry])
  try {
    await manager.enable('@test/secret-plugin', { apiKey: 'sk-live-123' })
    const view = manager.configOf('@test/secret-plugin')
    assert.deepEqual(view.secrets, { apiKey: true }, '只报有无')
    assert.equal('apiKey' in view.config, false, '值不得出现在 config 里')
    assert.equal(JSON.stringify(view).includes('sk-live-123'), false, '整份响应不得含密钥明文')

    // 插件快照（/api/plugins 的数据源）同样不得泄漏
    assert.equal(JSON.stringify(manager.snapshot()).includes('sk-live-123'), false, '插件列表快照不得含密钥明文')
  } finally {
    env.cleanup()
  }
})

test('留空 = 不修改：只改普通字段时，已保存的密钥必须保留', async () => {
  const env = makeEnv()
  const { entry, seen } = makePlugin('@test/secret-plugin')
  const manager = makeManager(env, [entry])
  try {
    await manager.enable('@test/secret-plugin', { apiKey: 'sk-first' })
    // 表单回显的密钥恒为空串，用户只改了别的字段
    await manager.updateConfig('@test/secret-plugin', { endpoint: 'https://changed.test/v1', apiKey: '' })
    assert.deepEqual(readSecretFile(env.secretsFile), { '@test/secret-plugin': { apiKey: 'sk-first' } })
    assert.equal(seen.at(-1)?.['apiKey'], 'sk-first', '热更新交出去的配置仍须带旧密钥')
    assert.equal(seen.at(-1)?.['endpoint'], 'https://changed.test/v1')
  } finally {
    env.cleanup()
  }
})

test('填新值 = 替换；clearSecrets = 显式清除（并删掉空密钥文件）', async () => {
  const env = makeEnv()
  const { entry, seen } = makePlugin('@test/secret-plugin')
  const manager = makeManager(env, [entry])
  try {
    await manager.enable('@test/secret-plugin', { apiKey: 'sk-first' })
    await manager.updateConfig('@test/secret-plugin', { apiKey: 'sk-second' })
    assert.deepEqual(readSecretFile(env.secretsFile), { '@test/secret-plugin': { apiKey: 'sk-second' } })

    await manager.updateConfig('@test/secret-plugin', { apiKey: '' }, { clearSecrets: ['apiKey'] })
    assert.equal(existsSync(env.secretsFile), false, '清空后删文件')
    assert.equal(manager.configOf('@test/secret-plugin').secrets['apiKey'], false)
    assert.equal(seen.at(-1)?.['apiKey'], '', '清除后交给插件的是 schema 默认空串（不再有值）')
  } finally {
    env.cleanup()
  }
})

test('未声明 role: secret 的插件完全不受影响（不读也不写密钥文件）', async () => {
  const env = makeEnv()
  const schema = Schema.object({ endpoint: Schema.string().default('') })
  const plugin = {
    name: '@test/plain-plugin',
    Config: schema,
    apply() {
      return () => undefined
    },
  }
  const entry = {
    name: '@test/plain-plugin',
    module: plugin as unknown as RegisteredPlugin['module'],
    manifest: {
      name: '@test/plain-plugin',
      version: '0.1.0',
      geewiki: {
        displayName: '普通插件',
        description: '测试用',
        requires: [],
        runtime: { supportsHotReload: true, requiresCachePurge: false },
        configSchema: schema,
      },
    },
  } satisfies RegisteredPlugin
  const manager = makeManager(env, [entry])
  try {
    await manager.enable('@test/plain-plugin', { endpoint: 'https://x.test' })
    assert.equal(existsSync(env.secretsFile), false, '没有密钥字段就不该产生密钥文件')
    // 会话层启用 → 普通字段落进会话清单（不是基础层），但无论如何都要落盘
    const persisted = readFileSync(env.sessionFile, 'utf8') + readFileSync(env.baseFile, 'utf8')
    assert.equal(persisted.includes('https://x.test'), true, '普通字段照常落盘')
  } finally {
    env.cleanup()
  }
})
