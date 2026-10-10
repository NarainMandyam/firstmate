# crew-seatbelt

A Claude Code mod for firstmate's worker sessions.
It refuses the few shell actions that have already cost a worker its work or moved the captain's screen, and every refusal names the safe alternative so the worker carries on.

| Refused | Safe alternative named in the refusal |
| --- | --- |
| `pkill` or `killall` (they match by name or pattern, so they kill sibling workers too) | `kill <pid>` of the process you started |
| `osascript`, `screencapture`, `open`, a `--headed` browser, `headless: false`, chrome-devtools-axi with `CHROME_DEVTOOLS_AXI_HEADED` or `CHROME_DEVTOOLS_AXI_AUTO_CONNECT` | a headless browser, or reading the file directly |
| `git checkout <paths>` or `git restore <paths>` when git shows uncommitted changes in those paths | commit or copy the file first, then restore from that |
| `git stash` without a message, and `git stash pop` (the stash stack is shared by every worktree) | a WIP commit, or `git stash push -u -m <tag>` then `git stash apply <sha>` |
| a build or test command run in the background (`cargo test`, `npm run build`, `vitest`, `build-*.sh`, ...) | run it in the foreground with a timeout |
| in a writing-workbench checkout only: `git commit --no-verify`, and Write or Edit under a reserved data directory name (`notes/`, `manuscripts/`, ...) | commit without `--no-verify`; use another directory name |

It only refuses; it never approves, rewrites, or runs anything on a worker's behalf, and a command it does not match passes through unchanged.
The uncommitted-changes and writing-workbench rules ask git first and refuse only on what git reports.
If the seatbelt's own check fails, it refuses the call rather than letting it through.
Matching command text is best effort (a command hidden in a variable or `eval` can slip past), so it backs up the worker rules rather than replacing them.

The mod is inert unless `FM_TASK_ID` is set, which firstmate exports into every worker it spawns, so it never acts in the captain's own session.
It never types into a session and never hooks the Stop event, so firstmate's turn-end guard and Stop auto-arm are untouched.

## Install

It must be installed at **user** scope so every worker session loads it.
From a terminal Claude Code session:

```
/plugin install crew-seatbelt --marketplace NarainMandyam/firstmate
```

Answer `y` to add the marketplace, then pick the user scope.

To have later edits load with `/reload-plugins` instead of a reinstall, add the local firstmate home as the marketplace instead:

```
claude plugin marketplace add <firstmate home>
claude plugin install crew-seatbelt@firstmate --scope user
```

## Turn it off

For one worker, start it with `FM_SEATBELT_OFF=1` in its environment.
A worker cannot switch it off from inside its own shell, because the mod reads the session's environment, not a command's.

Everywhere:

```
claude plugin disable crew-seatbelt@firstmate
```

`claude plugin enable crew-seatbelt@firstmate` turns it back on.

## Develop

```
claude plugin validate plugins/crew-seatbelt
claude plugin test plugins/crew-seatbelt
```

The rules live in `hooks/rules.ts`; `hooks/register.ts` wires them to tool calls and runs the git checks.
