import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 开发模式：前端 5173 端口，/api 代理到 GeeWiki 后端（默认 3000）
  server: {
    // 显式监听通配地址（Linux 上 '::' 为双栈），为保证 localhost 在 IPv4/IPv6 解析下都可访问：
    // 默认写法在某些环境下只绑定 IPv6 回环 [::1]，导致只走 IPv4 的浏览器访问 http://127.0.0.1:5173/ 被拒绝。
    host: '::',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  base: '/',
})
