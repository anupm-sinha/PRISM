import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  visLen, fmtDur, fmtTokens, fmtReset, modelName, contextPct, cachePct,
  stripJsonc, deepMerge, thresholdRgb, resolveGlyphs, THEMES,
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
