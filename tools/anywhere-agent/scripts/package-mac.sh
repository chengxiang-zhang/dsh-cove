#!/usr/bin/env bash
# Build Anywhere Work.app for macOS, ad-hoc signed.
#
# What this produces is a real, launchable application bundle: the Electron runtime,
# the shell and agent sources, the version contract, and the embedded engine binary,
# with every nested Mach-O signed and the signature verified afterwards.
#
# What it deliberately is not: a distributable release. Signing for distribution
# means a Developer ID certificate and notarisation, which the Electron documentation
# requires an Apple Developer account and Xcode for. An ad-hoc signature runs on this
# machine and nowhere else without the user overriding Gatekeeper, so the script
# reports exactly which gate rejected what instead of pretending otherwise.
#
# Usage:
#   scripts/package-mac.sh                       # build only
#   scripts/package-mac.sh --dmg                 # also write the installer .dmg
#   ELECTRON_DIST=/path/to/Electron.app scripts/package-mac.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/tools/anywhere-agent"
CONTRACT="$PACKAGE_DIR/packaging/version-contract.json"

ELECTRON_DIST="${ELECTRON_DIST:-$HOME/anywhere-poc/electron/node_modules/electron/dist/Electron.app}"
HELPER="${HELPER:-$HOME/.cache/anywhere-agent/bin/anywhere-tunnel}"
OUT="${OUT:-$PACKAGE_DIR/build}"
APP_NAME="Anywhere Work"
BUNDLE_ID="${BUNDLE_ID:-com.anywherework.desktop}"
MAKE_DMG=0

for arg in "$@"; do
  case "$arg" in
    --dmg) MAKE_DMG=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# The product version is the repository's released version, not a number typed into
# this tool: a tag carries the runtime package and this installer together, so one
# version has to name both. `VERSION` is overridable because the release workflow knows
# the tag it is building; locally the repository's own version is the honest answer.
#
# The build number is separate and comes from git, so every committed state produces a
# bundle macOS can tell apart from the one before it. Without it `CFBundleVersion` never
# moved, and a rebuilt app could be treated as the same version it replaced.
VERSION="${VERSION:-$(python3 -c "import json;print(json.load(open('$REPO_ROOT/packages/dsh-web-all/package.json'))['version'])")}"
BUILD="${BUILD:-$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo 0)}"
BUILD_LABEL="$BUILD"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  # Named, not hidden: a bundle built from a tree that is not a commit is a development
  # artifact, and the label is how a person sees that at a glance.
  BUILD_LABEL="$BUILD-dirty"
fi
APP="$OUT/$APP_NAME.app"

for required in "$ELECTRON_DIST" "$HELPER" "$CONTRACT"; do
  if [ ! -e "$required" ]; then
    echo "missing input: $required" >&2
    exit 1
  fi
done

# Rasterises one piece of brand artwork with the distribution's Electron.
#
# The artwork is part of the product surface, not decoration: a bundle whose .icns never
# got built shows the vendor's logo in the Dock, and a bundle whose tray image never got
# built shows nothing in the menu bar. Electron can fail to start (a GPU process that
# cannot initialise, a transient SIGTRAP while other Electron instances are running), so
# the render gets its own profile directory, no GPU, and a few attempts - and running out
# of attempts is an error here rather than a warning that lets the wrong icon ship.
# `ALLOW_VENDOR_ICON=1` is the deliberate opt-out for an environment that cannot render.
render_brand_art() {
  local svg="$1" out="$2" size="$3" attempt log data
  data="$(mktemp -d)/electron-render"
  for attempt in 1 2 3; do
    log="$(mktemp -d)/render-$attempt.log"
    if "$ELECTRON_DIST/Contents/MacOS/Electron" \
        --user-data-dir="$data" --disable-gpu --disable-gpu-sandbox --no-sandbox \
        "$PACKAGE_DIR/scripts/render-icon.cjs" "$svg" "$out" "$size" >"$log" 2>&1; then
      return 0
    fi
    cat "$log" >&2
    sleep 1
  done
  return 1
}

echo "==> staging $APP"
rm -rf "$APP"
mkdir -p "$OUT"
cp -R "$ELECTRON_DIST" "$APP"

echo "==> writing the app payload (version $VERSION, build $BUILD_LABEL)"
PAYLOAD="$APP/Contents/Resources/app"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD"
# The shell, the agent and the shared sources only: the acceptance scripts under
# poc/ are not part of the product and are not shipped.
cp -R "$PACKAGE_DIR/shell" "$PACKAGE_DIR/agent" "$PACKAGE_DIR/src" "$PAYLOAD/"
mkdir -p "$PAYLOAD/packaging"
cp "$CONTRACT" "$PAYLOAD/packaging/version-contract.json"
# The payload's own package.json is what the window reports as itself (`appIdentity`),
# and `build` is the half a person needs to tell two builds of one version apart.
cat > "$PAYLOAD/package.json" <<JSON
{
  "name": "anywhere-work",
  "productName": "Anywhere Work",
  "version": "$VERSION",
  "build": "$BUILD_LABEL",
  "private": true,
  "type": "module",
  "main": "shell/main.mjs"
}
JSON

# The address this build enrolls against, when the release supplies one. This is the same
# name the fleet's installer reads, and baking it in is what keeps a shipped app from
# falling back to a placeholder that does not resolve: a person who opens the app is not
# asked where the fleet is, because the build already knows. A build without it is not
# broken - it asks through the server field - so an empty value is reported, not fatal.
if [ -n "${AW_MANAGEMENT_URL:-}" ]; then
  printf '{\n  "managementUrl": "%s"\n}\n' "$AW_MANAGEMENT_URL" > "$PAYLOAD/endpoint.json"
  echo "==> endpoint baked into the bundle"
else
  echo "==> no endpoint baked in (AW_MANAGEMENT_URL was empty): this build asks for one"
fi

# A licence obligation, not a nicety: the notices travel with the binary whose
# modules they describe.
if [ -f "$PACKAGE_DIR/THIRD_PARTY_NOTICES.md" ]; then
  echo "==> shipping third-party notices"
  cp "$PACKAGE_DIR/THIRD_PARTY_NOTICES.md" "$PAYLOAD/THIRD_PARTY_NOTICES.md"
else
  echo "warning: THIRD_PARTY_NOTICES.md is missing; run scripts/third-party-notices.mjs" >&2
fi

# The vendor runtime carries its own licences (Electron under MIT, Chromium with
# the third-party notice bundle). They are distribution obligations of the app
# just like the engine notices, so they travel inside the bundle.
for licence in LICENSE LICENSES.chromium.html; do
  if [ -f "$ELECTRON_DIST/Contents/Resources/$licence" ]; then
    cp "$ELECTRON_DIST/Contents/Resources/$licence" "$PAYLOAD/$licence"
  else
    echo "warning: $licence is missing from the Electron runtime" >&2
  fi
done

echo "==> embedding the engine"
mkdir -p "$APP/Contents/Resources/bin"
cp "$HELPER" "$APP/Contents/Resources/bin/anywhere-tunnel"
chmod 755 "$APP/Contents/Resources/bin/anywhere-tunnel"

# The app icon comes from the brand's own artwork, rasterised at packaging time. The
# alternative was leaving Electron's logo in the Dock, which is the vendor's brand, not
# the product's.
echo "==> building the app icon from the brand artwork"
# The full-bleed icon the brand pipeline generates: a square whose corners the system
# masks. Using the canvas-sized favicon here would pre-round the corners and get masked
# twice, which is why the Dock showed something that did not look like the brand.
ICON_SOURCE="$PACKAGE_DIR/icons/app-icon.svg"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
icon_ok=0
if [ -f "$ICON_SOURCE" ]; then
  if render_brand_art "$ICON_SOURCE" "$ICONSET/icon-1024.png" 1024; then
    for spec in "16 16" "32 32" "64 32" "128 128" "256 256" "512 256" "512 512" "1024 512"; do
      set -- $spec
      sips -z "$1" "$1" "$ICONSET/icon-1024.png" --out "$ICONSET/icon_${2}x${2}$([ "$1" != "$2" ] && echo '@2x').png" >/dev/null
    done
    if iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null; then
      # The same artwork as a plain PNG: the running app sets its Dock tile from this, so
      # what the Dock shows does not depend on any icon cache being warm.
      cp "$ICONSET/icon-1024.png" "$APP/Contents/Resources/AppIcon.png"
      icon_ok=1
      echo "  icon: built from app-icon.svg"
    else
      echo "iconutil could not build the icns from $ICONSET" >&2
    fi
  else
    echo "could not rasterise $ICON_SOURCE" >&2
  fi
else
  echo "missing artwork: $ICON_SOURCE" >&2
fi
if [ "$icon_ok" -ne 1 ]; then
  # The alternative is Electron's logo in the Dock, which is the vendor's brand, not the
  # product's - so a build that cannot produce the icon is a broken build, not a warning.
  # The opt-out exists for an environment that genuinely cannot start a renderer.
  if [ "${ALLOW_VENDOR_ICON:-0}" = "1" ]; then
    echo "  warning: continuing without the product icon (ALLOW_VENDOR_ICON=1)" >&2
  else
    echo "error: no product icon; refusing to build a bundle that would ship the vendor's logo" >&2
    echo "       set ALLOW_VENDOR_ICON=1 to build one anyway" >&2
    exit 1
  fi
fi

echo "==> rewriting Info.plist"
PLIST="$APP/Contents/Info.plist"
plist_set() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}
plist_set CFBundleName "$APP_NAME"
plist_set CFBundleDisplayName "Anywhere Work"
plist_set CFBundleIdentifier "$BUNDLE_ID"
plist_set CFBundleShortVersionString "$VERSION"
# The build number, not the version: this is the field macOS compares to decide whether
# a bundle is newer than the one it replaces. Equal values are how a rebuilt app was
# silently treated as the same app.
plist_set CFBundleVersion "$BUILD"
plist_set LSMinimumSystemVersion "12.0"
plist_set NSHumanReadableCopyright ""
# The menu bar icon: the same mark, as a template image (macOS tints it from its alpha,
# so the brand's colours are not used there and it reads correctly on either menu bar).
MARK_SOURCE="$PACKAGE_DIR/../../tools/dsh-netbird/brand/dashboard/logo-mark.svg"
if [ -f "$MARK_SOURCE" ] && [ -f "$APP/Contents/MacOS/Electron" ]; then
  TRAY_MASTER="$(mktemp -d)/tray-master.png"
  if render_brand_art "$MARK_SOURCE" "$TRAY_MASTER" 256; then
    sips -z 18 18 "$TRAY_MASTER" --out "$APP/Contents/Resources/trayTemplate.png" >/dev/null
    sips -z 36 36 "$TRAY_MASTER" --out "$APP/Contents/Resources/trayTemplate@2x.png" >/dev/null
    echo "  tray: built from logo-mark.svg"
  elif [ "${ALLOW_VENDOR_ICON:-0}" = "1" ]; then
    echo "  warning: continuing without the menu bar icon (ALLOW_VENDOR_ICON=1)" >&2
  else
    echo "error: could not rasterise the menu bar mark; refusing to build a bundle without it" >&2
    echo "       set ALLOW_VENDOR_ICON=1 to build one anyway" >&2
    exit 1
  fi
fi

# Point the bundle at the product's icon, and drop the runtime's own so nothing can
# fall back to the vendor's logo.
if [ -f "$APP/Contents/Resources/AppIcon.icns" ]; then
  plist_set CFBundleIconFile "AppIcon"
  rm -f "$APP/Contents/Resources/electron.icns"
fi

# Ad-hoc signing, inside out. Apple's guidance is to sign nested code before the
# bundle that contains it, so every Mach-O is signed deepest-first and the app is
# signed last. `--deep` would hide which nested binary failed.
# A bundle that cannot resolve its own imports is not a bundle. This gate is what
# caught the shell importing a build script through a repository-relative path:
# that resolves in a checkout and dies inside the app.
echo "==> checking that every relative import resolves inside the payload"
node "$PACKAGE_DIR/scripts/check-payload-imports.mjs" "$PAYLOAD" | sed 's/^/  /'

echo "==> signing (ad-hoc)"
sign_one() {
  codesign --force --sign - "$1" >/dev/null 2>&1 || {
    echo "  failed to sign $1" >&2
    return 1
  }
}
find "$APP/Contents" -type f -print0 \
  | xargs -0 file \
  | grep "Mach-O" \
  | cut -d: -f1 \
  | awk '{ print gsub(/\//, "/"), $0 }' \
  | sort -rn \
  | cut -d' ' -f2- \
  | while IFS= read -r binary; do
      sign_one "$binary"
    done
sign_one "$APP"

echo "==> verifying"
if codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -2; then
  echo "  signature verifies"
else
  echo "  signature did NOT verify" >&2
  exit 1
fi

# The bundle's identity, read back from the artifact itself rather than trusted from the
# steps above: a build that says it has the product icon but ships `electron.icns` is how
# the Dock ends up showing the vendor's logo, and nothing later in this script would
# notice. Every one of these is a failure, because all of them are visible to the person
# who installs the build.
echo "==> verifying the bundle's identity"
IDENTITY_FAILURES=0
check_identity() {
  if [ "$2" = "$3" ]; then
    echo "  ok   $1: $3"
  else
    echo "  FAIL $1: got '$2', want '$3'" >&2
    IDENTITY_FAILURES=$((IDENTITY_FAILURES + 1))
  fi
}
check_identity "CFBundleIconFile" \
  "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP/Contents/Info.plist" 2>/dev/null || true)" \
  "AppIcon"
check_identity "AppIcon.icns present" \
  "$([ -s "$APP/Contents/Resources/AppIcon.icns" ] && echo yes || echo no)" "yes"
check_identity "AppIcon.png present" \
  "$([ -s "$APP/Contents/Resources/AppIcon.png" ] && echo yes || echo no)" "yes"
check_identity "no vendor icon left" \
  "$([ -e "$APP/Contents/Resources/electron.icns" ] && echo present || echo absent)" "absent"
check_identity "AppIcon.icns is not the runtime's icon" \
  "$([ -s "$APP/Contents/Resources/AppIcon.icns" ] && [ "$(shasum -a 256 "$APP/Contents/Resources/AppIcon.icns" | cut -d' ' -f1)" = "$(shasum -a 256 "$ELECTRON_DIST/Contents/Resources/electron.icns" | cut -d' ' -f1)" ] && echo same || echo different)" \
  "different"
if [ -f "$PACKAGE_DIR/../../tools/dsh-netbird/brand/dashboard/logo-mark.svg" ]; then
  check_identity "menu bar mark present" \
    "$([ -s "$APP/Contents/Resources/trayTemplate.png" ] && echo yes || echo no)" "yes"
fi
if [ "$IDENTITY_FAILURES" -ne 0 ]; then
  echo "error: the bundle would show the wrong icon; refusing to ship it" >&2
  exit 1
fi

# Expected to fail for an ad-hoc build; recorded so nobody reads it as a bug.
echo "==> Gatekeeper assessment (an ad-hoc build is expected to be rejected)"
spctl --assess --type execute --verbose=2 "$APP" 2>&1 | sed 's/^/  /' || true

echo "==> payload"
du -sh "$APP" | sed 's/^/  /'
ls -1 "$APP/Contents/Resources/app" | sed 's/^/  app\//'

if [ "$MAKE_DMG" = "1" ]; then
  DMG="$OUT/$APP_NAME-$VERSION-$BUILD_LABEL.dmg"
  echo "==> writing $DMG"
  # The installer has its own owner: the Applications shortcut, the install notes, the
  # window arrangement and the background belong to make-dmg.sh, which renders the
  # background from the brand tokens and then verifies the result by mounting it. This
  # script's only job here is to hand over what it built.
  bash "$PACKAGE_DIR/scripts/make-dmg.sh" \
    --app "$APP" \
    --out "$DMG" \
    --electron "$ELECTRON_DIST/Contents/MacOS/Electron"
fi

echo "==> built $APP"