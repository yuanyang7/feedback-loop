/**
 * The link from a GitHub issue back to where it came from, stored inside the
 * issue body so reconcile needs no database of its own.
 *
 * Two shapes share the one marker. An issue intake filed carries the chat
 * message ids reconcile reacts on; an issue `report` filed carries only a
 * `source` ("cli", "hub", "agentdeck", …), because there is no message to
 * react on. `decodeFooter` returns the first kind only, so every caller that
 * reacts in chat skips the second without a special case.
 */

const MARKER = "feedback-loop:v1";
const PATTERN = /<!--\s*feedback-loop:v1\s+(\{.*?\})\s*-->/s;

export interface SourceLink {
  guild: string;
  channel: string;
  /** Source message snowflakes, oldest first. */
  messages: string[];
  /** The message reactions go on. Absent on issues filed before this existed. */
  anchor?: string;
  /** Discord user ids of the people who reported it. */
  reportedBy: string[];
}

/** The footer on an issue filed by hand: where it came from, and nothing to react on. */
export interface ManualLink {
  /** "cli", "hub", "agentdeck", or whatever the reporter named. */
  source: string;
  /** Who filed it, when known — a username, not a chat id. */
  reportedBy: string[];
}

export function encodeFooter(link: SourceLink): string {
  return `<!-- ${MARKER} ${JSON.stringify(link)} -->`;
}

export function encodeManualFooter(link: ManualLink): string {
  return `<!-- ${MARKER} ${JSON.stringify(link)} -->`;
}

/** The chat link, or null — including for a manual footer, which has no messages. */
export function decodeFooter(body: string | null | undefined): SourceLink | null {
  const parsed = rawFooter(body);
  if (!parsed) return null;
  const link = parsed as Partial<SourceLink>;
  return Array.isArray(link.messages) && link.messages.length > 0 ? (link as SourceLink) : null;
}

/** The source named by a manual footer, or null for a chat-filed issue. */
export function decodeManualFooter(body: string | null | undefined): ManualLink | null {
  const parsed = rawFooter(body);
  if (!parsed) return null;
  const link = parsed as Partial<ManualLink> & Partial<SourceLink>;
  if (typeof link.source !== "string" || Array.isArray(link.messages)) return null;
  return { source: link.source, reportedBy: Array.isArray(link.reportedBy) ? link.reportedBy : [] };
}

function rawFooter(body: string | null | undefined): Record<string, unknown> | null {
  if (!body) return null;
  const match = PATTERN.exec(body);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
