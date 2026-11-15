const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 440;
const SCALES = [80, 100, 120];

/** Missing/old/corrupted saved preferences use the standard size. */
export function normalizeScale(value) {
  return SCALES.includes(value) ? value : 100;
}

function checkedWorkArea(workArea) {
  if (!workArea || !['x', 'y', 'width', 'height'].every(
    (key) => typeof workArea[key] === 'number' && Number.isFinite(workArea[key]),
  )) {
    throw new TypeError('A finite primary-screen workArea is required.');
  }

  const area = {
    x: Math.round(workArea.x),
    y: Math.round(workArea.y),
    width: Math.floor(workArea.width),
    height: Math.floor(workArea.height),
  };
  if (!Object.values(area).every(Number.isSafeInteger)
    || area.width < 1 || area.height < 1
    || !Number.isSafeInteger(area.x + area.width)
    || !Number.isSafeInteger(area.y + area.height)) {
    throw new TypeError('The primary-screen workArea must contain safe positive pixel dimensions.');
  }
  return area;
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function dimension(value, fallback, maximum) {
  const finite = finiteOr(value, fallback);
  return Math.max(1, Math.min(maximum, Math.round(finite > 0 ? finite : fallback)));
}

/** Keep the complete window inside the usable primary-screen area. */
export function clampBounds(bounds, workArea) {
  const area = checkedWorkArea(workArea);
  const width = dimension(bounds?.width, DEFAULT_WIDTH, area.width);
  const height = dimension(bounds?.height, DEFAULT_HEIGHT, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, finiteOr(bounds?.x, area.x)))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, finiteOr(bounds?.y, area.y)))),
    width,
    height,
  };
}

/** Fit a supported preset proportionally; at least one pixel survives per axis. */
export function avatarSize(scale, workArea) {
  if (!SCALES.includes(scale)) throw new TypeError('Avatar scale must be 80, 100, or 120.');
  const area = checkedWorkArea(workArea);
  const width = DEFAULT_WIDTH * scale / 100;
  const height = DEFAULT_HEIGHT * scale / 100;
  const fit = Math.min(1, area.width / width, area.height / height);
  return {
    width: Math.max(1, Math.min(area.width, Math.floor(width * fit))),
    height: Math.max(1, Math.min(area.height, Math.floor(height * fit))),
  };
}

/** Preserve the lower-center anchor, then recover the complete window at edges. */
export function resizeAvatarBounds(bounds, scale, workArea) {
  const area = checkedWorkArea(workArea);
  const { width, height } = avatarSize(scale, area);
  const previousWidth = dimension(bounds?.width, DEFAULT_WIDTH, area.width);
  const previousHeight = dimension(bounds?.height, DEFAULT_HEIGHT, area.height);
  return clampBounds({
    x: finiteOr(bounds?.x, area.x) + (previousWidth - width) / 2,
    y: finiteOr(bounds?.y, area.y) + previousHeight - height,
    width,
    height,
  }, area);
}

/** Start near the lower-right edge, preserving the selected size and margins. */
export function defaultBounds(workArea, scale = 100) {
  const area = checkedWorkArea(workArea);
  const { width, height } = avatarSize(scale, area);
  return clampBounds({
    x: area.x + area.width - width - 24,
    y: area.y + area.height - height - 12,
    width,
    height,
  }, area);
}

function movement(previous, next) {
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return 0;
  // Saturation also handles subtraction overflow from corrupted finite values.
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, next - previous));
}

/** Move the avatar by the control window's displacement, then recover at edges. */
export function followControlMove(avatarBounds, previousControlBounds, newControlBounds, workArea) {
  const area = checkedWorkArea(workArea);
  return clampBounds({
    ...avatarBounds,
    x: finiteOr(avatarBounds?.x, area.x) + movement(previousControlBounds?.x, newControlBounds?.x),
    y: finiteOr(avatarBounds?.y, area.y) + movement(previousControlBounds?.y, newControlBounds?.y),
  }, area);
}
