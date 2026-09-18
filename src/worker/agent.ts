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
      "--output-format", "json",
      "--append-system-prompt", opts.playbook,
      "--permission-mode", "auto",
      "--permission-prompts", "none",
      "--allowedTools", ...opts.allowedTools,
      "--disallowedTools", ...opts.disallowedTools,
    ],
    fullPrompt,
    opts.cwd,
  );

  writeFileSync(transcriptPath, stdout);

  let envelope: {
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    num_turns?: number;
    session_id?: string;
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
      failure: envelope.is_error
        ? `session errored: ${envelope.result ?? "unknown"}`
        : `session ended without writing a verdict. Last message: ${(envelope.result ?? "").slice(0, 400)}`,
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

function spawnClaude(args: string[], prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    child.on("error", reject);
    child.on("close", () => {
      if (stdout.trim()) resolve(stdout);
      else reject(new Error(`claude produced no output. stderr: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.end(prompt);
  });
}
