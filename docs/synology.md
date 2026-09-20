# The always-on half, on a Synology

Status: designed and built. The code is in; the NAS deployment is a runbook you
run once, on the network the NAS is on.

What has been exercised: the payload builds, and the loop script runs against
it — it finds node, ticks against live Discord and GitHub, stops cleanly on
SIGTERM, refuses a second instance and recovers a lock left by a `kill -9`.
What has **not**: any of it on DSM itself. The NAS was not reachable from the
machine this was written on, so Package Center's node, the Task Scheduler
trigger and the boot behaviour are all unverified.

## What this buys, and what it does not

The worker must live on the Mac: it needs Xcode, the iOS Simulator, `idb`, git
worktrees and the local lab's Postgres. A NAS cannot provide any of those, and
that is not going to change.

But the Mac sleeps, and `launchd` cannot wake it. So today the whole pipeline —
including the parts that need nothing but two HTTP APIs — is only alive when
the Mac happens to be awake. A report posted at 2am becomes an issue whenever
someone next opens the laptop.

The NAS is worth exactly one thing: **it is always on**. So this is not "move
feedback-loop to the NAS". It is "move the half that only needs the network,
and leave the half that needs the machine".

Be clear about the ceiling before spending an evening on it. After this:

- reports become issues 24/7, and the reporter gets their 📝 immediately;
- `go 1213` typed from a phone at midnight is **accepted** at midnight;
- the run itself still starts when the Mac is next awake.

Discord already reaches you from anywhere, so this does not improve access to
the loop. It improves how fast the loop answers. If the Mac were never asleep,
almost none of this would be needed — which is why the first step is not code.

## Step 0, and do this first: stop the Mac sleeping

```bash
sudo pmset -a sleep 0
```

On the machine this was written on, `pmset -g` currently reports `sleep 1` —
system sleep after one minute of idle, held off only by whatever happens to be
running. That is the actual cause of most of what the NAS is meant to fix. It
costs nothing to change and needs nothing installed.

Do it, leave it a week, and re-read the rest of this with that week's evidence.
It may turn out to be the whole fix, and the honest outcome of that week might
be that you never build the rest.

## The split

| Stage | Needs | Host |
|---|---|---|
| `intake` — read chat, classify, file issues | Discord + GitHub + one model call | **NAS** |
| `reconcile` — reactions, rewriting stale messages | GitHub + `status.json` | **NAS** |
| commands (`go`, `ready`, `status`, `queue`) | as above, plus a way to ask for a run | **NAS** |
| promoting unasked work into the queue | GitHub labels | **NAS** |
| draining the queue — starting runs | a repo checkout | Mac |
| `triage` / `fix` | repo, worktree, lab, Simulator | Mac |
| dashboard | run artifacts on disk | Mac |

Which half a host runs is one setting, `--role` (or `FEEDBACK_LOOP_ROLE`):

| role | `tick` does |
|---|---|
| `all` | intake, reconcile, pickup. The default, and what a laptop does. |
| `intake` | intake, reconcile, and promoting work into the queue. Starts nothing. |
| `worker` | drains the queue. Reads no chat at all. |

The role is a **per-host** setting rather than a config key, so the deployment
is what says which host is which. The two `config.yml` copies then differ only
where the hosts genuinely differ — where the token files are, and which model
backend — never in what each thinks its job is. `host.role` exists as a config
default; the flag and the environment variable both beat it.

## The decisions, and why

**The queue is a GitHub label** (`fl:requested`), not a file. Two hosts have to
share the queue and cannot share a disk. A network mount drops whenever the Mac
sleeps or leaves the LAN — precisely the condition this design exists to
survive — and file locking over SMB is not something to bet a work queue on.
Syncing a file has the same problem with worse symptoms: two writers, no
ordering, silent last-write-wins. A label is written and read over an API both
hosts already use, needs no new transport or secret, survives either host being
off, and you can read the queue in a browser.

What a label cannot carry — the verb, the channel, the id of the message the
run is supposed to edit — rides in a hidden marker inside an issue comment, the
same trick the source footer already uses. The label is the queue; the comment
is the detail. If the comment is lost or edited away, the request degrades to
"somebody asked for a `go` on this issue", which is still the important half.

`requests.json` is **gone**, not kept alongside. Two queue mechanisms would be
a drift source, and the local file's only advantage was speed that nothing here
needs.

**Only the NAS writes `status.json`.** That file records what the bot has told
people and where, and a second writer would mean two hosts disagreeing about
which Discord message says what. Intake and reconcile already write it and both
move to the NAS together. The one thing that had to move with them is choosing
unasked work: picking up an `agent-ready` issue means posting a Discord message
and recording that we posted it. So the NAS now *promotes* such an issue into
the queue, and the Mac only ever drains. The Mac's `pickup` writes no status.

That promotion is deliberately stricter than the local version was: it queues
one issue, and only when nothing is queued and nothing carries `in-progress`.
It cannot see the Mac's process list, so it uses the state both hosts can see.
Without that, a long weekend would put the whole backlog in the queue.

**Spend caps stay on the Mac.** The daily budget and run count are read from
`~/.feedback-loop/<target>/runs`, which only the host that runs work ever
writes. The NAS reading them would find an empty log, conclude nothing had been
spent today, and wave through work the Mac is about to refuse — a cap that
reports itself satisfied because it is looking at the wrong disk is worse than
no cap. So the NAS checks only the open-PR cap, which is a GitHub fact and
means the same thing from anywhere, and the full gate runs at drain time.

**`operatorIds` does not get relaxed.** A command accepted on the NAS still
ends in a run on the laptop, spending money and executing code. The front end
moving changes nothing about who is allowed to do that.

**Backend: `api`.** The `cli` backend spawns `claude`, which needs a Claude Code
install and a logged-in session on the NAS. On Linux those credentials are a
plain `~/.claude/.credentials.json` belonging to whichever user the task runs
as — and however it is stored, the session eventually expires, fails
*silently*, and intake just stops filing. `api` needs no interactive login,
which is the whole requirement for an unattended host. It costs real money
(~$0.01–0.015 a call) instead of subscription quota (~$0.09 of notional quota a
call, roughly 90% of which is harness overhead), so it is a cost *change*,
not obviously a cost increase — price it against your own week.

## Runbook

### 1. Build the payload

There is no container and nothing to cross-compile. Every production
dependency is pure JavaScript — `@anthropic-ai/sdk`, `yaml`, `zod` and their
transitive tree, none of which ships a `.node`, `.so` or `.dylib` — so a
`node_modules` built on an arm64 Mac runs unchanged on the amd64 NAS. That
fact is the whole reason a container is unnecessary here, and the packaging
script re-checks it on every build rather than trusting that it still holds.

```bash
./deploy/package.sh
```

That builds `dist/`, prunes to production dependencies, fetches the `gh`
linux-amd64 binary into `vendor/`, and writes `dist-synology/feedback-loop.tar.gz`
(about 16MB). `gh` is a statically linked Go binary, so it needs no packages
on the NAS. The dev toolchain is restored in the checkout afterwards.

Copy that file across with File Station and extract it so that
`/volume1/feedback-loop/app/bin/feedback-loop.mjs` exists.

### 2. Lay out the NAS

Install **Node.js** from Package Center (v20 or newer — the tool's `engines`
require it). Nothing else needs installing.

```
/volume1/feedback-loop/
├── app/                   # the extracted payload: bin, dist, node_modules, vendor/gh
├── config/config.yml      # a copy of .feedback-loop/config.yml
├── secrets/discord.env    # DISCORD_BOT_TOKEN=...
├── secrets/github.env     # GITHUB_TOKEN=...
├── secrets/anthropic.env  # ANTHROPIC_API_KEY=...
└── state/                 # the cursor, status.json, the run log
```

On the secrets, and this is the part worth being fussy about:

- This is a **second copy** of the Discord and GitHub tokens. That is a new
  exposure surface, and the reason to be deliberate about where it lands.
- `chmod 600` each file, and put the folder somewhere that is not a shared
  folder anyone browses or that Photos/Drive syncs.
- They are parsed as plain `KEY=VALUE` lines, never sourced as shell, so a
  token containing a backtick or `$(…)` stays a string instead of running as
  the task's user at boot.
- They are loaded inside the subshell that runs one tick, so they are not in
  the long-lived process's environment and not readable from `/proc/<pid>/environ`.
- The GitHub token needs `repo` scope, and that is all. Mint it for this, not
  the one you use elsewhere, so revoking it costs nothing.
- **No playbook.** It is the worker's system prompt; no worker runs here, so
  the NAS never holds a description of how to build and deploy the app.

Two changes to the copied `config.yml`:

```yaml
github:
  tokenFile: /volume1/feedback-loop/secrets/github.env   # no interactive `gh` login here
intake:
  backend: api                                                   # see above
```

`discord.tokenFile` has to point at the NAS's copy too. Everything else stays
identical to the Mac's.

### 3. Create the labels

Once, from anywhere with a checkout:

```bash
feedback-loop labels /path/to/your/repo
```

This adds `fl:requested` to the set. Without it the queue cannot be written.

### 4. Hand the cursor over — do not skip this

The NAS starting with an empty `state/` is not a clean slate, it is a gap.
With no cursor, the first tick adopts the newest message and **files nothing
older**, so every report between the Mac's last tick and the NAS's first one
disappears without a word. And with no `status.json`, the bot does not know
which Discord messages it has already posted, so every one of them becomes
unrewritable and stays stale forever.

Copy both across before starting anything:

```bash
scp ~/.feedback-loop/vibeplat/intake.json \
    ~/.feedback-loop/vibeplat/status.json \
    you@nas:/volume1/feedback-loop/state/vibeplat/
```

(The directory is named after `target.name`, not the repo.) Do this with the
Mac's timer stopped, so nothing advances the cursor between the copy and the
switch in step 6.

### 5. Start it

Control Panel → Task Scheduler → Create → **Triggered Task** → User-defined
script, event **Boot-up**, run as the user that owns the install directory:

```
/volume1/feedback-loop/app/deploy/synology-loop.sh
```

A boot-up task rather than a scheduled one, and that is deliberate. A
15-minute scheduled task would start a fresh tick on a timer with nothing
stopping two overlapping, and there is no tick-level lock in the tool — two
intakes would each advance the Discord cursor past messages the other never
saw, and reports would vanish at random. The script sleeps between ticks
instead, so it cannot overlap with itself, and it takes a lock so a second
copy exits rather than racing the first.

Before letting it write anything, run one pass by hand and read it:

```bash
FL_ARGS=--dry-run FEEDBACK_LOOP_INTERVAL=30 /volume1/feedback-loop/app/deploy/synology-loop.sh
```

Dry-run classifies real messages and prints what it *would* do. It is a
read-only pass, not an offline one: it still fetches from Discord, still calls
the classifier and still pays for it, and still reads from GitHub. What it
skips is every write. Ctrl-C when you have seen enough, then start the task
properly (Task Scheduler → select it → Run).

Its log is `state/tick.log`, trimmed at 5MB. For the status screen:

```bash
FEEDBACK_LOOP_HOME=/volume1/feedback-loop/state \
  node /volume1/feedback-loop/app/bin/feedback-loop.mjs status \
  --config /volume1/feedback-loop/config/config.yml
```

One difference from the Mac's: "what is running" comes from the `in-progress`
label on GitHub rather than a local process list, because the run is on a
machine the NAS cannot see.

### 6. Switch the Mac to `worker` — last, not first

**Not until step 5 is actually working.** Two hosts must not both run intake:
the Discord cursor has a single writer, and two readers would each advance it
past messages the other never saw, so reports would vanish at random. Moving
intake to the NAS means *removing* it from the Mac, and the gap between the two
is the only window where that can go wrong.

Add one argument to `~/Library/LaunchAgents/com.yuanyang.feedback-loop.vibeplat.plist`:

```xml
<string>tick</string>
<string>/Users/yangyuan/code/vibe-code-app-store</string>
<string>--role</string>
<string>worker</string>
```

```bash
launchctl unload ~/Library/LaunchAgents/com.yuanyang.feedback-loop.vibeplat.plist
launchctl load  ~/Library/LaunchAgents/com.yuanyang.feedback-loop.vibeplat.plist
```

A `worker` tick is cheap — it reads no chat and calls no model — so you can
also drop the interval from 900s if you want work to start sooner after it is
asked for.

To roll back, remove the two `--role worker` lines and reload: the Mac is doing
everything again, and the only thing to remember is to stop the NAS's task.

### 7. Reaching it from a phone

Install the **Tailscale** package on the NAS from Package Center and join the
phone to the same tailnet. Nothing is exposed publicly and there is no auth to
write. Do not hand-roll this, and do not port-forward DSM.

Worth being honest about what the phone gets. Discord already works from
anywhere, and that is the whole control surface: `status`, `queue`, `ready`,
`go`. Tailscale adds reaching DSM itself — reading `state/tick.log`, restarting
the task, looking at the state files. That is an operator's tool for when
something is wrong, not the daily path.

## Asking for a run by hand

`fl:requested` is an ordinary label, so adding it in the browser is a real way
to ask for a run — useful when Discord is not to hand. A bare label carries no
verb and no message to edit, so the intake host adopts it on its next tick:
it posts the usual notice, records it, and writes the request detail. Only a
host that owns `status.json` may do that, so a worker host holds such a request
until then rather than posting a message nothing can ever rewrite.

## What is still not done

**The dashboard stays on the Mac.** Its data is run artifacts on the Mac's
disk, so serving it from the NAS means pushing them there. The value ceiling is
low: when the Mac is asleep there is no new evidence to look at, so it buys
"browse old runs from the sofa", not "watch work happen". Ranked last, and it
may not survive the ranking.

**Nothing has run on DSM.** See the top of this file.

**The payload depends on the launcher's fallback.** `bin/feedback-loop.mjs`
prefers `tsx` when it is installed and falls back to `dist/`, which is what
lets `package.sh` ship without a dev toolchain. An earlier draft of this
pruned the only thing that could execute the CLI, and the result exited
non-zero with nothing on stderr — a host that looks alive and does nothing.
Worth re-checking if either the launcher or the packaging moves.

## Outages: what recovers by itself, and what does not

**NAS loses power.** The boot-up task starts the loop again, and `state/` is on
the volume, so the cursor survives. A lock left behind by the hard stop is
detected as stale — the recorded pid is gone — and cleared on the next start,
rather than wedging the loop into thinking it is already running. The next tick reads every Discord message since that cursor, so the
gap fills in rather than being skipped — a two-hour outage costs two hours of
latency, not two hours of reports.

The state files are written atomically (write a sibling, `fsync`, rename), so a
cut mid-write leaves either the old contents or the new, never half of each.
That matters more than it sounds: a torn `intake.json` used to read as "no
cursor", which makes intake adopt the newest message and **silently file
nothing older** — an outage would have quietly eaten every report in the gap.
A damaged file is now refused loudly, with a copy kept beside it, and the tick
fails every five minutes until someone looks.

**Internet drops.** A tick throws, the loop logs `tick exited N — continuing`,
and the next one tries again. The cursor only advances after a
tick succeeds, so nothing is consumed and lost. Reactions and message rewrites
catch up on their own, because reconcile derives what it should say from
GitHub every time rather than from a queue of pending edits.

**The Mac loses power mid-run.** Two things are left behind, and only one of
them heals:

- The issue keeps `in-progress`, because the run never reached its cleanup.
  That would hold it out of the queue *and* stop the NAS promoting anything at
  all, forever. The worker host's next tick clears it: runs happen only there,
  so a claim with no live process behind it is stale by definition. It never
  touches a claim that does have one.
- The **run is not retried**. It was dequeued when it started, deliberately —
  a run that dies on its first line must not be restarted every tick forever.
  Re-ask with `go <issue>`. The worktree it left under `.worktrees/` is also
  still there, and is yours to remove.

**What never self-heals.** A `.corrupt` state file, by design. Anything else
that needs a human says so in the log rather than continuing quietly.

## Things that will bite

- **Both hosts running intake.** Covered above; it is the one failure here that
  loses data rather than delaying it.
- **A silently dead loop.** `status` flags a stale tick past
  `intake.staleAfterMinutes`, which is the only place anyone would notice. Keep
  that setting above `FEEDBACK_LOOP_INTERVAL`.
- **`gh` is a hard dependency.** The tool shells out to it rather than holding
  an HTTP client, so `package.sh` pins a version and ships the binary. If
  GitHub changes the CLI's JSON output, this breaks on the NAS the same way it
  would anywhere.
- **Nothing pins node.** This is the one thing a container would have given
  you: Package Center decides the version, and a DSM update can move or
  disable the package underneath a running install. If that happens the task
  logs "no node found" and stops — loudly, at least.
- **`state/` is not scratch.** It holds the Discord cursor and
  `status.json`. *Deleting* it — as opposed to a torn write, which is now
  caught — re-adopts the cursor, silently skipping whatever arrived meanwhile,
  and forgets every message the bot has posted, so every stale one stays stale
  forever. Include it in a Hyper Backup task.
- **`worker.lock` identifies runs by pid.** After a reboot a recycled pid could
  in principle look like a live run and hold up the queue. Not observed, and
  `queue` would show it; delete the file if it ever happens.
