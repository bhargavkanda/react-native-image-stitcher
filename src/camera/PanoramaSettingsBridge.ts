// SPDX-License-Identifier: Apache-2.0
/**
 * PanoramaSettingsBridge — JS-side adapters that convert the v0.4
 * typed `PanoramaSettings` / `SlitscanSettings` / `HybridSettings`
 * shape into the flat `configOverrides` dictionary the native
 * bridges read.
 *
 * Why this file exists
 * ────────────────────
 *
 * The v0.4 types use hierarchical sub-trees (`stitcher`,
 * `frameSelection.flow`, `painting`, `registration.ncc1d`,
 * `registration.ncc2d.emaSmoothing`, `plane`, …) to give consumers
 * a clean, ergonomic settings surface that mirrors the native
 * engine's domain.  But the native bridges (iOS Swift's
 * `applyConfigOverrides`, Android Kotlin's `IncrementalStitcher.start`)
 * read a FLAT dictionary of native-named keys (e.g. `nccSearchRadius1d`,
 * `enable1dNcc`, `ncc2dEmaAlpha`, `flowMaxTranslationCm`).
 *
 * Two semantic gaps to bridge:
 *
 *   1. **Naming.**  JS `registration.ncc1d.searchRadius` →
 *      native `nccSearchRadius1d`.  JS `painting.paintMode` →
 *      native `paintMode` (same).  Etc.
 *
 *   2. **Presence-as-enable.**  The native side reads explicit
 *      `enable1dNcc`, `enable2dNcc`, `enableNcc2dEmaSmoothing`,
 *      `enableNcc2dPanAxisLock` booleans.  JS models these as
 *      optional sub-objects (sub-object present ⇒ enabled).  This
 *      adapter flattens the booleans for the wire.
 *
 *   3. **Skipped engine defaults.**  Hybrid engine presets internally
 *      clobber most fields (see HybridSettings JSDoc), so we don't
 *      send overrides that would be ignored — just the small useful
 *      surface.
 *
 * The Camera component calls `panoramaSettingsToNativeConfig` once
 * per capture start to produce the value passed as
 * `incremental.start({ config: … })`.  Layer 2 callers building
 * SlitscanSettings or HybridSettings call the matching adapter
 * before reaching `incremental.start()`.
 */

import {
  DEFAULT_ANTI_BLUR_SETTINGS,
  DEFAULT_FLOW_GATE_SETTINGS,
  DEFAULT_SHARPNESS_WINDOW,
  type PanoramaSettings,
} from './PanoramaSettings';


/**
 * Flat config dictionary type — what the native bridges expect.
 * Indexed by the native-side key name; values are platform-
 * marshallable (booleans / numbers / strings).  Keep this type
 * loose: native validates each key individually, and silently
 * ignores keys it doesn't recognise.
 */
export type NativeConfigDict = Record<string, boolean | number | string>;


/**
 * Convert a v0.4 PanoramaSettings tree into the flat dict the
 * batch-keyframe native side reads.  Maps every consumed field
 * exactly once and skips fields the engine doesn't reach.
 *
 * Verified against:
 *   - iOS  `IncrementalStitcher.swift:810-960` (batch path)
 *   - Android `IncrementalStitcher.kt:280-430` (batch path)
 */
export function panoramaSettingsToNativeConfig(
  s: PanoramaSettings,
): NativeConfigDict {
  const cfg: NativeConfigDict = {
    // ── Cross-cutting ────────────────────────────────────────────
    captureSource: s.captureSource,

    // ── BatchStitcherSettings → cv::Stitcher knobs ───────────────
    stitchMode: s.stitcher.stitchMode,
    warperType: s.stitcher.warperType,
    blenderType: s.stitcher.blenderType,
    seamFinderType: s.stitcher.seamFinderType,
    enableMaxInscribedRectCrop: s.stitcher.enableMaxInscribedRectCrop,

    // ── FrameSelectionSettings → KeyframeGate knobs ──────────────
    frameSelectionMode: s.frameSelection.mode,
    keyframeMaxCount: s.frameSelection.maxKeyframes,
    keyframeOverlapThreshold: s.frameSelection.overlapThreshold,
    // Time-budget force-accept (both strategies).  Native reads
    // configOverrides["maxKeyframeIntervalMs"] → setMaxKeyframeIntervalMs.
    maxKeyframeIntervalMs: s.frameSelection.maxKeyframeIntervalMs,
    // v0.21 — pick-sharpest-in-window anti-blur selection.  The field
    // is optional on the type (pre-v0.21 settings literals must keep
    // compiling) but ALWAYS emitted on the wire with the JS default
    // filled in, same canonical-defaults policy as the flow knobs
    // below.  Native re-clamps to [1, 10].
    sharpnessWindow:
      s.frameSelection.sharpnessWindow ?? DEFAULT_SHARPNESS_WINDOW,

    // v0.23 — anti-blur CAPTURE controls (exposure cap, motion gate,
    // relative sharpness floor, high-fps format).  Same always-emit
    // policy as the flow knobs below: a host writing a sparse settings
    // literal must not inherit whatever the native side happens to
    // compile in.  Every value here defaults to OFF (0/false), so the
    // wire is explicit that the features are disabled unless opted in.
    antiBlurMaxExposureMs:
      s.frameSelection.antiBlur?.maxExposureMs
        ?? DEFAULT_ANTI_BLUR_SETTINGS.maxExposureMs,
    antiBlurMaxCommitPanRateRadPerSec:
      s.frameSelection.antiBlur?.maxCommitPanRateRadPerSec
        ?? DEFAULT_ANTI_BLUR_SETTINGS.maxCommitPanRateRadPerSec,
    antiBlurMinScoreFractionOfMedian:
      s.frameSelection.antiBlur?.minScoreFractionOfMedian
        ?? DEFAULT_ANTI_BLUR_SETTINGS.minScoreFractionOfMedian,
    antiBlurMaxConsecutiveHolds:
      s.frameSelection.antiBlur?.maxConsecutiveHolds
        ?? DEFAULT_ANTI_BLUR_SETTINGS.maxConsecutiveHolds,
    antiBlurPreferHighFpsFormat:
      s.frameSelection.antiBlur?.preferHighFpsFormat
        ?? DEFAULT_ANTI_BLUR_SETTINGS.preferHighFpsFormat,
  };

  // Flow strategy knobs — always serialised, regardless of
  // `frameSelection.mode`.  Two reasons:
  //
  //   1. Mode-flip-mid-session: hosts can change `mode` without
  //      restarting capture; consistent flow serialisation means
  //      `'time-based' → 'flow-based'` mid-session doesn't slip
  //      back to stale native-side defaults.  Native ignores these
  //      keys when the active mode doesn't use them.
  //
  //   2. **Native compiled-in defaults disagree with the JS
  //      defaults.**  Specifically: native sets `flowMaxTranslationCm
  //      = 0` and `flowEvalEveryNFrames = 1` when the keys are
  //      missing (iOS `IncrementalStitcher.swift:1003-1029`,
  //      Android `IncrementalStitcher.kt:419-445`), whereas the JS
  //      `DEFAULT_PANORAMA_SETTINGS.frameSelection.flow` values are
  //      `50` and `5`.  Hosts who write sparse settings literals
  //      (omitted `flow` sub-tree, legal per the optional `?`)
  //      would silently get IMU translation gate disabled and
  //      ~5× CPU on flow evaluation — a v0.3-style behaviour
  //      regression on the wire that the type system can't catch.
  //      Filling from `DEFAULT_FLOW_GATE_SETTINGS` here closes the
  //      gap; the JS defaults become the canonical defaults across
  //      both layers.
  //
  // See the F10 Phase 2 review (B1 + N3 + N6) for the full
  // discussion of why this matters.
  const f = s.frameSelection.flow ?? DEFAULT_FLOW_GATE_SETTINGS;
  cfg.flowNoveltyPercentile = f.noveltyPercentile;
  cfg.flowEvalEveryNFrames = f.evalEveryNFrames;
  cfg.flowMaxTranslationCm = f.maxTranslationCm;
  cfg.flowMaxCorners = f.maxCorners;
  cfg.flowQualityLevel = f.qualityLevel;
  cfg.flowMinDistance = f.minDistance;

  return cfg;
}
