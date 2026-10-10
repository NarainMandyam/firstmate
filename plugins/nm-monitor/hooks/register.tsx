// nm-monitor: an on-demand view of every no-mistakes run in the fleet, for
// firstmate's primary Claude Code session.
//
// Nothing shows until `/nm` opens the pane; there is no band, status line,
// toast or notification. One row per pipeline task: task, branch, the step
// the run is on and for how long, its findings, a waiting-on-a-decision mark,
// and the PR link. A row's hotkey opens its step strip, findings, error and
// the current step's log tail.
//
// Boundaries, by design:
// - Inert unless this is the primary firstmate session: FM_TASK_ID unset, the
//   session root a firstmate home (resolved, never a hardcoded path), not a
//   secondmate home, and FM_HOME absent or resolving to that same root.
// - Reads tasks from `state/*.meta` (worktree, project, kind, mode, pr) and
//   runs only no-mistakes' read commands: `axi status`, `axi status --run`,
//   and `axi logs` on a press. It never answers a gate, aborts, starts or
//   syncs a run, and never touches the daemon.
// - Polls only while the pane is open: every 15 s, each command with a
//   timeout, a tick skipped while the previous read still runs, and the poll
//   stopped when the pane closes.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NmBoard, NmRow } from '../types'
import {
  ageText,
  cut,
  isActive,
  parseMeta,
  parseStatus,
  prLabel,
  projectRow,
  runsPipeline,
  sortRows,
  taskBranch,
} from './runs'
import type { NmListed, NmRun, TaskMeta } from './runs'

const PANE = 'nm-monitor'
const TITLE = 'no-mistakes'
const POLL_MS = 15_000
const COMMAND_TIMEOUT_MS = 10_000
const LOG_LINES = 30
const FINDINGS_SHOWN = 8

const boardAtom = atom({ plugin: 'nm-monitor', key: 'board' } as const, null)
const expandedAtom = atom({ plugin: 'nm-monitor', key: 'expanded' } as const, null)
const logAtom = atom({ plugin: 'nm-monitor', key: 'log' } as const, null)
const noticeAtom = atom({ plugin: 'nm-monitor', key: 'notice' } as const, null)

type Dollar = EngineInterface

// The resolved firstmate home while the mod is active; null keeps every hook
// inert. Module state is lost on a hot reload, and session.start runs again
// then, so it is recomputed rather than persisted.
let home: string | null = null
let timer: { cancel: () => void } | null = null
let isRefreshing = false
// When each active run's current step was first seen, for a step whose
// reported duration is still 0.
let since = new Map<string, number>()
// A finished run never changes, so its detail is read once.
const finishedRuns = new Map<string, NmRun>()
// The copy each run was read from, where its log is read too.
const runDirs = new Map<string, string>()

/** The firstmate home this session is the primary of, or null to stay inert. */
const resolveHome = async ($: Dollar): Promise<string | null> => {
  if ((await $.env.get('FM_TASK_ID')) !== undefined) return null
  const root = await $.session.root()
  const realOf = async (path: string): Promise<string | null> => {
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    return stat?.realPath ?? null
  }
  const real = (await realOf(root)) ?? root
  for (const marker of ['AGENTS.md', 'bin/fm-spawn.sh', 'bin/fm-crew-state.sh']) {
    if (!(await $.fs.exists(`${real}/${marker}`))) return null
  }
  if (await $.fs.exists(`${real}/.fm-secondmate-home`)) return null
  const fmHome = await $.env.get('FM_HOME')
  if (fmHome !== undefined && fmHome !== '') {
    const fmReal = (await realOf(fmHome)) ?? fmHome
    if (fmReal.replace(/\/+$/, '') !== real.replace(/\/+$/, '')) return null
  }
  return real
}

type NmOut = { stdout: string; fault: string | null }

/** One read-only no-mistakes command in `cwd`; a failure comes back as a short fault. */
const nm = async ($: Dollar, cwd: string, args: readonly string[]): Promise<NmOut> => {
  try {
    const ran = await $.process.run(['no-mistakes', ...args], {
      cwd,
      env: { NO_COLOR: '1' },
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
    if (ran.exitCode === 0) return { stdout: ran.stdout, fault: null }
    // The update banner is not the reason anything failed.
    const why = ran.stderr
      .split('\n')
      .filter(line => !/new version of no-mistakes|no-mistakes update/.test(line))
      .join(' ')
    return { stdout: ran.stdout, fault: cut(why || `exit ${ran.exitCode}`, 100) }
  } catch (error) {
    return { stdout: '', fault: cut(String(error), 100) }
  }
}

const readMetas = async ($: Dollar): Promise<TaskMeta[]> => {
  const entries = await $.fs.list(`${home}/state`).catch(() => [])
  const metas: TaskMeta[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.meta')) continue
    const text = await $.fs.read(`${home}/state/${entry.name}`).catch(() => null)
    if (typeof text !== 'string') continue
    const meta = parseMeta(entry.name.slice(0, -'.meta'.length), text)
    if (meta !== null && runsPipeline(meta)) metas.push(meta)
  }
  return metas
}

/** The full record of a listed run: finished ones from the cache, else read. */
const detailOf = async ($: Dollar, dir: string, listed: NmListed): Promise<NmRun | NmListed> => {
  const cached = finishedRuns.get(listed.id)
  if (cached !== undefined) return cached
  const out = await nm($, dir, ['axi', 'status', '--run', listed.id])
  const parsed = out.fault === null ? parseStatus(out.stdout) : null
  if (parsed?.kind !== 'run') return listed
  if (!isActive(parsed.run)) finishedRuns.set(listed.id, parsed.run)
  return parsed.run
}

/**
 * Reads every pipeline task's newest run. Tasks are grouped by repository: a
 * checkout on a branch with no run (the primary one sits on the default
 * branch) lists the repository's runs with their ids in one call; a task copy
 * on its own branch answers with that branch's run directly.
 */
const collect = async ($: Dollar): Promise<NmBoard> => {
  const fetchedAt = await $.clock.now()
  const groups = new Map<string, TaskMeta[]>()
  for (const meta of await readMetas($)) {
    const key = meta.project ?? meta.worktree
    groups.set(key, [...(groups.get(key) ?? []), meta])
  }
  const rows: NmRow[] = []
  const faults: string[] = []
  const nextSince = new Map<string, number>()
  for (const [key, tasks] of groups) {
    const dirs = [...new Set([...(tasks[0]?.project ? [tasks[0].project] : []), ...tasks.map(t => t.worktree)])]
    const byBranch = new Map<string, { run: NmRun; dir: string }>()
    let listing: { runs: NmListed[]; dir: string } | null = null
    let fault: string | null = null
    for (const dir of dirs) {
      if (!(await $.fs.exists(dir))) continue
      const out = await nm($, dir, ['axi', 'status'])
      if (out.fault !== null) {
        fault = out.fault
        continue
      }
      const parsed = parseStatus(out.stdout)
      if (parsed.kind === 'run' && !byBranch.has(parsed.run.branch)) byBranch.set(parsed.run.branch, { run: parsed.run, dir })
      if (parsed.kind === 'list') {
        listing = { runs: parsed.runs, dir }
        break
      }
    }
    if (listing === null && byBranch.size === 0 && fault !== null) {
      faults.push(`${key.split('/').pop() ?? key}: ${fault}`)
    }
    for (const task of tasks) {
      const branch = taskBranch(task.id)
      const direct = byBranch.get(branch)
      let run: NmRun | NmListed | null = direct?.run ?? null
      let dir = direct?.dir ?? null
      if (run === null && listing !== null) {
        const listed = listing.runs.find(r => r.branch === branch)
        if (listed !== undefined) {
          run = await detailOf($, listing.dir, listed)
          dir = listing.dir
        }
      }
      if (run !== null && dir !== null) runDirs.set(run.id, dir)
      const row = projectRow(task, run, fetchedAt, since)
      if (row.phase === 'active' && row.runId !== null && row.step !== null) {
        const stepKey = `${row.runId}:${row.step}`
        nextSince.set(stepKey, since.get(stepKey) ?? fetchedAt)
      }
      rows.push(row)
    }
  }
  since = nextSince
  return { fetchedAt, rows: sortRows(rows), faults }
}

const refresh = async ($: Dollar) => {
  if (home === null || isRefreshing) return
  isRefreshing = true
  try {
    const board = await collect($)
    await update($, boardAtom, () => board)
    await update($, noticeAtom, () => null)
  } catch (error) {
    await update($, noticeAtom, () => `could not read the runs: ${cut(String(error), 100)}`)
  } finally {
    isRefreshing = false
  }
}

const stopPolling = () => {
  timer?.cancel()
  timer = null
}

const isOpen = async ($: Dollar): Promise<boolean> =>
  (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)

const startPolling = ($: Dollar) => {
  if (timer !== null) return
  timer = $.clock.every(POLL_MS, () => {
    void (async () => {
      if (await isOpen($)) await refresh($)
      else stopPolling()
    })()
  })
  void refresh($)
}

const toggleRow = async ($: Dollar, task: string) => {
  const current = await read($, expandedAtom)
  await update($, expandedAtom, () => (current === task ? null : task))
  await update($, logAtom, () => null)
}

/** The tail of the step's log; a second press hides it. */
const toggleLog = async ($: Dollar, row: NmRow) => {
  const current = await read($, logAtom)
  if (current !== null && current.task === row.task) {
    await update($, logAtom, () => null)
    return
  }
  const dir = row.runId === null ? undefined : runDirs.get(row.runId)
  if (row.runId === null || row.step === null || dir === undefined) return
  const out = await nm($, dir, ['axi', 'logs', '--run', row.runId, '--step', row.step])
  const text = out.fault === null ? out.stdout : `${out.stdout}\n${out.fault}`.trim()
  await update($, logAtom, () => ({ task: row.task, step: row.step ?? '', text }))
}

const STEP_MARK: Record<string, string> = {
  completed: '✓',
  passed: '✓',
  running: '●',
  fixing: '●',
  failed: '✗',
  cancelled: '✗',
  pending: '·',
  skipped: '-',
  awaiting_approval: '⏸',
  fix_review: '⏸',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = await resolveHome($)
    if (home === null) return next(e)
    await $.command.register({
      name: 'nm',
      description: 'Open the no-mistakes monitor: every validation run in the fleet',
    })
    // A reload while the pane stayed open picks the poll back up.
    stopPolling()
    if (await isOpen($)) startPolling($)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    stopPolling()
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) stopPolling()
    return next(e)
  })

  on('command.run', { command: 'nm' }, async $ => {
    if (home === null) return { text: 'nm-monitor is inert here: not a firstmate primary session.' }
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    startPolling($)
    return { text: opened.isPlaced ? 'no-mistakes monitor opened.' : `no-mistakes monitor waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const board = await read($, boardAtom)
    const notice = await read($, noticeAtom)
    const expanded = await read($, expandedAtom)
    const log = await read($, logAtom)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)

    if (board === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{notice ?? 'Reading the runs…'}</Text>
        </Box>
      )
    }

    const active = board.rows.filter(r => r.phase === 'active')
    const finished = board.rows.filter(r => r.phase === 'finished')
    const idle = board.rows.filter(r => r.phase === 'none')
    const waiting = active.filter(r => r.isWaiting).length
    const runRows = [...active, ...finished]

    const details = (row: NmRow) => (
      <Box key={`detail:${row.task}`} flexDirection="column" marginLeft={3} borderStyle="single" borderDimColor paddingX={1}>
        {row.steps.length > 0 && (
          <Text key="steps" wrap="wrap">
            {row.steps.map(s => `${s.step} ${STEP_MARK[s.status] ?? s.status}`).join('  ')}
          </Text>
        )}
        {row.findings.slice(0, FINDINGS_SHOWN).map(f => (
          <Text key={`finding:${f.id}`} wrap="truncate-end" {...(f.action === 'ask-user' ? { color: 'warning' } : {})}>
            {f.severity} · {f.action}
            {f.file === '' ? '' : ` · ${f.file}`} · {f.description}
          </Text>
        ))}
        {row.findings.length === 0 && row.findingsNote !== null && (
          <Text key="findings-note" dimColor>findings: {row.findingsNote}</Text>
        )}
        {row.findings.length > FINDINGS_SHOWN && (
          <Text key="more" dimColor>+{row.findings.length - FINDINGS_SHOWN} more</Text>
        )}
        {row.error !== null && (
          <Text key="error" color="error" wrap="wrap">{cut(row.error, 400)}</Text>
        )}
        {row.step !== null && (
          <Box key="actions" gap={1}>
            <Button key={`log:${row.task}`} plain dimColor onPress={() => void toggleLog($, row)}>
              {log !== null && log.task === row.task ? 'hide log' : `${row.step} log`}
            </Button>
          </Box>
        )}
        {log !== null &&
          log.task === row.task &&
          log.text
            .split('\n')
            .slice(-LOG_LINES)
            .map((line, i) => (
              <Text key={`log-line:${i}`} dimColor wrap="truncate-end">{line === '' ? ' ' : line}</Text>
            ))}
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        <Box key="head" gap={1} flexWrap="wrap">
          <Text bold>{active.length} running</Text>
          {waiting > 0 && <Text key="waiting" color="warning" bold>{waiting} waiting on a decision</Text>}
          <Text dimColor>· read {ageText(now - board.fetchedAt)} ago</Text>
        </Box>
        {notice !== null && <Text key="notice" color="warning" wrap="wrap">{notice}</Text>}
        {board.faults.map(fault => (
          <Text key={`fault:${fault}`} color="warning" wrap="truncate-end">{fault}</Text>
        ))}
        {board.rows.length === 0 && <Text key="empty" dimColor>No pipeline tasks in the fleet.</Text>}

        {active.map(row => {
          const index = runRows.indexOf(row)
          const findings = row.findings.length
          const askUser = row.findings.filter(f => f.action === 'ask-user').length
          return (
            <Box key={`row:${row.task}`} flexDirection="column" marginTop={1}>
              <Button key={`open:${row.task}`} plain {...(index < 9 ? { hotkey: String(index + 1) } : {})} onPress={() => void toggleRow($, row.task)}>
                {row.task} <Text dimColor>{row.branch}</Text>
              </Button>
              <Box key="line" marginLeft={3} columnGap={1} flexWrap="wrap">
                <Text key="step" color={row.isWaiting ? 'warning' : 'success'}>{row.step ?? row.status}</Text>
                {row.stepSince !== null && <Text key="age" dimColor>{ageText(now - row.stepSince)}</Text>}
                {findings > 0 && (
                  <Text key="findings" {...(askUser > 0 ? { color: 'warning' } : { dimColor: true })}>
                    · {findings} finding{findings === 1 ? '' : 's'}
                    {askUser > 0 ? ` (${askUser} ask-user)` : ''}
                  </Text>
                )}
                {findings === 0 && row.findingsNote !== null && (
                  <Text key="findings-note" {...(/awaiting|ask-user/.test(row.findingsNote) ? { color: 'warning' } : { dimColor: true })}>
                    · findings: {row.findingsNote}
                  </Text>
                )}
                {row.isWaiting && <Text key="waiting" color="warning" bold>· ⏸ waiting on a decision</Text>}
              </Box>
              {row.pr !== null && (
                <Box key="pr" marginLeft={3}>
                  <Link href={row.pr} />
                </Box>
              )}
              {expanded === row.task && details(row)}
            </Box>
          )
        })}

        {finished.length > 0 && (
          <Box key="finished" flexDirection="column" marginTop={1}>
            <Text dimColor>finished</Text>
            {finished.map(row => {
              const index = runRows.indexOf(row)
              const isPassed = row.status === 'passed' || row.status === 'completed'
              return (
                <Box key={`row:${row.task}`} flexDirection="column">
                  <Box key="line" columnGap={1} flexWrap="wrap">
                    <Button key={`open:${row.task}`} plain dimColor {...(index < 9 ? { hotkey: String(index + 1) } : {})} onPress={() => void toggleRow($, row.task)}>
                      {row.task}
                    </Button>
                    <Text key="status" {...(isPassed ? { color: 'success' } : row.status === 'failed' ? { color: 'error' } : { dimColor: true })}>
                      {row.status}
                      {row.status === 'failed' && row.step !== null ? ` at ${row.step}` : ''}
                    </Text>
                    {row.pr !== null && <Link key="pr" href={row.pr} label={prLabel(row.pr)} />}
                  </Box>
                  {expanded === row.task && details(row)}
                </Box>
              )
            })}
          </Box>
        )}

        {idle.length > 0 && (
          <Box key="idle" marginTop={1}>
            <Text dimColor wrap="wrap">no run yet: {idle.map(r => r.task).join(', ')}</Text>
          </Box>
        )}

        <Box key="footer" gap={1} marginTop={1}>
          <Button key="refresh" plain dimColor hotkey="r" onPress={() => void refresh($)}>
            refresh
          </Button>
          <Button key="close" plain dimColor role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
            close
          </Button>
        </Box>
      </Box>
    )
  })
}
