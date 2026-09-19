/**
 * Starting a worker run from a phone.
 *
 * The grammar is fixed and parsed, never interpreted. A chat message selects
 * one action from a closed set and names an issue number; it is data, not an
 * instruction. Nothing here reaches a model, so there is nothing to talk into
 * doing something else — which matters, because the channel is a place other
 * people can type.
 *
 * Authorisation is a separate allowlist from every other id list in the config:
 * this one permits spending money and running code on someone's machine.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../core/state.js";
import { bold, dim, info, warn } from "../core/log.js";
import type { DiscordMessage } from "./discord.js";

/**
 * Split per verb rather than one object with a union `kind`: narrowing a
 * discriminant only narrows a union of object types, so the single-member form
 * left `ready` in the type everywhere a run is started.
 */
export type Command =
  | { kind: "triage"; issue: number }
  | { kind: "fix"; issue: number }
  | { kind: "ready"; issue: number }
  | { kind: "go"; issue: number }
  | { kind: "status" }
  | { kind: "queue" }
  | { kind: "help" };

const VERBS = /^(triage|fix|ready|go|status|queue|help)\b/i;

/**
 * Recognise a command, or return null and let the message be treated as a
 * report. Anything that is not an exact match is not a command — a near miss
 * must not be guessed at.
 */
export function parseCommand(
  message: DiscordMessage,
  botIds: string[],
  opts: { requireMention?: boolean } = {},
): Command | null {
  let text = message.content.trim();
  const mentioned = (message.mentions ?? []).some((m) => botIds.includes(m.id));
  for (const id of botIds) text = text.replace(new RegExp(`<@!?${id}>`, "g"), "").trim();
  // In a shared channel a mention is what distinguishes an instruction from
  // conversation. In a channel that exists only for commands there is nothing
  // to distinguish it from, so typing one would just be ceremony.
  if (opts.requireMention !== false && !mentioned) return null;

  const match = VERBS.exec(text);
  if (!match) return null;
  const verb = match[1]!.toLowerCase();
  const rest = text.slice(match[0].length).trim();

  if (verb === "status") return { kind: "status" };
  if (verb === "queue") return { kind: "queue" };
  if (verb === "help") return { kind: "help" };

  const issue = Number(rest.replace(/^#/, "").split(/\s+/)[0]);
  if (!Number.isInteger(issue) || issue <= 0) return null;
  return { kind: verb as "triage" | "fix" | "go", issue };
}

export function isOperator(message: DiscordMessage, operatorIds: string[]): boolean {
  return operatorIds.includes(message.author.id);
}

/**
 * Runs are tracked per issue, not globally. Two runs on the same issue would
 * fight over one worktree; two on different issues would not. What does bound
 * them is the machine — each run wants its own database, dev server and full
 * CI pass — so worker.maxConcurrentRuns exists, defaulting to 1.
 */
export interface RunLock {
  pid: number;
  what: string;
  at: string;
  /** Absent in locks written before per-issue tracking; recovered from `what`. */
  issue?: number;
}

function lockPath(target: string): string {
  return join(stateDir(target), "worker.lock");
}

/** Live runs, with entries for dead processes pruned as a side effect. */
export function activeRuns(target: string): RunLock[] {
  const path = lockPath(target);
  if (!existsSync(path)) return [];

  let entries: RunLock[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // Tolerate the single-object form this used to write.
    entries = Array.isArray(parsed) ? parsed : [parsed as RunLock];
  } catch {
    unlinkSync(path);
    return [];
  }

  const live = entries.filter((lock) => {
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (live.length !== entries.length) writeFileSync(path, JSON.stringify(live));
  return live;
}

export function claimRun(target: string, pid: number, what: string, issue: number): void {
  mkdirSync(stateDir(target), { recursive: true });
  const live = activeRuns(target);
  writeFileSync(lockPath(target), JSON.stringify([...live, { pid, what, at: new Date().toISOString(), issue }]));
}

export function releaseRun(target: string, pid = process.pid): void {
  const remaining = activeRuns(target).filter((lock) => lock.pid !== pid);
  writeFileSync(lockPath(target), JSON.stringify(remaining));
}

/** Why this run cannot start right now, or null. */
export function concurrencyRefusal(
  target: string,
  issue: number,
  maxConcurrent: number,
): string | null {
  const live = activeRuns(target);
  // Locks written before this field existed still name their issue in `what`.
  const issueOf = (lock: RunLock): number =>
    lock.issue ?? Number(/#(\d+)/.exec(lock.what)?.[1] ?? NaN);
  const sameIssue = live.find((lock) => issueOf(lock) === issue);
  if (sameIssue) {
    return `\`${sameIssue.what}\` is already running on that issue (started ${sameIssue.at.slice(11, 16)} UTC).`;
  }
  if (live.length >= maxConcurrent) {
    const names = live.map((lock) => `\`${lock.what}\``).join(", ");
    return (
      `${names} ${live.length === 1 ? "is" : "are"} running, and this machine is set to ` +
      `${maxConcurrent} at a time. Raise \`worker.maxConcurrentRuns\` to overlap them.`
    );
  }
  return null;
}

/**
 * Start the run detached and return immediately. These take ten minutes or
 * more; holding the tick open for one would stall intake behind it.
 */
export function startWorker(
  target: string,
  repoDir: string,
  command: { kind: "triage" | "fix" | "go"; issue: number },
  announceChannel: string,
  announceMessage: string | null,
): { pid: number; logPath: string } {
  const logPath = join(stateDir(target), `worker-${command.kind}-${command.issue}.log`);
  const log = openSync(logPath, "a");
  // Re-enter through the launcher rather than process.argv: in development
  // argv[1] is a .ts file, and node cannot run one without tsx.
  const launcher = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "feedback-loop.mjs");
  const child = spawn(
    process.execPath,
    [
      launcher, command.kind, repoDir,
      "--issue", String(command.issue),
      "--announce", announceChannel,
      ...(announceMessage ? ["--announce-message", announceMessage] : []),
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  return { pid: child.pid!, logPath };
}

export const HELP = [
  "**feedback-loop** — mention me with one of these:",
  "",
  "`ready <issue>` — clear it for an autonomous attempt. This is the gate; only you can open it.",
  "`triage <issue>` — reproduce and size it. Never edits code.",
  "`fix <issue>` — implement, review adversarially, open a PR. Never merges.",
  "`go <issue>` — all of the above in one run: clear it, reproduce it, fix it, open the PR.",
  "`status` — spend, and what is waiting on you.",
  "`queue` — what runs next, in order.",
  "",
  "A run takes ten minutes or more and I will reply when it finishes.",
].join("\n");

export function describeRejection(command: Command, reason: string): string {
  return `Can't run \`${command.kind}\` — ${reason}`;
}

export { info, warn, bold, dim };
