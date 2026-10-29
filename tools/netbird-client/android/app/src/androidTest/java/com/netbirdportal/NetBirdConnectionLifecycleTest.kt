package com.netbirdportal

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NetBirdConnectionLifecycleTest {
  private lateinit var context: Context

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences("netbird-connection", Context.MODE_PRIVATE).edit().clear().commit()
  }

  @After
  fun tearDown() {
    context.getSharedPreferences("netbird-connection", Context.MODE_PRIVATE).edit().clear().commit()
  }

  @Test
  fun explicitStopSurvivesColdStateUntilUserReconnects() {
    NetBirdConnectionPreferences.markConnectedByUser(context)
    assertTrue(NetBirdConnectionPreferences.shouldKeepConnected(context))
    assertFalse(NetBirdConnectionPreferences.wasStoppedByUser(context))

    NetBirdConnectionPreferences.markStoppedByUser(context)
    assertFalse(NetBirdConnectionPreferences.shouldKeepConnected(context))
    assertTrue(NetBirdConnectionPreferences.wasStoppedByUser(context))

    NetBirdConnectionPreferences.markConnectedByUser(context)
    assertTrue(NetBirdConnectionPreferences.shouldKeepConnected(context))
    assertFalse(NetBirdConnectionPreferences.wasStoppedByUser(context))
  }

  @Test
  fun authenticationRejectionIsNotRecordedAsUserLogout() {
    NetBirdConnectionPreferences.markConnectedByUser(context)
    NetBirdConnectionPreferences.markAuthenticationRequired(context)

    assertFalse(NetBirdConnectionPreferences.shouldKeepConnected(context))
    assertFalse(NetBirdConnectionPreferences.wasStoppedByUser(context))
    assertTrue(NetBirdConnectionPreferences.isAuthenticationRequired(context))
  }
}
