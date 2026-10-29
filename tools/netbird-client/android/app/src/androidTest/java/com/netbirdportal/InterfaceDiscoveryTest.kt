package com.netbirdportal

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.netbird.portal.Portal
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Pins the interface discovery the ICE agent depends on.
 *
 * Android 11+ denies an ordinary app the NETLINK_ROUTE bind and RTM_GETLINK that
 * net.Interfaces() issues. The embedded client used to turn that failure into an
 * empty interface list it handed to ICE anyway, so a phone gathered no candidate
 * at all and every peer connection stayed on the relay. The AAR build routes
 * discovery through anet and fails unless that patch is in effect; this test is
 * the on-device half of the same contract:
 *
 *   1. net.Interfaces() reports the platform restriction this fix exists for,
 *   2. the engine's own discoverer still enumerates interfaces, and
 *   3. an ICE agent built the way the engine builds it gathers candidates.
 */
@RunWith(AndroidJUnit4::class)
class InterfaceDiscoveryTest {
  @Test
  fun embeddedEngineGathersIceCandidates() {
    val report = JSONObject(Portal.describeInterfaceDiscovery())
    Log.i("NETBIRD_PROBE", report.toString())

    // 1. The restriction is worth recording even though older devices answer it.
    val netError = report.optString("netError")
    if (netError.isNotEmpty()) {
      Log.i("NETBIRD_PROBE", "net.Interfaces() denied: $netError")
    }

    // 2. Discovery must survive it.
    val discovered = report.getJSONArray("discovered")
    assertTrue("interface discovery returned nothing: $report", discovered.length() > 0)

    // 3. And ICE must get candidates out of that list.
    val candidates = report.getJSONArray("candidates")
    assertTrue("ICE gathered no candidate: $report", candidates.length() > 0)
  }
}
