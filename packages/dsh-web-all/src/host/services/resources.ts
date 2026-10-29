/** Registration transactions for resources owned by one service domain. */
import type { ServiceDisposer } from './lifecycle.ts'

/** Record a disposer immediately after acquiring its resource. */
export type OwnResource<T extends ServiceDisposer = ServiceDisposer> = <D extends T>(dispose: D) => D

function failure(errors: unknown[]): void {
  if (errors.length > 0) throw new AggregateError(errors, 'service resource cleanup failed')
}

/** Roll back partial synchronous setup and dispose every resource in reverse order. */
export function registerResources(setup: (own: OwnResource<() => void>) => void): () => void {
  const resources: Array<() => void> = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const errors: unknown[] = []
    for (const release of resources.splice(0).reverse()) {
      try { release() } catch (error) { errors.push(error) }
    }
    failure(errors)
  }
  try {
    setup(release => {
      if (disposed) release()
      else resources.push(release)
      return release
    })
    return dispose
  } catch (error) {
    try { dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'service registration and rollback failed')
    }
    throw error
  }
}

/** Await rollback before rejecting asynchronous setup; disposal is single-shot and awaitable. */
export async function registerAsyncResources(setup: (own: OwnResource) => Promise<void>): Promise<() => Promise<void>> {
  const resources: ServiceDisposer[] = []
  let disposing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposing ??= (async () => {
      const errors: unknown[] = []
      for (const release of resources.splice(0).reverse()) {
        try { await release() } catch (error) { errors.push(error) }
      }
      failure(errors)
    })()
    return disposing
  }
  try {
    await setup(release => {
      if (disposing === undefined) resources.push(release)
      else {
        // A failed setup may still have uncancelled asynchronous callbacks.
        // Own their late acquisitions instead of stranding them after rollback.
        let cleanup: void | Promise<void>
        try { cleanup = release() } catch (error) { cleanup = Promise.reject(error) }
        const late = Promise.resolve(cleanup)
        void late.catch(() => {})
        disposing = Promise.allSettled([disposing, late]).then(results => {
          const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
          failure(errors)
        })
        void disposing.catch(() => {})
      }
      return release
    })
    return dispose
  } catch (error) {
    try { await dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'service registration and rollback failed')
    }
    throw error
  }
}
