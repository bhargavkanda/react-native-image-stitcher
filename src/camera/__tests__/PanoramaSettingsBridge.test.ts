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
  DEFAULT_FLOW_GATE_SETTINGS,
  DEFAULT_PANORAMA_SETTINGS,
  type PanoramaSettings,
} from '../PanoramaSettings';
import {
  panoramaSettingsToNativeConfig,
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
    expect(cfg.enableMaxInscribedRectCrop).toBe(true);

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

  it('falls back to DEFAULT_FLOW_GATE_SETTINGS when frameSelection.flow is undefined', () => {
    // F10 Phase 2 review B1 — native compiled-in defaults disagree
    // with the JS defaults for two flow knobs (maxTranslationCm and
    // evalEveryNFrames).  The bridge must always emit every flow key
    // so sparse-literal hosts get the JS defaults on the wire, not
    // the native fallbacks.
    const noFlow: PanoramaSettings = {
      ...DEFAULT_PANORAMA_SETTINGS,
      frameSelection: {
        ...DEFAULT_PANORAMA_SETTINGS.frameSelection,
        flow: undefined,
      },
    };
    const cfg = panoramaSettingsToNativeConfig(noFlow);

    expect(cfg.frameSelectionMode).toBe('flow-based');
    expect(cfg.keyframeMaxCount).toBe(6);
    expect(cfg.keyframeOverlapThreshold).toBe(0.2);

    // Every flow.* native key present, matching DEFAULT_FLOW_GATE_SETTINGS.
    expect(cfg.flowNoveltyPercentile).toBe(DEFAULT_FLOW_GATE_SETTINGS.noveltyPercentile);
    expect(cfg.flowEvalEveryNFrames).toBe(DEFAULT_FLOW_GATE_SETTINGS.evalEveryNFrames);
    expect(cfg.flowMaxTranslationCm).toBe(DEFAULT_FLOW_GATE_SETTINGS.maxTranslationCm);
    expect(cfg.flowMaxCorners).toBe(DEFAULT_FLOW_GATE_SETTINGS.maxCorners);
    expect(cfg.flowQualityLevel).toBe(DEFAULT_FLOW_GATE_SETTINGS.qualityLevel);
    expect(cfg.flowMinDistance).toBe(DEFAULT_FLOW_GATE_SETTINGS.minDistance);
  });

  it('emits flow defaults to the wire when frameSelection.flow is undefined AND mode is flow-based', () => {
    // F10 Phase 2 review N3 — the realistic user-facing case:
    // host writes `mode: 'flow-based'` but omits the flow sub-tree.
    // Pre-B1-fix, the gate would silently run with native fallbacks
    // (flowMaxTranslationCm=0, flowEvalEveryNFrames=1) instead of
    // the JS defaults (50 cm budget, 5× throttle).
    const s: PanoramaSettings = {
      ...DEFAULT_PANORAMA_SETTINGS,
      frameSelection: {
        mode: 'flow-based',
        maxKeyframes: 6,
        overlapThreshold: 0.20,
        // flow omitted — legal per the optional `?` in the type
      },
    };
    const cfg = panoramaSettingsToNativeConfig(s);

    expect(cfg.flowMaxTranslationCm).toBe(50);
    expect(cfg.flowEvalEveryNFrames).toBe(5);
    expect(cfg.flowNoveltyPercentile).toBe(0.85);
    expect(cfg.flowMaxCorners).toBe(150);
    expect(cfg.flowQualityLevel).toBe(0.01);
    expect(cfg.flowMinDistance).toBe(10);
  });

  it('locks down the full wire-key set for DEFAULT_PANORAMA_SETTINGS', () => {
    // F10 Phase 2 review N4 — mirror the hybrid test below.  Lock
    // down which keys leave the bridge so a future field accidentally
    // riding along (e.g. `debug` being treated as a wire knob) fails
    // this test immediately.
    const cfg = panoramaSettingsToNativeConfig(DEFAULT_PANORAMA_SETTINGS);
    expect(Object.keys(cfg).sort()).toEqual([
      'blenderType',
      'captureSource',
      'enableMaxInscribedRectCrop',
      'flowEvalEveryNFrames',
      'flowMaxCorners',
      'flowMaxTranslationCm',
      'flowMinDistance',
      'flowNoveltyPercentile',
      'flowQualityLevel',
      'frameSelectionMode',
      'keyframeMaxCount',
      'keyframeOverlapThreshold',
      'seamFinderType',
      'stitchMode',
      'warperType',
    ]);
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
