package com.netbirdportal

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkSecurityConfigSyncTest {
  @Test
  fun theCompiledZoneMatchesTheInventoryAndItsCleartextPolicy() {
    val machines = File("../../../dsh-netbird/machines.json").readText()
    val securityConfig = File("src/main/res/xml/network_security_config.xml").readText()
    val zonesXml = File("src/main/res/values/fleet_dsh_zones.xml").readText()
    val pattern = Regex("\\\"domainPattern\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
      .find(machines)
      ?.groupValues
      ?.get(1)
      ?: error("machines.json declares no domainPattern")
    val inventory = Regex(
      "\\\"netbirdName\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"[\\s\\S]*?\\\"domain\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"",
    ).findAll(machines).associate { it.groupValues[1] to it.groupValues[2] }

    assertTrue("machines.json must register at least one machine", inventory.isNotEmpty())
    inventory.forEach { (machine, domain) ->
      assertEquals(
        "machines.json domain of $machine must follow its own domainPattern $pattern",
        pattern.replace("<netbird-machine-name>", machine),
        domain,
      )
    }

    // The zone is the pattern's literal suffix (dsh.<machine>.netbird ->
    // netbird). It is the only thing the app still compiles in, because
    // Android's cleartext policy is a build-time resource; the machine list is
    // discovered from the control plane at runtime.
    val zone = pattern.substringAfterLast('>').removePrefix(".")
    assertTrue("domainPattern must end in a literal zone", zone.isNotEmpty() && !zone.contains('<'))
    val compiledZones = Regex("<item>\\s*([^<\\s]+)\\s*</item>")
      .findAll(zonesXml)
      .map { it.groupValues[1] }
      .toSet()
    assertEquals("fleet_dsh_zones.xml must declare exactly the pattern's zone", setOf(zone), compiledZones)
    assertTrue(
      "network_security_config.xml is missing NetBird cleartext zone $zone",
      securityConfig.contains(">$zone</domain>"),
    )
    // And every machine's canonical name really does sit inside that zone.
    inventory.values.forEach { domain ->
      assertTrue("$domain must live inside the declared zone $zone", domain.endsWith(".$zone"))
    }
  }

  @Test
  fun theMachineInventoryStaysOutOfTheApk() {
    // The compiled machine list is what made a fleet-side rename empty the
    // catalogue on every phone. Adding one back has to fail a check.
    val legacyInventory = File("src/main/res/values/authorized_dsh_hosts.xml")
    assertFalse("a compiled DSH machine list must not come back", legacyInventory.exists())
  }
}