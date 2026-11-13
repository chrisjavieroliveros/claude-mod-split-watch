import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Flag, Level } from '../types'

const flagged = atom({ plugin: 'split-watch', key: 'flagged' } as const, [])
const dismissed = atom({ plugin: 'split-watch', key: 'dismissed' } as const, {})

// What is watched, in any project:
// - CLAUDE.md / CLAUDE.local.md anywhere in the repo, .claude/CLAUDE.md, and ~/.claude/CLAUDE.md: loaded into every
//   session, so they cost on every turn long before they get hard to read;
// - each skill's SKILL.md, the project's (.claude/skills) and the user's (~/.claude/skills): loaded whole each run;
// - markdown at the repo root and under the docs folders: past ~15k words a file no longer fits one Read, so it is
//   read in pieces and things get missed.
// Plugin skills are left out: they belong to someone else and can't be split here.
type Kind = 'doc' | 'claude' | 'skill'
type Limits = Record<Kind, [number, number, number]>

// Overridable per user (~/.claude/split-watch.json) and per project (<repo>/.claude/split-watch.json), project last.
type Settings = {
  docs: string[] // folders (repo-relative, any case) whose markdown counts as docs; the repo root always does
  ignore: string[] // file names (any case) or repo-relative folders never flagged
  limits: Limits // word counts for levels 1, 2 and 3, per kind
  model: string // the model "Split it" starts its new chat on (desktop); "" keeps the app's default
  effort: string
}

const DEFAULTS: Settings = {
  docs: ['docs', 'doc', 'documentation'],
  ignore: ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md', 'LICENSE.md', 'CODE_OF_CONDUCT.md', 'node_modules', 'vendor'],
  limits: {
    doc: [6000, 10000, 15000],
    claude: [1500, 2000, 2500],
    skill: [3000, 4500, 6000],
  },
  // Bump when a newer Opus ships, or set "model" in a split-watch.json.
  model: 'claude-opus-5-5',
  effort: 'high',
}

const SETTINGS_FILE = 'split-watch.json'

// Red-orange to deep red, by the worst file's level.
const COLOR: Record<Level, string> = { 1: '#E8603C', 2: '#D63A2F', 3: '#A11A1A' }
const LABEL: Record<Level, string> = { 1: 'getting long', 2: 'split soon', 3: 'split now' }
const ICON_SIZE = 36

// The band above the prompt is drawn by the terminal and the desktop app only. Where VS Code (or the mobile app) is
// attached the same card is shown in a pane of its own, which every surface draws.
const PANE = 'split-watch'
const BAND_SURFACES: readonly string[] = ['terminal', 'desktop']

const icon = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
  <circle cx="28" cy="28" r="28" fill="${color}" fill-opacity="0.16"/>
  <g transform="translate(16 16)" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <path d="M14 2v6h6"/>
    <path d="M7 12h10M7 16h10" stroke-dasharray="2.5 2"/>
  </g>
</svg>`

const words = (text: string) => text.split(/\s+/).filter(Boolean).length
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function levelOf(limits: Limits, kind: Kind, count: number): Level | 0 {
  const [a, b, c] = limits[kind]
  return count >= c ? 3 : count >= b ? 2 : count >= a ? 1 : 0
}

// Paths in the native style of `like` (git answers C:/... on Windows).
const sepOf = (base: string) => (base.includes('\\') ? '\\' : '/')
const native = (path: string, like: string) => (sepOf(like) === '\\' ? path.replace(/\//g, '\\') : path)

function join(base: string, rel: string): string {
  const sep = sepOf(base)
  return `${base.replace(/[\\/]$/, '')}${sep}${rel.split('/').join(sep)}`
}

// ---- where we are ----

type Place = { root: string; home: string | undefined }

// The repo root (git), else the session's folder: a session cd'd into a subfolder still watches the whole project.
async function placeOf($: EngineInterface): Promise<Place> {
  const cwd = await $.session.cwd()
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 }).catch(() => undefined)
  const top = r && r.exitCode === 0 ? r.stdout.trim() : ''
  const root = top ? native(top, cwd) : cwd
  const home = (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))
  return { root, home: home || undefined }
}

// ---- settings ----

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const isTriple = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && n > 0)

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    $.ui.log(`split-watch: ${path} is not valid JSON, ignored`)
    return undefined
  }
}

function merge(base: Settings, over: Record<string, unknown> | undefined): Settings {
  if (!over) return base
  const limits = { ...base.limits }
  const ol = over.limits
  if (ol && typeof ol === 'object') {
    for (const k of ['doc', 'claude', 'skill'] as const) {
      const v = (ol as Record<string, unknown>)[k]
      if (isTriple(v)) limits[k] = v
    }
  }
  return {
    docs: isStrings(over.docs) ? over.docs : base.docs,
    ignore: isStrings(over.ignore) ? over.ignore : base.ignore,
    limits,
    model: typeof over.model === 'string' ? over.model : base.model,
    effort: typeof over.effort === 'string' ? over.effort : base.effort,
  }
}

async function loadSettings($: EngineInterface, place: Place): Promise<Settings> {
  let s = DEFAULTS
  if (place.home) s = merge(s, await readJson($, join(place.home, `.claude/${SETTINGS_FILE}`)))
  return merge(s, await readJson($, join(place.root, `.claude/${SETTINGS_FILE}`)))
}

let settings: Settings = DEFAULTS

// ---- what to look at ----

type Candidate = { path: string; abs: string; kind: Kind } // path as shown: repo-relative, or ~/... for the user's

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function isIgnored(rel: string, s: Settings): boolean {
  const lower = rel.toLowerCase()
  const parts = lower.split('/')
  return s.ignore.some(i => {
    const n = norm(i)
    return n.includes('/') ? lower === n || lower.startsWith(`${n}/`) : parts.includes(n)
  })
}

function kindOf(rel: string, s: Settings): Kind | undefined {
  if (isIgnored(rel, s)) return undefined
  const base = baseName(rel)
  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md') return 'claude'
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel)) return 'skill'
  if (!/\.md$/i.test(rel)) return undefined
  if (!rel.includes('/')) return 'doc'
  const lower = rel.toLowerCase()
  return s.docs.some(d => lower.startsWith(`${norm(d)}/`)) ? 'doc' : undefined
}

// Every markdown file git knows of or would add (tracked + untracked, .gitignore respected), or undefined outside git.
async function gitMarkdown($: EngineInterface, root: string): Promise<string[] | undefined> {
  const r = await $.process
    .run(['git', 'ls-files', '-z', '-co', '--exclude-standard', '--', '*.md'], { cwd: root, timeoutMs: 10000 })
    .catch(() => undefined)
  if (!r || r.exitCode !== 0) return undefined
  return r.stdout.split('\0').filter(Boolean)
}

// Outside git: the root's own .md files and every .md under the docs folders, however deep.
async function walkMarkdown($: EngineInterface, root: string, s: Settings): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 8) return
    for (const entry of await $.fs.list(join(root, rel)).catch(() => [])) {
      const path = `${rel}/${entry.name}`
      if (isIgnored(path, s)) continue
      if (entry.kind === 'dir') await walk(path, depth + 1)
      else if (entry.kind === 'file' && /\.md$/i.test(entry.name)) out.push(path)
    }
  }
  const top = await $.fs.list(root).catch(() => [])
  for (const entry of top) {
    if (entry.kind === 'file' && /\.md$/i.test(entry.name)) out.push(entry.name)
    if (entry.kind === 'dir' && s.docs.some(d => norm(d) === entry.name.toLowerCase())) await walk(entry.name, 1)
  }
  // Nested docs folders named with a slash (e.g. "packages/api/docs").
  for (const d of s.docs.filter(d => d.includes('/'))) await walk(d.replace(/\\/g, '/').replace(/\/+$/, ''), 1)
  return out
}

// Skill folders under <base>/.claude/skills, as SKILL.md paths relative to base.
async function skillFiles($: EngineInterface, base: string): Promise<string[]> {
  return (await $.fs.list(join(base, '.claude/skills')).catch(() => []))
    .filter(e => e.kind === 'dir')
    .map(e => `.claude/skills/${e.name}/SKILL.md`)
}

async function candidates($: EngineInterface, place: Place, s: Settings): Promise<Candidate[]> {
  const { root, home } = place
  const listed = (await gitMarkdown($, root)) ?? (await walkMarkdown($, root, s))
  // Often gitignored, so always looked at directly.
  const always = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', ...(await skillFiles($, root))]

  const seen = new Set<string>()
  const out: Candidate[] = []
  const add = (c: Candidate) => {
    const key = norm(c.abs)
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }
  for (const rel of [...always, ...listed]) {
    const kind = kindOf(rel, s)
    if (kind) add({ path: rel, abs: join(root, rel), kind })
  }
  if (home) {
    add({ path: '~/.claude/CLAUDE.md', abs: join(home, '.claude/CLAUDE.md'), kind: 'claude' })
    for (const rel of await skillFiles($, home)) add({ path: `~/${rel}`, abs: join(home, rel), kind: 'skill' })
  }
  return out
}

async function scan($: EngineInterface, place: Place, s: Settings): Promise<Flag[]> {
  const out: Flag[] = []
  for (const c of await candidates($, place, s)) {
    const text = await $.fs.read(c.abs).catch(() => undefined)
    if (typeof text !== 'string') continue
    const count = words(text)
    const level = levelOf(s.limits, c.kind, count)
    if (level > 0) out.push({ path: c.path, words: count, level: level as Level })
  }
  return out.sort((a, b) => b.level - a.level || b.words - a.words)
}

// ---- dismissals ----

// The card shows while any file has grown past the level it was dismissed at.
const isNewIn = (flags: Flag[], gone: Record<string, Level>) => flags.some(f => f.level > (gone[f.path] ?? 0))

// Kept across sessions: per project for the project's files, once for the user's own (~/...), which show everywhere.
const projectKey = (root: string) => `dismissed:${root.toLowerCase()}`
const USER_KEY = 'dismissed:~'
const isUsers = (path: string) => path.startsWith('~/')

const say = ($: EngineInterface, text: string) => {
  try {
    $.ui.toast(text)
  } catch {
    // nothing to show it on; the card still carries it
  }
}

// True while a surface that has no band (VS Code, the mobile app) is attached.
async function needsPane($: EngineInterface): Promise<boolean> {
  const surfaces = await $.session.surfaces().catch(() => [] as readonly RenderSurface[])
  return surfaces.some(s => !BAND_SURFACES.includes(s))
}

let lastWorst = 0 // the worst level already toasted about, so a jump toasts once
let paneOpen = false
let place: Place | undefined // set by refresh, kept for the buttons

// Opens the pane where the band isn't drawn and there's something new to show; closes it once there's nothing.
async function syncPane($: EngineInterface, flags: Flag[], asked = false): Promise<void> {
  const show = isNewIn(flags, await read($, dismissed)) && (await needsPane($))
  if (show && (!paneOpen || asked)) {
    const top = flags[0]
    const opened = await $.ui.open({ id: PANE, title: 'Split watch' })
    if (!paneOpen && top) say($, `${baseName(top.path)} is ${short(top.words)} words: ${LABEL[top.level]}`)
    paneOpen = true
    if (!opened.isPlaced) $.ui.log(`split-watch: the pane waits undrawn (${opened.reason})`)
  } else if (!show && paneOpen) {
    paneOpen = false
    await $.ui.close({ id: PANE }).catch(() => undefined)
  }
}

async function refresh($: EngineInterface): Promise<void> {
  place = await placeOf($)
  settings = await loadSettings($, place)
  const flags = await scan($, place, settings)
  await update($, flagged, () => flags)

  const top = flags[0]
  const worst = top?.level ?? 0
  if (top && worst > lastWorst && lastWorst > 0) say($, `${baseName(top.path)} is ${short(top.words)} words: ${LABEL[top.level]}`)
  lastWorst = worst

  await syncPane($, flags).catch(() => undefined)
}

const asLevels = (v: unknown): Record<string, Level> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Level>) : {}

async function loadDismissed($: EngineInterface): Promise<void> {
  const p = place ?? (await placeOf($))
  const mine = asLevels(await $.store.get(projectKey(p.root)))
  const users = asLevels(await $.store.get(USER_KEY))
  await update($, dismissed, () => ({ ...mine, ...users }))
}

async function dismissAll($: EngineInterface, flags: Flag[]): Promise<void> {
  const p = place ?? (await placeOf($))
  const mine: Record<string, Level> = {}
  const users = asLevels(await $.store.get(USER_KEY))
  for (const f of flags) (isUsers(f.path) ? users : mine)[f.path] = f.level
  await $.store.set(projectKey(p.root), mine)
  await $.store.set(USER_KEY, users)
  await update($, dismissed, () => ({ ...mine, ...users }))
  await syncPane($, flags).catch(() => undefined)
}

// ---- Split it ----

function splitPrompt(f: Flag): string {
  return (
    `${f.path} is ${short(f.words)} words (${LABEL[f.level]}). Split it into one file per topic with a short ` +
    `index that says what lives where. Move the text as is, don't rewrite it, and update every reference to it ` +
    `(CLAUDE.md, other docs, skills, memory). Propose the split before moving anything.`
  )
}

const background = (root: string) =>
  `The split-watch mod (a card above the prompt) flagged this file as too long: past ~15k words a doc no longer fits ` +
  `one Read, and CLAUDE.md / SKILL.md files are loaded whole into every session or skill run. Project folder: ${root}. ` +
  `Read its CLAUDE.md, if there is one, for the working rules, and look for an earlier split in the repo (a folder ` +
  `of one file per topic plus a short index file) to follow its shape.`

// "Split it" on the desktop runs in a new chat of its own: the configured model and effort, top level in the sidebar
// (not nested under and reporting back to the session the card popped up in), opened in the main pane.
const SESSION = 'ccd_session'
const MGMT = 'ccd_session_mgmt'
const WINDOW = 'ccd_window'

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map(b => b.text ?? '').join('\n')

// Elsewhere (terminal, VS Code, mobile) there are no session tools: the prompt goes in this chat's prompt box.
async function draftHere($: EngineInterface, f: Flag, why?: string): Promise<void> {
  const filled = await $.prompt.fill({ text: splitPrompt(f) }).catch(() => ({ isFilled: false }))
  if (filled.isFilled) say($, why ? `${why}; drafted the split in the prompt box instead` : `Split prompt drafted in the prompt box: review it and send`)
  else say($, `Couldn't fill the prompt box (a dialog is open?): run /split-check for the list`)
}

let starting = false // a second press while the first is still starting does nothing

async function splitIt($: EngineInterface, f: Flag, surface: RenderSurface): Promise<void> {
  if (starting) return
  starting = true
  try {
    if (surface !== 'desktop') return await draftHere($, f)
    const { model, effort } = settings
    say($, `Starting a new chat to split ${baseName(f.path)}…`)
    const root = (place ?? (await placeOf($))).root
    const started = await $.mcp.call(SESSION, 'start_session', {
      initiation: 'user_asked',
      title: `Split ${baseName(f.path)}`,
      name: `split-${baseName(f.path).replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 24),
      context: 'fresh',
      prompt: splitPrompt(f),
      background: background(root),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })
    const id = textOf(started).match(/local_[A-Za-z0-9_-]+/)?.[0]
    if (started.isError || id === undefined) throw new Error(textOf(started) || 'no session id')

    // start_session caps model and effort at this session's own; these lift them (the app asks if that costs more).
    if (model) await $.mcp.call(MGMT, 'set_session_model', { session_id: id, model }).catch(() => undefined)
    if (effort) await $.mcp.call(MGMT, 'set_session_effort', { session_id: id, effort }).catch(() => undefined)
    // Show it, then cut it loose so it is a chat of its own, not a side session of this one.
    await $.mcp.call(WINDOW, 'open_session_in', { session_id: id, target: 'focus' }).catch(() => undefined)
    await $.mcp.call(MGMT, 'detach_session', { session_id: id }).catch(() => undefined)
    say($, `New chat started: Split ${baseName(f.path)}`)
  } catch (err) {
    // The app refused or its session tools are missing.
    await draftHere($, f, `Couldn't start a new chat (${String((err as Error)?.message ?? err).slice(0, 80)})`)
  } finally {
    starting = false
  }
}

function report(flags: Flag[]): string {
  const limits = Object.entries(settings.limits)
    .map(([k, [a, b, c]]) => `${k} ${short(a)} / ${short(b)} / ${short(c)}`)
    .join(', ')
  const where =
    `Watched: CLAUDE.md files, skills (project + ~/.claude/skills), markdown at the repo root and under ` +
    `${settings.docs.join(', ')}. Limits (getting long / split soon / split now): ${limits}. ` +
    `Change them in .claude/${SETTINGS_FILE} (project) or ~/.claude/${SETTINGS_FILE}.`
  if (flags.length === 0) return `No doc, CLAUDE.md or skill is big enough to split.\n\n${where}`
  const rows = flags.map(f => `- ${f.path}: ${f.words.toLocaleString('en-US')} words, ${LABEL[f.level]}`)
  return `Files to split, worst first:\n${rows.join('\n')}\n\n${where}`
}

// ---- hooks ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'split-check',
      description: 'List every doc, CLAUDE.md or skill big enough to split (add "reset" to bring a dismissed card back)',
    })
    paneOpen = false
    place = await placeOf($).catch(() => undefined)
    await loadDismissed($).catch(() => undefined)
    await refresh($).catch(() => undefined)
    return started
  })

  // VS Code or the mobile app joining later gets the pane.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await syncPane($, await read($, flagged)).catch(() => undefined)
    return attached
  })

  // Any change, however it was made (Write, Edit, a script, git, a cd to another repo), shows by the end of the turn.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const before = place?.root
    await refresh($).catch(() => undefined)
    if (place && place.root !== before) await loadDismissed($).catch(() => undefined)
    return done
  })

  on('command.run', { command: 'split-check' }, async ($, e) => {
    await refresh($)
    if (e.args.trim() === 'reset' && place) {
      await $.store.set(projectKey(place.root), {})
      await $.store.set(USER_KEY, {})
      await update($, dismissed, () => ({}))
    }
    const flags = await read($, flagged)
    await syncPane($, flags, true).catch(() => undefined) // asked: placed at any width
    return { text: report(flags) }
  })

  // The pane goes away with the person's close too; it comes back when a file grows a level.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    paneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const flags = await read($, flagged)
    const worst = flags[0]
    if (e.props.hasSurvey || worst === undefined || !isNewIn(flags, await read($, dismissed))) return next(e)

    const color = COLOR[worst.level]
    const rest = flags.slice(1)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const key = (text: string) => (
      <Text bold color="claude">
        {text}
      </Text>
    )
    const mark =
      'Svg' in ui ? (
        <ui.Svg source={icon(color)} alt="File to split" width={ICON_SIZE} height={ICON_SIZE} />
      ) : (
        <Text color={color}>■</Text>
      )

    return (
      <Box key="card" flexDirection="row" alignItems="center" gap="sm" borderStyle="round" borderColor={color} paddingX="sm" paddingY="xs">
        {mark}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size="caption" bold color={color}>
            {LABEL[worst.level].toUpperCase()}
          </Text>
          <Text bold>
            {key(baseName(worst.path))} is {short(worst.words)} words, {key('time to split it')}
          </Text>
          <Text size="footnote" dimColor wrap="truncate-end">
            {rest.length === 0
              ? worst.path
              : `+${rest.length} more: ${rest.map(f => `${baseName(f.path)} ${short(f.words)}`).join(' · ')}`}
          </Text>
        </Box>
        <Box flexDirection="row" gap="xs" flexShrink={0}>
          <Button key="split" variant="primary" label="Split it" onPress={() => void splitIt($, worst, e.surface)} />
          <Button
            key="list"
            variant="secondary"
            label="List all"
            onPress={() => void $.prompt.fill({ text: '/split-check' })}
          />
          <Button key="dismiss" plain dimColor label="Dismiss" onPress={() => void dismissAll($, flags)} />
        </Box>
      </Box>
    )
  })

  // The same card for VS Code and the mobile app, with the whole list in place of "List all".
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const flags = await read($, flagged)
    const worst = flags[0]
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    if (worst === undefined) return <Text dimColor>No doc, CLAUDE.md or skill is big enough to split.</Text>

    const color = COLOR[worst.level]
    const key = (text: string) => (
      <Text bold color="claude">
        {text}
      </Text>
    )
    const mark =
      'Svg' in ui ? (
        <ui.Svg source={icon(color)} alt="File to split" width={ICON_SIZE} height={ICON_SIZE} />
      ) : (
        <Text color={color}>■</Text>
      )

    return (
      <Box key="card" flexDirection="column" gap="xs" borderStyle="round" borderColor={color} paddingX="sm" paddingY="xs">
        <Box flexDirection="row" alignItems="center" gap="sm">
          {mark}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="caption" bold color={color}>
              {LABEL[worst.level].toUpperCase()}
            </Text>
            <Text bold>
              {key(baseName(worst.path))} is {short(worst.words)} words, {key('time to split it')}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="column">
          {flags.map(f => (
            <Text size="footnote" wrap="truncate-end">
              <Text color={COLOR[f.level]}>■ </Text>
              {f.path}
              <Text dimColor>{`  ${short(f.words)} words, ${LABEL[f.level]}`}</Text>
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" gap="xs">
          <Button key="split" variant="primary" label="Split it" onPress={() => void splitIt($, worst, e.surface)} />
          <Button key="dismiss" plain dimColor label="Dismiss" onPress={() => void dismissAll($, flags)} />
        </Box>
      </Box>
    )
  })
}
