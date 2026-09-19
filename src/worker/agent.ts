/**
 * Runs a phase as a headless Claude Code session inside a worktree.
 *
 * The verdict comes back through a file rather than by parsing the final
 * message: an agentic run ends with prose, and prose parsing fails in ways
 * that look like the agent said something it did not.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dim, info } from "../core/log.js";

export interface PhaseRun<T> {
  verdict: T | null;
  costUsd: number;
  turns: number;
  /** Claude Code session id — resumable, and visible in the app's history. */
  sessionId?: string;
  /** Set when the session ended without writing a verdict. */
  failure?: string;
}

export interface PhaseOptions {
  /** Worktree the session runs in. */
  cwd: string;
  /** Where the transcript and verdict are written. Outside the worktree. */
  artifactDir: string;
  model: string;
  effort: string;
  /** Passed to the session as a hard spend ceiling. */
  maxBudgetUsd: number;
  /** Wall-clock ceiling. A blocked session spends nothing, so the budget never saves it. */
  timeoutMinutes: number;
  /** Appended to the default system prompt — normally the repo's playbook. */
  playbook: string;
  allowedTools: string[];
  disallowedTools: string[];
}

export async function runPhase<T>(
  name: string,
  prompt: string,
  schema: z.ZodType<T>,
  opts: PhaseOptions,
): Promise<PhaseRun<T>> {
  const verdictPath = join(opts.artifactDir, `${name}.verdict.json`);
  const transcriptPath = join(opts.artifactDir, `${name}.transcript.json`);

  const fullPrompt = `${prompt}

---

When you are finished, write your verdict as a single JSON object to this exact path:

    ${verdictPath}

It must validate against this JSON Schema:

${JSON.stringify(z.toJSONSchema(schema), null, 2)}

Writing that file is how you report your result. A session that ends without it has failed,
however much you found out along the way.`;

  info(`  ${dim(`phase ${name}: starting (${opts.model}, effort ${opts.effort})`)}`);

  const stdout = await spawnClaude(
    [
      "-p",
      "--model", opts.model,
      "--effort", opts.effort,
      "--max-budget-usd", String(opts.maxBudgetUsd),
      "--output-format", "json",
      "--append-system-prompt", opts.playbook,
      "--permission-mode", "auto",
      "--permission-prompts", "none",
      // A variadic flag with an empty list is a parse error, not a no-op.
      ...(opts.allowedTools.length > 0 ? ["--allowedTools", ...opts.allowedTools] : []),
      ...(opts.disallowedTools.length > 0 ? ["--disallowedTools", ...opts.disallowedTools] : []),
    ],
    fullPrompt,
    opts.cwd,
    opts.timeoutMinutes,
  );

  writeFileSync(transcriptPath, stdout);

  let envelope: {
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    num_turns?: number;
    session_id?: string;
    subtype?: string;
    terminal_reason?: string;
  };
  try {
    envelope = JSON.parse(stdout);
  } catch {
  return { verdict: null, costUsd: 0, turns: 0, failure: `no JSON envelope: ${stdout.slice(0, 300)}` };
  }

  const costUsd = envelope.total_cost_usd ?? 0;
  const turns = envelope.num_turns ?? 0;
  const sessionId = envelope.session_id;

  // The --output-format json envelope carries only the final message, so the
  // turn-by-turn record has to come from the persisted session file. Copy it
  // in rather than pointing at it: sessions get cleaned up, artifacts should not.
  if (sessionId) {
    const source = findSessionFile(sessionId);
    if (source) copyFileSync(source, join(opts.artifactDir, `${name}.session.jsonl`));
  }

  if (!existsSync(verdictPath)) {
    return {
      verdict: null,
      costUsd,
      turns,
      sessionId,
      failure: describeFailure(envelope, costUsd, opts.maxBudgetUsd),
    };
  }

  const parsed = schema.safeParse(JSON.parse(readFileSync(verdictPath, "utf8")));
  if (!parsed.success) {
    return { verdict: null, costUsd, turns, sessionId, failure: `verdict failed validation: ${parsed.error.message}` };
  }
  info(`  ${dim(`phase ${name}: done in ${turns} turn(s), $${costUsd.toFixed(3)}`)}`);
  return { verdict: parsed.data, costUsd, turns, sessionId };
}

/**
 * A killed session has a null result, so the envelope's own fields are the only
 * thing that says what happened. Reporting "unknown" when it plainly says
 * budget_exhausted sends someone hunting for a bug that is really a setting.
 */
function describeFailure(
  envelope: { is_error?: boolean; result?: string; subtype?: string; terminal_reason?: string },
  costUsd: number,
  budgetUsd: number,
): string {
  if (envelope.subtype === "error_max_budget_usd" || envelope.terminal_reason === "budget_exhausted") {
    return `ran out of budget at $${costUsd.toFixed(2)} (cap $${budgetUsd.toFixed(2)}) before writing a verdict`;
  }
  if (envelope.is_error) {
    return `session errored: ${envelope.result ?? envelope.terminal_reason ?? envelope.subtype ?? "no detail reported"}`;
  }
  return `session ended without writing a verdict. Last message: ${(envelope.result ?? "").slice(0, 400)}`;
}

/**
 * Sessions live under a directory named after the cwd they ran in, but the
 * exact mangling is Claude Code's business — so search for the id instead of
 * reconstructing the path.
 */
function findSessionFile(sessionId: string): string | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function spawnClaude(
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMinutes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // detached so the whole process group can be killed: a session that blocks
    // usually does so on a server it started, and killing only the session
    // leaves that child holding the pipes open.
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        reject(
          new Error(
            `session exceeded ${timeoutMinutes} minutes of wall clock and was killed. ` +
              `A blocked session spends nothing, so the spend cap never trips — this is the only ` +
              `thing that stops it. The usual cause is a command that does not return, such as a ` +
              `dev server started in the foreground.`,
          ),
        );
      },
      timeoutMinutes * 60_000,
    );

    child.stdout.on("data", (c: Buffer) => (stdout += c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    // "exit" rather than "close": close waits for every inherited pipe, so one
    // leaked grandchild would hold this open long after the session is done.
    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Give the streams a beat to flush what is already buffered.
      setTimeout(() => {
        if (stdout.trim()) resolve(stdout);
        else reject(new Error(`claude produced no output. stderr: ${stderr.trim().slice(0, 500)}`));
      }, 250);
    });
    child.stdin.end(prompt);
  });
}
