import { clampBounds } from './geometry.mjs';

const MAX_WIDTH = 512;
const MAX_HEIGHT = 768;
const MAX_RECTANGLES = 4096;

function checkedDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new TypeError('Move regions require integer dimensions up to 512 by 768.');
  }
}

function checkedPoint(point) {
  if (!point || !['x', 'y'].every((key) => (
    typeof point[key] === 'number' && Number.isFinite(point[key])
  ))) {
    throw new TypeError('A finite x/y point is required.');
  }
}

/**
 * Convert bottom-up WebGL RGBA bytes to top-left native rectangles at DPR 1.
 * Every alpha-positive pixel is included; equal runs merge vertically without
 * filling transparent holes. An empty frame returns [] for the caller to reject.
 */
export function rgbaToShape(pixels, width, height) {
  checkedDimensions(width, height);
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
    || pixels.length !== width * height * 4) {
    throw new TypeError('A complete RGBA byte array is required.');
  }

  const rectangles = [];
  let previousRuns = new Map();
  for (let y = 0; y < height; y += 1) {
    const rowOffset = (height - 1 - y) * width * 4;
    const currentRuns = new Map();
    let x = 0;
    while (x < width) {
      if (pixels[rowOffset + x * 4 + 3] === 0) {
        x += 1;
        continue;
      }
      const left = x;
      while (x < width && pixels[rowOffset + x * 4 + 3] > 0) x += 1;
      const runWidth = x - left;
      const key = `${left}:${runWidth}`;
      let rectangle = previousRuns.get(key);
      if (rectangle) {
        rectangle.height += 1;
      } else {
        if (rectangles.length >= MAX_RECTANGLES) {
          throw new RangeError('The move region exceeds 4096 rectangles.');
        }
        rectangle = { x: left, y, width: runWidth, height: 1 };
        rectangles.push(rectangle);
      }
      currentRuns.set(key, rectangle);
    }
    previousRuns = currentRuns;
  }
  return rectangles;
}

/** Validate an IPC region before passing a fresh copy to BrowserWindow.setShape. */
export function validateShape(value, width, height) {
  checkedDimensions(width, height);
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RECTANGLES) {
    throw new TypeError('A move region requires between 1 and 4096 rectangles.');
  }
  return Array.from(value, (rectangle) => {
    if (!rectangle || typeof rectangle !== 'object' || Array.isArray(rectangle)
      || !['x', 'y', 'width', 'height'].every((key) => Number.isInteger(rectangle[key]))
      || rectangle.x < 0 || rectangle.y < 0 || rectangle.width < 1 || rectangle.height < 1
      || rectangle.x + rectangle.width > width || rectangle.y + rectangle.height > height) {
      throw new TypeError('Move rectangles must be integer, positive-size, and inside the canvas.');
    }
    return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
  });
}

/** Test a local DIP point against an already validated region (half-open edges). */
export function containsPoint(rectangles, point) {
  checkedPoint(point);
  if (!Array.isArray(rectangles)) throw new TypeError('A rectangle array is required.');
  return rectangles.some((rectangle) => (
    point.x >= rectangle.x && point.x < rectangle.x + rectangle.width
    && point.y >= rectangle.y && point.y < rectangle.y + rectangle.height
  ));
}

/** Drag from the original cursor/window pair, preserving the size and clamping edges. */
export function dragBounds(startBounds, startCursor, nextCursor, area) {
  checkedPoint(startBounds);
  checkedPoint(startCursor);
  checkedPoint(nextCursor);
  if (!Number.isSafeInteger(startBounds.width) || !Number.isSafeInteger(startBounds.height)
    || startBounds.width < 1 || startBounds.height < 1) {
    throw new TypeError('Drag bounds require safe positive integer dimensions.');
  }
  const normalized = clampBounds(startBounds, area);
  if (normalized.width !== startBounds.width || normalized.height !== startBounds.height) {
    throw new RangeError('The work area must fit the avatar without resizing it.');
  }
  // Saturate subtraction overflow so even extreme finite input clamps to an edge.
  const delta = (start, next) => Math.max(-Number.MAX_SAFE_INTEGER,
    Math.min(Number.MAX_SAFE_INTEGER, next - start));
  return clampBounds({
    ...startBounds,
    x: startBounds.x + delta(startCursor.x, nextCursor.x),
    y: startBounds.y + delta(startCursor.y, nextCursor.y),
  }, area);
}
