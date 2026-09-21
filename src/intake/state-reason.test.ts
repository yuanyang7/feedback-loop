import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// deriveState is private, so this pins the one comparison that was wrong rather
// than reaching into the module: the bug was a literal, and a literal is what
// has to stay correct.
const SOURCE = readFileSync(new URL("./reconcile.ts", import.meta.url), "utf8");

test("stateReason is compared case-insensitively", () => {
  assert.match(SOURCE, /stateReason\?\.toLowerCase\(\) === "not_planned"/);
  assert.doesNotMatch(SOURCE, /stateReason === "not_planned"/);
});

test("GraphQL's NOT_PLANNED would resolve to dropped", () => {
  const derive = (reason: string | null) =>
    reason?.toLowerCase() === "not_planned" ? "dropped" : "merged";
  assert.equal(derive("NOT_PLANNED"), "dropped");
  assert.equal(derive("not_planned"), "dropped");
  assert.equal(derive("COMPLETED"), "merged");
  assert.equal(derive(null), "merged");
});
