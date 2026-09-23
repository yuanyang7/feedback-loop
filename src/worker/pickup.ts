/**
 * Start the next queued run when there is room for it, and — where no worker
 * host exists — decide what goes into the queue in the first place.
 *
 * Called from a tick, so it inherits the schedule rather than needing one. It
 * starts at most one run and returns: the gate, the concurrency limit and the
 * open-PR cap all still apply, and the point is to keep the queue moving, not
 * to drain it.
 *
 * Split across hosts, the two halves land in different places. An intake host
 * can judge what *should* run — that is a GitHub question — but has nothing to
 * run it on, so it promotes work into the queue and stops. A worker host does
 * the opposite: it never chooses unasked work, because choosing means posting
 * a Discord message and recording that we posted it, and `status.json` has
 * exactly one writer by design. Each host does the half it can do honestly.
 */
import { readSecret, requireRepo, type LoadedConfig } from "../core/config.js";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { bold, cyan, dim, info, warn } from "../core/log.js";
import { stateDir } from "../core/state.js";
import { activeRuns, claimRun, startWorker } from "../intake/commands.js";
import { GitHubClient, type Issue } from "../intake/github.js";
import { checkGate } from "./gate.js";
import { readStatus, recordStatus } from "../core/tracker.js";
import { dropRequest, enqueueRequest, readQueue, recordAsk, type RunRequest } from "./queue.js";
import { HUMAN_OWNED } from "./handoff.js";

/**
 * Drain the queue: start the oldest asked-for run that can still run.
 *
 * On a host that does everything, this also picks up unasked work when the
 * auto policy allows and the queue is empty — unchanged from before the split.
 * On a worker host it does not, because the intake host already did that part
 * and put the result in the queue.
 */
export async function pickUpWork(
  loaded: LoadedConfig,
  dryRun: boolean,
  role: "all" | "worker" = "all",
): Promise<void> {
  const { config } = loaded;
  const target = config.target.name;
  const repoPath = requireRepo(loaded);

  if (activeRuns(target).length >= config.worker.maxConcurrentRuns) return;

  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  // `auto: never` governs what starts unasked. Work a person explicitly asked
  // for is not that, and must still drain — otherwise turning auto off silently
  // swallows every queued request instead of just declining to invent new ones.
  // A bare label is an ask with no detail. On this host we can fill it in;
  // on a worker host we cannot, because posting the Discord message the run
  // will edit means recording that we posted it, and `status.json` has one
  // writer. There, such a request waits for the intake host's next tick.
  // Before anything else, clean up after a host that died mid-run.
  await clearStaleClaims(github, config, target, dryRun);

  if (role === "all") await adoptBareRequests(loaded, github, dryRun);

  const queue = (await readQueue(github, config)).filter((r) => {
    if (role !== "worker" || r.at !== "") return true;
    info(`  ${dim(`holding #${r.issue} — labelled by hand; the intake host will pick up the detail`)}`);
    return false;
  });
  if (queue.length === 0 && (role === "worker" || config.worker.auto === "never")) return;

  warnAboutLegacyQueue(target);

  const gate = await checkGate(config, github);
  if (!gate.ok) {
    info(`  ${dim(`not picking up work — ${gate.reason}`)}`);
    return;
  }

  // Asked-for work goes first, and goes whatever the auto policy says: someone
  // typed the issue number, which is the same decision `auto` exists to avoid
  // making on its own.
  const requested = await nextRequest(github, config, queue);
  if (requested) {
    const { request, issue } = requested;
    if (dryRun) {
      info(`  ${dim(`[dry-run] would start queued ${request.kind} #${issue.number}`)}`);
      return;
    }
    // Claim before dequeuing, in that order. Between the two, an intake host
    // ticking would see no queue and no `in-progress` and conclude nothing is
    // moving — and promote a second issue on top of this one. The run itself
    // also applies this label and removes it however it ends, so claiming
    // early is idempotent rather than a second thing to clean up.
    await github.addLabels(issue.number, ["in-progress"]);
    await dropRequest(github, config, issue.number, `▶️ Starting \`${request.kind}\`.`);
    const { pid } = startWorker(
      target, repoPath, { kind: request.kind, issue: issue.number }, request.channel || null, request.message,
    );
    claimRun(target, pid, `${request.kind} #${issue.number}`, issue.number);
    info(`  ${bold(`started queued ${request.kind} #${issue.number}`)} ${cyan(issue.title)} ${dim(`pid ${pid}`)}`);
    return;
  }

  if (role === "worker" || config.worker.auto === "never") return;

  const next = await nextIssue(github, config.github.labels.agentReady, config.worker.auto);
  if (!next) return;

  // One query, on the chosen candidate only. A run removes agent-ready when it
  // opens a PR, so this should never fire — but the label can be re-applied by
  // hand, and redoing finished work is expensive enough to be worth a check
  // rather than a comment saying it cannot happen.
  const existing = await github.linkedPullRequest(next.number).catch(() => null);
  if (existing?.state === "OPEN") {
    info(`  ${dim(`not picking up #${next.number} — PR #${existing.number} is already open on it`)}`);
    return;
  }

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
 * Put unasked work into the queue, from a host that cannot run it.
 *
 * This is the auto policy doing its job across the split: the judgement — is
 * this urgent, is this easy, is anything already moving — is entirely about
 * GitHub, so it can be made here. What it must not do is make that judgement
 * repeatedly while the worker host is asleep, which would put the whole
 * backlog in the queue over a weekend. So it promotes one issue and only when
 * nothing else is outstanding: nothing queued, nothing in progress.
 *
 * That is deliberately stricter than the local version, which checks a live
 * process list it cannot see from here. It trades throughput for a queue that
 * can never be longer than the person watching it expects.
 */
export async function promoteAutoWork(loaded: LoadedConfig, dryRun: boolean): Promise<void> {
  const { config } = loaded;
  if (config.worker.auto === "never") return;

  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const queue = await readQueue(github, config);
  if (queue.length > 0) return;

  // Filtered by the API, not by paging everything and filtering here: `gh
  // issue list` returns newest first and truncates at the limit, so on a repo
  // with more open issues than the page size an older `in-progress` would
  // fall off the end and this guard would wave through a second run.
  const running = await github.listIssues({ labels: ["in-progress"], state: "open" });
  if (running.length > 0) return;

  // The PR cap only. Spend is read from the worker host's run log, which this
  // host does not have; that check belongs at drain time, where the log is.
  const gate = await checkGate(config, github, { spendCaps: false });
  if (!gate.ok) {
    info(`  ${dim(`not queueing work — ${gate.reason}`)}`);
    return;
  }

  const ready = await github.listIssues({ labels: [config.github.labels.agentReady], state: "open" });
  const next = orderQueue(ready).find((i) => startsUnasked(i, config.worker.auto));
  if (!next) return;

  if (dryRun) {
    info(`  ${dim(`[dry-run] would queue #${next.number} — ${next.title}`)}`);
    return;
  }

  const channel = config.discord.channelId;
  // Announce once. If the queue write below fails — a GitHub 5xx is exactly
  // what the tick's error handling exists for — the next tick picks the same
  // issue again, and without this it would post a second "picked up" line
  // every five minutes until GitHub recovered.
  const announced = readStatus(config.target.name, next.number)?.botMessages ?? [];
  const message = announced.at(-1) ?? (await postOpening(loaded, channel, next));
  if (message) recordStatus(config.target.name, next.number, { botMessage: message, channel });
  await enqueueRequest(github, config, {
    issue: next.number,
    kind: "go",
    channel,
    message,
    by: `auto (${config.worker.auto})`,
  });
  info(`  ${bold(`queued #${next.number}`)} ${cyan(next.title)} ${dim("— waiting for a worker host")}`);
}

/**
 * The oldest queued request that can still run, dropping any that cannot.
 *
 * A request can sit here for a weekend, which is long enough for the issue to
 * be closed or for someone to label it `needs-info`. Re-reading GitHub rather
 * than trusting the queue is what keeps a stale ask from spending ten minutes
 * on work that was already resolved.
 */
async function nextRequest(
  github: GitHubClient,
  config: LoadedConfig["config"],
  queue: RunRequest[],
): Promise<{ request: RunRequest; issue: Issue } | null> {
  for (const request of queue) {
    const issue = await github.getIssue(request.issue).catch(() => null);
    if (!issue || issue.state !== "OPEN") {
      info(`  ${dim(`dropping queued #${request.issue} — ${issue ? "closed" : "gone"}`)}`);
      await dropRequest(github, config, request.issue, "Dequeued — the issue is closed.");
      continue;
    }
    // The same narrow rule the command applied when it took the request: `go`
    // clears its own gate, but nothing acts on an issue too thin to act on.
    if (issue.labels.some((l) => l.name === "needs-info")) {
      info(`  ${dim(`holding queued #${request.issue} — needs-info`)}`);
      continue;
    }
    // A handoff drains the queue as it claims, so this only catches a request
    // made after the fact — but that is the case where a person is already in
    // the worktree, which is the worst one to get wrong.
    if (issue.labels.some((l) => l.name === HUMAN_OWNED)) {
      info(`  ${dim(`holding queued #${request.issue} — a person has it`)}`);
      continue;
    }
    return { request, issue };
  }
  return null;
}

/**
 * Take `in-progress` off issues whose run no longer exists.
 *
 * A run claims that label and removes it however it ends — but "however it
 * ends" assumes the process gets to run its last line. A power cut, or a
 * `kill -9`, does not grant that. What is left is an issue that looks busy
 * forever: it is held out of the queue, and an intake host's promotion guard
 * sees work in flight and stops queueing anything at all. The loop goes quiet
 * and nothing says why.
 *
 * Only a host that runs work can judge this, and it can judge it exactly:
 * runs happen here and nowhere else, so a claim with no live process behind
 * it is stale by definition. Deliberately not done on an intake host, which
 * would be guessing about a machine it cannot see.
 */
export async function clearStaleClaims(
  github: GitHubClient,
  config: LoadedConfig["config"],
  target: string,
  dryRun: boolean,
): Promise<void> {
  const claimed = await github.listIssues({ labels: ["in-progress"], state: "open" });
  if (claimed.length === 0) return;

  const live = new Set(activeRuns(target).map((lock) => lock.issue ?? Number(/#(\d+)/.exec(lock.what)?.[1] ?? NaN)));
  for (const issue of claimed) {
    if (live.has(issue.number)) continue;
    if (dryRun) {
      info(`  ${dim(`[dry-run] would clear stale in-progress on #${issue.number}`)}`);
      continue;
    }
    await github.removeLabels(issue.number, ["in-progress"]);
    warn(`cleared stale in-progress on #${issue.number} — its run did not finish`);
  }
}

/**
 * Give every hand-labelled request the detail a run needs.
 *
 * Only a host that owns `status.json` may do this, because it posts the
 * message the run will edit and has to record that it did.
 */
export async function adoptBareRequests(
  loaded: LoadedConfig,
  github: GitHubClient,
  dryRun: boolean,
): Promise<void> {
  const { config } = loaded;
  for (const request of await readQueue(github, config)) {
    if (request.at !== "") continue;
    const issue = await github.getIssue(request.issue).catch(() => null);
    if (!issue || issue.state !== "OPEN") continue;
    if (dryRun) {
      info(`  ${dim(`[dry-run] would adopt hand-labelled #${request.issue}`)}`);
      continue;
    }
    const channel = config.discord.channelId;
    const message = await postOpening(loaded, channel, issue);
    if (message) recordStatus(config.target.name, issue.number, { botMessage: message, channel });
    await recordAsk(github, { issue: issue.number, kind: "go", channel, message, by: "label" });
    info(`  ${bold(`adopted #${issue.number}`)} ${cyan(issue.title)} ${dim("— labelled by hand")}`);
  }
}

/**
 * The queue used to be `requests.json` on the machine that took the command.
 * Nothing reads it any more, and anything left in it at upgrade time is a
 * person who was told "queued, I'll start it when a slot frees" and would
 * otherwise never hear another word. Say so once, loudly, rather than losing
 * it quietly.
 */
function warnAboutLegacyQueue(target: string): void {
  const legacy = join(stateDir(target), "requests.json");
  if (!existsSync(legacy)) return;
  let pending: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(legacy, "utf8"));
    pending = Array.isArray(parsed) ? parsed : [];
  } catch {
    pending = [];
  }
  if (pending.length > 0) {
    warn(
      `${legacy} still holds ${pending.length} request(s) from the old local queue. ` +
        `The queue is now the \`fl:requested\` label — re-ask for those, then delete the file.`,
    );
  }
  renameSync(legacy, `${legacy}.migrated`);
}

/** Why an issue is not in line, or null if it is. */
export function heldBack(issue: Issue): string | null {
  const names = issue.labels.map((l) => l.name);
  // run-failed is here so `auto` never picks it up again on its own: a run
  // that crashes reproducibly would otherwise be retried every tick forever.
  // It does not block an explicit ask — nextRequest only refuses needs-info —
  // which is the whole point of the two being different states.
  // HUMAN_OWNED is here rather than only at the paths that start runs: this
  // function is what `nextIssue`, `promoteAutoWork` and every queue display
  // agree on, and a handed-off issue that reaches `promoteAutoWork` gets
  // enqueued, held forever by `nextRequest`, and wedges auto-promotion for
  // every other issue behind it — a liveness failure with no error anywhere.
  for (const label of ["needs-decision", "needs-info", "in-progress", "run-failed", HUMAN_OWNED]) {
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
