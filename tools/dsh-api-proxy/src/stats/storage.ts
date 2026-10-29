import fs from "fs";
import path from "path";
import type { StatsEvent } from "./recorder";

/**
 * Storage layer for the stats subsystem. The on-disk format is JSONL —
 * one event per line — appended via a long-lived write stream so request
 * latency isn't blocked on fsync. The file is the source of truth: the
 * in-memory aggregate is rebuilt from it on startup.
 */

export const STATS_FILENAME = "stats.jsonl";

export function statsFilePath(authDir: string): string {
  return path.join(authDir, STATS_FILENAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProvider(value: unknown): boolean {
  return value === "anthropic" || value === "codex" || value === "cursor";
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return (
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.cacheCreationInputTokens) &&
    isFiniteNumber(value.cacheReadInputTokens) &&
    isFiniteNumber(value.reasoningOutputTokens)
  );
}

function isStatsEvent(value: unknown): value is StatsEvent {
  if (!isObject(value)) return false;
  return (
    value.v === 1 &&
    typeof value.ts === "string" &&
    typeof value.apiKeyHash === "string" &&
    typeof value.ip === "string" &&
    typeof value.ua === "string" &&
    typeof value.endpoint === "string" &&
    isNullableString(value.model) &&
    (value.provider === null || isProvider(value.provider)) &&
    isNullableString(value.accountEmail) &&
    (value.status === "success" || value.status === "failure") &&
    isNullableString(value.failureKind) &&
    isFiniteNumber(value.statusCode) &&
    isFiniteNumber(value.latencyMs) &&
    isUsage(value.usage)
  );
}

/**
 * Replay every persisted event into `apply` synchronously. Corrupted lines
 * (partial writes after a crash, manual edits, schema mismatches) are
 * skipped with a console warning so a single bad line doesn't poison the
 * entire history.
 */
export function replayStatsEvents(
  filePath: string,
  apply: (event: StatsEvent) => void,
): { lines: number; skipped: number } {
  if (!fs.existsSync(filePath)) return { lines: 0, skipped: 0 };
  const raw = fs.readFileSync(filePath, "utf-8");
  let lines = 0;
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    lines++;
    try {
      const event = JSON.parse(line);
      if (!isStatsEvent(event)) {
        skipped++;
        continue;
      }
      apply(event);
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

/**
 * Append-only writer kept open for the lifetime of the recorder so each
 * event is a single non-blocking `stream.write()`. The 0o600 permission
 * matches token files — the JSONL contains hashed API keys + IPs which
 * we'd rather keep readable only by the operator.
 */
export class StatsAppender {
  private stream: fs.WriteStream | null = null;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  open(): void {
    if (this.stream) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // 0o600 only takes effect on file creation; pre-existing files keep
    // their mode. That's fine — the parent dir is 0o700.
    this.stream = fs.createWriteStream(this.filePath, {
      flags: "a",
      mode: 0o600,
    });
    this.stream.on("error", (err) => {
      console.error("[stats] write stream error:", err.message);
    });
  }

  append(event: StatsEvent): void {
    if (!this.stream) this.open();
    this.stream!.write(JSON.stringify(event) + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }
}
