package com.netbirdportal

import android.content.Context
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import java.io.File

/**
 * Owns the single per-process GeckoRuntime (bundled Firefox engine).
 *
 * The loopback NetBird proxy port is baked into a geckoview-config.yaml that
 * GeckoView reads unconditionally via configFilePath, so the bundled engine
 * routes dsh.<zone> traffic through the embedded NetBird netstack exactly like
 * the WebView ProxyController path. A modern engine is required because the
 * system WebView on some HarmonyOS devices (Chrome/114 kernel) cannot evaluate
 * the DSH client bundle (ES2024 APIs such as Promise.withResolvers).
 */
object GeckoViewHelper {
  private const val CFG_NAME = "geckoview-config.yaml"
  private const val DEFAULT_PORT = 19001
  private const val PREFS = "netbird_portal"
  private const val KEY_PORT = "proxy_port"

  @Volatile
  private var runtime: GeckoRuntime? = null

  @Volatile
  private var activeSessions = 0

  @Volatile
  private var pendingProxyPort: Int? = null

  fun configFile(context: Context): File = File(context.filesDir, CFG_NAME)

  fun proxyPort(context: Context): Int =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_PORT, DEFAULT_PORT)

  // Default: the portal proxy runs in-process on loopback. The acceptance
  // emulator overrides this to the docker bridge gateway so GeckoView reaches
  // the host-side tunnel proxy.
  fun proxyHost(context: Context): String =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString("proxy_host", "127.0.0.1") ?: "127.0.0.1"

  fun storeProxyPort(context: Context, port: Int) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putInt(KEY_PORT, port)
      .apply()
  }

  @Synchronized
  fun updateProxyPort(context: Context, port: Int) {
    val oldPort = proxyPort(context)
    if (oldPort == port) return
    if (runtime != null && activeSessions > 0) {
      // Never tear down a live browser/WS. The new port is applied only after
      // the last session closes and a future runtime is created.
      pendingProxyPort = port
      return
    }
    storeProxyPort(context, port)
    if (runtime != null) {
      shutdown()
    }
  }

  @Synchronized
  fun sessionOpened() {
    activeSessions += 1
  }

  @Synchronized
  fun sessionClosed(context: Context) {
    activeSessions = (activeSessions - 1).coerceAtLeast(0)
    if (activeSessions == 0) {
      pendingProxyPort?.let {
        pendingProxyPort = null
        storeProxyPort(context, it)
        shutdown()
      }
    }
  }

  @Synchronized
  fun ensureRuntime(context: Context): GeckoRuntime {
    runtime?.let { return it }
    pendingProxyPort?.let {
      pendingProxyPort = null
      storeProxyPort(context, it)
    }
    writeConfig(context, proxyPort(context))
    val settings = GeckoRuntimeSettings.Builder()
      .configFilePath(configFile(context).absolutePath)
      .allowInsecureConnections(GeckoRuntimeSettings.ALLOW_ALL)
      .javaScriptEnabled(true)
      .remoteDebuggingEnabled(true)
      .setLnaEnabled(false)
      .setLnaBlocking(false)
      .build()
    val created = GeckoRuntime.create(context, settings)
    runtime = created
    return created
  }

  @Synchronized
  fun shutdown() {
    runtime?.shutdown()
    runtime = null
  }

  internal fun configYaml(host: String, port: Int): String = buildString {
    appendLine("prefs:")
    appendLine("  network.proxy.type: 1")
    appendLine("  network.proxy.http: \"$host\"")
    appendLine("  network.proxy.http_port: $port")
    appendLine("  network.proxy.ssl: \"$host\"")
    appendLine("  network.proxy.ssl_port: $port")
    appendLine("  network.proxy.no_proxies_on: \"localhost, 127.0.0.1\"")
    appendLine("  network.trr.mode: 5")
    // DSH's content-addressed bundles (assets/index-<hash>.js and the batched
    // plugins/??...&rev=<hash> requests) are served immutable by nginx, so the
    // engine can keep them instead of pulling ~14 MB over the overlay on every
    // open. A fixed capacity is used because smart sizing would shrink the
    // cache below what one DSH version needs.
    appendLine("  browser.cache.disk.enable: true")
    appendLine("  browser.cache.disk.smart_size.enabled: false")
    appendLine("  browser.cache.disk.capacity: 524288")
    appendLine("  browser.cache.memory.enable: true")
    // The official DSH voice-input v0.2.0 plugin owns MediaRecorder and
    // getUserMedia, while private DSH origins are currently http://dsh.*.
    // GeckoServiceActivity remains the final allow-list gate.
    appendLine("  media.devices.insecure.enabled: true")
    appendLine("  media.getusermedia.insecure.enabled: true")
  }

  private fun writeConfig(context: Context, port: Int) {
    configFile(context).writeText(configYaml(proxyHost(context), port))
  }
}
