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
  type AntiBlurSettings,
  type BatchStitcherSettings,
  type FlowGateSettings,
  type FrameSelectionSettings,
  type PanoramaSettings,
} from './PanoramaSettings';


/**
 * v0.24 — the perf-lever keys that moved OUT of the `stitcher` prop and into
 * the dedicated `perf` prop group.  Kept as one list so the `stitcher` prop
 * type (which Omits them) and the `PerfPropOverrides` type (which Picks them)
 * can never drift apart.
 */
type PerfLeverKey =
  | 'seamFinderType'
  | 'rangeMatcherWidth'
  | 'numThreads'
  | 'adaptiveStitchMode'
  | 'adaptiveMinOutputMP'
  | 'adaptiveSlowStitchMsPerFrame';


/**
 * v0.24 — **`blur` prop group.**  Every motion-blur defense in ONE object
 * (previously split across `frameSelection.sharpnessWindow` and
 * `frameSelection.antiBlur`).  All fields optional; all default ON (see
 * `DEFAULT_ANTI_BLUR_SETTINGS` + `SUGGESTED_ANTI_BLUR_SETTINGS`).  Set a value
 * to `0` / `false` (or `sharpnessWindow: 1`) to disable that one mechanism.
 */
export interface BlurPropOverrides extends AntiBlurSettings {
  /** Pick-sharpest-of-K keyframe selection.  `1` disables it.  Default `4`. */
  sharpnessWindow?: number;
}


/**
 * v0.24 — **`perf` prop group.**  The stitch-SPEED levers, grouped out of
 * `stitcher` (which now carries only the stitch *recipe*: mode/warper/blender/
 * crop).  All optional; each falls back to the SDK default.  See the docs for
 * how to flip each.  0.24 defaults: `seamFinderType:'voronoi'`, `numThreads:0`
 * (multi-core), `rangeMatcherWidth:3`, `adaptiveStitchMode:'measured'`.
 */
export type PerfPropOverrides = Partial<Pick<BatchStitcherSettings, PerfLeverKey>>;


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
   * v0.15 — initial value for `stitcher.enableMaxInscribedRectCrop`.
   * Maps from the standalone `maxInscribedRectCrop` <Camera> prop.
   * Omitted ⇒ the stitcher default (false = bounding-rect crop).
   */
  maxInscribedRectCrop?: boolean;
  /**
   * v0.16 — the stitch **recipe** as a JSON OBJECT: `stitchMode` / `warperType`
   * / `blenderType` / `enableMaxInscribedRectCrop` / `debugPack`.  Overrides the
   * matching flat `default*` props; unset fields fall back to the SDK default.
   * Partial — set only what you want.
   *
   * v0.24 — the stitch-SPEED levers (seam finder, range-matcher, threads,
   * adaptive resolution) MOVED OUT of here into the dedicated {@link perf}
   * group.  Setting them here is now a type error; use `perf={{…}}`.
   */
  stitcher?: Partial<Omit<BatchStitcherSettings, PerfLeverKey>>;
  /**
   * v0.16 — the keyframe **gate** as a JSON OBJECT: `mode` / `maxKeyframes` /
   * `overlapThreshold` / `maxKeyframeIntervalMs` / `flow` (deep-merged).
   *
   * v0.24 — the anti-blur controls (`sharpnessWindow` + `antiBlur.*`) MOVED OUT
   * of here into the dedicated {@link blur} group.  Use `blur={{…}}`.
   */
  frameSelection?: Partial<
    Omit<FrameSelectionSettings, 'flow' | 'antiBlur' | 'sharpnessWindow'>
  > & {
    flow?: Partial<FlowGateSettings>;
  };
  /**
   * v0.24 — **anti-blur prop group.**  Every motion-blur defense in one object
   * (pick-sharpest window + exposure cap + motion gate + sharpness floor +
   * hi-fps format).  Deep-merged over the SDK defaults, so setting one knob
   * doesn't wipe the rest.  See {@link BlurPropOverrides}.
   */
  blur?: BlurPropOverrides;
  /**
   * v0.24 — **perf prop group.**  The stitch-speed levers, grouped out of
   * `stitcher`.  See {@link PerfPropOverrides}.
   */
  perf?: PerfPropOverrides;
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

  // v0.24 — split the flat `blur` prop group into its two settings-tree homes:
  // `sharpnessWindow` (a frameSelection scalar) and the rest (the `antiBlur`
  // sub-object).  Both deep-merge over the defaults below.
  const { sharpnessWindow: blurSharpnessWindow, ...blurAntiBlur } =
    overrides.blur ?? {};

  return {
    captureSource: overrides.defaultCaptureSource ?? base.captureSource,
    debug: base.debug,

    stitcher: {
      ...stitcherDefaults,
      stitchMode: overrides.defaultStitchMode ?? stitcherDefaults.stitchMode,
      warperType: overrides.defaultWarper ?? stitcherDefaults.warperType,
      blenderType: overrides.defaultBlender ?? stitcherDefaults.blenderType,
      enableMaxInscribedRectCrop:
        overrides.maxInscribedRectCrop
        ?? stitcherDefaults.enableMaxInscribedRectCrop,
      // The `stitcher` recipe object wins over the flat default* props above…
      ...(overrides.stitcher ?? {}),
      // …and the `perf` group (seam finder / range-matcher / threads / adaptive)
      // wins over both — it's the canonical home for the speed levers (v0.24).
      ...(overrides.perf ?? {}),
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
      // The `frameSelection` gate object wins over the flat default* props above
      // for the scalar fields (mode / maxKeyframes / overlapThreshold /
      // intervalMs).  Its `flow` is DEEP-merged in the explicit `flow:` key
      // below, so a partial flow object doesn't wipe the rest.
      ...(overrides.frameSelection ?? {}),
      // v0.24 — pick-sharpest window now comes from the `blur` group.
      sharpnessWindow:
        blurSharpnessWindow ?? base.frameSelection.sharpnessWindow,
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
      // v0.24 anti-blur — from the `blur` group, DEEP-merged like `flow` so a
      // host can set a single knob (e.g. just `preferHighFpsFormat`) without
      // restating the rest and silently losing the safety `maxConsecutiveHolds`
      // default.
      antiBlur: {
        ...base.frameSelection.antiBlur,
        ...blurAntiBlur,
      },
    },
  };
}
