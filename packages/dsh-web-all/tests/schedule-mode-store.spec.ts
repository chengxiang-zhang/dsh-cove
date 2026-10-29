/**
 * schedule-mode 存储层单测：原子写往返、损坏文件拒绝、身份一致性、删除。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScheduleModePolicy } from '../src/core/schedule-mode/types.ts'
import { parsePolicy, parseStoreFile, ScheduleModeStore } from '../src/host/services/schedule-mode/store.ts'

const tempDirs: string[] = []
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-schedule-mode-'))
  tempDirs.push(dir)
  return join(dir, 'dsh-schedule-mode.json')
}
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

function policy(overrides: Partial<ScheduleModePolicy> = {}): ScheduleModePolicy {
  return {
    key: 'session-a\u0000task-1',
    sourceSessionId: 'session-a',
    logicalId: 'task-1',
    title: 'Nightly report',
    prompt: 'write the nightly report',
    rule: { kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' },
    runs: [],
    active: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('schedule-mode store', () => {
  it('round-trips a policy through the file', () => {
    const file = tempFile()
    const store = new ScheduleModeStore(file)
    store.upsert(policy({
      armedTaskId: 'task-9',
      runSessionId: 'run-3',
      nextScheduledAt: '2026-10-10T01:00:00.000Z',
      runs: [{ scheduledAt: '2026-10-09T01:00:00.000Z', deliveredAt: '2026-10-09T01:00:01.000Z', sessionId: 'run-3', taskId: 'task-9' }],
    }))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ formatVersion: 1 })

    const reloaded = new ScheduleModeStore(file)
    const loaded = reloaded.get('session-a\u0000task-1')
    expect(loaded?.armedTaskId).toBe('task-9')
    expect(loaded?.runs).toHaveLength(1)
    expect(loaded?.runs[0]?.sessionId).toBe('run-3')
    expect(loaded?.active).toBe(true)
  })

  it('persists rotationInFlight and the deleted end reason across reloads', () => {
    const file = tempFile()
    const store = new ScheduleModeStore(file)
    store.upsert(policy({ rotationInFlight: true }))
    store.upsert(policy({ key: 'session-a\u0000task-2', logicalId: 'task-2', active: false, endedReason: 'deleted' }))
    const reloaded = new ScheduleModeStore(file)
    expect(reloaded.get('session-a\u0000task-1')?.rotationInFlight).toBe(true)
    expect(reloaded.get('session-a\u0000task-2')?.endedReason).toBe('deleted')
    expect(reloaded.get('session-a\u0000task-2')?.rotationInFlight).toBeUndefined()
    expect(parsePolicy({ ...policy(), rotationInFlight: 'yes' } as unknown)?.rotationInFlight).toBeUndefined()
  })

  it('round-trips exact transition associations without dropping the journal', () => {
    const file = tempFile()
    const store = new ScheduleModeStore(file)
    const transition = { kind: 'original' as const, phase: 'created' as const,
      deleteTasks: [{ sessionId: 'run-3', id: 'old-copy' }], sessionId: 'session-a',
      created: { sessionId: 'session-a', id: 'restored', scheduledAt: '2026-10-10T01:00:00Z' } }
    store.upsert(policy({ transition, runSessionId: 'run-3', armedTaskId: 'old-copy' }))
    expect(new ScheduleModeStore(file).find('task-1', 'session-a')?.transition).toEqual(transition)
  })

  it('fails closed rather than dropping an invalid transition journal', () => {
    for (const transition of [null, {}, { kind: 'rotate', phase: 'created', deleteTasks: [] },
      { kind: 'rotate', phase: 'deleting', deleteTasks: [{ id: 'missing-session' }] }]) {
      expect(parsePolicy({ ...policy(), transition })?.transition?.phase).toBe('recovery-required')
    }
  })

  it('refreshes persisted state instead of exposing a stale ownership snapshot', () => {
    const file = tempFile()
    const store = new ScheduleModeStore(file)
    store.upsert(policy())
    writeFileSync(file, JSON.stringify({ formatVersion: 1, policies: {} }), 'utf8')
    expect(store.list()).toHaveLength(0)
    store.invalidate()
    expect(store.list()).toHaveLength(0)
  })

  it('refuses a corrupt file without overwriting recovery evidence', () => {
    const file = tempFile()
    const damaged = '{ not json'
    writeFileSync(file, damaged, 'utf8')
    const store = new ScheduleModeStore(file)
    expect(() => store.list()).toThrow()
    expect(() => store.upsert(policy())).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(damaged)
  })

  it('rejects malformed persisted policies rather than losing ownership tracking', () => {
    expect(parsePolicy(null)).toBeUndefined()
    expect(parsePolicy({ sourceSessionId: 's', logicalId: 't' })).toBeUndefined()
    expect(parsePolicy({ ...policy(), rule: { kind: 'lunar' } } as unknown)).toBeUndefined()
    expect(parsePolicy({ ...policy(), runs: 'nope' } as unknown)?.runs).toEqual([])
    expect(() => parseStoreFile(JSON.stringify({
      formatVersion: 1,
      policies: {
        [policy().key]: policy(),
        bad: { sourceSessionId: 's' },
        worse: { ...policy(), rule: { kind: 'weekly', time: '09:00:00.000', timeZone: 'UTC', weekdays: [] } },
      },
    }))).toThrow()
    const parsed = parseStoreFile(JSON.stringify({ formatVersion: 1, policies: { [policy().key]: policy() } }))
    expect(Object.keys(parsed.policies)).toEqual([policy().key])
  })

  it('removes a policy by key and reports whether it existed', () => {
    const store = new ScheduleModeStore(tempFile())
    store.upsert(policy())
    expect(store.remove('session-a\u0000task-1')).toBe(true)
    expect(store.remove('session-a\u0000task-1')).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('finds a policy by logical id or by its current native row', () => {
    const store = new ScheduleModeStore(tempFile())
    store.upsert(policy({ armedTaskId: 'task-rotated' }))
    expect(store.find('task-1', 'session-a')?.logicalId).toBe('task-1')
    expect(store.findArmed('task-rotated')?.key).toBe('session-a\u0000task-1')
    expect(store.findArmed('task-other')).toBeUndefined()
  })
})
