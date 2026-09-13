export const POSTURE_TRANSITION_MS = 700;
export function normalizePosture(value) { return value === 'sitting' ? 'sitting' : 'standing'; }
export function postureEase(progress) {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  return t * t * t * (t * (t * 6 - 15) + 10);
}
// Original poses in the normalized VRM skeleton. No downloaded motion assets.
// Angles are radians in YXZ order. Head/chest breathing and call response are
// composed separately so sitting never disables the existing small response.
export const STANDING_POSE = {
  leftUpperArm: [0, 0, -Math.PI * 0.4], rightUpperArm: [0, 0, Math.PI * 0.4],
  leftLowerArm: [0, 0, 0], rightLowerArm: [0, 0, 0],
  leftHand: [0, 0, 0], rightHand: [0, 0, 0],
  leftUpperLeg: [0, 0, 0], rightUpperLeg: [0, 0, 0],
  leftLowerLeg: [0, 0, 0], rightLowerLeg: [0, 0, 0],
};
export const SITTING_POSE = {
  // Bring elbows close to the body and turn the hands toward the lap.
  // These are a shared resting pose, not model-specific contact/cloth solving.
  leftUpperArm: [-0.15, 0, -1.7], rightUpperArm: [-0.15, 0, 1.7],
  leftLowerArm: [0, -1.08, 0], rightLowerArm: [0, 1.08, 0],
  leftHand: [-1.15, 0, 0], rightHand: [1.15, 0, 0],
  leftUpperLeg: [-1.6, 0, -0.04], rightUpperLeg: [-1.6, 0, 0.04],
  leftLowerLeg: [1.6, 0, 0], rightLowerLeg: [1.6, 0, 0],
};
