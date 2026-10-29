import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Published SDK browser bundles import their CSS assets from the package
  // entrypoint. Keep those modules in Vite's transform pipeline instead of
  // handing them directly to Node's ESM loader.
  css: {
    devSourcemap: false,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
