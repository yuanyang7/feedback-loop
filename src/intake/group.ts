import type { DiscordMessage } from "./discord.js";

export interface Report {
  messages: DiscordMessage[];
  authorId: string;
  authorName: string;
  /** True when the message explicitly addressed the bot — skips the confidence floor. */
  directed: boolean;
  /**
   * The issue this message is a reply to, resolved from the tracker rather than
   * inferred from the quoted text. Filled in by intake, which is what can see
   * the tracker; grouping itself knows nothing about issues.
   */
  repliesToIssue?: number;
}

/**
 * One message, one report. No time-window grouping.
 *
 * Grouping consecutive messages from one author used to merge them, on the
 * theory that a bug often gets split across a few lines. It also merged two
 * unrelated reports sent a couple of minutes apart into a single issue that
 * could not be closed until both halves were done — and time cannot tell those
 * apart, since "one thing over three messages" and "three things in a row" look
 * identical.
 *
 * So the rule is the predictable one. The cost is the case it was built for: a
 * report split across lines now files an issue per line, and the duplicate check
 * does not catch siblings classified in the same batch because none of them is
 * an open issue yet.
 */
export function groupMessages(
  messages: DiscordMessage[],
  opts: { ignoreAuthorIds: string[]; mentionTriggerIds: string[] },
): Report[] {
  const ignore = new Set(opts.ignoreAuthorIds);
  const triggers = new Set(opts.mentionTriggerIds);

  return messages
    .filter((message) => !ignore.has(message.author.id) && hasContent(message))
    .map((message) => ({
      messages: [message],
      authorId: message.author.id,
      authorName: message.author.username,
      directed: (message.mentions ?? []).some((m) => triggers.has(m.id)),
    }));
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

/**
 * The message a reaction and a reply should land on. Not simply the first one:
 * a forward carries empty content and renders as a bare card, so reacting to
 * it looks like reacting to nothing. Prefer the first message someone actually
 * typed, and fall back to the first message when the forward is the whole
 * report.
 */
export function anchorOf(report: Report): DiscordMessage {
  return report.messages.find((m) => m.content.trim()) ?? report.messages[0]!;
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
