/**
 * Reconcile, and every worker `react`, find chat messages through
 * `decodeFooter`. An issue filed by `report` has a footer with no messages in
 * it, and the property that matters is that those callers see null — not a
 * link with an empty list that then fails on a channel it never had.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import test from "node:test";
import { decodeFooter, decodeManualFooter, encodeFooter, encodeManualFooter } from "./footer.js";

test("a chat footer round-trips", () => {
  const link = { guild: "g", channel: "c", messages: ["1", "2"], anchor: "1", reportedBy: ["u"] };
  deepStrictEqual(decodeFooter(`report text\n\n${encodeFooter(link)}`), link);
  strictEqual(decodeManualFooter(encodeFooter(link)), null);
});

test("a manual footer is invisible to the chat readers", () => {
  const body = `Something is wrong.\n\n${encodeManualFooter({ source: "hub", reportedBy: ["me"] })}`;
  strictEqual(decodeFooter(body), null);
  deepStrictEqual(decodeManualFooter(body), { source: "hub", reportedBy: ["me"] });
});

test("a footer with an empty message list is not a chat link either", () => {
  strictEqual(decodeFooter('<!-- feedback-loop:v1 {"messages":[],"source":"cli"} -->'), null);
  deepStrictEqual(decodeManualFooter('<!-- feedback-loop:v1 {"source":"cli"} -->'), { source: "cli", reportedBy: [] });
});

test("no footer, or a broken one, is null for both", () => {
  strictEqual(decodeFooter("plain body"), null);
  strictEqual(decodeManualFooter("plain body"), null);
  strictEqual(decodeFooter("<!-- feedback-loop:v1 {not json} -->"), null);
  strictEqual(decodeManualFooter(null), null);
});
