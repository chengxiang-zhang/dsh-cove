import { expect, it } from 'vitest'
import { CodexNativeExecutor } from '../src/host/services/superagent/executors/engines/codex.ts'

it('collects complete material-heavy history without requesting an oversized multi-turn frame', async () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    id: `turn-${index}`, status: 'completed', startedAt: index + 1,
    items: [{ type: 'userMessage', content: [{ type: 'text', text: `${index}:` + 'x'.repeat(100000) }] }],
  }))
  const observations: any[] = [], pages: number[] = []
  const io = {
    launch: { epoch: 1, actionRef: { id: 'launch', revision: 1 } }, generation: 'generation', stream: 'stream',
    kernel: { host: { nativeFacts: () => [] } }, onMessage: () => {},
    observe(value: any) { observations.push(value); return `fact:${observations.length}` },
    async call(method: string, params: any) {
      expect(method).toBe('thread/turns/list')
      expect(params.itemsView).toBe('full')
      const start = Number(params.cursor ?? 0), end = Math.min(history.length, start + params.limit)
      const result = { data: history.slice(start, end), nextCursor: end < history.length ? String(end) : null }
      const bytes = Buffer.byteLength(JSON.stringify({ id: 1, result }))
      if (bytes > 1048576) throw Error('JSONL_FRAME_TOO_LARGE')
      pages.push(bytes)
      return result
    },
  }
  const engine = new (CodexNativeExecutor as any)(io, { hostRef: 'host', engineRef: 'codex', runtimeNamespace: 'private' }, 'original-thread')
  await expect(engine.refreshTurns()).resolves.toBe(true)
  expect(engine.turns()).toEqual(history)
  expect(pages.length).toBeGreaterThan(1)
  expect(Math.max(...pages)).toBeLessThanOrEqual(1048576)
  const recorded = observations.length
  await expect(engine.refreshTurns()).resolves.toBe(true)
  expect(observations).toHaveLength(recorded)
  expect(engine.identity.native_session_id).toBe('original-thread')
})

it('resumes the same thread without embedding aggregate history in its attach frame', async () => {
  const io = {
    launch: { epoch: 1, actionRef: { id: 'launch', revision: 1 } }, generation: 'generation', stream: 'stream',
    kernel: { host: { nativeFacts: () => [] } }, onMessage: () => {}, observe: () => 'fact', notify: async () => {},
    async call(method: string, params: any) {
      if (method === 'config/read') return { config: { features: Object.fromEntries(['shell_tool','code_mode_host','apps','plugins','remote_plugin','multi_agent'].map(key => [key, false])) } }
      if (method === 'mcpServerStatus/list') return { data: [] }
      if (method === 'thread/resume') {
        if (params.excludeTurns !== true) throw Error('JSONL_FRAME_TOO_LARGE')
        expect(params.threadId).toBe('original-thread')
        return { thread: { id: 'original-thread' } }
      }
      return {}
    },
  }
  const engine = await CodexNativeExecutor.connect(io as any, { hostRef: 'host', engineRef: 'codex', runtimeNamespace: 'private', cwd: '/public', instructions: 'same work', nativeSessionId: 'original-thread' })
  expect(engine.identity.native_session_id).toBe('original-thread')
})
