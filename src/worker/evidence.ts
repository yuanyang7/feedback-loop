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
