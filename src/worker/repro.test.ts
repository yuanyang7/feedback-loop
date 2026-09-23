import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findReproDir, reuseReproInstruction } from "./evidence.js";

function run(root: string, name: string, withScript: boolean): string {
  const dir = join(root, name, "evidence", "repro");
  mkdirSync(dir, { recursive: true });
  if (withScript) writeFileSync(join(dir, "README.md"), "run seed.mts");
  return dir;
}

test("the newest triage run with scripts wins; fix runs and other issues are ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "repro-"));
  run(root, "2026-09-23T010000-issue-12-x", true);
  const newest = run(root, "2026-09-23T020000-issue-12-x", true);
  run(root, "2026-09-23T030000-issue-12-x", false); // empty: skipped
  run(root, "2026-09-23T040000-fix-issue-12-x", true);
  run(root, "2026-09-23T050000-issue-112-x", true);
  assert.equal(findReproDir(root, 12), newest);
  assert.equal(findReproDir(root, 99), null);
});

test("no scripts, no prompt text", () => {
  assert.equal(reuseReproInstruction(null), "");
});
