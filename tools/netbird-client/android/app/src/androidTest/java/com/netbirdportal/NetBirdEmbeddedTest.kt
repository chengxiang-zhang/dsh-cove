package com.netbirdportal

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.netbird.portal.Portal
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class NetBirdEmbeddedTest {
  @After
  fun stopClient() {
    runCatching { Portal.stop() }
  }

  @Test
  fun fetchesOpenVikingThroughEmbeddedNetBird() {
    val args = InstrumentationRegistry.getArguments()
    val setupKey = requireNotNull(args.getString("setupKey")) { "setupKey argument required" }
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val dir = File(context.filesDir, "netbird-instrumentation").apply { mkdirs() }

    Portal.start(
      setupKey,
      "netbird-portal-android-test",
      "https://netbird.example.com:443",
      File(dir, "config.json").absolutePath,
      File(dir, "state.json").absolutePath,
    )

    val result = Portal.fetch("http://openviking.dl-dev/studio")
    assertTrue("expected URL in response: $result", result.contains("openviking.dl-dev/studio"))
    assertTrue("expected OpenViking HTML response: $result", result.contains("OpenViking Studio"))
    assertTrue("expected HTTP 200: $result", result.contains("\"statusCode\":200"))
    assertEquals(true, Portal.status().contains("\"managementConnected\":true"))
  }
}
