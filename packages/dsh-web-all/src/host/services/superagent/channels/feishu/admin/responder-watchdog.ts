/**
 * Notice that the answer path lost its responder, and put one back.
 *
 * The failure this exists for happened on a real host: a settings write started a
 * plugin reload, a second write arrived before the first finished, and the loader
 * aborted with "HMR transactions cannot be nested". The domain's teardown had
 * already disposed the responder; the replacement never ran. The result was a bot
 * that still held its Feishu connection, still stored every message, and answered
 * none of them - with nothing in the log to say so.
 *
 * The repair is deliberately narrow. It never touches the gateway, the store or the
 * credentials, because those are not what went missing: it only builds a responder
 * over the runtime that is already there. A guard that rebuilt everything would
 * turn one lost object into a reconnect storm.
 *
 * It is also deliberately loud. Every repair logs a warning, because a watchdog
 * that silently papers over a systematic problem is worse than no watchdog: the
 * operator needs to know their reload is not landing.
 */

/** What the watchdog may observe and do. */
export interface ResponderWatchdogDeps {
  /** Whether a runtime is mounted and answering is enabled. */
  expected(): boolean
  /** Whether a responder is currently attached to that runtime. */
  present(): boolean
  /** Build and start a responder over the mounted runtime. */
  repair(): void
  log: { warn(message: string): void }
}

/** Observable behaviour of the watchdog. */
export interface ResponderWatchdog {
  /**
   * Check once, repairing when needed.
   * @param now - current epoch milliseconds, for the cooldown.
   * @returns what this check did.
   */
  check(now?: number): 'idle' | 'repaired' | 'skipped'
}

/** How long to wait before trying to repair again after a failed attempt. */
export const REPAIR_COOLDOWN_MS = 5 * 60_000

/**
 * Build a watchdog.
 *
 * The cooldown is the difference between a recovery and a loop: a repair that
 * throws leaves the responder missing, and without a cooldown the next check
 * would try again fifteen seconds later, forever.
 * @param deps - what to observe and how to repair.
 * @returns the watchdog.
 */
export function createResponderWatchdog(deps: ResponderWatchdogDeps): ResponderWatchdog {
  let lastAttempt = Number.NEGATIVE_INFINITY

  return {
    check(now = Date.now()) {
      if (!deps.expected() || deps.present()) return 'idle'
      if (now - lastAttempt < REPAIR_COOLDOWN_MS) return 'skipped'
      lastAttempt = now
      try {
        deps.repair()
      } catch (error) {
        deps.log.warn(`lark-inbox: 重建回话链路失败，${Math.round(REPAIR_COOLDOWN_MS / 60000)} 分钟后重试：${error instanceof Error ? error.message : String(error)}`)
        return 'skipped'
      }
      if (!deps.present()) {
        deps.log.warn('lark-inbox: 回话链路重建后仍不可用')
        return 'skipped'
      }
      // Loud on purpose: a repair means a reload went missing, and the operator
      // should know that their settings write did not land cleanly.
      deps.log.warn('lark-inbox: 回话链路已自动重建（上一次插件重载没有装回 responder）')
      return 'repaired'
    },
  }
}