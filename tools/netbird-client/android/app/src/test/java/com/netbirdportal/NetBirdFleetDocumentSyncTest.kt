package com.netbirdportal

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * The control plane has one owner: the address a fresh install enrolls against,
 * which is a build input now (`-PawManagementUrl=`, see build.gradle) rather than a
 * source literal.
 *
 * What is still worth pinning is that the two committed mirrors of the *fallback*
 * stay in step: `android/app/build.gradle` (`awManagementUrlFallback`) and
 * `src/fleetConfig.ts` (the fleet document's record of the same address, which
 * `scripts/publish.sh` writes into fleet.json). A deployment that overrides the
 * address on purpose is not drift, and an APK carrying an address its channel does
 * not advertise is refused by that same publish script.
 *
 * Paths are relative to the Gradle module directory (android/app), matching
 * [NetworkSecurityConfigSyncTest], which reads the machine inventory the same way.
 */
class NetBirdFleetDocumentSyncTest {
  @Test
  fun theCommittedFallbackIsTheAddressTheFleetDocumentRecords() {
    val build = File("build.gradle").readText()
    val fallback =
      Regex("def awManagementUrlFallback = '([^']+)'").find(build)?.groupValues?.get(1)
    assertNotNull("build.gradle declares no awManagementUrlFallback", fallback)

    val document = File("../../src/fleetConfig.ts").readText()
    val declared =
      Regex("managementUrl:\\s*'([^']+)'").find(document)?.groupValues?.get(1)
    assertNotNull("network: src/fleetConfig.ts declares no managementUrl default", declared)

    assertEquals(fallback, declared)
  }

  @Test
  fun theCompiledDefaultIsACanonicalAddress() {
    // Whatever the build was given - the committed fallback or a deployment's own
    // control plane - has to be an address the engine can dial, in the one form the
    // native rule accepts. A malformed -PawManagementUrl= is then caught here instead
    // of on a phone that cannot sign in.
    assertEquals(
      NetBirdRuntime.DEFAULT_MANAGEMENT_URL,
      NetBirdServerAddress.normalize(NetBirdRuntime.DEFAULT_MANAGEMENT_URL),
    )
  }
}