/** Real DSH mount lane for the position-owned @dsh-cove/dsh-web-all entity. */
import { test, expect, type Page } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) throw new Error('DSH_E2E_URL is not set; start an isolated dsh web profile first')

/**
 * The entity's sidebar surfaces on DSH 0.2: the family panels are native
 * `sidebar.panellist` rows next to the shell's own Plugins row and Settings
 * control. The lane pins an English browser locale (see playwright.config.ts)
 * and accepts either spelling of the localized family label, so a copy change
 * in either dictionary cannot fail the mount check. Feishu is not a sidebar row
 * any more: its connection wizard and settings live in the Built-in plugins
 * settings tab.
 */
const ENTRY_NAMES = [
  /^Plugins$/,
  /^SSH$/,
  /^(?:记忆|Memory)$/,
  /^Settings$/,
]

test('single entity mounts its position modules without browser errors', async ({ page }) => {
  const pageErrors: string[] = []
  const pluginConsoleErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/web-all|git-graph|workbench|lark-inbox/i.test(text)) pluginConsoleErrors.push(text)
  })

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  // The first-run notice mounts asynchronously and its mask swallows pointer
  // events, so wait for the shell first, then dismiss whatever notice appears
  // (localized: match a Continue-like control, then fall back to Escape).
  await expect(page.getByRole('button', { name: /^Plugins$/ }).first()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2_000)

  await dismissFirstRunDialogs(page)

  for (const name of ENTRY_NAMES) await expect(page.getByRole('button', { name }).first()).toBeVisible({ timeout: 30_000 })

  // The family panels open through the shell's native main slot: clicking a row
  // selects the panel, and the panel body renders inside `main`.
  //
  // The click is retried with the dismissal in front of it, because DSH's provider dialog
  // mounts asynchronously: on a slow runner it can land after the dismissal above and
  // swallow this click. When it still cannot be clicked, ask the page what is actually at
  // that point and report it - `elementFromPoint` names the element the browser would
  // deliver the click to, which is the one fact a retry log cannot give.
  let clicked = false
  let clickError: unknown = null
  for (let attempt = 0; attempt < 3 && !clicked; attempt += 1) {
    await dismissFirstRunDialogs(page)
    clicked = await page
      .getByRole('button', { name: 'SSH' })
      .first()
      .click({ timeout: 10_000 })
      .then(() => true)
      .catch(error => {
        clickError = error
        return false
      })
  }
  if (!clicked) {
    const topmost = await page
      .evaluate(() => {
        const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
        const root = element?.closest('[role="presentation"], [role="dialog"], [data-dsh-part]') ?? element
        const controls = [...(root?.querySelectorAll('button, [role="button"]') ?? [])]
          .map(control => (control.getAttribute('aria-label') || control.textContent || '').trim())
          .filter(name => name !== '')
        return {
          top: element?.className ?? null,
          topTag: element?.tagName ?? null,
          rootClass: root?.className ?? null,
          text: (root?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 400),
          controls,
          html: (root?.outerHTML ?? '').slice(0, 600),
        }
      })
      .catch(describeError => ({ describeError: String(describeError) }))
    throw new Error(`clicking the SSH row was intercepted by ${JSON.stringify(topmost)} (${String(clickError).slice(0, 120)})`)
  }
  await expect(page.getByText(/Hosts|主机/).first()).toBeVisible({ timeout: 15_000 })
  // The Feishu page is the Built-in plugins settings tab, present only while the
  // host serves the family settings entry.
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByText('Built-in plugins', { exact: true }).first().click()
  await page.getByRole('tab', { name: /Feishu|飞书/ }).first().click()
  await expect(page.locator('[data-dsh-plugin="lark-inbox"][data-dsh-part="settings"]')).toHaveCount(1)
  await expect(page.getByText(/Feishu connection and settings|飞书连接与配置/).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Failed to load plugins/i)).toHaveCount(0)
  expect(pageErrors, 'page errors').toEqual([])
  expect(pluginConsoleErrors, 'entity console errors').toEqual([])
})

/**
 * Clear whatever first-run dialog the shell put up.
 *
 * Two are known. DSH's own notice ("Continue" and friends), and - on a profile with no
 * model credentials, which is exactly a clean runner - DSH's "Add an API key to get
 * started" dialog. The second one is what stopped this lane on CI: its mask swallowed
 * every click on the SSH row while the test's label list could not match it. It is
 * dismissed by its own wording, and never through "Save and continue": submitting an
 * empty key is not this lane's business.
 *
 * The dialogs mount asynchronously, so this runs again in front of every click that can
 * be intercepted rather than once when the page loads.
 */
async function dismissFirstRunDialogs(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const keyDialog = page.getByRole('dialog', { name: /API key|密钥/i }).first()
    if (await keyDialog.isVisible().catch(() => false)) {
      await keyDialog
        .getByRole('button', { name: /Configure later|稍后|以后再说|暂不配置/i })
        .first()
        .click({ force: true })
        .catch(() => {})
      await keyDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    }
    const notice = page.getByRole('button', { name: /^(?:Continue|继续|知道了|OK|Got it)$/ }).first()
    if (await notice.isVisible().catch(() => false)) {
      await notice.click({ force: true }).catch(() => {})
      await notice.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    }
    const mask = page.locator('div[aria-hidden="true"][class*="_mask_"]').first()
    if (!(await mask.isVisible().catch(() => false))) break
    await page.keyboard.press('Escape').catch(() => {})
    await mask.click({ force: true, position: { x: 5, y: 5 } }).catch(() => {})
    await page.waitForTimeout(500)
  }
}
