/**
 * One release, one version, one build number - for every artifact a tag carries.
 *
 * A tag releases the runtime package, the macOS app and the Android APK together. Before
 * this gate each of them kept its own idea of "the version": the macOS app read a number
 * typed into its packaging contract on the first day, the APK carried 2.7.6 from a
 * numbering that started before it was this product, and neither moved when anything was
 * fixed. A person holding two installers could not tell which one was newer.
 *
 * The doctrine is two facts, derived rather than typed:
 *
 *   version     = the repository's released version (`packages/dsh-web-all/package.json`,
 *                 which `release.yml` cross-checks against the `vX.Y.Z` tag). Every
 *                 first-party manifest declares that same number - the shared modules and
 *                 both clients - so one
 *                 release never carries two answers to "which version is this".
 *   build       = the git commit count (the macOS bundle's CFBundleVersion and Android's
 *                 versionCode), so a rebuilt artifact is never mistaken for its predecessor
 *
 * This test is the gate that keeps them from drifting apart again.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const readJson = (path) => JSON.parse(read(path))

const RELEASED = readJson('packages/dsh-web-all/package.json').version

test('every first-party manifest declares the released version', () => {
  assert.match(RELEASED, /^\d+\.\d+\.\d+/, 'the released version is a plain semver')
  // Every manifest in the repository, not only the ones with a build step: a hand-written
  // number beside the release is a second answer to "which version is this", and it goes
  // stale the moment the release moves. The tag bumps them together.
  for (const [path, what] of [
    ['shared/package.json', 'the shared modules inlined into every bundle'],
    ['tools/anywhere-agent/package.json', 'the macOS app'],
    ['tools/netbird-client/package.json', 'the Android app'],
  ]) {
    assert.equal(readJson(path).version, RELEASED, what)
  }
})

test('the macOS app takes its version from the repository and its build from git', () => {
  const script = read('tools/anywhere-agent/scripts/package-mac.sh')
  assert.match(script, /packages\/dsh-web-all\/package\.json/, 'the released version is the source')
  assert.match(script, /rev-list --count HEAD/, 'the build number is the git commit count')
  assert.match(script, /CFBundleVersion "\$BUILD"/, 'macOS compares the build number, not the version')
  assert.doesNotMatch(script, /\['shell'\]/, 'the packaging contract is not a version source')
})

test('the Android app derives the same pair from the same two facts', () => {
  const gradle = read('tools/netbird-client/android/app/build.gradle')
  assert.match(gradle, /versionName awVersionName/, 'the version is derived, not typed')
  assert.match(gradle, /versionCode awVersionCode/, 'the build number is derived, not typed')
  assert.match(gradle, /packages\/dsh-web-all\/package\.json/, 'it reads the released version')
  assert.match(gradle, /'rev-list',\s*'--count',\s*'HEAD'/, 'and the git build number')
  // A wrong build number is not guessed: a tree without git has to be told the number.
  assert.match(gradle, /-PawVersionCode/, 'and says how to override it rather than inventing one')
  // A typed literal is the failure this gate exists for.
  assert.doesNotMatch(gradle, /versionName "2\./, 'no hand-typed product version')
})

test('the APK channel refuses a manifest that disagrees with the APK', () => {
  const publish = read('tools/netbird-client/scripts/publish.sh')
  assert.match(publish, /packages\/dsh-web-all\/package\.json/, 'the manifest version is the released one')
  assert.match(publish, /rev-list --count HEAD/, 'and the build number is the git count')
  assert.match(publish, /aapt2/, 'the APK is asked what it actually carries')
  // The phones only compare versionCode, so the manifest and the APK must not disagree:
  // that mismatch is how an installed app is told there is nothing to install.
  assert.match(publish, /the APK carries .* but this manifest would advertise/s, 'a mismatch stops the deploy')
})

test('both release workflows build the version their tag names', () => {
  const desktop = read('.github/workflows/desktop-release.yml')
  assert.match(desktop, /VERSION:\s*\$\{\{\s*github\.ref_name\s*\}\}/, 'the macOS app is pinned to the tag')
  assert.match(desktop, /VERSION#v/, 'and its leading v is stripped')

  const android = read('.github/workflows/android-release.yml')
  assert.match(android, /VERSION_NAME:\s*\$\{\{\s*github\.ref_name\s*\}\}/, 'the APK is pinned to the tag')
  assert.match(android, /-PawVersionName="\$\{VERSION_NAME#v\}"/, 'and handed to Gradle stripped')
  // The artifact gate reads the version out of the APK rather than out of a source file.
  assert.match(android, /aapt2" dump badging "\$APK"/, 'the APK is the source of truth for its own version')
  assert.match(android, /v\$\{VERSION_NAME\}" != "\$\{GITHUB_REF_NAME\}/, 'and it must agree with the tag')
})

test('the desktop workflow builds and pins the Windows installer too', () => {
  const desktop = read('.github/workflows/desktop-release.yml')
  // A second platform must not invent a second version: it takes the same tag and the
  // same commit count, and the artifact is named from both.
  assert.match(desktop, /windows-installer:/, 'the Windows job exists')
  assert.match(desktop, /runs-on: windows-2025/, 'and runs on Windows, where an installer can be built and run')
  assert.match(desktop, /ELECTRON_WIN_ZIP_SHA256:\s*'[0-9a-f]{64}'/, 'the win32 runtime is pinned by hash')
  assert.match(desktop, /ELECTRON_WIN_ZIP_BYTES:\s*'\d+'/, 'and by size, the rule the darwin pin follows')
  assert.match(desktop, /ELECTRON_WIN_ZIP_SHA256\) \{ throw/, 'a mismatch stops the build instead of shipping an unpinned runtime')
  // Signing is external for Windows too, and the step has to be guarded rather than
  // half-present: an unguarded one fails every release without a certificate, and a
  // signing step that never verifies its own output ships a broken signature silently.
  assert.match(desktop, /AW_WINDOWS_SIGNING:\s*\$\{\{\s*secrets\.AW_WINDOWS_SIGNING\s*\}\}/, 'the signing switch is a secret')
  assert.match(desktop, /if: env\.AW_WINDOWS_SIGNING == 'true'/, 'and the step only runs when it is set')
  assert.match(desktop, /-Filter signtool\.exe/, 'signtool is located on the runner')
  assert.match(desktop, /sign \/f \$pfx/, 'the installer is signed with the configured certificate')
  assert.match(desktop, /verify \/pa \$installer\.FullName/, 'and the signature is verified before it is published')

  // One report, after both installers: two jobs force-pushing the same orphan branch would
  // delete each other's file.
  assert.match(desktop, /needs: \[macos-installer, windows-installer\]/, 'the report waits for both')
  assert.equal((desktop.match(/git push --force origin ci-status\n/g) ?? []).length, 1, 'one push, one file')
})

test('the iOS project and workflow carry the same two facts as the other platforms', () => {
  // The version is a literal in the project because Xcode needs one, so a gate has to keep
  // it equal to the released version - which is exactly how the Android half avoids a
  // hand-typed number drifting away from the release.
  const project = read('tools/netbird-client/ios/NetBirdPortal.xcodeproj/project.pbxproj')
  const matches = project.match(/MARKETING_VERSION = ([^;]+);/g) ?? []
  assert.equal(matches.length, 2, 'both build configurations carry a marketing version')
  for (const match of matches) {
    assert.equal(match, `MARKETING_VERSION = ${RELEASED};`, 'and it is the released version')
  }
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.anywherework\.app;/, 'the iOS bundle id matches the Android applicationId')

  const ios = read('.github/workflows/ios-release.yml')
  assert.match(ios, /VERSION:\s*\$\{\{\s*github\.ref_name\s*\}\}/, 'the build is pinned to the tag')
  assert.match(ios, /MARKETING_VERSION="\$VERSION"/, 'and the marketing version is the tag')
  assert.match(ios, /CURRENT_PROJECT_VERSION="\$BUILD"/, 'with the commit count as the build number')
  assert.match(ios, /git rev-list --count HEAD/, 'which is where that number comes from')
  // The bundle is the source of truth for its own version, like the APK gate.
  assert.match(ios, /Print :CFBundleShortVersionString/, 'the built bundle is asked for its version')
  assert.match(ios, /the bundle says \$SHORT, the tag says \$VERSION/, 'and a mismatch fails the build')

  // The control plane a fresh install enrolls against is a build input on both phone
  // platforms: the source carries the documentation placeholder, and a release that
  // forgets to substitute it ships an app nobody can sign in to.
  assert.match(ios, /AW_MANAGEMENT_URL:\s*\$\{\{\s*vars\.AW_MANAGEMENT_URL\s*\}\}/, 'the address comes from a repository variable')
  assert.match(ios, /PlistBuddy -c "Set :AWManagementURL \$AW_MANAGEMENT_URL"/, 'and is written into the built app')
  assert.match(ios, /the app carries \$URL, the fleet variable says/, 'and read back out of it before the release')
})