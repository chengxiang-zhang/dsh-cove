#!/bin/sh
# Anywhere Work private-network client installer.
#
#   curl -fsSL https://anywhere.example.com/install.sh | sh
#
# It downloads the NetBird client from our own public channel, verifies the
# SHA-256 against the checksums published next to it, installs it, starts the
# background service and opens the browser for SSO login (Feishu first, account
# password as the switch). The account server hands each new identity its own
# private group, so there is nothing to approve and nothing to configure here.
#
# DSH (DeepSeek Harness) rides along on the same one-liner: installed with npm
# (a private Node under $DSH_HOME/node first when the machine has no usable
# one), configured with Kaon Router as its default model provider, and kept
# resident by a LaunchAgent on macOS or a user systemd unit on Linux so the
# machine answers on its own http://dsh.<machine>.netbird/ address. The model
# API key is the one thing this script cannot do for you: it prints where to
# apply for it (https://router-admin.example.com/) and where to paste it.
# Pass --no-dsh to install only the private-network client.
#
# This script is served as https://anywhere.example.com/install.sh; the
# archives it installs from live under .../client/, together with latest.txt
# (version), management-url.txt and checksums.txt ("<sha256>  <file>", copied
# from the upstream release).
#
# Flags, each with an AW_* environment equivalent:
#   --dry-run              print the plan, change nothing
#   --no-service           no system service; run the daemon for this session
#   --no-login             install and start the client, do not log in
#   --no-dsh               install the private-network client only, no DSH
#   --dsh-version V        DSH version to install (default: latest)
#   --force                install the channel copy even if netbird exists
#   --bin-dir DIR          install the binary here (default /usr/local/bin)
#   --channel URL          channel base holding the archives and checksums
#   --management-url URL   management endpoint to log into
#   --profile NAME         NetBird profile to use
#   --no-browser           print the login URL instead of opening a browser
#   --qr                   print a QR code for the login URL instead of opening it
#   --uninstall            stop the services, remove the client and the DSH service
#   -h, --help             this text
set -eu

CHANNEL="${AW_CHANNEL:-https://anywhere.example.com/client}"
MANAGEMENT_URL="${AW_MANAGEMENT_URL:-}"
BIN_DIR="${AW_BIN_DIR:-/usr/local/bin}"
PROFILE="${AW_PROFILE:-}"
DSH_VERSION="${AW_DSH_VERSION:-latest}"
NODE_BASE_URL="${AW_NODE_CHANNEL:-https://nodejs.org/dist/latest-v22.x}"
NO_DSH="${AW_NO_DSH:-0}"
DRY_RUN=0
NO_SERVICE=0
NO_LOGIN=0
FORCE=0
QR=0
NO_BROWSER=0
UNINSTALL=0

say() { printf '%s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

usage() {
  cat <<'TXT'
Anywhere Work private-network client installer (macOS and Linux)

  curl -fsSL https://anywhere.example.com/install.sh | sh

Options:
  --dry-run              print the plan, change nothing
  --no-service           no system service; run the daemon for this session
  --no-login             install and start the client, do not log in
  --no-dsh               install the private-network client only, no DSH
  --dsh-version V        DSH version to install (default: latest)
  --force                install the channel copy even if the client is already installed
  --bin-dir DIR          install the binary here (default /usr/local/bin)
  --channel URL          channel base holding the archives and checksums
  --management-url URL   management endpoint to log into
  --profile NAME         client profile to use
  --no-browser           print the login URL instead of opening a browser
  --qr                   print a QR code for the login URL instead of opening it
  --uninstall            stop the services, remove the client and the resident DSH service
  -h, --help             this text

This one-liner also installs DSH, seeds Kaon Router as its default model
provider and keeps it resident (LaunchAgent on macOS, user systemd unit on
Linux). Apply for the Kaon Router API key at
https://router-admin.example.com/ and paste it into DSH once. Run it as
your own user rather than as root: the resident service belongs to your account,
and the parts that need administrator rights escalate on their own.
TXT
}

# Under `curl | sh` stdin is the script itself, so anything that reads stdin
# (sudo, the login flow) has to be pointed at the terminal instead. /dev/tty is
# world-readable even where it cannot be opened (no controlling terminal), so
# the check opens it instead of testing permissions.
have_tty() { (exec </dev/tty) 2>/dev/null; }
as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif have_tty; then
    note "administrator rights needed: $*"
    sudo "$@" </dev/tty
  else
    sudo "$@"
  fi
}

# Print ARG as one single-quoted shell word, so the path recorded inside the
# generated command survives whatever the install directory contains.
sh_quote() {
  q="'"
  out="'"
  rest="$1"
  while :; do
    case "$rest" in
      *"$q"*)
        out="$out${rest%%"$q"*}$q\\$q$q"
        rest="${rest#*"$q"}"
        ;;
      *)
        out="$out$rest$q"
        break
        ;;
    esac
  done
  printf '%s' "$out"
}

# Write the product command to $2, recording $1 as the client binary it wraps.
# The body is one quoted heredoc with a single placeholder line so the recorded
# path is substituted rather than templated by string surgery.
write_anywhere_command() {
  vendor_bin="$1"
  dest="$2"
  : > "$dest"
  while IFS= read -r line; do
    case "$line" in
      "VENDOR_DEFAULT=__ANYWHERE_VENDOR__")
        printf 'VENDOR_DEFAULT=%s\n' "$(sh_quote "$vendor_bin")" >> "$dest"
        ;;
      *)
        printf '%s\n' "$line" >> "$dest"
        ;;
    esac
  done <<'ANYWHERE_COMMAND_EOF'
#!/bin/sh
# Anywhere Work private-network command.
#
# The private-network client binary installed next to this script keeps its own
# name and its own behavior; this command is additive and never replaces it.
# VENDOR_DEFAULT is the absolute path recorded at install time and the sibling
# lookup is the fallback, so this command never depends on the client being on
# PATH. Everything it prints is derived from what the client itself reports.
set -u

VENDOR_DEFAULT=__ANYWHERE_VENDOR__

VENDOR=""
PARSED=""
MGMT=""
SIGNAL=""
TOTAL=""
DEVICE=""
PEER_LINES=""

missing_client() {
  printf 'anywhere: the private-network client binary is missing\n' >&2
  printf 'anywhere: expected %s or a client binary next to %s\n' "${VENDOR_DEFAULT:-the recorded path}" "$0" >&2
  printf 'anywhere: reinstall it with the Anywhere Work installer\n' >&2
  exit 127
}

resolve_client() {
  if [ -n "$VENDOR_DEFAULT" ] && [ -x "$VENDOR_DEFAULT" ]; then
    VENDOR="$VENDOR_DEFAULT"
    return 0
  fi
  self="$0"
  case "$self" in
    */*) dir="${self%/*}" ;;
    *) dir="." ;;
  esac
  dir="$(CDPATH= cd "$dir" 2>/dev/null && pwd)" || dir=""
  if [ -n "$dir" ] && [ -x "$dir/netbird" ]; then
    VENDOR="$dir/netbird"
    return 0
  fi
  return 1
}

require_client() {
  resolve_client || missing_client
}

usage() {
  cat <<'TXT'
Anywhere Work private network

Usage:
  anywhere                 status summary and available commands
  anywhere status          connection state and the machines you can see
  anywhere machines        list the machines you can see (name and address)
  anywhere up [args...]    connect this machine
  anywhere down [args...]  disconnect this machine
  anywhere version         show the client version
  anywhere help            this text

The command wraps the private-network client installed with it. Anything after
the subcommand is passed to that client unchanged and its exit status is
returned as-is.
TXT
}

# The client's own machine-readable status is the JSON behind `status --json`.
# This reads it with POSIX awk alone (no jq, no python) and prints one record
# per line:
#   m <management>  s <signal>  d <device fqdn>  t <peer total>
#   p <peer fqdn> <peer address>
# A key is only trusted at the depth its shape puts it at, so a peer's fqdn can
# never be read as this device's name. Both layouts the client has shipped are
# understood: management/signal as objects carrying a `connected` boolean, and
# the older flat `management_state` / `signal_state` strings.
parse_records() {
  awk '
  function stateword(v) {
    if (v == "true") return "Connected"
    if (v == "false") return "Disconnected"
    return v
  }
  BEGIN { nt = 0; buf = ""; ok = 0 }
  { buf = buf $0 "\n" }
  END {
    n = length(buf)
    i = 1
    while (i <= n) {
      c = substr(buf, i, 1)
      if (c == "\"") {
        i++
        s = ""
        while (i <= n) {
          c = substr(buf, i, 1)
          if (c == "\\") {
            e = substr(buf, i + 1, 1)
            if (e == "n") s = s "\n"
            else if (e == "t") s = s "\t"
            else if (e == "r") s = s "\r"
            else s = s e
            i += 2
            continue
          }
          if (c == "\"") { i++; break }
          s = s c
          i++
        }
        nt++; tok[nt] = "S"; val[nt] = s
        continue
      }
      if (c == "{" || c == "}" || c == "[" || c == "]" || c == ":" || c == ",") {
        nt++; tok[nt] = c; val[nt] = c
        i++
        continue
      }
      if (c == " " || c == "\t" || c == "\r" || c == "\n") { i++; continue }
      s = ""
      while (i <= n) {
        c = substr(buf, i, 1)
        if (c == " " || c == "\t" || c == "\r" || c == "\n" || c == "," || c == "}" || c == "]" || c == ":") break
        s = s c
        i++
      }
      nt++; tok[nt] = "V"; val[nt] = s
    }

    depth = 0; pending = ""
    mgmt = -1; sig = -1; peers = -1; pdetails = -1; parr = -1; peer = -1; localp = -1
    pfqdn = ""; pip = ""
    for (k = 1; k <= nt; k++) {
      t = tok[k]
      if (t == "S") {
        if (k + 1 <= nt && tok[k + 1] == ":") {
          key = val[k]
          vt = (k + 2 <= nt) ? tok[k + 2] : ""
          vv = (k + 2 <= nt) ? val[k + 2] : ""
          if (vt == "{" || vt == "[") {
            pending = key
          } else if (vt == "V" || vt == "S") {
            if (depth == 1) {
              if (key == "management_state" || key == "managementState") { print "m " vv; ok = 1 }
              else if (key == "signal_state" || key == "signalState") { print "s " vv; ok = 1 }
              else if (key == "fqdn") { print "d " vv; ok = 1 }
            }
            if (localp > 0 && depth == localp && key == "fqdn") { print "d " vv; ok = 1 }
            if (mgmt > 0 && depth == mgmt && key == "connected") { print "m " stateword(vv); ok = 1 }
            if (sig > 0 && depth == sig && key == "connected") { print "s " stateword(vv); ok = 1 }
            if (peers > 0 && depth == peers && key == "total") { print "t " vv; ok = 1 }
            if (peer > 0 && depth == peer) {
              if (key == "fqdn" && pfqdn == "") pfqdn = vv
              else if ((key == "netbirdIp" || key == "netbird_ip" || key == "ip" || key == "IP") && pip == "") pip = vv
            }
            pending = ""
          }
          continue
        }
        continue
      }
      if (t == "{") {
        depth++
        if (pending == "management") mgmt = depth
        else if (pending == "signal") sig = depth
        else if (pending == "peers") peers = depth
        else if (pending == "localPeerState") localp = depth
        else if ((pdetails > 0 && depth == pdetails + 1) || (parr > 0 && depth == parr + 1)) { peer = depth; pfqdn = ""; pip = "" }
        pending = ""
        continue
      }
      if (t == "[") {
        depth++
        if (pending == "peers") parr = depth
        else if (pending == "details" && peers > 0) pdetails = depth
        pending = ""
        continue
      }
      if (t == "}") {
        if (peer > 0 && depth == peer) {
          if (pfqdn != "") { print "p " pfqdn " " pip; ok = 1 }
          peer = -1
        }
        if (depth == mgmt) mgmt = -1
        if (depth == sig) sig = -1
        if (depth == peers) peers = -1
        if (depth == pdetails) pdetails = -1
        if (depth == localp) localp = -1
        depth--
        pending = ""
        continue
      }
      if (t == "]") {
        if (depth == pdetails) pdetails = -1
        if (depth == parr) parr = -1
        depth--
        pending = ""
        continue
      }
    }
    if (!ok) print "__ANYWHERE_PARSE_FAILED__"
  }
  '
}

# Reads the client's machine-readable status into PARSED. Returns non-zero when
# the client cannot be read that way, so every caller can fall back to the
# client's own plain output instead of failing.
read_client() {
  command -v awk >/dev/null 2>&1 || return 1
  json="$("$VENDOR" status --json 2>/dev/null)" || json=""
  [ -n "$json" ] || return 1
  PARSED="$(printf '%s\n' "$json" | parse_records)" || return 1
  [ "$PARSED" = "__ANYWHERE_PARSE_FAILED__" ] && return 1
  [ -n "$PARSED" ] || return 1
  return 0
}

load_fields() {
  peer_count=0
  MGMT=""; SIGNAL=""; TOTAL=""; DEVICE=""; PEER_LINES=""
  old_ifs="$IFS"
  IFS='
'
  set -f
  for record in $PARSED; do
    case "$record" in
      "m "*) [ -n "$MGMT" ] || MGMT="${record#m }" ;;
      "s "*) [ -n "$SIGNAL" ] || SIGNAL="${record#s }" ;;
      "d "*) [ -n "$DEVICE" ] || DEVICE="${record#d }" ;;
      "t "*) [ -n "$TOTAL" ] || TOTAL="${record#t }" ;;
      "p "*)
        rest="${record#p }"
        case "$rest" in
          *" "*) pname="${rest%% *}"; paddr="${rest#* }" ;;
          *) pname="$rest"; paddr="" ;;
        esac
        peer_count=$((peer_count + 1))
        if [ -z "$PEER_LINES" ]; then
          PEER_LINES="$pname|$paddr"
        else
          PEER_LINES="$PEER_LINES
$pname|$paddr"
        fi
        ;;
    esac
  done
  IFS="$old_ifs"
  set +f
  [ -n "$TOTAL" ] || TOTAL="$peer_count"
  [ -n "$MGMT" ] || MGMT="unknown"
  [ -n "$SIGNAL" ] || SIGNAL="unknown"
  [ -n "$DEVICE" ] || DEVICE="unknown"
}

print_status() {
  printf 'Management: %s\n' "$MGMT"
  printf 'Signal:     %s\n' "$SIGNAL"
  printf 'Your machines: %s\n' "$TOTAL"
  printf 'This device: %s\n' "$DEVICE"
}

print_machines() {
  [ -n "$PEER_LINES" ] || return 0
  printf '%s\n' "$PEER_LINES" | while IFS='|' read -r machine address; do
    [ -n "$machine" ] || continue
    if [ -n "$address" ]; then
      printf '%s  %s\n' "$machine" "$address"
    else
      printf '%s\n' "$machine"
    fi
  done
}

print_commands() {
  cat <<'TXT'
Commands
  anywhere status     connection state and the machines you can see
  anywhere machines   the machines you can see (name and address)
  anywhere up         connect this machine
  anywhere down       disconnect this machine
  anywhere version    show the client version
  anywhere help       this text
TXT
}

show_summary() {
  printf 'Anywhere Work private network\n\n'
  if read_client; then
    load_fields
    print_status
  else
    "$VENDOR" status 2>&1 || true
  fi
  printf '\n'
  print_commands
}

command_name="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

case "$command_name" in
  '')
    require_client
    show_summary
    ;;
  status)
    require_client
    if [ "$#" -gt 0 ]; then
      exec "$VENDOR" status "$@"
    fi
    if read_client; then
      load_fields
      print_status
    else
      exec "$VENDOR" status
    fi
    ;;
  machines)
    require_client
    if [ "$#" -gt 0 ]; then
      exec "$VENDOR" status --detail "$@"
    fi
    if read_client; then
      load_fields
      print_machines
    else
      exec "$VENDOR" status --detail
    fi
    ;;
  up|down)
    require_client
    exec "$VENDOR" "$command_name" "$@"
    ;;
  version|--version|-v)
    require_client
    exec "$VENDOR" version "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
ANYWHERE_COMMAND_EOF
}

# Install the product command next to the client binary and only ever there:
# it is additive, so the binary keeps its own name, its own file and its own
# behavior, and anything that already calls the client directly still works.
install_anywhere_command() {
  wrapper="$BIN_DIR/anywhere"
  say "install -m 0755 <generated> $wrapper"
  note "wraps $1"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  [ -d "$BIN_DIR" ] || as_root mkdir -p "$BIN_DIR"
  write_anywhere_command "$1" "$TMP/anywhere"
  if [ -w "$BIN_DIR" ]; then
    install -m 0755 "$TMP/anywhere" "$wrapper"
  else
    as_root install -m 0755 "$TMP/anywhere" "$wrapper"
  fi
}

# -------------------------------------------------------------------- dsh ---
# DSH (DeepSeek Harness) rides along on the same one-liner. Everything here
# stays inside the user's own account: a private Node under $DSH_HOME/node when
# the machine has no usable one, the npm global prefix the machine already had,
# a LaunchAgent on macOS and a systemd user unit on Linux. No system-wide file
# is created and the machine's own default Node is left exactly as it was.
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DSH_LAUNCHD_LABEL="org.dsh.web"
DSH_SYSTEMD_UNIT="com.dsh.web.service"
DSH_PACKAGE="@deepseek-ai/dsh"
DSH_WEB_PLUGIN="@dsh-cove/dsh-web-all"
KAON_KEY_REF="KAON_ROUTER_API_KEY"
KAON_KEY_URL="${KAON_KEY_URL:-https://router-admin.example.com/}"
DSH_INSTALLED=0
DSH_RESIDENT=0
DSH_BIN=""
DSH_TRUSTED_HOST=""
dsh_ready_code=""

command_path() { command -v "$1" 2>/dev/null || true; }

# Major version of the Node at $1, empty when it cannot be read that way.
node_major_version() {
  node_version_string="$("$1" -v 2>/dev/null || true)"
  case "$node_version_string" in
    v[0-9]*) printf '%s' "${node_version_string#v}" | awk -F. '{ print $1 }' ;;
    *) printf '' ;;
  esac
}

# Install Node from the official distribution into $DSH_HOME/node: verified
# against the SHA-256 list published next to it, extracted for this user only.
# The machine's own Node is not touched, so an old system Node cannot break it.
install_private_node() {
  case "$(uname -m)" in
    arm64|aarch64) node_arch=arm64 ;;
    x86_64|amd64) node_arch=x64 ;;
    *) warn "no Node build for $(uname -m); install Node 22 by hand and re-run"; return 1 ;;
  esac
  node_suffix="-${OS}-${node_arch}.tar.gz"
  step "installing a private Node (${OS}-${node_arch})"
  say "curl -fsSL $NODE_BASE_URL/SHASUMS256.txt"
  if [ "$DRY_RUN" = "1" ]; then
    say "curl -fsSL -o <tmp>/node-v<version>${node_suffix} $NODE_BASE_URL/node-v<version>${node_suffix}"
    say "verify its sha256 against SHASUMS256.txt, then unpack into $DSH_HOME_DIR/node"
    NODE_BIN="$DSH_HOME_DIR/node/node-v<version>-${OS}-${node_arch}/bin/node"
    return 0
  fi
  curl -fsSL --max-time 60 -o "$TMP/node-shasums.txt" "$NODE_BASE_URL/SHASUMS256.txt" \
    || { warn "cannot reach $NODE_BASE_URL/SHASUMS256.txt"; return 1; }
  node_file="$(awk -v suffix="$node_suffix" '$2 ~ suffix && $2 !~ /musl/ { print $2; exit }' "$TMP/node-shasums.txt")"
  node_digest="$(awk -v suffix="$node_suffix" '$2 ~ suffix && $2 !~ /musl/ { print $1; exit }' "$TMP/node-shasums.txt")"
  [ -n "$node_file" ] || { warn "the Node channel publishes no $node_suffix archive"; return 1; }
  say "downloading $node_file"
  curl -fL --retry 2 --retry-delay 2 --max-time 600 -o "$TMP/$node_file" "$NODE_BASE_URL/$node_file" \
    || { warn "download failed: $NODE_BASE_URL/$node_file"; return 1; }
  node_actual="$(sha256_of "$TMP/$node_file")"
  [ "$node_actual" = "$node_digest" ] || die "checksum mismatch for $node_file (expected $node_digest, got $node_actual)"
  say "sha256    $node_actual (matches the Node release list)"
  mkdir -p "$TMP/node-extract"
  tar -xzf "$TMP/$node_file" -C "$TMP/node-extract" || { warn "cannot unpack $node_file"; return 1; }
  node_dir="${node_file%.tar.gz}"
  [ -x "$TMP/node-extract/$node_dir/bin/node" ] || { warn "$node_file does not contain bin/node"; return 1; }
  mkdir -p "$DSH_HOME_DIR/node"
  rm -rf "$DSH_HOME_DIR/node/$node_dir"
  mv "$TMP/node-extract/$node_dir" "$DSH_HOME_DIR/node/"
  NODE_BIN="$DSH_HOME_DIR/node/$node_dir/bin/node"
  PATH="$DSH_HOME_DIR/node/$node_dir/bin:$PATH"
  export PATH
  say "installed $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null || echo 'version unknown'))"
  return 0
}

# npm install -g, with administrator rights only when the global prefix in use
# is not writable for this user: a private or nvm Node never needs them.
npm_global_install() {
  npm_prefix="$("$NPM" prefix -g 2>/dev/null || true)"
  say "$NPM install -g $*"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  if [ -n "$npm_prefix" ] && [ -w "$npm_prefix" ]; then
    "$NPM" install -g "$@"
  else
    as_root "$NPM" install -g "$@"
  fi
}

# PATH the resident service has to see: the directory holding the dsh binary
# plus the usual system directories. launchd and systemd start with a minimal
# PATH, so a dsh under ~/.nvm or $DSH_HOME/node is unreachable without this.
dsh_service_path() {
  dsh_dir="${DSH_BIN%/*}"
  case "$dsh_dir" in
    "$DSH_BIN"|"") dsh_dir="/usr/local/bin" ;;
  esac
  printf '%s:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' "$dsh_dir"
}

# The canonical authority of this machine's DSH entry (machines.json in
# tools/dsh-netbird): dsh.<private-network machine name>.netbird, where the
# machine name is the first label of the client's own FQDN. Without a logged-in
# client the local host name is the best guess available, and the entry answers
# remotely only once an administrator publishes that record.
dsh_trusted_host() {
  dsh_fqdn=""
  if [ -n "$NB" ]; then
    dsh_fqdn="$("$NB" status 2>/dev/null | awk -F': ' '/^FQDN:/{ print $2 }' || true)"
  fi
  dsh_machine="${dsh_fqdn%%.*}"
  if [ -z "$dsh_machine" ]; then
    dsh_machine="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
    dsh_machine="${dsh_machine%%.*}"
  fi
  [ -n "$dsh_machine" ] || dsh_machine="localhost"
  dsh_machine="$(printf '%s' "$dsh_machine" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | sed 's/-\{1,\}$//')"
  [ -n "$dsh_machine" ] || dsh_machine="localhost"
  printf 'dsh.%s.netbird' "$dsh_machine"
}

# macOS: a per-user LaunchAgent, which starts at login and restarts a crashed
# server, and needs no administrator rights.
install_dsh_launchagent() {
  plist="$HOME/Library/LaunchAgents/$DSH_LAUNCHD_LABEL.plist"
  if [ -f "$plist" ] && [ "$FORCE" != "1" ]; then
    note "the resident service is already installed: $plist (--force rewrites it)"
  else
    say "install -m 0644 <generated> $plist"
    if [ "$DRY_RUN" != "1" ]; then
      mkdir -p "$HOME/Library/LaunchAgents" "$DSH_HOME_DIR/logs"
      {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
        printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        printf '%s\n' '<plist version="1.0">' '<dict>'
        printf '\t<key>Label</key>\n\t<string>%s</string>\n' "$DSH_LAUNCHD_LABEL"
        printf '%s\n' '\t<key>ProgramArguments</key>' '\t<array>'
        printf '\t\t<string>%s</string>\n' "$DSH_BIN"
        printf '%s\n' '\t\t<string>web</string>' '\t\t<string>--host</string>' '\t\t<string>127.0.0.1</string>' \
          '\t\t<string>--port</string>' '\t\t<string>3080</string>' '\t\t<string>--no-open</string>' \
          '\t\t<string>--trusted-host</string>'
        printf '\t\t<string>%s</string>\n' "$DSH_TRUSTED_HOST"
        printf '%s\n' '\t</array>'
        printf '%s\n' '\t<key>EnvironmentVariables</key>' '\t<dict>'
        printf '\t\t<key>HOME</key>\n\t\t<string>%s</string>\n' "$HOME"
        printf '\t\t<key>DSH_HOME</key>\n\t\t<string>%s</string>\n' "$DSH_HOME_DIR"
        printf '\t\t<key>PATH</key>\n\t\t<string>%s</string>\n' "$(dsh_service_path)"
        printf '%s\n' '\t</dict>'
        printf '\t<key>WorkingDirectory</key>\n\t<string>%s</string>\n' "$HOME"
        printf '%s\n' '\t<key>RunAtLoad</key>' '\t<true/>'
        printf '%s\n' '\t<key>KeepAlive</key>' '\t<dict>' '\t\t<key>SuccessfulExit</key>' '\t\t<false/>' '\t</dict>'
        printf '%s\n' '\t<key>ThrottleInterval</key>' '\t<integer>10</integer>'
        printf '\t<key>StandardOutPath</key>\n\t<string>%s/logs/web.launchd.log</string>\n' "$DSH_HOME_DIR"
        printf '\t<key>StandardErrorPath</key>\n\t<string>%s/logs/web.launchd.log</string>\n' "$DSH_HOME_DIR"
        printf '%s\n' '</dict>' '</plist>'
      } > "$plist"
    fi
  fi
  say "launchctl bootout gui/$(id -u)/$DSH_LAUNCHD_LABEL; launchctl bootstrap gui/$(id -u) $plist"
  if [ "$DRY_RUN" != "1" ]; then
    launchctl bootout "gui/$(id -u)/$DSH_LAUNCHD_LABEL" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1; then
      warn "could not load the LaunchAgent; a machine with no GUI session needs a LaunchDaemon instead (see tools/dsh-launchd)"
    fi
  fi
}

# Linux: a systemd user unit plus lingering, so the service comes back after a
# reboot without an interactive login.
install_dsh_systemd() {
  unit_dir="$HOME/.config/systemd/user"
  unit="$unit_dir/$DSH_SYSTEMD_UNIT"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "no systemctl on this machine; DSH will not be kept resident. Start it with: $DSH_BIN web --host 127.0.0.1 --port 3080 --no-open"
    return 0
  fi
  if [ -f "$unit" ] && [ "$FORCE" != "1" ]; then
    note "the resident service is already installed: $unit (--force rewrites it)"
  else
    say "install -m 0644 <generated> $unit"
    if [ "$DRY_RUN" != "1" ]; then
      mkdir -p "$unit_dir" "$DSH_HOME_DIR/logs"
      {
        printf '%s\n' '[Unit]' 'Description=DeepSeek Harness Web UI' 'After=network-online.target' 'Wants=network-online.target' ''
        printf '%s\n' '[Service]' 'Type=simple'
        printf 'WorkingDirectory=%s\n' "$HOME"
        printf 'Environment=HOME=%s\n' "$HOME"
        printf 'Environment=DSH_HOME=%s\n' "$DSH_HOME_DIR"
        printf 'Environment=PATH=%s\n' "$(dsh_service_path)"
        printf 'ExecStart=%s web --host 127.0.0.1 --port 3080 --no-open --trusted-host %s\n' "$DSH_BIN" "$DSH_TRUSTED_HOST"
        printf '%s\n' 'Restart=always' 'RestartSec=5'
        printf 'StandardOutput=append:%s/logs/web.log\n' "$DSH_HOME_DIR"
        printf 'StandardError=append:%s/logs/web.log\n' "$DSH_HOME_DIR"
        printf '%s\n' '' '[Install]' 'WantedBy=default.target'
      } > "$unit"
    fi
  fi
  say "systemctl --user daemon-reload; systemctl --user enable --now $DSH_SYSTEMD_UNIT"
  if [ "$DRY_RUN" != "1" ]; then
    if ! systemctl --user daemon-reload >/dev/null 2>&1; then
      warn "this account has no systemd user session; run DSH as a system unit instead (see tools/dsh-netbird/dsh-web.service.template)"
      return 0
    fi
    systemctl --user enable --now "$DSH_SYSTEMD_UNIT" >/dev/null 2>&1 \
      || warn "could not start $DSH_SYSTEMD_UNIT; check: systemctl --user status $DSH_SYSTEMD_UNIT"
    if ! loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
      warn "could not enable lingering: the service stops at logout (run: sudo loginctl enable-linger $(id -un))"
    fi
  fi
  return 0
}

# Seed the model provider this fleet uses by default. The block below is a seed,
# not the full catalog: tools/dsh-netbird/llm-models.patch.yml carries the
# per-model context windows and `pnpm dsh-netbird:llm-apply` replaces this
# provider block by name once an administrator runs it. The API key itself is
# never written here: it is applied for at KAON_KEY_URL and pasted into DSH.
seed_kaon_provider() {
  dsh_profile="$DSH_HOME_DIR/profiles/web/cordis.patch.yml"
  if [ -f "$dsh_profile" ] && grep -q '^- id: llm-pi-ai' "$dsh_profile"; then
    note "the Web profile already configures a model provider; keeping it: $dsh_profile"
    return 0
  fi
  say "append the Kaon Router provider and the default model to $dsh_profile"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  mkdir -p "$DSH_HOME_DIR/profiles/web"
  if [ -f "$dsh_profile" ]; then
    # A freshly initialized profile is a comment header plus an explicit empty
    # flow sequence. Appending after that `[]` would make a second YAML document
    # and the profile would refuse to mount, so the marker line goes first.
    if [ "$(grep -v '^[[:space:]]*#' "$dsh_profile" | tr -d '[:space:]')" = "[]" ]; then
      pw_tmp="$dsh_profile.seed-write"
      grep -v '^\[\][[:space:]]*$' "$dsh_profile" > "$pw_tmp" || true
      mv "$pw_tmp" "$dsh_profile"
    fi
  fi
  cat >> "$dsh_profile" <<'DSH_LLM_SEED_EOF'

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      router:
        displayName: Kaon Router
        apiKeyEnv: KAON_ROUTER_API_KEY
        api: openai-completions
        baseURL: https://router.example.com/v1
        compat:
          supportsDeveloperRole: false
        requestImageMaxBytes: 524288
        maxRequestImageBytes: 1048576
        models:
          - id: kaon/deepseek-v4.1-flash
            name: kaon/deepseek-v4.1-flash
            contextWindow: 1000000
            maxTokens: 36384
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
              max: max
          - id: kaon/claude-opus-4-8
            name: kaon/claude-opus-4-8
            contextWindow: 1000000
            maxTokens: 128000
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
          - id: kaon/claude-sonnet-4-6
            name: kaon/claude-sonnet-4-6
            contextWindow: 1000000
            maxTokens: 64800
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
          - id: kaon/gpt-6.1-sol
            name: kaon/gpt-6.1-sol
            contextWindow: 1000000
            maxTokens: 128000
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
          - id: kaon/gemini-3.5-flash
            name: kaon/gemini-3.5-flash
            contextWindow: 1000000
            maxTokens: 32000
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
          - id: kaon/glm-5.3
            name: kaon/glm-5.3
            contextWindow: 1000000
            maxTokens: 36384
            input:
              - text
            reasoningEfforts:
              off: null
              low: low
              high: high
              max: max
          - id: kaon/kimi-k3
            name: kaon/kimi-k3
            contextWindow: 1000000
            maxTokens: 32000
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: router
    model: kaon/deepseek-v4.1-flash
    reasoningEffort: high
DSH_LLM_SEED_EOF
  say "seeded  router + kaon/deepseek-v4.1-flash as the default model"
}

# The service is started asynchronously; a boot that mounts the whole profile
# takes a few seconds the first time. Any HTTP answer proves the port serves.
dsh_wait_ready() {
  dsh_attempt=0
  while [ "$dsh_attempt" -lt 30 ]; do
    if dsh_port_answers; then
      return 0
    fi
    dsh_attempt=$((dsh_attempt + 1))
    sleep 3
  done
  return 1
}

# True when something already answers on the DSH port. That is how this script
# stays additive on a machine whose DSH was installed another way (an operator's
# LaunchDaemon or system unit): a second service on the same port would only
# fail to bind and restart-loop.
dsh_port_answers() {
  dsh_ready_code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3080/ 2>/dev/null || true)"
  case "$dsh_ready_code" in
    [1-5][0-9][0-9]) return 0 ;;
  esac
  return 1
}

# The one step this script cannot do for the user, and the reason the reminder
# exists: the model API key.
print_kaon_key_steps() {
  step "connect a model API"
  cat <<TXT
  DSH is installed and configured to use Kaon Router, so one API key is all
  that is missing:

    1. Apply for a key at $KAON_KEY_URL
       (Kaon Router admin console -> API keys).
    2. Fill it in: open http://127.0.0.1:3080/ , go to the model provider
       settings, choose Kaon Router and paste the key. Or put it in
       $DSH_HOME_DIR/.credentials.yaml under refs:

           refs:
             $KAON_KEY_REF: <the key you applied for>

    3. Until then DSH still starts and serves the UI, but every conversation
       fails with an authentication error.
TXT
}

# Install DSH, seed the model provider and keep `dsh web` resident. Every step
# is idempotent: an existing DSH, an existing provider block and an existing
# service unit are reused, and only --force replaces them.
install_dsh() {
  if [ "$(id -u)" = "0" ]; then
    warn "not installing DSH: run this installer as your own user, not as root (the resident service belongs to your account)"
    return 0
  fi

  step "installing DSH"
  dsh_found="$(command_path dsh)"
  if [ -n "$dsh_found" ] && [ "$FORCE" != "1" ]; then
    DSH_BIN="$dsh_found"
    note "using the DSH already on this machine: $DSH_BIN"
    if [ "$DRY_RUN" != "1" ]; then
      note "version $("$DSH_BIN" -V 2>/dev/null || echo unknown); --force installs the channel version"
    fi
  else
    node_bin="$(command_path node)"
    node_ok=0
    if [ -n "$node_bin" ]; then
      node_major="$(node_major_version "$node_bin")"
      case "$node_major" in
        ''|*[!0-9]*) node_ok=0 ;;
        *) if [ "$node_major" -ge 22 ]; then node_ok=1; fi ;;
      esac
    fi
    if [ "$node_ok" = "1" ]; then
      say "using the Node already on this machine: $node_bin ($("$node_bin" -v 2>/dev/null || echo 'version unknown'))"
    else
      if [ -n "$node_bin" ]; then
        note "the Node on PATH ($("$node_bin" -v 2>/dev/null || echo 'version unknown')) is older than 22; installing a private one"
      else
        note "no Node on this machine; installing a private one"
      fi
      install_private_node || { warn "DSH was not installed; install Node 22 and run this installer again"; return 0; }
    fi
    NPM="$(command_path npm)"
    if [ -z "$NPM" ]; then
      if [ "$DRY_RUN" = "1" ]; then
        NPM="npm"
      else
        warn "no npm on this machine; DSH was not installed"
        return 0
      fi
    fi
    npm_global_install "$DSH_PACKAGE@$DSH_VERSION" || { warn "npm could not install $DSH_PACKAGE; DSH was not installed"; return 0; }
    DSH_BIN="$(command_path dsh)"
    if [ "$DRY_RUN" = "1" ] && [ -z "$DSH_BIN" ]; then
      DSH_BIN="dsh"
    fi
    if [ -z "$DSH_BIN" ]; then
      warn "dsh is not on PATH after the npm install; add its directory to PATH and run this installer again"
      return 0
    fi
    if [ "$DRY_RUN" != "1" ]; then
      say "installed $DSH_BIN ($("$DSH_BIN" -V 2>/dev/null || echo 'version unknown'))"
    fi
  fi
  DSH_INSTALLED=1

  step "adding the Web GUI plugin"
  if [ -z "$(command_path pnpm)" ]; then
    note "the plugin command installs packages with pnpm; installing it now"
    npm_global_install pnpm || warn "pnpm could not be installed"
  fi
  say "$DSH_BIN plugin --profile web add $DSH_WEB_PLUGIN@latest"
  if [ "$DRY_RUN" != "1" ]; then
    "$DSH_BIN" plugin --profile web add "$DSH_WEB_PLUGIN@latest" \
      || warn "the Web GUI plugin did not install (an offline or private registry does this); DSH itself still works, run this later: $DSH_BIN plugin --profile web add $DSH_WEB_PLUGIN@latest"
  fi

  seed_kaon_provider

  if [ "$NO_SERVICE" = "1" ]; then
    step "not keeping DSH resident (--no-service)"
    say "run it for this session: $DSH_BIN web --host 127.0.0.1 --port 3080 --no-open"
  elif [ "$DRY_RUN" != "1" ] && dsh_port_answers; then
    step "a DSH service is already answering on this port"
    note "http://127.0.0.1:3080/ answered HTTP $dsh_ready_code before anything was installed"
    note "leaving that service alone; this machine's own entry stays as its administrator deployed it"
  else
    DSH_TRUSTED_HOST="$(dsh_trusted_host)"
    step "keeping DSH resident"
    say "local     http://127.0.0.1:3080/"
    say "address   http://$DSH_TRUSTED_HOST/ from your other machines"
    case "$OS" in
      darwin) install_dsh_launchagent ;;
      linux) install_dsh_systemd ;;
    esac
    DSH_RESIDENT=1
    if [ "$DRY_RUN" != "1" ]; then
      if dsh_wait_ready; then
        note "DSH answers on http://127.0.0.1:3080/ (HTTP $dsh_ready_code)"
      else
        warn "DSH did not answer on http://127.0.0.1:3080/ within 90s; see $DSH_HOME_DIR/logs"
      fi
    fi
  fi

  print_kaon_key_steps
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-service) NO_SERVICE=1 ;;
    --no-login) NO_LOGIN=1 ;;
    --no-dsh) NO_DSH=1 ;;
    --dsh-version) DSH_VERSION="${2:?--dsh-version needs a version}"; shift ;;
    --force) FORCE=1 ;;
    --qr) QR=1 ;;
    --no-browser) NO_BROWSER=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir needs a path}"; shift ;;
    --channel) CHANNEL="${2:?--channel needs a URL}"; shift ;;
    --management-url) MANAGEMENT_URL="${2:?--management-url needs a URL}"; shift ;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- platform ---
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "this installer supports macOS and Linux; on Windows use the installer from the onboarding page" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

# -------------------------------------------------------------- uninstall ----
if [ "$UNINSTALL" = "1" ]; then
  step "removing the client"
  FOUND=""
  if command -v netbird >/dev/null 2>&1; then
    FOUND="$(command -v netbird)"
  elif [ -x "$BIN_DIR/netbird" ]; then
    FOUND="$BIN_DIR/netbird"
  fi
  WRAPPER="$BIN_DIR/anywhere"
  # DSH has its own lifecycle: this removes only the resident service this
  # installer created. The npm package and $DSH_HOME (sessions, credentials)
  # belong to the user and are never deleted here.
  DSH_SERVICE_PRESENT=0
  if [ -f "$HOME/Library/LaunchAgents/$DSH_LAUNCHD_LABEL.plist" ] || [ -f "$HOME/.config/systemd/user/$DSH_SYSTEMD_UNIT" ]; then
    DSH_SERVICE_PRESENT=1
  fi
  if [ "$NO_DSH" = "0" ] && [ "$DSH_SERVICE_PRESENT" = "1" ]; then
    step "removing the resident DSH service"
    case "$OS" in
      darwin)
        say "launchctl bootout gui/$(id -u)/$DSH_LAUNCHD_LABEL"
        say "rm -f $HOME/Library/LaunchAgents/$DSH_LAUNCHD_LABEL.plist"
        if [ "$DRY_RUN" != "1" ]; then
          launchctl bootout "gui/$(id -u)/$DSH_LAUNCHD_LABEL" >/dev/null 2>&1 || true
          rm -f "$HOME/Library/LaunchAgents/$DSH_LAUNCHD_LABEL.plist"
        fi
        ;;
      linux)
        say "systemctl --user disable --now $DSH_SYSTEMD_UNIT"
        say "rm -f $HOME/.config/systemd/user/$DSH_SYSTEMD_UNIT"
        if [ "$DRY_RUN" != "1" ]; then
          systemctl --user disable --now "$DSH_SYSTEMD_UNIT" >/dev/null 2>&1 || true
          rm -f "$HOME/.config/systemd/user/$DSH_SYSTEMD_UNIT"
          systemctl --user daemon-reload >/dev/null 2>&1 || true
        fi
        ;;
    esac
    say "    DSH itself stays installed: $DSH_HOME_DIR and the npm package are kept"
  fi
  if [ -z "$FOUND" ] && [ ! -e "$WRAPPER" ]; then
    say "the client is not installed"
    exit 0
  fi
  if [ -n "$FOUND" ]; then
    say "client    $FOUND"
    for command in "down" "service stop" "service uninstall"; do
      say "$FOUND $command"
      if [ "$DRY_RUN" = "1" ]; then continue; fi
      case "$command" in
        down) "$FOUND" down || true ;;
        # shellcheck disable=SC2086
        *) as_root "$FOUND" $command || true ;;
      esac
    done
    say "rm -f $FOUND"
    [ "$DRY_RUN" = "1" ] || as_root rm -f "$FOUND"
  fi
  say "rm -f $WRAPPER"
  [ "$DRY_RUN" = "1" ] || as_root rm -f "$WRAPPER"
  say "    the machine's identity stays on the account server until an"
  say "    administrator deletes the peer from the dashboard"
  exit 0
fi

# ---------------------------------------------------------------- channel ----
for candidate in curl tar awk; do
  command -v "$candidate" >/dev/null 2>&1 || die "missing required command: $candidate"
done
SHA_TOOL=""
for candidate in shasum sha256sum; do
  if command -v "$candidate" >/dev/null 2>&1; then SHA_TOOL="$candidate"; break; fi
done
[ -n "$SHA_TOOL" ] || die "missing a SHA-256 tool (shasum or sha256sum)"

sha256_of() {
  if [ "$SHA_TOOL" = "shasum" ]; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/aw-install.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

step "resolving the client version"
if [ "$DRY_RUN" = "1" ]; then
  say "curl -fsSL $CHANNEL/latest.txt"
  VERSION="<latest>"
else
  curl -fsSL --max-time 30 -o "$TMP/latest.txt" "$CHANNEL/latest.txt" \
    || die "cannot reach the client channel: $CHANNEL/latest.txt"
  VERSION="$(head -n 1 "$TMP/latest.txt" | tr -d ' \r\n')"
  [ -n "$VERSION" ] || die "the channel returned an empty version file"
fi
say "channel   $CHANNEL"
say "platform  $OS-$ARCH"
say "version   $VERSION"

EXISTING="$(command -v netbird 2>/dev/null || true)"
NB="$EXISTING"
if [ -n "$EXISTING" ] && [ "$FORCE" != "1" ]; then
  step "using the client already on this machine"
  note "$EXISTING"
  [ "$DRY_RUN" = "1" ] || note "version $("$EXISTING" version 2>/dev/null || echo unknown)"
  note "re-run with --force to install the channel copy into $BIN_DIR instead"
  install_anywhere_command "$EXISTING"
  SKIP_DOWNLOAD=1
else
  SKIP_DOWNLOAD=0
  ARTIFACT="netbird_${VERSION}_${OS}_${ARCH}.tar.gz"
fi

if [ "$SKIP_DOWNLOAD" = "0" ]; then
  NB=""
  step "downloading $ARTIFACT"
  say "curl -fsSL -o <tmp>/$ARTIFACT $CHANNEL/$ARTIFACT"
  if [ "$DRY_RUN" != "1" ]; then
    curl -fL --retry 2 --retry-delay 2 --max-time 600 -o "$TMP/$ARTIFACT" "$CHANNEL/$ARTIFACT" \
      || die "download failed: $CHANNEL/$ARTIFACT"
    curl -fsSL --max-time 30 -o "$TMP/checksums.txt" "$CHANNEL/checksums.txt" \
      || die "cannot fetch $CHANNEL/checksums.txt; refusing to install unverified bits"
    EXPECTED="$(awk -v f="$ARTIFACT" '$2 == f { print $1 }' "$TMP/checksums.txt")"
    [ -n "$EXPECTED" ] || die "$ARTIFACT is not listed in the channel checksums"
    ACTUAL="$(sha256_of "$TMP/$ARTIFACT")"
    [ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $ARTIFACT (expected $EXPECTED, got $ACTUAL)"
    say "sha256    $ACTUAL (matches the channel)"

    step "unpacking"
    tar -xzf "$TMP/$ARTIFACT" -C "$TMP"
    [ -x "$TMP/netbird" ] || die "the archive does not contain the client binary"
    if [ "$OS" = "darwin" ]; then
      xattr -d com.apple.quarantine "$TMP/netbird" 2>/dev/null || true
    fi
  fi

  step "installing the client"
  TARGET="$BIN_DIR/netbird"
  say "install -m 0755 <tmp>/netbird $TARGET"
  if [ "$DRY_RUN" != "1" ]; then
    [ -d "$BIN_DIR" ] || as_root mkdir -p "$BIN_DIR"
    if [ -w "$BIN_DIR" ]; then
      install -m 0755 "$TMP/netbird" "$TARGET"
    else
      as_root install -m 0755 "$TMP/netbird" "$TARGET"
    fi
    NB="$TARGET"
    say "installed $TARGET ($("$TARGET" version 2>/dev/null || echo 'version unknown'))"
    case ":$PATH:" in
      *":$BIN_DIR:"*) ;;
      *) warn "$BIN_DIR is not on your PATH; call the client as $TARGET or add it to PATH" ;;
    esac
  fi
  install_anywhere_command "$TARGET"
fi

# ---------------------------------------------------------------- service ----
if [ "$NO_SERVICE" = "0" ]; then
  step "installing the background service"
  say "install and start the background service"
  if [ "$DRY_RUN" != "1" ]; then
    if "$NB" service status >/dev/null 2>&1; then
      note "the service is already installed"
    else
      as_root "$NB" service install
    fi
    as_root "$NB" service start >/dev/null 2>&1 || true
  fi
else
  step "starting the daemon for this session only (--no-service)"
  say "run the client daemon for this session only"
  if [ "$DRY_RUN" != "1" ]; then
    # Detach into its own session: a background child of this shell dies with
    # it, which is exactly what a container needs it not to do (measured: one
    # of three containers lost its daemon when the installing shell exited).
    if command -v setsid >/dev/null 2>&1; then
      setsid "$NB" service run --daemon-addr unix:///var/run/netbird.sock \
        --log-file "${TMPDIR:-/tmp}/netbird-client.log" >/dev/null 2>&1 &
    else
      nohup "$NB" service run --daemon-addr unix:///var/run/netbird.sock \
        --log-file "${TMPDIR:-/tmp}/netbird-client.log" >/dev/null 2>&1 &
    fi
    i=0
    while [ "$i" -lt 30 ]; do
      "$NB" status >/dev/null 2>&1 && break
      i=$((i + 1))
      sleep 1
    done
    "$NB" status >/dev/null 2>&1 || die "the daemon did not come up (see ${TMPDIR:-/tmp}/netbird-client.log)"
    note "daemon up"
  fi
fi

# ------------------------------------------------------------------ login ----
[ -n "$NB" ] || NB="$BIN_DIR/netbird"

if [ "$NO_LOGIN" = "0" ]; then
  step "logging in"
  if [ -z "$MANAGEMENT_URL" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      MANAGEMENT_URL="<from $CHANNEL/management-url.txt>"
    else
      MANAGEMENT_URL="$(curl -fsSL --max-time 20 "$CHANNEL/management-url.txt" 2>/dev/null | head -n 1 | tr -d ' \r\n' || true)"
    fi
  fi
  [ -n "$MANAGEMENT_URL" ] || die "no management URL available (pass --management-url)"
  UP_ARGS="up --management-url $MANAGEMENT_URL"
  [ -n "$PROFILE" ] && UP_ARGS="$UP_ARGS --profile $PROFILE"
  [ "$QR" = "1" ] && UP_ARGS="$UP_ARGS --qr"
  [ "$NO_BROWSER" = "1" ] && UP_ARGS="$UP_ARGS --no-browser"
  say "anywhere $UP_ARGS"
  note "a browser window opens: sign in with Feishu (default) or switch to"
  note "account + password. The same account on any machine puts those"
  note "machines into one private group that only you can see."
  if [ "$DRY_RUN" != "1" ]; then
    # shellcheck disable=SC2086
    # shellcheck disable=SC2086
    "$NB" $UP_ARGS \
      || die "the login did not complete; run 'anywhere up --management-url $MANAGEMENT_URL' again to get a fresh link"
    i=0
    while [ "$i" -lt 60 ]; do
      "$NB" status 2>/dev/null | grep -q 'Management: *Connected' && break
      i=$((i + 1))
      sleep 2
    done
    "$NB" status 2>/dev/null | grep -q 'Management: *Connected' \
      || warn "the client is not connected yet; check 'anywhere status'"
  fi
fi

# ------------------------------------------------------------------- dsh ----
# After the client: DSH is installed, seeded with the fleet's default model
# provider and kept resident, so the machine answers both locally and on its
# private-network name. A failure here never undoes the network client.
if [ "$NO_DSH" = "0" ]; then
  install_dsh
else
  step "skipping DSH (--no-dsh)"
  say "the private-network client is installed on its own"
fi

# ----------------------------------------------------------------- report ----
step "done"
if [ "$DRY_RUN" = "1" ]; then
  say "dry run: nothing was downloaded, installed or changed"
  exit 0
fi

FQDN="$("$NB" status 2>/dev/null | awk -F': ' '/^FQDN:/{print $2}' || true)"
IP="$("$NB" status --ipv4 2>/dev/null | head -n 1 | tr -d ' ' || true)"
[ -n "$FQDN" ] && say "machine   ${FQDN%%.*}"
[ -n "$IP" ] && say "address   $IP"

# The closing summary only claims what this run actually did: a root run, a
# --no-dsh run or a failed install must not promise a resident DSH.
if [ "$DSH_RESIDENT" = "1" ]; then
  DSH_NEXT="  3. DSH is installed and resident on this machine: http://127.0.0.1:3080/
     here, and http://dsh.<machine-name>.netbird/ once an administrator
     publishes that name (no port, no raw address).
  4. Its model access needs one key: apply for it at
     https://router-admin.example.com/ and paste it into DSH.
  5. Phones: open https://anywhere.example.com/ and install AnywhereWork."
elif [ "$DSH_INSTALLED" = "1" ]; then
  DSH_NEXT="  3. DSH is installed but not kept resident: run
     $DSH_BIN web --host 127.0.0.1 --port 3080 --no-open when you want it.
  4. Its model access needs one key: apply for it at
     https://router-admin.example.com/ and paste it into DSH.
  5. Phones: open https://anywhere.example.com/ and install AnywhereWork."
else
  DSH_NEXT="  3. Phones: open https://anywhere.example.com/ and install AnywhereWork."
fi
cat <<TXT

What happens next
  1. The account server gives this identity its own private group within about
     two minutes of the first login. Nothing to approve, nothing to click.
  2. Every machine you log into with the same account joins that group and can
     reach the others on any port; nobody else sees or reaches them.
$DSH_NEXT

Check it yourself
  anywhere status         Management and Signal both "Connected"
  anywhere machines       lists your own machines only
TXT