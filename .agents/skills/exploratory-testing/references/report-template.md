# Report template

Firstmate addition, not upstream; the shape follows the dogfood skill's report template (vercel-labs/agent-browser, Apache-2.0), with no cap on the number of findings.
Report every distinct bug you can reproduce.

```markdown
# Playtest report: {APP}

| Field | Value |
|-------|-------|
| Date | {DATE} |
| App / commit | {URL or path} / {commit} |
| Backend | {mock or real} |
| Engine | {headless engine and version} |

## Summary

Counts by severity, the worst three in one line each, and what the mechanical tools (sweep, monkey, axe) found.

## Bugs

### {ID}. {Severity}. {Short title}

- Category: functional / ux / visual / content / console / accessibility / performance
- Steps: numbered, from a fresh page load.
- Expected:
- Actual:
- Reproduced: {count} times from a fresh page load.
- Evidence: {screenshot paths and the script that shows it}
- Where: {best read of the code, if checked}

## Previously known bugs: status

| Earlier item | Status now |
|--------------|-----------|

## Harness artifacts discarded

Things that looked like bugs but came from the harness.

## Not covered

| Area | Status (covered / partial / unexplored) | Why |
|------|-----------------------------------------|-----|
```

Severity: critical = data loss or crash; high = blocks a core task; medium = a user will hit it and it misleads or blocks; low-medium = wrong but with an obvious workaround; low = polish.
