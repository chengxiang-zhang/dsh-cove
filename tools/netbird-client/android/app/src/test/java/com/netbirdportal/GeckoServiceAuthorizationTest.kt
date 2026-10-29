package com.netbirdportal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GeckoServiceAuthorizationTest {
  private val registeredHosts = setOf("dsh.studio-mac.netbird", "dsh.laptop-b.netbird")

  @Test
  fun bindsMicrophoneAuthorizationToAnExactRegisteredServiceHost() {
    assertEquals(
      "dsh.studio-mac.netbird",
      GeckoServiceActivity.authorizedHostFor(
        "http://dsh.studio-mac.netbird/conversation/1",
        "DSH.STUDIO-MAC.NETBIRD",
        registeredHosts,
      ),
    )
  }

  @Test
  fun rejectsUnregisteredPublicLookalikesEvenWhenCandidateMatchesUrl() {
    assertNull(
      GeckoServiceActivity.authorizedHostFor(
        "https://dsh.attacker.com",
        "dsh.attacker.com",
        registeredHosts,
      ),
    )
  }

  @Test
  fun rejectsMismatchedAndUnregisteredAuthorization() {
    assertNull(
      GeckoServiceActivity.authorizedHostFor(
        "https://dsh.attacker.com",
        "dsh.studio-mac.netbird",
        registeredHosts,
      ),
    )
    assertNull(
      GeckoServiceActivity.authorizedHostFor(
        "http://wiki.studio-mac",
        "wiki.studio-mac",
        registeredHosts,
      ),
    )
    assertNull(
      GeckoServiceActivity.authorizedHostFor(
        "http://dsh.studio-mac.netbird",
        "dsh.laptop-b.netbird",
        registeredHosts,
      ),
    )
  }

  @Test
  fun keepsTheMicrophoneBoundWhenTheNotificationCarriesOnlyTheUrl() {
    // The ongoing notification opens a validated registered URL without the
    // JavaScript-supplied host extra; dropping the binding there silently broke
    // DSH voice input.
    assertEquals(
      "dsh.studio-mac.netbird",
      GeckoServiceActivity.authorizedHostFor("http://dsh.studio-mac.netbird/", null, registeredHosts),
    )
    assertEquals(
      "dsh.studio-mac.netbird",
      GeckoServiceActivity.authorizedHostFor("http://dsh.studio-mac.netbird/", "  ", registeredHosts),
    )
  }
}
