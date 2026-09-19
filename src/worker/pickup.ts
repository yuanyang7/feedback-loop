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

  const next = await nextIssue(github, config.github.labels.agentReady);
  if (!next) return;

  if (dryRun) {
    info(`  ${dim(`[dry-run] would pick up #${next.number} — ${next.title}`)}`);
    return;
  }

  const channel = config.discord.channelId;
  const message = await postOpening(loaded, channel, next);
  const { pid } = startWorker(target, repoPath, { kind: "go", issue: next.number }, channel, message);
  claimRun(target, pid, `go #${next.number}`, next.number);
  info(`  ${bold(`picked up #${next.number}`)} ${cyan(next.title)} ${dim(`pid ${pid}`)}`);
}

/**
 * Highest severity first, oldest wins a tie so nothing starves. Anything a
 * human or an earlier run has already set aside is skipped.
 */
async function nextIssue(github: GitHubClient, readyLabel: string): Promise<Issue | null> {
  const candidates = await github.listIssues({ labels: [readyLabel], state: "open" });
  const rank = (issue: Issue): number => {
    const names = issue.labels.map((l) => l.name);
    if (names.includes("needs-decision") || names.includes("needs-info") || names.includes("in-progress")) {
      return -1;
    }
    if (names.includes("severity:high")) return 3;
    if (names.includes("severity:medium")) return 2;
    return 1;
  };
  return (
    candidates
      .filter((i) => rank(i) > 0)
      .sort((a, b) => rank(b) - rank(a) || a.number - b.number)[0] ?? null
  );
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
