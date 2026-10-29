---
name: dsh-find-simplifications
description: 简化/减法/防复杂度累积； Find evidence-backed simplifications in DeepSeek Harness code, APIs, configuration, tests, and prose; write or consolidate proposals, identify small inline cleanups, or assess simplifications from another branch. Use for removing dead, duplicated, speculative, or unnecessarily maintained behavior and infrastructure.

<!-- provenance: ported from deepseek-ai/deepseek-harness/.agents/skills/dsh-find-simplifications @ 00102833dfaee1da9f48a3a8eae9d34005a75218 (MIT License, Copyright (c) 2026 DeepSeek). Content adapted for self-contained operation outside the upstream repo. -->
---

# Finding DeepSeek Harness Simplifications

Find changes that remove maintained obligations: APIs, representations, lifecycle states, configuration paths, dependencies, tests, or documentation. Prefer a few well-supported candidates over a count of deletions. This is guidance, not a checklist; keep the user's scope and distinguish a survey from permission to implement its proposals.

## Establish scope and constraints

Read the repository constitution（AGENTS.md、architecture、defensive patterns、testing policy——均源自 DeepSeek Harness）before judging packages. Consult relevant decision records for intentional decisions; use decision-record rules（proposed/implemented/rejected 骨架，源自 DeepSeek Harness note 体系）for new records. Archived notes are historical examples, not current authority: never inspect, verify, or repair their outbound links.

The two LLM adapters are intentional. JSONL is the sole first-party Session persistence provider, while the backend-neutral Service Definition supports out-of-tree providers. Do not propose deleting an LLM twin or the persistence seam unless the user explicitly overrides that constraint. Unused members within a protected design remain candidates when their removal preserves its purpose.

For broad requests, divide independent domains among subagents: loop and persistence; model/tool assembly; Host, Client, and SDKs; subprocess and execution providers; composition, scripts, tests, and documentation. Give each agent a bounded domain and require consumer evidence and rejected alternatives. Inspect substantial production machinery as well as obvious unused symbols; do not stop after the first promising deletion.

## Search for removable obligations

Use these questions to guide discovery. Read the relevant section of [historical patterns](references/historical-patterns.md) when a candidate needs calibration; the examples illustrate decisions, not a current deletion inventory.

- **Does a declared feature have a complete effect path?** Trace producer, transformations, provider or endpoint support, and observable result. A field copied everywhere may still have no setter, no reader, or only implementations that reject it. Search constructors and discriminant emitters as well as callers.
- **Which distinctions change a consumer's action?** Several internal states may require one model-facing status or one usable identifier. Keep internal distinctions that control authorization, residency, durability, or ownership; remove public distinctions that only invite an unusable choice.
- **Could a smaller explicit behavior remove the subsystem?** Fixed intervals, caller-supplied time zones, or reported activation failure can eliminate generalized calendars, persisted defaults, or automatic rollback. Name the capability given up and the machinery deleted. A production caller makes this a behavior decision, not an automatic rejection; implementation must remain within the user's authorization.
- **Can a consumer read the authoritative value when needed?** Look for copied histories, promotion ledgers, invalidation events followed by reads, and feature caches beside a shared projection stream. Derivation or reuse may delete subscriptions, retained data, stale-response handling, and recovery paths together. Establish the required time of observation first.
- **Is composition being mistaken for policy?** Optional service presence, a provider method, or a sibling tool can express availability without deciding deployment behavior. Explicit configuration or a caller-intent operation may remove registries and dependency checks. Preserve distinct operations when their ownership or completion timing differs.
- **What owns the complete maintenance cost?** Trace pass-through configuration, duplicate application trees, demo launchers used by products, resolver-only workspaces, and installation helpers with their own upgrade lifecycle. Compare the entire removed system with the replacement, including residual glue; moving complexity or adding a gate to keep duplicate definitions equal does not remove it.

## Prove reachability and the trade-off

Start with `rg`, then read the matches. Search exact symbols, property reads and writes, discriminants, event and wire strings, config keys, package names, and both `.method(` and `method(` forms. Tests and declarations can show a contract without proving a shipped producer or consumer.

Include `packages/*/*/src`, `apps/`, `python/`, runtime scripts, shipped profiles and overlays, package manifests and exports, loader resolution, generated runtime assets, and installed-package consumers. Classify examples and fixtures by their actual entry point rather than directory name. Follow generated catalogs to their consumers: a catalog used by model-written plugin mounts is a dynamic product API, while a documentation-only listing is not a fixed caller. Public third-party extension paths can be intentional despite zero repository call sites.

For each candidate, record the current owner, effective producer/consumer path, what disappears, what remains, and the strongest reason to retain it. Distinguish:

- removal of unreachable or unread behavior;
- a narrower public or product behavior with an explicit loss;
- a protected obligation or insufficient evidence.

Reject a candidate when it breaks a retained obligation, merely relocates the same complexity, or has no meaningful reduction. Read rejection reasons at the level of the proposed change: a stale inventory or a mixed proposal's rejected behavior does not settle every independent item. Refresh the evidence before re-proposing one. Small local improvements belong in actionable `TODO`/`FIXME`/`XXX` comments under the urgency rules（TODO/FIXME/XXX 按紧迫度分级）, not standalone design records.

## Preserve ownership and failure semantics

For copies, freezes, validators, and callback captures, name the value's origin, next owner, and trust boundary. Typed same-process calls ordinarily borrow readonly values; parsers, config loaders, queues, model/tool JSON, durable files, workers, processes, and wire decoders own or validate their inputs. Hostile-getter or callback-replacement tests do not establish a requirement by themselves. A frozen root does not prove its descendants immutable, and equal ids do not prove object identity.

For asynchronous machinery, map each promise, flag, cancellation path, disposer, and reservation to its owner and transition. Collapse mechanisms only when they express the same fact. Preserve synchronous publication and rollback, callback containment, first-terminal-outcome arbitration, worker/process ownership, and dispose-to-quiescence where required. Durable start/end markers can record real facts even when transcript renderers ignore them; dropping interrupted work is a capability loss, not redundant-log cleanup.

An invariant companion is justified by comparing independently produced observations that can diverge. Checks of service presence, plugin metadata, fixed examples, or the same mutation's return value do not qualify. Removing a companion includes its export, build entry, invariant-only compiler references, dependencies, and tests; record the package-specific omission reason in both READMEs. Keep checks comparing independent event producers, durable history, or mutable data.

## Replace infrastructure only for a net reduction

Follow the dependency policy（优先维护良好的依赖或 Node builtins；替换必须删除真实拥有的代码而非假设；评估维护/传递成本与残留语义）. Search existing dependencies and Node builtins at the engine floor before adding a package. Identify the exact implementation and dedicated tests the replacement deletes, its maintenance and transitive cost, and every residual behavior the glue must preserve.

Exercise the mismatches most likely to defeat the replacement: protocol truncation, cancellation and teardown, configured bounds, deterministic test clocks, platform packaging, and source versus built entry points. A library that covers framing but requires rebuilding the same framing to enforce a size limit is not a simplification. An accepted edge-behavior change belongs in the proposal and relevant tests. Do not re-prove a dependency's generic specification while omitting tests for the harness-specific shim.

## Record, consolidate, and validate

Use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) when prose is in scope. Remove code-restating or remotely owned explanations while preserving local behavior, timing, ownership, and failure obligations. Update affected READMEs, JSDoc, model-visible catalogs, configuration, snapshots, and generated files with their owning change.

A substantial proposal belongs in an Issue with `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, and `Risks`. Include concrete consumer evidence, the removed maintenance cost, the capability given up, and observable acceptance conditions. Record the implemented decision and verification evidence in the pull request and Git history. Update an existing Issue when the decision is the same; do not create duplicates to preserve candidate counts.

Before opening a new Issue, check whether an existing Issue or pull request owns the same decision. Preserve current durable, wire, compatibility, or rejected-alternative obligations in the code or current documentation that owns them.

When folding another branch, compare its independent diff against the target base, port only supported non-overlapping proposals, and consolidate overlapping rationale. Closing another PR requires authorization or clear ownership of that housekeeping.

For docs-only issue or pull request work, run 项目自身的文档/静态检查（如 package.json 的 lint/typecheck 脚本）与 `git diff --check`（本环境无 doc-sync 门禁；文档改动以人工对照 + wish-programming 的 quote/模板一致性检查为准）; for skill or comment edits, include the applicable validator. Select other checks through pre-push minimal-evidence discipline（只跑与改动相关的验证）。 Report the surveyed areas, supported candidates, meaningful rejections or deferrals, notes added/consolidated/retained/removed, and commands actually run. 展开中的调研先把候选登记到 gap-register/工单（本环境无 draft PR 流程）；do not describe an unverified search as exhaustive.
