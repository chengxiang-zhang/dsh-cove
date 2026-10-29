#!/usr/bin/env python3
"""verify_preset_budgets.py — 预设内容预算 × skill 引用完整性门禁。

检查（全部可负对照验证）：
1. persona prefix ≤ 3000 字符（解析 bundle 根目录的 `code-vibe.patch.yml` 或旧目录的 `agent.cordis.yml`）
2. 每个 skills/*/SKILL.md ≤ 200 行
3. 每个 SKILL.md 的 description：> 540 字符 ERROR / > 300 WARN（DSH catalogDescriptionMaxLength=300
   渲染截断点——截断后触发契约必须在前 300 字符，故 WARN 提醒；540 是脚本自定义的绝对上限）
4. skill 引用完整性（persona 文本 + 全部 SKILL.md 全文）：
   a. 反引号 token：`` `xxx-yyy` `` 短横线连写（技能名判别特征：catalog 13 名全部含 `-`，
      而命令/路径/变量类反引号词如 `journey.sh`/`--assert`/`vN` 天然不满足）→ 必须命中 catalog；
   b. 字面互引：`../<name>/SKILL.md` → <name> 必须在 catalog；
   c. 跨 skill 路径：`../<name>/references/…` 等 → <name> 必须在 catalog，且跟随的
      references/scripts 子路径必须真实存在于 skills/<name>/ 下；
   d. 措辞引用（兼容旧版）：`load the X skill` / `X skill` / `X/SKILL.md` 格式 → X 必须在 catalog。
   全部不满足 → exit 1（TEST 负向：把 persona/SKILL.md 里技能名改错、删 references 目录必须被拒）。

用法：python3 verify_preset_budgets.py [preset_root]（默认从脚本位置解析包内 code-vibe）
      python3 verify_preset_budgets.py --help
Exit: 0 ok, 1 违例, 2 usage.
超限时按 relocate → condense → raise 处理：先删/移内容，仍不够才 raise（raise 须用户确认并记录于对应 Issue 或 pull request）。
"""
import re
import sys
from pathlib import Path

PERSONA_LIMIT = 3000
SKILL_LINES_LIMIT = 200
DESC_LIMIT = 540        # 绝对上限（>540 ERROR）
DESC_WARN = 300         # DSH catalog 渲染截断点（>300 WARN）

# 预设自有流程词（journey 状态机 / delivery target / 豁免标记等）：反引号内出现但非技能名。
# 新增流程词必须在此登记（对应 MAINTENANCE 规则），否则会被 4a 误报。
FLOW_WORDS = {
    "acceptance-passed", "blocked", "stuck", "idle", "claim-deliver",
    "code-ready", "dev-effective", "production-delivered", "no-ui",
}

USAGE = """verify_preset_budgets.py — 预设预算 × skill 引用完整性门禁
用法：python3 verify_preset_budgets.py [preset_root]（默认从脚本位置解析包内 code-vibe）
      python3 verify_preset_budgets.py --help
检查：persona ≤3000 字符；SKILL.md ≤200 行；description ≤540（>300 WARN）；
      反引号技能名 / ../<name>/SKILL.md 互引 / ../<name>/references 路径 / 措辞引用 全部必须命中 catalog。
Exit: 0 ok, 1 违例, 2 usage."""


def parse_persona_prefix(agent_yml: Path):
    """提取 `prefix: |-` 块文本；无则返回 ''。"""
    if not agent_yml.is_file():
        return ""
    text = agent_yml.read_text(encoding="utf-8")
    m = re.search(r"prefix:\s*\|-([ \t]*\n)?", text)
    if not m:
        return ""
    start = m.end()
    lines = text[start:].split("\n")
    body = []
    indent = None
    for line in lines:
        if not line.strip():
            body.append("")
            continue
        lead = len(line) - len(line.lstrip(" "))
        if indent is None:
            indent = lead
        if line.startswith("- id:") and lead <= (indent or 0):
            break
        if lead >= (indent or 0):
            body.append(line[indent:])
        else:
            break
    return "\n".join(body)


def skill_names(root: Path):
    return {p.name for p in root.iterdir() if (p / "SKILL.md").is_file()}


def check_references_in_text(text: str, name: str, skills_dir: Path, catalog: set, errs: list, ctx: str):
    """引用检查 d：`../…` 相对路径引用必须真实可解析。

    从 SKILL.md（skills/<name>/SKILL.md）出发：
    - 首段命中 catalog 且带子路径 → 跨 skill 引用：skills/<target>/<rest> 必须存在；
    - 首段未命中 catalog → 同 skill 引用（写作 `../x.md` 意图是 skills/<name>/x.md…，
      但 `..` 实际解析到 skills/ 根，故按「skills/<name>/<完整路径>」与「skills/<完整路径>」
      两处存在性判定，均不存在则为断裂引用（如 ../critique-format.md）。
    """
    ref_re = re.compile(r"\.\./([^\s\\)\]`,，。；:+]+)")
    for m in ref_re.finditer(text):
        path = m.group(1)
        segs = path.split("/")
        head = segs[0]
        head_m = re.fullmatch(r"[a-z][a-z0-9-]*", head)
        if head_m and head in catalog:
            rest = "/".join(segs[1:])
            cand = (skills_dir / head / rest).resolve() if rest else skills_dir / head
            if not cand.exists():
                errs.append(f"{ctx}: 跨 skill 引用 ../{path} 不存在（skills/{head}/ 下无此路径）")
        else:
            # 同 skill 内部引用：先按写作意图（skills/<name>/…），再按字面（skills/…）
            cand1 = skills_dir / name / path
            cand2 = skills_dir / path
            if not cand1.exists() and not cand2.exists():
                errs.append(f"{ctx}: ../{path} 断裂——skills/{name}/{path} 与 skills/{path} 均不存在")


def default_preset_root():
    """Return the packaged code-vibe asset root from this script's location."""
    return Path(__file__).resolve().parents[3]


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(USAGE)
        return 0
    preset_root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else default_preset_root()
    skills_dir = preset_root / "skills"
    if not skills_dir.is_dir():
        print(f"verify_preset_budgets: no skills dir at {skills_dir}", file=sys.stderr)
        return 2

    errs = []
    warns = []

    # 1. persona prefix 字符数。0.2 bundle patch 优先，旧目录格式仅作显式路径兼容。
    agent_yml = preset_root.parent / "code-vibe.patch.yml"
    if not agent_yml.is_file():
        agent_yml = preset_root / "agent.cordis.yml"
    persona = parse_persona_prefix(agent_yml)
    if persona:
        if len(persona) > PERSONA_LIMIT:
            errs.append(f"persona prefix {len(persona)} chars > {PERSONA_LIMIT}（relocate→condense→raise：先删重复与指针化，仍超再 raise）")
        else:
            print(f"persona prefix: {len(persona)} chars (≤{PERSONA_LIMIT})")
    else:
        warns.append(f"{agent_yml.name} 未找到 persona prefix 块（跳过该项）")

    catalog = skill_names(skills_dir)
    print(f"catalog: {len(catalog)} skills — {', '.join(sorted(catalog))}")

    # 4a-0. FLOW_WORDS 防滥用：豁免表登记了 catalog 内的技能名 = 试图绕过引用检查 → ERROR
    flow_conflicts = sorted(FLOW_WORDS & catalog)
    if flow_conflicts:
        for t in flow_conflicts:
            errs.append(f"FLOW_WORDS 登记了 catalog 内的技能名: {t}（禁止把技能名加入豁免表——引用检查必须生效）")

    # 2-3. 每个 SKILL.md 行数与 description 长度
    sk_texts = {}
    for name in sorted(catalog):
        sk = skills_dir / name / "SKILL.md"
        sk_texts[name] = sk.read_text(encoding="utf-8")
        lines = sk_texts[name].splitlines()
        if len(lines) > SKILL_LINES_LIMIT:
            errs.append(f"{name}/SKILL.md {len(lines)} lines > {SKILL_LINES_LIMIT}")
        dline = next((l for l in lines if l.startswith("description: ")), None)
        m = re.match(r"^description: (.*)$", dline) if dline else None
        if m:
            desc = m.group(1).strip().strip('"')
            if len(desc) > DESC_LIMIT:
                errs.append(f"{name} description {len(desc)} chars > {DESC_LIMIT}")
            elif len(desc) > DESC_WARN:
                warns.append(f"{name} description {len(desc)} chars > {DESC_WARN}（catalog 渲染截断点；触发契约主体在前 300 字符即可）")

    # 4a. 反引号短横线 token（persona + 全部 SKILL.md）：技能名判别特征 = 字母开头 + 含至少一个 `-`
    backtick_re = re.compile(r"`([a-z][a-z0-9-]*-[a-z0-9][a-z0-9-]*)`")
    for ctx, text in [("persona", persona)] + [(f"{n}/SKILL.md", t) for n, t in sk_texts.items()]:
        for m in backtick_re.finditer(text):
            target = m.group(1)
            if target not in catalog and target not in FLOW_WORDS:
                errs.append(f"{ctx} 反引号技能名不在 catalog: `{target}`（引用即失效——修复须与 catalog 一致，或登记进 FLOW_WORDS）")

    # 4b. 字面互引 ../<name>/SKILL.md
    inter_ref = re.compile(r"\.\./([A-Za-z0-9-]+)/SKILL\.md")
    for name in sorted(catalog):
        for m in inter_ref.finditer(sk_texts[name]):
            target = m.group(1)
            if target not in catalog:
                errs.append(f"{name}/SKILL.md 互引指向不存在的 skill: ../{target}/SKILL.md")

    # 4c. 措辞引用（兼容旧版）：`load the X skill` / `X skill`（X/SKILL.md 无 .. 前缀的裸引用）
    name_re = re.compile(r"(?:load(?:ing)?\s+the\s+|skill\s*[:：]?\s*)([a-z][a-z0-9-]+)\s+skill")
    bare_ref = re.compile(r"(?<![.\w])/([a-z][a-z0-9-]+)/SKILL\.md")
    for ctx, text in [("persona", persona)] + [(f"{n}/SKILL.md", t) for n, t in sk_texts.items()]:
        for m in name_re.finditer(text):
            target = m.group(1)
            if target not in catalog:
                errs.append(f"{ctx} 点名的 skill 不在 catalog: {target}")
        for m in bare_ref.finditer(text):
            target = m.group(1)
            if target not in catalog:
                errs.append(f"{ctx} 互引指向不存在的 skill: /{target}/SKILL.md")

    # 4d. 跨 skill 路径存在性（references/scripts 等）
    for name in sorted(catalog):
        check_references_in_text(sk_texts[name], name, skills_dir, catalog, errs, f"{name}/SKILL.md")

    # 4e. 同 skill 内部路径引用（references/scripts/templates/roles 前缀，反引号或链接目标）存在性
    local_re = re.compile(r"`((?:references|scripts|templates|roles)/[^`\s]+)`|\(((?:references|scripts|templates|roles)/[^)\s]+)\)")
    for name in sorted(catalog):
        for m in local_re.finditer(sk_texts[name]):
            p = (m.group(1) or m.group(2)).split("#")[0]  # 去掉 # 锚点片段
            cand = skills_dir / name / p
            if not cand.exists():
                errs.append(f"{name}/SKILL.md 引用缺失: {p}（skills/{name}/ 下不存在）")

    for w in warns:
        print(f"WARN: {w}", file=sys.stderr)
    if errs:
        for e in errs:
            print(f"ERROR: {e}", file=sys.stderr)
        print(f"verify_preset_budgets FAIL: {len(errs)} violation(s)", file=sys.stderr)
        return 1
    print("verify_preset_budgets OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
