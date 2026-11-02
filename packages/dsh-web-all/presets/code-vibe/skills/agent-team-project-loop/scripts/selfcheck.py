#!/usr/bin/env python3
"""Mechanical self-check for PROGRAM MODE assets in the code-vibe preset.

Maintenance rule #1 of this preset requires every rule change to ship with a
reproducible probe. This script is the mechanical half (structure + wiring);
`probes/behavior-probe.md` is the behavioral half (a fixed scenario to run in a
fresh session and the pass criteria).

Usage: python3 skills/agent-team-project-loop/scripts/selfcheck.py [preset_root]
Exit: 0 = all checks pass, 1 = at least one failure (prints each failure).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

INVARIANTS = ["①", "②", "③", "④", "⑤", "⑥"]

SKILLS = {
    "fix-loop": ["步骤", "证据下限（E1）", "禁止", "升级触发器"],
    "change-spec": ["三个变体", "步骤", "证据下限（E2）", "数据安全", "运维单批", "禁止"],
    "research-brief": ["步骤", "证据与覆盖", "禁止", "出口"],
    "incident-runbook": ["顺序（不可换）", "硬规则", "与其它档的关系"],
    "task-router": [
        "时机",
        "档位判定",
        "上下文可容性",
        "并发图",
        "宣告",
        "升降级触发器",
        "常见误判",
        "机械校验",
    ],
    "large-backlog-program": [
        "阶段 0",
        "阶段 1",
        "阶段 2",
        "阶段 3",
        "阶段 4",
        "阶段 5",
        "反模式清单",
        "交付前自检",
    ],
    "agent-team-project-loop": [
        "角色边界",
        "开环四件套",
        "派工",
        "回执与独立验收",
        "关条证据判据",
        "账本与关条",
        "收尾信号",
        "进度汇报",
        "抗上下文压缩",
        "环境窗口",
        "出口与交接",
        "反模式",
    ],
}

REFERENCES = [
    "skills/task-router/references/triage-card.md",
    "skills/task-router/references/artifact-home.md",
    "skills/change-spec/references/acceptance.tpl.md",
    "skills/change-spec/references/data-safety.md",
    "skills/change-spec/references/ops-runbook.md",
    "skills/task-router/references/scenario-matrix.md",
    "skills/task-router/references/transition-log.md",
    "skills/large-backlog-program/references/ledger-plan-templates.md",
    "skills/large-backlog-program/references/spec-pack-templates.md",
    "skills/agent-team-project-loop/references/project-charter.md",
    "skills/agent-team-project-loop/references/t3-invariants.md",
    "skills/agent-team-project-loop/references/evidence.md",
    "skills/agent-team-project-loop/references/state-card.md",
    "skills/agent-team-project-loop/references/handoff.md",
    "skills/change-spec/references/plan-card.md",
    "skills/agent-team-project-loop/references/mechanical-checks.md",
    "skills/agent-team-project-loop/references/batch-ledger.md",
    "skills/agent-team-project-loop/references/card-dispatch-report.md",
    "skills/agent-team-project-loop/references/anti-patterns.md",
]

TEMPLATE_REQUIRED = {
    "skills/agent-team-project-loop/references/project-charter.md": [
        "§0 出口",
        "§2 单轮协议",
        "§4 写域与并发",
        "§5 证据纪律",
        "§6 记账与关条",
        "§7 预算与检查点",
        "§9 抗压缩与幂等",
        "他证三件套",
        "关条下游锚点扫描",
        "KILL 五条件",
        "轮次日志",
    ],
    "skills/agent-team-project-loop/references/batch-ledger.md": [
        "closed-by-closure",
        "closed-by-effect",
        "closed-by-decision",
        "复跑校验",
        "读于",
        "KILL 五条件",
    ],
    "skills/large-backlog-program/references/ledger-plan-templates.md": [
        "方案组",
        "已从本账删除",
        "blocked(<类>)",
        "三要素",
    ],
    "skills/large-backlog-program/references/spec-pack-templates.md": [
        "VERSION.md",
        "contract.md",
        "tests.md",
        "plan.md",
        "run.md",
        "INTERFACES.md",
        "INTEGRATION.md",
    ],
}

FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.S)


def check_frontmatter(root: Path, failures: list[str]) -> None:
    for name in SKILLS:
        path = root / "skills" / name / "SKILL.md"
        if not path.is_file():
            failures.append(f"missing skill: {path}")
            continue
        text = path.read_text(encoding="utf-8")
        match = FRONTMATTER.match(text)
        if not match:
            failures.append(f"no YAML frontmatter: {path}")
            continue
        fm = match.group(1)
        name_line = next((l for l in fm.splitlines() if l.startswith("name:")), "")
        if name_line.split(":", 1)[1].strip() != name:
            failures.append(f"frontmatter name != dir name: {path} ({name_line!r})")
        if not any(l.startswith("description:") and len(l) > 60 for l in fm.splitlines()):
            failures.append(f"frontmatter description too short: {path}")
        if name in ("wish-programming", "large-backlog-program", "agent-team-project-loop", "fix-loop", "change-spec", "research-brief", "incident-runbook") and "Entry tier" not in text:
            failures.append(f"{path.name}: missing Entry tier line")
        for heading in SKILLS[name]:
            if heading not in text:
                failures.append(f"{path.name}: missing section marker {heading!r}")
        print(f"ok  skill {name} ({len(text)} chars)")


def check_persona(root: Path, failures: list[str]) -> None:
    path = root / "agent.cordis.yml"
    if not path.is_file():
        failures.append(f"missing preset composition: {path}")
        return
    text = path.read_text(encoding="utf-8")
    for marker in ("TASK TRIAGE", "COMPACTION RECOVERY", "task-router", "fix-loop", "change-spec", "research-brief", "incident-runbook"):
        if marker not in text:
            failures.append(f"persona: missing marker {marker!r}")
    for marker in INVARIANTS:
        if marker not in text:
            failures.append(f"persona: invariant marker {marker} missing")
    for skill in SKILLS:
        if f"`{skill}`" not in text:
            failures.append(f"persona: does not reference skill {skill!r}")
    for artifact in ("EXECUTION-LOOP", "BATCH-STATE", "HANDOFF", "STATE.md", "tasks.md"):
        if artifact not in text:
            failures.append(f"persona: does not name durable artifact {artifact}")
    # duplicate row ids would be rejected at mount
    ids = re.findall(r"^-\s+id:\s*(\S+)", text, re.M)
    ids += re.findall(r"^\s{4}-\s+id:\s*(\S+)", text, re.M)
    dups = {i for i in ids if ids.count(i) > 1}
    if dups:
        failures.append(f"preset: duplicate row ids {sorted(dups)}")
    print(f"ok  persona block + {len(ids)} row ids unique")


def check_references(root: Path, failures: list[str]) -> None:
    for rel in REFERENCES:
        path = root / rel
        if not path.is_file():
            failures.append(f"missing reference: {rel}")
            continue
        text = path.read_text(encoding="utf-8")
        for needle in TEMPLATE_REQUIRED.get(rel, []):
            if needle not in text:
                failures.append(f"{rel}: missing required section {needle!r}")
        print(f"ok  reference {rel} ({len(text)} chars)")




ASSETS = [
    "scripts/check_lead_scope.py",
    "scripts/check_batch_ledger.py",
    "scripts/check_plan_card.py",
    "scripts/ctx_budget.py",
    "evals/tier-cases.md",
    "evals/regression-cases.md",
    "evals/run-smoke.sh",
    "docs/portable/AGENTS.md",
]


def check_assets(root: Path, failures: list[str]) -> None:
    for rel in ASSETS:
        if not (root / rel).is_file():
            failures.append(f"missing asset: {rel}")
    print(f"ok  assets ({len(ASSETS)} files)")


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[3]
    failures: list[str] = []
    check_persona(root, failures)
    check_frontmatter(root, failures)
    check_references(root, failures)
    check_assets(root, failures)
    if failures:
        print("\nFAIL:")
        for item in failures:
            print(" -", item)
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())