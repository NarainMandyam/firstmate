// Pure projections from firstmate's `fm-fleet-snapshot.v1` JSON to what the
// deck draws. Nothing here touches `$`: the hooks module runs the commands and
// hands their text in, so every rule below is testable from a fixture.
import type { Deck, DeckCall, DeckPr, DeckVitals, DeckWorker } from '../types'

// The parts of `bin/fm-fleet-snapshot.sh --json` the deck reads, every field
// optional so a partial or older snapshot projects to an empty deck rather
// than a crash. Its header owns the full contract.
type SnapshotRecord = {
  id?: unknown
  title?: unknown
  repo?: unknown
  kind?: unknown
  hold_reason?: unknown
  captain_actionable?: unknown
  merged?: unknown
}

type SnapshotTask = {
  id?: unknown
  kind?: unknown
  project?: unknown
  current_state?: { state?: unknown; detail?: unknown; observed_at?: unknown } | null
  endpoint?: { exists?: unknown } | null
  pr?: { url?: unknown } | null
  hints?: { pending_decision?: unknown } | null
  backlog?: SnapshotRecord | null
}

type Snapshot = {
  generated?: unknown
  backlog?: { records?: unknown } | null
  tasks?: unknown
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path

/** One line, collapsed whitespace, cut to `max` characters with an ellipsis. */
export const cut = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** `9s`, `3m`, `2h`, `4d` for a duration in milliseconds. */
export const ageText = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * Projects a snapshot into the deck: captain-actionable backlog records are
 * the calls, tasks with a recorded PR and no merge are the PRs waiting, and
 * every task is a worker row.
 */
export const projectDeck = (raw: unknown, fetchedAt: number): Deck => {
  const snapshot = (raw ?? {}) as Snapshot
  const records = Array.isArray(snapshot.backlog?.records)
    ? (snapshot.backlog?.records as SnapshotRecord[])
    : []
  const tasks = Array.isArray(snapshot.tasks) ? (snapshot.tasks as SnapshotTask[]) : []

  const calls: DeckCall[] = []
  for (const record of records) {
    const id = text(record.id)
    if (id === null || record.captain_actionable !== true) continue
    calls.push({
      id,
      title: text(record.title) ?? id,
      reason: text(record.hold_reason) ?? '',
      repo: text(record.repo),
      kind: text(record.kind),
    })
  }

  const workers: DeckWorker[] = []
  const prs: DeckPr[] = []
  for (const task of tasks) {
    const id = text(task.id)
    if (id === null) continue
    const state = text(task.current_state?.state) ?? 'unknown'
    const detail = text(task.current_state?.detail) ?? ''
    const project = text(task.project)
    const repo = text(task.backlog?.repo) ?? (project === null ? null : basename(project))
    const pr = text(task.pr?.url)
    const isGone = task.endpoint?.exists === false || detail.startsWith('backend target gone')
    const needsCaptain = state === 'blocked' || task.hints?.pending_decision === true
    workers.push({
      id,
      repo,
      kind: text(task.kind),
      state,
      detail,
      pr,
      isGone,
      needsCaptain,
      observedAt: text(task.current_state?.observed_at),
    })
    if (pr !== null && (task.backlog?.merged ?? null) === null) {
      prs.push({ id, url: pr, repo, state })
    }
  }

  return {
    generatedAt: text(snapshot.generated) ?? '',
    fetchedAt,
    calls,
    prs,
    workers,
    counts: {
      calls: calls.length,
      working: workers.filter(w => w.state === 'working').length,
      prs: prs.length,
      gone: workers.filter(w => w.isGone).length,
      blocked: workers.filter(w => w.needsCaptain).length,
    },
  }
}

/** Reads `df -P -k <path>`: the used percentage and the free gigabytes. */
export const parseDf = (stdout: string): { usedPct: number; freeGb: number } | null => {
  const line = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .pop()
  if (line === undefined) return null
  const fields = line.split(/\s+/)
  const pctField = fields.find(f => /^\d+%$/.test(f))
  if (pctField === undefined) return null
  const usedPct = Number(pctField.slice(0, -1))
  const at = fields.indexOf(pctField)
  const availableKb = Number(fields[at - 1])
  const freeGb = Number.isFinite(availableKb) ? Math.round(availableKb / 1024 / 1024) : 0
  return Number.isFinite(usedPct) ? { usedPct, freeGb } : null
}

export const MONITOR_LATE_MS = 10 * 60_000
export const DISK_FULL_PCT = 90

/**
 * Everything that needs the captain right now, as stable keys: an alert fires
 * only for a key that was not in the previous set.
 */
export const alertKeys = (deck: Deck, vitals: DeckVitals): string[] => {
  const keys = [
    ...deck.calls.map(c => `call:${c.id}`),
    ...deck.prs.map(p => `pr:${p.id}`),
    ...deck.workers.filter(w => w.needsCaptain).map(w => `blocked:${w.id}`),
  ]
  const isWorking = deck.counts.working > 0
  if (isWorking && vitals.monitorAgeMs !== null && vitals.monitorAgeMs > MONITOR_LATE_MS) {
    keys.push('monitor:late')
  }
  if (vitals.diskUsedPct !== null && vitals.diskUsedPct >= DISK_FULL_PCT) keys.push('disk:full')
  return keys
}

/** The one line an alert says, in the captain's nouns. */
export const describeKeys = (keys: readonly string[], deck: Deck): string => {
  const parts: string[] = []
  for (const key of keys) {
    const [kind, id] = key.split(':', 2)
    if (kind === 'call') {
      const call = deck.calls.find(c => c.id === id)
      parts.push(`decision: ${cut(call?.title ?? id ?? key, 60)}`)
    } else if (kind === 'pr') {
      const pr = deck.prs.find(p => p.id === id)
      parts.push(`PR to review: ${pr?.url ?? id}`)
    } else if (kind === 'blocked') {
      parts.push(`worker ${id} needs you`)
    } else if (kind === 'monitor') {
      parts.push('monitoring has gone quiet while work is running')
    } else if (kind === 'disk') {
      parts.push('disk is nearly full')
    }
  }
  return parts.join(' · ')
}
