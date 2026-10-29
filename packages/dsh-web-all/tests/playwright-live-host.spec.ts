/** host-side live-view 辅助单测：CDP 端点解析与配置默认值。 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCdpEndpoint, waitForCdpEndpoint } from '../src/host/services/playwright-sessions/child.ts'
import { playwrightToolNeedsApproval, playwrightToolRisk, resolvePlaywrightSessionsConfig } from '../src/core/playwright-sessions/contracts.ts'

describe('playwright-sessions live-view CDP endpoint', () => {
  it('parses the DevToolsActivePort file into a browser websocket endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-dta-'))
    writeFileSync(join(dir, 'DevToolsActivePort'), '41234\n/devtools/browser/abc-123\n', 'utf8')
    expect(readCdpEndpoint(dir)).toBe('ws://127.0.0.1:41234/devtools/browser/abc-123')
    rmSync(dir, { recursive: true, force: true })
  })

  it('waits for the port file to appear with a bounded window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-dta-wait-'))
    setTimeout(() => { writeFileSync(join(dir, 'DevToolsActivePort'), '55555\n/devtools/browser/x\n', 'utf8') }, 50)
    await expect(waitForCdpEndpoint(dir, 2000)).resolves.toBe('ws://127.0.0.1:55555/devtools/browser/x')
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails when the port file never appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-dta-none-'))
    await expect(waitForCdpEndpoint(dir, 300)).rejects.toThrow(/did not appear/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('playwright-sessions live-view config', () => {
  it('defaults liveView to false and honors an explicit launch flag', () => {
    expect(resolvePlaywrightSessionsConfig().liveView).toBe(false)
    expect(resolvePlaywrightSessionsConfig({}).liveView).toBe(false)
    expect(resolvePlaywrightSessionsConfig({ liveView: true }).liveView).toBe(true)
    expect(resolvePlaywrightSessionsConfig({ liveView: false }).liveView).toBe(false)
  })

  it('resolves extension mode as one attended external browser without live view', () => {
    const resolved = resolvePlaywrightSessionsConfig({ mode: 'extension', liveView: true })
    expect(resolved.mode).toBe('extension')
    expect(resolved.liveView).toBe(false)
    expect(resolved.maxConcurrentBrowsers).toBe(1)
    expect(resolved.unsafeTools).toBe(false)
    expect(resolved.approvalPolicy).toBe('mutations')
  })

  it('classifies local Chrome tool risks and approval policies', () => {
    expect(playwrightToolRisk('browser_snapshot')).toBe('read')
    expect(playwrightToolRisk('browser_click')).toBe('mutation')
    expect(playwrightToolRisk('browser_evaluate')).toBe('unsafe')
    expect(playwrightToolNeedsApproval('browser_snapshot', 'mutations')).toBe(false)
    expect(playwrightToolNeedsApproval('browser_click', 'unsafe')).toBe(false)
    expect(playwrightToolNeedsApproval('browser_click', 'mutations')).toBe(true)
    expect(playwrightToolNeedsApproval('browser_evaluate', 'unsafe')).toBe(true)
  })
})