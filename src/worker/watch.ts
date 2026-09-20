/**
 * Follow a run while it is happening.
 *
 * Discord says which phase a run is in and the dashboard shows each phase once
 * it has written a verdict, but neither shows the inside of a phase in flight
 * — and a fix phase can be forty minutes long. The transcript exists the whole
 * time; it is simply somewhere nobody would think to look.
 *
 * Two details make this work. The artifact copy of a session is written when a
 * phase *ends*, so a live phase must be read from Claude's own project
 * directory instead. And a phase boundary shows up as a new file rather than
 * more lines, so this re-checks which file is newest rather than following one
 * handle to the end of a phase and then going quiet.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bold, cyan, dim, info, warn, yellow } from "../core/log.js";

/** Claude names a project directory after its working directory, punctuation flattened. */
function projectDir(worktreePath: string): string {
  return join(homedir(), ".claude", "projects", worktreePath.replace(/[/.]/g, "-"));
}

function newestSession(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files[0] ? join(dir, files[0].f) : null;
}

function render(row: Record<string, unknown>): string | null {
  const message = row.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const out: string[] = [];

  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "tool_use") {
      const input = (part.input ?? {}) as Record<string, unknown>;
      // Whichever field this tool puts its subject in; a tool with none is
      // still worth a line, because the name alone says what is happening.
      const subject = [input.command, input.file_path, input.pattern, input.path, input.description]
        .find((v) => typeof v === "string" && v) as string | undefined;
      out.push(`  ${cyan(String(part.name))} ${dim((subject ?? "").replace(/\s+/g, " ").slice(0, 120))}`);
    } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      // The agent's own words are the reason to watch; keep more of them.
      for (const line of part.text.trim().split("\n").slice(0, 6)) {
        out.push(`  ${line.slice(0, 160)}`);
      }
      out.push("");
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

export async function watchRun(worktreePath: string, intervalMs = 1500): Promise<void> {
  const dir = projectDir(worktreePath);
  if (!existsSync(dir)) {
    warn(`No session directory for ${worktreePath}.`);
    warn(`Looked in ${dir} — the run may not have started, or it ran somewhere else.`);
    return;
  }

  info(`${bold("watching")} ${cyan(worktreePath)} ${dim("— ctrl-c to stop")}\n`);

  let current: string | null = null;
  let offset = 0;

  for (;;) {
    const newest = newestSession(dir);
    if (newest && newest !== current) {
      // A new file is a new phase. Start at its end when we already had one,
      // so switching does not replay a megabyte of history at the reader.
      // The live file is named by session id, not by phase — the phase name is
      // only applied when the artifact copy is written. The id is the more
      // useful of the two anyway, because it is what resumes the session.
      const id = newest.split("/").pop()!.replace(".jsonl", "");
      info(`${yellow("── new phase")} ${dim(`claude --resume ${id}`)}`);
      offset = current === null ? 0 : statSync(newest).size;
      current = newest;
      if (offset > 0) info(dim("   (joined in progress)\n"));
    }

    if (current && existsSync(current)) {
      const size = statSync(current).size;
      if (size > offset) {
        const chunk = readFileSync(current).subarray(offset, size).toString("utf8");
        offset = size;
        // A write can land mid-line; anything after the last newline waits.
        const lines = chunk.split("\n");
        const complete = chunk.endsWith("\n") ? lines : lines.slice(0, -1);
        if (!chunk.endsWith("\n")) offset -= Buffer.byteLength(lines.at(-1) ?? "");
        for (const line of complete) {
          if (!line.trim()) continue;
          try {
            const text = render(JSON.parse(line) as Record<string, unknown>);
            if (text) console.log(text);
          } catch {
            // A partial or unexpected row is not worth ending the watch over.
          }
        }
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
