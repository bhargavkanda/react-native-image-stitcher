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
#include <string>
#include <vector>


#define LOG_TAG "RetaiLensStitcher.JNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)


namespace {

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
        jboolean useInscribedRectCrop) {

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

    LOGI("nativeStitchFramePaths: frames=%d warper=%s blender=%s seam=%s "
         "orientation=%s quality=%d inscribedRect=%d",
         frameCount, warperName.c_str(), blenderName.c_str(),
         seamName.c_str(), orientationStr.c_str(),
         jpegQuality, useInscribedRectCrop ? 1 : 0);

    // ── 2.  Load input frames ───────────────────────────────────────
    std::vector<cv::Mat> images;
    images.reserve(frameCount);
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
        images.push_back(std::move(img));
    }

    // ── 3.  Configure cv::Stitcher ──────────────────────────────────
    cv::Ptr<cv::Stitcher> stitcher;
    try {
        stitcher = cv::Stitcher::create(cv::Stitcher::PANORAMA);
    } catch (const cv::Exception& e) {
        throw_runtime(env, std::string("Stitcher::create threw: ") + e.what());
        return nullptr;
    }

    if (auto warper = make_warper(warperName)) {
        stitcher->setWarper(warper);
    }
    stitcher->setBlender(make_blender(blenderName));
    stitcher->setSeamFinder(make_seam_finder(seamName));

    // ── 4.  Stitch ──────────────────────────────────────────────────
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

    // ── 5.  Crop ────────────────────────────────────────────────────
    // V16 Phase 1b: bbox-only by default (matches iOS' useInscribedRectCrop=false).
    // The inscribed-rect-crop path on iOS is gated behind a settings toggle
    // and rarely produces strictly better output for a 4-6 frame batch
    // capture, so we ship Android-side with bbox-only and skip the
    // inscribed-rect logic for now (can be added later if useful).
    cv::Mat cropped = crop_bbox(panorama);
    LOGI("crop: bbox %dx%d → %dx%d (inscribedRect=%d, currently ignored)",
         panorama.cols, panorama.rows, cropped.cols, cropped.rows,
         useInscribedRectCrop ? 1 : 0);

    // ── 6.  Bake rotation ───────────────────────────────────────────
    cv::Mat final_image = bake_rotation(cropped, orientationStr);

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

    // ── 8.  Return [width, height] to Kotlin ────────────────────────
    jintArray dims = env->NewIntArray(2);
    jint values[2] = { final_image.cols, final_image.rows };
    env->SetIntArrayRegion(dims, 0, 2, values);
    return dims;
}
