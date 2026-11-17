import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { Reading, Snapshot, Worker } from '../types'

// A usage budget for unattended runs. The person sets a percent of the weekly
// allowance (the box in the band, or /cap) and walks away. Once weekly usage
// reaches it, every tool call is refused and Claude is told to say where it
// stopped and end its turn; no tool runs again until the person raises the
// budget or turns it off. The band above the prompt shows the agents out
// working, usage against the budget, the box that sets it, and the model. It
// draws wherever the band is raised: the terminal, the desktop app, mobile.
//
// A budget belongs to the account that set it: two accounts on one machine (a
// personal login in the terminal, a work login in the desktop app) each have
// their own number and their own usage.

const snapshot = atom({ plugin: 'ops-band', key: 'snapshot' } as const, null)

const LIVE = new Set(['pending', 'running', 'waiting'])
const REFRESH_MS = 5000
const JOB_STALE_MS = 45 * 60 * 1000
const ACCOUNT_MS = 60 * 1000
const CAP_FILE = 'usage_cap'
const CAP_DIR = 'usage_cap.d'
const READING = 'reading'
const ID = /^[0-9a-f-]{8,64}$/i

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

// The account the session is signed in to, as a name fit for a file path, or
// null when the mod cannot tell. A host that hands the session its login (the
// desktop app) names the account in the environment; a terminal session's is
// in the login Claude Code keeps in its own config file.
const readAccount = async ($: EngineInterface): Promise<string | null> => {
  try {
    let organization = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
    let person = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')

    if (!organization && !person) {
      const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (await $.env.get('HOME'))
      const text = dir ? await readText($, `${dir}/.claude.json`) : null
      const login =
        text === null
          ? undefined
          : (JSON.parse(text) as { oauthAccount?: Record<string, unknown> }).oauthAccount

      organization = String(login?.organizationUuid ?? '')
      person = String(login?.accountUuid ?? '')
    }

    const ids = [organization, person].filter(
      (id): id is string => typeof id === 'string' && ID.test(id),
    )

    return ids.length > 0 ? ids.join('_').toLowerCase() : null
  } catch {
    return null
  }
}

// The session's account: read at the session's start and once a minute after
// (a /login changes it), so no tool call waits on the config file.
let account: string | null | undefined

const who = async ($: EngineInterface): Promise<string | null> => {
  if (account === undefined) {
    account = await readAccount($)
  }

  return account
}

// Where the session's budget is written: the account's own file, or the
// machine-wide one when the account cannot be told.
const capName = async ($: EngineInterface): Promise<string> => {
  const id = await who($)

  return id === null ? CAP_FILE : `${CAP_DIR}/${id}`
}

// Where the session's last usage reading is kept in the mod's store.
const readingKey = async ($: EngineInterface): Promise<string> => {
  const id = await who($)

  return id === null ? READING : `${READING}:${id}`
}

// The budget the session is held to, as its file holds it: a percent, "off",
// or "" when there is none. An account that has set none of its own is held to
// the machine-wide file, where versions before 0.3 kept the one budget.
const readBudget = async ($: EngineInterface): Promise<{ cap: string; isOwn: boolean }> => {
  const tidy = (text: string): string => text.trim().replace(/%$/, '')
  const id = await who($)
  const own = id === null ? null : await readClaude($, `${CAP_DIR}/${id}`)

  if (own !== null) {
    return { cap: tidy(own), isOwn: true }
  }

  const shared = await readClaude($, CAP_FILE)

  return { cap: shared === null ? '' : tidy(shared), isOwn: id === null }
}

const readCap = async ($: EngineInterface): Promise<string> => (await readBudget($)).cap

// The budget as a number, or null when there is none to enforce. /cap and the
// box write whole percents; a file edited by hand may hold a decimal.
const capPercent = (cap: string): number | null => {
  const value = Number(cap)

  return /^\d{1,3}(\.\d+)?$/.test(cap) && value >= 1 && value <= 100 ? value : null
}

// The budget in words, for /cap.
const describeCap = (cap: string): string => {
  if (cap === '') {
    return 'none'
  }

  if (cap === 'off') {
    return 'off'
  }

  return capPercent(cap) === null
    ? `not valid ("${cap}"), so nothing is enforced; set it with /cap`
    : `${cap}%`
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

// What this session's last response reported: the fullest window of the
// account, the five-hour window left out (it resets on its own within the day),
// and when that window resets. Null before the session's first reading, or off
// a subscription.
const readLive = async (
  $: EngineInterface,
): Promise<{ percent: number; resetsAt: number | null } | null> => {
  try {
    const usage = await $.session.usage()
    const windows = usage.rateLimits.filter(limit => limit.kind !== 'five_hour')

    if (windows.length === 0) {
      return null
    }

    const fullest = windows.reduce((most, limit) =>
      limit.percentUsed > most.percentUsed ? limit : most,
    )
    const resetsAt = Date.parse(fullest.resetsAt ?? '')

    return { percent: fullest.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }
  } catch {
    return null
  }
}

// The last reading any session of this account took on this machine, kept in
// the mod's store until its window resets. Usage only grows within a window,
// so the real figure is at least this.
const recall = async ($: EngineInterface, now: number): Promise<Reading | null> => {
  const kept = await $.store.get(await readingKey($))

  if (kept === null || typeof kept !== 'object') {
    return null
  }

  const { percent, resetsAt } = kept as Partial<Reading>

  return typeof percent === 'number' && typeof resetsAt === 'number' && now < resetsAt
    ? { percent, resetsAt }
    : null
}

// Usage the budget is held against. A session has no reading of its own until
// its first response is in, and its first tool calls come before that: until
// then it is held to the last reading another session of the account kept.
// Null when there is neither.
const readUsed = async ($: EngineInterface): Promise<number | null> => {
  const live = await readLive($)

  try {
    const kept = await recall($, await $.clock.now())

    if (live === null) {
      return kept?.percent ?? null
    }

    if (
      live.resetsAt !== null &&
      (kept?.percent !== live.percent || kept.resetsAt !== live.resetsAt)
    ) {
      await $.store.set(await readingKey($), {
        percent: live.percent,
        resetsAt: live.resetsAt,
      })
    }
  } catch {
    // The store could not be read or written: the session's own reading stands.
  }

  return live?.percent ?? null
}

// The main loop's model as /model shows it, or null when it cannot be read.
const readModel = async ($: EngineInterface): Promise<string | null> => {
  try {
    return (await $.session.model()) || null
  } catch {
    return null
  }
}

const isOver = (used: number | null, cap: string): boolean => {
  const percent = capPercent(cap)

  return used !== null && percent !== null && used >= percent
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
    model: await readModel($),
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

// What the budget box does with what was typed into it.
const submitCap = async ($: EngineInterface, typed: string): Promise<void> => {
  try {
    $.ui.toast(await setCap($, typed))
  } catch {
    $.ui.toast('The budget file could not be written.')
  }
}

const setCap = async ($: EngineInterface, typed: string): Promise<string> => {
  const value = typed.trim().toLowerCase().replace(/%$/, '')
  const isPercent = /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100

  if (!isPercent && value !== 'off') {
    return `Not set: "${typed.trim()}" is not a percent from 1 to 100, or "off".`
  }

  const path = await inClaude($, await capName($))

  if (path === null) {
    return 'Not set: HOME is not set, so there is no budget file to write.'
  }

  const cap = value === 'off' ? value : String(Number(value))

  await $.fs.write(path, `${cap}\n`)
  // The write is done: a refresh that fails must not report it as failed.
  await refreshQuietly($)

  // Said only where the budget is one account's and not the machine's.
  const whose = (await who($)) === null ? '' : ' for this account'

  if (cap === 'off') {
    return `Usage budget is off${whose}.`
  }

  const used = await readUsed($)

  return isOver(used, cap)
    ? `Usage budget set to ${cap}%${whose}. Usage is already at ${Math.floor(used ?? 0)}%, so tool calls stay refused.`
    : `Usage budget set to ${cap}%${whose}.`
}

// The file a file-writing tool names as its target.
const targetOf = (e: ToolCallInput): string | null => {
  if (e.tool === 'Write' || e.tool === 'Edit') {
    return e.file_path
  }

  return e.tool === 'NotebookEdit' ? e.notebook_path : null
}

// The shell command a tool would run.
const commandOf = (e: ToolCallInput): string | null => {
  if (e.tool === 'Bash') {
    return e.command
  }

  return e.tool === 'Monitor' ? (e.command ?? null) : null
}

// Whether a tool call is aimed at a budget file: a file tool whose path ends at
// .claude/usage_cap or passes through .claude/usage_cap.d, however it is
// spelled (capitals, "..", doubled slashes), or a shell command that names
// either (the one name begins the other).
const isAimedAtCap = (e: ToolCallInput): boolean => {
  const parts = (targetOf(e) ?? '')
    .toLowerCase()
    .split(/[\\/]+/)
    .filter(part => part !== '' && part !== '.')

  if (
    parts.includes('.claude') &&
    (parts[parts.length - 1] === CAP_FILE || parts.includes(CAP_DIR))
  ) {
    return true
  }

  return (commandOf(e) ?? '').toLowerCase().includes(`.claude/${CAP_FILE}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cap',
      description: 'Show the usage budget, or set it: /cap 55, /cap off',
      argumentHint: '[percent | off]',
    })
    account = await readAccount($)
    await refreshQuietly($)
    $.clock.every(REFRESH_MS, () => {
      void refreshQuietly($)
    })
    $.clock.every(ACCOUNT_MS, () => {
      void readAccount($).then(id => {
        account = id
      })
    })

    return next(e)
  })

  on('command.run', { command: 'cap' }, async ($, e) => {
    const typed = e.args.trim()

    if (typed === '') {
      const { cap, isOwn } = await readBudget($)
      const used = await readUsed($)
      const usage = used === null ? 'unknown' : `${Math.floor(used)}%`
      const state = isOver(used, cap) ? ' Budget reached: tool calls are refused.' : ''
      const source =
        isOwn || cap === ''
          ? ''
          : ' This account has set no budget of its own, so the machine-wide one applies.'

      return {
        text: `Usage budget: ${describeCap(cap)}. Weekly usage: ${usage}.${state}${source}`,
      }
    }

    // Only the person's own Enter moves the budget: at the terminal, or from
    // their phone through Remote Control. Never a notification, a peer or a plugin.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return { text: 'Only the person at the keyboard sets the budget: type /cap yourself.' }
    }

    return { text: await setCap($, typed) }
  })

  // The babysitter. Every tool call of the session and its subagents passes here.
  on('tool.call', async ($, e, next) => {
    // The budget is the person's to move: a tool call aimed at the budget file
    // is refused whatever the usage is.
    if (isAimedAtCap(e)) {
      return { deny: 'ops-band: the usage budget file is set by the person with /cap, not by a tool.' }
    }

    const cap = await readCap($)
    const used = await readUsed($)

    if (!isOver(used, cap)) {
      return next(e)
    }

    return {
      deny:
        `USAGE BUDGET REACHED: weekly usage is at ${Math.floor(used ?? 0)}% and the budget is ${cap}%. ` +
        'Stop all work now. Do not retry this or any other tool: every tool call is refused until the person raises the budget. ' +
        'In your reply, say where you stopped and what is left to do, then end your turn. ' +
        'Only the person can lift the budget, by typing /cap.',
    }
  }).catch(($, e, next) =>
    // A check that breaks must not hold an unattended run hostage: the call goes
    // through (or, where it already ran, its own result stands).
    next(e),
  )

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
    const hasReachedBudget = isOver(now.used, now.cap)

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold={now.workers.length > 0} dimColor={now.workers.length === 0}>
          {workers}
        </Text>
        {now.job !== null && <Text bold>| {now.job}</Text>}
        <Text bold={hasReachedBudget} dimColor={!hasReachedBudget}>
          | usage {now.used === null ? '?' : `${Math.floor(now.used)}%`}
          {hasReachedBudget ? ' BUDGET REACHED, tools refused' : ''}
        </Text>
        <Input
          key="cap"
          label="| budget %"
          placeholder="none"
          value={now.cap}
          submitLabel="set budget"
          onSubmit={value => {
            void submitCap($, value)
          }}
        />
        {now.model ? <Text dimColor>| {now.model}</Text> : null}
      </Box>
    )
  })
}
