import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatBounds, validateAnchor, normalizeFavorite } from '../src/placement.mjs';
const area = { x: 0, y: 0, width: 1920, height: 1032 };

test('seat placement aligns a normalized body point at each scale without rounding drift', () => {
  for (const scale of [80, 100, 120]) {
    const bounds = seatBounds({ x: 950, y: 500 }, { x: 0.43, y: 0.66 }, scale, area);
    assert.ok(Math.abs(bounds.x + bounds.width * 0.43 - 950) <= 0.5);
    assert.ok(Math.abs(bounds.y + bounds.height * 0.66 - 500) <= 0.5);
  }
});
test('seat targets beyond any edge preserve the complete window in the primary work area', () => {
  for (const x of [-1e8, 0, 1920, 1e8]) for (const y of [-1e8, 0, 1032, 1e8]) {
    const b = seatBounds({ x, y }, { x: 0.5, y: 0.6 }, 120, area);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 1920 && b.y + b.height <= 1032);
  }
});
test('untrusted seat anchors cannot position from nonfinite or outside-canvas coordinates', () => {
  for (const value of [null, {}, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: -0.01, y: 0.5 }, { x: 1.01, y: 0.5 }, { x: '0.5', y: 0.5 }]) assert.throws(() => validateAnchor(value));
  assert.throws(() => seatBounds({ x: Infinity, y: 0 }, { x: 0, y: 0 }, 100, area));
});
test('favorite recovery clamps on a smaller screen and retains only validated appearance', () => {
  const spot = normalizeFavorite({ bounds: { x: 1800, y: 900, width: 100000 }, scale: 120, posture: 'sitting', facing: 'left', quiet: true }, { x: -100, y: 30, width: 280, height: 400 });
  assert.deepEqual(spot, { bounds: { x: -92, y: 30, width: 272, height: 400 }, scale: 120, posture: 'sitting', facing: 'left' });
  assert.equal(normalizeFavorite({ bounds: { x: null, y: 0 } }, area), null);
  assert.equal(normalizeFavorite({ bounds: { x: 0, y: NaN } }, area), null);
  const old = normalizeFavorite({ bounds: { x: 50, y: 70 }, scale: 999, posture: 'bad', facing: 'bad' }, area);
  assert.deepEqual(old, { bounds: { x: 50, y: 70, width: 300, height: 440 }, scale: 100, posture: 'standing', facing: 'right' });
});
