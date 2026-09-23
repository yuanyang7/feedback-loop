# Reading the dashboard from a phone

The dashboard is no longer only a viewer — it answers escalated issues, clears
the gate and hands work off. That makes "can I open it from outside the house"
a different question than it was when it only showed screenshots.

The short version: **Tailscale on the Mac and on the phone, and the dashboard
bound to the tailnet address.** No NAS, no port forwarding, no reverse proxy,
no authentication to write.

## Why not just expose the port

This page has no login. Whoever loads it gets the action token out of the HTML
and can comment on issues and clear the gate — by design, because it was built
for `localhost`, where being able to open it already meant being the person
sitting at the machine.

So the network is the access control, and the whole job is picking a network
that means the same thing. A tailnet does: your devices and nothing else. Port
forwarding does not, and neither does `--host 0.0.0.0`, which also publishes it
to whatever café wifi the laptop is on.

That is why `--host` takes an interface address rather than defaulting to
0.0.0.0 when you ask for remote access. The default is still `127.0.0.1` and
binding wider prints a warning naming what it exposes.

## Setup

**1. Tailscale on both devices.** Install it on the Mac, sign in, then install
the iOS app and sign in as the same user. Nothing needs to be exposed publicly
and there is no ACL to write for this — a personal tailnet allows your own
devices by default.

**2. Run the dashboard bound to the tailnet.**

```bash
feedback-loop dashboard /path/to/your/repo --host tailscale
```

`tailscale` is resolved by looking for this machine's 100.64.0.0/10 address, so
nothing hardcodes an IP. If Tailscale is not up yet it waits and retries rather
than failing, which is what makes it safe to start at login.

**3. Keep it running.** `deploy/com.yuanyang.feedback-loop.dashboard.plist` is
a launchd job for exactly that:

```bash
cp deploy/com.yuanyang.feedback-loop.dashboard.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.yuanyang.feedback-loop.dashboard.plist
```

It logs to `~/.feedback-loop/<target>/dashboard.log`, and `KeepAlive` brings it
back if it dies.

**4. Open it on the phone.** `http://<mac's tailnet ip>:7777`. Find the address
with `tailscale ip -4`, or use the MagicDNS name — in which case the name has
to be allowed too, since the `Host:` check is what stops a hostile domain
resolving to your machine and reading the token:

```bash
feedback-loop dashboard . --host tailscale --allow-host mymac.tailnet-name.ts.net
```

## What this does not need

**The Mac has to be awake, and it now is** — `sudo pmset -a sleep 0`. That one
change is also what removed most of the argument for moving intake to a NAS:
measured over the three days after it, there was not a single gap longer than
the 45-minute staleness threshold, against gaps of 12.6h and 20.7h before it.

The dashboard reads run artifacts off this machine's disk, so it has to run
here regardless. A NAS could not serve it without shipping the artifacts
across, and when the Mac is always awake there is nothing left for the NAS to
be awake *for*. See [synology.md](synology.md) for that design; it is still
sound, and it is now solving a problem you may no longer have.

## Bookmark it

Add it to the iOS home screen and it opens full-screen, which is worth doing —
the page is responsive and the queue groups, log tails and before/after
screenshots are all usable on a phone.
