# feedback-loop — design

Turn chat feedback into reviewed, verified pull requests, and stop at the merge button.

```
Discord thread ──▶ intake (Sonnet) ──▶ GitHub issue ──▶ worker (Opus) ──▶ draft-ready PR ──▶ you merge
      ▲                                                                                        │
      └──────────────────── emoji reactions mirror the state ◀─────────────────────────────────┘
```

## 1. Principles

1. **GitHub Issues *is* the ticket system.** No second database, no sync problem. Labels carry
   routing state, the issue thread carries the audit trail, and the fixer has to end up in GitHub
   anyway. The only local state is a read cursor and a run log.
2. **Generation is easy; verification is the product.** An agent that opens plausible-looking PRs
   you can't trust is a backlog generator, not a teammate. Every rule below that looks like a
   restriction exists to protect review capacity.
3. **The tool is generic; the repo carries its conventions.** This repo never contains target-repo
   code, secrets, or workflow details. A target repo describes itself in `.feedback-loop/`.
4. **Chat is untrusted input.** Anyone in the server can type "ignore previous instructions". Message
   text is *data to classify*, never instructions to follow.
5. **Nothing merges, nothing releases, nothing touches production.** Ever. Not behind a flag.

## 2. The two processes

They are deliberately separate: different models, different cadence, different blast radius. The
intake half is useful on its own and should run alone for a while before the worker is switched on.

### 2.1 Intake — cheap, frequent, low-risk

Runs on a timer (default 10 min). Model: Sonnet.

```
fetch messages since cursor          (Discord REST)
  → group consecutive messages from one author into candidate reports
  → classify each: bug | feature | question | noise  (+ title, body, severity, size hint, confidence)
  → dedupe against open `from-discord` issues
  → create issue, or link to the duplicate
  → react on the source message
  → advance cursor
```

Two things make this survivable:

- **Confidence floor.** Below the threshold, intake still files, but labels the issue `needs-info`
  and reacts `❓`. Dropping it would lose a real report silently whenever nobody circles back —
  the same failure mode as a wrong duplicate, and the costs are equally asymmetric. `needs-info`
  issues are never picked up by the worker.
- **Dedupe before create.** Open `from-discord` issue titles + bodies go into the classification
  call. Five people reporting one bug is one issue with five links, not five issues.

### 2.2 Reconcile — the emoji state machine

State changes happen in GitHub (you merge the PR), not in Discord. So each intake tick also runs a
reconcile pass. It needs no extra storage: the link back to Discord lives in a machine-readable
footer inside the issue body.

```html
<!-- feedback-loop:v1 {"guild":"…","channel":"…","messages":["…"],"reportedBy":["…"]} -->
```

Reconcile lists `from-discord` issues, parses the footer, derives the state, and sets exactly one
state reaction on each source message (removing the previous one).

| emoji | state | set by |
|---|---|---|
| 📝 | logged as an issue | intake |
| 🔁 | duplicate of an existing issue | intake |
| ❓ | filed, but too thin to act on — needs the reporter | intake |
| 🔧 | a worker run is in progress | worker |
| ✅ | PR open and ready for your review | worker |
| 🤔 | escalated — needs a decision, no PR | worker |
| 🚢 | merged into `dev` | reconcile |
| ❌ | closed without a fix | reconcile |

### 2.3 Worker — expensive, capped, gated

Runs on demand or on a slow timer. Driven by the Claude Agent SDK against a real checkout on your
machine (not CI — the fix loop needs the local dev database and app).

```
gate     open agent PRs < maxOpenPRs ?   no → stop, do nothing
         daily spend < budget ?          no → stop, do nothing
pick     highest-severity `agent-ready` issue with no active run

  phase 1  REPRO    sonnet/low     reproduce the reported bug in the local lab, capture evidence
             └─ cannot reproduce → comment what was tried, label `needs-decision`, react 🤔, STOP
  phase 2  SIZE     sonnet/low     read the real code, re-estimate, choose model + effort for the fix
             └─ touches a denylisted path, or size L → `needs-decision`, react 🤔, STOP
  phase 3  FIX      routed         worktree off dev, lab setup, fix, verify, screenshots
  phase 4  REVIEW   opus/high      adversarial review subagent; findings are blockers, loop to 3
  phase 5  SHIP     —              push, open PR against dev, attach artifacts, react ✅, STOP
```

**Phase 1 is the whole design.** An agent that never reproduced the bug is guessing, and a
plausible guess is worse than nothing because it consumes a careful review. "Couldn't reproduce" is
a first-class, respectable outcome that costs you a 30-second read instead of a 20-minute one.

**Phase 2 re-estimates from the code.** Intake's size hint is routing only — it was made by a model
that never saw the repository. The worker may escalate effort or bail; it may never downgrade below
what intake flagged.

#### Routing table

| size | fix model | effort | notes |
|---|---|---|---|
| S — copy, styling, off-by-one, obvious null check | sonnet | low | |
| M — logic inside one module, with tests | opus | medium | |
| L — cross-cutting, schema, API contract, perf | — | — | never auto-fixed; `needs-decision` |

#### Path denylist (config, per target)

Any diff touching these aborts to `needs-decision` regardless of size: database schema and
migrations, auth, anything money-related, CI workflow files, release scripts, and the
`.feedback-loop/` config itself. These are the changes where a wrong-but-plausible fix is most
expensive and where a human decision is the actual work.

## 3. Caps — the part that decides whether this works

| cap | default | why |
|---|---|---|
| `maxOpenPRs` | 3 | The worker does not start new work until you drain the queue. Without this you get a PR firehose and review becomes the bottleneck you were trying to remove. |
| `maxRunsPerDay` | 10 | Bounds cost and blast radius while you still don't trust it. |
| `dailyBudgetUsd` | 15 | Hard stop, not a warning. |
| `maxFixAttempts` | 2 | After two failed review loops, escalate rather than grind. |
| worktree GC | on merge/abandon | The target repo already has ~35 stale worktrees from ad-hoc agent runs. An uncapped worker makes that worse fast, so cleanup is a phase, not an afterthought. |

## 4. Observability

Most of the dashboard already exists — it's called GitHub. The queue, the diffs, the discussion,
and the merge button are all there and better than anything worth rebuilding.

What GitHub *cannot* show you is the part that would make you distrust the system: what a run is
doing right now, what it cost, what it tried before it gave up, and the before/after screenshots
that justify a fix. So the dashboard is scoped to exactly that gap.

- **`feedback-loop status`** — one screen: queue counts, active run + current phase, today's spend,
  last 10 runs with outcomes. This is the real interface and comes first.
- **`feedback-loop dashboard`** — a local page on `localhost:7777`, regenerated from the run log.
  Adds what a terminal can't do: inline before/after screenshots, the repro evidence, the
  adversarial review findings, and a link straight to the PR. Each queue count opens its issues,
  and each issue has the chat verbs as buttons — the same closed set, gates and queue, so the page
  is another front door rather than a second policy. No cloud, no database; the only auth is a
  per-process token baked into the page plus a `Host` check, which is what stops another browser
  tab (or a rebinding DNS name) from pressing the buttons.

Run artifacts live at `~/.feedback-loop/runs/<run-id>/` — transcript, evidence, screenshots, cost,
final status. The PR body links back to the dashboard; the dashboard serves the images.

## 5. Integration with a target repo

The tool takes a path. Everything repo-specific lives in the target repo, which keeps this repo
publishable and makes a second target a config file rather than a fork.

```
feedback-loop (public, this repo)      target repo (private)
├─ src/intake/    chat → issues        └─ .feedback-loop/
├─ src/worker/    issues → PRs            ├─ config.yml    channel, labels, caps, denylist
├─ src/dashboard/ status + local page     └─ playbook.md   how to set up, verify and ship here
└─ prompts/       generic templates
```

`playbook.md` is appended verbatim to the worker's system prompt. For a repo that already documents
its agent workflow — worktree conventions, local dev database setup, the verify recipe, the ship
script — the playbook is mostly a pointer to those files rather than a rewrite of them.

Secrets stay where they already are: the Discord bot token and GitHub token are read from paths
named in config, never copied into this repo, never committed.

## 6. Forwarding a task by @-mention

Not new machinery — a second trigger into the same intake path. Mention the bot (or reply to any
message with a trigger phrase) and that message is classified and filed immediately, bypassing the
timer and the confidence floor, because an explicit human ask is not a guess.

## 7. Threat model

| risk | mitigation |
|---|---|
| Prompt injection from chat | Message text is delivered inside a data block with a classify-only instruction. Intake has no write tools beyond "create issue". The worker never sees raw chat — it sees an issue framed as a report. |
| Injection via issue body | Worker prompt states the body is a user-submitted report, not instruction. Tool allowlist is narrow; no network writes. |
| Destructive git action | Worker is forbidden `master`, force-push, branch deletion beyond its own worktree, and the release script. It opens PRs and never merges. |
| Runaway cost | Budget + run caps checked before every phase, not just at pick time. |
| Leaking private code | This repo holds no target code. Artifacts stay local. Nothing is uploaded anywhere. |

## 8. Build order

1. **Intake + reconcile.** Useful alone. Run it against one channel for a week and read every issue
   it files before anything else is built.
2. **`status`.** Needed before the worker exists, so the worker is never a black box.
3. **Worker phases 1–2 only** (repro + size, no fixing). It comments its findings on issues. This is
   where you learn whether the repro gate actually holds, at near-zero risk.
4. **Worker phases 3–5.** Turn on fixing, `maxOpenPRs: 1`, watch every PR.
5. **Dashboard page.** Once there are enough runs for a screen to be worth opening.
