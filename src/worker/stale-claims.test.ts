/**
 * The safety property here is one-directional: failing to clear a stale claim
 * leaves the loop quietly stuck, but clearing a live one pulls an issue out
 * from under a running fix. So the test that matters is the negative one.
 */
import { deepStrictEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.FEEDBACK_LOOP_HOME = mkdtempSync(join(tmpdir(), "fl-claims-"));
const { clearStaleClaims } = await import("./pickup.js");
import type { Config } from "../core/config.js";
import type { GitHubClient } from "../intake/github.js";

const config = { github: { labels: {} } } as unknown as Config;

function withLock(target: string, locks: Array<{ pid: number; issue: number }>): void {
  const dir = join(process.env.FEEDBACK_LOOP_HOME!, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "worker.lock"),
    JSON.stringify(locks.map((l) => ({ ...l, what: `go #${l.issue}`, at: new Date().toISOString() }))),
  );
}

function stub(inProgress: number[]): { gh: GitHubClient; cleared: number[] } {
  const cleared: number[] = [];
  const gh = {
    listIssues: async () => inProgress.map((number) => ({ number, labels: [{ name: "in-progress" }] })),
    removeLabels: async (n: number) => void cleared.push(n),
  } as unknown as GitHubClient;
  return { gh, cleared };
}

test("a claim with a live process behind it is left alone", async () => {
  // process.pid is, by construction, alive.
  withLock("live", [{ pid: process.pid, issue: 1225 }]);
  const { gh, cleared } = stub([1225]);
  await clearStaleClaims(gh, config, "live", false);
  deepStrictEqual(cleared, []);
});

test("a claim whose run died is cleared", async () => {
  // No lock file at all: the host rebooted and the run is gone.
  const { gh, cleared } = stub([1225, 1210]);
  await clearStaleClaims(gh, config, "dead", false);
  deepStrictEqual(cleared, [1225, 1210]);
});

test("a live run does not shield the others", async () => {
  withLock("mixed", [{ pid: process.pid, issue: 1225 }]);
  const { gh, cleared } = stub([1225, 1210]);
  await clearStaleClaims(gh, config, "mixed", false);
  deepStrictEqual(cleared, [1210]);
});

test("dry-run clears nothing", async () => {
  const { gh, cleared } = stub([1225]);
  await clearStaleClaims(gh, config, "dry", true);
  deepStrictEqual(cleared, []);
});
