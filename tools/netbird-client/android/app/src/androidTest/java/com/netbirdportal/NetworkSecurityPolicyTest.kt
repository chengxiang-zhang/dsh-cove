package com.netbirdportal

import android.security.NetworkSecurityPolicy
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NetworkSecurityPolicyTest {
  private val policy = NetworkSecurityPolicy.getInstance()

  @Test
  fun cleartextIsAllowedOnlyForLoginLoopbackAndPrivateZones() {
    assertTrue(policy.isCleartextTrafficPermitted("localhost"))
    assertTrue(policy.isCleartextTrafficPermitted("127.0.0.1"))
    // Overlay namespaces: the DSH zone and the peer namespace the connect-time
    // liveness probe addresses (tx.vpn).
    assertTrue(policy.isCleartextTrafficPermitted("dsh.studio-mac.netbird"))
    assertTrue(policy.isCleartextTrafficPermitted("dsh.thinkcentre-lab.netbird"))
    assertTrue(policy.isCleartextTrafficPermitted("tx.vpn"))

    assertFalse(policy.isCleartextTrafficPermitted("example.com"))
    assertFalse(policy.isCleartextTrafficPermitted("dsh.attacker.com"))
    assertFalse(policy.isCleartextTrafficPermitted("netbird.example.com"))
    // The update channel is a public HTTPS origin, so it must NOT be reachable
    // over cleartext - that is what made the old `dl-dev` exception obsolete.
    assertFalse(policy.isCleartextTrafficPermitted("anywhere.example.com"))
    assertFalse(policy.isCleartextTrafficPermitted("apk.dl-dev"))
    // The retired per-machine zones are no longer trusted for cleartext: those
    // names are not the canonical authority any more.
    assertFalse(policy.isCleartextTrafficPermitted("dsh.studio-mac"))
  }
}
