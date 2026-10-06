/**
 * `report` is the entry point a hub or an editor shells out to, so its
 * argument parsing is an interface, and the labels it applies are what put
 * the issue in the worker's queue — or keep it out until a person says so.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoadedConfig } from "../core/config.js";
import { decodeFooter, decodeManualFooter } from "./footer.js";
import { composeReport, parseReportArgs, type ReportOptions } from "./report.js";

const loaded = {
  config: {
    target: { name: "t", repo: "o/r" },
    github: { titlePrefix: "[feedback]", labels: { source: "from-discord", agentReady: "agent-ready" } },
  },
  repoPath: null,
  playbookPath: null,
} as unknown as LoadedConfig;

test("the minimum is a title; everything else defaults", () => {
  const parsed = parseReportArgs(["--title", "Login button is blank"]) as ReportOptions;
  deepStrictEqual(parsed, {
    title: "Login button is blank",
    body: "",
    severity: null,
    size: null,
    ready: false,
    source: "cli",
    json: false,
    dryRun: false,
  });
});

test("missing or malformed flags come back as a sentence, not a throw", () => {
  strictEqual(parseReportArgs([]), "report needs --title.");
  strictEqual(parseReportArgs(["--title", "--json"]), "--title needs a value.");
  strictEqual(parseReportArgs(["--title", "x", "--severity", "urgent"]), "--severity must be one of low, medium, high.");
  strictEqual(parseReportArgs(["--title", "x", "--size", "xl"]), "--size must be one of s, m, l.");
  strictEqual(parseReportArgs(["--title", "x", "--body", "a", "--body-file", "b"]), "Give --body or --body-file, not both.");
  strictEqual(typeof parseReportArgs(["--title", "x", "--body-file", "/nonexistent/file"]), "string");
  strictEqual(typeof parseReportArgs(["--title", "x", "--source", "a whole sentence"]), "string");
});

test("--body-file reads the file", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fl-report-")), "body.md");
  writeFileSync(file, "steps:\n1. open\n2. click\n");
  const parsed = parseReportArgs(["--title", "x", "--body-file", file, "--source", "hub", "--json"]) as ReportOptions;
  strictEqual(parsed.body, "steps:\n1. open\n2. click");
  strictEqual(parsed.source, "hub");
  strictEqual(parsed.json, true);
});

test("labels match what intake would apply, and agent-ready only with --ready", () => {
  const plain = composeReport(loaded, parseReportArgs(["--title", "x", "--severity", "high", "--size", "s"]) as ReportOptions);
  deepStrictEqual(plain.labels, ["from-discord", "severity:high", "size:s"]);
  strictEqual(plain.title, "[feedback] x");

  const ready = composeReport(loaded, parseReportArgs(["--title", "x", "--ready"]) as ReportOptions);
  deepStrictEqual(ready.labels, ["from-discord", "agent-ready"]);
});

test("the footer names the source and is not a chat link", () => {
  const { body } = composeReport(loaded, parseReportArgs(["--title", "x", "--source", "agentdeck"]) as ReportOptions);
  strictEqual(decodeFooter(body), null);
  strictEqual(decodeManualFooter(body)?.source, "agentdeck");
});
