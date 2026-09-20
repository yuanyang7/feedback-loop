import {
  appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Write a file so that a power cut leaves either the old contents or the new
 * ones, never half of each.
 *
 * This is not hypothetical here. A plain `writeFileSync` truncates and then
 * writes, so an unclean shutdown in that window leaves a file that exists and
 * does not parse. Both readers below used to treat unparseable as absent, and
 * "absent" has a specific and terrible meaning for each: an absent cursor makes
 * intake adopt the newest message and file nothing, silently losing every
 * report since the last tick; an absent status table forgets every message the
 * bot has posted, so every stale one stays stale forever. Neither says a word.
 *
 * Write to a sibling, flush it to the platter, then rename — rename within a
 * directory is atomic, so a reader sees one version or the other.
 */
export function writeJsonAtomically(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    // Without the flush the rename can land before the bytes do, which on a
    // sudden power loss is the same torn file with extra steps.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/**
 * Read a JSON state file, treating "missing" and "damaged" as the different
 * things they are.
 *
 * Missing is ordinary: nothing has happened yet. Damaged means something was
 * lost, and guessing at a default there is how a corrupt cursor turns into a
 * quietly skipped week of reports. So it keeps a copy and refuses, loudly —
 * an unattended host will log the failure every tick until someone looks,
 * which is the correct amount of noise for "state was lost".
 */
function readJsonState<T>(path: string, missing: T, what: string): T {
  if (!existsSync(path)) return missing;
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    const kept = `${path}.corrupt`;
    try {
      copyFileSync(path, kept);
    } catch {
      // Keeping a copy is a courtesy; failing to is not worth masking the
      // real error with a second one.
    }
    throw new Error(
      `${what} at ${path} is damaged — most likely an unclean shutdown mid-write. ` +
        `A copy is at ${kept}. Repair it, or delete it and be aware of what that means: ` +
        `for intake.json, the next tick adopts the newest message and files nothing older; ` +
        `for status.json, the bot forgets which messages it has posted.`,
    );
  }
}

export interface IntakeState {
  /** Discord snowflake of the last message intake has processed. */
  cursor: string | null;
  lastTickAt: string | null;
  /** Cursors for command-only channels, keyed by channel id. */
  commandCursors?: Record<string, string>;
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
  return readJsonState<IntakeState>(
    intakeStatePath(target),
    { cursor: null, lastTickAt: null },
    "The intake cursor",
  );
}

/**
 * Merges rather than replaces. Several call sites update one field each — the
 * main cursor, the per-channel command cursors — and a plain overwrite meant
 * whichever wrote last silently erased the others. Merging makes that class of
 * bug impossible instead of relying on every caller remembering to carry the
 * whole object.
 */
export function writeIntakeState(target: string, state: Partial<IntakeState>): void {
  const merged: IntakeState = { ...readIntakeState(target), ...state };
  writeJsonAtomically(intakeStatePath(target), merged);
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
