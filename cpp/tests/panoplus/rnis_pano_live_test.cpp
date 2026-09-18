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
// twin of that seam is a plain C++ object with no threads and no platform
// dependency — which means these are runnable today, on a Mac, before the
// phone is ever plugged in.
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
#include <opencv2/imgproc.hpp>

#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
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
    return o;
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

// ── meta.json ↔ replay ──────────────────────────────────────────────────────

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
    EXPECT_EQ(st.find("nan"), std::string::npos) << st;
    EXPECT_EQ(st.find("inf"), std::string::npos) << st;
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
    EXPECT_TRUE(exists(start.framesDir + "/frame_000000.jpg"));
    EXPECT_TRUE(exists(start.framesDir + "/frame_000002.jpg"));

    bool empty = false;
    const std::string summary = s.finalizeSweep(&empty);
    EXPECT_NE(summary.find("\"framesWritten\":3"), std::string::npos) << summary;
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
