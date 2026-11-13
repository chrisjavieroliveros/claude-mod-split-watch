// 1 getting long (red-orange), 2 split soon (red), 3 split now (deep red).
export type Level = 1 | 2 | 3

// A file over its kind's first threshold: its path as shown (project-relative, or ~/... for the user's), its absolute
// path (what "Ignore this file" records), word count and level.
export type Flag = { path: string; abs: string; words: number; level: Level }

declare module 'claude-code' {
  interface PluginState {
    'split-watch': {
      // Every flagged file, worst first.
      flagged: Flag[]
      // Per path, the level the person dismissed it at; the card comes back when it grows past that.
      dismissed: Record<string, Level>
    }
  }
}
