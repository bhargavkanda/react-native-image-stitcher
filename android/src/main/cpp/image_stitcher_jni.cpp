// SPDX-License-Identifier: Apache-2.0
//
// image_stitcher_jni.cpp — JNI shim that marshals Java/Kotlin args
// into the shared C++ `retailens::stitchFramePaths` function in
// cpp/stitcher.{hpp,cpp}.
//
// As of 2026-05-15, the algorithm itself lives in shared C++ (used by
// both iOS via Obj-C++ bridge + Android via this JNI shim).  This
// file's job is now ONLY:
//   1. Unmarshal jobjectArray → std::vector<std::string>
//   2. Unmarshal jstring args → StitchConfig
//   3. Plug Android's __android_log_print into the shared LogFn
//   4. Call retailens::stitchFramePaths(...)
//   5. Marshal StitchResult → jintArray for Kotlin
//
// History
// ───────
//
// Before 2026-05-15 commit feature/shared-stitcher-port, this file
// owned the algorithm directly (~600 lines, used cv::Stitcher
// high-level API).  The iOS side owned its own ~3000-line manual
// pipeline.  Moving both behind a shared C++ stitcher eliminates
// the platform divergence.

#include <jni.h>
#include <android/log.h>
#include "stitcher.hpp"

#include <string>
#include <vector>


#define LOG_TAG "BatchStitcher.JNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)


namespace {

std::string jstring_to_string(JNIEnv* env, jstring jstr) {
    if (jstr == nullptr) return std::string();
    const char* cstr = env->GetStringUTFChars(jstr, nullptr);
    std::string result(cstr);
    env->ReleaseStringUTFChars(jstr, cstr);
    return result;
}

void throw_runtime(JNIEnv* env, const std::string& msg) {
    LOGE("%s", msg.c_str());
    jclass cls = env->FindClass("java/lang/RuntimeException");
    if (cls != nullptr) {
        env->ThrowNew(cls, msg.c_str());
    }
}

// Bridge the shared LogFn to __android_log_print so the shared C++
// stitcher's [stitch]/[dimstat]/[memstat] log lines flow into logcat
// under the same LOG_TAG the previous owner used.
void androidLogBridge(int level, const char* tag, const char* msg) {
    int prio = (level == 2) ? ANDROID_LOG_ERROR
             : (level == 1) ? ANDROID_LOG_WARN
                            : ANDROID_LOG_INFO;
    __android_log_print(prio, LOG_TAG, "%s %s", tag ? tag : "", msg ? msg : "");
}

}  // namespace


extern "C" JNIEXPORT jintArray JNICALL
Java_io_imagestitcher_rn_BatchStitcher_nativeStitchFramePaths(
        JNIEnv* env,
        jobject /*thiz*/,
        jobjectArray framePaths,
        jstring outputPath,
        jint jpegQuality,
        jstring warperType,
        jstring blenderType,
        jstring seamFinderType,
        jstring captureOrientation,
        jboolean useInscribedRectCrop,
        jdouble registrationResolMP,
        jdouble seamEstimationResolMP,
        jdouble compositingResolMP,
        jstring stitchModeStr) {

    if (framePaths == nullptr) {
        throw_runtime(env, "framePaths is null");
        return nullptr;
    }
    const jsize frameCount = env->GetArrayLength(framePaths);
    std::vector<std::string> paths;
    paths.reserve(frameCount);
    for (jsize i = 0; i < frameCount; ++i) {
        jstring jPath = (jstring) env->GetObjectArrayElement(framePaths, i);
        if (jPath == nullptr) {
            throw_runtime(env, "framePaths[" + std::to_string(i) + "] is null");
            return nullptr;
        }
        paths.push_back(jstring_to_string(env, jPath));
        env->DeleteLocalRef(jPath);
    }

    // Build the shared StitchConfig.
    retailens::StitchConfig cfg;
    cfg.warperType           = jstring_to_string(env, warperType);
    cfg.blenderType          = jstring_to_string(env, blenderType);
    cfg.seamFinderType       = jstring_to_string(env, seamFinderType);
    cfg.captureOrientation   = jstring_to_string(env, captureOrientation);
    cfg.useInscribedRectCrop = useInscribedRectCrop;
    cfg.registrationResolMP  = registrationResolMP;
    cfg.seamEstimationResolMP = seamEstimationResolMP;
    cfg.compositingResolMP   = compositingResolMP;
    cfg.jpegQuality          = jpegQuality;
    const std::string modeStr = jstring_to_string(env, stitchModeStr);
    cfg.stitchMode = (modeStr == "panorama")
        ? retailens::StitchMode::Panorama
        : retailens::StitchMode::Scans;

    // 2026-06-07 — unify on the manual cv::detail pipeline.  It won the
    // on-device A/B: equals the high-level cv::Stitcher on quality after
    // parity AND is strictly more robust — the cylindrical fallback, warp
    // guard, and exposure comp all live only in the manual path, so the
    // high-level path garbages wide/0.5x captures.  Mirrors iOS'
    // OpenCVStitcher.mm.  See docs/stitch-pipeline-architecture.md §7.
    cfg.useManualPipeline = true;
    // Match iOS' parity resolution: the manual entry's default registration
    // is 0.3 MP (vs the high-level's 0.6); bump to 0.6 unless the caller set
    // an explicit value.  (compositingResolMP already arrives as 1.0.)
    if (cfg.registrationResolMP <= 0.0) {
        cfg.registrationResolMP = 0.6;
    }

    const std::string outPath = jstring_to_string(env, outputPath);

    retailens::StitchResult result = retailens::stitchFramePaths(
        paths, outPath, cfg, &androidLogBridge);

    if (!result.success) {
        const std::string msg = "Stitch failed: " + result.errorMessage +
            " (code=" + std::to_string(static_cast<int>(result.errorCode)) + ")";
        throw_runtime(env, msg);
        return nullptr;
    }

    // Return [width, height, framesRequested, framesIncluded, finalThresholdMilli]
    // — same JNI return layout as the previous file (Kotlin already
    // parses indices 0-4).  The threshold is multiplied by 1000 +
    // rounded to int since IntArray can't hold doubles.
    jintArray dims = env->NewIntArray(5);
    jint values[5] = {
        result.width,
        result.height,
        result.framesRequested,
        result.framesIncluded,
        static_cast<jint>(result.finalConfidenceThresh * 1000.0),
    };
    env->SetIntArrayRegion(dims, 0, 5, values);
    return dims;
}
