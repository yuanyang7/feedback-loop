/**
 * A local, read-only page over the runs directory.
 *
 * It exists for the one thing a terminal cannot do: put a before and an after
 * screenshot side by side. Everything else it shows is also in `status`.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readSecret, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info } from "../core/log.js";
import { readRunLog, runsDir } from "../core/state.js";
import { activeRuns } from "../intake/commands.js";
import { GitHubClient } from "../intake/github.js";
import { renderPage, type Overview } from "./render.js";
import { scanRuns } from "./scan.js";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8", ".patch": "text/plain; charset=utf-8",
};

export async function serveDashboard(loaded: LoadedConfig, port: number): Promise<void> {
  const { config } = loaded;
  const target = config.target.name;
  const root = resolve(runsDir(target));

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname.startsWith("/evidence/")) {
        return serveEvidence(root, url.pathname, res);
      }
      if (url.pathname !== "/") {
        res.writeHead(404).end("not found");
        return;
      }

      try {
        const overview = await buildOverview(loaded);
        const html = renderPage(overview, scanRuns(target));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      } catch (error) {
        res
          .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          .end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  await new Promise<void>((ready) => server.listen(port, "127.0.0.1", ready));
  info(`${bold("dashboard")} ${cyan(`http://localhost:${port}`)} ${dim("— ctrl-c to stop")}`);
  await new Promise(() => {}); // serve until interrupted
}

/**
 * Evidence is served straight off disk, so the path has to be pinned inside the
 * runs directory: a page that renders whatever a URL names would happily read
 * the rest of the filesystem.
 */
function serveEvidence(root: string, pathname: string, res: import("node:http").ServerResponse): void {
  const parts = pathname.slice("/evidence/".length).split("/").map(decodeURIComponent);
  if (parts.length !== 2) {
    res.writeHead(400).end("bad path");
    return;
  }
  const file = normalize(join(root, parts[0]!, "evidence", parts[1]!));
  if (!file.startsWith(`${root}/`) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(res);
}

async function buildOverview(loaded: LoadedConfig): Promise<Overview> {
  const { config } = loaded;
  const labels = config.github.labels;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const [fromChat, agentReady, readyToFix, needsDecision, prs] = await Promise.all([
    github.listIssues({ labels: [labels.source], state: "open" }),
    github.listIssues({ labels: [labels.agentReady], state: "open" }),
    github.listIssues({ labels: [labels.readyToFix], state: "open" }),
    github.listIssues({ labels: [labels.needsDecision], state: "open" }),
    github.listPullRequests({ state: "open" }),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const spentToday = readRunLog(config.target.name, 500)
    .filter((e) => e.kind === "worker" && e.at.startsWith(today))
    .reduce((sum, e) => sum + (typeof e.data?.costUsd === "number" ? e.data.costUsd : 0), 0);

  return {
    target: config.target.name,
    repo: config.target.repo,
    fromChat: fromChat.length,
    agentReady: agentReady.length,
    readyToFix: readyToFix.length,
    needsDecision: needsDecision.length,
    agentPrs: prs
      .filter((pr) => (pr.labels ?? []).some((l) => l.name === labels.agentPr))
      .map((pr) => ({ number: pr.number, url: pr.url, title: pr.title })),
    running: activeRuns(config.target.name).map((r) => ({ what: r.what, at: r.at })),
    spentToday,
    dailyBudgetUsd: config.worker.dailyBudgetUsd,
  };
}
