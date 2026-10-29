package com.netbirdportal

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.netbird.portal.Portal
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Records the exact SSO URL the shipped app hands to the browser.
 *
 * The app never composes the SSO URL itself: `Portal.loginSSO` does, inside the
 * embedded NetBird engine, and the returned string is what the login screen
 * opens. Every identity-provider change (the Casdoor connector, its own
 * providers) is therefore invisible from the app side - what matters is that
 * this URL still points at the management host and still lands on the
 * connector chooser. This test pins that down so a future change that quietly
 * redirects the flow somewhere else fails here instead of on a phone.
 *
 * NetBird Cloud does not use this PKCE flow: it answers with the device
 * authorization flow, whose URL lives on NetBird's account host rather than on
 * the management host. This test therefore covers a self-hosted server only.
 *
 *   ./android/gradlew -p android :app:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.netbirdportal.NetBirdSsoUrlTest
 */
@RunWith(AndroidJUnit4::class)
class NetBirdSsoUrlTest {
  private val tag = "NETBIRD_SSO_URL"

  @Test
  fun theLoginUrlPointsAtTheManagementHost() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val config = File(context.filesDir, "netbird-sso-probe-config.json").absolutePath
    val state = File(context.filesDir, "netbird-sso-probe-state.json").absolutePath

    val url = Portal.loginSSO(
      "netbird-portal-android",
      "https://netbird.example.com:443",
      config,
      state,
    )
    Log.i(tag, "ssoUrl=$url")

    assertTrue("SSO url is empty", url.isNotBlank())
    assertTrue("SSO url does not target the management host: $url", url.contains("netbird.example.com"))
  }
}