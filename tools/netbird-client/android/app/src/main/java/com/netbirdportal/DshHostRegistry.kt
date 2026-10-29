package com.netbirdportal

import android.content.Context
import org.json.JSONArray
import java.net.URI

/**
 * The only DSH entry registry for this app.
 *
 * It is a rule evaluated at runtime, not a list compiled into the APK. The
 * fleet inventory lives in tools/dsh-netbird/machines.json; a second copy here
 * could only ever go stale, and when the fleet moved from `dsh.<machine>` to
 * `dsh.<machine>.netbird` the stale copy silently emptied the catalogue on every
 * phone.
 *
 * A DNS record is offered only when all of this holds:
 *
 * - it is an A record;
 * - its name is `dsh.<label>` inside one of the fleet's DSH zones
 *   (`R.array.fleet_dsh_zones`, the zone part of machines.json's domainPattern);
 * - the address it points at belongs to a peer of this network
 *   (`Portal.peerAddresses()`), so a record can never send the app outside the
 *   overlay it already lives in.
 *
 * Adding a machine is then a NetBird-side change: no app release, no second
 * inventory to synchronize. What still has to be compiled is the zone name,
 * because Android's cleartext policy is a build-time resource either way.
 *
 * The accepted hosts are remembered for the lifetime of the process and are the
 * authority for opening a page (`registeredServiceUrl`) and for microphone
 * trust. [`acceptRecords`] is the only thing that may put a host in there.
 */
object DshHostRegistry {
  private val trustedLock = Any()
  private var trusted: Set<String> = emptySet()

  /**
   * The NetBird Cloud peer DNS domain in force, compiled from `config/fleet.json`
   * (`fleet_cloud_dns_domain`). Set by [acceptRecords]; empty before discovery,
   * which is safe because no page can be open yet.
   */
  @Volatile
  private var cloudDnsDomain: String = ""

  /** Zone names this app reads DSH entries from. */
  fun fleetZones(context: Context): Set<String> =
    context.resources.getStringArray(R.array.fleet_dsh_zones)
      .map { normalizeDnsName(it) }
      .filter { it.isNotEmpty() }
      .toSet()

  /**
   * The hosts discovery accepted. Empty until [`acceptRecords`] ran, which is
   * the safe default: a page or a microphone request cannot be authorized
   * before the control plane has said which hosts exist.
   */
  fun trustedHosts(): Set<String> = synchronized(trustedLock) { trusted }

  fun isTrustedHost(host: String?): Boolean =
    host?.trim()?.lowercase()?.let { it in trustedHosts() } == true

  /**
   * Keeps the DSH entries the fleet declares and returns them as the same JSON
   * array shape the bridge handed in. The accepted host names replace the
   * runtime trust set, so a machine that left the fleet stops being trusted on
   * the next refresh.
   */
  fun acceptRecords(context: Context, recordsJson: String, peerAddressesJson: String): String {
    val domain = context.getString(R.string.fleet_cloud_dns_domain)
    setCloudDnsDomain(domain)
    val (kept, accepted) = selectAcceptedDsh(
      recordsJson,
      peerAddressesJson,
      fleetZones(context),
      NetBirdRuntime.isCloudManagement(context),
      domain,
    )
    replaceTrustedHosts(accepted)
    return kept
  }

  /**
   * The whole acceptance decision, with the zone list and the peer set passed
   * in: the catalogue, the openable page and the microphone all read the same
   * answer, and it stays testable without an Android context.
   */
  internal fun selectAcceptedDsh(
    recordsJson: String,
    peerAddressesJson: String,
    fleetZones: Set<String>,
    cloudMode: Boolean = false,
    cloudDnsDomain: String = "",
  ): Pair<String, Set<String>> {
    val peers = parsePeerAddresses(peerAddressesJson)
    val records = runCatching { JSONArray(recordsJson) }.getOrNull() ?: JSONArray()
    val kept = JSONArray()
    val accepted = mutableSetOf<String>()
    for (index in 0 until records.length()) {
      val record = records.optJSONObject(index) ?: continue
      val canonical = acceptedDshName(
        type = record.optInt("type", 0),
        name = record.optString("name"),
        zone = record.optString("zone"),
        content = record.optString("content"),
        fleetZones = fleetZones,
        peerAddresses = peers,
        cloudMode = cloudMode,
        cloudDnsDomain = cloudDnsDomain,
      ) ?: continue
      kept.put(record)
      accepted.add(canonical)
    }
    return kept.toString() to accepted
  }

  internal fun replaceTrustedHosts(hosts: Set<String>) {
    synchronized(trustedLock) { trusted = hosts }
  }

  /**
   * Canonical DSH name for one DNS record, mirroring the client-side rule: a
   * record is qualified against its own zone (a name that already carries the
   * zone is kept as-is), and the internal netbird.selfhosted zone and zone-root
   * records are ignored.
   */
  fun canonicalRecordName(name: String, zone: String): String? {
    val normalizedZone = normalizeDnsName(zone)
    val normalizedName = normalizeDnsName(name)
    if (normalizedZone.isEmpty() || normalizedZone == "netbird.selfhosted") return null
    if (normalizedName.isEmpty() || normalizedName == normalizedZone) return null
    return if (normalizedName.endsWith(".$normalizedZone")) {
      normalizedName
    } else {
      "$normalizedName.$normalizedZone"
    }
  }

  /** Whether a zone belongs to NetBird Cloud rather than a self-hosted deployment. */
  internal fun isCloudZone(zone: String, cloudDnsDomain: String): Boolean {
    val domain = normalizeDnsName(cloudDnsDomain)
    return domain.isNotEmpty() && (zone == domain || zone.endsWith(".$domain"))
  }

  /** Records the configured cloud DNS domain for the permission guard. */
  internal fun setCloudDnsDomain(domain: String) {
    cloudDnsDomain = normalizeDnsName(domain)
  }

  /**
   * Whether a host is a NetBird Cloud peer name.
   *
   * Cloud entries are `<peer>.netbird.cloud`; the viewing layer still checks a
   * name shape before granting a device permission, and that shape differs
   * between the two deployments.
   */
  fun isCloudHost(host: String?): Boolean {
    val domain = cloudDnsDomain
    if (domain.isEmpty()) {
      return false
    }
    val normalized = normalizeDnsName(host ?: return false)
    return normalized.endsWith(".$domain")
  }

  /**
   * Returns the canonical name when one record is an acceptable fleet DSH
   * entry, otherwise null. One decision, used for every record, so the
   * catalogue, the openable page and the microphone cannot disagree.
   */
  internal fun acceptedDshName(
    type: Int,
    name: String,
    zone: String,
    content: String,
    fleetZones: Set<String>,
    peerAddresses: Set<String>,
    cloudMode: Boolean = false,
    cloudDnsDomain: String = "",
  ): String? {
    if (type != 1) return null
    val canonical = canonicalRecordName(name, zone) ?: return null
    if (cloudMode) {
      // Cloud peers answer under their own FQDN (`<peer>.netbird.cloud`). The
      // record names one peer of this network; the probe drops peers that do
      // not serve a DSH workspace, so phones and plain peers never reach the
      // machine list.
      val normalizedZone = normalizeDnsName(zone)
      if (!isCloudZone(normalizedZone, cloudDnsDomain) || !canonical.endsWith(".$normalizedZone")) {
        return null
      }
      // The network map may carry the name zone-relative (`peer-a`) or as the
      // FQDN (`peer-a.netbird.cloud`); both qualify to the same canonical name,
      // which must be exactly one peer label in front of the zone.
      val relative = canonical.removeSuffix(".$normalizedZone")
      if (relative.isEmpty() || relative.contains('.')) {
        return null
      }
      val address = content.trim().substringBefore('/')
      if (address.isEmpty() || address !in peerAddresses) return null
      return canonical
    }
    if (canonical.substringBefore('.') != "dsh") return null
    // The entry must live in a declared DSH zone. A retired per-machine zone
    // (`<machine>` with a bare `dsh` record) names the same machine but is not
    // the canonical authority any more, so it is not offered.
    if (fleetZones.none { canonical.endsWith(".$it") }) return null
    // A DSH name has a machine label between `dsh` and the zone, so a record
    // literally named `dsh` (which qualifies to `dsh.<zone>`) is not one.
    val remainder = canonical.removePrefix("dsh.")
    if (!remainder.contains('.')) return null
    val machine = remainder.substringBeforeLast('.')
    if (machine.isEmpty()) return null
    val address = content.trim().substringBefore('/')
    if (address.isEmpty() || address !in peerAddresses) return null
    return canonical
  }

  /**
   * Returns the normalized root URL when the address is exactly one accepted
   * DSH service, otherwise null. Anything else (another intranet name, public
   * host, raw IP, sub-path, non-default port, non-HTTP scheme) is refused.
   */
  fun registeredServiceUrl(rawUrl: String?): String? {
    if (rawUrl.isNullOrBlank()) return null
    val uri = runCatching { URI(rawUrl.trim()) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    val host = uri.host?.lowercase() ?: return null
    if (!isTrustedHost(host)) return null
    val path = uri.path.orEmpty()
    if (path.isNotEmpty() && path != "/") return null
    if (uri.query != null || uri.fragment != null) return null
    val defaultPort = when (scheme) {
      "http" -> uri.port == -1 || uri.port == 80
      else -> uri.port == -1 || uri.port == 443
    }
    if (!defaultPort) return null
    return "$scheme://$host/"
  }

  internal fun parsePeerAddresses(peerAddressesJson: String): Set<String> {
    val array = runCatching { JSONArray(peerAddressesJson) }.getOrNull() ?: return emptySet()
    val addresses = mutableSetOf<String>()
    for (index in 0 until array.length()) {
      val address = array.optString(index).trim().substringBefore('/')
      if (address.isNotEmpty()) addresses.add(address)
    }
    return addresses
  }

  private fun normalizeDnsName(value: String): String = value.trim().lowercase().trimEnd('.')
}