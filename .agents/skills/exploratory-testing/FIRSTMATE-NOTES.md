# Firstmate notes for exploratory-testing

This file is a firstmate addition; `SKILL.md` and the upstream references stay diffable against petrkindlmann/qa-skills.

## When to load

Load this skill when a worker is briefed to playtest, QA, exploratory-test, or bug-hunt a running app or UI.
It is a method for a human tester, so an agent also needs the additions below.

## Additions

- `references/agent-harness.md` - how an agent drives the app headlessly and sweeps many controls, with the WebKit gotchas.
- `scripts/` - generic Playwright harness: `lib.mjs`, `sweep.mjs`, `monkey.mjs`, `ax.mjs`, configured by environment variables.
- `references/tours.md` - short tour list for apps with many small controls.
- `references/report-template.md` - the output shape for findings.

## Rules for every playtest worker

- Headless only. Never drive the captain's screen: no headed browser, no osascript or System Events keystrokes, no app windows you open, no chrome-devtools-axi against the captain's own Chrome.
- Serve the app on your own port and stop only the exact process ids you started.
- Do not cap the number of findings. Reproduce each bug at least twice from a fresh page load and read the code before writing it up.
- Say what the run could not cover (real backend, native dialogs, OS drag-drop); use the covered / partial / unexplored table from the debrief.
