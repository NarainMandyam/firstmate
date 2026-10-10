export type WakeTurn = { label: string; drains: number; others: number }

declare module 'claude-code' {
  interface PluginState {
    'wake-meter': {
      pendingWake: string | null
      turn: WakeTurn | null
      nudgeStep: number
    }
  }
}
