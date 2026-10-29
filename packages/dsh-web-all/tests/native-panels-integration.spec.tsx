// @vitest-environment jsdom
/**
 * Position-module integration: who owns which seat.
 *
 * The sidebar renders SSH and memoir as native panellist pages and must not
 * carry a worktree row anymore; the worktree browser half belongs to the
 * conversation position module, which registers the branch picker (composer
 * dock) and the header lane chip, and owns the `worktree` locale namespace the
 * chip's menu and dialogs speak.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/conversation/subagent-model.ts', () => ({
  mountSubagentModel: () => () => {},
}))

import {
  MEMOIR_PANEL_ID,
  SSH_PANEL_ID,
  registerNativePanels,
} from '../src/client/sidebar/native-panels.tsx'
import { mountConversation } from '../src/client/conversation/index.ts'

/** Records the slot registrations a position module makes. */
function makeSlots() {
  const seats: Array<{ name: string; options: Record<string, unknown>; body: unknown }> = []
  return {
    seats,
    slots: {
      inject(_name: string, factory: () => (() => void) | void) { factory(); return () => {} },
      register(options: Record<string, unknown>, body: unknown) {
        seats.push({ name: String(options['name']), options, body })
        return () => {}
      },
    },
  }
}

describe('sidebar position module', () => {
  it('registers SSH and memoir as panellist rows plus main panels', () => {
    const { seats, slots } = makeSlots()
    const selectPanel = vi.fn<(id: string | null) => void>()
    const openSession = vi.fn<(id: string) => void>()
    const listeners = new Set<() => void>()
    const ctx = {
      slots,
      get(name: string) {
        if (name === 'layout') {
          return {
            selectPanel: (id: string | null) => { selectPanel(id); for (const listener of listeners) listener() },
            panelInfo: {
              getSnapshot: () => ({ activePanelId: selectPanel.mock.calls.at(-1)?.[0] ?? null }),
              subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
            },
          }
        }
        if (name === 'workspaces') return { startSession: vi.fn() }
        if (name === 'sessions') {
          return { list: { getSnapshot: () => ({ current: undefined, byId: { 'session-a': { cwd: '/repo' } } }), subscribe: () => () => {} } }
        }
        // 0.2 selection cell: the memoir page resolves its project from here
        // and opens a memory's source session through it (sessions.open is gone).
        if (name === 'uiWorkspace') {
          return { selection: { getSnapshot: () => ({ sessionId: 'session-a' }), subscribe: () => () => {} }, openSession }
        }
        return undefined
      },
      locale: { bind: () => (key: string) => key },
    }

    const dispose = registerNativePanels(ctx as never)

    const rows = seats.filter(seat => seat.name === 'sidebar.panellist')
    const mains = seats.filter(seat => seat.name === 'main')
    expect(rows.map(row => row.options['id'])).toEqual([SSH_PANEL_ID, MEMOIR_PANEL_ID])
    expect(rows.map(row => row.options['order'])).toEqual([30, 31])
    expect(mains.map(main => main.options['key'])).toEqual([SSH_PANEL_ID, MEMOIR_PANEL_ID])
    // The memoir page receives a tracker wired to the live selection sources, so
    // the panel can load the project memory of the session the operator is in
    // (DSH 0.2 no longer exposes sessions.list.current).
    const memoirProps = (mains[1]!.options['inject'] as () => { cwdTracker: { getSnapshot(): string }; openSource(sessionId: string): void })()
    expect(memoirProps.cwdTracker.getSnapshot()).toBe('/repo')
    // Opening a memory's source session goes through the 0.2 selection API.
    memoirProps.openSource('session-b')
    expect(openSession).toHaveBeenCalledWith('session-b')
    // No worktree page: the sidebar is not a worktree surface anymore.
    expect(seats.some(seat => String(seat.options['id'] ?? seat.options['key'] ?? '').includes('worktree'))).toBe(false)
    dispose()
  })
})

describe('conversation position module', () => {
  it('owns the branch picker, the lane chip, and the worktree copy they speak', () => {
    const { seats, slots } = makeSlots()
    const registered: string[] = []
    const ctx = {
      slots,
      get(name: string) {
        if (name === 'sessions') {
          return { list: { getSnapshot: () => ({ current: undefined, byId: {} }), subscribe: () => () => {} } }
        }
        if (name === 'uiWorkspace') return { openSession: vi.fn() }
        return undefined
      },
      locale: {
        register: (namespace: string) => { registered.push(namespace); return () => {} },
        bind: () => (key: string) => key,
      },
    }

    const dispose = mountConversation(ctx as never)

    expect(seats.map(seat => seat.name)).toEqual(['conversation.input.dock', 'conversation.session.header.actions'])
    expect(seats[0]?.options['id']).toBe('web-all-git-branch-chip')
    expect(seats[1]?.options['id']).toBe('web-all-session-lane-chip')
    // The lane chip's popover and dialogs run on the worktree namespace, so the
    // module that mounts the chip has to register it.
    expect(registered).toContain('worktree')
    dispose()
  })
})