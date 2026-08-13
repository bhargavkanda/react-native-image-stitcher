// SPDX-License-Identifier: Apache-2.0
/**
 * CameraShutter — dual-mode shutter button for the SDK's panorama UX.
 *
 *     ┌──────────────────────────────────────────────────┐
 *     │  TAP   → take a single photo (existing flow)      │
 *     │  HOLD  → start recording video                    │
 *     │  RELEASE → stop recording → return video file     │
 *     └──────────────────────────────────────────────────┘
 *
 * The button is "pure" UI — it owns gesture detection + visual
 * feedback (idle / pressing / recording / processing rings) but
 * NOT the recording / stitching pipeline itself.  Host apps wire
 * the resulting `onTap` / `onHoldComplete` callbacks to whatever
 * `useCapture` / `useVideoCapture` instance they've configured.
 *
 * Why expose just the button (not the full surface)?
 *   Different audit screens want different layouts (thumbnails,
 *   quality badges, mode chips); pinning them all to one
 *   "PanoramaCaptureSurface" would overfit one customer's UX.  The
 *   button is the only piece every screen needs identical, so it
 *   ships in the SDK.  The orchestration helpers ship as
 *   `<PanoramaCaptureSurface>` next door — host apps that want full
 *   plug-and-play use that; the rest stitch this button into their
 *   own layout.
 *
 * Gesture detection
 *   onPressIn fires immediately on touch down; we start a
 *   ``HOLD_THRESHOLD_MS`` timer.  Two outcomes:
 *
 *     - onPressOut fires before the timer → it was a tap.
 *     - timer fires before onPressOut → transition to recording
 *       state, fire ``onHoldStart``.  When onPressOut eventually
 *       fires we call ``onHoldComplete``.
 *
 *   We deliberately do NOT use react-native-gesture-handler — the
 *   Pressable + setTimeout pattern stays in the SDK's existing dep
 *   surface (RN core only).  Adds zero new peer deps for host apps.
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';


/// Time the user must hold before tap → hold mode flip.  250 ms is
/// the iOS native "long press" default; matches user muscle memory
/// for distinguishing "snap" from "stay".
const HOLD_THRESHOLD_MS = 250;


export interface CameraShutterProps {
  /** Called when the user taps (press-and-release before the threshold). */
  onTap: () => void;
  /** Called when the press crosses the threshold and recording should start. */
  onHoldStart: () => void;
  /** Called on release while in the hold state — recording should stop. */
  onHoldComplete: () => void;
  /**
   * Maximum hold duration in milliseconds.  When the timer fires
   * we auto-fire `onHoldComplete` — same behaviour as the user
   * releasing the button.  Default 8000 ms; keeps recording
   * within the stitcher's adjacent-frame-overlap budget
   * (16 frames × 2 fps = 8 s upper bound).  Pass 0 / undefined
   * to disable the auto-stop.
   *
   * Pair with `<CaptureStatusOverlay countdownMs>` so the user
   * sees how much hold time is left.
   */
  maxHoldMs?: number;
  /**
   * Optional state-driven visual override.  When the host has its own
   * processing indicator (e.g. "Stitching... 70%") set this to true to
   * paint the button in the disabled-while-processing visual.
   */
  isProcessing?: boolean;
  /** Disable the whole button (e.g. while permissions are loading). */
  disabled?: boolean;
  /**
   * Whether the HOLD gesture is live (default `true`). Set `false` for a
   * tap-only shutter: the press never transitions to the holding phase, so
   * `onHoldStart`/`onHoldComplete` never fire, the red recording ring never
   * paints, and the a11y label drops the "hold for panorama" half.
   *
   * WHY IT EXISTS: without it, a host that wires `onHoldStart` to a no-op (a
   * capture mode with no panorama) still gets the full press→hold transition —
   * the button paints a red "Recording — release to stitch panorama" ring while
   * NOTHING records. This is the tap-only shutter Photo mode needs once Pano is
   * its own mode. Default `true` keeps every existing consumer byte-identical.
   */
  holdEnabled?: boolean;
  /**
   * v0.25 — grace window, in milliseconds, before a hold that ended
   * WITHOUT a genuine finger-lift is committed as a release.
   * **Default `0` — disabled, byte-identical to previous behaviour.**
   *
   * ## The failure this exists for
   *
   * React Native's `Pressable` folds two very different events into one
   * `onPressOut`: the user lifting their finger, and the system
   * TERMINATING the touch (an interface rotation, an ancestor
   * scrollable claiming the drag, a Modal mounting, or simply the
   * Pressable being remounted by a re-render — note this button's own
   * visuals change the instant the hold begins).  A termination is not
   * a release, but the shutter treats it as one: `onHoldComplete`
   * fires, and a panorama that captured a single keyframe is finalized
   * into a "panorama" that is just that one frame.  That is the shape
   * of the v0.24.x field reports — capture self-ends in under a second,
   * landscape only, and the user gets frame #1 as the result.
   *
   * ## What a non-zero value does
   *
   * A press-out that arrives with a native touch CANCEL is not
   * committed immediately; it waits this long for the gesture to be
   * re-granted (a remounted Pressable re-acquires a finger that is
   * still down).  If it is, the hold continues uninterrupted.  If it is
   * not, the hold ends normally when the window expires — so this can
   * never hang a capture, which matters because `<Camera>` does not set
   * `maxHoldMs`, leaving no other upper bound.
   *
   * A genuine finger-lift is never delayed, whatever this is set to.
   *
   * Suggested value if you are chasing this: `400`.  Left at `0` until
   * it has been validated on a device that actually reproduces the
   * failure — the diagnostics on `onTouchCancel` / `onTouchEnd` tell
   * you whether your captures are ending by cancel or by release, and
   * this flag is only worth turning on if they say cancel.
   */
  cancelGraceMs?: number;
  /** Optional style applied to the outer touch target. */
  style?: ViewStyle;
}


/**
 * Pure decision for "a press-out just arrived — commit it now, or wait
 * to see whether the gesture comes back?"
 *
 * Extracted so jest can exercise the matrix without a React renderer
 * (this package's jest config is `testEnvironment: 'node'` with no RN
 * preset — same reason `_computeDriftStateForTests` exists).
 *
 * @param wasHolding      the phase at press-out time was 'holding'
 * @param sawTouchCancel  a native touch CANCEL was observed for this
 *                        gesture (i.e. the touch was terminated rather
 *                        than lifted)
 * @param cancelGraceMs   the `cancelGraceMs` prop
 */
export function _decidePressOutForTests(
  wasHolding: boolean,
  sawTouchCancel: boolean,
  cancelGraceMs: number,
): { action: 'commit-hold-end' | 'defer-hold-end' | 'tap' | 'none'; deferMs: number } {
  if (!wasHolding) {
    // Ended before the hold threshold.  A clean lift is a TAP; a
    // cancelled touch is nothing at all — the user never completed a
    // press, and firing a photo because the system stole the gesture
    // would be worse than doing nothing.
    return { action: sawTouchCancel ? 'none' : 'tap', deferMs: 0 };
  }
  const shouldDefer = sawTouchCancel && cancelGraceMs > 0;
  return shouldDefer
    ? { action: 'defer-hold-end', deferMs: cancelGraceMs }
    : { action: 'commit-hold-end', deferMs: 0 };
}


/**
 * Imperative handle so a parent can force-release (e.g. on unmount
 * during a long press).  Exposed via forwardRef.
 */
export interface CameraShutterHandle {
  /** Cancel any in-flight hold without calling onHoldComplete. */
  cancelHold: () => void;
}


export const CameraShutter = forwardRef<CameraShutterHandle, CameraShutterProps>(
  function CameraShutter(
    {
      onTap,
      onHoldStart,
      onHoldComplete,
      maxHoldMs,
      isProcessing = false,
      disabled = false,
      holdEnabled = true,
      cancelGraceMs = 0,
      style,
    },
    ref,
  ) {
    type Phase = 'idle' | 'pressing' | 'holding';

    // Phase machine.  We use a state value for re-render-driven
    // visuals AND a ref so onPressOut can read the up-to-date phase
    // without waiting on React's render cycle (otherwise the
    // tap-vs-hold decision can race the timer).
    const [phase, setPhase] = useState<Phase>('idle');
    const phaseRef = useRef<Phase>('idle');
    const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Separate timer for the auto-stop (max hold).  Distinct from
    // the tap-vs-hold detection timer so each can fire independently.
    const maxHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const setPhaseBoth = useCallback((next: Phase) => {
      phaseRef.current = next;
      setPhase(next);
    }, []);

    const clearHoldTimer = useCallback(() => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    }, []);

    const clearMaxHoldTimer = useCallback(() => {
      if (maxHoldTimerRef.current !== null) {
        clearTimeout(maxHoldTimerRef.current);
        maxHoldTimerRef.current = null;
      }
    }, []);

    // v0.25 — cancel-grace bookkeeping.  `sawTouchCancelRef` records
    // that THIS gesture was terminated rather than lifted; the raw
    // touch handlers set it, and press-out reads it.  Both orderings
    // are handled: `onTouchCancel` before `onPressOut` sets the flag in
    // time, and `onTouchCancel` after `onPressOut` still lands inside
    // the deferred window and vetoes the commit.
    const sawTouchCancelRef = useRef(false);
    const deferredEndRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearDeferredEnd = useCallback(() => {
      if (deferredEndRef.current !== null) {
        clearTimeout(deferredEndRef.current);
        deferredEndRef.current = null;
      }
    }, []);

    const cancelHold = useCallback(() => {
      clearHoldTimer();
      clearMaxHoldTimer();
      clearDeferredEnd();
      sawTouchCancelRef.current = false;
      setPhaseBoth('idle');
    }, [clearHoldTimer, clearMaxHoldTimer, clearDeferredEnd, setPhaseBoth]);

    useImperativeHandle(ref, () => ({ cancelHold }), [cancelHold]);

    // Belt-and-suspenders: clean both timers on unmount so a
    // fast navigation away from the camera doesn't leave one
    // firing into a stale closure.
    useEffect(() => () => {
      clearHoldTimer();
      clearMaxHoldTimer();
      clearDeferredEnd();
    }, [clearHoldTimer, clearMaxHoldTimer, clearDeferredEnd]);

    // If hold is disabled mid-press (e.g. a Pano→Photo switch while the finger
    // is down), disarm the pending hold timer so it can't still enter the
    // holding phase — paint the recording ring and fire onHoldStart — on a
    // shutter that is now tap-only.
    useEffect(() => {
      if (!holdEnabled) clearHoldTimer();
    }, [holdEnabled, clearHoldTimer]);

    const handlePressIn = useCallback(() => {
      if (disabled || isProcessing) return;
      // A press-in means the gesture is (re)granted.  If a deferred
      // hold-end is pending, this is the re-grant it was waiting for:
      // veto the commit and let the hold continue.  This is the whole
      // point of `cancelGraceMs` — a Pressable that gets remounted
      // mid-hold terminates the touch and immediately re-acquires it.
      if (deferredEndRef.current !== null) {
        clearDeferredEnd();
        sawTouchCancelRef.current = false;
        setPhaseBoth('holding');
        return;
      }
      sawTouchCancelRef.current = false;
      setPhaseBoth('pressing');
      // Tap-only: never arm the hold transition, so the button stays in
      // 'pressing' until release (→ a tap) and can never paint the recording
      // ring or fire the hold callbacks.
      if (!holdEnabled) return;
      holdTimerRef.current = setTimeout(() => {
        // Threshold elapsed → enter hold mode + notify.
        if (phaseRef.current === 'pressing') {
          setPhaseBoth('holding');
          onHoldStart();
          // Schedule the auto-stop if maxHoldMs is set.  Same
          // outcome as the user releasing the button manually —
          // fires onHoldComplete + drops back to idle.
          if (maxHoldMs && maxHoldMs > 0) {
            maxHoldTimerRef.current = setTimeout(() => {
              // Auto-stop unconditionally after maxHoldMs.  Earlier
              // versions gated this on `phase === 'holding'`, which
              // skipped the fire when iOS' gesture recogniser had
              // already flipped the phase to 'idle' due to finger
              // drift from camera motion — leaving the engine running
              // for hundreds of frames after the user thought they
              // released.  An extra onHoldComplete call when nothing
              // is recording is a safe no-op (`!incremental.isRunning`
              // early-returns).
              if (phaseRef.current === 'holding') setPhaseBoth('idle');
              onHoldComplete();
            }, maxHoldMs);
          }
        }
      }, HOLD_THRESHOLD_MS);
    }, [disabled, isProcessing, holdEnabled, onHoldStart, onHoldComplete, maxHoldMs, setPhaseBoth]);

    const handlePressOut = useCallback(() => {
      // CRITICAL: release ALWAYS stops the recording, regardless of
      // disabled/isProcessing state.  The previous version returned
      // early when `isProcessing === true`, silently swallowing the
      // release.  When that happened mid-recording, `onHoldComplete`
      // never fired, the engine kept ingesting AR frames forever
      // (hundreds of frames stacked up before the user even noticed),
      // and the final stitch ran on data the user never intended.
      //
      // The release event is the user's primary signal that they
      // want this capture to end.  No internal state is allowed to
      // block it.  `onHoldComplete` itself is idempotent (it
      // early-returns when there's nothing running), so an extra
      // call when the engine is already finishing is a safe no-op.
      const wasHolding = phaseRef.current === 'holding';
      clearHoldTimer();
      clearMaxHoldTimer();

      const { action, deferMs } = _decidePressOutForTests(
        wasHolding,
        sawTouchCancelRef.current,
        cancelGraceMs,
      );

      if (action === 'defer-hold-end') {
        // v0.25 — the touch was TERMINATED, not lifted, and the host
        // opted into a grace window.  Hold the phase (so the recording
        // ring stays lit and the engine keeps ingesting) and wait to
        // see whether the gesture is re-granted.  `handlePressIn`
        // vetoes if it is; otherwise this timer ends the hold exactly
        // as a release would, so a capture can never hang here.
        deferredEndRef.current = setTimeout(() => {
          deferredEndRef.current = null;
          sawTouchCancelRef.current = false;
          setPhaseBoth('idle');
          onHoldComplete();
        }, deferMs);
        return;
      }

      sawTouchCancelRef.current = false;
      setPhaseBoth('idle');
      if (action === 'commit-hold-end') {
        onHoldComplete();
      } else if (action === 'tap' && !disabled && !isProcessing) {
        // It was a tap (released before the threshold).  Suppress
        // the tap when the camera is busy — taps trigger photos and
        // we don't want to fire-and-forget into a busy pipeline.
        onTap();
      }
      // action === 'none' → a sub-threshold press that the system
      // cancelled.  Deliberately does nothing: firing a photo because
      // something stole the gesture is worse than ignoring it.
    }, [disabled, isProcessing, onTap, onHoldComplete, clearHoldTimer, clearMaxHoldTimer, setPhaseBoth, cancelGraceMs]);

    // Visuals.  Three layered circles so the inner colour can swap
    // without animating the outer ring (smoother on lower-end phones).
    const innerStyle =
      isProcessing
        ? styles.innerProcessing
        : phase === 'holding'
          ? styles.innerRecording
          : phase === 'pressing'
            ? styles.innerPressing
            : styles.innerIdle;

    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          phase === 'holding'
            ? 'Recording — release to stitch panorama'
            : holdEnabled
              ? 'Tap for photo, hold for panorama'
              : 'Take photo'
        }
        accessibilityState={{ disabled: disabled || isProcessing }}
        disabled={disabled || isProcessing}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        // v0.25 diagnostics — name HOW each hold ends.  `onTouchCancel`
        // fires on NATIVE cancellation (UIKit interface rotation, an
        // ancestor scrollable claiming the drag via responder
        // termination, a Modal window mounting) — cases the Pressable
        // otherwise folds into `onPressOut` indistinguishably from the
        // user lifting their finger.  A hold that ends via CANCEL was
        // NOT a user release; the v0.24.x field failures ("capture
        // self-ends after ~1 frame, landscape only") hinge on exactly
        // this distinction, so the log names the killer directly
        // instead of leaving it to inference.  Warn-level (not __DEV__
        // -gated): integrators hit this in release-ish builds and this
        // line is the difference between a one-log diagnosis and days
        // of guessing.  The behavioural fix (cancel ⇒ capture
        // CONTINUES, tap-to-finish) ships separately, flag-gated.
        onTouchCancel={() => {
          // Record it for `handlePressOut`.  Ordering-safe: if the
          // cancel lands FIRST, press-out reads the flag; if it lands
          // second, press-out has already committed (grace off) or is
          // sitting in the deferred window (grace on).
          sawTouchCancelRef.current = true;
          // eslint-disable-next-line no-console
          console.warn(
            '[react-native-image-stitcher] shutter touch CANCELLED by '
            + `the system (phase=${phaseRef.current}). If a recording `
            + 'just ended, the user did NOT release — something stole '
            + 'the touch (interface rotation, a parent ScrollView '
            + 'claiming the pan drag, or a Modal mount).',
          );
        }}
        onTouchEnd={() => {
          // A real finger-lift.  Clear any cancel seen earlier in this
          // gesture so the lift is committed immediately — a genuine
          // release is NEVER delayed by `cancelGraceMs`.
          sawTouchCancelRef.current = false;
          if (phaseRef.current === 'holding') {
            // eslint-disable-next-line no-console
            console.log('[react-native-image-stitcher] shutter released by user (holding → end)');
          }
        }}
        style={[styles.outer, disabled && styles.disabled, style]}
      >
        <View style={styles.ring} />
        <View style={[styles.inner, innerStyle]} />
      </Pressable>
    );
  },
);


const styles = StyleSheet.create({
  outer: {
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.4,
  },
  ring: {
    position: 'absolute',
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#ffffff',
  },
  inner: {
    width: 60,
    height: 60,
    borderRadius: 30,
  },
  innerIdle: {
    backgroundColor: '#ffffff',
  },
  innerPressing: {
    // Subtle shrink-effect via colour shift; opacity dims confirm
    // touch landed without committing to a mode yet.
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  innerRecording: {
    // Apple-native panorama / shutter recording uses red.
    backgroundColor: '#FF3B30',
  },
  innerProcessing: {
    // Greyed mid-tone with reduced contrast — clearly "busy, can't
    // press me" without being alarming.
    backgroundColor: '#9aa0a6',
  },
});
