# Anywhere Work mobile client

English | [中文](README.zh.md)

Anywhere Work is a lightweight React Native app over one Go engine: the shipped phone build is the Android package (arm64-v8a; HarmonyOS devices can use it when they are APK-compatible), and an iOS build exists in `ios/` and is produced by the iOS release workflow - it is not distributed yet, because that needs an Apple distribution certificate and an upload. It embeds the NetBird userspace network stack so that only the app's own traffic enters the private NetBird overlay; the device is not connected to a general VPN.

This directory is part of the dsh-cove repository (tools/netbird-client). It pairs with [tools/dsh-netbird](../dsh-netbird/README.md): that directory manages the per-machine DSH exposure contract (`dsh.<machine>.netbird` entries, nginx topology, machine inventory in `machines.json`), while this app provides the mobile entry point that reaches those same machines over the overlay.

## Capabilities

- Sign-in against the NetBird management server. A self-hosted server answers with the PKCE authorization-code flow; NetBird Cloud answers with the device authorization flow, and the embedded client follows whichever flow the server offers. The identity is persisted and the app auto-connects at launch.
- The management server is choosable: an install whose fleet runs its own control plane sets that address on the login screen or the settings screen, and changing it drops the old enrollment and asks for sign-in against the new one.
- Only the registered machines' DSH services have an entry: the list, page opening, and page microphone share one registry; other intranet names, public hosts, and raw IPs are refused.
- In-page downloads with Range/206 resume.
- Bundled GeckoView engine renders the full DSH workspace page regardless of the device's system WebView version.
- The DSH page microphone uses the official voice input `0.2.0-rc.2`; the app only provides GeckoView page-recording permission, performs no recognition of its own, and has no top voice entry.
- Android foreground service keeps the NetBird connection alive in the background, across screen lock and process restart.
- Long work started from the phone reports back: while the connection runs, the foreground service polls each accepted machine's finished-run feed (`/api/dsh-notify/feed`, one pass per 45 seconds) and raises a single normal notification when a turn completed or failed. The channel, the notice and the switch are separate from the ongoing connection notification, and the switch (enabled by default) lives in Settings.
- In-app self-update from the public HTTPS update channel (download progress, install, silent startup check).
- The NetBird control plane is a screen of its own, reachable before sign-in from the login screen and after it from Settings: one address field, a way back to the compiled default, and a pre-flight probe that uses the phone's own network to check the address is a NetBird management server before it is saved.
- A stalled connection is never a dead end: the login connecting phase has an explicit timeout, and the service list names the failing stage (engine, management, proxy, identity), keeps retrying in the background, and always offers retry (which rebuilds the engine) and re-login.

## Repository layout

- `android/` and `ios/`: React Native platform projects.
- `src/`: shared app logic — netbird bridge, service discovery, updater, screens, WebView injections.
- `native/`: the Go package bound via gomobile into `android/app/libs/netbird-portal.aar` and, for iOS, into `ios/Portal.xcframework` by `scripts/build-xcframework.sh` (userspace NetBird client, loopback HTTP/CONNECT proxy, SSO, probing, downloads).
- `scripts/publish.sh`: publishes an APK plus version manifest to the in-network update channel (deploy action, run only with user approval).

## Building

The Android build runs on macOS for development and release. Requirements: Node.js >= 22.11, JDK 17 (JDK 21 also builds; `JAVA_HOME` must be exported, because the Gradle wrapper cannot locate a JDK by itself), and an Android SDK with platform 37, build-tools 37.0.0, and NDK 27.1.12297006 (installable via the Android commandline tools with `sdkmanager "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006" "platform-tools"`). The Gradle wrapper downloads Gradle 9.4.1 from the Tencent mirror (see `android/gradle/wrapper/gradle-wrapper.properties`), so no separate Gradle install is needed. Point `android/local.properties` at your SDK with `sdk.dir=/absolute/path/to/sdk`.

```bash
npm ci
npm run android   # debug assemble
./android/gradlew -p android :app:assembleDebug
```

The control plane a fresh install enrolls against is a build input, not a source literal: pass your own address and it is compiled in (`build.gradle` writes it into `BuildConfig.AW_MANAGEMENT_URL`, which `NetBirdRuntime` reads). The repository's fallback is the documentation placeholder, so a build without this property produces an install that has to be given an address in the app before it can sign in - and `scripts/publish.sh` refuses to publish such an APK on an update channel that advertises a different one.

```bash
./android/gradlew -p android :app:assembleRelease \
  -PawManagementUrl=https://netbird.<your-domain>:443
```

The debug APK is signed with the committed `android/app/debug.keystore`, matching the update channel's signature, so a debug build installs over an installed release without an uninstall. The `netbird-portal.aar` in `android/app/libs/` is the build input. `scripts/build-aar.sh` rebuilds it from `native/*.go` on a macOS machine: it pins NetBird `v0.78.1` (recovered from the shipped AAR's Go build info and dependency fingerprint), trims two `//go:linkname` targets that Go 1.26 removed, enumerates interfaces through `anet` instead of `net.Interfaces()` because Android 11+ denies an ordinary app the netlink calls the standard library makes (without that patch ICE gathers no candidate and every phone connection stays on the relay), and runs gomobile.

iOS builds from the same engine on a Mac with Xcode. The framework is built, not committed: `scripts/build-xcframework.sh` binds `native/*.go` with gomobile into `ios/Portal.xcframework`, about 235 MB across the device and simulator slices, which is why it stays out of the repository. It builds with `-tags netgo` because iOS ships no libresolv and Go's cgo resolver would otherwise fail to link. CocoaPods comes from the committed `Gemfile`; [ios-release.yml](../../.github/workflows/ios-release.yml) runs the same steps on a runner, builds the simulator app, and checks the version the built bundle carries.

```bash
npm ci
bash scripts/build-xcframework.sh      # gomobile bind -> ios/Portal.xcframework
bundle install && bundle exec pod install --project-directory=ios
xcodebuild -workspace ios/NetBirdPortal.xcworkspace -scheme NetBirdPortal \
  -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Signing is external by construction: the release workflow signs and uploads only when its secrets carry a distribution certificate, a provisioning profile and an App Store Connect key, and it says so in its log when they are absent. The control plane is a build input here too - the release substitutes `AWManagementURL` from a repository variable and reads the address back out of the built app - so a tag cannot ship an install that only knows the documentation placeholder.

Local smoke test on macOS: the `portal-test` AVD (API 35, arm64) boots headless with the Android emulator, then install the APK and confirm the login screen renders (`Anywhere Work`, subtitle `登录后接入你自己的机器工作区`, and a `登录` button). Note the launcher component: the applicationId is `com.anywherework.app` while the activity class keeps the `com.netbirdportal` namespace. This proves the app boots and the login screen renders; it does not exercise a real SSO login, which needs credentials the emulator does not have:

```bash
export ANDROID_SDK_ROOT=~/Library/Android/sdk
~/Library/Android/sdk/emulator/emulator -avd portal-test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot
~/Library/Android/sdk/platform-tools/adb -e install -r android/app/build/outputs/apk/release/app-release.apk
~/Library/Android/sdk/platform-tools/adb -e shell am start -n com.anywherework.app/com.netbirdportal.MainActivity
```

Two end-to-end instrumentation tests run on the emulator and should be run before any on-device debugging; both need a one-off setup key minted fleet-side first, since the group a key carries is the thing under test:

```bash
cd android && export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
# Discovery path for a brand-new peer: enrolment -> management stream -> network map -> accepted records -> reachable services
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.netbirdportal.NetBirdDiscoveryE2ETest \
  -Pandroid.testInstrumentationRunnerArguments.setupKey=<key with auto_groups=[ops]>
```

`NetBirdScopedVisibilityE2ETest` runs two identities in one pass and asserts that what a device sees is decided by its groups: `fleetKey` (`auto_groups=[ops]`) must see every machine and accept all 6 `dsh.*` entries, while `employeeKey` (`auto_groups=[u-employee-a]`) must report exactly its own machine in `peerAddresses` and accept exactly that one entry - even though it also received all six names. The member case needs one machine in `u-employee-a` and the fleet zone distributed to that group first (the measured run is recorded in [netbird-management.md](../dsh-netbird/netbird-management.md)).

`NetBirdSsoUrlTest` pins one thing: the URL `Portal.loginSSO` hands to the browser still targets the management host (currently the `netbird-cli` client with `redirect_uri=http://localhost:53000/` and `prompt=login`), so an identity-provider change cannot silently reroute the login flow.

```bash
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.netbirdportal.NetBirdScopedVisibilityE2ETest \
  -Pandroid.testInstrumentationRunnerArguments.fleetKey=<key with auto_groups=[ops]> \
  -Pandroid.testInstrumentationRunnerArguments.employeeKey=<key with auto_groups=[u-employee-a]> \
  -Pandroid.testInstrumentationRunnerArguments.fleetIps=<the 6 machines' overlay IPs, comma separated> \
  -Pandroid.testInstrumentationRunnerArguments.employeeMachineIp=<the member machine's overlay IP>
```

## Configuration

Addresses live in `src/fleetConfig.ts`: the APK carries only the bootstrap origins (public HTTPS `https://anywhere.example.com/fleet.json`, plus the overlay fallback `http://tx.vpn/fleet.json`) and reads `fleet.json` in the background at launch, falling back to those bootstrap origins when the fetch fails. Renaming a channel therefore needs no release.

- Update channel: public HTTPS `https://anywhere.example.com/` (APK, `version.json`, `fleet.json`), served by the network edge host (`nb-tx`; `203.0.113.10` is an example address from the documentation range) from the nginx virtual host owned by `anywhere.conf`, static root `/www/wwwroot/apk`, Range/206 supported. The same vhost answers the overlay names `tx` / `tx.vpn`, so a phone reaches it on plain WiFi and over the tunnel. Publish with `scripts/publish.sh`, which generates and uploads all three files and checks permissions and reachability.
  - Do not host this channel on a developer machine.
- LAN mirror (convenience only, never authoritative): the machine that runs `scripts/publish.sh` also refreshes `~/.dsh/netbird-apk/www` and serves it from its own address via the existing `apk.mac.conf` vhost (`http://<that-machine-lan-ip>:8088/AnywhereWork.apk`), so a phone on the same WiFi can pull the 248 MB file locally instead of over the internet. It cannot drift: publish refreshes and checks it from the same staged files, and the manifest it serves points the app back at the public channel for updates.
- The connect path runs no HTTP probe at all. Login only waits for the engine and a connected management stream (native `ensureServiceReady`, bounded), then wires the loopback proxy; real reachability is the service list's job, which probes every discovered service, retries, names the failing stage and offers retry/re-login. A name that has to resolve inside the userspace DNS stack must not sit on the login path.
- The management server is user-choosable. A fresh install enrolls against NetBird Cloud (`https://api.netbird.io:443`), so nobody has to run a control plane to use the app; a fleet that runs its own server picks it on the login or settings screen, which accepts an `https` origin with host and port only (`NetBirdServerAddress.kt` owns that rule). The choice is stored natively (`NetBirdServerPreferences.kt`) and wins over the compiled default. Saving a different address stops the connection and deletes the enrolled profile, so the app returns to sign-in and enrolls against the new control plane.
- Cloud mode needs the same exposure contract as a self-hosted entry, with the peer's own FQDN as the canonical authority: the machine answers on its overlay address port 80 under `<machine>.netbird.cloud`, and DSH is started with `--trusted-host <machine>.netbird.cloud`. Only machines that do so are listed; every other peer is probed and dropped.
- `managementUrl` in `src/fleetConfig.ts` is the fleet document's record of the control plane the channel publishes, not a runtime input: the address in force is always read from the native store. `NetBirdFleetDocumentSyncTest` holds the two equal.
- A channel for another control plane is published with `MANAGEMENT_URL=... ZONE=... scripts/publish.sh` (both are overridable, and the defaults are this fleet's), and the server side that has to match it - the zone name this app compiles, the IdP its sign-in uses, the per-machine exposure - is documented in [self-hosted.md](../dsh-netbird/self-hosted.md).
- One address ships compiled per platform: the default management server a fresh install enrolls against (Android: `BuildConfig.AW_MANAGEMENT_URL`, read by `NetBirdRuntime.kt`; iOS: `AWManagementURL` in `ios/NetBirdPortal/Info.plist`), which is NetBird Cloud unless a deployment passes its own. The self-hosted DSH zone name also stays compiled (Android: `res/values/fleet_dsh_zones.xml`; iOS: `AWFleetDshZones`), because a cleartext policy is a build-time resource on both; cloud mode needs no compiled zone because entries are peer FQDNs under `netbird.cloud`.
- Per-machine DSH inventory and exposure contract: [tools/dsh-netbird](../dsh-netbird/README.md).
- DSH entries are discovered, not compiled in. `Portal.listServices()` returns the network's DNS records and `Portal.peerAddresses()` the overlay addresses of its peers. On a self-hosted server a record is accepted only when it is a `dsh.<machine>` entry inside the fleet's own zone **and** points at one of those peers; on NetBird Cloud the client synthesizes one A record per peer from its peer table (the peer's own FQDN under `netbird.cloud`), accepts those that point at a peer of the network, and the reachability probe drops the peers that do not serve a DSH workspace; no custom DNS zone is needed there. The accepted hosts become the runtime trust set behind the catalogue, the openable page and microphone trust, so adding or renaming a machine is a NetBird-side change with no app release. `pnpm dsh-netbird:mobile-registry` (in `pnpm test:scripts`) fails if a self-hosted compiled zone drifts from `machines.json`.

## Security model

- Cleartext networking is denied by default on both platforms: Android's network security config and iOS's App Transport Security allow only the login loopback and the registered private NetBird zones over `http://` (the self-hosted zone plus `netbird.cloud`), and `pnpm dsh-netbird:mobile-registry` holds the self-hosted carriers to the zone `machines.json` declares.
- The trust set is what discovery accepted from the control plane, and it is empty until discovery has run: a cold process refuses to open or microphone-authorize any page. Because acceptance also requires the DNS answer to be a peer address of this network, a record cannot point the app outside the overlay it already lives in.
- GeckoView grants microphone access only to the current `dsh.*` page; camera, other origins, and cross-page requests are denied.
- The official DSH voice plugin owns recording, recognition, and draft insertion; the app does not read, store, or forward audio or transcripts.

## Known limitations

- An empty catalogue has two causes outside the app, both worth checking first: a newly enrolled peer that sits in no policy sees no peers at all (`peerAddresses=[]`, so nothing can be accepted), and the device's peer must be in the group its traffic needs. Groups reach a peer through its enrolling identity (`auto_groups` on the setup key or on the user), never through a broad `All`-sourced policy - that would hand every enrolled device the whole fleet and break per-user isolation. See [netbird-management.md](../dsh-netbird/netbird-management.md).
- In self-hosted mode the DSH entry zone is still compiled (`netbird`): a control plane that serves its `dsh.<machine>` records from another zone connects, but its catalogue stays empty. `pnpm dsh-netbird:mobile-registry` fails when either platform's carrier drifts from `machines.json`, so a rename cannot break one platform silently. Cloud mode has no such compiled zone, but it recognises only the default `netbird.cloud` peer domain: a cloud account that set a custom DNS domain connects, and its machine list stays empty until the domain is added to the build. The update channel and the bootstrap origins also remain this fleet's.
- The catalogue also waits out a short settle window (`CATALOGUE_SETTLE_TIMEOUT_MS`) because the network map arrives a second or two after the management stream connects; before that it listed nothing on a cold start until the user pulled to refresh.
- Official voice input is supported only on the primary GeckoView path; the emergency system-WebView fallback does not provide microphone recording.
- The iOS build is not distributed yet: it builds for the simulator and runs there (the login screen renders and the bridge answers with the compiled control plane), but nothing signs or uploads it until the release secrets carry an Apple certificate and profile. It also has no background poll for finished runs: that timer belongs to the Android foreground service, iOS has no equivalent, and a run that finishes while the app is closed is reported the next time it is opened. iOS also has no browser-level proxy override, so a page cannot be pointed at the loopback proxy the way Android's GeckoView and system WebView are; it has no in-app update path (updates arrive through TestFlight or the App Store, and the channel's APK manifest is not offered there); it has no GeckoView container, so the app's own `WKWebView` is used; and it has no foreground service, so the engine runs only while the app does.

## License

Apache-2.0.