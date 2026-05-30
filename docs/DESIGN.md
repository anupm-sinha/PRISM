# PRISM — Design

> The design that PRISM was built from. Captured during a design-first
> brainstorm; kept here as the project's reference spec.

## Goal

A **design-first status line for Claude Code** — "fancy, colorful, beautiful" —
in the spirit of [METRICC](https://github.com/professionalcrastinationco/METRICC),
but visually richer and architecturally simpler.

## Decisions

| Area | Choice |
|------|--------|
| Form factor | Single-file **Node.js** (`prism.mjs`), **zero dependencies**, cross-platform |
| Layout | **HUD Dashboard** — a multi-line panel framed in box-drawing characters |
| Default theme | **Neon** (glowing accents); also ships `spectrum` and `mono` |
| Context bar | **Purple → magenta gradient** (per-character truecolor) |
| Spacing | Generous gap between info groups (default 5 spaces) for breathing room |
| Glyphs | `auto` → plain Unicode, with `nerd` (Nerd Font) and `ascii` fallbacks |
| Data source | Claude Code's **native stdin JSON** (incl. `rate_limits`, `effort`) — no OAuth scraping |
| Config | `prism.config.jsonc` (JSONC, hot-reloaded each render); zero-config works |

## Layout

```
╭─ ✳ <model> ───────────────────────────────── ⚡ <effort> ─╮
│  ctx ▕<gradient bar>▏ <pct>     5h ▕<bar>▏ <pct>     7d ▕<bar>▏ <pct>
│  ◷ <session>     $<cost>     ⎇ <branch>     +<add> −<del>
╰────────────────────────────────────────────────────────────╯
```

- **Row 1 (title rule):** brand mark + model, with reasoning effort pinned right.
- **Row 2 (meters):** context window + 5h/7d rate limits as labelled bars.
- **Row 3 (session):** duration, cost, git branch and line changes.
- The frame's top/bottom corners are computed from a width-aware panel size.
- **Width-aware:** reads `COLUMNS`; if the panel won't fit, it collapses to a
  single compact line instead of clipping.

## Default stat loadout

On by default: `model`, `effort`, `context`, `fiveHour`, `sevenDay`, `session`,
`cost`, `branch`, `lines`. Off by default (one flag away): reset countdowns,
`tokens`, `cache`, `apiTime`, `directory`, `version`, `pr`, `thinking`.

## Architecture

`prism.mjs`, organised as small pure functions for testability:

1. **stdin → JSON** (tolerant parse; `{}` on failure)
2. **config** — locate `prism.config.jsonc`, strip JSONC, deep-merge over defaults
3. **extract** — defensive getters for every metric (never throw on absent/null)
4. **resolve** — theme palette + glyph set
5. **render** — build rows, color by threshold, draw the frame (or compact line)
6. **output** — write to stdout

Color is 24-bit truecolor via ANSI SGR. Thresholds: green → amber → red, with
configurable warn/crit cutoffs (context and rate limits tuned separately).

Git branch is read via `git branch --show-current`, cached per session in the OS
temp dir (~4s TTL) to stay fast across frequent status-line refreshes.

## Distribution

- Public repo, **MIT** licensed.
- One-line installers (`install.ps1`, `install.sh`) that drop the script into
  `~/.claude/prism/` and patch `settings.json` via the script's own `--install`.
- `--demo` renders sample data across every theme for screenshots.

## Testing

`node --test` covers pure helpers (width measurement, formatters, model/context
parsing, JSONC, merging, thresholds) and end-to-end rendering (full HUD, empty
input, null fields, compact fallback) — guaranteeing the status line never
crashes on real-world payloads.
