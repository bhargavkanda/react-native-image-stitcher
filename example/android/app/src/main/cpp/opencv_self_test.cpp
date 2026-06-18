// opencv_self_test.cpp — HOST-side proof that the example app can reuse the
// SAME custom OpenCV bundled by react-native-image-stitcher (no second copy).
//
// This translation unit is NOT part of the library; it lives in the example
// app's own externalNativeBuild (see app/src/main/cpp/CMakeLists.txt).  It
// links against the bundled OpenCV via OpenCV's own first-class CMake package
// (`find_package(OpenCV)` against the library's vendored SDK), exercising:
//   - a CORE symbol  (construct a cv::Mat — resolved at runtime from the
//     library's already-loaded libopencv_java4.so), and
//   - cv::Stitcher::create(PANORAMA) — resolved at LINK time from the static
//     archive libopencv_stitching.a (whole-archived into THIS .so), proving
//     the host gets stitching too even though it isn't in the fat .so.
//
// Exposed via JNI so neither reference is dead-code-eliminated.

#include <jni.h>
#include <string>

#include <opencv2/core.hpp>
#include <opencv2/stitching.hpp>

extern "C" JNIEXPORT jstring JNICALL
Java_com_rnimagestitcherexample_OpenCVSelfTest_opencvSelfTest(JNIEnv* env, jobject /* this */) {
    // CORE: touch cv::Mat so the consumer .so references libopencv_java4.so.
    cv::Mat probe(2, 2, CV_8UC1, cv::Scalar(0));

    // STITCHING: cv::Stitcher::create must be link-resolved from the static
    // archive.  Keep a non-null check so the symbol can't be elided.
    cv::Ptr<cv::Stitcher> stitcher = cv::Stitcher::create(cv::Stitcher::PANORAMA);
    bool stitcherOk = !stitcher.empty();

    std::string result = "OpenCV " + std::string(CV_VERSION) +
                         " | Mat " + std::to_string(probe.rows) + "x" +
                         std::to_string(probe.cols) +
                         " | Stitcher=" + (stitcherOk ? "OK" : "NULL");
    return env->NewStringUTF(result.c_str());
}
