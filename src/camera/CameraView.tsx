// SPDX-License-Identifier: Apache-2.0
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
  /**
   * Enable video recording on the underlying camera.  Required for
   * `useVideoCapture().startRecording()` — vision-camera throws
   * `capture/video-not-enabled` if you call startRecording without
   * this flag set.  Defaults to `false` so apps that only take photos
   * don't pay the video-pipeline allocation cost.
   *
   * Photo capture remains enabled regardless of this flag, so a
   * single `<CameraView video />` can do both tap (photo) and
   * hold (video → stitch) flows.
   */
  video?: boolean;
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

  /**
   * Forwarded from vision-camera's `<Camera onError>` AFTER lifecycle
   * errors are filtered.  The SDK's built-in filter swallows:
   *
   *   * `system/camera-is-restricted` — screen-lock / DoNotDisturb
   *     temporarily revokes camera access; vision-camera re-acquires
   *     on resume.  Logged to console.warn, NOT surfaced.
   *   * `system/camera-has-been-disconnected` — another app grabbed
   *     the camera.  Same auto-recovery.
   *   * `device/camera-already-in-use` — same class as above.
   *
   * Real errors (permission denials, hardware failures, malformed
   * format requests) are forwarded.  Hosts can therefore safely
   * pipe this to a redbox / Crashlytics without getting paged on
   * routine screen-lock events.
   */
  onError?: (error: unknown) => void;
}


/**
 * A forwardRef'd wrapper that exposes the underlying Camera ref
 * to callers (so ``cameraRef.current.takePhoto()`` keeps working),
 * while presenting a smaller API on the outside.
 */
// Error codes vision-camera reports for transient lifecycle events.
// Filtered out of the SDK's onError forward (see `handleVcError` in
// the body): the camera self-recovers when the device comes back into
// the foreground / regains permission / the other app releases the
// device.  Surfacing these as host errors causes spurious crash
// reports during routine phone-lock / app-switch operations.
const VC_LIFECYCLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'system/camera-is-restricted',         // screen lock, DoNotDisturb, MDM policy
  'system/camera-has-been-disconnected', // another app grabbed the camera
  'device/camera-already-in-use',        // same class as above
]);


export const CameraView = forwardRef<Camera | null, CameraViewProps>(function CameraView(
  {
    device,
    flash = 'off',
    isActive = true,
    video = false,
    guidance,
    style,
    cameraProps,
    onError,
  },
  ref,
): React.JSX.Element {
  // Error filter — see `VC_LIFECYCLE_ERROR_CODES` for the swallow
  // list rationale.  `code` on vision-camera's `CameraRuntimeError`
  // is typed as a string; treat any non-string defensively as a
  // "forward it" so we don't accidentally swallow unknown errors.
  const handleVcError = (err: unknown): void => {
    const code = (err as { code?: unknown })?.code;
    if (typeof code === 'string' && VC_LIFECYCLE_ERROR_CODES.has(code)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[react-native-image-stitcher] vision-camera reported a '
        + `transient lifecycle error (${code}); the camera will `
        + 'auto-recover on resume.  Not forwarding to onError.',
      );
      return;
    }
    onError?.(err);
  };
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
        video={video}
        // Bake the device orientation into the captured pixels.
        // Without this, vision-camera writes the file in the camera
        // sensor's native landscape and relies on EXIF metadata to
        // tell viewers "rotate me" — but RN's <Image> on iOS often
        // ignores EXIF, leading to thumbnails / previews appearing
        // sideways even though the user shot in portrait.  Setting
        // `outputOrientation="device"` rotates the pixels to match
        // how the user is holding the phone, so the saved JPEG is
        // "what you see is what was taken".
        outputOrientation="device"
        torch={flash === 'on' ? 'on' : 'off'}
        onError={handleVcError}
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
