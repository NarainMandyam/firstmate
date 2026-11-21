#!/usr/bin/env bash
# Behavior tests for bin/fm-upstream-audit.sh.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-upstream-audit)

init_upstream_and_fork() {  # <case-dir>
  local dir=$1 upstream_bare fork_repo
  upstream_bare="$dir/upstream.git"
  fork_repo="$dir/fork"
  mkdir -p "$dir"
  git init --bare -q -b main "$upstream_bare"
  git clone -q "$upstream_bare" "$fork_repo"
  git -C "$fork_repo" config user.name "Test User"
  git -C "$fork_repo" config user.email "test@example.invalid"
  mkdir -p "$fork_repo/bin" "$fork_repo/docs" "$fork_repo/.agents/skills/demo"
  cp "$ROOT/bin/fm-upstream-audit.sh" "$fork_repo/bin/fm-upstream-audit.sh"
  chmod +x "$fork_repo/bin/fm-upstream-audit.sh"
  printf 'base\n' > "$fork_repo/AGENTS.md"
  git -C "$fork_repo" add AGENTS.md bin/fm-upstream-audit.sh
  git -C "$fork_repo" commit -qm "base commit"
  git -C "$fork_repo" push -q origin main
  git -C "$fork_repo" remote add upstream "$upstream_bare"
  git -C "$fork_repo" fetch -q upstream main
}

test_up_to_date_fork_reports_clean_and_no_commits() {
  local dir fork out
  dir="$TMP_ROOT/up-to-date"
  init_upstream_and_fork "$dir"
  fork="$dir/fork"

  out=$("$fork/bin/fm-upstream-audit.sh" --no-fetch 2>&1) \
    || fail "audit failed on up-to-date fork: $out"
  assert_contains "$out" "status: up-to-date (ahead=0 behind=0)" "expected up-to-date status"
  assert_contains "$out" "worktree: clean" "expected clean worktree"
  assert_contains "$out" "backup-branch: archive/pre-upstream-sync-" "missing suggested backup branch"
  assert_contains "$out" "sync-branch: sync/upstream-" "missing suggested sync branch"
  assert_contains "$out" "  none" "expected no fork-only commits"
  pass "fm-upstream-audit.sh: up-to-date fork reports clean status and zero fork commits"
}

test_suggested_branch_names_skip_existing_local_and_origin_branches() {
  local dir fork out today
  dir="$TMP_ROOT/branch-collisions"
  init_upstream_and_fork "$dir"
  fork="$dir/fork"
  today=$(date +%Y-%m-%d)

  git -C "$fork" branch "archive/pre-upstream-sync-$today"
  git -C "$fork" branch "sync/upstream-$today"
  git -C "$fork" push -q origin "sync/upstream-$today"
  git -C "$fork" branch -D -q "sync/upstream-$today"
  git -C "$fork" branch "sync/upstream-$today-2"

  out=$("$fork/bin/fm-upstream-audit.sh" --no-fetch 2>&1) \
    || fail "audit failed with existing branches: $out"
  assert_contains "$out" "backup-branch: archive/pre-upstream-sync-$today-2" "backup name did not skip local branch"
  assert_contains "$out" "sync-branch: sync/upstream-$today-3" "sync name did not skip origin and local branches"
  pass "fm-upstream-audit.sh: suggested backup and sync branch names skip existing local and origin branches"
}

test_classifies_already_upstream_and_unique_commits_and_surfaces() {
  local dir fork other out
  dir="$TMP_ROOT/diverged"
  init_upstream_and_fork "$dir"
  fork="$dir/fork"
  other="$dir/upstream-work"

  # Commit 1 on fork: will also land upstream (patch-id equivalent).
  printf 'shared fix\n' > "$fork/docs/fix.md"
  git -C "$fork" add docs/fix.md
  git -C "$fork" commit -qm "fix: shared upstream fix"

  # Commit 2 on fork: stays unique to the fork.
  printf 'custom\n' > "$fork/.agents/skills/demo/SKILL.md"
  git -C "$fork" add .agents/skills/demo/SKILL.md
  git -C "$fork" commit -qm "feat: custom fork skill"

  # Upstream receives the shared fix plus one brand-new upstream commit.
  git clone -q "$dir/upstream.git" "$other"
  git -C "$other" config user.name "Upstream Maintainer"
  git -C "$other" config user.email "upstream@example.invalid"
  mkdir -p "$other/docs"
  printf 'shared fix\n' > "$other/docs/fix.md"
  git -C "$other" add docs/fix.md
  git -C "$other" commit -qm "fix: shared upstream fix (#100)"
  printf 'upstream feature\n' > "$other/docs/new.md"
  git -C "$other" add docs/new.md
  git -C "$other" commit -qm "feat: upstream feature (#101)"
  git -C "$other" push -q origin main

  out=$("$fork/bin/fm-upstream-audit.sh" 2>&1) \
    || fail "audit failed on diverged fork: $out"
  assert_contains "$out" "status: diverged (ahead=2 behind=2)" "expected diverged ahead=2 behind=2"
  assert_contains "$out" "[already-upstream]" "patch-id-matched commit should be tagged already-upstream"
  assert_contains "$out" "fix: shared upstream fix" "missing shared commit subject"
  assert_contains "$out" "[unique]" "fork-only commit should be tagged unique"
  assert_contains "$out" "feat: custom fork skill" "missing unique commit subject"
  assert_contains "$out" "skills: 1" "missing skills surface count"
  assert_contains "$out" "docs: 1" "missing docs surface count"
  pass "fm-upstream-audit.sh: classifies already-upstream vs unique commits and summarizes surfaces"
}

test_config_upstream_remote_and_dirty_worktree_and_missing_remote() {
  local dir fork home out rc
  dir="$TMP_ROOT/config-and-dirty"
  init_upstream_and_fork "$dir"
  fork="$dir/fork"
  home="$dir/home"
  mkdir -p "$home/config"

  git -C "$fork" remote rename upstream kun
  git -C "$fork" fetch -q kun main

  # Without config/upstream-remote, default "upstream" fails cleanly with a hint.
  set +e
  out=$(FM_HOME="$home" "$fork/bin/fm-upstream-audit.sh" --no-fetch 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "expected failure when upstream remote is missing"
  assert_contains "$out" "remote 'upstream' is not configured" "missing remote error did not name remote"
  assert_contains "$out" "hint: git -C" "missing remote error did not print hint"

  # With config/upstream-remote pointing at kun and a dirty tracked file.
  printf '# custom upstream remote\nkun\n' > "$home/config/upstream-remote"
  printf 'local edit\n' >> "$fork/AGENTS.md"
  out=$(FM_HOME="$home" "$fork/bin/fm-upstream-audit.sh" --no-fetch 2>&1) \
    || fail "audit failed with config/upstream-remote: $out"
  assert_contains "$out" "upstream: kun/main" "did not honor config/upstream-remote"
  assert_contains "$out" "worktree: dirty" "did not report dirty worktree"
  pass "fm-upstream-audit.sh: honors config/upstream-remote, reports dirty worktree, and fails clearly on missing remote"
}

test_up_to_date_fork_reports_clean_and_no_commits
test_suggested_branch_names_skip_existing_local_and_origin_branches
test_classifies_already_upstream_and_unique_commits_and_surfaces
test_config_upstream_remote_and_dirty_worktree_and_missing_remote
