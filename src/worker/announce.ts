/**
 * A run started from chat reports into a single message, editing it as it goes.
 *
 * Posting per phase turned one twenty-minute job into four lines in a channel
 * whose purpose is to hold bug reports. The run owns one message and rewrites
 * it; the history people scroll is the reports, not the machinery.
 */
import { readSecret, type LoadedConfig } from "../core/config.js";
import { DiscordClient } from "../intake/discord.js";
import { releaseRun } from "../intake/commands.js";

export interface Announcer {
  /** Replace what the run's message says. */
  update(text: string): Promise<void>;
  /** Final state, and release the run's lock. */
  finish(text: string): Promise<void>;
}

export function announcer(
  loaded: LoadedConfig,
  channelId: string | undefined,
  messageId: string | undefined,
): Announcer {
  const write = async (text: string): Promise<void> => {
    if (!channelId) return;
    const discord = new DiscordClient(
      readSecret(loaded.config.discord.tokenFile, "DISCORD_BOT_TOKEN"),
    );
    // Without a message to edit — a run started from a terminal — say it once
    // rather than staying silent.
    if (messageId) await discord.editMessage(channelId, messageId, text);
    else await discord.sendMessage(channelId, text).catch(() => undefined);
  };

  return {
    update: write,
    finish: async (text: string): Promise<void> => {
      releaseRun(loaded.config.target.name);
      await write(text);
    },
  };
}

/** One-shot form for callers that report once and are done. */
export async function announce(
  loaded: LoadedConfig,
  channelId: string | undefined,
  text: string,
  messageId?: string,
): Promise<void> {
  await announcer(loaded, channelId, messageId).finish(text);
}

/**
 * One sentence of an agent's reasoning, for a chat line that has to stay short.
 *
 * Breaks on a word so a truncated line reads as truncated rather than as a
 * typo — the first version of this cut "onto its launch card" to "onto its l"
 * and the reader's question became what the message meant, not what it said.
 */
export function firstSentence(text: string | undefined, limit = 240): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  const end = trimmed.search(/(?<=[.!?])\s/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end);
  if (sentence.length <= limit) return sentence;
  const cut = sentence.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, "")}…`;
}
