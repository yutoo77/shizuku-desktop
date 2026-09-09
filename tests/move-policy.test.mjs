import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPoint, dragBounds, rgbaToShape, validateShape } from '../src/move-policy.mjs';

// Input rows are visually top-down; WebGL readPixels stores the bottom row first.
function pixelsFor(rows) {
  return Uint8Array.from(rows.toReversed().flatMap((row) => (
    [...row].flatMap((alpha) => [120, 160, 200, alpha === '.' ? 0 : Number(alpha)])
  )));
}

test('RGBA rows flip to native top-left coordinates and preserve alpha holes', () => {
  const shape = rgbaToShape(pixelsFor(['11.1', '1..1', '.11.']), 4, 3);
  assert.deepEqual(shape, [
    { x: 0, y: 0, width: 2, height: 1 },
    { x: 3, y: 0, width: 1, height: 2 },
    { x: 0, y: 1, width: 1, height: 1 },
    { x: 1, y: 2, width: 2, height: 1 },
  ]);
  assert.equal(containsPoint(shape, { x: 1, y: 1 }), false);
  assert.equal(containsPoint(shape, { x: 0, y: 0 }), true);
  assert.equal(containsPoint(shape, { x: 0, y: 2 }), false);
});

test('only equal runs on adjacent rows merge and even alpha 1 stays clickable', () => {
  const shape = rgbaToShape(pixelsFor(['.11.', '.99.', '....', '.11.']), 4, 4);
  assert.deepEqual(shape, [
    { x: 1, y: 0, width: 2, height: 2 },
    { x: 1, y: 3, width: 2, height: 1 },
  ]);
  assert.deepEqual(rgbaToShape(new Uint8Array(24), 2, 3), []);
  assert.deepEqual(rgbaToShape(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1), [
    { x: 0, y: 0, width: 1, height: 1 },
  ]);
});

test('RGBA inputs have bounded dimensions and require complete byte storage', () => {
  for (const [width, height] of [[0, 1], [1, 0], [-1, 2], [513, 1], [1, 769], [1.5, 1], [NaN, 1]]) {
    assert.throws(() => rgbaToShape(new Uint8Array(), width, height), TypeError);
  }
  for (const pixels of [[], new Uint8Array(3), new Uint8Array(5), new Uint16Array(4), null]) {
    assert.throws(() => rgbaToShape(pixels, 1, 1), TypeError);
  }
  assert.deepEqual(rgbaToShape(new Uint8Array(512 * 768 * 4), 512, 768), []);
});

test('pathological alpha fragmentation fails at 4097 rectangles, never widening the shape', () => {
  // Alternating pixels/rows cannot merge: 128 * 64 / 2 = 4096 rectangles.
  const rows = Array.from({ length: 65 }, (_, y) => (
    Array.from({ length: 128 }, (_, x) => ((x + y) % 2 === 0 ? '1' : '.')).join('')
  ));
  const boundary = rgbaToShape(pixelsFor(rows.slice(0, 64)), 128, 64);
  assert.equal(boundary.length, 4096);
  assert.equal(validateShape(boundary, 128, 64).length, 4096);
  assert.throws(() => rgbaToShape(pixelsFor(rows), 128, 65), RangeError);
});

test('IPC region validation returns a copy and rejects invalid or out-of-canvas rectangles', () => {
  const original = [{ x: 0, y: 1, width: 2, height: 3 }];
  const copy = validateShape(original, 2, 4);
  assert.deepEqual(copy, original);
  assert.notEqual(copy, original);
  assert.notEqual(copy[0], original[0]);
  for (const value of [null, {}, [], Array(1), Array(4097).fill(original[0]),
    [null], [[]], [{ x: 0, y: 0, width: 0, height: 1 }],
    [{ x: -1, y: 0, width: 1, height: 1 }],
    [{ x: 0, y: -1, width: 1, height: 1 }],
    [{ x: 0, y: 0, width: 1, height: -1 }],
    [{ x: 0.5, y: 0, width: 1, height: 1 }],
    [{ x: NaN, y: 0, width: 1, height: 1 }],
    [{ x: 0, y: 0, width: Infinity, height: 1 }],
    [{ x: 1, y: 0, width: 2, height: 1 }],
    [{ x: 0, y: 3, width: 1, height: 2 }]]) {
    assert.throws(() => validateShape(value, 2, 4), TypeError);
  }
  assert.throws(() => validateShape(original, 513, 4), TypeError);
});

test('hit tests include left/top, exclude right/bottom, and retain empty gaps', () => {
  const rectangles = [{ x: 2, y: 3, width: 2, height: 3 }];
  for (const point of [{ x: 2, y: 3 }, { x: 3.999, y: 5.999 }]) {
    assert.equal(containsPoint(rectangles, point), true);
  }
  for (const point of [{ x: 1.999, y: 3 }, { x: 2, y: 2.999 }, { x: 4, y: 3 }, { x: 2, y: 6 }]) {
    assert.equal(containsPoint(rectangles, point), false);
  }
  assert.equal(containsPoint([], { x: 0, y: 0 }), false);
  assert.throws(() => containsPoint(rectangles, { x: Infinity, y: 0 }), TypeError);
  assert.throws(() => containsPoint(null, { x: 0, y: 0 }), TypeError);
});

const bounds = { x: 80, y: 100, width: 300, height: 440 };
const cursor = { x: 180, y: 220 };
const area = { x: -100, y: 20, width: 1000, height: 800 };

test('drag tracks the original grab offset and clamps all edges without resizing', () => {
  assert.deepEqual(dragBounds(bounds, cursor, { x: 215, y: 200 }, area), {
    x: 115, y: 80, width: 300, height: 440,
  });
  assert.deepEqual(dragBounds(bounds, cursor, { x: -9000, y: -9000 }, area), {
    x: -100, y: 20, width: 300, height: 440,
  });
  assert.deepEqual(dragBounds(bounds, cursor, { x: 9000, y: 9000 }, area), {
    x: 600, y: 380, width: 300, height: 440,
  });
  // A held pointer returning from a clamped edge still uses the original offset.
  assert.deepEqual(dragBounds(bounds, cursor, cursor, area), bounds);
  assert.deepEqual(dragBounds(bounds, { x: -1e308, y: -1e308 }, { x: 1e308, y: 1e308 }, area), {
    x: 600, y: 380, width: 300, height: 440,
  });
});

test('drag rejects invalid coordinates, dimensions, and an area that would resize the avatar', () => {
  assert.throws(() => dragBounds({ ...bounds, x: NaN }, cursor, cursor, area), TypeError);
  assert.throws(() => dragBounds(bounds, { x: '1', y: 0 }, cursor, area), TypeError);
  assert.throws(() => dragBounds(bounds, cursor, { x: 0, y: Infinity }, area), TypeError);
  assert.throws(() => dragBounds({ ...bounds, width: 0 }, cursor, cursor, area), TypeError);
  assert.throws(() => dragBounds({ ...bounds, height: 0.5 }, cursor, cursor, area), TypeError);
  assert.throws(() => dragBounds(bounds, cursor, cursor, { ...area, width: 299 }), RangeError);
  assert.throws(() => dragBounds(bounds, cursor, cursor, { ...area, x: NaN }), TypeError);
});
