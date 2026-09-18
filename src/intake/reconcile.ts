import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, dim, info } from "../core/log.js";
import { appendRunLog, readIntakeState, writeIntakeState } from "../core/state.js";
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

  const seen = { ...(readIntakeState(target).reconciled ?? {}) };
  let updated = 0;
  let skipped = 0;

  for (const issue of issues) {
    const link = decodeFooter(issue.body);
    if (!link || link.channel !== config.discord.channelId) continue;

    // A closed issue we have already finalised is done forever. Skipping it
    // before deriving anything is what keeps this from growing into dozens of
    // GitHub calls every tick as issues accumulate — and a rate limit here
    // fails silently, which is the worst way for it to fail.
    const previous = seen[String(issue.number)];
    if (previous?.final && issue.state === "CLOSED") {
      skipped += 1;
      continue;
    }

    const state = await deriveState(github, issue);
    const final = issue.state === "CLOSED";

    if (previous?.state === state) {
      // Still worth recording that it is now final, but nothing to write out.
      if (final) seen[String(issue.number)] = { state, final };
      skipped += 1;
      continue;
    }

    const anchor = link.anchor ?? link.messages[0]!;
    info(`#${issue.number} ${dim(issue.title.slice(0, 60))} -> ${bold(state)}`);
    if (!opts.dryRun) {
      await setState(discord, link.channel, anchor, state);
      seen[String(issue.number)] = { state, final };
    }
    updated += 1;
  }

  if (!opts.dryRun) writeIntakeState(target, { reconciled: seen });

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

async function deriveState(github: GitHubClient, issue: Issue): Promise<State> {
  const labels = new Set(issue.labels.map((l) => l.name));

  if (issue.state === "CLOSED") {
    // "not planned" is a decision not to fix; anything else closed we treat as shipped.
    return issue.stateReason === "not_planned" ? "dropped" : "merged";
  }
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
