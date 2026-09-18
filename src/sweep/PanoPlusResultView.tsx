// SPDX-License-Identifier: Apache-2.0
/**
 * PanoPlusResultView — the full-screen review of one finished pano+ sweep.
 *
 * ── WHY IT IS A DEDICATED VIEWER AND NOT A GENERIC ONE ───────────────────
 * A host's richer review screen is typically generic over its own capture
 * results and driven by a per-object model — detected items, per-item crop
 * cards, real-world dimensions, view toggles, detection hotspots. A sweep has
 * NONE of those: no per-object provenance and no object detection in the
 * construction path at all (detection, if any, is downstream). Widening such
 * a union would mean teaching a production review path about a result kind
 * whose every branch is "absent", and would add a member to a discriminated
 * union that existing call sites narrow on.
 *
 * What pano+ needs instead is exactly what that screen does not show: the G1
 * verdict (zero breaks or not), the residual numbers that answer the operator's
 * standing evaluation gate, and the pack's location. So this is a small,
 * dedicated viewer that REUSES the shared pieces that do transfer —
 * `PinchZoomView` (a 12000 px panorama is unreadable without it) and
 * `containRect` — and nothing else.
 *
 * Purely presentational + host-driven: Save/Share pack are host callbacks (the
 * SDK stays filesystem-agnostic, the `debugActions` split every review here
 * already uses).
 *
 * ── 2026-09-02: THE IMAGE AND THE CONTROLS ARE THE SCREEN ────────────────
 *
 * Operator, verbatim: *"There is SO MUCH text on the image output that I do
 * not see the buttons still!! WHY is that text needed on the output? What
 * purpose is it serving?"*
 *
 * He was right, and the defect was LAYOUT, not verbosity alone. The screen was
 * four siblings in a column: a fixed 0.42·H viewport, then the verdict block —
 * nine prose paragraphs in a plain `View`, auto-height, and React Native
 * defaults `flexShrink` to **0** (CSS defaults it to 1) — then a `flex: 1`
 * ScrollView, then the actions row. When the verdict grew past the leftover
 * space it could not shrink, so the ScrollView collapsed to zero and the
 * actions row was pushed off the bottom of the display WITH NO SCROLL PATH TO
 * IT. Measured on his own pack (`Pano plus tau = 0/…T18-29-47-653Z`): 1,816
 * chars of verdict = ~455 pt on a 402x874 iPhone against 990 pt of
 * non-shrinkable children — 116 pt of overflow, and 166 pt on the A35's
 * 384x832. The verdict itself was then clipped mid-sentence: the screen failed
 * at BOTH its jobs, losing the controls AND truncating the diagnostic.
 *
 * THE SHAPE THAT CANNOT DO THAT AGAIN:
 *
 *   root ─ column
 *     ├─ content   flex: 1        ← the PICTURE, and the only elastic child
 *     │    ├─ viewport  (absolute fill) canvas + pinch-zoom
 *     │    └─ report    (absolute fill, ONLY when expanded) scrollable prose
 *     ├─ chip      flexShrink: 0  ← ONE verdict line + the expander
 *     └─ actions   flexShrink: 0  ← Close / Save / Share / Notes, ALWAYS
 *
 * The report overlay covers the CONTENT box and nothing else, so expanding it
 * cannot displace or cover the controls — the property a `flex` sibling could
 * not give. Every remaining fixed child is bounded (the headline is
 * `numberOfLines={2}`), so the fixed budget is ~170 pt on any screen and the
 * actions row is structurally unreachable-proof.
 *
 * AND THE TEXT IS NOT DELETED. It is the pano+ residual diagnostic — the
 * standing "residuals to the operator before iterating" instrument, ADVISORY,
 * gating nothing. One tap opens it in full, and `panoPlusVerdictSidecar` writes
 * it into the pack on every mount whether it was opened or not, in the exact
 * words the screen would have printed. Same treatment, same reasoning and the
 * same file placement as the capture screen's `panoPlusNoticeSidecar`.
 */

import React, {
  useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { containFit } from '../index';

/**
 * Aspect-fit rect for the finished sweep inside the measured viewport.
 *
 * Thin wrapper over the package's own `containFit` rather than a second copy
 * of the same `Math.min(w/iw, h/ih)` — but it keeps a guard `containFit` does
 * not have. `containFit` rejects on `<= 0`, which drops NaN (NaN > 0 is
 * false) but NOT Infinity, and this is fed a MEASURED layout height that is
 * zero on the first paint. `Number.isFinite` makes "not measured yet" and
 * "measured as nonsense" the same answer: null, render nothing, wait.
 */
function containRect(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number,
): { left: number; top: number; width: number; height: number } | null {
  const ok = (v: number): boolean => Number.isFinite(v) && v > 0;
  if (!ok(containerW) || !ok(containerH) || !ok(imageW) || !ok(imageH)) {
    return null;
  }
  const fit = containFit({ width: containerW, height: containerH }, imageW, imageH);
  if (fit == null) return null;
  return {
    left: fit.offX,
    top: fit.offY,
    width: imageW * fit.scale,
    height: imageH * fit.scale,
  };
}
import { PinchZoomView } from './PinchZoomView';
import { packStatusLabel } from './packStatus';
import type { PackStatusProvider } from './packStatus';
import { loadVideoFileSystem } from './fileSystem';
import {
  PANO_PLUS_VERDICT_FILE,
  fileUri,
  panoPlusIntegrity,
  panoPlusResidualLines,
  panoPlusVerdictHeadline,
  panoPlusVerdictSidecar,
} from './panoPlusModel';
import type { PanoPlusCaptureResult } from './panoPlusTypes';

export interface PanoPlusResultViewProps {
  result: PanoPlusCaptureResult;
  /** Close the viewer. The result is ALREADY delivered to the host by the
   *  surface's `onComplete` — this screen is a viewer, not a gate. */
  onDismiss: () => void;
  debugActions?: {
    onShare: (result: PanoPlusCaptureResult) => Promise<unknown> | void;
    /** Resolve TRUTHY on a real save so the row can confirm. */
    onSave: (result: PanoPlusCaptureResult) => Promise<unknown> | void;
    onAddNotes?: (result: PanoPlusCaptureResult) => void;
    /** PERSISTED per-capture pack status — the SAME contract the two shipped
     *  reviews use. It matters more here than anywhere else: pano+ auto-saves a
     *  session dir that can run to hundreds of megabytes, so "did the pack
     *  actually land?" is a question the operator will ask in the aisle, and a
     *  review that cannot answer it invites a second manual save (which is how
     *  9 packs ended up on disk for 7 captures in the field). Absent ⇒ no pill,
     *  byte-identical row. */
    packStatus?: PackStatusProvider;
  };
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * The viewport's height BEFORE the content box has laid out.
 *
 * A first paint at zero would make `containRect` return null and render the
 * "no canvas dimensions" refusal for one frame — a sentence that means
 * something specific and must never appear because a measurement had not
 * arrived yet. 0.52·H is what the flex layout settles to on both reference
 * screens once the chip and the actions row are subtracted, so the first frame
 * is already close to the final one and `onLayout` only refines it.
 */
const PRELAYOUT_CONTENT_FRACTION = 0.52;

/**
 * Points reserved down the report's right edge for the HOST's chip column.
 *
 * The surface cannot measure a sibling it does not own. When this was sized
 * (2026-09-03) the IR shell parked two chips there (`0.5×` and `AR off`,
 * ~50 pt wide plus a 12 pt margin); those moved into the capture surface as
 * Pano's own pills later the same day, but a host is still free to park chrome
 * down that edge, and 76 costs the prose nothing that matters — the full text
 * is in the pack either way.
 */
const REPORT_RIGHT_INSET = 76;

export function PanoPlusResultView({
  result,
  onDismiss,
  debugActions,
}: PanoPlusResultViewProps): React.JSX.Element {
  const { width: fbW, height: fbH } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  // ── THIS SCREEN DOES NOT TURN WITH THE HOLD (2026-09-03) ───────────────
  //
  // It did, for one day: the root was rotated by the surface's chrome
  // rotation and its box transposed, so a portrait-locked framebuffer held
  // sideways showed the review upright to the operator. That was removed with
  // the rest of pano+'s chrome rotation on the owner's parity requirement —
  // "the pano UI does not rotate in landscape currently; why does the pano+
  // rotate?" Pano's review (the stitcher's crop preview and the shell's review
  // strip) is laid out in the portrait framebuffer and turns with nothing, and
  // pano+ now does exactly the same: a portrait screen, whichever way the
  // phone is held. The PICTURE inside it is still world-upright — that half is
  // the engine's bake (`panoPlusUprightRotationDeg`), which is unchanged.
  //
  // So the layout box is the framebuffer, and the two names below survive
  // only so the rest of this file reads as it did.
  const winW = fbW;
  const winH = fbH;
  const [reportOpen, setReportOpen] = useState(false);
  const [showPackDetail, setShowPackDetail] = useState(false);
  const [saved, setSaved] = useState(false);
  const [contentH, setContentH] = useState(0);

  const packProvider = debugActions?.packStatus;
  const packSnapshot = useSyncExternalStore(
    packProvider?.subscribe ?? NOOP_SUBSCRIBE,
    () => (packProvider != null ? packProvider.get(result) : null),
  );
  const packLabel = packStatusLabel(packSnapshot);

  const integrity = useMemo(
    () => panoPlusIntegrity(result.summary),
    [result.summary],
  );
  const residuals = useMemo(
    () => panoPlusResidualLines(result.summary, result.arms),
    [result.summary, result.arms],
  );

  // ── THE REPORT, INTO THE PACK ───────────────────────────────────────────
  // Written ONCE per result, on mount, before the operator has decided
  // anything: the sidecar is evidence about the sweep, and a diagnostic that
  // is only written when somebody remembers to open it is not evidence.
  //
  // FIRE-AND-FORGET AND SWALLOWED, exactly like the capture screen's notice
  // sidecar — a review must never fail because a file could not be written,
  // and `fs` is null on a host without expo-file-system (and in every render
  // test), where there is nothing to write to and nothing to report.
  const fs = useMemo(() => loadVideoFileSystem(), []);
  const verdictWrittenFor = useRef<string | null>(null);
  useEffect(() => {
    if (fs == null || result.sessionDir === '') return;
    // Keyed by the session dir: React 18 mounts effects twice in StrictMode and
    // the surface re-renders this screen on every pack-status tick, neither of
    // which is a new sweep.
    if (verdictWrittenFor.current === result.sessionDir) return;
    verdictWrittenFor.current = result.sessionDir;
    const uri =
      `${fileUri(result.sessionDir).replace(/\/$/, '')}/${PANO_PLUS_VERDICT_FILE}`;
    void fs
      .writeAsStringAsync(uri, panoPlusVerdictSidecar(result))
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[pano+] verdict sidecar not written —', e);
      });
  }, [fs, result]);

  // The panorama is extremely wide; `contain` inside the viewport is the only
  // fit that shows the whole sweep at once, and PinchZoomView is what makes it
  // readable afterwards.
  //
  // The box is now whatever the flex layout LEAVES, measured — not a fixed
  // 0.42·H. That is the point of the restructure: the picture gets the screen
  // that the prose used to take.
  const viewportH =
    contentH > 0 ? contentH : Math.max(160, winH * PRELAYOUT_CONTENT_FRACTION);
  const rect = containRect(winW, viewportH, result.width, result.height);

  return (
    <View
      style={[
        styles.root,
        // The framebuffer, and never a transform — see the note at the top of
        // the component: this screen is portrait-laid-out like Pano's.
        { left: 0, top: 0, width: winW, height: winH },
      ]}
      testID="panoplus-result">
      {/* ── THE PICTURE, AND THE ONLY ELASTIC CHILD ────────────────────── */}
      <View
        style={styles.content}
        onLayout={(e: { nativeEvent: { layout: { height: number } } }) => {
          const h = e?.nativeEvent?.layout?.height;
          if (typeof h === 'number' && h > 0 && h !== contentH) setContentH(h);
        }}>
        <View style={styles.viewport} testID="panoplus-result-viewport">
          {rect != null ? (
            <PinchZoomView
              contentWidth={winW}
              contentHeight={viewportH}
              style={StyleSheet.absoluteFill}>
              <Image
                source={{ uri: fileUri(result.uri) }}
                style={{
                  position: 'absolute',
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                }}
                resizeMode="contain"
                testID="panoplus-result-image"
              />
            </PinchZoomView>
          ) : (
            <Text style={styles.dim}>
              The sweep reported no canvas dimensions — nothing to show.
            </Text>
          )}
        </View>

        {/* ── THE FULL REPORT — OVER THE PICTURE, NEVER OVER THE CONTROLS ──
            Absolutely positioned inside the CONTENT box. That is the whole
            defence: a `flex` sibling with this much prose is what pushed the
            actions row off the display, and an overlay bounded by its parent
            structurally cannot reach them however long the text gets.

            Scrollable, because it legitimately IS long — 15 residual lines
            plus up to nine verdict sentences — and a long diagnostic that is
            clipped instead of scrolled is the same defect one layer down. */}
        {reportOpen && (
          <ScrollView
            style={styles.report}
            contentContainerStyle={[
              styles.reportPad,
              // ⚠ THE HOST DRAWS ITS OWN CHIPS OVER THIS BOX, from the right.
              // Measured 2026-09-03: the 0.5× and AR pills cut lines
              // mid-sentence in portrait ("(or ran wi[th it off]") and, in
              // landscape, ran them off the display entirely. The report is
              // advisory and duplicated in host_verdict.json, so nothing was
              // lost operationally — but a diagnostic that is clipped instead
              // of wrapped is the same defect one layer down, which is the
              // note `report`'s own ScrollView already carries.
              {
                paddingRight: REPORT_RIGHT_INSET + Math.max(0, insets?.right ?? 0),
                paddingLeft: 14 + Math.max(0, insets?.left ?? 0),
              },
            ]}
            testID="panoplus-report">
            <Text style={styles.reportHeading}>The verdict, in full</Text>
            <Text style={styles.verdictLine}>{integrity.line}</Text>
            {integrity.clipLine != null && (
              <Text style={styles.verdictLine} testID="panoplus-integrity-clip">
                {integrity.clipLine}
              </Text>
            )}
            {integrity.seamLine != null && (
              <Text style={styles.verdictLine} testID="panoplus-integrity-seam">
                {integrity.seamLine}
              </Text>
            )}
            {integrity.warpLine != null && (
              <Text style={styles.verdictLine} testID="panoplus-integrity-warp">
                {integrity.warpLine}
              </Text>
            )}
            {/* v11 — the fitted subject distance, GRADED. `warpLine` above
                prints it bare, and on all three Test-13 field packs that bare
                number was 2x to 7.5x wrong with nothing saying so. */}
            {integrity.subjectDistanceLine != null && (
              <Text
                style={styles.verdictLine}
                testID="panoplus-integrity-subject-distance">
                {integrity.subjectDistanceLine}
              </Text>
            )}
            {integrity.bandLine != null && (
              <Text style={styles.verdictLine} testID="panoplus-integrity-band">
                {integrity.bandLine}
              </Text>
            )}
            {integrity.exposureLine != null && (
              <Text
                style={styles.verdictLine}
                testID="panoplus-integrity-exposure">
                {integrity.exposureLine}
              </Text>
            )}
            {/* v11 — ARKit's OWN exposure. The line above is read back off the
                same AVCaptureDevice the lock was asserted on, so it is circular
                with respect to device identity and to whether the lock reaches
                ARKit's pixels. This one is not. */}
            {integrity.arExposureLine != null && (
              <Text
                style={styles.verdictLine}
                testID="panoplus-integrity-ar-exposure">
                {integrity.arExposureLine}
              </Text>
            )}
            {integrity.gainLine != null && (
              <Text style={styles.verdictLine} testID="panoplus-integrity-gain">
                {integrity.gainLine}
              </Text>
            )}

            <Text style={styles.reportHeading}>Residuals</Text>
            {residuals.map((line, i) => (
              <Text key={i} style={styles.detailText}>
                {line}
              </Text>
            ))}

            {showPackDetail && (
              <>
                <Text style={styles.reportHeading}>Pack</Text>
                <Text style={styles.detailText}>{result.sessionDir}</Text>
                <Text style={styles.detailText}>
                  canvas.jpg · meta.json · ledger.jsonl (one row per ingested
                  frame) · track.jsonl (attitude + per-frame intrinsics) ·
                  frames/ · preview.jpg · {PANO_PLUS_VERDICT_FILE} (this report)
                </Text>
                <Text style={styles.reportHeading}>Why the pack matters</Text>
                <Text style={styles.detailText}>
                  The ledger + track are what let the offline harness replay this
                  exact sweep. A residual you cannot reproduce offline is a
                  residual you cannot fix.
                </Text>
              </>
            )}
            <TouchableOpacity
              onPress={() => setShowPackDetail((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel="Toggle pano plus pack detail"
              testID="panoplus-detail-toggle">
              <Text style={styles.link}>
                {showPackDetail ? 'Less' : 'Pack detail…'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>

      {/* ── THE ONE LINE ────────────────────────────────────────────────────
          G1 (zero breaks) is the T1 contract's headline measure and a review
          that buries it is a review that lets a broken panorama look finished
          — so it stays, and it stays FIRST among the text. What does not stay
          is the eight paragraphs under it.

          `panoPlusVerdictHeadline` composes the sentence, in the model, beside
          the sidecar that also writes it. Two spellings of one verdict is how
          the screen and the pack end up disagreeing about the same sweep.

          `numberOfLines={2}` is load-bearing rather than cosmetic: it is what
          makes this child's height BOUNDED, which is what makes the actions
          row's position independent of the pack being reviewed. */}
      <TouchableOpacity
        style={[styles.chip, integrity.isIntact ? styles.ok : styles.bad]}
        onPress={() => setReportOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: reportOpen }}
        accessibilityLabel={
          reportOpen
            ? `${panoPlusVerdictHeadline(integrity)}. Tap to hide the full report.`
            : `${panoPlusVerdictHeadline(integrity)}. Tap to read the full report.`
        }
        testID="panoplus-integrity">
        <Text
          style={styles.verdictTitle}
          numberOfLines={2}
          testID="panoplus-integrity-headline">
          {panoPlusVerdictHeadline(integrity)}
        </Text>
        {/* THE AFFORDANCE SAYS WHERE THE TEXT WENT. A collapsed diagnostic
            with no visible handle is indistinguishable from a deleted one, and
            the second reading is what gets a working feature reported as a
            regression — the same sentence, for the same reason, as the capture
            screen's arm notice. */}
        <Text style={styles.chipMore} testID="panoplus-integrity-more">
          {reportOpen
            ? '▾ tap to hide'
            : `▸ tap for the residuals · full text is in the pack (${PANO_PLUS_VERDICT_FILE})`}
        </Text>
      </TouchableOpacity>

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.btn}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Close the pano plus review"
          testID="panoplus-result-close">
          <Text style={styles.btnText}>Close</Text>
        </TouchableOpacity>
        {debugActions != null && (
          <>
            {packLabel != null
              && (packLabel.retry ? (
                <TouchableOpacity
                  style={styles.btn}
                  onPress={() => {
                    void debugActions.onSave(result);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Debug pack failed — tap to retry the save"
                  testID="panoplus-pack-retry">
                  <Text style={styles.btnText}>{packLabel.text}</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.btn} testID="panoplus-pack-status">
                  <Text style={styles.btnText}>{packLabel.text}</Text>
                </View>
              ))}
            <TouchableOpacity
              style={styles.btn}
              onPress={() => {
                const r = debugActions.onSave(result);
                if (r != null && typeof (r as Promise<unknown>).then === 'function') {
                  void (r as Promise<unknown>).then((ok) => {
                    if (ok) setSaved(true);
                  });
                }
              }}
              accessibilityRole="button"
              accessibilityLabel="Save the pano plus debug pack"
              testID="panoplus-result-save">
              <Text style={styles.btnText}>{saved ? '✓ Saved' : '💾 Save pack'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.btn}
              onPress={() => {
                void debugActions.onShare(result);
              }}
              accessibilityRole="button"
              accessibilityLabel="Share the pano plus debug pack"
              testID="panoplus-result-share">
              <Text style={styles.btnText}>📤 Share</Text>
            </TouchableOpacity>
            {debugActions.onAddNotes != null && (
              <TouchableOpacity
                style={styles.btn}
                onPress={() => debugActions.onAddNotes?.(result)}
                accessibilityRole="button"
                accessibilityLabel="Add notes to this pano plus capture"
                testID="panoplus-result-notes">
                <Text style={styles.btnText}>📝 Notes</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** `position: 'absolute'` with the box supplied at render — the framebuffer,
   *  always (the turned-and-transposed box this once carried is gone; see the
   *  component's opening note). */
  root: { position: 'absolute', backgroundColor: '#0b0b0b' },
  /** THE ONLY ELASTIC CHILD. Everything below it is `flexShrink: 0`, so this
   *  is what absorbs a short screen — and it is the picture, which degrades
   *  gracefully, rather than the controls, which do not. `position: relative`
   *  is what bounds the report overlay to this box. */
  content: {
    flex: 1,
    position: 'relative',
    marginTop: 44,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  viewport: { ...StyleSheet.absoluteFillObject },
  /** Over the picture, inside `content`, and therefore never over the chip or
   *  the actions row. 0.92 alpha rather than opaque: the panorama staying
   *  faintly visible underneath is what tells the operator the report is a
   *  layer and not a new screen. */
  report: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(11,11,11,0.92)',
  },
  reportPad: { paddingHorizontal: 14, paddingVertical: 12, paddingBottom: 24 },
  reportHeading: {
    color: '#9fd8ff',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 12,
  },
  dim: { color: '#8a8a8a', fontSize: 12, textAlign: 'center', marginTop: 40 },
  /** ⚠ `flexShrink: 0` IS WRITTEN OUT rather than left to React Native's
   *  default, which is already 0. The default is the OPPOSITE of CSS's, this
   *  screen's overflow bug was exactly that difference, and a reader who knows
   *  CSS reads an unmarked auto-height child as shrinkable. Stating it is what
   *  makes the layout's invariant legible at the point it matters. */
  chip: {
    flexShrink: 0,
    marginHorizontal: 12,
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
  },
  ok: { backgroundColor: 'rgba(34,197,94,0.16)' },
  bad: { backgroundColor: 'rgba(239,68,68,0.16)' },
  verdictTitle: { color: '#f0f0f0', fontSize: 14, fontWeight: '700' },
  chipMore: { color: '#7fd7ff', fontSize: 11, marginTop: 4 },
  verdictLine: { color: '#d0d0d0', fontSize: 11, marginTop: 3 },
  detailText: {
    color: '#c4c4c4',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
    fontVariant: ['tabular-nums'],
  },
  link: { color: '#7fd7ff', fontSize: 12, marginTop: 10 },
  /** See `chip`: the same `flexShrink: 0` note, and here it is the whole
   *  point of the file's 2026-09-02 rewrite. */
  actions: {
    flexShrink: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    paddingBottom: 30,
    paddingTop: 6,
  },
  btn: {
    marginHorizontal: 5,
    marginVertical: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  btnText: { color: '#e8e8e8', fontSize: 13, fontWeight: '600' },
});
