/**
 * Phases 3-5: implement, review adversarially, open a pull request — and stop.
 *
 * Nothing here merges. The run ends with a PR a human has to read, which is
 * the whole point: the expensive, scarce resource this design protects is
 * review attention, not compute.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, green, info, red, warn, yellow } from "../core/log.js";
import { appendRunLog, runsDir } from "../core/state.js";
import { DiscordClient } from "../intake/discord.js";
import { setState } from "../intake/emoji.js";
import { decodeFooter } from "../intake/footer.js";
import { GitHubClient, type Issue } from "../intake/github.js";
import { checkGate } from "./gate.js";
import { runPhase } from "./agent.js";
import { ensureWorktree, slugForIssue, type Worktree } from "./worktree.js";
import { evidenceDir, evidenceInstruction, listEvidence, sweepWorktree } from "./evidence.js";
import { announce } from "./announce.js";
import { findingsFrom, parseCiFailure, renderCiFailure } from "./ci.js";
import { shareEvidence } from "./share.js";

const exec = promisify(execFile);

const FixSchema = z.object({
  implemented: z.boolean().describe("True only if you changed code and committed it."),
  summary: z.string().describe("What you changed and why, for a reviewer who has not seen the issue."),
  filesChanged: z.array(z.string()),
  verification: z
    .string()
    .describe(
      "How you confirmed the reported problem is gone — the same interaction that reproduced it, now working. " +
        "Green tests alone are evidence that nothing else broke, not that this is fixed.",
    ),
  risks: z.string().describe("What a reviewer should scrutinise, and anything you deliberately did not do."),
  recommendation: z
    .string()
    .describe(
      "When blockedReason is not 'none': what you would do about it, chosen rather than listed. " +
        "You have read this code; the person reading your report has not. Empty otherwise.",
    ),
  blockedReason: z
    .enum(["none", "deny-path", "too-large", "cannot-verify", "needs-product-decision"])
    .describe("Why this should stop here instead of becoming a PR, or 'none'."),
});

const ReviewSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  blocking: z.array(z.string()).describe("Issues that must be fixed before this can be reviewed by a human."),
  repeatsPreviousFinding: z
    .boolean()
    .describe(
      "True when a blocking finding below is one an earlier round already raised and this attempt " +
        "did not resolve. That is the signal that another attempt will not help; a new problem " +
        "uncovered by fixing the last one is not a repeat.",
    ),
  nonBlocking: z.array(z.string()).describe("Worth mentioning in the PR, not worth another attempt."),
  recommendation: z
    .string()
    .describe(
      "If a blocking finding admits more than one way out, name the one you would take and say why " +
        "in a sentence or two. Do not hedge: listing options without a preference hands the work " +
        "back to a human who has read less of this code than you just did. Empty when there is " +
        "nothing to choose between.",
    ),
  reasoning: z.string(),
});

type Fix = z.infer<typeof FixSchema>;
type Review = z.infer<typeof ReviewSchema>;

const FIX_PROMPT = (
  issue: Issue,
  triage: string,
  denyPaths: string[],
  previousFindings: string[],
  evidencePath: string,
  previous: Fix | null,
) => {
  const retry =
    previousFindings.length === 0
      ? ""
      : [
          "A previous attempt was rejected. Address these before anything else:",
          ...previousFindings.map((f) => `  - ${f}`),
          "",
          ...(previous
            ? [
                "That attempt is already committed on this branch — you are continuing it, not",
                "starting over. Do not re-derive what it established:",
                "",
                `  What it changed:   ${previous.summary}`,
                `  Files it touched:  ${previous.filesChanged.join(", ") || "(none reported)"}`,
                `  How it verified:   ${previous.verification}`,
                `  What it flagged:   ${previous.risks}`,
                "",
                "`git diff HEAD~1...HEAD` shows its diff if you need it. Change what the findings",
                "require and leave the rest alone.",
                "",
              ]
            : []),
        ].join("\n");

  return `Fix the bug below. It has already been reproduced — the triage notes say how.

${retry}Work in this worktree, on its existing branch. When the fix is done:

1. Confirm the reported problem is actually gone — drive the same interaction that reproduced it.
   Green tests prove nothing else broke; they do not prove this is fixed.
2. Run typecheck, lint, test and build. All must pass.
3. Commit, following the repo's commit message rules. Do not push, and do not open a pull request —
   that happens outside this session.

Stop and set blockedReason instead of continuing if a fix would touch any of:
${denyPaths.map((p) => `  - ${p}`).join("\n")}

${evidenceInstruction(evidencePath)}

Capture the same interaction twice where you can — before your change and after — so a reviewer can
see the difference rather than take your word for it.

Prefer the smallest change that actually fixes the reported problem. A refactor you believe in is
not in scope, and it makes the diff harder to review.

If a test fails, fix the code it is testing. Do not weaken the test to make it pass — not by
relaxing an assertion, not by widening a tolerance, not by skipping it. If you become convinced the
test itself is wrong, say so in \`risks\` and stop; that is a human's call, not a step on the way to
a green build.

<issue number="${issue.number}">
<title>${issue.title}</title>
<body>
${issue.body}
</body>
</issue>

<triage-notes>
${triage}
</triage-notes>`;
};

const REVIEW_PROMPT = (issue: Issue, fix: Fix, baseBranch: string, previousFindings: string[]) => `Review the committed changes on this branch as a hostile reviewer. You are the last check before a human spends their attention on this.

Read the diff with \`git diff origin/${baseBranch}...HEAD\` and judge it on:

- **Correctness.** Does it actually fix the reported problem, or does it fix a symptom?
- **Scope.** Is anything in the diff unrelated to the issue?
- **Security.** Does it introduce a way for untrusted input to reach somewhere it should not?
- **Evidence.** The claim below says how it was verified. Is that claim actually supported?
- **Simplicity.** Is this the smallest change that works?

Do not be agreeable. A finding you are unsure about belongs in nonBlocking, not omitted. Reject if
anything in blocking would waste a reviewer's time or ship a defect.

${
  previousFindings.length > 0
    ? `An earlier round of this review raised the following, and the attempt you are looking at was
supposed to resolve them:
${previousFindings.map((f) => `  - ${f}`).join("\n")}

Set repeatsPreviousFinding when something above is still true. Do not set it for a new problem you
found while checking, even one the previous change caused — those are different, and treating them
the same stops a run that is converging.

`
    : ""
}When a blocking finding has more than one acceptable resolution, pick one. You have just read this
code closely; the person who reads your report has not, and handing them a list of options is
handing back the part of the work you were best placed to do. Say which and why.

Do not change any files. You are reviewing, not fixing.

<issue number="${issue.number}">
<title>${issue.title}</title>
</issue>

<claimed-fix>
${fix.summary}

Verification claimed: ${fix.verification}
Risks flagged by the author: ${fix.risks}
</claimed-fix>`;

export async function runFix(
  loaded: LoadedConfig,
  opts: { issueNumber?: number; dryRun: boolean; announceChannel?: string; announceMessage?: string },
): Promise<void> {
  // in-progress is claimed early and has to come off however the run ends.
  // Without this, a crash leaves an issue asserting that work is underway
  // when nothing is, and the next run skips it.
  let claimed: Issue | null = null;
  try {
    claimed = await runFixInner(loaded, opts, (issue) => {
      claimed = issue;
    });
  } catch (error) {
    if (claimed) {
      const github = githubFor(loaded);
      await github
        .commentOnIssue(
          claimed.number,
          `### ⚠️ The fix run crashed\n\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\`\n\nNo changes were pushed. The issue is back in the queue.`,
        )
        .catch(() => undefined);
      await github.removeLabels(claimed.number, ["in-progress"]).catch(() => undefined);
    }
    throw error;
  }
}

function githubFor(loaded: LoadedConfig): GitHubClient {
  return new GitHubClient(
    loaded.config.target.repo,
    loaded.config.github.tokenFile
      ? readSecret(loaded.config.github.tokenFile, "GITHUB_TOKEN")
      : undefined,
  );
}

async function runFixInner(
  loaded: LoadedConfig,
  opts: { issueNumber?: number; dryRun: boolean; announceChannel?: string; announceMessage?: string },
  onClaim: (issue: Issue) => void,
): Promise<Issue | null> {
  const { config, repoPath, playbookPath } = loaded;
  const target = config.target.name;
  const labels = config.github.labels;

  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const gate = await checkGate(config, github);
  if (!gate.ok) {
    warn(`gate closed — ${gate.reason}`);
    await announce(loaded, opts.announceChannel, `Can't start — ${gate.reason}`, opts.announceMessage);
    return null;
  }

  const issue = await pickIssue(github, labels.readyToFix, opts.issueNumber);
  if (!issue) {
    if (opts.issueNumber === undefined) {
      info(`Nothing labelled ${cyan(labels.readyToFix)} to fix. Run triage first.`);
    }
    await announce(loaded, opts.announceChannel,
      opts.issueNumber === undefined
        ? `Nothing labelled \`${labels.readyToFix}\` to fix — run \`triage\` on something first.`
        : `Can't fix #${opts.issueNumber} — it isn't labelled \`${labels.readyToFix}\`. Triage has to reproduce it first.`,
    opts.announceMessage);
    return null;
  }
  info(`${bold(`#${issue.number}`)} ${issue.title}`);

  if (!playbookPath) {
    warn("No .feedback-loop/playbook.md — refusing to run an agent in this repo without one.");
    await announce(loaded, opts.announceChannel, "Can't start — this repo has no `.feedback-loop/playbook.md`.", opts.announceMessage);
    return null;
  }
  const { readFileSync } = await import("node:fs");
  const playbook = readFileSync(playbookPath, "utf8");

  // Triage wrote its findings on the issue. Reuse them rather than rediscovering.
  const triageNotes = await lastTriageComment(config.target.repo, issue.number);

  if (opts.dryRun) {
    console.log(`\n${dim("[dry-run] would run the fix phase with this prompt:")}\n`);
    console.log(FIX_PROMPT(issue, triageNotes, config.worker.denyPaths, [], "<run artifact dir>/evidence", null));
    return null;
  }

  const slug = slugForIssue(issue.number, issue.title);
  const artifactDir = join(runsDir(target), `${stamp()}-fix-${slug}`);
  mkdirSync(artifactDir, { recursive: true });

  const evidence = evidenceDir(artifactDir);
  const worktree = await ensureWorktree(repoPath, config.target.baseBranch, slug, "fix");
  if (!existsSync(join(worktree.path, "node_modules"))) {
    warn("  worktree has no node_modules — triage's setup is gone; the fix session will have to redo it");
  }
  await github.addLabels(issue.number, ["in-progress"]);
  onClaim(issue);
  await react(loaded, issue, "working");

  const phaseOpts = {
    cwd: worktree.path,
    artifactDir,
    playbook,
    timeoutMinutes: config.worker.phaseTimeoutMinutes,
  };

  let fix: Fix | null = null;
  // Carried into the next attempt so it continues the work rather than
  // rediscovering it: a retry that re-reads the whole codebase costs as much as
  // the first pass and arrives back where the first pass already was.
  let previousFix: Fix | null = null;
  let review: Review | null = null;
  let findings: string[] = [];
  // Counted apart from review rounds: a rejected push is about correctness or
  // the machine, not about judgement, and spending a review round on it was
  // what cut #1213 off while it was still converging.
  let ciRejections = 0;
  let repeats = 0;
  let spent = 0;

  // `attempt` counts every pass through this loop, including ones a rejected
  // push sent back round; maxFixAttempts is the backstop on that total. What
  // actually decides whether to give up is `repeats` — the same blocking
  // finding surviving an attempt — because that is the shape of being stuck,
  // and a round that clears one problem and uncovers another is not.
  for (let attempt = 1; attempt <= config.worker.maxFixAttempts; attempt += 1) {
    info(`  ${bold(`attempt ${attempt}/${config.worker.maxFixAttempts}`)}`);

    const fixRun = await runPhase(
      `fix-${attempt}`,
      FIX_PROMPT(issue, triageNotes, config.worker.denyPaths, findings, evidence, previousFix),
      FixSchema,
      {
        ...phaseOpts,
        model: config.worker.fixModel,
        effort: config.worker.fixEffort,
        maxBudgetUsd: config.worker.fixMaxUsd,
        allowedTools: ["Bash", "Read", "Grep", "Glob", "Write", "Edit"],
        disallowedTools: [],
      },
    );
    spent += fixRun.costUsd;
    fix = fixRun.verdict as Fix | null;
    await sweepWorktree(worktree.path, evidence);

    if (!fix) {
      const sha = await lastCommit(worktree, config.target.baseBranch);
      if (sha) {
        // The verdict is written last, so budget exhaustion can lose the report
        // while the change itself is committed and fine. Reporting that as a
        // plain failure would throw away real work.
        warn(`  no verdict, but ${sha.slice(0, 8)} is committed — keeping the worktree so a re-run can continue`);
        await github.commentOnIssue(
          issue.number,
          [
            "### ⚠️ The fix phase stopped before reporting",
            "",
            "```",
            fixRun.failure ?? "unknown",
            "```",
            "",
            `It had already committed \`${sha.slice(0, 8)}\` in \`.worktrees/${worktree.slug}\`, so the work is not lost.`,
            "Re-run `feedback-loop fix` to continue from there, or review that commit directly.",
          ].join("\n"),
        );
        await github.removeLabels(issue.number, ["in-progress"]);
        log(target, issue, `stopped with work committed (${sha.slice(0, 8)})`, spent, artifactDir);
        return null;
      }
      warn(`  fix phase failed: ${fixRun.failure}`);
      await escalate(github, loaded, issue, `The fix phase did not complete.\n\n\`\`\`\n${fixRun.failure}\n\`\`\``, opts.announceChannel, opts.announceMessage);
      log(target, issue, "fix phase failed", spent, artifactDir);
      return null;
    }
    if (fix.blockedReason !== "none") {
      warn(`  blocked: ${fix.blockedReason}`);
      const branch = (await hasCommits(worktree, config.target.baseBranch))
        ? await pushForInspection(config, worktree)
        : "";
      await escalate(github, loaded, issue, blockedComment(fix) + branch, opts.announceChannel, opts.announceMessage);
      log(target, issue, `blocked: ${fix.blockedReason}`, spent, artifactDir);
      return null;
    }
    if (!fix.implemented || !(await hasCommits(worktree, config.target.baseBranch))) {
      warn("  reported success but committed nothing");
      await escalate(github, loaded, issue, "The fix phase reported success but committed nothing.", opts.announceChannel, opts.announceMessage);
      log(target, issue, "no commits", spent, artifactDir);
      return null;
    }

    const reviewRun = await runPhase(
      `review-${attempt}`,
      REVIEW_PROMPT(issue, fix, config.target.baseBranch, findings),
      ReviewSchema,
      {
        ...phaseOpts,
        model: config.worker.reviewModel,
        effort: config.worker.reviewEffort,
        maxBudgetUsd: config.worker.reviewMaxUsd,
        allowedTools: ["Bash", "Read", "Grep", "Glob"],
        disallowedTools: ["Edit", "Write", "NotebookEdit"],
      },
    );
    spent += reviewRun.costUsd;
    review = reviewRun.verdict;

    if (review?.verdict !== "approve") {
      findings = review?.blocking ?? ["Review did not complete; treat that as a rejection."];
      previousFix = fix;
      if (review?.repeatsPreviousFinding) repeats += 1;
      warn(
        `  review rejected: ${findings.length} blocking finding(s)` +
          (review?.repeatsPreviousFinding ? ` ${yellow(`(repeat ${repeats}/${config.worker.maxRepeatedFindings})`)}` : ""),
      );

      const stuck = repeats >= config.worker.maxRepeatedFindings;
      if (stuck || attempt >= config.worker.maxFixAttempts) {
        const branch = await pushForInspection(config, worktree);
        await escalate(
          github,
          loaded,
          issue,
          (stuck
            ? `Review raised the same finding ${repeats} times without it being resolved — another attempt will not help.\n\n`
            : `Review is still rejecting after ${attempt} attempts, each on something new. Stopping at the backstop rather than open-endedly.\n\n`) +
            findings.map((f) => `- ${f}`).join("\n") +
            (review?.recommendation?.trim()
              ? `\n\n**What the reviewer would do**\n\n${review.recommendation}`
              : "") +
            branch,
          opts.announceChannel,
          opts.announceMessage,
        );
        log(target, issue, "review rejected", spent, artifactDir);
        return null;
      }
      continue;
    }
    info(`  ${green("review passed")}`);

    // The pre-push hook runs full local CI, so a rejection here is an ordinary
    // outcome of this loop, not an exception. Treat it like a review rejection:
    // feed what failed back into another attempt.
    const push = await pushBranch(worktree, artifactDir, attempt);
    if (!push) break;

    warn(`  push rejected by local CI${push.timeoutsOnly ? " (all timeouts)" : ""}`);
    await github.commentOnIssue(
      issue.number,
      `${renderCiFailure(push, worktree.slug)}\n\nFull CI output: \`${artifactDir}/push-${attempt}.ci.log\``,
    );

    ciRejections += 1;
    const ciFindings = findingsFrom(push);
    if (
      ciFindings.length > 0 &&
      ciRejections < config.worker.maxCiRejections &&
      attempt < config.worker.maxFixAttempts
    ) {
      findings = ciFindings;
      previousFix = fix;
      continue;
    }

    await announce(loaded, opts.announceChannel,
      push.timeoutsOnly
        ? `⏱️ #${issue.number}: CI timed out — the machine was loaded, not the diff. Work is saved; re-run when quieter.\n${issue.url}`
        : `❌ #${issue.number}: local CI rejected the push. Needs you.\n${issue.url}`,
    );
    // A timeout says nothing about the change, so the issue keeps ready-to-fix
    // and stays in the queue instead of being escalated as a defect.
    if (!push.timeoutsOnly) {
      await github.addLabels(issue.number, [config.github.labels.needsDecision]);
      await github.removeLabels(issue.number, [config.github.labels.readyToFix]);
    }
    await github.removeLabels(issue.number, ["in-progress"]);
    log(target, issue, push.timeoutsOnly ? "CI timed out" : "CI rejected the push", spent, artifactDir);
    return null;
  }

  if (!fix || !review) return null;

  const prUrl = await openPullRequest(github, config, worktree, issue, fix, review, triageNotes, spent, artifactDir, listEvidence(evidence));
  info(`  ${green("PR open")} ${prUrl}`);
  await announce(loaded, opts.announceChannel, `✅ PR open for #${issue.number} — $${spent.toFixed(2)}. Waiting on you.\n${prUrl}`, opts.announceMessage);
  // The screenshots are the argument for the change, and the pull request can
  // only name a path that means nothing away from this machine.
  await shareEvidence(
    loaded,
    opts.announceChannel,
    opts.announceMessage,
    artifactDir,
    `📎 What changed, for #${issue.number}`,
  );
  await github.removeLabels(issue.number, ["in-progress", config.github.labels.readyToFix]);
  await react(loaded, issue, "prReady");
  log(target, issue, `PR opened: ${prUrl}`, spent, artifactDir);
  return null;
}

async function openPullRequest(
  github: GitHubClient,
  config: LoadedConfig["config"],
  worktree: Worktree,
  issue: Issue,
  fix: Fix,
  review: Review,
  triageNotes: string,
  spent: number,
  artifactDir: string,
  evidenceFiles: string[],
): Promise<string> {
  const body = [
    `Closes #${issue.number}.`,
    "",
    fix.summary,
    "",
    "## How this was verified",
    "",
    fix.verification,
    "",
    ...(evidenceFiles.length > 0
      ? [
          "",
          "**Captured while verifying** — in `" + artifactDir + "/evidence`:",
          "",
          ...evidenceFiles.map((f) => `- \`${f}\``),
        ]
      : ["", "_No evidence files were captured._"]),
    "",
    "## What to scrutinise",
    "",
    fix.risks,
    ...(review.nonBlocking.length > 0
      ? ["", "Raised in review, judged non-blocking:", "", ...review.nonBlocking.map((f) => `- ${f}`)]
      : []),
    "",
    "<details><summary>Triage notes</summary>",
    "",
    triageNotes || "(none)",
    "",
    "</details>",
    "",
    `<sub>Opened by feedback-loop — $${spent.toFixed(2)} across triage, fix and review. ` +
      `Nothing here was merged automatically; this is waiting on you.</sub>`,
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");

  const { stdout } = await exec("gh", [
    "pr", "create",
    "--repo", config.target.repo,
    "--base", config.target.baseBranch,
    "--head", worktree.branch,
    "--title", issue.title.replace(/^\[feedback\]\s*/, ""),
    "--body", body,
    "--label", config.github.labels.agentPr,
  ]);
  return stdout.trim().split("\n").at(-1) ?? "";
}

/**
 * Push, and return the CI failure if the hook rejected it. Never bypasses the
 * hook: a gate this tool can switch off is not a gate.
 */
async function pushBranch(
  worktree: Worktree,
  artifactDir: string,
  attempt: number,
): Promise<ReturnType<typeof parseCiFailure>> {
  try {
    await exec("git", ["-C", worktree.path, "push", "-u", "origin", worktree.branch], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return null;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    // The parsed summary is a reading of this; keep the thing it read, because
    // a parser that does not recognise a runner reports a step and no tests,
    // and then there is nothing left to look at.
    writeFileSync(join(artifactDir, `push-${attempt}.ci.log`), output);
    const parsed = parseCiFailure(output);
    if (parsed) return parsed;
    throw error; // a genuine git failure is still an exception
  }
}

function blockedComment(fix: Fix): string {
  return [
    `### 🤔 Stopped before making a change`,
    "",
    `**Reason:** \`${fix.blockedReason}\``,
    "",
    fix.summary,
    ...(fix.risks ? ["", "**Concerns**", "", fix.risks] : []),
    ...(fix.recommendation?.trim() ? ["", "**What I would do**", "", fix.recommendation] : []),
  ].join("\n");
}

/**
 * Push the branch even when the run is giving up, so the work is reachable from
 * anywhere rather than stranded in one worktree on one machine. No pull request
 * is opened — this is for looking at, not for proposing — and the CI hook is
 * never bypassed: a branch that cannot pass is still worth reading, but it must
 * not be mistaken for one that did.
 */
async function pushForInspection(
  config: LoadedConfig["config"],
  worktree: Worktree,
): Promise<string> {
  const compare = `https://github.com/${config.target.repo}/compare/${config.target.baseBranch}...${worktree.branch}`;
  try {
    await exec("git", ["-C", worktree.path, "push", "-u", "origin", worktree.branch], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return `\n\nThe branch is pushed for inspection — no PR: [\`${worktree.branch}\`](${compare})`;
  } catch (error) {
    const failure = parseCiFailure(`${(error as { stdout?: string }).stdout ?? ""}`);
    return failure
      ? `\n\nThe branch could not be pushed: local CI rejected it${failure.timeoutsOnly ? " (all timeouts)" : ""}. It is in \`.worktrees/${worktree.slug}\`.`
      : `\n\nThe branch could not be pushed. It is in \`.worktrees/${worktree.slug}\`.`;
  }
}

async function escalate(
  github: GitHubClient,
  loaded: LoadedConfig,
  issue: Issue,
  comment: string,
  announceChannel?: string,
  announceMessage?: string,
): Promise<void> {
  await announce(loaded, announceChannel, `🤔 Stopped on #${issue.number}. Needs you.\n${issue.url}`, announceMessage);
  await github.commentOnIssue(issue.number, comment);
  await github.addLabels(issue.number, [loaded.config.github.labels.needsDecision]);
  await github.removeLabels(issue.number, ["in-progress", loaded.config.github.labels.readyToFix]);
  await react(loaded, issue, "needsDecision");
}

function log(target: string, issue: Issue, summary: string, costUsd: number, artifactDir: string): void {
  appendRunLog({
    at: new Date().toISOString(),
    kind: "worker",
    target,
    summary: `fix #${issue.number}: ${summary}`,
    data: { issue: issue.number, costUsd, artifactDir },
  });
}

async function lastCommit(worktree: Worktree, baseBranch: string): Promise<string | null> {
  const { stdout } = await exec("git", [
    "-C", worktree.path, "rev-list", "-1", `origin/${baseBranch}..HEAD`,
  ]).catch(() => ({ stdout: "" }));
  return stdout.trim() || null;
}

async function hasCommits(worktree: Worktree, baseBranch: string): Promise<boolean> {
  const { stdout } = await exec("git", [
    "-C", worktree.path, "rev-list", "--count", `origin/${baseBranch}..HEAD`,
  ]);
  return Number(stdout.trim()) > 0;
}

/** Triage's findings live on the issue; the fix phase should not rediscover them. */
async function lastTriageComment(repo: string, issueNumber: number): Promise<string> {
  // --repo matters: without it this resolves against whatever directory the
  // command happened to be run from, which is only the right repo by luck.
  const { stdout } = await exec("gh", [
    "issue", "view", String(issueNumber), "--repo", repo, "--json", "comments",
    "--jq", '[.comments[] | select(.body | test("Reproduced|Triage")) | .body] | last // ""',
  ]).catch(() => ({ stdout: "" }));
  return stdout.trim();
}

async function pickIssue(
  github: GitHubClient,
  readyLabel: string,
  explicit?: number,
): Promise<Issue | null> {
  if (explicit !== undefined) {
    const issue = await github.getIssue(explicit);
    if (!issue) return warnNull(`#${explicit} not found.`);
    if (issue.state !== "OPEN") return warnNull(`#${explicit} is ${issue.state.toLowerCase()}.`);
    if (!issue.labels.some((l) => l.name === readyLabel)) {
      return warnNull(
        `#${explicit} is not labelled ${readyLabel}. Only an issue triage has actually reproduced ` +
          `gets a fix attempt — run \`feedback-loop triage . --issue ${explicit}\` first.`,
      );
    }
    return issue;
  }
  const candidates = await github.listIssues({ labels: [readyLabel], state: "open" });
  return candidates.filter((i) => !i.labels.some((l) => l.name === "needs-decision"))[0] ?? null;
}

function warnNull(message: string): null {
  warn(message);
  return null;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "");
}

async function react(
  loaded: LoadedConfig,
  issue: Issue,
  state: "working" | "needsDecision" | "prReady",
): Promise<void> {
  const link = decodeFooter(issue.body);
  if (!link) return;
  const discord = new DiscordClient(readSecret(loaded.config.discord.tokenFile, "DISCORD_BOT_TOKEN"));
  await setState(discord, link.channel, link.anchor ?? link.messages[0]!, state).catch(() => undefined);
}
