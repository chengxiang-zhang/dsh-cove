#!/usr/bin/env python3
"""M1: Lead scope check — 检查 Lead 是否越界改实现文件。

用法:
  python3 scripts/check_lead_scope.py --root <repo> [--since HEAD~1] [--allow <prefix> ...] [--include-worktree]

规则（终稿 v5）:
  - Lead 不得改 `scripts/**`、`deploy/**`、`installer/**`
  - Lead 不得改包内 `VERSION.md/contract.md/tests.md/plan.md/run.md`
  - 允许: 账本/宪章/批次/程序级控制文件（INDEX/INTERFACES/INTEGRATION/EFFICIENCY/EXECUTION-LOOP/BATCH-STATE/HANDOFF）/板卡/commit
退出码: 0 通过；1 越界；2 用法错。
"""
import argparse, subprocess, sys
from pathlib import Path

FORBIDDEN_PREFIX = ("scripts/", "deploy/", "installer/")
PACKAGE_FILES = {"VERSION.md", "contract.md", "tests.md", "plan.md", "run.md"}


def git(root, *args):
    p = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--since", default="HEAD~1")
    ap.add_argument("--allow", action="append", default=[])
    ap.add_argument("--include-worktree", action="store_true")
    a = ap.parse_args()
    root = Path(a.root).resolve()
    rc, out, err = git(root, "rev-parse", "--verify", a.since)
    if rc != 0:
        print(f"check_lead_scope: bad --since {a.since!r}: {err.strip()}", file=sys.stderr)
        return 2
    rc, out, err = git(root, "diff", "--name-only", f"{a.since}..HEAD")
    if rc != 0:
        print(f"check_lead_scope: git diff failed: {err.strip()}", file=sys.stderr)
        return 2
    names = {n for n in out.splitlines() if n.strip()}
    if a.include_worktree:
        rc, out, _ = git(root, "status", "--porcelain")
        for line in out.splitlines():
            if len(line) > 3:
                names.add(line[3:].strip())
    violations = []
    for n in sorted(names):
        if any(n == p or n.startswith(p) for p in a.allow):
            continue
        if any(n.startswith(p) for p in FORBIDDEN_PREFIX):
            violations.append((n, "forbidden path (scripts/deploy/installer)"))
        elif n.startswith("docs/specs/") and Path(n).name in PACKAGE_FILES:
            violations.append((n, "package file (worker-only)"))
    if violations:
        print("check_lead_scope FAIL:")
        for n, why in violations:
            print(f"  - {n}: {why}")
        return 1
    print(f"check_lead_scope OK: {len(names)} changed file(s), no Lead-scope violation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
