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

import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import {
  Camera,
  type CameraDevice,
  type CameraProps,
} from 'react-native-vision-camera';

import { pickCaptureFormat } from './pickCaptureFormat';


/**
 * Cap on the chosen capture format's PHOTO long edge (px).  4032 ≈ 12 MP at
 * 4:3 ("4K"-ish), matching the 1× lens, so the ultra-wide stops producing a
 * 48 MP / ~6000 px still.  Set to 2016 for "2K" (~3 MP).  `0` reverts to pure
 * max-video.  TODO(v0.16): expose as a `<Camera photoMaxLongEdge>` prop once
 * the 0.5× panorama 8-bit check passes on-device.
 */
const PHOTO_LONG_EDGE_CAP = 4032;
/**
 * Photo long-edge cap when `highResCapture` is set (document scanning).  4096
 * admits the common 12.5 MP 4:3 still (4080×3060) that the 4032 cap excluded,
 * without chasing 48 MP+ stills (memory).  The chosen format's video stream is
 * still bounded by the 4:3 + preferHighFps logic, so the preview is unchanged.
 */
const HIGH_RES_PHOTO_LONG_EDGE_CAP = 4096;

/** keyframeQualityCapture video floor — matches the AR path's 1280 keyframe
 *  budget (stitcher ef1a326/8e655c8) so both pano sources deliver comparable
 *  tiles. */
const KEYFRAME_QUALITY_MIN_VIDEO_LONG_EDGE = 1280;


export interface CameraViewProps {
  /** Output of ``useCapture().device``.  If null, a placeholder is shown. */
  device: CameraDevice | null | undefined;
  /** Flash / torch state from ``useCapture().flash``. */
  flash?: 'off' | 'on';
  /**
   * v0.13.2 — zoom factor for the mounted device.  Used in multi-cam
   * mode to switch lenses (0.5× ultra-wide ↔ 1× wide) on a single
   * device.  `undefined` leaves vision-camera at its default zoom.
   */
  zoom?: number;
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
  /**
   * Opt into HIGH-RESOLUTION still capture (e.g. document scanning).  Raises
   * the photo-resolution cap so the picker selects the device's largest 4:3
   * still (e.g. 12.5 MP / 4080×3060 on the A35) and runs the camera at
   * `photoQualityBalance="quality"`.  The chosen format's VIDEO stream is
   * unchanged (still the 4:3 preview the frame-processor detection runs on),
   * so the preview + detection are unaffected — only the captured photo gets
   * bigger.  Default off (keeps the 4032px cap for back-compat).
   */
  highResCapture?: boolean;
  /**
   * iOS: opt into AVDepthData delivery for stills, so `useCapture` can save
   * a `<photo>.depth.bin` sidecar (see `extractPhotoDepth`).  Biases the
   * format picker toward `supportsDepthCapture` formats and sets
   * vision-camera's `enableDepthData`.  Depth only materialises when the
   * MOUNTED DEVICE is depth-capable (a multi-lens virtual device or the
   * LiDAR camera — the lens-driven `selectCaptureDevice` multicam pick
   * qualifies; a plain single wide-angle does not).  No-op on Android and
   * on depth-less devices/formats — capture proceeds without a sidecar.
   * Default off (depth delivery adds per-shot latency).
   */
  captureDepthData?: boolean;
  /**
   * Panorama keyframe QUALITY (non-AR path): floors the picked format's
   * VIDEO long edge at 1280 so the frame-processor stream — the source of
   * non-AR pano keyframes — stops delivering 640×480 tiles.  The 60 fps
   * preference still ranks within the floored set.  Soft on devices with
   * no qualifying format.  Default off.
   */
  keyframeQualityCapture?: boolean;
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
    zoom,
    isActive = true,
    video = false,
    highResCapture = false,
    captureDepthData = false,
    keyframeQualityCapture = false,
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

  // ── WYSIWYG letterboxing ────────────────────────────────────────
  //
  // Pin BOTH the photo and the preview (video) stream to a 4:3 aspect
  // ratio so the viewport shows exactly what gets captured.  Without a
  // pinned format, vision-camera picks the device default for each —
  // commonly a 4:3 photo but a 16:9 preview — so the preview and the
  // saved frame frame different scenes.  4:3 is the native still
  // aspect on essentially every phone camera (incl. ultra-wide), so a
  // matching format is virtually always available; `useCameraFormat`
  // returns the closest match and never throws.
  //
  // Resolution preference matters too: filtering on aspect ALONE lets
  // vision-camera settle on whatever 4:3 format sorts first — observed as
  // a 192×144 VIDEO stream on the iPhone 16 Pro (the photo still uses the
  // format's full-res photo dims, so you'd get a sharp capture behind a
  // mush preview).  So we also request the highest video resolution.
  //
  // Why `'max'` and not a bounded target like 1920×1440?  We tried the
  // bounded target and it FAILED on the iPhone 16 Pro: the nearest
  // 1920×1440 format is a 10-bit format (pixel formats x420 / x422 only —
  // and it is NOT flagged HDR, so the `videoHdr` filter can't dodge it).
  // The frame processor + the stitcher's CV pipeline need 8-bit
  // `420v`/`420f`, so vision-camera raises
  // `device/pixel-format-not-supported` and silently falls back to a
  // default pixel format — breaking non-AR stitching.  vision-camera does
  // NOT expose a format's supported pixel formats to JS (no
  // `pixelFormats` field; `FormatFilter` has no pixel-format key), so we
  // can't select an 8-bit format by inspection.  Empirically the device's
  // MAX 4:3 video format is 8-bit (420v/420f) on the iPhone 16 Pro, and
  // Android formats are near-universally 8-bit YUV_420_888, so `'max'` is
  // the robust choice: a sharp preview on a frame-processor-compatible
  // pipeline.  Trade-off: the max format tends to run at 30 fps (fine for
  // hold-to-pan) and feeds full-res frames to the non-AR gate — if that
  // ever shows up as dropped frames we can downscale for the gate
  // natively while keeping full-res keyframes.  Aspect stays the
  // top-priority filter, so 4:3 WYSIWYG parity holds on every device.
  //
  // Still resolution: a plain `videoResolution:'max'` filter (what we used
  // before) maximises VIDEO and lets the PHOTO ride along — on the iPhone 16
  // Pro ULTRA-WIDE that pairs a 48 MP still (8064×6048) with the max-video
  // format, so a tap photo came out ~6000 px.  `pickCaptureFormat` instead
  // picks the SHARPEST-video 4:3 format whose photo is within
  // PHOTO_LONG_EDGE_CAP (verified on-device: the ultra-wide then chooses
  // 3264×2448 video + 12 MP photo — still a crisp preview, no 48 MP still).
  // The cap is on the PHOTO; video stays as high as the cap allows, so the
  // 8-bit/sharp-preview rationale above still holds.
  //
  // preferHighFps: a panorama preview must stay SMOOTH while panning.  Video-
  // resolution-first would pick the 3264×2448 **@30 fps** format over the
  // 1920×1440 **@60 fps** one — visibly jittery.  Keyframes are clamped to
  // 640/1280 px before stitching, so the extra video resolution buys nothing
  // here; a 60 fps stream just looks right.  We opt the panorama camera in.
  const format = useMemo(
    () => {
      const picked = pickCaptureFormat(device?.formats ?? [], {
        // highResCapture (document scanning) raises the photo cap so the
        // device's largest 4:3 still is selected (e.g. 4080×3060 on the A35,
        // which 4032 was excluding).  preferHighFps stays on, so the chosen
        // format's VIDEO/preview stream is unchanged — detection is untouched,
        // only the captured photo gets bigger.
        maxPhotoLongEdge: highResCapture ? HIGH_RES_PHOTO_LONG_EDGE_CAP : PHOTO_LONG_EDGE_CAP,
        aspect: 4 / 3,
        preferHighFps: true,
        // captureDepthData: keep only depth-capable 4:3 formats when the
        // device has any — depth delivery on a depth-less format silently
        // produces nothing.  Falls through unchanged on depth-less devices.
        preferDepthCapture: captureDepthData && Platform.OS === 'ios',
        // keyframeQualityCapture: floor the VIDEO stream at 1280 long edge
        // so non-AR pano keyframes stop being 640×480 tiles; fps still
        // ranks within the floored set (see pickCaptureFormat).
        minVideoLongEdge: keyframeQualityCapture
          ? KEYFRAME_QUALITY_MIN_VIDEO_LONG_EDGE
          : 0,
      });
      return picked;
    },
    [device, highResCapture, captureDepthData, keyframeQualityCapture],
  );

  // Pin the session frame rate to the format's max, capped at 60.  Picking a
  // 60 fps-capable format is necessary but NOT sufficient — without an explicit
  // `fps`, vision-camera can leave the session at a lower default, which is the
  // jitter the user saw.  min(maxFps, 60) is always within the format's range.
  const fps = useMemo(
    () => (format ? Math.min(format.maxFps ?? 30, 60) : undefined),
    [format],
  );

  // Measured size of our container, so we can size the <Camera> view to
  // the largest box of the capture's aspect ratio that fits inside it
  // (the rest becomes the black letterbox).  We deliberately size the
  // VIEW rather than relying on vision-camera's `resizeMode` alone:
  // resizeMode maps to PreviewView.ScaleType on Android, which several
  // devices ignore under the default SurfaceView compositor — so the
  // preview kept filling the screen.  When the view's own aspect ratio
  // equals the feed's, there is nothing left to crop on any platform.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev && prev.w === width && prev.h === height
        ? prev
        : { w: width, h: height },
    );
  }, []);

  if (!device) {
    return (
      <View style={[styles.placeholder, style]} accessibilityLabel="Camera initialising">
        <Text style={styles.placeholderText}>Initialising camera…</Text>
      </View>
    );
  }

  // Capture aspect ratio (W÷H) in the sensor's native landscape
  // orientation (so > 1).  Falls back to 4:3 until the format resolves.
  const sensorAspect =
    format && format.photoWidth > 0 && format.photoHeight > 0
      ? format.photoWidth / format.photoHeight
      : 4 / 3;

  // With outputOrientation="device", a portrait device displays the
  // scene rotated, so the on-screen content aspect is the inverse of
  // the landscape sensor aspect.  Detect portrait from the measured
  // container — robust across devices, split-screen and rotation.
  const isPortrait = size != null ? size.h >= size.w : true;
  const contentAspect = isPortrait ? 1 / sensorAspect : sensorAspect;

  // Largest box of `contentAspect` that fits the container, centred by
  // styles.root.  The remaining area is the black letterbox.  Before the
  // first onLayout we fill the container so the camera session mounts
  // immediately; the exact box snaps in ~1 frame later.
  let cameraStyle: ViewStyle;
  if (size == null || size.w === 0 || size.h === 0) {
    cameraStyle = StyleSheet.absoluteFillObject;
  } else {
    const heightIfFullWidth = size.w / contentAspect;
    cameraStyle =
      heightIfFullWidth <= size.h
        ? { width: size.w, height: heightIfFullWidth }
        : { width: size.h * contentAspect, height: size.h };
  }

  return (
    <View style={[styles.root, style]} onLayout={onRootLayout}>
      <Camera
        ref={innerRef}
        // Sized to the letterboxed box (capture aspect ratio) so the
        // preview never crops; styles.root centres it and paints the
        // surrounding bars black.  See the cameraStyle computation above.
        style={cameraStyle}
        device={device}
        isActive={isActive}
        photo
        video={video}
        // Pin preview + photo to the same 4:3 format (WYSIWYG capture).
        format={format}
        // Run the session at the format's fps (≤60) for a smooth pan preview.
        {...(fps != null ? { fps } : {})}
        // v0.13.2 — multi-cam lens switch via zoom (undefined = default).
        {...(zoom != null ? { zoom } : {})}
        // Orient the captured pixels.  Default `"device"` follows the
        // accelerometer — but when the phone is held FLAT over a document
        // (scanning), the device orientation is ambiguous, so the first shot
        // after launch can come out sideways.  For high-res document capture
        // we use `"preview"`, which matches the on-screen PREVIEW/UI
        // orientation (stable, what the user actually sees) instead of the
        // accelerometer — "what you see is what was taken", deterministically.
        outputOrientation={highResCapture ? 'preview' : 'device'}
        // Show the full camera FOV — no cropping.  'contain' maps to
        // AVLayerVideoGravity.resizeAspect on iOS and the equivalent
        // on Android, letterboxing the preview to the sensor's exact
        // aspect ratio.  Without this the default 'cover' crops
        // ~19% off each horizontal edge in portrait mode (4:3 sensor
        // in a 9:21 viewport), so the stitcher receives frames the
        // user never saw.  Black bars fill the remainder; backgroundColor
        // on styles.root ensures they are always black.
        resizeMode="contain"
        // Android: force TextureView rendering so that FIT_CENTER
        // (the Android equivalent of resizeMode="contain") actually
        // produces visible letterboxing.  The default SurfaceView mode
        // composes at the hardware layer below the View hierarchy and
        // on many devices ignores FIT_CENTER, filling the full surface
        // instead.  TextureView is part of the regular View hierarchy
        // so the matrix transform for FIT_CENTER works correctly —
        // the bars outside the letterboxed area are transparent,
        // revealing the parent's black backgroundColor.
        androidPreviewViewType="texture-view"
        // High-res document capture: prioritise image QUALITY (multi-frame
        // fusion / less noise) over shutter speed.  Only when highResCapture
        // is set — quality mode adds latency that would hurt rapid panorama
        // keyframe grabs.
        {...(highResCapture ? { photoQualityBalance: 'quality' as const } : {})}
        // iOS depth sidecar (captureDepthData): AVFoundation embeds the
        // AVDepthData in the written JPEG; `useCapture` extracts it to a
        // `<photo>.depth.bin` BEFORE the normaliseOrientation re-encode
        // strips it.  vision-camera itself re-asserts this on every session
        // reconfigure, so it survives prop-driven output rebuilds.
        {...(captureDepthData && Platform.OS === 'ios'
          ? { enableDepthData: true }
          : {})}
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
    // Centre the letterboxed <Camera> box so the black bars are
    // symmetric on both sides (top/bottom in portrait, left/right in
    // landscape).
    alignItems: 'center',
    justifyContent: 'center',
    // Black bars when the camera's aspect ratio doesn't fill the
    // container (e.g. 4:3 sensor in a 9:21 portrait viewport).  Without
    // this the bars are transparent, revealing whatever is behind the
    // component.
    backgroundColor: '#000',
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
