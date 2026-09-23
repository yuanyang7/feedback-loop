/**
 * The page. Plain HTML with inline CSS and one small script — this is a local
 * view over files on disk and a few GitHub lists, and a build step would be
 * more machinery than the thing it displays.
 */
import type { EvidencePair, RunSummary } from "./scan.js";

export interface IssueRow {
  number: number;
  title: string;
  url: string;
  labels: string[];
  /** What is running on it right now, e.g. "fix #1210", or null. */
  running: string | null;
  hasLog: boolean;
  /** For an escalated issue, the loop's last comment on it. */
  asked: string | null;
}

export interface IssueGroup {
  key: string;
  label: string;
  issues: IssueRow[];
}

export interface Overview {
  target: string;
  repo: string;
  /** Label names the buttons key off, as this target configured them. */
  labels: { agentReady: string; readyToFix: string; needsInfo: string; humanOwned: string; needsDecision: string };
  groups: IssueGroup[];
  /** False when this process has no checkout to start a run in. */
  canRun: boolean;
  agentPrs: Array<{ number: number; url: string; title: string }>;
  running: Array<{ what: string; at: string; issue: number | null }>;
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
.stats { display: flex; flex-wrap: wrap; gap: 1px;
  background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.stat { flex: 1 1 110px; background: var(--panel); padding: 12px 14px; border: 0; text-align: left; color: inherit;
  font: inherit; }
button.stat { cursor: pointer; }
button.stat:hover { background: var(--bg); }
button.stat[aria-expanded="true"] { box-shadow: inset 0 -2px 0 var(--accent); }
button.stat:disabled { cursor: default; opacity: 0.55; }
.group { margin-top: 12px; }
.group h2 { margin-top: 20px; }
.issue { display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; padding: 10px 0;
  border-top: 1px solid var(--line); }
.issue:first-child { border-top: 0; }
.issue .title { flex: 1 1 260px; min-width: 0; }
.chips { display: inline-flex; gap: 4px; flex-wrap: wrap; margin-left: 6px; vertical-align: 1px; }
.chip { font-size: 10.5px; padding: 1px 6px; border-radius: 20px; background: var(--bg);
  border: 1px solid var(--line); color: var(--muted); }
.acts { display: flex; gap: 6px; flex-wrap: wrap; }
.act { font: inherit; font-size: 12.5px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
.act:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.act.primary { border-color: var(--accent); color: var(--accent); }
.act:disabled { opacity: 0.45; cursor: not-allowed; }
.run-acts { margin-top: 14px; }
.answer { flex: 1 1 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-top: 2px; }
.answer textarea { width: 100%; font: inherit; font-size: 14px; padding: 8px 10px; border-radius: 7px;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink); resize: vertical; }
.answer textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.answer summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.answer pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
.toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); max-width: min(640px, calc(100% - 32px));
  background: var(--ink); color: var(--bg); padding: 10px 14px; border-radius: 9px; font-size: 13.5px;
  white-space: pre-wrap; box-shadow: 0 6px 24px rgba(0,0,0,.2); z-index: 10; }
.toast.bad { background: var(--bad); color: #fff; }
dialog { width: min(920px, calc(100% - 32px)); border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel); color: var(--ink); padding: 0; }
dialog::backdrop { background: rgba(0,0,0,.35); }
dialog header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.ho-body { padding: 14px 16px 18px; }
.ho-body h4 { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 6px; font-size: 13px; }
.ho-body pre { white-space: pre-wrap; word-break: break-word; }
.ho-row { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
.ho-row code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 12.5px; }
#log pre { margin: 0; border: 0; border-radius: 0; max-height: 70vh; }
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

export function renderPage(overview: Overview, runs: RunSummary[], token: string): string {
  const rows = new Map<number, IssueRow>();
  for (const group of overview.groups) for (const issue of group.issues) rows.set(issue.number, issue);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>feedback-loop — ${esc(overview.target)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">
  <h1>${esc(overview.target)}</h1>
  <div class="sub">${esc(overview.repo)} · view of <code>~/.feedback-loop</code> and the GitHub queue · click a number to list it</div>

  <div class="stats">
    ${overview.groups.map((g) => groupTile(g.key, g.issues.length, g.label)).join("")}
    ${groupTile("prs", overview.agentPrs.length, "open PRs")}
    <div class="stat"><b>$${overview.spentToday.toFixed(2)}</b><span>spent today of $${esc(String(overview.dailyBudgetUsd))}</span></div>
  </div>

  ${overview.groups.map((g) => `<section class="group card" id="g-${esc(g.key)}" hidden>
    ${g.issues.map((issue) => renderIssue(issue, overview, g.key === "need-you")).join("")}
  </section>`).join("")}
  <section class="group card" id="g-prs" hidden>
    ${overview.agentPrs.map((pr) => `<div class="issue"><span class="title"><a href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a> ${esc(pr.title)}</span></div>`).join("")}
  </section>

  ${overview.running.length > 0 ? `<h2>Running now</h2><div class="card">${overview.running
    .map((r) => `<div class="issue"><span class="title">🔧 <b>${esc(r.what)}</b> <span class="num">since ${esc(r.at.slice(11, 16))} UTC</span></span>
      ${r.issue ? `<div class="acts">${button("log", r.issue)}</div>` : ""}</div>`)
    .join("")}</div>` : ""}

  ${overview.agentPrs.length > 0 ? `<h2>Waiting on you</h2><div class="card">${overview.agentPrs
    .map((pr) => `<div><a href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a> ${esc(pr.title)}</div>`)
    .join("")}</div>` : ""}

  <h2>Runs</h2>
  ${runs.length === 0 ? '<p class="empty">No runs yet.</p>' : runs.map((run) => renderRun(run, overview, rows)).join("")}
</div>
<dialog id="log"><header><b id="log-title">log</b><span class="num" id="log-state"></span><span class="grow"></span>
  <button class="act" id="log-close">close</button></header><pre id="log-text"></pre></dialog>
<dialog id="handoff"><header><b id="ho-title">handed off</b><span class="grow"></span>
  <button class="act" id="ho-close">close</button></header>
  <div class="ho-body">
    <div class="ho-row"><span class="num">worktree</span><code id="ho-path"></code><button class="act" data-copy="ho-path">copy</button></div>
    <div class="ho-row"><span class="num">branch</span><code id="ho-branch"></code></div>
    <h4>Prompt for an agent <button class="act primary" data-copy="ho-prompt">copy prompt</button></h4>
    <pre id="ho-prompt"></pre>
    <h4>Or start one from a terminal <button class="act" data-copy="ho-command">copy command</button></h4>
    <pre id="ho-command"></pre>
  </div></dialog>
<script>const TOKEN = ${JSON.stringify(token)};${SCRIPT}</script>
</body></html>`;
}

function groupTile(key: string, count: number, label: string): string {
  return `<button class="stat" data-group="${esc(key)}" aria-expanded="false" aria-controls="g-${esc(key)}"${count === 0 ? " disabled" : ""}>
    <b>${count}</b><span>${esc(label)}</span></button>`;
}

/**
 * Which verbs to offer. The server re-checks every one against the same gates
 * as chat — this only keeps buttons off rows where they would certainly be
 * refused, so what is left on a row is what can actually be done to it.
 */
function actionsFor(issue: IssueRow, overview: Overview): string {
  const has = (label: string): boolean => issue.labels.includes(label);
  const live = issue.running !== null;
  const buttons: string[] = [];
  if (has(overview.labels.humanOwned)) {
    buttons.push(button("prompt", issue.number, { primary: true }));
    buttons.push(button("back", issue.number));
  } else {
    const thin = has(overview.labels.needsInfo);
    if (!has(overview.labels.agentReady)) buttons.push(button("ready", issue.number, { disabled: thin }));
    if (overview.canRun) {
      if (has(overview.labels.agentReady)) buttons.push(button("triage", issue.number, { disabled: live || thin, primary: !has(overview.labels.readyToFix) }));
      if (has(overview.labels.readyToFix)) buttons.push(button("fix", issue.number, { disabled: live || thin, primary: true }));
      buttons.push(button("go", issue.number, { disabled: live || thin }));
    }
    buttons.push(button("mine", issue.number, { disabled: live }));
  }
  if (issue.hasLog || live) buttons.push(button("log", issue.number));
  return `<div class="acts">${buttons.join("")}</div>`;
}

const LABELS: Record<string, string> = {
  ready: "ready", triage: "triage", fix: "fix", go: "go", mine: "hand off to me", back: "hand back", log: "log", prompt: "agent prompt",
};
const TITLES: Record<string, string> = {
  ready: "Clear it for an autonomous attempt (adds the agent-ready label)",
  triage: "Reproduce and size it. Never edits code.",
  fix: "Implement, review adversarially, open a PR. Never merges.",
  go: "Clear, reproduce, fix and open a PR in one run",
  mine: "Take it off the loop and set up a worktree for you",
  back: "Give it back to the loop",
  log: "Show the latest worker log",
  prompt: "Worktree path and a prompt to start an agent on it",
};

function button(action: string, issue: number, opts: { disabled?: boolean; primary?: boolean } = {}): string {
  return `<button class="act${opts.primary ? " primary" : ""}" data-action="${action}" data-issue="${issue}" title="${esc(TITLES[action] ?? action)}"${opts.disabled ? " disabled" : ""}>${esc(LABELS[action] ?? action)}</button>`;
}

function renderIssue(issue: IssueRow, overview: Overview, answerable = false): string {
  const chips = issue.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join("");
  return `<div class="issue">
    <span class="title"><a href="${esc(issue.url)}" target="_blank" rel="noopener"><b>#${issue.number}</b></a> ${esc(issue.title)}
      ${issue.running ? `<span class="tag ok">${esc(issue.running)}</span>` : ""}
      <span class="chips">${chips}</span></span>
    ${actionsFor(issue, overview)}
    ${answerable && !issue.labels.includes(overview.labels.humanOwned) ? answerBox(issue, overview) : ""}
  </div>`;
}

/** The reply box on an issue the loop is waiting on a person for. */
function answerBox(issue: IssueRow, overview: Overview): string {
  return `<form class="answer" data-issue="${issue.number}">
    ${issue.asked ? `<details><summary>What the loop said</summary><pre>${esc(issue.asked)}</pre></details>` : ""}
    <textarea name="text" rows="3" placeholder="Your decision — the next triage/fix run for #${issue.number} reads this. e.g. &quot;Only fix the iOS side; leave web alone.&quot;"></textarea>
    <div class="acts">
      <button class="act" type="submit" value="none">post answer</button>
      ${overview.canRun ? `<button class="act" type="submit" value="triage">answer &amp; re-triage</button>
      <button class="act primary" type="submit" value="go">answer &amp; go</button>` : ""}
    </div>
  </form>`;
}

function renderRun(run: RunSummary, overview: Overview, rows: Map<number, IssueRow>): string {
  const outcome = outcomeOf(run);
  const shots = run.evidence.filter((e) => !e.single);
  const row = run.issue ? rows.get(run.issue) : undefined;
  return `<details class="run"${shots.length > 0 ? " open" : ""}>
  <summary>
    <b>${run.issue ? `#${run.issue}` : run.id}</b>
    ${row ? `<span>${esc(row.title)}</span>` : ""}
    <span class="tag">${esc(run.kind)}</span>
    <span class="tag ${outcome.className}">${esc(outcome.label)}</span>
    <span class="grow"></span>
    <span class="num">${run.at.toISOString().slice(5, 16).replace("T", " ")} · $${run.costUsd.toFixed(2)} · ${run.phases.reduce((n, p) => n + p.turns, 0)} turns</span>
  </summary>
  <div class="run-body">
    ${run.issue ? `<div class="run-acts">${row ? actionsFor(row, overview) : `<div class="acts">${button("log", run.issue)}</div>`}</div>` : ""}
    ${shots.length > 0 ? shots.map((e) => renderPair(run, e)).join("") : ""}
    ${run.phases.map((p) => renderPhase(run, p)).join("")}
    ${run.attachments.length > 0 ? `<h2>Attachments</h2><ul class="files">${run.attachments
      .map((f) => `<li><a href="/evidence/${esc(run.id)}/${encodeURIComponent(f)}">${esc(f)}</a></li>`)
      .join("")}</ul>` : ""}
    ${run.readme ? `<h2>The run's own notes</h2><pre>${esc(run.readme)}</pre>` : ""}
  </div>
</details>`;
}

/**
 * Plain script, no framework. Which group is open lives in the URL hash so the
 * reload after a button press lands where you were.
 */
const SCRIPT = `
const $ = (s) => document.querySelector(s);
function openGroup(key) {
  document.querySelectorAll("button.stat[data-group]").forEach((b) => {
    const on = b.dataset.group === key;
    b.setAttribute("aria-expanded", String(on));
    document.getElementById("g-" + b.dataset.group).hidden = !on;
  });
  history.replaceState(null, "", key ? "#g=" + key : location.pathname);
}
document.querySelectorAll("button.stat[data-group]").forEach((b) => b.addEventListener("click", () =>
  openGroup(b.getAttribute("aria-expanded") === "true" ? null : b.dataset.group)));
function fromHash() {
  const m = /^#g=([\\w-]+)$/.exec(location.hash);
  if (m && document.getElementById("g-" + m[1])) openGroup(m[1]);
}
fromHash();
addEventListener("hashchange", fromHash);

let toastTimer;
function toast(text, bad) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); document.body.append(t); }
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 9000 : 4000);
}

const CONFIRM = {
  triage: "Start triage on #N? It runs an agent and spends budget.",
  fix: "Start a fix on #N? It runs an agent, spends budget and opens a PR.",
  go: "Clear, triage and fix #N in one run? It spends budget and opens a PR.",
  mine: "Take #N off the loop and set up a worktree for yourself?",
};

let logTimer;
let logFor = 0;
async function showLog(issue) {
  const dialog = $("#log");
  $("#log-title").textContent = "#" + issue;
  const token = ++logFor;
  const load = async () => {
    let body;
    try {
      const res = await fetch("/api/log?issue=" + issue, { headers: { "x-feedback-loop-token": TOKEN } });
      body = await res.json();
    } catch (error) {
      body = { ok: false, message: "Couldn't load the log: " + error };
    }
    // A slow answer for the log that was open before this one.
    if (token !== logFor || !dialog.open) return;
    const pre = $("#log-text");
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = body.ok ? body.text : body.message;
    $("#log-state").textContent = body.ok ? (body.running ? "live · refreshing" : body.path) : "";
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    clearTimeout(logTimer);
    if (body.ok && body.running && dialog.open) logTimer = setTimeout(load, 3000);
  };
  if (!dialog.open) dialog.showModal();
  $("#log-text").textContent = "loading…";
  await load();
}
$("#log-close").addEventListener("click", () => $("#log").close());
$("#log").addEventListener("close", () => clearTimeout(logTimer));

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form.answer");
  if (!form) return;
  event.preventDefault();
  const then = event.submitter ? event.submitter.value : "none";
  const issue = Number(form.dataset.issue);
  const text = form.elements.text.value;
  if (!text.trim()) return toast("Write an answer first.", true);
  if (then !== "none" && !confirm((then === "go" ? "Post the answer and start go on #" : "Post the answer and re-triage #") + issue + "? It spends budget.")) return;
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-feedback-loop-token": TOKEN },
      body: JSON.stringify({ action: "decide", issue, text, then }),
    });
    const body = await res.json().catch(() => ({ ok: false, message: "HTTP " + res.status }));
    toast(body.message, !body.ok);
    if (body.ok) return setTimeout(() => location.reload(), 1800);
  } catch (error) { toast(String(error), true); }
  buttons.forEach((b) => (b.disabled = false));
});

function showHandoff(h) {
  $("#ho-title").textContent = "#" + h.issue + " is yours";
  $("#ho-path").textContent = h.path;
  $("#ho-branch").textContent = h.branch || "(unknown)";
  $("#ho-prompt").textContent = h.prompt;
  $("#ho-command").textContent = h.command;
  $("#handoff").showModal();
}
$("#ho-close").addEventListener("click", () => $("#handoff").close());
// Reload once it is dismissed, not before: the row it came from has changed,
// but the reload would take the panel with it.
$("#handoff").addEventListener("close", () => { if (handoffReload) location.reload(); });
let handoffReload = false;
document.addEventListener("click", async (event) => {
  const c = event.target.closest("button[data-copy]");
  if (!c) return;
  try {
    await navigator.clipboard.writeText(document.getElementById(c.dataset.copy).textContent);
    const was = c.textContent;
    c.textContent = "copied";
    setTimeout(() => (c.textContent = was), 1200);
  } catch { toast("Couldn't copy — select the text instead.", true); }
});
async function fetchHandoff(issue) {
  const res = await fetch("/api/handoff?issue=" + issue, { headers: { "x-feedback-loop-token": TOKEN } });
  const body = await res.json().catch(() => ({ ok: false, message: "HTTP " + res.status }));
  if (body.ok) showHandoff(body.handoff); else toast(body.message, true);
}

document.addEventListener("click", async (event) => {
  const b = event.target.closest("button.act[data-action]");
  if (!b || b.disabled) return;
  const action = b.dataset.action;
  const issue = Number(b.dataset.issue);
  if (action === "log") return showLog(issue);
  if (action === "prompt") return fetchHandoff(issue);
  if (CONFIRM[action] && !confirm(CONFIRM[action].replace("#N", "#" + issue))) return;
  const siblings = [...b.parentElement.querySelectorAll("button.act")].filter((s) => !s.disabled);
  siblings.forEach((s) => (s.disabled = true));
  const label = b.textContent;
  b.textContent = "…";
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-feedback-loop-token": TOKEN },
      body: JSON.stringify({ action, issue }),
    });
    const body = await res.json().catch(() => ({ ok: false, message: "HTTP " + res.status }));
    if (body.ok && body.handoff) {
      handoffReload = true;
      return showHandoff(body.handoff);
    }
    toast(body.message, !body.ok);
    if (body.ok) return setTimeout(() => location.reload(), 1500);
  } catch (error) {
    toast(String(error), true);
  }
  b.textContent = label;
  siblings.forEach((s) => (s.disabled = false));
});
`;

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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
