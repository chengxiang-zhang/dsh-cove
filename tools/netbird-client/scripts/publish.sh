#!/usr/bin/env bash
# Publish the Anywhere Work APK, version manifest and fleet config to the update
# channel on the network edge.
#
# The channel is served by the nginx vhost `apk.conf` on the edge host
# (REMOTE_HOST, static root REMOTE_ROOT) under three names:
#
#   https://anywhere.example.com/   public HTTPS - phones on ordinary WiFi,
#                                      no NetBird, and no cleartext exception
#   http://100.64.0.20/ , http://tx.vpn/ , http://tx/
#                                      overlay names for the same root, so the
#                                      app's bootstrap fallback and an operator
#                                      curl can reach it inside the tunnel
#
# It is deliberately NOT hosted on a developer machine: the previous channel was
# an `apk.dl-dev` vhost on a laptop, and when that DNS zone was retired the
# address stayed compiled into the APK, where it blocked both the update check
# and every connect. Nothing here may depend on a laptop being awake.
#
# Note there is no liveness probe URL in fleet.json any more. Connect gated on a
# fetch through the embedded netstack twice and failed both times, because that
# resolver does not answer the names it was given; reachability is the service
# list's job now.
#
# The desktop client channel (install.sh plus the mirrored NetBird archives on
# the same vhost) lives in its own root, /www/wwwroot/client, served from
# /install.sh and /client/. Keep the two roots separate: this script replaces
# REMOTE_ROOT atomically and would delete the installer. It is published by
# `pnpm dsh-netbird:client-publish` (see tools/dsh-netbird/netbird-management.md).
#
# Run from the project root. Deploy action - run only with user approval.
#
# NOTE: this release renames the package to com.anywherework.app. An install of
# the old com.netbirdportal app is NOT replaced by an update - Android treats a
# different applicationId as a different app. Old installs have to be removed
# by hand.
set -euo pipefail

APK_SRC="${1:-android/app/build/outputs/apk/release/app-release.apk}"
APK_NAME="${APK_NAME:-AnywhereWork.apk}"
# The version this manifest advertises is derived from the same two facts the APK is built
# from (build.gradle reads them the same way): the repository's released version and the git
# commit count. The caller may override both explicitly with VERSION_NAME / VERSION_CODE.
#
# The check below is the point: a channel whose manifest disagrees with the APK it points at
# is how installed phones are told there is nothing to install. Whenever aapt2 is around the
# two are compared, and a mismatch stops the deploy instead of publishing it.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
VERSION_NAME="${VERSION_NAME:-$(python3 -c "import json;print(json.load(open('$REPO_ROOT/packages/dsh-web-all/package.json'))['version'])")}"
VERSION_CODE="${VERSION_CODE:-$(git -C "$REPO_ROOT" rev-list --count HEAD)}"
NOTES="${NOTES:-连接路径不再做任何 HTTP 存活探测：登录只等引擎与管理端就绪，真实连通性由服务列表页逐服务探测、重试并给出原因；通道与清单在公网 HTTPS，包内只留引导地址。}"

# The channel defaults are the same config the clients are rendered from
# (`config/fleet.json` via scripts/render-fleet-config.mjs); overriding them here
# is how a deployment publishes a channel that matches its own build.
FLEET_CONFIG_RENDER="$REPO_ROOT/scripts/render-fleet-config.mjs"
PUBLIC_BASE="${PUBLIC_BASE:-$(node "$FLEET_CONFIG_RENDER" --get updateBaseUrl)}"
OVERLAY_BASE="${OVERLAY_BASE:-$(node "$FLEET_CONFIG_RENDER" --get overlayUpdateBaseUrl)}"
MANAGEMENT_URL="${MANAGEMENT_URL:-$(node "$FLEET_CONFIG_RENDER" --get managementUrl)}"
ZONE="${ZONE:-$(node "$FLEET_CONFIG_RENDER" --get zone)}"

REMOTE_HOST="${REMOTE_HOST:-nb-tx}"
REMOTE_ROOT="${REMOTE_ROOT:-/www/wwwroot/apk}"
REMOTE_STAGE="${REMOTE_STAGE:-${REMOTE_ROOT}.staging}"

[ -f "$APK_SRC" ] || { echo "APK not found: $APK_SRC"; exit 1; }
echo "==> versionCode=$VERSION_CODE versionName=$VERSION_NAME"
echo "==> SHA-256: $(shasum -a 256 "$APK_SRC" | cut -d' ' -f1)"

# The APK is the artifact that matters, so when aapt2 can read it, its answer is the one
# that must match the manifest. Without aapt2 the deploy can still proceed, loudly.
AAPT2="${AAPT2:-}"
if [ -z "$AAPT2" ]; then
  SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  if [ -n "$SDK" ] && [ -x "$SDK/build-tools/$(ls "$SDK/build-tools" 2>/dev/null | sort -V | tail -1)/aapt2" ]; then
    AAPT2="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)/aapt2"
  fi
fi
if [ -n "$AAPT2" ] && [ -x "$AAPT2" ]; then
  # Read the whole badging dump and keep its first line; do not pipe through
  # `head -1`. This script runs under `set -o pipefail`, and aapt2 keeps writing
  # after head exits, so that pipeline ends 141 (SIGPIPE) and takes the deploy
  # down before anything is staged - which is why this gate had never actually
  # run. A dump aapt2 cannot produce leaves BADGING empty, and the comparison
  # below then refuses the deploy, which is the answer we want anyway.
  BADGING_ALL="$("$AAPT2" dump badging "$APK_SRC" 2>/dev/null || true)"
  BADGING="${BADGING_ALL%%$'\n'*}"
  APK_CODE="$(printf '%s' "$BADGING" | sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p")"
  APK_NAME_IN_APK="$(printf '%s' "$BADGING" | sed -nE "s/.*versionName='([^']+)'.*/\1/p")"
  if [ "$APK_CODE" != "$VERSION_CODE" ] || [ "$APK_NAME_IN_APK" != "$VERSION_NAME" ]; then
    echo "the APK carries $APK_NAME_IN_APK ($APK_CODE) but this manifest would advertise $VERSION_NAME ($VERSION_CODE)" >&2
    echo "rebuild the APK from this commit, or pass VERSION_NAME/VERSION_CODE to match it" >&2
    exit 1
  fi
  echo "==> the APK agrees: $APK_NAME_IN_APK ($APK_CODE)"
else
  echo "==> warning: aapt2 not found, so the manifest's version was not checked against the APK" >&2
fi

# The control plane a phone enrolls against is compiled into the APK, while this
# channel advertises MANAGEMENT_URL. The repository's committed fallback is NetBird
# Cloud, so a build that never passed -PawManagementUrl= enrolls against Cloud; a
# channel describing one address while the app dials another is a support case with
# no visible cause. Read the address out of the
# dex rather than trusting the command line that produced it.
WANTED="${MANAGEMENT_URL%/}"
if command -v unzip > /dev/null 2>&1; then
  # `sort -u` reads the whole stream, so nothing exits early and the pipeline cannot
  # end on SIGPIPE under `set -o pipefail` (see the badging gate above).
  BAKED="$(unzip -p "$APK_SRC" classes.dex 2>/dev/null | grep -aoE 'https://[A-Za-z0-9._:/-]+' | sort -u || true)"
  if [ -z "$BAKED" ]; then
    echo "refusing to publish: no address could be read out of the APK's classes.dex" >&2
    exit 1
  fi
  if ! printf '%s\n' "$BAKED" | grep -qxF "$WANTED"; then
    echo "refusing to publish: the APK does not carry $WANTED" >&2
    echo "  rebuild it with -PawManagementUrl=$WANTED" >&2
    echo "  (addresses this APK does carry: $(printf '%s' "$BAKED" | tr '\n' ' '))" >&2
    exit 1
  fi
  echo "==> the APK carries this channel's control plane: $WANTED"
else
  echo "==> warning: unzip not found, so the APK's compiled control plane was not checked" >&2
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> stage artifacts"
# -p keeps the source mtime so a re-publish skips the 248 MB upload.
cp -p "$APK_SRC" "$STAGE/$APK_NAME"
shasum -a 256 "$APK_SRC" | cut -d' ' -f1 > "$STAGE/$APK_NAME.sha256"
NOTICES="$(dirname "$0")/../THIRD_PARTY_NOTICES.md"
if [ -f "$NOTICES" ]; then
  cp -p "$NOTICES" "$STAGE/THIRD_PARTY_NOTICES.md"
else
  echo "refusing to publish without THIRD_PARTY_NOTICES.md: the APK embeds BSD-3 code" >&2
  exit 1
fi

# apkUrl is a bare filename on purpose: the app resolves it against the
# configured apkBaseUrl (src/updater.ts resolveApkUrl), so the channel host
# lives in fleet.json alone and a host change never needs a new manifest format.
cat > "$STAGE/version.json" <<EOF
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "apkUrl": "$APK_NAME",
  "notes": "$NOTES"
}
EOF

cat > "$STAGE/fleet.json" <<EOF
{
  "managementUrl": "$MANAGEMENT_URL",
  "manifestUrl": "${PUBLIC_BASE}version.json",
  "apkBaseUrl": "$PUBLIC_BASE",
  "zone": "$ZONE"
}
EOF

python3 -m json.tool "$STAGE/version.json" >/dev/null
python3 -m json.tool "$STAGE/fleet.json" >/dev/null
# The shipped APK must resolve these without any of them being dead.
if grep -rq "dl-dev" "$STAGE/fleet.json" "$STAGE/version.json"; then
  echo "refusing to publish a retired dl-dev address"; exit 1
fi

echo "==> upload to $REMOTE_HOST:$REMOTE_ROOT"
ssh "$REMOTE_HOST" "rm -rf '$REMOTE_STAGE' && mkdir -p '$REMOTE_STAGE'"
rsync -a --partial --inplace "$STAGE/" "$REMOTE_HOST:$REMOTE_STAGE/"
ssh "$REMOTE_HOST" "
  set -e
  test -s '$REMOTE_STAGE/$APK_NAME'
  test -s '$REMOTE_STAGE/version.json'
  test -s '$REMOTE_STAGE/fleet.json'
  test -s '$REMOTE_STAGE/THIRD_PARTY_NOTICES.md'
  rm -rf '${REMOTE_ROOT}.previous'
  if [ -d '$REMOTE_ROOT' ]; then mv '$REMOTE_ROOT' '${REMOTE_ROOT}.previous'; fi
  mv '$REMOTE_STAGE' '$REMOTE_ROOT'
  rm -rf '${REMOTE_ROOT}.previous'
  # The channel must be readable by the nginx worker (www on this host). An
  # rsync-created directory inherits a restrictive mode and nginx answers 403,
  # which reads exactly like an unreachable channel from the app.
  chown -R www:www '$REMOTE_ROOT'
  chmod 0755 '$REMOTE_ROOT'
  find '$REMOTE_ROOT' -maxdepth 1 -type f -exec chmod 0644 {} +
"
echo "==> uploaded"

echo "==> verify manifest + config"
LOCAL_SIZE=$(wc -c < "$APK_SRC" | tr -d ' ')
for base in "$PUBLIC_BASE" "$OVERLAY_BASE"; do
  printf '%-34s ' "$base"
  manifest=$(curl -fsS -m 12 "${base}version.json" 2>/dev/null || true)
  if [ -z "$manifest" ]; then
    echo "UNREACHABLE (DNS, certificate or nginx not ready for this name)"
    continue
  fi
  printf '%s' "$manifest" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("version.json ok:", d["versionCode"], d["versionName"], d["apkUrl"])'
  curl -fsS -m 12 "${base}fleet.json" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  fleet.json ok:", d["manifestUrl"], "| apkBase:", d["apkBaseUrl"])' 2>/dev/null || echo "  fleet.json UNREACHABLE"
  # HEAD + a 1 MiB range instead of pulling 248 MB: proves the file is served
  # whole (Content-Length), resumable (206), and identical to what we uploaded.
  remote_size=$(curl -fsSI -m 20 "${base}${APK_NAME}" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')
  if [ "$remote_size" = "$LOCAL_SIZE" ]; then
    echo "  apk size ok: $remote_size bytes (matches local)"
  else
    echo "  apk size MISMATCH: remote=${remote_size:-none} local=$LOCAL_SIZE"
  fi
  curl -fsS -m 20 -r 0-1048575 -o /dev/null -w "  range http=%{http_code} bytes=%{size_download}\n" "${base}${APK_NAME}" \
    || echo "  range request FAILED"
done
echo "==> refresh the LAN mirror (convenience for a phone on the same WiFi)"
# Not the authoritative channel and never a second source of truth: it serves
# the same staged files the edge channel just got, so it cannot drift into
# handing out an old build the way the retired laptop channel did. Set
# MIRROR_ROOT= to skip it.
MIRROR_ROOT="${MIRROR_ROOT:-$HOME/.dsh/netbird-apk/www}"
if [ -n "$MIRROR_ROOT" ]; then
  mkdir -p "$MIRROR_ROOT"
  cp -p "$STAGE/$APK_NAME" "$MIRROR_ROOT/$APK_NAME"
  cp -p "$STAGE/$APK_NAME.sha256" "$MIRROR_ROOT/$APK_NAME.sha256"
  cp -p "$STAGE/version.json" "$MIRROR_ROOT/version.json"
  cp -p "$STAGE/fleet.json" "$MIRROR_ROOT/fleet.json"
  chmod 0755 "$MIRROR_ROOT"
  find "$MIRROR_ROOT" -maxdepth 1 -type f -exec chmod 0644 {} +
  echo "  mirror root: $MIRROR_ROOT"
  LAN_IP="${LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
  if [ -n "$LAN_IP" ]; then
    printf '  http://%s:8088/version.json -> ' "$LAN_IP"
    curl -fsS -m 10 "http://$LAN_IP:8088/version.json" 2>/dev/null \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok", d["versionCode"], d["versionName"])' 2>/dev/null \
      || echo "not served (no vhost for this host)"
    echo "  phone URL on WiFi: http://$LAN_IP:8088/$APK_NAME"
  else
    echo "  (no en0 address; skipped the LAN check)"
  fi
fi
echo "==> done"