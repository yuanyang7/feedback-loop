/**
 * A report filed by hand — from a terminal, a hub, an editor — rather than
 * taken from chat.
 *
 * It lands in the same place and wears the same labels intake would give it,
 * so everything downstream (the queue, the gate, the dashboard, `handoff`)
 * treats it identically. What it does not do: no model call, because the
 * reporter already wrote the title; no dedupe, because a person filing by
 * hand has the open issues in front of them. The footer names a `source`
 * instead of chat message ids, which is how reconcile and the workers'
 * reactions know to leave it alone.
 */
import { readFileSync } from "node:fs";
import { readSecret, type LoadedConfig } from "../core/config.js";
import { encodeManualFooter } from "./footer.js";
import { GitHubClient } from "./github.js";

export const SEVERITIES = ["low", "medium", "high"] as const;
export const SIZES = ["s", "m", "l"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Size = (typeof SIZES)[number];

export interface ReportOptions {
  title: string;
  body: string;
  severity: Severity | null;
  size: Size | null;
  /**
   * Apply `agent-ready` as well. This is the human gate — the label intake
   * never applies — and passing it here means the reporter is the person
   * judging the report safe to hand to an agent. It is their call to make,
   * and it is made explicitly, by flag, not by default.
   */
  ready: boolean;
  /** Where it came from: cli (default), hub, agentdeck, or any short word. */
  source: string;
  json: boolean;
  dryRun: boolean;
}

/**
 * Parse the flags after `report`. Returns an error string rather than
 * throwing, so the CLI can print usage; kept apart from the filing so it can
 * be tested without GitHub.
 */
export function parseReportArgs(argv: string[]): ReportOptions | string {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? "" : v;
  };
  const title = value("--title");
  if (title === undefined) return "report needs --title.";
  if (!title.trim()) return "--title needs a value.";

  const bodyFile = value("--body-file");
  if (bodyFile === "") return "--body-file needs a path.";
  const inlineBody = value("--body");
  if (inlineBody !== undefined && bodyFile !== undefined) return "Give --body or --body-file, not both.";
  let body = inlineBody ?? "";
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(bodyFile, "utf8");
    } catch (error) {
      return `Could not read --body-file ${bodyFile}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const severity = value("--severity");
  if (severity !== undefined && !(SEVERITIES as readonly string[]).includes(severity)) {
    return `--severity must be one of ${SEVERITIES.join(", ")}.`;
  }
  const size = value("--size");
  if (size !== undefined && !(SIZES as readonly string[]).includes(size)) {
    return `--size must be one of ${SIZES.join(", ")}.`;
  }
  const source = value("--source") ?? "cli";
  // It goes into a label-free footer and the issue body as text, so the only
  // constraint is that it stays a word: a sentence here is someone confusing
  // --source with --body.
  if (!/^[\w.-]{1,32}$/.test(source)) return "--source should be a short word, e.g. cli, hub or agentdeck.";

  return {
    title: title.trim(),
    body: body.trim(),
    severity: (severity as Severity | undefined) ?? null,
    size: (size as Size | undefined) ?? null,
    ready: argv.includes("--ready"),
    source,
    json: argv.includes("--json"),
    dryRun: argv.includes("--dry-run"),
  };
}

export interface Filed {
  number: number | null;
  url: string | null;
  target: string;
  title: string;
  labels: string[];
  body: string;
}

/** The title and labels intake would have used for the same report. */
export function composeReport(loaded: LoadedConfig, opts: ReportOptions): { title: string; labels: string[]; body: string } {
  const { config } = loaded;
  const prefix = config.github.titlePrefix;
  const title = `${prefix}${prefix ? " " : ""}${opts.title}`;
  const labels = [
    config.github.labels.source,
    ...(opts.severity ? [`severity:${opts.severity}`] : []),
    ...(opts.size ? [`size:${opts.size}`] : []),
    ...(opts.ready ? [config.github.labels.agentReady] : []),
  ];
  const who = process.env.USER || process.env.USERNAME || "";
  const body = [
    `> **Reported via \`${opts.source}\`${who ? ` by \`${who}\`` : ""}** — filed with \`feedback-loop report\`, not classified by a model.`,
    "",
    opts.body || "_(no body)_",
    ...(opts.ready
      ? ["", `> Cleared for an autonomous attempt by the reporter (\`--ready\`), which is the gate a person would otherwise open with \`ready ${"<issue>"}\`.`]
      : []),
    "",
    encodeManualFooter({ source: opts.source, reportedBy: who ? [who] : [] }),
  ].join("\n");
  return { title, labels, body };
}

export async function fileReport(loaded: LoadedConfig, opts: ReportOptions): Promise<Filed> {
  const { config } = loaded;
  const { title, labels, body } = composeReport(loaded, opts);
  if (opts.dryRun) return { number: null, url: null, target: config.target.name, title, labels, body };

  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );
  const number = await github.createIssue({ title, body, labels });
  return {
    number,
    url: `https://github.com/${config.target.repo}/issues/${number}`,
    target: config.target.name,
    title,
    labels,
    body,
  };
}
