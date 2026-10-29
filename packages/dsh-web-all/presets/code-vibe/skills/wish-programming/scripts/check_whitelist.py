#!/usr/bin/env python3
"""check_whitelist.py — 组件白名单合规（设计规范单「组件白名单」vs 实现引用；「禁发明」的机械门）。

读 docs/wish/<id>/design-spec.md 的「组件白名单」表（组件路径列）与「共享件清单」表（路径列）；
扫描工作区实现代码，提取组件引用（import/require 路径末段 + JSX 大写标签名）；
实现引用不在白名单/共享件集合 → 违例（--allowlist "Name:reason" 可显式豁免，原因进入 audit 日志）。

定位：机械下限，不是质量上限——它只抓「用了清单外组件」，同类不同名/内联重写不在本门范围。

用法：
  python3 check_whitelist.py <workspace> <id> [--glob '**/*.{ts,tsx,js,jsx}' ...] [--allowlist Name:reason ...]
Exit: 0 ok/skip（无 design-spec 或无白名单表）, 1 违例, 2 usage.
"""
import argparse
import re
import sys
from pathlib import Path


def clean(s):
    return s.strip().strip("`").strip().strip("**")


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


def last_segment(value):
    """组件路径取最后一个有意义的分段：'@/components/ui/button'→button、'./shared/Header.vue'→Header、'buttons'→buttons。"""
    v = clean(value)
    v = re.sub(r"['\"\s]", "", v)
    if not v:
        return ""
    if v.startswith((".", "@")) :  # 相对/别名路径取末分段
        return v.split("/")[-1].split(".")[0]
    return v.split("/")[-1].split(".")[0]


def extract_component_refs(files):
    """import/require 路径末段 + JSX 大写标签 + createElement/h/defineComponent 组件名。"""
    refs = set()
    import_re = re.compile(r"(?:import\s+(?:[^'\"\n]*?\s+from\s+)?|require\()\s*['\"]([^'\"]+)['\"]")
    dyn_import_re = re.compile(r"import\s*\(\s*['\"]([^'\"]+)['\"]")
    tag_re = re.compile(r"<([A-Z][A-Za-z0-9_]*)")
    elem_re = re.compile(r"(?:createElement|h|defineComponent)\s*\(\s*['\"]([A-Za-z][A-Za-z0-9_]*)['\"]")
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for m in list(import_re.finditer(text)) + list(dyn_import_re.finditer(text)):
            path = m.group(1)
            if "/" not in path:
                continue  # 裸模块名（react 等平台运行时）不算组件引用
            refs.add(last_segment(path))
        for m in tag_re.finditer(text):
            refs.add(m.group(1))
        for m in elem_re.finditer(text):
            refs.add(m.group(1))
    return refs


def main():
    if any(a in ("-h", "--help") for a in sys.argv[1:]):
        print(__doc__)
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("args", nargs="*")
    opts, rest = ap.parse_known_args(sys.argv[1:])
    try:
        root = Path(opts.args[0]).resolve()
        wid = opts.args[1]
    except IndexError:
        print("usage: check_whitelist.py <workspace> <id> [--glob PATTERN] [--allowlist Name:reason]", file=sys.stderr)
        return 2

    globs = []
    allow = {}
    i = 0
    while i < len(rest):
        if rest[i] == "--glob" and i + 1 < len(rest):
            globs.append(rest[i + 1])
            i += 2
        elif rest[i] == "--allowlist" and i + 1 < len(rest):
            name, _, reason = rest[i + 1].partition(":")
            if not reason:
                print("--allowlist needs Name:reason", file=sys.stderr)
                return 2
            allow[name.strip()] = reason.strip()
            i += 2
        else:
            i += 1

    design = root / "docs" / "wish" / wid / "design-spec.md"
    if not design.is_file():
        print("check_whitelist: skip — no design-spec.md (非设计类愿望)", file=sys.stderr)
        return 0

    dtext = design.read_text(encoding="utf-8")
    wl_rows = table_after(dtext, "组件白名单")
    if not wl_rows:
        print("check_whitelist: skip — 组件白名单 table missing/empty", file=sys.stderr)
        return 0
    wl = {last_segment(r.values().__iter__().__next__()) for r in wl_rows if clean(next(iter(r.values()), ""))}

    shared_rows = table_after(dtext, "共享件清单")
    shared = set()
    for r in shared_rows:
        p = clean(r.get("路径", ""))
        if p:
            shared.add(last_segment(p))

    if not globs:
        globs = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.vue", "**/*.html", "**/*.mjs", "**/*.cjs", "**/*.mts", "**/*.cts"]
    exclude_parts = {"node_modules", ".git", ".sdd", "docs", "dist", "build", ".next", "__pycache__"}
    files = []
    for g in globs:
        for p in root.glob(g):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            if exclude_parts & set(rel.parts):
                continue
            files.append(p)

    if not files:
        print("check_whitelist: skip — no source files matched（确认 --glob 匹配技术栈）", file=sys.stderr)
        return 0

    refs = extract_component_refs(files)
    allowed = wl | shared | set(allow)
    violations = []
    for ref in sorted(refs):
        if ref in allowed:
            continue
        # 只忽略精确匹配的通用词（原生标签小写/常见误报）：大小写敏感——
        # <Button>（组件库）与 <button>（原生）不同，前者必须进白名单或报违例。
        if ref in {"div", "span", "form", "table", "button", "input", "new", "function", "return", "import"}:
            continue
        # 全小写引用一律放行：HTML 原生标签（li/ul/a/…）与小写自定义元素都属于
        # 「组件必须大写开头」约定的扫描面外（声明边界；小写组件不被白名单检查）。
        if ref.islower():
            continue
        violations.append(ref)

    if violations:
        print(f"check_whitelist FAIL: {wid} — 实现引用了白名单外组件 {len(violations)} 个（禁发明；新增须用户拍板后补入白名单，或 --allowlist 显式豁免）：", file=sys.stderr)
        for v in violations:
            if v in allow:
                continue
            print(f"  {v}", file=sys.stderr)
        if allow:
            print(f"  (allowlist 豁免: {', '.join(f'{k}（{v}）' for k, v in allow.items())})", file=sys.stderr)
        return 1
    print(f"check_whitelist OK: {wid} — {len(refs)} 个组件引用全部在白名单/共享件内（豁免: {', '.join(allow) or '无'}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
