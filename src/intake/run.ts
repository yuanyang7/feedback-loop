import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info, warn, yellow } from "../core/log.js";
import { makeClassifier } from "../core/llm.js";
import { appendRunLog, readIntakeState, writeIntakeState } from "../core/state.js";
import { classifyReports, type Decision } from "./classify.js";
import { DiscordClient, messageUrl, type DiscordMessage } from "./discord.js";
import { setState } from "./emoji.js";
import { encodeFooter } from "./footer.js";
import { GitHubClient, type Issue } from "./github.js";
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
  await pollCommandChannels(loaded, discord, state, opts.dryRun);

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
  const remaining = await handleCommands(loaded, discord, messages, opts.dryRun);

  const reports = groupMessages(remaining, {
    windowSeconds: config.intake.groupWindowSeconds,
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

  for (const [index, report] of reports.entries()) {
    const decision = decisions[index]!;
    const anchor = anchorOf(report);
    const link = messageUrl(config.discord.guildId, config.discord.channelId, anchor.id);
    const label = `${dim(`#${index}`)} ${report.authorName}: ${decision.kind} ${dim(`(${decision.confidence.toFixed(2)})`)}`;

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
    await replyWithIssue(
      loaded, discord, anchor.id,
      lowConfidence
        ? `Filed as ${issueLink(config.target.repo, number)} — but I couldn't tell what's actually going wrong from this. Could you add specifics?`
        : `Filed as ${issueLink(config.target.repo, number)} · ${decision.title}`,
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
): Promise<DiscordMessage[]> {
  const { config, repoPath } = loaded;
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
      await reply(await statusLine(loaded));
      continue;
    }

    const busy = concurrencyRefusal(config.target.name, command.issue, config.worker.maxConcurrentRuns);
    if (busy) {
      await reply(describeRejection(command, busy));
      continue;
    }

    // Check the gate before promising ten minutes. The worker would refuse this
    // in a second anyway, and a promise followed by silence is worse than a
    // refusal — it leaves someone waiting on a run that already died.
    const refusal = await gateRefusal(loaded, command);
    if (refusal) {
      await reply(refusal);
      continue;
    }

    if (dryRun) {
      await reply(`[dry-run] would start \`${command.kind} #${command.issue}\``);
      continue;
    }

    const { pid, logPath } = startWorker(config.target.name, repoPath, command, channel);
    claimRun(config.target.name, pid, `${command.kind} #${command.issue}`, command.issue);
    info(`  ${bold(`started ${command.kind} #${command.issue}`)} ${dim(`pid ${pid}`)}`);
    await reply(
      `Starting \`${command.kind}\` on #${command.issue}. This takes ten minutes or more — I'll reply when it's done.\n` +
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
async function gateRefusal(
  loaded: LoadedConfig,
  command: { kind: "triage" | "fix"; issue: number },
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
  const needed = command.kind === "triage" ? config.github.labels.agentReady : config.github.labels.readyToFix;
  if (!has(needed)) {
    return command.kind === "triage"
      ? `#${command.issue} isn't labelled \`${needed}\` yet — that's the gate saying it's cleared for an autonomous attempt.\n\`gh issue edit ${command.issue} --add-label ${needed}\``
      : `#${command.issue} isn't labelled \`${needed}\` — only an issue triage actually reproduced gets a fix attempt. Try \`triage ${command.issue}\` first.`;
  }
  if (has("needs-info")) {
    return `#${command.issue} is labelled \`needs-info\` — it's too thin to act on. It needs specifics before an agent can do anything with it.`;
  }
  return null;
}

function issueLink(repo: string, number: number): string {
  return `[#${number}](https://github.com/${repo}/issues/${number})`;
}

async function replyWithIssue(
  loaded: LoadedConfig,
  discord: DiscordClient,
  messageId: string,
  text: string,
): Promise<void> {
  if (!loaded.config.discord.replyWithIssue) return;
  await discord
    .sendMessage(loaded.config.discord.channelId, text, messageId)
    .catch(() => undefined); // a failed reply must not cost us the filed issue
}

async function pollCommandChannels(
  loaded: LoadedConfig,
  discord: DiscordClient,
  state: ReturnType<typeof readIntakeState>,
  dryRun: boolean,
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
      await handleCommands(loaded, discord, messages, dryRun, channel, false);
    }
    cursors[channel] = messages.at(-1)!.id;
    changed = true;
  }

  if (changed && !dryRun) {
    writeIntakeState(loaded.config.target.name, { ...state, commandCursors: cursors });
  }
}

async function statusLine(loaded: LoadedConfig): Promise<string> {
  const github = new GitHubClient(
    loaded.config.target.repo,
    loaded.config.github.tokenFile ? readSecret(loaded.config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  const labels = loaded.config.github.labels;
  const [ready, readyToFix, blocked, prs] = await Promise.all([
    github.listIssues({ labels: [labels.agentReady], state: "open" }),
    github.listIssues({ labels: [labels.readyToFix], state: "open" }),
    github.listIssues({ labels: [labels.needsDecision], state: "open" }),
    github.listPullRequests({ state: "open" }),
  ]);
  const agentPrs = prs.filter((p) => (p.labels ?? []).some((l) => l.name === labels.agentPr));
  const running = activeRuns(loaded.config.target.name);
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
