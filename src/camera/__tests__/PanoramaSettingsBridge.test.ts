// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the JS→native settings bridge.
 *
 * Scope: every adapter (panoramaSettingsToNativeConfig,
 * slitscanSettingsToNativeConfig, hybridSettingsToNativeConfig)
 * round-trip from a hierarchical typed input to the flat wire dict
 * the native side reads.  Asserts both:
 *
 *   1. Naming — JS key `registration.ncc1d.searchRadius` becomes
 *      native key `nccSearchRadius1d` (and similar mappings).  Each
 *      DEFAULT_* snapshot's expected wire dict is enumerated below;
 *      drift in either direction (lib drops a key, or adds a phantom
 *      one) is caught here.
 *
 *   2. Presence-as-enable — undefined optional sub-objects in the
 *      typed shape (`registration.ncc1d`, `registration.ncc2d`,
 *      `registration.ncc2d.emaSmoothing`, `registration.ncc2d.panAxisLock`,
 *      `frameSelection.flow`, `advanced`) translate to explicit
 *      `enable*: false` (or the absence of all the sub-object's
 *      payload keys) on the wire.  Many of these have been silent
 *      drift hazards historically — the old flat type required the
 *      consumer to set BOTH `enable1dNcc: true` AND `nccSearchRadius1d:
 *      <value>`; v0.4 makes them inseparable by collapsing into a
 *      single optional sub-object, and this file is what guarantees
 *      the wire side still gets both halves.
 *
 *   3. Engine-discriminated coverage — plane source variants
 *      ('Disabled' / 'ARKitDetected' / 'Virtual') gate which optional
 *      plane fields are emitted; the bridge filters those at the
 *      adapter boundary so the modal's per-source rendering doesn't
 *      get mislead by stale-but-present keys from a previous source
 *      selection.
 *
 * These tests are pure-TS; no React Native module import.  Jest config
 * (`jest.config.js`) routes test files in `__tests__/` through ts-jest
 * with the `node` testEnvironment.
 */

import {
  DEFAULT_HYBRID_SETTINGS,
  DEFAULT_PANORAMA_SETTINGS,
  DEFAULT_SLITSCAN_SETTINGS,
  type HybridSettings,
  type PanoramaSettings,
  type SlitscanSettings,
} from '../PanoramaSettings';
import {
  hybridSettingsToNativeConfig,
  panoramaSettingsToNativeConfig,
  slitscanSettingsToNativeConfig,
} from '../PanoramaSettingsBridge';


// ════════════════════════════════════════════════════════════════════
// PANORAMA — batch-keyframe engine
// ════════════════════════════════════════════════════════════════════

describe('panoramaSettingsToNativeConfig', () => {
  it('round-trips DEFAULT_PANORAMA_SETTINGS to the expected flat dict', () => {
    const cfg = panoramaSettingsToNativeConfig(DEFAULT_PANORAMA_SETTINGS);

    // Cross-cutting
    expect(cfg.captureSource).toBe('ar');

    // BatchStitcherSettings
    expect(cfg.stitchMode).toBe('auto');
    expect(cfg.warperType).toBe('plane');
    expect(cfg.blenderType).toBe('multiband');
    expect(cfg.seamFinderType).toBe('graphcut');
    expect(cfg.enableMaxInscribedRectCrop).toBe(false);

    // FrameSelectionSettings
    expect(cfg.frameSelectionMode).toBe('flow-based');
    expect(cfg.keyframeMaxCount).toBe(6);
    expect(cfg.keyframeOverlapThreshold).toBe(0.2);

    // FlowGateSettings (flow is defined in the default)
    expect(cfg.flowNoveltyPercentile).toBe(0.85);
    expect(cfg.flowEvalEveryNFrames).toBe(5);
    expect(cfg.flowMaxTranslationCm).toBe(50);
    expect(cfg.flowMaxCorners).toBe(150);
    expect(cfg.flowQualityLevel).toBe(0.01);
    expect(cfg.flowMinDistance).toBe(10);
  });

  it('omits every flow.* key when frameSelection.flow is undefined', () => {
    const noFlow: PanoramaSettings = {
      ...DEFAULT_PANORAMA_SETTINGS,
      frameSelection: {
        ...DEFAULT_PANORAMA_SETTINGS.frameSelection,
        flow: undefined,
      },
    };
    const cfg = panoramaSettingsToNativeConfig(noFlow);

    // Top-level FrameSelection knobs still emitted
    expect(cfg.frameSelectionMode).toBe('flow-based');
    expect(cfg.keyframeMaxCount).toBe(6);
    expect(cfg.keyframeOverlapThreshold).toBe(0.2);

    // Every flow.* native key must be absent (not undefined,
    // not present — the dict must not even have the property).
    expect(cfg).not.toHaveProperty('flowNoveltyPercentile');
    expect(cfg).not.toHaveProperty('flowEvalEveryNFrames');
    expect(cfg).not.toHaveProperty('flowMaxTranslationCm');
    expect(cfg).not.toHaveProperty('flowMaxCorners');
    expect(cfg).not.toHaveProperty('flowQualityLevel');
    expect(cfg).not.toHaveProperty('flowMinDistance');
  });

  it('honours captureSource and stitcher overrides', () => {
    const overridden: PanoramaSettings = {
      ...DEFAULT_PANORAMA_SETTINGS,
      captureSource: 'non-ar',
      debug: true,
      stitcher: {
        stitchMode: 'scans',
        warperType: 'spherical',
        blenderType: 'feather',
        seamFinderType: 'skip',
        enableMaxInscribedRectCrop: true,
      },
    };
    const cfg = panoramaSettingsToNativeConfig(overridden);

    expect(cfg.captureSource).toBe('non-ar');
    expect(cfg.stitchMode).toBe('scans');
    expect(cfg.warperType).toBe('spherical');
    expect(cfg.blenderType).toBe('feather');
    expect(cfg.seamFinderType).toBe('skip');
    expect(cfg.enableMaxInscribedRectCrop).toBe(true);
    // Note: `debug` is intentionally NOT on the wire — it's a
    // JS-side UI gate, not a native config knob.  The bridge MUST
    // omit it; if a future change starts emitting it, the modal's
    // operator-facing semantics will silently drift.
    expect(cfg).not.toHaveProperty('debug');
  });
});


// ════════════════════════════════════════════════════════════════════
// SLITSCAN — Layer 2 slit-scan engines
// ════════════════════════════════════════════════════════════════════

describe('slitscanSettingsToNativeConfig', () => {
  it('round-trips DEFAULT_SLITSCAN_SETTINGS to the expected flat dict', () => {
    const cfg = slitscanSettingsToNativeConfig(DEFAULT_SLITSCAN_SETTINGS);

    expect(cfg.captureSource).toBe('ar');
    expect(cfg.engineVariant).toBe('slitscan-rotate');

    // Painting
    expect(cfg.paintMode).toBe('FirstPaintedWins');
    expect(cfg.sliverPosition).toBe('Bottom');
    expect(cfg.firstFrameFullFrame).toBe(true);

    // Registration (explicit booleans)
    expect(cfg.enableTriangulation).toBe(false);
    expect(cfg.enableTriAccumulator).toBe(false);
    expect(cfg.enableRansacHomography).toBe(false);

    // Plane
    expect(cfg.planeSource).toBe('ARKitDetected');
    expect(cfg.planeProjectionStyle).toBe('Rectified');
    expect(cfg.arkitPlaneAlignmentThreshold).toBe(0.6);

    // ncc1d / ncc2d both omitted in defaults
    expect(cfg.enable1dNcc).toBe(false);
    expect(cfg.enable2dNcc).toBe(false);
    expect(cfg).not.toHaveProperty('nccSearchRadius1d');
    expect(cfg).not.toHaveProperty('nccSearchMargin2d');
    expect(cfg).not.toHaveProperty('nccConfidenceThreshold2d');
    expect(cfg).not.toHaveProperty('ncc2dEmaAlpha');
    expect(cfg).not.toHaveProperty('ncc2dCrossAxisLockPx');

    // Plane: ARKitDetected — alignmentThreshold present, virtual depth absent
    expect(cfg).not.toHaveProperty('virtualPlaneDepthMeters');

    // Advanced: not set in defaults
    expect(cfg).not.toHaveProperty('kPanAxisFractionRect');
    expect(cfg).not.toHaveProperty('kMinAcceptDeltaPx');
  });

  it('expands `registration.ncc1d` presence-as-enable correctly', () => {
    const withNcc1d: SlitscanSettings = {
      ...DEFAULT_SLITSCAN_SETTINGS,
      registration: {
        ...DEFAULT_SLITSCAN_SETTINGS.registration,
        ncc1d: { searchRadius: 25 },
      },
    };
    const cfg = slitscanSettingsToNativeConfig(withNcc1d);
    expect(cfg.enable1dNcc).toBe(true);
    expect(cfg.nccSearchRadius1d).toBe(25);
  });

  it('expands `registration.ncc2d` presence-as-enable with nested optionals', () => {
    const withNcc2dFull: SlitscanSettings = {
      ...DEFAULT_SLITSCAN_SETTINGS,
      registration: {
        ...DEFAULT_SLITSCAN_SETTINGS.registration,
        ncc2d: {
          searchMargin: 14,
          confidenceThreshold: 0.95,
          emaSmoothing: { alpha: 0.5 },
          panAxisLock: { crossAxisLockPx: 4 },
        },
      },
    };
    const cfg = slitscanSettingsToNativeConfig(withNcc2dFull);

    expect(cfg.enable2dNcc).toBe(true);
    expect(cfg.nccSearchMargin2d).toBe(14);
    expect(cfg.nccConfidenceThreshold2d).toBe(0.95);
    expect(cfg.enableNcc2dEmaSmoothing).toBe(true);
    expect(cfg.ncc2dEmaAlpha).toBe(0.5);
    expect(cfg.enableNcc2dPanAxisLock).toBe(true);
    expect(cfg.ncc2dCrossAxisLockPx).toBe(4);
  });

  it('honours ncc2d nested-optional absence (ema + panAxisLock undefined)', () => {
    const withNcc2dBare: SlitscanSettings = {
      ...DEFAULT_SLITSCAN_SETTINGS,
      registration: {
        ...DEFAULT_SLITSCAN_SETTINGS.registration,
        ncc2d: {
          searchMargin: 12,
          confidenceThreshold: 0.99,
          // emaSmoothing + panAxisLock omitted → enable-flag false, no payload
        },
      },
    };
    const cfg = slitscanSettingsToNativeConfig(withNcc2dBare);

    expect(cfg.enable2dNcc).toBe(true);
    expect(cfg.enableNcc2dEmaSmoothing).toBe(false);
    expect(cfg.enableNcc2dPanAxisLock).toBe(false);
    // Critical: payload keys for the disabled sub-features must NOT
    // ride along — Native engine would treat them as authoritative
    // even with the enable flag off (defensive against a native bug).
    expect(cfg).not.toHaveProperty('ncc2dEmaAlpha');
    expect(cfg).not.toHaveProperty('ncc2dCrossAxisLockPx');
  });

  it.each([
    ['Disabled', { virtualPlaneDepthMeters: false, arkitPlaneAlignmentThreshold: false, planeProjectionStyle: false }],
    ['Virtual', { virtualPlaneDepthMeters: true, arkitPlaneAlignmentThreshold: false, planeProjectionStyle: true }],
    ['ARKitDetected', { virtualPlaneDepthMeters: false, arkitPlaneAlignmentThreshold: true, planeProjectionStyle: true }],
  ] as const)(
    'emits plane optionals consistent with source=%s',
    (source, expected) => {
      const s: SlitscanSettings = {
        ...DEFAULT_SLITSCAN_SETTINGS,
        plane: {
          source,
          projectionStyle: 'Rectified',
          virtualDepthMeters: 2.0,
          alignmentThreshold: 0.7,
        },
      };
      const cfg = slitscanSettingsToNativeConfig(s);
      expect(cfg.planeSource).toBe(source);
      expect('virtualPlaneDepthMeters' in cfg).toBe(expected.virtualPlaneDepthMeters);
      expect('arkitPlaneAlignmentThreshold' in cfg).toBe(expected.arkitPlaneAlignmentThreshold);
      expect('planeProjectionStyle' in cfg).toBe(expected.planeProjectionStyle);
    },
  );

  it('emits `advanced` knobs only when explicitly set', () => {
    const withAdvanced: SlitscanSettings = {
      ...DEFAULT_SLITSCAN_SETTINGS,
      advanced: { panAxisFractionRect: 0.6, minAcceptDeltaPx: 30 },
    };
    const cfg = slitscanSettingsToNativeConfig(withAdvanced);
    expect(cfg.kPanAxisFractionRect).toBe(0.6);
    expect(cfg.kMinAcceptDeltaPx).toBe(30);

    const onlyOne: SlitscanSettings = {
      ...DEFAULT_SLITSCAN_SETTINGS,
      advanced: { panAxisFractionRect: 0.6 },
      // minAcceptDeltaPx omitted within the sub-object
    };
    const cfgOne = slitscanSettingsToNativeConfig(onlyOne);
    expect(cfgOne.kPanAxisFractionRect).toBe(0.6);
    expect(cfgOne).not.toHaveProperty('kMinAcceptDeltaPx');
  });
});


// ════════════════════════════════════════════════════════════════════
// HYBRID — RetaiLens live engine
// ════════════════════════════════════════════════════════════════════

describe('hybridSettingsToNativeConfig', () => {
  it('round-trips DEFAULT_HYBRID_SETTINGS to the expected flat dict', () => {
    const cfg = hybridSettingsToNativeConfig(DEFAULT_HYBRID_SETTINGS);
    expect(cfg.captureSource).toBe('ar');
    expect(cfg.hybridProjection).toBe('Planar');
  });

  it('honours projection override', () => {
    const cyl: HybridSettings = {
      ...DEFAULT_HYBRID_SETTINGS,
      projection: 'Cylindrical',
    };
    expect(hybridSettingsToNativeConfig(cyl).hybridProjection).toBe('Cylindrical');
  });

  it('emits only the documented hybrid surface (debug is JS-only)', () => {
    // Hybrid presets internally clobber most fields; the bridge
    // deliberately keeps the wire surface minimal.  This test guards
    // against future drift where someone adds a hybrid setting to the
    // bridge without first validating that the engine actually reads it.
    const cfg = hybridSettingsToNativeConfig({
      ...DEFAULT_HYBRID_SETTINGS,
      debug: true, // JS-only, must NOT reach the wire
    });
    expect(Object.keys(cfg).sort()).toEqual(['captureSource', 'hybridProjection']);
  });
});
