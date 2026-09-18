/**
 * A run started from chat outlives the tick that started it, so it reports its
 * own result. Reconcile would eventually move the reaction, but someone who
 * asked for this from a phone wants a reply, not a changed emoji.
 */
import { readSecret, type LoadedConfig } from "../core/config.js";
import { DiscordClient } from "../intake/discord.js";
import { releaseRun } from "../intake/commands.js";

export async function announce(
  loaded: LoadedConfig,
  channelId: string | undefined,
  text: string,
): Promise<void> {
  releaseRun(loaded.config.target.name);
  if (!channelId) return;
  const discord = new DiscordClient(readSecret(loaded.config.discord.tokenFile, "DISCORD_BOT_TOKEN"));
  await discord.sendMessage(channelId, text).catch(() => undefined);
}
