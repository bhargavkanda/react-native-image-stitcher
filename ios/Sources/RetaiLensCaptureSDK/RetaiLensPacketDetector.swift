// SPDX-License-Identifier: UNLICENSED
//
// RetaiLensPacketDetector — Phase 7 on-edge packet detection.
//
// Design contract (per docs/site-content/design/2026-04-29-ar-measurement-and-detection.md):
//
//   runPacketDetection(panoramaPath) → [{ bbox, class, confidence }]
//
// Cross-platform: the same JS surface is mirrored on Android via
// onnxruntime-android.  Stock YOLOv8n model (~6 MB quantised) ships
// as bundled resource so audits run offline without network round-
// trips.
//
// THIS FILE IS A SCAFFOLD.  The actual ONNX Runtime call site is
// gated behind `Bundle.main.url(forResource: "yolov8n", withExtension: "onnx")`
// — when the model is present + the `onnxruntime-objc` pod is added
// to the host's Podfile, real inference activates.  Until then this
// returns an empty array so the auto-pipeline (panorama save →
// detect → measure → persist) is end-to-end runnable, just yields
// no detected items.
//
// To enable real detection:
//   1. Convert stock YOLOv8n.pt → yolov8n.onnx (`yolo export
//      model=yolov8n.pt format=onnx imgsz=640`).
//   2. Drop `yolov8n.onnx` into `retailens-capture-sdk/ios/Sources/
//      RetaiLensCaptureSDK/Resources/`.
//   3. Add `pod 'onnxruntime-objc'` to the host's Podfile.
//   4. Replace the `runYOLOInference` stub below with a call into
//      `ORTSession` (see the Apple docs for the full pattern).

import Foundation
import UIKit


/// Result entry — JS sees a list of these from `runPacketDetection`.
@objc(RetaiLensDetectedItem)
public final class RetaiLensDetectedItem: NSObject {
    /// Bounding box in NORMALISED panorama coordinates [0..1].
    /// Caller scales to actual pixel coords using the panorama's
    /// width × height.  Normalised so detection results survive
    /// downscale / re-encode round-trips.
    @objc public let x: Double
    @objc public let y: Double
    @objc public let w: Double
    @objc public let h: Double

    /// Class label.  When the stock COCO YOLOv8n model is wired,
    /// values come from the COCO list (e.g. "bottle", "cup",
    /// "book").  When a fine-tuned packet model is wired, "packet"
    /// is the most common label.
    @objc public let className: String

    /// Detection confidence [0..1].
    @objc public let confidence: Double

    @objc public init(
        x: Double, y: Double, w: Double, h: Double,
        className: String, confidence: Double
    ) {
        self.x = x; self.y = y; self.w = w; self.h = h
        self.className = className
        self.confidence = confidence
    }

    @objc public func asDictionary() -> [String: Any] {
        return [
            "bbox": ["x": x, "y": y, "w": w, "h": h],
            "class": className,
            "detection_confidence": confidence,
        ]
    }
}


@objc(RetaiLensPacketDetector)
public final class RetaiLensPacketDetector: NSObject {

    /// Whether real inference is wired up — checks for the model
    /// file's presence in the bundle.  Used by the bridge to
    /// surface a stable "available" flag to JS.
    @objc public static var isAvailable: Bool {
        return Bundle.main.url(
            forResource: "yolov8n",
            withExtension: "onnx"
        ) != nil
    }

    /// Run detection on the panorama at `path`.  When the ONNX
    /// model + runtime are wired, returns real detections.  When
    /// not (current state), returns an empty array so the host's
    /// auto-pipeline runs end-to-end without crashing.
    @objc public static func detect(
        panoramaPath: String,
        confidenceThreshold: Double,
        completion: @escaping ([RetaiLensDetectedItem]?, NSError?) -> Void
    ) {
        // Load the panorama into a UIImage so the inference path
        // gets validated even when the stub returns no items.
        let cleanedPath = path(stripping: panoramaPath)
        guard FileManager.default.fileExists(atPath: cleanedPath) else {
            completion(nil, NSError(
                domain: "RetaiLensPacketDetector",
                code: 7001,
                userInfo: [NSLocalizedDescriptionKey:
                    "Panorama not found at path: \(cleanedPath)"]
            ))
            return
        }
        guard UIImage(contentsOfFile: cleanedPath) != nil else {
            completion(nil, NSError(
                domain: "RetaiLensPacketDetector",
                code: 7002,
                userInfo: [NSLocalizedDescriptionKey:
                    "Could not decode panorama: \(cleanedPath)"]
            ))
            return
        }

        // Real inference requires:
        //   - yolov8n.onnx in Bundle.main.url(forResource:withExtension:)
        //   - onnxruntime-objc pod in the host's Podfile
        // Both are intentionally NOT shipped with this scaffold so
        // the SDK stays small until a fine-tuned packet model is
        // available.  See the file header for enablement steps.
        if isAvailable {
            // TODO(phase 7 follow-up): replace with the real
            // ORTSession.run call here.  Pre-process: resize to
            // 640×640, normalise to [0,1], CHW.  Post-process:
            // sigmoid the objectness, NMS @ IoU 0.45, threshold @
            // confidenceThreshold.  Return normalised bboxes.
            NSLog("[RetaiLensPacketDetector] yolov8n.onnx present but inference path not yet wired — returning [].")
        } else {
            NSLog("[RetaiLensPacketDetector] yolov8n.onnx NOT present — returning [].  Drop the model into the SDK Resources and add onnxruntime-objc to the Podfile to enable.")
        }
        completion([], nil)
    }

    private static func path(stripping raw: String) -> String {
        if raw.hasPrefix("file://") {
            return String(raw.dropFirst("file://".count))
        }
        return raw
    }
}
