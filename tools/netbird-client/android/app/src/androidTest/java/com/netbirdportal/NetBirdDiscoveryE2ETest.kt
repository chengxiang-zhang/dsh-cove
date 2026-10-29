package com.netbirdportal

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.netbird.portal.Portal
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * End-to-end enrolment and discovery on an emulator, for a BRAND-NEW peer.
 *
 * It enrols this app instance with a one-off setup key into the same config
 * paths the app itself uses, then checks every link an empty service list could
 * break at:
 *
 *   1. the fleet DNS records actually reach this new peer (zone distribution);
 *   2. the registry accepts them (name shape + target is one of our peers);
 *   3. one accepted entry answers through the tunnel, because the list screen
 *      drops services that do not answer.
 *
 * Written because the empty-catalogue bug was diagnosed from the server side
 * twice without a client, and a fresh peer is exactly the case that breaks it:
 * a newly registered device landed in a group the DNS zone was not distributed
 * to, so it received no records at all.
 *
 * Run it targeted, with a one-off key passed as an instrumentation argument:
 *
 *   ./android/gradlew -p android :app:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.netbirdportal.NetBirdDiscoveryE2ETest \
 *     -Pandroid.testInstrumentationRunnerArguments.setupKey=<one-off key>
 */
@RunWith(AndroidJUnit4::class)
class NetBirdDiscoveryE2ETest {
  private val tag = "NETBIRD_E2E"

  @After
  fun stopClient() {
    runCatching { Portal.stop() }
  }

  @Test
  fun aFreshPeerReceivesTheFleetEntriesAndCanReachOne() {
    val args = InstrumentationRegistry.getArguments()
    val setupKey = requireNotNull(args.getString("setupKey")) { "setupKey argument required" }
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    // The app's own paths, so the launched app picks the enrolment up too.
    val config = File(context.filesDir, "netbird-portal-config.json").absolutePath
    val state = File(context.filesDir, "netbird-portal-state.json").absolutePath

    Portal.start(
      setupKey,
      "netbird-portal-android",
      "https://netbird.example.com:443",
      config,
      state,
    )

    var status = ""
    val deadline = System.currentTimeMillis() + 90_000
    while (System.currentTimeMillis() < deadline) {
      status = runCatching { Portal.status() }.getOrDefault("")
      if (status.contains("\"managementConnected\":true")) break
      Thread.sleep(2000)
    }
    Log.i(tag, "status=$status")
    assertTrue("management never connected: $status", status.contains("\"managementConnected\":true"))

    // The network map is pushed to a peer asynchronously; a peer set that is
    // still empty right after connecting is normal and must not be read as "no
    // services". Poll for it, which is also what tells the two failure modes
    // apart in the log: an empty map (ACL/policy) versus no records (zone).
    var peers = "[]"
    val peerDeadline = System.currentTimeMillis() + 60_000
    while (System.currentTimeMillis() < peerDeadline) {
      peers = runCatching { Portal.peerAddresses() }.getOrDefault("[]")
      if (peers.length > 4) break
      Thread.sleep(2000)
    }
    Log.i(tag, "peerAddresses=$peers")

    val records = Portal.listServices()
    Log.i(tag, "records=$records")
    assertTrue(
      "this peer sees no peers at all: it is in no policy that covers the fleet. peerAddresses=$peers",
      peers.length > 4,
    )
    assertTrue(
      "the peer received no fleet DNS records; the zone is not distributed to it. records=$records",
      records.contains("\"name\""),
    )

    val accepted = DshHostRegistry.acceptRecords(context, records, peers)
    Log.i(tag, "accepted=$accepted")
    val acceptedArray = JSONArray(accepted)
    assertTrue(
      "records arrived but none was accepted (name shape or peer set): records=$records peers=$peers",
      acceptedArray.length() > 0,
    )

    // An accepted entry that does not answer would still leave the list empty.
    val first = acceptedArray.getJSONObject(0)
    val zone = first.optString("zone").trimEnd('.')
    val name = first.optString("name").trimEnd('.')
    val canonical = if (name.endsWith(".$zone")) name else "$name.$zone"
    val probe = runCatching { Portal.probe("http://$canonical/") }.getOrDefault("")
    Log.i(tag, "probe($canonical)=$probe")
    assertTrue("accepted entry did not answer through the tunnel: $probe", probe.contains("\"reachable\":true"))
  }
}