# fleet-deck

A Claude Code mod for firstmate's primary session: the captain's deck.

## What it does

- A band above the prompt: calls waiting for the captain, workers busy, PRs to review, workers whose pane is gone, the age of the last monitoring beat, disk use, plus `Calls` and `Fleet` buttons.
- A Calls pane (`/deck`, or the `Calls` button): one card per captain call with an answer field, a `Go: resume the held work` button, and a `reply in chat` button that puts `On <id>: ` in the prompt.
  Below the calls, every PR waiting for a merge with a `Merge (asks firstmate)` button, and every worker that is blocked or waiting on a decision.
- A Fleet pane (`/crew`, or the `Fleet` button): one row per task with repo, state and detail; a row's hotkey or press shows the last 40 lines of that worker's pane, and a `state` button reads its current state.
- One desktop notification and one toast only when something new starts needing the captain: a new call, a newly recorded PR, a newly blocked worker, monitoring quiet for ten minutes while work runs, or the disk at or above 90 percent.
  The first snapshot of a session seeds the known set silently, and the set survives restarts.

The band never types into the session and never submits a prompt.

## Where the data comes from

- `bin/fm-fleet-snapshot.sh --json`, once a minute, with a timeout; a tick is skipped while the previous read still runs.
- `bin/fm-peek.sh <id> 40` and `bin/fm-crew-state.sh <id>`, only when a Fleet row is pressed.
- `df -P -k <home>` every fifth poll for the disk chip, and the modification time of `state/.last-watcher-beat` for the monitoring chip.

## What it writes

- An answer goes through `bin/fm-captain-hold.sh answers --source captain-deck`, the one keyed-answer intake, and then `bin/fm-inbox.sh note` so firstmate wakes and acts.
  Enter in the answer field records the words and closes the call; `Go` records the words (or `go`) and releases the hold so the held work resumes.
- `Merge` only files an inbox note asking firstmate to merge that PR's URL; firstmate's merge authority is unchanged, and nothing here merges.

## Scope

The mod stays inert unless all of these hold: `FM_TASK_ID` is unset, the session root is a firstmate home (it has `AGENTS.md`, `bin/fm-fleet-snapshot.sh`, `bin/fm-captain-hold.sh` and `bin/fm-inbox.sh`), that home is not a secondmate home, and `FM_HOME`, when set, resolves to the same directory.
So a user-scope install loads in every worker session and does nothing there.

## Install (later, from a terminal session)

The firstmate repo doubles as a folder marketplace through `.claude-plugin/marketplace.json`.

```
claude plugin marketplace add /path/to/firstmate
claude plugin install fleet-deck@firstmate
```

A plugin installed from a folder marketplace is read from the folder itself, so a later edit loads with `/reload-plugins`, no reinstall.
Pick the user scope so the primary session loads it wherever it starts; the scope gate above keeps workers inert.
The panes dock beside the transcript in the fullscreen layout from 110 columns; narrower, they open inline above the prompt.

## Turn it off

- For the rest of a session: press `hide` on the band; `/deck` or `/crew` brings it back.
- For good: `claude plugin uninstall fleet-deck@firstmate`, or disable it from `/plugin`.

## Verify without loading it anywhere

```
claude plugin validate plugins/fleet-deck
claude plugin test plugins/fleet-deck
```

Neither command loads the mod into a live session.
