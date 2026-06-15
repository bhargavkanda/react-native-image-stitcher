// SPDX-License-Identifier: Apache-2.0
/**
 * cameraGuidanceCopy — the single user-overridable copy surface for EVERY
 * string the panorama capture UI renders itself: the rotate prompt, pan
 * hint, too-fast cue, lateral-stop popup, the capture-status banner
 * (recording / stitching) AND the crop-editor warning banners.  Centralised
 * so a host can localise or re-word the whole capture experience in one
 * place via the `guidanceCopy` `<Camera>` prop (see the README's
 * "Internationalization" section), and so the defaults live together.
 *
 * NOTE on coverage: the *recoverable stitch-error* alert copy
 * (`userFacingStitchError`) is rendered by the HOST (it calls that helper
 * in its `onError` handler), so it is localised there — see
 * `cameraErrorMessages.ts`, which accepts an override map for the same
 * reason.  Everything the SDK draws on screen flows through THIS object.
 *
 * Mirrors the override pattern of `PanoramaGuidance.messages` and
 * `cameraErrorMessages.ts`.
 */
import {
  DEFAULT_CAPTURE_WARNING_COPY,
  type CaptureWarningCopy,
} from './captureWarnings';

export interface GuidanceCopy {
  /** Item 2 — caption pill while waiting for the user to rotate to landscape
   *  (panMode `'vertical'`). */
  rotateToLandscape: string;
  /** Item 2 — caption pill while waiting for the user to rotate to portrait
   *  (panMode `'horizontal'`). */
  rotateToPortrait: string;
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
  /**
   * Accept button in PREVIEW-ONLY mode (`showPreview` without `rectCrop`):
   * the editor shows the stitched image with no crop box, and this confirms
   * it as-is.
   */
  previewConfirm: string;

  // ── Capture-status banner (CaptureStatusOverlay) ───────────────────────
  /** Banner while a capture is recording (the calm, green state). */
  statusRecording: string;
  /** Banner while the panorama is being stitched after release. */
  statusStitching: string;

  // ── Crop-editor warning banner (buildCaptureWarnings) ──────────────────
  // These re-use the capture-warning defaults verbatim (single source of
  // truth in `captureWarnings.ts`); overriding them here re-words BOTH the
  // crop-banner text AND the `message` carried on `onCapture(...).warnings`.
  /**
   * LOW_FRAME_UTILIZATION warning.  TEMPLATE — keep the `{included}`,
   * `{requested}` and `{percent}` placeholders (substituted at runtime).
   */
  warnLowFrameUtilization: string;
  /** LATERAL_DRIFT_FINALIZE warning. */
  warnLateralDriftFinalize: string;
  /** HIGH_PAN_SPEED warning. */
  warnHighPanSpeed: string;
}

export const DEFAULT_GUIDANCE_COPY: GuidanceCopy = {
  rotateToLandscape: 'Rotate to landscape',
  rotateToPortrait: 'Rotate to portrait',
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
  previewConfirm: 'Confirm',
  statusRecording: 'Hold steady — pan slowly',
  statusStitching: 'Stitching panorama…',
  // DRY: the English warning copy lives once, in captureWarnings.ts.
  warnLowFrameUtilization: DEFAULT_CAPTURE_WARNING_COPY.lowFrameUtilization,
  warnLateralDriftFinalize: DEFAULT_CAPTURE_WARNING_COPY.lateralDriftFinalize,
  warnHighPanSpeed: DEFAULT_CAPTURE_WARNING_COPY.highPanSpeed,
};

/**
 * Project the warning keys of a resolved `GuidanceCopy` back onto the
 * {@link CaptureWarningCopy} shape `buildCaptureWarnings` consumes.  Keeps
 * the two call sites in `<Camera>` from re-spelling the mapping (DRY).
 */
export function captureWarningCopyFrom(g: GuidanceCopy): CaptureWarningCopy {
  return {
    lowFrameUtilization: g.warnLowFrameUtilization,
    lateralDriftFinalize: g.warnLateralDriftFinalize,
    highPanSpeed: g.warnHighPanSpeed,
  };
}

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
