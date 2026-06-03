import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  visLen, fmtDur, fmtTokens, fmtReset, fmtHoursLeft, modelName, contextPct, cachePct,
  stripJsonc, deepMerge, thresholdRgb, resolveGlyphs, fetchLatestScript, doUpdate,
  render, updateDotRgb, setJsoncValue, fontInstallDir, DEFAULTS, THEMES,
} from '../prism.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prism.mjs');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Run prism.mjs with a JSON payload on stdin and return stdout. */
function run(json, env = {}) {
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(json),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

// ── Pure helpers ────────────────────────────────────────────────────────────
test('visLen strips ANSI and measures wide glyphs', () => {
  assert.equal(visLen('abc'), 3);
  assert.equal(visLen('\x1b[38;2;1;2;3mabc\x1b[0m'), 3);
  assert.equal(visLen('⚡'), 2);   // emoji-presentation → double width
  assert.equal(visLen('✳'), 1);   // text dingbat → single width
});

test('fmtDur formats seconds, minutes, hours', () => {
  assert.equal(fmtDur(5000), '5s');
  assert.equal(fmtDur(65000), '1m');
  assert.equal(fmtDur(3_660_000), '1h01');
});

test('fmtTokens abbreviates thousands', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(76000), '76.0k');
  assert.equal(fmtTokens(150000), '150k');
});

test('fmtReset counts down or says now', () => {
  assert.equal(fmtReset(0), '');
  assert.equal(fmtReset(Math.floor(Date.now() / 1000) - 10), 'now');
  assert.match(fmtReset(Math.floor(Date.now() / 1000) + 3600), /m$/);
});

test('fmtHoursLeft brackets whole hours until reset', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(fmtHoursLeft(0), '');                 // no epoch
  assert.equal(fmtHoursLeft(undefined), '');         // missing
  assert.equal(fmtHoursLeft(now - 10), '');          // already reset
  assert.equal(fmtHoursLeft(now + 1800), '(<1h)');   // under an hour
  assert.equal(fmtHoursLeft(now + 2 * 3600), '(~2h)');
  assert.equal(fmtHoursLeft(now + 100 * 3600), '(~100h)');
});

test('modelName prefers parsed id, falls back to display name', () => {
  assert.equal(modelName({ model: { id: 'claude-opus-4-8' } }), 'Opus 4.8');
  assert.equal(modelName({ model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' } }), 'Sonnet 4.6');
  assert.equal(modelName({ model: { display_name: 'Haiku' } }), 'Haiku');
  assert.equal(modelName({}), 'Claude');
});

test('contextPct uses used_percentage, else computes input-only', () => {
  assert.equal(contextPct({ context_window: { used_percentage: 42 } }), 42);
  assert.equal(Math.round(contextPct({
    context_window: { context_window_size: 100, current_usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } },
  })), 30);
  assert.equal(contextPct({}), 0);
});

test('cachePct derives cache-read share', () => {
  assert.equal(cachePct({}), null);
  assert.equal(Math.round(cachePct({
    context_window: { current_usage: { input_tokens: 25, cache_read_input_tokens: 75, cache_creation_input_tokens: 0 } },
  })), 75);
});

test('stripJsonc removes comments and trailing commas', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{ "a":1, // line\n "b":2, /* block */ }')), { a: 1, b: 2 });
  assert.deepEqual(JSON.parse(stripJsonc('{ "url": "http://x//y" }')), { url: 'http://x//y' });
});

test('deepMerge merges nested objects', () => {
  assert.deepEqual(deepMerge({ a: { x: 1, y: 2 }, b: 5 }, { a: { y: 3 } }), { a: { x: 1, y: 3 }, b: 5 });
});

test('thresholdRgb picks healthy/warn/crit bands', () => {
  const t = THEMES.neon;
  assert.deepEqual(thresholdRgb(10, t, 70, 90), t.healthy);
  assert.deepEqual(thresholdRgb(75, t, 70, 90), t.warn);
  assert.deepEqual(thresholdRgb(95, t, 70, 90), t.crit);
});

test('resolveGlyphs maps modes', () => {
  assert.equal(resolveGlyphs('ascii').fill, '#');
  assert.equal(resolveGlyphs('unicode').brand, '✳');
});

// ── End-to-end rendering ────────────────────────────────────────────────────
test('renders a full HUD and emits color', () => {
  const out = run({
    model: { id: 'claude-opus-4-8' }, effort: { level: 'high' },
    cost: { total_cost_usd: 1.27, total_duration_ms: 60000, total_lines_added: 5, total_lines_removed: 1 },
    context_window: { used_percentage: 38 },
    rate_limits: { five_hour: { used_percentage: 24 }, seven_day: { used_percentage: 41 } },
  });
  const s = strip(out);
  assert.match(s, /Opus 4\.8/);
  assert.match(s, /38%/);
  assert.match(s, /24%/);
  assert.match(s, /\$1\.27/);
  assert.ok(out.includes('\x1b['), 'expected ANSI color codes');
});

test('context percentage is suffixed with "used"', () => {
  const s = strip(run({ model: { id: 'claude-opus-4-8' }, context_window: { used_percentage: 38 } }));
  assert.match(s, /38% used/);
});

test('5h/7d show an hours-left bracket when reset time is known', () => {
  const now = Math.floor(Date.now() / 1000);
  const s = strip(run({
    model: { id: 'claude-opus-4-8' },
    context_window: { used_percentage: 38 },
    rate_limits: {
      five_hour: { used_percentage: 24, resets_at: now + 2 * 3600 },
      seven_day: { used_percentage: 41, resets_at: now + 100 * 3600 },
    },
  }));
  assert.match(s, /24% \(~2h\)/);
  assert.match(s, /41% \(~100h\)/);
});

test('5h/7d render a placeholder when no rate-limit data has arrived', () => {
  const s = strip(run({ model: { id: 'claude-opus-4-8' }, context_window: { used_percentage: 10 } }));
  assert.match(s, /5h.*—/);   // em-dash placeholder keeps the layout complete
  assert.match(s, /7d.*—/);
});

test('rate limits persist from cache when a later render omits them', () => {
  const sid = 'prism-test-cache-' + Date.now();
  // First render carries live rate-limit data for this session.
  run({ model: { id: 'claude-opus-4-8' }, session_id: sid, rate_limits: { five_hour: { used_percentage: 24 }, seven_day: { used_percentage: 41 } } });
  // Second render (same session) omits it — PRISM should reuse the cached values.
  const s = strip(run({ model: { id: 'claude-opus-4-8' }, session_id: sid }));
  assert.match(s, /24%/);
  assert.match(s, /41%/);
});

test('never throws on empty input', () => {
  assert.match(strip(run({})), /Claude/);
});

test('tolerates null context fields', () => {
  const s = strip(run({ model: { id: 'claude-haiku-4-5' }, context_window: { used_percentage: null, current_usage: null } }));
  assert.match(s, /Haiku 4\.5/);
  assert.match(s, /0%/);
});

test('falls back to a single compact line on a narrow terminal', () => {
  const s = strip(run({ model: { id: 'claude-opus-4-8' }, context_window: { used_percentage: 50 } }, { COLUMNS: '28' }));
  assert.ok(!s.includes('╭'), 'compact mode should not draw a box');
  assert.match(s, /Opus 4\.8/);
});

// ── Self-update ──────────────────────────────────────────────────────────────
test('fetchLatestScript returns the script text on a good response', async () => {
  const body = "#!/usr/bin/env node\nconst VERSION = '9.9.9';\n";
  const fakeFetch = async () => ({ ok: true, text: async () => body });
  assert.equal(await fetchLatestScript(fakeFetch), body);
});

test('fetchLatestScript throws on a non-OK response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => '' });
  await assert.rejects(() => fetchLatestScript(fakeFetch), /503/);
});

test('fetchLatestScript rejects content that is not the PRISM script', async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => '<html>not found</html>' });
  await assert.rejects(() => fetchLatestScript(fakeFetch), /PRISM/);
});

test('doUpdate overwrites the target file with the fetched script', async () => {
  const target = path.join(os.tmpdir(), `prism-update-test-${Date.now()}.mjs`);
  fs.writeFileSync(target, "const VERSION = '0.0.0';\n");
  const body = "const VERSION = '9.9.9';\n";
  const ok = await doUpdate({
    fetch: async () => ({ ok: true, text: async () => body }),
    target, log: () => {}, err: () => {},
  });
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), body);
  fs.rmSync(target, { force: true });
  fs.rmSync(target + '.bak', { force: true });
});

// ── Version dot / update check ───────────────────────────────────────────────
test('updateDotRgb signals Claude Code update state', () => {
  const t = THEMES.neon;
  assert.deepEqual(updateDotRgb('2.1.0', '2.1.1', t, true), t.warn);     // newer exists
  assert.deepEqual(updateDotRgb('2.1.1', '2.1.1', t, true), t.healthy);  // up to date
  assert.deepEqual(updateDotRgb('2.1.1', null, t, true), t.healthy);     // unknown → assume current
  assert.deepEqual(updateDotRgb('2.1.0', '2.1.1', t, false), t.dim);     // check disabled → neutral
});

test('version renders an update dot and drops the dim attribute', () => {
  const cfg = { ...DEFAULTS, stats: { ...DEFAULTS.stats, version: true } };
  const raw = render({ model: { id: 'claude-opus-4-8' }, version: '2.1.0' }, cfg);
  assert.match(strip(raw), /● v2\.1\.0/);                       // colored dot before version
  assert.ok(!raw.includes('\x1b[2m'), 'version should not use the dim (2m) attribute');
});

test('two spaces separate the model glyph from the model name', () => {
  assert.match(strip(render({ model: { id: 'claude-opus-4-8' } }, DEFAULTS)), /✳ {2}Opus 4\.8/);
});

test('default view is text (worded labels)', () => {
  assert.equal(DEFAULTS.labels, 'text');
  const out = strip(render({ model: { id: 'claude-opus-4-8' }, context_window: { used_percentage: 38 } }, DEFAULTS));
  assert.match(out, /Context/);   // worded label, not "ctx"
});

// ── Full icon coverage ───────────────────────────────────────────────────────
test('icon mode + nerd glyphs iconizes context / 5h / 7d / cost', () => {
  const cfg = { ...DEFAULTS, labels: 'icon', glyphs: 'nerd', stats: { ...DEFAULTS.stats, version: false } };
  const out = strip(render({
    model: { id: 'claude-opus-4-8' }, context_window: { used_percentage: 38 },
    cost: { total_cost_usd: 1.2 },
    rate_limits: { five_hour: { used_percentage: 24 }, seven_day: { used_percentage: 41 } },
  }, cfg));
  for (const cp of [0xf0e4, 0xf252, 0xf073, 0xf155].map((c) => String.fromCharCode(c))) {
    assert.ok(out.includes(cp), `expected nerd glyph`);
  }
  assert.ok(!/\bctx\b/.test(out), 'nerd icon mode should not show "ctx" text');
});

test('icon mode + unicode glyphs stays box-safe (cache → ≣, ctx kept as text)', () => {
  const cfg = { ...DEFAULTS, labels: 'icon', glyphs: 'unicode', stats: { ...DEFAULTS.stats, version: false } };
  const out = strip(render({
    model: { id: 'claude-opus-4-8' },
    context_window: { used_percentage: 38, current_usage: { input_tokens: 25, cache_read_input_tokens: 75, cache_creation_input_tokens: 0 } },
  }, cfg));
  assert.match(out, /\bctx\b/);
  assert.match(out, /≣/);
});

// ── Config view switching ────────────────────────────────────────────────────
test('setJsoncValue replaces an existing key and preserves comments', () => {
  const src = '{\n  "theme": "neon",\n  "labels": "text", // mine\n  "spacing": 5\n}\n';
  const out = setJsoncValue(src, 'labels', 'icon');
  assert.match(out, /"labels":\s*"icon"/);
  assert.match(out, /\/\/ mine/);
  assert.equal(JSON.parse(stripJsonc(out)).labels, 'icon');
  assert.equal(JSON.parse(stripJsonc(out)).theme, 'neon');
});

test('setJsoncValue inserts a missing key', () => {
  const out = setJsoncValue('{\n  "theme": "neon"\n}\n', 'labels', 'icon');
  assert.equal(JSON.parse(stripJsonc(out)).labels, 'icon');
  assert.equal(JSON.parse(stripJsonc(out)).theme, 'neon');
});

// ── Font install dir ─────────────────────────────────────────────────────────
test('fontInstallDir resolves the per-user font dir per platform', () => {
  assert.match(fontInstallDir('darwin', { home: '/Users/x' }), /^\/Users\/x\/Library\/Fonts$/);
  assert.match(fontInstallDir('linux', { home: '/home/x' }), /\.local\/share\/fonts$/);
  assert.match(fontInstallDir('win32', { home: 'C:\\Users\\x', localAppData: 'C:\\Users\\x\\AppData\\Local' }), /Microsoft\\Windows\\Fonts$/);
});
