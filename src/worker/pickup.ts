/**
 * Start the next queued run when there is room for it.
 *
 * Called from a tick, so it inherits the schedule rather than needing one. It
 * starts at most one run and returns: the gate, the concurrency limit and the
 * open-PR cap all still apply, and the point is to keep the queue moving, not
 * to drain it.
 */
import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info } from "../core/log.js";
import { activeRuns, claimRun, startWorker } from "../intake/commands.js";
import { GitHubClient, type Issue } from "../intake/github.js";
import { checkGate } from "./gate.js";
import { recordStatus } from "../core/tracker.js";

export async function pickUpWork(loaded: LoadedConfig, dryRun: boolean): Promise<void> {
  const { config, repoPath } = loaded;
  if (config.worker.auto === "never") return;

  const target = config.target.name;
  if (activeRuns(target).length >= config.worker.maxConcurrentRuns) return;

  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const gate = await checkGate(config, github);
  if (!gate.ok) {
    info(`  ${dim(`not picking up work — ${gate.reason}`)}`);
    return;
  }

  const next = await nextIssue(github, config.github.labels.agentReady, config.worker.auto);
  if (!next) return;

  if (dryRun) {
    info(`  ${dim(`[dry-run] would pick up #${next.number} — ${next.title}`)}`);
    return;
  }

  const channel = config.discord.channelId;
  const message = await postOpening(loaded, channel, next);
  if (message) recordStatus(target, next.number, { botMessage: message, channel });
  const { pid } = startWorker(target, repoPath, { kind: "go", issue: next.number }, channel, message);
  claimRun(target, pid, `go #${next.number}`, next.number);
  info(`  ${bold(`picked up #${next.number}`)} ${cyan(next.title)} ${dim(`pid ${pid}`)}`);
}

/** Why an issue is not in line, or null if it is. */
export function heldBack(issue: Issue): string | null {
  const names = issue.labels.map((l) => l.name);
  for (const label of ["needs-decision", "needs-info", "in-progress"]) {
    if (names.includes(label)) return label;
  }
  return null;
}

export function sizeOf(issue: Issue): "s" | "m" | "l" | null {
  const label = issue.labels.map((l) => l.name).find((n) => n.startsWith("size:"));
  const value = label?.slice(5);
  return value === "s" || value === "m" || value === "l" ? value : null;
}

/**
 * Whether this is one to start without being asked. Urgent because waiting has
 * a cost, or easy because a failed attempt is cheap — different arguments, both
 * sound, and neither covers the large-and-not-urgent middle, which is where an
 * unattended run spends the most to learn it should have asked.
 */
export function startsUnasked(issue: Issue, mode: "never" | "urgent-or-easy" | "ready"): boolean {
  if (mode === "never") return false;
  if (mode === "ready") return true;
  return severityOf(issue) === "high" || sizeOf(issue) === "s";
}

export function severityOf(issue: Issue): "high" | "medium" | "low" {
  const names = issue.labels.map((l) => l.name);
  if (names.includes("severity:high")) return "high";
  if (names.includes("severity:medium")) return "medium";
  return "low";
}

/**
 * Highest severity first, oldest wins a tie so nothing starves. Exported and
 * used by anything that shows the queue as well as by the picker — a display
 * with its own copy of this would drift and start quietly lying about what
 * runs next.
 */
export function orderQueue(issues: Issue[]): Issue[] {
  const rank = { high: 3, medium: 2, low: 1 } as const;
  return issues
    .filter((i) => heldBack(i) === null)
    .sort((a, b) => rank[severityOf(b)] - rank[severityOf(a)] || a.number - b.number);
}

async function nextIssue(
  github: GitHubClient,
  readyLabel: string,
  mode: "never" | "urgent-or-easy" | "ready",
): Promise<Issue | null> {
  const candidates = await github.listIssues({ labels: [readyLabel], state: "open" });
  return orderQueue(candidates).find((i) => startsUnasked(i, mode)) ?? null;
}

/** The one message the run will edit as it goes, so this adds a line, not four. */
async function postOpening(
  loaded: LoadedConfig,
  channel: string,
  issue: Issue,
): Promise<string | null> {
  const { DiscordClient } = await import("../intake/discord.js");
  const discord = new DiscordClient(
    readSecret(loaded.config.discord.tokenFile, "DISCORD_BOT_TOKEN"),
  );
  return discord
    .sendMessage(channel, `⏳ Picked up #${issue.number} — ${issue.title}\nI'll update this message as it goes.`)
    .catch(() => null);
}
