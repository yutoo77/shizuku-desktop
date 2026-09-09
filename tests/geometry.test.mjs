import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarSize, clampBounds, defaultBounds, followControlMove, normalizeScale, resizeAvatarBounds } from '../src/geometry.mjs';

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
  assert.deepEqual(defaultBounds(area), { x: 65, y: 40, width: 61, height: 90 });
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
    assert.throws(() => avatarSize(100, area), TypeError);
    assert.throws(() => resizeAvatarBounds({}, 100, area), TypeError);
  }
});

test('saved scales migrate to standard while action-facing size helpers reject invalid choices', () => {
  for (const scale of [80, 100, 120]) assert.equal(normalizeScale(scale), scale);
  for (const value of [undefined, null, '80', '100', '120', true, false, NaN, Infinity, -1, 0, 80.1, 200, {}, []]) {
    assert.equal(normalizeScale(value), 100);
    assert.throws(() => avatarSize(value, screen), TypeError);
    assert.throws(() => resizeAvatarBounds({}, value, screen), TypeError);
  }
});

test('all presets keep the frame aspect and remain inside native move-shape limits', () => {
  const presets = [[80, 240, 352], [100, 300, 440], [120, 360, 528]];
  for (const [scale, width, height] of presets) {
    assert.deepEqual(avatarSize(scale, screen), { width, height });
    assert.equal(width / height, 15 / 22);
    assert.ok(width <= 512 && height <= 768);
    assert.deepEqual(defaultBounds(screen, scale), {
      x: screen.width - width - 24, y: screen.height - height - 12, width, height,
    });
  }
});

test('resizing preserves the bottom-center anchor and is reversible away from edges', () => {
  const before = Object.freeze({ x: 500, y: 300, width: 300, height: 440 });
  const smaller = resizeAvatarBounds(before, 80, screen);
  const larger = resizeAvatarBounds(smaller, 120, screen);
  assert.deepEqual(smaller, { x: 530, y: 388, width: 240, height: 352 });
  assert.deepEqual(larger, { x: 470, y: 212, width: 360, height: 528 });
  assert.deepEqual(resizeAvatarBounds(larger, 100, screen), before);
  assert.deepEqual(before, { x: 500, y: 300, width: 300, height: 440 });
});

test('size changes recover at edges without moving the lower anchor unless the screen requires it', () => {
  assert.deepEqual(resizeAvatarBounds({ x: 0, y: 0, width: 300, height: 440 }, 120, screen),
    { x: 0, y: 0, width: 360, height: 528 });
  assert.deepEqual(resizeAvatarBounds({ x: 1620, y: 600, width: 300, height: 440 }, 120, screen),
    { x: 1560, y: 512, width: 360, height: 528 });
  assert.deepEqual(resizeAvatarBounds({ x: -50, y: 300, width: 300, height: 440 }, 80, screen),
    { x: 0, y: 388, width: 240, height: 352 });
  const area = { x: -1600, y: -900, width: 1600, height: 860 };
  assert.deepEqual(resizeAvatarBounds({ x: -1000, y: -600, width: 300, height: 440 }, 120, area),
    { x: -1030, y: -688, width: 360, height: 528 });
});

test('small work areas fit proportionally with only pixel rounding and never produce an empty window', () => {
  for (const scale of [80, 100, 120]) {
    for (const [width, height] of [[120, 90], [40, 900], [900, 40], [1, 1], [1, 100], [100, 1]]) {
      const area = { x: 30, y: 40, width, height };
      const size = avatarSize(scale, area);
      assert.ok(size.width >= 1 && size.width <= width);
      assert.ok(size.height >= 1 && size.height <= height);
      assert.ok(Math.abs(size.width - size.height * 15 / 22) < 1);
      const bounds = resizeAvatarBounds({ x: 1e300, y: -1e300, width: 1e300, height: 1e300 }, scale, area);
      assert.deepEqual(bounds, { x: area.x + width - size.width, y: area.y, ...size });
    }
  }
});

test('corrupted saved dimensions cannot bypass preset limits and safe pixel bounds', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, null, '100', 1e300, -1]) {
    const bounds = resizeAvatarBounds({ x: value, y: value, width: value, height: value }, 120, screen);
    assert.equal(bounds.width, 360);
    assert.equal(bounds.height, 528);
    assert.ok(Object.values(bounds).every(Number.isSafeInteger));
    assert.ok(bounds.x >= screen.x && bounds.x + bounds.width <= screen.width);
    assert.ok(bounds.y >= screen.y && bounds.y + bounds.height <= screen.height);
  }
});
