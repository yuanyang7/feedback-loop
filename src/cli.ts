#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadConfigFile, requireRepo, resolveRole, type LoadedConfig } from "./core/config.js";
import { bold, cyan, dim, fail, green, info, red, warn, yellow } from "./core/log.js";
import { readIntakeState, readRunLog } from "./core/state.js";
import { runIntake } from "./intake/run.js";
import { runReconcile } from "./intake/reconcile.js";
import { runTriage } from "./worker/triage.js";
import { handBack, handOff, HUMAN_OWNED } from "./worker/handoff.js";
import { runFix } from "./worker/fix.js";
import { serveDashboard } from "./dashboard/server.js";
import { watchRun } from "./worker/watch.js";
import { runChain } from "./worker/chain.js";
import { adoptBareRequests, heldBack, orderQueue, pickUpWork, promoteAutoWork, severityOf, sizeOf, startsUnasked } from "./worker/pickup.js";
import { activeRuns } from "./intake/commands.js";
import { STATE_EMOJI } from "./intake/emoji.js";
import { readSecret } from "./core/config.js";
import { GitHubClient } from "./intake/github.js";
import { readQueue } from "./worker/queue.js";

const USAGE = `feedback-loop — chat feedback in, reviewed pull requests out.

Usage:
  feedback-loop init [dir]            Scaffold .feedback-loop/ in a target repo
  feedback-loop intake [dir]          One intake tick: new messages -> issues
  feedback-loop reconcile [dir]       Sync chat reactions with GitHub state
  feedback-loop tick [dir]            Run the stages this host's role covers
  feedback-loop pickup [dir]          Start the next queued run, if there is room
  feedback-loop triage [dir]          Reproduce + size one agent-ready issue (never fixes)
  feedback-loop fix [dir]             Fix + adversarial review + open a PR (never merges)
  feedback-loop go [dir] --issue N    triage + fix + PR in one run (still never merges)
  feedback-loop handoff [dir] --issue N  Take one issue off the loop and work on it yourself
  feedback-loop queue [dir]           What runs next, in order, and what is held back
  feedback-loop status [dir]          Queue counts, recent runs, and caps
  feedback-loop dashboard [dir]       Local page: runs, verdicts, before/after screenshots
  feedback-loop watch [dir] --issue N Follow a running phase as it happens
  feedback-loop labels [dir]          Create the labels this tool expects

Options:
  --dry-run        Classify and print; create nothing, react to nothing
  --backfill N     On a fresh cursor, process the last N messages (default: skip history)
  --issue N        triage/fix/handoff: act on this issue instead of picking one
  --slug NAME      handoff: worktree directory name (default: manual-<n>-<title>)
  --prefix P       handoff: branch prefix, e.g. fix (default: fix)
  --no-worktree    handoff: claim the issue only; make the worktree yourself
  --return         handoff: give the issue back to the loop
  --announce ID    triage/fix: post the result to this Discord channel when done
  --port N         dashboard: listen on this port (default 7777)
  --config PATH    Load this config file instead of finding one in a repo.
                   For a host that has no checkout and does not want one.
                   Also read from FEEDBACK_LOOP_CONFIG.
  --role ROLE      all | intake | worker. Which half of the pipeline this host
                   runs; overrides host.role and FEEDBACK_LOOP_ROLE.

Roles
  all      Everything on one machine. The default, and what a laptop does.
  intake   Chat in, issues out, commands accepted — and nothing ever run here.
           Asked-for work goes on the GitHub queue for a worker host to drain.
  worker   Drains that queue. Reads no chat: the Discord cursor has one writer,
           and two hosts advancing it would each skip what the other consumed.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const valueFlags = new Set(["--backfill", "--issue", "--announce", "--announce-message", "--port", "--config", "--role"]);
  const positional = argv.slice(1).filter((a, i) => {
    if (a.startsWith("--")) return false;
    const previous = argv.slice(1)[i - 1];
    return previous === undefined || !valueFlags.has(previous);
  });
  const dir = positional[0] ?? process.cwd();

  /**
   * Find the config, from a repo or from a path. `--config` exists for a host
   * that deliberately has no clone of the target: `loadConfig` walks up
   * looking for `.feedback-loop/` inside one, which cannot succeed there.
   */
  const load = (): LoadedConfig => {
    const i = argv.indexOf("--config");
    if (i >= 0) return loadConfigFile(argv[i + 1]!);
    // FEEDBACK_LOOP_CONFIG lets a container set this once, so that every
    // command run inside it — a tick, a `status` over docker exec — finds the
    // same config without the flag being repeated in three places.
    const fromEnv = process.env.FEEDBACK_LOOP_CONFIG;
    return fromEnv ? loadConfigFile(fromEnv) : loadConfig(dir);
  };
  const roleIndex = argv.indexOf("--role");
  // `--role` with nothing after it is a typo, not a request for the default.
  // Falling through silently would leave a host running the wrong half.
  if (roleIndex >= 0 && (argv[roleIndex + 1] ?? "").startsWith("--")) {
    fail("--role needs a value: all, intake or worker.");
    return 1;
  }
  const roleFlag = roleIndex >= 0 ? argv[roleIndex + 1] : undefined;

  const backfillIndex = argv.indexOf("--backfill");
  const backfill = backfillIndex >= 0 ? Number(argv[backfillIndex + 1] ?? 0) : 0;
  const dryRun = flags.has("--dry-run");

  switch (command) {
    case "init":
      return init(dir);
    case "intake": {
      const loaded = load();
      await runIntake(loaded, { dryRun, backfill, role: intakeRole(resolveRole(loaded.config, roleFlag)) });
      return 0;
    }
    case "reconcile": {
      await runReconcile(load(), { dryRun });
      return 0;
    }
    case "tick": {
      const loaded = load();
      const role = resolveRole(loaded.config, roleFlag);

      // One being unreachable used to take the whole tick with it, so a
      // Discord outage also stopped reactions catching up and work being
      // picked up — neither of which it has anything to do with.
      let failures = 0;
      const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
        try {
          await fn();
        } catch (error) {
          failures += 1;
          warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      // A worker host reads no chat at all. The Discord cursor is a
      // single-writer value: two hosts polling would each advance it past
      // messages the other never saw, and reports would vanish at random.
      if (role !== "worker") {
        await attempt("intake", () => runIntake(loaded, { dryRun, backfill, role: intakeRole(role) }));
        await attempt("reconcile", () => runReconcile(loaded, { dryRun }));
      }

      // Reconcile first: a merge that just freed a slot has to be visible
      // before we decide whether there is room for another run.
      if (role === "intake") {
        // Adopt first: a request labelled by hand has no detail, and no
        // worker host can add it. Then consider promoting new work.
        await attempt("adopting", () => tendQueue(loaded, dryRun));
        await attempt("queueing", () => promoteAutoWork(loaded, dryRun));
      } else {
        await attempt("pickup", () => pickUpWork(loaded, dryRun, role));
      }

      // Non-zero tells launchd, DSM's Task Scheduler, and anyone reading the
      // log, that this tick did not do its job — without it a run of failures
      // looks like a quiet week.
      return failures > 0 ? 1 : 0;
    }
    case "pickup": {
      const loaded = load();
      const role = resolveRole(loaded.config, roleFlag);
      if (role === "intake") {
        await tendQueue(loaded, dryRun);
        await promoteAutoWork(loaded, dryRun);
        return 0;
      }
      await pickUpWork(loaded, dryRun, role);
      return 0;
    }
    case "triage": {
      const issueIndex = argv.indexOf("--issue");
      const issueNumber = issueIndex >= 0 ? Number(argv[issueIndex + 1]) : undefined;
      const a = argv.indexOf("--announce");
      await runTriage(load(), {
        dryRun,
        issueNumber,
        announceChannel: a >= 0 ? argv[a + 1] : undefined,
        announceMessage: msgFlag(argv),
      });
      return 0;
    }
    case "fix": {
      const i = argv.indexOf("--issue");
      const a = argv.indexOf("--announce");
      await runFix(load(), {
        dryRun,
        issueNumber: i >= 0 ? Number(argv[i + 1]) : undefined,
        announceChannel: a >= 0 ? argv[a + 1] : undefined,
        announceMessage: msgFlag(argv),
      });
      return 0;
    }
    case "go": {
      const i = argv.indexOf("--issue");
      const a = argv.indexOf("--announce");
      if (i < 0) {
        fail("go needs an issue: feedback-loop go . --issue 1213");
        return 1;
      }
      await runChain(load(), {
        issueNumber: Number(argv[i + 1]),
        dryRun,
        announceChannel: a >= 0 ? argv[a + 1] : undefined,
        announceMessage: msgFlag(argv),
      });
      return 0;
    }
    case "handoff": {
      const i = argv.indexOf("--issue");
      const issueNumber = i >= 0 ? Number(argv[i + 1]) : NaN;
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        fail("handoff needs an issue: feedback-loop handoff . --issue 1207");
        return 1;
      }
      const loaded = load();
      if (flags.has("--return")) {
        return (await handBack(loaded, issueNumber, dryRun)) ? 0 : 1;
      }
      const s = argv.indexOf("--slug");
      const p = argv.indexOf("--prefix");
      const worktree = await handOff(loaded, {
        issueNumber,
        slug: s >= 0 ? argv[s + 1] : undefined,
        prefix: p >= 0 ? argv[p + 1] : undefined,
        noWorktree: flags.has("--no-worktree"),
        dryRun,
      });
      // Nothing was claimed when a live run or a closed issue refused it, and
      // a script that chains on this should see that rather than press on.
      return worktree === null && !flags.has("--no-worktree") && !dryRun ? 1 : 0;
    }
    case "queue":
      return queue(load());
    case "status":
      return status(load());
    case "dashboard": {
      const p = argv.indexOf("--port");
      await serveDashboard(load(), p >= 0 ? Number(argv[p + 1]) : 7777);
      return 0;
    }
    case "watch": {
      const loaded = loadConfig(dir);
      const at = argv.indexOf("--issue");
      const n = at >= 0 ? Number(argv[at + 1]) : NaN;
      if (!Number.isInteger(n) || n <= 0) {
        fail("watch needs --issue N.");
        return 1;
      }
      const repo = requireRepo(loaded);
      const worktrees = join(repo, ".worktrees");
      const dirs = existsSync(worktrees)
        ? readdirSync(worktrees).filter((d: string) => d.startsWith(`issue-${n}-`))
        : [];
      if (dirs.length === 0) {
        fail(`No worktree for #${n} — nothing has run on it yet.`);
        return 1;
      }
      // A finished run is still worth reading back, so say which case this is
      // rather than refusing when nothing is live.
      if (!activeRuns(loaded.config.target.name).some((r) => r.issue === n)) {
        warn(`No live run on #${n} — showing the last session in its worktree.`);
      }
      await watchRun(join(worktrees, dirs[0]!));
      return 0;
    }
    case "labels":
      return labels(load());
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

/** The message a chat-started run edits as it progresses. */
function msgFlag(argv: string[]): string | undefined {
  const i = argv.indexOf("--announce-message");
  return i >= 0 ? argv[i + 1] : undefined;
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

/** Fill in the detail on any request that arrived as a bare label. */
async function tendQueue(loaded: LoadedConfig, dryRun: boolean): Promise<void> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  await adoptBareRequests(loaded, github, dryRun);
}

/** The role, narrowed to what intake itself distinguishes. */
function intakeRole(role: "all" | "intake" | "worker"): "all" | "intake" {
  return role === "intake" ? "intake" : "all";
}

async function status(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  const target = config.target.name;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const [sourced, ready, blocked, readyToFix, openPRs] = await Promise.all([
    github.listIssues({ labels: [config.github.labels.source], state: "open" }),
    github.listIssues({ labels: [config.github.labels.agentReady], state: "open" }),
    github.listIssues({ labels: [config.github.labels.needsDecision], state: "open" }),
    github.listIssues({ labels: [config.github.labels.readyToFix], state: "open" }),
    github.listPullRequests({ state: "open" }),
  ]);

  const state = readIntakeState(target);
  const log = readRunLog(target, 10);

  console.log(`\n${bold(target)} ${dim(config.target.repo)}\n`);
  console.log(`  ${bold("queue")}`);
  console.log(`    ${String(sourced.length).padStart(3)}  from chat, open`);
  console.log(`    ${String(ready.length).padStart(3)}  ${cyan("agent-ready")}`);
  console.log(`    ${String(readyToFix.length).padStart(3)}  ${green("ready-to-fix")} ${dim("(reproduced)")}`);
  console.log(`    ${String(blocked.length).padStart(3)}  ${yellow("needs-decision")}`);
  const agentPRs = openPRs.filter((pr) => (pr.labels ?? []).some((l) => l.name === "agent-pr"));
  console.log(
    `    ${String(agentPRs.length).padStart(3)}  agent PRs ${dim(`(cap ${config.worker.maxOpenPRs}; ${openPRs.length} open in total)`)}`,
  );

  const capHit = agentPRs.length >= config.worker.maxOpenPRs;
  console.log(
    `\n  ${bold("worker")} ${capHit ? yellow("paused — PR queue is full, drain it to resume") : green("free to pick up work")}`,
  );

  // An unattended tick that stops working is silent by nature — the CLI login
  // it depends on expires, and nothing else notices. Make staleness loud here,
  // because this screen is the only place someone would look.
  const lastTick = state.lastTickAt ? Date.parse(state.lastTickAt) : null;
  const staleMinutes = lastTick ? Math.round((Date.now() - lastTick) / 60000) : null;
  const stale = staleMinutes !== null && staleMinutes > config.intake.staleAfterMinutes;

  console.log(`\n  ${bold("intake")}`);
  console.log(`    cursor     ${state.cursor ?? dim("(not started)")}`);
  console.log(
    `    last tick  ${state.lastTickAt ?? dim("never")}` +
      (staleMinutes === null
        ? ""
        : stale
          ? `  ${red(`— ${formatAge(staleMinutes)} ago, expected every ${config.intake.staleAfterMinutes}m`)}`
          : `  ${dim(`(${formatAge(staleMinutes)} ago)`)}`),
  );
  if (stale) {
    console.log(
      `    ${red("!")}  ${dim("a scheduled tick has not run. Check the login with")} ${cyan("claude auth status")}${dim(", and")} ${cyan(`tail ~/.feedback-loop/${target}/tick.log`)}`,
    );
  }

  // The budget cap only governs worker runs, but intake spends money too and
  // was invisible — so report both, and be explicit about which one is capped.
  const today = new Date().toISOString().slice(0, 10);
  const todays = readRunLog(target, 500).filter((e) => e.at.startsWith(today));
  const cost = (kinds: string[]): number =>
    todays
      .filter((e) => kinds.includes(e.kind))
      .reduce((sum, e) => sum + (typeof e.data?.costUsd === "number" ? e.data.costUsd : 0), 0);
  const workerSpend = cost(["worker"]);

  console.log(`\n  ${bold("spend today")}`);
  console.log(`    $${cost(["intake", "reconcile"]).toFixed(3).padStart(7)}  intake ${dim("(uncapped)")}`);
  console.log(
    `    $${workerSpend.toFixed(3).padStart(7)}  worker ${dim(`(budget $${config.worker.dailyBudgetUsd})`)}` +
      (workerSpend >= config.worker.dailyBudgetUsd ? ` ${yellow("— exhausted")}` : ""),
  );

  if (log.length > 0) {
    console.log(`\n  ${bold("recent")}`);
    for (const entry of log.slice().reverse()) {
      const c = typeof entry.data?.costUsd === "number" ? `$${entry.data.costUsd.toFixed(3)}` : "";
      console.log(
        `    ${dim(entry.at.slice(5, 16).replace("T", " "))} ${entry.kind.padEnd(9)} ${c.padStart(7)}  ${entry.summary}`,
      );
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

async function queue(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  const [ready, prs] = await Promise.all([
    github.listIssues({ labels: [config.github.labels.agentReady], state: "open" }),
    github.listPullRequests({ state: "open" }),
  ]);
  // Asked-for runs are shown above the derived queue, because that is the
  // order they actually start in — one of these overtakes everything below.
  const requested = await readQueue(github, config);

  const lined = orderQueue(ready);
  // An explicitly asked-for issue drains whatever heldBack says — nextRequest
  // refuses only needs-info — so listing it as "set aside" states the opposite
  // of what will happen. #1225 was shown as held while queued and about to run.
  const queued = new Set(requested.map((r) => r.issue));
  const held = ready.filter((i) => heldBack(i) !== null && !queued.has(i.number));
  const agentPrs = prs.filter((pr) => (pr.labels ?? []).some((l) => l.name === config.github.labels.agentPr));
  const running = activeRuns(config.target.name);

  const blocked =
    running.length >= config.worker.maxConcurrentRuns
      ? `${running.map((r) => r.what).join(", ")} still running`
      : agentPrs.length >= config.worker.maxOpenPRs
        ? `${agentPrs.length} agent PR(s) open, cap ${config.worker.maxOpenPRs} — merge one to free a slot`
        : config.worker.auto === "never"
          ? `auto is off — start one with ${cyan("feedback-loop go . --issue N")}`
          : null;

  if (requested.length > 0) {
    console.log(`\n  ${bold("asked for")} ${dim("(starts next, whatever auto says)")}`);
    for (const r of requested) {
      const title = ready.find((i) => i.number === r.issue)?.title ?? "";
      console.log(`    ${green(r.kind.padEnd(6))} #${r.issue}  ${dim(`by ${r.by}`.padEnd(18))} ${title.slice(0, 40)}`);
    }
  }

  console.log(`\n  ${bold("in line")} ${dim(`(${config.github.labels.agentReady}, highest severity first)`)}`);
  if (lined.length === 0) {
    console.log(`    ${dim("nothing")}`);
  } else {
    const auto = lined.filter((i) => startsUnasked(i, config.worker.auto));
    lined.forEach((issue) => {
      const self = startsUnasked(issue, config.worker.auto);
      const marker = self && auto[0] === issue && !blocked ? green(" <- starts next") : "";
      // Say plainly which ones will never start on their own, or the queue reads
      // as a promise it is not making.
      const how = self ? dim("auto ") : yellow("ask  ");
      console.log(
        `    ${how} #${issue.number}  ${dim(`${severityOf(issue)}/${sizeOf(issue) ?? "?"}`.padEnd(9))} ${issue.title.slice(0, 48)}${marker}`,
      );
    });
    if (config.worker.auto !== "never" && auto.length === 0) {
      console.log(`\n    ${dim(`none of these start unasked at auto: ${config.worker.auto}`)}`);
    }
  }

  if (blocked) console.log(`\n  ${yellow("holding")} — ${blocked}`);

  if (held.length > 0) {
    console.log(`\n  ${bold("set aside")} ${dim("(not in line until the label comes off)")}`);
    for (const issue of held) {
      console.log(`      #${issue.number}  ${dim((heldBack(issue) ?? "").padEnd(14))} ${issue.title.slice(0, 48)}`);
    }
  }
  console.log("");
  return 0;
}

async function labels(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  const wanted: Array<[string, string, string]> = [
    [config.github.labels.source, "5865F2", "Filed automatically from a chat channel"],
    [config.github.labels.agentReady, "0E8A16", "Cleared for an autonomous fix attempt"],
    [config.github.labels.needsDecision, "D93F0B", "Needs a human decision before any fix"],
    [config.github.labels.runFailed, "E4E669", "A run fell over; nothing to decide, it just needs another attempt"],
    [config.github.labels.needsInfo, "D4C5F9", "Filed below the confidence floor; ask the reporter for specifics"],
    ["in-progress", "FBCA04", "A worker run is currently working on this"],
    [HUMAN_OWNED, "0052CC", "A person is working on this; the loop will not start runs on it"],
    [config.github.labels.agentPr, "5319E7", "Opened by a worker run; awaiting human review and merge"],
    [config.github.labels.readyToFix, "0E8A16", "Reproduced by triage; cleared for a fix attempt"],
    [config.github.labels.requested, "1D76DB", "Someone asked for a run on this; waiting for a worker host"],
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

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

const SAMPLE_CONFIG = `# feedback-loop — target configuration
# Lives in the target repo so the tool itself stays generic and publishable.

# Which half of the pipeline a host runs. Leave this alone unless you are
# splitting across two machines — see docs/synology.md. Prefer setting it per
# host with --role or FEEDBACK_LOOP_ROLE, so both hosts can share one config.
# host:
#   role: all                  # all | intake | worker

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
