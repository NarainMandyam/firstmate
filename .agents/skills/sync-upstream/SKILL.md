---
name: sync-upstream
description: >-
  Audit a personal firstmate fork against upstream and cleanly re-port fork customizations onto the latest upstream default branch, dropping already-upstreamed or obsolete changes.
  Use when the captain invokes /sync-upstream (e.g. "/sync-upstream", "sync with upstream", "port my firstmate onto upstream", "rebase fork on upstream").
user-invocable: true
metadata:
  internal: true
---

# sync-upstream

Keep a personal fork of firstmate cleanly stacked on top of upstream (`kunchenguid/firstmate:main` or the remote named in `config/upstream-remote`) instead of accumulating tangled merge commits.
Updating this fork is consumption of upstream plus an explicit captain-approved update of this fork's own `origin` — it never publishes anything to upstream itself (`firstmate-self-repo` owns that boundary).

## Principles

- **Clean replay over merge commits.** Start a fresh branch directly from `upstream/<default>` and replay only the fork customizations the captain still wants, keeping each logical customization as one small, self-contained commit so the next sync stays fast.
- **Drop what upstream already absorbed.** Upstream frequently lands fixes or features that overlap fork commits. Check both exact patch matches (`git cherry`, automated by `bin/fm-upstream-audit.sh`) and functional overlap in upstream's log on every file the fork touches.
- **Never lose prior history.** Always create a dated backup branch (`archive/pre-upstream-sync-<YYYY-MM-DD>`) pointing at the old `origin/<default>` before rewriting or replacing the fork's default branch.
- **Confirm before rewriting or pushing.** Presenting the audit and drop/keep plan is read-only; rewriting `main` or pushing to `origin` requires the captain's explicit confirmation.

## Procedure

1. **Run the read-only upstream audit:**
   ```sh
   bin/fm-upstream-audit.sh
   ```
   This fetches the configured upstream remote (default `upstream`, or `config/upstream-remote`), reports `ahead`/`behind` counts and worktree cleanliness, flags patch-equivalent commits as `[already-upstream]`, lists remaining `[unique]` commits, summarizes touched surfaces, and prints a collision-free `backup-branch:` name.
   If the `upstream` remote is missing, report the hint printed by the script and add it only with the captain's approval.

2. **Check functional overlap for `[unique]` commits.**
   For each `[unique]` commit that touches a tracked upstream file (especially `bin/` scripts or shared skills), inspect upstream's commits on those same paths since the merge-base:
   ```sh
   git log --oneline <merge-base>..<upstream>/<branch> -- <paths>
   ```
   Classify every fork customization into:
   - **Drop (upstreamed/superseded)** — upstream fixed or replaced it.
   - **Drop (extracted/obsolete)** — moved to another repo (for example `firstmate-mods`) or no longer needed.
   - **Keep** — still unique to this fork and desired.

3. **Present the concise diff and keep/drop plan to the captain.**
   Wait for the captain to confirm which items to keep and whether to update `origin/<default>` directly (after pushing the backup branch) or push a staging branch first.

4. **Create the backup branch and clean port branch.**
   Work in a clean checkout or isolated worktree — never rewrite a dirty working tree:
   ```sh
   git branch <backup-branch> origin/<default>
   git checkout -b port/upstream-sync-<YYYY-MM-DD> <upstream>/<branch>
   ```
   Replay each confirmed customization in logical order as its own clean commit, adapting cleanly to any upstream changes (rule numbering, new forge variants, skill triggers, `docs/documentation-audiences.json`, and colocated tests).

5. **Verify before pushing.**
   - Run targeted behavioral tests for every touched `bin/` script (for example `tests/fm-brief.test.sh`, `tests/fm-ensure-agents-md.test.sh`, `tests/fm-teardown-endpoint-safety.test.sh`, `tests/fm-upstream-audit.test.sh`).
   - Run `bin/fm-doc-audience-check.sh` whenever tracked markdown or skills changed.
   - Run `bin/fm-lint.sh` (or `bash -n` plus ShellCheck where installed) on every modified shell script.

6. **Publish to the fork and roll out to running homes.**
   After captain confirmation:
   ```sh
   git push origin <backup-branch>
   git branch -f <default> HEAD
   git push --force-with-lease origin <default>
   ```
   (Or push the staging branch without force-pushing `<default>` if the captain prefers a PR.)
   Finally, run `/updatefirstmate` so the primary home and any secondmates fast-forward cleanly onto the synced default branch and restart as needed.
