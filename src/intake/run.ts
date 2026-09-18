import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info, yellow } from "../core/log.js";
import { makeClassifier } from "../core/llm.js";
import { appendRunLog, readIntakeState, writeIntakeState } from "../core/state.js";
import { classifyReports, type Decision } from "./classify.js";
import { DiscordClient, messageUrl } from "./discord.js";
import { setState } from "./emoji.js";
import { encodeFooter } from "./footer.js";
import { GitHubClient, type Issue } from "./github.js";
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

  const reports = groupMessages(messages, {
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

export function issueBody(
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
      reportedBy: [report.authorId],
    }),
  ].join("\n");
}
