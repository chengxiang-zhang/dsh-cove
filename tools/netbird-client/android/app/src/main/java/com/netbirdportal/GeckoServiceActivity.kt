package com.netbirdportal

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.netbird.portal.Portal
import org.json.JSONObject
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebResponse
import java.io.File
import java.net.URLDecoder

/**
 * Full-screen bundled-engine browser for one DSH service. The URL arrives via
 * intent; the loopback NetBird proxy port is already baked into the GeckoView
 * config file by [GeckoViewHelper] before the runtime starts, so the page is
 * loaded through the embedded NetBird netstack.
 *
 * P3 control bar (slice 2): 回首页 / 后退 / 前进 / 刷新 / 只读地址栏,
 * plus a download bar (N7) fed by ContentDelegate.onExternalResponse and the
 * embedded NetBird Portal.download pipeline (Range/206 capable).
 */
class GeckoServiceActivity : Activity() {

  private lateinit var session: GeckoSession
  private lateinit var geckoView: GeckoView
  private lateinit var urlView: TextView
  private lateinit var backButton: TextView
  private lateinit var forwardButton: TextView
  private lateinit var mediaPermissionDelegate: DshMediaPermissionDelegate

  private lateinit var downloadBar: LinearLayout
  private lateinit var progressBar: ProgressBar
  private lateinit var downloadText: TextView
  private lateinit var cancelButton: TextView
  private lateinit var openButton: TextView
  private lateinit var shareButton: TextView

  private var currentUrl = ""
  private var authorizedDshHost: String? = null
  private var downloadPath: File? = null

  @Volatile private var downloadActive = false
  @Volatile private var cancelRequested = false

  private val uiHandler = Handler(Looper.getMainLooper())
  private val collapseRunnable = Runnable { downloadBar.visibility = View.GONE }

  /**
   * Colours come from the shared brand tokens (res/values/aw_colors.xml and its
   * -night twin) rather than from literals. This activity is the primary
   * workspace surface, and it used to hardcode the previous brand blue on a white
   * toolbar whatever the reader's theme was. Read through a getter so a scheme
   * switch picks up the night-qualified resource.
   */
  private val colorEnabled: Int get() = getColor(R.color.aw_brand)
  private val colorDisabled: Int get() = getColor(R.color.aw_text_faint)

  private lateinit var toolbar: LinearLayout
  private val toolbarButtons = mutableListOf<TextView>()
  private var navBackEnabled = false
  private var navForwardEnabled = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val url = intent.getStringExtra("url") ?: BrowserSessionStore.lastUrl(this)
    if (url.isNullOrBlank()) {
      finish()
      return
    }
    // Strict scope: the browser page only ever opens a DSH service discovery
    // accepted from the control plane, so a notification resume or a crafted
    // intent cannot reach another intranet address.
    val registeredUrl = DshHostRegistry.registeredServiceUrl(url)
    if (registeredUrl == null) {
      finish()
      return
    }
    currentUrl = registeredUrl
    authorizedDshHost = authorizedHostFor(
      registeredUrl,
      intent.getStringExtra("authorizedDshHost"),
      DshHostRegistry.trustedHosts(),
    )
    BrowserSessionStore.rememberUrl(this, registeredUrl)
    val runtime = GeckoViewHelper.ensureRuntime(this)

    // ---- Control bar ----
    val homeButton = toolbarButton("回首页", 14f) { finish() }
    backButton = toolbarButton("‹", 18f) { session.goBack() }
    forwardButton = toolbarButton("›", 18f) { session.goForward() }
    val refreshButton = toolbarButton("刷新", 14f) { session.reload() }
    urlView = TextView(this).apply {
      text = url
      maxLines = 1
      ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
      setTextColor(getColor(R.color.aw_text))
      textSize = 13f
      gravity = Gravity.CENTER
    }
    setNavEnabled(backButton, false)
    setNavEnabled(forwardButton, false)

    toolbar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setBackgroundColor(getColor(R.color.aw_surface))
      setPadding(dp(12), dp(6), dp(12), dp(6))
    }
    // NB: buttons must use WRAP_CONTENT width — a 0-width + 0-weight child
    // is measured 0px wide and never rendered (inherited v9 toolbar bug).
    toolbar.addView(homeButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))
    toolbar.addView(backButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))
    toolbar.addView(forwardButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))
    toolbar.addView(refreshButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))
    toolbar.addView(urlView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

    // ---- Download bar ----
    progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
      progressTintList = ColorStateList.valueOf(getColor(R.color.aw_brand))
      indeterminateTintList = ColorStateList.valueOf(getColor(R.color.aw_brand))
    }
    downloadText = TextView(this).apply {
      text = ""
      setTextColor(getColor(R.color.aw_text))
      textSize = 13f
      maxLines = 1
      setPadding(dp(8), 0, dp(8), 0)
    }
    cancelButton = TextView(this).apply {
      text = "取消"
      setTextColor(colorEnabled)
      textSize = 13f
      setPadding(dp(4), dp(4), dp(4), dp(4))
      setOnClickListener { requestCancel() }
    }
    openButton = TextView(this).apply {
      text = "打开"
      setTextColor(colorEnabled)
      textSize = 13f
      setPadding(dp(4), dp(4), dp(4), dp(4))
      setOnClickListener { openDownload() }
      visibility = View.GONE
    }
    shareButton = TextView(this).apply {
      text = "分享"
      setTextColor(colorEnabled)
      textSize = 13f
      setPadding(dp(4), dp(4), dp(4), dp(4))
      setOnClickListener { shareDownload() }
      visibility = View.GONE
    }
    downloadBar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setBackgroundColor(getColor(R.color.aw_surface_alt))
      setPadding(dp(12), dp(4), dp(12), dp(4))
      visibility = View.GONE
    }
    // NB: fixed-width children need WRAP_CONTENT width — (0,WRAP,0f) measures 0px.
    downloadBar.addView(progressBar, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    downloadBar.addView(downloadText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))
    downloadBar.addView(cancelButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))
    downloadBar.addView(openButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))
    downloadBar.addView(shareButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0f))

    // ---- Root: toolbar / download bar / content ----
    geckoView = GeckoView(this)
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
    }
    root.addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(downloadBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(geckoView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    // The app draws edge to edge, so without insets the control bar is painted
    // under the status bar: the system icons land on top of 回首页 and 刷新, and
    // the status bar's own area swallows the taps.
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(0, bars.top, 0, bars.bottom)
      insets
    }
    setContentView(root)

    mediaPermissionDelegate = DshMediaPermissionDelegate(
      activity = this,
      currentUrl = { currentUrl },
      authorizedDshHost = { authorizedDshHost },
    )
    session = GeckoSession().apply {
      permissionDelegate = mediaPermissionDelegate
      open(runtime)
      GeckoViewHelper.sessionOpened()
      navigationDelegate = object : GeckoSession.NavigationDelegate {
        override fun onLocationChange(
          session: GeckoSession,
          url: String?,
          perms: List<GeckoSession.PermissionDelegate.ContentPermission>,
          hasUserGesture: Boolean,
        ) {
          if (url.isNullOrBlank()) return
          currentUrl = url
          // Only a URL this app can open again may be remembered: the ongoing
          // notification and the activity's own cold start both replay this
          // value, and a deep page URL is refused by the registry.
          DshHostRegistry.registeredServiceUrl(url)?.let {
            BrowserSessionStore.rememberUrl(this@GeckoServiceActivity, it)
          }
          runOnUiThread { urlView.text = url }
        }

        override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
          navBackEnabled = canGoBack
          runOnUiThread { setNavEnabled(backButton, canGoBack) }
        }

        override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) {
          navForwardEnabled = canGoForward
          runOnUiThread { setNavEnabled(forwardButton, canGoForward) }
        }
      }
      contentDelegate = object : GeckoSession.ContentDelegate {
        override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
          handleExternalResponse(response)
        }
      }
    }
    geckoView.setSession(session)
    applyThemeColors()
    session.loadUri(url)
  }

  /**
   * The manifest declares `uiMode` as handled, so switching the system theme does
   * not recreate this activity. The colours therefore have to be re-read here, or
   * the sidebar would keep whichever scheme it was first built in.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyThemeColors()
  }

  private fun applyThemeColors() {
    if (!::toolbar.isInitialized) return
    toolbar.setBackgroundColor(getColor(R.color.aw_surface))
    downloadBar.setBackgroundColor(getColor(R.color.aw_surface_alt))
    urlView.setTextColor(getColor(R.color.aw_text))
    downloadText.setTextColor(getColor(R.color.aw_text))
    progressBar.progressTintList = ColorStateList.valueOf(getColor(R.color.aw_brand))
    progressBar.indeterminateTintList = ColorStateList.valueOf(getColor(R.color.aw_brand))
    for (button in toolbarButtons) {
      button.setTextColor(colorEnabled)
    }
    // Navigation arrows carry an enabled/disabled state, so theirs is restored
    // from what the session last reported rather than forced to the brand colour.
    setNavEnabled(backButton, navBackEnabled)
    setNavEnabled(forwardButton, navForwardEnabled)
  }

  override fun onStart() {
    super.onStart()
    if (::session.isInitialized) {
      session.setActive(true)
    }
  }

  override fun onStop() {
    if (::session.isInitialized) {
      session.setActive(false)
    }
    super.onStop()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    val requested = intent.getStringExtra("url") ?: return
    val registeredUrl = DshHostRegistry.registeredServiceUrl(requested) ?: return
    authorizedDshHost = authorizedHostFor(
      registeredUrl,
      intent.getStringExtra("authorizedDshHost"),
      DshHostRegistry.trustedHosts(),
    )
    if (registeredUrl == currentUrl) {
      return
    }
    currentUrl = registeredUrl
    BrowserSessionStore.rememberUrl(this, registeredUrl)
    urlView.text = registeredUrl
    session.loadUri(registeredUrl)
  }

  @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
  override fun onBackPressed() {
    // GeckoView 150 exposes public goBack()/goForward() (verified in the AAR);
    // the toolbar back button handles page-level history. The system back
    // button leaves the DSH page and returns to the service list.
    super.onBackPressed()
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (::mediaPermissionDelegate.isInitialized) {
      mediaPermissionDelegate.onRequestPermissionsResult(requestCode, grantResults)
    }
  }

  override fun onDestroy() {
    if (::mediaPermissionDelegate.isInitialized) {
      mediaPermissionDelegate.close()
    }
    downloadActive = false
    uiHandler.removeCallbacks(collapseRunnable)
    // onCreate finishes early for a blank or unregistered address, so the
    // session may never have been created. Without this guard the teardown
    // throws UninitializedPropertyAccessException and takes the whole process
    // (foreground connection service included) down with it.
    if (::session.isInitialized) {
      session.close()
    }
    GeckoViewHelper.sessionClosed(this)
    super.onDestroy()
  }

  // ---- Download (N7): GeckoView external response -> Portal tunnel download ----
  private fun handleExternalResponse(response: WebResponse) {
    val uri = response.uri
    if (!(uri.startsWith("http://") || uri.startsWith("https://"))) return
    if (downloadActive) return // one download at a time
    val dir = File(filesDir, "downloads").apply { mkdirs() }
    val dest = File(dir, downloadName(uri, response.headers))
    startDownload(uri, dest)
  }

  private fun downloadName(uri: String, headers: Map<String, String>): String {
    var name: String? = null
    headers["Content-Disposition"]?.let { cd ->
      Regex("filename\\*?=\"?([^\";]+)").find(cd)?.groupValues?.getOrNull(1)?.let {
        val raw = it.trim().removeSurrounding("\"")
        val decoded = try {
          URLDecoder.decode(raw.removePrefix("UTF-8''"), "UTF-8")
        } catch (e: Exception) {
          raw
        }
        name = decoded
      }
    }
    if (name.isNullOrBlank()) {
      name = uri.substringBefore('?').substringAfterLast('/')
    }
    val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(100)
    return safe.ifBlank { "download.bin" }
  }

  private fun startDownload(url: String, dest: File) {
    downloadActive = true
    cancelRequested = false
    downloadPath = dest
    uiHandler.removeCallbacks(collapseRunnable)
    runOnUiThread {
      downloadBar.visibility = View.VISIBLE
      progressBar.isIndeterminate = false
      progressBar.progress = 0
      downloadText.text = "下载中 0"
      cancelButton.visibility = View.VISIBLE
      openButton.visibility = View.GONE
      shareButton.visibility = View.GONE
    }

    // Progress polling (Portal.downloadState is native/blocking -> background).
    val poller = Thread {
      while (downloadActive) {
        try {
          val json = JSONObject(Portal.downloadState())
          val active = json.optBoolean("active", false)
          val bytes = json.optLong("bytes", 0L)
          val total = json.optLong("total", 0L)
          runOnUiThread { updateProgress(bytes, total, active) }
        } catch (e: Exception) {
          // transient native state; keep polling
        }
        try {
          Thread.sleep(500)
        } catch (e: InterruptedException) {
          break
        }
      }
    }
    poller.start()

    // Portal.download is synchronous/blocking (same process, NetBird Dial,
    // Range/206 resume) -> must run on a background thread.
    Thread {
      val ok = try {
        Portal.download(url, dest.absolutePath)
        dest.exists() && dest.length() > 0
      } catch (e: Exception) {
        false
      }
      downloadActive = false
      runOnUiThread { onDownloadFinished(ok) }
    }.start()
  }

  private fun updateProgress(bytes: Long, total: Long, active: Boolean) {
    if (!downloadActive || isFinishing) return
    if (total > 0) {
      progressBar.isIndeterminate = false
      progressBar.progress = ((bytes * 100) / total).toInt().coerceIn(0, 100)
      downloadText.text = "下载中 ${formatSize(bytes)}/${formatSize(total)}"
    } else {
      progressBar.isIndeterminate = true
      downloadText.text = "下载中 ${formatSize(bytes)}"
    }
  }

  private fun onDownloadFinished(success: Boolean) {
    if (isFinishing) return
    progressBar.isIndeterminate = false
    if (cancelRequested) {
      downloadText.text = "已取消"
      cancelButton.visibility = View.GONE
      scheduleCollapse(2500)
    } else if (success) {
      downloadText.text = "下载完成"
      progressBar.progress = progressBar.max
      cancelButton.visibility = View.GONE
      openButton.visibility = View.VISIBLE
      shareButton.visibility = View.VISIBLE
      scheduleCollapse(4000)
    } else {
      downloadText.text = "下载失败"
      cancelButton.visibility = View.GONE
      scheduleCollapse(3000)
    }
  }

  private fun requestCancel() {
    cancelRequested = true
    downloadText.text = "正在取消…"
    Thread {
      try {
        Portal.cancelDownload()
      } catch (e: Exception) {
        // ignore
      }
    }.start()
  }

  private fun openDownload() {
    val file = downloadPath ?: return
    if (!file.exists()) return
    val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
    val mime = MimeTypeMap.getSingleton()
      .getMimeTypeFromExtension(file.extension.lowercase())
      ?: "application/octet-stream"
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      Toast.makeText(this, "没有可打开该文件的应用", Toast.LENGTH_SHORT).show()
    }
  }

  private fun shareDownload() {
    val file = downloadPath ?: return
    if (!file.exists()) return
    val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_SEND).setType("*/*")
      .putExtra(Intent.EXTRA_STREAM, uri)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    startActivity(Intent.createChooser(intent, "分享文件"))
  }

  private fun scheduleCollapse(delayMs: Long) {
    uiHandler.removeCallbacks(collapseRunnable)
    uiHandler.postDelayed(collapseRunnable, delayMs)
  }

  private fun toolbarButton(label: String, sizeSp: Float, onClick: () -> Unit): TextView =
    TextView(this).apply {
      text = label
      setTextColor(colorEnabled)
      textSize = sizeSp
      setPadding(dp(6), dp(8), dp(6), dp(8))
      setOnClickListener { onClick() }
      toolbarButtons.add(this)
    }

  private fun setNavEnabled(button: TextView, enabled: Boolean) {
    button.isEnabled = enabled
    button.setTextColor(if (enabled) colorEnabled else colorDisabled)
  }

  private fun formatSize(bytes: Long): String = when {
    bytes >= 1 shl 20 -> String.format("%.1f MB", bytes / 1048576.0)
    bytes >= 1 shl 10 -> String.format("%.1f KB", bytes / 1024.0)
    else -> "$bytes B"
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  companion object {
    internal fun authorizedHostFor(
      url: String,
      candidate: String?,
      registeredHosts: Set<String>,
    ): String? {
      val host = runCatching { java.net.URI(url).host?.lowercase() }.getOrNull() ?: return null
      if (!registeredHosts.contains(host)) return null
      val normalizedCandidate = candidate?.trim()?.lowercase()
      // Callers pass a URL the registry already accepted. The ongoing
      // notification carries only that URL, so a missing candidate must not
      // silently disable the microphone: the validated host is the authority.
      // A candidate that is present still has to match it exactly.
      return if (normalizedCandidate.isNullOrEmpty()) {
        host
      } else {
        normalizedCandidate.takeIf { it == host }
      }
    }
  }
}
