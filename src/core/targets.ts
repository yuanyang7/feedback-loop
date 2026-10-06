/**
 * The registry of every repo this machine runs the loop for.
 *
 * One target is a path; many targets are a list somebody has to keep, and
 * keeping it in a shell alias or a launchd plist means `tick --all` and
 * `dashboard --all` each have their own copy of it. So it lives next to the
 * rest of the state, in `~/.feedback-loop/targets.json`, and both read it.
 *
 * An entry remembers where the config is, not what it says: the config stays
 * in the target repo, which is the whole reason this tool can be public.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, loadConfigFile, type LoadedConfig } from "./config.js";
import { homeDir, writeJsonAtomically } from "./state.js";
import { readFileSync } from "node:fs";

export interface TargetEntry {
  /** `target.name` from the config, which is also the state directory. */
  name: string;
  /** The checkout, or null when only the config is here (an intake host). */
  path: string | null;
  /** Absolute path to the config.yml. */
  config: string;
}

interface Registry {
  targets: TargetEntry[];
}

export function targetsPath(): string {
  return join(homeDir(), "targets.json");
}

export function readTargets(): TargetEntry[] {
  const path = targetsPath();
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = (parsed as Partial<Registry> | null)?.targets;
  if (!Array.isArray(list)) throw new Error(`${path} should be { "targets": [ … ] }`);
  return list.filter(
    (t): t is TargetEntry =>
      !!t && typeof t === "object" && typeof (t as TargetEntry).name === "string" && typeof (t as TargetEntry).config === "string",
  ).map((t) => ({ name: t.name, path: typeof t.path === "string" ? t.path : null, config: t.config }));
}

function writeTargets(targets: TargetEntry[]): void {
  writeJsonAtomically(targetsPath(), { targets } satisfies Registry);
}

/**
 * Register a target from its repo, or from a bare config file. The name comes
 * from the config rather than the command line so the registry cannot
 * disagree with the state directory the target already writes to.
 */
export function addTarget(where: { repoPath?: string; configFile?: string }): TargetEntry {
  let entry: TargetEntry;
  if (where.configFile) {
    const file = resolve(where.configFile);
    const loaded = loadConfigFile(file);
    entry = { name: loaded.config.target.name, path: loaded.repoPath, config: file };
  } else {
    const loaded = loadConfig(where.repoPath ?? process.cwd());
    // `loadConfig` walked up to find it; record where it landed, not where it
    // was called from, so `add .` from a subdirectory registers the repo.
    const repo = loaded.repoPath!;
    entry = { name: loaded.config.target.name, path: repo, config: join(repo, ".feedback-loop", "config.yml") };
  }

  const targets = readTargets();
  const clash = targets.find((t) => t.name === entry.name || t.config === entry.config);
  if (clash) {
    throw new Error(
      clash.name === entry.name
        ? `A target named "${entry.name}" is already registered (${clash.config}). Remove it first, or give this one another target.name.`
        : `${entry.config} is already registered as "${clash.name}".`,
    );
  }
  writeTargets([...targets, entry]);
  return entry;
}

export function removeTarget(name: string): TargetEntry | null {
  const targets = readTargets();
  const found = targets.find((t) => t.name === name) ?? null;
  if (found) writeTargets(targets.filter((t) => t !== found));
  return found;
}

/**
 * Load a registered target the way the CLI would have: from inside the repo
 * when there is one, so `target.path` and the playbook resolve as usual, and
 * from the bare config otherwise.
 */
export function loadTarget(entry: TargetEntry): LoadedConfig {
  if (entry.path && existsSync(join(entry.path, ".feedback-loop", "config.yml"))) return loadConfig(entry.path);
  return loadConfigFile(entry.config);
}
