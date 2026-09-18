import type { DiscordClient } from "./discord.js";

/**
 * One reaction per source message, mirroring where the report got to.
 * All chosen without a variation selector so the Discord API round-trips them.
 */
export const STATE_EMOJI = {
  logged: "📝",
  duplicate: "🔁",
  unclear: "❓",
  working: "🔧",
  prReady: "✅",
  needsDecision: "🤔",
  merged: "🚢",
  dropped: "❌",
} as const;

export type State = keyof typeof STATE_EMOJI;

const ALL = Object.values(STATE_EMOJI);

/** Set the single state reaction, clearing any previous one. */
export async function setState(
  discord: DiscordClient,
  channelId: string,
  messageId: string,
  state: State,
): Promise<void> {
  const want = STATE_EMOJI[state];
  await discord.addReaction(channelId, messageId, want);
  for (const emoji of ALL) {
    if (emoji !== want) await discord.removeOwnReaction(channelId, messageId, emoji);
  }
}
