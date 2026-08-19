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
import type { LateralStopOutcome } from './lateralStopPolicy';

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
  /**
   * Item 6 — popup TITLE for the THIRD lateral-stop state: enough frames
   * landed to stitch, but the host's `lateralStopFinalizeMinFrames` policy
   * discarded the capture anyway.  Distinct from `lateralStopTitle` because
   * that copy PROMISES a stitch ("we stitched what you captured") and this
   * state produced no output at all — saying it here would send the operator
   * looking for a panorama that does not exist.  At the default threshold of
   * 5 this is the state a 2-to-4-keyframe drifted capture lands in, so it is
   * very much reachable out of the box.
   */
  lateralStopDiscardedTitle: string;
  /** Item 6 — popup BODY for the discarded-by-policy stop.  Must NOT promise
   *  a stitch; it asks for a re-shoot in one straight line. */
  lateralStopDiscardedBody: string;
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
  /** v0.25 — CAPTURE_TOO_SHORT; `{included}` is the keyframe count. */
  warnCaptureTooShort: string;
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
  lateralStopDiscardedTitle: 'Capture discarded',
  lateralStopDiscardedBody:
    'You moved sideways, so this capture was discarded. Shoot it again, '
    + 'panning in one straight line.',
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
  warnCaptureTooShort: DEFAULT_CAPTURE_WARNING_COPY.captureTooShort,
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
    captureTooShort: g.warnCaptureTooShort,
  };
}

/**
 * Pick the `LateralMotionModal` title + body for a lateral-stop outcome.
 *
 * Kept as a pure function (rather than a ternary stack in `<Camera>`'s JSX)
 * because the three states are easy to mis-pair — and pairing them wrongly
 * shows an operator "we stitched what you captured" for a capture that was
 * thrown away.  Unit-tested in `lateralStopPolicy.test.ts`.
 */
export function lateralStopCopyFor(
  outcome: LateralStopOutcome,
  copy: GuidanceCopy,
): { title: string; body: string } {
  if (outcome === 'wrong-direction') {
    return {
      title: copy.lateralWrongDirectionTitle,
      body: copy.lateralWrongDirectionBody,
    };
  }
  if (outcome === 'discarded') {
    return {
      title: copy.lateralStopDiscardedTitle,
      body: copy.lateralStopDiscardedBody,
    };
  }
  return { title: copy.lateralStopTitle, body: copy.lateralStopBody };
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
