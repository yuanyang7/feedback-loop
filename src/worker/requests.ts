/**
 * Runs a person asked for that could not start yet.
 *
 * The queue shown by `queue` is derived from GitHub labels, which is right for
 * work nobody has spoken for: it stays true as labels change and needs no
 * bookkeeping. What it cannot represent is the one thing labels do not record —
 * that a human typed `go 1221` at a specific issue. Without that, hitting the
 * concurrency limit turned an explicit request into a refusal, and the person
 * who asked had to remember to ask again.
 *
 * So this file holds only the asking. Everything about whether the run may
 * proceed is still decided at drain time against GitHub and the gate, because
 * an hour in a queue is long enough for all of it to have changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../core/state.js";

export interface RunRequest {
  issue: number;
  kind: "triage" | "fix" | "go";
  channel: string;
  /**
   * The "queued" notice. Handed to the run when it finally starts so it edits
   * that line into "running" and then "done", rather than posting a second one.
   */
  message: string | null;
  /** Who asked, for the queue view — this is a record of a decision. */
  by: string;
  at: string;
}

function path(target: string): string {
  return join(stateDir(target), "requests.json");
}

export function readRequests(target: string): RunRequest[] {
  const file = path(target);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as RunRequest[]) : [];
  } catch {
    return [];
  }
}

function write(target: string, requests: RunRequest[]): void {
  const file = path(target);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(requests, null, 2)}\n`);
}

/**
 * Add a request, or return where the existing one already sits. Asking twice
 * for the same issue is what a person does when they are not sure the first one
 * landed, and it should tell them rather than queue the work twice.
 */
export function enqueueRequest(
  target: string,
  request: Omit<RunRequest, "at">,
): { position: number; alreadyQueued: boolean } {
  const requests = readRequests(target);
  const existing = requests.findIndex((r) => r.issue === request.issue);
  if (existing >= 0) return { position: existing + 1, alreadyQueued: true };

  requests.push({ ...request, at: new Date().toISOString() });
  write(target, requests);
  return { position: requests.length, alreadyQueued: false };
}

export function dropRequest(target: string, issue: number): void {
  const requests = readRequests(target);
  const remaining = requests.filter((r) => r.issue !== issue);
  if (remaining.length !== requests.length) write(target, remaining);
}
