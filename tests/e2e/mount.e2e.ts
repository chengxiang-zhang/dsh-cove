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
]

test('single entity mounts its position modules without browser errors', async ({ page }, testInfo) => {
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
  await openSettings(page)
  await page.getByText('Built-in plugins', { exact: true }).first().click()
  await page.getByRole('tab', { name: /Feishu|飞书/ }).first().click()
  await expect(page.locator('[data-dsh-plugin="lark-inbox"][data-dsh-part="settings"]')).toHaveCount(1)
  await expect(page.getByText(/Feishu connection and settings|飞书连接与配置/).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Failed to load plugins/i)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('desktop-feishu.png'), fullPage: true })
  expect(pageErrors, 'page errors').toEqual([])
  expect(pluginConsoleErrors, 'entity console errors').toEqual([])
})

async function clickShellButton(page: Page, name: string | RegExp): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissFirstRunDialogs(page)
    try {
      await page.getByRole('button', { name, exact: true }).first().click({ timeout: 5_000 })
      return
    } catch (error) { if (attempt === 2) throw error }
  }
}

/** Settings moved under Account menu in DSH 0.2.1; keep the 0.2.0 path. */
async function openSettings(page: Page): Promise<void> {
  const legacySettings = page.getByRole('button', { name: 'Settings', exact: true }).first()
  if (await legacySettings.isVisible().catch(() => false)) await legacySettings.click()
  else {
    // DSH 0.2.1 renders the account menu as a masked popover: 设置/意见反馈/登录 (Settings /
    // Feedback / Sign in) above a "More" row. Two things bite the release smoke here - the
    // trigger is named in the shell's locale, and the popover's full-screen mask outlives
    // the selection, swallowing the next click inside the settings sheet.
    await clickShellButton(page, /^(?:Account menu|账号菜单)$/)
    await page.getByRole('menuitem', { name: /^(?:Settings|设置)$/ }).first().click()
    await page
      .locator('div[aria-hidden="true"][class*="_mask_"]')
      .first()
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(() => {})
  }
  await expect(page.getByText('Built-in plugins', { exact: true })).toBeVisible({ timeout: 15_000 })
}

for (const width of [320, 390]) test(`family panels and settings remain usable at phone width ${width}px`, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width, height: 844 })
  await page.goto(BASE_URL!, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: 'SSH', exact: true })).toBeVisible({ timeout: 30_000 })
  await dismissFirstRunDialogs(page)
  await clickShellButton(page, 'SSH')
  await expect(page.getByText('Remote SSH', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('phone-ssh.png'), fullPage: true })
  await clickShellButton(page, /^(?:Memory|记忆)$/)
  await expect(page.getByText('Memory Memoir', { exact: true })).toBeVisible()
  await openSettings(page)
  await page.getByText('Built-in plugins', { exact: true }).click()
  await page.getByRole('tab', { name: /Feishu|飞书/ }).click()
  await expect(page.locator('[data-dsh-plugin="lark-inbox"][data-dsh-part="settings"]')).toBeVisible()
  const form = page.locator('[data-dsh-plugin="lark-inbox"][data-dsh-part="settings"]')
  await expect.poll(async () => (await form.boundingBox())?.width ?? 0).toBeGreaterThan(width - 70)
  const title = page.locator('[data-slot="settings.header"]')
  const action = page.getByRole('button', { name: 'Open configuration file', exact: true })
  const titleBox = await title.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const box = range.getBoundingClientRect()
    return { x: box.x, width: box.width }
  })
  const actionBox = (await action.boundingBox())!
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(actionBox.x)
  await page.screenshot({ path: testInfo.outputPath('phone-feishu.png'), fullPage: true })
  expect(errors).toEqual([])
})

test('family settings save and reload through the native form API', async ({ page }) => {
  await page.goto(BASE_URL!, { waitUntil: 'domcontentloaded' })
  // The shell mounts its rows asynchronously. Without this wait the account-menu click
  // races the first render and burns clickShellButton's retries on a slow runner: the
  // v0.6.1 release run failed here twice at desktop width while the phone-width cases,
  // which do wait for a shell button first, passed.
  await expect(page.getByRole('button', { name: 'SSH', exact: true })).toBeVisible({ timeout: 30_000 })
  await openSettings(page)
  const openFeishu = async () => {
    await page.getByText('Built-in plugins', { exact: true }).click()
    await page.getByRole('tab', { name: /Feishu|飞书/ }).click()
    await expect(page.locator('[data-dsh-plugin="lark-inbox"] [data-field="announceToAgent"] input[type="checkbox"]')).toBeEnabled()
  }
  await openFeishu()
  const original = await page.locator('[data-dsh-plugin="lark-inbox"] [data-field="announceToAgent"] input[type="checkbox"]').isChecked()
  await page.locator('[data-dsh-plugin="lark-inbox"] [data-field="announceToAgent"] input[type="checkbox"]').setChecked(!original)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await page.reload()
  await openSettings(page)
  await openFeishu()
  await expect(page.locator('[data-dsh-plugin="lark-inbox"] [data-field="announceToAgent"] input[type="checkbox"]')).toBeChecked({ checked: !original })
  await page.locator('[data-dsh-plugin="lark-inbox"] [data-field="announceToAgent"] input[type="checkbox"]').setChecked(original)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
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
