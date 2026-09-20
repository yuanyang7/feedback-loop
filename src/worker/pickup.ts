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
import { dropRequest, readRequests, type RunRequest } from "./requests.js";

export async function pickUpWork(loaded: LoadedConfig, dryRun: boolean): Promise<void> {
  const { config, repoPath } = loaded;
  const target = config.target.name;

  // `auto: never` governs what starts unasked. Work a person explicitly asked
  // for is not that, and must still drain — otherwise turning auto off silently
  // swallows every queued request instead of just declining to invent new ones.
  const requests = readRequests(target);
  if (config.worker.auto === "never" && requests.length === 0) return;

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

  // Asked-for work goes first, and goes whatever the auto policy says: someone
  // typed the issue number, which is the same decision `auto` exists to avoid
  // making on its own.
  const requested = await nextRequest(target, github, requests);
  if (requested) {
    const { request, issue } = requested;
    if (dryRun) {
      info(`  ${dim(`[dry-run] would start queued ${request.kind} #${issue.number}`)}`);
      return;
    }
    dropRequest(target, issue.number);
    const { pid } = startWorker(
      target, repoPath, { kind: request.kind, issue: issue.number }, request.channel, request.message,
    );
    claimRun(target, pid, `${request.kind} #${issue.number}`, issue.number);
    info(`  ${bold(`started queued ${request.kind} #${issue.number}`)} ${cyan(issue.title)} ${dim(`pid ${pid}`)}`);
    return;
  }

  if (config.worker.auto === "never") return;

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

/**
 * The oldest queued request that can still run, dropping any that cannot.
 *
 * A request can sit here for an hour, which is long enough for the issue to be
 * closed or for someone to label it `needs-info`. Re-reading GitHub rather than
 * trusting the queue is what keeps a stale ask from spending ten minutes on
 * work that was already resolved.
 */
async function nextRequest(
  target: string,
  github: GitHubClient,
  requests: RunRequest[],
): Promise<{ request: RunRequest; issue: Issue } | null> {
  for (const request of requests) {
    const issue = await github.getIssue(request.issue).catch(() => null);
    if (!issue || issue.state !== "OPEN") {
      info(`  ${dim(`dropping queued #${request.issue} — ${issue ? "closed" : "gone"}`)}`);
      dropRequest(target, request.issue);
      continue;
    }
    // The same narrow rule the command applied when it took the request: `go`
    // clears its own gate, but nothing acts on an issue too thin to act on.
    if (issue.labels.some((l) => l.name === "needs-info")) {
      info(`  ${dim(`holding queued #${request.issue} — needs-info`)}`);
      continue;
    }
    return { request, issue };
  }
  return null;
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
