/**
 * Bridge internals for the restored codex-bridge service domain (no
 * network): stable api key persistence, config.yaml generation, and the
 * provider-profile builder.
 *
 * Ported from the pre-merge @dsh-cove/dsh-codex-bridge package tests
 * (tests/bridge.spec.ts); the modules under test moved into the dsh-web-all
 * host services.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiProxyBridge } from '../src/host/services/codex-bridge/bridge.ts'
import { buildProviderProfile, serviceableModels } from '../src/host/services/codex-bridge/dsh-integration.ts'

let dirs: string[] = []
beforeEach(() => {
  dirs = []
})
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `codex-bridge-${tag}-`))
  dirs.push(dir)
  return dir
}

describe('ApiProxyBridge key + config', () => {
  it('mints a stable api key across instances', () => {
    const dir = tempDir('key')
    const bridge = new ApiProxyBridge({ proxyDir: dir })
    const key = bridge.apiKey()
    expect(key).toMatch(/^sk-[0-9a-f]{48}$/)
    const second = new ApiProxyBridge({ proxyDir: dir })
    expect(second.apiKey()).toBe(key)
    expect(readFileSync(join(dir, '.api-key'), 'utf8').trim()).toBe(key)
  })

  it('honours a configured api key', () => {
    const bridge = new ApiProxyBridge({ proxyDir: tempDir('cfg'), apiKey: 'sk-configured' })
    expect(bridge.apiKey()).toBe('sk-configured')
  })

  it('writes a valid config.yaml with the codex auth file and api key', () => {
    const dir = tempDir('cfg')
    const bridge = new ApiProxyBridge({ proxyDir: dir, port: 8457, authFile: '~/.codex/auth.json' })
    const { key, configPath } = bridge.ensureConfig()
    expect(configPath).toBe(join(dir, 'config.yaml'))
    expect(existsSync(configPath)).toBe(true)
    const text = readFileSync(configPath, 'utf8')
    expect(text).toContain(`port: 8457`)
    expect(text).toContain(`codex-auth-file: "~/.codex/auth.json"`)
    expect(text).toContain(`- "${key}"`)
    expect(text).toContain('stats:')
  })
})

describe('provider profile builder', () => {
  it('filters unsupported model ids', () => {
    expect(
      serviceableModels([
        'gpt-reserve',
        'codex-auto-review',
        'gpt-5.5',
        'o3',
        'gpt-4o',
        'codex-mini',
        'gpt-6-sol',
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-6-luna',
      ]),
    ).toEqual(['gpt-5.5', 'o3', 'codex-mini', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])
  })

  it('builds a pi-ai profile with reasoning efforts on every model', () => {
    const profile = buildProviderProfile('http://127.0.0.1:8317/v1', ['gpt-5.5', 'gpt-5.6-terra'])
    expect(profile.apiKeyEnv).toBe('DSH_API_PROXY_KEY')
    expect(profile.api).toBe('openai-completions')
    expect(profile.baseURL).toBe('http://127.0.0.1:8317/v1')
    expect(profile.reasoning).toBe('high')
    expect(profile.models).toHaveLength(2)
    for (const model of profile.models) {
      expect(model.input).toEqual(['text'])
      expect(model.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })
})

describe('bridge status wiring', () => {
  it('reports stopped with a missing auth file', async () => {
    const dir = tempDir('status')
    // A port nothing listens on keeps the status probe deterministic.
    const bridge = new ApiProxyBridge({ proxyDir: dir, port: 8417, authFile: join(dir, 'no-auth.json') })
    const status = await bridge.status({ present: false, valid: false })
    expect(status.proxy).toBe('stopped')
    expect(status.auth.valid).toBe(false)
    expect(status.baseURL).toBe('http://127.0.0.1:8417')
  })
})