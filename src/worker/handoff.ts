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
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { bold, cyan, dim, green, info, warn, yellow } from "../core/log.js";
import { readSecret, requireRepo, type LoadedConfig } from "../core/config.js";
import { runsDir, stateDir } from "../core/state.js";

import { GitHubClient, type Issue } from "../intake/github.js";
import { activeRuns, type RunLock } from "../intake/commands.js";
import { dropRequest } from "./queue.js";
import { ensureWorktree, type Worktree } from "./worktree.js";

/** The label that marks an issue as a person's, not the loop's. */
export const HUMAN_OWNED = "human-owned";

const exec = promisify(execFile);

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

  if (worktree && !opts.dryRun) {
    const briefing = await writeBriefing(config.target.name, worktree, issue, requireRepo(loaded));
    if (briefing) info(`  ${dim(`wrote ${briefing}`)}`);
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
export async function handBack(loaded: LoadedConfig, issueNumber: number, dryRun: boolean): Promise<boolean> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const issue = await github.getIssue(issueNumber).catch(() => null);
  if (!issue) {
    warn(`#${issueNumber} not found.`);
    return false;
  }
  if (!issue.labels.some((l) => l.name === HUMAN_OWNED)) {
    warn(`#${issueNumber} is not handed off — nothing to give back.`);
    return false;
  }

  if (dryRun) {
    info(`  ${dim(`[dry-run] would hand #${issueNumber} back to the loop`)}`);
    return true;
  }
  await github.removeLabels(issueNumber, [HUMAN_OWNED]);
  // Deliberately not re-applying `agent-ready`: what made it eligible before
  // was a judgement about a state of the issue that a person has since been
  // editing. Asking for it again is one command; a run started on a stale
  // clearance is a PR someone has to read.
  info(`${green("back")} — #${issueNumber} is the loop's again.`);
  info(`  ${dim(`it will not start unasked until you add ${config.github.labels.agentReady} back`)}`);
  if (issue.labels.some((l) => l.name === config.github.labels.agentReady)) return true;
  info(
    `  ${dim(`gh issue edit ${issueNumber} --add-label ${config.github.labels.agentReady} --repo ${config.target.repo}`)}`,
  );
  const stray = yellow("worktree left in place");
  info(`  ${stray} ${dim("— remove it yourself once the PR is merged")}`);
  return true;
}

/**
 * What the loop already found out, written where the next session will look.
 *
 * A fresh agent window in a worktree starts with no idea that any of this
 * happened: the triage verdict, the screenshots, the log of the attempt that
 * fell over. All of it lives under the state directory, keyed by a run
 * timestamp nobody is going to guess. Dropping a file at the root of the
 * worktree is the one place both a person and an agent reliably read.
 *
 * Excluded locally rather than added to `.gitignore`: the target repo's
 * ignore file is checked in, and a handoff should not need a commit to it.
 */
export async function writeBriefing(
  target: string,
  worktree: Worktree,
  issue: Issue,
  repoPath: string,
): Promise<string | null> {
  const dir = runsDir(target);
  const runs = existsSync(dir)
    ? readdirSync(dir)
        .filter((d) => d.includes(`issue-${issue.number}-`))
        .sort()
        .reverse()
    : [];

  const lines = [
    `# Handed off: #${issue.number}`,
    "",
    `${issue.title}`,
    "",
    issue.url,
    "",
    "This issue was taken off the feedback-loop and given to you. The loop will not start runs on",
    "it while it is labelled `human-owned`; hand it back with",
    `\`feedback-loop handoff . --issue ${issue.number} --return\`.`,
    "",
    "## Before you run anything",
    "",
    "This worktree's `.env` is symlinked from the main checkout and points at the **production**",
    "database. Set up its own database, storage and port first:",
    "",
    "```bash",
    "npm run lab -- setup --yes",
    "```",
    "",
    "## The report",
    "",
    issue.body.trim() || "_(no body)_",
    "",
  ];

  if (runs.length === 0) {
    lines.push("## What the loop found", "", "Nothing — no run has touched this issue.", "");
  } else {
    lines.push("## What the loop already found", "");
    for (const run of runs.slice(0, 3)) {
      const path = join(dir, run);
      lines.push(`### ${run}`, "");
      // The verdict is the one file worth inlining: it is the reasoning a
      // second session would otherwise redo from scratch, and it is short.
      for (const phase of ["triage", "fix"]) {
        const verdict = join(path, `${phase}.verdict.json`);
        if (!existsSync(verdict)) continue;
        try {
          const parsed = JSON.parse(readFileSync(verdict, "utf8")) as Record<string, unknown>;
          lines.push(
            `**${phase}** — reproduced: ${String(parsed.reproduced ?? "unknown")}` +
              (parsed.evidenceKind ? ` (${String(parsed.evidenceKind)})` : "") +
              (parsed.blockedReason && parsed.blockedReason !== "none"
                ? `, blocked: ${String(parsed.blockedReason)}`
                : ""),
            "",
          );
          // `attempted` matters most when `evidence` is empty: that is the run
          // that got stuck, and what it already ruled out is the reason not to
          // spend the first hour rediscovering it.
          for (const [heading, key] of [
            ["What it found", "evidence"],
            ["What it tried", "attempted"],
            ["Where it would go next", "reasoning"],
          ] as const) {
            const text = String(parsed[key] ?? "").trim();
            if (text) lines.push(`_${heading}:_`, "", `> ${text.replace(/\n/g, "\n> ")}`, "");
          }
        } catch {
          lines.push(`**${phase}** — verdict file unreadable: ${verdict}`, "");
        }
      }
      const evidence = join(path, "evidence");
      if (existsSync(evidence)) {
        const files = readdirSync(evidence);
        lines.push(
          `Evidence (${files.length} file(s), incl. before/after screenshots): \`${evidence}\``,
          "",
        );
      }
      lines.push(`Full transcripts: \`${path}\``, "");
    }
    lines.push(
      "The run log for this issue, including why an attempt stopped:",
      "",
      `\`${join(stateDir(target), `worker-go-${issue.number}.log`)}\``,
      "",
    );
  }

  const path = join(worktree.path, "HANDOFF.md");
  writeFileSync(path, lines.join("\n"));
  // Keep it out of the diff without touching the repo's checked-in ignore file.
  await exclude(repoPath, worktree, "HANDOFF.md");
  return path;
}

/** Add a path to this worktree's local excludes. Never fails the handoff. */
async function exclude(repoPath: string, worktree: Worktree, entry: string): Promise<void> {
  try {
    const { stdout } = await exec("git", ["-C", worktree.path, "rev-parse", "--git-path", "info/exclude"]);
    const file = stdout.trim();
    const path = file.startsWith("/") ? file : join(worktree.path, file);
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (!current.split("\n").includes(entry)) {
      writeFileSync(path, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${entry}\n`);
    }
  } catch {
    warn(`could not exclude ${entry} from ${worktree.slug} — it will show up as an untracked file`);
  }
  void repoPath;
}

/**
 * `mine <issue>` / `back <issue>` from chat.
 *
 * Returns the line to reply with rather than logging, and never throws: a
 * command that dies takes the whole intake tick's command loop with it.
 *
 * An intake host claims the issue and stops there. It has no checkout to make
 * a worktree in, and inventing one on the wrong machine is worse than saying
 * where the work has to happen.
 */
export async function handOffFromChat(
  loaded: LoadedConfig,
  issueNumber: number,
  dryRun: boolean,
  role: "all" | "intake" | "worker",
): Promise<string> {
  try {
    if (dryRun) return `[dry-run] would take #${issueNumber} off the loop`;
    const worktree = await handOff(loaded, { issueNumber, noWorktree: role === "intake", dryRun: false });
    if (!worktree) {
      return role === "intake"
        ? `#${issueNumber} is yours — I won't touch it. No worktree: this host has no checkout, so make one where you work.`
        : `Couldn't take #${issueNumber} off the loop — see the log; a live run or a closed issue is the usual reason.`;
    }
    return (
      `🧑‍💻 #${issueNumber} is yours — I've stopped touching it.\n` +
      `Worktree \`${worktree.slug}\` on branch \`${worktree.branch}\`, with \`HANDOFF.md\` in it: ` +
      `the report, what triage already found, and where the screenshots and transcripts are.\n` +
      `Run \`npm run lab -- setup --yes\` in it before anything else. Say \`back ${issueNumber}\` when you're done.`
    );
  } catch (error) {
    return `Couldn't take #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function handBackFromChat(loaded: LoadedConfig, issueNumber: number, dryRun: boolean): Promise<string> {
  try {
    if (dryRun) return `[dry-run] would hand #${issueNumber} back`;
    const given = await handBack(loaded, issueNumber, false);
    if (!given) return `#${issueNumber} wasn't handed off — nothing to give back.`;
    return (
      `Got it — #${issueNumber} is mine again, but I won't start on it unasked: ` +
      `say \`ready ${issueNumber}\` if it should go back in the queue. Your worktree is untouched.`
    );
  } catch (error) {
    return `Couldn't hand #${issueNumber} back: ${error instanceof Error ? error.message : String(error)}`;
  }
}
