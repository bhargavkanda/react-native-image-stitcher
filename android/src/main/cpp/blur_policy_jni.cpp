// SPDX-License-Identifier: Apache-2.0
//
// blur_policy_jni.cpp — JNI bindings exposing the shared C++ anti-blur
// ADMISSION policy (../../../../cpp/blur_policy.{hpp,cpp}) to the
// Kotlin side (io.imagestitcher.rn.BlurPolicy).
//
// Architecture parity with iOS:
//   iOS wraps the same `retailens::admitKeyframe` +
//   `retailens::RunningScoreMedian` through its Obj-C++ bridge; these
//   are the Android thunks.  Both platforms consult ONE verdict
//   function, which is the point — the v0.21 window logic was
//   re-derived per platform and drifted (2026-07 adversarial review).
//
// Handle pattern: identical to sharpness_window_jni.cpp — the median
// is created by nativeMedianCreate() and returned as a jlong; Kotlin
// owns the lifetime and calls nativeMedianDestroy().  admitKeyframe is
// STATELESS in C++, so its thunk takes no handle: the caller passes
// the config triple and the four inputs by value.
//
// No packed return here (unlike the window's decision bitfield): the
// verdict is a single enum and the call happens at most once per
// keyframe close — a plain jint is clearer and costs nothing.
//
// Symbol naming: every `external fun` is declared as an INSTANCE
// member of BlurPolicy (not a companion/@JvmStatic), so all signatures
// take a `jobject`, NOT a `jclass`.  Mismatching this yields an
// UnsatisfiedLinkError at first call (same note as sharpness_jni.cpp).
//
// OpenCV-free, like the header it wraps — nothing in this translation
// unit pulls in cv::*.

#include <jni.h>

#include "blur_policy.hpp"

namespace {
inline retailens::RunningScoreMedian* median(jlong h) {
    return reinterpret_cast<retailens::RunningScoreMedian*>(h);
}
} // anonymous namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_io_imagestitcher_rn_BlurPolicy_nativeMedianCreate(
    JNIEnv*, jobject, jint capacity)
{
    return reinterpret_cast<jlong>(
        new retailens::RunningScoreMedian(static_cast<int32_t>(capacity)));
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_BlurPolicy_nativeMedianDestroy(
    JNIEnv*, jobject, jlong handle)
{
    delete median(handle);
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_BlurPolicy_nativeMedianAdd(
    JNIEnv*, jobject, jlong handle, jdouble score)
{
    median(handle)->add(score);
}

JNIEXPORT jdouble JNICALL
Java_io_imagestitcher_rn_BlurPolicy_nativeMedianValue(
    JNIEnv*, jobject, jlong handle)
{
    return median(handle)->median();
}

JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_BlurPolicy_nativeMedianCount(
    JNIEnv*, jobject, jlong handle)
{
    return static_cast<jint>(median(handle)->count());
}

JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_BlurPolicy_nativeMedianReset(
    JNIEnv*, jobject, jlong handle)
{
    median(handle)->reset();
}

JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_BlurPolicy_nativeAdmitKeyframe(
    JNIEnv*, jobject,
    jdouble maxCommitPanRateRadPerSec,
    jdouble minScoreFractionOfMedian,
    jint    maxConsecutiveHolds,
    jdouble candidateScore,
    jdouble sessionMedianScore,
    jdouble panRateRadPerSec,
    jint    consecutiveHolds)
{
    // Every "unknown" sentinel (median <= 0, panRate < 0, non-finite)
    // is interpreted by the shared C++, not here — duplicating the
    // fail-open rules in the thunk is exactly how the two platforms
    // would drift apart again.
    retailens::BlurPolicyConfig cfg;
    cfg.maxCommitPanRateRadPerSec = maxCommitPanRateRadPerSec;
    cfg.minScoreFractionOfMedian  = minScoreFractionOfMedian;
    cfg.maxConsecutiveHolds       = static_cast<int32_t>(maxConsecutiveHolds);

    retailens::BlurAdmissionInput in;
    in.candidateScore     = candidateScore;
    in.sessionMedianScore = sessionMedianScore;
    in.panRateRadPerSec   = panRateRadPerSec;
    in.consecutiveHolds   = static_cast<int32_t>(consecutiveHolds);

    return static_cast<jint>(retailens::admitKeyframe(cfg, in));
}

} // extern "C"
