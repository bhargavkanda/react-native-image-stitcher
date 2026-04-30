/**
 * detect.ts — Phase 7 on-edge packet detection.
 *
 * Wraps the native RetaiLensPacketDetector module.  When a YOLOv8n
 * ONNX model is bundled (`yolov8n.onnx`) AND `onnxruntime-objc` is
 * in the host's Podfile, `runPacketDetection` returns real bounding
 * boxes.  When either is missing the call resolves with an empty
 * `items` array — the host's auto-pipeline runs end-to-end without
 * crashing, just doesn't produce detections.
 *
 * Cross-platform: Android port wires the same JS surface through
 * `onnxruntime-android` once Phase 7 catches up there.
 */

import { NativeModules } from 'react-native';


/** Normalised bounding box [0..1] in panorama coords. */
export interface DetectionBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}


export interface DetectedItem {
  bbox: DetectionBBox;
  /** Class label from the model (e.g. "packet", "bottle", "box"). */
  class: string;
  /** Detection confidence [0..1]. */
  detection_confidence: number;
}


export interface RunPacketDetectionOptions {
  /** Path to the saved panorama JPEG (with or without `file://`). */
  panoramaPath: string;
  /**
   * Drop detections below this score.  Default 0.35 — lower values
   * surface more candidates but also more false positives.
   */
  confidenceThreshold?: number;
}


export interface RunPacketDetectionResult {
  items: DetectedItem[];
  /**
   * False when the YOLOv8n ONNX model isn't bundled or the runtime
   * isn't installed.  Hosts can use this to surface a "detection
   * unavailable on this build" message.
   */
  isAvailable: boolean;
}


function getNative(): {
  isAvailable: () => Promise<boolean>;
  runPacketDetection: (
    opts: RunPacketDetectionOptions,
  ) => Promise<RunPacketDetectionResult>;
} | null {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['RetaiLensPacketDetector'];
  if (
    !native
    || typeof native !== 'object'
    || typeof (native as { runPacketDetection?: unknown }).runPacketDetection !== 'function'
  ) {
    return null;
  }
  return native as ReturnType<typeof getNative> & object;
}


/**
 * Run on-device packet detection over a saved panorama.  Resolves
 * with `{ items, isAvailable }` — a `false` `isAvailable` means
 * the model file is missing or onnxruntime-objc isn't linked, and
 * `items` will be empty.
 *
 * Auto-pipeline contract: when the host calls this after panorama
 * save and the AuditTemplate has `detect_packets_on_edge=true`,
 * each detected item should be passed through the SDK's
 * `measureRegion` API to get cm dimensions, then persisted to
 * `Capture.detected_items`.
 */
export async function runPacketDetection(
  options: RunPacketDetectionOptions,
): Promise<RunPacketDetectionResult> {
  const native = getNative();
  if (!native) {
    return { items: [], isAvailable: false };
  }
  const path = options.panoramaPath.replace(/^file:\/\//, '');
  return native.runPacketDetection({
    panoramaPath: path,
    confidenceThreshold: options.confidenceThreshold ?? 0.35,
  });
}


/**
 * Probe whether on-device detection is wired up.  Cheap to call —
 * just reads a bundle resource flag.  Hosts can use this to gate
 * the "Detection unavailable on this device" toast.
 */
export async function packetDetectionIsAvailable(): Promise<boolean> {
  const native = getNative();
  if (!native) return false;
  return native.isAvailable();
}
