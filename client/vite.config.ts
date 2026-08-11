import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(import.meta.dirname, '..'), '')
  const firstValue = (...names: string[]) => {
    for (const name of names) {
      const value = process.env[name] ?? env[name]
      if (value) return value
    }
    return undefined
  }
  const serverPort = firstValue('LLMHARBOR_DASHBOARD_PORT', 'DASHBOARD_PORT', 'PORT') ?? '3001'
  const configuredHost = firstValue('LLMHARBOR_DASHBOARD_HOST', 'DASHBOARD_HOST', 'HOST') ?? '127.0.0.1'
  const proxyHost = configuredHost === '0.0.0.0' || configuredHost === '::' ? '127.0.0.1' : configuredHost
  const proxyUrlHost = proxyHost.includes(':') && !proxyHost.startsWith('[') ? `[${proxyHost}]` : proxyHost
  const proxyTarget = `http://${proxyUrlHost}:${serverPort}`

  return {
    plugins: [react(), tailwindcss()],
    base: firstValue('VITE_BASE') ?? '/',
    envDir: path.resolve(import.meta.dirname, '..'),
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': proxyTarget,
        '/v1': proxyTarget,
        '/e': proxyTarget,
      },
    },
  }
})
