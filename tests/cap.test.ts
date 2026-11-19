import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CAP = '/Users/owner/.claude/usage_cap'

// Two logins on one machine: a work account the desktop app hands its sessions
// in the environment, and a personal login in the terminal, which no file names
// reliably: Claude Code's config file is shared, and names the work login,
// because the desktop app's sessions keep writing theirs into it.
const WORK = { organization: '11111111-aaaa-4aaa-8aaa-111111111111', person: '22222222-bbbb-4bbb-8bbb-222222222222' }
const WORK_CAP = `/Users/owner/.claude/usage_cap.d/${WORK.organization}_${WORK.person}`
const WORK_ENV = {
  CLAUDE_CODE_ORGANIZATION_UUID: WORK.organization,
  CLAUDE_CODE_ACCOUNT_UUID: WORK.person,
}
const CONFIG = '/Users/owner/.claude.json'
const DESKTOP_CONFIG = JSON.stringify({
  oauthAccount: { organizationUuid: WORK.organization, accountUuid: WORK.person },
})

// The weekly window of every test resets a minute after the clock starts.
const RESETS_AT = '1970-01-01T00:17:40.000Z'

// Where readings are kept in the mod's store: the machine-wide key, which a
// terminal session uses, and the keys 0.3.0 kept them under.
const KEPT = 'last-reading'
const OLD_KEPT = 'reading'
const OLD_WORK_KEPT = `reading:${WORK.organization}_${WORK.person}`

// The usage windows the account reports: the five-hour window, which the budget
// is never held against, and the weekly one, absent for a session with no
// reading yet.
const windows = (weekly: number | null) => [
  { kind: 'five_hour', percentUsed: 80 },
  ...(weekly === null ? [] : [{ kind: 'seven_day', percentUsed: weekly, resetsAt: RESETS_AT }]),
]

// The engine beneath the mod: a few files in memory, a store holding `kept`, no
// agents out, and the usage windows the account reports (`world.weekly` is the
// weekly figure, null for a session with no reading yet; `world.env` is the
// environment, HOME alone unless a test adds to it). `ran` lists the tool calls
// that got through.
const engine = (
  on: On,
  files: Record<string, string>,
  weekly: number | null = 17,
  hasBrokenEnv = false,
  kept: Record<string, unknown> = {},
) => {
  const world = {
    files: { ...files },
    writes: [] as string[],
    ran: [] as string[],
    weekly,
    env: { HOME: '/Users/owner' } as Record<string, string>,
    clock: mock.clock(on, { now: 1_000_000 }),
  }

  mock.store(on, kept)

  on('env.get', (_, e) => {
    if (hasBrokenEnv) {
      throw new Error('the environment cannot be read')
    }

    return { value: world.env[e.name] }
  })

  on('command.register', () => ({ value: { command: 'cap' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  on('agent.list', () => ({ value: [] }))
  on('session.model', () => ({ value: 'Fable 5.2' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {} as never,
      rateLimits: windows(world.weekly),
    },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('fs.read', (_, e) => {
    const text = world.files[e.path]

    if (text === undefined) {
      throw new Error(`no such file: ${e.path}`)
    }

    return { value: text }
  })
  on('fs.write', (_, e) => {
    world.files[e.path] = e.text
    world.writes.push(e.path)

    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    world.ran.push(e.tool)

    return { result: {} }
  })

  return world
}

// A response comes in with a new weekly figure, and the engine reports that the
// session's reading moved, as it does after a turn.
const respond = async ($: Engine, world: ReturnType<typeof engine>, weekly: number) => {
  world.weekly = weekly
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: windows(weekly),
    changed: ['rateLimits'],
  })
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const run = (args: string, kind: 'composer' | 'bridge' | 'peer') =>
  ({
    command: 'cap',
    args,
    origin: { kind },
    presentation: { isFullscreen: false, columns: 120 },
  }) as const

test('/cap alone shows the budget and the weekly usage', async ($, on) => {
  engine(on, { [CAP]: '25\n' })

  await $.session.start(START)
  const said = await $.command.run(run('', 'composer'))

  // 17 is the weekly figure; the five-hour 80 is not counted.
  expect(said.text).toBe('Usage budget: 25%. Weekly usage: 17%.')
})

test('typing /cap 95 at the prompt writes the budget file', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' })

  await $.session.start(START)
  const said = await $.command.run(run('95', 'composer'))

  expect(said.text).toBe('Usage budget set to 95%.')
  expect(world.files[CAP]).toBe('95\n')

  expect((await $.command.run(run('off', 'bridge'))).text).toBe('Usage budget is off.')
  expect(world.files[CAP]).toBe('off\n')
})

test('nothing but the person at the keyboard moves the budget', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' })

  await $.session.start(START)
  const said = await $.command.run(run('95', 'peer'))

  expect(said.text).toBe('Only the person at the keyboard sets the budget: type /cap yourself.')
  expect(world.files[CAP]).toBe('25\n')
  expect(world.writes).toHaveLength(0)
})

test('a value that is not a percent or "off" changes nothing', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' })

  await $.session.start(START)

  for (const typed of ['0', '101', 'abc', '9 5', '-5', '12.5']) {
    const said = await $.command.run(run(typed, 'composer'))

    expect(said.text).toStartWith('Not set:')
  }

  expect(world.files[CAP]).toBe('25\n')
  expect(world.writes).toHaveLength(0)
})

test('under the budget every tool call goes through', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 24.9)

  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash'])
})

test('at the budget every tool call is refused, and nothing runs', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 25)

  await $.session.start(START)

  const shell = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const read = await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.md' })
  const write = await $.tool.call({ tool: 'Write', file_path: '/tmp/notes.md', content: 'x' })
  const agent = await $.tool.call({ tool: 'Agent', description: 'Carry on', prompt: 'Carry on.' })

  expect(shell.deny).toStartWith('USAGE BUDGET REACHED: weekly usage is at 25% and the budget is 25%.')
  expect(shell.deny).toContain('In your reply, say where you stopped')
  expect(shell.deny).toContain('/cap')
  expect(read.deny).toStartWith('USAGE BUDGET REACHED')
  expect(write.deny).toStartWith('USAGE BUDGET REACHED')
  expect(agent.deny).toStartWith('USAGE BUDGET REACHED')
  expect(world.ran).toEqual([])
  expect((await $.command.run(run('', 'composer'))).text).toBe(
    'Usage budget: 25%. Weekly usage: 25%. Budget reached: tool calls are refused.',
  )
})

test('raising the budget or turning it off lets the work go on', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 60)

  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  // Still under usage: said so, and still refused.
  expect((await $.command.run(run('50', 'composer'))).text).toBe(
    'Usage budget set to 50%. Usage is already at 60%, so tool calls stay refused.',
  )
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  await $.command.run(run('75', 'composer'))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()

  await $.command.run(run('off', 'composer'))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash', 'Bash'])
})

test('with no budget nothing is refused', async ($, on) => {
  const world = engine(on, {}, 99)

  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash'])
  expect((await $.command.run(run('', 'composer'))).text).toBe('Usage budget: none. Weekly usage: 99%.')
})

test('a budget is not enforced while the account reports no weekly usage', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, null)

  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash'])
  expect((await $.command.run(run('', 'composer'))).text).toBe('Usage budget: 25%. Weekly usage: unknown.')
})

test('a new session is held to the last reading another session took', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, null)

  // A response comes in at 60%, and the reading is kept.
  await $.session.start(START)
  await respond($, world, 60)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  // A session that has no reading of its own yet.
  world.weekly = null
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith(
    'USAGE BUDGET REACHED: weekly usage is at 60% and the budget is 25%.',
  )
  expect((await $.command.run(run('', 'composer'))).text).toBe(
    'Usage budget: 25%. Weekly usage: 60%. Budget reached: tool calls are refused.',
  )
  expect(world.ran).toEqual([])
})

test('a kept reading is dropped once its window has reset', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, null)

  await $.session.start(START)
  await respond($, world, 60)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  world.weekly = null
  await world.clock.set(Date.parse(RESETS_AT))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash'])
})

test('a session with a reading of its own goes by it, not by a kept one', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 60)

  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  world.weekly = 10
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash'])
})

test('a budget set in the desktop app leaves the terminal one alone, and the other way round', async ($, on) => {
  const world = engine(on, { [CAP]: '75\n', [CONFIG]: DESKTOP_CONFIG })

  // The desktop app's session, signed in to the work account.
  world.env = { ...world.env, ...WORK_ENV }
  await $.session.start(START)
  expect((await $.command.run(run('57', 'composer'))).text).toBe('Usage budget set to 57% for this account.')
  expect(world.files[WORK_CAP]).toBe('57\n')
  expect(world.files[CAP]).toBe('75\n')
  expect((await $.command.run(run('', 'composer'))).text).toBe('Usage budget: 57%. Weekly usage: 17%.')

  // The terminal's session, signed in to the personal account: it goes by the
  // machine-wide budget, though the config file names the work login.
  world.env = { HOME: '/Users/owner' }
  await $.session.start(START)
  expect((await $.command.run(run('', 'composer'))).text).toBe('Usage budget: 75%. Weekly usage: 17%.')
  expect((await $.command.run(run('90', 'composer'))).text).toBe('Usage budget set to 90%.')
  expect(world.files[CAP]).toBe('90\n')
  expect(world.files[WORK_CAP]).toBe('57\n')
})

test('a terminal session is not taken for the login the config file names', async ($, on) => {
  // The desktop app's sessions leave the work login in the config file. The
  // terminal session is signed in to another account, at 48% of its week.
  const world = engine(on, { [CAP]: '75\n', [WORK_CAP]: '25\n', [CONFIG]: DESKTOP_CONFIG }, 48)

  // Held to the machine-wide 75, not the work account's 25.
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect((await $.command.run(run('', 'composer'))).text).toBe('Usage budget: 75%. Weekly usage: 48%.')

  // Its reading is not kept for the work account: a new desktop session with
  // no reading of its own yet has none to go by.
  await respond($, world, 49)
  world.env = { ...world.env, ...WORK_ENV }
  world.weekly = null
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash', 'Bash'])
})

test('each account is stopped at its own budget', async ($, on) => {
  const world = engine(on, { [CAP]: '75\n', [CONFIG]: DESKTOP_CONFIG, [WORK_CAP]: '57\n' }, 65)

  // Work: 65% used against its own 57.
  world.env = { ...world.env, ...WORK_ENV }
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith(
    'USAGE BUDGET REACHED: weekly usage is at 65% and the budget is 57%.',
  )

  // Personal: 65% used against the machine-wide 75, which the work budget did not move.
  world.env = { HOME: '/Users/owner' }
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash'])
})

test('an account that turns its budget off is not held to the machine-wide one', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 60)

  world.env = { ...world.env, ...WORK_ENV }
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  expect((await $.command.run(run('off', 'composer'))).text).toBe('Usage budget is off for this account.')
  expect(world.files[WORK_CAP]).toBe('off\n')
  expect(world.files[CAP]).toBe('25\n')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test('a usage reading kept for one account is not used for another', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n', [CONFIG]: DESKTOP_CONFIG }, null)

  // The work account's session takes a reading of 60%, and it is kept.
  world.env = { ...world.env, ...WORK_ENV }
  await $.session.start(START)
  await respond($, world, 60)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  // A new terminal session with no reading yet is not held to the work figure,
  // though the config file names the work login.
  world.env = { HOME: '/Users/owner' }
  world.weekly = null
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()

  // A new work session with no reading yet is.
  world.env = { ...world.env, ...WORK_ENV }
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith(
    'USAGE BUDGET REACHED: weekly usage is at 60% and the budget is 25%.',
  )
  expect(world.ran).toEqual(['Bash'])
})

test('an idle session leaves a newer reading another session kept alone', async ($, on) => {
  // Another session of the account kept 60% after its last response. This
  // session's own last response, long ago, said 13%, and it sits idle.
  const world = engine(on, { [CAP]: '25\n' }, 13, false, {
    [KEPT]: { percent: 60, resetsAt: Date.parse(RESETS_AT) },
  })

  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  // Six refreshes of the row.
  await world.clock.advance(30_000)

  // A new session with no reading of its own yet is held to the newer 60%.
  world.weekly = null
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith(
    'USAGE BUDGET REACHED: weekly usage is at 60% and the budget is 25%.',
  )
})

test('readings an earlier version kept are not read', async ($, on) => {
  // 0.3.0 took terminal sessions for the login the config file named, so a
  // reading it kept may be another account's.
  const stale = { percent: 76, resetsAt: Date.parse(RESETS_AT) }
  const world = engine(on, { [CAP]: '25\n' }, null, false, {
    [OLD_KEPT]: stale,
    [OLD_WORK_KEPT]: stale,
  })

  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()

  world.env = { ...world.env, ...WORK_ENV }
  await $.session.start(START)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash', 'Bash'])
})

test('an account id that is not one is not used as a file name', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' })

  world.env = { ...world.env, CLAUDE_CODE_ACCOUNT_UUID: '../../etc/passwd' }
  await $.session.start(START)
  expect((await $.command.run(run('40', 'composer'))).text).toBe('Usage budget set to 40%.')
  expect(world.writes).toEqual([CAP])
})

test('a tool cannot move the budget file, whatever the usage', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 1)

  await $.session.start(START)

  const refused = [
    await $.tool.call({ tool: 'Write', file_path: CAP, content: '100\n' }),
    await $.tool.call({ tool: 'Edit', file_path: CAP, old_string: '25', new_string: '100' }),
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: CAP, new_source: '100' }),
    // The same file, spelled another way.
    await $.tool.call({ tool: 'Write', file_path: '/Users/owner/.claude/ops-band/../usage_cap', content: '100\n' }),
    await $.tool.call({ tool: 'Write', file_path: '/Users/owner/.claude//usage_cap', content: '100\n' }),
    await $.tool.call({ tool: 'Write', file_path: '/Users/owner/.claude/./usage_cap', content: '100\n' }),
    await $.tool.call({ tool: 'Write', file_path: '/Users/owner/.Claude/USAGE_CAP', content: '100\n' }),
    await $.tool.call({ tool: 'Bash', command: 'echo 100 > ~/.claude/usage_cap' }),
    await $.tool.call({ tool: 'Bash', command: 'echo 100 > ~/.Claude/Usage_Cap' }),
    // An account's own budget file.
    await $.tool.call({ tool: 'Write', file_path: WORK_CAP, content: '100\n' }),
    await $.tool.call({ tool: 'Edit', file_path: WORK_CAP, old_string: '57', new_string: '100' }),
    await $.tool.call({ tool: 'Bash', command: `echo 100 > ${WORK_CAP}` }),
    await $.tool.call({
      tool: 'Monitor',
      description: 'watch',
      timeout_ms: 1000,
      command: 'echo 100 > ~/.claude/usage_cap',
    }),
  ]

  for (const call of refused) {
    expect(call.deny).toContain('set by the person with /cap')
  }

  expect(world.ran).toEqual([])
  expect(world.files[CAP]).toBe('25\n')
})

test('a file or a command that only looks like the budget file is left alone', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 1)

  await $.session.start(START)

  const allowed = [
    await $.tool.call({ tool: 'Write', file_path: '/Users/owner/project/usage_cap', content: 'x' }),
    await $.tool.call({ tool: 'Write', file_path: '/Users/owner/.claude/usage_cap.md', content: 'x' }),
    await $.tool.call({ tool: 'Bash', command: 'grep -rn usage_cap src/' }),
    await $.tool.call({ tool: 'Read', file_path: CAP }),
  ]

  for (const call of allowed) {
    expect(call.deny).toBeUndefined()
  }

  expect(world.ran).toEqual(['Write', 'Write', 'Bash', 'Read'])
})

test('a budget file edited by hand is read as it was meant', async ($, on) => {
  // A percent sign is dropped.
  const signed = engine(on, { [CAP]: '55%\n' }, 60)

  await $.session.start(START)
  expect((await $.command.run(run('', 'composer'))).text).toBe(
    'Usage budget: 55%. Weekly usage: 60%. Budget reached: tool calls are refused.',
  )
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith('USAGE BUDGET REACHED')

  // A decimal is enforced as written.
  signed.files[CAP] = '60.5\n'
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  signed.files[CAP] = '59.5\n'
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toStartWith(
    'USAGE BUDGET REACHED: weekly usage is at 60% and the budget is 59.5%.',
  )

  // Anything else is no budget, and /cap says so.
  signed.files[CAP] = 'lots\n'
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect((await $.command.run(run('', 'composer'))).text).toBe(
    'Usage budget: not valid ("lots"), so nothing is enforced; set it with /cap. Weekly usage: 60%.',
  )
})

test('a check that breaks lets the tool call through', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n' }, 99, true)

  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.deny).toBeUndefined()
  expect(world.ran).toEqual(['Bash'])
})

const BAND = {
  plugin: 'ops-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

// The row draws from each surface's own elements: the terminal, the desktop
// app and the mobile apps all raise the band.
for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
  test(`${surface}: the row shows workers, usage and the budget box, and the box sets the budget`, async ($, on) => {
    const world = engine(on, { [CAP]: '25\n' })
    const toasts: string[] = []

    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })

    await $.session.start({ ...START, surface })
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /workers/ }))?.text).toBe('workers: none out')
    expect((await ui.find({ type: 'Text', text: /usage/ }))?.text).toContain('usage 17%')
    expect((await ui.find({ type: 'Input', key: 'cap' }))?.props.value).toBe('25')
    expect((await ui.find({ type: 'Text', text: /Fable/ }))?.text).toBe('| Fable 5.2')

    await ui.input({ key: 'cap', text: '40' })
    expect(world.files[CAP]).toBe('40\n')
    expect(toasts).toEqual(['Usage budget set to 40%.'])

    await ui.input({ key: 'cap', text: 'lots' })
    expect(world.files[CAP]).toBe('40\n')
    await ui.unmount()
  })

  test(`${surface}: the row says so when the budget is reached`, async ($, on) => {
    engine(on, { [CAP]: '25\n' }, 31.4)

    await $.session.start({ ...START, surface })
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /usage/ }))?.text).toContain(
      'usage 31% BUDGET REACHED, tools refused',
    )
    await ui.unmount()
  })

  test(`${surface}: the row shows a question mark while there is no usage reading`, async ($, on) => {
    engine(on, { [CAP]: '25\n' }, null)

    await $.session.start({ ...START, surface })
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /usage/ }))?.text).toContain('usage ?')
    await ui.unmount()
  })
}
