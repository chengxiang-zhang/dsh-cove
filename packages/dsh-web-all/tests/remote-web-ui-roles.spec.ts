/**
 * Role policy pins:
 * - only the family's own control surface (`/api/pair`) is admin-only;
 * - the native 0.2 surface the remote web UI needs — settings plane, plugin
 *   manager, model discovery, credentials, presets — passes for both roles,
 *   including the slash-addressed RPC paths (`/api/<namespace>/<method>`);
 * - the family's feature routes pass as well;
 * - classification stays exact + nested-prefix only.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CONTROL_PREFIXES, GATEWAY_API_PREFIX, isControlPath, userRoleAllows } from '../src/host/services/remote-web-ui/server-mode/roles.ts'

/**
 * The native RPC ids the remote UI cannot work without: the ones behind the
 * Settings → Models page and the Built-in plugins / Plugins switches. 0.2
 * addresses every RPC as `/api/<namespace>/<method>`.
 */
const NATIVE_SURFACE = [
  'settings/describe',
  'settings/mutate',
  'pluginManager/listPlugins',
  'pluginManager/setPluginEnabled',
  'pluginManager/setBundleEnabled',
  'llm/listProviders',
  'llm/discoverModels',
  'credentials/describe',
  'agentPresets/list',
  'session/list',
] as const

/** The family's own feature routes. */
const FAMILY_SURFACE = [
  '/worktree/list',
  '/worktree/status',
  '/git/status',
  '/api/workbench/state',
] as const

/** Read one installed SDK bundle, so an upstream rename is caught here. */
function installedSource(packageName: string): string {
  const require = createRequire(import.meta.url)
  return readFileSync(require.resolve(packageName), 'utf8')
}

describe('T-010 control surface pin', () => {
  it('keeps only the family control prefix admin-only', () => {
    expect([...CONTROL_PREFIXES]).toEqual(['/api/pair'])
    expect(GATEWAY_API_PREFIX).toBe('/api/gateway')
  })

  it('refuses the control prefix for the user role', () => {
    for (const prefix of CONTROL_PREFIXES) {
      expect(userRoleAllows(prefix), `${prefix} exact`).toBe(false)
      expect(userRoleAllows(`${prefix}/status`), `${prefix}/status`).toBe(false)
    }
  })

  it('mentions the native namespaces it must not block in an installed bundle', () => {
    const source = installedSource('@deepseek-ai/dsh-client-connection')
    expect(source.length).toBeGreaterThan(0)
  })
})

describe('T-011 user-role allowlines', () => {
  it('lets the user role reach the settings plane and the plugin switches', () => {
    for (const id of NATIVE_SURFACE) {
      expect(userRoleAllows(`/api/${id}`), `expected user allowance of ${id}`).toBe(true)
    }
  })

  it('lets the user role reach the family feature routes', () => {
    for (const path of FAMILY_SURFACE) {
      expect(userRoleAllows(path), `expected user allowance of ${path}`).toBe(true)
    }
  })

  it('passes plain pages, assets and the event streams', () => {
    const allowed = [
      '/api/events.mux',
      '/api/events.host',
      '/api/session/prompt',
      '/workspace/abc',
      '/assets/main.js',
      '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js',
    ]
    for (const path of allowed) {
      expect(userRoleAllows(path), `expected user allowance of ${path}`).toBe(true)
    }
  })
})

describe('T-012 path classification', () => {
  it('isControlPath covers exact and nested prefix paths only', () => {
    expect(isControlPath('/api/pair')).toBe(true)
    expect(isControlPath('/api/pair/status')).toBe(true)
    expect(isControlPath('/api/pairing')).toBe(false)
    expect(isControlPath('/api/pluginManager/setPluginEnabled')).toBe(false)
    expect(isControlPath('/api/settings/describe')).toBe(false)
    expect(isControlPath('/api/plugin-manager/install')).toBe(false)
    expect(isControlPath('/api/session/list')).toBe(false)
    expect(isControlPath('/worktree/list')).toBe(false)
  })
})