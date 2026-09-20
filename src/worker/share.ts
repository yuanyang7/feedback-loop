/**
 * Putting the evidence where it can actually be looked at.
 *
 * A run's screenshots live under ~/.feedback-loop, which is reachable from the
 * machine that produced them and nowhere else. The pull request references the
 * path, which is no use on a phone — and embedding them in the pull request is
 * not an option either: this is a private repo, so an image link needs a
 * logged-in session and will not render inline.
 *
 * So they go to Discord, which hosts them and is already open on the phone that
 * got the notification.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSecret, type LoadedConfig } from "../core/config.js";
import { dim, info } from "../core/log.js";
import { DiscordClient } from "../intake/discord.js";
import { evidenceDir, listEvidence } from "./evidence.js";
import { pairEvidence } from "../dashboard/scan.js";

/** Discord takes ten per message; a before/after pair is two. */
const MAX_FILES = 10;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Attaches to the run's own message when there is one, rather than adding a
 * second. Posting separately would undo the reason that message exists: a
 * twenty-minute job should leave one line in a channel meant for bug reports,
 * and evidence is part of the result, not an announcement of its own.
 */
export async function shareEvidence(
  loaded: LoadedConfig,
  channelId: string | undefined,
  runMessageId: string | undefined,
  artifactDir: string,
  /**
   * The message's full text, not a caption. Editing replaces content, so this
   * has to repeat what announce just wrote or the run's result is overwritten
   * by a note about its attachments.
   */
  text: string,
): Promise<void> {
  if (!channelId) return;

  const dir = evidenceDir(artifactDir);
  // Not only images: #1215 captured no screenshots at all — the surface was
  // iOS and could not be driven — and its logs were the whole argument.
  const all = listEvidence(dir);
  const images = all.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
  const logs = all.filter((f) => /\.(txt|log|diff|patch|json)$/i.test(f));
  if (images.length === 0 && logs.length === 0) return;

  // Complete before/after pairs first and kept adjacent — the comparison is the
  // whole argument, and a lone "after" says much less than the two together.
  const ordered = [
    ...pairEvidence(images).flatMap((p) => [p.before, p.after, p.single].filter(Boolean) as string[]),
    ...logs,
  ];

  const files: Array<{ name: string; bytes: Buffer }> = [];
  let total = 0;
  for (const name of ordered) {
    if (files.length >= MAX_FILES) break;
    const path = join(dir, name);
    const size = statSync(path).size;
    if (total + size > MAX_BYTES) break;
    files.push({ name, bytes: readFileSync(path) });
    total += size;
  }
  if (files.length === 0) return;

  const omitted = ordered.length - files.length;
  const note = omitted > 0 ? `\n<sub>${omitted} more in \`${dir}\`</sub>` : "";

  const discord = new DiscordClient(readSecret(loaded.config.discord.tokenFile, "DISCORD_BOT_TOKEN"));
  const sent = await discord
    .sendFiles(channelId, `${text}${note}`, files, undefined, runMessageId)
    .catch(() => null);
  info(`  ${dim(sent ? `shared ${files.length} evidence file(s)` : "could not share evidence")}`);
}
