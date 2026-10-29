// @vitest-environment jsdom
/**
 * Wiring test for the composer branch chip: the real face
 * (`createGitBranchFace`) mounted on a fake client context, driven through a
 * stubbed fetch, with the platform's workspace navigation observed.
 *
 * This is the cover the shipped bug needed. The dock seat carries
 * `{ session, input }` only (DSH renders `conversation.input.dock` with
 * `renderSlot('conversation.input.dock', { session, input })`), so a test that
 * handed the chip a `selectWorkspace` prop could pass while every real branch
 * choice created a directory and left the conversation where it was. Nothing
 * here passes that prop: the switch has to come from the `uiWorkspace` service.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitBranchFace } from '../src/client/conversation/git-branch.tsx'
import { zh, type GitGraphKey } from '../src/client/conversation/git-graph/locales.ts'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

vi.mock('../src/client/conversation/git-graph/git-graph.module.css', () => ({ default: {} }))
// `ui-icons.ts` resolves icons at runtime and falls back to an empty component
// when a name is absent, so an empty primitives module is enough here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({}))

const LANE_PATH = '/repo/.dsh/workspaces/fea/mcpfiles'
const SESSION = 'session-main'
const LANE_SESSION = 'session-lane'

const t = ((key: GitGraphKey, params?: Record<string, unknown>): string => {
  let value = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Translate<GitGraphKey>

/** The chip's SSE subscription would reach for a browser EventSource. */
class FakeEventSource {
  addEventListener(): void {}
  close(): void {}
}

interface Recorded {
  url: string
  body: unknown
}

/** Stub every route the chip touches and record the mutation bodies. */
function stubFetch(): Recorded[] {
  const calls: Recorded[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ url, body })
    const json = (value: unknown): Response => new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json' },
    })
    if (url === '/git/status') {
      return json({ ok: true, value: { root: '/repo', branch: 'dev', head: 'abc1234', dirtyFiles: 0, untrackedFiles: 0, conflicts: 0, operationInProgress: false } })
    }
    if (url === '/git/branches') {
      return json({
        ok: true,
        value: {
          root: '/repo', branch: 'dev', dirtyFiles: 0, untrackedFiles: 0, conflicts: 0, operationInProgress: false,
          branches: [{ name: 'dev', current: true }, { name: 'fea/mcpfiles', current: false }],
        },
      })
    }
    if (url === '/worktree/lane') return json({ ok: true, value: null })
    if (url === '/worktree/lane/create') {
      return json({
        ok: true,
        value: { name: 'fea/mcpfiles', branch: 'fea/mcpfiles', path: LANE_PATH, head: 'abc1234', created: true, workspaceId: 'ws-lane-1' },
      })
    }
    if (url === '/worktree/lane/bind') return json({ ok: true, value: { lane: null, permissionPresetApplied: true } })
    throw new Error(`unexpected fetch: ${url}`)
  })
  return calls
}

/** The lane workspace the face asked the platform to connect and what it revealed. */
interface NavigationCalls {
  workspaces: string[]
  revealed: string[]
}

/**
 * The client context the face needs: locale, the session list, and (unless a test
 * opts out) the platform's workspace navigation.
 */
function makeCtx(options: { navigation?: boolean } = {}) {
  const navigation: NavigationCalls = { workspaces: [], revealed: [] }
  const services: Record<string, unknown> = {
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: { [SESSION]: { cwd: '/repo' }, [LANE_SESSION]: { cwd: LANE_PATH } },
          ids: [SESSION, LANE_SESSION],
        }),
      },
    },
  }
  if (options.navigation !== false) {
    services['uiWorkspace'] = {
      openWorkspace: async (workspaceId: string, beforeOpen?: (sessionId: string) => void) => {
        navigation.workspaces.push(workspaceId)
        navigation.revealed.push(LANE_SESSION)
        beforeOpen?.(LANE_SESSION)
      },
    }
  }
  const ctx = {
    locale: { bind: () => t },
    get: (name: string, strict?: boolean) => {
      const found = services[name]
      if (found === undefined && strict !== false) throw new Error(`service ${name} is not available`)
      return found
    },
  }
  return { ctx: ctx as unknown as ClientContext, navigation }
}

/** Render the face with the seat props a real dock gives it (and nothing else). */
function renderFace(ctx: ClientContext) {
  const Face = createGitBranchFace(ctx) as unknown as (props: Record<string, unknown>) => ReactElement
  return render(
    <Face
      sessionId={SESSION}
      useSessions={(selector: (state: unknown) => unknown) => selector({ byId: { [SESSION]: { blank: true } }, ids: [SESSION] })}
    />,
  )
}

/** Open the branch popover through the chip (waiting for the status probe). */
async function openPopover(): Promise<void> {
  fireEvent.click(await screen.findByLabelText(t('chip.aria.branch')))
  await waitFor(() => { expect(screen.getByText('fea/mcpfiles')).toBeTruthy() })
}

beforeEach(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
})
afterEach(() => {
  // vitest runs without globals here, so Testing Library cannot self-register
  // its cleanup: without this, one test's chip and dialogs leak into the next.
  cleanup()
  vi.restoreAllMocks()
  delete (globalThis as { EventSource?: unknown }).EventSource
})

describe('branch chip wiring', () => {
  it('moves the conversation onto the new lane and binds it, with no seat prop in play', async () => {
    const calls = stubFetch()
    const { ctx, navigation } = makeCtx()
    const { container } = renderFace(ctx)

    await openPopover()
    fireEvent.click(screen.getByText(t('branch.create')))
    fireEvent.change(container.querySelector('#git-graph-branch-name') as HTMLInputElement, { target: { value: 'fea/mcpfiles' } })
    fireEvent.click(screen.getByText(t('branch.createDialog.confirm')))

    // The lane's registered workspace is what the platform connects; the dock
    // seat never carries a switch, so this can only come from the service.
    await waitFor(() => { expect(navigation.workspaces).toEqual(['ws-lane-1']) })
    expect(navigation.revealed).toEqual([LANE_SESSION])
    // The binding records the conversation that landed in the lane.
    await waitFor(() => {
      expect(calls.some((call) => call.url === '/worktree/lane/bind')).toBe(true)
    })
    expect(calls.find((call) => call.url === '/worktree/lane/bind')?.body).toEqual({
      repoPath: '/repo', branch: 'fea/mcpfiles', sessionId: LANE_SESSION,
    })
    // The user is told the conversation is in the lane, not sent to a picker.
    await waitFor(() => { expect(container.textContent).toContain(t('toast.switchSuccess', { branchName: 'fea/mcpfiles' })) })
    expect(container.textContent).not.toContain(t('toast.worktreeReady', { branchName: 'fea/mcpfiles' }))
  })

  it('moves the conversation when an existing branch is picked from the list', async () => {
    const calls = stubFetch()
    const { ctx, navigation } = makeCtx()
    const { container } = renderFace(ctx)

    await openPopover()
    fireEvent.click(screen.getByText('fea/mcpfiles'))

    await waitFor(() => { expect(navigation.workspaces).toEqual(['ws-lane-1']) })
    await waitFor(() => { expect(container.textContent).toContain(t('toast.switchSuccess', { branchName: 'fea/mcpfiles' })) })
    expect(calls.find((call) => call.url === '/worktree/lane/bind')?.body).toEqual({
      repoPath: '/repo', branch: 'fea/mcpfiles', sessionId: LANE_SESSION,
    })
  })

  it('degrades to the prepared-worktree notice when the shell provides no navigation service', async () => {
    const calls = stubFetch()
    const { ctx, navigation } = makeCtx({ navigation: false })
    const { container } = renderFace(ctx)

    await openPopover()
    fireEvent.click(screen.getByText(t('branch.create')))
    fireEvent.change(container.querySelector('#git-graph-branch-name') as HTMLInputElement, { target: { value: 'fea/mcpfiles' } })
    fireEvent.click(screen.getByText(t('branch.createDialog.confirm')))

    // The lane is real, so it is reported as ready; nothing is bound, because
    // this conversation never left the old checkout.
    await waitFor(() => { expect(container.textContent).toContain(t('toast.worktreeReady', { branchName: 'fea/mcpfiles' })) })
    expect(navigation.workspaces).toEqual([])
    expect(calls.some((call) => call.url === '/worktree/lane/bind')).toBe(false)
  })
})