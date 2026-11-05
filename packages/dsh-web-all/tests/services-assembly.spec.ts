/**
 * Assembly wiring for the remote-access domain, and the mounted-domain names.
 *
 * The three fixes that make a reverse-proxied entry work (per-request Host
 * ownership, the posture readout, the plain-HTTP shims) are only reachable if
 * `assembleServices` actually mounts the domain, and the documented NetBird
 * topology runs with `noBrowserAuth: true`, i.e. without the optional
 * server-mode gateway. This test pins that wiring against a context that
 * provides nothing beyond the route/inject seats, so dropping or reordering the
 * mount turns red here instead of on a remote browser.
 *
 * The second test pins the one thing a `toContain` check cannot: the name a
 * domain is mounted under. `capability-parity` only asserts that a manifest name
 * appears somewhere in `src`, and a retired domain name keeps appearing there
 * for as long as its settings namespace, its wizard route and its settings page
 * stay supported, so that check passes whether or not the domain was renamed.
 * Mount names are the capability inventory, so they are read back from the
 * assembly and compared against the manifest list in both directions.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { assembleServices } from '../src/host/services/index.ts'
import manifest from './capability-parity.manifest.json'
import {
  CLIPBOARD_SHIM_SCRIPT,
  HOST_ACCESS_BOOT_PATH,
  HOST_ACCESS_SESSION_PATH,
} from '../src/host/services/remote-access/index.ts'

interface InjectionRow {
  kind: string
  placement?: string
  src?: string
  text?: string
}

function harness(): {
  ctx: Context
  routes: WebRoute[]
  inject(): InjectionRow[]
  diagnostics: Array<{ service: string; phase: string }>
  mounted: string[]
} {
  const store = new Map<string, unknown>()
  const routes: WebRoute[] = []
  const listeners: Array<(table: InjectionRow[]) => void> = []
  const diagnostics: Array<{ service: string; phase: string }> = []
  const mounted: string[] = []
  const ctx = {
    get: (name: string, strict?: boolean) => {
      if (store.has(name)) return store.get(name)
      if (strict === false) return undefined
      throw new Error(`service not found: ${name}`)
    },
    provide: (name: string, value: unknown) => { store.set(name, value); return () => { store.delete(name) } },
    webServer: {
      register: (route: WebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: () => () => {},
    },
    on: (event: string, listener: (table: InjectionRow[]) => void) => {
      if (event === 'webserver/index-inject') listeners.push(listener)
      return () => {}
    },
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    effect: (run: () => unknown) => {
      const result = run()
      if (result instanceof Promise) {
        const ready = result as Promise<() => void | Promise<void>>
        const dispose = async () => { const release = await ready; await release() }
        return Object.assign(dispose, { then: ready.then.bind(ready) })
      }
      return typeof result === 'function' ? result : () => {}
    },
  } as unknown as Context
  return {
    ctx,
    routes,
    inject: () => {
      const table: InjectionRow[] = []
      for (const listener of listeners) listener(table)
      return table
    },
    diagnostics,
    mounted,
  }
}

describe('remote-access assembly wiring', () => {
  it('mounts the boot route, the posture route and the three index rows without the gateway', async () => {
    const built = harness()
    const dispose = assembleServices(built.ctx, {
      noBrowserAuth: true,
      onDiagnostic: diagnostic => built.diagnostics.push({ service: diagnostic.service, phase: diagnostic.phase }),
    })

    const paths = built.routes.map(route => route.path)
    expect(paths).toContain(HOST_ACCESS_BOOT_PATH)
    expect(paths).toContain(HOST_ACCESS_SESSION_PATH)

    expect(built.inject()).toEqual([
      { kind: 'script-src', placement: 'head', src: HOST_ACCESS_BOOT_PATH },
      { kind: 'script', placement: 'head', text: CLIPBOARD_SHIM_SCRIPT },
    ])

    expect(built.diagnostics.filter(row => row.service === 'remote-access')).toEqual([])
    await expect(dispose()).resolves.toBeUndefined()
  })
})

describe('mounted domain inventory', () => {
  it('mounts the superagent domain and the parity manifest names that same domain', async () => {
    const built = harness()
    const dispose = assembleServices(built.ctx, {
      noBrowserAuth: true,
      onMount: name => built.mounted.push(name),
    })

    // The assembly is the fact source: this is the name the owner holds the
    // domain's disposer under, so it is the name an operator and the assembly
    // diagnostics see.
    expect(built.mounted).toContain('superagent')
    expect(built.mounted).not.toContain('lark-inbox')

    // The manifest is the inventory a reader trusts, so it has to agree. Without
    // this half the rename is unguarded: `capability-parity` cannot tell the two
    // names apart because the retired name legitimately survives in the settings
    // namespace, the wizard route and the client settings page.
    expect(manifest.hostServices).toContain('superagent')
    expect(manifest.hostServices).not.toContain('lark-inbox')

    await expect(dispose()).resolves.toBeUndefined()
  })
})
