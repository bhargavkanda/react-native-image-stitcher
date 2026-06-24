// SPDX-License-Identifier: Apache-2.0
/**
 * runQualityCheck — public entry point for the SDK's blur + brightness
 * quality gate.  Delegates to the native module
 * `RNImageStitcherQualityChecker` when registered (iOS today via
 * `ios/Sources/RNImageStitcher/QualityChecker.swift`, Android in
 * Phase 3); falls back to a conservative pass-through shim when the
 * native module is absent so dev / Jest runs don't crash on a missing
 * NativeModules entry.
 *
 * The shim NEVER fails an image — false negatives in production are
 * worse than missing data.  The native path is the only branch that
 * can return `passed=false`.
 */

import { NativeModules, Platform } from 'react-native';

import type { QualityIssue, QualityReport, QualityThresholds } from '../types';


let warnedOnce = false;


/**
 * Numeric scores produced by the native module.  The bridge resolves
 * with `{ blurScore, brightnessScore }` — issues are computed in JS
 * so the same threshold logic applies on iOS + Android even if a
 * platform's native impl evolves independently.
 */
interface NativeQualityScores {
  blurScore: number;
  brightnessScore: number;
  glareScore: number;
}


/**
 * Analyse an image file and return a quality report.
 *
 * @param imagePath Filesystem path to the image (with or without
 *                  `file://` prefix — the native module strips it).
 * @param thresholds Cut-offs the report scores against.
 */
export async function runQualityCheck(
  imagePath: string,
  thresholds: QualityThresholds,
): Promise<QualityReport> {
  const native = (NativeModules as Record<string, unknown>)['RNImageStitcherQualityChecker'];

  // Native path: registered + has the bridged `measure` method.
  if (
    native
    && typeof native === 'object'
    && typeof (native as { measure?: unknown }).measure === 'function'
  ) {
    const scores: NativeQualityScores =
      await (native as { measure: (path: string) => Promise<NativeQualityScores> })
        .measure(imagePath);
    return scoreToReport(scores, thresholds);
  }

  // Shim fallback — never reached when the SDK's native module is linked
  // into the host app correctly.  Surfaces a one-time warning in dev so
  // misconfiguration is loud rather than silent.
  if (!warnedOnce && __DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      '[react-native-image-stitcher] QualityChecker native module not '
      + `found on ${Platform.OS}; falling back to optimistic shim.  Check `
      + 'autolinking + a clean `pod install` (iOS) / `gradle clean` (Android).',
    );
    warnedOnce = true;
  }
  void thresholds;
  return {
    passed: true,
    blurScore: Number.POSITIVE_INFINITY,
    brightnessScore: 128,
    issues: [],
  };
}


/**
 * Apply thresholds to native scores → produce the report shape the JS
 * surface promises.  Pure function so it's trivially unit-testable.
 *
 * Exported for tests; not part of the SDK's public API.
 */
export function scoreToReport(
  scores: NativeQualityScores,
  thresholds: QualityThresholds,
): QualityReport {
  const issues: QualityIssue[] = [];

  if (scores.blurScore < thresholds.minBlurScore) {
    issues.push({
      type: 'blur',
      message:
        `Image is too blurry (Laplacian variance ${scores.blurScore.toFixed(1)} `
        + `< ${thresholds.minBlurScore}). Hold the camera steady and retry.`,
      severity: 'error',
    });
  }
  if (scores.brightnessScore < thresholds.minBrightness) {
    issues.push({
      type: 'brightness_low',
      message:
        `Image is too dark (mean luminance ${scores.brightnessScore.toFixed(0)} `
        + `< ${thresholds.minBrightness}). Add light or move closer to a lit area.`,
      severity: 'warning',
    });
  } else if (scores.brightnessScore > thresholds.maxBrightness) {
    issues.push({
      type: 'brightness_high',
      message:
        `Image is overexposed (mean luminance ${scores.brightnessScore.toFixed(0)} `
        + `> ${thresholds.maxBrightness}). Reduce light or move out of direct sunlight.`,
      severity: 'warning',
    });
  }
  if (thresholds.maxGlare != null && scores.glareScore > thresholds.maxGlare) {
    issues.push({
      type: 'glare',
      message:
        `Glare/reflection detected (dark-channel ${Math.round(scores.glareScore)}/255). `
        + 'Tilt the camera to avoid the reflection.',
      severity: 'warning',
    });
  }

  return {
    // `passed` is the strict gate — only `error`-severity issues block.
    // Brightness warnings are advisory; SOS is still computable from a
    // dim or bright photo, but a blurry one isn't.
    passed: issues.every((i) => i.severity !== 'error'),
    blurScore: scores.blurScore,
    brightnessScore: scores.brightnessScore,
    issues,
  };
}
