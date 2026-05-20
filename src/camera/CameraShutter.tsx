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
  /** Optional style applied to the outer touch target. */
  style?: ViewStyle;
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

    const cancelHold = useCallback(() => {
      clearHoldTimer();
      clearMaxHoldTimer();
      setPhaseBoth('idle');
    }, [clearHoldTimer, clearMaxHoldTimer, setPhaseBoth]);

    useImperativeHandle(ref, () => ({ cancelHold }), [cancelHold]);

    // Belt-and-suspenders: clean both timers on unmount so a
    // fast navigation away from the camera doesn't leave one
    // firing into a stale closure.
    useEffect(() => () => {
      clearHoldTimer();
      clearMaxHoldTimer();
    }, [clearHoldTimer, clearMaxHoldTimer]);

    const handlePressIn = useCallback(() => {
      if (disabled || isProcessing) return;
      setPhaseBoth('pressing');
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
    }, [disabled, isProcessing, onHoldStart, onHoldComplete, maxHoldMs, setPhaseBoth]);

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
      setPhaseBoth('idle');
      if (wasHolding) {
        onHoldComplete();
      } else if (!disabled && !isProcessing) {
        // It was a tap (released before the threshold).  Suppress
        // the tap when the camera is busy — taps trigger photos and
        // we don't want to fire-and-forget into a busy pipeline.
        onTap();
      }
    }, [disabled, isProcessing, onTap, onHoldComplete, clearHoldTimer, clearMaxHoldTimer, setPhaseBoth]);

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
            : 'Tap for photo, hold for panorama'
        }
        accessibilityState={{ disabled: disabled || isProcessing }}
        disabled={disabled || isProcessing}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
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
