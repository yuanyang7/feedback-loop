/**
 * Reading what a run left behind.
 *
 * Everything here is derived from the runs directory on disk — nothing is
 * stored for the dashboard's benefit, so the page can never disagree with the
 * artifacts it is describing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "../core/state.js";

export interface EvidencePair {
  /** The shared part of the name: "desktop-community-dropdown". */
  label: string;
  before?: string;
  after?: string;
  /** Files that are neither, e.g. a driving script or a log. */
  single?: string;
}

export interface RunSummary {
  id: string;
  /** "triage" or "fix", parsed from the directory name. */
  kind: string;
  issue: number | null;
  at: Date;
  phases: PhaseSummary[];
  evidence: EvidencePair[];
  /** Files in the evidence directory that are not images. */
  attachments: string[];
  readme: string | null;
  costUsd: number;
}

export interface PhaseSummary {
  name: string;
  verdict: Record<string, unknown> | null;
  costUsd: number;
  turns: number;
  sessionId: string | null;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export function scanRuns(target: string, limit = 40): RunSummary[] {
  const root = runsDir(target);
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => readRun(root, id));
}

function readRun(root: string, id: string): RunSummary {
  const dir = join(root, id);
  const files = readdirSync(dir);

  const phases: PhaseSummary[] = files
    .filter((f) => f.endsWith(".verdict.json"))
    .map((f) => f.replace(".verdict.json", ""))
    .sort()
    .map((name) => {
      const envelope = readJson(join(dir, `${name}.transcript.json`));
      return {
        name,
        verdict: readJson(join(dir, `${name}.verdict.json`)),
        costUsd: Number(envelope?.total_cost_usd ?? 0),
        turns: Number(envelope?.num_turns ?? 0),
        sessionId: (envelope?.session_id as string | undefined) ?? null,
      };
    });

  // A phase that died before writing a verdict still has a transcript, and
  // those are the runs most worth looking at.
  for (const f of files.filter((f) => f.endsWith(".transcript.json"))) {
    const name = f.replace(".transcript.json", "");
    if (phases.some((p) => p.name === name)) continue;
    const envelope = readJson(join(dir, f));
    phases.push({
      name,
      verdict: null,
      costUsd: Number(envelope?.total_cost_usd ?? 0),
      turns: Number(envelope?.num_turns ?? 0),
      sessionId: (envelope?.session_id as string | undefined) ?? null,
    });
  }
  phases.sort((a, b) => a.name.localeCompare(b.name));

  const evidenceDir = join(dir, "evidence");
  const evidenceFiles = existsSync(evidenceDir) ? readdirSync(evidenceDir).sort() : [];

  return {
    id,
    kind: /-fix-/.test(id) ? "fix" : "triage",
    issue: Number(/issue-(\d+)/.exec(id)?.[1] ?? NaN) || null,
    at: parseStamp(id),
    phases,
    evidence: pairEvidence(evidenceFiles.filter((f) => IMAGE.test(f))),
    // Files only: a directory such as repro/ is not something the page can serve.
    attachments: evidenceFiles.filter(
      (f) => !IMAGE.test(f) && f !== "README.txt" && statSync(join(evidenceDir, f)).isFile(),
    ),
    readme: existsSync(join(evidenceDir, "README.txt"))
      ? readFileSync(join(evidenceDir, "README.txt"), "utf8")
      : null,
    costUsd: phases.reduce((sum, p) => sum + p.costUsd, 0),
  };
}

/**
 * Match "before-x.png" with "after-x.png". Pairing them is the whole point of
 * this page: two files in a directory listing say nothing, and the same two
 * side by side are the argument for the change.
 */
export function pairEvidence(files: string[]): EvidencePair[] {
  const pairs = new Map<string, EvidencePair>();

  for (const file of files) {
    const match = /^(before|after)-(.+)\.[a-z]+$/i.exec(file);
    if (!match) {
      pairs.set(file, { label: file, single: file });
      continue;
    }
    const [, side, label] = match;
    const entry = pairs.get(label!) ?? { label: label! };
    entry[side!.toLowerCase() as "before" | "after"] = file;
    pairs.set(label!, entry);
  }

  // Complete pairs first — they are what someone came to look at.
  return [...pairs.values()].sort((a, b) => {
    const score = (p: EvidencePair): number => (p.before && p.after ? 0 : p.single ? 2 : 1);
    return score(a) - score(b) || a.label.localeCompare(b.label);
  });
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Directory names start with an ISO-ish stamp: 2026-09-19T005825-fix-issue-1209-… */
function parseStamp(id: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return new Date(0);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
}
