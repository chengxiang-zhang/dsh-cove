#!/usr/bin/env bash
# Build the desktop tunnel helper (anywhere-tunnel) from the repo's own sources.
#
# The helper is the NetBird userspace client compiled into a small binary that
# speaks the JSON-lines protocol in tunnel/main.go. It replaces what the Android
# client does with gomobile: no NDK, no Java, no per-platform binding — three
# desktop platforms build the same binary.
#
# Why a whole NetBird source tree is needed: the binding package imports
# client/internal/{auth,profilemanager} and client/iface/netstack, and Go only
# lets an internal package be imported from inside the tree rooted at its parent.
# The binding therefore has to be built as a package of the netbird module, not
# as a standalone module. Same constraint and same pinned inputs as
# tools/netbird-client/scripts/build-aar.sh (netbird v0.78.1, recovered from the
# shipped AAR), minus gomobile.
#
# Local patches, both carried over from build-aar.sh:
#   1. github.com/wlynxg/anet v0.0.5 -> ./.portal-build/anet with its two
#      //go:linkname lines removed (Go 1.26 deleted the target symbols; the
#      caches are a pure optimization).
#   2. native/*.go -> client/portalbind/ (package name stays "portal").
#
# Usage:
#   tools/anywhere-agent/scripts/build-tunnel.sh
#   NETBIRD_TREE=~/nb-build/netbird OUT=~/bin/anywhere-tunnel tools/anywhere-agent/scripts/build-tunnel.sh
#   GOOS=linux GOARCH=amd64 tools/anywhere-agent/scripts/build-tunnel.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NATIVE_DIR="$REPO_ROOT/tools/netbird-client/native"
TUNNEL_DIR="$REPO_ROOT/tools/anywhere-agent/tunnel"
NETBIRD_VERSION="${NETBIRD_VERSION:-v0.78.1}"
ANET_VERSION_FALLBACK="v0.0.5"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/anywhere-agent}"
TREE="${NETBIRD_TREE:-$BUILD_DIR/netbird-$NETBIRD_VERSION}"
OUT="${OUT:-$BUILD_DIR/bin/anywhere-tunnel}"

GO_BIN="${GO_BIN:-$(command -v go || true)}"
if [ -z "$GO_BIN" ] && [ -x /opt/homebrew/opt/go/bin/go ]; then
  GO_BIN=/opt/homebrew/opt/go/bin/go
fi
if [ -z "$GO_BIN" ] || [ ! -x "$GO_BIN" ]; then
  echo "go not found; set GO_BIN (e.g. GO_BIN=/opt/homebrew/opt/go/bin/go)" >&2
  exit 1
fi

echo "==> toolchain"
"$GO_BIN" version

# Stage the tree only when it is not already there: a git checkout of the tag and
# a module-cache copy are both acceptable, and re-staging costs minutes.
if [ ! -f "$TREE/go.mod" ]; then
  echo "==> staging netbird $NETBIRD_VERSION at $TREE"
  mkdir -p "$BUILD_DIR/work"
  cd "$BUILD_DIR/work"
  [ -f go.mod ] || "$GO_BIN" mod init anywhere-tunnel-build >/dev/null
  "$GO_BIN" mod download "github.com/netbirdio/netbird@$NETBIRD_VERSION"
  MODCACHE="$("$GO_BIN" env GOMODCACHE)"
  rm -rf "$TREE"
  cp -R "$MODCACHE/github.com/netbirdio/netbird@$NETBIRD_VERSION" "$TREE"
  chmod -R u+w "$TREE"
fi

cd "$TREE"
ANET_VERSION="$(grep -oE 'wlynxg/anet v[^ ]+' go.mod | head -1 | awk '{print $2}')"
ANET_VERSION="${ANET_VERSION:-$ANET_VERSION_FALLBACK}"
echo "==> patching anet $ANET_VERSION (go1.26 removed net.zoneCache)"
"$GO_BIN" mod download "github.com/wlynxg/anet@$ANET_VERSION"
MODCACHE="$("$GO_BIN" env GOMODCACHE)"
if [ ! -d "$TREE/.portal-build/anet" ]; then
  mkdir -p "$TREE/.portal-build"
  cp -R "$MODCACHE/github.com/wlynxg/anet@$ANET_VERSION" "$TREE/.portal-build/anet"
  chmod -R u+w "$TREE/.portal-build/anet"
fi
python3 - "$TREE/.portal-build/anet/interface_android.go" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
patched = (source
    .replace('//go:linkname zoneCache net.zoneCache\n', '')
    .replace('//go:linkname zoneCacheX golang.org/x/net/internal/socket.zoneCache\n', ''))
print('anet: nothing to patch (already trimmed)' if patched == source else 'anet: linkname lines removed')
open(path, 'w').write(patched)
PY
grep -q 'wlynxg/anet => ./.portal-build/anet' go.mod \
  || printf '\nreplace github.com/wlynxg/anet => ./.portal-build/anet\n' >> go.mod

echo "==> staging the binding package and the helper"
mkdir -p "$TREE/client/portalbind/cmd/anywhere-tunnel"
cp "$NATIVE_DIR"/*.go "$TREE/client/portalbind/"
# fetchstatic.go joins the same package but is not part of the Android binding: it
# adds fetch-by-address, which only the desktop helper needs.
cp "$TUNNEL_DIR/fetchstatic.go" "$TREE/client/portalbind/"
cp "$TUNNEL_DIR/main.go" "$TREE/client/portalbind/cmd/anywhere-tunnel/main.go"

echo "==> build + unit tests"
"$GO_BIN" build ./client/portalbind

# A cross-built test binary cannot run on this host (`exec format error`), so the
# tests are run only when the target is the machine doing the building. That is a
# skip with a reason, not a failure.
# GOHOSTOS/GOHOSTARCH, not GOOS/GOARCH: `go env GOOS` reports the *requested* target,
# which is the variable being set here, so it could never detect a cross-build.
HOST_OS="$("$GO_BIN" env GOHOSTOS)"
HOST_ARCH="$("$GO_BIN" env GOHOSTARCH)"
TARGET_OS="${GOOS:-$HOST_OS}"
TARGET_ARCH="${GOARCH:-$HOST_ARCH}"
if [ "$TARGET_OS" = "$HOST_OS" ] && [ "$TARGET_ARCH" = "$HOST_ARCH" ]; then
  "$GO_BIN" test ./client/portalbind
else
  echo "    skipping tests: building for $TARGET_OS/$TARGET_ARCH on $HOST_OS/$HOST_ARCH"
fi

echo "==> writing $OUT"
mkdir -p "$(dirname "$OUT")"
HELPER_VERSION="${HELPER_VERSION:-dev}"
# -s -w -trimpath keep the shipped binary small (44.8 MB -> 29.9 MB); the stamped
# versions are what the agent checks before trusting the overlay, so they are
# recorded at build time rather than guessed at runtime.
"$GO_BIN" build \
  -trimpath \
  -ldflags "-s -w -X main.buildVersion=$HELPER_VERSION -X main.netbirdVersion=$NETBIRD_VERSION" \
  -o "$OUT" ./client/portalbind/cmd/anywhere-tunnel
ls -la "$OUT"
if [ "$TARGET_OS" = "$HOST_OS" ] && [ "$TARGET_ARCH" = "$HOST_ARCH" ]; then
  "$OUT" <<< '{"id":1,"cmd":"version"}'
else
  echo "    $OUT targets $TARGET_OS/$TARGET_ARCH and cannot run here"
fi