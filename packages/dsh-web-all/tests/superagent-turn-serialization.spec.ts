import { expect, it, vi } from 'vitest'
import { NativeTurnQueue, NativeRequestScope, closeExactSession } from '../src/host/services/superagent/executors/native/turn-lifecycle.ts'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

it('does not start the outer secretary turn while an internal technical turn or its close is pending', async () => {
  const lane = new NativeTurnQueue(), answer = deferred(), stopped = deferred(), entered = deferred(), events: string[] = []
  const internal = lane.run(async () => { events.push('technical:start'); entered.resolve(); await answer.promise; events.push('technical:unknown'); await stopped.promise; events.push('technical:closed'); throw Error('partial write unknown') })
  const failed = expect(internal).rejects.toThrow('partial write unknown')
  await entered.promise
  const outer = lane.run(async () => { events.push('outer:start'); return 'new input' })
  await Promise.resolve(); expect(events).toEqual(['technical:start'])
  answer.resolve(); await Promise.resolve(); expect(events).toEqual(['technical:start','technical:unknown'])
  stopped.resolve(); await failed; expect(await outer).toBe('new input')
  expect(events).toEqual(['technical:start','technical:unknown','technical:closed','outer:start'])
})

it('detaches new worker requests and drains its accepted callback before propagating a history failure', async () => {
  const requests = new NativeRequestScope(), answer = deferred(), entered = deferred(), events: string[] = []
  const respond = vi.fn(async () => { events.push('response:unknown'); throw Error('ACK unknown') })
  requests.accept(async () => { entered.resolve(); await answer.promise; await respond() })
  await entered.promise
  const finish = requests.finish(() => { events.push('detached') }).then(() => { events.push('outer:advance') })
  requests.accept(async () => { events.push('late callback') })
  await Promise.resolve(); expect(events).toEqual(['detached'])
  answer.resolve(); await finish
  expect(events).toEqual(['detached','response:unknown','outer:advance']); expect(respond).toHaveBeenCalledOnce()
})

it('never closes or deletes a replacement session through an older captured role', async () => {
  const old = {}, next = {}, sessions = new Map([['quality',next]]), release = vi.fn(async () => ({ stopped: true }))
  await expect(closeExactSession(sessions,'quality',old,release)).rejects.toThrow('NATIVE_SESSION_OWNERSHIP_CHANGED')
  expect(release).not.toHaveBeenCalled(); expect(sessions.get('quality')).toBe(next)
  await closeExactSession(sessions,'quality',next,release); expect(release).toHaveBeenCalledWith(next); expect(sessions.has('quality')).toBe(false)
})
