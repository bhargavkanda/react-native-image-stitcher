// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_replay_test.cpp — host tests for the platform-free pack replay
// driver (cpp/rnis_pano_replay.cpp), the piece the Android port is graded on
// before any Galaxy A35 is plugged in.
//
// WHAT THESE PIN, and why each one is here rather than being obvious:
//
//   * A PACK THAT IS NOT THERE IS A REPORT, NOT A CRASH.  Every failure path
//     the Android leg can hit on a read-only asset dir — no track.jsonl, no
//     frames/, a file where a directory should be, an outDir that cannot be
//     created — returns false with a named reason and does not throw.  A JNI
//     caller cannot unwind a C++ exception, so "does not throw" is a hard
//     requirement, not a nicety.
//   * A MALFORMED ROW IS SKIPPED AND COUNTED.  One bad line in a 400-row
//     track file must cost one frame, not the sweep.
//   * THE JSON SCANNER RESPECTS NESTING.  meta.json's `config` carries a
//     `pack` sub-object with its OWN `canvasQuality`; a line-grepping parser
//     would read it as a top-level knob.  This is the specific mistake the
//     scanner exists to make impossible.
//   * `null` IS NOT A VALUE.  jnum() writes lensK1/lensK2 as null when
//     unmeasured; adopting that as 0.0 would silently turn "we do not know"
//     into "we measured zero distortion".
//   * EVERY INGESTED FRAME YIELDS EXACTLY ONE LEDGER ROW (+1 for the tail
//     flush), which is the invariant the outcome histogram is only meaningful
//     under.
//   * THE DRIVER CANNOT OVERWRITE ITS OWN ORACLE.  An outDir resolving to the
//     pack's panoplus/ is refused: a replay that can clobber the ledger it is
//     graded against can be made to agree with itself.
//   * REPLAYING A PACK AGAINST A LEDGER THIS DRIVER ITSELF WROTE AGREES ROW
//     FOR ROW.  That does not prove agreement with the DEVICE (see the
//     fidelity note the report carries on every run) — it proves the diff
//     machinery reports agreement when there is agreement, which is the
//     precondition for reading a real divergence as a finding.
//
// Set RNIS_TEST_PANO_PACK=<pack dir> to additionally replay a REAL device pack
// and print its numbers; without it that test SKIPS LOUDLY rather than
// silently passing.

#include <gtest/gtest.h>

#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "rnis_pano_replay.hpp"

using rnis::pano::Config;
using rnis::pano::replay::ReplayOptions;
using rnis::pano::replay::ReplayReport;
using rnis::pano::replay::TrackRow;

namespace {

// ── scratch ─────────────────────────────────────────────────────────────────

class ScratchDir {
public:
    explicit ScratchDir(const std::string& tag) {
        const char* base = std::getenv("TMPDIR");
        dir_ = (base != nullptr ? std::string(base) : std::string("/tmp/"));
        if (dir_.empty() || dir_[dir_.size() - 1] != '/') dir_ += '/';
        dir_ += "rnis_pano_replay_" + tag + "_" +
                std::to_string((long long)::getpid()) + "_" +
                std::to_string((long long)counter_++);
        ::mkdir(dir_.c_str(), 0700);
    }
    ~ScratchDir() {
        const std::string cmd = "rm -rf '" + dir_ + "'";
        (void)std::system(cmd.c_str());
    }
    std::string at(const std::string& n) const { return dir_ + "/" + n; }
    const std::string& path() const { return dir_; }

private:
    std::string dir_;
    static int counter_;
};
int ScratchDir::counter_ = 0;

bool writeText(const std::string& path, const std::string& body) {
    std::ofstream f(path.c_str(), std::ios::binary);
    if (!f.good()) return false;
    f.write(body.data(), (std::streamsize)body.size());
    return f.good();
}

std::string readText(const std::string& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// ── a synthetic pack ────────────────────────────────────────────────────────
// Deliberately NOT built from cv::RNG.  cpp/tests/CMakeLists.txt records three
// days lost to `rng.fill(noise, NORMAL, 0.0, s)` on a multi-channel
// destination being undefined and non-reproducible; a fixture whose pixels are
// a pure function of an integer LCG cannot repeat that.

unsigned int lcg(unsigned int& s) {
    s = s * 1664525u + 1013904223u;
    return s;
}

/// A wide, high-contrast "shelf" the sweep crops out of.  Blobs at several
/// scales so phase correlation has real structure at the work scale.
cv::Mat makeScene(int w, int h) {
    cv::Mat m(h, w, CV_8UC3, cv::Scalar(24, 28, 32));
    unsigned int s = 12345u;
    for (int i = 0; i < 420; ++i) {
        const int x = (int)(lcg(s) % (unsigned)w);
        const int y = (int)(lcg(s) % (unsigned)h);
        const int bw = 8 + (int)(lcg(s) % 54u);
        const int bh = 8 + (int)(lcg(s) % 54u);
        const cv::Scalar c((double)(lcg(s) % 256u), (double)(lcg(s) % 256u),
                           (double)(lcg(s) % 256u));
        cv::rectangle(m, cv::Rect(x, y, bw, bh), c, -1);
    }
    for (int i = 0; i < 60; ++i) {
        const int x = (int)(lcg(s) % (unsigned)w);
        const int y = (int)(lcg(s) % (unsigned)h);
        cv::circle(m, cv::Point(x, y), 6 + (int)(lcg(s) % 24u),
                   cv::Scalar((double)(lcg(s) % 256u), (double)(lcg(s) % 256u),
                              (double)(lcg(s) % 256u)),
                   -1);
    }
    return m;
}

struct SynthPackSpec {
    int frames = 24;
    int frameW = 640, frameH = 480;
    int stepPx = 16;          // source px of pure translation per frame
    bool writeMeta = true;
    double workScale = 0.5;
};

/// Writes <root>/panoplus/{track.jsonl,frames/frame_%06d.jpg,meta.json}.
/// Returns the pack ROOT (the directory holding panoplus/), so the tests also
/// exercise the "pack root or panoplus dir" resolution.
std::string makeSynthPack(const ScratchDir& scratch, const std::string& name,
                          const SynthPackSpec& spec) {
    const std::string root = scratch.at(name);
    const std::string pp = root + "/panoplus";
    const std::string fr = pp + "/frames";
    ::mkdir(root.c_str(), 0700);
    ::mkdir(pp.c_str(), 0700);
    ::mkdir(fr.c_str(), 0700);

    const int sceneW = spec.frameW + spec.frames * spec.stepPx + 8;
    const cv::Mat scene = makeScene(sceneW, spec.frameH);

    std::string track;
    for (int i = 0; i < spec.frames; ++i) {
        const cv::Mat crop =
            scene(cv::Rect(i * spec.stepPx, 0, spec.frameW, spec.frameH)).clone();
        char nb[64];
        std::snprintf(nb, sizeof(nb), "frame_%06d.jpg", i);
        const std::vector<int> p{cv::IMWRITE_JPEG_QUALITY, 92};
        cv::imwrite(fr + "/" + nb, crop, p);

        char row[512];
        // Identity attitude and zero translation: the rotation channel is 0,
        // so the whole advance lands in the residual — the "walk a shelf"
        // regime, which is the one the driver has to carry.
        std::snprintf(row, sizeof(row),
                      "{\"seq\":%d,\"tsNs\":%lld,\"q\":[0,0,0,1],\"t\":[0,0,0],"
                      "\"fx\":520,\"fy\":520,\"cx\":%d,\"cy\":%d,\"w\":%d,\"h\":%d,"
                      "\"tracking\":2,\"expDurS\":0.016,\"expISO\":300,"
                      "\"arExpDurS\":0,\"arExpOffsetEV\":0,\"arExpHave\":false}\n",
                      i, (long long)i * 16666667LL, spec.frameW / 2,
                      spec.frameH / 2, spec.frameW, spec.frameH);
        track += row;
    }
    EXPECT_TRUE(writeText(pp + "/track.jsonl", track));

    if (spec.writeMeta) {
        // Pretty-printed AND nested, exactly like the device's: `config.pack`
        // carries its own `canvasQuality`, and `lensK1`/`lensK2` are null.
        std::ostringstream meta;
        meta << "{\n"
             << "  \"engineVersion\": 13,\n"
             << "  \"device\": \"synthetic\",\n"
             << "  \"config\": {\n"
             << "    \"workScale\": " << spec.workScale << ",\n"
             << "    \"canvasScale\": 0.5,\n"
             << "    \"projection\": 1,\n"
             << "    \"rectify\": true,\n"
             << "    \"gainMatch\": true,\n"
             << "    \"seamMetrics\": true,\n"
             << "    \"d8JogGuard\": true,\n"
             << "    \"d8JogBarPx\": 8,\n"
             << "    \"d8JogMaxRun\": 5,\n"
             << "    \"lensUndistort\": false,\n"
             << "    \"lensK1\": null,\n"
             << "    \"lensK2\": null,\n"
             << "    \"lensDeviceModel\": \"synthetic-model\",\n"
             << "    \"pack\": { \"canvasQuality\": 11, \"packFrameEveryN\": 1 }\n"
             << "  },\n"
             << "  \"canvas\": { \"outputW\": 777, \"outputH\": 555, "
                "\"paintedW\": 999, \"w\": 2048, \"h\": 1216 },\n"
             << "  \"counts\": { \"seen\": " << spec.frames << " }\n"
             << "}\n";
        EXPECT_TRUE(writeText(pp + "/meta.json", meta.str()));
    }
    return root;
}

int histAt(const ReplayReport& r, const char* name) {
    for (size_t i = 0; i < r.outcomeCounts.size(); ++i) {
        if (r.outcomeCounts[i].first == name) return r.outcomeCounts[i].second;
    }
    return -1;   // -1, not 0: "the name is not in the histogram" is a defect
}

int histSum(const ReplayReport& r) {
    int n = 0;
    for (size_t i = 0; i < r.outcomeCounts.size(); ++i) n += r.outcomeCounts[i].second;
    return n;
}

bool contains(const std::vector<std::string>& v, const std::string& s) {
    for (size_t i = 0; i < v.size(); ++i) if (v[i] == s) return true;
    return false;
}

}  // namespace

// ── refusals: every one of these is an Android failure path ─────────────────

TEST(PanoReplayRefusals, AnEmptyPackDirIsAReportNotACrash) {
    ReplayOptions o;
    ReplayReport r;
    EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r));
    EXPECT_FALSE(r.ok);
    EXPECT_FALSE(r.error.empty());
}

TEST(PanoReplayRefusals, ANonexistentPackNamesBothPathsItTried) {
    ScratchDir s("nopack");
    ReplayOptions o;
    o.packDir = s.at("does-not-exist");
    ReplayReport r;
    EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r));
    EXPECT_NE(r.error.find("track.jsonl"), std::string::npos) << r.error;
    EXPECT_NE(r.error.find("panoplus"), std::string::npos) << r.error;
}

TEST(PanoReplayRefusals, AMissingFramesDirIsAnErrorNotACrash) {
    ScratchDir s("noframes");
    const std::string pp = s.at("pack");
    ::mkdir(pp.c_str(), 0700);
    ASSERT_TRUE(writeText(pp + "/track.jsonl",
                          "{\"seq\":0,\"tsNs\":0,\"q\":[0,0,0,1],\"fx\":100,"
                          "\"fy\":100,\"cx\":10,\"cy\":10,\"w\":20,\"h\":20}\n"));
    ReplayOptions o;
    o.packDir = pp;
    ReplayReport r;
    EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r));
    EXPECT_FALSE(r.ok);
    EXPECT_NE(r.error.find("frames"), std::string::npos) << r.error;
}

TEST(PanoReplayRefusals, AFileWhereADirectoryShouldBeDoesNotThrow) {
    ScratchDir s("fileasdir");
    ASSERT_TRUE(writeText(s.at("notadir"), "hello"));
    ReplayOptions o;
    o.packDir = s.at("notadir");
    ReplayReport r;
    EXPECT_NO_THROW({ EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r)); });
    EXPECT_FALSE(r.error.empty());
}

// THE ERROR MUST NOT LIE ABOUT WHY.
//
// An iOS pack pushed with `adb push` lands in /sdcard, which an Android app may
// not read — and a bare `stat(...) == 0` reports that as "no track.jsonl at
// <the exact path the operator is looking at the file in>".  Following that
// message means re-recording a sweep that was never the problem.  So the
// permission case says PERMISSION and names the remedy.
TEST(PanoReplayRefusals, APermissionFailureSaysSoInsteadOfClaimingTheFileIsAbsent) {
    if (::geteuid() == 0) {
        GTEST_SKIP() << "running as root: the kernel grants the access this test denies";
    }
    ScratchDir s("denied");
    const std::string locked = s.at("locked");
    const std::string pp = locked + "/pack";
    ASSERT_EQ(::mkdir(locked.c_str(), 0700), 0);
    ASSERT_EQ(::mkdir(pp.c_str(), 0700), 0);
    ASSERT_EQ(::mkdir((pp + "/frames").c_str(), 0700), 0);
    ASSERT_TRUE(writeText(pp + "/track.jsonl",
                          "{\"seq\":0,\"tsNs\":0,\"q\":[0,0,0,1],\"fx\":100,"
                          "\"fy\":100,\"cx\":10,\"cy\":10,\"w\":20,\"h\":20}\n"));
    // Unsearchable PARENT — how an app's uid sees another app's (or the shell's)
    // directory. The file below is untouched and demonstrably present.
    ASSERT_EQ(::chmod(locked.c_str(), 0000), 0);

    ReplayOptions o;
    o.packDir = pp;
    ReplayReport r;
    EXPECT_NO_THROW({ EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r)); });

    // Restore before any assertion can abort the test: ScratchDir's rm -rf
    // cannot enter a 0000 directory either.
    ASSERT_EQ(::chmod(locked.c_str(), 0700), 0);

    EXPECT_NE(r.error.find("PERMISSION"), std::string::npos) << r.error;
    EXPECT_NE(r.error.find("run-as"), std::string::npos) << r.error;
    // And it must NOT be the absent-file message, which is the whole point.
    EXPECT_EQ(r.error.find("no track.jsonl"), std::string::npos) << r.error;
}

// The other half of the same distinction: a path that genuinely is not there
// still gets the absent message, so the new branch cannot swallow the old one.
TEST(PanoReplayRefusals, AGenuinelyAbsentPackIsStillReportedAsAbsent) {
    ScratchDir s("stillabsent");
    ReplayOptions o;
    o.packDir = s.at("nothing-here");
    ReplayReport r;
    EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r));
    EXPECT_NE(r.error.find("no track.jsonl"), std::string::npos) << r.error;
    EXPECT_EQ(r.error.find("PERMISSION"), std::string::npos) << r.error;
}

TEST(PanoReplayRefusals, AnEmptyTrackFileIsReported) {
    ScratchDir s("emptytrack");
    const std::string pp = s.at("pack");
    ::mkdir(pp.c_str(), 0700);
    ::mkdir((pp + "/frames").c_str(), 0700);
    ASSERT_TRUE(writeText(pp + "/track.jsonl", "\n\n"));
    ReplayOptions o;
    o.packDir = pp;
    ReplayReport r;
    EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r));
    EXPECT_NE(r.error.find("no rows"), std::string::npos) << r.error;
}

TEST(PanoReplayRefusals, OutDirInsideThePackIsRefusedSoTheOracleSurvives) {
    ScratchDir s("oracleguard");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    // The pack's OWN panoplus/, reached by a different-looking path — the
    // guard has to canonicalise, not string-compare.
    o.outDir = root + "/panoplus/../panoplus/";
    ReplayReport r;
    EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r));
    EXPECT_NE(r.error.find("oracle"), std::string::npos) << r.error;
}

// ── the JSON scanner ────────────────────────────────────────────────────────

TEST(PanoReplayJson, ANestedPackObjectDoesNotLeakIntoTheTopLevelConfig) {
    // `canvasQuality` lives ONLY inside config.pack.  A line-grepping parser
    // would find `canvasScale`'s neighbour and mis-assign; a real scanner must
    // report every top-level knob it did not find, and must not invent one.
    const std::string meta =
        "{\"config\":{\"canvasScale\":0.25,"
        "\"pack\":{\"canvasQuality\":11,\"workScale\":0.99},"
        "\"projection\":0}}";
    Config c;
    std::vector<std::string> found, defaulted;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(meta, c, &found, &defaulted));
    EXPECT_DOUBLE_EQ(c.canvasScale, 0.25);
    EXPECT_EQ(c.projection, 0);
    // config.pack.workScale must NOT have been adopted as config.workScale.
    EXPECT_DOUBLE_EQ(c.workScale, Config().workScale);
    EXPECT_TRUE(contains(defaulted, "workScale"));
    EXPECT_TRUE(contains(found, "canvasScale"));
}

TEST(PanoReplayJson, NullIsNotAValue) {
    // jnum() writes an unmeasured lensK1/K2 as null.  Adopting that as 0.0
    // would turn "not measured" into "measured zero distortion".
    const std::string meta = "{\"config\":{\"lensK1\":null,\"lensK2\":-0.02}}";
    Config c;
    c.lensK1 = 7.0;
    std::vector<std::string> found, defaulted;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(meta, c, &found, &defaulted));
    EXPECT_DOUBLE_EQ(c.lensK1, 7.0) << "null was adopted as a value";
    EXPECT_DOUBLE_EQ(c.lensK2, -0.02);
    EXPECT_TRUE(contains(defaulted, "lensK1"));
    EXPECT_TRUE(contains(found, "lensK2"));
}

TEST(PanoReplayJson, AMetaWithoutAConfigObjectDeclinesInsteadOfGuessing) {
    Config c;
    EXPECT_FALSE(rnis::pano::replay::applyMetaConfig("{\"counts\":{}}", c, nullptr, nullptr));
    EXPECT_FALSE(rnis::pano::replay::applyMetaConfig("not json at all", c, nullptr, nullptr));
    EXPECT_FALSE(rnis::pano::replay::applyMetaConfig("{\"config\":5}", c, nullptr, nullptr));
    // A truncated document must be refused, not half-adopted.
    EXPECT_FALSE(rnis::pano::replay::applyMetaConfig("{\"config\":{\"rectify\":tr",
                                                     c, nullptr, nullptr));
}

TEST(PanoReplayJson, BooleansAndBigNumbersRoundTrip) {
    const std::string meta =
        "{\"config\":{\"rectify\":false,\"gainMatch\":true,"
        "\"canvasMaxPixels\":1.8e7,\"phaseWindowPx\":384,"
        "\"lensDeviceLens\":\"AVCaptureDeviceTypeBuiltInUltraWideCamera\"}}";
    Config c;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(meta, c, nullptr, nullptr));
    EXPECT_FALSE(c.rectify);
    EXPECT_TRUE(c.gainMatch);
    EXPECT_DOUBLE_EQ(c.canvasMaxPixels, 1.8e7);
    EXPECT_EQ(c.phaseWindowPx, 384);
    EXPECT_EQ(c.lensDeviceLens, "AVCaptureDeviceTypeBuiltInUltraWideCamera");
}

// ── track rows ──────────────────────────────────────────────────────────────

TEST(PanoReplayTrackRow, AWellFormedRowParsesEveryFieldTheEngineConsumes) {
    const std::string line =
        "{\"seq\":7,\"tsNs\":166487140096208,\"tsWallMs\":1788231596688.19,"
        "\"q\":[0.5006,0.4997,0.5007,0.4989],\"t\":[0.1,-0.2,0.3],"
        "\"fx\":778.28,\"fy\":778.29,\"cx\":960.79,\"cy\":722.62,"
        "\"w\":1920,\"h\":1440,\"tracking\":1,\"expDurS\":0.016,"
        "\"expISO\":3188.77,\"arExpDurS\":0.008,\"arExpOffsetEV\":-0.5,"
        "\"arExpHave\":true,\"droppedBefore\":0}";
    const TrackRow r = rnis::pano::replay::parseTrackRow(line);
    ASSERT_TRUE(r.ok) << r.why;
    EXPECT_EQ(r.seq, 7);
    EXPECT_DOUBLE_EQ(r.tsNs, 166487140096208.0);
    EXPECT_NEAR(r.q[0], 0.5006, 1e-12);
    EXPECT_NEAR(r.q[3], 0.4989, 1e-12);
    EXPECT_NEAR(r.t[1], -0.2, 1e-12);
    EXPECT_EQ(r.w, 1920);
    EXPECT_EQ(r.h, 1440);
    EXPECT_EQ(r.tracking, 1);
    EXPECT_FALSE(r.trackingDefaulted);
    EXPECT_NEAR(r.expISO, 3188.77, 1e-9);
    EXPECT_NEAR(r.arExpOffsetEV, -0.5, 1e-12);
    EXPECT_TRUE(r.arExpHave);
}

TEST(PanoReplayTrackRow, TheDefaultedTrackingFlagIsRaisedNotHidden) {
    // A row with no `tracking` gets the NAMED fallback 2 (normal).  The other
    // plausible default, 0 (notAvailable), would hold the chain for the whole
    // sweep and report a dead replay as an engine finding.
    const TrackRow r = rnis::pano::replay::parseTrackRow(
        "{\"seq\":1,\"tsNs\":1,\"q\":[0,0,0,1],\"fx\":10,\"fy\":10,"
        "\"cx\":5,\"cy\":5,\"w\":10,\"h\":10}");
    ASSERT_TRUE(r.ok) << r.why;
    EXPECT_EQ(r.tracking, 2);
    EXPECT_TRUE(r.trackingDefaulted);
}

TEST(PanoReplayTrackRow, MalformedRowsAreRejectedWithAReason) {
    const char* bad[] = {
        "",
        "not json",
        "{\"seq\":0}",                                        // no tsNs
        "{\"seq\":0,\"tsNs\":1,\"q\":[0,0,1]}",               // q is 3 long
        "{\"seq\":0,\"tsNs\":1,\"q\":[0,0,0,1],\"fx\":1}",    // no fy/cx/cy
        "{\"seq\":0,\"tsNs\":1,\"q\":[0,0,0,1],\"fx\":1,\"fy\":1,\"cx\":1,"
        "\"cy\":1,\"w\":0,\"h\":10}",                         // w == 0
        "{\"seq\":0,\"tsNs\":1,\"q\":[0,0,0,1],\"fx\":1,\"fy\":1,\"cx\":1,"
        "\"cy\":1,\"w\":10,\"h\":10",                         // truncated
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        const TrackRow r = rnis::pano::replay::parseTrackRow(bad[i]);
        EXPECT_FALSE(r.ok) << "accepted: " << bad[i];
        EXPECT_FALSE(r.why.empty()) << "no reason for: " << bad[i];
    }
}

// ── config overrides ────────────────────────────────────────────────────────

TEST(PanoReplayOverrides, AppliedUnknownAndMalformedAreThreeDifferentAnswers) {
    Config c;
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "workScale", "0.75"), 1);
    EXPECT_DOUBLE_EQ(c.workScale, 0.75);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "rectify", "false"), 1);
    EXPECT_FALSE(c.rectify);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "crossWindows", "5"), 1);
    EXPECT_EQ(c.crossWindows, 5);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "lensDeviceModel", "SM-A356B"), 1);
    EXPECT_EQ(c.lensDeviceModel, "SM-A356B");

    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "noSuchKnob", "1"), 0);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "workScale", "yes-please"), -1);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "workScale", ""), -1);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "workScale", "nan"), -1)
        << "a NaN reached a config knob";
    EXPECT_DOUBLE_EQ(c.workScale, 0.75) << "a malformed value still moved the knob";
}

// v14 — THE UPRIGHT BAKE HAS TO BE A KNOB, on this exact table, because that
// table is THREE paths at once: the Android live arm's `configOverrides` bag
// (rnis_pano_live.cpp calls `applyConfigOverride` by name), the replay's
// `applyMetaConfig` seeding from a pack, and the `config` block every writer
// echoes into meta.json.  If the name is absent here the Android sweep's bake
// lands in `overridesUnknown` and the deliverable silently ships sideways —
// the exact failure this change exists to fix, arriving through the filter
// instead of through the engine.
TEST(PanoReplayOverrides, TheUprightBakeIsAKnobOnAllThreePaths) {
    Config c;
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "outputRotationCwDeg", "90"), 1)
        << "the Android live arm sends this by name; 0 here means "
           "`overridesUnknown` and a sideways pack";
    EXPECT_EQ(c.outputRotationCwDeg, 90);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "outputRotationCwDeg", "270"), 1);
    EXPECT_EQ(c.outputRotationCwDeg, 270);

    // Seeded from a pack, which is how a replay reproduces the device's OWN
    // output frame instead of a differently-turned one.
    Config seeded;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"outputRotationCwDeg\":180}}", seeded, nullptr, nullptr));
    EXPECT_EQ(seeded.outputRotationCwDeg, 180);

    // A PRE-v14 pack has no such key and must replay at 0 — exactly what
    // produced it.  Anything else would re-turn a canvas that was written
    // untouched and call the difference a regression.
    Config old_;
    std::vector<std::string> found, defaulted;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"workScale\":0.5}}", old_, &found, &defaulted));
    EXPECT_EQ(old_.outputRotationCwDeg, 0);
    EXPECT_NE(std::find(defaulted.begin(), defaulted.end(),
                        std::string("outputRotationCwDeg")),
              defaulted.end())
        << "a pre-v14 pack must REPORT that it defaulted the bake, not hide it";

    // And it round-trips through the echo every writer emits.
    Config echoSrc;
    echoSrc.outputRotationCwDeg = 270;
    std::string js;
    rnis::pano::replay::appendConfigJson(js, echoSrc);
    EXPECT_NE(js.find("\"outputRotationCwDeg\":270"), std::string::npos) << js;
}

// The cheap lead-out (Config::leadOutTraj) is a knob on the same three paths:
// `--set leadOutTraj=0` by name, seeded from a pack's meta, and echoed by every
// writer — the pattern crossSweepFit / leadOutFromFrontier already follow.
//
// RED, observed (no table row): applyConfigOverride returns 0 (unknown), the
// meta seed leaves the default, and the echo has no such key.
TEST(PanoReplayOverrides, TheCheapLeadOutIsAKnobOnAllThreePaths) {
    Config c;
    EXPECT_TRUE(c.leadOutTraj) << "the default is the shipped behaviour: on";
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "leadOutTraj", "0"), 1)
        << "`--set leadOutTraj=0` landed in overridesUnknown";
    EXPECT_FALSE(c.leadOutTraj);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "leadOutTraj", "1"), 1);
    EXPECT_TRUE(c.leadOutTraj);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "leadOutTraj", "false"), 1);
    EXPECT_FALSE(c.leadOutTraj);

    // Seeded from a pack.
    Config seeded;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"leadOutTraj\":false}}", seeded, nullptr, nullptr));
    EXPECT_FALSE(seeded.leadOutTraj);

    // A pack written before the knob existed replays with it ON — what
    // produced it — and says so.
    Config old_;
    std::vector<std::string> found, defaulted;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"workScale\":0.5}}", old_, &found, &defaulted));
    EXPECT_TRUE(old_.leadOutTraj);
    EXPECT_NE(std::find(defaulted.begin(), defaulted.end(), std::string("leadOutTraj")),
              defaulted.end())
        << "an older pack must REPORT that it defaulted the knob";

    // And it round-trips through the echo every writer emits.
    Config echoSrc;
    echoSrc.leadOutTraj = false;
    std::string js;
    rnis::pano::replay::appendConfigJson(js, echoSrc);
    EXPECT_NE(js.find("\"leadOutTraj\":false"), std::string::npos) << js;
    Config back;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig("{\"config\":" + js + "}", back,
                                                    nullptr, nullptr));
    EXPECT_FALSE(back.leadOutTraj);
}

// THE SEED JUNCTION (Config::seedFrontierMeet) ON ALL THREE PATHS.  Same
// shape as the lead-out knob above: `--set`, a pack's own config block, and
// the echo every writer emits.  Written against the observed RED — before the
// table row existed `applyConfigOverride` returned 0 and `--set
// seedFrontierMeet=1` landed silently in `overridesUnknown`, which is exactly
// how an A/B arm ends up reporting a knob it never actually set.
TEST(PanoReplayOverrides, TheSeedFrontierMeetIsAKnobOnAllThreePaths) {
    Config c;
    EXPECT_FALSE(c.seedFrontierMeet) << "the default is the shipped behaviour: off";
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "seedFrontierMeet", "1"), 1)
        << "`--set seedFrontierMeet=1` landed in overridesUnknown";
    EXPECT_TRUE(c.seedFrontierMeet);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, "seedFrontierMeet", "false"), 1);
    EXPECT_FALSE(c.seedFrontierMeet);

    Config seeded;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"seedFrontierMeet\":true}}", seeded, nullptr, nullptr));
    EXPECT_TRUE(seeded.seedFrontierMeet);

    // Every pack on this machine was written before the knob existed; each one
    // must replay with it OFF — what produced it — and SAY that it defaulted.
    Config old_;
    std::vector<std::string> found, defaulted;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"workScale\":0.5}}", old_, &found, &defaulted));
    EXPECT_FALSE(old_.seedFrontierMeet);
    EXPECT_NE(std::find(defaulted.begin(), defaulted.end(),
                        std::string("seedFrontierMeet")), defaulted.end())
        << "an older pack must REPORT that it defaulted the knob";

    Config echoSrc;
    echoSrc.seedFrontierMeet = true;
    std::string js;
    rnis::pano::replay::appendConfigJson(js, echoSrc);
    EXPECT_NE(js.find("\"seedFrontierMeet\":true"), std::string::npos) << js;
    Config back;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig("{\"config\":" + js + "}", back,
                                                    nullptr, nullptr));
    EXPECT_TRUE(back.seedFrontierMeet);
}

// WHERE THE MEET IS ALLOWED TO MEASURE FROM — the second half of the knob.
//
// `Config::seedFrontierMeetPinMeasure` decides whether the meet also drags the
// gain-fit / jog-guard window forward with the paint.  It has to be reachable
// from a replay arm or the operator cannot A/B the two anchors on pictures,
// which is the only way that question gets answered.  Same three paths, and
// the same RED: without the table row `--set seedFrontierMeetPinMeasure=0`
// returns 0 and lands in `overridesUnknown` — an arm that silently did not
// change what it says it changed.
TEST(PanoReplayOverrides, TheSeedFrontierMeasureAnchorIsAKnobOnAllThreePaths) {
    Config c;
    EXPECT_TRUE(c.seedFrontierMeetPinMeasure)
        << "the meet's default is the PINNED anchor: the knob must not be able "
           "to change a d8 decision unless the operator asks for the coupled "
           "arm by name";
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(
                  c, "seedFrontierMeetPinMeasure", "0"), 1)
        << "`--set seedFrontierMeetPinMeasure=0` landed in overridesUnknown";
    EXPECT_FALSE(c.seedFrontierMeetPinMeasure);
    EXPECT_EQ(rnis::pano::replay::applyConfigOverride(
                  c, "seedFrontierMeetPinMeasure", "true"), 1);
    EXPECT_TRUE(c.seedFrontierMeetPinMeasure);

    Config seeded;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"seedFrontierMeetPinMeasure\":false}}", seeded,
        nullptr, nullptr));
    EXPECT_FALSE(seeded.seedFrontierMeetPinMeasure);

    Config old_;
    std::vector<std::string> found, defaulted;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
        "{\"config\":{\"workScale\":0.5}}", old_, &found, &defaulted));
    EXPECT_TRUE(old_.seedFrontierMeetPinMeasure);
    EXPECT_NE(std::find(defaulted.begin(), defaulted.end(),
                        std::string("seedFrontierMeetPinMeasure")),
              defaulted.end())
        << "an older pack must REPORT that it defaulted the anchor";

    Config echoSrc;
    echoSrc.seedFrontierMeetPinMeasure = false;
    std::string js;
    rnis::pano::replay::appendConfigJson(js, echoSrc);
    EXPECT_NE(js.find("\"seedFrontierMeetPinMeasure\":false"), std::string::npos)
        << js;
    Config back;
    ASSERT_TRUE(rnis::pano::replay::applyMetaConfig("{\"config\":" + js + "}",
                                                    back, nullptr, nullptr));
    EXPECT_FALSE(back.seedFrontierMeetPinMeasure);
}

// ── the low-light registration gate (2026-09-07), step 1 ──────────────────
// RED, observed 2026-09-07: `crossResidualGate` landed in overridesUnknown
// (applyConfigOverride returned 0) and the FrameOutcome had no `crossGated`.
TEST(PanoCrossGate, ReplayTableRoundTripsTheSevenKnobs) {
    struct K { const char* name; double set; };
    const K knobs[] = {
        {"crossResidualGate", 1.0},       {"crossTextureMinVar", 12.5},
        {"crossPeakMinPSR", 3.25},        {"crossPeakMinMass", 0.15},
        {"crossPeriodGuard", 1.0},        {"crossPeriodMaxFrac", 0.4},
        {"crossPeakSecondaryFrac", 0.6},
    };
    auto get = [](const Config& c, const std::string& n) -> double {
        if (n == "crossResidualGate") return (double)c.crossResidualGate;
        if (n == "crossTextureMinVar") return c.crossTextureMinVar;
        if (n == "crossPeakMinPSR") return c.crossPeakMinPSR;
        if (n == "crossPeakMinMass") return c.crossPeakMinMass;
        if (n == "crossPeriodGuard") return (double)c.crossPeriodGuard;
        if (n == "crossPeriodMaxFrac") return c.crossPeriodMaxFrac;
        if (n == "crossPeakSecondaryFrac") return c.crossPeakSecondaryFrac;
        return -1e9;
    };
    for (const K& k : knobs) {
        SCOPED_TRACE(k.name);
        Config c;
        EXPECT_DOUBLE_EQ(get(c, k.name), 0.0) << "every gate knob ships at 0";
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.17g", k.set);
        EXPECT_EQ(rnis::pano::replay::applyConfigOverride(c, k.name, buf), 1)
            << "`--set " << k.name << "=…` landed in overridesUnknown";
        EXPECT_DOUBLE_EQ(get(c, k.name), k.set);

        // Seeded from a pack.
        Config seeded;
        ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
            std::string("{\"config\":{\"") + k.name + "\":" + buf + "}}", seeded,
            nullptr, nullptr));
        EXPECT_DOUBLE_EQ(get(seeded, k.name), k.set);

        // A pack written before the knob existed replays at 0 and says so.
        Config old_;
        std::vector<std::string> found, defaulted;
        ASSERT_TRUE(rnis::pano::replay::applyMetaConfig(
            "{\"config\":{\"workScale\":0.5}}", old_, &found, &defaulted));
        EXPECT_DOUBLE_EQ(get(old_, k.name), 0.0);
        EXPECT_NE(std::find(defaulted.begin(), defaulted.end(), std::string(k.name)),
                  defaulted.end())
            << "an older pack must REPORT that it defaulted the knob";

        // And it round-trips through the echo every writer emits.
        std::string js;
        rnis::pano::replay::appendConfigJson(js, c);
        EXPECT_NE(js.find(std::string("\"") + k.name + "\":"), std::string::npos) << js;
        Config back;
        ASSERT_TRUE(rnis::pano::replay::applyMetaConfig("{\"config\":" + js + "}", back,
                                                        nullptr, nullptr));
        EXPECT_DOUBLE_EQ(get(back, k.name), k.set);
    }
    // The two ints are spelled as ints, not `1.0`.
    Config c;
    c.crossResidualGate = 1;
    c.crossPeriodGuard = 1;
    std::string js;
    rnis::pano::replay::appendConfigJson(js, c);
    EXPECT_NE(js.find("\"crossResidualGate\":1,"), std::string::npos) << js;
    EXPECT_NE(js.find("\"crossPeriodGuard\":1,"), std::string::npos) << js;
}

TEST(PanoCrossGate, LedgerWritesTheStatsBlockOnlyWhenItWasComputed) {
    rnis::pano::FrameOutcome row;
    row.seq = 7;
    row.outcome = rnis::pano::Outcome::Painted;
    std::string off;
    rnis::pano::replay::appendLedgerLine(off, row);
    EXPECT_EQ(off.find("crossGated"), std::string::npos)
        << "a row the gate never touched must be textually the v15 row: " << off;
    EXPECT_EQ(off.find("crossTextureVar"), std::string::npos);
    EXPECT_EQ(off.find("crossResidualRawPx"), std::string::npos);

    row.crossStatsComputed = true;
    row.crossGated = 0;
    row.crossTextureVar = 123.5;
    row.crossPeakPSR = 4.25;
    row.crossPeakMass = 0.125;
    row.crossDominantPeriodPx = 18.5;
    row.crossPeakSecondary = 0.5;
    row.crossResidualRawPx = -0.25;
    std::string on;
    rnis::pano::replay::appendLedgerLine(on, row);
    EXPECT_NE(on.find("\"crossGated\":0"), std::string::npos) << on;
    EXPECT_NE(on.find("\"crossTextureVar\":123.5"), std::string::npos) << on;
    EXPECT_NE(on.find("\"crossPeakPSR\":4.25"), std::string::npos) << on;
    EXPECT_NE(on.find("\"crossPeakMass\":0.125"), std::string::npos) << on;
    EXPECT_NE(on.find("\"crossDominantPeriodPx\":18.5"), std::string::npos) << on;
    EXPECT_NE(on.find("\"crossPeakSecondary\":0.5"), std::string::npos) << on;
    EXPECT_NE(on.find("\"crossResidualRawPx\":-0.25"), std::string::npos) << on;
    // Every pre-existing field is still there, in its place, before the block.
    EXPECT_LT(on.find("\"crossAvgDeltaPx\":"), on.find("\"crossGated\":"));
    EXPECT_LT(on.find("\"crossResidualRawPx\":"), on.find("\"expGain\":"));

    // A non-finite statistic is written as null, never as a bare nan.
    row.crossPeakPSR = std::numeric_limits<double>::quiet_NaN();
    std::string nan;
    rnis::pano::replay::appendLedgerLine(nan, row);
    EXPECT_NE(nan.find("\"crossPeakPSR\":null"), std::string::npos) << nan;
    // (`":nan`, not `nan` — "crossDomi-nan-tPeriodPx" is a field name.)
    EXPECT_EQ(nan.find(":nan"), std::string::npos) << nan;
    EXPECT_EQ(nan.find(":inf"), std::string::npos) << nan;
}

TEST(PanoCrossGate, TheReportCarriesTheThreeCountersBesideTheJogGuards) {
    ReplayReport r;
    r.stats.crossGatedTexture = 3;
    r.stats.crossGatedPeak = 2;
    r.stats.crossGatedPeriod = 1;
    const std::string js = rnis::pano::replay::reportToJson(r);
    EXPECT_NE(js.find("\"crossGatedTexture\":3"), std::string::npos) << js;
    EXPECT_NE(js.find("\"crossGatedPeak\":2"), std::string::npos) << js;
    EXPECT_NE(js.find("\"crossGatedPeriod\":1"), std::string::npos) << js;
    EXPECT_LT(js.find("\"d8JogForced\":"), js.find("\"crossGatedTexture\":"));
}

TEST(PanoReplayOverrides, TheReportSeparatesTheThreeOutcomes) {
    ScratchDir s("ovr");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.maxFrames = 3;                 // plumbing only — keep it quick
    o.configOverrides.push_back(std::make_pair(std::string("rectify"), std::string("false")));
    o.configOverrides.push_back(std::make_pair(std::string("nope"), std::string("1")));
    o.configOverrides.push_back(std::make_pair(std::string("gainCumClamp"), std::string("wat")));
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.overridesApplied.size(), 1u);
    EXPECT_EQ(r.overridesUnknown.size(), 1u);
    EXPECT_EQ(r.overridesMalformed.size(), 1u);
    EXPECT_FALSE(r.resolvedConfig.rectify);
}

// ── the synthetic pack ──────────────────────────────────────────────────────

TEST(PanoReplaySynthetic, ASmallPackReplaysWithSaneCounts) {
    ScratchDir s("synth");
    SynthPackSpec spec;
    spec.frames = 24;
    const std::string root = makeSynthPack(s, "p", spec);

    ReplayOptions o;
    o.packDir = root;
    o.outDir = s.at("out");
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    EXPECT_TRUE(r.haveMeta);
    EXPECT_EQ(r.rowsTotal, spec.frames);
    EXPECT_EQ(r.framesRead, spec.frames);
    EXPECT_EQ(r.framesIngested, spec.frames);
    EXPECT_EQ(r.rowsMalformed, 0);
    EXPECT_EQ(r.framesMissing, 0);
    EXPECT_EQ(r.framesUnreadable, 0);
    EXPECT_EQ(r.rowsMissingTracking, 0);
    EXPECT_EQ(r.intrinsicsRescaled, 0);
    EXPECT_EQ(r.grayWorkSizeCorrected, 0);
    EXPECT_EQ(r.rowsTruncated, 0);

    // EXACTLY ONE LEDGER ROW PER INGESTED FRAME, PLUS THE TAIL FLUSH.  The
    // histogram is only readable under this invariant.
    EXPECT_EQ(histSum(r), r.framesIngested + 1);

    // Every outcome name is present in the histogram even at zero, so two
    // reports diff without a join.
    EXPECT_GE(histAt(r, "painted"), 0);
    EXPECT_GE(histAt(r, "d8-jog-held"), 0);
    EXPECT_GE(histAt(r, "gap-backfilled"), 0);
    EXPECT_EQ(histAt(r, "rejected-input"), 0) << "the driver fed the engine a bad frame";

    // The engine's own view has to agree with the driver's counting.
    EXPECT_EQ((int)r.stats.seen, r.framesIngested);

    EXPECT_GT(r.totalMs, 0.0);
    EXPECT_GT(r.loadMsTotal, 0.0);
    EXPECT_LE(r.msP50, r.msMax);
    EXPECT_LE(r.msP95, r.msMax);

    // A pure translation sweep with real texture must paint something and
    // produce a canvas — otherwise the driver is "working" over a dead engine.
    EXPECT_GT(r.stats.painted, 0);
    EXPECT_GT(r.canvasW, 0);
    EXPECT_GT(r.canvasH, 0);
    EXPECT_TRUE(r.canvasWritten) << r.writeError;

    std::ifstream cf(r.canvasPath.c_str(), std::ios::binary);
    EXPECT_TRUE(cf.good()) << "canvas.jpg not on disk at " << r.canvasPath;
    const std::string ledger = readText(r.ledgerPath);
    EXPECT_FALSE(ledger.empty());
    // Same field names as the device writer, so a textual diff is meaningful.
    EXPECT_NE(ledger.find("\"seamCanvasJogSignedPx\""), std::string::npos);
    EXPECT_NE(ledger.find("\"chainAdvanced\""), std::string::npos);

    EXPECT_FALSE(r.fidelityNote.empty());
    EXPECT_FALSE(r.attitudeNote.empty());
}

TEST(PanoReplaySynthetic, TheTailFlushRowIsWrittenAtSeqMinusOneLikeTheDevice) {
    // FOUND BY THE FIRST REAL-PACK DIFF, not by reasoning.  Engine::finish()
    // never sets row.seq, so it comes back at the FrameOutcome default of 0;
    // RNISPanoCore.mm therefore hard-codes "seq":-1 and writes only five
    // fields.  A driver that copies the ordinary row writer here puts a full
    // row at seq 0, which COLLIDES with frame 0 in any per-seq join: the
    // device's tail row then reads as oracle-only and frame 0's real outcome
    // reads as a disagreement with a tail flush.
    ScratchDir s("tailrow");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.outDir = s.at("out");
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    const std::string ledger = readText(r.ledgerPath);
    const size_t lastNl = ledger.find_last_of('\n', ledger.size() - 2);
    ASSERT_NE(lastNl, std::string::npos);
    const std::string tail = ledger.substr(lastNl + 1);
    EXPECT_EQ(tail.compare(0, 12, "{\"seq\":-1,\"o"), 0) << tail;
    EXPECT_NE(tail.find("\"outcome\":\"tail-flush\""), std::string::npos) << tail;
    EXPECT_NE(tail.find("\"highWater\""), std::string::npos) << tail;
    // The SHORT row: the ordinary row's fields must NOT be here, or a textual
    // diff against a device ledger reports a difference at every tail.
    EXPECT_EQ(tail.find("\"advanceX\""), std::string::npos) << tail;
    EXPECT_EQ(tail.find("\"seamCanvasJogPx\""), std::string::npos) << tail;

    // …and no seq appears twice, which is what the per-seq join depends on.
    int seqZero = 0;
    for (size_t p = 0; (p = ledger.find("{\"seq\":0,", p)) != std::string::npos; ++p) {
        ++seqZero;
    }
    EXPECT_EQ(seqZero, 1) << "two ledger rows claim seq 0";
}

TEST(PanoReplaySynthetic, TheMetaConfigIsAdoptedAndAbsentKnobsAreNamed) {
    ScratchDir s("cfg");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.maxFrames = 2;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    EXPECT_TRUE(contains(r.configFound, "workScale"));
    EXPECT_TRUE(contains(r.configFound, "d8JogGuard"));
    EXPECT_TRUE(contains(r.configFound, "lensDeviceModel"));
    EXPECT_TRUE(r.resolvedConfig.d8JogGuard) << "the pack ran the v13 jog guard";
    EXPECT_EQ(r.resolvedConfig.lensDeviceModel, "synthetic-model");
    // The synthetic meta carries only a dozen knobs, so the rest MUST be
    // reported as defaulted rather than silently taken.
    EXPECT_TRUE(contains(r.configDefaulted, "stripMargin"));
    EXPECT_TRUE(contains(r.configDefaulted, "lensK1"));
    EXPECT_TRUE(contains(r.configDefaulted, "lensDeviceLens"));
}

TEST(PanoReplaySynthetic, TheDevicesOwnCanvasDimsAreCarriedForComparison) {
    // The pad-row trim is recorded NOWHERE in a pack (not meta.json, not
    // result.json — checked on a v11 and a v13 pack), so a replay cannot
    // adopt the device's finalize setting and must not pretend to.  What it
    // CAN do is carry the device's own numbers beside its own, which is the
    // difference between a reader seeing a 19% size gap and understanding it:
    // a pre-v12 pack was finalized untrimmed and its outputW is ~2 x
    // canvasPadPx larger for the very same sweep.
    ScratchDir s("devdims");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.maxFrames = 2;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.deviceOutputW, 777);
    EXPECT_EQ(r.deviceOutputH, 555);
    EXPECT_EQ(r.devicePaintedW, 999);
    EXPECT_TRUE(r.canvasCropPadApplied) << "the v12+ default";
    EXPECT_FALSE(r.canvasNote.empty());

    // A pack with no meta.json reports NOT-KNOWN, never zero.
    SynthPackSpec nometa;
    nometa.writeMeta = false;
    const std::string root2 = makeSynthPack(s, "q", nometa);
    ReplayOptions o2;
    o2.packDir = root2;
    o2.maxFrames = 2;
    ReplayReport r2;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o2, &r2)) << r2.error;
    EXPECT_FALSE(r2.haveMeta);
    EXPECT_EQ(r2.deviceOutputW, -1);
    EXPECT_EQ(r2.devicePaintedW, -1);
    EXPECT_TRUE(contains(r2.configDefaulted, "<all: meta.json not readable>"));
}

TEST(PanoReplaySynthetic, AMalformedTrackRowIsSkippedAndCounted) {
    ScratchDir s("bad");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    const std::string tp = root + "/panoplus/track.jsonl";
    std::string track = readText(tp);
    // Corrupt row 3 in place, leaving every other row intact.
    size_t p = 0;
    for (int i = 0; i < 2; ++i) p = track.find('\n', p) + 1;
    const size_t e = track.find('\n', p);
    track = track.substr(0, p) + "{\"seq\":2,\"q\":[0,0,\n" + track.substr(e + 1);
    ASSERT_TRUE(writeText(tp, track));

    ReplayOptions o;
    o.packDir = root;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.rowsMalformed, 1);
    EXPECT_EQ(r.framesRead, r.rowsTotal - 1);
    EXPECT_EQ(r.framesIngested, r.rowsTotal - 1);
    EXPECT_NE(r.firstMalformedDetail.find("line 3"), std::string::npos)
        << r.firstMalformedDetail;
    EXPECT_EQ(histSum(r), r.framesIngested + 1);
}

TEST(PanoReplaySynthetic, AMissingFrameFileIsSkippedCountedAndNamed) {
    ScratchDir s("missingframe");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ASSERT_EQ(std::remove((root + "/panoplus/frames/frame_000004.jpg").c_str()), 0);
    ASSERT_EQ(std::remove((root + "/panoplus/frames/frame_000005.jpg").c_str()), 0);

    ReplayOptions o;
    o.packDir = root;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.framesMissing, 2);
    EXPECT_EQ(r.framesRead, r.rowsTotal) << "the rows still parsed";
    EXPECT_EQ(r.framesIngested, r.rowsTotal - 2);
    ASSERT_EQ(r.framesMissingExamples.size(), 2u);
    EXPECT_EQ(r.framesMissingExamples[0], "frame_000004.jpg");
}

TEST(PanoReplaySynthetic, AnUnreadableFrameFileIsSkippedAndCounted) {
    ScratchDir s("badframe");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ASSERT_TRUE(writeText(root + "/panoplus/frames/frame_000003.jpg",
                          "this is not a JPEG"));
    ReplayOptions o;
    o.packDir = root;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.framesUnreadable, 1);
    EXPECT_EQ(r.framesMissing, 0);
    EXPECT_EQ(r.framesIngested, r.rowsTotal - 1);
}

TEST(PanoReplaySynthetic, ATransposedRasterIsSkippedNotRescaled) {
    // The Android-leg risk: cv::imread applies EXIF orientation by default, so
    // a pack whose JPEGs carry an orientation tag decodes rotated while
    // track.jsonl still declares the sensor's w/h.  Folding that into the
    // intrinsics rescale would produce a plausible-looking WRONG H_rect on
    // every frame — far worse than a missing frame, and invisible in every
    // count.  Simulated here by replacing one frame with its transpose.
    ScratchDir s("transposed");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    const std::string fp = root + "/panoplus/frames/frame_000006.jpg";
    cv::Mat m = cv::imread(fp, cv::IMREAD_COLOR);
    ASSERT_FALSE(m.empty());
    cv::Mat t;
    cv::transpose(m, t);
    const std::vector<int> q{cv::IMWRITE_JPEG_QUALITY, 92};
    ASSERT_TRUE(cv::imwrite(fp, t, q));

    ReplayOptions o;
    o.packDir = root;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.framesTransposed, 1);
    EXPECT_EQ(r.intrinsicsRescaled, 0) << "a transpose was rescaled";
    EXPECT_EQ(r.framesIngested, r.rowsTotal - 1);
    EXPECT_EQ(histSum(r), r.framesIngested + 1);
}

TEST(PanoReplaySynthetic, MaxFramesIsHonouredAndTheRemainderIsCounted) {
    ScratchDir s("maxframes");
    SynthPackSpec spec;
    spec.frames = 24;
    const std::string root = makeSynthPack(s, "p", spec);

    ReplayOptions o;
    o.packDir = root;
    o.maxFrames = 7;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.rowsTotal, 24);
    EXPECT_EQ(r.framesIngested, 7);
    EXPECT_EQ(r.rowsTruncated, 17);
    EXPECT_EQ(histSum(r), 8);

    // maxFrames LARGER than the pack is not an error and truncates nothing.
    ReplayOptions o2 = o;
    o2.maxFrames = 1000;
    ReplayReport r2;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o2, &r2)) << r2.error;
    EXPECT_EQ(r2.framesIngested, 24);
    EXPECT_EQ(r2.rowsTruncated, 0);
}

TEST(PanoReplaySynthetic, AnEmptyOutDirWritesNothingAndStillMeasures) {
    ScratchDir s("nowrite");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.outDir = "";                 // the read-only-asset-dir case
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_FALSE(r.canvasWritten);
    EXPECT_TRUE(r.canvasPath.empty());
    EXPECT_TRUE(r.ledgerPath.empty());
    EXPECT_TRUE(r.writeError.empty());
    EXPECT_GT(r.canvasW, 0) << "the canvas was still rendered and measured";
    EXPECT_EQ(histSum(r), r.framesIngested + 1);
}

TEST(PanoReplaySynthetic, ThePanoplusDirectoryItselfIsAlsoAValidPackDir) {
    ScratchDir s("ppdir");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root + "/panoplus";
    o.maxFrames = 3;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.framesIngested, 3);
}

// ── the oracle diff ─────────────────────────────────────────────────────────

TEST(PanoReplayOracle, NoLedgerMeansNotMeasuredNeverAgreed) {
    ScratchDir s("noledger");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.maxFrames = 3;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_FALSE(r.haveOracle);
    EXPECT_EQ(r.outcomeAgree, 0);
    EXPECT_EQ(r.outcomeDisagree, 0);
}

TEST(PanoReplayOracle, ALedgerThisDriverWroteAgreesRowForRow) {
    // NOT a claim about the device — see the report's fidelityNote.  This pins
    // that the diff machinery reports agreement when there IS agreement, which
    // is the precondition for reading a real divergence as a finding.
    ScratchDir s("selfdiff");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.outDir = s.at("out1");
    ReplayReport r1;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r1)) << r1.error;
    ASSERT_FALSE(r1.ledgerPath.empty());
    ASSERT_TRUE(writeText(root + "/panoplus/ledger.jsonl", readText(r1.ledgerPath)));

    ReplayOptions o2 = o;
    o2.outDir = s.at("out2");
    ReplayReport r2;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o2, &r2)) << r2.error;
    EXPECT_TRUE(r2.haveOracle);
    EXPECT_EQ(r2.oracleMalformed, 0);
    EXPECT_GT(r2.outcomeAgree, 0);
    EXPECT_EQ(r2.outcomeDisagree, 0) << r2.firstDivergenceDetail;
    EXPECT_EQ(r2.oracleOnlySeqs, 0);
    EXPECT_EQ(r2.replayOnlySeqs, 0);
    EXPECT_EQ(r2.firstDivergenceSeq, -1);
}

TEST(PanoReplayOracle, ADisagreeingLedgerIsReportedWithItsFirstDivergence) {
    ScratchDir s("diff");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    // A hand-made oracle: seq 0 agrees (warming-up), seq 1 does not, seq 900
    // exists only on the oracle side, and one row is malformed.
    ASSERT_TRUE(writeText(
        root + "/panoplus/ledger.jsonl",
        "{\"seq\":0,\"outcome\":\"warming-up\"}\n"
        "{\"seq\":1,\"outcome\":\"painted\"}\n"
        "{\"seq\":900,\"outcome\":\"painted\"}\n"
        "{\"seq\":\n"));
    ReplayOptions o;
    o.packDir = root;
    o.maxFrames = 3;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_TRUE(r.haveOracle);
    EXPECT_EQ(r.oracleMalformed, 1);
    EXPECT_EQ(r.oracleRows, 3);
    EXPECT_EQ(r.outcomeAgree, 1);
    EXPECT_EQ(r.outcomeDisagree, 1);
    EXPECT_EQ(r.firstDivergenceSeq, 1);
    EXPECT_NE(r.firstDivergenceDetail.find("device=painted"), std::string::npos)
        << r.firstDivergenceDetail;
    EXPECT_EQ(r.oracleOnlySeqs, 1) << "seq 900 is oracle-only, not a disagreement";
    EXPECT_GT(r.replayOnlySeqs, 0);
}

// ── the report ──────────────────────────────────────────────────────────────

TEST(PanoReplayReport, TheJsonCarriesTheCountsAndIsWellFormed) {
    ScratchDir s("json");
    const std::string root = makeSynthPack(s, "p", SynthPackSpec());
    ReplayOptions o;
    o.packDir = root;
    o.maxFrames = 5;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    const std::string js = rnis::pano::replay::reportToJson(r);
    // Well-formed enough for the scanner that reads the packs to accept it —
    // the report crosses JNI as a string and something has to parse it.
    Config sink;
    EXPECT_FALSE(rnis::pano::replay::applyMetaConfig(js, sink, nullptr, nullptr))
        << "the report should have no `config` object";
    EXPECT_NE(js.find("\"outcomeCounts\""), std::string::npos);
    EXPECT_NE(js.find("\"msP95\""), std::string::npos);
    EXPECT_NE(js.find("\"framesIngested\":5"), std::string::npos);
    EXPECT_NE(js.find("\"fidelityNote\""), std::string::npos);
    EXPECT_NE(js.find("\"attitudeNote\""), std::string::npos);
    EXPECT_NE(js.find("\"grayWorkSizeCorrected\""), std::string::npos);
    EXPECT_EQ(js[0], '{');
    EXPECT_EQ(js[js.size() - 1], '}');
}

TEST(PanoReplayReport, TheReportJsonSurvivesAFailedRun) {
    // The Android leg's most likely first result is a refusal, and it has to
    // come back as a readable report rather than an empty string.
    ReplayOptions o;
    o.packDir = "/definitely/not/a/pack";
    ReplayReport r;
    EXPECT_FALSE(rnis::pano::replay::replayPack(o, &r));
    const std::string js = rnis::pano::replay::reportToJson(r);
    EXPECT_NE(js.find("\"ok\":false"), std::string::npos);
    EXPECT_NE(js.find("\"error\""), std::string::npos);
    EXPECT_EQ(js[0], '{');
}

// ── the per-tick PREVIEW GEOMETRY ledger ───────────────────────────────────
//
// WHAT THESE PIN, and why each one is here.
//
//   * OFF IS OFF.  The instrumentation is diagnostics; with it disabled the
//     deliverable must be the same BYTES.  Asserted directly — canvas.jpg
//     compared byte for byte between the two arms, and ledger.jsonl compared
//     with `engineMs` stripped, because that one field is a wall-clock
//     measurement and is not reproducible even between two runs of the SAME
//     binary (measured 2026-09-05 over the operator's 12 packs: ledger differs
//     12/12 raw, 0/12 with engineMs removed; canvas.jpg 0/12 either way).
//   * EVERY TICK IS A ROW, and the LAST row is the final republish — the one
//     RNISPanoCore.mm renders from the finished engine with `windowAlongPx=0`
//     and `leadOut=false`. It is the control: the row where the provisional
//     region is gone, against which every live row's `leadOutPx` is read.
//   * THE GEOMETRY IS INTERNALLY CONSISTENT.  A row whose `viewEndU` did not
//     include its own lead-out, or whose frontier sat outside the view it
//     claims to be inside, would put a boundary marker in the wrong place —
//     which is precisely the question this file was added to answer.
//   * THE HOST'S KNOBS COME OUT OF THE PACK, not out of a compiled default.
//     `previewWindowCrossMult` is computed on the phone from the on-screen
//     capsule and reads 6.577 on the operator's 2026-09-05 packs against a
//     1.44 default — rendering at the default would move the window edge and
//     then attribute the difference to the engine.
//   * AND IT IS READ FROM `config.pack`, NOT THE TOP LEVEL.  Same nesting
//     discipline PanoReplayJson.ANestedPackObjectDoesNotLeakIntoTheTopLevel-
//     Config pins in the other direction.

namespace {

std::vector<std::string> splitLines(const std::string& t) {
    std::vector<std::string> out;
    std::string cur;
    for (size_t i = 0; i < t.size(); ++i) {
        if (t[i] == '\n') { if (!cur.empty()) out.push_back(cur); cur.clear(); }
        else if (t[i] != '\r') cur += t[i];
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

/// The raw text of `"key":<value>` in one FLAT jsonl row.  Flat is the whole
/// reason a substring search is safe here: preview.jsonl rows contain no
/// nested object and no string value that could itself spell `"key":`.
bool jsonRaw(const std::string& row, const char* key, std::string* out) {
    const std::string pat = std::string("\"") + key + "\":";
    const size_t p = row.find(pat);
    if (p == std::string::npos) return false;
    size_t b = p + pat.size();
    size_t e = b;
    while (e < row.size() && row[e] != ',' && row[e] != '}') ++e;
    *out = row.substr(b, e - b);
    return true;
}

double jsonNum(const std::string& row, const char* key, bool* ok) {
    std::string raw;
    if (ok) *ok = false;
    if (!jsonRaw(row, key, &raw) || raw.empty() || raw == "null") return 0.0;
    char* endp = nullptr;
    const double v = std::strtod(raw.c_str(), &endp);
    if (endp == nullptr || *endp != '\0') return 0.0;
    if (ok) *ok = true;
    return v;
}

bool jsonBool(const std::string& row, const char* key) {
    std::string raw;
    return jsonRaw(row, key, &raw) && raw == "true";
}

/// ledger.jsonl with the one non-reproducible field removed.  Named here, not
/// hidden in a helper called `normalise`: the reader has to know exactly what
/// was excluded before a byte-identity claim means anything.
std::string ledgerWithoutEngineMs(const std::string& t) {
    std::string out;
    out.reserve(t.size());
    const std::string pat = ",\"engineMs\":";
    size_t p = 0;
    for (;;) {
        const size_t q = t.find(pat, p);
        if (q == std::string::npos) { out += t.substr(p); break; }
        out += t.substr(p, q - p);
        size_t e = q + pat.size();
        while (e < t.size() && t[e] != ',' && t[e] != '}') ++e;
        p = e;
    }
    return out;
}

bool dirExists(const std::string& p) {
    struct stat st;
    return ::stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

}  // namespace

TEST(PanoReplayPreview, OffWritesNothingAndDoesNotMoveTheDeliverable) {
    ScratchDir s("pvoff");
    const std::string pack = makeSynthPack(s, "pack", SynthPackSpec());

    ReplayOptions off;
    off.packDir = pack;
    off.outDir = s.at("out-off");
    ReplayReport ro;
    ASSERT_TRUE(rnis::pano::replay::replayPack(off, &ro)) << ro.error;

    EXPECT_FALSE(ro.previewEnabled);
    EXPECT_EQ(ro.previewTicks, 0);
    EXPECT_EQ(ro.previewPublished, 0);
    EXPECT_EQ(ro.previewImagesWritten, 0);
    EXPECT_TRUE(ro.previewJsonlPath.empty());
    EXPECT_TRUE(ro.previewImageDir.empty());
    EXPECT_TRUE(readText(s.at("out-off") + "/preview.jsonl").empty())
        << "the flag is off and a file was written anyway";
    EXPECT_FALSE(dirExists(s.at("out-off") + "/preview"));

    ReplayOptions on = off;
    on.outDir = s.at("out-on");
    on.preview.enabled = true;
    on.preview.imageEveryN = 1;
    ReplayReport rn;
    ASSERT_TRUE(rnis::pano::replay::replayPack(on, &rn)) << rn.error;
    ASSERT_GT(rn.previewTicks, 0) << "the ON arm rendered nothing to compare";

    // THE CLAIM: the diagnostic does not move one deliverable byte.
    const std::string ca = readText(s.at("out-off") + "/canvas.jpg");
    const std::string cb = readText(s.at("out-on") + "/canvas.jpg");
    ASSERT_FALSE(ca.empty());
    EXPECT_EQ(ca, cb) << "canvas.jpg moved when the preview flag was flipped";
    EXPECT_EQ(ledgerWithoutEngineMs(readText(s.at("out-off") + "/ledger.jsonl")),
              ledgerWithoutEngineMs(readText(s.at("out-on") + "/ledger.jsonl")))
        << "ledger.jsonl moved (excluding engineMs) when the flag was flipped";
    // …and the throughput number the driver exists to produce is not inflated
    // by the render: its cost is reported separately.
    EXPECT_GT(rn.previewMsTotal, 0.0);
}

TEST(PanoReplayPreview, EveryTickIsARowAndTheLastOneIsTheFinalRepublish) {
    ScratchDir s("pvrows");
    const std::string pack = makeSynthPack(s, "pack", SynthPackSpec());

    ReplayOptions o;
    o.packDir = pack;
    o.outDir = s.at("out");
    o.preview.enabled = true;
    o.preview.imageEveryN = 1;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    EXPECT_TRUE(r.previewEnabled);
    ASSERT_GE(r.previewTicks, 3) << "a 400 ms sweep at 120 ms should tick 3+ times";
    EXPECT_EQ(r.previewPublished + r.previewRefused, r.previewTicks);
    ASSERT_FALSE(r.previewJsonlPath.empty());

    const std::vector<std::string> rows =
        splitLines(readText(s.at("out") + "/preview.jsonl"));
    ASSERT_EQ((int)rows.size(), r.previewTicks)
        << "one row per tick, no more and no fewer";

    for (size_t i = 0; i + 1 < rows.size(); ++i) {
        bool ok = false;
        EXPECT_EQ(jsonNum(rows[i], "tick", &ok), (double)i);
        EXPECT_TRUE(ok);
        EXPECT_FALSE(jsonBool(rows[i], "finalRepublish"))
            << "row " << i << " claims to be the final republish";
    }
    const std::string& last = rows.back();
    EXPECT_TRUE(jsonBool(last, "finalRepublish"));
    EXPECT_TRUE(jsonBool(last, "published"));
    bool ok = false;
    EXPECT_EQ(jsonNum(last, "seq", &ok), -1.0);
    EXPECT_FALSE(jsonBool(last, "leadOutRequested"))
        << "the final republish must ask for no provisional region";
    EXPECT_EQ(jsonNum(last, "leadOutPx", &ok), 0.0)
        << "the tail flush has committed it; nothing is provisional any more";
    EXPECT_EQ(jsonNum(last, "windowAlongPx", &ok), 0.0)
        << "RNISPanoCore.mm renders the final republish over the WHOLE band";

    const std::string js = rnis::pano::replay::reportToJson(r);
    EXPECT_NE(js.find("\"previewEnabled\":true"), std::string::npos);
    EXPECT_NE(js.find("\"previewTicks\""), std::string::npos);
    EXPECT_NE(js.find("\"previewSettings\""), std::string::npos);
}

TEST(PanoReplayPreview, PublishedRowsCarryTheWindowGeometryTheEngineReports) {
    ScratchDir s("pvgeom");
    const std::string pack = makeSynthPack(s, "pack", SynthPackSpec());

    ReplayOptions o;
    o.packDir = pack;
    o.outDir = s.at("out");
    o.preview.enabled = true;
    o.preview.imageEveryN = 0;          // geometry only
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;
    EXPECT_EQ(r.previewImagesWritten, 0) << "imageEveryN=0 asked for no images";

    const std::vector<std::string> rows =
        splitLines(readText(s.at("out") + "/preview.jsonl"));
    ASSERT_FALSE(rows.empty());

    int checked = 0;
    for (size_t i = 0; i < rows.size(); ++i) {
        const std::string& row = rows[i];
        if (!jsonBool(row, "published")) continue;
        if (jsonBool(row, "seed")) continue;   // the held reference frame: no band
        bool ok = false;
        const double bandStart = jsonNum(row, "bandStartU", &ok);   ASSERT_TRUE(ok);
        const double bandEnd   = jsonNum(row, "bandEndU", &ok);     ASSERT_TRUE(ok);
        const double viewStart = jsonNum(row, "viewStartU", &ok);   ASSERT_TRUE(ok);
        const double viewEnd   = jsonNum(row, "viewEndU", &ok);     ASSERT_TRUE(ok);
        const double leadPx    = jsonNum(row, "leadOutPx", &ok);    ASSERT_TRUE(ok);
        const double frontier  = jsonNum(row, "frontierU", &ok);    ASSERT_TRUE(ok);
        const double frac      = jsonNum(row, "frontierFrac", &ok); ASSERT_TRUE(ok);
        const double imageW    = jsonNum(row, "imageW", &ok);       ASSERT_TRUE(ok);
        const double imageH    = jsonNum(row, "imageH", &ok);       ASSERT_TRUE(ok);
        const double crossAll  = jsonNum(row, "canvasCrossPx", &ok);ASSERT_TRUE(ok);
        const double crossView = jsonNum(row, "viewCrossPx", &ok);  ASSERT_TRUE(ok);

        EXPECT_GT(bandEnd, bandStart) << "row " << i;
        EXPECT_GE(viewStart, bandStart) << "row " << i;
        EXPECT_GT(viewEnd, viewStart) << "row " << i;
        // `viewEndU` INCLUDES the provisional lead-out — that is the property
        // that lets a marker at frontierFrac divide committed from provisional
        // rather than landing at the image edge.
        EXPECT_LE(viewEnd - leadPx, bandEnd) << "row " << i;
        if (!jsonBool(row, "windowed")) {
            EXPECT_DOUBLE_EQ(viewStart, bandStart) << "row " << i;
            EXPECT_DOUBLE_EQ(viewEnd - leadPx, bandEnd)
                << "row " << i << ": an unwindowed view must end at the band";
        }
        EXPECT_GE(leadPx, 0.0) << "row " << i;
        // The pad trim can only ever REMOVE rows.
        EXPECT_LE(crossView, crossAll) << "row " << i;
        EXPECT_GT(imageW, 0.0) << "row " << i;
        EXPECT_GT(imageH, 0.0) << "row " << i;
        if (frac >= 0.0) {
            EXPECT_LE(frac, 1.0) << "row " << i;
            EXPECT_GE(frontier, viewStart) << "row " << i;
            EXPECT_LE(frontier, viewEnd) << "row " << i;
        }
        // When the lead-out placed columns, the view's far edge IS the ceiling
        // of the provisional end the engine resolved.
        if (leadPx > 0.0) {
            const double leadEnd = jsonNum(row, "leadEndU", &ok);
            ASSERT_TRUE(ok) << "row " << i << ": leadOutPx>0 with no leadEndU";
            EXPECT_DOUBLE_EQ(viewEnd, std::ceil(leadEnd)) << "row " << i;
            EXPECT_TRUE(jsonBool(row, "liveValid")) << "row " << i;
        }
        ++checked;
    }
    EXPECT_GT(checked, 0) << "no published, non-seed row to check the geometry on";
}

TEST(PanoReplayPreview, ImagesAreSavedEveryNthAndTheCapIsReported) {
    ScratchDir s("pvimg");
    const std::string pack = makeSynthPack(s, "pack", SynthPackSpec());

    ReplayOptions o;
    o.packDir = pack;
    o.outDir = s.at("out");
    o.preview.enabled = true;
    o.preview.imageEveryN = 1;
    o.preview.imageMaxCount = 1;        // the cap, deliberately tiny
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    EXPECT_EQ(r.previewImagesWritten, 1);
    EXPECT_TRUE(r.previewImagesCapped) << "the cap bit and the report must say so";
    EXPECT_EQ(r.previewImageWriteFailed, 0);
    ASSERT_FALSE(r.previewImageDir.empty());

    // WHICH tick got the image is NOT assumed — the first ticks of a sweep are
    // REFUSED (nothing is painted until the reference latch), and asserting
    // `preview_00000.jpg` here is what caught that: the first image on the
    // synthetic pack is a later tick. The JSONL names the file; that name is
    // the thing under test, and the number in it must be that row's `tick`.
    const std::vector<std::string> rows =
        splitLines(readText(s.at("out") + "/preview.jsonl"));
    ASSERT_FALSE(rows.empty());
    int named = 0;
    for (size_t i = 0; i < rows.size(); ++i) {
        std::string raw;
        if (!jsonRaw(rows[i], "image", &raw) || raw == "null") continue;
        ++named;
        bool ok = false;
        const int tick = (int)jsonNum(rows[i], "tick", &ok);
        ASSERT_TRUE(ok);
        char want[64];
        std::snprintf(want, sizeof(want), "\"preview/preview_%05d.jpg\"", tick);
        EXPECT_EQ(raw, std::string(want))
            << "the filename must carry the tick, or the join is a lookup table";
        EXPECT_TRUE(jsonBool(rows[i], "published"))
            << "a refused tick has no image to name";
        const std::string abs =
            r.previewImageDir + "/" + raw.substr(1 + 8, raw.size() - 2 - 8);
        const cv::Mat img = cv::imread(abs, cv::IMREAD_COLOR);
        ASSERT_FALSE(img.empty()) << abs << " is not a readable image";
        EXPECT_EQ(jsonNum(rows[i], "imageW", &ok), (double)img.cols);
        EXPECT_EQ(jsonNum(rows[i], "imageH", &ok), (double)img.rows);
    }
    EXPECT_EQ(named, 1) << "exactly one image was written; exactly one row names it";
}

TEST(PanoReplayPreview, TheHostPreviewKnobsAreReadOutOfTheMetaPackBlock) {
    const std::string meta =
        "{\n"
        "  \"preview\": { \"leadOutEnabled\": false, \"published\": 40 },\n"
        "  \"config\": {\n"
        "    \"workScale\": 0.5,\n"
        "    \"pack\": {\n"
        "      \"previewIntervalMs\": 250,\n"
        "      \"previewMaxAlong\": 1234,\n"
        "      \"previewMaxCross\": 567,\n"
        "      \"previewWindowAlongPx\": 0,\n"
        "      \"previewWindowCrossMult\": 6.576923076923077,\n"
        "      \"previewCropPad\": true,\n"
        "      \"previewQuality\": 71\n"
        "    }\n"
        "  }\n"
        "}\n";
    rnis::pano::replay::PackPreviewSettings ps;
    ASSERT_TRUE(rnis::pano::replay::readPackPreviewSettings(meta, &ps));
    EXPECT_DOUBLE_EQ(ps.intervalMs, 250.0);
    EXPECT_EQ(ps.maxAlong, 1234);
    EXPECT_EQ(ps.maxCross, 567);
    EXPECT_EQ(ps.windowAlongPx, 0);
    EXPECT_NEAR(ps.windowCrossMult, 6.576923076923077, 1e-12);
    EXPECT_TRUE(ps.cropPad);
    EXPECT_EQ(ps.quality, 71);
    // The eighth knob is a VERDICT and lives in the top-level preview block,
    // not with the requests — and `false` must survive as false, not fall back
    // to the `true` default.
    EXPECT_FALSE(ps.leadOut);
    EXPECT_TRUE(contains(ps.found, "config.pack.previewWindowCrossMult"));
    EXPECT_TRUE(contains(ps.found, "preview.leadOutEnabled"));
    EXPECT_TRUE(ps.defaulted.empty()) << "every knob was present and readable";
}

TEST(PanoReplayPreview, AnAbsentKnobIsNamedNotSilentlyDefaulted) {
    const std::string meta = "{ \"config\": { \"workScale\": 0.5 } }";
    rnis::pano::replay::PackPreviewSettings ps;
    ASSERT_TRUE(rnis::pano::replay::readPackPreviewSettings(meta, &ps));
    EXPECT_TRUE(ps.found.empty());
    EXPECT_EQ((int)ps.defaulted.size(), 8) << "all eight fell back, all eight named";
    EXPECT_TRUE(contains(ps.defaulted, "config.pack.previewMaxAlong"));
    EXPECT_TRUE(contains(ps.defaulted, "preview.leadOutEnabled"));
    // …at the compiled iOS defaults, which is what the report then shows.
    EXPECT_EQ(ps.maxAlong, 2000);
    EXPECT_EQ(ps.maxCross, 800);
    EXPECT_NEAR(ps.windowCrossMult, 1.44, 1e-12);
    EXPECT_TRUE(ps.leadOut);
}

TEST(PanoReplayPreview, ATopLevelPreviewKnobDoesNotLeakIntoThePackBlock) {
    // The mirror image of PanoReplayJson.ANestedPackObjectDoesNotLeakIntoThe-
    // TopLevelConfig: a knob at the WRONG nesting level must not be adopted,
    // or a reader would be told the render used a geometry it did not use.
    const std::string meta =
        "{ \"previewMaxAlong\": 4444, \"config\": { \"workScale\": 0.5 } }";
    rnis::pano::replay::PackPreviewSettings ps;
    ASSERT_TRUE(rnis::pano::replay::readPackPreviewSettings(meta, &ps));
    EXPECT_EQ(ps.maxAlong, 2000);
    EXPECT_TRUE(contains(ps.defaulted, "config.pack.previewMaxAlong"));
}

TEST(PanoReplayPreview, ForcedKnobsOverrideThePackAndAreNamedAsForced) {
    ScratchDir s("pvforce");
    const std::string pack = makeSynthPack(s, "pack", SynthPackSpec());
    ReplayOptions o;
    o.packDir = pack;
    o.outDir = s.at("out");
    o.preview.enabled = true;
    o.preview.imageEveryN = 0;
    o.preview.intervalMs = 40.0;        // 400 ms sweep ⇒ many more ticks
    o.preview.leadOut = 0;
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    EXPECT_DOUBLE_EQ(r.previewSettings.intervalMs, 40.0);
    EXPECT_FALSE(r.previewSettings.leadOut);
    EXPECT_TRUE(contains(r.previewSettings.found, "forced:intervalMs"));
    EXPECT_TRUE(contains(r.previewSettings.found, "forced:leadOut"));
    EXPECT_GE(r.previewTicks, 8) << "the forced 40 ms interval did not take";

    const std::vector<std::string> rows =
        splitLines(readText(s.at("out") + "/preview.jsonl"));
    ASSERT_FALSE(rows.empty());
    for (size_t i = 0; i < rows.size(); ++i) {
        EXPECT_FALSE(jsonBool(rows[i], "leadOutRequested")) << "row " << i;
        bool ok = false;
        EXPECT_EQ(jsonNum(rows[i], "leadOutPx", &ok), 0.0) << "row " << i;
    }
}

// ── the real thing, when the operator's packs are on this machine ───────────

TEST(PanoReplayRealPack, ReplaysADevicePackAndPrintsTheDiff) {
    const char* dir = std::getenv("RNIS_TEST_PANO_PACK");
    if (dir == nullptr || *dir == '\0') {
        GTEST_SKIP() << "set RNIS_TEST_PANO_PACK=<pano+ pack dir> to run this "
                        "against a real device pack";
    }
    ScratchDir s("realpack");
    ReplayOptions o;
    o.packDir = dir;
    // RNIS_TEST_PANO_OUT keeps the replayed canvas + ledger after the test —
    // the artefacts an eyes-on comparison against the pack's own canvas.jpg
    // needs, and the ones the Android JNI entry will be asked to produce.
    const char* keep = std::getenv("RNIS_TEST_PANO_OUT");
    o.outDir = (keep != nullptr && *keep != '\0') ? std::string(keep) : s.at("out");
    // RNIS_TEST_PANO_PREVIEW=1 additionally writes the PER-TICK preview
    // geometry (preview.jsonl) and the published preview images, rendered at
    // the geometry THIS pack recorded. Off by default, so the standard run is
    // the run it has always been.
    //   RNIS_TEST_PANO_PREVIEW_EVERY=N   save every Nth tick's image (default 1,
    //                                    0 = geometry only)
    //   RNIS_TEST_PANO_PREVIEW_MAX=N     cap on images written (default 240)
    //   RNIS_TEST_PANO_PREVIEW_MS=X      force the tick interval, ms
    const char* pvOn = std::getenv("RNIS_TEST_PANO_PREVIEW");
    if (pvOn != nullptr && *pvOn != '\0' && std::string(pvOn) != "0") {
        o.preview.enabled = true;
        const char* every = std::getenv("RNIS_TEST_PANO_PREVIEW_EVERY");
        if (every != nullptr && *every != '\0') o.preview.imageEveryN = std::atoi(every);
        const char* cap = std::getenv("RNIS_TEST_PANO_PREVIEW_MAX");
        if (cap != nullptr && *cap != '\0') o.preview.imageMaxCount = std::atoi(cap);
        const char* ms = std::getenv("RNIS_TEST_PANO_PREVIEW_MS");
        if (ms != nullptr && *ms != '\0') o.preview.intervalMs = std::atof(ms);
    }
    ReplayReport r;
    ASSERT_TRUE(rnis::pano::replay::replayPack(o, &r)) << r.error;

    std::printf("\n[real pack] %s\n", r.packDirResolved.c_str());
    std::printf("  rows=%d read=%d ingested=%d malformed=%d missingFrames=%d "
                "unreadable=%d rescaledK=%d grayFix=%d\n",
                r.rowsTotal, r.framesRead, r.framesIngested, r.rowsMalformed,
                r.framesMissing, r.framesUnreadable, r.intrinsicsRescaled,
                r.grayWorkSizeCorrected);
    std::printf("  ms p50=%.3f p95=%.3f max=%.3f total=%.1f  load=%.1f "
                "finish=%.1f finalize=%.1f\n",
                r.msP50, r.msP95, r.msMax, r.totalMs, r.loadMsTotal,
                r.finishMs, r.finalizeMs);
    std::printf("  canvas replay=%dx%d device=%dx%d (cropPad=%d, NOT recorded "
                "in the pack)\n",
                r.canvasW, r.canvasH, r.deviceOutputW, r.deviceOutputH,
                (int)r.canvasCropPadApplied);
    std::printf("  paintedW replay=%d device=%d  holes=%d axis=%d sign=%d "
                "relatch=%d written=%d\n",
                r.stats.paintedW, r.devicePaintedW, r.holes, r.stats.axis,
                r.stats.sweepSign, r.stats.relatchCount, (int)r.canvasWritten);
    std::printf("  %-24s %8s %8s\n", "outcome", "replay", "device");
    for (size_t i = 0; i < r.outcomeCounts.size(); ++i) {
        int dev = -1;
        for (size_t j = 0; j < r.oracleCounts.size(); ++j) {
            if (r.oracleCounts[j].first == r.outcomeCounts[i].first) {
                dev = r.oracleCounts[j].second;
            }
        }
        if (r.outcomeCounts[i].second == 0 && dev <= 0) continue;
        std::printf("  %-24s %8d %8d\n", r.outcomeCounts[i].first.c_str(),
                    r.outcomeCounts[i].second, dev);
    }
    std::printf("  per-seq: agree=%d disagree=%d oracleOnly=%d replayOnly=%d\n",
                r.outcomeAgree, r.outcomeDisagree, r.oracleOnlySeqs,
                r.replayOnlySeqs);
    if (r.firstDivergenceSeq >= 0) {
        std::printf("  first divergence: %s\n", r.firstDivergenceDetail.c_str());
    }
    if (r.previewEnabled) {
        std::printf("  preview: ticks=%d published=%d refused=%d seeded=%d "
                    "images=%d capped=%d failed=%d renderMs=%.1f\n",
                    r.previewTicks, r.previewPublished, r.previewRefused,
                    r.previewSeeded, r.previewImagesWritten,
                    (int)r.previewImagesCapped, r.previewImageWriteFailed,
                    r.previewMsTotal);
        std::printf("  preview geometry: intervalMs=%.1f box=%dx%d(along x cross) "
                    "windowAlongPx=%d crossMult=%.4f cropPad=%d leadOut=%d q=%d\n",
                    r.previewSettings.intervalMs, r.previewSettings.maxAlong,
                    r.previewSettings.maxCross, r.previewSettings.windowAlongPx,
                    r.previewSettings.windowCrossMult,
                    (int)r.previewSettings.cropPad,
                    (int)r.previewSettings.leadOut, r.previewSettings.quality);
        std::printf("  preview knobs defaulted (NOT read from this pack): %d\n",
                    (int)r.previewSettings.defaulted.size());
        for (size_t i = 0; i < r.previewSettings.defaulted.size(); ++i) {
            std::printf("    %s\n", r.previewSettings.defaulted[i].c_str());
        }
        std::printf("  preview.jsonl -> %s\n", r.previewJsonlPath.c_str());
        std::printf("  preview images -> %s\n", r.previewImageDir.c_str());
    }
    std::fflush(stdout);

    // The ONLY assertions here are about the DRIVER, never about agreement:
    // divergence is a finding to report, not a test to fail (the replay eats
    // JPEG frames and a BGR2GRAY luma; the device ate raw NV12 and its Y plane).
    EXPECT_GT(r.framesIngested, 0);
    EXPECT_EQ(r.rowsMalformed, 0) << "the device wrote a track row we cannot read";
    EXPECT_EQ(histSum(r), r.framesIngested + 1);
    EXPECT_TRUE(r.haveOracle) << "pack has no ledger.jsonl to grade against";
}
