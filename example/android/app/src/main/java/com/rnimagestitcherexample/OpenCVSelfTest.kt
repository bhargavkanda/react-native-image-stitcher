package com.rnimagestitcherexample

/**
 * OpenCVSelfTest — host-side proof that the example app reuses the SAME
 * custom OpenCV bundled by react-native-image-stitcher (no second copy),
 * including cv::Stitcher.
 *
 * The native side (app/src/main/cpp/opencv_self_test.cpp) links the
 * library's vendored OpenCV via find_package(OpenCV) and references both a
 * core symbol (cv::Mat) and cv::Stitcher::create(PANORAMA).  The JNI entry
 * point keeps those references alive (no dead-code elimination).
 *
 * libopencv_java4.so itself is supplied at runtime by the library's AAR;
 * we only need to load our own consumer .so, which depends on it.
 */
object OpenCVSelfTest {
    init {
        // The library's AAR ships libopencv_java4.so; load it first so our
        // consumer .so resolves its cv::* runtime symbols.
        System.loadLibrary("opencv_java4")
        System.loadLibrary("opencv_self_test")
    }

    /** Returns e.g. "OpenCV 4.10.0 | Mat 2x2 | Stitcher=OK". */
    external fun opencvSelfTest(): String
}
