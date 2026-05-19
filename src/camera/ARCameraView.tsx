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

import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import {
  NativeModules,
  Platform,
  StyleSheet,
  Text,
  View,
  requireNativeComponent,
  type ViewStyle,
} from 'react-native';


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
  takePhoto: (options?: { quality?: number }) => Promise<{
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
    { style, guidance },
    ref,
  ): React.JSX.Element {
    // Held across the start→stop lifecycle so stopRecording's
    // resolved VideoFile can be delivered via the same callback
    // pair vision-camera uses.
    const recordingCallbacksRef = useRef<RecordingCallbacks | null>(null);

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
