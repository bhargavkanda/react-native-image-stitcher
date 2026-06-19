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
 */
export interface ARCameraViewHandle {
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
  }) => Promise<{
    path: string;
    width: number;
    height: number;
    isMirrored: boolean;
    isRawPhoto: boolean;
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
      enableAnchors,
      enableMesh,
      planeDetection,
      onArFrame,
      arFrameMetaInterval,
      onArPluginResult,
    },
    ref,
  ): React.JSX.Element {
    // Held across the start→stop lifecycle so stopRecording's
    // resolved VideoFile can be delivered via the same callback
    // pair vision-camera uses.
    const recordingCallbacksRef = useRef<RecordingCallbacks | null>(null);

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

    useImperativeHandle(ref, () => ({
      takePhoto: async (options = {}) => {
        const native: any =
          (NativeModules as Record<string, unknown>).RNSARSession;
        if (!native?.takePhoto) {
          throw new Error(
            'ARCameraView.takePhoto: native RNSARSession module not registered',
          );
        }
        return native.takePhoto({
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
    }), []);

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
