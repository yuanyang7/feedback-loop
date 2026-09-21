import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSentence } from "./announce.js";

// The real one from #1237, which the first version cut to "...onto its l".
const REAL =
  "The report is explicitly low-confidence with no repro steps, and the two server-side paths most " +
  "likely to explain 'wrong user's avatar on a remixed app' -- who owns a freshly created remix, and " +
  "how that owner's avatar is resolved onto its launch card -- are both correctly scoped per app id.";

test("a long first sentence is cut at a word boundary, not mid-word", () => {
  const out = firstSentence(REAL);
  assert.ok(out.endsWith("…"), "marks that it was cut");
  const kept = out.slice(0, -1);
  assert.ok(REAL.startsWith(kept), "is a prefix of the original");
  // The character the original continues with is whitespace: that is what
  // "did not cut mid-word" actually means.
  assert.match(REAL[kept.length]!, /\s/);
  assert.ok(out.length <= 241);
});

test("a short sentence is left alone", () => {
  assert.equal(firstSentence("Could not reproduce it."), "Could not reproduce it.");
});

test("only the first sentence is taken", () => {
  assert.equal(firstSentence("One. Two. Three."), "One.");
});

test("nothing in, nothing out", () => {
  assert.equal(firstSentence(undefined), "");
  assert.equal(firstSentence("   "), "");
});

test("a sentence with no spaces to break on still gets cut", () => {
  const out = firstSentence("x".repeat(400));
  assert.ok(out.endsWith("…") && out.length <= 241);
});
