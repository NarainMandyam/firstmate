export type NmStep = {
  step: string
  status: string
  findings: number
  durationMs: number
}

export type NmFinding = {
  id: string
  severity: string
  file: string
  action: string
  description: string
}

/** One task's newest no-mistakes run, as the monitor draws it. */
export type NmRow = {
  task: string
  repo: string | null
  branch: string
  runId: string | null
  /** `active` while the run is in flight, `finished` once it ended, `none` before its first run. */
  phase: 'active' | 'finished' | 'none'
  /** The run's own word: `running`, or its outcome (`passed`, `failed`, `cancelled`, `completed`). */
  status: string
  step: string | null
  /** Epoch ms the current step started, as near as the run reports it. */
  stepSince: number | null
  findings: NmFinding[]
  isWaiting: boolean
  pr: string | null
  error: string | null
  steps: NmStep[]
}

export type NmBoard = {
  fetchedAt: number
  rows: NmRow[]
  /** Copies whose runs could not be read this pass, with why. */
  faults: string[]
}

export type NmLog = {
  task: string
  step: string
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'nm-monitor': {
      board: NmBoard | null
      expanded: string | null
      log: NmLog | null
      notice: string | null
    }
  }
}
