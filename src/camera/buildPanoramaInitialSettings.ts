// SPDX-License-Identifier: Apache-2.0
/**
 * buildPanoramaInitialSettings — pure helper that materialises the
 * initial `PanoramaSettings` snapshot from <Camera>'s `default*` props
 * and a device-capability hint.
 *
 * Why a separate file?
 * ────────────────────
 *
 * The settings tree lives in `PanoramaSettings.ts`; <Camera> consumes
 * it and writes it into React state.  The translation FROM the prop
 * surface (flat names like `defaultStitchMode`) INTO the hierarchical
 * settings tree is the part that:
 *
 *   • is non-trivial enough to deserve direct unit-test coverage
 *     (covers the prop→sub-tree path mapping, which is easy to drift),
 *   • is pure TS — no React, no React Native — so the test runs in
 *     jest's `node` environment without needing the `react-native`
 *     preset (the rest of <Camera> is unmockable in pure TS).
 *
 * Living alongside `Camera.tsx` (vs. burying it as a private function
 * inside) is the only way to get those two properties without taking
 * on full React-Native jest setup just for this one helper.
 *
 * The exported `PanoramaPropOverrides` type is the prop-fragment
 * <Camera> uses; `CameraProps` extends it.  Keeping it explicit here
 * means future Camera prop additions don't accidentally widen the
 * settings-translation surface — every consumer of the helper sees
 * exactly the prop fields that drive the settings tree.
 */

import {
  DEFAULT_FLOW_GATE_SETTINGS,
  DEFAULT_PANORAMA_SETTINGS,
  type PanoramaSettings,
} from './PanoramaSettings';


/**
 * Subset of <Camera>'s props that map onto fields of the initial
 * `PanoramaSettings` snapshot.  Anything outside this interface
 * (e.g. `defaultLens`, `enablePhotoMode`, callbacks) is irrelevant
 * to the settings shape and stays in `CameraProps` only.
 *
 * Forward-looking `default*ResolMP` props are documented here but
 * intentionally not translated yet — the new `PanoramaSettings` tree
 * has no home for them (the v0.3 audit found cv::Stitcher's resol
 * knobs aren't reached by the current native bridges).
 */
export interface PanoramaPropOverrides {
  defaultCaptureSource?: 'ar' | 'non-ar';
  defaultStitchMode?: 'auto' | 'panorama' | 'scans';
  defaultBlender?: 'multiband' | 'feather';
  defaultSeamFinder?: 'graphcut' | 'skip';
  defaultWarper?: 'plane' | 'cylindrical' | 'spherical';
  defaultFlowNoveltyPercentile?: number;
  defaultFlowEvalEveryNFrames?: number;
  defaultFlowMaxTranslationCm?: number;
  defaultKeyframeMaxCount?: number;
  defaultKeyframeOverlapThreshold?: number;
  /**
   * v0.15 — initial value for `stitcher.enableMaxInscribedRectCrop`.
   * Maps from the standalone `maxInscribedRectCrop` <Camera> prop.
   * Omitted ⇒ the stitcher default (false = bounding-rect crop).
   */
  maxInscribedRectCrop?: boolean;
}


/**
 * Whether this device is low-memory enough to benefit from the
 * feather+skip blender/seam fallback (vs. the heavier multiband+
 * graphcut default).  <Camera> derives this from
 * `NativeModules.BatchStitcher.physicalMemoryBytes` at module load
 * (RN-only — see `getIsLowMemDevice` in Camera.tsx); tests pass
 * `false` explicitly to keep the prop-translation path the unit of
 * the unit test.
 *
 * Why a parameter and not a constant import?
 *   The pre-v0.4 `DEFAULT_PANORAMA_SETTINGS` was a `let` mutated at
 *   module load — side-effect-heavy, untestable.  v0.4 keeps the
 *   defaults static + side-effect-free; the device adaptation lives
 *   exactly where it needs to (Camera's mount-time `useState`).
 */
export function buildPanoramaInitialSettings(
  overrides: PanoramaPropOverrides,
  isLowMemDevice: boolean,
): PanoramaSettings {
  // Start from the static, side-effect-free defaults.
  const base = DEFAULT_PANORAMA_SETTINGS;

  // Apply the low-memory device adaptation:
  //   - feather blender (streams warped frames, no peak-memory spike)
  //   - skip seam finder (no graphcut working set)
  // Replaces the v0.3 module-load-time mutation; same semantics.
  const stitcherDefaults = isLowMemDevice
    ? {
      ...base.stitcher,
      blenderType: 'feather' as const,
      seamFinderType: 'skip' as const,
    }
    : base.stitcher;

  // Use the standalone DEFAULT_FLOW_GATE_SETTINGS constant rather
  // than `base.frameSelection.flow!` — the non-null assertion would
  // crash silently if a future refactor un-defines the default's
  // flow sub-tree, but the constant lives at the same level as the
  // type and is type-checked.  See F10 Phase 2 review (NIT-4).
  const flowDefaults = DEFAULT_FLOW_GATE_SETTINGS;

  return {
    captureSource: overrides.defaultCaptureSource ?? base.captureSource,
    debug: base.debug,

    stitcher: {
      ...stitcherDefaults,
      stitchMode: overrides.defaultStitchMode ?? stitcherDefaults.stitchMode,
      warperType: overrides.defaultWarper ?? stitcherDefaults.warperType,
      blenderType: overrides.defaultBlender ?? stitcherDefaults.blenderType,
      seamFinderType:
        overrides.defaultSeamFinder ?? stitcherDefaults.seamFinderType,
      enableMaxInscribedRectCrop:
        overrides.maxInscribedRectCrop
        ?? stitcherDefaults.enableMaxInscribedRectCrop,
    },

    frameSelection: {
      ...base.frameSelection,
      maxKeyframes:
        overrides.defaultKeyframeMaxCount ?? base.frameSelection.maxKeyframes,
      overlapThreshold:
        overrides.defaultKeyframeOverlapThreshold
        ?? base.frameSelection.overlapThreshold,
      flow: {
        ...flowDefaults,
        noveltyPercentile:
          overrides.defaultFlowNoveltyPercentile
          ?? flowDefaults.noveltyPercentile,
        evalEveryNFrames:
          overrides.defaultFlowEvalEveryNFrames
          ?? flowDefaults.evalEveryNFrames,
        maxTranslationCm:
          overrides.defaultFlowMaxTranslationCm
          ?? flowDefaults.maxTranslationCm,
      },
    },
  };
}
