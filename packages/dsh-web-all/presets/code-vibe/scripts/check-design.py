#!/usr/bin/env python3
"""设计件完整性检查（只查机械项，不评质量）。

用法: python3 scripts/check-design.py <design-dir>
判据:
  1. brief.md 存在且含 level: L1|L2|L3
  2. 该档必填文件存在（L1: brief,design,freeze; L2: +product,ia,review; L3: +arch,adr/,review,freeze）
  3. review.md 含至少一个 reviewer 结论行（"结论" 或 verdict）
  4. adr/*.md 编号唯一、状态合法（proposed/accepted/superseded）
  5. freeze.md 若存在：含 version 且列出的 sha256 与对应文件一致
退出码 0=全过；1=有不合规项。
"""
import hashlib
import re
import sys
from pathlib import Path

LEVEL_RE = re.compile(r"level\s*:\s*(L[123])", re.I)
ADR_RE = re.compile(r"^(?:\d{4})-[a-z0-9-]+\.md$", re.I)
STATUS_RE = re.compile(r"(proposed|accepted|superseded)", re.I)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    root = Path(argv[1]).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}")
        return 2
    errors: list[str] = []
    brief = root / "brief.md"
    if not brief.is_file():
        errors.append("missing brief.md")
        level = None
    else:
        m = LEVEL_RE.search(brief.read_text(encoding="utf-8"))
        level = m.group(1).upper() if m else None
        if not level:
            errors.append("brief.md missing `level: L1|L2|L3`")
    required = {"L1": ["brief.md", "design.md", "freeze.md"],
                "L2": ["brief.md", "product.md", "ia.md", "design.md", "review.md", "freeze.md"],
                "L3": ["brief.md", "product.md", "ia.md", "design.md", "arch.md", "review.md", "freeze.md"]}
    if level:
        for name in required[level]:
            if not (root / name).is_file():
                errors.append(f"{level} missing {name}")
        if level == "L3" and not (root / "adr").is_dir():
            errors.append("L3 missing adr/ directory")
    review = root / "review.md"
    if review.is_file():
        text = review.read_text(encoding="utf-8")
        if not re.search(r"(结论|verdict)", text, re.I):
            errors.append("review.md has no verdict/结论")
    adr_dir = root / "adr"
    if adr_dir.is_dir():
        seen = set()
        for f in sorted(adr_dir.glob("*.md")):
            if not ADR_RE.match(f.name):
                errors.append(f"bad ADR filename: {f.name}")
                continue
            num = f.name[:4]
            if num in seen:
                errors.append(f"duplicate ADR number: {num}")
            seen.add(num)
            body = f.read_text(encoding="utf-8")
            if not STATUS_RE.search(body):
                errors.append(f"ADR {f.name} missing status (proposed/accepted/superseded)")
    freeze = root / "freeze.md"
    if freeze.is_file():
        body = freeze.read_text(encoding="utf-8")
        if not re.search(r"version\s*:", body, re.I):
            errors.append("freeze.md missing version:")
        for name, digest in re.findall(r"([A-Za-z0-9_./-]+\.md)\s+([0-9a-f]{64})", body):
            target = root / name
            if not target.is_file():
                errors.append(f"freeze lists missing artifact: {name}")
            elif sha256(target) != digest:
                errors.append(f"sha256 mismatch for {name}")
    if errors:
        print("FAIL")
        for e in errors:
            print(" -", e)
        return 1
    print(f"OK level={level} dir={root}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
