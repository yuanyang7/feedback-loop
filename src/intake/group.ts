import type { DiscordMessage } from "./discord.js";

export interface Report {
  messages: DiscordMessage[];
  authorId: string;
  authorName: string;
  /** True when the message explicitly addressed the bot — skips the confidence floor. */
  directed: boolean;
}

/**
 * Consecutive messages from one author inside `windowSeconds` are one report.
 * People split a bug across three lines; three issues would be wrong.
 */
export function groupMessages(
  messages: DiscordMessage[],
  opts: { windowSeconds: number; ignoreAuthorIds: string[]; mentionTriggerIds: string[] },
): Report[] {
  const ignore = new Set(opts.ignoreAuthorIds);
  const triggers = new Set(opts.mentionTriggerIds);
  const reports: Report[] = [];

  for (const message of messages) {
    if (ignore.has(message.author.id)) continue;
    if (!hasContent(message)) continue;

    const directed = (message.mentions ?? []).some((m) => triggers.has(m.id));
    const last = reports.at(-1);
    const withinWindow =
      last !== undefined &&
      last.authorId === message.author.id &&
      Date.parse(message.timestamp) - Date.parse(last.messages.at(-1)!.timestamp) <=
        opts.windowSeconds * 1000;

    if (withinWindow) {
      last.messages.push(message);
      last.directed ||= directed;
    } else {
      reports.push({
        messages: [message],
        authorId: message.author.id,
        authorName: message.author.username,
        directed,
      });
    }
  }
  return reports;
}

/**
 * A forwarded message carries empty content, so judging emptiness by `content`
 * alone silently drops exactly the messages someone took the trouble to forward.
 */
function hasContent(message: DiscordMessage): boolean {
  return Boolean(
    message.content.trim() ||
      (message.attachments ?? []).length > 0 ||
      (message.embeds ?? []).length > 0 ||
      (message.message_snapshots ?? []).length > 0,
  );
}

/** Render a report as inert data for the classifier. Never used as instructions. */
export function renderReport(report: Report): string {
  return report.messages
    .map((m) => {
      const quoted = m.referenced_message
        ? `(replying to ${m.referenced_message.author.username}: ${truncate(m.referenced_message.content, 200)})\n`
        : "";
      const files = (m.attachments ?? []).map((a) => `[attachment: ${a.filename}]`).join(" ");

      // Forwarded text is the message, not an annotation on it — "link these"
      // means nothing without the thing being pointed at.
      const forwarded = (m.message_snapshots ?? [])
        .map((snapshot) => {
          const inner = snapshot.message;
          const body = [
            inner?.content?.trim(),
            ...(inner?.embeds ?? []).map(renderEmbed),
            ...(inner?.attachments ?? []).map((a) => `[attachment: ${a.filename}]`),
          ]
            .filter(Boolean)
            .join("\n");
          return body ? `[forwarded message]\n${body}` : "";
        })
        .filter(Boolean)
        .join("\n");

      const embeds = (m.embeds ?? []).map(renderEmbed).filter(Boolean).join("\n");

      return [quoted + m.content, forwarded, embeds, files].filter((part) => part.trim()).join("\n").trim();
    })
    .join("\n");
}

function renderEmbed(embed: { title?: string; description?: string; url?: string }): string {
  return [embed.title, embed.url, embed.description && truncate(embed.description, 300)]
    .filter(Boolean)
    .join(" — ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
