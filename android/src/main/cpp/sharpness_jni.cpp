// SPDX-License-Identifier: Apache-2.0
//
// sharpness_jni.cpp — JNI binding exposing the shared C++
// retailens::sharpnessScore (in ../../../../cpp/sharpness.{hpp,cpp})
// to the Kotlin side (io.imagestitcher.rn.IncrementalStitcher), for
// the pick-sharpest-in-window anti-blur keyframe selection.
//
// Architecture parity with iOS:
//   iOS scores through OpenCVKeyframeCollector.sharpnessScoreForPixelBuffer
//   (Obj-C++), Android through this JNI thunk.  Both call the same
//   shared function in cpp/sharpness.cpp, so the two platforms rank
//   candidate frames with identical math.
//
// Contract:
//   The Kotlin `external fun nativeSharpnessScore(gray, w, h, stride)`
//   passes the frame's grayscale Y-plane bytes (the same buffer the
//   keyframe gate evaluates — for the ARCore path that's the head of
//   the packed NV21 array with stride == width; the UV tail bytes are
//   never read).  Returns the variance-of-Laplacian score as a
//   jdouble; 0.0 for null/undersized input.
//
// Why GetByteArrayElements and NOT GetPrimitiveArrayCritical:
//   sharpnessScore runs multi-ms OpenCV work (INTER_AREA downscale +
//   Laplacian + meanStdDev).  A critical pin would block the GC for
//   that whole span on the 30-60 Hz producer thread — the exact
//   problem the keyframe gate's ingest/evaluate split (audit #4)
//   exists to avoid.  GetByteArrayElements may copy (~0.3 ms for a
//   640×480 Y plane) but never stalls the GC.
//
// Symbol naming:
//   nativeSharpnessScore is declared as an INSTANCE `external fun` on
//   the IncrementalStitcher ReactContextBaseJavaModule (not a
//   companion/static), so the JNI signature takes a `jobject`, NOT a
//   `jclass`.  Mismatching this yields an UnsatisfiedLinkError at
//   first call (same note as glare_jni.cpp).

// OpenCV's headers redefine NO/YES on platforms whose prefix.pch already
// has the ObjC bool macros; undef defensively (no-op off iOS).  Same
// guard as glare_jni.cpp / keyframe_gate_jni.cpp.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#include <jni.h>

#include <opencv2/core.hpp>  // cv::Mat (full definition for wrapping)

#include <cstdint>

#include "sharpness.hpp"

extern "C" {

// Bridges io.imagestitcher.rn.IncrementalStitcher.nativeSharpnessScore.
JNIEXPORT jdouble JNICALL
Java_io_imagestitcher_rn_IncrementalStitcher_nativeSharpnessScore(
    JNIEnv* env, jobject,
    jbyteArray grayData, jint width, jint height, jint stride)
{
    if (grayData == nullptr || width <= 0 || height <= 0 ||
        stride < width) {
        return 0.0;
    }
    // The last row only needs `width` bytes, not a full stride —
    // same bounds rule the keyframe gate's JNI uses.
    const int64_t needed =
        static_cast<int64_t>(stride) * (height - 1) + width;
    if (static_cast<int64_t>(env->GetArrayLength(grayData)) < needed) {
        return 0.0;
    }
    jbyte* bytes = env->GetByteArrayElements(grayData, nullptr);
    if (bytes == nullptr) {
        return 0.0;
    }
    double score = 0.0;
    {
        // Wrap without copying; sharpnessScore's first step (the
        // INTER_AREA downscale) reads into its own buffer and never
        // mutates the source.
        cv::Mat gray(height, width, CV_8UC1,
                     reinterpret_cast<unsigned char*>(bytes),
                     static_cast<size_t>(stride));
        score = retailens::sharpnessScore(gray);
    }
    // JNI_ABORT: read-only access — don't copy back, just release.
    env->ReleaseByteArrayElements(grayData, bytes, JNI_ABORT);
    return static_cast<jdouble>(score);
}

} // extern "C"
