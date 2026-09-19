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
const FAIL_LINE = /FAIL\s+(?:\S+\s+)?(\S+\.test\.[cm]?[jt]sx?)\s*>\s*(.+)/g;

/** Strip the ANSI a terminal-shaped hook writes even when nothing is a terminal. */
function plain(text: string): string {
  return text.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join("");
}

export function parseCiFailure(output: string): CiFailure | null {
  const text = plain(output);
  if (!/local CI failed/.test(text)) return null;

  const tests: string[] = [];
  for (const match of text.matchAll(FAIL_LINE)) {
    const entry = `${match[1]} > ${match[2]!.trim()}`;
    if (!tests.includes(entry)) tests.push(entry);
  }

  const timeouts = (text.match(/Test timed out in \d+ms/g) ?? []).length;
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
