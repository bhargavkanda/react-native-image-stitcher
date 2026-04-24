/**
 * useVideoCapture — video recording + frame extraction API.
 *
 * Sibling of ``useCapture`` for the "sweep a shelf with a video" flow
 * that feeds the stitcher.  The hook's state machine is:
 *
 *     idle → recording → stopping → extracting → idle  (success)
 *     idle → recording → cancelling → idle            (user aborted)
 *
 * The recording part is implemented on top of vision-camera's
 * ``Camera.startRecording`` today — no extra native work needed.
 *
 * Frame extraction is a stub for now; it will call into the same
 * native stitcher module as ``stitchFrames`` to decode the mp4 into
 * evenly-spaced still frames.  Until the native module lands the hook
 * surfaces a clear NOT_IMPLEMENTED error on ``extractFrames()`` so
 * host apps don't silently ship broken panoramas.
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
  startRecording: (
    cameraRef: React.RefObject<Camera | null>,
    onRecordingFinished?: (video: VideoFile) => void,
  ) => Promise<void>;
  stopRecording: (
    cameraRef: React.RefObject<Camera | null>,
  ) => Promise<VideoFile | null>;
  cancelRecording: (cameraRef: React.RefObject<Camera | null>) => Promise<void>;
  /**
   * Decode an mp4 into N evenly-spaced still frames, written to
   * ``outputDir``.  Throws NOT_IMPLEMENTED until the native module ships.
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
  const lastVideoRef = useRef<VideoFile | null>(null);

  const startRecording = useCallback(
    async (
      cameraRef: React.RefObject<Camera | null>,
      onRecordingFinished?: (video: VideoFile) => void,
    ): Promise<void> => {
      if (!cameraRef.current) {
        throw new Error('useVideoCapture.startRecording: cameraRef is null');
      }
      setState('recording');
      cameraRef.current.startRecording({
        onRecordingFinished: (video) => {
          lastVideoRef.current = video;
          setState('idle');
          onRecordingFinished?.(video);
        },
        onRecordingError: (err) => {
          setState('idle');
          // eslint-disable-next-line no-console
          console.error('[useVideoCapture] recording error', err);
        },
      });
    },
    [],
  );

  const stopRecording = useCallback(
    async (cameraRef: React.RefObject<Camera | null>): Promise<VideoFile | null> => {
      if (!cameraRef.current) return null;
      setState('stopping');
      await cameraRef.current.stopRecording();
      // The vision-camera callback (startRecording.onRecordingFinished)
      // flips the state back to idle and writes lastVideoRef.  The
      // caller can await that via the returned VideoFile.
      return lastVideoRef.current;
    },
    [],
  );

  const cancelRecording = useCallback(
    async (cameraRef: React.RefObject<Camera | null>): Promise<void> => {
      if (!cameraRef.current) return;
      setState('stopping');
      try {
        await cameraRef.current.stopRecording();
      } finally {
        lastVideoRef.current = null;
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
          '[@retailens/capture-sdk] extractFrames is not yet implemented. '
          + 'The native RetaiLensStitcher module must expose an '
          + '`extractFrames` method — registering it will auto-enable '
          + 'this path (the JS shim unblocks once NativeModules.RetaiLensStitcher '
          + 'is registered).',
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
