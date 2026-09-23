/**
 * A local page over the runs directory and the GitHub queue.
 *
 * It exists for what a terminal cannot do: put a before and an after
 * screenshot side by side, and show every issue in a group with the commands
 * that apply to it one click away. The buttons are chat commands by another
 * route — `actions.ts` holds them to the same gates.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readSecret, resolveRole, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info } from "../core/log.js";
import { readRunLog, runsDir } from "../core/state.js";
import { activeRuns } from "../intake/commands.js";
import { GitHubClient, type Issue } from "../intake/github.js";
import { HUMAN_OWNED } from "../worker/handoff.js";
import { handoffInfo, isAction, latestLog, readLogTail, runAction } from "./actions.js";
import { renderPage, type IssueRow, type Overview } from "./render.js";
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
  // Per process, and only ever written into the page this server renders. A
  // page on another origin can send a simple POST here but cannot set a custom
  // header without a preflight we never answer, and cannot read this token.
  const token = randomBytes(18).toString("hex");
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // DNS rebinding: a hostile name that resolves to 127.0.0.1 would be
      // same-origin with this page, able to read the token and press buttons.
      if (!hosts.has(req.headers.host ?? "")) {
        res.writeHead(421).end("wrong host");
        return;
      }
      if (url.pathname === "/api/action") {
        return handleAction(loaded, token, req, res);
      }
      if (url.pathname === "/api/handoff") {
        if (!authorised(req, token)) return json(res, 403, { ok: false, message: "Reload the page — its token is stale." });
        const issue = Number(url.searchParams.get("issue"));
        if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { ok: false, message: "bad issue" });
        const found = handoffInfo(loaded, issue);
        return found
          ? json(res, 200, { ok: true, handoff: found })
          : json(res, 404, { ok: false, message: `No handoff worktree with a HANDOFF.md for #${issue} on this machine.` });
      }
      if (url.pathname === "/api/log") {
        return handleLog(target, token, req, url, res);
      }
      if (url.pathname.startsWith("/evidence/")) {
        return serveEvidence(root, url.pathname, res);
      }
      if (url.pathname !== "/") {
        res.writeHead(404).end("not found");
        return;
      }

      try {
        const overview = await buildOverview(loaded);
        const html = renderPage(overview, scanRuns(target), token);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // The buttons are the reason: framed by another site, a click on
          // "ready" there would be a click on this page.
          "content-security-policy": "frame-ancestors 'none'",
          "x-frame-options": "DENY",
        }).end(html);
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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    .end(JSON.stringify(body));
}

function authorised(req: IncomingMessage, token: string): boolean {
  return req.headers["x-feedback-loop-token"] === token;
}

async function handleAction(loaded: LoadedConfig, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { ok: false, message: "POST only" });
  if (!authorised(req, token)) return json(res, 403, { ok: false, message: "Reload the page — its token is stale." });

  let body: { action?: unknown; issue?: unknown; text?: unknown; then?: unknown };
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 32 * 1024) return json(res, 413, { ok: false, message: "too large" });
      chunks.push(chunk as Buffer);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
  } catch {
    return json(res, 400, { ok: false, message: "bad JSON" });
  }

  const issue = Number(body.issue);
  if (!isAction(body.action) || !Number.isInteger(issue) || issue <= 0) {
    return json(res, 400, { ok: false, message: "unknown action or issue" });
  }
  try {
    info(`${bold("dashboard")} ${body.action} #${issue}`);
    const then = body.then === "triage" || body.then === "go" ? body.then : "none";
    const text = typeof body.text === "string" ? body.text : "";
    return json(res, 200, await runAction(loaded, body.action, issue, { text, then }));
  } catch (error) {
    return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
  }
}

function handleLog(target: string, token: string, req: IncomingMessage, url: URL, res: ServerResponse): void {
  if (!authorised(req, token)) return json(res, 403, { ok: false, message: "Reload the page — its token is stale." });
  const issue = Number(url.searchParams.get("issue"));
  if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { ok: false, message: "bad issue" });
  const path = latestLog(target, issue);
  if (!path) return json(res, 404, { ok: false, message: `No worker log for #${issue} yet.` });
  const running = activeRuns(target).some((r) => r.issue === issue);
  return json(res, 200, { ok: true, path, running, text: readLogTail(path) });
}

/**
 * Evidence is served straight off disk, so the path has to be pinned inside the
 * runs directory: a page that renders whatever a URL names would happily read
 * the rest of the filesystem.
 */
function serveEvidence(root: string, pathname: string, res: ServerResponse): void {
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

  const [fromChat, agentReady, readyToFix, needsDecision, runFailed, queued, humanOwned, prs] = await Promise.all([
    github.listIssues({ labels: [labels.source], state: "open" }),
    github.listIssues({ labels: [labels.agentReady], state: "open" }),
    github.listIssues({ labels: [labels.readyToFix], state: "open" }),
    github.listIssues({ labels: [labels.needsDecision], state: "open" }),
    github.listIssues({ labels: [labels.runFailed], state: "open" }),
    github.listIssues({ labels: [labels.requested], state: "open" }),
    github.listIssues({ labels: [HUMAN_OWNED], state: "open" }),
    github.listPullRequests({ state: "open" }),
  ]);
  const running = activeRuns(config.target.name);
  // Why each escalated issue is waiting: the loop's last comment on it.
  const asked = new Map<number, string>(
    await Promise.all(
      needsDecision.map(async (issue): Promise<[number, string]> => {
        const comments = await github.issueComments(issue.number).catch(() => []);
        return [issue.number, comments.at(-1)?.body.replace(/<!--[\s\S]*?-->/g, "").trim() ?? ""];
      }),
    ),
  );
  // GitHub labels are shared with people: `needs-decision` on an issue you
  // filed by hand is your note, not the loop asking for you. So an issue is
  // shown only once the loop has a stake in it — it came from chat, someone
  // cleared or queued it for a run, it was handed off, or a run exists on disk.
  const ran = new Set(
    existsSync(runsDir(config.target.name))
      ? readdirSync(runsDir(config.target.name)).map((d) => Number(/issue-(\d+)-/.exec(d)?.[1])).filter(Boolean)
      : [],
  );
  const ours = (issue: Issue): boolean =>
    ran.has(issue.number) ||
    issue.labels.some((l) => [labels.source, labels.agentReady, labels.requested, HUMAN_OWNED].includes(l.name));
  const row = (issue: Issue): IssueRow => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels.map((l) => l.name),
    running: running.find((r) => r.issue === issue.number)?.what ?? null,
    hasLog: latestLog(config.target.name, issue.number) !== null,
    asked: asked.get(issue.number) || null,
  });

  const today = new Date().toISOString().slice(0, 10);
  const spentToday = readRunLog(config.target.name, 500)
    .filter((e) => e.kind === "worker" && e.at.startsWith(today))
    .reduce((sum, e) => sum + (typeof e.data?.costUsd === "number" ? e.data.costUsd : 0), 0);

  return {
    target: config.target.name,
    repo: config.target.repo,
    labels: {
      agentReady: labels.agentReady,
      readyToFix: labels.readyToFix,
      needsInfo: labels.needsInfo,
      humanOwned: HUMAN_OWNED,
      needsDecision: labels.needsDecision,
    },
    // Order is the order the tiles appear in: what wants a person first.
    groups: [
      { key: "need-you", label: "need you", issues: needsDecision.filter(ours).map(row) },
      { key: "run-failed", label: "run failed", issues: runFailed.filter(ours).map(row) },
      { key: "reproduced", label: "reproduced", issues: readyToFix.filter(ours).map(row) },
      { key: "agent-ready", label: "agent-ready", issues: agentReady.filter(ours).map(row) },
      { key: "queued", label: "queued", issues: queued.filter(ours).map(row) },
      { key: "handed-off", label: "handed off", issues: humanOwned.filter(ours).map(row) },
      { key: "from-chat", label: "from chat", issues: fromChat.filter(ours).map(row) },
    ],
    canRun: loaded.repoPath !== null || resolveRole(config) === "intake",
    agentPrs: prs
      .filter((pr) => (pr.labels ?? []).some((l) => l.name === labels.agentPr))
      .map((pr) => ({ number: pr.number, url: pr.url, title: pr.title })),
    running: running.map((r) => ({ what: r.what, at: r.at, issue: r.issue ?? null })),
    spentToday,
    dailyBudgetUsd: config.worker.dailyBudgetUsd,
  };
}
