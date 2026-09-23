import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionComment, readDecisions, withDecisions } from "./decisions.js";
import type { GitHubClient } from "../intake/github.js";

const fake = (bodies: string[]): GitHubClient =>
  ({ issueComments: async () => bodies.map((body) => ({ body, createdAt: "" })) }) as unknown as GitHubClient;

test("only marked comments come back, oldest first, without the marker", async () => {
  const github = fake(["Triage: could not reproduce", decisionComment("iOS only"), "lgtm", decisionComment(" skip web \n")]);
  assert.deepEqual(await readDecisions(github, 1), ["iOS only", "skip web"]);
});

test("a prompt with no decisions is left alone", () => {
  assert.equal(withDecisions("P", []), "P");
});

test("decisions are appended in order", () => {
  const out = withDecisions("P", ["a", "b"]);
  assert.ok(out.startsWith("P\n"));
  assert.ok(out.indexOf('<decision n="1">\na') < out.indexOf('<decision n="2">\nb'));
});
