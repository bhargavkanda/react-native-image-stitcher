// SPDX-License-Identifier: Apache-2.0
//
// stitcher_frame_jsi.cpp — implementation of the shared C++ JSI
// host object.  See stitcher_frame_jsi.hpp for class docs.

#include "stitcher_frame_jsi.hpp"

#include <string>
#include <utility>

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
  names.push_back(PropNameID::forUtf8(rt, "__source"));
  names.push_back(PropNameID::forUtf8(rt, "toArrayBuffer"));
  if (!_data.arTrackingState.empty()) {
    names.push_back(PropNameID::forUtf8(rt, "arTrackingState"));
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
  if (name == "__source") return String::createFromUtf8(rt, _data.source);

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
            "[StitcherFrame] toArrayBuffer() called on invalidated frame");
      }
      std::size_t bufSize = self->_data.pixelReader->byteSize();
      auto owning = std::make_shared<OwningPixelBuffer>(bufSize);
      std::size_t written = self->_data.pixelReader->copyTo(owning->bytes(), bufSize);
      if (written == 0 && bufSize > 0) {
        throw JSError(runtime,
            "[StitcherFrame] toArrayBuffer() pixel copy failed (reader returned 0 bytes)");
      }
      return facebook::jsi::ArrayBuffer(runtime, owning);
    };
    return Function::createFromHostFunction(rt,
        PropNameID::forUtf8(rt, "toArrayBuffer"), 0, fn);
  }

  // Unknown property — return undefined (matches JS object
  // semantics).  Worklets accessing arDepth / arAnchors hit this
  // path in v0.8.0 (stubbed to undefined; populated in v0.8.1+).
  return Value::undefined();
}

}  // namespace retailens
