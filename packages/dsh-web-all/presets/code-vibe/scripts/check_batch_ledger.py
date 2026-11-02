#!/usr/bin/env python3
"""M3/EC: 批次台账结构检查（命令/读数/复跑 三格 + 减条自洽 + 禁竖线 + 每条一据提示）。

用法:
  python3 scripts/check_batch_ledger.py --file docs/specs/<program>/BATCH-STATE.md [--ledger docs/product/gap-register.md]

检查:
  - 行以 `| B-` 开头；列数与表头一致（防竖线打乱）
  - closed-by-closure: 前→后必须递减；证据三格（命令/读数/复跑）非空
  - closed-by-effect / closed-by-decision: 至少"命令+读数"两格非空
  - 最后一条 closed* 的"后" == 账本 `### GAP-` 计数（若给 --ledger）
退出码: 0 通过；1 失败；2 用法错。
"""
import argparse, re, sys
from pathlib import Path


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--ledger", default="")
    a = ap.parse_args()
    path = Path(a.file)
    if not path.is_file():
        print(f"check_batch_ledger: no file {path}", file=sys.stderr)
        return 2
    lines = path.read_text(encoding="utf-8").splitlines()
    header = None
    rows = []
    for ln in lines:
        if ln.startswith("|") and "批次 id" in ln:
            header = cells(ln); continue
        if ln.startswith("| B-"):
            rows.append(cells(ln))
    if not header:
        print("check_batch_ledger: no header row (expect '批次 id' column)", file=sys.stderr)
        return 2
    idx = {name: i for i, name in enumerate(header)}
    def col(row, *names):
        for n in names:
            if n in idx and idx[n] < len(row):
                return row[idx[n]]
        return ""
    errs = []
    last_after = None
    for row in rows:
        bid = row[0]
        if len(row) != len(header):
            errs.append(f"{bid}: column count {len(row)} != header {len(header)} (unescaped '|'?)")
            continue
        status = col(row, "状态")
        if status.startswith("closed"):
            cmd = col(row, "命令(当轮执行原文)", "命令")
            reading = col(row, "读数(输出片段，禁竖线)", "读数")
            replay = col(row, "复跑校验", "复跑")
            if not cmd:
                errs.append(f"{bid}: closed row has empty command cell")
            if not reading:
                errs.append(f"{bid}: closed row has empty reading cell")
            if not replay:
                errs.append(f"{bid}: closed row has empty replay cell")
            delta = col(row, "账本条数(前→后)", "账本条数")
            m = re.match(r"\s*(\d+)\s*→\s*(\d+)\s*$", delta)
            if m:
                before, after = int(m.group(1)), int(m.group(2))
                last_after = after
                if status == "closed-by-closure" and not after < before:
                    errs.append(f"{bid}: closed-by-closure must decrease ({before}→{after})")
    if a.ledger:
        lp = Path(a.ledger)
        if not lp.is_file():
            errs.append(f"ledger not found: {lp}")
        else:
            count = len(re.findall(r"(?m)^### GAP-", lp.read_text(encoding="utf-8")))
            if last_after is not None and last_after != count:
                errs.append(f"last closed 'after'={last_after} != ledger open count={count}")
    if errs:
        print("check_batch_ledger FAIL:")
        for e in errs:
            print("  -", e)
        return 1
    print(f"check_batch_ledger OK: {len(rows)} row(s), last_after={last_after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
