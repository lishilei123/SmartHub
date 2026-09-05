import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    server: {
      proxy: {
        '/api': {
          target: env.SMART_HUB_DEV_API_TARGET || 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
      },
    },
  }
})
