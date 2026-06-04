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
| Default view | **text** (worded labels); compact `icon` glyphs are one command away (`--view`) |
| Version dot | `●` by the Claude Code version flags updates — green current, amber newer (hourly npm check, cached; `checkUpdate:false` disables) |
| Fonts | `--install-font` adds CaskaydiaCove Nerd Font (per-user, no admin) for the full icon set |
| Self-update | `--update` replaces the script in place from `main`; `--sync-config` adds new options to your config (re-running the installer does both) — both keep a `.bak` |

## Layout

```
╭─ ✳  <model>  ● v<cc-version> ──────────────────────────── ⚡ <effort> ─╮
│  Context ▕<gradient bar>▏ <pct>% used   5h Usage ▕<bar>▏ <pct>% (~Nh)   7d Usage ▕<bar>▏ <pct>% (~Nh)   Cost $<cost>
│  Session <dur>     Cache <pct>%     Branch <branch>     +<add> −<del>
╰────────────────────────────────────────────────────────────────────────╯
```

- **Row 1 (title rule):** brand mark + model + an update-aware version dot,
  with reasoning effort pinned right.
- **Row 2 (meters):** context (`% used`) + 5h/7d rate limits (each with a
  `(~Nh)`-until-reset hint), then cost and tokens.
- **Row 3 (session):** duration, cache %, git branch and line changes.
- Labels are **text** by default (`Context`, `5h Usage`, …); `icon` view swaps
  in glyphs (full Nerd Font set via `--install-font`, box-safe Unicode otherwise).
- The frame's top/bottom corners are computed from a width-aware panel size.
- **Width-aware:** reads `COLUMNS`; if the panel won't fit, it collapses to a
  single compact line instead of clipping.

## Default stat loadout

On by default: `model`, `effort`, `context`, `fiveHour`, `sevenDay`, `session`,
`cost`, `branch`, `lines`, `tokens`, `cache`, `version`. Off by default (one flag
away): reset countdowns, `apiTime`, `directory`, `pr`, `thinking`. When `version`
is on, an update-aware `●` dot precedes it.

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
temp dir (~4s TTL) to stay fast across frequent status-line refreshes. Two more
caches live alongside it: last-known `rate_limits` per session (so the 5h/7d bars
survive payloads that omit them), and the latest Claude Code version from npm
(1 h TTL) that drives the version dot — fetched after the render so it never
blocks output.

## Distribution

- Public repo, **MIT** licensed.
- One-line installers (`install.ps1`, `install.sh`) that drop the script into
  `~/.claude/prism/` and patch `settings.json` via the script's own `--install`.
  Re-running them is an **idempotent upgrade**: refresh the script, then
  `--sync-config` to merge any new options into an existing config.
- `--demo` renders sample data across every theme for screenshots.
- `--update` self-updates the script from `main`; `--sync-config` inserts any
  newly-released config keys without disturbing the user's values or comments
  (top-level + nested, comma-safe, `.bak` on change); `--view icon|text` flips the
  label view (surgical JSONC edit, comments preserved); `--install-font`
  installs CaskaydiaCove Nerd Font into the per-user font dir (no admin).

## Testing

`node --test` covers pure helpers (width measurement, formatters, model/context
parsing, JSONC, merging, thresholds) and end-to-end rendering (full HUD, empty
input, null fields, compact fallback) — guaranteeing the status line never
crashes on real-world payloads.
