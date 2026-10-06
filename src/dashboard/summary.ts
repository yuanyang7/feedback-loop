/**
 * One target, as numbers. `status --json` prints it, and the `--all`
 * dashboard's index page shows one row of it per target. Derived from the
 * same overview the page renders, so the two can never disagree.
 */
import type { LoadedConfig } from "../core/config.js";
import { buildOverview } from "./server.js";

export interface TargetStatus {
  target: string;
  repo: string;
  dashboardUrl: string | null;
  counts: {
    needsYou: number;
    needsInfo: number;
    reproduced: number;
    agentReady: number;
    inProgress: number;
    prReady: number;
    needsDecision: number;
  };
  running: Array<{ issue: number | null; verb: string; pid: number; startedAt: string }>;
  prs: Array<{ number: number; url: string; title: string; issue: number | null }>;
}

export async function targetStatus(loaded: LoadedConfig, dashboardUrl?: string | null): Promise<TargetStatus> {
  const overview = await buildOverview(loaded);
  const count = (key: string): number => overview.groups.find((g) => g.key === key)?.issues.length ?? 0;
  return {
    target: overview.target,
    repo: overview.repo,
    dashboardUrl: dashboardUrl ?? loaded.config.dashboard.url ?? null,
    counts: {
      // Everything waiting on a person: a decision to make, or a run that fell
      // over and needs another go.
      needsYou: count("need-you") + count("run-failed"),
      needsInfo: overview.needsInfo,
      reproduced: count("reproduced"),
      agentReady: count("agent-ready"),
      inProgress: overview.inProgress,
      prReady: overview.agentPrs.length,
      needsDecision: count("need-you"),
    },
    running: overview.running.map((r) => ({
      issue: r.issue,
      verb: r.what.split(" ")[0] ?? r.what,
      pid: r.pid,
      startedAt: r.at,
    })),
    prs: overview.agentPrs.map((pr) => ({ number: pr.number, url: pr.url, title: pr.title, issue: pr.issue })),
  };
}
