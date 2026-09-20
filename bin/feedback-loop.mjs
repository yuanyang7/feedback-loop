#!/usr/bin/env node
/**
 * Run the TypeScript source through tsx when it is available, and the built
 * output when it is not.
 *
 * Development wants the source: there is no build step to forget, and argv[1]
 * being a .ts file is why this launcher exists at all — `startWorker`
 * re-enters through it rather than through process.argv. A packaged host wants
 * the opposite, because shipping tsx to a machine that runs unattended means
 * shipping a compiler it has no reason to have.
 *
 * The test is tsx rather than dist, and that direction matters: a developer
 * who ran `npm run build` once must not silently keep running that build for
 * the rest of the week. Absent tsx there is nothing to be stale against.
 *
 * Getting this wrong is expensive. The failure is a spawn that cannot find its
 * binary, which exits non-zero with nothing on stderr — so a container would
 * have ticked into silence every five minutes and looked like a quiet week.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "dist", "cli.js");
const source = join(here, "..", "src", "cli.ts");
const tsx = join(here, "..", "node_modules", ".bin", "tsx");

const [command, args] = existsSync(tsx)
  ? [tsx, [source, ...process.argv.slice(2)]]
  : [process.execPath, [built, ...process.argv.slice(2)]];

if (!existsSync(existsSync(tsx) ? source : built)) {
  console.error(`feedback-loop: nothing to run — no tsx and no dist/cli.js. Run \`npm run build\`.`);
  process.exit(1);
}

const result = spawnSync(command, args, { stdio: "inherit" });
// Say why, rather than exiting 1 into the dark. A missing tsx on a host that
// was built without dev dependencies is the whole reason this branch exists.
if (result.error) {
  console.error(`feedback-loop: could not run ${command} — ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
