package com.netbirdportal

import android.content.Context
import android.util.Log
import io.netbird.portal.Portal
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Polls the finished-run feed of every accepted machine and raises one normal
 * notification when something finished while the user was away.
 *
 * Why the foreground service owns this instead of JavaScript: the phone learns
 * that work finished precisely when the app is NOT open, and a JS timer stops
 * with the React instance. `NetBirdConnectionService` is the one component the
 * app keeps alive in the background across screen lock and process restart, and
 * it already holds the netstack that reaches the overlay, so a poll here is the
 * only shape that makes the alert useful at all. The JS side only reads and
 * writes the switch.
 *
 * The netstack calls are the same ones the app uses everywhere else
 * (`Portal.listServices` / `Portal.peerAddresses` / `Portal.fetch`), so a notice
 * is read over the overlay connection the user is already connected to, not over
 * the phone's general network.
 *
 * Hosts are discovered here rather than read off `DshHostRegistry`: that set is
 * filled by the React Native catalogue load, so a service restarted from the
 * boot receiver - with the app never opened - would have an empty trust set and
 * this feature would silently do nothing. The acceptance rule is still the one
 * registry method, so the poller can only ever talk to hosts the app itself
 * would accept.
 *
 * Everything that decides - the switch, the watermarks, the accepted hosts, the
 * connection state and the fetch itself - arrives through [RunNotificationState],
 * which is why the whole poll loop is exercised by a JVM unit test and this file
 * touches only `Log` from the Android framework.
 */
class RunNotificationPoller(
  private val state: RunNotificationState,
  private val listener: Listener,
) {
  /** What the poller asks the service to do; the service owns notifications. */
  interface Listener {
    /** One finished-run notification for this batch. */
    fun onRunFinished(summary: RunNotificationSummary)

    /** Nothing should be shown any more: the switch went off while one was up. */
    fun onRunNotificationsCleared()
  }

  private val running = AtomicBoolean(false)
  private var scheduler: ScheduledExecutorService? = null

  /**
   * Whether this connection has already seen the history of the current host
   * set. Reset whenever the poll stops, so reconnecting establishes a fresh
   * baseline instead of alerting for everything that finished while away.
   */
  private var baselined = false

  /** The accepted hosts, and when they were last re-read from discovery. */
  private var hosts: Set<String> = emptySet()
  private var hostsDiscoveredAt = 0L

  /** The machine the last notification was about, so ticks rotate through them. */
  private var lastNotifiedHost: String? = null

  fun start() {
    if (!running.compareAndSet(false, true)) return
    val service = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "run-notify-poll")
    }
    scheduler = service
    // One immediate pass, then the interval. The first pass only establishes a
    // baseline; it notifies nothing.
    service.scheduleWithFixedDelay(
      { runCatching { tick() }.onFailure { Log.w(TAG, "poll tick failed", it) } },
      FIRST_TICK_DELAY_SECONDS,
      POLL_INTERVAL_SECONDS,
      TimeUnit.SECONDS,
    )
  }

  fun stop() {
    running.set(false)
    baselined = false
    hosts = emptySet()
    hostsDiscoveredAt = 0L
    lastNotifiedHost = null
    scheduler?.shutdownNow()
    scheduler = null
  }

  /** The connection dropped or the engine was rebuilt: re-baseline on return. */
  fun resetBaseline() {
    baselined = false
  }

  /**
   * One poll. Never raises more than one notification: several runs that
   * finished together collapse into one summary.
   */
  fun tick() {
    if (!runCatching { state.notificationsEnabled() }.getOrDefault(true)) {
      if (baselined) {
        baselined = false
        listener.onRunNotificationsCleared()
      }
      return
    }
    if (!runCatching { state.connected() }.getOrDefault(false)) {
      baselined = false
      return
    }
    val now = state.now()
    val accepted = acceptedHosts(now)
    if (accepted.isEmpty()) {
      // Discovery has not accepted anything, or has not run yet. Do not touch
      // the baseline: an empty catalogue is a normal transient on cold start.
      return
    }
    val baseline = !baselined
    var posted: RunNotificationSummary? = null
    // The loop stops at the first host with something to report, so a tick raises
    // one notice at most. A host that also has unreported work keeps its
    // watermark where it is and gets its own tick, because advancing it here
    // would count that work as already reported and the user would never hear
    // about it.
    for (host in rotate(accepted, lastNotifiedHost)) {
      val decision = pollHost(host, baseline)
      when {
        // A baseline pass reports nothing, so every host's watermark is stored.
        baseline -> runCatching { state.saveWatermark(host, decision.watermark) }
        // Nothing the user should be interrupted for: remember how far the feed
        // was read so a host that only serves stopped turns is not re-read.
        !decision.notifiable -> runCatching { state.saveWatermark(host, decision.watermark) }
        decision.summary != null -> {
          runCatching { state.saveWatermark(host, decision.watermark) }
          posted = decision.summary
          break
        }
        // Notifiable work that this tick does not report: leave the watermark
        // where it is so the next tick reports it.
        else -> Unit
      }
    }
    baselined = true
    posted?.let { summary ->
      lastNotifiedHost = summary.host
      // Remember where the work ran before the notification is built, so the
      // tap target is the machine this batch came from.
      runCatching { state.rememberHost(summary.host) }
      listener.onRunFinished(summary)
    }
  }

  /** `hosts` sorted, with `after` moved to the front when it is present. */
  private fun rotate(hosts: Set<String>, after: String?): List<String> {
    val sorted = hosts.sorted()
    if (after == null) return sorted
    val index = sorted.indexOf(after)
    if (index <= 0) return sorted
    return sorted.subList(index + 1, sorted.size) + sorted.subList(0, index + 1)
  }

  /**
   * The host set to poll, re-read from discovery at most once per
   * [HOSTS_REFRESH_SECONDS]. A failed discovery keeps the previous set, because
   * a transient control-plane hiccup must not stop the alerts.
   */
  private fun acceptedHosts(now: Long): Set<String> {
    if (hosts.isNotEmpty() && now - hostsDiscoveredAt < HOSTS_REFRESH_MILLIS) {
      return hosts
    }
    val discovered = runCatching { state.acceptedHosts() }.getOrNull()
    if (discovered != null) {
      hosts = discovered
      hostsDiscoveredAt = now
    }
    return hosts
  }

  /**
   * What one host's feed amounted to: the watermark it should be read from next,
   * whether there is anything the user should be interrupted for, and the
   * summary to show when there is.
   *
   * [`notifiable`] false means every notifiable turn in the feed has already
   * been reported or suppressed, so the watermark may move. [`notifiable`] true
   * with a null [`summary`] means work the user has not been told about is
   * waiting for a tick of its own.
   */
  private data class PollDecision(
    val watermark: Int,
    val notifiable: Boolean,
    val summary: RunNotificationSummary?,
  )

  /**
   * Reads one host's feed. Deciding only: nothing is persisted here, because
   * whether the watermark may move depends on whether this tick reports the
   * host, and that is the caller's decision.
   */
  private fun pollHost(host: String, baseline: Boolean): PollDecision {
    val previous = runCatching { state.watermark(host) }.getOrDefault(0)
    val body = runCatching { state.fetch(RunNotifications.feedUrl(host, previous)) }.getOrNull()
    // A 404 (machine not updated yet), an empty body and a malformed payload are
    // all "nothing to say": they must never affect reachability or the
    // watermark, and must never throw out of the service's scheduler.
    val feed = NotifyFeedJson.parseEnvelope(body)
      ?: return PollDecision(watermark = previous, notifiable = false, summary = null)
    val selection = WatermarkRule.select(
      notices = feed.notices,
      previous = previous,
      latest = feed.latest,
      baseline = baseline,
    )
    return PollDecision(
      watermark = selection.watermark,
      notifiable = selection.notices.isNotEmpty(),
      summary = RunNotificationSummaryFactory.of(host, selection.notices),
    )
  }

  companion object {
    private const val TAG = "RunNotify"

    /** Seconds before the first pass. Short: the baseline should exist early. */
    const val FIRST_TICK_DELAY_SECONDS = 10L

    /**
     * One poll per 45 seconds. Frequent enough that a phone left in a pocket
     * reports a finished turn within a minute, rare enough that a handful of
     * machines cost a handful of tiny GETs per minute and the radio is not held
     * awake for them.
     */
    const val POLL_INTERVAL_SECONDS = 45L

    /** Machines change rarely; re-reading discovery every 10 minutes is plenty. */
    const val HOSTS_REFRESH_SECONDS = 600L
    private const val HOSTS_REFRESH_MILLIS = HOSTS_REFRESH_SECONDS * 1000

    /** The production sources, all of them already used elsewhere in the app. */
    fun androidState(context: Context): RunNotificationState = object : RunNotificationState {
      override fun notificationsEnabled(): Boolean = RunNotificationStore.isEnabled(context)

      override fun connected(): Boolean =
        org.json.JSONObject(Portal.status()).optBoolean("managementConnected", false)

      /**
       * The accepted hosts, by the same rule the catalogue uses: the DSH records
       * the control plane declares, kept only when the entry lives in a fleet
       * zone and points at a peer of this network. Null when discovery itself
       * failed, so the caller can tell "no machines" from "could not ask".
       */
      override fun acceptedHosts(): Set<String>? {
        val records = runCatching { Portal.listServices() }.getOrNull() ?: return null
        val peers = runCatching { Portal.peerAddresses() }.getOrNull() ?: return null
        return runCatching {
          DshHostRegistry.selectAcceptedDsh(records, peers, DshHostRegistry.fleetZones(context)).second
        }.getOrNull()
      }

      override fun watermark(host: String): Int = RunNotificationStore.watermark(context, host)

      override fun saveWatermark(host: String, watermark: Int) {
        RunNotificationStore.setWatermark(context, host, watermark)
      }

      override fun rememberHost(host: String) {
        RunNotificationStore.setLastHost(context, host)
      }

      override fun fetch(url: String): String = Portal.fetch(url)

      override fun now(): Long = System.currentTimeMillis()
    }
  }
}

/**
 * Everything one poll needs from the outside world.
 *
 * It is an interface so the loop that decides whether a phone buzzes can be
 * driven by a unit test instead of only by a device: the production
 * implementation is [RunNotificationPoller.androidState], and the test one is a
 * few lines of map lookups.
 */
interface RunNotificationState {
  /** The user's switch; off means no polling and no notification. */
  fun notificationsEnabled(): Boolean

  /** Whether the management stream is connected, i.e. the overlay can be used. */
  fun connected(): Boolean

  /** The accepted hosts, or null when discovery could not run. */
  fun acceptedHosts(): Set<String>?

  fun watermark(host: String): Int

  fun saveWatermark(host: String, watermark: Int)

  /** Where the work that is about to be reported ran. */
  fun rememberHost(host: String)

  /** One HTTP GET through the embedded netstack, as `Portal.fetch` returns it. */
  fun fetch(url: String): String

  fun now(): Long
}