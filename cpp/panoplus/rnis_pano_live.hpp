// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_live.hpp — the pano+ LIVE SESSION, platform-free.
//
// ── What this is ────────────────────────────────────────────────────────────
//
// iOS has had a live arm since v1: `ios/RNISPanoCore.mm` owns a frame ring, an
// engine queue, a preview queue and a pack queue, and drives
// `rnis::pano::Engine` while the operator sweeps.  Android has had only
// RECORD-then-REPLAY — `PanoPlusAndroidRecorder` writes JPEGs and a track
// ledger to disk and `rnis::pano::replay` runs the engine afterwards.
//
// This is the missing middle: everything RNISPanoCore.mm does that is NOT
// Objective-C, extracted so the Android leg gets it without a second
// implementation of the algorithm.
//
//   engine lifecycle · pixel conversion · per-frame ingest · the throttled
//   live preview render · the atomic preview publish · ledger.jsonl ·
//   canvas.jpg · meta.json · the status snapshot · the finalize summary
//
// ── WHAT IT DELIBERATELY DOES NOT OWN: THREADS ──────────────────────────────
//
// Not one.  No queue, no worker, no lock-and-wait.  The CALLER owns threading,
// and on Android that caller is `PanoPlusAndroidRecorder`, which already has
// the four HandlerThreads, the drain-every-image loop and the single-in-flight
// backpressure gate this port must not duplicate.
//
// That is a deliberate inversion of the iOS shape, for two reasons that both
// bit this programme:
//
//   1. THE ANR / NativeModules-QUEUE CLASS.  A blocking call inside a legacy
//      `@ReactMethod` runs on RN's ONE NativeModules thread and wedges every
//      native module in the app (the `RNSARSession.setKeyframeQuality…` hang,
//      fixed 2026-09-01).  Threading that is visible in Kotlin, beside the
//      Promise settle, is threading a reviewer can check.  Threading hidden
//      behind a JNI call is not.
//   2. HOST TESTABILITY.  With no threads and no JNI, every decision below —
//      the preview duty-cycle throttle, the pack-frame cadence, the summary
//      arithmetic, the empty-sweep refusal — is a gtest away on the Mac.  The
//      2026-08-29 preview defect lived for eleven days in exactly the ObjC++
//      seam that had no such test.
//
// The ONE consequence the caller must honour is stated on `ingest()`: it is
// NOT re-entrant and NOT thread-safe against itself.  `statusJson()` IS safe
// to call concurrently with `ingest()` — the panel polls it while the sweep
// runs — and nothing else is.
//
// The ONE thread in the picture belongs to `rnis::pano::android::PreviewPump`,
// which this session holds: a JPEG encode of a wide canvas must not sit in
// front of the next frame, and that hand-off is the pump's whole job.  The
// refresh throttle, the render and the coalesced publish are ITS policy, not a
// second copy here — that policy has been wrong twice on iOS and having one of
// it is the point.
//
// ── MEMORY, STATED UP FRONT ─────────────────────────────────────────────────
//
// The operator's A35 sits at ~730 MB RSS idle and has peaked at 1.33 GB, so
// this budget is a design constraint rather than a footnote:
//
//   canvas + coverage   canvasMaxPixels × 4 B   (32 MB at the 8e6 default;
//                                                72 MB at the iOS 18e6 —
//                                                and ~1.75× that transiently
//                                                during a grow)
//   per-ingest BGR      w × h × 3               (6.2 MB at 1920×1080)
//   per-ingest gray     workScale² of that      (1.6 MB at 0.5)
//   preview mats        2 × along × cross × 3   (3.4 MB at 1200×480)
//
// `bgr` is allocated FRESH every frame and cannot be pooled: the engine keeps
// a shallow `cv::Mat` reference to the last PAINTED frame for the finalize
// tail flush (see the note on `rnis::pano::FrameInput`), so a reused scratch
// buffer would be overwritten under it and the lead-out would paint the wrong
// pixels.  That is the same allocation iOS makes, for the same reason.
//
// Nothing here queues frames.  A frame either runs through `ingest()` on the
// caller's thread or was never handed over; there is no growth path.
//
// ── DEPENDENCY DISCIPLINE ───────────────────────────────────────────────────
// C++17 STL + OpenCV core/imgproc/imgcodecs + POSIX <sys/stat.h>, exactly the
// set `rnis_pano_replay.cpp` documents and for the same reason — so the Mac
// host build and the NDK arm64 build compile this translation unit byte for
// byte.  No <filesystem>, no JSON library.

#ifndef RNIS_PANO_LIVE_HPP
#define RNIS_PANO_LIVE_HPP

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "rnis_pano.hpp"
#include "rnis_pano_android_preview.hpp"

namespace rnis {
namespace pano {
namespace live {

/// Which source frames reach `frames/` beside the ledger.
///
/// `None` is the Android DEFAULT and the reason is throughput, not taste: a
/// 1920×1080 software JPEG costs ~15-20 ms on the A35, on the same thread as
/// the engine step, and the operator's complaint is that the live arm does not
/// exist — not that its replay twin is thin.  `track.jsonl` (the replay INPUT:
/// poses, intrinsics, exposure, tracking) is written by the capture arm on
/// every mode, so a `None` pack still carries the full pose ledger and this
/// session's own `ledger.jsonl` decisions; what it cannot do is re-run the
/// PIXELS offline.
enum class PackFrames : int { All = 0, Painted = 1, None = 2 };

struct Options {
    /// Absolute path of THE PACK DIRECTORY — `frames/` is created under it and
    /// `preview.jpg` / `canvas.jpg` / `meta.json` / `ledger.jsonl` are written
    /// into it, exactly as `RNISPanoCore.mm` writes into the `dir` it is given.
    /// The Android recorder passes its own `packDir`, so a live pack and a
    /// recorded pack are the same layout and one replay driver reads both.
    ///
    /// Named `sessionDir` and not `packDir` because that is the key the SDK
    /// sends and the field it reads back (`PanoPlusStarted.sessionDir`).
    std::string sessionDir;

    PackFrames packFrames      = PackFrames::None;
    int        packFrameEveryN = 1;
    int        packFrameQuality = 70;
    int        packMaxFrames   = 1500;

    int  canvasQuality = 92;
    bool canvasCropPad = true;

    /// ── THE LIVE PREVIEW IS NOT IMPLEMENTED HERE ────────────────────────
    /// These map 1:1 onto `rnis::pano::android::PreviewConfig`, which owns the
    /// refresh throttle, the render, the coalesced atomic publish and its own
    /// worker thread.  This session holds a `PreviewPump` and calls `tick`
    /// once per ingest; it does not re-implement any of that policy, because
    /// the policy has been wrong twice on iOS and the whole point of having it
    /// in one host-tested object is that there is one of it.
    ///
    /// A FLOOR, not a period — see `previewMaxDutyPct`.
    double previewIntervalMs = 120.0;
    /// The preview's own measured cost may take at most this share of wall
    /// time on the ingest thread, so a dear render slows the REFRESH RATE and
    /// never the sweep.  0 disables the self-throttle.
    double previewMaxDutyPct = 8.0;
    int    previewQuality    = 82;

    /// See `rnis::pano::android::PreviewConfig` for why the Android box is
    /// 1200 × 480 and not iOS's 2000 × 800 (Fresco's URI-keyed bitmap cache
    /// versus a `?v=<seq>` cache-bust on a process that has peaked at 1.33 GB).
    int previewMaxAlong = 1200;
    int previewMaxCross = 480;

    /// Follow-the-frontier window as a multiple of the canvas cross extent;
    /// 0 ⇒ always fit the whole painted band.
    double previewWindowCrossMult = 1.44;
    /// An explicit window in canvas px WINS over the multiple above.
    int    previewWindowAlongPx   = 0;
    bool   previewCropPad         = true;
    bool   previewLeadOut         = true;

    /// `ledger.jsonl` — the engine's own decision trace, one row per ingested
    /// frame, in RNISPanoCore.mm's field order (this writes it through
    /// `rnis::pano::replay::appendLedgerLine`, so the two cannot drift).
    bool writeLedger = true;

    /// Engine knobs BY NAME, applied through
    /// `rnis::pano::replay::applyConfigOverride` — one table for meta.json
    /// adoption, replay overrides and this.  A name the table does not know,
    /// or a value it cannot parse, is REPORTED in `StartReport` rather than
    /// silently dropped: a sweep that ran at a knob the operator did not set
    /// is the failure this port cannot afford.
    std::vector<std::pair<std::string, std::string> > configOverrides;

    /// A complete JSON OBJECT (braces included) written verbatim into
    /// `meta.json → capture`.  The capture arm's own provenance — which
    /// camera, which basis, what the AE lock read back — which this session
    /// cannot know and must not invent.  Empty ⇒ the key is omitted; anything
    /// that does not begin with `{` is DROPPED and named, because a malformed
    /// inline would not corrupt one field but the whole file.
    std::string captureJsonInline;

    /// `meta.json → poseSource`.  "imu" | "ar" | "" (omitted).
    std::string poseSource;
};

struct StartReport {
    bool        ok = false;
    std::string error;
    std::string sessionDir, packDir, framesDir;
    std::string previewPath, canvasPath, metaPath, ledgerPath, trackPath;
    /// Knob names, split three ways.  `unknown` means the table has no such
    /// knob (a typo, or a knob this engine build predates); `malformed` means
    /// the knob exists and the VALUE could not be parsed.  Both leave the
    /// engine default in force and both are the caller's to surface.
    std::vector<std::string> overridesApplied, overridesUnknown, overridesMalformed;
    /// The canvas ceiling actually in force, in PIXELS — the number the memory
    /// budget in this header is computed from.
    double canvasMaxPixels = 0.0;
};

/// One frame, as the capture arm knows it.
///
/// ⚠ INTRINSICS ARE EXPRESSED AGAINST `width` × `height` — the raster of the
/// NV21 buffer handed to `ingest`, UNROTATED, in the sensor frame.  Rotating
/// the pixels without rotating the intrinsics leaves the basis wrong by that
/// angle with nothing in the pack able to name it, which is why
/// `PanoPlusNativeBasis.PANO_RECORDER_ROTATION_RAW_SENSOR_BUFFER` is a FACT
/// about the recorder rather than a preference.
struct FrameIn {
    double tsNs = 0.0;
    double fx = 0, fy = 0, cx = 0, cy = 0;
    int    width = 0, height = 0;
    /// world←camera unit quaternion [x, y, z, w].
    double q[4] = {0, 0, 0, 1};
    /// 0 notAvailable · 1 limited · 2 normal.
    int       tracking = 0;
    long long seq      = 0;
    /// Seconds and ISO.  Scene radiance is linear in their PRODUCT, which is
    /// what lets the engine normalise exposure EXACTLY instead of estimating
    /// it from overlap.  Either at 0 ⇒ "not available", treated as identity.
    double exposureDurationS = 0.0;
    double exposureISO       = 0.0;
};

struct IngestReport {
    /// False when no session is running, the buffer is the wrong size, or the
    /// conversion threw.  A false here is a DROPPED frame, not an error.
    bool ran = false;
    /// `rnis::pano::Outcome` as an int, or -1 when `ran` is false.
    int  outcome = -1;
    bool painted = false;
    /// The preview pump rendered on this tick.  It publishes on its OWN worker
    /// thread, so there is nothing for the caller to do about it; reported only
    /// so a caller can attribute a slow frame to the render.
    bool previewRendered = false;
    /// Milliseconds: the engine step alone, then the whole call (conversion +
    /// engine + preview render + ledger row).
    double engineMs = 0.0;
    double totalMs  = 0.0;
    /// Set when the conversion or the engine refused, for the caller's
    /// first-error field.  Empty on the happy path.
    std::string error;
};

/// One live pano+ sweep.
///
/// NOT thread-safe against itself: `ingest()` must be called from ONE thread
/// at a time.  `statusJson()` IS safe concurrently with `ingest()` (the
/// preview pump's snapshot is mutex-guarded and the counters it reads are
/// atomics); `start()`, `finalizeSweep()` and `cancel()` are not safe against
/// anything.
class Session {
public:
    Session();
    ~Session();
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    /// Create the pack tree, configure the engine, open the ledger.  Returns a
    /// report whose `ok` is the only success signal.  Never throws.
    StartReport start(const Options& opt);

    bool running() const noexcept;

    /// Correct `meta.json`'s `poseSource` when the arm CHANGES mid-sweep.
    ///
    /// ⚠ THIS EXISTS BECAUSE `meta.json` IS READ ALONE. `poseSource.kind` is
    /// the field an offline harness consults to know which series painted the
    /// pixels, and it is fixed at `start()` — which is correct only while the
    /// arm cannot change after `start()`. The Android recorder can now give
    /// the ARCore arm up mid-sweep and finish on the IMU ring, so without
    /// this the pack would say `ar` for a sweep the IMU painted, and a
    /// `device.json` cross-reference is not a fix: the two files are consumed
    /// separately.
    ///
    /// Takes the status mutex, is safe to call from the recorder's writer
    /// thread while ingest is running, and is a no-op on an empty string.
    void setPoseSource(const std::string& kind) noexcept;

    /// One frame.  `nv21` is `width × height × 3 / 2` bytes, NV21 (Y plane
    /// then interleaved VU) — the layout `Yuv420ToNv21` already produces.
    /// Never throws.
    IngestReport ingest(const unsigned char* nv21, size_t len, const FrameIn& in);

    /// The live status, as a JSON object.  The Android leg has NO push channel
    /// (iOS rides the AR plugin's synchronous return), so this poll is the
    /// ONLY status channel and `running` is the one field the JS side treats
    /// as mandatory.
    std::string statusJson() const;

    /// Drain, lead-out tail flush, `canvas.jpg`, `meta.json`, and the summary.
    ///
    /// Returns the summary JSON.  `*empty` is set when the sweep painted
    /// NOTHING — the caller must then reject `panoplus-empty` and still keep
    /// the pack, because a failed sweep is evidence (the summary is returned
    /// either way and carries the counters).
    ///
    /// ⚠ SECONDS, not milliseconds: it encodes a multi-megapixel JPEG.  Never
    /// call it on a thread that must not block — and never on RN's
    /// NativeModules queue or the UI thread.  `cancel()` is the cheap exit.
    std::string finalizeSweep(bool* empty);

    /// Abandon the sweep.  Releases the engine and closes the ledger WITHOUT
    /// rendering a canvas, so it is safe on a tight teardown budget.  Files
    /// already on disk are KEPT: on Android the ownerless teardown paths
    /// (module invalidate, host destroy) reach this, and deleting the
    /// operator's pack because his Activity was recreated would destroy the
    /// only evidence the sweep produced.  Idempotent.
    void cancel();

private:
    /// Build the status object into `s`.  `row` is the frame that just ran, or
    /// null before the first one (the surface polls from the instant `start()`
    /// resolves, and a status is owed then too).
    void appendStatus(std::string& s, const FrameOutcome* row) const;

    /// `meta.json`.  Written at finalize, from values already read out of the
    /// engine — it takes them as arguments rather than re-reading, because
    /// `stats()` is not free and the summary and the meta must describe ONE
    /// snapshot rather than two taken a few milliseconds apart.
    void writeMeta(const SessionStats& st,
                   const std::vector<std::pair<int, int> >& holes,
                   const std::vector<std::pair<int, int> >& env,
                   int outW, int outH, int cropLo, int cropHi, double sweepMs,
                   const android::PreviewSnapshot& pv);

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace live
}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_LIVE_HPP
