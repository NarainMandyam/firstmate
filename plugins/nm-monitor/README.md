# nm-monitor

A Claude Code mod for firstmate's primary session: an on-demand view of every no-mistakes validation run in the fleet.

## What it does

Nothing shows by default: no band, status line, toast or notification.
`/nm` opens a pane with one row per task that validates through no-mistakes:

```
1 running  1 waiting on a decision  · read 4s ago

1: mp-core-finish fm/mp-core-finish
   review 4m · 2 findings (1 ask-user) · ⏸ waiting on a decision

2: fm-mod-x fm/fm-mod-x
   ci 6m
   https://github.com/NarainMandyam/firstmate/pull/9

finished
3: fm-mod-fleet-deck passed PR #7
4: mp-dedupe-resume failed at review

no run yet: mp-new

refresh  close
```

- Active runs come first, the ones parked at a gate on top: the task, its branch, the step the run is on and how long it has been on it, its findings, a waiting-on-a-decision mark when the run is parked at a gate, and the PR link once there is one.
- Finished runs are one line each: passed, failed (with the step it failed at), or cancelled, plus the PR.
- A row's number (or a press) opens its step strip (`✓` done, `●` running, `⏸` parked, `✗` failed, `·` not started), its findings with severity and action, the run's error, and a button that shows the tail of that step's log; the same key closes it.
- `r` refreshes now; `close` closes the pane.

## Where the data comes from

- Tasks are firstmate's own records, `state/*.meta`: a ship task whose delivery mode is no-mistakes (or unrecorded), with its copy, repository and PR.
  Direct-PR, local-only and scout tasks never run the pipeline and are left out.
- A task's run is the newest one on its `fm/<task>` branch.
  Per repository, `no-mistakes axi status` from the repository's primary copy (which sits on its default branch) lists every run with its id; `no-mistakes axi status --run <id>` then reads that run's steps, findings and gate.
  When the primary copy cannot list, each task's own copy is asked instead, where `axi status` answers with its branch's run.
- `no-mistakes axi logs --run <id> --step <step>` runs only when a log button is pressed.

Reading is all it does: it never answers a gate, aborts, starts, reruns or syncs a run, and never touches the no-mistakes daemon.

## When it polls

Only while the pane is open: right away on `/nm`, then every 15 seconds.
Each command has a 10-second timeout, a tick is skipped while the previous read is still running, and polling stops when the pane closes.
A finished run is read once and remembered, since it no longer changes.
`no-mistakes` must be on the session's `PATH`; a repository whose runs cannot be read is named at the top of the pane with the reason.

## Scope

The mod stays inert unless all of these hold: `FM_TASK_ID` is unset, the session root is a firstmate home (it has `AGENTS.md`, `bin/fm-spawn.sh` and `bin/fm-crew-state.sh`), that home is not a secondmate home, and `FM_HOME`, when set, resolves to the same directory.
So a user-scope install loads in every worker session and does nothing there, and `/nm` is not registered there.

## Install

From a terminal Claude Code session:

```
/plugin install nm-monitor --marketplace NarainMandyam/firstmate
```

Answer `y` to add the marketplace, then pick a scope.

To have later edits load with `/reload-plugins` instead of a reinstall, add the local firstmate home as the marketplace instead:

```
claude plugin marketplace add <firstmate home>
claude plugin install nm-monitor@firstmate
```

The pane docks beside the transcript in the fullscreen layout from 110 columns; narrower, it opens inline above the prompt.

## Turn it off

```
claude plugin disable nm-monitor@firstmate
```

`claude plugin enable nm-monitor@firstmate` turns it back on.

## Verify without loading it anywhere

```
claude plugin validate plugins/nm-monitor
claude plugin test plugins/nm-monitor
```

Neither command loads the mod into a live session.
