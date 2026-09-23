/**
 * ready → triage → fix → pull request, in one go.
 *
 * What this skips is the human read of the triage verdict. Everything that
 * actually protects the repository is still in the way: a fix only runs on an
 * issue triage reproduced, deny paths still stop it, review still blocks it,
 * and it still ends at a pull request nobody but you can merge.
 *
 * What it costs is the chance to look at the reproduction before paying for a
 * fix, so it is a verb you type at a specific issue — never something that
 * happens on a timer.
 */
import { readSecret, type LoadedConfig } from "../core/config.js";
import { HUMAN_OWNED } from "./handoff.js";
import { bold, cyan, dim, info, warn } from "../core/log.js";
import { GitHubClient } from "../intake/github.js";
import { announce, announcer, firstSentence } from "./announce.js";
import { runFix } from "./fix.js";
import { runTriage } from "./triage.js";
import { slugForIssue } from "./worktree.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function runChain(
  loaded: LoadedConfig,
  opts: { issueNumber: number; dryRun: boolean; announceChannel?: string; announceMessage?: string },
): Promise<void> {
  const { config } = loaded;
  const labels = config.github.labels;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const issue = await github.getIssue(opts.issueNumber).catch(() => null);
  if (!issue) {
    warn(`#${opts.issueNumber} not found.`);
    await announce(loaded, opts.announceChannel, `#${opts.issueNumber} doesn't exist.`, opts.announceMessage);
    return;
  }
  if (issue.state !== "OPEN") {
    warn(`#${opts.issueNumber} is closed.`);
    await announce(loaded, opts.announceChannel, `#${opts.issueNumber} is closed.`, opts.announceMessage);
    return;
  }

  const has = (name: string): boolean => issue.labels.some((l) => l.name === name);
  if (has(labels.needsInfo)) {
    const message = `#${issue.number} is labelled \`needs-info\` — too thin to act on. It needs specifics before any of this can start.`;
    warn(message);
    await announce(loaded, opts.announceChannel, message, opts.announceMessage);
    return;
  }

  // Before the clearance below, which would otherwise re-apply `agent-ready`
  // to an issue a person deliberately took it off — and put a run into the
  // worktree they are working in.
  if (has(HUMAN_OWNED)) {
    const message =
      `#${issue.number} was handed off to a person (\`${HUMAN_OWNED}\`). ` +
      `Hand it back first: \`feedback-loop handoff . --issue ${issue.number} --return\`.`;
    warn(message);
    await announce(loaded, opts.announceChannel, message, opts.announceMessage);
    return;
  }

  // Typing this at a specific issue is the decision the gate records, so the
  // label is applied rather than demanded — but it is still applied, because
  // the rest of the pipeline reads it.
  if (!has(labels.agentReady)) {
    info(`  ${dim(`clearing #${issue.number} for an attempt`)}`);
    if (!opts.dryRun) await github.addLabels(issue.number, [labels.agentReady]);
  }

  // Already reproduced, and the worktree holding that reproduction — and any
  // work an interrupted fix left — is still here. Triaging again would pay to
  // rediscover it, in a worktree that is no longer the clean one triage expects.
  const worktree = loaded.repoPath
    ? join(loaded.repoPath, ".worktrees", slugForIssue(issue.number, issue.title))
    : null;
  if (has(labels.readyToFix) && worktree && existsSync(worktree) && !opts.dryRun) {
    info(`${bold("1/2")} triage ${dim("— skipped: already reproduced, worktree kept")}`);
  } else {
    info(`${bold("1/2")} triage`);
    // Triage reports through the chain's own message rather than finishing it —
    // the run is not over, and a "done" here would release the lock mid-chain.
    const triaged = await runTriage(loaded, {
      issueNumber: issue.number, dryRun: opts.dryRun, announceChannel: undefined,
    });
    if (opts.dryRun) return;

    // Triage marks ready-to-fix only when it actually reproduced the problem and
    // found nothing blocking. Re-reading it is how this chain stays honest: the
    // fix phase is never reached by assumption, only by that label existing.
    const after = await github.getIssue(issue.number).catch(() => null);
    const reproduced = after?.labels.some((l) => l.name === labels.readyToFix) ?? false;
    if (!reproduced) {
      info(`  ${dim("triage did not clear it for a fix — stopping here")}`);
      // Say why here. "Needs you" without a reason means opening the issue to
      // find out whether it wants thirty seconds or an afternoon, every time.
      const sentence = firstSentence(triaged?.why);
      const why = sentence ? `\n> ${sentence}` : "";
      await announce(loaded, opts.announceChannel,
        `🤔 #${issue.number}: triage stopped short of a fix — **${triaged?.blockedReason ?? "did not complete"}**.${why}\n${issue.url}`,
      opts.announceMessage);
      return;
    }
  }

  info(`${bold("2/2")} fix`);
  // update, not announce: `announce` is `finish`, and finish releases the run
  // lock. Doing that here left the lock empty for the whole fix phase, so
  // maxConcurrentRuns stopped holding and — worse, once clearStaleClaims
  // existed — a live chain looked like a dead one, its `in-progress` was
  // stripped, and the issue became eligible for a second run against the same
  // worktree. The warning against exactly this is seventeen lines above.
  await announcer(loaded, opts.announceChannel, opts.announceMessage)
    .update(`✅ #${issue.number} reproduced — starting the fix. Another ten minutes or so.`)
    .catch(() => undefined);
  await runFix(loaded, {
    issueNumber: issue.number,
    dryRun: false,
    announceChannel: opts.announceChannel,
    announceMessage: opts.announceMessage,
  });
  info(`${cyan("chain done")}`);
}
