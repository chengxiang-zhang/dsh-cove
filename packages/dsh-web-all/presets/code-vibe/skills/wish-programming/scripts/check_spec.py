#!/usr/bin/env python3
"""Product-aware spec-structure gate — v2 五阶段工件结构门（机械下限，不是质量）。

只检查「产生真实质量后果」的工件结构：原话 / 需求清单 / 规范单 / 存量落点 / 截图。
评审文档与状态机仪式不再检查。

Phases:
  --phase design   (阶段 1/2 门):  quote.md（原话，v1 保留）
                    + requirements.md（需求清单 N 编号 + 存量功能清单 + 语义不变量）
                    + design-spec.md（页面树 + 组件白名单 + 共享件清单）
                    + product.md 条件式（存在才查「用户原话」节，不存在跳过）
                    + confirmation-pack.md 禁用词汇表检查（若存在）
  --phase plan     (技术架构类门):  arch.md 存在才查其结构 + review-arch.md 交锋段格式与原话对照；
                    页面/前端类愿望无 arch.md → 跳过
  --phase build    (默认):         上述全部 + plan.md 纵向切片；contract.md 条件式（存在才查事实映射）
  --phase close    (acceptance-passed 门): 回填存在性检查（仓库感知）

Usage:
  python3 check_spec.py <workspace> <id> [--phase design|plan|build|close]
Exit: 0 ok, 1 fail, 2 usage.
"""
import re
import sys
from pathlib import Path

EMPTYISH = {"", "-", "—", "n/a", "N/A", "TODO", "TBD", "…", "...", "Verified/Unverified"}


def clean(s):
    return s.strip().strip("`").strip()


def cells(line):
    return [clean(c) for c in line.strip().strip("|").split("|")]


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


def section_lines(text, heading):
    """All non-blank body lines between the heading and the next heading."""
    lines = text.splitlines()
    out = []
    started = False
    for l in lines:
        if l.startswith("#") and heading in l:
            started = True
            continue
        if started:
            if l.lstrip().startswith("#"):
                break
            if l.strip():
                out.append(l.strip())
    return out


def section_exists(text, heading):
    return any(l.startswith("#") and heading in l for l in text.splitlines())


def filled(v):
    v = clean(v)
    return bool(v) and v not in EMPTYISH


def review_pass(path):
    if not path.is_file():
        return False
    lines = [l.strip() for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not lines:
        return False
    return bool(re.match(r"^结论\s*[:：]\s*pass$", lines[-1], re.IGNORECASE))


def review_structured(path, name):
    """评审文件必须含交锋段格式：advocate 结论 / skeptic 结论 / 裁决（引用双方），末行 结论：pass。"""
    if not review_pass(path):
        return False, f"{name} missing or not ending in 结论：pass"
    text = path.read_text(encoding="utf-8")
    for marker in ("advocate 结论", "skeptic 结论", "裁决"):
        if not re.search(rf"^#{{1,4}}\s*.*{marker}|^[#]{{1,4}}\s*{marker}", text, re.MULTILINE) and marker not in text:
            return False, f"{name} lacks 交锋段 marker: {marker}"
    # 裁决段必须非空（引用双方结论）
    m = re.search(r"裁决[^\n]*\n((?:[ \t]*\S[^\n]*\n)+)", text)
    body = m.group(1).strip() if m else ""
    if not body or len(body.splitlines()) < 2:
        return False, f"{name} 裁决 section empty (must quote both verdicts)"
    return True, ""


FORBIDDEN_WORDS = ["scope", "adminonly", "治理动作", "路由", "schema", "命名空间", "endpoint", "限流配额", "gateway 管理"]


def check_confirmation_pack(path):
    """确认包禁用词汇表：禁用词出现行必须同段含「白话」解释。"""
    if not path.is_file():
        return []  # 包不存在则跳过（旧愿望或非 UI 愿望）
    errs = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        low = line.lower()
        for w in FORBIDDEN_WORDS:
            if w in low and "白话" not in low:
                errs.append(f"confirmation-pack.md:{i} contains forbidden word {w!r} without 白话 explanation")
    return errs


def table_header(text, heading):
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
    return cells(lines[start])


def main():
    if len(sys.argv) not in (3, 5):
        print("usage: check_spec.py <workspace> <id> [--phase design|plan|build|close]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    wid = sys.argv[2]
    phase = "build"
    if len(sys.argv) == 5:
        if sys.argv[3] != "--phase":
            print("usage: check_spec.py <workspace> <id> [--phase design|plan|build|close]", file=sys.stderr)
            return 2
        phase = sys.argv[4]
        if phase not in {"design", "plan", "build", "close"}:
            print(f"check_spec: invalid phase {phase!r}", file=sys.stderr)
            return 2

    wish_dir = root / "docs" / "wish" / wid
    product_md = wish_dir / "product.md"
    arch_md = wish_dir / "arch.md"
    review_arch = wish_dir / "review-arch.md"
    contract_md = wish_dir / "contract.md"
    plan_md = wish_dir / "plan.md"

    errs = 0
    need_design = phase in {"design", "build"}
    need_plan = phase in {"plan", "build"}

    # ---- design gate: quote.md + requirements.md + design-spec.md ------------
    if need_design:
        # ---- quote.md 用户原话工件（最高优先级，v1 保留） ---------------------
        quote_md = wish_dir / "quote.md"
        if not quote_md.is_file():
            print("ERROR: missing quote.md — 用户原话逐字转录（最高优先级工件）; wish.sh --new --quote 生成，或手工补录", file=sys.stderr)
            errs += 1
        else:
            qlines = [l.strip() for l in quote_md.read_text(encoding="utf-8").splitlines() if l.strip()]
            if not qlines or "用户原话" not in qlines[0]:
                print("ERROR: quote.md must start with heading 用户原话（最高优先级 · 逐字转录 · 不可改写）", file=sys.stderr)
                errs += 1
            elif any("待补录" in l for l in qlines):
                print("ERROR: quote.md 仍是占位 — 必须逐字补录用户原话（原话最高优先级，禁止以转述代替）", file=sys.stderr)
                errs += 1
            # 原话指纹（v3 对抗修复）：journey --confirm 时锁定 quote.md sha256；
            # 内容被改动（含只改一字）但未重新确认 → 拦截。存量 wish 无指纹文件 → 降级不查。
            qhash_f = root / ".sdd" / "acceptance" / (wid + ".quote-hash")
            if qhash_f.is_file():
                import hashlib
                locked = qhash_f.read_text(encoding="utf-8", errors="ignore").splitlines()[0].split("=", 1)[-1].strip()
                cur = hashlib.sha256(quote_md.read_bytes()).hexdigest()
                if not locked or cur != locked:
                    print("ERROR: quote.md 内容与确认时指纹不一致（原话被改动后未重新 --confirm；quote 更新须版本+1、下游重对齐、并重新确认）", file=sys.stderr)
                    errs += 1

        # ---- requirements.md（阶段 1 产出） ----------------------------------
        req_md = wish_dir / "requirements.md"
        if not req_md.is_file():
            print(f"ERROR: missing {req_md} (copy references/templates/requirements.md.tpl)", file=sys.stderr)
            errs += 1
        else:
            rtext = req_md.read_text(encoding="utf-8")
            n_ids = [r for r in table_after(rtext, "1. 需求清单") if re.match(r"^N\d+", r.get("编号", ""))]
            if len(n_ids) < 1:
                print("ERROR: requirements.md 需求清单 table needs ≥1 N-numbered row (N1/N2...)", file=sys.stderr)
                errs += 1
            if not (section_exists(rtext, "存量功能清单") or "N/A" in rtext):
                print("ERROR: requirements.md missing 存量功能清单 section (全新建设类愿望须注明 N/A)", file=sys.stderr)
                errs += 1
            if not section_exists(rtext, "语义不变量"):
                print("ERROR: requirements.md missing section 语义不变量", file=sys.stderr)
                errs += 1
            elif not section_lines(rtext, "语义不变量"):
                print("ERROR: requirements.md 语义不变量 section empty (≥1 条；存量功能零丢失或显式豁免必须在此)", file=sys.stderr)
                errs += 1

        # ---- design-spec.md（阶段 2 产出） -----------------------------------
        design_spec = wish_dir / "design-spec.md"
        if not design_spec.is_file():
            print(f"ERROR: missing {design_spec} (copy references/templates/design-spec.md.tpl)", file=sys.stderr)
            errs += 1
        else:
            dtext = design_spec.read_text(encoding="utf-8")
            for sec in ("页面树", "组件白名单", "共享件清单"):
                if not section_exists(dtext, sec):
                    print(f"ERROR: design-spec.md missing section {sec}", file=sys.stderr)
                    errs += 1

        # ---- product.md 条件式（存在才查「用户原话」节；不存在跳过不报错） ----
        if product_md.is_file():
            ptext = product_md.read_text(encoding="utf-8")
            if not section_exists(ptext, "用户原话"):
                print("ERROR: product.md missing section 用户原话 (从 quote.md 逐字复制，最高优先级)", file=sys.stderr)
                errs += 1
            elif not section_lines(ptext, "用户原话"):
                print("ERROR: product.md 用户原话 section empty (必须逐字转录 quote.md)", file=sys.stderr)
                errs += 1

        # ---- confirmation-pack 禁用词汇表 + 原话回显段（v1 保留） -------------
        pack = wish_dir / "confirmation-pack.md"
        if pack.is_file():
            ptext2 = pack.read_text(encoding="utf-8")
            if not section_exists(ptext2, "你的原话"):
                print("ERROR: confirmation-pack.md missing 你的原话回显段 (§0 原样回显 quote.md，原话最高优先级)", file=sys.stderr)
                errs += 1
        for e in check_confirmation_pack(pack):
            print(f"ERROR: {e}", file=sys.stderr)
            errs += 1

        # ---- quote 版本一致性（v2 新增：stale 检出） -------------------------
        qver = None
        if quote_md.is_file():
            mq = re.search(r"quote 版本\s*[：:]\s*v(\d+)", quote_md.read_text(encoding="utf-8"))
            qver = mq.group(1) if mq else None
        if qver:
            for label, path, sec in (
                ("requirements.md", req_md, "需求清单"),
                ("design-spec.md", design_spec, "需求覆盖矩阵"),
            ):
                if not path.is_file():
                    continue
                t = path.read_text(encoding="utf-8")
                mv = re.search(r"quote 版本\s*[：:]\s*v(\d+)", t)
                if mv is None:
                    print(f"ERROR: {label} missing quote 版本 line (quote= v{qver}；新 wish 必须声明并一致)", file=sys.stderr)
                    errs += 1
                elif mv.group(1) != qver:
                    print(f"ERROR: {label} quote 版本 v{mv.group(1)} != quote.md v{qver} — stale，须重新对齐原话", file=sys.stderr)
                    errs += 1
            if pack.is_file():
                pt = pack.read_text(encoding="utf-8")
                mv = re.search(r"quote 版本\s*[：:]\s*v(\d+)", pt)
                if mv is None:
                    print(f"ERROR: confirmation-pack.md missing quote 版本 line (quote= v{qver})", file=sys.stderr)
                    errs += 1
                elif mv.group(1) != qver:
                    print(f"ERROR: confirmation-pack.md quote 版本 v{mv.group(1)} != quote.md v{qver} — stale，本包作废需重做", file=sys.stderr)
                    errs += 1

        # ---- design-spec 备选方案节（v2 新增；旧 wish 无版本行时仅警告） ------
        if design_spec.is_file():
            dtext2 = design_spec.read_text(encoding="utf-8")
            if section_exists(dtext2, "备选方案"):
                opts_lines = section_lines(dtext2, "备选方案")
                if not opts_lines:
                    print("ERROR: design-spec.md 备选方案 section empty (≥1 个被否方案+理由)", file=sys.stderr)
                    errs += 1
            else:
                if qver:
                    print("ERROR: design-spec.md missing section 备选方案 (Alternatives considered；缺失 = 决策会被重审)", file=sys.stderr)
                    errs += 1
                else:
                    print("WARN: design-spec.md missing 备选方案 section（存量 wish 不强制；下次进入本 wish 时补齐）", file=sys.stderr)

    # ---- plan gate: arch.md 条件式（技术架构类愿望才需要） --------------------
    if need_plan:
        if arch_md.is_file():
            text = arch_md.read_text(encoding="utf-8")
            headers = table_header(text, "方案选项")
            option_cols = [h for h in headers if h.startswith("方案")]
            opts = table_after(text, "方案选项")
            if len(option_cols) < 2:
                print("ERROR: arch.md 方案选项 table needs ≥2 option columns (方案 A / 方案 B ...)", file=sys.stderr)
                errs += 1
            if not opts:
                print("ERROR: arch.md 方案选项 table has no filled row (权衡维度)", file=sys.stderr)
                errs += 1
            if not section_exists(text, "方向对齐"):
                print("ERROR: arch.md missing section 方向对齐 (逐条标 符合/偏离/缺口)", file=sys.stderr)
                errs += 1
            else:
                body = "\n".join(section_lines(text, "方向对齐"))
                if not any(k in body for k in ("符合", "偏离", "缺口")):
                    print("ERROR: arch.md 方向对齐 section lacks 符合/偏离/缺口 annotations", file=sys.stderr)
                    errs += 1

            # ---- architecture review（仅 arch.md 存在时要求，交锋段格式） ----
            ok, msg = review_structured(review_arch, "review-arch.md (arch-reviewer)")
            if not ok:
                print(f"ERROR: {msg}", file=sys.stderr)
                errs += 1
            elif review_arch.is_file() and "原话对照" not in review_arch.read_text(encoding="utf-8"):
                print("ERROR: review-arch.md (arch-reviewer) lacks 原话对照 (rubric 第 0 条：对照 quote.md)", file=sys.stderr)
                errs += 1
        # else: 页面/前端类愿望无 arch.md → 跳过（不报错）

    # ---- build gate: plan.md 必查 + contract.md 条件式 ----------------------
    if phase == "build":
        if not plan_md.is_file():
            print(f"ERROR: missing {plan_md}", file=sys.stderr)
            errs += 1
        else:
            plan = plan_md.read_text(encoding="utf-8")
            srows = table_after(plan, "纵向切片")
            if not srows:
                print("ERROR: plan.md 纵向切片 table missing", file=sys.stderr)
                errs += 1
            else:
                good = [r for r in srows
                        if filled(r.get("切片 ID", "")) and filled(r.get("入口", ""))
                        and filled(r.get("触及路径", ""))
                        and any(re.search(r"T-\d+", str(v)) for v in r.values())]
                if not good:
                    print("ERROR: 纵向切片 has no complete row (切片ID+入口+T-xxx oracle+触及路径)", file=sys.stderr)
                    errs += 1
        if contract_md.is_file():
            contract = contract_md.read_text(encoding="utf-8")
            rows = table_after(contract, "事实映射")
            if not rows:
                print("ERROR: contract.md 事实映射 table missing", file=sys.stderr)
                errs += 1
            else:
                filled_rows = [r for r in rows
                               if filled(r.get("入口", "")) and filled(r.get("代码调用点", "")) and filled(r.get("证据级", ""))]
                if not filled_rows:
                    print("ERROR: 事实映射 has no filled row (入口+代码调用点+证据级)", file=sys.stderr)
                    errs += 1
                else:
                    for r in filled_rows:
                        ev = r.get("证据级", "")
                        if ev not in {"Verified", "Unverified", "Assumption"}:
                            print(f"ERROR: 事实映射 证据级 must be Verified|Unverified|Assumption, got {ev!r}", file=sys.stderr)
                            errs += 1
            m = re.search(r"主结果[^\n:：]*[：:]\s*(.+)", contract)
            if not m or not filled(m.group(1)):
                print("ERROR: contract.md 主结果 not filled", file=sys.stderr)
                errs += 1

    # ---- close gate: backfill existence checks (repo-aware) ------------------
    if phase == "close":
        repo_readme = root / "docs" / "README.md"
        if repo_readme.is_file() and "回填矩阵" in repo_readme.read_text(encoding="utf-8", errors="ignore"):
            handoff = root / "docs" / "reference" / "handoff.md"
            if not handoff.is_file() or wid not in handoff.read_text(encoding="utf-8", errors="ignore"):
                print("ERROR: close gate — docs/reference/handoff.md must reference wish id (会话收尾必更 handoff，禁脚本盲写)", file=sys.stderr)
                errs += 1
            product_text = product_md.read_text(encoding="utf-8", errors="ignore") if product_md.is_file() else ""
            dec_lines = [l for l in section_lines(product_text, "产品决策记录") if l.strip() and "持续补录" not in l]
            if dec_lines:  # 有实质决策 → 要求至少一处落库（gap-register 或 09-decisions）
                gap_reg = root / "docs" / "architecture" / "11-gap-register.md"
                dec_dir = root / "docs" / "architecture" / "09-decisions"
                found = False
                if gap_reg.is_file() and wid in gap_reg.read_text(encoding="utf-8", errors="ignore"):
                    found = True
                if not found and dec_dir.is_dir():
                    for f in dec_dir.iterdir():
                        if f.is_file() and wid in f.read_text(encoding="utf-8", errors="ignore"):
                            found = True
                            break
                if not found:
                    print("ERROR: close gate — product.md records real decisions but gap-register/09-decisions does not reference wish id", file=sys.stderr)
                    errs += 1
        else:
            print("check_spec: close gate skipped (repo has no docs/README.md 回填矩阵)")

    if errs:
        print(f"check_spec FAIL: {wid} phase={phase} ({errs} error(s))", file=sys.stderr)
        return 1
    print(f"check_spec OK: {wid} phase={phase}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
