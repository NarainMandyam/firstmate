import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const HOME = '/fleet/home'
const WAKE =
  '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n' +
  'Stop hook blocking error from command "Stop": firstmate watcher wake - one supervision event needs a handling turn now.\n' +
  'signal: /fleet/home/state/fm-x.status /fleet/home/state/fm-x.turn-ended\n' +
  'Run bin/fm-wake-drain.sh first, handle the wake.'

type World = { statuses: (string | undefined)[]; toasts: string[]; usage: SessionUsage }

// Stands for the engine beneath the plugin: a firstmate home on disk unless `root` says otherwise.
function world(on: On, env: Record<string, string> = {}, root = HOME): World {
  const w: World = {
    statuses: [],
    toasts: [],
    usage: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 41.2 }] },
  }
  mock.env(on, env)
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 10, 12) })
  on('session.root', () => ({ value: root }))
  on('fs.stat', ($, e) => {
    const kind = ({ [`${HOME}/bin/fm-session-start.sh`]: 'file', [`${HOME}/state`]: 'dir' } as const)[e.path]
    if (kind === undefined) throw new Error('ENOENT')
    return { value: { kind, size: 0, mtimeMs: 0, isLink: false } }
  })
  on('session.usage', () => ({ value: w.usage }))
  on('ui.status', ($, e) => { w.statuses.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: '', usage: e.usage }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  return w
}

// One notification turn: the rewake row, the drain, optionally another tool, then the turn's end at `tokens` of context.
async function wakeTurn($: Engine, w: World, tokens: number, isIdle = true) {
  w.usage = { ...w.usage, context: { ...w.usage.context, tokens } }
  await $.prompt.submit({ text: WAKE, wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: WAKE, turnId: 't' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'bin/fm-wake-drain.sh' } as never)
  if (!isIdle) await $.tool.call({ tool: 'Read', tool_use_id: 'b', file_path: '/x' } as never)
  await $.turn.complete({
    answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
    usage: { model: 'm', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 98_500 },
  })
}

describe('wake meter', () => {
  test('counts notifications, shows cost and allowance used, and nudges a restart once per 50k step', async ($, on) => {
    const w = world(on)
    await wakeTurn($, w, 180_000, false)
    expect(w.statuses.at(-1)).toBe('ctx 180k · wakes 1 (0 idle) · last 1.1M · 5h 41% used')
    expect(w.toasts).toHaveLength(0)

    await wakeTurn($, w, 262_000)
    expect(w.statuses.at(-1)).toBe('ctx 262k · wakes 2 (1 idle) · last 1.1M · 5h 41% used')
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('/stow and restart')

    await wakeTurn($, w, 290_000)
    expect(w.toasts).toHaveLength(1)
    await wakeTurn($, w, 305_000, false)
    expect(w.toasts).toHaveLength(1)
    await wakeTurn($, w, 306_000)
    expect(w.toasts).toHaveLength(2)
  })

  test('a captain prompt is not counted as a notification', async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ text: 'status?', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'status?', turnId: 'c' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c', reason: 'answer' })
    expect(w.statuses.at(-1)).toBe('wakes 0 (0 idle) · 5h 41% used')
  })

  test('stays inert in a worker session', async ($, on) => {
    const w = world(on, { FM_TASK_ID: 'fm-x' })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    await wakeTurn($, w, 400_000)
    expect(w.statuses).toHaveLength(0)
    expect(w.toasts).toHaveLength(0)
  })

  test('stays inert when the session root is not a firstmate home', async ($, on) => {
    const w = world(on, {}, '/elsewhere')
    await wakeTurn($, w, 400_000)
    expect(w.statuses).toHaveLength(0)
  })
})

const ROW = {
  component: 'UserMessage',
  props: { text: WAKE, origin: { kind: 'task-notification' }, isExpanded: false },
} as const

// The engine's own drawing of the row, so a pass-through is visible.
function engineRow(on: On) {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
}

describe('notification rows', () => {
  test('are left to the engine unless folding is turned on', async ($, on) => {
    world(on)
    engineRow(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'wake-meter', surface, ...ROW })
      expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('fold to one dim line when turned on, and ctrl+o still shows the whole row', { options: { foldWakeRows: true } }, async ($, on) => {
    world(on)
    engineRow(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const folded = await $.ui.mount({ plugin: 'wake-meter', surface, ...ROW })
      expect(await folded.find({ type: 'Text', text: /firstmate notification · signal fm-x/ })).toBeDefined()
      await folded.unmount()
      const expanded = await $.ui.mount({
        plugin: 'wake-meter', surface, ...ROW, props: { ...ROW.props, isExpanded: true },
      })
      expect(await expanded.find({ type: 'Text', text: /engine row/ })).toBeDefined()
      await expanded.unmount()
    }
  })
})
