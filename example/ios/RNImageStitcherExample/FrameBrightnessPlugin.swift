// SPDX-License-Identifier: Apache-2.0
//
// FrameBrightnessPlugin — example-app demonstration of the v0.19.0
// native AR plugin framework (`RNISARFramePlugin`).
//
// The SDK ships ONLY the generic plugin framework — no concrete plugins.
// This sample proves the framework end-to-end: it computes the mean luma
// (0..1) of each ARFrame's `capturedImage` and returns it via the SYNC
// channel, so the JS `onArFrame` callback sees
// `meta.plugins.frameBrightness.brightness`.
//
// Registered once at startup in `AppDelegate` via
// `RNISARPluginRegistry.shared.register(...)`.  A real host plugin (e.g.
// RetaiLens's OCR) would offload heavy work to its own queue and use the
// ASYNC channel (`RNISARPluginRegistry.shared.emit(...)`) instead.

import Foundation
import CoreVideo
import RNImageStitcher

final class FrameBrightnessPlugin: NSObject, RNISARFramePlugin {

    func name() -> String { "frameBrightness" }

    /// Compute mean luma of the frame on the AR thread and return it
    /// synchronously.  This is intentionally cheap (sub-millisecond on a
    /// downsampled luma plane) so it's safe to run inline per frame.
    ///
    /// ARFrame.capturedImage is a bi-planar YUV
    /// (`kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`) buffer; plane 0
    /// is the full-resolution Y (luma) plane.  We average a sparse,
    /// strided sample of plane 0 — averaging every pixel at 60Hz would be
    /// wasteful and unnecessary for a brightness readout.
    func process(_ context: RNISARFrameContext) -> [String: Any]? {
        let pb = context.pixelBuffer

        // Only the luma plane of a bi-planar YUV buffer is needed.  Bail
        // gracefully (nil → no result this frame) for any unexpected
        // format rather than misreading bytes.
        let format = CVPixelBufferGetPixelFormatType(pb)
        guard format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ||
              format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange else {
            return nil
        }

        // pixelBuffer is valid only during process(_:) — read it here,
        // synchronously, and copy out only the scalar result.
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else {
            return nil
        }
        let width = CVPixelBufferGetWidthOfPlane(pb, 0)
        let height = CVPixelBufferGetHeightOfPlane(pb, 0)
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        guard width > 0, height > 0, rowBytes > 0 else { return nil }

        let ptr = base.assumingMemoryBound(to: UInt8.self)

        // Sparse sampling: ~32 columns × ~32 rows across the frame keeps
        // this O(1024) regardless of capture resolution.
        let xStep = max(1, width / 32)
        let yStep = max(1, height / 32)
        var sum: UInt64 = 0
        var count: UInt64 = 0
        var y = 0
        while y < height {
            let row = ptr + y * rowBytes
            var x = 0
            while x < width {
                sum += UInt64(row[x])
                count += 1
                x += xStep
            }
            y += yStep
        }
        guard count > 0 else { return nil }

        // Mean luma normalised to 0..1 (8-bit luma → /255).
        let brightness = Double(sum) / Double(count) / 255.0
        return ["brightness": brightness]
    }
}
