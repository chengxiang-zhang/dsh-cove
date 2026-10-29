/**
 * The cross-tab SSE relay is the only place the plugin depends on Web Locks,
 * and Web Locks is a secure-context API: on a plain-HTTP remote entry
 * (`http://dsh.<machine>/`) `navigator.locks` does not exist, so the relay
 * degrades to one EventSource per subscription — the pre-#383 behavior that
 * exhausts the per-origin HTTP/1.1 pool faster. The relay path and that
 * degradation are both pinned here so neither changes silently.
 */
import { describe, expect, it } from 'vitest'
import { subscribeSharedEvents, type SseRelaySeams } from '../src/client/conversation/git-graph/sse-leader.ts'

interface EventListener {
  (raw: { data: string }): void
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  private readonly listeners = new Map<string, Set<EventListener>>()
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
  addEventListener(name: string, listener: EventListener): void {
    const set = this.listeners.get(name) ?? new Set<EventListener>()
    set.add(listener)
    this.listeners.set(name, set)
  }
  close(): void { this.closed = true }
  emit(name: string, data: string): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener({ data })
  }
}

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = []
  readonly name: string
  closed = false
  readonly posted: string[] = []
  private readonly listeners = new Set<EventListener>()
  constructor(name: string) { this.name = name; FakeBroadcastChannel.instances.push(this) }
  addEventListener(_type: string, listener: EventListener): void { this.listeners.add(listener) }
  postMessage(data: string): void { this.posted.push(data) }
  close(): void { this.closed = true }
  /** Simulate another tab posting on the same channel name. */
  receive(data: string): void { for (const listener of [...this.listeners]) listener({ data }) }
}

/** A lock manager that grants the leadership callback immediately. */
function grantingLocks(): LockManager {
  return {
    request: (_name: string, _options: unknown, callback: () => unknown) => Promise.resolve(callback()).then(() => undefined),
  } as unknown as LockManager
}

function relaySeams(): SseRelaySeams {
  return {
    eventSource: FakeEventSource as unknown as typeof EventSource,
    broadcastChannel: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
    locks: grantingLocks(),
  }
}

/** Run with the `navigator` global absent, the plain-HTTP remote condition. */
function withoutNavigator<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  delete (globalThis as Record<string, unknown>).navigator
  try {
    expect(typeof navigator === 'undefined' || navigator.locks === undefined).toBe(true)
    return run()
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, 'navigator', descriptor)
  }
}

describe('shared SSE relay', () => {
  it('keeps one EventSource per URL for every local subscriber and fans out broadcasts', () => {
    FakeEventSource.instances = []
    FakeBroadcastChannel.instances = []
    const seen: string[] = []
    const first = subscribeSharedEvents('/git/events?path=/repo', 'change', data => seen.push(`a:${data}`), relaySeams())
    const second = subscribeSharedEvents('/git/events?path=/repo', 'change', data => seen.push(`b:${data}`), relaySeams())

    expect(FakeEventSource.instances).toHaveLength(1)
    const source = FakeEventSource.instances[0]!
    source.emit('change', 'one')
    expect(seen).toEqual(['a:one', 'b:one'])
    expect(FakeBroadcastChannel.instances[0]!.posted).toEqual(['one'])

    // A follower tab's broadcast reaches local subscribers without a new stream.
    FakeBroadcastChannel.instances[0]!.receive('two')
    expect(seen).toEqual(['a:one', 'b:one', 'a:two', 'b:two'])
    expect(FakeEventSource.instances).toHaveLength(1)

    first()
    expect(source.closed).toBe(false)
    second()
    expect(source.closed).toBe(true)
    expect(FakeBroadcastChannel.instances[0]!.closed).toBe(true)
  })

  it('gives each URL its own relay', () => {
    FakeEventSource.instances = []
    const stopA = subscribeSharedEvents('/git/events?path=/a', 'change', () => {}, relaySeams())
    const stopB = subscribeSharedEvents('/git/events?path=/b', 'change', () => {}, relaySeams())
    expect(FakeEventSource.instances.map(source => source.url)).toEqual(['/git/events?path=/a', '/git/events?path=/b'])
    stopA()
    stopB()
  })

  it('degrades to a per-tab stream without Web Locks', () => {
    FakeEventSource.instances = []
    FakeBroadcastChannel.instances = []
    withoutNavigator(() => {
      const seen: string[] = []
      const seams: SseRelaySeams = {
        eventSource: FakeEventSource as unknown as typeof EventSource,
        broadcastChannel: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
      }
      const first = subscribeSharedEvents('/git/events?path=/repo', 'change', data => seen.push(`a:${data}`), seams)
      const second = subscribeSharedEvents('/git/events?path=/repo', 'change', data => seen.push(`b:${data}`), seams)

      // Still shared within this tab, but the browser-wide relay is gone: no
      // channel is created, so a second tab opens its own stream.
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(FakeBroadcastChannel.instances).toHaveLength(0)
      FakeEventSource.instances[0]!.emit('change', 'one')
      expect(seen).toEqual(['a:one', 'b:one'])

      first()
      expect(FakeEventSource.instances[0]!.closed).toBe(false)
      second()
      expect(FakeEventSource.instances[0]!.closed).toBe(true)
    })
  })
})