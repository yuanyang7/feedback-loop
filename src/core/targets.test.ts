/**
 * The registry is what `tick --all` and `dashboard --all` iterate, so a
 * duplicate here is a target ticked twice — and two intake passes on one
 * Discord cursor each skip what the other consumed. Refusing duplicates is
 * the property, and the name has to come from the config, not the caller.
 */
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.FEEDBACK_LOOP_HOME = mkdtempSync(join(tmpdir(), "fl-targets-"));
const { addTarget, loadTarget, readTargets, removeTarget, targetsPath } = await import("./targets.js");

function repo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fl-repo-${name}-`));
  mkdirSync(join(dir, ".feedback-loop"));
  writeFileSync(
    join(dir, ".feedback-loop", "config.yml"),
    `target:\n  name: ${name}\n  repo: o/${name}\ngithub: {}\n`,
  );
  return dir;
}

test("an empty registry reads as no targets", () => {
  deepStrictEqual(readTargets(), []);
});

test("add takes the name from the config and remembers both paths", () => {
  const dir = repo("alpha");
  const entry = addTarget({ repoPath: join(dir) });
  strictEqual(entry.name, "alpha");
  strictEqual(entry.path, dir);
  strictEqual(entry.config, join(dir, ".feedback-loop", "config.yml"));
  deepStrictEqual(readTargets(), [entry]);
  strictEqual(targetsPath(), join(process.env.FEEDBACK_LOOP_HOME!, "targets.json"));
});

test("a second target with the same name is refused", () => {
  const dir = repo("alpha");
  throws(() => addTarget({ repoPath: dir }), /already registered/);
  strictEqual(readTargets().length, 1);
});

test("a bare config registers with no checkout", () => {
  const dir = repo("beta");
  const entry = addTarget({ configFile: join(dir, ".feedback-loop", "config.yml") });
  strictEqual(entry.name, "beta");
  strictEqual(entry.path, null);
  // Loading it goes through the bare-config path, so there is no repo to run in.
  strictEqual(loadTarget(entry).repoPath, null);
  strictEqual(loadTarget(readTargets()[0]!).repoPath, readTargets()[0]!.path);
});

test("a target without a discord section is still a valid target", () => {
  const entry = readTargets()[0]!;
  strictEqual(loadTarget(entry).config.discord, null);
});

test("remove returns what it removed, and null for a name it never had", () => {
  strictEqual(removeTarget("beta")?.name, "beta");
  strictEqual(removeTarget("beta"), null);
  deepStrictEqual(readTargets().map((t) => t.name), ["alpha"]);
});
