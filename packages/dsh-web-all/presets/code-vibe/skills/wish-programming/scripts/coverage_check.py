#!/usr/bin/env python3
"""coverage_check.py — 存量功能落点完整性机械核对（阶段 4 用）。

读 docs/wish/<id>/requirements.md 的「存量功能清单」表，提取全部 O 编号；
读 .sdd/acceptance/<id>/coverage.tsv（三列：编号 \t 新落点 \t 证据路径）；
检查每个 O 编号在 tsv 中有行、新落点非空、证据路径存在。
缺 / 空 / 路径缺失 → 逐条列错，exit 1；
requirements 无 O 编号或注明 N/A → 打印 skip，exit 0。

用法：python3 coverage_check.py <workspace> <id>
Exit: 0 ok/skip, 1 fail, 2 usage.
"""
import re
import sys
from pathlib import Path


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_delim(row):
    parts = [c for c in row if c]
    return bool(parts) and all(re.fullmatch(r":?-{3,}:?", c) for c in parts)


def table_after(text, heading):
    lines = text.splitlines()
    start = None
    for i, l in enumerate(lines):
        if l.startswith("#") and heading in l:
            start = i + 1
            break
    if start is None:
        return []
    while start < len(lines) and ("|" not in lines[start] or lines[start].lstrip().startswith("#")):
        if lines[start].lstrip().startswith("#"):
            return []
        start += 1
    if start >= len(lines):
        return []
    headers = cells(lines[start])
    start += 1
    if start < len(lines) and is_delim(cells(lines[start])):
        start += 1
    rows = []
    while start < len(lines) and "|" in lines[start]:
        vals = cells(lines[start])
        if len(vals) == len(headers):
            rows.append({headers[i]: vals[i] for i in range(len(headers))})
        start += 1
    return rows


def main():
    if len(sys.argv) != 3:
        print("usage: coverage_check.py <workspace> <id>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    wid = sys.argv[2]
    req_path = root / "docs" / "wish" / wid / "requirements.md"
    tsv_path = root / ".sdd" / "acceptance" / wid / "coverage.tsv"

    if not req_path.is_file():
        print(f"coverage_check: missing requirements.md at {req_path}", file=sys.stderr)
        return 1

    req_text = req_path.read_text(encoding="utf-8")
    rows = table_after(req_text, "存量功能清单")
    o_ids = [r.get("编号", "").strip() for r in rows if re.match(r"^O\d+", r.get("编号", "").strip())]

    if not o_ids:
        reason = "注明 N/A（全新建设类愿望）" if "N/A" in req_text else "无 O 编号"
        print(f"coverage_check: skip — requirements.md {reason}")
        return 0

    if not tsv_path.is_file():
        print(f"coverage_check: missing coverage.tsv at {tsv_path}", file=sys.stderr)
        return 1

    tsv_rows = {}
    for lineno, line in enumerate(tsv_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = [c.strip() for c in line.split("\t")]
        if len(parts) < 3:
            print(f"coverage_check: malformed tsv row (need 3 tab-separated columns) at line {lineno}: {line!r}", file=sys.stderr)
            return 1
        num = parts[0]
        if not re.match(r"^O\d+", num):
            continue  # 表头或非 O 编号行，跳过
        if num in tsv_rows:
            print(f"coverage_check: duplicate O id in tsv: {num}", file=sys.stderr)
            return 1
        tsv_rows[num] = (parts[1], parts[2])

    errs = 0
    for oid in o_ids:
        if oid not in tsv_rows:
            print(f"coverage_check: 存量功能 {oid} 缺落点行（coverage.tsv 无对应条目）", file=sys.stderr)
            errs += 1
            continue
        target, evpath = tsv_rows[oid]
        if not target:
            print(f"coverage_check: 存量功能 {oid} 新落点为空", file=sys.stderr)
            errs += 1
        if not evpath:
            print(f"coverage_check: 存量功能 {oid} 证据路径为空", file=sys.stderr)
            errs += 1
            continue
        p = Path(evpath)
        if not p.is_absolute():
            p = root / evpath
        if not p.is_file():
            print(f"coverage_check: 存量功能 {oid} 证据路径不存在: {evpath}", file=sys.stderr)
            errs += 1

    if errs:
        print(f"coverage_check FAIL: {wid} ({errs} error(s))", file=sys.stderr)
        return 1
    print(f"coverage_check OK: {wid} ({len(o_ids)} 存量功能均有落点与证据)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
