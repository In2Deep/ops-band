import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CAP = '/Users/owner/.claude/usage_cap'

// The weekly window of every test resets a minute after the clock starts.
const RESETS_AT = '1970-01-01T00:17:40.000Z'

// The engine beneath the mod: a few files in memory, an empty store, no agents
// out, and the usage windows the account reports (`world.weekly` is the weekly
// figure, null for a session with no reading yet). `ran` lists the tool calls
// that got through.
const engine = (
  on: On,
  files: Record<string, string>,
  weekly: number | null = 17,
  hasBrokenEnv = false,
) => {
  const world = {
    files: { ...files },
    writes: [] as string[],
    ran: [] as string[],
    weekly,
    clock: mock.clock(on, { now: 1_000_000 }),
  }

  mock.store(on)

  if (hasBrokenEnv) {
    on('env.get', () => {
      throw new Error('the environment cannot be read')
    })
  } else {
    mock.env(on, { HOME: '/Users/owner' })
  }

  on('command.register', () => ({ value: { command: 'cap' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  on('agent.list', () => ({ value: [] }))
  on('session.model', () => ({ value: 'Fable 5.2' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {} as never,
      // The five-hour window is never what the budget is held against.
      rateLimits: [
        { kind: 'five_hour', percentUsed: 80 },
        ...(world.weekly === null
          ? []
          : [{ kind: 'seven_day', percentUsed: world.weekly, resetsAt: RESETS_AT }]),
      ],
    },
  }))
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
  const world = engine(on, { [CAP]: '25\n' }, 60)

  await $.session.start(START)
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
  const world = engine(on, { [CAP]: '25\n' }, 60)

  await $.session.start(START)
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
