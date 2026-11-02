#!/usr/bin/env bash
# red/green tests for dsh-lane prototype
set -uo pipefail
LANE=/tmp/lane-design/dsh-lane.sh
WORK=/tmp/lane-design/testbed
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "PASS $*"; }
no(){ FAIL=$((FAIL+1)); echo "FAIL $*"; }
rm -rf "$WORK"; mkdir -p "$WORK/repo/src"
cd "$WORK/repo"
printf 'def greet():\n    return "hello"\n' > src/app.py
printf 'node_modules/\n.env*\n.cache/\n' > .gitignore
git init -q; git add -A; git -c user.email=a@b -c user.name=t commit -qm init
export LANE_ROOT="$WORK/lanes" MAX_LANES=2 MAX_LANES_TOTAL=8 TTL_HOURS=48 HARD_TTL_HOURS=96

# T1 invalid task-id
if $LANE create "$WORK/repo" "Bad_ID!" >/dev/null 2>&1; then no "invalid id rejected"; else ok "invalid id rejected"; fi

# T2 create two lanes
if $LANE create "$WORK/repo" task-one >/dev/null 2>&1; then ok "create lane1"; else no "create lane1"; fi
if $LANE create "$WORK/repo" task-two >/dev/null 2>&1; then ok "create lane2"; else no "create lane2"; fi

# T3 duplicate branch / duplicate id
if $LANE create "$WORK/repo" task-one >/dev/null 2>&1; then no "duplicate id rejected"; else ok "duplicate id rejected"; fi

# T4 limit (MAX_LANES=2)
if $LANE create "$WORK/repo" task-three >/dev/null 2>&1; then no "lane limit enforced"; else ok "lane limit enforced"; fi

# T5 lane-root inside repo rejected
LANE_ROOT="$WORK/repo/.lanes" $LANE create "$WORK/repo" task-inside >/dev/null 2>&1 && no "inside-repo lane rejected" || ok "inside-repo lane rejected"

# T6 check before setup fails
$LANE check task-one >/dev/null 2>&1 && no "check fails before setup" || ok "check fails before setup"

# T7 setup + check
$LANE setup task-one >/dev/null 2>&1 && ok "setup lane1" || no "setup lane1"
$LANE setup task-two >/dev/null 2>&1 && ok "setup lane2" || no "setup lane2"
$LANE check task-one >/dev/null 2>&1 && ok "check ok after setup" || no "check ok after setup"

# T8 audit: registered lanes pass
$LANE audit "$WORK/repo" >/dev/null 2>&1 && ok "audit ok for registered lanes" || no "audit ok for registered lanes"

# T9 unregistered worktree outside lane-root -> violation
git worktree add -q -b evil "$WORK/evil-wt" HEAD
$LANE audit "$WORK/repo" >/dev/null 2>&1 && no "audit catches unregistered worktree" || ok "audit catches unregistered worktree"
git worktree remove --force "$WORK/evil-wt" >/dev/null 2>&1; git branch -D evil >/dev/null 2>&1

# T10 conflict preflight + serial merge
L1="$WORK/lanes/repo/task-one"; L2="$WORK/lanes/repo/task-two"
sed -i 's/return "hello"/return "hello-one"/' "$L1/src/app.py"
git -C "$L1" -c user.email=a@b -c user.name=t commit -qam "one"
sed -i 's/return "hello"/return "hello-two"/' "$L2/src/app.py"
git -C "$L2" -c user.email=a@b -c user.name=t commit -qam "two"
$LANE merge task-one >/dev/null 2>&1 && ok "merge lane1 clean" || no "merge lane1 clean"
$LANE merge task-two >/dev/null 2>&1; rc=$?
[ "$rc" -eq 20 ] && ok "conflict preflight blocks merge (rc=20)" || no "conflict preflight blocks merge (rc=$rc)"
git merge --abort >/dev/null 2>&1

# T11 the owner resolves in-lane (merge main into lane, fix conflict) then merge succeeds
git -C "$L2" merge main >/dev/null 2>&1 || true
sed -i 's/return "hello-one"/return "hello-one-and-two"/' "$L2/src/app.py"
git -C "$L2" add src/app.py
git -C "$L2" -c user.email=a@b -c user.name=t commit -qm "resolve: keep both" >/dev/null 2>&1 || true
git -C "$WORK/repo" merge --no-ff -m "merge two resolved" task/task-two >/dev/null 2>&1 && ok "merge after resolution" || no "merge after resolution"

# T12 drop cleans up
$LANE drop task-one --force >/dev/null 2>&1 && ok "drop lane1" || no "drop lane1"
[ ! -d "$L1" ] && ok "lane1 dir removed" || no "lane1 dir removed"
git -C "$WORK/repo" show-ref --verify --quiet refs/heads/task/task-one && no "lane1 branch deleted" || ok "lane1 branch deleted"

# T13 gc: forge old created time then force-collect
python3 - "$LANE_ROOT/.lane-registry.jsonl" <<'PY'
import json,sys,datetime
p=sys.argv[1]; rows=[]
for line in open(p):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d["taskId"]=="task-two":
        old=datetime.datetime.utcnow()-datetime.timedelta(hours=100)
        d["createdAt"]=old.strftime("%Y-%m-%dT%H:%M:%SZ")
    rows.append(d)
open(p,"w").write("\n".join(json.dumps(r) for r in rows)+"\n")
PY
$LANE list | grep -q EXPIRED && ok "list flags expired lane" || no "list flags expired lane"
$LANE gc >/dev/null 2>&1 && ok "gc runs" || no "gc runs"
grep -q '"status": "closed"' "$LANE_ROOT/.lane-registry.jsonl" && ok "gc closed expired lane" || no "gc closed expired lane"

echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
