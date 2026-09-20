/**
 * The queue is the one piece the split cannot get wrong quietly: if a request
 * loses its verb, an explicit `triage` silently becomes a `go` and spends ten
 * times as much; if it loses its message id, the run posts a second Discord
 * message instead of editing the one the person is watching. Both failures
 * look like success from the host that wrote the request.
 *
 * So these cover the round trip rather than the encoding — a stub stands in
 * for GitHub, holding labels and comments the way the real one does.
 */
import { deepStrictEqual } from "node:assert/strict";
import test from "node:test";
import type { Config } from "../core/config.js";
import type { GitHubClient } from "../intake/github.js";
import { dropRequest, enqueueRequest, readQueue } from "./queue.js";

const config = {
  github: { labels: { requested: "fl:requested" } },
  discord: { channelId: "CHAN" },
} as unknown as Config;

function stub(issues: number[]): GitHubClient {
  const labels = new Map(issues.map((n) => [n, new Set<string>()]));
  const comments = new Map<number, Array<{ body: string; createdAt: string }>>();
  return {
    listIssues: async ({ labels: want = [] }: { labels?: string[] }) =>
      [...labels]
        .filter(([, has]) => want.every((l) => has.has(l)))
        .map(([number]) => ({ number, labels: [] })),
    getIssue: async (n: number) => ({
      number: n,
      labels: [...(labels.get(n) ?? [])].map((name) => ({ name })),
    }),
    issueComments: async (n: number) => comments.get(n) ?? [],
    commentOnIssue: async (n: number, body: string) => {
      comments.set(n, [...(comments.get(n) ?? []), { body, createdAt: new Date().toISOString() }]);
    },
    addLabels: async (n: number, add: string[]) => add.forEach((l) => labels.get(n)?.add(l)),
    removeLabels: async (n: number, drop: string[]) => drop.forEach((l) => labels.get(n)?.delete(l)),
    _comments: comments,
  } as unknown as GitHubClient;
}

test("a request round-trips its verb, channel and message id", async () => {
  const gh = stub([10, 11]);
  deepStrictEqual(await readQueue(gh, config), []);

  const first = await enqueueRequest(gh, config, {
    issue: 11, kind: "go", channel: "C1", message: "M1", by: "yy",
  });
  deepStrictEqual(first, { position: 1, alreadyQueued: false });

  // Distinct timestamps, or the tie-break by issue number decides the order
  // and the thing under test does not.
  await new Promise((r) => setTimeout(r, 5));
  const second = await enqueueRequest(gh, config, {
    issue: 10, kind: "triage", channel: "C2", message: null, by: "wk",
  });
  deepStrictEqual(second, { position: 2, alreadyQueued: false });

  deepStrictEqual(
    (await readQueue(gh, config)).map((r) => [r.issue, r.kind, r.channel, r.message, r.by]),
    [[11, "go", "C1", "M1", "yy"], [10, "triage", "C2", null, "wk"]],
  );
});

test("asking twice reports the place in line rather than queueing it twice", async () => {
  const gh = stub([11]);
  await enqueueRequest(gh, config, { issue: 11, kind: "go", channel: "C1", message: "M1", by: "yy" });
  deepStrictEqual(
    await enqueueRequest(gh, config, { issue: 11, kind: "fix", channel: "C9", message: "X", by: "yy" }),
    { position: 1, alreadyQueued: true },
  );
  deepStrictEqual((await readQueue(gh, config)).length, 1);
});

test("a label applied by hand is a queued go, not an empty queue", async () => {
  // The label is what membership means. Someone labelling an issue in the
  // browser, or editing the comment away, must not produce silence.
  const gh = stub([12]);
  await gh.addLabels(12, ["fl:requested"]);
  deepStrictEqual(
    (await readQueue(gh, config)).map((r) => [r.issue, r.kind, r.by]),
    [[12, "go", "label"]],
  );
});

test("dropping takes the label off and leaves the record", async () => {
  const gh = stub([11]);
  await enqueueRequest(gh, config, { issue: 11, kind: "go", channel: "C1", message: "M1", by: "yy" });
  await dropRequest(gh, config, 11);
  deepStrictEqual(await readQueue(gh, config), []);
  // Two comments: the ask, and the drain that ends it. Neither is deleted —
  // together they are the record of what was asked for and when it started.
  deepStrictEqual((gh as unknown as { _comments: Map<number, unknown[]> })._comments.get(11)?.length, 2);
});

test("a drained request is not adopted again when the label comes back", async () => {
  // The comment holding a request is never deleted, so months later it still
  // names a Discord message that by then says "done, PR #1400". Re-applying
  // the label must not resurrect it and edit that message back to "starting".
  const gh = stub([11]);
  await enqueueRequest(gh, config, { issue: 11, kind: "triage", channel: "C1", message: "M1", by: "yy" });
  await dropRequest(gh, config, 11);

  await gh.addLabels(11, ["fl:requested"]);
  deepStrictEqual(
    (await readQueue(gh, config)).map((r) => [r.issue, r.kind, r.message, r.by]),
    [[11, "go", null, "label"]],
  );
});

test("a display name cannot break out of the marker", async () => {
  // `by` is the one field a stranger controls. A `-->` in it would close the
  // comment early, the decode would fail, and an explicit `triage` would
  // silently become a far more expensive `go`.
  const gh = stub([11]);
  await enqueueRequest(gh, config, {
    issue: 11, kind: "triage", channel: "C1", message: "M1", by: 'ev--><!--il "}{',
  });
  const [request] = await readQueue(gh, config);
  deepStrictEqual(request?.kind, "triage");
  deepStrictEqual(request?.message, "M1");
  deepStrictEqual(request?.by.includes("-->"), false);
});

test("a bare label waits behind asks a person actually made", async () => {
  const gh = stub([10, 11]);
  await enqueueRequest(gh, config, { issue: 10, kind: "go", channel: "C1", message: null, by: "yy" });
  await gh.addLabels(11, ["fl:requested"]);
  deepStrictEqual((await readQueue(gh, config)).map((r) => r.issue), [10, 11]);
});
