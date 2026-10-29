package com.netbirdportal

import java.io.File
import java.util.concurrent.CompletionException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetBirdRuntimeTest {
  @Test
  fun explicitAuthenticationRejectionsRequireLogin() {
    assertTrue(
      NetBirdRuntime.isAuthenticationRequired(
        IllegalStateException(
          "rpc error: code = PermissionDenied desc = no peer auth method provided, " +
            "please use interactive SSO login",
        ),
      ),
    )
    assertTrue(
      NetBirdRuntime.isAuthenticationRequired(
        CompletionException(IllegalStateException("authentication rejected by management")),
      ),
    )
  }

  @Test
  fun transientNetworkFailuresKeepThePersistedLogin() {
    assertFalse(
      NetBirdRuntime.isAuthenticationRequired(
        IllegalStateException("NetBird management connection timed out"),
      ),
    )
    assertFalse(
      NetBirdRuntime.isAuthenticationRequired(
        IllegalStateException("dial tcp: network is unreachable"),
      ),
    )
  }

  @Test
  fun diagnosticsCarryStageFailuresAndEscapedErrorText() {
    NetBirdRuntime.recordFailure(
      NetBirdRuntime.STAGE_MANAGEMENT_DISCONNECTED,
      "line1\n\"quoted\"",
      2,
    )

    val json = NetBirdRuntime.diagnosticsJson(serviceRunning = false)

    assertTrue(json.contains("\"serviceRunning\":false"))
    assertTrue(json.contains("\"stage\":\"management_disconnected\""))
    assertTrue(json.contains("\"failures\":2"))
    // The reason line reaches the UI inside JSON: an unescaped newline or quote
    // would turn it into "no reason at all".
    assertTrue(json.contains("line1\\n\\\"quoted\\\""))
  }

  @Test
  fun connectingClearsTheRecordedFailures() {
    NetBirdRuntime.recordFailure(NetBirdRuntime.STAGE_ENGINE_NOT_RUNNING, "client not started", 3)
    NetBirdRuntime.recordConnected()

    val json = NetBirdRuntime.diagnosticsJson(serviceRunning = true)

    assertTrue(json.contains("\"failures\":0"))
    assertTrue(json.contains("\"stage\":\"idle\""))
    assertTrue(json.contains("\"lastError\":\"\""))
  }

  @Test
  fun connectingClearsAStaleIdentityVerdict() {
    NetBirdRuntime.recordAuthVerdict(NetBirdRuntime.AUTH_VERDICT_LOGIN_REQUIRED)
    assertTrue(
      NetBirdRuntime.diagnosticsJson(serviceRunning = true)
        .contains("\"authVerdict\":\"login_required\""),
    )

    NetBirdRuntime.recordConnected()

    // A successful connection is newer evidence; keeping the cached verdict
    // would make the list claim a login that just worked is no longer accepted.
    assertTrue(
      NetBirdRuntime.diagnosticsJson(serviceRunning = true)
        .contains("\"authVerdict\":\"unknown\""),
    )
  }

  @Test
  fun refusesDownloadPathsOutsideTheDownloadsDirectory() {
    val root = File("/tmp/netbird-downloads")

    assertTrue(
      NetBirdRuntime.isManagedPath(root, File(root, "NetBirdPortal-update-v19.apk")),
    )
    assertFalse(NetBirdRuntime.isManagedPath(root, File("/tmp/elsewhere.apk")))
    assertFalse(
      NetBirdRuntime.isManagedPath(root, File(root, "../netbird-portal-config.json")),
    )
    assertFalse(NetBirdRuntime.isManagedPath(root, root))
  }
}
