// SPDX-License-Identifier: Apache-2.0
//
// stitcher_frame_data.hpp — platform-agnostic backing data for the
// v0.8.0 `StitcherFrame` JSI host object.
//
// ## Why this lives here
//
// The JSI host object's `get()` dispatch logic is platform-specific
// (Obj-C++ on iOS includes `<jsi/jsi.h>` from React Native's
// CocoaPod; Android needs a more elaborate CMake setup to link
// against React Native's JSI library).  But the *data* the host
// object exposes — pose, dimensions, the pixel-buffer reader
// indirection — is identical on both platforms.  That data lives
// here so iOS / Android JSI dispatch code references one source.
//
// ## Memory model
//
// `PixelBufferReader` is an opaque interface; platform code (iOS
// `StitcherFrameHostObject.mm`; Android `stitcher_frame_jni.cpp`)
// implements it by wrapping the underlying `CVPixelBufferRef` /
// `ArImage*`.  Lifetime: the reader holds a strong ref to its
// source for the entire host-object lifetime; releases on
// destruction (deterministic, RAII).
//
// `StitcherFrameData` is value-typed (cheap to copy; ~100 bytes).
// Construct on the worklet runtime's thread before each dispatch.

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace retailens {

/// Opaque interface for reading the underlying camera pixel data.
/// Platform code provides an implementation:
///   - iOS: wraps a `CVPixelBufferRef` (locks/unlocks base address
///     across copyTo, defers release until destruction).
///   - Android: wraps an ARCore `ArImage*` (handles plane access via
///     `ArImage_getPlaneData`, calls `ArImage_release` on destruct).
///
/// Thread-affinity: implementations need not be thread-safe; the
/// JSI host object that owns the reader is itself single-threaded
/// (lives in worklet-runtime scope).
class PixelBufferReader {
public:
    virtual ~PixelBufferReader() = default;

    /// Total byte size of the buffer the reader exposes.  For Y-plane
    /// access (the v0.8.0 default), this is `width * height`.
    virtual std::size_t byteSize() const = 0;

    /// Copy up to `maxBytes` of the underlying buffer into `dst`.
    /// Returns bytes written.  Returns 0 if reader is invalidated.
    ///
    /// Implementations MUST handle the case where `maxBytes < byteSize()`
    /// (clip silently).  This matches JS `ArrayBuffer.slice` semantics
    /// even though the host object always allocates exactly `byteSize()`.
    virtual std::size_t copyTo(uint8_t* dst, std::size_t maxBytes) = 0;
};

/// Plain-old-data payload for one `StitcherFrame`.  Fully extracted
/// at construction time (cheap fields) plus an opaque reader for
/// the lazy pixel access.
struct StitcherFrameData {
    /// Discriminator. `"ar"` for AR-mode frames, `"vc"` for
    /// vision-camera frames.  Used by worklets to gate on AR-only
    /// field access (translation, depth, anchors, tracking state).
    /// Mirrored to the JS `__source` field.
    std::string source;

    /// Width / height of the camera image in pixels.
    int32_t width = 0;
    int32_t height = 0;

    /// String pixel-format identifier; matches the JS
    /// `StitcherFrame.pixelFormat` union: `"yuv"` / `"rgb"` /
    /// `"unknown"`.  Today's emitters always populate `"yuv"`
    /// (NV12 on iOS, NV21 on Android).
    std::string pixelFormat;

    /// String orientation identifier; matches vision-camera's
    /// `Frame.orientation`: `"portrait"`, `"portrait-upside-down"`,
    /// `"landscape-left"`, `"landscape-right"`.
    std::string orientation;

    /// Monotonic timestamp in nanoseconds.  AR mode: from
    /// `ARFrame.timestamp` (CFAbsoluteTime, converted to ns).
    /// Non-AR mode: from `vision-camera Frame.timestamp` (already ns).
    double timestampNs = 0.0;

    /// Pose rotation as quaternion `(x, y, z, w)`.  Matches the
    /// `q = q_yaw * q_pitch * q_roll` convention used elsewhere in
    /// the lib (KeyframeGate, RNSARFramePose, AcceptedKeyframe).
    double qx = 0.0;
    double qy = 0.0;
    double qz = 0.0;
    double qw = 1.0;

    /// Pose translation in metres (world coords).  AR mode: from
    /// `ARFrame.camera.transform`.  Non-AR mode: undefined — the
    /// `hasTranslation` flag is `false` and JS receives
    /// `pose.translation === undefined`.
    double tx = 0.0;
    double ty = 0.0;
    double tz = 0.0;
    bool hasTranslation = false;

    /// AR tracking state.  Empty string (`""`) means "not
    /// applicable" (the JS host object exposes `arTrackingState ===
    /// undefined` in that case).  Otherwise one of `"notAvailable"`,
    /// `"limited"`, `"normal"`.
    std::string arTrackingState;

    /// Pixel data accessor.  Always present (even for AR mode where
    /// arDepth might be the more interesting buffer).  See class
    /// docstring for lifetime contract.
    std::shared_ptr<PixelBufferReader> pixelReader;

    // ── AR-only optional fields (not populated in v0.8.0; stubs) ──
    // These are deferred to v0.8.1+ because the host worklets that
    // would consume them aren't shipping in v0.8.0 either.  Adding
    // them here as plain data fields keeps the JSI host object code
    // simple when they DO arrive.

    /// arDepth, arAnchors stubs intentionally omitted — they're
    /// fields the JSI dispatch will return `undefined` for in v0.8.0.
    /// v0.8.1+ adds them here as `std::optional<ArDepth>` etc.
};

}  // namespace retailens
