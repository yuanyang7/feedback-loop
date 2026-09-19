import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { z } from "zod";

/** Paths that a worker must never auto-fix — a wrong-but-plausible diff here is expensive. */
const DEFAULT_DENY_PATHS = [
  "**/schema.prisma",
  "**/migrations/**",
  ".github/**",
  "**/auth/**",
  "**/payment*/**",
  "**/billing/**",
  "scripts/release*",
  ".feedback-loop/**",
  // Test configuration is the gate's own machinery. An agent told "CI failed"
  // can reach the right answer here — one did — but the path from "a test
  // timed out" to "raise the timeout" is the same path as "an assertion
  // failed" to "delete the assertion", and only one of those is acceptable.
  // Changing how every test runs is a human decision.
  "vitest.config.*",
  "jest.config.*",
  "**/jest.setup.*",
  "vitest-setup.*",
  "playwright.config.*",
];

export const ConfigSchema = z.object({
  target: z.object({
    /** Short slug used for state and run directories. */
    name: z.string().min(1),
    /** GitHub "owner/repo". */
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"'),
    baseBranch: z.string().default("dev"),
    /** Checkout to work in. Defaults to the directory containing .feedback-loop/. */
    path: z.string().optional(),
  }),
  discord: z.object({
    guildId: z.string(),
    channelId: z.string(),
    /** File holding DISCORD_BOT_TOKEN=… (or the bare token). */
    tokenFile: z.string(),
    /** Authors whose messages are never filed — e.g. the bots themselves. */
    ignoreAuthorIds: z.array(z.string()).default([]),
    /** Mentioning one of these bypasses the confidence floor. */
    mentionTriggerIds: z.array(z.string()).default([]),
    /**
     * Discord user ids allowed to start worker runs from chat. Deliberately
     * separate from every other list here: this one authorises spending money
     * and running code on the machine, so it is opt-in and names people, not
     * roles. Empty means chat cannot start anything.
     */
    operatorIds: z.array(z.string()).default([]),
    /**
     * Extra channels polled for commands only — a DM is the natural place to
     * drive this from a phone. Reports are never taken from here: intake stays
     * scoped to channelId so ordinary conversation cannot become issues.
     */
    commandChannelIds: z.array(z.string()).default([]),
    /**
     * Reply in-channel with the issue number when something is filed. A
     * reaction tells the reporter it landed somewhere; only a link tells them
     * where, and lets them follow it.
     */
    replyWithIssue: z.boolean().default(true),
  }),
  github: z.object({
    /** File holding a GitHub token. Falls back to the ambient `gh` login. */
    tokenFile: z.string().optional(),
    /** Prepended to every filed title, e.g. "[feedback]". Empty for none. */
    titlePrefix: z.string().default(""),
    labels: z
      .object({
        source: z.string().default("from-discord"),
        agentReady: z.string().default("agent-ready"),
        needsDecision: z.string().default("needs-decision"),
        needsInfo: z.string().default("needs-info"),
        /** Applied by triage when a bug was reproduced and nothing blocks a fix. */
        readyToFix: z.string().default("ready-to-fix"),
        agentPr: z.string().default("agent-pr"),
      })
      .prefault({}),
  }),
  intake: z
    .object({
      /** cli = the `claude` CLI you already log into. api = ANTHROPIC_API_KEY. */
      backend: z.enum(["cli", "api"]).default("cli"),
      model: z.string().default("claude-sonnet-5"),
      /** Costs the same as low here, and dedupe judgement is worth the headroom. */
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
      /** Below this, intake files nothing and asks a human to restate. */
      minConfidence: z.number().min(0).max(1).default(0.7),
      /**
       * Severity at which a filed bug is cleared for an autonomous attempt
       * without waiting for a human. "never" keeps the gate closed for
       * everything, which is the default: the label means a person judged this
       * safe to hand to an agent, and a tool that grants its own permission is
       * not a gate. Raising it trades that judgement for latency on the reports
       * where waiting costs most.
       */
      autoAgentReady: z.enum(["never", "high", "medium"]).default("never"),
      /** Deliberately higher than minConfidence: a wrong duplicate loses the report entirely. */
      minDuplicateConfidence: z.number().min(0).max(1).default(0.85),
      /** Max messages pulled per tick. */
      lookbackLimit: z.number().int().positive().default(100),
      /** Consecutive messages from one author within this window are one report. */
      groupWindowSeconds: z.number().int().positive().default(300),
      /** status flags the schedule as broken past this. Set above your interval. */
      staleAfterMinutes: z.number().int().positive().default(45),
    })
    .prefault({}),
  worker: z
    .object({
      maxOpenPRs: z.number().int().positive().default(3),
      /** Bounded by the machine, not by correctness: each run wants its own
       * database, dev server and full CI pass. Different issues never share a
       * worktree, so raising this is safe, just contended. */
      maxConcurrentRuns: z.number().int().positive().default(1),
      maxRunsPerDay: z.number().int().positive().default(10),
      dailyBudgetUsd: z.number().positive().default(15),
      /**
       * Stop when review raises the same blocking finding twice. That is the
       * shape that means a run is stuck; rounds that each clear one problem and
       * uncover another are converging, just slowly, and counting rounds
       * conflates the two.
       */
      maxRepeatedFindings: z.number().int().positive().default(2),
      /** Backstop only, so a run that keeps finding new things cannot run forever. */
      maxFixAttempts: z.number().int().positive().default(4),
      /** CI rejections are counted apart from review: correctness, not judgement. */
      maxCiRejections: z.number().int().positive().default(2),
      /** Triage reads code and drives the app; it is not the fix, so it stays cheap. */
      /** Hard ceilings per phase. The daily budget alone is too coarse, and a
       * fix costs several times what reading and reproducing does. */
      /** Wall clock per phase. The spend caps cannot see a session that hangs. */
      phaseTimeoutMinutes: z.number().int().positive().default(45),
      triageMaxUsd: z.number().positive().default(3),
      fixMaxUsd: z.number().positive().default(10),
      reviewMaxUsd: z.number().positive().default(4),
      triageModel: z.string().default("claude-sonnet-5"),
      /** Writing the fix is the expensive judgement call, so it gets the better model. */
      fixModel: z.string().default("claude-opus-5"),
      fixEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      /** Review is the last gate before a human, so it does not economise either. */
      reviewModel: z.string().default("claude-opus-5"),
      reviewEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      triageEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      denyPaths: z.array(z.string()).default(DEFAULT_DENY_PATHS),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  /** Absolute path to the target checkout. */
  repoPath: string;
  /** Absolute path to .feedback-loop/playbook.md, if present. */
  playbookPath: string | null;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Find `.feedback-loop/config.yml` by walking up from `start`. */
export function findConfigDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".feedback-loop", "config.yml"))) {
      return join(dir, ".feedback-loop");
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(start: string): LoadedConfig {
  const configDir = findConfigDir(start);
  if (!configDir) {
    throw new Error(
      `No .feedback-loop/config.yml found at or above ${resolve(start)}.\n` +
        `Run \`feedback-loop init\` inside the target repo to create one.`,
    );
  }
  const raw = YAML.parse(readFileSync(join(configDir, "config.yml"), "utf8"));
  const config = ConfigSchema.parse(raw);

  const repoRoot = dirname(configDir);
  const repoPath = config.target.path
    ? resolve(repoRoot, expandHome(config.target.path))
    : repoRoot;

  const playbookPath = join(configDir, "playbook.md");
  return {
    config,
    repoPath,
    playbookPath: existsSync(playbookPath) ? playbookPath : null,
  };
}

/**
 * Read a secret from a file that is either a bare token or a dotenv line.
 * Secrets stay where they already live; nothing is copied into this repo.
 */
export function readSecret(file: string, key: string): string {
  const path = isAbsolute(expandHome(file)) ? expandHome(file) : resolve(expandHome(file));
  if (!existsSync(path)) throw new Error(`Secret file not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const line = text.split("\n").find((l) => l.trim().startsWith(`${key}=`));
  const value = line ? line.slice(line.indexOf("=") + 1) : text;
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) throw new Error(`No value for ${key} in ${path}`);
  return trimmed;
}
