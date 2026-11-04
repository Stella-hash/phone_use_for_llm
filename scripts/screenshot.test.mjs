import test from 'node:test';
import assert from 'node:assert/strict';
import { requirePng } from '../dist/screenshot.js';
import { observePhone } from '../dist/observation.js';
import { archiveValue } from '../dist/activity.js';

const store = { save: (id, bytes) => ({filename: `event-${id}.png`, storage:'owner-host'}) };
const state = (_, ...args) => args.join(' ') === 'dumpsys window policy' ? 'showing=false\nsecure=false' : 'mWakefulness=Awake';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC4sAAAAASUVORK5CYII=', 'base64');

test('post-action result returns the same saved PNG with capture times and without journaling binary', () => {
  const calls = [];
  let returned;
  const observation = observePhone({ shell: (_, ...args) => { calls.push(args); return state(_, ...args); },
    getCurrentApp: () => ({}), adb: (_, ...args) => { calls.push(args); return png; } }, {}, 'phone', 42, true, false, [], bytes => { returned = bytes; }, store);
  assert.equal(returned, png);
  assert.equal(calls.filter(args => args[0] === 'exec-out' && args[1] === 'screencap').length, 1);
  assert.equal(observation.screenshot.returnedInline, true);
  assert(observation.screenshot.captureStartedAt <= observation.screenshot.captureFinishedAt);
  assert(!JSON.stringify(archiveValue({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })).includes(png.toString('base64')));
});

test('private calls, password fields and unknown privacy state never produce action screenshots', () => {
  for (const [privateText, elements] of [[true, []], [false, [{ password: true }]], [false, null]]) {
    let captured = false;
    const observation = observePhone({ shell: (_, ...args) => { if (args[0] === 'exec-out' && args[1] === 'screencap') captured = true; return state(_, ...args); },
      getCurrentApp: () => ({}) }, {}, 'phone', 1, true, privateText, elements, () => { captured = true; });
    assert.equal(captured, false);
    assert(observation.screenshotOmitted);
  }
});

test('missing, truncated and non-PNG capture is reported honestly instead of returned as an image', () => {
  assert.equal(requirePng(png), png);
  for (const invalid of [Buffer.alloc(0), Buffer.from('protected surface'), png.subarray(0, 33)]) assert.throws(() => requirePng(invalid), /no image is claimed/i);
  let captured = false;
  const observation = observePhone({ shell: state, getCurrentApp: () => ({}), adb: () => Buffer.alloc(0) },
    {}, 'phone', 1, true, false, [], () => { captured = true; });
  assert.equal(captured, false);
  assert.equal(observation.screenshot, undefined);
  assert.match(observation.screenshotOmitted, /capture or storage unavailable/);
});
