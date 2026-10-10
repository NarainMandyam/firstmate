export type DeckCall = {
  id: string
  title: string
  reason: string
  repo: string | null
  kind: string | null
}

export type DeckPr = {
  id: string
  url: string
  repo: string | null
  state: string
}

export type DeckWorker = {
  id: string
  repo: string | null
  kind: string | null
  state: string
  detail: string
  pr: string | null
  isGone: boolean
  needsCaptain: boolean
  observedAt: string | null
}

export type DeckCounts = {
  calls: number
  working: number
  prs: number
  gone: number
  blocked: number
}

export type Deck = {
  generatedAt: string
  fetchedAt: number
  calls: DeckCall[]
  prs: DeckPr[]
  workers: DeckWorker[]
  counts: DeckCounts
}

export type DeckVitals = {
  monitorAgeMs: number | null
  diskUsedPct: number | null
  diskFreeGb: number | null
}

export type DeckPeek = {
  id: string
  kind: 'peek' | 'state'
  text: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'fleet-deck': {
      deck: Deck | null
      vitals: DeckVitals
      isHidden: boolean
      peek: DeckPeek | null
      notice: string | null
    }
  }
}
