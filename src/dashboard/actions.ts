/**
 * The buttons on the page.
 *
 * Each one is a chat command with a different front door: the same closed set
 * of verbs, the same gates, the same concurrency limit and queue. Nothing here
 * decides anything the chat path does not — a button that could start a run
 * chat would have refused is a second, weaker policy.
 *
 * Only the server's own page can press them (see `server.ts`): a local port
 * that starts paid runs on a POST is otherwise reachable from any tab open in
 * the same browser.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSecret, requireRepo, resolveRole, type LoadedConfig } from "../core/config.js";
import { stateDir } from "../core/state.js";
import { claimRun, concurrencyRefusal, startWorker } from "../intake/commands.js";
import { GitHubClient } from "../intake/github.js";
import { gateRefusal, openGate } from "../intake/run.js";
import { handBackFromChat, handOffFromChat } from "../worker/handoff.js";
import { enqueueRequest } from "../worker/queue.js";

export const ACTIONS = ["ready", "triage", "fix", "go", "mine", "back"] as const;
export type Action = (typeof ACTIONS)[number];

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Set after a successful hand-off, for the page to show. */
  handoff?: HandoffInfo | null;
}

/**
 * One at a time. Chat commands are handled in a loop; HTTP requests are not,
 * and the gap between the concurrency check and `claimRun` spans a GitHub
 * call — two clicks on the same issue inside it would start two workers in
 * one worktree.
 */
let last: Promise<unknown> = Promise.resolve();

export function runAction(loaded: LoadedConfig, action: Action, issue: number): Promise<ActionResult> {
  const next = last.then(() => runActionNow(loaded, action, issue));
  last = next.catch(() => undefined);
  return next;
}

async function runActionNow(loaded: LoadedConfig, action: Action, issue: number): Promise<ActionResult> {
  const { config } = loaded;
  const role = resolveRole(config);

  if (action === "ready") return settled(await openGate(loaded, issue, false), /cleared for triage/);
  if (action === "mine") {
    const result = settled(await handOffFromChat(loaded, issue, false, role), /is yours/);
    return result.ok ? { ...result, handoff: handoffInfo(loaded, issue) } : result;
  }
  if (action === "back") return settled(await handBackFromChat(loaded, issue, false), /is mine again/);

  const command = { kind: action, issue };
  // Same order as chat: a second run on one issue is never allowed, being at
  // the limit only means "later", and an intake host is always at its limit.
  const busy =
    role === "intake"
      ? { reason: "this host doesn't run work — a worker host will pick it up.", queueable: true }
      : concurrencyRefusal(config.target.name, issue, config.worker.maxConcurrentRuns);
  if (busy && !busy.queueable) return { ok: false, message: busy.reason };

  const refusal = await gateRefusal(loaded, command);
  if (refusal) return { ok: false, message: refusal };

  if (busy) {
    const github = new GitHubClient(
      config.target.repo,
      config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
    );
    const { position, alreadyQueued } = await enqueueRequest(github, config, {
      issue,
      kind: action,
      channel: "",
      message: null,
      by: "dashboard",
    });
    return {
      ok: true,
      message: alreadyQueued
        ? `#${issue} is already queued, at position ${position}.`
        : `Queued ${action} #${issue} at position ${position} — ${busy.reason}`,
    };
  }

  const { pid } = startWorker(config.target.name, requireRepo(loaded), command, null, null);
  claimRun(config.target.name, pid, `${action} #${issue}`, issue);
  return { ok: true, message: `Started ${action} #${issue} (pid ${pid}).` };
}

/**
 * The chat helpers answer in sentences, success and refusal alike; which one
 * came back is only visible in the wording.
 */
function settled(message: string, success: RegExp): ActionResult {
  return { ok: success.test(message), message };
}

/** The newest worker log for an issue, whichever verb wrote it. */
export function latestLog(target: string, issue: number): string | null {
  const dir = stateDir(target);
  if (!existsSync(dir)) return null;
  const suffix = `-${issue}.log`;
  const newest = readdirSync(dir)
    .filter((f) => f.startsWith("worker-") && f.endsWith(suffix))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  return newest ? join(dir, newest.f) : null;
}

export function readLogTail(path: string, maxBytes = 64 * 1024): string {
  // Worker output is coloured for a terminal; escapes are noise in a <pre>.
  const text = readFileSync(path, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  if (text.length <= maxBytes) return text;
  const tail = text.slice(-maxBytes);
  return `…\n${tail.slice(tail.indexOf("\n") + 1)}`;
}

export interface HandoffInfo {
  issue: number;
  path: string;
  branch: string;
  /** What to paste into an agent session opened in `path`. */
  prompt: string;
  /** The same, as one line for a terminal. */
  command: string;
}

/**
 * Where a handed-off issue's worktree is, and what to tell an agent there.
 *
 * Found by the briefing's first line rather than by directory name: `--slug`
 * lets a person name the worktree anything.
 */
export function handoffInfo(loaded: LoadedConfig, issue: number): HandoffInfo | null {
  if (!loaded.repoPath) return null;
  const worktrees = join(loaded.repoPath, ".worktrees");
  if (!existsSync(worktrees)) return null;
  const heading = `# Handed off: #${issue}\n`;
  const dir = readdirSync(worktrees)
    .map((d) => join(worktrees, d))
    .find((d) => {
      const briefing = join(d, "HANDOFF.md");
      return existsSync(briefing) && readFileSync(briefing, "utf8").startsWith(heading);
    });
  if (!dir) return null;

  let branch = "";
  try {
    branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  } catch {
    // Still worth showing the path without it.
  }
  const prompt = [
    `You're picking up GitHub issue #${issue} in ${loaded.config.target.repo}, handed off from the feedback-loop.`,
    `Work only in this worktree (${dir}${branch ? `, branch ${branch}` : ""}).`,
    "Read HANDOFF.md first: it has the report, what triage already found, and where the screenshots and transcripts are.",
    "Run `npm run lab -- setup --yes` before running anything — the .env here points at production.",
    "Then follow the repo's AGENTS.md workflow to fix it and ship a PR.",
  ].join("\n");
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  return { issue, path: dir, branch, prompt, command: `cd ${quote(dir)} && claude ${quote(prompt)}` };
}
