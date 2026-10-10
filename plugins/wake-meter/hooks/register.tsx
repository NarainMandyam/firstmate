import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WakeTurn } from '../types'

const pendingWake = atom({ plugin: 'wake-meter', key: 'pendingWake' } as const, null)
const turn = atom({ plugin: 'wake-meter', key: 'turn' } as const, null)
const nudgeStep = atom({ plugin: 'wake-meter', key: 'nudgeStep' } as const, -1)

const NUDGE_STEP_TOKENS = 50_000
const WAKE_BANNER = 'firstmate watcher wake'
const DRAIN = /(^|[\s/])fm-wake-drain\.sh\b/

type Tally = { day: string; wakes: number; idle: number; lastCost: number | null }

// A rewake row as stored carries the banner; a row drawn as its summary alone reads "Stop hook feedback".
const isWakeText = (text: string): boolean =>
  text.includes(WAKE_BANNER) || text.trim() === 'Stop hook feedback'

// "signal fm-x" from the banner's first wake line, or "" when the text carries none.
const wakeLabel = (text: string): string => {
  const line = /^(signal|stale|check|heartbeat)\b:?\s*(\S*)/m.exec(text)
  if (line === null) return ''
  const target = (line[2] ?? '').split('/').pop()?.replace(/\.(status|turn-ended)$/, '') ?? ''
  return target === '' ? (line[1] ?? '') : `${line[1]} ${target}`
}

const compact = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(tokens / 1000)}k`

const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function readTally($: EngineInterface): Promise<Tally> {
  const day = dayOf(await $.clock.now())
  const saved = (await $.store.get('tally')) as Tally | undefined
  return saved?.day === day ? saved : { day, wakes: 0, idle: 0, lastCost: null }
}

// Active only in a firstmate home's own session: no worker task, and the root holds a home's bin/ and state/.
async function isActive($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('FM_TASK_ID')) !== undefined) return false
  const root = (await $.session.root()).replace(/\/$/, '')
  const script = await $.fs.stat(`${root}/bin/fm-session-start.sh`).catch(() => undefined)
  const state = await $.fs.stat(`${root}/state`).catch(() => undefined)
  return script?.kind === 'file' && state?.kind === 'dir'
}

// Pins the meter line; answers the context size so the caller can judge a restart nudge.
async function refreshStatus($: EngineInterface): Promise<number | undefined> {
  const usage = await $.session.usage()
  const tally = await readTally($)
  const fiveHour = usage.rateLimits.find(r => r.kind === 'five_hour')
  const parts = [
    usage.context.tokens === undefined ? undefined : `ctx ${compact(usage.context.tokens)}`,
    `wakes ${tally.wakes} (${tally.idle} idle)`,
    tally.lastCost === null ? undefined : `last ${compact(tally.lastCost)}`,
    fiveHour === undefined ? undefined : `5h ${Math.round(fiveHour.percentUsed)}% used`,
  ]
  $.ui.status(parts.filter(p => p !== undefined).join(' · '))
  return usage.context.tokens
}

export const register: Register = (on, options) => {
  const restartAt = Number(options.restartAtTokens ?? 250_000)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (await isActive($)) await refreshStatus($)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const isOwnTurn = e.origin.kind === 'task-notification' && e.turnId === undefined
    if (isOwnTurn && isWakeText(e.text) && (await isActive($))) {
      await update($, pendingWake, () => wakeLabel(e.text))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (await isActive($)) {
      const label = await read($, pendingWake)
      await update($, pendingWake, () => null)
      await update($, turn, () => (label === null ? null : { label, drains: 0, others: 0 }))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, turn)) !== null) {
      const isDrain = e.tool === 'Bash' && DRAIN.test(String(e.command))
      await update($, turn, t =>
        t === null ? t : isDrain ? { ...t, drains: t.drains + 1 } : { ...t, others: t.others + 1 },
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !(await isActive($))) return done

    const wake: WakeTurn | null = await read($, turn)
    await update($, turn, () => null)
    const isIdle = wake !== null && wake.others === 0
    if (wake !== null) {
      const u = e.usage
      const cost = u === undefined ? null
        : u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const tally = await readTally($)
      await $.store.set('tally', {
        ...tally,
        wakes: tally.wakes + 1,
        idle: tally.idle + (isIdle ? 1 : 0),
        lastCost: cost ?? tally.lastCost,
      } satisfies Tally)
    }

    const tokens = await refreshStatus($)
    if (tokens === undefined || tokens < restartAt) {
      await update($, nudgeStep, () => -1)
    } else if (isIdle) {
      const step = Math.floor((tokens - restartAt) / NUDGE_STEP_TOKENS)
      if (step > (await read($, nudgeStep))) {
        await update($, nudgeStep, () => step)
        $.ui.toast(
          `Firstmate is carrying ${compact(tokens)} tokens of context, and every notification re-reads all of it. Good point to /stow and restart.`,
          { timeoutMs: 10_000 },
        )
      }
    }
    return done
  })

  if (options.foldWakeRows === true) {
    on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
      if (e.props.isExpanded || !isWakeText(e.props.text) || !(await isActive($))) return next(e)
      const { Text } = $.ui.resolve(e)
      const label = wakeLabel(e.props.text)
      return <Text dimColor>⟳ firstmate notification{label === '' ? '' : ` · ${label}`}</Text>
    })
  }
}
