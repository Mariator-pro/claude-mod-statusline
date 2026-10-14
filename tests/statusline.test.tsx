import { expect, test } from 'claude-code/testing'

import type { Stats } from '../types'
import { bar, left, modelName, rows, weekday, width } from '../hooks/format'

const text = (runs: { text: string }[]) => runs.map(r => r.text).join('')

const STATS: Stats = {
  model: 'claude-opus-5-5',
  effort: 'medium',
  tokens: 0,
  window: 200_000,
  limits: [
    { kind: 'five_hour', percent: 14.5, resetsAt: 10_440_000, resetLabel: null },
    { kind: 'seven_day', percent: 62, resetsAt: 0, resetLabel: 'Thu 16:00' },
  ],
  cacheAt: null,
  cacheTtl: null,
}

test('formats model, bars, times and weekdays', () => {
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelName('Claude Fable 5.1')).toBe('Fable 5.1')
  expect(text(bar(50, 8, 'green'))).toBe('████    ')
  expect(text(bar(6.25, 8, 'green'))).toBe('▌       ')
  expect(bar(27, 8, 'green')[1]).toEqual({ text: '▏', color: 'green', bg: '#3a3a3a' })
  expect(text(bar(120, 8, 'red'))).toBe('████████')
  expect(left(2 * 60 * 60_000 + 54 * 60_000 + 30_000)).toBe('2h54m')
  expect(left(-5)).toBe('0h00m')
  expect(weekday('4 16:00\n')).toBe('Thu 16:00')
  expect(weekday('garbage')).toBe(null)
})

test('two rows of equal width, as the screenshot', () => {
  const [first, second] = rows(STATS, 0)
  expect(text(first!)).toMatch(/^Opus 5\.5 medium \| ctx \[ +\] 0%$/)
  expect(text(second!)).toBe('5h [█       ] 14% ↻ 2h54m | 7d [████▉   ] 62% ↻ Thu 16:00')
  expect(width(first!)).toBe(width(second!))
})

test('cache countdown and one row without limits', () => {
  // No known TTL and no limits (API key): 5m.
  const warm = rows({ ...STATS, limits: [], cacheAt: 0 }, 1_000)
  expect(warm.length).toBe(1)
  expect(text(warm[0]!)).toMatch(/\| pc 🔥 4m$/)
  expect(warm[0]!.at(-1)?.color).toBe('yellow')
  // No known TTL with limits (subscription): 1h; a known TTL wins.
  expect(text(rows({ ...STATS, cacheAt: 0 }, 1_000)[0]!)).toMatch(/\| pc 🔥 59m$/)
  expect(text(rows({ ...STATS, cacheAt: 0, cacheTtl: 5 * 60_000 }, 1_000)[0]!)).toMatch(/\| pc 🔥 4m$/)
  expect(text(rows({ ...STATS, cacheAt: 0 }, 60 * 60_000)[0]!)).toMatch(/\| pc ❄ cold$/)
})

test('bad readings do not break the row', () => {
  expect(text(bar(-5, 8, 'green'))).toBe('        ')
  expect(text(bar(NaN, 8, 'green'))).toBe('        ')
  expect(text(rows({ ...STATS, tokens: 5, window: 0 }, 0)[0]!)).toMatch(/\] 0%$/)
})

test('second row with only one limit', () => {
  const [first, second] = rows({ ...STATS, limits: STATS.limits.slice(0, 1) }, 0)
  expect(text(second!)).toBe('5h [█       ] 14% ↻ 2h54m')
  expect(width(first!)).toBeGreaterThanOrEqual(width(second!))
})

test('draws both rows under the prompt and keeps the hint', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'PromptHint' }, (engine, e) => {
    const { Text } = engine.ui.resolve(e)
    return <Text dimColor>{e.props.hint}</Text>
  })
  await $.session.measure({
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 14 },
      { kind: 'seven_day', percentUsed: 62 },
    ],
    changed: ['context', 'rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-bars',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      viewport: { columns: 120, rows: 30 },
    })
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ key: 'row-1' })).toBeDefined()
    await ui.unmount()
  }
})

test('7d reset time falls through to PowerShell where `date` is missing', async ($, on) => {
  const tried: string[] = []
  on('process.run', (_, e) => {
    tried.push(e.argv.slice(0, 2).join(' '))
    if (e.argv[0] === 'date') return { deny: 'not found' } // Windows
    return { value: { exitCode: 0, stdout: '4 16:00\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'PromptHint' }, (engine, e) => {
    const { Text } = engine.ui.resolve(e)
    return <Text dimColor>{e.props.hint}</Text>
  })
  await $.session.measure({
    context: { tokens: 0, window: 200_000, percent: 0 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 14 },
      { kind: 'seven_day', percentUsed: 62, resetsAt: '2026-10-15T14:00:00Z' },
    ],
    changed: ['rateLimits'],
  })
  expect(tried).toEqual(['date -r', 'date -d', 'powershell -NoProfile'])
  const ui = await $.ui.mount({
    plugin: 'usage-bars',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '' },
    viewport: { columns: 120, rows: 30 },
  })
  expect(await ui.find({ type: 'Text', text: '↻ Thu 16:00' })).toBeDefined()
  await ui.unmount()
})
