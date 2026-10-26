#!/usr/bin/env node
/** 在临时数据库、配置和自动分配的端口上运行核心流程；--dev 验证 Vite 路径。 */
import { runBrowserFlow } from './lib/run-browser.mjs'

await runBrowserFlow({ name: 'core-flow', script: 'core-flow-cdp.mjs' })
