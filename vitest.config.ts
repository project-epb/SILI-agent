import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '~': resolve(__dirname, './src/plugins'),
      '$utils': resolve(__dirname, './src/utils'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'plugins/**/*.test.ts'],
    environment: 'node',
  },
})
