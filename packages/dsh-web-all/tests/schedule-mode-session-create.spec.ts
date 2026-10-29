/**
 * 运行会话创建请求构造单测：待运行会话必须落在工作区之外，否则 DSH 的「新建会话」
 * 会把这条空会话当成草稿复用（新对话因此继承 `<任务名> · #N` 的名字与待投递提醒）。
 * 这里锁死「只带 cwd 与 agentPreset、绝不请求 workspaceId」的行为。
 */
import { describe, expect, it } from 'vitest'
import { buildSessionCreateRequest } from '../src/host/services/schedule-mode/session-create.ts'

describe('schedule-mode session create request', () => {
  it('creates the run session outside any workspace', () => {
    const request = buildSessionCreateRequest({ cwd: '/repo' })
    expect(request).toEqual({ cwd: '/repo' })
    expect('workspaceId' in request).toBe(false)
  })

  it('passes the inherited cwd and preset through', () => {
    expect(buildSessionCreateRequest({ cwd: '/repo/sub', agentPreset: 'code-vibe' }))
      .toEqual({ cwd: '/repo/sub', agentPreset: 'code-vibe' })
  })

  it('omits every field it cannot resolve', () => {
    expect(buildSessionCreateRequest({})).toEqual({})
    expect(buildSessionCreateRequest({ agentPreset: 'code-vibe' })).toEqual({ agentPreset: 'code-vibe' })
  })
})