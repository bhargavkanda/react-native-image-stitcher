// SPDX-License-Identifier: Apache-2.0
//
// stitcher_jsi_install_jni.cpp — JNI binding for the Android-side
// JSI install (v0.8.0 Phase 4b.ii).
//
// Kotlin's `StitcherJsiInstallerModule.nativeInstall(jsiRuntimeRef)`
// calls into this file.  We unbox the `jsi::Runtime*` from the
// Java `long` and hand it to the shared
// `retailens::installStitcherProxy(runtime)` function which sets
// `globalThis.__stitcherProxy`.  Same destination as iOS — the
// host object class lives in `cpp/stitcher_proxy_jsi.{hpp,cpp}`.
//
// ## Why a `long` ref, not a JSI handle wrapper class
//
// `ReactApplicationContext.getJavaScriptContextHolder()` returns a
// `JavaScriptContextHolder` whose `.get()` returns a Java `long`
// that's the raw pointer to the C++ `jsi::Runtime*`.  Same
// contract as worklets-core's `WorkletsModule.nativeInstall`
// (verified at the same call site).  Caller is responsible for
// ensuring the runtime outlives this call — in practice, the
// runtime IS the JS thread's runtime which lives the whole
// process lifetime, so this is structurally always safe in our
// usage.
//
// ## Threading
//
// Kotlin invokes this from a `@ReactMethod(isBlockingSynchronousMethod
// = true)` so we're already on the JS thread.  Synchronous JSI
// access is safe.

#include "stitcher_proxy_jsi.hpp"

// v0.8.0 Phase 4b.iii — per-frame fan-out support.  The shared
// `dispatchToHostWorklets` posts to worklets-core's default context;
// this JNI file's `nativeDispatchToHostWorklets` constructs the
// `StitcherFrameData` from raw bytes + pose + dims and forwards it.
#include "stitcher_frame_data.hpp"
#include "stitcher_worklet_dispatch.hpp"
#include "stitcher_worklet_registry.hpp"

#include <react-native-worklets-core/WKTJsiWorkletContext.h>

#include <jni.h>
#include <jsi/jsi.h>

#include <android/log.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <utility>
#include <vector>

#define LOG_TAG "StitcherJsiInstaller"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" JNIEXPORT jboolean JNICALL
Java_io_imagestitcher_rn_StitcherJsiInstallerModule_nativeInstall(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong jsiRuntimeRef) {
  if (jsiRuntimeRef == 0) {
    // ReactApplicationContext.getJavaScriptContextHolder().get()
    // returns 0 when the runtime isn't ready (rare — JS would have
    // had to call us before its own runtime was up; impossible in
    // practice).  Defensive.
    return JNI_FALSE;
  }
  auto* runtime = reinterpret_cast<facebook::jsi::Runtime*>(jsiRuntimeRef);
  retailens::installStitcherProxy(*runtime);
  LOGI("installed globalThis.__stitcherProxy on main JS runtime.");
  return JNI_TRUE;
}

// ─── v0.8.0 Phase 4b.iii — Android NV21 PixelBufferReader ──────────
//
// Owns a heap-allocated `std::vector<uint8_t>` of pre-copied NV21
// bytes.  Constructed by `nativeDispatchToHostWorklets` after one
// JNI byte-array copy from Kotlin; outlives the AR render thread
// scope via `StitcherFrameData::pixelReader`'s `shared_ptr` —
// dropped when the host object is invalidated.

namespace {

class AndroidNV21BufferReader : public retailens::PixelBufferReader {
 public:
  explicit AndroidNV21BufferReader(std::vector<uint8_t>&& bytes)
      : _bytes(std::move(bytes)) {}

  std::size_t byteSize() const override { return _bytes.size(); }

  std::size_t copyTo(uint8_t* dst, std::size_t maxBytes) override {
    if (dst == nullptr) return 0;
    std::size_t n = std::min(maxBytes, _bytes.size());
    if (n > 0) {
      std::memcpy(dst, _bytes.data(), n);
    }
    return n;
  }

 private:
  std::vector<uint8_t> _bytes;
};

}  // namespace

// ─── v0.8.0 Phase 4b.iii — registry count accessor ─────────────────
//
// Cheap (microsecond) accessor for the per-frame gate in
// `RNSARCameraView.onDrawFrame`.  Avoids the NV21 byte-pack cost
// when no host worklets are registered AND no capture is active.
// Same atomic-read the JSI host object's `count()` host function
// goes through.
extern "C" JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_StitcherWorkletRuntime_nativeRegistryCount(
    JNIEnv* /*env*/, jobject /*thiz*/) {
  return static_cast<jint>(
      retailens::StitcherWorkletRegistry::shared().count());
}

// ─── v0.8.0 Phase 4b.iii — per-frame dispatch JNI binding ──────────
//
// Called from Kotlin's `StitcherWorkletRuntime.dispatchToHostWorklets`
// after the first-party stitching block has returned (the AR-frame
// data is still in scope on the Kotlin side because
// `RNSARCameraView.onDrawFrame` reads the ARCore Frame, builds the
// NV21 byte[], invokes first-party via `runFirstParty { ... }`,
// THEN calls into here).
//
// The byte[] is COPIED into our owned vector — ARCore's pixel data
// becomes inaccessible shortly after `onDrawFrame` returns, and our
// async dispatch must outlive that scope.  Cost: one ~3MB memcpy
// per frame at 1080p NV21 (~90 MB/s at 30 fps; <5 ms on a mid-range
// Android device).  Fast-path early-exit when the registry is empty
// skips the copy entirely.
//
// trackingState: Kotlin passes one of "" / "notAvailable" / "limited"
// / "normal" (empty string = field unset → JS sees undefined).
extern "C" JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_StitcherWorkletRuntime_nativeDispatchToHostWorklets(
    JNIEnv* env, jobject /*thiz*/,
    jbyteArray nv21Bytes,
    jint width, jint height,
    jdouble qx, jdouble qy, jdouble qz, jdouble qw,
    jdouble tx, jdouble ty, jdouble tz,
    jdouble timestampNs,
    jstring trackingState) {
  // Fast-path early-exit BEFORE the JNI byte-array copy.  Saves the
  // ~3MB memcpy + JSI host object alloc on every frame in the
  // common first-party-only case.
  if (retailens::StitcherWorkletRegistry::shared().count() == 0) {
    return;
  }

  if (nv21Bytes == nullptr) {
    LOGE("nativeDispatchToHostWorklets: nv21Bytes is null");
    return;
  }

  const jsize byteLen = env->GetArrayLength(nv21Bytes);
  if (byteLen <= 0) {
    LOGE("nativeDispatchToHostWorklets: nv21Bytes is empty");
    return;
  }

  // Copy into our owned vector.  `GetByteArrayRegion` is the
  // canonical "copy" path — `GetByteArrayElements + Release` MAY
  // pin the JVM array (zero-copy) but the contract isn't
  // guaranteed; we need our own buffer for the async dispatch
  // anyway, so the explicit copy is cleaner.
  std::vector<uint8_t> bytes(static_cast<std::size_t>(byteLen));
  env->GetByteArrayRegion(
      nv21Bytes, 0, byteLen,
      reinterpret_cast<jbyte*>(bytes.data()));

  // Extract trackingState string (may be null on the Kotlin side
  // for non-AR or pre-tracking frames — guard accordingly).
  std::string trackingStateStr;
  if (trackingState != nullptr) {
    const char* cs = env->GetStringUTFChars(trackingState, nullptr);
    if (cs != nullptr) {
      trackingStateStr = cs;
      env->ReleaseStringUTFChars(trackingState, cs);
    }
  }

  // Build StitcherFrameData.  Field semantics match the iOS
  // `StitcherFrameHostObject::fromARFrame:pose:` factory; this is
  // the Android equivalent path.
  retailens::StitcherFrameData data;
  data.source = "ar";
  data.width = static_cast<int32_t>(width);
  data.height = static_cast<int32_t>(height);
  // ARCore's camera image is YUV_420_888 on Android, mapped to NV21
  // by the existing `YuvImageConverter.packNV21` path — the byte[]
  // we receive is interleaved Y then VU.  Worklets gate on this
  // string identifier (`'yuv'` vs `'unknown'`); v0.8.0 always
  // emits `'yuv'` for AR mode on Android (NV21).
  data.pixelFormat = "yuv";
  // Android AR-mode camera image is always landscape-natural; the
  // mapping matches iOS' coarse two-value set.  Hosts that need
  // exact display orientation read it from the device-orientation
  // sensors (see `useDeviceOrientation` hook).
  data.orientation = (width >= height) ? "landscape-right" : "portrait";
  data.timestampNs = timestampNs;
  data.qx = qx;
  data.qy = qy;
  data.qz = qz;
  data.qw = qw;
  data.tx = tx;
  data.ty = ty;
  data.tz = tz;
  data.hasTranslation = true;  // AR mode always has translation
  data.arTrackingState = trackingStateStr;
  data.pixelReader =
      std::make_shared<AndroidNV21BufferReader>(std::move(bytes));

  // Dispatch on worklets-core's default context.  That context is
  // initialised by JS' `Worklets.install()` (which runs at lib
  // bootstrap when worklets-core's module is imported); by the
  // time host worklets are registered, the default context is up.
  // The shared dispatch helper handles the registry snapshot,
  // host-object construction (inside the worklet thread), per-
  // worklet failure isolation, and invalidation.
  retailens::dispatchToHostWorklets(
      RNWorklet::JsiWorkletContext::getDefaultInstance(),
      std::move(data));
}
