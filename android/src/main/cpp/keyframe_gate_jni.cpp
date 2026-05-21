// SPDX-License-Identifier: Apache-2.0
//
// keyframe_gate_jni.cpp — JNI bindings exposing the shared C++
// retailens::KeyframeGate (in ../../../../cpp/) to the Kotlin side
// (io.imagestitcher.rn.KeyframeGate).
//
// Architecture parity with iOS:
//   iOS uses an Obj-C++ bridge (KeyframeGateBridge.mm) to wrap the
//   same C++ class.  Android uses these JNI thunks.  Both ultimately
//   call into the same code in cpp/keyframe_gate.cpp — that's the
//   point of the port.
//
// Handle pattern:
//   nativeCreate() returns a `Long` opaque handle (the C++ KeyframeGate
//   pointer cast to jlong).  All subsequent calls pass the handle
//   back.  The Kotlin wrapper owns the handle's lifetime and MUST
//   call nativeDestroy() before being garbage-collected (otherwise we
//   leak a small heap allocation per gate-instance).
//
// Decision packing:
//   Evaluate returns a DoubleArray of length 5:
//     [0] accept              — 1.0 or 0.0
//     [1] reasonCode          — int (the C++ enum int value)
//     [2] newContentFraction  — -1.0 when not computed
//     [3] acceptedCount       — int
//     [4] maxCount            — int
//   Kotlin wrapper unpacks into a data class.  This avoids JNI
//   per-call object construction (NewObject) which is ~10× more
//   expensive than a primitive-array allocation.

#include <jni.h>
#include <cstring>

#include "keyframe_gate.hpp"
#include "ar_frame_pose.h"

namespace {
inline retailens::KeyframeGate* gate(jlong h) {
    return reinterpret_cast<retailens::KeyframeGate*>(h);
}
} // anonymous namespace

extern "C" {

// ── Lifecycle ────────────────────────────────────────────────────

JNIEXPORT jlong JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeCreate(JNIEnv*, jclass) {
    return reinterpret_cast<jlong>(new retailens::KeyframeGate());
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeDestroy(
    JNIEnv*, jclass, jlong handle)
{
    delete gate(handle);
}

// ── Settings ─────────────────────────────────────────────────────

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeSetEnabled(
    JNIEnv*, jclass, jlong handle, jboolean enabled)
{
    gate(handle)->setEnabled(enabled);
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeSetOverlapThreshold(
    JNIEnv*, jclass, jlong handle, jdouble t)
{
    gate(handle)->setOverlapThreshold(t);
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeSetMaxCount(
    JNIEnv*, jclass, jlong handle, jint n)
{
    gate(handle)->setMaxCount(static_cast<int32_t>(n));
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeMarkNextFrameAsLast(
    JNIEnv*, jclass, jlong handle)
{
    gate(handle)->markNextFrameAsLast();
}

// 2026-05-14 — non-AR-mode opt-out for the angular-delta fallback.
// See `setDisableAngularFallback` doc in keyframe_gate.hpp for the
// rationale (no usable pose data in non-AR captures).
JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeSetDisableAngularFallback(
    JNIEnv*, jclass, jlong handle, jboolean disabled)
{
    gate(handle)->setDisableAngularFallback(static_cast<bool>(disabled));
}

// 2026-05-14 — JS-driven IMU translation budget for non-AR mode.
// In non-AR captures, the gate has no ARKit/ARCore pose; the JS
// host computes translation via react-native-sensors accelerometer
// integration and forwards it via this setter so the gate's
// translation-budget logic still kicks in.  See setFlowMaxTranslationM
// doc in keyframe_gate.hpp.  This is the Android JNI counterpart of
// the iOS bridge method that already exists in KeyframeGateBridge.
JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeSetFlowMaxTranslationM(
    JNIEnv*, jclass, jlong handle, jdouble metres)
{
    gate(handle)->setFlowMaxTranslationM(static_cast<double>(metres));
}

// 2026-05-14 — Android JNI for the percentile setter so JS Settings
// can tune novelty aggregation on Android (was iOS-only until now).
// See setFlowNoveltyPercentile doc in keyframe_gate.hpp.
JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeSetFlowNoveltyPercentile(
    JNIEnv*, jclass, jlong handle, jdouble percentile)
{
    gate(handle)->setFlowNoveltyPercentile(static_cast<double>(percentile));
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeReset(
    JNIEnv*, jclass, jlong handle)
{
    gate(handle)->reset();
}

// ── Read-only state ──────────────────────────────────────────────

JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeGetAcceptedCount(
    JNIEnv*, jclass, jlong handle)
{
    return static_cast<jint>(gate(handle)->getAcceptedCount());
}

JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeGetMaxCount(
    JNIEnv*, jclass, jlong handle)
{
    return static_cast<jint>(gate(handle)->getMaxCount());
}

JNIEXPORT jboolean JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeIsEnabled(
    JNIEnv*, jclass, jlong handle)
{
    return static_cast<jboolean>(gate(handle)->isEnabled());
}

// ── Per-frame evaluate ───────────────────────────────────────────
//
// plane16OrNull is FloatArray of exactly 16 elements (column-major),
// or null for angular-delta fallback.  Returns DoubleArray[5] as
// described in the file header.

JNIEXPORT jdoubleArray JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeEvaluate(
    JNIEnv* env, jclass, jlong handle,
    jfloat tx, jfloat ty, jfloat tz,
    jfloat qx, jfloat qy, jfloat qz, jfloat qw,
    jfloat fx, jfloat fy, jfloat cx, jfloat cy,
    jint imageWidth, jint imageHeight,
    jfloatArray plane16OrNull)
{
    retailens::Pose pose;
    pose.tx = tx; pose.ty = ty; pose.tz = tz;
    pose.qx = qx; pose.qy = qy; pose.qz = qz; pose.qw = qw;
    pose.fx = fx; pose.fy = fy; pose.cx = cx; pose.cy = cy;
    pose.imageWidth  = static_cast<int32_t>(imageWidth);
    pose.imageHeight = static_cast<int32_t>(imageHeight);

    retailens::PlaneTransform planeStorage;
    const retailens::PlaneTransform* planePtr = nullptr;
    if (plane16OrNull) {
        jsize len = env->GetArrayLength(plane16OrNull);
        if (len == 16) {
            jfloat* src = env->GetFloatArrayElements(plane16OrNull, nullptr);
            if (src) {
                std::memcpy(planeStorage.m, src, sizeof(float) * 16);
                env->ReleaseFloatArrayElements(plane16OrNull, src, JNI_ABORT);
                planePtr = &planeStorage;
            }
        }
        // len != 16 silently falls through to angular fallback; the
        // Kotlin caller is responsible for passing exactly 16 floats.
    }

    retailens::KeyframeGateDecision d = gate(handle)->evaluate(pose, planePtr);

    jdoubleArray out = env->NewDoubleArray(5);
    jdouble values[5];
    values[0] = d.accept ? 1.0 : 0.0;
    values[1] = static_cast<jdouble>(static_cast<int32_t>(d.reason));
    values[2] = d.newContentFraction;
    values[3] = static_cast<jdouble>(d.acceptedCount);
    values[4] = static_cast<jdouble>(d.maxCount);
    env->SetDoubleArrayRegion(out, 0, 5, values);
    return out;
}

// ── Per-frame evaluate WITH PIXEL DATA ──────────────────────────
//
// 2026-05-21 (v0.3) — pixel-aware Flow-strategy entry point.  The
// `nativeEvaluate` above hands the gate pose + plane only, which
// forces the C++ side to silently fall back from Flow strategy to
// Pose strategy in cpp/keyframe_gate.cpp's evaluateWithFrame()
// (defensive fallback at the grayData==nullptr branch).  This thunk
// is the proper Flow-strategy entry point: the caller supplies the
// frame's grayscale plane (Y plane for YUV camera images, or a
// JPEG-decode result for the JS-driver path), and the C++ Flow
// path actually runs feature tracking on it.
//
// grayBytes:  Java byte[] holding the grayscale plane.  Accessed via
//             GetPrimitiveArrayCritical (no copy, pins GC briefly for
//             the duration of the gate.evaluateWithFrame call —
//             evaluation is ~1-5 ms so the pin window is tight).
// width:      grayscale image width in pixels.
// height:     grayscale image height in pixels.
// stride:     bytes per row.  May exceed width when the plane has
//             padding (ARCore's Image.Plane.getRowStride() can pad).
//
// plane16OrNull: same as nativeEvaluate — column-major 4×4 plane
//             transform, or null for angular-delta fallback.
//
// Returns DoubleArray[5] identical to nativeEvaluate.
JNIEXPORT jdoubleArray JNICALL
Java_io_imagestitcher_rn_KeyframeGate_nativeEvaluateWithFrame(
    JNIEnv* env, jclass, jlong handle,
    jfloat tx, jfloat ty, jfloat tz,
    jfloat qx, jfloat qy, jfloat qz, jfloat qw,
    jfloat fx, jfloat fy, jfloat cx, jfloat cy,
    jint imageWidth, jint imageHeight,
    jfloatArray plane16OrNull,
    jbyteArray grayBytes,
    jint grayWidth, jint grayHeight, jint grayStride)
{
    retailens::Pose pose;
    pose.tx = tx; pose.ty = ty; pose.tz = tz;
    pose.qx = qx; pose.qy = qy; pose.qz = qz; pose.qw = qw;
    pose.fx = fx; pose.fy = fy; pose.cx = cx; pose.cy = cy;
    pose.imageWidth  = static_cast<int32_t>(imageWidth);
    pose.imageHeight = static_cast<int32_t>(imageHeight);

    retailens::PlaneTransform planeStorage;
    const retailens::PlaneTransform* planePtr = nullptr;
    if (plane16OrNull) {
        jsize len = env->GetArrayLength(plane16OrNull);
        if (len == 16) {
            jfloat* src = env->GetFloatArrayElements(plane16OrNull, nullptr);
            if (src) {
                std::memcpy(planeStorage.m, src, sizeof(float) * 16);
                env->ReleaseFloatArrayElements(plane16OrNull, src, JNI_ABORT);
                planePtr = &planeStorage;
            }
        }
    }

    // Pin the byte[] for the duration of the gate evaluate.  Use
    // GetPrimitiveArrayCritical (zero-copy, JVM pins the GC) over
    // GetByteArrayElements (may copy on some VMs) because at 30-60
    // Hz of 2 MB Y-planes, the copy cost adds up.  Evaluate is
    // ~1-5 ms so the pin window is short.  Always paired with
    // ReleasePrimitiveArrayCritical even on the error paths below.
    retailens::KeyframeGateDecision d;
    if (grayBytes && grayWidth > 0 && grayHeight > 0 && grayStride >= grayWidth) {
        void* raw = env->GetPrimitiveArrayCritical(grayBytes, nullptr);
        if (raw) {
            d = gate(handle)->evaluateWithFrame(
                pose, planePtr,
                static_cast<const uint8_t*>(raw),
                static_cast<int32_t>(grayWidth),
                static_cast<int32_t>(grayHeight),
                static_cast<int32_t>(grayStride));
            env->ReleasePrimitiveArrayCritical(grayBytes, raw, JNI_ABORT);
        } else {
            // GetPrimitiveArrayCritical failed (rare, but defensive).
            // Fall back to pose-only path so we degrade gracefully
            // rather than crashing the whole capture pipeline.
            d = gate(handle)->evaluate(pose, planePtr);
        }
    } else {
        // Caller passed null / invalid dims — defensive fall-through
        // to pose-only path (matches the C++ side's own defensive
        // fallback in evaluateWithFrame when grayData == nullptr).
        d = gate(handle)->evaluate(pose, planePtr);
    }

    jdoubleArray out = env->NewDoubleArray(5);
    jdouble values[5];
    values[0] = d.accept ? 1.0 : 0.0;
    values[1] = static_cast<jdouble>(static_cast<int32_t>(d.reason));
    values[2] = d.newContentFraction;
    values[3] = static_cast<jdouble>(d.acceptedCount);
    values[4] = static_cast<jdouble>(d.maxCount);
    env->SetDoubleArrayRegion(out, 0, 5, values);
    return out;
}

} // extern "C"
