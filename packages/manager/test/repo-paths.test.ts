/**
 * @geewiki/core 路径解析（与进程工作目录无关）回归测试。
 *
 * 放在 manager 包内执行的原因：当前仓库只有 @geewiki/manager 声明了 `test`
 * 脚本（`node --import tsx --test test/*.test.ts`，见根 `pnpm test`），
 * core 包无测试运行器；而 manager 依赖 core，可直接消费其导出。
 *
 * 覆盖目标（消除 cwd 依赖）：
 * 1. findRepoRoot 依据 pnpm-workspace.yaml 自调用方模块位置向上定位仓库根；
 * 2. resolveProjectPath：绝对路径原样返回；相对路径以仓库根为基准，
 *    且切换进程工作目录（chdir）后结果不变——这正是 server/db-sqlite 默认
 *    路径（data/、config/、packages/web/dist）在任意 cwd 下都指向同一份数据的前提。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findRepoRoot, repoRootOf, resolveProjectPath } from '@geewiki/core'

/** 本测试文件所在包（packages/manager/test/）的模块 URL：与 src 中的 import.meta.url 同根 */
const here = import.meta.url

test('findRepoRoot：自模块位置向上定位含 pnpm-workspace.yaml 的仓库根', () => {
  const root = findRepoRoot(here)
  assert.ok(root, '应能定位仓库根')
  assert.ok(isAbsolute(root), '仓库根应为绝对路径')
  assert.ok(existsSync(join(root, 'pnpm-workspace.yaml')), '仓库根应含 pnpm-workspace.yaml')
  assert.ok(existsSync(join(root, 'packages', 'manager', 'package.json')), '仓库根下应有 packages/manager')

  // 同一个仓库内的任意模块 URL 解析到同一根
  const fromCore = pathToFileURL(join(root, 'packages', 'core', 'src', 'index.ts')).href
  assert.equal(findRepoRoot(fromCore), root, '不同包内解析出的仓库根应一致')
})

test('findRepoRoot：无 workspace 标记时返回 undefined，repoRootOf 回退进程工作目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-root-'))
  try {
    const orphan = pathToFileURL(join(dir, 'pkg', 'index.js')).href
    assert.equal(findRepoRoot(orphan), undefined, '向上无 pnpm-workspace.yaml → undefined')
    assert.equal(repoRootOf(orphan), process.cwd(), '不可探测时回退进程工作目录')
    assert.equal(findRepoRoot('not-a-file-url'), undefined, '非 file: URL 不抛错，返回 undefined')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveProjectPath：相对路径以仓库根为基准，切换 cwd 后结果不变', () => {
  const root = repoRootOf(here)
  assert.equal(resolveProjectPath('data/geewiki.db', here), join(root, 'data', 'geewiki.db'))
  assert.equal(resolveProjectPath('config/plugins.base.json', here), join(root, 'config', 'plugins.base.json'))
  assert.equal(resolveProjectPath('packages/web/dist', here), join(root, 'packages', 'web', 'dist'))

  const absolute = join(tmpdir(), 'gw-absolute', 'geewiki.db')
  assert.equal(resolveProjectPath(absolute, here), absolute, '绝对路径原样返回')

  // cwd 独立性回归：切到无关目录后，相对路径仍解析到仓库根（修复前会落到 cwd）
  const originalCwd = process.cwd()
  const foreign = mkdtempSync(join(tmpdir(), 'gw-cwd-'))
  try {
    process.chdir(foreign)
    assert.equal(
      resolveProjectPath('data/geewiki.db', here),
      join(root, 'data', 'geewiki.db'),
      '相对路径不得随进程工作目录漂移',
    )
  } finally {
    process.chdir(originalCwd)
    rmSync(foreign, { recursive: true, force: true })
  }
})
