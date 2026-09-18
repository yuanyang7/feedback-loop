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

export type Command =
  | { kind: "triage" | "fix"; issue: number }
  | { kind: "status" }
  | { kind: "help" };

const VERBS = /^(triage|fix|status|help)\b/i;

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
  if (verb === "help") return { kind: "help" };

  const issue = Number(rest.replace(/^#/, "").split(/\s+/)[0]);
  if (!Number.isInteger(issue) || issue <= 0) return null;
  return { kind: verb as "triage" | "fix", issue };
}

export function isOperator(message: DiscordMessage, operatorIds: string[]): boolean {
  return operatorIds.includes(message.author.id);
}

/**
 * One worker run at a time. Two concurrent runs would fight over the same
 * worktree and double the spend with nobody watching.
 */
function lockPath(target: string): string {
  return join(stateDir(target), "worker.lock");
}

export function activeRun(target: string): { pid: number; what: string; at: string } | null {
  const path = lockPath(target);
  if (!existsSync(path)) return null;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as { pid: number; what: string; at: string };
    process.kill(lock.pid, 0); // throws if the process is gone
    return lock;
  } catch {
    unlinkSync(path); // stale lock from a run that died
    return null;
  }
}

export function claimRun(target: string, pid: number, what: string): void {
  mkdirSync(stateDir(target), { recursive: true });
  writeFileSync(lockPath(target), JSON.stringify({ pid, what, at: new Date().toISOString() }));
}

export function releaseRun(target: string): void {
  const path = lockPath(target);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Start the run detached and return immediately. These take ten minutes or
 * more; holding the tick open for one would stall intake behind it.
 */
export function startWorker(
  target: string,
  repoDir: string,
  command: { kind: "triage" | "fix"; issue: number },
  announceChannel: string,
): { pid: number; logPath: string } {
  const logPath = join(stateDir(target), `worker-${command.kind}-${command.issue}.log`);
  const log = openSync(logPath, "a");
  // Re-enter through the launcher rather than process.argv: in development
  // argv[1] is a .ts file, and node cannot run one without tsx.
  const launcher = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "feedback-loop.mjs");
  const child = spawn(
    process.execPath,
    [launcher, command.kind, repoDir, "--issue", String(command.issue), "--announce", announceChannel],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  return { pid: child.pid!, logPath };
}

export const HELP = [
  "**feedback-loop** — mention me with one of these:",
  "",
  "`triage <issue>` — reproduce and size it. Never edits code.",
  "`fix <issue>` — implement, review adversarially, open a PR. Never merges.",
  "`status` — queue, spend, and what is waiting on you.",
  "",
  "A run takes ten minutes or more and I will reply when it finishes.",
].join("\n");

export function describeRejection(command: Command, reason: string): string {
  return `Can't run \`${command.kind}\` — ${reason}`;
}

export { info, warn, bold, dim };
