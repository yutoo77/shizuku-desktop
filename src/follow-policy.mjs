import { seatBounds } from './placement.mjs';

/** The selected source id stays inside main; no titles, content or paths. */
export function parseWindowEvent(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.id) || value.id < 1 || value.id > 2147483647) throw new Error('Invalid follow request');
  if (value.type === 'end' && ['closed', 'ineligible', 'unavailable', 'timeout'].includes(value.reason)) return { type: 'end', id: value.id, reason: value.reason };
  if (value.type !== 'window' || !['visible', 'hidden', 'minimized'].includes(value.state)) throw new Error('Invalid window state');
  if (!['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key]) && Math.abs(value[key]) <= 1000000)) throw new Error('Invalid window bounds');
  if (value.state === 'visible' && (value.width < 1 || value.height < 1)) throw new Error('Empty window');
  if (typeof value.sourceId !== 'string' || !/^window:[1-9][0-9]{0,18}:0$/.test(value.sourceId)
    || BigInt(value.sourceId.split(':')[1]) > 9223372036854775807n || typeof value.topmost !== 'boolean'
    || typeof value.adjacent !== 'boolean' || !Number.isSafeInteger(value.orderVersion) || value.orderVersion < 0) throw new Error('Invalid window order');
  return { type: 'window', id: value.id, state: value.state, x: value.x, y: value.y, width: value.width, height: value.height,
    sourceId: value.sourceId, topmost: value.topmost, adjacent: value.adjacent, orderVersion: value.orderVersion };
}

/** Keep the requested top-edge contact exact; never silently sit inside a window. */
export function followPlacement(rect, anchor, scale, area) {
  const point = { x: rect.x + rect.width / 2, y: rect.y };
  const bounds = seatBounds(point, anchor, scale, area);
  // Half a DIP of rounding is expected. More means the complete body cannot fit.
  if (Math.abs(bounds.y + anchor.y * bounds.height - point.y) > 1
    || Math.abs(bounds.x + anchor.x * bounds.width - point.x) > 1) return null;
  return bounds;
}
