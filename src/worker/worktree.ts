/**
 * Every run works in its own git worktree with its own database, storage and
 * port. Never in the main checkout: a human is working there, it sits on the
 * base branch, and the repo's own rules forbid working on it directly.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { dim, info } from "../core/log.js";

const exec = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
  slug: string;
}

export function slugForIssue(issueNumber: number, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return `issue-${issueNumber}${words ? `-${words}` : ""}`;
}

export async function ensureWorktree(
  repoPath: string,
  baseBranch: string,
  slug: string,
  prefix: string,
): Promise<Worktree> {
  const path = join(repoPath, ".worktrees", slug);
  const branch = `${prefix}/${slug}`;

  if (existsSync(path)) return { path, branch, slug };

  // Start from an up-to-date base so the diff is not polluted by drift.
  await exec("git", ["-C", repoPath, "fetch", "origin", baseBranch]);
  await exec("git", [
    "-C", repoPath,
    "worktree", "add", join(".worktrees", slug),
    "-b", branch, `origin/${baseBranch}`,
  ]);

  await seedDependencies(repoPath, path);
  return { path, branch, slug };
}

/**
 * A fresh worktree has no node_modules, and installing them is most of the wall
 * clock of a run that then spends two minutes thinking. The main checkout
 * already has the right ones, so clone them with APFS copy-on-write: the copy
 * is independent but shares blocks, so it costs seconds and almost no disk.
 *
 * Only when the lockfiles match. A clone against a different lockfile would be
 * wrong in a way that surfaces much later as a confusing build failure, and
 * `npm ci` is the correct answer there — just the slow one.
 */
async function seedDependencies(repoPath: string, worktreePath: string): Promise<void> {
  for (const pkg of ["", "mobile"]) {
    const from = join(repoPath, pkg, "node_modules");
    const to = join(worktreePath, pkg, "node_modules");
    if (!existsSync(from) || existsSync(to)) continue;
    if (!sameLockfile(join(repoPath, pkg), join(worktreePath, pkg))) continue;

    // -c asks for a clone; without APFS this silently falls back to a real copy,
    // which is slower but still correct, so there is nothing to detect.
    const started = Date.now();
    const ok = await exec("cp", ["-c", "-R", from, to]).then(
      () => true,
      () => false,
    );
    if (ok) {
      info(`  ${dim(`cloned ${pkg || "root"} node_modules in ${Math.round((Date.now() - started) / 1000)}s`)}`);
    }
  }
}

function sameLockfile(a: string, b: string): boolean {
  const read = (dir: string): string | null => {
    const path = join(dir, "package-lock.json");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const left = read(a);
  return left !== null && left === read(b);
}

export async function removeWorktree(repoPath: string, worktree: Worktree): Promise<void> {
  await exec("git", ["-C", repoPath, "worktree", "remove", "--force", worktree.path]).catch(
    () => undefined,
  );
  await exec("git", ["-C", repoPath, "branch", "-D", worktree.branch]).catch(() => undefined);
}

/** True when the worktree has no commits of its own and nothing uncommitted. */
export async function isUntouched(repoPath: string, worktree: Worktree, baseBranch: string): Promise<boolean> {
  const { stdout: status } = await exec("git", ["-C", worktree.path, "status", "--porcelain"]);
  if (status.trim()) return false;
  const { stdout: ahead } = await exec("git", [
    "-C", worktree.path, "rev-list", "--count", `origin/${baseBranch}..HEAD`,
  ]);
  return ahead.trim() === "0";
}
