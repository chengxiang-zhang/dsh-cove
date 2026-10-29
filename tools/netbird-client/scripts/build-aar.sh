#!/usr/bin/env bash
# Rebuild android/app/libs/netbird-portal.aar from native/*.go.
#
# Why this needs a whole NetBird source tree: native/*.go imports
# client/internal/{auth,profilemanager} and client/iface/netstack, and Go only
# allows importing an internal package from inside the tree rooted at its
# parent. The binding package therefore has to be built as a package of the
# netbird module (client/portalbind), not as a standalone module.
#
# Pinned inputs, recovered from the shipped AAR rather than guessed:
#   go version -m android/app/libs/netbird-portal.aar's libgojni.so   -> go1.26.7,
#     golang.org/x/mobile v0.0.0-20260816165457-f98cc9b3c733
#   the same build info's dependency table (103 deps) matched against the
#     module proxy: netbird v0.78.1 (101/103 versions identical; wireguard-go
#     v0.0.0-20260628102922 and go-nat v0.0.0-20260821095157 pin the range
#     v0.78.0 <= x < v0.78.2)
#
# Local patches applied to the tree:
#   1. github.com/wlynxg/anet v0.0.5 -> ./.portal-build/anet with its two
#      //go:linkname lines to net.zoneCache and
#      golang.org/x/net/internal/socket.zoneCache removed. Go 1.26 deleted the
#      first symbol, and those caches are a pure optimization.
#   2. native/*.go -> client/portalbind/ (package name stays "portal", so the
#      generated Java API stays io.netbird.portal.Portal).
#   3. client/internal/stdnet: enumerate interfaces through anet instead of
#      net.Interfaces(). Android 11+ denies an ordinary app the NETLINK_ROUTE
#      bind and RTM_GETLINK that the standard library needs, so ICE gathered no
#      candidates at all on a phone (no host, no server-reflexive) and every
#      connection fell back to the relay. See patch_netbird_stdnet below.
#
# Usage:
#   scripts/build-aar.sh                 # build and replace the AAR
#   BUILD_DIR=~/nb-build scripts/build-aar.sh
#
# Requirements: Go 1.26.x, Android NDK 27.1.12297006, and gomobile/gobind built
# from golang.org/x/mobile at the version above (see install_toolchain below).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETBIRD_VERSION="${NETBIRD_VERSION:-v0.78.1}"
X_MOBILE_VERSION="${X_MOBILE_VERSION:-v0.0.0-20260816165457-f98cc9b3c733}"
ANET_VERSION_FALLBACK="v0.0.5"
NDK_VERSION="${NDK_VERSION:-27.1.12297006}"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/netbird-client-aar}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/$NDK_VERSION}"
OUT_AAR="${OUT_AAR:-$REPO_ROOT/android/app/libs/netbird-portal.aar}"

GO_BIN="${GO_BIN:-$(command -v go || echo /opt/homebrew/opt/go/bin/go)}"
GOBIN_DIR="${GOBIN_DIR:-$(dirname "$GO_BIN")/../bin}"
export ANDROID_HOME ANDROID_NDK_HOME
export PATH="$(dirname "$GO_BIN"):$HOME/go/bin:$PATH"

# The macOS default PATH often lacks the Homebrew Go, so fail with a fixable message.
if [ ! -x "$GO_BIN" ]; then
  echo "go not found; set GO_BIN (e.g. GO_BIN=/opt/homebrew/opt/go/bin/go)" >&2
  exit 1
fi
if [ ! -d "$ANDROID_NDK_HOME" ]; then
  echo "NDK not found at $ANDROID_NDK_HOME" >&2
  exit 1
fi

# gomobile binds by generating Java and shelling out to javac. Without a real
# JDK that fails only after the whole Go build, with "Unable to locate a Java
# Runtime" from deep inside gomobile. macOS ships /usr/bin/javac as a shim that
# prints exactly that, so its presence proves nothing: run it and check.
JAVAC_VERSION="$(javac -version 2>&1)" || {
  echo "no usable JDK for the gomobile javac step: $JAVAC_VERSION" >&2
  echo "  JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH=\$JAVA_HOME/bin:\$PATH $0" >&2
  exit 1
}

echo "==> toolchain"
"$GO_BIN" version
echo "    $JAVAC_VERSION"

install_toolchain() {
  if [ ! -x "$HOME/go/bin/gomobile" ] || [ ! -x "$HOME/go/bin/gobind" ]; then
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
[ -f go.mod ] || "$GO_BIN" mod init netbird-aar-build >/dev/null

echo "==> fetching netbird $NETBIRD_VERSION"
"$GO_BIN" mod download "github.com/netbirdio/netbird@$NETBIRD_VERSION"
MODCACHE="$("$GO_BIN" env GOMODCACHE)"

echo "==> staging source tree at $TREE"
rm -rf "$TREE"
cp -R "$MODCACHE/github.com/netbirdio/netbird@$NETBIRD_VERSION" "$TREE"
chmod -R u+w "$TREE"

ANET_VERSION="$(grep -oE 'wlynxg/anet v[^ ]+' "$TREE/go.mod" | head -1 | awk '{print $2}')"
ANET_VERSION="${ANET_VERSION:-$ANET_VERSION_FALLBACK}"
echo "==> patching anet $ANET_VERSION (go1.26 removed net.zoneCache)"
"$GO_BIN" mod download "github.com/wlynxg/anet@$ANET_VERSION"
mkdir -p "$TREE/.portal-build"
rm -rf "$TREE/.portal-build/anet"
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
grep -q 'wlynxg/anet => ./.portal-build/anet' "$TREE/go.mod" \
  || printf '\nreplace github.com/wlynxg/anet => ./.portal-build/anet\n' >> "$TREE/go.mod"

echo "==> patching netbird stdnet interface discovery (Android 11+ netlink restriction)"
python3 - "$TREE" <<'PY'
import pathlib
import sys

tree = pathlib.Path(sys.argv[1])
discover = tree / "client/internal/stdnet/discover_pion.go"
discover.write_text('''package stdnet

import (
	"github.com/pion/transport/v3"
	"github.com/wlynxg/anet"
)

type pionDiscover struct {
}

// iFaces enumerates the host interfaces through anet rather than through
// net.Interfaces().
//
// Android 11+ denies an ordinary app the NETLINK_ROUTE bind and the
// RTM_GETLINK request the standard library issues, so net.Interfaces() answers
// "route ip+net: netlinkrib: permission denied" there. The embedded client used
// to turn that failure into an empty interface list that it handed to ICE
// anyway, which left the phone with no local ICE candidate at all: no host and
// no server-reflexive candidate, so no direct path to any peer was ever
// attempted and every connection stayed on the relay. anet performs the same
// enumeration without the denied operations, and delegates to net.Interfaces()
// on every other platform.
func (d pionDiscover) iFaces() ([]*transport.Interface, error) {
	ifs := []*transport.Interface{}

	oifs, err := anet.Interfaces()
	if err != nil {
		return nil, err
	}

	for i := range oifs {
		ifc := transport.NewInterface(oifs[i])

		addrs, err := anet.InterfaceAddrsByInterface(&oifs[i])
		if err != nil {
			return nil, err
		}

		for _, addr := range addrs {
			ifc.AddAddress(addr)
		}

		ifs = append(ifs, ifc)
	}

	return ifs, nil
}
''')

stdnet = tree / "client/internal/stdnet/stdnet.go"
source = stdnet.read_text()
old = '''	if netstack.IsEnabled() {
		n.iFaceDiscover = pionDiscover{}
	} else {
		n.iFaceDiscover = newMobileIFaceDiscover(iFaceDiscover)
	}
	return n, n.UpdateInterfaces()
'''
new = '''	if netstack.IsEnabled() {
		n.iFaceDiscover = pionDiscover{}
	} else {
		n.iFaceDiscover = newMobileIFaceDiscover(iFaceDiscover)
	}
	// Returning this Net after a failed first enumeration handed ICE an
	// interface list that never became non-empty, silently disabling every
	// direct connection. Fail instead, so the caller falls back to pion's own
	// stdnet.
	if err := n.UpdateInterfaces(); err != nil {
		return nil, err
	}
	return n, nil
'''
if old not in source:
    raise SystemExit("netbird stdnet: NewNetWithDiscover no longer matches the patch anchor")
stdnet.write_text(source.replace(old, new, 1))

# The behaviour the patch protects is "discovery returns interfaces even where
# the netlink path is unavailable". A test pins it, so a NetBird bump that
# restores net.Interfaces() fails the build instead of silently returning the
# phone to relay-only.
(tree / "client/internal/stdnet/discover_pion_anet_test.go").write_text('''package stdnet

import "testing"

// TestPionDiscoverEnumeratesInterfaces pins the ICE interface enumeration to a
// source that works on Android, where net.Interfaces() is denied the netlink
// calls it needs. An empty result is not an error in the caller, it is an
// interface list of zero entries, which makes ICE gather no candidate at all.
func TestPionDiscoverEnumeratesInterfaces(t *testing.T) {
	ifaces, err := pionDiscover{}.iFaces()
	if err != nil {
		t.Fatalf("enumerate interfaces: %v", err)
	}
	if len(ifaces) == 0 {
		t.Fatal("no interfaces discovered: ICE would gather no candidates")
	}
}
''')
print("stdnet: interface discovery now goes through anet")
PY

echo "==> verifying the interface-discovery patch is in effect"
grep -q 'anet.Interfaces()' "$TREE/client/internal/stdnet/discover_pion.go" \
  || { echo "stdnet patch missing: discover_pion.go does not use anet" >&2; exit 1; }
grep -q 'Returning this Net after a failed first enumeration' "$TREE/client/internal/stdnet/stdnet.go" \
  || { echo "stdnet patch missing: NewNetWithDiscover still returns a failed Net" >&2; exit 1; }

echo "==> staging the binding package"
mkdir -p "$TREE/client/portalbind"
cp "$REPO_ROOT"/native/*.go "$TREE/client/portalbind/"

echo "==> build + unit tests"
cd "$TREE"
"$GO_BIN" build ./client/portalbind
"$GO_BIN" test ./client/portalbind
"$GO_BIN" test ./client/internal/stdnet -run TestPionDiscoverEnumeratesInterfaces -count=1

echo "==> gomobile bind"
mkdir -p "$(dirname "$OUT_AAR")"
# Only the two ABIs the app ships: arm64-v8a for devices, x86_64 for the
# acceptance emulator. The full ABI set doubles the committed AAR for nothing.
"$HOME/go/bin/gomobile" bind \
  -target=android/arm64,android/amd64 \
  -javapkg=io.netbird \
  -androidapi 24 \
  -o "$OUT_AAR" \
  ./client/portalbind

echo "==> wrote $OUT_AAR"
ls -la "$OUT_AAR"