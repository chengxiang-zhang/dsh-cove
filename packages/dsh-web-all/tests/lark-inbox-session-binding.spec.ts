/**
 * Session binding contracts.
 *
 * The answer path names its sessions deterministically, and a session id can be
 * created only once. These cases pin the difference between "created", "the engine
 * already had it" and "this failed for real", because getting that wrong turns a
 * changed working directory into a conversation that can never answer again.
 */

import { describe, expect, it, vi } from 'vitest'
import { bindReplySession } from '../src/host/services/superagent/channels/feishu/session-binding.ts'

describe('bindReplySession', () => {
  it('reports a fresh create as not adopted', async () => {
    const create = vi.fn().mockResolvedValue({ sessionId: 'feishu-1' })
    await expect(bindReplySession({ create }, { sessionId: 'feishu-1', cwd: '/repo' }))
      .resolves.toEqual({ adopted: false })
    expect(create).toHaveBeenCalledWith({ sessionId: 'feishu-1', cwd: '/repo' })
  })

  it('omits the working directory when none is configured', async () => {
    const create = vi.fn().mockResolvedValue({ sessionId: 'feishu-1' })
    await bindReplySession({ create }, { sessionId: 'feishu-1', cwd: '   ' })
    expect(create).toHaveBeenCalledWith({ sessionId: 'feishu-1' })
  })

  it('treats an empty id as the engine owning the supplied one', async () => {
    const create = vi.fn().mockResolvedValue({})
    await expect(bindReplySession({ create }, { sessionId: 'feishu-1', cwd: '' }))
      .resolves.toEqual({ adopted: false })
  })

  it('adopts the existing session when create fails and inspect finds it', async () => {
    const create = vi.fn().mockRejectedValue(new Error('session/conflict'))
    const inspect = vi.fn().mockResolvedValue({ meta: { cwd: '/old/repo' } })
    const outcome = await bindReplySession({ create, inspect }, { sessionId: 'feishu-1', cwd: '/new/repo' })
    expect(outcome).toEqual({ adopted: true, cwd: '/old/repo' })
    expect(inspect).toHaveBeenCalledWith('feishu-1')
  })

  it('adopts when create returns a different id but the session is really there', async () => {
    const create = vi.fn().mockResolvedValue({ sessionId: 'something-else' })
    const inspect = vi.fn().mockResolvedValue({ meta: { cwd: '/repo' } })
    await expect(bindReplySession({ create, inspect }, { sessionId: 'feishu-1', cwd: '/repo' }))
      .resolves.toEqual({ adopted: true, cwd: '/repo' })
  })

  it('rethrows the create failure when the session cannot be shown', async () => {
    const create = vi.fn().mockRejectedValue(new Error('session/conflict'))
    const inspect = vi.fn().mockRejectedValue(new Error('session/not-found'))
    await expect(bindReplySession({ create, inspect }, { sessionId: 'feishu-1', cwd: '/repo' }))
      .rejects.toThrow('session/conflict')
  })

  it('rethrows when the engine cannot be inspected at all', async () => {
    const create = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(bindReplySession({ create }, { sessionId: 'feishu-1', cwd: '/repo' }))
      .rejects.toThrow('boom')
  })

  it('rethrows a mismatched id when inspection is unavailable', async () => {
    const create = vi.fn().mockResolvedValue({ sessionId: 'something-else' })
    await expect(bindReplySession({ create }, { sessionId: 'feishu-1', cwd: '/repo' }))
      .rejects.toThrow('意外的 id')
  })
})
