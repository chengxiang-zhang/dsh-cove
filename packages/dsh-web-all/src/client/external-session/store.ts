/**
 * 外援会话快照源。
 *
 * 面板与会话头部的下拉分组读同一份列表：任何操作（追问 / 取消 / 关闭）宿主都回
 * 整份列表，这里替换快照，因此「外援 · N」的计数与列表内容永远一致，也不会出
 * 现两套各自轮询的数字。
 *
 * 只用 `getSnapshot()` + `subscribe()` 这一对最小接口，便于在测试里直接驱动，
 * 也便于以后换成 useSyncExternalStore。
 */
import {
  ExternalSessionApiError,
  type ExternalSessionApi,
} from './api.ts'
import {
  readSessionList,
  type ExternalSessionView,
} from './types.ts'

/** 快照状态：面板据此选加载 / 就绪 / 失败三态。 */
export type ExternalSessionStoreState = 'idle' | 'loading' | 'ready' | 'error'

/** 一次读取的结果。 */
export interface ExternalSessionSnapshot {
  readonly state: ExternalSessionStoreState
  readonly sessions: readonly ExternalSessionView[]
  readonly error?: Error
}

/** 快照源。 */
export interface ExternalSessionStore {
  getSnapshot(): ExternalSessionSnapshot
  subscribe(listener: () => void): () => void
  /** 主动读一次；并发的第二次调用复用在飞的那次。 */
  refresh(): Promise<void>
  /** 跑一个会返回整份列表的操作（追问 / 取消 / 关闭），成功后替换快照。 */
  apply(operation: (signal?: AbortSignal) => Promise<readonly ExternalSessionView[]>): Promise<readonly ExternalSessionView[]>
}

const EMPTY: ExternalSessionSnapshot = { state: 'idle', sessions: [] }

/** 造一个快照源；`now` 只为测试与调试保留，目前不参与计算。 */
export function createExternalSessionStore(api: ExternalSessionApi): ExternalSessionStore {
  let snapshot: ExternalSessionSnapshot = EMPTY
  const listeners = new Set<() => void>()
  let inFlight: Promise<void> | undefined

  const publish = (next: ExternalSessionSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 一个订阅者抛错不该影响其它订阅者与数据面。
      }
    }
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async refresh() {
      if (inFlight !== undefined) return inFlight
      publish({ state: 'loading', sessions: snapshot.sessions, ...(snapshot.error === undefined ? {} : { error: snapshot.error }) })
      inFlight = (async () => {
        try {
          const sessions = await api.list()
          publish({ state: 'ready', sessions })
        } catch (cause) {
          if ((cause as { name?: unknown } | null)?.name === 'AbortError') {
            publish({ state: snapshot.sessions.length === 0 ? 'idle' : 'ready', sessions: snapshot.sessions })
            return
          }
          const error = cause instanceof Error ? cause : new Error(String(cause))
          publish({ state: 'error', sessions: snapshot.sessions, error })
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    },

    async apply(operation) {
      const sessions = await operation()
      publish({ state: 'ready', sessions })
      return sessions
    },
  }
}

/** 把未知的宿主回包当成列表读（宿主偶尔只回一条记录）。 */
export function normalizeOperationResult(payload: unknown): readonly ExternalSessionView[] {
  return readSessionList(payload)
}

/** 失败是否指向「宿主没权限」这类不该重试的情况。 */
export function isForbidden(error: Error | undefined): boolean {
  return error instanceof ExternalSessionApiError && error.failure === 'forbidden'
}