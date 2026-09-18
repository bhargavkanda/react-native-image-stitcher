// SPDX-License-Identifier: Apache-2.0
//
// panoplus_jni.cpp — the pano+ half of the JNI shim, compiled into
// libimage_stitcher_panoplus.so.
//
// ⚠ SPLIT OUT OF A LARGER JNI TRANSLATION UNIT in the host's private plugin
// overlay. That file held four regions, and the pano+ entries were TWO blocks
// straddling one that did not come across. This file is those two blocks,
// reassembled in their original order, plus the file-local helpers they need.
//
// WHAT WAS DUPLICATED RATHER THAN MOVED, and why each one:
//   · jstring_to_string / procRssMB / purgeNativeAllocator — anonymous
//     namespace, internal linkage, called from every region. Copying an
//     internal-linkage helper creates no symbol either half can see.
//   · newJsonString / jsonError / describeException — same, second helper
//     block. `nowMs` did NOT come: its only callers were in a region that
//     stayed behind.
//   · the RNIS_MEMORY_PROFILING gate — see the comment on it below.
// `throw_runtime`, `androidLogBridge` and the three g_last*Message globals did
// NOT come either: none of them has a pano+ caller.
//
// ⚠ THE SIX PanoPlusLiveNative_nativeLive* ENTRIES AT THE BOTTOM ARE THE
// FRAGILE PART OF THIS FILE. They are the last region of the original, they sit
// after a region that stayed behind, and nothing in the host test suite, the
// replay ledger or a device install touches them — so a cut that dropped or
// stranded them passes every other check. Their Kotlin caller loads
// "image_stitcher_panoplus" (PanoPlusLiveNative.kt), and the JNI symbol encodes the Kotlin
// package, so moving that class between packages breaks the binding even if the
// C++ is correct.
//
// JNI LOCAL-REF DISCIPLINE (carried from the original): every
// GetObjectArrayElement ref is DeleteLocalRef'd inside its loop — a 100+-shot
// pass would otherwise exhaust the 512-entry local-ref table.


#include <jni.h>
#include <android/log.h>

// ── HALF-NEUTRAL: belongs to neither half — see cpp/rnis_jni_utf8.hpp ──────
#include "rnis_jni_utf8.hpp"

// ── PANO-BOUND ─────────────────────────────────────────────────────────────
#include "rnis_pano.hpp"
#include "rnis_pano_android_basis.hpp"
#include "rnis_pano_android_report.hpp"
#include "rnis_pano_android_s1.hpp"
#include "rnis_pano_attitude.hpp"   // basisCandidateCount() — the linkage probe
#include "rnis_pano_live.hpp"    // the LIVE session — engine ingest during the sweep
#include "rnis_pano_replay.hpp"

#include <memory>     // shared_ptr — the process-wide live pano+ session
#include <mutex>
#include <shared_mutex> // lifecycle vs frame path; see the pano+ LIVE block
#include <string>
#include <vector>
#include <cmath>     // isfinite — a NaN option must be dropped, not passed on
#include <cstdio>    // /proc/self/statm read for the purge diagnostic
#include <unistd.h>  // sysconf — page size for the RSS read
#include <dlfcn.h>   // dlsym — resolve mallopt() at runtime (API-gated; see below)

// M_PURGE (release free pages back to the OS) was added to bionic at API 28;
// define it for our minSdk-24 build (a harmless no-op on the older allocator).
#ifndef M_PURGE
#define M_PURGE (-101)
#endif

// ⚠ COPIED FROM THE HOST OVERLAY'S CORE HEADER, NOT INCLUDED FROM IT.
// That header belongs to the other half of the split and this translation
// unit must not reach into it — that is the whole point. But the macro is
// used in a C++ EXPRESSION below (purgeNativeAllocator(RNIS_MEMORY_PROFILING
// != 0)), not in an #if, so it cannot simply be left undefined: the compile
// fails with "use of undeclared identifier".
//
// Keep the same name and the same defaulting as the private copy, so one
// build-system -D governs both. It gates LOCAL diagnostics only — there is no
// linkage through it, so two definitions cannot disagree in a way that reaches
// a symbol.
#ifndef RNIS_MEMORY_PROFILING
#  ifdef NDEBUG
#    define RNIS_MEMORY_PROFILING 0
#  else
#    define RNIS_MEMORY_PROFILING 1
#  endif
#endif

// Names the LIBRARY, not a module: this translation unit hosts symbols for
// three Kotlin classes across two RN module ids, so tagging it with one of
// them would send anyone filtering logcat to the wrong place.
#define LOG_TAG "RNSSweep.JNI"
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

// Post-purge RSS in MB for the diagnostic log, or -1 when gated off.
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

// Return the just-finished stitch's freed native memory to the OS.  cv::Mat /
// the OpenCV allocator keep freed blocks in a process-wide pool; without this
// the native-heap RSS baseline ratchets up ~10-15 MB per capture.  The
// mallopt(M_PURGE) CALL is UNCONDITIONAL — it's the leak fix; only its
// before/after READS + the log are gated, so a release build pays nothing.
double purgeNativeAllocator(bool profiling) {
    using MalloptFn = int (*)(int, int);
    // Resolve mallopt at runtime (API-26 symbol; minSdk 24).  Prefer an
    // explicit libc.so handle — RTLD_DEFAULT from a dlopen'd .so doesn't
    // always reach libc on Android — then fall back to RTLD_DEFAULT.
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
    LOGI("[memstat] purge: mallopt=%s rss %.1f -> %.1f MB",
         (fn != nullptr) ? "ok" : "MISSING", before, after);
    return after;
}

}  // namespace

// ════════════════════════════════════════════════════════════════════════════
//  pano+ ANDROID PORT — the engine, reachable from the app
// ════════════════════════════════════════════════════════════════════════════
//
// FOUR entries, all owned by PanoPlusAndroidModule (a DIFFERENT Kotlin class
// from StitchPluginsModule above, so a different JNI symbol prefix), and all
// returning ONE JSON STRING rather than the jdoubleArray + last-message-getter
// pair the stitch entries use.
//
// ⚠ WHY THE SHAPE DIFFERS FROM ITS NEIGHBOURS ABOVE, DELIBERATELY.  A stitch
// returns seven fixed scalars, which is what jdoubleArray is good at.  A replay
// report is ~70 heterogeneous fields including string lists, per-outcome
// counts and a first-divergence detail; marshalling that as a flat double array
// would need a length convention on both sides of the boundary, and every field
// added later would be an off-by-one nobody can see.  The C++ side already
// hand-writes its own JSON (`rnis::pano::replay::reportToJson`, pinned by the
// host gtest suite), so the string IS the marshalling and this file adds none.
//
// ⚠ NOTHING HERE THROWS INTO JAVA.  The stitch entries above use throw_runtime
// for programming errors, which is right when the caller is a Kotlin method
// that will catch it. These three are the DEVICE-LESS port's only observable:
// a thrown exception on a phone in an aisle reports nothing at all, and the
// whole point of the panel is to answer hardware questions in one session. So
// every failure — a null argument, a C++ exception, an OOM — comes back as a
// JSON object carrying `"ok": false` and an `"error"` that names what happened.
// The Kotlin side always gets a parseable payload.
//
// REACHABILITY: these entries are also what PULLS the pano objects into the .so.
// The engine sources compile clean but were dropped as unreferenced under
// -fvisibility=hidden until something called them.
//
// ⚠ THE OBVIOUS CHECK IS A GUARANTEED FALSE NEGATIVE, and this comment used to
// prescribe it. `nm -D` lists only DYNAMIC symbols; -fvisibility=hidden makes
// every pano symbol local, so `nm -DC … | grep -c "rnis::pano"` answers 0 on a
// PERFECTLY HEALTHY build — measured on the arm64-v8a debug artifact:
// `nm -C` 513, `nm -DC` 0. Anyone treating that zero as a verdict declares a
// working port broken, or "fixes" the visibility settings and exports the whole
// engine. Use the local symbols, on the PRE-STRIP artifact:
//
//   nm -C android/build/intermediates/cxx/Debug/*/obj/arm64-v8a/libimage_stitcher_panoplus.so \
//     | grep -c "rnis::pano"          # must be > 0
//
// The shipping artifact under stripped_native_libs/ answers 0 to BOTH forms —
// it is stripped, which is the intent, not a defect.
//
// And a symbol count is only evidence about LINKING. The runtime proof that the
// engine in this .so is the engine the port was written against is the
// engineInfo entry's own self-test (`basisSelfTestPassed` / `outcomeProbe`
// below), which calls into rnis_pano.cpp and compares its answer with the value
// iOS measured. That is what the panel's step 1 renders, and it is the check to
// trust when the two disagree.

namespace {

/// NewStringUTF that cannot hand Java a malformed string, and that answers with
/// a minimal valid JSON error object rather than null when even that fails.
///
/// The sanitiser itself lives in cpp/rnis_jni_utf8.cpp, host-tested, for the
/// same reason the JSON writers do: it guards a CheckJNI ABORT (an app kill,
/// not an exception), and logic that must be right does not belong in the one
/// translation unit in this repo that no test can reach.
///
/// ⚠ IT IS IN A NEUTRAL NAMESPACE (`rnis::jniutil`) ON PURPOSE. It used to be
/// `rnis::pano::android::`, which meant THIS function — reached by another
/// consumer's whole JSON return path — ran through a pano translation unit.
/// Keep it in its own namespace; it is deliberately owned by neither caller.
jstring newJsonString(JNIEnv* env, const std::string& json) {
    const std::string safe = rnis::jniutil::sanitizeForModifiedUtf8(json);
    jstring s = env->NewStringUTF(safe.c_str());
    if (s != nullptr) return s;
    // NewStringUTF returning null means an OOM is pending; clear it so the
    // caller is not handed a live exception alongside a return value, and try
    // once with a payload small enough that it should not fail.
    if (env->ExceptionCheck()) env->ExceptionClear();
    return env->NewStringUTF(
        "{\"ok\":false,\"error\":\"native could not allocate the JSON result\"}");
}

/// A JSON error object with the same `ok`/`error` shape every entry here
/// returns, so the Kotlin side has exactly one payload contract.
std::string jsonError(const std::string& what) {
    std::string s = "{\"ok\":false,\"error\":\"";
    for (size_t i = 0; i < what.size(); ++i) {
        const unsigned char c = (unsigned char)what[i];
        switch (c) {
            case '"':  s += "\\\""; break;
            case '\\': s += "\\\\"; break;
            case '\n': s += "\\n";  break;
            case '\r': s += "\\r";  break;
            case '\t': s += "\\t";  break;
            default:
                if (c < 0x20) s += ' '; else s += (char)c;
        }
    }
    s += "\"}";
    return s;
}

std::string describeException(const std::exception& e, const char* where) {
    return std::string(where) + " threw: " + (e.what() != nullptr ? e.what() : "(no what)");
}

}  // namespace

// ── Is the pano+ engine actually in this .so, and does it run here? ─────────
//
// The FIRST thing the operator presses, and the only one that needs no
// arguments, no permission and no pack. It calls into all four pano translation
// units so that a linkage fault names itself here rather than surfacing as a
// mysterious empty replay report:
//
//   · rnis_pano.cpp            → outcomeName()          (the ENGINE object)
//   · rnis_pano_attitude.cpp   → basisCandidateCount()  (the 24-candidate table)
//   · rnis_pano_android_basis.cpp / _report.cpp → the derivation + its JSON
//
// `engineVersion` is a header constant, so on its own it would prove only that
// the header was included; `outcomeProbe` is a call into rnis_pano.cpp's own
// object file and is the field that actually proves the engine linked.
//
// `basisSelfTest` re-runs the derivation for the configuration iOS MEASURED as
// basis 8 (rnis_pano_android_basis_test.cpp's load-bearing case). A device that
// answers anything other than 8 has a toolchain difference the host tests
// cannot see, and the whole port is suspect — so the expected value travels in
// the payload beside the observed one rather than living in a comment.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusAndroidModule_nativePanoEngineInfo(
        JNIEnv* env, jobject /*thiz*/) {
    std::string s;
    try {
        const char* outcome = rnis::pano::outcomeName(rnis::pano::Outcome::Painted);
        const int candidates = rnis::pano::basisCandidateCount();

        rnis::pano::android::BasisRequest req;
        req.sensorOrientationDeg = 90;
        req.facing = rnis::pano::android::LensFacing::Back;
        req.recorder = rnis::pano::android::RecorderRotation::RawSensorBuffer;
        const rnis::pano::android::BasisDerivation d =
            rnis::pano::android::deriveBasis(req);

        s = "{\"ok\":true,\"error\":\"\",\"engineVersion\":";
        s += std::to_string(rnis::pano::kEngineVersion);
        s += ",\"outcomeProbe\":\"";
        s += (outcome != nullptr ? outcome : "");
        s += "\",\"basisCandidateCount\":";
        s += std::to_string(candidates);
        s += ",\"basisSelfTestIndex\":";
        s += std::to_string(d.index);
        s += ",\"basisSelfTestExpected\":8";
        s += ",\"basisSelfTestPassed\":";
        s += (d.index == 8 ? "true" : "false");
        s += ",\"basisProvenance\":\"";
        s += rnis::pano::android::derivedBasisProvenanceName();
        s += "\"}";
    } catch (const std::exception& e) {
        s = jsonError(describeException(e, "nativePanoEngineInfo"));
    } catch (...) {
        s = jsonError("nativePanoEngineInfo threw an unknown native error");
    }
    return newJsonString(env, s);
}


// ── Derive the IMU→camera basis C from the device's own characteristics ─────
//
// All arguments are RAW Camera2 values, passed through without a translation
// table that could drift from the constants (see the LensFacing note in
// rnis_pano_android_basis.hpp — Camera2 and the legacy Camera API disagree by a
// SWAP, and a shim that "helpfully" remapped them would silently derive the
// front basis for a back sweep).
//
// `lensPoseQuat` is null when the HAL publishes no LENS_POSE_ROTATION, and 4
// doubles [x,y,z,w] when it does. `referenceBasisIndex` is < 0 when there is
// nothing to compare against; ≥ 0 asks for the derived-vs-measured diagnosis.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusAndroidModule_nativeDeriveBasis(
        JNIEnv* env,
        jobject /*thiz*/,
        jint sensorOrientationDeg,
        jint lensFacing,
        jint recorderRotation,
        jint displayRotationDeg,
        jint explicitRotationCwDeg,
        jboolean mirrored,
        jdoubleArray lensPoseQuat,
        jint lensPoseReference,
        jint poseQuatSense,
        jint cameraFrameAdjustIndex,
        jdouble poseThresholdDeg,
        jint referenceBasisIndex) {

    std::string s;
    try {
        namespace ab = rnis::pano::android;
        ab::BasisReportRequest req;

        req.basis.sensorOrientationDeg = (int)sensorOrientationDeg;
        // The enums are range-checked by value, not clamped: an out-of-range
        // int means the Kotlin side read something it should not have, and
        // silently snapping it to Back/RawSensorBuffer would derive a plausible
        // basis for a configuration that does not exist.
        req.basis.facing =
            ((int)lensFacing >= 0 && (int)lensFacing <= 2)
                ? (ab::LensFacing)(int)lensFacing
                : ab::LensFacing::External;   // always refused, by name
        req.basis.recorder =
            ((int)recorderRotation >= 0 && (int)recorderRotation <= 3)
                ? (ab::RecorderRotation)(int)recorderRotation
                : ab::RecorderRotation::Explicit;
        req.basis.displayRotationDeg = (int)displayRotationDeg;
        req.basis.explicitRotationCwDeg = (int)explicitRotationCwDeg;
        req.basis.mirrored = (mirrored != JNI_FALSE);

        if (lensPoseQuat != nullptr && env->GetArrayLength(lensPoseQuat) == 4) {
            jdouble* q = env->GetDoubleArrayElements(lensPoseQuat, nullptr);
            if (q != nullptr) {
                req.haveLensPose = true;
                for (int k = 0; k < 4; ++k) req.lensPose.q[k] = q[k];
                // JNI_ABORT — read-only; nothing to copy back.
                env->ReleaseDoubleArrayElements(lensPoseQuat, q, JNI_ABORT);
                req.lensPose.reference =
                    ((int)lensPoseReference >= 0 && (int)lensPoseReference <= 3)
                        ? (ab::LensPoseReference)(int)lensPoseReference
                        : ab::LensPoseReference::Undefined;   // refused, by name
                req.lensPose.sense =
                    ((int)poseQuatSense == 1) ? ab::PoseQuatSense::CameraFromDevice
                                              : ab::PoseQuatSense::DeviceFromCamera;
                req.lensPose.cameraFrameAdjustIndex = (int)cameraFrameAdjustIndex;
                req.lensPose.thresholdDeg =
                    (poseThresholdDeg > 0.0) ? (double)poseThresholdDeg
                                             : ab::kDefaultPoseResidualDegThreshold;
            }
            // A failed pin leaves haveLensPose false: the block is reported
            // ABSENT rather than fitted against an uninitialised quaternion.
        }

        if ((int)referenceBasisIndex >= 0) {
            req.haveReferenceIndex = true;
            req.referenceBasisIndex = (int)referenceBasisIndex;
        }

        // buildBasisReport / basisReportToJson are pure and host-tested; the
        // catch below is the C-ABI backstop, not error handling.
        s = ab::basisReportToJson(ab::buildBasisReport(req));
    } catch (const std::exception& e) {
        s = jsonError(describeException(e, "nativeDeriveBasis"));
    } catch (...) {
        s = jsonError("nativeDeriveBasis threw an unknown native error");
    }
    return newJsonString(env, s);
}


// ── Replay a pano+ pack through the engine ──────────────────────────────────
//
// The port's throughput and agreement instrument: it answers "does the engine
// run on this hardware, how many ms is one ingest(), and does it decide what
// iOS decided" from a pack on the device's own storage — no camera, no
// permission, no sweep.
//
// `overrideNames` / `overrideValues` are PARALLEL String[]s carrying the A/B
// knobs (the pair-of-strings surface rnis_pano_replay.hpp chose precisely so
// this boundary needs no per-knob glue). A length mismatch is refused rather
// than truncated: silently dropping the tail would run an arm nobody asked for
// and report it under the name of the one they did.
//
// ⚠ This can run for MINUTES on a 400-frame pack. Kotlin calls it from a
// coroutine on Dispatchers.Default — never the JS thread.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusAndroidModule_nativeReplayPack(
        JNIEnv* env,
        jobject /*thiz*/,
        jstring packDir,
        jstring outDir,
        jint maxFrames,
        jboolean writeCanvas,
        jboolean writeLedger,
        jint canvasQuality,
        jboolean canvasCropPad,
        jboolean useMetaConfig,
        jboolean compareLedger,
        jint frameMissingReportCap,
        jobjectArray overrideNames,
        jobjectArray overrideValues) {

    std::string s;
    try {
        rnis::pano::replay::ReplayOptions opt;
        opt.packDir = jstring_to_string(env, packDir);
        if (opt.packDir.empty()) {
            return newJsonString(env, jsonError("packDir is required"));
        }
        opt.outDir = jstring_to_string(env, outDir);
        opt.maxFrames = (int)maxFrames;
        opt.writeCanvas = (writeCanvas != JNI_FALSE);
        opt.writeLedger = (writeLedger != JNI_FALSE);
        opt.canvasQuality = (int)canvasQuality;
        opt.canvasCropPad = (canvasCropPad != JNI_FALSE);
        opt.useMetaConfig = (useMetaConfig != JNI_FALSE);
        opt.compareLedger = (compareLedger != JNI_FALSE);
        opt.frameMissingReportCap = (int)frameMissingReportCap;

        if (overrideNames != nullptr || overrideValues != nullptr) {
            const jsize nn = (overrideNames != nullptr)
                ? env->GetArrayLength(overrideNames) : 0;
            const jsize nv = (overrideValues != nullptr)
                ? env->GetArrayLength(overrideValues) : 0;
            if (nn != nv) {
                return newJsonString(env, jsonError(
                    "overrideNames/overrideValues length mismatch ("
                    + std::to_string((long)nn) + " vs "
                    + std::to_string((long)nv) + ")"));
            }
            opt.configOverrides.reserve((size_t)nn);
            for (jsize i = 0; i < nn; ++i) {
                // Every GetObjectArrayElement ref is DeleteLocalRef'd inside
                // the loop — the 512-entry local-ref table would otherwise be
                // exhausted by a long override list (the discipline this file's
                // header states for the stitch loops).
                jstring jn = (jstring)env->GetObjectArrayElement(overrideNames, i);
                jstring jv = (jstring)env->GetObjectArrayElement(overrideValues, i);
                const std::string n = jstring_to_string(env, jn);
                const std::string v = jstring_to_string(env, jv);
                if (jn != nullptr) env->DeleteLocalRef(jn);
                if (jv != nullptr) env->DeleteLocalRef(jv);
                // An empty NAME is dropped here; an unknown or unparseable one
                // is passed through so the driver can COUNT it in
                // overridesUnknown / overridesMalformed rather than this shim
                // swallowing it silently.
                if (!n.empty()) opt.configOverrides.push_back(std::make_pair(n, v));
            }
        }

        rnis::pano::replay::ReplayReport report;
        // replayPack documents that it never throws (it catches cv::Exception
        // and std::exception at its own boundary and turns them into
        // report.error), so the catch below is the C-ABI backstop only.
        rnis::pano::replay::replayPack(opt, &report);
        s = rnis::pano::replay::reportToJson(report);

        // A replay decodes hundreds of frames; hand the freed native memory
        // back to the OS on the way out, exactly as the stitch entries do.
        purgeNativeAllocator(RNIS_MEMORY_PROFILING != 0);
    } catch (const std::exception& e) {
        s = jsonError(describeException(e, "nativeReplayPack"));
    } catch (...) {
        s = jsonError("nativeReplayPack threw an unknown native error");
    }
    return newJsonString(env, s);
}


// ── MEASURE the basis from a recorded pack, and falsify the derived one ─────
//
// The other half of `nativeDeriveBasis`. That entry DERIVES `C` from
// SENSOR_ORIENTATION + lens facing; on a device that does not publish
// LENS_POSE_ROTATION — the A35 does not — nothing on the phone can contradict
// it, and `derivedBasisProvenanceName()` exists only so a pack cannot pretend
// otherwise. This entry MEASURES `C` instead, by running the engine's own
// `selectBasis()` over the recorder's `sensors.jsonl` and the ARCore reference
// sidecar `attitude_arcore.jsonl`, and then compares the two.
//
// ⚠ THE MEASURED INDEX WINS WHEN THEY DISAGREE, and the SIZE of the
// disagreement localises the fault: a 90° roll about the optical axis means
// the recorder rotated the buffer without saying so; 180° about X is the
// GL-vs-CV convention error. The report says which; this shim decides nothing.
//
// Seconds, not minutes — it parses two text ledgers and fits 24 candidates
// over a few hundred pairs. Still called off the JS thread, for the same
// reason `nativeReplayPack` is: a diagnostic that can jank the panel is a
// diagnostic the operator stops pressing.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusAndroidModule_nativeArCoreBasisRun(
        JNIEnv* env,
        jobject /*thiz*/,
        jstring packDir,
        jstring imuType,
        jstring refField,
        jdouble tauS,
        jdoubleArray tauCandidatesS,
        jint derivedBasisIndex,
        jdouble sweepSeconds,
        jdouble canvasPxPerDeg) {

    std::string s;
    try {
        namespace ab = rnis::pano::android;
        ab::S1PackRequest req;
        req.packDir = jstring_to_string(env, packDir);
        if (req.packDir.empty()) {
            return newJsonString(env, jsonError("packDir is required"));
        }
        // An EMPTY selector falls back to the header's default rather than
        // being passed through: a `""` row type would match no row at all and
        // the run would report "no IMU samples" for a healthy pack.
        const std::string it = jstring_to_string(env, imuType);
        if (!it.empty()) req.imuType = it;
        const std::string rf = jstring_to_string(env, refField);
        if (!rf.empty()) req.refField = rf;

        req.run.tauS = std::isfinite((double)tauS) ? (double)tauS : 0.0;
        req.run.derivedBasisIndex = (int)derivedBasisIndex;
        if (std::isfinite((double)sweepSeconds) && (double)sweepSeconds > 0.0) {
            req.run.sweepSeconds = (double)sweepSeconds;
        }
        if (std::isfinite((double)canvasPxPerDeg) && (double)canvasPxPerDeg > 0.0) {
            req.run.canvasPxPerDeg = (double)canvasPxPerDeg;
        }

        if (tauCandidatesS != nullptr) {
            const jsize n = env->GetArrayLength(tauCandidatesS);
            if (n > 0) {
                jdouble* p = env->GetDoubleArrayElements(tauCandidatesS, nullptr);
                if (p != nullptr) {
                    req.run.tauCandidatesS.reserve((size_t)n);
                    for (jsize i = 0; i < n; ++i) {
                        // Non-finite offsets are DROPPED here rather than
                        // handed on: basisStability() already skips them, but
                        // it counts only what it tried, and a NaN that reached
                        // it would silently shrink triedOffsets below the
                        // number the caller asked for.
                        if (std::isfinite((double)p[i])) {
                            req.run.tauCandidatesS.push_back((double)p[i]);
                        }
                    }
                    env->ReleaseDoubleArrayElements(tauCandidatesS, p, JNI_ABORT);
                }
            }
        }

        s = ab::s1PackResultToJson(ab::runS1OnPack(req));
    } catch (const std::exception& e) {
        s = jsonError(describeException(e, "nativeArCoreBasisRun"));
    } catch (...) {
        s = jsonError("nativeArCoreBasisRun threw an unknown native error");
    }
    return newJsonString(env, s);
}


// ════════════════════════════════════════════════════════════════════════════
//  The RECORDER's basis lookup — five entries, deliberately not one
// ════════════════════════════════════════════════════════════════════════════
//
// PanoPlusAndroidRecorder writes `q` from TYPE_ROTATION_VECTOR mapped through
// the basis `C`, and to do that it needs four things the engine already owns:
// the DERIVED index for this camera, the derivation's refusal string when it
// refused, the MATRIX for whichever index finally wins, and its LABEL.
//
// ⚠ WHY NOT ONE JSON ENTRY, like every other pano+ entry in this file.  The
// four entries above return a JSON STRING because their caller is
// PanoPlusAndroidModule, whose contract is "the string crosses the bridge and
// JS parses it" — the module deliberately parses nothing.  The RECORDER is not
// a bridge: it would have to READ these values, so a JSON entry here would
// oblige it to grow a JSON PARSER, on the frame path, for four scalars.  Five
// primitively-typed entries are ~10 lines each, individually greppable, and
// each one's Kotlin `external` signature is checked against this file by the
// only thing that can check it — an UnsatisfiedLinkError on the device.
//
// ⚠ AND WHY THE MATRIX IS NOT COMPUTED IN KOTLIN.  The 24 candidates are a
// TABLE (rnis_pano_attitude.cpp), the engine indexes into it, and a Kotlin
// copy would be a second table to keep in step with the first.  When they
// drifted, every pack recorded in between would carry quaternions built on one
// enumeration and replay against the other — a silent 90° roll with no field
// anywhere able to name it.  So `basisMatrix()` is asked, never reimplemented.
//
// `deriveBasis` is PURE and deterministic (its header says so), which is what
// makes calling it twice — once for the index, once for the refusal — a
// non-issue rather than a smell.

namespace {

/// Shared by the two derive entries below: build the request from RAW Camera2
/// values, exactly as `nativeDeriveBasis` does, with the same refuse-don't-clamp
/// treatment of out-of-range enums.
rnis::pano::android::BasisRequest recorderBasisRequest(
        jint sensorOrientationDeg,
        jint lensFacing,
        jint recorderRotation,
        jint displayRotationDeg,
        jint explicitRotationCwDeg,
        jboolean mirrored) {
    namespace ab = rnis::pano::android;
    ab::BasisRequest req;
    req.sensorOrientationDeg = (int)sensorOrientationDeg;
    req.facing = ((int)lensFacing >= 0 && (int)lensFacing <= 2)
                     ? (ab::LensFacing)(int)lensFacing
                     : ab::LensFacing::External;          // always refused, by name
    req.recorder = ((int)recorderRotation >= 0 && (int)recorderRotation <= 3)
                       ? (ab::RecorderRotation)(int)recorderRotation
                       : ab::RecorderRotation::Explicit;
    req.displayRotationDeg = (int)displayRotationDeg;
    req.explicitRotationCwDeg = (int)explicitRotationCwDeg;
    req.mirrored = (mirrored != JNI_FALSE);
    return req;
}

}  // namespace

/// The derived index, or −1 when the derivation refused.
extern "C" JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusNativeBasis_nativePanoDeriveBasisIndex(
        JNIEnv* /*env*/,
        jobject /*thiz*/,
        jint sensorOrientationDeg,
        jint lensFacing,
        jint recorderRotation,
        jint displayRotationDeg,
        jint explicitRotationCwDeg,
        jboolean mirrored) {
    try {
        const rnis::pano::android::BasisDerivation d =
            rnis::pano::android::deriveBasis(recorderBasisRequest(
                sensorOrientationDeg, lensFacing, recorderRotation,
                displayRotationDeg, explicitRotationCwDeg, mirrored));
        // `ok` and `index` are separate fields in the C++ struct on purpose;
        // honour that here rather than trusting `index` alone.
        return d.ok ? (jint)d.index : (jint)-1;
    } catch (...) {
        return (jint)-1;
    }
}

/// `BasisDerivation::refusal` — `"none"` on success, a stable
/// lowercase-hyphen reason otherwise. The pack quotes it verbatim so a sweep
/// that fell back to identity says WHICH refusal put it there.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusNativeBasis_nativePanoDeriveBasisRefusal(
        JNIEnv* env,
        jobject /*thiz*/,
        jint sensorOrientationDeg,
        jint lensFacing,
        jint recorderRotation,
        jint displayRotationDeg,
        jint explicitRotationCwDeg,
        jboolean mirrored) {
    const char* r = "native-threw";
    try {
        const rnis::pano::android::BasisDerivation d =
            rnis::pano::android::deriveBasis(recorderBasisRequest(
                sensorOrientationDeg, lensFacing, recorderRotation,
                displayRotationDeg, explicitRotationCwDeg, mirrored));
        r = (d.refusal != nullptr) ? d.refusal : "unreported";
    } catch (...) {
        r = "native-threw";
    }
    jstring s = env->NewStringUTF(r);
    if (s == nullptr && env->ExceptionCheck()) env->ExceptionClear();
    return s;
}

/// `rnis::pano::basisMatrix(index)` — 9 doubles, row-major, or NULL when the
/// index is not one of this engine's candidates. NULL is the caller's
/// validity test: an index the engine cannot look up is not an index.
extern "C" JNIEXPORT jdoubleArray JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusNativeBasis_nativePanoBasisMatrix(
        JNIEnv* env, jobject /*thiz*/, jint index) {
    double m[9];
    try {
        if (!rnis::pano::basisMatrix((int)index, m)) return nullptr;
    } catch (...) {
        return nullptr;
    }
    jdoubleArray out = env->NewDoubleArray(9);
    if (out == nullptr) {
        if (env->ExceptionCheck()) env->ExceptionClear();
        return nullptr;
    }
    env->SetDoubleArrayRegion(out, 0, 9, m);
    return out;
}

/// The engine's OWN label (`+x+y+z`, `-y+x+z`, …). Never a locally invented
/// string: the pack's label and the engine's index must name one thing.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusNativeBasis_nativePanoBasisLabel(
        JNIEnv* env, jobject /*thiz*/, jint index) {
    const char* l = "invalid";
    try {
        const char* got = rnis::pano::basisLabel((int)index);
        if (got != nullptr) l = got;
    } catch (...) {
        l = "invalid";
    }
    jstring s = env->NewStringUTF(l);
    if (s == nullptr && env->ExceptionCheck()) env->ExceptionClear();
    return s;
}

/// `rnis::pano::basisCandidateCount()` — 24, read from the engine rather than
/// hardcoded in Kotlin, so an operator-supplied index is range-checked against
/// the enumeration this build actually links.
extern "C" JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusNativeBasis_nativePanoBasisCandidateCount(
        JNIEnv* /*env*/, jobject /*thiz*/) {
    try {
        return (jint)rnis::pano::basisCandidateCount();
    } catch (...) {
        return (jint)0;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  pano+ LIVE — the engine ingesting DURING the sweep
// ════════════════════════════════════════════════════════════════════════════
//
// The Android leg's missing arm.  Everything above this block is
// RECORD-then-REPLAY: `PanoPlusAndroidRecorder` writes JPEGs and a track
// ledger, and `nativeReplayPack` runs the engine over them afterwards.  These
// SIX entries let the same recorder feed the SAME engine while the operator
// is still sweeping, so the canvas grows on screen instead of appearing
// minutes later.
//
// ── OWNERSHIP: ONE SESSION, PROCESS-WIDE ────────────────────────────────────
//
// There is exactly one back camera and therefore exactly one sweep, so the
// session is a singleton here — the same shape `RNISPanoCore` has on iOS (all
// class methods over one static session).  Kotlin holds no pointer: a handle
// crossing the bridge would be a use-after-free waiting for the first reload,
// and RN reloads modules while native state survives.
//
// ── THE LOCK, AND WHY IT IS A shared_mutex ──────────────────────────────────
//
// `rnis::pano::live::Session` is documented as safe for concurrent
// `ingest` / `publishPreview` / `statusJson` and NOT safe for `start` /
// `finalize` / `cancel` against anything.  That contract is honoured by the
// Kotlin caller's thread discipline — but "honoured by discipline" is exactly
// what a mid-sweep stop, a camera error and an Activity destroy all race, and
// this programme has already paid for one teardown ordering bug.
//
// So the three lifecycle entries take the lock EXCLUSIVELY and the three
// steady-state entries take it SHARED.  A frame in flight when `stop()` lands
// finishes before the finalize begins, structurally, rather than because the
// recorder joined its threads first (it does, and this is the belt to that
// brace).  A shared acquisition is tens of nanoseconds against a ~30 ms engine
// step, so the frame path pays nothing measurable for it.
//
// ⚠ Two concurrent INGESTS would both hold shared locks and would race each
// other.  That is the caller's guarantee and not this file's: the recorder has
// exactly one engine thread (`writerThread`, one Handler, one message at a
// time).  Stated here so a future second producer cannot be added without
// meeting it.
//
// ── NOTHING HERE THROWS INTO JAVA ───────────────────────────────────────────
//
// Same rule as the pano+ block above, and the ingest entry additionally can
// never REJECT: a dropped frame comes back as a 0 return and is counted by the
// caller, because throwing on a frame path would turn one bad buffer into an
// app kill in an aisle.

namespace {

std::shared_mutex g_panoLiveMu;
std::shared_ptr<rnis::pano::live::Session> g_panoLive;

/// The session, or null.  Callers take the appropriate lock FIRST; this only
/// reads the pointer.
std::shared_ptr<rnis::pano::live::Session> panoLiveSession() { return g_panoLive; }

/// Return codes for `nativeLiveIngest`, mirrored EXACTLY in
/// PanoPlusLiveNative.kt.  A packed int rather than an int[] because this is
/// the frame path: an array return would allocate a Java object 30 times a
/// second for four bits of information.
enum : jint {
    kLiveRan             = 0x1,
    kLivePainted         = 0x2,
    kLivePreviewRendered = 0x4,
    kLiveOutcomeShift    = 8,
};

}  // namespace


// ── Begin a live sweep ──────────────────────────────────────────────────────
//
// Every option is a PRIMITIVE plus the two override arrays, deliberately, and
// not a JSON blob: this file has no JSON reader (the engine's dependency set
// has none, and the replay driver's is private to its translation unit), and a
// parser added here would be the one piece of marshalling in the pano+ port
// that no test can reach.  The argument list is long; every entry in it is
// checkable against the Kotlin `external fun` by eye.
//
// Returns the StartReport as JSON.  `ok:false` is the only failure signal —
// there is no rejection, because a start that fails on a phone in an aisle has
// to say WHY on screen and an exception says nothing.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusLiveNative_nativeLiveStart(
        JNIEnv* env,
        jobject /*thiz*/,
        jstring sessionDir,
        jint packFramesMode,
        jint packFrameEveryN,
        jint packFrameQuality,
        jint packMaxFrames,
        jint canvasQuality,
        jboolean canvasCropPad,
        jdouble previewIntervalMs,
        jdouble previewMaxDutyPct,
        jint previewQuality,
        jint previewMaxAlong,
        jint previewMaxCross,
        jdouble previewWindowCrossMult,
        jint previewWindowAlongPx,
        jboolean previewCropPad,
        jboolean previewLeadOut,
        jboolean writeLedger,
        jstring poseSource,
        jstring captureJson,
        jobjectArray overrideNames,
        jobjectArray overrideValues) {
    std::string s;
    try {
        namespace pl = rnis::pano::live;
        pl::Options opt;
        opt.sessionDir = jstring_to_string(env, sessionDir);
        if (opt.sessionDir.empty()) {
            return newJsonString(env, jsonError("sessionDir is required"));
        }
        opt.packFrames = (packFramesMode == 0) ? pl::PackFrames::All
                       : (packFramesMode == 1) ? pl::PackFrames::Painted
                                               : pl::PackFrames::None;
        opt.packFrameEveryN = (int)packFrameEveryN;
        opt.packFrameQuality = (int)packFrameQuality;
        opt.packMaxFrames = (int)packMaxFrames;
        opt.canvasQuality = (int)canvasQuality;
        opt.canvasCropPad = (canvasCropPad != JNI_FALSE);
        opt.previewIntervalMs = (double)previewIntervalMs;
        opt.previewMaxDutyPct = (double)previewMaxDutyPct;
        opt.previewQuality = (int)previewQuality;
        opt.previewMaxAlong = (int)previewMaxAlong;
        opt.previewMaxCross = (int)previewMaxCross;
        opt.previewWindowCrossMult = (double)previewWindowCrossMult;
        opt.previewWindowAlongPx = (int)previewWindowAlongPx;
        opt.previewCropPad = (previewCropPad != JNI_FALSE);
        opt.previewLeadOut = (previewLeadOut != JNI_FALSE);
        opt.writeLedger = (writeLedger != JNI_FALSE);
        opt.poseSource = jstring_to_string(env, poseSource);
        opt.captureJsonInline = jstring_to_string(env, captureJson);

        if (overrideNames != nullptr || overrideValues != nullptr) {
            const jsize nn = (overrideNames != nullptr)
                ? env->GetArrayLength(overrideNames) : 0;
            const jsize nv = (overrideValues != nullptr)
                ? env->GetArrayLength(overrideValues) : 0;
            if (nn != nv) {
                return newJsonString(env, jsonError(
                    "overrideNames/overrideValues length mismatch ("
                    + std::to_string((long)nn) + " vs "
                    + std::to_string((long)nv) + ")"));
            }
            opt.configOverrides.reserve((size_t)nn);
            for (jsize i = 0; i < nn; ++i) {
                // Every array element ref is DeleteLocalRef'd inside the loop —
                // the same 512-entry local-ref discipline nativeReplayPack
                // states above.
                jstring jn = (jstring)env->GetObjectArrayElement(overrideNames, i);
                jstring jv = (jstring)env->GetObjectArrayElement(overrideValues, i);
                const std::string n = jstring_to_string(env, jn);
                const std::string v = jstring_to_string(env, jv);
                if (jn != nullptr) env->DeleteLocalRef(jn);
                if (jv != nullptr) env->DeleteLocalRef(jv);
                // Unknown / unparseable names are passed THROUGH so the session
                // can count them by name in the report; only an empty name is
                // dropped here, because it cannot be reported on.
                if (!n.empty()) opt.configOverrides.push_back(std::make_pair(n, v));
            }
        }

        std::unique_lock<std::shared_mutex> lock(g_panoLiveMu);
        if (g_panoLive != nullptr && g_panoLive->running()) {
            return newJsonString(env, jsonError(
                "a pano+ live sweep is already running; stop it first"));
        }
        // A previous FINISHED session is replaced rather than reused: the
        // engine is stateful across a sweep and reset() alone would leave the
        // pack paths and counters of the last one in place.
        std::shared_ptr<pl::Session> sess(new pl::Session());
        const pl::StartReport R = sess->start(opt);
        if (!R.ok) {
            return newJsonString(env, jsonError(
                R.error.empty() ? "pano+ live start refused with no reason" : R.error));
        }
        g_panoLive = sess;

        // ⚠ EVERY STRING IS ESCAPED, including the paths.  A directory the
        // host chose is not this file's to trust: one backslash or quote in it
        // and the whole payload stops being JSON, which the Kotlin side reads
        // as "the engine refused" rather than as "the path was odd".  Knob
        // NAMES come straight from the caller's option bag and have the same
        // problem with more reason to actually happen.
        auto str = [](const std::string& v) {
            std::string o = "\"";
            for (size_t i = 0; i < v.size(); ++i) {
                const unsigned char c = (unsigned char)v[i];
                switch (c) {
                    case '"':  o += "\\\""; break;
                    case '\\': o += "\\\\"; break;
                    case '\n': o += "\\n";  break;
                    case '\r': o += "\\r";  break;
                    case '\t': o += "\\t";  break;
                    default:
                        if (c < 0x20) o += ' '; else o += (char)c;
                }
            }
            o += "\"";
            return o;
        };
        s = "{\"ok\":true,\"error\":\"\"";
        s += ",\"sessionDir\":" + str(R.sessionDir);
        s += ",\"packDir\":" + str(R.packDir);
        s += ",\"framesDir\":" + str(R.framesDir);
        s += ",\"previewPath\":" + str(R.previewPath);
        s += ",\"canvasPath\":" + str(R.canvasPath);
        s += ",\"metaPath\":" + str(R.metaPath);
        s += ",\"ledgerPath\":" + str(R.ledgerPath);
        s += ",\"trackPath\":" + str(R.trackPath);
        s += ",\"canvasMaxPixels\":" + std::to_string(R.canvasMaxPixels);
        // The three knob buckets, by NAME.  A knob the operator set that this
        // engine build does not have must be visible on the panel — a sweep
        // that silently ran at a default nobody chose is the failure this port
        // cannot afford.
        auto arr = [&s, &str](const char* key, const std::vector<std::string>& v) {
            s += ",\"";
            s += key;
            s += "\":[";
            for (size_t i = 0; i < v.size(); ++i) {
                if (i) s += ",";
                s += str(v[i]);
            }
            s += "]";
        };
        arr("overridesApplied", R.overridesApplied);
        arr("overridesUnknown", R.overridesUnknown);
        arr("overridesMalformed", R.overridesMalformed);
        s += "}";
    } catch (const std::exception& e) {
        s = jsonError(describeException(e, "nativeLiveStart"));
    } catch (...) {
        s = jsonError("nativeLiveStart threw an unknown native error");
    }
    return newJsonString(env, s);
}


// ── One frame, straight into the engine ─────────────────────────────────────
//
// THE HOT PATH.  ~30 ms on this phone, called once per captured frame from the
// recorder's engine thread.
//
// ⚠ `GetByteArrayElements`, NOT `GetPrimitiveArrayCritical`.  The critical
// variant would avoid a ~3 MB copy, but it PINS the Java heap for the whole
// call — and the whole call is a colour conversion, an engine step and
// possibly a preview render, i.e. tens of milliseconds during which no GC can
// move anything.  A 0.3 ms copy is the cheaper of the two by a wide margin,
// and it is also the SAFER one: the OpenCV work below is free to call back
// into anything, which a critical region forbids.
//
// Returns 0 when the frame did not reach the engine (no session, wrong size,
// conversion refused) — a DROP, which the caller counts.  Otherwise a bitmask;
// see the enum above and its twin in PanoPlusLiveNative.kt.
extern "C" JNIEXPORT jint JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusLiveNative_nativeLiveIngest(
        JNIEnv* env,
        jobject /*thiz*/,
        jbyteArray nv21,
        jint length,
        jint width,
        jint height,
        jdouble tsNs,
        jdouble fx, jdouble fy, jdouble cx, jdouble cy,
        jdouble qx, jdouble qy, jdouble qz, jdouble qw,
        jint tracking,
        jlong seq,
        jdouble exposureDurationS,
        jdouble exposureISO) {
    if (nv21 == nullptr) return 0;
    std::shared_lock<std::shared_mutex> lock(g_panoLiveMu);
    std::shared_ptr<rnis::pano::live::Session> sess = panoLiveSession();
    if (sess == nullptr || !sess->running()) return 0;

    jbyte* buf = env->GetByteArrayElements(nv21, nullptr);
    if (buf == nullptr) {
        // OOM is pending; clear it so the caller is not handed a live exception
        // alongside a return value, and report the frame as dropped.
        if (env->ExceptionCheck()) env->ExceptionClear();
        return 0;
    }
    jint packed = 0;
    try {
        rnis::pano::live::FrameIn in;
        in.tsNs = (double)tsNs;
        in.fx = (double)fx; in.fy = (double)fy;
        in.cx = (double)cx; in.cy = (double)cy;
        in.width = (int)width; in.height = (int)height;
        in.q[0] = (double)qx; in.q[1] = (double)qy;
        in.q[2] = (double)qz; in.q[3] = (double)qw;
        in.tracking = (int)tracking;
        in.seq = (long long)seq;
        in.exposureDurationS = (double)exposureDurationS;
        in.exposureISO = (double)exposureISO;

        const rnis::pano::live::IngestReport r =
            sess->ingest((const unsigned char*)buf, (size_t)length, in);
        if (r.ran) {
            packed |= kLiveRan;
            if (r.painted) packed |= kLivePainted;
            if (r.previewRendered) packed |= kLivePreviewRendered;
            packed |= ((jint)(r.outcome + 1) << kLiveOutcomeShift);
        }
    } catch (...) {
        packed = 0;
    }
    // JNI_ABORT: nothing was written back, so do not copy 3 MB the other way.
    env->ReleaseByteArrayElements(nv21, buf, JNI_ABORT);
    return packed;
}


// ── The live status ─────────────────────────────────────────────────────────
//
// The Android leg has NO push channel — iOS rides the AR plugin's synchronous
// per-frame return, and there is no such plugin here — so this poll is the
// operator's ONLY live signal and `running` is the one field the JS coercion
// treats as mandatory.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusLiveNative_nativeLiveStatusJson(
        JNIEnv* env, jobject /*thiz*/) {
    std::string s;
    try {
        std::shared_lock<std::shared_mutex> lock(g_panoLiveMu);
        std::shared_ptr<rnis::pano::live::Session> sess = panoLiveSession();
        if (sess == nullptr) {
            s = "{\"running\":false}";
        } else {
            s = sess->statusJson();
        }
    } catch (...) {
        // Still a VALID status, because a status the JS side cannot parse is
        // dropped whole and the panel goes blank — which reads as a dead sweep.
        s = "{\"running\":false,\"error\":\"status threw\"}";
    }
    return newJsonString(env, s);
}


// ── Finish: tail flush, canvas.jpg, meta.json, summary ──────────────────────
//
// ⚠ SECONDS, not milliseconds — it encodes a multi-megapixel JPEG.  The Kotlin
// caller dispatches this off the NativeModules queue and off the UI thread;
// the teardown paths that CANNOT afford it call `nativeLiveCancel` instead.
//
// The session is released here whatever happens.  A finalize that threw and
// left the singleton installed would make every later `start()` refuse with
// "already running" for the rest of the process's life.
extern "C" JNIEXPORT jstring JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusLiveNative_nativeLiveFinalize(
        JNIEnv* env, jobject /*thiz*/) {
    std::string s;
    try {
        std::unique_lock<std::shared_mutex> lock(g_panoLiveMu);
        std::shared_ptr<rnis::pano::live::Session> sess = g_panoLive;
        g_panoLive.reset();
        if (sess == nullptr) {
            s = "{\"ok\":false,\"error\":\"no pano+ live sweep is running\"}";
        } else {
            bool empty = false;
            s = sess->finalizeSweep(&empty);
            // `empty` rides the summary as a field rather than as a separate
            // return: the caller has to reject `panoplus-empty` AND keep the
            // counters, and two channels would let one of them be dropped.
            if (!s.empty() && s[s.size() - 1] == '}') {
                s.erase(s.size() - 1);
                s += ",\"empty\":";
                s += (empty ? "true" : "false");
                s += "}";
            }
        }
        purgeNativeAllocator(RNIS_MEMORY_PROFILING != 0);
    } catch (const std::exception& e) {
        s = jsonError(describeException(e, "nativeLiveFinalize"));
    } catch (...) {
        s = jsonError("nativeLiveFinalize threw an unknown native error");
    }
    return newJsonString(env, s);
}


// ── Abandon, cheaply ────────────────────────────────────────────────────────
//
// The exit for teardown paths that must not block: no canvas render, no JPEG,
// no meta.  Files already on disk are KEPT — an Activity destroy must not cost
// the operator the evidence his sweep produced.  Idempotent.
extern "C" JNIEXPORT void JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusLiveNative_nativeLiveCancel(
        JNIEnv* /*env*/, jobject /*thiz*/) {
    try {
        std::unique_lock<std::shared_mutex> lock(g_panoLiveMu);
        std::shared_ptr<rnis::pano::live::Session> sess = g_panoLive;
        g_panoLive.reset();
        if (sess != nullptr) sess->cancel();
    } catch (...) {
        // Nothing to report to: this is the path a teardown takes.
    }
}


extern "C" JNIEXPORT jboolean JNICALL
Java_io_imagestitcher_rn_panoplus_PanoPlusLiveNative_nativeLiveRunning(
        JNIEnv* /*env*/, jobject /*thiz*/) {
    try {
        std::shared_lock<std::shared_mutex> lock(g_panoLiveMu);
        std::shared_ptr<rnis::pano::live::Session> sess = panoLiveSession();
        return (sess != nullptr && sess->running()) ? JNI_TRUE : JNI_FALSE;
    } catch (...) {
        return JNI_FALSE;
    }
}
