package com.netbirdportal

import java.net.URI

/**
 * Validation and canonicalization for the NetBird management (control plane)
 * address a user types in.
 *
 * This is the only place the rule lives: the settings row and the login screen
 * both send the raw text through the bridge, and a rejected value comes back
 * with [INVALID_INPUT_MESSAGE]. Duplicating the rule in JavaScript is what would
 * let a screen accept an address the native side refuses.
 *
 * The rule is deliberately narrow, because this string is the enrollment
 * identity of the install:
 *
 * - `https` only. The sign-in page is loaded by the system WebView, whose
 *   cleartext policy allows `http` for the loopback callback alone, so an
 *   `http://` control plane could never complete a login here.
 * - host and port only. A path, query or fragment would silently change which
 *   endpoint the embedded client talks to; a userinfo part would be stored in
 *   plain preferences and shown on screen.
 * - the port is always made explicit, defaulting to 443, so
 *   `https://host` and `https://host:443` are the same enrollment instead of
 *   two identities that differ by formatting.
 *
 * The canonical form is `https://<lowercase-host>:<port>`.
 */
object NetBirdServerAddress {
  /** Longer than this is a paste accident, not an address. */
  const val MAX_LENGTH = 200

  /** Shown to the reader when the input cannot be used. */
  const val INVALID_INPUT_MESSAGE =
    "请输入以 https:// 开头的管理端地址，只填主机和端口，例如 https://netbird.example.com"

  private const val SCHEME = "https"
  private const val DEFAULT_PORT = 443

  /** The canonical address, or null when the input is not usable. */
  fun normalize(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty() || trimmed.length > MAX_LENGTH) {
      return null
    }
    if (trimmed.any { it.isWhitespace() }) {
      return null
    }
    val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
    if (!SCHEME.equals(uri.scheme, ignoreCase = true)) {
      return null
    }
    if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
      return null
    }
    val path = uri.path.orEmpty()
    if (path.isNotEmpty() && path != "/") {
      return null
    }
    val host = uri.host?.lowercase() ?: return null
    if (host.isEmpty()) {
      return null
    }
    val port = if (uri.port == -1) DEFAULT_PORT else uri.port
    if (port <= 0 || port > 65535) {
      return null
    }
    return "$SCHEME://$host:$port"
  }
}