package com.netbirdportal

import android.content.Context

object NetBirdConnectionPreferences {
  private const val PREFERENCES_NAME = "netbird-connection"
  private const val KEY_KEEP_CONNECTED = "keep-connected"
  private const val KEY_USER_STOPPED = "user-stopped"
  private const val KEY_AUTHENTICATION_REQUIRED = "authentication-required"

  fun shouldKeepConnected(context: Context): Boolean =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .getBoolean(KEY_KEEP_CONNECTED, false)

  fun wasStoppedByUser(context: Context): Boolean =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .getBoolean(KEY_USER_STOPPED, false)

  fun isAuthenticationRequired(context: Context): Boolean =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .getBoolean(KEY_AUTHENTICATION_REQUIRED, false)

  fun markConnectedByUser(context: Context) {
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_KEEP_CONNECTED, true)
      .putBoolean(KEY_USER_STOPPED, false)
      .putBoolean(KEY_AUTHENTICATION_REQUIRED, false)
      .apply()
  }

  fun markStoppedByUser(context: Context) {
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_KEEP_CONNECTED, false)
      .putBoolean(KEY_USER_STOPPED, true)
      .putBoolean(KEY_AUTHENTICATION_REQUIRED, false)
      .commit()
  }

  fun markAuthenticationRequired(context: Context) {
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_KEEP_CONNECTED, false)
      .putBoolean(KEY_USER_STOPPED, false)
      .putBoolean(KEY_AUTHENTICATION_REQUIRED, true)
      .commit()
  }
}
