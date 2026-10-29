package com.netbirdportal

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.netbird.portal.Portal
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Proves, against the live fleet, that what a device sees is decided by the
 * groups its peer was placed in - not by the DNS zone alone.
 *
 * The account serves two roles out of one NetBird account:
 *
 *   - a fleet peer (`auto_groups=[ops]`) must see the whole fleet;
 *   - an employee peer (`auto_groups=[u-employee-a]`) must see exactly its own
 *     machine and nothing else, even though the shared "netbird services" zone
 *     is handed to it and therefore contains every machine's name.
 *
 * The second half is the part that matters: it is the check that a per-user
 * isolation scheme survives, and it is deliberately asserted on the peer set
 * (the ACL result) rather than on the record list, because the record list is
 * only a name list and carries no access by itself.
 *
 * Run it targeted, with two setup keys passed as instrumentation arguments:
 *
 *   ./android/gradlew -p android :app:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.netbirdportal.NetBirdScopedVisibilityE2ETest \
 *     -Pandroid.testInstrumentationRunnerArguments.fleetKey=<key auto_groups=[ops]> \
 *     -Pandroid.testInstrumentationRunnerArguments.employeeKey=<key auto_groups=[u-employee-a]> \
 *     -Pandroid.testInstrumentationRunnerArguments.fleetIps=100.64.0.11,... \
 *     -Pandroid.testInstrumentationRunnerArguments.employeeMachineIp=100.64.0.14
 *
 * The employee case additionally requires that one machine is a member of
 * `u-employee-a` and that `u-employee-a` is in the zone's distribution groups,
 * which is exactly how a real employee machine is wired up.
 */
@RunWith(AndroidJUnit4::class)
class NetBirdScopedVisibilityE2ETest {
  private val tag = "NETBIRD_SCOPE"
  private val management = "https://netbird.example.com:443"

  @After
  fun stopClient() {
    runCatching { Portal.stop() }
  }

  @Test
  fun aFleetPeerSeesEveryMachine() {
    val args = InstrumentationRegistry.getArguments()
    val fleetIps = csv(args.getString("fleetIps"))
    val peers = enrolAndCollectPeers(requireNotNull(args.getString("fleetKey")) { "fleetKey required" })
    val records = lastRecords
    val accepted = lastAccepted

    Log.i(tag, "FLEET peerAddresses=$peers records=$records accepted=$accepted")
    val missing = fleetIps - peers
    assertTrue("a fleet peer is missing machines from its network map: missing=$missing peers=$peers", missing.isEmpty())
    assertEquals(
      "a fleet peer must still see every machine's DSH entry: accepted=$accepted",
      fleetIps.size,
      accepted.length(),
    )
  }

  @Test
  fun anEmployeePeerSeesOnlyItsOwnMachine() {
    val args = InstrumentationRegistry.getArguments()
    val employeeMachineIp = requireNotNull(args.getString("employeeMachineIp")) { "employeeMachineIp required" }
    val fleetIps = csv(args.getString("fleetIps"))
    val peers = enrolAndCollectPeers(requireNotNull(args.getString("employeeKey")) { "employeeKey required" })
    val records = lastRecords
    val accepted = lastAccepted

    Log.i(tag, "EMPLOYEE peerAddresses=$peers records=$records accepted=$accepted")

    // The ACL result: the employee peer may reach its own machine, and no
    // other machine, even though the shared zone put every name on its disk.
    assertEquals(
      "an employee peer must see exactly its own machine in the network map: peers=$peers",
      setOf(employeeMachineIp),
      peers,
    )
    val leaked = peers intersect (fleetIps - employeeMachineIp)
    assertTrue("an employee peer can see machines outside its group: $leaked", leaked.isEmpty())

    // The app's own filter: the shared zone did arrive, so the accepted set is
    // what keeps the list correct. One machine, not the fleet.
    assertEquals(
      "an employee peer must accept exactly one DSH entry: accepted=$accepted records=$records",
      1,
      accepted.length(),
    )
    val acceptedName = accepted.getJSONObject(0).optString("name")
    assertTrue(
      "the accepted entry is not the employee's own machine: name=$acceptedName",
      acceptedName.startsWith("dsh."),
    )
  }

  private var lastRecords = ""
  private var lastAccepted = JSONArray()

  /**
   * Enrols a brand-new peer through the app's own config paths, waits for the
   * network map, then reads the catalogue and what the app accepts from it.
   */
  private fun enrolAndCollectPeers(setupKey: String): Set<String> {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val config = File(context.filesDir, "netbird-scope-config.json").absolutePath
    val state = File(context.filesDir, "netbird-scope-state.json").absolutePath
    // Each case must enrol a NEW peer with its own key: an enrolment that is
    // already on disk would keep the previous case's groups and make the two
    // cases indistinguishable.
    runCatching { File(config).delete() }
    runCatching { File(state).delete() }

    Portal.start(setupKey, "netbird-portal-android", management, config, state)

    var status = ""
    val connectDeadline = System.currentTimeMillis() + 90_000
    while (System.currentTimeMillis() < connectDeadline) {
      status = runCatching { Portal.status() }.getOrDefault("")
      if (status.contains("\"managementConnected\":true")) break
      Thread.sleep(2000)
    }
    Log.i(tag, "status=$status")
    assertTrue("management never connected: $status", status.contains("\"managementConnected\":true"))

    // The map is pushed asynchronously and arrives in pieces; a set that is
    // still small right after connecting is normal, not an answer.
    var peersJson = "[]"
    var peers = emptySet<String>()
    val mapDeadline = System.currentTimeMillis() + 60_000
    while (System.currentTimeMillis() < mapDeadline) {
      peersJson = runCatching { Portal.peerAddresses() }.getOrDefault("[]")
      peers = DshHostRegistry.parsePeerAddresses(peersJson)
      if (peers.isNotEmpty()) {
        // one more settle interval, so a partially delivered map is not read
        // as the final answer
        Thread.sleep(4000)
        peersJson = runCatching { Portal.peerAddresses() }.getOrDefault("[]")
        peers = DshHostRegistry.parsePeerAddresses(peersJson)
        break
      }
      Thread.sleep(2000)
    }

    lastRecords = Portal.listServices()
    lastAccepted = JSONArray(DshHostRegistry.acceptRecords(context, lastRecords, peersJson))
    return peers
  }

  private fun csv(value: String?): Set<String> =
    (value ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }.toSet()
}