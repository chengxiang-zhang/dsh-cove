/** Lifecycle owner for all host service-domain registrations in the web-all entity. */

export type ServiceDisposer = () => void | Promise<void>

export interface ServiceRegistrationDiagnostic {
  service: string
  phase: 'register' | 'dispose'
  message: string
  error: unknown
  at: number
}

export interface ServiceLifecycleOptions {
  onDiagnostic?: (diagnostic: ServiceRegistrationDiagnostic) => void
  now?: () => number
}

export interface ServiceLifecycleOwner {
  readonly signal: AbortSignal
  readonly diagnostics: readonly ServiceRegistrationDiagnostic[]
  mount(service: string, register: () => ServiceDisposer): void
  track(service: string, registration: Promise<ServiceDisposer>): void
  dispose(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))
}

/**
 * Own sync and async service registrations under one deterministic lifetime.
 * Async registrations that settle after disposal are torn down immediately;
 * owner disposal aborts and awaits every tracked registration before returning.
 */
export function createServiceLifecycleOwner(options: ServiceLifecycleOptions = {}): ServiceLifecycleOwner {
  const controller = new AbortController()
  const diagnostics: ServiceRegistrationDiagnostic[] = []
  const disposers: Array<{ service: string; dispose: ServiceDisposer }> = []
  const pending = new Set<Promise<void>>()
  let disposed = false
  let disposing: Promise<void> | undefined

  const report = (service: string, phase: ServiceRegistrationDiagnostic['phase'], error: unknown): void => {
    const diagnostic = { service, phase, message: errorMessage(error), error, at: (options.now ?? Date.now)() }
    diagnostics.push(diagnostic)
    // Observability must never become a second failure that interrupts rollback.
    try { options.onDiagnostic?.(diagnostic) } catch { /* retained in diagnostics */ }
  }

  const runDisposer = async (service: string, dispose: ServiceDisposer): Promise<void> => {
    try { await dispose() } catch (error) { report(service, 'dispose', error) }
  }

  const add = (service: string, dispose: ServiceDisposer): void => {
    if (disposed) {
      const late = runDisposer(service, dispose)
      pending.add(late)
      void late.finally(() => pending.delete(late))
      return
    }
    disposers.push({ service, dispose })
  }

  const owner: ServiceLifecycleOwner = {
    signal: controller.signal,
    get diagnostics() { return diagnostics },
    mount(service, register) {
      if (disposed) return
      try { add(service, register()) } catch (error) { report(service, 'register', error) }
    },
    track(service, registration) {
      const tracked = registration.then(
        dispose => { add(service, dispose) },
        error => { if (!(disposed && isAbort(error))) report(service, 'register', error) },
      )
      pending.add(tracked)
      void tracked.finally(() => pending.delete(tracked))
    },
    dispose() {
      if (disposing !== undefined) return disposing
      disposed = true
      controller.abort(new DOMException('web-all service owner disposed', 'AbortError'))
      disposing = (async () => {
        while (pending.size > 0) await Promise.allSettled([...pending])
        for (const entry of disposers.splice(0).reverse()) await runDisposer(entry.service, entry.dispose)
        while (pending.size > 0) await Promise.allSettled([...pending])
      })()
      return disposing
    },
  }
  return owner
}

/** Reject promptly on owner abort without allowing the underlying task to register late resources. */
export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
