package com.netbirdportal

import org.junit.Assert.assertEquals
import org.junit.Test

class NetBirdRetryPolicyTest {
  @Test
  fun keepsRetryingWhileTheLiveEngineMayStillRecover() {
    assertEquals(
      NetBirdRetryPolicy.Action.RETRY,
      NetBirdRetryPolicy.nextAction(failuresSinceReset = 1, engineNotRunning = false),
    )
    assertEquals(
      NetBirdRetryPolicy.Action.RETRY,
      NetBirdRetryPolicy.nextAction(
        failuresSinceReset = NetBirdRetryPolicy.HARD_RESET_AFTER_FAILURES - 1,
        engineNotRunning = false,
      ),
    )
  }

  @Test
  fun rebuildsTheEngineAfterRepeatedFailures() {
    // "Retrying" a wedged instance is a no-op: Portal.start() returns
    // immediately while a client exists, so a real rebuild is the only way back.
    assertEquals(
      NetBirdRetryPolicy.Action.HARD_RESET,
      NetBirdRetryPolicy.nextAction(
        failuresSinceReset = NetBirdRetryPolicy.HARD_RESET_AFTER_FAILURES,
        engineNotRunning = false,
      ),
    )
    assertEquals(
      NetBirdRetryPolicy.Action.HARD_RESET,
      NetBirdRetryPolicy.nextAction(failuresSinceReset = 9, engineNotRunning = false),
    )
  }

  @Test
  fun rebuildsImmediatelyWhenTheEngineIsGone() {
    assertEquals(
      NetBirdRetryPolicy.Action.HARD_RESET,
      NetBirdRetryPolicy.nextAction(failuresSinceReset = 1, engineNotRunning = true),
    )
  }
}