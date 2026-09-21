import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, dim, info } from "../core/log.js";
import { appendRunLog } from "../core/state.js";
import { otherOwners, readStatus, recordStatus } from "../core/tracker.js";
import { DiscordClient } from "./discord.js";
import { setState, type State } from "./emoji.js";
import { decodeFooter } from "./footer.js";
import { GitHubClient, type Issue } from "./github.js";

/**
 * Pull the truth back from GitHub. State changes happen there — you merge the
 * PR, you close the issue — so the chat reactions have to be caught up, not
 * written once at file time.
 */
export async function runReconcile(loaded: LoadedConfig, opts: { dryRun: boolean }): Promise<void> {
  const { config } = loaded;
  const target = config.target.name;

  const discord = new DiscordClient(readSecret(config.discord.tokenFile, "DISCORD_BOT_TOKEN"));
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const issues = [
    ...(await github.listIssues({ labels: [config.github.labels.source], state: "open", limit: 200 })),
    ...(await github.listIssues({ labels: [config.github.labels.source], state: "closed", limit: 100 })),
  ];

  let updated = 0;
  let skipped = 0;

  for (const issue of issues) {
    const link = decodeFooter(issue.body);
    if (!link || link.channel !== config.discord.channelId) continue;

    // A closed issue already announced as closed is done forever. Skipping it
    // before deriving anything is what keeps this from growing into dozens of
    // GitHub calls every tick as issues accumulate — and a rate limit here
    // fails silently, which is the worst way for it to fail.
    const tracked = readStatus(target, issue.number);
    const settled = tracked?.state === "merged" || tracked?.state === "dropped";
    if (settled && issue.state === "CLOSED") {
      skipped += 1;
      continue;
    }

    const state = await deriveState(github, issue);
    if (tracked?.state === state) {
      skipped += 1;
      continue;
    }

    const anchor = link.anchor ?? link.messages[0]!;
    info(`#${issue.number} ${dim(issue.title.slice(0, 60))} -> ${bold(state)}`);
    if (!opts.dryRun) {
      await setState(discord, link.channel, anchor, state);

      // Anything the bot said about this issue is now out of date. A reaction
      // is a symbol nobody misreads; a sentence saying "stopped, needs you"
      // outlives the thing it described, and only a record of having posted it
      // makes that fixable.
      const text = announcement(config.target.repo, issue, state);
      for (const message of tracked?.botMessages ?? []) {
        // Leave a message that speaks for other issues too — rewriting it from
        // this one's point of view deletes what it said about the others.
        const shared = otherOwners(target, issue.number, message);
        if (shared.length > 0) {
          info(`  ${dim(`left a message alone — it also covers #${shared.join(", #")}`)}`);
          continue;
        }
        await discord.editMessage(link.channel, message, text).catch(() => undefined);
      }
      recordStatus(target, issue.number, {
        state,
        channel: link.channel,
        anchor,
        title: issue.title,
      });
    }
    updated += 1;
  }

  if (!opts.dryRun) {
    appendRunLog({
      at: new Date().toISOString(),
      kind: "reconcile",
      target,
      summary: `${updated} changed, ${skipped} unchanged`,
      data: { updated, skipped },
    });
  }
  info(`${bold("done")} — ${updated} changed, ${skipped} unchanged.`);
}

/**
 * What a bot message about this issue should say now. One sentence, because it
 * replaces whatever was there — including a run's own report, which was true
 * when written and is not any more.
 */
function announcement(repo: string, issue: Issue, state: State): string {
  const link = `[#${issue.number}](https://github.com/${repo}/issues/${issue.number})`;
  const title = issue.title.replace(/^\[feedback\]\s*/, "");
  switch (state) {
    case "merged":
      return `✅ ${link} shipped — ${title}`;
    case "prReady":
      return `👀 ${link} has a pull request open and waiting on you — ${title}`;
    case "needsDecision":
      return `🤔 ${link} needs a decision from you — ${title}`;
    // Says the verb, because the whole point of this state is that the reader
    // should not have to open the issue to learn there is nothing to decide.
    case "runFailed":
      return `💥 ${link} — the run failed; nothing to decide. Reply \`go ${issue.number}\` to try again — ${title}`;
    case "working":
      return `🔧 ${link} is being worked on — ${title}`;
    case "unclear":
      return `❓ ${link} is filed but too thin to act on — ${title}`;
    case "dropped":
      return `❌ ${link} was closed without a fix — ${title}`;
    case "duplicate":
      return `🔁 Already tracked as ${link} — ${title}`;
    default:
      return `📝 Filed as ${link} — ${title}`;
  }
}

async function deriveState(github: GitHubClient, issue: Issue): Promise<State> {
  const labels = new Set(issue.labels.map((l) => l.name));

  if (issue.state === "CLOSED") {
    // Case matters here and nowhere else in this file: `gh --json` answers from
    // GraphQL, so this arrives as NOT_PLANNED, not not_planned. Comparing it in
    // lower case never matched, and the fallback is "merged" — so every issue
    // closed as not planned was announced as shipped. #1238 was closed as a
    // mis-filed duplicate and the channel was told it had shipped.
    return issue.stateReason?.toLowerCase() === "not_planned" ? "dropped" : "merged";
  }
  // Before needs-decision: a run that fell over may still carry a stale
  // decision label from an earlier pass, and "it crashed" is the more useful
  // of the two to show.
  if (labels.has("run-failed")) return "runFailed";
  if (labels.has("needs-decision")) return "needsDecision";
  // Filed, but the reporter is still the only one who can make it actionable —
  // so the question mark has to survive a reconcile pass.
  if (labels.has("needs-info")) return "unclear";

  const pr = await github.linkedPullRequest(issue.number);
  if (pr?.state === "MERGED") return "merged";
  if (pr?.state === "OPEN") return "prReady";
  if (labels.has("in-progress")) return "working";
  return "logged";
}
