# Rough plan: an always-on half on a Synology DS220+

Status: a sketch, not a commitment. Nothing here is built.

## The problem this solves

The worker must live on the Mac: it needs Xcode, the iOS Simulator, `idb`, git
worktrees and the local lab's Postgres. A NAS cannot provide any of those, and
that is not going to change.

But the Mac sleeps, and `launchd` cannot wake it. So today the whole pipeline —
including the parts that need nothing but two HTTP APIs — is only alive when the
Mac happens to be awake. A report posted at 2am becomes an issue whenever
someone next opens the laptop.

The NAS is worth exactly one thing: **it is always on**. The plan is therefore
not "move feedback-loop to the NAS". It is "move the half that only needs the
network, and leave the half that needs the machine".

Prerequisite, and it is not optional: `sudo pmset -a sleep 0` on the Mac. Even a
perfect always-on intake produces nothing if no host can ever run the work. Do
that first and measure for a week — it may turn out to be the whole fix.

## The split

| Stage | Needs | Host |
|---|---|---|
| `intake` — read chat, classify, file issues | Discord + GitHub + one model call | **NAS** |
| `reconcile` — reactions, rewriting stale messages | GitHub + `status.json` | **NAS** |
| command handling (`go`, `queue`, `status`) | as above, plus a way to ask for a run | **NAS** |
| `pickup` — start the next run | a repo checkout | Mac |
| `triage` / `fix` | repo, worktree, lab, Simulator | Mac |
| dashboard | run artifacts on disk | either; see below |

## What makes this tractable

Two facts about the current code, both checked rather than assumed:

**The worker never writes the status database.** Every `recordStatus` call is in
`intake/run.ts`, `intake/reconcile.ts` and `worker/pickup.ts`. `triage.ts`,
`fix.ts` and `chain.ts` do not touch it. So if intake and reconcile move
together, `status.json` keeps a single writer and there is no drift to reconcile
between two hosts — which is the failure this design most needs to avoid.

**The request queue is already the handoff.** A queued request is the record of
"a human named this issue, and it has not started yet". On the NAS the
concurrency limit is effectively zero — no run can ever start there — so *every*
`go` naturally becomes a queued request, and the Mac's pickup drains it when it
wakes. The mechanism needed for the split is the one that already exists.

## The one real design decision: where the queue lives

`requests.json` is currently a local file. Two hosts cannot share it:

- **A network mount** (NAS exports it, Mac mounts it) is the obvious answer and
  the wrong one. The mount drops whenever the Mac sleeps or leaves the LAN,
  which is precisely the condition the whole plan exists to survive, and file
  locking over SMB is not something to bet a work queue on.
- **Syncing** it has the same problem with worse failure modes: two writers, no
  ordering, silent last-write-wins.
- **GitHub as the queue** — a label such as `fl:requested`, written by the NAS
  and read by the Mac's pickup. Both hosts already talk to GitHub, it is
  reachable from both whatever the LAN is doing, it needs no new transport or
  secret, and it is inspectable by a human in the browser. When the Mac is
  asleep the request simply sits on the issue, which is the correct behaviour.

Go with the label. It replaces `requests.json` rather than sitting beside it —
two queue mechanisms would be a drift source, and the local file's only
advantage is speed that nothing here needs.

Cost: a request's position in line stops being explicit, and `by` / `at` have to
come from the label event rather than a record we wrote. Acceptable.

## Phases

**Phase 0 — `pmset`, then wait a week.** Zero code. Decide the rest on what is
actually still missing afterwards.

**Phase 1 — intake + reconcile + commands on the NAS.**
- Teach the tool to load config without a repo checkout: today `loadConfig`
  walks to `.feedback-loop/config.yml` inside the target repo. Needs a mode that
  takes a config path directly (the worker playbook stays on the Mac — the NAS
  never runs a worker and does not need it).
- Split the `tick` command so intake/reconcile can run without pickup.
- Move the request queue to a GitHub label; teach the Mac's pickup to read it.
- Package as a container, run it from DSM's Task Scheduler every N minutes.
  Container Manager is available on the DS220+ (it is *not* on the `j` models).
- The Mac keeps a pickup-only tick.

Result: reports become issues 24/7, commands are accepted 24/7, work starts
whenever the Mac is next available. This is the bulk of the value.

**Phase 2 — remote access.** Install the Tailscale package on the NAS. The phone
joins the tailnet; nothing is exposed publicly and no auth needs writing. Do not
hand-roll authentication for this.

**Phase 3 — the dashboard, only if still wanted.** Its data is run artifacts on
the Mac's disk, so serving it from the NAS means pushing artifacts there (a
one-way rsync while the Mac is awake). Worth noting the value ceiling: when the
Mac is asleep there is no new evidence to look at, so this buys "can browse old
runs from the sofa", not "can watch work happen". Rank it last, and expect it
may not survive the ranking.

## Things to get right, or not do

- **Secrets.** The Discord and GitHub tokens get a second copy on the NAS. That
  is a new exposure surface. `~/.feedback-loop/` is `600` on the Mac; on the NAS
  they must not land in a shared folder, and the container should read them from
  a mounted file rather than an environment variable baked into the image.
- **Two hosts must not both run intake.** The Discord cursor is a single-writer
  value; two readers would each advance it past messages the other never saw.
  Moving intake to the NAS means *removing* it from the Mac's tick, not adding
  it to the NAS's.
- **`operatorIds` authorises spending money and running code on the Mac.** A
  command accepted on the NAS still ends in a run on the laptop. The operator
  check does not get relaxed because the front end moved.
- **Spend caps are read from the Mac's run log.** The gate's daily budget check
  reads `~/.feedback-loop/<target>/runs`. Keep that check on the Mac, at pickup
  time, where the log is. Do not reimplement it on the NAS against a copy.

## Open questions

- Is the DS220+ on 2GB or upgraded? 2GB is fine for this, but it is shared with
  whatever else DSM is running.
- Does the classifier call go out over `cli` or `api` from the NAS? The `cli`
  backend spawns `claude`, which means a Claude Code install and a logged-in
  session on the NAS. `api` with a key is the honest choice for an unattended
  headless host — but it is metered differently, and that is a cost change to
  price before committing, not after.
