/**
 * CaptureControlsBar — bottom-of-screen controls for any capture
 * surface.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  [⚡ flash]      [● shutter]      [ host slot ]            │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The SDK owns the flash button and the shutter button (which is
 * `<CameraShutter>` under the hood, so tap-vs-hold gesture handling
 * comes "for free" in any host that uses this).  The right-side
 * action is a render-prop — host apps put a "Submit", "Done",
 * "Save", "Next" button there as fits their flow.
 *
 * Why a slot for the right-side action?
 *   The flash and shutter buttons are universally camera-shaped;
 *   every host wants them with the same gesture, the same colors,
 *   the same accessibility labels.  But the third action varies
 *   wildly — submitting an audit, saving a single photo, advancing
 *   a wizard step.  Slotting keeps the SDK from prescribing host
 *   semantics.
 */

import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { CameraShutter } from './CameraShutter';


export interface CaptureControlsBarProps {
  /** Current flash mode — drives the flash icon's colour. */
  flashMode: 'off' | 'on';
  /** Called when the flash button is pressed. */
  onToggleFlash: () => void;

  // ── Shutter callbacks (forwarded to <CameraShutter>) ───────────────
  /** Tap → take photo. */
  onShutterTap: () => void;
  /** Hold crosses threshold → start video recording. */
  onShutterHoldStart: () => void;
  /** Release after hold → stop recording, stitch. */
  onShutterHoldComplete: () => void;
  /**
   * Disable the shutter (e.g. at-max-photos for the audit, no
   * camera permission, etc).  Flash and the right-side action
   * remain interactive.
   */
  shutterDisabled?: boolean;
  /**
   * Show the shutter's "processing" visual.  Use this while a
   * stitch is in progress so the operator can't kick off a second
   * recording mid-stitch.
   */
  shutterProcessing?: boolean;

  /**
   * Render-prop slot for the host's right-side action.  Typically a
   * Pressable wrapping a "Submit" / "Done" button, but anything is
   * fair game.  Receives no arguments — wire your callbacks in the
   * usual way.
   *
   * Pass `null` to render an empty spacer instead (keeps the shutter
   * centred when there's no action to show).
   */
  rightAction?: React.ReactNode;

  /** Override the default colours. */
  colors?: {
    background?: string;
    iconButton?: string;
    iconActive?: string;
    icon?: string;
    iconAccessible?: string;
  };

  /** Bottom inset for safe-area on devices with a home indicator. */
  bottomInset?: number;

  /** Outer style passthrough. */
  style?: StyleProp<ViewStyle>;
}


export function CaptureControlsBar({
  flashMode,
  onToggleFlash,
  onShutterTap,
  onShutterHoldStart,
  onShutterHoldComplete,
  shutterDisabled = false,
  shutterProcessing = false,
  rightAction = null,
  colors,
  bottomInset = 0,
  style,
}: CaptureControlsBarProps): React.JSX.Element {
  const bg = colors?.background ?? '#000000';
  const iconButtonBg = colors?.iconButton ?? 'rgba(255,255,255,0.12)';
  const iconActiveBg = colors?.iconActive ?? '#FF9F0A';
  const iconColor = colors?.icon ?? '#ffffff';

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: bg, paddingBottom: bottomInset + 16 },
        style,
      ]}
    >
      {/* Flash button — colour shifts when active. */}
      <Pressable
        onPress={onToggleFlash}
        accessibilityRole="button"
        accessibilityLabel={`Flash ${flashMode === 'on' ? 'on' : 'off'}`}
        accessibilityState={{ selected: flashMode === 'on' }}
        style={[
          styles.iconButton,
          { backgroundColor: flashMode === 'on' ? iconActiveBg : iconButtonBg },
        ]}
        hitSlop={8}
      >
        <Text style={[styles.icon, { color: iconColor }]}>⚡</Text>
      </Pressable>

      {/* Shutter — SDK component, owns tap-vs-hold gesture. */}
      <CameraShutter
        onTap={onShutterTap}
        onHoldStart={onShutterHoldStart}
        onHoldComplete={onShutterHoldComplete}
        disabled={shutterDisabled}
        isProcessing={shutterProcessing}
      />

      {/* Right-side host slot.  Wrapped in a fixed-width view so
       *  the flash and shutter stay positioned identically across
       *  hosts regardless of what the slot contains. */}
      <View style={styles.rightSlot}>{rightAction}</View>
    </View>
  );
}


const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 22,
  },
  rightSlot: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
