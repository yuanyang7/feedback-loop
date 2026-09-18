import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface IntakeState {
  /** Discord snowflake of the last message intake has processed. */
  cursor: string | null;
  lastTickAt: string | null;
  /** Cursors for command-only channels, keyed by channel id. */
  commandCursors?: Record<string, string>;
  /**
   * The last reaction reconcile set for each issue, keyed by issue number, and
   * whether that issue was closed at the time. A closed issue's state cannot
   * change again, so it never needs looking at twice.
   */
  reconciled?: Record<string, { state: string; final: boolean }>;
}

export interface RunLogEntry {
  at: string;
  kind: "intake" | "reconcile" | "worker";
  target: string;
  summary: string;
  /** Free-form detail — issue numbers, phase, outcome, cost. */
  data?: Record<string, unknown>;
}

const ROOT = process.env.FEEDBACK_LOOP_HOME ?? join(homedir(), ".feedback-loop");

export function stateDir(target: string): string {
  const dir = join(ROOT, target);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runsDir(target: string): string {
  const dir = join(stateDir(target), "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function intakeStatePath(target: string): string {
  return join(stateDir(target), "intake.json");
}

export function readIntakeState(target: string): IntakeState {
  const path = intakeStatePath(target);
  if (!existsSync(path)) return { cursor: null, lastTickAt: null };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as IntakeState;
  } catch {
    return { cursor: null, lastTickAt: null };
  }
}

/**
 * Merges rather than replaces. Several call sites update one field each — the
 * main cursor, the per-channel command cursors — and a plain overwrite meant
 * whichever wrote last silently erased the others. Merging makes that class of
 * bug impossible instead of relying on every caller remembering to carry the
 * whole object.
 */
export function writeIntakeState(target: string, state: Partial<IntakeState>): void {
  const path = intakeStatePath(target);
  mkdirSync(dirname(path), { recursive: true });
  const merged: IntakeState = { ...readIntakeState(target), ...state };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
}

export function appendRunLog(entry: RunLogEntry): void {
  const path = join(stateDir(entry.target), "runs.jsonl");
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function readRunLog(target: string, limit = 50): RunLogEntry[] {
  const path = join(stateDir(target), "runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunLogEntry];
      } catch {
        return [];
      }
    });
}
