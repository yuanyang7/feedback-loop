/**
 * Hand one issue from the loop to a person, and hand it back.
 *
 * Doing this by hand is three steps in three places and the order matters:
 * take `agent-ready` off, drain any queued request, then make a worktree that
 * does not collide with the one a run would make. Miss the first and the next
 * tick promotes the issue you are already editing; miss the second and the
 * queued ask survives the label removal, because the queue is read from
 * `fl:requested` alone. Both failures look the same from outside — two agents
 * in one worktree, one of them a person.
 *
 * `in-progress` is deliberately not the claim used here. A run applies that
 * label and `clearStaleClaims` removes it from any issue with no live process
 * behind it, so a hand-applied one survives at most one tick. `human-owned`
 * is a separate label for exactly that reason: nothing sweeps it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bold, cyan, dim, green, info, warn, yellow } from "../core/log.js";
import { readSecret, requireRepo, type LoadedConfig } from "../core/config.js";

import { GitHubClient, type Issue } from "../intake/github.js";
import { activeRuns, type RunLock } from "../intake/commands.js";
import { dropRequest } from "./queue.js";
import { ensureWorktree, type Worktree } from "./worktree.js";

/** The label that marks an issue as a person's, not the loop's. */
export const HUMAN_OWNED = "human-owned";

export interface HandoffOptions {
  issueNumber: number;
  /** Worktree directory name. Defaults to `manual-<n>-<words from title>`. */
  slug?: string;
  /** Branch prefix, per the target repo's conventional-commit rules. */
  prefix?: string;
  /** Claim the issue but leave the worktree to the caller. */
  noWorktree?: boolean;
  dryRun: boolean;
}

/**
 * A run's worktree is `issue-<n>-…`, and `watch --issue N` finds a run's work
 * by that prefix. Naming a person's worktree the same way would point `watch`
 * at a directory no run ever touched, so this namespace is kept separate.
 */
export function slugForHandoff(issueNumber: number, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return `manual-${issueNumber}${words ? `-${words}` : ""}`;
}

/**
 * The run that makes this issue unsafe to claim, if there is one.
 *
 * Pulling an issue out from under a running fix leaves that run writing to a
 * worktree whose branch has been re-pointed, and it will still open a PR at
 * the end of it. Kept separate from the rest so the refusal can be tested
 * without a GitHub round trip standing in front of it.
 */
export function blockingRun(target: string, issueNumber: number): RunLock | null {
  return (
    activeRuns(target).find(
      (lock) => (lock.issue ?? Number(/#(\d+)/.exec(lock.what)?.[1] ?? NaN)) === issueNumber,
    ) ?? null
  );
}

/** Everything the loop must stop doing to this issue, in a safe order. */
export async function releaseToHuman(
  github: GitHubClient,
  config: LoadedConfig["config"],
  issue: Issue,
  dryRun: boolean,
): Promise<void> {
  const labels = config.github.labels;
  const has = (name: string): boolean => issue.labels.some((l) => l.name === name);

  // Claim first. Between dropping `agent-ready` and applying this there is a
  // window an intake tick can land in, and it promotes on `agent-ready`
  // alone — so the window has to be one where the issue is still ineligible,
  // not one where it is briefly eligible and unclaimed.
  if (!has(HUMAN_OWNED)) {
    info(`  ${dim(`claiming #${issue.number} for a person`)}`);
    if (!dryRun) await github.addLabels(issue.number, [HUMAN_OWNED]);
  }
  if (has(labels.agentReady)) {
    info(`  ${dim(`removing ${labels.agentReady} — it is what auto-promotion reads`)}`);
    if (!dryRun) await github.removeLabels(issue.number, [labels.agentReady]);
  }
  // The queue is read from this label alone, so removing `agent-ready` does
  // not dequeue anything: an ask made before the handoff would still drain.
  if (has(labels.requested)) {
    info(`  ${dim("dequeuing the run that was already asked for")}`);
    if (!dryRun) await dropRequest(github, config, issue.number, "Dequeued — a person took this over.");
  }
  // Only ever stale here: a live run is refused before we get this far.
  if (has("in-progress")) {
    info(`  ${dim("clearing a stale in-progress claim")}`);
    if (!dryRun) await github.removeLabels(issue.number, ["in-progress"]);
  }
}

/** Take an issue off the loop and set up somewhere to work on it. */
export async function handOff(loaded: LoadedConfig, opts: HandoffOptions): Promise<Worktree | null> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const issue = await github.getIssue(opts.issueNumber).catch(() => null);
  if (!issue) {
    warn(`#${opts.issueNumber} not found.`);
    return null;
  }
  if (issue.state !== "OPEN") {
    warn(`#${opts.issueNumber} is closed — nothing to take over.`);
    return null;
  }

  const live = blockingRun(config.target.name, issue.number);
  if (live) {
    warn(
      `#${issue.number} has a live run on it (pid ${live.pid}, ${live.what}). ` +
        `Let it finish, or stop it with \`kill ${live.pid}\`, then run this again.`,
    );
    return null;
  }

  info(`${bold(`#${issue.number}`)} ${cyan(issue.title)}`);
  await releaseToHuman(github, config, issue, opts.dryRun);

  let worktree: Worktree | null = null;
  if (!opts.noWorktree) {
    const repoPath = requireRepo(loaded);
    const slug = opts.slug ?? slugForHandoff(issue.number, issue.title);
    const path = join(repoPath, ".worktrees", slug);
    if (existsSync(path)) {
      info(`  ${dim(`resuming existing worktree ${path}`)}`);
      worktree = { path, branch: `${opts.prefix ?? "fix"}/${slug}`, slug };
    } else if (opts.dryRun) {
      info(`  ${dim(`[dry-run] would create ${path}`)}`);
    } else {
      info(`  ${dim("creating a worktree off the base branch")}`);
      worktree = await ensureWorktree(repoPath, config.target.baseBranch, slug, opts.prefix ?? "fix");
    }
  }

  if (!opts.dryRun) {
    const where = worktree ? `\n\nWorking on branch \`${worktree.branch}\`.` : "";
    await github
      .commentOnIssue(
        issue.number,
        `### 🧑‍💻 Taken over by a person\n\nThe loop will not start runs on this while it is ` +
          `labelled \`${HUMAN_OWNED}\`.${where}\n\n<sub>Hand it back with ` +
          `\`feedback-loop handoff . --issue ${issue.number} --return\`.</sub>`,
      )
      .catch((error: Error) => warn(`could not comment on #${issue.number}: ${error.message}`));
  }

  info(`${green("yours")} — the loop will not touch #${issue.number} until you hand it back.`);
  if (worktree) {
    // node_modules is cloned by `ensureWorktree`; the database, storage and
    // port are not, and the repo's own rules say a worktree must never run
    // against the shared one.
    info(`  ${dim("cd")} ${worktree.path}`);
    info(`  ${dim("npm run lab -- setup --yes")}   ${dim("# its own database, storage and port")}`);
  }
  info(`  ${dim(`feedback-loop handoff . --issue ${issue.number} --return`)}   ${dim("# when you are done")}`);
  return worktree;
}

/** Give an issue back to the loop. Leaves the worktree alone. */
export async function handBack(loaded: LoadedConfig, issueNumber: number, dryRun: boolean): Promise<void> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const issue = await github.getIssue(issueNumber).catch(() => null);
  if (!issue) {
    warn(`#${issueNumber} not found.`);
    return;
  }
  if (!issue.labels.some((l) => l.name === HUMAN_OWNED)) {
    warn(`#${issueNumber} is not handed off — nothing to give back.`);
    return;
  }

  if (dryRun) {
    info(`  ${dim(`[dry-run] would hand #${issueNumber} back to the loop`)}`);
    return;
  }
  await github.removeLabels(issueNumber, [HUMAN_OWNED]);
  // Deliberately not re-applying `agent-ready`: what made it eligible before
  // was a judgement about a state of the issue that a person has since been
  // editing. Asking for it again is one command; a run started on a stale
  // clearance is a PR someone has to read.
  info(`${green("back")} — #${issueNumber} is the loop's again.`);
  info(`  ${dim(`it will not start unasked until you add ${config.github.labels.agentReady} back`)}`);
  if (issue.labels.some((l) => l.name === config.github.labels.agentReady)) return;
  info(
    `  ${dim(`gh issue edit ${issueNumber} --add-label ${config.github.labels.agentReady} --repo ${config.target.repo}`)}`,
  );
  const stray = yellow("worktree left in place");
  info(`  ${stray} ${dim("— remove it yourself once the PR is merged")}`);
}
