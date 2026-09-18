// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_preview — THE GROWING CANVAS ON SCREEN, as a testable
// object.
//
// ── What this is ────────────────────────────────────────────────────────────
//
// The live preview is not a picture; it is a POLICY with four moving parts, and
// on iOS all four live inline in `RNISPanoCore.mm` between lines 1160 and 1660:
//
//   1. a REFRESH THROTTLE — `previewIntervalMs` is a floor, and the preview may
//      cost at most `previewMaxDutyPct` of the ingest thread, judged by its own
//      measured render cost.  A dearer render slows the REFRESH and never the
//      sweep;
//   2. a RENDER — `Engine::previewIntoFit`, which turns the fit box with the
//      latched sweep axis, optionally windows on the frontier, trims the
//      unpainted canvas pad and composites the dimmed lead-out;
//   3. a COALESCED PUBLISH — encode + atomic tmp+rename on a queue that is NOT
//      the ingest thread, dropping (and counting) a tick whose predecessor is
//      still in flight, because a backlog of stale panoramas is worth nothing;
//   4. the COUNTERS that make all of the above falsifiable from a pack.
//
// This file is that policy, once, in platform-free C++17, so the Android arm
// gets the SAME behaviour rather than a second implementation of it.
//
// ── Why it is a separate translation unit ───────────────────────────────────
//
// The obvious home is the JNI shim or the session holder beside it.  Both are
// places where nothing can be tested: the JNI translation unit needs <jni.h>
// and compiles under the NDK and nowhere else, and a live session needs a
// camera.  The same argument `rnis_pano_android_report.hpp` makes for the basis
// JSON applies here with more force, because this policy has ALREADY BEEN WRONG
// TWICE ON iOS and neither fault was visible from either suite:
//
//   * the publish swallowed a cv::Exception on every tick of every sweep for
//     ELEVEN DAYS — the panel was empty, the engine was fine, and nothing
//     counted the failures (fixed by `publishJpegAtomically` + `previewFailed`);
//   * the interval clock did not advance on a REFUSED render, so a pre-latch
//     sweep re-probed at 60 Hz and pushed a ~0 ms sample every frame, which
//     corrupted the pack's own preview-lag evidence (fixed by advancing the
//     clock on attempts, not renders).
//
// Both are pure policy defects reachable from a host test and from nowhere
// else.  So the policy lives here, `rnis_pano_android_preview_test.cpp` asserts
// it, and the session holder's job shrinks to two calls it cannot get wrong.
//
// ── The seam the session holder consumes ────────────────────────────────────
//
//     PreviewPump pump;
//     pump.start(cfg, &err);                 // once, inside start()
//     ...
//     pump.tick(engine, monotonicMs());      // once per ingest, engine thread
//     ...
//     PreviewSnapshot s = pump.snapshot();   // any thread, for getStatus()
//     pump.flush(engine, monotonicMs(), &e); // once, after engine.finish()
//     pump.stop();                           // drain + join
//
// `previewStatusToJson` emits EXACTLY the keys the SDK's `coercePanoPlusStatus`
// reads (panoPlusModel.ts:296-317).  A key spelled differently here is a panel
// that stays empty on a phone in an aisle, so the spelling is asserted by test
// rather than by review.
//
// ── MEMORY, stated up front because it is the operator's critical issue ─────
//
// This object holds exactly TWO preview mats and one encode buffer:
//
//     render mat    maxAlong x maxCross x 3 (BGR)
//     outbox mat    the same, swapped with the render mat under the in-flight
//                   token, so a publish never aliases the canvas the engine is
//                   painting and no tick allocates
//     JPEG bytes    ~60-120 kB at quality 82
//
// At the ANDROID defaults below (1200 x 480) that is 2 x 1.73 MB + ~0.1 MB =
// 3.6 MB steady, with no per-tick allocation after the first render.  At the
// iOS defaults (2000 x 800) the same structure would be 9.6 MB.
//
// ⚠ WHY THE ANDROID BOX IS SMALLER, AND WHAT IT COSTS.  RN Android's `<Image>`
// is Fresco, and Fresco keys its bitmap memory cache by the URI INCLUDING the
// query string.  The preview's cache-bust is `?v=<seq>` (panoPlusModel.ts:1518),
// so every publish is a NEW cache entry, LRU-retained as decoded ARGB_8888:
// 2000x800 would be 6.4 MB per tick of pure churn on a process that already
// idles at 733 MB RSS on the A35 and has peaked at 1.33 GB.  1200x480 is 2.3 MB
// decoded, still ~3x the device pixels of the panel it is drawn into, and the
// cost is preview SHARPNESS ONLY — `maxAlong`/`maxCross` are the preview fit
// box and reach neither the canvas nor `canvas.jpg`.
//
// ── What is NOT here ────────────────────────────────────────────────────────
//
// The VIEWFINDER (the camera's own live feed) is a different thing entirely and
// is not in this file: on Android it is `PanoPlusPreviewView.kt`, a TextureView
// whose Surface the recorder adds as a second capture-session output.  This
// file is only the panorama the engine is growing.

#ifndef RNIS_PANO_ANDROID_PREVIEW_HPP
#define RNIS_PANO_ANDROID_PREVIEW_HPP

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

#include <opencv2/core.hpp>

#include "rnis_pano.hpp"

namespace rnis {
namespace pano {
namespace android {

/// A monotonic millisecond clock, so every caller of `tick` measures the same
/// thing.  `steady_clock` and NOT `system_clock`: an NTP step during a sweep
/// must not make the throttle skip an hour of previews or fire every frame.
double monotonicMs();

// ── Configuration ───────────────────────────────────────────────────────────

/// Everything the pump needs, and nothing it can derive.
///
/// The defaults are the ANDROID ones — see the memory note in the file header
/// for why `maxAlong`/`maxCross` differ from iOS's 2000/800.  Every other value
/// is iOS's, deliberately: they were tuned against real packs, and a second set
/// of numbers would be a second behaviour to explain.
struct PreviewConfig {
    /// Absolute path of the published JPEG.  `<sessionDir>/preview.jpg` — the
    /// SDK reads `status.previewPath` and appends `?v=<seq>`, so this string is
    /// what ends up in an `<Image>` source.
    std::string path;

    /// The refresh FLOOR in ms.  Clamped to >= 50 on adoption, matching
    /// `RNISPanoCore.mm:790`.
    double intervalMs = 120.0;

    /// The share of the ingest thread's wall time the preview may cost, in
    /// percent.  0 disables the self-throttle and leaves `intervalMs` in force.
    double maxDutyPct = 8.0;

    /// The fit box in SWEEP terms — `Along` caps the axis the sweep is growing
    /// along, `Cross` the perpendicular one.  Sweep terms because the box has
    /// to TURN with the sweep and only the engine knows which way that is.
    int maxAlong = 1200;
    int maxCross = 480;

    /// The frontier window.  An explicit px count wins; otherwise the ratio is
    /// applied to the canvas the latch actually sized.  0 / 0 is the whole
    /// painted band, which is byte-identical to the pre-window path.
    int windowAlongPx = 0;
    double windowCrossMult = 1.44;

    /// Trim the rows nothing ever painted (the canvas's two pads) off the
    /// preview's cross axis.  Row UNION, so it can never cut a committed pixel.
    bool cropPad = true;

    /// Composite the PROVISIONAL region between the commit frontier and the
    /// live frame's leading edge, dimmed.  Preview only; the canvas is untouched.
    bool leadOut = true;

    /// JPEG quality for the published preview.
    int quality = 82;
};

// ── The throttle, alone ─────────────────────────────────────────────────────

/// The refresh policy with no engine, no canvas and no thread in it.
///
/// Split out because it is the half that has been wrong before and the half a
/// test can pin exactly: given a clock and a sequence of render costs, the
/// cadence is arithmetic.
class PreviewThrottle {
public:
    PreviewThrottle() = default;
    PreviewThrottle(double intervalFloorMs, double maxDutyPct);

    /// Is a render due at `nowMs`?  True before the first attempt.
    bool due(double nowMs) const;

    /// A render was ATTEMPTED at `nowMs` — call this whether or not the engine
    /// had anything to draw.
    ///
    /// ⚠ ON REFUSALS TOO, and that is the fix for a measured defect: before
    /// iOS advanced the clock here, a pre-latch sweep (nothing painted yet)
    /// re-probed the engine on EVERY frame at 60 Hz.
    void markAttempt(double nowMs);

    /// A render SUCCEEDED and cost `costMs`.  Feeds the duty-cycle EWMA that
    /// sets the effective interval.
    void markRender(double costMs);

    /// The interval actually in force — `>= intervalFloorMs`, capped at 1000 ms
    /// so a pathological render cannot stop the panel entirely.
    double effectiveIntervalMs() const { return intervalEffMs_; }

    /// The EWMA of measured render cost, or -1 before the first render.
    double costEwmaMs() const { return costEwmaMs_; }

private:
    double intervalFloorMs_ = 120.0;
    double maxDutyPct_ = 8.0;
    double intervalEffMs_ = 120.0;
    double costEwmaMs_ = -1.0;
    double lastAttemptMs_ = 0.0;
    bool attempted_ = false;
};

// ── What the panel is told ──────────────────────────────────────────────────

/// The live preview's contribution to `getStatus()`.
///
/// Field names track the SDK's `PanoPlusStatus` one for one so the JSON
/// serialiser below is a transcription and not a translation.
struct PreviewSnapshot {
    /// The path JS points an `<Image>` at.  Empty until `start` adopts a config.
    std::string path;

    /// The PUBLISHED sequence number — the cache-bust, and the panel's whole
    /// liveness signal.  0 means nothing has reached disk yet.
    ///
    /// ⚠ PUBLISHED, NOT RENDERED.  The two diverging is the entire signature of
    /// a publisher that cannot write, and conflating them is what hid that for
    /// eleven days on iOS.  `renders > 0 && seq == 0` is the panel's own alarm
    /// (panoPlusModel.ts:1419).
    int64_t publishedSeq = 0;

    /// The published image's own pixel dims — the panorama's SHAPE, which is
    /// what the panel sizes itself from.  0 until the first publish lands.
    int w = 0, h = 0;

    /// Rendered / published / coalesced-away / failed-to-write.  Four different
    /// facts; the panel renders three of them as distinct warnings.
    int64_t renders = 0, published = 0, skips = 0, fails = 0;

    /// The first write error, kept verbatim.  Empty when nothing has failed.
    /// SURFACED, never swallowed — silence is what let the eleven days run.
    std::string firstError;

    /// The interval actually in force, so the HUD can say "prev 4.2Hz" when the
    /// duty throttle has slowed the panel rather than leaving it unexplained.
    double intervalMs = 120.0;

    /// Where this preview sits in the panorama.  `frontierFrac` is 0..1 along
    /// the published image's own long axis, or -1 when unplaceable — and -1 is
    /// NOT 0, because 0 is a legitimate fraction at the near end of a reversed
    /// sweep.
    double frontierFrac = -1.0;
    int viewPx = 0, bandPx = 0, viewStartPx = 0;
    bool windowed = false;
};

/// The snapshot as the JSON object `getStatus()` merges into its reply.
///
/// Emits exactly the keys `coercePanoPlusStatus` reads, with no trailing comma
/// and no bare `nan`/`inf` — `JSON.parse` throws on both, three layers away
/// from whoever wrote them.
std::string previewStatusToJson(const PreviewSnapshot& s);

// ── The pump ────────────────────────────────────────────────────────────────

/// Throttle + render + coalesced publish, with one worker thread.
///
/// THREADING CONTRACT, and it is narrow on purpose:
///   * `tick` and `flush` are called from the ENGINE thread and only from
///     there.  They read the engine, which is the same thread that writes it —
///     so the engine needs no lock, exactly as on iOS.
///   * `snapshot` is callable from any thread (the RN NativeModules thread
///     answering `getStatus`, and the AR plugin's sync channel).
///   * `start`/`stop` are called from the session's own lifecycle, which is
///     serialized.
///
/// NOTHING HERE THROWS OUTWARD.  A preview failure must degrade to a counted
/// number and an empty panel; a throw out of `tick` would abort a sweep the
/// operator is halfway through, and a throw out of the worker would be
/// `std::terminate`.
class PreviewPump {
public:
    PreviewPump();
    /// Stops and joins.  Safe to destroy without calling `stop` first.
    ~PreviewPump();

    PreviewPump(const PreviewPump&) = delete;
    PreviewPump& operator=(const PreviewPump&) = delete;

    /// Adopt `cfg` and spawn the publish worker.  Returns false and fills `err`
    /// on a config that cannot work (an empty path), leaving the pump inert —
    /// `tick` then does nothing and the panel reports the reason through the
    /// session's own start rejection.
    bool start(const PreviewConfig& cfg, std::string* err);

    /// One engine tick.  Renders at most one preview, hands it to the worker,
    /// and returns whether a render happened (for the caller's own timing
    /// samples).  Cheap and non-blocking when the throttle is not due — which
    /// is most frames.
    bool tick(const Engine& engine, double nowMs);

    /// The FINAL republish, after `engine.finish()`.
    ///
    /// Bypasses the throttle and publishes SYNCHRONOUSLY on the calling thread,
    /// because the alternative is a panel frozen one tick short of the sweep
    /// the operator just finished — and by then the worker may already be
    /// joined.  Waits (bounded) for an in-flight publish first so the last
    /// write wins the rename.
    bool flush(const Engine& engine, double nowMs, std::string* err);

    /// Drain and join.  Idempotent; safe from any thread; never throws.
    void stop();

    /// The live status.  Consistent field-by-field, not a torn struct: the
    /// publish half is written under the same mutex this reads.
    PreviewSnapshot snapshot() const;

    /// The throttle's current view, for the session's `meta.json` timing block.
    double effectiveIntervalMs() const;

private:
    /// The publish worker's body.  One iteration per handed-off frame.
    void workerLoop();
    /// Encode + atomic rename + counters.  Runs on the worker for `tick` and on
    /// the caller for `flush`; identical either way.  Holds no lock — the
    /// caller must own the `inFlight_` token before calling it.
    void publishNow(const cv::Mat& img, int64_t seq);

    /// Written once in `start`, before the worker exists; read unlocked from
    /// both threads afterwards.  Thread creation is the happens-before edge.
    PreviewConfig cfg_;

    /// ⚠ ENGINE THREAD ONLY.  `snapshot` runs on the RN NativeModules thread
    /// and must not read this object — a `double` read torn against a write is
    /// undefined, and the HUD would be reporting it.  The one field the panel
    /// needs is mirrored into `intervalEffPub_` after every update.
    PreviewThrottle throttle_;
    std::atomic<double> intervalEffPub_{120.0};

    /// The engine thread's render target.  Touched ONLY by `tick`/`flush`.
    cv::Mat render_;
    /// The worker's buffer.  Swapped with `render_` under `inFlight_`, which is
    /// the ownership token: while it is true the worker owns `outbox_`, and
    /// while it is false nobody does.  That is what makes this allocation-free
    /// and lock-free on the hot path.
    cv::Mat outbox_;

    /// Guards `pending_` / `outboxSeq_` / `cfg_` / `worker_` / `running_`.
    /// NOT `outbox_` — see that member.
    mutable std::mutex mu_;
    /// Engine thread -> worker: a frame is waiting.
    std::condition_variable cv_;
    /// Worker -> `flush`: the in-flight publish has landed.  A second variable
    /// rather than a shared one so a finalize cannot be woken by, and then
    /// re-sleep through, the hand-off it is not waiting for.
    std::condition_variable doneCv_;
    std::thread worker_;
    bool running_ = false;
    bool pending_ = false;
    bool quit_ = false;
    int64_t outboxSeq_ = 0;

    /// The coalescing token.  See `outbox_`.
    std::atomic<bool> inFlight_{false};

    /// Counters.  Atomic because `snapshot` reads them off the mutex's hot path
    /// and because the AR sync channel reads them on a third thread.
    std::atomic<int64_t> seqRendered_{0};
    std::atomic<int64_t> seqPublished_{0};
    std::atomic<int64_t> renders_{0};
    std::atomic<int64_t> published_{0};
    std::atomic<int64_t> skips_{0};
    std::atomic<int64_t> fails_{0};
    std::atomic<int> pubW_{0}, pubH_{0};

    /// Window placement of the most recent RENDER (not publish) — the frontier
    /// moves through the 2.4-2.9 s at the start of every sweep in which the
    /// band's extent does not, so this is published even when the render is
    /// later coalesced away.
    std::atomic<int> viewPx_{0}, bandPx_{0}, viewStartPx_{0};
    std::atomic<int> frontierFracMilli_{-1};
    std::atomic<bool> windowed_{false};

    /// First error, under `errMu_` — a string cannot be atomic and the failure
    /// path is cold.
    mutable std::mutex errMu_;
    std::string firstError_;
};

}  // namespace android
}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_ANDROID_PREVIEW_HPP
