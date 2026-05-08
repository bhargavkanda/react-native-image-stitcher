/**
 * PanoramaSettingsModal — runtime A/B testing surface for the
 * stitcher pipeline.  Operators in the field can toggle warper,
 * blender, and tuning constants between captures to see what
 * looks best on real shelf scenes.
 *
 * The modal is presentational: the host owns the settings state
 * (typically `useState<PanoramaSettings>`) and renders the modal
 * with `visible` toggled by a gear-icon press in the capture
 * header.  Settings flow OUT via `onChange` for each tweak.
 *
 * Why expose this as an SDK component instead of leaving it to
 * each host?  The set of tunable knobs IS the SDK's contract —
 * if a new setting is added (e.g. registration MP) the SDK ships
 * the UI for it in lockstep with the param itself, instead of
 * forcing every host app to update its settings screen.
 */

import React from 'react';
import {
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';


export interface PanoramaSettings {
  warperType: 'plane' | 'cylindrical' | 'spherical';
  blenderType: 'multiband' | 'feather';
  /**
   * Seam finder strategy.  "graphcut" finds optimal seams before
   * blending (cleaner output, pairs with multiband, more memory).
   * "skip" streams warp+feed (lower peak memory, fine with feather).
   */
  seamFinderType: 'graphcut' | 'skip';
  /**
   * Phase 4.4 EXPERIMENTAL: when true, the host swaps the
   * vision-camera-backed CameraView for an ARKit-backed ARCameraView
   * during panorama capture.  Default false (keeps the existing
   * stitcher flow untouched).  Phase 5 will add AR-backed photo /
   * video capture and pose-driven stitching; until then this is
   * preview-only — useful for verifying the AR session renders
   * cleanly on the operator's device before we cut over.
   */
  useARPreview: boolean;
  /**
   * V15 — Incremental engine choice for live realtime stitching.
   *   'hybrid'           — Whole-frame projection + feature matching;
   *                        planar by default (was cylindrical).
   *   'slitscan-rotate'  — V13.0a baseline + 1D NCC for rotation
   *                        wobble correction.
   *   'slitscan-both'    — DEFAULT.  V13.0a + no accept gate +
   *                        feather blend.  Iterate via per-stage
   *                        toggles below.
   *
   * All three are A/B-comparable on the same scene by toggling here
   * without restarting the app.
   */
  incrementalEngine:
    | 'hybrid'
    | 'slitscan-rotate'
    | 'slitscan-both';

  /**
   * V15 — Slit-scan slit width (fraction of pan-axis retained per
   * frame).  Range 0.10 – 0.70.  Smaller = less within-slit multi-
   * depth disagreement but tighter overlap budget at fast pans.
   * Default 0.30.  Only applied to slitscan-* engines.
   */
  slitWidthFraction: number;

  /**
   * V15 — Per-stage correction toggles for slitscan-both.  Settings
   * UI exposes these so iteration happens via toggles, not rebuilds.
   */
  acceptGate: 0 | 50;
  enableTriangulation: boolean;
  enableTriAccumulator: boolean;
  enable2dNcc: boolean;
  enableRansacHomography: boolean;
  paintMode: 'FirstPaintedWins' | 'FeatherBlend';
  hybridProjection: 'Cylindrical' | 'Planar';
  /** 1D NCC search radius (slitscan-rotate only). */
  nccSearchRadius1d: number;
  /** V15.0b — Trax-style plane projection: warp each accepted frame
   *  onto an ARKit-detected vertical plane instead of the pose-only
   *  rectilinear canvas.  Slit-scan modes only.  Requires plane
   *  detection (2–5 s on non-LiDAR; near-instant on LiDAR). */
  useDetectedPlane: boolean;
  /** V15.0c — sliver position within the camera frame.  'Center' is
   *  V13.x default.  'Bottom' takes leading-edge content for top-to-
   *  bottom pan; 'Top' for bottom-to-top pan. */
  sliverPosition: 'Center' | 'Bottom' | 'Top';
  /** V15.0c — paint full first frame, then add slivers as user pans.
   *  Useful with 'Bottom' or 'Top' sliverPosition. */
  firstFrameFullFrame: boolean;
  /** Hard cap on hold duration (ms).  0 disables auto-stop. */
  maxRecordingMs: number;
  /** Frames per second of recording to sample for stitching. */
  framesPerSecond: number;
  /** Floor / ceiling on extracted frame count. */
  minFrames: number;
  maxFrames: number;
  /** JPEG quality (0-100) for output panorama. */
  quality: number;
}


// Per-device default selection.  We read the iPhone's physical
// RAM at SDK module load (exposed by `RetaiLensStitcher`'s
// `constantsToExport`) and pick the heaviest blender + seam
// finder combo that fits.  Threshold (2 GB) is conservative —
// iPhone 6s through iPhone X have 2 GB exactly; below that
// (iPhone 6 / 5s) is unsupported by RN 0.84 anyway.  The user
// can still flip ANY of these in the settings modal at runtime;
// this only chooses the INITIAL default.
const _physicalMemoryBytes: number = (() => {
  const m = (NativeModules as Record<string, unknown>).RetaiLensStitcher;
  const bytes =
    m && typeof m === 'object'
      ? (m as { physicalMemoryBytes?: number }).physicalMemoryBytes
      : undefined;
  return typeof bytes === 'number' ? bytes : 0;
})();

const _isLowMem = _physicalMemoryBytes > 0
  && _physicalMemoryBytes < 2 * 1024 * 1024 * 1024;

// One-line diagnostic so the host's Metro console shows what the
// SDK saw at module load.  If `physicalMemoryBytes=0` here, the
// native bridge's `constantsToExport` isn't being picked up by
// React Native and we should investigate the @objc registration.
// The defaults always pick the SAFE fallback (multiband+graphcut)
// when the value is 0 — this log is the only signal we have.
// eslint-disable-next-line no-console
console.log(
  '[capture-sdk] PanoramaSettings defaults: '
  + `physicalMemoryBytes=${_physicalMemoryBytes} `
  + `isLowMem=${_isLowMem} `
  + `→ blender=${_isLowMem ? 'feather' : 'multiband'} `
  + `seam=${_isLowMem ? 'skip' : 'graphcut'}`,
);


export const DEFAULT_PANORAMA_SETTINGS: PanoramaSettings = {
  warperType: 'plane',
  // High-quality defaults on devices with ≥2 GB RAM (iPhone X+):
  // MultiBandBlender + GraphCutSeamFinder, the same combo
  // cv::Stitcher::PANORAMA uses internally and what produced the
  // sharpest output during iteration.
  // Low-memory devices (<2 GB) fall back to FeatherBlender + skip
  // seam (streams warp+feed) so peak memory stays under the
  // tighter jetsam threshold.  Either way, the user can switch
  // both in the settings modal.
  blenderType: _isLowMem ? 'feather' : 'multiband',
  seamFinderType: _isLowMem ? 'skip' : 'graphcut',
  // AR-backed capture is the default — vision-camera path is kept as
  // a fallback while we shake out edge cases.
  useARPreview: true,
  // V15 — slitscan-both is the default; iterate via per-stage toggles
  // below (no rebuilds needed).
  incrementalEngine: 'slitscan-both',
  slitWidthFraction: 0.30,
  acceptGate: 0,
  enableTriangulation: false,
  enableTriAccumulator: false,
  enable2dNcc: false,
  enableRansacHomography: false,
  // V15.0c — Ram observation: FirstPaintedWins is consistently the best
  // output across all combinations.  Default switched from FeatherBlend.
  paintMode: 'FirstPaintedWins',
  hybridProjection: 'Planar',
  nccSearchRadius1d: 15,
  useDetectedPlane: false,
  // V15.0c — sliver tweaks: leading-edge sliver from BOTTOM for typical
  // top-to-bottom pan + full first-frame anchor produced the best
  // outputs in early iteration.
  sliverPosition: 'Bottom',
  firstFrameFullFrame: true,
  maxRecordingMs: 8000,
  framesPerSecond: 3,
  minFrames: 6,
  maxFrames: 16,
  quality: 85,
};


export interface PanoramaSettingsModalProps {
  visible: boolean;
  settings: PanoramaSettings;
  onChange: (next: PanoramaSettings) => void;
  onClose: () => void;
}


export function PanoramaSettingsModal({
  visible,
  settings,
  onChange,
  onClose,
}: PanoramaSettingsModalProps): React.JSX.Element {
  const update = (patch: Partial<PanoramaSettings>) =>
    onChange({ ...settings, ...patch });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Panorama settings</Text>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close settings"
              style={styles.closeBtn}
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.debugLine}>
              {`device: physicalMemoryBytes=${_physicalMemoryBytes} `
                + `(${(_physicalMemoryBytes / (1024 ** 3)).toFixed(2)} GB) · `
                + `isLowMem=${_isLowMem ? 'yes' : 'no'} · `
                + `default blender=${_isLowMem ? 'feather' : 'multiband'}`}
            </Text>
            <SectionHeader title="Projection" />
            <SegmentedControl
              options={['plane', 'cylindrical', 'spherical']}
              value={settings.warperType}
              onChange={(v) => update({ warperType: v as PanoramaSettings['warperType'] })}
              caption="Plane: flat output, good for short pans / close-up shelves. Cylindrical: rotational mid-arc. Spherical: wide pans (180°+)."
            />

            <SectionHeader title="Blender" />
            <SegmentedControl
              options={['multiband', 'feather']}
              value={settings.blenderType}
              onChange={(v) => update({ blenderType: v as PanoramaSettings['blenderType'] })}
              caption="MultiBand: best seams when exposure is consistent. Feather: faster, no halo artifacts when exposure varies."
            />

            <SectionHeader title="Seam finder" />
            <SegmentedControl
              options={['graphcut', 'skip']}
              value={settings.seamFinderType}
              onChange={(v) => update({ seamFinderType: v as PanoramaSettings['seamFinderType'] })}
              caption="GraphCut: optimal seams, pairs best with MultiBand (more memory). Skip: streams warp+feed (lower peak memory, fine with Feather)."
            />

            <SectionHeader title="AR preview" />
            <SegmentedControl
              options={['on', 'off']}
              value={settings.useARPreview ? 'on' : 'off'}
              onChange={(v) => update({ useARPreview: v === 'on' })}
              caption="ARKit pose-aware preview + capture (default). Off falls back to the vision-camera path."
            />

            <SectionHeader title="Incremental engine (AR mode only)" />
            <SegmentedControl
              options={['hybrid', 'slitscan-rotate', 'slitscan-both']}
              value={settings.incrementalEngine}
              onChange={(v) => update({ incrementalEngine: v as PanoramaSettings['incrementalEngine'] })}
              caption="hybrid: whole-frame projection + feature matching (planar by default). slitscan-rotate: V13.0a + 1D NCC for rotation wobble. slitscan-both (default): V13.0a + no accept gate + feather blend; iterate via toggles below."
            />

            <SectionHeader title="Slit width (slit-scan modes only)" />
            <SegmentedControl
              options={['0.01', '0.05', '0.10', '0.20', '0.30', '0.50']}
              value={settings.slitWidthFraction.toFixed(2)}
              onChange={(v) => update({ slitWidthFraction: parseFloat(v) })}
              caption="Fraction of pan-axis retained per sliver. 0.01 ≈ 10 px (Apple-thin), 0.05 ≈ 54 px, 0.10 ≈ 108 px, 0.30 ≈ 324 px (V15 default), 0.50+ wider. Smaller = less within-slit depth disagreement, but tighter overlap budget at fast pans."
            />

            <SectionHeader title="Sliver position (slit-scan modes only)" />
            <SegmentedControl
              options={['Center', 'Bottom', 'Top']}
              value={settings.sliverPosition}
              onChange={(v) => update({ sliverPosition: v as PanoramaSettings['sliverPosition'] })}
              caption="Where on the camera sensor frame the sliver is taken. Center = V13.x default. Bottom = leading edge for top-to-bottom landscape pan (recommended). Top = leading edge for bottom-to-top pan."
            />

            <SectionHeader title="First frame: full-frame anchor (slit-scan modes)" />
            <SegmentedControl
              options={['off', 'on']}
              value={settings.firstFrameFullFrame ? 'on' : 'off'}
              onChange={(v) => update({ firstFrameFullFrame: v === 'on' })}
              caption="When ON, the FIRST accepted frame paints the full camera frame at the canvas anchor; subsequent frames still use the configured sliver clip. Recommended ON when sliverPosition is Bottom/Top so the canvas is anchored with maximum first-frame content."
            />

            <SectionHeader title="Accept gate (slit-scan modes only)" />
            <SegmentedControl
              options={['0', '50']}
              value={String(settings.acceptGate)}
              onChange={(v) => update({ acceptGate: parseInt(v, 10) as PanoramaSettings['acceptGate'] })}
              caption="0 = accept on every frame (Apple-dense slit-scan, default). 50 = V13.0g throttle (one accept per 50px advance)."
            />

            <SectionHeader title="Paint mode (slit-scan modes only)" />
            <SegmentedControl
              options={['FirstPaintedWins', 'FeatherBlend']}
              value={settings.paintMode}
              onChange={(v) => update({ paintMode: v as PanoramaSettings['paintMode'] })}
              caption="FirstPaintedWins: protect already-painted pixels (V13.0e+ baseline; sharper, hard seams). FeatherBlend (default): alpha-blend new content into already-painted overlap (V15 hypothesis: smooths seams when accept gate is 0)."
            />

            <SectionHeader title="Triangulation parallax (slitscan-both)" />
            <SegmentedControl
              options={['off', 'on']}
              value={settings.enableTriangulation ? 'on' : 'off'}
              onChange={(v) => update({ enableTriangulation: v === 'on' })}
              caption="V13.0e+ ORB triangulation + median-Z parallax correction.  Adds ~10ms/accept.  Known limitation: per-accept correction can over-shoot, leaving gaps in the canvas — disable if output stops updating."
            />

            <SectionHeader title="2D NCC fine-alignment (slitscan-both)" />
            <SegmentedControl
              options={['off', 'on']}
              value={settings.enable2dNcc ? 'on' : 'off'}
              onChange={(v) => update({ enable2dNcc: v === 'on' })}
              caption="V13.0g 2D NCC after triangulation.  Refines (Δx, Δy) translation via cv::matchTemplate."
            />

            <SectionHeader title="RANSAC homography (slitscan-both)" />
            <SegmentedControl
              options={['off', 'on']}
              value={settings.enableRansacHomography ? 'on' : 'off'}
              onChange={(v) => update({ enableRansacHomography: v === 'on' })}
              caption="V14.0a RANSAC 3×3 homography per slit + cv::warpPerspective.  Supersedes rectangular paste when successful (8 inliers, det>1e-6).  Known limitation: per-frame homography can absorb pan advance as scale, shrinking each warped sliver — leaves visible gaps between slits."
            />

            <SectionHeader title="Hybrid projection" />
            <SegmentedControl
              options={['Planar', 'Cylindrical']}
              value={settings.hybridProjection}
              onChange={(v) => update({ hybridProjection: v as PanoramaSettings['hybridProjection'] })}
              caption="V15 hybrid mode default = Planar (cv::detail::PlaneWarper, well-behaved <60° pans).  Cylindrical preserves V12.x – V14.0a behaviour but has the documented landscape roll-asymmetry bug."
            />

            <SectionHeader title="Plane projection (V14.0b — Trax Virtual Ruler)" />
            <SegmentedControl
              options={['off', 'on']}
              value={settings.useDetectedPlane ? 'on' : 'off'}
              onChange={(v) => update({ useDetectedPlane: v === 'on' })}
              caption="When ON (slit-scan modes), each accepted frame is warped onto an ARKit-detected vertical plane (the actual fixture wall in 3D).  Composes with paint mode; skips slit-scan stage refinements (1D NCC, 2D NCC, RANSAC).  Requires 2–5 s plane detection on non-LiDAR devices.  Falls back to slit-scan until a plane is detected."
            />

            <SectionHeader title="Recording cap" />
            <SegmentedControl
              options={['4 s', '6 s', '8 s', '10 s']}
              value={`${Math.round(settings.maxRecordingMs / 1000)} s`}
              onChange={(v) => update({ maxRecordingMs: parseInt(v, 10) * 1000 })}
              caption="Auto-stops the hold-recording at this duration. Combined with FPS below, controls how many frames the stitcher processes."
            />

            <SectionHeader title="Frame sampling" />
            <SegmentedControl
              options={['2', '3', '4']}
              value={String(settings.framesPerSecond)}
              onChange={(v) => update({ framesPerSecond: parseInt(v, 10) })}
              caption={`Frames per second of recording extracted for stitching. Lower = faster but riskier overlap.`}
            />
            <View style={styles.row}>
              <Text style={styles.label}>Frame count clamp</Text>
              <SegmentedControl
                options={['4-12', '6-16', '8-20']}
                value={`${settings.minFrames}-${settings.maxFrames}`}
                onChange={(v) => {
                  const [min, max] = v.split('-').map((n) => parseInt(n, 10));
                  update({ minFrames: min, maxFrames: max });
                }}
                caption="Floor and ceiling for frames extracted, regardless of duration × FPS."
              />
            </View>

            <SectionHeader title="JPEG quality" />
            <SegmentedControl
              options={['70', '85', '92']}
              value={String(settings.quality)}
              onChange={(v) => update({ quality: parseInt(v, 10) })}
              caption="Higher = bigger files, sharper detail. 85 is the recommended default."
            />

            <Pressable
              onPress={() => onChange(DEFAULT_PANORAMA_SETTINGS)}
              style={styles.resetBtn}
              accessibilityRole="button"
              accessibilityLabel="Reset to defaults"
            >
              <Text style={styles.resetText}>Reset to defaults</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}


function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}


function SegmentedControl({
  options,
  value,
  onChange,
  caption,
}: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
  caption?: string;
}) {
  return (
    <View>
      <View style={styles.segmentedRow}>
        {options.map((opt) => {
          const selected = opt === value;
          return (
            <Pressable
              key={opt}
              onPress={() => onChange(opt)}
              style={[
                styles.segment,
                selected && styles.segmentSelected,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${opt}${selected ? ' (selected)' : ''}`}
            >
              <Text
                style={[
                  styles.segmentText,
                  selected && styles.segmentTextSelected,
                ]}
              >
                {opt}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
    maxHeight: '88%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.15)',
  },
  title: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '300',
    lineHeight: 24,
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  sectionHeader: {
    color: '#ffffff',
    opacity: 0.85,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  row: {
    marginTop: 4,
  },
  label: {
    color: '#ffffff',
    opacity: 0.85,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  segmentedRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: {
    backgroundColor: '#ffffff',
  },
  segmentText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
    opacity: 0.85,
  },
  segmentTextSelected: {
    color: '#000000',
    fontWeight: '700',
    opacity: 1,
  },
  caption: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    marginTop: 6,
    lineHeight: 16,
  },
  debugLine: {
    color: 'rgba(255,200,0,0.85)',
    fontFamily: 'Menlo',
    fontSize: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(255,200,0,0.08)',
    borderRadius: 6,
    marginBottom: 4,
  },
  resetBtn: {
    marginTop: 28,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
  },
  resetText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
});
