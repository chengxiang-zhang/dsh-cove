package com.netbirdportal

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mozilla.geckoview.GeckoSession

class DshMediaPermissionDelegateTest {
  @Test
  fun acceptsGeckoMicrophoneAndroidPermissionsButRejectsCameraAndEmptyRequests() {
    assertTrue(
      DshMediaPermissionDelegate.acceptsAndroidMicrophonePermissions(
        listOf(android.Manifest.permission.RECORD_AUDIO),
      ),
    )
    assertTrue(
      DshMediaPermissionDelegate.acceptsAndroidMicrophonePermissions(
        listOf(
          android.Manifest.permission.RECORD_AUDIO,
          android.Manifest.permission.MODIFY_AUDIO_SETTINGS,
        ),
      ),
    )
    assertFalse(
      DshMediaPermissionDelegate.acceptsAndroidMicrophonePermissions(
        listOf(android.Manifest.permission.MODIFY_AUDIO_SETTINGS),
      ),
    )
    assertFalse(
      DshMediaPermissionDelegate.acceptsAndroidMicrophonePermissions(
        listOf(android.Manifest.permission.RECORD_AUDIO, android.Manifest.permission.CAMERA),
      ),
    )
    assertFalse(DshMediaPermissionDelegate.acceptsAndroidMicrophonePermissions(emptyList()))
  }

  @Test
  fun selectsMicrophoneCandidateAndRejectsVideoOrMissingMicrophone() {
    assertTrue(
      DshMediaPermissionDelegate.canGrantMicrophoneFromCandidates(
        videoCount = 0,
        audioSources = listOf(GeckoSession.PermissionDelegate.MediaSource.TYPE_AUDIO to GeckoSession.PermissionDelegate.MediaSource.SOURCE_MICROPHONE),
      ),
    )
    assertTrue(
      DshMediaPermissionDelegate.canGrantMicrophoneFromCandidates(
        videoCount = 0,
        audioSources = listOf(
          GeckoSession.PermissionDelegate.MediaSource.TYPE_AUDIO to GeckoSession.PermissionDelegate.MediaSource.SOURCE_MICROPHONE,
          GeckoSession.PermissionDelegate.MediaSource.TYPE_AUDIO to GeckoSession.PermissionDelegate.MediaSource.SOURCE_AUDIOCAPTURE,
        ),
      ),
    )
    assertFalse(
      DshMediaPermissionDelegate.canGrantMicrophoneFromCandidates(
        videoCount = 1,
        audioSources = listOf(GeckoSession.PermissionDelegate.MediaSource.TYPE_AUDIO to GeckoSession.PermissionDelegate.MediaSource.SOURCE_MICROPHONE),
      ),
    )
    assertFalse(
      DshMediaPermissionDelegate.canGrantMicrophoneFromCandidates(
        videoCount = 0,
        audioSources = listOf(GeckoSession.PermissionDelegate.MediaSource.TYPE_AUDIO to GeckoSession.PermissionDelegate.MediaSource.SOURCE_AUDIOCAPTURE),
      ),
    )
    assertFalse(
      DshMediaPermissionDelegate.canGrantMicrophoneFromCandidates(
        videoCount = 0,
        audioSources = emptyList(),
      ),
    )
  }

  @Test
  fun acceptsOnlyTheExactAuthorizedDshOrigin() {
    assertTrue(
      trusted(
        request = "http://dsh.studio-mac.netbird",
        current = "http://dsh.studio-mac.netbird/conversation/1",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
    assertTrue(
      trusted(
        request = "https://dsh.studio-mac.netbird:8443",
        current = "https://dsh.studio-mac.netbird:8443/conversation/1",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
  }

  @Test
  fun acceptsTheCloudPeerFqdnAsTheAuthorizedOrigin() {
    DshHostRegistry.setCloudDnsDomain("netbird.cloud")
    assertTrue(
      trusted(
        request = "http://studio-mac.netbird.cloud",
        current = "http://studio-mac.netbird.cloud/conversation/1",
        authorizedHost = "studio-mac.netbird.cloud",
      ),
    )
    assertFalse(
      trusted(
        request = "http://studio-mac.netbird.cloud",
        current = "http://attacker.netbird.cloud",
        authorizedHost = "studio-mac.netbird.cloud",
      ),
    )
  }

  @Test
  fun rejectsPublicLookalikesAndMissingAuthorization() {
    assertFalse(
      trusted(
        request = "https://dsh.attacker.com",
        current = "https://dsh.attacker.com",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
    assertFalse(
      trusted(
        request = "https://dsh.attacker.com",
        current = "https://dsh.attacker.com",
        authorizedHost = null,
      ),
    )
    assertFalse(
      trusted(
        request = "http://dsh.studio-mac.netbird",
        current = "http://dsh.studio-mac.netbird",
        authorizedHost = null,
      ),
    )
  }

  @Test
  fun rejectsNavigationRacesAndCrossOriginRequests() {
    assertFalse(
      trusted(
        request = "http://dsh.studio-mac.netbird",
        current = "http://wiki.studio-mac",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
    assertFalse(
      trusted(
        request = "http://dsh.laptop-b.netbird",
        current = "http://dsh.studio-mac.netbird",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
    assertFalse(
      trusted(
        request = "https://dsh.studio-mac.netbird",
        current = "http://dsh.studio-mac.netbird",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
    assertFalse(
      trusted(
        request = "http://dsh.studio-mac.netbird:3080",
        current = "http://dsh.studio-mac.netbird",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
    assertFalse(
      trusted(
        request = "data:text/html,blocked",
        current = "http://dsh.studio-mac.netbird",
        authorizedHost = "dsh.studio-mac.netbird",
      ),
    )
  }

  private fun trusted(request: String, current: String, authorizedHost: String?): Boolean =
    DshMediaPermissionDelegate.isTrustedDshOrigin(request, current, authorizedHost)
}

