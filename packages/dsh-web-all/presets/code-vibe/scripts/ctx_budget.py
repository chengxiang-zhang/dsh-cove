#!/usr/bin/env python3
"""上下文预算估算（fit/slice/delegate/program + 区段）。

用法:
  python3 scripts/ctx_budget.py --reads 20 --avg-lines 300 --rounds 8 [--artifacts 3] [--evidence 6]
  或 --files "src/a.py:200,src/b.py:350"
"""
import argparse, sys

FIXED = 19000
PER_LINE = 13
PER_ARTIFACT = 1200
PER_EVIDENCE = 1500
PER_ROUND = 4000
ZONES = ((250000, "green"), (400000, "yellow"), (550000, "orange"), (10**12, "red"))


def zone(n):
    for limit, name in ZONES:
        if n <= limit:
            return name
    return "red"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", default="")
    ap.add_argument("--reads", type=int, default=0)
    ap.add_argument("--avg-lines", type=int, default=300)
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--artifacts", type=int, default=3)
    ap.add_argument("--evidence", type=int, default=5)
    a = ap.parse_args()
    lines = 0
    if a.files:
        for part in a.files.split(","):
            if ":" in part:
                lines += int(part.rsplit(":", 1)[1])
            else:
                lines += a.avg_lines
    else:
        lines = a.reads * a.avg_lines
    total = FIXED + lines * PER_LINE + a.artifacts * PER_ARTIFACT + a.evidence * PER_EVIDENCE + a.rounds * PER_ROUND
    z = zone(total)
    if total <= 250000:
        fit = "fit"
    elif total <= 400000:
        fit = "slice"
    else:
        fit = "delegate" if a.rounds < 20 else "program"
    print(f"estimate={total} tokens (~{total//1000}K) zone={z} fit={fit} rounds={a.rounds} lines={lines}")
    if z in ("orange", "red"):
        print("建议：拆段/委派/换会话；写 HANDOFF；不要在压缩后直接续跑大任务。")
    elif z == "yellow":
        print("建议：停止新增大读取；卸载工件/派工；写检查点。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
