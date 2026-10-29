package com.netbirdportal

/**
 * The pure decision layer behind a finished-run notification.
 *
 * Nothing in this file touches an Android framework class, so the whole rule
 * set - what the feed means, which notices are new, and what the notification
 * says - runs in a JVM unit test. The service keeps only the Android-shaped
 * parts: SharedPreferences, the netstack fetch and the notification itself.
 *
 * The wire contract it reads is `packages/dsh-web-all/src/core/notify/contract.ts`;
 * that file is the one description of a notice and this is a defensive reader of
 * it, not a second contract. Every field is re-derived rather than trusted, so a
 * truncated or unknown payload degrades into "nothing to notify" instead of a
 * crash inside a foreground service.
 *
 * The user-facing wording lives in `res/values/strings.xml` (the rule here
 * decides counts and which machine to name), so it stays translatable and
 * matches the app's existing voice.
 */

/** How a finished turn ended, collapsed to the three answers a person acts on. */
enum class RunOutcome(val wire: String) {
  COMPLETED("completed"),
  FAILED("failed"),
  STOPPED("stopped");

  companion object {
    /**
     * The contract's collapse of a raw `TurnEndReason` kind. An unrecognized
     * reason comes from a plugin that merged a new variant; reporting it as
     * completed would put a success claim on something no one inspected, so it
     * takes the neutral outcome.
     */
    fun ofReason(reason: String?): RunOutcome = when (reason?.trim()) {
      "completed", "max-tokens" -> COMPLETED
      "error", "blocked" -> FAILED
      else -> STOPPED
    }

    /** Parses the wire value, falling back to the raw reason when absent. */
    fun parse(value: String?, reason: String?): RunOutcome = when (value?.trim()) {
      COMPLETED.wire -> COMPLETED
      FAILED.wire -> FAILED
      STOPPED.wire -> STOPPED
      else -> ofReason(reason)
    }
  }

  /** Whether this outcome is worth interrupting a person for. */
  val notifiable: Boolean
    get() = this == COMPLETED || this == FAILED
}

/** One finished turn as the feed reports it. */
data class RunNotice(
  val id: Int,
  val at: Long,
  val sessionId: String,
  val title: String,
  val turn: Int,
  val reason: String,
  val outcome: RunOutcome,
)

/** The feed document, already narrowed from the wire. */
data class NotifyFeedDoc(
  val latest: Int,
  val notices: List<RunNotice>,
)

/**
 * The watermark rule from the contract, ported natively.
 *
 * Notice ids count from one host process, so a restarted host serves ids that
 * start over. A stored watermark from the previous process would then be higher
 * than every new id and would hide each new notice forever - the one failure
 * mode a finished-run alert must not have. A regression therefore means "this
 * host is a different process now; start over", and the caller keeps 0 and
 * treats the whole held log as new.
 */
object WatermarkRule {
  /** A stored watermark is only ever a non-negative whole number. */
  fun clamp(value: Int?): Int = when {
    value == null -> 0
    value < 0 -> 0
    else -> value
  }

  /**
   * The watermark to keep and compare against, given what the host just served.
   * A non-finite or negative `latest` is ignored and the previous value stands.
   */
  fun reconcile(previous: Int, latest: Int): Int {
    if (latest < 0) return previous
    return if (latest < clamp(previous)) 0 else clamp(previous)
  }

  /** The effective watermark after reading `latest` off the wire. */
  fun effective(previous: Int, latest: Int): Int = reconcile(clamp(previous), latest)

  /**
   * Which ids are worth a notification.
   *
   * Two rules beyond the outcome filter:
   *
   * - `baseline` marks the first read from a host in this connection. The feed
   *   holds the host's recent history, and a phone that reconnects after days
   *   away must not buzz once for every turn that finished while it was gone,
   *   so the first contact only establishes what "already seen" means.
   * - `latest` is the value to store afterwards. It is the feed's `latest` when
   *   that is usable, else the newest id among the notifiable notices.
   */
  fun select(
    notices: List<RunNotice>,
    previous: Int,
    latest: Int,
    baseline: Boolean,
  ): Selection {
    if (baseline) {
      val anchor = if (latest > 0) latest else notices.maxOfOrNull { it.id } ?: 0
      return Selection(emptyList(), if (anchor > 0) anchor else clamp(previous))
    }
    val effective = effective(previous, latest)
    val fresh = notices
      .filter { it.id > effective && it.outcome.notifiable }
      .sortedBy { it.id }
    val stored = when {
      latest > effective -> latest
      else -> maxOf(effective, fresh.maxOfOrNull { it.id } ?: effective)
    }
    return Selection(fresh, stored)
  }

  /** The notifiable notices plus the watermark to persist. */
  data class Selection(val notices: List<RunNotice>, val watermark: Int)
}

/**
 * Selects nothing from a host's history on first contact, and otherwise reports
 * every notifiable turn newer than the stored watermark.
 */
object RunNotifications {
  /** How many notices the poll asks for; matches the host's own default. */
  const val LIMIT = 20

  /** The feed path, appended to one accepted machine's root URL. */
  const val FEED_PATH = "/api/dsh-notify/feed"

  /** The feed URL for one host, with the stored watermark. */
  fun feedUrl(host: String, watermark: Int): String =
    "http://$host$FEED_PATH?since=${WatermarkRule.clamp(watermark)}&limit=$LIMIT"

  /**
   * Narrows one decoded notice. Returns null when the element is not an object
   * at all; every field inside is re-derived.
   */
  fun parseNotice(value: Any?): RunNotice? {
    val record = value as? Map<*, *> ?: return null
    val reason = asString(record["reason"])
    return RunNotice(
      id = asWhole(record["id"]),
      at = asWholeLong(record["at"]),
      sessionId = asString(record["sessionId"]),
      title = asString(record["title"]),
      turn = asWhole(record["turn"]),
      reason = reason,
      outcome = RunOutcome.parse(asString(record["outcome"]), reason),
    )
  }

  /**
   * Narrows a whole feed document. Returns null when the body is not a feed
   * object, which is how a malformed payload, a 404 page or an empty body all
   * end up as "nothing to notify" instead of a throw.
   */
  fun parseFeed(value: Any?): NotifyFeedDoc? {
    val record = value as? Map<*, *> ?: return null
    // A JSON object that carries neither feed key is not a feed: it is a proxy
    // error page, a login page or a shape this app does not know. Treating it as
    // an empty feed would be indistinguishable from "the host has nothing", so
    // it is refused instead.
    if (!record.containsKey("notices") && !record.containsKey("latest")) return null
    val notices = (record["notices"] as? List<*>)
      .orEmpty()
      .mapNotNull { parseNotice(it) }
    val declared = record["latest"]
    val latest = if (isUsableNumber(declared)) {
      asWhole(declared)
    } else {
      notices.maxOfOrNull { it.id } ?: 0
    }
    return NotifyFeedDoc(latest = latest, notices = notices)
  }

  private fun asString(value: Any?): String = value as? String ?: ""

  private fun isUsableNumber(value: Any?): Boolean {
    val parsed = when (value) {
      is Number -> value.toDouble()
      is String -> value.trim().toDoubleOrNull()
      else -> null
    }
    return parsed != null && parsed.isFinite()
  }

  private fun asWhole(value: Any?): Int {
    val parsed = when (value) {
      is Number -> value.toDouble()
      is String -> value.trim().toDoubleOrNull()
      else -> null
    }
    if (parsed == null || !parsed.isFinite()) return 0
    return parsed.toInt()
  }

  /** Notice ids are small counters; `at` is epoch milliseconds and must not be squeezed into one. */
  private fun asWholeLong(value: Any?): Long {
    val parsed = when (value) {
      is Number -> value.toDouble()
      is String -> value.trim().toDoubleOrNull()
      else -> null
    }
    if (parsed == null || !parsed.isFinite()) return 0L
    return parsed.toLong()
  }
}

/**
 * What one poll decided, in the shape the notification needs. The text is built
 * from resource templates so it stays translatable; this type only carries the
 * counts and the machine the work ran on.
 */
data class RunNotificationSummary(
  val host: String,
  val title: String,
  val completed: Int,
  val failed: Int,
) {
  val total: Int get() = completed + failed
}

/**
 * Turns the selected notices into one summary, newest title first.
 *
 * Every consumer shows one notification per poll tick, so several runs that
 * finished together collapse into a single line that says how many there were.
 */
object RunNotificationSummaryFactory {
  fun of(host: String, notices: List<RunNotice>): RunNotificationSummary? {
    val notifiable = notices.filter { it.outcome.notifiable }
    if (notifiable.isEmpty()) return null
    val newest = notifiable.last()
    val title = newest.title.trim().ifEmpty { host }
    return RunNotificationSummary(
      host = host,
      title = title,
      completed = notifiable.count { it.outcome == RunOutcome.COMPLETED },
      failed = notifiable.count { it.outcome == RunOutcome.FAILED },
    )
  }
}