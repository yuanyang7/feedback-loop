/**
 * Checked before a run starts. The caps protect review capacity, which is the
 * real bottleneck — a worker that outruns the human reading its output is a
 * backlog generator, not a teammate.
 */
import type { Config } from "../core/config.js";
import { readRunLog } from "../core/state.js";
import type { GitHubClient } from "../intake/github.js";

export interface GateResult {
  ok: boolean;
  reason?: string;
}

export interface GateOptions {
  /**
   * Whether the run log on this host is the one that would record the run.
   *
   * The daily budget and run count are read from `~/.feedback-loop/<target>/runs`,
   * which only the host that actually runs work ever writes. An intake host
   * checking them would read an empty log, conclude nothing has been spent
   * today, and wave through work that the worker host is about to refuse — a
   * cap that reports itself satisfied because it is looking at the wrong disk
   * is worse than no cap. So that half is skipped there, and applied in full
   * at drain time where the log lives. The PR cap is unaffected: it is read
   * from GitHub and means the same thing from anywhere.
   */
  spendCaps?: boolean;
}

export async function checkGate(
  config: Config,
  github: GitHubClient,
  opts: GateOptions = {},
): Promise<GateResult> {
  const agentPrLabel = config.github.labels.agentPr;
  // Only the worker's own PRs count. The cap is on the queue this tool
  // produces, not on however many PRs the humans happen to have open.
  const openPRs = await github.listPullRequests({ state: "open" });
  const agentPRs = openPRs.filter((pr) => (pr.labels ?? []).some((l) => l.name === agentPrLabel));
  if (agentPRs.length >= config.worker.maxOpenPRs) {
    return {
      ok: false,
      reason:
        `${agentPRs.length} open agent PR(s) (${agentPRs.map((p) => `#${p.number}`).join(", ")}), ` +
        `cap is ${config.worker.maxOpenPRs}. Drain the queue before starting new work.`,
    };
  }

  if (opts.spendCaps === false) return { ok: true };

  const today = new Date().toISOString().slice(0, 10);
  const runsToday = readRunLog(config.target.name, 500).filter(
    (e) => e.kind === "worker" && e.at.startsWith(today),
  );
  if (runsToday.length >= config.worker.maxRunsPerDay) {
    return { ok: false, reason: `${runsToday.length} runs today, cap is ${config.worker.maxRunsPerDay}.` };
  }

  const spentToday = runsToday.reduce(
    (sum, e) => sum + (typeof e.data?.costUsd === "number" ? e.data.costUsd : 0),
    0,
  );
  if (spentToday >= config.worker.dailyBudgetUsd) {
    return {
      ok: false,
      reason: `$${spentToday.toFixed(2)} spent today, budget is $${config.worker.dailyBudgetUsd}.`,
    };
  }

  return { ok: true };
}
