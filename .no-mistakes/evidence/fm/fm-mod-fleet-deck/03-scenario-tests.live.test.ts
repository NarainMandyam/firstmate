import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement } from 'claude-code'
import { SNAP1, SNAP2 } from './snap.js'

const PLUGIN = 'fleet-deck'
const HOME = '/tmp/fd-home'
const NOW = 1_760_000_000_000
const BAND = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 7 }, view: {} } as any
const pane = (title: string) => ({ title, isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as any
const ok = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const dfOut = (pct: number) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1s2 488245288 374119616 88788636 ${pct}% /System/Volumes/Data\n`

const flat = (n: any, depth = 0): string[] => {
  if (n == null || n === false) return []
  if (typeof n === 'string' || typeof n === 'number') return [String(n)]
  if (Array.isArray(n)) return n.flatMap(c => flat(c, depth))
  const kids = flat(n.children ?? n.props?.children, depth + 1)
  const label = n.type === 'Button' ? `[${kids.join('')}]` : n.type === 'Input' ? `<input ${n.key ?? n.props?.key ?? ''}>` : n.type === 'Link' ? `${kids.join('')} <${n.props?.href}>` : null
  if (label) return [label]
  if (n.type === 'Text') return [kids.join('')]
  const dir = n.props?.flexDirection ?? 'column'
  return dir === 'row' ? [kids.join(' ')] : kids
}
const dump = async (tag: string, h: any) => {
  const btns = (await h.findAll({ type: 'Button' })).map((b: any) => `[${b.text}]${b.props?.hotkey ? ' (' + b.props.hotkey + ')' : ''}  key=${b.key}`)
  const lines = flat(await h.drawn()).filter(l => l.trim() && l !== '[]')
  console.log(`==${tag}==\n` + lines.join('\n') + '\n-- buttons --\n' + btns.join('\n') + `\n==end ${tag}==`)
}

type W = { env?: Record<string, string>; root?: string; secondmate?: boolean; missing?: string; snap: () => any; beaconAgeMs?: number; diskPct?: number; store?: Record<string, unknown> }
const arm = (on: On, w: W) => {
  const runs: { argv: readonly string[]; stdin?: string; timeoutMs?: number }[] = []
  const notified: string[] = []
  mock.env(on, w.env ?? {})
  const clock = mock.clock(on, { now: NOW })
  const store = w.store ?? {}
  mock.store(on, store)
  on('session.root', () => ({ value: w.root ?? HOME }))
  on('fs.stat', ($, e) => ({ value: { kind: 'dir' as const, size: 0, isLink: false, mtimeMs: e.path.endsWith('.last-watcher-beat') ? NOW - (w.beaconAgeMs ?? 9_000) : NOW, ...(e.resolve ? { realPath: e.path.replace(/\/+$/, '') } : {}) } }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/.fm-secondmate-home') ? !!w.secondmate : !(w.missing && e.path.endsWith(w.missing)) }))
  on('process.run', async ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: (e.init as any)?.timeoutMs })
    const s = e.argv[0] ?? ''
    if (s.endsWith('/bin/fm-fleet-snapshot.sh')) return { value: ok(JSON.stringify(w.snap())) }
    if (s === 'df') return { value: ok(dfOut(w.diskPct ?? 71)) }
    if (s.endsWith('/bin/fm-captain-hold.sh')) return { value: ok('answered\n') }
    if (s.endsWith('/bin/fm-inbox.sh')) return { value: ok('queued 1\n') }
    return { value: { ...ok(''), exitCode: 127 } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', ($, e) => { notified.push(e.text); return { value: { isSent: true as const, channel: 'kitty' as const } } })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box, Text } = $.ui.resolve(e); return h(Box, { key: 'engine-own' }, h(Text, null, 'engine band')) as RenderElement })
  return { runs, notified, clock, store }
}
const names = (runs: { argv: readonly string[] }[]) => runs.map(r => (r.argv[0] ?? '').split('/').pop())

test('LIVE: real fm-fleet-snapshot.v1 output drives band and calls pane; answer emits keyed line', async ($, on) => {
  const w = arm(on, { snap: () => SNAP1 })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(2_000)
  console.log('SNAPRUN', JSON.stringify(w.runs[0]))
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    await dump(`band-${surface}`, band)
    expect((await band.find({ key: 'chip-calls' }))?.text).toContain('2 calls for you')
    await band.press({ key: 'open-calls' })
    const calls = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'fleet-calls', props: pane('Calls for the captain') })
    await dump(`calls-${surface}`, calls)
    expect(await calls.find({ type: 'Text', text: 'Decide the navigation order' })).toBeDefined()
    expect(await calls.find({ type: 'Text', text: 'Choose the outline style' })).toBeDefined()
    if (surface === 'terminal') {
      const b = w.runs.length
      await calls.input({ key: 'answer:ww-nav', text: 'timeline first' })
      console.log('ANSWER_RUNS', JSON.stringify(w.runs.slice(b)))
      await dump('calls-after-answer', calls)
    }
    await band.unmount(); await calls.unmount()
  }
  const allowed = new Set(['fm-fleet-snapshot.sh', 'df', 'fm-captain-hold.sh', 'fm-inbox.sh'])
  for (const n of names(w.runs)) expect(allowed.has(n ?? '')).toBe(true)
  expect(w.runs.find(r => names([r])[0] === 'fm-fleet-snapshot.sh')?.timeoutMs).toBeGreaterThan(0)
})

test('RESTART: a restart does not re-notify known items, but does notify one that is new', async ($, on) => {
  let snap: any = { ...SNAP1, backlog: { ...SNAP1.backlog, records: SNAP1.backlog.records.filter((r: any) => r.id === 'ww-nav') } }
  const w = arm(on, { snap: () => snap })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(2_000)
  expect(w.notified).toEqual([])
  await $.session.end({ reason: 'exit' } as any).catch(() => {})
  console.log('STORE_AFTER_SESSION1', JSON.stringify(w.store))
  // restart with the same persisted store: same call -> silence
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(2_000)
  expect(w.notified).toEqual([])
  // a new call arrives -> exactly one notification naming only the new one
  snap = SNAP1
  await w.clock.advance(60_000)
  console.log('NOTIFIED', JSON.stringify(w.notified))
  expect(w.notified).toHaveLength(1)
  expect(w.notified[0]).toContain('Choose the outline style')
  expect(w.notified[0]).not.toContain('navigation')
  await w.clock.advance(180_000)
  expect(w.notified).toHaveLength(1)
})

test('VITALS: quiet monitor while working and disk >= 90% notify once each; healthy vitals do not', async ($, on) => {
  const working = { ...SNAP1, tasks: [{ id: 'fm-a', kind: 'ship', project: '/x/firstmate', current_state: { state: 'working', detail: 'busy', observed_at: null }, endpoint: { exists: true }, pr: { url: null }, hints: { pending_decision: false }, backlog: null }] }
  let beacon = 9_000
  let disk = 71
  const w = arm(on, { snap: () => working, get beaconAgeMs() { return beacon }, get diskPct() { return disk } } as any)
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(2_000)
  await w.clock.advance(60_000)
  expect(w.notified).toEqual([])
  beacon = 11 * 60_000
  await w.clock.advance(60_000)
  disk = 95
  for (let i = 0; i < 6; i++) await w.clock.advance(60_000)
  console.log('VITAL_NOTIFIED', JSON.stringify(w.notified))
  expect(w.notified.some(t => /monitoring has gone quiet/.test(t))).toBe(true)
  expect(w.notified.some(t => /disk is nearly full/.test(t))).toBe(true)
  expect(w.notified).toHaveLength(2)
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await dump('band-vitals-alarm', band)
  await band.unmount()
})

for (const [name, world] of [
  ['root is not a firstmate home (no AGENTS.md)', { missing: '/AGENTS.md' }],
  ['root is not a firstmate home (no fm-captain-hold.sh)', { missing: '/bin/fm-captain-hold.sh' }],
  ['root is a secondmate home', { secondmate: true }],
  ['FM_HOME resolves to a different home', { env: { FM_HOME: '/srv/other-home' } }],
  ['FM_TASK_ID set (worker), even empty', { env: { FM_TASK_ID: '' } }],
] as const) {
  test(`INERT: ${name}`, async ($, on) => {
    const w = arm(on, { ...(world as any), snap: () => SNAP1 })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    await w.clock.advance(180_000)
    expect(w.runs).toHaveLength(0)
    expect(w.notified).toHaveLength(0)
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'engine-own' })).toBeDefined()
    expect(await band.find({ key: 'chip-calls' })).toBeUndefined()
    await band.unmount()
  })
}

test('CONTROL: FM_HOME equal to the root keeps the deck live', async ($, on) => {
  const w = arm(on, { env: { FM_HOME: HOME + '/' }, snap: () => SNAP1 })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(2_000)
  expect(names(w.runs)).toContain('fm-fleet-snapshot.sh')
})

test('RESTART-STORE: a persisted set from an earlier session is honoured on the first snapshot', async ($, on) => {
  const w = arm(on, { snap: () => SNAP1, store: { 'alerted-keys': ['call:ww-nav'] } })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(2_000)
  console.log('PRESTORED_NOTIFIED', JSON.stringify(w.notified))
  expect(w.notified).toEqual(['decision: Choose the outline style'])
})

test('RESTART-STORE: both already known -> a restart is silent', async ($, on) => {
  const w = arm(on, { snap: () => SNAP1, store: { 'alerted-keys': ['call:ww-nav', 'call:ww-outline'] } })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(120_000)
  expect(w.notified).toEqual([])
})

test('ROUNDTRIP: after the real answer closed ww-nav, the next real snapshot leaves one call and no new alert', async ($, on) => {
  let snap: any = SNAP1
  const w = arm(on, { snap: () => snap })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await w.clock.advance(2_000)
  snap = SNAP2
  await w.clock.advance(60_000)
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await dump('band-after-roundtrip', band)
  expect((await band.find({ key: 'chip-calls' }))?.text).toContain('1 call for you')
  await band.press({ key: 'open-calls' })
  const calls = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'fleet-calls', props: pane('Calls for the captain') })
  await dump('calls-after-roundtrip', calls)
  expect(await calls.find({ type: 'Text', text: 'Decide the navigation order' })).toBeUndefined()
  expect(w.notified).toEqual([])
})
