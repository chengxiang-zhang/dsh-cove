package com.netbirdportal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.netbird.portal.Portal
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

class NetBirdConnectionService : Service() {
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
  private val connecting = AtomicBoolean(false)
  private var retryAttempt = 0
  private var attemptsSinceReset = 0
  private var retryTask: ScheduledFuture<*>? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var currentStatus = STATUS_STARTING

  /**
   * Watches the accepted machines for turns that finished while the user was
   * away. It lives here, not in JavaScript, because this service is the only
   * part of the app that runs while the app is not open - which is exactly when
   * the alert is worth raising.
   */
  private var runNotifier: RunNotificationPoller? = null

  /**
   * Raised when the embedded engine itself is gone. Waiting out the status
   * window cannot help in that case: the engine has to be rebuilt.
   */
  private class EngineNotRunningException(message: String) : IllegalStateException(message)

  override fun onCreate() {
    super.onCreate()
    isRunning = true
    instance = this
    createNotificationChannel()
    createRunNotificationChannel()
    startForeground(NOTIFICATION_ID, notification(STATUS_STARTING))
    registerNetworkCallback()
    startRunNotifier()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val requestId = intent?.getStringExtra(EXTRA_REQUEST_ID)
    if (intent?.action == ACTION_STOP || !NetBirdConnectionPreferences.shouldKeepConnected(this)) {
      stopFromUserRequest(requestId)
      return START_NOT_STICKY
    }
    connectAsync(requestId)
    return START_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    if (instance === this) {
      instance = null
    }
    stopRunNotifier()
    networkCallback?.let {
      runCatching {
        getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
      }
    }
    retryTask?.cancel(false)
    networkCallback = null
    executor.shutdownNow()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun connectAsync(requestId: String? = null) {
    if (!NetBirdConnectionPreferences.shouldKeepConnected(this)) {
      failRequest(requestId, IllegalStateException("Connection stopped by user"))
      return
    }
    if (!connecting.compareAndSet(false, true)) {
      executor.schedule({ completeFromCurrentState(requestId) }, 250, TimeUnit.MILLISECONDS)
      return
    }
    updateNotification(STATUS_CONNECTING)
    executor.execute {
      try {
        if (!NetBirdRuntime.hasPersistedConfig(applicationContext)) {
          stopInvalidIdentity(requestId)
          return@execute
        }
        val proxyUrl = NetBirdRuntime.connect(applicationContext)
        if (!waitForManagementConnection()) {
          throw IllegalStateException("NetBird management connection timed out")
        }
        attemptsSinceReset = 0
        NetBirdRuntime.recordConnected()
        retryAttempt = 0
        retryTask?.cancel(false)
        retryTask = null
        completeRequest(requestId, proxyUrl)
      } catch (error: Exception) {
        if (NetBirdRuntime.isAuthenticationRequired(error)) {
          Log.w(TAG, "NetBird identity was rejected; login is required", error)
          stopInvalidIdentity(requestId)
        } else {
          Log.w(TAG, "NetBird connection attempt failed; waiting to recover", error)
          // Keep the process-local engine and loopback proxy alive. NetBird owns
          // transient transport recovery; replacing the proxy would invalidate
          // active browser sessions that still use its stable endpoint.
          val engineNotRunning = error is EngineNotRunningException
          attemptsSinceReset += 1
          NetBirdRuntime.recordFailure(
            if (engineNotRunning) {
              NetBirdRuntime.STAGE_ENGINE_NOT_RUNNING
            } else {
              NetBirdRuntime.STAGE_MANAGEMENT_DISCONNECTED
            },
            error.message ?: error.toString(),
            attemptsSinceReset,
          )
          // Positive identity read: an expired login must not look like a
          // transient outage forever. The verdict only changes what the UI
          // says and offers; the user still decides when to log in again.
          val verdict = runCatching { NetBirdRuntime.resolveAuthVerdict(applicationContext) }
            .getOrDefault(NetBirdRuntime.AUTH_VERDICT_UNKNOWN)
          if (verdict == NetBirdRuntime.AUTH_VERDICT_LOGIN_REQUIRED) {
            Log.w(TAG, "Persisted NetBird identity no longer authenticates; offering re-login")
          }
          val action = NetBirdRetryPolicy.nextAction(attemptsSinceReset, engineNotRunning)
          if (action == NetBirdRetryPolicy.Action.HARD_RESET) {
            Log.w(TAG, "NETBIRD_ENGINE_HARD_RESET after $attemptsSinceReset failed attempts")
            attemptsSinceReset = 0
            runCatching { NetBirdRuntime.resetEngine(applicationContext) }
              .onFailure { Log.w(TAG, "engine reset failed", it) }
          }
          failRequest(requestId, error)
          scheduleRetry()
        }
      } finally {
        connecting.set(false)
      }
    }
  }

  private fun stopInvalidIdentity(requestId: String?) {
    val error = IllegalStateException("NetBird login is no longer valid")
    NetBirdConnectionPreferences.markAuthenticationRequired(this)
    runCatching { NetBirdRuntime.stop() }
      .onFailure { Log.w(TAG, "NetBird invalid-identity cleanup failed", it) }
    failRequest(requestId, error)
    updateNotification(STATUS_LOGIN_REQUIRED)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun completeFromCurrentState(requestId: String?) {
    if (requestId == null) {
      return
    }
    val proxyUrl = NetBirdRuntime.currentProxyUrl()
    if (proxyUrl != null) {
      completeRequest(requestId, proxyUrl)
    } else if (connecting.get()) {
      executor.schedule({ completeFromCurrentState(requestId) }, 250, TimeUnit.MILLISECONDS)
    } else {
      failRequest(requestId, IllegalStateException("NetBird connection failed"))
    }
  }

  private fun waitForManagementConnection(): Boolean {
    repeat(STATUS_CHECK_ATTEMPTS) {
      if (!NetBirdConnectionPreferences.shouldKeepConnected(this)) {
        return false
      }
      val probe = runCatching {
        JSONObject(Portal.status()).optBoolean("managementConnected", false)
      }
      if (probe.getOrDefault(false)) {
        updateNotification(STATUS_CONNECTED)
        return true
      }
      probe.exceptionOrNull()?.let { failure ->
        // The embedded engine is gone (Portal.status() reports "client not
        // started"). Sleeping through the remaining status window would only
        // delay the rebuild that is the only way back.
        throw EngineNotRunningException(failure.message ?: "NetBird engine is not running")
      }
      TimeUnit.SECONDS.sleep(STATUS_CHECK_INTERVAL_SECONDS)
    }
    updateNotification(STATUS_RECOVERING)
    return false
  }

  private fun scheduleRetry() {
    if (!NetBirdConnectionPreferences.shouldKeepConnected(this) || executor.isShutdown) {
      return
    }
    updateNotification(STATUS_WAITING)
    if (retryTask?.isDone == false) {
      return
    }
    val delaySeconds = min(MAX_RETRY_SECONDS, INITIAL_RETRY_SECONDS shl retryAttempt.coerceAtMost(5))
    retryAttempt += 1
    retryTask = executor.schedule({
      retryTask = null
      connectAsync()
    }, delaySeconds.toLong(), TimeUnit.SECONDS)
  }

  private fun registerNetworkCallback() {
    val connectivity = getSystemService(ConnectivityManager::class.java)
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        executor.execute {
          retryAttempt = 0
          retryTask?.cancel(false)
          retryTask = null
          connectAsync()
        }
      }

      override fun onLost(network: Network) {
        executor.execute { updateNotification(STATUS_WAITING) }
      }
    }
    networkCallback = callback
    connectivity.registerDefaultNetworkCallback(callback)
  }

  private fun stopFromUserRequest(requestId: String?) {
    NetBirdConnectionPreferences.markStoppedByUser(this)
    executor.execute {
      val error = runCatching { NetBirdRuntime.stop() }.exceptionOrNull()
      if (error == null) {
        completeRequest(requestId, "")
      } else {
        Log.w(TAG, "NetBird stop failed", error)
        failRequest(requestId, error)
      }
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun createNotificationChannel() {
    val channel = NotificationChannel(
      NOTIFICATION_CHANNEL_ID,
      getString(R.string.netbird_connection_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.netbird_connection_channel_description)
      setShowBadge(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun updateNotification(status: String) {
    currentStatus = status
    getSystemService(NotificationManager::class.java)
      .notify(NOTIFICATION_ID, notification(status))
  }

  /**
   * The finished-run channel, deliberately separate from the connection one.
   *
   * It is IMPORTANCE_DEFAULT, not LOW, and its notification is neither ongoing
   * nor silent: this is the one notice the app raises that a person is meant to
   * notice later. Changing the connection channel instead would either mute
   * these alerts or make the always-present connection notice noisy, and a
   * channel's importance cannot be raised after users have seen it.
   */
  private fun createRunNotificationChannel() {
    val channel = NotificationChannel(
      RUN_NOTIFICATION_CHANNEL_ID,
      getString(R.string.run_notifications_channel_name),
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = getString(R.string.run_notifications_channel_description)
      setShowBadge(true)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun startRunNotifier() {
    if (runNotifier != null) return
    val poller = RunNotificationPoller(
      RunNotificationPoller.androidState(applicationContext),
      runNotificationListener,
    )
    runNotifier = poller
    poller.start()
  }

  private fun stopRunNotifier() {
    runNotifier?.stop()
    runNotifier = null
  }

  /**
   * What the poller asked for. One notification per finished batch: several
   * runs that ended together are collapsed into a single line that says how
   * many there were, so a poll can never produce a burst.
   */
  private val runNotificationListener = object : RunNotificationPoller.Listener {
    override fun onRunFinished(summary: RunNotificationSummary) {
      if (!runCatching { RunNotificationStore.isEnabled(this@NetBirdConnectionService) }
          .getOrDefault(true)) {
        return
      }
      getSystemService(NotificationManager::class.java)
        .notify(RUN_NOTIFICATION_ID, runNotification(summary))
    }

    override fun onRunNotificationsCleared() {
      getSystemService(NotificationManager::class.java).cancel(RUN_NOTIFICATION_ID)
    }
  }

  private fun runNotification(summary: RunNotificationSummary): Notification {
    return NotificationCompat.Builder(this, RUN_NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_anywhere)
      .setContentTitle(getString(R.string.app_name_full))
      .setContentText(runNotificationBody(summary))
      .setContentIntent(runNotificationIntent())
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setAutoCancel(true)
      .setOnlyAlertOnce(false)
      .build()
  }

  /**
   * One sentence for the whole batch: the machine, then how many finished, and
   * the failures called out separately because they are the reason to look now.
   */
  private fun runNotificationBody(summary: RunNotificationSummary): String =
    if (summary.failed > 0) {
      getString(
        R.string.run_notifications_summary_errors,
        summary.host,
        summary.completed,
        summary.failed,
      )
    } else {
      getString(R.string.run_notifications_summary, summary.host, summary.total)
    }

  /**
   * Opens the app on the machine the work ran on. This reuses the ongoing
   * notification's route rather than inventing one: `GeckoServiceActivity` with
   * a registered URL, else `MainActivity`. The URL comes from the store, never
   * from the feed body, and `GeckoServiceActivity` re-validates it against the
   * discovered hosts before loading it, so a notice cannot point the app
   * anywhere discovery has not accepted.
   */
  private fun runNotificationIntent(): PendingIntent {
    val host = RunNotificationStore.lastHost(this)
    val target = if (host != null) {
      DshHostRegistry.registeredServiceUrl("http://$host/")
    } else {
      null
    }
    val openApp = if (target != null) {
      Intent(this, GeckoServiceActivity::class.java)
        .putExtra("url", target)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    } else {
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(
      this,
      RUN_NOTIFICATION_REQUEST_CODE,
      openApp,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /**
   * Repaint the ongoing notification without touching the connection state.
   * Called from the companion when the app reports a new machine count.
   */
  private fun refreshNotification() {
    updateNotification(currentStatus)
  }

  /**
   * What the notification says under the title. Once the app has reported how
   * many machines are reachable, the connected state shows that instead of the
   * bare status, so the ongoing notification doubles as a status panel.
   */
  private fun contentText(status: String): String {
    val machines = reportedMachines
    return if (status == STATUS_CONNECTED && machines >= 0) {
      getString(R.string.netbird_connection_summary, machines)
    } else {
      status
    }
  }

  private fun notification(status: String): Notification {
    val lastUrl = BrowserSessionStore.lastUrl(this)
    val openApp = if (lastUrl != null) {
      Intent(this, GeckoServiceActivity::class.java)
        .putExtra("url", lastUrl)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    } else {
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      openApp,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_anywhere)
      .setContentTitle(getString(R.string.app_name_full))
      .setContentText(contentText(status))
      .setContentIntent(pendingIntent)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .build()
  }

  companion object {
    private const val TAG = "NetBirdConnection"
    private const val NOTIFICATION_CHANNEL_ID = "netbird_connection"
    private const val NOTIFICATION_ID = 21001

    /**
     * Finished-run notifications get their own channel and their own ids.
     *
     * Neither may collide with the connection notification (id 21001), the
     * permission request code (21001, MainActivity) or the connection's
     * PendingIntent request code (0): Android keys both notification updates and
     * PendingIntents by those numbers, and a collision silently replaces the
     * other notice.
     */
    private const val RUN_NOTIFICATION_CHANNEL_ID = "run_finished"
    private const val RUN_NOTIFICATION_ID = 21002
    private const val RUN_NOTIFICATION_REQUEST_CODE = 21002
    private const val ACTION_START = "com.netbirdportal.action.START_CONNECTION"
    private const val ACTION_STOP = "com.netbirdportal.action.STOP_CONNECTION"
    private const val EXTRA_REQUEST_ID = "request-id"
    private const val STATUS_CHECK_ATTEMPTS = 6
    private const val STATUS_CHECK_INTERVAL_SECONDS = 5L
    private const val INITIAL_RETRY_SECONDS = 2
    private const val MAX_RETRY_SECONDS = 60
    private const val REQUEST_TIMEOUT_SECONDS = 45L

    private const val STATUS_STARTING = "正在启动…"
    private const val STATUS_CONNECTING = "正在连接内网…"
    private const val STATUS_CONNECTED = "内网连接运行中"
    private const val STATUS_WAITING = "等待网络恢复"
    private const val STATUS_RECOVERING = "连接恢复中…"
    private const val STATUS_LOGIN_REQUIRED = "登录已失效，请打开 App 重新登录"

    private val requests = ConcurrentHashMap<String, CompletableFuture<String>>()

    /**
     * Whether the foreground connection service is alive right now. Exposed to
     * the bridge so the service list can explain a stall instead of only
     * saying that the intranet is not connected.
     */
    @Volatile
    var isRunning = false
      private set

    /**
     * The live service instance, so the app can repaint the ongoing
     * notification without restarting the connection. A foreground service is
     * a process singleton; the reference is cleared in onDestroy.
     */
    @Volatile
    private var instance: NetBirdConnectionService? = null

    /**
     * How many machines the app last saw, or -1 when it has not reported yet.
     * Reported from JavaScript on every catalogue load.
     */
    @Volatile
    private var reportedMachines = -1

    fun reportServiceCount(count: Int) {
      reportedMachines = count
      instance?.refreshNotification()
    }

    fun clearServiceCount() {
      reportedMachines = -1
    }

    /**
     * Applies the finished-run switch from the app.
     *
     * Writing the preference is not enough on its own: turning the switch off
     * must also take back the notification that is already in the shade and
     * forget where the next poll stood, so that turning it back on starts from a
     * fresh baseline instead of replaying the history of a host that restarted
     * in between. Both are no-ops when the service is not running - the
     * preference is what the next start reads.
     */
    fun applyRunNotificationsEnabled(context: Context, enabled: Boolean) {
      RunNotificationStore.setEnabled(context, enabled)
      if (enabled) {
        return
      }
      runCatching {
        context.getSystemService(NotificationManager::class.java).cancel(RUN_NOTIFICATION_ID)
      }
      RunNotificationStore.clearWatermarks(context)
      instance?.runNotifier?.resetBaseline()
    }

    fun start(context: Context) {
      if (!NetBirdConnectionPreferences.shouldKeepConnected(context)) {
        return
      }
      val intent = Intent(context, NetBirdConnectionService::class.java).setAction(ACTION_START)
      ContextCompat.startForegroundService(context, intent)
    }

    fun startAndAwait(context: Context): String {
      NetBirdConnectionPreferences.markConnectedByUser(context)
      val requestId = java.util.UUID.randomUUID().toString()
      val future = CompletableFuture<String>()
      requests[requestId] = future
      val intent = Intent(context, NetBirdConnectionService::class.java)
        .setAction(ACTION_START)
        .putExtra(EXTRA_REQUEST_ID, requestId)
      return try {
        // Inside the try: a refused foreground-service start must not leave the
        // request entry behind in this process-lifetime map.
        ContextCompat.startForegroundService(context, intent)
        future.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      } finally {
        requests.remove(requestId)
      }
    }

    fun stopAndAwait(context: Context) {
      NetBirdConnectionPreferences.markStoppedByUser(context)
      val requestId = java.util.UUID.randomUUID().toString()
      val future = CompletableFuture<String>()
      requests[requestId] = future
      val intent = Intent(context, NetBirdConnectionService::class.java)
        .setAction(ACTION_STOP)
        .putExtra(EXTRA_REQUEST_ID, requestId)
      try {
        context.startService(intent)
        future.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      } finally {
        requests.remove(requestId)
      }
    }

    private fun completeRequest(requestId: String?, value: String) {
      requestId?.let { requests.remove(it)?.complete(value) }
    }

    private fun failRequest(requestId: String?, error: Throwable) {
      requestId?.let { requests.remove(it)?.completeExceptionally(error) }
    }
  }
}
