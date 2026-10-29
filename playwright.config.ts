import { defineConfig } from '@playwright/test'

/**
 * Headless-render lane config for the web-all mount smoke
 * (`scripts/e2e-mount.sh` + `tests/e2e/mount.e2e.ts`). The server is booted
 * by the shell script; the spec only loads the page against `DSH_E2E_URL`.
 * Serial by design: one scratch DSH instance per run.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // The mount lane files are named *.e2e.ts (mirroring the better-sidebar
  // repo convention) — outside Playwright's default *.test.* match.
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    // This lane also runs inside a 7 GB GitHub runner, where Chromium's default
    // /dev/shm (64 MB) and its GPU probe are the classic silent-crash pair - a mount
    // lane that dies there reports nothing at all. Both flags change how the browser
    // starts, not what the lane asserts.
    launchOptions: { args: ['--disable-dev-shm-usage', '--disable-gpu'] },
    // The shell localizes its own rows and the entity localizes the family rows
    // from the browser's locale. Pin one so the lane asserts the same strings on
    // every machine and in CI instead of inheriting the runner's locale.
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  },
})
