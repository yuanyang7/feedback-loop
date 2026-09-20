#!/bin/sh
# The intake half, ticking forever on a Synology.
#
# Run as a DSM Task Scheduler **boot-up triggered** task, not a scheduled one.
# That is the whole design: an interval task would start a fresh tick on a
# timer with nothing stopping two of them overlapping, and there is no
# tick-level lock in the tool — two intakes would each advance the Discord
# cursor past messages the other never saw, and reports would vanish at
# random. A process that sleeps between ticks cannot overlap with itself.
#
#   Control Panel -> Task Scheduler -> Create -> Triggered Task -> User-defined script
#   Event: Boot-up.  User: the one that owns the install directory.
#   Command: /volume1/feedback-loop/app/deploy/synology-loop.sh
#
# Nothing here is Synology-specific except where node is found. It will run on
# any always-on box with node and gh.
set -eu

# Where everything lives. Override in the task's command line if you laid it
# out elsewhere: FL_HOME=/volume2/... /path/to/synology-loop.sh
: "${FL_HOME:=/volume1/feedback-loop}"
: "${FL_APP:=$FL_HOME/app}"
: "${FEEDBACK_LOOP_CONFIG:=$FL_HOME/config/config.yml}"
: "${FEEDBACK_LOOP_HOME:=$FL_HOME/state}"
: "${FL_SECRETS:=$FL_HOME/secrets}"
: "${FEEDBACK_LOOP_ROLE:=intake}"
: "${FEEDBACK_LOOP_INTERVAL:=300}"
# Extra arguments for every tick. Set FL_ARGS=--dry-run to watch a fresh
# install decide what it would do without letting it write anything.
: "${FL_ARGS:=}"
export FEEDBACK_LOOP_HOME FEEDBACK_LOOP_ROLE

LOG="$FEEDBACK_LOOP_HOME/tick.log"

say() {
  # Timestamped, because a boot-up task's output goes nowhere by default and
  # this file is the only record that the thing is alive.
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# --- node ------------------------------------------------------------------
# DSM does not put the Package Center node on PATH for a scheduled task, and
# the path contains the major version, so it moves when you upgrade the
# package. Look in the obvious places and take the newest.
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in $(ls -d /var/packages/Node.js_v*/target/usr/local/bin/node 2>/dev/null | sort -V -r); do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  [ -x /usr/local/bin/node ] && { echo /usr/local/bin/node; return 0; }
  return 1
}

NODE=$(find_node) || {
  mkdir -p "$FEEDBACK_LOOP_HOME"
  say "no node found — install Node.js from Package Center, or set PATH in the task"
  exit 1
}

# gh ships beside the app. It is a single Go binary with no shared-library
# dependencies, which is why this works without a package at all.
PATH="$FL_APP/vendor:$PATH"
export PATH

# --- single instance -------------------------------------------------------
# mkdir is atomic on every filesystem DSM offers, which `[ -e ]` then `touch`
# is not. Guards against the task being triggered twice, and against someone
# adding a scheduled task beside the boot-up one later.
LOCK="$FEEDBACK_LOOP_HOME/loop.lock"
mkdir -p "$FEEDBACK_LOOP_HOME"
if ! mkdir "$LOCK" 2>/dev/null; then
  previous=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$previous" ] && kill -0 "$previous" 2>/dev/null; then
    say "already running as pid $previous — this instance is exiting"
    exit 0
  fi
  # The holder is gone: the NAS lost power mid-tick and never cleaned up.
  say "clearing a stale lock from pid ${previous:-unknown}"
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"; say "stopped"; exit 0' INT TERM
trap 'rm -rf "$LOCK"' EXIT

# --- secrets ---------------------------------------------------------------
# Two things this deliberately does not do:
#
#   - it does not `.` the files. That would *execute* them, so a token
#     containing a backtick or $(…) would run as this task's user — and these
#     are dotenv files a human hand-edits over SMB. Each line is parsed as
#     KEY=VALUE and nothing else.
#   - it does not export into this shell. This process lives for months, and
#     its environment is readable at /proc/<pid>/environ. Loading happens in
#     the subshell that runs one tick.
load_secrets() {
  [ -d "$FL_SECRETS" ] || return 0
  for file in "$FL_SECRETS"/*.env; do
    [ -f "$file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in "" | \#*) continue ;; esac
      key=${line%%=*}
      value=${line#*=}
      # A key that is not a plain identifier is a malformed file, not a
      # secret. Skipping it beats exporting something strange.
      case "$key" in *[!A-Za-z0-9_]* | "" | [0-9]*) continue ;; esac
      # Tolerate the quoting people put in .env files out of habit.
      case "$value" in
        \"*\") value=$(printf '%s' "$value" | sed 's/^"//; s/"$//') ;;
        \'*\') value=$(printf '%s' "$value" | sed "s/^'//; s/'\$//") ;;
      esac
      export "$key=$value"
    done < "$file"
  done
}

# The subshell is the point: secrets exist for one tick, never in the
# environment of the process that outlives it.
# shellcheck disable=SC2086 # FL_ARGS is a deliberate word-split of flags
tick() (
  load_secrets
  "$NODE" "$FL_APP/bin/feedback-loop.mjs" tick --config "$FEEDBACK_LOOP_CONFIG" $FL_ARGS
)

# --- go --------------------------------------------------------------------
if [ ! -f "$FEEDBACK_LOOP_CONFIG" ]; then
  say "no config at $FEEDBACK_LOOP_CONFIG"
  exit 1
fi

say "started — role=$FEEDBACK_LOOP_ROLE every ${FEEDBACK_LOOP_INTERVAL}s, node $("$NODE" -v)"
while true; do
  # Keep the log from growing without bound. Truncating the tail rather than
  # rotating: the recent past is what anyone reads, and a second file to
  # manage on an unattended box is a second thing to get wrong.
  if [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    tail -c 1048576 "$LOG" > "$LOG.trimmed" && mv "$LOG.trimmed" "$LOG"
  fi
  # A failed tick must not kill the loop: the usual causes are a Discord blip
  # or a GitHub 5xx, and the right response to both is to try again shortly.
  # The exit code is still recorded, because a run of them is the signal.
  tick >> "$LOG" 2>&1 || say "tick exited $? — continuing"
  sleep "$FEEDBACK_LOOP_INTERVAL"
done
