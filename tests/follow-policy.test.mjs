import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowEvent, followPlacement } from '../src/follow-policy.mjs';
const area = { x: 0, y: 0, width: 1920, height: 1032 }, anchor = { x: .43, y: .707 };
test('following keeps top-edge contact through moving and resizing the selected window', () => {
  const first = followPlacement({ x: 500, y: 450, width: 600, height: 400 }, anchor, 100, area);
  const moved = followPlacement({ x: 540, y: 480, width: 600, height: 400 }, anchor, 100, area);
  assert.equal(moved.x - first.x, 40); assert.equal(moved.y - first.y, 30);
  const resized = followPlacement({ x: 500, y: 450, width: 700, height: 400 }, anchor, 100, area);
  assert.equal(resized.x - first.x, 50); assert.equal(resized.y, first.y);
});
test('no headroom or offscreen contact suspends instead of silently seating inside the window', () => {
  for (const rect of [{ x: 500, y: 0, width: 600 }, { x: -1000, y: 500, width: 500 }, { x: 1850, y: 500, width: 500 }, { x: 500, y: 2000, width: 600 }]) assert.equal(followPlacement(rect, anchor, 100, area), null);
  assert.ok(followPlacement({ x: 500, y: 450, width: 600 }, anchor, 120, area));
});
test('native window messages reject invalid ids, dimensions, coordinates and states', () => {
  const good = { type: 'window', id: 2, state: 'visible', x: 10, y: 450, width: 1000, height: 500 };
  for (const change of [{ id: 0 }, { id: Infinity }, { id: '2' }, { x: NaN }, { y: 1.2 }, { width: -1 }, { height: 0 }, { x: 1000001 }, { state: 'unknown' }]) assert.throws(() => parseWindowEvent({ ...good, ...change }));
  assert.deepEqual(parseWindowEvent({ ...good, title: 'not transmitted to consumers' }), good);
  assert.deepEqual(parseWindowEvent({ type: 'end', id: 2, reason: 'closed' }), { type: 'end', id: 2, reason: 'closed' });
  assert.throws(() => parseWindowEvent({ type: 'end', id: 2, reason: 'fake' }));
});
