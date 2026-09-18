/**
 * Every run works in its own git worktree with its own database, storage and
 * port. Never in the main checkout: a human is working there, it sits on the
 * base branch, and the repo's own rules forbid working on it directly.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

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
  return { path, branch, slug };
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
