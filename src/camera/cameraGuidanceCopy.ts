// SPDX-License-Identifier: Apache-2.0
/**
 * cameraGuidanceCopy — the user-overridable copy surface for all panorama
 * capture guidance strings (rotate prompt, pan hint, too-fast warning,
 * lateral-stop popup, countdown).  Centralised so hosts can localise or
 * re-word every guidance message in one place via the `guidanceCopy`
 * `<Camera>` prop, and so the defaults live next to each other.
 *
 * Mirrors the override pattern of `PanoramaGuidance.messages` and
 * `cameraErrorMessages.ts`.
 */

export interface GuidanceCopy {
  /** Item 2 — caption pill while waiting for the user to rotate to landscape. */
  rotateToLandscape: string;
  /** Item 3 — short hint shown with the how-to-pan animation. */
  panHint: string;
  /** Item 4 — transient warning when the pan is too fast. */
  tooFast: string;
  /** Item 6 — popup title when the user drifts laterally (cross-axis). */
  lateralStopTitle: string;
  /** Item 6 — popup body / guidance for the lateral-drift stop. */
  lateralStopBody: string;
  /** Item 6 — popup dismiss button label. */
  lateralStopDismiss: string;
  /**
   * Item 6 — popup TITLE when lateral drift stopped the capture before
   * enough frames were captured to stitch (the user panned the wrong way
   * almost immediately).  Nothing was produced, so the copy points them at
   * the arrow instead of saying "we kept what you captured".
   */
  lateralWrongDirectionTitle: string;
  /** Item 6 — popup BODY for the too-few-frames wrong-direction stop. */
  lateralWrongDirectionBody: string;
  /** Item 7 — confirm button on the crop editor. */
  cropConfirm: string;
  /** Item 7 — reset-corners button on the crop editor. */
  cropReset: string;
  /** Item 7 — "emit the stitch un-cropped" button on the crop editor. */
  cropUseOriginal: string;
  /** Item 7 — discard this capture and return to the camera. */
  cropRetake: string;
}

export const DEFAULT_GUIDANCE_COPY: GuidanceCopy = {
  rotateToLandscape: 'Rotate to landscape',
  panHint: 'Pan slowly top to bottom',
  tooFast: 'Moving too fast — slow down',
  lateralStopTitle: 'Keep the pan straight',
  lateralStopBody:
    'You moved sideways. Pan in one direction only — we stitched what you captured.',
  lateralStopDismiss: 'Got it',
  lateralWrongDirectionTitle: 'Follow the arrow',
  lateralWrongDirectionBody:
    'You moved the phone the wrong way. Pan slowly in the direction the '
    + 'arrow shows, in one straight line.',
  cropConfirm: 'Crop',
  cropReset: 'Reset',
  cropUseOriginal: 'Use original',
  cropRetake: 'Retake',
};

/**
 * Merge a partial host override onto the defaults.  Undefined / missing keys
 * fall back to the default string; an empty-object / undefined override
 * returns the defaults unchanged.
 */
export function mergeGuidanceCopy(
  override?: Partial<GuidanceCopy>,
): GuidanceCopy {
  if (!override) return DEFAULT_GUIDANCE_COPY;
  return { ...DEFAULT_GUIDANCE_COPY, ...stripUndefined(override) };
}

/** Drop keys whose value is `undefined` so they don't clobber a default. */
function stripUndefined(o: Partial<GuidanceCopy>): Partial<GuidanceCopy> {
  const out: Partial<GuidanceCopy> = {};
  (Object.keys(o) as (keyof GuidanceCopy)[]).forEach((k) => {
    if (o[k] !== undefined) out[k] = o[k];
  });
  return out;
}
