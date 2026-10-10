# guard-translator

A Claude Code mod for firstmate's own primary session.

When the cd-guard, watcher-arm, or subagent-dispatch seatbelt silently refuses a command, this mod reads the refusal's stable `[code]` and raises a toast explaining why in plain words.
For the two guards whose fix is a single, always-safe rewrite of the same Bash command (`persistent-cd`'s compound `cd x && y` wrapped in a subshell, and `watcher-direct`'s `fm-watch.sh` swapped for `fm-watch-arm.sh`), it also puts the corrected command in the prompt box, ready to send.
Every other refusal shape gets an explanation only: the mod never guesses a command it cannot verify is safe.

It only observes a denied call (`next(e)`'s result) and never answers a call itself or bypasses a guard.

It is inert outside firstmate's own primary session: unset `FM_TASK_ID` and a session root carrying `AGENTS.md`, `bin/`, and `state/` (a plain checkout or a marked secondmate home), mirroring `bin/fm-primary-scope-lib.sh`'s `fm_primary_scope_matches`.

## Install (later, once the captain wants it loaded)

```
/plugin install guard-translator --marketplace narainmandyam/firstmate
```

## Turn it off

Uninstall it with `/plugin uninstall guard-translator`, or remove its folder from wherever it was loaded from (a `--plugin-dir`, or the marketplace entry in `.claude-plugin/marketplace.json`).
