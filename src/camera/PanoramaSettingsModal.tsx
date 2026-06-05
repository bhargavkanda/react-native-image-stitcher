// SPDX-License-Identifier: Apache-2.0
/**
 * PanoramaSettingsModal — runtime tuning surface for <Camera>'s
 * batch-keyframe panorama capture.
 *
 * v0.4 rewrite (Phase 2 of F10):
 * ──────────────────────────────
 *
 * The v0.3 modal exposed a flat 45-field surface that mixed
 * batch-keyframe knobs with slit-scan, hybrid, and video-recording
 * fallback fields the engine never reads in <Camera>'s
 * `engine: 'batch-keyframe'` path.  The 2026-05-22 audit (v0.3.0
 * CHANGELOG) traced every field's native consumer and proved most of
 * the cross-engine fields were dead surface in this modal.
 *
 * v0.4 narrows the modal to exactly the surface <Camera> consumes:
 * the `PanoramaSettings` type defined in `./PanoramaSettings.ts`.  Each
 * section in the modal mirrors a sub-tree of that type — operators see
 * the same shape in the UI as the code, and host apps that want to
 * tune slit-scan or hybrid engines build their own analogous
 * SlitscanSettingsModal / HybridSettingsModal on top of those types.
 *
 * UI structure (matches the type tree):
 *
 *   - Debug                       (top-level, `debug`)
 *   - Frame selection             (`frameSelection`, closed by default)
 *       - Mode
 *       - Max keyframes
 *       - Overlap threshold
 *       - Flow tunables           (`frameSelection.flow`, only when
 *                                  mode === 'flow-based')
 *           - Max corners
 *           - Quality level
 *           - Min distance
 *           - Max translation cm
 *           - Novelty percentile
 *           - Eval every N frames
 *   - Stitcher                    (`stitcher`, closed by default)
 *       - Stitch mode
 *       - Warper type
 *       - Blender
 *       - Seam finder
 *       - Inscribed-rect crop
 *   - Reset to defaults           (button)
 *
 * Note: `captureSource` (AR vs non-AR) is NOT surfaced here.  The
 * camera-screen AR toggle owns that state — Camera.tsx overrides the
 * native bridge's `captureSource` with the derived
 * `effectiveCaptureSource` so settings and runtime stay in sync.
 *
 * The reusable `Accordion` + `SectionHeader` + `SegmentedControl` +
 * `Tag` helpers from the v0.3 modal are preserved verbatim — only the
 * data-binding layer changed.
 */

import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  DEFAULT_FLOW_GATE_SETTINGS,
  DEFAULT_PANORAMA_SETTINGS,
  type BatchStitcherSettings,
  type CaptureBaseSettings,
  type FlowGateSettings,
  type FrameSelectionSettings,
  type PanoramaSettings,
} from './PanoramaSettings';
import {
  getPhysicalMemoryBytes,
  isLowMemDevice,
} from './lowMemDevice';


// ─── Device-memory diagnostic (informational only) ─────────────────
//
// Read once at module load via the shared `lowMemDevice` helper.  We
// surface this as a single Menlo-monospace line at the top of the
// modal body so operators can see what the SDK detected — useful for
// diagnosing "why am I OOMing on this device?" questions.  The same
// helper feeds <Camera>'s initial-settings device adaptation; they
// were duplicated implementations pre-Phase-2-fix.

const _physicalMemoryBytes = getPhysicalMemoryBytes();
const _isLowMem = isLowMemDevice();


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
  // ─── Sub-tree update helpers ─────────────────────────────────────
  //
  // Each settings sub-tree has its own update helper that
  // non-destructively patches that branch and re-emits the whole
  // settings object via `onChange`.  Call sites stay short
  // (`updateStitcher({ stitchMode: 'scans' })`) and avoid the
  // nested-spread boilerplate the hierarchical shape would otherwise
  // require at every callsite.
  //
  // Why not a generic deep-merge?  Type-safety: each helper takes
  // exactly the `Partial<SubTree>` the section it backs can patch.
  // A generic helper would accept arbitrary nested keys and break the
  // type-level guarantee that the modal only mutates what its
  // matching settings type defines.

  const updateBase = (patch: Partial<CaptureBaseSettings>) =>
    onChange({ ...settings, ...patch });

  const updateStitcher = (patch: Partial<BatchStitcherSettings>) =>
    onChange({
      ...settings,
      stitcher: { ...settings.stitcher, ...patch },
    });

  const updateFrameSelection = (patch: Partial<FrameSelectionSettings>) =>
    onChange({
      ...settings,
      frameSelection: { ...settings.frameSelection, ...patch },
    });

  // Flow has an extra wrinkle: `frameSelection.flow` is optional.
  // We materialise it from `DEFAULT_FLOW_GATE_SETTINGS` (the
  // canonical FlowGateSettings defaults — see PanoramaSettings.ts)
  // when patching from "undefined" — happens if a host starts with
  // a custom settings literal that omits the sub-tree.
  const updateFlow = (patch: Partial<FlowGateSettings>) =>
    onChange({
      ...settings,
      frameSelection: {
        ...settings.frameSelection,
        flow: {
          ...(settings.frameSelection.flow ?? DEFAULT_FLOW_GATE_SETTINGS),
          ...patch,
        },
      },
    });

  // Frame-selection mode controls the visibility of the nested
  // Flow-tunables section.  Mirrors the type-level optionality of
  // `frameSelection.flow`.
  const showFlowTunables = settings.frameSelection.mode === 'flow-based';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
      // v0.12.0 — RN's iOS Modal defaults to portrait-only.  When a
      // host removes its UIInterfaceOrientations portrait lock to
      // support landscape capture, opening this modal while in
      // landscape would force iOS to rotate the window scene to
      // portrait, then the underlying <Camera>'s ARSession can end
      // up with stale display-transform state on dismiss (preview
      // renders sideways).  Declaring all orientations keeps the
      // window aligned with the device throughout the modal cycle.
      supportedOrientations={[
        'portrait',
        'portrait-upside-down',
        'landscape-left',
        'landscape-right',
      ]}
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
                + `current blender=${settings.stitcher.blenderType} `
                + `(low-mem fallback=${_isLowMem ? 'feather' : 'multiband'})`}
            </Text>

            {/* ──────────────────────────────────────────────
             *  DEBUG (top-level, `debug`)
             *
             *  Note: `captureSource` (AR vs non-AR) is intentionally
             *  NOT surfaced here — the camera-screen AR toggle is the
             *  sole source of truth.  Camera.tsx computes
             *  `effectiveCaptureSource` from `arPreference + lens +
             *  AR-device-support` and overrides `settings.captureSource`
             *  on the bridge call, so the native engine always agrees
             *  with the runtime preview.  Exposing a second control
             *  here led to silent split-state where the modal value
             *  disagreed with the on-screen toggle.
             * ────────────────────────────────────────────── */}
            <SectionHeader title="Debug" />
            <SegmentedControl
              options={['off', 'on']}
              value={settings.debug ? 'on' : 'off'}
              onChange={(v) => updateBase({ debug: v === 'on' })}
              caption="When ON, <Camera> mounts the diagnostic pills (memory, keyframes, orientation), the detailed metrics overlay, and the stitch-stats toast on every successful finalize.  OFF (default) — production end-user UI."
            />

            {/* ──────────────────────────────────────────────
             *  FRAME SELECTION (`frameSelection` sub-tree, closed by default)
             *
             *  Placed above Stitcher because keyframe-gate tuning is
             *  the more frequently touched control surface during
             *  capture-quality troubleshooting.  Stitcher knobs are
             *  rarely changed at runtime.
             *
             *  Nested Flow-tunables section reveals when mode is
             *  flow-based (mirrors the `frameSelection.flow` optional
             *  on the type).
             * ────────────────────────────────────────────── */}
            <Accordion title="Frame selection (KeyframeGate)">
              <SectionHeader title="Mode" />
              <SegmentedControl
                options={['time-based', 'pose-based', 'flow-based']}
                value={settings.frameSelection.mode}
                onChange={(v) => updateFrameSelection({
                  mode: v as FrameSelectionSettings['mode'],
                })}
                caption="flow-based (default): sparse Shi-Tomasi + KLT optical flow.  Plane-independent.  pose-based: plane-overlap when a plane is latched, angular fallback otherwise — cheap but conservative.  time-based: gate disabled; every frame accepted up to maxKeyframes."
              />
              <SectionHeader title="Max keyframes per capture" />
              <SegmentedControl
                options={['3', '4', '5', '6', '8', '10']}
                value={String(settings.frameSelection.maxKeyframes)}
                onChange={(v) => updateFrameSelection({
                  maxKeyframes: parseInt(v, 10),
                })}
                caption="Hard cap on accepted keyframes; native clamps to [3, 10].  6 (default) matches Samsung Pano's behaviour and is the sweet spot for cv::Stitcher BA convergence."
              />
              <SectionHeader title="Overlap threshold (new content per keyframe)" />
              <SegmentedControl
                options={['20%', '30%', '40%', '50%', '60%']}
                value={`${Math.round(settings.frameSelection.overlapThreshold * 100)}%`}
                onChange={(v) => updateFrameSelection({
                  overlapThreshold: parseInt(v, 10) / 100,
                })}
                caption="Required NEW-content fraction.  20% (default): generous, ~5–6 keyframes for a 90° pan.  Native clamps to [10%, 80%]."
              />

              {showFlowTunables && (
                <View style={styles.nested}>
                  <Text style={styles.nestedLabel}>Flow tuning</Text>
                  <SectionHeader title="Max corners (Shi-Tomasi)" />
                  <SegmentedControl
                    options={['50', '100', '150', '200', '300']}
                    value={String(settings.frameSelection.flow?.maxCorners
                      ?? DEFAULT_FLOW_GATE_SETTINGS.maxCorners)}
                    onChange={(v) => updateFlow({ maxCorners: parseInt(v, 10) })}
                    caption="More corners = more robust median displacement, slower detect.  150 (default) ~ 15–25 ms / frame on Galaxy A35.  Native clamps to [50, 300]."
                  />
                  <SectionHeader title="Quality level (Shi-Tomasi)" />
                  <SegmentedControl
                    options={['0.005', '0.01', '0.02', '0.03', '0.05']}
                    value={String(settings.frameSelection.flow?.qualityLevel
                      ?? DEFAULT_FLOW_GATE_SETTINGS.qualityLevel)}
                    onChange={(v) => updateFlow({ qualityLevel: parseFloat(v) })}
                    caption="Lower lets weaker corners in; higher demands stronger corners.  0.01 (default).  Clamped to [0.005, 0.05]."
                  />
                  <SectionHeader title="Min distance (working-resolution px)" />
                  <SegmentedControl
                    options={['5', '8', '10', '15', '20']}
                    value={String(settings.frameSelection.flow?.minDistance
                      ?? DEFAULT_FLOW_GATE_SETTINGS.minDistance)}
                    onChange={(v) => updateFlow({ minDistance: parseInt(v, 10) })}
                    caption="Min pixel distance between detected corners (working res = 720 px longest side).  10 (default).  Clamped to [1, 50]."
                  />
                  <SectionHeader title="Translation budget (cm)" />
                  <SegmentedControl
                    options={['0', '5', '8', '12', '20', '50']}
                    value={String(settings.frameSelection.flow?.maxTranslationCm
                      ?? DEFAULT_FLOW_GATE_SETTINGS.maxTranslationCm)}
                    onChange={(v) => updateFlow({
                      maxTranslationCm: parseInt(v, 10),
                    })}
                    caption="Force-accept the next frame once the operator has translated this many cm since the last keyframe, even when novelty < threshold.  Bounds parallax so cv::Stitcher's matcher can handle the input.  50 (default).  0 disables.  Clamped to [0, 100]."
                  />
                  <SectionHeader title="Novelty percentile" />
                  <SegmentedControl
                    options={['0.50', '0.70', '0.85', '0.95', '0.99']}
                    value={(settings.frameSelection.flow?.noveltyPercentile
                      ?? DEFAULT_FLOW_GATE_SETTINGS.noveltyPercentile).toFixed(2)}
                    onChange={(v) => updateFlow({
                      noveltyPercentile: parseFloat(v),
                    })}
                    caption="How tracked-feature displacements aggregate into a per-axis novelty estimate.  0.85 (default): picks up leading-edge motion sooner — matches user perception.  0.50: pre-V16 median (conservative).  0.99: very aggressive.  Clamped to [0.50, 0.99]."
                  />
                  <SectionHeader title="Eval every N frames" />
                  <SegmentedControl
                    options={['1', '2', '3', '5', '10']}
                    value={String(settings.frameSelection.flow?.evalEveryNFrames
                      ?? DEFAULT_FLOW_GATE_SETTINGS.evalEveryNFrames)}
                    onChange={(v) => updateFlow({
                      evalEveryNFrames: parseInt(v, 10),
                    })}
                    caption="Throttle gate evaluation to every Nth frame for CPU savings.  5 (default) gives ~6 Hz novelty samples at 30 Hz ARCore.  Doesn't change WHICH frames are accepted; only the sample rate.  Clamped to [1, 10]."
                  />
                </View>
              )}
            </Accordion>

            {/* ──────────────────────────────────────────────
             *  STITCHER (`stitcher` sub-tree, closed by default)
             * ────────────────────────────────────────────── */}
            <Accordion title="Stitcher (cv::Stitcher knobs)">
              <SectionHeader title="Stitch mode" />
              <SegmentedControl
                options={['auto', 'panorama', 'scans']}
                value={settings.stitcher.stitchMode}
                onChange={(v) => updateStitcher({
                  stitchMode: v as BatchStitcherSettings['stitchMode'],
                })}
                caption="auto (default): pick PANORAMA or SCANS based on translation/rotation totals at finalize.  panorama: rotation-only (spherical warper, BA-Ray) — best for rotate-in-place captures; BAD on translation.  scans: affine pipeline (plane warper, BA-affine) — best for shelf-pan captures; never diverges on rotation either.  Both modes auto-retry with the opposite if camera params come out degenerate."
              />
              <SectionHeader title="Warper" />
              <SegmentedControl
                options={['plane', 'cylindrical', 'spherical']}
                value={settings.stitcher.warperType}
                onChange={(v) => updateStitcher({
                  warperType: v as BatchStitcherSettings['warperType'],
                })}
                caption="plane (default): flat rectangular output, best for retail shelves.  cylindrical: rotational mid-arc.  spherical: wide pans (180°+), always curved.  Only consulted in panorama mode; scans hardwires PlaneWarper."
              />
              <SectionHeader title="Blender" />
              <SegmentedControl
                options={['multiband', 'feather']}
                value={settings.stitcher.blenderType}
                onChange={(v) => updateStitcher({
                  blenderType: v as BatchStitcherSettings['blenderType'],
                })}
                caption="multiband (default): Laplacian-pyramid blending; cleanest seams, holds all warped frames in memory.  feather: streams warp+feed (lower peak memory, no halo with varied exposure).  <Camera> auto-picks feather on low-memory devices."
              />
              <SectionHeader title="Seam finder" />
              <SegmentedControl
                options={['graphcut', 'skip']}
                value={settings.stitcher.seamFinderType}
                onChange={(v) => updateStitcher({
                  seamFinderType: v as BatchStitcherSettings['seamFinderType'],
                })}
                caption="graphcut (default): cv::detail::GraphCutSeamFinder for optimal seams; pairs with multiband.  skip: stream warp+feed (lowest-memory configuration; pair with feather)."
              />
              <SectionHeader title="Inscribed-rect crop" />
              <SegmentedControl
                options={['off', 'on']}
                value={settings.stitcher.enableMaxInscribedRectCrop ? 'on' : 'off'}
                onChange={(v) => updateStitcher({
                  enableMaxInscribedRectCrop: v === 'on',
                })}
                caption="off (default): crop to cv::boundingRect of non-black pixels — preserves all stitched content; may leave black corners.  on: run MaxInscribedRectFromMask + column-projection second-pass for a clean rectangle (can shrink output a lot if mask is lopsided / ultra-wide)."
              />
            </Accordion>

            {/* ──────────────────────────────────────────────
             *  RESET TO DEFAULTS
             * ────────────────────────────────────────────── */}
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


// ════════════════════════════════════════════════════════════════════
// Helpers (kept verbatim from v0.3 — presentational primitives the
// modal composes; nothing in here depends on the settings shape).
// ════════════════════════════════════════════════════════════════════

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}


/**
 * Collapsible section.  Each instance owns its open/closed state;
 * the modal opens fresh-collapsed on every mount, which is what we
 * want (no AsyncStorage roundtrip on every settings tweak).
 */
function Accordion({
  title,
  initiallyOpen = false,
  badge,
  children,
}: {
  title: string;
  initiallyOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.accordion}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.accordionHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${open ? 'expanded' : 'collapsed'}`}
      >
        <Text style={styles.accordionChevron}>{open ? '▼' : '▶'}</Text>
        <Text style={styles.accordionTitle}>{title}</Text>
        {badge ? <Tag label={badge} /> : null}
      </Pressable>
      {open ? <View style={styles.accordionBody}>{children}</View> : null}
    </View>
  );
}


/**
 * Small grey-text badge — marks sections as "advanced",
 * "experimental", or similar.  No semantic effect; purely a quick
 * visual signal.  Kept for future Layer-2 settings modals that may
 * want to flag experimental sub-trees.
 */
function Tag({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
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
  // Nested-sub-section label inside an accordion body — used for the
  // Flow-tunables sub-tree under Frame selection.
  nested: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  nestedLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
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
  accordion: {
    marginTop: 18,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 8,
  },
  accordionChevron: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    width: 14,
  },
  accordionTitle: {
    color: '#ffffff',
    opacity: 0.85,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
  },
  accordionBody: {
    paddingHorizontal: 12,
    paddingBottom: 14,
  },
  tag: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
