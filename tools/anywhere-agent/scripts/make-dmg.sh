#!/usr/bin/env bash
# Build the disk image a person downloads: the app, the shortcut that installs it, and
# the instructions that tell them what to do with an ad-hoc signed build.
#
# The image is an installer, not a folder with an app in it. Three things make it one, and
# the first two are guarantees the script verifies after writing the file:
#
#   1. an `Applications` symlink next to the app, so the app can be dragged onto it;
#   2. the install notes, readable without mounting anything else, in both languages;
#   3. a Finder window that opens already arranged, with a background that points from the
#      app to the folder. This one is best effort: writing the arrangement means asking
#      Finder to do it (`osascript`), which a headless or consent-less session cannot. The
#      image is still installable without it - (1) and (2) do not depend on it - so a
#      failed arrangement is reported and not fatal.
#
# The verification step remounts what was written and checks (1) and (2) plus the app's own
# executable, so "the installer works" is a measurement rather than a claim.
#
# Usage:
#   scripts/make-dmg.sh --app build/Anywhere\ Work.app --out build/Anywhere\ Work-0.1.0.dmg \
#     --electron <runtime>/Electron.app/Contents/MacOS/Electron
#
# Options:
#   --app <bundle>        the signed .app to ship (required)
#   --out <dmg>           where to write the compressed image (required)
#   --volume <name>       the volume name the Finder shows (default: Anywhere Work)
#   --notes <file>        the install notes shipped in the volume
#                         (default: packaging/install-notes.txt)
#   --electron <binary>   the runtime Electron binary, used to render the background
#   --tokens <file>       the brand tokens the background's colours come from
#   --background <png>    a pre-rendered background, instead of rendering one
#   --no-layout           skip the Finder arrangement (headless sessions, tests)
#   --no-verify           skip the remount-and-check step
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP=""
OUT=""
VOLUME="Anywhere Work"
NOTES="$PACKAGE_DIR/packaging/install-notes.txt"
ELECTRON=""
TOKENS="$PACKAGE_DIR/../../tools/dsh-netbird/brand/tokens.json"
BACKGROUND=""
LAYOUT=1
VERIFY=1

# The Finder window and where the two icons sit in it. This is the single owner of that
# geometry: the background is rendered from exactly these numbers, so the arrow cannot
# point somewhere the icons are not.
WIN_W=660
WIN_H=420
ICON_SIZE=112
APP_X=170
APP_Y=195
APPS_X=490
APPS_Y=195
# The notes file sits in the upper left corner, clear of the centred copy and of the icon
# row: it is a fallback for a Finder that will not arrange, so it must not read as part of
# the picture - and its own label has to stay inside the window.
NOTES_X=96
NOTES_Y=96
# Set high enough that the icons do not sit on the window's edges, low enough to leave the
# instructions readable at a glance.
WINDOW_TITLE_BAR=28

# The notes file's name inside the volume: a person who never finds the background (or a
# Finder that would not arrange) still has the instructions in front of them in both
# languages.
NOTES_NAME="安装说明 How to install.txt"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:?--app needs a bundle path}"; shift 2 ;;
    --out) OUT="${2:?--out needs a file path}"; shift 2 ;;
    --volume) VOLUME="${2:?--volume needs a name}"; shift 2 ;;
    --notes) NOTES="${2:?--notes needs a file path}"; shift 2 ;;
    --electron) ELECTRON="${2:?--electron needs a binary path}"; shift 2 ;;
    --tokens) TOKENS="${2:?--tokens needs a file path}"; shift 2 ;;
    --background) BACKGROUND="${2:?--background needs a png path}"; shift 2 ;;
    --no-layout) LAYOUT=0; shift ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$APP" ] || [ -z "$OUT" ]; then
  echo "--app and --out are required" >&2
  usage >&2
  exit 2
fi
if [ ! -d "$APP" ] || [ ! -f "$APP/Contents/Info.plist" ]; then
  echo "not an application bundle: $APP" >&2
  exit 1
fi

APP_BUNDLE="$(basename "$APP")"
WORK="$(mktemp -d)"
ATTACHED=""
cleanup() {
  if [ -n "$ATTACHED" ]; then
    hdiutil detach "$ATTACHED" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

warn() {
  echo "  warning: $*" >&2
}

# Run a command with a deadline, because `osascript` has none: a session that cannot answer
# Finder's consent prompt would otherwise hang the build instead of failing one step.
run_bounded() {
  local seconds="$1"
  shift
  "$@" &
  local pid=$!
  ( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null ) &
  local guard=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$guard" 2>/dev/null || true
  wait "$guard" 2>/dev/null || true
  return "$rc"
}

echo "==> staging the volume ($VOLUME)"
STAGE="$WORK/stage"
mkdir -p "$STAGE"
# ditto, not cp -R: an .app bundle carries symlinks, extended attributes and permissions
# that a plain copy does not preserve, and the signature covers all three.
ditto "$APP" "$STAGE/$APP_BUNDLE"

# The shortcut. Without it the window is a folder with an app in it and installing means
# knowing that /Applications is where apps belong.
ln -s /Applications "$STAGE/Applications"

STAGED_NOTES=""
if [ -f "$NOTES" ]; then
  cp "$NOTES" "$STAGE/$NOTES_NAME"
  STAGED_NOTES="$NOTES_NAME"
  echo "  notes: $NOTES_NAME"
else
  warn "$NOTES is missing; the volume ships without install instructions"
fi

if [ -z "$BACKGROUND" ] && [ -n "$ELECTRON" ] && [ -f "$TOKENS" ]; then
  if [ ! -x "$ELECTRON" ]; then
    warn "$ELECTRON is not executable; the volume gets no background"
  else
    echo "==> rendering the installer background"
    for scale in 1 2; do
      w=$((WIN_W * scale))
      h=$((WIN_H * scale))
      suffix=""
      if [ "$scale" = 2 ]; then
        suffix="@2x"
      fi
      out="$WORK/background$suffix.png"
      if "$ELECTRON" "$SCRIPT_DIR/render-dmg-background.cjs" "$TOKENS" "$out" "$w" "$h" \
          "$((APP_X * scale))" "$((APP_Y * scale))" "$((APPS_X * scale))" "$((APPS_Y * scale))" \
          "$((ICON_SIZE * scale))" >/dev/null 2>&1; then
        if [ "$scale" = 1 ]; then
          BACKGROUND="$out"
        fi
        echo "  background: ${w}x${h}"
      else
        warn "could not render the ${w}x${h} background"
      fi
    done
  fi
fi

if [ -n "$BACKGROUND" ] && [ -f "$BACKGROUND" ]; then
  mkdir -p "$STAGE/.background"
  cp "$BACKGROUND" "$STAGE/.background/background.png"
  # A Retina twin next to it. The arrangement names only the 1x file, so a Finder that
  # does not look for the @2x variant loses sharpness and nothing else.
  RETINA="${BACKGROUND%.png}@2x.png"
  if [ -f "$RETINA" ]; then
    cp "$RETINA" "$STAGE/.background/background@2x.png"
  fi
fi

RW="$WORK/rw.dmg"
echo "==> writing the read-write image"
hdiutil create -quiet -srcfolder "$STAGE" -volname "$VOLUME" -fs HFS+ -format UDRW -ov "$RW"

LAYOUT_APPLIED="no"
# Empty when the volume carries no background; the verification step reads it too.
BG_NAME=""
if [ "$LAYOUT" = 1 ]; then
  echo "==> arranging the Finder window"
  # A stale mount of the same name would make macOS mount this one as "<name> 1", so any
  # volume already sitting under that name is taken down first (best effort: it may be the
  # user's own open window).
  if [ -d "/Volumes/$VOLUME" ]; then
    warn "/Volumes/$VOLUME is already mounted; detaching it to arrange this image"
    hdiutil detach "/Volumes/$VOLUME" -quiet >/dev/null 2>&1 || hdiutil detach "/Volumes/$VOLUME" -quiet -force >/dev/null 2>&1 || true
  fi
  # Mounted where the system puts it, not at a private mount point: Finder addresses the
  # volume by name, and a disk mounted outside /Volumes is not a disk it can be told about.
  ATTACH_OUT="$(hdiutil attach "$RW" -readwrite -noverify -noautoopen 2>/dev/null || true)"
  MP="$(printf '%s\n' "$ATTACH_OUT" | awk -F'\t' '/\/Volumes\// { print $NF }' | tail -1)"
  if [ -n "$MP" ] && [ -d "$MP" ]; then
    ATTACHED="$MP"
    # The name the system actually gave it, which is not always the requested one.
    MOUNTED_NAME="$(basename "$MP")"
    BG_NAME=""
    if [ -f "$STAGE/.background/background.png" ]; then
      BG_NAME="background.png"
    fi
    LAYOUT_SCRIPT="$WORK/layout.applescript"
    cat > "$LAYOUT_SCRIPT" <<'APPLESCRIPT'
on run argv
  set volName to item 1 of argv
  set appName to item 2 of argv
  set winWidth to (item 3 of argv) as integer
  set winHeight to (item 4 of argv) as integer
  set iconSize to (item 5 of argv) as integer
  set appX to (item 6 of argv) as integer
  set appY to (item 7 of argv) as integer
  set appsX to (item 8 of argv) as integer
  set appsY to (item 9 of argv) as integer
  set bgName to item 10 of argv
  set titleBar to (item 11 of argv) as integer
  set mountPath to item 12 of argv
  set notesName to item 13 of argv
  set notesX to (item 14 of argv) as integer
  set notesY to (item 15 of argv) as integer
  tell application "Finder"
    tell disk volName
      open
      -- The window has to exist before its view options can be written; setting the
      -- background picture immediately after `open` is answered with a bare
      -- "AppleEvent handler failed" (-10000).
      delay 1
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      -- The bounds include the title bar, the picture is drawn in the content area, so the
      -- height carries the extra chrome and the background is not clipped.
      set the bounds of container window to {200, 140, 200 + winWidth, 140 + winHeight + titleBar}
      set theOptions to the icon view options of container window
      set arrangement of theOptions to not arranged
      set icon size of theOptions to iconSize
      set text size of theOptions to 13
      set position of item appName of container window to {appX, appY}
      set position of item "Applications" of container window to {appsX, appsY}
      if notesName is not "" then
        set position of item notesName of container window to {notesX, notesY}
      end if
      -- The picture is addressed by its path on the mounted volume. The usual shorthand
      -- (`file ".background:x.png"`) resolves against the disk object instead and never
      -- reaches the file, which is how the picture goes missing without an error.
      if bgName is not "" then
        set background picture of theOptions to (POSIX file (mountPath & "/.background/" & bgName)) as alias
      end if
      update without registering applications
      delay 1
      -- Read back what was just asked for: the arrangement is the whole point of opening
      -- this window, and Finder reports no error when a setting does not stick. The
      -- background picture is not read back here - asking Finder for that property raises
      -- "AppleEvent handler failed" (-10000) - the caller checks it in the volume's
      -- .DS_Store instead.
      set placedApp to position of item appName of container window
      set placedApps to position of item "Applications" of container window
      if placedApp is not {appX, appY} then error "the app icon landed at " & (item 1 of placedApp) & "," & (item 2 of placedApp)
      if placedApps is not {appsX, appsY} then error "the Applications icon landed at " & (item 1 of placedApps) & "," & (item 2 of placedApps)
      if notesName is not "" then
        set placedNotes to position of item notesName of container window
        if placedNotes is not {notesX, notesY} then error "the notes file landed at " & (item 1 of placedNotes) & "," & (item 2 of placedNotes)
      end if
      close
    end tell
  end tell
  return "ok"
end run
APPLESCRIPT
    if run_bounded 60 osascript "$LAYOUT_SCRIPT" "$MOUNTED_NAME" "$APP_BUNDLE" "$WIN_W" "$WIN_H" \
        "$ICON_SIZE" "$APP_X" "$APP_Y" "$APPS_X" "$APPS_Y" "$BG_NAME" "$WINDOW_TITLE_BAR" "$MP" \
        "$STAGED_NOTES" "$NOTES_X" "$NOTES_Y" >/dev/null 2>"$WORK/layout.err"; then
      LAYOUT_APPLIED="yes"
      echo "  icons placed"
      # Finder stores the picture as an alias inside the volume's .DS_Store; that record is
      # the only readable evidence that the background was accepted, and its absence means
      # the window opens arranged but plain.
      if [ -n "$BG_NAME" ] && [ -f "$MP/.DS_Store" ] && ! grep -a -q "$BG_NAME" "$MP/.DS_Store"; then
        warn "the background picture did not stick; the window will open arranged but plain"
      fi
    else
      warn "Finder would not arrange the window: $(tr -d '\n' < "$WORK/layout.err" | tail -c 200)"
      warn "the app, the Applications shortcut and the install notes still install it"
    fi
    # Finder and Spotlight write their own state into the volume; the image is what the
    # user needs, not a record of this machine having mounted it.
    rm -rf "$MP/.Trashes" "$MP/.fseventsd" "$MP/.Spotlight-V100" 2>/dev/null || true
    # Let Finder flush the arrangement into .DS_Store before the volume goes away.
    sync
    if ! hdiutil detach "$MP" -quiet >/dev/null 2>&1; then
      sleep 2
      hdiutil detach "$MP" -quiet -force >/dev/null 2>&1 || warn "could not detach $MP"
    fi
    ATTACHED=""
  else
    warn "could not mount the read-write image; the window will not be arranged"
  fi
fi

echo "==> compressing"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil convert "$RW" -quiet -format UDZO -imagekey zlib-level=9 -o "$OUT"

echo "==> verifying the image"
if ! hdiutil verify "$OUT" >/dev/null 2>&1; then
  echo "the image failed its own checksum verification" >&2
  exit 1
fi

verify_image() {
  local mp="$WORK/mnt-verify"
  mkdir -p "$mp"
  if ! hdiutil attach "$OUT" -readonly -nobrowse -noverify -noautoopen -mountpoint "$mp" >/dev/null 2>&1; then
    echo "  could not mount the image that was just written" >&2
    return 1
  fi
  ATTACHED="$mp"
  local failures=0
  local bundle="$mp/$APP_BUNDLE"

  if [ ! -d "$bundle" ]; then
    echo "  the volume has no $APP_BUNDLE" >&2
    failures=$((failures + 1))
  else
    local exe
    exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist" 2>/dev/null || true)"
    if [ -z "$exe" ] || [ ! -x "$bundle/Contents/MacOS/$exe" ]; then
      echo "  the bundled app has no launchable executable" >&2
      failures=$((failures + 1))
    fi
  fi

  # The shortcut is the difference between an installer and a folder.
  if [ ! -L "$mp/Applications" ]; then
    echo "  the volume has no Applications shortcut" >&2
    failures=$((failures + 1))
  elif [ "$(readlink "$mp/Applications")" != "/Applications" ]; then
    echo "  the Applications shortcut points at $(readlink "$mp/Applications")" >&2
    failures=$((failures + 1))
  fi

  if [ ! -s "$mp/$NOTES_NAME" ]; then
    echo "  the volume has no install notes" >&2
    failures=$((failures + 1))
  fi

  if [ "$LAYOUT" = 1 ] && [ ! -f "$mp/.DS_Store" ]; then
    echo "  note: the window is not arranged (no .DS_Store); the shortcut and the notes still install it"
  elif [ "$LAYOUT" = 1 ] && [ -n "$BG_NAME" ] && ! grep -a -q "$BG_NAME" "$mp/.DS_Store"; then
    echo "  note: the window is arranged but carries no background picture"
  fi

  hdiutil detach "$mp" -quiet >/dev/null 2>&1 || true
  ATTACHED=""
  return "$failures"
}

if [ "$VERIFY" = 1 ]; then
  if verify_image; then
    echo "  layout verifies (app, Applications shortcut, install notes)"
  else
    echo "the image that was written is not installable" >&2
    exit 1
  fi
fi

echo "  arranged: $LAYOUT_APPLIED"
if [ "$LAYOUT" = 1 ] && [ "$LAYOUT_APPLIED" != "yes" ]; then
  echo "  note: arrange the window by hand if this image is a release, or build it where Finder can be scripted" >&2
fi
du -sh "$OUT" | sed 's/^/  /'
echo "==> built $OUT"