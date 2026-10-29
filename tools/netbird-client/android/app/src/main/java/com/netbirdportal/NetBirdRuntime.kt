package com.netbirdportal

import android.content.Context
import io.netbird.portal.Portal
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

object NetBirdRuntime {
  private const val DEVICE_NAME = "netbird-portal-android"

  /**
   * The address this app ships with, and what a fresh install enrolls against.
   *
   * It is no longer the enrollment identity of every install: a fleet whose
   * control plane is not this one sets its own address in the app, and
   * [NetBirdServerPreferences] holds that choice. Pointing an already-enrolled
   * install at another server is a re-login rather than a config reload, so
   * choosing an address drops the local enrollment (see [switchManagementUrl]).
   * src/fleetConfig.ts mirrors the committed fallback as the fleet document's own
   * record; the native side is the authority.
   *
   * The value is a build input, not a source literal: the committed fallback is
   * NetBird Cloud (https://api.netbird.io:443), so an APK nobody configured is
   * still usable, and a self-hosted deployment passes
   * -PawManagementUrl=https://netbird.<its-domain>:443 (see
   * android/app/build.gradle) to compile its own address in. scripts/publish.sh
   * refuses to publish an APK that does not carry the address its channel
   * advertises.
   */
  internal val DEFAULT_MANAGEMENT_URL: String = BuildConfig.AW_MANAGEMENT_URL

  /**
   * Whether the address in force is NetBird Cloud.
   *
   * Cloud accounts name their peers under `netbird.cloud`, self-hosted ones
   * under their own DNS domain, so callers that resolve machine names need the
   * distinction rather than only the URL.
   */
  internal fun isCloudManagement(url: String, hostSuffixes: List<String>): Boolean {
    val host = runCatching { java.net.URI(url).host?.lowercase() }.getOrNull() ?: return false
    return hostSuffixes.any { suffix -> host == suffix || host.endsWith(".$suffix") }
  }

  fun isCloudManagement(context: Context): Boolean =
    isCloudManagement(
      managementUrl(context),
      context.resources.getStringArray(R.array.fleet_cloud_host_suffixes).map { it.lowercase() },
    )

  /**
   * The compiled default in canonical form, so a user who types the default
   * without its port (or with a trailing slash) is recognized as choosing the
   * default rather than as a second identity.
   */
  internal val normalizedDefaultManagementUrl: String =
    NetBirdServerAddress.normalize(DEFAULT_MANAGEMENT_URL) ?: DEFAULT_MANAGEMENT_URL

  /** Enrollment state written by the embedded client, purged when it changes. */
  internal const val CONFIG_FILE_NAME = "netbird-portal-config.json"
  internal const val STATE_FILE_NAME = "netbird-portal-state.json"

  /**
   * Where the last connection attempt stopped. The service list screen shows
   * this as a one-line reason, so a stuck install can be diagnosed from a
   * screenshot instead of a logcat capture.
   */
  const val STAGE_IDLE = "idle"
  const val STAGE_ENGINE_NOT_RUNNING = "engine_not_running"
  const val STAGE_MANAGEMENT_DISCONNECTED = "management_disconnected"
  const val STAGE_PROXY_UNAVAILABLE = "proxy_unavailable"
  const val STAGE_AUTH_REQUIRED = "auth_required"

  /**
   * Positive identity verdict, computed from the persisted profile.
   *
   * `Portal.isSSOConfigured` answers "does the saved identity still
   * authenticate?"; it returns false both for "token expired" and for "could
   * not ask". Probing management reachability separately is what tells the two
   * apart, and it is the only honest way to stop treating an expired login as
   * a transient outage forever.
   */
  const val AUTH_VERDICT_UNKNOWN = "unknown"
  const val AUTH_VERDICT_VALID = "valid"
  const val AUTH_VERDICT_LOGIN_REQUIRED = "login_required"
  const val AUTH_VERDICT_MANAGEMENT_UNREACHABLE = "management_unreachable"

  private const val MANAGEMENT_PROBE_TIMEOUT_MS = 4000

  /**
   * The identity verdict costs a management round trip, so it is throttled:
   * a fast retry loop must not queue up one RPC per attempt.
   */
  private const val AUTH_VERDICT_MIN_INTERVAL_MS = 30_000

  private val lock = Any()
  private val diagnosticsLock = Any()

  @Volatile
  private var stage = STAGE_IDLE

  @Volatile
  private var lastError = ""

  @Volatile
  private var failures = 0

  @Volatile
  private var hardResets = 0

  @Volatile
  private var authVerdict = AUTH_VERDICT_UNKNOWN

  @Volatile
  private var authVerdictResolvedAt = 0L

  private val AUTH_REJECTION_MARKERS = listOf(
    "permissiondenied",
    "no peer auth method",
    "interactive sso login",
    "authentication rejected",
    "unauthenticated",
    "login is no longer valid",
  )

  @Volatile
  private var proxyUrl: String? = null

  @Volatile
  private var systemWebViewProxyUpdater: ((String) -> Unit)? = null

  fun connect(context: Context, setupKey: String = ""): String = synchronized(lock) {
    val files = context.applicationContext.filesDir
    Portal.start(
      setupKey,
      DEVICE_NAME,
      managementUrl(context),
      File(files, CONFIG_FILE_NAME).absolutePath,
      File(files, STATE_FILE_NAME).absolutePath,
    )
    val activeProxy = Portal.startProxy()
    proxyUrl = activeProxy
    GeckoViewHelper.updateProxyPort(
      context.applicationContext,
      activeProxy.substringAfterLast(':').toIntOrNull() ?: 19001,
    )
    systemWebViewProxyUpdater?.invoke(activeProxy)
    activeProxy
  }

  fun currentProxyUrl(): String? = proxyUrl

  fun setSystemWebViewProxyUpdater(updater: (String) -> Unit) {
    systemWebViewProxyUpdater = updater
    proxyUrl?.let(updater)
  }

  fun clearSystemWebViewProxyUpdater() {
    systemWebViewProxyUpdater = null
  }

  /**
   * Local-only startup gate.
   *
   * A management RPC is not an identity check: during cold start it can fail
   * simply because Android has not restored the network yet. Treating that as
   * "logged out" caused the app to demand SSO on every transient outage.
   * The connection service validates the identity by making the real
   * connection and only logs out on an explicit authentication rejection.
   */
  fun hasPersistedConfig(context: Context): Boolean =
    File(context.applicationContext.filesDir, CONFIG_FILE_NAME).exists() &&
      NetBirdConnectionPreferences.shouldKeepConnected(context) &&
      !NetBirdConnectionPreferences.wasStoppedByUser(context) &&
      !NetBirdConnectionPreferences.isAuthenticationRequired(context)

  /**
   * The management server in force. Every management caller reads it here, so a
   * switched address cannot be honoured on one path and ignored on another.
   */
  fun managementUrl(context: Context): String {
    val configured = NetBirdServerPreferences.configured(context)
    return configured?.let { NetBirdServerAddress.normalize(it) } ?: normalizedDefaultManagementUrl
  }

  /**
   * Snapshot for the settings row: the address in force, the compiled default a
   * "restore default" action would return to, and whether the current one is the
   * user's choice.
   *
   * Both URLs went through [NetBirdServerAddress], so they contain only scheme,
   * host and port: no quoting or escaping is needed to place them in JSON.
   */
  fun serverConfigJson(context: Context): String {
    val url = managementUrl(context)
    val custom = url != normalizedDefaultManagementUrl
    return "{\"url\":\"$url\",\"defaultUrl\":\"$normalizedDefaultManagementUrl\"," +
      "\"isCustom\":$custom}"
  }

  /**
   * Chooses the management server, and reports back whether that ended the
   * session.
   *
   * An address that canonicalizes to the default clears the stored choice
   * instead of storing an equal value, so "is this install on its own server"
   * stays answerable. A different address is a different account: the local
   * enrollment is dropped, and `changed = true` means the caller has to send the
   * user back through sign-in.
   */
  fun switchManagementUrl(context: Context, raw: String): String {
    val normalized = NetBirdServerAddress.normalize(raw)
      ?: throw IllegalArgumentException(NetBirdServerAddress.INVALID_INPUT_MESSAGE)
    val previous = managementUrl(context)
    if (normalized == normalizedDefaultManagementUrl) {
      NetBirdServerPreferences.clear(context)
    } else {
      NetBirdServerPreferences.set(context, normalized)
    }
    val changed = normalized != previous
    if (changed) {
      clearEnrollment(context)
    }
    return "{\"url\":\"$normalized\",\"changed\":$changed}"
  }

  /**
   * Drops the user's choice and goes back to the compiled default, with the same
   * re-enrollment consequence when the two differ.
   */
  fun resetManagementUrl(context: Context): String {
    val previous = managementUrl(context)
    NetBirdServerPreferences.clear(context)
    val changed = previous != normalizedDefaultManagementUrl
    if (changed) {
      clearEnrollment(context)
    }
    return "{\"url\":\"$normalizedDefaultManagementUrl\",\"changed\":$changed}"
  }

  /**
   * Forgets the enrolled device identity, because it belongs to a control plane
   * this install no longer talks to.
   *
   * Order matters. "Stopped by user" is written first, so the foreground service
   * cannot restart the connection it is about to lose (`start()` refuses while
   * that flag is set) and only then is the service stopped. The profile files are
   * deleted after the engine is down: deleting them under a running client would
   * let it write them back. The client state left behind is the same as an
   * explicit sign-out, which is the path the app already handles.
   */
  fun clearEnrollment(context: Context) {
    val application = context.applicationContext
    NetBirdConnectionPreferences.markStoppedByUser(application)
    if (NetBirdConnectionService.isRunning) {
      runCatching { NetBirdConnectionService.stopAndAwait(application) }
        .onFailure {
          android.util.Log.w("NetBirdRuntime", "service stop during re-enrollment failed", it)
        }
    }
    stop()
    for (name in listOf(CONFIG_FILE_NAME, STATE_FILE_NAME)) {
      runCatching {
        val file = File(application.filesDir, name)
        if (file.exists() && !file.delete()) {
          android.util.Log.w("NetBirdRuntime", "could not delete enrollment file $name")
        }
      }
    }
  }

  /**
   * Asks whether the persisted identity still authenticates, and separates
   * "the token is gone" from "management could not be reached at all".
   *
   * This runs on the connection service's worker thread: it performs one
   * management round trip and one plain reachability probe, so it must never be
   * called from the React Native thread.
   */
  fun resolveAuthVerdict(context: Context): String {
    val now = System.currentTimeMillis()
    synchronized(diagnosticsLock) {
      if (now - authVerdictResolvedAt < AUTH_VERDICT_MIN_INTERVAL_MS) {
        return authVerdict
      }
    }
    val configPath = File(context.applicationContext.filesDir, CONFIG_FILE_NAME)
      .absolutePath
    val management = managementUrl(context)
    val configured = runCatching { Portal.isSSOConfigured(management, configPath) }
      .getOrNull()
    val verdict = when {
      configured == null -> AUTH_VERDICT_UNKNOWN
      configured -> AUTH_VERDICT_VALID
      !managementReachable(management) -> AUTH_VERDICT_MANAGEMENT_UNREACHABLE
      else -> AUTH_VERDICT_LOGIN_REQUIRED
    }
    recordAuthVerdict(verdict)
    return verdict
  }

  private fun managementReachable(management: String): Boolean = runCatching {
    val connection = URL("$management/").openConnection() as HttpURLConnection
    connection.requestMethod = "HEAD"
    connection.connectTimeout = MANAGEMENT_PROBE_TIMEOUT_MS
    connection.readTimeout = MANAGEMENT_PROBE_TIMEOUT_MS
    try {
      connection.responseCode in 200..499
    } finally {
      connection.disconnect()
    }
  }.getOrDefault(false)

  fun isAuthenticationRequired(error: Throwable): Boolean {
    var current: Throwable? = error
    repeat(8) {
      val text = listOfNotNull(current?.message, current?.toString())
        .joinToString(" ")
        .lowercase()
      if (AUTH_REJECTION_MARKERS.any(text::contains)) {
        return true
      }
      current = current?.cause ?: return false
    }
    return false
  }

  /**
   * Records the stage of a failed attempt. Callers never pass credentials or
   * page content here: only a stage label and the engine's own error text.
   */
  fun recordFailure(stageValue: String, error: String, consecutiveFailures: Int) {
    synchronized(diagnosticsLock) {
      stage = stageValue
      lastError = error.take(200)
      failures = consecutiveFailures
    }
  }

  fun recordConnected() {
    synchronized(diagnosticsLock) {
      stage = STAGE_IDLE
      lastError = ""
      failures = 0
      // A successful connection is newer evidence than the last verdict: a
      // cached "login_required" would otherwise make the list screen claim a
      // login that just worked is no longer accepted.
      authVerdict = AUTH_VERDICT_UNKNOWN
      authVerdictResolvedAt = 0L
    }
  }

  internal fun recordAuthVerdict(verdict: String) {
    synchronized(diagnosticsLock) {
      authVerdict = verdict
      authVerdictResolvedAt = System.currentTimeMillis()
    }
  }

  fun recordHardReset() {
    synchronized(diagnosticsLock) {
      hardResets += 1
    }
  }

  /**
   * Snapshot for the bridge. `serviceRunning` is filled in by the connection
   * service, which owns that fact.
   */
  fun diagnosticsJson(serviceRunning: Boolean): String {
    val snapshot = synchronized(diagnosticsLock) {
      listOf(stage, jsonEscape(lastError), failures.toString(), hardResets.toString(), authVerdict)
    }
    return "{" +
      "\"serviceRunning\":$serviceRunning," +
      "\"stage\":\"${snapshot[0]}\"," +
      "\"lastError\":\"${snapshot[1]}\"," +
      "\"failures\":${snapshot[2]}," +
      "\"hardResets\":${snapshot[3]}," +
      "\"authVerdict\":\"${snapshot[4]}\"" +
      "}"
  }

  /**
   * Engine error text reaches the UI inside JSON, so it has to survive
   * newlines and control characters: a malformed payload would silently turn
   * the reason line into "no reason at all".
   */
  private fun jsonEscape(value: String): String = buildString {
    for (character in value) {
      when (character) {
        '\\' -> append("\\\\")
        '"' -> append("\\\"")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> if (character < ' ') {
          append("\\u%04x".format(character.code))
        } else {
          append(character)
        }
      }
    }
  }

  /**
   * Full engine reset.
   *
   * Repeated `Portal.start()` calls are no-ops while an instance exists
   * (`native/portal.go:51-56`), and `StartProxy()` returns the cached listener
   * (`native/portal.go:196-198`). A wedged instance therefore cannot recover by
   * "retrying": the only way back is to stop it and build a fresh one.
   */
  fun resetEngine(context: Context): String = synchronized(lock) {
    runCatching { Portal.stop() }
      .onFailure { android.util.Log.w("NetBirdRuntime", "engine stop before reset failed", it) }
    proxyUrl = null
    recordHardReset()
    connect(context)
  }

  fun stop() = synchronized(lock) {
    try {
      Portal.stop()
    } finally {
      proxyUrl = null
      // The identity is gone with the connection; keep no verdict about it.
      recordAuthVerdict(AUTH_VERDICT_UNKNOWN)
    }
  }

  /**
   * True when `candidate` is a file inside this app's own downloads directory.
   *
   * The bridge only exposes deletion for paths passing this check: the JS side
   * needs to drop a poisoned partial download, and nothing else.
   */
  fun isManagedPath(downloadsRoot: File, candidate: File): Boolean = runCatching {
    val root = downloadsRoot.canonicalPath
    val target = candidate.canonicalPath
    target != root && target.startsWith(root + File.separator)
  }.getOrDefault(false)
}
