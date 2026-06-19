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

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace retailens {

/// Opaque interface for reading the underlying camera pixel data.
/// Platform code provides an implementation:
///   - iOS: wraps a `CVPixelBufferRef` (locks/unlocks base address
///     across copyTo, defers release until destruction).
///   - Android: wraps an ARCore `ArImage*` (handles plane access via
///     `ArImage_getPlaneData`, calls `ArImage_release` on destruct).
///
/// **Thread-affinity contract:** implementations need not be
/// reentrant.  An instance MAY be constructed on thread A
/// (typically the ARSession delegate queue) and used on thread B
/// (the worklet-runtime thread), provided the construction-thread
/// releases its `shared_ptr` reference before thread B uses the
/// reader.  The `shared_ptr`'s atomic refcount serves as the
/// happens-before barrier — fields set in the constructor are
/// visible on the worklet thread once the construction-thread
/// drops its ref.  Concurrent access from two threads simultaneously
/// is NOT supported.
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

/// One detected AR anchor (ARKit `ARAnchor` / ARCore `Anchor`).
/// Mirrors the JS `ARAnchor`: a stable id, a coarse type, and a
/// 4x4 transform.
struct ArAnchor {
    /// Stable per-session identifier (ARKit UUID / ARCore anchor id).
    std::string id;
    /// Coarse class: `"plane"`, `"image"`, `"point"`, or `"mesh"`.
    std::string type;
    /// 4x4 anchor->world transform, ROW-MAJOR (16 elements). Platform
    /// code is responsible for emitting row-major regardless of the
    /// native matrix's storage order.
    std::array<double, 16> transform{};

    // ── Scene-reconstruction geometry (only when type == "mesh") ──
    /// True when this anchor carries a mesh (gates JSI emission of
    /// `meshGeometry`).  Raw bytes, emitted as ArrayBuffers verbatim
    /// (no conversion) by the JSI layer:
    ///   - meshVertices: Float32 xyz triplets, anchor-local.
    ///   - meshFaces: Uint32 triangle indices into the vertices.
    ///   - meshClassifications: optional Uint8 per-face class (iOS
    ///     ARMeshAnchor; empty on Android — depth-derived meshes have
    ///     no semantics).
    bool hasMesh = false;
    std::vector<uint8_t> meshVertices;
    std::vector<uint8_t> meshFaces;
    std::vector<uint8_t> meshClassifications;
};

/// AR depth map for one frame. The platforms encode depth differently,
/// so we carry the raw bytes plus a `format` tag and NORMALISE to a
/// single JS shape (Float32 metres + Uint8 confidence 0..2) in the JSI
/// layer (`stitcher_frame_jsi.cpp`):
///   - iOS (ARKit `ARDepthData`): `depthBytes` = Float32 metres
///     (row-packed); `confidenceBytes` = Uint8 `ARConfidenceLevel`
///     (0=low,1=medium,2=high). `format = "f32m"`.
///   - Android (ARCore DEPTH16): `depthBytes` = uint16 packed (low 13
///     bits = millimetres, high 3 bits = confidence 0..7);
///     `confidenceBytes` empty. `format = "u16packed"`.
/// Depth maps are small (~256x192 iOS, ~160x120 Android) so the bytes
/// are eager-copied at extraction time (the ARCore Image is closed
/// in-scope; iOS copies for the same uniform contract).
struct ArDepth {
    int32_t width = 0;
    int32_t height = 0;
    /// Encoding of `depthBytes`: `"f32m"` or `"u16packed"`.
    std::string format;
    /// Raw depth bytes, interpreted per `format`.
    std::vector<uint8_t> depthBytes;
    /// Per-pixel confidence (Uint8 0..2). Populated on iOS; empty on
    /// Android (confidence is packed into `depthBytes`).
    std::vector<uint8_t> confidenceBytes;
};

/// Plain-old-data payload for one `StitcherFrame`.  Fully extracted
/// at construction time (cheap fields) plus an opaque reader for
/// the lazy pixel access.
struct StitcherFrameData {
    /// Discriminator. `"ar"` for AR-mode frames, `"vc"` for
    /// vision-camera frames.  Used by worklets to gate on AR-only
    /// field access (translation, depth, anchors, tracking state).
    /// Mirrored to the JS `source` field (standard discriminated-
    /// union pattern).
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

    // ── AR-only optional fields ──────────────────────────────────────

    /// AR depth map (ARKit sceneDepth / ARCore Depth API).  `nullopt`
    /// when the device/session can't provide depth; the JSI host object
    /// then exposes `arDepth === undefined`.  Normalised to a single JS
    /// shape in the JSI layer regardless of the native `format`.
    std::optional<ArDepth> arDepth;

    /// Tracked AR anchors visible this frame.  Empty when none (or in
    /// non-AR mode); the JSI host object exposes `arAnchors === undefined`
    /// only when empty AND source != "ar" (an AR frame with no anchors
    /// returns an empty array, per the JS contract).
    std::vector<ArAnchor> arAnchors;
};

}  // namespace retailens
