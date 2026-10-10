# disk-sentinel

A status-line free-space alarm plus a `/targets` listing of build-cache dirs, so firstmate's disk never fills up silently from stale `target` build caches.

## What it does

- Pins a `disk <N>G free` status-line entry, refreshed from `df` once a minute.
- Toasts and sends one native notification the moment free space drops below a configurable threshold (default 15 GB), then stays quiet until free space recovers above it and drops again.
- `/targets` lists every `target` directory under `~/.treehouse` with its size, cross-checked against every task's recorded `worktree=` line in `state/*.meta` so each one is tagged `live (<task-id>)` or `idle`.
- Never deletes anything: it only lists what is idle so the captain can clear it himself.
- Inert outside firstmate's own primary session: it checks for an unset `FM_TASK_ID` and a session root that looks like a firstmate home (its own `AGENTS.md` and `bin/fm-session-start.sh`), so it stays off in a crewmate, secondmate, or any other project's session.

## Install (later, when the captain asks for it loaded)

```
/plugin install disk-sentinel --marketplace NarainMandyam/firstmate
```

## Turn it off

Uninstall it with `/plugin uninstall disk-sentinel`, or lower its alarm threshold instead of removing it via `/config` (`disk-sentinel.freeThresholdGb`).
