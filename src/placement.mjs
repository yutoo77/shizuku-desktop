import { avatarSize, clampBounds, normalizeScale } from './geometry.mjs';
import { normalizePosture } from './posture.mjs';

export const normalizeFacing = value => value === 'left' ? 'left' : 'right';

/** The renderer supplies only a normalized point inside its own canvas. */
export function validateAnchor(value) {
  if (!value || typeof value !== 'object' || !['x', 'y'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)) {
    throw new TypeError('Invalid seat anchor');
  }
  return { x: value.x, y: value.y };
}

export function seatBounds(point, anchor, scale, workArea) {
  const valid = validateAnchor(anchor);
  if (!point || !['x', 'y'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key]))) {
    throw new TypeError('Invalid placement point');
  }
  const size = avatarSize(scale, workArea);
  return clampBounds({ ...size, x: point.x - valid.x * size.width, y: point.y - valid.y * size.height }, workArea);
}

/** One explicit bookmark; corrupt coordinates never become an implicit favorite. */
export function normalizeFavorite(value, workArea) {
  if (!value || !value.bounds || !['x', 'y'].every(key =>
    typeof value.bounds[key] === 'number' && Number.isFinite(value.bounds[key]))) return null;
  const scale = normalizeScale(value.scale);
  return {
    bounds: clampBounds({ ...value.bounds, ...avatarSize(scale, workArea) }, workArea),
    scale, posture: normalizePosture(value.posture), facing: normalizeFacing(value.facing),
  };
}
