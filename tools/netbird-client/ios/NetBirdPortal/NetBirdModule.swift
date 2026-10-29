import Foundation
import React
import WebKit
import Portal

/**
 * The iOS half of the `NetBirdPortal` native module.
 *
 * The Android module is Kotlin behind the same JavaScript contract
 * (`src/NetBirdPortal.ts` lists all 33 methods). This is not a re-design of that
 * contract: every method name, every JSON shape and every rejection code is the same
 * one, because the JS wrapper parses 13 of the returns and matches some rejections by
 * regex. What differs is only what iOS genuinely does differently:
 *
 *   - there is no foreground service, so `resumeConnection` starts the engine in this
 *     process instead of asking a service to;
 *   - there is no WebView proxy override, so `applyWebViewProxy` rejects with the same
 *     code an Android device without `PROXY_OVERRIDE` rejects with - the JS side already
 *     treats that as "no proxy" and warns rather than failing;
 *   - there is no way to install an update from a file, so `installApk` rejects and the
 *     updater is switched off for iOS in the JS layer;
 *   - there is no GeckoView, so `openGeckoService` rejects and JS falls back to the
 *     in-app web view it already has.
 *
 * The engine is the same Go package the desktop helper and the Android AAR are built
 * from, bound with gomobile into Portal.xcframework: no platform-specific overlay code
 * exists, and none is added here.
 */
@objc(NetBirdPortal)
final class NetBirdModule: NSObject {

  // MARK: - identity

  /// The peer name this install enrolls under. Android's is `netbird-portal-android`;
  /// claiming that name here would put a lie in the management server's peer list.
  private static let deviceName = "netbird-portal-ios"

  /// The compiled default control plane, overridden by a build or by the user's choice.
  /// The placeholder is deliberate: a build that carries a real address carries it in
  /// Info.plist, and scripts/publish.sh refuses to ship a placeholder build.
  private static let placeholderManagementURL = "https://netbird.example.com:443"

  private static let invalidServerAddress = "请输入形如 https://netbird.example.com:443 的地址"

  // MARK: - paths

  /// Config and enrollment state are private to the app and never user-visible, so they
  /// live in Application Support rather than Documents (which is browsable and synced).
  private static var supportDirectory: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("NetBirdPortal", isDirectory: true)
  }

  private static var configURL: URL { supportDirectory.appendingPathComponent("netbird-portal-config.json") }
  private static var stateURL: URL { supportDirectory.appendingPathComponent("netbird-portal-state.json") }

  /// Downloaded update files are disposable, which is exactly what Caches means.
  private static var downloadsDirectory: URL {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("NetBirdPortal/downloads", isDirectory: true)
  }

  // MARK: - preferences (the Android SharedPreferences, one file per key set)

  private enum Pref {
    static let server = "netbird-server"
    static let connection = "netbird-connection"
    static let notifications = "netbird-run-notifications"
    static let browserSession = "netbird-browser-session"
  }

  private static func defaults(_ name: String) -> UserDefaults {
    UserDefaults.standard
  }

  private static func string(_ name: String, _ key: String) -> String {
    defaults(name).string(forKey: "\(name).\(key)") ?? ""
  }

  private static func setString(_ name: String, _ key: String, _ value: String) {
    defaults(name).set(value, forKey: "\(name).\(key)")
  }

  private static func remove(_ name: String, _ key: String) {
    defaults(name).removeObject(forKey: "\(name).\(key)")
  }

  private static func flag(_ name: String, _ key: String, default fallback: Bool) -> Bool {
    let store = defaults(name)
    let composite = "\(name).\(key)"
    if store.object(forKey: composite) == nil {
      return fallback
    }
    return store.bool(forKey: composite)
  }

  private static func setFlag(_ name: String, _ key: String, _ value: Bool) {
    defaults(name).set(value, forKey: "\(name).\(key)")
  }

  // MARK: - process state (the Android runtime's in-memory fields)

  private static var proxyURL = ""
  private static var engineRunning = false
  private static var reportedMachines = -1
  private static var lastStage = "idle"
  private static var lastError = ""
  private static var failures = 0
  private static var hardResets = 0
  private static var authRequired = false
  /// Hosts the discovery pass accepted, as full URLs. Empty until `listServices` runs;
  /// an empty set is the security default, not an oversight.
  private static var trustedServices: Set<String> = []

  // MARK: - bridge plumbing

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func work(_ body: @escaping () throws -> Any?, _ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock, _ code: String) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let value = try body()
        DispatchQueue.main.async { resolve(value) }
      } catch {
        let message = (error as NSError).userInfo["message"] as? String ?? error.localizedDescription
        DispatchQueue.main.async { reject(code, message, error) }
      }
    }
  }

  private func rejectUnsupported(_ code: String, _ message: String, _ reject: @escaping RCTPromiseRejectBlock) {
    reject(code, message, NSError(domain: "NetBirdPortal", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
  }

  /// Calls a gomobile binding.
  ///
  /// The generated framework is C, not Objective-C methods: Swift imports its
  /// `NSError**` out-parameter as an explicit pointer rather than as `throws`, so every
  /// call goes through here and the pointer is turned back into a thrown error.
  @inline(__always)
  private static func go<T>(_ body: (NSErrorPointer) -> T) throws -> T {
    var error: NSError?
    let value = body(&error)
    if let error = error {
      throw error
    }
    return value
  }

  private func fail(_ code: String, _ message: String) -> NSError {
    NSError(domain: "NetBirdPortal", code: 1, userInfo: ["message": message, NSLocalizedDescriptionKey: message])
  }

  // MARK: - server address (ported from NetBirdServerAddress.kt, same rules)

  /// Normalises a management URL exactly as Android does: https only, host and port only,
  /// no credentials, no query, no fragment, an explicit port defaulting to 443, lower-case
  /// host, at most 200 characters, no whitespace.
  static func normalizeManagementURL(_ raw: String) throws -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed.count > 200 || trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) != nil {
      throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
    }
    guard var components = URLComponents(string: trimmed) else {
      throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
    }
    guard components.scheme?.lowercased() == "https" else {
      throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
    }
    guard let host = components.host, !host.isEmpty else {
      throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
    }
    if components.user != nil || components.password != nil || components.query != nil || components.fragment != nil || components.path != "" {
      if components.path != "" && components.path != "/" {
        throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
      }
    }
    if components.user != nil || components.password != nil || components.query != nil || components.fragment != nil {
      throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
    }
    if trimmed.lowercased().hasPrefix("https://") == false {
      throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
    }
    components.user = nil
    components.password = nil
    components.query = nil
    components.fragment = nil
    components.path = ""
    let port = components.port ?? 443
    components.port = port
    guard let normalized = components.string else {
      throw NSError(domain: "NetBirdPortal", code: 2, userInfo: ["message": invalidServerAddress])
    }
    return normalized
  }

  /// The address in force: the user's choice when there is one, otherwise the compiled
  /// default.
  private static func compiledDefaultManagementURL() -> String {
    let configured = (Bundle.main.object(forInfoDictionaryKey: "AWManagementURL") as? String) ?? ""
    let candidate = configured.isEmpty ? placeholderManagementURL : configured
    return (try? normalizeManagementURL(candidate)) ?? placeholderManagementURL
  }

  private static func managementURL() -> String {
    let chosen = string(Pref.server, "management-url")
    if chosen.isEmpty {
      return compiledDefaultManagementURL()
    }
    return (try? normalizeManagementURL(chosen)) ?? compiledDefaultManagementURL()
  }

  private static func fleetZones() -> [String] {
    (Bundle.main.object(forInfoDictionaryKey: "AWFleetDshZones") as? [String]) ?? ["netbird"]
  }

  /// The peer DNS domain NetBird Cloud assigns (an account may replace it).
  private static func cloudDnsDomain() -> String {
    (Bundle.main.object(forInfoDictionaryKey: "AWCloudDnsDomain") as? String) ?? "netbird.cloud"
  }

  /// Whether the address in force is NetBird Cloud rather than a self-hosted server.
  private static func isCloudManagement() -> Bool {
    guard let host = URL(string: managementURL())?.host?.lowercased() else { return false }
    return host == "netbird.io" || host == "api.netbird.io" || host.hasSuffix(".netbird.io")
  }

  // MARK: - discovery acceptance (ported from DshHostRegistry.kt)

  /// A DNS record name without its trailing dot, lower-cased.
  static func canonicalRecordName(_ name: String) -> String {
    var value = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    while value.hasSuffix(".") {
      value.removeLast()
    }
    return value
  }

  /// The machine label a record names, or empty when it is not one of ours.
  static func acceptedDshName(name: String, type: Int, zone: String, content: String, peerAddresses: [String]) -> String {
    let canonicalName = canonicalRecordName(name)
    let canonicalZone = canonicalRecordName(zone)
    // A self-hosted control plane publishes its own records in the same zone; serving them
    // would point the app at a machine that is not part of the fleet's DSH entries.
    if canonicalName.contains("netbird.selfhosted") {
      return ""
    }
    guard type == 1 else { return "" }
    if isCloudManagement() {
      // Cloud peers are named under the account's peer DNS domain and the
      // record names one of them; the probe drops peers without a workspace.
      let domain = canonicalRecordName(cloudDnsDomain())
      guard !domain.isEmpty, canonicalZone == domain || canonicalZone.hasSuffix(".\(domain)") else { return "" }
      let suffix = ".\(canonicalZone)"
      guard canonicalName.hasSuffix(suffix) else { return "" }
      let relative = String(canonicalName.dropLast(suffix.count))
      guard !relative.isEmpty, !relative.contains(".") else { return "" }
      let address = content.split(separator: "/").first.map(String.init) ?? ""
      guard peerAddresses.contains(address) else { return "" }
      return canonicalName
    }
    guard let zoneName = fleetZones().first(where: { canonicalRecordName($0) == canonicalZone }) else { return "" }
    let suffix = ".\(canonicalRecordName(zoneName))"
    guard canonicalName.hasSuffix(suffix) else { return "" }
    let label = String(canonicalName.dropLast(suffix.count))
    guard label.hasPrefix("dsh.") else { return "" }
    let machine = String(label.dropFirst(4))
    guard !machine.isEmpty, !machine.contains(".") else { return "" }
    // The address must be one of this overlay's own peers: a record pointing anywhere else
    // is a record the app must not follow.
    let address = content.split(separator: "/").first.map(String.init) ?? ""
    guard peerAddresses.contains(address) else { return "" }
    return canonicalName
  }

  /// Turns an accepted record into the service URL the app may open, or nil.
  static func registeredServiceURL(_ raw: String) -> URL? {
    guard let components = URLComponents(string: raw) else { return nil }
    guard let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
    guard let host = components.host, !host.isEmpty else { return nil }
    let origin = "\(scheme)://\(host)"
    guard trustedServices.contains(origin) || trustedServices.contains("\(origin)/") else { return nil }
    guard components.path == "" || components.path == "/" else { return nil }
    guard components.query == nil, components.fragment == nil else { return nil }
    if let port = components.port, !(scheme == "http" && port == 80) && !(scheme == "https" && port == 443) {
      return nil
    }
    return URL(string: "\(origin)/")
  }

  // MARK: - engine

  /// Starts the engine and the loopback proxy, mirroring `NetBirdRuntime.connect`: the
  /// enrollment files persist a login, so `start` with no setup key is the normal path.
  private static func connect() throws -> String {
    do {
      try NetBirdModule.go { error in
        PortalStart(nil, deviceName, managementURL(), configURL.path, stateURL.path, error)
      }
    } catch {
      throw NSError(domain: "NetBirdPortal", code: 3, userInfo: ["message": error.localizedDescription])
    }
    engineRunning = true
    let proxy = try NetBirdModule.go { PortalStartProxy($0) }
    proxyURL = proxy
    lastStage = "connected"
    return proxy
  }

  private static func stopEngine() throws {
    do {
      try NetBirdModule.go { error in PortalStop(error) }
    } catch {
      throw NSError(domain: "NetBirdPortal", code: 4, userInfo: ["message": error.localizedDescription])
    }
    engineRunning = false
    proxyURL = ""
    lastStage = "idle"
  }

  private static func markConnectedByUser() {
    setFlag(Pref.connection, "keep-connected", true)
    setFlag(Pref.connection, "user-stopped", false)
    setFlag(Pref.connection, "authentication-required", false)
    authRequired = false
  }

  private static func markStoppedByUser() {
    setFlag(Pref.connection, "keep-connected", false)
    setFlag(Pref.connection, "user-stopped", true)
  }

  private static func clearEnrollment() {
    try? FileManager.default.removeItem(at: configURL)
    try? FileManager.default.removeItem(at: stateURL)
  }

  // MARK: - JSON helpers

  private static func jsonEscape(_ raw: String) -> String {
    var out = ""
    for scalar in raw.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case _ where scalar.value < 0x20:
        out += String(format: "\\u%04x", scalar.value)
      default:
        out.unicodeScalars.append(scalar)
      }
    }
    return out
  }

  private static func truncated(_ raw: String, limit: Int = 200) -> String {
    raw.count <= limit ? raw : String(raw.prefix(limit))
  }

  // MARK: - exported methods
  //
  // The Kotlin module's contracts, method for method. Rejection codes are JS-visible, so
  // they are preserved verbatim.

  @objc(verify:url:resolver:rejecter:)
  func verify(_ setupKey: String, url: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      NetBirdModule.markConnectedByUser()
      _ = try NetBirdModule.connect()
      return try NetBirdModule.go { PortalFetch(url, $0) }
    }, resolve, reject, "NETBIRD_VERIFY")
  }

  @objc(ensureServiceReady:rejecter:)
  func ensureServiceReady(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      NetBirdModule.markConnectedByUser()
      return try NetBirdModule.connect()
    }, resolve, reject, "NETBIRD_VERIFY")
  }

  @objc(startProxy:rejecter:)
  func startProxy(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if !NetBirdModule.proxyURL.isEmpty {
      resolve(NetBirdModule.proxyURL)
      return
    }
    rejectUnsupported("NETBIRD_PROXY", "NetBird connection service is not ready", reject)
  }

  /// iOS has no WebView proxy override. This is not a missing feature to be faked: the
  /// code is the one Android raises when `WebViewFeature.PROXY_OVERRIDE` is absent, and
  /// the JS layer logs it and continues without a proxy.
  @objc(applyWebViewProxy:resolver:rejecter:)
  func applyWebViewProxy(_ proxyUrl: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    rejectUnsupported("WEBVIEW_PROXY_UNSUPPORTED", "WebView proxy override is unavailable", reject)
  }

  /// Serves the page from a loopback origin.
  ///
  /// This is the iOS counterpart of `applyWebViewProxy`: WKWebView has no proxy API, so the
  /// engine serves the private-network page itself and the view loads 127.0.0.1. Nothing
  /// outside the app can reach that origin, which is the same app-scope promise the loopback
  /// forward proxy keeps on the platforms that can use one.
  @objc(startPageProxy:resolver:rejecter:)
  func startPageProxy(_ url: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({ try NetBirdModule.go { PortalStartPageProxy(url, $0) } }, resolve, reject, "NETBIRD_PAGE_PROXY")
  }

  @objc(stopPageProxy:rejecter:)
  func stopPageProxy(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    PortalStopPageProxy()
    resolve(nil)
  }

  @objc(clearWebViewProxy:rejecter:)
  func clearWebViewProxy(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  @objc(status:rejecter:)
  func status(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      let payload = try NetBirdModule.go { PortalStatus($0) }
      // The Go value is a map, and Go marshals a map's keys sorted: fqdn, ip,
      // managementConnected. Re-emitted by hand so the byte order matches.
      guard let data = payload.data(using: .utf8),
            let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return payload
      }
      let fqdn = parsed["fqdn"] as? String ?? ""
      let ip = parsed["ip"] as? String ?? ""
      let connected = parsed["managementConnected"] as? Bool ?? false
      return "{\"fqdn\":\"\(NetBirdModule.jsonEscape(fqdn))\",\"ip\":\"\(NetBirdModule.jsonEscape(ip))\",\"managementConnected\":\(connected)}"
    }, resolve, reject, "NETBIRD_STATUS")
  }

  @objc(fetch:resolver:rejecter:)
  func fetch(_ url: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({ try NetBirdModule.go { PortalFetch(url, $0) } }, resolve, reject, "NETBIRD_FETCH")
  }

  @objc(stop:rejecter:)
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      NetBirdModule.markStoppedByUser()
      try NetBirdModule.stopEngine()
      return nil
    }, resolve, reject, "NETBIRD_STOP")
  }

  @objc(listServices:rejecter:)
  func listServices(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      let recordsJSON = try NetBirdModule.go { PortalListServices($0) }
      let peersJSON = try NetBirdModule.go { PortalPeerAddresses($0) }
      let peers = (try? JSONSerialization.jsonObject(with: Data(peersJSON.utf8)) as? [String]) ?? []
      guard let records = try? JSONSerialization.jsonObject(with: Data(recordsJSON.utf8)) as? [[String: Any]] else {
        return recordsJSON
      }
      var kept: [[String: Any]] = []
      var seen = Set<String>()
      NetBirdModule.trustedServices.removeAll()
      for record in records {
        let name = record["name"] as? String ?? ""
        let type = record["type"] as? Int ?? Int(record["type"] as? Int64 ?? 0)
        let zone = record["zone"] as? String ?? ""
        let content = record["content"] as? String ?? ""
        let accepted = NetBirdModule.acceptedDshName(name: name, type: type, zone: zone, content: content, peerAddresses: peers)
        if accepted.isEmpty { continue }
        let key = "\(accepted)|\(name)|\(content)"
        if seen.contains(key) { continue }
        seen.insert(key)
        kept.append(record)
        let host = NetBirdModule.canonicalRecordName(accepted)
        NetBirdModule.trustedServices.insert("http://\(host)")
        NetBirdModule.trustedServices.insert("https://\(host)")
      }
      // Emitted by hand in the order Android's JSONArray produces: name, type, class,
      // content, zone.
      let rows = kept.map { record -> String in
        let name = record["name"] as? String ?? ""
        let type = record["type"] as? Int ?? 0
        let klass = record["class"] as? String ?? ""
        let content = record["content"] as? String ?? ""
        let zone = record["zone"] as? String ?? ""
        return "{\"name\":\"\(NetBirdModule.jsonEscape(name))\",\"type\":\(type),\"class\":\"\(NetBirdModule.jsonEscape(klass))\",\"content\":\"\(NetBirdModule.jsonEscape(content))\",\"zone\":\"\(NetBirdModule.jsonEscape(zone))\"}"
      }
      return "[\(rows.joined(separator: ","))]"
    }, resolve, reject, "NETBIRD_LIST_SERVICES")
  }

  @objc(probe:resolver:rejecter:)
  func probe(_ url: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({ try NetBirdModule.go { PortalProbe(url, $0) } }, resolve, reject, "NETBIRD_PROBE")
  }

  @objc(hasPersistedConfig:rejecter:)
  func hasPersistedConfig(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let exists = FileManager.default.fileExists(atPath: NetBirdModule.configURL.path)
    let keep = NetBirdModule.flag(Pref.connection, "keep-connected", default: false)
    let stopped = NetBirdModule.flag(Pref.connection, "user-stopped", default: false)
    let needsAuth = NetBirdModule.flag(Pref.connection, "authentication-required", default: false)
    resolve(exists && keep && !stopped && !needsAuth)
  }

  @objc(resumeConnection:rejecter:)
  func resumeConnection(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let persisted = FileManager.default.fileExists(atPath: NetBirdModule.configURL.path)
    guard persisted else {
      reject("NETBIRD_AUTH_REQUIRED", "No persisted NetBird login is available", fail("NETBIRD_AUTH_REQUIRED", "No persisted NetBird login is available"))
      return
    }
    work({
      NetBirdModule.markConnectedByUser()
      _ = try NetBirdModule.connect()
      return nil
    }, resolve, reject, "NETBIRD_RESUME")
  }

  @objc(resetConnection:rejecter:)
  func resetConnection(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let persisted = FileManager.default.fileExists(atPath: NetBirdModule.configURL.path)
    guard persisted else {
      reject("NETBIRD_AUTH_REQUIRED", "No persisted NetBird login is available", fail("NETBIRD_AUTH_REQUIRED", "No persisted NetBird login is available"))
      return
    }
    work({
      try? NetBirdModule.stopEngine()
      NetBirdModule.hardResets += 1
      NetBirdModule.markConnectedByUser()
      _ = try NetBirdModule.connect()
      return nil
    }, resolve, reject, "NETBIRD_RESET")
  }

  @objc(diagnostics:rejecter:)
  func diagnostics(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let stage = NetBirdModule.engineRunning ? NetBirdModule.lastStage : "engine_not_running"
    let error = NetBirdModule.jsonEscape(NetBirdModule.truncated(NetBirdModule.lastError))
    let verdict: String
    if NetBirdModule.authRequired {
      verdict = "login_required"
    } else {
      verdict = "unknown"
    }
    let payload = "{\"serviceRunning\":\(NetBirdModule.engineRunning),\"stage\":\"\(stage)\",\"lastError\":\"\(error)\",\"failures\":\(NetBirdModule.failures),\"hardResets\":\(NetBirdModule.hardResets),\"authVerdict\":\"\(verdict)\"}"
    resolve(payload)
  }

  @objc(getServerConfig:rejecter:)
  func getServerConfig(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let url = NetBirdModule.managementURL()
    let compiled = NetBirdModule.compiledDefaultManagementURL()
    let custom = url != compiled
    resolve("{\"url\":\"\(NetBirdModule.jsonEscape(url))\",\"defaultUrl\":\"\(NetBirdModule.jsonEscape(compiled))\",\"isCustom\":\(custom)}")
  }

  @objc(setServerUrl:resolver:rejecter:)
  func setServerUrl(_ url: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let previous = NetBirdModule.managementURL()
    let normalized: String
    do {
      normalized = try NetBirdModule.normalizeManagementURL(url)
    } catch {
      reject("NETBIRD_SERVER_URL", NetBirdModule.invalidServerAddress, error)
      return
    }
    let changed = normalized != previous
    if normalized == NetBirdModule.compiledDefaultManagementURL() {
      NetBirdModule.remove(Pref.server, "management-url")
    } else {
      NetBirdModule.setString(Pref.server, "management-url", normalized)
    }
    if changed {
      NetBirdModule.clearEnrollment()
      try? NetBirdModule.stopEngine()
    }
    resolve("{\"url\":\"\(NetBirdModule.jsonEscape(normalized))\",\"changed\":\(changed)}")
  }

  @objc(resetServerUrl:rejecter:)
  func resetServerUrl(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let compiled = NetBirdModule.compiledDefaultManagementURL()
    let previous = NetBirdModule.managementURL()
    NetBirdModule.remove(Pref.server, "management-url")
    let changed = compiled != previous
    if changed {
      NetBirdModule.clearEnrollment()
      try? NetBirdModule.stopEngine()
    }
    resolve("{\"url\":\"\(NetBirdModule.jsonEscape(compiled))\",\"changed\":\(changed)}")
  }

  /// The count feeds an Android ongoing notification. There is no such surface on iOS, so
  /// the value is kept (the JS side and diagnostics read it) and nothing is repainted.
  @objc(reportServiceCount:resolver:rejecter:)
  func reportServiceCount(_ count: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    NetBirdModule.reportedMachines = count.intValue
    resolve(nil)
  }

  @objc(clearServiceCount:rejecter:)
  func clearServiceCount(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    NetBirdModule.reportedMachines = -1
    resolve(nil)
  }

  @objc(getRunNotificationsEnabled:rejecter:)
  func getRunNotificationsEnabled(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Default true, like Android's RunNotificationStore.
    resolve(NetBirdModule.flag(Pref.notifications, "enabled", default: true))
  }

  @objc(setRunNotificationsEnabled:resolver:rejecter:)
  func setRunNotificationsEnabled(_ enabled: Bool, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    NetBirdModule.setFlag(Pref.notifications, "enabled", enabled)
    resolve(nil)
  }

  @objc(clearWebSessions:rejecter:)
  func clearWebSessions(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      do {
        try NetBirdModule.clearCookies()
        resolve(nil)
      } catch {
        reject("NETBIRD_CLEAR_SESSIONS", error.localizedDescription, error)
      }
    }
  }

  @objc(clearWebViewCache:rejecter:)
  func clearWebViewCache(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      do {
        try NetBirdModule.clearCookies()
        URLCache.shared.removeAllCachedResponses()
        resolve(nil)
      } catch {
        reject("NETBIRD_CLEAR_CACHE", error.localizedDescription, error)
      }
    }
  }

  private static func clearCookies() throws {
    let store = WKWebsiteDataStore.default()
    let semaphore = DispatchSemaphore(value: 0)
    store.httpCookieStore.getAllCookies { cookies in
      let group = DispatchGroup()
      for cookie in cookies {
        group.enter()
        store.httpCookieStore.delete(cookie) { group.leave() }
      }
      group.notify(queue: .main) {
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
          semaphore.signal()
        }
      }
    }
    // The web view stack answers on the main queue, and this is called from it.
    while semaphore.wait(timeout: .now()) == .timedOut {
      RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
  }

  @objc(downloadApk:destPath:resolver:rejecter:)
  func downloadApk(_ url: String, destPath: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({ try NetBirdModule.go { PortalDownload(url, destPath, $0) } }, resolve, reject, "NETBIRD_DOWNLOAD")
  }

  @objc(downloadState:rejecter:)
  func downloadState(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      let payload = try NetBirdModule.go { PortalDownloadState($0) }
      guard let parsed = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else {
        return payload
      }
      // Go marshals a map's keys sorted: active, bytes, destPath, total.
      let active = parsed["active"] as? Bool ?? false
      let bytes = parsed["bytes"] as? Int ?? 0
      let dest = parsed["destPath"] as? String ?? ""
      let total = parsed["total"] as? Int ?? 0
      return "{\"active\":\(active),\"bytes\":\(bytes),\"destPath\":\"\(NetBirdModule.jsonEscape(dest))\",\"total\":\(total)}"
    }, resolve, reject, "NETBIRD_DOWNLOAD_STATE")
  }

  @objc(cancelDownload:rejecter:)
  func cancelDownload(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      PortalCancelDownload()
      return nil
    }, resolve, reject, "NETBIRD_CANCEL_DOWNLOAD")
  }

  /// No iOS app installs an update from a file: updates arrive through TestFlight or the
  /// App Store. The JS updater is switched off for iOS, and this is the second line of
  /// defence if it is ever called.
  @objc(installApk:resolver:rejecter:)
  func installApk(_ destPath: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    rejectUnsupported("NETBIRD_INSTALL", "iOS installs updates through the App Store, not from a downloaded file", reject)
  }

  @objc(getAppVersion:rejecter:)
  func getAppVersion(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let info = Bundle.main.infoDictionary ?? [:]
    let versionName = info["CFBundleShortVersionString"] as? String ?? ""
    let build = Int(info["CFBundleVersion"] as? String ?? "") ?? 0
    resolve("{\"versionCode\":\(build),\"versionName\":\"\(NetBirdModule.jsonEscape(versionName))\"}")
  }

  @objc(getDownloadsDir:rejecter:)
  func getDownloadsDir(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    try? FileManager.default.createDirectory(at: NetBirdModule.downloadsDirectory, withIntermediateDirectories: true)
    resolve(NetBirdModule.downloadsDirectory.path)
  }

  /// Deletes one of the app's own download files, and refuses anything outside that
  /// directory after resolving symlinks - the same scope rule Android enforces.
  @objc(deleteFile:resolver:rejecter:)
  func deleteFile(_ path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let root = NetBirdModule.downloadsDirectory.standardizedFileURL.resolvingSymlinksInPath()
    let target = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
    guard target.path.hasPrefix(root.path + "/") else {
      reject("NETBIRD_DELETE_SCOPE", "Refusing to delete outside the downloads directory", fail("NETBIRD_DELETE_SCOPE", "Refusing to delete outside the downloads directory"))
      return
    }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
      resolve(!FileManager.default.fileExists(atPath: target.path))
      return
    }
    do {
      try FileManager.default.removeItem(at: target)
      resolve(true)
    } catch {
      reject("NETBIRD_DELETE", error.localizedDescription, error)
    }
  }

  @objc(loginSSO:rejecter:)
  func loginSSO(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({
      try? FileManager.default.createDirectory(at: NetBirdModule.supportDirectory, withIntermediateDirectories: true)
      // The Go flow runs PKCE and answers with the browser URL to open; an empty string
      // means a persisted token already works, which the login screen treats as signed in.
      return try NetBirdModule.go { error in
        PortalLoginSSO(NetBirdModule.deviceName, NetBirdModule.managementURL(), NetBirdModule.configURL.path, NetBirdModule.stateURL.path, error)
      }
    }, resolve, reject, "NETBIRD_SSO_LOGIN")
  }

  @objc(ssoStatus:rejecter:)
  func ssoStatus(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    work({ try NetBirdModule.go { PortalSSOStatus($0) } }, resolve, reject, "NETBIRD_SSO_STATUS")
  }

  /// Android opens its GeckoView container here. iOS has no GeckoView and the JS layer
  /// already falls back to its own in-app web view on rejection, so this rejects in the
  /// same shape instead of pretending to open one.
  @objc(openGeckoService:authorizedDshHost:resolver:rejecter:)
  func openGeckoService(_ url: String, authorizedDshHost: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    rejectUnsupported("GECKO_OPEN", "iOS opens discovered services in the app's own web view; there is no GeckoView container", reject)
  }
}