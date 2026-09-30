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
// ── WHAT IT DELIBERATELY DOES NOT OWN: THE FRAME THREAD ─────────────────────
//
// No frame queue, no ingest worker, no lock-and-wait on the frame path.  The
// CALLER owns the thread `ingest()` runs on, and on Android that caller is
// `PanoPlusAndroidRecorder` or one of the plugin arms, which already have the
// HandlerThreads, the drain-every-image loop and the backpressure gate this
// port must not duplicate.
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
//   2. HOST TESTABILITY.  With no frame thread and no JNI, every decision
//      below — the preview duty-cycle throttle, the pack-frame cadence, the summary
//      arithmetic, the empty-sweep refusal — is a gtest away on the Mac.  The
//      2026-08-29 preview defect lived for eleven days in exactly the ObjC++
//      seam that had no such test.
//
// The ONE consequence the caller must honour is stated on `ingest()`: it is
// NOT re-entrant and NOT thread-safe against itself.  `statusJson()` IS safe
// to call concurrently with `ingest()` — the panel polls it while the sweep
// runs — and nothing else is.
//
// TWO workers ARE owned here, and both exist for the same reason: a JPEG
// encode must not sit in front of the next frame.
//
//   * `rnis::pano::android::PreviewPump` publishes the growing canvas.  The
//     refresh throttle, the render and the coalesced publish are ITS policy,
//     not a second copy here — that policy has been wrong twice on iOS and
//     having one of it is the point.
//   * `detail::PackWriter` writes the pack frames (`frames/frame_*.jpg`).  It
//     used to run `cv::imwrite` inline on the ingest thread, which put a
//     full-resolution software JPEG (~20-25 ms of a 65 ms ingest on the A35,
//     inferred) in front of every next frame of a `PackFrames::All` sweep.
//     It is the iOS pack queue's shape (RNISPanoCore.mm: bounded,
//     drop-and-count).
//
// Both are BOUNDED, never throw outward, and are joined at finalize, cancel
// and destruction.  Neither is visible to `ingest()`'s caller except through
// the counters it reports.
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
//   pack queue          packQueueMax × w × h × 3 (18.6 MB at 3 × 1920×1080 —
//                                                 two queued plus the one
//                                                 being encoded)
//
// `bgr` is allocated FRESH every frame and cannot be pooled: the engine keeps
// a shallow `cv::Mat` reference to the last PAINTED frame for the finalize
// tail flush (see the note on `rnis::pano::FrameInput`), so a reused scratch
// buffer would be overwritten under it and the lead-out would paint the wrong
// pixels.  That is the same allocation iOS makes, for the same reason.
//
// The pack queue holds SHALLOW handles to each frame's own `bgr` — the same
// refcounted Mat the engine may also be holding, never a copy — which is
// exactly why a fresh-per-frame `bgr` is what makes the queue free of copies.
// It is bounded at `Options::packQueueMax` OUTSTANDING frames (queued + the one
// being encoded); a frame that finds it full is not written, and is counted
// (`droppedQueueFull`).  The ENGINE's input is never queued: a frame either
// runs through `ingest()` on the caller's thread or was never handed over.
//
// ── DEPENDENCY DISCIPLINE ───────────────────────────────────────────────────
// C++17 STL + OpenCV core/imgproc/imgcodecs + POSIX <sys/stat.h>, exactly the
// set `rnis_pano_replay.cpp` documents and for the same reason — so the Mac
// host build and the NDK arm64 build compile this translation unit byte for
// byte.  No <filesystem>, no JSON library.

#ifndef RNIS_PANO_LIVE_HPP
#define RNIS_PANO_LIVE_HPP

#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/core.hpp>

#include "rnis_pano.hpp"
#include "rnis_pano_android_preview.hpp"

namespace rnis {
namespace pano {
namespace live {

namespace detail {

/// One pack frame on its way to disk.
///
/// `bgr` is a SHALLOW handle to the frame's own conversion output: `ingest()`
/// allocates that Mat fresh for every frame and nothing writes into it again,
/// so the refcount is all the writer needs to keep the pixels alive — the same
/// hand-off iOS makes (`bgrForPack = bgr;   // shallow`, RNISPanoCore.mm).
struct PackJob {
    std::string path;
    cv::Mat     bgr;
    int         quality = 70;
    long long   seq = 0;
};

/// The encode.  Returns true only when `path` now holds the frame; `err` (may
/// be null) carries the reason when it does not.  An EMPTY function means the
/// production encoder, `cv::imwrite` with IMWRITE_JPEG_QUALITY — the seam
/// exists so the host tests can hold an encode on a latch, slow it or fail it.
using PackEncoder = std::function<bool(const std::string& path, const cv::Mat& bgr,
                                       int quality, std::string* err)>;

/// Everything the writer did, read under its lock.
struct PackWriterStats {
    /// A worker was spawned for this sweep.  False on `PackFrames::None`,
    /// which spawns nothing.
    bool      started = false;
    /// OUTSTANDING frames allowed: queued PLUS the one being encoded.
    int       queueMax = 0;
    long long enqueued = 0;
    /// On disk.  `written + failed` is every encode that ran.
    long long written = 0;
    long long failed = 0;
    /// Refused at `enqueue` because `queueMax` frames were outstanding.
    long long droppedQueueFull = 0;
    /// Still queued when `stop` ran out of budget (or was handed 0).
    long long droppedAtStop = 0;
    long long bytes = 0;
    /// The most frames ever outstanding at once.
    int       highWater = 0;
    /// Queued + in flight right now.  0 after `stop`.
    int       outstanding = 0;
    int       niceRequested = 0;
    bool      niceApplied = false;
    /// Wall time of each encode that RAN (a refused frame is not a sample).
    /// Filled only by `stats(true)`: sorting the reservoir is not free, and
    /// the status snapshot is rebuilt on every ingest.
    double    writeMsP50 = 0.0, writeMsP99 = 0.0, writeMsMax = 0.0;
    long long writeMsN = 0;
    std::string firstError;
};

/// The pack-frame writer: one worker, a bounded queue, drop-and-count.
///
/// THREADING CONTRACT:
///   * `enqueue` is called from the ingest thread and NEVER blocks on an
///     encode — it takes the queue lock for a push and returns.
///   * `stats` is callable from any thread.
///   * `start`/`stop` come from the session's own serialized lifecycle.
///
/// NOTHING HERE THROWS OUTWARD: an exception escaping an encode on a
/// `std::thread` is `std::terminate`, and a pack frame is not worth the app.
/// Every encode runs inside a catch-all and a throw is counted as `failed`.
class PackWriter {
public:
    PackWriter();
    /// Stops with budget 0 and JOINS.  A joinable `std::thread` destroyed
    /// without a join is `std::terminate`, so this is not optional.
    ~PackWriter();
    PackWriter(const PackWriter&) = delete;
    PackWriter& operator=(const PackWriter&) = delete;

    /// Reset the counters and spawn the worker.  `queueMax` < 1 is clamped to
    /// 1.  `niceness` != 0 lowers (or raises) the WORKER THREAD's scheduling
    /// priority on Linux/Android and is ignored elsewhere — 0 leaves it
    /// inheriting the caller's.  False (with `err`) when already running or
    /// when the thread could not be created.
    bool start(int queueMax, PackEncoder encoder, int niceness, std::string* err);

    /// Hand one frame over.  Returns false — and counts `droppedQueueFull` —
    /// when `queueMax` frames are already outstanding; false (counted as
    /// `droppedAtStop`) when the writer is not running.  Never blocks.
    bool enqueue(PackJob&& job);

    /// Drain for up to `budgetMs`, then drop what is still queued (counted as
    /// `droppedAtStop`) and JOIN: an encode already in flight always
    /// completes, so this returns within `budgetMs` plus at most one encode.
    /// Idempotent; never throws.
    void stop(double budgetMs) noexcept;

    /// `stop(0)` and zero every counter, `started` included — for a sweep
    /// that starts no writer (`PackFrames::None`), so it cannot report the
    /// previous sweep's frames as its own.
    void reset() noexcept;

    bool running() const noexcept;
    PackWriterStats stats(bool withTimings = true) const;

private:
    struct State;
    std::unique_ptr<State> st_;
};

}  // namespace detail

/// Which source frames reach `frames/` beside the ledger.
///
/// `None` is the Android DEFAULT, for CPU and battery rather than ingest
/// latency: a 1920×1080 software JPEG costs ~15-20 ms of CPU on the A35.  It
/// no longer rides the engine thread — `detail::PackWriter` encodes on its own
/// worker — but the cycles are MOVED, not removed, and on a phone whose big
/// cores are saturated the writer falls behind and drops pack frames (counted
/// as `droppedQueueFull`; the sweep itself loses nothing).  `track.jsonl` (the replay INPUT:
/// poses, intrinsics, exposure, tracking) is written on every mode, so a
/// `None` pack still carries the full pose ledger and this session's own
/// `ledger.jsonl` decisions; what it cannot do is re-run the PIXELS offline.
///
/// ⚠ THAT SENTENCE USED TO SAY "by the capture arm", AND IT WAS FALSE ON TWO
/// ARMS OUT OF THREE.  The Android recorder's writer is reached only from the
/// Camera2 `ImageReader` callback, so the `ar-plugin` and `vc-plugin` arms
/// wrote no rows at all and left a 0-byte file — measured 2026-09-22 on 15 of
/// 16 A35 packs, every date.  The row is now written HERE, under
/// `Options::writeTrack`, which is the one point every arm funnels through.
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

    /// Pack frames `detail::PackWriter` may hold at once, COUNTING THE ONE
    /// BEING ENCODED — 3 is two queued plus one in flight, 18.6 MB at
    /// 1920×1080 (see the memory note above).  A frame that finds it full is
    /// not written and is counted as `droppedQueueFull`: the PACK loses the
    /// frame, the sweep does not, and replay names the gap (`framesMissing`).
    /// Ignored on `PackFrames::None`, which starts no writer at all.
    int packQueueMax = 3;
    /// Scheduling niceness for the writer thread (Linux/Android only; ignored
    /// elsewhere).  0 = inherit, the default, and deliberately so: a niced
    /// writer beside a latest-wins ingest worker that is ~100% busy is exactly
    /// the state that starves it into `droppedQueueFull` on an `All`
    /// sweep, and no device measurement yet says the encode steals enough from
    /// the ingest or GL threads to be worth that.  An Options knob so the
    /// A/B needs no change to this session; the JNI start does not pass it
    /// yet, so on a device it is 0 until that one line is plumbed.
    int packWriterNice = 0;
    /// TEST SEAM.  Empty ⇒ `cv::imwrite`.  The host tests hold an encode on a
    /// latch, slow it or fail it through this; production never sets it.
    detail::PackEncoder packEncoder;

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
    /// Write `track.jsonl` — the REPLAY INPUT — from this layer.
    ///
    /// ⚠ DEFAULT FALSE, and it is a statement about ownership rather than
    /// timidity: exactly one process may own this file per sweep, and this
    /// layer cannot see the host descriptor it would collide with.  On
    /// Android the Camera2 arm's recorder writes its own 46-key superset and
    /// holds the handle, so it passes false; every other arm reaches the
    /// engine WITHOUT passing through that writer and passes true.  Before
    /// 2026-09-22 nobody passed anything and the two shipping arms left a
    /// 0-byte file, so no capture from either could be replayed.
    bool writeTrack = false;

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
    /// Whether THIS layer took ownership of `track.jsonl` (see
    /// `Options::writeTrack`).  Reported rather than inferred: the flag
    /// crosses a JNI boundary with no compiler between the two sides, and an
    /// arrival that cannot be observed is how a knob ships inert.
    bool writeTrack = false;
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
    /// engine + preview render + pack hand-off + track and ledger rows).  The
    /// pack frame's ENCODE is not in it: that runs on `detail::PackWriter`.
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
/// atomics, and the pack writer's counters are read under its own lock);
/// `start()`, `finalizeSweep()` and `cancel()` are not safe against anything.
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
    /// A1.0 — the per-stage ingest timings, the ingest thread's CPU time and
    /// its core placement; written into BOTH the summary and `meta.json`.
    void appendStageTimings(std::string& s, const detail::PackWriterStats& pw) const;
    /// A1.1 — the pack writer's flat counters for the summary.
    void appendPackCounts(std::string& s, const detail::PackWriterStats& pw) const;

    void writeMeta(const SessionStats& st,
                   const std::vector<std::pair<int, int> >& holes,
                   const std::vector<std::pair<int, int> >& env,
                   int outW, int outH, int cropLo, int cropHi, double sweepMs,
                   const android::PreviewSnapshot& pv,
                   const detail::PackWriterStats& pw);

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace live
}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_LIVE_HPP
