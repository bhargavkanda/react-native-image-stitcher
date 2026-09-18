// SPDX-License-Identifier: Apache-2.0
/**
 * PanoPlusBasisOverlay — THE FIRST-RUN BASIS MEASUREMENT, IN THE CAMERA.
 *
 * The operator's 2026-09-01 decision, verbatim: *"derive if possible, else for
 * the first pano+ capture on the device (basis is unknown), show a guidance to
 * the user on camera screen to move the device as needed — the way we show the
 * guidance for panorama for the user to pan — and once done by user and basis
 * obtained, remove it and allow the user to continue to capture. Save this
 * basis and persist forever."*
 *
 * So this is NOT a panel. It is the same shape as `PanHowToOverlay`: a
 * full-screen coach layer over the live camera that appears when it is needed,
 * coaches while the phone moves, and DISAPPEARS the instant the number exists.
 * There is nothing to find, nothing to dismiss and nothing to navigate back
 * from. The panel it replaces (`PanoCalibrationPanel`) still exists for τ,
 * which needs AVFoundation and therefore cannot run with ARKit up — but the
 * basis, the half that CAN be measured beside a live AR session, is acquired
 * here or it is not acquired at all.
 *
 * ── WHY A STRAIGHT SWEEP IS THE WORST THING HE CAN DO, AND WHY THAT SHAPES
 *    EVERY LINE OF COPY BELOW ──────────────────────────────────────────────
 *
 * `selectBasis` cannot identify `C` from a one-axis log. It is a theorem, not a
 * numerical near-miss: writing the truth as `C₀` and a candidate as `C₀·A`, the
 * residual vanishes for every observed increment iff `A` commutes with all of
 * them, and the rotations about a single axis have a centraliser containing the
 * quarter-turns about that axis — which are signed permutations, i.e. four of
 * the 24 candidates matching to floating-point dust (9.86e-15° in the prototype
 * run). Two independent axes generate all of SO(3), whose centraliser is {I}.
 *
 * Every other capture in this app trains the operator to pan smoothly. That
 * instinct is exactly wrong here, so the overlay ASKS for the wrong-feeling
 * motion by name, meters each named axis separately, and — when the solve
 * refuses — says which motion was missing rather than "try again".
 *
 * ── THE LIFECYCLE IS OWNED HERE, ENTIRELY ───────────────────────────────
 *
 * `startBasisCalibration` registers a plugin on the ARKit delegate thread AND
 * starts a 200 Hz CoreMotion stream. Both must come down on EVERY exit path —
 * acquired, declined, refused-and-abandoned, or the host unmounting the surface
 * mid-gesture. `PanoCalibrationPanel` learned this the hard way and guards it
 * with three separate effects; here there is exactly one owner (this component)
 * and one teardown (`discardBasisCalibration`, which stops without solving and
 * frees the recording), so there is no second path to forget.
 *
 * ── WHAT IS NEVER DONE HERE ─────────────────────────────────────────────
 *
 * A refusal is NEVER persisted and NEVER presented as a measurement. The persist
 * gate lives in C++ (`rnis_pano_calib::gradeBasis` + `basisStability`) and is
 * enforced natively (`RNISPanoCalibStore.saveBasis`); `basisIsPersistable` is
 * this layer's MIRROR of it, consulted so the flow does not walk into a native
 * `calibration-not-persistable` — which reads as broken rather than as unmet.
 * If the two ever disagree, NATIVE WINS and the mirror is the bug.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  basisCalibrationStatus,
  basisIsPersistable,
  discardBasisCalibration,
  saveBasisCalibration,
  startBasisCalibration,
  stopBasisCalibration,
} from './panoPlusCalibration';
import type { CalibBasisSolve, CalibLiveStatus } from './panoPlusCalibration';
import {
  panoPlusBasisGestureView,
} from './panoPlusBasisAcquisition';
import type { PanoPlusBasisGesturePhase } from './panoPlusBasisAcquisition';

/**
 * Live coaching poll. Matches `PanoCalibrationPanel`'s 250 ms and the native
 * recorder's own 4 Hz reduction cadence — polling faster would read the same
 * cached dictionary twice and cost a bridge hop for nothing.
 */
const POLL_MS = 250;

/**
 * The recorder's hard cap, seconds.
 *
 * SHORTER THAN THE PANEL'S 90 s, deliberately. The panel's cap exists to stop a
 * recorder left armed by a dismissed modal; here the overlay is the thing the
 * operator is looking at, and a gesture that has not converged in 45 s is not
 * going to — it is a wrong motion, and the refusal that names it is more useful
 * than another 45 s of the same. The native side stops itself either way.
 */
const MAX_DURATION_S = 45;

export interface PanoPlusBasisOverlayProps {
  /**
   * The AR reference is live — i.e. `<ARCameraView>` is mounted and ARKit is
   * running.
   *
   * ⚠ THE RECORDER'S REFERENCE *IS* `RNISARFrameContext.poseRotation`, the same
   * quantity the engine consumes. Starting before the session is up records a
   * log with no reference in it, which the solve then correctly refuses — an
   * operator performing a perfect gesture and being told it was not good enough.
   * So the gesture WAITS for this rather than racing it.
   */
  arLive: boolean;
  /** A basis was measured, gated and PERSISTED. The surface re-reads the store
   *  and the overlay unmounts itself out of existence. */
  onAcquired: (solve: CalibBasisSolve) => void;
  /** The operator chose to sweep on ARKit instead. Not remembered across a
   *  re-entry — see `PanoPlusBasisResolutionInput.gestureDeclined`. */
  onDecline: () => void;
}

export function PanoPlusBasisOverlay({
  arLive,
  onAcquired,
  onDecline,
}: PanoPlusBasisOverlayProps): React.JSX.Element {
  const [phase, setPhase] = useState<PanoPlusBasisGesturePhase>('arming');
  const [live, setLive] = useState<CalibLiveStatus | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * Bumped by `retry`, and it is what actually RE-RUNS the arm effect.
   *
   * ⚠ CLEARING `armedRef` IS NOT ENOUGH ON ITS OWN. The effect's only other
   * dependency is `arLive`, which does not change when the operator taps "go
   * again" — so without this the retry would clear the guard, set the phase to
   * `arming`, and then sit there forever with no recorder running and a screen
   * that says it is bringing one up.
   */
  const [armNonce, setArmNonce] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  /**
   * ⚠ SINGLE-FLIGHT OVER THE SOLVE, and it is a ref rather than a phase check
   * for the reason the surface's `busyRef` is: the poll fires the solve, and a
   * poll that lands while the previous solve's promise is in flight would start
   * a second `stopBasisCalibration` against the same recording. The first one
   * has already unregistered the plugin, so the second takes the
   * `not-recording` branch and reports a refusal for a gesture that succeeded.
   */
  const solvingRef = useRef(false);
  /** The recorder is armed natively. Written SYNCHRONOUSLY, never derived from
   *  `phase`, so the unmount cleanup cannot miss a start that a batched React
   *  commit had not yet reflected. */
  const armedRef = useRef(false);

  const stopPolling = useCallback((): void => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // ── ARM ────────────────────────────────────────────────────────────────
  //
  // Runs when the AR reference comes up, and only then. Re-entry is guarded by
  // `armedRef`: a re-render with `arLive` still true must not start a second
  // recorder, which native would refuse with `basiscal-busy` — a refusal the
  // operator would read as the gesture failing.
  useEffect(() => {
    if (!arLive || armedRef.current) return undefined;
    let alive = true;
    startBasisCalibration({ maxDurationS: MAX_DURATION_S }).then(
      () => {
        if (!alive || !mountedRef.current) {
          // Started after the overlay went away: NOTHING else will take this
          // down, so this branch owns it. Dropping it here is how a plugin
          // stays on the AR thread for the rest of the process.
          void discardBasisCalibration();
          return;
        }
        armedRef.current = true;
        setPhase('recording');
        const poll = (): void => {
          basisCalibrationStatus().then(
            (s) => { if (mountedRef.current) setLive(s); },
            () => undefined,
          );
        };
        // ONE READ IMMEDIATELY, then the interval — the first quarter-second is
        // exactly when the operator is looking to find out whether the gesture
        // has been understood at all, and blank meters read as "broken".
        poll();
        pollRef.current = setInterval(poll, POLL_MS);
      },
      (e: unknown) => {
        if (!alive || !mountedRef.current) return;
        // A START failure is a DIFFERENT thing from a refused gesture and must
        // not be coached as one: no amount of tilting fixes a missing
        // calibration module or a device with no CoreMotion.
        setRefusal(String(e));
        setPhase('failed');
      },
    );
    return () => { alive = false; };
  }, [arLive, armNonce]);

  // ── TEARDOWN — one owner, every path ───────────────────────────────────
  useEffect(
    () => () => {
      mountedRef.current = false;
      if (pollRef.current != null) clearInterval(pollRef.current);
      pollRef.current = null;
      // Always, even when never armed: `discard()` on an idle recorder is a
      // no-op, and the alternative is a conditional that can be wrong.
      void discardBasisCalibration();
      armedRef.current = false;
    },
    [],
  );

  // ── SOLVE — fired by the METER, not by a button ────────────────────────
  //
  // The operator's decision says the guidance disappears "once done by user and
  // basis obtained". There is therefore no Finish button: the excitation
  // verdict is what says the gesture is sufficient, it is computed from the
  // motion alone, and it is the same verdict the solve will grade against. A
  // button here would let him press it early and be refused for a gesture the
  // screen had already told him was incomplete.
  useEffect(() => {
    if (phase !== 'recording' || live?.sufficient !== true) return;
    if (solvingRef.current) return;
    solvingRef.current = true;
    stopPolling();
    setPhase('solving');
    // τ = 0: ARFrame.timestamp and CMDeviceMotion.timestamp both run on the
    // system uptime clock. The solve's own ±10 ms stability sweep is what turns
    // that from an assumption into an observation, and it is a PERSIST GATE.
    stopBasisCalibration(0).then(
      (solve) => {
        armedRef.current = false;
        if (!mountedRef.current) return;
        const gate = basisIsPersistable(solve);
        if (!gate.ok) {
          // NEVER PERSIST AN AMBIGUOUS RESULT. `saveBasisCalibration` would
          // refuse it natively anyway; walking into that refusal would report
          // the calibration as broken instead of as unmet.
          setRefusal(gate.reason);
          setPhase('refused');
          solvingRef.current = false;
          return;
        }
        setPhase('saving');
        // `acquiredVia`, NOT `source`: the store merges `extra` straight into
        // the record, and the bridge already writes a `basisSource` key
        // ("store" / "options") that the pack's provenance is DERIVED from. A
        // neighbouring `source` would sit one letter away from the field that
        // decides whether a pack may say `measured`.
        saveBasisCalibration(solve, { acquiredVia: 'in-camera-first-run' }).then(
          () => {
            if (!mountedRef.current) return;
            setPhase('acquired');
            solvingRef.current = false;
            onAcquired(solve);
          },
          (e: unknown) => {
            if (!mountedRef.current) return;
            // The native store refused what the mirror accepted. Native wins;
            // this is the mirror being wrong, and it is said in those words so
            // a field report can name it.
            setRefusal(`the store refused it — ${String(e)}`);
            setPhase('refused');
            solvingRef.current = false;
          },
        );
      },
      (e: unknown) => {
        armedRef.current = false;
        if (!mountedRef.current) return;
        setRefusal(String(e));
        setPhase('refused');
        solvingRef.current = false;
      },
    );
  }, [live?.sufficient, onAcquired, phase, stopPolling]);

  /** Go again after a refusal. Re-arms the recorder from scratch — the previous
   *  recording is what produced the refusal and re-solving it would produce the
   *  same one. */
  const retry = useCallback((): void => {
    setRefusal(null);
    setLive(null);
    solvingRef.current = false;
    armedRef.current = false;
    setPhase('arming');
    // ⚠ NO `discardBasisCalibration()` HERE, AND ITS ABSENCE IS THE FIX.
    //
    // `RNISPanoCalibCore.beginRecording` already clears both buffers, so the
    // next `start()` frees the refused recording implicitly — the discard would
    // be redundant. It would also RACE: `discard()` ends in `endRecording()`,
    // which clears `gImu`/`gRef`, and it is fire-and-forget. Landing after the
    // re-armed `start()` it would empty the buffers of the NEW gesture, and the
    // operator would perform a perfect motion into a log that stayed empty and
    // be refused `too-few-samples` for it.
    //
    // THE NONCE IS WHAT RE-RUNS THE ARM EFFECT. `arLive` has not changed, so
    // clearing the guard alone would leave the overlay saying "bringing the
    // reference camera up" with nothing recording.
    setArmNonce((n) => n + 1);
  }, []);

  const view = panoPlusBasisGestureView(phase, live, refusal);
  const busy = phase === 'solving' || phase === 'saving' || phase === 'arming';

  return (
    <View
      style={styles.root}
      // `box-none`: the scrim must not swallow taps meant for the surface
      // beneath it, but the two buttons inside DO need them.
      pointerEvents="box-none"
      testID="panoplus-basis-overlay">
      <View style={styles.scrim} pointerEvents="none" />
      {/* Laid out in the framebuffer and NEVER turned (2026-09-03). This card
          carried the surface's chrome rotation so it read upright in a
          sideways hold; Pano turns no block on its screen, and pano+ is to
          look exactly like Pano — the library's own coach overlays that
          self-rotate are the one exception, and this card is not one. */}
      <View style={styles.card} testID="panoplus-basis-card">
        <Text style={styles.kicker}>ONE-TIME SETUP FOR THIS PHONE</Text>
        <Text
          style={[
            styles.headline,
            view.tone === 'warn' && styles.toneWarn,
            view.tone === 'stop' && styles.toneStop,
          ]}
          testID="panoplus-basis-headline">
          {view.headline}
        </Text>
        <Text style={styles.coach} testID="panoplus-basis-coach">
          {view.coach}
        </Text>

        {/* THE PER-AXIS METERS. Three separate bars rather than one progress
            ring, because the failure this whole overlay exists to prevent is
            one axis at 200° and the other two at zero — which a single bar
            would render as two-thirds of the way to a basis. */}
        <View style={styles.meters} testID="panoplus-basis-meters">
          {view.axes.map((a) => (
            <View key={a.axis} style={styles.meterRow}>
              <Text
                style={[styles.meterLabel, a.done && styles.meterLabelDone]}
                testID={`panoplus-basis-axis-${a.axis}`}>
                {a.done ? '✓ ' : ''}{a.label}
              </Text>
              <View style={styles.meterTrack}>
                <View
                  style={[
                    styles.meterFill,
                    a.done && styles.meterFillDone,
                    // `flex` rather than a percentage width: RN 0.84 rejects a
                    // string percentage under strict TS, and the flex pair is
                    // this repo's established spelling for a fractional fill.
                    { flex: Math.max(a.fraction, 0.001) },
                  ]}
                />
                <View style={{ flex: Math.max(1 - a.fraction, 0.001) }} />
              </View>
              <Text style={styles.meterValue}>{`${Math.round(a.deg)}°`}</Text>
            </View>
          ))}
        </View>
        {/* The verb, for the axis that is furthest from its bar. One
            instruction at a time: three at once is a list, and a list is not
            read by somebody waving a phone. */}
        {phase === 'recording' && !view.sufficient && !view.referenceMissing && (
          <Text style={styles.nextVerb} testID="panoplus-basis-next">
            {nextVerb(view)}
          </Text>
        )}

        <View style={styles.actions}>
          {phase === 'refused' && (
            <Pressable
              style={styles.retryBtn}
              onPress={retry}
              accessibilityRole="button"
              accessibilityLabel="Record the basis gesture again"
              testID="panoplus-basis-retry">
              <Text style={styles.retryBtnText}>Go again</Text>
            </Pressable>
          )}
          {busy && <ActivityIndicator color="#ffc462" />}
          {/* THE DEAD END MUST STILL LEAVE HIM ABLE TO CAPTURE. A basis that
              cannot be obtained — a refusing device, a hand that will not make
              the motion, an aisle with no texture for ARKit to track — must not
              trap the operator on a screen with no way out. Declining drops
              straight onto the ARKit arm, which needs no basis, and the AR pill
              on the capture screen NAMES that so the pack's arm is never a
              surprise. */}
          <Pressable
            style={styles.skipBtn}
            onPress={onDecline}
            accessibilityRole="button"
            accessibilityLabel={
              'Skip the basis measurement and sweep on ARKit instead. The AR '
              + 'pill will say so.'
            }
            testID="panoplus-basis-skip">
            <Text style={styles.skipBtnText}>Skip — sweep on AR</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** The single next instruction: the unfinished axis that is FURTHEST from its
 *  bar, so the coaching moves the meter that is holding everything up. */
function nextVerb(view: ReturnType<typeof panoPlusBasisGestureView>): string {
  const pending = view.axes.filter((a) => !a.done);
  if (pending.length === 0) return '';
  const worst = pending.reduce((lo, a) => (a.fraction < lo.fraction ? a : lo));
  return `→ ${worst.verb}`;
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // Dark enough to read white text over a lit aisle, light enough that the
  // operator can still see what the camera is pointed at — he is being asked to
  // move the phone, and a black screen makes that disorienting.
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.62)' },
  card: {
    maxWidth: 420,
    paddingHorizontal: 22,
    paddingVertical: 18,
    alignItems: 'center',
  },
  kicker: {
    color: '#9ca3af',
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: '700',
    marginBottom: 6,
  },
  headline: {
    color: '#e5e7eb',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.4,
  },
  // The guidance amber, matching the library's GUIDANCE_TOKENS so pano+ speaks
  // the same visual language as every other 1D pass. Copied rather than
  // imported: the token module is internal to the stitcher package and is not
  // on its public export surface.
  toneWarn: { color: '#ffc462' },
  toneStop: { color: '#fca5a5' },
  coach: {
    color: '#d1d5db',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 8,
  },
  meters: { alignSelf: 'stretch', marginTop: 16 },
  meterRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  meterLabel: {
    color: '#9ca3af',
    fontSize: 11,
    fontWeight: '700',
    width: 62,
    letterSpacing: 0.6,
  },
  meterLabelDone: { color: '#6ee7b7' },
  meterTrack: {
    flex: 1,
    height: 6,
    flexDirection: 'row',
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  meterFill: { backgroundColor: '#ffc462' },
  meterFillDone: { backgroundColor: '#34d399' },
  meterValue: {
    color: '#9ca3af',
    fontSize: 11,
    width: 42,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  nextVerb: {
    color: '#ffc462',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 6,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    gap: 12,
  },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#ffc462',
  },
  retryBtnText: { color: '#000', fontSize: 13, fontWeight: '700' },
  skipBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  skipBtnText: { color: '#d1d5db', fontSize: 12, fontWeight: '600' },
});
