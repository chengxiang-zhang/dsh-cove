package com.netbirdportal

import org.json.JSONArray
import org.json.JSONObject

/**
 * The one piece of the finished-run rules that needs a JSON implementation.
 *
 * Decoding happens here, deciding happens in [RunNotifications] over plain
 * Kotlin collections, so the rules stay unit-testable while the wire parse
 * still uses the platform's own org.json (also on the JVM test classpath,
 * alongside the registry tests).
 *
 * Every failure mode - a 404 body, an empty body, a truncated document, a JSON
 * literal that is not an object - returns null, which the caller reads as
 * "nothing to notify". None of them is an error and none of them may throw
 * inside a foreground service.
 */
object NotifyFeedJson {
  fun parse(body: String?): NotifyFeedDoc? {
    val text = body?.trim().orEmpty()
    if (text.isEmpty()) return null
    if (!text.startsWith("{")) return null
    val root = runCatching { JSONObject(text) }.getOrNull() ?: return null
    return RunNotifications.parseFeed(root.toPlainValue())
  }

  /**
   * Narrows one `Portal.fetch` envelope into a feed.
   *
   * `Portal.fetch` answers with `{url, statusCode, body}` and does NOT throw on
   * a non-2xx status, so the status has to be considered here: a machine that
   * has not been updated yet answers 404, and that is "no notifications", not a
   * failure. An envelope that cannot be decoded is equally silent.
   */
  fun parseEnvelope(raw: String?): NotifyFeedDoc? {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty()) return null
    val envelope = runCatching { JSONObject(text) }.getOrNull() ?: return null
    if (envelope.optInt("statusCode", 0) != HTTP_OK) return null
    return parse(envelope.optString("body"))
  }

  /**
   * One value as plain Kotlin, never as an org.json type: this is what lets the
   * decision layer be tested without any JSON library on the classpath.
   */
  private fun Any?.toPlainValue(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> {
      val mapped = LinkedHashMap<String, Any?>()
      val keys = keys()
      while (keys.hasNext()) {
        val key = keys.next()
        mapped[key] = opt(key).toPlainValue()
      }
      mapped
    }
    is JSONArray -> {
      val mapped = ArrayList<Any?>(length())
      for (index in 0 until length()) {
        mapped.add(opt(index).toPlainValue())
      }
      mapped
    }
    else -> this
  }

  private const val HTTP_OK = 200
}