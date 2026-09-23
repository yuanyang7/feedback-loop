/**
 * A person's answer to an issue the loop escalated.
 *
 * Runs do not read an issue's comments — most of them are the loop's own
 * reports, and the rest are conversation. An answer typed on the dashboard is
 * marked, so it is the one kind of comment that does reach the next prompt.
 */
import type { GitHubClient } from "../intake/github.js";

const MARKER = "feedback-loop:decision:v1";
const PATTERN = /<!--\s*feedback-loop:decision:v1\s*-->/;

export function decisionComment(text: string): string {
  return `🧑‍⚖️ **Operator decision**\n\n${text.trim()}\n\n<!-- ${MARKER} -->`;
}

/** Every decision on the issue, oldest first, with the marker stripped. */
export async function readDecisions(github: GitHubClient, issue: number): Promise<string[]> {
  const comments = await github.issueComments(issue).catch(() => []);
  return comments
    .filter((c) => PATTERN.test(c.body))
    .map((c) => c.body.replace(PATTERN, "").replace(/^🧑‍⚖️ \*\*Operator decision\*\*\s*/, "").trim());
}

/**
 * Appended to a phase's prompt. Unlike the report, these come from an
 * operator — the person who decides what the loop does — so they are
 * direction, and the latest wins where they disagree.
 */
export function withDecisions(prompt: string, decisions: string[]): string {
  if (decisions.length === 0) return prompt;
  return `${prompt}

A person who operates this loop answered an earlier escalation on this issue. Unlike the report,
these are decisions for you to follow; where two disagree, the later one wins.

<operator-decisions>
${decisions.map((d, i) => `<decision n="${i + 1}">\n${d}\n</decision>`).join("\n")}
</operator-decisions>`;
}
