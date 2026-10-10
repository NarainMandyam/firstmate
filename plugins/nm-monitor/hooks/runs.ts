// Pure readers for no-mistakes' own read-only output and firstmate's task
// records. Nothing here touches `$`: the hooks module runs the commands and
// hands their text in, so every rule below is testable from a fixture.
//
// `no-mistakes axi status` prints TOON. Run in a checkout whose branch has a
// run, it prints that run (`run:` block, `steps[N]{...}` table, optional
// `gate`, `outcome`, `error`); anywhere else (a default branch, a detached
// head) it lists the repository's runs newest first as
// `runs[N]{id,branch,status,head,pr}`. `axi status --run <id>` prints one
// run, under `other_branch_run:` when the checkout is on another branch.
// A run's `findings` is a table, `none`, or a summary such as
// `"2 awaiting, 1 auto-fix"`.
import type { NmFinding, NmRow, NmStep } from '../types'

export type NmRun = {
  id: string
  branch: string
  status: string
  pr: string | null
  outcome: string | null
  error: string | null
  gateStep: string | null
  gateStatus: string | null
  steps: NmStep[]
  findings: NmFinding[]
  findingsNote: string | null
}

export type NmListed = { id: string; branch: string; status: string; pr: string | null }

export type NmStatus = { kind: 'run'; run: NmRun } | { kind: 'list'; runs: NmListed[] } | { kind: 'none' }

export type TaskMeta = {
  id: string
  worktree: string
  project: string | null
  kind: string | null
  mode: string | null
  pr: string | null
}

const TERMINAL = new Set(['completed', 'passed', 'failed', 'cancelled'])
const SETTLED_STEP = new Set(['completed', 'passed', 'pending', 'skipped'])
const PARKED = new Set(['awaiting_approval', 'fix_review'])
const RUN_BLOCKS = ['run', 'other_branch_run']

const indentOf = (line: string): number => line.length - line.trimStart().length

/** A TOON scalar: surrounding quotes removed and escapes undone. */
export const unquote = (raw: string): string => {
  const s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  return s
}

/** One TOON table row: comma-separated, a quoted cell may hold commas. */
export const splitRow = (line: string): string[] => {
  const cells: string[] = []
  let cell = ''
  let isQuoted = false
  const s = line.trim()
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ''
    if (isQuoted && c === '\\' && i + 1 < s.length) {
      cell += c + (s[i + 1] ?? '')
      i++
    } else if (c === '"') {
      isQuoted = !isQuoted
      cell += c
    } else if (c === ',' && !isQuoted) {
      cells.push(unquote(cell))
      cell = ''
    } else {
      cell += c
    }
  }
  cells.push(unquote(cell))
  return cells
}

/** The first table named `name`, at any depth, as one record per row. */
const table = (lines: readonly string[], name: string): Record<string, string>[] | null => {
  const head = new RegExp(`^\\s*${name}\\[(\\d+)\\]\\{([^}]*)\\}:\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    const match = head.exec(lines[i] ?? '')
    if (match === null) continue
    const count = Number(match[1])
    const columns = (match[2] ?? '').split(',').map(c => c.trim())
    const depth = indentOf(lines[i] ?? '')
    const rows: Record<string, string>[] = []
    for (let j = i + 1; j < lines.length && rows.length < count; j++) {
      const line = lines[j] ?? ''
      if (line.trim() === '' || indentOf(line) <= depth) break
      const cells = splitRow(line)
      rows.push(Object.fromEntries(columns.map((col, k) => [col, cells[k] ?? ''])))
    }
    return rows
  }
  return null
}

/** `key: value` directly under `block:` (or at the top level when block is null). */
const scalar = (lines: readonly string[], key: string, block: string | null): string | null => {
  let inside = block === null
  let depth = -1
  for (const line of lines) {
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (block !== null) {
      if (!inside) {
        if (indent === 0 && line.trim() === `${block}:`) {
          inside = true
          depth = -1
        }
        continue
      }
      if (indent === 0) return null
      if (depth === -1) depth = indent
      if (indent !== depth) continue
    } else if (indent !== 0) {
      continue
    }
    const match = /^([A-Za-z_][\w]*):(?:\s+(.*))?$/.exec(line.trim())
    if (match !== null && match[1] === key && match[2] !== undefined) return unquote(match[2])
  }
  return null
}

const nonEmpty = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value

/** Reads one `axi status` answer. */
export const parseStatus = (stdout: string): NmStatus => {
  const lines = stdout.split('\n')
  const block = RUN_BLOCKS.find(name => lines.some(line => line.trimEnd() === `${name}:`))
  if (block !== undefined) {
    const steps = (table(lines, 'steps') ?? []).map(row => ({
      step: row.step ?? '',
      status: row.status ?? '',
      findings: Number(row.findings) || 0,
      durationMs: Number(row.duration_ms) || 0,
    }))
    const findings = (table(lines, 'findings') ?? []).map(row => ({
      id: row.id ?? '',
      severity: row.severity ?? '',
      file: row.file ?? '',
      action: row.action ?? '',
      description: row.description ?? '',
    }))
    const gateScalar = nonEmpty(scalar(lines, 'gate', null))
    return {
      kind: 'run',
      run: {
        id: scalar(lines, 'id', block) ?? '',
        branch: scalar(lines, 'branch', block) ?? '',
        status: scalar(lines, 'status', block) ?? '',
        pr: nonEmpty(scalar(lines, 'pr', block)),
        outcome: nonEmpty(scalar(lines, 'outcome', null)),
        error: nonEmpty(scalar(lines, 'error', null)),
        gateStep: gateScalar ?? nonEmpty(scalar(lines, 'step', 'gate')),
        gateStatus: nonEmpty(scalar(lines, 'status', 'gate')),
        steps,
        findings,
        findingsNote: findings.length > 0 ? null : nonEmpty(scalar(lines, 'findings', block)?.replace(/^none$/, '')),
      },
    }
  }
  const listed = table(lines, 'runs')
  if (listed !== null) {
    return {
      kind: 'list',
      runs: listed.map(row => ({
        id: row.id ?? '',
        branch: row.branch ?? '',
        status: row.status ?? '',
        pr: nonEmpty(row.pr),
      })),
    }
  }
  return { kind: 'none' }
}

/** `key=value` lines of a `state/<id>.meta` record; null without a worktree. */
export const parseMeta = (id: string, text: string): TaskMeta | null => {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const worktree = nonEmpty(fields.get('worktree'))
  if (worktree === null) return null
  return {
    id,
    worktree,
    project: nonEmpty(fields.get('project')),
    kind: nonEmpty(fields.get('kind')),
    mode: nonEmpty(fields.get('mode')),
    pr: nonEmpty(fields.get('pr')),
  }
}

/** Only ship work validated through no-mistakes has runs to show. */
export const runsPipeline = (meta: TaskMeta): boolean =>
  meta.kind !== 'scout' && (meta.mode === null || meta.mode === 'no-mistakes')

/** Firstmate's task branch: every brief has the worker create `fm/<id>`. */
export const taskBranch = (id: string): string => `fm/${id}`

export const isActive = (run: Pick<NmRun, 'status' | 'outcome'>): boolean =>
  run.outcome === null && !TERMINAL.has(run.status)

/** The step the run is on: its gate's, else the first one neither done nor waiting to start. */
export const currentStep = (run: NmRun): NmStep | null => {
  const named = run.gateStep ?? run.steps.find(s => PARKED.has(s.status))?.step
  if (named !== undefined) return run.steps.find(s => s.step === named) ?? { step: named, status: run.gateStatus ?? 'awaiting_approval', findings: 0, durationMs: 0 }
  return run.steps.find(s => !SETTLED_STEP.has(s.status)) ?? null
}

/** Parked at a gate: the worker, or a call above it, has to answer before the run moves. */
export const isWaiting = (run: NmRun): boolean =>
  isActive(run) &&
  (run.gateStep !== null || PARKED.has(run.status) || run.steps.some(s => PARKED.has(s.status)))

const basename = (path: string | null): string | null =>
  path === null ? null : (path.replace(/\/+$/, '').split('/').pop() ?? path)

/**
 * One task's row. `since` holds when each run's step was first seen, so a step
 * whose reported duration is still 0 ages from the first poll that saw it.
 */
export const projectRow = (
  meta: TaskMeta,
  run: NmRun | NmListed | null,
  fetchedAt: number,
  since: Map<string, number>,
): NmRow => {
  const base = {
    task: meta.id,
    repo: basename(meta.project),
    branch: taskBranch(meta.id),
  }
  if (run === null) {
    return { ...base, runId: null, phase: 'none', status: 'no run yet', step: null, stepSince: null, findings: [], findingsNote: null, isWaiting: false, pr: meta.pr, error: null, steps: [] }
  }
  if (!('steps' in run)) {
    const finished = TERMINAL.has(run.status)
    return { ...base, runId: run.id, phase: finished ? 'finished' : 'active', status: run.status, step: null, stepSince: null, findings: [], findingsNote: null, isWaiting: false, pr: run.pr ?? meta.pr, error: null, steps: [] }
  }
  const active = isActive(run)
  const step = active ? currentStep(run) : null
  let stepSince: number | null = null
  if (step !== null) {
    const key = `${run.id}:${step.step}`
    const seen = since.get(key) ?? fetchedAt
    since.set(key, seen)
    stepSince = step.durationMs > 0 ? fetchedAt - step.durationMs : seen
  }
  const failedAt = run.steps.find(s => s.status === 'failed')?.step
  return {
    ...base,
    runId: run.id,
    phase: active ? 'active' : 'finished',
    status: active ? run.status || 'running' : (run.outcome ?? run.status),
    step: step?.step ?? (active ? null : (failedAt ?? null)),
    stepSince,
    findings: run.findings,
    findingsNote: run.findingsNote,
    isWaiting: isWaiting(run),
    pr: run.pr ?? meta.pr,
    error: run.error,
    steps: run.steps,
  }
}

/** Active first (waiting ones on top), then finished, then not started; by task id within. */
export const sortRows = (rows: readonly NmRow[]): NmRow[] => {
  const rank = (row: NmRow): number => (row.phase === 'active' ? (row.isWaiting ? 0 : 1) : row.phase === 'finished' ? 2 : 3)
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.task.localeCompare(b.task))
}

/** One line, collapsed whitespace, cut to `max` characters with an ellipsis. */
export const cut = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** `9s`, `4m`, `1h12m` for a duration in milliseconds. */
export const ageText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`
}

/** Pull request number for a short label, the full URL kept for the link. */
export const prLabel = (url: string): string => {
  const match = /\/pull\/(\d+)/.exec(url)
  return match === null ? 'PR' : `PR #${match[1]}`
}
