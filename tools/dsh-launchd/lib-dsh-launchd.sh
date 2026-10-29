# shellcheck shell=sh
# Pure helpers shared by install-dsh-daemons.sh (entry point, zsh) and the
# launcher it materializes.
#
# The entry point runs as `sudo zsh install-dsh-daemons.sh`, so this file is
# POSIX sh: the same functions work under zsh and under /bin/sh, which is how
# scripts/dsh-launchd-templates.test.mjs exercises them. Every function takes
# its inputs as arguments, writes its result to stdout, reports failure as a
# message on stderr plus a non-zero exit status, and changes nothing on the
# machine.

# Placeholder tokens launchd/start-dsh-web.sh carries (sorted). The installer
# replaces exactly these and the template must contain nothing else; the
# template placeholder test pins both sides to this list.
DSH_LAUNCHD_TEMPLATE_PLACEHOLDERS='__DSH_BIN_DIR__ __DSH_HOME__ __HOME__ __TRUSTED_HOST_FLAGS__'

# Authority syntax shared by every check below: a DNS name with at least one
# dot, no scheme, no port, no path, and never an IPv4 literal. Values that do
# not match are refused instead of being handed to --trusted-host.
DSH_LAUNCHD_AUTHORITY_AWK='
function dsh_authority_ok(a) {
  if (a == "") return 0
  if (a !~ /^[A-Za-z0-9.-]+$/) return 0
  if (a !~ /\./) return 0
  if (a ~ /^[.-]/ || a ~ /[.-]$/) return 0
  if (a ~ /\.\./) return 0
  if (a ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) return 0
  return 1
}
'

# dsh_launchd_authority_is_valid <authority>
dsh_launchd_authority_is_valid() {
  if [ $# -ne 1 ]; then
    echo "dsh_launchd_authority_is_valid takes exactly one authority" >&2
    return 2
  fi
  DSH_LAUNCHD_CHECKED_AUTHORITY=$1 awk "$DSH_LAUNCHD_AUTHORITY_AWK"'
    BEGIN { exit(dsh_authority_ok(ENVIRON["DSH_LAUNCHD_CHECKED_AUTHORITY"]) ? 0 : 1) }
  ' </dev/null
}

# dsh_launchd_machine_domain <machines.json> <netbirdName>
# Prints the domain recorded for that machine. Order-independent within an
# entry; refuses to guess when the name is absent.
dsh_launchd_machine_domain() {
  if [ $# -ne 2 ]; then
    echo "dsh_launchd_machine_domain takes <machines.json> <netbirdName>" >&2
    return 2
  fi
  if [ ! -f "$1" ]; then
    echo "netbird machine list not found: $1" >&2
    return 1
  fi
  if [ -z "$2" ]; then
    echo "netbird machine name is empty" >&2
    return 1
  fi
  DSH_LAUNCHD_MACHINE_NAME=$2 awk "$DSH_LAUNCHD_AUTHORITY_AWK"'
    BEGIN { RS = "}"; target = ENVIRON["DSH_LAUNCHD_MACHINE_NAME"] }
    {
      obj = $0
      name = ""
      dom = ""
      if (match(obj, /"netbirdName"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        name = substr(obj, RSTART, RLENGTH)
        sub(/^"[^"]*"[[:space:]]*:[[:space:]]*"/, "", name)
        sub(/"$/, "", name)
      }
      if (match(obj, /"domain"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        dom = substr(obj, RSTART, RLENGTH)
        sub(/^"[^"]*"[[:space:]]*:[[:space:]]*"/, "", dom)
        sub(/"$/, "", dom)
      }
      if (name == target && dom != "" && !found) { print dom; found = 1 }
    }
    END { if (!found) exit 1 }
  ' "$1"
}

# dsh_launchd_authorities <machines.json> <hosts-newline-list> <machines-newline-list>
# Prints the deduplicated canonical authorities in argument order. Fails closed:
# no output, a message on stderr and a non-zero status when any input is not a
# canonical authority, when a machine name is unknown, or when the result is
# empty. The installer calls this before it changes anything.
dsh_launchd_authorities() {
  if [ $# -ne 3 ]; then
    echo "dsh_launchd_authorities takes <machines.json> <hosts> <machines>" >&2
    return 2
  fi
  input=/dev/null
  if [ -n "$3" ]; then
    if [ ! -f "$1" ]; then
      echo "netbird machine list not found: $1" >&2
      return 1
    fi
    input=$1
  fi
  DSH_LAUNCHD_HOSTS=$2 DSH_LAUNCHD_MACHINES=$3 awk "$DSH_LAUNCHD_AUTHORITY_AWK"'
    BEGIN {
      RS = "}"
      nh = split(ENVIRON["DSH_LAUNCHD_HOSTS"], h, "\n")
      nm = split(ENVIRON["DSH_LAUNCHD_MACHINES"], m, "\n")
    }
    {
      obj = $0
      name = ""
      dom = ""
      if (match(obj, /"netbirdName"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        name = substr(obj, RSTART, RLENGTH)
        sub(/^"[^"]*"[[:space:]]*:[[:space:]]*"/, "", name)
        sub(/"$/, "", name)
      }
      if (match(obj, /"domain"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        dom = substr(obj, RSTART, RLENGTH)
        sub(/^"[^"]*"[[:space:]]*:[[:space:]]*"/, "", dom)
        sub(/"$/, "", dom)
      }
      if (name != "" && dom != "") domain[name] = dom
    }
    END {
      bad = 0
      n = 0
      for (i = 1; i <= nh; i++) {
        if (h[i] == "") continue
        if (!dsh_authority_ok(h[i])) {
          printf "not a canonical authority: %s\n", h[i] > "/dev/stderr"
          bad = 1
          continue
        }
        if (!(h[i] in seen)) { seen[h[i]] = 1; ordered[++n] = h[i] }
      }
      for (i = 1; i <= nm; i++) {
        if (m[i] == "") continue
        if (!(m[i] in domain)) {
          printf "unknown netbird machine: %s\n", m[i] > "/dev/stderr"
          bad = 1
          continue
        }
        d = domain[m[i]]
        if (!dsh_authority_ok(d)) {
          printf "machine %s has no canonical authority: %s\n", m[i], d > "/dev/stderr"
          bad = 1
          continue
        }
        if (!(d in seen)) { seen[d] = 1; ordered[++n] = d }
      }
      if (bad) exit 1
      if (n == 0) {
        print "no trusted authority given: pass --trusted-host <authority> or --machine <netbirdName>" > "/dev/stderr"
        exit 1
      }
      for (i = 1; i <= n; i++) print ordered[i]
    }
  ' "$input"
}

# Reads newline-separated authorities on stdin, prints them as one
# `--trusted-host <authority>` flag each, space separated.
dsh_launchd_trusted_host_flags() {
  awk '
    {
      if ($0 == "") next
      flags = flags (flags == "" ? "" : " ") "--trusted-host " $0
    }
    END { print flags }
  '
}

# dsh_launchd_sed_escape <value>
dsh_launchd_sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&]/\\&/g'
}

# dsh_launchd_render_launcher <template> <bin-dir> <home> <dsh-home> <authorities-newline-list>
# Prints the launcher with every placeholder substituted. Fails closed when the
# template is missing, is not a template, or no authority was supplied.
dsh_launchd_render_launcher() {
  if [ $# -ne 5 ]; then
    echo "dsh_launchd_render_launcher takes <template> <bin-dir> <home> <dsh-home> <authorities>" >&2
    return 2
  fi
  if [ ! -f "$1" ]; then
    echo "launcher template not found: $1" >&2
    return 1
  fi
  if ! grep -q -e '__TRUSTED_HOST_FLAGS__' "$1"; then
    echo "not a launcher template (no __TRUSTED_HOST_FLAGS__): $1" >&2
    return 1
  fi
  flags=$(printf '%s\n' "$5" | dsh_launchd_trusted_host_flags)
  if [ -z "$flags" ]; then
    echo "no trusted authority to pass to --trusted-host" >&2
    return 1
  fi
  sed \
    -e "s|__DSH_BIN_DIR__|$(dsh_launchd_sed_escape "$2")|g" \
    -e "s|__DSH_HOME__|$(dsh_launchd_sed_escape "$4")|g" \
    -e "s|__HOME__|$(dsh_launchd_sed_escape "$3")|g" \
    -e "s|__TRUSTED_HOST_FLAGS__|$(dsh_launchd_sed_escape "$flags")|g" \
    "$1"
}

# dsh_launchd_launcher_has_trusted_host <launcher>
# Comment lines are ignored, so the template header explaining
# `--trusted-host` never counts as a configured authority.
dsh_launchd_launcher_has_trusted_host() {
  if [ $# -ne 1 ]; then
    echo "dsh_launchd_launcher_has_trusted_host takes exactly one launcher path" >&2
    return 2
  fi
  if [ ! -f "$1" ]; then
    echo "launcher not found: $1" >&2
    return 1
  fi
  grep -v -e '^[[:space:]]*#' "$1" | grep -q -e '--trusted-host'
}

# dsh_launchd_launcher_decision <launcher> <rewrite 0|1>
# Prints "write" when the installer must (re)materialize the launcher, and
# "keep" when an existing launcher already passes --trusted-host and no
# rewrite was requested. A launcher written against a stale or foreign
# authority is still a launcher carrying the flag, so it is kept and reported.
dsh_launchd_launcher_decision() {
  if [ $# -ne 2 ]; then
    echo "dsh_launchd_launcher_decision takes <launcher> <rewrite>" >&2
    return 2
  fi
  if [ "$2" = "1" ]; then
    printf 'write\n'
    return 0
  fi
  if [ -f "$1" ] && dsh_launchd_launcher_has_trusted_host "$1"; then
    printf 'keep\n'
    return 0
  fi
  printf 'write\n'
}

# dsh_launchd_plist_first_path_dir <plist>
# Prints the first component of the daemon EnvironmentVariables PATH, which is
# the directory holding the dsh executable the daemon already runs.
dsh_launchd_plist_first_path_dir() {
  if [ $# -ne 1 ]; then
    echo "dsh_launchd_plist_first_path_dir takes exactly one plist path" >&2
    return 2
  fi
  if [ ! -f "$1" ]; then
    echo "plist not found: $1" >&2
    return 1
  fi
  awk '
    /<key>PATH<\/key>/ { seen = 1; next }
    seen && /<string>/ {
      line = $0
      sub(/^[[:space:]]*<string>/, "", line)
      sub(/<\/string>[[:space:]]*$/, "", line)
      split(line, parts, ":")
      if (parts[1] != "") { print parts[1]; found = 1 }
      exit
    }
    END { if (!found) exit 1 }
  ' "$1"
}
