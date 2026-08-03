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
#include <cstdio>    // /proc/self/statm read for the purge diagnostic
#include <unistd.h>  // sysconf — device RAM for the manual-pipeline budget
#include <dlfcn.h>   // dlsym — resolve mallopt() at runtime (API-gated; see below)

// M_PURGE (release free pages back to the OS) was added to bionic at API 28;
// define it for our minSdk-24 build (a harmless no-op on the older allocator).
#ifndef M_PURGE
#define M_PURGE (-101)
#endif


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

// 2026-06-15 — last successful stitch's debugSummary (pipe/warp/route/seam/blend).
// The nativeStitchFramePaths return is a jintArray which can't carry a string,
// so we stash it here and expose it via the lightweight nativeLastDebugSummary()
// getter that Kotlin calls right after a successful stitch (same thread → no
// concurrency).  Mirrors the iOS RNStitchResult.debugSummary surface so the DEV
// overlay shows warp/route/seam/blend on Android too, not just mode/score.
std::string g_lastDebugSummary;

// Return the just-finished stitch's freed native memory to the OS.  cv::Mat /
// the OpenCV allocator keep freed blocks in a process-wide pool, so without this
// the native-heap RSS baseline ratchets up ~10-15 MB per capture (dumpsys showed
// the creep in Native Heap, not Graphics).  mallopt() was exported by bionic at
// API 26 but our minSdk is 24, so resolve it at runtime via dlsym and call only
// when present (it is on every API-26+ device, including the test A35).
double procRssMB() {
    FILE* f = fopen("/proc/self/statm", "r");
    if (f == nullptr) return -1.0;
    long sizePages = 0, residentPages = 0;
    const int n = fscanf(f, "%ld %ld", &sizePages, &residentPages);
    fclose(f);
    if (n != 2) return -1.0;
    return static_cast<double>(residentPages)
        * static_cast<double>(sysconf(_SC_PAGE_SIZE)) / (1024.0 * 1024.0);
}

// Returns the POST-purge RSS in MB (the leak-plateau "floor"), or -1 when the
// diagnostic reads are gated off.  The mallopt(M_PURGE) CALL is UNCONDITIONAL —
// it's the leak fix; only its before/after READS + the log are gated (3A), so a
// release build pays nothing while debug builds surface memFloor.
double purgeNativeAllocator(bool profiling) {
    using MalloptFn = int (*)(int, int);
    // Resolve mallopt at runtime (API-26 symbol; minSdk 24).  Prefer an explicit
    // libc.so handle — RTLD_DEFAULT from a dlopen'd .so doesn't always reach
    // libc on Android — then fall back to RTLD_DEFAULT.
    static MalloptFn fn = []() -> MalloptFn {
        void* h = dlopen("libc.so", RTLD_NOLOAD | RTLD_NOW);
        void* s = (h != nullptr) ? dlsym(h, "mallopt") : nullptr;
        if (s == nullptr) s = dlsym(RTLD_DEFAULT, "mallopt");
        return reinterpret_cast<MalloptFn>(s);
    }();
    const double before = profiling ? procRssMB() : -1.0;
    if (fn != nullptr) fn(M_PURGE, 0);          // the fix — always runs
    if (!profiling) return -1.0;
    const double after = procRssMB();
    // Diagnostic: shows whether mallopt resolved and how much RSS the purge
    // actually returned to the OS.  If mallopt=MISSING → dlsym failed; if
    // resolved but before≈after → the residual isn't allocator-retained (real
    // leak) and M_PURGE can't help.
    LOGI("[memstat] purge: mallopt=%s rss %.1f -> %.1f MB",
         (fn != nullptr) ? "ok" : "MISSING", before, after);
    return after;  // memFloor — the post-purge plateau metric
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
        jstring stitchModeStr,
        jboolean useManualPipeline,
        jint rangeMatcherWidth,
        jint numThreads) {

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

    // 2026-06-15 — pipeline is caller-selectable (mirrors iOS).  The batch
    // finalize passes useManualPipeline=true: ALL the memory/OOM hardening
    // lives on the manual path (PreStitchMemoryAbort, RAM-aware canvas-budget
    // downscale, STREAM/BATCH held-set routing, the black-canvas utilization
    // guard); the high-level cv::Stitcher path calls NONE of it — so manual is
    // both the preferred output AND the memory-safe one.  The on-demand
    // HIGH-LEVEL preview tab calls refinePanorama with useManualPipeline=false
    // to re-stitch the captured keyframes via stock cv::Stitcher.
    //
    // WARPER: NOT hardcoded — cfg.warperType carries the caller's choice (set
    // above from the JS `warperType`, which defaults to "spherical" and is
    // settable via the ⚙️ panel / the host's `defaultWarper` prop).  The JS
    // default is the single source of truth now (mirrors iOS).  Choosing "plane"
    // re-arms the manual pipeline's dynamic plane→spherical fallback/divergence
    // switch (they only fire when warperType != "spherical").
    cfg.useManualPipeline = (useManualPipeline == JNI_TRUE);
    // perf-3b — PANORAMA attempt-1 range matcher width (0 = off).
    cfg.rangeMatcherWidth = rangeMatcherWidth;
    // perf-3b item 1 — OpenCV thread count (0 = auto-multi, 1 = single).
    cfg.numThreads = numThreads;
    // 2026-06-16 — memory profiling (DEV).  Gated by the compile flag (debug-on,
    // release-off); Android leaves memProbeFn null so rss_mb() uses /proc.
    cfg.enableMemoryProfiling = (RNIS_MEMORY_PROFILING != 0);
    if (cfg.warperType.empty()) cfg.warperType = "spherical";
    if (cfg.registrationResolMP <= 0.0) {
        cfg.registrationResolMP = 0.6;
    }
    // Plumb the device's physical RAM so the manual pipeline's memory budget
    // (perProcessMemoryBudgetMB = RAM × 0.42, floored at 900 MB) scales to the
    // ACTUAL device instead of the assumed-4GB fallback (which over-throttles a
    // 6–8 GB phone into STREAM+feather → blurrier).  iOS passes physicalMemory;
    // on Android we read it from sysconf here (no JNI signature change needed).
    if (cfg.availableRamMB <= 0.0) {
        const long pages    = sysconf(_SC_PHYS_PAGES);
        const long pageSize = sysconf(_SC_PAGE_SIZE);
        if (pages > 0 && pageSize > 0) {
            cfg.availableRamMB =
                static_cast<double>(pages) * static_cast<double>(pageSize)
                / (1024.0 * 1024.0);
        }
    }

    const std::string outPath = jstring_to_string(env, outputPath);

    // 2026-06-16 (review #1) — backstop try/catch at the JNI C-ABI boundary.
    // stitchFramePaths now has its own catch ladders (high-level + manual), so
    // this should never fire — but a C++ exception crossing into JNI is UB
    // (std::terminate/SIGABRT), so we NEVER let one through: convert any escape
    // into a Java exception the Kotlin layer can catch.
    retailens::StitchResult result;
    try {
        result = retailens::stitchFramePaths(
            paths, outPath, cfg, &androidLogBridge);
    } catch (const std::exception& e) {
        throw_runtime(env, std::string("native stitch crashed: ") + e.what());
        return nullptr;
    } catch (...) {
        throw_runtime(env, "native stitch crashed (unknown exception)");
        return nullptr;
    }

    // Return the stitch's freed native memory to the OS so the native-heap RSS
    // baseline doesn't ratchet up ~10-15 MB per capture (see purgeNativeAllocator).
    // Applies to BOTH pipelines (they share the OpenCV/bionic allocator).  The
    // post-purge RSS is the leak-plateau "floor" — append it to debugSummary so
    // it rides the existing nativeLastDebugSummary() path to JS (no new bridge).
    const double memFloor = purgeNativeAllocator(RNIS_MEMORY_PROFILING != 0);
    if ((RNIS_MEMORY_PROFILING != 0) && memFloor >= 0.0) {
        char fbuf[40];
        std::snprintf(fbuf, sizeof(fbuf), ";memFloor=%.1f", memFloor);
        if (!result.debugSummary.empty()) result.debugSummary += fbuf;
        // 2026-06-16 — one authoritative per-stitch memory line to logcat (the
        // sampler peak otherwise only rides debugSummary to the on-screen
        // overlay).  pipe/warp/mode lets each line be attributed to a preview
        // tab: pipe=manual warp=plane mode=panorama = "As captured" primary;
        // pipe=highlevel warp=plane = HL·Plane; warp=spherical = HL·Sph;
        // mode=scans = SCANS.  Grep `[memstat] record:` to harvest all of them.
        LOGI("[memstat] record: pipe=%s warp=%s mode=%s before=%.1f peak=%.1f "
             "after=%.1f floor=%.1f src=%s frames=%d/%d",
             cfg.useManualPipeline ? "manual" : "highlevel",
             cfg.warperType.c_str(),
             (result.stitchModeUsed == retailens::StitchMode::Scans)
                 ? "scans" : "panorama",
             result.memBeforeMB, result.memPeakMB, result.memAfterMB, memFloor,
             result.memSource.c_str(),
             result.framesIncluded, result.framesRequested);
    }

    if (!result.success) {
        const std::string msg = "Stitch failed: " + result.errorMessage +
            " (code=" + std::to_string(static_cast<int>(result.errorCode)) + ")";
        throw_runtime(env, msg);
        return nullptr;
    }

    // Stash the run's debugSummary for nativeLastDebugSummary() (jintArray
    // can't carry a string).  Read by Kotlin right after this returns.
    g_lastDebugSummary = result.debugSummary;

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

// Returns the debugSummary of the most recent successful stitch (pipe/warp/
// route/seam/blend).  Kotlin calls this right after nativeStitchFramePaths so
// the value is fresh (stitches are serialized on one background thread).
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_BatchStitcher_nativeLastDebugSummary(
        JNIEnv* env, jobject /*thiz*/) {
    return env->NewStringUTF(g_lastDebugSummary.c_str());
}
