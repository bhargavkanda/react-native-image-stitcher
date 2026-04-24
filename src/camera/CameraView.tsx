/**
 * CameraView — the SDK's drop-in replacement for the raw
 * vision-camera ``<Camera />``.
 *
 * Why wrap it?
 *   1. **Default props** — always ``isActive={true}``, ``photo={true}``,
 *      and honouring the hook's flash state.  Every call-site in the
 *      mobile app repeated the same tuple; the SDK canonicalises it.
 *   2. **Branded guidance overlay** — optional ``guidance`` prop renders
 *      a themed banner over the preview without the host app having to
 *      know about positioning / contrast.
 *   3. **Forward ref** — so ``useCapture``'s ref attaches cleanly.
 *
 * The component is intentionally thin — anything more elaborate goes
 * into a separate screen (e.g. AuditCaptureSurface that combines this
 * view with thumbnails and a shutter button).  Keeping CameraView at
 * the vision-camera layer means host apps that want a highly-custom
 * UI can still use it as their building block.
 */

import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import {
  Camera,
  type CameraDevice,
  type CameraProps,
} from 'react-native-vision-camera';


export interface CameraViewProps {
  /** Output of ``useCapture().device``.  If null, a placeholder is shown. */
  device: CameraDevice | null | undefined;
  /** Flash / torch state from ``useCapture().flash``. */
  flash?: 'off' | 'on';
  /** Whether the preview is actively rendering.  Defaults to true. */
  isActive?: boolean;
  /** Optional themed guidance banner.  Renders over the preview at the top. */
  guidance?: string;
  /** Extra style layer applied on top of the default full-screen layout. */
  style?: ViewStyle;
  /** Pass-through to vision-camera for anything custom. */
  cameraProps?: Partial<CameraProps>;
  /**
   * Called when the user taps the preview.  Host apps may use this to
   * drive focus-on-tap, AE/AF lock, etc.  Not wired into vision-camera's
   * focus API by this component on purpose — host apps have different
   * preferences (focus-on-tap vs. tap-to-lock).
   */
  onPreviewTap?: (event: { x: number; y: number }) => void;
}


/**
 * A forwardRef'd wrapper that exposes the underlying Camera ref
 * to callers (so ``cameraRef.current.takePhoto()`` keeps working),
 * while presenting a smaller API on the outside.
 */
export const CameraView = forwardRef<Camera | null, CameraViewProps>(function CameraView(
  {
    device,
    flash = 'off',
    isActive = true,
    guidance,
    style,
    cameraProps,
  },
  ref,
): React.JSX.Element {
  // Internal ref so we can both attach to <Camera> and forward outward.
  const innerRef = useRef<Camera>(null);
  useImperativeHandle(ref, () => innerRef.current as Camera);

  if (!device) {
    return (
      <View style={[styles.placeholder, style]} accessibilityLabel="Camera initialising">
        <Text style={styles.placeholderText}>Initialising camera…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, style]}>
      <Camera
        ref={innerRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
        photo
        torch={flash === 'on' ? 'on' : 'off'}
        {...cameraProps}
      />
      {guidance ? (
        <View style={styles.guidance} pointerEvents="none" accessible accessibilityRole="text">
          <Text style={styles.guidanceText} numberOfLines={2}>
            {guidance}
          </Text>
        </View>
      ) : null}
    </View>
  );
});


const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  placeholderText: {
    color: '#ffffff',
    fontSize: 14,
  },
  guidance: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  guidanceText: {
    color: '#ffffff',
    fontSize: 13,
  },
});
