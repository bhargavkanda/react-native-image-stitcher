// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_live.cpp — see the header for what this owns and, more
// importantly, for what it deliberately does NOT own (threads).
//
// Every decision here has a twin in ios/RNISPanoCore.mm and the twin is named
// in the comment, because the two must not drift: one operator sweeping on an
// iPhone and the same operator sweeping on the A35 have to be looking at the
// same engine behaving the same way, and the only thing the port is allowed to
// change is how pixels and poses REACH it.

#include "rnis_pano_live.hpp"

#include "rnis_pano_android_preview.hpp"
#include "rnis_pano_replay.hpp"

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <sys/stat.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace rnis {
namespace pano {
namespace live {

namespace {

// ── JSON out ────────────────────────────────────────────────────────────────
// Same precisions as RNISPanoCore.mm's writers and rnis_pano_replay.cpp's, so
// a number that appears in both a live pack and a replay report is the same
// text.  Hand-rolled for the reason the replay driver states: the engine's
// dependency set has no JSON library and the Android build must not pull one
// the shipped engine does not have.

void jnum(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    s += buf;
}

void jint(std::string& s, long long v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", v);
    s += buf;
}

void jstr(std::string& s, const std::string& v) {
    s += '"';
    for (size_t i = 0; i < v.size(); ++i) {
        const unsigned char c = (unsigned char)v[i];
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
    s += '"';
}

void kv(std::string& s, const char* k) {
    if (!s.empty() && s[s.size() - 1] != '{' && s[s.size() - 1] != ',') s += ',';
    s += '"'; s += k; s += "\":";
}

void kvNum(std::string& s, const char* k, double v) { kv(s, k); jnum(s, v); }
void kvInt(std::string& s, const char* k, long long v) { kv(s, k); jint(s, v); }
void kvBool(std::string& s, const char* k, bool v) { kv(s, k); s += (v ? "true" : "false"); }
void kvStr(std::string& s, const char* k, const std::string& v) { kv(s, k); jstr(s, v); }

// ── paths ───────────────────────────────────────────────────────────────────
// POSIX, not <filesystem>, for the reason rnis_pano_replay.cpp documents: the
// libc++ filesystem archive's availability has moved across NDK releases and
// minSdk levels, and this file needs exactly one operation.

std::string joinPath(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    if (b.empty()) return a;
    if (a[a.size() - 1] == '/') return a + b;
    return a + "/" + b;
}

/// mkdir -p.  Returns false only when the leaf is not a directory afterwards.
bool ensureDir(const std::string& d) {
    if (d.empty()) return false;
    std::string acc;
    size_t i = 0;
    if (d[0] == '/') { acc = "/"; i = 1; }
    while (i <= d.size()) {
        const size_t nx = d.find('/', i);
        const size_t e = (nx == std::string::npos) ? d.size() : nx;
        if (e > i) {
            if (acc.size() > 1 || (acc.size() == 1 && acc[0] != '/')) acc += "/";
            acc += d.substr(i, e - i);
            ::mkdir(acc.c_str(), 0777);
        }
        if (nx == std::string::npos) break;
        i = nx + 1;
    }
    struct stat st;
    return ::stat(d.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

double nowMs() {
    using namespace std::chrono;
    return (double)duration_cast<microseconds>(
               steady_clock::now().time_since_epoch()).count() / 1000.0;
}

/// Unix epoch milliseconds — the ONE place a wall clock is read, and only for
/// the pack's `startedAtMs` (which JS shows the operator).  Every DURATION in
/// this file comes off `nowMs()`'s monotonic clock instead, because a wall
/// clock can step and a stepped clock turns a measurement into a plausible
/// wrong number nobody can tell from a real one.
double wallMs() {
    using namespace std::chrono;
    return (double)duration_cast<milliseconds>(
               system_clock::now().time_since_epoch()).count();
}

/// A bounded sample keeper.  Bounded because it lives for the whole sweep on a
/// per-frame path: 4096 samples is ~2 minutes at 30 fps and 32 KB, and past
/// that the OLDEST are dropped so the percentiles describe the recent sweep
/// rather than growing without limit.  (iOS keeps unbounded std::vectors; on a
/// 1.33 GB-peak phone that trade is not available.)
class Samples {
public:
    void add(double v) {
        if (!std::isfinite(v)) return;
        ++n_;
        if (v > max_) max_ = v;
        if (buf_.size() < kCap) buf_.push_back(v);
        else { buf_[cursor_] = v; cursor_ = (cursor_ + 1) % kCap; }
    }
    long long count() const { return n_; }
    double max() const { return n_ > 0 ? max_ : 0.0; }
    double pct(double p) const {
        if (buf_.empty()) return 0.0;
        std::vector<double> c(buf_);
        std::sort(c.begin(), c.end());
        size_t k = (size_t)std::lround(p * (double)(c.size() - 1));
        if (k >= c.size()) k = c.size() - 1;
        return c[k];
    }
    void appendJson(std::string& s, const char* key) const {
        kv(s, key);
        s += "{";
        kvNum(s, "p50", pct(0.50));
        kvNum(s, "p99", pct(0.99));
        kvNum(s, "max", max());
        kvInt(s, "n", n_);
        s += "}";
    }
private:
    static const size_t kCap = 4096;
    std::vector<double> buf_;
    size_t cursor_ = 0;
    long long n_ = 0;
    double max_ = 0.0;
};

}  // namespace

// ════════════════════════════════════════════════════════════════════════════
//  Impl
// ════════════════════════════════════════════════════════════════════════════

struct Session::Impl {
    Options opt;
    Config  cfg;
    Engine  engine;

    bool running = false;
    bool started = false;

    std::string sessionDir, packDir, framesDir;
    std::string previewPath, canvasPath, metaPath, ledgerPath, trackPath;

    std::FILE* ledgerFp = nullptr;
    long long  ledgerRows = 0;

    double startedWallMs = 0.0;
    double startedMs = 0.0;
    double firstTsNs = 0.0, lastTsNs = 0.0;
    /// The last ingested frame's tracking (0 notAvailable / 1 limited /
    /// 2 normal).  Written on the ingest thread, read by the status poll on
    /// another; an int race here is a one-tick-stale HUD value and nothing
    /// more, which is why it is not worth a lock on the frame path.
    int lastTracking = 0;

    // ── Counters ────────────────────────────────────────────────────────
    long long engineFrames = 0;
    long long framesWritten = 0;
    long long frameWriteFailed = 0;
    long long droppedPack = 0;      // pack frames declined by the cap
    long long packBytes = 0;
    bool      frameCapHit = false;
    long long convertFailed = 0;
    std::string firstError;

    Samples engineMs, previewMs, ingestMs;

    // ── The live preview ────────────────────────────────────────────────
    // Owned wholesale by the pump: refresh throttle, render, coalesced atomic
    // publish, its own worker thread, and the counters the panel's alarms
    // read.  This session calls `tick` once per ingest and reads `snapshot()`
    // for the status — it re-implements none of it.
    android::PreviewPump preview;
    bool previewArmed = false;
    std::string previewStartError;

    // ── Status snapshot ─────────────────────────────────────────────────
    mutable std::mutex statusMu;
    std::string        statusCache;

    void closeLedger() {
        if (ledgerFp != nullptr) {
            std::fflush(ledgerFp);
            std::fclose(ledgerFp);
            ledgerFp = nullptr;
        }
    }

    void noteError(const std::string& e) {
        if (firstError.empty()) firstError = e;
    }
};

// ════════════════════════════════════════════════════════════════════════════
//  Lifecycle
// ════════════════════════════════════════════════════════════════════════════

Session::Session() : impl_(new Impl()) {}

Session::~Session() {
    if (impl_ != nullptr) impl_->closeLedger();
}

StartReport Session::start(const Options& opt) {
    StartReport R;
    Impl& S = *impl_;

    if (S.running) {
        R.error = "a pano+ sweep is already running";
        return R;
    }
    if (opt.sessionDir.empty()) {
        R.error = "sessionDir is required";
        return R;
    }

    S.opt = opt;
    // ── ONE DIRECTORY, THE SAME SHAPE AS iOS ────────────────────────────
    // `sessionDir` IS the pack directory, exactly as `RNISPanoCore.mm`'s `dir`
    // is: frames/ beside preview.jpg, canvas.jpg, meta.json, ledger.jsonl and
    // the capture arm's track.jsonl.  The Android recorder passes its own
    // `packDir` here, so a live pack and a recorded pack are the same layout
    // and one replay driver reads both without a mode flag.
    S.sessionDir = opt.sessionDir;
    S.packDir    = opt.sessionDir;
    S.framesDir  = joinPath(S.packDir, "frames");
    if (!ensureDir(S.framesDir)) {
        R.error = "could not create " + S.framesDir;
        return R;
    }

    S.previewPath = joinPath(S.packDir, "preview.jpg");
    S.canvasPath  = joinPath(S.packDir, "canvas.jpg");
    S.metaPath    = joinPath(S.packDir, "meta.json");
    S.ledgerPath  = joinPath(S.packDir, "ledger.jsonl");
    S.trackPath   = joinPath(S.packDir, "track.jsonl");

    // ── Engine config ───────────────────────────────────────────────────
    S.cfg = Config();
    // ANDROID DEFAULT, applied BEFORE the caller's overrides so an explicit
    // knob still wins.  8e6 canvas px is 32 MB of canvas + coverage against
    // iOS's 18e6 / 72 MB — and ~1.75× that transiently while the canvas grows.
    // The operator's own A35 sweep finished at 2048×1216 = 2.5e6, so this is
    // 3× his measured need and not a limit he is likely to reach; discovering
    // a 126 MB transient on a process that has peaked at 1.33 GB is the
    // outcome this default exists to avoid.
    S.cfg.canvasMaxPixels = 8.0e6;

    for (size_t i = 0; i < opt.configOverrides.size(); ++i) {
        const std::string& name = opt.configOverrides[i].first;
        const std::string& val  = opt.configOverrides[i].second;
        const int rc = replay::applyConfigOverride(S.cfg, name, val);
        if (rc == 1) R.overridesApplied.push_back(name);
        else if (rc == 0) R.overridesUnknown.push_back(name);
        else R.overridesMalformed.push_back(name);
    }

    std::string cfgErr;
    if (!S.engine.configure(S.cfg, &cfgErr)) {
        R.error = "engine.configure refused: " + cfgErr;
        return R;
    }

    if (opt.writeLedger) {
        S.ledgerFp = std::fopen(S.ledgerPath.c_str(), "wb");
        if (S.ledgerFp == nullptr) {
            // NOT fatal.  A sweep with no ledger is a worse pack but still a
            // panorama, and refusing to capture because a debug file could not
            // be opened would cost the operator the trip.
            S.noteError("could not open " + S.ledgerPath + " for writing");
        }
    }

    // ── Arm the preview pump ────────────────────────────────────────────
    // A pump that refuses is NOT a reason to refuse the sweep: the panorama is
    // the deliverable and the preview is how the operator aims.  It is
    // recorded, surfaced in the status, and the sweep proceeds blind — which
    // is strictly better than a start() rejection he cannot act on in an aisle.
    android::PreviewConfig pc;
    pc.path = S.previewPath;
    pc.intervalMs = opt.previewIntervalMs;
    pc.maxDutyPct = opt.previewMaxDutyPct;
    pc.maxAlong = opt.previewMaxAlong;
    pc.maxCross = opt.previewMaxCross;
    pc.windowAlongPx = opt.previewWindowAlongPx;
    pc.windowCrossMult = opt.previewWindowCrossMult;
    pc.cropPad = opt.previewCropPad;
    pc.leadOut = opt.previewLeadOut;
    pc.quality = opt.previewQuality;
    S.previewArmed = S.preview.start(pc, &S.previewStartError);
    if (!S.previewArmed) S.noteError("preview pump: " + S.previewStartError);

    S.startedWallMs = wallMs();
    S.startedMs = nowMs();
    S.running = true;
    S.started = true;

    R.ok = true;
    R.sessionDir = S.sessionDir;
    R.packDir = S.packDir;
    R.framesDir = S.framesDir;
    R.previewPath = S.previewPath;
    R.canvasPath = S.canvasPath;
    R.metaPath = S.metaPath;
    R.ledgerPath = S.ledgerPath;
    R.trackPath = S.trackPath;
    R.canvasMaxPixels = S.cfg.canvasMaxPixels;
    return R;
}

bool Session::running() const noexcept { return impl_->running; }

// ════════════════════════════════════════════════════════════════════════════
//  Ingest — the frame path
// ════════════════════════════════════════════════════════════════════════════

IngestReport Session::ingest(const unsigned char* nv21, size_t len,
                             const FrameIn& in) {
    IngestReport out;
    Impl& S = *impl_;
    if (!S.running) return out;

    const double t0 = nowMs();

    if (nv21 == nullptr || in.width <= 0 || in.height <= 0) {
        out.error = "null buffer or degenerate dimensions";
        ++S.convertFailed;
        S.noteError(out.error);
        return out;
    }
    // (w × h × 3) / 2 exactly.  A short buffer would read past the end inside
    // cvtColor, which on a phone is a native crash and not an exception —
    // refuse it here where the reason can still be named.
    const size_t need = (size_t)in.width * (size_t)in.height * 3u / 2u;
    if (len < need) {
        char b[160];
        std::snprintf(b, sizeof(b),
                      "NV21 buffer is %zu bytes but %dx%d needs %zu",
                      len, in.width, in.height, need);
        out.error = b;
        ++S.convertFailed;
        S.noteError(out.error);
        return out;
    }

    cv::Mat bgr, grayWork;
    rnis::pano::FrameOutcome row;
    try {
        // ── Conversion ──────────────────────────────────────────────────
        // `bgr` is allocated FRESH (cvtColor into an empty Mat allocates) and
        // must be: the engine keeps a shallow reference to the last PAINTED
        // frame's bgr for the finalize tail flush, so a pooled buffer would be
        // overwritten under it.  Same allocation iOS makes, same reason.
        //
        // The Y PLANE IS LUMA — no colour conversion for the registration
        // channel, just a resize.  Wrapping the caller's buffer costs nothing:
        // cvtColor and resize both read it before this function returns and
        // neither retains it.
        const cv::Mat yuv(in.height + in.height / 2, in.width, CV_8UC1,
                          const_cast<unsigned char*>(nv21));
        cv::cvtColor(yuv, bgr, cv::COLOR_YUV2BGR_NV21);
        const cv::Mat y(in.height, in.width, CV_8UC1,
                        const_cast<unsigned char*>(nv21));
        cv::resize(y, grayWork, cv::Size(), S.cfg.workScale, S.cfg.workScale,
                   cv::INTER_AREA);
    } catch (const cv::Exception& e) {
        out.error = std::string("frame conversion failed: ") + e.what();
        ++S.convertFailed;
        S.noteError(out.error);
        return out;
    } catch (...) {
        out.error = "frame conversion failed (unknown native error)";
        ++S.convertFailed;
        S.noteError(out.error);
        return out;
    }

    rnis::pano::FrameInput fi;
    fi.bgr = &bgr;
    fi.grayWork = &grayWork;
    fi.tsNs = in.tsNs;
    fi.fx = in.fx; fi.fy = in.fy; fi.cx = in.cx; fi.cy = in.cy;
    fi.imageWidth = in.width; fi.imageHeight = in.height;
    for (int k = 0; k < 4; ++k) fi.q[k] = in.q[k];
    // ⚠ TRANSLATION IS IDENTICALLY ZERO on this arm, and that is a statement
    // about the producer, not a placeholder.  Camera2 + TYPE_ROTATION_VECTOR
    // gives attitude and nothing else, so every engine consumer of `t` goes
    // inert exactly as it does on iOS's decoupled AVFoundation arm:
    //   · the pose-speed cage (maxSweepSpeedMps / poseSlackM) never fires and
    //     `counts.rejectedPoseSpeed` is structurally 0 — NOT "no lurch
    //     happened";
    //   · the session-restart detector (maxTranslationJumpM) never fires;
    //   · the regime read-out's rotationFraction is 1.0 by construction.
    // `meta.json → poseSource` carries this so the zeros are attributable.
    fi.t[0] = fi.t[1] = fi.t[2] = 0.0;
    fi.tracking = in.tracking;
    fi.seq = (int64_t)in.seq;
    fi.exposureDurationS = in.exposureDurationS;
    fi.exposureISO = in.exposureISO;
    // arExposure* stay unset: those are ARKit's own numbers, read off an
    // ARFrame.  There is no ARFrame here, and a zero that MEANT something
    // would be worse than the absent-by-construction zero the engine already
    // treats as "not available".

    try {
        row = S.engine.ingest(fi);
    } catch (const std::exception& e) {
        out.error = std::string("engine.ingest threw: ") + e.what();
        S.noteError(out.error);
        return out;
    } catch (...) {
        out.error = "engine.ingest threw an unknown native error";
        S.noteError(out.error);
        return out;
    }

    out.ran = true;
    out.outcome = (int)row.outcome;
    out.engineMs = row.engineMs;
    out.painted = (row.outcome == Outcome::Painted ||
                   row.outcome == Outcome::GapExtended ||
                   row.outcome == Outcome::GapBreak ||
                   row.outcome == Outcome::Bootstrap);

    ++S.engineFrames;
    S.lastTracking = in.tracking;
    S.engineMs.add(row.engineMs);
    if (S.firstTsNs == 0.0) S.firstTsNs = in.tsNs;
    S.lastTsNs = in.tsNs;

    // ── Live preview ────────────────────────────────────────────────────
    // ONE call.  The pump decides whether the refresh is due, renders through
    // `Engine::previewIntoFit` (which turns the fit box with the latched sweep
    // axis), hands the mat to its own worker for the encode + atomic rename,
    // and keeps the four counters the panel's alarms read.  It is called from
    // the ENGINE thread and only from there, which is its stated contract and
    // is why the engine needs no lock — exactly as on iOS.
    if (S.previewArmed) {
        const double pv0 = nowMs();
        const bool rendered = S.preview.tick(S.engine, android::monotonicMs());
        if (rendered) {
            out.previewRendered = true;
            // MEASURED on the ingest thread, because that is the one per-tick
            // cost that can plausibly delay a frame.  Samples are RENDERS only
            // — a refused tick is ~free and folding it in would report a p50
            // of 0.00 for a render that never got cheaper (the v12 defect).
            S.previewMs.add(nowMs() - pv0);
        }
    }

    // ── Pack frame ──────────────────────────────────────────────────────
    // On the SAME thread as the engine, deliberately: a third thread would
    // need its own copy of `bgr` (6.2 MB at 1920×1080) to outlive this call,
    // and the memory budget in the header does not have room for a queue of
    // them.  The cost is throughput, which is why `PackFrames::None` is the
    // Android default and why choosing `All` is documented as costing frame
    // rate rather than being free.
    const bool wantFrame =
        S.opt.packFrames == PackFrames::All ||
        (S.opt.packFrames == PackFrames::Painted && out.painted);
    if (wantFrame) {
        const int everyN = S.opt.packFrameEveryN > 0 ? S.opt.packFrameEveryN : 1;
        if ((in.seq % everyN) != 0) {
            // cadence, not a drop
        } else if (S.framesWritten >= (long long)S.opt.packMaxFrames) {
            ++S.droppedPack;
            S.frameCapHit = true;
        } else {
            char name[64];
            std::snprintf(name, sizeof(name), "frame_%06lld.jpg", (long long)in.seq);
            const std::string path = joinPath(S.framesDir, name);
            bool wrote = false;
            try {
                std::vector<int> params;
                params.push_back(cv::IMWRITE_JPEG_QUALITY);
                params.push_back(S.opt.packFrameQuality);
                wrote = cv::imwrite(path, bgr, params);
            } catch (const cv::Exception& e) {
                S.noteError(std::string("pack frame: ") + e.what());
            } catch (...) {
                S.noteError("pack frame: unknown native error");
            }
            if (wrote) {
                ++S.framesWritten;
                struct stat st;
                if (::stat(path.c_str(), &st) == 0) S.packBytes += (long long)st.st_size;
            } else {
                // NOT swallowed: `framesWritten` must never overstate what is
                // on disk or the pack lies about its own contents.
                ++S.frameWriteFailed;
            }
        }
    }

    // ── Ledger row ──────────────────────────────────────────────────────
    if (S.ledgerFp != nullptr) {
        std::string line;
        replay::appendLedgerLine(line, row);
        std::fwrite(line.data(), 1, line.size(), S.ledgerFp);
        // Periodic flush, iOS's rule and its reason: a background kill
        // mid-sweep must not cost the ledger.  30 rows is ~1 s at 30 fps.
        if ((++S.ledgerRows % 30) == 0) std::fflush(S.ledgerFp);
    }

    out.totalMs = nowMs() - t0;
    S.ingestMs.add(out.totalMs);

    // ── Status snapshot ─────────────────────────────────────────────────
    // Built here, cached, and handed to whichever thread polls — the Android
    // leg has NO push channel (iOS rides the AR plugin's synchronous return),
    // so this is the operator's only live signal.
    {
        std::string s;
        appendStatus(s, &row);
        std::lock_guard<std::mutex> g(S.statusMu);
        S.statusCache.swap(s);
    }
    return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  Status
// ════════════════════════════════════════════════════════════════════════════

void Session::appendStatus(std::string& s, const FrameOutcome* row) const {
    const Impl& S = *impl_;
    const SessionStats st = S.engine.stats();

    s += "{";
    // `running` is the ONE field the JS coercion treats as mandatory: its
    // absence means "not a pano+ status" and the tick is dropped whole.
    kvBool(s, "running", S.running);
    kvStr(s, "sessionDir", S.sessionDir);
    kvInt(s, "seq", row != nullptr ? (long long)row->seq : -1);
    kvInt(s, "framesSeen", st.seen);
    kvInt(s, "painted", st.painted);
    kvInt(s, "heldBacktrack", st.heldBacktrack);
    kvInt(s, "heldFrontier", st.heldFrontier);
    kvInt(s, "skippedNoAdvance", st.skippedNoAdvance);
    kvInt(s, "rejectedLowResponse", st.rejectedLowResponse);
    kvInt(s, "rejectedOutOfCage", st.rejectedOutOfCage);
    kvInt(s, "rejectedPoseSpeed", st.rejectedPoseSpeed);
    kvInt(s, "rejectedTracking", st.rejectedTracking);
    kvInt(s, "rejectedRectify", st.rejectedRectify);
    kvInt(s, "gapExtended", st.gapExtended);
    kvInt(s, "gapBreak", st.gapBreak);
    kvInt(s, "gapBackfilled", st.gapBackfilled);
    kvInt(s, "limitedFrames", st.limitedFrames);
    // PERPENDICULAR TRUNCATION, live.  The hole gate only looks ALONG the
    // sweep, so without these two the operator can watch a clean-looking HUD
    // while the panorama loses shelf height.
    kvInt(s, "clippedFrames", st.clippedFrames);
    kvInt(s, "clippedColumns", st.clippedColumns);
    kvInt(s, "canvasHeightPx", st.canvasH);
    kvInt(s, "paintedWidthPx", st.paintedW);
    kvInt(s, "canvasWidthPx", st.canvasW);

    double mag = 0.0;
    if (row != nullptr) {
        mag = std::sqrt(row->advanceX * row->advanceX + row->advanceY * row->advanceY);
    }
    kvNum(s, "advancePx", mag);
    kvNum(s, "stripPx", row != nullptr ? row->stripW : 0.0);
    kvStr(s, "outcome",
          row != nullptr ? std::string(outcomeName(row->outcome)) : std::string(""));
    const char* speed = "ok";
    if (row != nullptr) {
        if (row->outcome == Outcome::SkippedNoAdvance || mag < S.cfg.minAdvancePx) {
            speed = "no-motion";
        } else if (st.maxAdvancePxResolved > 0 && mag > 0.6 * st.maxAdvancePxResolved) {
            speed = "fast";
        }
    }
    kvStr(s, "speed", std::string(speed));
    kvBool(s, "stalled", st.stalled);
    kvBool(s, "axisLatched", st.axisLatched);
    kvInt(s, "axis", st.axis);
    kvInt(s, "sweepSign", st.sweepSign);
    kvNum(s, "maxRectifyDeg", st.maxRectifyDeg);
    kvNum(s, "maxAreaScale", st.maxAreaScalePainted);
    kvNum(s, "seamWorstBandP95Px", st.seamWorstBandP95Px);
    kvNum(s, "seamWorstBandMaxPx", st.seamWorstBandMaxPx);
    kvNum(s, "crossBandDivergencePx", st.crossBandDivergencePx);
    kvNum(s, "crossBandDivergenceNormPx", st.crossBandDivergenceNormPx);
    kvNum(s, "seamCanvasJogP95Px", st.seamCanvasJogP95Px);
    kvNum(s, "seamCanvasJogMaxPx", st.seamCanvasJogMaxPx);
    kvNum(s, "seamPhotoStepP95DN", st.seamPhotoStepP95DN);
    kvNum(s, "seamPhotoStepMaxDN", st.seamPhotoStepMaxDN);
    kvInt(s, "seamPhotoStepOverBar", st.seamPhotoStepOverBar);
    kvInt(s, "seamPhotoSamples", st.seamPhotoSamples);
    kvNum(s, "photoDriftLocalPct", st.seamPhotoDriftLocalPct);
    kvNum(s, "photoDriftTotalPct", st.seamPhotoDriftTotalPct);
    // 1.00 with exposureMetaFrames > 0 is the live proof the AE lock held.
    // 1.00 with exposureMetaFrames == 0 is UNKNOWN, and the HUD must be able
    // to tell those apart.
    kvNum(s, "exposureRangeRatio", st.exposureRangeRatio);
    kvInt(s, "exposureMetaFrames", st.exposureMetaFrames);
    kvBool(s, "seamBandSelfScored", st.seamBandSelfScored);
    kvBool(s, "seamMeasured", st.seamMeasured);
    kvBool(s, "integrityFailed", st.integrityFailed);
    kvInt(s, "projection", st.projection);
    kvNum(s, "maxCrossRectifyDeg", st.maxCrossRectifyDeg);
    // 1 = a pivot, 0 = a walk.  Until the axis latches this is the only signal
    // that says WHY nothing is painting.  ⚠ On this arm `t` is identically
    // zero, so it is 1.0 by construction — see the note in ingest().
    kvNum(s, "rotationFraction", st.rotationFraction);
    kvInt(s, "relatchCount", st.relatchCount);
    if (row != nullptr) {
        kvNum(s, "advanceRotPx",
              std::sqrt(row->advanceRotX * row->advanceRotX +
                        row->advanceRotY * row->advanceRotY));
        kvNum(s, "engineMs", row->engineMs);
    } else {
        kvNum(s, "advanceRotPx", 0.0);
        kvNum(s, "engineMs", 0.0);
    }
    // The LAST INGESTED FRAME's tracking, not a constant.  It used to be
    // hardcoded 0, which told the HUD "no attitude channel" on every tick of a
    // perfectly healthy sweep — and `tracking` is the field the operator is
    // meant to read when nothing is painting.
    kvInt(s, "tracking", S.lastTracking);

    // ── Preview ─────────────────────────────────────────────────────────
    // SPLICED VERBATIM from the pump, not re-spelled here.  `previewStatusToJson`
    // emits exactly the keys `coercePanoPlusStatus` reads and is asserted by
    // its own host test; a second transcription in this file would be a second
    // place for `previewSeq` to be misspelled, and a misspelled key is a panel
    // that stays empty on a phone in an aisle.
    {
        const std::string pj = android::previewStatusToJson(S.preview.snapshot());
        if (pj.size() > 2 && pj[0] == '{' && pj[pj.size() - 1] == '}') {
            s += ',';
            s.append(pj, 1, pj.size() - 2);
        }
    }
    // Not the pump's: whether it was ever ARMED.  `previewSeq == 0` with a
    // pump that refused to start is a different fact from one that started and
    // has not published yet, and only this session knows which.
    kvBool(s, "previewArmed", S.previewArmed);

    kvInt(s, "droppedQueue", 0);   // the CALLER owns backpressure; see below
    kvInt(s, "droppedPack", S.droppedPack);
    kvInt(s, "framesWritten", S.framesWritten);
    kvInt(s, "convertFailed", S.convertFailed);
    kv(s, "abort");
    if (st.abortReason.empty()) s += "null"; else jstr(s, st.abortReason);
    kv(s, "firstError");
    if (S.firstError.empty()) s += "null"; else jstr(s, S.firstError);
    s += "}";
}

void Session::setPoseSource(const std::string& kind) noexcept {
    // Empty is the "not supplied" sentinel `writeMeta` already tests
    // (`if (!S.opt.poseSource.empty())`), so accepting one here would DELETE
    // the block rather than correct it.
    if (kind.empty()) return;
    try {
        Impl& S = *impl_;
        std::lock_guard<std::mutex> g(S.statusMu);
        S.opt.poseSource = kind;
    } catch (...) {
        // Nothing to report to, and a failed correction must not take the
        // sweep down: the pack still carries the truth in device.json.
    }
}


std::string Session::statusJson() const {
    const Impl& S = *impl_;
    // ⚠ `running` IS CHECKED BEFORE THE CACHE, and the order is the fix.  The
    // cache holds the LAST INGESTED FRAME's status, which says `running:true`;
    // returning it after a finalize or a cancel would tell the surface a sweep
    // that has ended is still going, and the surface would keep polling a
    // session that no longer owns a camera.  (The JNI layer drops its pointer
    // on both paths, so this was unreachable through the bridge — which is
    // exactly the kind of "protected by someone else's discipline" that stops
    // being true the first time a second caller appears.)
    if (!S.running) return std::string("{\"running\":false}");
    {
        std::lock_guard<std::mutex> g(S.statusMu);
        if (!S.statusCache.empty()) return S.statusCache;
    }
    // No frame has been ingested yet.  A status is still owed — the surface
    // polls from the instant start() resolves, and `{running:false}` there
    // would read as a sweep that had already ended.
    std::string s;
    appendStatus(s, nullptr);
    return s;
}

// ════════════════════════════════════════════════════════════════════════════
//  Finalize
// ════════════════════════════════════════════════════════════════════════════

std::string Session::finalizeSweep(bool* empty) {
    Impl& S = *impl_;
    if (empty != nullptr) *empty = false;
    if (!S.started) {
        return std::string("{\"ok\":false,\"error\":\"no pano+ sweep is running\"}");
    }
    const double f0 = nowMs();
    S.running = false;

    std::string s;
    s += "{";
    kvBool(s, "ok", true);

    rnis::pano::FrameOutcome tail;
    bool tailFlushed = false;
    std::string tailErr;
    try {
        tail = S.engine.finish();
        tailFlushed = (tail.canvasX1 != tail.canvasX0);
    } catch (const std::exception& e) {
        tailErr = e.what();
    } catch (...) {
        tailErr = "unknown native error";
    }
    if (S.ledgerFp != nullptr && tailErr.empty()) {
        std::string line;
        replay::appendTailFlushLine(line, tail);
        std::fwrite(line.data(), 1, line.size(), S.ledgerFp);
    }
    S.closeLedger();

    // ── THE FINAL REPUBLISH ─────────────────────────────────────────────
    // AFTER `finish()` and before the pump is joined, so the last thing on
    // screen is the panorama the operator actually swept — including the
    // lead-out tail.  Without it the panel freezes one throttled tick short of
    // the end, which reads as a sweep that lost its last second.
    //
    // Synchronous on this thread by design (see PreviewPump::flush); its
    // failure is recorded and never fatal — a missing final preview must not
    // cost the canvas.
    std::string previewFlushErr;
    bool previewFlushed = false;
    if (S.previewArmed) {
        previewFlushed = S.preview.flush(S.engine, android::monotonicMs(),
                                         &previewFlushErr);
    }
    const android::PreviewSnapshot pv = S.preview.snapshot();

    SessionStats st;
    std::vector<std::pair<int, int> > holes;
    std::vector<std::pair<int, int> > env;
    cv::Mat canvas;
    int cropLo = 0, cropHi = 0;
    bool haveCanvas = false;
    std::string canvasErr;
    try {
        st = S.engine.stats();
        holes = S.engine.unpaintedRuns();
        env = S.engine.verticalEnvelope();
        haveCanvas = S.engine.finalCanvas(canvas, S.opt.canvasCropPad,
                                          &cropLo, &cropHi) && !canvas.empty();
    } catch (const std::exception& e) {
        canvasErr = e.what();
    } catch (...) {
        canvasErr = "unknown native error";
    }

    bool canvasWritten = false;
    if (haveCanvas) {
        std::string err;
        try {
            canvasWritten = rnis::pano::publishJpegAtomically(
                S.canvasPath, canvas, S.opt.canvasQuality, &err);
        } catch (...) {
            err = "unknown native error";
        }
        if (!canvasWritten && canvasErr.empty()) canvasErr = err;
    }

    // A sweep that painted nothing is EMPTY.  The pack still lands, and the
    // counters below are the evidence for why — a failed sweep with no
    // evidence is the outcome this programme refuses.
    if (empty != nullptr) *empty = !haveCanvas;

    kvStr(s, "sessionDir", S.sessionDir);
    kvStr(s, "canvasPath", canvasWritten ? S.canvasPath : std::string(""));
    kvStr(s, "previewPath", pv.published > 0 ? S.previewPath : std::string(""));
    kvStr(s, "metaPath", S.metaPath);
    kvStr(s, "ledgerPath", S.opt.writeLedger ? S.ledgerPath : std::string(""));
    kvStr(s, "trackPath", S.trackPath);
    kvInt(s, "width", haveCanvas ? canvas.cols : 0);
    kvInt(s, "height", haveCanvas ? canvas.rows : 0);
    kvStr(s, "canvasError", canvasErr);

    kv(s, "counts"); s += "{";
    kvInt(s, "seen", st.seen);
    kvInt(s, "painted", st.painted);
    kvInt(s, "heldBacktrack", st.heldBacktrack);
    kvInt(s, "heldFrontier", st.heldFrontier);
    kvInt(s, "skippedNoAdvance", st.skippedNoAdvance);
    kvInt(s, "rejectedLowResponse", st.rejectedLowResponse);
    kvInt(s, "rejectedOutOfCage", st.rejectedOutOfCage);
    kvInt(s, "rejectedPoseSpeed", st.rejectedPoseSpeed);
    kvInt(s, "rejectedTracking", st.rejectedTracking);
    kvInt(s, "rejectedRectify", st.rejectedRectify);
    kvInt(s, "rejectedInput", st.rejectedInput);
    kvInt(s, "warmingUp", st.warmingUp);
    kvInt(s, "bootstrap", st.bootstrap);
    kvInt(s, "gapExtended", st.gapExtended);
    kvInt(s, "gapBreak", st.gapBreak);
    kvInt(s, "gapBackfilled", st.gapBackfilled);
    kvInt(s, "limitedFrames", st.limitedFrames);
    kvInt(s, "canvasGrowths", st.canvasGrowths);
    kvInt(s, "canvasHeightGrowths", st.canvasHeightGrowths);
    kvInt(s, "skippedNonmonotonicTs", st.skippedNonmonotonicTs);
    s += "}";

    kvInt(s, "axis", st.axis);
    kvInt(s, "sweepSign", st.sweepSign);
    kvNum(s, "maxRectifyDeg", st.maxRectifyDeg);
    // ⚠ THE RUNS INDEX THE SWEEP AXIS, which is the output's COLUMN axis only
    // for a horizontal sweep — a vertical sweep is TRANSPOSED by the finalize
    // bake.  `unpaintedRunsAxis` names it so a consumer cannot print "columns"
    // unconditionally and be wrong half the time.
    kv(s, "unpaintedRuns"); s += "[";
    long long holeCols = 0;
    for (size_t i = 0; i < holes.size(); ++i) {
        if (i) s += ",";
        s += "["; jint(s, holes[i].first); s += ","; jint(s, holes[i].second); s += "]";
        holeCols += (long long)(holes[i].second - holes[i].first);
    }
    s += "]";
    kvInt(s, "unpaintedColumns", holeCols);
    kvStr(s, "unpaintedRunsAxis", std::string(st.axis == 1 ? "y" : "x"));

    kv(s, "clipping"); s += "{";
    kvInt(s, "frames", st.clippedFrames);
    kvInt(s, "columns", st.clippedColumns);
    kvNum(s, "maxTopPx", st.maxClipTopPx);
    kvNum(s, "maxBottomPx", st.maxClipBotPx);
    kvInt(s, "canvasH", st.canvasH);
    kvInt(s, "heightGrowths", st.canvasHeightGrowths);
    s += "}";

    // The ragged edge attitude rectification leaves.  `commonTop/Bottom` is
    // the band EVERY painted column carries — the honest full-height crop.
    kv(s, "verticalEnvelope"); s += "{";
    long long covered = 0;
    int commonTop = 0, commonBottom = 0;
    bool first = true;
    for (size_t i = 0; i < env.size(); ++i) {
        if (env[i].second <= env[i].first) continue;
        ++covered;
        if (first) { commonTop = env[i].first; commonBottom = env[i].second; first = false; }
        else {
            if (env[i].first > commonTop) commonTop = env[i].first;
            if (env[i].second < commonBottom) commonBottom = env[i].second;
        }
    }
    kvInt(s, "columns", (long long)env.size());
    kvInt(s, "covered", covered);
    kvInt(s, "commonTop", commonTop);
    kvInt(s, "commonBottom", commonBottom);
    s += "}";

    kv(s, "regime"); s += "{";
    kvNum(s, "rotationFraction", st.rotationFraction);
    kvNum(s, "rotTravelPx", st.rotTravelPx);
    kvNum(s, "resTravelPx", st.resTravelPx);
    kvNum(s, "rotPathPx", st.rotPathPx);
    kvNum(s, "resPathPx", st.resPathPx);
    s += "}";

    kv(s, "latch"); s += "{";
    kvInt(s, "axis", st.axis);
    kvInt(s, "sweepSign", st.sweepSign);
    kvBool(s, "latched", st.axisLatched);
    kvInt(s, "framesUsed", st.latchFramesUsed);
    kvBool(s, "weak", st.latchWasWeak);
    kvInt(s, "relatchCount", st.relatchCount);
    kv(s, "rotationPx"); s += "["; jnum(s, st.latchRotPx[0]); s += ",";
    jnum(s, st.latchRotPx[1]); s += "]";
    kv(s, "totalPx"); s += "["; jnum(s, st.latchTotPx[0]); s += ",";
    jnum(s, st.latchTotPx[1]); s += "]";
    s += "}";

    kv(s, "projection"); s += "{";
    kvInt(s, "mode", st.projection);
    kvNum(s, "maxAreaScalePainted", st.maxAreaScalePainted);
    kvNum(s, "maxCrossRectifyDeg", st.maxCrossRectifyDeg);
    kvNum(s, "sweepDeg", st.sweepDeg);
    s += "}";

    kv(s, "seam"); s += "{";
    kvNum(s, "worstBandP95Px", st.seamWorstBandP95Px);
    kvNum(s, "worstBandMaxPx", st.seamWorstBandMaxPx);
    kvNum(s, "crossBandDivergencePx", st.crossBandDivergencePx);
    kvNum(s, "crossBandDivergenceNormPx", st.crossBandDivergenceNormPx);
    kvNum(s, "canvasJogP95Px", st.seamCanvasJogP95Px);
    kvNum(s, "canvasJogMaxPx", st.seamCanvasJogMaxPx);
    kvNum(s, "lumaStepMaxDN", st.seamLumaStepMaxDN);
    kvNum(s, "photoStepP95DN", st.seamPhotoStepP95DN);
    kvNum(s, "photoStepMaxDN", st.seamPhotoStepMaxDN);
    kvInt(s, "photoSamples", st.seamPhotoSamples);
    kvInt(s, "photoStepOverBar", st.seamPhotoStepOverBar);
    kvInt(s, "photoNonUniform", st.seamPhotoNonUniform);
    kvInt(s, "photoUniformUnknown", st.seamPhotoUniformUnknown);
    kvNum(s, "photoUniStepMaxDN", st.seamPhotoUniStepMaxDN);
    kvInt(s, "photoUniSamples", st.seamPhotoUniSamples);
    kvNum(s, "photoSpreadMaxDN", st.seamPhotoSpreadMaxDN);
    kvNum(s, "photoDriftLocalPct", st.seamPhotoDriftLocalPct);
    kvNum(s, "photoDriftTotalPct", st.seamPhotoDriftTotalPct);
    kvBool(s, "bandSelfScored", st.seamBandSelfScored);
    kvBool(s, "measured", st.seamMeasured);
    kvInt(s, "boundaries", st.seamBoundaries);
    s += "}";

    kv(s, "exposure"); s += "{";
    kvBool(s, "normalize", S.cfg.exposureNormalize);
    kvNum(s, "gainClamp", S.cfg.exposureGainClamp);
    kvInt(s, "metaFrames", st.exposureMetaFrames);
    kvInt(s, "clampedFrames", st.exposureClampedFrames);
    kvNum(s, "refValue", st.exposureRefValue);
    kvNum(s, "minValue", st.exposureMinValue);
    kvNum(s, "maxValue", st.exposureMaxValue);
    kvNum(s, "rangeRatio", st.exposureRangeRatio);
    s += "}";

    S.engineMs.appendJson(s, "engineMs");
    S.previewMs.appendJson(s, "previewMs");
    S.ingestMs.appendJson(s, "ingestMs");
    // `arThreadUs` is an ARKit-arm field with no Android producer.  Emitted as
    // an EMPTY sample block (n: 0) rather than omitted, so the JS shape is one
    // schema and a reader can tell "not measured here" from "measured at zero".
    kv(s, "arThreadUs"); s += "{\"p50\":0,\"p99\":0,\"max\":0,\"n\":0}";

    // THE PREVIEW'S OWN LEDGER on the finished sweep.  rendered / published /
    // failed diverging is the entire signature of a publisher that cannot
    // write — the defect that outlived eleven days and six green suites on iOS
    // because no pack could say it.
    kvInt(s, "previewRendered", pv.renders);
    kvInt(s, "previewPublished", pv.published);
    kvInt(s, "previewFailed", pv.fails);
    kvInt(s, "previewSkipped", pv.skips);
    kvInt(s, "previewLastPublishedSeq", pv.publishedSeq);
    kv(s, "previewError");
    if (pv.firstError.empty()) s += "null"; else jstr(s, pv.firstError);
    kvBool(s, "previewArmed", S.previewArmed);

    kvBool(s, "previewFinalFlushed", previewFlushed);
    kv(s, "previewFinalFlushError");
    if (previewFlushErr.empty()) s += "null"; else jstr(s, previewFlushErr);

    kvBool(s, "tailFlushAttempted", true);
    kvBool(s, "tailFlushed", tailFlushed);
    kv(s, "tailFlushError");
    if (tailErr.empty()) s += "null"; else jstr(s, tailErr);

    // ⚠ `droppedQueue` IS STRUCTURALLY ZERO HERE and that is not a claim that
    // nothing was dropped.  Backpressure lives in the CAPTURE ARM on this leg
    // (the recorder's single-in-flight gate), so the honest count is the
    // caller's `droppedBusy` and the caller merges it into this summary.  A
    // zero written by the party that cannot see the drops would be a lie the
    // shape of a measurement.
    kvInt(s, "droppedQueue", 0);
    kvInt(s, "droppedPack", S.droppedPack);
    kvInt(s, "framesWritten", S.framesWritten);
    kvInt(s, "frameWriteFailed", S.frameWriteFailed);
    kvInt(s, "packBytes", S.packBytes);
    kvInt(s, "intrinsicsRescaled", 0);
    kvBool(s, "packFrameCapHit", S.frameCapHit);
    kvInt(s, "convertFailed", S.convertFailed);
    kvInt(s, "engineFrames", S.engineFrames);
    kvInt(s, "canvasCropLoPx", cropLo);
    kvInt(s, "canvasCropHiPx", cropHi);

    const double sweepMs = (S.lastTsNs > S.firstTsNs)
        ? (S.lastTsNs - S.firstTsNs) / 1e6 : 0.0;
    kvNum(s, "sweepMs", sweepMs);
    kvNum(s, "fpsMeasured",
          sweepMs > 0.0 ? (double)(S.engineFrames - 1) * 1000.0 / sweepMs : 0.0);
    kvNum(s, "finalizeMs", nowMs() - f0);
    kvNum(s, "startedAtMs", S.startedWallMs);
    kv(s, "abort");
    if (st.abortReason.empty()) s += "null"; else jstr(s, st.abortReason);
    kv(s, "firstError");
    if (S.firstError.empty()) s += "null"; else jstr(s, S.firstError);
    s += "}";

    writeMeta(st, holes, env, haveCanvas ? canvas.cols : 0,
              haveCanvas ? canvas.rows : 0, cropLo, cropHi, sweepMs, pv);

    // The pump is joined only NOW: `flush` above and `writeMeta` below both
    // read it, and stopping it earlier would publish the counters of a worker
    // that had not finished its last write.
    S.preview.stop();
    S.previewArmed = false;
    // The engine is released HERE, at the end of finalize, and not in cancel()
    // — everything above reads it.
    S.engine.reset();
    S.started = false;
    return s;
}

void Session::writeMeta(const SessionStats& st,
                        const std::vector<std::pair<int, int> >& holes,
                        const std::vector<std::pair<int, int> >& env,
                        int outW, int outH, int cropLo, int cropHi,
                        double sweepMs, const android::PreviewSnapshot& pv) {
    Impl& S = *impl_;
    std::string m;
    m += "{";
    kvInt(m, "engineVersion", (long long)kEngineVersion);
    kvStr(m, "arm", std::string("android-live"));
    kvNum(m, "startedAtMs", S.startedWallMs);
    kvNum(m, "sweepMs", sweepMs);
    kvInt(m, "outputW", outW);
    kvInt(m, "outputH", outH);
    // v14 — the upright bake that produced those dims.  `outputW/H` alone
    // cannot say whether a tall pack came from a portrait sweep or from a
    // landscape one that was turned, and every offline harness in this repo
    // reads meta.json rather than re-deriving from the pixels.
    kvInt(m, "outputRotationCwDeg", st.outputRotationCwDeg);
    kvInt(m, "canvasCropLoPx", cropLo);
    kvInt(m, "canvasCropHiPx", cropHi);
    if (!S.opt.poseSource.empty()) {
        // ⚠ EMITTED SO THE ZEROS ARE ATTRIBUTABLE.  `counts.rejectedPoseSpeed`
        // and the session-restart gate read 0 on this arm because `t` is
        // identically zero, not because nothing lurched — and every offline
        // harness in this repo reads meta.json rather than a sidecar.  The one
        // file with the zeros in it must be the file with the marker on it.
        kv(m, "poseSource"); m += "{";
        kvStr(m, "kind", S.opt.poseSource);
        kvBool(m, "translationAvailable", false);
        kvStr(m, "note", std::string(
            "Camera2 + TYPE_ROTATION_VECTOR: attitude only. t == [0,0,0] on "
            "every frame, so the pose-speed cage, the translation-jump "
            "session-restart detector and rotationFraction are INERT — their "
            "values describe the absence of a translation channel, not the "
            "absence of translation."));
        m += "}";
    }
    // THE CONFIG BLOCK, written through the SAME table the replay driver reads
    // it back with.  Without it, replaying this pack would silently run at
    // engine defaults while reporting that it reproduced the sweep.
    kv(m, "config");
    replay::appendConfigJson(m, S.cfg);

    kv(m, "pack"); m += "{";
    kvStr(m, "frames", std::string(
        S.opt.packFrames == PackFrames::All ? "all"
        : S.opt.packFrames == PackFrames::Painted ? "painted" : "none"));
    kvInt(m, "frameEveryN", S.opt.packFrameEveryN);
    kvInt(m, "frameQuality", S.opt.packFrameQuality);
    kvInt(m, "maxFrames", S.opt.packMaxFrames);
    kvInt(m, "framesWritten", S.framesWritten);
    kvInt(m, "frameWriteFailed", S.frameWriteFailed);
    kvBool(m, "frameCapHit", S.frameCapHit);
    kvInt(m, "bytes", S.packBytes);
    m += "}";

    kv(m, "preview"); m += "{";
    kvInt(m, "maxAlong", S.opt.previewMaxAlong);
    kvInt(m, "maxCross", S.opt.previewMaxCross);
    kvNum(m, "intervalMsFloor", S.opt.previewIntervalMs);
    kvNum(m, "intervalMsEffective", S.preview.effectiveIntervalMs());
    kvNum(m, "maxDutyPct", S.opt.previewMaxDutyPct);
    kvBool(m, "armed", S.previewArmed);
    kvStr(m, "startError", S.previewStartError);
    kvInt(m, "rendered", pv.renders);
    kvInt(m, "published", pv.published);
    kvInt(m, "failed", pv.fails);
    kvInt(m, "replaced", pv.skips);
    kv(m, "firstError");
    if (pv.firstError.empty()) m += "null"; else jstr(m, pv.firstError);
    m += "}";

    kv(m, "counts"); m += "{";
    kvInt(m, "seen", st.seen);
    kvInt(m, "painted", st.painted);
    kvInt(m, "warmingUp", st.warmingUp);
    kvInt(m, "rejectedTracking", st.rejectedTracking);
    kvInt(m, "rejectedLowResponse", st.rejectedLowResponse);
    kvInt(m, "rejectedOutOfCage", st.rejectedOutOfCage);
    kvInt(m, "rejectedRectify", st.rejectedRectify);
    kvInt(m, "rejectedPoseSpeed", st.rejectedPoseSpeed);
    kvInt(m, "skippedNoAdvance", st.skippedNoAdvance);
    kvInt(m, "heldBacktrack", st.heldBacktrack);
    kvInt(m, "gapExtended", st.gapExtended);
    kvInt(m, "gapBreak", st.gapBreak);
    kvInt(m, "clippedFrames", st.clippedFrames);
    kvInt(m, "clippedColumns", st.clippedColumns);
    kvInt(m, "unpaintedRuns", (long long)holes.size());
    kvInt(m, "envelopeColumns", (long long)env.size());
    m += "}";

    S.engineMs.appendJson(m, "engineMs");
    S.previewMs.appendJson(m, "previewMs");
    S.ingestMs.appendJson(m, "ingestMs");

    // Verbatim, unparsed: the capture arm's own evidence (which camera, which
    // basis, what the AE lock read back).  This session cannot know any of it
    // and must not invent it.
    //
    // The leading-brace check is not defensiveness for its own sake: a
    // malformed inline would not corrupt one FIELD, it would make the whole
    // `meta.json` unparseable — and meta.json is what every offline harness in
    // this repo opens first.  A dropped block is recoverable; a dead pack is
    // not.
    if (!S.opt.captureJsonInline.empty() && S.opt.captureJsonInline[0] == '{') {
        kv(m, "capture");
        m += S.opt.captureJsonInline;
    } else if (!S.opt.captureJsonInline.empty()) {
        kvStr(m, "captureRefused",
              std::string("the capture block was not a JSON object and was "
                          "dropped rather than corrupt meta.json"));
    }
    m += "}\n";

    std::FILE* f = std::fopen(S.metaPath.c_str(), "wb");
    if (f != nullptr) {
        std::fwrite(m.data(), 1, m.size(), f);
        std::fclose(f);
    } else {
        S.noteError("could not write " + S.metaPath);
    }
}

void Session::cancel() {
    Impl& S = *impl_;
    S.running = false;
    S.closeLedger();
    if (S.started) {
        try { S.engine.reset(); } catch (...) {}
        S.started = false;
    }
    // Drains and joins the publish worker.  Idempotent and safe from any
    // thread — this is the path a teardown takes, and it must not depend on
    // whether a publish happened to be in flight.
    S.preview.stop();
    S.previewArmed = false;
    // FILES ARE KEPT.  iOS's cancel deletes the session directory because its
    // only caller is an operator abandoning a sweep.  On Android the ownerless
    // teardowns (module invalidate, host destroy) reach here too, and deleting
    // the operator's pack because his Activity was recreated would destroy the
    // only evidence the sweep produced.
}

}  // namespace live
}  // namespace pano
}  // namespace rnis
