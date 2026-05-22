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

import type {
  PanoramaSettings,
  SlitscanSettings,
  HybridSettings,
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
  };

  // Flow strategy knobs — only meaningful when mode === 'flow-based',
  // but harmless to always emit (native ignores them in other
  // strategies, and consumers can switch modes mid-session without
  // restart so we always serialise).
  if (s.frameSelection.flow) {
    const f = s.frameSelection.flow;
    cfg.flowNoveltyPercentile = f.noveltyPercentile;
    cfg.flowEvalEveryNFrames = f.evalEveryNFrames;
    cfg.flowMaxTranslationCm = f.maxTranslationCm;
    cfg.flowMaxCorners = f.maxCorners;
    cfg.flowQualityLevel = f.qualityLevel;
    cfg.flowMinDistance = f.minDistance;
  }

  return cfg;
}


/**
 * Convert a v0.4 SlitscanSettings tree into the flat dict the
 * slit-scan / firstwins native engines read.  Handles the
 * "presence-as-enable" boolean expansion: a non-undefined
 * `registration.ncc1d` means `enable1dNcc: true` on the wire,
 * with the sub-object's `searchRadius` carried alongside.
 *
 * Verified against:
 *   - iOS  `IncrementalStitcher.swift:1006-1100` (applyConfigOverrides)
 *   - iOS  `OpenCVSlitScanStitcher.mm` (all numbered references in
 *          the audit ground-truth matrix)
 */
export function slitscanSettingsToNativeConfig(
  s: SlitscanSettings,
): NativeConfigDict {
  const cfg: NativeConfigDict = {
    captureSource: s.captureSource,
    // The native side reads `engine: 'slitscan-…'` at start time
    // from a separate top-level field, NOT from configOverrides.
    // We still serialise the variant here for hosts that want to
    // round-trip a single settings object through both surfaces.
    engineVariant: s.variant,

    // ── Painting ─────────────────────────────────────────────────
    paintMode: s.painting.paintMode,
    sliverPosition: s.painting.sliverPosition,
    firstFrameFullFrame: s.painting.firstFrameFullFrame,

    // ── Registration (explicit booleans) ─────────────────────────
    enableTriangulation: s.registration.enableTriangulation,
    enableTriAccumulator: s.registration.enableTriAccumulator,
    enableRansacHomography: s.registration.enableRansacHomography,

    // ── Plane projection ─────────────────────────────────────────
    planeSource: s.plane.source,
  };

  // ── 1D NCC: presence-as-enable ─────────────────────────────────
  if (s.registration.ncc1d) {
    cfg.enable1dNcc = true;
    cfg.nccSearchRadius1d = s.registration.ncc1d.searchRadius;
  } else {
    cfg.enable1dNcc = false;
  }

  // ── 2D NCC: presence-as-enable + nested optionals ──────────────
  if (s.registration.ncc2d) {
    const n2 = s.registration.ncc2d;
    cfg.enable2dNcc = true;
    cfg.nccSearchMargin2d = n2.searchMargin;
    cfg.nccConfidenceThreshold2d = n2.confidenceThreshold;
    if (n2.emaSmoothing) {
      cfg.enableNcc2dEmaSmoothing = true;
      cfg.ncc2dEmaAlpha = n2.emaSmoothing.alpha;
    } else {
      cfg.enableNcc2dEmaSmoothing = false;
    }
    if (n2.panAxisLock) {
      cfg.enableNcc2dPanAxisLock = true;
      cfg.ncc2dCrossAxisLockPx = n2.panAxisLock.crossAxisLockPx;
    } else {
      cfg.enableNcc2dPanAxisLock = false;
    }
  } else {
    cfg.enable2dNcc = false;
  }

  // ── Plane optionals ────────────────────────────────────────────
  // Only emit when `source` actually consumes the field.  Native
  // tolerates unsolicited keys but the modal also walks the dict
  // to decide which sliders to render — extra keys would mislead.
  if (s.plane.source !== 'Disabled' && s.plane.projectionStyle !== undefined) {
    cfg.planeProjectionStyle = s.plane.projectionStyle;
  }
  if (s.plane.source === 'Virtual' && s.plane.virtualDepthMeters !== undefined) {
    cfg.virtualPlaneDepthMeters = s.plane.virtualDepthMeters;
  }
  if (s.plane.source === 'ARKitDetected' && s.plane.alignmentThreshold !== undefined) {
    cfg.arkitPlaneAlignmentThreshold = s.plane.alignmentThreshold;
  }

  // ── Advanced motion knobs (only emit if explicitly set) ────────
  if (s.advanced?.panAxisFractionRect !== undefined) {
    cfg.kPanAxisFractionRect = s.advanced.panAxisFractionRect;
  }
  if (s.advanced?.minAcceptDeltaPx !== undefined) {
    cfg.kMinAcceptDeltaPx = s.advanced.minAcceptDeltaPx;
  }

  return cfg;
}


/**
 * Convert a v0.4 HybridSettings tree into the flat dict the hybrid
 * engine reads.  Minimal surface — hybrid presets internally clobber
 * almost everything; see HybridSettings JSDoc for context.
 *
 * Verified against:
 *   - iOS  `OpenCVIncrementalStitcher.mm:139-180` (preset paths)
 *   - iOS  `IncrementalStitcher.swift:1034-1040` (hybridProjection override)
 */
export function hybridSettingsToNativeConfig(
  s: HybridSettings,
): NativeConfigDict {
  return {
    captureSource: s.captureSource,
    hybridProjection: s.projection,
  };
}
