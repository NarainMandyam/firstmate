// fleet-deck: the captain's deck for firstmate's primary Claude Code session.
//
// A band above the prompt (calls waiting, workers busy, PRs to review, workers
// gone, monitoring age, disk), a Calls pane whose controls record the captain's
// answer through firstmate's one keyed-answer intake and then wake firstmate
// with an inbox note, and a Fleet pane with one row per task and a peek key.
//
// Boundaries, by design:
// - Inert unless this is the primary firstmate session: FM_TASK_ID unset, the
//   session root a firstmate home (resolved, never a hardcoded path), not a
//   secondmate home, and FM_HOME absent or resolving to that same root.
// - Reads the fleet only through `bin/fm-fleet-snapshot.sh --json` once a
//   minute (with a timeout, skipping a tick while one still runs), plus
//   `bin/fm-crew-state.sh` and `bin/fm-peek.sh` on a press, `df` for the disk
//   chip, and the mtime of the watcher beacon for the monitoring chip.
// - Writes only through `bin/fm-captain-hold.sh answers --source captain-deck`
//   and `bin/fm-inbox.sh note`. Merge files a note asking firstmate to merge;
//   nothing here merges, drains, arms, or types into the session.
// - Never calls `$.prompt.submit` and never hooks `classic.Stop`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deck, DeckPeek, DeckVitals } from '../types'
import {
  DISK_FULL_PCT,
  MONITOR_LATE_MS,
  ageText,
  alertKeys,
  cut,
  describeKeys,
  parseDf,
  projectDeck,
} from './project'

const CALLS_PANE = 'fleet-calls'
const CREW_PANE = 'fleet-crew'
const CALLS_TITLE = 'Calls for the captain'
const CREW_TITLE = 'Fleet'
const ANSWER_SOURCE = 'captain-deck'
const POLL_MS = 60_000
const FIRST_POLL_MS = 1_500
const PRESS_REFRESH_FLOOR_MS = 10_000
const DISK_EVERY_N_POLLS = 5
const SNAPSHOT_TIMEOUT_MS = 50_000
const COMMAND_TIMEOUT_MS = 20_000
const PEEK_LINES = 40
const STORE_ALERTED = 'alerted-keys'
// Every snapshot-failure notice starts with this, so a later success can clear
// it without touching an answer or merge notice.
const SNAPSHOT_NOTICE = 'fleet snapshot'

const deckAtom = atom({ plugin: 'fleet-deck', key: 'deck' } as const, null)
const vitalsAtom = atom({ plugin: 'fleet-deck', key: 'vitals' } as const, {
  monitorAgeMs: null,
  diskUsedPct: null,
  diskFreeGb: null,
})
const isHiddenAtom = atom({ plugin: 'fleet-deck', key: 'isHidden' } as const, false)
const peekAtom = atom({ plugin: 'fleet-deck', key: 'peek' } as const, null)
const noticeAtom = atom({ plugin: 'fleet-deck', key: 'notice' } as const, null)

type Dollar = EngineInterface

const oneLine = (value: string): string => value.replace(/[\t\r\n]+/g, ' ').trim()

// The resolved firstmate home while the mod is active; null keeps every hook
// inert. Module state is lost on a hot reload, and session.start runs again
// then, so it is recomputed rather than persisted.
let home: string | null = null
let timer: { cancel: () => void } | null = null
let isRefreshing = false
let isWriteRefreshOwed = false
let lastRefreshAt = 0
let polls = 0
let lastDisk: { usedPct: number; freeGb: number } | null = null
// null until the first snapshot seeds it: a session's first snapshot never
// alerts for what the captain already knew about.
let alerted: Set<string> | null = null
// The text typed into each call's answer field, read by its Go button.
const drafts = new Map<string, string>()

const bin = (script: string): string => `${home}/bin/${script}`

const run = ($: Dollar, argv: readonly string[], init?: { stdin?: string; timeoutMs?: number }) =>
  $.process.run(argv, {
    cwd: home ?? undefined,
    env: { FM_HOME: home ?? '' },
    timeoutMs: init?.timeoutMs ?? COMMAND_TIMEOUT_MS,
    ...(init?.stdin === undefined ? {} : { stdin: init.stdin }),
  })

const setNotice = ($: Dollar, notice: string | null) => update($, noticeAtom, () => notice)

/** The firstmate home this session is the primary of, or null to stay inert. */
const resolveHome = async ($: Dollar): Promise<string | null> => {
  if ((await $.env.get('FM_TASK_ID')) !== undefined) return null
  const root = await $.session.root()
  const realOf = async (path: string): Promise<string | null> => {
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    return stat?.realPath ?? null
  }
  const real = (await realOf(root)) ?? root
  for (const marker of ['AGENTS.md', 'bin/fm-fleet-snapshot.sh', 'bin/fm-captain-hold.sh', 'bin/fm-inbox.sh']) {
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

const loadAlerted = async ($: Dollar): Promise<Set<string> | null> => {
  const stored = await $.store.get(STORE_ALERTED).catch(() => undefined)
  return Array.isArray(stored) ? new Set(stored.filter(k => typeof k === 'string')) : null
}

const readVitals = async ($: Dollar, now: number): Promise<DeckVitals> => {
  const beacon = await $.fs.stat(`${home}/state/.last-watcher-beat`).catch(() => undefined)
  if (polls % DISK_EVERY_N_POLLS === 1 || lastDisk === null) {
    const df = await run($, ['df', '-P', '-k', home ?? '/'], { timeoutMs: 5_000 }).catch(() => undefined)
    if (df !== undefined && df.exitCode === 0) lastDisk = parseDf(df.stdout) ?? lastDisk
  }
  return {
    monitorAgeMs: beacon === undefined ? null : Math.max(0, now - beacon.mtimeMs),
    diskUsedPct: lastDisk?.usedPct ?? null,
    diskFreeGb: lastDisk?.freeGb ?? null,
  }
}

/** One native notification, only for keys that just appeared; nothing else notifies. */
const announce = async ($: Dollar, deck: Deck, vitals: DeckVitals) => {
  const keys = alertKeys(deck, vitals)
  const previous = alerted
  alerted = new Set(keys)
  await $.store.set(STORE_ALERTED, keys).catch(() => undefined)
  if (previous === null) return
  const fresh = keys.filter(k => !previous.has(k))
  if (fresh.length === 0) return
  await $.ui.notify(describeKeys(fresh, deck), { title: 'Firstmate needs you' }).catch(() => undefined)
}

// `timer` is the poll, `press` a manual refresh bounded by the press floor, and
// `write` the read that follows a recorded answer, which must not be skipped:
// a stale card invites a repeat press and a duplicate inbox note.
const refresh = async ($: Dollar, origin: 'timer' | 'press' | 'write') => {
  if (home === null) return
  if (isRefreshing) {
    if (origin === 'write') isWriteRefreshOwed = true
    return
  }
  const now = await $.clock.now()
  if (origin === 'press' && now - lastRefreshAt < PRESS_REFRESH_FLOOR_MS) return
  isRefreshing = true
  lastRefreshAt = now
  try {
    const ran = await run($, [bin('fm-fleet-snapshot.sh'), '--json'], { timeoutMs: SNAPSHOT_TIMEOUT_MS })
    if (ran.exitCode !== 0 || ran.isStdoutTruncated) {
      await setNotice($, `${SNAPSHOT_NOTICE} failed (exit ${ran.exitCode}): ${cut(ran.stderr, 100)}`)
      return
    }
    polls += 1
    const deck = projectDeck(JSON.parse(ran.stdout), now)
    const vitals = await readVitals($, now)
    await update($, deckAtom, () => deck)
    await update($, vitalsAtom, () => vitals)
    await update($, noticeAtom, notice => (notice !== null && notice.startsWith(SNAPSHOT_NOTICE) ? null : notice))
    await announce($, deck, vitals)
  } catch (error) {
    await setNotice($, `${SNAPSHOT_NOTICE} error: ${cut(String(error), 100)}`)
  } finally {
    isRefreshing = false
    if (isWriteRefreshOwed) {
      isWriteRefreshOwed = false
      void refresh($, 'write')
    }
  }
}

/**
 * Records the captain's answer through the one keyed-answer intake, then
 * files an inbox note so firstmate wakes and acts. `done` closes the call,
 * `release` lifts the hold so a held work item resumes.
 */
const answerCall = async ($: Dollar, id: string, raw: string, mode: 'done' | 'release') => {
  if (home === null) return
  const answer = oneLine(raw)
  if (answer === '') {
    await setNotice($, `${id}: type an answer first`)
    return
  }
  const label = mode === 'release' ? 'deck: go' : 'deck: answer'
  const recorded = await run($, [bin('fm-captain-hold.sh'), 'answers', '--source', ANSWER_SOURCE], {
    stdin: `${id}\t${answer}\t${label}\t${mode}\n`,
  }).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const report = cut(`${recorded.stdout}\n${recorded.stderr}`, 140)
  if (recorded.exitCode !== 0) {
    await setNotice($, `${id}: answer NOT recorded - ${report}`)
    $.ui.toast(`${id}: answer not recorded - ${report}`)
    return
  }
  drafts.delete(id)
  const note = `Deck: captain answered ${id} (${mode === 'release' ? 'resume the held work' : 'close the call'}): ${answer}`
  const noted = await run($, [bin('fm-inbox.sh'), 'note', note]).catch(error => ({
    exitCode: 1,
    stdout: '',
    stderr: String(error),
  }))
  if (noted.exitCode !== 0) {
    await setNotice($, `${id}: recorded, but firstmate was not woken - ${cut(noted.stderr, 100)}`)
  } else {
    await setNotice($, `recorded ${id}: ${cut(answer, 80)}`)
  }
  void refresh($, 'write')
}

/** Merge never merges: it asks firstmate, who holds the merge authority. */
const requestMerge = async ($: Dollar, id: string, url: string) => {
  if (home === null) return
  const note = `Deck: captain pressed Merge for ${id} - please merge ${url}`
  const noted = await run($, [bin('fm-inbox.sh'), 'note', note]).catch(error => ({
    exitCode: 1,
    stdout: '',
    stderr: String(error),
  }))
  await setNotice(
    $,
    noted.exitCode === 0
      ? `asked firstmate to merge ${id}`
      : `merge request for ${id} NOT filed - ${cut(noted.stderr, 100)}`,
  )
}

const inspect = async ($: Dollar, id: string, kind: DeckPeek['kind']) => {
  if (home === null) return
  const current = await read($, peekAtom)
  if (current !== null && current.id === id && current.kind === kind) {
    await update($, peekAtom, () => null)
    return
  }
  const argv = kind === 'peek' ? [bin('fm-peek.sh'), id, String(PEEK_LINES)] : [bin('fm-crew-state.sh'), id]
  const ran = await run($, argv).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const text = ran.exitCode === 0 ? ran.stdout : `${ran.stdout}\n${ran.stderr}`.trim() || `exit ${ran.exitCode}`
  const at = await $.clock.now()
  await update($, peekAtom, () => ({ id, kind, text, at }))
}

const openPane = async ($: Dollar, id: typeof CALLS_PANE | typeof CREW_PANE) => {
  await update($, isHiddenAtom, () => false)
  return $.ui.open({ id, title: id === CALLS_PANE ? CALLS_TITLE : CREW_TITLE, focus: true })
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = await resolveHome($)
    if (home === null) return next(e)
    await $.command.register({
      name: 'deck',
      description: "Open the captain's deck: every call, PR and blocker waiting on you",
    })
    await $.command.register({
      name: 'crew',
      description: 'Open the fleet pane: one row per worker, with a peek key',
    })
    alerted = await loadAlerted($)
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($, 'timer'))
    $.clock.after(FIRST_POLL_MS, () => void refresh($, 'timer'))
    return next(e)
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = null
    return next(e)
  })

  on('command.run', { command: 'deck' }, async $ => {
    if (home === null) return { text: 'fleet-deck is inert here: not a firstmate primary session.' }
    const opened = await openPane($, CALLS_PANE)
    return { text: opened.isPlaced ? 'Calls pane opened.' : `Calls pane waits: ${opened.reason}` }
  })

  on('command.run', { command: 'crew' }, async $ => {
    if (home === null) return { text: 'fleet-deck is inert here: not a firstmate primary session.' }
    const opened = await openPane($, CREW_PANE)
    return { text: opened.isPlaced ? 'Fleet pane opened.' : `Fleet pane waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (home === null || e.props.hasSurvey || (await read($, isHiddenAtom))) return next(e)
    const deck = await read($, deckAtom)
    const notice = await read($, noticeAtom)
    if (deck === null && notice === null) return next(e)
    const vitals = await read($, vitalsAtom)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    if (deck === null) {
      return (
        <Box key="band" width={e.props.bodyColumns} gap={1}>
          <Text color="warning" wrap="truncate-end">⚓ {notice}</Text>
        </Box>
      )
    }

    const c = deck.counts
    const isWorking = c.working > 0
    const monitorLate = vitals.monitorAgeMs !== null && vitals.monitorAgeMs > MONITOR_LATE_MS
    const staleMs = now - deck.fetchedAt
    return (
      <Box key="band" width={e.props.bodyColumns} flexWrap="wrap" columnGap={2}>
        <Box key="chip-calls">
          <Text color={c.calls > 0 ? 'warning' : 'subtle'} bold={c.calls > 0}>
            ⚓ {c.calls === 0 ? 'no calls for you' : `${c.calls} call${c.calls === 1 ? '' : 's'} for you`}
          </Text>
        </Box>
        <Box key="chip-working">
          <Text dimColor={!isWorking}>{c.working} working</Text>
        </Box>
        {c.prs > 0 && (
          <Box key="chip-prs">
            <Text color="success">{c.prs} PR{c.prs === 1 ? '' : 's'} to review</Text>
          </Box>
        )}
        {c.blocked > 0 && (
          <Box key="chip-blocked">
            <Text color="error">{c.blocked} blocked</Text>
          </Box>
        )}
        {c.gone > 0 && (
          <Box key="chip-gone">
            <Text color="warning">{c.gone} gone</Text>
          </Box>
        )}
        <Box key="chip-monitor">
          <Text {...(monitorLate && isWorking ? { color: 'error' } : { dimColor: true })}>
            monitor {vitals.monitorAgeMs === null ? 'none' : ageText(vitals.monitorAgeMs)}
          </Text>
        </Box>
        {vitals.diskUsedPct !== null && (
          <Box key="chip-disk">
            <Text
              {...(vitals.diskUsedPct >= DISK_FULL_PCT
                ? { color: 'error' }
                : vitals.diskUsedPct >= 80
                  ? { color: 'warning' }
                  : { dimColor: true })}
            >
              disk {vitals.diskUsedPct}%
            </Text>
          </Box>
        )}
        {staleMs > 5 * 60_000 && (
          <Box key="chip-stale">
            <Text color="warning">snapshot {ageText(staleMs)} old</Text>
          </Box>
        )}
        {notice !== null && (
          <Box key="chip-notice">
            <Text dimColor wrap="truncate-end">{cut(notice, 60)}</Text>
          </Box>
        )}
        <Box key="band-buttons" gap={1}>
          <Button key="open-calls" hotkey="c" onPress={() => void openPane($, CALLS_PANE)}>
            Calls
          </Button>
          <Button key="open-crew" hotkey="f" onPress={() => void openPane($, CREW_PANE)}>
            Fleet
          </Button>
          <Button key="hide" plain dimColor onPress={() => void update($, isHiddenAtom, () => true)}>
            hide
          </Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CALLS_PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    // The mobile table draws no Input: there the call takes Go or a chat reply.
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input
    const deck = await read($, deckAtom)
    const notice = await read($, noticeAtom)
    const width = Math.max(20, e.props.bodyColumns)

    if (deck === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{notice ?? 'Reading the fleet…'}</Text>
        </Box>
      )
    }

    const blocked = deck.workers.filter(w => w.needsCaptain)
    const isEmpty = deck.calls.length === 0 && deck.prs.length === 0 && blocked.length === 0
    return (
      <Box flexDirection="column" width={width}>
        {notice !== null && (
          <Box key="notice" marginBottom={1}>
            <Text color="suggestion" wrap="wrap">{notice}</Text>
          </Box>
        )}
        {isEmpty && <Text dimColor>Nothing is waiting on you.</Text>}

        {deck.calls.length > 0 && (
          <Box key="calls" flexDirection="column" marginBottom={1}>
            <Text bold>Decisions ({deck.calls.length})</Text>
            {deck.calls.map(call => (
              <Box key={`call:${call.id}`} flexDirection="column" marginTop={1}>
                <Box gap={1}>
                  <Text bold wrap="truncate-end">{call.title}</Text>
                  <Text dimColor wrap="truncate-end">{call.repo ?? ''} · {call.id}</Text>
                </Box>
                {call.reason !== '' && <Text dimColor wrap="wrap">{cut(call.reason, 300)}</Text>}
                {Input !== null && (
                  <Input
                    key={`answer:${call.id}`}
                    placeholder="your answer; Enter records it and closes the call"
                    submitLabel="answer"
                    onInput={value => {
                      drafts.set(call.id, value)
                    }}
                    onSubmit={value => void answerCall($, call.id, value, 'done')}
                  />
                )}
                <Box gap={1}>
                  <Button
                    key={`go:${call.id}`}
                    onPress={() => void answerCall($, call.id, (drafts.get(call.id) ?? '') || 'go', 'release')}
                  >
                    Go: resume the held work
                  </Button>
                  <Button
                    key={`draft:${call.id}`}
                    plain
                    dimColor
                    onPress={() => void $.prompt.fill({ text: `On ${call.id}: `, mode: 'replace' })}
                  >
                    reply in chat
                  </Button>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {deck.prs.length > 0 && (
          <Box key="prs" flexDirection="column" marginBottom={1}>
            <Text bold>PRs to review ({deck.prs.length})</Text>
            {deck.prs.map(pr => (
              <Box key={`pr:${pr.id}`} flexDirection="column" marginTop={1}>
                <Box gap={1}>
                  <Text bold>{pr.id}</Text>
                  <Text dimColor wrap="truncate-end">{pr.repo ?? ''} · worker {pr.state}</Text>
                </Box>
                <Link href={pr.url} />
                <Box gap={1}>
                  <Button key={`merge:${pr.id}`} onPress={() => void requestMerge($, pr.id, pr.url)}>
                    Merge (asks firstmate)
                  </Button>
                  <Button
                    key={`copy:${pr.id}`}
                    plain
                    dimColor
                    onPress={press => void $.ui.copy({ text: pr.url, surface: press.surface })}
                  >
                    copy link
                  </Button>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {blocked.length > 0 && (
          <Box key="blocked" flexDirection="column" marginBottom={1}>
            <Text bold>Workers waiting on you ({blocked.length})</Text>
            {blocked.map(w => (
              <Box key={`blocked:${w.id}`} flexDirection="column" marginTop={1}>
                <Box gap={1}>
                  <Text color="error">{w.id}</Text>
                  <Text dimColor wrap="truncate-end">{w.repo ?? ''} · {w.state}</Text>
                </Box>
                {w.detail !== '' && <Text dimColor wrap="wrap">{cut(w.detail, 300)}</Text>}
                <Box gap={1}>
                  <Button
                    key={`draft:${w.id}`}
                    plain
                    dimColor
                    onPress={() => void $.prompt.fill({ text: `On ${w.id}: `, mode: 'replace' })}
                  >
                    reply in chat
                  </Button>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        <Box key="footer" gap={1} marginTop={1}>
          <Button key="refresh-calls" plain dimColor hotkey="r" onPress={() => void refresh($, 'press')}>
            refresh
          </Button>
          <Button key="close-calls" plain dimColor role="dismiss" onPress={() => void $.ui.close({ id: CALLS_PANE })}>
            close
          </Button>
        </Box>
        <Text dimColor wrap="wrap">
          Answers are recorded in firstmate's own records and firstmate is woken to act; Merge only asks.
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CREW_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const deck = await read($, deckAtom)
    const peek = await read($, peekAtom)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)

    if (deck === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Reading the fleet…</Text>
        </Box>
      )
    }

    const tone = (w: Deck['workers'][number]): 'error' | 'warning' | 'success' | 'merged' | 'text' =>
      w.needsCaptain ? 'error' : w.isGone ? 'warning' : w.state === 'working' ? 'success' : w.state === 'done' ? 'merged' : 'text'

    return (
      <Box flexDirection="column" width={width}>
        <Box gap={1}>
          <Text bold>Fleet ({deck.workers.length})</Text>
          <Text dimColor>snapshot {ageText(now - deck.fetchedAt)} ago</Text>
        </Box>
        {deck.workers.length === 0 && <Text dimColor>No workers.</Text>}
        {deck.workers.map((w, index) => (
          <Box key={`row:${w.id}`} flexDirection="column">
            <Button
              key={`peek:${w.id}`}
              plain
              {...(index < 9 ? { hotkey: String(index + 1) } : {})}
              onPress={() => void inspect($, w.id, 'peek')}
            >
              {w.id} <Text dimColor>{w.repo ?? ''}</Text> <Text color={tone(w)}>{w.isGone ? 'gone' : w.state}</Text>{' '}
              <Text dimColor>{cut(w.detail, 50)}</Text>
              {w.pr !== null && <Text color="success"> PR</Text>}
            </Button>
            {peek !== null && peek.id === w.id && (
              <Box flexDirection="column" marginLeft={3} borderStyle="single" borderDimColor paddingX={1}>
                <Box gap={1}>
                  <Text dimColor>{peek.kind === 'peek' ? `last ${PEEK_LINES} lines` : 'current state'}</Text>
                  <Button key={`state:${w.id}`} plain dimColor onPress={() => void inspect($, w.id, 'state')}>
                    state
                  </Button>
                  <Button key={`repeek:${w.id}`} plain dimColor onPress={() => void inspect($, w.id, 'peek')}>
                    {peek.kind === 'peek' ? 'hide' : 'peek'}
                  </Button>
                </Box>
                {peek.text
                  .split('\n')
                  .slice(-PEEK_LINES)
                  .map(line => (
                    <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
                  ))}
              </Box>
            )}
          </Box>
        ))}
        <Box key="footer" gap={1} marginTop={1}>
          <Button key="refresh-crew" plain dimColor hotkey="r" onPress={() => void refresh($, 'press')}>
            refresh
          </Button>
          <Button key="close-crew" plain dimColor role="dismiss" onPress={() => void $.ui.close({ id: CREW_PANE })}>
            close
          </Button>
        </Box>
      </Box>
    )
  })
}
