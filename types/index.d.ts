export type Worker = {
  id: string
  type: string
  description: string
  since: number
}

export type Snapshot = {
  workers: Worker[]
  job: string | null
  used: number | null
  cap: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'ops-band': { snapshot: Snapshot | null }
  }
}
