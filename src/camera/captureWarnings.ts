// SPDX-License-Identifier: Apache-2.0
/**
 * captureWarnings — non-fatal quality / behaviour signals attached to a
 * SUCCESSFUL capture result.  A stitch that *failed* surfaces a
 * `CameraError` (via the `ok:false` result + `onError`); these warnings
 * cover the "it succeeded but the host/user should know something" cases:
 *
 *   • LOW_FRAME_UTILIZATION — fewer than `threshold` (default 70 %) of the
 *     captured frames survived the confidence filter, so the panorama may
 *     be patchy / shorter than intended.
 *   • LATERAL_DRIFT_FINALIZE — the capture was auto-finalized early because
 *     the phone drifted sideways (item 6); only the pre-drift portion was
 *     stitched.
 *   • HIGH_PAN_SPEED — the pan exceeded the recommended pace at some point
 *     during the capture (the live "too fast" cue fired), so motion blur /
 *     thin overlap may have hurt the result.
 *
 * `<Camera>` builds these at finalize and threads them into BOTH the
 * `onCapture` result payload (so any host — not just the example app —
 * learns of degraded output programmatically) AND the crop editor's banner
 * (so the user sees it before accepting the crop).
 *
 * Pure + dependency-free so it's unit-testable in isolation (the lib's jest
 * config is pure-TS and can't mount `<Camera>`), mirroring
 * `classifyStitchError` / `buildPanoramaInitialSettings`.
 */

/** Stable codes a host can branch on (in addition to the message). */
export type CaptureWarningCode =
  | 'LOW_FRAME_UTILIZATION'
  | 'LATERAL_DRIFT_FINALIZE'
  | 'HIGH_PAN_SPEED'
  /**
   * v0.25 — the capture finalized with fewer keyframes than
   * `minPanoramaKeyframes`.  A one-keyframe capture still SUCCEEDS and
   * still returns that frame (it is a valid one-shot capture), but it is
   * no longer silent: previously the SDK reported a hold that had ended
   * after a single frame as an ordinary panorama, which is why the AR
   * self-ending-hold failures were reported as stitching bugs.
   */
  | 'CAPTURE_TOO_SHORT';

export interface CaptureWarning {
  /** Stable, host-switchable code. */
  code: CaptureWarningCode;
  /** Plain-language default message (shown in the crop banner). */
  message: string;
  /** Frames the engine tried to use (LOW_FRAME_UTILIZATION only). */
  framesRequested?: number;
  /** Frames that survived the confidence filter (LOW_FRAME_UTILIZATION). */
  framesIncluded?: number;
  /** included / requested in [0, 1] (LOW_FRAME_UTILIZATION only). */
  utilization?: number;
}

/**
 * Default trip point for LOW_FRAME_UTILIZATION: warn when fewer than 70 %
 * of captured frames survived.  Matches the threshold the user specified.
 */
export const LOW_FRAME_UTILIZATION_THRESHOLD = 0.7;

/**
 * The overridable message strings for the three capture warnings.  This is
 * the SINGLE SOURCE OF TRUTH for the default English warning copy — the
 * `GuidanceCopy` surface re-uses these defaults (see `cameraGuidanceCopy`),
 * so a host that localises via the `guidanceCopy` `<Camera>` prop re-words
 * these too.
 *
 * `lowFrameUtilization` is a TEMPLATE: the placeholders `{included}`,
 * `{requested}` and `{percent}` are substituted at build time with the
 * actual frame counts.  A translation must keep the placeholders (any it
 * omits is simply not interpolated; an unknown placeholder is left as-is).
 */
export interface CaptureWarningCopy {
  /** LOW_FRAME_UTILIZATION — template; `{included}`/`{requested}`/`{percent}`. */
  lowFrameUtilization: string;
  /** LATERAL_DRIFT_FINALIZE. */
  lateralDriftFinalize: string;
  /** HIGH_PAN_SPEED. */
  highPanSpeed: string;
  /** CAPTURE_TOO_SHORT — template; `{included}` is the keyframe count. */
  captureTooShort: string;
}

export const DEFAULT_CAPTURE_WARNING_COPY: CaptureWarningCopy = {
  lowFrameUtilization:
    'Only {included} of {requested} captured frames ({percent}%) could be '
    + 'used — the panorama may be incomplete. Pan more slowly and steadily '
    + 'next time.',
  lateralDriftFinalize:
    'Capture stopped early because the phone drifted sideways — only the '
    + 'part captured before the drift was stitched.',
  highPanSpeed:
    'The capture was taken faster than the recommended pace — the result '
    + 'may not be the best. Pan more slowly next time.',
  captureTooShort:
    'Only {included} frame(s) were captured, so this is a single shot '
    + 'rather than a panorama. Hold the shutter and pan steadily across '
    + 'the scene.',
};

/**
 * Substitute `{name}` placeholders in a template with `vars[name]`.  An
 * unknown placeholder is left verbatim (so a malformed translation degrades
 * to showing `{percent}` rather than throwing).
 */
function fillTemplate(
  tpl: string,
  vars: Record<string, string | number>,
): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m,
  );
}

export interface BuildCaptureWarningsInput {
  /** `framesRequested` from the native finalize result. */
  framesRequested?: number;
  /** `framesIncluded` from the native finalize result. */
  framesIncluded?: number;
  /** True when this finalize was triggered by lateral-drift auto-stop. */
  lateralFinalize?: boolean;
  /** True when the pan exceeded the recommended pace during the capture. */
  highPanSpeed?: boolean;
  /** Override the LOW_FRAME_UTILIZATION trip point (fraction in (0, 1]). */
  lowFrameUtilizationThreshold?: number;
  /**
   * v0.25 — warn with CAPTURE_TOO_SHORT when `framesRequested` is below
   * this.  Default `1`, i.e. never warns; `2` treats a single-frame
   * capture as too short to be a panorama.
   *
   * Read from the FINALIZE RESULT deliberately, not from the live
   * accepted-keyframe count.  The live count excludes any keyframe whose
   * anti-blur sharpness window is still open at release — which is the
   * trailing keyframe of essentially every capture — and it means
   * different things on iOS and Android.  Judging "too short" from it
   * would misfire constantly.  By finalize time native has drained the
   * window, so the count is true and identical on both platforms.
   */
  minPanoramaKeyframes?: number;
  /**
   * Localised / re-worded warning messages.  Missing keys fall back to
   * {@link DEFAULT_CAPTURE_WARNING_COPY}.  `<Camera>` threads the resolved
   * `guidanceCopy` here so the crop-banner warnings honour the host's i18n.
   */
  copy?: Partial<CaptureWarningCopy>;
}

/**
 * Build the warning list for a successful capture.  Order is by cause →
 * symptom: a lateral-drift stop (the reason a capture is short) is listed
 * before the low-utilization symptom it usually produces.
 */
export function buildCaptureWarnings(
  input: BuildCaptureWarningsInput,
): CaptureWarning[] {
  const {
    framesRequested,
    framesIncluded,
    lateralFinalize = false,
    highPanSpeed = false,
    lowFrameUtilizationThreshold = LOW_FRAME_UTILIZATION_THRESHOLD,
    minPanoramaKeyframes = 1,
  } = input;
  const copy: CaptureWarningCopy = {
    ...DEFAULT_CAPTURE_WARNING_COPY,
    ...stripUndefinedCopy(input.copy),
  };

  const warnings: CaptureWarning[] = [];

  // v0.25 — listed first: "the capture was too short" is the CAUSE of any
  // utilization/coverage symptom below it, same ordering rationale as
  // lateral-drift.
  if (
    minPanoramaKeyframes > 1
    && typeof framesRequested === 'number'
    && framesRequested < minPanoramaKeyframes
  ) {
    warnings.push({
      code: 'CAPTURE_TOO_SHORT',
      message: copy.captureTooShort.replace('{included}', String(framesRequested)),
      framesRequested,
      framesIncluded,
    });
  }

  if (lateralFinalize) {
    warnings.push({
      code: 'LATERAL_DRIFT_FINALIZE',
      message: copy.lateralDriftFinalize,
    });
  }

  if (highPanSpeed) {
    warnings.push({
      code: 'HIGH_PAN_SPEED',
      message: copy.highPanSpeed,
    });
  }

  if (
    typeof framesRequested === 'number'
    && typeof framesIncluded === 'number'
    && framesRequested > 0
    && framesIncluded >= 0
    && framesIncluded < framesRequested * lowFrameUtilizationThreshold
  ) {
    const utilization = framesIncluded / framesRequested;
    warnings.push({
      code: 'LOW_FRAME_UTILIZATION',
      message: fillTemplate(copy.lowFrameUtilization, {
        included: framesIncluded,
        requested: framesRequested,
        percent: Math.round(utilization * 100),
      }),
      framesRequested,
      framesIncluded,
      utilization,
    });
  }

  return warnings;
}

/** Drop `undefined` values so a partial override never clobbers a default. */
function stripUndefinedCopy(
  o?: Partial<CaptureWarningCopy>,
): Partial<CaptureWarningCopy> {
  if (!o) return {};
  const out: Partial<CaptureWarningCopy> = {};
  (Object.keys(o) as (keyof CaptureWarningCopy)[]).forEach((k) => {
    if (o[k] !== undefined) out[k] = o[k];
  });
  return out;
}
