package com.netbirdportal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class NetBirdBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action !in SUPPORTED_ACTIONS) {
      return
    }
    if (!NetBirdConnectionPreferences.shouldKeepConnected(context)) {
      return
    }
    val pending = goAsync()
    Thread {
      try {
        if (NetBirdRuntime.hasPersistedConfig(context)) {
          // Android can refuse a background foreground-service start; letting
          // that escape this worker thread crashes the process instead of
          // simply skipping the restart.
          runCatching { NetBirdConnectionService.start(context) }
            .onFailure { Log.w(TAG, "connection restart after boot failed", it) }
        }
      } finally {
        pending.finish()
      }
    }.start()
  }

  companion object {
    private const val TAG = "NetBirdBoot"

    private val SUPPORTED_ACTIONS = setOf(
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
    )
  }
}
