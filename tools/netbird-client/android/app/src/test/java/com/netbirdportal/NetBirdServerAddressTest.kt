package com.netbirdportal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The management address is the enrollment identity of the install and the value
 * the embedded client dials, so what the field accepts is a product rule, not a
 * formatting preference. These cases pin the rule down.
 */
class NetBirdServerAddressTest {
  @Test
  fun canonicalizesCaseTheTrailingSlashAndThePort() {
    assertEquals(
      "https://netbird.example.com:443",
      NetBirdServerAddress.normalize(" https://NetBird.Example.com/ "),
    )
    assertEquals(
      "https://netbird.example.com:443",
      NetBirdServerAddress.normalize("https://netbird.example.com:443"),
    )
    assertEquals(
      "https://netbird.example.com:8443",
      NetBirdServerAddress.normalize("https://netbird.example.com:8443"),
    )
  }

  @Test
  fun makesTheDefaultPortExplicit() {
    // Without this, `https://host` and `https://host:443` would be two identities
    // that differ only by formatting, and saving one would re-enroll the device.
    assertEquals(
      "https://netbird.example.com:443",
      NetBirdServerAddress.normalize("https://netbird.example.com"),
    )
  }

  @Test
  fun refusesAnythingThatIsNotAnHttpsOrigin() {
    val refused = listOf(
      "",
      "   ",
      "netbird.example.com",
      "http://netbird.example.com",
      "ftp://netbird.example.com",
      "javascript:alert(1)",
      "https://user:secret@netbird.example.com",
      "https://netbird.example.com/oauth2",
      "https://netbird.example.com?tenant=1",
      "https://netbird.example.com#top",
      "https://netbird.example.com:0",
      "https://netbird.example.com:70000",
      "https://net bird.example.com",
      "https://",
    )
    for (raw in refused) {
      assertNull("should have been refused: <$raw>", NetBirdServerAddress.normalize(raw))
    }
  }

  @Test
  fun refusesAPasteLongerThanTheFieldAllows() {
    val pasted = "https://netbird.example.com/" + "a".repeat(NetBirdServerAddress.MAX_LENGTH)
    assertNull(NetBirdServerAddress.normalize(pasted))
  }

  @Test
  fun theCompiledDefaultPassesTheSameRuleTheFieldEnforces() {
    // The shipped address must be expressible in the field: otherwise the first
    // thing a user sees is an address the app would refuse to save.
    val normalized = NetBirdServerAddress.normalize(NetBirdRuntime.DEFAULT_MANAGEMENT_URL)
    assertNotNull(normalized)
    assertEquals(NetBirdRuntime.normalizedDefaultManagementUrl, normalized)
    assertTrue(
      "the compiled default must be an https origin with an explicit port: $normalized",
      Regex("^https://[a-z0-9.-]+:\\d+$").matches(normalized!!),
    )
  }
}