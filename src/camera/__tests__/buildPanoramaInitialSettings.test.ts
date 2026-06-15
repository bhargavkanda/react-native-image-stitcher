// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for buildPanoramaInitialSettings — the prop→settings-tree
 * translation that runs once at <Camera>'s mount.
 *
 * Coverage:
 *
 *   - Defaults (no prop overrides) reproduce DEFAULT_PANORAMA_SETTINGS
 *     when `isLowMemDevice=false`.
 *   - `isLowMemDevice=true` swaps blender + seamFinder defaults to the
 *     feather+skip fallback; other fields unchanged.
 *   - Every prop override routes to its hierarchical path: stitchMode →
 *     stitcher.stitchMode, defaultFlowMaxTranslationCm →
 *     frameSelection.flow.maxTranslationCm, etc.
 *   - Partial overrides leave non-overridden fields at the default.
 *
 * Plus a "wire-format integration" check: the produced settings tree,
 * fed through `panoramaSettingsToNativeConfig`, lands at the expected
 * flat dict.  This is the seam where the prop translation, the
 * hierarchical tree, and the bridge all meet — verifying it here means
 * <Camera>'s `incremental.start({ config })` call is correctly wired
 * end-to-end on the JS side (on-device run remains the integration
 * check across the JS/native boundary itself).
 */

import {
  DEFAULT_FLOW_GATE_SETTINGS,
  DEFAULT_PANORAMA_SETTINGS,
  type PanoramaSettings,
} from '../PanoramaSettings';
import { panoramaSettingsToNativeConfig } from '../PanoramaSettingsBridge';
import { buildPanoramaInitialSettings } from '../buildPanoramaInitialSettings';


describe('buildPanoramaInitialSettings', () => {
  it('returns DEFAULT_PANORAMA_SETTINGS verbatim when no overrides and not low-mem', () => {
    const s = buildPanoramaInitialSettings({}, false);
    expect(s).toEqual(DEFAULT_PANORAMA_SETTINGS);
  });

  it('swaps blender + seamFinder for the low-mem fallback', () => {
    const s = buildPanoramaInitialSettings({}, true);
    expect(s.stitcher.blenderType).toBe('feather');
    expect(s.stitcher.seamFinderType).toBe('skip');
    // Everything else stays at the static default.
    expect(s.stitcher.stitchMode).toBe(DEFAULT_PANORAMA_SETTINGS.stitcher.stitchMode);
    expect(s.stitcher.warperType).toBe(DEFAULT_PANORAMA_SETTINGS.stitcher.warperType);
    expect(s.frameSelection).toEqual(DEFAULT_PANORAMA_SETTINGS.frameSelection);
    expect(s.captureSource).toBe(DEFAULT_PANORAMA_SETTINGS.captureSource);
  });

  it('routes every prop override to its hierarchical path', () => {
    const s = buildPanoramaInitialSettings(
      {
        defaultCaptureSource: 'non-ar',
        defaultStitchMode: 'scans',
        defaultBlender: 'feather',
        defaultSeamFinder: 'skip',
        defaultWarper: 'cylindrical',
        defaultFlowNoveltyPercentile: 0.70,
        defaultFlowEvalEveryNFrames: 3,
        defaultFlowMaxTranslationCm: 12,
        defaultKeyframeMaxCount: 8,
        defaultKeyframeOverlapThreshold: 0.30,
        maxInscribedRectCrop: true,
      },
      false,
    );

    expect(s.captureSource).toBe('non-ar');
    expect(s.stitcher.stitchMode).toBe('scans');
    expect(s.stitcher.blenderType).toBe('feather');
    expect(s.stitcher.seamFinderType).toBe('skip');
    expect(s.stitcher.warperType).toBe('cylindrical');
    expect(s.frameSelection.flow?.noveltyPercentile).toBe(0.70);
    expect(s.frameSelection.flow?.evalEveryNFrames).toBe(3);
    expect(s.frameSelection.flow?.maxTranslationCm).toBe(12);
    expect(s.frameSelection.maxKeyframes).toBe(8);
    expect(s.frameSelection.overlapThreshold).toBe(0.30);
    expect(s.stitcher.enableMaxInscribedRectCrop).toBe(true);
  });

  it('maps maxInscribedRectCrop → stitcher.enableMaxInscribedRectCrop', () => {
    expect(
      buildPanoramaInitialSettings({ maxInscribedRectCrop: true }, false)
        .stitcher.enableMaxInscribedRectCrop,
    ).toBe(true);
    expect(
      buildPanoramaInitialSettings({ maxInscribedRectCrop: false }, false)
        .stitcher.enableMaxInscribedRectCrop,
    ).toBe(false);
    // Omitted ⇒ default (false — inscribed-rect crop is opt-in), and the
    // low-mem fallback must not flip it.
    expect(
      buildPanoramaInitialSettings({}, false)
        .stitcher.enableMaxInscribedRectCrop,
    ).toBe(false);
    expect(
      buildPanoramaInitialSettings({}, true)
        .stitcher.enableMaxInscribedRectCrop,
    ).toBe(false);
  });

  it('maps defaultMaxKeyframeIntervalMs → frameSelection.maxKeyframeIntervalMs', () => {
    expect(
      buildPanoramaInitialSettings({ defaultMaxKeyframeIntervalMs: 3500 }, false)
        .frameSelection.maxKeyframeIntervalMs,
    ).toBe(3500);
    // 0 explicitly disables the time-budget force-accept — it is NOT
    // nullish, so `??` does not replace it with the default.
    expect(
      buildPanoramaInitialSettings({ defaultMaxKeyframeIntervalMs: 0 }, false)
        .frameSelection.maxKeyframeIntervalMs,
    ).toBe(0);
    // Omitted ⇒ the 1500 ms (1.5 s) default.
    expect(
      buildPanoramaInitialSettings({}, false)
        .frameSelection.maxKeyframeIntervalMs,
    ).toBe(1500);
  });

  it('leaves non-overridden fields at the default (partial override)', () => {
    const s = buildPanoramaInitialSettings(
      { defaultStitchMode: 'panorama' },
      false,
    );

    // The override took effect …
    expect(s.stitcher.stitchMode).toBe('panorama');

    // … and every other field stays at the corresponding default.
    expect(s.stitcher.warperType).toBe(DEFAULT_PANORAMA_SETTINGS.stitcher.warperType);
    expect(s.stitcher.blenderType).toBe(DEFAULT_PANORAMA_SETTINGS.stitcher.blenderType);
    expect(s.stitcher.seamFinderType).toBe(DEFAULT_PANORAMA_SETTINGS.stitcher.seamFinderType);
    expect(s.frameSelection).toEqual(DEFAULT_PANORAMA_SETTINGS.frameSelection);
    expect(s.captureSource).toBe(DEFAULT_PANORAMA_SETTINGS.captureSource);
  });

  it('produces wire-format-clean output when piped through the bridge', () => {
    // The end-to-end JS-side path: props → buildPanoramaInitialSettings →
    // panoramaSettingsToNativeConfig.  Verifying it here catches drift
    // at any of the three layers (prop name, type-tree shape, bridge
    // adapter) with a single assertion.
    const overrides = {
      defaultCaptureSource: 'non-ar' as const,
      defaultStitchMode: 'scans' as const,
      defaultFlowMaxTranslationCm: 25,
    };
    const settings: PanoramaSettings =
      buildPanoramaInitialSettings(overrides, false);
    const wire = panoramaSettingsToNativeConfig(settings);

    expect(wire.captureSource).toBe('non-ar');
    expect(wire.stitchMode).toBe('scans');
    expect(wire.flowMaxTranslationCm).toBe(25);
    // Defaulted fields still on the wire with their default value.
    expect(wire.warperType).toBe('spherical');
    expect(wire.frameSelectionMode).toBe('flow-based');
    expect(wire.flowNoveltyPercentile).toBe(0.85);
  });

  // ── v0.16 — JSON-object props (stitcher / frameSelection) ────────────

  it('accepts a `stitcher` JSON object (partial; unset fields keep defaults)', () => {
    const s = buildPanoramaInitialSettings(
      { stitcher: { warperType: 'plane', blenderType: 'feather' } },
      false,
    );
    expect(s.stitcher.warperType).toBe('plane');
    expect(s.stitcher.blenderType).toBe('feather');
    // Unset object fields fall back to the SDK defaults.
    expect(s.stitcher.seamFinderType).toBe(
      DEFAULT_PANORAMA_SETTINGS.stitcher.seamFinderType,
    );
    expect(s.stitcher.stitchMode).toBe(
      DEFAULT_PANORAMA_SETTINGS.stitcher.stitchMode,
    );
  });

  it('accepts a `frameSelection` JSON object and DEEP-merges `flow`', () => {
    const s = buildPanoramaInitialSettings(
      {
        frameSelection: {
          maxKeyframes: 5,
          overlapThreshold: 0.25,
          flow: { maxCorners: 99 },
        },
      },
      false,
    );
    expect(s.frameSelection.maxKeyframes).toBe(5);
    expect(s.frameSelection.overlapThreshold).toBe(0.25);
    // flow.maxCorners overridden; the rest of flow stays at defaults.
    expect(s.frameSelection.flow?.maxCorners).toBe(99);
    expect(s.frameSelection.flow?.noveltyPercentile).toBe(
      DEFAULT_FLOW_GATE_SETTINGS.noveltyPercentile,
    );
    expect(s.frameSelection.flow?.minDistance).toBe(
      DEFAULT_FLOW_GATE_SETTINGS.minDistance,
    );
    // Untouched scalar stays default.
    expect(s.frameSelection.maxKeyframeIntervalMs).toBe(
      DEFAULT_PANORAMA_SETTINGS.frameSelection.maxKeyframeIntervalMs,
    );
  });

  it('object props WIN over the matching flat default* props', () => {
    const s = buildPanoramaInitialSettings(
      {
        defaultWarper: 'cylindrical',
        defaultKeyframeMaxCount: 3,
        stitcher: { warperType: 'plane' },
        frameSelection: { maxKeyframes: 9 },
      },
      false,
    );
    expect(s.stitcher.warperType).toBe('plane'); // object beats defaultWarper
    expect(s.frameSelection.maxKeyframes).toBe(9); // object beats flat
  });
});
