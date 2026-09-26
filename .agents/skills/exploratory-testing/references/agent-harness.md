# Agent harness for exploratory testing

Firstmate addition, not upstream.
The upstream skill assumes a human at a keyboard; this file is what an agent adds to hit every control headlessly.

## Rules

- Headless only.
  Playwright `webkit.launch({ headless: true })`, or another headless engine when the app targets it.
  Never a headed browser, never the captain's own Chrome, never osascript or System Events.
- Run the app on a port you choose, run one browser at a time (two at most), and stop only the process ids you started.
- Prefer the app's mock or seeded backend and say so; state what a mock cannot show (persistence across restart, native dialogs, OS drag-drop).

## Scripts

`scripts/` needs `@playwright/test` (and `axe-core` for `ax.mjs`) resolvable from where you run them; install them in the project or a scratch dir, not in firstmate.
All scripts read these environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PT_URL` | `http://localhost:4291/` | Served app URL |
| `PT_OUT` | `./.pt` | Directory for screenshots and JSON results (created on demand) |
| `PT_READY` | none | CSS selector that means the app has booted |
| `PT_SETUPS` | none | Path to an ES module whose default export maps a name to `async (page) => {}` that navigates to a screen |
| `PT_ENGINE` | `webkit` | `webkit`, `chromium` or `firefox` |

- `lib.mjs` - `open()`, `shot(page, name)`, `texts(page, selector)`, shared by the others.
- `sweep.mjs <setup>` - loads a fresh page per control on that screen, clicks it, and reports controls whose click changed nothing, failed, or raised an error or unhandled rejection.
  A "no change" hit is a lead, not a bug: confirm by hand (a Close on the only tab is legitimately inert).
- `monkey.mjs <seed> <steps>` - seeded random clicks, right-clicks, keys and typed strings; reports page errors and unhandled rejections with the last actions.
  Same seed, same run.
  Pass extra keyboard shortcuts through `PT_KEYS` (comma separated).
- `ax.mjs` - runs axe-core over every setup in `PT_SETUPS` and prints violations.

Own the setups module per app; it is the only app-specific part.

## Gotchas

- WebKit `page.screenshot()` injects a `<style>` and trips a strict CSP; the console then shows "Refused to apply a stylesheet" errors that are harness artifacts.
  Read the console before you screenshot, and filter that message out.
- `page.addScriptTag` is blocked by the same CSP; inject axe-core with `context.addInitScript` and reload (as `ax.mjs` does).
- `End` does not move the caret in a WebKit text field on macOS; use `Meta+ArrowRight`.
- Clicking a highlight or annotation may open a popover that captures the next typed text; check where focus went before you type.
- Listen for `unhandledrejection` yourself (`page.evaluate` a listener); Playwright's `pageerror` does not see every rejection.
- Playwright cannot drive real HTML5 drag-and-drop in WebKit; a synthetic `DragEvent` sequence is partial evidence only and should be reported as such.

## What the mechanical tools found

Random monkeying (about 1,500 actions) found no crash; the sweeper found one real bug in about 380 clicks.
Nearly all real bugs came from semantic charters: interrupt / delete the thing that is open elsewhere, boundary text (`<x>`, `&amp;`, leading spaces, accents) through a save-close-reopen round trip, claims in labels versus what happens, keyboard-only use.
Use the tools for breadth and the charters for depth.
