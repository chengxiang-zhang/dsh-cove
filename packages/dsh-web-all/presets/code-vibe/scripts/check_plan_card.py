#!/usr/bin/env python3
"""M-PlanCard: Plan Card 结构校验（字段齐 / 波内写域不相交 / max_parallel 上限 / checkpoints）。

用法: python3 scripts/check_plan_card.py --file <tasks.md|plan.md>
退出码: 0 通过；1 失败；2 用法错。
"""
import argparse, re, sys
from pathlib import Path

ZONES = {"green", "yellow", "orange", "red"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    a = ap.parse_args()
    text = Path(a.file).read_text(encoding="utf-8")
    m = re.search(r"(?ms)^## Plan Card.*?(?=^## |\Z)", text)
    if not m:
        print("check_plan_card FAIL: no '## Plan Card' block", file=sys.stderr)
        return 1
    block = m.group(0)
    errs = []
    for field in ("tier:", "estimate:", "zone:", "waves:", "max_parallel:"):
        if field not in block:
            errs.append(f"missing field {field}")
    zone = re.search(r"zone:\s*(\w+)", block)
    if zone and zone.group(1) not in ZONES:
        errs.append(f"invalid zone {zone.group(1)}")
    if zone and zone.group(1) in {"yellow", "orange", "red"} and "checkpoints:" not in block:
        errs.append(f"zone={zone.group(1)} requires checkpoints")
    mp = re.search(r"max_parallel:\s*(\d+)", block)
    if mp and int(mp.group(1)) > 5:
        errs.append(f"max_parallel={mp.group(1)} > runtime cap 5")
    # write scopes: lines with "# write scopes: A→path1, path2" or "scopes:"
    scopes = {}
    for line in block.splitlines():
        if "write scopes:" in line:
            for pair in line.split("write scopes:", 1)[1].split(","):
                pair = pair.strip()
                if "→" in pair:
                    key, val = pair.split("→", 1)
                    scopes.setdefault(key.strip(), []).append(val.strip())
    if not scopes:
        errs.append("no 'write scopes:' declaration found on parallel wave lines")
    else:
        def norm(s):
            s = s.strip().rstrip("/")
            if s.endswith("/**"):
                s = s[:-3]
            if s.endswith("/*"):
                s = s[:-2]
            return s.rstrip("/")
        owners = list(scopes)
        for i in range(len(owners)):
            for j in range(i + 1, len(owners)):
                for p in scopes[owners[i]]:
                    for q in scopes[owners[j]]:
                        np, nq = norm(p), norm(q)
                        if np == nq or np.startswith(nq + "/") or nq.startswith(np + "/"):
                            errs.append(f"write scope overlap: {owners[i]}:{p} vs {owners[j]}:{q}")
    if errs:
        print("check_plan_card FAIL:")
        for e in errs:
            print("  -", e)
        return 1
    print(f"check_plan_card OK: zone={zone.group(1) if zone else '?'} max_parallel={mp.group(1) if mp else '?'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
