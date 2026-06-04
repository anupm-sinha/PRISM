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
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const VERSION = '1.13.0';
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
    frame: [58, 53, 102], dim: [90, 99, 126], faint: [70, 67, 100], label: [123, 133, 153], text: [201, 209, 217],
    brand: [79, 240, 255], model: [255, 95, 210],
    ctxFrom: [150, 80, 255], ctxTo: [221, 100, 255], ctxEmpty: [35, 40, 59],   // purple → magenta
    healthy: [84, 248, 160], warn: [255, 180, 84], crit: [255, 95, 109],
    cost: [84, 248, 160], branch: [183, 148, 255], add: [84, 248, 160], del: [98, 107, 134],
    time: [170, 180, 207], accent: [79, 240, 255],
    effort: { low: [123, 133, 153], medium: [79, 240, 255], high: [255, 224, 102], xhigh: [255, 180, 84], max: [255, 95, 109] },
  },
  spectrum: {
    frame: [68, 80, 107], dim: [86, 96, 122], faint: [72, 80, 104], label: [125, 133, 150], text: [201, 209, 217],
    brand: [129, 219, 255], model: [199, 146, 234],
    ctxFrom: [40, 199, 255], ctxTo: [37, 99, 235], ctxEmpty: [43, 49, 64],
    healthy: [63, 185, 80], warn: [210, 153, 34], crit: [248, 81, 73],
    cost: [126, 231, 135], branch: [88, 166, 255], add: [63, 185, 80], del: [110, 118, 129],
    time: [173, 186, 199], accent: [88, 166, 255],
    effort: { low: [110, 118, 129], medium: [88, 166, 255], high: [210, 153, 34], xhigh: [219, 109, 40], max: [248, 81, 73] },
  },
  mono: {
    frame: [68, 76, 94], dim: [110, 118, 129], faint: [82, 88, 102], label: [139, 148, 158], text: [201, 209, 217],
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
  nerd:    { brand: '', effort: '', clock: '', branch: '', barL: '', barR: '', fill: '█', empty: '░', add: '+', del: '−', reset: '', sep: '·', pr: '', think: '', token: '', cache: '', ver: '', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
};

// Per-field markers for icon mode (the meter/cost labels). Added separately so the
// Nerd Font codepoints use explicit escapes and don't disturb the sets above.
// Unicode/ASCII keep short text where no well-supported glyph exists (cost reads
// from its own "$"); Nerd Font gets a distinct icon for every field.
Object.assign(GLYPHS.unicode, { ctx: 'ctx', five: '5h', seven: '7d', cost: '' });
Object.assign(GLYPHS.ascii,   { ctx: 'ctx', five: '5h', seven: '7d', cost: '' });
Object.assign(GLYPHS.nerd,    { ctx: '', five: '', seven: '', cost: '' }); // gauge · hourglass · calendar · dollar

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
  labels: 'text',           // "text" (worded: 5h Usage, Cost, …) or "icon" (compact glyphs)
  align: false,             // align row 2 & row 3 into shared columns (grid)
  spacing: 5,               // spaces between info groups (breathing room)
  minWidth: 60,             // minimum panel width — keeps it from rendering tiny on first load
  barStyle: 'pill',         // "block" (█), "rounded" (◖█◗), "pill" (slim ▬), or "line" (thin ━)
  barWidth: 16,             // context bar width in cells
  smallBarWidth: 6,         // 5h / 7d bar width
  thresholds: { warn: 70, crit: 90 },      // context %
  rateThresholds: { warn: 60, crit: 80 },  // rate-limit %
  checkUpdate: true,        // dot by the version checks npm for a newer Claude Code (hourly); set false to stay fully offline
  stats: {
    model: true, effort: true, context: true,
    fiveHour: true, sevenDay: true,
    fiveHourReset: false, sevenDayReset: false,
    session: true, cost: true, branch: true, lines: true,
    tokens: true, cache: true, apiTime: false,
    directory: false, version: true, pr: false, thinking: false,
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

/** Set `"key": "value"` in JSONC source — replaces an existing string value or inserts it. Comments survive. */
function setJsoncValue(src, key, value) {
  const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  if (re.test(src)) return src.replace(re, `$1"${value}"`);
  return src.replace(/\{/, `{\n  "${key}": "${value}",`);
}

/** The config file PRISM writes to: the first one it finds, else the standard install path. */
function writableConfigPath() {
  return findConfig() || path.join(os.homedir(), '.claude', 'prism', 'prism.config.jsonc');
}

/** Apply key→value updates to the writable config (backs it up first). Returns the path written. */
function updateConfigFile(updates) {
  const file = writableConfigPath();
  let src = '{\n}\n';
  try { src = fs.readFileSync(file, 'utf8'); } catch { /* will create */ }
  for (const [k, v] of Object.entries(updates)) src = setJsoncValue(src, k, v);
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch { /* ignore */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, src);
  return file;
}

/**
 * Insert keys present in `defaults` but missing from JSONC `src`, preserving the
 * user's existing values, comments and formatting. Handles top-level keys and one
 * level of nesting (e.g. new entries under `stats`). Returns `{ text, added }`,
 * where `added` lists the dotted names inserted (empty → nothing changed).
 */
function syncConfigText(src, defaults) {
  let parsed;
  try { parsed = JSON.parse(stripJsonc(src)); } catch { parsed = {}; }
  const added = [];
  let out = src;
  const insertTop = (s, k, v) => s.replace(/\{/, `{\n  "${k}": ${JSON.stringify(v)},`);
  const insertNested = (s, p, k, v) =>
    s.replace(new RegExp(`("${p}"\\s*:\\s*\\{)`), `$1\n    "${k}": ${JSON.stringify(v)},`);
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in parsed)) { out = insertTop(out, k, v); added.push(k); }
  }
  for (const [k, v] of Object.entries(defaults)) {
    if (isObj(v) && isObj(parsed[k])) {
      for (const [sk, sv] of Object.entries(v)) {
        if (!(sk in parsed[k])) { out = insertNested(out, k, sk, sv); added.push(`${k}.${sk}`); }
      }
    }
  }
  return { text: out, added };
}

/**
 * Upgrade path: bring an installed config up to date with the current DEFAULTS by
 * adding any new options, without touching the user's existing values. A `.bak` is
 * kept only when something actually changes. `target`/`defaults`/`log` are
 * injectable for testing. Returns `{ file, added }`.
 */
function doSyncConfig(opts = {}) {
  const target = opts.target || writableConfigPath();
  const defaults = opts.defaults || DEFAULTS;
  const log = opts.log || console.log;
  let src = '{\n}\n';
  try { src = fs.readFileSync(target, 'utf8'); } catch { /* will create */ }
  const { text, added } = syncConfigText(src, defaults);
  if (!added.length) {
    log(`✳ PRISM config already up to date — ${target}`);
    return { file: target, added };
  }
  try { if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak'); } catch { /* ignore */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  log(`✳ PRISM config synced (+${added.length}: ${added.join(', ')}) — ${target}`);
  return { file: target, added };
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

/** Hours until `epoch` reset, as a parenthesised "(~Nh)" / "(<1h)" hint ('' if past/unknown). */
function fmtHoursLeft(epoch) {
  if (!epoch) return '';
  const ms = epoch * 1000 - Date.now();
  if (ms <= 0) return '';
  const h = ms / 3_600_000;
  return h < 1 ? '(<1h)' : `(~${Math.round(h)}h)`;
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

/**
 * 5h/7d rate-limit usage. Claude Code may omit `rate_limits` on early renders
 * (e.g. first load), so we cache the last-known values per session in tmp and
 * reuse them when a later payload arrives without them.
 */
function rateLimits(input, sessionId) {
  const cur = input?.rate_limits || {};
  const live = {
    five: cur.five_hour?.used_percentage,
    fiveReset: cur.five_hour?.resets_at,
    seven: cur.seven_day?.used_percentage,
    sevenReset: cur.seven_day?.resets_at,
  };
  const have = typeof live.five === 'number' || typeof live.seven === 'number';
  if (!sessionId) return live;   // no session key → don't read or write the cache
  const cache = path.join(os.tmpdir(), `prism-rate-${sessionId.replace(/[^\w-]/g, '')}.json`);
  if (have) {
    try { fs.writeFileSync(cache, JSON.stringify(live)); } catch { /* ignore */ }
    return live;
  }
  try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* miss */ }
  return live;
}

// ──────────────────────────────────────────────── Claude Code update check ──
// Optional, off-the-render-path: we look up the latest published Claude Code
// version on npm (cached 1h) so the version dot can flag when an update exists.
const CC_VERSION_CACHE = path.join(os.homedir(), '.claude', 'prism', '.cc-version-cache.json');
const CC_VERSION_TTL_MS = 3_600_000; // 1 hour

/** Latest known Claude Code version from the local cache (null if none). */
function ccLatestVersion() {
  try { return JSON.parse(fs.readFileSync(CC_VERSION_CACHE, 'utf8')).latest || null; }
  catch { return null; }
}

/** GET the latest @anthropic-ai/claude-code version from npm (resolves null on any failure). */
function fetchCcLatest(timeoutMs = 2000) {
  return new Promise((resolve) => {
    try {
      const req = https.request({
        hostname: 'registry.npmjs.org', path: '/@anthropic-ai/claude-code/latest',
        method: 'GET', headers: { Accept: 'application/json' }, timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 200) { try { resolve(JSON.parse(data).version || null); } catch { resolve(null); } }
          else resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

/**
 * Refresh the cached Claude Code version if it's older than the TTL. Always
 * bumps the timestamp (even on failure) so we retry at most once per TTL, and
 * keeps the last-known value when offline. Injectable for testing.
 */
async function refreshCcVersion(opts = {}) {
  const cachePath = opts.cachePath || CC_VERSION_CACHE;
  const fetchLatest = opts.fetchLatest || fetchCcLatest;
  const now = opts.now || Date.now();
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* none */ }
  if (prev && now - prev.ts < CC_VERSION_TTL_MS) return prev.latest || null;
  const latest = await fetchLatest();
  const next = { ts: now, latest: latest ?? prev?.latest ?? null };
  try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(next)); } catch { /* ignore */ }
  return next.latest;
}

/** Dot color for the version: warn if an update exists, healthy if current/unknown, dim if checking is off. */
function updateDotRgb(running, latest, t, check) {
  if (!check) return t.dim;
  if (running && latest && running !== latest) return t.warn;
  return t.healthy;
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
  if (!usePartial && p > 0 && full === 0) full = 1;   // min visible fill for line/pill bars
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
  const rl = rateLimits(input, input?.session_id);
  const data = {
    model: modelName(input),
    effort: input?.effort?.level || null,
    thinking: !!input?.thinking?.enabled,
    ctx: contextPct(input),
    five: rl.five,
    fiveReset: rl.fiveReset,
    seven: rl.seven,
    sevenReset: rl.sevenReset,
    durMs: input?.cost?.total_duration_ms,
    apiMs: input?.cost?.total_api_duration_ms,
    cost: input?.cost?.total_cost_usd,
    added: input?.cost?.total_lines_added || 0,
    removed: input?.cost?.total_lines_removed || 0,
    tokens: input?.context_window?.total_input_tokens,
    cache: cachePct(input),
    dir: path.basename(cwd || '') || cwd,
    version: input?.version,
    ccLatest: ccLatestVersion(),
    pr: input?.pr,
  };

  // Identity (title) pieces.
  const verDot = updateDotRgb(data.version, data.ccLatest, t, cfg.checkUpdate !== false);
  const brandModel = paint(g.brand, t.brand) + '  ' + paint(data.model, t.model, true)
    + (s.version && data.version ? '  ' + paint(g.ver, verDot) + ' ' + paint(`v${data.version}`, t.label) : '')
    + (s.thinking && data.thinking ? ' ' + paint(g.think, t.accent) : '');
  let effortStr = '';
  if (s.effort && data.effort) {
    const ec = t.effort[data.effort] || t.dim;
    effortStr = paint(`${g.effort} ${data.effort}`, ec, true);
  }

  // Bar segment builder. Nerd Font mode gets rounded "pill" caps; others get
  // thin caps. Fills are smooth thanks to sub-cell partial blocks in meter().
  const rounded = g === GLYPHS.nerd;
  const lineStyle = cfg.barStyle === 'line';
  const pillStyle = cfg.barStyle === 'pill';
  const roundedStyle = cfg.barStyle === 'rounded';
  const roundedCaps = rounded || roundedStyle;
  const barG = lineStyle ? { ...g, fill: '━', empty: '─' }
    : pillStyle ? { ...g, fill: '▬', empty: '▬' } : g;
  const capL = rounded ? '' : g.barL;   //  left half-circle
  const capR = rounded ? '' : g.barR;   //  right half-circle
  const pcapL = roundedStyle ? '◖' : (pillStyle ? '' : capL);
  const pcapR = roundedStyle ? '◗' : (pillStyle ? '' : capR);
  const barSeg = (label, pct, width, from, to, gradient, pctRgb, extra = '') =>
    paint(label, t.label) + ' ' +
    (lineStyle ? '' : paint(pcapL, roundedCaps ? (pct > 0 ? from : t.ctxEmpty) : t.dim)) +
    meter(pct, width, from, to, t.ctxEmpty, barG, gradient) +
    (lineStyle ? '' : paint(pcapR, roundedCaps ? t.ctxEmpty : t.dim)) + ' ' +
    paint(`${Math.round(pct)}%`, pctRgb) + extra;
  // Placeholder for a meter whose data hasn't arrived yet: empty track + dim em dash.
  const barPlaceholder = (label, width) =>
    paint(label, t.label) + ' ' +
    (lineStyle ? '' : paint(pcapL, t.dim)) +
    meter(0, width, t.dim, t.dim, t.ctxEmpty, barG, false) +
    (lineStyle ? '' : paint(pcapR, t.dim)) + ' ' +
    paint('—', t.dim);

  const textLabels = cfg.labels === 'text';
  // Leading marker for a segment: a worded label (text mode) or a glyph (icon mode).
  const lead = (word, glyph, glyphColor = t.dim) =>
    textLabels ? paint(word, t.label) : paint(glyph, glyphColor);

  // Row 2: context + rate-limit meters (with optional reset countdowns).
  const row2 = [];
  if (s.context) {
    row2.push(barSeg(textLabels ? 'Context' : g.ctx, data.ctx, cfg.barWidth, t.ctxFrom, t.ctxTo, true,
      thresholdRgb(data.ctx, t, cfg.thresholds.warn, cfg.thresholds.crit), ' ' + paint('used', t.dim)));
  }
  if (s.fiveHour) {
    if (typeof data.five === 'number') {
      const c = thresholdRgb(data.five, t, cfg.rateThresholds.warn, cfg.rateThresholds.crit);
      const hint = fmtHoursLeft(data.fiveReset);
      let seg = barSeg(textLabels ? '5h Usage' : g.five, data.five, cfg.smallBarWidth, c, c, false, c,
        hint ? ' ' + paint(hint, t.dim) : '');
      if (s.fiveHourReset && data.fiveReset) seg += ' ' + paint(`${g.reset} ${fmtReset(data.fiveReset)}`, t.dim);
      row2.push(seg);
    } else {
      row2.push(barPlaceholder(textLabels ? '5h Usage' : g.five, cfg.smallBarWidth));
    }
  }
  if (s.sevenDay) {
    if (typeof data.seven === 'number') {
      const c = thresholdRgb(data.seven, t, cfg.rateThresholds.warn, cfg.rateThresholds.crit);
      const hint = fmtHoursLeft(data.sevenReset);
      let seg = barSeg(textLabels ? '7d Usage' : g.seven, data.seven, cfg.smallBarWidth, c, c, false, c,
        hint ? ' ' + paint(hint, t.dim) : '');
      if (s.sevenDayReset && data.sevenReset) seg += ' ' + paint(`${g.reset} ${fmtReset(data.sevenReset)}`, t.dim);
      row2.push(seg);
    } else {
      row2.push(barPlaceholder(textLabels ? '7d Usage' : g.seven, cfg.smallBarWidth));
    }
  }
  if (s.cost && data.cost != null) {
    const amt = Number(data.cost).toFixed(2);
    const lbl = textLabels ? paint('Cost ', t.label) : (g.cost ? paint(g.cost + ' ', t.label) : '');
    row2.push(lbl + paint((g.cost && !textLabels) ? amt : `$${amt}`, t.cost));
  }
  if (s.tokens && data.tokens) row2.push(lead('Tokens', g.token) + ' ' + paint(fmtTokens(data.tokens), t.text));

  // Row 3 (optional second line): session, cache, git and meta.
  const row3 = [];
  if (s.session && data.durMs != null) row3.push(lead('Session', g.clock) + ' ' + paint(fmtDur(data.durMs), t.time));
  if (s.cache && data.cache != null) row3.push(paint(textLabels ? 'Cache' : g.cache, t.label) + ' ' + paint(`${Math.round(data.cache)}%`, t.accent));
  if (s.apiTime && data.apiMs) row3.push(paint(textLabels ? 'API' : 'api', t.label) + ' ' + paint(fmtDur(data.apiMs), t.dim));
  if (s.branch) {
    const b = data.dir && input?.workspace ? gitBranch(cwd, input?.session_id) : '';
    if (b) row3.push(lead('Branch', g.branch, t.branch) + ' ' + paint(b, t.branch));
  }
  if (s.lines && (data.added || data.removed)) {
    row3.push(paint(`${g.add}${data.added}`, t.add) + ' ' + paint(`${g.del}${data.removed}`, t.del));
  }
  if (s.directory) row3.push((textLabels ? paint('Dir ', t.label) : '') + paint(data.dir, t.dim));
  if (s.pr && data.pr?.number) {
    const rc = data.pr.review_state === 'approved' ? t.healthy
      : data.pr.review_state === 'changes_requested' ? t.crit : t.warn;
    row3.push(paint(`${textLabels ? 'PR' : g.pr} #${data.pr.number}`, t.accent) +
      (data.pr.review_state ? ' ' + paint(data.pr.review_state, rc) : ''));
  }

  // Optionally align the two content rows into shared columns.
  if (cfg.align && row2.length && row3.length) {
    const n = Math.max(row2.length, row3.length);
    for (let i = 0; i < n - 1; i++) {
      const w = Math.max(row2[i] != null ? visLen(row2[i]) : 0, row3[i] != null ? visLen(row3[i]) : 0);
      if (row2[i] != null) row2[i] += ' '.repeat(Math.max(0, w - visLen(row2[i])));
      if (row3[i] != null) row3[i] += ' '.repeat(Math.max(0, w - visLen(row3[i])));
    }
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
  return `${g.brand}  ${data.model}`
    + (s.version && data.version ? `  ${g.ver} v${data.version}` : '')
    + (s.thinking && data.thinking ? ` ${g.think}` : '');
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

// ─────────────────────────────────────────────────────────────── Self-update ──
const UPDATE_URL = 'https://raw.githubusercontent.com/anupm-sinha/PRISM/main/prism.mjs';

/** Download the latest prism.mjs source, verifying it looks like the real script. */
async function fetchLatestScript(fetchImpl = fetch) {
  const res = await fetchImpl(UPDATE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/const VERSION = '/.test(text)) throw new Error('unexpected response (not the PRISM script)');
  return text;
}

/**
 * Self-update: fetch the latest prism.mjs from `main` and overwrite this file
 * (a `.bak` copy is kept). Config is never touched. Returns true on success.
 * `fetch`/`target`/`log`/`err` are injectable for testing.
 */
async function doUpdate(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const target = opts.target || fileURLToPath(import.meta.url);
  const log = opts.log || console.log;
  const err = opts.err || console.error;
  const verOf = (s) => /const VERSION = '([^']+)'/.exec(s || '')?.[1];
  try {
    const text = await fetchLatestScript(fetchImpl);
    let was = null;
    try { was = verOf(fs.readFileSync(target, 'utf8')); } catch { /* fresh file */ }
    try { fs.copyFileSync(target, target + '.bak'); } catch { /* nothing to back up */ }
    fs.writeFileSync(target, text);
    const now = verOf(text) || 'latest';
    log(`✳ PRISM updated${was && was !== now ? ` ${was} → ${now}` : ` to ${now}`} — restart Claude Code to load it.`);
    return true;
  } catch (e) {
    err(`✗ Update failed: ${e.message}`);
    err('  Re-run the installer instead: https://github.com/anupm-sinha/PRISM#-install');
    process.exitCode = 1;
    return false;
  }
}

// ────────────────────────────────────────────────────── View switch & fonts ──
/** Flip the label view between 'icon' and 'text' (bare arg toggles). Edits config. */
function doSetView(arg) {
  let view = (arg || '').toLowerCase();
  if (view !== 'icon' && view !== 'text') {
    let cur = 'icon';
    try { cur = JSON.parse(stripJsonc(fs.readFileSync(writableConfigPath(), 'utf8'))).labels || 'icon'; } catch { /* default icon */ }
    view = cur === 'icon' ? 'text' : 'icon';
  }
  const file = updateConfigFile({ labels: view });
  console.log(`✳ PRISM view → ${view}   (${file})`);
  if (view === 'icon') console.log('  For the full icon set, run:  node prism.mjs --install-font');
}

// ──────────────────────────────────────────────────────────────── Preset ──
/**
 * The signature PRISM look — neon, slim pill bars, a focused stat loadout
 * (context / 5h / 7d / cost / tokens + version dot). `labels` picks worded
 * 'text' or compact 'icon'. Returns a plain config object.
 */
function presetConfig(labels = 'text') {
  const view = (labels || '').toLowerCase() === 'icon' ? 'icon' : 'text';
  return {
    theme: 'neon',
    glyphs: 'unicode',
    labels: view,
    align: false,
    spacing: 5,
    minWidth: 60,
    barStyle: 'pill',
    barWidth: 10,
    smallBarWidth: 6,
    thresholds: { warn: 70, crit: 90 },
    rateThresholds: { warn: 60, crit: 80 },
    stats: {
      model: true, effort: true, context: true,
      fiveHour: true, sevenDay: true,
      fiveHourReset: false, sevenDayReset: false,
      session: false, cost: true, branch: false, lines: false,
      tokens: true, cache: false, apiTime: false,
      directory: false, version: true, pr: false, thinking: false,
    },
  };
}

/** Render the preset as a JSONC file (comment header + pretty JSON body). */
function presetText(labels = 'text') {
  const header =
`// ╭───────────────────────────────────────────────────────────────────╮
// │  PRISM config — written by \`node prism.mjs --preset\`. This is the    │
// │  signature look. Edit freely; changes hot-reload (no restart).       │
// │  Switch labels any time:  node prism.mjs --view icon|text            │
// ╰───────────────────────────────────────────────────────────────────╯
`;
  return header + JSON.stringify(presetConfig(labels), null, 2) + '\n';
}

/**
 * Write the preset config to the writable config path (backs up any existing
 * file to `.bak` first). `target`/`log` are injectable for testing.
 * Bare arg → 'text'; 'icon' selects compact glyph labels.
 */
function doPreset(arg, opts = {}) {
  const labels = (arg || '').toLowerCase() === 'icon' ? 'icon' : 'text';
  const target = opts.target || writableConfigPath();
  const log = opts.log || console.log;
  try { if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak'); } catch { /* nothing to back up */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, presetText(labels));
  log(`✳ PRISM preset applied (${labels} labels) — ${target}`);
  log('  Hot-reloads on the next status-line refresh; no restart needed.');
  log('  Switch labels later with:  node prism.mjs --view icon|text');
  return target;
}

/** Per-user font install directory for the platform (injectable env for testing). */
function fontInstallDir(platform, env = {}) {
  const home = env.home || os.homedir();
  if (platform === 'win32') {
    const lad = env.localAppData || process.env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(lad, 'Microsoft', 'Windows', 'Fonts');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Fonts');
  return path.posix.join(home, '.local', 'share', 'fonts');
}

const FONT_LABEL = 'CaskaydiaCove Nerd Font Mono';
const FONT_ZIP_URL = 'https://github.com/ryanoasis/nerd-fonts/releases/latest/download/CascadiaCode.zip';

/** Download `url` to `dest`, following redirects (GitHub release assets redirect). */
function downloadTo(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PRISM' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadTo(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);
  });
}

/** Extract a .zip using whatever the OS provides (bsdtar → unzip → PowerShell). */
function extractZip(zip, dest) {
  const attempts = [
    `tar -xf "${zip}" -C "${dest}"`,
    `unzip -o "${zip}" -d "${dest}"`,
    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zip}' -DestinationPath '${dest}'"`,
  ];
  let last;
  for (const cmd of attempts) { try { execSync(cmd, { stdio: 'ignore' }); return; } catch (e) { last = e; } }
  throw new Error('could not unzip (need tar, unzip, or PowerShell)');
}

/** Register a font for the current user on Windows so apps see it without a reboot. */
function registerFontWindows(file, fullPath) {
  try {
    execSync(`reg add "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts" /v "${file.replace(/\.ttf$/i, '')} (TrueType)" /t REG_SZ /d "${fullPath}" /f`, { stdio: 'ignore' });
  } catch { /* the copied file is still selectable after a relog */ }
}

/** Download + install CaskaydiaCove Nerd Font into the per-user font dir (no admin), then switch to nerd icons. */
async function doInstallFont() {
  const dir = fontInstallDir(process.platform);
  const tmp = path.join(os.tmpdir(), `prism-font-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, 'font.zip');
    console.log(`✳ Downloading ${FONT_LABEL} …`);
    await downloadTo(FONT_ZIP_URL, zip);
    console.log('  Extracting …');
    extractZip(zip, tmp);
    const ttfs = fs.readdirSync(tmp).filter((f) => /\.ttf$/i.test(f));
    const pick = ttfs.find((f) => /Mono.*Regular/i.test(f)) || ttfs.find((f) => /Regular/i.test(f)) || ttfs[0];
    if (!pick) throw new Error('no .ttf found in the archive');
    const target = path.join(dir, pick);
    fs.copyFileSync(path.join(tmp, pick), target);
    if (process.platform === 'win32') registerFontWindows(pick, target);
    if (process.platform === 'linux') { try { execSync('fc-cache -f', { stdio: 'ignore' }); } catch { /* optional */ } }
    const cf = updateConfigFile({ glyphs: 'nerd', labels: 'icon' });
    console.log(`✳ Installed ${pick} → ${dir}`);
    console.log(`  Config set to icon + nerd glyphs   (${cf})`);
    console.log(`  Last step (only you can do this): set your terminal font to "${FONT_LABEL}", then restart the terminal.`);
  } catch (e) {
    console.error(`✗ Font install failed: ${e.message}`);
    console.error('  Install manually: https://www.nerdfonts.com/font-downloads  (choose "CaskaydiaCove"),');
    console.error('  then run:  node prism.mjs --view icon');
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
  node prism.mjs --update            Update prism.mjs in place from the latest release
  node prism.mjs --sync-config       Add new config options without touching your settings
  node prism.mjs --preset [text|icon] Apply the signature PRISM look (bare → text)
  node prism.mjs --view icon|text    Switch label view (bare --view toggles)
  node prism.mjs --install-font      Install CaskaydiaCove Nerd Font + switch to icon glyphs
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
  if (args.includes('--update')) return doUpdate();
  if (args.includes('--sync-config')) return doSyncConfig();
  if (args.includes('--install-font')) return doInstallFont();
  const viewIdx = args.indexOf('--view');
  if (viewIdx !== -1) return doSetView(args[viewIdx + 1]);
  const presetIdx = args.indexOf('--preset');
  if (presetIdx !== -1) return doPreset(args[presetIdx + 1]);
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
  // After printing, refresh the Claude Code version cache for the next render
  // (hourly, bounded, and only when the version dot is actually shown).
  if (cfg.stats?.version && cfg.checkUpdate !== false) {
    try { await refreshCcVersion(); } catch { /* never let the update check break us */ }
  }
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isMain) main();

export {
  render, compact, meter, gradientText, visLen, isWide, modelName, contextPct, cachePct,
  fmtDur, fmtReset, fmtHoursLeft, fmtTokens, stripJsonc, deepMerge, resolveGlyphs, thresholdRgb,
  fetchLatestScript, doUpdate, updateDotRgb, refreshCcVersion, ccLatestVersion,
  setJsoncValue, fontInstallDir, presetConfig, presetText, doPreset,
  syncConfigText, doSyncConfig,
  THEMES, GLYPHS, DEFAULTS, VERSION,
};
