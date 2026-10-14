import type { Stats } from '../types'

// One piece of text in one style; a row is the runs side by side.
type Run = { text: string; color?: string; bg?: string; dim?: boolean }
type Row = Run[]

const BLUE = 'blue'
const EMPTY_BG = '#3a3a3a' // xterm 237
const EIGHTHS = '▏▎▍▌▋▊▉'
const CTX_WIDTH = 22
const MIN_CTX_WIDTH = 5
export const HOUR_MS = 60 * 60_000
export const MIN5_MS = 5 * 60_000
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const level = (p: number, yellow = 60, red = 85) => (p >= red ? 'red' : p >= yellow ? 'yellow' : 'green')

// Full blocks, an eighth block on grey for the started cell, grey cells for the rest.
export function bar(percent: number, width: number, color: string): Run[] {
  const eighths = Math.floor((Math.min(Math.max(percent, 0) || 0, 100) * width * 8) / 100)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8 ? EIGHTHS[(eighths % 8) - 1] : ''
  const rest = width - full - (part ? 1 : 0)
  return [
    { text: '█'.repeat(full), color },
    { text: part, color, bg: EMPTY_BG },
    { text: ' '.repeat(rest), bg: EMPTY_BG },
  ]
}

// Remaining time as 2h54m.
export function left(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

// `date +'%u %H:%M'` output (1 = Monday) as "Thu 16:00".
export function weekday(dateOutput: string): string | null {
  const m = /^([1-7]) (\d\d:\d\d)/.exec(dateOutput.trim())
  return m ? `${WEEKDAYS[Number(m[1]) - 1]} ${m[2]}` : null
}

// "claude-opus-5-5[1m]" or "Claude Opus 5.5" as "Opus 5.5".
export function modelName(model: string): string {
  const [, name, major, minor] = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model) ?? []
  if (name) return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${major}.${minor}`
  return model.replace(/^Claude /, '')
}

// Terminal cells; the fire emoji is two wide.
export const width = (row: Row) => row.reduce((n, r) => n + [...r.text].length + (r.text.match(/🔥/gu)?.length ?? 0), 0)

function cache(s: Stats, now: number): Row {
  if (s.cacheAt === null) return []
  // Unknown TTL: Claude Code writes 1h caches on a subscription login (the one with limits), 5m on an API key.
  // Decided here, not when the cache was armed, since limits can arrive later (a resume).
  const ms = s.cacheAt + (s.cacheTtl ?? (s.limits.length > 0 ? HOUR_MS : MIN5_MS)) - now
  if (ms <= 0) return [{ text: ' | pc ' }, { text: '❄ cold', color: BLUE }]
  return [{ text: ' | pc ' }, { text: `🔥 ${Math.floor(ms / 60_000)}m`, color: ms < MIN5_MS ? 'yellow' : 'green' }]
}

function context(s: Stats, now: number, barWidth: number): Row {
  const pct = s.tokens === null || !(s.window > 0) ? 0 : Math.max(0, Math.floor((s.tokens * 100) / s.window))
  const color = level(pct, 75, 90)
  return [
    { text: modelName(s.model), color: BLUE },
    ...(s.effort ? [{ text: ` ${s.effort}`, color: BLUE, dim: true }] : []),
    { text: ' | ctx [' },
    ...bar(pct, barWidth, color),
    { text: '] ' },
    { text: `${pct}%`, color },
    ...cache(s, now),
  ]
}

// An unknown reset time shows no reset at all.
function limit(label: string, percent: number, reset: string | null): Row {
  const p = Math.floor(percent)
  const color = level(p)
  return [
    { text: `${label} [` },
    ...bar(p, 8, color),
    { text: '] ' },
    { text: `${p}%`, color },
    ...(reset === null ? [] : [{ text: ` ↻ ${reset}`, dim: true }]),
  ]
}

// Both rows; the context bar stretches so the first row is as wide as the second.
export function rows(s: Stats, now: number): Row[] {
  // The engine reports limits only with a response; one whose reset has passed is empty until the next.
  const find = (kind: string) => {
    const l = s.limits.find(l => l.kind === kind)
    return l && l.resetsAt !== null && l.resetsAt <= now ? { ...l, percent: 0, resetsAt: null, resetLabel: null } : l
  }
  const five = find('five_hour')
  const seven = find('seven_day')
  const parts = [
    ...(five ? [limit('5h', five.percent, five.resetsAt === null ? null : left(five.resetsAt - now))] : []),
    ...(seven ? [limit('7d', seven.percent, seven.resetLabel)] : []),
  ]
  // Limits come only with a subscription login; without them the first row stands alone.
  if (!parts.length) return [context(s, now, CTX_WIDTH)]
  const second = parts.flatMap((p, i) => (i ? [{ text: ' | ' }, ...p] : p))
  // The first row without its bar is the fixed part; the bar takes the rest.
  const w = Math.max(MIN_CTX_WIDTH, width(second) - width(context(s, now, 0)))
  return [context(s, now, w), second]
}
