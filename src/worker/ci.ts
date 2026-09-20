/**
 * Reading a rejected push.
 *
 * The pre-push hook runs the full local CI suite, so a rejection is an ordinary
 * outcome, not a crash — but its output is thousands of lines of Prisma banners
 * and jsdom warnings with the actual failures buried inside. Pasting that at a
 * human tells them nothing.
 */

const ESC = String.fromCharCode(27);

export interface CiFailure {
  /** The pipeline step that failed, e.g. "test (vitest run)". */
  step: string | null;
  /** Individual failing tests, as "file > suite > name". */
  tests: string[];
  /** True when every failure is a timeout — the signature of a loaded machine. */
  timeoutsOnly: boolean;
}

const STEP = /local CI failed: step failed \(exit \d+\): (.+)/;
// vitest: "FAIL  node  src/x.test.ts > suite > name"
const VITEST_FAIL = /FAIL\s+(?:\S+\s+)?(\S+\.test\.[cm]?[jt]sx?)\s*>\s*(.+)/g;
// jest: "FAIL src/x.test.tsx" on one line, then "  ● suite › name" for each
const JEST_FILE = /^\s*FAIL\s+(\S+\.test\.[cm]?[jt]sx?)\s*$/gm;
const JEST_CASE = /^\s*●\s+(?!Console)(.+?)\s*$/gm;

/** Strip the ANSI a terminal-shaped hook writes even when nothing is a terminal. */
function plain(text: string): string {
  return text.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join("");
}

export function parseCiFailure(output: string): CiFailure | null {
  const text = plain(output);
  if (!/local CI failed/.test(text)) return null;

  const tests: string[] = [];
  const add = (entry: string): void => {
    if (!tests.includes(entry)) tests.push(entry);
  };
  for (const match of text.matchAll(VITEST_FAIL)) add(`${match[1]} > ${match[2]!.trim()}`);

  // Jest prints the file and the cases separately, and "● Console" is a log
  // heading rather than a failure — counting it would invent failing tests.
  const jestFiles = [...text.matchAll(JEST_FILE)].map((m) => m[1]!);
  if (jestFiles.length > 0) {
    const cases = [...text.matchAll(JEST_CASE)].map((m) => m[1]!.trim());
    if (cases.length > 0) for (const c of cases) add(c);
    else for (const f of jestFiles) add(f);
  }

  // Both runners, said differently: vitest "Test timed out in 5000ms", jest
  // "Exceeded timeout of 5000 ms for a test". Missing one turns a loaded
  // machine into findings, and sends the next attempt hunting a phantom.
  const timeouts = (text.match(/Test timed out in \d+\s*ms|Exceeded timeout of \d+\s*ms/g) ?? []).length;
  return {
    step: STEP.exec(text)?.[1]?.trim() ?? null,
    tests,
    // Every failing test timed out, and there was at least one. Nothing
    // asserted wrong; the suite simply never got the CPU to finish.
    timeoutsOnly: tests.length > 0 && timeouts >= tests.length,
  };
}

/** What to tell the fix phase to address, or nothing when there is nothing to act on. */
export function findingsFrom(failure: CiFailure): string[] {
  // Handing an agent a timeout to "fix" sends it chasing a phantom in the diff.
  if (failure.timeoutsOnly) return [];
  return failure.tests.length > 0
    ? failure.tests.map((t) => `CI failure: ${t}`)
    : [`CI step failed: ${failure.step ?? "unknown"}`];
}

export function renderCiFailure(failure: CiFailure, worktreeSlug: string): string {
  const lines = [
    failure.timeoutsOnly
      ? "### ⏱️ Push rejected by local CI — every failure was a timeout"
      : "### ❌ Push rejected by local CI",
    "",
    `Failing step: \`${failure.step ?? "unknown"}\``,
  ];

  if (failure.tests.length > 0) {
    lines.push("", ...failure.tests.map((t) => `- \`${t}\``));
  }

  if (failure.timeoutsOnly) {
    lines.push(
      "",
      "Nothing asserted wrong — these tests ran out of time rather than failing. That is usually " +
        "the machine being loaded rather than anything in this diff, and it means the gate cannot " +
        "be trusted on this run in either direction.",
      "",
      "Check the tests in isolation before assuming the change is at fault, and re-run when the " +
        "machine is quieter.",
    );
  }

  lines.push(
    "",
    `The commits are still in \`.worktrees/${worktreeSlug}\` — nothing was lost, and a re-run ` +
      "continues from there rather than starting over.",
  );
  return lines.join("\n");
}
