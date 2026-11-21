---
name: sync-upstream
description: >-
  Audit a personal firstmate fork against upstream and re-port fork customizations onto the latest upstream default branch on a dated sync branch delivered as a pull request into the fork's default branch, dropping already-upstreamed or obsolete changes.
  Use when the captain invokes /sync-upstream (e.g. "/sync-upstream", "sync with upstream", "port my firstmate onto upstream", "rebase fork on upstream").
user-invocable: true
metadata:
  internal: true
---

# sync-upstream

Keep a personal fork of firstmate cleanly stacked on top of upstream (`kunchenguid/firstmate:main` or the remote named in `config/upstream-remote`) instead of accumulating tangled merge commits.
Updating this fork is consumption of upstream plus a pull request into this fork's own `origin` — it never publishes anything to upstream itself (`firstmate-self-repo` owns that boundary).
Every `gh` call in this skill names the fork explicitly with `-R <fork-owner>/<fork-repo>` (the `origin` remote); never push to, open a PR on, comment on, or fork the upstream repository.

## Principles

- **Land through a PR, never by moving the default branch.** All sync work happens on a dated sync branch (`sync/upstream-<YYYY-MM-DD>`) that reaches the fork's default branch only through a pull request the captain merges.
  Never push directly to `<default>`, never force-push `<default>`, and never merge the sync PR unless the captain says so for that PR.
- **Clean replay over accumulated merges.** Start the sync branch directly from `upstream/<default>` and replay only the fork customizations the captain still wants, keeping each logical customization as one small, self-contained commit so the next sync stays fast.
- **Drop what upstream already absorbed.** Upstream frequently lands fixes or features that overlap fork commits. Check both exact patch matches (`git cherry`, automated by `bin/fm-upstream-audit.sh`) and functional overlap in upstream's log on every file the fork touches.
- **Never lose prior history.** Always push a dated backup branch (`archive/pre-upstream-sync-<YYYY-MM-DD>`) pointing at the old `origin/<default>` before opening the sync PR.

## Procedure

1. **Run the read-only upstream audit:**
   ```sh
   bin/fm-upstream-audit.sh
   ```
   This fetches the configured upstream remote (default `upstream`, or `config/upstream-remote`), reports `ahead`/`behind` counts and worktree cleanliness, flags patch-equivalent commits as `[already-upstream]`, lists remaining `[unique]` commits, summarizes touched surfaces, and prints collision-free `backup-branch:` and `sync-branch:` names.
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

3. **Present the concise diff and keep/drop plan to the captain** and wait for the captain to confirm which items to keep.

4. **Create the backup branch and the sync branch.**
   Work in a clean checkout or isolated worktree — never rewrite a dirty working tree, and never check out or reset `<default>` for this work:
   ```sh
   git branch <backup-branch> origin/<default>
   git push origin <backup-branch>
   git checkout -b <sync-branch> <upstream>/<branch>
   ```
   Replay each confirmed customization in logical order as its own clean commit, adapting cleanly to any upstream changes (rule numbering, new forge variants, skill triggers, `docs/documentation-audiences.json`, and colocated tests).
   When the fork has no customizations worth replaying individually, `git merge <upstream>/<branch>` onto a sync branch cut from `origin/<default>` is acceptable instead; it already descends from `<default>`, so skip step 5.

5. **Make a rebuilt history mergeable.**
   A branch replayed onto upstream does not descend from `origin/<default>`, so its PR cannot fast-forward and a normal merge would re-conflict every replayed change.
   End the sync branch with an `ours` merge of the old default branch:
   ```sh
   git merge -s ours --no-edit -m "chore: supersede pre-sync <default> with upstream re-port" origin/<default>
   git diff --exit-code HEAD^1 HEAD
   ```
   The empty diff proves the branch tree is exactly the rebuilt result; the old default becomes a second parent, so the PR merges cleanly and `<default>` stays fast-forward-only for every home.
   Trade-off: the default branch keeps the superseded fork commits reachable in its history (as the `ours` parent) instead of a linear upstream-plus-fork log, and the patches dropped in the plan disappear only from the tree, not from history.
   That is the price of never rewriting `<default>`; the backup branch still marks the exact pre-sync tip.

6. **Verify the sync branch.**
   - Run targeted behavioral tests for every touched `bin/` script (for example `tests/fm-brief.test.sh`, `tests/fm-ensure-agents-md.test.sh`, `tests/fm-teardown-endpoint-safety.test.sh`, `tests/fm-upstream-audit.test.sh`).
   - Run `bin/fm-doc-audience-check.sh` whenever tracked markdown or skills changed.
   - Run `bin/fm-lint.sh` (or `bash -n` plus ShellCheck where installed) on every modified shell script.

7. **Push the sync branch and open the PR into the fork.**
   ```sh
   git push -u origin <sync-branch>
   gh pr create -R <fork-owner>/<fork-repo> --base <default> --head <sync-branch> --title "chore: sync with upstream <upstream-sha>" --body-file <body>
   ```
   The PR body lists the upstream range (`<merge-base>..<upstream-sha>`), every fork commit with its outcome (kept, dropped as already upstream, dropped as superseded, or dropped as obsolete) and the reason, whether step 5's `ours` merge was used, the backup branch name, and the test commands with their results.

8. **Hand the PR to the captain.**
   Report the PR's full URL and the keep/drop summary, watch its checks, and fix failures on the sync branch with new commits.
   Do not merge it, push to `<default>`, or force-push anything to `<default>`; only the captain merges the sync PR, using a merge commit rather than squash or rebase so the `ours` parent and replayed commits survive.
   After the captain merges it, run `/updatefirstmate` so the primary home and any secondmates fast-forward onto the synced default branch and restart as needed.
