// SPDX-License-Identifier: Apache-2.0
//
// camera_frame_jsi.hpp — shared C++ JSI host object for the v0.8.0
// `StitcherFrame` contract.  Compiles on both iOS and Android; each
// platform provides only the PixelBufferReader implementation and
// the construction call site (Obj-C++ on iOS; JNI on Android).
//
// The JSI dispatch logic (`get` / `getPropertyNames`) is identical
// across platforms — the host object exposes the same JS-visible
// surface regardless of frame source, by design of the
// `StitcherFrame` contract.

#pragma once

#include <jsi/jsi.h>

#include <cstdint>
#include <memory>
#include <vector>

#include "camera_frame_data.hpp"

namespace retailens {

/// Owning byte buffer that satisfies the `jsi::MutableBuffer`
/// contract.  Backs the `ArrayBuffer` returned by
/// `StitcherFrame.toArrayBuffer()`.
///
/// **Lifetime:** tied to the JSI ArrayBuffer's GC root.  The buffer
/// persists until Hermes / JSC garbage-collects the ArrayBuffer
/// (not deterministic with frame timing).  To avoid per-frame
/// allocation churn (30 fps × 2 MB = ~60 MB/s in the AR-mode pan
/// case), `toArrayBuffer()` caches a single instance per JSI
/// runtime on `runtime.global()` and reuses it across frames —
/// reallocating only when the requested size changes.  Pattern
/// adopted from vision-camera's `FrameHostObject.mm:124-149`.
class OwningPixelBuffer : public facebook::jsi::MutableBuffer {
 public:
  explicit OwningPixelBuffer(std::size_t sizeBytes)
      : _storage(sizeBytes, 0) {}

  // jsi::MutableBuffer interface
  uint8_t* data() override { return _storage.data(); }
  size_t size() const override { return _storage.size(); }

  /// Direct accessor for the native side to memcpy into before
  /// handing the buffer to JSI.  Not part of jsi::MutableBuffer.
  uint8_t* bytes() { return _storage.data(); }

 private:
  std::vector<uint8_t> _storage;
};

/// v0.8.0 — JSI host object representing one `StitcherFrame`.  See
/// `src/stitching/StitcherFrame.ts` for the JS-visible contract.
///
/// Construct on the worklet runtime's thread, hand to
/// `jsi::Object::createFromHostObject`, dispatch to a registered
/// worklet, then invalidate (typically immediately after dispatch
/// returns — the underlying pixel buffer's lifetime is bound to
/// the calling AR-session callback scope).
class CameraFrameJsiHostObject
    : public facebook::jsi::HostObject,
      public std::enable_shared_from_this<CameraFrameJsiHostObject> {
 public:
  /// Factory.  ALWAYS use this — `shared_from_this()` (called inside
  /// `get` for `toArrayBuffer`) requires the instance to be owned
  /// by a `shared_ptr` from the moment of construction.  A raw
  /// `new CameraFrameJsiHostObject(...)` would throw
  /// `std::bad_weak_ptr` on the first `toArrayBuffer()` JSI call.
  ///
  /// Private constructor + public factory enforces this at the
  /// language level; callers can't accidentally construct without
  /// `std::make_shared`.
  static std::shared_ptr<CameraFrameJsiHostObject> create(
      CameraFrameData data) {
    // `std::make_shared` would require a public ctor; route through
    // a tagged-dispatch private constructor instead.
    struct EnableMakeShared : CameraFrameJsiHostObject {
      explicit EnableMakeShared(CameraFrameData d)
          : CameraFrameJsiHostObject(std::move(d)) {}
    };
    return std::make_shared<EnableMakeShared>(std::move(data));
  }

  // jsi::HostObject interface
  facebook::jsi::Value get(
      facebook::jsi::Runtime& rt,
      const facebook::jsi::PropNameID& name) override;
  std::vector<facebook::jsi::PropNameID> getPropertyNames(
      facebook::jsi::Runtime& rt) override;

  /// Mark the host object's backing data as no longer accessible.
  /// Subsequent JSI reads of valid-required properties throw.
  /// Releases the pixel reader (and its underlying ARFrame /
  /// ArImage retain) immediately.  Idempotent.
  void invalidate();

  bool isValid() const { return _isValid; }

 private:
  explicit CameraFrameJsiHostObject(CameraFrameData data);

  CameraFrameData _data;
  bool _isValid;
};

}  // namespace retailens
