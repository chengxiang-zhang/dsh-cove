package com.netbirdportal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

class DshHostRegistryTest {
  private val fleetZones = setOf("netbird")
  private val peers = setOf("100.64.0.11", "100.64.0.12", "100.64.0.15")

  private fun accepted(
    type: Int = 1,
    name: String,
    zone: String,
    content: String,
    cloudMode: Boolean = false,
    cloudDnsDomain: String = "netbird.cloud",
  ) = DshHostRegistry.acceptedDshName(type, name, zone, content, fleetZones, peers, cloudMode, cloudDnsDomain)

  @Test
  fun canonicalRecordNameMatchesTheClientRule() {
    assertEquals("dsh.studio-mac.netbird", DshHostRegistry.canonicalRecordName("dsh.studio-mac.netbird.", "netbird."))
    assertEquals("dsh.studio-mac.netbird", DshHostRegistry.canonicalRecordName("dsh.studio-mac", "netbird"))
    assertEquals("dsh.studio-mac", DshHostRegistry.canonicalRecordName("dsh", "studio-mac."))
    assertEquals("dsh.studio-mac.netbird", DshHostRegistry.canonicalRecordName("DSH.STUDIO-MAC.NETBIRD", "NETBIRD"))
    assertNull(DshHostRegistry.canonicalRecordName("dsh", "netbird.selfhosted"))
    assertNull(DshHostRegistry.canonicalRecordName("dsh", ""))
    assertNull(DshHostRegistry.canonicalRecordName("", "studio-mac"))
    assertNull(DshHostRegistry.canonicalRecordName("netbird", "netbird"))
  }

  @Test
  fun acceptsAFleetDshRecordThatPointsAtAPeer() {
    assertEquals("dsh.studio-mac.netbird", accepted(name = "dsh.studio-mac.netbird.", zone = "netbird.", content = "100.64.0.11"))
    // A zone-relative record in the shared zone is the same entry.
    assertEquals("dsh.laptop-b.netbird", accepted(name = "dsh.laptop-b", zone = "netbird", content = "100.64.0.12"))
    // Case and a prefixed address are normalized on both sides.
    assertEquals(
      "dsh.studio-mac.netbird",
      accepted(name = "DSH.STUDIO-MAC.NETBIRD", zone = "NETBIRD", content = "100.64.0.11/16"),
    )
  }

  @Test
  fun refusesNamesOutsideTheFleetDshScope() {
    val target = "100.64.0.11"
    // Not a DSH entry.
    assertNull(accepted(name = "wiki", zone = "netbird", content = target))
    assertNull(accepted(name = "openviking.dl-dev.", zone = "dl-dev.", content = target))
    // A retired per-machine zone names the same machine but is not a fleet zone.
    assertNull(accepted(name = "dsh", zone = "studio-mac.", content = target))
    assertNull(accepted(name = "dsh.studio-mac", zone = "dl-dev", content = target))
    // Zone root and the internal peer zone.
    assertNull(accepted(name = "netbird", zone = "netbird", content = target))
    assertNull(accepted(name = "dsh", zone = "netbird.selfhosted", content = target))
    // A DSH name always has a machine label before the zone.
    assertNull(accepted(name = "dsh", zone = "netbird", content = target))
  }

  @Test
  fun refusesATargetThatIsNotAMachineOfThisNetwork() {
    // Public host, office LAN address, an overlay address no peer owns, and an
    // empty answer.
    assertNull(accepted(name = "dsh.evil.netbird", zone = "netbird", content = "203.0.113.7"))
    assertNull(accepted(name = "dsh.evil.netbird", zone = "netbird", content = "192.168.111.32"))
    assertNull(accepted(name = "dsh.evil.netbird", zone = "netbird", content = "100.64.1.11"))
    assertNull(accepted(name = "dsh.evil.netbird", zone = "netbird", content = ""))
    // Only A records.
    assertNull(accepted(type = 28, name = "dsh.studio-mac.netbird", zone = "netbird", content = "100.64.0.11"))
  }

  @Test
  fun selectionKeepsTheAcceptedRecordsAndReportsTheirHosts() {
    val records = """
      [
        {"name":"dsh.studio-mac.netbird.","type":1,"class":"IN","content":"100.64.0.11","zone":"netbird."},
        {"name":"dsh.laptop-b","type":1,"class":"IN","content":"100.64.0.12","zone":"netbird"},
        {"name":"dsh.evil.netbird","type":1,"class":"IN","content":"203.0.113.7","zone":"netbird."},
        {"name":"wiki","type":1,"class":"IN","content":"100.64.0.15","zone":"netbird."},
        {"name":"dsh","type":1,"class":"IN","content":"100.64.0.11","zone":"studio-mac."}
      ]
    """.trimIndent()
    val peersJson = """["100.64.0.11","100.64.0.12","100.64.0.15"]"""

    val (keptJson, hosts) = DshHostRegistry.selectAcceptedDsh(records, peersJson, fleetZones)

    assertEquals(setOf("dsh.studio-mac.netbird", "dsh.laptop-b.netbird"), hosts)
    assertTrue(keptJson.contains("dsh.studio-mac.netbird."))
    assertTrue(keptJson.contains("dsh.laptop-b"))
    assertFalse(keptJson.contains("evil"))
    assertFalse(keptJson.contains("wiki"))
  }

  @Test
  fun selectionSurvivesRecordsThatAreNotEvenJson() {
    val (keptJson, hosts) = DshHostRegistry.selectAcceptedDsh("not json", "also not json", fleetZones)
    assertEquals("[]", keptJson)
    assertTrue(hosts.isEmpty())
  }

  @Test
  fun onlyADiscoveredRootDshUrlIsOpenable() {
    DshHostRegistry.replaceTrustedHosts(setOf("dsh.studio-mac.netbird", "dsh.laptop-b.netbird"))
    val leoMac = "http://dsh.studio-mac.netbird/"
    assertEquals(leoMac, DshHostRegistry.registeredServiceUrl(leoMac))
    assertEquals(
      "https://dsh.laptop-b.netbird/",
      DshHostRegistry.registeredServiceUrl("https://dsh.laptop-b.netbird"),
    )
    assertEquals(
      leoMac,
      DshHostRegistry.registeredServiceUrl("http://DSH.STUDIO-MAC.NETBIRD:80/"),
    )

    assertNull(DshHostRegistry.registeredServiceUrl("http://dsh.imac-office.netbird/"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://dsh.studio-mac/"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://wiki.studio-mac/"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://dsh.attacker.com/"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://100.64.0.11/"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://dsh.studio-mac.netbird/conversation/1"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://dsh.studio-mac.netbird:8080/"))
    assertNull(DshHostRegistry.registeredServiceUrl("ftp://dsh.studio-mac.netbird/"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://dsh.studio-mac.netbird/?x=1"))
    assertNull(DshHostRegistry.registeredServiceUrl(""))
    assertNull(DshHostRegistry.registeredServiceUrl(null))
  }

  @Test
  fun nothingIsTrustedBeforeDiscoveryRan() {
    // The trust set is runtime state, so a cold process must refuse every page
    // until the control plane has said which hosts exist.
    DshHostRegistry.replaceTrustedHosts(emptySet())

    assertTrue(DshHostRegistry.trustedHosts().isEmpty())
    assertFalse(DshHostRegistry.isTrustedHost("dsh.studio-mac.netbird"))
    assertNull(DshHostRegistry.registeredServiceUrl("http://dsh.studio-mac.netbird/"))
  }
}

  @Test
  fun cloudModeAcceptsPeerRecordsUnderTheCloudZone() {
    // The native service list synthesizes peer FQDNs from the peer table, so
    // both the zone-relative and the qualified form have to qualify equally.
    assertEquals(
      "peer-a.netbird.cloud",
      accepted(name = "peer-a", zone = "netbird.cloud", content = "100.64.0.11", cloudMode = true),
    )
    assertEquals(
      "peer-a.netbird.cloud",
      accepted(name = "peer-a.netbird.cloud", zone = "netbird.cloud", content = "100.64.0.11", cloudMode = true),
    )
  }

  @Test
  fun cloudModeRefusesNamesOutsideTheCloudZoneOrOffNetworkPeers() {
    // A dsh entry under the cloud zone is not how Cloud names peers; accepting
    // it would list a host that no Cloud setup can serve.
    assertNull(accepted(name = "dsh.peer-a", zone = "netbird.cloud", content = "100.64.0.11", cloudMode = true))
    assertNull(accepted(name = "peer-a", zone = "netbird", content = "100.64.0.11", cloudMode = true))
    assertNull(accepted(name = "peer-a", zone = "netbird.cloud", content = "93.184.216.34", cloudMode = true))
  }

  @Test
  fun cloudSelectionKeepsOnlyPeerRecordsAndTrustsTheirFqdns() {
    val records = JSONArray()
      .put(JSONObject().put("type", 1).put("name", "peer-a.netbird.cloud").put("zone", "netbird.cloud").put("content", "100.64.0.11"))
      .put(JSONObject().put("type", 1).put("name", "dsh.studio").put("zone", "netbird").put("content", "100.64.0.12"))
      .put(JSONObject().put("type", 1).put("name", "outside").put("zone", "netbird.cloud").put("content", "93.184.216.34"))
    val peersJson = JSONArray(peers.toList()).toString()
    val (keptJson, hosts) = DshHostRegistry.selectAcceptedDsh(
      records.toString(),
      peersJson,
      fleetZones,
      cloudMode = true,
      cloudDnsDomain = "netbird.cloud",
    )
    assertEquals(setOf("peer-a.netbird.cloud"), hosts)
    assertTrue(keptJson.contains("peer-a"))
    assertFalse(keptJson.contains("outside"))
  }
