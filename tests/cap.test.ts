import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CAP = '/Users/owner/.claude/usage_cap'
const RATES = '/Users/owner/.claude/usage_rate_limits.json'

// The engine beneath the mod: a few files in memory, no agents out.
const engine = (on: On, files: Record<string, string>) => {
  const world = { files: { ...files }, writes: [] as string[] }

  mock.env(on, { HOME: '/Users/owner' })
  mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'cap' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {} as never,
      rateLimits: [{ kind: 'seven_day', percentUsed: 99 }],
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

const RATE_FILE = JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 80 },
    seven_day: { used_percentage: 17 },
  },
})

test('/cap alone shows the cap and the weekly usage figure', async ($, on) => {
  engine(on, { [CAP]: '25\n', [RATES]: RATE_FILE })

  await $.session.start(START)
  const said = await $.command.run(run('', 'composer'))

  // 17 is the weekly figure in the file; the five-hour 80 is not counted.
  expect(said.text).toBe('Usage cap: 25%. Weekly usage: 17%.')
})

test('typing /cap 95 at the prompt writes the cap file', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n', [RATES]: RATE_FILE })

  await $.session.start(START)
  const said = await $.command.run(run('95', 'composer'))

  expect(said.text).toBe('Usage cap set to 95%.')
  expect(world.files[CAP]).toBe('95\n')

  expect((await $.command.run(run('off', 'bridge'))).text).toBe('Usage cap is off.')
  expect(world.files[CAP]).toBe('off\n')
})

test('nothing but the person at the keyboard moves the cap', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n', [RATES]: RATE_FILE })

  await $.session.start(START)
  const said = await $.command.run(run('95', 'peer'))

  expect(said.text).toBe('Only the person at the keyboard sets the cap: type /cap yourself.')
  expect(world.files[CAP]).toBe('25\n')
  expect(world.writes).toHaveLength(0)
})

test('a value that is not a percent or "off" changes nothing', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n', [RATES]: RATE_FILE })

  await $.session.start(START)

  for (const typed of ['0', '101', 'abc', '9 5', '-5', '12.5']) {
    const said = await $.command.run(run(typed, 'composer'))

    expect(said.text).toStartWith('Not set:')
  }

  expect(world.files[CAP]).toBe('25\n')
  expect(world.writes).toHaveLength(0)
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

test('the row shows workers, usage and the cap box, and the box sets the cap', async ($, on) => {
  const world = engine(on, { [CAP]: '25\n', [RATES]: RATE_FILE })
  const toasts: string[] = []

  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /workers/ }))?.text).toBe('workers: none out')
  expect((await ui.find({ type: 'Text', text: /usage/ }))?.text).toContain('usage 17%')
  expect((await ui.find({ type: 'Input', key: 'cap' }))?.props.value).toBe('25')

  await ui.input({ key: 'cap', text: '40' })
  expect(world.files[CAP]).toBe('40\n')
  expect(toasts).toEqual(['Usage cap set to 40%.'])

  await ui.input({ key: 'cap', text: 'lots' })
  expect(world.files[CAP]).toBe('40\n')
  await ui.unmount()
})
