#!/usr/bin/env python3
"""Sync the persona prompt block from the code-vibe preset into the profile patches.

The profile patches embed a copy of the preset composition (the `- id: persona`
row). That copy silently drifts from `~/.dsh/.agent-presets/code-vibe/agent.cordis.yml`
— on 2026-11-01 the live copy still had a garbled PATHS line. This tool makes the
preset file the single source and rewrites only the persona `prefix` block.

Usage:
  python3 scripts/sync-persona.py            # dry-run, prints per-profile status
  python3 scripts/sync-persona.py --write    # rewrite the profile patches
  python3 scripts/sync-persona.py --check    # exit 1 if any profile drifts
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PRESET = Path.home() / '.dsh/.agent-presets/code-vibe/agent.cordis.yml'
PROFILES = Path.home() / '.dsh/profiles'
NAMES = ['web', 'v5new', 'v5n2', 'v5n3', 'v5n4']


def read_lines(p: Path) -> list[str]:
    return p.read_text(encoding='utf-8').splitlines()


def extract_prefix(lines: list[str], indent: int) -> list[str]:
    """Return the block lines following `prefix: |-` (dedented to `indent`)."""
    start = None
    for i, line in enumerate(lines):
        if re.match(rf'^\s{{{indent}}}prefix:\s*\|-\s*$', line):
            start = i + 1
            break
    if start is None:
        raise SystemExit(f'prefix: |- not found at indent {indent}')
    body: list[str] = []
    for line in lines[start:]:
        if not line.strip():
            body.append('')
            continue
        cur = len(line) - len(line.lstrip(' '))
        if cur <= indent:
            break
        body.append(line)
    # trim trailing blank lines
    while body and not body[-1]:
        body.pop()
    return body


def find_persona(lines: list[str]):
    for i, line in enumerate(lines):
        m = re.match(r'^(\s*)- id: persona\s*$', line)
        if not m:
            continue
        row_indent = len(m.group(1))
        prefix_line = None
        prefix_indent = None
        for j in range(i + 1, min(i + 60, len(lines))):
            pm = re.match(r'^(\s*)prefix:\s*\|-\s*$', lines[j])
            if pm:
                prefix_line = j
                prefix_indent = len(pm.group(1))
                break
            if re.match(rf'^\s{{{row_indent}}}- id:', lines[j]):
                break
        if prefix_line is None:
            continue
        end = len(lines)
        for k in range(prefix_line + 1, len(lines)):
            if not lines[k].strip():
                continue
            cur = len(lines[k]) - len(lines[k].lstrip(' '))
            if cur <= prefix_indent:
                end = k
                break
        return i, prefix_line, prefix_indent, end
    raise SystemExit('persona row with prefix: |- not found')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()

    preset_lines = read_lines(PRESET)
    # preset persona row sits at indent 0, prefix at 4, body at 6
    body = extract_prefix(preset_lines, 4)

    drift = 0
    for name in NAMES:
        patch = PROFILES / name / 'cordis.patch.yml'
        if not patch.exists():
            print(f'SKIP {name}: no patch')
            continue
        lines = read_lines(patch)
        _, p_line, p_indent, end = find_persona(lines)
        rel = [(ln[6:] if ln.startswith(' ' * 6) else ln.lstrip(' ')) for ln in body]
        want = [(' ' * (p_indent + 2)) + ln if ln else '' for ln in rel]
        have = lines[p_line + 1:end]
        same = [x.rstrip() for x in have] == [x.rstrip() for x in want]
        status = 'OK' if same else 'DRIFT'
        print(f'{status:5} {name}: {len(have)} -> {len(want)} lines')
        if not same:
            drift += 1
            if args.write:
                lines[p_line + 1:end] = want
                patch.write_text('\n'.join(lines) + '\n', encoding='utf-8')
                print(f'      wrote {patch}')
    if args.check and drift:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())