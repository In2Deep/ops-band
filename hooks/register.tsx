import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot, Worker } from '../types'

// One row above the prompt: which agents are out working, an optional one-line
// job status, weekly usage, and a box for the usage cap. The cap file is written
// only from what the person at the keyboard types (the box, or /cap).

const snapshot = atom({ plugin: 'ops-band', key: 'snapshot' } as const, null)

const LIVE = new Set(['pending', 'running', 'waiting'])
const REFRESH_MS = 5000
const JOB_STALE_MS = 45 * 60 * 1000

const minutes = (ms: number): string => {
  const whole = Math.max(0, Math.round(ms / 60000))

  return whole < 1 ? 'under 1m' : `${whole}m`
}

const readText = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

// A file under ~/.claude, or null when HOME is not set.
const inClaude = async ($: EngineInterface, name: string): Promise<string | null> => {
  const home = await $.env.get('HOME')

  return home ? `${home}/.claude/${name}` : null
}

const readClaude = async ($: EngineInterface, name: string): Promise<string | null> => {
  const path = await inClaude($, name)

  return path === null ? null : readText($, path)
}

// The cap as the file holds it: a whole percent, "off", or "" when there is none.
const readCap = async ($: EngineInterface): Promise<string> => {
  const text = await readClaude($, 'usage_cap')

  return text === null ? '' : text.trim()
}

// Optional: "<name> <stage> <epoch seconds>" in ~/.claude/ops-band/job.status,
// written by any script of yours while it runs and removed when it ends.
const readJob = async ($: EngineInterface, now: number): Promise<string | null> => {
  const text = await readClaude($, 'ops-band/job.status')

  if (text === null) {
    return null
  }

  const [name, stage, started] = text.trim().split(/\s+/)
  const since = Number(started) * 1000

  if (!name || !stage || !Number.isFinite(since) || now - since > JOB_STALE_MS) {
    return null
  }

  return `${name}: ${stage}, ${minutes(now - since)}`
}

// Weekly usage: the highest used_percentage of any window but five_hour, from
// ~/.claude/usage_rate_limits.json when a status line script writes one (see the
// README), so the band and an enforcing hook read the same figure. Without that
// file, this session's own figure.
const readUsed = async ($: EngineInterface): Promise<number | null> => {
  const text = await readClaude($, 'usage_rate_limits.json')

  if (text !== null) {
    try {
      const limits: unknown = (JSON.parse(text) as { rate_limits?: unknown }).rate_limits
      const figures = Object.entries(
        limits !== null && typeof limits === 'object' ? limits : {},
      )
        .filter(([window]) => window !== 'five_hour')
        .map(([, value]) =>
          value !== null && typeof value === 'object'
            ? (value as { used_percentage?: unknown }).used_percentage
            : null,
        )
        .filter((figure): figure is number => typeof figure === 'number')

      if (figures.length > 0) {
        return Math.round(Math.max(...figures))
      }
    } catch {
      // Not JSON: fall through to the session's own figure.
    }
  }

  try {
    const usage = await $.session.usage()
    const figures = usage.rateLimits
      .filter(limit => limit.kind !== 'five_hour')
      .map(limit => limit.percentUsed)

    return figures.length > 0 ? Math.round(Math.max(...figures)) : null
  } catch {
    return null
  }
}

// First time each live agent was seen, for "how long has it been out".
const seen = new Map<string, number>()

const refresh = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  let workers: Worker[] = []

  try {
    const agents = await $.agent.list()
    const live = agents.filter(agent => LIVE.has(agent.status))

    for (const id of [...seen.keys()]) {
      if (!live.some(agent => agent.id === id)) {
        seen.delete(id)
      }
    }

    workers = live.map(agent => {
      if (!seen.has(agent.id)) {
        seen.set(agent.id, now)
      }

      return {
        id: agent.id,
        type: agent.type,
        description: agent.description,
        since: seen.get(agent.id) ?? now,
      }
    })
  } catch {
    workers = []
  }

  const next: Snapshot = {
    workers,
    job: await readJob($, now),
    used: await readUsed($),
    cap: await readCap($),
    at: now,
  }

  await update($, snapshot, () => next)
}

// The timer's pass and the pass at start: a refresh that fails (the session is
// closing, the mod is reloading) is dropped, the next one tries again.
const refreshQuietly = async ($: EngineInterface): Promise<void> => {
  try {
    await refresh($)
  } catch {
    // Dropped.
  }
}

// What the cap box does with what was typed into it.
const submitCap = async ($: EngineInterface, typed: string): Promise<void> => {
  try {
    $.ui.toast(await setCap($, typed))
  } catch {
    $.ui.toast('The cap file could not be written.')
  }
}

const setCap = async ($: EngineInterface, typed: string): Promise<string> => {
  const value = typed.trim().toLowerCase().replace(/%$/, '')
  const isPercent = /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100

  if (!isPercent && value !== 'off') {
    return `Not set: "${typed.trim()}" is not a percent from 1 to 100, or "off".`
  }

  const path = await inClaude($, 'usage_cap')

  if (path === null) {
    return 'Not set: HOME is not set, so there is no cap file to write.'
  }

  const cap = value === 'off' ? value : String(Number(value))

  await $.fs.write(path, `${cap}\n`)
  // The write is done: a refresh that fails must not report it as failed.
  await refreshQuietly($)

  return cap === 'off' ? 'Usage cap is off.' : `Usage cap set to ${cap}%.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cap',
      description: 'Show the weekly usage cap, or set it: /cap 95, /cap off',
      argumentHint: '[percent | off]',
    })
    await refreshQuietly($)
    $.clock.every(REFRESH_MS, () => {
      void refreshQuietly($)
    })

    return next(e)
  })

  on('command.run', { command: 'cap' }, async ($, e) => {
    const typed = e.args.trim()

    if (typed === '') {
      const cap = await readCap($)
      const used = await readUsed($)

      return {
        text: `Usage cap: ${cap === '' ? 'none' : cap === 'off' ? 'off' : `${cap}%`}. Weekly usage: ${used === null ? 'unknown' : `${used}%`}.`,
      }
    }

    // Only the person's own Enter moves the cap: at the terminal, or from their
    // phone through Remote Control. Never a notification, a peer or a plugin.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return { text: 'Only the person at the keyboard sets the cap: type /cap yourself.' }
    }

    return { text: await setCap($, typed) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, snapshot)

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    const { Box, Input, Text } = $.ui.resolve(e)
    const longest = now.workers.reduce(
      (oldest, worker) => Math.min(oldest, worker.since),
      now.at,
    )
    const names = now.workers
      .slice(0, 2)
      .map(worker => worker.description || worker.type)
      .join(', ')
    const more = now.workers.length > 2 ? `, +${now.workers.length - 2}` : ''
    const workers =
      now.workers.length === 0
        ? 'workers: none out'
        : `workers: ${now.workers.length} out, longest ${minutes(now.at - longest)} (${names}${more})`

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold={now.workers.length > 0} dimColor={now.workers.length === 0}>
          {workers}
        </Text>
        {now.job !== null && <Text bold>| {now.job}</Text>}
        <Text dimColor>
          | usage {now.used === null ? '?' : `${now.used}%`}
        </Text>
        <Input
          key="cap"
          label="| cap %"
          placeholder="none"
          value={now.cap}
          submitLabel="set cap"
          onSubmit={value => {
            void submitCap($, value)
          }}
        />
      </Box>
    )
  })
}
