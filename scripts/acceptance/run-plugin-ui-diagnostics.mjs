#!/usr/bin/env node
/** 隔离的真实插件 UI 故障回归；用 --dev 再验 Vite 的动态 import 路径。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runBrowserFlow } from './lib/run-browser.mjs'

await runBrowserFlow({
  name: 'plugin-ui-diagnostics',
  script: 'plugin-ui-diagnostics-cdp.mjs',
  async prepare(temporary) {
    const root = join(temporary, 'plugins')
    const sources = {
      sync: `export function register(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        s.counts.sync = (s.counts.sync ?? 0) + 1;
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'sync' }, 'sync'));
        if (!s.recover.sync) throw new Error('fixture synchronous entry failure');
      }`,
      async: `export default async function(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        s.counts.async = (s.counts.async ?? 0) + 1;
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'async' }, 'async'));
        await Promise.resolve();
        throw new Error('fixture asynchronous entry failure');
      }`,
      top: `const host = globalThis.__GEEWIKI_HOST__;
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'top' }, 'top'));
        throw new Error('fixture module evaluation failure');`,
      healthy: `export function register(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        s.counts.healthy = (s.counts.healthy ?? 0) + 1;
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'healthy' }, 'healthy'));
      }`,
      late: `export async function register(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'late' }, 'late'));
        await new Promise(resolve => { s.release = resolve; s.waiting = true; });
        if (s.rejectLate) throw new Error('fixture stale asynchronous failure');
        return () => { s.cleaned = (s.cleaned ?? 0) + 1; };
      }`,
    }
    for (const [id, source] of Object.entries(sources)) {
      const directory = join(root, id)
      await mkdir(join(directory, 'dist'), { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: `@gw-test/ui-${id}`, version: '0.0.1', type: 'module',
        geewiki: { entry: 'index.js', client: { entry: 'client.js', css: 'client.css' },
          slots: ['app-header'], runtime: { supportsHotReload: true, requiresCachePurge: false } },
      }))
      await writeFile(join(directory, 'index.js'), 'export default function apply() {}\n')
      await writeFile(join(directory, 'dist/client.js'), source)
      await writeFile(join(directory, 'dist/client.css'), '/* isolated UI fixture */\n')
    }
    return {
      enabled: ['sync', 'async', 'top', 'healthy'].map(id => ({ name: `@gw-test/ui-${id}` })),
      env: { GEEWIKI_UI_FIXTURE_DIR: root },
    }
  },
})
