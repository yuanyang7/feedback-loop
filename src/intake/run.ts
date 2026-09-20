import { readSecret, requireRepo, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info, warn, yellow } from "../core/log.js";
import { makeClassifier } from "../core/llm.js";
import { appendRunLog, readIntakeState, writeIntakeState } from "../core/state.js";
import { recordStatus } from "../core/tracker.js";
import { classifyReports, type Decision } from "./classify.js";
import { DiscordClient, messageUrl, type DiscordMessage } from "./discord.js";
import { setState } from "./emoji.js";
import { encodeFooter } from "./footer.js";
import { GitHubClient, type Issue } from "./github.js";
import { heldBack, orderQueue, severityOf } from "../worker/pickup.js";
import { enqueueRequest, readQueue } from "../worker/queue.js";
import { anchorOf, groupMessages, renderReport, type Report } from "./group.js";
import {
  activeRuns, claimRun, concurrencyRefusal, describeRejection, HELP, isOperator, parseCommand,
  startWorker,
} from "./commands.js";

export interface IntakeOptions {
  /** Classify and print, but create nothing and react to nothing. */
  dryRun: boolean;
  /** On a fresh cursor, process this many recent messages instead of skipping them. */
  backfill: number;
  /**
   * `intake` when this host has no checkout and cannot run anything, so every
   * accepted command becomes a queued request rather than a process.
   */
  role?: "all" | "intake";
}

export async function runIntake(loaded: LoadedConfig, opts: IntakeOptions): Promise<void> {
  const { config } = loaded;
  const target = config.target.name;

  const discord = new DiscordClient(readSecret(config.discord.tokenFile, "DISCORD_BOT_TOKEN"));
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const state = readIntakeState(target);
  let cursor = state.cursor;

  // Command-only channels are polled first and independently: they carry no
  // reports, so nothing here reaches the classifier or costs anything.
  await pollCommandChannels(loaded, discord, state, opts.dryRun, opts.role ?? "all");

  // First run: adopt the newest message as the cursor rather than filing the
  // entire channel history as issues. --backfill opts into some history.
  if (cursor === null && opts.backfill === 0) {
    const recent = await discord.fetchMessages(config.discord.channelId, null, 1);
    const newest = recent.at(-1);
    if (!opts.dryRun) {
      writeIntakeState(target, { cursor: newest?.id ?? null, lastTickAt: new Date().toISOString() });
    }
    info(
      newest
        ? `No cursor yet — starting from message ${dim(newest.id)}. Use --backfill N to include history.`
        : "Channel is empty — nothing to adopt as a cursor yet.",
    );
    return;
  }

  // Discord rejects limit=0, which a bare --backfill 0 would otherwise produce.
  const limit = Math.max(1, cursor === null ? Math.min(opts.backfill, 100) : config.intake.lookbackLimit);
  const messages = await discord.fetchMessages(config.discord.channelId, cursor, limit);
  if (messages.length === 0) {
    info("No new messages.");
    if (!opts.dryRun) writeIntakeState(target, { cursor, lastTickAt: new Date().toISOString() });
    return;
  }

  // Commands are pulled out before classification: they are instructions to the
  // tool, not reports about the product, and filing them as issues would be
  // both wrong and expensive.
  const remaining = await handleCommands(loaded, discord, messages, opts.dryRun, undefined, true, opts.role ?? "all");

  const reports = groupMessages(remaining, {
    ignoreAuthorIds: config.discord.ignoreAuthorIds,
    mentionTriggerIds: config.discord.mentionTriggerIds,
  });
  info(`${messages.length} new message(s) -> ${reports.length} candidate report(s).`);
  if (reports.length === 0) {
    if (!opts.dryRun) {
      writeIntakeState(target, { cursor: messages.at(-1)!.id, lastTickAt: new Date().toISOString() });
    }
    return;
  }

  const channelName = await discord.channelName(config.discord.channelId);
  const openIssues = await github.listIssues({ state: "open", limit: 200 });
  const classifier = makeClassifier(config.intake.backend, config.intake.model, config.intake.effort);
  const { decisions, costUsd } = await classifyReports(reports, openIssues, classifier);
  if (costUsd !== null) info(`classified ${reports.length} report(s) for ${dim(`$${costUsd.toFixed(4)}`)}`);

  let filed = 0;
  let duplicates = 0;
  let skipped = 0;

  // Iterate decisions, not reports: one report can now yield several issues,
  // which is what happens when someone raises two unrelated things in a row.
  for (const decision of decisions) {
    const report = reports[decision.index]!;
    const anchor = anchorOf(report);
    const link = messageUrl(config.discord.guildId, config.discord.channelId, anchor.id);
    const label = `${dim(`#${decision.index}`)} ${report.authorName}: ${decision.kind} ${dim(`(${decision.confidence.toFixed(2)})`)}`;

    if (decision.kind === "noise" || decision.kind === "question") {
      skipped += 1;
      info(`${label} ${dim("skipped —")} ${dim(decision.reasoning)}`);
      continue;
    }

    // An explicit @-mention is a human asking directly; it does not need to clear
    // the confidence floor the way passively-observed chat does.
    //
    // Below the floor we still file, tagged needs-info. Dropping it would lose a
    // real report silently whenever nobody circles back, which is the same
    // failure as a wrong duplicate — and closing a thin issue is ten seconds.
    const lowConfidence = !report.directed && decision.confidence < config.intake.minConfidence;
    if (lowConfidence) {
      info(`${label} ${yellow("below confidence floor")} ${dim("— filing as needs-info")}`);
    }

    let related: Issue | undefined;
    if (decision.duplicateOf !== null) {
      const existing = openIssues.find((i) => i.number === decision.duplicateOf);
      const sure = decision.duplicateConfidence >= config.intake.minDuplicateConfidence;
      if (existing && !sure) {
        // File it, but carry the suspicion forward so a human can collapse the
        // two in one click if the model was right after all.
        related = existing;
        info(
          `${label} ${yellow(`possibly duplicate of #${existing.number}`)} ` +
            `${dim(`(${decision.duplicateConfidence.toFixed(2)} < ${config.intake.minDuplicateConfidence})`)} — filing separately, linked`,
        );
      }
      if (existing && sure) {
        duplicates += 1;
        info(`${label} ${cyan(`duplicate of #${existing.number}`)} ${existing.title}`);
        if (!opts.dryRun) {
          await github.commentOnIssue(
            existing.number,
            `Also reported by **${report.authorName}** in Discord: ${link}\n\n> ${renderReport(report).replace(/\n/g, "\n> ")}`,
          );
          await setState(discord, config.discord.channelId, anchor.id, "duplicate");
          await replyWithIssue(
            loaded, discord, anchor.id,
            `Already tracked — ${issueLink(config.target.repo, existing.number)} · ${existing.title}`,
            existing.number,
          );
        }
        continue;
      }
    }

    const body = issueBody(decision, report, {
      guildId: config.discord.guildId,
      channelId: config.discord.channelId,
      channelName,
      related,
      lowConfidence: lowConfidence ? decision.reasoning : undefined,
    });
    const title = `${config.github.titlePrefix}${config.github.titlePrefix ? " " : ""}${decision.title}`;
    const labels = [
      config.github.labels.source,
      ...(lowConfidence ? [config.github.labels.needsInfo] : []),
      `severity:${decision.severity}`,
      `size:${decision.sizeHint}`,
      decision.kind === "feature" ? "enhancement" : "bug",
      ...(autoReady(config.intake.autoAgentReady, decision, lowConfidence)
        ? [config.github.labels.agentReady]
        : []),
    ];

    if (opts.dryRun) {
      filed += 1;
      console.log(`\n${bold(`[dry-run] would file: ${title}`)}\n${dim(labels.join("  "))}\n${body}\n`);
      continue;
    }

    const number = await github.createIssue({ title, body, labels });
    filed += 1;
    info(`${label} ${bold(`filed #${number}`)} ${decision.title}`);
    // Keep the question mark on a thin report: it is filed, but the reporter is
    // the only one who can make it actionable.
    await setState(discord, config.discord.channelId, anchor.id, lowConfidence ? "unclear" : "logged");
    recordStatus(target, number, {
      state: lowConfidence ? "unclear" : "logged",
      channel: config.discord.channelId,
      anchor: anchor.id,
      title,
    });
    await replyWithIssue(
      loaded, discord, anchor.id,
      lowConfidence
        ? `Filed as ${issueLink(config.target.repo, number)} — but I couldn't tell what's actually going wrong from this. Could you add specifics?`
        : autoReady(config.intake.autoAgentReady, decision, lowConfidence)
          ? `Filed as ${issueLink(config.target.repo, number)} · ${decision.title}\n\`severity:${decision.severity}\` — cleared for triage automatically. Reply \`triage ${number}\` to start one.`
          : `Filed as ${issueLink(config.target.repo, number)} · ${decision.title}`,
      number,
    );
  }

  const newest = messages.at(-1)!.id;
  if (!opts.dryRun) {
    writeIntakeState(target, { cursor: newest, lastTickAt: new Date().toISOString() });
    appendRunLog({
      at: new Date().toISOString(),
      kind: "intake",
      target,
      summary: `${filed} filed, ${duplicates} duplicate, ${skipped} skipped from ${messages.length} message(s)`,
      data: { filed, duplicates, skipped, messages: messages.length, cursor: newest, costUsd },
    });
  }
  info(`${bold("done")} — ${filed} filed, ${duplicates} duplicate, ${skipped} skipped.`);
}

export /**
 * Returns the messages that are not commands. A command from someone not on the
 * operator list is answered, not silently dropped — saying no out loud is how
 * people learn the boundary exists.
 */
async function handleCommands(
  loaded: LoadedConfig,
  discord: DiscordClient,
  messages: DiscordMessage[],
  dryRun: boolean,
  channel: string = loaded.config.discord.channelId,
  requireMention = true,
  role: "all" | "intake" = "all",
): Promise<DiscordMessage[]> {
  const { config } = loaded;
  const botIds = config.discord.mentionTriggerIds;
  const remaining: DiscordMessage[] = [];

  for (const message of messages) {
    const command = parseCommand(message, botIds, { requireMention });
    if (!command) {
      remaining.push(message);
      continue;
    }

    const reply = async (text: string): Promise<void> => {
      info(`  ${dim("->")} ${text.split("\n")[0]}`);
      if (!dryRun) await discord.sendMessage(channel, text, message.id).catch(() => undefined);
    };

    if (!isOperator(message, config.discord.operatorIds)) {
      warn(`command "${command.kind}" from non-operator ${message.author.username} — refused`);
      await reply(`Sorry ${message.author.username}, you're not on the operator list for this repo.`);
      continue;
    }

    if (command.kind === "help") {
      await reply(HELP);
      continue;
    }
    if (command.kind === "status") {
      await reply(await statusLine(loaded, role));
      continue;
    }
    if (command.kind === "queue") {
      await reply(await queueLine(loaded, role));
      continue;
    }
    if (command.kind === "ready") {
      await reply(await openGate(loaded, command.issue, dryRun));
      continue;
    }

    // On an intake host there is nothing to be busy with: no run has ever
    // started here and none can. Every accepted command is a queued request,
    // which is not a degraded path — it is the same mechanism a busy machine
    // already used, with the limit permanently at zero.
    const busy =
      role === "intake"
        ? { reason: "no worker host is awake right now.", queueable: true }
        : concurrencyRefusal(config.target.name, command.issue, config.worker.maxConcurrentRuns);
    if (busy && !busy.queueable) {
      await reply(describeRejection(command, busy.reason));
      continue;
    }

    // Check the gate before promising ten minutes. The worker would refuse this
    // in a second anyway, and a promise followed by silence is worse than a
    // refusal — it leaves someone waiting on a run that already died. This runs
    // before queueing too: a place in line for work that can never start is the
    // same broken promise, just delayed.
    const refusal = await gateRefusal(loaded, command);
    if (refusal) {
      await reply(refusal);
      continue;
    }

    // At the machine's limit, but the work is sound — take the request rather
    // than making the person who asked remember to ask again. The notice posted
    // here is the run's own message: when a slot frees, the worker edits this
    // line instead of adding another to the channel.
    if (busy) {
      if (dryRun) {
        await reply(`[dry-run] would queue \`${command.kind} #${command.issue}\``);
        continue;
      }
      const notice = await discord
        .sendMessage(channel, `🕒 #${command.issue} queued — ${busy.reason} I'll start it when a slot frees.`, message.id)
        .catch(() => null);
      const { position, alreadyQueued } = await enqueueRequest(github(loaded), config, {
        issue: command.issue,
        kind: command.kind,
        channel,
        message: notice,
        by: message.author.username,
      });
      if (alreadyQueued) {
        await reply(`#${command.issue} is already queued, at position ${position}.`);
      } else if (notice) {
        recordStatus(config.target.name, command.issue, { botMessage: notice, channel });
        info(`  ${bold(`queued ${command.kind} #${command.issue}`)} ${dim(`position ${position}`)}`);
      } else {
        await reply(`🕒 #${command.issue} queued at position ${position}.`);
      }
      continue;
    }

    if (dryRun) {
      await reply(`[dry-run] would start \`${command.kind} #${command.issue}\``);
      continue;
    }

    // Post the run's one message first, then hand its id to the worker so every
    // later phase edits this line instead of adding another to the channel.
    const opening =
      command.kind === "go"
        ? `⏳ #${command.issue} — reproducing, then fixing. I'll update this message as it goes.`
        : `⏳ \`${command.kind}\` on #${command.issue} — I'll update this message when it's done.`;
    const runMessage = dryRun ? null : await discord.sendMessage(channel, opening, message.id).catch(() => null);

    // The run's message is the one that ages worst — it says "starting", then
    // "stopped, needs you", and stays that way after the work ships.
    if (runMessage) recordStatus(config.target.name, command.issue, { botMessage: runMessage, channel });
    const { pid, logPath } = startWorker(config.target.name, requireRepo(loaded), command, channel, runMessage);
    claimRun(config.target.name, pid, `${command.kind} #${command.issue}`, command.issue);
    info(`  ${bold(`started ${command.kind} #${command.issue}`)} ${dim(`pid ${pid}`)}`);
    if (runMessage) continue; // the message above is the reply
    await reply(
      (command.kind === "go"
        ? `On it — #${command.issue}: reproduce, fix, review, PR. Twenty minutes or so, and I'll report at each step.\n`
        : `Starting \`${command.kind}\` on #${command.issue}. This takes ten minutes or more — I'll reply when it's done.\n`) +
        `<sub>${logPath}</sub>`,
    );
  }
  return remaining;
}

/**
 * Each command channel keeps its own cursor, so a reply in one never re-runs a
 * command from another, and a first poll adopts the newest message rather than
 * replaying whatever was already there.
 */
/**
 * Returns a message explaining why this cannot start, or null if it can. The
 * label is deliberately not applied for you: it is the gate that says a human
 * cleared this for an autonomous attempt, so the reply says how to grant it.
 */
/**
 * Apply the gate label. Kept as its own verb rather than folded into `triage`:
 * the whole point of the label is that a person decided, and doing it silently
 * on their behalf while starting a run would erase the decision it records.
 */
async function openGate(loaded: LoadedConfig, issue: number, dryRun: boolean): Promise<string> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  const found = await github.getIssue(issue).catch(() => null);
  if (!found) return `#${issue} doesn't exist.`;
  if (found.state !== "OPEN") return `#${issue} is closed.`;

  const has = (name: string): boolean => found.labels.some((l) => l.name === name);
  if (has(config.github.labels.agentReady)) {
    return `#${issue} is already cleared — reply \`triage ${issue}\` to start one.`;
  }
  if (has(config.github.labels.needsInfo)) {
    return `#${issue} is labelled \`needs-info\` — it's too thin to act on. Add specifics first, or clear the label yourself if it's wrong.`;
  }
  if (dryRun) return `[dry-run] would clear #${issue}`;

  await github.addLabels(issue, [config.github.labels.agentReady]);
  return `#${issue} cleared for triage. Reply \`triage ${issue}\` to start one.\n${found.title}`;
}

async function gateRefusal(
  loaded: LoadedConfig,
  command: { kind: "triage" | "fix" | "go"; issue: number },
): Promise<string | null> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  const issue = await github.getIssue(command.issue).catch(() => null);
  if (!issue) return `Can't run \`${command.kind}\` — #${command.issue} doesn't exist.`;
  if (issue.state !== "OPEN") return `Can't run \`${command.kind}\` — #${command.issue} is closed.`;

  const has = (name: string): boolean => issue.labels.some((l) => l.name === name);
  // `go` clears the gate itself — typing it at an issue is the decision.
  if (command.kind === "go") {
    return has("needs-info")
      ? `#${command.issue} is labelled \`needs-info\` — too thin to act on. It needs specifics first.`
      : null;
  }
  const needed = command.kind === "triage" ? config.github.labels.agentReady : config.github.labels.readyToFix;
  if (!has(needed)) {
    return command.kind === "triage"
      ? `#${command.issue} isn't cleared yet — that gate says a person judged it safe to hand to an agent.\nReply \`ready ${command.issue}\` to clear it.`
      : `#${command.issue} isn't labelled \`${needed}\` — only an issue triage actually reproduced gets a fix attempt. Try \`triage ${command.issue}\` first.`;
  }
  if (has("needs-info")) {
    return `#${command.issue} is labelled \`needs-info\` — it's too thin to act on. It needs specifics before an agent can do anything with it.`;
  }
  return null;
}

/**
 * Whether this report clears the gate on its own. Deliberately narrow: only a
 * bug (a feature request is a product decision before it is an engineering
 * one), only above the configured severity, and never one filed below the
 * confidence floor — a report too thin for a person to act on is not one an
 * agent can reproduce.
 */
function autoReady(
  setting: "never" | "high" | "medium",
  decision: Decision,
  lowConfidence: boolean,
): boolean {
  if (setting === "never" || lowConfidence || decision.kind !== "bug") return false;
  return setting === "high" ? decision.severity === "high" : decision.severity !== "low";
}

function issueLink(repo: string, number: number): string {
  return `[#${number}](https://github.com/${repo}/issues/${number})`;
}

async function replyWithIssue(
  loaded: LoadedConfig,
  discord: DiscordClient,
  messageId: string,
  text: string,
  issue?: number,
): Promise<void> {
  if (!loaded.config.discord.replyWithIssue) return;
  const sent = await discord
    .sendMessage(loaded.config.discord.channelId, text, messageId)
    .catch(() => null); // a failed reply must not cost us the filed issue
  // Remembered so reconcile can rewrite it later. Without this the reply keeps
  // saying "filed" long after the work shipped, and nothing knows it is there.
  if (sent && issue !== undefined) {
    recordStatus(loaded.config.target.name, issue, { botMessage: sent });
  }
}

async function pollCommandChannels(
  loaded: LoadedConfig,
  discord: DiscordClient,
  state: ReturnType<typeof readIntakeState>,
  dryRun: boolean,
  role: "all" | "intake" = "all",
): Promise<void> {
  const channels = loaded.config.discord.commandChannelIds;
  if (channels.length === 0) return;

  const cursors = { ...(state.commandCursors ?? {}) };
  let changed = false;

  for (const channel of channels) {
    const seen = cursors[channel] ?? null;
    const messages = await discord
      .fetchMessages(channel, seen, seen ? 50 : 1)
      .catch((error: Error) => {
        warn(`command channel ${channel}: ${error.message.slice(0, 120)}`);
        return [] as DiscordMessage[];
      });
    if (messages.length === 0) continue;

    if (seen !== null) {
      await handleCommands(loaded, discord, messages, dryRun, channel, false, role);
    }
    cursors[channel] = messages.at(-1)!.id;
    changed = true;
  }

  if (changed && !dryRun) {
    writeIntakeState(loaded.config.target.name, { ...state, commandCursors: cursors });
  }
}

/** A client for the target repo, from wherever the token is configured. */
function github(loaded: LoadedConfig): GitHubClient {
  const { config } = loaded;
  return new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
}

async function queueLine(loaded: LoadedConfig, role: "all" | "intake" = "all"): Promise<string> {
  const { config } = loaded;
  const gh = github(loaded);
  const [ready, prs, inProgress] = await Promise.all([
    gh.listIssues({ labels: [config.github.labels.agentReady], state: "open" }),
    gh.listPullRequests({ state: "open" }),
    // What is running is a local process list — except on an intake host,
    // where the run is on a machine this one cannot see. There the answer has
    // to come from GitHub, and `in-progress` is exactly the claim a run makes
    // when it starts. Asking `queue` from a phone and being told "nothing is
    // running" while the worker is mid-fix is the worst possible answer.
    role === "intake"
      ? gh.listIssues({ labels: ["in-progress"], state: "open" })
      : Promise.resolve([]),
  ]);
  const lined = orderQueue(ready);
  const held = ready.filter((i) => heldBack(i) !== null);
  const agentPrs = prs.filter((pr) => (pr.labels ?? []).some((l) => l.name === config.github.labels.agentPr));
  const running =
    role === "intake"
      ? inProgress.map((i) => ({ what: `#${i.number}` }))
      : activeRuns(config.target.name);

  // Asked-for runs are shown apart from the derived queue and above it, because
  // that is the order they will actually start in — folding them together would
  // put a request behind issues it is going to overtake.
  const requested = await readQueue(gh, config);
  if (lined.length === 0 && held.length === 0 && requested.length === 0) return "Queue is empty.";

  const lines: string[] = [];
  if (requested.length > 0) {
    lines.push(
      `**Asked for** — starts next, whatever \`auto\` says`,
      ...requested.map((r, n) => {
        const title = ready.find((i) => i.number === r.issue)?.title ?? "";
        return `${n === 0 ? "▸" : "  "} **#${r.issue}** \`${r.kind}\` ${title} — asked by ${r.by}`.replace(/\s+—/, " —");
      }),
      "",
    );
  }

  lines.push(
    ...lined
      .slice(0, 8)
      .map((i, n) => `${n === 0 && requested.length === 0 ? "▸" : "  "} **#${i.number}** \`${severityOf(i)}\` ${i.title}`),
  );
  if (lined.length > 8) lines.push(`  …and ${lined.length - 8} more`);

  if (running.length > 0) lines.push(`\n🔧 ${running.map((r) => r.what).join(", ")} running`);
  else if (agentPrs.length >= config.worker.maxOpenPRs) {
    lines.push(`\n⏸ ${agentPrs.length} PR(s) open, cap ${config.worker.maxOpenPRs} — merge one to free a slot`);
  }
  if (held.length > 0) {
    lines.push(`\nSet aside: ${held.map((i) => `#${i.number} (${heldBack(i)})`).join(", ")}`);
  }
  return lines.join("\n");
}

async function statusLine(loaded: LoadedConfig, role: "all" | "intake" = "all"): Promise<string> {
  const gh = github(loaded);
  const labels = loaded.config.github.labels;
  const [ready, readyToFix, blocked, prs, inProgress] = await Promise.all([
    gh.listIssues({ labels: [labels.agentReady], state: "open" }),
    gh.listIssues({ labels: [labels.readyToFix], state: "open" }),
    gh.listIssues({ labels: [labels.needsDecision], state: "open" }),
    gh.listPullRequests({ state: "open" }),
    // As in `queueLine`: on an intake host the run is on a machine this one
    // cannot see, so the local process list is always empty and would report
    // "nothing running" straight through a fix. `in-progress` is the claim a
    // run makes on GitHub, and it is visible from both hosts.
    role === "intake" ? gh.listIssues({ labels: ["in-progress"], state: "open" }) : Promise.resolve([]),
  ]);
  const agentPrs = prs.filter((p) => (p.labels ?? []).some((l) => l.name === labels.agentPr));
  const running =
    role === "intake"
      ? inProgress.map((i) => ({ what: `#${i.number}` }))
      : activeRuns(loaded.config.target.name);
  return [
    running.length > 0
      ? `🔧 running: ${running.map((r) => `\`${r.what}\``).join(", ")}`
      : "💤 nothing running",
    `**${ready.length}** agent-ready · **${readyToFix.length}** ready-to-fix · **${blocked.length}** need you`,
    agentPrs.length > 0
      ? `Open PRs: ${agentPrs.map((p) => `[#${p.number}](${p.url})`).join(", ")}`
      : "No open agent PRs.",
  ].join("\n");
}

function issueBody(
  decision: Decision,
  report: Report,
  source: {
    guildId: string;
    channelId: string;
    channelName: string;
    related?: Issue;
    /** Present when the report was filed despite not clearing the floor. */
    lowConfidence?: string;
  },
): string {
  const quoted = renderReport(report)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

  // Every message in the report gets a link, not just the anchor: a report
  // split across three messages is three places a reviewer may need to look.
  const links = report.messages
    .map((m, i) => `[${report.messages.length > 1 ? `part ${i + 1}` : "open in Discord"}](${messageUrl(source.guildId, source.channelId, m.id)})`)
    .join(" · ");

  return [
    // Kept first so it survives the truncated preview in issue lists and
    // notification emails — the source is the first thing worth checking.
    `> **Reported by \`${report.authorName}\` in ${source.channelName}** — ${links}`,
    "",
    decision.body,
    ...(source.lowConfidence
      ? [
          "",
          "> [!WARNING]",
          "> **Filed with low confidence — this report may not be actionable as written.**",
          `> ${source.lowConfidence}`,
          ">",
          "> Filed anyway so it is not lost. Ask the reporter for specifics, or close it.",
        ]
      : []),
    ...(source.related
      ? [
          "",
          `> **Possibly related to #${source.related.number}** — ${source.related.title}`,
          ">",
          "> Filed separately because the reported problem looks different. Close this as a duplicate if that call was wrong.",
        ]
      : []),
    "",
    "<details><summary>What was said</summary>",
    "",
    quoted,
    "",
    "</details>",
    "",
    "<sub>Filed automatically by [feedback-loop](https://github.com/yuanyang7/feedback-loop). The text above is a user report, not a verified diagnosis — confirm it before acting on it.</sub>",
    "",
    encodeFooter({
      guild: source.guildId,
      channel: source.channelId,
      messages: report.messages.map((m) => m.id),
      anchor: anchorOf(report).id,
      reportedBy: [report.authorId],
    }),
  ].join("\n");
}
