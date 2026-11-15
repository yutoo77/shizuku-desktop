/** A brief local acknowledgement. Angles are radians; no queued actions or sound. */
export const CALL_RESPONSE_MS = 2100;

/**
 * @param {number} elapsedMs Time since the accepted call, measured monotonically.
 * @returns {{progress: number, done: boolean, nod: number, turn: number, tilt: number, expression: number}}
 */
export function sampleCallResponse(elapsedMs) {
  const progress = Number.isFinite(elapsedMs)
    ? Math.min(1, Math.max(0, elapsedMs / CALL_RESPONSE_MS)) : 1;
  if (progress === 0 || progress === 1) {
    return { progress, done: progress === 1, nod: 0, turn: 0, tilt: 0, expression: 0 };
  }
  // Smooth onset and return, with one small nod before settling back to idle.
  const presence = Math.sin(Math.PI * progress) ** 2;
  const nodProgress = Math.min(1, Math.max(0, (progress - 0.12) / 0.52));
  const nod = nodProgress === 0 || nodProgress === 1
    ? 0 : Math.sin(Math.PI * nodProgress) ** 2 * 0.075;
  return {
    progress, done: false, nod,
    turn: -0.035 * presence, tilt: 0.025 * presence, expression: 0.18 * presence,
  };
}

/** @param {string[]} names */
export function callExpression(names) {
  return names.includes('happy') ? 'happy' : names.includes('relaxed') ? 'relaxed' : null;
}
