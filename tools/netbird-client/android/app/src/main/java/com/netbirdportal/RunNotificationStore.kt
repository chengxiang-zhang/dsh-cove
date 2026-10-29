package com.netbirdportal

import android.content.Context

/**
 * Persistence for finished-run notifications, kept in its own store next to
 * `netbird-browser-session` (the app's existing SharedPreferences file for
 * small, single-purpose state) rather than in the connection store whose keys
 * drive the foreground service lifecycle.
 *
 * Two kinds of value live here:
 *
 * - the user's enable/disable switch, defaulting to enabled;
 * - the per-host read watermark, so a restart of the app does not re-alert for
 *   work that was already reported.
 *
 * A missing or unreadable watermark is 0, never an exception: a client that
 * cannot parse its stored value should be told everything again rather than
 * nothing, which is also what the contract's `clampWatermark` decides.
 */
object RunNotificationStore {
  private const val PREFERENCES_NAME = "netbird-run-notifications"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_LAST_HOST = "last-host"

  /** Long work started from the phone should report back without a setting first. */
  const val ENABLED_BY_DEFAULT = true

  fun isEnabled(context: Context): Boolean =
    preferences(context).getBoolean(KEY_ENABLED, ENABLED_BY_DEFAULT)

  fun setEnabled(context: Context, enabled: Boolean) {
    preferences(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
  }

  /**
   * The stored watermark, or 0. A corrupt value - a string where an int is
   * expected, or a negative number - degrades to "nothing seen yet", because a
   * client that cannot read its own watermark must be told everything again
   * rather than nothing.
   */
  fun watermark(context: Context, host: String): Int {
    val stored = preferences(context)
    val raw = runCatching { stored.getInt(watermarkKey(host), 0) }.getOrDefault(0)
    return WatermarkRule.clamp(raw)
  }

  fun setWatermark(context: Context, host: String, watermark: Int) {
    if (host.isBlank()) return
    preferences(context).edit()
      .putInt(watermarkKey(host), WatermarkRule.clamp(watermark))
      .apply()
  }

  /**
   * The machine the last finished-run notification was about, so a tap can open
   * the app on that machine and the service can rebuild the same deep link.
   */
  fun lastHost(context: Context): String? =
    preferences(context).getString(KEY_LAST_HOST, null)?.trim()?.takeIf { it.isNotEmpty() }

  fun setLastHost(context: Context, host: String) {
    preferences(context).edit().putString(KEY_LAST_HOST, host).apply()
  }

  /**
   * Forgets every stored watermark. Used when the user turns the switch off and
   * on again, so the next connection starts from a clean baseline instead of
   * replaying the history of a host that restarted in between.
   */
  fun clearWatermarks(context: Context) {
    val stored = preferences(context)
    val editor = stored.edit()
    for (key in stored.all.keys) {
      if (key.startsWith(WATERMARK_PREFIX)) {
        editor.remove(key)
      }
    }
    editor.apply()
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  private fun contentKey(host: String) = host.trim().lowercase()

  private fun watermarkKey(host: String) = "$WATERMARK_PREFIX${contentKey(host)}"

  private const val WATERMARK_PREFIX = "watermark."
}