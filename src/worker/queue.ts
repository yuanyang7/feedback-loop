/**
 * The run queue — work a person asked for that no host has started yet.
 *
 * The queue shown by `queue` is derived from GitHub labels, which is right for
 * work nobody has spoken for: it stays true as labels change and needs no
 * bookkeeping. What labels alone cannot represent is the one thing that is not
 * a property of the issue — that a human typed `go 1221` at it, from a
 * particular channel, in a message the run is expected to edit as it goes.
 *
 * This used to be a local JSON file, which worked while one machine did
 * everything. It cannot survive the split: the host that accepts the command
 * is no longer the host that runs it. Of the ways two machines could share a
 * queue, a label on the issue is the only one that does not invent a new
 * failure mode —
 *
 *   - a network mount drops whenever the worker host sleeps or leaves the LAN,
 *     which is precisely the condition the split exists to survive, and file
 *     locking over SMB is not something to bet a work queue on;
 *   - syncing the file has the same problem with worse symptoms: two writers,
 *     no ordering, silent last-write-wins;
 *   - a label is written and read over an API both hosts already use, needs no
 *     new transport or secret, survives either host being off, and a human can
 *     read the queue in a browser.
 *
 * What the label cannot carry — the verb, the channel, the message id — rides
 * in a hidden marker inside an issue comment, the same trick the source footer
 * already uses. The label is the queue; the comment is the detail. Anything
 * that loses the comment degrades to "somebody asked for this issue", which is
 * still the important half.
 *
 * Everything about whether a run may actually proceed is still decided at
 * drain time, on the host that would run it, against GitHub and the gate. An
 * hour in a queue is long enough for all of it to have changed.
 */
import type { Config } from "../core/config.js";
import type { GitHubClient } from "../intake/github.js";

const MARKER = "feedback-loop:request:v1";
const PATTERN = /<!--\s*feedback-loop:request:v1\s+([\s\S]*?)-->/;

/**
 * Written when a request leaves the queue.
 *
 * Without it the record of an old ask outlives the ask. The comment carrying
 * a request is never deleted — it is the history of who asked for what — so
 * an issue that was queued, drained and finished still holds a comment naming
 * a Discord message that now reads "done, PR #1400". Re-apply the label by
 * hand months later and the next drain would find that comment, adopt its
 * verb, and edit the finished message into "starting…".
 *
 * So both markers are scanned newest-first and whichever appears first wins.
 * A request followed by a drain reads as drained; a label re-applied after
 * that is a fresh, detail-free ask, which is exactly what it is.
 */
const DRAINED = "feedback-loop:drained:v1";
const DRAINED_PATTERN = /<!--\s*feedback-loop:drained:v1\s*-->/;

export interface RunRequest {
  issue: number;
  kind: "triage" | "fix" | "go";
  /**
   * Discord channel the answer belongs in. Empty for a request made from the
   * dashboard: whoever clicked is watching the page, not the channel.
   */
  channel: string;
  /**
   * The "queued" notice. Handed to the run when it finally starts so it edits
   * that line into "running" and then "done", rather than posting a second
   * one. Null when the notice could not be posted.
   */
  message: string | null;
  /** Who asked. A record of a decision, not bookkeeping. */
  by: string;
  at: string;
}

function encode(request: RunRequest): string {
  // `by` is a Discord display name, so it is the one field a stranger
  // controls. A `-->` in it would close the comment early and leave the rest
  // of the payload as visible text; the decode would then fail and silently
  // downgrade an explicit `triage` to a `go`, which is the exact failure this
  // marker exists to prevent. Strip rather than escape: nothing downstream
  // needs those characters, and a mangled name is a cosmetic loss.
  const by = request.by.replace(/-->|<!--/g, "").replace(/[\u0000-\u001f]/g, "").slice(0, 80);
  return `<!-- ${MARKER} ${JSON.stringify({ ...request, by })} -->`;
}

function decode(body: string): RunRequest | null {
  const match = PATTERN.exec(body);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as RunRequest;
    const kind = parsed.kind;
    if (kind !== "triage" && kind !== "fix" && kind !== "go") return null;
    return Number.isInteger(parsed.issue) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The visible half of a request. Someone reading the issue should be able to
 * tell what is about to happen to it without knowing this tool exists, which
 * is also what makes a stuck queue diagnosable from a phone.
 */
function comment(request: RunRequest): string {
  const verb = { triage: "reproduce and size", fix: "fix and open a PR", go: "reproduce, fix and open a PR" }[
    request.kind
  ];
  return (
    `🕒 Queued: **${request.kind}** — ${verb}.\n\n` +
    `Asked for by ${request.by}. It starts when a worker host is next awake and has a free slot; ` +
    `the caps and the reproduce gate still apply then, so this is a place in line, not a promise.\n` +
    encode(request)
  );
}

/**
 * Everything queued, oldest ask first.
 *
 * The label is authoritative about membership and the comment only supplies
 * detail, so an issue carrying the label with no readable request is still
 * returned — as a `go` asked for by nobody in particular. Dropping it would
 * turn a hand-applied label, or a comment someone edited, into silence.
 */
export async function readQueue(github: GitHubClient, config: Config): Promise<RunRequest[]> {
  const issues = await github.listIssues({ labels: [config.github.labels.requested], state: "open" });
  const requests = await Promise.all(
    issues.map(async (issue): Promise<RunRequest> => {
      const comments = await github.issueComments(issue.number).catch(() => []);
      // Newest first: asking again after changing your mind should change the
      // ask, and a drain in between should end the previous one.
      for (const { body } of comments.slice().reverse()) {
        if (DRAINED_PATTERN.test(body)) break;
        const found = decode(body);
        if (found) return { ...found, issue: issue.number };
      }
      return { issue: issue.number, kind: "go", channel: config.discord.channelId, message: null, by: "label", at: "" };
    }),
  );
  // A request with no timestamp came from a bare label, so it has no place in
  // line to claim. Sorting blanks last keeps a hand-applied label from
  // overtaking asks that a person actually made earlier.
  return requests.sort(
    (a, b) => Number(!a.at) - Number(!b.at) || a.at.localeCompare(b.at) || a.issue - b.issue,
  );
}

/**
 * Attach detail to a request that arrived as a bare label.
 *
 * Someone labelling an issue in the browser is a real way to ask for a run,
 * and the label alone carries no verb, no channel and no message to edit. A
 * host that can post to Discord fills those in, so that by the time a worker
 * drains it the request looks like any other — and, crucially, so the message
 * the run will edit is one that `status.json` knows about.
 */
export async function recordAsk(github: GitHubClient, request: Omit<RunRequest, "at">): Promise<void> {
  await github.commentOnIssue(request.issue, comment({ ...request, at: new Date().toISOString() }));
}

/**
 * Add a request, or report where the existing one already sits. Asking twice
 * for the same issue is what a person does when they are not sure the first
 * one landed, and it should tell them rather than queue the work twice.
 */
export async function enqueueRequest(
  github: GitHubClient,
  config: Config,
  request: Omit<RunRequest, "at">,
): Promise<{ position: number; alreadyQueued: boolean }> {
  // Membership is checked against the issue itself, not the queue listing.
  // `listIssues` goes through GitHub's search index, which lags a write by
  // seconds — and asking twice in quick succession is exactly what a person
  // does when they are not sure the first one landed, so the lagging read is
  // the likely one, not the edge case.
  const current = await github.getIssue(request.issue).catch(() => null);
  const queue = await readQueue(github, config);
  if (current?.labels.some((l) => l.name === config.github.labels.requested)) {
    const at = queue.findIndex((r) => r.issue === request.issue);
    return { position: at >= 0 ? at + 1 : queue.length, alreadyQueued: true };
  }

  const full: RunRequest = { ...request, at: new Date().toISOString() };
  // Comment before label: the label is what a drain looks for, so applying it
  // last means a worker never finds a queued issue whose detail has not landed
  // yet and silently downgrades an explicit `triage` into a `go`.
  await github.commentOnIssue(request.issue, comment(full));
  await github.addLabels(request.issue, [config.github.labels.requested]);
  return { position: queue.length + 1, alreadyQueued: false };
}

/**
 * Take it out of the queue. Only the label comes off — the comment stays as
 * the record that this run was asked for, by whom, and when.
 */
export async function dropRequest(
  github: GitHubClient,
  config: Config,
  issue: number,
  note = "Dequeued.",
): Promise<void> {
  // The marker first: it is what stops the old request being adopted again,
  // and a label removed without it would leave the issue re-queueable into a
  // finished run's Discord message.
  await github.commentOnIssue(issue, `${note}\n<!-- ${DRAINED} -->`).catch(() => undefined);
  await github.removeLabels(issue, [config.github.labels.requested]);
}
