/**
 * Phases 3-5: implement, review adversarially, open a pull request — and stop.
 *
 * Nothing here merges. The run ends with a PR a human has to read, which is
 * the whole point: the expensive, scarce resource this design protects is
 * review attention, not compute.
 */
import { mkdirSync, existsSync } from "node:fs";
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
  blockedReason: z
    .enum(["none", "deny-path", "too-large", "cannot-verify", "needs-product-decision"])
    .describe("Why this should stop here instead of becoming a PR, or 'none'."),
});

const ReviewSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  blocking: z.array(z.string()).describe("Issues that must be fixed before this can be reviewed by a human."),
  nonBlocking: z.array(z.string()).describe("Worth mentioning in the PR, not worth another attempt."),
  reasoning: z.string(),
});

type Fix = z.infer<typeof FixSchema>;
type Review = z.infer<typeof ReviewSchema>;

const FIX_PROMPT = (issue: Issue, triage: string, denyPaths: string[], previousFindings: string[]) => `Fix the bug below. It has already been reproduced — the triage notes say how.

${previousFindings.length > 0 ? `A previous attempt was rejected in review. Address these before anything else:\n${previousFindings.map((f) => `  - ${f}`).join("\n")}\n` : ""}
Work in this worktree, on its existing branch. When the fix is done:

1. Confirm the reported problem is actually gone — drive the same interaction that reproduced it.
   Green tests prove nothing else broke; they do not prove this is fixed.
2. Run typecheck, lint, test and build. All must pass.
3. Commit, following the repo's commit message rules. Do not push, and do not open a pull request —
   that happens outside this session.

Stop and set blockedReason instead of continuing if a fix would touch any of:
${denyPaths.map((p) => `  - ${p}`).join("\n")}

Prefer the smallest change that actually fixes the reported problem. A refactor you believe in is
not in scope, and it makes the diff harder to review.

<issue number="${issue.number}">
<title>${issue.title}</title>
<body>
${issue.body}
</body>
</issue>

<triage-notes>
${triage}
</triage-notes>`;

const REVIEW_PROMPT = (issue: Issue, fix: Fix, baseBranch: string) => `Review the committed changes on this branch as a hostile reviewer. You are the last check before a human spends their attention on this.

Read the diff with \`git diff origin/${baseBranch}...HEAD\` and judge it on:

- **Correctness.** Does it actually fix the reported problem, or does it fix a symptom?
- **Scope.** Is anything in the diff unrelated to the issue?
- **Security.** Does it introduce a way for untrusted input to reach somewhere it should not?
- **Evidence.** The claim below says how it was verified. Is that claim actually supported?
- **Simplicity.** Is this the smallest change that works?

Do not be agreeable. A finding you are unsure about belongs in nonBlocking, not omitted. Reject if
anything in blocking would waste a reviewer's time or ship a defect.

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
  opts: { issueNumber?: number; dryRun: boolean },
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
  opts: { issueNumber?: number; dryRun: boolean },
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
    return null;
  }

  const issue = await pickIssue(github, labels.readyToFix, opts.issueNumber);
  if (!issue) {
    if (opts.issueNumber === undefined) {
      info(`Nothing labelled ${cyan(labels.readyToFix)} to fix. Run triage first.`);
    }
    return null;
  }
  info(`${bold(`#${issue.number}`)} ${issue.title}`);

  if (!playbookPath) {
    warn("No .feedback-loop/playbook.md — refusing to run an agent in this repo without one.");
    return null;
  }
  const { readFileSync } = await import("node:fs");
  const playbook = readFileSync(playbookPath, "utf8");

  // Triage wrote its findings on the issue. Reuse them rather than rediscovering.
  const triageNotes = await lastTriageComment(config.target.repo, issue.number);

  if (opts.dryRun) {
    console.log(`\n${dim("[dry-run] would run the fix phase with this prompt:")}\n`);
    console.log(FIX_PROMPT(issue, triageNotes, config.worker.denyPaths, []));
    return null;
  }

  const slug = slugForIssue(issue.number, issue.title);
  const artifactDir = join(runsDir(target), `${stamp()}-fix-${slug}`);
  mkdirSync(artifactDir, { recursive: true });

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
  };

  let fix: Fix | null = null;
  let review: Review | null = null;
  let findings: string[] = [];
  let spent = 0;

  for (let attempt = 1; attempt <= config.worker.maxFixAttempts; attempt += 1) {
    info(`  ${bold(`attempt ${attempt}/${config.worker.maxFixAttempts}`)}`);

    const fixRun = await runPhase(
      `fix-${attempt}`,
      FIX_PROMPT(issue, triageNotes, config.worker.denyPaths, findings),
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
    fix = fixRun.verdict;

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
      await escalate(github, loaded, issue, `The fix phase did not complete.\n\n\`\`\`\n${fixRun.failure}\n\`\`\``);
      log(target, issue, "fix phase failed", spent, artifactDir);
      return null;
    }
    if (fix.blockedReason !== "none") {
      warn(`  blocked: ${fix.blockedReason}`);
      await escalate(github, loaded, issue, blockedComment(fix));
      log(target, issue, `blocked: ${fix.blockedReason}`, spent, artifactDir);
      return null;
    }
    if (!fix.implemented || !(await hasCommits(worktree, config.target.baseBranch))) {
      warn("  reported success but committed nothing");
      await escalate(github, loaded, issue, "The fix phase reported success but committed nothing.");
      log(target, issue, "no commits", spent, artifactDir);
      return null;
    }

    const reviewRun = await runPhase(
      `review-${attempt}`,
      REVIEW_PROMPT(issue, fix, config.target.baseBranch),
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

    if (review?.verdict === "approve") {
      info(`  ${green("review passed")}`);
      break;
    }
    findings = review?.blocking ?? ["Review did not complete; treat that as a rejection."];
    warn(`  review rejected: ${findings.length} blocking finding(s)`);
    review = review ?? null;

    if (attempt === config.worker.maxFixAttempts) {
      await escalate(
        github,
        loaded,
        issue,
        `Review rejected ${config.worker.maxFixAttempts} attempts. Escalating rather than grinding.\n\n` +
          findings.map((f) => `- ${f}`).join("\n"),
      );
      log(target, issue, "review rejected", spent, artifactDir);
      return null;
    }
  }

  if (!fix || !review) return null;

  const prUrl = await openPullRequest(github, config, worktree, issue, fix, review, triageNotes, spent);
  info(`  ${green("PR open")} ${prUrl}`);
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
): Promise<string> {
  await exec("git", ["-C", worktree.path, "push", "-u", "origin", worktree.branch], {
    env: { ...process.env, SKIP_CI_HOOK: process.env.SKIP_CI_HOOK ?? "" },
  });

  const body = [
    `Closes #${issue.number}.`,
    "",
    fix.summary,
    "",
    "## How this was verified",
    "",
    fix.verification,
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

function blockedComment(fix: Fix): string {
  return [
    `### 🤔 Stopped before making a change`,
    "",
    `**Reason:** \`${fix.blockedReason}\``,
    "",
    fix.summary,
    ...(fix.risks ? ["", "**Concerns**", "", fix.risks] : []),
  ].join("\n");
}

async function escalate(
  github: GitHubClient,
  loaded: LoadedConfig,
  issue: Issue,
  comment: string,
): Promise<void> {
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
  await setState(discord, link.channel, link.messages[0]!, state).catch(() => undefined);
}
