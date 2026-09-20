import { test } from "node:test";
import assert from "node:assert/strict";
import { heldBack } from "/Users/yangyuan/code/feedback-loop/src/worker/pickup.js";

const issue = (...labels: string[]) => ({ number: 1, labels: labels.map((name) => ({ name })) }) as never;

test("run-failed is kept out of auto pickup so a crash loop cannot form", () => {
  assert.equal(heldBack(issue("bug", "run-failed")), "run-failed");
});
test("run-failed and needs-decision stay distinguishable", () => {
  assert.equal(heldBack(issue("needs-decision")), "needs-decision");
});
test("an ordinary agent-ready issue is in line", () => {
  assert.equal(heldBack(issue("bug", "agent-ready")), null);
});
