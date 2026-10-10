import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, ProcessRunResult, RenderPropsOf } from 'claude-code'

const PLUGIN = 'nm-monitor'
const HOME = '/srv/fm-home'
const NOW = 1_760_000_000_000
const SURFACES = ['terminal', 'desktop'] as const

const MP = '/srv/fm-home/projects/MealPrepper'
const MP_COPY = '/srv/pool/1/MealPrepper'
const FM = '/srv/fm-home'
const FM_COPY = '/srv/pool/2/firstmate'
const PR_URL = 'https://github.com/NarainMandyam/firstmate/pull/7'

const PANE: RenderPropsOf['Pane'] = {
  title: 'no-mistakes',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

// The fleet's task records: two pipeline tasks with runs, one not started, and
// two that never run the pipeline (a direct-PR ship and a scout).
const METAS: Record<string, string> = {
  'mp-core.meta': `worktree=${MP_COPY}\nproject=${MP}\nkind=ship\nmode=no-mistakes\n`,
  'mp-new.meta': `worktree=${MP_COPY}\nproject=${MP}\nkind=ship\nmode=no-mistakes\n`,
  'fm-deck.meta': `worktree=${FM_COPY}\nproject=${FM}\nkind=ship\nmode=no-mistakes\n`,
  'fm-direct.meta': `worktree=/srv/pool/3/firstmate\nproject=${FM}\nkind=ship\nmode=direct-PR\n`,
  'mp-scout.meta': `worktree=/srv/pool/4/MealPrepper\nproject=${MP}\nkind=scout\n`,
}

// `axi status` from the MealPrepper primary copy: the repository's runs, newest first.
const MP_LISTING = `current_branch: main
runs_on_current_branch: 0
count: 3 of 3 total
runs[3]{id,branch,status,head,pr}:
  "01RUNCORE",fm/mp-core,running,abc1234,""
  "01RUNOLD",fm/mp-core,failed,9f9f9f9,""
  "01RUNX",fm/mp-other,completed,1111111,"https://github.com/NarainMandyam/MealPrepper/pull/1"
`

// `axi status --run 01RUNCORE`: parked at the review gate four minutes in.
const MP_CORE_RUN = `run:
  id: "01RUNCORE"
  branch: fm/mp-core
  status: running
  head: abc1234
  pr: ""
  findings[2]{id,severity,file,line,action,description}:
    r1,warning,a.go,,auto-fix,ignored error
    r2,error,b.go,,ask-user,"changes product behavior, needs a call"
gate:
  step: review
  status: awaiting_approval
steps[4]{step,status,findings,duration_ms}:
  intent,completed,0,12
  rebase,completed,0,896
  review,awaiting_approval,2,240000
  test,pending,0,0
`

// `axi status` from the firstmate task copy, on its own branch: that run, finished.
const FM_DECK_RUN = `run:
  id: "01RUNDECK"
  branch: fm/fm-deck
  status: completed
  head: 1f1405e8
  pr: "${PR_URL}"
  findings: none
  steps[2]{step,status,findings,duration_ms}:
    review,completed,0,21023
    ci,completed,0,329084
outcome: passed
`

type Run = { cwd: string | undefined; argv: readonly string[]; timeoutMs: number | undefined }

const ok = (stdout: string): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// The world beneath the plugin: a firstmate home whose task records and
// no-mistakes answers come from the fixtures above, every command recorded.
const arm = (on: On, world: { env?: Record<string, string>; statusGate?: () => Promise<void> | undefined } = {}) => {
  const runs: Run[] = []
  const open = new Set<string>()
  const commands: string[] = []
  mock.env(on, world.env ?? {})
  const clock = mock.clock(on, { now: NOW })
  on('session.root', () => ({ value: HOME }))
  on('fs.stat', ($, e) => ({
    value: { kind: 'dir' as const, size: 0, isLink: false, mtimeMs: NOW, ...(e.resolve ? { realPath: e.path } : {}) },
  }))
  // The firstmate primary copy is not listable here, so its task is read from its own copy.
  on('fs.exists', ($, e) => ({ value: !e.path.endsWith('/.fm-secondmate-home') && e.path !== FM }))
  on('fs.list', () => ({
    value: Object.keys(METAS).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })),
  }))
  on('fs.read', ($, e) => ({ value: METAS[e.path.split('/').pop() ?? ''] ?? '' }))
  on('process.run', async ($, e) => {
    runs.push({ cwd: e.init?.cwd, argv: e.argv, timeoutMs: e.init?.timeoutMs })
    const args = e.argv.join(' ')
    if (args === 'no-mistakes axi status') {
      await world.statusGate?.()
      if (e.init?.cwd === MP) return { value: ok(MP_LISTING) }
      if (e.init?.cwd === FM_COPY) return { value: ok(FM_DECK_RUN) }
    }
    if (args === 'no-mistakes axi status --run 01RUNCORE') return { value: ok(MP_CORE_RUN) }
    if (args === 'no-mistakes axi logs --run 01RUNCORE --step review') return { value: ok('reviewing b.go\nround 2 of 3\n') }
    return { value: { ...ok(''), exitCode: 1, stderr: `unexpected ${args}` } }
  })
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })),
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return { runs, open, commands, clock }
}

const openMonitor = ($: EngineInterface) =>
  $.command.run({ command: 'nm', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('hidden until /nm, then one row per pipeline run, read-only, and the poll stops with the pane', async ($, on) => {
  const world = arm(on)
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await world.clock.advance(60_000)
  // Nothing opens and nothing is read until the captain asks.
  expect(world.open.size).toBe(0)
  expect(world.runs).toHaveLength(0)

  expect((await openMonitor($)).text).toContain('opened')
  await world.clock.advance(1)
  expect(world.open.has('nm-monitor')).toBe(true)
  // The direct-PR ship and the scout are never asked about.
  expect(world.runs.some(r => r.cwd?.includes('/pool/3/') || r.cwd?.includes('/pool/4/'))).toBe(false)

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'nm-monitor', props: PANE })
    expect(await pane.find({ type: 'Text', text: '1 running' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '1 waiting on a decision' })).toBeDefined()
    // The newest run for the branch wins over the older failed one.
    expect((await pane.find({ key: 'open:mp-core' }))?.text).toContain('fm/mp-core')
    expect(await pane.find({ type: 'Text', text: 'review' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '4m' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /2 findings \(1 ask-user\)/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /waiting on a decision/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'passed' })).toBeDefined()
    expect(await pane.find({ type: 'Link' })).toMatchObject({ props: { href: PR_URL } })
    expect(await pane.find({ type: 'Text', text: 'no run yet: mp-new' })).toBeDefined()

    await pane.press({ key: 'open:mp-core' })
    expect(await pane.find({ type: 'Text', text: /review ⏸/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /changes product behavior, needs a call/ })).toBeDefined()
    await pane.press({ key: 'log:mp-core' })
    expect(await pane.find({ type: 'Text', text: 'round 2 of 3' })).toBeDefined()
    await pane.press({ key: 'open:mp-core' })
    await pane.unmount()
  }

  // Polls continue while the pane is open, then stop once it is closed.
  const beforeTick = world.runs.length
  await world.clock.advance(15_000)
  expect(world.runs.length).toBeGreaterThan(beforeTick)
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'nm-monitor', props: PANE })
  await pane.press({ key: 'close' })
  await pane.unmount()
  const afterClose = world.runs.length
  await world.clock.advance(120_000)
  expect(world.runs.length).toBe(afterClose)

  // Only no-mistakes' read commands ever ran, each with a timeout.
  for (const run of world.runs) {
    expect(run.argv.slice(0, 3).join(' ')).toMatch(/^no-mistakes axi (status|logs)/)
    expect(run.timeoutMs).toBe(10_000)
  }
})

test('a poll still reading skips the next tick instead of piling up', async ($, on) => {
  let gate: Promise<void> | undefined
  let release = () => {}
  const world = arm(on, { statusGate: () => gate })
  const statusReads = () => world.runs.filter(r => r.argv.join(' ') === 'no-mistakes axi status').length
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  gate = new Promise(resolve => {
    release = resolve
  })
  await openMonitor($)
  await world.clock.advance(1)
  expect(statusReads()).toBe(1)
  await world.clock.advance(45_000)
  expect(statusReads()).toBe(1)

  gate = undefined
  release()
  await world.clock.advance(15_000)
  expect(statusReads()).toBeGreaterThan(1)
})

test('stays inert in a worker session', async ($, on) => {
  const world = arm(on, { env: { FM_TASK_ID: 'mp-core' } })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  expect(world.commands).toEqual([])
  await world.clock.advance(60_000)
  expect(world.runs).toHaveLength(0)
})
