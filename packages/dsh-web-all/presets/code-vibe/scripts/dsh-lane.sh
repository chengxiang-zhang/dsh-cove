#!/usr/bin/env bash
# dsh-lane: worktree-per-task lane manager (prototype v0.1)
set -uo pipefail

LANE_ROOT="${LANE_ROOT:-/tmp/lane-design/lanes}"
REG="$LANE_ROOT/.lane-registry.jsonl"
MERGE_LOCK="$LANE_ROOT/.merge.lock"
MAX_LANES="${MAX_LANES:-4}"
MAX_LANES_TOTAL="${MAX_LANES_TOTAL:-8}"
TTL_HOURS="${TTL_HOURS:-48}"
HARD_TTL_HOURS="${HARD_TTL_HOURS:-96}"
DSH_BASE="${DSH_BASE:-}"
DSH_TOKEN_FILE="${DSH_TOKEN_FILE:-}"
SETUP_SCRIPT_NAME="${SETUP_SCRIPT_NAME:-.dsh-lane-setup.sh}"
TASK_RE='^[a-z0-9][a-z0-9-]{2,40}$'

die(){ echo "dsh-lane: $*" >&2; exit 1; }
now_iso(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch(){ date -u +%s; }
iso_to_epoch(){ date -u -d "$1" +%s 2>/dev/null || echo 0; }
ensure_root(){ mkdir -p "$LANE_ROOT" "$LANE_ROOT/.trash"; touch "$REG"; }
repo_toplevel(){ git -C "$1" rev-parse --show-toplevel 2>/dev/null; }
repo_common_dir(){ git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | xargs -r dirname 2>/dev/null; }
repo_name(){ basename "$(repo_toplevel "$1")"; }
lane_path(){ echo "$LANE_ROOT/$(repo_name "$1")/$2"; }
count_lanes(){ local repo="$1"; python3 - "$REG" "$repo" <<'PY'
import json,sys
reg,repo=sys.argv[1],sys.argv[2]; n=t=0
try:
  for line in open(reg):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("status")!="open": continue
    t+=1
    if d.get("repo")==repo: n+=1
except FileNotFoundError: pass
print(n,t)
PY
}
reg_add(){ python3 - "$REG" "$@" <<'PY'
import json,sys
reg=sys.argv[1]; rec=dict(zip(["repo","taskId","branch","path","owner","createdAt","status"],sys.argv[2:9]))
with open(reg,"a") as f: f.write(json.dumps(rec,ensure_ascii=False)+"\n")
print("registered",rec["taskId"])
PY
}
reg_find(){ python3 - "$REG" "$1" "$2" <<'PY'
import json,sys
reg,field,val=sys.argv[1],sys.argv[2],sys.argv[3]
try:
  for line in open(reg):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if str(d.get(field))==val and d.get("status")=="open": print(json.dumps(d,ensure_ascii=False)); break
except FileNotFoundError: pass
PY
}
reg_set_status(){ python3 - "$REG" "$1" "$2" <<'PY'
import json,sys
reg,task,status=sys.argv[1],sys.argv[2],sys.argv[3]; rows=[]
try:
  for line in open(reg):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("taskId")==task: d["status"]=status
    rows.append(d)
except FileNotFoundError: pass
open(reg,"w").write("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+("\n" if rows else ""))
print("status",task,"->",status)
PY
}
reg_set_field(){ python3 - "$REG" "$1" "$2" "$3" <<'PY'
import json,sys
reg,task,field,val=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]; rows=[]
for line in open(reg):
  line=line.strip()
  if not line: continue
  d=json.loads(line)
  if d.get("taskId")==task: d[field]=val
  rows.append(d)
open(reg,"w").write("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+("\n" if rows else ""))
PY
}
dsh_rpc(){ # method json-args
  [ -n "$DSH_BASE" ] || return 3
  local tok=""; [ -n "$DSH_TOKEN_FILE" ] && tok=$(grep -o 'token=[A-Za-z0-9_-]*' "$DSH_TOKEN_FILE" | tail -1 | cut -d= -f2)
  curl -s -m 15 -X POST "$DSH_BASE/api/$1" -H 'content-type: application/json' \
    -H "referer: $DSH_BASE/" \
    -d "{\"type\":\"client-request\",\"rpcId\":\"lane$RANDOM\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"
}

cmd_create(){ local repo="$1" task="$2" owner="${3:-$USER}"
  ensure_root
  [[ "$task" =~ $TASK_RE ]] || die "invalid task-id: $task"
  local top; top=$(repo_toplevel "$repo") || die "not a git repo: $repo"
  local lpath; lpath=$(lane_path "$top" "$task")
  case "$lpath" in "$top"/*) die "I2: lane path must be outside repo ($lpath)";; esac
  local branch="task/$task"
  git -C "$top" show-ref --verify --quiet "refs/heads/$branch" && die "I3: branch exists: $branch"
  [ -z "$(reg_find taskId "$task")" ] || die "I3: task-id already registered: $task"
  read -r n t < <(count_lanes "$(repo_name "$top")")
  [ "$n" -lt "$MAX_LANES" ] || die "I5: repo lane limit reached ($n/$MAX_LANES)"
  [ "$t" -lt "$MAX_LANES_TOTAL" ] || die "I5: global lane limit reached ($t/$MAX_LANES_TOTAL)"
  mkdir -p "$(dirname "$lpath")"
  git -C "$top" worktree add -q -b "$branch" "$lpath" HEAD || die "worktree add failed"
  reg_add "$(repo_name "$top")" "$task" "$branch" "$lpath" "$owner" "$(now_iso)" open >/dev/null
  echo "created $task -> $lpath [$branch]"
}

cmd_setup(){ local task="$1"; local rec; rec=$(reg_find taskId "$task") || true; [ -n "$rec" ] || die "unknown lane: $task"
  local lpath top; lpath=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["path"])' "$rec")
  top=$(repo_common_dir "$lpath")
  [ -f "$lpath/$SETUP_SCRIPT_NAME" ] || true
  # carry gitignored env files (exclude production secrets), own caches
  shopt -s nullglob
  for f in "$top"/.env*; do case "$f" in *".env.production"*) echo "skip $f (production secret)";; *) cp -n "$f" "$lpath/" 2>/dev/null && echo "copied $(basename "$f")";; esac; done
  shopt -u nullglob
  mkdir -p "$lpath/.cache/cargo" "$lpath/.cache/pyc" "$lpath/.cache/npm" "$lpath/.cache/build"
  local base; base=$(python3 - "$REG" "$(repo_name "$top")" <<'PY'
import json,sys,hashlib
reg,repo=sys.argv[1],sys.argv[2]; n=0
try:
  for line in open(reg):
    d=json.loads(line)
    if d.get("status")=="open" and d.get("repo")==repo: n+=1
except FileNotFoundError: pass
print(20000+ n*100)
PY
)
  local gd; gd=$(git -C "$lpath" rev-parse --absolute-git-dir)
  local cd; cd=$(git -C "$lpath" rev-parse --path-format=absolute --git-common-dir)
  grep -qx '.lane.env' "$cd/info/exclude" 2>/dev/null || echo '.lane.env' >> "$cd/info/exclude"
  cat > "$lpath/.lane.env" <<ENV
LANE_TASK=$task
LANE_REPO=$(repo_name "$top")
LANE_PORT_BASE=$base
CARGO_TARGET_DIR=$lpath/.cache/cargo
PYTHONPYCACHEPREFIX=$lpath/.cache/pyc
npm_config_cache=$lpath/.cache/npm
ENV
  [ -x "$lpath/$SETUP_SCRIPT_NAME" ] && ( cd "$lpath" && bash "$SETUP_SCRIPT_NAME" )
  echo "setup ok $task"
}

cmd_sessions(){ local task="$1"; local rec; rec=$(reg_find taskId "$task") || true; [ -n "$rec" ] || die "unknown lane: $task"
  local lpath; lpath=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["path"])' "$rec")
  [ -n "$DSH_BASE" ] || die "DSH_BASE not set"
  dsh_rpc session/list '{"_request":{}}' | python3 -c '
import json,sys
lane=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for s in d.get("result",{}).get("value",{}).get("items",[]):
    if s.get("cwd")==lane: print(s["sessionId"])
' "$lpath"
}
cmd_archive(){ local task="$1"; local rec; rec=$(reg_find taskId "$task") || true; [ -n "$rec" ] || die "unknown lane: $task"
  [ -n "$DSH_BASE" ] || { echo "archive skipped: DSH_BASE not set"; return 0; }
  local ids; ids=$(cmd_sessions "$task")
  [ -z "$ids" ] && { echo "no lane sessions to archive"; return 0; }
  for sid in $ids; do dsh_rpc workspace/archiveSession "{\"request\":{\"sessionId\":\"$sid\",\"stopActivity\":true}}" >/dev/null 2>&1 && echo "archived $sid"; done
}
cmd_register(){ local task="$1"; local rec; rec=$(reg_find taskId "$task") || true; [ -n "$rec" ] || die "unknown lane: $task"
  echo "NOTE: register is optional; default lane sessions stay ungrouped (no extra DSH project). Use only if you want a project.";
  local lpath; lpath=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["path"])' "$rec")
  local out rc; out=$(dsh_rpc workspace/create "{\"request\":{\"path\":\"$(printf '%s' "$lpath" | sed 's/"/\\"/g')\"}}"); rc=$?
  [ $rc -eq 3 ] && { echo "register skipped: DSH_BASE not set"; return 0; }
  local wid; wid=$(python3 -c 'import json,sys
try:
  d=json.loads(sys.argv[1]); print(d["result"]["value"]["workspace"]["workspaceId"])
except Exception: print("")' "$out")
  [ -n "$wid" ] || die "workspace/create failed: $out"
  reg_set_field "$task" workspaceId "$wid"
  echo "registered workspace $wid"
}

cmd_check(){ local task="$1"; local rec; rec=$(reg_find taskId "$task") || true; [ -n "$rec" ] || die "I1: lane not registered: $task"
  local lpath; lpath=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["path"])' "$rec")
  [ -d "$lpath" ] || die "lane dir missing: $lpath"
  local branch; branch=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["branch"])' "$rec")
  [ "$(git -C "$lpath" rev-parse --abbrev-ref HEAD)" = "$branch" ] || die "branch mismatch in lane"
  [ -f "$lpath/.lane.env" ] || die "I7: setup missing (.lane.env)"
  echo "check ok $task"
}

cmd_merge(){ local task="$1"; local rec; rec=$(reg_find taskId "$task") || true; [ -n "$rec" ] || die "unknown lane"
  local lpath branch; lpath=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["path"])' "$rec"); branch=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["branch"])' "$rec")
  local top; top=$(repo_common_dir "$lpath")
  local main_branch; main_branch=$(git -C "$top" rev-parse --abbrev-ref HEAD)
  local base; base=$(git -C "$top" merge-base "$main_branch" "$branch")
  exec 9>"$MERGE_LOCK"; flock -n 9 || die "I9: another merge is running"
  local mt; mt=$(git -C "$top" merge-tree "$base" "$main_branch" "$branch" 2>&1 || true)
  if printf '%s' "$mt" | grep -q '<<<<<<<'; then echo "CONFLICT preflight detected; merge aborted" >&2; exit 20; fi
  git -C "$top" merge --no-ff -m "merge $branch" "$branch" || { echo "merge failed" >&2; exit 21; }
  echo "merged $branch -> $main_branch"
}

cmd_drop(){ local task="$1" force="${2:-}"; local rec; rec=$(reg_find taskId "$task") || true; [ -n "$rec" ] || die "unknown lane"
  local lpath branch wid; lpath=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["path"])' "$rec"); branch=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["branch"])' "$rec"); wid=$(python3 -c 'import json,sys;d=json.loads(sys.argv[1]);print(d.get("workspaceId",""))' "$rec")
  local top; top=$(repo_common_dir "$lpath")
  cmd_archive "$task" >/dev/null 2>&1 || true
  [ -n "$wid" ] && dsh_rpc workspace/delete "{\"request\":{\"workspaceId\":\"$wid\"}}" >/dev/null 2>&1 || true
  if [ "$force" = "--force" ]; then git -C "$top" worktree remove --force "$lpath" 2>/dev/null || rm -rf "$lpath"; else git -C "$top" worktree remove "$lpath" 2>/dev/null || true; fi
  git -C "$top" branch -D "$branch" >/dev/null 2>&1 || true
  git -C "$top" worktree prune
  reg_set_status "$task" closed >/dev/null
  echo "dropped $task"
}

cmd_list(){ ensure_root; echo "OPEN LANES (max repo=$MAX_LANES total=$MAX_LANES_TOTAL ttl=${TTL_HOURS}h hard=${HARD_TTL_HOURS}h)"; python3 - "$REG" "$TTL_HOURS" "$HARD_TTL_HOURS" <<'PY'
import json,sys,time
reg,ttl,hard=sys.argv[1],float(sys.argv[2]),float(sys.argv[3])
now=time.time(); rows=[]
try:
  for line in open(reg):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("status")!="open": continue
    age=(now-time.mktime(time.strptime(d["createdAt"],"%Y-%m-%dT%H:%M:%SZ")))/3600
    state="ok" if age<ttl else ("stale" if age<hard else "EXPIRED")
    rows.append((d["taskId"],d["repo"],d["branch"],round(age,1),state,d["path"]))
except FileNotFoundError: pass
for r in rows: print("%-24s %-16s %-28s age=%-6s %-8s %s"%r)
print("count",len(rows))
PY
}
cmd_audit(){ local repo="$1"; local top; top=$(repo_toplevel "$repo") || die "not a repo"
  local bad=0
  while IFS= read -r line; do
    local p; p=$(printf '%s' "$line" | sed -E 's/^worktree //')
    [ "$p" = "$top" ] && continue
    case "$p" in "$LANE_ROOT"/*) : ;; *) echo "VIOLATION unregistered worktree outside lane-root: $p"; bad=1;; esac
    python3 - "$REG" "$p" <<'PY' || bad=1
import json,sys
reg,p=sys.argv[1],sys.argv[2]
for line in open(reg):
  line=line.strip()
  if not line: continue
  d=json.loads(line)
  if d.get("path")==p and d.get("status")=="open": sys.exit(0)
print("VIOLATION worktree not registered:",p); sys.exit(1)
PY
  done < <(git -C "$top" worktree list --porcelain | grep '^worktree ')
  [ $bad -eq 0 ] && echo "audit ok: all worktrees registered under $LANE_ROOT" || exit 1
}
cmd_gc(){ ensure_root; python3 - "$REG" "$HARD_TTL_HOURS" "$LANE_ROOT" <<'PY'
import json,sys,time,subprocess,os,shutil
reg,hard,root=sys.argv[1],float(sys.argv[2]),sys.argv[3]
now=time.time(); rows=[]; toforce=[]
for line in open(reg):
  line=line.strip()
  if not line: continue
  d=json.loads(line)
  if d.get("status")!="open": rows.append(d); continue
  age=(now-time.mktime(time.strptime(d["createdAt"],"%Y-%m-%dT%H:%M:%SZ")))/3600
  if age>=hard: toforce.append(d)
  rows.append(d)
for d in toforce:
  p=d["path"]; repo=d["repo"]
  trash=os.path.join(root,".trash",d["taskId"]+"-"+str(int(now)))
  os.makedirs(trash,exist_ok=True)
  if os.path.isdir(p):
    subprocess.run(["cp","-a",p,trash],capture_output=True)
    top=subprocess.run(["git","-C",p,"rev-parse","--show-toplevel"],capture_output=True,text=True).stdout.strip()
    if top: subprocess.run(["git","-C",top,"worktree","remove","--force",p],capture_output=True)
    shutil.rmtree(p,ignore_errors=True)
  d["status"]="closed"
  print("gc forced",d["taskId"],"->",trash)
open(reg,"w").write("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+("\n" if rows else ""))
PY
}

usage(){ echo "usage: dsh-lane {create <repo> <task-id> | setup <task> | check <task> | merge <task> | drop <task> [--force] | list | audit <repo> | gc | sessions <task> | archive <task> | register <task>(optional project)}"; }
cmd="${1:-}"; shift || true
case "$cmd" in
  create) cmd_create "$@";; setup) cmd_setup "$@";; register) cmd_register "$@";; check) cmd_check "$@";;
  merge) cmd_merge "$@";; drop) cmd_drop "$@";; list) cmd_list;; audit) cmd_audit "$@";; gc) cmd_gc;;
  sessions) cmd_sessions "$@";; archive) cmd_archive "$@";;
  *) usage; exit 2;;
esac
