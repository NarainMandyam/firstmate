#!/usr/bin/env bash
# Audit a firstmate fork against its upstream remote without modifying git
# state (outside an optional fetch). Reports ahead/behind counts, classifies
# each fork-only commit as already-upstream (patch-id match via git cherry) or
# unique, summarizes changed files by surface, checks working-tree cleanliness,
# and prints a suggested dated backup branch name.
#
# Designed as the deterministic read-only preflight for the /sync-upstream
# skill: it never creates branches, rebases, resets, stashes, or pushes.
#
# Remote selection precedence:
#   1. --upstream <remote>
#   2. $FM_HOME/config/upstream-remote or <repo-root>/config/upstream-remote
#      (first non-blank, non-comment line; names a git remote, e.g. upstream)
#   3. literal "upstream"
#
# Usage:
#   fm-upstream-audit.sh [--upstream <remote>] [--upstream-branch <branch>] [--head <ref>] [--no-fetch]
#   fm-upstream-audit.sh --help
set -eu

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

UPSTREAM_REMOTE=""
UPSTREAM_BRANCH=""
HEAD_REF="HEAD"
NO_FETCH=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --upstream)
      [ "$#" -ge 2 ] || { echo "error: --upstream requires a remote name" >&2; exit 1; }
      UPSTREAM_REMOTE=$2
      shift 2
      ;;
    --upstream-branch)
      [ "$#" -ge 2 ] || { echo "error: --upstream-branch requires a branch name" >&2; exit 1; }
      UPSTREAM_BRANCH=$2
      shift 2
      ;;
    --head)
      [ "$#" -ge 2 ] || { echo "error: --head requires a git ref" >&2; exit 1; }
      HEAD_REF=$2
      shift 2
      ;;
    --no-fetch)
      NO_FETCH=1
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/.." && pwd -P))"

read_config_remote() {
  local cfg=$1 line
  [ -f "$cfg" ] && [ ! -L "$cfg" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    case "$line" in
      ''|'#'*) continue ;;
      *) printf '%s' "$line"; return 0 ;;
    esac
  done < "$cfg"
  return 1
}

if [ -z "$UPSTREAM_REMOTE" ]; then
  if [ -n "${FM_HOME:-}" ] && UPSTREAM_REMOTE=$(read_config_remote "$FM_HOME/config/upstream-remote" 2>/dev/null); then
    :
  elif UPSTREAM_REMOTE=$(read_config_remote "$REPO_ROOT/config/upstream-remote" 2>/dev/null); then
    :
  else
    UPSTREAM_REMOTE="upstream"
  fi
fi

if ! UPSTREAM_URL=$(git -C "$REPO_ROOT" remote get-url "$UPSTREAM_REMOTE" 2>/dev/null); then
  echo "error: git remote '$UPSTREAM_REMOTE' is not configured in $REPO_ROOT" >&2
  echo "hint: git -C \"$REPO_ROOT\" remote add $UPSTREAM_REMOTE https://github.com/kunchenguid/firstmate.git" >&2
  exit 1
fi

if [ -z "$UPSTREAM_BRANCH" ]; then
  symref=$(git -C "$REPO_ROOT" symbolic-ref -q "refs/remotes/$UPSTREAM_REMOTE/HEAD" 2>/dev/null || true)
  if [ -n "$symref" ]; then
    UPSTREAM_BRANCH=${symref#"refs/remotes/$UPSTREAM_REMOTE/"}
  else
    UPSTREAM_BRANCH="main"
  fi
fi

if [ "$NO_FETCH" -eq 0 ]; then
  if ! git -C "$REPO_ROOT" fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"; then
    echo "error: failed to fetch $UPSTREAM_REMOTE/$UPSTREAM_BRANCH" >&2
    exit 1
  fi
fi

UPSTREAM_REF="refs/remotes/$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$UPSTREAM_REF^{commit}" >/dev/null; then
  echo "error: upstream ref $UPSTREAM_REMOTE/$UPSTREAM_BRANCH does not exist locally (run without --no-fetch or check --upstream-branch)" >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$HEAD_REF^{commit}" >/dev/null; then
  echo "error: head ref '$HEAD_REF' does not resolve to a commit" >&2
  exit 1
fi

HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse --short "$HEAD_REF")
UPSTREAM_SHA=$(git -C "$REPO_ROOT" rev-parse --short "$UPSTREAM_REF")
MERGE_BASE=$(git -C "$REPO_ROOT" merge-base "$HEAD_REF" "$UPSTREAM_REF" 2>/dev/null || true)
if [ -z "$MERGE_BASE" ]; then
  echo "error: no common merge-base between $HEAD_REF and $UPSTREAM_REMOTE/$UPSTREAM_BRANCH" >&2
  exit 1
fi
MERGE_BASE_SHORT=$(git -C "$REPO_ROOT" rev-parse --short "$MERGE_BASE")

COUNTS=$(git -C "$REPO_ROOT" rev-list --left-right --count "$UPSTREAM_REF...$HEAD_REF")
BEHIND=$(printf '%s' "$COUNTS" | awk '{print $1}')
AHEAD=$(printf '%s' "$COUNTS" | awk '{print $2}')

if [ "$AHEAD" -eq 0 ] && [ "$BEHIND" -eq 0 ]; then
  STATUS="up-to-date"
elif [ "$AHEAD" -eq 0 ]; then
  STATUS="behind"
elif [ "$BEHIND" -eq 0 ]; then
  STATUS="ahead"
else
  STATUS="diverged"
fi

DIRTY_LINES=$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)
if [ -n "$DIRTY_LINES" ]; then
  WORKTREE_STATE="dirty"
else
  WORKTREE_STATE="clean"
fi

TODAY=$(date +%Y-%m-%d)
BACKUP_BASE="archive/pre-upstream-sync-$TODAY"
BACKUP_BRANCH=$BACKUP_BASE
suffix=2
while git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BACKUP_BRANCH" \
   || git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$BACKUP_BRANCH"; do
  BACKUP_BRANCH="${BACKUP_BASE}-${suffix}"
  suffix=$((suffix + 1))
done

echo "repo: $REPO_ROOT"
echo "upstream: $UPSTREAM_REMOTE/$UPSTREAM_BRANCH ($UPSTREAM_SHA) $UPSTREAM_URL"
echo "head: $HEAD_REF ($HEAD_SHA)"
echo "merge-base: $MERGE_BASE_SHORT"
echo "status: $STATUS (ahead=$AHEAD behind=$BEHIND)"
echo "worktree: $WORKTREE_STATE"
echo "backup-branch: $BACKUP_BRANCH"

echo ""
echo "commits:"
CHERRY_OUT=$(git -C "$REPO_ROOT" cherry -v "$UPSTREAM_REF" "$HEAD_REF")
if [ -z "$CHERRY_OUT" ]; then
  echo "  none"
else
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sign=${line%% *}
    rest=${line#* }
    sha=${rest%% *}
    subject=${rest#* }
    short_sha=$(git -C "$REPO_ROOT" rev-parse --short "$sha")
    if [ "$sign" = "-" ]; then
      tag="already-upstream"
    else
      tag="unique"
    fi
    printf '  [%s] %s %s\n' "$tag" "$short_sha" "$subject"
  done <<< "$CHERRY_OUT"
fi

echo ""
echo "surfaces:"
CHANGED_FILES=$(git -C "$REPO_ROOT" diff --name-only "$MERGE_BASE..$HEAD_REF")
if [ -z "$CHANGED_FILES" ]; then
  echo "  none"
else
  c_agents=0
  c_skills=0
  c_bin=0
  c_tests=0
  c_docs=0
  c_other=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      AGENTS.md|CLAUDE.md) c_agents=$((c_agents + 1)) ;;
      .agents/skills/*|skills/*) c_skills=$((c_skills + 1)) ;;
      bin/*) c_bin=$((c_bin + 1)) ;;
      tests/*) c_tests=$((c_tests + 1)) ;;
      docs/*) c_docs=$((c_docs + 1)) ;;
      *) c_other=$((c_other + 1)) ;;
    esac
  done <<< "$CHANGED_FILES"
  [ "$c_agents" -eq 0 ] || echo "  agents-md: $c_agents"
  [ "$c_skills" -eq 0 ] || echo "  skills: $c_skills"
  [ "$c_bin" -eq 0 ] || echo "  bin: $c_bin"
  [ "$c_tests" -eq 0 ] || echo "  tests: $c_tests"
  [ "$c_docs" -eq 0 ] || echo "  docs: $c_docs"
  [ "$c_other" -eq 0 ] || echo "  other: $c_other"
fi
