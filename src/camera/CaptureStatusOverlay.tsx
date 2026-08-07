// SPDX-License-Identifier: Apache-2.0
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

import React, { useContext, useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  HostJsLandscapeContext,
  contentRotationDeg,
  framebufferEdge,
} from './useContentRotation';
import { useDeviceOrientation, type DeviceOrientation } from './useDeviceOrientation';


export type CaptureStatusPhase = 'idle' | 'recording' | 'stitching';


export interface CaptureStatusOverlayProps {
  /**
   * Current phase.  `idle` renders nothing.  `recording` shows the
   * REC banner + glowing border (GREEN normally, RED when `tooFast`).
   * `stitching` swaps to a neutral "Stitching..." banner with no border
   * (recording is over; UI cue should de-escalate).
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
   * v0.16 — speed feedback.  When `false` (default) the recording banner +
   * border are GREEN ("your pace is fine"); when `true` they turn RED to
   * signal the pan is too fast.  This consolidates the old always-red border
   * + separate amber "slow down" pill into one calm-by-default cue.
   */
  tooFast?: boolean;
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
  tooFast = false,
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
  const { width, height } = useWindowDimensions();
  const measuredLandscape = useContext(HostJsLandscapeContext);
  const isJsLandscape = measuredLandscape ?? width > height;

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

  // Orientation-aware banner placement via DIRECT absolute positioning
  // + percentage transforms.
  //
  // Why this instead of a rotated-wrapper approach: the previous
  // wrapper approach (sized to user-view dims, positioned to align
  // center, rotated) is geometrically correct on paper but rendered
  // off-center on device (probably a RN flex+rotation interaction).
  // Direct absolute positioning of the banner with translateX/Y('-50%')
  // for self-centering is simpler, doesn't depend on useWindowDimensions,
  // and uses only well-trodden RN style features.
  //
  // Border is rendered separately because it hugs the physical camera
  // preview (in layout coords) — it must not rotate with the banner.
  const bannerOrientationStyle = bannerStyleForOrientation(
    deviceOrientation,
    topInset,
    isJsLandscape,
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
        <View
          pointerEvents="none"
          style={[
            styles.recordBorder,
            tooFast ? styles.recordBorderTooFast : styles.recordBorderOk,
          ]}
        />
      ) : null}

      <View
        pointerEvents="none"
        style={[
          styles.banner,
          phase === 'recording'
            ? (tooFast ? styles.bannerTooFast : styles.bannerRecording)
            : styles.bannerStitching,
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
 * Compute the style placing the banner at user-perceived top-center
 * with text reading in the user's view direction.
 *
 * Approach: direct absolute positioning + percentage-translate self-
 * centering (works on the banner's own measured dimensions, so the
 * banner's text content can be any width).
 *
 * For each orientation, anchor the banner to the layout edge that
 * corresponds to user-perceived top:
 *
 *   portrait              → layout-top    + horizontally centered + 0°
 *   portrait-upside-down  → layout-bottom + horizontally centered + 180°
 *   landscape-left        → layout-right  + vertically centered   + 90°
 *   landscape-right       → layout-left   + vertically centered   + -90°
 *
 * In landscape, the banner is rotated around its center so its text
 * (originally horizontal in layout) reads horizontally in the user's
 * view.  The translateY('-50%') aligns the banner's center with the
 * layout's vertical center, which maps to user-horizontal-center
 * post-rotation.
 *
 * RN supports `'50%'` for absolute positions and percentage values in
 * translateX/Y since 0.70 — the percentage in a translate is relative
 * to the element's OWN dimensions, which is exactly what self-
 * centering an unknown-width element needs.
 */
export function bannerStyleForOrientation(
  orientation: DeviceOrientation,
  topInset: number,
  jsLandscape: boolean = false,
): ViewStyle {
  // Single source of truth, shared with the k/n counter's
  // `placeAtUserEdge('bottom')`: the net rotation from `contentRotationDeg`
  // (device − framebuffer) and the framebuffer edge that maps to the user's
  // TOP.  This replaces the previous hand-rolled jsLandscape + per-orientation
  // switch, so the pill and the counter can never drift apart.
  const net = contentRotationDeg(jsLandscape, orientation);
  const edge = framebufferEdge('top', net);
  const rotate = `${net}deg`;

  // Keep the pill's DIRECT absolute + percentage-translate self-centering
  // (NOT the counter's flex layer): the banner is wide, so on the ±90° side
  // edges it needs `translateX(±50%)` to cancel its own width — a flex anchor
  // would offset it by half its length.  Side edges use the tuned 34 px anchor
  // (8 px gap + banner_height/2 after the self-centre); top/bottom read
  // horizontally so only need `topInset + 8` + `translateX(-50%)`.
  switch (edge) {
    case 'right': // user-top when the framebuffer is rotated +90° (locked landscape-left)
      return {
        position: 'absolute',
        right: 34,
        top: '50%',
        transform: [{ translateY: '-50%' }, { translateX: '50%' }, { rotate }],
      };
    case 'left': // user-top when rotated −90° (locked landscape-right)
      return {
        position: 'absolute',
        left: 34,
        top: '50%',
        transform: [{ translateY: '-50%' }, { translateX: '-50%' }, { rotate }],
      };
    case 'bottom': // user-top when rotated 180° (locked upside-down)
      return {
        position: 'absolute',
        bottom: topInset + 8,
        left: '50%',
        transform: [{ translateX: '-50%' }, { rotate }],
      };
    case 'top': // user-top with no rotation (portrait, or any non-locked landscape)
    default:
      return {
        position: 'absolute',
        top: topInset + 8,
        left: '50%',
        transform: [{ translateX: '-50%' }, { rotate }],
      };
  }
}


const styles = StyleSheet.create({
  banner: {
    // position: 'absolute' is added back so the orientation-specific
    // style (returned by bannerStyleForOrientation) can position the
    // banner at the layout edge for that orientation using top/right/
    // bottom/left.  The transform array on the same style does the
    // self-centering via translateX/Y('-50%') and applies rotation.
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 22,
    minHeight: 36,
  },
  bannerRecording: {
    // Green by default — "you're recording and your pace is fine".
    backgroundColor: 'rgba(52,199,89,0.92)',
  },
  bannerTooFast: {
    // Red only when the pan is too fast (consolidates the old amber pill).
    backgroundColor: 'rgba(255,59,48,0.94)',
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
  },
  recordBorderOk: {
    // Green by default (calm — the pan pace is fine).
    borderColor: 'rgba(52,199,89,0.9)',
  },
  recordBorderTooFast: {
    // Red only when too fast.
    borderColor: 'rgba(255,59,48,0.95)',
  },
});
