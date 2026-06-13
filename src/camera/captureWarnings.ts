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
  | 'LATERAL_DRIFT_FINALIZE';

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

export interface BuildCaptureWarningsInput {
  /** `framesRequested` from the native finalize result. */
  framesRequested?: number;
  /** `framesIncluded` from the native finalize result. */
  framesIncluded?: number;
  /** True when this finalize was triggered by lateral-drift auto-stop. */
  lateralFinalize?: boolean;
  /** Override the LOW_FRAME_UTILIZATION trip point (fraction in (0, 1]). */
  lowFrameUtilizationThreshold?: number;
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
    lowFrameUtilizationThreshold = LOW_FRAME_UTILIZATION_THRESHOLD,
  } = input;

  const warnings: CaptureWarning[] = [];

  if (lateralFinalize) {
    warnings.push({
      code: 'LATERAL_DRIFT_FINALIZE',
      message:
        'Capture stopped early because the phone drifted sideways — only '
        + 'the part captured before the drift was stitched.',
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
      message:
        `Only ${framesIncluded} of ${framesRequested} captured frames `
        + `(${Math.round(utilization * 100)}%) could be used — the panorama `
        + 'may be incomplete. Pan more slowly and steadily next time.',
      framesRequested,
      framesIncluded,
      utilization,
    });
  }

  return warnings;
}
