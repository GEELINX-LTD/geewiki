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
      '00-timeout': `export async function register(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        const runs = (s.timeoutRuns ??= []);
        const run = { index: runs.length + 1, started: performance.now() };
        runs.push(run);
        const registerAll = () => [
          host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'timeout' }, 'timeout-' + run.index)),
          host.registerExtension('ui-card', () => null),
          host.registerRoute('fixture-timeout', () => null),
          host.registerTool('fixture.timeout', () => run.index),
          host.registerMarkdownExtension({ name: 'fixture-timeout', marked: {} }),
          host.registerTheme({ name: 'fixture-timeout-' + run.index, light: { '--gw-accent': '#123456' } }),
        ];
        const original = registerAll();
        const cleanup = () => {
          run.cleaned = (run.cleaned ?? 0) + 1;
          host.unregisterSlot('app-header');
          host.unregisterRoutes(host.pluginName);
          host.unregisterTools(host.pluginName);
          host.unregisterMarkdownExtensions(host.pluginName);
          host.unregisterThemes(host.pluginName);
        };
        if (s.recoverTimeout) return cleanup;
        await new Promise(resolve => { run.release = resolve; });
        if (run.reject) { run.rejected = true; throw new Error('fixture timed-out late rejection'); }
        registerAll();
        cleanup();
        for (const off of original) off();
        run.mutationsComplete = true;
        return () => { run.lateCleanup = (run.lateCleanup ?? 0) + 1; cleanup(); };
      }`,
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
        s.healthyAt = performance.now();
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'healthy' }, 'healthy'));
      }`,
      missing: `export function register(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        s.counts.missing = (s.counts.missing ?? 0) + 1;
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'missing' }, 'partial'));
      }`,
      dynamic: `export function register(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        s.registerDynamicRoute = () => { s.disposeDynamicRoute = host.registerRoute('fixture-dynamic', () => null); };
        s.registerDynamic = () => {
          const slot = host.registerSlot('app-header', () => null);
          const ext = host.registerExtension('ui-card', () => null);
          s.registerDynamicRoute();
          s.disposeDynamic = () => { slot(); ext(); s.disposeDynamicRoute(); };
        };
      }`,
      lazy: 'export function register() {}',
      winner: `export function register(host) {
        host.registerSlot('app-header', () => null);
        host.registerSlot('editor', () => null);
      }`,
      suppressed: `export function register(host) {
        host.registerSlot('app-header', () => null);
        host.registerSlot('editor', () => null);
      }`,
      delayed: `export async function register(host) {
        await Promise.resolve();
        host.registerSlot('app-header', () => null);
        host.registerExtension('ui-card', () => null);
        host.registerRoute('fixture-delayed', () => null);
      }`,
      late: `export async function register(host) {
        const s = globalThis.__uiFixture ??= { counts: {}, recover: {} };
        host.registerSlot('app-header', () => host.React.createElement('span', { 'data-ui-fixture': 'late' }, 'late'));
        await new Promise(resolve => { s.release = resolve; s.waiting = true; });
        try {
          if (s.rejectLate) throw new Error('fixture stale asynchronous failure');
          return () => { s.cleaned = (s.cleaned ?? 0) + 1; };
        } finally { s.lateSettled = (s.lateSettled ?? 0) + 1; }
      }`,
    }
    const declarations = {
      '00-timeout': { slots: ['app-header'], extensions: [{ node: 'ui-card', mode: 'extend' }], routes: [{ id: 'fixture-timeout' }] },
      missing: { slots: ['app-header', 'app-footer'], extensions: [{ node: 'ui-card', mode: 'extend' }], routes: [{ id: 'fixture-missing' }] },
      dynamic: { slots: ['app-header'], extensions: [{ node: 'ui-card', mode: 'extend' }], routes: [{ id: 'fixture-dynamic' }] },
      lazy: { slots: ['account-identities'] },
      winner: { slots: ['app-header', 'editor'] },
      suppressed: { slots: ['app-header', 'editor'] },
      delayed: { slots: ['app-header'], extensions: [{ node: 'ui-card', mode: 'extend' }], routes: [{ id: 'fixture-delayed' }] },
    }
    for (const [id, source] of Object.entries(sources)) {
      const directory = join(root, id)
      await mkdir(join(directory, 'dist'), { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: `@gw-test/ui-${id}`, version: '0.0.1', type: 'module',
        geewiki: { entry: 'index.js', client: { entry: 'client.js', css: 'client.css' },
          slots: ['app-header'], ...declarations[id], runtime: { supportsHotReload: true, requiresCachePurge: false } },
      }))
      await writeFile(join(directory, 'index.js'), 'export default function apply() {}\n')
      await writeFile(join(directory, 'dist/client.js'), source)
      await writeFile(join(directory, 'dist/client.css'), '/* isolated UI fixture */\n')
    }
    return {
      enabled: Object.keys(sources).filter(id => id !== 'late').map(id => ({ name: `@gw-test/ui-${id}` })),
      env: { GEEWIKI_UI_FIXTURE_DIR: root },
    }
  },
})
