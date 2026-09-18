#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./core/config.js";
import { bold, cyan, dim, fail, green, info, yellow } from "./core/log.js";
import { readIntakeState, readRunLog } from "./core/state.js";
import { runIntake } from "./intake/run.js";
import { runReconcile } from "./intake/reconcile.js";
import { STATE_EMOJI } from "./intake/emoji.js";
import { readSecret } from "./core/config.js";
import { GitHubClient } from "./intake/github.js";

const USAGE = `feedback-loop — chat feedback in, reviewed pull requests out.

Usage:
  feedback-loop init [dir]            Scaffold .feedback-loop/ in a target repo
  feedback-loop intake [dir]          One intake tick: new messages -> issues
  feedback-loop reconcile [dir]       Sync chat reactions with GitHub state
  feedback-loop tick [dir]            intake + reconcile
  feedback-loop status [dir]          Queue, recent runs, and caps
  feedback-loop labels [dir]          Create the labels this tool expects

Options:
  --dry-run        Classify and print; create nothing, react to nothing
  --backfill N     On a fresh cursor, process the last N messages (default: skip history)
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
  const dir = positional[0] ?? process.cwd();

  const backfillIndex = argv.indexOf("--backfill");
  const backfill = backfillIndex >= 0 ? Number(argv[backfillIndex + 1] ?? 0) : 0;
  const dryRun = flags.has("--dry-run");

  switch (command) {
    case "init":
      return init(dir);
    case "intake": {
      await runIntake(loadConfig(dir), { dryRun, backfill });
      return 0;
    }
    case "reconcile": {
      await runReconcile(loadConfig(dir), { dryRun });
      return 0;
    }
    case "tick": {
      const loaded = loadConfig(dir);
      await runIntake(loaded, { dryRun, backfill });
      await runReconcile(loaded, { dryRun });
      return 0;
    }
    case "status":
      return status(dir);
    case "labels":
      return labels(dir);
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

function init(dir: string): number {
  const configDir = join(dir, ".feedback-loop");
  if (existsSync(join(configDir, "config.yml"))) {
    fail(`${configDir}/config.yml already exists.`);
    return 1;
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yml"), SAMPLE_CONFIG);
  if (!existsSync(join(configDir, "playbook.md"))) {
    writeFileSync(join(configDir, "playbook.md"), SAMPLE_PLAYBOOK);
  }
  info(`${green("created")} ${configDir}/config.yml`);
  info(`${green("created")} ${configDir}/playbook.md`);
  info(`Fill both in, then run ${cyan("feedback-loop intake --dry-run")}.`);
  return 0;
}

async function status(dir: string): Promise<number> {
  const { config } = loadConfig(dir);
  const target = config.target.name;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const [sourced, ready, blocked, openPRs] = await Promise.all([
    github.listIssues({ labels: [config.github.labels.source], state: "open" }),
    github.listIssues({ labels: [config.github.labels.agentReady], state: "open" }),
    github.listIssues({ labels: [config.github.labels.needsDecision], state: "open" }),
    github.listPullRequests({ state: "open" }),
  ]);

  const state = readIntakeState(target);
  const log = readRunLog(target, 10);

  console.log(`\n${bold(target)} ${dim(config.target.repo)}\n`);
  console.log(`  ${bold("queue")}`);
  console.log(`    ${String(sourced.length).padStart(3)}  from chat, open`);
  console.log(`    ${String(ready.length).padStart(3)}  ${cyan("agent-ready")}`);
  console.log(`    ${String(blocked.length).padStart(3)}  ${yellow("needs-decision")}`);
  console.log(`    ${String(openPRs.length).padStart(3)}  open PRs ${dim(`(cap ${config.worker.maxOpenPRs})`)}`);

  const capHit = openPRs.length >= config.worker.maxOpenPRs;
  console.log(
    `\n  ${bold("worker")} ${capHit ? yellow("paused — PR queue is full, drain it to resume") : green("free to pick up work")}`,
  );

  console.log(`\n  ${bold("intake")}`);
  console.log(`    cursor     ${state.cursor ?? dim("(not started)")}`);
  console.log(`    last tick  ${state.lastTickAt ?? dim("never")}`);

  if (log.length > 0) {
    console.log(`\n  ${bold("recent")}`);
    for (const entry of log.slice().reverse()) {
      console.log(`    ${dim(entry.at.slice(5, 16).replace("T", " "))} ${entry.kind.padEnd(9)} ${entry.summary}`);
    }
  }

  if (blocked.length > 0) {
    console.log(`\n  ${bold("waiting on you")}`);
    for (const issue of blocked.slice(0, 10)) {
      console.log(`    ${STATE_EMOJI.needsDecision} #${issue.number} ${issue.title}`);
    }
  }
  console.log("");
  return 0;
}

async function labels(dir: string): Promise<number> {
  const { config } = loadConfig(dir);
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  const wanted: Array<[string, string, string]> = [
    [config.github.labels.source, "5865F2", "Filed automatically from a chat channel"],
    [config.github.labels.agentReady, "0E8A16", "Cleared for an autonomous fix attempt"],
    [config.github.labels.needsDecision, "D93F0B", "Needs a human decision before any fix"],
    ["in-progress", "FBCA04", "A worker run is currently working on this"],
    ["agent-pr", "5319E7", "Opened by a worker run; awaiting human review and merge"],
    ["severity:high", "B60205", "Data loss, or a core flow is unusable"],
    ["severity:medium", "D93F0B", "A real feature is broken for some users"],
    ["severity:low", "FEF2C0", "Cosmetic, rare, or a minor annoyance"],
    ["size:s", "C2E0C6", "Small: copy, styling, obvious local fix"],
    ["size:m", "BFD4F2", "Medium: logic inside one module"],
    ["size:l", "E99695", "Large: cross-cutting; never auto-fixed"],
  ];
  for (const [name, color, description] of wanted) {
    await github.ensureLabel(name, color, description);
    info(`${green("label")} ${name}`);
  }
  return 0;
}

const SAMPLE_CONFIG = `# feedback-loop — target configuration
# Lives in the target repo so the tool itself stays generic and publishable.

target:
  name: my-app                 # slug for local state and run directories
  repo: owner/my-app           # GitHub repo that receives the issues and PRs
  baseBranch: dev              # PRs are opened against this, never master

discord:
  guildId: "000000000000000000"
  channelId: "000000000000000000"
  tokenFile: ~/.config/my-app/discord.env   # holds DISCORD_BOT_TOKEN=...
  ignoreAuthorIds: []          # bot ids whose messages should never be filed
  mentionTriggerIds: []        # mentioning these bypasses the confidence floor

github:
  # tokenFile: .secrets/github-token   # omit to use the ambient \`gh\` login
  labels:
    source: from-discord
    agentReady: agent-ready
    needsDecision: needs-decision

intake:
  # cli = spawn the \`claude\` CLI, using the Claude Code login you already have.
  # api = the Anthropic SDK; needs ANTHROPIC_API_KEY. Better for an unattended server.
  backend: cli
  model: claude-sonnet-5
  minConfidence: 0.7
  lookbackLimit: 100
  groupWindowSeconds: 300

worker:
  maxOpenPRs: 3                # the worker stops until you drain the queue
  maxRunsPerDay: 10
  dailyBudgetUsd: 15
  maxFixAttempts: 2
  # denyPaths: omitted -> schema/migrations/auth/payments/CI/release are protected
`;

const SAMPLE_PLAYBOOK = `# Playbook

Appended verbatim to the worker's system prompt. Point at the files that already
document your workflow rather than restating them here.

## Setting up a working copy
<!-- e.g. how to create a worktree and a scratch database -->

## Reproducing a bug
<!-- how to run the app locally and drive it -->

## Verifying a fix
<!-- tests, screenshots, whatever counts as evidence here -->

## Opening the PR
<!-- the ship command, target branch, and the rule that nothing is ever merged -->

## Things to never touch
<!-- anything beyond the configured denyPaths -->
`;

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
