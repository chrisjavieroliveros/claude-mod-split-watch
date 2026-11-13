# split-watch

A Claude Code mod that shows a card above the prompt (a pane in VS Code) once a file Claude reads in full gets long
enough to split. The card goes from red-orange to deep red as the file grows. It works in any project.

**Watched**
- `CLAUDE.md` / `CLAUDE.local.md` anywhere in the repo, `.claude/CLAUDE.md`, and `~/.claude/CLAUDE.md`
- each skill's `SKILL.md`, in the project's `.claude/skills/` and in `~/.claude/skills/`
- markdown at the repo root and under `docs/`, `doc/` or `documentation/` (any case)

It finds the repo root with git, so a session in a subfolder still watches the whole project, and it respects
`.gitignore`. Outside git it walks the root and the docs folders. Changelogs, licences, `node_modules` and `vendor`
are skipped.

**Default limits** (words, for getting long / split soon / split now): docs 5k / 8k / 12k, CLAUDE.md 1.5k / 2k / 2.5k,
SKILL.md 2.5k / 3.5k / 4.5k. Docs stop before ~25k tokens (one Read), SKILL.md before ~500 lines.

**Buttons**: *Split it* starts a new chat that proposes the split (on the desktop app; elsewhere it drafts the prompt
in the prompt box), *List all* runs `/split-check`, and *Dismiss* hides the card until a file grows another level.
`/split-check reset` brings dismissed cards back.

## Settings

Optional `split-watch.json`, in `~/.claude/` (your defaults) and/or `<repo>/.claude/` (the project's, applied last):

```json
{
  "docs": ["docs", "Design", "packages/api/docs"],
  "ignore": ["CHANGELOG.md", "node_modules", "docs/generated"],
  "limits": { "doc": [5000, 8000, 12000], "claude": [1500, 2000, 2500], "skill": [2500, 3500, 4500] },
  "model": "claude-opus-5-5",
  "effort": "high"
}
```

Every field is optional. `docs` and `ignore` replace the defaults rather than adding to them. Set `"model": ""` to
start the split chat on the app's default model.

## Install

At the prompt of a terminal session:

```
/plugin install split-watch --marketplace chrisjavieroliveros/claude-mod-split-watch
```

Answer `y` to add the marketplace, then pick a scope (user = every project on that machine).

From a shell:

```
claude plugin install split-watch --marketplace chrisjavieroliveros/claude-mod-split-watch
```

Don't install it twice on one machine (say, from the marketplace and as a `~/.claude/skills` folder too), or the card
shows twice.
