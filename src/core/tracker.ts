/**
 * What we have told people about each issue, and where we told them.
 *
 * The issue body's footer already records which chat messages produced an
 * issue, and that stays the durable source of truth — it survives this file
 * being deleted. What it cannot record is the other direction: the messages the
 * bot itself posted about that issue. Those are ours, not the issue's, and
 * without a record of them a run's "stopped, needs you" sits in the channel
 * hours after the work shipped, because nothing knows the message exists.
 *
 * So this is not a cache of GitHub. Desired state is still derived from GitHub
 * every time; this holds what was last announced and which messages said it, so
 * reconcile can tell whether anything needs rewriting rather than rewriting
 * unconditionally.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./state.js";

export interface IssueStatus {
  issue: number;
  /** The last state we announced. Compared against what GitHub says now. */
  state: string;
  channel: string;
  /** The reporter's message — where the reaction goes. */
  anchor: string;
  /** Messages the bot posted about this issue, rewritten when state changes. */
  botMessages: string[];
  /** Filled in once a run opens one, so a stale message can link it. */
  prUrl?: string;
  title?: string;
  updatedAt: string;
}

type Table = Record<string, IssueStatus>;

function path(target: string): string {
  return join(stateDir(target), "status.json");
}

export function readStatuses(target: string): Table {
  const file = path(target);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Table;
  } catch {
    return {};
  }
}

export function readStatus(target: string, issue: number): IssueStatus | null {
  return readStatuses(target)[String(issue)] ?? null;
}

/**
 * Merge into the record for one issue. Callers each know one part — intake
 * knows the anchor, a run knows its own message, reconcile knows the state — so
 * writing whole records would mean each of them clobbering what the others knew.
 */
export function recordStatus(
  target: string,
  issue: number,
  patch: Partial<Omit<IssueStatus, "issue" | "updatedAt">> & { botMessage?: string },
): IssueStatus {
  const table = readStatuses(target);
  const key = String(issue);
  const previous = table[key];

  const { botMessage, ...rest } = patch;
  const botMessages = [...new Set([...(previous?.botMessages ?? []), ...(rest.botMessages ?? []), ...(botMessage ? [botMessage] : [])])];

  const next: IssueStatus = {
    issue,
    state: rest.state ?? previous?.state ?? "unknown",
    channel: rest.channel ?? previous?.channel ?? "",
    anchor: rest.anchor ?? previous?.anchor ?? "",
    botMessages,
    ...(rest.prUrl ?? previous?.prUrl ? { prUrl: rest.prUrl ?? previous?.prUrl } : {}),
    ...(rest.title ?? previous?.title ? { title: rest.title ?? previous?.title } : {}),
    updatedAt: new Date().toISOString(),
  };

  const file = path(target);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...table, [key]: next }, null, 2)}\n`);
  return next;
}

/**
 * Issues other than this one that also point at a given bot message. A message
 * covering several issues must not be rewritten from the perspective of one of
 * them — doing that once turned "filed as two issues, #1220 and #1221" into a
 * sentence about #1220 alone, and #1221 vanished from the channel.
 */
export function otherOwners(target: string, issue: number, message: string): number[] {
  return Object.values(readStatuses(target))
    .filter((s) => s.issue !== issue && s.botMessages.includes(message))
    .map((s) => s.issue);
}

/** Issues whose announced state no longer matches what GitHub says. */
export function staleIssues(target: string, current: Map<number, string>): IssueStatus[] {
  return Object.values(readStatuses(target)).filter((s) => {
    const now = current.get(s.issue);
    return now !== undefined && now !== s.state;
  });
}
