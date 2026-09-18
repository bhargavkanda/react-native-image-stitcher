// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_preview_test — the live preview's POLICY, on the host.
//
// WHAT THIS SUITE IS FOR.  The iOS twin of this policy has shipped two defects
// that neither the C++ suite nor the SDK suite could see, because both lived in
// the platform seam between them:
//
//   1. the publish swallowed a cv::Exception on every tick of every sweep for
//      eleven days — an empty panel with no number anywhere disagreeing;
//   2. the refresh clock advanced only on SUCCESSFUL renders, so a pre-latch
//      sweep re-probed the engine at 60 Hz and corrupted the pack's own timing
//      evidence with ~0 ms samples.
//
// Both are reachable from here and from nowhere else on a laptop.  Every test
// below is one of those two shapes: a cadence claim, or a "what does the panel
// get told when the write fails" claim.
//
// WHAT IT DELIBERATELY DOES NOT COVER: that the JPEG reaches the operator's
// screen.  That is Fresco, a TextureView and a phone — device-verify.

#include <gtest/gtest.h>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

// POSIX rather than <filesystem>: the same rule the replay driver states — the
// NDK's libc++ archive availability for <filesystem> has moved across releases,
// and this translation unit compiles under both toolchains.
#include <sys/stat.h>
#include <unistd.h>

#include "rnis_pano_android_preview.hpp"

namespace {

using rnis::pano::android::PreviewConfig;
using rnis::pano::android::PreviewPump;
using rnis::pano::android::PreviewSnapshot;
using rnis::pano::android::PreviewThrottle;
using rnis::pano::android::previewStatusToJson;

constexpr int kFrameW = 960;
constexpr int kFrameH = 720;
constexpr double kFx = 900.0, kFy = 900.0;
constexpr double kCx = 480.0, kCy = 360.0;

/// A temp directory that removes its files on the way out.  No <filesystem>:
/// the NDK's libc++ archive availability for it has moved across releases, and
/// the same rule the replay driver states applies to its tests.
class TempDir {
public:
    TempDir() {
        char tmpl[] = "/tmp/rnis_preview_XXXXXX";
        const char* d = ::mkdtemp(tmpl);
        path_ = (d != nullptr) ? d : "/tmp";
    }
    ~TempDir() {
        for (const auto& f : made_) std::remove(f.c_str());
        if (path_ != "/tmp") ::rmdir(path_.c_str());
    }
    std::string file(const std::string& name) {
        const std::string p = path_ + "/" + name;
        made_.push_back(p);
        // publishJpegAtomically writes through a sibling ".part"; it removes it
        // on every failure path, but a crashed run would leave one behind.
        made_.push_back(p + ".part");
        return p;
    }
    const std::string& dir() const { return path_; }

private:
    std::string path_;
    std::vector<std::string> made_;
};

/// A textured shelf run with enough high-frequency structure that phase
/// correlation is well conditioned — the same construction the engine suite
/// uses, shrunk, because this suite is about the pump and not the registration.
cv::Mat makeShelf(int width, int height) {
    cv::Mat img(height, width, CV_8UC3);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            img.at<cv::Vec3b>(y, x) = cv::Vec3b(
                static_cast<uchar>(60 + ((x * 7) % 120)),
                static_cast<uchar>(40 + ((y * 11) % 150)),
                static_cast<uchar>(80 + (((x + y) * 5) % 120)));
        }
    }
    for (int x = 30; x < width - 30; x += 90) {
        for (int y = 40; y < height - 40; y += 200) {
            cv::rectangle(img, cv::Rect(x, y, 64, 150),
                          cv::Scalar((x * 13) % 255, (y * 29) % 255,
                                     ((x + y) * 7) % 255),
                          cv::FILLED);
            cv::circle(img, cv::Point(x + 32, y + 50), 18,
                       cv::Scalar(255, 255, 255), cv::FILLED);
        }
    }
    cv::GaussianBlur(img, img, cv::Size(0, 0), 0.7);
    return img;
}

rnis::pano::Config testConfig() {
    rnis::pano::Config c;
    c.trackingWarmupFrames = 2;
    c.axisLatchFrames = 3;
    c.canvasInitWidthPx = 2048;
    return c;
}

/// Drive `n` frames of a pure left-to-right translation sweep through `eng`,
/// calling `perFrame(i)` after each ingest.  The pump is what `perFrame` is
/// for; the sweep itself is scenery.
template <typename F>
void runSweep(rnis::pano::Engine& eng, const cv::Mat& shelf, int n, int stepPx,
              F&& perFrame) {
    for (int i = 0; i < n; ++i) {
        const int x0 = i * stepPx;
        if (x0 + kFrameW > shelf.cols) break;
        cv::Mat crop = shelf(cv::Rect(x0, 0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), 0.5, 0.5, cv::INTER_AREA);

        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = static_cast<double>(i) * 33e6;
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        // A pure translation sweep: identity attitude, camera walking +X.  The
        // engine's axis latch votes on measured translation, which is what makes
        // this the shortest path to a painted band.
        in.t[0] = static_cast<double>(i) * 0.02;
        in.tracking = 2;
        in.seq = i;
        (void)eng.ingest(in);
        perFrame(i);
    }
}

bool fileExists(const std::string& p) {
    std::FILE* f = std::fopen(p.c_str(), "rb");
    if (f == nullptr) return false;
    std::fclose(f);
    return true;
}

}  // namespace

// ── The throttle ────────────────────────────────────────────────────────────

TEST(PreviewThrottle, TheFirstTickIsDueImmediately) {
    // Waiting one interval for the first sign of life is the difference between
    // "it started" and "it is broken" from behind the phone.
    PreviewThrottle t(120.0, 8.0);
    EXPECT_TRUE(t.due(0.0));
    EXPECT_TRUE(t.due(1000.0));
}

TEST(PreviewThrottle, HoldsTheFloorBetweenRenders) {
    PreviewThrottle t(120.0, 8.0);
    t.markAttempt(1000.0);
    t.markRender(2.0);
    EXPECT_FALSE(t.due(1000.0));
    EXPECT_FALSE(t.due(1119.0));
    EXPECT_TRUE(t.due(1120.0));
    EXPECT_TRUE(t.due(1600.0));
}

TEST(PreviewThrottle, ARefusedAttemptStillAdvancesTheClock) {
    // THE 60 Hz RE-PROBE.  Before iOS advanced the clock on attempts, a sweep
    // whose axis had not latched yet (nothing painted, so `previewIntoFit`
    // returns false) re-entered the engine on EVERY frame and pushed a ~0 ms
    // timing sample each time — previewMs reported n=106-126 against 39-60 real
    // renders, so the pack's own preview-lag evidence was fiction.
    PreviewThrottle t(120.0, 8.0);
    t.markAttempt(500.0);   // refused: no markRender follows
    EXPECT_FALSE(t.due(500.0));
    EXPECT_FALSE(t.due(619.0));
    EXPECT_TRUE(t.due(620.0));
}

TEST(PreviewThrottle, ACheapRenderLeavesTheFloorInCharge) {
    PreviewThrottle t(120.0, 8.0);
    t.markAttempt(0.0);
    t.markRender(4.0);  // 4 ms at 8% duty wants 50 ms; the 120 ms floor wins
    EXPECT_DOUBLE_EQ(120.0, t.effectiveIntervalMs());
}

TEST(PreviewThrottle, ADearRenderSlowsTheRefreshAndNotTheSweep) {
    // The whole point of the duty throttle: a 40 ms render at 8% may run once
    // every 500 ms.  The sweep keeps its thread; the panel updates slower and
    // the HUD says so (`previewIntervalMs` reaches JS).
    PreviewThrottle t(120.0, 8.0);
    t.markAttempt(0.0);
    for (int i = 0; i < 60; ++i) t.markRender(40.0);
    EXPECT_NEAR(500.0, t.effectiveIntervalMs(), 1.0);
}

TEST(PreviewThrottle, TheEffectiveIntervalIsCappedSoThePanelNeverFreezes) {
    // A frozen preview reads as a crashed sweep, and the operator's response to
    // that is to stop and start again — which costs him the whole sweep.
    PreviewThrottle t(120.0, 8.0);
    t.markAttempt(0.0);
    for (int i = 0; i < 200; ++i) t.markRender(5000.0);
    EXPECT_DOUBLE_EQ(1000.0, t.effectiveIntervalMs());
}

TEST(PreviewThrottle, TheCostIsSmoothedRatherThanLatched) {
    // One slow frame (a canvas grow, a GC pause) must not slow the panel for
    // the rest of the sweep, and one fast frame must not undo a real slowdown.
    PreviewThrottle t(120.0, 8.0);
    t.markAttempt(0.0);
    t.markRender(4.0);
    const double afterCheap = t.effectiveIntervalMs();
    t.markRender(200.0);
    const double afterOneSpike = t.effectiveIntervalMs();
    EXPECT_DOUBLE_EQ(120.0, afterCheap);
    // 0.8*4 + 0.2*200 = 43.2 ms -> 540 ms, not 200/0.08 = 2500 ms.
    EXPECT_NEAR(540.0, afterOneSpike, 1.0);
}

TEST(PreviewThrottle, ZeroDutyDisablesTheSelfThrottle) {
    PreviewThrottle t(120.0, 0.0);
    t.markAttempt(0.0);
    for (int i = 0; i < 20; ++i) t.markRender(400.0);
    EXPECT_DOUBLE_EQ(120.0, t.effectiveIntervalMs());
}

TEST(PreviewThrottle, TheFloorIsClampedToFiftyMilliseconds) {
    // A 0 ms interval is a preview on every frame — the sweep's own budget
    // spent looking at it.  `RNISPanoCore.mm:790` clamps identically.
    PreviewThrottle t(0.0, 8.0);
    EXPECT_DOUBLE_EQ(50.0, t.effectiveIntervalMs());
}

// ── The status contract ─────────────────────────────────────────────────────

TEST(PreviewStatusJson, CarriesEveryKeyTheSdkReads) {
    // THE SPELLING IS THE CONTRACT.  `coercePanoPlusStatus`
    // (panoPlusModel.ts:296-317) reads these names and defaults every one of
    // them, so a misspelling is not an error anywhere — it is a panel that
    // stays empty on a phone in an aisle with no way to find out why.
    PreviewSnapshot s;
    s.path = "/data/x/preview.jpg";
    s.publishedSeq = 12;
    s.w = 1200; s.h = 400;
    s.renders = 20; s.published = 12; s.skips = 7; s.fails = 1;
    s.intervalMs = 137.5;
    s.frontierFrac = 0.75;
    s.viewPx = 900; s.bandPx = 1800; s.viewStartPx = 900;
    s.windowed = true;
    const std::string j = previewStatusToJson(s);

    for (const char* key : {"\"previewPath\"", "\"previewSeq\"", "\"previewW\"",
                            "\"previewH\"", "\"previewRenders\"",
                            "\"previewFails\"", "\"previewSkips\"",
                            "\"previewIntervalMs\"", "\"previewFrontierFrac\"",
                            "\"previewViewPx\"", "\"previewBandPx\"",
                            "\"previewViewStartPx\"", "\"previewWindowed\""}) {
        EXPECT_NE(std::string::npos, j.find(key)) << "missing " << key;
    }
    EXPECT_NE(std::string::npos, j.find("\"previewSeq\":12"));
    EXPECT_NE(std::string::npos, j.find("\"previewWindowed\":true"));
    EXPECT_NE(std::string::npos, j.find("\"previewPath\":\"/data/x/preview.jpg\""));
}

TEST(PreviewStatusJson, AnUnplaceableFrontierStaysMinusOneAndNotZero) {
    // 0 is a LEGITIMATE fraction (the frontier at the near end of a reversed
    // sweep).  The SDK defaults this key to -1 for exactly that reason, and a
    // serialiser that emitted 0 would draw the marker at one end of a panorama
    // it knows nothing about.
    PreviewSnapshot s;
    const std::string j = previewStatusToJson(s);
    EXPECT_NE(std::string::npos, j.find("\"previewFrontierFrac\":-1"));
}

TEST(PreviewStatusJson, NonFiniteNumbersNeverReachTheParser) {
    // `JSON.parse` throws on `nan` / `inf`, and the throw happens in JS three
    // layers from whoever produced it.
    PreviewSnapshot s;
    s.intervalMs = std::nan("");
    s.frontierFrac = 1.0 / 0.0;
    const std::string j = previewStatusToJson(s);
    EXPECT_EQ(std::string::npos, j.find("nan"));
    EXPECT_EQ(std::string::npos, j.find("inf"));
    EXPECT_NE(std::string::npos, j.find("\"previewIntervalMs\":0"));
}

TEST(PreviewStatusJson, EscapesAPathAndAnErrorThatWouldBreakTheParse) {
    PreviewSnapshot s;
    s.path = "/tmp/a\"b\\c";
    s.firstError = "could not rename\n/tmp/x.part";
    const std::string j = previewStatusToJson(s);
    EXPECT_NE(std::string::npos, j.find("\\\"b\\\\c"));
    EXPECT_NE(std::string::npos, j.find("rename\\n/tmp"));
    EXPECT_EQ(std::string::npos, j.find("\n"));
}

// ── The pump, against a real engine ─────────────────────────────────────────

TEST(PreviewPump, RefusesAnEmptyPathRatherThanRunningBlind) {
    PreviewPump pump;
    PreviewConfig cfg;
    std::string err;
    EXPECT_FALSE(pump.start(cfg, &err));
    EXPECT_FALSE(err.empty());
    // Inert, not crashing: a tick on an unstarted pump is a no-op.
    rnis::pano::Engine eng;
    EXPECT_FALSE(pump.tick(eng, 0.0));
}

TEST(PreviewPump, PublishesAGrowingPanoramaAndCountsWhatItDid) {
    TempDir tmp;
    const std::string path = tmp.file("preview.jpg");

    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;

    PreviewPump pump;
    PreviewConfig cfg;
    cfg.path = path;
    cfg.intervalMs = 50.0;   // the floor, so a short synthetic sweep publishes
    cfg.maxDutyPct = 0.0;    // no self-throttle: this test is about the pixels
    ASSERT_TRUE(pump.start(cfg, &err)) << err;

    const cv::Mat shelf = makeShelf(2600, kFrameH);
    double clock = 0.0;
    runSweep(eng, shelf, 22, 70, [&](int) {
        clock += 60.0;  // one interval per frame
        pump.tick(eng, clock);
    });
    // stop() drains: a preview handed off one tick before it still lands.
    pump.stop();

    const PreviewSnapshot s = pump.snapshot();
    EXPECT_GT(s.renders, 0) << "the engine painted nothing to preview";
    EXPECT_GT(s.publishedSeq, 0) << "renders happened but nothing reached disk";
    EXPECT_EQ(0, s.fails) << s.firstError;
    EXPECT_GT(s.w, 0);
    EXPECT_GT(s.h, 0);
    EXPECT_EQ(path, s.path);
    ASSERT_TRUE(fileExists(path));

    // The published bytes are a decodable JPEG of the dims the status claims —
    // the status and the file must not be able to disagree, because JS sizes
    // the panel from the status and draws the file.
    const cv::Mat back = cv::imread(path, cv::IMREAD_COLOR);
    ASSERT_FALSE(back.empty());
    EXPECT_EQ(s.w, back.cols);
    EXPECT_EQ(s.h, back.rows);

    // The fit box is a CAP, and the memory note in the header depends on it.
    EXPECT_LE(std::max(back.cols, back.rows), cfg.maxAlong);
    EXPECT_LE(std::min(back.cols, back.rows), cfg.maxCross);

    // No ".part" survives a clean run — one stale temp file per publish inside
    // the pack the operator has to ship us would be a slow leak.
    EXPECT_FALSE(fileExists(path + ".part"));
}

TEST(PreviewPump, ThrottleHoldsTheRenderCountFarBelowTheFrameCount) {
    // The reason the pump exists at all: the engine thread must not spend its
    // budget resizing the canvas for a panel refreshing at 8 Hz.
    TempDir tmp;
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;

    PreviewPump pump;
    PreviewConfig cfg;
    cfg.path = tmp.file("preview.jpg");
    cfg.intervalMs = 120.0;
    cfg.maxDutyPct = 0.0;
    ASSERT_TRUE(pump.start(cfg, &err)) << err;

    const cv::Mat shelf = makeShelf(2600, kFrameH);
    double clock = 0.0;
    int frames = 0;
    runSweep(eng, shelf, 22, 70, [&](int) {
        clock += 16.6;  // 60 Hz delivery
        ++frames;
        pump.tick(eng, clock);
    });
    pump.stop();

    const PreviewSnapshot s = pump.snapshot();
    EXPECT_GT(frames, 15);
    // 22 frames at 16.6 ms is ~365 ms of sweep: at a 120 ms floor that is at
    // most 4 renders, and the first is free.
    EXPECT_LE(s.renders, 5) << "the throttle is not holding";
}

TEST(PreviewPump, AWriteThatCannotLandIsCountedAndExplainedRatherThanSilent) {
    // THE ELEVEN DAYS.  A publisher that cannot write must make the panel's own
    // alarm fire — `renders > 0 && previewSeq == 0` is what the SDK renders as
    // "PREVIEW WRITE(S) FAILED" (panoPlusModel.ts:1423).
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;

    PreviewPump pump;
    PreviewConfig cfg;
    // A directory that does not exist: fopen of the ".part" fails.
    cfg.path = "/nonexistent-rnis-dir-9f3a/preview.jpg";
    cfg.intervalMs = 50.0;
    cfg.maxDutyPct = 0.0;
    ASSERT_TRUE(pump.start(cfg, &err)) << err;

    const cv::Mat shelf = makeShelf(2600, kFrameH);
    double clock = 0.0;
    runSweep(eng, shelf, 22, 70, [&](int) {
        clock += 60.0;
        pump.tick(eng, clock);
    });
    pump.stop();

    const PreviewSnapshot s = pump.snapshot();
    ASSERT_GT(s.renders, 0);
    EXPECT_GT(s.fails, 0);
    EXPECT_EQ(0, s.publishedSeq);
    EXPECT_FALSE(s.firstError.empty()) << "a failure with no reason is the bug";
    // And the reason survives into the status JS reads.
    EXPECT_NE(std::string::npos,
              previewStatusToJson(s).find("previewFirstError"));
}

TEST(PreviewPump, FlushRepublishesAfterFinishSoThePanelEndsOnTheWholeSweep) {
    // Without this the panel is frozen one throttle tick short of the sweep the
    // operator just completed, which looks exactly like a sweep that stalled.
    TempDir tmp;
    const std::string path = tmp.file("preview.jpg");

    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;

    PreviewPump pump;
    PreviewConfig cfg;
    cfg.path = path;
    cfg.intervalMs = 5000.0;  // so ONLY the first tick and the flush publish
    cfg.maxDutyPct = 0.0;
    ASSERT_TRUE(pump.start(cfg, &err)) << err;

    const cv::Mat shelf = makeShelf(2600, kFrameH);
    double clock = 0.0;
    runSweep(eng, shelf, 22, 70, [&](int) {
        clock += 16.6;
        pump.tick(eng, clock);
    });
    const int64_t beforeFlush = pump.snapshot().publishedSeq;
    (void)eng.finish();
    std::string ferr;
    EXPECT_TRUE(pump.flush(eng, clock, &ferr)) << ferr;
    pump.stop();

    const PreviewSnapshot s = pump.snapshot();
    EXPECT_GT(s.publishedSeq, beforeFlush)
        << "the final republish did not advance the cache-bust, so JS would "
           "keep showing the previous image";
    EXPECT_EQ(0, s.fails) << s.firstError;
}

TEST(PreviewPump, FlushOnASweepThatPaintedNothingDeclinesInsteadOfFailing) {
    TempDir tmp;
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;

    PreviewPump pump;
    PreviewConfig cfg;
    cfg.path = tmp.file("preview.jpg");
    ASSERT_TRUE(pump.start(cfg, &err)) << err;

    std::string ferr;
    EXPECT_FALSE(pump.flush(eng, 0.0, &ferr));
    EXPECT_FALSE(ferr.empty());
    // An empty sweep is not a preview FAILURE — the panel must not raise the
    // write alarm for a sweep that had nothing to show.
    EXPECT_EQ(0, pump.snapshot().fails);
    pump.stop();
}

TEST(PreviewPump, StopIsIdempotentAndSurvivesNeverHavingStarted) {
    // `stop()` runs on the session teardown path, which is also the ANR path.
    PreviewPump pump;
    pump.stop();
    pump.stop();
    TempDir tmp;
    PreviewConfig cfg;
    cfg.path = tmp.file("preview.jpg");
    std::string err;
    ASSERT_TRUE(pump.start(cfg, &err)) << err;
    pump.stop();
    pump.stop();
    SUCCEED();
}

TEST(PreviewPump, ASecondStartIsRefusedRatherThanLeakingAWorker) {
    TempDir tmp;
    PreviewPump pump;
    PreviewConfig cfg;
    cfg.path = tmp.file("preview.jpg");
    std::string err;
    ASSERT_TRUE(pump.start(cfg, &err)) << err;
    EXPECT_FALSE(pump.start(cfg, &err));
    EXPECT_FALSE(err.empty());
    pump.stop();
}
