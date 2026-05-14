// retailens_stitcher.cpp — JNI shim exposing cv::Stitcher to the Android
// Kotlin SDK.  Mirrors iOS' OpenCVStitcher.stitchFramePaths so the
// batch-keyframe flow has parity between platforms.
//
// Why this exists
// ───────────────
// OpenCV's official prebuilt Android library (`libopencv_java4.so` from
// opencv.org) ships with the stitching module's symbols STRIPPED.
// Calls into `cv::Stitcher::create()` from Kotlin/Java fail at link time.
// We rebuild OpenCV ourselves with `BUILD_opencv_stitching=ON` to keep
// the C++ symbols in the .so.
//
// We do NOT enable OpenCV's Java auto-binding generator for the
// stitching module (`WRAP python` only in upstream).  OpenCV's
// generator has multiple bugs with the stitching internals (float&
// output params, FeaturesMatcher::operator() scoping, etc.) that the
// upstream team has explicitly avoided by not declaring `WRAP java`.
// Instead, we hand-write JNI entry points here that expose ONLY the
// methods our Kotlin code needs.  Bug-free, audit-friendly,
// maintainable surface area is ~150 lines instead of ~5000 auto-
// generated lines that fight the binding generator.
//
// What this exposes
// ─────────────────
// Single JNI function, mirroring iOS' stitchFramePaths:
//
//   Java_com_retailens_capturesdk_RetaiLensStitcher_nativeStitchFramePaths(
//     framePaths:        String[]   - input JPEG paths in capture order
//     outputPath:        String     - destination JPEG path
//     jpegQuality:       int        - [0..100]
//     warperType:        String     - "plane" | "cylindrical" | "spherical"
//     blenderType:       String     - "multiband" | "feather"
//     seamFinderType:    String     - "graphcut" | "skip" | "voronoi"
//     captureOrientation:String     - "portrait" | "portrait-upside-down"
//                                      | "landscape-left" | "landscape-right"
//     useInscribedRectCrop: boolean - true → inscribed-rect crop,
//                                      false → bboxRect crop only
//   ) returns int[2] {width, height} of the written JPEG
//
// Throws java.lang.RuntimeException on error with a descriptive message.

#include <jni.h>
#include <android/log.h>
#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/stitching.hpp>
#include <opencv2/stitching/detail/blenders.hpp>
#include <opencv2/stitching/detail/seam_finders.hpp>
#include <opencv2/stitching/warpers.hpp>
#include <cstdio>
#include <unistd.h>
#include <string>
#include <vector>


#define LOG_TAG "RetaiLensStitcher.JNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)


namespace {

// Read this process' resident set size (RSS) from /proc/self/statm.
//
// `statm` line is space-separated:
//   total_pages  resident_pages  shared_pages  text_pages  data+stack_pages  ...
//
// We want the second field (resident).  Multiply by page size (4 KB on
// every Android device we ship to) to get bytes.
//
// Returns -1.0 on read failure (very rare — procfs is always mounted
// and the file is always readable by the owning process).
//
// Cheap enough to call inside a hot loop: ~20 µs (the kernel computes
// the values lazily and caches them; the read is essentially a single
// page-aligned copy).  We invoke it at major pipeline phase
// boundaries only — not per Mat allocation — so cost is irrelevant.
//
// Note: this is RSS (resident set), NOT PSS.  PSS requires parsing
// `/proc/self/smaps_rollup` which is ~10× slower.  For diagnostic
// logging in the native stitch path, RSS is the right tradeoff;
// PSS is exposed at the Kotlin layer via the memory-HUD bridge.
double rss_mb() {
    FILE* f = std::fopen("/proc/self/statm", "r");
    if (f == nullptr) return -1.0;
    long size_pages = 0, resident_pages = 0;
    int n = std::fscanf(f, "%ld %ld", &size_pages, &resident_pages);
    std::fclose(f);
    if (n != 2) return -1.0;
    long page_bytes = sysconf(_SC_PAGESIZE);
    return (double) resident_pages * (double) page_bytes / (1024.0 * 1024.0);
}

// Return Mat's data footprint in MB.  Uses Mat::total() and
// Mat::elemSize() so it's correct for any depth/channel combo.
//
// Note: this is the data buffer size only — NOT counting Mat header,
// ROI parents, or refcount metadata.  Cheap.
double mat_mb(const cv::Mat& m) {
    if (m.empty()) return 0.0;
    return (double)(m.total() * m.elemSize()) / (1024.0 * 1024.0);
}


// Convert a UTF-16 jstring to std::string.  Returns empty string for
// nullptr inputs.
std::string jstring_to_string(JNIEnv* env, jstring jstr) {
    if (jstr == nullptr) return std::string();
    const char* cstr = env->GetStringUTFChars(jstr, nullptr);
    std::string result(cstr);
    env->ReleaseStringUTFChars(jstr, cstr);
    return result;
}

// Throw a java.lang.RuntimeException with the given message.  Caller
// must return from JNI after this; the exception is delivered on JNI
// return, not immediately.
void throw_runtime(JNIEnv* env, const std::string& msg) {
    LOGE("%s", msg.c_str());
    jclass cls = env->FindClass("java/lang/RuntimeException");
    if (cls != nullptr) {
        env->ThrowNew(cls, msg.c_str());
    }
}

// Decode warper name → WarperCreator instance.  Returns nullptr for
// unrecognised names.
cv::Ptr<cv::WarperCreator> make_warper(const std::string& name) {
    if (name == "plane")        return cv::makePtr<cv::PlaneWarper>();
    if (name == "cylindrical")  return cv::makePtr<cv::CylindricalWarper>();
    if (name == "spherical")    return cv::makePtr<cv::SphericalWarper>();
    return nullptr;
}

// Decode blender name → Blender instance.  Defaults to MULTI_BAND.
cv::Ptr<cv::detail::Blender> make_blender(const std::string& name) {
    if (name == "feather") {
        return cv::detail::Blender::createDefault(cv::detail::Blender::FEATHER, false);
    }
    return cv::detail::Blender::createDefault(cv::detail::Blender::MULTI_BAND, false);
}

// Decode seam-finder name → SeamFinder instance.  Defaults to GraphCut.
cv::Ptr<cv::detail::SeamFinder> make_seam_finder(const std::string& name) {
    if (name == "skip" || name == "no") {
        return cv::makePtr<cv::detail::NoSeamFinder>();
    }
    if (name == "voronoi") {
        return cv::makePtr<cv::detail::VoronoiSeamFinder>();
    }
    // Default: GraphCut with color-gradient cost — matches iOS
    return cv::makePtr<cv::detail::GraphCutSeamFinder>(
        cv::detail::GraphCutSeamFinder::COST_COLOR_GRAD);
}

// Apply bake-rotation per captureOrientation.  Returns a new Mat (the
// caller owns it).  Rotation table mirrors
// retailens-capture-sdk/ios/Sources/RetaiLensCaptureSDK/OpenCVStitcher.mm:
//
//   portrait              → no rotation
//   portrait-upside-down  → ROTATE_180
//   landscape-left        → ROTATE_90_COUNTERCLOCKWISE
//   landscape-right       → ROTATE_90_CLOCKWISE
//
// AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
cv::Mat bake_rotation(const cv::Mat& src, const std::string& orientation) {
    cv::Mat rotated;
    if (orientation == "landscape-left") {
        cv::rotate(src, rotated, cv::ROTATE_90_COUNTERCLOCKWISE);
        LOGI("bake-rotated 90° CCW for landscape-left (%dx%d → %dx%d)",
             src.cols, src.rows, rotated.cols, rotated.rows);
        return rotated;
    }
    if (orientation == "landscape-right") {
        cv::rotate(src, rotated, cv::ROTATE_90_CLOCKWISE);
        LOGI("bake-rotated 90° CW for landscape-right (%dx%d → %dx%d)",
             src.cols, src.rows, rotated.cols, rotated.rows);
        return rotated;
    }
    if (orientation == "portrait-upside-down") {
        cv::rotate(src, rotated, cv::ROTATE_180);
        LOGI("bake-rotated 180° for portrait-upside-down (%dx%d)",
             src.cols, src.rows);
        return rotated;
    }
    // portrait or unknown: no rotation
    LOGI("no bake-rotation (orientation=%s, %dx%d)",
         orientation.c_str(), src.cols, src.rows);
    return src;
}

// Bbox-only crop: tighten to the non-zero bounding rect of the
// stitched canvas to remove the surrounding black border.
cv::Mat crop_bbox(const cv::Mat& panorama) {
    cv::Mat gray;
    cv::cvtColor(panorama, gray, cv::COLOR_BGR2GRAY);
    cv::Mat mask;
    cv::threshold(gray, mask, 0, 255, cv::THRESH_BINARY);
    cv::Rect bbox = cv::boundingRect(mask);
    if (bbox.width <= 0 || bbox.height <= 0) {
        return panorama;
    }
    return panorama(bbox).clone();
}

}  // namespace


// Negative values mean "use cv::Stitcher's library default".  This
// matches OpenCV's own ORIG_RESOL sentinel for compositing — the
// public API accepts any negative number to opt out and keep the
// default in place.
constexpr double kUseLibraryDefault = -1.0;

extern "C" JNIEXPORT jintArray JNICALL
Java_com_retailens_capturesdk_RetaiLensStitcher_nativeStitchFramePaths(
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
        // V16-followup (Android OOM fix): three new params for
        // cv::Stitcher's staged-resolution pipeline.  Each is a target
        // MEGAPIXEL budget per frame.  Pass a negative value (e.g.
        // -1.0) for any of them to fall back to OpenCV's default.
        //
        //   registrationResolMP — driver downsample for feature
        //     detection / matching / bundle adjustment.  cv::Stitcher
        //     default 0.6 MP.  Lower = faster, more false matches.
        //
        //   seamEstimationResolMP — driver downsample for the seam
        //     finder (GraphCut / Voronoi).  Default 0.1 MP.  GraphCut
        //     is roughly quadratic in pixel count, so going lower is
        //     a big speed/RAM win — at cost of seam precision.
        //
        //   compositingResolMP — THIS IS THE BIG ONE.  cv::Stitcher's
        //     default is ORIG_RESOL (-1.0) = compose at the ORIGINAL
        //     input resolution.  On Android with 1920×1080 sensor
        //     frames, that means MultiBand pyramid + per-frame warp
        //     buffers all run at full res.  3 frames easily blow past
        //     350 MB total native heap and trigger Android lmkd's
        //     foreground-app kill ("vis TOP" classification in
        //     logcat — observed 2026-05-14).  Setting this to 1.0 MP
        //     scales the compositing stage down ~2× per axis on the
        //     A35 (1920×1080 → ~1360×765), cutting compositing-stage
        //     memory by ~4× without a visible quality drop.
        //
        // iOS-parity: iOS hand-rolls the equivalent pipeline at
        // these same target resolutions (see OpenCVStitcher.mm
        // comments around line 600 — "Two-stage resolution pipeline
        // matches cv::Stitcher::PANORAMA: 0.6 MP registration / 0.1
        // MP seam") — but iOS bounds compositing because it owns the
        // pipeline.  Android needs these settings explicitly because
        // it uses the high-level cv::Stitcher::create() API.
        jdouble registrationResolMP,
        jdouble seamEstimationResolMP,
        jdouble compositingResolMP,
        // 2026-05-14 — cv::Stitcher pipeline mode picker.  String
        // values:
        //   "panorama" → cv::Stitcher::PANORAMA  — rotation-only
        //                  pipeline (HomographyBasedEstimator,
        //                  BundleAdjusterRay, SphericalWarper).
        //                  Best for rotate-in-place captures; BAD
        //                  for translation (rotation-only homography
        //                  diverges → 3.2 GB canvas observed 2026-05-14).
        //   "scans"    → cv::Stitcher::SCANS     — translational
        //                  pipeline (AffineBestOf2NearestMatcher,
        //                  BundleAdjusterAffine, PlaneWarper).  Best
        //                  for walk-and-pan shelf captures; canvas
        //                  size bounded by sum of frames.  Slightly
        //                  worse on pure rotation.
        // Caller (RetaiLensIncrementalStitcher.kt) resolves the JS
        // 'auto' setting to a concrete mode before reaching here.
        // Unknown input defaults to SCANS at runtime (the safer
        // choice — bounded canvas, no lmkd-kill risk).
        jstring stitchMode) {

    // ── 1.  Unmarshal Java args ─────────────────────────────────────
    if (framePaths == nullptr) {
        throw_runtime(env, "framePaths is null");
        return nullptr;
    }
    jsize frameCount = env->GetArrayLength(framePaths);
    if (frameCount < 2) {
        throw_runtime(env,
            "Need at least 2 frames to stitch (got " +
            std::to_string(frameCount) + ")");
        return nullptr;
    }

    const std::string outPath        = jstring_to_string(env, outputPath);
    const std::string warperName     = jstring_to_string(env, warperType);
    const std::string blenderName    = jstring_to_string(env, blenderType);
    const std::string seamName       = jstring_to_string(env, seamFinderType);
    const std::string orientationStr = jstring_to_string(env, captureOrientation);
    const std::string stitchModeStr  = jstring_to_string(env, stitchMode);

    // Resolve stitch mode → cv::Stitcher::Mode.  Default SCANS on
    // any unrecognised input (incl. nullptr).  See the arg-doc on
    // `stitchMode` above for why SCANS is the safer default.
    const cv::Stitcher::Mode stitchModeEnum =
        (stitchModeStr == "panorama") ? cv::Stitcher::PANORAMA
                                       : cv::Stitcher::SCANS;

    LOGI("nativeStitchFramePaths: frames=%d warper=%s blender=%s seam=%s "
         "orientation=%s quality=%d inscribedRect=%d stitchMode=%s (enum=%d)",
         frameCount, warperName.c_str(), blenderName.c_str(),
         seamName.c_str(), orientationStr.c_str(),
         jpegQuality, useInscribedRectCrop ? 1 : 0,
         stitchModeStr.c_str(), static_cast<int>(stitchModeEnum));
    LOGI("[memstat] phase=entry rss=%.1f MB", rss_mb());

    // ── 2.  Load input frames ───────────────────────────────────────
    std::vector<cv::Mat> images;
    images.reserve(frameCount);
    double totalInputMB = 0.0;
    for (jsize i = 0; i < frameCount; ++i) {
        jstring jPath = (jstring) env->GetObjectArrayElement(framePaths, i);
        if (jPath == nullptr) {
            throw_runtime(env, "framePaths[" + std::to_string(i) + "] is null");
            return nullptr;
        }
        std::string path = jstring_to_string(env, jPath);
        env->DeleteLocalRef(jPath);

        cv::Mat img = cv::imread(path, cv::IMREAD_COLOR);
        if (img.empty()) {
            throw_runtime(env,
                "Failed to load frame: " + path);
            return nullptr;
        }
        const double mb = mat_mb(img);
        totalInputMB += mb;
        LOGI("[dimstat] input[%d] %dx%d %dch elemSize=%zu data=%.2f MB",
             i, img.cols, img.rows, img.channels(), img.elemSize(), mb);
        images.push_back(std::move(img));
    }
    LOGI("[dimstat] loaded %d frames total_input_data=%.2f MB",
         frameCount, totalInputMB);
    LOGI("[memstat] phase=after_imread rss=%.1f MB", rss_mb());

    // ── 3.  Configure cv::Stitcher ──────────────────────────────────
    //
    // Stitcher mode is supplied by the caller via the `stitchMode` arg
    // and resolved to a `cv::Stitcher::Mode` enum above.  PANORAMA is
    // the cv::Stitcher legacy default that ships with OpenCV; SCANS is
    // a hand-tuned alternative pipeline more suitable for translation-
    // heavy shelf-scanning captures.  When the caller passes "auto"
    // upstream (RetaiLensIncrementalStitcher.finalize), it's resolved
    // to a concrete "panorama" / "scans" string before reaching this
    // JNI based on accumulated pose deltas at capture time.
    cv::Ptr<cv::Stitcher> stitcher;
    try {
        stitcher = cv::Stitcher::create(stitchModeEnum);
    } catch (const cv::Exception& e) {
        throw_runtime(env, std::string("Stitcher::create threw: ") + e.what());
        return nullptr;
    }

    // Warper override only applies to PANORAMA mode.  SCANS mode in
    // cv::Stitcher hard-wires the PlaneWarper internally (the affine
    // pipeline is incoherent with cylindrical/spherical projection —
    // see `2026-05-13-stitcher-pipeline-coherence.md` learning).
    // Skip setWarper() under SCANS to avoid silently breaking the
    // affine BA's assumptions.
    if (stitchModeEnum == cv::Stitcher::PANORAMA) {
        if (auto warper = make_warper(warperName)) {
            stitcher->setWarper(warper);
        }
    } else {
        LOGI("SCANS mode: skipping setWarper (PlaneWarper is hard-wired internally)");
    }
    stitcher->setBlender(make_blender(blenderName));
    stitcher->setSeamFinder(make_seam_finder(seamName));

    // Apply caller-supplied resolution budgets.  Negative => keep
    // cv::Stitcher's library default (which is sensible for
    // registration + seam but pathological for compositing — see the
    // arg doc on compositingResolMP for the OOM rationale).
    if (registrationResolMP > 0.0) {
        stitcher->setRegistrationResol(static_cast<double>(registrationResolMP));
    }
    if (seamEstimationResolMP > 0.0) {
        stitcher->setSeamEstimationResol(static_cast<double>(seamEstimationResolMP));
    }
    if (compositingResolMP > 0.0) {
        stitcher->setCompositingResol(static_cast<double>(compositingResolMP));
    }

    // Log cv::Stitcher's internal resolution settings BEFORE invoking
    // stitch(), so we can correlate logged peak memory with the
    // staging-resolution decisions OpenCV is about to make.  These
    // are PER-FRAME megapixel budgets that drive how each stage
    // downsamples the inputs:
    //   registration_resol — feature detection / matching        (default 0.6 MP)
    //   seam_estimation_resol — GraphCut / seam finding          (default 0.1 MP)
    //   compositing_resol — MultiBand pyramid + final warps      (default ORIG_RESOL = -1.0 = NO downscale)
    // The compositing_resol default of ORIG_RESOL is the OOM
    // trigger on Android: composing at full 1920×1080 inflates the
    // MultiBand pyramid by ~4× vs a 1.0 MP target.
    LOGI("[dimstat] cv::Stitcher resol budgets (per frame, MP):"
         " registration=%.3f seam=%.3f compositing=%.3f%s",
         stitcher->registrationResol(),
         stitcher->seamEstimationResol(),
         stitcher->compositingResol(),
         stitcher->compositingResol() < 0 ? " (ORIG_RESOL = no downscale!)" : "");

    // ── 4.  Stitch ──────────────────────────────────────────────────
    LOGI("[memstat] phase=before_stitch rss=%.1f MB", rss_mb());
    cv::Mat panorama;
    cv::Stitcher::Status status;
    try {
        status = stitcher->stitch(images, panorama);
    } catch (const cv::Exception& e) {
        throw_runtime(env, std::string("Stitcher::stitch threw: ") + e.what());
        return nullptr;
    }
    if (status != cv::Stitcher::OK) {
        throw_runtime(env,
            "Stitcher::stitch failed with status code " +
            std::to_string(static_cast<int>(status)));
        return nullptr;
    }
    LOGI("[dimstat] post-stitch panorama %dx%d %dch data=%.2f MB",
         panorama.cols, panorama.rows, panorama.channels(),
         mat_mb(panorama));
    LOGI("[memstat] phase=after_stitch rss=%.1f MB", rss_mb());

    // ── 5.  Crop ────────────────────────────────────────────────────
    // V16 Phase 1b: bbox-only by default (matches iOS' useInscribedRectCrop=false).
    // The inscribed-rect-crop path on iOS is gated behind a settings toggle
    // and rarely produces strictly better output for a 4-6 frame batch
    // capture, so we ship Android-side with bbox-only and skip the
    // inscribed-rect logic for now (can be added later if useful).
    cv::Mat cropped = crop_bbox(panorama);
    LOGI("[dimstat] post-crop_bbox %dx%d → %dx%d data=%.2f MB"
         " (inscribedRect=%d, currently ignored)",
         panorama.cols, panorama.rows, cropped.cols, cropped.rows,
         mat_mb(cropped),
         useInscribedRectCrop ? 1 : 0);
    LOGI("[memstat] phase=after_crop rss=%.1f MB", rss_mb());

    // ── 6.  Bake rotation ───────────────────────────────────────────
    cv::Mat final_image = bake_rotation(cropped, orientationStr);
    LOGI("[dimstat] post-bake_rotation %dx%d data=%.2f MB",
         final_image.cols, final_image.rows, mat_mb(final_image));
    LOGI("[memstat] phase=after_bake_rotation rss=%.1f MB", rss_mb());

    // ── 7.  Write JPEG ──────────────────────────────────────────────
    int q = std::max(0, std::min(100, static_cast<int>(jpegQuality)));
    std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, q};
    bool wrote;
    try {
        wrote = cv::imwrite(outPath, final_image, params);
    } catch (const cv::Exception& e) {
        throw_runtime(env, std::string("cv::imwrite threw: ") + e.what());
        return nullptr;
    }
    if (!wrote) {
        throw_runtime(env, "cv::imwrite failed (path=" + outPath + ")");
        return nullptr;
    }

    LOGI("output written: %s (%dx%d)",
         outPath.c_str(), final_image.cols, final_image.rows);
    LOGI("[memstat] phase=after_imwrite rss=%.1f MB", rss_mb());

    // ── 8.  Return [width, height] to Kotlin ────────────────────────
    jintArray dims = env->NewIntArray(2);
    jint values[2] = { final_image.cols, final_image.rows };
    env->SetIntArrayRegion(dims, 0, 2, values);
    return dims;
}
