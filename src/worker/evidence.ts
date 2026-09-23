/**
 * Evidence has to outlive the worktree it was captured in.
 *
 * A triage run reported that screenshots confirmed what it saw; those files
 * were written inside the worktree, the worktree was removed when the run
 * escalated, and the screenshots went with it. The verdict survived and the
 * thing backing it did not, which is the wrong way round.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { dim, info } from "../core/log.js";

const exec = promisify(execFile);

const CAPTURED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webm", ".mp4", ".webp", ".har", ".log"]);

export function evidenceDir(artifactDir: string): string {
  const dir = join(artifactDir, "evidence");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The instruction handed to a phase so it writes evidence somewhere durable. */
export function evidenceInstruction(dir: string): string {
  return `Write every screenshot, recording, log excerpt or captured output you rely on to:

    ${dir}

Anything you leave inside the worktree is discarded when the run ends. A claim whose evidence was
not saved there cannot be checked later, so it is worth no more than a guess. Name files for what
they show — \`before-panel.png\`, \`after-panel.png\` — and cite them by filename in your verdict.`;
}

/**
 * Anything image-shaped the session created but did not save to the evidence
 * directory, swept up before the worktree is removed. Only untracked files:
 * the repo's own assets are not evidence.
 */
export async function sweepWorktree(worktreePath: string, dir: string): Promise<number> {
  const { stdout } = await exec("git", [
    "-C", worktreePath, "ls-files", "--others", "--exclude-standard",
  ]).catch(() => ({ stdout: "" }));

  let copied = 0;
  for (const rel of stdout.split("\n").filter(Boolean)) {
    if (!CAPTURED.has(extname(rel).toLowerCase())) continue;
    const source = join(worktreePath, rel);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    if (statSync(source).size > 25 * 1024 * 1024) continue; // a stray build output, not evidence
    copyFileSync(source, join(dir, uniqueName(dir, basename(rel))));
    copied += 1;
  }
  if (copied > 0) info(`  ${dim(`swept ${copied} evidence file(s) out of the worktree`)}`);
  return copied;
}

// src/app holds both pages and API routes under Next's App Router, and a route
// handler renders nothing — treating one as a UI change asks for screenshots of
// a JSON endpoint.
const NOT_UI = /(^src\/app\/api\/)|(\.test\.[cm]?[jt]sx?$)|(\.config\.[cm]?[jt]s$)/;
const UI_PATH = /(\.tsx$)|(^mobile\/src\/)|(^src\/components\/)|(^src\/app\/)|(\.css$)/;

/**
 * Whether this change alters what someone sees. A rule in a prompt is a hope;
 * this is what turns "capture the UI" into something that can be checked.
 */
export function touchesUi(changedPaths: string[]): boolean {
  return changedPaths.some((p) => UI_PATH.test(p) && !NOT_UI.test(p));
}

export function hasImages(dir: string): boolean {
  return listEvidence(dir).some((f) => /\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(f));
}

export function listEvidence(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !f.startsWith("."));
}

function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/**
 * Triage already worked out how to put the app into the broken state — the
 * data to seed, the screen to drive to. Saved as scripts, the fix phase can
 * rerun that in a minute instead of rewriting it from the notes, which was
 * where most of a fix's wall clock went.
 */
export function reproInstruction(dir: string): string {
  return `If reproducing needed any setup — seeding or changing data, a Playwright script, idb or simctl
commands to reach a screen — save each as a runnable script in:

    ${join(dir, "repro")}

with a README.md saying what to run, in what order, and what it expects (a lab database URL, a port,
a booted Simulator). Parameterise anything specific to this worktree, such as the database URL or
port, as an environment variable rather than hard-coding it. The fix phase reruns these for its
before and after captures instead of writing them again.`;
}

/** The latest triage run's repro scripts for an issue, if it saved any. */
export function findReproDir(runsRoot: string, issueNumber: number): string | null {
  if (!existsSync(runsRoot)) return null;
  const marker = `-issue-${issueNumber}-`;
  for (const run of readdirSync(runsRoot).filter((d) => d.includes(marker) && !d.includes("-fix-")).sort().reverse()) {
    const dir = join(runsRoot, run, "evidence", "repro");
    if (existsSync(dir) && readdirSync(dir).length > 0) return dir;
  }
  return null;
}

export function reuseReproInstruction(dir: string | null): string {
  if (!dir) return "";
  return `Triage saved the scripts that reproduce this bug in:

    ${dir}

Read its README.md and rerun them — to confirm the bug before your change and to capture the after
state — rather than writing new ones. Adapt them if they no longer fit; do not start from scratch.
`;
}
