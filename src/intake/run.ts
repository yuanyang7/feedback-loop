import Anthropic from "@anthropic-ai/sdk";
import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info, warn } from "../core/log.js";
import { appendRunLog, readIntakeState, writeIntakeState } from "../core/state.js";
import { classifyReports, type Decision } from "./classify.js";
import { DiscordClient, messageUrl } from "./discord.js";
import { setState } from "./emoji.js";
import { encodeFooter } from "./footer.js";
import { GitHubClient } from "./github.js";
import { groupMessages, renderReport, type Report } from "./group.js";

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

  // First run: adopt the newest message as the cursor rather than filing the
  // entire channel history as issues. --backfill opts into some history.
  if (cursor === null && opts.backfill === 0) {
    const recent = await discord.fetchMessages(config.discord.channelId, null, 1);
    const newest = recent.at(-1);
    if (newest) {
      writeIntakeState(target, { cursor: newest.id, lastTickAt: new Date().toISOString() });
      info(`No cursor yet — starting from message ${dim(newest.id)}. Use --backfill N to include history.`);
      return;
    }
  }

  const limit = cursor === null ? Math.min(opts.backfill, 100) : config.intake.lookbackLimit;
  const messages = await discord.fetchMessages(config.discord.channelId, cursor, limit);
  if (messages.length === 0) {
    info("No new messages.");
    writeIntakeState(target, { cursor, lastTickAt: new Date().toISOString() });
    return;
  }

  const reports = groupMessages(messages, {
    windowSeconds: config.intake.groupWindowSeconds,
    ignoreAuthorIds: config.discord.ignoreAuthorIds,
    mentionTriggerIds: config.discord.mentionTriggerIds,
  });
  info(`${messages.length} new message(s) -> ${reports.length} candidate report(s).`);
  if (reports.length === 0) {
    writeIntakeState(target, { cursor: messages.at(-1)!.id, lastTickAt: new Date().toISOString() });
    return;
  }

  const openIssues = await github.listIssues({ state: "open", limit: 200 });
  const decisions = await classifyReports(reports, openIssues, {
    model: config.intake.model,
    client: new Anthropic(),
  });

  let filed = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const [index, report] of reports.entries()) {
    const decision = decisions[index]!;
    const anchor = report.messages[0]!;
    const link = messageUrl(config.discord.guildId, config.discord.channelId, anchor.id);
    const label = `${dim(`#${index}`)} ${report.authorName}: ${decision.kind} ${dim(`(${decision.confidence.toFixed(2)})`)}`;

    if (decision.kind === "noise" || decision.kind === "question") {
      skipped += 1;
      info(`${label} ${dim("skipped —")} ${dim(decision.reasoning)}`);
      continue;
    }

    // An explicit @-mention is a human asking directly; it does not need to clear
    // the confidence floor the way passively-observed chat does.
    if (!report.directed && decision.confidence < config.intake.minConfidence) {
      skipped += 1;
      info(`${label} ${dim("below confidence floor —")} ${dim(decision.reasoning)}`);
      if (!opts.dryRun) {
        await setState(discord, config.discord.channelId, anchor.id, "unclear");
      }
      continue;
    }

    if (decision.duplicateOf !== null) {
      const existing = openIssues.find((i) => i.number === decision.duplicateOf);
      if (existing) {
        duplicates += 1;
        info(`${label} ${cyan(`duplicate of #${existing.number}`)} ${existing.title}`);
        if (!opts.dryRun) {
          await github.commentOnIssue(
            existing.number,
            `Also reported by **${report.authorName}** in Discord: ${link}\n\n> ${renderReport(report).replace(/\n/g, "\n> ")}`,
          );
          await setState(discord, config.discord.channelId, anchor.id, "duplicate");
        }
        continue;
      }
    }

    const body = issueBody(decision, report, link, config.discord.guildId, config.discord.channelId);
    const labels = [
      config.github.labels.source,
      `severity:${decision.severity}`,
      `size:${decision.sizeHint}`,
      decision.kind === "feature" ? "enhancement" : "bug",
    ];

    if (opts.dryRun) {
      filed += 1;
      console.log(`\n${bold(`[dry-run] would file: ${decision.title}`)}\n${dim(labels.join("  "))}\n${body}\n`);
      continue;
    }

    const number = await github.createIssue({ title: decision.title, body, labels });
    filed += 1;
    info(`${label} ${bold(`filed #${number}`)} ${decision.title}`);
    await setState(discord, config.discord.channelId, anchor.id, "logged");
  }

  const newest = messages.at(-1)!.id;
  if (!opts.dryRun) {
    writeIntakeState(target, { cursor: newest, lastTickAt: new Date().toISOString() });
    appendRunLog({
      at: new Date().toISOString(),
      kind: "intake",
      target,
      summary: `${filed} filed, ${duplicates} duplicate, ${skipped} skipped from ${messages.length} message(s)`,
      data: { filed, duplicates, skipped, messages: messages.length, cursor: newest },
    });
  }
  info(`${bold("done")} — ${filed} filed, ${duplicates} duplicate, ${skipped} skipped.`);
}

function issueBody(
  decision: Decision,
  report: Report,
  link: string,
  guildId: string,
  channelId: string,
): string {
  const quoted = renderReport(report)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

  return [
    decision.body,
    "",
    "---",
    "",
    `**Reported by** ${report.authorName} in Discord — [original message](${link})`,
    "",
    "<details><summary>What was said</summary>",
    "",
    quoted,
    "",
    "</details>",
    "",
    `<sub>Filed automatically by feedback-loop. The text above is a user report, not a verified diagnosis — confirm it before acting on it.</sub>`,
    "",
    encodeFooter({
      guild: guildId,
      channel: channelId,
      messages: report.messages.map((m) => m.id),
      reportedBy: [report.authorId],
    }),
  ].join("\n");
}
