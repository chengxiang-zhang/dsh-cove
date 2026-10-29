#!/usr/bin/env python3
"""coverage_check.py — 存量功能落点完整性机械核对（阶段 4 用）。

读 docs/wish/<id>/requirements.md 的「存量功能清单」表，提取全部 O 编号；
读 .sdd/acceptance/<id>/coverage.tsv（三列：编号 \t 新落点 \t 证据路径）；
检查每个 O 编号在 tsv 中有行、新落点非空、证据路径存在。
缺 / 空 / 路径缺失 → 逐条列错，exit 1；
requirements 无 O 编号或注明 N/A → 打印 skip，exit 0。

负对照自证（guard only guards if the regression fails it）：
  python3 coverage_check.py --self-test
构造正例+负例断言：缺行/空落点/空证据/坏证据路径 → 必 exit 1；完好 → exit 0。
自证失败即 exit 1（门禁自身被回归击穿时，先修门禁再放行）。

用法：python3 coverage_check.py <workspace> <id> | coverage_check.py --self-test
Exit: 0 ok/skip, 1 fail, 2 usage.
"""
import re
import sys
import tempfile
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


def check(root: Path, wid: str) -> int:
    req_path = root / "docs" / "wish" / wid / "requirements.md"
    tsv_path = root / ".sdd" / "acceptance" / wid / "coverage.tsv"

    if not req_path.is_file():
        print(f"coverage_check: missing requirements.md at {req_path}", file=sys.stderr)
        return 1

    req_text = req_path.read_text(encoding="utf-8-sig")
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
    for lineno, line in enumerate(tsv_path.read_text(encoding="utf-8-sig").splitlines(), 1):
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
        if ".." in p.parts:
            print(f"coverage_check: 存量功能 {oid} 证据路径不得含 ..: {evpath!r}（禁止跨目录/跨愿望引用）", file=sys.stderr)
            errs += 1
            continue
        resolved = p if p.is_absolute() else (root / p).resolve()
        resolved = resolved.resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            print(f"coverage_check: 存量功能 {oid} 证据路径越出工作区: {evpath!r}（工作区内绝对路径可用，工作区外一律拒绝）", file=sys.stderr)
            errs += 1
            continue
        if resolved == tsv_path.resolve():
            print(f"coverage_check: 存量功能 {oid} 证据路径自指 coverage.tsv: {evpath!r}", file=sys.stderr)
            errs += 1
            continue
        if not resolved.is_file():
            print(f"coverage_check: 存量功能 {oid} 证据路径不存在: {evpath!r}", file=sys.stderr)
            errs += 1

    if errs:
        print(f"coverage_check FAIL: {wid} ({errs} error(s))", file=sys.stderr)
        return 1
    print(f"coverage_check OK: {wid} ({len(o_ids)} 存量功能均有落点与证据)")
    return 0


def self_test() -> int:
    """负对照自证：构造正例与四类负例，全部断言后报告。任一断言失败 → exit 1。"""
    failures = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        wish = root / "docs" / "wish" / "selftest" / "requirements.md"
        wish.parent.mkdir(parents=True)
        # requirements：O1 + O2
        req = """# selftest · 需求清单

## 2. 存量功能清单

| 编号 | 存量功能 | 处置 |
|---|---|---|
| O1 | 旧功能一 | 保留 |
| O2 | 旧功能二 | 保留 |
"""
        wish.write_text(req, encoding="utf-8")

        acc = root / ".sdd" / "acceptance" / "selftest"
        acc.mkdir(parents=True)
        ev1 = acc / "ev1.png"
        ev1.write_text("x", encoding="utf-8")

        good_tsv = f"O1\t新页面A\t{ev1}\nO2\t新页面B\t{ev1}\n"
        cases = [
            ("正例：全好 → 期望 exit 0", good_tsv, 0),
            ("负例 A：删掉落点行 → 期望 exit 1", "O1\t新页面A\t%s\n" % ev1, 1),
            ("负例 B：空落点 → 期望 exit 1", "O1\t\t%s\nO2\t新页面B\t%s\n" % (ev1, ev1), 1),
            ("负例 C：空证据 → 期望 exit 1", "O1\t新页面A\t\nO2\t新页面B\t%s\n" % ev1, 1),
            ("负例 D：证据路径不存在 → 期望 exit 1", "O1\t新页面A\tno-such-file.png\nO2\t新页面B\t%s\n" % ev1, 1),
        ]
        for label, tsv_text, want in cases:
            (acc / "coverage.tsv").write_text(tsv_text, encoding="utf-8")
            got = check(root, "selftest")
            status = "OK" if got == want else "FAIL"
            if got != want:
                failures.append(f"{label} — want exit {want}, got {got}")
            print(f"  [{status}] {label}（exit {got}）")

    if failures:
        for f in failures:
            print(f"coverage_check --self-test FAIL: {f}", file=sys.stderr)
        return 1
    print("coverage_check --self-test OK：正例放行、四类负例全部被拒（门禁自证有效）")
    return 0


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return self_test()
    if len(sys.argv) != 3:
        print("usage: coverage_check.py <workspace> <id> | coverage_check.py --self-test", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    return check(root, sys.argv[2])


if __name__ == "__main__":
    sys.exit(main())
