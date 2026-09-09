import assert from 'node:assert/strict';
import test from 'node:test';
import { clampBounds, defaultBounds, followControlMove } from '../src/geometry.mjs';

const screen = { x: 0, y: 0, width: 1920, height: 1040 };

test('default placement respects taskbar work area and lower-right margins', () => {
  assert.deepEqual(defaultBounds(screen), { x: 1596, y: 588, width: 300, height: 440 });
});

test('offscreen positions recover at every edge with the complete avatar visible', () => {
  assert.deepEqual(clampBounds({ x: -2000, y: -4000, width: 300, height: 440 }, screen),
    { x: 0, y: 0, width: 300, height: 440 });
  assert.deepEqual(clampBounds({ x: 5000, y: 5000, width: 300, height: 440 }, screen),
    { x: 1620, y: 600, width: 300, height: 440 });
});

test('negative screen origins and nonzero work-area offsets are preserved', () => {
  const area = { x: -1600, y: -900, width: 1600, height: 860 };
  assert.deepEqual(defaultBounds(area), { x: -324, y: -492, width: 300, height: 440 });
  assert.deepEqual(clampBounds({ x: 0, y: 0, width: 300, height: 440 }, area),
    { x: -300, y: -480, width: 300, height: 440 });
  assert.deepEqual(clampBounds({ x: -9999, y: -9999, width: 300, height: 440 }, area),
    { x: -1600, y: -900, width: 300, height: 440 });
});

test('oversized windows and tiny work areas remain recoverable', () => {
  const area = { x: 30, y: 40, width: 120, height: 90 };
  assert.deepEqual(defaultBounds(area), area);
  assert.deepEqual(clampBounds({ x: -100, y: 9000, width: 1e300, height: 1e300 }, area), area);
  assert.deepEqual(defaultBounds({ x: -1, y: -1, width: 1, height: 1 }),
    { x: -1, y: -1, width: 1, height: 1 });
});

test('corrupted saved bounds cannot create nonfinite or nonpositive native bounds', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, null, '100']) {
    assert.deepEqual(clampBounds({ x: value, y: value, width: value, height: value }, screen),
      { x: 0, y: 0, width: 300, height: 440 });
  }
  assert.deepEqual(clampBounds(undefined, screen), { x: 0, y: 0, width: 300, height: 440 });
  assert.deepEqual(clampBounds({ x: 1e300, y: -1e300, width: -20, height: 0 }, screen),
    { x: 1620, y: 0, width: 300, height: 440 });
});

test('fractional bounds produce integer pixels, including a minimum one-pixel size', () => {
  assert.deepEqual(clampBounds({ x: 12.7, y: 20.2, width: 0.2, height: 14.7 }, screen),
    { x: 13, y: 20, width: 1, height: 15 });
});

test('control movement translates the avatar by the delta, independent of control size', () => {
  const avatar = Object.freeze({ x: 500, y: 400, width: 300, height: 440 });
  const previous = Object.freeze({ x: 100, y: 100, width: 100, height: 100 });
  const current = Object.freeze({ x: 155, y: 60, width: 500, height: 500 });
  assert.deepEqual(followControlMove(avatar, previous, current, screen),
    { x: 555, y: 360, width: 300, height: 440 });
  assert.deepEqual(avatar, { x: 500, y: 400, width: 300, height: 440 });
});

test('control movement clamps to screen edges and the next inward move works', () => {
  const initial = { x: 1600, y: 580, width: 300, height: 440 };
  const edge = followControlMove(initial, { x: 0, y: 0 }, { x: 100, y: 100 }, screen);
  assert.deepEqual(edge, { x: 1620, y: 600, width: 300, height: 440 });
  assert.deepEqual(followControlMove(edge, { x: 100, y: 100 }, { x: 75, y: 70 }, screen),
    { x: 1595, y: 570, width: 300, height: 440 });
});

test('invalid control coordinates preserve that axis; overflowing finite deltas still recover', () => {
  const avatar = { x: 500, y: 300, width: 300, height: 440 };
  assert.deepEqual(followControlMove(avatar, { x: NaN, y: 50 }, { x: 20, y: 75 }, screen),
    { x: 500, y: 325, width: 300, height: 440 });
  assert.deepEqual(followControlMove(avatar, undefined, undefined, screen), avatar);
  assert.deepEqual(followControlMove(avatar, { x: -1e308, y: 1e308 }, { x: 1e308, y: -1e308 }, screen),
    { x: 1620, y: 0, width: 300, height: 440 });
});

test('invalid work areas fail explicitly instead of inventing a screen', () => {
  for (const area of [undefined, { ...screen, x: NaN }, { ...screen, width: 0 },
    { ...screen, height: -1 }, { ...screen, y: Infinity }, { ...screen, width: 1e300 }]) {
    assert.throws(() => clampBounds({}, area), TypeError);
    assert.throws(() => defaultBounds(area), TypeError);
    assert.throws(() => followControlMove({}, {}, {}, area), TypeError);
  }
});
