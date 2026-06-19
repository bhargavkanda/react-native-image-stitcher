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
// `CameraFrameData` from raw bytes + pose + dims and forwards it.
#include "camera_frame_data.hpp"
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
// scope via `CameraFrameData::pixelReader`'s `shared_ptr` —
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

// ─── per-frame extraction-config gate ──────────────────────────────
//
// Returns the current `retailens::getExtractionConfig()` packed into a
// `jint` bitmask so Kotlin can cheaply read the JS-driven
// enableDepth/enableAnchors/enableMesh toggles once per frame and skip
// the costly ARCore depth-acquire / anchor-collect / mesh-build work
// when a host hasn't opted in.  Same atomic-snapshot read the JSI
// `setExtractionConfig` host function writes.
//
//   bit0 (0x1) = depth
//   bit1 (0x2) = anchors
//   bit2 (0x4) = mesh
extern "C" JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_StitcherWorkletRuntime_nativeExtractionFlags(
    JNIEnv* /*env*/, jobject /*thiz*/) {
  const retailens::ExtractionConfig cfg = retailens::getExtractionConfig();
  jint flags = 0;
  if (cfg.depth) flags |= 0x1;
  if (cfg.anchors) flags |= 0x2;
  if (cfg.mesh) flags |= 0x4;
  return flags;
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
    jstring trackingState,
    jbyteArray depthBytes,
    jint depthWidth, jint depthHeight,
    jobjectArray anchorIds,
    jobjectArray anchorTypes,
    jobjectArray anchorTransforms,
    jobjectArray anchorMeshVertices,
    jobjectArray anchorMeshFaces,
    jdouble fx, jdouble fy, jdouble cx, jdouble cy,
    jint intrinsicsImageWidth, jint intrinsicsImageHeight,
    jobjectArray anchorAlignments,
    jobjectArray anchorExtents) {
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

  // Build CameraFrameData.  Field semantics match the iOS
  // `CameraFrameHostObject::fromARFrame:pose:` factory; this is
  // the Android equivalent path.
  retailens::CameraFrameData data;
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

  // ── AR depth (ARCore DEPTH16, "u16packed") ────────────────────────
  //
  // Kotlin hands us a dense, row-packed uint16-per-pixel byte array
  // (depthWidth*depthHeight*2 bytes; low 13 bits = mm, high 3 bits =
  // confidence 0..7) or null when depth is unavailable this frame.  We
  // copy the bytes verbatim into `data.arDepth.depthBytes` with
  // `format = "u16packed"` and leave `confidenceBytes` EMPTY — the
  // shared JSI layer (`cpp/camera_frame_jsi.cpp`) unpacks mm->metres
  // and confidence 0..7 -> 0..2 from the high bits.
  if (depthBytes != nullptr && depthWidth > 0 && depthHeight > 0) {
    const jsize depthLen = env->GetArrayLength(depthBytes);
    if (depthLen > 0) {
      retailens::ArDepth depth;
      depth.width = static_cast<int32_t>(depthWidth);
      depth.height = static_cast<int32_t>(depthHeight);
      depth.format = "u16packed";
      depth.depthBytes.resize(static_cast<std::size_t>(depthLen));
      env->GetByteArrayRegion(
          depthBytes, 0, depthLen,
          reinterpret_cast<jbyte*>(depth.depthBytes.data()));
      // confidenceBytes intentionally left empty (packed into the high
      // 3 bits of each uint16 — unpacked JSI-side).
      data.arDepth = std::move(depth);
    }
  }

  // ── Per-frame camera intrinsics ───────────────────────────────────
  //
  // Kotlin passes camera.imageIntrinsics (fx,fy,cx,cy in pixels) + the
  // capture resolution they're expressed at.  fx <= 0.0 is the "no
  // intrinsics" sentinel (defensive — AR frames always carry valid
  // intrinsics, but a degenerate session could yield 0).  The shared
  // JSI layer exposes `intrinsics === undefined` when !hasIntrinsics.
  if (fx > 0.0) {
    data.hasIntrinsics = true;
    data.fx = fx;
    data.fy = fy;
    data.cx = cx;
    data.cy = cy;
    data.intrinsicsImageWidth = static_cast<int32_t>(intrinsicsImageWidth);
    data.intrinsicsImageHeight = static_cast<int32_t>(intrinsicsImageHeight);
  }

  // ── AR anchors ────────────────────────────────────────────────────
  //
  // Five parallel arrays from Kotlin: ids (String[]), types (String[]),
  // transforms (double[16][]), and the per-anchor mesh byte arrays
  // meshVertices (byte[][], Float32 xyz triplets) + meshFaces (byte[][],
  // Uint32 triangle indices) — both NULL for non-mesh anchors.  Build one
  // `retailens::ArAnchor` per entry; the transform is already ROW-MAJOR
  // (anchor->world) — Kotlin transposed ARCore's column-major OpenGL
  // matrix before marshaling (mesh anchors emit identity: the vertices
  // are camera-local).  Empty arrays (the common case — no host opted
  // into anchors/mesh) leave `data.arAnchors` empty, which the JSI layer
  // surfaces as `[]` for source=="ar".
  if (anchorIds != nullptr && anchorTypes != nullptr &&
      anchorTransforms != nullptr) {
    const jsize anchorCount = env->GetArrayLength(anchorIds);
    data.arAnchors.reserve(static_cast<std::size_t>(anchorCount));
    for (jsize i = 0; i < anchorCount; ++i) {
      retailens::ArAnchor anchor;

      auto idObj = reinterpret_cast<jstring>(
          env->GetObjectArrayElement(anchorIds, i));
      if (idObj != nullptr) {
        const char* cs = env->GetStringUTFChars(idObj, nullptr);
        if (cs != nullptr) {
          anchor.id = cs;
          env->ReleaseStringUTFChars(idObj, cs);
        }
        env->DeleteLocalRef(idObj);
      }

      auto typeObj = reinterpret_cast<jstring>(
          env->GetObjectArrayElement(anchorTypes, i));
      if (typeObj != nullptr) {
        const char* cs = env->GetStringUTFChars(typeObj, nullptr);
        if (cs != nullptr) {
          anchor.type = cs;
          env->ReleaseStringUTFChars(typeObj, cs);
        }
        env->DeleteLocalRef(typeObj);
      }

      auto transformObj = reinterpret_cast<jdoubleArray>(
          env->GetObjectArrayElement(anchorTransforms, i));
      if (transformObj != nullptr) {
        const jsize n = env->GetArrayLength(transformObj);
        jdouble* elems = env->GetDoubleArrayElements(transformObj, nullptr);
        if (elems != nullptr) {
          const jsize copyN = (n < 16) ? n : 16;
          for (jsize j = 0; j < copyN; ++j) {
            anchor.transform[static_cast<std::size_t>(j)] =
                static_cast<double>(elems[j]);
          }
          env->ReleaseDoubleArrayElements(transformObj, elems, JNI_ABORT);
        }
        env->DeleteLocalRef(transformObj);
      }

      // ── per-anchor plane alignment + extent ─────────────────────────
      //
      // anchorAlignments[i] is "" for image/mesh anchors (→ JS
      // `alignment === undefined`) or "horizontal"/"vertical" for plane
      // anchors.  anchorExtents[i] is null for non-plane anchors or a
      // double[2] = {extentX, extentZ} (metres) for planes.  Both arrays
      // are parallel to anchorIds; guard for null (a caller passing the
      // older arg shape) the same way the mesh arrays are guarded.  We do
      // NOT set classification — Android has no plane semantics (iOS-only).
      if (anchorAlignments != nullptr) {
        auto alignObj = reinterpret_cast<jstring>(
            env->GetObjectArrayElement(anchorAlignments, i));
        if (alignObj != nullptr) {
          const char* cs = env->GetStringUTFChars(alignObj, nullptr);
          if (cs != nullptr) {
            if (cs[0] != '\0') {
              anchor.alignment = cs;
            }
            env->ReleaseStringUTFChars(alignObj, cs);
          }
          env->DeleteLocalRef(alignObj);
        }
      }
      if (anchorExtents != nullptr) {
        auto extObj = reinterpret_cast<jdoubleArray>(
            env->GetObjectArrayElement(anchorExtents, i));
        if (extObj != nullptr) {
          if (env->GetArrayLength(extObj) >= 2) {
            jdouble vals[2] = {0.0, 0.0};
            env->GetDoubleArrayRegion(extObj, 0, 2, vals);
            anchor.hasExtent = true;
            anchor.extentX = static_cast<double>(vals[0]);
            anchor.extentZ = static_cast<double>(vals[1]);
          }
          env->DeleteLocalRef(extObj);
        }
      }

      // ── per-anchor mesh geometry (depth-derived; type=="mesh") ──────
      //
      // anchorMeshVertices[i] / anchorMeshFaces[i] are null for non-mesh
      // anchors and a byte[] for a mesh anchor.  When BOTH are present we
      // copy them verbatim into the ArAnchor's vectors and flag hasMesh —
      // the JSI layer (`cpp/camera_frame_jsi.cpp`) emits them as
      // ArrayBuffers (Float32 vertices / Uint32 faces) unchanged.
      // meshClassifications stays empty (Android depth meshes carry no
      // per-face semantics).
      if (anchorMeshVertices != nullptr && anchorMeshFaces != nullptr) {
        auto vertObj = reinterpret_cast<jbyteArray>(
            env->GetObjectArrayElement(anchorMeshVertices, i));
        auto faceObj = reinterpret_cast<jbyteArray>(
            env->GetObjectArrayElement(anchorMeshFaces, i));
        if (vertObj != nullptr && faceObj != nullptr) {
          const jsize vLen = env->GetArrayLength(vertObj);
          const jsize fLen = env->GetArrayLength(faceObj);
          if (vLen > 0 && fLen > 0) {
            anchor.meshVertices.resize(static_cast<std::size_t>(vLen));
            env->GetByteArrayRegion(
                vertObj, 0, vLen,
                reinterpret_cast<jbyte*>(anchor.meshVertices.data()));
            anchor.meshFaces.resize(static_cast<std::size_t>(fLen));
            env->GetByteArrayRegion(
                faceObj, 0, fLen,
                reinterpret_cast<jbyte*>(anchor.meshFaces.data()));
            anchor.hasMesh = true;
          }
        }
        if (vertObj != nullptr) env->DeleteLocalRef(vertObj);
        if (faceObj != nullptr) env->DeleteLocalRef(faceObj);
      }

      data.arAnchors.push_back(std::move(anchor));
    }
  }

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
