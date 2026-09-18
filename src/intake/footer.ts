/**
 * The link from a GitHub issue back to the chat messages that produced it,
 * stored inside the issue body so reconcile needs no database of its own.
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

export function encodeFooter(link: SourceLink): string {
  return `<!-- ${MARKER} ${JSON.stringify(link)} -->`;
}

export function decodeFooter(body: string | null | undefined): SourceLink | null {
  if (!body) return null;
  const match = PATTERN.exec(body);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as SourceLink;
    return Array.isArray(parsed.messages) && parsed.messages.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}
