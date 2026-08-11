// SPDX-License-Identifier: Apache-2.0
/**
 * ARCameraView — AR-backed alternative to ``<CameraView>`` for
 * audits that need pose-aware capture (panorama mode, packet
 * detection).  Renders the ARKit camera feed via the native
 * `RNSARCameraView` UIView; the underlying ARSession is the
 * SDK singleton (`RNSARSession.shared`), shared between the
 * preview and the pose log that feeds Phase 5 stitching + Phase 6
 * measurement.
 *
 * Why a separate component (vs. a polymorphic CameraView)?
 *   1. **Different imperative API.** The vision-camera-backed
 *      CameraView exposes `takePhoto / startRecording` via its ref
 *      (Phase 5 will add equivalents to this component, but they
 *      route through ARFrame.capturedImage + AVAssetWriter rather
 *      than vision-camera's APIs).
 *   2. **Camera-access conflict.** ARKit and AVCaptureSession
 *      can't share the camera.  Forcing the host to pick one
 *      component over the other (instead of toggling a prop on a
 *      shared component) makes the conflict impossible to misuse —
 *      you can't accidentally mount both at the same time.
 *   3. **Lifecycle clarity.** The native side starts the AR
 *      session in `didMoveToWindow`.  Mount = start, unmount =
 *      stop.  No flag-twiddling.
 *
 * This component is preview-only in Phase 4.4.  Photo + video
 * capture come in Phase 5 (Step 5 of the AR design plan).  Until
 * then, the host's panorama capture flow continues to use
 * vision-camera; ARCameraView is opt-in via a settings flag for
 * developer verification.
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  StyleSheet,
  Text,
  View,
  requireNativeComponent,
  type ViewStyle,
} from 'react-native';

import { ensureStitcherProxyInstalled } from '../stitching/ensureStitcherProxyInstalled';
import type { CameraFrameProcessor } from '../stitching/CameraFrame';
import type { ARFrameMeta, ARPluginResult } from '../stitching/ARFrameMeta';
import type { AROverlay } from '../stitching/AROverlay';
import type { FramePose } from '../ar/useARSession';
import {
  createAROverlayController,
  type AROverlayMethods,
} from './arOverlayController';
import {
  resolveOverlayPush,
  resolveOverlayUnmount,
} from './arOverlayLifecycle';


// React Native looks up the component by its NATIVE name.
//   iOS: comes from `ARCameraViewManager.m`'s
//        `RCT_EXTERN_MODULE(RNSARCameraViewManager, RCTViewManager)`.
//   Android: comes from `RNSARCameraViewManager.kt`'s
//        `getName() = "RNSARCameraView"`.
// Both expose the same name; same JS lookup works on both platforms.
const NativeARCameraView =
  Platform.OS === 'ios' || Platform.OS === 'android'
    ? requireNativeComponent<{ style?: ViewStyle }>('RNSARCameraView')
    : null;


export interface ARCameraViewProps {
  /** Layout style, typically `StyleSheet.absoluteFill` or `flex: 1`. */
  style?: ViewStyle;
  /**
   * Optional themed guidance banner shown over the preview at the
   * top, mirrors the `<CameraView>` prop so host apps can swap
   * components without rewriting their guidance text plumbing.
   */
  guidance?: string;
  /**
   * Optional host worklet invoked once per AR frame, ALONGSIDE the
   * lib's first-party stitching (composition, not replacement).  The
   * worklet receives a `CameraFrame` enriched with AR metadata —
   * `source: 'ar'`, world-space `pose` (rotation + translation),
   * `arTrackingState`, and (when supported) `arDepth` / `arAnchors`.
   *
   * Must be a `'worklet'`-prefixed function.  Registration installs the
   * native `__stitcherProxy` JSI host object on first use and fans the
   * worklet out from the AR session's per-frame dispatch.  If the
   * native install is unavailable (e.g. remote debugging), the worklet
   * silently never fires — no crash.
   *
   * The non-AR equivalent is vision-camera's own `useFrameProcessor`
   * passed via `<Camera frameProcessor={...}>`; the two modes run on
   * different runtimes with different frame shapes, hence the separate
   * prop.
   */
  arFrameProcessor?: CameraFrameProcessor;
  /**
   * Opt in to per-frame AR depth extraction (`CameraFrame.arDepth`).
   * Default `false` — depth is the costliest field (a per-frame buffer
   * copy), so it stays off until a worklet needs it.
   */
  enableDepth?: boolean;
  /**
   * Opt in to the SLAM feature-point cloud in AR plugin contexts.  Default
   * `false`.  Available on ALL AR-capable devices — no LiDAR required.
   * Consumed natively by AR plugins only; does not appear in
   * {@link ARFrameMeta} or `CameraFrame`.
   *
   *   - iOS   → ARKit `rawFeaturePoints` in `RNISARFrameContext.featurePoints`
   *             as world-space `[simd_float3]` (bare `x, y, z`).
   *   - Android → ARCore `Frame.acquirePointCloud()` in
   *             `ARFrameContext.featurePoints` as a flat stride-4
   *             `[x, y, z, confidence]` world-space `FloatArray` (the extra
   *             per-point confidence lets native plugins filter ARCore's
   *             sparser cloud).
   */
  enableFeaturePoints?: boolean;
  /**
   * Opt in to high-resolution photo capture (iOS 16+).  When `true`, the AR
   * session runs on the smallest video format that supports
   * `captureHighResolutionFrame`, so `takePhoto()` returns a true full-res
   * still (for document OCR / detail capture).  Default `false` — the live
   * stream stays as small as possible (cheapest for the panorama-stitch
   * path, whose keyframes are downscaled to a fixed budget regardless).
   * No-op on Android (no equivalent high-res capture API).
   */
  highResCapture?: boolean;
  /**
   * Opt in to PANORAMA-QUALITY keyframes (Android).  Picks a larger ARCore
   * CPU-image config (largest long-edge ≤ 1920 — e.g. the A35's 1920×1080
   * over its tiny 640×480 sole-4:3 config) and lifts the keyframe encode
   * budget 640 → 1280, so stitches stop being assembled from 0.3 MP tiles.
   * Costs stitch memory (~4× pixels per keyframe) — pano flows only; DT /
   * liveness sessions must not set it.  Default `false`.  No-op on iOS
   * (keyframes are already saved at native resolution there) and on
   * binaries older than the feature (optional-chained native call).
   */
  keyframeQualityCapture?: boolean;
  /**
   * Opt in to per-frame AR anchor extraction (`CameraFrame.arAnchors` —
   * detected planes / augmented images).  Default `false`.
   */
  enableAnchors?: boolean;
  /**
   * Opt in to scene-reconstruction mesh anchors (`type: 'mesh'` entries
   * in `arAnchors`, carrying `meshGeometry`).  Default `false`.  iOS
   * enables ARKit `sceneReconstruction` (LiDAR devices); Android
   * reconstructs a rough mesh from the depth map.  Expensive — only on
   * when needed.  Implies depth on Android.
   */
  enableMesh?: boolean;
  /**
   * Which plane orientations to surface in `arAnchors` (requires
   * `enableAnchors`).  Default `'vertical'` — the orientation the
   * plane-projected stitch path has always used, so existing callers
   * see no change.
   *
   *   - `'vertical'`   — walls / doors / fixtures (the default)
   *   - `'horizontal'` — floors / tables / seats
   *   - `'both'`       — surface every detected plane
   *
   * Platform notes: iOS changes ARKit `planeDetection` to match (a
   * live session reconfigure).  Android always detects both planes
   * (ARCore needs horizontal planes to bootstrap tracking) and simply
   * FILTERS which orientations reach `arAnchors`, so the JS-observable
   * set is identical on both platforms.
   */
  planeDetection?: 'vertical' | 'horizontal' | 'both';

  /**
   * v0.18.0 — LIGHT per-frame AR metadata callback, invoked on the JS
   * MAIN thread (NOT a worklet).  When provided, the native AR session
   * builds an {@link ARFrameMeta} per frame and emits it as a device
   * event; this component subscribes and calls the handler.  Worklet-free
   * — this is the recommended way to read AR pose / tracking / anchor /
   * intrinsics / depth-dims / mesh-counts data (the `arFrameProcessor`
   * worklet can only safely surface a shared value; see `ARFrameMeta`).
   *
   * Costly fields are gated: `depth` only when `enableDepth`, `mesh` only
   * when `enableMesh`, `anchors` only when `enableAnchors`;
   * `intrinsics` / `pose` / `trackingState` are always present.  Emission
   * is throttled to {@link arFrameMetaInterval} ms.
   */
  onArFrame?: (meta: ARFrameMeta) => void;

  /**
   * v0.18.0 — throttle interval (ms) for {@link onArFrame}.  Default `100`
   * (≈ 10 Hz).  No effect unless `onArFrame` is provided.
   */
  arFrameMetaInterval?: number;

  /**
   * v0.19.0 — ASYNCHRONOUS AR-plugin result callback, invoked on the JS MAIN
   * thread (NOT a worklet).  Part of the AR plugin framework: host-registered
   * native plugins (see `RNISARPluginRegistry` / `RNSARPluginRegistry`) can
   * offload heavy per-frame work to their own queue and later push a result
   * via `registry.emit(name, result)`.  The SDK routes that to JS as a
   * `RNImageStitcherARPluginResult` device event; when this prop is provided,
   * this component subscribes and invokes the handler with
   * `{ plugin, result }`.
   *
   * SYNCHRONOUS plugin results (computed inline on the AR thread) instead ride
   * the throttled {@link onArFrame} event on {@link ARFrameMeta.plugins} —
   * read them there.  This callback is ONLY for the out-of-band async channel.
   *
   * The subscription is independent of {@link onArFrame}: a host can read
   * sync results via `onArFrame` and async results via `onArPluginResult`,
   * either, or both.  Wiring mirrors `onArFrame` exactly (latest handler held
   * in a ref so the subscription effect depends only on whether a handler is
   * present; cleanup on unmount / when the handler is removed).
   */
  onArPluginResult?: (e: ARPluginResult) => void;

  /**
   * v0.20.0 — AR OVERLAY / ANNOTATION renderer.  A declarative array of 2D
   * shapes the native overlay layer draws ON TOP of the AR camera preview,
   * each anchored to WORLD positions and REPROJECTED to screen on every AR
   * frame from the current camera pose + intrinsics (smooth, display-rate
   * tracking; no 3D engine).
   *
   * State-driven: pass a React-state array and update it as your world points
   * change.  The set is diffed against the current overlays BY `id` (add /
   * update / remove), so re-passing the same ids is cheap.  Each render pushes
   * the resolved array to native via `RNSARSession.setOverlays`.
   *
   * For zero-render-latency / fire-and-forget mutations use the imperative ref
   * methods instead ({@link ARCameraViewHandle.setOverlays} etc.) — both paths
   * funnel through the same native channel and stay consistent.  JS-set
   * overlays are merged on the native side with any overlays a registered AR
   * plugin placed directly (`RNISARPluginRegistry.setOverlays` /
   * `RNSARPluginRegistry.setOverlays`); the two sets are namespaced so neither
   * clobbers the other.
   *
   * See {@link AROverlay} for the shape (single world point + size, or explicit
   * world quad; `outline` / `box`; optional label + colour; `mode:'3d'` is a
   * documented scaffold this release and renders as `'2d'`).
   */
  overlays?: AROverlay[];
}


/**
 * Imperative handle exposed via the ref — shape mirrors the subset
 * of vision-camera's `Camera` ref methods that the host's
 * `useCapture` / `useVideoCapture` hooks call.  Hosts can pass the
 * SAME ref to those hooks as they do for the vision-camera path,
 * with no branching required.
 *
 * Note we do NOT exhaustively mirror vision-camera's API surface —
 * only the methods the panorama capture flow uses today.  As the
 * SDK grows AR-aware features, methods are added here.
 *
 * v0.20.0 — also exposes the imperative AR-overlay methods
 * ({@link AROverlayMethods}: `setOverlays` / `addOverlay` / `updateOverlay` /
 * `removeOverlay` / `clearOverlays`) so a host can drive overlays without a
 * render (the declarative `overlays` prop is the React-state alternative).
 */
export interface ARCameraViewHandle extends AROverlayMethods {
  /**
   * Capture the latest ARFrame as a JPEG.  Resolves with a
   * vision-camera-compatible PhotoFile (`{ path, width, height,
   * isMirrored, isRawPhoto }`).  Native generates a temp path —
   * caller does NOT need to construct one.
   */
  takePhoto: (options?: {
    quality?: number;
    /**
     * v0.12.0 — device orientation at capture time, used to bake
     * correct rotation into the saved JPEG.  Pass the value from
     * `useDeviceOrientation()`.  Defaults to `'portrait'` on the
     * native side if omitted (preserves pre-v0.12 behavior).
     * Without this, AR-mode photos taken in landscape come out
     * sideways because the native side previously hardcoded the
     * rotate-to-portrait assumption.
     */
    orientation?:
      | 'portrait'
      | 'portrait-upside-down'
      | 'landscape-left'
      | 'landscape-right';
    /**
     * Photo-capture plugin passthrough: EVERY extra key is forwarded
     * verbatim to the native takePhoto options, where registered
     * `RNSPhotoCapturePlugin`s receive the full dictionary.  Lets a host
     * route per-call flags to its own native plugin without a library
     * change.  With no plugin registered, extra keys are never read.
     */
    [pluginOption: string]: unknown;
  }) => Promise<{
    path: string;
    width: number;
    height: number;
    isMirrored: boolean;
    isRawPhoto: boolean;
    /**
     * AR camera pose of the EXACT frame whose pixels became the photo —
     * the same shape (full intrinsics included) as the per-frame pose
     * ledger (`getFramePoses`), built by one shared native builder.
     * Intrinsics/dims describe the AR camera's native (unoriented) frame,
     * not the oriented JPEG dims above.  Absent only when the native pose
     * read failed (a failed pose never blocks the photo).
     */
    pose?: FramePose;
    /**
     * Registered photo-capture plugins may merge additional fields into
     * the result (the library's own keys always win).  Typed open so a
     * host can read its plugin's fields without casting through `any`.
     */
    [pluginField: string]: unknown;
  }>;
  /**
   * Begin recording AR frames into an mp4.  Mirrors vision-camera's
   * callback-based API: takes `onRecordingFinished` /
   * `onRecordingError` handlers; the actual VideoFile is delivered
   * via `onRecordingFinished` AFTER the host calls `stopRecording`.
   *
   * Synchronous return (void) — useVideoCapture wraps it in a
   * Promise on top of the callbacks.
   */
  startRecording: (options: {
    onRecordingFinished?: (video: {
      path: string;
      duration: number;
      size: number;
      width: number;
      height: number;
    }) => void;
    onRecordingError?: (err: Error) => void;
  }) => void;
  /** Finalise the in-progress recording. */
  stopRecording: () => Promise<void>;
}


type RecordingCallbacks = {
  onRecordingFinished?: (video: {
    path: string;
    duration: number;
    size: number;
    width: number;
    height: number;
  }) => void;
  onRecordingError?: (err: Error) => void;
};


export const ARCameraView = forwardRef<ARCameraViewHandle, ARCameraViewProps>(
  function ARCameraView(
    {
      style,
      guidance,
      arFrameProcessor,
      enableDepth,
      highResCapture,
      keyframeQualityCapture,
      enableAnchors,
      enableMesh,
      enableFeaturePoints,
      planeDetection,
      onArFrame,
      arFrameMetaInterval,
      onArPluginResult,
      overlays,
    },
    ref,
  ): React.JSX.Element {
    // Held across the start→stop lifecycle so stopRecording's
    // resolved VideoFile can be delivered via the same callback
    // pair vision-camera uses.
    const recordingCallbacksRef = useRef<RecordingCallbacks | null>(null);

    // v0.20.0 — AR overlay controller (shared logic with <Camera>).  One
    // instance per mount holds the JS-set overlay collection (keyed by id) and
    // pushes the full array to native on every mutation.  Both the declarative
    // `overlays` prop (effect below) and the imperative ref methods drive it,
    // so the two APIs can never diverge.
    const overlayControllerRef = useRef<
      ReturnType<typeof createAROverlayController> | null
    >(null);
    if (overlayControllerRef.current == null) {
      overlayControllerRef.current = createAROverlayController();
    }
    const overlayController = overlayControllerRef.current;

    // AR frame-processor registration.  Installs the native
    // `__stitcherProxy` (idempotent) and registers the host worklet so
    // the AR session's per-frame fan-out invokes it; unregisters on
    // unmount or when the worklet identity changes.  No-op when no
    // worklet is supplied or the native install is unavailable.
    useEffect(() => {
      if (arFrameProcessor == null) {
        return undefined;
      }
      if (!ensureStitcherProxyInstalled()) {
        return undefined;
      }
      const proxy = (globalThis as {
        __stitcherProxy?: {
          install(fn: CameraFrameProcessor): string;
          uninstall(id: string): void;
        };
      }).__stitcherProxy;
      if (proxy == null) {
        return undefined;
      }
      const id = proxy.install(arFrameProcessor);
      return () => {
        proxy.uninstall(id);
      };
    }, [arFrameProcessor]);

    // Push the AR-metadata extraction config to native — gates the
    // costly per-frame depth / anchor / mesh work (all off by default).
    // Routed through `__stitcherProxy.setExtractionConfig`, read by the
    // platform AR extraction.  iOS ADDITIONALLY toggles ARKit
    // `sceneReconstruction` for mesh (a session-config change, not a
    // per-frame gate); Android reconstructs mesh from the depth map and
    // needs no session change.
    useEffect(() => {
      const depth = enableDepth === true;
      const anchors = enableAnchors === true;
      const mesh = enableMesh === true;
      if (ensureStitcherProxyInstalled()) {
        (globalThis as {
          __stitcherProxy?: {
            setExtractionConfig?(d: boolean, a: boolean, m: boolean): void;
          };
        }).__stitcherProxy?.setExtractionConfig?.(depth, anchors, mesh);
      }
      if (Platform.OS === 'ios') {
        const session = (NativeModules as Record<string, unknown>)
          .RNSARSession as
          | { setSceneReconstructionEnabled?(on: boolean): void }
          | undefined;
        session?.setSceneReconstructionEnabled?.(mesh);
      }
    }, [enableDepth, enableAnchors, enableMesh]);

    // Push the feature-point-cloud flag to native on BOTH platforms.  ARCore
    // DOES expose a raw SLAM feature-point API — `Frame.acquirePointCloud()`
    // returns world-space `[x, y, z, confidence]` points, the ARCore
    // equivalent of ARKit's `ARFrame.rawFeaturePoints`.  On iOS the flag
    // populates `RNISARFrameContext.featurePoints` (`[simd_float3]`); on
    // Android it drives `Frame.acquirePointCloud()` into
    // `ARFrameContext.featurePoints` (stride-4 `[x, y, z, confidence]`).
    // Routes through the RNSARSession native module, mirroring the
    // scene-reconstruction toggle.  No session reconfiguration is triggered;
    // the flag is read per-frame on the AR thread (iOS: invokeArPlugins;
    // Android: runArPlugins) on the next frame.  The `?.` keeps it a no-op on
    // any older native build that doesn't expose the method.
    useEffect(() => {
      const session = (NativeModules as Record<string, unknown>)
        .RNSARSession as
        | { setFeaturePointsEnabled?(on: boolean): void }
        | undefined;
      session?.setFeaturePointsEnabled?.(enableFeaturePoints === true);
    }, [enableFeaturePoints]);

    // Push the high-res-capture flag to native on BOTH platforms.  iOS re-picks
    // the AR video format; Android (added 0.20.5) re-picks the ARCore camera
    // config to the largest available so AR takePhoto captures at full
    // resolution.  Routes through the RNSARSession native module like the
    // scene-reconstruction / plane-detection session settings.  The `?.` keeps
    // it a no-op on any build that doesn't expose the method.
    useEffect(() => {
      const session = (NativeModules as Record<string, unknown>)
        .RNSARSession as
        | { setHighResCaptureEnabled?(on: boolean): void }
        | undefined;
      session?.setHighResCaptureEnabled?.(highResCapture === true);
    }, [highResCapture]);

    // Pano keyframe quality (Android; see the prop doc).  ACQUIRE/RELEASE
    // against the native holder REFCOUNT — and only when the prop is
    // actually on: an unconditional set(false) here would let a prop-less
    // mount (the DT capture surface) STEAL a holder another view acquired.
    // The refcount (not a boolean) is what keeps overlapping camera-view
    // mounts during a source/lens swap from downgrading a live pan.
    useEffect(() => {
      if (keyframeQualityCapture !== true) return undefined;
      const session = (NativeModules as Record<string, unknown>)
        .RNSARSession as
        | { setKeyframeQualityCaptureEnabled?(on: boolean): void }
        | undefined;
      session?.setKeyframeQualityCaptureEnabled?.(true);
      return () => {
        session?.setKeyframeQualityCaptureEnabled?.(false);
      };
    }, [keyframeQualityCapture]);

    // Push the plane-detection mode to native.  Unlike the extraction
    // config above this is a SESSION setting, so it routes through the
    // RNSARSession native module on BOTH platforms (iOS reconfigures
    // ARKit `planeDetection`; Android stores an emission filter — see
    // the prop docs).  Defaults to `'vertical'` to preserve the
    // plane-projected stitch path's long-standing behaviour.
    useEffect(() => {
      const mode = planeDetection ?? 'vertical';
      const session = (NativeModules as Record<string, unknown>)
        .RNSARSession as
        | { setPlaneDetection?(mode: string): void }
        | undefined;
      session?.setPlaneDetection?.(mode);
    }, [planeDetection]);

    // v0.18.0 — onArFrame device-event wiring (worklet-free, main thread).
    //
    // The latest `onArFrame` is held in a ref so the subscription effect
    // depends only on whether a handler is present + the interval — NOT on
    // the handler's identity (which typically changes every render).  This
    // avoids tearing down + re-establishing the native event subscription
    // (and the costly `setArFrameMetaEnabled(true)` extraction toggle) on
    // every parent re-render.
    const onArFrameRef = useRef<((meta: ARFrameMeta) => void) | undefined>(
      onArFrame,
    );
    useEffect(() => {
      onArFrameRef.current = onArFrame;
    }, [onArFrame]);

    const arFrameEnabled = onArFrame != null;
    useEffect(() => {
      if (!arFrameEnabled) {
        return undefined;
      }
      const session = (NativeModules as Record<string, unknown>)
        .RNSARSession as
        | {
            setArFrameMetaEnabled?(enabled: boolean, intervalMs: number): void;
          }
        | undefined;
      if (session?.setArFrameMetaEnabled == null) {
        // Native module / method unavailable (e.g. web, or a native build
        // predating the event channel): no-op, no crash.
        return undefined;
      }
      const intervalMs = arFrameMetaInterval ?? 100;
      session.setArFrameMetaEnabled(true, intervalMs);
      const emitter = new NativeEventEmitter(
        NativeModules.RNSARSession as never,
      );
      const sub = emitter.addListener(
        'RNImageStitcherARFrame',
        (meta: ARFrameMeta) => {
          onArFrameRef.current?.(meta);
        },
      );
      return () => {
        sub.remove();
        session.setArFrameMetaEnabled?.(false, intervalMs);
      };
    }, [arFrameEnabled, arFrameMetaInterval]);

    // v0.19.0 — onArPluginResult device-event wiring (worklet-free, main
    // thread).  Mirrors the onArFrame subscription above: the latest handler
    // is held in a ref so the subscription effect depends only on WHETHER a
    // handler is present, not its (per-render-changing) identity — so the
    // native event subscription isn't torn down + re-established every render.
    //
    // This is a PURELY-JS subscription: unlike onArFrame there's no native
    // "enable" toggle to flip.  Native emits `RNImageStitcherARPluginResult`
    // whenever a registered plugin calls `registry.emit(...)`; the registry is
    // empty unless the host registered plugins, so an app with no plugins
    // never sees an event even if this prop is wired.
    const onArPluginResultRef = useRef<
      ((e: ARPluginResult) => void) | undefined
    >(onArPluginResult);
    useEffect(() => {
      onArPluginResultRef.current = onArPluginResult;
    }, [onArPluginResult]);

    const arPluginResultEnabled = onArPluginResult != null;
    useEffect(() => {
      if (!arPluginResultEnabled) {
        return undefined;
      }
      const native = (NativeModules as Record<string, unknown>)
        .RNSARSession;
      if (native == null) {
        // Native module unavailable (e.g. web, or a native build predating
        // the plugin event channel): no-op, no crash.
        return undefined;
      }
      const emitter = new NativeEventEmitter(native as never);
      const sub = emitter.addListener(
        'RNImageStitcherARPluginResult',
        (e: ARPluginResult) => {
          onArPluginResultRef.current?.(e);
        },
      );
      return () => {
        sub.remove();
      };
    }, [arPluginResultEnabled]);

    // v0.20.0 — declarative `overlays` prop → native.  Each render pushes the
    // resolved array through the controller (which replaces the JS-set
    // collection wholesale and dispatches to `RNSARSession.setOverlays`).  The
    // controller dedups identical native dispatches at the wire level is NOT
    // attempted here — React only re-runs this when `overlays` identity
    // changes, and native overlay set is cheap (a handful of shapes).  When the
    // prop is omitted we DON'T touch the controller, so a host driving overlays
    // purely imperatively (via the ref) isn't clobbered by an undefined prop.
    //
    // Declarative overlays are cleared on UNMOUNT (effect below): the native
    // JS-overlay collection is a process-wide singleton that outlives this
    // component AND session restarts, so without the clear the NEXT mounted
    // AR view renders this instance's stale shapes (observed: digital-twin
    // detection quads persisting into an unrelated photo-mode AR view). The
    // clear is gated on this instance having actually driven declaratively —
    // an imperative-only host keeps full ownership across remounts.
    // Decision logic is the pure {@link resolveOverlayPush} /
    // {@link resolveOverlayUnmount} pair (arOverlayLifecycle.ts, unit-tested);
    // these effects only apply the decisions. `hasDriven` (the ownership token)
    // lives in a ref: an imperative-only host never drives declaratively, so it
    // never clears the singleton and keeps control across remounts.
    const declarativeOverlaysDroveRef = useRef(false);
    useEffect(() => {
      const { dispatch, hasDriven } = resolveOverlayPush(
        overlays,
        declarativeOverlaysDroveRef.current,
      );
      declarativeOverlaysDroveRef.current = hasDriven;
      if (dispatch !== null) {
        overlayController.setOverlays(dispatch);
      }
    }, [overlays, overlayController]);
    useEffect(() => {
      return () => {
        const dispatch = resolveOverlayUnmount(
          declarativeOverlaysDroveRef.current,
        );
        if (dispatch !== null) {
          overlayController.setOverlays(dispatch);
        }
      };
    }, [overlayController]);

    useImperativeHandle(ref, () => ({
      setOverlays: overlayController.setOverlays,
      addOverlay: overlayController.addOverlay,
      updateOverlay: overlayController.updateOverlay,
      removeOverlay: overlayController.removeOverlay,
      clearOverlays: overlayController.clearOverlays,
      raycast: overlayController.raycast,
      takePhoto: async (options = {}) => {
        const native: any =
          (NativeModules as Record<string, unknown>).RNSARSession;
        if (!native?.takePhoto) {
          throw new Error(
            'ARCameraView.takePhoto: native RNSARSession module not registered',
          );
        }
        // Spread FIRST so the library-owned keys below always win, then
        // pin path/quality/orientation.  Extra keys ride through verbatim
        // for registered photo-capture plugins (see the handle's option
        // docs); with no plugin registered the native side never reads
        // them, so the passthrough itself changes nothing for pre-existing
        // callers.  (Their RESULT does gain the new additive `pose` field —
        // that is takePhoto's own pose stamp, present regardless of
        // plugins; see the handle's result docs.)
        return native.takePhoto({
          ...options,
          path: '',
          quality: options.quality ?? 90,
          orientation: options.orientation ?? 'portrait',
        });
      },
      startRecording: (options) => {
        const native: any =
          (NativeModules as Record<string, unknown>).RNSARSession;
        if (!native?.startRecording) {
          options.onRecordingError?.(new Error(
            'ARCameraView.startRecording: native RNSARSession module not registered',
          ));
          return;
        }
        if (recordingCallbacksRef.current !== null) {
          options.onRecordingError?.(new Error(
            'ARCameraView.startRecording: a recording is already in progress',
          ));
          return;
        }
        recordingCallbacksRef.current = options;
        native.startRecording({ path: '' })
          .catch((err: Error) => {
            recordingCallbacksRef.current = null;
            options.onRecordingError?.(err);
          });
      },
      stopRecording: async () => {
        const native: any =
          (NativeModules as Record<string, unknown>).RNSARSession;
        const callbacks = recordingCallbacksRef.current;
        recordingCallbacksRef.current = null;
        if (!native?.stopRecording || !callbacks) {
          return;
        }
        try {
          const video = await native.stopRecording();
          callbacks.onRecordingFinished?.(video);
        } catch (err) {
          callbacks.onRecordingError?.(err as Error);
        }
      },
    }), [overlayController]);

    if (!NativeARCameraView
        || (Platform.OS !== 'ios' && Platform.OS !== 'android')) {
      // Web / unsupported platforms get a clear "not available here"
      // placeholder instead of a silent black rectangle.  iOS +
      // Android both ship the native component now.
      return (
        <View style={[styles.placeholder, style]} accessibilityLabel="AR camera unavailable">
          <Text style={styles.placeholderText}>
            AR camera is not available on this platform.
          </Text>
        </View>
      );
    }

    return (
      <View style={[styles.root, style]}>
        <NativeARCameraView style={StyleSheet.absoluteFill} />
        {guidance ? (
          <View
            style={styles.guidance}
            pointerEvents="none"
            accessible
            accessibilityRole="text"
          >
            <Text style={styles.guidanceText} numberOfLines={2}>
              {guidance}
            </Text>
          </View>
        ) : null}
      </View>
    );
  },
);


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
