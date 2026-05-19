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
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useDeviceOrientation, type DeviceOrientation } from './useDeviceOrientation';


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
  // useWindowDimensions hook also must be called before any early-
  // return — same hook-order rule.  W/H reflect the OS-reported
  // window in portrait (the host app is portrait-locked at OS
  // level), so for landscape we'll swap W/H when sizing the wrapper.
  const { width: winW, height: winH } = useWindowDimensions();

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

  // Orientation-aware banner placement via a rotated full-screen
  // wrapper.  Inside the wrapper the banner sits at its natural
  // "top-center" (top: topInset+8, alignSelf: 'center') — when the
  // wrapper rotates to match the user-perceived orientation, the
  // banner moves with it and ends up at user-perceived top-center
  // regardless of how the user is holding the phone.
  //
  // Border is rendered OUTSIDE the wrapper because it should hug the
  // physical camera preview (which is fixed to portrait layout coords
  // by the OS-level orientation lock); rotating it would put it on
  // the wrong edges of the screen.
  const wrapperStyle = bannerWrapperStyleForOrientation(
    deviceOrientation,
    winW,
    winH,
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

      <View pointerEvents="box-none" style={wrapperStyle}>
        <View
          pointerEvents="none"
          style={[
            styles.banner,
            phase === 'recording' ? styles.bannerRecording : styles.bannerStitching,
            // marginTop (not `top`) — `top` is ignored on non-absolute
            // flex children in RN.  Horizontal centering via
            // alignSelf works because the banner IS a flex child here
            // (it's no longer position:absolute).
            { marginTop: topInset + 8, alignSelf: 'center' },
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
    </View>
  );
}


/**
 * Compute the style for a full-screen wrapper View that, after its
 * rotation transform is applied, covers the screen with its local
 * "top" axis pointing toward the user's perceived top.
 *
 * Why this approach (instead of positioning the banner directly):
 * positioning + rotating the banner alone forced us to compute,
 * for each orientation, "which layout edge corresponds to the
 * user's top, and what does `alignSelf: 'center'` actually do to
 * a `position: absolute` element" — the latter answer being "it's
 * ignored", which silently broke centering in landscape.
 *
 * The wrapper trick: the banner lives at the wrapper's natural
 * top-center (top: 8, alignSelf: 'center').  Rotating the wrapper
 * carries the banner along.  Sizing the wrapper to user-view
 * dimensions (swap W↔H for landscape) + translating it so its
 * center sits over the screen center means that after the
 * rotation, the wrapper covers the screen and the banner ends up
 * exactly at user-top-center.
 *
 *   portrait              → wrapper W×H,  no rotation
 *   portrait-upside-down  → wrapper W×H,  180° rotation
 *   landscape-left        → wrapper H×W,  90° CW rotation
 *   landscape-right       → wrapper H×W, -90° CCW rotation
 *
 * The H×W wrapper is offset by ((W-H)/2, (H-W)/2) so its center
 * aligns with screen center; after rotation it covers the screen
 * exactly.
 *
 * Rotation direction (CW vs CCW): the user-facing orientation hook
 * uses iOS' "home-indicator-on-right = landscape-left" convention
 * (the phone was rotated 90° CCW from portrait to get here).  To
 * keep content upright in the user's view, the content needs to
 * rotate 90° CW.  Mirror logic for landscape-right.
 */
function bannerWrapperStyleForOrientation(
  orientation: DeviceOrientation,
  winW: number,
  winH: number,
): ViewStyle {
  switch (orientation) {
    case 'landscape-left':
      return {
        position: 'absolute',
        width: winH,
        height: winW,
        left: (winW - winH) / 2,
        top: (winH - winW) / 2,
        transform: [{ rotate: '90deg' }],
      };
    case 'landscape-right':
      return {
        position: 'absolute',
        width: winH,
        height: winW,
        left: (winW - winH) / 2,
        top: (winH - winW) / 2,
        transform: [{ rotate: '-90deg' }],
      };
    case 'portrait-upside-down':
      return {
        ...StyleSheet.absoluteFillObject,
        transform: [{ rotate: '180deg' }],
      };
    case 'portrait':
    default:
      return StyleSheet.absoluteFillObject;
  }
}


const styles = StyleSheet.create({
  banner: {
    // No `position: 'absolute'` here.  The banner is a normal flex
    // child of the rotated wrapper; `alignSelf: 'center'` (applied
    // inline at the JSX site) only works when the element is part
    // of the parent's flex flow.  Top offset is `top: <topInset>+8`
    // inline since it's a runtime value from props.
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
