/**
 * Two properties, both one-directional. Claiming an issue a run is working on
 * corrupts that run's worktree, so the refusal is the test that matters; and
 * leaving `fl:requested` behind means the handoff looks done and a run starts
 * anyway on the next tick, which is the failure the label ordering exists to
 * prevent.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.FEEDBACK_LOOP_HOME = mkdtempSync(join(tmpdir(), "fl-handoff-"));
const { blockingRun, releaseToHuman, slugForHandoff, writeBriefing, HUMAN_OWNED } = await import("./handoff.js");
const { heldBack } = await import("./pickup.js");
const { parseCommand } = await import("../intake/commands.js");
import type { Config } from "../core/config.js";
import type { GitHubClient, Issue } from "../intake/github.js";

const config = {
  target: { name: "t", repo: "o/r", baseBranch: "dev" },
  github: { labels: { agentReady: "agent-ready", requested: "fl:requested" } },
} as unknown as Config;

function issueWith(labels: string[]): Issue {
  return {
    number: 7,
    title: "[feedback] iOS: avatar is wrong",
    body: "",
    state: "OPEN",
    url: "https://example.invalid/7",
    labels: labels.map((name) => ({ name })),
  };
}

function stub(issue: Issue): { gh: GitHubClient; added: string[]; removed: string[]; comments: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const comments: string[] = [];
  const gh = {
    getIssue: async () => issue,
    addLabels: async (_n: number, l: string[]) => void added.push(...l),
    removeLabels: async (_n: number, l: string[]) => void removed.push(...l),
    commentOnIssue: async (_n: number, body: string) => void comments.push(body),
  } as unknown as GitHubClient;
  return { gh, added, removed, comments };
}

test("a queued request is drained, not just un-cleared", async () => {
  const issue = issueWith(["agent-ready", "fl:requested"]);
  const { gh, added, removed, comments } = stub(issue);
  await releaseToHuman(gh, config, issue, false);

  strictEqual(added.includes(HUMAN_OWNED), true);
  // Both, and in this order: the queue is read from `fl:requested` alone, so
  // dropping only `agent-ready` would leave the ask live.
  deepStrictEqual(removed, ["agent-ready", "fl:requested"]);
  strictEqual(comments.some((c) => c.includes("Dequeued")), true);
});

test("the claim is applied before the clearance is removed", async () => {
  const issue = issueWith(["agent-ready"]);
  const order: string[] = [];
  const gh = {
    addLabels: async (_n: number, l: string[]) => void order.push(`+${l.join(",")}`),
    removeLabels: async (_n: number, l: string[]) => void order.push(`-${l.join(",")}`),
  } as unknown as GitHubClient;
  await releaseToHuman(gh, config, issue, false);
  // Reversed, an intake tick landing between the two sees an eligible,
  // unclaimed issue and promotes it.
  deepStrictEqual(order, [`+${HUMAN_OWNED}`, "-agent-ready"]);
});

test("a dry run changes nothing", async () => {
  const issue = issueWith(["agent-ready", "fl:requested", "in-progress"]);
  const { gh, added, removed, comments } = stub(issue);
  await releaseToHuman(gh, config, issue, true);
  deepStrictEqual([added, removed, comments], [[], [], []]);
});

test("an issue with a live run on it is refused", () => {
  const dir = join(process.env.FEEDBACK_LOOP_HOME!, "t");
  mkdirSync(dir, { recursive: true });
  // process.pid is, by construction, alive.
  writeFileSync(
    join(dir, "worker.lock"),
    JSON.stringify([{ pid: process.pid, what: "go #7", at: new Date().toISOString(), issue: 7 }]),
  );
  strictEqual(blockingRun("t", 7)?.pid, process.pid);
  strictEqual(blockingRun("t", 8), null);
});

test("a lock written before per-issue tracking still blocks", () => {
  const dir = join(process.env.FEEDBACK_LOOP_HOME!, "old");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "worker.lock"),
    JSON.stringify([{ pid: process.pid, what: "fix #9", at: new Date().toISOString() }]),
  );
  strictEqual(blockingRun("old", 9)?.pid, process.pid);
});

test("a person's worktree does not land in the namespace `watch` searches", () => {
  const slug = slugForHandoff(7, "[feedback] iOS: avatar is wrong");
  strictEqual(slug.startsWith("issue-7"), false);
  strictEqual(slug, "manual-7-ios-avatar-is-wrong");
});

test("the briefing carries what an earlier run found, not just a link", () => {
  const target = "briefed";
  const runs = join(process.env.FEEDBACK_LOOP_HOME!, target, "runs", "2026-01-01T000000-issue-7-avatar");
  mkdirSync(join(runs, "evidence"), { recursive: true });
  writeFileSync(
    join(runs, "triage.verdict.json"),
    JSON.stringify({ reproduced: true, evidenceKind: "proven-by-code", evidence: "messages.en.ts:506 still says VIBE//PLAT" }),
  );
  writeFileSync(join(runs, "evidence", "before.png"), "");

  const worktree = { path: mkdtempSync(join(tmpdir(), "fl-wt-")), branch: "fix/manual-7", slug: "manual-7" };
  const path = writeBriefing(target, worktree, issueWith([]));
  const text = readFileSync(path, "utf8");

  // The verdict is inlined: a fresh session that only got a path would have
  // to guess that reading it was worth doing.
  strictEqual(text.includes("messages.en.ts:506 still says VIBE//PLAT"), true);
  strictEqual(text.includes("proven-by-code"), true);
  strictEqual(text.includes(join(runs, "evidence")), true);
  // The trap that costs real data if a handed-off session misses it.
  strictEqual(text.includes("npm run lab -- setup --yes"), true);
  strictEqual(text.toLowerCase().includes("production"), true);
});

test("a briefing is still written when no run has touched the issue", () => {
  const worktree = { path: mkdtempSync(join(tmpdir(), "fl-wt-")), branch: "fix/manual-7", slug: "manual-7" };
  const path = writeBriefing("never-run", worktree, issueWith([]));
  strictEqual(readFileSync(path, "utf8").includes("no run has touched this issue"), true);
});

test("a handed-off issue is held out of every queue, not just the ones that start runs", () => {
  // `heldBack` is what `nextIssue`, `promoteAutoWork` and the queue display all
  // agree on. Missing here, a handed-off issue gets enqueued and then held by
  // `nextRequest` forever — which wedges promotion for every issue behind it.
  strictEqual(heldBack(issueWith([HUMAN_OWNED, "agent-ready"])), HUMAN_OWNED);
  strictEqual(heldBack(issueWith(["agent-ready"])), null);
});

test("mine and back need an exact issue number, because a mention may not be required", () => {
  const message = (content: string) => ({
    content,
    mentions: [{ id: "bot" }],
    author: { id: "u", username: "u" },
  }) as never;
  deepStrictEqual(parseCommand(message("<@bot> mine 1207"), ["bot"]), { kind: "mine", issue: 1207 });
  deepStrictEqual(parseCommand(message("<@bot> back #1207"), ["bot"]), { kind: "back", issue: 1207 });
  // A verb with no issue number is not a command, it is someone talking.
  strictEqual(parseCommand(message("<@bot> mine"), ["bot"]), null);
  // In the report channel a mention is still what marks an instruction.
  strictEqual(parseCommand({ content: "mine 1207", mentions: [], author: { id: "u" } } as never, ["bot"]), null);

  // In a command channel `requireMention` is false, so these two words carry
  // no marker at all — an ordinary sentence must not release someone's claim.
  const bare = (content: string) =>
    parseCommand({ content, mentions: [], author: { id: "u" } } as never, ["bot"], { requireMention: false });
  strictEqual(bare("back 2 commits and it still repros"), null);
  strictEqual(bare("mine 1207 looks like the same bug"), null);
  deepStrictEqual(bare("back 1207"), { kind: "back", issue: 1207 });

  // The older verbs keep taking the first token: they are not English words,
  // so a trailing sentence after the number is a comment, not an ambiguity.
  deepStrictEqual(bare("go 1207 please"), { kind: "go", issue: 1207 });
});
