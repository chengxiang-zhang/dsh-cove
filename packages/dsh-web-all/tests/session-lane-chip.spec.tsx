// @vitest-environment jsdom
/**
 * Browser-half tests for the conversation header lane chip: status
 * precedence, the render/degrade rules (a header must never break, and a
 * session off a lane must render nothing), locale parity, and the seat
 * registration contract.
 */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { LaneView } from '../src/core/worktree/types.ts'
import {
  SessionLaneChip, laneStatusKey, mountSessionLaneChip, sessionLaneEn, sessionLaneZh,
  type SessionLaneKey,
} from '../src/client/conversation/session-lane-chip.tsx'

function laneView(overrides: Partial<LaneView> = {}): LaneView {
  return {
    name: 'feature/x',
    branch: 'feature/x',
    path: '/repo/.dsh/workspaces/feature/x',
    repoPath: '/repo',
    exists: true,
    workspaceId: null,
    sessionId: null,
    permissionPresetApplied: null,
    dirty: 0,
    pushed: false,
    remoteBranchGone: false,
    merged: false,
    prUrl: null,
    prNumber: null,
    ...overrides,
  }
}

const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}(${JSON.stringify(params)})`

/** Render the chip and flush the lane lookup promise. */
/**
 * The bind half of the API: recording a conversation on its lane. It answers
 * without a lane view (a shape the host allows), so the chip keeps rendering
 * whatever the lookup returned — these tests are about the chip, not about the
 * host's post-bind snapshot.
 */
const bindLane = vi.fn(async (_input: { repoPath: string; branch: string; sessionId: string }) => ({
  lane: null,
  permissionPresetApplied: true,
}))

async function renderChip(props: {
  sessionId?: string
  lane: (input: { sessionId?: string; path?: string }) => Promise<LaneView | null>
  repoStatus?: (sessionId: string) => Promise<{ root: string; branch: string; head: string; dirtyFiles: number; untrackedFiles: number; conflicts: number; operationInProgress: boolean } | null>
  /** Whether the conversation is running a turn (the lane menu reads it). */
  running?: (sessionId: string) => boolean
  /** Override the API stub (a refusal, or a missing bind call). */
  api?: Record<string, unknown>
}): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const Chip = SessionLaneChip as unknown as (p: Record<string, unknown>) => ReturnType<typeof createElement>
  await act(async () => {
    root.render(createElement(Chip, {
      sessionId: props.sessionId,
      lane: props.lane,
      repoStatus: props.repoStatus ?? (async () => null),
      running: props.running ?? (() => false),
      api: props.api ?? { bindLane },
      worktreeT: t,
      t,
    }))
  })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

describe('laneStatusKey', () => {
  it('prefers uncommitted work over every other fact', () => {
    expect(laneStatusKey(laneView({ dirty: 2, merged: true, prNumber: 7, pushed: true }))).toBe('lane.dirty')
  })

  it('then merge state, then the PR, then pushed, then local', () => {
    expect(laneStatusKey(laneView({ dirty: 0, merged: true, prNumber: 7, pushed: true }))).toBe('lane.merged')
    expect(laneStatusKey(laneView({ prNumber: 7, pushed: true }))).toBe('lane.pr')
    expect(laneStatusKey(laneView({ pushed: true }))).toBe('lane.pushed')
    expect(laneStatusKey(laneView())).toBe('lane.local')
  })

  it('treats an unknown dirty count as clean rather than as work in progress', () => {
    expect(laneStatusKey(laneView({ dirty: null }))).toBe('lane.local')
  })
})

describe('SessionLaneChip', () => {
  it('renders the branch and the status on the lane', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ prNumber: 12, pushed: true }),
    })
    const chip = container.querySelector('[data-dsh-part="lane-chip"]')
    expect(chip).not.toBeNull()
    expect(chip?.getAttribute('data-dsh-plugin')).toBe('worktree')
    expect(container.textContent).toContain('feature/x')
    // The status word comes from the namespace translator; the fake `t`
    // renders the key plus its params, so the PR number must be in there.
    expect(container.textContent).toContain('lane.pr')
    expect(container.textContent).toContain('"number":12')
    unmount()
  })

  it('renders nothing off a lane (the main checkout)', async () => {
    const { container, unmount } = await renderChip({ sessionId: 'session-1', lane: async () => null })
    expect(container.querySelector('[data-dsh-part="lane-chip"]')).toBeNull()
    expect(container.textContent).toBe('')
    unmount()
  })

  it('renders nothing for a detached lane (no branch)', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ branch: null }),
    })
    expect(container.querySelector('[data-dsh-part="lane-chip"]')).toBeNull()
    unmount()
  })

  it('renders nothing when the lookup fails, so a header can never break', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => { throw new Error('transport down') },
    })
    expect(container.querySelector('[data-dsh-part="lane-chip"]')).toBeNull()
    unmount()
  })

  it('renders nothing without a session id', async () => {
    const lookup = vi.fn(async () => laneView())
    const { container, unmount } = await renderChip({ lane: lookup })
    expect(container.querySelector('[data-dsh-part="lane-chip"]')).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
    unmount()
  })

  it('flags a lane whose required preset could not be applied', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ permissionPresetApplied: false }),
    })
    expect(container.textContent).toContain('lane.presetMissing')
    unmount()
  })

  it('does not warn for older lanes whose preset state is unknown', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ permissionPresetApplied: null }),
    })
    expect(container.textContent).not.toContain('lane.presetMissing')
    unmount()
  })

  it('makes the lane chip the lane menu trigger, closed until asked', async () => {
    const { container, unmount } = await renderChip({ sessionId: 'session-1', lane: async () => laneView() })
    const chip = container.querySelector('[data-dsh-part="lane-chip"]')

    expect(chip?.tagName).toBe('BUTTON')
    expect(chip?.getAttribute('aria-haspopup')).toBe('menu')
    expect(chip?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-dsh-part="lane-menu"]')).toBeNull()

    await act(async () => { (chip as HTMLButtonElement).click() })

    expect(chip?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-dsh-part="lane-menu"]')).not.toBeNull()
    unmount()
  })

  it('keeps the main checkout chip read-only: there is no lane to finish off', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => null,
      repoStatus: async () => ({ root: '/repo', branch: 'dev', head: 'deadbee', dirtyFiles: 0, untrackedFiles: 0, conflicts: 0, operationInProgress: false }),
    })
    const chip = container.querySelector('[data-dsh-kind="main"]')

    expect(chip?.tagName).toBe('SPAN')
    expect(container.querySelector('button')).toBeNull()
    unmount()
  })

  it('records a conversation whose cwd is a lane as that lane\'s own', async () => {
    // However the conversation got onto the lane (the branch picker, the
    // shell's own workspace selector, a restored selection), the pairing is
    // recorded the first time the chip sees it: the lane's permission preset
    // and the teardown guards both key off it.
    bindLane.mockClear()
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ sessionId: null }),
    })
    expect(bindLane).toHaveBeenCalledWith({ repoPath: '/repo', branch: 'feature/x', sessionId: 'session-1' })
    expect(container.textContent).not.toContain('lane.presetMissing')
    unmount()
  })

  it('warns when the lane binding could not be recorded', async () => {
    const refused = vi.fn(async () => { throw new Error('forbidden') })
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ sessionId: null }),
      api: { bindLane: refused },
    })
    expect(refused).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('lane.presetMissing')
    unmount()
  })

  it('leaves an already recorded lane alone', async () => {
    bindLane.mockClear()
    const { unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ sessionId: 'session-1' }),
    })
    expect(bindLane).not.toHaveBeenCalled()
    unmount()
  })

  it('tells the lane menu that the conversation is running', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ merged: true }),
      running: () => true,
    })

    await act(async () => { (container.querySelector('[data-dsh-part="lane-chip"]') as HTMLButtonElement).click() })

    expect(container.textContent).toContain('menu.running')
    unmount()
  })
})

describe('session-lane locales', () => {
  it('zh is the key source and en mirrors it exactly', () => {
    const keys: SessionLaneKey[] = [
      'lane.aria', 'lane.local', 'lane.dirty', 'lane.pushed', 'lane.pr', 'lane.merged', 'lane.presetMissing',
    ]
    for (const key of keys) expect(sessionLaneZh[key], `zh["${key}"]`).toBeTypeOf('string')
    expect(Object.keys(sessionLaneEn).sort()).toEqual(Object.keys(sessionLaneZh).sort())
    for (const key of keys) expect(sessionLaneEn[key], `en["${key}"]`).toBeTruthy()
  })
})

describe('mountSessionLaneChip', () => {
  function makeCtx() {
    const injections: string[] = []
    const registrations: Array<{ options: Record<string, unknown>; body: unknown }> = []
    const ctx = {
      locale: { bind: () => (key: string) => key },
      slots: {
        inject(name: string, factory: () => unknown) { injections.push(name); factory(); return () => {} },
        register(options: Record<string, unknown>, body: unknown) {
          registrations.push({ options, body })
          return () => {}
        },
      },
    }
    return { ctx, injections, registrations }
  }

  it('claims the session-header actions seat and injects the session id', () => {
    const { ctx, injections, registrations } = makeCtx()
    const dispose = mountSessionLaneChip(ctx as never)

    expect(injections).toEqual(['conversation.session.header.actions'])
    const entry = registrations[0]
    expect(entry?.options['name']).toBe('conversation.session.header.actions')
    expect(entry?.options['id']).toBe('web-all-session-lane-chip')
    expect(entry?.options['order']).toBe(100)
    const inject = entry?.options['inject'] as (sessionId: string) => Record<string, unknown>
    expect(inject('session-9')).toEqual({ sessionId: 'session-9' })
    expect(typeof entry?.body).toBe('function')
    expect(typeof dispose).toBe('function')
  })

  it('hands the chip a referentially stable lane lookup', () => {
    // Regression: a per-render closure here made the chip's effect refetch on
    // every render (observed as an endless POST /worktree/lane loop in the GUI).
    const { ctx, registrations } = makeCtx()
    mountSessionLaneChip(ctx as never)
    const face = registrations[0]?.body as (props: Record<string, unknown>) => { props: Record<string, unknown> }

    const first = face({ sessionId: 'session-1' })
    const second = face({ sessionId: 'session-1' })

    expect(first.props['lane']).toBe(second.props['lane'])
    expect(typeof first.props['lane']).toBe('function')
  })
})
describe('the header answers "which branch is this conversation on"', () => {
  const repo = (branch: string) => async (): Promise<{
    root: string; branch: string; head: string; dirtyFiles: number; untrackedFiles: number; conflicts: number; operationInProgress: boolean
  }> => ({ root: '/repo', branch, head: 'deadbee', dirtyFiles: 0, untrackedFiles: 0, conflicts: 0, operationInProgress: false })

  it('shows the main checkout branch when the conversation is not on a lane', async () => {
    const { container, unmount } = await renderChip({ sessionId: 'session-1', lane: async () => null, repoStatus: repo('dev') })
    expect(container.textContent).toContain('lane.mainCheckout')
    expect(container.textContent).toContain('dev')
    expect(container.querySelector('[data-dsh-kind="main"]')).not.toBeNull()
    unmount()
  })

  it('prefers the lane over the main checkout when both are known', async () => {
    const { container, unmount } = await renderChip({
      sessionId: 'session-1',
      lane: async () => laneView({ pushed: true }),
      repoStatus: repo('dev'),
    })
    expect(container.textContent).toContain('feature/x')
    expect(container.textContent).toContain('lane.pushed')
    expect(container.querySelector('[data-dsh-kind="main"]')).toBeNull()
    unmount()
  })

  it('renders nothing outside a git repository', async () => {
    const { container, unmount } = await renderChip({ sessionId: 'session-1', lane: async () => null, repoStatus: async () => null })
    expect(container.textContent).toBe('')
    unmount()
  })
})
