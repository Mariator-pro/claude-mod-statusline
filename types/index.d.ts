export type Limit = { kind: string; percent: number; resetsAt: number | null; resetLabel: string | null }

export type Stats = {
  model: string
  effort: string | null
  tokens: number | null
  window: number
  limits: Limit[]
  // When the last main response re-armed the prompt cache (ms), and its TTL once a cache write showed it.
  cacheAt: number | null
  cacheTtl: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': { stats: Shaped<Stats>; now: number }
  }
}
