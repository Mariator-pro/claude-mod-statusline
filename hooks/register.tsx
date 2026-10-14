import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Limit, Stats } from '../types'
import { HOUR_MS, MIN5_MS, rows, weekday } from './format'

const stats = atom({ plugin: 'usage-bars', key: 'stats' } as const, {
  model: '?',
  effort: null,
  tokens: null,
  window: 200_000,
  limits: [],
  cacheAt: null,
  cacheTtl: null,
} as Stats, { shape: 'v2' }) // bump when Stats changes, so a reload drops the old value
const now = atom({ plugin: 'usage-bars', key: 'now' } as const, 0)

const TICK_MS = 60_000 // the line shows whole minutes

const set = ($: EngineInterface, patch: Partial<Stats>) => update($, stats, s => ({ ...s, ...patch }))

// The 7d reset as the host's local time, through `date` so the host's time zone applies.
// BSD/macOS takes `-r <epoch>`, GNU `-d @<epoch>`, Windows has PowerShell; all print "4 16:00" (1 = Monday).
// Failures are not cached, so the next measure retries.
const labels = new Map<string, string>()
async function resetLabel($: EngineInterface, iso: string): Promise<string | null> {
  if (labels.has(iso)) return labels.get(iso)!
  const secs = String(Math.floor(Date.parse(iso) / 1000))
  const ps = `$d = [DateTimeOffset]::FromUnixTimeSeconds(${secs}).LocalDateTime; `
    + `'{0} {1}' -f ((([int]$d.DayOfWeek) + 6) % 7 + 1), $d.ToString('HH:mm', [cultureinfo]::InvariantCulture)`
  for (const cmd of [
    ['date', '-r', secs, '+%u %H:%M'],
    ['date', '-d', `@${secs}`, '+%u %H:%M'],
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps],
  ]) {
    try {
      const { exitCode, stdout } = await $.process.run(cmd)
      const label = exitCode === 0 ? weekday(stdout) : null
      if (label) {
        labels.set(iso, label)
        return label
      }
    } catch {
      // Not on this host (or no host commands on this surface); try the next.
    }
  }
  return null
}

async function limits($: EngineInterface, raw: readonly SessionRateLimit[]): Promise<Limit[]> {
  return Promise.all(raw.map(async l => ({
    kind: l.kind,
    percent: l.percentUsed,
    resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : null,
    resetLabel: l.kind === 'seven_day' && l.resetsAt ? await resetLabel($, l.resetsAt) : null,
  })))
}

type Entry = {
  type?: string
  isSidechain?: boolean
  message?: { usage?: { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } } }
}

// The transcript's last lines: `tail` where the host has it, else the engine's read (files up to 4 MiB).
async function tail($: EngineInterface, path: string, lines: number): Promise<string[]> {
  try {
    const { exitCode, stdout } = await $.process.run(['tail', '-n', String(lines), path])
    if (exitCode === 0) return stdout.split('\n')
  } catch {
    // No `tail` on this host (Windows).
  }
  try {
    return (await $.fs.read(path)).split('\n').slice(-lines)
  } catch {
    return []
  }
}

// The engine reports the cache's TTL to a mod only on a model switch; the transcript's usage has it
// per response: the last main response that wrote to the cache, 1h unless it wrote 5m only.
// No write in view keeps the TTL already known.
async function ttlFromTranscript($: EngineInterface, path: string): Promise<void> {
  const writes = (await tail($, path, 300)).flatMap(line => {
    try {
      const e = JSON.parse(line) as Entry
      const c = e.type === 'assistant' && !e.isSidechain ? e.message?.usage?.cache_creation : undefined
      return c && (c.ephemeral_5m_input_tokens ?? 0) + (c.ephemeral_1h_input_tokens ?? 0) > 0 ? [c] : []
    } catch {
      return []
    }
  })
  const w = writes.at(-1)
  if (w) await set($, { cacheTtl: (w.ephemeral_1h_input_tokens ?? 0) > 0 ? HOUR_MS : MIN5_MS })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const [model, settings, usage, t] = await Promise.all([
      $.session.model(),
      $.settings.read(),
      $.session.usage(),
      $.clock.now(),
    ])
    const effort = (settings as { effortLevel?: string }).effortLevel ?? null
    await set($, {
      model,
      effort,
      tokens: usage.context.tokens ?? null,
      window: usage.context.window,
    })
    await update($, now, () => t)
    // The 7d label spawns `date`; start does not wait for it, and a measure that landed meanwhile wins.
    void limits($, usage.rateLimits).then(l => update($, stats, s => (s.limits.length ? s : { ...s, limits: l })))
    // `-p` and SDK runs draw nothing, so nothing to tick for.
    if (e.isInteractive) $.clock.every(TICK_MS, () => void $.clock.now().then(t => update($, now, () => t)))
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await set($, { cacheAt: null, cacheTtl: null, tokens: null })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await set($, {
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      limits: await limits($, e.rateLimits),
    })
    return next(e)
  })

  // Every main response re-arms the prompt cache; the effort is the one the request carried.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const at = await $.clock.now()
      await update($, stats, s => ({
        ...s,
        model: e.model,
        // A level; a numeric thinking budget is not one to show.
        effort: typeof e.effort === 'string' ? e.effort : null,
        cacheAt: at,
      }))
    }
    return result
  })

  // A resumed session's cache: when its last response landed, as the engine reports it, and the TTL it wrote.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.seconds_since_last_response !== undefined) {
      await set($, { cacheAt: (await $.clock.now()) - e.seconds_since_last_response * 1000 })
    }
    await ttlFromTranscript($, e.transcript_path)
    return result
  }).catch(($, e, next) => next(e))

  // The TTL the turn actually wrote; turn.step already re-armed the cache.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    await ttlFromTranscript($, e.transcript_path)
    return result
  }).catch(($, e, next) => next(e))

  // Under the prompt, above the engine's own hint line, which stays.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const [hint, s, t] = await Promise.all([next(e), read($, stats), read($, now)])
    const { Box, Text } = $.ui.resolve(e)
    // A render can come before session.start has seeded `now`; render has no `$.clock`.
    return (
      <Box flexDirection="column">
        {rows(s, t || Date.now()).map((row, r) => (
          <Box key={`row-${r}`} marginTop={1}>
            <Text wrap="truncate-end">
              {row.map((run, i) => (
                <Text key={i} color={run.color} backgroundColor={run.bg} dimColor={run.dim}>{run.text}</Text>
              ))}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>{hint}</Box>
      </Box>
    )
  })
}
