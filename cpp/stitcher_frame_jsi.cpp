// SPDX-License-Identifier: Apache-2.0
//
// stitcher_frame_jsi.cpp — implementation of the shared C++ JSI
// host object.  See stitcher_frame_jsi.hpp for class docs.

#include "stitcher_frame_jsi.hpp"

#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace retailens {

using facebook::jsi::Array;
using facebook::jsi::Function;
using facebook::jsi::HostFunctionType;
using facebook::jsi::JSError;
using facebook::jsi::Object;
using facebook::jsi::PropNameID;
using facebook::jsi::Runtime;
using facebook::jsi::String;
using facebook::jsi::Value;

StitcherFrameJsiHostObject::StitcherFrameJsiHostObject(StitcherFrameData data)
    : _data(std::move(data)), _isValid(true) {}

void StitcherFrameJsiHostObject::invalidate() {
  _isValid = false;
  // Release the pixel reader immediately so the underlying camera
  // buffer can be reclaimed.  ARKit's ARFrame uses a pooled
  // CVPixelBuffer; holding past the dispatch scope causes
  // back-pressure.  ARCore's ArImage must be explicitly released
  // for the next frame's acquire to succeed.
  _data.pixelReader.reset();
}

std::vector<PropNameID> StitcherFrameJsiHostObject::getPropertyNames(
    Runtime& rt) {
  std::vector<PropNameID> names;
  names.push_back(PropNameID::forUtf8(rt, "isValid"));
  if (!_isValid) return names;

  names.push_back(PropNameID::forUtf8(rt, "width"));
  names.push_back(PropNameID::forUtf8(rt, "height"));
  names.push_back(PropNameID::forUtf8(rt, "pixelFormat"));
  names.push_back(PropNameID::forUtf8(rt, "orientation"));
  names.push_back(PropNameID::forUtf8(rt, "timestamp"));
  names.push_back(PropNameID::forUtf8(rt, "pose"));
  names.push_back(PropNameID::forUtf8(rt, "source"));
  names.push_back(PropNameID::forUtf8(rt, "toArrayBuffer"));
  if (!_data.arTrackingState.empty()) {
    names.push_back(PropNameID::forUtf8(rt, "arTrackingState"));
  }
  if (_data.arDepth.has_value()) {
    names.push_back(PropNameID::forUtf8(rt, "arDepth"));
  }
  // AR frames expose `arAnchors` (possibly an empty array); non-AR
  // frames omit it (JS sees `undefined`).
  if (_data.source == "ar") {
    names.push_back(PropNameID::forUtf8(rt, "arAnchors"));
  }
  if (_data.hasIntrinsics) {
    names.push_back(PropNameID::forUtf8(rt, "intrinsics"));
  }
  return names;
}

Value StitcherFrameJsiHostObject::get(Runtime& rt,
                                       const PropNameID& propName) {
  const std::string name = propName.utf8(rt);

  if (name == "isValid") {
    return Value(_isValid);
  }
  // Invalidated host objects expose only `isValid` (returns false).
  // Every other access throws — matches vc FrameHostObject's contract.
  // Lets worklets that incorrectly retain a frame across dispatch
  // boundaries fail loudly rather than read garbage.
  if (!_isValid) {
    throw JSError(rt,
        "[StitcherFrame] cannot access property '" + name +
        "' after host object was invalidated. "
        "Frame data is only valid for the duration of the worklet call.");
  }

  if (name == "width") return Value(static_cast<double>(_data.width));
  if (name == "height") return Value(static_cast<double>(_data.height));
  if (name == "pixelFormat") return String::createFromUtf8(rt, _data.pixelFormat);
  if (name == "orientation") return String::createFromUtf8(rt, _data.orientation);
  if (name == "timestamp") return Value(_data.timestampNs);
  if (name == "source") return String::createFromUtf8(rt, _data.source);

  if (name == "pose") {
    Object pose(rt);
    Array rotation(rt, 4);
    rotation.setValueAtIndex(rt, 0, Value(_data.qx));
    rotation.setValueAtIndex(rt, 1, Value(_data.qy));
    rotation.setValueAtIndex(rt, 2, Value(_data.qz));
    rotation.setValueAtIndex(rt, 3, Value(_data.qw));
    pose.setProperty(rt, "rotation", rotation);
    if (_data.hasTranslation) {
      Array translation(rt, 3);
      translation.setValueAtIndex(rt, 0, Value(_data.tx));
      translation.setValueAtIndex(rt, 1, Value(_data.ty));
      translation.setValueAtIndex(rt, 2, Value(_data.tz));
      pose.setProperty(rt, "translation", translation);
    }
    return pose;
  }

  if (name == "arTrackingState") {
    if (_data.arTrackingState.empty()) return Value::undefined();
    return String::createFromUtf8(rt, _data.arTrackingState);
  }

  if (name == "toArrayBuffer") {
    // Capture a weak self so the lambda doesn't extend the host
    // object's lifetime beyond what the runtime intended.  When the
    // runtime releases its shared_ptr (after dispatch), the weak
    // ref expires and toArrayBuffer() throws on next call.
    auto weakSelf = std::weak_ptr<StitcherFrameJsiHostObject>(shared_from_this());
    HostFunctionType fn = [weakSelf](Runtime& runtime,
                                       const Value& thisVal,
                                       const Value* args,
                                       size_t count) -> Value {
      auto self = weakSelf.lock();
      if (!self || !self->_isValid || !self->_data.pixelReader) {
        throw JSError(runtime,
            "[StitcherFrame] toArrayBuffer() called on invalidated frame "
            "(host object was released after the worklet dispatch returned)");
      }
      const std::size_t bufSize = self->_data.pixelReader->byteSize();

      // Per-runtime ArrayBuffer cache.  Pattern from vision-camera's
      // FrameHostObject.mm:124-149.  Without this, every per-frame
      // worklet call to toArrayBuffer() allocates a fresh ~2MB
      // vector (1920x1080 NV12 Y-plane) — ~60 MB/s of GC churn at
      // 30 fps that defeats the point of having a worklet at all.
      // Caching on `runtime.global()` is safe because (a) each
      // worklet runtime has its own global, and (b) every call
      // overwrites the cached buffer before returning, so there's
      // no time-window for cross-worklet data leaks.
      static constexpr const char* kCacheKey =
          "__stitcherFrameArrayBufferCache";
      auto global = runtime.global();
      std::shared_ptr<OwningPixelBuffer> owning;

      bool needsAlloc = true;
      if (global.hasProperty(runtime, kCacheKey)) {
        auto cached = global.getPropertyAsObject(runtime, kCacheKey);
        if (cached.isArrayBuffer(runtime)) {
          auto cachedBuffer = cached.getArrayBuffer(runtime);
          // Hermes JSI exposes the underlying MutableBuffer via the
          // shared_ptr the ArrayBuffer was constructed with — but
          // there's no public getter once handed to JSI.  We retain
          // a parallel shared_ptr below via a hidden global slot.
          if (cachedBuffer.size(runtime) == bufSize) {
            // Size matches — reuse.  Pull the parallel
            // OwningPixelBuffer ref out of its hidden slot.
            static constexpr const char* kRefKey =
                "__stitcherFrameArrayBufferCacheRef";
            if (global.hasProperty(runtime, kRefKey)) {
              // The hidden ref is stored as a HostObject wrapping
              // the shared_ptr; pull it back.  See alloc path below.
              auto refObj = global.getPropertyAsObject(runtime, kRefKey);
              if (refObj.isHostObject(runtime)) {
                struct RefHolder : facebook::jsi::HostObject {
                  std::shared_ptr<OwningPixelBuffer> buf;
                  explicit RefHolder(std::shared_ptr<OwningPixelBuffer> b)
                      : buf(std::move(b)) {}
                };
                auto holder =
                    refObj.getHostObject<RefHolder>(runtime);
                if (holder && holder->buf) {
                  owning = holder->buf;
                  needsAlloc = false;
                }
              }
            }
          }
        }
      }

      if (needsAlloc) {
        owning = std::make_shared<OwningPixelBuffer>(bufSize);
        // Store the ArrayBuffer + a parallel ref-holder on global.
        // The ArrayBuffer's MutableBuffer is the same `owning`; the
        // ref-holder lets us pull `owning` back out on cache hits.
        global.setProperty(runtime, kCacheKey,
            facebook::jsi::ArrayBuffer(runtime, owning));
        struct RefHolder : facebook::jsi::HostObject {
          std::shared_ptr<OwningPixelBuffer> buf;
          explicit RefHolder(std::shared_ptr<OwningPixelBuffer> b)
              : buf(std::move(b)) {}
        };
        global.setProperty(runtime, "__stitcherFrameArrayBufferCacheRef",
            facebook::jsi::Object::createFromHostObject(runtime,
                std::make_shared<RefHolder>(owning)));
      }

      std::size_t written =
          self->_data.pixelReader->copyTo(owning->bytes(), bufSize);
      if (written == 0 && bufSize > 0) {
        throw JSError(runtime,
            "[StitcherFrame] toArrayBuffer() pixel copy failed "
            "(reader returned 0 bytes — likely the underlying "
            "camera buffer was NULL or unreadable; see native log)");
      }

      // Re-fetch the cached ArrayBuffer to return.  Cheap (just a
      // property lookup); avoids constructing a new jsi::ArrayBuffer
      // that wraps the same MutableBuffer (which would be wasteful).
      return global.getPropertyAsObject(runtime, kCacheKey)
          .getArrayBuffer(runtime);
    };
    return Function::createFromHostFunction(rt,
        PropNameID::forUtf8(rt, "toArrayBuffer"), 0, fn);
  }

  if (name == "arDepth") {
    // Normalise both platforms to ONE JS shape:
    //   { width, height, depthMap: Float32 metres, confidenceMap?: Uint8 0..2 }
    if (!_data.arDepth.has_value()) return Value::undefined();
    const ArDepth& d = *_data.arDepth;
    const std::size_t px =
        static_cast<std::size_t>(d.width) * static_cast<std::size_t>(d.height);
    if (px == 0) return Value::undefined();

    Object depth(rt);
    depth.setProperty(rt, "width", Value(static_cast<double>(d.width)));
    depth.setProperty(rt, "height", Value(static_cast<double>(d.height)));

    // depthMap — always emitted as Float32 metres (px * 4 bytes).
    auto depthBuf = std::make_shared<OwningPixelBuffer>(px * sizeof(float));
    auto* out = reinterpret_cast<float*>(depthBuf->bytes());
    std::vector<uint8_t> conf;  // Uint8 0..2 (empty => no confidenceMap)

    if (d.format == "f32m") {
      // iOS ARKit: depthBytes already Float32 metres; confidence is a
      // separate Uint8 (ARConfidenceLevel 0..2) — pass both through.
      if (d.depthBytes.size() >= px * sizeof(float)) {
        std::memcpy(out, d.depthBytes.data(), px * sizeof(float));
      }
      if (d.confidenceBytes.size() >= px) {
        conf.assign(d.confidenceBytes.begin(), d.confidenceBytes.begin() + px);
      }
    } else if (d.format == "u16packed") {
      // Android ARCore DEPTH16: low 13 bits = millimetres, high 3 bits
      // = confidence 0..7.  Convert mm->metres and map confidence 0..7
      // -> 0..2 so JS sees the same scale as iOS.
      const auto* src = reinterpret_cast<const uint16_t*>(d.depthBytes.data());
      const std::size_t srcCount = d.depthBytes.size() / sizeof(uint16_t);
      conf.resize(px, 0);
      for (std::size_t i = 0; i < px; ++i) {
        const uint16_t raw = (i < srcCount) ? src[i] : 0;
        out[i] = static_cast<float>(raw & 0x1FFF) / 1000.0f;
        const uint8_t c7 = static_cast<uint8_t>((raw >> 13) & 0x7);
        conf[i] = (c7 <= 2) ? 0 : (c7 <= 5 ? 1 : 2);
      }
    } else {
      return Value::undefined();
    }

    depth.setProperty(rt, "depthMap", facebook::jsi::ArrayBuffer(rt, depthBuf));
    if (!conf.empty()) {
      auto confBuf = std::make_shared<OwningPixelBuffer>(px);
      std::memcpy(confBuf->bytes(), conf.data(), px);
      depth.setProperty(rt, "confidenceMap",
                        facebook::jsi::ArrayBuffer(rt, confBuf));
    }
    return depth;
  }

  if (name == "arAnchors") {
    // AR frames return an array (possibly empty); non-AR returns
    // undefined (matches the JS `arAnchors?: ARAnchor[]` contract).
    if (_data.source != "ar") return Value::undefined();
    Array anchors(rt, _data.arAnchors.size());
    for (std::size_t i = 0; i < _data.arAnchors.size(); ++i) {
      const ArAnchor& a = _data.arAnchors[i];
      Object obj(rt);
      obj.setProperty(rt, "id", String::createFromUtf8(rt, a.id));
      obj.setProperty(rt, "type", String::createFromUtf8(rt, a.type));
      Array transform(rt, 16);
      for (std::size_t j = 0; j < 16; ++j) {
        transform.setValueAtIndex(rt, j, Value(a.transform[j]));
      }
      obj.setProperty(rt, "transform", transform);
      if (!a.alignment.empty()) {
        obj.setProperty(rt, "alignment",
                        String::createFromUtf8(rt, a.alignment));
      }
      if (a.hasExtent) {
        Array extent(rt, 2);
        extent.setValueAtIndex(rt, 0, Value(a.extentX));
        extent.setValueAtIndex(rt, 1, Value(a.extentZ));
        obj.setProperty(rt, "extent", extent);
      }
      if (!a.classification.empty()) {
        obj.setProperty(rt, "classification",
                        String::createFromUtf8(rt, a.classification));
      }
      if (a.hasMesh) {
        // Scene-reconstruction geometry — bytes emitted verbatim as
        // ArrayBuffers (vertices=Float32, faces=Uint32, classifications=Uint8).
        Object mesh(rt);
        auto vbuf = std::make_shared<OwningPixelBuffer>(a.meshVertices.size());
        if (!a.meshVertices.empty()) {
          std::memcpy(vbuf->bytes(), a.meshVertices.data(), a.meshVertices.size());
        }
        mesh.setProperty(rt, "vertices", facebook::jsi::ArrayBuffer(rt, vbuf));
        auto fbuf = std::make_shared<OwningPixelBuffer>(a.meshFaces.size());
        if (!a.meshFaces.empty()) {
          std::memcpy(fbuf->bytes(), a.meshFaces.data(), a.meshFaces.size());
        }
        mesh.setProperty(rt, "faces", facebook::jsi::ArrayBuffer(rt, fbuf));
        if (!a.meshClassifications.empty()) {
          auto cbuf =
              std::make_shared<OwningPixelBuffer>(a.meshClassifications.size());
          std::memcpy(cbuf->bytes(), a.meshClassifications.data(),
                      a.meshClassifications.size());
          mesh.setProperty(rt, "classifications",
                           facebook::jsi::ArrayBuffer(rt, cbuf));
        }
        obj.setProperty(rt, "meshGeometry", mesh);
      }
      anchors.setValueAtIndex(rt, i, obj);
    }
    return anchors;
  }

  // Per-frame camera intrinsics (AR frames only).  `intrinsics ===
  // undefined` when not populated (non-AR frames).  Shape mirrors the
  // JS `CameraFrame.intrinsics`: fx/fy/cx/cy in pixels + the capture
  // resolution they're expressed at.
  if (name == "intrinsics") {
    if (!_data.hasIntrinsics) return Value::undefined();
    Object intrinsics(rt);
    intrinsics.setProperty(rt, "fx", Value(_data.fx));
    intrinsics.setProperty(rt, "fy", Value(_data.fy));
    intrinsics.setProperty(rt, "cx", Value(_data.cx));
    intrinsics.setProperty(rt, "cy", Value(_data.cy));
    intrinsics.setProperty(
        rt, "imageWidth",
        Value(static_cast<double>(_data.intrinsicsImageWidth)));
    intrinsics.setProperty(
        rt, "imageHeight",
        Value(static_cast<double>(_data.intrinsicsImageHeight)));
    return intrinsics;
  }

  // Unknown property — return undefined (matches JS object semantics).
  return Value::undefined();
}

}  // namespace retailens
