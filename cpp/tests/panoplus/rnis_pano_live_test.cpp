// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_live_test.cpp — the Android LIVE SESSION, on the host, with no
// camera and no JNI.
//
// ── What these tests are for ────────────────────────────────────────────────
//
// The live arm's seam is the one place this programme has repeatedly shipped
// defects no suite could reach: on iOS the equivalent logic lives inline in
// `RNISPanoCore.mm`, which needs a device, an ARKit session and a camera to
// execute one line of. `cpp/rnis_pano_live.{hpp,cpp}` exists so the Android
// twin of that seam is a plain C++ object with no frame thread and no platform
// dependency — which means these are runnable today, on a Mac, before the
// phone is ever plugged in. (Its two owned workers — the preview pump and the
// pack writer — take an injectable encode, so they are too.)
//
// They assert the things a device test could not tell you apart:
//
//   * an empty sweep REFUSES and still leaves its evidence on disk;
//   * a pack's `meta.json` carries a `config` block the replay driver's own
//     reader adopts — without which a replay of a live pack silently runs at
//     engine defaults while reporting that it reproduced the sweep;
//   * a knob the engine does not have is REPORTED by name, never dropped;
//   * `ledger.jsonl` is written by the replay driver's own row writer, so the
//     two files are textually diffable;
//   * a short or null NV21 buffer is a counted DROP and never a crash — the
//     one input class that would be a native abort on a phone in an aisle.
//
// What they do NOT assert is that a real sweep paints: that needs real pixels
// with real parallax, and it is the device's job. These pin the SEAM.

#include "rnis_pano_live.hpp"
#include "rnis_pano_replay.hpp"

#include <gtest/gtest.h>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <set>
#include <stdexcept>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace rnis::pano;

std::string readAll(const std::string& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f.good()) return std::string();
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

bool exists(const std::string& p) {
    struct stat st;
    return ::stat(p.c_str(), &st) == 0;
}

/// A unique scratch directory per test, under the system temp dir.
std::string makeTempDir(const char* tag) {
    const char* base = std::getenv("TMPDIR");
    std::string root = (base != nullptr && *base != '\0') ? base : "/tmp";
    if (!root.empty() && root[root.size() - 1] == '/') root.erase(root.size() - 1);
    char buf[512];
    std::snprintf(buf, sizeof(buf), "%s/rnis_live_%s_%d_%ld",
                  root.c_str(), tag, (int)::getpid(), (long)::random());
    ::mkdir(buf, 0777);
    return std::string(buf);
}

/// One synthetic NV21 frame of a textured scene, shifted horizontally by
/// `shiftPx` so consecutive frames actually correlate.
///
/// The pattern is deliberately high-frequency and aperiodic-ish: phase
/// correlation on a flat or periodic field is exactly the input that makes a
/// pass/fail here mean nothing.
std::vector<unsigned char> makeNv21(int w, int h, int shiftPx) {
    std::vector<unsigned char> buf((size_t)w * h * 3 / 2, 128);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const int u = x + shiftPx;
            const int v = (u * 37 + y * 17 + ((u / 13) * (y / 11)) * 5) & 0xFF;
            buf[(size_t)y * w + x] = (unsigned char)(40 + (v % 180));
        }
    }
    return buf;
}

live::FrameIn frameAt(int w, int h, long long seq, double tsNs) {
    live::FrameIn in;
    in.width = w;
    in.height = h;
    in.fx = (double)w * 0.8;
    in.fy = (double)w * 0.8;
    in.cx = (double)w * 0.5;
    in.cy = (double)h * 0.5;
    in.seq = seq;
    in.tsNs = tsNs;
    in.tracking = 2;
    in.exposureDurationS = 0.008;
    in.exposureISO = 200.0;
    return in;
}

live::Options optionsFor(const std::string& dir) {
    live::Options o;
    o.sessionDir = dir;
    o.packFrames = live::PackFrames::None;
    o.writeLedger = true;
    // The preview is exercised by its own suite
    // (rnis_pano_android_preview_test.cpp); here it is left at its defaults so
    // these tests measure the SESSION and not the pump.
    //
    // ⚠ AND THE PACK WRITER'S QUEUE IS MADE DEEP, deliberately. The encode is
    // ASYNC now and drops a frame when `packQueueMax` are outstanding, so on a
    // slow CI host back-to-back ingests could fill the production default of 3
    // before the worker dequeues the first — and every test below that counts
    // JPEGs would be a race. The drop-on-full behaviour has its OWN tests
    // (PanoLivePackWriter.*), which set the bound they are about.
    o.packQueueMax = 64;
    return o;
}

/// A latch for holding an encode: `wait()` blocks until `open()`.
struct Latch {
    std::mutex mu;
    std::condition_variable cv;
    bool isOpen = false;
    void open() {
        { std::lock_guard<std::mutex> g(mu); isOpen = true; }
        cv.notify_all();
    }
    bool wait(int ms) {
        std::unique_lock<std::mutex> lk(mu);
        return cv.wait_for(lk, std::chrono::milliseconds(ms), [this] { return isOpen; });
    }
};

double msSince(std::chrono::steady_clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now() - t0).count();
}

/// A small BGR frame for the writer's own tests.
cv::Mat bgrFrame(int w, int h, unsigned char v) {
    return cv::Mat(h, w, CV_8UC3, cv::Scalar(v, v, v));
}

/// The integer after `"key":` in `json` (first occurrence), or -1.
long long jsonInt(const std::string& json, const std::string& key) {
    const std::string k = "\"" + key + "\":";
    const size_t at = json.find(k);
    if (at == std::string::npos) return -1;
    return std::atoll(json.c_str() + at + k.size());
}

/// The `n` of the sample block `"key":{…,"n":N}`, or -1.
long long sampleN(const std::string& json, const std::string& key) {
    const std::string k = "\"" + key + "\":{";
    const size_t at = json.find(k);
    if (at == std::string::npos) return -1;
    const size_t end = json.find('}', at);
    const size_t n = json.find("\"n\":", at);
    if (n == std::string::npos || n > end) return -1;
    return std::atoll(json.c_str() + n + 4);
}

/// The p50 of the sample block `"key":{"p50":X,…}`, or -1.
double sampleP50(const std::string& json, const std::string& key) {
    const std::string k = "\"" + key + "\":{\"p50\":";
    const size_t at = json.find(k);
    if (at == std::string::npos) return -1.0;
    return std::atof(json.c_str() + at + k.size());
}

}  // namespace

// ── start ───────────────────────────────────────────────────────────────────

TEST(PanoLiveSession, StartCreatesThePackTreeAndReportsItsPaths) {
    const std::string dir = makeTempDir("start");
    live::Session s;
    const live::StartReport r = s.start(optionsFor(dir));

    ASSERT_TRUE(r.ok) << r.error;
    EXPECT_TRUE(s.running());
    // ONE directory, the same shape as an iOS pack: frames/ beside the ledger,
    // the meta, the preview and the canvas. A replay driver that has to branch
    // on which platform wrote the pack is a replay driver that will one day
    // branch wrong.
    EXPECT_TRUE(exists(dir + "/frames"));
    EXPECT_EQ(r.previewPath, dir + "/preview.jpg");
    EXPECT_EQ(r.canvasPath, dir + "/canvas.jpg");
    EXPECT_EQ(r.metaPath, dir + "/meta.json");
    EXPECT_EQ(r.ledgerPath, dir + "/ledger.jsonl");
    EXPECT_EQ(r.trackPath, dir + "/track.jsonl");
}

TEST(PanoLiveSession, StartRefusesAnEmptySessionDir) {
    live::Session s;
    live::Options o;
    o.sessionDir = "";
    const live::StartReport r = s.start(o);
    EXPECT_FALSE(r.ok);
    EXPECT_FALSE(r.error.empty());
    EXPECT_FALSE(s.running());
}

TEST(PanoLiveSession, StartRefusesASecondSweepWhileOneIsRunning) {
    const std::string dir = makeTempDir("twice");
    live::Session s;
    ASSERT_TRUE(s.start(optionsFor(dir)).ok);
    // A second start on a running session must REFUSE rather than quietly
    // reconfigure the engine underneath the sweep in progress: the canvas, the
    // ledger and the frame sequence all belong to the first one.
    const live::StartReport again = s.start(optionsFor(dir));
    EXPECT_FALSE(again.ok);
}

TEST(PanoLiveSession, TheAndroidCanvasCeilingIsLowerThanIosAndIsReported) {
    const std::string dir = makeTempDir("ceiling");
    live::Session s;
    const live::StartReport r = s.start(optionsFor(dir));
    ASSERT_TRUE(r.ok);
    // 8e6 px = 32 MB of canvas + coverage, against iOS's 18e6 / 72 MB. The
    // operator's phone idles at ~730 MB RSS and has peaked at 1.33 GB; his own
    // A35 sweep finished at 2048x1216 = 2.5e6, so this is 3x his measured need
    // and 2.25x cheaper than inheriting the iOS number.
    EXPECT_DOUBLE_EQ(r.canvasMaxPixels, 8.0e6);
}

// ── knobs ───────────────────────────────────────────────────────────────────

TEST(PanoLiveSession, KnobsAreSplitIntoAppliedUnknownAndMalformed) {
    const std::string dir = makeTempDir("knobs");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.configOverrides.push_back(std::make_pair("canvasScale", "0.4"));
    o.configOverrides.push_back(std::make_pair("rectify", "false"));
    o.configOverrides.push_back(std::make_pair("thisKnobDoesNotExist", "1"));
    o.configOverrides.push_back(std::make_pair("minAdvancePx", "not-a-number"));
    const live::StartReport r = s.start(o);
    ASSERT_TRUE(r.ok) << r.error;

    ASSERT_EQ(r.overridesApplied.size(), 2u);
    EXPECT_EQ(r.overridesApplied[0], "canvasScale");
    EXPECT_EQ(r.overridesApplied[1], "rectify");
    // ⚠ NAMED, NOT DROPPED. A sweep that ran at a knob the operator did not set
    // is the failure this port cannot afford, and a silently-ignored typo is
    // exactly that failure wearing an A/B arm's clothes.
    ASSERT_EQ(r.overridesUnknown.size(), 1u);
    EXPECT_EQ(r.overridesUnknown[0], "thisKnobDoesNotExist");
    ASSERT_EQ(r.overridesMalformed.size(), 1u);
    EXPECT_EQ(r.overridesMalformed[0], "minAdvancePx");
}

// ── ingest: the refusals that would be a native abort on a phone ────────────

TEST(PanoLiveSession, IngestRefusesANullBufferWithoutCrashing) {
    const std::string dir = makeTempDir("null");
    live::Session s;
    ASSERT_TRUE(s.start(optionsFor(dir)).ok);
    const live::IngestReport r = s.ingest(nullptr, 0, frameAt(64, 48, 0, 1.0));
    EXPECT_FALSE(r.ran);
    EXPECT_FALSE(r.error.empty());
}

TEST(PanoLiveSession, IngestRefusesAShortBufferByName) {
    const std::string dir = makeTempDir("short");
    live::Session s;
    ASSERT_TRUE(s.start(optionsFor(dir)).ok);
    // A buffer one byte short of w*h*3/2 would be read past the end INSIDE
    // cvtColor, which on a device is a native crash and not an exception. The
    // refusal has to happen here, where the reason can still be named.
    std::vector<unsigned char> tooShort((size_t)64 * 48 * 3 / 2 - 1, 0);
    const live::IngestReport r =
        s.ingest(tooShort.data(), tooShort.size(), frameAt(64, 48, 0, 1.0));
    EXPECT_FALSE(r.ran);
    EXPECT_NE(r.error.find("needs"), std::string::npos) << r.error;
}

TEST(PanoLiveSession, IngestBeforeStartIsAnInertDrop) {
    live::Session s;
    const std::vector<unsigned char> f = makeNv21(64, 48, 0);
    const live::IngestReport r = s.ingest(f.data(), f.size(), frameAt(64, 48, 0, 1.0));
    EXPECT_FALSE(r.ran);
}

TEST(PanoLiveSession, AWellFormedFrameReachesTheEngineAndIsLedgered) {
    const std::string dir = makeTempDir("ingest");
    live::Session s;
    const live::StartReport start = s.start(optionsFor(dir));
    ASSERT_TRUE(start.ok);

    const int w = 320, h = 240;
    for (int i = 0; i < 12; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        const live::IngestReport r =
            s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
        // `ran` is about REACHING the engine, not about painting: WarmingUp and
        // every rejection are decisions, and a decision is a successful ingest.
        EXPECT_TRUE(r.ran) << "frame " << i << ": " << r.error;
        EXPECT_GE(r.outcome, 0);
    }

    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    EXPECT_NE(summary.find("\"ok\":true"), std::string::npos);

    // ONE ROW PER INGESTED FRAME plus the synthetic tail-flush row.
    const std::string ledger = readAll(start.ledgerPath);
    ASSERT_FALSE(ledger.empty());
    size_t rows = 0;
    for (size_t i = 0; i < ledger.size(); ++i) if (ledger[i] == '\n') ++rows;
    EXPECT_EQ(rows, 13u);
    // Written through the replay driver's OWN row writer, so a live ledger and
    // a replay ledger are textually diffable rather than merely semantically
    // comparable. The field order is what makes that true.
    EXPECT_EQ(ledger.compare(0, 8, "{\"seq\":0"), 0) << ledger.substr(0, 60);
}

// ── the empty sweep ─────────────────────────────────────────────────────────

TEST(PanoLiveSession, ASweepThatPaintedNothingRefusesAndStillLeavesThePack) {
    const std::string dir = makeTempDir("empty");
    live::Session s;
    const live::StartReport start = s.start(optionsFor(dir));
    ASSERT_TRUE(start.ok);

    // Not one frame: the engine has nothing, so finalize must say EMPTY.
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    EXPECT_TRUE(empty);
    // ⚠ THE PACK IS STILL EVIDENCE. A failed sweep whose counters are thrown
    // away is a wasted field trip, so the summary is returned either way and
    // meta.json is on disk with the reason in it.
    EXPECT_NE(summary.find("\"counts\""), std::string::npos);
    EXPECT_TRUE(exists(start.metaPath));
    // Nothing was painted, so there is nothing to write a canvas from — and the
    // summary must not name a file that does not exist.
    EXPECT_NE(summary.find("\"canvasPath\":\"\""), std::string::npos);
}

TEST(PanoLiveSession, FinalizeWithoutStartIsRefusedNotCrashed) {
    live::Session s;
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    EXPECT_NE(summary.find("\"ok\":false"), std::string::npos);
}

// ── track.jsonl: the REPLAY INPUT ───────────────────────────────────────────
//
// Until 2026-09-22 this layer computed `trackPath`, reported it, and never
// wrote it.  The only writer was the Android recorder's `writeFrame`, reached
// ONLY from the Camera2 `ImageReader` callback — so on the two arms that
// actually ship (`vc-plugin`, `ar-plugin`) every pack carried a 0-BYTE
// track.jsonl and not one capture from either could be replayed.  Measured:
// 15 of 16 packs on the operator's A35, every date, both arms.
TEST(PanoLiveSession, WriteTrackOffWritesNoTrackFileAndSaysSo) {
    const std::string dir = makeTempDir("trackoff");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    const live::StartReport start = s.start(o);
    ASSERT_TRUE(start.ok);
    EXPECT_FALSE(start.writeTrack);

    const int w = 320, h = 240;
    for (int i = 0; i < 3; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    // The OFF side of the gate, pinned: no rows, and the summary says zero
    // rather than staying silent — "absent" must be able to mean only an
    // older binary.
    EXPECT_TRUE(readAll(start.trackPath).empty());
    EXPECT_NE(summary.find("\"trackRows\":0"), std::string::npos) << summary.substr(0, 400);
}

TEST(PanoLiveSession, WriteTrackOnWritesOneReplayableRowPerIngest) {
    const std::string dir = makeTempDir("trackon");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    o.writeTrack = true;
    // PackFrames::None is the ANDROID DEFAULT and the case that matters: the
    // rows must exist even when no JPEG does, because replay is row-driven
    // and a pose-only pack is still a replayable pose ledger.
    o.packFrames = live::PackFrames::None;
    const live::StartReport start = s.start(o);
    ASSERT_TRUE(start.ok);
    EXPECT_TRUE(start.writeTrack);

    const int w = 320, h = 240;
    const int n = 5;
    for (int i = 0; i < n; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);

    const std::string track = readAll(start.trackPath);
    ASSERT_FALSE(track.empty());
    size_t rows = 0;
    for (size_t i = 0; i < track.size(); ++i) if (track[i] == '\n') ++rows;
    EXPECT_EQ(rows, (size_t)n);
    EXPECT_NE(summary.find("\"trackRows\":5"), std::string::npos);

    // EVERY row must satisfy the PARSER, not merely look like JSON: the
    // writer lives beside it so the two cannot drift, and this is what holds
    // that claim.  `trackingDefaulted` false is part of it — a writer that
    // can supply `tracking` must never make a replay report it fell back.
    size_t at = 0;
    for (int i = 0; i < n; ++i) {
        const size_t nl = track.find('\n', at);
        ASSERT_NE(nl, std::string::npos);
        const replay::TrackRow r = replay::parseTrackRow(track.substr(at, nl - at));
        ASSERT_TRUE(r.ok) << "row " << i << ": " << r.why;
        EXPECT_EQ(r.seq, (long long)i);
        EXPECT_EQ(r.w, w);
        EXPECT_EQ(r.h, h);
        EXPECT_FALSE(r.trackingDefaulted);
        at = nl + 1;
    }
}

// THE NANOSECOND TRAP.  `tsNs` carries Android's SENSOR_TIMESTAMP (~1.7e14).
// Through the `%.9g` every other double in this writer uses, that quantises
// to the MILLISECOND — consecutive frames then compare EQUAL and the engine
// refuses every one after the first as non-monotonic.  The value below is the
// real device timestamp from the replay suite's own iOS fixture.
TEST(PanoLiveSession, TrackTsNsSurvivesADeviceUptimeTimestamp) {
    const std::string dir = makeTempDir("trackts");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    o.writeTrack = true;
    o.packFrames = live::PackFrames::None;
    const live::StartReport start = s.start(o);
    ASSERT_TRUE(start.ok);

    const int w = 320, h = 240;
    const double t0 = 166487140096208.0;
    for (int i = 0; i < 2; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, t0 + (double)i * 33.0e6));
    }
    bool empty = false;
    s.finalizeSweep(&empty);

    const std::string track = readAll(start.trackPath);
    ASSERT_FALSE(track.empty());
    const size_t nl = track.find('\n');
    ASSERT_NE(nl, std::string::npos);
    const replay::TrackRow r0 = replay::parseTrackRow(track.substr(0, nl));
    const size_t nl2 = track.find('\n', nl + 1);
    ASSERT_NE(nl2, std::string::npos);
    const replay::TrackRow r1 =
        replay::parseTrackRow(track.substr(nl + 1, nl2 - nl - 1));
    ASSERT_TRUE(r0.ok) << r0.why;
    ASSERT_TRUE(r1.ok) << r1.why;
    EXPECT_EQ((long long)std::llround(r0.tsNs), (long long)t0);
    EXPECT_GT(r1.tsNs, r0.tsNs) << "quantised: consecutive frames are not monotonic";
}

// THE WHOLE POINT, END TO END: a pack this layer wrote must REPLAY.
//
// Every assertion above is about the file; this one is about the contract.
// It is the host-side twin of the device proof — a sweep, then its own pack
// handed straight back to `replayPack` with nothing in between.
TEST(PanoLiveSession, ALiveTrackPackReplaysEndToEnd) {
    const std::string dir = makeTempDir("trackreplay");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    o.writeTrack = true;
    // Replay needs the PIXELS as well as the rows.
    o.packFrames = live::PackFrames::All;
    const live::StartReport start = s.start(o);
    ASSERT_TRUE(start.ok);

    const int w = 320, h = 240;
    const int n = 8;
    for (int i = 0; i < n; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    bool empty = false;
    s.finalizeSweep(&empty);

    replay::ReplayOptions ro;
    ro.packDir = start.packDir;
    replay::ReplayReport rr;
    ASSERT_TRUE(replay::replayPack(ro, &rr)) << rr.error;
    EXPECT_TRUE(rr.ok) << rr.error;
    EXPECT_EQ(rr.rowsTotal, n);
    EXPECT_EQ(rr.rowsMalformed, 0);
    // A row whose JPEG is missing is COUNTED and named; zero here is what
    // says the rows and the frames are in lockstep, which is the reason the
    // writer sits outside the frame gate rather than inside it.
    EXPECT_EQ(rr.framesMissing, 0);
    EXPECT_EQ(rr.framesIngested, n);
    // The writer supplies `tracking`, so no replay may report it defaulted.
    EXPECT_EQ(rr.rowsMissingTracking, 0);
}

// ── meta.json ↔ replay ──────────────────────────────────────────────────────

// ── meta.json carries the frame size the engine was FED ─────────────────────
//
// The Android host used to write a "delivered size" into its start-time
// `capture` block, read from a latch no frame had yet set: null on every pack
// of every arm, while the members sat in the binary looking wired. The engine
// is the one thing every arm feeds, so it records the size itself and writes
// it at finalize. 0 means no frame ever reached it — reported, not omitted, so
// "absent" can only mean an older binary.
TEST(PanoLiveSession, MetaCarriesTheDeliveredFrameSize) {
    const std::string dir = makeTempDir("delivered");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    ASSERT_TRUE(s.start(o).ok);

    const int w = 320, h = 240;
    for (int i = 0; i < 4; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    bool empty = false;
    s.finalizeSweep(&empty);

    const std::string meta = readAll(dir + "/meta.json");
    ASSERT_FALSE(meta.empty());
    EXPECT_NE(meta.find("\"deliveredFrameWidth\":320"), std::string::npos) << meta.substr(0, 400);
    EXPECT_NE(meta.find("\"deliveredFrameHeight\":240"), std::string::npos);
}

// ── The seed lead-in trim (engine v16) is recorded in the PACK ──────────────
//
// The count is decided inside finish(), so no live status can ever carry it,
// and the finalize summary reaches JS and is then gone: without these keys an
// Android pack said the flag was on and never what it cleared. Both are
// written whatever the count — 0 is a measurement, not an absence.
TEST(PanoLiveSession, MetaAndSummaryRecordTheSeedLeadTrim) {
    const std::string dir = makeTempDir("seedtrim");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    ASSERT_TRUE(s.start(o).ok);
    const int w = 320, h = 240;
    for (int i = 0; i < 4; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    EXPECT_NE(summary.find("\"seedLeadTrimPx\":"), std::string::npos) << summary.substr(0, 400);

    const std::string meta = readAll(dir + "/meta.json");
    ASSERT_FALSE(meta.empty());
    EXPECT_NE(meta.find("\"seedLeadTrimPx\":"), std::string::npos)
        << "meta.json must record what the trim cleared";
    EXPECT_NE(meta.find("\"seedLeadTrim\":true"), std::string::npos)
        << "meta.json must record the arm (the replay reads a missing key as OFF)";
}

TEST(PanoLiveSession, MetaReportsZeroDeliveredSizeWhenNothingWasIngested) {
    const std::string dir = makeTempDir("delivered0");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    ASSERT_TRUE(s.start(o).ok);
    bool empty = false;
    s.finalizeSweep(&empty);
    const std::string meta = readAll(dir + "/meta.json");
    ASSERT_FALSE(meta.empty());
    EXPECT_NE(meta.find("\"deliveredFrameWidth\":0"), std::string::npos);
    EXPECT_NE(meta.find("\"deliveredFrameHeight\":0"), std::string::npos);
}

TEST(PanoLiveSession, MetaCarriesAConfigBlockTheReplayReaderAdopts) {
    const std::string dir = makeTempDir("meta");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    // Two knobs the replay MUST inherit, one numeric and one boolean, chosen
    // because they change the canvas: a replay that ran at the default
    // canvasScale would report a different panorama and call it a reproduction.
    o.configOverrides.push_back(std::make_pair("canvasScale", "0.375"));
    o.configOverrides.push_back(std::make_pair("gainMatch", "false"));
    ASSERT_TRUE(s.start(o).ok);

    const int w = 320, h = 240;
    for (int i = 0; i < 4; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    bool empty = false;
    s.finalizeSweep(&empty);

    const std::string meta = readAll(dir + "/meta.json");
    ASSERT_FALSE(meta.empty());

    // THE ROUND TRIP, and the whole reason `appendConfigJson` exists: the
    // block this session wrote is adopted by the reader replay uses. Without
    // it, replaying a live pack silently runs at engine defaults while
    // reporting that it reproduced the sweep.
    Config adopted;
    std::vector<std::string> found, defaulted;
    ASSERT_TRUE(replay::applyMetaConfig(meta, adopted, &found, &defaulted));
    EXPECT_DOUBLE_EQ(adopted.canvasScale, 0.375);
    EXPECT_FALSE(adopted.gainMatch);
    // Every knob the writer emits is a knob the reader FOUND — an asymmetry
    // would mean one side knows a knob the other cannot see.
    EXPECT_TRUE(defaulted.empty())
        << "first knob the reader could not find: " << defaulted[0];

    // ⚠ THE ZEROS MUST BE ATTRIBUTABLE. `t` is identically zero on this arm, so
    // rejectedPoseSpeed and the translation-jump gate read 0 because there is
    // no translation CHANNEL — not because nothing lurched. Every offline
    // harness in this repo opens meta.json first, so the marker lives there.
    EXPECT_NE(meta.find("\"poseSource\""), std::string::npos);
    EXPECT_NE(meta.find("\"translationAvailable\":false"), std::string::npos);

    // ⚠ …AND IT MUST NOT NAME A CAMERA STACK IT CANNOT SEE.  The note opened
    // "Camera2 + TYPE_ROTATION_VECTOR" and was written on EVERY android-live
    // sweep — including the two plugin arms, which open no Camera2 client at
    // all.  Whether the sweep painted from a client of ours or from a
    // host-owned stream is exactly the question the S8 retirement decision
    // turns on, and the one file every offline harness opens was answering it
    // wrongly.  `captureJsonInline` states the rule one field down: the
    // capture arm's provenance is "which this session cannot know and must
    // not invent".
    EXPECT_EQ(meta.find("Camera2"), std::string::npos)
        << "meta.json names a camera stack this session is not told about";
    // The half it CAN see is still said, or the fix is a deletion.
    EXPECT_NE(meta.find("no translation channel"), std::string::npos);
    EXPECT_NE(meta.find("capture.frameSource"), std::string::npos)
        << "the note must point at the party that DOES know";
}

TEST(PanoLiveSession, ConfigJsonRoundTripsEveryKnobIncludingBoolsAndInts) {
    // Independent of a session: this is the writer and the reader alone, which
    // is where a spelling or a type mistake would actually live.
    Config a;
    a.canvasScale = 0.4321;
    a.rectify = false;
    a.canvasPadPx = 96;
    a.lensDeviceModel = "SM-A356U1";
    std::string j;
    replay::appendConfigJson(j, a);

    // Booleans as `true`/`false` and integer knobs without a fractional part,
    // so the block is diffable by eye against the iOS writer's and not only by
    // parser.
    EXPECT_NE(j.find("\"rectify\":false"), std::string::npos) << j;
    EXPECT_NE(j.find("\"canvasPadPx\":96"), std::string::npos) << j;
    EXPECT_EQ(j.find("\"canvasPadPx\":96.0"), std::string::npos) << j;

    Config b;
    std::vector<std::string> found, defaulted;
    const std::string wrapped = "{\"config\":" + j + "}";
    ASSERT_TRUE(replay::applyMetaConfig(wrapped, b, &found, &defaulted));
    EXPECT_DOUBLE_EQ(b.canvasScale, 0.4321);
    EXPECT_FALSE(b.rectify);
    EXPECT_EQ(b.canvasPadPx, 96);
    EXPECT_EQ(b.lensDeviceModel, "SM-A356U1");
    EXPECT_TRUE(defaulted.empty());
}

// ── status ──────────────────────────────────────────────────────────────────

TEST(PanoLiveSession, StatusIsValidBeforeTheFirstFrameAndCarriesRunning) {
    const std::string dir = makeTempDir("status0");
    live::Session s;
    ASSERT_TRUE(s.start(optionsFor(dir)).ok);
    const std::string st = s.statusJson();
    // `running` is the ONE field the SDK's coercion treats as mandatory — its
    // absence means "not a pano+ status" and the whole tick is dropped. The
    // surface polls from the instant start() resolves, so a status is owed
    // before any frame has arrived.
    EXPECT_NE(st.find("\"running\":true"), std::string::npos) << st;
    EXPECT_NE(st.find("\"previewPath\""), std::string::npos) << st;
    EXPECT_NE(st.find("\"framesSeen\""), std::string::npos) << st;
}

TEST(PanoLiveSession, StatusAfterAFrameCarriesTheEnginesOwnCounters) {
    const std::string dir = makeTempDir("status1");
    live::Session s;
    ASSERT_TRUE(s.start(optionsFor(dir)).ok);
    const int w = 320, h = 240;
    const std::vector<unsigned char> f = makeNv21(w, h, 0);
    ASSERT_TRUE(s.ingest(f.data(), f.size(), frameAt(w, h, 0, 1.0e9)).ran);

    const std::string st = s.statusJson();
    EXPECT_NE(st.find("\"running\":true"), std::string::npos);
    EXPECT_NE(st.find("\"outcome\":\""), std::string::npos) << st;
    // The perpendicular integrity signal, live. The hole gate only looks ALONG
    // the sweep, so without these the operator can watch a clean-looking HUD
    // while the panorama loses shelf height.
    EXPECT_NE(st.find("\"clippedFrames\""), std::string::npos);
    EXPECT_NE(st.find("\"clippedColumns\""), std::string::npos);
    // No bare NaN/Infinity anywhere: `JSON.parse` throws on both, three layers
    // from whoever wrote them.
    //
    // ⚠ MATCHED WHERE A VALUE CAN START, not anywhere in the string. The bare
    // substring test failed the moment a field was named `provenanceSeedPx` —
    // "prove-NAN-ceSeedPx" — and it would have failed on `maintenance` or
    // `finance` too. A guard that fires on its own key names teaches people to
    // rename the field rather than look at the number, which is the opposite
    // of what it is for. A JSON value only ever begins after `:`, `,` or `[`,
    // so those are the three places a bare NaN or Infinity can appear.
    for (const char* lit : {"nan", "-nan", "inf", "-inf", "Infinity", "-Infinity"}) {
        for (const char* lead : {":", ",", "["}) {
            const std::string probe = std::string(lead) + lit;
            EXPECT_EQ(st.find(probe), std::string::npos)
                << "bare " << lit << " after '" << lead << "' in status: " << st;
        }
    }
}

TEST(PanoLiveSession, StatusAfterCancelSaysNotRunning) {
    const std::string dir = makeTempDir("cancel");
    live::Session s;
    const live::StartReport start = s.start(optionsFor(dir));
    ASSERT_TRUE(start.ok);
    s.cancel();
    EXPECT_FALSE(s.running());
    EXPECT_NE(s.statusJson().find("\"running\":false"), std::string::npos);
    // ⚠ THE FILES SURVIVE, unlike iOS's cancel. On Android this call is reached
    // by the ownerless teardowns (module invalidate, Activity destroy), and
    // deleting the operator's pack because his Activity was recreated would
    // destroy the only evidence the sweep produced.
    EXPECT_TRUE(exists(start.ledgerPath));
    EXPECT_TRUE(exists(dir + "/frames"));
}

TEST(PanoLiveSession, CancelIsIdempotent) {
    const std::string dir = makeTempDir("cancel2");
    live::Session s;
    ASSERT_TRUE(s.start(optionsFor(dir)).ok);
    s.cancel();
    s.cancel();
    EXPECT_FALSE(s.running());
}

// ── pack frames ─────────────────────────────────────────────────────────────

TEST(PanoLiveSession, PackFramesNoneWritesNoJpegAndStillLedgersEveryFrame) {
    const std::string dir = makeTempDir("packnone");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.packFrames = live::PackFrames::None;
    const live::StartReport start = s.start(o);
    ASSERT_TRUE(start.ok);

    const int w = 320, h = 240;
    for (int i = 0; i < 5; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        ASSERT_TRUE(s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6)).ran);
    }
    EXPECT_FALSE(exists(start.framesDir + "/frame_000000.jpg"));

    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    EXPECT_NE(summary.find("\"framesWritten\":0"), std::string::npos);
    // A `None` sweep spawns NO writer thread and hands it nothing: the async
    // writer must cost a frame-less sweep exactly zero.
    EXPECT_NE(summary.find("\"packWriterStarted\":false"), std::string::npos) << summary;
    EXPECT_EQ(jsonInt(summary, "packEnqueued"), 0);
    EXPECT_EQ(jsonInt(summary, "packNotWanted"), 5);
    // The engine's own decision trace survives a frame-less pack — which is the
    // whole argument for defaulting Android to "none": the ROWS are the cheap
    // half of a replay twin and the pixels are the expensive one.
    EXPECT_FALSE(readAll(start.ledgerPath).empty());
}

TEST(PanoLiveSession, PackFramesAllWritesOneJpegPerIngestedFrame) {
    const std::string dir = makeTempDir("packall");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.packFrames = live::PackFrames::All;
    o.packFrameQuality = 60;
    const live::StartReport start = s.start(o);
    ASSERT_TRUE(start.ok);

    const int w = 320, h = 240;
    for (int i = 0; i < 3; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        ASSERT_TRUE(s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6)).ran);
    }

    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    // ⚠ ASSERTED AFTER FINALIZE, and the order is the point: the encode is
    // ASYNC, so a file checked straight after `ingest` returns is a race with
    // the writer. `finalizeSweep` drains it before it reports.
    EXPECT_TRUE(exists(start.framesDir + "/frame_000000.jpg"));
    EXPECT_TRUE(exists(start.framesDir + "/frame_000002.jpg"));
    EXPECT_NE(summary.find("\"framesWritten\":3"), std::string::npos) << summary;
    EXPECT_EQ(jsonInt(summary, "packEnqueued"), 3);
    EXPECT_EQ(jsonInt(summary, "droppedQueueFull"), 0);
}

TEST(PanoLiveSession, ThePackFrameCapIsRecordedRatherThanSilent) {
    const std::string dir = makeTempDir("packcap");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.packFrames = live::PackFrames::All;
    o.packMaxFrames = 2;
    ASSERT_TRUE(s.start(o).ok);

    const int w = 160, h = 120;
    for (int i = 0; i < 5; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 4);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    EXPECT_NE(summary.find("\"framesWritten\":2"), std::string::npos) << summary;
    // A cap that stops writing without saying so turns a chosen limit into a
    // mystery about the camera.
    EXPECT_NE(summary.find("\"packFrameCapHit\":true"), std::string::npos) << summary;
    EXPECT_NE(summary.find("\"droppedPack\":3"), std::string::npos) << summary;
    // The cap now counts frames HANDED TO THE WRITER, not frames on disk —
    // which is what still makes it a bound on disk use while the writes are
    // in flight. Split out, so a cap drop never reads as a writer drop.
    EXPECT_EQ(jsonInt(summary, "packEnqueued"), 2);
    EXPECT_EQ(jsonInt(summary, "droppedPackCap"), 3);
    EXPECT_EQ(jsonInt(summary, "droppedQueueFull"), 0);
}

// ── A1.1 — the pack writer, alone ───────────────────────────────────────────
//
// The encode used to run inline in `ingest`, in front of every next frame on
// a `PackFrames::All` sweep. It now runs on `detail::PackWriter`, and these pin
// the four properties that move makes load-bearing: the ingest thread never
// waits on it, the bound is real and every refusal is counted, a stop is
// bounded, and the frame it holds is the caller's frame — kept alive by the
// refcount, never copied.

TEST(PanoLivePackWriter, AFullQueueDropsCountsAndNeverBlocks) {
    Latch gate;
    std::atomic<int> began(0);
    live::detail::PackWriter w;
    std::string err;
    // queueMax 2 counts the frame BEING ENCODED: one in flight + one queued.
    ASSERT_TRUE(w.start(2, [&](const std::string&, const cv::Mat&, int, std::string*) {
        ++began;
        gate.wait(5000);
        return true;
    }, 0, &err)) << err;

    live::detail::PackJob j1; j1.path = "a"; j1.bgr = bgrFrame(8, 8, 1);
    ASSERT_TRUE(w.enqueue(std::move(j1)));
    for (int i = 0; i < 500 && began.load() == 0; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    ASSERT_EQ(began.load(), 1) << "#1 never reached the encoder";
    live::detail::PackJob j2; j2.path = "b"; j2.bgr = bgrFrame(8, 8, 2);
    ASSERT_TRUE(w.enqueue(std::move(j2)));

    // #3 finds two outstanding and is REFUSED — at once, while #1's encode is
    // still held. A blocking enqueue would sit here for the latch's 5 s.
    live::detail::PackJob j3; j3.path = "c"; j3.bgr = bgrFrame(8, 8, 3);
    const auto t0 = std::chrono::steady_clock::now();
    EXPECT_FALSE(w.enqueue(std::move(j3)));
    EXPECT_LT(msSince(t0), 50.0) << "enqueue must never wait on an encode";
    live::detail::PackWriterStats st = w.stats();
    EXPECT_EQ(st.droppedQueueFull, 1);
    EXPECT_EQ(st.outstanding, 2);
    EXPECT_EQ(st.highWater, 2);
    // The niceness knob defaults to "inherit": nothing is reniced unasked.
    EXPECT_EQ(st.niceRequested, 0);
    EXPECT_FALSE(st.niceApplied);

    gate.open();
    w.stop(2000.0);
    st = w.stats();
    EXPECT_EQ(st.written, 2);
    EXPECT_EQ(st.enqueued, 2);
    EXPECT_EQ(st.droppedAtStop, 0);
    EXPECT_EQ(st.outstanding, 0);
    EXPECT_EQ(st.writeMsN, 2);
}

TEST(PanoLivePackWriter, StopDrainsWithinBudgetAndCountsTheRest) {
    std::atomic<int> began(0);
    live::detail::PackWriter w;
    std::string err;
    ASSERT_TRUE(w.start(8, [&](const std::string&, const cv::Mat&, int, std::string*) {
        ++began;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        return true;
    }, 0, &err)) << err;
    for (int i = 0; i < 3; ++i) {
        live::detail::PackJob j; j.path = "f"; j.bgr = bgrFrame(8, 8, (unsigned char)i);
        ASSERT_TRUE(w.enqueue(std::move(j)));
    }
    for (int i = 0; i < 500 && began.load() == 0; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    ASSERT_GE(began.load(), 1);

    // Budget 0 — the cancel path: the encode in flight completes and is
    // JOINED, everything behind it is dropped and COUNTED. Within about one
    // encode, never the three.
    const auto t0 = std::chrono::steady_clock::now();
    w.stop(0.0);
    EXPECT_LT(msSince(t0), 140.0) << "stop(0) waited for more than the in-flight encode";
    live::detail::PackWriterStats st = w.stats();
    EXPECT_GE(st.droppedAtStop, 2);
    EXPECT_EQ(st.written + st.droppedAtStop, 3) << "every enqueued frame lands in one bucket";
    EXPECT_FALSE(w.running());

    // Idempotent: a second stop is a no-op, not a second count.
    const auto t1 = std::chrono::steady_clock::now();
    w.stop(0.0);
    EXPECT_LT(msSince(t1), 20.0);
    EXPECT_EQ(w.stats().droppedAtStop, st.droppedAtStop);
    // And a frame handed to a stopped writer is refused and counted, never
    // silently accepted into a queue nobody will drain.
    live::detail::PackJob late; late.path = "late"; late.bgr = bgrFrame(8, 8, 9);
    EXPECT_FALSE(w.enqueue(std::move(late)));
    EXPECT_EQ(w.stats().droppedAtStop, st.droppedAtStop + 1);
}

TEST(PanoLivePackWriter, AGenerousStopBudgetDrainsEverything) {
    live::detail::PackWriter w;
    std::string err;
    ASSERT_TRUE(w.start(8, [&](const std::string&, const cv::Mat&, int, std::string*) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        return true;
    }, 0, &err)) << err;
    for (int i = 0; i < 4; ++i) {
        live::detail::PackJob j; j.path = "f"; j.bgr = bgrFrame(8, 8, (unsigned char)i);
        ASSERT_TRUE(w.enqueue(std::move(j)));
    }
    // The finalize path: a budget wide enough for the queue writes all of it.
    w.stop(2000.0);
    const live::detail::PackWriterStats st = w.stats();
    EXPECT_EQ(st.written, 4);
    EXPECT_EQ(st.droppedAtStop, 0);
}

TEST(PanoLivePackWriter, AFailedOrThrowingEncodeIsCountedAndTheWorkerSurvives) {
    live::detail::PackWriter w;
    std::string err;
    std::atomic<int> calls(0);
    ASSERT_TRUE(w.start(8, [&](const std::string&, const cv::Mat&, int, std::string* e) -> bool {
        const int k = calls++;
        if (k == 0) { if (e) *e = "disk full"; return false; }
        // An escaping exception on the writer's std::thread would be
        // std::terminate — the whole app, for one pack frame.
        if (k == 1) throw std::runtime_error("encoder exploded");
        return true;
    }, 0, &err)) << err;
    for (int i = 0; i < 3; ++i) {
        live::detail::PackJob j; j.path = "f"; j.bgr = bgrFrame(8, 8, (unsigned char)i);
        ASSERT_TRUE(w.enqueue(std::move(j)));
    }
    w.stop(2000.0);
    const live::detail::PackWriterStats st = w.stats();
    EXPECT_EQ(st.failed, 2);
    // …and the frame AFTER the throw was still written: the worker survived.
    EXPECT_EQ(st.written, 1);
    // NOT swallowed: the first reason is kept verbatim.
    EXPECT_EQ(st.firstError, "disk full");
}

TEST(PanoLivePackWriter, TheQueuedFrameOutlivesTheCallersHandleWithoutACopy) {
    Latch gate;
    std::atomic<int> seenValue(-1);
    std::atomic<const unsigned char*> seenData(nullptr);
    live::detail::PackWriter w;
    std::string err;
    ASSERT_TRUE(w.start(4, [&](const std::string&, const cv::Mat& bgr, int, std::string*) {
        gate.wait(5000);
        seenValue = bgr.at<cv::Vec3b>(3, 3)[0];
        seenData = bgr.data;
        return true;
    }, 0, &err)) << err;

    cv::Mat mine = bgrFrame(16, 16, 77);
    const unsigned char* original = mine.data;
    live::detail::PackJob j; j.path = "f"; j.bgr = mine;   // shallow, as ingest does
    ASSERT_TRUE(w.enqueue(std::move(j)));
    // The caller lets go of its handle — exactly what `ingest` does when it
    // returns — and allocates over the heap it just freed.
    mine.release();
    cv::Mat churn = bgrFrame(16, 16, 5);
    gate.open();
    w.stop(2000.0);

    // The refcount kept the ORIGINAL pixels alive: same buffer, same value.
    EXPECT_EQ(seenValue.load(), 77);
    EXPECT_EQ(seenData.load(), original) << "the writer must hold the frame, not a copy of it";
    EXPECT_NE(churn.data, original);
}

TEST(PanoLivePackWriter, DestroyingARunningWriterJoinsInsteadOfTerminating) {
    const auto t0 = std::chrono::steady_clock::now();
    {
        live::detail::PackWriter w;
        std::string err;
        ASSERT_TRUE(w.start(8, [&](const std::string&, const cv::Mat&, int, std::string*) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            return true;
        }, 0, &err)) << err;
        for (int i = 0; i < 4; ++i) {
            live::detail::PackJob j; j.path = "f"; j.bgr = bgrFrame(8, 8, (unsigned char)i);
            w.enqueue(std::move(j));
        }
        // No stop(): the destructor must stop and JOIN, or a joinable
        // std::thread is destroyed and the process terminates here.
    }
    EXPECT_LT(msSince(t0), 1000.0);
}

// ── A1.1 — the writer inside the session ────────────────────────────────────

TEST(PanoLiveSession, TheIngestNoLongerPaysForThePackEncode) {
    const std::string dir = makeTempDir("packasync");
    live::Session s;
    live::Options o = optionsFor(dir);   // packQueueMax 64: nothing is refused
    o.packFrames = live::PackFrames::All;
    // A 40 ms encode — about what a 1080p software JPEG costs a degraded A35 —
    // that still writes a real file, so the pack can be checked on disk.
    o.packEncoder = [](const std::string& path, const cv::Mat& bgr, int q, std::string*) {
        std::this_thread::sleep_for(std::chrono::milliseconds(40));
        std::vector<int> params;
        params.push_back(cv::IMWRITE_JPEG_QUALITY);
        params.push_back(q);
        return cv::imwrite(path, bgr, params);
    };
    const live::StartReport start = s.start(o);
    ASSERT_TRUE(start.ok) << start.error;

    const int w = 320, h = 240;
    for (int i = 0; i < 5; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        ASSERT_TRUE(s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6)).ran);
    }
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);

    // THE POINT: the 40 ms encode is no longer inside the ingest. Before the
    // move every ingest here was >= 40 ms by construction.
    EXPECT_LT(sampleP50(summary, "ingestMs"), 40.0) << summary.substr(0, 600);
    EXPECT_LT(sampleP50(summary, "packMs"), 2.0) << "the hand-off is a push, not an encode";
    EXPECT_GE(sampleP50(summary, "packWriteMs"), 40.0) << "the encode ran — on the writer";
    // …and nothing was lost to it: finalize drained the writer before it
    // counted, so every frame is on disk.
    EXPECT_EQ(jsonInt(summary, "framesWritten"), 5);
    for (int i = 0; i < 5; ++i) {
        char name[64];
        std::snprintf(name, sizeof(name), "/frame_%06d.jpg", i);
        EXPECT_TRUE(exists(start.framesDir + name)) << name;
    }
}

TEST(PanoLiveSession, CancelWithQueuedFramesNeitherHangsNorCrashes) {
    const std::string dir = makeTempDir("packcancel");
    const auto t0 = std::chrono::steady_clock::now();
    double cancelMs = 0.0;
    // Counted at the START of each encode, so an encode in flight is counted.
    std::atomic<int> encodes(0);
    {
        live::Session s;
        live::Options o = optionsFor(dir);
        o.packFrames = live::PackFrames::All;
        o.packEncoder = [&encodes](const std::string&, const cv::Mat&, int, std::string*) {
            ++encodes;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            return true;
        };
        ASSERT_TRUE(s.start(o).ok);
        const int w = 160, h = 120;
        for (int i = 0; i < 6; ++i) {
            const std::vector<unsigned char> f = makeNv21(w, h, i * 4);
            s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
        }
        // Cancel is the cheap exit (a UI-thread teardown has 1 s for
        // everything): it joins the ONE encode in flight and drops the rest.
        // Draining all six would take ~600 ms.
        const int beforeCancel = encodes.load();
        const auto c0 = std::chrono::steady_clock::now();
        s.cancel();
        cancelMs = msSince(c0);
        const int atCancel = encodes.load();
        EXPECT_FALSE(s.running());
        // At most ONE encode more than had begun: the worker may have taken
        // the next frame between the read above and the stop landing.
        EXPECT_LE(atCancel, beforeCancel + 1);
        // ⚠ THE QUEUE WAS DROPPED BY cancel(), NOT BY THE DESTRUCTOR. The
        // session is still alive here; if cancel() had not stopped the writer
        // it would go on encoding the queue (one every 100 ms) until ~Session
        // stopped it at the end of this scope — well within the bounds below,
        // so only a count taken INSIDE the scope can tell the two apart.
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        EXPECT_EQ(encodes.load(), atCancel) << "an encode started after cancel() returned";
        EXPECT_LT(atCancel, 6) << "no frame was still queued at the cancel; the test proves nothing";
        // The destructor after cancel must be clean — a second stop is a no-op.
    }
    EXPECT_LT(cancelMs, 400.0) << "cancel waited for the queue, not just the in-flight encode";
    EXPECT_LT(msSince(t0), 2000.0);
    EXPECT_TRUE(exists(dir + "/frames"));
}

TEST(PanoLiveSession, MetaCarriesPerStageTimings) {
    const int w = 320, h = 240;
    for (const live::PackFrames mode : {live::PackFrames::All, live::PackFrames::None}) {
        const std::string dir = makeTempDir(mode == live::PackFrames::All ? "stageall" : "stagenone");
        live::Session s;
        live::Options o = optionsFor(dir);
        o.packFrames = mode;
        ASSERT_TRUE(s.start(o).ok);
        for (int i = 0; i < 5; ++i) {
            const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
            ASSERT_TRUE(s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6)).ran);
        }
        bool empty = false;
        const std::string summary = s.finalizeSweep(&empty);
        const std::string meta = readAll(dir + "/meta.json");
        ASSERT_FALSE(meta.empty());
        for (const std::string* doc : {&summary, &meta}) {
            EXPECT_EQ(sampleN(*doc, "convertMs"), 5) << doc->substr(0, 300);
            EXPECT_EQ(sampleN(*doc, "rowsMs"), 5);
            // A skipped write is never a sample: 5 on `all`, 0 on `none`.
            EXPECT_EQ(sampleN(*doc, "packMs"), mode == live::PackFrames::All ? 5 : 0);
            // The ingest thread's own CPU time, one sample per ingest.
            EXPECT_EQ(sampleN(*doc, "ingestCpuMs"), 5);
            EXPECT_NE(doc->find("\"ingestCores\":["), std::string::npos);
        }
    }
}

TEST(PanoLiveSession, ThePackIdentityClosesWhenTheCadenceAndTheQueueBothDrop) {
    // verdict A.3: an identity that omits the everyN cadence does not close
    // on an everyN > 1 sweep, and one that omits the writer's refusals does
    // not close when the writer falls behind. Both are exercised here at once.
    const std::string dir = makeTempDir("packidentity");
    Latch gate;
    live::Session s;
    live::Options o = optionsFor(dir);
    o.packFrames = live::PackFrames::All;
    o.packFrameEveryN = 2;
    // ONE outstanding, and the first encode held until every ingest is done:
    // every later cadence frame finds the writer full, deterministically.
    o.packQueueMax = 1;
    o.packEncoder = [&gate](const std::string&, const cv::Mat&, int, std::string*) {
        gate.wait(5000);
        return true;
    };
    ASSERT_TRUE(s.start(o).ok);
    const int w = 160, h = 120;
    const int n = 8;
    for (int i = 0; i < n; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 4);
        ASSERT_TRUE(s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6)).ran);
    }
    gate.open();
    bool empty = false;
    s.finalizeSweep(&empty);
    const std::string meta = readAll(dir + "/meta.json");
    const size_t at = meta.find("\"pack\":{");
    ASSERT_NE(at, std::string::npos);
    // Up to the NEXT block: `pack` nests `writeMs`, so its first '}' is not
    // its end.
    const size_t end = meta.find("\"preview\":{", at);
    ASSERT_NE(end, std::string::npos);
    const std::string pack = meta.substr(at, end - at);

    const long long written = jsonInt(pack, "framesWritten");
    const long long failed = jsonInt(pack, "frameWriteFailed");
    const long long full = jsonInt(pack, "droppedQueueFull");
    const long long atStop = jsonInt(pack, "droppedAtStop");
    const long long cap = jsonInt(pack, "droppedCap");
    const long long cadence = jsonInt(pack, "cadenceSkipped");
    const long long notWanted = jsonInt(pack, "notWanted");
    const long long frames = jsonInt(pack, "engineFrames");
    EXPECT_EQ(frames, n);
    EXPECT_EQ(cadence, n / 2) << pack;
    // seq 0 took the one slot; seq 2, 4 and 6 found it held.
    EXPECT_EQ(written, 1) << pack;
    EXPECT_EQ(full, 3) << pack;
    EXPECT_EQ(written + failed + full + atStop + cap + cadence + notWanted, frames) << pack;
    EXPECT_NE(pack.find("\"identity\":"), std::string::npos);
}

// ── the summary's honesty about what it cannot see ──────────────────────────

TEST(PanoLiveSession, DroppedQueueIsStructurallyZeroBecauseTheCallerOwnsBackpressure) {
    const std::string dir = makeTempDir("drop");
    live::Session s;
    ASSERT_TRUE(s.start(optionsFor(dir)).ok);
    const int w = 160, h = 120;
    const std::vector<unsigned char> f = makeNv21(w, h, 0);
    s.ingest(f.data(), f.size(), frameAt(w, h, 0, 1.0e9));
    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    // The engine is never TOLD about a frame the capture arm's gate dropped
    // before it, so this 0 is a structural fact and the caller must overwrite
    // it with its own count. Pinned here so nobody later reads it as evidence
    // that nothing was dropped.
    EXPECT_NE(summary.find("\"droppedQueue\":0"), std::string::npos) << summary;
}

// ── Key parity (M1) ─────────────────────────────────────────────────────────
//
// The TypeScript reads this producer's status and summary by KEY, and a key
// this side does not emit is not an error anywhere: the reader substitutes a
// default and the result looks complete. Commit dc0c98d found fields that had
// reached ZERO packs that way on iOS, and three of the summary's seam and
// projection fields were missing here on Android.
//
// So the key paths this producer emits are snapshotted to
// `fixtures/panoplus_live_keys.json`, and the jest suite
// (`src/sweep/__tests__/panoPlusKeyParity.test.ts`) checks every key the
// readers actually read against them. This test keeps the snapshot honest: it
// fails when the producer's keys and the committed snapshot disagree, in either
// direction. Regenerate with RNIS_UPDATE_KEY_FIXTURES=1.

namespace {

/// The key paths of a JSON document: "a", "a.b", … for every OBJECT member.
/// Array contents are walked but not recorded — a reader addresses an array
/// by the key that holds it. Tiny and strict on purpose: it throws on
/// anything it does not understand rather than returning a partial set.
struct KeyWalker {
    const std::string& s;
    size_t i = 0;
    std::set<std::string>& out;
    KeyWalker(const std::string& src, std::set<std::string>& o) : s(src), out(o) {}

    void ws() { while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) ++i; }
    [[noreturn]] void bad(const char* what) {
        throw std::runtime_error(std::string("json: ") + what + " at " + std::to_string(i));
    }
    std::string str() {
        if (s[i] != '"') bad("expected string");
        ++i;
        std::string r;
        while (i < s.size() && s[i] != '"') {
            if (s[i] == '\\') { r += s[i++]; if (i >= s.size()) bad("escape"); }
            r += s[i++];
        }
        if (i >= s.size()) bad("unterminated string");
        ++i;
        return r;
    }
    void value(const std::string& path, bool record) {
        ws();
        if (i >= s.size()) bad("eof");
        const char c = s[i];
        if (c == '{') {
            ++i; ws();
            if (s[i] == '}') { ++i; return; }
            for (;;) {
                ws();
                const std::string k = str();
                const std::string p = path.empty() ? k : path + "." + k;
                if (record) out.insert(p);
                ws(); if (s[i] != ':') bad("expected ':'"); ++i;
                value(p, record);
                ws();
                if (s[i] == ',') { ++i; continue; }
                if (s[i] == '}') { ++i; return; }
                bad("expected ',' or '}'");
            }
        } else if (c == '[') {
            ++i; ws();
            if (s[i] == ']') { ++i; return; }
            for (;;) {
                value(path, false);
                ws();
                if (s[i] == ',') { ++i; continue; }
                if (s[i] == ']') { ++i; return; }
                bad("expected ',' or ']'");
            }
        } else if (c == '"') {
            str();
        } else {
            const size_t start = i;
            while (i < s.size() && s[i] != ',' && s[i] != '}' && s[i] != ']'
                   && s[i] != ' ' && s[i] != '\n') ++i;
            if (i == start) bad("empty scalar");
        }
    }
};

std::set<std::string> jsonKeyPaths(const std::string& json) {
    std::set<std::string> out;
    KeyWalker w(json, out);
    w.value("", true);
    w.ws();
    if (w.i != json.size()) throw std::runtime_error("json: trailing bytes");
    return out;
}

std::string keysJson(const std::set<std::string>& status, const std::set<std::string>& summary) {
    std::string s = "{\n  \"_comment\": \"Generated by PanoLiveSession.KeyParityFixtureMatchesTheProducer "
                    "(RNIS_UPDATE_KEY_FIXTURES=1). The key paths rnis_pano_live emits; read by "
                    "src/sweep/__tests__/panoPlusKeyParity.test.ts.\",\n";
    auto list = [&](const char* name, const std::set<std::string>& keys, bool last) {
        s += std::string("  \"") + name + "\": [";
        bool first = true;
        for (const auto& k : keys) {
            s += first ? "\n    \"" : ",\n    \"";
            s += k + "\"";
            first = false;
        }
        s += last ? "\n  ]\n" : "\n  ],\n";
    };
    list("status", status, false);
    list("summary", summary, true);
    s += "}\n";
    return s;
}

}  // namespace

TEST(PanoLiveSession, TheKeyWalkerRecordsNestedMembersAndSkipsArrayContents) {
    // Negative control for the walker itself: an extractor that quietly
    // matches nothing would make the parity check vacuous.
    const std::set<std::string> k = jsonKeyPaths(
        "{\"a\":1,\"b\":{\"c\":\"x,}\",\"d\":[{\"e\":1},2]},\"f\":null,\"g\":{}}");
    const std::set<std::string> want = {"a", "b", "b.c", "b.d", "f", "g"};
    EXPECT_EQ(k, want);
    EXPECT_THROW(jsonKeyPaths("{\"a\":}"), std::runtime_error);
}

TEST(PanoLiveSession, KeyParityFixtureMatchesTheProducer) {
    const std::string dir = makeTempDir("keys");
    live::Session s;
    live::Options o = optionsFor(dir);
    o.poseSource = "imu";
    ASSERT_TRUE(s.start(o).ok);
    const int w = 320, h = 240;
    for (int i = 0; i < 6; ++i) {
        const std::vector<unsigned char> f = makeNv21(w, h, i * 6);
        s.ingest(f.data(), f.size(), frameAt(w, h, i, 1.0e9 + i * 33.0e6));
    }
    const std::set<std::string> status = jsonKeyPaths(s.statusJson());
    bool empty = false;
    const std::set<std::string> summary = jsonKeyPaths(s.finalizeSweep(&empty));
    ASSERT_GT(status.size(), 40u);
    ASSERT_GT(summary.size(), 100u);

    const std::string path = std::string(RNIS_PANO_FIXTURE_DIR) + "/panoplus_live_keys.json";
    const std::string want = keysJson(status, summary);
    const char* upd = std::getenv("RNIS_UPDATE_KEY_FIXTURES");
    if (upd != nullptr && std::string(upd) == "1") {
        std::ofstream(path) << want;
    }
    const std::string have = readAll(path);
    EXPECT_EQ(have, want)
        << "the live producer's keys changed; regenerate " << path
        << " with RNIS_UPDATE_KEY_FIXTURES=1 and re-run the jest parity suite";
}
