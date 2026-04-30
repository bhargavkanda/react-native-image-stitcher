/**
 * CaptureStatusOverlay — screen-level visual feedback for the
 * panorama capture lifecycle.
 *
 * Lives in the SDK because the existing shutter-button colour change
 * is hidden by the user's finger during a hold.  An overlay above
 * the preview is the only reliable channel for "you ARE recording
 * right now" feedback.
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  ● REC  Hold steady, pan slowly…                 │ ← banner
 *   ├──────────────────────────────────────────────────┤
 *   │ ┌──────────────────────────────────────────────┐ │
 *   │ │                                              │ │
 *   │ │           ⬛  red glow border                 │ │
 *   │ │           around the preview                 │ │
 *   │ │                                              │ │
 *   │ └──────────────────────────────────────────────┘ │
 *   └──────────────────────────────────────────────────┘
 *
 * The component is intentionally pure-presentational: it takes a
 * `phase` prop and renders the matching UI.  Recording vs stitching
 * vs idle is the host's source of truth — typically derived from
 * `useVideoCapture().state` and a local "isStitching" boolean.
 *
 * The overlay renders nothing in `idle` so the host can render it
 * unconditionally without conditional layout shifts.
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useDeviceOrientation } from './useDeviceOrientation';


export type CaptureStatusPhase = 'idle' | 'recording' | 'stitching';


export interface CaptureStatusOverlayProps {
  /**
   * Current phase.  `idle` renders nothing.  `recording` shows the
   * REC banner + red glowing border.  `stitching` swaps to a neutral
   * "Stitching..." banner with no border (recording is over; UI
   * cue should de-escalate).
   */
  phase: CaptureStatusPhase;
  /**
   * Optional override for the recording-phase message.  Defaults to
   * "Hold steady — pan slowly".  Useful if the host wants direction
   * hints (e.g. "Pan down across the rack") for a specific audit
   * type.
   */
  recordingMessage?: string;
  /**
   * Optional override for the stitching-phase message.  Defaults to
   * "Stitching panorama…".
   */
  stitchingMessage?: string;
  /**
   * If set, the recording-phase banner shows a live countdown
   * ("REC 4s left") computed against this value.  Set to the
   * shutter's `maxHoldMs` so the user can see how long they have
   * left before the auto-stop fires.  Pair with a fresh value
   * each time recording starts so the timer resets per capture.
   *
   * `recordingStartedAt` is the timestamp (Date.now()) when the
   * recording phase began — required for the countdown math.
   */
  countdownMs?: number;
  recordingStartedAt?: number;
  /**
   * Top inset to offset the banner below the status bar / notch.
   * Defaults to 0 — host apps using `react-native-safe-area-context`
   * should pass `insets.top` here so the banner doesn't disappear
   * behind the notch.
   */
  topInset?: number;
  /** Outer style passthrough. */
  style?: StyleProp<ViewStyle>;
}


export function CaptureStatusOverlay({
  phase,
  recordingMessage = 'Hold steady — pan slowly',
  stitchingMessage = 'Stitching panorama…',
  countdownMs,
  recordingStartedAt,
  topInset = 0,
  style,
}: CaptureStatusOverlayProps): React.JSX.Element | null {
  // Countdown ticker — re-renders every 250 ms while recording so
  // the "REC 4s left" text stays current without flooding render
  // calls.  Disabled (no interval) when not in recording phase or
  // when countdown isn't configured.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (phase !== 'recording' || !countdownMs || !recordingStartedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [phase, countdownMs, recordingStartedAt]);
  // Pulse animation for the REC dot.  Driven by a single Animated
  // value that loops 0→1→0.  Cheap (no listeners, runs on the
  // native driver) and only spins up while recording.
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (phase !== 'recording') {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  // Always call the hook — even when phase is 'idle' — so React's
  // hook-order rule isn't violated.  The accelerometer subscription
  // is cheap and stays alive for the screen's lifetime.
  const deviceOrientation = useDeviceOrientation();

  if (phase === 'idle') return null;

  // Interpolate pulse → opacity & scale so the dot breathes 0.6→1.0
  // opacity and 1.0→1.3 scale.  Subtle; not distracting.
  const dotOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.5, 1],
  });
  const dotScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.3],
  });

  // The red border appears only during recording — once the user
  // releases and we move to stitching the recording is over and a
  // bright red border would be misleading.
  const showBorder = phase === 'recording';

  // Compute remaining seconds for the countdown.  Re-rendered
  // every 250 ms by the tick interval above.  If countdownMs or
  // recordingStartedAt are missing we just render the base
  // message without a "Xs left" suffix.
  let baseMessage =
    phase === 'recording' ? recordingMessage : stitchingMessage;
  if (
    phase === 'recording'
    && countdownMs
    && recordingStartedAt
  ) {
    const elapsedMs = Date.now() - recordingStartedAt;
    const remainingMs = Math.max(0, countdownMs - elapsedMs);
    const remainingSec = Math.ceil(remainingMs / 1000);
    baseMessage = `${recordingMessage} · ${remainingSec}s left`;
  }
  const message = baseMessage;

  // Orientation-aware banner placement.  The app is portrait-locked
  // at the OS level, so we re-position via absolute coords + apply
  // a rotation transform so the banner appears at "user-perceived
  // top" regardless of how they're holding the phone.
  const bannerOrientationStyle = bannerStyleForOrientation(
    deviceOrientation,
    topInset,
  );

  return (
    <View
      // pointerEvents=box-none so the overlay never steals taps from
      // the underlying camera / shutter / preview.  The banner and
      // border are read-only.
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, style]}
      accessibilityLiveRegion="polite"
    >
      {showBorder ? (
        <View pointerEvents="none" style={styles.recordBorder} />
      ) : null}

      <View
        pointerEvents="none"
        style={[
          styles.banner,
          phase === 'recording' ? styles.bannerRecording : styles.bannerStitching,
          bannerOrientationStyle,
        ]}
      >
        {phase === 'recording' ? (
          <Animated.View
            style={[
              styles.recDot,
              { opacity: dotOpacity, transform: [{ scale: dotScale }] },
            ]}
          />
        ) : (
          <View style={styles.stitchSpinner} />
        )}
        <Text style={styles.bannerText} numberOfLines={1}>
          {phase === 'recording' ? 'REC' : '•••'}{'  '}{message}
        </Text>
      </View>
    </View>
  );
}


/**
 * Compute absolute-positioning + transform so the banner sits at
 * the user-perceived top of the screen.
 *
 * The app's layout is always portrait.  When the user rotates the
 * phone, `transform: [{ rotate }]` rotates the element to match
 * the device, and the absolute position is shifted to whichever
 * layout-edge corresponds to the user's perceived "top".
 *
 *   portrait        → layout-top    + 0°
 *   landscape-left  → layout-right  + 90°
 *   landscape-right → layout-left   − 90°
 *   upside-down     → layout-bottom + 180°
 */
function bannerStyleForOrientation(
  orientation:
    | 'portrait'
    | 'portrait-upside-down'
    | 'landscape-left'
    | 'landscape-right',
  topInset: number,
): {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  alignSelf?: 'center' | 'flex-start' | 'flex-end';
  transform?: { rotate: string }[];
} {
  switch (orientation) {
    case 'landscape-left':
      // Phone rotated 90° CCW (lightning port on left, status bar
      // on left edge of layout).  User's perceived top = layout's
      // right edge.  Rotate banner 90° CW so its text runs
      // bottom-to-top in layout space, which reads left-to-right
      // in the user's view.
      return {
        right: topInset + 8,
        alignSelf: 'center',
        transform: [{ rotate: '90deg' }],
      };
    case 'landscape-right':
      return {
        left: topInset + 8,
        alignSelf: 'center',
        transform: [{ rotate: '-90deg' }],
      };
    case 'portrait-upside-down':
      return {
        bottom: topInset + 8,
        alignSelf: 'center',
        transform: [{ rotate: '180deg' }],
      };
    case 'portrait':
    default:
      return {
        top: topInset + 8,
        alignSelf: 'center',
      };
  }
}


const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 22,
    minHeight: 36,
  },
  bannerRecording: {
    backgroundColor: 'rgba(255,59,48,0.92)',
  },
  bannerStitching: {
    // Neutral grey while we wait for the stitcher; communicates
    // "still working" without the alarming red of active recording.
    backgroundColor: 'rgba(0,0,0,0.78)',
  },
  bannerText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 8,
  },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ffffff',
  },
  stitchSpinner: {
    // Static dot for now — RN's ActivityIndicator is fine here too,
    // but a calm static dot keeps visual noise low when the user
    // already gets the spinner via the shutter-button "processing"
    // state below.
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ffffff',
    opacity: 0.7,
  },
  recordBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 4,
    borderColor: 'rgba(255,59,48,0.9)',
  },
});
