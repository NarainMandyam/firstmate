# disk-sentinel

A quiet free-space sentinel plus a `/targets` listing of build-cache dirs, so firstmate's disk never fills up silently from stale `target` build caches.

## What it does

- Reads free space from `df` once a minute and shows nothing while it is comfortably above the threshold.
- Within 10 GB of the threshold the status line reads `disk 48.2G free`; below it, `⚠ disk 38.2G free`.
- Toasts and sends one native notification the moment free space drops below the configurable threshold (default 15 GB), then stays quiet until free space recovers above it and drops again.
- `/targets` lists every `target` directory under `~/.treehouse` with its size, cross-checked against every task's recorded `worktree=` line in `state/*.meta`: idle dirs first, largest first, each tagged `idle` or `live <task-id>`.
- Never deletes anything: it only lists what is idle so the captain can clear it himself.
- Inert outside firstmate's own primary session: it checks for an unset `FM_TASK_ID` and a session root that looks like a firstmate home (its own `AGENTS.md` and `bin/fm-session-start.sh`), so it stays off in a crewmate, secondmate, or any other project's session.

## Install (later, when the captain asks for it loaded)

```
/plugin install disk-sentinel --marketplace NarainMandyam/firstmate
```

## Turn it off

Uninstall it with `/plugin uninstall disk-sentinel`, or lower its alarm threshold instead of removing it via `/config` (`disk-sentinel.freeThresholdGb`).
