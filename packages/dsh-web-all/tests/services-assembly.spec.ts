/**
 * Assembly wiring for the remote-access domain.
 *
 * The three fixes that make a reverse-proxied entry work (per-request Host
 * ownership, the posture readout, the plain-HTTP shims) are only reachable if
 * `assembleServices` actually mounts the domain, and the documented NetBird
 * topology runs with `noBrowserAuth: true`, i.e. without the optional
 * server-mode gateway. This test pins that wiring against a context that
 * provides nothing beyond the route/inject seats, so dropping or reordering the
 * mount turns red here instead of on a remote browser.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { assembleServices } from '../src/host/services/index.ts'
import {
  CLIPBOARD_SHIM_SCRIPT,
  HOST_ACCESS_BOOT_PATH,
  HOST_ACCESS_SESSION_PATH,
  UUID_POLYFILL_SCRIPT,
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
} {
  const store = new Map<string, unknown>()
  const routes: WebRoute[] = []
  const listeners: Array<(table: InjectionRow[]) => void> = []
  const diagnostics: Array<{ service: string; phase: string }> = []
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
      { kind: 'script', placement: 'head', text: UUID_POLYFILL_SCRIPT },
      { kind: 'script', placement: 'head', text: CLIPBOARD_SHIM_SCRIPT },
    ])

    expect(built.diagnostics.filter(row => row.service === 'remote-access')).toEqual([])
    await expect(dispose()).resolves.toBeUndefined()
  })
})