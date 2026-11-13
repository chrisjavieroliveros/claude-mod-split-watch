import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = 'C:\\Users\\chris\\Unity\\Project-Star'
const HOME = 'C:\\Users\\chris'
const at = (rel: string) => `${CWD}\\${rel.split('/').join('\\')}`
// The fixture paths are Windows ones; off Windows the engine resolves them as relative, under the test's folder.
const fsPath = (e: unknown) => {
  const path = (e as { path: string }).path
  const i = path.indexOf('C:\\')
  return i > 0 ? path.slice(i) : path
}
const abs = (key: string) => (key.startsWith('~/') ? `${HOME}\\${key.slice(2).split('/').join('\\')}` : at(key))

const BAND = {
  plugin: 'split-watch',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } },
} as const

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
const text = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

type Opts = { surfaces?: string[]; git?: boolean; cwd?: string; files?: Record<string, string>; store?: Record<string, unknown> }

// The project beneath the mod: word counts per path (repo-relative, or ~/... for the user's), editable between turns.
// git (on by default) answers the repo root and lists every .md key; `files` holds raw text (settings JSON).
function world(on: On, sizes: Record<string, number>, opts: Opts | string[] = {}) {
  const o: Opts = Array.isArray(opts) ? { surfaces: opts } : opts
  const filled: string[] = []
  const panes: string[] = [] // 'open' / 'close', in order
  const written: Record<string, string> = {} // fs.write, by absolute path; read back before anything else
  const git = o.git ?? true
  mock.store(on, o.store ?? {})
  on('session.cwd', () => ({ value: o.cwd ?? CWD }))
  on('session.surfaces', () => ({ value: o.surfaces ?? ['desktop'] }))
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'USERPROFILE' ? HOME : undefined }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    if (!git) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
    if (argv[1] === 'rev-parse') return { value: { exitCode: 0, stdout: `${CWD.replace(/\\/g, '/')}\n`, stderr: '' } }
    if (argv[1] === 'ls-files') {
      const listed = Object.keys(sizes).filter(k => !k.startsWith('~/') && k.endsWith('.md'))
      return { value: { exitCode: 0, stdout: listed.map(k => `${k}\0`).join(''), stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('ui.open', () => {
    panes.push('open')
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    panes.push('close')
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  on('command.register', () => ({ value: { command: 'split-check' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => {
    filled.push((e as { text: string }).text)
    return { isFilled: true }
  })
  on('fs.list', (_, e) => {
    const path = fsPath(e)
    if (path === CWD) return { value: [entry('Docs', 'dir'), entry('README.md', 'file'), entry('Assets', 'dir')] }
    if (path === abs('~/.claude/skills')) return { value: [entry('prompt-hud', 'dir')] }
    if (path === at('Docs')) return { value: [entry('VFXBriefs.md', 'file'), entry('Small.md', 'file'), entry('ArtDirection', 'dir'), entry('pic.png', 'file')] }
    if (path === at('Docs/ArtDirection')) return { value: [entry('ArtGuide.md', 'file')] }
    if (path === at('.claude/skills')) return { value: [entry('ui-import', 'dir')] }
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    const { text } = e as { text: string }
    const path = fsPath(e)
    written[path] = text
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const path = fsPath(e)
    if (path in written) return { value: written[path] }
    const raw = Object.keys(o.files ?? {}).find(r => abs(r) === path)
    if (raw !== undefined) return { value: (o.files ?? {})[raw] }
    const rel = Object.keys(sizes).find(r => abs(r) === path)
    if (rel === undefined) throw new Error('ENOENT')
    return { value: text(sizes[rel] ?? 0) }
  })
  return { filled, panes, written }
}

const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', category: null, explanation: null } as const

type T = Parameters<Parameters<typeof test>[1]>[0]
const start = ($: T, surface: 'desktop' | 'terminal' | 'vscode' = 'desktop') => $.session.start({ cwd: CWD, surface, isInteractive: true })
const label = async (ui: Awaited<ReturnType<T['ui']['mount']>>) =>
  (await ui.find({ type: 'Text', text: /^(GETTING LONG|SPLIT SOON|SPLIT NOW)$/ }))?.text

test('a brief past 8k words shows a red "split soon" card, on every surface', async ($, on) => {
  world(on, { 'CLAUDE.md': 860, 'Docs/VFXBriefs.md': 9900, 'Docs/ArtDirection/ArtGuide.md': 6200, 'Docs/Small.md': 300 })
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await label(ui)).toBe('SPLIT SOON')
    expect((await ui.find({ type: 'Text', text: /\+1 more/ }))?.text).toContain('ArtGuide.md 6.2k')
    await ui.unmount()
  }
})

test('past 12k words it turns deep red: "split now"', async ($, on) => {
  world(on, { 'Docs/VFXBriefs.md': 13000 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBe('SPLIT NOW')
  await ui.unmount()
})

test('CLAUDE.md has tighter limits: 2.6k words is already "split now"', async ($, on) => {
  world(on, { 'CLAUDE.md': 2600 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBe('SPLIT NOW')
  expect((await ui.find({ type: 'Text', text: /words, / }))?.text).toContain('CLAUDE.md')
  await ui.unmount()
})

test('nothing big enough: no card', async ($, on) => {
  world(on, { 'CLAUDE.md': 860, 'Docs/VFXBriefs.md': 4000, '.claude/skills/ui-import/SKILL.md': 2000 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBeUndefined()
  await ui.unmount()
})

type Call = { server: string; tool: string; args: Record<string, unknown> }

test('Split it starts a new top-level Opus chat at high effort, nothing drafted here', async ($, on) => {
  const w = world(on, { 'Docs/VFXBriefs.md': 9900, 'Docs/Small.md': 7000 })
  const calls: Call[] = []
  on('mcp.call', (_, e) => {
    calls.push(e as Call)
    const text = (e as Call).tool === 'start_session' ? 'Started session local_abc123 (split-vfxbriefs).' : 'ok'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'split' })

  expect(w.filled.length).toBe(0)
  const startCall = calls.find(c => c.tool === 'start_session')
  expect(startCall?.args.model).toBe('claude-opus-5-5')
  expect(startCall?.args.effort).toBe('high')
  expect(startCall?.args.context).toBe('fresh')
  expect(String(startCall?.args.prompt)).toContain('Docs/VFXBriefs.md is 9.9k words')
  expect(calls.map(c => c.tool)).toEqual(['start_session', 'set_session_model', 'set_session_effort', 'open_session_in', 'detach_session'])
  expect(calls.slice(1).every(c => c.args.session_id === 'local_abc123')).toBe(true)
  await ui.unmount()
})

test('without the desktop session tools, Split it falls back to drafting here', async ($, on) => {
  const w = world(on, { 'Docs/VFXBriefs.md': 9900 })
  on('mcp.call', () => {
    throw new Error('no server ccd_session')
  })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'split' })
  expect(w.filled.length).toBe(1)
  expect(w.filled[0]).toContain('Docs/VFXBriefs.md is 9.9k words')
  await ui.unmount()
})

test('Dismiss hides it until a file grows a level', async ($, on) => {
  const sizes: Record<string, number> = { 'Docs/VFXBriefs.md': 9000 }
  world(on, sizes)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dismiss' })
  expect(await label(ui)).toBeUndefined()

  sizes['Docs/VFXBriefs.md'] = 10500 // same level: stays hidden
  await $.turn.complete(TURN)
  expect(await label(ui)).toBeUndefined()

  sizes['Docs/VFXBriefs.md'] = 12500 // a level up: back, deep red
  await $.turn.complete(TURN)
  expect(await label(ui)).toBe('SPLIT NOW')
  await ui.unmount()
})

const PANE = {
  plugin: 'split-watch',
  component: 'Pane',
  requestId: 'split-watch',
  props: { title: 'Split watch', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('in VS Code (no band there) the card opens as a pane with the whole list', async ($, on) => {
  const w = world(on, { 'Docs/VFXBriefs.md': 9900, 'Docs/ArtDirection/ArtGuide.md': 6200 }, ['vscode'])
  await start($, 'vscode')
  expect(w.panes).toEqual(['open'])
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await label(ui)).toBe('SPLIT SOON')
  expect((await ui.find({ type: 'Text', text: /ArtGuide\.md/ }))?.text).toContain('6.2k words, getting long')
  await ui.unmount()
})

test('in VS Code Split it drafts the prompt here, without the desktop session tools', async ($, on) => {
  const w = world(on, { 'Docs/VFXBriefs.md': 9900 }, ['vscode'])
  const calls: string[] = []
  on('mcp.call', (_, e) => {
    calls.push((e as Call).tool)
    throw new Error('no server')
  })
  await start($, 'vscode')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'split' })
  expect(calls.length).toBe(0)
  expect(w.filled.length).toBe(1)
  expect(w.filled[0]).toContain('Docs/VFXBriefs.md is 9.9k words')
  await ui.unmount()
})

test('in VS Code Dismiss closes the pane; a level up opens it again', async ($, on) => {
  const sizes: Record<string, number> = { 'Docs/VFXBriefs.md': 9000 }
  const w = world(on, sizes, ['vscode'])
  await start($, 'vscode')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'dismiss' })
  expect(w.panes).toEqual(['open', 'close'])
  await ui.unmount()

  sizes['Docs/VFXBriefs.md'] = 15500
  await $.turn.complete(TURN)
  expect(w.panes).toEqual(['open', 'close', 'open'])
})

test('on the terminal or desktop alone no pane opens: the band carries it', async ($, on) => {
  const w = world(on, { 'Docs/VFXBriefs.md': 9900 }, ['terminal'])
  await start($, 'terminal')
  await $.turn.complete(TURN)
  expect(w.panes.length).toBe(0)
})

// ---- any project ----

const allFlags = async ($: T) => (await $.command.run({ command: 'split-check', args: '' })).text ?? ''

test("a session cd'd into a subfolder still watches the whole repo (git root)", async ($, on) => {
  world(on, { 'Docs/VFXBriefs.md': 9900 }, { cwd: at('Assets/Scripts') })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBe('SPLIT SOON')
  await ui.unmount()
})

test('docs folders match any case; markdown outside them and the root is left alone', async ($, on) => {
  world(on, { 'docs/guide.md': 11000, 'Assets/Plugins/readme.md': 20000, 'README.md': 7000 })
  await start($)
  const out = await allFlags($)
  expect(out).toContain('docs/guide.md')
  expect(out).toContain('README.md: 7,000')
  expect(out).not.toContain('Assets/Plugins')
})

test("nested CLAUDE.md files and the user's own CLAUDE.md and skills are watched", async ($, on) => {
  world(on, { 'packages/api/CLAUDE.md': 2100, '~/.claude/CLAUDE.md': 1600, '~/.claude/skills/prompt-hud/SKILL.md': 3600 })
  await start($)
  const out = await allFlags($)
  expect(out).toContain('packages/api/CLAUDE.md: 2,100 words, split soon')
  expect(out).toContain('~/.claude/CLAUDE.md: 1,600 words, getting long')
  expect(out).toContain('~/.claude/skills/prompt-hud/SKILL.md: 3,600 words, split soon')
})

test('changelogs and licences are never flagged', async ($, on) => {
  world(on, { 'CHANGELOG.md': 40000, 'docs/LICENSE.md': 20000 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBeUndefined()
  await ui.unmount()
})

test('outside git it walks the root and the docs folders', async ($, on) => {
  world(on, { 'Docs/ArtDirection/ArtGuide.md': 13000, 'README.md': 100 }, { git: false })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBe('SPLIT NOW')
  await ui.unmount()
})

test('a project split-watch.json overrides folders and limits', async ($, on) => {
  world(on, { 'Design/Spec.md': 3000, 'Docs/VFXBriefs.md': 9900 }, {
    files: { '.claude/split-watch.json': JSON.stringify({ docs: ['Design'], limits: { doc: [1000, 2000, 2500] } }) },
  })
  await start($)
  const out = await allFlags($)
  expect(out).toContain('Design/Spec.md: 3,000 words, split now')
  expect(out).not.toContain('VFXBriefs')
})

test("a user's file dismissed in another project stays dismissed here; this project's files still show", async ($, on) => {
  const store = { 'dismissed:~': { '~/.claude/CLAUDE.md': 1 }, 'dismissed:c:\\elsewhere': { 'Docs/VFXBriefs.md': 3 } }
  world(on, { '~/.claude/CLAUDE.md': 1600 }, { store })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBeUndefined()
  await ui.unmount()
})

test('a dismissal made elsewhere does not hide this project\'s files', async ($, on) => {
  world(on, { 'Docs/VFXBriefs.md': 9000 }, { store: { 'dismissed:c:\\elsewhere': { 'Docs/VFXBriefs.md': 3 } } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBe('SPLIT SOON')
  await ui.unmount()
})

// ---- ignored on this machine ----

const IGNORED = abs('~/.claude/split-watch.ignored.json')

test('Ignore this file drops the card\'s file for good, in a machine-local list; the next file takes the card', async ($, on) => {
  const sizes: Record<string, number> = { '~/.claude/skills/prompt-hud/SKILL.md': 7400, 'Docs/VFXBriefs.md': 9000 }
  const w = world(on, sizes)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBe('SPLIT NOW') // the skill
  await ui.press({ key: 'ignore' })

  expect(JSON.parse(w.written[IGNORED] ?? '{}')).toEqual({ files: [abs('~/.claude/skills/prompt-hud/SKILL.md')] })
  expect(await label(ui)).toBe('SPLIT SOON') // the brief now
  expect((await ui.find({ type: 'Text', text: /words, / }))?.text).toContain('VFXBriefs.md')

  sizes['~/.claude/skills/prompt-hud/SKILL.md'] = 20000 // growing doesn't bring it back, unlike Dismiss
  await $.turn.complete(TURN)
  expect(await allFlags($)).not.toContain('prompt-hud')
  await ui.unmount()
})

test('an ignore list already on the machine hides its files in every project, and /split-check says so', async ($, on) => {
  world(on, { '~/.claude/skills/prompt-hud/SKILL.md': 7400, 'Docs/VFXBriefs.md': 9000 }, {
    files: { '~/.claude/split-watch.ignored.json': JSON.stringify({ files: [abs('~/.claude/skills/prompt-hud/SKILL.md').toUpperCase()] }) },
  })
  await start($)
  const out = await allFlags($)
  expect(out).not.toContain('prompt-hud')
  expect(out).toContain('Docs/VFXBriefs.md')
  expect(out).toContain('Ignored on this machine: 1 file, listed in ~/.claude/split-watch.ignored.json')
})

test('/split-check reset brings dismissed cards back but keeps ignored files ignored', async ($, on) => {
  world(on, { 'Docs/VFXBriefs.md': 9000 }, {
    files: { '~/.claude/split-watch.ignored.json': JSON.stringify({ files: [at('Docs/VFXBriefs.md')] }) },
  })
  await start($)
  await $.command.run({ command: 'split-check', args: 'reset' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await label(ui)).toBeUndefined()
  await ui.unmount()
})

test('in VS Code the pane has Ignore this file too', async ($, on) => {
  const w = world(on, { 'Docs/VFXBriefs.md': 9900 }, ['vscode'])
  await start($, 'vscode')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'ignore' })
  expect(JSON.parse(w.written[IGNORED] ?? '{}').files).toEqual([at('Docs/VFXBriefs.md')])
  expect(w.panes).toEqual(['open', 'close'])
  await ui.unmount()
})

