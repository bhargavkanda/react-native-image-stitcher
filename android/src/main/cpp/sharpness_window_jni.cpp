// SPDX-License-Identifier: Apache-2.0
//
// sharpness_window_jni.cpp — JNI bindings exposing the shared C++
// retailens::SharpnessWindowMachine (../../../../cpp/sharpness_window.*)
// to the Kotlin side (io.imagestitcher.rn.SharpnessWindow).
//
// Architecture parity with iOS:
//   iOS wraps the same C++ class via SharpnessWindowBridge.mm; these
//   are the Android thunks.  Both platforms consult one decision
//   machine — that's the point (2026-07 adversarial review: the v0.21
//   window logic was re-derived per platform with zero tests).
//
// Handle pattern: identical to keyframe_gate_jni.cpp — nativeCreate()
// returns the C++ pointer as a jlong; Kotlin owns the lifetime and
// calls nativeDestroy().
//
// Decision packing: nativeIngest returns ONE jint —
//   bits 0-7  action (the C++ enum int value)
//   bit  8    replaceBest
//   bit  9    driftClosed (CloseAndSave came from the overlap-drift
//             guard rather than slot exhaustion)
// A packed primitive avoids a per-frame NewObject allocation on the
// 30-60 Hz producer path.

#include <jni.h>

#include "sharpness_window.hpp"

namespace {
inline retailens::SharpnessWindowMachine* machine(jlong h) {
    return reinterpret_cast<retailens::SharpnessWindowMachine*>(h);
}
} // anonymous namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeCreate(JNIEnv*, jobject) {
    return reinterpret_cast<jlong>(new retailens::SharpnessWindowMachine());
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeDestroy(
    JNIEnv*, jobject, jlong handle)
{
    delete machine(handle);
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeSetWindowSize(
    JNIEnv*, jobject, jlong handle, jint k)
{
    machine(handle)->setWindowSize(static_cast<int32_t>(k));
}

JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeIngest(
    JNIEnv*, jobject, jlong handle,
    jboolean isAccept, jdouble score,
    jdouble noveltyFraction, jdouble overlapThreshold)
{
    const retailens::SharpnessWindowDecision d = machine(handle)->ingest(
        isAccept == JNI_TRUE, score, noveltyFraction, overlapThreshold);
    jint packed = static_cast<jint>(d.action) & 0xFF;
    if (d.replaceBest) {
        packed |= 0x100;
    }
    if (d.closeReason == retailens::SharpnessWindowCloseReason::NoveltyDrift) {
        packed |= 0x200;
    }
    return packed;
}

JNIEXPORT jboolean JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeDrain(
    JNIEnv*, jobject, jlong handle)
{
    return machine(handle)->drain() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeReset(
    JNIEnv*, jobject, jlong handle)
{
    machine(handle)->reset();
}

JNIEXPORT jboolean JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeIsOpen(
    JNIEnv*, jobject, jlong handle)
{
    return machine(handle)->isOpen() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jdouble JNICALL
Java_io_imagestitcher_rn_SharpnessWindow_nativeBestScore(
    JNIEnv*, jobject, jlong handle)
{
    return machine(handle)->bestScore();
}

} // extern "C"
