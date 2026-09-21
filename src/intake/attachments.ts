/**
 * What the reporter attached, kept where an agent can open it.
 *
 * A screenshot is usually the most informative thing in a bug report, and it
 * reached the issue as the string "[attachment: IMG_0354.png]" — a filename,
 * not a file. #1237 was a claim that a remixed app showed the wrong person's
 * avatar, which a screenshot settles at a glance; triage spent thirty turns and
 * $1.53 concluding it could not reproduce the report, saying in as many words
 * that it could not view the attached image.
 *
 * Discord's CDN links are signed and expire within about a day, so this has to
 * happen at intake rather than when a run eventually starts.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import { stateDir } from "../core/state.js";
import type { DiscordMessage } from "./discord.js";

/** Big enough for a phone screenshot, small enough that nothing else gets in. */
const MAX_BYTES = 20 * 1024 * 1024;
const READABLE = /\.(png|jpe?g|gif|webp|heic|txt|log|json|csv|md)$/i;

export function attachmentDir(target: string, issue: number): string {
  return join(stateDir(target), "attachments", String(issue));
}

/** Paths of everything already saved for an issue, newest run or not. */
export function savedAttachments(target: string, issue: number): string[] {
  const dir = attachmentDir(target, issue);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((f) => join(dir, f));
}

/**
 * Download every attachment on these messages. Returns what landed.
 *
 * A failure here is reported and dropped: an image that would not download is
 * a worse report, not a reason to lose the issue it belongs to.
 */
export async function saveAttachments(
  target: string,
  issue: number,
  messages: DiscordMessage[],
  onError?: (message: string) => void,
): Promise<string[]> {
  const wanted = messages.flatMap((m) => m.attachments ?? []).filter((a) => READABLE.test(a.filename));
  if (wanted.length === 0) return [];

  const dir = attachmentDir(target, issue);
  mkdirSync(dir, { recursive: true });
  const saved: string[] = [];

  for (const attachment of wanted) {
    // basename, because the filename comes from a stranger and this is a path.
    const name = basename(attachment.filename).replace(/[^\w.\-]/g, "_");
    const path = join(dir, name);
    try {
      const response = await fetch(attachment.url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) throw new Error(`${(declared / 1e6).toFixed(1)}MB is over the limit`);
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path));
      saved.push(path);
    } catch (error) {
      onError?.(`could not save ${attachment.filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return saved;
}

/** The lines a worker prompt needs to know these exist. Empty when they do not. */
export function attachmentInstruction(paths: string[]): string {
  if (paths.length === 0) return "";
  return [
    "",
    "## What the reporter attached",
    "",
    "These came with the report and are on disk. **Read them before deciding you cannot reproduce**",
    "— a screenshot often settles in one look what the text left ambiguous.",
    "",
    ...paths.map((p) => `- \`${p}\``),
  ].join("\n");
}
