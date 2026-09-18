/**
 * Two ways to reach a model, behind one interface.
 *
 *   cli — spawn the `claude` CLI headless. No API key, no separate billing:
 *         it uses the Claude Code login you already have. Default, because
 *         anyone running this tool almost certainly already has that.
 *   api — the Anthropic SDK with structured outputs. Better for an unattended
 *         server, and gives schema-validated output without prompt coaxing.
 *
 * Either way the model is asked to classify text, never to act on it.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type BackendName = "cli" | "api";

export interface CompletionResult<T> {
  value: T;
  /** Reported by the CLI backend; null when the API backend is used. */
  costUsd: number | null;
}

export interface Classifier {
  complete<T>(opts: { system: string; user: string }, schema: z.ZodType<T>): Promise<CompletionResult<T>>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function makeClassifier(backend: BackendName, model: string, effort: Effort = "low"): Classifier {
  return backend === "api" ? new ApiClassifier(model, effort) : new CliClassifier(model, effort);
}

/** Tools are irrelevant to classification, and a tool-less run cannot be steered into acting. */
const BLOCKED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
];

class CliClassifier implements Classifier {
  constructor(
    private readonly model: string,
    private readonly effort: Effort,
  ) {}

  async complete<T>(
    opts: { system: string; user: string },
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);
    const prompt = `${opts.user}\n\nRespond with a single JSON object and nothing else — no prose, no code fence. It must validate against this JSON Schema:\n\n${jsonSchema}`;

    // An empty cwd so no CLAUDE.md, settings, or MCP config from a nearby
    // project leaks into a classification prompt.
    const cwd = mkdtempSync(join(tmpdir(), "feedback-loop-"));
    try {
      // The prompt goes on stdin: --disallowed-tools is variadic and would
      // otherwise swallow a positional prompt argument.
      const stdout = await run(
        "claude",
        [
          "-p",
          "--model", this.model,
          "--effort", this.effort,
          "--output-format", "json",
          "--system-prompt", opts.system,
          "--exclude-dynamic-system-prompt-sections",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--disallowed-tools", ...BLOCKED_TOOLS,
        ],
        { cwd, stdin: prompt },
      );

      let envelope: { result?: string; is_error?: boolean; total_cost_usd?: number };
      try {
        envelope = JSON.parse(stdout);
      } catch {
        throw new Error(`claude CLI produced no JSON envelope: ${stdout.slice(0, 300)}`);
      }
      if (envelope.is_error) {
        throw new Error(
          `claude CLI: ${envelope.result ?? "unknown error"}\n` +
            `If this mentions an expired OAuth session, run \`claude\` once in a terminal to refresh ` +
            `the login, or set intake.backend: api and provide ANTHROPIC_API_KEY.`,
        );
      }
      return {
        value: schema.parse(extractJson(envelope.result ?? "")),
        costUsd: envelope.total_cost_usd ?? null,
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/** Spawn, feed stdin, and return stdout even when the exit code is non-zero. */
function run(
  command: string,
  args: string[],
  opts: { cwd: string; stdin: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", () => {
      // A non-zero exit still carries a usable JSON envelope on stdout.
      if (stdout.trim()) resolve(stdout);
      else reject(new Error(`${command} produced no output. stderr: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.end(opts.stdin);
  });
}

class ApiClassifier implements Classifier {
  constructor(
    private readonly model: string,
    private readonly effort: Effort,
  ) {}

  async complete<T>(
    opts: { system: string; user: string },
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
      import("@anthropic-ai/sdk"),
      import("@anthropic-ai/sdk/helpers/zod"),
    ]);
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: this.model,
      max_tokens: 8000,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      output_config: { format: zodOutputFormat(schema as z.ZodType), effort: this.effort },
      messages: [{ role: "user", content: opts.user }],
    });
    if (response.parsed_output == null) {
      throw new Error("Model returned no parseable structured output.");
    }
    return { value: response.parsed_output as T, costUsd: null };
  }
}

/** Models sometimes wrap JSON in a fence or a sentence despite instructions. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`No JSON object in model output: ${candidate.slice(0, 300)}`);
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }
}
