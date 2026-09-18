/**
 * Runs a phase as a headless Claude Code session inside a worktree.
 *
 * The verdict comes back through a file rather than by parsing the final
 * message: an agentic run ends with prose, and prose parsing fails in ways
 * that look like the agent said something it did not.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dim, info } from "../core/log.js";

export interface PhaseRun<T> {
  verdict: T | null;
  costUsd: number;
  turns: number;
  /** Set when the session ended without writing a verdict. */
  failure?: string;
}

export interface PhaseOptions {
  /** Worktree the session runs in. */
  cwd: string;
  /** Where the transcript and verdict are written. Outside the worktree. */
  artifactDir: string;
  model: string;
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

  info(`  ${dim(`phase ${name}: starting (${opts.model})`)}`);

  const stdout = await spawnClaude(
    [
      "-p",
      "--model", opts.model,
      "--output-format", "json",
      "--append-system-prompt", opts.playbook,
      "--permission-mode", "auto",
      "--permission-prompts", "none",
      "--no-session-persistence",
      "--allowedTools", ...opts.allowedTools,
      "--disallowedTools", ...opts.disallowedTools,
    ],
    fullPrompt,
    opts.cwd,
  );

  writeFileSync(transcriptPath, stdout);

  let envelope: { is_error?: boolean; result?: string; total_cost_usd?: number; num_turns?: number };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { verdict: null, costUsd: 0, turns: 0, failure: `no JSON envelope: ${stdout.slice(0, 300)}` };
  }

  const costUsd = envelope.total_cost_usd ?? 0;
  const turns = envelope.num_turns ?? 0;

  if (!existsSync(verdictPath)) {
    return {
      verdict: null,
      costUsd,
      turns,
      failure: envelope.is_error
        ? `session errored: ${envelope.result ?? "unknown"}`
        : `session ended without writing a verdict. Last message: ${(envelope.result ?? "").slice(0, 400)}`,
    };
  }

  const parsed = schema.safeParse(JSON.parse(readFileSync(verdictPath, "utf8")));
  if (!parsed.success) {
    return { verdict: null, costUsd, turns, failure: `verdict failed validation: ${parsed.error.message}` };
  }
  info(`  ${dim(`phase ${name}: done in ${turns} turn(s), $${costUsd.toFixed(3)}`)}`);
  return { verdict: parsed.data, costUsd, turns };
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
