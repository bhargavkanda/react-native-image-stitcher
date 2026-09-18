// SPDX-License-Identifier: Apache-2.0
//
// See rnis_pano_android_preview.hpp for what this is and why it is not inline
// in the JNI shim.  The comments below are only about the parts a reader would
// otherwise have to reverse-engineer.

#include "rnis_pano_android_preview.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>

namespace rnis {
namespace pano {
namespace android {

namespace {

/// The ceiling on the duty-throttled interval.  A render so expensive that its
/// 8% budget exceeds a second must still leave the panel updating — a frozen
/// preview reads as a crashed sweep, and the operator's response to that is to
/// stop and start again, which costs him the whole sweep.
constexpr double kMaxIntervalMs = 1000.0;

/// The floor `RNISPanoCore.mm:790` clamps to.  Repeated rather than shared
/// because the two adopt options from different bags; if they ever diverge the
/// test that pins this value is the thing that says so.
constexpr double kMinIntervalFloorMs = 50.0;

/// How long `flush` will wait for the worker's in-flight publish before giving
/// up and publishing anyway.  Bounded because this runs inside `stop()`, and an
/// unbounded wait there is an ANR: Android kills the app after 5 s on the main
/// thread and the operator loses the sweep AND the pack.
constexpr int kFlushWaitMs = 1000;

void appendJsonString(std::string& s, const std::string& v) {
    s.push_back('"');
    for (const char c : v) {
        switch (c) {
            case '"':  s += "\\\""; break;
            case '\\': s += "\\\\"; break;
            case '\n': s += "\\n";  break;
            case '\r': s += "\\r";  break;
            case '\t': s += "\\t";  break;
            default:
                // Control characters are not legal raw in JSON strings, and a
                // stray one in a libc error message would make JSON.parse throw
                // in JS three layers from here.
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x",
                                  static_cast<unsigned>(c) & 0xFFu);
                    s += buf;
                } else {
                    s.push_back(c);
                }
        }
    }
    s.push_back('"');
}

/// A finite double, or `0` — never `nan` / `inf`, which `JSON.parse` rejects.
void appendJsonNumber(std::string& s, double v, int decimals) {
    if (!std::isfinite(v)) {
        s += "0";
        return;
    }
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.*f", decimals, v);
    s += buf;
}

}  // namespace

double monotonicMs() {
    using namespace std::chrono;
    return duration<double, std::milli>(
               steady_clock::now().time_since_epoch()).count();
}

// ── PreviewThrottle ─────────────────────────────────────────────────────────

PreviewThrottle::PreviewThrottle(double intervalFloorMs, double maxDutyPct)
    : intervalFloorMs_(std::max(kMinIntervalFloorMs, intervalFloorMs)),
      maxDutyPct_(std::max(0.0, maxDutyPct)),
      intervalEffMs_(std::max(kMinIntervalFloorMs, intervalFloorMs)) {}

bool PreviewThrottle::due(double nowMs) const {
    // The FIRST tick is always due: before any attempt there is no clock to
    // measure against, and making the operator wait one interval for the first
    // sign of life is the difference between "it started" and "it is broken".
    if (!attempted_) return true;
    return (nowMs - lastAttemptMs_) >= intervalEffMs_;
}

void PreviewThrottle::markAttempt(double nowMs) {
    lastAttemptMs_ = nowMs;
    attempted_ = true;
}

void PreviewThrottle::markRender(double costMs) {
    if (!std::isfinite(costMs) || costMs < 0.0) costMs = 0.0;
    if (maxDutyPct_ <= 0.0) {
        // The throttle is off: the floor IS the schedule.  Still track the cost
        // so the pack can say what it would have done.
        costEwmaMs_ = (costEwmaMs_ < 0.0) ? costMs
                                          : (0.8 * costEwmaMs_ + 0.2 * costMs);
        intervalEffMs_ = intervalFloorMs_;
        return;
    }
    costEwmaMs_ = (costEwmaMs_ < 0.0) ? costMs
                                      : (0.8 * costEwmaMs_ + 0.2 * costMs);
    // The preview may occupy `maxDutyPct_` percent of the thread; at a measured
    // cost of `costEwma` per render that is one render every
    // `costEwma * 100 / duty` ms.  The FLOOR wins when the render is cheap,
    // which is the ordinary case.
    const double dutyFloor = costEwmaMs_ * 100.0 / maxDutyPct_;
    intervalEffMs_ = std::min(kMaxIntervalMs,
                              std::max(intervalFloorMs_, dutyFloor));
}

// ── previewStatusToJson ─────────────────────────────────────────────────────

std::string previewStatusToJson(const PreviewSnapshot& s) {
    std::string j;
    j.reserve(512);
    j += "{\"previewPath\":";
    appendJsonString(j, s.path);
    j += ",\"previewSeq\":" + std::to_string(s.publishedSeq);
    j += ",\"previewW\":" + std::to_string(s.w);
    j += ",\"previewH\":" + std::to_string(s.h);
    j += ",\"previewRenders\":" + std::to_string(s.renders);
    j += ",\"previewFails\":" + std::to_string(s.fails);
    j += ",\"previewSkips\":" + std::to_string(s.skips);
    j += ",\"previewIntervalMs\":";
    appendJsonNumber(j, s.intervalMs, 2);
    j += ",\"previewFrontierFrac\":";
    appendJsonNumber(j, s.frontierFrac, 4);
    j += ",\"previewViewPx\":" + std::to_string(s.viewPx);
    j += ",\"previewBandPx\":" + std::to_string(s.bandPx);
    j += ",\"previewViewStartPx\":" + std::to_string(s.viewStartPx);
    j += ",\"previewWindowed\":";
    j += (s.windowed ? "true" : "false");
    // NOT read by `coercePanoPlusStatus` — it is for the pack and for a console
    // session.  Emitted last so a reader can see at a glance that the contract
    // keys above are complete.
    j += ",\"previewPublished\":" + std::to_string(s.published);
    j += ",\"previewFirstError\":";
    appendJsonString(j, s.firstError);
    j += "}";
    return j;
}

// ── PreviewPump ─────────────────────────────────────────────────────────────

PreviewPump::PreviewPump() = default;

PreviewPump::~PreviewPump() { stop(); }

bool PreviewPump::start(const PreviewConfig& cfg, std::string* err) {
    if (err) err->clear();
    if (cfg.path.empty()) {
        if (err) *err = "preview path is empty";
        return false;
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (running_) {
            if (err) *err = "preview pump is already running";
            return false;
        }
        cfg_ = cfg;
        // The same clamps `RNISPanoCore.mm:790-810` applies, HERE rather than at
        // the option-reading site, so a caller that forgets them cannot ship a
        // 0 ms interval (a preview on every frame, i.e. the sweep's own budget
        // spent on looking at it) or a 3-pixel fit box.
        cfg_.intervalMs = std::max(kMinIntervalFloorMs, cfg_.intervalMs);
        cfg_.maxDutyPct = std::max(0.0, cfg_.maxDutyPct);
        cfg_.maxAlong = std::max(64, cfg_.maxAlong);
        cfg_.maxCross = std::max(64, cfg_.maxCross);
        cfg_.windowAlongPx = std::max(0, cfg_.windowAlongPx);
        cfg_.windowCrossMult = std::max(0.0, cfg_.windowCrossMult);
        cfg_.quality = std::min(100, std::max(1, cfg_.quality));
        throttle_ = PreviewThrottle(cfg_.intervalMs, cfg_.maxDutyPct);
        running_ = true;
        quit_ = false;
        pending_ = false;
        intervalEffPub_.store(throttle_.effectiveIntervalMs());
    }
    inFlight_.store(false);
    worker_ = std::thread([this] { workerLoop(); });
    return true;
}

bool PreviewPump::tick(const Engine& engine, double nowMs) {
    if (!running_) return false;
    if (!throttle_.due(nowMs)) return false;

    PreviewWindow win;
    bool ok = false;
    double costMs = 0.0;
    try {
        // The window in CANVAS px.  An explicit count wins; otherwise the ratio
        // is applied to the cross the publish will ACTUALLY carry — i.e. with
        // the pad rows trimmed when `cropPad` is on, which is what ships.
        // `previewCrossPx` and not `stats()` — `stats()` allocates seven
        // strings and this runs on the engine thread once per tick.
        //
        // NOT `canvasHeightPx()` (used here until 2026-09-04): that is the
        // PADDED height, so the window engaged ~27% late and the panorama drew
        // thin inside the fixed strip.  See the header's note on this method.
        int windowPx = cfg_.windowAlongPx;
        if (windowPx <= 0 && cfg_.windowCrossMult > 0.0) {
            const int ch = engine.previewCrossPx(cfg_.cropPad);
            if (ch > 0) {
                windowPx = static_cast<int>(
                    std::lround(cfg_.windowCrossMult * static_cast<double>(ch)));
            }
        }
        const double t0 = monotonicMs();
        ok = engine.previewIntoFit(render_, cfg_.maxAlong, cfg_.maxCross,
                                   windowPx, &win, cfg_.cropPad, cfg_.leadOut);
        costMs = monotonicMs() - t0;
    } catch (...) {
        // `previewIntoFit` is documented not to throw, but it is an OpenCV
        // consumer and a cv::Exception out of here would abort a sweep that is
        // otherwise fine.  A preview is never worth the sweep.
        ok = false;
    }

    // ⚠ ON EVERY ATTEMPT, INCLUDING A REFUSED ONE.  See PreviewThrottle::
    // markAttempt — the iOS version of this clock did not advance here and
    // re-probed a pre-latch engine at 60 Hz.
    throttle_.markAttempt(nowMs);
    if (!ok || render_.empty()) return false;

    throttle_.markRender(costMs);
    // The one throttle field the panel reads, mirrored for cross-thread readers
    // — see the `throttle_` declaration for why they may not read it directly.
    intervalEffPub_.store(throttle_.effectiveIntervalMs());
    const int64_t seq = seqRendered_.fetch_add(1) + 1;
    renders_.fetch_add(1);

    // WHERE THIS PREVIEW SITS, stored on the RENDER and not the publish: the
    // frontier moves through the 2.4-2.9 s at the start of every sweep in which
    // the painted band's extent does not, so a coalesced-away render still
    // carries the only news there is.
    viewPx_.store(win.viewEndU - win.viewStartU);
    bandPx_.store(win.bandEndU - win.bandStartU);
    viewStartPx_.store(win.viewStartU - win.bandStartU);
    windowed_.store(win.windowed);
    frontierFracMilli_.store(
        win.frontierFrac < 0.0
            ? -1
            : static_cast<int>(std::lround(win.frontierFrac * 1000.0)));

    // ── COALESCE, do not queue ──────────────────────────────────────────────
    // A backlog of stale panoramas is worth nothing; only the newest one is.
    // The token also grants the worker exclusive use of `outbox_`, which is what
    // makes the swap below allocation-free and the publish lock-free.
    bool expected = false;
    if (!inFlight_.compare_exchange_strong(expected, true)) {
        skips_.fetch_add(1);
        return true;
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        // SWAP, not assign.  An assignment would make `render_` and `outbox_`
        // share one buffer, and the next `previewIntoFit` would then reallocate
        // (cv::Mat::create refuses to write through a shared reference) — one
        // 1.7 MB allocation per tick, forever.  The swap gives us a genuine
        // double buffer whose steady-state allocation count is two.
        cv::swap(render_, outbox_);
        outboxSeq_ = seq;
        pending_ = true;
    }
    cv_.notify_one();
    return true;
}

void PreviewPump::workerLoop() {
    std::unique_lock<std::mutex> lk(mu_);
    for (;;) {
        cv_.wait(lk, [this] { return pending_ || quit_; });
        if (pending_) {
            pending_ = false;
            const int64_t seq = outboxSeq_;
            lk.unlock();
            // `outbox_` is read WITHOUT the mutex, and that is deliberate: it is
            // guarded by `inFlight_`, not by `mu_`.  Holding `mu_` across a
            // ~5-15 ms JPEG encode would put the engine thread's swap behind it
            // on every tick, which is the one thing this worker exists to avoid.
            publishNow(outbox_, seq);
            lk.lock();
            inFlight_.store(false);
            // Under the mutex so `flush`'s wait predicate cannot miss the edge.
            doneCv_.notify_all();
            continue;
        }
        if (quit_) return;
    }
}

void PreviewPump::publishNow(const cv::Mat& img, int64_t seq) {
    if (img.empty()) {
        fails_.fetch_add(1);
        std::lock_guard<std::mutex> lk(errMu_);
        if (firstError_.empty()) firstError_ = "render produced an empty image";
        return;
    }
    std::string err;
    bool ok = false;
    try {
        ok = rnis::pano::publishJpegAtomically(cfg_.path, img, cfg_.quality,
                                               &err);
    } catch (const std::exception& e) {
        // `publishJpegAtomically` is documented never to throw; the catch is
        // for the day that stops being true, because an escaping exception on
        // this thread is std::terminate and takes the whole app with it.
        ok = false;
        err = std::string("publish threw: ") + e.what();
    } catch (...) {
        ok = false;
        err = "publish threw an unknown native error";
    }
    if (ok) {
        // ONLY NOW is there a file to point JS at.  Dims FIRST, then the seq —
        // JS keys its cache-bust off the seq, so a reader that sees the new seq
        // must already see the dims.  These are seq_cst, so that holds.
        pubW_.store(img.cols);
        pubH_.store(img.rows);
        seqPublished_.store(seq);
        published_.fetch_add(1);
        return;
    }
    // NEVER SILENT.  The previous iOS publisher swallowed a cv::Exception here
    // on every tick of every sweep for eleven days: the panel was empty, the
    // engine was fine, and no number anywhere disagreed with either.
    fails_.fetch_add(1);
    std::lock_guard<std::mutex> lk(errMu_);
    if (firstError_.empty()) {
        firstError_ = err.empty() ? "preview publish failed" : err;
    }
}

bool PreviewPump::flush(const Engine& engine, double nowMs, std::string* err) {
    if (err) err->clear();
    if (!running_) {
        if (err) *err = "preview pump is not running";
        return false;
    }
    // Let the worker's in-flight publish land first, so the LAST write wins the
    // rename rather than racing it.  Bounded — see kFlushWaitMs.
    {
        std::unique_lock<std::mutex> lk(mu_);
        doneCv_.wait_for(lk, std::chrono::milliseconds(kFlushWaitMs),
                         [this] { return !inFlight_.load(); });
    }

    PreviewWindow win;
    bool ok = false;
    try {
        // Same cross as the live path above — `previewCrossPx`, not the padded
        // `canvasHeightPx`.
        int windowPx = cfg_.windowAlongPx;
        if (windowPx <= 0 && cfg_.windowCrossMult > 0.0) {
            const int ch = engine.previewCrossPx(cfg_.cropPad);
            if (ch > 0) {
                windowPx = static_cast<int>(
                    std::lround(cfg_.windowCrossMult * static_cast<double>(ch)));
            }
        }
        ok = engine.previewIntoFit(render_, cfg_.maxAlong, cfg_.maxCross,
                                   windowPx, &win, cfg_.cropPad, cfg_.leadOut);
    } catch (...) {
        ok = false;
    }
    if (!ok || render_.empty()) {
        // Nothing was ever painted.  Not an error: an aborted or empty sweep
        // has no panorama, and the session's own summary says so.
        if (err) *err = "nothing painted — no final preview to publish";
        return false;
    }

    viewPx_.store(win.viewEndU - win.viewStartU);
    bandPx_.store(win.bandEndU - win.bandStartU);
    viewStartPx_.store(win.viewStartU - win.bandStartU);
    windowed_.store(win.windowed);
    frontierFracMilli_.store(
        win.frontierFrac < 0.0
            ? -1
            : static_cast<int>(std::lround(win.frontierFrac * 1000.0)));

    const int64_t seq = seqRendered_.fetch_add(1) + 1;
    renders_.fetch_add(1);
    (void)nowMs;  // the throttle is deliberately bypassed; see the header.

    // Take the token so a stray tick cannot interleave a second rename onto the
    // same path while this one is mid-write.  Released whatever happens.
    //
    // ⚠ WHAT HAPPENS WHEN THE TOKEN IS NOT AVAILABLE, stated rather than
    // hidden: the wait above timed out, so a worker publish is still running
    // and both writers are aiming at the same `preview.jpg` through the same
    // `.part`.  We publish ANYWAY and accept that one of the two renames may
    // fail — it is counted, not silent.  The alternative is skipping the final
    // republish, which leaves the panel frozen one throttle tick short of the
    // sweep the operator just finished; that reads exactly like a sweep that
    // stalled, and this whole file exists because of what he does when he
    // believes that.  A 1 s timeout means the phone is already in trouble.
    bool expected = false;
    const bool tookToken = inFlight_.compare_exchange_strong(expected, true);
    const int64_t before = published_.load();
    publishNow(render_, seq);
    if (tookToken) {
        std::lock_guard<std::mutex> lk(mu_);
        inFlight_.store(false);
        doneCv_.notify_all();
    }
    if (published_.load() > before) return true;
    if (err) {
        std::lock_guard<std::mutex> lk(errMu_);
        *err = firstError_.empty() ? "final preview publish failed" : firstError_;
    }
    return false;
}

void PreviewPump::stop() {
    std::thread t;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (!running_) return;
        running_ = false;
        quit_ = true;
        t = std::move(worker_);
    }
    cv_.notify_all();
    if (t.joinable()) {
        // The worker drains whatever is pending before it sees `quit_`, so a
        // preview handed off one tick before stop() still reaches disk.
        t.join();
    }
}

PreviewSnapshot PreviewPump::snapshot() const {
    PreviewSnapshot s;
    {
        std::lock_guard<std::mutex> lk(mu_);
        s.path = cfg_.path;
    }
    s.publishedSeq = seqPublished_.load();
    s.w = pubW_.load();
    s.h = pubH_.load();
    s.renders = renders_.load();
    s.published = published_.load();
    s.skips = skips_.load();
    s.fails = fails_.load();
    s.intervalMs = intervalEffPub_.load();
    const int milli = frontierFracMilli_.load();
    s.frontierFrac = (milli < 0) ? -1.0 : (static_cast<double>(milli) / 1000.0);
    s.viewPx = viewPx_.load();
    s.bandPx = bandPx_.load();
    s.viewStartPx = viewStartPx_.load();
    s.windowed = windowed_.load();
    {
        std::lock_guard<std::mutex> lk(errMu_);
        s.firstError = firstError_;
    }
    return s;
}

double PreviewPump::effectiveIntervalMs() const {
    return intervalEffPub_.load();
}

}  // namespace android
}  // namespace pano
}  // namespace rnis
