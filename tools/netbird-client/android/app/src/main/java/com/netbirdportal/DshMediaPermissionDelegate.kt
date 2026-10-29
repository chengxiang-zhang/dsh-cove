package com.netbirdportal

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import java.net.URI
import androidx.appcompat.app.AlertDialog
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.mozilla.geckoview.GeckoSession

/**
 * Grants the official DSH voice-input plugin access to the Android microphone.
 *
 * The page plugin owns getUserMedia, MediaRecorder, recognition and draft
 * insertion. This delegate is only the browser/OS permission bridge. It never
 * receives audio bytes and denies video, third-party frames and non-DSH pages.
 */
class DshMediaPermissionDelegate(
  private val activity: Activity,
  private val currentUrl: () -> String,
  private val authorizedDshHost: () -> String?,
) : GeckoSession.PermissionDelegate {
  private data class PendingMedia(
    val requestUri: String,
    val audio: GeckoSession.PermissionDelegate.MediaSource,
    val callback: GeckoSession.PermissionDelegate.MediaCallback,
  )

  private data class PendingAndroid(
    val requestUri: String,
    val callback: GeckoSession.PermissionDelegate.Callback,
  )

  private var pendingMedia: PendingMedia? = null
  private var pendingAndroid: PendingAndroid? = null

  override fun onAndroidPermissionsRequest(
    session: GeckoSession,
    permissions: Array<out String>?,
    callback: GeckoSession.PermissionDelegate.Callback,
  ) {
    val requestUri = currentUrl()
    val requested = permissions.orEmpty()
    Log.i(LOG_TAG, "Android permission request permissions=${requested.joinToString()}")
    if (!isTrustedDshOrigin(requestUri, requestUri, authorizedDshHost()) ||
      !acceptsAndroidMicrophonePermissions(requested.toList())
    ) {
      Log.w(LOG_TAG, "Android permission request rejected")
      callback.reject()
      return
    }
    if (hasRecordAudioPermission()) {
      callback.grant()
      return
    }
    pendingAndroid?.callback?.reject()
    pendingAndroid = PendingAndroid(requestUri, callback)
    ActivityCompat.requestPermissions(
      activity,
      arrayOf(Manifest.permission.RECORD_AUDIO),
      ANDROID_PERMISSION_REQUEST,
    )
  }

  override fun onMediaPermissionRequest(
    session: GeckoSession,
    uri: String,
    video: Array<out GeckoSession.PermissionDelegate.MediaSource>?,
    audio: Array<out GeckoSession.PermissionDelegate.MediaSource>?,
    callback: GeckoSession.PermissionDelegate.MediaCallback,
  ) {
    Log.i(
      LOG_TAG,
      "media request uri=$uri video=${video?.size ?: 0} audio=${audio?.size ?: 0}",
    )
    val audioSources = audio?.map { it.type to it.source }.orEmpty()
    val microphone = audio
      ?.firstOrNull {
        it.type == GeckoSession.PermissionDelegate.MediaSource.TYPE_AUDIO &&
          it.source == GeckoSession.PermissionDelegate.MediaSource.SOURCE_MICROPHONE
      }
    if (!isTrustedDshOrigin(uri, currentUrl(), authorizedDshHost()) ||
      !canGrantMicrophoneFromCandidates(
        videoCount = video?.size ?: 0,
        audioSources = audioSources,
      ) ||
      microphone == null
    ) {
      Log.w(LOG_TAG, "media request rejected")
      callback.reject()
      return
    }
    if (hasRecordAudioPermission()) {
      Log.i(LOG_TAG, "microphone request granted")
      callback.grant(null, microphone)
      return
    }
    pendingMedia?.callback?.reject()
    pendingMedia = PendingMedia(uri, microphone, callback)
    ActivityCompat.requestPermissions(
      activity,
      arrayOf(Manifest.permission.RECORD_AUDIO),
      MEDIA_PERMISSION_REQUEST,
    )
  }

  fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray): Boolean {
    when (requestCode) {
      ANDROID_PERMISSION_REQUEST -> {
        val pending = pendingAndroid ?: return true
        pendingAndroid = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED &&
          isTrustedDshOrigin(pending.requestUri, currentUrl(), authorizedDshHost())
        ) {
          pending.callback.grant()
        } else {
          pending.callback.reject()
          showPermissionRecovery()
        }
        return true
      }
      MEDIA_PERMISSION_REQUEST -> {
        val pending = pendingMedia ?: return true
        pendingMedia = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED &&
          isTrustedDshOrigin(pending.requestUri, currentUrl(), authorizedDshHost())
        ) {
          Log.i(LOG_TAG, "microphone request granted after Android permission")
          pending.callback.grant(null, pending.audio)
        } else {
          Log.w(LOG_TAG, "microphone request rejected after Android permission")
          pending.callback.reject()
          showPermissionRecovery()
        }
        return true
      }
      else -> return false
    }
  }

  fun close() {
    pendingAndroid?.callback?.reject()
    pendingAndroid = null
    pendingMedia?.callback?.reject()
    pendingMedia = null
  }

  private fun hasRecordAudioPermission(): Boolean =
    ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  private fun showPermissionRecovery() {
    if (ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.RECORD_AUDIO)) {
      AlertDialog.Builder(activity)
        .setTitle("需要麦克风权限")
        .setMessage("请允许 NetBird Portal 使用麦克风，DSH 官方语音输入才能录音。")
        .setPositiveButton("知道了", null)
        .show()
      return
    }
    AlertDialog.Builder(activity)
      .setTitle("开启麦克风权限")
      .setMessage("请在系统设置中允许 NetBird Portal 使用麦克风。")
      .setNegativeButton("取消", null)
      .setPositiveButton("去设置") { _, _ ->
        activity.startActivity(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${activity.packageName}")
          },
        )
      }
      .show()
  }

  companion object {
    private const val LOG_TAG = "DshMediaPermission"
    private const val ANDROID_PERMISSION_REQUEST = 21003
    private const val MEDIA_PERMISSION_REQUEST = 21004

    fun acceptsAndroidMicrophonePermissions(permissions: List<String>): Boolean =
      permissions.isNotEmpty() &&
        permissions.all {
          it == Manifest.permission.RECORD_AUDIO ||
            it == Manifest.permission.MODIFY_AUDIO_SETTINGS
        } &&
        permissions.contains(Manifest.permission.RECORD_AUDIO)

    /**
     * Gecko passes available media devices here, not a list of capabilities the
     * page will receive. A microphone-only getUserMedia request can therefore
     * include both microphone and audio-capture candidates on some Android
     * compatibility layers. Grant exactly one microphone candidate; never grant
     * the other candidates and still reject every request that offers video.
     */
    fun canGrantMicrophoneFromCandidates(
      videoCount: Int,
      audioSources: List<Pair<Int, Int>>,
    ): Boolean =
      videoCount == 0 &&
        audioSources.any { (type, source) ->
          type == GeckoSession.PermissionDelegate.MediaSource.TYPE_AUDIO &&
            source == GeckoSession.PermissionDelegate.MediaSource.SOURCE_MICROPHONE
        }

    fun isTrustedDshOrigin(
      requestUri: String,
      currentUri: String,
      authorizedDshHost: String?,
    ): Boolean {
      val request = runCatching { URI(requestUri) }.getOrNull() ?: return false
      val current = runCatching { URI(currentUri) }.getOrNull() ?: return false
      val requestHost = request.host?.lowercase() ?: return false
      val currentHost = current.host?.lowercase() ?: return false
      val authorizedHost = authorizedDshHost?.lowercase() ?: return false
      // Self-hosted entries are `dsh.<machine>.<zone>`, cloud entries are the
      // peer's own FQDN; both are accepted shapes here, while the trust set
      // still decides whether the host exists at all.
      if (!(authorizedHost.startsWith("dsh.") || DshHostRegistry.isCloudHost(authorizedHost)) ||
        requestHost != authorizedHost ||
        currentHost != authorizedHost
      ) return false
      if (request.scheme !in setOf("http", "https") || request.scheme != current.scheme) return false
      return normalizedPort(request) == normalizedPort(current)
    }

    private fun normalizedPort(uri: URI): Int = when {
      uri.port >= 0 -> uri.port
      uri.scheme == "https" -> 443
      else -> 80
    }
  }
}
