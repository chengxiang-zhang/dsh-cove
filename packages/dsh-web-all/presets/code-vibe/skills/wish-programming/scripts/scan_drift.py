#!/usr/bin/env python3
"""scan_drift.py — deterministic doc-vs-code drift scan.

Reads a module manifest (domain → doc files) and produces a difference list:
for each listed doc, report whether the described files/routes/sections still
exist in the code tree; missing/moved items are drift signals.

Output: <workspace>/.sdd/drift.md (overwritten each run).
Drift items are REGISTERED ONLY (gap-register todo), never auto-fixed —
doc fixes go through the repo's Spec/PR discipline.

Usage:
  python3 scan_drift.py <workspace> [--manifest <path>]
Default manifest: docs/wish/.drift-manifest.md with lines:
  domain_name | code_path_glob | doc_file

Exit: 0 scan done (drift found or not), 2 usage error.
"""
import sys
from pathlib import Path

MANIFEST_HINT = """# drift manifest — one row per module: 域 | 代码路径(glob 或目录) | 文档
query_gateway | backend/app/domains/query_gateway | docs/architecture/05-building-blocks/query-gateway.md
"""


def main():
    if len(sys.argv) not in (2, 4):
        print("usage: scan_drift.py <workspace> [--manifest <path>]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    manifest_path = root / "docs" / "wish" / ".drift-manifest.md"
    if len(sys.argv) == 4 and sys.argv[2] == "--manifest":
        manifest_path = Path(sys.argv[3]).resolve()
    if not manifest_path.is_file():
        print(f"scan_drift: no manifest at {manifest_path}; create one (rows: 域 | 代码路径 | 文档)", file=sys.stderr)
        (root / "docs" / "wish").mkdir(parents=True, exist_ok=True)
        (root / "docs" / "wish" / ".drift-manifest.md").write_text(MANIFEST_HINT, encoding="utf-8")
        print("scan_drift: wrote an empty manifest hint — fill it, then rerun", file=sys.stderr)
        return 0

    findings = []
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 3:
            findings.append(f"- [manifest malformed] {line}")
            continue
        domain, code_glob, doc = parts
        code_glob_path = root / code_glob
        if not code_glob_path.exists():
            findings.append(f"- [drift] {domain}: code path missing/moved: {code_glob} (doc: {doc})")
            continue
        doc_path = root / doc
        if not doc_path.is_file():
            findings.append(f"- [drift] {domain}: doc missing: {doc} (code: {code_glob})")
            continue
        doc_text = doc_path.read_text(encoding="utf-8", errors="ignore")
        # doc must name at least one file under its code path — cheap cross-check
        named = 0
        for p in code_glob_path.rglob("*") if code_glob_path.is_dir() else [code_glob_path]:
            if p.is_file() and p.name.split(".")[0] in doc_text:
                named += 1
        if named == 0:
            findings.append(f"- [drift] {domain}: doc {doc} references none of the files under {code_glob} — likely stale")

    out = root / ".sdd" / "drift.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(findings) if findings else "- (no drift detected)"
    out.write_text(f"# drift scan {domain if False else ''}\n\n{body}\n", encoding="utf-8")
    print(f"scan_drift: wrote {out} ({len(findings)} finding(s))")
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
