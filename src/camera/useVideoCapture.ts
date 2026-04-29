/**
 * useVideoCapture — video recording + frame extraction API.
 *
 * Sibling of ``useCapture`` for the "sweep a shelf with a video" flow
 * that feeds the stitcher.  The hook's state machine is:
 *
 *     idle → recording → stopping → idle  (success)
 *     idle → recording → idle             (recording errored)
 *     idle → recording → stopping → idle  (user cancelled)
 *
 * API shape — `startRecording` returns a `Promise<VideoFile>` that:
 *   - resolves with the recorded file when the user releases the
 *     shutter and `stopRecording()` is called (vision-camera fires
 *     `onRecordingFinished`),
 *   - rejects if vision-camera fires `onRecordingError` at any point
 *     (e.g. `<Camera>` was rendered without `video={true}`, disk
 *     full mid-recording, permission revoked).
 *
 * Why a single future instead of separate finished/error callbacks?
 *   Lets host code use the natural async/await pattern.  Earlier we
 *   used a callback + a parked resolver in the host screen; that
 *   masked start-time errors (the resolver hung forever) and produced
 *   confusing cascade errors when `stopRecording` ran against a
 *   non-recording camera.
 *
 * Frame extraction lives behind the `extractFrames` method but is
 * deferred to the higher-level `stitchVideo()` SDK API now — host
 * apps shouldn't have to manage their own tmp dir.  This shim is
 * kept for parity / future use; it currently throws.
 */

import { useCallback, useRef, useState } from 'react';
import { Camera, type VideoFile } from 'react-native-vision-camera';


export type VideoCaptureState =
  | 'idle'
  | 'recording'
  | 'stopping'
  | 'extracting';


export interface UseVideoCaptureReturn {
  state: VideoCaptureState;
  /**
   * Begin recording on the given camera ref.  Returns a Promise that
   * resolves with the resulting `VideoFile` once `stopRecording()`
   * has been called and vision-camera writes the file to disk, or
   * rejects on any recording error.
   *
   * Callers who only need fire-and-forget can ignore the returned
   * promise; the hook still tracks state internally.
   */
  startRecording: (
    cameraRef: React.RefObject<Camera | null>,
  ) => Promise<VideoFile>;
  /**
   * Tell vision-camera to stop the active recording.  If no recording
   * is in progress (e.g. it errored at start) this is a safe no-op.
   * The recorded file flows back through the promise returned by
   * `startRecording`, NOT through this method's return.
   */
  stopRecording: (
    cameraRef: React.RefObject<Camera | null>,
  ) => Promise<void>;
  /**
   * Cancel the active recording without delivering the file.  The
   * promise from `startRecording` will reject with a cancellation
   * error so awaiters unblock instead of receiving a stale file.
   */
  cancelRecording: (
    cameraRef: React.RefObject<Camera | null>,
  ) => Promise<void>;
  /**
   * Decode an mp4 into N evenly-spaced still frames, written to
   * ``outputDir``.  Throws NOT_IMPLEMENTED — call `stitchVideo` from
   * the SDK index instead, which combines extract + stitch in one
   * native bridge call so the JS thread never has to round-trip
   * frame paths.
   */
  extractFrames: (opts: ExtractFramesOptions) => Promise<ExtractFramesResult>;
}


export interface ExtractFramesOptions {
  videoPath: string;
  outputDir: string;
  frameCount: number;
  /** JPEG quality [0-100]. Defaults to 85. */
  quality?: number;
}


export interface ExtractFramesResult {
  framePaths: string[];
  durationMs: number;
}


export function useVideoCapture(): UseVideoCaptureReturn {
  const [state, setState] = useState<VideoCaptureState>('idle');

  /**
   * The active recording's resolve/reject handles.  Set when
   * `startRecording` is called; cleared when vision-camera fires
   * `onRecordingFinished` / `onRecordingError`, or when the host
   * calls `cancelRecording`.
   *
   * Stored in a ref (not state) because vision-camera's callbacks
   * fire outside React's render cycle and need synchronous access
   * to the latest handles.
   */
  const recordingFutureRef = useRef<{
    resolve: (video: VideoFile) => void;
    reject: (err: unknown) => void;
  } | null>(null);

  const startRecording = useCallback(
    (cameraRef: React.RefObject<Camera | null>): Promise<VideoFile> => {
      if (!cameraRef.current) {
        return Promise.reject(
          new Error('useVideoCapture.startRecording: cameraRef is null'),
        );
      }
      if (recordingFutureRef.current !== null) {
        return Promise.reject(
          new Error(
            'useVideoCapture.startRecording: a recording is already in progress',
          ),
        );
      }

      return new Promise<VideoFile>((resolve, reject) => {
        recordingFutureRef.current = { resolve, reject };
        setState('recording');
        cameraRef.current!.startRecording({
          onRecordingFinished: (video) => {
            const future = recordingFutureRef.current;
            recordingFutureRef.current = null;
            setState('idle');
            // If the future was cleared (cancelled), drop the file
            // on the floor.  vision-camera still wrote it to disk;
            // that's a known cleanup gap for a future iteration.
            future?.resolve(video);
          },
          onRecordingError: (err) => {
            const future = recordingFutureRef.current;
            recordingFutureRef.current = null;
            setState('idle');
            // eslint-disable-next-line no-console
            console.error('[useVideoCapture] recording error', err);
            future?.reject(err);
          },
        });
      });
    },
    [],
  );

  const stopRecording = useCallback(
    async (cameraRef: React.RefObject<Camera | null>): Promise<void> => {
      // No-op if there's nothing to stop — protects against the
      // cascade where startRecording errored synchronously and the
      // host's release handler still calls stop.
      if (recordingFutureRef.current === null) return;
      if (!cameraRef.current) return;
      setState('stopping');
      try {
        await cameraRef.current.stopRecording();
      } catch (err) {
        // The native call can throw "no-recording-in-progress" if
        // the recording was already finalised by an error path.
        // The future has its own error handling; we just absorb so
        // the host's await doesn't see a confusing secondary error.
        // eslint-disable-next-line no-console
        console.warn('[useVideoCapture] stopRecording threw', err);
      }
    },
    [],
  );

  const cancelRecording = useCallback(
    async (cameraRef: React.RefObject<Camera | null>): Promise<void> => {
      const future = recordingFutureRef.current;
      // Clear FIRST so the eventual onRecordingFinished/Error
      // callback no-ops on a null ref instead of fulfilling a
      // promise the caller has already moved past.
      recordingFutureRef.current = null;
      if (future) {
        future.reject(new Error('useVideoCapture: recording cancelled'));
      }
      if (!cameraRef.current) {
        setState('idle');
        return;
      }
      setState('stopping');
      try {
        await cameraRef.current.stopRecording();
      } catch {
        // Expected when no recording is in flight.
      } finally {
        setState('idle');
      }
    },
    [],
  );

  const extractFrames = useCallback(
    async (_opts: ExtractFramesOptions): Promise<ExtractFramesResult> => {
      setState('extracting');
      try {
        throw new Error(
          '[@retailens/capture-sdk] useVideoCapture.extractFrames is not '
          + 'available — use `stitchVideo()` from the SDK index, which '
          + 'combines extract + stitch in a single native call.',
        );
      } finally {
        setState('idle');
      }
    },
    [],
  );

  return {
    state,
    startRecording,
    stopRecording,
    cancelRecording,
    extractFrames,
  };
}
