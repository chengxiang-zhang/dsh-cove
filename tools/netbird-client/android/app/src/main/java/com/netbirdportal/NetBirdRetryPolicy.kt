package com.netbirdportal

/**
 * Decides what one failed connection attempt should do next.
 *
 * This exists because "retry" was a no-op: `Portal.start()` returns immediately
 * while an engine instance exists (`native/portal.go:51-56`) and `StartProxy()`
 * hands back the cached listener (`native/portal.go:196-198`). A wedged
 * instance can therefore only come back after a real rebuild, so the first
 * attempts stay cheap (a live engine may still recover on its own) and the
 * engine is then torn down and rebuilt.
 *
 * Pure Kotlin on purpose: it carries the recovery policy that must be testable
 * without a device.
 */
object NetBirdRetryPolicy {
  const val HARD_RESET_AFTER_FAILURES = 3

  enum class Action {
    RETRY,
    HARD_RESET,
  }

  fun nextAction(failuresSinceReset: Int, engineNotRunning: Boolean): Action =
    if (engineNotRunning || failuresSinceReset >= HARD_RESET_AFTER_FAILURES) {
      Action.HARD_RESET
    } else {
      Action.RETRY
    }
}