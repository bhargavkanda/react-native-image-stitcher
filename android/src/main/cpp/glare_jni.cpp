// SPDX-License-Identifier: Apache-2.0
//
// glare_jni.cpp — JNI binding exposing the shared C++
// retailens::computeGlareScore (in ../../../../cpp/glare.{hpp,cpp}) to
// the Kotlin side (io.imagestitcher.rn.QualityChecker).
//
// Architecture parity with iOS:
//   iOS uses an Obj-C++ bridge to wrap the same C++ free function.
//   Android uses this JNI thunk.  Both ultimately call into the same
//   code in cpp/glare.cpp — that's the point of the port.
//
// Contract:
//   The Kotlin `external fun nativeComputeGlareScore(matAddr: Long)`
//   passes the OpenCV-Java `Mat.nativeObjAddr` of a COLOUR (BGR,
//   CV_8UC3) cv::Mat.  We reinterpret_cast it back to a cv::Mat* and
//   call computeGlareScore(*mat) with the DEFAULT GlareRoi (central-box
//   fallback) — V1 callers pass no ROI.  Returns the mean dark-channel
//   glare score (0..255) as a jdouble; computeGlareScore itself returns
//   0.0 for an empty / unsupported Mat.
//
// Symbol naming:
//   nativeComputeGlareScore is declared as an INSTANCE `external fun`
//   on the QualityChecker ReactContextBaseJavaModule (not a
//   companion/static), so the JNI signature takes a `jobject` (the
//   QualityChecker instance), NOT a `jclass`.  Mismatching this yields
//   an UnsatisfiedLinkError at first call.

// OpenCV's headers redefine NO/YES on platforms whose prefix.pch already
// has the ObjC bool macros; undef defensively (no-op off iOS).  Same
// guard as glare.cpp / crop_quad.cpp / keyframe_gate.cpp.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#include <jni.h>

#include <opencv2/core.hpp>  // cv::Mat (full definition for deref)

#include "glare.hpp"

extern "C" {

// Bridges io.imagestitcher.rn.QualityChecker.nativeComputeGlareScore.
// matAddr is the OpenCV-Java Mat.nativeObjAddr of a COLOUR (BGR,
// CV_8UC3) cv::Mat.  V1 uses the default ROI (central-box fallback) —
// no roi/debug args are forwarded.
JNIEXPORT jdouble JNICALL
Java_io_imagestitcher_rn_QualityChecker_nativeComputeGlareScore(
    JNIEnv*, jobject, jlong matAddr)
{
    if (matAddr == 0) {
        return 0.0;
    }
    const cv::Mat* mat = reinterpret_cast<const cv::Mat*>(matAddr);
    return static_cast<jdouble>(retailens::computeGlareScore(*mat));
}

} // extern "C"
