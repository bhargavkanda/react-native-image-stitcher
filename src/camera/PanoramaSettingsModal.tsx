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
   * Incremental engine choice for live realtime stitching (only used
   * when AR preview is on).
   *   'hybrid'   — Samsung-style: cylindrical projection + KLT
   *                optical flow refinement + feather blend.
   *   'firstwins' — Cylindrical full-frame warp + first-painted-wins
   *                  hard overlay (no OF refinement, no blending).
   *                  Was 'slitscan' but the implementation is full-
   *                  frame cylindrical, not Apple-style narrow strips.
   *
   * Both are A/B-comparable on the same scene by toggling this in
   * settings without restarting the app.
   */
  incrementalEngine: 'hybrid' | 'firstwins';
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
  incrementalEngine: 'hybrid',
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
              options={['hybrid', 'firstwins']}
              value={settings.incrementalEngine}
              onChange={(v) => update({ incrementalEngine: v as PanoramaSettings['incrementalEngine'] })}
              caption="Hybrid (default): spherical warp + KLT optical-flow refinement + feather blend — best general-purpose quality. FirstWins: spherical warp with anchor-frame priority — best for short, mostly-horizontal pans where you want the first frame to dominate; no later corrections."
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
