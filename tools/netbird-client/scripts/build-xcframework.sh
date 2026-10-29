#!/usr/bin/env bash
# Build Portal.xcframework from native/*.go for the iOS app.
#
# The Android app binds the same Go package with gomobile into an .aar; iOS binds
# it into an .xcframework. Same source files, same pinned NetBird tree, same anet
# patch - the only difference is the gomobile target. Keeping that in one script
# means the two bindings cannot drift: a change to native/*.go that compiles for
# Android and not for iOS fails here, on a machine that can build both.
#
# Requirements: Go 1.26.x, Xcode (xcodebuild on PATH or DEVELOPER_DIR pointing at
# it), and gomobile/gobind built from the pinned golang.org/x/mobile. No JDK is
# needed: the javac step belongs to the Android target only.
#
# Usage:
#   scripts/build-xcframework.sh
#   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/build-xcframework.sh
#   BUILD_DIR=~/nb-build OUT=~/Portal.xcframework scripts/build-xcframework.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="$REPO_ROOT/native"
NETBIRD_VERSION="${NETBIRD_VERSION:-v0.78.1}"
X_MOBILE_VERSION="${X_MOBILE_VERSION:-v0.0.0-20260816165457-f98cc9b3c733}"
ANET_VERSION_FALLBACK="v0.0.5"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/netbird-client-xcframework}"
OUT="${OUT:-$REPO_ROOT/ios/Portal.xcframework}"

GO_BIN="${GO_BIN:-$(command -v go || echo /opt/homebrew/opt/go/bin/go)}"
GOBIN_DIR="${GOBIN_DIR:-$("$GO_BIN" env GOPATH)/bin}"
export PATH="$(dirname "$GO_BIN"):$GOBIN_DIR:$PATH"

if [ ! -x "$GO_BIN" ]; then
  echo "go not found; set GO_BIN (e.g. GO_BIN=/opt/homebrew/opt/go/bin/go)" >&2
  exit 1
fi

# Xcode, not just the Command Line Tools: gomobile links against the iOS SDK, and
# a host whose xcode-select points at /Library/Developer/CommandLineTools fails
# deep inside the linker with a message about missing SDKs. Name the real one.
if ! xcodebuild -version >/dev/null 2>&1; then
  if [ -d /Applications/Xcode.app/Contents/Developer ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "no usable Xcode: install it, or export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

echo "==> toolchain"
"$GO_BIN" version
xcodebuild -version | head -2 | sed 's/^/    /'

install_toolchain() {
  if [ ! -x "$GOBIN_DIR/gomobile" ] || [ ! -x "$GOBIN_DIR/gobind" ]; then
    echo "==> installing gomobile/gobind @ $X_MOBILE_VERSION"
    "$GO_BIN" install "golang.org/x/mobile/cmd/gomobile@$X_MOBILE_VERSION"
    "$GO_BIN" install "golang.org/x/mobile/cmd/gobind@$X_MOBILE_VERSION"
  fi
}
install_toolchain

mkdir -p "$BUILD_DIR"
WORK="$BUILD_DIR/work"
TREE="$BUILD_DIR/netbird-$NETBIRD_VERSION"
mkdir -p "$WORK"
cd "$WORK"
[ -f go.mod ] || "$GO_BIN" mod init netbird-xcframework-build >/dev/null

# A staged tree is reused when it is already there: re-staging costs minutes and
# the pin is in the path, so a different NETBIRD_VERSION gets its own directory.
if [ ! -f "$TREE/go.mod" ]; then
  echo "==> fetching netbird $NETBIRD_VERSION"
  "$GO_BIN" mod download "github.com/netbirdio/netbird@$NETBIRD_VERSION"
  MODCACHE="$("$GO_BIN" env GOMODCACHE)"
  rm -rf "$TREE"
  cp -R "$MODCACHE/github.com/netbirdio/netbird@$NETBIRD_VERSION" "$TREE"
  chmod -R u+w "$TREE"
fi

cd "$TREE"
ANET_VERSION="$(grep -oE 'wlynxg/anet v[^ ]+' go.mod | head -1 | awk '{print $2}')"
ANET_VERSION="${ANET_VERSION:-$ANET_VERSION_FALLBACK}"
if [ ! -d "$TREE/.portal-build/anet" ]; then
  echo "==> staging anet $ANET_VERSION (go1.26 removed net.zoneCache)"
  "$GO_BIN" mod download "github.com/wlynxg/anet@$ANET_VERSION"
  MODCACHE="$("$GO_BIN" env GOMODCACHE)"
  mkdir -p "$TREE/.portal-build"
  cp -R "$MODCACHE/github.com/wlynxg/anet@$ANET_VERSION" "$TREE/.portal-build/anet"
  chmod -R u+w "$TREE/.portal-build/anet"
  python3 - "$TREE/.portal-build/anet/interface_android.go" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
patched = (
    source.replace('//go:linkname zoneCache net.zoneCache\n', '')
    .replace('//go:linkname zoneCacheX golang.org/x/net/internal/socket.zoneCache\n', '')
)
if patched == source:
    print('anet: nothing to patch (already trimmed)')
open(path, 'w').write(patched)
PY
fi
grep -q 'wlynxg/anet => ./.portal-build/anet' go.mod \
  || printf '\nreplace github.com/wlynxg/anet => ./.portal-build/anet\n' >> go.mod

echo "==> staging the binding package"
mkdir -p "$TREE/client/portalbind"
cp "$NATIVE_DIR"/*.go "$TREE/client/portalbind/"

echo "==> build + unit tests"
"$GO_BIN" build ./client/portalbind
"$GO_BIN" test ./client/portalbind

echo "==> gomobile bind (ios + iossimulator)"
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
# `-tags netgo` is not a preference: iOS ships no libresolv, and Go's cgo resolver calls
# res_9_ninit/res_9_nsearch, so a framework built without it fails to link with
# "Undefined symbols for architecture arm64: _res_9_ninit". The pure-Go resolver does the
# same job inside the process, which is where this engine dials anyway.
"$GOBIN_DIR/gomobile" bind \
  -tags netgo \
  -target=ios,iossimulator \
  -o "$OUT" \
  ./client/portalbind

echo "==> wrote $OUT"
ls -la "$(dirname "$OUT")"
xcrun lipo -info "$OUT/ios-arm64/Portal.framework/Portal" 2>/dev/null || true