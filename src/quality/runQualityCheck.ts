/**
 * runQualityCheck — pure-JS shim for now; the real implementation will
 * live in a native module (QualityCheckModule on iOS, the NDK binding
 * on Android) once the OpenCV bridge lands.
 *
 * The SDK exposes ``runQualityCheck`` as the single entry point so host
 * apps can opt into quality gating without knowing anything about
 * Laplacian variance / exposure sampling.  When the native module lands,
 * this file swaps its implementation without breaking the public API.
 *
 * Until then the shim returns a conservative "passed" report with
 * placeholder scores so UI that expects a QualityReport object keeps
 * working.  A ``TODO`` warning fires in development so the regression
 * is noisy rather than silently accepted as ground truth.
 */

import { Platform } from 'react-native';

import type { QualityReport, QualityThresholds } from '../types';


let warnedOnce = false;


/**
 * Analyse an image file and return a quality report.
 *
 * @param imagePath Filesystem path to the image (no `file://` prefix).
 *                  Must be readable by the host app's sandbox.
 * @param thresholds The thresholds the report should be scored against.
 */
export async function runQualityCheck(
  imagePath: string,
  thresholds: QualityThresholds,
): Promise<QualityReport> {
  if (!warnedOnce && __DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      '[@retailens/capture-sdk] runQualityCheck() is currently a pure-JS '
      + 'shim — real blur/brightness scoring lands when the native module '
      + `ships (tracked on the roadmap).  Platform=${Platform.OS}, imagePath=${imagePath}`,
    );
    warnedOnce = true;
  }

  void thresholds; // shim: thresholds are used by the native impl only.

  // Optimistic defaults — the shim must never "fail" an image because
  // we can't actually measure it yet; that would surface false
  // negatives in production.  The real native impl will override.
  return {
    passed: true,
    blurScore: Number.POSITIVE_INFINITY,
    brightnessScore: 128,
    issues: [],
  };
}
