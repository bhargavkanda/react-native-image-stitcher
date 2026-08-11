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
  type BatchStitcherSettings,
  type FlowGateSettings,
  type FrameSelectionSettings,
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
   * Initial value for `frameSelection.maxKeyframeIntervalMs` — the
   * time-budget force-accept (ms).  `0` disables it.  Default 1500.
   */
  defaultMaxKeyframeIntervalMs?: number;
  /**
   * v0.21 — initial value for `frameSelection.sharpnessWindow` (the
   * pick-sharpest-in-window anti-blur selection).  `1` disables the
   * window (immediate save).  Default 4 — the feature is ON unless
   * explicitly turned off.
   */
  defaultSharpnessWindow?: number;
  /**
   * v0.15 — initial value for `stitcher.enableMaxInscribedRectCrop`.
   * Maps from the standalone `maxInscribedRectCrop` <Camera> prop.
   * Omitted ⇒ the stitcher default (false = bounding-rect crop).
   */
  maxInscribedRectCrop?: boolean;
  /**
   * v0.16 — pass the stitcher config as a JSON OBJECT (canonical field names:
   * `warperType` / `blenderType` / `seamFinderType` / `stitchMode` /
   * `enableMaxInscribedRectCrop`).  Any field set here OVERRIDES the matching
   * flat `default*` prop; unset fields fall back to the flat prop, then the SDK
   * default.  Partial — set only what you want.
   */
  stitcher?: Partial<BatchStitcherSettings>;
  /**
   * v0.16 — pass the frame-gate config as a JSON OBJECT (canonical field names:
   * `mode` / `maxKeyframes` / `overlapThreshold` / `maxKeyframeIntervalMs` /
   * `flow`).  Overrides the matching flat `default*` props; `flow` is
   * DEEP-merged so you can set a single flow knob without restating the rest.
   */
  frameSelection?: Partial<Omit<FrameSelectionSettings, 'flow'>> & {
    flow?: Partial<FlowGateSettings>;
  };
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
      // The JSON-object prop wins over the flat default* props above.
      ...(overrides.stitcher ?? {}),
    },

    frameSelection: {
      ...base.frameSelection,
      maxKeyframes:
        overrides.defaultKeyframeMaxCount ?? base.frameSelection.maxKeyframes,
      overlapThreshold:
        overrides.defaultKeyframeOverlapThreshold
        ?? base.frameSelection.overlapThreshold,
      maxKeyframeIntervalMs:
        overrides.defaultMaxKeyframeIntervalMs
        ?? base.frameSelection.maxKeyframeIntervalMs,
      sharpnessWindow:
        overrides.defaultSharpnessWindow
        ?? base.frameSelection.sharpnessWindow,
      // The JSON-object prop wins over the flat default* props above for the
      // scalar fields (mode / maxKeyframes / overlapThreshold / intervalMs).
      // Its `flow` (if any) is dropped here and DEEP-merged in the explicit
      // `flow:` key below, so a partial flow object doesn't wipe the rest.
      ...(overrides.frameSelection ?? {}),
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
        // The object prop's flow wins over the flat default*Flow* props.
        ...(overrides.frameSelection?.flow ?? {}),
      },
      // v0.23 anti-blur — DEEP-merged like `flow`, so a host can set a
      // single knob (e.g. just `preferHighFpsFormat`) without restating
      // the rest and silently losing the safety `maxConsecutiveHolds`
      // default.  `...overrides.frameSelection` above shallow-replaced
      // the whole sub-tree; this restores the defaults it dropped.
      antiBlur: {
        ...base.frameSelection.antiBlur,
        ...(overrides.frameSelection?.antiBlur ?? {}),
      },
    },
  };
}
