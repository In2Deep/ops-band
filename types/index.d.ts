export type Worker = {
  id: string
  type: string
  description: string
  since: number
}

// A usage reading kept between sessions: the percent used, and when its window
// resets (epoch milliseconds).
export type Reading = {
  percent: number
  resetsAt: number
}

export type Snapshot = {
  workers: Worker[]
  job: string | null
  used: number | null
  cap: string
  // Absent in a snapshot an earlier version of the mod stored.
  model?: string | null
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'ops-band': { snapshot: Snapshot | null }
  }
}
