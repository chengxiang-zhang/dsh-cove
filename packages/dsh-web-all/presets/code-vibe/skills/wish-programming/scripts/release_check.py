#!/usr/bin/env python3
"""Release readiness gate — 「具备上线条件了吗」的机械 PASS/FAIL 表，不可手写。

把上线条件从散文（"生产还跑旧代码 / 没有回滚演练 / 告警没在生产验证"）变成
九项可复算的判定。每项只有 PASS / FAIL / UNRUN 三种结论，没有"大概可以"。

Usage:
  python3 release_check.py <workspace> <id> [--run] [--json]
Exit: 0 全部 PASS; 1 存在 FAIL/UNRUN; 2 usage error.

Inputs (相对解析后的 workspace 根):
  .sdd/release/<id>.env                   KEY=VALUE 发布计划（# 注释、空行忽略，值可含空格）
  .sdd/acceptance/<id>.deploy-authorized  by= / ts= / quote= 授权标记（journey.sh 写入）
  .sdd/acceptance/<id>/e2e/steps.md       至少两个编号步骤（1. 与 2.）
  .sdd/acceptance/<id>/e2e/run.log        非空
  .sdd/acceptance/<id>/**                 至少一张 *.png|*.jpg|*.jpeg|*.webp 截图

Checks (顺序即输出顺序):
  plan        计划文件存在，十个必需键非空，TARGET 恰好是 production
  change-set  workspace 是 git 仓，工作区无未提交改动，详情记 HEAD 与分支
  e2e         浏览器端到端证据（steps.md / run.log / 截图）
  authorized  授权标记字段齐全、ts 是 ISO-8601、标记不早于计划（授权在计划之后）
  artifact    ARTIFACT 非空；带 @sha256: 时 digest 必须是 64 位小写十六进制
  version     --run：VERSION_CMD 退出码 0 且输出含 VERSION_EXPECT
  smoke       --run：SMOKE_CMD 退出码 0 且输出含 SMOKE_PROOF（绝 ok/200/pass/true/health 这类弱证明）
  rollback    --run：ROLLBACK 非空且 ROLLBACK_CHECK_CMD 退出码 0
  alert       --run：ALERT_CMD 退出码 0 且确实打印了内容

无 --run 时四项命令检查判 UNRUN（detail 为 needs --run），退出码 1。

Evidence（本脚本只写这里，不改动仓内其他内容）:
  .sdd/release/<id>/<check>.log  执行命令的检查（change-set 与四项命令检查）的
                                 cmd / cwd / exit / stdout / stderr 全量留证
  .sdd/release/<id>/status.tsv   每次运行整体重写：check<TAB>verdict<TAB>detail

注意：证据与授权标记都落在 .sdd/ 下；change-set 只统计 .sdd/ 之外的改动，因为发布
状态不是源码改动（把它算进"工作树不干净"会让第二次 --run 永远红）。
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REQUIRED_PLAN_KEYS = (
    "TARGET",
    "ENV",
    "ARTIFACT",
    "VERSION_CMD",
    "VERSION_EXPECT",
    "SMOKE_CMD",
    "SMOKE_PROOF",
    "ROLLBACK",
    "ROLLBACK_CHECK_CMD",
    "ALERT_CMD",
)

# 弱证明：只证明"进程活着"，不证明产品行为。SMOKE_PROOF 命中其一即拒绝。
WEAK_SMOKE_PROOFS = ("ok", "200", "pass", "true", "health")
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")
COMMAND_TIMEOUT = 300
GIT_TIMEOUT = 60
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}")
STEP_PATTERN = re.compile(r"^\s*(\d+)[.)]\s+\S")


class CommandResult(object):
    """One recorded command: exit code plus both captured streams."""

    __slots__ = ("code", "stdout", "stderr", "timedout")

    def __init__(self, code, stdout, stderr, timedout=False):
        self.code = code
        self.stdout = stdout
        self.stderr = stderr
        self.timedout = timedout

    @property
    def output(self):
        return self.stdout + self.stderr


def decode(raw):
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    return raw.decode("utf-8", "replace")


def run_command(command, cwd, timeout):
    """Run `command` through `sh -c` in `cwd` and capture exit code, stdout, stderr."""
    try:
        proc = subprocess.run(
            ["sh", "-c", command],
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return CommandResult(124, decode(exc.stdout), decode(exc.stderr), True)
    except OSError as exc:
        return CommandResult(127, "", "cannot execute: {}".format(exc))
    return CommandResult(proc.returncode, decode(proc.stdout), decode(proc.stderr))


def run_git(root, *args):
    """Run a read-only git probe against `root`."""
    command = ["git", "-C", str(root)] + [str(arg) for arg in args]
    try:
        proc = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=GIT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return CommandResult(124, "", "git timed out", True)
    except OSError as exc:
        return CommandResult(127, "", "cannot execute git: {}".format(exc))
    return CommandResult(proc.returncode, decode(proc.stdout), decode(proc.stderr))


def snippet(text, limit=120):
    """First non-blank line of `text`, trimmed for a one-line table cell."""
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:limit] + ("..." if len(line) > limit else "")
    return "<no output>"


def unquote(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def parse_kv(path):
    """Parse `KEY=VALUE` lines; blank lines and `#` comments are ignored."""
    data = {}
    if not path.is_file():
        return data
    text = path.read_text(encoding="utf-8", errors="replace")
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not key:
            continue
        data[key] = unquote(value.strip())
    return data


def parse_iso(value):
    """Parse an ISO-8601 timestamp; returns None when it is not one."""
    text = value.strip()
    if not text:
        return None
    candidate = text[:-1] + "+00:00" if text[-1] in ("Z", "z") else text
    try:
        return datetime.fromisoformat(candidate)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def tsv_cell(text):
    return re.sub(r"[\t\r\n]+", " ", text).strip()


class Gate(object):
    """The nine release checks for one wish id inside one workspace."""

    def __init__(self, root, wid, run):
        self.root = root
        self.id = wid
        self.run = run
        self.plan_path = root / ".sdd" / "release" / "{}.env".format(wid)
        self.evidence_dir = root / ".sdd" / "release" / wid
        self.acceptance_dir = root / ".sdd" / "acceptance" / wid
        self.marker_path = root / ".sdd" / "acceptance" / "{}.deploy-authorized".format(wid)
        self.plan = parse_kv(self.plan_path)
        self.results = []

    @property
    def target(self):
        return self.plan.get("ENV", "").strip() or "missing"

    def rel(self, path):
        try:
            return path.relative_to(self.root).as_posix()
        except ValueError:
            return str(path)

    def plan_value(self, key):
        return self.plan.get(key, "").strip()

    def record(self, name, verdict, detail, entries=None):
        self.results.append({"name": name, "verdict": verdict, "detail": detail})
        if entries:
            self.write_log(name, entries)

    def write_log(self, name, entries):
        """Capture cmd / cwd / exit / stdout / stderr for every command a check ran."""
        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        blocks = []
        for command, result in entries:
            blocks.append("# check={}".format(name))
            blocks.append("cmd: {}".format(command))
            blocks.append("cwd: {}".format(self.root))
            suffix = " (timeout)" if result.timedout else ""
            blocks.append("exit: {}{}".format(result.code, suffix))
            blocks.append("--- stdout ---")
            blocks.append(result.stdout.rstrip("\n"))
            blocks.append("--- stderr ---")
            blocks.append(result.stderr.rstrip("\n"))
            blocks.append("")
        path = self.evidence_dir / "{}.log".format(name)
        path.write_text("\n".join(blocks), encoding="utf-8")

    def write_status(self):
        """Rewrite status.tsv for this run: check<TAB>verdict<TAB>detail."""
        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        rows = [
            "{}\t{}\t{}".format(item["name"], item["verdict"], tsv_cell(item["detail"]))
            for item in self.results
        ]
        path = self.evidence_dir / "status.tsv"
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    # ---- checks ------------------------------------------------------------

    def check_plan(self):
        if not self.plan_path.is_file():
            return "FAIL", "missing {}".format(self.rel(self.plan_path)), None
        missing = [key for key in REQUIRED_PLAN_KEYS if not self.plan_value(key)]
        if missing:
            return "FAIL", "missing or empty keys: {}".format(", ".join(missing)), None
        if self.plan_value("TARGET") != "production":
            return "FAIL", "TARGET must be production, got {!r}".format(self.plan_value("TARGET")), None
        return "PASS", "{} has {} keys, env={}".format(
            self.rel(self.plan_path), len(REQUIRED_PLAN_KEYS), self.plan_value("ENV")
        ), None

    def check_change_set(self):
        probe = run_git(self.root, "rev-parse", "--is-inside-work-tree")
        entries = [("git -C <root> rev-parse --is-inside-work-tree", probe)]
        if probe.code != 0 or probe.stdout.strip() != "true":
            return "FAIL", "not a git work tree ({})".format(snippet(probe.output)), entries
        status = run_git(self.root, "status", "--porcelain")
        entries.append(("git -C <root> status --porcelain", status))
        if status.code != 0:
            return "FAIL", "git status failed ({})".format(snippet(status.output)), entries
        dirty = self.source_changes(status.stdout)
        if dirty:
            return "FAIL", "{} uncommitted path(s), first: {}".format(
                len(dirty), snippet(dirty[0])
            ), entries
        head = run_git(self.root, "rev-parse", "HEAD")
        branch = run_git(self.root, "rev-parse", "--abbrev-ref", "HEAD")
        entries.append(("git -C <root> rev-parse HEAD", head))
        entries.append(("git -C <root> rev-parse --abbrev-ref HEAD", branch))
        sha = head.stdout.strip()
        if head.code != 0 or not sha:
            return "FAIL", "cannot read HEAD ({})".format(snippet(head.output)), entries
        name = branch.stdout.strip() or "unknown"

        # A local-only commit is not a released change set: the deploy must be
        # reproducible from the remote. Skipped only when the workspace has no
        # remote at all, and the PASS detail then says so instead of pretending.
        remotes = run_git(self.root, "remote")
        entries.append(("git -C <root> remote", remotes))
        pushed = "local-only (no remote configured)"
        if remotes.code == 0 and remotes.stdout.strip():
            upstream = run_git(self.root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
            entries.append(("git -C <root> rev-parse --abbrev-ref --symbolic-full-name @{u}", upstream))
            if upstream.code != 0:
                return "FAIL", "no upstream for HEAD (push the branch before releasing)", entries
            ahead = run_git(self.root, "rev-list", "--count", "@{u}..HEAD")
            entries.append(("git -C <root> rev-list --count @{u}..HEAD", ahead))
            if ahead.code != 0:
                return "FAIL", "cannot count unpushed commits ({})".format(snippet(ahead.output)), entries
            count = ahead.stdout.strip() or "0"
            if count != "0":
                return "FAIL", "{} unpushed commit(s) vs {}".format(count, upstream.stdout.strip()), entries
            pushed = "pushed to {}".format(upstream.stdout.strip())

        return "PASS", "clean work tree, head={} branch={} {}".format(sha, name, pushed), entries

    @staticmethod
    def source_changes(porcelain_output):
        """Porcelain entries that are real source changes: .sdd/ state is not source."""
        changes = []
        for line in porcelain_output.splitlines():
            if not line.strip():
                continue
            entry = line[3:] if len(line) > 3 else line.strip()
            if " -> " in entry:
                entry = entry.split(" -> ", 1)[1]
            entry = entry.strip().strip('"')
            if entry.startswith(".sdd/"):
                continue
            changes.append(line)
        return changes

    def check_e2e(self):
        e2e = self.acceptance_dir / "e2e"
        steps = e2e / "steps.md"
        run_log = e2e / "run.log"
        problems = []
        if not steps.is_file():
            problems.append("missing {}".format(self.rel(steps)))
        else:
            numbers = set()
            for line in steps.read_text(encoding="utf-8", errors="replace").splitlines():
                match = STEP_PATTERN.match(line)
                if match:
                    numbers.add(int(match.group(1)))
            if not {1, 2}.issubset(numbers):
                problems.append("{} needs numbered steps 1. and 2. (found {})".format(
                    self.rel(steps), sorted(numbers) if numbers else "none"
                ))
        if not run_log.is_file():
            problems.append("missing {}".format(self.rel(run_log)))
        elif not run_log.read_text(encoding="utf-8", errors="replace").strip():
            problems.append("{} is empty".format(self.rel(run_log)))
        images = []
        if self.acceptance_dir.is_dir():
            images = [
                path for path in self.acceptance_dir.rglob("*")
                if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
            ]
        if not images:
            problems.append("no screenshot (*.png|*.jpg|*.jpeg|*.webp) under {}".format(
                self.rel(self.acceptance_dir)
            ))
        if problems:
            return "FAIL", "; ".join(problems), None
        return "PASS", "steps=2+ run.log non-empty screenshots={} ({})".format(
            len(images), self.rel(images[0])
        ), None

    def check_authorized(self):
        marker = self.marker_path
        if not marker.is_file():
            return "FAIL", "missing {}".format(self.rel(marker)), None
        fields = parse_kv(marker)
        missing = [key for key in ("by", "ts", "quote") if not fields.get(key, "").strip()]
        if missing:
            return "FAIL", "marker missing field(s): {}".format(", ".join(missing)), None
        stamp = fields["ts"].strip()
        if parse_iso(stamp) is None:
            return "FAIL", "ts is not ISO-8601: {!r}".format(stamp), None
        if not self.plan_path.is_file():
            return "FAIL", "no plan at {} to order the authorization against".format(
                self.rel(self.plan_path)
            ), None
        marker_ns = marker.stat().st_mtime_ns
        plan_ns = self.plan_path.stat().st_mtime_ns
        if marker_ns < plan_ns:
            return "FAIL", "authorization is older than the plan (write the marker after the plan)", None
        return "PASS", "by={} ts={} quote recorded after the plan".format(
            fields["by"].strip(), stamp
        ), None

    def check_artifact(self):
        artifact = self.plan_value("ARTIFACT")
        if not artifact:
            return "FAIL", "ARTIFACT empty", None
        if "@sha256:" in artifact:
            digest = artifact.split("@sha256:", 1)[1].strip()
            if not DIGEST_PATTERN.fullmatch(digest):
                return "FAIL", "digest must be 64 lowercase hex chars, got {!r}".format(
                    digest[:24] + ("..." if len(digest) > 24 else "")
                ), None
            return "PASS", "digest-pinned {}".format(artifact), None
        return "PASS", "tag={} (no @sha256 digest pinned)".format(artifact), None

    def check_version(self):
        if not self.run:
            return "UNRUN", "needs --run", None
        command = self.plan_value("VERSION_CMD")
        expect = self.plan_value("VERSION_EXPECT")
        if not command:
            return "FAIL", "VERSION_CMD missing from the release plan", None
        if not expect:
            return "FAIL", "VERSION_EXPECT missing from the release plan", None
        result = run_command(command, self.root, COMMAND_TIMEOUT)
        entries = [(command, result)]
        if result.timedout:
            return "FAIL", "VERSION_CMD timed out after {}s".format(COMMAND_TIMEOUT), entries
        if result.code != 0:
            return "FAIL", "VERSION_CMD exit={} ({})".format(result.code, snippet(result.output)), entries
        if expect not in result.output:
            return "FAIL", "VERSION_EXPECT {!r} not in output ({})".format(expect, snippet(result.output)), entries
        return "PASS", "deployed version reads {} (`{}`)".format(expect, command), entries

    def check_smoke(self):
        if not self.run:
            return "UNRUN", "needs --run", None
        command = self.plan_value("SMOKE_CMD")
        proof = self.plan_value("SMOKE_PROOF")
        if not command:
            return "FAIL", "SMOKE_CMD missing from the release plan", None
        if not proof:
            return "FAIL", "SMOKE_PROOF missing from the release plan", None
        weak = proof.lower()
        if len(proof) < 4 or weak in WEAK_SMOKE_PROOFS:
            return "FAIL", "SMOKE_PROOF {!r} too weak (>=4 chars, not {})".format(
                proof, "/".join(WEAK_SMOKE_PROOFS)
            ), None
        result = run_command(command, self.root, COMMAND_TIMEOUT)
        entries = [(command, result)]
        if result.timedout:
            return "FAIL", "SMOKE_CMD timed out after {}s".format(COMMAND_TIMEOUT), entries
        if result.code != 0:
            return "FAIL", "SMOKE_CMD exit={} ({})".format(result.code, snippet(result.output)), entries
        if proof not in result.output:
            return "FAIL", "SMOKE_PROOF {!r} not in output ({})".format(proof, snippet(result.output)), entries
        return "PASS", "product smoke proved {} (`{}`)".format(proof, command), entries

    def check_rollback(self):
        if not self.run:
            return "UNRUN", "needs --run", None
        point = self.plan_value("ROLLBACK")
        command = self.plan_value("ROLLBACK_CHECK_CMD")
        if not point:
            return "FAIL", "ROLLBACK missing from the release plan", None
        if not command:
            return "FAIL", "ROLLBACK_CHECK_CMD missing from the release plan", None
        result = run_command(command, self.root, COMMAND_TIMEOUT)
        entries = [(command, result)]
        if result.timedout:
            return "FAIL", "ROLLBACK_CHECK_CMD timed out after {}s".format(COMMAND_TIMEOUT), entries
        if result.code != 0:
            return "FAIL", "ROLLBACK_CHECK_CMD exit={} ({})".format(
                result.code, snippet(result.output)
            ), entries
        return "PASS", "rollback point {} verified (`{}`)".format(point, command), entries

    def check_alert(self):
        if not self.run:
            return "UNRUN", "needs --run", None
        command = self.plan_value("ALERT_CMD")
        if not command:
            return "FAIL", "ALERT_CMD missing from the release plan", None
        result = run_command(command, self.root, COMMAND_TIMEOUT)
        entries = [(command, result)]
        if result.timedout:
            return "FAIL", "ALERT_CMD timed out after {}s".format(COMMAND_TIMEOUT), entries
        if result.code != 0:
            return "FAIL", "ALERT_CMD exit={} ({})".format(result.code, snippet(result.output)), entries
        if not result.output.strip():
            return "FAIL", "ALERT_CMD printed nothing (no alert readback)", entries
        return "PASS", "alert readback: {}".format(snippet(result.output)), entries

    def run_all(self):
        ordered = (
            ("plan", self.check_plan),
            ("change-set", self.check_change_set),
            ("e2e", self.check_e2e),
            ("authorized", self.check_authorized),
            ("artifact", self.check_artifact),
            ("version", self.check_version),
            ("smoke", self.check_smoke),
            ("rollback", self.check_rollback),
            ("alert", self.check_alert),
        )
        for name, check in ordered:
            verdict, detail, entries = check()
            self.record(name, verdict, detail, entries)


def fail_lines(messages):
    for index, message in enumerate(messages, 1):
        print("ERROR {}: {}".format(index, message), file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="release_check.py",
        description="Release readiness gate: nine mechanical PASS/FAIL checks, no prose.",
    )
    parser.add_argument("workspace", help="workspace root, resolved to an absolute path")
    parser.add_argument("id", help="wish id used by .sdd/release/<id>.env and .sdd/acceptance/<id>*")
    parser.add_argument("--run", action="store_true", help="run the four declared commands")
    parser.add_argument("--json", action="store_true", help="print one JSON object instead of the table")
    args = parser.parse_args(argv)

    root = Path(args.workspace).resolve()
    if not root.is_dir():
        fail_lines(["workspace is not a directory: {}".format(root)])
        return 2
    if not ID_PATTERN.match(args.id):
        fail_lines(["id must match [A-Za-z0-9][A-Za-z0-9._-]* up to 64 chars, got {!r}".format(args.id)])
        return 2

    gate = Gate(root, args.id, args.run)
    gate.run_all()
    gate.write_status()

    passed = sum(1 for item in gate.results if item["verdict"] == "PASS")
    total = len(gate.results)
    if args.json:
        print(json.dumps({
            "spec": args.id,
            "target": gate.target,
            "checks": gate.results,
            "passed": passed,
            "total": total,
        }, ensure_ascii=False))
    else:
        print("release_check: {} spec={} target={}".format(root, args.id, gate.target))
        for item in gate.results:
            print("{:<5}  {:<10}  {}".format(item["verdict"], item["name"], item["detail"]))
        print("release_check: {}/{} PASS".format(passed, total))
    return 0 if passed == total else 1


def configure_streams():
    """Keep evidence readable under a non-UTF-8 locale (marker quotes are usually Chinese)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


if __name__ == "__main__":
    configure_streams()
    sys.exit(main())
