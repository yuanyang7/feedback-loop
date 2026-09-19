/**
 * The page. Plain HTML with inline CSS — this is a local read-only view over
 * files on disk, and a build step would be more machinery than the thing it
 * displays.
 */
import type { EvidencePair, RunSummary } from "./scan.js";

export interface Overview {
  target: string;
  repo: string;
  fromChat: number;
  agentReady: number;
  readyToFix: number;
  needsDecision: number;
  agentPrs: Array<{ number: number; url: string; title: string }>;
  running: Array<{ what: string; at: string }>;
  spentToday: number;
  dailyBudgetUsd: number;
}

const CSS = `
:root {
  --bg: #fbfbfa; --panel: #fff; --ink: #1a1a18; --muted: #6b6b66;
  --line: #e4e4e0; --accent: #2f6f4e; --warn: #9a6a1b; --bad: #a33a2a;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161715; --panel: #1e201d; --ink: #eceae4; --muted: #9a9a92;
    --line: #2e312d; --accent: #7fc09b; --warn: #d6a44d; --bad: #e08472;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 16px 80px; }
h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 32px 0 10px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1px;
  background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.stat { background: var(--panel); padding: 12px 14px; }
.stat b { display: block; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 12px; }
.run { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  margin-bottom: 12px; overflow: hidden; }
.run > summary { padding: 13px 16px; cursor: pointer; display: flex; gap: 10px;
  align-items: baseline; flex-wrap: wrap; list-style: none; }
.run > summary::-webkit-details-marker { display: none; }
.run > summary::before { content: "▸"; color: var(--muted); margin-right: 2px; }
.run[open] > summary::before { content: "▾"; }
.run-body { padding: 0 16px 18px; border-top: 1px solid var(--line); }
.tag { font-size: 11px; padding: 2px 7px; border-radius: 20px; border: 1px solid var(--line);
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.ok { color: var(--accent); border-color: currentColor; }
.warnc { color: var(--warn); border-color: currentColor; }
.badc { color: var(--bad); border-color: currentColor; }
.grow { flex: 1; }
.num { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; }
.pair { margin: 18px 0; }
.pair h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.shots figure { margin: 0; }
.shots figcaption { font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.05em; margin-bottom: 5px; }
.shots img { width: 100%; border: 1px solid var(--line); border-radius: 7px; display: block;
  background: #fff; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 5px 16px; margin: 10px 0; }
dt { color: var(--muted); font-size: 13px; }
dd { margin: 0; font-size: 14px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 11px;
  overflow: auto; font-size: 12.5px; max-height: 340px; }
a { color: inherit; }
.files { list-style: none; padding: 0; margin: 8px 0 0; font-size: 13px; }
.files li { padding: 2px 0; }
.empty { color: var(--muted); padding: 28px 0; }
dd > details > summary { cursor: pointer; color: var(--muted); }
dd > details[open] > summary { color: var(--ink); }
.more { margin-top: 7px; padding-left: 11px; border-left: 2px solid var(--line); white-space: pre-wrap; }
.run-body > h2:first-child { margin-top: 18px; }
.pair:first-of-type { margin-top: 18px; }
@media (max-width: 680px) { .shots { grid-template-columns: 1fr; } }
`;

export function renderPage(overview: Overview, runs: RunSummary[]): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>feedback-loop — ${esc(overview.target)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">
  <h1>${esc(overview.target)}</h1>
  <div class="sub">${esc(overview.repo)} · read-only view of <code>~/.feedback-loop</code></div>

  <div class="stats">
    ${stat(overview.fromChat, "from chat")}
    ${stat(overview.agentReady, "agent-ready")}
    ${stat(overview.readyToFix, "reproduced")}
    ${stat(overview.needsDecision, "need you")}
    ${stat(overview.agentPrs.length, "open PRs")}
    ${stat(`$${overview.spentToday.toFixed(2)}`, `spent today of $${overview.dailyBudgetUsd}`)}
  </div>

  ${overview.running.length > 0 ? `<h2>Running now</h2><div class="card">${overview.running
    .map((r) => `<div>🔧 <b>${esc(r.what)}</b> <span class="num">since ${esc(r.at.slice(11, 16))} UTC</span></div>`)
    .join("")}</div>` : ""}

  ${overview.agentPrs.length > 0 ? `<h2>Waiting on you</h2><div class="card">${overview.agentPrs
    .map((pr) => `<div><a href="${esc(pr.url)}">#${pr.number}</a> ${esc(pr.title)}</div>`)
    .join("")}</div>` : ""}

  <h2>Runs</h2>
  ${runs.length === 0 ? '<p class="empty">No runs yet.</p>' : runs.map(renderRun).join("")}
</div></body></html>`;
}

function renderRun(run: RunSummary): string {
  const outcome = outcomeOf(run);
  const shots = run.evidence.filter((e) => !e.single);
  return `<details class="run"${shots.length > 0 ? " open" : ""}>
  <summary>
    <b>${run.issue ? `#${run.issue}` : run.id}</b>
    <span class="tag">${esc(run.kind)}</span>
    <span class="tag ${outcome.className}">${esc(outcome.label)}</span>
    <span class="grow"></span>
    <span class="num">${run.at.toISOString().slice(5, 16).replace("T", " ")} · $${run.costUsd.toFixed(2)} · ${run.phases.reduce((n, p) => n + p.turns, 0)} turns</span>
  </summary>
  <div class="run-body">
    ${shots.length > 0 ? shots.map((e) => renderPair(run, e)).join("") : ""}
    ${run.phases.map((p) => renderPhase(run, p)).join("")}
    ${run.attachments.length > 0 ? `<h2>Attachments</h2><ul class="files">${run.attachments
      .map((f) => `<li><a href="/evidence/${esc(run.id)}/${encodeURIComponent(f)}">${esc(f)}</a></li>`)
      .join("")}</ul>` : ""}
    ${run.readme ? `<h2>The run's own notes</h2><pre>${esc(run.readme)}</pre>` : ""}
  </div>
</details>`;
}

function renderPhase(run: RunSummary, phase: { name: string; verdict: Record<string, unknown> | null; costUsd: number; turns: number; sessionId: string | null }): string {
  const rows = phase.verdict
    ? Object.entries(phase.verdict)
        .filter(([, v]) => v !== "" && v !== null && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${value(Array.isArray(v) ? v.join(", ") : String(v))}</dd>`)
        .join("")
    : `<dt>verdict</dt><dd class="badc">none written — the phase did not finish</dd>`;

  return `<h2>${esc(phase.name)} <span class="num">· $${phase.costUsd.toFixed(2)} · ${phase.turns} turns</span></h2>
    <dl>${rows}</dl>
    ${phase.sessionId ? `<div class="num">replay: <code>claude --resume ${esc(phase.sessionId)}</code></div>` : ""}`;
}

/** Long prose folds away; a verdict has several fields that run to a page each. */
function value(text: string): string {
  if (text.length <= 220) return esc(text);
  return `<details><summary>${esc(text.slice(0, 200))}…</summary><div class="more">${esc(text)}</div></details>`;
}

function renderPair(run: RunSummary, pair: EvidencePair): string {
  const src = (f: string): string => `/evidence/${esc(run.id)}/${encodeURIComponent(f)}`;
  return `<div class="pair"><h4>${esc(pair.label.replace(/[-_]/g, " "))}</h4>
    <div class="shots">
      ${pair.before ? `<figure><figcaption>before</figcaption><a href="${src(pair.before)}"><img src="${src(pair.before)}" alt="before ${esc(pair.label)}" loading="lazy"></a></figure>` : ""}
      ${pair.after ? `<figure><figcaption>after</figcaption><a href="${src(pair.after)}"><img src="${src(pair.after)}" alt="after ${esc(pair.label)}" loading="lazy"></a></figure>` : ""}
    </div></div>`;
}

function outcomeOf(run: RunSummary): { label: string; className: string } {
  const last = run.phases.at(-1);
  if (!last || !last.verdict) return { label: "incomplete", className: "badc" };
  const v = last.verdict;
  if (typeof v.verdict === "string") {
    return v.verdict === "approve"
      ? { label: "review approved", className: "ok" }
      : { label: "review rejected", className: "warnc" };
  }
  if (v.blockedReason && v.blockedReason !== "none") {
    return { label: String(v.blockedReason), className: "warnc" };
  }
  if (v.reproduced === true) return { label: "reproduced", className: "ok" };
  if (v.implemented === true) return { label: "implemented", className: "ok" };
  return { label: "not reproduced", className: "warnc" };
}

function stat(value: string | number, label: string): string {
  return `<div class="stat"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
