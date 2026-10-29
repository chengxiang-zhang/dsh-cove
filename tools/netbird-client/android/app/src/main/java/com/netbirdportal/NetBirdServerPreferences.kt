package com.netbirdportal

import android.content.Context

/**
 * The management server this install enrolls against, when the user has chosen
 * one.
 *
 * It is stored apart from [NetBirdConnectionPreferences] because the two answer
 * different questions: that object records what the connection lifecycle is
 * doing, this one records the account identity the user picked. An absent value
 * means "the address the app ships with" (see `NetBirdRuntime`), which is why
 * clearing the key is the way back to the default.
 *
 * Writes use `commit()` rather than `apply()`: the value must be on disk before
 * the enrollment it invalidates is purged, and before the settings row reads it
 * back.
 */
object NetBirdServerPreferences {
  private const val PREFERENCES_NAME = "netbird-server"
  private const val KEY_MANAGEMENT_URL = "management-url"

  /** The chosen address, or null when this install uses the compiled default. */
  fun configured(context: Context): String? =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .getString(KEY_MANAGEMENT_URL, null)

  fun set(context: Context, url: String) {
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_MANAGEMENT_URL, url)
      .commit()
  }

  fun clear(context: Context) {
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(KEY_MANAGEMENT_URL)
      .commit()
  }
}