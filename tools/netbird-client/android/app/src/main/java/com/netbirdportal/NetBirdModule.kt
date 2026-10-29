package com.netbirdportal

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent
import android.util.Log
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import io.netbird.portal.Portal
import java.io.File

class NetBirdModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  init {
    NetBirdRuntime.setSystemWebViewProxyUpdater { url -> applySystemWebViewProxy(url) }
  }

  override fun getName() = "NetBirdPortal"

  override fun invalidate() {
    NetBirdRuntime.clearSystemWebViewProxyUpdater()
    super.invalidate()
  }

  @ReactMethod
  fun verify(setupKey: String, url: String, promise: Promise) {
    Thread {
      try {
        NetBirdConnectionPreferences.markConnectedByUser(context)
        val proxyUrl = NetBirdConnectionService.startAndAwait(context)
        Log.i("NetBirdBridge", "NetBird service connected through $proxyUrl; fetching $url")
        val result = Portal.fetch(url)
        Log.i("NetBirdBridge", "Portal.fetch returned ${result.length} characters")
        context.runOnUiQueueThread {
          Log.i("NetBirdBridge", "resolving Promise on UI queue")
          promise.resolve(result)
        }
      } catch (error: Exception) {
        Log.e("NetBirdBridge", "verify failed", error)
        val code = if (NetBirdRuntime.isAuthenticationRequired(error)) {
          "NETBIRD_AUTH_REQUIRED"
        } else {
          "NETBIRD_VERIFY"
        }
        promise.reject(code, error)
      }
    }.start()
  }

  /**
   * Brings the engine up and resolves the loopback proxy URL, with NO HTTP
   * probe.
   *
   * `verify` used to be the connect entry point, but it always finished with
   * `Portal.fetch(url)` and the app treated that answer as "the network is
   * usable". That gate broke login twice for one reason: the fetch runs through
   * the embedded netstack, whose resolver does not answer the names it was
   * pointed at (first a retired `dl-dev` name, then a peer name reported as
   * `no such host` on a phone while a desktop client resolved it). Reachability
   * is the service list's job - it probes every discovered service, retries,
   * names the failing stage and offers retry/re-login - so the connect path
   * needs exactly this much and nothing more.
   */
  @ReactMethod
  fun ensureServiceReady(promise: Promise) {
    Thread {
      try {
        NetBirdConnectionPreferences.markConnectedByUser(context)
        val proxyUrl = NetBirdConnectionService.startAndAwait(context)
        context.runOnUiQueueThread { promise.resolve(proxyUrl) }
      } catch (error: Exception) {
        Log.e("NetBirdBridge", "ensureServiceReady failed", error)
        val code = if (NetBirdRuntime.isAuthenticationRequired(error)) {
          "NETBIRD_AUTH_REQUIRED"
        } else {
          "NETBIRD_VERIFY"
        }
        context.runOnUiQueueThread { promise.reject(code, error) }
      }
    }.start()
  }

  @ReactMethod
  fun startProxy(promise: Promise) {
    try {
      val proxyUrl = NetBirdRuntime.currentProxyUrl()
        ?: throw IllegalStateException("NetBird connection service is not ready")
      promise.resolve(proxyUrl)
    } catch (error: Exception) {
      promise.reject("NETBIRD_PROXY", error)
    }
  }

  @ReactMethod
  fun openGeckoService(url: String, authorizedDshHost: String, promise: Promise) {
    val normalized = DshHostRegistry.registeredServiceUrl(url)
    if (normalized == null) {
      promise.reject("GECKO_OPEN", "Only discovered DSH services can be opened")
      return
    }
    try {
      val intent = Intent(context, GeckoServiceActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        .putExtra("url", normalized)
        .putExtra("authorizedDshHost", authorizedDshHost)
      context.startActivity(intent)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("GECKO_OPEN", error)
    }
  }

  @ReactMethod
  fun applyWebViewProxy(proxyUrl: String, promise: Promise) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      promise.reject("WEBVIEW_PROXY_UNSUPPORTED", "WebView proxy override is unavailable")
      return
    }
    applySystemWebViewProxy(
      proxyUrl,
      completion = { promise.resolve(null) },
      onFailure = { promise.reject("WEBVIEW_PROXY", it) },
    )
  }

  private fun applySystemWebViewProxy(
    proxyUrl: String,
    completion: () -> Unit = {},
    onFailure: (Exception) -> Unit = {},
  ) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      return
    }
    val config = ProxyConfig.Builder().addProxyRule(proxyUrl).build()
    context.runOnUiQueueThread {
      // An escaping exception here would reach the main looper (process death)
      // and leave the awaited promise unsettled forever.
      try {
        ProxyController.getInstance().setProxyOverride(
          config,
          context.mainExecutor,
          completion,
        )
      } catch (error: Exception) {
        Log.w("NetBirdBridge", "system WebView proxy override failed", error)
        runCatching { onFailure(error) }
      }
    }
  }

  @ReactMethod
  fun clearWebViewProxy(promise: Promise) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      promise.resolve(null)
      return
    }
    context.runOnUiQueueThread {
      try {
        ProxyController.getInstance().clearProxyOverride(
          context.mainExecutor,
        ) { promise.resolve(null) }
      } catch (error: Exception) {
        promise.reject("WEBVIEW_PROXY_CLEAR", error)
      }
    }
  }

  @ReactMethod
  fun status(promise: Promise) {
    // Portal.status() takes the same engine lock that Portal.start() holds
    // while building the client. Run inline it blocks the single native-module
    // queue, so the service list's first load (and every other bridge call)
    // waits behind it.
    Thread {
      try {
        promise.resolve(Portal.status())
      } catch (error: Exception) {
        promise.reject("NETBIRD_STATUS", error)
      }
    }.start()
  }

  @ReactMethod
  fun fetch(url: String, promise: Promise) {
    Thread {
      try {
        promise.resolve(Portal.fetch(url))
      } catch (error: Exception) {
        promise.reject("NETBIRD_FETCH", error)
      }
    }.start()
  }

  @ReactMethod
  fun stop(promise: Promise) {
    Thread {
      try {
        NetBirdConnectionPreferences.markStoppedByUser(context)
        NetBirdConnectionService.stopAndAwait(context)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("NETBIRD_STOP", error)
      }
    }.start()
  }

  @ReactMethod
  fun listServices(promise: Promise) {
    Thread {
      try {
        // Strict scope, derived from the control plane instead of a compiled
        // inventory: keep the DSH entries declared in the fleet's zones whose
        // target is a peer of this network. Every other intranet DNS record is
        // discarded here, and the accepted hosts become the runtime trust set
        // for opening a page and for microphone access.
        val records = Portal.listServices()
        val peerAddresses = Portal.peerAddresses()
        promise.resolve(DshHostRegistry.acceptRecords(context, records, peerAddresses))
      } catch (error: Exception) {
        promise.reject("NETBIRD_LIST_SERVICES", error)
      }
    }.start()
  }

  @ReactMethod
  fun probe(url: String, promise: Promise) {
    Thread {
      try {
        promise.resolve(Portal.probe(url))
      } catch (error: Exception) {
        promise.reject("NETBIRD_PROBE", error)
      }
    }.start()
  }

  @ReactMethod
  fun hasPersistedConfig(promise: Promise) {
    promise.resolve(NetBirdRuntime.hasPersistedConfig(context))
  }

  @ReactMethod
  fun resumeConnection(promise: Promise) {
    if (!NetBirdRuntime.hasPersistedConfig(context)) {
      promise.reject("NETBIRD_AUTH_REQUIRED", "No persisted NetBird login is available")
      return
    }
    try {
      // Non-blocking cold-start path: show the service list immediately while
      // the foreground service connects and retries in the background.
      NetBirdConnectionPreferences.markConnectedByUser(context)
      NetBirdConnectionService.start(context)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("NETBIRD_RESUME", error)
    }
  }

  @ReactMethod
  fun diagnostics(promise: Promise) {
    try {
      promise.resolve(NetBirdRuntime.diagnosticsJson(NetBirdConnectionService.isRunning))
    } catch (error: Exception) {
      promise.reject("NETBIRD_DIAGNOSTICS", error)
    }
  }

  /**
   * Lets the app turn the ongoing notification into a status panel: once a
   * count is reported, the connected state reads "已连接 · N 台机器可用"
   * instead of the bare connection status. Safe to call when the service is
   * not running — the value is remembered for the next start.
   */
  @ReactMethod
  fun reportServiceCount(count: Double, promise: Promise) {
    NetBirdConnectionService.reportServiceCount(count.toInt())
    promise.resolve(null)
  }

  @ReactMethod
  fun clearServiceCount(promise: Promise) {
    NetBirdConnectionService.clearServiceCount()
    promise.resolve(null)
  }

  /**
   * Whether finished-run notifications are on. The screen reads this on mount
   * so the switch shows the stored choice rather than a guess.
   */
  @ReactMethod
  fun getRunNotificationsEnabled(promise: Promise) {
    try {
      promise.resolve(RunNotificationStore.isEnabled(context))
    } catch (error: Exception) {
      promise.reject("NETBIRD_RUN_NOTIFY_READ", error)
    }
  }

  /**
   * Persists the finished-run switch. The foreground service reads the same
   * preference on every poll, so the change takes effect without a reconnect;
   * turning it off also withdraws the notification that is already showing.
   */
  @ReactMethod
  fun setRunNotificationsEnabled(enabled: Boolean, promise: Promise) {
    try {
      NetBirdConnectionService.applyRunNotificationsEnabled(context, enabled)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("NETBIRD_RUN_NOTIFY_WRITE", error)
    }
  }

  /**
   * Rebuilds the embedded engine on demand. The manual retry button uses this
   * because repeated `Portal.start()` calls are no-ops while a wedged instance
   * exists (native/portal.go:51-56), so "retrying" alone never recovers.
   */
  @ReactMethod
  fun resetConnection(promise: Promise) {
    if (!NetBirdRuntime.hasPersistedConfig(context)) {
      promise.reject("NETBIRD_AUTH_REQUIRED", "No persisted NetBird login is available")
      return
    }
    Thread {
      try {
        NetBirdRuntime.resetEngine(context)
        NetBirdConnectionPreferences.markConnectedByUser(context)
        NetBirdConnectionService.start(context)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("NETBIRD_RESET", error)
      }
    }.start()
  }

  @ReactMethod
  fun clearWebSessions(promise: Promise) {
    context.runOnUiQueueThread {
      try {
        android.webkit.CookieManager.getInstance().removeAllCookies(null)
        android.webkit.CookieManager.getInstance().flush()
        android.webkit.WebStorage.getInstance().deleteAllData()
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("NETBIRD_CLEAR_SESSIONS", error)
      }
    }
  }

  @ReactMethod
  fun clearWebViewCache(promise: Promise) {
    context.runOnUiQueueThread {
      try {
        android.webkit.CookieManager.getInstance().removeAllCookies(null)
        android.webkit.CookieManager.getInstance().flush()
        android.webkit.WebStorage.getInstance().deleteAllData()
        // A throwaway WebView has to be destroyed: leaving it alive on every
        // "清缓存" tap accumulates native WebView state.
        android.webkit.WebView(this@NetBirdModule.context).apply {
          clearCache(true)
          destroy()
        }
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("NETBIRD_CLEAR_CACHE", error)
      }
    }
  }

  @ReactMethod
  fun downloadApk(url: String, destPath: String, promise: Promise) {
    Thread {
      try {
        val result = Portal.download(url, destPath)
        context.runOnUiQueueThread { promise.resolve(result) }
      } catch (error: Exception) {
        context.runOnUiQueueThread { promise.reject("NETBIRD_DOWNLOAD", error) }
      }
    }.start()
  }

  @ReactMethod
  fun downloadState(promise: Promise) {
    Thread {
      try {
        val result = Portal.downloadState()
        context.runOnUiQueueThread { promise.resolve(result) }
      } catch (error: Exception) {
        context.runOnUiQueueThread { promise.reject("NETBIRD_DOWNLOAD_STATE", error) }
      }
    }.start()
  }

  @ReactMethod
  fun cancelDownload(promise: Promise) {
    Thread {
      try {
        Portal.cancelDownload()
        context.runOnUiQueueThread { promise.resolve(null) }
      } catch (error: Exception) {
        context.runOnUiQueueThread { promise.reject("NETBIRD_CANCEL_DOWNLOAD", error) }
      }
    }.start()
  }

  @ReactMethod
  fun installApk(destPath: String, promise: Promise) {
    context.runOnUiQueueThread {
      try {
        val apk = File(destPath)
        if (!apk.exists()) {
          promise.reject("NETBIRD_INSTALL_NOFILE", "APK not found: $destPath")
          return@runOnUiQueueThread
        }
        val uri = androidx.core.content.FileProvider.getUriForFile(
          context.applicationContext,
          "${context.packageName}.fileprovider",
          apk,
        )
        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW)
        intent.setDataAndType(uri, "application/vnd.android.package-archive")
        intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("NETBIRD_INSTALL", error)
      }
    }
  }

  @ReactMethod
  fun getAppVersion(promise: Promise) {
    try {
      val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
      val result = "{\"versionCode\":${pkg.longVersionCode},\"versionName\":\"${pkg.versionName}\"}"
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("NETBIRD_APP_VERSION", error)
    }
  }

  @ReactMethod
  fun getDownloadsDir(promise: Promise) {
    val dir = File(context.filesDir, "downloads")
    if (!dir.exists()) {
      dir.mkdirs()
    }
    promise.resolve(dir.absolutePath)
  }

  /**
   * Removes one of this app's own download files.
   *
   * The native downloader keeps a partial file for Range/206 resume, but a
   * partial that is larger than the served APK makes every later attempt fail
   * with HTTP 416 and is never cleaned up on its own. The JS side deletes it and
   * retries once; anything outside the downloads directory is refused.
   */
  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    Thread {
      try {
        val file = File(path)
        val downloadsRoot = File(context.filesDir, "downloads")
        if (file.isDirectory || !NetBirdRuntime.isManagedPath(downloadsRoot, file)) {
          promise.reject(
            "NETBIRD_DELETE_SCOPE",
            "Refusing to delete outside the downloads directory",
          )
          return@Thread
        }
        val deleted = !file.exists() || file.delete()
        promise.resolve(deleted)
      } catch (error: Exception) {
        promise.reject("NETBIRD_DELETE", error)
      }
    }.start()
  }

  /**
   * The management server in force, plus the compiled default and whether the
   * current one is the user's choice. The settings row shows this instead of a
   * compiled string, so a switched install cannot display the address it stopped
   * using.
   */
  @ReactMethod
  fun getServerConfig(promise: Promise) {
    try {
      promise.resolve(NetBirdRuntime.serverConfigJson(context))
    } catch (error: Exception) {
      promise.reject("NETBIRD_SERVER_READ", error.message ?: "无法读取服务器设置")
    }
  }

  /**
   * Chooses the management server. Native owns the rule (https origin, host and
   * port only) so both screens accept exactly what the engine can dial; a
   * rejected value comes back as NETBIRD_SERVER_URL with the reason.
   *
   * The call runs off the bridge thread: a changed address stops the connection
   * service and drops the local enrollment, which waits on the service.
   */
  @ReactMethod
  fun setServerUrl(url: String, promise: Promise) {
    Thread {
      try {
        val result = NetBirdRuntime.switchManagementUrl(context, url)
        context.runOnUiQueueThread { promise.resolve(result) }
      } catch (error: Exception) {
        context.runOnUiQueueThread {
          promise.reject(
            if (error is IllegalArgumentException) "NETBIRD_SERVER_URL" else "NETBIRD_SERVER_WRITE",
            error.message ?: "无法保存服务器地址",
          )
        }
      }
    }.start()
  }

  /** Goes back to the address the app ships with, with the same consequences. */
  @ReactMethod
  fun resetServerUrl(promise: Promise) {
    Thread {
      try {
        val result = NetBirdRuntime.resetManagementUrl(context)
        context.runOnUiQueueThread { promise.resolve(result) }
      } catch (error: Exception) {
        context.runOnUiQueueThread {
          promise.reject("NETBIRD_SERVER_WRITE", error.message ?: "无法恢复默认服务器")
        }
      }
    }.start()
  }

  @ReactMethod
  fun loginSSO(promise: Promise) {
    Thread {
      try {
        val files = context.filesDir
        val config = File(files, NetBirdRuntime.CONFIG_FILE_NAME).absolutePath
        val state = File(files, NetBirdRuntime.STATE_FILE_NAME).absolutePath
        val url = Portal.loginSSO(
          "netbird-portal-android",
          NetBirdRuntime.managementUrl(context),
          config,
          state,
        )
        context.runOnUiQueueThread { promise.resolve(url) }
      } catch (error: Exception) {
        context.runOnUiQueueThread { promise.reject("NETBIRD_SSO_LOGIN", error) }
      }
    }.start()
  }

  @ReactMethod
  fun ssoStatus(promise: Promise) {
    Thread {
      try {
        val status = Portal.ssoStatus()
        context.runOnUiQueueThread { promise.resolve(status) }
      } catch (error: Exception) {
        context.runOnUiQueueThread { promise.reject("NETBIRD_SSO_STATUS", error) }
      }
    }.start()
  }
}

class NetBirdPackage : com.facebook.react.ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext) =
    listOf(NetBirdModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext) =
    emptyList<com.facebook.react.uimanager.ViewManager<*, *>>()
}
