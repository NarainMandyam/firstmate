import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement, RenderPropsOf } from 'claude-code'

const PLUGIN = 'fleet-deck'
const HOME = '/srv/fm-home'
const NOW = 1_760_000_000_000
const SURFACES = ['terminal', 'desktop'] as const

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 7 },
  view: {},
}

const pane = (title: string): RenderPropsOf['Pane'] => ({
  title,
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

type Fixture = { calls: string[]; snapshotFails?: boolean }

const PR_URL = 'https://github.com/NarainMandyam/MealPrepper/pull/2'

// The parts of `fm-fleet-snapshot.v1` the deck reads: one live captain call per
// id, one aged hold that must stay out, a working task, a gone task with a PR
// waiting, and a blocked task.
const snapshot = (fixture: Fixture) => ({
  schema: 'fm-fleet-snapshot.v1',
  generated: '2026-10-10T17:00:00Z',
  backlog: {
    present: true,
    records: [
      ...fixture.calls.map(id => ({
        id,
        title: `Decide ${id}`,
        repo: 'writing-workbench',
        kind: 'scout',
        hold_kind: 'captain',
        hold_reason: `Captain said: think about ${id} later`,
        hold_bucket: 'live',
        captain_actionable: true,
      })),
      {
        id: 'ww-aged',
        title: 'An aged hold',
        hold_kind: 'captain',
        hold_bucket: 'aged',
        captain_actionable: false,
      },
    ],
  },
  tasks: [
    {
      id: 'fm-a',
      kind: 'ship',
      project: '/x/firstmate',
      current_state: { state: 'working', detail: 'harness busy', observed_at: '2026-10-10T17:00:00Z' },
      endpoint: { exists: true },
      pr: { url: null },
      hints: { pending_decision: false },
      backlog: { repo: 'firstmate', merged: null },
    },
    {
      id: 'mp-b',
      kind: 'ship',
      project: '/x/MealPrepper',
      current_state: { state: 'unknown', detail: 'backend target gone: default:wB:p2', observed_at: null },
      endpoint: { exists: false },
      pr: { url: PR_URL },
      hints: { pending_decision: false },
      backlog: { repo: 'MealPrepper', merged: null },
    },
    {
      id: 'fm-c',
      kind: 'scout',
      project: '/x/firstmate',
      current_state: { state: 'blocked', detail: 'needs a credential', observed_at: null },
      endpoint: { exists: true },
      pr: { url: null },
      hints: { pending_decision: true },
      backlog: null,
    },
  ],
})

const DF =
  'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
  '/dev/disk1s2 488245288 374119616 88788636 77% /System/Volumes/Data\n'

type Run = { argv: readonly string[]; stdin: string | undefined }

const ok = (stdout: string): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// The world beneath the plugin: a firstmate home at HOME whose scripts answer
// from fixtures, every answer recorded so a test can say what ran.
const arm = (
  on: On,
  world: {
    env?: Record<string, string>
    store?: Record<string, unknown>
    fixture: () => Fixture
    snapshotGate?: () => Promise<void> | undefined
  },
) => {
  const runs: Run[] = []
  const notified: string[] = []
  const fills: string[] = []
  const toasts: string[] = []
  mock.env(on, world.env ?? {})
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, world.store)
  on('session.root', () => ({ value: HOME }))
  on('fs.stat', ($, e) => ({
    value: {
      kind: 'dir' as const,
      size: 0,
      isLink: false,
      mtimeMs: e.path.endsWith('.last-watcher-beat') ? NOW - 9_000 : NOW,
      ...(e.resolve ? { realPath: e.path.replace(/\/+$/, '') } : {}),
    },
  }))
  on('fs.exists', ($, e) => ({ value: !e.path.endsWith('/.fm-secondmate-home') }))
  on('process.run', async ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const script = e.argv[0] ?? ''
    if (script.endsWith('/bin/fm-fleet-snapshot.sh')) {
      await world.snapshotGate?.()
      const fixture = world.fixture()
      if (fixture.snapshotFails) return { value: { ...ok(''), exitCode: 1, stderr: 'state unreadable' } }
      return { value: ok(JSON.stringify(snapshot(fixture))) }
    }
    if (script === 'df') return { value: ok(DF) }
    if (script.endsWith('/bin/fm-captain-hold.sh')) return { value: ok('answered\n') }
    if (script.endsWith('/bin/fm-inbox.sh')) return { value: ok('queued 1\n') }
    if (script.endsWith('/bin/fm-peek.sh')) return { value: ok('pane line one\npane line two\n') }
    if (script.endsWith('/bin/fm-crew-state.sh')) return { value: ok('state: working · source: pane · busy\n') }
    return { value: { ...ok(''), exitCode: 127, stderr: `unexpected command ${script}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', ($, e) => {
    notified.push(e.text)
    return { value: { isSent: true as const, channel: 'kitty' as const } }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // The engine's own band, drawn when the plugin passes: what an inert mod leaves.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, { key: 'engine-own' }, h(Text, null, 'engine band')) as RenderElement
  })
  return { runs, notified, fills, toasts, clock }
}

const scriptsRun = (runs: readonly Run[]) => runs.map(r => (r.argv[0] ?? '').split('/').pop())

test('band and panes draw the fleet on terminal and desktop, and every control routes through firstmate', async ($, on) => {
  const world = arm(on, { fixture: () => ({ calls: ['ww-nav'] }) })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await world.clock.advance(2_000)

  expect(scriptsRun(world.runs)).toEqual(['fm-fleet-snapshot.sh', 'df'])
  expect(world.runs[0]?.argv).toEqual([`${HOME}/bin/fm-fleet-snapshot.sh`, '--json'])

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ key: 'chip-calls' }))?.text).toContain('1 call for you')
    expect((await band.find({ key: 'chip-working' }))?.text).toContain('1 working')
    expect((await band.find({ key: 'chip-prs' }))?.text).toContain('1 PR to review')
    expect((await band.find({ key: 'chip-blocked' }))?.text).toContain('1 blocked')
    expect((await band.find({ key: 'chip-gone' }))?.text).toContain('1 gone')
    // The beacon is 9 s old at NOW and the first poll ran 1.5 s later.
    expect((await band.find({ key: 'chip-monitor' }))?.text).toContain('monitor 11s')
    expect((await band.find({ key: 'chip-disk' }))?.text).toContain('disk 77%')
    await band.press({ key: 'open-calls' })

    const calls = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'fleet-calls',
      props: pane('Calls for the captain'),
    })
    expect(await calls.find({ type: 'Text', text: 'Decide ww-nav' })).toBeDefined()
    expect(await calls.find({ type: 'Text', text: /aged hold/ })).toBeUndefined()
    expect(await calls.find({ type: 'Link' })).toMatchObject({ props: { href: PR_URL } })
    expect(await calls.find({ type: 'Text', text: 'needs a credential' })).toBeDefined()

    const before = world.runs.length
    await calls.input({ key: 'answer:ww-nav', text: '   ' })
    expect(world.runs.length).toBe(before)

    await calls.input({ key: 'answer:ww-nav', text: 'ship the timeline\tfirst' })
    expect(world.runs.slice(before).map(r => r.argv)).toEqual([
      [`${HOME}/bin/fm-captain-hold.sh`, 'answers', '--source', 'captain-deck'],
      [`${HOME}/bin/fm-inbox.sh`, 'note', 'Deck: captain answered ww-nav (close the call): ship the timeline first'],
      // The read that follows a recorded answer is never skipped by the press floor.
      [`${HOME}/bin/fm-fleet-snapshot.sh`, '--json'],
    ])
    expect(world.runs[before]?.stdin).toBe('ww-nav\tship the timeline first\tdeck: answer\tdone\n')
    expect((await calls.find({ key: 'notice' }))?.text).toContain('recorded ww-nav')

    const beforeGo = world.runs.length
    await calls.press({ key: 'go:ww-nav' })
    expect(world.runs[beforeGo]?.stdin).toBe('ww-nav\tgo\tdeck: go\trelease\n')
    expect(world.runs[beforeGo + 1]?.argv[1]).toBe('note')
    expect(world.runs[beforeGo + 2]?.argv[1]).toBe('--json')

    const beforeMerge = world.runs.length
    await calls.press({ key: 'merge:mp-b' })
    expect(world.runs.slice(beforeMerge).map(r => r.argv)).toEqual([
      [`${HOME}/bin/fm-inbox.sh`, 'note', `Deck: captain pressed Merge for mp-b - please merge ${PR_URL}`],
    ])

    await calls.press({ key: 'draft:fm-c' })
    expect(world.fills.at(-1)).toBe('On fm-c: ')

    const crew = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'fleet-crew',
      props: pane('Fleet'),
    })
    expect((await crew.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('peek:'))).toHaveLength(3)
    expect((await crew.find({ key: 'peek:fm-a' }))?.text).toContain('working')
    expect((await crew.find({ key: 'peek:mp-b' }))?.text).toContain('gone')
    const beforePeek = world.runs.length
    await crew.press({ key: 'peek:mp-b' })
    expect(world.runs.slice(beforePeek).map(r => r.argv)).toEqual([[`${HOME}/bin/fm-peek.sh`, 'mp-b', '40']])
    expect(await crew.find({ type: 'Text', text: 'pane line two' })).toBeDefined()
    await crew.press({ key: 'state:mp-b' })
    expect(world.runs.at(-1)?.argv).toEqual([`${HOME}/bin/fm-crew-state.sh`, 'mp-b'])
    expect(await crew.find({ type: 'Text', text: /source: pane/ })).toBeDefined()

    await band.unmount()
    await calls.unmount()
    await crew.unmount()
  }

  // Only firstmate's own entry points ever ran: nothing merged, drained or armed.
  const allowed = new Set(['fm-fleet-snapshot.sh', 'df', 'fm-captain-hold.sh', 'fm-inbox.sh', 'fm-peek.sh', 'fm-crew-state.sh'])
  for (const script of scriptsRun(world.runs)) expect(allowed.has(script ?? '')).toBe(true)
})

test('an answer recorded while a poll is in flight is followed by a fresh snapshot', async ($, on) => {
  let gate: Promise<void> | undefined
  let release = () => {}
  const world = arm(on, { fixture: () => ({ calls: ['ww-nav'] }), snapshotGate: () => gate })
  const snapshots = () => scriptsRun(world.runs).filter(s => s === 'fm-fleet-snapshot.sh').length
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await world.clock.advance(2_000)
  expect(snapshots()).toBe(1)

  gate = new Promise(resolve => {
    release = resolve
  })
  await world.clock.advance(60_000)
  expect(snapshots()).toBe(2)

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'open-calls' })
  const calls = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'fleet-calls',
    props: pane('Calls for the captain'),
  })
  await calls.input({ key: 'answer:ww-nav', text: 'ship it' })
  expect(scriptsRun(world.runs).slice(-2)).toEqual(['fm-captain-hold.sh', 'fm-inbox.sh'])
  expect(snapshots()).toBe(2)

  gate = undefined
  release()
  await world.clock.advance(1)
  expect(snapshots()).toBe(3)
  expect(world.runs.at(-1)?.argv).toEqual([`${HOME}/bin/fm-fleet-snapshot.sh`, '--json'])

  await world.clock.advance(1_000)
  expect(snapshots()).toBe(3)
  await band.unmount()
  await calls.unmount()
})

test('stays inert in a worker session', async ($, on) => {
  const world = arm(on, { env: { FM_TASK_ID: 'fm-mod-fleet-deck' }, fixture: () => ({ calls: ['ww-nav'] }) })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await world.clock.advance(120_000)
  expect(world.runs).toHaveLength(0)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'chip-calls' })).toBeUndefined()
    await band.unmount()
  }
})

test('alerts only when something new needs the captain', async ($, on) => {
  let calls = ['ww-nav']
  const world = arm(on, { fixture: () => ({ calls }) })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await world.clock.advance(2_000)
  // The first snapshot seeds what the captain already knows: no alert.
  expect(world.notified).toEqual([])

  calls = ['ww-nav', 'ww-outline']
  await world.clock.advance(60_000)
  expect(world.notified).toHaveLength(1)
  expect(world.toasts).toEqual([])
  expect(world.notified[0]).toContain('Decide ww-outline')
  expect(world.notified[0]).not.toContain('ww-nav')

  await world.clock.advance(60_000)
  expect(world.notified).toHaveLength(1)
  expect(scriptsRun(world.runs).filter(s => s === 'fm-fleet-snapshot.sh')).toHaveLength(3)
})

test('a snapshot failure shows on the band until the next snapshot succeeds', async ($, on) => {
  let snapshotFails = true
  const world = arm(on, { fixture: () => ({ calls: ['ww-nav'], snapshotFails }) })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await world.clock.advance(2_000)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /fleet snapshot failed \(exit 1\)/ })).toBeDefined()
    await band.unmount()
  }

  snapshotFails = false
  await world.clock.advance(60_000)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ key: 'chip-calls' }))?.text).toContain('1 call for you')
    expect(await band.find({ key: 'chip-notice' })).toBeUndefined()
    await band.unmount()
  }
})
