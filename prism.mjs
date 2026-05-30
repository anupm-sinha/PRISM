#!/usr/bin/env node
/**
 * PRISM — a colorful HUD status line for Claude Code.
 *
 * Zero dependencies. Reads Claude Code's session JSON on stdin and prints a
 * multi-line neon "heads-up display": model, reasoning effort, context window,
 * 5h/7d rate limits, session time, cost, git branch and line changes — with
 * threshold colors, a gradient context bar, and graceful fallbacks.
 *
 * Repo:    https://github.com/anupm-sinha/PRISM
 * License: MIT
 *
 * Usage (configured by Claude Code automatically, but you can test it):
 *   echo '{"model":{"id":"claude-opus-4-8"}}' | node prism.mjs
 *   node prism.mjs --demo        # render sample data in every theme
 *   node prism.mjs --help
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const VERSION = '1.1.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────────────────────────────────────────── ANSI helpers ──
const ESC = '\x1b[';
const RESET = ESC + '0m';
const BOLD = ESC + '1m';

/** Truecolor foreground escape from an [r,g,b] triple. */
function fg(rgb) { return `${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`; }
/** Paint `text` in `rgb`, optionally bold, and reset afterward. */
function paint(text, rgb, bold = false) { return (bold ? BOLD : '') + fg(rgb) + text + RESET; }

/** Linear-interpolate a string's color from `a` to `b`, per character. */
function gradientText(str, a, b) {
  const chars = [...str];
  if (chars.length === 0) return '';
  const n = Math.max(chars.length - 1, 1);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const t = i / n;
    const rgb = [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * t));
    out += fg(rgb) + chars[i];
  }
  return out + RESET;
}

/** Visible width of a string: strips ANSI, counts wide glyphs (emoji/CJK) as 2. */
function visLen(str) {
  const plain = str
    .replace(/\x1b\[[0-9;]*m/g, '')                  // SGR colors
    .replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, ''); // OSC-8 hyperlinks
  let w = 0;
  for (const ch of plain) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

// Symbols in the BMP that carry emoji presentation and render double-width
// (e.g. ⚡ U+26A1). Text-presentation dingbats like ✳ U+2733 stay single-width.
const EMOJI2 = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe,
  0x2614, 0x2615, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f,
  0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd,
  0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa,
  0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755,
  0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
]);

function isWide(cp) {
  if (cp >= 0x1100 && cp <= 0x115f) return true;          // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) return true; // CJK & friends
  if (cp >= 0xac00 && cp <= 0xd7a3) return true;          // Hangul syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return true;          // CJK compatibility
  if (cp >= 0xfe30 && cp <= 0xfe4f) return true;          // CJK compat forms
  if ((cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) return true; // fullwidth
  if (cp >= 0x1f000 && cp <= 0x1faff) return true;        // emoji & symbol planes
  if (cp >= 0x20000 && cp <= 0x3fffd) return true;        // CJK extensions
  return EMOJI2.has(cp);
}

// ─────────────────────────────────────────────────────────────────── Themes ──
// Each role is an [r,g,b] triple. `ctxFrom`/`ctxTo` drive the gradient context
// bar; `effort` maps reasoning levels to a color.
const THEMES = {
  neon: {
    frame: [58, 53, 102], dim: [90, 99, 126], label: [123, 133, 153], text: [201, 209, 217],
    brand: [79, 240, 255], model: [255, 95, 210],
    ctxFrom: [150, 80, 255], ctxTo: [221, 100, 255], ctxEmpty: [35, 40, 59],   // purple → magenta
    healthy: [84, 248, 160], warn: [255, 180, 84], crit: [255, 95, 109],
    cost: [84, 248, 160], branch: [183, 148, 255], add: [84, 248, 160], del: [98, 107, 134],
    time: [170, 180, 207], accent: [79, 240, 255],
    effort: { low: [123, 133, 153], medium: [79, 240, 255], high: [255, 224, 102], xhigh: [255, 180, 84], max: [255, 95, 109] },
  },
  spectrum: {
    frame: [68, 80, 107], dim: [86, 96, 122], label: [125, 133, 150], text: [201, 209, 217],
    brand: [129, 219, 255], model: [199, 146, 234],
    ctxFrom: [40, 199, 255], ctxTo: [37, 99, 235], ctxEmpty: [43, 49, 64],
    healthy: [63, 185, 80], warn: [210, 153, 34], crit: [248, 81, 73],
    cost: [126, 231, 135], branch: [88, 166, 255], add: [63, 185, 80], del: [110, 118, 129],
    time: [173, 186, 199], accent: [88, 166, 255],
    effort: { low: [110, 118, 129], medium: [88, 166, 255], high: [210, 153, 34], xhigh: [219, 109, 40], max: [248, 81, 73] },
  },
  mono: {
    frame: [68, 76, 94], dim: [110, 118, 129], label: [139, 148, 158], text: [201, 209, 217],
    brand: [150, 200, 255], model: [220, 226, 234],
    ctxFrom: [120, 170, 220], ctxTo: [170, 205, 245], ctxEmpty: [40, 45, 58],
    healthy: [142, 178, 160], warn: [196, 170, 120], crit: [206, 130, 130],
    cost: [170, 200, 180], branch: [150, 160, 180], add: [150, 180, 160], del: [100, 108, 120],
    time: [165, 174, 188], accent: [120, 200, 255],
    effort: { low: [110, 118, 129], medium: [150, 200, 255], high: [196, 170, 120], xhigh: [200, 150, 110], max: [206, 130, 130] },
  },
};

// ─────────────────────────────────────────────────────────────── Glyph sets ──
const GLYPHS = {
  unicode: { brand: '✳', effort: '⚡', clock: '◷', branch: '⎇', barL: '▕', barR: '▏', fill: '█', empty: '░', add: '+', del: '−', reset: '⟳', sep: '·', pr: '⬡', think: '✦', token: '◈', cache: '≣', ver: '●', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  ascii:   { brand: '*', effort: '!', clock: 't', branch: 'on', barL: '[', barR: ']', fill: '#', empty: '-', add: '+', del: '-', reset: '~', sep: '|', pr: 'PR', think: '*', token: 'T', cache: 'C', ver: 'v', tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  // Nerd Font (Powerline + Font Awesome + Octicons codepoints). Requires a Nerd Font.
  nerd:    { brand: '', effort: '', clock: '', branch: '', barL: '', barR: '', fill: '█', empty: '░', add: '', del: '', reset: '', sep: '·', pr: '', think: '', token: '', cache: '', ver: '', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
};

function resolveGlyphs(mode) {
  let m = (mode || 'auto').toLowerCase();
  if (m === 'auto') {
    const hint = (process.env.PRISM_GLYPHS || '').toLowerCase();
    m = (hint === 'nerd' || hint === 'ascii' || hint === 'unicode') ? hint : 'unicode';
  }
  return GLYPHS[m] || GLYPHS.unicode;
}

// ─────────────────────────────────────────────────────────────── Defaults ──
const DEFAULTS = {
  theme: 'neon',
  glyphs: 'auto',           // auto | nerd | unicode | ascii
  spacing: 5,               // spaces between info groups (breathing room)
  minWidth: 60,             // minimum panel width — keeps it from rendering tiny on first load
  barWidth: 16,             // context bar width in cells
  smallBarWidth: 6,         // 5h / 7d bar width
  thresholds: { warn: 70, crit: 90 },      // context %
  rateThresholds: { warn: 60, crit: 80 },  // rate-limit %
  stats: {
    model: true, effort: true, context: true,
    fiveHour: true, sevenDay: true,
    fiveHourReset: true, sevenDayReset: true,
    session: true, cost: true, branch: true, lines: true,
    tokens: true, cache: true, apiTime: false,
    directory: false, version: false, pr: false, thinking: false,
  },
};

// ─────────────────────────────────────────────────────────────── Config I/O ──
/** Strip // line and block comments and trailing commas from JSONC. */
function stripJsonc(src) {
  let out = '', inStr = false, strCh = '', inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === '\\') { out += (n ?? ''); i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = isObj(base?.[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

function findConfig() {
  const c = [];
  if (process.env.PRISM_CONFIG) c.push(process.env.PRISM_CONFIG);
  c.push(path.join(__dirname, 'prism.config.jsonc'));
  c.push(path.join(os.homedir(), '.claude', 'prism', 'prism.config.jsonc'));
  c.push(path.join(process.cwd(), 'prism.config.jsonc'));
  for (const f of c) { try { if (f && fs.existsSync(f)) return f; } catch { /* ignore */ } }
  return null;
}

function loadConfig() {
  const file = findConfig();
  if (!file) return DEFAULTS;
  try {
    const parsed = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
    return deepMerge(DEFAULTS, parsed);
  } catch {
    return DEFAULTS; // never break the status line over a bad config
  }
}

// ─────────────────────────────────────────────────────── Data extraction ──
function modelName(input) {
  const dn = input?.model?.display_name;
  const id = input?.model?.id || '';
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return dn || 'Claude';
}

function contextPct(input) {
  const cw = input?.context_window || {};
  if (typeof cw.used_percentage === 'number') return cw.used_percentage;
  const u = cw.current_usage;
  if (u && cw.context_window_size) {
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    return (used / cw.context_window_size) * 100;
  }
  return 0;
}

function cachePct(input) {
  const u = input?.context_window?.current_usage;
  if (!u) return null;
  const tot = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return tot ? (u.cache_read_input_tokens || 0) / tot * 100 : null;
}

function fmtDur(ms) {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function fmtReset(epoch) {
  if (!epoch) return '';
  const ms = epoch * 1000 - Date.now();
  return ms <= 0 ? 'now' : fmtDur(ms);
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
  return String(n);
}

/** Current git branch, cached per session in tmp to stay fast across calls. */
function gitBranch(cwd, sessionId) {
  const cache = path.join(os.tmpdir(), `prism-git-${(sessionId || 'x').replace(/[^\w-]/g, '')}.txt`);
  try {
    const st = fs.statSync(cache);
    if (Date.now() - st.mtimeMs < 4000) return fs.readFileSync(cache, 'utf8').trim();
  } catch { /* miss */ }
  let branch = '';
  try {
    branch = execSync('git branch --show-current', {
      cwd: cwd || process.cwd(), timeout: 800, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch { branch = ''; }
  try { fs.writeFileSync(cache, branch); } catch { /* ignore */ }
  return branch;
}

// ───────────────────────────────────────────────────────────────── Render ──
// Left-aligned eighth blocks give sub-cell resolution for smooth fills.
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
function meter(pct, width, from, to, empty, g, gradient) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const usePartial = g.fill === '█';
  const exact = (p / 100) * width;
  let full = Math.floor(exact);
  let part = '';
  if (usePartial && full < width) {
    const idx = Math.round((exact - full) * 8);
    if (idx === 8) full += 1;
    else if (idx > 0) part = PARTIAL[idx];
  }
  if (full > width) full = width;
  const fillChars = g.fill.repeat(full) + part;
  const emp = g.empty.repeat(Math.max(0, width - full - (part ? 1 : 0)));
  const fStr = gradient ? gradientText(fillChars, from, to) : paint(fillChars, from);
  return fStr + paint(emp, empty);
}

function thresholdRgb(pct, t, warn, crit) {
  if (pct >= crit) return t.crit;
  if (pct >= warn) return t.warn;
  return t.healthy;
}

/** Build the rendered status line(s) as a single string. */
function render(input, cfg) {
  const t = THEMES[cfg.theme] || THEMES.neon;
  const g = resolveGlyphs(cfg.glyphs);
  const s = cfg.stats;
  const gap = ' '.repeat(Math.max(1, cfg.spacing | 0));

  const cwd = input?.workspace?.current_dir || input?.cwd || process.cwd();
  const data = {
    model: modelName(input),
    effort: input?.effort?.level || null,
    thinking: !!input?.thinking?.enabled,
    ctx: contextPct(input),
    five: input?.rate_limits?.five_hour?.used_percentage,
    fiveReset: input?.rate_limits?.five_hour?.resets_at,
    seven: input?.rate_limits?.seven_day?.used_percentage,
    sevenReset: input?.rate_limits?.seven_day?.resets_at,
    durMs: input?.cost?.total_duration_ms,
    apiMs: input?.cost?.total_api_duration_ms,
    cost: input?.cost?.total_cost_usd,
    added: input?.cost?.total_lines_added || 0,
    removed: input?.cost?.total_lines_removed || 0,
    tokens: input?.context_window?.total_input_tokens,
    cache: cachePct(input),
    dir: path.basename(cwd || '') || cwd,
    version: input?.version,
    pr: input?.pr,
  };

  // Identity (title) pieces.
  const brandModel = paint(g.brand, t.brand) + ' ' + paint(data.model, t.model, true)
    + (s.thinking && data.thinking ? ' ' + paint(g.think, t.accent) : '');
  let effortStr = '';
  if (s.effort && data.effort) {
    const ec = t.effort[data.effort] || t.dim;
    effortStr = paint(`${g.effort} ${data.effort}`, ec, true);
  }

  // Bar segment builder. Nerd Font mode gets rounded "pill" caps; others get
  // thin caps. Fills are smooth thanks to sub-cell partial blocks in meter().
  const rounded = g === GLYPHS.nerd;
  const capL = rounded ? '' : g.barL;   //  left half-circle
  const capR = rounded ? '' : g.barR;   //  right half-circle
  const barSeg = (label, pct, width, from, to, gradient, pctRgb) =>
    paint(label, t.label) + ' ' +
    paint(capL, rounded ? (pct > 0 ? from : t.ctxEmpty) : t.dim) +
    meter(pct, width, from, to, t.ctxEmpty, g, gradient) +
    paint(capR, rounded ? t.ctxEmpty : t.dim) + ' ' +
    paint(`${Math.round(pct)}%`, pctRgb);

  // Row 2: context + rate-limit meters (with optional reset countdowns).
  const row2 = [];
  if (s.context) {
    row2.push(barSeg('ctx', data.ctx, cfg.barWidth, t.ctxFrom, t.ctxTo, true,
      thresholdRgb(data.ctx, t, cfg.thresholds.warn, cfg.thresholds.crit)));
  }
  if (s.fiveHour && typeof data.five === 'number') {
    const c = thresholdRgb(data.five, t, cfg.rateThresholds.warn, cfg.rateThresholds.crit);
    let seg = barSeg('5h', data.five, cfg.smallBarWidth, c, c, false, c);
    if (s.fiveHourReset && data.fiveReset) seg += ' ' + paint(`${g.reset} ${fmtReset(data.fiveReset)}`, t.dim);
    row2.push(seg);
  }
  if (s.sevenDay && typeof data.seven === 'number') {
    const c = thresholdRgb(data.seven, t, cfg.rateThresholds.warn, cfg.rateThresholds.crit);
    let seg = barSeg('7d', data.seven, cfg.smallBarWidth, c, c, false, c);
    if (s.sevenDayReset && data.sevenReset) seg += ' ' + paint(`${g.reset} ${fmtReset(data.sevenReset)}`, t.dim);
    row2.push(seg);
  }

  // Row 3: session, cost, tokens, cache, git and meta.
  const row3 = [];
  if (s.session && data.durMs != null) row3.push(paint(g.clock, t.dim) + ' ' + paint(fmtDur(data.durMs), t.time));
  if (s.cost && data.cost != null) row3.push(paint(`$${Number(data.cost).toFixed(2)}`, t.cost));
  if (s.tokens && data.tokens) row3.push(paint(g.token, t.dim) + ' ' + paint(fmtTokens(data.tokens), t.text));
  if (s.cache && data.cache != null) row3.push(paint('cache', t.label) + ' ' + paint(`${Math.round(data.cache)}%`, t.accent));
  if (s.apiTime && data.apiMs) row3.push(paint('api', t.label) + ' ' + paint(fmtDur(data.apiMs), t.dim));
  if (s.branch) {
    const b = data.dir && input?.workspace ? gitBranch(cwd, input?.session_id) : '';
    if (b) row3.push(paint(g.branch + ' ' + b, t.branch));
  }
  if (s.lines && (data.added || data.removed)) {
    row3.push(paint(`${g.add}${data.added}`, t.add) + ' ' + paint(`${g.del}${data.removed}`, t.del));
  }
  if (s.directory) row3.push(paint(data.dir, t.dim));
  if (s.version && data.version) row3.push(paint(`${g.ver}${data.version}`, t.dim));
  if (s.pr && data.pr?.number) {
    const rc = data.pr.review_state === 'approved' ? t.healthy
      : data.pr.review_state === 'changes_requested' ? t.crit : t.warn;
    row3.push(paint(`${g.pr} #${data.pr.number}`, t.accent) +
      (data.pr.review_state ? ' ' + paint(data.pr.review_state, rc) : ''));
  }

  const railRaw = g.v + '  ';
  const line2 = row2.length ? paint(g.v, t.frame) + '  ' + row2.join(gap) : '';
  const line3 = row3.length ? paint(g.v, t.frame) + '  ' + row3.join(gap) : '';

  // Width-aware sizing, with a sensible minimum so the panel never renders tiny
  // (e.g. on first load, before context/limits/cost data has arrived).
  const cols = parseInt(process.env.COLUMNS || '', 10) || 0;
  const contentW = Math.max(
    line2 ? visLen(railRaw) + visLen(row2.join(gap)) : 0,
    line3 ? visLen(railRaw) + visLen(row3.join(gap)) : 0,
  );
  const titleMin = 8 + visLen(brandModelPlain(data, g, s)) + (effortStr ? visLen(`${g.effort} ${data.effort}`) : 0) + 2;
  const floorW = cols ? Math.min(cfg.minWidth || 0, cols - 2) : (cfg.minWidth || 0);
  let panelW = Math.max(contentW + 3, titleMin, floorW);
  if (cols && panelW > cols - 1) return compact(data, t, g, s, cfg, gap);

  // Title rule with effort pinned to the right.
  const bmW = visLen(brandModelPlain(data, g, s));
  let top;
  if (effortStr) {
    const efW = visLen(`${g.effort} ${data.effort}`);
    const k = Math.max(2, panelW - 8 - bmW - efW);
    top = paint(g.tl + g.h + ' ', t.frame) + brandModel + ' ' +
      paint(g.h.repeat(k), t.frame) + ' ' + effortStr + paint(' ' + g.h + g.tr, t.frame);
  } else {
    const k = Math.max(2, panelW - 4 - bmW - 1);
    top = paint(g.tl + g.h + ' ', t.frame) + brandModel + ' ' + paint(g.h.repeat(k) + g.tr, t.frame);
  }
  const bottom = paint(g.bl + g.h.repeat(Math.max(2, panelW - 2)) + g.br, t.frame);

  return [top, line2, line3, bottom].filter(Boolean).join('\n');
}

/** Visible model+brand text without color, for width math. */
function brandModelPlain(data, g, s) {
  return `${g.brand} ${data.model}` + (s.thinking && data.thinking ? ` ${g.think}` : '');
}

/** Single-line fallback for narrow terminals. */
function compact(data, t, g, s, cfg, gap) {
  const parts = [];
  parts.push(paint(g.brand, t.brand) + ' ' + paint(data.model, t.model, true));
  if (s.effort && data.effort) parts.push(paint(`${g.effort}${data.effort}`, t.effort[data.effort] || t.dim));
  if (s.context) {
    const pc = thresholdRgb(data.ctx, t, cfg.thresholds.warn, cfg.thresholds.crit);
    parts.push(paint('ctx', t.label) + ' ' + paint(`${Math.round(data.ctx)}%`, pc));
  }
  if (s.fiveHour && typeof data.five === 'number')
    parts.push(paint('5h', t.label) + ' ' + paint(`${Math.round(data.five)}%`, thresholdRgb(data.five, t, cfg.rateThresholds.warn, cfg.rateThresholds.crit)));
  if (s.sevenDay && typeof data.seven === 'number')
    parts.push(paint('7d', t.label) + ' ' + paint(`${Math.round(data.seven)}%`, thresholdRgb(data.seven, t, cfg.rateThresholds.warn, cfg.rateThresholds.crit)));
  if (s.cost && data.cost != null) parts.push(paint(`$${Number(data.cost).toFixed(2)}`, t.cost));
  if (s.lines && (data.added || data.removed)) parts.push(paint(`${g.add}${data.added}`, t.add) + paint(`${g.del}${data.removed}`, t.del));
  return parts.join('  ' + paint(g.sep, t.frame) + '  ');
}

// ──────────────────────────────────────────────────────────── CLI plumbing ──
// ──────────────────────────────────────────────────────────── Self-install ──
function settingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }

function doInstall() {
  const sp = settingsPath();
  let settings = {};
  try { settings = JSON.parse(stripJsonc(fs.readFileSync(sp, 'utf8'))); } catch { settings = {}; }
  let backed = false;
  try { if (fs.existsSync(sp)) { fs.copyFileSync(sp, sp + '.prism-backup'); backed = true; } } catch { /* ignore */ }
  const scriptPath = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  settings.statusLine = { type: 'command', command: `node "${scriptPath}"`, padding: 1 };
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✳ PRISM installed — statusLine → node "${scriptPath}"`);
  console.log(`  Settings: ${sp}${backed ? `  (backup saved alongside)` : ''}`);
  console.log('  Restart Claude Code to see it. Nerd Font users: set "glyphs":"nerd" in prism.config.jsonc.');
}

function doUninstall() {
  const sp = settingsPath();
  try {
    const settings = JSON.parse(stripJsonc(fs.readFileSync(sp, 'utf8')));
    delete settings.statusLine;
    fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
    console.log('✳ PRISM removed from statusLine.');
  } catch { console.log('Nothing to uninstall (no settings.json statusLine found).'); }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function printHelp() {
  console.log(`PRISM ${VERSION} — a colorful HUD status line for Claude Code

USAGE
  <claude-json> | node prism.mjs     Render the status line (Claude Code does this)
  node prism.mjs --demo              Preview sample data in every theme
  node prism.mjs --help              Show this help
  node prism.mjs --version           Print version
  node prism.mjs --install           Set PRISM as your Claude Code statusLine
  node prism.mjs --uninstall         Remove PRISM from your statusLine

CONFIG  (first found wins; all fields optional)
  $PRISM_CONFIG, ./prism.config.jsonc (next to script),
  ~/.claude/prism/prism.config.jsonc, ./prism.config.jsonc (cwd)

  theme: neon | spectrum | mono      glyphs: auto | nerd | unicode | ascii
  Per-stat toggles, thresholds, spacing and bar widths — see prism.config.jsonc.

  Tip: set PRISM_GLYPHS=nerd if you run a Nerd Font.`);
}

const DEMO_INPUT = {
  session_id: 'demo', version: '2.1.90',
  model: { id: 'claude-opus-4-8', display_name: 'Opus' },
  workspace: { current_dir: 'home/dev/UtilityKit' },
  effort: { level: 'high' }, thinking: { enabled: true },
  cost: { total_cost_usd: 1.2734, total_duration_ms: 1_080_000, total_api_duration_ms: 92_000, total_lines_added: 156, total_lines_removed: 23 },
  context_window: { total_input_tokens: 76000, context_window_size: 200000, used_percentage: 38, current_usage: { input_tokens: 12000, cache_creation_input_tokens: 9000, cache_read_input_tokens: 55000 } },
  rate_limits: { five_hour: { used_percentage: 24, resets_at: Math.floor(Date.now() / 1000) + 9000 }, seven_day: { used_percentage: 41, resets_at: Math.floor(Date.now() / 1000) + 380000 } },
};

function runDemo(cfg) {
  for (const theme of ['neon', 'spectrum', 'mono']) {
    process.stdout.write(`\n  ${BOLD}${theme}${RESET}\n\n`);
    process.stdout.write(render({ ...DEMO_INPUT }, { ...cfg, theme, stats: { ...DEFAULTS.stats } }) + '\n');
  }
  process.stdout.write('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return printHelp();
  if (args.includes('--version') || args.includes('-v')) return console.log(`PRISM ${VERSION}`);
  if (args.includes('--install')) return doInstall();
  if (args.includes('--uninstall')) return doUninstall();
  const cfg = loadConfig();
  if (args.includes('--demo')) return runDemo(cfg);
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch { input = {}; }
  try {
    process.stdout.write(render(input, cfg) + '\n');
  } catch (e) {
    // Last-resort fallback: never leave the status line blank.
    process.stdout.write(`✳ ${modelName(input)}\n`);
  }
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isMain) main();

export {
  render, compact, meter, gradientText, visLen, isWide, modelName, contextPct, cachePct,
  fmtDur, fmtReset, fmtTokens, stripJsonc, deepMerge, resolveGlyphs, thresholdRgb,
  THEMES, GLYPHS, DEFAULTS, VERSION,
};
