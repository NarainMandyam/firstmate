# wake-meter

A Claude Code mod for firstmate's own primary session.
It pins one status line under the prompt that shows what firstmate's monitoring notifications cost:

```
ctx 262k · wakes 23 (19 idle) · last 1.1M · 5h 41% used
```

- `ctx` is how much context firstmate is carrying now; every notification re-reads all of it.
- `wakes` counts today's notification turns, and `idle` is how many of them only drained the queue and did nothing else.
- `last` is the token cost of the most recent notification turn.
- `5h` is how much of the five-hour allowance is used.

When an idle notification turn ends with context past the restart threshold (250k tokens by default), a toast suggests a good moment to `/stow` and restart.
It repeats only after another 50k of growth, and it is never a desktop notification.

An optional setting, `foldWakeRows`, draws each notification row in the transcript as one dim line; ctrl+o still shows the row whole, and the model always reads the original.
It is off by default because it has not yet been confirmed against a live session that the notification row is drawn where the mod can fold it.

The mod is inert everywhere else: in worker sessions (where `FM_TASK_ID` is set) and in any session whose root is not a firstmate home.
It only observes; it never types into the session, blocks a tool call, or touches firstmate's Stop hooks.

## Install

From a terminal Claude Code session:

```
/plugin install wake-meter --marketplace NarainMandyam/firstmate
```

Answer `y` to add the marketplace, then pick a scope.

To have later edits load with `/reload-plugins` instead of a reinstall, add the local firstmate home as the marketplace instead:

```
claude plugin marketplace add <firstmate home>
claude plugin install wake-meter@firstmate
```

## Settings

`/config` lists both options, or `claude plugin configure wake-meter@firstmate`:

- `restartAtTokens` - context size that arms the restart toast (default 250000).
- `foldWakeRows` - fold notification rows to one line (default off).

## Turn it off

```
claude plugin disable wake-meter@firstmate
```

`claude plugin enable wake-meter@firstmate` turns it back on.

## Develop

```
claude plugin validate plugins/wake-meter
claude plugin test plugins/wake-meter
```
