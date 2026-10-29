package com.netbirdportal

import android.content.Context

object BrowserSessionStore {
  private const val PREFERENCES_NAME = "netbird-browser-session"
  private const val KEY_LAST_URL = "last-url"

  fun lastUrl(context: Context): String? =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .getString(KEY_LAST_URL, null)
      ?.takeIf { it.isNotBlank() }

  fun rememberUrl(context: Context, url: String) {
    if (url.isBlank()) return
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_LAST_URL, url)
      .apply()
  }
}
