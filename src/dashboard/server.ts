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
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { readSecret, resolveRole, type LoadedConfig } from "../core/config.js";
import { bold, cyan, dim, info, warn } from "../core/log.js";
import { readRunLog, runsDir } from "../core/state.js";
import { activeRuns } from "../intake/commands.js";
import { GitHubClient, issueOfPullRequest, type Issue } from "../intake/github.js";
import { agentdeckLink, HUMAN_OWNED } from "../worker/handoff.js";
import { targetStatus, type TargetStatus } from "./summary.js";
import { handoffInfo, isAction, latestLog, readLogTail, runAction } from "./actions.js";
import { renderPage, type IssueRow, type Overview } from "./render.js";
import { scanRuns } from "./scan.js";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8", ".patch": "text/plain; charset=utf-8",
};

export interface DashboardOptions {
  port: number;
  /**
   * Address to bind. Loopback by default, which is the only safe default:
   * this page has no login, and whoever can reach the port can read the
   * token out of the HTML and press the buttons that comment on issues and
   * clear the gate.
   *
   * Binding wider is for exactly one case — a private network you control,
   * such as a tailnet — and then the right value is that interface's address,
   * not 0.0.0.0. Bound to the tailnet address, the page is unreachable from
   * whatever café wifi the laptop is also on; bound to 0.0.0.0 it is not.
   */
  host?: string;
  /**
   * Extra `Host:` values to accept, for reaching it by name rather than by
   * address — a MagicDNS name, say. The bind address is accepted already.
   */
  allowHosts?: string[];
}

/** One mounted target: its config and the path prefix its page lives under. */
export interface Mounted {
  name: string;
  loaded: LoadedConfig;
}

/**
 * The machine's address on the tailnet, if it is up.
 *
 * Read from the interfaces rather than by shelling out to `tailscale`, which
 * lives in different places depending on how it was installed and is not on
 * a launchd job's PATH either way. Tailscale assigns out of 100.64.0.0/10,
 * the carrier-grade NAT range, and nothing else on a normal machine uses it.
 */
function tailnetAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const [a, b] = address.address.split(".").map(Number);
      if (a === 100 && b !== undefined && b >= 64 && b <= 127) return address.address;
    }
  }
  return null;
}

/**
 * Serve one target at `/`, or — given several — an index at `/` and each
 * target under `/<name>/`. The token and the Host check are per process
 * either way: one page, one origin, however many targets it shows.
 */
export async function serveDashboard(what: LoadedConfig | Mounted[], opts: DashboardOptions): Promise<void> {
  const { port } = opts;
  const targets: Mounted[] = Array.isArray(what) ? what : [{ name: what.config.target.name, loaded: what }];
  const multi = Array.isArray(what);
  // `--host tailscale` rather than a literal address, so a launchd job does
  // not hardcode something that changes when the tailnet is reset — and so
  // the plist reads as the intent instead of as a number.
  let host = opts.host ?? "127.0.0.1";
  if (host === "tailscale") {
    // Said once, not every pass. This waits indefinitely by design — the
    // interface may be minutes away at login, or weeks away if Tailscale is
    // not installed yet — and a line every ten seconds would bury the log
    // that is supposed to tell you what went wrong.
    for (let said = false; ; said = true) {
      const found = tailnetAddress();
      if (found) {
        if (said) info(`tailnet address is up: ${cyan(found)}`);
        host = found;
        break;
      }
      if (!said) warn("waiting for a tailnet address — is Tailscale running?");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  // Per process, and only ever written into the page this server renders. A
  // page on another origin can send a simple POST here but cannot set a custom
  // header without a preflight we never answer, and cannot read this token.
  const token = randomBytes(18).toString("hex");
  // The guard stays meaningful when the bind address widens: it is still a
  // closed list, just one that now includes however you reach this machine.
  const hosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `${host}:${port}`,
    // An IPv6 literal has to be bracketed in a Host header.
    ...(host.includes(":") ? [`[${host}]:${port}`] : []),
    ...(opts.allowHosts ?? []).map((h) => (h.includes(":") && !h.startsWith("[") ? h : `${h}:${port}`)),
  ]);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // DNS rebinding: a hostile name that resolves to 127.0.0.1 would be
      // same-origin with this page, able to read the token and press buttons.
      if (!hosts.has(req.headers.host ?? "")) {
        res.writeHead(421).end("wrong host");
        return;
      }

      if (!multi) {
        return handleTarget(targets[0]!.loaded, "", token, req, res, url, url.pathname);
      }
      if (url.pathname === "/") {
        return serveIndex(targets, token, req, res, url);
      }
      // `/<name>` and `/<name>/…` — the name is matched exactly against the
      // registry, so a path is never used to pick a directory.
      const [, first, ...rest] = url.pathname.split("/");
      const target = targets.find((t) => t.name === first);
      if (!target) {
        res.writeHead(404).end("not found");
        return;
      }
      if (rest.length === 0) {
        // The page's own links are absolute, but the browser resolves a bare
        // `/<name>` relative to `/`; send it to the canonical form.
        res.writeHead(302, { location: `/${first}/` }).end();
        return;
      }
      return handleTarget(target.loaded, `/${first}`, token, req, res, url, `/${rest.join("/")}`);
    })();
  });

  // A tailnet address does not exist until Tailscale is up, and at login
  // this can easily win that race. Retrying beats failing, because the thing
  // that would have to notice a failure is a launchd job nobody reads.
  let warnedUnavailable = false;
  for (;;) {
    try {
      await new Promise<void>((ready, broken) => {
        server.once("error", broken);
        server.listen(port, host, () => {
          server.removeListener("error", broken);
          ready();
        });
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") throw error;
      if (!warnedUnavailable) {
        warn(`${host} is not up on this machine yet — retrying every 10s`);
        warnedUnavailable = true;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  info(`${bold("dashboard")} ${cyan(origin)} ${dim("— ctrl-c to stop")}`);
  if (multi) for (const t of targets) info(`  ${t.name.padEnd(20)} ${cyan(`${origin}/${t.name}/`)}`);
  if (!loopback) {
    // Say it plainly rather than in a doc nobody re-reads: the network is the
    // whole access control here.
    warn(
      `reachable from ${host === "0.0.0.0" ? "every network this machine is on" : host} — this page has no login, ` +
        `and anyone who loads it can comment on issues and clear the gate. Keep it on a network you control.`,
    );
  }
  await new Promise(() => {}); // serve until interrupted
}

/**
 * One target's routes, relative to `base`. `path` is the part of the URL
 * after the prefix, so the handlers are the same whether or not there is one.
 */
async function handleTarget(
  loaded: LoadedConfig,
  base: string,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
): Promise<void> {
  const target = loaded.config.target.name;
  if (path === "/api/action") {
    return handleAction(loaded, token, req, res);
  }
  if (path === "/api/handoff") {
    if (!authorised(req, token)) return json(res, 403, { ok: false, message: "Reload the page — its token is stale." });
    const issue = Number(url.searchParams.get("issue"));
    if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { ok: false, message: "bad issue" });
    const found = handoffInfo(loaded, issue);
    return found
      ? json(res, 200, { ok: true, handoff: found })
      : json(res, 404, { ok: false, message: `No handoff worktree with a HANDOFF.md for #${issue} on this machine.` });
  }
  if (path === "/api/log") {
    return handleLog(target, token, req, url, res);
  }
  if (path === "/api/status") {
    if (!authorised(req, token)) return json(res, 403, { ok: false, message: "Reload the page — its token is stale." });
    try {
      return json(res, 200, { ok: true, status: await targetStatus(loaded) });
    } catch (error) {
      return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (path.startsWith("/evidence/")) {
    return serveEvidence(resolve(runsDir(target)), path, res);
  }
  if (path !== "/") {
    res.writeHead(404).end("not found");
    return;
  }

  try {
    const overview = await buildOverview(loaded);
    const html = renderPage(overview, scanRuns(target), token, base);
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
}

/**
 * The `--all` front page: every target, with the same counts `status --json`
 * prints. One target's GitHub being unreachable shows as a row saying so,
 * not as a blank page for all of them.
 */
async function serveIndex(targets: Mounted[], token: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const rows = await Promise.all(
    targets.map(async (t): Promise<{ name: string; status: TargetStatus | null; error: string | null }> => {
      try {
        return { name: t.name, status: await targetStatus(t.loaded), error: null };
      } catch (error) {
        return { name: t.name, status: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  if (url.searchParams.get("format") === "json") {
    if (!authorised(req, token)) return json(res, 403, { ok: false, message: "token" });
    return json(res, 200, { ok: true, targets: rows });
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
  }).end(renderIndex(rows));
}

function renderIndex(rows: Array<{ name: string; status: TargetStatus | null; error: string | null }>): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const columns: Array<[keyof TargetStatus["counts"], string]> = [
    ["needsYou", "need you"], ["needsInfo", "needs info"], ["reproduced", "reproduced"], ["agentReady", "agent-ready"],
    ["inProgress", "in progress"], ["prReady", "PRs open"],
  ];
  const cell = (n: number): string => `<td class="num${n > 0 ? " on" : ""}">${n}</td>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>feedback-loop — all targets</title>
<style>
:root { --bg: #fbfbfa; --panel: #fff; --ink: #1a1a18; --muted: #6b6b66; --line: #e4e4e0; --accent: #2f6f4e; --bad: #a33a2a; }
@media (prefers-color-scheme: dark) { :root { --bg: #161715; --panel: #1e201d; --ink: #eceae4; --muted: #9a9a92; --line: #2e312d; --accent: #7fc09b; --bad: #e08472; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 16px 80px; }
h1 { font-size: 20px; margin: 0 0 2px; } .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { padding: 10px 12px; text-align: left; border-top: 1px solid var(--line); }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border-top: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
td.num.on { color: var(--ink); font-weight: 600; }
a { color: inherit; } .repo { color: var(--muted); font-size: 13px; } .bad { color: var(--bad); font-size: 13px; }
.run { color: var(--accent); font-size: 12px; }
</style></head><body><div class="wrap">
<h1>feedback-loop</h1>
<div class="sub">${rows.length} target${rows.length === 1 ? "" : "s"} · each row is what <code>status --json</code> says</div>
<table><thead><tr><th>target</th>${columns.map(([, label]) => `<th style="text-align:right">${esc(label)}</th>`).join("")}</tr></thead><tbody>
${rows
  .map((r) =>
    r.status
      ? `<tr><td><a href="/${encodeURIComponent(r.name)}/"><b>${esc(r.name)}</b></a> <span class="repo">${esc(r.status.repo)}</span>${
          r.status.running.length > 0 ? `<div class="run">🔧 ${esc(r.status.running.map((x) => `${x.verb} #${x.issue ?? "?"}`).join(", "))}</div>` : ""
        }</td>${columns.map(([key]) => cell(r.status!.counts[key])).join("")}</tr>`
      : `<tr><td><a href="/${encodeURIComponent(r.name)}/"><b>${esc(r.name)}</b></a><div class="bad">${esc(r.error ?? "unavailable")}</div></td>${columns.map(() => `<td class="num">–</td>`).join("")}</tr>`,
  )
  .join("\n")}
</tbody></table>
</div></body></html>`;
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

export async function buildOverview(loaded: LoadedConfig): Promise<Overview> {
  const { config } = loaded;
  const labels = config.github.labels;
  const github = new GitHubClient(
    config.target.repo,
    config.github.tokenFile ? readSecret(config.github.tokenFile, "GITHUB_TOKEN") : undefined,
  );

  const [fromChat, agentReady, readyToFix, needsDecision, runFailed, queued, humanOwned, prs, needsInfo, inProgress] = await Promise.all([
    github.listIssues({ labels: [labels.source], state: "open" }),
    github.listIssues({ labels: [labels.agentReady], state: "open" }),
    github.listIssues({ labels: [labels.readyToFix], state: "open" }),
    github.listIssues({ labels: [labels.needsDecision], state: "open" }),
    github.listIssues({ labels: [labels.runFailed], state: "open" }),
    github.listIssues({ labels: [labels.requested], state: "open" }),
    github.listIssues({ labels: [HUMAN_OWNED], state: "open" }),
    github.listPullRequests({ state: "open" }),
    github.listIssues({ labels: [labels.needsInfo], state: "open" }),
    github.listIssues({ labels: ["in-progress"], state: "open" }),
  ]);
  // Most recently closed first is how gh returns them; a hundred is enough to
  // fill the list after the filter below drops issues the loop never saw.
  const closed = await github.listIssues({ state: "closed", limit: 100 }).catch(() => []);
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
    worktree: worktreeOf(issue),
  });
  // Only a handed-off issue has a worktree a person is in; looking for one on
  // every row would read every HANDOFF.md once per issue.
  function worktreeOf(issue: Issue): IssueRow["worktree"] {
    if (!issue.labels.some((l) => l.name === HUMAN_OWNED)) return null;
    const found = handoffInfo(loaded, issue.number);
    return found ? { path: found.path, agentdeck: agentdeckLink(config, found.path) } : null;
  }

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
      {
        key: "completed",
        label: "completed",
        issues: closed.filter(ours).slice(0, 30).map((issue) => {
          const r = row(issue);
          // Why it closed is the one thing worth knowing about a closed issue.
          if (issue.stateReason) r.labels = [issue.stateReason.toLowerCase().replace("_", " "), ...r.labels];
          return r;
        }),
      },
    ],
    canRun: loaded.repoPath !== null || resolveRole(config) === "intake",
    agentPrs: prs
      .filter((pr) => (pr.labels ?? []).some((l) => l.name === labels.agentPr))
      .map((pr) => ({ number: pr.number, url: pr.url, title: pr.title, issue: issueOfPullRequest(pr) })),
    running: running.map((r) => ({ what: r.what, at: r.at, issue: r.issue ?? null, pid: r.pid })),
    spentToday,
    dailyBudgetUsd: config.worker.dailyBudgetUsd,
    needsInfo: needsInfo.filter(ours).length,
    inProgress: inProgress.filter(ours).length,
  };
}
