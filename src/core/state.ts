import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface IntakeState {
  /** Discord snowflake of the last message intake has processed. */
  cursor: string | null;
  lastTickAt: string | null;
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

export function writeIntakeState(target: string, state: IntakeState): void {
  const path = intakeStatePath(target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
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
