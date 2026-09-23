// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_test.cpp — host isolation tests for the pano+ slit-scan engine
// (cpp/rnis_pano.cpp).  No React Native, no ObjC, no ARKit: a synthetic
// fronto-parallel "shelf" is swept past a virtual camera and the engine is
// fed the exact (pixels, attitude, intrinsics) triple the device plugin will
// hand it.
//
// What these PIN (the invariants that reasoning at the keyboard gets wrong):
//
//   * the phase-correlation SIGN and the resulting paint direction — a sweep
//     reconstructs the ground-truth scene in the right order, not mirrored;
//   * the SWEEP-DIRECTION INVARIANCE the design demanded be pinned by a
//     test: right-to-left produces the same panorama as left-to-right;
//   * ZERO interior holes (G1) over the swept extent;
//   * HIGH-WATER — a backtrack paints nothing and cannot duplicate content;
//   * the ALIASING CAGE rejects a jump instead of widening its search, and
//     does NOT advance the chain when it does;
//   * ATTITUDE RECTIFICATION actually removes a roll the image-only arm
//     cannot see — the miniature of the whole pano+ hypothesis;
//   * every ingested frame yields exactly one ledger row.
//
// These are HOST sanity tests against a host OpenCV, not byte-parity
// evidence against the device's vendored 4.10 build.  A device pack
// (ledger + canvas) is what answers the residual gate.

#include <gtest/gtest.h>

#include <fstream>
#include <sstream>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/core/utility.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <chrono>
#include <cmath>
#include <functional>
#include <ios>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

#include <sys/stat.h>
#include <unistd.h>

#include "rnis_pano.hpp"

namespace {

// NO cv::setNumThreads(1) HERE, and that is a retracted change rather than an
// omission.  A full-suite PanoDeterminism failure on 2026-08-23 was first read
// as OpenCV's load-dependent thread split, and pinning one thread was added to
// remove the machine from the gate.  It was then measured: the failure is
// DECLARATION-ORDER dependent and exactly reproducible — the identical value
// 0.10765694081783295 appears with the pin and without it — while the same
// binary passes in shuffled order and in isolation.  So the pin fixed nothing,
// and it cost the suite 175 s -> ~480 s.  Retracted.  The real finding is in
// PanoDeterminism itself.

constexpr int kFrameW = 1440;
constexpr int kFrameH = 1080;
constexpr double kFx = 1400.0, kFy = 1400.0;
constexpr double kCx = 720.0, kCy = 540.0;

/// A wide, richly textured synthetic shelf run.  Deterministic; enough
/// high-frequency structure that phase correlation is well-conditioned and a
/// mirrored / duplicated reconstruction cannot score well by accident.
cv::Mat makeShelf(int width, int height) {
    cv::Mat img(height, width, CV_8UC3);
    cv::RNG rng(20260819);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            img.at<cv::Vec3b>(y, x) = cv::Vec3b(
                (uchar)(60 + ((x * 7) % 120)),
                (uchar)(40 + ((y * 11) % 150)),
                (uchar)(80 + (((x + y) * 5) % 120)));
        }
    }
    // Shelf rails.
    for (int y = 180; y < height; y += 260) {
        cv::rectangle(img, cv::Rect(0, y, width, 14), cv::Scalar(230, 230, 230),
                      cv::FILLED);
    }
    // "Facings" — distinct blobs so a one-pitch alias would be visible.
    for (int x = 40; x < width - 40; x += 95) {
        for (int y = 60; y < height - 60; y += 260) {
            const cv::Scalar c(rng.uniform(0, 256), rng.uniform(0, 256),
                               rng.uniform(0, 256));
            cv::rectangle(img, cv::Rect(x, y, 70, 190), c, cv::FILLED);
            cv::circle(img, cv::Point(x + 35, y + 60), 22,
                       cv::Scalar(255, 255, 255), cv::FILLED);
            cv::putText(img, std::to_string((x / 95) % 97),
                        cv::Point(x + 8, y + 150), cv::FONT_HERSHEY_SIMPLEX, 1.1,
                        cv::Scalar(20, 20, 20), 3);
        }
    }
    cv::GaussianBlur(img, img, cv::Size(0, 0), 0.7);
    return img;
}

/// A shelf whose LOW-GRADIENT pixels all live in one narrow horizontal band.
///
/// The base pattern's own gray slope is ~9.7 DN/px, above the 8 DN/px
/// admission bound, so the only pixels the photometric seam can sample are the
/// flat blobs — and here they occupy a single band of rows.  That is the state
/// in which uniformity across the boundary's extent is genuinely UNMEASURABLE,
/// and it exists on real content too (a boundary whose only flat pixels are
/// one shelf's worth of packaging).
cv::Mat makeThinFlatShelf(int width, int height) {
    cv::Mat img(height, width, CV_8UC3);
    cv::RNG rng(20260821);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            img.at<cv::Vec3b>(y, x) = cv::Vec3b(
                (uchar)(60 + ((x * 7) % 120)),
                (uchar)(40 + ((y * 11) % 150)),
                (uchar)(80 + (((x + y) * 5) % 120)));
        }
    }
    const int bandY = height / 2 - 30;
    for (int x = 20; x < width - 20; x += 95) {
        const cv::Scalar c(rng.uniform(0, 256), rng.uniform(0, 256),
                           rng.uniform(0, 256));
        cv::rectangle(img, cv::Rect(x, bandY, 74, 60), c, cv::FILLED);
    }
    cv::GaussianBlur(img, img, cv::Size(0, 0), 0.7);
    return img;
}

using Quat = std::array<double, 4>;

/// Quaternion [x,y,z,w] for a rotation of `deg` about the camera's Z axis
/// (GL convention — the optical axis is −Z, so this is a camera ROLL).
void rollQuat(double deg, double q[4]) {
    const double h = deg * CV_PI / 360.0;
    q[0] = 0; q[1] = 0; q[2] = std::sin(h); q[3] = std::cos(h);
}

/// Camera YAW — about the GL +Y (up) axis.  THE dof the offline RCA blamed
/// for the residual wobble, and the one roll never exercises: unlike a roll,
/// a yaw makes H_rect genuinely PROJECTIVE (bottom row ≠ [0,0,1]).
Quat yawQuat(double deg) {
    const double h = deg * CV_PI / 360.0;
    return Quat{0.0, std::sin(h), 0.0, std::cos(h)};
}

/// Camera PITCH — about the GL +X axis.  Also projective, and the dof that
/// walks content out of the canvas band (the vertical-clip case).
Quat pitchQuat(double deg) {
    const double h = deg * CV_PI / 360.0;
    return Quat{std::sin(h), 0.0, 0.0, std::cos(h)};
}

Quat identityQuat() { return Quat{0.0, 0.0, 0.0, 1.0}; }

/// The rectification homography the engine will compute for `q` against an
/// identity reference — used to SYNTHESISE a frame that carries that
/// attitude, so the test and the engine cannot silently agree on a wrong
/// convention (the synthesis is the inverse of the engine's own formula).
cv::Matx33d rectifyH(const double q[4]) {
    const double x = q[0], y = q[1], z = q[2], w = q[3];
    const cv::Matx33d R(
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w),
        2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y));
    const cv::Matx33d F(1, 0, 0, 0, -1, 0, 0, 0, -1);
    const cv::Matx33d K(kFx, 0, kCx, 0, kFy, kCy, 0, 0, 1);
    const cv::Matx33d Kinv(1 / kFx, 0, -kCx / kFx, 0, 1 / kFy, -kCy / kFy, 0, 0, 1);
    return K * (F * R * F) * Kinv;
}

struct SweepResult {
    std::vector<rnis::pano::FrameOutcome> rows;
    rnis::pano::SessionStats stats;
    cv::Mat canvas;
    /// The coverage mask for `canvas` — CV_8UC1, 255 where a frame committed
    /// a pixel. Byte-aligned with it by construction; the PanoCoverage block
    /// is what holds that claim.
    cv::Mat coverage;
    std::vector<std::pair<int, int>> holes;
    std::vector<std::pair<int, int>> envelope;
};

/// Every number the PHOTOMETRIC clauses of `integrityFailed` read, as one
/// string.  A gate assertion whose failure message is only "expected false"
/// tells the next reader which bar fired and NOTHING about how far past it the
/// session was, which is exactly the state this suite exists to remove — the
/// v6 clauses were added because a pack came back "clean" with a visible band
/// in it, and a test that fails without its numbers reproduces that silence in
/// the other direction.
/// GEOMETRY + PHOTOMETRY IN ONE LINE, attached to the gate assertions.
///
/// Added 2026-08-23 because a failure of PanoGate.TheDivergenceBarIsNormalised…
/// at -O2 printed only the number that breached, and the number that breached
/// was not the interesting one: painted / seen / rejected were IDENTICAL to the
/// passing build (143 of 150 and 613 of 620, zero rejections), while the
/// photometric block was a different sweep entirely.  A gate that fails without
/// saying which half of the engine moved costs an afternoon.
///
/// It earned itself the same day: that split — geometry untouched, photometry
/// blown — is what showed the ENGINE was not the variable, and pointed the
/// search upstream to the fixture's uninitialised noise buffer.  Keep both
/// halves in the message.
std::string sweepSummary(const rnis::pano::SessionStats& st);

std::string photoSummary(const rnis::pano::SessionStats& st) {
    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(3);
    o << "photo{ stepP95=" << st.seamPhotoStepP95DN
      << " stepMax=" << st.seamPhotoStepMaxDN
      << " DN over " << st.seamPhotoSamples << " boundaries"
      << " · driftLocal=" << st.seamPhotoDriftLocalPct
      << "% driftTotal=" << st.seamPhotoDriftTotalPct
      << "% · appliedBand=" << st.photoLocalP2PPct
      << "% appliedRange=" << st.photoScaleRangePct
      << "% · gainCumEnd=" << st.gainCumEnd
      << " · nonUniform=" << st.seamPhotoNonUniform
      << " unknownUniform=" << st.seamPhotoUniformUnknown
      << " }";
    return o.str();
}

std::string sweepSummary(const rnis::pano::SessionStats& st) {
    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(4);
    o << "seen=" << st.seen << " painted=" << st.painted
      << " rejLow=" << st.rejectedLowResponse
      << " rejCage=" << st.rejectedOutOfCage
      << " bnd=" << st.seamBoundaries
      << " divNorm=" << st.crossBandDivergenceNormPx
      << " divRaw=" << st.crossBandDivergencePx
      << " jogP95=" << st.seamCanvasJogP95Px
      << "  " << photoSummary(st);
    return o.str();
}

/// One synthetic sweep, fully specified.  `xs`/`ys` are the ground-truth crop
/// origins in shelf px; `qs` the per-frame camera attitude; `tracking` the
/// per-frame ARKit tracking code (0/1/2).  Empty optional vectors mean
/// "zero / identity / normal".
struct SweepSpec {
    std::vector<double> xs;
    std::vector<double> ys;
    std::vector<Quat>   qs;
    std::vector<int>    tracking;
    // ── v6 PHOTOMETRY ──────────────────────────────────────────────────
    /// Per-frame LINEAR-LIGHT gain applied to the crop before it is handed to
    /// the engine — i.e. what a camera whose exposure changed would actually
    /// deliver.  Empty ⇒ no photometric change at all.
    std::vector<double> gains;
    /// A LEFT-TO-RIGHT gain ramp inside each frame (1.0 ⇒ flat).  This is the
    /// real mechanism behind the chained estimator's drift: the gain is fitted
    /// on the overlap sample window and applied to the strip, so a gradient
    /// FIXED IN THE FRAME and moving through the world makes the two disagree
    /// — exactly what lens shading does.
    double shadingSpan = 1.0;
    /// A TOP-TO-BOTTOM gain ramp, alternating sign per frame.  Produces a
    /// large but RAGGED row-to-row difference at every boundary, which the
    /// photometric metric must DECLINE rather than report as a DC step.
    double rowShadingSpan = 1.0;
    /// Per-frame exposure metadata handed to the engine.  Empty ⇒ none, which
    /// is every pack captured before v6.
    std::vector<double> expDur;
    std::vector<double> expISO;
    /// v11 — ARKit'S OWN per-frame exposure, the non-circular half.  Empty ⇒
    /// unreadable on this path, which the engine must record as UNKNOWN and
    /// never as a zero exposure.  `arExpHave` is carried separately because
    /// `exposureOffset` is an EV OFFSET whose 0.0 is a legal reading.
    std::vector<double> arExpDur;
    std::vector<double> arExpEV;
    std::vector<char>   arExpHave;
};

/// sRGB transfer, used by the test to synthesise a camera whose EXPOSURE
/// changed (exposure is linear in radiance; the raster is gamma-encoded).
///
/// SCOPE, stated the same way `rectifyH` states its own: this makes the test
/// self-consistent with the engine's transfer, so it proves the engine
/// INVERTS the model the test applied.  That the model matches a real iPhone
/// raster is what the device pack answers, not this file.
double srgbDecodeT(double e) {
    return (e <= 0.04045) ? (e / 12.92) : std::pow((e + 0.055) / 1.055, 2.4);
}
double srgbEncodeT(double l) {
    if (l <= 0.0) return 0.0;
    return (l <= 0.0031308) ? (12.92 * l)
                            : (1.055 * std::pow(l, 1.0 / 2.4) - 0.055);
}
/// Multiply RADIANCE by `g` (optionally with a left-to-right span `spanX` and
/// a top-to-bottom span `spanY`, each expressed as max/min across the frame).
///
/// The gradient is applied as 48 BLOCK LUTs rather than per pixel — 48
/// `cv::LUT` calls on sub-ROIs instead of 1.5 M scalar sRGB round-trips per
/// frame, which is the difference between a test that runs in seconds and one
/// that runs in minutes.  48 levels puts the step between adjacent blocks
/// around 1%, well under anything the registration can see.
cv::Mat linearGainT(const cv::Mat& src, double g, double spanX = 1.0,
                    double spanY = 1.0) {
    if (std::fabs(g - 1.0) < 1e-12 && std::fabs(spanX - 1.0) < 1e-12 &&
        std::fabs(spanY - 1.0) < 1e-12) {
        return src;
    }
    auto lutFor = [](double gg) {
        cv::Mat lut(1, 256, CV_8UC1);
        for (int v = 0; v < 256; ++v) {
            lut.at<uchar>(0, v) = cv::saturate_cast<uchar>(
                cvRound(srgbEncodeT(srgbDecodeT((double)v / 255.0) * gg) * 255.0));
        }
        return lut;
    };
    cv::Mat out(src.size(), src.type());
    const bool alongX = std::fabs(spanX - 1.0) > 1e-12;
    const bool alongY = std::fabs(spanY - 1.0) > 1e-12;
    if (!alongX && !alongY) {
        cv::LUT(src, lutFor(g), out);
        return out;
    }
    const double span = alongX ? spanX : spanY;
    const double lo = g / std::sqrt(span), hi = g * std::sqrt(span);
    const int kBlocks = 48;
    const int extent = alongX ? src.cols : src.rows;
    for (int k = 0; k < kBlocks; ++k) {
        const int a = (int)((int64_t)extent * k / kBlocks);
        const int b = (int)((int64_t)extent * (k + 1) / kBlocks);
        if (b <= a) continue;
        const double f = (kBlocks > 1) ? ((double)k / (double)(kBlocks - 1)) : 0.0;
        const cv::Mat lut = lutFor(lo + (hi - lo) * f);
        const cv::Rect roi = alongX ? cv::Rect(a, 0, b - a, src.rows)
                                    : cv::Rect(0, a, src.cols, b - a);
        cv::LUT(src(roi), lut, out(roi));
    }
    return out;
}

/// Mean absolute per-pixel difference between two canvases over the region
/// both of them cover.  The scene-controlled photometric instrument: comparing
/// an arm against a FLAT-CAMERA control removes the scene's own brightness
/// structure entirely, which a bare column-luma range cannot do.
/// `canvasMeanAbsDiff` after removing an INTEGER canvas offset of up to +/-3 px.
///
/// The 2026-08-24 precision round needed this, for a reason worth recording:
/// the exposure
/// test compares three arms fed DIFFERENT PIXELS, so their registration chains
/// are free to disagree by a pixel, and a photometric claim measured through a
/// 1 px misregistration is measuring geometry.  At work scale 0.5 the arms
/// happened to land on the same integer column; at 0.75 they do not.  The
/// search is symmetric — every arm gets its own best alignment — so it cannot
/// favour one.
[[maybe_unused]] double canvasMeanAbsDiffAligned(const cv::Mat& a, const cv::Mat& b,
                                                  int r = 3);

double canvasMeanAbsDiff(const cv::Mat& a, const cv::Mat& b) {
    if (a.empty() || b.empty()) return 1e9;
    const int w = std::min(a.cols, b.cols), h = std::min(a.rows, b.rows);
    if (w < 8 || h < 8) return 1e9;
    cv::Mat ga, gb;
    cv::cvtColor(a(cv::Rect(0, 0, w, h)), ga, cv::COLOR_BGR2GRAY);
    cv::cvtColor(b(cv::Rect(0, 0, w, h)), gb, cv::COLOR_BGR2GRAY);
    cv::Mat both = (ga > 0) & (gb > 0);
    const int n = cv::countNonZero(both);
    if (n < 1000) return 1e9;
    cv::Mat d;
    cv::absdiff(ga, gb, d);
    return cv::mean(d, both)[0];
}

/// The PHOTOMETRIC difference between two canvases: per-column mean luma over
/// the commonly-painted rows, compared column by column.
///
/// This is needed only off the shipped work scale, and the reason is measured
/// rather than
/// assumed.  The exposure fixture runs three arms fed DIFFERENT PIXELS (that is
/// its point — one carries a 1.6x camera ramp), so their registration chains
/// are not obliged to agree.  At work scale 0.5 they agreed to well under a
/// pixel and a per-PIXEL comparison read the photometry directly (0.69 vs 1.01
/// DN).  At 0.75 the estimator is fine enough to respond to the ramp's own
/// 8-bit quantisation, the chains diverge SUB-PIXEL — same painted count, same
/// painted width, same end gain — and the per-pixel comparison picks up a ~1.7
/// DN texture floor that has nothing to do with exposure and that no integer
/// realignment can remove (verified: the best integer shift is 0,0).
///
/// A per-column MEAN is insensitive to a sub-pixel offset and is exactly the
/// quantity the claim is about: how bright the panorama is, along the sweep.
double canvasColumnMeanAbsDiff(const cv::Mat& a, const cv::Mat& b) {
    if (a.empty() || b.empty()) return 1e9;
    const int w = std::min(a.cols, b.cols), h = std::min(a.rows, b.rows);
    if (w < 64 || h < 64) return 1e9;
    cv::Mat ga, gb;
    cv::cvtColor(a(cv::Rect(0, 0, w, h)), ga, cv::COLOR_BGR2GRAY);
    cv::cvtColor(b(cv::Rect(0, 0, w, h)), gb, cv::COLOR_BGR2GRAY);
    double acc = 0.0;
    int n = 0;
    // Trim the first and last 8 columns: those are the two arms' OUTERMOST
    // strips, the only place a 1 px difference in painted width can put a
    // half-painted column against a full one.
    for (int x = 8; x < w - 8; ++x) {
        double sa = 0.0, sb = 0.0;
        int m = 0;
        for (int y = 0; y < h; ++y) {
            const uchar va = ga.at<uchar>(y, x), vb = gb.at<uchar>(y, x);
            if (va == 0 || vb == 0) continue;
            sa += va; sb += vb; ++m;
        }
        if (m < 32) continue;
        acc += std::fabs(sa / m - sb / m);
        ++n;
    }
    return (n < 64) ? 1e9 : acc / n;
}

[[maybe_unused]] double canvasMeanAbsDiffAligned(const cv::Mat& a, const cv::Mat& b,
                                                  int r) {
    if (a.empty() || b.empty()) return 1e9;
    double best = 1e9;
    for (int dy = -r; dy <= r; ++dy) {
        for (int dx = -r; dx <= r; ++dx) {
            const int x0 = std::max(0, dx), y0 = std::max(0, dy);
            const int x1 = std::max(0, -dx), y1 = std::max(0, -dy);
            const int w = std::min(a.cols - x0, b.cols - x1);
            const int h = std::min(a.rows - y0, b.rows - y1);
            if (w < 64 || h < 64) continue;
            best = std::min(best,
                            canvasMeanAbsDiff(a(cv::Rect(x0, y0, w, h)),
                                              b(cv::Rect(x1, y1, w, h))));
        }
    }
    return best;
}

/// Range of per-column mean luma over the painted canvas, as a percentage —
/// the OPERATOR-FACING band: what his eye integrates walking along the
/// panorama.  Measured on the finished canvas, with none of the engine's own
/// arithmetic in it.
[[maybe_unused]] double canvasColumnLumaRangePct(const cv::Mat& canvas, int axis) {
    if (canvas.empty()) return 0.0;
    cv::Mat g;
    cv::cvtColor(canvas, g, cv::COLOR_BGR2GRAY);
    if (axis != 0) cv::transpose(g, g);
    double lo = 1e18, hi = -1e18;
    for (int x = 0; x < g.cols; ++x) {
        cv::Mat col = g.col(x);
        cv::Mat nz = (col > 0);
        if (cv::countNonZero(nz) < g.rows / 4) continue;
        const double m = cv::mean(col, nz)[0];
        if (m < 4.0) continue;
        lo = std::min(lo, m);
        hi = std::max(hi, m);
    }
    if (lo > hi) return 0.0;
    return (hi / lo - 1.0) * 100.0;
}

SweepResult runSweepSpec(const cv::Mat& shelf, const SweepSpec& spec,
                         const rnis::pano::Config& cfg) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;

    SweepResult out;
    for (size_t i = 0; i < spec.xs.size(); ++i) {
        const int x0 = (int)std::lround(spec.xs[i]);
        const int y0 = (int)std::lround(spec.ys.empty() ? 0.0 : spec.ys[i]);
        cv::Mat crop = shelf(cv::Rect(x0, y0, kFrameW, kFrameH)).clone();

        Quat q = spec.qs.empty() ? identityQuat() : spec.qs[i];
        const bool rotated = std::fabs(q[0]) + std::fabs(q[1]) + std::fabs(q[2]) > 1e-12;
        if (rotated) {
            // Synthesise a frame that genuinely CARRIES that attitude, by
            // warping through the INVERSE of the rectification the engine
            // will compute.  (Scope, stated plainly: this makes the test
            // self-consistent with the engine's own convention — it proves
            // the engine inverts its model, not that the model matches
            // ARKit.  The device pack is the only evidence for that.)
            cv::Mat rot;
            cv::warpPerspective(crop, rot, cv::Mat(rectifyH(q.data()).inv()),
                                crop.size(), cv::INTER_LINEAR,
                                cv::BORDER_REPLICATE);
            crop = rot;
        }

        // v6 — synthesise the camera's photometry BEFORE anything else reads
        // the frame, so `grayWork` (and therefore the registration) sees
        // exactly what the engine will paint, as it does on the device.
        const double frameGain = spec.gains.empty() ? 1.0 : spec.gains[i];
        const double rowSpan = (spec.rowShadingSpan != 1.0)
            ? ((i % 2 == 0) ? spec.rowShadingSpan : 1.0 / spec.rowShadingSpan)
            : 1.0;
        if (frameGain != 1.0 || spec.shadingSpan != 1.0 || rowSpan != 1.0) {
            crop = linearGainT(crop, frameGain, spec.shadingSpan, rowSpan);
        }

        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);

        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        for (int k = 0; k < 4; ++k) in.q[k] = q[k];
        // A translating camera 0.6 m from the plane: 1400 px focal and a
        // 1 px crop step ⇒ 0.6/1400 m of translation per px.
        in.t[0] = spec.xs[i] * (0.6 / kFx);
        in.t[1] = (spec.ys.empty() ? 0.0 : spec.ys[i]) * (0.6 / kFy);
        in.tracking = spec.tracking.empty() ? 2 : spec.tracking[i];
        in.seq = (int64_t)i;
        if (!spec.expDur.empty()) in.exposureDurationS = spec.expDur[i];
        if (!spec.expISO.empty()) in.exposureISO = spec.expISO[i];
        if (!spec.arExpDur.empty()) {
            in.arExposureDurationS = spec.arExpDur[i];
            in.arExposureOffsetEV = spec.arExpEV.empty() ? 0.0 : spec.arExpEV[i];
            in.arExposureValid =
                spec.arExpHave.empty() ? true : (spec.arExpHave[i] != 0);
        }
        out.rows.push_back(eng.ingest(in));
    }
    out.rows.push_back(eng.finish());
    eng.finalCanvas(out.canvas);
    // Rendered with the SAME `cropPadRows` as the canvas one line up — which
    // is the only argument that can separate the two, and the reason
    // `finalCoverage` takes it at all. See the PanoCoverage block.
    eng.finalCoverage(out.coverage);
    out.stats = eng.stats();
    out.holes = eng.unpaintedRuns();
    out.envelope = eng.verticalEnvelope();
    return out;
}

/// Drive a full sweep: `xs` are the ground-truth crop origins (px), `rolls`
/// the per-frame camera roll in degrees (same length).
SweepResult runSweep(const cv::Mat& shelf, const std::vector<double>& xs,
                     const std::vector<double>& rolls,
                     const rnis::pano::Config& cfg,
                     int trackingFrom = 0) {
    SweepSpec spec;
    spec.xs = xs;
    if (!rolls.empty()) {
        spec.qs.reserve(rolls.size());
        for (double r : rolls) {
            Quat q = identityQuat();
            rollQuat(r, q.data());
            spec.qs.push_back(q);
        }
    }
    if (trackingFrom > 0) {
        spec.tracking.assign(xs.size(), 2);
        for (int i = 0; i < trackingFrom && i < (int)xs.size(); ++i)
            spec.tracking[i] = 1;
    }
    return runSweepSpec(shelf, spec, cfg);
}

/// Wall clock for the two timing assertions in this suite.
double nowMsForTest() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(
               clock::now().time_since_epoch()).count();
}

std::vector<double> linearSweep(double from, double step, int n) {
    std::vector<double> xs;
    xs.reserve(n);
    for (int i = 0; i < n; ++i) xs.push_back(from + step * i);
    return xs;
}

/// Best normalised cross-correlation of `patch` anywhere in `scene`, plus the
/// location it was found at.  Grayscale, TM_CCOEFF_NORMED.
double bestNcc(const cv::Mat& patch, const cv::Mat& scene, cv::Point* at = nullptr) {
    if (patch.empty() || scene.empty()) return -2.0;
    if (patch.cols > scene.cols || patch.rows > scene.rows) return -2.0;
    cv::Mat p, s, r;
    cv::cvtColor(patch, p, cv::COLOR_BGR2GRAY);
    cv::cvtColor(scene, s, cv::COLOR_BGR2GRAY);
    cv::matchTemplate(s, p, r, cv::TM_CCOEFF_NORMED);
    double mn = 0, mx = 0;
    cv::Point mnl, mxl;
    cv::minMaxLoc(r, &mn, &mx, &mnl, &mxl);
    if (at) *at = mxl;
    return mx;
}

rnis::pano::Config testConfig() {
    rnis::pano::Config c;
    c.trackingWarmupFrames = 2;
    c.axisLatchFrames = 3;
    c.canvasInitWidthPx = 2048;
    if (const char* w = std::getenv("RNIS_TEST_WORKSCALE")) c.workScale = atof(w);
    return c;
}

int countOutcome(const SweepResult& r, rnis::pano::Outcome o) {
    int n = 0;
    for (const auto& row : r.rows) if (row.outcome == o) ++n;
    return n;
}

}  // namespace

// ── Configuration ───────────────────────────────────────────────────────────

// THE SHIPPED CORRELATION WINDOW, PINNED WITH ITS REASON (2026-09-07).
// 384 stopped whole sweeps dead on the operator's phone — `chain-lost`, zero
// strips, 71-77 consecutive low-response rejections — while 768 turned the
// SAME pack's frames into a 243-strip panorama at response 0.89.  A future
// reader who wants this number back at 384 has to answer those packs
// (scratchpad/pull3, 19:04:37 and 19:05:20) first.  The knob stays reachable:
// the second half of this test is what makes the A/B possible.
TEST(PanoConfig, TheShippedCorrelationWindowIs768AndIsStillOverridable) {
    rnis::pano::Config c;
    EXPECT_EQ(c.phaseWindowPx, 768);
    // Still a knob: an explicit value wins, and the validator's floor holds.
    c.phaseWindowPx = 384;
    rnis::pano::Engine e;
    EXPECT_TRUE(e.configure(c, nullptr));
    c.phaseWindowPx = 16;
    EXPECT_FALSE(e.configure(c, nullptr));
}

TEST(PanoConfig, RejectsDegenerateValues) {
    rnis::pano::Engine eng;
    std::string err;
    rnis::pano::Config c;
    c.canvasScale = 0.0;
    EXPECT_FALSE(eng.configure(c, &err));
    EXPECT_FALSE(err.empty());

    c = rnis::pano::Config();
    c.stripMargin = 0.5;
    EXPECT_FALSE(eng.configure(c, &err));

    c = rnis::pano::Config();
    c.canvasMaxWidthPx = 512;
    c.canvasInitWidthPx = 2048;
    EXPECT_FALSE(eng.configure(c, &err));

    EXPECT_TRUE(eng.configure(rnis::pano::Config(), &err)) << err;
}

TEST(PanoConfig, IngestBeforeConfigureIsRejectedNotCrash) {
    rnis::pano::Engine eng;
    cv::Mat bgr(kFrameH, kFrameW, CV_8UC3, cv::Scalar(1, 2, 3));
    cv::Mat gray(kFrameH / 2, kFrameW / 2, CV_8UC1, cv::Scalar(7));
    rnis::pano::FrameInput in;
    in.bgr = &bgr; in.grayWork = &gray;
    in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
    in.imageWidth = kFrameW; in.imageHeight = kFrameH;
    in.tracking = 2; in.tsNs = 1e9;
    EXPECT_EQ(eng.ingest(in).outcome, rnis::pano::Outcome::RejectedInput);
}

TEST(PanoConfig, MalformedFrameIsLedgeredNotFatal) {
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;
    rnis::pano::FrameInput in;   // null pixel pointers
    in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
    in.imageWidth = kFrameW; in.imageHeight = kFrameH;
    in.tracking = 2; in.tsNs = 1e9;
    EXPECT_EQ(eng.ingest(in).outcome, rnis::pano::Outcome::RejectedInput);
    EXPECT_EQ(eng.stats().seen, 0);   // never counted as a real frame
}

// ── Warm-up gating ──────────────────────────────────────────────────────────

TEST(PanoWarmup, HoldsUntilTrackingIsNormal) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    auto cfg = testConfig();
    // Frames 0..9 report "limited"; the reference must not latch before that.
    SweepResult r = runSweep(shelf, linearSweep(100, 20, 40), {}, cfg,
                             /*trackingFrom=*/10);
    ASSERT_TRUE(r.stats.referenceLatched);
    // Nothing painted while tracking was limited.
    for (int i = 0; i < 10; ++i)
        EXPECT_EQ(r.rows[i].outcome, rnis::pano::Outcome::WarmingUp) << "frame " << i;
}

// ── The core sweep ──────────────────────────────────────────────────────────

TEST(PanoSweep, ReconstructsTheSceneInOrderWithNoHoles) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    auto cfg = testConfig();
    const auto xs = linearSweep(200, 20, 220);   // 20 px/frame, ~4.4 m of shelf
    SweepResult r = runSweep(shelf, xs, {}, cfg);

    ASSERT_TRUE(r.stats.axisLatched);
    EXPECT_EQ(r.stats.axis, 0);
    EXPECT_EQ(r.stats.sweepSign, 1);
    EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;
    EXPECT_GT(r.stats.painted, 150);
    ASSERT_FALSE(r.canvas.empty());

    // G1 — zero interior holes over the swept extent.
    EXPECT_TRUE(r.holes.empty()) << "first hole at " << r.holes[0].first;

    // Painted extent ≈ the swept extent (220 frames × 20 px) + one frame of
    // lead-in/lead-out, all at canvasScale.
    const double sweptSrc = xs.back() - xs.front() + kFrameW;
    EXPECT_NEAR(r.canvas.cols, sweptSrc * cfg.canvasScale,
                sweptSrc * cfg.canvasScale * 0.12);

    // The reconstruction matches the ground truth, IN ORDER: a patch taken
    // from 3/4 along the canvas must be found 3/4 along the shelf.
    cv::Mat gt;
    cv::resize(shelf, gt, cv::Size(), cfg.canvasScale, cfg.canvasScale,
               cv::INTER_AREA);
    const int px = (int)(r.canvas.cols * 0.72);
    const cv::Rect patchRect(px, r.canvas.rows / 2 - 90, 260, 180);
    cv::Point at;
    const double ncc = bestNcc(r.canvas(patchRect), gt, &at);
    EXPECT_GT(ncc, 0.90) << "reconstruction does not match the ground truth";
    const double expectedX = (xs.front() * cfg.canvasScale) + px;
    EXPECT_NEAR(at.x, expectedX, 60.0)
        << "patch found at the wrong place — order/direction is wrong";
}

TEST(PanoSweep, EveryIngestedFrameProducesExactlyOneLedgerRow) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    const auto xs = linearSweep(150, 18, 90);
    SweepResult r = runSweep(shelf, xs, {}, testConfig());
    ASSERT_EQ(r.rows.size(), xs.size() + 1);   // + the finalize tail row
    const auto& s = r.stats;
    const int64_t accounted = s.painted + s.heldBacktrack + s.heldFrontier +
                              s.skippedNoAdvance + s.rejectedLowResponse +
                              s.rejectedOutOfCage + s.rejectedPoseSpeed +
                              s.rejectedRectify + s.warmingUp + s.bootstrap;
    EXPECT_EQ(accounted, s.seen) << "a frame vanished from the ledger";
    EXPECT_EQ(r.rows.back().outcome, rnis::pano::Outcome::TailFlush);
}

// ── Sweep-direction invariance (the design demanded a test, not reasoning)

TEST(PanoSweep, RightToLeftMatchesLeftToRight) {
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    auto cfg = testConfig();
    const auto fwd = linearSweep(300, 20, 150);
    std::vector<double> rev(fwd.rbegin(), fwd.rend());

    SweepResult a = runSweep(shelf, fwd, {}, cfg);
    SweepResult b = runSweep(shelf, rev, {}, cfg);

    ASSERT_FALSE(a.canvas.empty());
    ASSERT_FALSE(b.canvas.empty());
    EXPECT_EQ(a.stats.sweepSign, 1);
    EXPECT_EQ(b.stats.sweepSign, -1);
    EXPECT_EQ(b.stats.axis, 0);
    EXPECT_TRUE(b.holes.empty());

    // Both canvases must read in the SAME (scene) order.
    const cv::Rect patchRect(b.canvas.cols / 2 - 130, b.canvas.rows / 2 - 90,
                             260, 180);
    cv::Point at;
    const double ncc = bestNcc(b.canvas(patchRect), a.canvas, &at);
    EXPECT_GT(ncc, 0.85) << "reverse sweep did not reproduce the forward canvas";
    // Mirrored output would land the mid patch far from the middle.
    EXPECT_NEAR(at.x + 130.0, a.canvas.cols / 2.0, a.canvas.cols * 0.12);
}

// ── High-water / backtrack ──────────────────────────────────────────────────

TEST(PanoHighWater, BacktrackPaintsNothingAndCannotDuplicate) {
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    auto cfg = testConfig();

    // Forward 100 frames, back 40, forward again past the old frontier.
    std::vector<double> xs = linearSweep(300, 20, 100);
    for (int i = 1; i <= 40; ++i) xs.push_back(xs.back() - 20);
    for (int i = 1; i <= 120; ++i) xs.push_back(xs.back() + 20);

    SweepResult r = runSweep(shelf, xs, {}, cfg);
    ASSERT_FALSE(r.canvas.empty());
    EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;

    // The backtrack must be HELD, not painted.
    EXPECT_GE(countOutcome(r, rnis::pano::Outcome::HeldBacktrack) +
                  countOutcome(r, rnis::pano::Outcome::HeldFrontier),
              35);
    EXPECT_GE(countOutcome(r, rnis::pano::Outcome::HeldBacktrack), 30);
    EXPECT_TRUE(r.holes.empty());

    // Extent is the swept EXTENT, not the swept path length: a duplicating
    // engine would produce ~40 frames' worth of extra canvas.
    const double extentSrc =
        *std::max_element(xs.begin(), xs.end()) -
        *std::min_element(xs.begin(), xs.end()) + kFrameW;
    EXPECT_NEAR(r.canvas.cols, extentSrc * cfg.canvasScale,
                extentSrc * cfg.canvasScale * 0.12);

    // And the content is still in scene order (no repeated band).
    cv::Mat gt;
    cv::resize(shelf, gt, cv::Size(), cfg.canvasScale, cfg.canvasScale,
               cv::INTER_AREA);
    const int px = (int)(r.canvas.cols * 0.6);
    cv::Point at;
    EXPECT_GT(bestNcc(r.canvas(cv::Rect(px, r.canvas.rows / 2 - 80, 240, 160)),
                      gt, &at),
              0.90);
    EXPECT_NEAR(at.x, xs.front() * cfg.canvasScale + px, 70.0);
}

// ── The aliasing cage ───────────────────────────────────────────────────────

TEST(PanoCage, PoseSpeedGateRejectsALurchThatWouldWrapTheWindow) {
    const cv::Mat shelf = makeShelf(8000, kFrameH);
    auto cfg = testConfig();
    cfg.cageStallFrames = 3;

    std::vector<double> xs = linearSweep(300, 20, 60);
    xs.push_back(xs.back() + 300);     // 300 src px in one 30 fps frame:
                                       // 3.9 m/s — physically a lurch, and far
                                       // beyond what the window can measure.
    for (int i = 1; i <= 5; ++i) xs.push_back(xs.back() + 20);

    SweepResult r = runSweep(shelf, xs, {}, cfg);
    EXPECT_GE(countOutcome(r, rnis::pano::Outcome::RejectedPoseSpeed), 1)
        << "the pose-side cage let a 3.9 m/s lurch through";
    EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;
    // The engine must NOT have silently widened its search and painted the
    // jump: the canvas cannot span the jumped-over region.
    ASSERT_FALSE(r.canvas.empty());
    const double preJumpExtent = (xs[59] - xs[0] + kFrameW) * cfg.canvasScale;
    EXPECT_LT(r.canvas.cols, preJumpExtent * 1.35);
}

TEST(PanoCage, AbortsWhenThePoseTeleports) {
    const cv::Mat shelf = makeShelf(8000, kFrameH);
    auto cfg = testConfig();
    std::vector<double> xs = linearSweep(300, 20, 40);
    xs.push_back(xs.back() + 900);     // 0.39 m in one frame — a relocalisation
    for (int i = 1; i <= 5; ++i) xs.push_back(xs.back() + 20);
    SweepResult r = runSweep(shelf, xs, {}, cfg);
    EXPECT_EQ(r.stats.abortReason, "session-restart");
}

TEST(PanoCage, MeasuredAdvanceCageHoldsTheChainWhenItFires) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    auto cfg = testConfig();
    cfg.maxAdvancePx = 2.0;            // canvas px — every real step exceeds it
    cfg.cageStallFrames = 4;

    SweepResult r = runSweep(shelf, linearSweep(300, 20, 90), {}, cfg);
    printf("[cage] cage=%lld low=%lld pose=%lld painted=%lld stalled=%d latched=%d abort=%s\n",
           (long long)r.stats.rejectedOutOfCage, (long long)r.stats.rejectedLowResponse,
           (long long)r.stats.rejectedPoseSpeed, (long long)r.stats.painted,
           (int)r.stats.stalled, (int)r.stats.axisLatched, r.stats.abortReason.c_str());
    EXPECT_GE(r.stats.rejectedOutOfCage, 3);
    EXPECT_TRUE(r.stats.stalled) << "a sustained cage stall must become visible";
    // The chain is never advanced on a rejection, so a cage that can
    // never be satisfied ends in a VISIBLE abort — not in an aliased canvas.
    EXPECT_EQ(r.stats.abortReason, "chain-lost");
    EXPECT_FALSE(r.stats.axisLatched);
    EXPECT_TRUE(r.canvas.empty());
    EXPECT_EQ(r.stats.painted, 0);
}

TEST(PanoCage, ClampsTheCageToTheCorrelationWindowRange) {
    const cv::Mat shelf = makeShelf(5000, kFrameH);
    auto cfg = testConfig();
    cfg.maxAdvancePx = 5000.0;         // absurd — must be clamped, not honoured
    SweepResult r = runSweep(shelf, linearSweep(200, 15, 40), {}, cfg);
    const int winW = (int)std::lround(cfg.phaseWindowPx * cfg.workScale) & ~1;
    const double limit = 0.40 * winW / cfg.workScale * cfg.canvasScale;
    EXPECT_NEAR(r.stats.maxAdvancePxResolved, limit, 1e-6);
}

TEST(PanoCage, DerivesTheDefaultCageFromTheFrameWidth) {
    const cv::Mat shelf = makeShelf(5000, kFrameH);
    auto cfg = testConfig();          // maxAdvancePx 0 ⇒ derived
    SweepResult r = runSweep(shelf, linearSweep(200, 15, 40), {}, cfg);
    EXPECT_NEAR(r.stats.maxAdvancePxResolved,
                cfg.maxAdvanceFrac * kFrameW * cfg.canvasScale, 1e-6);
}

// ── Attitude rectification — the pano+ hypothesis in miniature ──────────────

TEST(PanoRectify, RemovesARollTheImageOnlyArmCannot) {
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    const auto xs = linearSweep(400, 20, 140);

    // A slow ±6° roll oscillation — exactly the unmodelled rotation the
    // offline replay left standing as a lateral wobble.
    std::vector<double> rolls;
    rolls.reserve(xs.size());
    for (size_t i = 0; i < xs.size(); ++i)
        rolls.push_back(6.0 * std::sin(2.0 * CV_PI * (double)i / 70.0));

    // SCOPE: the arm under test is `rectify`, and the ground truth is a FLAT
    // shelf — for which the planar (gnomonic) canvas is the exact comparison
    // surface.  v5's sweep-cylindrical canvas deliberately trades that
    // exactness for bounded area magnification, so comparing IT against a flat
    // plane would be measuring the projection, not the hypothesis.  The
    // cylindrical arm is pinned on its own terms by the PanoProjection suite.
    auto on = testConfig();
    on.rectify = true;
    on.projection = 0;
    auto off = testConfig();
    off.rectify = false;
    off.projection = 0;

    SweepResult a = runSweep(shelf, xs, rolls, on);
    SweepResult b = runSweep(shelf, xs, rolls, off);

    ASSERT_FALSE(a.canvas.empty());
    ASSERT_FALSE(b.canvas.empty());
    EXPECT_GT(a.stats.maxRectifyDeg, 4.0);   // the attitude really was there

    cv::Mat gt;
    cv::resize(shelf, gt, cv::Size(), on.canvasScale, on.canvasScale,
               cv::INTER_AREA);
    const cv::Rect pr(a.canvas.cols / 2 - 150, a.canvas.rows / 2 - 100, 300, 200);
    const double nccOn = bestNcc(a.canvas(pr), gt);
    const cv::Rect pr2(b.canvas.cols / 2 - 150, b.canvas.rows / 2 - 100, 300, 200);
    const double nccOff = bestNcc(b.canvas(pr2), gt);

    EXPECT_GT(nccOn, 0.88) << "rectified sweep did not reproduce the scene";
    EXPECT_GT(nccOn, nccOff + 0.05)
        << "rectify=true did not beat rectify=false under a real roll "
           "(on=" << nccOn << " off=" << nccOff << ")";
}

// PITCH / YAW coverage.  Roll is the ONE attitude dof under which H_rect
// stays affine, and it is also the dof the offline RCA said was NOT the
// problem — so a suite that only rolls never exercises the projective terms
// (bottom row ≠ [0,0,1]) at all.  This is the yaw twin of the roll test.
TEST(PanoRectify, RemovesAYawTheImageOnlyArmCannot) {
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(400, 20, 140);
    spec.qs.reserve(spec.xs.size());
    for (size_t i = 0; i < spec.xs.size(); ++i)
        spec.qs.push_back(yawQuat(7.0 * std::sin(2.0 * CV_PI * (double)i / 70.0)));

    // Same scoping as the roll twin: flat ground truth ⇒ planar canvas.
    auto on = testConfig();  on.rectify = true;  on.projection = 0;
    auto off = testConfig(); off.rectify = false; off.projection = 0;

    SweepResult a = runSweepSpec(shelf, spec, on);
    SweepResult b = runSweepSpec(shelf, spec, off);
    ASSERT_FALSE(a.canvas.empty());
    ASSERT_FALSE(b.canvas.empty());
    EXPECT_GT(a.stats.maxRectifyDeg, 5.0);

    cv::Mat gt;
    cv::resize(shelf, gt, cv::Size(), on.canvasScale, on.canvasScale, cv::INTER_AREA);
    const cv::Rect pr(a.canvas.cols / 2 - 150, a.canvas.rows / 2 - 100, 300, 200);
    const cv::Rect pr2(b.canvas.cols / 2 - 150, b.canvas.rows / 2 - 100, 300, 200);
    const double nccOn = bestNcc(a.canvas(pr), gt);
    const double nccOff = bestNcc(b.canvas(pr2), gt);
    EXPECT_GT(nccOn, 0.85) << "rectified yaw sweep did not reproduce the scene";
    EXPECT_GT(nccOn, nccOff + 0.03)
        << "rectify=true did not beat rectify=false under a real yaw "
           "(on=" << nccOn << " off=" << nccOff << ")";
}

// THE hypothesis, in its purest form: a camera that only ROTATES sees no
// scene translation, so a correctly rectified engine must measure ~no
// advance.  The image-only arm cannot know that and chases the rotation.
// SCOPE, stated because this test's name over-promises: it pins the A/B
// CONTRAST (rectified arm does not chase the rotation, control arm does) on an
// INTERMEDIATE quantity.  It says nothing about the deliverable — the fixture
// crops at a fixed origin, so no new scene ever enters the frame.  The canvas
// itself is asserted by PanoAdvance.PureRotationSweepGrowsTheCanvasByFocalTimesTheta.
TEST(PanoRectify, PureRotationProducesNoAdvanceWhenRectified) {
    const cv::Mat shelf = makeShelf(4000, kFrameH);
    SweepSpec spec;
    spec.xs.assign(90, 1200.0);          // ZERO translation
    spec.qs.reserve(90);
    for (int i = 0; i < 90; ++i) spec.qs.push_back(yawQuat(0.2 * i));

    auto on = testConfig();  on.rectify = true;
    auto off = testConfig(); off.rectify = false;

    SweepResult a = runSweepSpec(shelf, spec, on);
    SweepResult b = runSweepSpec(shelf, spec, off);

    auto meanAbsAdvance = [](const SweepResult& r) {
        double s = 0; int n = 0;
        for (const auto& row : r.rows) {
            if (row.outcome == rnis::pano::Outcome::TailFlush) continue;
            if (row.response <= 0.0) continue;
            s += std::fabs(row.advanceX); ++n;
        }
        return n > 0 ? s / n : 0.0;
    };
    const double advOn = meanAbsAdvance(a);
    const double advOff = meanAbsAdvance(b);
    EXPECT_LT(advOn, 0.6) << "rectified arm invented translation from pure rotation";
    EXPECT_GT(advOff, 3.0 * std::max(advOn, 0.05))
        << "control arm should chase the rotation (on=" << advOn
        << " off=" << advOff << ")";
}

// The A/B arms must differ in the HYPOTHESIS and nothing else.  The
// excursion gate used to live inside `if (rectify)`, so the control arm had
// no gate at all and could never produce this outcome.
// v5 SCOPE, and it is a behaviour change rather than a test fix:
// rectifyYawLimitDeg now bounds the CROSS excursion — the part the homography
// actually carries — while the along-sweep excursion is bounded by
// Config::sweepMaxDeg and canvasMaxWidthPx.  A YAW on a HORIZONTAL sweep IS
// the sweep component, so it is no longer gated by this knob; that is the
// point (see PanoProjection.APivotPastTheOldYawLimitStillPaints).  A PITCH on
// a horizontal sweep is the cross component, and that is what this gate is
// for.  Both arms must still reject the SAME frames, which is what this test
// is really pinning.
TEST(PanoRectify, ExcursionGateAppliesToBothArms) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(300, 18, 60);
    spec.qs.assign(spec.xs.size(), identityQuat());
    for (size_t i = 40; i < spec.xs.size(); ++i) spec.qs[i] = pitchQuat(25.0);

    for (bool rectify : {true, false}) {
        auto cfg = testConfig();
        cfg.rectify = rectify;
        cfg.rectifyYawLimitDeg = 10.0;
        SweepResult r = runSweepSpec(shelf, spec, cfg);
        EXPECT_GE(countOutcome(r, rnis::pano::Outcome::RejectedRectify), 10)
            << "rectify=" << rectify;
    }
}

// The correlation window is pinned to the RECTIFIED frame centre, which under
// yaw θ sits fx·tanθ px away from the raster centre — off the raster entirely
// well before the 35° default limit.  Clamping it into the rectified
// footprint is what stops the engine correlating BORDER_CONSTANT black and
// emitting spurious low-response / held-backtrack rows.
TEST(PanoRectify, LargeYawDoesNotManufactureRejectionsOrReversals) {
    const cv::Mat shelf = makeShelf(8000, kFrameH);
    auto cfg = testConfig();          // rectifyYawLimitDeg stays at its default

    auto sweepAt = [&](double maxYawDeg) {
        SweepSpec spec;
        spec.xs = linearSweep(400, 18, 120);
        spec.qs.reserve(spec.xs.size());
        for (size_t i = 0; i < spec.xs.size(); ++i) {
            const double f = (double)i / (double)(spec.xs.size() - 1);
            spec.qs.push_back(yawQuat(maxYawDeg * f));
        }
        return runSweepSpec(shelf, spec, cfg);
    };

    SweepResult mild = sweepAt(8.0);
    SweepResult hard = sweepAt(30.0);   // legal: inside rectifyYawLimitDeg

    const int mildBad = countOutcome(mild, rnis::pano::Outcome::RejectedLowResponse)
                      + countOutcome(mild, rnis::pano::Outcome::HeldBacktrack);
    const int hardBad = countOutcome(hard, rnis::pano::Outcome::RejectedLowResponse)
                      + countOutcome(hard, rnis::pano::Outcome::HeldBacktrack);
    EXPECT_TRUE(hard.stats.abortReason.empty()) << hard.stats.abortReason;
    EXPECT_GT(hard.stats.maxRectifyDeg, 25.0);
    EXPECT_LE(hardBad, mildBad + 3)
        << "a legal-but-large yaw manufactured " << hardBad
        << " rejections/reversals vs " << mildBad << " at 8°";
}

TEST(PanoRectify, RejectsAnExcursionBeyondTheYawLimit) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    auto cfg = testConfig();
    cfg.rectifyYawLimitDeg = 10.0;

    const auto xs = linearSweep(300, 18, 60);
    std::vector<double> rolls(xs.size(), 0.0);
    for (size_t i = 40; i < xs.size(); ++i) rolls[i] = 25.0;   // way past the limit

    SweepResult r = runSweep(shelf, xs, rolls, cfg);
    EXPECT_GE(countOutcome(r, rnis::pano::Outcome::RejectedRectify), 15);
    EXPECT_TRUE(r.holes.empty());
}


// ── THE ADVANCE MODEL: rotation, translation, and the two mixed ─────────────
//
// THE fixture this suite was missing, and why the one it had could not catch a
// one-frame canvas.  PanoRectify.PureRotationProducesNoAdvanceWhenRectified
// crops the shelf at a FIXED origin and warps that crop through H_rect⁻¹ with
// BORDER_REPLICATE: the frame is distorted, but no NEW scene ever enters it, so
// a sweep that reveals nothing cannot grow a canvas however correct the engine
// is.  It then asserts an INTERMEDIATE quantity (mean |advanceX| < 0.6) which
// is ≈0 BY DESIGN under a correct rectification — an assertion a working AND a
// broken engine both satisfy.
//
// Here each frame is SAMPLED FROM THE SHELF through its own projection
//
//     shelf px = T(x0, y0) · H_rect(q) · frame px
//
// so a pitching camera genuinely reveals new shelf rows — the operator's actual
// pano gesture — and every assertion below is on the DELIVERABLE: the painted
// extent, the latched direction, the holes.

cv::Mat renderProjectedFrame(const cv::Mat& shelf, double x0, double y0,
                             const Quat& q) {
    const cv::Matx33d T(1, 0, x0, 0, 1, y0, 0, 0, 1);
    const cv::Matx33d M = T * rectifyH(q.data());
    cv::Mat out;
    cv::warpPerspective(shelf, out, cv::Mat(M), cv::Size(kFrameW, kFrameH),
                        cv::INTER_LINEAR | cv::WARP_INVERSE_MAP,
                        cv::BORDER_REPLICATE);
    return out;
}

/// `renderProjectedFrame` with a magnification about the frame centre.  A
/// SEPARATE helper so the unzoomed path stays byte-identical for every
/// fixture that never asked for a zoom.
cv::Mat renderProjectedFrameZoomed(const cv::Mat& shelf, double x0, double y0,
                                   const Quat& q, double zoom) {
    const cv::Matx33d T(1, 0, x0, 0, 1, y0, 0, 0, 1);
    const cv::Matx33d Z(1.0 / zoom, 0, kCx * (1.0 - 1.0 / zoom),
                        0, 1.0 / zoom, kCy * (1.0 - 1.0 / zoom),
                        0, 0, 1);
    const cv::Matx33d M = T * Z * rectifyH(q.data());
    cv::Mat out;
    cv::warpPerspective(shelf, out, cv::Mat(M), cv::Size(kFrameW, kFrameH),
                        cv::INTER_LINEAR | cv::WARP_INVERSE_MAP,
                        cv::BORDER_REPLICATE);
    return out;
}

struct ProjSweepSpec {
    int    n        = 90;
    double pitchDeg = 0.0;   // TOTAL pitch swept, signed (0 ⇒ no rotation)
    double dx       = 0.0;   // shelf px per frame, horizontal
    double dy       = 0.0;   // shelf px per frame, vertical
    /// Deterministic per-frame image NOISE, in DN.  A noiseless synthetic has
    /// no per-boundary residual to random-walk at all (measured: the seam
    /// divergence of a clean walk is 0.55-0.67 px at 52 boundaries AND at
    /// 452), which makes it useless for asking how a session-cumulative
    /// statistic behaves as a sweep gets longer.  Real packs do random-walk
    /// (measured on 15-58-22: 1.6 -> 3.1 -> 19.5 -> 52.4 px at 73 -> 107 ->
    /// 192 -> 318 boundaries), so a fixture that means to answer that question
    /// has to carry noise.
    double noiseDN  = 0.0;
    /// Deterministic per-frame error in the REPORTED attitude, in degrees.
    ///
    /// The frame's PIXELS are still rendered from the true pose — only `in.q`
    /// is perturbed.  That is the real situation (ARKit reports a noisy
    /// attitude for a frame whose content came from wherever the camera
    /// actually was), and it is the only way to ask whether the engine's
    /// attitude channel can reach the delivered panorama.  A sweep with this
    /// set is NOT a harder tracking problem — it is the SAME image sequence
    /// with a lying pose stream.
    double attNoiseDeg = 0.0;
    /// A steady ZOOM along the sweep: frame i is rendered at magnification
    /// 1 + zoomPerFrame·i about its own centre.  What the operator's sweeps
    /// do to a near railing as the pivot carries the camera toward it, and
    /// what the strip chain does NOT model (cross scale is not fitted, so each
    /// strip is at its frame's own scale and the run fans, while a block is
    /// one frame at one scale).  0 ⇒ the render is byte-identical to before.
    double zoomPerFrame = 0.0;
    /// The zoom's RATE ramps linearly to zero over the last `zoomRampFrames`
    /// frames (0 ⇒ constant to the end).  With a ramp the strips' fan BENDS
    /// inside the tail window — the offset behind the join is quadratic in u
    /// with zero slope at the join — which is what a trajectory estimator
    /// that reads the window's mean slope gets wrong (Config::crossTraj).
    int    zoomRampFrames = 0;
    /// Push every frame through `distortFrame(k1, k2)` after rendering — the
    /// lens fixture's dose, on a pitched sweep.  0 ⇒ untouched.
    double lensK1 = 0.0, lensK2 = 0.0;
};

namespace {
cv::Mat distortFrame(const cv::Mat& pin, double k1, double k2);   // defined below
}  // namespace

/// Hamilton product, [x,y,z,w] — `a` then `b`, camera-frame composition.
Quat mulQuat(const Quat& a, const Quat& b) {
    return Quat{a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
                a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
                a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
                a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]};
}

/// The per-frame attitude LIE, deterministic in the frame index.  Two axes, at
/// incommensurate rates, so the error is neither a constant bias (which the
/// reference latch would absorb) nor aligned with the sweep.
Quat attitudeError(double deg, int frameIndex) {
    if (std::fabs(deg) <= 1e-12) return identityQuat();
    const double i = (double)frameIndex;
    return mulQuat(yawQuat(deg * std::sin(2.399963 * i)),
                   pitchQuat(deg * std::sin(1.618034 * i + 0.7)));
}

/// The fixture's synthetic sensor noise, as ONE function so the test that
/// guards it (PanoDeterminism.TheSyntheticNoiseIsRealAndRepeatable) checks the
/// code the sweeps actually run rather than a copy of it that can drift.
///
/// ⚠ cv::Scalar::all, NOT bare doubles.  RNG::fill takes its two distribution
/// parameters as InputArray; a bare `double` becomes a 1x1 array, and for a
/// MULTI-CHANNEL destination OpenCV then reads the per-channel mean/stddev
/// slots it was never given.  Measured 2026-08-23 on host OpenCV 5.0.0,
/// CV_16SC3, seed fixed, inside one process:
///
///   rng.fill(noise, NORMAL, Scalar::all(0.0),
///                           Scalar::all(5.0))  -> range [-25..25], bit-identical
///                                            across heap states and across a
///                                            pre-filled sentinel
///
/// The bare-double form is UNDEFINED, and re-measured 2026-08-23 it does not
/// even fail the same way twice — which is the point.  In one and the same
/// -O0 binary the noise buffer came back all-zero for frame 0 and carrying
/// -32768 for frames 1-2; in a standalone probe (any size tried, sentinel-
/// prefilled or not) it came back all-zero every time; and adding ONE
/// unrelated 9 MB allocate/free inside this function flipped a build that
/// failed PanoDeterminism into one that passed it, without touching a line
/// the engine runs.  A result that moves when you add an allocation next to
/// it is not a computation.  Do not "simplify" this back to doubles.
///
/// What the defect DID, concretely: the frames handed to ingest() were not the
/// same frames between two sweeps of the same spec in one process (measured:
/// first differing frame index 9, and the sweep's first differing output row
/// is 9 as well).  The ENGINE was never the nondeterministic part — see
/// PanoDeterminism.TheEngineIsAPureFunctionOfItsInputs, which pins that
/// separately and would have decided this in one run.
void applySyntheticNoise(cv::Mat& crop, double noiseDN, int frameIndex) {
    if (noiseDN <= 0.0) return;
    cv::RNG rng(0x5eed1234u + (uint64_t)frameIndex * 7919u);   // deterministic
    cv::Mat noise(crop.size(), CV_16SC3);
    rng.fill(noise, cv::RNG::NORMAL, cv::Scalar::all(0.0),
             cv::Scalar::all(noiseDN));
    cv::Mat wide;
    crop.convertTo(wide, CV_16SC3);
    wide += noise;
    wide.convertTo(crop, CV_8UC3);
}

/// FNV-1a over a Mat's pixels, used only by the determinism tests to turn
/// "the inputs were the same" from an assumption into an assertion.  Clones a
/// non-continuous Mat first: hashing `data` for `total()*elemSize()` bytes on a
/// ROI reads the parent's padding, which is exactly the kind of quietly-wrong
/// instrument that sent one investigation of this bug off indicting the engine.
inline uint64_t fnv1aPixels(const cv::Mat& m) {
    const cv::Mat c = m.isContinuous() ? m : m.clone();
    uint64_t h = 1469598103934665603ull;
    const uchar* p = c.data;
    const size_t n = c.total() * c.elemSize();
    EXPECT_GT(n, 0u) << "hashing an empty Mat proves nothing";
    for (size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 1099511628211ull; }
    return h;
}

/// The ingest loop of `runProjectedSweep`, WITHOUT `finish()`.
///
/// Extracted so a test can look at the engine mid-sweep — the provisional
/// lead-out only exists before the tail flush, and it is the lead-out that has
/// to agree with what the flush then commits.  `runProjectedSweep` is this plus
/// the finish, so the two cannot describe different sweeps.
///
/// `afterFrame(i, in)` runs after frame `i` was ingested, with the SAME
/// `FrameInput` (its pixel pointers still live) — a per-TICK probe for a test
/// that has to look at every preview the sweep would publish, or feed the
/// identical frame to a second engine in lockstep.  Null (every pre-existing
/// caller) is the loop exactly as it was.
using AfterFrameFn = std::function<void(int, const rnis::pano::FrameInput&)>;
void ingestProjectedSweep(rnis::pano::Engine& eng, const cv::Mat& shelf,
                          const ProjSweepSpec& s,
                          const rnis::pano::Config& cfg, SweepResult& out,
                          const AfterFrameFn& afterFrame = nullptr) {
    const double x0ref = 1400.0, y0ref = 1400.0;
    double zoomAcc = 0.0;
    for (int i = 0; i < s.n; ++i) {
        const double f = (double)i / (double)std::max(1, s.n - 1);
        const double x0 = x0ref + s.dx * (double)i;
        const double y0 = y0ref + s.dy * (double)i;
        const Quat q = (std::fabs(s.pitchDeg) > 1e-12)
                           ? pitchQuat(s.pitchDeg * f) : identityQuat();
        // The zoom is cumulative so a ramp can taper its RATE: full rate up
        // to n − ramp, then linearly to nothing at the last frame.
        if (s.zoomPerFrame != 0.0 && i > 0) {
            const double left = (double)(s.n - i);
            const double rate = (s.zoomRampFrames > 0 && left < (double)s.zoomRampFrames)
                                    ? s.zoomPerFrame * left / (double)s.zoomRampFrames
                                    : s.zoomPerFrame;
            zoomAcc += rate;
        }
        cv::Mat crop = (s.zoomPerFrame != 0.0)
            ? renderProjectedFrameZoomed(shelf, x0, y0, q, 1.0 + zoomAcc)
            : renderProjectedFrame(shelf, x0, y0, q);
        if (std::fabs(s.lensK1) > 1e-12 || std::fabs(s.lensK2) > 1e-12)
            crop = distortFrame(crop, s.lensK1, s.lensK2);
        applySyntheticNoise(crop, s.noiseDN, i);
        // The PIXELS above came from `q`.  What the engine is TOLD may not be.
        const Quat qReported = mulQuat(q, attitudeError(s.attNoiseDeg, i));
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);

        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        for (int k = 0; k < 4; ++k) in.q[k] = qReported[k];
        in.t[0] = x0 * (0.6 / kFx);
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = (int64_t)i;
        out.rows.push_back(eng.ingest(in));
        if (afterFrame) afterFrame(i, in);
    }
}

SweepResult runProjectedSweep(const cv::Mat& shelf, const ProjSweepSpec& s,
                              const rnis::pano::Config& cfg) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;

    SweepResult out;
    ingestProjectedSweep(eng, shelf, s, cfg, out);
    out.rows.push_back(eng.finish());
    eng.finalCanvas(out.canvas);
    // Rendered with the SAME `cropPadRows` as the canvas one line up — which
    // is the only argument that can separate the two, and the reason
    // `finalCoverage` takes it at all. See the PanoCoverage block.
    eng.finalCoverage(out.coverage);
    out.stats = eng.stats();
    out.holes = eng.unpaintedRuns();
    out.envelope = eng.verticalEnvelope();
    return out;
}

/// One frame's footprint ALONG the latched sweep axis, in canvas px — the
/// width a one-frame canvas has.  Growth is measured past this.
double sweepFootprintPx(const rnis::pano::SessionStats& st, double canvasScale) {
    return canvasScale * (double)(st.axis == 0 ? kFrameW : kFrameH);
}

double sweepGrowthPx(const SweepResult& r, const rnis::pano::Config& cfg) {
    return (double)r.stats.paintedW - sweepFootprintPx(r.stats, cfg.canvasScale);
}

/// What a pure pitch of `deg` MUST move the frame by, in canvas px.
double rotationTravelPx(double deg, double canvasScale) {
    return canvasScale * kFy * std::fabs(std::tan(deg * CV_PI / 180.0));
}

// A rotation-dominant sweep is what a person actually does when they pano —
// they pivot.  It MUST grow the canvas by ≈ f·tan(θ)·canvasScale, in BOTH
// pitch polarities.  The shipped engine painted 0 of 85 frames here (it latched
// its sweep sign from Σ(advance) — the post-rectification RESIDUAL, which is
// ≈ −attitude and therefore votes backwards on exactly this gesture).
TEST(PanoAdvance, PureRotationSweepGrowsTheCanvasByFocalTimesTheta) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();
    const double kDeg = 18.0;
    const double expect = rotationTravelPx(kDeg, cfg.canvasScale);

    for (double polarity : {-1.0, 1.0}) {
        ProjSweepSpec s;
        s.n = 90;
        s.pitchDeg = polarity * kDeg;
        SweepResult r = runProjectedSweep(shelf, s, cfg);

        SCOPED_TRACE(polarity < 0 ? "pitch DOWN" : "pitch UP");
        ASSERT_TRUE(r.stats.axisLatched);
        EXPECT_EQ(r.stats.axis, 1) << "a pitch sweep moves the frame VERTICALLY";
        EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;
        EXPECT_TRUE(r.holes.empty());
        const double growth = sweepGrowthPx(r, cfg);
        EXPECT_GT(growth, 0.60 * expect)
            << "rotation-dominant sweep produced a " << r.stats.paintedW
            << " px canvas (one frame is " << sweepFootprintPx(r.stats, cfg.canvasScale)
            << "); expected ≈ " << expect << " px of growth";
        EXPECT_LT(growth, 2.20 * expect) << "canvas grew far past the rotation";
        EXPECT_GT(r.stats.painted, 40)
            << "only " << r.stats.painted << " frames painted of " << s.n;
    }
}

// The regime the engine already handled — walking a shelf.  This is the guard
// that stops the rotation fix being "over-rotated" into an attitude-only
// placement: a walking sweep produces NO attitude change at all, so an engine
// that places frames from H_rect alone paints exactly one frame here.
TEST(PanoAdvance, PureTranslationSweepStillGrowsTheCanvas) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 14.0;
    const double expect = s.dx * (s.n - 1) * cfg.canvasScale;

    SweepResult r = runProjectedSweep(shelf, s, cfg);
    ASSERT_TRUE(r.stats.axisLatched);
    EXPECT_EQ(r.stats.axis, 0);
    EXPECT_TRUE(r.holes.empty());
    EXPECT_GT(sweepGrowthPx(r, cfg), 0.75 * expect);
    EXPECT_GT(r.stats.painted, 40);
}

// MIXED, on ONE axis — the case that tells a summed model from a
// double-counted one.  A camera that pitches WHILE it moves sweeps the SUM of
// the two contributions; measure each alone, then together.  (A GL +X pitch
// moves the frame UP the canvas and a growing crop origin moves it DOWN, so
// the ADDING combination is a negative pitch with a positive dy — verified by
// the two single-channel arms below, not assumed.)
TEST(PanoAdvance, MixedSweepSumsBothContributionsWithoutDoubleCounting) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();
    const double kDeg = -12.0;
    const double kDy  = 6.0;

    ProjSweepSpec rot;  rot.n = 90; rot.pitchDeg = kDeg;
    ProjSweepSpec tra;  tra.n = 90; tra.dy = kDy;
    ProjSweepSpec both; both.n = 90; both.pitchDeg = kDeg; both.dy = kDy;

    SweepResult a = runProjectedSweep(shelf, rot, cfg);
    SweepResult b = runProjectedSweep(shelf, tra, cfg);
    SweepResult c = runProjectedSweep(shelf, both, cfg);

    EXPECT_EQ(a.stats.axis, 1);
    EXPECT_EQ(b.stats.axis, 1);
    EXPECT_EQ(c.stats.axis, 1);
    EXPECT_TRUE(c.holes.empty());
    // Both channels pull the same way, so the two session-level travels must
    // agree in sign with each other and with the sweep.
    EXPECT_GT(c.stats.rotTravelPx, 0.0);
    EXPECT_GT(c.stats.resTravelPx, 0.0);

    const double gr = sweepGrowthPx(a, cfg);
    const double gt = sweepGrowthPx(b, cfg);
    const double gc = sweepGrowthPx(c, cfg);
    ASSERT_GT(gr, 20.0) << "rotation arm did not sweep";
    ASSERT_GT(gt, 20.0) << "translation arm did not sweep";
    // A double-counted attitude term would land near gr + gt + gr; a cancelled
    // one near |gt - gr|.
    EXPECT_NEAR(gc, gr + gt, 0.22 * (gr + gt))
        << "rot=" << gr << " trans=" << gt << " mixed=" << gc;
}

// THE HARD MIXED CASE, and the one that decides how the axis latch may read
// the attitude: the camera pitches ONE way while the operator moves the OTHER,
// and the translation wins.  The rotation channel crosses its threshold first
// here and points BACKWARDS — an engine that simply prefers the attitude paints
// nothing.  The sweep must still resolve to the net direction and still grow.
TEST(PanoAdvance, MixedSweepWhereRotationOpposesTranslationStillSweeps) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();

    ProjSweepSpec rot;  rot.n = 90; rot.pitchDeg = 12.0;
    ProjSweepSpec tra;  tra.n = 90; tra.dy = 6.0;
    ProjSweepSpec both; both.n = 90; both.pitchDeg = 12.0; both.dy = 6.0;

    SweepResult a = runProjectedSweep(shelf, rot, cfg);
    SweepResult b = runProjectedSweep(shelf, tra, cfg);
    SweepResult c = runProjectedSweep(shelf, both, cfg);

    const double gr = sweepGrowthPx(a, cfg);
    const double gt = sweepGrowthPx(b, cfg);
    const double gc = sweepGrowthPx(c, cfg);
    ASSERT_GT(gt, gr) << "fixture no longer has translation winning";

    EXPECT_EQ(c.stats.axis, 1);
    EXPECT_TRUE(c.holes.empty());
    EXPECT_GT(c.stats.painted, 30)
        << "the opposing-mixed sweep painted " << c.stats.painted << " frames";
    EXPECT_GT(gc, 0.5 * (gt - gr))
        << "rot=" << gr << " trans=" << gt << " mixed=" << gc;
    // The two channels genuinely FIGHT: opposite signs along the latched axis.
    EXPECT_LT(c.stats.rotTravelPx * c.stats.resTravelPx, 0.0);
    // ...and the regime split names the winner.
    EXPECT_LT(c.stats.rotationFraction, 0.5);
}

// The 6-frame latch window is a SAMPLE, and a fix that merely gets the right
// answer on one sample length has not fixed anything.  The latched direction
// must not depend on how long the engine looked.
TEST(PanoAdvance, LatchedDirectionIsInvariantToTheLatchWindowLength) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const double kDeg = 18.0;
    const double expect = rotationTravelPx(kDeg, 0.5);

    int firstAxis = -1, firstSign = 0;
    for (int latchFrames : {3, 6, 12, 24}) {
        auto cfg = testConfig();
        cfg.axisLatchFrames = latchFrames;
        ProjSweepSpec s;
        s.n = 90;
        s.pitchDeg = -kDeg;
        SweepResult r = runProjectedSweep(shelf, s, cfg);

        SCOPED_TRACE("axisLatchFrames=" + std::to_string(latchFrames));
        ASSERT_TRUE(r.stats.axisLatched);
        if (firstAxis < 0) { firstAxis = r.stats.axis; firstSign = r.stats.sweepSign; }
        EXPECT_EQ(r.stats.axis, firstAxis);
        EXPECT_EQ(r.stats.sweepSign, firstSign);
        EXPECT_GT(sweepGrowthPx(r, cfg), 0.60 * expect);
        EXPECT_TRUE(r.holes.empty());
    }
}

// A fully FORCED axis+sign has nothing to vote on, so the motion gate must not
// make it wait: an A/B arm that pins both knobs has to start painting on the
// same frame as the arm it is compared against, or the two runs differ in more
// than the knob under test.  (This is also the operator's escape hatch if a
// field sweep ever latches wrongly again.)
TEST(PanoAdvance, ForcedAxisAndSignSkipTheMotionGate) {
    const cv::Mat shelf = makeShelf(5200, 3400);

    auto forced = testConfig();
    forced.axisOverride = 2;      // vertical
    forced.signOverride = 1;
    // Thresholds no real sweep in this fixture could ever reach.
    forced.latchTotalPx    = 1.0e6;
    forced.axisLatchMaxFrames = 10000;

    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = -18.0;
    SweepResult r = runProjectedSweep(shelf, s, forced);

    ASSERT_TRUE(r.stats.axisLatched) << "a forced axis+sign waited on the gate";
    EXPECT_EQ(r.stats.axis, 1);
    EXPECT_EQ(r.stats.sweepSign, 1);
    EXPECT_EQ(r.stats.latchFramesUsed, forced.axisLatchFrames);
    EXPECT_GT(r.stats.painted, 40);
    EXPECT_TRUE(r.holes.empty());

    // Only ONE knob forced still needs the vote — and therefore the gate.
    auto half = testConfig();
    half.signOverride = 1;
    half.latchTotalPx    = 1.0e6;
    half.axisLatchMaxFrames = 40;
    SweepResult h = runProjectedSweep(shelf, s, half);
    EXPECT_EQ(h.stats.latchFramesUsed, half.axisLatchMaxFrames)
        << "a half-forced config skipped the gate it still needs";
}

// ── Regime reporting: the pack must STATE what kind of sweep it was ────────
//
// The first device pack cost a full offline forensic pass to answer one
// question — "was that a pivot or a walk?" — because the ledger carried only
// the RESIDUAL advance, which is ≈0 on a pivot BY DESIGN.  Both channels and
// their sum are ledgered now, per frame and per session.

TEST(PanoRegime, LedgersBothChannelsAndTheirSum) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();
    ProjSweepSpec s;
    s.n = 90; s.pitchDeg = -14.0; s.dy = 4.0;
    SweepResult r = runProjectedSweep(shelf, s, cfg);

    int checked = 0;
    for (const auto& row : r.rows) {
        if (row.outcome == rnis::pano::Outcome::TailFlush) continue;
        // The identity is UNCONDITIONAL — every row, including the ones the
        // response floor and the cage reject.  Those carry advance == 0 (the
        // residual never reached the chain) so advanceTot collapses to
        // advanceRot, which is a true statement rather than a broken identity.
        // No `response` predicate here on purpose: the old test skipped rows
        // below minPhaseResponse and so was green by luck once the stall floor
        // (stallResumeResponse, 12× minPhaseResponse) started rejecting rows
        // the predicate still let through.
        EXPECT_NEAR(row.advanceTotX, row.advanceRotX + row.advanceX, 1e-9);
        EXPECT_NEAR(row.advanceTotY, row.advanceRotY + row.advanceY, 1e-9);
        ++checked;
    }
    EXPECT_GT(checked, 60);

    // Session totals: the two channels' travels sum to the panorama's own.
    const double travel = r.stats.rotTravelPx + r.stats.resTravelPx;
    EXPECT_GT(travel, 100.0);
    EXPECT_NEAR(travel, sweepGrowthPx(r, cfg), 0.35 * travel);
    // A path can only be longer than the travel it produced.
    EXPECT_GE(r.stats.rotPathPx, std::fabs(r.stats.rotTravelPx) - 1e-6);
    EXPECT_GE(r.stats.resPathPx, std::fabs(r.stats.resTravelPx) - 1e-6);
}

// ── THE ATTITUDE CANCELS OUT OF THE COMMITTED STEP ─────────────────────────
//
// PanoRegime.LedgersBothChannelsAndTheirSum above pins the BOOKKEEPING
// identity advanceTot == advanceRot + advance, which is true by assignment and
// would survive the compensation being deleted.  This pins the LOAD-BEARING
// one, which would not.
//
// Because the correlation window origin tracks the rectified frame centre,
//
//     owX == crx·ws − winW/2      ⇒     owX − prevOwX == ws·(crx − prevCrX)
//
// and the origin-compensated residual is
//
//     advance = −canvasScale·[shift + (owX − prevOwX)]/ws
//             = −canvasScale·shift/ws  −  advanceRot
//
// so the committed step advanceTot = advanceRot + advance = −canvasScale·
// shift/ws carries NO attitude term at all.  Verified on the four operator
// packs to 0.0e+00 canvas px over 1709 accepted frames, 0 of them clamped
// (the offline twin's wobble source, results
// 2026-08-24-panoplus-noise-impl/wobble_source.json).
//
// The consequence is what this test asserts, because it is the one a future
// edit can break: the delivered panorama is INVARIANT to the reported
// attitude.  Feed the same pixels with a lying pose stream and the placement
// must not move — the rectification error the lie introduces is re-measured by
// the correlation and subtracted again in the same step.
//
// This is also the answer to the question the JOB-2 round left open ("is the
// attitude channel's high-frequency content ARKit noise, or real motion?").
// For the committed step it does not matter: it cancels either way, so the
// attitude channel is NOT a wobble lever.  What survives is the correlation's
// own error on `shift`, and nothing else.
TEST(PanoAdvance, ReportedAttitudeNoiseDoesNotReachTheCommittedPlacement) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();
    ProjSweepSpec s;
    s.n = 90; s.pitchDeg = -14.0; s.dy = 4.0;

    SweepResult clean = runProjectedSweep(shelf, s, cfg);
    ProjSweepSpec lie = s;
    lie.attNoiseDeg = 0.04;          // ≈ 0.98 px of frame-centre motion at kFy
    SweepResult noisy = runProjectedSweep(shelf, lie, cfg);

    ASSERT_EQ(clean.rows.size(), noisy.rows.size());
    double rotMoved = 0.0, totMoved = 0.0;
    int checked = 0;
    for (size_t i = 0; i < clean.rows.size(); ++i) {
        const auto& a = clean.rows[i];
        const auto& b = noisy.rows[i];
        if (a.outcome == rnis::pano::Outcome::TailFlush) continue;
        if (!a.chainAdvanced || !b.chainAdvanced) continue;
        rotMoved = std::max(rotMoved,
                            std::max(std::fabs(b.advanceRotX - a.advanceRotX),
                                     std::fabs(b.advanceRotY - a.advanceRotY)));
        totMoved = std::max(totMoved,
                            std::max(std::fabs(b.advanceTotX - a.advanceTotX),
                                     std::fabs(b.advanceTotY - a.advanceTotY)));
        ++checked;
    }
    ASSERT_GT(checked, 60);

    // NON-VACUITY FIRST.  If the lie never reached the attitude channel the
    // rest of this test asserts nothing, and a test that can only pass is
    // worse than no test.
    EXPECT_GT(rotMoved, 0.5)
        << "the attitude lie never reached advanceRot — fixture is inert";

    // …and the committed step barely notices.  What is left is the correlation
    // re-measuring a differently-warped window, which is second order; the
    // attitude term itself is gone algebraically.
    EXPECT_LT(totMoved, 0.25 * rotMoved)
        << "committed step moved " << totMoved << " canvas px when the attitude "
        << "channel moved " << rotMoved << " — the cancellation is broken";

    // The DELIVERABLE, not just the ledger.
    EXPECT_EQ(clean.stats.corrOriginClampedFrames, 0)
        << "fixture clamped the origin — outside the identity's regime";
    EXPECT_EQ(noisy.stats.corrOriginClampedFrames, 0);
    EXPECT_EQ(clean.stats.axis, noisy.stats.axis);
    EXPECT_EQ(clean.stats.sweepSign, noisy.stats.sweepSign);
    EXPECT_NEAR((double)noisy.stats.paintedW, (double)clean.stats.paintedW,
                0.02 * (double)clean.stats.paintedW)
        << "a lying pose stream moved the panorama's extent";
}

// The identity above holds while the window origin sits ON the rectified
// centre.  The clamp is the one thing that moves it off, so a pack has to be
// able to SAY whether it ran inside that regime — the same reason
// exposureClampedFrames exists.  Counted on accepted frames only.
TEST(PanoStats, TheWindowOriginClampIsCountedNotSilent) {
    const cv::Mat shelf = makeShelf(5200, 3400);

    // ── the REGIME.  At the shipped window (phaseWindowPx 384 ⇒ 192×144 work
    // px) the clamp cannot fire, because rectification EXPANDS the footprint
    // while the window stays small and pinned to the mapped centre.  That is
    // why all four operator packs report 0, and it is what makes the
    // attitude-cancellation identity above unconditional in practice rather
    // than only in theory.  Asserted on the two gestures that would break it
    // if anything did: a walk, and a pivot past the old yaw limit.
    {
        const auto cfg = testConfig();
        ProjSweepSpec walk;  walk.n = 90; walk.dy = 6.0;
        ProjSweepSpec pivot; pivot.n = 90; pivot.pitchDeg = -45.0;
        SweepResult a = runProjectedSweep(shelf, walk, cfg);
        SweepResult b = runProjectedSweep(shelf, pivot, cfg);
        EXPECT_GT(a.stats.painted, 10);
        EXPECT_GT(b.stats.painted, 10);
        EXPECT_GT(b.stats.maxRectifyDeg, 30.0) << "pivot fixture is inert";
        EXPECT_EQ(a.stats.corrOriginClampedFrames, 0);
        EXPECT_EQ(b.stats.corrOriginClampedFrames, 0)
            << "a 45° pivot clamped at the shipped window size — the regime "
               "the identity covers is narrower than the packs said";
    }

    // ── NON-VACUITY.  The counter must be wired to the clamp, not hard-zero.
    // The clamp is reachable: widen the window until it is the whole work
    // raster (phaseWindowPx is capped at the raster, so 1600 ⇒ 720×540) and a
    // wide pivot pushes the mapped centre near enough to the footprint edge
    // that the origin has to be pulled back.  A test whose only arm is an
    // EXPECT_EQ(…, 0) would pass just as well against `return 0;`.
    {
        auto cfg = testConfig();
        cfg.phaseWindowPx = 1600;
        ProjSweepSpec pivot; pivot.n = 90; pivot.pitchDeg = -30.0;
        SweepResult c = runProjectedSweep(shelf, pivot, cfg);
        EXPECT_EQ(c.stats.corrWindowW, 720);
        EXPECT_GT(c.stats.painted, 10);
        EXPECT_GT(c.stats.corrOriginClampedFrames, 0)
            << "the counter is not wired to the clamp";
        EXPECT_LE(c.stats.corrOriginClampedFrames, (int64_t)c.stats.painted + 8)
            << "more clamped frames than the chain ever accepted";
    }
}

// ── THE TWO DOCUMENTED SEMANTICS OF THAT COUNTER, PINNED ───────────────────
//
// A reviewer of the round that added `corrOriginClampedFrames` demonstrated
// that BOTH of its documented behaviours were unpinned: deleting the re-base
// in reseedReferenceTo(), and moving the increment from the accept path to the
// clamp site, each left the whole suite green.  A counter whose contract no
// test can break is a comment, not a contract.  These two tests are the
// contract.  They are DIAGNOSTIC-only assertions — no pixel depends on them —
// but the number is quoted as evidence for the attitude-cancellation identity's
// regime, so what it counts has to stay what the header says it counts.
//
// (1) COUNTED ON ACCEPTED FRAMES ONLY.
//
// The clamp is evaluated BEFORE the response gate, so a frame can clamp and
// then be rejected.  Counting those would overstate how much of the sweep ran
// outside the identity's regime — a frame that never reached the chain never
// placed anything, correctly or otherwise.
//
// The fixture makes every clamping frame a rejected one.  Measured on this
// sweep: the clamp fires on seq 2-7 and nowhere else, because rectification
// EXPANDS the rectified footprint as the pivot proceeds while the window stays
// the whole work raster — so the origin only has to be pulled back in the
// first frames after the reference latch, not the last.  Blanking seq 3-9
// therefore rejects five of the six clamping frames while leaving the
// reference frame itself (seq 2) intact, and leaving 80 good frames after the
// run for the chain to recover on (maxRejectRunFrames is 60).
TEST(PanoStats, TheOriginClampCountsOnlyFramesThatReachedTheChain) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    auto cfg = testConfig();
    cfg.phaseWindowPx = 1600;             // ⇒ 720×540, the whole work raster

    // Same geometry both arms; the second replaces some frames' PIXELS with
    // flat grey, which collapses the correlation response without touching the
    // attitude the clamp is computed from.
    auto run = [&](int blankLo, int blankHi) {
        rnis::pano::Engine eng;
        std::string err;
        EXPECT_TRUE(eng.configure(cfg, &err)) << err;
        SweepResult out;
        const int n = 90;
        for (int i = 0; i < n; ++i) {
            const double f = (double)i / (double)(n - 1);
            const Quat q = pitchQuat(-30.0 * f);
            cv::Mat crop = renderProjectedFrame(shelf, 1400.0, 1400.0, q);
            if (i >= blankLo && i <= blankHi) crop.setTo(cv::Scalar(128, 128, 128));
            cv::Mat gray, grayWork;
            cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
            cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                       cv::INTER_AREA);
            rnis::pano::FrameInput in;
            in.bgr = &crop;
            in.grayWork = &grayWork;
            in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
            in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
            in.imageWidth = kFrameW; in.imageHeight = kFrameH;
            for (int k = 0; k < 4; ++k) in.q[k] = q[k];
            in.t[0] = 1400.0 * (0.6 / kFx);
            in.t[1] = 1400.0 * (0.6 / kFy);
            in.tracking = 2;
            in.seq = (int64_t)i;
            out.rows.push_back(eng.ingest(in));
        }
        out.rows.push_back(eng.finish());
        eng.finalCanvas(out.canvas);
        out.stats = eng.stats();
        return out;
    };

    SweepResult all     = run(-1, -1);          // nothing blanked
    SweepResult blanked = run(3, 9);            // the clamping frames rejected

    // NON-VACUITY, both halves.  Without clamps there is nothing to count, and
    // without rejections the two arms are the same experiment.
    ASSERT_GT(all.stats.corrOriginClampedFrames, 0)
        << "fixture no longer clamps — the test asserts nothing";
    const int rejected =
        countOutcome(blanked, rnis::pano::Outcome::RejectedLowResponse);
    ASSERT_GE(rejected, 5)
        << "blanked frames were not rejected (" << rejected << ") — the test "
           "cannot tell accept-path counting from clamp-site counting";
    EXPECT_TRUE(blanked.stats.abortReason.empty()) << blanked.stats.abortReason;

    // THE PIN.  Rejecting the clamping frames must REDUCE the count.  Moving
    // the increment to the clamp site makes the two arms report the same
    // number, because the clamp does not care whether the frame was accepted.
    EXPECT_LT(blanked.stats.corrOriginClampedFrames,
              all.stats.corrOriginClampedFrames)
        << "rejecting " << rejected << " of the clamping frames left the count "
        << "at " << blanked.stats.corrOriginClampedFrames << " (clean arm: "
        << all.stats.corrOriginClampedFrames << ") — the counter is counting "
           "frames that never reached the chain";
}

TEST(PanoRegime, RotationFractionSeparatesAPivotFromAWalk) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();

    ProjSweepSpec pivot; pivot.n = 90; pivot.pitchDeg = -18.0;
    ProjSweepSpec walk;  walk.n = 90;  walk.dx = 14.0;

    SweepResult a = runProjectedSweep(shelf, pivot, cfg);
    SweepResult b = runProjectedSweep(shelf, walk, cfg);

    EXPECT_GT(a.stats.rotationFraction, 0.80)
        << "a pure pivot reported rotationFraction " << a.stats.rotationFraction;
    EXPECT_LT(b.stats.rotationFraction, 0.05)
        << "a pure walk reported rotationFraction " << b.stats.rotationFraction;
    // ...and both channel vectors are recorded, whichever way the sweep ran.
    // The latch votes on the TOTAL in both cases (the rotation channel does not
    // vote — see Config), so what the pack reader compares is the two vectors:
    // a pivot's rotation vector is large, a walk's is ~0.
    EXPECT_GT(std::max(std::fabs(a.stats.latchRotPx[0]),
                       std::fabs(a.stats.latchRotPx[1])), 8.0);
    EXPECT_LT(std::max(std::fabs(b.stats.latchRotPx[0]),
                       std::fabs(b.stats.latchRotPx[1])), 2.0);
    EXPECT_GT(a.stats.latchFramesUsed, 0);
}

// ── cv::phaseCorrelate consumes its inputs ─────────────────────────────────
//
// A GUARD, not a hypothesis.  phaseCorrelate multiplies BOTH inputs by the
// window IN PLACE whenever the array size needs no DFT padding, and the engine
// used to store that mutated buffer as its next reference — so every
// correlation after the first compared Hann²·prev against Hann¹·cur, and a
// HELD chain compounded another power of the window per rejected frame.  If a
// future OpenCV stops doing this, this test fails and the engine's defensive
// copy can be revisited; until then it documents WHY the copy is there.
TEST(PanoCorrelate, OpenCvPhaseCorrelateMutatesItsInputsInPlace) {
    const int w = 192, h = 144;
    ASSERT_EQ(cv::getOptimalDFTSize(w), w) << "fixture no longer hits the no-pad path";
    ASSERT_EQ(cv::getOptimalDFTSize(h), h);

    cv::Mat a(h, w, CV_32F, cv::Scalar(100.0));
    cv::Mat b(h, w, CV_32F, cv::Scalar(100.0));
    cv::Mat win;
    cv::createHanningWindow(win, cv::Size(w, h), CV_32F);
    cv::phaseCorrelate(a, b, win);
    EXPECT_LT(cv::mean(a)[0], 99.0)
        << "OpenCV no longer windows its inputs in place";
    EXPECT_LT(cv::mean(b)[0], 99.0);

    // A size that DOES need padding is left alone — which is why this bug
    // could hide: it is invisible at any window OpenCV has to copy.
    cv::Mat c(h - 1, w - 2, CV_32F, cv::Scalar(100.0));
    cv::Mat d(h - 1, w - 2, CV_32F, cv::Scalar(100.0));
    cv::Mat win2;
    cv::createHanningWindow(win2, cv::Size(w - 2, h - 1), CV_32F);
    cv::phaseCorrelate(c, d, win2);
    EXPECT_NEAR(cv::mean(c)[0], 100.0, 1e-6);
}

// The engine's own consequence of the above: a clean sweep must produce STRONG
// peaks.  Under the Hann² defect the same fixture's responses were roughly
// halved, and the stale-chain resume floor (Config::stallResumeResponse) was
// calibrated against those depressed numbers.
TEST(PanoCorrelate, ACleanSweepProducesStrongPeaks) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    const auto cfg = testConfig();
    ProjSweepSpec s;
    s.n = 90; s.dx = 14.0;
    SweepResult r = runProjectedSweep(shelf, s, cfg);

    std::vector<double> resp;
    for (const auto& row : r.rows) {
        if (row.response > 0.0) resp.push_back(row.response);
    }
    ASSERT_GT(resp.size(), 60u);
    std::sort(resp.begin(), resp.end());
    const double median = resp[resp.size() / 2];
    const double worst = resp.front();
    EXPECT_GT(median, 0.80) << "median phase response " << median;
    EXPECT_GT(worst, cfg.stallResumeResponse)
        << "weakest peak on a CLEAN sweep (" << worst << ") is below the "
           "stale-chain resume floor — the floor would gate honest frames";
}

// ── Perpendicular drift: growth, and honest reporting when growth is capped ─
//
// THE failure this pins: `canvasH` is fixed at the axis latch and
// `warpPerspective` discards everything outside it with no return value, no
// outcome and no abort — while `unpaintedRuns()` (which only looks ALONG the
// sweep) still reports zero holes.  A panorama missing half the shelf height
// must never be indistinguishable from a clean one.

TEST(PanoClip, GrowsTheBandInsteadOfSilentlyCroppingDrift) {
    const cv::Mat shelf = makeShelf(7000, 2200);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 200);
    spec.ys.reserve(spec.xs.size());
    // 800 source px of vertical hand drift over the sweep — 400 canvas px at
    // canvasScale 0.5, far outside the ±128 px default pad.
    for (size_t i = 0; i < spec.xs.size(); ++i)
        spec.ys.push_back(4.0 * (double)i);

    auto cfg = testConfig();
    SweepResult r = runSweepSpec(shelf, spec, cfg);

    EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;
    EXPECT_GT(r.stats.canvasHeightGrowths, 0) << "the band never grew";
    EXPECT_EQ(r.stats.clippedFrames, 0)
        << "content was still clipped after growth (max top "
        << r.stats.maxClipTopPx << " bottom " << r.stats.maxClipBotPx << ")";
    ASSERT_FALSE(r.canvas.empty());
    // The panorama is taller than one frame's band precisely BECAUSE the
    // drift was kept rather than cropped away.
    EXPECT_GT(r.canvas.rows, (int)(kFrameH * cfg.canvasScale) + 300);
}

TEST(PanoClip, ReportsClippingWhenGrowthIsRefused) {
    const cv::Mat shelf = makeShelf(7000, 2200);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 200);
    spec.ys.reserve(spec.xs.size());
    for (size_t i = 0; i < spec.xs.size(); ++i)
        spec.ys.push_back(4.0 * (double)i);

    auto cfg = testConfig();
    cfg.canvasGrowVertical = false;      // the old, silent behaviour
    SweepResult r = runSweepSpec(shelf, spec, cfg);

    ASSERT_FALSE(r.canvas.empty());
    EXPECT_GT(r.stats.clippedFrames, 20) << "truncation went unreported";
    EXPECT_GT(r.stats.clippedColumns, 100);
    EXPECT_GT(r.stats.maxClipBotPx, 50.0);
    // And the point of the whole finding: the sweep-axis hole gate is CLEAN
    // while this is happening, so it cannot be the only integrity signal.
    EXPECT_TRUE(r.holes.empty());
    int clippedRows = 0;
    for (const auto& row : r.rows) if (row.clipped) ++clippedRows;
    EXPECT_GT(clippedRows, 20) << "per-frame ledger did not record the clip";
}

TEST(PanoClip, HeightGrowthIsBoundedByTheAreaBudget) {
    const cv::Mat shelf = makeShelf(7000, 2200);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 200);
    spec.ys.reserve(spec.xs.size());
    for (size_t i = 0; i < spec.xs.size(); ++i)
        spec.ys.push_back(4.0 * (double)i);

    auto cfg = testConfig();
    // Just above the latched band (540 + 2×128 = 796) and well below what
    // 400 canvas px of drift needs, so growth starts and is then capped.
    cfg.canvasMaxHeightPx = 900;
    SweepResult r = runSweepSpec(shelf, spec, cfg);

    EXPECT_LE(r.stats.canvasH, 900) << "growth ignored canvasMaxHeightPx";
    EXPECT_GT(r.stats.canvasHeightGrowths, 0);
    // Growth was capped, so the residue is CLIPPED — and reported.
    EXPECT_GT(r.stats.clippedFrames, 0);
    EXPECT_GT(r.stats.maxClipTopPx + r.stats.maxClipBotPx, 10.0);
}

// ── Interior gaps along the sweep axis ─────────────────────────────────────
//
// SCOPE, STATED PLAINLY: the backfill (algorithm step 8) is DEFENCE IN DEPTH,
// not a hot path, and this suite could not construct a sweep that reaches it.
// The reason is an invariant worth pinning in its own right:
//
//   an interior gap needs   du > footprintU/2
//   the cage is clamped to  0.40 × winW ÷ workScale × canvasScale
//   and winW saturates at   imgW × workScale
//   ⇒ cage ≤ 0.40 × imgW × canvasScale = 0.40 × footprintU   (horizontal sweep)
//
// 0.40 < 0.50, so no ACCEPTED frame can open a gap: an advance large enough
// to try is rejected by the cage first, and a rejected frame does not advance
// the chain.  (A vertical sweep's footprintU is the frame HEIGHT while the
// cage still derives from the WIDTH, which narrows the margin but does not
// close it once the strip's own half-width is counted.)  The backfill exists
// so that a future widening of phaseWindowPx / canvasScale that breaks this
// inequality degrades into recovery instead of a hole.
TEST(PanoGap, TheClampedCageMakesInteriorGapsUnreachable) {
    auto cfg = testConfig();
    cfg.maxAdvanceFrac = 1.0;          // ask for the widest cage the API allows
    cfg.phaseWindowPx = 4000;          // and the widest correlation window

    const cv::Mat shelf = makeShelf(9000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 40);
    SweepResult r = runSweepSpec(shelf, spec, cfg);

    const double footprintU = (double)kFrameW * cfg.canvasScale;
    EXPECT_LT(r.stats.maxAdvancePxResolved, 0.5 * footprintU)
        << "the cage no longer guarantees gap-free painting — the backfill "
           "path is now live and needs its own coverage";
}

// The backfill must never make things WORSE, under a sweep violent enough to
// exercise every rejection path around it.
TEST(PanoGap, BackfillNeverIncreasesHolesUnderAViolentSweep) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    std::vector<double> xs;
    for (int i = 0; i < 120; ++i) {
        const double base = 200.0 + 20.0 * i;
        xs.push_back(i >= 60 ? base + 560.0 : base);   // a mid-sweep lurch
    }
    SweepSpec spec; spec.xs = xs;

    auto on = testConfig();
    auto off = testConfig();
    off.backfillGaps = false;

    SweepResult a = runSweepSpec(shelf, spec, on);
    SweepResult b = runSweepSpec(shelf, spec, off);

    int64_t holeColsA = 0, holeColsB = 0;
    for (const auto& h : a.holes) holeColsA += h.second - h.first;
    for (const auto& h : b.holes) holeColsB += h.second - h.first;
    EXPECT_LE(holeColsA, holeColsB);
    EXPECT_LE(a.stats.gapBreak, b.stats.gapBreak);
    EXPECT_EQ(holeColsA, 0);
}

// ── Vertical sweep ──────────────────────────────────────────────────────────

TEST(PanoAxis, VerticalSweepLatchesAxisOneAndTransposes) {
    // A vertical scene: sweep the crop window DOWN a tall shelf.
    cv::Mat tall = makeShelf(kFrameW, 5000);
    cv::Mat shelfT;
    cv::transpose(tall, shelfT);   // ground truth for the transposed compare

    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    for (int i = 0; i < 120; ++i) {
        const int y0 = 200 + 18 * i;
        cv::Mat crop = tall(cv::Rect(0, y0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = i;
        eng.ingest(in);
    }
    eng.finish();
    cv::Mat out;
    ASSERT_TRUE(eng.finalCanvas(out));
    const auto st = eng.stats();
    EXPECT_EQ(st.axis, 1);
    EXPECT_EQ(st.sweepSign, 1);
    EXPECT_TRUE(eng.unpaintedRuns().empty());
    // A vertical sweep produces a TALL canvas.
    EXPECT_GT(out.rows, out.cols);
}

// ── v14: THE UPRIGHT BAKE ───────────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS.  Operator, 2026-09-02: "the output image is sideways".
// Reproduced on his own packs from that day — the four `hold: "landscape"`
// sweeps come out upright and the one `hold: "portrait"` sweep comes out a
// quarter turn over, shelves running DOWN the image.  The cause was a MISSING
// step, not a wrong one: the whole pipeline is deliberately raster-referenced
// (rotating at ingest is the standing repo trap), and the raster -> world
// turn that both platforms deferred to "somewhere else" was never written
// anywhere.  `Config::outputRotationCwDeg` is that step.  These two tests pin
// the half of it that is provable off-device: that the bake is EXACTLY a
// quarter turn, and that every (hold x pan direction) pair lands world-upright.

// The bake must be a ROTATION and not a mirror, in the CLOCKWISE sense, and it
// must touch nothing else.  A mirror would read as "the shelf came out in
// reverse order" rather than as an orientation bug, which is a far more
// expensive thing to debug in the aisle — so the turn is pinned against
// `cv::rotate` EXACTLY, pixel for pixel, on all three non-zero cases.
TEST(PanoUpright, BakesTheExactQuarterTurnAndNothingElse) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    std::vector<double> xs;
    for (int i = 0; i < 80; ++i) xs.push_back(20.0 + 55.0 * i);

    const SweepResult r0 = runSweep(shelf, xs, {}, testConfig());
    ASSERT_FALSE(r0.canvas.empty());
    EXPECT_EQ(r0.stats.outputRotationCwDeg, 0) << "the default must stay 0";

    struct Case { int cw; int rotCode; };
    const Case cases[3] = {
        {90,  cv::ROTATE_90_CLOCKWISE},
        {180, cv::ROTATE_180},
        {270, cv::ROTATE_90_COUNTERCLOCKWISE},
    };
    for (const Case& c : cases) {
        auto cfg = testConfig();
        cfg.outputRotationCwDeg = c.cw;
        const SweepResult r = runSweep(shelf, xs, {}, cfg);
        ASSERT_FALSE(r.canvas.empty()) << "bake " << c.cw;

        // THE INGEST PATH IS UNTOUCHED.  The bake is a finalize-time step, so
        // every counter, every ledger row and the painted extent must be
        // identical to the unbaked run.  If this ever fails the bake has
        // leaked into the pipeline, which is the trap this design avoids.
        EXPECT_EQ(r.stats.painted, r0.stats.painted) << "bake " << c.cw;
        EXPECT_EQ(r.stats.paintedW, r0.stats.paintedW) << "bake " << c.cw;
        EXPECT_EQ(r.stats.paintedH, r0.stats.paintedH) << "bake " << c.cw;
        EXPECT_EQ(r.stats.axis, r0.stats.axis) << "bake " << c.cw;
        EXPECT_EQ(r.stats.sweepSign, r0.stats.sweepSign) << "bake " << c.cw;

        cv::Mat want;
        cv::rotate(r0.canvas, want, c.rotCode);
        ASSERT_EQ(r.canvas.rows, want.rows) << "bake " << c.cw;
        ASSERT_EQ(r.canvas.cols, want.cols) << "bake " << c.cw;
        cv::Mat diff;
        cv::absdiff(r.canvas, want, diff);
        EXPECT_EQ(cv::countNonZero(diff.reshape(1)), 0)
            << "bake " << c.cw << " is not the exact clockwise quarter turn "
               "(a mirrored bake passes the size check and fails here)";

        // stats() predicts the size the surface lays the review viewport out
        // from, one frame before the real canvas exists, so it has to turn too.
        EXPECT_EQ(r.stats.outputRotationCwDeg, c.cw);
        if (c.cw == 180) {
            EXPECT_EQ(r.stats.outputW, r0.stats.outputW);
            EXPECT_EQ(r.stats.outputH, r0.stats.outputH);
        } else {
            EXPECT_EQ(r.stats.outputW, r0.stats.outputH) << "bake " << c.cw;
            EXPECT_EQ(r.stats.outputH, r0.stats.outputW) << "bake " << c.cw;
        }
    }

    // Quarter turns only.  A 45 would resample the whole deliverable and cost
    // sharpness silently; it is refused by name at configure time instead.
    rnis::pano::Engine eng;
    auto bad = testConfig();
    bad.outputRotationCwDeg = 45;
    std::string err;
    EXPECT_FALSE(eng.configure(bad, &err));
    EXPECT_NE(err.find("outputRotationCwDeg"), std::string::npos) << err;
}

// THE PREVIEW IS DELIBERATELY *NOT* BAKED, and that is load-bearing rather
// than an omission.
//
// `preview.jpg` is drawn on a screen bolted to the same body as the sensor, and
// the SDK already turns it: `panoPlusImageRotationDeg - panoPlusChromeRotationDeg`
// == `90 - deviceRotationCw` == THIS ANGLE, identically, on a portrait-locked
// host and on an unlocked one.  Baking here as well would double-turn every
// live preview.  So the deliverable and the preview leave the engine in
// DIFFERENT frames on purpose, and this pins it — if a later change moves the
// bake into `orient()`, this test fails and the SDK's rotation must move with
// it.  (The identity itself is asserted on the TS side, in panoPlusModel's
// suite; neither half can drift without one of the two suites going red.)
TEST(PanoUpright, TheLivePreviewStaysInTheRasterFrame) {
    const cv::Mat shelf = makeShelf(4000, kFrameH);

    auto run = [&](int bakeCw, cv::Size* preview, cv::Size* final_) {
        rnis::pano::Engine eng;
        auto cfg = testConfig();
        cfg.outputRotationCwDeg = bakeCw;
        std::string err;
        ASSERT_TRUE(eng.configure(cfg, &err)) << err;
        for (int i = 0; i < 40; ++i) {
            const int x0 = 20 + 55 * i;
            cv::Mat crop = shelf(cv::Rect(x0, 0, kFrameW, kFrameH)).clone();
            cv::Mat gray, grayWork;
            cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
            cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                       cv::INTER_AREA);
            rnis::pano::FrameInput in;
            in.bgr = &crop; in.grayWork = &grayWork;
            in.tsNs = 1e9 + i * (1e9 / 30.0);
            in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
            in.imageWidth = kFrameW; in.imageHeight = kFrameH;
            in.t[0] = x0 * (0.6 / kFx);
            in.tracking = 2;
            in.seq = i;
            eng.ingest(in);
        }
        cv::Mat pv;
        ASSERT_TRUE(eng.previewIntoFit(pv, 2000, 800, 0, nullptr));
        *preview = pv.size();
        eng.finish();
        cv::Mat fin;
        ASSERT_TRUE(eng.finalCanvas(fin));
        *final_ = fin.size();
    };

    cv::Size pv0, fin0, pv90, fin90;
    run(0, &pv0, &fin0);
    run(90, &pv90, &fin90);

    EXPECT_EQ(pv0, pv90)
        << "the live preview must stay in the camera raster frame — the SDK "
           "turns it on screen, and baking here would double-turn it";
    EXPECT_EQ(fin90.width, fin0.height);
    EXPECT_EQ(fin90.height, fin0.width);
}

// EVERY (HOLD x PAN DIRECTION) PAIR LANDS WORLD-UPRIGHT.
//
// The synthetic is anchored to the WORLD, not to the raster: a shelf carrying a
// monotone top-to-bottom brightness gradient, so "which way is world up" is a
// measurable property of any output crop rather than a claim about a marker
// that might be off-frame.  For each hold the RASTER is that world scene turned
// by the inverse of the hold's bake — which is exactly what a phone does when
// you turn it, since the sensor turns with the body and the scene rotates
// inside the raster.  Then each hold is swept BOTH ways (along raster X and
// along raster Y), because pan direction is the second half of the operator's
// report and a bake that only worked for one gesture would be no fix at all.
//
// Two things are asserted per cell:
//   1. world up is UP — the output's top third is brighter than its bottom
//      third, over painted pixels only;
//   2. the output's LONG axis is the direction the operator actually panned in
//      the world — the "what the canvas SHOULD be" table, which is what makes a
//      landscape top-to-bottom sweep a TALL panorama and a portrait
//      left-to-right sweep a WIDE one.
TEST(PanoUpright, EveryHoldAndPanDirectionLandsWorldUpright) {
    // Square, so a quarter turn is size-preserving and the two sweep
    // directions get the same room.
    const int kWorld = 4200;
    cv::Mat world = makeShelf(kWorld, kWorld);
    // WORLD UP IS BRIGHT.  0.45 at the bottom to 1.0 at the top: a ~14% mean
    // separation across the ~1080-row band one sweep covers, which is an order
    // of magnitude more than the texture's contribution to a third-image mean.
    for (int y = 0; y < kWorld; ++y) {
        const double g = 1.0 - 0.55 * ((double)y / (double)(kWorld - 1));
        world.row(y) *= g;
    }

    // Mean luminance over PAINTED pixels only.  The canvas pads its cross axis
    // and the tail is ragged, so an unmasked mean would be measuring how much
    // black each third happens to carry.
    auto paintedMean = [](const cv::Mat& bgr) {
        cv::Mat gray;
        cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
        double sum = 0.0;
        long long n = 0;
        for (int y = 0; y < gray.rows; ++y) {
            const uchar* row = gray.ptr<uchar>(y);
            for (int x = 0; x < gray.cols; ++x) {
                if (row[x] > 5) { sum += row[x]; ++n; }
            }
        }
        return n > 0 ? sum / (double)n : 0.0;
    };

    struct Hold { const char* name; int bakeCw; int rasterToWorld; };
    // `rasterToWorld` turns the WORLD scene into the raster this hold sees —
    // the inverse of the bake, which is the whole point.
    const Hold holds[4] = {
        {"landscape-left",       0,   -1},
        {"portrait",            90,   cv::ROTATE_90_COUNTERCLOCKWISE},
        {"landscape-right",    180,   cv::ROTATE_180},
        {"portrait-upside-down", 270, cv::ROTATE_90_CLOCKWISE},
    };

    for (const Hold& h : holds) {
        cv::Mat raster;
        if (h.rasterToWorld < 0) raster = world;
        else cv::rotate(world, raster, h.rasterToWorld);

        for (int alongY = 0; alongY < 2; ++alongY) {
            SweepSpec spec;
            for (int i = 0; i < 60; ++i) {
                const double d = 20.0 + 40.0 * i;
                spec.xs.push_back(alongY ? 20.0 : d);
                spec.ys.push_back(alongY ? d : 20.0);
            }
            auto cfg = testConfig();
            cfg.outputRotationCwDeg = h.bakeCw;
            const SweepResult r = runSweepSpec(raster, spec, cfg);

            const std::string where =
                std::string(h.name) + (alongY ? " / pan along raster Y"
                                              : " / pan along raster X");
            ASSERT_FALSE(r.canvas.empty()) << where;
            ASSERT_TRUE(r.stats.axisLatched) << where;

            // 1. WORLD UP IS UP.
            const int third = std::max(1, r.canvas.rows / 3);
            const double top =
                paintedMean(r.canvas(cv::Rect(0, 0, r.canvas.cols, third)));
            const double bot = paintedMean(
                r.canvas(cv::Rect(0, r.canvas.rows - third, r.canvas.cols, third)));
            EXPECT_GT(top, bot * 1.03)
                << where << ": world-up did not land at the top of the "
                << "deliverable (top " << top << " DN, bottom " << bot << " DN)";

            // 2. THE LONG AXIS IS THE WORLD PAN DIRECTION.  A quarter-turn
            // hold transposes which raster axis the operator's world-horizontal
            // gesture runs along, so the expected shape flips with the bake —
            // this is the "what the canvas SHOULD be" table, executed.
            const bool quarter = (h.bakeCw == 90 || h.bakeCw == 270);
            const bool wantWide = quarter ? (alongY != 0) : (alongY == 0);
            if (wantWide) {
                EXPECT_GT(r.canvas.cols, r.canvas.rows) << where;
            } else {
                EXPECT_GT(r.canvas.rows, r.canvas.cols) << where;
            }
        }
    }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

// A single `.limited` frame used to END the sweep.  ARKit reports
// `.limited(.excessiveMotion)` routinely during exactly the deliberate pan
// pano+ asks for, and `.limited(.relocalizing)` after any brief occlusion —
// neither invalidates the gyro-driven attitude the engine consumes, and the
// real relocalisation risk is caught by the translation-jump test instead.
// This pins that a blink is COUNTED, not fatal.
TEST(PanoSession, LimitedTrackingIsCountedNotFatal) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 80);
    spec.tracking.assign(spec.xs.size(), 2);
    spec.tracking[60] = 1;
    spec.tracking[61] = 1;

    SweepResult r = runSweepSpec(shelf, spec, testConfig());
    EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;
    EXPECT_EQ(r.stats.limitedFrames, 2);
    // The sweep kept painting AFTER the limited frames.
    int paintedAfter = 0;
    for (size_t i = 62; i < r.rows.size(); ++i)
        if (r.rows[i].outcome == rnis::pano::Outcome::Painted) ++paintedAfter;
    EXPECT_GT(paintedAfter, 10);
    EXPECT_TRUE(r.holes.empty());
}

TEST(PanoSession, AbortsOnLimitedTrackingOnlyWhenAskedTo) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    auto cfg = testConfig();
    cfg.abortOnLimitedTracking = true;
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 80);
    spec.tracking.assign(spec.xs.size(), 2);
    spec.tracking[60] = 1;

    SweepResult r = runSweepSpec(shelf, spec, cfg);
    EXPECT_EQ(r.stats.abortReason, "tracking-limited");
    EXPECT_FALSE(r.canvas.empty());          // painted content is KEPT
    EXPECT_GT(r.canvas.cols, 400);
}

// `notAvailable` is the case that really has no usable attitude: the chain is
// HELD (never advanced on a pose we do not believe) and the sweep survives a
// short outage — including the pose RE-SEED, without which the first good
// frame after the gap would read as a teleport and abort `session-restart`.
TEST(PanoSession, SurvivesAShortTrackingOutageAndHoldsTheChain) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 80);
    spec.tracking.assign(spec.xs.size(), 2);
    for (int i = 40; i < 48; ++i) spec.tracking[i] = 0;

    SweepResult r = runSweepSpec(shelf, spec, testConfig());
    EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;
    EXPECT_EQ(r.stats.rejectedTracking, 8);
    for (int i = 40; i < 48; ++i)
        EXPECT_EQ(r.rows[i].outcome, rnis::pano::Outcome::RejectedTracking)
            << "frame " << i;
    EXPECT_GT(r.stats.painted, 20);
}

TEST(PanoSession, AbortsWhenTrackingNeverComesBack) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    auto cfg = testConfig();
    cfg.maxRejectRunFrames = 10;
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 60);
    spec.tracking.assign(spec.xs.size(), 2);
    for (size_t i = 30; i < spec.xs.size(); ++i) spec.tracking[i] = 0;

    SweepResult r = runSweepSpec(shelf, spec, cfg);
    EXPECT_EQ(r.stats.abortReason, "tracking-lost");
    EXPECT_FALSE(r.canvas.empty());          // painted content is KEPT
}

TEST(PanoSession, AbortsOnATranslationDiscontinuity) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    cfg.maxTranslationJumpM = 0.05;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    for (int i = 0; i < 40; ++i) {
        const int x0 = 200 + 20 * i;
        cv::Mat crop = shelf(cv::Rect(x0, 0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        // ARKit relocalises to a NEW world origin at frame 25.
        in.t[0] = (i < 25) ? x0 * (0.6 / kFx) : (x0 * (0.6 / kFx) + 3.0);
        in.tracking = 2;
        in.seq = i;
        eng.ingest(in);
    }
    EXPECT_EQ(eng.stats().abortReason, "session-restart");
}

TEST(PanoSession, AbortsOnANonMonotonicTimestamp) {
    const cv::Mat shelf = makeShelf(4000, kFrameH);
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;
    cv::Mat crop = shelf(cv::Rect(0, 0, kFrameW, kFrameH)).clone();
    cv::Mat gray, grayWork;
    cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
    const rnis::pano::Config tcfg = testConfig();
    cv::resize(gray, grayWork, cv::Size(), tcfg.workScale, tcfg.workScale,
               cv::INTER_AREA);
    rnis::pano::FrameInput in;
    in.bgr = &crop; in.grayWork = &grayWork;
    in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
    in.imageWidth = kFrameW; in.imageHeight = kFrameH;
    in.tracking = 2;
    in.tsNs = 2e9; eng.ingest(in);
    in.tsNs = 1e9; in.seq = 1;
    EXPECT_EQ(eng.ingest(in).outcome, rnis::pano::Outcome::AbortedTracking);
    EXPECT_EQ(eng.stats().abortReason, "nonmonotonic-timestamp");
}

// ── Exposure ────────────────────────────────────────────────────────────────

TEST(PanoGain, ChainedGainStaysWithinTheCumulativeClamp) {
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    auto cfg = testConfig();
    cfg.gainCumClamp = 1.5;

    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    double worstLow = 1.0, worstHigh = 1.0;
    for (int i = 0; i < 150; ++i) {
        const int x0 = 300 + 20 * i;
        cv::Mat crop = shelf(cv::Rect(x0, 0, kFrameW, kFrameH)).clone();
        // A steadily darkening exposure ramp — the estimator must chase it,
        // bounded, and never run away.
        crop.convertTo(crop, CV_8UC3, 1.0 - 0.004 * i, 0.0);
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = x0 * (0.6 / kFx);
        in.tracking = 2;
        in.seq = i;
        const auto row = eng.ingest(in);
        worstLow = std::min(worstLow, row.gainCum);
        worstHigh = std::max(worstHigh, row.gainCum);
    }
    EXPECT_GE(worstLow, 1.0 / cfg.gainCumClamp - 1e-6);
    EXPECT_LE(worstHigh, cfg.gainCumClamp + 1e-6);
    EXPECT_GT(worstHigh, 1.02) << "the gain never chased the darkening ramp";
}

TEST(PanoGain, DisabledGainLeavesTheCumulativeGainAtUnity) {
    const cv::Mat shelf = makeShelf(5000, kFrameH);
    auto cfg = testConfig();
    cfg.gainMatch = false;
    SweepResult r = runSweep(shelf, linearSweep(200, 20, 80), {}, cfg);
    for (const auto& row : r.rows) EXPECT_DOUBLE_EQ(row.gainCum, 1.0);
}

// ── Preview + finalize ──────────────────────────────────────────────────────

TEST(PanoPreview, FitsTheRequestedBandAndMatchesTheFinalOrientation) {
    const cv::Mat shelf = makeShelf(8000, kFrameH);
    auto cfg = testConfig();
    SweepResult r = runSweep(shelf, linearSweep(200, 20, 180), {}, cfg);
    ASSERT_FALSE(r.canvas.empty());

    // Re-run to get a live engine we can ask for a preview mid-sweep.
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    const auto xs = linearSweep(200, 20, 180);
    for (size_t i = 0; i < xs.size(); ++i) {
        cv::Mat crop = shelf(cv::Rect((int)xs[i], 0, kFrameW, kFrameH)).clone();
        cv::Mat g, gw;
        cv::cvtColor(crop, g, cv::COLOR_BGR2GRAY);
        cv::resize(g, gw, cv::Size(), cfg.workScale, cfg.workScale, cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &gw;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = xs[i] * (0.6 / kFx);
        in.tracking = 2; in.seq = (int64_t)i;
        eng.ingest(in);
    }
    cv::Mat band;
    ASSERT_TRUE(eng.previewInto(band, 1400, 220));
    EXPECT_LE(band.cols, 1400);
    EXPECT_LE(band.rows, 220);
    EXPECT_GT(band.cols, band.rows);   // a horizontal sweep previews as a band
    // The preview is the same scene the final canvas shows, just smaller.
    cv::Mat finalC;
    eng.finish();
    ASSERT_TRUE(eng.finalCanvas(finalC));
    cv::Mat finalSmall;
    cv::resize(finalC, finalSmall, band.size(), 0, 0, cv::INTER_AREA);
    EXPECT_GT(bestNcc(band(cv::Rect(band.cols / 4, 0, band.cols / 3, band.rows)),
                      finalSmall),
              0.80);
}

// THE PREVIEW GEOMETRY BUG, pinned.
//
// Every one of the operator's four device packs is a VERTICAL sweep (axis 1,
// 1344x1471 output — he holds the phone in landscape and pans top to bottom).
// `previewInto`'s box is in ORIENTED output terms, and the shipped caller
// passed a LANDSCAPE box (1400x220): the fit then collapses to 220/1471 and
// hands back a ~200x220 thumbnail of a 1344-px-wide shelf, which is the
// "I do not see a live preview of the image growing" report of 2026-08-23.
//
// `previewIntoFit` takes the box in SWEEP terms and turns it with the axis, so
// the SAME numbers produce a tall preview for a tall panorama.  Both halves
// are asserted here — the old behaviour as the reason the new call exists.
TEST(PanoPreview, AxisAwareFitTurnsTheBoxWithAVerticalSweep) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    for (int i = 0; i < 120; ++i) {
        const int y0 = 200 + 18 * i;
        cv::Mat crop = tall(cv::Rect(0, y0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = i;
        eng.ingest(in);
    }
    ASSERT_EQ(eng.stats().axis, 1) << "this test is only meaningful on a vertical sweep";

    // The SHIPPED-BEFORE call with the SHIPPED-BEFORE numbers — the defect,
    // measured on this fixture.
    cv::Mat landscapeBox;
    ASSERT_TRUE(eng.previewInto(landscapeBox, 1400, 220));
    EXPECT_LE(landscapeBox.rows, 220)
        << "the oriented box caps the TALL axis at 220 — that IS the bug";

    // The SHIPPED-AFTER call: the box turns with the sweep AND the cross cap
    // is the one a near-square panorama actually needs.  These two numbers
    // mirror RNISPanoCore's `previewMaxAlong` / `previewMaxCross` defaults —
    // if they drift apart, this test is measuring something the device does
    // not do.
    constexpr int kMaxAlong = 1400;
    constexpr int kMaxCross = 360;
    cv::Mat fitted;
    ASSERT_TRUE(eng.previewIntoFit(fitted, kMaxAlong, kMaxCross));
    EXPECT_GT(fitted.rows, fitted.cols) << "a vertical sweep previews TALL";
    EXPECT_LE(fitted.cols, kMaxCross);   // cross axis
    EXPECT_LE(fitted.rows, kMaxAlong);   // sweep axis
    // THE NUMBER THE OPERATOR SEES: cross resolution is what carries the
    // shelf, and the old box crushed it below the new box's cap.
    EXPECT_GT(fitted.cols, landscapeBox.cols)
        << "landscapeBox " << landscapeBox.cols << "x" << landscapeBox.rows
        << "  fitted " << fitted.cols << "x" << fitted.rows;
    EXPECT_GT(fitted.rows * fitted.cols, 2 * landscapeBox.rows * landscapeBox.cols);

    // And it is a FAITHFUL view: the same aspect as the panorama it is a view
    // of, which is what lets the host size its on-screen box from the
    // preview's own pixel dims and have that box BE the panorama's shape.
    // Compared AFTER finish() on both sides — the tail flush legitimately
    // extends the canvas past the frontier the mid-sweep preview saw.
    eng.finish();
    cv::Mat fittedAfter, finalC;
    ASSERT_TRUE(eng.previewIntoFit(fittedAfter, kMaxAlong, kMaxCross));
    ASSERT_TRUE(eng.finalCanvas(finalC));
    const double aFinal = (double)finalC.cols / (double)finalC.rows;
    const double aPrev  = (double)fittedAfter.cols / (double)fittedAfter.rows;
    EXPECT_NEAR(aPrev, aFinal, 0.02 * aFinal);
}

// The horizontal case must be BYTE-IDENTICAL to the old call: a caller that
// swaps `previewInto(w,h)` for `previewIntoFit(along,cross)` on a horizontal
// sweep has changed nothing.
TEST(PanoPreview, AxisAwareFitIsTheOldCallOnAHorizontalSweep) {
    const cv::Mat shelf = makeShelf(8000, kFrameH);
    auto cfg = testConfig();
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    const auto xs = linearSweep(200, 20, 180);
    for (size_t i = 0; i < xs.size(); ++i) {
        cv::Mat crop = shelf(cv::Rect((int)xs[i], 0, kFrameW, kFrameH)).clone();
        cv::Mat g, gw;
        cv::cvtColor(crop, g, cv::COLOR_BGR2GRAY);
        cv::resize(g, gw, cv::Size(), cfg.workScale, cfg.workScale, cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &gw;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = xs[i] * (0.6 / kFx);
        in.tracking = 2; in.seq = (int64_t)i;
        eng.ingest(in);
    }
    ASSERT_EQ(eng.stats().axis, 0);
    cv::Mat a, b;
    ASSERT_TRUE(eng.previewInto(a, 1400, 220));
    ASSERT_TRUE(eng.previewIntoFit(b, 1400, 220));
    ASSERT_EQ(a.size(), b.size());
    EXPECT_EQ(cv::norm(a, b, cv::NORM_INF), 0.0);
}

// ── THE FRONTIER WINDOW ─────────────────────────────────────────────────────
//
// Why these exist, from the packs rather than from taste.  Replaying the
// operator's three 2026-08-29 pano+ sweeps through the SHIPPED layout
// (results/2026-08-30-panoplus-portrait/preview/) measured two things:
//
//   · the painted band's outer extent does not move for the first 2.4-2.9 s of
//     every sweep (40% / 30% / 33%), because `bootstrap` paints a whole 718 px
//     frame footprint and the strip commit then starts at the frame CENTRE,
//     half a footprint behind it.  `PreviewWindow::frontierFrac` is the thing
//     that IS moving in that window, published so the surface can show it.
//
//   · fitting the WHOLE band into a fixed panel shrinks without bound.  The
//     inked panel area peaks at along ≈ 2000 canvas px and then collapses:
//     114x374 pt at 3.9 m of shelf, 76x374 pt at 5.8 m.  A window caps it.
//
// The default (`windowAlongPx == 0`) must stay byte-identical, because that is
// what every pre-existing caller and every test above is asserting.

namespace {
/// A vertical sweep long enough that the band comfortably exceeds any window
/// under test.  `dir` +1 sweeps down the shelf, -1 sweeps up it (which is what
/// produces `sweepSign == -1`, and therefore the flipped frontier fraction).
void runVerticalSweep(rnis::pano::Engine& eng, const rnis::pano::Config& cfg,
                      const cv::Mat& tall, int frames, int dir) {
    const int span = 18 * (frames - 1);
    for (int i = 0; i < frames; ++i) {
        const int y0 = (dir >= 0) ? (200 + 18 * i) : (200 + span - 18 * i);
        cv::Mat crop = tall(cv::Rect(0, y0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = i;
        eng.ingest(in);
    }
}
}  // namespace

TEST(PanoPreviewWindow, ZeroWindowIsByteIdenticalToTheWholeBandAndReportsIt) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);
    ASSERT_EQ(eng.stats().axis, 1);

    cv::Mat plain, zeroed;
    rnis::pano::PreviewWindow win;
    ASSERT_TRUE(eng.previewIntoFit(plain, 2000, 800));
    ASSERT_TRUE(eng.previewIntoFit(zeroed, 2000, 800, 0, &win));
    ASSERT_EQ(plain.size(), zeroed.size());
    EXPECT_EQ(cv::norm(plain, zeroed, cv::NORM_INF), 0.0)
        << "windowAlongPx 0 is the pre-window path, byte for byte";
    EXPECT_FALSE(win.windowed);
    EXPECT_EQ(win.viewStartU, win.bandStartU);
    EXPECT_EQ(win.viewEndU, win.bandEndU);
    EXPECT_GT(win.bandEndU, win.bandStartU);
}

TEST(PanoPreviewWindow, AWindowLongerThanTheBandIsTheWholeBand) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);

    rnis::pano::PreviewWindow probe;
    cv::Mat whole;
    ASSERT_TRUE(eng.previewIntoFit(whole, 2000, 800, 0, &probe));
    const int band = probe.bandEndU - probe.bandStartU;
    ASSERT_GT(band, 0);

    cv::Mat wide;
    rnis::pano::PreviewWindow win;
    ASSERT_TRUE(eng.previewIntoFit(wide, 2000, 800, band + 500, &win));
    EXPECT_FALSE(win.windowed);
    ASSERT_EQ(whole.size(), wide.size());
    EXPECT_EQ(cv::norm(whole, wide, cv::NORM_INF), 0.0);
}

TEST(PanoPreviewWindow, AShortWindowIsTheLEADINGSliceOfTheSameBand) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);

    rnis::pano::PreviewWindow probe;
    cv::Mat whole;
    // 1:1 — no downscale — so the two views are directly comparable pixels.
    ASSERT_TRUE(eng.previewIntoFit(whole, 100000, 100000, 0, &probe));
    const int band = probe.bandEndU - probe.bandStartU;
    const int windowPx = band / 2;
    ASSERT_GT(windowPx, 32);

    cv::Mat view;
    rnis::pano::PreviewWindow win;
    ASSERT_TRUE(eng.previewIntoFit(view, 100000, 100000, windowPx, &win));
    EXPECT_TRUE(win.windowed);
    EXPECT_EQ(win.viewEndU, win.bandEndU) << "anchored on the LEADING edge";
    EXPECT_EQ(win.viewStartU, win.bandEndU - windowPx);
    // A vertical sweep with sweepSign +1 orients along the ROWS, and the
    // leading slice is the LAST `windowPx` rows of the whole view.
    ASSERT_EQ(view.cols, whole.cols);
    ASSERT_EQ(view.rows, windowPx);
    const cv::Mat tailOfWhole = whole(cv::Rect(0, whole.rows - windowPx,
                                               whole.cols, windowPx));
    EXPECT_EQ(cv::norm(view, tailOfWhole, cv::NORM_INF), 0.0)
        << "the window must be a VIEW of the panorama, not a re-render of it";
}

TEST(PanoPreviewWindow, TheWindowCapsTheAlongExtentTheGrowingPanoramaLosesTo) {
    // The measured complaint, as an invariant: without a window the along
    // extent grows with the sweep (and the on-screen scale falls with it);
    // with one it stops at the cap.
    cv::Mat tall = makeShelf(kFrameW, 5000);
    auto cfg = testConfig();
    std::string err;

    const int kWindow = 400;
    int wholeShort = 0, wholeLong = 0, winShort = 0, winLong = 0;
    {
        rnis::pano::Engine eng;
        ASSERT_TRUE(eng.configure(cfg, &err)) << err;
        runVerticalSweep(eng, cfg, tall, 60, +1);
        cv::Mat a, b;
        ASSERT_TRUE(eng.previewIntoFit(a, 100000, 100000, 0, nullptr));
        ASSERT_TRUE(eng.previewIntoFit(b, 100000, 100000, kWindow, nullptr));
        wholeShort = a.rows; winShort = b.rows;
    }
    {
        rnis::pano::Engine eng;
        ASSERT_TRUE(eng.configure(cfg, &err)) << err;
        runVerticalSweep(eng, cfg, tall, 180, +1);
        cv::Mat a, b;
        ASSERT_TRUE(eng.previewIntoFit(a, 100000, 100000, 0, nullptr));
        ASSERT_TRUE(eng.previewIntoFit(b, 100000, 100000, kWindow, nullptr));
        wholeLong = a.rows; winLong = b.rows;
    }
    EXPECT_GT(wholeLong, wholeShort + 200)
        << "the fixture must actually grow, or this test proves nothing";
    EXPECT_EQ(winLong, kWindow);
    EXPECT_EQ(winShort, kWindow);
}

TEST(PanoPreviewWindow, TheFrontierFractionLandsInsideTheViewAndAdvances) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    // Sample the fraction as the sweep runs, on the WHOLE band (window 0), so
    // this is the number the opening-stall marker will be drawn from.
    std::vector<double> fracs;
    const int span = 18 * 119;
    for (int i = 0; i < 120; ++i) {
        const int y0 = 200 + 18 * i;
        cv::Mat crop = tall(cv::Rect(0, y0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2; in.seq = i;
        eng.ingest(in);
        cv::Mat out;
        rnis::pano::PreviewWindow win;
        if (eng.previewIntoFit(out, 2000, 800, 0, &win) && win.frontierFrac >= 0.0) {
            fracs.push_back(win.frontierFrac);
        }
    }
    (void)span;
    ASSERT_GT(fracs.size(), 20u);
    for (double f : fracs) {
        EXPECT_GE(f, 0.0);
        EXPECT_LE(f, 1.0);
    }
    // THE POINT: it moves even while the band's extent does not.  On the
    // device packs that window is 2.4-2.9 s long; on this fixture it is the
    // bootstrap footprint, and the fraction has to climb through it.
    EXPECT_GT(fracs.back(), fracs.front())
        << "front " << fracs.front() << " back " << fracs.back();
}

TEST(PanoPreviewWindow, TheFrontierFractionFlipsWithTheSweepSign) {
    // `orient` mirrors the along axis for a negative sweep sign.  A fraction
    // that did not mirror with it would put the marker at the WRONG END on
    // half the holds — the same class of error as the 154x100 pt panel.
    cv::Mat tall = makeShelf(kFrameW, 5000);
    auto cfg = testConfig();
    std::string err;

    rnis::pano::Engine down;
    ASSERT_TRUE(down.configure(cfg, &err)) << err;
    runVerticalSweep(down, cfg, tall, 120, +1);

    rnis::pano::Engine up;
    ASSERT_TRUE(up.configure(cfg, &err)) << err;
    runVerticalSweep(up, cfg, tall, 120, -1);

    ASSERT_EQ(down.stats().sweepSign, 1);
    ASSERT_EQ(up.stats().sweepSign, -1)
        << "the reversed fixture must actually latch a negative sign";

    cv::Mat o;
    rnis::pano::PreviewWindow wd, wu;
    ASSERT_TRUE(down.previewIntoFit(o, 2000, 800, 0, &wd));
    ASSERT_TRUE(up.previewIntoFit(o, 2000, 800, 0, &wu));
    ASSERT_GE(wd.frontierFrac, 0.0);
    ASSERT_GE(wu.frontierFrac, 0.0);
    // Both sweeps end with the frontier at the LEADING edge of the band, which
    // after orienting is the FAR end of the image either way.
    EXPECT_NEAR(wd.frontierFrac, 1.0, 0.05);
    EXPECT_NEAR(wu.frontierFrac, 0.0, 0.05)
        << "a negative sweep sign mirrors the along axis, so the same physical "
           "frontier reports the OTHER end of the image";
}

// ── v13: the jog guard ────────────────────────────────────────────────
//
// The injection is surgical, and it reproduces the FIELD defect class rather
// than a generic corruption: `in.bgr` is a crop displaced along the CROSS
// axis while `in.grayWork` stays clean, so the placement chain (which reads
// grayWork) runs smooth — exactly the 2026-08-31 packs, where 92/110 px cuts
// were committed while the ledger read 1.1 px/frame.  The painted pixels
// disagree with the canvas; the pose never knew.
//
// DOSE NOTE: `shiftPx` is SOURCE px; the seam jog is measured in CANVAS px
// and canvasScale (~0.63) shrinks it — a 12 px injection measured 6.0 canvas
// px and sat under the 8 px bar on the first run of this suite.  20 source
// px ≈ 12-13 canvas px, comfortably over the bar without tripping any cage.
namespace {
std::vector<rnis::pano::FrameOutcome> runVerticalSweepShifted(
    rnis::pano::Engine& eng, const rnis::pano::Config& cfg, const cv::Mat& tall,
    int frames, int shiftFrom, int shiftTo, int shiftPx) {
    std::vector<rnis::pano::FrameOutcome> rows;
    for (int i = 0; i < frames; ++i) {
        const int y0 = 200 + 18 * i;
        const int dx = (i >= shiftFrom && i < shiftTo) ? shiftPx : 0;
        cv::Mat crop = tall(cv::Rect(32 + dx, y0, kFrameW, kFrameH)).clone();
        cv::Mat clean = tall(cv::Rect(32, y0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(clean, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = i;
        rows.push_back(eng.ingest(in));
    }
    return rows;
}
}  // namespace

TEST(PanoJogGuard, OffPaintsTheCutOnRefusesItAndTheNextStripCovers) {
    cv::Mat tall = makeShelf(kFrameW + 64, 5000);

    // Guard OFF: the misplaced strip is painted, and the ledger's own jog
    // measurement sees the cut (this is the failing-first half — the defect
    // must exist before the guard can be credited with removing it).
    rnis::pano::Engine off;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(off.configure(cfg, &err)) << err;
    auto rowsOff = runVerticalSweepShifted(off, cfg, tall, 120, 60, 61, 20);
    double worstOff = 0.0;
    for (const auto& r : rowsOff)
        if (r.outcome == rnis::pano::Outcome::Painted && r.seamCanvasJogValid)
            worstOff = std::max(worstOff, r.seamCanvasJogPx);
    ASSERT_GT(worstOff, 8.0)
        << "the injected cross-shift must register as a committed cut with "
           "the guard off, or this test proves nothing";
    EXPECT_EQ(off.stats().d8JogRefusals, 0);

    // Guard ON: the same frame is REFUSED (its own outcome, its evidence on
    // the row), nothing is forced, and no coverage is lost — the next
    // well-placed strip paints the span.
    rnis::pano::Engine on;
    auto cfgOn = testConfig();
    cfgOn.d8JogGuard = true;
    ASSERT_TRUE(on.configure(cfgOn, &err)) << err;
    auto rowsOn = runVerticalSweepShifted(on, cfgOn, tall, 120, 60, 61, 20);
    int held = 0;
    for (const auto& r : rowsOn)
        if (r.outcome == rnis::pano::Outcome::JogHeld) {
            ++held;
            EXPECT_TRUE(r.seamCanvasJogValid);
            EXPECT_GT(r.seamCanvasJogPx, 8.0)
                << "the refusal row must carry the measured jog";
        }
    EXPECT_EQ(held, 1);
    EXPECT_EQ(on.stats().d8JogRefusals, 1);
    EXPECT_EQ(on.stats().d8JogForced, 0);
    (void)on.finish();
    EXPECT_TRUE(on.unpaintedRuns().empty())
        << "a refusal must cost zero coverage — the next strip covers";
    double worstOn = 0.0;
    for (const auto& r : rowsOn)
        if (r.outcome == rnis::pano::Outcome::Painted && r.seamCanvasJogValid)
            worstOn = std::max(worstOn, r.seamCanvasJogPx);
    EXPECT_LT(worstOn, worstOff)
        << "the committed cut must not survive into the guarded canvas";
}

TEST(PanoJogGuard, CleanSweepIsByteIdenticalWithTheGuardArmed) {
    cv::Mat tall = makeShelf(kFrameW + 64, 5000);
    rnis::pano::Engine off, on;
    auto cfg = testConfig();
    auto cfgOn = testConfig();
    cfgOn.d8JogGuard = true;
    std::string err;
    ASSERT_TRUE(off.configure(cfg, &err)) << err;
    ASSERT_TRUE(on.configure(cfgOn, &err)) << err;
    runVerticalSweepShifted(off, cfg, tall, 100, 0, 0, 0);
    runVerticalSweepShifted(on, cfgOn, tall, 100, 0, 0, 0);
    (void)off.finish(); (void)on.finish();
    cv::Mat a, b;
    ASSERT_TRUE(off.finalCanvas(a));
    ASSERT_TRUE(on.finalCanvas(b));
    ASSERT_EQ(a.size(), b.size());
    EXPECT_EQ(cv::norm(a, b, cv::NORM_INF), 0.0)
        << "an armed guard that never fires must not move a byte";
    EXPECT_EQ(on.stats().d8JogRefusals, 0);
}

TEST(PanoJogGuard, PersistentDivergenceIsForcedAfterTheRunCapNeverStalled) {
    cv::Mat tall = makeShelf(kFrameW + 64, 5000);
    rnis::pano::Engine on;
    auto cfg = testConfig();
    cfg.d8JogGuard = true;
    cfg.d8JogMaxRun = 3;
    std::string err;
    ASSERT_TRUE(on.configure(cfg, &err)) << err;
    // Frames 60..120 ALL shifted: a persistent divergence, not a glitch.
    auto rows = runVerticalSweepShifted(on, cfg, tall, 120, 60, 120, 20);
    const auto st = on.stats();
    EXPECT_EQ(st.d8JogRefusals, 3) << "exactly the run cap, then acceptance";
    EXPECT_GE(st.d8JogForced, 1);
    // After the forced accept the shifted content IS the canvas, so the next
    // shifted strip agrees with it and the guard goes quiet — the run
    // counter must have reset rather than refusing forever.
    int heldTail = 0;
    for (size_t i = 70; i < rows.size(); ++i)
        if (rows[i].outcome == rnis::pano::Outcome::JogHeld) ++heldTail;
    EXPECT_EQ(heldTail, 0);
    (void)on.finish();
    EXPECT_TRUE(on.unpaintedRuns().empty());
}

TEST(PanoJogGuard, FiresIdenticallyWithAndWithoutTheGainFit) {
    // The doc's ordering pin: the guard measures BEFORE the gain fit, and
    // phase correlation is normalised by cross-power magnitude — so the
    // pending photometric scale cannot move the refusal decision.
    cv::Mat tall = makeShelf(kFrameW + 64, 5000);
    std::string err;
    for (bool gain : {true, false}) {
        rnis::pano::Engine e;
        auto cfg = testConfig();
        cfg.d8JogGuard = true;
        cfg.gainMatch = gain;
        ASSERT_TRUE(e.configure(cfg, &err)) << err;
        runVerticalSweepShifted(e, cfg, tall, 120, 60, 61, 20);
        EXPECT_EQ(e.stats().d8JogRefusals, 1)
            << "gainMatch=" << gain
            << " — the refusal decision must be photometry-invariant";
    }
}

TEST(PanoJogGuard, RefusesToArmBlindWithoutSeamMetrics) {
    rnis::pano::Engine e;
    auto cfg = testConfig();
    cfg.d8JogGuard = true;
    cfg.seamMetrics = false;
    std::string err;
    EXPECT_FALSE(e.configure(cfg, &err))
        << "metrics off makes the jog measurement silently invalid — the "
           "guard would be a no-op that LOOKS armed";
}

// ── the low-light registration gate (2026-09-07), step 1 ──────────────────
//
// STEP 1 IS THE INSTRUMENT, NOT THE GATE.  `crossResidualGate = 1` computes
// the texture / peak-shape / periodicity statistics on the centre window and
// ledgers them beside the residual; it moves nothing.  What these tests pin:
// the knob ships OFF and OFF is byte-identical; log-only writes a finite
// statistic on every painted row; log-only leaves every placement number the
// shipped chain produced exactly where it was.  The thresholds are chosen
// from the log-only corpus pass, so no test here asserts a threshold.
//
// RED, observed 2026-09-07 (before the knob existed): the suite did not
// compile — `crossResidualGate` is not a member of `rnis::pano::Config`.

TEST(PanoCrossGate, OffWritesNoNewFieldAndMatchesTheShippedCanvas) {
    cv::Mat tall = makeShelf(kFrameW + 64, 5000);
    rnis::pano::Engine off, log;
    auto cfg = testConfig();
    EXPECT_EQ(cfg.crossResidualGate, 0) << "the gate ships OFF";
    EXPECT_EQ(cfg.crossPeriodGuard, 0);
    EXPECT_DOUBLE_EQ(cfg.crossTextureMinVar, 0.0);
    EXPECT_DOUBLE_EQ(cfg.crossPeakMinPSR, 0.0);
    EXPECT_DOUBLE_EQ(cfg.crossPeakMinMass, 0.0);
    EXPECT_DOUBLE_EQ(cfg.crossPeriodMaxFrac, 0.0);
    EXPECT_DOUBLE_EQ(cfg.crossPeakSecondaryFrac, 0.0);
    auto cfgLog = testConfig();
    cfgLog.crossResidualGate = 1;
    std::string err;
    ASSERT_TRUE(off.configure(cfg, &err)) << err;
    ASSERT_TRUE(log.configure(cfgLog, &err)) << err;
    const auto rowsOff = runVerticalSweepShifted(off, cfg, tall, 100, 0, 0, 0);
    const auto rowsLog = runVerticalSweepShifted(log, cfgLog, tall, 100, 0, 0, 0);
    (void)off.finish(); (void)log.finish();

    // The deliverable: byte for byte.
    cv::Mat a, b;
    ASSERT_TRUE(off.finalCanvas(a));
    ASSERT_TRUE(log.finalCanvas(b));
    ASSERT_EQ(a.size(), b.size());
    EXPECT_EQ(cv::norm(a, b, cv::NORM_INF), 0.0)
        << "log-only computes statistics; it must not move a byte";

    // The chain: the same outcome and the same position on every row.
    ASSERT_EQ(rowsOff.size(), rowsLog.size());
    for (size_t i = 0; i < rowsOff.size(); ++i) {
        EXPECT_EQ(rowsOff[i].outcome, rowsLog[i].outcome) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].posU, rowsLog[i].posU) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].posV, rowsLog[i].posV) << "row " << i;
    }
    // OFF carries no statistic — every new field is its default, and the
    // row says the block was never computed (which is what the ledger
    // writer keys on to leave the row textually identical to v15).
    for (const auto& r : rowsOff) {
        EXPECT_FALSE(r.crossStatsComputed);
        EXPECT_EQ(r.crossGated, 0);
        EXPECT_DOUBLE_EQ(r.crossTextureVar, 0.0);
        EXPECT_DOUBLE_EQ(r.crossPeakPSR, 0.0);
        EXPECT_DOUBLE_EQ(r.crossPeakMass, 0.0);
        EXPECT_DOUBLE_EQ(r.crossDominantPeriodPx, 0.0);
        EXPECT_DOUBLE_EQ(r.crossPeakSecondary, 0.0);
        EXPECT_DOUBLE_EQ(r.crossResidualRawPx, 0.0);
    }
    EXPECT_EQ(off.stats().crossGatedTexture, 0);
    EXPECT_EQ(off.stats().crossGatedPeak, 0);
    EXPECT_EQ(off.stats().crossGatedPeriod, 0);
}

TEST(PanoCrossGate, LogOnlyWritesFiniteStatsOnEveryPaintedRow) {
    cv::Mat tall = makeShelf(kFrameW + 64, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    cfg.crossResidualGate = 1;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    const auto rows = runVerticalSweepShifted(eng, cfg, tall, 100, 0, 0, 0);
    ASSERT_EQ(eng.stats().axis, 1) << "fixture drifted — this is a vertical sweep";
    int painted = 0;
    for (const auto& r : rows) {
        if (r.outcome != rnis::pano::Outcome::Painted) continue;
        ++painted;
        EXPECT_TRUE(r.crossStatsComputed) << "seq " << r.seq;
        EXPECT_EQ(r.crossGated, 0) << "log-only never gates";
        EXPECT_TRUE(std::isfinite(r.crossTextureVar)) << "seq " << r.seq;
        EXPECT_GT(r.crossTextureVar, 0.0)
            << "the synthetic shelf is textured — a zero here is a broken statistic";
        EXPECT_TRUE(std::isfinite(r.crossPeakPSR)) << "seq " << r.seq;
        EXPECT_GT(r.crossPeakPSR, 0.0) << "seq " << r.seq;
        EXPECT_TRUE(std::isfinite(r.crossPeakMass)) << "seq " << r.seq;
        EXPECT_GT(r.crossPeakMass, 0.0) << "seq " << r.seq;
        EXPECT_LE(r.crossPeakMass, 1.0) << "seq " << r.seq;
        EXPECT_TRUE(std::isfinite(r.crossDominantPeriodPx)) << "seq " << r.seq;
        EXPECT_GT(r.crossDominantPeriodPx, 0.0) << "seq " << r.seq;
        EXPECT_TRUE(std::isfinite(r.crossPeakSecondary)) << "seq " << r.seq;
        EXPECT_LE(r.crossPeakSecondary, 1.0)
            << "nothing outside the exclusion band can exceed the argmax";
        // axis 1: the cross component is advanceX, and in log-only the raw
        // measurement IS the applied one.
        EXPECT_DOUBLE_EQ(r.crossResidualRawPx, r.advanceX) << "seq " << r.seq;
    }
    ASSERT_GT(painted, 50) << "fixture drifted — too few painted rows to pin anything";
}

TEST(PanoCrossGate, LogOnlyLeavesPlacementUntouched) {
    cv::Mat tall = makeShelf(kFrameW + 64, 5000);
    rnis::pano::Engine off, log;
    auto cfg = testConfig();
    auto cfgLog = testConfig();
    cfgLog.crossResidualGate = 1;
    std::string err;
    ASSERT_TRUE(off.configure(cfg, &err)) << err;
    ASSERT_TRUE(log.configure(cfgLog, &err)) << err;
    const auto rowsOff = runVerticalSweepShifted(off, cfg, tall, 100, 0, 0, 0);
    const auto rowsLog = runVerticalSweepShifted(log, cfgLog, tall, 100, 0, 0, 0);
    ASSERT_EQ(rowsOff.size(), rowsLog.size());
    for (size_t i = 0; i < rowsOff.size(); ++i) {
        const auto& a = rowsOff[i];
        const auto& b = rowsLog[i];
        EXPECT_EQ(a.chainAdvanced, b.chainAdvanced) << "row " << i;
        EXPECT_DOUBLE_EQ(a.advanceX, b.advanceX) << "row " << i;
        EXPECT_DOUBLE_EQ(a.advanceY, b.advanceY) << "row " << i;
        EXPECT_DOUBLE_EQ(a.advanceRotX, b.advanceRotX) << "row " << i;
        EXPECT_DOUBLE_EQ(a.advanceRotY, b.advanceRotY) << "row " << i;
        EXPECT_DOUBLE_EQ(a.advanceTotX, b.advanceTotX) << "row " << i;
        EXPECT_DOUBLE_EQ(a.advanceTotY, b.advanceTotY) << "row " << i;
        EXPECT_DOUBLE_EQ(a.response, b.response) << "row " << i;
        EXPECT_DOUBLE_EQ(a.canvasX0, b.canvasX0) << "row " << i;
        EXPECT_DOUBLE_EQ(a.canvasX1, b.canvasX1) << "row " << i;
        EXPECT_DOUBLE_EQ(a.gainStep, b.gainStep) << "row " << i;
        EXPECT_DOUBLE_EQ(a.seamCanvasJogSignedPx, b.seamCanvasJogSignedPx) << "row " << i;
        // The identity holds on every log-only row exactly as it does today.
        EXPECT_DOUBLE_EQ(b.advanceTotX, b.advanceRotX + b.advanceX) << "row " << i;
        EXPECT_DOUBLE_EQ(b.advanceTotY, b.advanceRotY + b.advanceY) << "row " << i;
    }
    EXPECT_EQ(off.stats().painted, log.stats().painted);
    EXPECT_EQ(log.stats().crossGatedTexture, 0);
    EXPECT_EQ(log.stats().crossGatedPeak, 0);
    EXPECT_EQ(log.stats().crossGatedPeriod, 0);
}

// The d8JogGuard rule, applied to this knob: a mode that LOOKS armed and
// cannot fire is refused by name.  Gate mode needs a live threshold; the
// period guard needs gate mode and a live threshold of its own.  (Until
// step 3 landed, `2` itself was refused — that refusal is what this test
// pinned on 2026-09-07 morning; it is now the all-zero form that is.)
TEST(PanoCrossGate, ConfigureRefusesArmedLookingNoOpsAndBadRanges) {
    rnis::pano::Engine e;
    std::string err;
    auto cfg = testConfig();
    cfg.crossResidualGate = 2;                  // every threshold 0, no guard
    EXPECT_FALSE(e.configure(cfg, &err));
    EXPECT_NE(err.find("crossResidualGate"), std::string::npos) << err;
    cfg = testConfig();
    cfg.crossResidualGate = 2;
    cfg.crossTextureMinVar = 100.0;
    EXPECT_TRUE(e.configure(cfg, &err)) << err;   // one live test arms it
    cfg = testConfig();
    cfg.crossResidualGate = 2;
    cfg.crossPeriodGuard = 1;
    cfg.crossPeriodMaxFrac = 0.5;
    EXPECT_TRUE(e.configure(cfg, &err)) << err;   // the guard alone arms it
    cfg = testConfig();
    cfg.crossResidualGate = 1;
    cfg.crossPeriodGuard = 1;
    cfg.crossPeriodMaxFrac = 0.5;
    EXPECT_FALSE(e.configure(cfg, &err))
        << "a period guard under log-only would look armed and only log";
    EXPECT_NE(err.find("crossPeriodGuard"), std::string::npos) << err;
    cfg = testConfig();
    cfg.crossResidualGate = 2;
    cfg.crossPeriodGuard = 1;                   // both period thresholds 0
    EXPECT_FALSE(e.configure(cfg, &err));
    EXPECT_NE(err.find("crossPeriodGuard"), std::string::npos) << err;
    cfg = testConfig();
    cfg.crossResidualGate = 3;
    EXPECT_FALSE(e.configure(cfg, &err));
    cfg = testConfig();
    cfg.crossResidualGate = -1;
    EXPECT_FALSE(e.configure(cfg, &err));
    cfg = testConfig();
    cfg.crossPeriodGuard = 2;
    EXPECT_FALSE(e.configure(cfg, &err));
    cfg = testConfig();
    cfg.crossTextureMinVar = -1.0;
    EXPECT_FALSE(e.configure(cfg, &err));
    cfg = testConfig();
    cfg.crossPeakSecondaryFrac = -0.5;
    EXPECT_FALSE(e.configure(cfg, &err));
    cfg = testConfig();
    cfg.crossResidualGate = 1;
    EXPECT_TRUE(e.configure(cfg, &err)) << err;
}

// ── the low-light registration gate, steps 3 + 4: the gate and the period
// guard ───────────────────────────────────────────────────────────────────
//
// FIXTURES.  Every sweep here is vertical (axis 1, cross = X), the hold the
// 2026-09-07 packs used.  Frame i is a VIEW of a tall synthetic shelf from a
// camera at crop origin (x_i, y_i) with attitude q_i — synthesised through the
// inverse of the engine's own rectification exactly as runSweepSpec does, but
// resampled from the WHOLE tall image rather than from a pre-cut crop, so an
// attitude step brings real shelf content into view instead of a replicated
// border.  With q = identity it is the plain crop every other fixture uses.
//
// Three shelves:
//   * flat-centre shelf — makeShelf's texture on both sides of a 600 px wide
//     FLAT column band under the centre correlation window; the band carries
//     a faint (±4 DN, blurred) pattern that DRIFTS one source px per frame
//     across the sweep.  The whitened estimator is amplitude-blind, so it
//     reads that drift as a confident cross residual every frame — the
//     doc's "confident quarter pixel of noise", made deterministic and
//     biased so the chain provably walks.  The outer windows sit on the
//     textured sides, so the cut metric and the paint see real content.
//   * stripe shelf — a cross-axis periodic pattern (period kStripePeriodPx
//     source px) with an aperiodic row modulation for the along axis and a
//     faint aperiodic field so the estimator can resolve a one-period step
//     deterministically.  A window of pure stripes reads 0 for any
//     whole-period shift (the windows are identical), so a test that needs
//     the estimator to REPORT the period has to break the symmetry; from the
//     guard's side a reported one-period step it cannot attribute to the
//     attitude is exactly the alias case, which is what Risk 2 is about.
//   * aperiodic shelf — a blurred random field; no period at all.
namespace {

constexpr int kStripePeriodPx = 48;   // source px; 24 canvas px at canvasScale 0.5

/// makeShelf with a flat column band [x0, x0 + w) painted uniform 128.
cv::Mat makeFlatCentreShelf(int width, int height, int bandX0, int bandW) {
    cv::Mat img = makeShelf(width, height);
    cv::rectangle(img, cv::Rect(bandX0, 0, bandW, height), cv::Scalar(128, 128, 128),
                  cv::FILLED);
    return img;
}

/// A faint, smooth, aperiodic field (±amp DN around 0), CV_32FC1.
cv::Mat makeFaintField(int width, int height, double amp, uint64_t seed,
                       double sigma = 3.0) {
    cv::Mat n(height, width, CV_32FC1);
    cv::RNG rng(seed);
    rng.fill(n, cv::RNG::UNIFORM, -1.0f, 1.0f);
    cv::GaussianBlur(n, n, cv::Size(0, 0), sigma);
    double lo, hi;
    cv::minMaxLoc(n, &lo, &hi);
    const double sc = (hi > lo) ? (2.0 * amp / (hi - lo)) : 0.0;
    n = (n - (float)(0.5 * (lo + hi))) * (float)sc;
    return n;
}

/// The tiled shelf: ONE random-texture tile, kStripePeriodPx wide and the
/// full height, repeated across the width — a genuinely 2-D periodic pattern
/// (wallpaper), so every spectral bin the pattern owns sits at a multiple of
/// the period's frequency and the whitened surface carries the alias peaks
/// at ±period at nearly the primary's height.  (An ADDITIVE stripe + row
/// modulation was tried first and measured secondary 0.02-0.05: its
/// periodicity lives in four bins of 27648, which whitening erases.)  An
/// optional faint aperiodic field (±fieldAmp DN) breaks the whole-period
/// symmetry so a one-period step can be REPORTED by the estimator; without
/// it the two windows are identical and the estimator reads 0.
cv::Mat makeTiledShelf(int width, int height, double fieldAmp) {
    cv::Mat tile(height, kStripePeriodPx, CV_32FC1);
    cv::RNG rng(20260907);
    rng.fill(tile, cv::RNG::UNIFORM, 0.0f, 1.0f);
    cv::GaussianBlur(tile, tile, cv::Size(0, 0), 1.2);
    cv::normalize(tile, tile, 40.0, 215.0, cv::NORM_MINMAX);
    cv::Mat g(height, width, CV_32FC1);
    for (int x = 0; x < width; ++x) tile.col(x % kStripePeriodPx).copyTo(g.col(x));
    if (fieldAmp > 0.0) g += makeFaintField(width, height, fieldAmp, 20260908);
    cv::Mat g8, bgr;
    g.convertTo(g8, CV_8UC1);
    cv::cvtColor(g8, bgr, cv::COLOR_GRAY2BGR);
    return bgr;
}

/// The aperiodic shelf: a blurred random field with full contrast.
cv::Mat makeAperiodicShelf(int width, int height) {
    cv::Mat n(height, width, CV_32FC1);
    cv::RNG rng(20260909);
    rng.fill(n, cv::RNG::UNIFORM, 0.0f, 1.0f);
    cv::GaussianBlur(n, n, cv::Size(0, 0), 1.5);
    cv::normalize(n, n, 30.0, 225.0, cv::NORM_MINMAX);
    cv::Mat g8, bgr;
    n.convertTo(g8, CV_8UC1);
    cv::cvtColor(g8, bgr, cv::COLOR_GRAY2BGR);
    return bgr;
}

/// One frame: the camera's view of `tall` from crop origin (x0, y0) with
/// attitude q.  dst (frame) → tall is T(x0, y0) · rectifyH(q), i.e. the
/// engine's rectification composed with the crop — WARP_INVERSE_MAP.
cv::Mat viewOfShelf(const cv::Mat& tall, double x0, double y0, const Quat& q) {
    const bool rotated = std::fabs(q[0]) + std::fabs(q[1]) + std::fabs(q[2]) > 1e-12;
    if (!rotated && std::fabs(x0 - std::round(x0)) < 1e-9 &&
        std::fabs(y0 - std::round(y0)) < 1e-9) {
        return tall(cv::Rect((int)std::lround(x0), (int)std::lround(y0), kFrameW,
                             kFrameH)).clone();
    }
    const cv::Matx33d T(1, 0, x0, 0, 1, y0, 0, 0, 1);
    const cv::Matx33d M = T * rectifyH(q.data());
    cv::Mat out;
    cv::warpPerspective(tall, out, cv::Mat(M), cv::Size(kFrameW, kFrameH),
                        cv::INTER_LINEAR | cv::WARP_INVERSE_MAP, cv::BORDER_REPLICATE);
    return out;
}

/// A per-frame view spec: crop origin, attitude, and a hook that may edit
/// the finished frame (the flat band's drifting pattern is painted there,
/// in FRAME coordinates, since it is not part of the shelf).
struct GateFrame {
    double x0 = 0.0, y0 = 0.0;
    Quat q = identityQuat();
};

std::vector<rnis::pano::FrameOutcome> runGateSweep(
    rnis::pano::Engine& eng, const rnis::pano::Config& cfg, const cv::Mat& tall,
    const std::vector<GateFrame>& frames,
    const std::function<void(int, cv::Mat&)>& edit = nullptr,
    double noiseDN = 0.0) {
    std::vector<rnis::pano::FrameOutcome> rows;
    for (size_t i = 0; i < frames.size(); ++i) {
        const GateFrame& f = frames[i];
        cv::Mat crop = viewOfShelf(tall, f.x0, f.y0, f.q);
        if (edit) edit((int)i, crop);
        applySyntheticNoise(crop, noiseDN, (int)i);
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        for (int k = 0; k < 4; ++k) in.q[k] = f.q[k];
        in.t[0] = f.x0 * (0.6 / kFx);
        in.t[1] = f.y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = (int64_t)i;
        rows.push_back(eng.ingest(in));
    }
    return rows;
}

/// The plain vertical walk every gate fixture starts from: 18 source px per
/// frame down the shelf, identity attitude.
std::vector<GateFrame> verticalWalk(int frames, double x0 = 0.0) {
    std::vector<GateFrame> v((size_t)frames);
    for (int i = 0; i < frames; ++i) { v[(size_t)i].x0 = x0; v[(size_t)i].y0 = 200.0 + 18.0 * i; }
    return v;
}

// The flat-centre shelf's band: 600 px wide, centred on the frame centre
// (720), so the 384 px centre window at any clamp sits inside it while the
// outer windows (crossWindows 3, span 1.0 → the clamp range's ends, [0, 384)
// and [1056, 1440) in source px) sit on texture.
constexpr int kFlatBandX0 = 420, kFlatBandW = 600;

/// Paint the faint drifting pattern into the flat band of `frame` i: the
/// field is a fixed image in SHELF coordinates shifted by `driftPx` × i
/// along X, and it moves with the shelf along Y (y0 = 200 + 18 i), so the
/// centre window sees a pattern that walks the sweep AND creeps sideways.
struct FaintDrift {
    cv::Mat field;   // CV_32FC1, wide enough for the whole drift
    double driftPx;
    double amp;
    FaintDrift(int frames, double drift, double a) : driftPx(drift), amp(a) {
        field = makeFaintField(kFlatBandW + (int)std::ceil(std::fabs(drift) * frames) + 64,
                               5000, a, 20260910);
    }
    void operator()(int i, cv::Mat& frame) const {
        const int y0 = 200 + 18 * i;
        const int sx = (int)std::lround(std::fabs(driftPx) * (driftPx >= 0 ? i : 0)
                                        + (driftPx < 0 ? std::fabs(driftPx) * ((field.cols - kFlatBandW - 64) / std::fabs(driftPx) - i) : 0));
        cv::Mat patch = field(cv::Rect(sx, y0, kFlatBandW, kFrameH));
        cv::Mat roi = frame(cv::Rect(kFlatBandX0, 0, kFlatBandW, kFrameH));
        cv::Mat f32;
        roi.convertTo(f32, CV_32FC3);
        cv::Mat p3;
        cv::merge(std::vector<cv::Mat>{patch, patch, patch}, p3);
        f32 += p3;
        f32.convertTo(roi, CV_8UC3);
    }
};

double sumCrossPainted(const std::vector<rnis::pano::FrameOutcome>& rows) {
    double s = 0.0;
    for (const auto& r : rows)
        if (r.chainAdvanced) s += r.advanceX;
    return s;
}

}  // namespace

// The thresholds below are FIXTURE thresholds, chosen from the log-only
// statistics of these synthetic shelves (measured on this Mac, 2026-09-07,
// 3 DN sensor noise): the flat band reads crossTextureVar 22-24 / PSR 12-18
// / mass 0.006 against makeShelf's 790+ / 144+ / 0.013+; the tiled shelf's
// secondary reads 0.26-0.29 on a plain walk and 0.5-0.9 across a one-period
// attitude step against the aperiodic shelf's 0.01-0.03.  They say nothing
// about the device thresholds, which step 2 chooses from the corpus.
namespace {
constexpr double kFxNoiseDN = 3.0;
rnis::pano::Config gateCfg(double texVar, double psr, double mass) {
    auto c = testConfig();
    c.crossResidualGate = 2;
    c.crossTextureMinVar = texVar;
    c.crossPeakMinPSR = psr;
    c.crossPeakMinMass = mass;
    return c;
}
rnis::pano::Config periodCfg(double maxFrac, double secondaryFrac) {
    auto c = testConfig();
    c.crossResidualGate = 2;
    c.crossPeriodGuard = 1;
    c.crossPeriodMaxFrac = maxFrac;
    c.crossPeakSecondaryFrac = secondaryFrac;
    return c;
}
/// RNIS_TEST_DUMP=<dir>: write a canvas so the picture can be LOOKED at.
void dumpCanvas(rnis::pano::Engine& e, const char* name) {
    const char* d = std::getenv("RNIS_TEST_DUMP");
    if (!d) return;
    cv::Mat c;
    if (e.finalCanvas(c) && !c.empty())
        cv::imwrite(std::string(d) + "/" + name + ".png", c);
}
/// One period's worth of yaw on the suite's camera, in degrees: the
/// rectified centre moves fx·tan(θ) source px, and one period of the tiled
/// shelf is kStripePeriodPx source px.
double onePeriodYawDeg() {
    return std::atan((double)kStripePeriodPx / kFx) * 180.0 / CV_PI;
}
/// A vertical walk that, from frame `from`, yaws by one period per frame for
/// `steps` frames and then holds the attitude — the camera turns across the
/// cross axis while it keeps sweeping.
std::vector<GateFrame> walkWithPeriodYaw(int frames, int from, int steps) {
    auto fr = verticalWalk(frames, (double)kStripePeriodPx);
    const double th1 = onePeriodYawDeg();
    for (int i = from; i < frames; ++i)
        fr[(size_t)i].q = yawQuat(th1 * std::min(steps, i - from + 1));
    return fr;
}
}  // namespace

// STEP 3 (a): the texture / peak gate.  RED, observed 2026-09-07 against the
// step-1 engine: configure() refuses crossResidualGate 2 outright
// ("not implemented yet"), so every test below failed at its ASSERT_TRUE on
// configure — quoted in the step-3 report.
TEST(PanoCrossGate, FlatWindowFallsBackToAttitude) {
    cv::Mat tall = makeFlatCentreShelf(kFrameW, 5000, kFlatBandX0, kFlatBandW);
    FaintDrift drift(100, 1.0, 4.0);
    const auto frames = verticalWalk(100);
    std::string err;

    // UNGATED (log-only, so the statistics are on the row): the chain walks.
    rnis::pano::Engine off;
    auto cfgOff = testConfig();
    // Subject: the cross-residual gate, not the window.  The flat band is 600
    // src px wide, so a window wider than that overhangs it onto real texture
    // and the fixture stops producing the flat window under test.
    cfgOff.phaseWindowPx = 384;
    cfgOff.crossResidualGate = 1;
    ASSERT_TRUE(off.configure(cfgOff, &err)) << err;
    const auto rowsOff = runGateSweep(off, cfgOff, tall, frames, drift, kFxNoiseDN);
    ASSERT_EQ(off.stats().axis, 1) << "fixture drifted — this is a vertical sweep";
    const double driftOff = sumCrossPainted(rowsOff);
    ASSERT_GT(std::fabs(driftOff), 20.0)
        << "the faint pattern must make the ungated chain walk, or the gate "
           "has nothing to remove (Σ advanceX = " << driftOff << " canvas px)";
    // The window IS flat by the instrument's reading, and the estimator IS
    // confident about it — the pair the doc names (response 0.82-1.11 on the
    // P5 band): minPhaseResponse cannot fire here, the texture can.
    for (const auto& r : rowsOff)
        if (r.outcome == rnis::pano::Outcome::Painted) {
            EXPECT_LT(r.crossTextureVar, 100.0) << "seq " << r.seq;
            EXPECT_GT(r.response, 0.5) << "seq " << r.seq;
        }
    dumpCanvas(off, "flat_ungated");

    // GATED by texture (reason 1), by peak (reason 2), and by both (3).
    struct Arm { const char* name; rnis::pano::Config cfg; int reason; };
    Arm arms[] = {
        {"texture", gateCfg(100.0, 0.0, 0.0), 1},
        {"psr",     gateCfg(0.0, 50.0, 0.0), 2},
        {"mass",    gateCfg(0.0, 0.0, 0.01), 2},
        {"all",     gateCfg(100.0, 50.0, 0.01), 3},
    };
    // Both arms of the A/B on the window the fixture was calibrated for.
    for (Arm& a : arms) a.cfg.phaseWindowPx = cfgOff.phaseWindowPx;
    for (const Arm& arm : arms) {
        rnis::pano::Engine on;
        ASSERT_TRUE(on.configure(arm.cfg, &err)) << arm.name << ": " << err;
        const auto rowsOn = runGateSweep(on, arm.cfg, tall, frames, drift, kFxNoiseDN);
        ASSERT_EQ(rowsOn.size(), rowsOff.size());
        int gated = 0;
        for (size_t i = 0; i < rowsOn.size(); ++i) {
            const auto& g = rowsOn[i];
            const auto& u = rowsOff[i];
            if (g.outcome != rnis::pano::Outcome::Painted) continue;
            EXPECT_EQ(g.crossGated, arm.reason) << arm.name << " seq " << g.seq;
            ++gated;
            // Placement by the attitude on the cross axis …
            EXPECT_DOUBLE_EQ(g.advanceX, 0.0) << arm.name << " seq " << g.seq;
            EXPECT_DOUBLE_EQ(g.advanceTotX, g.advanceRotX) << arm.name << " seq " << g.seq;
            // … the measurement kept on the row — and it IS the ungated
            // engine's measurement, because the windows are attitude-placed
            // and never read the chain.
            EXPECT_DOUBLE_EQ(g.crossResidualRawPx, u.advanceX) << arm.name << " seq " << g.seq;
            EXPECT_NE(g.crossResidualRawPx, 0.0) << arm.name << " seq " << g.seq;
            // The outcome and the chain flag are the ungated engine's.
            EXPECT_EQ(g.outcome, u.outcome) << arm.name << " seq " << g.seq;
            EXPECT_EQ(g.chainAdvanced, u.chainAdvanced) << arm.name << " seq " << g.seq;
        }
        EXPECT_GT(gated, 50) << arm.name;
        const double driftOn = sumCrossPainted(rowsOn);
        EXPECT_LT(std::fabs(driftOn), 2.0)
            << arm.name << ": gated Σ advanceX = " << driftOn
            << " (ungated " << driftOff << ")";
        EXPECT_EQ(on.stats().painted, off.stats().painted) << arm.name;
        const auto& st = on.stats();
        if (arm.reason & 1) EXPECT_GT(st.crossGatedTexture, 50) << arm.name;
        else                EXPECT_EQ(st.crossGatedTexture, 0) << arm.name;
        if (arm.reason & 2) EXPECT_GT(st.crossGatedPeak, 50) << arm.name;
        else                EXPECT_EQ(st.crossGatedPeak, 0) << arm.name;
        EXPECT_EQ(st.crossGatedPeriod, 0) << arm.name;
        if (arm.reason == 3) dumpCanvas(on, "flat_gated");
    }
}

TEST(PanoCrossGate, TexturedWindowIsUntouched) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    const auto frames = verticalWalk(100);
    std::string err;
    rnis::pano::Engine off, on;
    auto cfgOff = testConfig();
    // Armed on every test, at the fixture thresholds — none of which the
    // textured shelf reaches.
    auto cfgOn = gateCfg(100.0, 50.0, 0.01);
    // Subject: an armed gate that never fires, not the window.  These fixture
    // thresholds are window-area dependent — crossPeakMass in particular is a
    // fixed 5x5 support over the whole surface — so both arms pin the 384 src
    // px (192x144 work) window the 0.01 floor was measured against.
    cfgOff.phaseWindowPx = 384;
    cfgOn.phaseWindowPx = 384;
    cfgOn.crossPeriodGuard = 1;
    cfgOn.crossPeriodMaxFrac = 0.5;
    cfgOn.crossPeakSecondaryFrac = 0.4;
    ASSERT_TRUE(off.configure(cfgOff, &err)) << err;
    ASSERT_TRUE(on.configure(cfgOn, &err)) << err;
    const auto rowsOff = runGateSweep(off, cfgOff, tall, frames, nullptr, kFxNoiseDN);
    const auto rowsOn = runGateSweep(on, cfgOn, tall, frames, nullptr, kFxNoiseDN);
    (void)off.finish(); (void)on.finish();
    cv::Mat a, b;
    ASSERT_TRUE(off.finalCanvas(a));
    ASSERT_TRUE(on.finalCanvas(b));
    ASSERT_EQ(a.size(), b.size());
    EXPECT_EQ(cv::norm(a, b, cv::NORM_INF), 0.0)
        << "an armed gate that never fires must not move a byte";
    ASSERT_EQ(rowsOff.size(), rowsOn.size());
    for (size_t i = 0; i < rowsOff.size(); ++i) {
        EXPECT_EQ(rowsOn[i].crossGated, 0) << "seq " << rowsOn[i].seq;
        EXPECT_EQ(rowsOff[i].outcome, rowsOn[i].outcome) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].advanceX, rowsOn[i].advanceX) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].advanceY, rowsOn[i].advanceY) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].advanceTotX, rowsOn[i].advanceTotX) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].advanceTotY, rowsOn[i].advanceTotY) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].seamCanvasJogSignedPx, rowsOn[i].seamCanvasJogSignedPx)
            << "row " << i;
    }
    EXPECT_EQ(on.stats().crossGatedTexture, 0);
    EXPECT_EQ(on.stats().crossGatedPeak, 0);
    EXPECT_EQ(on.stats().crossGatedPeriod, 0);
    EXPECT_EQ(on.stats().painted, off.stats().painted);
}

TEST(PanoCrossGate, IdentityHoldsOnGatedRows) {
    cv::Mat tall = makeFlatCentreShelf(kFrameW, 5000, kFlatBandX0, kFlatBandW);
    FaintDrift drift(100, 1.0, 4.0);
    rnis::pano::Engine on;
    auto cfg = gateCfg(100.0, 50.0, 0.01);
    std::string err;
    ASSERT_TRUE(on.configure(cfg, &err)) << err;
    const auto rows = runGateSweep(on, cfg, tall, verticalWalk(100), drift, kFxNoiseDN);
    int gated = 0;
    for (const auto& r : rows) {
        // On EVERY row — gated, ungated, held, rejected, bootstrap.
        EXPECT_DOUBLE_EQ(r.advanceTotX, r.advanceRotX + r.advanceX) << "seq " << r.seq;
        EXPECT_DOUBLE_EQ(r.advanceTotY, r.advanceRotY + r.advanceY) << "seq " << r.seq;
        if (r.crossGated == 0) continue;
        ++gated;
        EXPECT_DOUBLE_EQ(r.advanceX, 0.0) << "seq " << r.seq;
        EXPECT_NE(r.crossResidualRawPx, 0.0) << "seq " << r.seq;
        EXPECT_TRUE(r.chainAdvanced) << "seq " << r.seq
            << " — a gated frame still advances the chain";
    }
    EXPECT_GT(gated, 50);
}

TEST(PanoCrossGate, AlongAxisIsNeverGated) {
    cv::Mat tall = makeFlatCentreShelf(kFrameW, 5000, kFlatBandX0, kFlatBandW);
    FaintDrift drift(100, 1.0, 4.0);
    const auto frames = verticalWalk(100);
    std::string err;
    rnis::pano::Engine off, on;
    auto cfgOff = testConfig();
    auto cfgOn = gateCfg(100.0, 50.0, 0.01);
    // Subject: the ALONG channel on gated rows, not the window.  This test
    // needs the TEXTURE reason to fire, and only the 384 src px window fits
    // inside the fixture's 600 px flat band; both arms pin it.
    cfgOff.phaseWindowPx = 384;
    cfgOn.phaseWindowPx = 384;
    ASSERT_TRUE(off.configure(cfgOff, &err)) << err;
    ASSERT_TRUE(on.configure(cfgOn, &err)) << err;
    const auto rowsOff = runGateSweep(off, cfgOff, tall, frames, drift, kFxNoiseDN);
    const auto rowsOn = runGateSweep(on, cfgOn, tall, frames, drift, kFxNoiseDN);
    ASSERT_EQ(rowsOff.size(), rowsOn.size());
    ASSERT_EQ(on.stats().axis, 1);
    int gated = 0;
    for (size_t i = 0; i < rowsOn.size(); ++i) {
        const auto& g = rowsOn[i];
        if (g.crossGated == 0) continue;
        ++gated;
        // The along-axis (Y) component is the ungated measurement, bit for
        // bit, and it is the real 18 px/frame walk (9 canvas px).
        EXPECT_DOUBLE_EQ(g.advanceY, rowsOff[i].advanceY) << "seq " << g.seq;
        EXPECT_NEAR(std::fabs(g.advanceY), 9.0, 1.0) << "seq " << g.seq;
        EXPECT_DOUBLE_EQ(g.advanceTotY, g.advanceRotY + g.advanceY) << "seq " << g.seq;
    }
    EXPECT_GT(gated, 50);
    EXPECT_GT(on.stats().crossGatedTexture, 50);
}

// STEP 4 (b): the periodicity guard.  THE ALIAS, reproduced rather than
// injected: on the tiled shelf a one-period attitude step (1.96° of yaw =
// 48 source px = 24 canvas px) leaves the two rectified windows IDENTICAL up
// to the tie-breaking field, and the estimator locks to the zero-lag peak —
// measured on this Mac 2026-09-07: residual +24.15 against advanceRot
// −24.00, advanceTot ≈ 0.  The chain refuses to move while the camera did,
// and the strip lands one period off — the fireplace tear's mechanism.  The
// same step on an aperiodic shelf reads a residual of 0.1-0.2.
TEST(PanoCrossGate, PeriodicWindowRejectsWholePeriodJump) {
    cv::Mat tall = makeTiledShelf(kFrameW + 96, 5000, 6.0);
    const auto frames = walkWithPeriodYaw(100, 40, 6);
    std::string err;

    rnis::pano::Engine off;
    auto cfgOff = testConfig();
    // Subject: the periodicity guard, not the window.  The alias this fixture
    // has to reproduce is a property of how much of the tie-breaking aperiodic
    // field the window sees — a 768 src px window resolves the true peak on 4
    // of these 6 yaw rows and the fixture has no alias left to guard.
    cfgOff.phaseWindowPx = 384;
    cfgOff.crossResidualGate = 1;
    ASSERT_TRUE(off.configure(cfgOff, &err)) << err;
    const auto rowsOff = runGateSweep(off, cfgOff, tall, frames, nullptr, kFxNoiseDN);
    ASSERT_EQ(off.stats().axis, 1);
    int aliased = 0;
    for (const auto& r : rowsOff) {
        if (r.seq < 40 || r.seq >= 46) continue;
        ASSERT_EQ(r.outcome, rnis::pano::Outcome::Painted) << "seq " << r.seq;
        EXPECT_NEAR(r.advanceRotX, -(double)kStripePeriodPx * cfgOff.canvasScale, 1.5)
            << "seq " << r.seq << " — the attitude carries one period";
        // The period instrument reads the tile — or one of its HARMONICS
        // (measured 6 / 12 / 24 canvas px across these rows: the argmax of
        // the mean profile's spectrum is whichever harmonic the tile's own
        // texture makes loudest).  Pinned as "an integer divisor of the
        // tile period"; what it does to the N× rule is a step-2 question.
        {
            const double tilePx = (double)kStripePeriodPx * cfgOff.canvasScale;
            const double k = tilePx / r.crossDominantPeriodPx;
            EXPECT_NEAR(k, std::round(k), 1e-6)
                << "seq " << r.seq << " period " << r.crossDominantPeriodPx;
            EXPECT_GE(k, 1.0) << "seq " << r.seq;
            EXPECT_LE(k, 8.0) << "seq " << r.seq;
        }
        // The alias: the residual cancels the attitude.
        if (std::fabs(r.advanceX + r.advanceRotX) < 1.5) ++aliased;
        EXPECT_GT(std::fabs(r.advanceX), 0.5 * r.crossDominantPeriodPx) << "seq " << r.seq;
    }
    ASSERT_GE(aliased, 5)
        << "the fixture must reproduce the alias on the yaw rows or this "
           "test proves nothing";
    dumpCanvas(off, "period_ungated");

    // The magnitude rule alone, then the secondary-peak rule alone.
    struct Arm { const char* name; rnis::pano::Config cfg; };
    Arm arms[] = {
        {"magnitude", periodCfg(0.5, 0.0)},
        {"secondary", periodCfg(0.0, 0.4)},
    };
    // Both arms of the A/B on the window the fixture was calibrated for.
    for (Arm& a : arms) a.cfg.phaseWindowPx = cfgOff.phaseWindowPx;
    for (const Arm& arm : arms) {
        rnis::pano::Engine on;
        ASSERT_TRUE(on.configure(arm.cfg, &err)) << arm.name << ": " << err;
        const auto rowsOn = runGateSweep(on, arm.cfg, tall, frames, nullptr, kFxNoiseDN);
        ASSERT_EQ(rowsOn.size(), rowsOff.size());
        for (size_t i = 0; i < rowsOn.size(); ++i) {
            const auto& g = rowsOn[i];
            const auto& u = rowsOff[i];
            if (g.seq >= 40 && g.seq < 46) {
                EXPECT_EQ(g.crossGated, 4) << arm.name << " seq " << g.seq;
                EXPECT_DOUBLE_EQ(g.advanceX, 0.0) << arm.name << " seq " << g.seq;
                EXPECT_DOUBLE_EQ(g.advanceTotX, g.advanceRotX) << arm.name << " seq " << g.seq;
                EXPECT_DOUBLE_EQ(g.crossResidualRawPx, u.advanceX) << arm.name << " seq " << g.seq;
                EXPECT_EQ(g.outcome, u.outcome) << arm.name << " seq " << g.seq;
            } else if (arm.cfg.crossPeriodMaxFrac > 0.0) {
                // The magnitude rule leaves the plain walk alone.
                EXPECT_EQ(g.crossGated, 0) << arm.name << " seq " << g.seq;
            }
        }
        EXPECT_GE(on.stats().crossGatedPeriod, 6) << arm.name;
        EXPECT_EQ(on.stats().crossGatedTexture, 0) << arm.name;
        EXPECT_EQ(on.stats().crossGatedPeak, 0) << arm.name;
        if (arm.cfg.crossPeriodMaxFrac > 0.0) {
            EXPECT_EQ(on.stats().crossGatedPeriod, 6) << arm.name;
            dumpCanvas(on, "period_gated");
        }
    }
}

TEST(PanoCrossGate, AperiodicWindowPassesPeriodGuard) {
    cv::Mat tall = makeAperiodicShelf(kFrameW + 96, 5000);
    // The same one-period attitude step: on an aperiodic window the
    // estimator resolves it and the residual agrees with the attitude.
    const auto frames = walkWithPeriodYaw(100, 40, 6);
    std::string err;
    rnis::pano::Engine off, on;
    auto cfgOff = testConfig();
    auto cfgOn = periodCfg(0.5, 0.4);
    ASSERT_TRUE(off.configure(cfgOff, &err)) << err;
    ASSERT_TRUE(on.configure(cfgOn, &err)) << err;
    const auto rowsOff = runGateSweep(off, cfgOff, tall, frames, nullptr, kFxNoiseDN);
    const auto rowsOn = runGateSweep(on, cfgOn, tall, frames, nullptr, kFxNoiseDN);
    (void)off.finish(); (void)on.finish();
    cv::Mat a, b;
    ASSERT_TRUE(off.finalCanvas(a));
    ASSERT_TRUE(on.finalCanvas(b));
    ASSERT_EQ(a.size(), b.size());
    EXPECT_EQ(cv::norm(a, b, cv::NORM_INF), 0.0);
    ASSERT_EQ(rowsOff.size(), rowsOn.size());
    for (size_t i = 0; i < rowsOn.size(); ++i) {
        EXPECT_EQ(rowsOn[i].crossGated, 0) << "seq " << rowsOn[i].seq;
        EXPECT_DOUBLE_EQ(rowsOff[i].advanceX, rowsOn[i].advanceX) << "row " << i;
        EXPECT_DOUBLE_EQ(rowsOff[i].advanceTotX, rowsOn[i].advanceTotX) << "row " << i;
    }
    EXPECT_EQ(on.stats().crossGatedPeriod, 0);
    EXPECT_EQ(on.stats().crossGatedTexture, 0);
    EXPECT_EQ(on.stats().crossGatedPeak, 0);
    EXPECT_EQ(on.stats().painted, off.stats().painted);
}

// Risk 2.  The magnitude rule is referred to the ATTITUDE, never to zero: a
// one-period cross step the attitude predicts and the estimator agrees with
// has a residual near 0 and must pass, although the measured step itself
// (advanceTot) is a whole period.  Two windows: the tiled shelf with a
// tie-breaking field strong enough that the estimator resolves the true
// one-period shift (amp 24 DN, σ 1.5 — measured residual −0.03 against a
// −24 attitude step), and the aperiodic shelf.  A rule that compared the
// measured step to zero would fire on every one of these rows.
TEST(PanoCrossGate, RealTranslationOfOnePeriodPasses) {
    struct Case { const char* name; cv::Mat tall; };
    Case cases[] = {
        {"tiled+field", makeTiledShelf(kFrameW + 96, 5000, 0.0)},
        {"aperiodic",   makeAperiodicShelf(kFrameW + 96, 5000)},
    };
    {
        // The strong tie-breaker, in shelf coordinates.
        cv::Mat field = makeFaintField(kFrameW + 96, 5000, 24.0, 20260911, 1.5);
        cv::Mat f32, p3;
        cases[0].tall.convertTo(f32, CV_32FC3);
        cv::merge(std::vector<cv::Mat>{field, field, field}, p3);
        f32 += p3;
        f32.convertTo(cases[0].tall, CV_8UC3);
    }
    const auto frames = walkWithPeriodYaw(100, 40, 6);
    std::string err;
    for (const Case& c : cases) {
        rnis::pano::Engine on;
        auto cfg = periodCfg(0.5, 0.0);
        ASSERT_TRUE(on.configure(cfg, &err)) << err;
        const auto rows = runGateSweep(on, cfg, c.tall, frames, nullptr, kFxNoiseDN);
        ASSERT_EQ(on.stats().axis, 1) << c.name;
        int checked = 0;
        for (const auto& r : rows) {
            if (r.seq < 40 || r.seq >= 46) continue;
            ASSERT_EQ(r.outcome, rnis::pano::Outcome::Painted) << c.name << " seq " << r.seq;
            ++checked;
            // The measurement agrees with the attitude …
            EXPECT_LT(std::fabs(r.advanceX), 1.5) << c.name << " seq " << r.seq
                << " — the estimator must resolve the step, not alias it";
            // … the step itself is a whole period …
            EXPECT_GT(std::fabs(r.advanceTotX), 0.5 * r.crossDominantPeriodPx)
                << c.name << " seq " << r.seq << " — a zero-referenced rule would fire here";
            EXPECT_NEAR(r.advanceRotX, -(double)kStripePeriodPx * cfg.canvasScale, 1.5)
                << c.name << " seq " << r.seq;
            // … and the guard lets it through.
            EXPECT_EQ(r.crossGated, 0) << c.name << " seq " << r.seq;
        }
        EXPECT_EQ(checked, 6) << c.name;
        EXPECT_EQ(on.stats().crossGatedPeriod, 0) << c.name;
    }
}

// STEP 6 (review finding 1): the gate is a PLACEMENT decision, never a
// MEASUREMENT one.  Two things followed from handing the GATED residual to
// crossMeasure, and this pair pins their absence:
//   * with Config::crossAvgWindows on, the K-window mean was the weighted
//     mean of 0 (the gated centre) and the UNGATED outer bands, and the
//     chain applied it — the row said advanceX = 0 / advanceTot ==
//     advanceRot while the chain walked on the outer bands' residual
//     (measured on this Mac, pack 11-11-46, 81 of 81 gated rows with
//     crossAvgDeltaPx != 0, max 0.105 px);
//   * with it off, the outer bands' gradient fit and per-band cage were
//     referred to 0 instead of the measurement, so crossGrad on a gated row
//     differed from the log-only engine's on the same frame (127 of 2719
//     corpus rows, max |Δg| 5.79e-06).
// RED, observed on this Mac 2026-09-07 against the step-3/4 engine: quoted
// in the step-6 report.
TEST(PanoCrossGate, GatedFrameIsAttitudePlacedWithAvgWindowsOn) {
    cv::Mat tall = makeFlatCentreShelf(kFrameW, 5000, kFlatBandX0, kFlatBandW);
    FaintDrift drift(100, 1.0, 4.0);
    const auto frames = verticalWalk(100);
    std::string err;

    // Control: log-only with the averaging on — the outer bands DO move the
    // chain off the centre value on this fixture, so the assertion below is
    // discriminating and not a tautology.
    rnis::pano::Engine log;
    auto cfgLog = testConfig();
    cfgLog.crossResidualGate = 1;
    cfgLog.crossAvgWindows = true;
    ASSERT_TRUE(log.configure(cfgLog, &err)) << err;
    const auto rowsLog = runGateSweep(log, cfgLog, tall, frames, drift, kFxNoiseDN);
    int moved = 0;
    for (const auto& r : rowsLog)
        if (r.outcome == rnis::pano::Outcome::Painted && r.crossAvgDeltaPx != 0.0) ++moved;
    ASSERT_GT(moved, 50) << "fixture: crossAvgWindows must move the chain on "
                            "the ungated engine for this test to mean anything";

    // Gate with the averaging on, against the gate with it off.
    rnis::pano::Engine on, onNoAvg;
    auto cfgOn = gateCfg(100.0, 50.0, 0.01);
    cfgOn.crossAvgWindows = true;
    auto cfgNoAvg = gateCfg(100.0, 50.0, 0.01);
    ASSERT_TRUE(on.configure(cfgOn, &err)) << err;
    ASSERT_TRUE(onNoAvg.configure(cfgNoAvg, &err)) << err;
    const auto rowsOn = runGateSweep(on, cfgOn, tall, frames, drift, kFxNoiseDN);
    const auto rowsNoAvg = runGateSweep(onNoAvg, cfgNoAvg, tall, frames, drift, kFxNoiseDN);
    ASSERT_EQ(rowsOn.size(), rowsNoAvg.size());
    int gated = 0;
    bool allPaintedGated = true;
    for (size_t i = 0; i < rowsOn.size(); ++i) {
        const auto& g = rowsOn[i];
        if (g.outcome == rnis::pano::Outcome::Painted && g.crossGated == 0)
            allPaintedGated = false;
        if (g.crossGated == 0) continue;
        ++gated;
        // The chain applied the attitude: the averaged value the chain used
        // IS the gated value, so the delta is exactly 0 — the row's
        // advanceX = 0 / advanceTot == advanceRot is then TRUE of the chain.
        EXPECT_DOUBLE_EQ(g.crossAvgDeltaPx, 0.0) << "seq " << g.seq;
        EXPECT_DOUBLE_EQ(g.advanceX, 0.0) << "seq " << g.seq;
        EXPECT_DOUBLE_EQ(g.advanceTotX, g.advanceRotX) << "seq " << g.seq;
    }
    EXPECT_GT(gated, 50);
    // On this fixture every painted row is gated, so the two gate arms must
    // have walked the same chain and painted the same canvas — the averaging
    // switch has nothing left to average on a gated frame.
    ASSERT_TRUE(allPaintedGated) << "fixture: every painted row must be gated";
    for (size_t i = 0; i < rowsOn.size(); ++i) {
        EXPECT_DOUBLE_EQ(rowsOn[i].posU, rowsNoAvg[i].posU) << "seq " << rowsOn[i].seq;
        EXPECT_DOUBLE_EQ(rowsOn[i].posV, rowsNoAvg[i].posV) << "seq " << rowsOn[i].seq;
    }
    (void)on.finish(); (void)onNoAvg.finish();
    cv::Mat a, b;
    ASSERT_TRUE(on.finalCanvas(a));
    ASSERT_TRUE(onNoAvg.finalCanvas(b));
    ASSERT_EQ(a.size(), b.size());
    EXPECT_EQ(cv::norm(a, b, cv::NORM_INF), 0.0)
        << "gate + crossAvgWindows must paint the gate's canvas byte for byte "
           "when every painted frame is gated";
}

TEST(PanoCrossGate, GateLeavesTheOuterFitOnTheMeasurement) {
    cv::Mat tall = makeFlatCentreShelf(kFrameW, 5000, kFlatBandX0, kFlatBandW);
    FaintDrift drift(100, 1.0, 4.0);
    const auto frames = verticalWalk(100);
    std::string err;
    rnis::pano::Engine log, on;
    // crossFitMode 1 applies the per-frame image-fitted gradient DIRECTLY
    // (row.crossGrad = the clamped fit), which is what makes the fit
    // observable row by row; under the default mode 2 this walk has no
    // forward travel, the distance fit never engages and the applied
    // gradient is 0 on every row whatever the outer bands measured.
    auto cfgLog = testConfig();
    cfgLog.crossResidualGate = 1;
    cfgLog.crossFitMode = 1;
    auto cfgOn = gateCfg(100.0, 50.0, 0.01);
    cfgOn.crossFitMode = 1;
    ASSERT_TRUE(log.configure(cfgLog, &err)) << err;
    ASSERT_TRUE(on.configure(cfgOn, &err)) << err;
    const auto rowsLog = runGateSweep(log, cfgLog, tall, frames, drift, kFxNoiseDN);
    const auto rowsOn = runGateSweep(on, cfgOn, tall, frames, drift, kFxNoiseDN);
    ASSERT_EQ(rowsLog.size(), rowsOn.size());
    // The K windows are attitude-placed and never read the chain, so the
    // outer-band MEASUREMENT — the per-frame gradient fit and the bands the
    // per-band cage admitted — must be the log-only engine's bit for bit on
    // EVERY row: the gate changed what the chain APPLIES, not what the
    // windows MEASURED.  (The first arm referred the fit to the gated 0,
    // which moved the gradient on every gated row.)
    int gated = 0, nonZeroGrad = 0;
    for (size_t i = 0; i < rowsOn.size(); ++i) {
        const auto& g = rowsOn[i];
        const auto& u = rowsLog[i];
        if (g.crossGated != 0) ++gated;
        if (u.crossGrad != 0.0) ++nonZeroGrad;
        EXPECT_EQ(g.outcome, u.outcome) << "seq " << g.seq;
        EXPECT_DOUBLE_EQ(g.crossGrad, u.crossGrad) << "seq " << g.seq;
        EXPECT_EQ(g.seamBands, u.seamBands) << "seq " << g.seq;
        if (g.crossGated != 0)
            EXPECT_DOUBLE_EQ(g.crossResidualRawPx, u.advanceX) << "seq " << g.seq;
    }
    EXPECT_GT(gated, 50) << "fixture: nothing was gated";
    EXPECT_GT(nonZeroGrad, 0) << "fixture: the outer bands must yield a "
                                 "non-zero applied gradient somewhere for "
                                 "this to discriminate";
}

// ── v12: the provisional lead-out ───────────────────────────────────────────
TEST(PanoPreviewLeadOut, OffIsByteIdenticalAndOnAppendsPastTheFrontierOnly) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);
    ASSERT_EQ(eng.stats().axis, 1);

    cv::Mat off, on;
    rnis::pano::PreviewWindow woff, won;
    // 1:1 — no downscale — so the committed region is comparable pixel for
    // pixel (the fitted scale would otherwise differ between the two arms,
    // because the lead-out extends the extent being fitted).
    ASSERT_TRUE(eng.previewIntoFit(off, 100000, 100000, 0, &woff, false, false));
    ASSERT_TRUE(eng.previewIntoFit(on, 100000, 100000, 0, &won, false, true));

    EXPECT_EQ(woff.leadOutPx, 0);
    ASSERT_GT(won.leadOutPx, 0)
        << "mid-sweep, half a footprint is ahead of the frontier — the "
           "lead-out must have something to show";
    EXPECT_EQ(won.viewEndU, woff.viewEndU + won.leadOutPx)
        << "viewEndU must include the lead so the frontier marker divides "
           "committed from provisional";

    // Vertical sweep, sign +1: along = output rows, leading edge = LAST rows.
    ASSERT_EQ(on.cols, off.cols);
    ASSERT_EQ(on.rows, off.rows + won.leadOutPx);
    const cv::Mat committed = on(cv::Rect(0, 0, off.cols, off.rows));
    EXPECT_EQ(cv::norm(committed, off, cv::NORM_INF), 0.0)
        << "the lead-out may only APPEND — committed pixels are the "
           "painter's, never the live frame's";
    const cv::Mat prov = on(cv::Rect(0, off.rows, on.cols, won.leadOutPx));
    EXPECT_GT(cv::norm(prov, cv::NORM_INF), 0.0)
        << "the provisional region must carry the live frame's content";

    // ── 2026-09-03: AND IT IS NOT DIMMED ────────────────────────────────────
    // These columns used to be multiplied by 0.82 to mark them provisional.
    // The operator read that 18% step as a second boundary line and asked for
    // "the exact image you are going to get as the result" — and he is right
    // on the substance: this region is the same `lastBgr` through the same
    // `lastHint` that the tail flush commits at stop.  A dim would show up
    // here as a systematically darker provisional block against the committed
    // band next to it.
    //
    // Compared as MEANS over the lit pixels of each region rather than pixel
    // for pixel: the two regions are different content (different rows of the
    // shelf), so only their exposure is comparable.  A 0.82 multiply is an 18%
    // gap and would fail this by a wide margin; the bar is set at 6% so the
    // test measures the dim and not the shelf's own texture.
    cv::Mat provG, commG;
    cv::cvtColor(prov, provG, cv::COLOR_BGR2GRAY);
    cv::cvtColor(committed, commG, cv::COLOR_BGR2GRAY);
    const cv::Mat provLit = provG > 0, commLit = commG > 0;
    ASSERT_GT(cv::countNonZero(provLit), 1000);
    ASSERT_GT(cv::countNonZero(commLit), 1000);
    const double provMean = cv::mean(provG, provLit)[0];
    const double commMean = cv::mean(commG, commLit)[0];
    EXPECT_NEAR(provMean / commMean, 1.0, 0.06)
        << "the provisional lead-out is being brightness-scaled relative to "
           "the committed band (ratio " << (provMean / commMean) << ") — the "
           "preview must be the output, not a shaded annotation of it";
}

// ── 2026-09-03: THE PRE-LATCH SEED ──────────────────────────────────────────
//
// The operator, on the shipped build: "The preview does not show up when I
// hold the button, I need to start moving for it to appear.  Why?  ...  This
// is creating the issue of not knowing where the pano starts."
//
// This is the regression guard for the answer.  It holds the phone STILL —
// the same frame, no translation, no rotation — which is the input on which
// the axis latch is designed never to fire, and asserts that the preview
// publishes anyway, early, and carries the reference frame's own pixels.
TEST(PanoPreviewSeed, PublishesTheReferenceFrameWithNoMotionAtAll) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    const cv::Mat still = tall(cv::Rect(0, 200, kFrameW, kFrameH)).clone();
    int firstPublish = -1;
    cv::Mat seed;
    rnis::pano::PreviewWindow w;
    for (int i = 0; i < 60; ++i) {
        cv::Mat crop = still.clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 60.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.tracking = 2; in.seq = i;
        eng.ingest(in);
        if (firstPublish < 0
            && eng.previewIntoFit(seed, 2000, 800, 0, &w, true, true)) {
            firstPublish = i;
        }
    }
    EXPECT_FALSE(eng.stats().axisLatched)
        << "a stationary hold must not latch an axis — if it does, this test "
           "is measuring the wrong thing and the seed is untested";
    ASSERT_GE(firstPublish, 0)
        << "60 stationary frames and the panel is still empty — this is the "
           "exact defect the seed exists to fix";
    EXPECT_LE(firstPublish, 8)
        << "the seed must land within the warm-up, not after it: at 60 fps "
           "every frame of delay here is 17 ms of blank panel";

    // IT IS THE REFERENCE FRAME, not a blank of the right size.  Compared
    // against the same INTER_AREA downscale the engine performs, so the only
    // way to pass is to have published those pixels.
    const double sc = std::min(1.0, std::min(2000.0 / kFrameW, 800.0 / kFrameH));
    cv::Mat want;
    cv::resize(still, want, cv::Size((int)std::lround(kFrameW * sc),
                                     (int)std::lround(kFrameH * sc)),
               0, 0, cv::INTER_AREA);
    ASSERT_EQ(seed.cols, want.cols);
    ASSERT_EQ(seed.rows, want.rows);
    EXPECT_EQ(cv::norm(seed, want, cv::NORM_INF), 0.0)
        << "the seed must be the reference frame the engine is holding, not a "
           "re-render of something else";

    // THE WINDOW REPORTS 'NOTHING TO PLACE', explicitly.  The caller reuses one
    // PreviewWindow across ticks, so a field left untouched here would publish
    // a stale frontier under a frame that has none.
    EXPECT_EQ(w.frontierFrac, -1.0);
    EXPECT_EQ(w.leadOutPx, 0);
    EXPECT_FALSE(w.windowed);
    EXPECT_EQ(w.bandEndU - w.bandStartU, 0);

    // AND THE DELIVERABLE IS UNCHANGED.  The seed is preview-only: nothing was
    // painted, so the canvas still refuses, exactly as before this existed.
    cv::Mat finalOut;
    EXPECT_FALSE(eng.finalCanvas(finalOut, false))
        << "the seed leaked into the deliverable — it must be preview-only";
}

// 2026-09-04: AND IT STOPS WHEN THE SWEEP DIES.
//
// The seed's guard was `!anyPainted` alone, and `abort()` never releases
// `refBgr` — so an abort BEFORE the axis latch (reachable: a >maxTranslationJumpM
// step is ARKit relocalising, and it does not wait for the latch) left the panel
// publishing a frozen camera frame, as the panorama, forever, while
// `finalCanvas` refused.  The picture and the deliverable have to agree about
// whether a panorama exists.  On Android the same gap made `PreviewPump::flush`
// publish that frame as the FINAL preview into the pack.
TEST(PanoPreviewSeed, StopsWhenTheSweepAbortsBeforeLatching) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    const cv::Mat still = tall(cv::Rect(0, 200, kFrameW, kFrameH)).clone();
    auto feed = [&](int i, double tx) {
        cv::Mat crop = still.clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 60.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.tracking = 2; in.seq = i;
        in.t[0] = tx;
        eng.ingest(in);
    };

    // Stationary hold: the REFERENCE latches and `refBgr` is cloned, the AXIS
    // latch does not fire (that is the seed's whole premise), and the seed
    // publishes — the precondition this test needs to be about the abort.
    for (int i = 0; i < 12; ++i) feed(i, 0.0);
    cv::Mat out;
    ASSERT_FALSE(eng.stats().axisLatched);
    ASSERT_TRUE(eng.previewIntoFit(out, 2000, 800, 0, nullptr, true, true))
        << "the seed must be publishing before the abort, or this test proves "
           "nothing about the abort";

    // One frame a full metre away — ARKit relocalising onto a new origin.
    feed(12, cfg.maxTranslationJumpM + 1.0);
    ASSERT_STREQ(eng.stats().abortReason.c_str(), "session-restart")
        << "the fixture failed to trip the abort it is testing";
    EXPECT_FALSE(eng.stats().axisLatched)
        << "this must be the PRE-latch abort — the post-latch one is a "
           "different path and is covered elsewhere";

    EXPECT_FALSE(eng.previewIntoFit(out, 2000, 800, 0, nullptr, true, true))
        << "an aborted sweep kept publishing its reference frame as the "
           "panorama — the panel would show a still photo of a sweep that "
           "produces no canvas";

    // The deliverable already refused; the point is that the preview now
    // agrees with it rather than contradicting it.
    cv::Mat finalOut;
    EXPECT_FALSE(eng.finalCanvas(finalOut, false));
}

// The other half of the same claim: once a strip commits, the seed path is
// gone and the preview is the PAINTED band again.  Without this the seed could
// silently keep showing the reference frame for a whole sweep.
TEST(PanoPreviewSeed, StopsTheMomentTheFirstStripCommits) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);
    ASSERT_EQ(eng.stats().axis, 1);

    cv::Mat out;
    rnis::pano::PreviewWindow w;
    ASSERT_TRUE(eng.previewIntoFit(out, 2000, 800, 0, &w, true, false));
    EXPECT_GT(w.bandEndU - w.bandStartU, 0)
        << "past the latch the preview must report a real painted band, which "
           "the seed path never does";
}

// ── 2026-09-04: the window multiple and the publish must mean the same cross ─
//
// `windowPx = mult * cross`, where `mult` is the on-screen capsule's own
// along/cross ratio — so the window is meant to engage exactly at the knee
// where the panorama stops filling the capsule's thickness.  Both hosts used
// `canvasHeightPx()`, the PADDED height, while `previewCropPad` (on by default)
// trims those pad rows out of what is published: the window engaged late, and
// in the gap the panorama drew thin inside a fixed-thickness strip with black
// bars down both long edges, then snapped.  This pins the accessor the hosts
// now multiply against to the height the publish actually carries.
TEST(PanoPreviewCrossPx, MatchesTheCrossThePublishActuallyCarries) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    EXPECT_EQ(eng.previewCrossPx(true), 0)
        << "before the latch sizes the canvas there is no cross to report, "
           "and 0 is what the hosts test for";

    runVerticalSweep(eng, cfg, tall, 120, +1);
    ASSERT_TRUE(eng.stats().axisLatched);

    const int padded = eng.canvasHeightPx();
    const int trimmed = eng.previewCrossPx(true);
    ASSERT_GT(padded, 0);
    EXPECT_EQ(eng.previewCrossPx(false), padded)
        << "with the trim off the two must be the same number";
    EXPECT_GT(trimmed, 0);
    EXPECT_LT(trimmed, padded)
        << "the canvas carries two unpainted pads; if the trim is not smaller "
           "this fixture is not exercising the thing that broke";

    // THE CONTRACT: it is the cross `previewIntoFit` publishes, to the pixel.
    // Rendered with an enormous box so the fit cannot rescale and hide a
    // mismatch, and with the window off so only the pad trim is in play.
    cv::Mat out;
    rnis::pano::PreviewWindow w;
    ASSERT_TRUE(eng.previewIntoFit(out, 100000, 100000, 0, &w, true, false));
    EXPECT_EQ(w.viewCrossPx, trimmed)
        << "the accessor and the renderer disagree about the published cross "
           "— which is exactly the bug, one level down";
    // axis 1 here, so `orient` transposes: the published CROSS is the width.
    ASSERT_EQ(eng.stats().axis, 1);
    EXPECT_EQ(out.cols, trimmed);
}

// ── v12: the final canvas learns the preview's pad trim ─────────────────────
TEST(PanoFinalCanvas, CropPadRowsLosesNoCommittedPixelAndDropsOnlyBlackPad) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);
    (void)eng.finish();

    cv::Mat full, trimmed;
    ASSERT_TRUE(eng.finalCanvas(full, false));
    ASSERT_TRUE(eng.finalCanvas(trimmed, true));
    // Vertical sweep: the cross axis (where the pads live) is the output
    // WIDTH; the sweep extent is untouched.
    ASSERT_EQ(full.rows, trimmed.rows);
    ASSERT_LT(trimmed.cols, full.cols)
        << "this sweep never paints the pads, so the trim must remove them";
    // The row UNION cannot cut a committed pixel: every non-black pixel of
    // the full render must survive into the trimmed one.
    cv::Mat fullG, trimG;
    cv::cvtColor(full, fullG, cv::COLOR_BGR2GRAY);
    cv::cvtColor(trimmed, trimG, cv::COLOR_BGR2GRAY);
    EXPECT_EQ(cv::countNonZero(fullG), cv::countNonZero(trimG))
        << "the pad trim removed committed content, not just black pad";
}

TEST(PanoPreviewWindow, CropPadRowsTrimsONLYRowsNOTHINGPainted) {
    // MEASURED, and it was found by rendering the operator's own pack rather
    // than by any number in it: the canvas is one footprint plus TWO pads
    // (1920 x 0.5 + 2 x 128 = 1216 rows), so 256 rows — 21% — are pad nothing
    // will ever paint. The live preview took all of them, which put black bars
    // over a fifth of his panel AND, because the panel hugs the preview's
    // aspect, drew the shelf 21% smaller than the phone was willing to.
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);

    cv::Mat full, cropped;
    rnis::pano::PreviewWindow wf, wc;
    ASSERT_TRUE(eng.previewIntoFit(full, 100000, 100000, 0, &wf, false));
    ASSERT_TRUE(eng.previewIntoFit(cropped, 100000, 100000, 0, &wc, true));

    // The along axis is untouched — this crops the CROSS axis only.
    ASSERT_EQ(cropped.rows, full.rows);
    EXPECT_LT(cropped.cols, full.cols) << "the pad must actually be gone";
    EXPECT_EQ(wf.viewCrossPx, wf.canvasCrossPx);
    EXPECT_EQ(wc.viewCrossPx, cropped.cols);
    EXPECT_LT(wc.viewCrossPx, wc.canvasCrossPx);

    // AND IT LOSES NOTHING. Every non-black column of the full view must
    // survive: this is the row UNION, so it can only remove rows no frame ever
    // committed. (`cropVertical` cuts to the per-column INTERSECTION and CAN
    // remove real content — that is a different function and stays untouched.)
    cv::Mat grayFull, grayCrop;
    cv::cvtColor(full, grayFull, cv::COLOR_BGR2GRAY);
    cv::cvtColor(cropped, grayCrop, cv::COLOR_BGR2GRAY);
    EXPECT_EQ(cv::countNonZero(grayFull), cv::countNonZero(grayCrop))
        << "cropping the pad must not lose one painted pixel";
    // A vertical sweep is transposed on output, so the pad is a COLUMN band
    // there; it is the same rows either way.
    EXPECT_GT(full.cols - cropped.cols, 100)
        << "full " << full.cols << " cropped " << cropped.cols;
}

TEST(PanoPreviewWindow, CropPadRowsIsOffByDefaultAndCombinesWithTheWindow) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    runVerticalSweep(eng, cfg, tall, 120, +1);

    // DEFAULT OFF: the three-argument call every pre-existing caller makes is
    // byte-identical to the explicit `false`.
    cv::Mat a, b;
    ASSERT_TRUE(eng.previewIntoFit(a, 2000, 800));
    ASSERT_TRUE(eng.previewIntoFit(b, 2000, 800, 0, nullptr, false));
    ASSERT_EQ(a.size(), b.size());
    EXPECT_EQ(cv::norm(a, b, cv::NORM_INF), 0.0);

    // AND THE TWO COMPOSE: the window trims the along axis, the pad crop the
    // cross one, and neither disturbs the other's extent.
    rnis::pano::PreviewWindow probe;
    cv::Mat whole;
    ASSERT_TRUE(eng.previewIntoFit(whole, 100000, 100000, 0, &probe, true));
    const int windowPx = (probe.bandEndU - probe.bandStartU) / 2;
    ASSERT_GT(windowPx, 32);
    cv::Mat both;
    rnis::pano::PreviewWindow wb;
    ASSERT_TRUE(eng.previewIntoFit(both, 100000, 100000, windowPx, &wb, true));
    EXPECT_EQ(both.cols, whole.cols) << "the cross crop is unchanged by the window";
    EXPECT_EQ(both.rows, windowPx);
    const cv::Mat tailOfWhole = whole(cv::Rect(0, whole.rows - windowPx,
                                               whole.cols, windowPx));
    EXPECT_EQ(cv::norm(both, tailOfWhole, cv::NORM_INF), 0.0);
}

TEST(PanoPreviewWindow, WorksOnAHorizontalSweepToo) {
    const cv::Mat shelf = makeShelf(8000, kFrameH);
    auto cfg = testConfig();
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    const auto xs = linearSweep(200, 20, 180);
    for (size_t i = 0; i < xs.size(); ++i) {
        cv::Mat crop = shelf(cv::Rect((int)xs[i], 0, kFrameW, kFrameH)).clone();
        cv::Mat g, gw;
        cv::cvtColor(crop, g, cv::COLOR_BGR2GRAY);
        cv::resize(g, gw, cv::Size(), cfg.workScale, cfg.workScale, cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &gw;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = xs[i] * (0.6 / kFx);
        in.tracking = 2; in.seq = (int64_t)i;
        eng.ingest(in);
    }
    ASSERT_EQ(eng.stats().axis, 0);
    rnis::pano::PreviewWindow probe, win;
    cv::Mat whole, view;
    ASSERT_TRUE(eng.previewIntoFit(whole, 100000, 100000, 0, &probe));
    const int windowPx = (probe.bandEndU - probe.bandStartU) / 2;
    ASSERT_GT(windowPx, 32);
    ASSERT_TRUE(eng.previewIntoFit(view, 100000, 100000, windowPx, &win));
    EXPECT_TRUE(win.windowed);
    ASSERT_EQ(view.rows, whole.rows);
    ASSERT_EQ(view.cols, windowPx) << "a horizontal sweep windows the COLUMNS";
    const cv::Mat tailOfWhole = whole(cv::Rect(whole.cols - windowPx, 0,
                                               windowPx, whole.rows));
    EXPECT_EQ(cv::norm(view, tailOfWhole, cv::NORM_INF), 0.0);
}

TEST(PanoFinalize, TailFlushExtendsThePanoramaPastTheFrontier) {
    const cv::Mat shelf = makeShelf(8000, kFrameH);
    auto cfg = testConfig();
    const auto xs = linearSweep(300, 20, 160);

    // Without finish(): the canvas stops at the last strip's frontier.
    rnis::pano::Engine a;
    std::string err;
    ASSERT_TRUE(a.configure(cfg, &err)) << err;
    for (size_t i = 0; i < xs.size(); ++i) {
        cv::Mat crop = shelf(cv::Rect((int)xs[i], 0, kFrameW, kFrameH)).clone();
        cv::Mat g, gw;
        cv::cvtColor(crop, g, cv::COLOR_BGR2GRAY);
        cv::resize(g, gw, cv::Size(), cfg.workScale, cfg.workScale, cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &gw;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = xs[i] * (0.6 / kFx);
        in.tracking = 2; in.seq = (int64_t)i;
        a.ingest(in);
    }
    cv::Mat before;
    ASSERT_TRUE(a.finalCanvas(before));
    const auto tail = a.finish();
    cv::Mat after;
    ASSERT_TRUE(a.finalCanvas(after));

    EXPECT_EQ(tail.outcome, rnis::pano::Outcome::TailFlush);
    EXPECT_GT(tail.canvasX1, tail.canvasX0);
    // The lead-out is worth roughly half a frame of canvas.
    EXPECT_GT(after.cols - before.cols, 0.3 * kFrameW * cfg.canvasScale);
    EXPECT_TRUE(a.unpaintedRuns().empty());
    // Idempotent — a second finish() must not paint again.
    const auto again = a.finish();
    EXPECT_EQ(again.canvasX0, again.canvasX1);
}

TEST(PanoFinalize, CropVerticalNarrowsToTheCommonBand) {
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    const auto xs = linearSweep(400, 20, 130);

    auto off = testConfig();
    auto on = testConfig();
    on.cropVertical = true;

    SweepResult a = runSweep(shelf, xs, {}, off);
    SweepResult b = runSweep(shelf, xs, {}, on);
    ASSERT_FALSE(a.canvas.empty());
    ASSERT_FALSE(b.canvas.empty());

    // Default OFF: the canvas keeps its perpendicular padding, so the ragged
    // attitude-rectified edge is REPORTED (verticalEnvelope), not hidden.
    EXPECT_EQ(a.canvas.rows, 2 * off.canvasPadPx +
                                 (int)std::lround(kFrameH * off.canvasScale));
    // ON: narrowed to the band every painted column shares.
    EXPECT_LT(b.canvas.rows, a.canvas.rows);
    EXPECT_NEAR(b.canvas.rows, kFrameH * on.canvasScale, 6);
}

// The strict common-band definition can legitimately DECLINE: under a real
// attitude excursion the per-column extremes can cross, and cropping to that
// would cut real content.  The engine then keeps the full height rather than
// silently discarding pixels — pinned here so the behaviour is a decision, not
// a surprise.
TEST(PanoFinalize, CropVerticalDeclinesRatherThanCuttingRealContent) {
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    const auto xs = linearSweep(400, 20, 130);
    std::vector<double> rolls;
    for (size_t i = 0; i < xs.size(); ++i)
        rolls.push_back(6.0 * std::sin(2.0 * CV_PI * (double)i / 40.0));

    auto on = testConfig();
    on.cropVertical = true;
    SweepResult b = runSweep(shelf, xs, rolls, on);
    ASSERT_FALSE(b.canvas.empty());
    EXPECT_GT(b.canvas.rows, 200);   // never a degenerate sliver
    EXPECT_LE(b.canvas.rows, 2 * on.canvasPadPx +
                                 (int)std::lround(kFrameH * on.canvasScale));
}


// RESTORED (it was dropped when the v5 block was written, and the behaviour it
// pins is unchanged and was left uncovered).  minCropBandPx() measures the
// decline bar against ONE FRAME'S FOOTPRINT, never against canvasH — canvasH
// carries 2×canvasPadPx of pure pad plus every vertical growth the sweep
// caused, so a canvasH-relative bar TIGHTENS as the panorama gets longer and
// the crop would decline hardest on exactly the sweeps whose ragged edge is
// worst.  The bar is a property of the camera, not of the sweep.
TEST(PanoFinalize, TheCropBarDoesNotTightenAsThePanoramaGrows) {
    const cv::Mat shelf = makeShelf(9600, kFrameH);

    // Pad chosen so 0.25×canvasH EXCEEDS the whole footprint: a canvasH-
    // relative bar would refuse this crop outright, a footprint-relative one
    // accepts it.  That is the discriminator, so assert on it directly.
    auto cfg = testConfig();
    cfg.cropVertical = true;
    cfg.canvasPadPx = 900;
    cfg.canvasMaxHeightPx = 4096;    // the pad alone exceeds the 2048 default
    cfg.canvasMaxPixels = 60.0e6;    // ...and so does pad x doubled width
    const double footprintV = kFrameH * cfg.canvasScale;      // 540
    const double canvasHFull = footprintV + 2 * cfg.canvasPadPx;   // 2340
    ASSERT_GT(0.25 * canvasHFull, footprintV)
        << "fixture no longer separates the two candidate bars";

    SweepResult shortSweep = runSweep(shelf, linearSweep(20, 20, 60), {}, cfg);
    SweepResult longSweep  = runSweep(shelf, linearSweep(20, 20, 380), {}, cfg);
    ASSERT_FALSE(shortSweep.canvas.empty());
    ASSERT_FALSE(longSweep.canvas.empty());

    // The panorama really did grow.
    EXPECT_GT(longSweep.stats.paintedW, 3 * shortSweep.stats.paintedW);

    // The crop was HONOURED in both — and to the same height, because the bar
    // and the band are both properties of one frame.
    EXPECT_NEAR(shortSweep.canvas.rows, footprintV, 6);
    EXPECT_NEAR(longSweep.canvas.rows, footprintV, 6);
    // Measured 539 vs 536: the common band narrows by 0.6% while the panorama
    // grows 6x, which is sub-pixel resampling of the footprint edge, not the
    // bar moving.  A canvasH-relative bar would have declined BOTH.
    EXPECT_NEAR(shortSweep.canvas.rows, longSweep.canvas.rows, 5);
    // ...and a canvasH-relative bar would have declined both of them.
    EXPECT_LT((double)longSweep.canvas.rows, 0.25 * canvasHFull);
    EXPECT_LT((double)longSweep.canvas.rows, (double)longSweep.stats.canvasH);
}


// ── THE MIS-LATCH REGRESSION SUITE ─────────────────────────────────────────
//
// Two reviews of the v3 engine each found the SAME defect from a different
// direction, and both reproduce a ONE-FRAME CANVAS at shipped defaults:
//
//   * a shelf WALK carrying incidental pitch — rotation and translation on
//     PERPENDICULAR axes — latched the axis across the sweep, because the
//     rotation fast path compared ‖rotation‖∞ against ‖residual‖∞ and those
//     are ∞-norms of two vectors that need not be parallel;
//   * a walk carrying a TRANSIENT tilt (levelling the phone, ordinary hand
//     jitter) latched on the wobble, because over a short horizon a rising
//     transient and a real sweep are the same signal — and disabling the
//     rotation channel did not help, so no threshold could fix it.
//
// Every fixture below is TRANSVERSE by construction: the rotation is on the
// axis PERPENDICULAR to the translation.  The v3 suite had no such fixture —
// every mixed case put pitch and dy on the same axis, where an axis mis-vote
// is impossible — which is exactly why the suite was green while the engine
// produced one frame.
namespace {

struct GestureStep {
    double x0 = 0, y0 = 0;
    Quat   q  = {0, 0, 0, 1};
};

SweepResult runGestureSweep(const cv::Mat& shelf,
                            const std::vector<GestureStep>& steps,
                            const rnis::pano::Config& cfg) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;

    SweepResult out;
    for (size_t i = 0; i < steps.size(); ++i) {
        cv::Mat crop = renderProjectedFrame(shelf, steps[i].x0, steps[i].y0,
                                            steps[i].q);
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        for (int k = 0; k < 4; ++k) in.q[k] = steps[i].q[k];
        in.t[0] = steps[i].x0 * (0.6 / kFx);
        in.t[1] = steps[i].y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = (int64_t)i;
        out.rows.push_back(eng.ingest(in));
    }
    out.rows.push_back(eng.finish());
    eng.finalCanvas(out.canvas);
    // Rendered with the SAME `cropPadRows` as the canvas one line up — which
    // is the only argument that can separate the two, and the reason
    // `finalCoverage` takes it at all. See the PanoCoverage block.
    eng.finalCoverage(out.coverage);
    out.stats = eng.stats();
    out.holes = eng.unpaintedRuns();
    out.envelope = eng.verticalEnvelope();
    return out;
}

/// A horizontal walk of `dx` shelf px/frame carrying a PITCH (i.e. vertical,
/// transverse) disturbance given by `tilt(i)` degrees.
std::vector<GestureStep> walkWithTransversePitch(
    int n, double dx, const std::function<double(int)>& tilt) {
    std::vector<GestureStep> steps;
    steps.reserve(n);
    for (int i = 0; i < n; ++i) {
        steps.push_back({1400.0 + dx * (double)i, 1400.0, pitchQuat(tilt(i))});
    }
    return steps;
}

}  // namespace

// Reviewer A's geometry: the hand settles into a tilt while the feet walk.
// The tilt is MONOTONE, so it never "returns" — the axis must still follow the
// walk.  Pre-fix this produced paintedW ≈ one frame and painted == 1.
TEST(PanoMisLatch, AWalkCarryingASettlingTransverseTiltSweepsAlongTheWalk) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    for (double settleDeg : {2.0, 3.0, 4.0, 6.0}) {
        for (int settleN : {8, 10, 20}) {
            for (double dx : {5.0, 8.0, 14.0}) {
                const auto steps = walkWithTransversePitch(
                    140, dx, [&](int i) {
                        return settleDeg * std::min(1.0, (double)i / settleN);
                    });
                SweepResult r = runGestureSweep(shelf, steps, cfg);
                const std::string what =
                    "dx=" + std::to_string((int)dx) + " settle=" +
                    std::to_string((int)settleDeg) + "deg/" +
                    std::to_string(settleN) + "f";
                EXPECT_EQ(r.stats.axis, 0) << what << " latched ACROSS the walk";
                EXPECT_EQ(r.stats.sweepSign, 1) << what;
                // The deliverable, not an intermediate: a real panorama.
                EXPECT_GT(sweepGrowthPx(r, cfg), 0.55 * cfg.canvasScale * dx * 139.0)
                    << what << " grew only " << sweepGrowthPx(r, cfg);
                EXPECT_GT(r.stats.painted, 40) << what;
                EXPECT_TRUE(r.holes.empty()) << what;
            }
        }
    }
}

// Reviewer B's geometry: a TRANSIENT tilt — the operator levels the phone
// mid-walk and it returns.  At the moment of the vote this is indistinguishable
// from a pivot, which is why the latch has to be able to change its mind.
TEST(PanoMisLatch, ATransientTransverseTiltDoesNotCaptureTheAxis) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    for (double amp : {6.0, 8.0, 12.0}) {
        for (int dur : {20, 40, 60}) {
            for (double dx : {8.0, 14.0, -14.0}) {
                const auto steps = walkWithTransversePitch(
                    120, dx, [&](int i) {
                        return i < dur ? amp * std::sin(CV_PI * (double)i / dur)
                                       : 0.0;
                    });
                SweepResult r = runGestureSweep(shelf, steps, cfg);
                const std::string what =
                    "dx=" + std::to_string((int)dx) + " tilt=" +
                    std::to_string((int)amp) + "deg/" + std::to_string(dur) + "f";
                EXPECT_EQ(r.stats.axis, 0) << what << " latched on the wobble";
                EXPECT_EQ(r.stats.sweepSign, dx > 0 ? 1 : -1) << what;
                EXPECT_GT(r.stats.painted, 30) << what << " painted "
                                               << r.stats.painted << " frames";
                EXPECT_TRUE(r.holes.empty()) << what;
            }
        }
    }
}

// THE COIN-FLIP PROPERTY, stated as a test.  Ordinary handheld tremor is a
// wobble with an arbitrary phase at the moment the latch fires; a latch that
// reads one instant passes or fails depending on that phase.  The outcome must
// not depend on it.
TEST(PanoMisLatch, HandTremorDuringAWalkIsNotAPhaseLottery) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    for (double amp : {3.0, 6.0}) {
        for (double w : {0.15, 0.35, 0.70}) {
            for (double phase : {0.0, 1.0, 2.0, 3.0, 4.0, 5.0}) {
                const auto steps = walkWithTransversePitch(
                    120, 14.0,
                    [&](int i) { return amp * std::sin(phase + w * (double)i); });
                SweepResult r = runGestureSweep(shelf, steps, cfg);
                const std::string what = "amp=" + std::to_string((int)amp) +
                                         " w=" + std::to_string(w) +
                                         " phase=" + std::to_string(phase);
                EXPECT_EQ(r.stats.axis, 0) << what;
                EXPECT_EQ(r.stats.sweepSign, 1) << what;
                EXPECT_GT(r.stats.painted, 30) << what;
                EXPECT_TRUE(r.holes.empty()) << what;
            }
        }
    }
}

// ── RELATCH: the correction, and its cost ──────────────────────────────────

// The correction must be VISIBLE.  A panorama that starts partway into the
// sweep because the engine changed its mind is a different finding from a
// panorama that is simply short, and the pack has to say which it was.
TEST(PanoRelatch, ACorrectionIsCountedInTheStatsAndFlaggedOnItsRow) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    // A tilt big enough to capture the vote, on the axis across the walk.
    const auto steps = walkWithTransversePitch(120, 14.0, [](int i) {
        return i < 20 ? 8.0 * std::sin(CV_PI * (double)i / 20.0) : 0.0;
    });
    SweepResult r = runGestureSweep(shelf, steps, cfg);

    EXPECT_GT(r.stats.relatchCount, 0) << "the mis-latch was never corrected";
    int flagged = 0;
    for (const auto& row : r.rows) if (row.relatched) ++flagged;
    EXPECT_EQ(flagged, r.stats.relatchCount)
        << "relatchCount and the flagged rows disagree";
    // ...and the corrected sweep is a real panorama.
    EXPECT_EQ(r.stats.axis, 0);
    EXPECT_TRUE(r.holes.empty());
}

// THE GUARD AGAINST THE CURE.  A relatch DISCARDS the canvas, so it must be
// impossible on a sweep that is working.  Every regime that latches correctly
// has to report relatchCount == 0 — the check disarms as soon as the panorama
// is real and never looks again.
TEST(PanoRelatch, NeverFiresOnASweepThatIsAlreadyWorking) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    struct Case { const char* name; ProjSweepSpec spec; };
    const std::vector<Case> cases = {
        {"pivot pitch -18", [] { ProjSweepSpec s; s.n=120; s.pitchDeg=-18; return s; }()},
        {"pivot pitch +18", [] { ProjSweepSpec s; s.n=120; s.pitchDeg= 18; return s; }()},
        {"walk dx +14",     [] { ProjSweepSpec s; s.n=120; s.dx= 14; return s; }()},
        {"walk dx -14",     [] { ProjSweepSpec s; s.n=120; s.dx=-14; return s; }()},
        {"walk dy +14",     [] { ProjSweepSpec s; s.n=120; s.dy= 14; return s; }()},
        {"walk dx +3 slow", [] { ProjSweepSpec s; s.n=120; s.dx=  3; return s; }()},
        {"mixed collinear", [] { ProjSweepSpec s; s.n=120; s.pitchDeg=-12; s.dy=6; return s; }()},
        {"mixed opposing",  [] { ProjSweepSpec s; s.n=120; s.pitchDeg=  8; s.dy=12; return s; }()},
    };
    for (const auto& c : cases) {
        SweepResult r = runProjectedSweep(shelf, c.spec, cfg);
        EXPECT_EQ(r.stats.relatchCount, 0)
            << c.name << " discarded a working canvas";
        EXPECT_TRUE(r.holes.empty()) << c.name;
        EXPECT_GT(r.stats.painted, 40) << c.name;
    }
}

// The dominance guard refuses to correct on AMBIGUOUS evidence.  A diagonal
// sweep is permanently ambiguous by construction, so the guard could in
// principle deadlock it — it does not, and the reason is measurable: a diagonal
// projects ~0.7 of its motion onto whichever axis latched, so the canvas grows
// and the check disarms before the guard is ever consulted.
TEST(PanoRelatch, ADiagonalSweepIsNeverDeadlockedByTheDominanceGuard) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    for (double angDeg : {20.0, 35.0, 45.0, 55.0, 70.0}) {
        const double a = angDeg * CV_PI / 180.0;
        std::vector<GestureStep> steps;
        for (int i = 0; i < 120; ++i) {
            steps.push_back({1400.0 + 14.0 * std::cos(a) * i,
                             1400.0 + 14.0 * std::sin(a) * i, identityQuat()});
        }
        SweepResult r = runGestureSweep(shelf, steps, cfg);
        const std::string what = std::to_string((int)angDeg) + "deg diagonal";
        EXPECT_EQ(r.stats.relatchCount, 0) << what;
        EXPECT_GT(r.stats.painted, 60) << what;
        EXPECT_GT(sweepGrowthPx(r, cfg), 300.0) << what;
        EXPECT_TRUE(r.holes.empty()) << what;
    }
}

// ── The ledger identity, on the rows that USED to break it ─────────────────

TEST(PanoLedger, TheAdvanceIdentityHoldsOnRejectedRowsToo) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    auto cfg = testConfig();
    // Subject: the ledger identity on REJECTED rows, not the window.  The
    // gesture below is calibrated to break the 192x144 work window (measured:
    // out-of-cage at seq 10, then 58 stall-floor refusals and `chain-lost`);
    // a 384x288 one measures the same burst cleanly at response 0.59-0.99 and
    // the fixture produces no rejection at all, so it pins its own window.
    cfg.phaseWindowPx = 384;
    // A rotation rate past the correlation cage LOSES the chain, and every
    // frame after it is refused by stallResumeResponse — the cage's "never resume
    // on a lie" rule.  Those refused rows are exactly the ones whose advanceTot
    // used to be published as 0 beside a non-zero advanceRot, i.e. as a broken
    // identity rather than as a rejection.  (Setting stallResumeResponse alone
    // produces nothing: the stall floor only applies once a rejection has
    // already happened, so the fixture has to cause the first one.)
    const auto steps = walkWithTransversePitch(120, 14.0, [](int i) {
        return i < 10 ? 16.0 * std::sin(CV_PI * (double)i / 10.0) : 0.0;
    });
    SweepResult r = runGestureSweep(shelf, steps, cfg);

    int rejected = 0, advanced = 0;
    for (const auto& row : r.rows) {
        if (row.outcome == rnis::pano::Outcome::TailFlush) continue;
        EXPECT_NEAR(row.advanceTotX, row.advanceRotX + row.advanceX, 1e-9);
        EXPECT_NEAR(row.advanceTotY, row.advanceRotY + row.advanceY, 1e-9);
        if (row.chainAdvanced) ++advanced;
        if (row.outcome == rnis::pano::Outcome::RejectedLowResponse) {
            ++rejected;
            EXPECT_FALSE(row.chainAdvanced);
            EXPECT_EQ(row.advanceX, 0.0);
            EXPECT_EQ(row.advanceY, 0.0);
        }
    }
    EXPECT_GT(rejected, 10) << "fixture produced no response-floor rejections";
    EXPECT_GT(advanced, 5);
}

// THE SUMMARY'S IDENTITY, tested where it is easiest to break: a DELAYED
// latch.  rotTravelPx + resTravelPx must equal the panorama's own growth even
// when the motion gate held the engine in bootstrap for a long, moving run.
//
// This is the test that settles which frames count.  Pre-latch frames paint
// nothing, so excluding them looks right — and is wrong: the bootstrap paints
// the reference frame's WHOLE footprint and the first post-latch strip spans
// back to the frontier, so the pre-latch excursion IS in the panorama.
// Excluding it was measured at travel 641 vs growth 822 on this very fixture.
TEST(PanoRegime, TheTravelIdentityHoldsEvenWhenTheLatchIsDelayed) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    auto cfg = testConfig();
    // A high gate keeps the engine in bootstrap for a long, MOVING run.
    cfg.latchTotalPx = 180.0;

    ProjSweepSpec s; s.n = 120; s.dx = 14.0;
    SweepResult r = runProjectedSweep(shelf, s, cfg);

    ASSERT_TRUE(r.stats.axisLatched);
    EXPECT_GT(r.stats.latchFramesUsed, 15) << "fixture did not delay the latch";
    const double travel = r.stats.rotTravelPx + r.stats.resTravelPx;
    EXPECT_NEAR(travel, sweepGrowthPx(r, cfg), 0.15 * travel)
        << "travel " << travel << " vs growth " << sweepGrowthPx(r, cfg);
}

// ── The cage bounds the quantity the painter actually consumes ────────────
//
// AN INVARIANT GUARD, and honestly NOT a regression witness — stated plainly
// because a test that looks like proof and is not is worse than no test.
//
// `du` is the SUM of both channels, but the cage used to bound only the
// RESIDUAL, leaving the attitude channel with no per-frame rate gate at all —
// so on paper a single-frame rotation could open the interior hole
// PanoGap.TheClampedCageMakesInteriorGapsUnreachable calls impossible.
// Measured, that gap is not reachable TODAY: by the rotation rate where the
// total would pass the cage (~6°/frame) the rectification residual has itself
// exploded to ~144 px and the residual cage rejects the frame first (2°/f:
// total 24.8, residual 0.3 — accepted; 6°/f: total 311, residual 144 —
// rejected).  So this test passes on the pre-fix engine too.  It is kept
// because the inequality it pins is what the interior-gap proof rests on: if a
// future window/cage change ever lets the residual stay small at a high
// rotation rate, this fails instead of a hole appearing in a field pack.
TEST(PanoGap, TheCagedQuantityIsTheTotalStepNotOnlyTheResidual) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    // A rotation rate well past the cage, on an otherwise still camera.
    std::vector<GestureStep> steps;
    for (int i = 0; i < 60; ++i) {
        steps.push_back({1400.0, 1400.0, pitchQuat(-0.55 * i)});
    }
    SweepResult r = runGestureSweep(shelf, steps, cfg);

    for (const auto& row : r.rows) {
        if (!row.chainAdvanced) continue;
        const double tot = std::hypot(row.advanceTotX, row.advanceTotY);
        EXPECT_LE(tot, r.stats.maxAdvancePxResolved + 1e-6)
            << "an accepted frame stepped " << tot << " px past the cage";
    }
    EXPECT_TRUE(r.holes.empty());
}

// A sweep can legitimately end before the motion gate resolves — the operator
// stopped early, or never moved decisively.  That must still yield a canvas:
// returning nothing at all reads as a crash rather than as "you did not sweep".
TEST(PanoFinalize, ASweepThatNeverLatchesStillProducesACanvas) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    auto cfg = testConfig();
    cfg.latchTotalPx = 1.0e6;          // unreachable
    cfg.axisLatchMaxFrames = 100000;   // never times out either

    ProjSweepSpec s; s.n = 30; s.dx = 4.0;
    SweepResult r = runProjectedSweep(shelf, s, cfg);

    ASSERT_FALSE(r.canvas.empty())
        << "a short sweep produced no output object at all";
    EXPECT_GT(r.canvas.cols, 0);
    EXPECT_GT(r.canvas.rows, 0);
    EXPECT_TRUE(r.stats.latchWasWeak)
        << "a forced finalize latch must declare itself weak";
    EXPECT_TRUE(r.holes.empty());
}


// ── v5: PROJECTION, CROSS-SWEEP PLACEMENT, AND THE CUT METRIC ───────────────
//
// WHY THIS BLOCK EXISTS.  The operator rejected v4's output — "there is wobble,
// warping and cuts through the output in multiple places" — while v4's own
// integrity verdict reported all four device packs CLEAN (unpaintedColumns 0,
// gapBreak 0, clipping.frames 0).  A quality gate that passes visibly broken
// output is the same failure class as the vertical-clipping blind spot v2
// fixed, so every test below asserts on a quantity v4 does not have, and each
// one is RED when its v5 knob is turned off.

/// A camera walking a shelf AND moving toward it.  Moving forward toward a
/// fronto-parallel plane scales the image exactly about the principal point,
/// so a centred crop resampled to the full frame IS forward motion — and it is
/// the one fixture v4 structurally cannot register, because its model is a
/// single translation fitted in a 384 px window at the frame centre.
///
/// GL convention: the camera looks down −Z, so moving FORWARD means t[2] gets
/// more negative.  Getting that backwards makes the plane prior push the
/// panorama the wrong way, which is exactly the bug the device packs caught.
SweepResult runApproachSweep(const cv::Mat& shelf, int n, double dxPx,
                             double totalForwardM, double planeM,
                             const rnis::pano::Config& cfg,
                             double exposureAmp = 0.0) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;

    SweepResult out;
    const double x0ref = 900.0, y0ref = 900.0;
    for (int i = 0; i < n; ++i) {
        const double z = totalForwardM * (double)i / (double)std::max(1, n - 1);
        const double k = planeM / std::max(1e-3, planeM - z);   // magnification
        int w = (int)std::lround((double)kFrameW / k);
        int h = (int)std::lround((double)kFrameH / k);
        w = std::min(w, kFrameW); h = std::min(h, kFrameH);
        const int cx0 = (int)std::lround(x0ref + dxPx * (double)i) + (kFrameW - w) / 2;
        const int cy0 = (int)std::lround(y0ref) + (kFrameH - h) / 2;
        cv::Mat crop;
        cv::resize(shelf(cv::Rect(cx0, cy0, w, h)), crop,
                   cv::Size(kFrameW, kFrameH), 0, 0, cv::INTER_LINEAR);
        if (exposureAmp > 0.0) {
            const double g = 1.0 + exposureAmp * std::sin(2.0 * CV_PI * (double)i / 23.0);
            cv::convertScaleAbs(crop, crop, g, 0.0);
        }
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);

        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = (x0ref + dxPx * (double)i) * (planeM / kFx);
        in.t[1] = y0ref * (planeM / kFy);
        in.t[2] = -z;                       // GL: forward is −Z
        in.tracking = 2;
        in.seq = (int64_t)i;
        out.rows.push_back(eng.ingest(in));
    }
    out.rows.push_back(eng.finish());
    eng.finalCanvas(out.canvas);
    // Rendered with the SAME `cropPadRows` as the canvas one line up — which
    // is the only argument that can separate the two, and the reason
    // `finalCoverage` takes it at all. See the PanoCoverage block.
    eng.finalCoverage(out.coverage);
    out.stats = eng.stats();
    out.holes = eng.unpaintedRuns();
    out.envelope = eng.verticalEnvelope();
    return out;
}

rnis::pano::Config planarConfig() {          // the v4 control arm
    auto c = testConfig();
    c.projection = 0;
    c.crossSweepFit = false;
    return c;
}

/// Median |along-sweep advanceTot| over the first / last `frac` of the
/// chain-advancing rows.  A CONSTANT-rate pivot has a constant ARC-length
/// advance and a tan-growing gnomonic one.
double advanceRatioEarlyLate(const SweepResult& r, double frac = 0.25) {
    std::vector<double> v;
    for (const auto& row : r.rows) {
        if (!row.chainAdvanced) continue;
        v.push_back(std::fabs(r.stats.axis == 0 ? row.advanceTotX : row.advanceTotY));
    }
    if (v.size() < 20) return 1.0;
    const size_t k = std::max<size_t>(3, (size_t)(v.size() * frac));
    std::vector<double> a(v.begin(), v.begin() + k);
    std::vector<double> b(v.end() - k, v.end());
    std::sort(a.begin(), a.end());
    std::sort(b.begin(), b.end());
    const double ma = a[a.size() / 2], mb = b[b.size() / 2];
    return (ma > 1e-9) ? mb / ma : 1.0;
}

// ── A. PROJECTION ──────────────────────────────────────────────────────────

// THE OPERATOR'S WARPING NUMBER, pinned.  A tangent-plane canvas magnifies as
// sec³θ off the reference axis, so a wide pivot renders the same object many
// times larger at one end of the sweep than at the other — measured 13.0× on
// his 30.5° pack, which is the stretched floor trapezoid he marked.
TEST(PanoProjection, MaxAreaScaleIsBoundedUnderAWidePivot) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = -30.0;

    SweepResult planar = runProjectedSweep(shelf, s, planarConfig());
    SweepResult cyl = runProjectedSweep(shelf, s, testConfig());

    ASSERT_TRUE(cyl.stats.axisLatched);
    EXPECT_TRUE(cyl.holes.empty());
    EXPECT_EQ(cyl.stats.projection, 1);
    EXPECT_EQ(planar.stats.projection, 0);

    // RED on v4: the planar canvas has no bound at all here.
    EXPECT_GT(planar.stats.maxAreaScalePainted, 5.0)
        << "the planar fixture stopped being a warping fixture";
    EXPECT_LT(cyl.stats.maxAreaScalePainted, 4.0)
        << "sweep-cylindrical magnification " << cyl.stats.maxAreaScalePainted
        << " (planar was " << planar.stats.maxAreaScalePainted << ")";
    EXPECT_LT(cyl.stats.maxAreaScalePainted, 0.6 * planar.stats.maxAreaScalePainted);

    // The excursion is carried by the SWEEP channel, not by the homography.
    EXPECT_GT(cyl.stats.sweepDeg, 20.0);
    EXPECT_LT(cyl.stats.maxCrossRectifyDeg, 8.0);
    EXPECT_NEAR(planar.stats.maxCrossRectifyDeg, planar.stats.maxRectifyDeg, 1e-6)
        << "the planar arm must gate on the TOTAL excursion, as v4 did";
}

// A constant angular rate produces a constant ARC-length advance and a
// tan-growing gnomonic one.  Ledger-only, zero image noise, fully
// deterministic — and RED on v4 by construction.
TEST(PanoProjection, CylindricalAdvanceIsLinearInAttitudeWhereGnomonicIsNot) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = -30.0;

    const double planar = advanceRatioEarlyLate(runProjectedSweep(shelf, s, planarConfig()));
    const double cyl = advanceRatioEarlyLate(runProjectedSweep(shelf, s, testConfig()));

    EXPECT_GT(planar, 1.12) << "gnomonic advance did not grow with the sweep";
    EXPECT_LT(cyl, 1.08) << "cylindrical advance grew like the tangent (" << cyl
                         << " vs planar " << planar << ")";
    EXPECT_LT(cyl, planar);
}

// NO CLIFF, NO THRESHOLD.  ψ ≡ 0 on a pure walk, so v5 must be byte-identical
// to v4 there — not "close", identical.  This is the guard that stops the
// projection change from touching the engine's actual deliverable, a shelf walk.
TEST(PanoProjection, DegeneratesExactlyToThePlanarArmOnAPureTranslationSweep) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 14.0;

    auto cylNoFit = testConfig();
    cylNoFit.crossSweepFit = false;      // isolate the PROJECTION
    SweepResult a = runProjectedSweep(shelf, s, planarConfig());
    SweepResult b = runProjectedSweep(shelf, s, cylNoFit);

    ASSERT_EQ(a.rows.size(), b.rows.size());
    EXPECT_EQ(a.stats.paintedW, b.stats.paintedW);
    EXPECT_EQ(a.stats.painted, b.stats.painted);
    EXPECT_EQ(a.stats.axis, b.stats.axis);
    EXPECT_EQ(a.stats.sweepSign, b.stats.sweepSign);
    for (size_t i = 0; i < a.rows.size(); ++i) {
        ASSERT_EQ((int)a.rows[i].outcome, (int)b.rows[i].outcome) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].posU, b.rows[i].posU) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].posV, b.rows[i].posV) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].canvasX0, b.rows[i].canvasX0) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].canvasX1, b.rows[i].canvasX1) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].psiDeg, 0.0) << "row " << i;
    }
}

// ── THE ARC SEED ────────────────────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS AT ALL.  The arc seed shipped ON — `seedArcSlicePx`
// defaults to 8.0 — and rewrites the bootstrap block, which the operator's own
// packs measure at 31-36 % of a landscape canvas.  It shipped with NOTHING
// naming it in this suite: `seedArcSlicePx`, `arcSeedH`, `commitArcSeed` and
// `seedSrcAt` returned zero hits across all twelve test files.  That was
// demonstrated rather than assumed — reverting the default to 0.0, which
// reverts the feature completely, left every pano/live/replay test green.  The
// law could have been inverted or deleted and this suite would have said
// nothing; the field pack six weeks later would have said it instead.
//
// It also cost a broken branch tip.  The seed's two Impl members were left in a
// working tree while the 207 lines that READ them were committed, so the
// committed file did not compile — for both hosts, which each build
// rnis_pano.cpp — and every arm of the offline proof was built from the working
// tree that hid it.  `TheArcSeedIsOneCommitAndOneLedgerRow` below is the
// assertion that fails when those members are missing or misused, because their
// only job is to stop `commitStrip` banking each slice separately.
//
// These pin the LAW, not a pixel count: each expectation is computed from the
// fixture's own intrinsics, so they hold on any field rather than freezing this
// one.  The fixture's field is NARROWER than the packs' — kFrameH/kFy gives a
// half-field of 21.1°, where an ultra-wide iPhone reaches ~51° — so the effect
// measured here is correspondingly smaller than the 720 → 578 px the packs
// show.  That is a scope statement, not a weakness: the ratio is asserted
// against the closed form, and the closed form is what the packs also obey.
//
// EVERY TEST BELOW WAS RUN RED BEFORE IT WAS KEPT, by breaking the engine and
// watching the named assertion fail:
//
//   arc placement removed (b := tangent)   -> …PlacesTheFieldAtArcLength… FAILS
//                                             (ratio 1.000 vs predicted 0.954)
//   `seedSlicing` never set                -> …IsOneCommitAndOneLedgerRow FAILS
//                                             (139 strips banked against 74)
//   `maxRectifyDeg > 0.0` gate removed     -> …KeepsTheBlockSeedByteForByte and
//                                             DegeneratesExactlyToThePlanarArm…
//                                             both FAIL
//   +3 px injected into arcSeedH           -> …IsTheIdentityAtThePrincipalRay
//                                             FAILS (1.31 px vs 0.31 px clean)
//
// ⚠ WHAT IS NOT PINNED, MEASURED RATHER THAN ASSUMED.  Setting the cos² factor
// to 1.0 — which deletes the slice-local scale correction and leaves only the
// arc placement of the slice CENTRES — leaves every assertion in this block
// green.  That is honest rather than alarming: with 8 canvas-px slices the
// correction is a sub-slice refinement worth ~0.6 canvas px of mean-zero
// sawtooth at this fixture's field edge, and a mean-zero sawtooth is invisible
// to a footprint ratio by construction.  Pinning it needs an instrument that
// looks WITHIN a slice — a per-slice-boundary continuity measure over the seed
// region, or a direct unit test of `arcSeedH` behind a test seam.  Neither
// exists yet, and until one does the cos² factor rests on its derivation and on
// the offline replay, not on this suite.

/// The bootstrap footprint in canvas px, read from the ledger's Bootstrap row.
/// The seed is ONE commit, so this is one row's committed span either way —
/// which is itself part of what is being pinned.
double bootstrapFootprintPx(const SweepResult& r) {
    for (const auto& row : r.rows) {
        if (row.outcome == rnis::pano::Outcome::Bootstrap &&
            row.canvasX1 > row.canvasX0) {
            return row.canvasX1 - row.canvasX0;
        }
    }
    return -1.0;
}

int countBootstrapRows(const SweepResult& r) {
    int n = 0;
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::Bootstrap) ++n;
    return n;
}

/// The same sweep with the arc seed turned OFF, which is the legacy block.
rnis::pano::Config blockSeedConfig() {
    auto c = testConfig();
    c.seedArcSlicePx = 0.0;
    return c;
}

// THE LAW: along the sweep, the reference raster's ray at angle phi sits at the
// TANGENT c + f·tan(phi) and belongs at the ARC c + f·phi.  So the bootstrap
// frame, which spans the field its own principal point actually subtends,
// occupies D·scale canvas px as a tangent block and f·(phiHi − phiLo)·scale as
// an arc.  The ratio between those is a closed form in the intrinsics alone,
// and it is < 1 for every real camera because tan grows faster than its angle.
//
// This is the assertion that fails if the cos² factor is dropped, inverted, or
// replaced by the rotation homography an earlier cut used.
TEST(PanoProjection, TheArcSeedPlacesTheFieldAtArcLengthNotTangent) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;               // a pivot: maxRectifyDeg > 0, so the seed arms

    const auto arcCfg = testConfig();
    SweepResult arc   = runProjectedSweep(shelf, s, arcCfg);
    SweepResult block = runProjectedSweep(shelf, s, blockSeedConfig());

    ASSERT_TRUE(arc.stats.axisLatched);
    ASSERT_EQ(arc.stats.axis, 1) << "a pitch sweep latches the VERTICAL axis";
    ASSERT_EQ(block.stats.axis, arc.stats.axis)
        << "the seed must not move the axis latch — it runs after it";

    // The field this raster spans about its OWN principal point, which is not
    // the centre and must not be assumed symmetric.
    const double f = kFy, c = kCy, D = (double)kFrameH;
    const double phiLo = std::atan((0.0 - c) / f);
    const double phiHi = std::atan((D - c) / f);
    const double predicted = (f * (phiHi - phiLo)) / D;

    const double blockPx = bootstrapFootprintPx(block);
    const double arcPx   = bootstrapFootprintPx(arc);
    ASSERT_GT(blockPx, 0.0);
    ASSERT_GT(arcPx, 0.0);

    EXPECT_NEAR(blockPx, arcCfg.canvasScale * D, 2.0)
        << "the block seed is the frame's own tangent footprint";
    EXPECT_NEAR(arcPx / blockPx, predicted, 0.01)
        << "arc " << arcPx << " px vs block " << blockPx << " px = ratio "
        << (arcPx / blockPx) << "; the closed form f·(phiHi−phiLo)/D predicts "
        << predicted << " (half-field "
        << (phiHi * 180.0 / CV_PI) << "°)";
    EXPECT_LT(arcPx, blockPx)
        << "tan(phi) > phi, so the arc placement is always the narrower one";
}

// At phi == 0 the slice map is EXACTLY the identity, so the seed's H is `Href`
// to the last bit — which is what lets a canvas that was sized, latched and
// high-watered BEFORE the seed ran stay valid after it.
//
// ⚠ THE OBVIOUS OBSERVABLES ARE TAUTOLOGIES HERE, and the first cut of this
// test used one.  `posU`, `posV` and `highWater` are assigned inside
// `commitLatch` BEFORE the seed runs, so they are trivially equal between the
// arms no matter what the seed does: a deliberate +3 px offset injected into
// `arcSeedH`'s translation left that version GREEN.  So does the first
// Bootstrap ledger row, whose committed span is (0, 0) — the span lands on a
// LATER Bootstrap row, which is why `bootstrapFootprintPx` skips empty ones.
//
// What is actually diagnostic is where the PRINCIPAL RAY lands.  The block seed
// puts source coordinate `c` at `x0 + c·scale`; an arc seed that is the
// identity at phi == 0 must put it at `x0 + f·|phiLo|·scale`, i.e. the same
// canvas coordinate.  Measured: the two agree to 0.31 px on a clean engine and
// diverge to 1.31 px under that same +3 px injection, so the tolerance below is
// set by the integer rounding of the committed span and nothing else.
TEST(PanoProjection, TheArcSeedIsTheIdentityAtThePrincipalRay) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;

    const auto cfg = testConfig();
    SweepResult arc   = runProjectedSweep(shelf, s, cfg);
    SweepResult block = runProjectedSweep(shelf, s, blockSeedConfig());

    const rnis::pano::FrameOutcome* a = nullptr;
    const rnis::pano::FrameOutcome* b = nullptr;
    for (const auto& row : arc.rows)
        if (row.outcome == rnis::pano::Outcome::Bootstrap &&
            row.canvasX1 > row.canvasX0) { a = &row; break; }
    for (const auto& row : block.rows)
        if (row.outcome == rnis::pano::Outcome::Bootstrap &&
            row.canvasX1 > row.canvasX0) { b = &row; break; }
    ASSERT_NE(a, nullptr) << "no Bootstrap row committed a span";
    ASSERT_NE(b, nullptr);

    const double f = kFy, c = kCy;
    const double phiLo = std::atan((0.0 - c) / f);
    const double arcPrincipal   = a->canvasX0 + f * std::fabs(phiLo) * cfg.canvasScale;
    const double blockPrincipal = b->canvasX0 + c * cfg.canvasScale;

    EXPECT_NEAR(arcPrincipal, blockPrincipal, 1.0)
        << "the principal ray moved: arc puts it at " << arcPrincipal
        << " (x0 " << a->canvasX0 << "), block at " << blockPrincipal
        << " (x0 " << b->canvasX0 << ").  arcSeedH(0) is no longer Href, so the "
           "seed no longer agrees with the canvas that was latched around it";
}

// The seed must leave the CROSS extent and the hole count exactly as the block
// left them: `projection == 1` says lines running across the sweep stay
// straight, so a cross-axis term of any kind contradicts it.  An earlier cut
// built each slice as a full rotation homography K·R(phi)ᵀ·K⁻¹, which carries a
// cos(phi) cross compression; the seed's outer columns then covered ~73 % of
// the cross extent and `cropVertical` cut the deliverable from 540 rows to 480.
//
// ⚠ SCOPE, MEASURED, BECAUSE THE NAME COULD OVERSELL THIS.  This fixture does
// NOT reproduce that regression.  Re-injecting the cos(phi) cross term into
// `arcSeedH` leaves this test green, leaves PanoFinalize.CropVerticalNarrows-
// ToTheCommonBand and .TheCropBarDoesNotTightenAsThePanoramaGrows green, and
// changes neither the canvas dimensions (976 x 734 / 885 / 1008 at 18/30/40° of
// pitch, identical in both arms) nor the per-row painted span (720 px at every
// row sampled, identical in both arms).  The strips overpaint the cross extent
// the seed would have narrowed, so at this field the seed is not what sets it.
// Catching that regression needs a fixture where the SEED sets the cross
// extent — a sweep short enough that little overpaints it, at a field wide
// enough for cos(phi) to bite.  This test is therefore a guard on the two
// things it does check, not evidence that the cross term is pinned.
TEST(PanoProjection, TheArcSeedLeavesTheCrossExtentAndTheHoleCountAlone) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;

    SweepResult arc   = runProjectedSweep(shelf, s, testConfig());
    SweepResult block = runProjectedSweep(shelf, s, blockSeedConfig());

    ASSERT_FALSE(arc.canvas.empty());
    ASSERT_FALSE(block.canvas.empty());
    // axis == 1, so the CROSS axis is the canvas's width.
    ASSERT_EQ(arc.stats.axis, 1);
    EXPECT_EQ(arc.canvas.cols, block.canvas.cols)
        << "the arc seed moved the cross extent from " << block.canvas.cols
        << " to " << arc.canvas.cols << " px";
    EXPECT_TRUE(arc.holes.empty())
        << "the sliced seed left " << arc.holes.size() << " interior hole run(s)";
}

// THE ONE THAT CATCHES THE MISSING MEMBERS.  The slices are an implementation
// of one commit, not many: `seedSlicing` exists only to stop `commitStrip`
// banking each slice as a separate strip, and `seedLensTally` only to stop the
// lens counters crediting one seed dozens of times.  Without them the counts
// below inflate by the slice count — which for this fixture is in the hundreds.
TEST(PanoProjection, TheArcSeedIsOneCommitAndOneLedgerRow) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;

    SweepResult arc   = runProjectedSweep(shelf, s, testConfig());
    SweepResult block = runProjectedSweep(shelf, s, blockSeedConfig());

    EXPECT_EQ(countBootstrapRows(arc), countBootstrapRows(block))
        << "the sliced seed produced " << countBootstrapRows(arc)
        << " Bootstrap rows against the block's " << countBootstrapRows(block)
        << "; one seed is one row";
    EXPECT_EQ(arc.stats.stripsCommitted, block.stats.stripsCommitted)
        << "the sliced seed banked " << arc.stats.stripsCommitted
        << " strips against the block's " << block.stats.stripsCommitted
        << " — the slices are being counted individually";
    EXPECT_EQ(arc.rows.size(), block.rows.size())
        << "every ingested frame still yields exactly one ledger row";
}

// The seed is gated on `maxRectifyDeg > 0.0` and that gate is load-bearing for
// the control arms: on a PURE TRANSLATION sweep dR is the identity on every
// frame, the quantity is identically zero, and the block must survive
// BYTE-FOR-BYTE.  Without this clause a translation sweep painted its strips on
// the tangent plane and its seed on the arc — the same fork this change exists
// to remove, pointing the other way — and it broke
// PanoProjection.DegeneratesExactlyToThePlanarArmOnAPureTranslationSweep.
TEST(PanoProjection, APureTranslationSweepKeepsTheBlockSeedByteForByte) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 14.0;                     // no rotation anywhere in this sweep

    SweepResult arc   = runProjectedSweep(shelf, s, testConfig());
    SweepResult block = runProjectedSweep(shelf, s, blockSeedConfig());

    ASSERT_FALSE(arc.canvas.empty());
    ASSERT_EQ(arc.canvas.size(), block.canvas.size());
    EXPECT_EQ(fnv1aPixels(arc.canvas), fnv1aPixels(block.canvas))
        << "the arc seed reached a sweep with no rotation in it";
    EXPECT_DOUBLE_EQ(bootstrapFootprintPx(arc), bootstrapFootprintPx(block));
}


// ── THE ARC TAIL ────────────────────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS.  The arc seed removed the tangent/arc fork from the
// BOOTSTRAP and the operator could not see any difference, because the seed's
// boundary lands on its own optical centre where the two laws agree in value
// AND slope (measured kink there: −0.03 px/row), and the half of the seed that
// diverges is overpainted by the strips.  The TAIL FLUSH is the same fork at
// the far end, where nothing overpaints it and nothing hides it: `finish()`
// commits one frame over 371-407 canvas px through one homography, its field
// stretched 1/cos²φ to 1.93× at φ = 44°, and a straight line's lean multiplied
// by cos²φ along with it.  That bend is what the operator circled.
//
// EVERY TEST BELOW WAS RUN RED BEFORE IT WAS KEPT, by breaking the engine and
// watching the named assertion fail (the actual observed numbers are quoted at
// each one).  The gate test is the exception in one direction and worth naming:
// it was written BECAUSE the suite already caught the bug — the first cut of
// this change gated on `maxRectifyDeg > 0` like the seed, and
// PanoMisLatch.AWalkCarryingASettlingTransverseTiltSweepsAlongTheWalk went red
// at 191 against its 191.125 bar (219 on the tip).  A walk with a settling
// transverse tilt has attitude excursion and ψ ≡ 0; its canvas is a planar
// mosaic and the arc law compressed it by 28 canvas px.

/// The tail-flush row's committed span, in canvas px.
double tailFlushSpanPx(const SweepResult& r) {
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::TailFlush &&
            row.canvasX1 > row.canvasX0)
            return row.canvasX1 - row.canvasX0;
    return -1.0;
}

double tailFlushX0(const SweepResult& r) {
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::TailFlush &&
            row.canvasX1 > row.canvasX0)
            return row.canvasX0;
    return -1.0;
}

/// The tail-flush row's own seam luminance step, or -1 when there is no
/// committing tail row.  Read from the LEDGER ROW and not from the session
/// percentile, because this is a claim about ONE boundary and the percentile
/// is a population.
double tailFlushSeamLumaDN(const SweepResult& r) {
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::TailFlush &&
            row.canvasX1 > row.canvasX0)
            return row.seamLumaStepDN;
    return -1.0;
}

int countTailFlushRows(const SweepResult& r) {
    int n = 0;
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::TailFlush) ++n;
    return n;
}

/// The last COMMITTED strip's optical centre — the tail frame's own φ = 0, and
/// therefore the point the arc map is centred on.  Read from the ledger so the
/// test's closed form uses the engine's own placement rather than a second
/// reconstruction of it.
double lastStripPosU(const SweepResult& r) {
    double u = -1.0;
    for (const auto& row : r.rows) {
        const bool committed =
            row.outcome == rnis::pano::Outcome::Painted ||
            row.outcome == rnis::pano::Outcome::GapExtended ||
            row.outcome == rnis::pano::Outcome::GapBreak ||
            row.outcome == rnis::pano::Outcome::GapBackfilled;
        if (committed && row.canvasX1 > row.canvasX0) u = row.posU;
    }
    return u;
}

/// The same sweep with the arc tail turned OFF, which is the legacy block.
rnis::pano::Config blockTailConfig() {
    auto c = testConfig();
    c.tailArcSlicePx = 0.0;
    return c;
}

// THE LAW, as a closed form in the fixture's own intrinsics and the block arm's
// own ledger — nothing fitted.  The block commits [u0, u1] as a tangent span of
// width u1 − u0 about the frame's optical centre u_c; the same rays belong on
// the arc at F·(atan((u1−u_c)/F) − atan((u0−u_c)/F)).
//
// This is also the assertion that fails if the kink is ever "fixed" by CROPPING
// the tail: a crop makes the span SHORTER than the closed form, and the
// tolerance below is one committed column.
//
// RED, observed: removing the law (kk := 1, b := 0) gives span 270 against the
// predicted 257.6, and the `arcSpan < blockSpan` line below fails too.
// Replacing only the arc TARGET with the tangent one (b := mid - kk*mid) gives
// the identical failure — the run-left clamp then hands the union straight
// back to the block's own span.
TEST(PanoProjection, TheArcTailPlacesTheFieldAtArcLengthNotTangent) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;               // a pivot: the sweep is carried by rotation

    const auto arcCfg = testConfig();
    SweepResult arc   = runProjectedSweep(shelf, s, arcCfg);
    SweepResult block = runProjectedSweep(shelf, s, blockTailConfig());

    ASSERT_TRUE(arc.stats.axisLatched);
    ASSERT_EQ(arc.stats.axis, 1) << "a pitch sweep latches the VERTICAL axis";
    ASSERT_EQ(block.stats.axis, arc.stats.axis)
        << "the tail must not move the axis latch — it runs long after it";

    const double blockSpan = tailFlushSpanPx(block);
    const double arcSpan   = tailFlushSpanPx(arc);
    ASSERT_GT(blockSpan, 0.0) << "the block arm committed no tail";
    ASSERT_GT(arcSpan, 0.0) << "the arc arm committed no tail";

    const double F = kFy * arcCfg.canvasScale;
    const double uc = lastStripPosU(block);
    ASSERT_GT(uc, 0.0);
    const double u0 = tailFlushX0(block);
    const double u1 = u0 + blockSpan;
    const double predicted = F * (std::atan((u1 - uc) / F) -
                                  std::atan((u0 - uc) / F));

    EXPECT_NEAR(arcSpan, predicted, 1.5)
        << "arc " << arcSpan << " px vs block " << blockSpan
        << " px; the closed form F·Δatan predicts " << predicted
        << " (F = " << F << " canvas px/rad, centre " << uc
        << ", span " << u0 << ".." << u1 << ")";
    EXPECT_LT(arcSpan, blockSpan)
        << "tan(phi) > phi, so the arc placement is always the narrower one";
}

// The frontier must not move.  g(u_c) = u_c and g'(u_c) = 1, and the block
// begins at the last strip's own edge — a hair past u_c — so the first
// committed column of the tail is the same column in both arms, and every
// strip before it is untouched.
//
// ⚠ THE SPAN IS NOT THE DIAGNOSTIC HERE and the first cut of this test used it:
// the span changes by design (that is the test above), so an assertion on it
// says nothing about the boundary.  What is diagnostic is x0 and the strip run
// behind it.
//
// RED, observed: +3 px injected into the slice map's translation moves x0 by 3
// columns (608 against 605) and fails this.
TEST(PanoProjection, TheArcTailDoesNotMoveTheFrontier) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;

    SweepResult arc   = runProjectedSweep(shelf, s, testConfig());
    SweepResult block = runProjectedSweep(shelf, s, blockTailConfig());

    EXPECT_DOUBLE_EQ(tailFlushX0(arc), tailFlushX0(block))
        << "the tail's first committed column moved: arc " << tailFlushX0(arc)
        << " vs block " << tailFlushX0(block)
        << " — the slice map is no longer the identity at the frame centre";
    EXPECT_DOUBLE_EQ(lastStripPosU(arc), lastStripPosU(block))
        << "the strip run itself moved; the tail must run AFTER everything";

    ASSERT_EQ(arc.rows.size(), block.rows.size());
    for (size_t i = 0; i + 1 < arc.rows.size(); ++i) {
        ASSERT_EQ((int)arc.rows[i].outcome, (int)block.rows[i].outcome)
            << "row " << i;
        EXPECT_DOUBLE_EQ(arc.rows[i].canvasX0, block.rows[i].canvasX0)
            << "row " << i << " — a pre-tail commit moved";
        EXPECT_DOUBLE_EQ(arc.rows[i].canvasX1, block.rows[i].canvasX1)
            << "row " << i << " — a pre-tail commit moved";
    }
}

// THE ONE THAT CATCHES THE SLICE BOOKKEEPING.  `seedSlicing` exists only to
// stop `commitStrip` banking each slice as a separate strip; without it around
// the tail run the counts inflate by the slice count, and the tail — unlike the
// seed — is banked at the END of a run of dozens.
//
// RED, observed: `seedSlicing` left false around the tail loop banks 106
// strips against the block's 74.
TEST(PanoProjection, TheArcTailIsOneCommitAndOneLedgerRow) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;

    SweepResult arc   = runProjectedSweep(shelf, s, testConfig());
    SweepResult block = runProjectedSweep(shelf, s, blockTailConfig());

    EXPECT_EQ(countTailFlushRows(arc), countTailFlushRows(block))
        << "the sliced tail produced " << countTailFlushRows(arc)
        << " tail-flush rows against the block's "
        << countTailFlushRows(block) << "; one flush is one row";
    EXPECT_EQ(arc.stats.stripsCommitted, block.stats.stripsCommitted)
        << "the sliced tail banked " << arc.stats.stripsCommitted
        << " strips against the block's " << block.stats.stripsCommitted
        << " — the slices are being counted individually";
    EXPECT_EQ(arc.rows.size(), block.rows.size());
    EXPECT_TRUE(arc.holes.empty())
        << "the sliced tail left " << arc.holes.size()
        << " interior hole run(s) — the slice run is not gap-free";
}

// THE ONE THAT PINS THE SEAM RESTORE, which nothing did.  `commitStrip`
// overwrites `lastSeam*` on every call, so after a run of ~46 slices those
// members describe an INTERIOR join between two slices of one frame at one
// exposure — ~0 DN by construction.  `commitArcTail` therefore captures the
// FIRST committing slice's values (the real boundary against the strip run)
// and restores them before returning, and this row's `seamLumaStepDN` is
// inserted into `seamLumaSamples` (rnis_pano.cpp:4631) and becomes
// seamLumaStepP50/P95/MaxDN.  Without the restore the LARGEST single boundary
// in the deliverable — 29-48% of the canvas on the operator's packs — scores a
// perfect zero and the pack's seam verdict IMPROVES while the seam gets worse.
//
// The block arm is the reference because its tail is one commit with nothing
// to overwrite it: whatever the arc arm banks must be the same boundary.
//
// RED, observed: deleting the restore block at the end of `commitArcTail`
// leaves this fixture's tail row at 0.0000 against the block arm's 2.1657 —
// and the whole pano suite stayed green, which is why this test exists.
TEST(PanoProjection, TheArcTailBanksTheBoundarySeamNotAnInteriorSliceJoin) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;

    SweepResult arc   = runProjectedSweep(shelf, s, testConfig());
    SweepResult block = runProjectedSweep(shelf, s, blockTailConfig());

    const double arcSeam   = tailFlushSeamLumaDN(arc);
    const double blockSeam = tailFlushSeamLumaDN(block);
    ASSERT_GE(arcSeam, 0.0) << "the arc arm committed no tail row";
    ASSERT_GE(blockSeam, 0.0) << "the block arm committed no tail row";

    // NON-VACUOUS FIRST.  If this fixture's tail boundary were itself ~0 DN,
    // the agreement below would hold with the restore deleted and the test
    // would pin nothing.
    ASSERT_GT(blockSeam, 0.5)
        << "fixture drifted — the block arm's tail boundary is " << blockSeam
        << " DN, too small for the agreement below to mean anything";

    EXPECT_NEAR(arcSeam, blockSeam, 0.05)
        << "the sliced tail banked " << arcSeam << " DN where the block banks "
        << blockSeam << " — the run is reporting an interior slice join as the "
           "tail boundary, which retires the largest seam in the deliverable "
           "from the integrity verdict while appearing to improve it";

    // AND IT REACHES THE VERDICT.  The row is banked into the percentiles, so
    // a zeroed tail would also pull the session maximum down.
    EXPECT_GE(arc.stats.seamLumaStepMaxDN, arcSeam - 1e-6)
        << "the tail row's " << arcSeam << " DN is not in the population the "
           "pack is graded on (max " << arc.stats.seamLumaStepMaxDN << ")";
}

// A sweep with NO rotation in it is a planar mosaic and its tail block belongs
// on the tangent.  Byte-for-byte, so the control arm stays a control arm.
TEST(PanoProjection, APureTranslationSweepKeepsTheBlockTailByteForByte) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 14.0;                     // no rotation anywhere in this sweep

    SweepResult arc   = runProjectedSweep(shelf, s, testConfig());
    SweepResult block = runProjectedSweep(shelf, s, blockTailConfig());

    ASSERT_FALSE(arc.canvas.empty());
    ASSERT_EQ(arc.canvas.size(), block.canvas.size());
    EXPECT_EQ(fnv1aPixels(arc.canvas), fnv1aPixels(block.canvas))
        << "the arc tail reached a sweep with no rotation in it";
    EXPECT_DOUBLE_EQ(tailFlushSpanPx(arc), tailFlushSpanPx(block));
}

// THE GATE, and the reason it is not the seed's.  A WALK carrying a transverse
// tilt has attitude excursion — `maxRectifyDeg` reaches 6° — while ψ, the
// component about the sweep axis, is identically zero.  Its canvas is carried
// by `posNat`, not by the arc term, so the tail block belongs on the tangent
// exactly as the pure-translation sweep's does.
//
// This is the case the first cut of the change got wrong, and it is asserted
// here directly rather than left to PanoMisLatch's growth bar to notice: that
// test failed by 0.125 px, which is a fragile way to learn about a 28 px
// geometric regression.
//
// RED, observed: gating on `maxRectifyDeg > 0.0` like the seed makes this
// fixture's canvas 911 x 796 against the block's 939 x 796 — the same 28 px.
TEST(PanoProjection, AWalkCarryingACrossTiltKeepsTheBlockTail) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto steps = walkWithTransversePitch(
        140, 5.0, [](int i) { return 6.0 * std::min(1.0, (double)i / 20.0); });

    SweepResult arc   = runGestureSweep(shelf, steps, testConfig());
    SweepResult block = runGestureSweep(shelf, steps, blockTailConfig());

    ASSERT_EQ(arc.stats.axis, 0) << "fixture drifted — this must latch the walk";
    EXPECT_GT(arc.stats.maxRectifyDeg, 1.0)
        << "fixture drifted — the tilt must give the SEED's gate something to "
           "fire on, or this test is not testing the difference";
    EXPECT_DOUBLE_EQ(arc.stats.sweepDeg, 0.0)
        << "fixture drifted — psi must be identically 0 for this to be the "
           "translation-carried case";

    ASSERT_FALSE(arc.canvas.empty());
    ASSERT_EQ(arc.canvas.size(), block.canvas.size());
    EXPECT_EQ(fnv1aPixels(arc.canvas), fnv1aPixels(block.canvas))
        << "the arc tail compressed a canvas that rotation does not carry";
}

// THE OPERATOR'S PROMISE, in one number.  The preview's lead-out warps the same
// frame over the same span the tail flush then commits — "the exact image you
// are going to get as the result" — so the columns it appends must be the
// columns the flush lands on.  Under the law change that is a 76-95 canvas px
// claim on a real pack: a lead-out left on the tangent law would show a block
// that visibly contracts the moment the sweep stops.
//
// RED, observed: reverting the lead-out to the single `lastHint` warp leaves it
// showing up to canvas u 875 where the flush commits to 862.
TEST(PanoPreviewLeadOut, ShowsTheSameSpanTheTailFlushCommits) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;

    for (double slice : {8.0, 0.0}) {     // arc tail ON, then the block control
        auto cfg = testConfig();
        cfg.tailArcSlicePx = slice;
        rnis::pano::Engine eng;
        std::string err;
        ASSERT_TRUE(eng.configure(cfg, &err)) << err;
        SweepResult out;
        ingestProjectedSweep(eng, shelf, s, cfg, out);
        ASSERT_TRUE(eng.stats().axisLatched);

        // 1:1, so viewEndU is canvas u and not a fitted scale's.
        cv::Mat on;
        rnis::pano::PreviewWindow won;
        ASSERT_TRUE(eng.previewIntoFit(on, 100000, 100000, 0, &won,
                                       false, true));
        ASSERT_GT(won.leadOutPx, 0)
            << "slice=" << slice
            << " — half a footprint is ahead of the frontier; the lead-out "
               "must have something to show";

        out.rows.push_back(eng.finish());
        const double committedEnd = tailFlushX0(out) + tailFlushSpanPx(out);
        ASSERT_GT(committedEnd, 0.0);
        EXPECT_NEAR((double)won.viewEndU, committedEnd, 1.5)
            << "slice=" << slice << ": the lead-out showed up to u "
            << won.viewEndU << " and the flush committed to " << committedEnd
            << " — the preview is not the output";
    }
}

// rectifyYawLimitDeg used to gate the TOTAL excursion, so a pivot past it was
// REJECTED and the chain eventually aborted — and the operator's own pivot
// pack already reached 30.5° of a 35° limit.  In v5 the gate bounds the CROSS
// excursion and the sweep is bounded separately, so v5 paints pivots v4
// structurally refused.  RED on v4: the planar arm below aborts.
TEST(PanoProjection, APivotPastTheOldYawLimitStillPaints) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 110;
    s.pitchDeg = -50.0;                   // past the 35° default

    SweepResult cyl = runProjectedSweep(shelf, s, testConfig());
    SweepResult planar = runProjectedSweep(shelf, s, planarConfig());

    EXPECT_TRUE(cyl.stats.abortReason.empty()) << cyl.stats.abortReason;
    EXPECT_TRUE(cyl.holes.empty());
    EXPECT_GT(cyl.stats.painted, 40);
    EXPECT_LT(cyl.stats.maxCrossRectifyDeg, testConfig().rectifyYawLimitDeg);
    EXPECT_GT(cyl.stats.sweepDeg, 40.0);

    EXPECT_GT(countOutcome(planar, rnis::pano::Outcome::RejectedRectify), 5)
        << "the planar arm no longer refuses this pivot — fixture drifted";
    EXPECT_GT(cyl.stats.painted, planar.stats.painted);
}

// ── B. CROSS-SWEEP PLACEMENT ───────────────────────────────────────────────

// v4 fits ONE translation in a window covering 20% of the cross extent and
// extrapolates it across the other 80%, so two strips meet correctly in the
// middle and diverge at the edges — which IS the visible cut.  Under real
// forward motion that divergence is a SCALE, and a plane at `d` predicts it
// from the pose.  RED on v4: the control arm carries the whole error.
TEST(PanoCrossSweep, AForwardMotionSweepIsRegisteredAcrossTheWholeStrip) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    SweepResult off = runApproachSweep(shelf, 120, 12.0, 0.06, 0.6, planarConfig());
    auto on = testConfig();
    on.projection = 0;                    // isolate the CROSS-SWEEP change
    SweepResult a = runApproachSweep(shelf, 120, 12.0, 0.06, 0.6, on);

    ASSERT_TRUE(a.stats.axisLatched);
    EXPECT_TRUE(a.holes.empty());
    EXPECT_TRUE(off.holes.empty());
    EXPECT_GT(a.stats.seamBoundaries, 40);

    EXPECT_LT(a.stats.seamWorstBandP95Px, 0.75 * off.stats.seamWorstBandP95Px)
        << "cross-sweep fit did not reduce the seam residual (on="
        << a.stats.seamWorstBandP95Px << " off=" << off.stats.seamWorstBandP95Px << ")";
    EXPECT_LT(a.stats.crossBandDivergencePx, 0.60 * off.stats.crossBandDivergencePx)
        << "the accumulated band shear did not fall (on="
        << a.stats.crossBandDivergencePx << " off="
        << off.stats.crossBandDivergencePx << ")";
    // The plane the pose implies must land near the truth (0.6 m here).
    EXPECT_GT(a.stats.subjectDistanceFitM, 0.30);
    EXPECT_LT(a.stats.subjectDistanceFitM, 1.60);
    // Moving TOWARD the surface SHRINKS the accumulated cross scale.  With the
    // sign inverted this is > 1 and the correction pushes the wrong way.
    EXPECT_LT(a.stats.crossScaleEnd, 1.0) << "the plane prior has the wrong sign";
}

// THE NO-REGRESSION PROOF, and the reason the metric is free: with the fit
// disabled the chain is v4's element for element, and turning the METRIC on
// changes nothing at all.
TEST(PanoCrossSweep, TheMetricCostsTheChainNothing) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 14.0;

    auto blind = planarConfig();
    blind.seamMetrics = false;
    auto measured = planarConfig();       // seamMetrics defaults ON
    SweepResult a = runProjectedSweep(shelf, s, blind);
    SweepResult b = runProjectedSweep(shelf, s, measured);

    ASSERT_EQ(a.rows.size(), b.rows.size());
    EXPECT_EQ(a.stats.paintedW, b.stats.paintedW);
    for (size_t i = 0; i < a.rows.size(); ++i) {
        ASSERT_EQ((int)a.rows[i].outcome, (int)b.rows[i].outcome) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].posU, b.rows[i].posU) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].posV, b.rows[i].posV) << "row " << i;
    }
    EXPECT_EQ(a.stats.seamBoundaries, 0) << "seamMetrics=false still measured";
    EXPECT_GT(b.stats.seamBoundaries, 20);

    // ...and with the fit ON but NO forward motion the plane predicts nothing,
    // so the placement is still identical.  (A model that moved the panorama
    // when the camera did not translate toward anything would be inventing.)
    auto fit = testConfig();
    fit.projection = 0;
    SweepResult c = runProjectedSweep(shelf, s, fit);
    ASSERT_EQ(a.rows.size(), c.rows.size());
    EXPECT_EQ(a.stats.paintedW, c.stats.paintedW);
    EXPECT_DOUBLE_EQ(c.stats.crossScaleEnd, 1.0);
    for (size_t i = 0; i < a.rows.size(); ++i) {
        EXPECT_DOUBLE_EQ(a.rows[i].posU, c.rows[i].posU) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].posV, c.rows[i].posV) << "row " << i;
    }
}

// The cage is a real bound, not a post-hoc filter: a nonsense plane distance
// must be CLAMPED and COUNTED, never allowed to run the cross scale away.
TEST(PanoCrossSweep, AnAbsurdPlaneDistanceIsCagedAndCounted) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    auto cfg = testConfig();
    cfg.projection = 0;
    cfg.subjectDistanceAuto = false;
    cfg.subjectDistanceM = 0.05;          // absurd: 5 cm
    SweepResult r = runApproachSweep(shelf, 100, 12.0, 0.06, 0.6, cfg);

    EXPECT_TRUE(r.holes.empty());
    EXPECT_GT(r.stats.crossScaleCagedFrames, 0) << "the cage never fired";
    const double bound = std::exp(cfg.crossScaleCageFrac);
    EXPECT_LE(r.stats.crossScaleEnd, bound);
    EXPECT_GE(r.stats.crossScaleEnd, 1.0 / bound);
}

// ── C. THE CUT METRIC ──────────────────────────────────────────────────────

// THE BLIND-SPOT TEST, in the same shape as the vertical-clipping one.  Every
// gate v4 shipped says this sweep is perfect — no holes, no gap break, no
// clipping, no abort — and it carries a cross-sweep misregistration the
// operator would see.  v5 must SAY SO.
TEST(PanoSeam, AMisregisteredSweepCannotReportClean) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    SweepResult r = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, planarConfig());

    // Everything v4 could see:
    EXPECT_TRUE(r.holes.empty());
    EXPECT_EQ(r.stats.gapBreak, 0);
    EXPECT_EQ(r.stats.clippedFrames, 0);
    EXPECT_TRUE(r.stats.abortReason.empty()) << r.stats.abortReason;

    // What v5 can see:
    EXPECT_GT(r.stats.seamWorstBandP95Px, 0.5)
        << "the fixture stopped carrying a cross-sweep cut";
    EXPECT_TRUE(r.stats.integrityFailed)
        << "a sweep with a visible cut reported CLEAN — p95="
        << r.stats.seamWorstBandP95Px << " max=" << r.stats.seamWorstBandMaxPx
        << " divergence=" << r.stats.crossBandDivergencePx;
}

// ...and the gate must be PASSABLE, or it is not a gate.  An ordinary walking
// sweep with no forward motion has nothing to flag.
TEST(PanoSeam, ACleanSweepIsNotFlagged) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 14.0;
    SweepResult r = runProjectedSweep(shelf, s, testConfig());

    EXPECT_TRUE(r.holes.empty());
    EXPECT_GT(r.stats.seamBoundaries, 20);
    EXPECT_FALSE(r.stats.integrityFailed)
        << "clean walk flagged — p95=" << r.stats.seamWorstBandP95Px
        << " max=" << r.stats.seamWorstBandMaxPx
        << " divergence=" << r.stats.crossBandDivergencePx;
}

// The ~128 px posV steps in a device ledger are the canvas vertical-growth
// re-base and are BENIGN.  The cut metric is measured in the frame's own
// rectified coordinates, so it is immune to them BY CONSTRUCTION rather than
// by subtracting vShiftPx afterwards — pin that, because a metric that chased
// the re-base would flag every long sweep.
TEST(PanoSeam, TheCanvasGrowthRebaseIsNotACut) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 110;
    s.dx = 14.0;
    s.dy = -6.0;                      // drift ACROSS the sweep, upward, so
                                      // the band grows at the TOP and every
                                      // posV is re-based (vShiftPx > 0)
    SweepResult r = runProjectedSweep(shelf, s, testConfig());

    ASSERT_GT(r.stats.canvasHeightGrowths, 0) << "no growth — fixture drifted";
    EXPECT_GT(r.stats.vShiftTotalPx, 0.0);
    EXPECT_TRUE(r.holes.empty());
    EXPECT_LT(r.stats.seamWorstBandMaxPx, 1.5)
        << "the vertical-growth re-base leaked into the cut metric";
    EXPECT_FALSE(r.stats.integrityFailed);
}

// The gain is fitted on a sample window LEFT of the frontier and applied to
// content RIGHT of it, so a gain that matches its own sample exactly can still
// commit a visible DC step.  Measure the step that lands on the CANVAS.
TEST(PanoSeam, ThePhotometricStepIsMeasuredOnTheCanvas) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    auto off = testConfig();
    off.gainMatch = false;
    auto on = testConfig();

    SweepResult a = runApproachSweep(shelf, 90, 12.0, 0.0, 0.6, off, 0.18);
    SweepResult b = runApproachSweep(shelf, 90, 12.0, 0.0, 0.6, on, 0.18);

    EXPECT_GT(a.stats.seamLumaStepP95DN, 2.0)
        << "an 18% exposure oscillation produced no measurable seam step";
    EXPECT_LT(b.stats.seamLumaStepP95DN, a.stats.seamLumaStepP95DN)
        << "gain matching did not reduce the committed DC step (on="
        << b.stats.seamLumaStepP95DN << " off=" << a.stats.seamLumaStepP95DN << ")";
    EXPECT_GT(a.stats.gainCumEnd, 0.0);
}

// ── C (round 2): THE GATE ITSELF ───────────────────────────────────────────
//
// Round 1 built the cut metric.  Review then showed the GATE could still be
// turned green three ways — an even crossWindows, a config with the metric
// off, and an absolute bar on a cumulative quantity — so these pin the gate,
// not the metric.

// An EVEN crossWindows collapsed to a single window inside crossWindowCount()
// and silently disabled every outer slot AND the cut metric with them, while
// configure() accepted it.  A validated knob value that turns the integrity
// gate green is the blind verdict restated as a knob.
TEST(PanoGate, AnEvenCrossWindowCountIsRejectedNotSilentlyCollapsed) {
    rnis::pano::Engine eng;
    std::string err;
    for (int k : {2, 4, 6, 8}) {
        auto c = testConfig();
        c.crossWindows = k;
        EXPECT_FALSE(eng.configure(c, &err)) << "crossWindows=" << k << " accepted";
        EXPECT_NE(err.find("ODD"), std::string::npos) << err;
    }
    for (int k : {1, 3, 5, 7, 9}) {
        auto c = testConfig();
        c.crossWindows = k;
        EXPECT_TRUE(eng.configure(c, &err)) << "crossWindows=" << k << " rejected: " << err;
    }
}

// NOT MEASURED is its own state.  A session that painted strips and produced
// no seam samples must fail the verdict, not inherit v4's silence — this is
// the blind spot in its purest form: identical painted count, zero holes, zero
// gap breaks, zero clipping, and nothing measured.
TEST(PanoGate, AnUnmeasuredSeamIsNotCleanItIsUnmeasured) {
    const cv::Mat shelf = makeShelf(6000, 2600);

    auto blind = testConfig();
    blind.seamMetrics = false;
    blind.crossSweepFit = false;
    SweepResult b = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, blind);

    // Everything the v4 verdict could see says CLEAN.
    EXPECT_TRUE(b.holes.empty());
    EXPECT_EQ(b.stats.gapBreak, 0);
    EXPECT_EQ(b.stats.clippedFrames, 0);
    EXPECT_GT(b.stats.painted, 50);
    // And the verdict refuses to call it clean anyway.
    EXPECT_EQ(b.stats.seamBoundaries, 0);
    EXPECT_EQ(b.stats.seamCanvasJogSamples, 0);
    EXPECT_FALSE(b.stats.seamMeasured);
    EXPECT_TRUE(b.stats.integrityFailed) << "unmeasured reported as clean";
    EXPECT_NE(b.stats.integrityReason.find("NOT MEASURED"), std::string::npos)
        << b.stats.integrityReason;

    // crossWindows == 1 is the OTHER way to silence the band instrument, and
    // it must be treated the same way even though the jog still measures.
    auto oneWin = testConfig();
    oneWin.crossWindows = 1;
    SweepResult o = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, oneWin);
    EXPECT_EQ(o.stats.seamBoundaries, 0);
    EXPECT_GT(o.stats.seamCanvasJogSamples, 50);
    EXPECT_FALSE(o.stats.seamMeasured);
    EXPECT_TRUE(o.stats.integrityFailed);
    EXPECT_NE(o.stats.integrityReason.find("band metric NOT MEASURED"),
              std::string::npos) << o.stats.integrityReason;
}

// THE COMMITTED-PIXEL INSTRUMENT.  The band metric reconstructs the placement
// from the same measurement the placement was made of; the jog correlates the
// slab of canvas the incoming warp covers and the high-water clip discards, so
// it reads PAINTED PIXELS through the matrix that painted them.  The
// crossWindows == 1 arm is the clean demonstration: the band instrument is
// structurally silent there, and the jog still measures — and measures a
// materially worse number, because that arm really does place the cross axis
// from a single centred window.
TEST(PanoGate, TheCommittedPixelJogMeasuresWhereTheBandFitIsSilent) {
    const cv::Mat shelf = makeShelf(6000, 2600);

    auto full = testConfig();
    auto oneWin = testConfig();
    oneWin.crossWindows = 1;

    SweepResult a = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, full);
    SweepResult b = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, oneWin);

    ASSERT_GT(a.stats.seamCanvasJogSamples, 50);
    ASSERT_GT(b.stats.seamCanvasJogSamples, 50);
    // The band instrument says NOTHING in the one-window arm...
    EXPECT_EQ(b.stats.seamBoundaries, 0);
    EXPECT_DOUBLE_EQ(b.stats.seamWorstBandP95Px, 0.0);
    // ...while the pixels say the placement is materially worse.
    EXPECT_GT(b.stats.seamCanvasJogP95Px, 2.0 * a.stats.seamCanvasJogP95Px)
        << "one-window jog=" << b.stats.seamCanvasJogP95Px
        << " full jog=" << a.stats.seamCanvasJogP95Px;
    EXPECT_LT(a.stats.seamCanvasJogP95Px, 1.5);
}

// The jog must not invent a cut out of the canvas vertical-growth re-base
// either: it is measured on the canvas AFTER the re-base, where the old
// content moved with it, so the shift cancels.
TEST(PanoGate, TheCommittedPixelJogIgnoresTheCanvasGrowthRebase) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 110;
    s.dx = 14.0;
    s.dy = -6.0;                        // forces vShiftPx re-bases
    SweepResult r = runProjectedSweep(shelf, s, testConfig());

    ASSERT_GT(r.stats.canvasHeightGrowths, 0) << "no growth — fixture drifted";
    EXPECT_GT(r.stats.vShiftTotalPx, 0.0);
    ASSERT_GT(r.stats.seamCanvasJogSamples, 20);
    EXPECT_LT(r.stats.seamCanvasJogMaxPx, 1.5)
        << "the vertical-growth re-base leaked into the committed-pixel jog";
    EXPECT_FALSE(r.stats.integrityFailed) << r.stats.integrityReason;
}

// crossBandDivergencePx is a CUMULATIVE sum, so an absolute bar on it fails a
// long sweep for being long.  The gated quantity is divided by sqrt(n), which
// is stationary under noise at any length — pin that the same gesture run four
// times longer does not walk the gated number up with it.
// ⚠ 2026-08-23 — THIS TEST WAS THE INSTRUMENT THAT CAUGHT THE FIXTURE BUG,
// and the record of what it caught belongs here because the obvious reading of
// its old failure was the wrong one.
//
// Built at -O2 and at -Os (the levels the Release pod ships at, and the ones
// the host tests were never run at) the SHORT arm failed the photometric
// clauses, deterministically, while the LONG arm — same shelf, same noiseDN,
// same engine, four times as many boundaries — came back clean:
//
//     short  stepMax 54.629 DN  driftTotal 422.071%  appliedBand 11.111%
//     long   stepMax  0.940 DN  driftTotal   1.622%  appliedBand  0.562%
//
// An engine cannot be photometrically broken on 150 frames and correct on 620
// of the same frames.  It was the INPUT that differed: runProjectedSweep's
// per-frame noise buffer was uninitialised memory (RNG::fill given bare
// doubles for a 3-channel destination never wrote it), so the arm that ran on
// a cold heap was fed saturating garbage and the arm that ran on a warm heap
// was fed nothing at all.  A discarded warm-up sweep was added here to make
// the failure deterministic; it papered over the asymmetry without removing
// it, and it is gone now that the cause is fixed at source.
//
// THE GATE WAS RIGHT AND THE FIXTURE WAS WRONG.  Not one threshold moved.
// With the noise generated correctly the same two arms read:
//
//     short  stepMax 0.421 DN  driftTotal 0.960%  appliedBand 0.330%
//     long   stepMax 0.576 DN  driftTotal 2.349%  appliedBand 0.399%
//
// and the test passes at -O0, -O2 and -Os.  See
// PanoDeterminism.EveryRunInAProcessIsBitIdenticalIncludingTheFirst.
//
// RE-MEASURED INDEPENDENTLY 2026-08-23, one -O0 host build with ONLY the fill
// reverted to bare doubles, everything else identical:
//
//     broken  short  stepMax 36.538 DN  driftTotal 9.586%  appliedBand 13.871%
//     broken  long   stepMax 36.538 DN  driftTotal 9.660%  appliedBand 13.871%
//     fixed   short  stepMax  0.421 DN  driftTotal 0.960%  appliedBand  0.330%
//     fixed   long   stepMax  0.576 DN  driftTotal 2.349%  appliedBand  0.399%
//
// The broken arms fail as 'seam DC step max > 3.00 DN' + 'photometric band >
// 6% over 40 px', and the engine also raises nonUniform=1 on them — i.e. the
// gate is reporting real photometric damage that was really present in the
// pixels it was handed.  Note the magnitudes do NOT match the -O2/-Os figures
// quoted above (422% vs 9.6%); that is expected and is itself evidence, since
// what the broken fill leaves in the buffer depends on heap history rather
// than on anything the program computed.  Measured far enough, THIS test's
// failure on a broken build is itself intermittent — a later broken build,
// same source, came back green on this clause while
// PanoDeterminism.EveryRunInAProcessIsBitIdenticalIncludingTheFirst still went
// red.  So do not use a green here as evidence the fixture is sound; the
// determinism test is the sensitive instrument, and this one is corroboration.
// The VERDICT is what reproduces: fixture wrong, gate right, no threshold
// touched.
TEST(PanoGate, TheDivergenceBarIsNormalisedNotAbsolute) {
    const cv::Mat shelf = makeShelf(12000, 3400);
    auto cfg = testConfig();

    // NOISE IS LOAD-BEARING HERE.  A noiseless synthetic has no per-boundary
    // residual to random-walk at all — measured: the seam divergence of a
    // clean walk is 0.61 px at 52 boundaries and 0.55 px at 452 — so it cannot
    // answer a question about a session-cumulative statistic.
    ProjSweepSpec shortS; shortS.n = 150; shortS.dx = 14.0; shortS.noiseDN = 9.0;
    ProjSweepSpec longS;  longS.n  = 620; longS.dx  = 14.0; longS.noiseDN = 9.0;
    SweepResult a = runProjectedSweep(shelf, shortS, cfg);
    SweepResult b = runProjectedSweep(shelf, longS, cfg);

    SCOPED_TRACE("short arm: " + sweepSummary(a.stats));
    SCOPED_TRACE("long  arm: " + sweepSummary(b.stats));
    ASSERT_GT(b.stats.seamBoundaries, 3 * a.stats.seamBoundaries)
        << "the long arm is not actually longer";
    ASSERT_GT(a.stats.seamBoundaries, 20);

    // The gated field IS raw / sqrt(n).
    EXPECT_NEAR(a.stats.crossBandDivergenceNormPx,
                a.stats.crossBandDivergencePx /
                    std::sqrt((double)a.stats.seamBoundaries), 1e-9);
    EXPECT_NEAR(b.stats.crossBandDivergenceNormPx,
                b.stats.crossBandDivergencePx /
                    std::sqrt((double)b.stats.seamBoundaries), 1e-9);

    // The RAW sum tracks the length; the gated number does not.  Measured on
    // this fixture: raw 0.96 -> 1.44 over 142 -> 612 boundaries, normalised
    // 0.080 -> 0.058.
    EXPECT_GT(b.stats.crossBandDivergencePx, a.stats.crossBandDivergencePx);
    EXPECT_LT(b.stats.crossBandDivergenceNormPx,
              2.0 * a.stats.crossBandDivergenceNormPx)
        << "short=" << a.stats.crossBandDivergenceNormPx
        << " long=" << b.stats.crossBandDivergenceNormPx;
    EXPECT_FALSE(a.stats.integrityFailed)
        << "short arm: " << a.stats.integrityReason << "  " << photoSummary(a.stats);
    EXPECT_FALSE(b.stats.integrityFailed)
        << "long arm: " << b.stats.integrityReason << "  " << photoSummary(b.stats);

    // SCOPE, stated rather than papered over: no synthetic fixture in this
    // suite reaches either bar — the engine's residuals on rendered frames are
    // an order of magnitude cleaner than on a real pack (measured on device
    // pack 15-58-22, truncated: raw 1.6 / 3.1 / 19.5 / 52.4 px at 73 / 107 /
    // 192 / 318 boundaries).  So the numbers above pin the SHAPE of the
    // statistic; the offline replay of the four device packs is what
    // calibrates the bar.  What this test CAN pin in-process is which
    // quantity the shipped verdict reads, which is the half a raw-bar build
    // gets wrong:
    SweepResult broken = runApproachSweep(makeShelf(6000, 2600), 120, 12.0,
                                          0.26, 0.6, planarConfig());
    ASSERT_TRUE(broken.stats.integrityFailed);
    EXPECT_NE(broken.stats.integrityReason.find("sqrt(n)"), std::string::npos)
        << "the divergence clause is not reading the normalised quantity: "
        << broken.stats.integrityReason;
}

// ── ATTRIBUTION + RE-BASING ────────────────────────────────────────────────

// A relatch THROWS THE CANVAS AWAY and re-seeds from a new reference, so the
// session metrics must be re-based with it — otherwise the operator-facing
// warping number and the seam percentiles describe strips that are not in the
// deliverable, and the verdict can be driven by content nobody can see.
TEST(PanoRelatch, SessionMetricsAreReBasedWithTheDiscardedCanvas) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();

    // The mis-latch fixture: a walk carrying a settling transverse tilt, which
    // captures the axis vote and is then corrected.
    const auto steps = walkWithTransversePitch(120, 14.0, [](int i) {
        return i < 20 ? 8.0 * std::sin(CV_PI * (double)i / 20.0) : 0.0;
    });
    SweepResult r = runGestureSweep(shelf, steps, cfg);
    ASSERT_GT(r.stats.relatchCount, 0) << "fixture no longer relatches";
    ASSERT_GT(r.stats.painted, 20);

    // Every seam sample must post-date the relatch, so the boundary count can
    // never exceed the strips committed since it.
    EXPECT_LE(r.stats.seamBoundaries, r.stats.painted);
    EXPECT_LE(r.stats.seamCanvasJogSamples, r.stats.painted);
    // ...and the sweep extent is measured from the NEW reference.
    EXPECT_GE(r.stats.sweepDeg, 0.0);
    EXPECT_LT(r.stats.sweepDeg, 180.0);
    EXPECT_EQ(r.stats.projectionSwitchSeq >= 0, r.stats.axisLatched &&
                                                    cfg.projection == 1);
    // The window-origin clamp count is re-based too, alongside
    // crossScaleCagedFrames — it grades the chain that produced the DELIVERED
    // canvas, and a relatch throws the previous one away.  It can therefore
    // never exceed the frames committed since the correction.
    //
    // ⚠ THIS LINE IS A BOUND, NOT THE PIN.  At the shipped window size this
    // fixture never clamps, so the bound holds at 0 whether the re-base is
    // present or not (verified: deleting `corrOriginClamped = 0;` from
    // reseedReferenceTo() leaves this test green).  The re-base itself is
    // pinned by PanoRelatch.TheOriginClampCountIsReBasedWithTheDiscardedCanvas,
    // which widens the window until the pre-relatch chain actually clamps.
    EXPECT_LE(r.stats.corrOriginClampedFrames, (int64_t)r.stats.painted);
}

// (2) RE-BASED BY A RELATCH.
//
// A relatch discards the canvas, so a clamp on the chain that produced the
// discarded one grades content nobody can see.  The existing
// PanoRelatch.SessionMetricsAreReBasedWithTheDiscardedCanvas cannot see this:
// at the SHIPPED window size that fixture never clamps, so its bound holds at
// 0 whether the re-base is there or not (demonstrated — deleting the re-base
// leaves it green).
//
// The discriminator is a fixture whose clamps are CONFINED to the pre-relatch
// chain.  A 14° transverse tilt over the first 20 frames clamps at the whole-
// raster window while the footprint is still tight, and is then flat, so
// nothing clamps afterwards; the mis-latch it causes is corrected later.  The
// same gesture TRUNCATED before the relatch is the non-vacuity arm: it has not
// yet re-based, so what it reports is exactly what the re-base throws away.
TEST(PanoRelatch, TheOriginClampCountIsReBasedWithTheDiscardedCanvas) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    auto cfg = testConfig();
    cfg.phaseWindowPx = 1600;             // ⇒ 720×540, the whole work raster

    const auto tilt = [](int i) {
        return i < 20 ? 14.0 * std::sin(CV_PI * (double)i / 20.0) : 0.0;
    };
    SweepResult full   = runGestureSweep(shelf, walkWithTransversePitch(120, 14.0, tilt), cfg);
    SweepResult prefix = runGestureSweep(shelf, walkWithTransversePitch(26,  14.0, tilt), cfg);

    ASSERT_GT(full.stats.relatchCount, 0)   << "fixture no longer relatches";
    ASSERT_EQ(prefix.stats.relatchCount, 0)
        << "the truncated arm already relatched — it is no longer a picture of "
           "the chain the re-base discards";
    ASSERT_GT(prefix.stats.painted, 0);
    ASSERT_GT(full.stats.painted, 20);

    // NON-VACUITY.  The pre-relatch chain really does clamp; frames 0-25 are
    // byte-identical inputs in both arms, so the full run clamped this many
    // times too before it corrected itself.
    ASSERT_GT(prefix.stats.corrOriginClampedFrames, 0)
        << "the pre-relatch chain no longer clamps — the test asserts nothing";

    // THE PIN.  Those clamps belong to a canvas that was thrown away, so the
    // delivered pack must not still be carrying them.
    EXPECT_LT(full.stats.corrOriginClampedFrames,
              prefix.stats.corrOriginClampedFrames)
        << "after a relatch the count is still "
        << full.stats.corrOriginClampedFrames << ", and the discarded chain on "
           "its own reported " << prefix.stats.corrOriginClampedFrames
        << " — the re-base in reseedReferenceTo() is gone";
}


// The tail flush paints a WHOLE footprint and is usually where the session's
// worst area magnification lives (the 13.0x floor trapezoid on device pack
// 15-59-29 is that row).  Leaving row.areaScale at 1.0 made the row that
// CAUSED the session maximum claim it had seen nothing.
TEST(PanoFinalize, TheTailFlushRowCarriesTheWarpingItCommitted) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 12.0;
    s.pitchDeg = 26.0;                    // a real excursion, so sec^3 bites
    SweepResult r = runProjectedSweep(shelf, s, testConfig());

    const rnis::pano::FrameOutcome* tail = nullptr;
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::TailFlush) tail = &row;
    ASSERT_NE(tail, nullptr) << "no tail flush row";
    ASSERT_GT(tail->canvasX1, tail->canvasX0) << "tail flush painted nothing";
    EXPECT_GT(tail->areaScale, 1.0)
        << "the tail flush painted a whole footprint and reported no warping";
    EXPECT_LE(tail->areaScale, r.stats.maxAreaScalePainted + 1e-9);
}

// subjectDistanceUsedM used to report Config::subjectDistanceM even though the
// default subjectDistanceAuto means the placement used the ONLINE FIT.  A
// field named "used" carrying the value that was not used is worse than no
// field at all.
TEST(PanoCrossSweep, TheReportedSubjectDistanceIsTheOneThePlacementUsed) {
    const cv::Mat shelf = makeShelf(6000, 2600);

    auto autoOn = testConfig();
    autoOn.subjectDistanceM = 1.5;
    SweepResult a = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, autoOn);
    ASSERT_GT(a.stats.subjectDistanceFitM, 0.0) << "the online fit never ran";
    EXPECT_DOUBLE_EQ(a.stats.subjectDistanceUsedM, a.stats.subjectDistanceFitM);
    EXPECT_DOUBLE_EQ(a.stats.subjectDistanceConfiguredM, 1.5);
    EXPECT_NE(a.stats.subjectDistanceUsedM, a.stats.subjectDistanceConfiguredM);

    auto autoOff = testConfig();
    autoOff.subjectDistanceAuto = false;
    autoOff.subjectDistanceM = 1.5;
    SweepResult b = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, autoOff);
    EXPECT_DOUBLE_EQ(b.stats.subjectDistanceUsedM, 1.5);
    EXPECT_DOUBLE_EQ(b.stats.subjectDistanceConfiguredM, 1.5);
}

// The projection law changes at the axis latch (psi is gated on it), so the
// frame before is placed on the tangent and the frame after on the arc.  It is
// bounded and self-correcting, but the brief asked that the projection never
// change mid-sweep unledgered.
TEST(PanoProjection, TheMidSweepSwitchIsLedgeredNotSilent) {
    const cv::Mat shelf = makeShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.dx = 14.0;
    s.pitchDeg = 18.0;
    SweepResult cyl = runProjectedSweep(shelf, s, testConfig());
    SweepResult pln = runProjectedSweep(shelf, s, planarConfig());

    ASSERT_TRUE(cyl.stats.axisLatched);
    EXPECT_GE(cyl.stats.projectionSwitchSeq, 0)
        << "the sweep-cylindrical arm switched law without ledgering it";
    EXPECT_GE(cyl.stats.projectionSwitchStepPx, 0.0);
    EXPECT_LT(cyl.stats.projectionSwitchStepPx, 80.0)
        << "the one-frame law-change step is meant to be bounded by the "
           "excursion gate";
    // The planar arm never switches, so it must say so.
    EXPECT_EQ(pln.stats.projectionSwitchSeq, -1);
}

// stats() is called once per ingested frame by the session owner and the seam
// sample vectors grow one entry per committed strip, so percentiling them on
// every call is an O(n log n) per frame that FrameOutcome::engineMs cannot
// even see.  The roll-ups are cached; pin that caching did not change them.
TEST(PanoGate, PerFrameStatsDoesNotCostMoreAsTheSweepGrows) {
    // LONG on purpose: the cost this pins grows with the strip count, and the
    // measured pre-fix numbers (0.014 ms at 0 strips, 0.125 ms at 1586) are
    // invisible at a couple of hundred.
    const cv::Mat shelf = makeShelf(18400, kFrameH);
    rnis::pano::Engine eng;
    std::string err;
    auto cfg = testConfig();
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    const auto xs = linearSweep(200, 18.0, 900);
    double statsEarlyMs = 0.0, statsLateMs = 0.0;
    for (size_t i = 0; i < xs.size(); ++i) {
        cv::Mat crop = shelf(cv::Rect((int)std::lround(xs[i]), 0,
                                      kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = xs[i] * (0.6 / kFx);
        in.tracking = 2; in.seq = (int64_t)i;
        eng.ingest(in);
        // The session owner calls stats() once per ingested frame, and MOST
        // ingested frames commit a strip — so a dirty-flag cache would still
        // sort on nearly every one of them.  Time the call at both ends of the
        // sweep: with the samples sorted at insert it must not grow.
        const double t0 = nowMsForTest();
        for (int k = 0; k < 40; ++k) eng.stats();
        const double dt = (nowMsForTest() - t0) / 40.0;
        if (i == 20) statsEarlyMs = dt;
        if (i + 1 == xs.size()) statsLateMs = dt;
    }
    eng.finish();
    const auto a = eng.stats();
    const auto b = eng.stats();
    EXPECT_DOUBLE_EQ(a.seamWorstBandP50Px, b.seamWorstBandP50Px);
    EXPECT_DOUBLE_EQ(a.seamWorstBandP95Px, b.seamWorstBandP95Px);
    EXPECT_DOUBLE_EQ(a.seamWorstBandMaxPx, b.seamWorstBandMaxPx);
    EXPECT_DOUBLE_EQ(a.seamCanvasJogP95Px, b.seamCanvasJogP95Px);
    EXPECT_EQ(a.integrityFailed, b.integrityFailed);
    // The measured cost before the fix grew 0.014 -> 0.125 ms across a
    // 1586-strip sweep.  Allow generous slack for host scheduling noise; what
    // must NOT happen is the late call costing multiples of the early one.
    EXPECT_LT(statsLateMs, statsEarlyMs + 0.02)
        << "stats() early=" << statsEarlyMs << " ms late=" << statsLateMs
        << " ms — the per-frame roll-up is tracking the sweep length";
    EXPECT_GT(a.seamBoundaries, 50);
    EXPECT_GE(a.seamCoverageFrac, 0.5);
    // The cached max is >= the p95, which "the last sample after a sort" only
    // happens to satisfy while percentileOf() is called on the preceding line.
    EXPECT_GE(a.seamWorstBandMaxPx, a.seamWorstBandP95Px);
    EXPECT_GE(a.seamCanvasJogMaxPx, a.seamCanvasJogP95Px);
}


// ── v6: PHOTOMETRY — THE BANDING THE OPERATOR REJECTED TWICE ────────────────
//
// Every test below FAILS on v5, and each one fails for a different reason:
// the config knob does not exist, the metric does not exist, or the verdict
// does not gate on it.  Together they pin the three parts of the fix:
//
//   A. exposure metadata → EXACT radiometric normalisation (Config::
//      exposureNormalize).  Strictly better than estimating gain from image
//      overlap, because it is not estimated at all.
//   B. the chained overlap fit demoted to a BOUNDED RESIDUAL corrector
//      (Config::gainLeak, ON in v6) so its per-strip error cannot integrate
//      into the 10-24%-over-40-columns excursions measured on the operator's
//      own four packs.
//   C. a photometric seam metric that is measured over the WHOLE shared
//      footprint, uniformity-tested, and FOLDED INTO THE VERDICT — v5
//      measured a single-column step, did not gate on it, and reported pack
//      15-58-22 clean with a visible band in it.

namespace {

/// A sweep whose camera brightens by `endGain` over the run — the shape of
/// the operator's own packs (measured C = 1.50-1.79 end to end).  `withMeta`
/// decides whether the camera also REPORTS the exposure it used.
SweepResult runExposureRamp(const cv::Mat& shelf,
                            const rnis::pano::Config& cfg,
                            double endGain, bool withMeta, int nFrames,
                            double shadingSpan = 1.0) {
    SweepSpec spec;
    spec.xs = linearSweep(200, 14.0, nFrames);
    spec.shadingSpan = shadingSpan;
    const int n = (int)spec.xs.size();
    spec.gains.resize((size_t)n);
    if (withMeta) {
        spec.expDur.assign((size_t)n, 1.0 / 60.0);
        spec.expISO.resize((size_t)n);
    }
    for (int i = 0; i < n; ++i) {
        const double f = (n > 1) ? (double)i / (double)(n - 1) : 0.0;
        const double g = std::pow(endGain, f);
        spec.gains[(size_t)i] = g;
        // A camera that brightens by g HAS a g-times-larger exposure, and says
        // so.  ISO carries it here; duration would be identical arithmetic.
        if (withMeta) spec.expISO[(size_t)i] = 100.0 * g;
    }
    return runSweepSpec(shelf, spec, cfg);
}

}  // namespace

TEST(PanoPhotometry, ExposureMetadataNormalisesARampTheOverlapFitCannotTrack) {
    // THE CONTROL IS A THIRD ARM.  Comparing an arm's canvas against its own
    // column-luma spread would measure the SCENE, not the photometry; comparing
    // it against the same sweep with a FLAT camera removes the scene exactly.
    //
    // The shelf is dimmed to 55% first so a 1.6× brightening does not CLIP —
    // clipped highlights are unrecoverable by any normalisation and would score
    // as a normalisation failure that is really a sensor one.
    const cv::Mat shelf = linearGainT(makeShelf(4200, kFrameH), 0.55);
    auto cfg = testConfig();

    // THE ESTIMATOR MUST BE BIASED, or this test measures nothing.  Measured
    // first, and it changed the test: with a UNIFORM synthetic frame the
    // chained overlap fit is UNBIASED — its target is exactly the frame-to-
    // frame gain ratio — so it tracks a global exposure ramp essentially
    // perfectly and exact normalisation cannot beat it (measured: 0.71 DN vs
    // 0.93 DN from the control, a 23% edge, and the committed drift TIED at
    // ~1%).  The normalisation earns its keep only where the fit is biased,
    // which in the field it always is: the gain is fitted on the overlap
    // sample window and applied to the strip, so any gradient FIXED IN THE
    // FRAME — lens shading, flare — makes the two disagree on every strip.
    // `shadingSpan` is that condition, and the flat control carries it too so
    // the only difference between the arms is the camera ramp itself.
    const double kShading = 2.40;
    const SweepResult flat = runExposureRamp(shelf, cfg, 1.0, false, 140, kShading);
    const SweepResult on   = runExposureRamp(shelf, cfg, 1.6, true, 140, kShading);
    auto cfgOff = cfg;
    cfgOff.exposureNormalize = false;
    const SweepResult off  = runExposureRamp(shelf, cfgOff, 1.6, false, 140, kShading);

    ASSERT_GT(flat.stats.painted, 20);
    ASSERT_GT(on.stats.painted, 20);
    ASSERT_GT(off.stats.painted, 20);
    // The geometry must be the same in all three arms, or the pixel comparison
    // below would be measuring a different panorama rather than a different
    // exposure.
    //
    // WITHIN 2 px, not exactly: the three arms are fed
    // DIFFERENT PIXELS (that is the point of the fixture — one carries a 1.6x
    // camera ramp), so their registration chains are not obliged to agree
    // exactly.  Phase correlation is whitened and therefore exposure-invariant
    // in principle, but the ramp still changes the 8-bit quantisation of every
    // work pixel.  At work scale 0.5 the resulting disagreement rounded away;
    // at 0.75 the estimator is fine enough to keep 1 px of it (1682 vs 1681).
    // `canvasMeanAbsDiff` already compares over the COMMON extent, so a 1-2 px
    // difference in painted width does not make the comparison unlike-for-like.
    ASSERT_NEAR(flat.stats.paintedW, on.stats.paintedW, 2);
    ASSERT_NEAR(flat.stats.paintedW, off.stats.paintedW, 2);

    // THE TRACE IS THE EVIDENCE, and it is recorded in BOTH arms — the arm
    // running unnormalised is exactly the one where it matters.
    EXPECT_GT(on.stats.exposureMetaFrames, 20);
    EXPECT_NEAR(on.stats.exposureRangeRatio, 1.6, 0.05)
        << "the pack must state what the camera's exposure actually did";
    EXPECT_EQ(off.stats.exposureMetaFrames, 0);
    EXPECT_DOUBLE_EQ(off.stats.exposureRangeRatio, 1.0);

    // THE CLAIM, measured against a MATCHED CONTROL: with the camera's own
    // exposure known, the canvas ends up closer to the panorama the same sweep
    // would have produced had the camera never moved.  Measured: 0.69 DN vs
    // 1.01 DN.
    // PER-COLUMN MEAN, not per pixel, and the bar is 0.80 rather than 0.75.
    // Both changes came out of the 2026-08-24 precision round, which ran this
    // fixture at four work scales; both are stated rather than tuned quietly:
    //
    //   · the flat control is the one arm fed DIFFERENT PIXELS, so its chain
    //     is free to disagree with the two ramped arms'.  At work scale 0.5 it
    //     agreed to well under a pixel; from 0.625 the estimator is fine
    //     enough to respond to the ramp's own 8-bit quantisation and the
    //     chains part SUB-PIXEL — same painted count (133/133/133), same
    //     painted width, same end gain, different resampled pixels.  A
    //     per-pixel comparison then reads a ~1.7 DN texture floor that has
    //     nothing to do with exposure and that no integer realignment removes
    //     (checked: the best integer shift is 0,0).  A column MEAN is blind to
    //     a sub-pixel offset and IS the quantity the claim is about.
    //   · the residual floor still compresses the ratio, so the margin is
    //     smaller than at 0.5.  Measured, column means, this fixture:
    //         ws 0.5    0.256 / 0.667  ratio 0.38
    //         ws 0.625  0.306 / 0.778  ratio 0.39
    //         ws 0.75   0.718 / 0.963  ratio 0.75   <- shipped
    //         ws 1.0    0.345 / 0.731  ratio 0.47
    //     The CLAIM — the normalisation gets closer to the flat-camera
    //     panorama — holds at every scale; only the fixture's discrimination
    //     narrows, and it narrows because of the control, not the feature.
    const double dOn  = canvasColumnMeanAbsDiff(on.canvas, flat.canvas);
    const double dOff = canvasColumnMeanAbsDiff(off.canvas, flat.canvas);
    EXPECT_LT(dOn, dOff)
        << "normalised=" << dOn << " DN unnormalised=" << dOff
        << " DN from the flat-camera control";
    EXPECT_LT(dOn, 0.80 * dOff)
        << "normalised=" << dOn << " DN unnormalised=" << dOff
        << " DN from the flat-camera control";

    // Both arms must MEASURE the seam — an arm that goes quiet is not a
    // cleaner arm.
    EXPECT_GT(on.stats.seamPhotoSamples, 20);
    EXPECT_GT(off.stats.seamPhotoSamples, 20);

    // WHAT THIS TEST DELIBERATELY DOES NOT ASSERT, and why — because the
    // measurement was taken before the assertion was written:
    //
    //   · `seamPhotoStepP95DN`.  The unnormalised arm's chained fit MINIMISES
    //     the per-boundary step by construction — that is literally the
    //     quantity it fits — so it wins there (0.28 vs 0.38 DN on a uniform
    //     frame) while losing on the pixels.  A gate reading only the
    //     per-boundary number would prefer the worse panorama.
    //   · `seamPhotoDriftTotalPct`.  Both arms carry the SAME in-frame shading
    //     bias, and integrating it dominates the exposure term here (36% vs
    //     31%); the flat-camera control subtracts it, the integral cannot.
    //     The integral is a defect indicator for a deliverable, not an
    //     attribution between two causes.
    //
    // Both numbers are real and both are reported in the pack.  Neither is the
    // claim this test makes.
}

TEST(PanoPhotometry, PhotometryIsFoldedIntoTheVerdictNotMerelyReported) {
    // THE v5 DEFECT, restated as a test.  v5 MEASURED a seam DC step and left
    // it out of `integrityReason`, so pack 15-58-22 verdicted CLEAN with a
    // band the operator could see.  A session whose committed boundaries carry
    // a real photometric step must now FAIL, and the reason must name it.
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 10.0, 320);
    spec.shadingSpan = 2.40;      // a strongly biased overlap estimator
    auto cfg = testConfig();
    cfg.gainLeak = 0.0;           // v5's default: nothing anchors the chain

    const SweepResult r = runSweepSpec(shelf, spec, cfg);
    ASSERT_GT(r.stats.painted, 50);
    EXPECT_GT(r.stats.seamPhotoSamples, 20)
        << "the photometric seam must be MEASURED before it can be gated";
    EXPECT_TRUE(r.stats.integrityFailed);
    EXPECT_NE(r.stats.integrityReason.find("seam DC step"), std::string::npos)
        << "reason was: " << r.stats.integrityReason;

    // The band instrument is a DIFFERENT quantity from the per-boundary step:
    // it integrates the chain over a window, so it is locatable in the image
    // and bounded by the end-to-end range.
    EXPECT_GT(r.stats.photoLocalP2PPct, 0.0);
    EXPECT_GE(r.stats.photoScaleRangePct, r.stats.photoLocalP2PPct - 1e-9)
        << "a window inside the sweep cannot swing more than the whole sweep";
    EXPECT_GT(r.stats.photoLocalWorstU, 0)
        << "the band must be locatable in the image, not just a scalar";
    EXPECT_GT(r.stats.photoColumns, 100);
}

TEST(PanoPhotometry, NoExposureMetadataIsBitIdenticalToTheUnnormalisedPath) {
    // THE PARITY CLAUSE.  Every pack captured before v6 carries no exposure
    // metadata, so replaying one must exercise the new code path and change
    // NOTHING — otherwise the before/after on the operator's four packs would
    // be confounded by an unrelated pixel change and neither number would mean
    // anything.
    const cv::Mat shelf = makeShelf(4200, kFrameH);
    auto cfgOn = testConfig();
    cfgOn.exposureNormalize = true;
    auto cfgOff = testConfig();
    cfgOff.exposureNormalize = false;

    SweepSpec spec;
    spec.xs = linearSweep(200, 14.0, 120);
    spec.shadingSpan = 1.20;      // a real, drift-producing estimator error

    const SweepResult a = runSweepSpec(shelf, spec, cfgOn);
    const SweepResult b = runSweepSpec(shelf, spec, cfgOff);
    ASSERT_FALSE(a.canvas.empty());
    ASSERT_EQ(a.canvas.size(), b.canvas.size());
    cv::Mat diff;
    cv::absdiff(a.canvas, b.canvas, diff);
    EXPECT_EQ(0.0, cv::sum(diff)[0] + cv::sum(diff)[1] + cv::sum(diff)[2])
        << "exposureNormalize must be the IDENTITY without metadata";
    EXPECT_EQ(a.stats.exposureMetaFrames, 0);
    EXPECT_EQ(a.stats.paintedW, b.stats.paintedW);
}

TEST(PanoPhotometry, TheGainLeakAnchorsTheAppliedFieldAndTheDefaultIsStillOff) {
    // TWO CLAIMS, and they point in opposite directions — which is exactly why
    // both are pinned here rather than one being quietly assumed.
    //
    // 1. THE MECHANISM IS REAL.  A gain gradient FIXED IN THE FRAME makes the
    //    overlap sample window and the committed strip see different
    //    brightnesses, so the chained estimator is biased on every strip, and
    //    with nothing anchoring it those biases INTEGRATE.  `gainLeak` is the
    //    mean-reversion that stops that, and it demonstrably does.
    //
    // 2. THE DEFAULT IS STILL OFF, because claim 1 is about the field the
    //    ENGINE APPLIED — the engine scoring its own correction.  Measured on
    //    the operator's four packs against COMMITTED PIXELS instead, the leak
    //    makes the end-to-end drift 3-6x worse and the local band worse on half
    //    of them (full table in rnis_pano.hpp).  Shipping it on would have been
    //    the same class of blind verdict v5 exists to remove.
    const cv::Mat shelf = makeShelf(7000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 12.0, 240);
    spec.shadingSpan = 2.40;

    auto cfgFree = testConfig();
    cfgFree.gainLeak = 0.0;
    auto cfgAnchored = testConfig();
    cfgAnchored.gainLeak = 0.15;

    // The DEFAULT is part of the finding, so it is asserted, not assumed.
    EXPECT_DOUBLE_EQ(rnis::pano::Config().gainLeak, 0.0)
        << "the leak is REFUTED on committed pixels; a non-zero default would "
           "be an untested one";
    EXPECT_TRUE(rnis::pano::Config().exposureNormalize);

    const SweepResult free_ = runSweepSpec(shelf, spec, cfgFree);
    const SweepResult anch = runSweepSpec(shelf, spec, cfgAnchored);
    ASSERT_GT(free_.stats.painted, 50);
    ASSERT_GT(anch.stats.painted, 50);
    ASSERT_EQ(free_.stats.paintedW, anch.stats.paintedW);

    // Claim 1, on the APPLIED field.
    EXPECT_LT(anch.stats.photoScaleRangePct, free_.stats.photoScaleRangePct)
        << "free=" << free_.stats.photoScaleRangePct
        << "% anchored=" << anch.stats.photoScaleRangePct << "%";
    EXPECT_LT(anch.stats.photoLocalP2PPct, free_.stats.photoLocalP2PPct)
        << "free=" << free_.stats.photoLocalP2PPct
        << "% anchored=" << anch.stats.photoLocalP2PPct << "%";

    // Both instruments must exist and be independent: the committed one reads
    // painted pixels, the applied one reads the engine's own arithmetic, and a
    // session must never be able to report the second without the first.
    EXPECT_GT(free_.stats.seamPhotoDriftTotalPct, 0.0);
    EXPECT_GT(anch.stats.seamPhotoDriftTotalPct, 0.0);

    // The geometry must be untouched — this is a photometric change only.
    EXPECT_EQ(free_.holes.size(), anch.holes.size());
    EXPECT_NEAR(free_.stats.seamCanvasJogP95Px, anch.stats.seamCanvasJogP95Px, 0.25);
}

TEST(PanoPhotometry, ASeamFreeCanvasDoesNotFireThePhotometricGate) {
    // THE FALSE-POSITIVE SIDE.  The operator has been handed four "clean"
    // verdicts on banded output; a gate added in response must not now fail
    // output that is genuinely fine.  A sweep with NO photometric change at
    // all — one camera, one exposure, no in-frame gradient — must measure the
    // seam, report a near-zero step, and name no photometric clause.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 12.0, 200);

    const SweepResult r = runSweepSpec(shelf, spec, testConfig());
    ASSERT_GT(r.stats.painted, 30);
    EXPECT_GT(r.stats.seamPhotoSamples, 20)
        << "measured, not silent — 'not measured' is its own failure";
    EXPECT_LT(r.stats.seamPhotoStepP95DN, 1.20)
        << "p95=" << r.stats.seamPhotoStepP95DN << " DN on a seam-free sweep";
    EXPECT_LT(r.stats.seamPhotoStepMaxDN, 3.00);
    EXPECT_LT(r.stats.seamPhotoDriftLocalPct, 6.00);
    EXPECT_LT(r.stats.photoLocalP2PPct, 6.00);
    EXPECT_LT(r.stats.photoScaleRangePct, 20.00);
    EXPECT_EQ(r.stats.integrityReason.find("photometric"), std::string::npos)
        << "reason was: " << r.stats.integrityReason;
    EXPECT_EQ(r.stats.integrityReason.find("seam DC step"), std::string::npos)
        << "reason was: " << r.stats.integrityReason;
}

TEST(PanoPhotometry, ARaggedRowDifferenceIsNotClaimedAsAPhotometricStep) {
    // THE UNIFORMITY TEST.  A top-to-bottom gain ramp that flips sign every
    // frame produces a large difference ALONG THE BOUNDARY'S EXTENT at every
    // boundary, whose trimmed mean is near zero — a shading-shaped
    // disagreement, not an exposure step.  Two things must hold and they are
    // different claims:
    //
    //   (a) the GATE stays quiet.  This is the false-positive guard: the step
    //       clauses must not fire on a defect they are not measuring.
    //   (b) the DIAGNOSTIC says so.  A metric that is quiet because it found
    //       nothing is indistinguishable from one that is quiet because it
    //       declined, and only the second is honest here.
    //
    // (An earlier revision of this test asserted neither.  It read
    // `if (uniform >= 0.60) continue; EXPECT_LT(uniform, 0.60);` — it skipped
    // exactly the rows that could fail and then asserted the negation of the
    // skip condition, so it could not fail.  Caught in review.)
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 12.0, 200);
    spec.rowShadingSpan = 1.60;

    const SweepResult r = runSweepSpec(shelf, spec, testConfig());
    ASSERT_GT(r.stats.painted, 30);
    ASSERT_GT(r.stats.seamPhotoSamples, 20);

    // (a) THE GATE IS QUIET.  Named clauses, not a bare `!integrityFailed`:
    // this fixture has a real row-shading defect and other clauses may well
    // have an opinion about it — the claim is only that the PHOTOMETRIC STEP
    // clauses do not fire.
    EXPECT_EQ(r.stats.integrityReason.find("seam DC step"), std::string::npos)
        << "reason was: " << r.stats.integrityReason;

    // (b) THE DIAGNOSTIC DECLINED, and it did so ACROSS THE EXTENT.
    EXPECT_GT(r.stats.seamPhotoNonUniform, 0)
        << "the metric must record that it DECLINED, never silently find "
           "nothing";
    EXPECT_GT(r.stats.seamPhotoSpreadP95DN, 1.0)
        << "the bands must visibly DISAGREE on a row-shaded sweep — p95 spread "
           "was " << r.stats.seamPhotoSpreadP95DN << " DN";

    // THE PARTITION INVARIANT.  Every measured boundary lands in exactly one
    // of {DC-like, not-DC-like, unknown} — the same discipline the frame
    // ledger's outcome buckets follow, and the thing that makes "unknown" a
    // state rather than a rounding of one of the other two.
    EXPECT_EQ(r.stats.seamPhotoUniSamples + r.stats.seamPhotoNonUniform
                  + r.stats.seamPhotoUniformUnknown,
              r.stats.seamPhotoSamples);

    // And the per-row invariant the old test meant to assert: a boundary
    // reported as DC-like must actually have agreeing bands.
    // And the per-row invariant the old test meant to assert — CORRECTED, and
    // the correction is a tightening rather than a relaxation.
    //
    // `seamPhotoUniform` is the FRACTION of band pairs that agree, while
    // `seamPhotoSpreadDN` is a max-minus-min over the SAME bands.  With four
    // bands, uniform == 0.75 means one band dissents — which is precisely a
    // large spread.  So "uniform >= 0.60 implies spread <= 1 DN" was never
    // implied by the definitions; it held only because at work scale 0.5 this
    // fixture produced exactly ONE uniform-classified boundary and it happened
    // to pass.  Raising it to 0.75 produces three, two of them at uniform 0.75
    // with spreads of 2.8 and 3.0 DN — the arithmetic the old bound never met.
    //
    // The claim that IS implied: when EVERY band agrees, the bands agree.
    int nUnanimous = 0;
    for (const auto& row : r.rows) {
        if (!row.seamPhotoValid) continue;
        if (row.seamPhotoUniform < 0.999) continue;   // (b) covers the rest
        ++nUnanimous;
        EXPECT_LE(row.seamPhotoSpreadDN,
                  std::max(1.0, 0.5 * std::fabs(row.seamPhotoStepDN)) + 1e-9)
            << "a boundary whose bands ALL agree must have agreeing bands: "
               "spread=" << row.seamPhotoSpreadDN
            << " step=" << row.seamPhotoStepDN;
    }
    // …and a partially-uniform boundary is still allowed to be wide, which is
    // what makes the line above a real bound rather than a vacuous one.
    EXPECT_GT(r.stats.seamPhotoNonUniform + nUnanimous, 0);
}

TEST(PanoPhotometry, UniformityDiscriminatesADcStepFromRowShading) {
    // THE DISCRIMINATOR, stated as the difference between two sweeps rather
    // than as a threshold on one.  The uniformity statistic exists to answer
    // "is this step the SAME all the way along the boundary?", and the only
    // way to show it answers that is to feed it both cases.
    //
    // This is the test that the PER-PIXEL form of the statistic could not
    // pass.  Measured on the operator's four packs, that form flagged
    // 71-99.7% of boundaries non-uniform — at the operating point the spread
    // of a low-gradient difference field is dominated by the residual
    // sub-pixel resample, so it read ~"fail" on everything and separated
    // nothing.
    const cv::Mat shelf = makeShelf(6000, kFrameH);

    //  (1) A PURE DC EXPOSURE STEP: the same offset everywhere on the
    //      boundary.  Bands must agree.
    SweepSpec dc;
    dc.xs = linearSweep(200, 12.0, 200);
    dc.gains.assign(dc.xs.size(), 1.0);
    for (size_t i = dc.xs.size() / 2; i < dc.xs.size(); ++i) dc.gains[i] = 1.10;

    //  (2) ROW SHADING: a difference that varies ALONG the boundary.
    SweepSpec ragged;
    ragged.xs = linearSweep(200, 12.0, 200);
    ragged.rowShadingSpan = 1.60;

    auto cfg = testConfig();
    cfg.gainMatch = false;   // do not let the corrector erase case (1)
    const SweepResult a = runSweepSpec(shelf, dc, cfg);
    const SweepResult b = runSweepSpec(shelf, ragged, cfg);
    ASSERT_GT(a.stats.seamPhotoSamples, 20);
    ASSERT_GT(b.stats.seamPhotoSamples, 20);

    EXPECT_LT(a.stats.seamPhotoSpreadP95DN, b.stats.seamPhotoSpreadP95DN)
        << "a DC step must read MORE uniform along the boundary than row "
           "shading: dc=" << a.stats.seamPhotoSpreadP95DN
        << " ragged=" << b.stats.seamPhotoSpreadP95DN;
    const double dcNonUni = (double)a.stats.seamPhotoNonUniform
                          / (double)std::max<int64_t>(1, a.stats.seamPhotoSamples);
    const double ragNonUni = (double)b.stats.seamPhotoNonUniform
                          / (double)std::max<int64_t>(1, b.stats.seamPhotoSamples);
    EXPECT_LT(dcNonUni, ragNonUni)
        << "dc=" << dcNonUni << " ragged=" << ragNonUni;
}

TEST(PanoPhotometry, UnknownUniformityIsNotReportedAsUniform) {
    // "Fewer than two bands could measure" is NOT "the step was uniform", and
    // encoding it as 1.0 would have put a number on something nothing
    // measured.  Forcing more bands than the slab can support drives every
    // boundary into that state; it must show up as UNKNOWN, the percentiles
    // must still be computed, and nothing may be counted as DC-like.
    const cv::Mat shelf = makeThinFlatShelf(4200, kFrameH);
    auto cfg = testConfig();
    // Enough samples to MEASURE the step, over a row span so thin that no
    // band inside it can reach the per-band floor.  BOTH knobs are needed and
    // each is doing a different job: the fixture supplies the thin span, the
    // band count subdivides it below what any band can fill.
    cfg.photoMinSamples = 300;
    cfg.photoUniformBands = 32;

    SweepSpec spec;
    spec.xs = linearSweep(200, 14.0, 120);
    const SweepResult r = runSweepSpec(shelf, spec, cfg);
    ASSERT_GT(r.stats.painted, 20);
    ASSERT_GT(r.stats.seamPhotoSamples, 10)
        << "the step itself must still be measured — this is about uniformity "
           "being unknown, not about the seam being unmeasured";
    // THE STATE IS REACHABLE AND IT IS COUNTED APART.  Not every boundary
    // lands in it — the sample span varies along the sweep — and asserting
    // that it would be asserting the fixture, not the rule.
    EXPECT_GT(r.stats.seamPhotoUniformUnknown, 0)
        << "a boundary whose flat pixels span too few rows to band must be "
           "reachable, or this encoding is untested";
    EXPECT_EQ(r.stats.seamPhotoUniSamples + r.stats.seamPhotoNonUniform
                  + r.stats.seamPhotoUniformUnknown,
              r.stats.seamPhotoSamples);

    // THE RULE, per boundary: unknown is NEGATIVE (never 1.0, which would read
    // as "perfectly uniform"), it carries no spread, and it says how many
    // bands could actually measure.
    int64_t unknownRows = 0;
    for (const auto& row : r.rows) {
        if (!row.seamPhotoValid) continue;
        if (row.seamPhotoUniform >= 0.0) {
            EXPECT_GE(row.seamPhotoBands, 2)
                << "a uniformity FRACTION implies at least two bands agreed or "
                   "disagreed";
            continue;
        }
        ++unknownRows;
        EXPECT_LT(row.seamPhotoBands, 2);
        EXPECT_DOUBLE_EQ(row.seamPhotoSpreadDN, 0.0)
            << "nothing measured a spread, so none may be reported";
        // The step ITSELF is still measured — that is the whole point of
        // separating "the step is unknown" from "its uniformity is unknown".
        EXPECT_TRUE(std::isfinite(row.seamPhotoStepDN));
    }
    EXPECT_EQ(unknownRows, r.stats.seamPhotoUniformUnknown);
}

TEST(PanoPhotometry, TheUniformOnlyCrossCheckPartitionsTheSamePopulation) {
    // THE BRIEF ASKED FOR "uniform-across-width tested so real scene edges do
    // not trigger it".  The gate deliberately does NOT exclude non-uniform
    // boundaries — excluding them would condition the percentiles on the ones
    // that happened to look flat — so the requirement is met by REPORTING the
    // restricted percentile beside the gated one.  What must hold is that the
    // restricted population is a real subset of the same measurements, and
    // that it is populated at all on an ordinary sweep (a cross-check nobody
    // can read is not a cross-check).
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 12.0, 200);
    spec.gains.assign(spec.xs.size(), 1.0);
    for (size_t i = 0; i < spec.gains.size(); ++i) {
        spec.gains[i] = 1.0 + 0.0016 * (double)i;   // a slow camera drift
    }
    auto cfg = testConfig();
    cfg.gainMatch = false;
    const SweepResult r = runSweepSpec(shelf, spec, cfg);
    ASSERT_GT(r.stats.seamPhotoSamples, 20);
    EXPECT_GT(r.stats.seamPhotoUniSamples, 0)
        << "an ordinary drifting sweep must produce DC-like boundaries, or the "
           "cross-check is unreadable";
    EXPECT_LE(r.stats.seamPhotoUniSamples, r.stats.seamPhotoSamples);
    EXPECT_LE(r.stats.seamPhotoUniStepMaxDN, r.stats.seamPhotoStepMaxDN + 1e-9)
        << "a subset cannot exceed the population's maximum";
}

TEST(PanoPhotometry, AnUnmeasuredPhotometricSeamIsNotClean) {
    // NOT MEASURED is its own state.  The same discipline the v5 band metric
    // already applies, extended to the instrument v5 lacked.
    const cv::Mat shelf = makeShelf(4200, kFrameH);
    auto cfg = testConfig();
    cfg.seamMetrics = false;

    SweepSpec spec;
    spec.xs = linearSweep(200, 14.0, 120);
    const SweepResult r = runSweepSpec(shelf, spec, cfg);
    ASSERT_GT(r.stats.painted, 20);
    EXPECT_TRUE(r.stats.integrityFailed);
    EXPECT_NE(r.stats.integrityReason.find("photometric seam NOT MEASURED"),
              std::string::npos)
        << "reason was: " << r.stats.integrityReason;
}

TEST(PanoPhotometry, OutOfRangeExposureMetadataIsClampedAndCounted) {
    // Bad metadata is not an exposure change.  Clamp it, count it, and let the
    // pack say the metadata is not to be trusted — never scale a frame by
    // 1e6 because a device read returned nonsense.
    const cv::Mat shelf = makeShelf(4200, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 14.0, 120);
    const int n = (int)spec.xs.size();
    spec.expDur.assign((size_t)n, 1.0 / 60.0);
    spec.expISO.assign((size_t)n, 100.0);
    for (int i = 40; i < 60 && i < n; ++i) spec.expISO[(size_t)i] = 1.0e-4;

    auto cfg = testConfig();
    const SweepResult r = runSweepSpec(shelf, spec, cfg);
    EXPECT_GT(r.stats.exposureClampedFrames, 0);
    for (const auto& row : r.rows) {
        EXPECT_LE(row.expGain, cfg.exposureGainClamp + 1e-9);
        EXPECT_GE(row.expGain, 1.0 / cfg.exposureGainClamp - 1e-9);
    }
}

TEST(PanoPhotometry, TheTailFlushCarriesItsOwnFramesExposure) {
    // The tail flush is 29-48% of the deliverable on the operator's packs and
    // paints the LAST PAINTED frame's pixels — so it must carry THAT frame's
    // exposure, not whatever the chain happened to end on.
    const cv::Mat shelf = makeShelf(4200, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 14.0, 120);
    const int n = (int)spec.xs.size();
    spec.expDur.assign((size_t)n, 1.0 / 60.0);
    spec.expISO.resize((size_t)n);
    for (int i = 0; i < n; ++i)
        spec.expISO[(size_t)i] = 100.0 * std::pow(1.5, (double)i / (double)(n - 1));

    const SweepResult r = runSweepSpec(shelf, spec, testConfig());
    ASSERT_FALSE(r.rows.empty());
    const auto& tail = r.rows.back();
    ASSERT_EQ(tail.outcome, rnis::pano::Outcome::TailFlush);

    double lastPaintedExpGain = -1.0;
    for (const auto& row : r.rows) {
        if (row.outcome == rnis::pano::Outcome::Painted ||
            row.outcome == rnis::pano::Outcome::GapExtended ||
            row.outcome == rnis::pano::Outcome::GapBackfilled) {
            lastPaintedExpGain = row.expGain;
        }
    }
    ASSERT_GT(lastPaintedExpGain, 0.0);
    // Load-bearing: with the normalisation inert every expGain would be 1.0
    // and the equality below would hold for the wrong reason.
    ASSERT_LT(lastPaintedExpGain, 0.95)
        << "the ramp must actually have produced a non-unity exposure gain";
    EXPECT_NEAR(tail.expGain, lastPaintedExpGain, 1e-12)
        << "the lead-out must be normalised with its SOURCE frame's exposure";
}

// ── v8: THE SIGN OF THE COMMITTED-PIXEL JOG ────────────────────────────────
//
// WHY THIS SUITE EXISTS.  The operator's standing complaint is WOBBLE — a
// low-frequency random walk of the cross-sweep placement, measured offline on
// his four packs at rms 0.87-1.31 px over a 128-row lag with a structure
// function slope of 0.83-1.38 (1.0 = a random walk; the single-frame bootstrap
// block, which is the instrument's own floor, sits at 0.36-0.43).
//
// The engine ALREADY measures the per-boundary increment of exactly that walk:
// `seamCanvasJogPx` correlates each incoming strip's discarded slab against
// the canvas underneath it, in canvas pixels, from the warp that did the
// painting.  And then it took `std::fabs` and threw the sign away — so the
// pack recorded HOW BIG each misregistration was and not WHICH WAY, and a
// running sum of it grows monotonically whether the errors cancel or compound.
// The sign is the whole difference between "these two strips disagree" and
// "the panorama has drifted this far", and it was unrecoverable from the pack.
//
// SCOPE, MEASURED AND STATED SO NOBODY INHERITS AN OVERCLAIM.  The running sum
// is NOT the wobble number.  Validated against the slat-wall ruler on all four
// operator packs (twin arm v6, swept zone, cubic-detrended):
//
//   pack       ruler slope / rms@128      signed-jog cumulative slope / rms@128
//   15-57-16   0.98 / 1.177 px            0.59 / 1.006 px
//   15-58-22   0.83 / 1.175 px            0.83 / 4.816 px
//   15-59-29   1.38 / 1.307 px            1.20 / 3.009 px
//   16-00-28   0.87 / 0.873 px            0.92 / 2.679 px
//
// The SLOPE tracks (mean |Δ| 0.16, and both agree the process is a walk on
// 4/4).  The AMPLITUDE does not: the cumulative is 1-4× high and it RANKS the
// four packs differently from the ruler, because the jog carries its own
// correlation noise and the running sum integrates that noise as well as the
// defect.  So it is ledgered and reported as a DIAGNOSTIC and is deliberately
// NOT folded into `integrityFailed` — the mistake this codebase already made
// once with `crossBandDivergencePx`, which was documented as "THE WOBBLE
// NUMBER" and was then measured to be IDENTICAL across every arm of the pose-
// anchor A/B, i.e. blind to the very intervention it was supposed to score.

TEST(PanoJogSign, TheAbsoluteRollUpsAreUnchangedAndTheSignIsNoLongerDestroyed) {
    const cv::Mat shelf = makeShelf(9000, 3000);
    ProjSweepSpec s; s.n = 260; s.dx = 14.0; s.noiseDN = 6.0;
    const SweepResult r = runProjectedSweep(shelf, s, testConfig());
    ASSERT_GT(r.stats.seamCanvasJogSamples, 20);

    // 1. THE ABSOLUTE FIELD IS UNTOUCHED.  Every shipped bar, percentile and
    //    gate reads `seamCanvasJogPx`; this change must not move any of them.
    int negatives = 0, valid = 0;
    for (const auto& row : r.rows) {
        if (!row.seamCanvasJogValid) {
            EXPECT_EQ(row.seamCanvasJogSignedPx, 0.0)
                << "an unmeasured boundary must not carry a signed value";
            continue;
        }
        ++valid;
        EXPECT_NEAR(row.seamCanvasJogPx, std::fabs(row.seamCanvasJogSignedPx), 1e-12)
            << "seq " << row.seq;
        if (row.seamCanvasJogSignedPx < 0.0) ++negatives;
    }
    EXPECT_EQ(valid, (int)r.stats.seamCanvasJogSamples);
    // 2. THE INFORMATION IS REALLY THERE.  A field that happened to be
    //    non-negative everywhere would satisfy (1) while still telling the
    //    reader nothing the absolute value did not.
    EXPECT_GT(negatives, 0) << "no boundary drifted the other way — the sign "
                               "carries no information on this fixture";
    EXPECT_LT(negatives, valid) << "every boundary drifted the same way";

    // 3. THE SESSION STATISTIC IS THE RUNNING SUM'S RANGE, and it is an
    //    IDENTITY the engine cannot fake: recompute it from the rows.
    double acc = 0.0, lo = 0.0, hi = 0.0;
    int64_t n = 0;
    for (const auto& row : r.rows) {
        if (!row.seamCanvasJogValid) continue;
        acc += row.seamCanvasJogSignedPx;
        lo = std::min(lo, acc);
        hi = std::max(hi, acc);
        ++n;
    }
    EXPECT_EQ(r.stats.seamJogDriftSamples, n);
    EXPECT_NEAR(r.stats.seamJogDriftPx, hi - lo, 1e-9);
    EXPECT_NEAR(r.stats.seamJogDriftEndPx, acc, 1e-9);
    // 4. AND IT IS NOT GATED.  A diagnostic that fails the pack is a verdict.
    EXPECT_EQ(r.stats.integrityReason.find("jog drift"), std::string::npos)
        << r.stats.integrityReason;
}

// ── v8: HOW MANY BOUNDARIES BREACHED, NOT MERELY THAT ONE DID ──────────────
//
// The operator's report on the v6 banding work was "I am not sure I see the
// banding issue you are talking about", and the verdict he would have to
// settle that on says `seam DC step max > 3.00 DN` — a MAX clause, which one
// anomalous boundary out of six hundred fires exactly as loudly as a genuine
// end-to-end band does.  Those two are different findings and the pack could
// not tell them apart.  This is not a case for loosening the bar (a single
// 3 DN seam IS visible); it is a case for the pack SAYING WHICH IT IS.
TEST(PanoPhotometry, TheSeamStepVerdictSaysHowManyBoundariesBreached) {
    const cv::Mat shelf = makeShelf(7000, 3000);

    // A. A CLEAN SWEEP: nothing breaches, and the count says so.
    SweepSpec clean;
    for (int i = 0; i < 150; ++i) clean.xs.push_back(900.0 + 14.0 * (double)i);
    const SweepResult a = runSweepSpec(shelf, clean, testConfig());
    ASSERT_GT(a.stats.seamPhotoSamples, 20);
    EXPECT_EQ(a.stats.seamPhotoStepOverBar, 0);

    // B. ONE FRAME LIT DIFFERENTLY.  The count must be the number of
    //    boundaries actually over the bar — recomputed from the rows, so the
    //    engine cannot report a number its own ledger does not support.
    SweepSpec step = clean;
    step.gains.assign(clean.xs.size(), 1.0);
    for (size_t i = 70; i < clean.xs.size(); ++i) step.gains[i] = 1.35;
    const SweepResult b = runSweepSpec(shelf, step, testConfig());
    ASSERT_GT(b.stats.seamPhotoSamples, 20);

    int64_t over = 0;
    for (const auto& row : b.rows) {
        if (row.seamPhotoValid && std::fabs(row.seamPhotoStepDN) > 3.00) ++over;
    }
    EXPECT_EQ(b.stats.seamPhotoStepOverBar, over);
    ASSERT_GT(over, 0) << "the fixture no longer produces a breaching boundary; "
                          "photoSummary: " << photoSummary(b.stats);
    // The verdict has to CARRY the count, otherwise the pack reader is back to
    // guessing whether one boundary or four hundred fired it.
    ASSERT_TRUE(b.stats.integrityFailed) << photoSummary(b.stats);
    EXPECT_NE(b.stats.integrityReason.find("seam DC step max"), std::string::npos)
        << b.stats.integrityReason;
    EXPECT_NE(b.stats.integrityReason.find("of " +
                  std::to_string((long long)b.stats.seamPhotoSamples)),
              std::string::npos)
        << "the max clause does not state its support: "
        << b.stats.integrityReason;
}

// ── v8: MULTI-WINDOW CHAIN AVERAGING (Config::crossAvgWindows) ─────────────
//
// SHIPPED OFF.  These tests pin the two properties that make it safe to ship
// off and cheap to turn on: the flag is a pure PLACEMENT switch (it never
// changes which strips are committed or how far they are warped), and with one
// window it is the identity, so a K=1 session cannot be moved by it at all.
//
// The evidence lives in Config::crossAvgWindows's own comment and it is MIXED,
// not the free win the first cut of that comment claimed: 22-35% better on the
// band residual it fits, 2-of-4 packs WORSE on the committed-pixel jog it does
// not.  A synthetic sweep is not where that gets re-litigated — but the
// annotation that keeps the two apart IS pinned here, three tests down.

TEST(PanoCrossAvg, WithOneWindowTheAverageIsTheCentreWindowExactly) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    ProjSweepSpec s; s.n = 120; s.dx = 14.0; s.noiseDN = 5.0;

    auto cfg = testConfig();
    cfg.crossWindows = 1;
    cfg.crossAvgWindows = false;
    // NO DISCARD.  The first sweep in a process used to differ from every
    // later one; that was the fixture's uninitialised noise buffer, not the
    // engine, and it is fixed at source in runProjectedSweep.  See
    // PanoDeterminism.EveryRunInAProcessIsBitIdenticalIncludingTheFirst, which
    // now holds the first sweep to the same bar as the rest.
    const SweepResult off = runProjectedSweep(shelf, s, cfg);
    cfg.crossAvgWindows = true;
    const SweepResult on = runProjectedSweep(shelf, s, cfg);

    ASSERT_GT(off.stats.painted, 20);
    ASSERT_EQ(off.rows.size(), on.rows.size());
    for (size_t i = 0; i < off.rows.size(); ++i) {
        EXPECT_EQ(off.rows[i].outcome, on.rows[i].outcome) << "row " << i;
        EXPECT_EQ(off.rows[i].posU, on.rows[i].posU) << "row " << i;
        EXPECT_EQ(off.rows[i].posV, on.rows[i].posV) << "row " << i;
        EXPECT_EQ(on.rows[i].crossAvgDeltaPx, 0.0) << "row " << i;
    }
    EXPECT_EQ(off.stats.paintedW, on.stats.paintedW);
    ASSERT_FALSE(off.canvas.empty());
    ASSERT_EQ(off.canvas.size(), on.canvas.size());
    EXPECT_EQ(cv::norm(off.canvas, on.canvas, cv::NORM_INF), 0.0)
        << "K=1 averaging moved a pixel";
}

TEST(PanoCrossAvg, ItMovesThePlacementAndNothingElse) {
    const cv::Mat shelf = makeShelf(8000, 2600);
    ProjSweepSpec s; s.n = 180; s.dx = 14.0; s.noiseDN = 7.0;

    auto cfg = testConfig();          // crossWindows 3, the shipped default
    const SweepResult off = runProjectedSweep(shelf, s, cfg);
    ASSERT_FALSE(cfg.crossAvgWindows) << "the flag must ship OFF";
    // OFF must leave no trace at all — a pack states which chain it ran by
    // this column being identically zero.
    for (const auto& row : off.rows) EXPECT_EQ(row.crossAvgDeltaPx, 0.0);

    cfg.crossAvgWindows = true;
    const SweepResult on = runProjectedSweep(shelf, s, cfg);

    // THE COST CLAIM, which is what makes this safe to leave in the binary:
    // it changes WHERE a strip goes, never WHICH strips go or how far they
    // are warped.
    EXPECT_EQ(off.stats.painted, on.stats.painted);
    EXPECT_EQ(off.holes.size(), on.holes.size());
    EXPECT_NEAR(off.stats.maxAreaScalePainted, on.stats.maxAreaScalePainted, 1e-9);
    EXPECT_EQ(off.stats.axis, on.stats.axis);
    EXPECT_EQ(off.stats.sweepSign, on.stats.sweepSign);

    // ...and it really does something, or the flag is decoration.
    int moved = 0;
    for (size_t i = 0; i < std::min(off.rows.size(), on.rows.size()); ++i) {
        if (on.rows[i].crossAvgDeltaPx != 0.0) ++moved;
    }
    EXPECT_GT(moved, 10) << "the outer windows never contributed a measurement";
}

// THE CLAUSE THAT KEEPS THE 22-35% OUT OF THE VERDICT.
//
// `seamWorstBand*` is the residual of the K band measurements.  With
// `crossAvgWindows` OFF the chain is driven by ONE of those K (the centre
// window) and scored on all K, so K−1 of the residuals are independent of the
// placement.  With it ON the chain is the weighted least-squares centre of the
// very same K, so the residual it is scored on is ITS OWN FIT.  It must fall,
// and it does — 22-35% on all four operator packs.
//
// The INDEPENDENT instrument disagrees.  `seamCanvasJogPx` correlates the slab
// of canvas the incoming warp covers and the high-water clip discards —
// committed pixels through the painting matrix, never the band fit.  Measured
// in the offline twin, K=3 against the shipped chain, jog p95 in canvas px:
//
//     15-57-16   0.307 → 1.026   (3.34× WORSE)
//     15-58-22   0.874 → 0.856   (flat; max 1.101 → 1.259, worse)
//     15-59-29   0.641 → 0.318   (2.0× better)
//     16-00-28   0.568 → 0.759   (1.34× worse)
//
// Two worse, one flat, one better — against 4-of-4 on the self-scored one.
// The header comment on Config::crossAvgWindows used to quote only the 4-of-4,
// which is exactly the blind verdict this engine's own history is made of, so
// the ENGINE now says it in the verdict rather than leaving it to a comment
// nobody re-reads.
TEST(PanoCrossAvg, TheBandResidualStopsBeingEvidenceWhenTheChainIsFittedToIt) {
    const cv::Mat shelf = makeShelf(8000, 2600);
    ProjSweepSpec s; s.n = 180; s.dx = 14.0; s.noiseDN = 7.0;

    auto cfg = testConfig();
    const SweepResult off = runProjectedSweep(shelf, s, cfg);
    ASSERT_FALSE(cfg.crossAvgWindows);
    ASSERT_GT(off.stats.painted, 20);
    EXPECT_FALSE(off.stats.seamBandSelfScored)
        << "the shipped chain is scored on measurements it did not fit";
    EXPECT_EQ(off.stats.integrityReason.find("own fit"), std::string::npos)
        << off.stats.integrityReason;

    cfg.crossAvgWindows = true;
    const SweepResult on = runProjectedSweep(shelf, s, cfg);
    EXPECT_TRUE(on.stats.seamBandSelfScored)
        << "a chain fitted to the K bands is scored on its own residual and "
           "the stats do not say so";
    // ...and the VERDICT says it, in words, on a pack that would otherwise
    // read as a cleaner sweep.  Not a failure clause — the placement may well
    // be better — a clause that stops the number being quoted as proof of it.
    EXPECT_NE(on.stats.integrityReason.find("own fit"), std::string::npos)
        << "the verdict is silent about a self-scored band metric: "
        << on.stats.integrityReason;
    // ...AND IT IS NOT A FAILURE CLAUSE, which is what v8 shipped it as.
    //
    // The sentence went into `why`, and `integrityFailed = !why.empty()` turns
    // anything in `why` into a verdict — so every pack captured with the knob
    // on read FAILED regardless of its pixels, pinning one arm of the A/B the
    // knob was exposed for and flipping the live HUD to CUTS on the arm with
    // the LOWEST band number.  The note is appended AFTER the verdict now and
    // marked, so this can be checked mechanically rather than by reading four
    // comments that all claimed it already.
    const std::string& reason = on.stats.integrityReason;
    const size_t notePos = reason.find("NOTE ");
    ASSERT_NE(notePos, std::string::npos)
        << "the annotation is not marked as a note: " << reason;
    const std::string clauses = reason.substr(0, notePos);
    EXPECT_EQ(on.stats.integrityFailed, !clauses.empty())
        << "the self-scored NOTE is being counted as a failure clause: "
        << reason;
    // The independent instrument must still be MEASURED in both arms — the
    // annotation is worthless if the arm it annotates has nothing to fall back
    // on.
    EXPECT_GT(on.stats.seamCanvasJogSamples, 0);
    EXPECT_GT(off.stats.seamCanvasJogSamples, 0);
}

// ── DETERMINISM ────────────────────────────────────────────────────────────
//
// Every A/B in this project — the projection arms, the gain leak, the pose
// anchor, the multi-window average — is read as "arm A differs from arm B by
// the knob".  That reading is only valid if running the SAME arm twice gives
// the same answer.  This test pins that, with no discards and no tolerances:
// the FIRST sweep in a fresh process is bit-identical to every later one.
//
// ⚠ 2026-08-23 — THE ENGINE WAS NEVER THE NONDETERMINISTIC PART.  THE FIXTURE
// WAS.  Read this before adding another discard anywhere in this suite.
//
// This test used to be called DiscardOneSweepAndEveryRunAfterItIsBitIdentical
// and it threw away its first sweep, because a first sweep measurably differed
// from every later one (|dpos| up to 0.203 px, response gap up to 0.108, and
// the gap itself a function of what ran before).  Three explanations were
// proposed and each was WITHDRAWN after measurement: an OpenCV thread split
// (setNumThreads(1) reproduces the divergence to the last digit —
// 0.203028723559 either way), uninitialised engine state (MallocScribble /
// MallocPreScribble / MallocNanoZone=0 leave it bit-for-bit identical), and
// strict aliasing.  The mechanism was recorded as "unknown, probably SIMD
// alignment inside OpenCV" and the discard was made a suite-wide RULE.
//
// It was none of those.  Bisecting the divergence with FNV hashes of the
// engine's own inputs put it UPSTREAM of the engine entirely — the frames
// handed to ingest() differed between two sweeps of the same spec in one
// process (re-measured 2026-08-23: first differing frame index 9, and the
// sweep's first differing output row is 9 too), while renderProjectedFrame()
// alone was bit-stable and the shelf was never mutated.  ⚠ Watch the
// instrument here: a first pass at this hashed the wrong sweep helper, got an
// empty hash vector, and read the resulting vacuous "inputs identical" as
// evidence that the ENGINE was impure.  It is not — see
// PanoDeterminism.TheEngineIsAPureFunctionOfItsInputs.  The one remaining
// stage is this, which runProjectedSweep applied inline and which now lives in
// applySyntheticNoise():
//
//     cv::Mat noise(crop.size(), CV_16SC3);          // uninitialised
//     rng.fill(noise, cv::RNG::NORMAL, 0.0, s.noiseDN);
//
// RNG::fill takes its distribution parameters as InputArray.  A bare `double`
// is a 1x1 array; the destination has THREE channels, and OpenCV then reads
// per-channel mean/stddev slots it was never given.  Measured on host OpenCV
// 5.0.0, CV_16SC3, fixed seed, one process:
//
//     rng.fill(m, NORMAL, Scalar::all(0.0),
//                         Scalar::all(5.0))    -> range [-25..25], and
//                                              bit-identical across heap states
//                                              and across a pre-filled sentinel
//
// So the fixture's "deterministic per-frame noise" was reading memory the
// program never wrote.  Resist the urge to give that a tidier mechanism than
// the evidence supports: the bare-double form is arity-mismatched UB and it
// behaves differently in different heap states of the SAME binary — all-zero
// for one frame, -32768 for the next, all-zero in every standalone probe, and
// (decisively) an added 9 MB allocate/free next to the call is enough to turn
// a failing build into a passing one.  Either way the frames stop being a
// function of the spec, which is all the divergence needed.
//
// With the parameters passed as cv::Scalar::all the discard is gone, from here
// and from the four other tests that carried one, and this asserts the strong
// property directly.  It also closed
// PanoGate.TheDivergenceBarIsNormalisedNotAbsolute at -O2/-Os without touching
// a single threshold: that test's short arm was reading
// stepMax 54.6 DN / driftTotal 422% / appliedBand 11.1% against a long arm at
// 0.94 DN / 1.6% / 0.56% off the SAME fixture — the cold arm was being fed the
// garbage and the warm arm nothing.  After the fix the arms are
// 0.42 DN / 0.96% / 0.33% and 0.58 DN / 2.35% / 0.40%.  The gate was right.
//
// SCOPE: a HOST-BUILD observation, now verified at -O0, -O2 and -Os (the level
// the Release pod ships at).  The device links a different OpenCV (vendored
// 4.10, arm64, no IPP); this says the ENGINE is order-independent on the host,
// not that the device build is, which is why the offline twin is still GRADED
// against a shipped device ledger rather than assumed to reproduce it.
TEST(PanoDeterminism, EveryRunInAProcessIsBitIdenticalIncludingTheFirst) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    ProjSweepSpec s; s.n = 120; s.dx = 14.0; s.noiseDN = 5.0;
    const auto cfg = testConfig();

    // NO DISCARD.  `z` is the process's first sweep and is held to the same
    // bar as the rest — that is the point of the test.
    const SweepResult z = runProjectedSweep(shelf, s, cfg);
    const SweepResult a = runProjectedSweep(shelf, s, cfg);
    const SweepResult b = runProjectedSweep(shelf, s, cfg);
    const SweepResult c = runProjectedSweep(shelf, s, cfg);
    ASSERT_GT(a.stats.painted, 20);
    ASSERT_EQ(z.rows.size(), a.rows.size());
    ASSERT_EQ(a.rows.size(), b.rows.size());
    ASSERT_EQ(b.rows.size(), c.rows.size());

    // THE FIXTURE ACTUALLY CARRIES NOISE NOW, and the test that measures a
    // noisy sweep should say so rather than trust the spec field: a fixture
    // silently degraded to noiseless is exactly the failure this test exists
    // to have caught once already.
    ASSERT_GT(a.stats.seamBoundaries, 20);

    const SweepResult* runs[4] = {&z, &a, &b, &c};
    for (int r = 1; r < 4; ++r) {
        const SweepResult& x = *runs[0];
        const SweepResult& y = *runs[r];
        SCOPED_TRACE("run 0 vs run " + std::to_string(r));
        for (size_t i = 0; i < x.rows.size(); ++i) {
            EXPECT_EQ(x.rows[i].outcome, y.rows[i].outcome) << "row " << i;
            EXPECT_EQ(x.rows[i].posU, y.rows[i].posU) << "row " << i;
            EXPECT_EQ(x.rows[i].posV, y.rows[i].posV) << "row " << i;
            EXPECT_EQ(x.rows[i].response, y.rows[i].response) << "row " << i;
            EXPECT_EQ(x.rows[i].advanceX, y.rows[i].advanceX) << "row " << i;
            EXPECT_EQ(x.rows[i].advanceY, y.rows[i].advanceY) << "row " << i;
        }
        EXPECT_EQ(x.stats.painted, y.stats.painted);
        EXPECT_EQ(x.stats.paintedW, y.stats.paintedW);
        EXPECT_EQ(x.stats.integrityReason, y.stats.integrityReason);
        ASSERT_FALSE(x.canvas.empty());
        ASSERT_EQ(x.canvas.size(), y.canvas.size());
        EXPECT_EQ(cv::norm(x.canvas, y.canvas, cv::NORM_INF), 0.0);
    }
}

// THE QUESTION THE LAST TWO INVESTIGATIONS KEPT GETTING WRONG, ASKED DIRECTLY.
//
// Every other determinism test in this suite runs the whole fixture — render,
// noise, colour-convert, resize, ingest — and so a failure indicts the engine
// and the fixture together.  Twice now that ambiguity has cost a full run: the
// fixture was the guilty party both times, and both times the engine was the
// first suspect (an OpenCV thread split, then uninitialised engine state, then
// strict aliasing — each proposed, each withdrawn after measurement).
//
// This test removes the ambiguity by construction.  The frames are rendered
// ONCE, into buffers that are then never rewritten, and four freshly
// configured engines are driven over THE SAME cv::Mat objects.  Nothing
// upstream of ingest() can differ, because there is no upstream left inside
// the loop.  If this passes and a full-fixture determinism test fails, the
// defect is in the fixture — go and look at what feeds ingest(), not at the
// engine.
//
// Measured 2026-08-23: this passes even on a build with the broken
// bare-double RNG::fill still in place — i.e. it stayed green through exactly
// the failure that made EveryRunInAProcessIsBitIdenticalIncludingTheFirst red.
// That is the discrimination it exists to provide.
TEST(PanoDeterminism, TheEngineIsAPureFunctionOfItsInputs) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    ProjSweepSpec s; s.n = 120; s.dx = 14.0; s.noiseDN = 5.0;
    const auto cfg = testConfig();
    const double x0ref = 1400.0, y0ref = 1400.0;

    // Render every frame ONCE.  These buffers are the fixed point of the test.
    std::vector<cv::Mat> crops, grays;
    crops.reserve(s.n); grays.reserve(s.n);
    for (int i = 0; i < s.n; ++i) {
        cv::Mat crop = renderProjectedFrame(shelf, x0ref + s.dx * (double)i,
                                            y0ref + s.dy * (double)i, identityQuat());
        applySyntheticNoise(crop, s.noiseDN, i);
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        crops.push_back(crop);
        grays.push_back(grayWork);
    }

    // Fingerprint the inputs BEFORE any engine touches them.
    std::vector<uint64_t> cropH, grayH;
    for (int i = 0; i < s.n; ++i) {
        cropH.push_back(fnv1aPixels(crops[i]));
        grayH.push_back(fnv1aPixels(grays[i]));
    }

    struct Run { std::vector<rnis::pano::FrameOutcome> rows; cv::Mat canvas; };
    std::vector<Run> runs(4);
    for (int r = 0; r < 4; ++r) {
        rnis::pano::Engine eng;
        std::string err;
        ASSERT_TRUE(eng.configure(cfg, &err)) << err;
        for (int i = 0; i < s.n; ++i) {
            rnis::pano::FrameInput in;
            in.bgr = &crops[i];
            in.grayWork = &grays[i];
            in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
            in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
            in.imageWidth = kFrameW; in.imageHeight = kFrameH;
            const Quat q = identityQuat();
            for (int k = 0; k < 4; ++k) in.q[k] = q[k];
            in.t[0] = (x0ref + s.dx * (double)i) * (0.6 / kFx);
            in.t[1] = (y0ref + s.dy * (double)i) * (0.6 / kFy);
            in.tracking = 2;
            in.seq = (int64_t)i;
            runs[r].rows.push_back(eng.ingest(in));
        }
        runs[r].rows.push_back(eng.finish());
        eng.finalCanvas(runs[r].canvas);
    }

    // The frames must not have been mutated under us — otherwise "same inputs"
    // is an assumption rather than a fact, and this test proves nothing.  This
    // is asserted on the PIXELS, not on non-emptiness: ingest() takes the Mats
    // by pointer, so an engine that wrote through one would otherwise make this
    // test vacuously green while the property it names was false.
    for (int i = 0; i < s.n; ++i) {
        ASSERT_EQ(cropH[i], fnv1aPixels(crops[i]))
            << "the engine mutated input frame " << i;
        ASSERT_EQ(grayH[i], fnv1aPixels(grays[i]))
            << "the engine mutated input grayWork " << i;
    }

    for (int r = 1; r < 4; ++r) {
        SCOPED_TRACE("engine 0 vs engine " + std::to_string(r));
        ASSERT_EQ(runs[0].rows.size(), runs[r].rows.size());
        for (size_t i = 0; i < runs[0].rows.size(); ++i) {
            EXPECT_EQ(runs[0].rows[i].outcome,  runs[r].rows[i].outcome)  << "row " << i;
            EXPECT_EQ(runs[0].rows[i].posU,     runs[r].rows[i].posU)     << "row " << i;
            EXPECT_EQ(runs[0].rows[i].posV,     runs[r].rows[i].posV)     << "row " << i;
            EXPECT_EQ(runs[0].rows[i].response, runs[r].rows[i].response) << "row " << i;
        }
        ASSERT_FALSE(runs[0].canvas.empty());
        ASSERT_EQ(runs[0].canvas.size(), runs[r].canvas.size());
        EXPECT_EQ(cv::norm(runs[0].canvas, runs[r].canvas, cv::NORM_INF), 0.0);
    }
}

// THE FIXTURE'S OWN GUARD.  The bug above was invisible for as long as it was
// because nothing ever asserted that the synthetic noise existed — the spec
// field said noiseDN and everyone read the field.  Assert the DATA.
TEST(PanoDeterminism, TheSyntheticNoiseIsRealAndRepeatable) {
    const cv::Mat shelf = makeShelf(3000, 2400);
    const cv::Mat clean = renderProjectedFrame(shelf, 900.0, 700.0, identityQuat());
    ASSERT_FALSE(clean.empty());

    // 1. THE NOISE EXISTS, AND IS OF THE ORDERED MAGNITUDE.  The bug this
    //    guards produced either nothing at all or saturation, so both ends are
    //    bounded — a one-sided "it changed something" check would have passed
    //    on the garbage.
    cv::Mat noisy = clean.clone();
    applySyntheticNoise(noisy, 9.0, 3);
    cv::Mat d;
    cv::absdiff(clean, noisy, d);
    const double meanDiff = cv::mean(d)[0];
    EXPECT_GT(meanDiff, 2.0)
        << "noiseDN=9 moved the frame by " << meanDiff
        << " DN — the fixture's noise is not reaching the pixels";
    EXPECT_LT(meanDiff, 25.0)
        << "noiseDN=9 moved the frame by " << meanDiff
        << " DN — the fixture is injecting saturating garbage, not N(0,9)";

    // 2. IT IS A PURE FUNCTION OF THE SEED — independent of what was in the
    //    destination buffer beforehand.  This is the exact property the
    //    bare-double form of RNG::fill did not have, and the reason the same
    //    sweep gave different answers depending on where in the process it ran.
    cv::Mat s1 = clean.clone(), s2 = clean.clone();
    applySyntheticNoise(s1, 9.0, 3);
    {
        // dirty the heap the way a preceding sweep would, then repeat
        cv::Mat churn(2600, 6000, CV_16SC3, cv::Scalar::all(-31000));
        (void)cv::sum(churn);
    }
    applySyntheticNoise(s2, 9.0, 3);
    EXPECT_EQ(cv::norm(s1, s2, cv::NORM_INF), 0.0)
        << "the synthetic noise depends on heap history";

    // 3. AND ZERO MEANS ZERO — the flag is honoured, not merely present.
    cv::Mat off = clean.clone();
    applySyntheticNoise(off, 0.0, 3);
    EXPECT_EQ(cv::norm(clean, off, cv::NORM_INF), 0.0);

    // 4. The raw generator, at the level the bug lived at: same seed, two
    //    different pre-filled buffers, one answer.
    cv::Mat n1(64, 48, CV_16SC3, cv::Scalar::all(1234));
    cv::Mat n2(64, 48, CV_16SC3, cv::Scalar::all(-4321));
    for (cv::Mat* m : {&n1, &n2}) {
        cv::RNG rng(0x5eed1234u);
        rng.fill(*m, cv::RNG::NORMAL, cv::Scalar::all(0.0), cv::Scalar::all(9.0));
    }
    EXPECT_EQ(cv::norm(n1, n2, cv::NORM_INF), 0.0)
        << "RNG::fill's output depends on what was in the buffer beforehand";
    double mn = 0, mx = 0;
    cv::minMaxLoc(n1.reshape(1), &mn, &mx);
    EXPECT_GT(mx,  5.0) << "noise amplitude collapsed: max " << mx;
    EXPECT_LT(mx, 90.0) << "noise amplitude is not N(0,9): max " << mx;
    EXPECT_LT(mn, -5.0) << "noise amplitude collapsed: min " << mn;
    EXPECT_GT(mn, -90.0) << "noise amplitude is not N(0,9): min " << mn;
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRATION PRECISION (2026-08-24).  The wobble is the integral of the per-step
// displacement estimator's noise, so these pin the estimator itself rather
// than only its effect on a whole sweep.
//
// The measurement behind them is in the offline harness results,
// 2026-08-24-panoplus-noise/: triangle closure on the four operator packs
// (N ≈ 480 per pack), which is exactly zero for a rigid planar scene however
// the camera moved, so what fails to close bounds the estimator's error.
// ═══════════════════════════════════════════════════════════════════════════

namespace {

/// A textured window pair related by an EXACT sub-pixel translation.
///
/// The content is the suite's own synthetic shelf, not white noise: the
/// estimator under test resolves a peak, and on a broadband random field the
/// whitened correlation surface has near-degenerate competing lobes, so two
/// numerically different but equally valid implementations legitimately pick
/// different integer peaks and the comparison measures the fixture rather than
/// the estimator.  A photograph has structure; so does this.
///
/// The shift is a band-limited Fourier shift of a raster 3x larger than the
/// crop, so the window sees new content entering at its edges the way a real
/// one does — which is what the Hann window exists to handle.
void makeShiftedPair(int w, int h, double dx, double dy, cv::Mat* a,
                     cv::Mat* b) {
    const int W = w * 3, H = h * 3;
    cv::Mat shelf = makeShelf(W, H);
    cv::Mat g;
    cv::cvtColor(shelf, g, cv::COLOR_BGR2GRAY);
    cv::Mat big;
    g.convertTo(big, CV_32F);
    cv::GaussianBlur(big, big, cv::Size(0, 0), 1.1);   // a lens, roughly
    cv::Mat F;
    cv::dft(big, F, cv::DFT_COMPLEX_OUTPUT);
    for (int y = 0; y < H; ++y) {
        cv::Vec2f* row = F.ptr<cv::Vec2f>(y);
        const double fy = (y <= H / 2) ? (double)y / H : (double)(y - H) / H;
        for (int x = 0; x < W; ++x) {
            const double fx = (x <= W / 2) ? (double)x / W : (double)(x - W) / W;
            const double ph = -2.0 * CV_PI * (fx * dx + fy * dy);
            const double c = std::cos(ph), s = std::sin(ph);
            const float re = row[x][0], im = row[x][1];
            row[x][0] = (float)(re * c - im * s);
            row[x][1] = (float)(re * s + im * c);
        }
    }
    cv::Mat shifted;
    cv::idft(F, shifted, cv::DFT_REAL_OUTPUT | cv::DFT_SCALE);
    const cv::Rect roi((W - w) / 2, (H - h) / 2, w, h);
    *a = big(roi).clone();
    *b = shifted(roi).clone();
}

}  // namespace

TEST(PanoCorr, TheSupportIsDerivedFromTheWorkScaleAndIsTenSourcePxWide) {
    // The rule, stated as arithmetic: a support of `box` WORK px spans
    // box / workScale SOURCE px, and that is what is held constant.
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(0.50), 5)
        << "at the OLD work scale the derived support must be exactly the 5x5 "
           "cv::phaseCorrelate hard-wires — otherwise raising the work scale "
           "silently changes two things at once";
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(0.625), 7);
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(0.75), 7);
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(0.875), 9);
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(1.00), 9);
    // Over the OPERATING range (>= 0.5; below it the odd-integer support and
    // the [3, 15] clamp cannot hold 10 source px and the clamp is what wins).
    for (double ws : {0.5, 0.625, 0.75, 0.875, 1.0}) {
        const int b = rnis::pano::detail::centroidBoxFor(ws);
        EXPECT_EQ(b & 1, 1) << "support must be odd (it is centred on a pixel)";
        EXPECT_NEAR((double)b / ws, 10.0, 1.25)   // the odd-integer grid’s own limit
            << "support at ws " << ws << " spans " << (double)b / ws
            << " source px, not ~10";
    }
    for (double ws : {0.05, 0.25, 0.375, 2.0, 4.0}) {
        const int b = rnis::pano::detail::centroidBoxFor(ws);
        EXPECT_GE(b, 3);
        EXPECT_LE(b, 15);
        EXPECT_EQ(b & 1, 1);
    }
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(0.05), 3) << "clamped low";
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(4.0), 15) << "clamped high";
}

TEST(PanoCorr, BoxFiveIsCvPhaseCorrelateAndTheResponseNeverMovesWithTheBox) {
    cv::Mat hann;
    cv::createHanningWindow(hann, cv::Size(192, 144), CV_32F);

    // 1. SAME ESTIMATOR — but NOT the same bits, and that is stated rather
    //    than hidden.  cv::phaseCorrelate computes the whitened cross-power
    //    spectrum through the packed real-DFT (CCS) path; this one uses the
    //    complex path.  Both are float32, and the two formulations disagree at
    //    the 1e-2 px level, which is ~5% of the estimator's own per-step noise
    //    (0.13 work px measured on the packs).  Which is exactly why the
    //    ENGINE calls cv::phaseCorrelate itself whenever the support is 5 —
    //    see PanoCorr.TheDefaultPathIsLiterallyCvPhaseCorrelate.  This
    //    generalised form is only reached off the shipped work scale.
    double worstShift = 0.0, worstResp = 0.0, seCv = 0.0, seUs = 0.0;
    int n = 0;
    for (int k = 0; k < 40; ++k) {
        const double dx = -5.0 + 0.2531 * k, dy = 3.1 - 0.1719 * k;
        cv::Mat a, b;
        makeShiftedPair(192, 144, dx, dy, &a, &b);
        cv::Mat ca = a.clone(), cb = b.clone();   // phaseCorrelate mutates both
        double rCv = 0.0;
        const cv::Point2d ref = cv::phaseCorrelate(ca, cb, hann, &rCv);
        double xy[2] = {0, 0}, rUs = 0.0;
        rnis::pano::detail::phaseShiftBoxXY(a, b, hann, 5, xy, &rUs);
        const double dxy = std::max(std::fabs(xy[0] - ref.x),
                                    std::fabs(xy[1] - ref.y));
        worstShift = std::max(worstShift, dxy);
        worstResp = std::max(worstResp,
                             std::fabs(rUs - rCv) / std::max(1e-9, std::fabs(rCv)));
        seCv += (ref.x - dx) * (ref.x - dx) + (ref.y - dy) * (ref.y - dy);
        seUs += (xy[0] - dx) * (xy[0] - dx) + (xy[1] - dy) * (xy[1] - dy);
        n += 2;
    }
    EXPECT_LT(worstShift, 0.05)
        << "box 5 is supposed to BE the shipped estimator; it disagreed by "
        << worstShift << " px";
    EXPECT_LT(worstResp, 0.05)
        << "the response scale drifted by " << (100.0 * worstResp)
        << "% — minPhaseResponse and stallResumeResponse are calibrated "
           "against cv::phaseCorrelate's number";

    // 2. AND IT IS NOT WORSE AGAINST GROUND TRUTH.  "Different bits" is only
    //    acceptable if the difference is not a regression, so the same pairs
    //    are scored against the shift that made them.
    const double rmsCv = std::sqrt(seCv / n), rmsUs = std::sqrt(seUs / n);
    EXPECT_LT(rmsUs, 1.10 * rmsCv)
        << "our box-5 estimator is worse than cv::phaseCorrelate against "
           "ground truth: " << rmsUs << " vs " << rmsCv << " work px";

    // 3. NEITHER OPERAND IS MODIFIED.  cv::phaseCorrelate multiplies BOTH by
    //    the window in place, and storing that mutated buffer as the reference
    //    is the v3 Hann-squared defect.
    cv::Mat a0, b0, a1, b1;
    makeShiftedPair(192, 144, 2.37, -1.62, &a0, &b0);
    makeShiftedPair(192, 144, 2.37, -1.62, &a1, &b1);
    double xy0[2] = {0, 0}, r0 = 0.0;
    rnis::pano::detail::phaseShiftBoxXY(a0, b0, hann, 5, xy0, &r0);
    EXPECT_EQ(cv::norm(a0, a1, cv::NORM_INF), 0.0) << "operand a was mutated";
    EXPECT_EQ(cv::norm(b0, b1, cv::NORM_INF), 0.0) << "operand b was mutated";

    // 4. THE RESPONSE IS THE CAGE'S GATE SIGNAL, not an estimate: it must stay on
    //    the 5x5 support whatever the estimator's support is, or a precision
    //    change silently moves both gates.
    for (int box : {3, 7, 9, 13}) {
        double xyb[2] = {0, 0}, respB = 0.0;
        rnis::pano::detail::phaseShiftBoxXY(a0, b0, hann, box, xyb, &respB);
        EXPECT_NEAR(respB, r0, 1e-9) << "box " << box << " moved the response gate";
        if (box != 5) {
            EXPECT_NE(xyb[0], xy0[0])
                << "box " << box << " changed nothing — the support is not wired in";
        }
    }
}

TEST(PanoCorr, HalfResolutionCostsSubPixelPrecisionInSourcePx) {
    // The lever, in isolation: the SAME estimator, the same source content and
    // the same ground-truth shift, correlated at two work scales.  The error
    // is reported in SOURCE px — which is the unit the chain integrates and
    // the unit the wobble is measured in.
    struct Arm { double ws; int win; };
    const Arm arms[] = {{0.5, 192}, {0.75, 288}};
    double err[2] = {0, 0};
    for (int ai = 0; ai < 2; ++ai) {
        const Arm& A = arms[ai];
        cv::Mat hann;
        cv::createHanningWindow(hann, cv::Size(A.win, (A.win * 3) / 4), CV_32F);
        const int box = rnis::pano::detail::centroidBoxFor(A.ws);
        double se = 0.0;
        int n = 0;
        for (int k = 0; k < 12; ++k) {
            // ground truth in SOURCE px, converted to the arm's work px
            const double dxSrc = -6.0 + 1.0 * k + 0.137 * k;
            const double dySrc = 3.5 - 0.61 * k;
            cv::Mat a, b;
            makeShiftedPair(A.win, (A.win * 3) / 4, dxSrc * A.ws, dySrc * A.ws,
                            &a, &b);
            double xy[2] = {0, 0}, r = 0.0;
            rnis::pano::detail::phaseShiftBoxXY(a, b, hann, box, xy, &r);
            const double ex = xy[0] / A.ws - dxSrc;
            const double ey = xy[1] / A.ws - dySrc;
            se += ex * ex + ey * ey;
            n += 2;
        }
        err[ai] = std::sqrt(se / n);
    }
    EXPECT_LT(err[1], err[0])
        << "work scale 0.75 did not beat 0.5 in SOURCE px: "
        << err[1] << " vs " << err[0];
    EXPECT_LT(err[1], 0.85 * err[0])
        << "the gain is smaller than the packs measured (closure 0.64-0.74x): "
        << err[1] << " vs " << err[0];
}

TEST(PanoConfig, RejectsAnOutOfRangeCentroidBox) {
    rnis::pano::Config c;
    // THE DEFAULT DID NOT MOVE, and that is the round's verdict rather than an
    // oversight: the finer work scale makes the ESTIMATOR measurably quieter
    // (triangle closure 0.64x, 4/4 packs) and does NOT measurably move the
    // DELIVERABLE (wobble rms 0.945x, 95% CI [0.871, 1.034] over 40 chain
    // realisations), because the estimator is only ~26% of the local placement
    // variance.  See Config::workScale.
    EXPECT_EQ(c.workScale, 0.5) << "the precision round shipped no default change";
    EXPECT_EQ(c.corrCentroidBoxPx, 0) << "0 means DERIVE from the work scale";
    EXPECT_EQ(rnis::pano::detail::centroidBoxFor(c.workScale), 5)
        << "at the shipped work scale the support must be cv::phaseCorrelate's own";
    rnis::pano::Engine e;
    std::string err;
    c.corrCentroidBoxPx = 2;
    EXPECT_FALSE(e.configure(c, &err)) << "accepted an even support";
    c.corrCentroidBoxPx = 17;
    EXPECT_FALSE(e.configure(c, &err)) << "accepted a support past the clamp";
    c.corrCentroidBoxPx = 7;
    EXPECT_TRUE(e.configure(c, &err)) << err;
    c.corrCentroidBoxPx = 0;
    EXPECT_TRUE(e.configure(c, &err)) << err;
}

TEST(PanoCorr, TheFinerWorkScaleCostsWhatItsPixelCountCosts) {
    // THE LIVE-PATH BUDGET.  Work scale 0.75 correlates a 288x216 window
    // instead of 192x144 — 2.25x the pixels — and the host also resizes 2.25x
    // more of the frame.  This pins the SHAPE of that cost (it must scale with
    // the pixel count, not worse), and prints the host numbers.
    //
    // ⚠ ABSOLUTE numbers from this binary are NOT a device projection.  These
    // tests are configured with no CMAKE_BUILD_TYPE, i.e. -O0 (see
    // cpp/tests/CMakeLists.txt), and the repo has a standing finding that a
    // Mac-vs-device factor measured that way is an -O0 artefact.  The RATIO is
    // the transferable quantity: nearly all the work is inside prebuilt
    // OpenCV (dft, mulSpectrums, magnitude, divide, idft), which is optimised
    // in both builds.
    struct Arm { double ws; int w, h; double ms; };
    Arm arms[] = {{0.50, 192, 144, 0.0}, {0.75, 288, 216, 0.0}, {1.00, 384, 288, 0.0}};
    for (auto& A : arms) {
        cv::Mat a, b;
        makeShiftedPair(A.w, A.h, 2.3, -1.7, &a, &b);
        cv::Mat hann;
        cv::createHanningWindow(hann, cv::Size(A.w, A.h), CV_32F);
        const int box = rnis::pano::detail::centroidBoxFor(A.ws);
        double xy[2], r = 0.0;
        for (int i = 0; i < 20; ++i)                 // warm the plans/caches
            rnis::pano::detail::phaseShiftBoxXY(a, b, hann, box, xy, &r);
        const int N = 200;
        const auto t0 = std::chrono::steady_clock::now();
        for (int i = 0; i < N; ++i)
            rnis::pano::detail::phaseShiftBoxXY(a, b, hann, box, xy, &r);
        const auto t1 = std::chrono::steady_clock::now();
        A.ms = std::chrono::duration<double, std::milli>(t1 - t0).count() / N;
        std::cout << "  ws " << A.ws << "  window " << A.w << "x" << A.h
                  << "  box " << box << "  " << A.ms << " ms/correlation (host, -O0)\n";
    }
    // 2.25x the pixels must not cost more than 4x the time — i.e. the cost is
    // pixel-bounded, not super-linear (an accidental O(n^2) in the refinement
    // or a non-optimal DFT size would show up here).
    EXPECT_LT(arms[1].ms, 4.0 * arms[0].ms)
        << "ws 0.75 cost " << (arms[1].ms / arms[0].ms) << "x of ws 0.50";
    EXPECT_LT(arms[2].ms, 8.0 * arms[0].ms)
        << "ws 1.00 cost " << (arms[2].ms / arms[0].ms) << "x of ws 0.50";
}

TEST(PanoCorr, TheDefaultPathIsLiterallyCvPhaseCorrelate) {
    // THE PARITY CLAIM, and it is structural rather than statistical.
    //
    // The precision round measured a real estimator improvement and a
    // deliverable that did not move, so NOTHING shipped: the defaults are
    // untouched and `kEngineVersion` did not bump.  A generalised estimator
    // sitting in the same file is only harmless if the shipped configuration
    // cannot reach it, so this pins the dispatch:
    //
    //   the shipped work scale derives support 5, and at support 5 the engine
    //   calls cv::phaseCorrelate — the same function, not one that agrees with
    //   it to some tolerance.
    //
    // (The generalised form differs from OpenCV's packed real-DFT formulation
    // by up to ~0.05 px in float32, which is why "agrees with it" would not be
    // good enough for a no-op claim.  That difference is characterised in
    // PanoCorr.BoxFiveIsCvPhaseCorrelateAndTheResponseNeverMovesWithTheBox.)
    rnis::pano::Config c;
    ASSERT_EQ(rnis::pano::detail::centroidBoxFor(c.workScale), 5);
    ASSERT_EQ(c.corrCentroidBoxPx, 0);
    // Pinned to the CURRENT version so a silent bump still trips this test.
    // v14 is a legitimate bump (the upright bake, `outputRotationCwDeg`) and
    // none of it touches the registration path this test pins — the bake is a
    // finalize-time transpose/flip applied AFTER every strip has landed, and it
    // is 0 by default.
    // v15 (2026-09-04) likewise leaves this path alone: it changes WHICH
    // calibration row an ultra-wide sweep selects.  This test's Config names no
    // lens, and an unnamed lens still takes the body's first row exactly as
    // before, so the registration chain it pins is byte-identical.
    // v16 (2026-09-23) leaves it alone too: the seed lead-in trim runs at
    // finish(), after every strip has registered, and only CLEARS pixels —
    // placement, the ledger and the registration chain are untouched.
    EXPECT_EQ(rnis::pano::kEngineVersion, 16)
        << "the engine version bumped without a behavioural change shipping";

    // The whole sweep, at defaults, must reproduce the pre-round engine.  The
    // strongest thing a host test can say is that it is deterministic and that
    // the registration path it takes is OpenCV's own; the byte-level baseline
    // lives in the offline gate.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 12.0, 140);
    const SweepResult a = runSweepSpec(shelf, spec, testConfig());
    const SweepResult b = runSweepSpec(shelf, spec, testConfig());
    ASSERT_GT(a.stats.painted, 40);
    EXPECT_EQ(a.stats.painted, b.stats.painted);
    EXPECT_EQ(a.stats.paintedW, b.stats.paintedW);
    ASSERT_EQ(a.canvas.size(), b.canvas.size());
    EXPECT_EQ(cv::norm(a.canvas, b.canvas, cv::NORM_INF), 0.0);
    EXPECT_EQ(a.stats.corrCentroidBoxResolved, 5)
        << "the sweep resolved a support the shipped path does not use";

    // And the knob is REACHABLE — a no-op default is only interesting if the
    // measured configuration can actually be selected.
    auto cfg = testConfig();
    cfg.workScale = 0.75;
    // This arm's subject is the SUPPORT the work scale derives, not the window:
    // pin the 384 src px that the `288` below is the arithmetic of (384 x 0.75),
    // so the shipped default can move without moving this assertion.
    cfg.phaseWindowPx = 384;
    const SweepResult c75 = runSweepSpec(shelf, spec, cfg);
    EXPECT_EQ(c75.stats.corrCentroidBoxResolved, 7)
        << "raising the work scale must widen the support with it";
    EXPECT_EQ(c75.stats.corrWindowW, 288);
    EXPECT_GT(c75.stats.painted, 40);
    EXPECT_TRUE(c75.holes.empty());
}

// ── v10 — LENS UNDISTORTION (geometric fidelity) ────────────────────────────
//
// SCOPE, stated before the first assertion: this is a GEOMETRIC-FIDELITY
// change, not a wobble fix.  The wobble hypothesis was measured and refused
// (the correlation window never leaves the raw frame centre, where the radial
// field is zero — total view travel < 3 px, distortion ≤ 2 % of wobble
// variance).  What the lens DOES cost is straightness: the delivered panorama
// carries 3.7-4.5 canvas px of cross displacement peak-to-peak, of which the
// affine-irreducible part — the only part a straightness ruler can ever see —
// is 0.67-0.78 px, measured model-free on all four operator packs
// (offline harness, 2026-08-25 pano+ undistort study).
//
// The coefficients below are the operator's own packs' plumb-line fit
// (…/results/2026-08-24-panoplus-noise/lens_iter.json), for the iPhone17,1
// WIDE lens and nothing else.  Applying them to another body or another lens
// would ADD geometric error, which is why the gate exists and why every path
// out of it that is not an exact match falls back to NO correction.

namespace {

/// The shipped model — iPhone17,1 wide, plumb-line fixpoint fit.
constexpr double kFitK1 = -0.024106415924339927;
constexpr double kFitK2 =  0.026764126525081398;
/// The calibrated normalised focal, fx ÷ imageWidth.  Measured 0.69404-0.69743
/// across the four packs (ARKit's focus breathing); the table carries the mean.
constexpr double kFitFxOverW = 0.6952;

/// Ground truth for the LUT: ideal radius → distorted radius scale, by Newton
/// on the SAME polynomial the fit produced.  Written out HERE, not called from
/// the engine, so an inversion bug cannot be masked by the test sharing it.
/// (This is `lens_fit.undistort_maps`'s loop, transcribed.)
double exactScaleGT(double k1, double k2, double ru) {
    if (ru <= 1e-12) return 1.0;
    double r = ru;
    for (int i = 0; i < 40; ++i) {
        const double rr = r * r;
        const double f = r * (1.0 + k1 * rr + k2 * rr * rr) - ru;
        const double fp = 1.0 + 3.0 * k1 * rr + 5.0 * k2 * rr * rr;
        r -= f / std::max(fp, 1e-9);
    }
    return r / ru;
}

/// What a camera CARRYING (k1,k2) would deliver, given the pinhole frame: the
/// pixel at distorted radius r sees the scene point a pinhole puts at
/// ru = r(1 + k1 r² + k2 r⁴).  The engine's correction is the exact inverse of
/// this, so "distort then correct" must recover the pinhole geometry.
cv::Mat distortFrame(const cv::Mat& pin, double k1, double k2) {
    cv::Mat mx(pin.size(), CV_32FC1), my(pin.size(), CV_32FC1);
    for (int y = 0; y < pin.rows; ++y) {
        for (int x = 0; x < pin.cols; ++x) {
            const double u = ((double)x - kCx) / kFx;
            const double v = ((double)y - kCy) / kFy;
            const double rr = u * u + v * v;
            const double s = 1.0 + k1 * rr + k2 * rr * rr;
            mx.at<float>(y, x) = (float)(u * s * kFx + kCx);
            my.at<float>(y, x) = (float)(v * s * kFy + kCy);
        }
    }
    cv::Mat out;
    cv::remap(pin, out, mx, my, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    return out;
}

/// makeShelf with hard, world-STRAIGHT vertical rules drawn through it.  The
/// texture is what the phase correlation needs; the rules are what a
/// straightness measurement needs.  Positions are irregular so a one-pitch
/// alias cannot masquerade as a ridge.
cv::Mat makeRuledShelf(int width, int height) {
    cv::Mat img = makeShelf(width, height);
    for (int x = 660; x < width - 40; x += 517) {
        cv::rectangle(img, cv::Rect(x, 0, 3, height), cv::Scalar(255, 255, 255),
                      cv::FILLED);
    }
    return img;
}

/// Mean sagitta (max |residual| about a straight line, canvas px) of every
/// bright near-vertical ridge that survives the whole band.  Sub-pixel by a
/// 3-point parabola on the luma profile.  Deliberately crude — it is measuring
/// a fixture with 255-DN rules on it, not a retail scene.
double ridgeSagitta(const cv::Mat& bgr, int x0, int x1, int y0, int y1,
                    int* nRidges) {
    cv::Mat gray;
    cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
    cv::Mat f;
    gray.convertTo(f, CV_32F);
    const int yMid = (y0 + y1) / 2;
    std::vector<int> seeds;
    for (int x = x0 + 4; x < x1 - 4; ++x) {
        const float c = f.at<float>(yMid, x);
        if (c < 230.0f) continue;
        if (c >= f.at<float>(yMid, x - 1) && c > f.at<float>(yMid, x + 1)) {
            if (seeds.empty() || x - seeds.back() > 8) seeds.push_back(x);
        }
    }
    std::vector<double> sags;
    for (int sx : seeds) {
        std::vector<double> ys, xs;
        double cur = (double)sx;
        bool alive = true;
        for (int y = y0; y < y1 && alive; ++y) {
            const int c0 = (int)std::lround(cur);
            int best = -1;
            float bv = 200.0f;
            for (int d = -3; d <= 3; ++d) {
                const int x = c0 + d;
                if (x <= x0 || x >= x1 - 1) continue;
                if (f.at<float>(y, x) > bv) { bv = f.at<float>(y, x); best = x; }
            }
            if (best < 0) { alive = false; break; }
            const double a = f.at<float>(y, best - 1), b = f.at<float>(y, best),
                         c = f.at<float>(y, best + 1);
            const double den = a - 2 * b + c;
            const double sub = (std::fabs(den) < 1e-6) ? 0.0
                                : std::max(-1.0, std::min(1.0, 0.5 * (a - c) / den));
            cur = (double)best + sub;
            ys.push_back((double)y);
            xs.push_back(cur);
        }
        if (!alive || ys.size() < (size_t)((y1 - y0) * 0.95)) continue;
        const size_t n = ys.size();
        double sy = 0, sx2 = 0, syy = 0, sxy = 0;
        for (size_t i = 0; i < n; ++i) {
            sy += ys[i]; sx2 += xs[i]; syy += ys[i] * ys[i]; sxy += ys[i] * xs[i];
        }
        const double den = (double)n * syy - sy * sy;
        if (std::fabs(den) < 1e-9) continue;
        const double slope = ((double)n * sxy - sy * sx2) / den;
        const double inter = (sx2 - slope * sy) / (double)n;
        double worst = 0.0;
        for (size_t i = 0; i < n; ++i)
            worst = std::max(worst, std::fabs(xs[i] - (inter + slope * ys[i])));
        sags.push_back(worst);
    }
    if (nRidges) *nRidges = (int)sags.size();
    if (sags.empty()) return -1.0;
    double s = 0;
    for (double v : sags) s += v;
    return s / (double)sags.size();
}

/// A sweep over frames that have been pushed through `distortFrame` first —
/// i.e. what THIS camera would have delivered.  Everything else is
/// runProjectedSweep verbatim.
SweepResult runDistortedSweep(const cv::Mat& shelf, const ProjSweepSpec& s,
                              const rnis::pano::Config& cfg,
                              double k1, double k2) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;
    SweepResult out;
    const double x0ref = 1400.0, y0ref = 1400.0;
    for (int i = 0; i < s.n; ++i) {
        const double x0 = x0ref + s.dx * (double)i;
        const double y0 = y0ref + s.dy * (double)i;
        cv::Mat crop = renderProjectedFrame(shelf, x0, y0, identityQuat());
        if (std::fabs(k1) > 1e-12 || std::fabs(k2) > 1e-12)
            crop = distortFrame(crop, k1, k2);
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.q[0] = in.q[1] = in.q[2] = 0.0; in.q[3] = 1.0;
        in.t[0] = x0 * (0.6 / kFx);
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = (int64_t)i;
        out.rows.push_back(eng.ingest(in));
    }
    out.rows.push_back(eng.finish());
    eng.finalCanvas(out.canvas);
    // Rendered with the SAME `cropPadRows` as the canvas one line up — which
    // is the only argument that can separate the two, and the reason
    // `finalCoverage` takes it at all. See the PanoCoverage block.
    eng.finalCoverage(out.coverage);
    out.stats = eng.stats();
    out.holes = eng.unpaintedRuns();
    out.envelope = eng.verticalEnvelope();
    return out;
}

/// Config with the correction ON and a model injected directly — the A/B and
/// fixture path, ledgered as `override` so a pack can never be read as though
/// the shipped table had matched.
rnis::pano::Config lensConfig(double k1, double k2) {
    rnis::pano::Config c = testConfig();
    c.lensUndistort = true;
    c.lensModelOverride = true;
    c.lensK1 = k1;
    c.lensK2 = k2;
    return c;
}

}  // namespace

TEST(PanoLens, TheLutIsTheExactModelToWellUnderAHundredthOfAPixel) {
    rnis::pano::lens::RadialLut lut;
    lut.build(rnis::pano::lens::Model{kFitK1, kFitK2}, 1.2);
    ASSERT_TRUE(lut.valid());
    double worstPx = 0.0;
    for (int i = 0; i <= 2000; ++i) {
        const double ru = 1.2 * (double)i / 2000.0;
        const double got = lut.scaleForRadiusSq(ru * ru);
        const double want = exactScaleGT(kFitK1, kFitK2, ru);
        worstPx = std::max(worstPx, std::fabs(got - want) * ru * kFx);
    }
    EXPECT_LT(worstPx, 0.01) << "the LUT is not the model — worst sampling "
                                "error " << worstPx << " px";
    // PARITY ANCHOR for the offline twin, which mirrors this LUT line for line
    // (the offline twin's lens-LUT builder).  The
    // twin is what replays the operator's packs, so a transcription drift
    // between the two would silently make the replay evidence about a
    // different engine.  These are the numbers to diff.
    std::cout.precision(15);
    std::cout << "[lens lut parity] worstErrPx=" << worstPx << "\n";
    for (double ru : {0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.1}) {
        std::cout << "[lens lut parity] ru=" << ru << " scale="
                  << lut.scaleForRadiusSq(ru * ru) << "\n";
    }
}

TEST(PanoLens, AZeroModelIsExactlyIdentityEverywhere) {
    rnis::pano::lens::RadialLut lut;
    lut.build(rnis::pano::lens::Model{0.0, 0.0}, 1.2);
    ASSERT_TRUE(lut.valid());
    for (int i = 0; i <= 500; ++i) {
        const double ru = 1.2 * (double)i / 500.0;
        EXPECT_DOUBLE_EQ(lut.scaleForRadiusSq(ru * ru), 1.0);
    }
}

TEST(PanoLens, TheFieldIsZeroAtTheCentreAndPeaksWhereTheFitSaysItDoes) {
    // The measured shape, pinned in PIXELS on the operator's own geometry
    // (fx 1333.26, 1920x1440).  Zero at the centre by construction; a moustache
    // — one interior extremum, then falling back toward the corner.
    rnis::pano::lens::RadialLut lut;
    lut.build(rnis::pano::lens::Model{kFitK1, kFitK2}, 1.2);
    const double fxDev = 1333.2620849609375;
    EXPECT_NEAR(lut.scaleForRadiusSq(0.0), 1.0, 1e-12);
    double worst = 0.0, worstAt = 0.0;
    for (int rp = 0; rp <= 1210; ++rp) {
        const double ru = (double)rp / fxDev;
        const double d = (lut.scaleForRadiusSq(ru * ru) - 1.0) * ru * fxDev;
        if (std::fabs(d) > std::fabs(worst)) { worst = d; worstAt = (double)rp; }
    }
    EXPECT_NEAR(worst, 5.11, 0.15) << "peak radial displacement moved";
    EXPECT_NEAR(worstAt, 980.0, 25.0) << "the peak moved off the fitted radius";
}

TEST(PanoLens, TheGateAcceptsTheCalibratedBodyAndLens) {
    rnis::pano::Config c;
    c.lensUndistort = true;
    c.lensDeviceModel = "iPhone17,1";
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInWideAngleCamera";
    const auto d = rnis::pano::lens::resolve(c, 1333.262, 1920);
    EXPECT_EQ(d.gate, rnis::pano::lens::Gate::Applied);
    EXPECT_TRUE(d.applied());
    EXPECT_NEAR(d.model.k1, kFitK1, 1e-12);
    EXPECT_NEAR(d.model.k2, kFitK2, 1e-12);
    EXPECT_FALSE(d.source.empty()) << "an applied model with no provenance";
    EXPECT_NEAR(d.expectedFxOverWidth, kFitFxOverW, 1e-3);
}

TEST(PanoLens, TheGateRefusesAnUnknownDeviceRatherThanGuessing) {
    rnis::pano::Config c;
    c.lensUndistort = true;
    c.lensDeviceModel = "iPhone14,5";       // no row — a different body
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInWideAngleCamera";
    const auto d = rnis::pano::lens::resolve(c, 1333.262, 1920);
    EXPECT_EQ(d.gate, rnis::pano::lens::Gate::UnknownDevice);
    EXPECT_FALSE(d.applied());
    EXPECT_EQ(d.model.k1, 0.0);
    EXPECT_EQ(d.model.k2, 0.0);
    EXPECT_STREQ(rnis::pano::lens::gateName(d.gate), "unknown-device");

    // …and an EMPTY device model is unknown too — never a default to the one
    // body we happen to have calibrated.
    rnis::pano::Config e;
    e.lensUndistort = true;
    EXPECT_EQ(rnis::pano::lens::resolve(e, 1333.262, 1920).gate,
              rnis::pano::lens::Gate::UnknownDevice);
}

// ⚠️ SPEC CHANGED 2026-09-04, and this comment is why rather than a silent edit.
//
// This test used to assert that the ultra-wide gets LensMismatch on a
// calibrated body.  That was true, and it was a BUG: `resolve()` matched rows
// on the device BODY alone and `break`ed on the first hit, so the wide row —
// first in the table — was always chosen, and the ultra-wide name then
// disagreed with it.  The v13 ultra-wide calibration (2026-08-31,
// clean_fit.json) has been in the shipped table since before Test 14 and was
// unreachable the whole time; Test-14 pano+ pack 23-00-43 is the proof, with
// `lens.applied=false`, k1=k2=0, and `expectedFxOverWidth` stamped 0.6952 —
// the WIDE row's number — against ultra-wide frames measuring 0.4056.
//
// The refusal this test was written to protect is REAL and is still asserted
// below; what changed is that a lens with its OWN calibrated row now finds it.
TEST(PanoLens, TheGateRefusesAnotherLensOnTheCalibratedBody) {
    rnis::pano::Config c;
    c.lensUndistort = true;
    c.lensDeviceModel = "iPhone17,1";
    // The ultra-wide BY NAME, carrying a WIDE focal — the name and the frames
    // disagree with each other.  It still refuses, and now names the sharper
    // reason: the ultra-wide row was selected (its own row exists), and the
    // frames then failed that row's focal check.  FocalMismatch is the more
    // precise verdict, and it is the one that reads the FRAMES rather than the
    // host's claim about them.
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInUltraWideCamera";
    EXPECT_EQ(rnis::pano::lens::resolve(c, 1333.262, 1920).gate,
              rnis::pano::lens::Gate::FocalMismatch);
    // …and by FOCAL, which is the check that still fires when the AV layer
    // could not name the device (ultra-wide ≈ 0.37·W, tele ≈ 1.4·W).
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInWideAngleCamera";
    EXPECT_EQ(rnis::pano::lens::resolve(c, 0.37 * 1920.0, 1920).gate,
              rnis::pano::lens::Gate::FocalMismatch);
    EXPECT_EQ(rnis::pano::lens::resolve(c, 1.40 * 1920.0, 1920).gate,
              rnis::pano::lens::Gate::FocalMismatch);
    // The real spread of ARKit's own focus breathing must NOT be refused.
    for (double fxOverW : {0.69404, 0.69743}) {
        EXPECT_EQ(rnis::pano::lens::resolve(c, fxOverW * 1920.0, 1920).gate,
                  rnis::pano::lens::Gate::Applied) << fxOverW;
    }
}

// THE ROW THAT WAS UNREACHABLE — the regression guard for the selection bug.
TEST(PanoLens, TheUltraWideRowIsSelectableAndApplies) {
    rnis::pano::Config c;
    c.lensUndistort = true;
    c.lensDeviceModel = "iPhone17,1";
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInUltraWideCamera";
    // The ultra-wide's OWN calibrated ratio, on its own frames.
    const auto d = rnis::pano::lens::resolve(c, 0.4056 * 1920.0, 1920);
    EXPECT_EQ(d.gate, rnis::pano::lens::Gate::Applied);
    // …selecting the ULTRA-WIDE row, not the wide one.  Before the fix this
    // reported 0.6952, which is how the bug identifies itself in any pack: a
    // gate quoting the expectation of a row it should never have chosen.
    EXPECT_NEAR(d.expectedFxOverWidth, 0.4056, 1e-9);
    EXPECT_LT(d.model.k1, 0.0);          // -0.03648853362274224
    EXPECT_GT(d.model.k2, 0.0);          // +0.01880303705846588
    EXPECT_NE(d.model.k1, 0.0);
    // …and it is a DIFFERENT model from the wide row, which is the whole point.
    rnis::pano::Config w;
    w.lensUndistort = true;
    w.lensDeviceModel = "iPhone17,1";
    w.lensDeviceLens = "AVCaptureDeviceTypeBuiltInWideAngleCamera";
    const auto wd = rnis::pano::lens::resolve(w, 0.6952 * 1920.0, 1920);
    EXPECT_EQ(wd.gate, rnis::pano::lens::Gate::Applied);
    EXPECT_NE(wd.model.k1, d.model.k1);
    EXPECT_NE(wd.expectedFxOverWidth, d.expectedFxOverWidth);
}

// A KNOWN BODY ON AN UNCALIBRATED LENS IS A LENS MISMATCH, NOT AN UNKNOWN
// DEVICE.  Collapsing the two would say "we do not know this iPhone", which is
// false and points the next investigation at the wrong table.
TEST(PanoLens, AKnownBodyWithNoRowForItsLensIsALensMismatch) {
    rnis::pano::Config c;
    c.lensUndistort = true;
    c.lensDeviceModel = "iPhone17,1";
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInTelephotoCamera";  // no row
    EXPECT_EQ(rnis::pano::lens::resolve(c, 1.40 * 1920.0, 1920).gate,
              rnis::pano::lens::Gate::LensMismatch);
}

// AN UNNAMED LENS STILL MATCHES ON BODY ALONE, and must: ARKit world tracking
// streams the back wide-angle without naming it, and every ARKit pano+ pack in
// the corpus depends on that path.  The first row for the body is the wide row,
// which is the camera ARKit actually streams.
TEST(PanoLens, AnUnnamedLensTakesTheBodysFirstRowAsBefore) {
    rnis::pano::Config c;
    c.lensUndistort = true;
    c.lensDeviceModel = "iPhone17,1";
    c.lensDeviceLens = "";
    const auto d = rnis::pano::lens::resolve(c, 0.6952 * 1920.0, 1920);
    EXPECT_EQ(d.gate, rnis::pano::lens::Gate::Applied);
    EXPECT_NEAR(d.expectedFxOverWidth, 0.6952, 1e-9);
}

TEST(PanoLens, TheFlagIsOnByDefaultAndInertOnAnUnknownDevice) {
    // (c) of the brief: ON for the field build.  Safe because the gate, not the
    // flag, decides — an unknown body paints EXACTLY the shipped pixels.
    rnis::pano::Config def;
    EXPECT_TRUE(def.lensUndistort)
        << "the field build ships features ON; a feature shipped off has not "
           "been tested";

    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 40; s.dx = 12.0;
    auto off = testConfig();
    off.lensUndistort = false;
    auto on = testConfig();                 // default true, no device model
    const SweepResult a = runProjectedSweep(shelf, s, off);
    const SweepResult b = runProjectedSweep(shelf, s, on);
    ASSERT_GT(a.stats.painted, 10);
    EXPECT_EQ(a.stats.painted, b.stats.painted);
    ASSERT_EQ(a.canvas.size(), b.canvas.size());
    EXPECT_EQ(cv::norm(a.canvas, b.canvas, cv::NORM_INF), 0.0)
        << "an ungated device changed committed pixels";
    EXPECT_FALSE(b.stats.lensApplied);
    EXPECT_EQ(b.stats.lensGate, "unknown-device");
    EXPECT_EQ(b.stats.lensK1, 0.0);
}

TEST(PanoLens, AnUnknownDeviceIsRecordedInTheSessionNotSilent) {
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 30; s.dx = 12.0;
    auto cfg = testConfig();
    cfg.lensUndistort = true;
    cfg.lensDeviceModel = "iPhone14,5";
    cfg.lensDeviceLens = "AVCaptureDeviceTypeBuiltInWideAngleCamera";
    const SweepResult r = runProjectedSweep(shelf, s, cfg);
    EXPECT_FALSE(r.stats.lensApplied);
    EXPECT_EQ(r.stats.lensGate, "unknown-device");
    EXPECT_EQ(r.stats.lensDevice, "iPhone14,5")
        << "the pack must say WHICH device was not corrected";
    EXPECT_GT(r.stats.lensFxOverWidth, 0.0)
        << "the pack must carry what the gate measured, not only its verdict";
    EXPECT_EQ(r.stats.lensCorrectedStrips, 0);
}

TEST(PanoLens, TheCorrectionStraightensACameraThatCarriesTheDefect) {
    // A DELIBERATELY LARGE dose (≈30× the device's own field): the operator's
    // real lens bends a canvas line by ~0.4 px, which a 30-line ridge tracker
    // on a synthetic cannot resolve — the real-magnitude evidence is the
    // offline replay of the four packs, not this fixture.  What this pins is
    // that the painter inverts the model it is given, end to end.
    const double k1 = -0.150, k2 = 0.050;
    const cv::Mat shelf = makeRuledShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 40; s.dx = 12.0;

    auto off = testConfig();
    off.lensUndistort = false;
    const SweepResult bent = runDistortedSweep(shelf, s, off, k1, k2);
    const SweepResult fixed = runDistortedSweep(shelf, s, lensConfig(k1, k2),
                                                k1, k2);
    ASSERT_GT(bent.stats.painted, 10);
    // The canvases need NOT be the same width, and at this dose they are not
    // (937 vs 911 px measured): undistorting pulls the frame's own footprint
    // in by the size of the field, so a camera carrying 30x the device's
    // distortion delivers a visibly shorter panorama.  At the SHIPPED dose
    // that difference is ~2 canvas px, and the four-pack replay reports it
    // rather than this fixture hiding it behind an equality.
    const int wCommon = std::min({bent.stats.paintedW, fixed.stats.paintedW,
                                  bent.canvas.cols, fixed.canvas.cols});
    const int hCommon = std::min(bent.canvas.rows, fixed.canvas.rows);
    ASSERT_GT(wCommon, 300);
    const int y0 = (int)(hCommon * 0.20);
    const int y1 = (int)(hCommon * 0.80);
    int nB = 0, nF = 0;
    const double sB = ridgeSagitta(bent.canvas, 0, wCommon, y0, y1, &nB);
    const double sF = ridgeSagitta(fixed.canvas, 0, wCommon, y0, y1, &nF);
    std::cout << "[lens straighten] sagitta bent " << sB << " px (" << nB
              << " ridges) -> corrected " << sF << " px (" << nF
              << " ridges); paintedW " << bent.stats.paintedW << " -> "
              << fixed.stats.paintedW << "\n";
    ASSERT_GT(nB, 2) << "the fixture produced no measurable ridges";
    ASSERT_GT(nF, 2);
    EXPECT_GT(sB, 1.0) << "the fixture does not carry the defect it claims";
    EXPECT_LT(sF, 0.40 * sB)
        << "corrected sagitta " << sF << " px vs bent " << sB << " px over "
        << nF << "/" << nB << " ridges";
    EXPECT_TRUE(fixed.stats.lensApplied);
    EXPECT_EQ(fixed.stats.lensGate, "override");
    EXPECT_GT(fixed.stats.lensCorrectedStrips, 10);
}

TEST(PanoLens, TheIdentityModelIsGeometricallyTheShippedWarp) {
    // The PLACEBO the Job-1 ruler demanded: the remap path with a zero model
    // resamples through the same geometry the warp does.  They are different
    // OpenCV kernels, so this is a geometric claim, not a byte-parity one.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 40; s.dx = 12.0;
    auto off = testConfig();
    off.lensUndistort = false;
    const SweepResult a = runProjectedSweep(shelf, s, off);
    const SweepResult b = runProjectedSweep(shelf, s, lensConfig(0.0, 0.0));
    ASSERT_EQ(a.canvas.size(), b.canvas.size());
    EXPECT_EQ(a.stats.painted, b.stats.painted);
    EXPECT_EQ(a.stats.paintedW, b.stats.paintedW);
    cv::Mat ga, gb;
    cv::cvtColor(a.canvas, ga, cv::COLOR_BGR2GRAY);
    cv::cvtColor(b.canvas, gb, cv::COLOR_BGR2GRAY);
    cv::Mat fa, fb;
    ga.convertTo(fa, CV_32F);
    gb.convertTo(fb, CV_32F);
    const cv::Rect roi(20, 20, std::min(512, a.stats.paintedW - 40),
                       a.canvas.rows - 40);
    cv::Mat hann;
    cv::createHanningWindow(hann, roi.size(), CV_32F);
    double resp = 0.0;
    const cv::Point2d sh = cv::phaseCorrelate(fa(roi).clone(), fb(roi).clone(),
                                              hann, &resp);
    EXPECT_LT(std::hypot(sh.x, sh.y), 0.02)
        << "the identity remap moved the panorama by " << sh.x << "," << sh.y;
    EXPECT_LT(cv::norm(fa(roi), fb(roi), cv::NORM_L1) /
                  (double)(roi.width * roi.height), 1.5)
        << "the two resamplers disagree by more than interpolation";
    // ⚠ THE ASSERTION THAT MAKES THIS A PLACEBO AND NOT A TAUTOLOGY.  Without
    // it, deleting the fold from commitStrip leaves this test PASSING —
    // verified by mutation during review — because a `b` that never remapped
    // is trivially identical to `a`.  The placebo has to prove the remap path
    // RAN and still landed on the same geometry.
    EXPECT_GT(b.stats.lensCorrectedStrips, 10)
        << "the identity arm never entered the remap path — this test is "
           "comparing the shipped warp against itself";
    EXPECT_EQ(a.stats.lensCorrectedStrips, 0);
    EXPECT_EQ(b.stats.lensSkippedStrips, 0);
}

TEST(PanoLens, TheCostIsPaidPerStripNotPerFrame) {
    // The whole point of folding the correction into the painter's existing
    // homography sampling: the corrected raster is the STRIP, not the frame.
    // A separate full-frame remap pass would be 2.8 Mpx/frame against a 0.75 ms
    // p50 engine — 2-4× the engine's own budget.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 60; s.dx = 12.0;
    auto off = testConfig();
    off.lensUndistort = false;
    // MIN OF THREE, interleaved.  A single wall-clock pair on a shared machine
    // reads the machine, not the change: measured three times in a row at -Os
    // the per-frame delta came back +0.157, -0.065, +0.150 ms — including a
    // NEGATIVE one, which is the instrument telling you its own resolution.
    // The minimum is the robust estimator for a timing that can only be
    // inflated by contention.
    //
    // THREE arms, not two, because the review asked WHERE the cost is and the
    // two-arm version could not say.  `id` is the remap path with a ZERO model:
    // it pays cv::remap instead of cv::warpPerspective and it pays the map
    // build, but the LUT returns 1.0 on the first branch.  So
    //     id − off   = the resampler swap plus the map's own arithmetic,
    //     on − id    = the radial lookup itself.
    double msOff = 1e18, msOn = 1e18, msId = 1e18;
    SweepResult a, b, c;
    for (int rep = 0; rep < 3; ++rep) {
        const auto t0 = std::chrono::steady_clock::now();
        a = runProjectedSweep(shelf, s, off);
        const auto t1 = std::chrono::steady_clock::now();
        b = runProjectedSweep(shelf, s, lensConfig(kFitK1, kFitK2));
        const auto t2 = std::chrono::steady_clock::now();
        c = runProjectedSweep(shelf, s, lensConfig(0.0, 0.0));
        const auto t3 = std::chrono::steady_clock::now();
        msOff = std::min(msOff, std::chrono::duration<double, std::milli>(t1 - t0).count());
        msOn = std::min(msOn, std::chrono::duration<double, std::milli>(t2 - t1).count());
        msId = std::min(msId, std::chrono::duration<double, std::milli>(t3 - t2).count());
    }
    // The engine's OWN per-frame time, which is what the live path pays.
    // BOTH the mean and the MEDIAN OVER PAINTED FRAMES are reported: the mean
    // carries the bootstrap lead-in and the tail flush, which paint a WHOLE
    // footprint and are therefore the two most expensive frames of any sweep;
    // the median is the steady state, which is what a 60 fps budget is about.
    auto medPainted = [](const SweepResult& r) {
        std::vector<double> v;
        for (const auto& row : r.rows)
            if (row.outcome == rnis::pano::Outcome::Painted) v.push_back(row.engineMs);
        if (v.empty()) return 0.0;
        std::sort(v.begin(), v.end());
        return v[v.size() / 2];
    };
    double engOff = 0, engOn = 0;
    for (const auto& r : a.rows) engOff += r.engineMs;
    for (const auto& r : b.rows) engOn += r.engineMs;
    const double perOff = engOff / (double)a.rows.size();
    const double perOn = engOn / (double)b.rows.size();
    const double p50Off = medPainted(a), p50On = medPainted(b),
                 p50Id = medPainted(c);
    // The per-frame figures come from the LAST rep's ledger; the whole-sweep
    // pair is the MIN over the three, which is the only one of the three
    // numbers that a busy machine can only make worse.
    std::cout << "[lens cost] last rep, engine per frame: mean off " << perOff
              << " ms, on " << perOn << " ms (Δ " << (perOn - perOff)
              << " ms) | p50 over PAINTED frames: off " << p50Off << " on "
              << p50On << " (Δ " << (p50On - p50Off) << " ms) | whole sweep, "
              << "MIN of 3: " << msOff << " → " << msOn << " ms ("
              << (100.0 * (msOn - msOff) / std::max(1e-9, msOff)) << " %)\n";
    std::cout << "[lens cost split] p50 painted: off " << p50Off << " | id "
              << p50Id << " (resampler+map Δ " << (p50Id - p50Off)
              << ") | model " << p50On << " (radial lookup Δ "
              << (p50On - p50Id) << ") ms | whole sweep MIN of 3: off " << msOff
              << " id " << msId << " model " << msOn << " ms\n";
    // The remapped raster per strip: the committed columns (plus the gain
    // sample window the painter already warps) against the whole frame.
    const double stripPx = (double)b.stats.canvasH *
                           std::max(1.0, (double)b.stats.paintedW /
                                         std::max(1.0, (double)b.stats.painted));
    const double framePx = (double)kFrameW * (double)kFrameH;
    EXPECT_LT(stripPx, 0.15 * framePx)
        << "the corrected raster is frame-sized — the fold did not happen";
    // ⚠ THERE IS DELIBERATELY NO WALL-CLOCK ASSERTION HERE — it was removed
    // after review, not softened.  The first cut of this test ended in
    // `EXPECT_LT(perOn - perOff, 2.0)`, whose own comment argued that a second
    // flaky timing gate "would be worse than none" — and which then failed 4
    // of 8 standalone -O0 runs, exactly as that comment predicted of the
    // OTHER wall-clock test in this suite.  A gate that fails on a loaded
    // machine teaches the team to ignore red, which is the failure mode this
    // repo has already paid for.  So the milliseconds are PRINTED and the
    // ASSERTIONS are on invariants that a machine's load cannot move:
    // the raster size above, and the fold actually having run below.
    //
    // The number that decides the cost question is measured on the PHONE, and
    // it has not been measured yet (§v13.6 "OPEN").  Nothing here should be
    // read as a device projection: a host↔device factor measures build
    // settings, not hardware, and this binary is not even the Release pod.
    EXPECT_GT(b.stats.lensCorrectedStrips, 10)
        << "the timed arm never ran the fold — this is timing the control "
           "against itself";
    EXPECT_EQ(a.stats.lensCorrectedStrips, 0);
}

// ── ROUND-2 TESTS: every one of these was written because a review found a
// hole the first twelve did not cover.  Named for the hole, not for the code.

TEST(PanoLens, AModelThatCannotBeTabulatedSaysSoAndPaintsTheShippedPixels) {
    // C5(c): a model the gate ACCEPTED and the LUT then could not invert used
    // to leave the pack reading gate `applied` beside `applied:false` — two
    // fields a reader had to combine to learn that nothing was corrected.
    // It is now its own outcome.  k1 = −40 makes r·(1+k1r²) fold back on
    // itself, so Newton cannot return a positive root.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 30; s.dx = 12.0;
    auto off = testConfig();
    off.lensUndistort = false;
    const SweepResult a = runProjectedSweep(shelf, s, off);
    const SweepResult b = runProjectedSweep(shelf, s, lensConfig(-40.0, 0.0));
    EXPECT_EQ(b.stats.lensGate, "lut-failed");
    EXPECT_FALSE(b.stats.lensApplied);
    EXPECT_EQ(b.stats.lensCorrectedStrips, 0);
    EXPECT_EQ(b.stats.lensSkippedStrips, 0);
    // …and it falls back to the SHIPPED warp, byte for byte.  A model that
    // cannot be built must not become a half-corrected canvas.
    ASSERT_EQ(a.canvas.size(), b.canvas.size());
    EXPECT_EQ(cv::norm(a.canvas, b.canvas, cv::NORM_INF), 0.0);
    EXPECT_EQ(a.stats.painted, b.stats.painted);
}

TEST(PanoLens, TheStripCountersDescribeCommittedStripsOnly) {
    // C5(b): the counters used to tick on ATTEMPT, so a strip that resampled
    // and then committed no columns still reported itself corrected — measured
    // 347 "corrected" against 345 painted on a real pack, which is a ledger
    // nobody can check.  A counter that can exceed the thing it counts is not
    // a counter.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 40; s.dx = 12.0;
    const SweepResult r = runProjectedSweep(shelf, s, lensConfig(kFitK1, kFitK2));
    ASSERT_GT(r.stats.painted, 10);
    EXPECT_GT(r.stats.lensCorrectedStrips, 10);
    // EXACT, against the strip commits — not against `painted`.  A sweep
    // commits strips no frame row is marked Painted for (the bootstrap
    // lead-in, the tail flush, an interior backfill), which is why the raw
    // ledger read 347 against 345 and looked broken.  With the correction live
    // and no lens switch, every committed strip is corrected and none is
    // skipped, so the three numbers close exactly.
    EXPECT_EQ(r.stats.lensCorrectedStrips + r.stats.lensSkippedStrips,
              r.stats.stripsCommitted)
        << "corrected " << r.stats.lensCorrectedStrips << " + skipped "
        << r.stats.lensSkippedStrips << " != committed "
        << r.stats.stripsCommitted;
    EXPECT_EQ(r.stats.lensSkippedStrips, 0);
    EXPECT_GT(r.stats.stripsCommitted, (int64_t)r.stats.painted)
        << "the fixture no longer commits a lead-in and a tail flush, so this "
           "test is no longer distinguishing commits from painted frames";
    // …and the correction changes NOTHING about how many strips commit.
    auto off = testConfig();
    off.lensUndistort = false;
    const SweepResult q = runProjectedSweep(shelf, s, off);
    EXPECT_EQ(q.stats.stripsCommitted, r.stats.stripsCommitted);
    EXPECT_EQ(q.stats.lensCorrectedStrips, 0);
}

TEST(PanoLens, TheStripCountersAreReBasedByARelatch) {
    // C5(a): every other seam/session metric is re-based in reseedReferenceTo
    // because a relatch DISCARDS the canvas.  These two were not, so after a
    // relatch they counted strips that are in no deliverable.  Same fixture
    // and same bound as PanoRelatch.SessionMetricsAreReBasedWithTheDiscarded-
    // Canvas, so the two move together.
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto steps = walkWithTransversePitch(120, 14.0, [](int i) {
        return i < 20 ? 8.0 * std::sin(CV_PI * (double)i / 20.0) : 0.0;
    });
    auto cfg = lensConfig(kFitK1, kFitK2);
    const SweepResult r = runGestureSweep(shelf, steps, cfg);
    ASSERT_GT(r.stats.relatchCount, 0) << "fixture no longer relatches";
    ASSERT_GT(r.stats.painted, 20);
    EXPECT_GT(r.stats.lensCorrectedStrips, 0) << "the fold never ran";
    EXPECT_EQ(r.stats.lensCorrectedStrips + r.stats.lensSkippedStrips,
              r.stats.stripsCommitted)
        << "the lens counters survived a relatch that threw their canvas away";
    // ⚠ THE PIN, not just the bound: without the re-base the counters carry the
    // pre-relatch strips while `stripsCommitted` (re-based alongside them) does
    // not, so the equality above breaks by exactly the discarded count.
    // Verified by mutation: deleting the two re-base lines in
    // reseedReferenceTo makes the equality above read 100 against 97.
    EXPECT_LT(r.stats.stripsCommitted, (int64_t)r.stats.painted + 8)
        << "committed " << r.stats.stripsCommitted << " strips against "
        << r.stats.painted << " painted frames — the re-base did not happen";
}

TEST(PanoLens, ThePeakNumbersAreNamedApartBecauseTheyAreDifferentQuantities) {
    // C6 of the metric review: the pack ledgered ONE number called `peakPx`
    // (5.11 px) beside a design note quoting 4.36 px, and nothing said they
    // were different quantities.  They are: the RADIAL move includes the pure
    // scale term, the RESIDUAL is what is left after removing it — and only
    // the residual can bend a straight line.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 30; s.dx = 12.0;
    const SweepResult r = runProjectedSweep(shelf, s, lensConfig(kFitK1, kFitK2));
    ASSERT_TRUE(r.stats.lensApplied);
    std::cout << "[lens peaks] radial " << r.stats.lensPeakRadialPx
              << " px, residual " << r.stats.lensPeakResidualPx << " px\n";
    EXPECT_GT(r.stats.lensPeakRadialPx, 0.0);
    EXPECT_GT(r.stats.lensPeakResidualPx, 0.0);
    EXPECT_LT(r.stats.lensPeakResidualPx, r.stats.lensPeakRadialPx)
        << "removing a scale term cannot make the field larger";
    // A PURE SCALE has a zero residual and a large radial move: that is the
    // whole reason the two are reported apart.  k1 alone at a tiny dose is
    // very nearly a scale over this radius range.
    const SweepResult q = runProjectedSweep(shelf, s, lensConfig(-0.02, 0.0));
    ASSERT_TRUE(q.stats.lensApplied);
    EXPECT_LT(q.stats.lensPeakResidualPx, 0.5 * q.stats.lensPeakRadialPx);
    // Nothing applied ⇒ both zero, never a stale number.
    auto off = testConfig();
    off.lensUndistort = false;
    const SweepResult z = runProjectedSweep(shelf, s, off);
    EXPECT_EQ(z.stats.lensPeakRadialPx, 0.0);
    EXPECT_EQ(z.stats.lensPeakResidualPx, 0.0);
}

TEST(PanoLens, TheRowBoundNeverDropsARowTheFrameCouldPaint) {
    // The map is now built only over the canvas rows the frame's own footprint
    // can reach (the rest are filled with the invalid sentinel).  That is a
    // performance change on a correctness-critical path: get the bound wrong
    // and painted rows vanish silently.  Pin it against the SHIPPED warp,
    // which has no such bound, using the ZERO model so the two must agree
    // exactly in extent.
    const cv::Mat shelf = makeShelf(6000, kFrameH);
    ProjSweepSpec s;
    s.n = 40; s.dx = 12.0;
    auto off = testConfig();
    off.lensUndistort = false;
    const SweepResult a = runProjectedSweep(shelf, s, off);
    const SweepResult b = runProjectedSweep(shelf, s, lensConfig(0.0, 0.0));
    ASSERT_GT(b.stats.lensCorrectedStrips, 10);
    ASSERT_EQ(a.canvas.size(), b.canvas.size());
    auto coveredRows = [](const cv::Mat& c) {
        cv::Mat g; cv::cvtColor(c, g, cv::COLOR_BGR2GRAY);
        int n = 0;
        for (int y = 0; y < g.rows; ++y)
            if (cv::countNonZero(g.row(y)) > 0) ++n;
        return n;
    };
    EXPECT_EQ(coveredRows(a.canvas), coveredRows(b.canvas))
        << "the row bound dropped rows the shipped warp paints";
    EXPECT_EQ(a.holes.size(), b.holes.size());
    // …and with a REAL model the extent may shrink (the footprint pulls in),
    // but it must never GROW and must never break into holes.
    const SweepResult c = runProjectedSweep(shelf, s, lensConfig(kFitK1, kFitK2));
    EXPECT_LE(coveredRows(c.canvas), coveredRows(a.canvas));
    EXPECT_GT(coveredRows(c.canvas), (int)(0.97 * coveredRows(a.canvas)))
        << "the correction lost more rows than its own field can explain";
    EXPECT_TRUE(c.holes.empty()) << c.holes.size() << " interior holes";
}

TEST(PanoLens, TheOverrideIsNotReachableFromTheHostOptionsDictionary) {
    // THE SAFETY HOLE THE REVIEW FOUND.  `lensModelOverride`/`lensK1`/`lensK2`
    // apply ARBITRARY radial coefficients to ANY body, skipping the table —
    // exactly the outcome the gate exists to prevent.  They used to be read
    // straight out of the JS options dictionary, which made the gate
    // advisory.  This scans the bridge so the hole cannot be reopened by an
    // edit that looks harmless.
    const std::string path = std::string(RNIS_IOS_SRC_DIR) + "/RNISPanoCore.mm";
    std::ifstream f(path);
    ASSERT_TRUE(f.good()) << "cannot read the bridge at " << path;
    std::stringstream ss; ss << f.rdbuf();
    const std::string src = ss.str();
    ASSERT_GT(src.size(), 1000u);
    for (const char* key : {"boolOr(options, @\"lensModelOverride\"",
                            "numOr(options, @\"lensK1\"",
                            "numOr(options, @\"lensK2\""}) {
        EXPECT_EQ(src.find(key), std::string::npos)
            << "the bridge reads " << key << " from JS — the gate is bypassable";
    }
    // The identity the gate decides ON must still come from NATIVE, never from
    // the dictionary, for the same reason.
    EXPECT_NE(src.find("c.lensDeviceModel      = std::string([deviceModel()"),
              std::string::npos)
        << "the body is no longer read natively";
    EXPECT_EQ(src.find("strOr(options, @\"lensDeviceModel\""), std::string::npos);
}

// ════════════════════════════════════════════════════════════════════════════
// THE HOLD IS RECORDED, AND RECORDED IS ALL IT IS.
// ════════════════════════════════════════════════════════════════════════════
//
// The 2026-08-29 packs carry `axis`, `sweepSign` and `axisOverride` and say
// NOTHING about how the phone was held, so establishing that all three were
// landscape-left required deriving the hold from `referenceQuat`.  That
// derivation pins the rotation chain the coach arrow and the preview panel
// both walk, and the FIRST PORTRAIT PACK is exactly the case it has never been
// checked on.  So the hold now rides in `meta.json`.
//
// The danger in adding a host-supplied string to a start dictionary is that it
// stops being an observation and becomes an input — a `hold` that reached the
// axis latch, the rectifier or the preview rotation would be the operator's
// phone telling the engine what to conclude, which is how a self-confirming
// measurement is built.  This scans the bridge so that cannot happen by an
// edit that looks harmless, in the same shape as the lens-override gate above.
TEST(PanoLens, TheRecordedHoldIsAnObservationAndNeverAnInput) {
    const std::string path = std::string(RNIS_IOS_SRC_DIR) + "/RNISPanoCore.mm";
    std::ifstream f(path);
    ASSERT_TRUE(f.good()) << "cannot read the bridge at " << path;
    std::stringstream ss; ss << f.rdbuf();
    const std::string src = ss.str();
    ASSERT_GT(src.size(), 1000u);

    // It IS read from the host — it is an observation the host owns — and it
    // IS written to the pack, or recording it would be pointless.
    EXPECT_NE(src.find("strOr(options, @\"hold\""), std::string::npos)
        << "the bridge no longer reads the hold, so packs cannot say how the "
           "phone was held and every direction claim stays a derivation";
    EXPECT_NE(src.find("@\"hold\":"), std::string::npos)
        << "the hold is read and then dropped — it never reaches meta.json";

    // ...and it reaches NOTHING else.  Every config field is assigned through
    // `c.` in `configure`; the string must never appear on that side.
    for (const char* forbidden : {"c.hold", "cfg.hold", "S->cfg.hold"}) {
        EXPECT_EQ(src.find(forbidden), std::string::npos)
            << forbidden << " — the recorded hold is feeding the engine, which "
               "turns an observation into an input and makes the pack "
               "self-confirming";
    }
    // The one legitimate home, so a future reader can find it.
    EXPECT_NE(src.find("S->hold"), std::string::npos);
}

// ⚠️ REWRITTEN 2026-09-04.  THIS IS THE TEST THAT SHOULD HAVE CAUGHT THE BUG
// AND COULD NOT, because it never called `resolve()`.  It inspected the table
// and asserted that the two rows' focals are far apart, then closed with a
// comment about row selection depending on table ORDER — naming the exact
// defect that was live three lines of production code away, while testing
// something else.  It was green for the entire life of the bug.
//
// The lesson is specific and worth stating so it is not re-learned: a test that
// reads a DATA TABLE proves things about the table.  It proves nothing about
// the function that reads it.  The selection bug lived in the reader.
//
// What it now pins, in order:
//   1. SELECTION IS INDEPENDENT OF TABLE ORDER — as a property over every row
//      the shipped table holds, not as two hand-written cases.  This is the
//      assertion that fails the instant someone restores a device-only match
//      that `break`s on the first hit.
//   2. EVERY ROW NAMES A LENS, which keeps the `lens != nullptr` guard in
//      `resolve()` dead code.  A row with a null lens name would be a WILDCARD
//      that swallowed every named lens for its body — order-dependence again,
//      by a different door.
//   3. THE FOCALS STAY SEPARATED — kept from the old test, but for the reason
//      that is actually load-bearing now (see the test below it).
TEST(PanoLens, TheUltraWideRowIsPresentAndGatesOnItsOwnFocal) {
    size_t n = 0;
    const auto* t = rnis::pano::lens::table(&n);
    ASSERT_GE(n, 2u);

    // ── 1. EVERY row is reachable by its own key, whatever its position ──────
    // Written as a loop over the SHIPPED table on purpose: a third row added
    // tomorrow is covered the moment it lands, and a row that becomes
    // unreachable fails here rather than in a pack six weeks later.
    for (size_t i = 0; i < n; ++i) {
        rnis::pano::Config c;
        c.lensUndistort   = true;
        c.lensDeviceModel = t[i].device;
        c.lensDeviceLens  = t[i].lens;                     // ← 2: never null
        const auto d = rnis::pano::lens::resolve(
            c, t[i].fxOverWidth * 1920.0, 1920);
        EXPECT_EQ(d.gate, rnis::pano::lens::Gate::Applied)
            << "row " << i << " (" << t[i].device << " / " << t[i].lens
            << ") is not reachable by its own device+lens+focal";
        // …and it is THIS row's calibration, not a neighbour's.  Comparing the
        // coefficients is what makes the assertion about SELECTION rather than
        // merely about acceptance: the old code also returned Applied here for
        // row 0, with row 0's numbers, and was still wrong for row 1.
        EXPECT_NEAR(d.expectedFxOverWidth, t[i].fxOverWidth, 1e-12) << i;
        EXPECT_NEAR(d.model.k1, t[i].k1, 1e-15) << "row " << i << " k1";
        EXPECT_NEAR(d.model.k2, t[i].k2, 1e-15) << "row " << i << " k2";
    }

    // ── 2. No row may leave its lens unnamed ────────────────────────────────
    for (size_t i = 0; i < n; ++i) {
        ASSERT_NE(t[i].lens, nullptr) << "row " << i << " has a null lens name";
        EXPECT_GT(std::string(t[i].lens).size(), 0u)
            << "row " << i << " names no lens, so it is a wildcard for its "
               "body and re-creates the order-dependence v15 removed";
        ASSERT_NE(t[i].device, nullptr) << "row " << i;
    }

    // ── 3. The two shipped rows, by identity and by sign ────────────────────
    const rnis::pano::lens::Entry* uw = nullptr;
    const rnis::pano::lens::Entry* wide = nullptr;
    for (size_t i = 0; i < n; ++i) {
        const std::string lens = t[i].lens;
        if (lens.find("UltraWide") != std::string::npos) uw = &t[i];
        else if (lens.find("WideAngle") != std::string::npos) wide = &t[i];
    }
    ASSERT_NE(uw, nullptr) << "the ultra-wide row must be in the shipped table";
    ASSERT_NE(wide, nullptr);
    // The measured delivered-fx ratio, NOT the FOV-derived 0.3933 — the fit
    // report is explicit that the FOV-derived focal would sit at the edge of
    // the +-4% gate for no reason.
    EXPECT_NEAR(uw->fxOverWidth, 0.4056, 1e-4);
    EXPECT_LT(uw->k1, 0.0) << "barrel at the corners: k1 must be negative";
    EXPECT_GT(uw->k2, 0.0) << "moustache: k2 positive, as on the wide row";

    // ── 4. The focals stay separated — RESTATED, because the reason changed ──
    // The old comment said a narrow separation "would make row selection
    // depend on table ORDER".  That was never what this quantity did: before
    // v15 selection ignored the focal entirely, and after v15 it is the LENS
    // NAME that selects.  What the separation actually buys, now that the name
    // is part of the selection key, is that a MISNAMED lens is REFUSED instead
    // of being handed another row's coefficients — see
    // AMisnamedLensIsRefusedByTheFramesNotTrusted directly below.  Keep the
    // margin wide for that reason.
    const double sep = std::fabs(wide->fxOverWidth - uw->fxOverWidth)
                     / uw->fxOverWidth;
    EXPECT_GT(sep, 0.10)
        << "two rows for one body whose focals are within the +-4% gate "
           "tolerance would let a misnamed lens have the WRONG row's "
           "coefficients applied to its pixels";
}

// THE SAFETY PROPERTY THE v15 CHANGE NEEDS, stated as its own test because the
// change promoted `lensDeviceLens` from a post-hoc CHECK to part of the
// selection KEY — i.e. the host's claim about the camera now decides which
// calibration is fetched.  That is only acceptable while the FRAMES retain the
// last word, and this is where that is pinned.
//
// It matters most on the ARKit arm, where the producer is structurally unable
// to tell the truth: `RNISPanoCameraLock.lensType()` resolves the default back
// WIDE-ANGLE device and reports its type, whatever ARKit is really streaming
// (PanoPlusBridge.swift:304).  So "wide-angle" from that arm is a default, not
// an observation, and the gate must not treat it as one.
TEST(PanoLens, AMisnamedLensIsRefusedByTheFramesNotTrusted) {
    rnis::pano::Config c;
    c.lensUndistort   = true;
    c.lensDeviceModel = "iPhone17,1";

    // Ultra-wide FRAMES (fx÷W ≈ 0.4056, the measured 2026-09-04 range is
    // 0.3992-0.4054) arriving under the wide-angle NAME — exactly what the
    // ARKit arm would report if ARKit ever streamed the 0.5x camera.
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInWideAngleCamera";
    for (double fxOverW : {0.3992, 0.4054, 0.4056}) {
        const auto d = rnis::pano::lens::resolve(c, fxOverW * 1920.0, 1920);
        EXPECT_EQ(d.gate, rnis::pano::lens::Gate::FocalMismatch) << fxOverW;
        EXPECT_FALSE(d.applied()) << fxOverW;
        // The wide row was selected by the name and then REFUSED by the
        // frames.  Its coefficients must not have leaked out with the refusal.
        EXPECT_EQ(d.model.k1, 0.0) << fxOverW;
        EXPECT_EQ(d.model.k2, 0.0) << fxOverW;
    }

    // …and the mirror image: wide frames under the ultra-wide name.  Neither
    // direction may apply anything.
    c.lensDeviceLens = "AVCaptureDeviceTypeBuiltInUltraWideCamera";
    for (double fxOverW : {0.69496, 0.70101}) {   // the two measured wide packs
        const auto d = rnis::pano::lens::resolve(c, fxOverW * 1920.0, 1920);
        EXPECT_EQ(d.gate, rnis::pano::lens::Gate::FocalMismatch) << fxOverW;
        EXPECT_EQ(d.model.k1, 0.0) << fxOverW;
    }

    // The unnamed case is the same argument with the name absent: the body's
    // first row is taken on trust, and the frames still decide.  Ultra-wide
    // frames with no name must NOT quietly receive the wide row's model.
    c.lensDeviceLens = "";
    const auto u = rnis::pano::lens::resolve(c, 0.4056 * 1920.0, 1920);
    EXPECT_EQ(u.gate, rnis::pano::lens::Gate::FocalMismatch);
    EXPECT_EQ(u.model.k1, 0.0);
}

TEST(PanoLens, TheEngineVersionCarriesTheChange) {
    // v15 (2026-09-04): the ultra-wide calibration row becomes reachable.  A
    // 0.5x sweep gains the distortion correction it was always supposed to have
    // (peak corner move 19.1 px) — different output PIXELS, which is the bar
    // v12 set for a bump.  Wide and unnamed-lens sweeps are byte-identical.
    // v16 (2026-09-23): the seed lead-in trim goes default ON — different
    // PIXELS on every sweep that paints a strip, the same bar.
    // See the version ledger in the header.
    EXPECT_EQ(rnis::pano::kEngineVersion, 16)
        << "a behavioural change shipped without a version bump";
}

// ════════════════════════════════════════════════════════════════════════════
// THE PREVIEW PUBLISHER — the defect that shipped, and the seam that hid it.
// ════════════════════════════════════════════════════════════════════════════
//
// The live preview reached the operator's phone ZERO times across eight device
// packs.  The engine rendered ~30 previews per sweep and PanoPreview.* below
// has been green about that the whole time; the ObjC++ publisher threw on
// every single one and swallowed it.  These tests exist because that failure
// was reachable from NEITHER suite: the geometry is C++ (tested), the contract
// is TypeScript (tested), and the write was ObjC++ (not tested, not testable).
//
// So the write moved into this translation unit, and the bridge is now checked
// by grep for the idiom that broke — the same discipline PanoLens uses to keep
// the safety gate out of the options dictionary.

namespace {

/// A scratch directory that is UNIQUE per test and removed afterwards, so a
/// stale file from an earlier run can never make a publish test pass.
class ScratchDir {
public:
    explicit ScratchDir(const std::string& tag) {
        const char* base = std::getenv("TMPDIR");
        dir_ = (base != nullptr ? std::string(base) : std::string("/tmp/"));
        if (dir_.empty() || dir_.back() != '/') dir_ += '/';
        dir_ += "rnis_pano_publish_" + tag + "_" +
                std::to_string((long long)::getpid()) + "_" +
                std::to_string((long long)counter_++);
        ::mkdir(dir_.c_str(), 0700);
    }
    ~ScratchDir() {
        // Best-effort: a leaked scratch dir is noise, never a wrong verdict.
        const std::string cmd = "rm -rf '" + dir_ + "'";
        (void)std::system(cmd.c_str());
    }
    std::string at(const std::string& name) const { return dir_ + "/" + name; }
    const std::string& path() const { return dir_; }

private:
    std::string dir_;
    static int counter_;
};
int ScratchDir::counter_ = 0;

bool fileExists(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    return f.good();
}

std::vector<unsigned char> readAll(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    return std::vector<unsigned char>((std::istreambuf_iterator<char>(f)),
                                      std::istreambuf_iterator<char>());
}

cv::Mat previewLike() {
    // The shape a real pano+ preview has on the operator's packs: an 800-px
    // cross axis, a tall sweep, three channels.
    cv::Mat m(1236, 800, CV_8UC3, cv::Scalar(20, 40, 60));
    cv::rectangle(m, cv::Rect(60, 90, 300, 400), cv::Scalar(200, 180, 40), -1);
    cv::circle(m, cv::Point(500, 900), 180, cv::Scalar(30, 30, 220), -1);
    return m;
}

}  // namespace

// THE DEFECT ITSELF, executed.  This is the line the bridge shipped, and it
// does not "return false" — it THROWS, which is why an `if (imwrite(...))`
// guard could never catch it and the empty catch below it ate every preview.
//
// Written as an assertion about OpenCV rather than about our code on purpose:
// if a future OpenCV ever makes this WORK, this test goes red and tells us the
// hazard is gone, instead of silently blessing an idiom that is still wrong on
// the version the device links (vendored 4.10).
TEST(PanoPreviewPublish, TheShippedTmpExtensionIdiomThrowsAndWritesNothing) {
    ScratchDir dir("legacy");
    const cv::Mat img = previewLike();
    const std::string dest = dir.at("preview.jpg");
    const std::string tmp  = dest + ".tmp";     // stringByAppendingPathExtension:@"tmp"

    bool threw = false;
    std::string what;
    try {
        const std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, 60};
        const bool ok = cv::imwrite(tmp, img, params);
        // If it ever returns instead of throwing, it must at least be honest.
        EXPECT_FALSE(ok) << "imwrite claimed success on a '.tmp' destination";
    } catch (const cv::Exception& e) {
        threw = true;
        what = e.what();
    }
    EXPECT_TRUE(threw)
        << "cv::imwrite to a '.tmp' path did not throw on this OpenCV — "
           "re-read the publisher's contract before relying on that";
    EXPECT_NE(what.find("extension"), std::string::npos) << what;
    EXPECT_FALSE(fileExists(tmp))  << "a file appeared at the temp path";
    EXPECT_FALSE(fileExists(dest)) << "a file appeared at the destination";
}

// THE FIX'S CONTRACT: the destination's NAME cannot influence the encode.
// All three of these produced nothing under the old idiom; all three must
// produce a real JPEG now.
TEST(PanoPreviewPublish, PublishesRealJpegBytesWhateverTheDestinationIsCalled) {
    ScratchDir dir("names");
    const cv::Mat img = previewLike();
    for (const char* name : {"preview.jpg", "preview.jpg.tmp", "preview.tmp",
                             "preview", "preview.PART"}) {
        const std::string dest = dir.at(name);
        std::string err = "untouched";
        ASSERT_TRUE(rnis::pano::publishJpegAtomically(dest, img, 60, &err))
            << name << " -> " << err;
        EXPECT_TRUE(err.empty()) << "success must not report an error: " << err;
        ASSERT_TRUE(fileExists(dest)) << name;

        const std::vector<unsigned char> bytes = readAll(dest);
        ASSERT_GE(bytes.size(), 4u) << name;
        // JPEG SOI + the JFIF/APP0 marker byte: these ARE image bytes, not an
        // empty file that happens to exist.
        EXPECT_EQ(bytes[0], 0xFF) << name;
        EXPECT_EQ(bytes[1], 0xD8) << name;
        EXPECT_EQ(bytes[2], 0xFF) << name;

        // And they decode back to the picture that went in.
        const cv::Mat back = cv::imdecode(bytes, cv::IMREAD_COLOR);
        ASSERT_FALSE(back.empty()) << name;
        EXPECT_EQ(back.cols, img.cols) << name;
        EXPECT_EQ(back.rows, img.rows) << name;
        // q60 JPEG of a flat-block image: mean absolute error stays small.
        cv::Mat diff;
        cv::absdiff(back, img, diff);
        EXPECT_LT(cv::mean(diff)[0], 6.0) << name;
    }
}

// A READER MUST NEVER SEE A HALF FILE, and must never trip over our leftovers.
TEST(PanoPreviewPublish, LeavesNoTemporaryBehindAndReplacesInPlace) {
    ScratchDir dir("atomic");
    const std::string dest = dir.at("preview.jpg");

    cv::Mat first(400, 300, CV_8UC3, cv::Scalar(10, 200, 10));
    std::string err;
    ASSERT_TRUE(rnis::pano::publishJpegAtomically(dest, first, 60, &err)) << err;
    EXPECT_FALSE(fileExists(dest + ".part"))
        << "the temp file survived a successful publish";
    cv::Mat back = cv::imdecode(readAll(dest), cv::IMREAD_COLOR);
    ASSERT_FALSE(back.empty());
    EXPECT_EQ(back.rows, 400);

    // The panorama GROWS: every republish writes the same path with a
    // different shape, and the host cache-busts on the published seq.  The
    // second publish must fully replace the first, not append to it.
    cv::Mat second(900, 300, CV_8UC3, cv::Scalar(10, 10, 200));
    ASSERT_TRUE(rnis::pano::publishJpegAtomically(dest, second, 60, &err)) << err;
    back = cv::imdecode(readAll(dest), cv::IMREAD_COLOR);
    ASSERT_FALSE(back.empty());
    EXPECT_EQ(back.rows, 900) << "a republish did not replace the bytes";
    EXPECT_FALSE(fileExists(dest + ".part"));
}

// EVERY FAILURE PATH NAMES ITSELF.  The original bug was survivable; being
// SILENT about it for eleven days was not.
TEST(PanoPreviewPublish, EveryRefusalReportsWhyAndWritesNothing) {
    ScratchDir dir("refuse");

    // 1. An empty image — what previewIntoFit returns before the axis latches
    //    if a caller ignores its `false`.
    {
        std::string err;
        const std::string dest = dir.at("empty.jpg");
        EXPECT_FALSE(rnis::pano::publishJpegAtomically(dest, cv::Mat(), 60, &err));
        EXPECT_FALSE(err.empty()) << "a refusal with no reason is the old bug";
        EXPECT_FALSE(fileExists(dest));
        EXPECT_FALSE(fileExists(dest + ".part"));
    }
    // 2. A destination directory that does not exist — a session dir the OS
    //    reclaimed mid-sweep.
    {
        std::string err;
        const std::string dest = dir.at("no/such/dir/preview.jpg");
        EXPECT_FALSE(rnis::pano::publishJpegAtomically(dest, previewLike(), 60, &err));
        EXPECT_FALSE(err.empty());
        EXPECT_NE(err.find("preview.jpg.part"), std::string::npos)
            << "the reason must name the path that failed: " << err;
    }
    // 3. An empty path.
    {
        std::string err;
        EXPECT_FALSE(rnis::pano::publishJpegAtomically("", previewLike(), 60, &err));
        EXPECT_FALSE(err.empty());
    }
    // 4. A null `err` out-param must not crash a caller that does not want it.
    {
        EXPECT_FALSE(rnis::pano::publishJpegAtomically(dir.at("x.jpg"),
                                                       cv::Mat(), 60, nullptr));
    }
}

// THE SEAM, CLOSED BY GREP.
//
// The C++ above can prove the publisher is correct.  It cannot prove the
// BRIDGE calls it — and "both halves are right and neither can reach the
// other" is precisely the class of defect that shipped here.  So the bridge
// source is read and checked for the idiom that broke, exactly as
// PanoLens.TheOverrideIsNotReachableFromTheHostOptionsDictionary does for the
// safety gate.  A grep in a test is a poor substitute for a type system; the
// alternative is trusting that nobody writes `imwrite(tmp)` again, and that
// trust is what cost eight packs.
// Read a source file whole, or fail the test naming the path.
static std::string readSourceOrDie(const std::string& path) {
    std::ifstream f(path);
    EXPECT_TRUE(f.good()) << "cannot read source at " << path;
    if (!f.good()) return std::string();
    std::stringstream ss; ss << f.rdbuf();
    return ss.str();
}

// WHITESPACE-INSENSITIVE, and that is the point.
//
// The first cut of these tripwires compared EXACT strings, which the
// 2026-08-30 review correctly called trivially evadable: a reformat, a
// clang-format pass, or a line break in a different place defeats them without
// changing what the code does — and a guard that a reformat can switch off is
// not a guard.  Squeezing every whitespace character out of both haystack and
// needle removes that whole class of evasion, and it makes the needles
// STRICTLY stronger: the multi-line form
//
//     } catch (const cv::Exception&) {
//     } catch (const std::exception&) {
//     }
//
// squeezes to `...catch(constcv::Exception&){}catch(...` and is therefore
// caught by the same needle as the single-line form.  The exact-string version
// missed it, which is how the identical swallow survived in the ENGINE's tail
// flush while the bridge's was being fixed.
static std::string squeezed(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        if (!std::isspace(c)) out.push_back((char)c);
    }
    return out;
}

TEST(PanoPreviewPublish, TheBridgePublishesThroughTheTestedPathNotCvImwrite) {
    const std::string path = std::string(RNIS_IOS_SRC_DIR) + "/RNISPanoCore.mm";
    const std::string raw = readSourceOrDie(path);
    ASSERT_GT(raw.size(), 1000u);
    const std::string src = squeezed(raw);

    EXPECT_NE(src.find(squeezed("rnis::pano::publishJpegAtomically")),
              std::string::npos)
        << "the bridge no longer publishes the preview through the tested path";

    // The exact shipped line, and the general shape of it.  `imwrite` to a
    // path whose extension is not an image format is the whole bug.
    EXPECT_EQ(src.find(squeezed("stringByAppendingPathExtension:@\"tmp\"")),
              std::string::npos)
        << "the bridge is building an image path with a '.tmp' extension again";
    EXPECT_EQ(src.find(squeezed("cv::imwrite(tmp")), std::string::npos)
        << "the bridge is encoding to a temp path with cv::imwrite again";

    // And the swallow.  A bare `catch (const cv::Exception&) {}` is what turned
    // a throwing write into eleven silent days; every catch in the preview
    // path must say something.
    EXPECT_EQ(src.find(squeezed("catch (const cv::Exception&) {}")),
              std::string::npos)
        << "an empty cv::Exception catch is back in the bridge";
    EXPECT_EQ(src.find(squeezed("catch (const std::exception&) {}")),
              std::string::npos)
        << "an empty std::exception catch is back in the bridge";
}

// THE SAME GUARD ON THE ENGINE, because the bug was there too.
//
// The bridge's swallow was found and fixed while an IDENTICAL one sat in
// `Engine::finish()` — on the path that paints 29-48% of the deliverable on
// the operator's packs — and the exact-string tripwire could not see it,
// because it was multi-line and because it read only the bridge.  A throw
// there dropped the tail of the panorama and set `tailFlushed` false, and
// `tailFlushed` reached no status field, no meta.json key and no summary.
// Both halves of that are now pinned: the catch must name its reason, and the
// outcome must be reportable.
TEST(PanoTailFlush, TheLeadOutCannotGoSilentAgain) {
    // ⚠ The ENGINE, not an iOS file. This used to be spelled
    // RNIS_IOS_SRC_DIR + "/../cpp/rnis_pano.cpp", which only resolved while
    // ios/ and cpp/ were siblings. They are not, so the engine has its own
    // definition.
    const std::string path = std::string(RNIS_ENGINE_SRC_DIR) + "/rnis_pano.cpp";
    const std::string raw = readSourceOrDie(path);
    ASSERT_GT(raw.size(), 1000u);
    const std::string src = squeezed(raw);

    EXPECT_EQ(src.find(squeezed("catch (const cv::Exception&) {}")),
              std::string::npos)
        << "an empty cv::Exception catch is back in the engine";
    EXPECT_EQ(src.find(squeezed("catch (const std::exception&) {}")),
              std::string::npos)
        << "an empty std::exception catch is back in the engine";

    // The reason must be RECORDED, not merely caught.
    EXPECT_NE(src.find(squeezed("st.tailFlushError =")), std::string::npos)
        << "the tail flush catches without recording why";
    EXPECT_NE(src.find(squeezed("st.tailFlushAttempted = true")),
              std::string::npos)
        << "nothing marks that a lead-out was attempted, so a throw is "
           "indistinguishable from a sweep that had no tail to paint";

    // And it must reach the pack + the result screen.
    const std::string bridge =
        squeezed(readSourceOrDie(std::string(RNIS_IOS_SRC_DIR)
                                 + "/RNISPanoCore.mm"));
    EXPECT_NE(bridge.find(squeezed("st.tailFlushError")), std::string::npos)
        << "the bridge does not carry the tail-flush reason anywhere";
    EXPECT_NE(bridge.find(squeezed("@\"tailFlushed\"")), std::string::npos)
        << "the summary does not report whether the lead-out committed";
}

// The counters are not decoration: a CLEAN sweep must report a clean lead-out,
// or `tailFlushAttempted && !tailFlushed` would fire on every good pack and be
// learned-to-ignore within a week — which is how a warning becomes noise.
TEST(PanoTailFlush, ACleanSweepReportsAnAttemptedAndCompletedLeadOut) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    auto cfg = testConfig();
    SweepResult r = runSweep(shelf, linearSweep(200, 20, 120), {}, cfg);

    ASSERT_TRUE(r.stats.axisLatched);
    EXPECT_TRUE(r.stats.tailFlushAttempted)
        << "a latched sweep has a lead-out to paint";
    EXPECT_TRUE(r.stats.tailFlushed)
        << "the lead-out threw: " << r.stats.tailFlushError;
    EXPECT_TRUE(r.stats.tailFlushError.empty()) << r.stats.tailFlushError;
}

// A sweep that never latched has NO lead-out, and that is not a fault.  Without
// this the new result-screen line would cry wolf on every sweep the operator
// abandoned before moving, and the loud string stops being read.
TEST(PanoTailFlush, ASweepThatNeverLatchedReportsNoAttemptRatherThanAFailure) {
    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;

    EXPECT_FALSE(eng.stats().tailFlushAttempted) << "nothing has been swept";
    eng.finish();

    const auto st = eng.stats();
    EXPECT_FALSE(st.axisLatched);
    EXPECT_FALSE(st.tailFlushAttempted)
        << "an unlatched sweep has no tail, and 'no tail' is not 'a lost tail'";
    EXPECT_FALSE(st.tailFlushed);
    EXPECT_TRUE(st.tailFlushError.empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// v11 — A REPEAT FRAME MUST NOT KILL A SWEEP
//
// The 2026-08-30 field recording lost TWO OF THREE sweeps to
// "Sweep stopped — nonmonotonic timestamp", on a session that was concurrently
// dropping 77 and 59 pack writes — i.e. exactly the delivery pressure under
// which a frame arrives twice.  The guard read `tsNs <= lastTsNs` and aborted,
// so a duplicate delivery (dt == 0), which carries no new information and
// costs nothing to ignore, threw away every strip already painted.
//
// A genuinely NEW timebase (an `arSession.run` re-seed) is a different event
// and stays fatal.  These two tests pin the SPLIT, because a fix that skipped
// everything would be as wrong as the abort that killed everything.
// ═══════════════════════════════════════════════════════════════════════════

namespace {

// Drives frames with EXPLICIT timestamps.  `tsOverride[i] != 0` replaces the
// nominal 30 Hz stamp for frame i, which is the whole point of the fixture.
SweepResult runSweepWithStamps(const cv::Mat& shelf,
                               const std::vector<double>& xs,
                               const std::vector<double>& tsOverride,
                               const rnis::pano::Config& cfg) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;

    SweepResult out;
    for (size_t i = 0; i < xs.size(); ++i) {
        const int x0 = (int)std::lround(xs[i]);
        cv::Mat crop = shelf(cv::Rect(x0, 0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);

        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        const double nominal = 1e9 + (double)i * (1e9 / 30.0);
        in.tsNs = (i < tsOverride.size() && tsOverride[i] != 0.0)
                      ? tsOverride[i] : nominal;
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.q[0] = in.q[1] = in.q[2] = 0.0; in.q[3] = 1.0;
        in.t[0] = xs[i] * (0.6 / kFx);
        in.tracking = 2;
        in.seq = (int64_t)i;
        out.rows.push_back(eng.ingest(in));
    }
    out.rows.push_back(eng.finish());
    eng.finalCanvas(out.canvas);
    // Rendered with the SAME `cropPadRows` as the canvas one line up — which
    // is the only argument that can separate the two, and the reason
    // `finalCoverage` takes it at all. See the PanoCoverage block.
    eng.finalCoverage(out.coverage);
    out.stats = eng.stats();
    out.holes = eng.unpaintedRuns();
    out.envelope = eng.verticalEnvelope();
    return out;
}

}  // namespace

TEST(PanoTimestamp, ARepeatedFrameIsSkippedAndTheSweepSurvives) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    auto cfg = testConfig();
    const auto xs = linearSweep(200, 20, 60);

    // Frames 20 and 21 arrive with the SAME stamp as 19 — a duplicate delivery.
    std::vector<double> ts(xs.size(), 0.0);
    const double dup = 1e9 + 19.0 * (1e9 / 30.0);
    ts[20] = dup;
    ts[21] = dup;

    SweepResult r = runSweepWithStamps(shelf, xs, ts, cfg);

    EXPECT_EQ(r.stats.abortReason, "")
        << "a repeat frame ended the sweep: " << r.stats.abortReason;
    EXPECT_TRUE(r.stats.axisLatched);
    EXPECT_EQ(r.stats.skippedNonmonotonicTs, 2)
        << "the skip must be COUNTED, not silently swallowed";
    EXPECT_GT(r.stats.painted, 20)
        << "the sweep kept painting past the duplicate";
}

TEST(PanoTimestamp, ANewTimebaseIsStillFatal) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    auto cfg = testConfig();
    const auto xs = linearSweep(200, 20, 60);

    // Frame 30 restarts the clock a full second in the past — an arSession.run
    // re-seed, not a hiccup.  Fusing two clocks into one chain must stay fatal.
    std::vector<double> ts(xs.size(), 0.0);
    ts[30] = 1e9 + 29.0 * (1e9 / 30.0) - 1.0e9;

    SweepResult r = runSweepWithStamps(shelf, xs, ts, cfg);

    EXPECT_EQ(r.stats.abortReason, "nonmonotonic-timestamp")
        << "a new timebase must abort, not be absorbed as a hiccup";
    EXPECT_EQ(r.stats.skippedNonmonotonicTs, 0)
        << "a timebase reset is not a skip";
}

// ═══════════════════════════════════════════════════════════════════════════
// v11 — THE TWO EVIDENCE FIXES
//
// Neither changes the engine.  Both exist because a measurement that is
// SILENTLY WRONG is worse than one that is missing, and this pack format had
// one of each:
//
//   (a) `subjectDistanceFitM` returned 1.95 / 6.00 / 5.87 m on the three
//       Test-13 field packs against a standoff measured two independent ways
//       at 0.6-1.0 m — 2x to 7.5x wrong on every pack, ON THE CLAMP RAIL on
//       two of them — and nothing reported it, because the fit self-scores.
//   (b) `exposure.rangeRatio = 1.00` was read back off the same
//       `AVCaptureDevice` the lock was asserted on, so it could not answer
//       whether that is the device ARKit streams, nor whether the lock
//       reaches ARKit's pixels.
//
// The tests below are the ones that FAIL on the engine as it stood.
// ═══════════════════════════════════════════════════════════════════════════

/// A STANDOFF-HOLDING sweep: the pose really does creep forward by
/// `poseForwardM`, and the IMAGE does not magnify with it.
///
/// That decoupling is the whole point and it is not a cheat — it is the field
/// regime.  `runApproachSweep` synthesises a geometrically PERFECT dolly, so
/// its estimator is unbiased however small the travel; the field packs fail
/// because the measured cross gradient over 1-13 cm of forward travel is
/// dominated by registration noise rather than by signal, i.e. the pose moves
/// and the image does not say so.  This helper reproduces that regime
/// exactly, with zero instead of noise so the assertion is deterministic.
SweepResult runStandoffHoldSweep(const cv::Mat& shelf, int n, double dxPx,
                                 double poseForwardM, double planeM,
                                 const rnis::pano::Config& cfg) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;

    SweepResult out;
    const double x0ref = 900.0, y0ref = 900.0;
    for (int i = 0; i < n; ++i) {
        const double z = poseForwardM * (double)i / (double)std::max(1, n - 1);
        const int cx0 = (int)std::lround(x0ref + dxPx * (double)i);
        const int cy0 = (int)std::lround(y0ref);
        cv::Mat crop = shelf(cv::Rect(cx0, cy0, kFrameW, kFrameH)).clone();

        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);

        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.t[0] = (x0ref + dxPx * (double)i) * (planeM / kFx);
        in.t[1] = y0ref * (planeM / kFy);
        in.t[2] = -z;                       // GL: forward is -Z
        in.tracking = 2;
        in.seq = (int64_t)i;
        out.rows.push_back(eng.ingest(in));
    }
    out.rows.push_back(eng.finish());
    eng.finalCanvas(out.canvas);
    // Rendered with the SAME `cropPadRows` as the canvas one line up — which
    // is the only argument that can separate the two, and the reason
    // `finalCoverage` takes it at all. See the PanoCoverage block.
    eng.finalCoverage(out.coverage);
    out.stats = eng.stats();
    out.holes = eng.unpaintedRuns();
    out.envelope = eng.verticalEnvelope();
    return out;
}

// THE FIELD REGIME, reproduced.  Holding standoff is the POINT of a shelf
// sweep, so the only regressor this estimator has barely moves — and the pack
// used to publish the resulting number with no way to tell it apart from a
// measurement.
TEST(PanoSubjectDistanceEvidence, AStandoffHoldingSweepIsReportedAsDegenerate) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    // 120 frames x 12 px at 0.6 m/1400 px = 0.61 m across the shelf, against
    // 1 cm of forward creep: 1.7%, squarely inside the field packs' measured
    // 1.0% / 11.2% / 5.1%.
    SweepResult r = runStandoffHoldSweep(shelf, 120, 12.0, 0.01, 0.6, testConfig());

    ASSERT_TRUE(r.stats.axisLatched);
    ASSERT_GT(r.stats.subjectDistanceFitSamples, 40)
        << "the fit never sampled — this fixture is not exercising it";

    // THE LEVERAGE, which is the whole finding.
    EXPECT_LT(r.stats.subjectDistanceFitFwdSpanM, 0.02);
    EXPECT_GT(r.stats.subjectDistanceFitPerpSpanM, 0.40);
    EXPECT_GT(r.stats.subjectDistanceFitLeverRatio, 0.0);
    EXPECT_LT(r.stats.subjectDistanceFitLeverRatio,
              rnis::pano::kSubjectDistanceFitLeverBar);
    EXPECT_TRUE(r.stats.subjectDistanceFitDegenerate)
        << "forward travel was " << r.stats.subjectDistanceFitFwdSpanM
        << " m against " << r.stats.subjectDistanceFitPerpSpanM
        << " m perpendicular and the pack still calls the fit trustworthy";

    // THE DENOMINATOR the brief asked for, which is the conditioning of the
    // whole estimate.  Sum fwd^2 over ~120 frames of <=1 cm each is <1e-2 m^2.
    EXPECT_LT(r.stats.subjectDistanceFitDen, 1e-2);
    EXPECT_GE(r.stats.subjectDistanceFitDen, 0.0);
}

// SATURATION MUST BE VISIBLE.  A clamped 6.00 and a genuine 6.00 are the same
// field without the raw value, and TWO of the three field packs shipped the
// clamped one.
TEST(PanoSubjectDistanceEvidence, AClampedFitCarriesItsRawValueAndSaysItIsARail) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    // Enough forward creep to open the den > 1e-6 guard, with an image that
    // reports no magnification for it — so the ratio runs away exactly as it
    // does in the field.
    SweepResult r = runStandoffHoldSweep(shelf, 120, 12.0, 0.05, 0.6, testConfig());

    ASSERT_TRUE(r.stats.axisLatched);
    ASSERT_GT(r.stats.subjectDistanceFitM, 0.0) << "the fit never ran";
    ASSERT_TRUE(r.stats.subjectDistanceFitSaturated)
        << "fit=" << r.stats.subjectDistanceFitM
        << " raw=" << r.stats.subjectDistanceFitRawM
        << " — this fixture no longer saturates, so it cannot test saturation";

    // The shipped value IS the rail, and the raw value proves it.
    EXPECT_DOUBLE_EQ(r.stats.subjectDistanceFitM, 6.0);
    EXPECT_GT(r.stats.subjectDistanceFitRawM, 6.0);
    EXPECT_GT(r.stats.subjectDistanceFitClampedUpdates, 0);
    // ...and the placement really did run on it, which is a separate fact
    // from "the fit produced it".
    EXPECT_TRUE(r.stats.subjectDistanceFitInForce);
    EXPECT_DOUBLE_EQ(r.stats.subjectDistanceUsedM, r.stats.subjectDistanceFitM);
}

// THE CRY-WOLF GUARD.  A diagnostic that fires on a healthy sweep is learned
// to be ignored inside a week, and then it is worse than nothing.  This is
// the same geometrically-honest dolly the cross-sweep tests use, where the
// estimator recovers the 0.6 m plane.
TEST(PanoSubjectDistanceEvidence, AHealthyDollyIsNeitherSaturatedNorDegenerate) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    SweepResult r = runApproachSweep(shelf, 120, 12.0, 0.26, 0.6, testConfig());

    ASSERT_TRUE(r.stats.axisLatched);
    ASSERT_GT(r.stats.subjectDistanceFitM, 0.0) << "the online fit never ran";

    EXPECT_FALSE(r.stats.subjectDistanceFitSaturated)
        << "raw=" << r.stats.subjectDistanceFitRawM;
    EXPECT_FALSE(r.stats.subjectDistanceFitDegenerate)
        << "fwdSpan=" << r.stats.subjectDistanceFitFwdSpanM
        << " perpSpan=" << r.stats.subjectDistanceFitPerpSpanM
        << " lever=" << r.stats.subjectDistanceFitLeverRatio;
    EXPECT_GT(r.stats.subjectDistanceFitLeverRatio,
              rnis::pano::kSubjectDistanceFitLeverBar);
    EXPECT_GT(r.stats.subjectDistanceFitDen, 1e-6);
}

// THE DIAGNOSTIC MUST DESCRIBE THE SHIPPED NUMBER, not a parallel one.  If a
// later edit ever changed the clamp, or measured the raw ratio off a
// different accumulator, this catches it — the published pair would stop
// being consistent with each other.
TEST(PanoSubjectDistanceEvidence, TheRawValueClampsExactlyOntoTheShippedFit) {
    const cv::Mat shelf = makeShelf(6000, 2600);
    for (double fwd : {0.26, 0.05}) {
        SweepResult r = (fwd > 0.1)
            ? runApproachSweep(shelf, 120, 12.0, fwd, 0.6, testConfig())
            : runStandoffHoldSweep(shelf, 120, 12.0, fwd, 0.6, testConfig());
        ASSERT_GT(r.stats.subjectDistanceFitM, 0.0) << "fwd=" << fwd;
        const double clamped =
            std::max(0.3, std::min(6.0, r.stats.subjectDistanceFitRawM));
        EXPECT_DOUBLE_EQ(r.stats.subjectDistanceFitM, clamped)
            << "the reported raw value does not clamp onto the shipped fit "
               "(fwd=" << fwd << ")";
        EXPECT_EQ(r.stats.subjectDistanceFitSaturated,
                  r.stats.subjectDistanceFitRawM < 0.3 ||
                  r.stats.subjectDistanceFitRawM > 6.0);
    }
}

// ── v11 (b): ARKit'S OWN EXPOSURE ──────────────────────────────────────────

// THE PARITY CLAUSE, and the one that matters most: ARKit's exposure is
// EVIDENCE.  Supplying it must not move one canvas pixel, one ledger row or
// the verdict — otherwise it is a control input wearing a report's clothes.
TEST(PanoArExposure, SupplyingArKitsExposureChangesNoPixelAndNoVerdict) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    auto cfg = testConfig();

    SweepSpec base;
    base.xs = linearSweep(200, 20, 90);
    base.expDur.assign(base.xs.size(), 1.0 / 60.0);
    base.expISO.assign(base.xs.size(), 150.0);

    SweepSpec withAr = base;
    withAr.arExpDur.assign(base.xs.size(), 1.0 / 60.0);
    withAr.arExpEV.assign(base.xs.size(), -0.25);
    withAr.arExpHave.assign(base.xs.size(), 1);

    SweepResult a = runSweepSpec(shelf, base, cfg);
    SweepResult b = runSweepSpec(shelf, withAr, cfg);

    ASSERT_FALSE(a.canvas.empty());
    ASSERT_EQ(a.canvas.size(), b.canvas.size());
    EXPECT_EQ(cv::norm(a.canvas, b.canvas, cv::NORM_INF), 0.0)
        << "the canvas moved when only the AR exposure metadata changed";
    ASSERT_EQ(a.rows.size(), b.rows.size());
    for (size_t i = 0; i < a.rows.size(); ++i) {
        EXPECT_EQ(a.rows[i].outcome, b.rows[i].outcome) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].advanceTotX, b.rows[i].advanceTotX) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].advanceTotY, b.rows[i].advanceTotY) << "row " << i;
        EXPECT_DOUBLE_EQ(a.rows[i].expGain, b.rows[i].expGain) << "row " << i;
    }
    EXPECT_EQ(a.stats.integrityFailed, b.stats.integrityFailed);
    EXPECT_DOUBLE_EQ(a.stats.exposureRangeRatio, b.stats.exposureRangeRatio);
    EXPECT_DOUBLE_EQ(a.stats.gainCumEnd, b.stats.gainCumEnd);

    // ...and the evidence really was recorded on the arm that supplied it.
    EXPECT_EQ(a.stats.arExposureFrames, 0);
    EXPECT_GT(b.stats.arExposureFrames, 40);
    EXPECT_DOUBLE_EQ(b.stats.arExposureRangeRatio, 1.0);
    EXPECT_DOUBLE_EQ(b.stats.arExposureOffsetMinEV, -0.25);
    EXPECT_DOUBLE_EQ(b.stats.arExposureOffsetMaxEV, -0.25);
}

// ABSENCE IS UNKNOWN, NEVER ZERO.  `arExposureFrames == 0` with a ratio of
// 1.00 is the "we could not read it" case and must be distinguishable from a
// locked sweep, exactly as the v6 device trace already is.
//
// SCOPE, so this is not over-read: this is the ONE test in this block that
// passes vacuously on an engine with the whole v11 trace neutered — it
// asserts an ABSENCE, and an engine that records nothing also produces one.
// It is a REGRESSION GUARD against a future edit that starts writing 0.0 into
// the trace for an unread frame (which would read as "a completely dark
// camera, locked"), not evidence that the trace works.  The four tests around
// it are the ones that go red without the implementation.
TEST(PanoArExposure, AnUnreadableArExposureIsRecordedAsUnknownNotAsZero) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 60);
    spec.expDur.assign(spec.xs.size(), 1.0 / 60.0);
    spec.expISO.assign(spec.xs.size(), 150.0);
    // The plugin could not reach ARKit's camera: the values are present but
    // flagged invalid, which is what a nil sample forwards as.
    spec.arExpDur.assign(spec.xs.size(), 0.0);
    spec.arExpEV.assign(spec.xs.size(), 0.0);
    spec.arExpHave.assign(spec.xs.size(), 0);

    SweepResult r = runSweepSpec(shelf, spec, testConfig());

    EXPECT_EQ(r.stats.arExposureFrames, 0);
    EXPECT_EQ(r.stats.arVsDevicePairedFrames, 0);
    EXPECT_DOUBLE_EQ(r.stats.arExposureMinS, 0.0);
    EXPECT_DOUBLE_EQ(r.stats.arExposureMaxS, 0.0);
    EXPECT_DOUBLE_EQ(r.stats.arExposureRangeRatio, 1.0);
    EXPECT_DOUBLE_EQ(r.stats.arVsDeviceMaxAbsDeltaS, 0.0);
    // The DEVICE trace is untouched by the AR side being unreadable.
    EXPECT_GT(r.stats.exposureMetaFrames, 40);
}

// THE DEVICE-IDENTITY CHECK, which is the half the pack could not do at all.
// A lock asserted on the WRONG AVCaptureDevice shows up here as a large
// relative delta — and nowhere else, because reading our own device back
// agrees with itself by construction.
TEST(PanoArExposure, ADisagreeingDeviceIsVisibleInThePairedDelta) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);

    SweepSpec agree;
    agree.xs = linearSweep(200, 20, 60);
    agree.expDur.assign(agree.xs.size(), 1.0 / 60.0);
    agree.expISO.assign(agree.xs.size(), 150.0);
    agree.arExpDur.assign(agree.xs.size(), 1.0 / 60.0);
    agree.arExpEV.assign(agree.xs.size(), 0.0);
    agree.arExpHave.assign(agree.xs.size(), 1);

    SweepSpec disagree = agree;
    // ARKit says 1/30 s while the device we locked says 1/60 s: two different
    // cameras, or a lock that never reached the stream.
    disagree.arExpDur.assign(disagree.xs.size(), 1.0 / 30.0);

    SweepResult a = runSweepSpec(shelf, agree, testConfig());
    SweepResult d = runSweepSpec(shelf, disagree, testConfig());

    ASSERT_GT(a.stats.arVsDevicePairedFrames, 40);
    ASSERT_GT(d.stats.arVsDevicePairedFrames, 40);
    EXPECT_NEAR(a.stats.arVsDeviceMaxRelDelta, 0.0, 1e-12)
        << "the same exposure on both sides must read as agreement";
    EXPECT_NEAR(d.stats.arVsDeviceMaxRelDelta, 1.0, 1e-9)
        << "a 2x disagreement between ARKit and the locked device is invisible";
    EXPECT_NEAR(d.stats.arVsDeviceMaxAbsDeltaS, 1.0 / 60.0, 1e-9);
    // Neither arm's DEVICE-side trace moved: the AR reading is not feeding it.
    EXPECT_DOUBLE_EQ(a.stats.exposureRangeRatio, d.stats.exposureRangeRatio);
}

// AN AE LOCK THAT DID NOT REACH ARKit'S PIXELS.  The device trace is flat (we
// locked our object and it held) while ARKit's own exposure sweeps — which is
// precisely the failure `exposure.rangeRatio` structurally cannot see.
TEST(PanoArExposure, ADriftingArExposureIsVisibleWhileTheDeviceTraceIsFlat) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    SweepSpec spec;
    spec.xs = linearSweep(200, 20, 60);
    const size_t n = spec.xs.size();
    spec.expDur.assign(n, 1.0 / 60.0);      // the locked device: constant
    spec.expISO.assign(n, 150.0);
    spec.arExpDur.resize(n);
    spec.arExpEV.resize(n);
    spec.arExpHave.assign(n, 1);
    for (size_t i = 0; i < n; ++i) {
        // ARKit's own exposure drifts 1.5x across the sweep.
        spec.arExpDur[i] = (1.0 / 60.0) * (1.0 + 0.5 * (double)i / (double)(n - 1));
        spec.arExpEV[i] = -0.5 + (double)i / (double)(n - 1);
    }

    SweepResult r = runSweepSpec(shelf, spec, testConfig());

    EXPECT_DOUBLE_EQ(r.stats.exposureRangeRatio, 1.0)
        << "the device trace should be flat — that is the circular reading";
    EXPECT_NEAR(r.stats.arExposureRangeRatio, 1.5, 1e-9)
        << "ARKit's own exposure swept and the pack still reports it as held";
    EXPECT_NEAR(r.stats.arExposureOffsetMinEV, -0.5, 1e-12);
    EXPECT_NEAR(r.stats.arExposureOffsetMaxEV, 0.5, 1e-12);
    EXPECT_GT(r.stats.arVsDeviceMaxRelDelta, 0.4);
}

// ── OPTION C — FORCE REPLACEMENT OF THE PROVISIONAL LEAD-IN ─────────────────
//
// WHAT THE FLAG IS AIMED AT, AND WHAT IT IS NOT.  The bootstrap paints the
// reference frame's WHOLE footprint and sets the frontier to its CENTRE, so
// half a footprint is painted but unswept.  An owner map over the delivered
// canvas of the operator's 16 packs says two things about that band, and only
// the second is a defect:
//
//   * every canvas COLUMN ahead of the seed centre is already repainted — the
//     seed keeps ZERO of them, because `paintLeft = max(highWater, fu0)` puts
//     each strip's left edge AT the frontier and the frontier starts at the
//     centre.  The premise that strips "skip" the lead-in is false, and this
//     flag cannot and does not fix it;
//   * the band survives ACROSS the sweep axis.  A later strip repaints the
//     seed's columns only over the rows its own warp mask covers, so where the
//     hand has drifted perpendicular the seed's rows at the cross extreme are
//     never covered again — the "un-replaced provisional remnant" of the v6.7
//     design note, 0.36 % of the primary pack and 0.88 ± 0.18 % (n = 16) across
//     the set, standing against content a median of 182 frames newer.
//
// So these tests pin a SMALL, BOUNDED effect and the invariants that keep it
// small: ownership must fall, and nothing about the strip chain may move.  A
// test here that claimed a large ownership win would be measuring something
// this change does not do.
//
// ⚠ AND ONE INVARIANT THAT WAS MISSING, which is why the fill is the shape it
// is.  The first cut let EVERY painted frame repaint the whole remaining band.
// Ownership inside it then belonged to whichever warp mask reached each pixel
// LAST — the mask's ragged cross-axis edge, not the sweep — so adjacent pixels
// came from frames hundreds apart.  Measured on the operator's 12 same-raster
// packs over exactly the 60 878 px the flag took back from the seed: distinct
// owners 1 -> up to 163, owner-boundary density 0.10 -> 0.87 per px, local
// |Laplacian| 26 -> 73 DN, rougher on 12/12 packs, and visibly a comb at 4x.
// The band stopped being stale and became an artefact.  The fill now runs
// STRICTLY FORWARD (`Impl::leadFillU`), so a column is filled once and every row
// of it has one owner; `TheFillIsSingleOwnerBecauseItRunsStrictlyForward` is
// that rule, written as the inequality the ledger can carry.
//
// RED FIRST, and the controls are named because two different ones were needed:
//
//   control A — `leadEndU = -1.0` forced at the seed (feature off, nothing else)
//   control B — the REVIEWED first cut, i.e. the repaint-every-frame design
//   control C — `leadArcSeeded = false` forced (arc branch off, nothing else)
//
//   …RepaintsTheProvisionalLeadInAndThenStops     FAILS on A (0 repaint strips)
//   …TakesDeliveredPixelsBackFromTheSeedFrame     FAILS on A (204 444 ==
//                                                 204 444; green 204 444 ->
//                                                 197 280)
//   …TheFillIsSingleOwnerBecauseItRunsStrictlyForward
//                                                 FAILS on B (3 329 px
//                                                 committed over a 360 px band
//                                                 in 23 commits)
//   …TheCountersAreReBasedByARelatch              FAILS on B (session counter
//                                                 still carries pre-relatch
//                                                 fills)
//   …LeavesTheGeometryChainAndTheFrontierUntouched PASSES everywhere — it is the
//   …ThereIsNothingToTakeBackWithoutPerpendicular… GUARD, and all four are named
//   …IsOffByDefaultAndCostsNothingWhenOff          as such.
//   …TheChainedGainMovesOnlyBecauseItSamples…      PASSES — a BOUND.
//   …TheLedgerAreaScaleDescribesEveryPixel…        PASSES on B TOO at this
//                                                 fixture's field: it is the
//                                                 pack measurement (session max
//                                                 4.298 -> 5.360 with no row
//                                                 moving) that has the teeth.
//   …TheFillIsNotGrosslyMisplaced                 PASSES on C TOO (11 DN vs
//                                                 10 DN) — see its own ⚠.
//
namespace {

/// The frame the engine adopted as its reference — the one the bootstrap block
/// was painted from.  Read off the ledger rather than assumed to be frame 0:
/// the reference is latched after the tracking warm-up and the motion vote.
int64_t bootstrapSeq(const SweepResult& r) {
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::Bootstrap) return row.seq;
    return -1;
}

double totalLeadRepaintPx(const SweepResult& r) {
    double t = 0.0;
    for (const auto& row : r.rows) t += row.leadRepaintPx;
    return t;
}

/// AN OWNER MAP FOR ONE FRAME, built out of the engine's own paint path.
///
/// Run the sweep with the seed frame's PIXELS replaced by a flat sentinel and
/// count how much of the delivered canvas still carries it.  That is exactly
/// "how many delivered pixels does the bootstrap frame still own", measured on
/// the deliverable, with no instrumentation inside the engine to be wrong
/// about — and the caller checks that the sentinel does not occur naturally
/// (`sentinelFreeCount` below), so a count can never be an artefact of the
/// shelf's own colours.
///
/// Only `in.bgr` is tinted; `in.grayWork` still comes from the untinted crop,
/// so registration, the motion vote and every placement decision are bit-for-
/// bit the sweep the other arm ran.  `gainMatch` is off in the fixture so the
/// sentinel survives the commit unscaled.
int seedTintOwnedPixels(const cv::Mat& shelf, const ProjSweepSpec& s,
                        const rnis::pano::Config& cfg, int64_t tintSeq,
                        const cv::Vec3b& sentinel, cv::Mat* canvasOut) {
    rnis::pano::Engine eng;
    std::string err;
    EXPECT_TRUE(eng.configure(cfg, &err)) << err;

    const double x0ref = 1400.0, y0ref = 1400.0;
    for (int i = 0; i < s.n; ++i) {
        const double f = (double)i / (double)std::max(1, s.n - 1);
        const double x0 = x0ref + s.dx * (double)i;
        const double y0 = y0ref + s.dy * (double)i;
        const Quat q = (std::fabs(s.pitchDeg) > 1e-12)
                           ? pitchQuat(s.pitchDeg * f) : identityQuat();
        cv::Mat crop = renderProjectedFrame(shelf, x0, y0, q);
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        if ((int64_t)i == tintSeq) crop.setTo(cv::Scalar(sentinel));

        rnis::pano::FrameInput in;
        in.bgr = &crop;
        in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        for (int k = 0; k < 4; ++k) in.q[k] = q[k];
        in.t[0] = x0 * (0.6 / kFx);
        in.t[1] = y0 * (0.6 / kFy);
        in.tracking = 2;
        in.seq = (int64_t)i;
        eng.ingest(in);
    }
    eng.finish();
    cv::Mat canvas;
    EXPECT_TRUE(eng.finalCanvas(canvas));
    if (canvasOut) *canvasOut = canvas.clone();
    if (canvas.empty()) return -1;

    int n = 0;
    for (int y = 0; y < canvas.rows; ++y) {
        const cv::Vec3b* p = canvas.ptr<cv::Vec3b>(y);
        for (int x = 0; x < canvas.cols; ++x)
            if (p[x] == sentinel) ++n;
    }
    return n;
}

/// The fixture: a horizontal sweep that also DRIFTS perpendicular, because a
/// remnant is by construction a cross-axis phenomenon.  A drift-free synthetic
/// has every frame covering the same rows, so the seed is repainted everywhere
/// and there is nothing for Option C to take back — measured, not assumed
/// (`ThereIsNothingToTakeBackWithoutPerpendicularDrift` pins it).
ProjSweepSpec leadInSweep(double dyPerFrame) {
    ProjSweepSpec s;
    s.n  = 70;
    s.dx = 26.0;
    s.dy = dyPerFrame;
    return s;
}

/// THE SHIPPED PHOTOMETRY, deliberately — `gainMatch` stays ON.
///
/// ⚠ THIS DEFAULT WAS WRONG IN THE FIRST CUT OF THIS BLOCK, and the mistake is
/// worth recording because it is the exact shape this suite exists to catch.
/// Turning `gainMatch` off (which the sentinel probe below genuinely needs)
/// made the "chain untouched" test below assert `gainCum` equality against a
/// chain that was not running: it passed, vacuously, while on the operator's
/// 16 real packs `gainCum` DOES move — by 0.30 % at the median and 1.65 % at
/// the worst.  A test that would have said so is worth more than one that
/// says nothing loudly, so the chain test now runs the shipped photometry and
/// asserts only what is actually true (the GEOMETRY chain), and
/// `TheChainedGainMovesOnlyBecauseItSamplesRepaintedCanvas` states the rest.
rnis::pano::Config leadInConfig(bool leadReplace) {
    auto c = testConfig();
    c.leadReplace = leadReplace;
    // ⚠ PINNED OFF, and not to make these pass.  Every claim in this block is
    // Option C measured AGAINST THE UNTRIMMED SEED — "takes delivered pixels
    // back from the seed frame", "the fill lands where the seed's content
    // is".  `seedLeadTrim` (default ON since 2026-09-23) removes that same
    // remnant at finish by CLEARING it, in both arms, so with it on the
    // control arm has no remnant to compare against: the ownership probe read
    // 194400 -> 194400 and the misplacement bar compared fill content against
    // black (128 DN).  The two mechanisms answer one question two ways
    // (repaint vs clear); how they compose is pinned separately, in
    // PanoSeedLeadTrim.OptionCRepaintsWhatTheTrimWouldOtherwiseClear.
    c.seedLeadTrim = false;
    return c;
}

/// A PIVOT that also drifts perpendicular.  Two things at once, both needed:
/// the pitch is what arms the ARC seed (`maxRectifyDeg > 0`), and the drift is
/// what leaves a cross-axis remnant for the fill to have anything to do.  The
/// translation fixture above cannot reach the arc branch at all — a pure dolly
/// leaves `maxRectifyDeg == 0`, the seed is a single tangent block, and the
/// fill correctly follows it there.
ProjSweepSpec leadInPivotSweep() {
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = -18.0;
    // `dx`, not `dy`: pitch and `dy` are COLLINEAR (the suite's own "mixed
    // collinear" fixtures pair them), so on a pivot the CROSS axis is x.  With
    // `dy` here the sweep drifts along itself, there is no remnant, and the
    // fixture silently tests nothing — measured: the fill fired and changed 0
    // delivered pixels.
    s.dx = 4.0;
    return s;
}

/// Median |ΔY| over the pixels two canvases actually disagree on, and the count.
/// Restricted to the disagreement because the panorama is overwhelmingly
/// identical between the arms and a median over the whole frame would read 0
/// however badly the changed part was placed.
std::pair<double, int> medianChangedDN(const cv::Mat& a, const cv::Mat& b) {
    if (a.size() != b.size() || a.empty()) return {-1.0, 0};
    cv::Mat ga, gb;
    cv::cvtColor(a, ga, cv::COLOR_BGR2GRAY);
    cv::cvtColor(b, gb, cv::COLOR_BGR2GRAY);
    std::vector<int> d;
    for (int y = 0; y < ga.rows; ++y)
        for (int x = 0; x < ga.cols; ++x) {
            const int v = std::abs((int)ga.at<uchar>(y, x) - (int)gb.at<uchar>(y, x));
            if (v > 0) d.push_back(v);
        }
    if (d.empty()) return {0.0, 0};
    std::nth_element(d.begin(), d.begin() + d.size() / 2, d.end());
    return {(double)d[d.size() / 2], (int)d.size()};
}

/// The SENTINEL PROBE's config, and the one place `gainMatch` may be off: a
/// flat sentinel scaled by a chained gain is no longer the sentinel, so the
/// probe cannot count it.  The probe measures OWNERSHIP, which the gain does
/// not move (it scales pixels, it does not decide who wrote them).
rnis::pano::Config leadInProbeConfig(bool leadReplace) {
    auto c = leadInConfig(leadReplace);
    c.gainMatch = false;
    return c;
}

}  // namespace

// THE LAW: while any of the provisional band is left, each painted frame fills
// the part of it AHEAD of both water marks — and once the band is covered it
// STOPS, for the rest of the sweep.  The stopping half is not decoration:
// without it the flag costs an extra warp per frame for hundreds of frames and
// buys nothing, since there is no provisional canvas left to replace.
TEST(PanoLeadReplace, RepaintsTheProvisionalLeadInAndThenStops) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);

    SweepResult off = runProjectedSweep(shelf, s, leadInConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, leadInConfig(true));

    ASSERT_TRUE(on.stats.axisLatched);
    ASSERT_EQ(on.stats.relatchCount, 0)
        << "a relatch re-seeds the canvas and re-arms the band — this fixture "
           "must not have one, or the prefix law below is not the law";

    EXPECT_EQ(off.stats.leadRepaintStrips, 0)
        << "the flag is OFF: nothing may repaint";
    EXPECT_DOUBLE_EQ(off.stats.leadRepaintPx, 0.0);
    EXPECT_DOUBLE_EQ(totalLeadRepaintPx(off), 0.0);

    EXPECT_GT(on.stats.leadRepaintStrips, 0)
        << "the flag is ON and the seed painted half a footprint ahead of the "
           "frontier — something must have repainted it";
    EXPECT_GT(on.stats.leadRepaintPx, 0.0);
    EXPECT_NEAR(totalLeadRepaintPx(on), on.stats.leadRepaintPx, 1e-9)
        << "the per-row ledger and the session counter must be the same fact";

    // SPENT, and spent as a PREFIX of the painted rows: the band is consumed
    // from the front, so once a painted row repaints nothing, no later one may.
    bool spent = false;
    int painted = 0, repainting = 0;
    for (const auto& row : on.rows) {
        if (row.outcome != rnis::pano::Outcome::Painted) continue;
        ++painted;
        if (row.leadRepaintPx > 0.0) {
            ++repainting;
            EXPECT_FALSE(spent)
                << "row seq " << row.seq << " repainted after the band was "
                << "already spent — leadEndU was not cleared";
        } else {
            spent = true;
        }
    }
    EXPECT_TRUE(spent) << "the band must be exhausted before the sweep ends";
    EXPECT_LT(repainting, painted)
        << "a flag that repaints on EVERY painted frame has not stopped";
}

// THE OWNERSHIP CLAIM, measured on the deliverable and deliberately stated as
// a DIRECTION rather than a size.  Option C takes delivered pixels back from
// the seed frame; how many is a property of how far the hand drifted, and on
// the operator's packs it is 0.024-2.548 % of the canvas.  A test that pinned
// a number here would be pinning this fixture's drift.
TEST(PanoLeadReplace, TakesDeliveredPixelsBackFromTheSeedFrame) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);
    const cv::Vec3b kSentinel(0, 255, 0);

    const SweepResult probe = runProjectedSweep(shelf, s, leadInConfig(false));
    const int64_t seed = bootstrapSeq(probe);
    ASSERT_GE(seed, 0) << "no bootstrap row — the sweep never latched";

    // THE INSTRUMENT'S OWN CONTROL: with nothing tinted the sentinel must not
    // occur at all, or every count below is partly the shelf's own colours.
    cv::Mat untinted;
    const int natural = seedTintOwnedPixels(shelf, s, leadInProbeConfig(false),
                                            /*tintSeq=*/-1, kSentinel,
                                            &untinted);
    ASSERT_EQ(natural, 0)
        << "the sentinel occurs naturally in this shelf — pick another";

    cv::Mat cOff, cOn;
    const int ownedOff = seedTintOwnedPixels(shelf, s, leadInProbeConfig(false),
                                             seed, kSentinel, &cOff);
    const int ownedOn  = seedTintOwnedPixels(shelf, s, leadInProbeConfig(true),
                                             seed, kSentinel, &cOn);

    ASSERT_GT(ownedOff, 0)
        << "the seed owns nothing even with the flag off — the probe is not "
           "measuring what it claims to";
    EXPECT_LT(ownedOn, ownedOff)
        << "seed-owned delivered pixels: " << ownedOff << " -> " << ownedOn;
}

// The COMPLEMENT of the test above, and the reason it needs its own name: with
// no perpendicular drift there is no remnant, and Option C correctly does
// nothing to ownership.  Keeping this explicit stops the next reader reading
// the ownership test as "the flag always wins".
TEST(PanoLeadReplace, ThereIsNothingToTakeBackWithoutPerpendicularDrift) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(0.0);
    const cv::Vec3b kSentinel(0, 255, 0);

    const SweepResult probe = runProjectedSweep(shelf, s, leadInConfig(false));
    const int64_t seed = bootstrapSeq(probe);
    ASSERT_GE(seed, 0);

    const int ownedOff = seedTintOwnedPixels(shelf, s, leadInProbeConfig(false),
                                             seed, kSentinel, nullptr);
    const int ownedOn  = seedTintOwnedPixels(shelf, s, leadInProbeConfig(true),
                                             seed, kSentinel, nullptr);
    EXPECT_EQ(ownedOn, ownedOff)
        << "a drift-free sweep repaints every seed row already; Option C must "
           "have nothing left to take (" << ownedOff << " -> " << ownedOn << ")";
}

// THE GEOMETRY CHAIN IS UNTOUCHED — outcome for outcome, span for span.  The
// repaint is a second, NON-ADVANCING commit: it may not move the frontier, may
// not re-fit the gain, and may not touch the ledger row of the strip it rides
// on.  That is what keeps PER-COLUMN ownership identical arm to arm, which is
// in turn why this change cannot damage the swept part of the panorama.
//
// It is also the assertion that fails if the repaint is placed ABOVE the row's
// seam/gain read-out instead of below it: `commitStrip` overwrites `lastSeam*`
// and returns its own committed span on every call.
//
// It says nothing about the PHOTOMETRIC chain, and that is not an omission —
// see the test after it.  Verified against the operator's 16 packs: across
// 5 543 ledger rows the only fields that differ between the arms are
// `gainCum`, `gainStep`, `photoScale` and the five `seam*` measurements.
// `outcome`, `posU`, `highWater`, `canvasX0`, `canvasX1`, `gapPx`,
// `backfillPx` and `areaScale` are identical on every row of every pack.
TEST(PanoLeadReplace, LeavesTheGeometryChainAndTheFrontierUntouched) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);

    SweepResult off = runProjectedSweep(shelf, s, leadInConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, leadInConfig(true));

    ASSERT_EQ(off.rows.size(), on.rows.size());
    for (size_t i = 0; i < off.rows.size(); ++i) {
        const auto& a = off.rows[i];
        const auto& b = on.rows[i];
        ASSERT_EQ((int)a.outcome, (int)b.outcome) << "row " << i;
        EXPECT_EQ(a.seq, b.seq) << "row " << i;
        EXPECT_DOUBLE_EQ(a.posU, b.posU) << "row " << i;
        EXPECT_DOUBLE_EQ(a.highWater, b.highWater) << "row " << i;
        EXPECT_DOUBLE_EQ(a.canvasX0, b.canvasX0) << "row " << i;
        EXPECT_DOUBLE_EQ(a.canvasX1, b.canvasX1) << "row " << i;
    }
    EXPECT_EQ(off.stats.painted, on.stats.painted);
    EXPECT_EQ(off.stats.paintedW, on.stats.paintedW);
    EXPECT_EQ((int)off.holes.size(), (int)on.holes.size())
        << "a repaint may never open a hole — it only ever writes pixels";
}

// The flag is OFF by default, and OFF means the deliverable is the deliverable
// that shipped.  In-suite this can only be the weak half of the claim (the
// default config and an explicitly-false one agree); the strong half is the
// SHA-256 of the delivered canvas on the operator's own packs, which is a
// replay result and is reported there.
TEST(PanoLeadReplace, IsOffByDefaultAndCostsNothingWhenOff) {
    rnis::pano::Config fresh;
    EXPECT_FALSE(fresh.leadReplace) << "Option C must ship OFF";

    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);
    SweepResult dflt = runProjectedSweep(shelf, s, testConfig());
    SweepResult expl = runProjectedSweep(shelf, s, [] {
        auto c = testConfig();
        c.leadReplace = false;
        return c;
    }());
    ASSERT_FALSE(dflt.canvas.empty());
    EXPECT_EQ(fnv1aPixels(dflt.canvas), fnv1aPixels(expl.canvas));
    EXPECT_EQ(dflt.stats.leadRepaintStrips, 0);
}

// ── THE SINGLE-OWNER RULE, and the defect it was written against ────────
//
// THE FIRST CUT OF THIS FLAG LET EVERY PAINTED FRAME REPAINT THE WHOLE
// REMAINING BAND.  Each provisional column was then written dozens of times and
// a surviving pixel's owner was whichever warp mask reached it LAST — the mask's
// ragged cross-axis edge, not the sweep.  Measured on the operator's 12
// same-raster packs, over exactly the 60 878 px the flag took back from the
// seed: distinct owners 1 -> up to 163, owner-boundary density 0.10 -> 0.87 per
// pixel, local |Laplacian| 26 -> 73 DN, rougher on 12/12.  The band stopped
// being stale and became a comb, and a comb is worse: it is visible.
//
// The rule that fixes it is that the fill runs STRICTLY FORWARD, so a column is
// filled once and every row of it has the same owner.  This test states that as
// the inequality the ledger can actually carry: the fills are disjoint, so their
// widths SUM to no more than the band.  Under the old design the same sum is the
// band times the number of painted frames that saw it (34 348 px against a 360 px
// band on the operator's primary pack — two orders of magnitude out).
TEST(PanoLeadReplace, TheFillIsSingleOwnerBecauseItRunsStrictlyForward) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    // BOTH LAWS.  The translation fixture takes the single block, the pivot
    // takes the arc slices (26 of them, measured); the rule is the same rule
    // and a bound that only held on one of them would not be the rule.
    for (const ProjSweepSpec& s : {leadInSweep(4.0), leadInPivotSweep()}) {
    SweepResult on = runProjectedSweep(shelf, s, leadInConfig(true));
    ASSERT_TRUE(on.stats.axisLatched);
    ASSERT_EQ(on.stats.relatchCount, 0) << "a relatch re-arms the band";

    // The band is what the SEED committed ahead of the frontier it then set.
    // The LATCHING bootstrap row, not the first one: the warm-up frames before
    // the axis vote also carry Outcome::Bootstrap and have painted nothing, so
    // the row is picked by the thing that distinguishes it — a committed span.
    double bandFrom = -1.0, bandTo = -1.0;
    for (const auto& row : on.rows) {
        if (row.outcome != rnis::pano::Outcome::Bootstrap) continue;
        if (!(row.canvasX1 > row.canvasX0)) continue;
        bandFrom = row.highWater;
        bandTo = row.canvasX1;
        break;
    }
    ASSERT_GE(bandFrom, 0.0) << "no bootstrap row that committed a span";
    const double band = bandTo - bandFrom;
    ASSERT_GT(band, 1.0) << "the seed committed nothing ahead of its centre — "
                            "this fixture cannot test the rule";

    const double filled = totalLeadRepaintPx(on);
    ASSERT_GT(filled, 0.0) << "nothing was filled at all";
    // +1 px per contributing commit for the shared boundary column: a run
    // starts at the previous commit's right EDGE, and floor/ceil can claim that
    // column on both sides.  Nothing else may be double-written.
    EXPECT_LE(filled, band + (double)on.stats.leadRepaintStrips)
        << "the fill re-wrote canvas it had already filled: " << filled
        << " px committed over a " << band << " px band in "
        << on.stats.leadRepaintStrips << " commits";
    }
}

// THE FILL IS PLACED UNDER THE SEED'S OWN LAW — and ⚠ THIS FIXTURE CANNOT
// PROVE IT.  Read the second paragraph before citing this test for anything.
//
// The fill is WIDE — it takes the remaining band in one commit — and over a wide
// span `projection == 1`'s arc map and the tangent map are not the same map.
// The disagreement at the far edge is F·(d/F − atan(d/F)), so it is set by
// d/F = band/F = tan(half-FOV): a property of the LENS, not of the sweep.  The
// seed is arc-sliced, so a tangent-only fill would put its content away from the
// content it is replacing.  Hence the fill asks the same slice builder the tail
// flush and the preview lead-out ask, about the frame it is warping, whenever
// the seed arced (verified firing: 26 slices on this fixture, block path on the
// pure-translation one).
//
// ⚠ WHAT THIS TEST DOES AND DOES NOT SEPARATE, measured rather than assumed.
// The suite's synthetic camera has d/F = 0.303, so the two laws differ by 6.2 px
// at the far edge — and a RED-FIRST control with `leadArcSeeded` forced false
// (the arc branch disabled, nothing else) reads median |ΔY| 11 DN over 20 806
// changed px against 10 DN over 20 550 with it on.  That is NOT a separation,
// and this test PASSES in both arms.  It is a gross-misplacement bound, and
// nothing more.  The operator's 0.5x ultra-wide packs are where the two laws
// actually part: d/F = 0.81 there, 57 px at the far edge, and the arm-to-arm
// comparison on those packs is the evidence for the arc branch — reported with
// the replay measurements, not here.  A test that claimed more than this
// fixture's field of view can deliver would be the exact failure this file's
// header warns about.
TEST(PanoLeadReplace, TheFillIsNotGrosslyMisplaced) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInPivotSweep();

    SweepResult off = runProjectedSweep(shelf, s, leadInConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, leadInConfig(true));
    ASSERT_FALSE(off.canvas.empty());
    ASSERT_EQ(off.canvas.size(), on.canvas.size())
        << "the fill changed the raster — it may only write pixels";
    ASSERT_GT(on.stats.leadRepaintStrips, 0) << "nothing was filled";

    const auto d = medianChangedDN(off.canvas, on.canvas);
    ASSERT_GT(d.second, 0) << "the flag changed no pixel at all on a pivot "
                              "sweep — the fixture is not exercising the fill";
    // The bar is a MISPLACEMENT bar, not a "no change" bar and not a law
    // discriminator (see the header): a correctly placed fill re-writes the
    // band from a neighbouring frame, so a few DN of legitimate difference is
    // expected.  It fails on a fill that lands in the wrong place entirely.
    EXPECT_LT(d.first, 12.0)
        << "median |dY| over the " << d.second << " changed px is " << d.first
        << " DN — the fill is landing where the seed's content is not";
}

// THE FILL IS ONE COMMITTED STRIP, BANKED ONCE, whichever law placed it.
//
// The identity `lensCorrected + lensSkipped == stripsCommitted` is what makes
// the lens counters checkable at all (PanoLens.TheStripCountersDescribe-
// CommittedStripsOnly), and the fill is a place it can break two ways: the
// sliced arm commits 30-odd `commitStrip` calls for ONE strip, and the block arm
// commits one.  Both run under `SliceRun`, so `commitStrip` banks NEITHER and
// the fill banks itself once — if that ever drifts (a slice banking itself, or
// a double bank at the call site) this fails, on whichever arm drifted.
//
// RED FIRST on a mutant that leaves the block arm's bank to `commitStrip` AND
// banks at the call site: corrected 67 + skipped 0 != committed 68, with 1 fill.
TEST(PanoLeadReplace, TheFillIsOneCommittedStripUnderBothLaws) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    for (const ProjSweepSpec& s : {leadInSweep(4.0), leadInPivotSweep()}) {
        auto c = lensConfig(kFitK1, kFitK2);
        c.leadReplace = true;
        SweepResult r = runProjectedSweep(shelf, s, c);
        ASSERT_GT(r.stats.leadRepaintStrips, 0) << "nothing was filled";
        EXPECT_EQ(r.stats.lensCorrectedStrips + r.stats.lensSkippedStrips,
                  r.stats.stripsCommitted)
            << "corrected " << r.stats.lensCorrectedStrips << " + skipped "
            << r.stats.lensSkippedStrips << " != committed "
            << r.stats.stripsCommitted << " with " << r.stats.leadRepaintStrips
            << " fills";
        EXPECT_LE(r.stats.leadRepaintStrips, r.stats.stripsCommitted);
    }
}

// THE COUNTERS DESCRIBE THE DELIVERED CANVAS, so a relatch re-bases them.
//
// `SessionStats::leadRepaintStrips` is documented as a SUBSET of
// `stripsCommitted`, and `stripsCommitted` is re-based by `reseedReferenceTo`
// because a relatch throws its canvas away.  Left un-re-based these two would
// keep counting fills that painted a canvas nobody can see, and on a sweep that
// relatches late the containment can invert.  Measured on this fixture before
// the fix: relatchCount 1, stripsCommitted 144, leadRepaintStrips 49, of which
// 2 preceded the relatch.
TEST(PanoLeadReplace, TheCountersAreReBasedByARelatch) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto steps = walkWithTransversePitch(120, 14.0, [](int i) {
        return i < 20 ? 8.0 * std::sin(CV_PI * (double)i / 20.0) : 0.0;
    });
    SweepResult r = runGestureSweep(shelf, steps, leadInConfig(true));
    ASSERT_GT(r.stats.relatchCount, 0) << "fixture no longer relatches";

    // The fills that survive the relatch are the ones after it, and the rows
    // carry which is which: everything up to and including the relatched row
    // belongs to the discarded canvas.
    size_t relatchIdx = r.rows.size();
    for (size_t i = 0; i < r.rows.size(); ++i) {
        if (r.rows[i].relatched) {
            relatchIdx = i;
            break;
        }
    }
    ASSERT_LT(relatchIdx, r.rows.size()) << "no Relatched row in the ledger";

    double after = 0.0;
    int64_t afterN = 0;
    for (size_t i = relatchIdx; i < r.rows.size(); ++i) {
        if (r.rows[i].leadRepaintPx > 0.0) {
            after += r.rows[i].leadRepaintPx;
            ++afterN;
        }
    }
    EXPECT_EQ(r.stats.leadRepaintStrips, afterN)
        << "the session counter still carries fills from the discarded canvas";
    EXPECT_NEAR(r.stats.leadRepaintPx, after, 1e-9);
    EXPECT_LE(r.stats.leadRepaintStrips, r.stats.stripsCommitted)
        << "the header says these are a subset of stripsCommitted";
}

// THE LEDGER'S OWN MAX IS THE SESSION'S MAX — the identity a pack reader checks.
//
// `FrameOutcome::areaScale` is the frame's worst magnification, and the fill is
// a commit by that frame, at an oblique reach where the magnification is highest.
// Read out ABOVE the fill (which is where it used to be) the row reports the
// strip's number while `SessionStats::maxAreaScalePainted` carries the fill's,
// and the pack then names a 5.36x warp no ledger row admits to.  Measured before
// the fix: 15-51-02 row-max 4.298 against session 5.360; across 16 packs the
// session max rose 0.473 +/- 0.094 while not one row moved.
TEST(PanoLeadReplace, TheLedgerAreaScaleDescribesEveryPixelTheFrameCommitted) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);

    auto gap = [&](bool on) {
        SweepResult r = runProjectedSweep(shelf, s, leadInConfig(on));
        double rowMax = 0.0;
        for (const auto& row : r.rows) rowMax = std::max(rowMax, row.areaScale);
        return r.stats.maxAreaScalePainted - rowMax;
    };
    // ⚠ NOT ZERO, AND NOT BECAUSE OF THIS FLAG.  The BOOTSTRAP commit raises
    // maxAreaScalePainted and its ledger row never carried an areaScale at all
    // (measured on this fixture: session 1.6801 against row-max 1.6775, both
    // arms, flag off).  That gap is older than Option C and is not fixed here;
    // what is asserted is that the fill does not ADD to it.
    const double off = gap(false), on = gap(true);
    EXPECT_LE(on, off + 1e-9)
        << "the fill's magnification landed in the session max and in no "
           "ledger row: gap " << off << " -> " << on;
}

// AND THE PART THE GUARD ABOVE DOES NOT COVER: the chained gain DOES move.
//
// It is fitted on a sample window that reaches LEFT of the frontier into
// already-committed canvas, and Option C legitimately changed some of those
// pixels — the remnant rows inside the window now come from a neighbouring
// frame instead of from the seed.  So the fit sees a different canvas and
// answers slightly differently.  That is the correct behaviour (the fit is
// supposed to read the canvas it is matching to), and the honest thing is to
// BOUND it rather than to claim it does not happen.
//
// The bound here is the fixture's; the number that matters is the operator's:
// on the 16 device packs the largest relative excursion of `gainCum` anywhere
// in a sweep is 1.65 %, median 0.30 %, and the integrity verdict does not move
// on any of them.
TEST(PanoLeadReplace, TheChainedGainMovesOnlyBecauseItSamplesRepaintedCanvas) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);

    SweepResult off = runProjectedSweep(shelf, s, leadInConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, leadInConfig(true));
    ASSERT_EQ(off.rows.size(), on.rows.size());

    double worstRel = 0.0;
    for (size_t i = 0; i < off.rows.size(); ++i) {
        const double a = off.rows[i].gainCum, b = on.rows[i].gainCum;
        if (std::fabs(a) > 1e-9)
            worstRel = std::max(worstRel, std::fabs(b - a) / std::fabs(a));
    }
    // BOUNDED, not zero.  A bar of 5% is far above what the packs show (1.65%)
    // and far below "the chain has been taken over" — it fails if a future
    // change lets the repaint into the FIT rather than only into the pixels
    // the fit reads.
    EXPECT_LT(worstRel, 0.05)
        << "the repaint must perturb the gain chain only through the canvas "
           "it legitimately repainted; worst relative gainCum excursion "
        << (100.0 * worstRel) << "%";
}

// ── THE SEED'S LEAD-IN, TRIMMED (Config::seedLeadTrim) ─────────────────────
//
// The seed is painted WHOLE at latch and the strips start at its centre, so
// ahead of that centre the strips repaint every COLUMN — but only as far
// ACROSS as their own frames reach.  What they miss survives as a sliver of
// seed at the cross extreme: the operator's "faint line" on pp_1790172614759.
// The trim marks the seed's lead-in pending (coverage 128), lets every later
// paint overwrite the mark, and at finish clears whatever a later paint passed
// but did not cover.  Default ON (operator, 2026-09-23); OFF is the control.
//
// ⚠ testConfig() leaves crossTraj at 0, which no host ships, and a pure
// translation gets a BLOCK seed where every phone sweep gets the ARC seed —
// so each contract below also runs the shipped engine options on a pivot.
// Without that, resolving before the tail (86k surviving pixels changed on a
// pivot at crossTraj 2) and an arc-slice mark bound that stopped after the
// first slice both passed this whole file.
namespace {

rnis::pano::Config trimConfig(bool trim) {
    auto c = testConfig();
    c.seedLeadTrim = trim;
    return c;
}

/// The engine options every host actually ships (src/sweep/sweepDefaults.ts
/// SWEEP_ENGINE_DEFAULTS), on top of the suite's config.
rnis::pano::Config shippedTrimConfig(bool trim) {
    auto c = trimConfig(trim);
    c.crossTraj = 2;
    c.crossTrajRelaxPx = 100.0;
    c.leadOutFromFrontier = true;
    c.crossFitMode = 1;
    c.crossFitDcRemove = 1;
    c.crossScaleLeak = 0.005;
    return c;
}

/// True when every coverage byte is 0 or 255 — i.e. no pending mark (128)
/// escaped finish().
bool coverageIsBinary(const cv::Mat& cov) {
    for (int y = 0; y < cov.rows; ++y) {
        const uchar* p = cov.ptr<uchar>(y);
        for (int x = 0; x < cov.cols; ++x)
            if (p[x] != 0 && p[x] != 255) return false;
    }
    return true;
}

/// THE WHOLE "ONLY CLEARS" CONTRACT, for any pair of runs that differ only in
/// the trim: identical placement, the same raster, pixels go painted →
/// unpainted and black and nowhere else, and the counter names exactly them.
/// Returns the pixels cleared.
int expectTrimOnlyClears(const SweepResult& off, const SweepResult& on) {
    EXPECT_TRUE(coverageIsBinary(off.coverage));
    EXPECT_TRUE(coverageIsBinary(on.coverage))
        << "a pending seed mark (128) survived finish()";
    EXPECT_EQ(off.rows.size(), on.rows.size());
    for (size_t i = 0; i < std::min(off.rows.size(), on.rows.size()); ++i) {
        EXPECT_EQ(off.rows[i].outcome, on.rows[i].outcome) << "row " << i;
        EXPECT_EQ(off.rows[i].canvasX0, on.rows[i].canvasX0) << "row " << i;
        EXPECT_EQ(off.rows[i].canvasX1, on.rows[i].canvasX1) << "row " << i;
        EXPECT_DOUBLE_EQ(off.rows[i].highWater, on.rows[i].highWater) << "row " << i;
    }
    if (off.canvas.size() != on.canvas.size() ||
        off.coverage.size() != on.coverage.size()) {
        ADD_FAILURE() << "the trim changed the raster";
        return -1;
    }
    int cleared = 0, gained = 0, changedSurvivors = 0, clearedNotBlack = 0;
    for (int y = 0; y < on.canvas.rows; ++y) {
        const uchar* co = off.coverage.ptr<uchar>(y);
        const uchar* cn = on.coverage.ptr<uchar>(y);
        const cv::Vec3b* po = off.canvas.ptr<cv::Vec3b>(y);
        const cv::Vec3b* pn = on.canvas.ptr<cv::Vec3b>(y);
        for (int x = 0; x < on.canvas.cols; ++x) {
            if (co[x] && !cn[x]) {
                ++cleared;
                if (pn[x] != cv::Vec3b(0, 0, 0)) ++clearedNotBlack;
            } else if (!co[x] && cn[x]) {
                ++gained;
            } else if (cn[x] && pn[x] != po[x]) {
                ++changedSurvivors;
            }
        }
    }
    EXPECT_EQ(gained, 0) << "the trim may never paint";
    EXPECT_EQ(changedSurvivors, 0) << "a pixel the trim kept was altered";
    EXPECT_EQ(clearedNotBlack, 0) << "a cleared pixel still carries content";
    EXPECT_EQ((int64_t)cleared,
              on.stats.seedLeadTrimPx - off.stats.seedLeadTrimPx)
        << "the counter must describe exactly the pixels that changed";
    return cleared;
}

}  // namespace

// The operator's decision, pinned so a silent revert of the default is a red
// test rather than a quietly different panorama.
TEST(PanoSeedLeadTrim, IsOnByDefault) {
    EXPECT_TRUE(rnis::pano::Config{}.seedLeadTrim)
        << "the operator turned the seed lead-in trim ON by default "
           "(2026-09-23); turning it off is a product decision, not a refactor";
}

// THE WHOLE CONTRACT, on the block seed AND on the shipped arc-seed pivot.
TEST(PanoSeedLeadTrim, ClearsOnlyAndChangesNothingElse) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    struct Case {
        const char* name;
        ProjSweepSpec spec;
        rnis::pano::Config (*cfg)(bool);
    };
    // Perpendicular drift is what leaves a cross remnant at all — see
    // PanoLeadReplace.ThereIsNothingToTakeBackWithoutPerpendicularDrift.
    const Case cases[] = {
        {"translation, suite config (block seed)", leadInSweep(4.0), &trimConfig},
        {"translation, shipped options", leadInSweep(4.0), &shippedTrimConfig},
        {"pivot, shipped options (arc seed, crossTraj 2)", leadInPivotSweep(),
         &shippedTrimConfig},
    };
    for (const auto& k : cases) {
        SCOPED_TRACE(k.name);
        const SweepResult off = runProjectedSweep(shelf, k.spec, k.cfg(false));
        const SweepResult on  = runProjectedSweep(shelf, k.spec, k.cfg(true));
        ASSERT_TRUE(off.stats.axisLatched);
        ASSERT_TRUE(on.stats.axisLatched);
        EXPECT_EQ(off.stats.seedLeadTrimPx, 0) << "OFF must clear nothing";
        EXPECT_GT(on.stats.seedLeadTrimPx, 0)
            << "a drifting sweep leaves a remnant — a trim that cleared "
               "nothing did not run";
        expectTrimOnlyClears(off, on);
    }
}

// EVERY CLEARED PIXEL WAS THE SEED'S, AND NO SEED PIXEL SURVIVES AHEAD OF ITS
// CENTRE — measured with the sentinel owner probe, so both halves are facts
// about the deliverable, not about the mask bookkeeping.  The second half is
// the COMPLETENESS the rest of the suite cannot see: a mark that started 40
// columns late left 3% of the remnant (the faint line itself) and passed
// every other test.
TEST(PanoSeedLeadTrim, EveryClearedPixelWasTheSeedsAndNoneSurvivesAhead) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);
    const cv::Vec3b kSentinel(0, 255, 0);

    auto probeCfg = [](bool trim) {
        auto c = trimConfig(trim);
        c.gainMatch = false;   // a scaled sentinel is no longer the sentinel
        return c;
    };
    const SweepResult ref = runProjectedSweep(shelf, s, probeCfg(false));
    const int64_t seed = bootstrapSeq(ref);
    ASSERT_GE(seed, 0) << "no bootstrap row — the sweep never latched";
    ASSERT_EQ(ref.stats.axis, 0) << "the column test below assumes a "
                                    "horizontal sweep (along = output x)";
    cv::Mat untinted;
    ASSERT_EQ(seedTintOwnedPixels(shelf, s, probeCfg(false), -1, kSentinel,
                                  &untinted), 0)
        << "the sentinel occurs naturally in this shelf — pick another";

    cv::Mat cOff, cOn;
    const int ownedOff = seedTintOwnedPixels(shelf, s, probeCfg(false), seed,
                                             kSentinel, &cOff);
    const int ownedOn  = seedTintOwnedPixels(shelf, s, probeCfg(true), seed,
                                             kSentinel, &cOn);
    ASSERT_EQ(cOff.size(), cOn.size());
    EXPECT_LT(ownedOn, ownedOff)
        << "seed-owned delivered pixels: " << ownedOff << " -> " << ownedOn;

    int differ = 0, differNotSeed = 0, differNotCleared = 0;
    int lastSeedColOff = -1, lastSeedColOn = -1;
    for (int y = 0; y < cOff.rows; ++y) {
        const cv::Vec3b* a = cOff.ptr<cv::Vec3b>(y);
        const cv::Vec3b* b = cOn.ptr<cv::Vec3b>(y);
        for (int x = 0; x < cOff.cols; ++x) {
            if (a[x] == kSentinel) lastSeedColOff = std::max(lastSeedColOff, x);
            if (b[x] == kSentinel) lastSeedColOn = std::max(lastSeedColOn, x);
            if (a[x] == b[x]) continue;
            ++differ;
            if (a[x] != kSentinel) ++differNotSeed;
            if (b[x] != cv::Vec3b(0, 0, 0)) ++differNotCleared;
        }
    }
    EXPECT_GT(differ, 0);
    EXPECT_EQ(differNotSeed, 0)
        << "the trim changed a pixel the seed frame did not own";
    EXPECT_EQ(differNotCleared, 0)
        << "the trim changed a seed pixel into something other than unpainted";
    EXPECT_EQ(ownedOff - ownedOn, differ)
        << "every seed pixel that disappeared must be one the trim cleared";

    // The delivered canvas starts at the seed's rear edge, so the seed's
    // centre — where the strips begin — is half a footprint in.
    const double centre = 0.5 * sweepFootprintPx(ref.stats, probeCfg(false).canvasScale);
    EXPECT_GE(lastSeedColOff, (int)centre)
        << "with the trim OFF the seed must survive ahead of its centre, or "
           "this fixture has nothing to trim";
    EXPECT_LT(lastSeedColOn, (int)centre)
        << "a seed pixel survived at column " << lastSeedColOn
        << ", ahead of the seed's centre (" << centre << ") — an under-trim";
}

// A SWEEP WITH NO STRIP AFTER ITS SEED KEEPS THE WHOLE SEED.  The only other
// paint in its lead-in is the tail flush re-painting THE SEED FRAME ITSELF
// under a slightly different law; counting that as a later view blackened
// 1-2 edge columns of a one-frame panorama on a real pack (pp_1790172614759
// truncated at its latch: 71 px).
//
// Under the suite config the tail re-paints the seed pixel-exactly, so there
// is nothing to clear with or without the guard.  Under the SHIPPED options
// the tail is re-placed through its trajectory and misses a few seed pixels —
// 84 on this fixture without the `stripsSinceLatch` guard, 0 with it — which
// is what makes this test see the guard, and what runs the keep branch.
TEST(PanoSeedLeadTrim, ASweepWithNoStripKeepsTheWholeSeed) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    ProjSweepSpec s;
    s.n = 6;
    s.pitchDeg = -0.6;   // attitude moves (arms the arc seed), motion does not latch
    s.dx = 0.5;
    for (auto cfg : {&trimConfig, &shippedTrimConfig}) {
        SCOPED_TRACE(cfg == &trimConfig ? "suite config" : "shipped options");
        const SweepResult off = runProjectedSweep(shelf, s, cfg(false));
        const SweepResult on  = runProjectedSweep(shelf, s, cfg(true));
        int painted = 0;
        for (const auto& r : on.rows) {
            if (r.outcome == rnis::pano::Outcome::Painted ||
                r.outcome == rnis::pano::Outcome::GapExtended) ++painted;
        }
        ASSERT_EQ(painted, 0) << "the fixture painted a strip — it no longer "
                                 "tests the no-strip path";
        ASSERT_FALSE(on.canvas.empty()) << "finish() must still emit the seed";
        EXPECT_EQ(on.stats.seedLeadTrimPx, 0)
            << "a one-frame panorama lost pixels to its own tail flush";
        EXPECT_TRUE(coverageIsBinary(on.coverage));
        ASSERT_EQ(off.canvas.size(), on.canvas.size());
        EXPECT_EQ(cv::norm(off.canvas, on.canvas, cv::NORM_INF), 0.0);
        EXPECT_EQ(cv::norm(off.coverage, on.coverage, cv::NORM_INF), 0.0);
    }
}

// THE PAINTED ROW UNION FOLLOWS THE TRIM, and never past it: with
// `cropPadRows` the deliverable is cut to the rows something painted, so
// neither end cross line may come out empty AND not one committed pixel may
// be cut away (an over-shrink by one row at each end passed the end-line
// check alone).  ⚠ No synthetic fixture found produces a seed-only edge row,
// so the SHRINK itself is proven on the real pack (ios/pp_1790112505226: two
// output rows whose only content was the seed's lead-in, 1013 -> 1011 rows).
TEST(PanoSeedLeadTrim, TheCroppedDeliverableLosesNoPaintedPixel) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = leadInSweep(4.0);
    const auto cfg = trimConfig(true);
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    SweepResult out;
    ingestProjectedSweep(eng, shelf, s, cfg, out);
    eng.finish();
    ASSERT_GT(eng.stats().seedLeadTrimPx, 0);
    cv::Mat cropped, full;
    ASSERT_TRUE(eng.finalCoverage(cropped, /*cropPadRows=*/true));
    ASSERT_TRUE(eng.finalCoverage(full, /*cropPadRows=*/false));
    ASSERT_FALSE(cropped.empty());
    EXPECT_TRUE(coverageIsBinary(cropped));
    EXPECT_EQ(cv::countNonZero(cropped), cv::countNonZero(full))
        << "the pad-row crop cut away committed pixels";
    // Cross lines are output ROWS for a horizontal sweep, COLUMNS for a
    // vertical one (`orient()` transposes).
    const bool horizontal = eng.stats().axis == 0;
    const cv::Mat first = horizontal ? cropped.row(0) : cropped.col(0);
    const cv::Mat last  = horizontal ? cropped.row(cropped.rows - 1)
                                     : cropped.col(cropped.cols - 1);
    EXPECT_GT(cv::countNonZero(first), 0) << "an empty leading cross line";
    EXPECT_GT(cv::countNonZero(last), 0) << "an empty trailing cross line";
}

// HOW THE TWO MECHANISMS COMPOSE.  Option C (`leadReplace`) REPAINTS the
// remnant from later frames; the trim CLEARS whatever is left.  So with both
// on, the deliverable must be Option C's own deliverable minus pure clears —
// the same placement, nothing painted, nothing altered — and the trim must
// clear strictly less than it does alone.
TEST(PanoSeedLeadTrim, OptionCRepaintsWhatTheTrimWouldOtherwiseClear) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    for (const auto& spec : {leadInSweep(4.0), leadInPivotSweep()}) {
        SCOPED_TRACE(spec.pitchDeg != 0.0 ? "pivot" : "translation");
        auto trimOnly = trimConfig(true);
        auto cOnly = trimConfig(false);
        cOnly.leadReplace = true;
        auto both = trimConfig(true);
        both.leadReplace = true;

        const SweepResult a = runProjectedSweep(shelf, spec, trimOnly);
        const SweepResult c = runProjectedSweep(shelf, spec, cOnly);
        const SweepResult b = runProjectedSweep(shelf, spec, both);
        ASSERT_GT(a.stats.seedLeadTrimPx, 0);
        ASSERT_GT(b.stats.leadRepaintPx, 0.0) << "Option C filled nothing";
        EXPECT_LT(b.stats.seedLeadTrimPx, a.stats.seedLeadTrimPx)
            << "Option C repainted remnant the trim then cleared anyway";
        expectTrimOnlyClears(c, b);
    }
}

// ── THE SEED JUNCTION (Config::seedFrontierMeet) ────────────────────────────
//
// THE ~10 px HOLE, AND WHERE IT COMES FROM.  `commitLatch` hands the frontier
// the seed frame's CENTRE while every strip's left edge sits half a margin
// behind its OWN centre, so the first strip after a seed starts
//
//     gapPx = du₁ · (1 − stripMargin/2)          (= 0.375 · du₁ at 1.25)
//
// ahead of the frontier, the engine drags it back to bridge, and the row is
// reported `gap-extended`.  MEASURED on this Mac by host replay over every
// pano+ pack on the machine (Pano plus 3/4/5/6 + the two phone pulls; 36
// packs, 32 with a strip after their seed): the identity holds with
// |gapPx − 0.375·du₁| = 0.000000 on 32/32, gapPx 9.178–12.965 px at
// phaseWindowPx 384 and 9.380–12.997 px at 768.  It is arithmetic, and it does
// not move with the correlation window.
//
// ⚠ THE HOLE IS NOT THE TEAR.  How far that first strip LANDS off is a
// separate, correlation-limited quantity: at 384 the junction jog reached
// 48.54 px on Pano plus 5 / 11-12-47-888Z (refused five times by the d8 guard,
// then force-accepted at 72.85 px); at 768 the same 32 packs land within
// 1.70 px and refuse nothing.  These tests pin the ARITHMETIC and what the
// knob does to it — they do not claim it places anything.
namespace {

/// The LAST bootstrap row — the one that actually committed the seed block.
/// A sweep can carry several (the latch re-votes), and only the last one's
/// frontier is the junction.
int lastBootstrapIndex(const SweepResult& r) {
    int idx = -1;
    for (size_t i = 0; i < r.rows.size(); ++i)
        if (r.rows[i].outcome == rnis::pano::Outcome::Bootstrap) idx = (int)i;
    return idx;
}

/// The first row AFTER the seed that actually committed canvas.  Held and
/// skipped rows do not reach the gap rule at all, so they are not the junction.
int firstCommittedAfter(const SweepResult& r, int from) {
    using rnis::pano::Outcome;
    for (size_t i = (size_t)(from + 1); i < r.rows.size(); ++i) {
        const Outcome o = r.rows[i].outcome;
        if (o == Outcome::Painted || o == Outcome::GapExtended ||
            o == Outcome::GapBreak || o == Outcome::GapBackfilled)
            return (int)i;
    }
    return -1;
}

rnis::pano::Config seedMeetConfig(bool meet) {
    auto c = testConfig();
    c.seedFrontierMeet = meet;
    return c;
}

/// The junction sweep: the lead-in fixture, which latches early and then pans
/// at 26 shelf px per frame — a first-strip advance in the same range the
/// operator's packs show.
ProjSweepSpec seedMeetSweep() { return leadInSweep(4.0); }

}  // namespace

// THE RCA, AS AN ASSERTION.  Stated on the SHIPPED (off) arm so it keeps
// describing what the engine does today, and stated twice — once as the row's
// own geometry (leftEdge − frontier) and once as the closed form — because it
// is the closed form that makes this arithmetic rather than a coincidence of
// this fixture's hand speed.
TEST(PanoSeedFrontier, TheHoleIsExactlyTheAdvanceTimesOneMinusHalfTheMargin) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const auto cfg = seedMeetConfig(false);
    SweepResult off = runProjectedSweep(shelf, seedMeetSweep(), cfg);

    const int b = lastBootstrapIndex(off);
    ASSERT_GE(b, 0) << "no bootstrap row — the sweep never latched";
    const int j = firstCommittedAfter(off, b);
    ASSERT_GE(j, 0) << "no strip committed after the seed — no junction";

    const auto& seed = off.rows[b];
    const auto& strip = off.rows[j];
    // `highWater` on the bootstrap row IS the seed's frontier: `commitLatch`
    // sets it to the seed frame's centre and `finishRow` copies it out.
    const double frontier = seed.highWater;
    const double du = strip.posU - frontier;
    ASSERT_GT(du, 0.0) << "the junction strip did not advance";

    EXPECT_EQ((int)strip.outcome, (int)rnis::pano::Outcome::GapExtended)
        << "with the knob off the junction must still be bridged, and the "
           "bridge is what `gap-extended` names";
    EXPECT_GT(strip.gapPx, 0.0) << "there is no hole to explain";

    const double leftEdge = strip.posU - 0.5 * strip.stripW;
    EXPECT_NEAR(strip.gapPx, leftEdge - frontier, 1e-9)
        << "the hole is not the distance from the frontier to the strip's own "
           "left edge — the geometry above this has moved";
    EXPECT_NEAR(strip.gapPx, du * (1.0 - 0.5 * cfg.stripMargin), 1e-9)
        << "gapPx " << strip.gapPx << " vs du·(1 − stripMargin/2) "
        << du * (1.0 - 0.5 * cfg.stripMargin) << " (du " << du
        << ", stripMargin " << cfg.stripMargin << ")";
}

// OFF IS OFF — the default config and an explicitly-false one agree on the
// delivered pixels AND on the whole placement sequence, not just on the
// canvas.  (The strong half of this claim is the SHA-256 manifest over the
// operator's own 36 packs, which is a replay result and is reported there.)
TEST(PanoSeedFrontier, IsOffByDefaultAndIsByteIdenticalWhenOff) {
    rnis::pano::Config fresh;
    EXPECT_FALSE(fresh.seedFrontierMeet) << "the seed-junction meet must ship OFF";

    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = seedMeetSweep();
    SweepResult dflt = runProjectedSweep(shelf, s, testConfig());
    SweepResult expl = runProjectedSweep(shelf, s, seedMeetConfig(false));

    ASSERT_FALSE(dflt.canvas.empty());
    EXPECT_EQ(fnv1aPixels(dflt.canvas), fnv1aPixels(expl.canvas))
        << "the delivered canvas moved with the knob explicitly off";
    ASSERT_EQ(dflt.rows.size(), expl.rows.size());
    for (size_t i = 0; i < dflt.rows.size(); ++i) {
        const auto& a = dflt.rows[i];
        const auto& c = expl.rows[i];
        ASSERT_EQ((int)a.outcome, (int)c.outcome) << "row " << i;
        EXPECT_DOUBLE_EQ(a.posU, c.posU) << "row " << i;
        EXPECT_DOUBLE_EQ(a.posV, c.posV) << "row " << i;
        EXPECT_DOUBLE_EQ(a.gapPx, c.gapPx) << "row " << i;
        EXPECT_DOUBLE_EQ(a.highWater, c.highWater) << "row " << i;
    }
}

// ON — the two edges MEET.  The strip paints from its own left edge, the row
// reports no hole, and the outcome stops claiming a bridge that no longer
// happens.
//
// ⚠ WHAT THIS DOES *NOT* SAY.  An earlier version of this comment said
// "everything downstream of the junction is the same chain", and on the
// operator's own 36 packs that was false in three separate ways — the d8 jog
// guard changed its verdicts (refusals 31 -> 26 at phaseWindowPx 768), the
// exposure chain re-fitted (gainCum excursion to 9.304 %), and the seed
// lead-out trajectory estimator re-placed the seed block.  The first two are
// now cut (`Config::seedFrontierMeetPinMeasure`; see
// `TheMeetDoesNotMoveTheJogGuardsOwnInput` and
// `TheMeetDoesNotRefitTheExposureChain`, both of which fail on the pre-fix
// engine).  The third is NOT, and is stated with its measurement in
// `ChangesOnlyTheBridgeSpanOnceTheSeedTrajectoryIsOutOfTheWay` below.
TEST(PanoSeedFrontier, OnTheJunctionStripStartsAtItsOwnLeftEdgeAndReportsNoGap) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = seedMeetSweep();
    SweepResult off = runProjectedSweep(shelf, s, seedMeetConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, seedMeetConfig(true));

    const int bOff = lastBootstrapIndex(off);
    const int bOn  = lastBootstrapIndex(on);
    ASSERT_GE(bOff, 0); ASSERT_GE(bOn, 0);
    const int jOff = firstCommittedAfter(off, bOff);
    const int jOn  = firstCommittedAfter(on, bOn);
    ASSERT_GE(jOff, 0); ASSERT_GE(jOn, 0);

    const auto& a = off.rows[jOff];
    const auto& b = on.rows[jOn];
    ASSERT_EQ(a.seq, b.seq)
        << "the arms did not reach the junction on the same frame — the knob "
           "must not change what gets latched or held";

    ASSERT_GT(a.gapPx, 0.0) << "the fixture has no hole to close";
    EXPECT_DOUBLE_EQ(b.gapPx, 0.0)
        << "with the knob on the junction row must report no hole; it reports "
        << b.gapPx;
    EXPECT_EQ((int)b.outcome, (int)rnis::pano::Outcome::Painted)
        << "nothing was bridged, so the row may not say `gap-extended`";

    // The paint starts at the strip's OWN left edge, not at the frontier.
    const double leftEdge = b.posU - 0.5 * b.stripW;
    EXPECT_NEAR((double)b.canvasX0, leftEdge, 1.0)
        << "committed span starts at " << b.canvasX0 << ", its own left edge "
           "is " << leftEdge << " and the seed's frontier is "
        << on.rows[bOn].highWater;
    EXPECT_GT((double)b.canvasX0, on.rows[bOn].highWater)
        << "the strip still reached back into the datum";
    // and it stops in the same place, so the chain ahead of it is unchanged.
    EXPECT_DOUBLE_EQ(a.canvasX1, b.canvasX1);
    EXPECT_DOUBLE_EQ(a.highWater, b.highWater);
    EXPECT_DOUBLE_EQ(a.posU, b.posU);
}

// THE ADVANCE IDENTITY, on both arms and on every row.  `advanceTot` is the
// sum of the rotation term and the residual translation term by construction;
// a junction change that reached the advance decomposition would break it, and
// nothing else in the suite would say so on the OFF arm.
TEST(PanoSeedFrontier, TheAdvanceDecompositionStillHoldsOnEveryRow) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = seedMeetSweep();
    for (bool meet : {false, true}) {
        SweepResult r = runProjectedSweep(shelf, s, seedMeetConfig(meet));
        ASSERT_FALSE(r.rows.empty());
        for (size_t i = 0; i < r.rows.size(); ++i) {
            const auto& w = r.rows[i];
            EXPECT_NEAR(w.advanceTotX, w.advanceRotX + w.advanceX, 1e-9)
                << "meet=" << meet << " row " << i << " seq " << w.seq;
            EXPECT_NEAR(w.advanceTotY, w.advanceRotY + w.advanceY, 1e-9)
                << "meet=" << meet << " row " << i << " seq " << w.seq;
        }
    }
}

// A JUNCTION WHOSE CORRELATION IS DELIBERATELY WEAK — the operator's case.
// The first strip after a stationary seed is the least-determined strip in the
// sweep; under noise it is the one that lands off.  The claim this test makes
// is NOT that the knob places it (it does not — see the header note): it is
// that the arithmetic still closes to within a pixel when the correlation is
// bad, so a mis-landed strip is confined to its own span and the datum's
// columns are left to the datum.
TEST(PanoSeedFrontier, ClosesToWithinAPixelEvenWhenTheJunctionCorrelationIsWeak) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    ProjSweepSpec s = seedMeetSweep();
    s.noiseDN = 30.0;            // deterministic, seeded per frame index

    SweepResult off = runProjectedSweep(shelf, s, seedMeetConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, seedMeetConfig(true));
    const int bOff = lastBootstrapIndex(off), bOn = lastBootstrapIndex(on);
    ASSERT_GE(bOff, 0); ASSERT_GE(bOn, 0);
    const int jOff = firstCommittedAfter(off, bOff);
    const int jOn  = firstCommittedAfter(on, bOn);
    ASSERT_GE(jOff, 0); ASSERT_GE(jOn, 0);
    const auto& a = off.rows[jOff];
    const auto& b = on.rows[jOn];

    // The instrument's own control: this junction really is the weak one.
    EXPECT_LT(a.response, 1.0)
        << "the noise did not reach the correlation — the fixture proves "
           "nothing about a weak junction";
    ASSERT_GT(a.gapPx, 0.0) << "no hole under noise either";

    EXPECT_DOUBLE_EQ(b.gapPx, 0.0);
    const double leftEdge = b.posU - 0.5 * b.stripW;
    EXPECT_NEAR((double)b.canvasX0, leftEdge, 1.0)
        << "response " << b.response << ", committed x0 " << b.canvasX0
        << ", own left edge " << leftEdge;
}

// THE OWNERSHIP DIRECTION, MEASURED ON THE DELIVERED PIXELS — and measured
// WITHOUT perturbing the engine.  Option C's sentinel probe cannot be pointed
// at this question: it tints a whole frame flat before ingest, and a flat frame
// moves the latch, so the arm being measured is not the arm that ships.  The
// instrument here is the two DELIVERED canvases themselves.
//
// ⚠ READ THE SCOPE BEFORE READING THE ASSERTIONS.  This test is a FIXTURE
// result and it is NOT the corpus.  The version of it shipped on 2026-09-07
// asserted, without qualification, that the knob "may only change which frame
// owns a span, never the canvas" and that the changed column band is no wider
// than the bridge — and the operator's own 36 packs disproved BOTH while this
// test stayed green, because the synthetic shelf's whole gain excursion is
// |gainCum − 1| <= 0.0013, under the 1e-3 deadband at which the engine even
// applies the gain, so the photometric channel the corpus diverges on is dead
// here.  Measured on this Mac at phaseWindowPx 768, BEFORE the 2026-09-08 fix:
// 9 of 34 packs changed canvas size and 24 of the 25 same-size packs differed
// over 545-1032 columns against a ~10 px bridge.
//
// AFTER the fix, with the seed lead-out trajectory estimator taken out of the
// comparison (`crossTrajSeed=0`, the one remaining coupling — see the
// companion test below): 0 of 34 packs change size and every differing pack is
// confined to an 18-34 px band against a 9.4-13.0 px bridge span, the excess
// being JPEG block bleed on the encoded deliverable.  With that estimator LIVE
// the corpus still shows 9 size changes and 12 packs with a 305-353 px band.
//
// So what follows is what the FIXTURE can see, asserted at fixture scope, with
// the corpus number carried in the failure messages so no future reader can
// mistake it for a corpus-wide invariant.
TEST(PanoSeedFrontier, ChangesOnlyTheBridgeSpanOnThisFixture) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = seedMeetSweep();
    SweepResult off = runProjectedSweep(shelf, s, seedMeetConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, seedMeetConfig(true));

    ASSERT_FALSE(off.canvas.empty());
    ASSERT_FALSE(on.canvas.empty());
    // A FIXTURE observation, not an invariant.  On the operator's corpus the
    // knob DOES resize the deliverable (9 of 34 packs at 768; 988 -> 1009 px on
    // p5-2026-09-07T11-14-16-066Z on a single differing ledger row), and the
    // cause is isolated: `--set crossTrajSeed=0` puts both arms back to the
    // same size on 34/34.  This ASSERT also guards the pixel loop below, which
    // indexes both Mats by `off.canvas`'s dimensions and would read out of
    // bounds the moment they diverge — so it must stay, and it must stay an
    // ASSERT.
    ASSERT_EQ(off.canvas.size(), on.canvas.size())
        << "the knob resized the deliverable ON THIS FIXTURE.  That is new: "
           "the fixture used to agree while the corpus did not.  Do NOT relax "
           "this into an EXPECT — the loop below indexes both canvases by "
           "off.canvas.cols/rows";

    const int b = lastBootstrapIndex(on);
    ASSERT_GE(b, 0);
    const int j = firstCommittedAfter(on, b);
    ASSERT_GE(j, 0);
    const double frontier = on.rows[b].highWater;
    const double leftEdge = on.rows[j].posU - 0.5 * on.rows[j].stripW;
    ASSERT_GT(leftEdge, frontier) << "no bridge span in this fixture";

    // The canvas is CROPPED at finalize, so a canvas column is not a frontier
    // column.  Anchor the comparison on the offset the crop introduced, which
    // is the same in both arms because the painted extent is.
    int lo = off.canvas.cols, hi = -1, changed = 0;
    for (int y = 0; y < off.canvas.rows; ++y) {
        const cv::Vec3b* a = off.canvas.ptr<cv::Vec3b>(y);
        const cv::Vec3b* c = on.canvas.ptr<cv::Vec3b>(y);
        for (int x = 0; x < off.canvas.cols; ++x)
            if (a[x] != c[x]) { ++changed; lo = std::min(lo, x); hi = std::max(hi, x); }
    }
    ASSERT_GT(changed, 0)
        << "the knob changed nothing at all — either the fixture has no "
           "junction or the knob is not wired to the paint";
    const double span = leftEdge - frontier;
    EXPECT_LE((double)(hi - lo + 1), span + 2.0)
        << "the delivered canvas changed over " << (hi - lo + 1)
        << " columns [" << lo << ", " << hi << "], but the bridge span is only "
        << span << " px wide — the knob reached beyond the junction ON THIS "
           "FIXTURE.  Corpus scope, this Mac, phaseWindowPx 768: with "
           "crossTrajSeed=0 the same comparison is 18-34 px over 34 packs; "
           "with it live, 12 packs reach 305-353 px.  This bound is a fixture "
           "bound and has never been a corpus one";
}

// THE ONE COUPLING THAT IS STILL LIVE, named AND made to fail.
//
// After the measurement/paint split the knob's reach on the operator's corpus
// is not the d8 guard and is not the exposure chain — both are pinned equal by
// the two tests further down, and re-measured on this Mac over all 36 packs
// with one binary: d8JogRefusals 31 off / 31 on at phaseWindowPx 768 (35 / 35
// at 384), stats.painted 8128 / 8128 (7458 / 7458), gainCum moved on 0 packs.
// What is left is the SEED LEAD-OUT TRAJECTORY estimator
// (`Config::crossTrajSeed`): it fits the canvas AHEAD of the seed's centre,
// and the meet is precisely the change that puts the seed's OWN forward half
// back into the first ~10 px of that window.  Isolated on the corpus, not
// inferred — p5-2026-09-07T11-14-16-066Z at 768 has on/off ledgers differing on
// exactly ONE row (the junction) yet `seedTrajSamples` 768 -> 771,
// `seedTrajSlope` 0.00584071215 -> -0.0200403966 and a delivered canvas
// 988 -> 1009 px, and with `--set crossTrajSeed=0` BOTH arms deliver 988; over
// the whole corpus that flag takes the size changes from 9 of 34 packs to 0 of
// 34 and the change band from 305-353 px down to 18-34 px.
//
// ⚠ THIS TEST RECORDS AN UNFIXED DEFECT.  The second half asserts that the
// reach IS wide, which is not an endorsement — it is the sibling knob's own
// convention (`PanoLeadReplace.TheChainedGainMovesOnlyBecauseItSamples-
// RepaintedCanvas`: "the honest thing is to BOUND it rather than to claim it
// does not happen").  When the estimator's window is fixed this test fails, and
// whoever fixes it should turn the second half into the same bound as the
// first.  `testConfig()` leaves `crossTraj` at 0, which is exactly why every
// other test in this section is blind to this.
TEST(PanoSeedFrontier, TheOnlyReachLeftIsTheSeedTrajectoryEstimator) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = seedMeetSweep();
    auto mk = [](bool meet, bool seedTraj) {
        auto c = seedMeetConfig(meet);
        c.crossTraj = 2;              // the estimator the operator's packs run
        c.crossTrajSeed = seedTraj;
        return c;
    };
    auto changedBand = [](const SweepResult& a, const SweepResult& b) {
        if (a.canvas.empty() || b.canvas.empty()) return -1;
        if (a.canvas.size() != b.canvas.size()) return -2;
        int lo = a.canvas.cols, hi = -1;
        for (int y = 0; y < a.canvas.rows; ++y) {
            const cv::Vec3b* p = a.canvas.ptr<cv::Vec3b>(y);
            const cv::Vec3b* q = b.canvas.ptr<cv::Vec3b>(y);
            for (int x = 0; x < a.canvas.cols; ++x)
                if (p[x] != q[x]) { lo = std::min(lo, x); hi = std::max(hi, x); }
        }
        return hi < 0 ? 0 : hi - lo + 1;
    };

    // (a) WITHOUT the seed estimator: confined to the bridge span.
    SweepResult offA = runProjectedSweep(shelf, s, mk(false, false));
    SweepResult onA  = runProjectedSweep(shelf, s, mk(true,  false));
    const int bA = lastBootstrapIndex(onA);
    ASSERT_GE(bA, 0);
    const int jA = firstCommittedAfter(onA, bA);
    ASSERT_GE(jA, 0);
    const double span =
        onA.rows[jA].posU - 0.5 * onA.rows[jA].stripW - onA.rows[bA].highWater;
    ASSERT_GT(span, 0.0);
    const int bandA = changedBand(offA, onA);
    ASSERT_GT(bandA, 0) << "the knob changed nothing at all (code " << bandA << ")";
    EXPECT_LE((double)bandA, span + 2.0)
        << "with crossTrajSeed off the reach must be the bridge span: band "
        << bandA << " px against a span of " << span << " px";

    // (b) WITH it: not confined.  This is the defect, stated as a number.
    SweepResult offB = runProjectedSweep(shelf, s, mk(false, true));
    SweepResult onB  = runProjectedSweep(shelf, s, mk(true,  true));
    const int bandB = changedBand(offB, onB);
    ASSERT_GT(bandB, 0) << "code " << bandB;
    EXPECT_GT((double)bandB, span + 2.0)
        << "the seed trajectory estimator no longer widens the knob's reach "
           "(band " << bandB << " px against a span of " << span << " px, and "
           << bandA << " px with the estimator off).  If that is because it "
           "was FIXED, delete this half and fold the case into (a)";
}

// THE REFUSAL, by name.  Same shape as `d8JogGuard`'s: at stripMargin >= 2 the
// hole is identically <= 0, so an operator reading `seedFrontierMeet: 1` in a
// pack's config block would be reading a knob that can never fire.
TEST(PanoSeedFrontier, RefusesAMarginAtWhichItCouldNeverFire) {
    rnis::pano::Engine eng;
    std::string err;
    rnis::pano::Config c = testConfig();
    c.seedFrontierMeet = true;
    c.stripMargin = 1.25;
    EXPECT_TRUE(eng.configure(c, &err)) << err;
    c.stripMargin = 2.0;
    EXPECT_FALSE(eng.configure(c, &err));
    EXPECT_NE(err.find("seedFrontierMeet"), std::string::npos) << err;
    c.seedFrontierMeet = false;
    EXPECT_TRUE(eng.configure(c, &err)) << err;
}

// ── THE THREE DEFECTS THE 2026-09-08 REVIEW FOUND IN THIS KNOB ──────────────
//
// Everything below is stated against numbers MEASURED ON THIS MAC by host
// replay over the operator's own 36 pano+ packs (Pano plus 3/4/5/6 + the two
// phone pulls, driver `rnis_replay_cli` built from this tree).  No device
// produced any of them, and nothing here says what the default should be.
namespace {

/// The first row after the seed the d8 jog guard REFUSED.  `firstCommittedAfter`
/// deliberately excludes `JogHeld`, which is exactly why the refused-junction
/// defect below was invisible to every other test in this section.
int firstHeldAfter(const SweepResult& r, int from) {
    for (size_t i = (size_t)(from + 1); i < r.rows.size(); ++i)
        if (r.rows[i].outcome == rnis::pano::Outcome::JogHeld) return (int)i;
    return -1;
}

/// The knob, with the d8 jog guard armed the way the operator's packs arm it
/// (every Pano plus 5 pack's meta.json: d8JogGuard true, d8JogBarPx 8,
/// d8JogMaxRun 5, gainMatch true, gainSampleMinPx 24).  `testConfig()` leaves
/// the guard OFF, which is why the suite could not see the interaction.
rnis::pano::Config seedMeetGuardedConfig(bool meet, double barPx) {
    auto c = seedMeetConfig(meet);
    c.d8JogGuard = true;
    c.d8JogBarPx = barPx;
    c.d8JogMaxRun = 5;
    return c;
}

}  // namespace

// DEFECT 1 — A REFUSED JUNCTION REPORTED ITS HOLE AS CLOSED.
//
// `row.gapPx` was zeroed in the DECISION block, before `commitStrip` ran, so a
// junction the d8 guard then refused still said `gapPx 0` on a row where
// nothing was painted, the frontier never moved and the ~10 px hole was still
// open.  Measured on this Mac before the fix: p5-2026-09-07T11-12-47-888Z at
// its own phaseWindowPx 384 reported gapPx 0.000 on five consecutive
// `d8-jog-held` rows (53-57) whose true gaps are 9.734 / 10.202 / 10.648 /
// 11.054 / 11.472 px, and the same shape appeared at 768 on
// pull3-pp_1788825877445 and pull3-pp_1788825920544 (4 rows each).  gapPx is
// the field the whole A/B is scored on, so the arm being evaluated was
// blinding its own instrument on precisely the frames where it failed.
TEST(PanoSeedFrontier, ARefusedJunctionStillReportsTheHoleItLeftOpen) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    // THE REFUSING FIXTURE, reached by measurement rather than by wish: the
    // shipped sweep's junction jog is 0.017 px and no legal bar (the validator
    // floors `d8JogBarPx` at 1) can refuse it.  A cross drift of 12 shelf px
    // per frame with a 3 %-per-frame zoom — the fan the strip chain does not
    // model — puts the JUNCTION over the operator's own 8 px bar on this Mac,
    // and it is refused in BOTH arms (1 refusal each), which is what makes the
    // arms comparable.  Same shape as the fireplace pack
    // (p5-2026-09-07T11-12-47-888Z: five refusals at 47.5-73.3 px, then a
    // forced accept), and it is the shape that made this defect invisible:
    // `firstCommittedAfter` excludes `JogHeld` by construction, so no other
    // test in this section can reach a refused junction row at all.
    ProjSweepSpec s = leadInSweep(12.0);
    s.zoomPerFrame = 0.03;
    SweepResult on = runProjectedSweep(shelf, s, seedMeetGuardedConfig(true, 8.0));

    const int b = lastBootstrapIndex(on);
    ASSERT_GE(b, 0);
    const int h = firstHeldAfter(on, b);
    ASSERT_GE(h, 0) << "the guard refused nothing — the fixture cannot pose "
                       "the question";
    const auto& held = on.rows[h];
    const double leftEdge = held.posU - 0.5 * held.stripW;
    const double trueGap = std::max(0.0, leftEdge - held.highWater);
    ASSERT_GT(trueGap, 0.0)
        << "this refused row is not a junction row (no hole in front of it)";

    EXPECT_GT(held.gapPx, 0.0)
        << "row " << h << " seq " << held.seq << " was REFUSED (nothing "
           "painted, frontier still at " << held.highWater << ") yet reports "
           "gapPx " << held.gapPx << "; the hole it left open is "
        << trueGap << " px";
    EXPECT_NEAR(held.gapPx, trueGap, 1e-9);
    EXPECT_FALSE(held.seedMet)
        << "a row that painted nothing may not claim the seed junction was met";
}

// DEFECT 2 — THE BOOKKEEPING KNOB MOVED A QUALITY GATE'S OWN INPUT.
//
// `paintLeft` is the origin of BOTH the paint and the measurement window:
// `commitStrip` derives `wx0` from it, the d8 jog guard correlates over
// [wx0, x0) and the exposure fit is fitted over the same slab.  Moving the
// strip start forward by gapPx therefore moved the band the guard reads, and
// the guard changed its mind.  Measured on this Mac at phaseWindowPx 768 over
// the 36-pack corpus before the fix: d8JogRefusals 31 -> 26, and on
// pull3-pp_1788825920544 the junction itself flipped painted -> refused
// (jog 9.907 -> 10.425 across the 8.0 px bar the pack sets) while four rows
// later a -57.02 px strip the off arm had refused was committed.
//
// The fix separates the two: the paint starts at the strip's own left edge,
// the measurement stays anchored where the off arm anchored it, so the guard
// reads the same overlap of the same two frames in both arms.
TEST(PanoSeedFrontier, TheMeetDoesNotMoveTheJogGuardsOwnInput) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = seedMeetSweep();
    SweepResult off = runProjectedSweep(shelf, s, seedMeetGuardedConfig(false, 8.0));
    SweepResult on  = runProjectedSweep(shelf, s, seedMeetGuardedConfig(true, 8.0));

    ASSERT_EQ(off.rows.size(), on.rows.size());
    EXPECT_EQ(off.stats.d8JogRefusals, on.stats.d8JogRefusals)
        << "the knob changed which strips the d8 guard admits: "
        << off.stats.d8JogRefusals << " refusals off, "
        << on.stats.d8JogRefusals << " on";
    EXPECT_EQ(off.stats.d8JogForced, on.stats.d8JogForced);

    const int b = lastBootstrapIndex(off);
    ASSERT_GE(b, 0);
    const int j = firstCommittedAfter(off, b);
    ASSERT_GE(j, 0);
    // The junction's own measurement, which is the one the knob moves.
    EXPECT_NEAR(off.rows[j].seamCanvasJogPx, on.rows[j].seamCanvasJogPx, 1e-9)
        << "the junction's measured jog moved with the knob: "
        << off.rows[j].seamCanvasJogPx << " -> " << on.rows[j].seamCanvasJogPx;
    // The junction row itself is ALLOWED to change outcome — `gap-extended` is
    // the name of the bridge, and the whole point of the knob is that there is
    // no bridge.  Every other row must be untouched: that is the claim the
    // corpus disproved before the fix (31 -> 26 refusals at 768).
    EXPECT_EQ((int)off.rows[j].outcome, (int)rnis::pano::Outcome::GapExtended);
    EXPECT_EQ((int)on.rows[j].outcome,  (int)rnis::pano::Outcome::Painted);
    for (size_t i = 0; i < off.rows.size(); ++i) {
        if ((int)i == j) continue;
        EXPECT_EQ((int)off.rows[i].outcome, (int)on.rows[i].outcome)
            << "row " << i << " seq " << off.rows[i].seq;
    }
}

// DEFECT 3 — THE SAME ORIGIN RE-FITS THE EXPOSURE CHAIN ON EVERY PACK.
//
// The overlap slab [wx0, x0) is also the gain fit's sample window, so the knob
// re-fitted `gainCum` and carried the difference for the rest of the sweep —
// on packs where the d8 guard changed NOTHING.  Measured on this Mac at 768
// before the fix: p3-2026-09-04T12-47-06-709Z has zero d8 refusals in either
// arm and exactly one outcome change (the junction), yet gainStep moved
// 0.981425732 -> 0.986620189 at the junction and 250 of 328 rows carried a
// different gainStep afterwards.  Corpus-wide, gainCum's relative excursion
// reached 9.304 % (pull3-pp_1788825920544) — the sibling knob's own bound test
// (PanoLeadReplace.TheChainedGainMovesOnlyBecauseItSamplesRepaintedCanvas)
// fails anything past 5 %.
//
// This fixture is a WEAK instrument for it and says so: its whole gain
// excursion is |gainCum - 1| <= 0.0013, three orders under the corpus, and
// below the 1e-3 deadband at which the engine even applies the gain.  It can
// still see the FIT move, which is the mechanism; it cannot see the pixels.
TEST(PanoSeedFrontier, TheMeetDoesNotRefitTheExposureChain) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    const ProjSweepSpec s = seedMeetSweep();
    SweepResult off = runProjectedSweep(shelf, s, seedMeetConfig(false));
    SweepResult on  = runProjectedSweep(shelf, s, seedMeetConfig(true));

    ASSERT_EQ(off.rows.size(), on.rows.size());
    int moved = 0;
    double worstRel = 0.0;
    for (size_t i = 0; i < off.rows.size(); ++i) {
        const double a = off.rows[i].gainCum, c = on.rows[i].gainCum;
        if (a != c) ++moved;
        if (a > 1e-9) worstRel = std::max(worstRel, std::fabs(c - a) / a);
    }
    EXPECT_EQ(moved, 0)
        << moved << " of " << off.rows.size() << " rows re-fitted their gain "
           "because the knob moved the fit's sample window; worst relative "
           "excursion " << (worstRel * 100.0) << " %";
    for (size_t i = 0; i < off.rows.size(); ++i)
        EXPECT_DOUBLE_EQ(off.rows[i].gainStep, on.rows[i].gainStep)
            << "row " << i << " seq " << off.rows[i].seq;
}

// ── TRAJECTORY CONTINUATION (Config::crossTraj, Config::leadOutFromFrontier) ─
//
// THE OPERATOR'S ELBOW, as a fixture that can fail.  A block — the tail flush,
// the seed — is one frame through one homography; the strips beside it are a
// slit-scan that carries whatever cross-axis drift the run accumulated.  Where
// they meet, position is continuous and slope is not: a hinge.
//
// The fixture manufactures exactly that.  A rotation-carried vertical sweep
// (so the arc tail engages, as on the operator's packs) with a steady ZOOM of
// 0.35 % per frame — the camera carried toward the scene as it pivots.  The
// chain does not model cross scale (each strip is committed at its own frame's
// scale), so the strips FAN: a bar at cross offset v leans by a·v with
// a ≈ 0.0014 per px here.  The last frame's block is one scale, so its bars
// are parallel.  The hinge is that fan — like the operator's, it is not a
// single number but grows with the distance from the axis — and it is
// measured on the DELIVERED canvas by tracking bright vertical bars across
// the boundary, the way the r2 instrument reads his balusters, summarised as
// the median |slope discontinuity| over bars (a fan's SIGNED median is ~0).
//
// A pure cross translation was tried first and produced NO hinge: it is real
// image motion, the correlation measures it, posNat carries it, and strips
// and block agree.  What hinges is what the chain cannot see.
namespace {

/// The shelf with the operator's balusters: bright vertical bars, so a bar's
/// cross position can be tracked row by row through the delivered canvas.
cv::Mat makeBarShelf(int width, int height) {
    cv::Mat img = makeShelf(width, height);
    for (int x = 320; x < width - 320; x += 230) {
        cv::rectangle(img, cv::Rect(x, 0, 9, height), cv::Scalar(252, 252, 252),
                      cv::FILLED);
    }
    return img;
}

ProjSweepSpec driftSweep() {
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;        // the pivot: the arc tail engages
    // +22 % over the sweep: the strips fan, a block does not.  Toned down
    // from 0.0035 once the fan bound became span-aware
    // (detail::crossTrajFanWithinSpan): at 0.0035 the fixture's fan (~0.0013
    // /px) over its ~300 px tail block scaled the block's far end 1.6x, which
    // is exactly the nonsense the bound now declines.
    s.zoomPerFrame = 0.0025;
    return s;
}

rnis::pano::Config trajConfig(int mode, bool seed = true) {
    auto c = testConfig();
    c.crossTraj = mode;
    c.crossTrajSeed = seed;
    return c;
}

/// Canvas u → delivered row, for an axis-1 sweep (the offline reader's rule:
/// the sweep runs down the rows, and a negative sign reverses it).
int rowOfU(const SweepResult& r, double u) {
    double lo = 1e18, hi = -1e18;
    for (const auto& row : r.rows) {
        const bool committed =
            row.outcome == rnis::pano::Outcome::Painted ||
            row.outcome == rnis::pano::Outcome::GapExtended ||
            row.outcome == rnis::pano::Outcome::GapBreak ||
            row.outcome == rnis::pano::Outcome::GapBackfilled ||
            row.outcome == rnis::pano::Outcome::Bootstrap ||
            row.outcome == rnis::pano::Outcome::TailFlush;
        if (!committed || row.canvasX1 <= row.canvasX0) continue;
        lo = std::min(lo, row.canvasX0);
        hi = std::max(hi, row.canvasX1);
    }
    return (r.stats.sweepSign >= 0) ? (int)std::lround(u - lo)
                                    : (int)std::lround(hi - u);
}

double firstStripX0(const SweepResult& r) {
    for (const auto& row : r.rows) {
        const bool strip =
            row.outcome == rnis::pano::Outcome::Painted ||
            row.outcome == rnis::pano::Outcome::GapExtended ||
            row.outcome == rnis::pano::Outcome::GapBreak ||
            row.outcome == rnis::pano::Outcome::GapBackfilled;
        if (strip && row.canvasX1 > row.canvasX0) return row.canvasX0;
    }
    return -1.0;
}

struct BarKink {
    int    bars = 0;
    double medianDisc = 0.0;      // median over bars of (slope below − slope above)
    double medianAbsDisc = 0.0;
    double medianAbove = 0.0;
    double medianBelow = 0.0;
    double medianAbsStep = 0.0;   // median over bars of |x_below − x_above| AT the edge
    std::string detail;           // one line per bar: xe, above, below, disc, step
};

/// Slope discontinuity of the bright bars at delivered row `edge`.  Bars are
/// seeded on BOTH sides of the edge (one row past a 3-row guard), tracked away
/// from it with a slope-predicting search, fitted on each side, and paired by
/// their fitted position AT the edge (≤ 12 px apart) — so a join with a
/// lateral step still pairs the same physical bar, and the slope discontinuity
/// is measured through the step rather than lost to it.  Bars are the sample
/// unit; the summary is the median so one lost track cannot make the number.
/// `deg` 1 fits a line on each side — the MEAN slope over `half` rows; `deg` 2
/// fits a quadratic and reads its derivative AT the edge, which is what a
/// kink is (the r2 instrument's own definition): a bar that bends smoothly
/// inside the window has a large deg-1 "hinge" and none at deg 2.
BarKink barKinkAt(const cv::Mat& bgr, int edge, int half = 40, int deg = 1) {
    BarKink out;
    cv::Mat gray;
    cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
    gray.convertTo(gray, CV_32F);
    const int H = gray.rows, W = gray.cols;
    if (edge - half < 0 || edge + half >= H) return out;
    auto peakNear = [&](int y, double xg, double* x) {
        const int lo = std::max(1, (int)std::floor(xg) - 5);
        const int hi = std::min(W - 2, (int)std::ceil(xg) + 5);
        int best = -1; float bv = 0.f;
        for (int xx = lo; xx <= hi; ++xx) {
            const float v = gray.at<float>(y, xx);
            if (v > bv) { bv = v; best = xx; }
        }
        if (best < 0 || bv < 200.f) return false;
        float mn = 1e9f;
        for (int xx = std::max(0, best - 6); xx <= std::min(W - 1, best + 6); ++xx)
            mn = std::min(mn, gray.at<float>(y, xx));
        double sw = 0, sx = 0;
        for (int xx = std::max(0, best - 4); xx <= std::min(W - 1, best + 4); ++xx) {
            const double w = std::max(0.f, gray.at<float>(y, xx) - mn);
            sw += w; sx += w * xx;
        }
        if (!(sw > 0)) return false;
        *x = sx / sw;
        return true;
    };
    auto seedsOn = [&](int ys) {
        std::vector<double> seeds;
        for (int xx = 8; xx < W - 8; ++xx) {
            const float v = gray.at<float>(ys, xx);
            if (v < 200.f) continue;
            bool mx = true;
            for (int d = -4; d <= 4; ++d)
                if (d != 0 && gray.at<float>(ys, xx + d) > v) { mx = false; break; }
            if (!mx) continue;
            if (!seeds.empty() && xx - seeds.back() < 12) continue;
            seeds.push_back((double)xx);
        }
        return seeds;
    };
    // Track one bar from `ys` in direction `dir` to `yEnd`; return the fitted
    // slope and the fitted position at the edge, or false.
    auto trackFit = [&](double s, int ys, int dir, int yEnd, double* slope,
                        double* xAtEdge) {
        std::vector<double> ys_, xs_;
        double xg = s, sl = 0.0;
        int miss = 0;
        for (int y = ys; dir < 0 ? y >= yEnd : y <= yEnd; y += dir) {
            double x;
            const double pred = xg + sl * (double)dir;
            if (peakNear(y, pred, &x) && std::fabs(x - pred) <= 4.0) {
                ys_.push_back((double)y); xs_.push_back(x);
                xg = x; miss = 0;
                const size_t n = xs_.size();
                if (n >= 6) {
                    const double dy = ys_[n - 1] - ys_[n - 6];
                    sl = (std::fabs(dy) > 0.5) ? (xs_[n - 1] - xs_[n - 6]) / dy : 0.0;
                }
            } else {
                xg = pred;
                if (++miss > 3) break;
            }
        }
        if (ys_.size() < 24) return false;
        if (deg >= 2) {
            // Least squares about the edge: x = p0 + p1·t + p2·t², t = y − edge,
            // so p1 IS the slope at the edge and p0 the position there.
            cv::Mat A((int)ys_.size(), 3, CV_64F), B((int)ys_.size(), 1, CV_64F);
            for (size_t k = 0; k < ys_.size(); ++k) {
                const double t = ys_[k] - (double)edge;
                A.at<double>((int)k, 0) = 1.0;
                A.at<double>((int)k, 1) = t;
                A.at<double>((int)k, 2) = t * t;
                B.at<double>((int)k, 0) = xs_[k];
            }
            cv::Mat P;
            if (!cv::solve(A, B, P, cv::DECOMP_SVD)) return false;
            *xAtEdge = P.at<double>(0, 0);
            *slope = P.at<double>(1, 0);
            return std::isfinite(*slope) && std::isfinite(*xAtEdge);
        }
        double sy = 0, sx = 0, syy = 0, syx = 0;
        for (size_t k = 0; k < ys_.size(); ++k) {
            sy += ys_[k]; sx += xs_[k]; syy += ys_[k] * ys_[k]; syx += ys_[k] * xs_[k];
        }
        const double n = (double)ys_.size();
        const double den = n * syy - sy * sy;
        if (!(std::fabs(den) > 1e-9)) return false;
        *slope = (n * syx - sy * sx) / den;
        const double icpt = (sx - *slope * sy) / n;
        *xAtEdge = icpt + *slope * (double)edge;
        return true;
    };
    struct Side { double slope, xe; };
    std::vector<Side> above, below;
    for (double s : seedsOn(edge - 4)) {
        Side sd;
        if (trackFit(s, edge - 4, -1, edge - half, &sd.slope, &sd.xe)) above.push_back(sd);
    }
    for (double s : seedsOn(edge + 4)) {
        Side sd;
        if (trackFit(s, edge + 4, +1, edge + half, &sd.slope, &sd.xe)) below.push_back(sd);
    }
    std::vector<double> discs, aboves, belows, steps;
    std::ostringstream det;
    for (const Side& a : above) {
        const Side* best = nullptr;
        double bd = 16.0;
        for (const Side& b : below) {
            const double d = std::fabs(b.xe - a.xe);
            if (d < bd) { bd = d; best = &b; }
        }
        if (best == nullptr) continue;
        discs.push_back(best->slope - a.slope);
        aboves.push_back(a.slope);
        belows.push_back(best->slope);
        steps.push_back(std::fabs(best->xe - a.xe));
        det << " [x=" << (int)a.xe << " above " << a.slope << " below "
            << best->slope << " disc " << (best->slope - a.slope) << " step "
            << (best->xe - a.xe) << "]";
    }
    out.bars = (int)discs.size();
    out.detail = det.str();
    if (discs.empty()) return out;
    auto med = [](std::vector<double> v) {
        std::sort(v.begin(), v.end());
        return v[v.size() / 2];
    };
    std::vector<double> ad;
    for (double d : discs) ad.push_back(std::fabs(d));
    out.medianDisc = med(discs);
    out.medianAbsDisc = med(ad);
    out.medianAbove = med(aboves);
    out.medianBelow = med(belows);
    out.medianAbsStep = med(steps);
    return out;
}

/// Mean |Δx| of every bright near-vertical ridge between two canvases of the
/// same size over rows [y0, y1) — the ridges seeded on `a` at the band's
/// middle row and tracked in BOTH images with `ridgeSagitta`'s own tracker.
/// A ridge that dies in either image is dropped; `nRidges` says how many
/// survived.  Deliberately crude for the same reason ridgeSagitta is.
double ridgeMeanShift(const cv::Mat& a, const cv::Mat& b, int x0, int x1,
                      int y0, int y1, int* nRidges) {
    cv::Mat ga, gb, fa, fb;
    cv::cvtColor(a, ga, cv::COLOR_BGR2GRAY);
    cv::cvtColor(b, gb, cv::COLOR_BGR2GRAY);
    ga.convertTo(fa, CV_32F);
    gb.convertTo(fb, CV_32F);
    const int yMid = (y0 + y1) / 2;
    std::vector<int> seeds;
    for (int x = x0 + 4; x < x1 - 4; ++x) {
        const float c = fa.at<float>(yMid, x);
        if (c < 230.0f) continue;
        if (c >= fa.at<float>(yMid, x - 1) && c > fa.at<float>(yMid, x + 1)) {
            if (seeds.empty() || x - seeds.back() > 8) seeds.push_back(x);
        }
    }
    auto trackFrom = [&](const cv::Mat& f, double start, int yFrom, int yTo, int dir,
                         std::vector<double>* xs) {
        double cur = start;
        for (int y = yFrom; dir > 0 ? y < yTo : y >= yTo; y += dir) {
            const int c0 = (int)std::lround(cur);
            int best = -1;
            float bv = 200.0f;
            for (int d = -3; d <= 3; ++d) {
                const int x = c0 + d;
                if (x <= x0 || x >= x1 - 1) continue;
                if (f.at<float>(y, x) > bv) { bv = f.at<float>(y, x); best = x; }
            }
            if (best < 0) return false;
            const double p = f.at<float>(y, best - 1), q = f.at<float>(y, best),
                         r = f.at<float>(y, best + 1);
            const double den = p - 2 * q + r;
            const double sub = (std::fabs(den) < 1e-6) ? 0.0
                                : std::max(-1.0, std::min(1.0, 0.5 * (p - r) / den));
            cur = (double)best + sub;
            xs->push_back(cur);
        }
        return true;
    };
    std::vector<double> shifts;
    for (int sx : seeds) {
        // From the middle row outward in both directions, in both images.
        std::vector<double> aUp, aDn, bUp, bDn;
        if (!trackFrom(fa, sx, yMid, y0, -1, &aUp) || !trackFrom(fa, sx, yMid, y1, +1, &aDn))
            continue;
        if (!trackFrom(fb, sx, yMid, y0, -1, &bUp) || !trackFrom(fb, sx, yMid, y1, +1, &bDn))
            continue;
        double sum = 0.0;
        size_t n = 0;
        for (size_t i = 0; i < aUp.size() && i < bUp.size(); ++i) { sum += std::fabs(aUp[i] - bUp[i]); ++n; }
        for (size_t i = 0; i < aDn.size() && i < bDn.size(); ++i) { sum += std::fabs(aDn[i] - bDn[i]); ++n; }
        if (n < (size_t)((y1 - y0) * 0.8)) continue;
        shifts.push_back(sum / (double)n);
    }
    if (nRidges) *nRidges = (int)shifts.size();
    if (shifts.empty()) return -1.0;
    double s = 0;
    for (double v : shifts) s += v;
    return s / (double)shifts.size();
}

/// Investigation aid: RNIS_TEST_TRAJ_DUMP=<dir> writes each arm's canvas.
void dumpCanvas(const cv::Mat& canvas, const char* name) {
    if (const char* d = std::getenv("RNIS_TEST_TRAJ_DUMP"))
        cv::imwrite(std::string(d) + "/" + name + ".png", canvas);
}

std::string kinkDetail(const BarKink& k) {
    std::ostringstream o;
    o << "bars=" << k.bars << " median|disc|=" << k.medianAbsDisc
      << " medianDisc=" << k.medianDisc << " above=" << k.medianAbove
      << " below=" << k.medianBelow << " median|step|=" << k.medianAbsStep
      << k.detail;
    return o.str();
}

const rnis::pano::FrameOutcome* tailRow(const SweepResult& r) {
    for (const auto& row : r.rows)
        if (row.outcome == rnis::pano::Outcome::TailFlush &&
            row.canvasX1 > row.canvasX0)
            return &row;
    return nullptr;
}

}  // namespace

TEST(PanoCrossTraj, IsOffByDefaultAndTheLedgerSaysSo) {
    rnis::pano::Config c;
    EXPECT_EQ(c.crossTraj, 0);
    EXPECT_FALSE(c.leadOutFromFrontier);

    const cv::Mat shelf = makeBarShelf(5200, 3400);
    SweepResult r = runProjectedSweep(shelf, driftSweep(), testConfig());
    const auto* tail = tailRow(r);
    ASSERT_NE(tail, nullptr);
    EXPECT_FALSE(tail->crossTrajApplied);
    EXPECT_EQ(tail->crossTrajSamples, 0);
    EXPECT_FALSE(r.stats.tailTrajApplied);
    EXPECT_FALSE(r.stats.seedTrajApplied);
    EXPECT_DOUBLE_EQ(r.stats.seedTrajRepaintPx, 0.0);
}

// RED, observed (the routine stubbed to decline): the tail edge keeps its
// fan hinge and `crossTrajApplied` stays false.
TEST(PanoCrossTraj, TheZoomFixtureHasAFanHingeAndTheOverlapEstimatorRemovesIt) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();

    SweepResult off = runProjectedSweep(shelf, s, trajConfig(0));
    dumpCanvas(off.canvas, "zoom_off");
    ASSERT_EQ(off.stats.axis, 1) << "fixture drifted — this must be a vertical sweep";
    ASSERT_TRUE(off.stats.tailFlushed);
    const double tailU = tailFlushX0(off);
    ASSERT_GT(tailU, 0.0);
    const BarKink k0 = barKinkAt(off.canvas, rowOfU(off, tailU));
    ASSERT_GE(k0.bars, 4) << "fixture drifted — the bars must be trackable across the tail edge";
    // NON-VACUOUS: the fixture has the operator's hinge.
    ASSERT_GT(k0.medianAbsDisc, 0.12)
        << "fixture drifted — the zoom is supposed to put a fan hinge at the "
           "tail edge (median |disc| " << k0.medianAbsDisc << ")";

    // ESTIMATOR 2 — the overlap — sees the fan and continues it.
    {
        SweepResult on = runProjectedSweep(shelf, s, trajConfig(2));
        dumpCanvas(on.canvas, "zoom_on2");
        const auto* tail = tailRow(on);
        ASSERT_NE(tail, nullptr);
        EXPECT_TRUE(tail->crossTrajApplied) << "the overlap estimator declined";
        EXPECT_TRUE(on.stats.tailTrajApplied);
        EXPECT_GT(tail->crossTrajSamples, 0);
        EXPECT_GT(on.stats.tailTrajBands, 2);
        // The fitted fan is the strips' fan RELATIVE to the block frame's own:
        // the zoom gives the strips −0.0006 /px at the tail (0.0025 per frame
        // over 2.47 px, at the 1.22x the scale has reached) and the pitched
        // frame's own perspective fans its bars the other way by tan 18° / F
        // = +0.00046 /px — so the hinge the estimator must see is ~0.0010
        // /px, and over this fixture's tail block that is inside the span
        // rule (|fan|·span ≤ 0.3) with room to spare.
        EXPECT_NEAR(std::fabs(tail->crossTrajFan), 0.0010, 0.0004)
            << "fitted fan " << tail->crossTrajFan;
        EXPECT_LE(std::fabs(tail->crossTrajFan) * (tail->canvasX1 - tail->canvasX0), 0.27)
            << "the fixture's fan·span must sit inside the bound with margin, "
               "or this test measures the bound and not the estimator";

        const BarKink k1 = barKinkAt(on.canvas, rowOfU(on, tailFlushX0(on)));
        ASSERT_GE(k1.bars, 4);
        EXPECT_LT(k1.medianAbsDisc, 0.06)
            << "the block does not continue the strips' fan — " << kinkDetail(k1)
            << " (was " << kinkDetail(k0) << "); fitted slope "
            << tail->crossTrajSlope << " fan " << tail->crossTrajFan
            << " samples " << tail->crossTrajSamples << " bands "
            << on.stats.tailTrajBands << " resp " << on.stats.tailTrajResponse;
        EXPECT_LT(k1.medianAbsDisc, 0.3 * k0.medianAbsDisc);
        // Nothing lost: the same frames painted, no new holes.
        EXPECT_EQ(on.holes.size(), off.holes.size());
        EXPECT_EQ(on.stats.painted, off.stats.painted);
    }
    // ESTIMATOR 1 — the chain — cannot see a fan the chain never modelled:
    // its posV is flat here, so it applies a ~0 slope and changes nothing.
    // Pinned as "no harm", because that is the honest statement of what the
    // brief's literal definition does on a hinge the chain did not make.
    {
        SweepResult on = runProjectedSweep(shelf, s, trajConfig(1));
        const auto* tail = tailRow(on);
        ASSERT_NE(tail, nullptr);
        EXPECT_TRUE(tail->crossTrajApplied);
        EXPECT_LT(std::fabs(tail->crossTrajSlope), 0.05)
            << "the chain's own trajectory is flat on a zoom";
        const BarKink k1 = barKinkAt(on.canvas, rowOfU(on, tailFlushX0(on)));
        ASSERT_GE(k1.bars, 4);
        EXPECT_NEAR(k1.medianAbsDisc, k0.medianAbsDisc, 0.03)
            << "estimator 1 must neither fix nor damage a fan it cannot see";
    }
}

// The seed is the other end of the same fork, and what it shows is a STEP.
// The seed's rear half is the reference frame; the first strip after it is a
// LATER frame's rear span (the latch window's frames are never painted), and
// on a zoom the two differ in scale — so at the seed's centre the bars jog
// sideways by (zoom jump)·(distance from the axis): ~10 px at the canvas
// edges here.  That is a position discontinuity, not a slope one, and the
// seed's continuation carries a per-band intercept precisely so it can be
// measured and applied: the rear half is shifted and scaled about the axis to
// meet the first strip, then sheared to its slope.
//
// RED, observed (routine stubbed): the seed edge keeps its ~10 px step and
// `seedTrajApplied` stays false.
TEST(PanoCrossTraj, TheSeedRearHalfIsMadeContinuousWithTheFirstStrip) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();

    SweepResult off = runProjectedSweep(shelf, s, trajConfig(0));
    dumpCanvas(off.canvas, "seed_off");
    const double seedEdgeU = firstStripX0(off);
    ASSERT_GT(seedEdgeU, 0.0);
    const BarKink k0 = barKinkAt(off.canvas, rowOfU(off, seedEdgeU));
    ASSERT_GE(k0.bars, 4) << "fixture drifted — bars must cross the seed edge (row "
                          << rowOfU(off, seedEdgeU) << " of " << off.canvas.rows
                          << ", " << kinkDetail(k0) << ")";
    // NON-VACUOUS: the fixture has a lateral step at the seed edge.
    ASSERT_GT(k0.medianAbsStep, 3.0)
        << "fixture drifted — the latch-window zoom is supposed to jog the bars "
           "at the seed edge (" << kinkDetail(k0) << ")";

    SweepResult on = runProjectedSweep(shelf, s, trajConfig(2, /*seed=*/true));
    dumpCanvas(on.canvas, "seed_on2");
    EXPECT_TRUE(on.stats.seedTrajApplied);
    EXPECT_GT(on.stats.seedTrajRepaintPx, 0.0);
    EXPECT_GT(on.stats.seedTrajSamples, 0);
    const BarKink k1 = barKinkAt(on.canvas, rowOfU(on, firstStripX0(on)));
    ASSERT_GE(k1.bars, 4) << kinkDetail(k1);
    EXPECT_LT(k1.medianAbsStep, 1.5)
        << "the seed's rear half was not brought to the first strip — "
        << kinkDetail(k1) << " (was " << kinkDetail(k0) << ")";
    EXPECT_LT(k1.medianAbsStep, 0.4 * k0.medianAbsStep);
    // And the slope join must not be made worse by it.
    EXPECT_LT(k1.medianAbsDisc, k0.medianAbsDisc + 0.03) << kinkDetail(k1);
    EXPECT_EQ(on.holes.size(), off.holes.size());

    // The seed switch alone leaves the seed edge exactly as it was while the
    // tail is still continued — the two ends are measurable separately.
    SweepResult noSeed = runProjectedSweep(shelf, s, trajConfig(2, /*seed=*/false));
    EXPECT_FALSE(noSeed.stats.seedTrajApplied);
    EXPECT_TRUE(noSeed.stats.tailTrajApplied);
    const BarKink k2 = barKinkAt(noSeed.canvas, rowOfU(noSeed, firstStripX0(noSeed)));
    ASSERT_GE(k2.bars, 4);
    EXPECT_NEAR(k2.medianAbsStep, k0.medianAbsStep, 0.5);
}

// (B) THE STALE BAND.  Mid-sweep, before the strips have reached the seed's
// far edge, the committed band's end is the SEED's footprint end and
// everything between the frontier and it is the seed's 4-second-old pixels.
// With the flag on the live frame is painted from ceil(frontier), over that
// band, so the preview carries one boundary instead of two.
//
// RED, observed (flag ignored): leadStartU == bandEndU, leadOverwritePx == 0,
// and the region between the frontier and the band end is the seed's, byte
// for byte, under both arms.
TEST(PanoCrossTraj, TheLeadOutStartsAtTheFrontierAndOverwritesTheStaleBand) {
    cv::Mat tall = makeShelf(kFrameW, 5000);
    auto cfgOff = testConfig();
    auto cfgOn = testConfig();
    cfgOn.leadOutFromFrontier = true;
    rnis::pano::Engine eOff, eOn;
    std::string err;
    ASSERT_TRUE(eOff.configure(cfgOff, &err)) << err;
    ASSERT_TRUE(eOn.configure(cfgOn, &err)) << err;
    // 24 frames × 18 px × 0.5 = 216 canvas px of strips: short of the seed's
    // 270 px lead-in, so the stale band exists.
    runVerticalSweep(eOff, cfgOff, tall, 24, +1);
    runVerticalSweep(eOn, cfgOn, tall, 24, +1);
    ASSERT_EQ(eOff.stats().axis, 1);
    ASSERT_EQ(eOn.stats().axis, 1);

    cv::Mat off, on;
    rnis::pano::PreviewWindow woff, won;
    ASSERT_TRUE(eOff.previewIntoFit(off, 100000, 100000, 0, &woff, false, true));
    ASSERT_TRUE(eOn.previewIntoFit(on, 100000, 100000, 0, &won, false, true));
    ASSERT_GT(woff.leadOutPx, 0);
    ASSERT_GT(won.leadOutPx, 0);
    // NON-VACUOUS: there IS a stale band between the frontier and the band end.
    const int stale = woff.bandEndU - (int)std::ceil(woff.frontierU);
    ASSERT_GT(stale, 20) << "fixture drifted — the strips have reached the seed's "
                            "far edge and there is no stale band to overwrite";

    EXPECT_DOUBLE_EQ(woff.leadStartU, (double)woff.bandEndU)
        << "off: the lead-out only appends";
    EXPECT_EQ(woff.leadOverwritePx, 0);
    EXPECT_DOUBLE_EQ(won.leadStartU, std::ceil(won.frontierU))
        << "on: the live paint must begin at the first uncommitted column";
    EXPECT_EQ(won.leadOverwritePx, stale);
    EXPECT_EQ(won.viewEndU, woff.viewEndU) << "the extent is the same — only who owns the band changed";
    ASSERT_EQ(on.size(), off.size());

    // Vertical sweep, sign +1: canvas u runs down the rows.
    const int rFront = (int)std::ceil(won.frontierU) - won.viewStartU;
    const int rBand = won.bandEndU - won.viewStartU;
    const cv::Mat commOff = off(cv::Rect(0, 0, off.cols, rFront));
    const cv::Mat commOn = on(cv::Rect(0, 0, on.cols, rFront));
    EXPECT_EQ(cv::norm(commOff, commOn, cv::NORM_INF), 0.0)
        << "committed pixels behind the frontier are the painter's, in both arms";
    const cv::Mat staleOff = off(cv::Rect(0, rFront, off.cols, rBand - rFront));
    const cv::Mat staleOn = on(cv::Rect(0, rFront, on.cols, rBand - rFront));
    EXPECT_GT(cv::norm(staleOff, staleOn, cv::NORM_INF), 0.0)
        << "the stale band must now carry the live frame, not the seed";
    // And what it carries IS the live frame: the same content the appended
    // lead-out shows one row further on, i.e. continuous with it.  Cheap
    // check: the overwritten band is not black (the live mask reaches it).
    cv::Mat staleOnG;
    cv::cvtColor(staleOn, staleOnG, cv::COLOR_BGR2GRAY);
    EXPECT_GT(cv::countNonZero(staleOnG > 0), staleOnG.total() / 2);
}

// The lead-out is "the exact image you are going to get": the trajectory the
// preview places the provisional block under is the one finish() then commits
// with, measured on the same state.
//
// RED, observed (flag ignored in the preview): leadTrajApplied is false while
// the tail row's crossTrajApplied is true.
TEST(PanoCrossTraj, TheLeadOutCarriesTheSameTrajectoryTheTailFlushCommits) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();
    auto cfg = trajConfig(2);
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    SweepResult out;
    ingestProjectedSweep(eng, shelf, s, cfg, out);
    ASSERT_TRUE(eng.stats().axisLatched);

    cv::Mat pv;
    rnis::pano::PreviewWindow w;
    ASSERT_TRUE(eng.previewIntoFit(pv, 100000, 100000, 0, &w, false, true));
    ASSERT_GT(w.leadOutPx, 0);
    EXPECT_TRUE(w.leadTrajApplied);

    const rnis::pano::FrameOutcome tail = eng.finish();
    ASSERT_GT(tail.canvasX1, tail.canvasX0);
    EXPECT_TRUE(tail.crossTrajApplied);
    EXPECT_DOUBLE_EQ(w.leadTrajSlope, tail.crossTrajSlope)
        << "the preview and the flush measured different trajectories on the "
           "same state";
    EXPECT_DOUBLE_EQ(w.leadTrajFan, tail.crossTrajFan);
    EXPECT_NEAR(std::fabs(w.leadTrajFan), 0.0010, 0.0004)
        << "the fixture's hinge fan is ~0.0010 per px at the tail; the estimate should be near it";
}

// ── THE FOUR THE REVIEW FOUND ───────────────────────────────────────────────

// (1) THE SLOPE IS THE SLOPE AT THE JOIN.  The zoom's rate ramps to zero over
// the last 24 frames — the tail window — so the strips' bars BEND inside the
// window and arrive at the join tangent to the block: the r2-style (deg 2)
// hinge at the join is already at the floor, while a line through the window
// reads the bend as a slope.  Continuing that mean slope manufactures a kink
// on a join that had none (15-51-42: −0.03 → −0.13 on the device pack).
//
// RED, observed (per-band fit a line): the deg-2 hinge under crossTraj=2 is
// ~0.1 against ~0.02 with the flag off.
TEST(PanoCrossTraj, TheEstimatorContinuesTheSlopeAtTheJoinNotTheWindowMean) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    ProjSweepSpec s = driftSweep();
    // The same +31 % the original fixture carried, delivered at full rate for
    // 66 frames and then tapered to nothing over the last 24 — the window.
    s.zoomPerFrame = 0.004;
    s.zoomRampFrames = 24;

    SweepResult off = runProjectedSweep(shelf, s, trajConfig(0));
    dumpCanvas(off.canvas, "ramp_off");
    ASSERT_TRUE(off.stats.tailFlushed);
    const int edge0 = rowOfU(off, tailFlushX0(off));
    // The r2 instrument's own window (half = 60), so the ramp is inside it.
    const BarKink lin0 = barKinkAt(off.canvas, edge0, 60, 1);
    const BarKink quad0 = barKinkAt(off.canvas, edge0, 60, 2);
    ASSERT_GE(quad0.bars, 4) << kinkDetail(quad0);
    // NON-VACUOUS: the strips bend inside the window — the bars' mean slope
    // over the 60 rows above the edge differs from their slope AT the edge.
    // (Measured 0.037 on this fixture; the sharper proof that the bend is
    // there is that the window-mean estimator this test was written against
    // manufactures a 0.1 kink on it — see the RED note above.)
    ASSERT_GT(std::fabs(lin0.medianAbove - quad0.medianAbove), 0.025)
        << "fixture drifted — the ramp is supposed to bend the strips inside "
           "the window: deg-1 " << kinkDetail(lin0) << " deg-2 " << kinkDetail(quad0);

    SweepResult on = runProjectedSweep(shelf, s, trajConfig(2));
    dumpCanvas(on.canvas, "ramp_on2");
    const auto* tail = tailRow(on);
    ASSERT_NE(tail, nullptr);
    EXPECT_TRUE(tail->crossTrajApplied) << "the estimator declined on the ramp fixture";
    const BarKink quad1 = barKinkAt(on.canvas, rowOfU(on, tailFlushX0(on)), 60, 2);
    ASSERT_GE(quad1.bars, 4) << kinkDetail(quad1);
    EXPECT_LT(quad1.medianAbsDisc, 0.06)
        << "the block was sheared to the window's MEAN slope, not the slope at "
           "the join — " << kinkDetail(quad1) << " (off: " << kinkDetail(quad0)
        << "); fitted slope " << tail->crossTrajSlope << " fan " << tail->crossTrajFan;
    EXPECT_LT(quad1.medianAbsDisc, quad0.medianAbsDisc + 0.03)
        << "a join that had no kink must not be given one";
    EXPECT_EQ(on.stats.painted, off.stats.painted);
}

// (2) THE FAN BOUND KNOWS THE SPAN.  The slice map's cross scale is
// 1 / (1 − a·Δu): a = 0.004 puts the pole 250 px into every tail block on
// disk (277–401 px), mirroring its far end; the old flat cap of 0.006 accepted
// it.  The rule is |a|·L ≤ 0.3 — the far end scaled by at most 1.43x.
//
// RED, observed (rule stubbed to accept): the a = 0.004 / 296 px case passes.
TEST(PanoCrossTraj, TheFanBoundIsAFunctionOfTheSpanItIsCarriedOver) {
    using rnis::pano::detail::crossTrajFanWithinSpan;
    EXPECT_FALSE(crossTrajFanWithinSpan(0.004, 296.0, 0.0))
        << "a = 0.004 over 296 px is a pole inside the block";
    EXPECT_FALSE(crossTrajFanWithinSpan(-0.004, 296.0, 0.0))
        << "the same magnitude of de-magnification is the same nonsense";
    EXPECT_FALSE(crossTrajFanWithinSpan(0.002, 296.0, 0.0))
        << "a = 0.002 magnifies the far end 2.45x";
    EXPECT_TRUE(crossTrajFanWithinSpan(0.00092, 296.0, 0.0))
        << "the largest fan measured on the sixteen packs on disk (1.37x) is accepted";
    EXPECT_TRUE(crossTrajFanWithinSpan(0.004, 60.0, 0.0))
        << "the same a over a short block is fine (0.24)";
    EXPECT_TRUE(crossTrajFanWithinSpan(0.0, 0.0, 0.0)) << "no fan needs no span";
    EXPECT_FALSE(crossTrajFanWithinSpan(0.001, 0.0, 0.0)) << "a fan with no span is undefined";
    EXPECT_FALSE(crossTrajFanWithinSpan(std::nan(""), 100.0, 0.0));
    // Relax: the fan decays as exp(−Δu/L_r); its reach is L_r·(1 − e^(−L/L_r)).
    EXPECT_TRUE(crossTrajFanWithinSpan(0.002, 296.0, 100.0))
        << "0.002 over a 95 px reach is 0.19";
    EXPECT_FALSE(crossTrajFanWithinSpan(0.004, 296.0, 100.0))
        << "0.004 over a 95 px reach is 0.38";
    // The bound is exactly w ≥ 0.7 at the far end.
    EXPECT_TRUE(crossTrajFanWithinSpan(0.3 / 296.0 - 1e-9, 296.0, 0.0));
    EXPECT_FALSE(crossTrajFanWithinSpan(0.3 / 296.0 + 1e-9, 296.0, 0.0));
}

// (3) THE SEED REPAINT RESAMPLES THROUGH THE LENS THE SEED WAS PAINTED WITH.
// A pitched sweep with no zoom: the seed's trajectory is measured valid and
// ~zero, so the rear half is re-placed almost where it was — and on a camera
// carrying a barrel field, "where it was" is lens-corrected.  A repaint
// through the plain warp puts the field back into the rear half: the bars
// bow by the field's own px while the ledger still counts the seed corrected.
//
// RED, observed (repaint through cv::warpPerspective): the rear half's bar
// sagitta goes from ~0.3 px to several px.
TEST(PanoCrossTraj, TheSeedRepaintResamplesThroughTheLensLikeTheSeedDid) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    ProjSweepSpec s;
    s.n = 90;
    s.pitchDeg = 18.0;
    s.lensK1 = -0.05;   // ~10x the device's field — a sagitta a ridge tracker can see

    auto cfgOff = lensConfig(-0.05, 0.0);
    auto cfgOn = lensConfig(-0.05, 0.0);
    cfgOn.crossTraj = 2;
    cfgOn.crossTrajSeed = true;
    SweepResult off = runProjectedSweep(shelf, s, cfgOff);
    SweepResult on = runProjectedSweep(shelf, s, cfgOn);
    dumpCanvas(off.canvas, "lensseed_off");
    dumpCanvas(on.canvas, "lensseed_on2");
    ASSERT_TRUE(off.stats.lensApplied);
    ASSERT_TRUE(on.stats.lensApplied);
    ASSERT_TRUE(on.stats.seedTrajApplied) << "the seed estimator declined";
    ASSERT_GT(on.stats.seedTrajRepaintPx, 0.0);
    EXPECT_EQ(on.stats.lensCorrectedStrips, off.stats.lensCorrectedStrips)
        << "the repaint banks no strip and changes no lens verdict";
    EXPECT_EQ(on.stats.lensSkippedStrips, off.stats.lensSkippedStrips);

    // The seed's rear half: from its committed rear edge to its centre.
    const rnis::pano::FrameOutcome* boot = nullptr;
    for (const auto& row : on.rows)
        if (row.outcome == rnis::pano::Outcome::Bootstrap && row.canvasX1 > row.canvasX0) {
            boot = &row; break;
        }
    ASSERT_NE(boot, nullptr);
    // (`rowOfU` follows the sweep sign, so the rear half may be either way up.)
    const int ra = rowOfU(on, boot->canvasX0), rb = rowOfU(on, boot->highWater);
    const int r0 = std::min(ra, rb) + 6;
    const int r1 = std::max(ra, rb) - 6;
    ASSERT_GT(r1 - r0, 60) << "seed rear half rows " << r0 << ".." << r1;
    // The two canvases must be the same raster for a per-row comparison; the
    // continuation's ~zero estimate grows no band on this fixture.
    ASSERT_EQ(on.canvas.size(), off.canvas.size());
    // NOT a straightness test: the arc seed bends a pitched bar by its own
    // law in BOTH arms (measured 3 px of sagitta with the lens fully
    // corrected).  What must hold is that the re-placed half is the seed's
    // half — the same bars within the trajectory's own small step and shear
    // — and not that half with the barrel field put back, which moves the
    // rear corners by the field's px.
    int nBars = 0;
    const double shift = ridgeMeanShift(off.canvas, on.canvas, 4, off.canvas.cols - 4,
                                        r0, r1, &nBars);
    std::cout << "[seed repaint lens] rear-half bars: mean |dx| ON vs OFF " << shift
              << " px over " << nBars << " bars; seed step " << on.stats.seedTrajStepPx
              << " step-fan " << on.stats.seedTrajStepFan << " slope "
              << on.stats.seedTrajSlope << " fan " << on.stats.seedTrajFan << "\n";
    ASSERT_GT(nBars, 3);
    EXPECT_LT(shift, 1.5)
        << "the repainted rear half is not the seed's: mean |dx| " << shift
        << " px — the lens field is back in it";
    // And the ESTIMATOR, comparing a corrected half against a corrected canvas,
    // must not read the lens's own cross scale as a step-fan: on a plain warp
    // it read −0.0057 /px here (1.7 px at 300 px off the axis) and applied it.
    EXPECT_LT(std::fabs(on.stats.seedTrajStepFan), 0.002)
        << "step-fan " << on.stats.seedTrajStepFan << " is the lens, not the strips";
}

// (4) THE PREVIEW REPORTS THE PAD AND PUBLISHES THE BAND.  Under the zoom
// fixture's fan the block's far end reaches past the canvas rows; finish()
// grows the band for it, and the preview's SCRATCH is padded the same way so
// the sheared block is painted whole — `leadPadTopPx` / `leadPadBotPx` say
// how far it reached.  The PUBLISHED rows are not the scratch: a per-tick
// trajectory is a per-tick pad, and a preview that published it changed size
// on 41 of 45 ticks of the 2026-09-07 pack (see Config::leadOutFromFrontier),
// so the view is cropped back to the unpadded band — `viewCrossPx` never
// carries a pad — and the block IS cut at the band's edge where it reached
// past it.  That crop is the contract, on both `cropPadRows` arms from the
// same ingested state (`previewIntoFit` is const).
//
// An earlier cut of this test asserted the opposite ("no content reaches the
// edge of the padded band") and passed on either side of the crop, because
// on the plain arm the block sits 128 px inside both edges — the edge clause
// measured nothing.  The non-vacuity check now lives on the crop arm, where
// the block does reach the published edge.
//
// RED, observed (the crop at the publish widened back to the scratch rows,
// i.e. the pad in the image): plain arm 994 published px against 976 canvas
// rows and `previewCrossPx` 976 (pads 2/16); crop arm 740 against 722; and
// the edge clause reads 0 — a padded image cuts nothing, which is the point.
TEST(PanoCrossTraj, TheLeadOutIsPaddedWhereTheFlushWillGrowTheBand) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();
    auto cfg = trajConfig(2);
    // Subject: what the pad is REPORTED as and what is PUBLISHED, not the
    // window.  The pad this fixture leaves is 18 px (2 top / 16 bottom) off a
    // fitted fan of 0.00102 /px; a 768 src px window fits 0.00087 and the pad
    // is 0/0 — nothing to publish, nothing to withhold.  Pin what it was
    // written against.
    cfg.phaseWindowPx = 384;
    cfg.leadOutFromFrontier = true;
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    SweepResult out;
    ingestProjectedSweep(eng, shelf, s, cfg, out);
    ASSERT_TRUE(eng.stats().axisLatched);
    ASSERT_EQ(eng.stats().axis, 1);
    const int canvasRows = eng.stats().canvasH;

    for (bool cropPad : {false, true}) {
        SCOPED_TRACE(cropPad ? "cropPadRows=true (the hosts' pair)"
                             : "cropPadRows=false");
        cv::Mat pv;
        rnis::pano::PreviewWindow w;
        ASSERT_TRUE(eng.previewIntoFit(pv, 100000, 100000, 0, &w, cropPad, true));
        ASSERT_GT(w.leadOutPx, 0);
        ASSERT_TRUE(w.leadTrajApplied);
        // The pad is REPORTED: the block reached past the canvas rows and the
        // scratch was grown for it.
        EXPECT_GT(w.leadPadTopPx + w.leadPadBotPx, 0) << "the preview padded nothing";
        // ...and NOT PUBLISHED.  Axis 1: the cross axis is the published
        // width, and it is the unpadded band — the canvas rows on the plain
        // arm, the painted row union on the crop arm — i.e. exactly the cross
        // `previewCrossPx` promised the host before the tick.
        EXPECT_EQ(w.viewCrossPx, pv.cols) << "axis 1: the cross axis is the published width";
        EXPECT_EQ(pv.cols, eng.previewCrossPx(cropPad))
            << "the published width is not the one the host sized its window from";
        EXPECT_LE(pv.cols, canvasRows)
            << "the published width carries " << (pv.cols - canvasRows)
            << " pad px (pads " << w.leadPadTopPx << "/" << w.leadPadBotPx << ")";
        if (!cropPad) {
            EXPECT_EQ(pv.cols, canvasRows);
            EXPECT_EQ(w.viewCrossPx, w.canvasCrossPx)
                << "no crop was asked for, so the view must be the whole canvas cross";
        } else {
            // NON-VACUOUS (1): on the crop arm the block reaches the published
            // edge, so the equal sizes above were held AGAINST a block that
            // would have widened the image, not in its absence.  Provisional
            // rows only (axis 1, sign +1: canvas u runs down the rows), the
            // outermost two cross columns on each side.
            const int rFront = (int)std::ceil(w.frontierU) - w.viewStartU;
            ASSERT_GT(pv.rows, rFront + 8);
            int edgeContent = 0;
            for (int r = rFront; r < pv.rows; ++r) {
                for (int c : {0, 1, pv.cols - 2, pv.cols - 1}) {
                    const cv::Vec3b p = pv.at<cv::Vec3b>(r, c);
                    if (std::max({p[0], p[1], p[2]}) > 12) ++edgeContent;
                }
            }
            EXPECT_GT(edgeContent, 0)
                << "no provisional content at the band's edge: the crop cut "
                   "nothing here, so the size clauses were not exercised";
        }
    }
    // NON-VACUOUS (2): the flush grows the band for this block, so the pad
    // reported above was a real reach past the canvas rows, not a guard row.
    const rnis::pano::FrameOutcome tail = eng.finish();
    ASSERT_TRUE(tail.crossTrajApplied);
    ASSERT_GT(eng.stats().canvasH - canvasRows, 0)
        << "fixture drifted — the block no longer leaves the canvas";
}

// ── THE CHEAP LEAD-OUT (Config::leadOutTraj) ────────────────────────────────
//
// With `crossTraj` on, every preview tick re-fits the tail's trajectory and
// shears the provisional block under it.  `leadOutTraj = false` keeps the
// lead-out where `leadOutFromFrontier` puts it (from the frontier, through the
// lens) but under the plain `lastHint` warp: no estimate, no fan, no pad —
// the cheap route.  The flush is not this knob's, so it still continues the
// trajectory into the committed canvas.
//
// RED, observed (knob declared, not read): leadTrajApplied stays true and the
// pads stay > 0 with the knob off.
//
// Measured on BOTH `cropPadRows` arms from the same ingested state
// (`previewIntoFit` is const): `false` is what the fixtures here were written
// against, `true` is the pair both hosts ship (`previewCropPad` defaults true
// in RNISPanoCore and PanoPlusLiveModule) — a knob pinned only on the arm the
// hosts do not pass is pinned nowhere.
TEST(PanoCrossTraj, TheCheapLeadOutDropsTheTrajectoryButTheFlushKeepsIt) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();
    auto cfg = trajConfig(2);
    // Subject: the leadOutTraj knob, not the window.  The non-vacuity arm
    // below needs the WITH-knob state to pad, and that pad is the 18 px this
    // fixture only leaves at 384 src px (see
    // PanoCrossTraj.TheLeadOutIsPaddedWhereTheFlushWillGrowTheBand).
    cfg.phaseWindowPx = 384;
    cfg.leadOutFromFrontier = true;
    cfg.leadOutTraj = false;
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    SweepResult out;
    ingestProjectedSweep(eng, shelf, s, cfg, out);
    ASSERT_TRUE(eng.stats().axisLatched);

    // NON-VACUOUS: the same state WITH the knob does fit one and pad for it
    // (the fixture PanoCrossTraj.TheLeadOutIsPaddedWhereTheFlushWillGrowTheBand
    // stands on) — so "false / 0 / 0" below is the knob, not a declined
    // estimate.
    auto cfgOn = cfg;
    cfgOn.leadOutTraj = true;
    rnis::pano::Engine engOn;
    ASSERT_TRUE(engOn.configure(cfgOn, &err)) << err;
    SweepResult outOn;
    ingestProjectedSweep(engOn, shelf, s, cfgOn, outOn);

    for (bool cropPad : {false, true}) {
        SCOPED_TRACE(cropPad ? "cropPadRows=true (the hosts' pair)"
                             : "cropPadRows=false");
        cv::Mat pv;
        rnis::pano::PreviewWindow w;
        ASSERT_TRUE(eng.previewIntoFit(pv, 100000, 100000, 0, &w, cropPad, true));
        ASSERT_GT(w.leadOutPx, 0) << "the lead-out block did not run — nothing measured";
        // Placed exactly as leadOutFromFrontier places it: from the first
        // uncommitted column, over the stale band.
        EXPECT_DOUBLE_EQ(w.leadStartU, std::ceil(w.frontierU));
        EXPECT_FALSE(w.leadTrajApplied) << "the cheap lead-out still fitted a trajectory";
        EXPECT_DOUBLE_EQ(w.leadTrajSlope, 0.0);
        EXPECT_DOUBLE_EQ(w.leadTrajFan, 0.0);
        EXPECT_EQ(w.leadPadTopPx, 0);
        EXPECT_EQ(w.leadPadBotPx, 0);

        cv::Mat pvOn;
        rnis::pano::PreviewWindow wOn;
        ASSERT_TRUE(engOn.previewIntoFit(pvOn, 100000, 100000, 0, &wOn, cropPad, true));
        ASSERT_TRUE(wOn.leadTrajApplied) << "fixture drifted — the estimator declines here";
        ASSERT_GT(wOn.leadPadTopPx + wOn.leadPadBotPx, 0) << "fixture drifted — no pad to drop";
    }

    // The flush still continues the trajectory: the knob is the preview's only.
    const rnis::pano::FrameOutcome tail = eng.finish();
    ASSERT_GT(tail.canvasX1, tail.canvasX0);
    EXPECT_TRUE(tail.crossTrajApplied) << "leadOutTraj=false reached the tail flush";
    EXPECT_NE(tail.crossTrajSlope, 0.0);
}

// The knob is preview-only: seed repaint and tail flush read `crossTraj`
// alone, so the DELIVERABLE is byte-identical between the two arms while the
// preview ahead of the frontier is not (the sheared, padded block against the
// plain warp).
//
// RED, observed (knob declared, not read): the previews are identical too —
// the "differs" clause fails, the knob is inert.
TEST(PanoCrossTraj, TheCheapLeadOutChangesThePreviewAndNotTheCanvas) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();
    auto cfgTraj = trajConfig(2);
    cfgTraj.leadOutFromFrontier = true;
    cfgTraj.leadOutTraj = true;
    auto cfgCheap = cfgTraj;
    cfgCheap.leadOutTraj = false;

    rnis::pano::Engine eTraj, eCheap;
    std::string err;
    ASSERT_TRUE(eTraj.configure(cfgTraj, &err)) << err;
    ASSERT_TRUE(eCheap.configure(cfgCheap, &err)) << err;
    SweepResult oTraj, oCheap;
    ingestProjectedSweep(eTraj, shelf, s, cfgTraj, oTraj);
    ingestProjectedSweep(eCheap, shelf, s, cfgCheap, oCheap);
    ASSERT_TRUE(eTraj.stats().axisLatched);
    ASSERT_TRUE(eCheap.stats().axisLatched);

    // A mid-sweep preview from each, on the same state — on both crop arms,
    // the hosts' `cropPadRows=true` included (see the test above for why).
    for (bool cropPad : {false, true}) {
        SCOPED_TRACE(cropPad ? "cropPadRows=true (the hosts' pair)"
                             : "cropPadRows=false");
        cv::Mat pvTraj, pvCheap;
        rnis::pano::PreviewWindow wTraj, wCheap;
        ASSERT_TRUE(eTraj.previewIntoFit(pvTraj, 100000, 100000, 0, &wTraj, cropPad, true));
        ASSERT_TRUE(eCheap.previewIntoFit(pvCheap, 100000, 100000, 0, &wCheap, cropPad, true));
        ASSERT_GT(wTraj.leadOutPx, 0);
        ASSERT_GT(wCheap.leadOutPx, 0);
        ASSERT_TRUE(wTraj.leadTrajApplied) << "fixture drifted — the estimator declines here";
        EXPECT_DOUBLE_EQ(wTraj.frontierU, wCheap.frontierU) << "the two engines diverged before the preview";
        const bool previewDiffers =
            pvTraj.size() != pvCheap.size() ||
            cv::norm(pvTraj, pvCheap, cv::NORM_INF) > 0.0;
        EXPECT_TRUE(previewDiffers)
            << "the two arms published the same preview: the knob changed nothing";
    }

    // The deliverable: byte for byte the same.
    oTraj.rows.push_back(eTraj.finish());
    oCheap.rows.push_back(eCheap.finish());
    eTraj.finalCanvas(oTraj.canvas);
    eCheap.finalCanvas(oCheap.canvas);
    oTraj.stats = eTraj.stats();
    oCheap.stats = eCheap.stats();
    ASSERT_FALSE(oTraj.canvas.empty());
    ASSERT_EQ(oTraj.canvas.size(), oCheap.canvas.size());
    EXPECT_EQ(cv::norm(oTraj.canvas, oCheap.canvas, cv::NORM_INF), 0.0)
        << "a preview-only knob moved the final canvas";
    EXPECT_EQ(oTraj.stats.painted, oCheap.stats.painted);
    EXPECT_EQ(oTraj.stats.tailTrajApplied, oCheap.stats.tailTrajApplied);
    EXPECT_EQ(oTraj.stats.seedTrajApplied, oCheap.stats.seedTrajApplied);
    EXPECT_TRUE(oTraj.stats.tailTrajApplied);
    ASSERT_EQ(oTraj.rows.size(), oCheap.rows.size());
    for (size_t i = 0; i < oTraj.rows.size(); ++i) {
        EXPECT_EQ(oTraj.rows[i].outcome, oCheap.rows[i].outcome) << "row " << i;
        EXPECT_DOUBLE_EQ(oTraj.rows[i].canvasX0, oCheap.rows[i].canvasX0) << "row " << i;
        EXPECT_DOUBLE_EQ(oTraj.rows[i].canvasX1, oCheap.rows[i].canvasX1) << "row " << i;
    }
}

// ── THE TRAJECTORY LEAD-OUT NEVER CHANGES THE PUBLISHED SIZE ────────────────
//
// Field, 2026-09-07 (iPhone, leadOutTraj on): the published preview changed
// size almost every tick — thin, wide, tall, short — and the operator watched
// it jump.  Offline replay of that pack: imageH 459..800 and viewCrossPx
// 979..1145 bouncing, 41 size changes in 45 ticks, against a monotonic
// 498..661 / 978..995 with the knob off.
//
// MECHANISM.  The trajectory lead-out pads its scratch (top/bottom) so the
// sheared block fits, then took the PUBLISHED band from the widened rows —
// so the pads leaked into `viewCrossPx` / `drawH`, and because the fit box is
// fixed with aspect preserved, a wider cross extent also shrank the
// along-sweep height.  A per-tick trajectory estimate is a per-tick pad, so
// the panel breathed with the estimate.
//
// THE CONTRACT.  The pads may size the SCRATCH; the published view (the rows
// that reach the fit box — `viewCrossPx`, `canvasCrossPx`, the image size)
// is exactly what `leadOutTraj = false` publishes on the same tick.  Content
// inside the view may differ — that is the trajectory's job — its extent may
// not.  Measured on EVERY tick past the latch (one preview per ingested
// frame, two engines in lockstep), on both `cropPadRows` arms, through the
// hosts' fit box (previewMaxAlong 2000 x previewMaxCross 800 in both
// RNISPanoCore and PanoPlusLiveModule) so the fit's aspect coupling is in the
// measurement and not only the canvas-px fields.
//
// RED, observed (band taken from the padded rows): sizes differ on the ticks
// the estimator pads — viewCrossPx and the published height both move.
TEST(PanoCrossTraj, TheTrajectoryLeadOutNeverChangesThePublishedSize) {
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();
    auto cfgTraj = trajConfig(2);
    cfgTraj.leadOutFromFrontier = true;
    cfgTraj.leadOutTraj = true;
    auto cfgCheap = cfgTraj;
    cfgCheap.leadOutTraj = false;

    // The two engines are ingested in lockstep: frame i into both, then one
    // preview from each, per crop arm — so every compared pair is the SAME
    // sweep state, not two sweeps that happen to end alike.
    rnis::pano::Engine eTraj, eCheap;
    std::string err;
    ASSERT_TRUE(eTraj.configure(cfgTraj, &err)) << err;
    ASSERT_TRUE(eCheap.configure(cfgCheap, &err)) << err;
    SweepResult oTraj, oCheap;
    const int kMaxAlong = 2000, kMaxCross = 800;   // the hosts' box
    int ticks = 0, padded = 0, pixelsDiffer = 0, sizeMismatch = 0;
    std::vector<std::string> mismatches;
    ingestProjectedSweep(eTraj, shelf, s, cfgTraj, oTraj,
        [&](int i, const rnis::pano::FrameInput& in) {
            oCheap.rows.push_back(eCheap.ingest(in));
            if (!eTraj.stats().axisLatched) return;

            for (bool cropPad : {false, true}) {
                cv::Mat pvTraj, pvCheap;
                rnis::pano::PreviewWindow wTraj, wCheap;
                const bool okT = eTraj.previewIntoFit(pvTraj, kMaxAlong, kMaxCross, 0,
                                                      &wTraj, cropPad, true);
                const bool okC = eCheap.previewIntoFit(pvCheap, kMaxAlong, kMaxCross, 0,
                                                       &wCheap, cropPad, true);
                ASSERT_EQ(okT, okC) << "frame " << i << ": one arm published, the other refused";
                if (!okT) continue;
                ++ticks;
                ASSERT_DOUBLE_EQ(wTraj.frontierU, wCheap.frontierU)
                    << "frame " << i << ": the two engines diverged before the preview";
                if (wTraj.leadPadTopPx + wTraj.leadPadBotPx > 0) ++padded;
                const bool sameSize =
                    pvTraj.cols == pvCheap.cols && pvTraj.rows == pvCheap.rows &&
                    wTraj.viewCrossPx == wCheap.viewCrossPx &&
                    wTraj.canvasCrossPx == wCheap.canvasCrossPx;
                if (!sameSize) {
                    ++sizeMismatch;
                    if (mismatches.size() < 6) {
                        std::ostringstream os;
                        os << "frame " << i << (cropPad ? " cropPad" : " nocrop")
                           << ": image " << pvTraj.cols << "x" << pvTraj.rows
                           << " vs " << pvCheap.cols << "x" << pvCheap.rows
                           << ", viewCrossPx " << wTraj.viewCrossPx << " vs "
                           << wCheap.viewCrossPx << ", canvasCrossPx "
                           << wTraj.canvasCrossPx << " vs " << wCheap.canvasCrossPx
                           << ", pads " << wTraj.leadPadTopPx << "/" << wTraj.leadPadBotPx;
                        mismatches.push_back(os.str());
                    }
                } else if (cv::norm(pvTraj, pvCheap, cv::NORM_INF) > 0.0) {
                    ++pixelsDiffer;
                }
            }
        });
    std::cout << "[lead-out size] ticks " << ticks << " padded " << padded
              << " sizeMismatch " << sizeMismatch << " pixelsDiffer " << pixelsDiffer << "\n";
    for (const auto& m : mismatches) std::cout << "[lead-out size]   " << m << "\n";
    // NON-VACUOUS: the estimator padded the scratch on this fixture, so the
    // sizes below were held equal AGAINST a pad, not in its absence.
    ASSERT_GT(ticks, 10);
    ASSERT_GT(padded, 0) << "fixture drifted — the trajectory never padded the scratch";
    EXPECT_EQ(sizeMismatch, 0)
        << sizeMismatch << " of " << ticks
        << " ticks published a different size with the trajectory lead-out"
        << (mismatches.empty() ? "" : ("; first: " + mismatches.front()));
    // And the knob still does something inside that view.
    EXPECT_GT(pixelsDiffer, 0)
        << "the two arms published identical pixels on every tick: the knob is inert";
}

// ── THE SEED TICK CLEARS WHAT THE TRAJECTORY TICK WROTE ─────────────────────
//
// Both hosts reuse ONE `PreviewWindow` across ticks, and the pre-latch seed
// path fills it explicitly for exactly that reason ("leaving these would
// publish the previous sweep's numbers under this frame").  The trajectory
// added seven fields to the struct — the lead-out's start and overwrite, the
// applied flag with its slope and fan, the two pads — and the seed's reset
// did not learn them, so a window that had carried a sheared, padded lead-out
// kept saying so under a reference frame that has no lead-out at all.
//
// One engine reaches the seed path after such a tick through a relatch
// (`commitLatch` clears `anyPainted` with `refBgr` re-held); the STRUCT is
// what is under test, so the fixture takes the direct route — the trajectory
// tick from one engine, the seed tick from another (the stationary hold
// PanoPreviewSeed stands on), one window between them.  Defaults are read off
// a fresh struct, not restated as literals.
//
// RED, observed (fields not in the reset): leadTrajApplied stays true and the
// pads stay > 0 after the seed tick.
TEST(PanoCrossTraj, TheSeedTickResetsTheLeadOutFieldsTheTrajectoryTickFilled) {
    // Tick 1: the trajectory fixture, past the latch, lead-out sheared and
    // padded from the frontier.
    const cv::Mat shelf = makeBarShelf(5200, 3400);
    const ProjSweepSpec s = driftSweep();
    auto cfgTraj = trajConfig(2);
    // Subject: the SEED tick clearing the seven lead-out fields, not the
    // window.  Tick 1 has to FILL them first, and the pad is the 18 px this
    // fixture only leaves at 384 src px (see
    // PanoCrossTraj.TheLeadOutIsPaddedWhereTheFlushWillGrowTheBand).
    cfgTraj.phaseWindowPx = 384;
    cfgTraj.leadOutFromFrontier = true;
    rnis::pano::Engine eTraj;
    std::string err;
    ASSERT_TRUE(eTraj.configure(cfgTraj, &err)) << err;
    SweepResult out;
    ingestProjectedSweep(eTraj, shelf, s, cfgTraj, out);
    ASSERT_TRUE(eTraj.stats().axisLatched);

    rnis::pano::PreviewWindow w;
    cv::Mat pv;
    ASSERT_TRUE(eTraj.previewIntoFit(pv, 100000, 100000, 0, &w, false, true));
    std::cout << "[seed reset] after the trajectory tick: leadStartU " << w.leadStartU
              << " leadOverwritePx " << w.leadOverwritePx << " leadTrajApplied "
              << w.leadTrajApplied << " slope " << w.leadTrajSlope << " fan "
              << w.leadTrajFan << " pad " << w.leadPadTopPx << "/" << w.leadPadBotPx
              << "\n";
    // NON-VACUOUS: the fixture wrote the fields the reset is for, or the
    // reset below would be measured against their defaults.
    ASSERT_GT(w.leadOutPx, 0) << "the lead-out block did not run — nothing to clear";
    ASSERT_GE(w.leadStartU, 0.0);
    ASSERT_TRUE(w.leadTrajApplied) << "fixture drifted — the estimator declines here";
    ASSERT_NE(w.leadTrajSlope, 0.0);
    ASSERT_NE(w.leadTrajFan, 0.0);
    ASSERT_GT(w.leadPadTopPx + w.leadPadBotPx, 0) << "fixture drifted — no pad to clear";
    // (Measured 66 px here: the drift sweep's frontier is still short of the
    // seed's far edge, so the stale band exists and the live frame overwrote
    // it — every one of the seven is a real number from a real tick.)
    ASSERT_GT(w.leadOverwritePx, 0) << "fixture drifted — no stale band was overwritten";

    // Tick 2: the pre-latch seed, the SAME window.  A stationary hold on a
    // second engine — the reference latches and `refBgr` is held, the axis
    // never latches, and the seed publishes (PanoPreviewSeed's premise).
    cv::Mat tall = makeShelf(kFrameW, 5000);
    rnis::pano::Engine eSeed;
    auto cfgSeed = testConfig();
    ASSERT_TRUE(eSeed.configure(cfgSeed, &err)) << err;
    const cv::Mat still = tall(cv::Rect(0, 200, kFrameW, kFrameH)).clone();
    for (int i = 0; i < 12; ++i) {
        cv::Mat crop = still.clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfgSeed.workScale, cfgSeed.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + i * (1e9 / 60.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.tracking = 2; in.seq = i;
        eSeed.ingest(in);
    }
    ASSERT_FALSE(eSeed.stats().axisLatched)
        << "a stationary hold must not latch — this must be the SEED tick";
    cv::Mat seed;
    ASSERT_TRUE(eSeed.previewIntoFit(seed, 2000, 800, 0, &w, true, true))
        << "the seed did not publish — this tick never took the seed path";
    // The fields the seed already reset, as a control that this IS the seed
    // path filling the window.
    ASSERT_EQ(w.frontierFrac, -1.0);
    ASSERT_EQ(w.leadOutPx, 0);

    // THE SEVEN, back at the struct's own defaults.
    const rnis::pano::PreviewWindow fresh;
    EXPECT_DOUBLE_EQ(w.leadStartU, fresh.leadStartU)
        << "the seed tick published the trajectory tick's lead-out start";
    EXPECT_EQ(w.leadOverwritePx, fresh.leadOverwritePx);
    EXPECT_EQ(w.leadTrajApplied, fresh.leadTrajApplied)
        << "the seed tick says a trajectory was applied to a lead-out it does not have";
    EXPECT_DOUBLE_EQ(w.leadTrajSlope, fresh.leadTrajSlope);
    EXPECT_DOUBLE_EQ(w.leadTrajFan, fresh.leadTrajFan);
    EXPECT_EQ(w.leadPadTopPx, fresh.leadPadTopPx);
    EXPECT_EQ(w.leadPadBotPx, fresh.leadPadBotPx);
}

// ── THE COVERAGE MASK FOR THE DELIVERABLE ──────────────────────────────────
//
// WHY THIS BLOCK EXISTS.  The operator, on his own sweeps: "The final output
// should be cropped to the maximum inscribable rectangle — like we do in
// pano."  Both platforms already implement that crop, and both already PREFER
// a `<image>.coverage.png` sidecar the batch stitcher has written since v0.15.
// pano+ wrote none, so the sweep was the one engine cropping off a BRIGHTNESS
// PROXY — which cannot tell dark CONTENT from unpainted canvas.
//
// Measured on his pack `pp_1789931447063` (1441x1026): the brightness mask put
// the largest inscribed rectangle at 24.3% of the canvas, a thin band across
// the ceiling with the whole room excluded, because a black TV in the middle
// of the frame forced the rectangle above it.  The true answer on the same
// image and the same algorithm is 68.4%.  Border-connected hole filling —
// which both platforms already apply — recovers an interior TV and still loses
// every dark object that TOUCHES the boundary; on that pack he named three:
// "you are excluding high chair on the left, fan on the top and the floor on
// the right, just because they are black".
//
// ⚠ THE ONLY THING THAT MAKES THE MASK USEFUL IS THAT IT IS THE SAME PICTURE.
// A mask cropped, oriented or baked even slightly differently from the canvas
// is WORSE than no mask: the crop would land on a boundary belonging to a
// different image and look like a plausible answer rather than like a bug.
// Every case here is that one property, under the transforms that could break
// it.

TEST(PanoCoverage, IsTheSAMESIZEAsTheDeliverable) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    SweepSpec spec; spec.xs = linearSweep(200, 20, 120);
    SweepResult r = runSweepSpec(shelf, spec, testConfig());

    ASSERT_FALSE(r.canvas.empty());
    ASSERT_FALSE(r.coverage.empty());
    EXPECT_EQ(r.coverage.size(), r.canvas.size());
    EXPECT_EQ(r.coverage.type(), CV_8UC1);
}

TEST(PanoCoverage, SurvivesTheTransposeOfAVerticalSweep) {
    // ⚠ THE CASE THE MASK IS MOST LIKELY TO BE WRONG IN.  A vertical sweep is
    // TRANSPOSED by the finalize bake (`orient`), so a mask rendered through
    // any other path comes out with the canvas's dimensions swapped — which
    // every consumer would reject on the size check, silently falling back to
    // the proxy this file exists to replace.  A silent fallback is how a fix
    // ships and does nothing.
    cv::Mat tall = makeShelf(kFrameW, 5000);
    SweepSpec spec;
    spec.xs = std::vector<double>(120, 0.0);
    spec.ys = linearSweep(200, 18, 120);
    SweepResult r = runSweepSpec(tall, spec, testConfig());

    ASSERT_EQ(r.stats.axis, 1);                 // it really is the vertical arm
    ASSERT_FALSE(r.canvas.empty());
    ASSERT_FALSE(r.coverage.empty());
    EXPECT_GT(r.canvas.rows, r.canvas.cols);    // …and the canvas really is tall
    EXPECT_EQ(r.coverage.size(), r.canvas.size());
}

TEST(PanoCoverage, MarksPaintedPixelsAndOnlyPaintedPixels) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    SweepSpec spec; spec.xs = linearSweep(200, 20, 120);
    SweepResult r = runSweepSpec(shelf, spec, testConfig());
    ASSERT_FALSE(r.coverage.empty());

    const int painted = cv::countNonZero(r.coverage);
    const int total = r.coverage.rows * r.coverage.cols;
    // A rectified sweep leaves a RAGGED cross edge, so the mask must be
    // neither empty (it would crop to nothing) nor everything (it would be
    // indistinguishable from having no mask, which is the bug).
    EXPECT_GT(painted, 0);
    EXPECT_LT(painted, total);
    // The engine's own per-column envelope is the same fact from the other
    // side: it reports a band for columns it painted, so a mask claiming
    // FEWER painted pixels than the envelope's area would be missing content.
    long long envArea = 0;
    for (const auto& e : r.envelope) envArea += std::max(0, e.second - e.first);
    EXPECT_GT(envArea, 0);
    EXPECT_GE((long long)painted * 100, envArea * 50)
        << "the mask has less than half the area the envelope reports painted "
           "— it is not describing this canvas";
}

TEST(PanoCoverage, ABlackSCENEStillReadsAsPAINTED) {
    // ⚠ THE WHOLE POINT, IN ONE CASE — the operator's black TV.  A region
    // with no luminance is exactly what a brightness threshold calls
    // unpainted and exactly what a COVERAGE mask must call painted.  Without
    // this the two masks agree on every other fixture in this file, because
    // every other fixture is a bright synthetic shelf.
    //
    // ⚠ AND THE FIRST CUT OF THIS CASE WAS A TAUTOLOGY.  It asserted
    // `covPainted >= brightPainted` — but an UNPAINTED canvas pixel is
    // always 0, so `threshold(gray, 1, …)` can only ever mark a SUBSET of
    // the painted region.  `bright ⊆ coverage` holds for any correct mask on
    // any scene, bright or dark, so the case could not fail for the bug it
    // names: replacing `finalCoverage`'s body with the brightness proxy
    // itself left it green.  Three review agents found it independently.
    //
    // What is falsifiable is the CONVERSE: there must be pixels the proxy
    // calls unpainted that the engine knows it painted, and they must be the
    // dark ones.  That is false for the proxy and true for a real mask.
    cv::Mat dark = makeShelf(9000, kFrameH);
    // A genuinely BLACK object in the middle of the scene, the height of the
    // frame's centre band.  `convertTo(…, 0.06)` alone is not enough — it
    // scales toward zero but leaves most pixels >= 1, which the threshold
    // still accepts, and the case then measures nothing.
    const int tvX = 3000, tvW = 900;
    dark(cv::Rect(tvX, kFrameH / 4, tvW, kFrameH / 2)).setTo(cv::Scalar(0, 0, 0));
    SweepSpec spec; spec.xs = linearSweep(200, 20, 120);
    SweepResult r = runSweepSpec(dark, spec, testConfig());
    ASSERT_FALSE(r.canvas.empty());
    ASSERT_FALSE(r.coverage.empty());

    // What a brightness mask says about this canvas…
    cv::Mat gray, bright;
    cv::cvtColor(r.canvas, gray, cv::COLOR_BGR2GRAY);
    cv::threshold(gray, bright, 1, 255, cv::THRESH_BINARY);
    const int brightPainted = cv::countNonZero(bright);
    const int covPainted = cv::countNonZero(r.coverage);
    EXPECT_GT(covPainted, 0);

    // THE ASSERTION THAT CAN FAIL: the mask must claim STRICTLY more than the
    // proxy, and the difference must be the black object rather than a
    // rounding edge.  A `finalCoverage` that IS the proxy answers 0 here.
    const int onlyCoverage = cv::countNonZero(r.coverage & ~bright);
    EXPECT_GT(onlyCoverage, 20000)
        << "the coverage mask adds " << onlyCoverage << " painted pixels over "
           "a brightness threshold on a canvas with a black object in it — "
           "that is proxy-shaped, and the proxy is what this exists to replace";
    EXPECT_GT(covPainted, brightPainted);

    // …and the pixels it adds really are DARK ones, not a halo.  Mean luma
    // over the coverage-only set must sit near black; a mask that merely
    // dilated the proxy would land at scene brightness.
    const double meanOnlyCoverage = cv::mean(gray, r.coverage & ~bright)[0];
    EXPECT_LT(meanOnlyCoverage, 8.0)
        << "the pixels the coverage mask adds average " << meanOnlyCoverage
        << " DN — they are not the dark content this case is about";
}

// ── THE LEAD-OUT'S OWN EXTENT ─────────────────────────────────────────────
//
// `SessionStats::tailFlushColumns` is what puts "the last N columns came from
// ONE frame" on the result screen — the operator's "why is there some broken
// parts towards the edges". The PRODUCER is one line inside `Engine::finish()`
// and it had no test: every assertion about the field was against a JS fixture
// that hand-wrote the value, so deleting the line, mis-scoping it into a
// branch the lead-out does not take, or measuring the wrong pair would ship
// green and the line would simply never print.
TEST(PanoTailFlush, ReportsTheExtentTheLeadOutActuallyPainted) {
    const cv::Mat shelf = makeShelf(9000, kFrameH);
    SweepSpec spec; spec.xs = linearSweep(200, 20, 120);

    rnis::pano::Engine eng;
    auto cfg = testConfig();
    std::string err;
    ASSERT_TRUE(eng.configure(cfg, &err)) << err;
    for (size_t i = 0; i < spec.xs.size(); ++i) {
        const int x0 = (int)std::lround(spec.xs[i]);
        cv::Mat crop = shelf(cv::Rect(x0, 0, kFrameW, kFrameH)).clone();
        cv::Mat gray, grayWork;
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        rnis::pano::FrameInput in;
        in.bgr = &crop; in.grayWork = &grayWork;
        in.tsNs = 1e9 + (double)i * (1e9 / 30.0);
        in.fx = kFx; in.fy = kFy; in.cx = kCx; in.cy = kCy;
        in.imageWidth = kFrameW; in.imageHeight = kFrameH;
        in.tracking = 2; in.seq = (int)i;
        eng.ingest(in);
    }
    // THE LEAD-OUT ROW ITSELF — the only place the extent is observable
    // independently of the field under test.
    const rnis::pano::FrameOutcome tail = eng.finish();
    const auto st = eng.stats();

    ASSERT_TRUE(st.tailFlushAttempted);
    ASSERT_TRUE(st.tailFlushed);
    EXPECT_GT(tail.canvasX1, tail.canvasX0) << "the lead-out painted nothing";
    // The field IS the row's extent. A producer that measured the wrong pair,
    // or never ran, answers something else here.
    EXPECT_EQ(st.tailFlushColumns, (int64_t)(tail.canvasX1 - tail.canvasX0));
    EXPECT_GT(st.tailFlushColumns, 0);
    // …and it is a real slice of the deliverable, not a rounding edge. On the
    // operator's iPhone packs this is 13-24%; the bar here is only that it is
    // BIG, because the fixture's geometry is not his.
    cv::Mat canvas;
    ASSERT_TRUE(eng.finalCanvas(canvas));
    EXPECT_GT(st.tailFlushColumns * 200, (int64_t)canvas.cols)
        << "the lead-out owns under 0.5% of the canvas — that is not the "
           "block this field exists to report";
}

TEST(PanoTailFlush, AttemptedIsFalseWhenTheSweepNeverLatched) {
    // ⚠ THE READING THE FIELD'S DOC PRESCRIBES, MADE POSSIBLE. `0 columns`
    // means two different things — a lead-out that ran and painted nothing,
    // and a sweep that never had one — and `tailFlushAttempted` is what
    // separates them. Android's serialiser wrote a literal `true` here, so
    // the distinction did not survive the trip to the pack.
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;
    eng.finish();                       // nothing ingested, no axis latched
    const auto st = eng.stats();
    EXPECT_FALSE(st.tailFlushAttempted);
    EXPECT_FALSE(st.tailFlushed);
    EXPECT_EQ(st.tailFlushColumns, 0);
}

TEST(PanoCoverage, IsEmptyWhenNothingWasPainted) {
    // Negative control: a mask must not exist for a canvas that does not.
    // Without it every case above passes for a `finalCoverage` that returns
    // a blank mat of the right size, which would crop to nothing.
    rnis::pano::Engine eng;
    std::string err;
    ASSERT_TRUE(eng.configure(testConfig(), &err)) << err;
    eng.finish();
    cv::Mat cov;
    EXPECT_FALSE(eng.finalCoverage(cov));
}

// ── THE CANVAS CEILINGS THE LATCH NEVER CHECKED ─────────────────────────────
//
// `commitLatch` sizes the band from the reference footprint —
// `ceil(footprintV) + 2*canvasPadPx` — and compares it to NEITHER
// `canvasMaxHeightPx` NOR `canvasMaxPixels`.  When the result is already at or
// past the height ceiling, `ensureCanvasBand` computes the same `room`,
// returns false, and that refusal is documented as "not a failure — it is the
// point at which clipping becomes REPORTED".  True per frame, and it means a
// band that was DEAD ON ARRIVAL reaches the operator as ordinary clipping,
// identical to a band that grew normally and then ran out.  One of those is a
// configuration error he can act on; the other is the hand drifting.
//
// Both facts are now on SessionStats.  Neither changes a pixel.
TEST(PanoCanvasCeiling, ABandBornPastTheHeightCeilingSaysSoInsteadOfOnlyClipping) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    auto cfg = testConfig();
    // Below the reference footprint (kFrameH * canvasScale + 2*pad), so the
    // band is born with no room at all — the state the engine could not name.
    cfg.canvasMaxHeightPx = 320;
    const auto steps = walkWithTransversePitch(60, 8.0, [](int) { return 0.0; });
    const SweepResult r = runGestureSweep(shelf, steps, cfg);

    // EXACT, not `<= 0`: a field that is simply never written is also <= 0,
    // and an assertion a zeroed field satisfies proves nothing about the
    // computation. (Caught by mutating the assignment to a literal 0.)
    EXPECT_EQ(r.stats.canvasBandRoomPx, cfg.canvasMaxHeightPx - r.stats.canvasH)
        << "canvasH " << r.stats.canvasH << " vs ceiling " << cfg.canvasMaxHeightPx;
    EXPECT_LT(r.stats.canvasBandRoomPx, 0) << "the band should be born past the ceiling";
    // …and the height NEVER grew, which is the consequence that used to be
    // visible only as clipping.
    EXPECT_EQ(r.stats.canvasHeightGrowths, 0);
}

TEST(PanoCanvasCeiling, AHealthyBandReportsRealHeadroomAndAWidthCeiling) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();
    const auto steps = walkWithTransversePitch(60, 8.0, [](int) { return 0.0; });
    const SweepResult r = runGestureSweep(shelf, steps, cfg);

    // Room for at least one 128 px growth step: the band can follow a drift.
    EXPECT_GT(r.stats.canvasBandRoomPx, 128)
        << "canvasH " << r.stats.canvasH;
    EXPECT_EQ(r.stats.canvasBandRoomPx, cfg.canvasMaxHeightPx - r.stats.canvasH);

    // THE MEMORY CEILING BINDS ON THE PRODUCT, so the band's height is bought
    // with reachable sweep extent.  This is the number that connects "my sweep
    // stopped early" to "my band was tall", which nothing reported before.
    ASSERT_GT(r.stats.canvasH, 0);
    const int expect = (int)std::min(
        (double)cfg.canvasMaxWidthPx,
        std::floor(cfg.canvasMaxPixels / (double)r.stats.canvasH));
    EXPECT_EQ(r.stats.canvasMaxWidthAtBand, expect);
    EXPECT_GT(r.stats.canvasMaxWidthAtBand, 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  LATERAL-DRIFT DETECTOR
//
//  These pin the SHAPES, not the thresholds. The thresholds were calibrated
//  against 85 real A35 packs with operator labels (7/7 STOP caught, 0 fires
//  across 77 non-STOP), and that calibration is reproducible on any pack with
//  `rnis_drift_check`. What a unit test can pin — and what reasoning at the
//  keyboard gets wrong — is that a drift and a shake of the SAME AMPLITUDE
//  are separated by construction, that the eligibility floors bite, and that
//  the one correction the corpus forced (vShiftPx) cannot be dropped again.
// ════════════════════════════════════════════════════════════════════════════

namespace {

/// Feed a synthetic sweep through the SHIPPED detector.
/// `posU` advances 10 px a row, which is what makes the slide arm's
/// "sideways beats along-track" term a real test rather than a formality.
rnis::pano::DriftDetector runDrift(
    int rows, double panPerRow, const std::function<double(int)>& crossAt,
    const std::function<double(int)>& posVAt = [](int) { return 0.0; },
    const std::function<double(int)>& vShiftAt = [](int) { return 0.0; },
    int canvasH = 1000) {
    rnis::pano::Config cfg;
    rnis::pano::DriftDetector d;
    for (int i = 0; i < rows; ++i) {
        d.observe(cfg, crossAt(i), i * panPerRow, /*posU=*/i * 10.0, posVAt(i),
                  vShiftAt(i), canvasH);
    }
    return d;
}

}  // namespace

TEST(PanoDrift, AMonotoneLeanFires) {
    // 0.8 deg of cross per 1.0 deg of pan — a lean that eats the band.
    const auto d = runDrift(40, 1.0, [](int i) { return 0.8 * i; });
    EXPECT_EQ(d.level, 2);
    EXPECT_EQ(d.arm, "lean");
    EXPECT_GE(d.firedAtRow, 0);
}

TEST(PanoDrift, AShakeOfTheSameAmplitudeDoesNotFire) {
    // ⚠ THE DISCRIMINATOR, and the whole reason the monotonicity term exists.
    // Peak-to-peak is 20 deg here — LARGER than the lean above — but the net
    // excursion is ~0 because it oscillates, so e/tv collapses. A detector
    // built on peak-to-peak cannot tell these apart at all, which matters
    // because `crossRectifyDeg` is UNSIGNED: max-minus-min of a magnitude
    // conflates a 10 deg one-way lean with a +/-5 deg wobble.
    const auto d = runDrift(40, 1.0, [](int i) {
        return 10.0 * std::sin(static_cast<double>(i));
    });
    EXPECT_EQ(d.level, 0) << "an oscillation is not a drift";
}

TEST(PanoDrift, AShortPanCannotTripTheRatioAlone) {
    // Without the pan floor this is the classic false positive: a tiny pan
    // makes e/pan explode. Taken from a real clean 10.2 deg sweep whose raw
    // cross/pan is 0.301 — above the 0.27 bar an earlier ratio-only rule used.
    const auto d = runDrift(30, 0.05, [](int i) { return 0.10 * i; });
    EXPECT_EQ(d.level, 0) << "the pan floor must reject a ratio spike over no pan";
}

TEST(PanoDrift, ASidewaysSlideFiresOnTheSlideArm) {
    // posV walks 12 px a row against posU's 10 — sideways travel beating
    // along-track travel — with NO cross rotation at all. This is the failure
    // mode arms 1-2 are structurally blind to: in the corpus its two packs
    // rotate 5-10 deg while wandering 22-29% of the band.
    const auto d = runDrift(30, 0.2, [](int) { return 0.0; },
                            [](int i) { return 12.0 * i; });
    EXPECT_EQ(d.level, 2);
    EXPECT_EQ(d.arm, "slide");
}

TEST(PanoDrift, ASweepThatMovesMostlyAlongTrackIsNotASlide) {
    // The mirror of the above: posV drifts, but more slowly than posU
    // advances. That is a slightly sloped pan, not an operator walking
    // sideways, and `|accV| > accU` is what separates them.
    const auto d = runDrift(30, 0.2, [](int) { return 0.0; },
                            [](int i) { return 6.0 * i; });
    EXPECT_LT(d.level, 2) << "along-track travel dominating is a pan, not a slide";
}

TEST(PanoDrift, ABoundedWanderNeverAccumulatesIntoASlide) {
    // ⚠ WHAT THIS ACTUALLY GUARANTEES, stated honestly. The first draft of
    // this test asserted that "wander, correct, wander" never fires — and it
    // failed, correctly: each of its excursions was 180 px against a 60 px
    // bar, so the FIRST wander is a slide on its own and the correction never
    // gets a say. The rule does not forgive a large excursion because it was
    // later undone, and it should not.
    //
    // The real invariant is that bounded hand movement never ACCUMULATES.
    // Here posV oscillates +/-48 px against a 60 px bar, forever, while still
    // out-pacing posU so the sideways term stays armed — the signed
    // accumulator and the reversal restart together keep each run at its own
    // amplitude instead of summing 12 excursions into 576 px of "drift".
    const auto d = runDrift(96, 0.2, [](int) { return 0.0; }, [](int i) {
        const int p = i % 8;
        return (p < 4) ? 12.0 * p : 12.0 * (8 - p);
    });
    EXPECT_LT(d.level, 2) << "bounded oscillation must not sum into a slide";
    EXPECT_LT(d.peakSlideFrac, 0.06);
}

TEST(PanoDrift, AWholeBandVShiftIsNotOperatorMotion) {
    // ⚠ REGRESSION PIN, and it cost six false positives to find.
    // `posV` is the strip's canvas row INCLUDING any whole-band shift applied
    // when the canvas grew, and 7 packs in the corpus carry a single
    // 0 -> 128 px step of it. Reading `posV` raw fired arm 3 on every one of
    // them that was not already labelled bad. The canvas moved under the
    // strip; the operator did not move. So the step appears in BOTH signals,
    // exactly as the ledger records it, and must cancel.
    const double kStep = 128.0;
    const auto step = [&](int i) { return (i >= 20) ? kStep : 0.0; };
    const auto d = runDrift(60, 0.2, [](int) { return 0.0; }, step, step);
    EXPECT_EQ(d.level, 0) << "a band shift is not a slide";
}

TEST(PanoDrift, RebaseClearsTheRunButKeepsTheVerdict) {
    // A relatch discards the canvas, so accumulated excursion describes
    // geometry nobody can see and must be dropped — two packs in the labelled
    // set relatch mid-capture, one of them vouched GOOD. But a drift that
    // already happened still happened, so the VERDICT survives.
    rnis::pano::Config cfg;
    rnis::pano::DriftDetector d;
    for (int i = 0; i < 40; ++i) {
        d.observe(cfg, 0.8 * i, i * 1.0, i * 10.0, 0.0, 0.0, 1000);
    }
    ASSERT_EQ(d.level, 2);
    const int firedAt = d.firedAtRow;
    d.rebase();
    EXPECT_EQ(d.level, 2) << "the verdict is history, not state";
    EXPECT_EQ(d.firedAtRow, firedAt);
    EXPECT_EQ(d.row, 0) << "but the run itself restarts";
    EXPECT_FALSE(d.min_.set);
}

TEST(PanoDrift, TheGuardCanBeTurnedOffAndThenObservesNothing) {
    rnis::pano::Config cfg;
    cfg.driftGuard = false;
    rnis::pano::DriftDetector d;
    for (int i = 0; i < 40; ++i) {
        d.observe(cfg, 0.8 * i, i * 1.0, i * 10.0, 0.0, 0.0, 1000);
    }
    EXPECT_EQ(d.level, 0);
    EXPECT_EQ(d.row, 0);
}

// ── PROVENANCE OF THE DELIVERED ALONG AXIS ─────────────────────────────────
//
// These exist because the split was reconstructed by hand twice and got wrong
// twice — once by assuming the seed began at `firstStrip - frameWidth/2`, and
// once by splitting the output along the WRONG AXIS entirely. A number the
// engine STATES cannot be got wrong by a reader; one it leaves to inference
// will be.

TEST(PanoProvenance, TheThreeSpansSumToTheAlongExtent) {
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();
    const auto steps = walkWithTransversePitch(60, 8.0, [](int) { return 0.0; });
    const SweepResult r = runGestureSweep(shelf, steps, cfg);
    ASSERT_GT(r.stats.paintedW, 0);
    EXPECT_EQ(r.stats.provenanceSeedPx + r.stats.provenanceStripPx
                  + r.stats.provenanceTailPx,
              r.stats.paintedW)
        << "a split that does not account for every along-axis pixel is not a "
           "split, it is three unrelated numbers";
}

TEST(PanoProvenance, AHealthySweepIsNotAllOneFrame) {
    // The negative control for the field itself: a `provenanceStripPx` stuck
    // at zero would make every panorama look like one frame and be meaningless.
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto steps = walkWithTransversePitch(60, 8.0, [](int) { return 0.0; });
    const SweepResult r = runGestureSweep(shelf, steps, testConfig());
    EXPECT_GT(r.stats.provenanceStripPx, 0);
}

TEST(PanoProvenance, TheSeedAndTailAreCountedSeparatelyFromTheStrips) {
    // The seed is painted WHOLE and the strips then begin at its CENTRE, so a
    // leading span is never overpainted; the tail flush adds a trailing one.
    // Both are ONE frame from ONE pose. If either were folded into the strip
    // count, "how much of this is slit-scanned" would be unanswerable.
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto steps = walkWithTransversePitch(60, 8.0, [](int) { return 0.0; });
    const SweepResult r = runGestureSweep(shelf, steps, testConfig());
    EXPECT_GT(r.stats.provenanceSeedPx + r.stats.provenanceTailPx, 0)
        << "every sweep has a seed; one with neither a seed nor a lead-out "
           "span means the tracking is not running";
    EXPECT_LT(r.stats.provenanceStripPx, r.stats.paintedW)
        << "the strips cannot be the whole along extent";
}

TEST(PanoProvenance, TheAlongAxisIsReportedNotInferred) {
    // ⚠ THE FIELD THAT MATTERS TO A READER. `orient()` transposes when
    // `axis == 1`, so a VERTICAL sweep's along axis is output **Y** — and
    // splitting such a panorama by COLUMNS is 90° wrong. Inferring it from
    // pixels keeps failing because scene texture swamps every seam metric, so
    // the engine says it outright.
    const cv::Mat shelf = makeShelf(7000, 4200);
    const auto cfg = testConfig();
    const auto steps = walkWithTransversePitch(60, 8.0, [](int) { return 0.0; });
    const SweepResult r = runGestureSweep(shelf, steps, cfg);
    const bool quarter = (cfg.outputRotationCwDeg == 90
                       || cfg.outputRotationCwDeg == 270);
    EXPECT_EQ(r.stats.alongAxisIsOutputY, (r.stats.axis == 1) != quarter);
}

// THE TRIM'S KEEP BRANCH, ON A SWEEP WITH STRIPS.  With the seed junction met
// (`seedFrontierMeet`), the first strip starts at its OWN left edge rather
// than at the seed's centre, so a band of lead-in columns right after the
// centre is reached by no later frame at all — the seed is the only content
// there and the trim must KEEP it.  A resolve that cleared every mark once
// any strip existed (ignoring whether a later frame passed the column) left a
// full-height black band of 19 columns at the junction here and passed every
// other test in this file.
TEST(PanoSeedLeadTrim, KeepsTheSeedWhereNoLaterFrameReachedEvenWithStrips) {
    const cv::Mat shelf = makeShelf(6000, 3400);
    auto cfg = seedMeetConfig(true);
    ASSERT_TRUE(cfg.seedLeadTrim);
    const SweepResult r = runProjectedSweep(shelf, seedMeetSweep(), cfg);
    ASSERT_TRUE(r.stats.axisLatched);
    ASSERT_FALSE(r.coverage.empty());
    EXPECT_TRUE(r.holes.empty()) << r.holes.size() << " unpainted runs";
    // Every along line of the delivered raster carries something.
    const bool horizontal = r.stats.axis == 0;
    const int lines = horizontal ? r.coverage.cols : r.coverage.rows;
    int empty = 0;
    for (int i = 0; i < lines; ++i) {
        const cv::Mat line = horizontal ? r.coverage.col(i) : r.coverage.row(i);
        if (cv::countNonZero(line) == 0) ++empty;
    }
    EXPECT_EQ(empty, 0)
        << "the trim blanked " << empty << " whole lines — seed columns no "
           "later frame reached were cleared instead of kept";
}
