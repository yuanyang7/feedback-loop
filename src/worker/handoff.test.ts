/**
 * Two properties, both one-directional. Claiming an issue a run is working on
 * corrupts that run's worktree, so the refusal is the test that matters; and
 * leaving `fl:requested` behind means the handoff looks done and a run starts
 * anyway on the next tick, which is the failure the label ordering exists to
 * prevent.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.FEEDBACK_LOOP_HOME = mkdtempSync(join(tmpdir(), "fl-handoff-"));
const { blockingRun, releaseToHuman, slugForHandoff, HUMAN_OWNED } = await import("./handoff.js");
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
