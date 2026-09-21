// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano.cpp — pano+ slit-scan engine core.
//
// ⚠ HAND-WRITTEN.  This file is not produced by any codegen step and has no
// generated ancestor.
//
// See rnis_pano.hpp for the coordinate contract and the seven algorithm
// steps.  The load-bearing invariants this file must never break:
//
//   * SINGLE OWNER — a column is committed exactly once, by the frame that
//     first pushes the frontier past it (plus a bounded provisional lead-in /
//     lead-out ahead of the frontier that later frames REPLACE, never blend).
//   * ZERO DUPLICATION — nothing is ever painted behind the high-water mark,
//     so a backtrack cannot lay the same content down twice.
//   * ZERO GAPS — every strip is extended leftward to the frontier, so the
//     committed width per frame equals the measured advance exactly.  A frame
//     whose whole footprint is already past the frontier is BACKFILLED from
//     the previous painted frame (which did see those columns); only when
//     even that frame cannot reach is a hole reported, as GapBreak — never
//     silent.
//   * NO SILENT PERPENDICULAR LOSS — the canvas grows across the sweep axis
//     too, and whatever is still outside the band after growth is COUNTED
//     (clippedFrames / clipTopPx / clipBotPx).  A vertically truncated
//     panorama must never look identical to a clean one, which is exactly
//     what a sweep-axis-only hole gate would let happen.
//   * NO SILENT ALIASING — an advance beyond the cage is REJECTED and the
//     chain is NOT advanced.  The engine never widens its search.

#include "rnis_pano.hpp"

// Shared canvas guard, consumed in place from the package's own cpp/ root.
#include "warp_guard.hpp"

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <limits>
#include <string>
#include <vector>

namespace rnis {
namespace pano {

// ── The preview publisher.  See the header for the eleven days it cost. ─────
bool publishJpegAtomically(const std::string& path, const cv::Mat& img,
                           int quality, std::string* err) {
    const auto fail = [err](const std::string& why) {
        if (err) *err = why;
        return false;
    };
    if (err) err->clear();
    if (path.empty()) return fail("empty destination path");
    if (img.empty())  return fail("empty image");

    std::vector<unsigned char> bytes;
    try {
        const std::vector<int> params{cv::IMWRITE_JPEG_QUALITY,
                                      std::min(100, std::max(1, quality))};
        // ".jpg" IS A LITERAL.  It is not derived from `path`, and that is the
        // entire point of this function — see the header.
        if (!cv::imencode(".jpg", img, bytes, params) || bytes.empty()) {
            return fail("cv::imencode(\".jpg\") produced no bytes");
        }
    } catch (const cv::Exception& e) {
        return fail(std::string("cv::imencode threw: ") + e.what());
    } catch (const std::exception& e) {
        return fail(std::string("cv::imencode threw: ") + e.what());
    }

    // TMP + RENAME, because JS polls this path and must never read a half
    // file.  stdio has no opinion about the temp file's extension, which is
    // exactly why the bytes go through it rather than through cv::imwrite.
    // Same directory as the destination, so the rename is within one
    // filesystem and therefore atomic.
    const std::string tmp = path + ".part";
    std::FILE* f = std::fopen(tmp.c_str(), "wb");
    if (f == nullptr) return fail("could not open " + tmp + " for writing");
    const size_t wrote  = std::fwrite(bytes.data(), 1, bytes.size(), f);
    const bool  flushed = (std::fflush(f) == 0);
    const bool  closed  = (std::fclose(f) == 0);
    if (wrote != bytes.size() || !flushed || !closed) {
        std::remove(tmp.c_str());
        return fail("short write to " + tmp + " (" + std::to_string(wrote) +
                    " of " + std::to_string(bytes.size()) + " bytes)");
    }
    if (std::rename(tmp.c_str(), path.c_str()) != 0) {
        // Leaving the .part behind would accumulate one stale file per failed
        // publish inside the pack the operator has to ship us.
        std::remove(tmp.c_str());
        return fail("could not rename " + tmp + " onto " + path);
    }
    return true;
}

const char* outcomeName(Outcome o) {
    switch (o) {
        case Outcome::Painted:             return "painted";
        case Outcome::HeldBacktrack:       return "held-backtrack";
        case Outcome::SkippedNoAdvance:    return "skipped-no-advance";
        case Outcome::RejectedLowResponse: return "rejected-low-response";
        case Outcome::RejectedOutOfCage:   return "rejected-out-of-cage";
        case Outcome::WarmingUp:           return "warming-up";
        case Outcome::Bootstrap:           return "bootstrap";
        case Outcome::GapExtended:         return "gap-extended";
        case Outcome::GapBreak:            return "gap-break";
        case Outcome::AbortedTracking:     return "aborted";
        case Outcome::CanvasFull:          return "canvas-full";
        case Outcome::RejectedRectify:     return "rejected-rectify";
        case Outcome::RejectedInput:       return "rejected-input";
        case Outcome::TailFlush:           return "tail-flush";
        case Outcome::HeldFrontier:        return "held-frontier";
        case Outcome::RejectedPoseSpeed:   return "rejected-pose-speed";
        case Outcome::RejectedTracking:    return "rejected-tracking";
        case Outcome::GapBackfilled:       return "gap-backfilled";
        case Outcome::JogHeld:             return "d8-jog-held";
    }
    return "unknown";
}

// ── v10: LENS UNDISTORTION — model, table, gate, LUT ────────────────────────
namespace lens {

const char* gateName(Gate g) {
    switch (g) {
        case Gate::Disabled:      return "disabled";
        case Gate::UnknownDevice: return "unknown-device";
        case Gate::LensMismatch:  return "lens-mismatch";
        case Gate::FocalMismatch: return "focal-mismatch";
        case Gate::NoIntrinsics:  return "no-intrinsics";
        case Gate::Applied:       return "applied";
        case Gate::Override:      return "override";
        case Gate::LutFailed:     return "lut-failed";
    }
    return "unknown";
}

namespace {
/// THE SHIPPED TABLE.  One row per (body, lens) that has actually been
/// calibrated.  Adding a device means adding a row here with its provenance —
/// there is no fallback row, and no interpolation between rows, because a
/// neighbouring iPhone's lens is a different piece of glass.
///
/// iPhone17,1 wide: plumb-line fit on the operator's own slat wall over the
/// four packs of 2026-08-20 (offline lens fit, k1_cum/k2_cum).
/// Per-pack k1 spans −0.0231..−0.0240 (3.7 % spread) with a bootstrap 1σ of
/// 0.0018-0.0023, i.e. the four captures agree to well inside their own
/// scatter.  fxOverWidth is the mean of ARKit's own per-frame fx ÷ 1920 across
/// those packs (measured range 0.69404-0.69743 — that spread IS focus
/// breathing, which is why the gate has a tolerance rather than an equality).
///
/// iPhone17,1 ultra-wide (v13, 2026-08-31): plumb-line fixpoint fit with the
/// SAME tooling on the three dense tau=0 packs (the two sparse living-room
/// packs contributed arched pelmets — real curvature, not lens — and were
/// excluded; the contaminated {1,2,3} split that included them is recorded in
/// uw_fit.json, not shipped).  Frames are NOT raw barrel: the ISP already
/// delivers mostly-rectilinear ultra-wide video (gdcEnabled=false
/// notwithstanding), and this row corrects the stable MOUSTACHE residual that
/// remains — border-third line sag median 0.78→0.61 px, p95 4.87→3.81, every
/// pack improved, peak corner move 19.1 px.  Honest amplitude uncertainty
/// ±10-15% (defensible arms: clean {2,4,5} −0.0365/+0.0188, all-5
/// −0.0371/+0.0191, dense-split −0.0328/+0.0170).  fxOverWidth is the mean
/// DELIVERED per-frame fx ÷ 1920 (0.40328-0.40585 measured; fovDerivedFx
/// 0.3933 is NOT the calibrated focal and must not gate this row).
constexpr Entry kTable[] = {
    {"iPhone17,1", "AVCaptureDeviceTypeBuiltInWideAngleCamera", 0.6952,
     -0.024106415924339927, 0.026764126525081398,
     "plumb-line fit, 4 operator packs 2026-08-20 "
     "(results/2026-08-24-panoplus-noise/lens_iter.json)"},
    {"iPhone17,1", "AVCaptureDeviceTypeBuiltInUltraWideCamera", 0.4056,
     -0.03648853362274224, 0.01880303705846588,
     "plumb-line fixpoint fit, 3 dense operator packs 2026-08-31 tau=0 set "
     "(results/2026-08-31-uwfit/clean_fit.json)"},
};
}  // namespace

const Entry* table(size_t* count) {
    if (count) *count = sizeof(kTable) / sizeof(kTable[0]);
    return kTable;
}

/// NOTE ON RASTER SCALE, because it is not obvious and it is load-bearing:
/// the host rescales ARKit's intrinsics to the raster it actually copied
/// (RNISPanoCore.mm, `intrinsicsRescaled`).  BOTH the gate's ratio
/// (fx ÷ imageWidth) and the model's normalised coordinates ((x−cx)/fx) are
/// INVARIANT under that rescale, so a buffer that disagrees with
/// `camera.imageResolution` changes neither the verdict nor the correction.
Decision resolve(const Config& cfg, double fx, int imageWidth) {
    Decision d;
    if (!cfg.lensUndistort) {
        d.gate = Gate::Disabled;
        return d;
    }
    if (cfg.lensModelOverride) {
        d.gate = Gate::Override;
        d.model.k1 = cfg.lensK1;
        d.model.k2 = cfg.lensK2;
        d.source = "config-override";
        if (fx > 1.0 && imageWidth > 0) d.fxOverWidth = fx / (double)imageWidth;
        return d;
    }
    // The body first: an unknown body is UNKNOWN, never "probably like the one
    // we calibrated".  An empty string lands here too, deliberately.
    //
    // ⚠️ THE LENS IS PART OF THE KEY, NOT A CHECK APPLIED AFTERWARDS.  This
    // loop matched on `device` alone and `break`ed on the first hit.  With two
    // rows for one body — wide first, ultra-wide second, both fitted — an
    // iPhone17,1 ALWAYS selected the wide row, and the ultra-wide name then
    // disagreed with it three lines below and returned LensMismatch.  The v13
    // ultra-wide calibration (2026-08-31, clean_fit.json) was therefore
    // unreachable from the day it shipped: dead code that the table, the tests
    // and the fit's own evidence all said was live.
    //
    // MEASURED on Test-14 pano+ pack 23-00-43 (the only 0.5x sweep in the
    // corpus): `lens.applied=false, gate="lens-mismatch"`, k1=k2=0,
    // correctedStrips=0 — and `expectedFxOverWidth` stamped 0.6952, the WIDE
    // row's number, against ultra-wide frames whose measured ratio is 0.4056.
    // That last detail is how the bug identifies itself in any pack: a gate
    // that reports the expectation of a row it should never have chosen.
    //
    // An UNNAMED lens still matches on body alone, and must: ARKit world
    // tracking streams the back wide-angle camera without naming it, and every
    // ARKit pano+ pack in the corpus relies on that path.  So an empty
    // `lensDeviceLens` takes the FIRST row for the body — which is the wide row,
    // which is the camera ARKit actually streams — and the focal check below
    // remains the arbiter for that case.  Naming the lens is what makes the
    // choice exact; not naming it is not an error.
    const Entry* row = nullptr;
    bool bodyKnown = false;
    size_t n = 0;
    const Entry* t = table(&n);
    for (size_t i = 0; i < n; ++i) {
        if (cfg.lensDeviceModel != t[i].device) continue;
        bodyKnown = true;
        if (!cfg.lensDeviceLens.empty() && t[i].lens != nullptr
            && cfg.lensDeviceLens != t[i].lens) {
            continue;  // right body, wrong lens — keep looking for its row
        }
        row = &t[i];
        break;
    }
    if (row == nullptr) {
        // TWO different refusals, and collapsing them would lose the one fact
        // that tells a calibration gap from an unsupported phone.  A body we
        // have never fitted is UnknownDevice.  A body we HAVE fitted, running a
        // lens we have not, is a LensMismatch — the lens really did switch to
        // one with no row, which is precisely what the ultra-wide reported
        // before it had a row of its own.  Reporting the second as
        // UnknownDevice would say "we do not know this iPhone", which is false
        // and points any future investigation at the wrong table.
        d.gate = bodyKnown ? Gate::LensMismatch : Gate::UnknownDevice;
        if (fx > 1.0 && imageWidth > 0) d.fxOverWidth = fx / (double)imageWidth;
        return d;
    }
    d.expectedFxOverWidth = row->fxOverWidth;
    // The lens BY NAME is settled by the SELECTION above — a named lens either
    // found its own row or fell to the LensMismatch return, so a row in hand
    // whose lens disagrees is no longer reachable here.
    //
    // THE FOCAL CHECK IS STILL THE LAST WORD, and promoting the name from a
    // post-hoc check to part of the selection KEY is only safe BECAUSE it is.
    // The name is the host's claim; this reads the FRAMES.  Two cases need it:
    //   • the UNNAMED lens, which takes the body's first row on trust, and
    //   • a MISNAMED lens, which now selects a row it does not belong to.
    // Both are refused here, because the shipped rows' focals are 71 % apart
    // against a ±4 % tolerance — a separation that is itself pinned by
    // PanoLens.TheUltraWideRowIsPresentAndGatesOnItsOwnFocal.  If a future row
    // lands within tolerance of another, that test fails FIRST, and it must:
    // this branch would then silently apply one lens's coefficients to
    // another's pixels, which is the exact outcome the gate exists to prevent.
    if (!(fx > 1.0) || imageWidth <= 0 || !std::isfinite(fx)) {
        d.gate = Gate::NoIntrinsics;
        return d;
    }
    d.fxOverWidth = fx / (double)imageWidth;
    const double tol = std::fabs(cfg.lensFocalTolFrac) * row->fxOverWidth;
    if (std::fabs(d.fxOverWidth - row->fxOverWidth) > tol) {
        d.gate = Gate::FocalMismatch;
        return d;
    }
    d.gate = Gate::Applied;
    d.model.k1 = row->k1;
    d.model.k2 = row->k2;
    d.source = row->source ? row->source : "";
    return d;
}

void RadialLut::build(const Model& m, double maxIdealRadius, int nodes) {
    model_ = m;
    lut_.clear();
    invStep_ = 0.0;
    valid_ = false;
    identity_ = (std::fabs(m.k1) < 1e-15 && std::fabs(m.k2) < 1e-15);
    if (!std::isfinite(maxIdealRadius) || maxIdealRadius <= 0.0) return;
    if (!std::isfinite(m.k1) || !std::isfinite(m.k2)) return;
    if (nodes < 16) nodes = 16;
    maxRr_ = maxIdealRadius * maxIdealRadius;
    step_ = maxRr_ / (double)(nodes - 1);
    if (!(step_ > 0.0) || !std::isfinite(step_)) return;
    invStep_ = 1.0 / step_;
    lut_.resize((size_t)nodes, 1.0);
    if (identity_) { valid_ = true; return; }
    // NEWTON on r·(1 + k1r² + k2r⁴) = ru, node by node.  This is the same
    // inversion `lens_fit.undistort_maps` runs per pixel; doing it 1024 times
    // at build instead of 2.8 M times per frame is the entire cost argument.
    for (int i = 0; i < nodes; ++i) {
        const double ru = std::sqrt(step_ * (double)i);
        if (ru <= 1e-12) { lut_[(size_t)i] = 1.0; continue; }
        double r = ru;
        for (int it = 0; it < 40; ++it) {
            const double rr = r * r;
            const double f = r * (1.0 + m.k1 * rr + m.k2 * rr * rr) - ru;
            const double fp = 1.0 + 3.0 * m.k1 * rr + 5.0 * m.k2 * rr * rr;
            r -= f / std::max(fp, 1e-9);
        }
        if (!std::isfinite(r) || r <= 0.0) return;   // model is not invertible here
        lut_[(size_t)i] = r / ru;
    }
    valid_ = true;
}

double RadialLut::scaleForRadiusSq(double rr) const {
    if (!valid_ || identity_ || lut_.empty()) return 1.0;
    if (!(rr > 0.0) || !std::isfinite(rr)) return lut_.front();
    if (rr >= maxRr_) return lut_.back();
    const double t = rr * invStep_;
    const size_t i = (size_t)t;
    if (i + 1 >= lut_.size()) return lut_.back();
    const double f = t - (double)i;
    return lut_[i] + (lut_[i + 1] - lut_[i]) * f;
}

}  // namespace lens

namespace {

using Mat33 = cv::Matx33d;

/// Unit quaternion [x, y, z, w] → 3×3 rotation.  A zero/degenerate
/// quaternion degrades to identity rather than producing NaNs downstream.
Mat33 quatToR(const double q[4]) {
    double x = q[0], y = q[1], z = q[2], w = q[3];
    const double n = std::sqrt(x * x + y * y + z * z + w * w);
    if (!(n > 1e-9) || !std::isfinite(n)) return Mat33::eye();
    x /= n; y /= n; z /= n; w /= n;
    return Mat33(
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w),
        2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y));
}

Mat33 kMat(double fx, double fy, double cx, double cy) {
    return Mat33(fx, 0, cx, 0, fy, cy, 0, 0, 1);
}

Mat33 kInv(double fx, double fy, double cx, double cy) {
    return Mat33(1.0 / fx, 0, -cx / fx, 0, 1.0 / fy, -cy / fy, 0, 0, 1);
}

Mat33 translate(double tx, double ty) {
    return Mat33(1, 0, tx, 0, 1, ty, 0, 0, 1);
}

Mat33 scaleM(double s) { return Mat33(s, 0, 0, 0, s, 0, 0, 0, 1); }

/// Axis/sign remap: NATURAL canvas (x right, y down) → INTERNAL canvas
/// (u = the monotone sweep coordinate, v = the perpendicular one).
///   axis 0 (horizontal sweep): u =  sign·x, v = y
///   axis 1 (vertical   sweep): u =  sign·y, v = x
/// Orthogonal by construction, so the finalize bake is an exact flip /
/// transpose — never a resampling.
Mat33 axisMatrix(int axis, int sign) {
    const double s = sign < 0 ? -1.0 : 1.0;
    if (axis == 0) return Mat33(s, 0, 0, 0, 1, 0, 0, 0, 1);
    return Mat33(0, s, 0, 1, 0, 0, 0, 0, 1);
}

/// R_sweep(ψ) — the rotation about the LATCHED SWEEP AXIS, CV frame.
///
/// Defined so that a pure R_sweep(ψ) moves the rectified frame centre by
/// +f·tan(ψ) along the natural canvas axis the sweep runs on (natural x for
/// axis 0, natural y for axis 1).  v5 places it at +f·ψ instead — ARC LENGTH
/// rather than the tangent — and that substitution is the whole of the
/// cylindrical fix.
Mat33 sweepRotation(int axis, double psi) {
    const double c = std::cos(psi), s = std::sin(psi);
    if (axis == 0) return Mat33(c, 0, s, 0, 1, 0, -s, 0, c);   // yaw, CV +Y
    return Mat33(1, 0, 0, 0, c, s, 0, -s, c);                  // pitch, CV +X
}

/// The component of `dR_cv` about the latched sweep axis, radians.
double sweepAngle(int axis, const Mat33& dR) {
    if (axis == 0) return std::atan2(dR(0, 2), dR(2, 2));
    return std::atan2(dR(1, 2), dR(2, 2));
}

/// Total rotation angle (degrees) encoded by a rotation matrix.
double rotationAngleDeg(const Mat33& R) {
    const double tr = R(0, 0) + R(1, 1) + R(2, 2);
    double c = 0.5 * (tr - 1.0);
    c = std::max(-1.0, std::min(1.0, c));
    return std::acos(c) * 180.0 / CV_PI;
}

bool mapPoint(const Mat33& H, double x, double y, double* ox, double* oy) {
    const double w = H(2, 0) * x + H(2, 1) * y + H(2, 2);
    if (!std::isfinite(w) || std::fabs(w) < 1e-9) return false;
    const double px = (H(0, 0) * x + H(0, 1) * y + H(0, 2)) / w;
    const double py = (H(1, 0) * x + H(1, 1) * y + H(1, 2)) / w;
    if (!std::isfinite(px) || !std::isfinite(py)) return false;
    *ox = px; *oy = py;
    return true;
}

/// Axis-aligned bounds of the image rect (0,0)-(w,h) mapped through `H`.
bool mapBounds(const Mat33& H, int w, int h,
               double* u0, double* u1, double* v0, double* v1) {
    const double xs[4] = {0.0, (double)w, (double)w, 0.0};
    const double ys[4] = {0.0, 0.0, (double)h, (double)h};
    double mnx = 0, mxx = 0, mny = 0, mxy = 0;
    for (int i = 0; i < 4; ++i) {
        double px = 0, py = 0;
        if (!mapPoint(H, xs[i], ys[i], &px, &py)) return false;
        if (i == 0) { mnx = mxx = px; mny = mxy = py; }
        else {
            mnx = std::min(mnx, px); mxx = std::max(mxx, px);
            mny = std::min(mny, py); mxy = std::max(mxy, py);
        }
    }
    *u0 = mnx; *u1 = mxx; *v0 = mny; *v1 = mxy;
    return true;
}

/// |det J| of `H` at source px (x, y), relative to canvasScale² — the
/// RESAMPLING ratio (source px area → canvas px area).
double areaScaleAt(const Mat33& H, double x, double y, double canvasScale) {
    const double d = 1.0;
    double px = 0, py = 0, qx = 0, qy = 0, rx = 0, ry = 0;
    if (!mapPoint(H, x, y, &px, &py)) return 1.0;
    if (!mapPoint(H, x + d, y, &qx, &qy)) return 1.0;
    if (!mapPoint(H, x, y + d, &rx, &ry)) return 1.0;
    const double ax = qx - px, ay = qy - py;
    const double bx = rx - px, by = ry - py;
    const double det = std::fabs(ax * by - ay * bx) / (d * d);
    const double ref = canvasScale * canvasScale;
    return (ref > 1e-12) ? det / ref : 1.0;
}

/// THE WARPING NUMBER, absolute: how much larger the composite renders a
/// patch of the world here than it renders the same solid angle on the
/// REFERENCE optical axis.
///
///   m = |det J(H)| · fx·fy / (cos³θ_in · canvasScale² · refFx·refFy)
///
/// For a tangent-plane (gnomonic) canvas this evaluates to sec³θ_out with
/// θ_out the ray's angle off the reference axis — the sec³ blow-up the
/// operator sees as a stretched floor.  1.0 = no distortion; one ordinary
/// photo from a 1335 px-focal 1920×1440 camera already reaches 2.45 at its
/// own corner, which is the right scale to read these against.
double areaMagnification(const Mat33& H, double x, double y, double canvasScale,
                         double fx, double fy, double cx, double cy,
                         double refFx, double refFy) {
    const double j = areaScaleAt(H, x, y, canvasScale);
    const double u = (fx > 1e-9) ? (x - cx) / fx : 0.0;
    const double v = (fy > 1e-9) ? (y - cy) / fy : 0.0;
    const double invCos3 = std::pow(1.0 + u * u + v * v, 1.5);
    const double ref = refFx * refFy;
    if (!(ref > 1e-9)) return j;
    return j * (fx * fy) / ref * invCos3;
}

/// Keep a sample vector SORTED at insert time.
///
/// stats() is called once per ingested frame by the session owner and MOST
/// ingested frames commit a strip, so a dirty-flag cache around a std::sort
/// still sorts on nearly every frame — the O(n log n) it was meant to remove
/// survives, and it survives INVISIBLY, because FrameOutcome::engineMs is
/// stamped before stats() runs.  A sorted insert is one memmove (11 KB at the
/// 2700-strip ceiling this engine's canvasMaxWidthPx implies) and leaves
/// stats() with no work at all.
void insertSorted(std::vector<float>& v, float x) {
    v.insert(std::lower_bound(v.begin(), v.end(), x), x);
}

/// Linear-interpolated percentile of an ALREADY-SORTED sample.
double percentileOf(const std::vector<float>& v, double q) {
    if (v.empty()) return 0.0;
    if (v.size() == 1) return (double)v[0];
    const double pos = (q / 100.0) * (double)(v.size() - 1);
    const size_t lo = (size_t)std::floor(pos);
    const size_t hi = std::min(v.size() - 1, lo + 1);
    const double t = pos - (double)lo;
    return (double)v[lo] * (1.0 - t) + (double)v[hi] * t;
}

/// THE VERDICT'S PHOTOMETRIC MAX BAR, named once.  It is read in two places
/// now — the clause itself and the count of boundaries that breached it — and
/// two copies of 3.00 that can drift apart is one copy too many.
constexpr double kSeamPhotoStepMaxBarDN = 3.00;

double nowMs() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(
               clock::now().time_since_epoch()).count();
}

/// Mean luminance (simple channel average — a scalar exposure proxy, not a
/// colorimetric luma) over `mask`.  Returns < 0 when the mask is empty.
// ── v6: LINEAR-LIGHT EXPOSURE LUT ───────────────────────────────────────────
// Exposure is linear in scene RADIANCE; the raster is gamma-encoded.  Scaling
// the encoded values by an exposure ratio is therefore wrong wherever the
// ratio is not ≈1, and the ratio an UNLOCKED auto-exposure produces over a
// sweep is 1.5-1.8× (measured on the operator's four packs).  So the exposure
// normalisation decodes to linear light, scales, and re-encodes — via a
// 256-entry LUT, so it costs one cv::LUT pass over the strip ROI.
//
// The RESIDUAL overlap corrector deliberately does NOT go through here: it is
// both FITTED and APPLIED on encoded means, so it is self-consistent in that
// domain, and moving it would change every committed pixel of every existing
// pack for no measured reason.
double srgbDecode(double e) {
    return (e <= 0.04045) ? (e / 12.92) : std::pow((e + 0.055) / 1.055, 2.4);
}
double srgbEncode(double l) {
    if (l <= 0.0) return 0.0;
    return (l <= 0.0031308) ? (12.92 * l)
                            : (1.055 * std::pow(l, 1.0 / 2.4) - 0.055);
}
/// Fill `lut` (256 bytes, CV_8U 1×256) with encoded→encoded for a LINEAR
/// radiance gain of `g`.  g == 1 is the identity map, exactly.
void buildExposureLut(double g, cv::Mat& lut) {
    if (lut.empty() || lut.type() != CV_8UC1 || lut.total() != 256)
        lut.create(1, 256, CV_8UC1);
    uchar* p = lut.ptr<uchar>(0);
    for (int v = 0; v < 256; ++v) {
        const double lin = srgbDecode((double)v / 255.0) * g;
        const double enc = srgbEncode(lin) * 255.0;
        p[v] = cv::saturate_cast<uchar>(cvRound(enc));
    }
}

double maskedMeanLuma(const cv::Mat& bgr, const cv::Mat& mask) {
    if (bgr.empty() || mask.empty()) return -1.0;
    if (cv::countNonZero(mask) < 16) return -1.0;
    const cv::Scalar m = cv::mean(bgr, mask);
    return (m[0] + m[1] + m[2]) / 3.0;
}

}  // namespace

// ── the sub-pixel estimator, exposed for the host tests ─────────────────────
namespace detail {

/// THE SUB-PIXEL SUPPORT RULE (measured 2026-08-24, NOT adopted as a default).
/// `cv::phaseCorrelate` reads its peak with
/// a weighted centroid over a support HARD-WIRED to 5×5 WORK px.  Work px are
/// not a physical unit: at `workScale` 0.5 a 5×5 support spans 10 SOURCE px,
/// and raising the work scale without widening the support shrinks the part of
/// the correlation surface the sub-pixel read averages.
///
/// That matters because on a REAL inter-frame pair the surface is BROAD, not a
/// needle.  After rectification the two frames still differ by a residual
/// scale change, parallax and rolling shutter, so the window sees a
/// DISTRIBUTION of displacements and the surface is that distribution.  Its
/// centroid is the mean; its argmax is only the mode.  Measured on the four
/// operator packs by triangle closure (offline harness results,
/// 2026-08-24-panoplus-noise/): reading the peak MORE sharply — Foroosh's
/// closed form, an upsampled-DFT refinement, a 13×13 centroid — makes the
/// estimator 1.2-2.0× WORSE, on every pack.  Keeping the support at ~10 source
/// px while raising the work scale makes it 0.64× better, on every pack.
///
/// Returns the odd support, in WORK px, for a given work scale.  0.5 → 5,
/// i.e. the shipped `cv::phaseCorrelate` behaviour is the ws 0.5 member of
/// this family, not a special case outside it.
bool crossTrajFanWithinSpan(double fan, double spanPx, double relaxPx) {
    if (!std::isfinite(fan) || !std::isfinite(spanPx)) return false;
    if (fan == 0.0) return true;
    if (!(spanPx > 0.0)) return false;
    double reach = spanPx;
    if (relaxPx > 0.0) reach = relaxPx * (1.0 - std::exp(-spanPx / relaxPx));
    return std::fabs(fan) * reach <= 0.3;
}

int centroidBoxFor(double workScale) {
    // The NEAREST ODD integer to 10*workScale, ties broken DOWNWARD (a tie
    // means two supports are equally close to 10 source px, and the narrower
    // one is the one the packs were measured with at work scale 1.0).
    const int k = (int)std::ceil((10.0 * workScale - 1.0) * 0.5 - 0.5);
    return std::max(3, std::min(15, 2 * k + 1));
}

/// Phase correlation with an EXPLICIT centroid support.
///
/// Line for line the estimator `cv::phaseCorrelate` implements — Hann,
/// whitened cross-power spectrum, inverse transform, fftShift, weighted
/// centroid — with two deliberate differences:
///
///   * the centroid support is `box`, not a hard-wired 5;
///   * `*response` is ALWAYS computed on the 5×5 support, whatever `box` is.
///     The response is not an estimate, it is the aliasing cage's gate signal that
///     `minPhaseResponse` and `stallResumeResponse` are calibrated against —
///     letting the support silently rescale it would move both gates as a side
///     effect of an estimator change, which is exactly the defect the v3
///     stallResumeResponse note records.
///
/// Neither input is modified (`cv::phaseCorrelate` multiplies BOTH by the
/// window in place), so the corrPrev/corrCur scratch copies at the call sites
/// are belt-and-braces from here on rather than load-bearing.
/// THE WHITENED CROSS-POWER SURFACE of (a, b), fftShifted so zero
/// displacement sits at the raster centre — everything phaseShiftBoxImpl does
/// before it reads the peak, factored out so the gate's peak-shape statistics
/// (phasePeakStats) walk the SAME surface by the same arithmetic rather than a
/// re-derivation of it.  Operation for operation what the estimator ran
/// before this was split out; the split moved no numerics.
static void whitenedSurface(const cv::Mat& a, const cv::Mat& b,
                            const cv::Mat& hann, cv::Mat& cc) {
    cv::Mat A, B;
    if (!hann.empty() && hann.size() == a.size()) {
        cv::multiply(a, hann, A);
        cv::multiply(b, hann, B);
    } else {
        A = a.clone();
        B = b.clone();
    }
    cv::Mat FA, FB, R;
    cv::dft(A, FA, cv::DFT_COMPLEX_OUTPUT);
    cv::dft(B, FB, cv::DFT_COMPLEX_OUTPUT);
    cv::mulSpectrums(FA, FB, R, 0, /*conjB=*/true);
    // WHITEN.  Phase correlation keeps only the phase, which is what makes the
    // peak a delta for a pure translation and what makes the estimator immune
    // to a per-frame exposure change.
    {
        cv::Mat ch[2];
        cv::split(R, ch);
        cv::Mat mag;
        cv::magnitude(ch[0], ch[1], mag);
        mag += 1e-12;
        cv::divide(ch[0], mag, ch[0]);
        cv::divide(ch[1], mag, ch[1]);
        cv::merge(ch, 2, R);
    }
    // DFT_SCALE, and it is load-bearing for the RESPONSE rather than for the
    // shift: cv::phaseCorrelate reports the raw sum over the 5x5 support of an
    // UNSCALED inverse transform divided by winW*winH — the same number this
    // scaled transform's sum is — and minPhaseResponse / stallResumeResponse
    // are calibrated against it.  Get the normalisation wrong and both cage
    // gates move without either constant being touched.  The centroid itself
    // is scale-invariant.
    cv::idft(R, cc, cv::DFT_REAL_OUTPUT | cv::DFT_SCALE);
    // fftShift: zero displacement to the raster centre, so the box below is a
    // plain neighbourhood and the aliasing cage's ±0.40·winW bound keeps the
    // peak well inside it.
    {
        const int cx = cc.cols / 2, cy = cc.rows / 2;
        cv::Mat q0(cc, cv::Rect(0, 0, cx, cy)), q1(cc, cv::Rect(cx, 0, cx, cy));
        cv::Mat q2(cc, cv::Rect(0, cy, cx, cy)), q3(cc, cv::Rect(cx, cy, cx, cy));
        cv::Mat t;
        q0.copyTo(t); q3.copyTo(q0); t.copyTo(q3);
        q1.copyTo(t); q2.copyTo(q1); t.copyTo(q2);
    }
}

static cv::Point2d phaseShiftBoxImpl(const cv::Mat& a, const cv::Mat& b,
                                     const cv::Mat& hann, int box,
                                     double* response) {
    CV_Assert(!a.empty() && a.size() == b.size());
    CV_Assert(a.type() == CV_32F && b.type() == CV_32F);
    cv::Mat cc;
    whitenedSurface(a, b, hann, cc);
    cv::Point peak;
    cv::minMaxLoc(cc, nullptr, nullptr, nullptr, &peak);

    auto centroid = [&](int n, double* respOut) {
        const int h = n / 2;
        const int x0 = std::max(peak.x - h, 0), x1 = std::min(peak.x + h, cc.cols - 1);
        const int y0 = std::max(peak.y - h, 0), y1 = std::min(peak.y + h, cc.rows - 1);
        double sum = 0.0, sx = 0.0, sy = 0.0;
        for (int y = y0; y <= y1; ++y) {
            const float* row = cc.ptr<float>(y);
            for (int x = x0; x <= x1; ++x) {
                const double w = (double)row[x];
                sum += w;
                sx += w * (double)x;
                sy += w * (double)y;
            }
        }
        if (respOut) *respOut = sum;
        if (std::fabs(sum) < 1e-12)
            return cv::Point2d((double)peak.x, (double)peak.y);
        return cv::Point2d(sx / sum, sy / sum);
    };

    if (response) centroid(5, response);
    const cv::Point2d c = centroid(std::max(3, box | 1), nullptr);
    return cv::Point2d((double)(cc.cols / 2) - c.x, (double)(cc.rows / 2) - c.y);
}


cv::Point2d phaseShiftBox(const cv::Mat& a, const cv::Mat& b,
                          const cv::Mat& hann, int box, double* response) {
    return phaseShiftBoxImpl(a, b, hann, box, response);
}

void phaseShiftBoxXY(const cv::Mat& a, const cv::Mat& b, const cv::Mat& hann,
                     int box, double* outXY, double* response) {
    const cv::Point2d p = phaseShiftBoxImpl(a, b, hann, box, response);
    if (outXY) { outXY[0] = p.x; outXY[1] = p.y; }
}

// ── the low-light registration gate's instruments (Config::crossResidualGate)

double laplacianVariance(const cv::Mat& winF) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    if (winF.empty() || winF.type() != CV_32F) return nan;
    cv::Mat lap;
    cv::Laplacian(winF, lap, CV_32F);   // ksize 1: the 3x3 [0 1 0; 1 -4 1; 0 1 0]
    cv::Scalar m, sd;
    cv::meanStdDev(lap, m, sd);
    const double v = sd[0] * sd[0];
    return std::isfinite(v) ? v : nan;
}

double dominantPeriodPx(const cv::Mat& winF, bool alongX) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    if (winF.empty() || winF.type() != CV_32F) return nan;
    // The mean profile along the requested axis: reduce over rows for a
    // per-column profile (alongX), over columns for a per-row one.
    cv::Mat prof;
    cv::reduce(winF, prof, alongX ? 0 : 1, cv::REDUCE_AVG, CV_32F);
    if (!alongX) prof = prof.t();
    prof = prof.clone();
    const int L = prof.cols;
    if (L < 8) return nan;
    prof -= cv::mean(prof)[0];
    cv::Mat F;
    cv::dft(prof, F, cv::DFT_COMPLEX_OUTPUT);
    // DC (k = 0) and the fundamental (k = 1, period == L) are excluded: a
    // period longer than half the profile is a gradient, not a repetition.
    int kBest = -1;
    double pBest = 0.0;
    for (int k = 2; k <= L / 2; ++k) {
        const cv::Vec2f c = F.at<cv::Vec2f>(0, k);
        const double p = (double)c[0] * c[0] + (double)c[1] * c[1];
        if (p > pBest) { pBest = p; kBest = k; }
    }
    if (kBest < 0 || !(pBest > 0.0) || !std::isfinite(pBest)) return nan;
    return (double)L / (double)kBest;
}

void phasePeakStats(const cv::Mat& a, const cv::Mat& b, const cv::Mat& hann,
                    int box, bool crossIsX, double exclusionHalfPx, double* out) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    if (out) out[0] = out[1] = out[2] = nan;
    if (!out || a.empty() || a.size() != b.size() || a.type() != CV_32F ||
        b.type() != CV_32F)
        return;
    cv::Mat cc;
    whitenedSurface(a, b, hann, cc);
    cv::Point peak;
    double peakV = 0.0;
    cv::minMaxLoc(cc, nullptr, &peakV, nullptr, &peak);
    if (!std::isfinite(peakV)) return;
    // The centroid box is the primary's own support; PSR's sidelobe region
    // and the mass ratio are both defined against it.  The secondary's
    // exclusion band is one period wide (±period/2 along the cross axis)
    // and never narrower than the box — the alias one period away is the
    // first candidate outside it.
    const int h = std::max(3, box | 1) / 2;
    int ex = h + 1;
    if (std::isfinite(exclusionHalfPx) && exclusionHalfPx > 0.0)
        ex = std::max(ex, (int)std::lround(exclusionHalfPx));
    double n = 0.0, s = 0.0, s2 = 0.0;
    double massIn = 0.0, massAll = 0.0;
    double secondary = -std::numeric_limits<double>::infinity();
    bool anyOutside = false;
    for (int y = 0; y < cc.rows; ++y) {
        const float* row = cc.ptr<float>(y);
        const int dy = y - peak.y;
        for (int x = 0; x < cc.cols; ++x) {
            const double v = (double)row[x];
            const double av = std::fabs(v);
            const int dx = x - peak.x;
            massAll += av;
            if (std::abs(dx) <= h && std::abs(dy) <= h) {
                massIn += av;
            } else {
                n += 1.0; s += v; s2 += v * v;
            }
            const int dc = crossIsX ? dx : dy;
            if (std::abs(dc) >= ex) {
                anyOutside = true;
                if (v > secondary) secondary = v;
            }
        }
    }
    if (n > 1.0) {
        const double mean = s / n;
        const double var = std::max(0.0, s2 / n - mean * mean);
        const double sd = std::sqrt(var);
        if (sd > 1e-30) out[0] = (peakV - mean) / sd;
    }
    if (massAll > 0.0) out[1] = massIn / massAll;
    if (anyOutside && peakV > 0.0 && std::isfinite(secondary))
        out[2] = secondary / peakV;
}

}  // namespace detail

// ── Impl ────────────────────────────────────────────────────────────────────

struct Engine::Impl {
    /// One cross-sweep correlation band: which slot it is, where it sits along
    /// the cross axis (canvas px, natural frame) and the residual advance it
    /// measured there.
    struct CrossBand { int slot; double xi; double adv; };

    Config cfg;
    bool   configured = false;

    // Session lifecycle
    bool        aborted = false;
    std::string abortReason;
    bool        haveTs = false;
    double      lastTsNs = 0.0;
    double      lastT[3] = {0, 0, 0};
    int         warm = 0;

    // Reference latch
    bool   refLatched = false;
    Mat33  R0 = Mat33::eye();
    double refFx = 0, refFy = 0, refCx = 0, refCy = 0;
    double refQuat[4] = {0, 0, 0, 1};
    int    imgW = 0, imgH = 0;
    double maxAdvancePx = 0.0;
    cv::Mat refBgr;              // retained ONLY until the axis latch paints it
    cv::Mat onesMask;            // cached full-frame 255 mask for warp coverage

    // Registration state
    cv::Mat prevWinF;            // CV_32F work window of the last ACCEPTED frame
    double  prevOwX = 0, prevOwY = 0;
    cv::Mat hann;
    int     winW = 0, winH = 0;
    // Sub-pixel centroid support, WORK px, resolved at the reference latch from
    // `workScale` so it always spans ~10 SOURCE px.  See centroidBoxFor().
    int     corrCentroidBox = 5;
    // Accepted frames whose window origin was clamped into the rectified
    // footprint — the precondition of the attitude-cancellation identity, made
    // observable.  See SessionStats::corrOriginClampedFrames.
    int64_t corrOriginClamped = 0;

    /// THE ONE registration call site.
    ///
    /// At the shipped support (5, i.e. workScale 0.5) this IS
    /// `cv::phaseCorrelate` — not a re-implementation that agrees with it, the
    /// call itself.  The generalised estimator differs from OpenCV's packed
    /// real-DFT formulation at the 1e-2 px level in float32, which is ~5 % of
    /// the estimator's own per-step noise; small, but there is no reason to
    /// spend it when the support is the one OpenCV hard-wires.  The default
    /// path is therefore byte-identical to v9 by construction rather than by
    /// measurement.
    /// NON-const, and both operands NON-const references, because
    /// `cv::phaseCorrelate` multiplies BOTH inputs by the window IN PLACE
    /// whenever the arrays need no DFT padding.  That is why the call sites
    /// hand it the `corrPrev` / `corrCur` scratch copies (see their note); the
    /// signature says so rather than hiding it behind a const reference.
    cv::Point2d correlate(cv::Mat& a, cv::Mat& b, double* resp) {
        if (corrCentroidBox == 5)
            return cv::phaseCorrelate(a, b, hann, resp);
        return detail::phaseShiftBox(a, b, hann, corrCentroidBox, resp);
    }
    // Scratch handed to cv::phaseCorrelate INSTEAD of prevWinF / curWinF.
    // phaseCorrelate multiplies BOTH inputs by the window IN PLACE whenever
    // the array needs no DFT padding — and 192×144 (the default window) is
    // already an optimal DFT size, so it does.  Storing that mutated buffer as
    // `prevWinF` made every correlation after the first compare Hann²·prev
    // against Hann¹·cur, and a HELD chain compounded a further power of the
    // window per rejected frame.  Reused, so this costs no per-frame alloc.
    cv::Mat corrPrev, corrCur;

    // ── v5: K-WINDOW REGISTRATION + THE CUT METRIC ──────────────────────
    // Slot centreSlot() is v4's window; prevWins[centre] and prevWinF are the
    // same raster and are updated together, so the two can never drift apart.
    std::vector<cv::Mat> prevWins;
    std::vector<double>  prevWinOwX, prevWinOwY;
    std::vector<double>  bandErrCum;      // accumulated per-band seam residual
    std::vector<float>   seamWorstSamples, seamSpreadSamples, seamLumaSamples;
    std::vector<float>   seamJogSamples;  // committed-pixel cross misregistration
    /// ALL FOUR ARE KEPT SORTED (insertSorted).  stats() runs once per
    /// ingested frame and these grow one entry per committed strip, so
    /// percentiling them there was an O(n log n) per frame that grew with the
    /// sweep and was invisible to FrameOutcome::engineMs (stamped before
    /// stats() runs).  Measured before the fix: 0.014 ms at 0 strips,
    /// 0.125 ms at 1586.  Sorted at insert, stats() now does no work.
    // Scratch for the canvas-domain jog correlation (no per-frame alloc).
    cv::Mat jogA, jogB, jogHann;
    double  lastSeamJogPx = 0.0;
    /// v8 — the SAME measurement with its sign; lastSeamJogPx is its |·|.
    double  lastSeamJogSignedPx = 0.0;
    bool    lastSeamJogValid = false;
    /// v8 — running sum of the signed jog and its excursion.  Peak-to-peak of
    /// the sum is how far the panorama has WALKED, which no per-boundary
    /// percentile can reach.  A DIAGNOSTIC, never a bar — see the scope note
    /// on SessionStats::seamJogDriftPx.
    double  jogAcc = 0.0, jogAccMin = 0.0, jogAccMax = 0.0;
    int64_t jogAccN = 0;
    /// v8 — boundaries whose |DC step| was over the verdict's 3.00 DN max bar.
    int64_t seamPhotoOverBar = 0;
    double crossScale = 1.0;              // accumulated cross-sweep scale
    double refT[3] = {0, 0, 0};           // reference camera position, world m
    double fwdRef[3] = {0, 0, -1};        // reference optical axis, world
    double crossLogMeas = 0.0;            // integrated MEASURED cross log-scale
    double dFitNum = 0.0, dFitDen = 0.0;  // online subject-distance regression
    double subjectDistanceFit = 0.0;
    // ── v11: THE FIT'S OWN INTERNALS, so the pack can grade it ──────────
    // See SessionStats' block for the measured defect these exist for.  All
    // write-only from the fit's point of view: not one of them is read back
    // by the estimator, the placement or the verdict.
    double  dFitRaw = 0.0;                // last UNCLAMPED ratio (0 = never ran)
    bool    dFitSaturated = false;        // ...and whether it hit a rail
    int64_t dFitClamped = 0, dFitRefused = 0;
    int64_t dFitSamples = 0;
    bool    dFitSpanSeen = false;         // fwd min/max are SEEDED, not 0-based
    double  dFitFwdMin = 0.0, dFitFwdMax = 0.0;
    double  dFitPerpMax = 0.0;            // largest ⊥ displacement from refT
    int64_t crossScaleCagedFrames = 0;
    // Frames on which the mode-1 leak actually ran.  Reported so an inert knob
    // reads 0 rather than looking like a leak that simply had nothing to do.
    int64_t crossScaleLeakedFrames = 0;
    // The running mean of the mode-1 gradient, and how often it was subtracted.
    double  crossGSum = 0.0;
    int64_t crossGCount = 0;
    int64_t crossDcRemovedFrames = 0;
    int64_t crossBandFitRefused = 0;
    int64_t crossGestureRefused = 0;
    double maxAreaScalePainted = 1.0;
    double lastAreaScale = 1.0;
    /// Set only while a SINGLE COMMIT is being rasterised as a run of slices —
    /// the arc seed (`commitArcSeed`) and, since the tail fix, the arc tail
    /// (`commitArcTail`).  Its ONE effect is to stop `commitStrip` banking each
    /// slice as a separate strip: each is one commit and one ledger row, and
    /// the slices are how a non-projective map is made into projective ones.
    /// The name is the seed's because it was the seed's first; one flag for one
    /// property is deliberate — a second bool with the same job is how two
    /// paths that must agree drift apart, which is the whole history here.
    bool   seedSlicing = false;
    int    seedLensTally = 0;          // -1 fell back, +1 corrected, 0 neither
    double lastSeamLumaDN = 0.0;
    bool   lastSeamLumaValid = false;
    int64_t seamStripsCommitted = 0;   // denominator for seamCoverageFrac
    double maxCrossRectifyDeg = 0.0;
    double minPsiDeg = 0.0, maxPsiDeg = 0.0;
    /// THE PROJECTION SWITCH.  ψ is gated on the axis latch, so the frame
    /// before the latch is placed on the tangent (f·tan ψ) and the one after
    /// on the arc (f·ψ).  Bounded (pre-latch ψ is still inside the excursion
    /// gate) and self-correcting (the next correlation folds the difference
    /// into posNat once) — but the brief asked that the projection never
    /// change mid-sweep unledgered, so it is ledgered.
    bool    projectionSwitched = false;
    int64_t projectionSwitchSeq = -1;
    double  projectionSwitchStepPx = 0.0;
    // The source intrinsics of whatever frame commitStrip is painting from —
    // set by the caller so the warping metric is measured against the right
    // camera (the backfill and the tail flush paint from an EARLIER frame).
    double curK[4] = {0, 0, 0, 0};
    double lastK[4] = {0, 0, 0, 0};   // the LAST PAINTED frame's intrinsics

    // ── v10: THE LENS CORRECTION, resolved once at the reference latch ──────
    // The gate reads the REFERENCE frame's own fx (with imageWidth fixed for
    // the session — a format change aborts the sweep), so the decision is made
    // on measured intrinsics rather than on the host's claim.  Every strip
    // then re-checks the focal of the frame IT paints from, which is what
    // catches a lens switch mid-sweep: the backfill and the tail flush paint
    // from an earlier frame and must not inherit this frame's licence.
    lens::Decision lensDec;
    lens::RadialLut lensLut;
    bool   lensReady = false;      // decision made AND a usable LUT built
    double lensFxLo = 0.0, lensFxHi = 0.0;   // the per-strip focal window
    double lensPeakRadialPx = 0.0;
    double lensPeakResidualPx = 0.0;
    int64_t lensCorrectedStrips = 0;
    int64_t lensSkippedStrips = 0;
    int64_t stripsCommitted = 0;    // strips that put columns in the canvas
    cv::Mat lensMap;               // CV_32FC2 scratch, reused per strip
    // Reused per-frame scratch for crossMeasure (no per-frame allocation on
    // the live path beyond the K window rasters themselves).
    std::vector<CrossBand> crossBands;
    std::vector<cv::Mat>   crossCurWins;
    std::vector<double>    crossOwXs, crossOwYs;

    // Chain / axis latch
    double posNatX = 0.0, posNatY = 0.0;   // RESIDUAL accumulator (translation)
    bool   axisLatched = false;
    int    axis = 0, sweepSign = 1;
    Mat33  A = Mat33::eye();
    int    latchFrames = 0;
    bool   latchWasWeak = false;           // decided at axisLatchMaxFrames
    // The reference frame's own natural-frame position (its H_rect is the
    // identity, so this is just its scaled centre).  Every latch quantity is
    // measured against it.
    double natRefX = 0.0, natRefY = 0.0;
    // The rectified centre of the last ACCEPTED frame — the attitude step is
    // measured across the same interval as the residual, so the two channels
    // sum to the frame's real canvas-position step.
    double prevCrX = 0.0, prevCrY = 0.0;
    // REGIME accounting (natural frame; projected onto the latched axis in
    // stats()).  Accepted frames only.
    double rotNetX = 0.0, rotNetY = 0.0, resNetX = 0.0, resNetY = 0.0;
    double rotPathX = 0.0, rotPathY = 0.0, resPathX = 0.0, resPathY = 0.0;
    // What the latch voted on, kept for the pack.
    double latchRotX = 0.0, latchRotY = 0.0;
    double latchTotX = 0.0, latchTotY = 0.0;

    // ── RELATCH (Config's relatch block) ───────────────────────────────────
    // The camera's cumulative canvas-space displacement since the FIRST latch,
    // summed from the per-frame total.  Deliberately NOT re-based by a
    // relatch: the correction must be decided on the LONGEST baseline the
    // session has, because a relatch that fires mid-wobble would otherwise
    // restart the evidence at the worst possible moment and decide the next
    // correction from the same bad window.  Reference-frame reseeds do not
    // disturb it — it accumulates measured steps, not positions.
    double gTotX = 0.0, gTotY = 0.0;
    int    framesSinceLatch = 0;   // accepted frames since the latch/relatch
    bool   everLatched = false;    // a latch has happened at least once
    bool   relatchArmed = false;   // disarmed for good once the canvas grows
    int    relatchCount = 0;
    /// One frame's footprint along the sweep axis (u) and across it (v), in
    /// canvas px, measured from the REFERENCE frame at latch time.  The
    /// relatch commit bar and cropVertical's decline bar are fractions of
    /// these — a bar in absolute px is meaningless across focal lengths, and
    /// canvasH is the wrong reference because it includes the pad and every
    /// vertical growth (so the bar would tighten as the sweep got longer).
    double footprintU = 0.0, footprintV = 0.0;

    // Canvas (internal coordinates)
    cv::Mat canvas;              // CV_8UC3
    cv::Mat coverage;            // CV_8UC1 — 255 where a frame committed a pixel
    int     canvasW = 0, canvasH = 0;
    double  originU = 0.0, originV = 0.0;
    double  highWater = 0.0;
    /// OPTION C (`Config::leadReplace`) — THE FAR EDGE OF THE PROVISIONAL
    /// LEAD-IN, in internal canvas px; < 0 when there is none.
    ///
    /// THE STATE THE DISTINCTION NEEDED.  `highWater` alone cannot tell a
    /// strip "you may repaint here": it is simultaneously the TRUE frontier
    /// (behind it, a column's photometry, gain sample and seam step are all
    /// final — see photoScanU) and the left edge of the next paint.  What it
    /// does NOT record is that the seed painted half a footprint AHEAD of it,
    /// content no frame has voted on yet.  This is that edge, and the pair
    /// (highWater, leadEndU) is the committed-vs-painted split: `[highWater,
    /// leadEndU)` is painted-but-provisional, `[0, highWater)` is committed
    /// and untouchable, `[leadEndU, ∞)` is unpainted.
    ///
    /// Set by `commitLatch` to what the seed ACTUALLY committed (`px1`, not
    /// the unwarped footprint `ru1` — the arc seed is narrower than `ru1` and
    /// repainting the difference would paint a span nothing ever put pixels
    /// in), re-set by every relatch because a relatch reseeds the canvas, and
    /// spent once the fill has covered it.  −1 unless `cfg.leadReplace`.
    double  leadEndU = -1.0;
    /// OPTION C — HOW FAR THE FILL HAS GOT, in internal canvas px.  The third
    /// water mark, and the one that makes the fill SINGLE-OWNER.
    ///
    /// WHY IT EXISTS, measured.  The first cut of this flag let EVERY painted
    /// frame repaint the whole remaining band.  Each column was then written
    /// dozens of times and a surviving pixel's owner was whichever frame's
    /// warp mask happened to reach it LAST — a function of the mask's ragged
    /// cross-axis edge, not of the sweep.  Adjacent pixels came from frames
    /// hundreds apart: over the 60 878 px the flag took back from the seed on
    /// the operator's 12 same-raster packs, the number of owners went 1 → up
    /// to 163, owner-boundary density went 0.10 → 0.87 per pixel and the local
    /// |Laplacian| went 26 → 73 DN.  The band stopped being stale and started
    /// being a comb, which is worse: the operator can see a comb.
    ///
    /// With this mark the band is filled STRICTLY FORWARD and exactly once —
    /// `[max(highWater, leadFillU), …)` — so ownership inside it is a function
    /// of COLUMN alone.  Whatever a block's owner is, its neighbours in the
    /// cross direction have the same owner, and the only boundaries left are
    /// the vertical column joins an ordinary strip already makes.
    double  leadFillU = -1.0;
    /// OPTION C — WHETHER THE SEED WAS ARC-PLACED, so the fill can be placed
    /// under the SAME law.  The fill repaints the seed's own span, and a
    /// tangent-only fill over an arc-placed seed puts the content tens of px
    /// from where the seed put it.  Not derived from
    /// `tailArcRotationFraction()`, which is the tail's gate and is the wrong
    /// question here twice over: it needs travel to divide by, and at the first
    /// painted frame — the frame that does the whole fill — the sweep has
    /// travelled nothing, so that gate reads 0 and would refuse the arc on
    /// exactly the frame that needs it.  What the fill has to match is the
    /// seed, and the seed has already decided.
    bool    leadArcSeeded = false;

    // ── TRAJECTORY CONTINUATION (`Config::crossTraj`) ───────────────────
    /// The strip chain's cross-axis trajectory at a join, as ONE struct that
    /// both estimators fill and one slice map consumes.  Slope and fan are in
    /// INTERNAL canvas coordinates (v per u; fan per v), about `fanCentreV`.
    struct CrossTraj {
        bool   valid = false;
        double slope = 0.0;
        double fan = 0.0;
        double fanCentreV = 0.0;
        double stepPx = 0.0;      // fitted cross offset AT the join (mean over bands)
        double stepFan = 0.0;     // d(step)/d(cross px) about fanCentreV
        bool   applyStep = false; // apply the step (the seed: two frames meet);
                                  // the tail's join is one frame, its step is noise
        int    samples = 0;
        int    bands = 0;
        double response = 0.0;
        int    source = 0;        // 1 chain, 2 overlap
        double relaxPx = 0.0;     // Config::crossTrajRelaxPx, carried so the map
                                  // is a function of the estimate alone
    };
    /// (posU, posV in the axis-latch frame) of every committed strip, in
    /// commit order — estimator 1's input.  Cleared by every latch with the
    /// canvas it describes.  Two doubles per strip; only kept while the flag is
    /// on, so the flag-off engine allocates nothing here.
    std::vector<std::pair<double, double> > stripTrail;
    /// The SEED's own geometry, retained for its finish()-time re-placement
    /// (`Config::crossTrajSeed`).  `refKeep` is the reference frame the latch
    /// painted — a shallow reference to the clone the engine already holds
    /// through the latch window, kept instead of released.  `seedHref` is the
    /// homography the seed was painted through, in the canvas frame that was
    /// current AT the latch: every later band growth shifts the canvas down by
    /// `vShiftTotal`, so it is re-based by that at use.  Empty / -1 when the
    /// flag is off.
    cv::Mat refKeep;
    Mat33   seedHref = Mat33::eye();
    bool    seedArced = false;
    int     seedX0 = 0, seedX1 = 0;
    double  seedCentreU = -1.0;
    /// The FIRST strip's committed far edge after the seed — the extent of the
    /// single-frame span the seed's rear half joins.  -1 until it commits.
    double  firstStripX1 = -1.0;
    double  lastPaintedU = 0.0;
    /// STRIPS COMMITTED SINCE THE LATCH — 0 means the next strip to reach the
    /// gap rule is the FIRST one after a seed, which is the only place the
    /// seed junction exists (`Config::seedFrontierMeet`).  Re-based by every
    /// relatch, because a relatch re-seeds and the junction comes back with it.
    /// Read only under that flag, so it costs nothing when the flag is off.
    int     stripsSinceLatch = 0;
    /// The REFERENCE frame's optical centre, in canvas px — the origin ψ is
    /// measured from, so `lastPaintedU - latchCentreU` is the frame-centre
    /// travel that ψ's arc contribution is compared against.  Re-adopted by
    /// every relatch, alongside the ψ bounds.  See tailArcRotationFraction.
    double  latchCentreU = 0.0;
    int     minPaintedU = 0, maxPaintedU = 0;
    bool    anyPainted = false;
    /// THE ROWS ANY FRAME ACTUALLY PAINTED — the UNION, not the per-column
    /// common band `cropVertical` computes.
    ///
    /// MEASURED, and it is why this exists.  The canvas is sized at one frame's
    /// footprint plus TWO pads: 1920 x 0.5 + 2 x 128 = 1216 rows on the
    /// operator's packs, of which 256 (21%) are pad that nothing will ever
    /// paint.  The live preview takes the WHOLE canvas height, so more than a
    /// fifth of his panel was black bars — and because the panel hugs the
    /// preview's aspect, that black also made the shelf 21% smaller than the
    /// phone was willing to draw it.  Rendering the mockups off his own field
    /// packs is what made it visible; no metric in the pack named it.
    ///
    /// The UNION is the right band and the per-column intersection is not:
    /// the union removes only rows NOTHING painted, so the ragged
    /// attitude-rectified edge stays visible (which `previewInto`'s comment
    /// explicitly wants) and no committed pixel can ever be cropped away.
    /// `cropVertical`, by contrast, cuts INTO real content and has to be able
    /// to decline.
    ///
    /// Maintained where the coverage mask is written, and shifted with the
    /// canvas when it grows upward — a stale value there would crop the
    /// preview to the wrong rows for the rest of the sweep.
    int     minPaintedV = 0, maxPaintedV = 0;
    bool    anyPaintedV = false;

    // Exposure
    double gainCum = 1.0;

    // ── v6: RADIOMETRIC NORMALISATION ───────────────────────────────────
    /// The reference frame's exposure (duration × ISO).  0 ⇒ never seen — and
    /// then every expGain is exactly 1.0 and this whole path is identity.
    double  refExposure = 0.0;
    /// This frame's exact normalisation factor, and the one belonging to the
    /// frame `lastBgr` points at (the tail flush and the interior backfill
    /// paint THAT frame's pixels, so they must carry THAT frame's exposure —
    /// not whatever the chain happened to end on).
    double  curExpGain = 1.0;
    double  lastExpGain = 1.0;
    /// What the CAMERA's own exposure change leaves in the canvas after the
    /// normalisation — (e_i/e_ref) × expGain, i.e. 1.0 whenever the
    /// normalisation was exact, and 1.0 (unobservable) when there is no
    /// metadata at all.  This is the factor that turns the ENGINE's applied
    /// gain into the EFFECTIVE scene→canvas transfer, which is the quantity
    /// whose local excursions the operator actually sees as a band.
    double  curExpResidual = 1.0;
    double  lastExpResidual = 1.0;
    cv::Mat expLut;                   // 1×256 CV_8U, rebuilt when the gain moves
    double  expLutGain = 1.0;         // the gain `expLut` currently encodes
    int64_t exposureMetaFrames = 0;
    int64_t exposureClampedFrames = 0;
    double  exposureMin = 0.0, exposureMax = 0.0;

    // ── v11: ARKit's OWN exposure trace — EVIDENCE, never an input ───────
    // Accumulated in ingestFrame() beside the device trace above and read
    // out in stats().  Nothing downstream of here consumes it: the gain
    // chain, the normalisation LUT and the verdict all still read
    // exposureDurationS × exposureISO exactly as v6 left them.
    int64_t arExposureFrames = 0;
    double  arExposureMinS = 0.0, arExposureMaxS = 0.0;
    /// exposureOffset is an EV OFFSET and is legitimately negative, so the
    /// min/max pair is SEEDED from the first sample rather than from 0 —
    /// which is why it needs its own "have we seen one yet" flag instead of
    /// leaning on `arExposureFrames` (the duration may be non-finite on a
    /// frame whose offset is fine, and vice versa).
    bool    arExposureOffsetSeen = false;
    double  arExposureOffsetMinEV = 0.0, arExposureOffsetMaxEV = 0.0;
    int64_t arVsDevicePairedFrames = 0;
    double  arVsDeviceMaxAbsDeltaS = 0.0;
    double  arVsDeviceMaxRelDelta  = 0.0;

    // ── v6: THE PHOTOMETRIC SEAM + THE BAND ─────────────────────────────
    double  lastSeamPhotoDN = 0.0;
    double  lastSeamPhotoBaseDN = 0.0;
    double  photoBaseSum = 0.0;
    int64_t photoBaseCount = 0;
    int     lastSeamSlabW = 0;
    double  lastSeamPhotoUniform = -1.0;
    double  lastSeamPhotoSpreadDN = 0.0;
    int     lastSeamPhotoBands = 0;
    bool    lastSeamPhotoValid = false;
    std::vector<float> seamPhotoSamples;   // |step| per measured boundary
    /// The same |step| population restricted to the boundaries whose step is
    /// DC-LIKE ACROSS THE BOUNDARY'S EXTENT.  Reported, never gated on — it is
    /// the cross-check that the gate is not an artefact of registration-shaped
    /// boundaries, which is a different question from what the gate measures.
    std::vector<float> seamPhotoUniSamples;
    std::vector<float> seamPhotoSpreadSamples;
    int64_t seamPhotoNonUniform = 0;
    int64_t seamPhotoUniformUnknown = 0;
    /// Row index of each entry in `photoDiffs`, so the band pass can slice by
    /// canvas row without a second gather over the image.
    std::vector<int>   photoDiffRows;
    std::vector<float> photoBand;      // one band's differences
    std::vector<float> photoScratch;   // nth_element workspace (never the input)
    /// THE COMMITTED DRIFT PROFILE.  Integrating the SIGNED per-boundary step
    /// reconstructs the brightness the canvas actually carries — measured on
    /// committed pixels, so it includes the CAMERA's drift, which the applied-
    /// scale field structurally cannot see on a pack with no exposure
    /// metadata.  Maintained incrementally, monotonic deques for the sliding
    /// window, for the same reason the column scan is: stats() runs once per
    /// frame.
    double photoCumDN = 0.0;
    double photoCumMinDN = 0.0, photoCumMaxDN = 0.0;
    double photoDriftLocalDN = 0.0;
    int64_t photoDriftWorstU = 0;
    std::deque<std::pair<int, double>> photoCumMinQ, photoCumMaxQ;
    /// The APPLIED photometric scale per committed canvas column, grown with
    /// the canvas.  0 ⇒ that column carries no paint.  This is the field whose
    /// local excursions ARE the bands, so it is recorded rather than inferred:
    /// a per-boundary metric structurally cannot see a 40-column drift.
    std::vector<float> colScale;
    /// INCREMENTAL SLIDING-WINDOW SCAN over `colScale`.
    ///
    /// stats() is called ONCE PER FRAME by the session owner for the live HUD,
    /// so nothing in it may cost O(canvasW) — PanoGate.PerFrameStatsDoesNot-
    /// CostMoreAsTheSweepGrows exists to fail exactly that, and it DID fail on
    /// the first cut of this metric (0.036 ms → 0.552 ms across a 900-frame
    /// sweep).  The fix is to scan on the WRITE side instead, which is sound
    /// because a column's photometric value is FINAL once the frontier has
    /// passed it: the provisional lead-in ahead of `highWater` is still going
    /// to be overwritten, everything behind it never is.  So the cursor walks
    /// to the frontier, amortised O(1) per canvas column over the session, and
    /// stats() just reads the cached extremes.
    int     photoScanU  = -1;    // next column to feed; -1 = not started
    int     photoStartU = 0;     // where this scan began (window fill datum)
    std::vector<int> photoRingMin, photoRingMax;   // monotonic, exactly `win`
    int     photoHMin = 0, photoTMin = 0, photoHMax = 0, photoTMax = 0;
    double  photoWorstP2P = 0.0;
    int64_t photoWorstAt = 0;
    double  photoGMin = 0.0, photoGMax = 0.0;
    int64_t photoCols = 0;
    /// Scratch for the photometric measurement — reused so the metric costs
    /// no per-frame allocation (`photoDiffs` keeps its capacity across calls).
    cv::Mat photoGrayA, photoGrayB, photoGradX, photoGradY;
    std::vector<float> photoDiffs;

    // Tail flush (a SHALLOW reference — see FrameInput's contract)
    cv::Mat lastBgr;
    Mat33   lastHint = Mat33::eye();
    double  lastFu1 = 0.0;
    bool    lastValid = false;
    bool    tailFlushed = false;

    // Stall / diagnostics
    int    stallCount = 0;
    bool   stalled = false;
    double maxRectifyDeg = 0.0;
    int64_t growths = 0;
    int64_t heightGrowths = 0;
    double  vShiftTotal = 0.0;

    /// Set while ARKit tracking is notAvailable.  The pose it publishes then
    /// is meaningless, so `lastT` is deliberately NOT advanced — which would
    /// make the very next good frame look like a translation TELEPORT.  This
    /// flag re-seeds `lastT` on the first recovered frame instead of aborting
    /// a sweep that merely blinked.
    bool poseStale = false;

    SessionStats st;

    /// Number of correlation windows across the sweep.  1 disables the outer
    /// slots entirely and the engine is v4's registration exactly.
    int crossWindowCount() const {
        if (!(cfg.crossSweepFit || cfg.seamMetrics)) return 1;
        const int k = cfg.crossWindows;
        if (k < 3) return 1;
        // configure() guarantees ODD, so there is no silent bump here any
        // more; the guard stays only so a directly-constructed Impl in a unit
        // test cannot produce an even slot count.
        return (k % 2) ? k : k + 1;
    }
    int centreSlot() const { return (crossWindowCount() - 1) / 2; }

    void resetCrossWindows() {
        const int k = crossWindowCount();
        prevWins.assign((size_t)k, cv::Mat());
        prevWinOwX.assign((size_t)k, prevOwX);
        prevWinOwY.assign((size_t)k, prevOwY);
        bandErrCum.assign((size_t)k, 0.0);
        if (k > 0 && !prevWinF.empty()) prevWins[(size_t)centreSlot()] = prevWinF;
        crossScale = 1.0;
        crossLogMeas = 0.0;
        dFitNum = dFitDen = 0.0;
        subjectDistanceFit = 0.0;
        // v11 — the diagnostics reset WITH the regression they describe.  A
        // relatch discards the canvas and re-seeds refT/fwdRef, so a leverage
        // span carried over from the previous reference would be measured
        // against an origin that no longer exists.
        dFitRaw = 0.0;
        dFitSaturated = false;
        dFitClamped = dFitRefused = 0;
        dFitSamples = 0;
        dFitSpanSeen = false;
        dFitFwdMin = dFitFwdMax = 0.0;
        dFitPerpMax = 0.0;
    }

    /// The same matrix as pnat() but built from EXPLICIT components, so the
    /// cut metric can evaluate the placement the previous frame committed
    /// without keeping a second copy of the chain.
    static Mat33 pnatOf(double s, double cross, double along, int ax) {
        if (ax == 0) return Mat33(1, 0, along, 0, s, cross, 0, 0, 1);
        return Mat33(s, 0, cross, 0, 1, along, 0, 0, 1);
    }

    /// The accumulated NATURAL-frame placement: a pure translation plus a
    /// cross-sweep scale.  crossScale == 1 makes this translate(posNat) — i.e.
    /// v4's chain, exactly.
    Mat33 pnat() const {
        if (std::fabs(crossScale - 1.0) < 1e-15)
            return translate(posNatX, posNatY);
        if (axis == 0)   // cross = natural y
            return Mat33(1, 0, posNatX, 0, crossScale, posNatY, 0, 0, 1);
        return Mat33(crossScale, 0, posNatX, 0, 1, posNatY, 0, 0, 1);
    }

    void countOutcome(Outcome o) {
        switch (o) {
            case Outcome::Painted:             ++st.painted; break;
            case Outcome::GapExtended:         ++st.painted; ++st.gapExtended; break;
            case Outcome::GapBreak:            ++st.painted; ++st.gapBreak; break;
            case Outcome::GapBackfilled:       ++st.painted; ++st.gapBackfilled; break;
            case Outcome::HeldBacktrack:       ++st.heldBacktrack; break;
            case Outcome::HeldFrontier:        ++st.heldFrontier; break;
            case Outcome::SkippedNoAdvance:    ++st.skippedNoAdvance; break;
            case Outcome::RejectedLowResponse: ++st.rejectedLowResponse; break;
            case Outcome::RejectedOutOfCage:   ++st.rejectedOutOfCage; break;
            case Outcome::RejectedPoseSpeed:   ++st.rejectedPoseSpeed; break;
            case Outcome::RejectedTracking:    ++st.rejectedTracking; break;
            case Outcome::RejectedRectify:     ++st.rejectedRectify; break;
            case Outcome::RejectedInput:       ++st.rejectedInput; break;
            case Outcome::WarmingUp:           ++st.warmingUp; break;
            case Outcome::Bootstrap:           ++st.bootstrap; break;
            default: break;
        }
    }

    /// Record one held-chain rejection.  Returns true when the rejection run
    /// has gone on long enough that resuming could only be a guess — the
    /// caller then ABORTS the sweep (a visible stop) rather than eventually
    /// accepting a stale-window measurement.
    bool noteRejection() {
        ++stallCount;
        if (stallCount >= cfg.cageStallFrames) stalled = true;
        return stallCount >= cfg.maxRejectRunFrames;
    }

    /// The single memory cap, applied to BOTH growth axes (the header's
    /// memory note is written against this number).
    bool areaWithinBudget(int64_t w, int64_t h) const {
        if (w <= 0 || h <= 0) return false;
        if (rnis::canvasExceedsGuard(w, h)) return false;
        return (double)(w * h) <= cfg.canvasMaxPixels;
    }

    bool ensureCanvasWidth(int need) {
        if (need <= canvasW) return true;
        if (need > cfg.canvasMaxWidthPx) return false;
        int nw = canvasW > 0 ? canvasW : cfg.canvasInitWidthPx;
        while (nw < need) {
            if (nw >= cfg.canvasMaxWidthPx) break;
            nw = std::min(nw * 2, cfg.canvasMaxWidthPx);
        }
        if (nw < need) return false;
        if (!areaWithinBudget((int64_t)nw, (int64_t)canvasH)) return false;
        // Release the old canvas BEFORE allocating the new coverage: the
        // transient peak is then 2×canvas + 1×coverage rather than 2× of
        // both, which is the number the header quotes.
        {
            cv::Mat nc = cv::Mat::zeros(canvasH, nw, CV_8UC3);
            if (canvasW > 0) canvas.copyTo(nc(cv::Rect(0, 0, canvasW, canvasH)));
            canvas = nc;
        }
        {
            cv::Mat ncov = cv::Mat::zeros(canvasH, nw, CV_8UC1);
            if (canvasW > 0) coverage.copyTo(ncov(cv::Rect(0, 0, canvasW, canvasH)));
            coverage = ncov;
        }
        canvasW = nw;
        ++growths;
        return true;
    }

    /// Grow the canvas PERPENDICULAR to the sweep so a frame that has drifted
    /// out of the band is painted whole instead of being silently cropped by
    /// warpPerspective.  `needTop` / `needBot` are the canvas px the frame's
    /// footprint overhangs above row 0 / below row canvasH.
    ///
    /// Growth happens in 128 px steps (a per-frame realloc of a 16 k-wide
    /// canvas would dominate the frame budget) and is bounded by
    /// canvasMaxHeightPx AND canvasMaxPixels.  Returns true when the canvas
    /// changed; `*addedTopOut` is how far every existing pixel MOVED DOWN, so
    /// the caller can re-base the homographies it already computed.
    ///
    /// Refusing to grow is not a failure — it is the point at which clipping
    /// becomes REPORTED (see commitStrip / FrameOutcome::clipTopPx).
    bool ensureCanvasBand(int needTop, int needBot, int* addedTopOut) {
        *addedTopOut = 0;
        if (needTop <= 0 && needBot <= 0) return false;
        if (!cfg.canvasGrowVertical) return false;
        if (canvasH <= 0 || canvasW <= 0 || canvas.empty()) return false;

        const int kStep = 128;
        auto stepUp = [&](int n) { return n > 0 ? ((n + kStep - 1) / kStep) * kStep : 0; };
        int addTop = stepUp(needTop);
        int addBot = stepUp(needBot);

        int room = cfg.canvasMaxHeightPx - canvasH;
        if (room <= 0) return false;
        if (addTop + addBot > room) {
            // Partial growth still helps, and what remains outside is
            // reported.  Satisfy the top first (a shift is the expensive
            // half — it re-bases the homographies) only if it fits.
            if (addTop <= room) addBot = room - addTop;
            else { addTop = room; addBot = 0; }
        }
        if (addTop <= 0 && addBot <= 0) return false;

        const int nh = canvasH + addTop + addBot;
        if (!areaWithinBudget((int64_t)canvasW, (int64_t)nh)) return false;

        {
            cv::Mat nc = cv::Mat::zeros(nh, canvasW, CV_8UC3);
            canvas.copyTo(nc(cv::Rect(0, addTop, canvasW, canvasH)));
            canvas = nc;
        }
        {
            cv::Mat ncov = cv::Mat::zeros(nh, canvasW, CV_8UC1);
            coverage.copyTo(ncov(cv::Rect(0, addTop, canvasW, canvasH)));
            coverage = ncov;
        }
        canvasH = nh;
        st.canvasH = nh;
        if (addTop > 0 && anyPaintedV) {
            // The existing content moved down by `addTop`; a row extent left
            // behind would crop the live preview to the wrong band for the
            // rest of the sweep.
            minPaintedV += addTop;
            maxPaintedV += addTop;
        }
        if (addTop > 0) {
            originV += (double)addTop;
            vShiftTotal += (double)addTop;
            // The retained tail-flush / backfill homography was baked against
            // the OLD origin; leaving it stale would paint the lead-out at
            // the wrong height.
            lastHint = translate(0.0, (double)addTop) * lastHint;
        }
        ++heightGrowths;
        *addedTopOut = addTop;
        return true;
    }

    /// v11 — ARKit'S OWN EXPOSURE, RECORDED AND NOTHING ELSE.
    ///
    /// Deliberately a SEPARATE function from `exposureGainFor` and called
    /// after it, so the compiler and the reader can both see that no value
    /// here reaches the gain, the LUT, the placement or the verdict.  It
    /// returns void for the same reason: there is no result to consume.
    ///
    /// WHAT IT SETTLES.  `exposureRangeRatio` is measured on the
    /// `AVCaptureDevice` this pod resolved and locked, so it is circular
    /// with respect to "is that the device ARKit streams?" and "does the
    /// lock reach ARKit's pixels?".  `ARCamera.exposureDuration` is neither:
    /// it is ARKit's own per-frame number.  Agreement between the two on the
    /// same frame is device identity; a FLAT ARKit trace is the lock landing
    /// where it was meant to.
    ///
    /// A frame with no ARKit sample is counted in NEITHER trace — absence is
    /// reported as `arExposureFrames == 0`, never as a zero exposure.
    void noteArExposure(const FrameInput& in) {
        if (!in.arExposureValid) return;
        const double d = in.arExposureDurationS;
        if (std::isfinite(d) && d > 0.0) {
            ++arExposureFrames;
            if (arExposureMinS <= 0.0 || d < arExposureMinS) arExposureMinS = d;
            if (d > arExposureMaxS) arExposureMaxS = d;
            // THE IDENTITY CHECK.  Only over frames that carry BOTH numbers;
            // a one-sided frame proves nothing and must not dilute the max.
            const double dev = in.exposureDurationS;
            if (std::isfinite(dev) && dev > 0.0) {
                ++arVsDevicePairedFrames;
                const double ad = std::fabs(d - dev);
                if (ad > arVsDeviceMaxAbsDeltaS) arVsDeviceMaxAbsDeltaS = ad;
                const double rel = ad / dev;
                if (rel > arVsDeviceMaxRelDelta) arVsDeviceMaxRelDelta = rel;
            }
        }
        // exposureOffset is an EV OFFSET: 0.0 is a legal reading and negative
        // values are normal, so this tracks its own presence flag rather than
        // inferring one from the value or from the duration's counter.
        const double ev = in.arExposureOffsetEV;
        if (std::isfinite(ev)) {
            if (!arExposureOffsetSeen) {
                arExposureOffsetSeen = true;
                arExposureOffsetMinEV = arExposureOffsetMaxEV = ev;
            } else {
                if (ev < arExposureOffsetMinEV) arExposureOffsetMinEV = ev;
                if (ev > arExposureOffsetMaxEV) arExposureOffsetMaxEV = ev;
            }
        }
    }

    /// v6 — THE FRAME'S EXACT RADIOMETRIC FACTOR.  Reference exposure ÷ this
    /// frame's exposure, both as duration × ISO.  Returns 1.0 (identity) when
    /// either side is missing, which is every pack captured before v6.
    double exposureGainFor(const FrameInput& in) {
        curExpResidual = 1.0;
        const double e = in.exposureDurationS * in.exposureISO;
        const bool haveMeta = (e > 0.0) && std::isfinite(e);
        // The exposure TRACE is recorded whether or not the normalisation is
        // enabled: with it off, the trace is the only evidence of what the
        // camera did, and that arm is exactly when it matters.
        if (haveMeta) {
            ++exposureMetaFrames;
            if (exposureMin <= 0.0 || e < exposureMin) exposureMin = e;
            if (e > exposureMax) exposureMax = e;
        }
        if (!cfg.exposureNormalize) {
            // THE CONTROL ARM STILL REPORTS HONESTLY.  With the normalisation
            // off we decline to CORRECT the camera, but we have measured what
            // it did — so the effective scene→canvas transfer carries the full
            // uncorrected camera term.  Reporting 1.0 here would make the
            // control arm's band metric flatter than the arm it is controlling
            // for, which is the one thing an A/B may never do.
            if (haveMeta && refExposure > 0.0) curExpResidual = e / refExposure;
            return 1.0;
        }
        if (!haveMeta || !(refExposure > 0.0)) return 1.0;
        double g = refExposure / e;
        if (!std::isfinite(g) || g <= 0.0) return 1.0;
        const double lo = 1.0 / std::max(1.0, cfg.exposureGainClamp);
        const double hi = std::max(1.0, cfg.exposureGainClamp);
        if (g < lo || g > hi) {
            ++exposureClampedFrames;
            g = std::max(lo, std::min(hi, g));
        }
        // WHAT THE CAMERA TERM LEAVES BEHIND after normalisation.  Exactly 1
        // when the normalisation was exact, which is the whole point; only a
        // CLAMPED gain leaves a residue, and then it is honestly reported
        // rather than assumed away.
        curExpResidual = (e / refExposure) * g;
        return g;
    }

    /// Apply an exposure gain to a warped strip ROI IN LINEAR LIGHT.  A gain
    /// of exactly 1.0 is a no-op — not "a LUT that happens to be the identity"
    /// — so the byte-parity of a metadata-free pack is structural rather than
    /// a property of the sRGB round-trip.
    void applyExposureGain(cv::Mat& roiBgr, double g) {
        if (!(std::fabs(g - 1.0) > 1e-9) || roiBgr.empty()) return;
        if (expLut.empty() || std::fabs(expLutGain - g) > 1e-12) {
            buildExposureLut(g, expLut);
            expLutGain = g;
        }
        cv::LUT(roiBgr, expLut, roiBgr);
    }

    /// The interquartile mean of `n` values, computed on a COPY.
    ///
    /// The copy is not defensive tidiness: the band pass below must read the
    /// differences in ROW ORDER after the whole-slab statistic has been taken,
    /// and `nth_element` permutes its input.  `scratch` is a member so this
    /// allocates nothing after the first boundary.
    static double interquartileMean(const float* v, size_t n,
                                    std::vector<float>& scratch) {
        if (n == 0) return 0.0;
        scratch.assign(v, v + n);
        const size_t q1 = n / 4, q3 = (3 * n) / 4;
        std::nth_element(scratch.begin(), scratch.begin() + q1, scratch.end());
        if (q1 + 1 <= q3 && q3 < n) {
            std::nth_element(scratch.begin() + q1 + 1, scratch.begin() + q3,
                             scratch.end());
        }
        double sum = 0.0;
        size_t cnt = 0;
        for (size_t i = q1; i <= q3 && i < n; ++i) { sum += scratch[i]; ++cnt; }
        return (cnt > 0) ? (sum / (double)cnt) : 0.0;
    }

    /// v6 — THE PHOTOMETRIC SEAM, over the WHOLE shared footprint.
    ///
    /// `[wx0, x0)` is the slab of canvas the incoming warp already covers and
    /// the high-water clip is about to discard: the SAME world content exists
    /// there twice, once as already-committed canvas and once as this frame's
    /// (already photometrically corrected) pixels.  The DC difference between
    /// them is exactly the step the boundary will commit.
    ///
    /// THREE THINGS MAKE THIS AN INSTRUMENT RATHER THAN A NUMBER, and each of
    /// them was measured on the operator's own packs before being chosen:
    ///
    ///  1. IT IS A MEDIAN OVER PIXELS, not one canvas column against one.
    ///     v5's single-column version is quantisation-limited at ±1 DN and
    ///     could not resolve a 0.21 DN median from a 4.68 DN band — which is
    ///     why pack 15-58-22 reported a step and still verdicted clean.
    ///
    ///  2. IT IS RESTRICTED TO LOW-GRADIENT PIXELS.  Photometry is only
    ///     measurable where the scene has no structure of its own: on a
    ///     textured pixel a quarter-pixel of misregistration moves the value
    ///     by more than any exposure step, so including those pixels measures
    ///     REGISTRATION.  This is the same restriction the offline owner map
    ///     used to separate the camera's drift from the engine's gain.
    ///
    ///  3. THE STATISTIC IS AN INTERQUARTILE MEAN, which is what makes a
    ///     MISREGISTERED SCENE EDGE unable to fire it: a shifted edge
    ///     contributes a symmetric ± difference field whose outliers are
    ///     trimmed from BOTH tails, while an exposure mismatch offsets every
    ///     pixel the same way and survives the trim intact.  A plain median
    ///     would be equally robust but is quantised to whole DN on integer
    ///     input — the very limitation that made v5's metric blind.  Measured
    ///     on real, heavily textured, well-registered boundaries from the
    ///     operator's packs: |step| p50 0.27-0.38 DN.  Scene structure does
    ///     not inflate it.
    ///
    ///  4. UNIFORMITY IS TESTED ACROSS THE BOUNDARY'S OWN EXTENT.  The
    ///     boundary is a vertical line in the canvas and its extent is the
    ///     CROSS-SWEEP direction (canvas rows).  An exposure change offsets
    ///     every point along it identically; a scene edge, a shading ramp, or
    ///     a local misregistration does not.  So the slab's rows are split
    ///     into `photoUniformBands` bands, each band's own interquartile mean
    ///     is computed, and `seamPhotoUniform` is the fraction of bands that
    ///     agree with the whole-slab step.  `seamPhotoSpreadDN` is the worst
    ///     band's disagreement in DN.
    ///
    ///     THIS REPLACED A PER-PIXEL VERSION THAT CARRIED NO INFORMATION.
    ///     Measured on the operator's four packs, the per-pixel form flagged
    ///     71-99.7% of boundaries "non-uniform" — a diagnostic that reads
    ///     ~100% fail cannot discriminate anything, because at the operating
    ///     point the spread of a low-gradient difference field is dominated by
    ///     the residual sub-pixel resample, not by the step.  The across-
    ///     extent form flags 8.5 / 12.5 / 16.5 / 21.3%.
    ///
    ///     It is REPORTED, not used to exclude samples: excluding
    ///     low-uniformity boundaries would condition the percentiles on the
    ///     boundaries that happened to look flat, which is precisely the bug
    ///     the v5 luma metric's own comment warns about ("a step of exactly
    ///     zero is a measurement, not a missing one").  The cross-check that
    ///     the requirement is nevertheless MET is reported beside it:
    ///     `seamPhotoUniStepP95DN` is the same percentile over the DC-like
    ///     boundaries ALONE, and on the operator's packs it reads 1.57 / 1.66
    ///     / 0.75 / 1.85 DN against an all-boundaries 2.09 / 1.86 / 0.77 /
    ///     2.43 — i.e. the gate fires on genuinely DC-like steps and is not an
    ///     artefact of registration-shaped ones.
    ///
    /// Fewer than two bands can measure ⇒ uniformity is UNKNOWN, encoded as
    /// -1 rather than as 1.0.  "Not measured" is its own state here too.
    void measureSeamPhotometry(const cv::Mat& roiBgr, const cv::Mat& roiMask,
                               int wx0, int x0) {
        lastSeamPhotoDN = 0.0;
        lastSeamPhotoUniform = -1.0;
        lastSeamPhotoSpreadDN = 0.0;
        lastSeamPhotoBands = 0;
        lastSeamPhotoValid = false;
        if (!cfg.seamMetrics || !anyPainted || canvasH <= 0) return;
        const int ow = x0 - wx0;
        if (ow < 4) return;
        if (wx0 < 0 || wx0 + ow > canvasW) return;

        const cv::Rect canRoi(wx0, 0, ow, canvasH);
        const cv::Rect srcRoi(0, 0, ow, canvasH);
        cv::Mat shared;
        cv::bitwise_and(roiMask(srcRoi), coverage(canRoi), shared);
        cv::cvtColor(canvas(canRoi), photoGrayA, cv::COLOR_BGR2GRAY);
        cv::cvtColor(roiBgr(srcRoi), photoGrayB, cv::COLOR_BGR2GRAY);
        // Gradient of the ALREADY-COMMITTED side — the reference for "is there
        // scene structure here?".  Scharr/Sobel ksize 3 sums to 4× the true
        // per-pixel slope, hence the 0.25.
        cv::Sobel(photoGrayA, photoGradX, CV_16S, 1, 0, 3);
        cv::Sobel(photoGrayA, photoGradY, CV_16S, 0, 1, 3);

        photoDiffs.clear();
        photoDiffRows.clear();
        photoBaseSum = 0.0;
        photoBaseCount = 0;
        int firstRow = -1, lastRow = -1;
        const int rowStep = 2;   // half the rows is ~8 k samples on a real
                                 // strip: plenty for a median, and it keeps
                                 // this off the engine queue's critical path
        const double gradMax = 4.0 * cfg.photoGradMaxDN;   // pre-scaled bound
        for (int r = 0; r < canvasH; r += rowStep) {
            const uchar* sh = shared.ptr<uchar>(r);
            const uchar* ga = photoGrayA.ptr<uchar>(r);
            const uchar* gb = photoGrayB.ptr<uchar>(r);
            const int16_t* gx = photoGradX.ptr<int16_t>(r);
            const int16_t* gy = photoGradY.ptr<int16_t>(r);
            for (int c = 0; c < ow; ++c) {
                if (!sh[c]) continue;
                const double g = (double)std::abs(gx[c]) + (double)std::abs(gy[c]);
                if (g > gradMax) continue;
                photoDiffs.push_back((float)((double)gb[c] - (double)ga[c]));
                photoDiffRows.push_back(r);
                if (firstRow < 0) firstRow = r;
                lastRow = r;
                photoBaseSum += (double)ga[c];
                ++photoBaseCount;
            }
        }
        if ((int)photoDiffs.size() < cfg.photoMinSamples) return;

        // THE INTERQUARTILE MEAN, not the median.  The differences are
        // integer DN, so a median of them is quantised to whole DN — which is
        // exactly the limitation that made v5's single-column step unable to
        // tell a 0.21 DN median from a 4.68 DN band, and it would be absurd to
        // reproduce it here.  Averaging the middle 50% keeps the median's
        // resistance to a misregistered edge (whose difference field is
        // symmetric, so its outliers are trimmed from BOTH tails) and recovers
        // sub-DN resolution.
        const size_t n = photoDiffs.size();
        // The band pass reads the ORIGINAL (row-ordered) differences, and
        // nth_element below permutes them — so it runs FIRST.
        const double step0 = interquartileMean(photoDiffs.data(), n, photoScratch);
        double spread = 0.0;
        int okBands = 0, qualBands = 0;
        if (firstRow >= 0 && lastRow >= firstRow) {
            const int nb = std::max(2, cfg.photoUniformBands);
            const int minPer = std::max(64, cfg.photoMinSamples / (2 * nb));
            const double tolB = std::max(1.0, 0.5 * std::fabs(step0));
            const int span = lastRow - firstRow + 1;
            const int h = std::max(1, (span + nb - 1) / nb);
            for (int bi = 0; bi < nb; ++bi) {
                const int b0 = firstRow + bi * h;
                const int b1 = std::min(lastRow + 1, b0 + h);
                if (b0 >= b1) continue;
                photoBand.clear();
                for (size_t i = 0; i < n; ++i) {
                    const int rr = photoDiffRows[i];
                    if (rr >= b0 && rr < b1) photoBand.push_back(photoDiffs[i]);
                }
                if ((int)photoBand.size() < minPer) continue;
                const double bstep = interquartileMean(photoBand.data(),
                                                       photoBand.size(),
                                                       photoScratch);
                ++qualBands;
                spread = std::max(spread, std::fabs(bstep - step0));
                if (std::fabs(bstep - step0) <= tolB) ++okBands;
            }
        }
        const double step = step0;
        // The BASE level the step is a fraction OF, over the SAME pixels.  A
        // 2 DN step on a 30 DN shadow and on a 200 DN highlight are different
        // defects, and the drift integral has to be a ratio to be comparable
        // across packs — or to be checked against an independent measurement
        // of the camera's own drift.
        lastSeamPhotoBaseDN = (photoBaseCount > 0)
            ? (photoBaseSum / (double)photoBaseCount) : 0.0;
        lastSeamPhotoDN = step;
        lastSeamPhotoBands = qualBands;
        // Fewer than two bands could measure ⇒ UNKNOWN, and the honest
        // encoding of unknown is not 1.0.  -1 so no consumer can average it
        // into a fraction by accident.  The SPREAD goes with it: one
        // qualifying band trivially reproduces the whole-slab step up to the
        // trim, so reporting its difference would dress rounding up as a
        // measurement.
        const bool uniKnown = (qualBands >= 2);
        lastSeamPhotoSpreadDN = uniKnown ? spread : 0.0;
        lastSeamPhotoUniform = uniKnown
            ? ((double)okBands / (double)qualBands) : -1.0;
        lastSeamSlabW = ow;
        lastSeamPhotoValid = true;
    }

    /// Fold one committed boundary's SIGNED DC step into the drift profile.
    ///
    /// TWO NORMALISATIONS, and both are load-bearing:
    ///
    ///  1. THE STEP IS NOT AN INCREMENT.  It is measured over the discarded
    ///     slab `[wx0, x0)`, which is ~24 canvas columns wide, while the strip
    ///     commits only 2-6.  The canvas under that slab was painted by the
    ///     LAST HANDFUL of frames, so consecutive boundaries re-measure the
    ///     same brightness difference ~6-12 times over.  Summing them raw
    ///     over-counts by that factor — measured: the raw sum reached 300 DN
    ///     on a 0-255 raster, which is not a brightness, it is a bookkeeping
    ///     error.  The increment per committed column is therefore
    ///     `step ÷ meanLag`, and for a uniformly painted slab the mean lag is
    ///     half its width.  (Approximate, and stated as such: the slab is a
    ///     mosaic of several frames, so half-width is the mean age only if
    ///     they contributed evenly.)
    ///
    ///  2. IT IS A RATIO, not DN.  A 2 DN step on a 30 DN shadow and on a
    ///     200 DN highlight are different defects; and only a ratio can be
    ///     checked against the offline owner map's independent measurement of
    ///     the camera's own cumulative brightness change (C = 1.50-1.79 on
    ///     these four packs).  Accumulated in LOG space so it composes.
    /// v8 — fold one boundary's SIGNED committed-pixel misregistration into
    /// the running sum and its excursion.  Three adds and two compares per
    /// committed strip; the measurement itself was already being made.
    void noteJogDrift(double signedPx) {
        if (!std::isfinite(signedPx)) return;
        jogAcc += signedPx;
        jogAccMin = std::min(jogAccMin, jogAcc);
        jogAccMax = std::max(jogAccMax, jogAcc);
        ++jogAccN;
    }

    void noteSeamPhotoStep(int u, double stepDN, double baseDN,
                           double committedW, double slabW) {
        if (!std::isfinite(stepDN) || !std::isfinite(baseDN)) return;
        if (baseDN < 8.0) return;          // too dark to form a ratio
        const double lag = 0.5 * slabW;
        if (!(lag >= 1.0) || !(committedW > 0.0)) return;
        double inc = (stepDN / baseDN) * (committedW / lag);
        if (!std::isfinite(inc)) return;
        inc = std::max(-0.9, std::min(9.0, inc));
        photoCumDN += std::log1p(inc);
        photoCumMinDN = std::min(photoCumMinDN, photoCumDN);
        photoCumMaxDN = std::max(photoCumMaxDN, photoCumDN);
        const int win = std::max(2, cfg.photoLocalWindowPx);
        while (!photoCumMinQ.empty() && photoCumMinQ.back().second >= photoCumDN)
            photoCumMinQ.pop_back();
        photoCumMinQ.emplace_back(u, photoCumDN);
        while (!photoCumMaxQ.empty() && photoCumMaxQ.back().second <= photoCumDN)
            photoCumMaxQ.pop_back();
        photoCumMaxQ.emplace_back(u, photoCumDN);
        const int left = u - win + 1;
        while (!photoCumMinQ.empty() && photoCumMinQ.front().first < left)
            photoCumMinQ.pop_front();
        while (!photoCumMaxQ.empty() && photoCumMaxQ.front().first < left)
            photoCumMaxQ.pop_front();
        if (photoCumMinQ.empty() || photoCumMaxQ.empty()) return;
        const double p2p = photoCumMaxQ.front().second - photoCumMinQ.front().second;
        if (p2p > photoDriftLocalDN) {
            photoDriftLocalDN = p2p;
            photoDriftWorstU = left;
        }
    }

    /// Record the photometric scale the committed columns `[x0, x1)` carry.
    /// The vector is the ONLY thing that can see a band: the chain moves 0.2%
    /// per strip and 14% over 40 columns, and no per-boundary metric is even
    /// in principle able to report that.
    void recordColumnScale(int x0, int x1, double scale) {
        if (x1 <= x0 || canvasW <= 0) return;
        if ((int)colScale.size() < canvasW) colScale.resize((size_t)canvasW, 0.0f);
        const int lo = std::max(0, x0), hi = std::min(canvasW, x1);
        const float v = (float)((std::isfinite(scale) && scale > 0.0) ? scale : 1.0);
        for (int x = lo; x < hi; ++x) colScale[(size_t)x] = v;
    }

    /// Walk the photometric field up to `frontier` (exclusive), maintaining
    /// the sliding peak-to-peak.  Called after every commit path updates
    /// `highWater`, and once more from finish() so the tail flush is included.
    /// Idempotent: the cursor only ever moves forward.
    void advancePhotoScan(double frontier) {
        if (!anyPainted || colScale.empty()) return;
        const int win = std::max(2, cfg.photoLocalWindowPx);
        if ((int)photoRingMin.size() != win) {
            photoRingMin.assign((size_t)win, 0);
            photoRingMax.assign((size_t)win, 0);
            photoHMin = photoTMin = photoHMax = photoTMax = 0;
        }
        if (photoScanU < 0) {
            photoScanU = minPaintedU;
            photoStartU = minPaintedU;
        }
        int limit = (int)std::floor(frontier);
        limit = std::min(limit, std::min(maxPaintedU, (int)colScale.size()));
        for (int x = photoScanU; x < limit; ++x) {
            if (x < 0) continue;
            const double v = (double)colScale[(size_t)x];
            if (v > 0.0) {
                if (photoCols == 0) { photoGMin = v; photoGMax = v; }
                else {
                    photoGMin = std::min(photoGMin, v);
                    photoGMax = std::max(photoGMax, v);
                }
                ++photoCols;
                while (photoTMin > photoHMin &&
                       (double)colScale[(size_t)photoRingMin[(photoTMin - 1) % win]] >= v)
                    --photoTMin;
                photoRingMin[photoTMin % win] = x; ++photoTMin;
                while (photoTMax > photoHMax &&
                       (double)colScale[(size_t)photoRingMax[(photoTMax - 1) % win]] <= v)
                    --photoTMax;
                photoRingMax[photoTMax % win] = x; ++photoTMax;
            }
            // Unpainted columns push nothing but still AGE the window, so a
            // hole can neither masquerade as a dip nor freeze a stale extreme.
            const int left = x - win + 1;
            while (photoTMin > photoHMin && photoRingMin[photoHMin % win] < left) ++photoHMin;
            while (photoTMax > photoHMax && photoRingMax[photoHMax % win] < left) ++photoHMax;
            if (x - photoStartU + 1 < win) continue;
            if (photoTMin <= photoHMin || photoTMax <= photoHMax) continue;
            const double a = (double)colScale[(size_t)photoRingMin[photoHMin % win]];
            const double b = (double)colScale[(size_t)photoRingMax[photoHMax % win]];
            if (!(a > 0.0)) continue;
            const double p2p = (b / a - 1.0) * 100.0;
            if (p2p > photoWorstP2P) { photoWorstP2P = p2p; photoWorstAt = left; }
        }
        if (limit > photoScanU) photoScanU = limit;
    }

    /// Cross-sweep misregistration between the incoming warp and the canvas
    /// it is about to butt against, measured on committed pixels.  In INTERNAL
    /// canvas coordinates the sweep always runs along +x (that is what the
    /// axis matrix `A` is for), so the cross component is always y.
    // v13 — jog-guard state.  `d8JogRun` is canvas-scoped (reset with
    // the canvas at the latch); `lastJogRefused` is per-commit, read by the
    // ingest caller to emit the JogHeld outcome.
    int  d8JogRun = 0;
    bool lastJogRefused = false;

    void measureCanvasJog(const cv::Mat& roiBgr, const cv::Mat& roiMask,
                          int wx0, int x0) {
        lastSeamJogPx = 0.0;
        lastSeamJogSignedPx = 0.0;
        lastSeamJogValid = false;
        if (!cfg.seamMetrics || !anyPainted || canvasH <= 0) return;
        const int ow = x0 - wx0;
        if (ow < 8) return;
        const int jw = std::min(ow, 64);
        const int jx = x0 - jw;
        if (jx < 0 || jx + jw > canvasW) return;
        const cv::Rect ovRoi(jx, 0, jw, canvasH);
        const cv::Rect ovSrc(jx - wx0, 0, jw, canvasH);
        if (ovSrc.x < 0 || ovSrc.x + jw > roiMask.cols) return;

        cv::Mat both;
        cv::bitwise_and(roiMask(ovSrc), coverage(ovRoi), both);
        cv::Mat rowMin;
        cv::reduce(both, rowMin, 1, cv::REDUCE_MIN, CV_8U);
        int bestR0 = -1, bestLen = 0, runR0 = -1, runLen = 0;
        for (int r = 0; r < canvasH; ++r) {
            if (rowMin.at<uchar>(r, 0)) {
                if (runLen == 0) runR0 = r;
                ++runLen;
                if (runLen > bestLen) { bestLen = runLen; bestR0 = runR0; }
            } else {
                runLen = 0;
            }
        }
        if (bestR0 < 0 || bestLen < 64) return;
        int h = std::min(bestLen, 512);
        h &= ~1;                                  // even rows: kinder DFT size
        if (h < 64) return;
        const int r0 = bestR0 + (bestLen - h) / 2;

        const cv::Rect aR(jx, r0, jw, h), bR(jx - wx0, r0, jw, h);
        cv::Mat ga, gb;
        cv::cvtColor(canvas(aR), ga, cv::COLOR_BGR2GRAY);
        cv::cvtColor(roiBgr(bR), gb, cv::COLOR_BGR2GRAY);
        ga.convertTo(jogA, CV_32F);
        gb.convertTo(jogB, CV_32F);
        if (jogHann.rows != h || jogHann.cols != jw)
            cv::createHanningWindow(jogHann, cv::Size(jw, h), CV_32F);
        double resp = 0.0;
        cv::Point2d sh;
        try {
            sh = cv::phaseCorrelate(jogA, jogB, jogHann, &resp);
        } catch (const cv::Exception&) {
            return;
        }
        if (!std::isfinite(sh.x) || !std::isfinite(sh.y)) return;
        if (resp < cfg.minPhaseResponse) return;
        // An |offset| past half the band is a wrapped correlation, not a
        // measurement — the same reasoning as the aliasing cage.
        if (std::fabs(sh.y) > 0.4 * (double)h) return;
        lastSeamJogPx = std::fabs(sh.y);
        // v8 — KEEP THE SIGN.  `fabs` here used to destroy, at the point of
        // measurement, the only thing that distinguishes a pair of strips that
        // disagree from a panorama that has drifted; nothing downstream could
        // recover it and neither could the pack.
        lastSeamJogSignedPx = sh.y;
        lastSeamJogValid = true;
    }

    /// ── v10: THE LENS GATE, run ONCE, on the reference frame's own numbers.
    ///
    /// Called from the reference latch, after refFx/refCx/imgW are set.  There
    /// is no second call: a reference RESEED keeps the same body and the same
    /// raster, and re-deciding on each reseed would let ARKit's focus
    /// breathing flip the gate mid-sweep at the tolerance edge.  Drift within
    /// the session is handled per strip instead (`lensOkForFocal`).
    void resolveLens(double fx, int imageWidth) {
        lensDec = lens::resolve(cfg, fx, imageWidth);
        lensReady = false;
        lensPeakRadialPx = 0.0;
        lensPeakResidualPx = 0.0;
        lensFxLo = lensFxHi = 0.0;
        lensCorrectedStrips = 0;
        lensSkippedStrips = 0;
        if (!lensDec.applied()) return;
        const double rfx = (refFx > 1.0) ? refFx : 1.0;
        const double rfy = (refFy > 1.0) ? refFy : rfx;
        // The LUT is tabulated over IDEAL radii.  A canvas column can ask for
        // a source point outside the raster, so the table runs past the
        // frame's own corner; past the table the scale clamps, and those
        // samples are outside the frame, where the warp mask discards them.
        double corner = 0.0;
        const double xs[2] = {0.0, (double)std::max(1, imgW) - 1.0};
        const double ys[2] = {0.0, (double)std::max(1, imgH) - 1.0};
        for (int i = 0; i < 2; ++i) {
            for (int j = 0; j < 2; ++j) {
                const double u = (xs[i] - refCx) / rfx;
                const double v = (ys[j] - refCy) / rfy;
                corner = std::max(corner, std::sqrt(u * u + v * v));
            }
        }
        // A model that was ACCEPTED and then could not be tabulated is its own
        // outcome, not "applied with applied:false".  Say so in ONE field.
        if (!(corner > 0.0) || !std::isfinite(corner)) {
            lensDec.gate = lens::Gate::LutFailed;
            return;
        }
        lensLut.build(lensDec.model, corner * 1.35,
                      std::max(16, cfg.lensLutNodes));
        if (!lensLut.valid()) {
            lensDec.gate = lens::Gate::LutFailed;
            return;
        }
        // What the correction is WORTH, in source px, over this frame's own
        // radius range — the numbers that belong in the pack beside k1/k2,
        // because a coefficient pair means nothing to a pack reader.
        //
        // TWO of them, named apart, because "peak" alone is ambiguous and the
        // ambiguity has already caused one misreading:
        //   · RADIAL   — the total move, |r_obs − r_ideal|.
        //   · RESIDUAL — the same after least-squares removal of the pure
        //     SCALE term (d ← d − a·r).  A pure scale bends nothing, so this
        //     is the part a straightness ruler can ever see: the moustache.
        const int nS = 512;
        double sdr = 0.0, srr = 0.0;
        std::vector<double> rs, ds;
        rs.reserve((size_t)nS + 1);
        ds.reserve((size_t)nS + 1);
        for (int i = 0; i <= nS; ++i) {
            const double r = corner * (double)i / (double)nS;
            const double d = (lensLut.scaleForRadiusSq(r * r) - 1.0) * r * rfx;
            if (!std::isfinite(d)) continue;
            lensPeakRadialPx = std::max(lensPeakRadialPx, std::fabs(d));
            rs.push_back(r * rfx);
            ds.push_back(d);
            sdr += d * r * rfx;
            srr += (r * rfx) * (r * rfx);
        }
        const double aFit = (srr > 1e-12) ? (sdr / srr) : 0.0;
        for (size_t i = 0; i < ds.size(); ++i)
            lensPeakResidualPx = std::max(lensPeakResidualPx,
                                          std::fabs(ds[i] - aFit * rs[i]));
        // The per-strip focal window.  On a table match it is the TABLE's
        // window (an absolute statement about the calibrated lens); on an
        // override there is no table, so it is the reference frame's own fx
        // — which still catches a lens switch, which is what it is for.
        const double tol = std::fabs(cfg.lensFocalTolFrac);
        const double centre = (lensDec.gate == lens::Gate::Applied &&
                               lensDec.expectedFxOverWidth > 0.0 && imageWidth > 0)
                                  ? lensDec.expectedFxOverWidth * (double)imageWidth
                                  : rfx;
        lensFxLo = centre * (1.0 - tol);
        lensFxHi = centre * (1.0 + tol);
        lensReady = true;
    }

    /// Is the frame this strip paints FROM still the lens the gate cleared?
    /// The backfill and the tail flush paint from an EARLIER frame, so this
    /// reads `curK`, which the caller has already pointed at that frame.
    bool lensOkForFocal() const {
        return lensFocalOk((curK[0] > 1.0) ? curK[0] : refFx);
    }
    /// The same gate for an EXPLICIT focal — the estimator and the seed
    /// repaint resample frames `curK` does not point at.
    bool lensFocalOk(double fx) const {
        if (!lensReady) return false;
        return std::isfinite(fx) && fx >= lensFxLo && fx <= lensFxHi;
    }

    /// THE FOLD.  The painter already resamples the source through `Hroi`;
    /// this builds that same sampling as an explicit map with the radial
    /// correction composed into it, so the correction costs the STRIP's pixels
    /// and not the frame's.  Canvas px → (through Hroi⁻¹) ideal source px →
    /// (through the LUT) the px the lens actually put that content on.
    bool buildLensMap(const Mat33& Hroi, int roiW, int roiH,
                      double fx, double fy, double cx, double cy,
                      cv::Mat& map) const {
        Mat33 Hinv;
        try { Hinv = Hroi.inv(); } catch (const cv::Exception&) { return false; }
        if (!std::isfinite(Hinv(0, 0)) || !std::isfinite(Hinv(2, 2))) return false;
        if (roiW <= 0 || roiH <= 0) return false;
        map.create(roiH, roiW, CV_32FC2);

        // ROWS THE FRAME CANNOT REACH.  The canvas is as tall as the whole
        // attitude-rectified band; a single frame's footprint is usually
        // shorter, and every row outside it resolves to "outside the source"
        // for every column.  Computing the map there is pure waste, so those
        // rows are filled with the invalid sentinel in one pass and skipped.
        //
        // SAFE BY CONSTRUCTION: the span is taken from the source rectangle
        // EXPANDED by the model's own peak displacement plus a margin, and any
        // degenerate mapping (a corner behind the camera, a non-finite result,
        // an implausible span) falls back to the full height.  Getting this
        // wrong would silently drop painted rows, so it fails toward doing
        // MORE work, never less.
        int yLo = 0, yHi = roiH;
        {
            const double pad = std::max(4.0, lensPeakRadialPx + 4.0);
            const double xs[4] = {-pad, (double)imgW + pad, -pad,
                                  (double)imgW + pad};
            const double ys[4] = {-pad, -pad, (double)imgH + pad,
                                  (double)imgH + pad};
            double lo = 1e18, hi = -1e18;
            bool ok = (imgW > 0 && imgH > 0);
            for (int i = 0; i < 4 && ok; ++i) {
                double u = 0.0, v = 0.0;
                if (!mapPoint(Hroi, xs[i], ys[i], &u, &v)) { ok = false; break; }
                if (!std::isfinite(v)) { ok = false; break; }
                lo = std::min(lo, v);
                hi = std::max(hi, v);
            }
            if (ok && hi >= lo && (hi - lo) < 1e7) {
                yLo = std::max(0, (int)std::floor(lo) - 2);
                yHi = std::min(roiH, (int)std::ceil(hi) + 2);
                if (yHi <= yLo) { yLo = 0; yHi = roiH; }
            }
        }
        if (yLo > 0) map.rowRange(0, yLo).setTo(cv::Scalar(-1.0, -1.0));
        if (yHi < roiH) map.rowRange(yHi, roiH).setTo(cv::Scalar(-1.0, -1.0));

        const double ifx = 1.0 / fx, ify = 1.0 / fy;
        // `kCoordCap` exists because cv::remap's float→fixed-point conversion
        // (cvRound(v*32)) has no range clamp of its own, unlike
        // warpPerspective which clamps before its cast.  Measured over all
        // four operator packs (1179 strips) the map's largest |coordinate| is
        // 2376-2943 px, so this never fires today; it
        // is here so that a future degenerate homography cannot turn into
        // undefined behaviour inside OpenCV.  Anything past the cap is
        // outside the frame by four orders of magnitude either way.
        const double kCoordCap = 1e6;
        for (int y = yLo; y < yHi; ++y) {
            double px = Hinv(0, 1) * (double)y + Hinv(0, 2);
            double py = Hinv(1, 1) * (double)y + Hinv(1, 2);
            double pw = Hinv(2, 1) * (double)y + Hinv(2, 2);
            float* dst = map.ptr<float>(y);
            for (int x = 0; x < roiW; ++x, px += Hinv(0, 0), py += Hinv(1, 0),
                                           pw += Hinv(2, 0)) {
                if (!(std::fabs(pw) > 1e-12)) {
                    dst[2 * x] = -1.0f; dst[2 * x + 1] = -1.0f;
                    continue;
                }
                const double iw = 1.0 / pw;
                const double xu = px * iw, yu = py * iw;
                const double u = (xu - cx) * ifx, v = (yu - cy) * ify;
                const double s = lensLut.scaleForRadiusSq(u * u + v * v);
                const double sx = u * s * fx + cx, sy = v * s * fy + cy;
                if (!std::isfinite(sx) || !std::isfinite(sy) ||
                    std::fabs(sx) > kCoordCap || std::fabs(sy) > kCoordCap) {
                    dst[2 * x] = -1.0f; dst[2 * x + 1] = -1.0f;
                    continue;
                }
                dst[2 * x] = (float)sx;
                dst[2 * x + 1] = (float)sy;
            }
        }
        return true;
    }

    /// THE ONE RESAMPLE (v10).  Every pixel a frame puts on this canvas goes
    /// through here: the lens map when the gate cleared the session and the
    /// frame's own focal is inside its window, else the plain warp.  `map` is
    /// the caller's scratch for the LUT (`commitStrip` lends `lensMap`; the
    /// const estimator brings its own).  Returns +1 lens-corrected, −1 lens
    /// ready but this frame refused or its map degenerate (painted through
    /// the plain warp, and the caller COUNTS it), 0 no lens in this session.
    /// `commitStrip`, the trajectory estimator and the seed repaint all read
    /// it, so a block can never be compared against, or re-placed by, a
    /// geometry its strips were not painted with.
    /// `roiH` defaults to the canvas height; the preview's padded scratch
    /// passes its own.
    int resampleFrame(const cv::Mat& src, const Mat33& Hroi, int roiW,
                      double fx, double fy, double cx, double cy,
                      cv::Mat& map, cv::Mat* bgr, cv::Mat* mask,
                      int roiH = -1) const {
        if (roiH < 0) roiH = canvasH;
        int tally = 0;
        bool used = false;
        if (lensReady && lensFocalOk(fx)) {
            if (fx > 1.0 && fy > 1.0 &&
                buildLensMap(Hroi, roiW, roiH, fx, fy, cx, cy, map)) {
                cv::remap(src, *bgr, map, cv::noArray(), cv::INTER_LINEAR,
                          cv::BORDER_CONSTANT, cv::Scalar());
                cv::remap(onesMask, *mask, map, cv::noArray(),
                          cv::INTER_NEAREST, cv::BORDER_CONSTANT, cv::Scalar());
                used = true;
                tally = +1;
            } else {
                tally = -1;
            }
        } else if (lensReady) {
            tally = -1;
        }
        if (!used) {
            cv::warpPerspective(src, *bgr, cv::Mat(Hroi), cv::Size(roiW, roiH),
                                cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar());
            cv::warpPerspective(onesMask, *mask, cv::Mat(Hroi),
                                cv::Size(roiW, roiH), cv::INTER_NEAREST,
                                cv::BORDER_CONSTANT, cv::Scalar());
        }
        return tally;
    }

    /// Commit one warped strip.  `H` maps SOURCE px → INTERNAL canvas px.
    /// Paints [max(paintLeft, 0), x1) only; everything left of the frontier is
    /// already owned and is never touched.  Returns false when the canvas
    /// could not be grown to fit.
    /// `expGain` is the frame's EXACT radiometric factor (v6).  It is applied
    /// to the warped ROI BEFORE the overlap fit runs, so the chained gain is
    /// left correcting a residual rather than chasing the camera — and it is
    /// the SOURCE frame's own factor, which is why the tail flush and the
    /// interior backfill pass `lastExpGain` rather than the current frame's.
    /// `applyChainGainNoFit` (Option C): apply the CHAINED gain `gainCum` to
    /// this commit without fitting it.  Only the strip chain may move
    /// `gainCum` — a repaint that re-fitted it would let the same frame vote
    /// twice — but a repaint that omitted it would commit pixels 24-30 %
    /// darker than the strips beside them (measured `gainCum` reaches
    /// 0.70-0.76 on the device packs), which is the band the whole v6
    /// photometric pass exists to remove.  Ignored when `doGain` is true,
    /// where the fit applies the chain itself; false ⇒ byte-identical.
    /// `measureLeft` (2026-09-08): the origin of the MEASUREMENT window,
    /// separated from `paintLeft`, which is the origin of the PAINT.
    ///
    /// They were the same number, and that made a bookkeeping choice reach a
    /// quality gate.  `wx0` is derived from `paintLeft`, the d8 jog guard
    /// correlates over `[wx0, x0)` and the exposure fit is fitted over the same
    /// slab — so ANY caller that moves where a strip starts painting also moves
    /// the band the guard reads and the sample the gain is fitted on.  The
    /// seed-junction meet (`Config::seedFrontierMeet`) does exactly that, by
    /// gapPx ≈ 9-13 px against a 24 px window, and the consequence was
    /// measured on this Mac over the operator's 36-pack corpus at
    /// phaseWindowPx 768: d8JogRefusals 31 → 26, the junction of
    /// pull3-pp_1788825920544 flipping painted → refused (jog 9.907 → 10.425
    /// across that pack's own 8 px bar) and a −57.02 px strip the off arm had
    /// refused being committed four rows later; and on packs with NO d8 change
    /// at all (p3-2026-09-04T12-47-06-709Z) the fit still moved, gainStep
    /// 0.981425732 → 0.986620189 at the junction and 250 of 328 rows carrying
    /// the difference afterwards.
    ///
    /// `kNoMeasureLeft` ⇒ measure from `paintLeft`, which is byte-identical to
    /// every call site that existed before the split.  A caller that passes a
    /// value pins the window where it would have been, so the guard reads the
    /// SAME overlap of the SAME two frames in both arms and cannot change its
    /// mind because of where the paint was told to start.  Both bands are
    /// honest overlaps — the pinned one simply is not adjacent to the paint —
    /// which is why the pin is itself a knob
    /// (`Config::seedFrontierMeetPinMeasure`) rather than a silent change.
    static constexpr double kNoMeasureLeft = -1e18;
    bool commitStrip(const cv::Mat& src, const Mat33& H,
                     double paintLeft, double rightEdge, double footprintLeft,
                     bool doGain, double expGain, double expResidual,
                     double* gainStepOut,
                     int* x0Out, int* x1Out, int* clipColsOut = nullptr,
                     bool jogGuardEligible = false,
                     bool applyChainGainNoFit = false,
                     double measureLeft = kNoMeasureLeft) {
        if (clipColsOut) *clipColsOut = 0;
        lastSeamLumaDN = 0.0;
        lastSeamJogPx = 0.0;
        lastSeamJogSignedPx = 0.0;
        lastSeamJogValid = false;
        lastJogRefused = false;
        lastSeamLumaValid = false;
        lastSeamPhotoDN = 0.0;
        lastSeamPhotoUniform = -1.0;
        lastSeamPhotoSpreadDN = 0.0;
        lastSeamPhotoBands = 0;
        lastSeamPhotoValid = false;
        const int x1 = (int)std::ceil(rightEdge);
        int x0 = (int)std::floor(std::max(0.0, paintLeft));
        if (x1 <= x0) { *x0Out = *x1Out = x0; return true; }
        if (!ensureCanvasWidth(x1 + 1)) return false;

        // Gain sample reaches LEFT of the frontier into already-painted canvas
        // (the strip's own overlap is sub-pixel-thin in steady state).
        //
        // ANCHORED ON `measureFrom`, NOT ON `paintLeft` — see the header note.
        // With no override the two are the same number and every byte below is
        // what it was; `mx1` is the window's RIGHT edge and collapses onto x0.
        const double measureFrom =
            (measureLeft > kNoMeasureLeft) ? measureLeft : paintLeft;
        const int mx1 = (measureLeft > kNoMeasureLeft)
                            ? std::min(x0, (int)std::floor(
                                               std::max(0.0, measureFrom)))
                            : x0;
        int wx0 = mx1;
        if ((doGain || cfg.seamMetrics) && anyPainted) {
            const double want = std::max(footprintLeft,
                                         measureFrom - cfg.gainSampleMinPx);
            wx0 = (int)std::floor(std::max(0.0, std::min(want, measureFrom)));
        }
        const int roiW = x1 - wx0;
        if (roiW <= 0) { *x0Out = *x1Out = x0; return true; }

        const Mat33 Hroi = translate(-(double)wx0, 0.0) * H;
        cv::Mat roiBgr, roiMask;
        // ── v10: THE LENS CORRECTION RIDES THIS RESAMPLE ────────────────
        // Same geometry, same destination raster, same interpolation — the
        // only change is WHERE each destination pixel reads from, which is
        // exactly what a lens model is.  The MASK goes through the identical
        // map, so coverage bookkeeping cannot drift from the pixels it
        // describes.  Any refusal below falls back to the shipped warp; there
        // is no half-corrected state.
        // TALLIED ON COMMIT, NOT ON ATTEMPT.  `lensTally` is banked only once
        // the strip is known to contribute columns: a strip that resamples and
        // then commits nothing (its whole warp mask fell outside the claimed
        // span) belongs in neither counter, because it put no pixels in the
        // deliverable.  Counting it made the ledger read 347 corrected against
        // 345 painted, which is a ledger that cannot be checked.
        // −1 is two cases and one counter: a degenerate strip homography (or
        // intrinsics the frame did not carry), and a frame whose focal the
        // gate refuses — a lens switch.  Falling back is right; falling back
        // SILENTLY is not, so a pack can never say "corrected" about a strip
        // that was warped uncorrected.
        const int lensTally = resampleFrame(
            src, Hroi, roiW,
            (curK[0] > 1.0) ? curK[0] : refFx, (curK[1] > 1.0) ? curK[1] : refFy,
            (curK[0] > 1.0) ? curK[2] : refCx, (curK[1] > 1.0) ? curK[3] : refCy,
            lensMap, &roiBgr, &roiMask);

        // v6 — RADIOMETRIC NORMALISATION, BEFORE the overlap fit.  Order is
        // load-bearing: fitting the chained gain on already-normalised pixels
        // is what demotes it from "tracks the camera" to "corrects a
        // residual", and a residual is what gainLeak is allowed to pull to 1.
        applyExposureGain(roiBgr, expGain);

        // ── v13: THE JOG GUARD — refuse, never move ────────
        // Pre-commit: if the committed-pixel cut this strip is about to
        // paint exceeds the bar, HOLD the strip.  The measurement is read
        // from the canvas but feeds NOTHING into placement (measure, never
        // move); the only action is a bounded refusal — after d8JogMaxRun
        // consecutive refusals the commit is accepted anyway (counted as
        // forced), so a genuine divergence delays by at most that many
        // strips instead of stalling.  Runs BEFORE the gain fit, exactly as
        // the twin validated it: phase correlation is normalised by the
        // cross-power magnitude, so the pending gain scale cannot move the
        // answer (pinned by PanoJogGuard.MeasurementIsGainInvariant), and
        // refusing here means a refused strip never mutates gainCum either.
        // Eligibility comes from the CALLER: only the live strip path — the
        // bootstrap, the backfill and the tail flush are single-owner paints
        // with no neighbour to disagree with.
        if (cfg.d8JogGuard && jogGuardEligible && anyPainted && mx1 > wx0) {
            measureCanvasJog(roiBgr, roiMask, wx0, mx1);
            if (lastSeamJogValid && lastSeamJogPx > cfg.d8JogBarPx) {
                if (d8JogRun < cfg.d8JogMaxRun) {
                    ++d8JogRun;
                    ++st.d8JogRefusals;
                    lastJogRefused = true;
                    *gainStepOut = 1.0;
                    *x0Out = *x1Out = x0;
                    return true;
                }
                ++st.d8JogForced;
            }
            d8JogRun = 0;
        }

        double gainStep = 1.0;
        if (doGain && anyPainted && mx1 > wx0) {
            const int ow = mx1 - wx0;
            const cv::Rect ovRoi(wx0, 0, ow, canvasH);
            const cv::Rect ovSrc(0, 0, ow, canvasH);
            cv::Mat m;
            cv::bitwise_and(roiMask(ovSrc), coverage(ovRoi), m);
            const double canvasMean = maskedMeanLuma(canvas(ovRoi), m);
            const double srcMean = maskedMeanLuma(roiBgr(ovSrc), m);
            if (canvasMean > 1.0 && srcMean > 1.0) {
                const double target = canvasMean / srcMean;
                const double lo = gainCum * (1.0 - cfg.gainStepClamp);
                const double hi = gainCum * (1.0 + cfg.gainStepClamp);
                double g = std::max(lo, std::min(hi, target));
                // OPTIONAL LEAK toward unity (Config::gainLeak, default OFF —
                // it changes committed pixels on every pack and is pending the
                // operator's approval).  The chained estimator is BIASED, not
                // noisy: gainCum walks monotonically to 0.70-0.76 on all four
                // device packs while gainStep never touches its ±10% clamp,
                // so the cumulative clamp at 2.0 can never catch it.
                if (cfg.gainLeak > 0.0)
                    g += (1.0 - g) * std::min(1.0, cfg.gainLeak);
                g = std::max(1.0 / cfg.gainCumClamp,
                             std::min(cfg.gainCumClamp, g));
                gainStep = (gainCum > 1e-9) ? (g / gainCum) : 1.0;
                gainCum = g;
            }
        }
        if ((doGain || applyChainGainNoFit) &&
            std::fabs(gainCum - 1.0) > 1e-3) {
            cv::convertScaleAbs(roiBgr, roiBgr, gainCum, 0.0);
        }
        *gainStepOut = gainStep;

        // TRIM the committed span to the columns the frame's own warp mask
        // actually covers.  floor(paintLeft) / ceil(rightEdge) can each claim
        // one column past the footprint (the mask resamples with
        // INTER_NEAREST, so an edge column's source sample can land outside
        // the frame), and a column CLAIMED but never painted is precisely a
        // reported hole — the G1 zero-breaks gate must not be failed by an
        // off-by-one in the extent bookkeeping.  Inside a strip this is a
        // no-op: paintLeft sits far inside the footprint, so firstCov == 0.
        cv::Mat colMax;
        cv::reduce(roiMask, colMax, 0, cv::REDUCE_MAX, CV_8U);
        int firstCov = -1, lastCov = -1;
        for (int c = 0; c < colMax.cols; ++c) {
            if (colMax.at<uchar>(0, c)) { firstCov = c; break; }
        }
        for (int c = colMax.cols - 1; c >= 0; --c) {
            if (colMax.at<uchar>(0, c)) { lastCov = c; break; }
        }
        if (firstCov < 0 || lastCov < 0) { *x0Out = *x1Out = x0; return true; }
        const int xStart = std::max(x0, wx0 + firstCov);
        const int xEnd = std::min(x1, wx0 + lastCov + 1);
        if (xEnd <= xStart) { *x0Out = *x1Out = x0; return true; }
        // The commit is real from here on — bank the strip and its lens tally.
        //
        // ONE COMMIT, NOT ONE CALL.  The arc seed rasterises a SINGLE commit —
        // one ledger row, one source frame, one exposure factor — through many
        // bounded calls, because the tangent-to-arc map is not a homography and
        // a slice is how it is made into one.  Those slices are not strips: they
        // are not separately placed, registered, gained or refused.  Counting
        // them here made stripsCommitted read 179 against 105 painted frames
        // and put lensCorrectedStrips one ahead of the strips it describes,
        // which is precisely what PanoLens.TheStripCountersDescribeCommitted-
        // StripsOnly exists to catch.  The seed banks itself once, at the end
        // of the run (see commitArcSeed).
        if (!seedSlicing) {
            ++stripsCommitted;
            if (lensTally > 0) ++lensCorrectedStrips;
            else if (lensTally < 0) ++lensSkippedStrips;
        } else if (lensTally != 0) {
            // Remembered, not banked: the seed's own lens verdict is whatever
            // its slices agreed on, and a slice that fell back must not be able
            // to hide behind the ones that did not.
            seedLensTally = (lensTally < 0) ? -1
                          : (seedLensTally == 0 ? +1 : seedLensTally);
        }

        const cv::Rect dst(xStart, 0, xEnd - xStart, canvasH);
        const cv::Rect sub(xStart - wx0, 0, xEnd - xStart, canvasH);
        const cv::Mat m = roiMask(sub);

        // PERPENDICULAR CLIP DETECTION — the ground-truth half of the fix for
        // the failure where drift walks content out of the fixed band and
        // warpPerspective discards it with no return value and no outcome.
        // A committed column whose warp mask reaches row 0 or row canvasH-1
        // has content continuing past the canvas edge: it is TRUNCATED, and
        // must never be indistinguishable from a clean column.  Two row scans
        // of a strip-width ROI — negligible next to the warp itself.
        if (clipColsOut && canvasH > 0) {
            const int topHit = cv::countNonZero(m.row(0));
            const int botHit = cv::countNonZero(m.row(canvasH - 1));
            *clipColsOut = std::max(topHit, botHit);
        }

        // ── THE PHOTOMETRIC SEAM, measured on the CANVAS ────────────────
        // The gain is fitted on a sample window LEFT of the frontier and then
        // applied to content RIGHT of it, so a gain that matches its own
        // sample exactly can still commit a visible DC step.  Measure the step
        // that is actually committed: the first NEW column against the last
        // OLD one, over the rows both of them cover.
        if (cfg.seamMetrics && xStart >= 1 && anyPainted && canvasH > 0) {
            const cv::Mat oldCol = coverage.col(xStart - 1);
            const cv::Mat newCol = m.col(0);
            cv::Mat both;
            cv::bitwise_and(oldCol, newCol, both);
            if (cv::countNonZero(both) >= 16) {
                const double a = maskedMeanLuma(canvas.col(xStart - 1), both);
                const double b = maskedMeanLuma(roiBgr(sub).col(0), both);
                if (a >= 0.0 && b >= 0.0) {
                    lastSeamLumaDN = std::fabs(a - b);
                    // A step of EXACTLY zero is a measurement, not a missing
                    // one.  Excluding it (which the first cut of this metric
                    // did, by testing `> 0.0`) conditions the percentiles on a
                    // nonzero step and reads them high.
                    lastSeamLumaValid = true;
                }
            }
        }

        // ── THE COMMITTED-PIXEL CUT (v5) ───────────────────────────────
        // Everything else in the seam block scores the placement the engine
        // DECIDED.  This scores the pixels it PAINTED.  The incoming warp
        // already covers `[wx0, x0)` — a slab of canvas the high-water clip is
        // about to throw away — so the same world content exists twice, once
        // as already-committed canvas and once as this frame's warp, in the
        // SAME canvas columns.  Correlating them measures the cross-sweep
        // misregistration between the two frames in canvas px, taken from the
        // matrix that did the painting.  It therefore survives three things
        // the band metric cannot:
        //   · a placement error introduced anywhere after the fit,
        //   · every K window locking onto the same aliased peak (this is real
        //     overlapping content, not two neighbouring world columns),
        //   · the fit being scored against its own residual.
        // Restricted to rows the two FULLY share, so nothing is masked and no
        // mask edge can correlate at zero and bias the answer toward clean.
        measureCanvasJog(roiBgr, roiMask, wx0, mx1);
        // ── THE PHOTOMETRIC SEAM (v6) ──────────────────────────────────
        // Same slab, same construction, different question: the jog asks WHERE
        // the two owners disagree, this asks HOW BRIGHT.  Both must be
        // measured on `roiBgr` AFTER every photometric correction, because
        // what the operator sees is what is committed.
        measureSeamPhotometry(roiBgr, roiMask, wx0, mx1);

        roiBgr(sub).copyTo(canvas(dst), m);
        coverage(dst).setTo(cv::Scalar(255), m);
        // THE PAINTED ROW UNION (see minPaintedV).  A column-wise max reduces
        // the strip mask — a few px wide — to one column, and the scan is then
        // over `dst.height` bytes: microseconds, and the only way to know which
        // rows a rectified frame actually reached without re-scanning the whole
        // canvas on the live preview path.
        //
        // `cv::reduce` deliberately, NOT `cv::boundingRect`: reduce is core and
        // present on both the host OpenCV 5 the tests link and the vendored
        // 4.10 the device ships, while boundingRect is not in cv:: on the
        // former (it fails the host build, which is how this was caught).
        if (m.rows > 0 && m.cols > 0) {
            cv::Mat rowsAny;
            cv::reduce(m, rowsAny, 1, cv::REDUCE_MAX, CV_8U);
            int first = -1, last = -1;
            for (int y = 0; y < rowsAny.rows; ++y) {
                if (rowsAny.at<uchar>(y, 0)) { if (first < 0) first = y; last = y; }
            }
            if (first >= 0) {
                const int v0 = dst.y + first;
                const int v1 = dst.y + last + 1;
                if (!anyPaintedV) { minPaintedV = v0; maxPaintedV = v1; anyPaintedV = true; }
                else {
                    minPaintedV = std::min(minPaintedV, v0);
                    maxPaintedV = std::max(maxPaintedV, v1);
                }
            }
        }
        // THE EFFECTIVE SCENE→CANVAS TRANSFER, per committed column.
        //
        // NOT the applied gain: under a working normalisation the applied gain
        // legitimately ramps by the camera's own 1.5-1.8×, and calling that a
        // band would fail exactly the sweeps the fix repaired.  What the eye
        // integrates is camera × applied, and the camera part is
        // `expResidual` — 1.0 when the normalisation was exact, 1.0
        // (unobservable) with no metadata, and the honest residue when the
        // exposure gain was clamped.
        // `doGain || applyChainGainNoFit`, not `doGain`: the field records the
        // scene→canvas transfer of the pixels that were actually WRITTEN, so
        // it has to follow the gain that was actually APPLIED.  Reading
        // `doGain` alone would log an Option C repaint as if it carried no
        // chained gain and put a false step into the band metric.
        recordColumnScale(xStart, xEnd,
                          expResidual *
                              ((doGain || applyChainGainNoFit) ? gainCum : 1.0));

        // ── THE WARPING NUMBER, over what was actually COMMITTED ────────
        // Every commit path runs this — including the bootstrap lead-in and
        // the finalize tail flush, which paint a WHOLE footprint and are
        // therefore where the worst magnification actually lives (measured:
        // the tail-flush strip is the 13.0× floor trapezoid on pack
        // 15-59-29, not any of the ~6 px steady-state strips).
        if (cfg.seamMetrics) {
            const double fx = (curK[0] > 1.0) ? curK[0] : refFx;
            const double fy = (curK[1] > 1.0) ? curK[1] : refFy;
            const double cx = (curK[0] > 1.0) ? curK[2] : refCx;
            const double cy = (curK[1] > 1.0) ? curK[3] : refCy;
            Mat33 Hinv;
            bool okInv = true;
            try { Hinv = H.inv(); } catch (const cv::Exception&) { okInv = false; }
            if (okInv && std::isfinite(Hinv(0, 0))) {
                const double us[6] = {(double)xStart, (double)xEnd, (double)xStart,
                                      (double)xEnd, 0.5 * (xStart + xEnd),
                                      0.5 * (xStart + xEnd)};
                const double vs[6] = {0.0, 0.0, (double)canvasH, (double)canvasH,
                                      0.0, (double)canvasH};
                for (int i = 0; i < 6; ++i) {
                    double sx = 0, sy = 0;
                    if (!mapPoint(Hinv, us[i], vs[i], &sx, &sy)) continue;
                    sx = std::max(0.0, std::min((double)imgW - 2.0, sx));
                    sy = std::max(0.0, std::min((double)imgH - 2.0, sy));
                    const double mag = areaMagnification(H, sx, sy, cfg.canvasScale,
                                                         fx, fy, cx, cy,
                                                         refFx, refFy);
                    if (std::isfinite(mag)) {
                        maxAreaScalePainted = std::max(maxAreaScalePainted, mag);
                        lastAreaScale = std::max(lastAreaScale, mag);
                    }
                }
            }
        }

        if (!anyPainted) {
            minPaintedU = xStart; maxPaintedU = xEnd; anyPainted = true;
        } else {
            minPaintedU = std::min(minPaintedU, xStart);
            maxPaintedU = std::max(maxPaintedU, xEnd);
        }
        *x0Out = xStart; *x1Out = xEnd;
        return true;
    }

    /// Smallest common vertical band cropVertical will honour: a quarter of
    /// ONE FRAME'S FOOTPRINT across the sweep.  Anything narrower means the
    /// ragged edge dominates and the crop must decline (see paintedBand).
    ///
    /// Measured against the FOOTPRINT, never against canvasH: canvasH carries
    /// 2×canvasPadPx of pure pad plus every vertical growth the sweep caused,
    /// so a canvasH-relative bar tightens as the panorama gets longer — the
    /// crop would decline hardest on exactly the sweeps whose ragged edge is
    /// worst.  The footprint is a property of the camera, not of the sweep.
    int minCropBandPx() const {
        const double f = (footprintV > 1.0) ? footprintV : (double)canvasH;
        return (int)(f * 0.25);
    }

    /// The painted band as a ROI into the canvas — a VIEW, never a copy.
    /// `cropVertical` additionally narrows it to the row band every painted
    /// column shares (the ragged attitude-rectified edge).
    bool paintedBand(cv::Rect& roi, bool cropVertical) const {
        if (!anyPainted || canvas.empty()) return false;
        const int u0 = std::max(0, std::min(minPaintedU, canvasW));
        const int u1 = std::max(u0, std::min(maxPaintedU, canvasW));
        if (u1 <= u0) return false;
        int v0 = 0, v1 = canvasH;
        if (cropVertical) {
            int top = 0, bot = canvasH;
            bool any = false;
            for (int x = u0; x < u1; ++x) {
                int t = -1, b = -1;
                for (int y = 0; y < canvasH; ++y) {
                    if (coverage.at<uchar>(y, x)) { t = y; break; }
                }
                if (t < 0) continue;   // unpainted column — excluded from the band
                for (int y = canvasH - 1; y >= 0; --y) {
                    if (coverage.at<uchar>(y, x)) { b = y + 1; break; }
                }
                if (!any) { top = t; bot = b; any = true; }
                else { top = std::max(top, t); bot = std::min(bot, b); }
            }
            // DECLINE rather than cut: under a real attitude excursion the
            // per-column extremes can cross (one column's first painted row
            // sits below another's last), and honouring that "band" would
            // discard real content.  Keeping the full height instead leaves
            // the ragged edge visible, which is the reportable outcome.
            //
            // The bar is PROPORTIONAL, not a fixed 8 px.  cropVertical exists
            // to trim a ragged EDGE; a "common band" that is a small fraction
            // of ONE FRAME means the ragged part is most of the panorama, and
            // cropping to it would output a sliver while reporting success.
            // (Measured: an oscillating ±6° roll can leave an 11-row common
            // band on a 796-row canvas — which the old >= 8 rule accepted.)
            const int minBand = std::max(8, minCropBandPx());
            if (any && bot - top >= minBand) { v0 = top; v1 = bot; }
        }
        roi = cv::Rect(u0, v0, u1 - u0, v1 - v0);
        return true;
    }

    /// Undo the axis/sign remap ONCE.  A is orthogonal, so this is an exact
    /// flip / transpose — never a resampling.
    ///
    /// Lands in the CAMERA RASTER frame, which is where the intrinsics live
    /// and is therefore the only frame this function may produce.  The turn
    /// from there to world-upright is a separate, later step — see
    /// `bakeUpright` and `Config::outputRotationCwDeg` — because the LIVE
    /// PREVIEW wants this frame (the SDK turns it on screen) and only the
    /// DELIVERABLE wants the upright one.
    void orient(const cv::Mat& band, cv::Mat& out) const {
        if (axis == 0) {
            if (sweepSign >= 0) band.copyTo(out);
            else cv::flip(band, out, 1);
        } else {
            cv::Mat tr;
            cv::transpose(band, tr);
            if (sweepSign >= 0) out = tr;
            else cv::flip(tr, out, 0);
        }
    }

    /// THE UPRIGHT BAKE — camera raster frame → world-upright, in place.
    ///
    /// Quarter turns only (`configure()` refuses the rest), so like `orient`
    /// this is a transpose/flip pair and NOT a resampling: no interpolation,
    /// no sharpness cost, and a 0° bake is a no-op that touches nothing.
    /// `cv::rotate` is deliberately not used — it is the same two primitives
    /// with an enum in front, and spelling them out keeps the 90/270 transpose
    /// visible next to `orient`'s, which is the thing a reader is checking.
    void bakeUpright(cv::Mat& img) const {
        const int cw = cfg.outputRotationCwDeg;
        if (cw == 0 || img.empty()) return;
        cv::Mat tmp;
        if (cw == 180) {
            cv::flip(img, tmp, -1);          // both axes
        } else {
            cv::transpose(img, tmp);
            // After a transpose, CW needs a horizontal flip and CCW (270 CW)
            // a vertical one.  Getting this pair backwards mirrors the
            // panorama, which reads as "the shelf order reversed" rather than
            // as a rotation bug — so the two cases are spelled apart.
            cv::flip(tmp, tmp, (cw == 90) ? 1 : 0);
        }
        img = tmp;
    }

    /// `src` selects WHICH canvas-frame raster is rendered — the pixels
    /// (`canvas`, the default) or the coverage mask (`coverage`).
    ///
    /// ⚠ ONE GEOMETRY PATH, DELIBERATELY. The mask's only job is to say which
    /// pixels of `canvas.jpg` were painted, which makes a mask that is
    /// cropped, oriented or baked even slightly differently WORSE THAN NO
    /// MASK: `computeInscribedRect` would then cut the deliverable along a
    /// boundary that belongs to a different image, and it would look like a
    /// plausible crop rather than like a bug. A second function that "does
    /// the same thing" is exactly how the two would drift, so there is one
    /// function and the only thing that varies is the source raster.
    bool renderOriented(cv::Mat& out, bool cropVertical,
                        bool cropPadRows = false,
                        int* cropCrossLoPx = nullptr,
                        int* cropCrossHiPx = nullptr,
                        const cv::Mat* src = nullptr) const {
        if (cropCrossLoPx) *cropCrossLoPx = 0;
        if (cropCrossHiPx) *cropCrossHiPx = 0;
        cv::Rect roi;
        if (!paintedBand(roi, cropVertical)) return false;
        // v12 — the SAME row-union pad trim the preview path applies (see
        // previewIntoWindowed), so the deliverable and the last preview agree
        // on aspect.  Union, never intersection: no committed pixel can be
        // lost, and a degenerate band declines the trim rather than emitting
        // a sliver.  The APPLIED trim is reported (review fix): cross-axis
        // coordinates in the ledger/meta are canvas-frame, and a reader of
        // canvas.jpg needs the offset to reconcile them.
        if (cropPadRows && anyPaintedV) {
            const int y1 = roi.y + roi.height;
            const int v0 = std::max(roi.y, std::min(minPaintedV, y1));
            const int v1 = std::max(v0, std::min(maxPaintedV, y1));
            if (v1 - v0 >= 8) {
                if (cropCrossLoPx) *cropCrossLoPx = v0 - roi.y;
                if (cropCrossHiPx) *cropCrossHiPx = y1 - v1;
                roi.y = v0; roi.height = v1 - v0;
            }
        }
        const cv::Mat& source = (src != nullptr) ? *src : canvas;
        // A source that is not the canvas's twin cannot be cropped by the
        // canvas's roi. Declining is the only safe answer: every consumer of
        // the mask re-checks its dimensions and falls back, so an ABSENT
        // sidecar degrades to the brightness proxy, while a MISALIGNED one
        // would be trusted.
        if (source.empty() || source.size() != canvas.size()) return false;
        orient(source(roi), out);
        // v14 — THE ONE PLACE THE DELIVERABLE LEAVES THE RASTER FRAME.  After
        // the crop and after `orient`, so `cropCrossLo/HiPx` above stay in the
        // canvas frame they are documented in and a pack reader can still
        // reconcile the ledger against `canvas.jpg` via
        // `SessionStats::outputRotationCwDeg`.
        bakeUpright(out);
        return !out.empty();
    }

    // ── THE ARC SEED ────────────────────────────────────────────────────────
    // The along-sweep source coordinate of the ray at sweep angle `phi`: where
    // a PINHOLE puts it in the reference raster, which is the tangent.  The arc
    // only ever appears on the canvas side.
    double seedSrcAt(double phi) const {
        const double f = (axis == 0) ? refFx : refFy;
        const double c = (axis == 0) ? refCx : refCy;
        return c + f * std::tan(phi);
    }

    /// `H` for the seed slice centred on sweep angle `phi`.
    ///
    /// THE LAW THIS IMPLEMENTS is `projection == 1`'s, quoted from its own
    /// definition: "the along-sweep component is carried as ARC LENGTH
    /// (cylindrical, uniform scale in the sweep angle) and everything else
    /// stays on the tangent plane (rectilinear across the sweep, so lines
    /// running ACROSS the sweep stay exactly straight)."  Both halves matter:
    ///
    ///   ALONG the sweep, the reference raster's ray at angle phi sits at the
    ///   tangent c + f·tan(phi) and belongs at the arc c + f·phi.  A slice is
    ///   the first-order map between them about its own centre, so its local
    ///   scale is cos²(phi) — which is exactly the factor that makes one
    ///   frame's stretched outer field render at the same canvas scale a frame
    ///   actually POINTED there would have rendered it at.
    ///
    ///   ACROSS the sweep, NOTHING.  An earlier cut of this built each slice as
    ///   a full rotation homography, K·R_sweep(phi)ᵀ·K⁻¹ — the frame a camera
    ///   turned to phi would have produced.  That is a truer camera model and
    ///   it is the WRONG law here: it carries a cos(phi) cross compression, so
    ///   the seed's outer columns covered only 73 % of the cross extent, and
    ///   `cropVertical` (which intersects per-column extents) then cut the
    ///   whole deliverable from 540 rows to 480.  PanoFinalize.CropVertical-
    ///   NarrowsToTheCommonBand and .TheCropBarDoesNotTightenAsThePanoramaGrows
    ///   both caught it.  The projection says lines across the sweep stay
    ///   straight; a cross-axis term of any kind contradicts that.
    ///
    /// At phi == 0 the map is the identity and this is
    /// `translate(originU, originV) * A * scaleM(scale)` — i.e. `Href` exactly,
    /// to the last bit — which is what keeps the frame centre, `highWater` and
    /// therefore the frontier exactly where they already were.
    Mat33 arcSeedH(double phi) const {
        const double f = (axis == 0) ? refFx : refFy;
        const double c = (axis == 0) ? refCx : refCy;
        const double k = std::cos(phi) * std::cos(phi);   // d(arc)/d(tangent)
        const double b = c + f * phi - seedSrcAt(phi) * k;
        const Mat33 M = (axis == 0) ? Mat33(k, 0, b, 0, 1, 0, 0, 0, 1)
                                    : Mat33(1, 0, 0, 0, k, b, 0, 0, 1);
        return translate(originU, originV) * A * scaleM(cfg.canvasScale) * M;
    }

    /// Canvas u of the ray at sweep angle `phiRay`, mapped through `H`.
    bool arcSeedU(const Mat33& H, double phiRay, double* u) const {
        const double s = seedSrcAt(phiRay);
        double uu = 0, vv = 0;
        const bool ok = (axis == 0) ? mapPoint(H, s, refCy, &uu, &vv)
                                    : mapPoint(H, refCx, s, &uu, &vv);
        *u = uu;
        return ok;
    }

    /// Owns `seedSlicing` for the length of ONE slice run.
    ///
    /// WHY AN OWNER RATHER THAN A PAIR OF ASSIGNMENTS.  A slice run calls
    /// `commitStrip`, which warps and allocates, so it can leave by an
    /// exception as well as by its returns — and `ingest()`'s catch keeps the
    /// SESSION alive afterwards.  A `seedSlicing` left true there would stop
    /// `commitStrip` banking strips for the REST of the sweep and fold every
    /// later lens verdict into `seedLensTally`, which is exactly the ledger
    /// corruption PanoLens.TheStripCountersDescribeCommittedStripsOnly exists
    /// to catch.  Two call sites share the flag deliberately; sharing it
    /// doubles the number of exits that have to remember, so the flag is given
    /// an owner instead of a third assignment.
    struct SliceRun {
        Impl& s;
        explicit SliceRun(Impl& impl) : s(impl) {
            s.seedSlicing = true;
            s.seedLensTally = 0;
        }
        ~SliceRun() { s.seedSlicing = false; }
        SliceRun(const SliceRun&) = delete;
        SliceRun& operator=(const SliceRun&) = delete;
    };

    /// Commit the bootstrap frame as a run of arc-placed slices.
    ///
    /// Returns false when the seed must fall back to the single block — no
    /// intrinsics, a degenerate field, or a mapping that declined; `*fatal` is
    /// set ONLY for an unrecoverable canvas failure, exactly as the block path
    /// reports one.  A false return with `*fatal == nullptr` is a request to
    /// paint the legacy block, so the seed can never end up painting NOTHING:
    /// `finalCanvas` refuses on `!anyPainted`, and a seed that silently
    /// declined would turn a good sweep into no deliverable at all.
    bool commitArcSeed(int* px0Out, int* px1Out, int* clipColsOut,
                       const char** fatal) {
        *fatal = nullptr;
        const double f = (axis == 0) ? refFx : refFy;
        const double c = (axis == 0) ? refCx : refCy;
        const double D = (axis == 0) ? (double)imgW : (double)imgH;
        if (!(f > 1.0) || !(D > 1.0) || !(cfg.canvasScale > 0.0)) return false;

        // The field the REFERENCE RASTER actually spans, from its own principal
        // point — not a symmetric ±atan(D/2f), because cx/cy are not the centre
        // and a symmetric assumption would paint one edge from outside the
        // image and clip the other.
        const double phiLo = std::atan((0.0 - c) / f);
        const double phiHi = std::atan((D - c) / f);
        if (!(phiHi > phiLo) || !std::isfinite(phiLo) || !std::isfinite(phiHi))
            return false;

        // Slice width is specified in CANVAS px and converted here, so the
        // residual it controls (f·(tan δ − δ) in the half-slice) is bounded in
        // the units the operator reads, on every lens.
        const double dPhi = cfg.seedArcSlicePx / (cfg.canvasScale * f);
        if (!(dPhi > 0.0)) return false;
        long n = (long)std::ceil((phiHi - phiLo) / dPhi);
        if (n < 1) n = 1;
        if (n > 4096) return false;   // a field this wide is not a camera

        // WHICH END OF THE FIELD IS THE CANVAS'S LOW-u END.  `sweepSign` is
        // folded into `A`, so a −1 sweep runs phi the other way round the
        // canvas.  Asked of the mapping rather than assumed: getting it
        // backwards would paint the slices in descending u, and each one's
        // `paintLeft` would then sit to the RIGHT of its own span and commit
        // nothing.
        double uAtLo = 0.0, uAtHi = 0.0;
        if (!arcSeedU(arcSeedH(phiLo), phiLo, &uAtLo) ||
            !arcSeedU(arcSeedH(phiHi), phiHi, &uAtHi))
            return false;
        const bool ascending = (uAtLo <= uAtHi);

        int unionX0 = 0, unionX1 = 0, clipTotal = 0;
        bool any = false;
        double runLeft = 0.0;
        // The slices are ONE commit; commitStrip must not bank them as strips.
        SliceRun sliceRun(*this);
        for (long k = 0; k < n; ++k) {
            // Walked in CANVAS order, so `runLeft` is monotone.
            const long idx = ascending ? k : (n - 1 - k);
            const double a = phiLo + dPhi * (double)idx;
            const double b = std::min(phiHi, a + dPhi);
            if (!(b > a)) continue;
            const double mid = 0.5 * (a + b);
            const Mat33 Hk = arcSeedH(mid);
            double ua = 0.0, ub = 0.0;
            if (!arcSeedU(Hk, a, &ua) || !arcSeedU(Hk, b, &ub)) continue;
            const double lo = std::min(ua, ub), hi = std::max(ua, ub);
            if (!std::isfinite(lo) || !std::isfinite(hi)) continue;
            // First slice starts at its own edge; every later one starts where
            // the previous COMMITTED, which is what makes the run gap-free
            // without relying on consecutive slices agreeing to the pixel.
            const double left = any ? std::max(runLeft, lo) : lo;
            int x0 = 0, x1 = 0, clip = 0;
            double gs = 1.0;
            // Same call the single block makes: the reference frame is the
            // exposure datum (factor 1.0 by definition), no gain chain, and
            // NOT jog-guard eligible — a guard that refused a seed slice would
            // leave a hole no later frame paints.
            if (!commitStrip(refBgr, Hk, left, hi, lo, false, 1.0, 1.0, &gs,
                             &x0, &x1, &clip)) {
                *fatal = "canvas-full";
                return false;
            }
            clipTotal += clip;
            if (x1 > x0) {
                if (!any) { unionX0 = x0; unionX1 = x1; any = true; }
                else { unionX0 = std::min(unionX0, x0); unionX1 = std::max(unionX1, x1); }
                runLeft = (double)x1;
            }
        }
        if (!any) return false;      // committed nothing — fall back to the block
        // ONE strip, banked once, exactly as the single-block seed banks itself.
        ++stripsCommitted;
        if (seedLensTally > 0) ++lensCorrectedStrips;
        else if (seedLensTally < 0) ++lensSkippedStrips;
        *px0Out = unionX0;
        *px1Out = unionX1;
        *clipColsOut = clipTotal;
        return true;
    }

    // ── THE ARC TAIL ────────────────────────────────────────────────────────
    //
    // The seed's fork, at the far end of the sweep, where it is visible.  The
    // reasoning is in Config::tailArcSlicePx and is not repeated; what follows
    // is only what the code does and the three things a reader would otherwise
    // have to take on trust.
    //
    // The map, in canvas px along the sweep, about the tail frame's own optical
    // centre u_c:  g(u) = u_c + F·atan((u − u_c)/F),  F = canvasScale·f_ref.
    // Each slice is g linearised about its own midpoint — the same construction
    // `arcSeedH` uses, written in canvas coordinates instead of the reference
    // raster's because that is the only frame in which the tail frame's own
    // `H_rect` is already accounted for.

    /// One slice of the tail flush: g linearised about the slice, pre-multiplied
    /// onto `lastHint`, plus the canvas span that slice owns.
    struct TailSlice { Mat33 H; double u0, u1; };

    /// Canvas px per radian of sweep — the projection's own angular scale, the
    /// same `arcSeedH` builds its law from.
    double tailArcF() const {
        return ((axis == 0) ? refFx : refFy) * cfg.canvasScale;
    }

    /// How much of this sweep's canvas growth the ARC TERM contributed: the
    /// canvas px `translate(f·ψ)` put in, over the px the sweep actually grew.
    ///
    /// This is the quantity that decides whether the canvas is an ARC canvas at
    /// all — see Config::tailArcMinRotFrac for why the seed's attitude-based
    /// gate is not a substitute, and for what this bar does and does not
    /// settle.  Returns 0 when the sweep grew by nothing, which correctly
    /// refuses the arc tail on a sweep that never went anywhere.
    double tailArcRotationFraction() const {
        const double travel = std::fabs(lastPaintedU - latchCentreU);
        if (!(travel > 0.0)) return 0.0;
        const double dPsi = (maxPsiDeg - minPsiDeg) * CV_PI / 180.0;
        if (!(dPsi > 0.0)) return 0.0;
        return (tailArcF() * dPsi) / travel;
    }

    /// The slices the tail flush commits, in CANVAS order.
    ///
    /// SHARED BY THE COMMIT AND BY THE PREVIEW'S LEAD-OUT, deliberately.  The
    /// lead-out warps this same frame over this same span and the operator
    /// asked for "the exact image you are going to get as the result"; two
    /// call sites building the law separately is exactly how that promise
    /// breaks silently, so there is one builder and both read it.
    ///
    /// The centre is taken from `lastHint` and `lastK` — the matrix and the
    /// intrinsics that will do the painting — rather than rebuilt from originU
    /// / A / pnat: those move after the last PAINTED frame (a rejected frame
    /// still advances `posNat`, and `ensureCanvasBand` re-bases `lastHint` and
    /// not them), so a centre recomputed from engine state at `finish()` time
    /// would sit on a different origin than the paint and the whole block's
    /// correction would be referred to the wrong point.  Same rule for the
    /// Option C caller below: it passes the frame it is about to warp.
    bool tailArcSlices(double uFrom, double uTo,
                       std::vector<TailSlice>* out) const {
        return arcSlicesAbout(lastHint, lastK[2], lastK[3], uFrom, uTo,
                              cfg.tailArcSlicePx, /*spanIsCanvas=*/false, out);
    }

    /// The same law, about an ARBITRARY frame's homography and principal point.
    ///
    /// WHY IT IS PARAMETERISED.  `tailArcSlices` above asks it about the LAST
    /// painted frame because that is the frame the tail flushes; Option C's
    /// lead-in fill asks it about the frame that is painting NOW.  Both are
    /// "place a wide block, from one frame, under `projection == 1`", and a
    /// wide block is exactly where the tangent map and the arc map diverge —
    /// at F ≈ 443 canvas px/rad and a half-footprint span of 360 px the two
    /// disagree by ~57 px at the far edge, which is a misregistration nobody
    /// would accept from a strip.  ONE builder, two callers, for the same
    /// reason the lead-out shares it: two call sites deriving the law
    /// separately is how the seed and the strips forked in the first place.
    /// `spanIsCanvas` — WHICH SPACE `[uFrom, uTo]` IS IN, and it is not a
    /// convenience.  The two callers want opposite things:
    ///
    ///   * the TAIL and the LEAD-OUT hand over a TANGENT span — "the columns
    ///     `lastHint` would paint" — and ask where the arc law puts that
    ///     content.  The run they get back is SHORTER than what they asked for,
    ///     and that compression IS the correction.  `spanIsCanvas = false`.
    ///   * the Option C FILL hands over a CANVAS span — "cover exactly these
    ///     columns, which the arc-placed seed already painted" — and asks which
    ///     rays belong there.  Passing that through the forward map covers only
    ///     `g([uFrom, uTo])`, leaving the far end of the band unfilled for the
    ///     next frame to retry; measured, that turned a single-owner fill into
    ///     a 31-owner one and doubled the owner-boundary density it exists to
    ///     keep down.  So the endpoints are inverted through `g` first.
    ///     `spanIsCanvas = true`.
    bool arcSlicesAbout(const Mat33& H, double kcx, double kcy,
                        double uFrom, double uTo, double slicePx,
                        bool spanIsCanvas,
                        std::vector<TailSlice>* out) const {
        out->clear();
        const double F = tailArcF();
        if (!(F > 1.0) || !(slicePx > 0.0)) return false;
        if (!(uTo > uFrom)) return false;
        if (!(kcx > 0.0) || !(kcy > 0.0)) return false;
        double uc = 0.0, vcDummy = 0.0;
        if (!mapPoint(H, kcx, kcy, &uc, &vcDummy)) return false;
        if (!std::isfinite(uc)) return false;
        if (spanIsCanvas) {
            // g⁻¹: canvas (arc) → tangent.  Same 90°-off-axis bound the walk
            // below takes, for the same reason — tan() at the pole is not a
            // placement, it is a NaN.
            const double a = (uFrom - uc) / F, b = (uTo - uc) / F;
            if (std::fabs(a) >= 1.5 || std::fabs(b) >= 1.5) return false;
            uFrom = uc + F * std::tan(a);
            uTo = uc + F * std::tan(b);
            if (!std::isfinite(uFrom) || !std::isfinite(uTo) ||
                !(uTo > uFrom))
                return false;
        }

        const double g0 = (uFrom - uc) / F, g1 = (uTo - uc) / F;
        const double v0 = uc + F * std::atan(g0);
        const double v1 = uc + F * std::atan(g1);
        if (!std::isfinite(v0) || !std::isfinite(v1) || !(v1 > v0)) return false;
        long n = (long)std::ceil((v1 - v0) / slicePx);
        if (n < 1) n = 1;
        if (n > 4096) return false;   // a tail this wide is not one frame's

        out->reserve((size_t)n);
        for (long k = 0; k < n; ++k) {
            // Walked in ARC space, so the slices are uniform in the OUTPUT —
            // the seed's `dPhi` walk in the units this engine's operator reads.
            const double va = v0 + slicePx * (double)k;
            const double vb = std::min(v1, va + slicePx);
            if (!(vb > va)) continue;
            const double ta = (va - uc) / F, tb = (vb - uc) / F;
            // A ray at or past 90° off the frame's axis has no place on this
            // canvas and would ask tan() for infinity.  A real footprint stops
            // at the frame edge — 43.2° on the widest lens in these packs — so
            // this bound is never approached; it exists so a corrupt `lastFu1`
            // declines the arc tail instead of producing a NaN homography.
            if (std::fabs(ta) >= 1.5 || std::fabs(tb) >= 1.5) return false;
            const double ua = uc + F * std::tan(ta);
            const double ub = uc + F * std::tan(tb);
            if (!std::isfinite(ua) || !std::isfinite(ub) || !(ub > ua))
                return false;
            const double mid = 0.5 * (ua + ub);
            const double d = (mid - uc) / F;
            const double kk = 1.0 / (1.0 + d * d);   // cos²(φ_mid) = g'(mid)
            const double b = (uc + F * std::atan(d)) - kk * mid;
            // Along the sweep only.  ACROSS it, NOTHING — `projection == 1`
            // says lines running across the sweep stay straight, and the cross
            // term an earlier cut of the SEED carried cost that change 60 rows
            // of deliverable (see arcSeedH's own note).
            const Mat33 M(kk, 0.0, b, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
            TailSlice s;
            s.H = M * H;
            // The span is taken THROUGH the slice's own map, not from `va/vb`,
            // so the committed columns are exactly the ones this slice's
            // homography lands on — the same reason `commitArcSeed` asks
            // `arcSeedU` rather than trusting its own walk.
            s.u0 = kk * ua + b;
            s.u1 = kk * ub + b;
            out->push_back(s);
        }
        return !out->empty();
    }

    /// Commit the tail flush as a run of arc-placed slices.
    ///
    /// Returns false when the tail must fall back to the single block — no
    /// intrinsics, a degenerate span, or a mapping that declined; `*fatal` is
    /// set ONLY for an unrecoverable canvas failure, exactly as `commitArcSeed`
    /// reports one.  A false return with `*fatal == nullptr` is a request to
    /// paint the legacy block, and that fallback is not optional: this block is
    /// the last content the sweep saw, and a tail that painted NOTHING would
    /// delete real scene rather than merely re-place it.
    bool commitArcTail(double uFrom, double uTo, bool doGain, double expGain,
                       double expResidual, double* gainStepOut, int* px0Out,
                       int* px1Out, int* clipColsOut, const char** fatal,
                       const CrossTraj* traj = nullptr) {
        *fatal = nullptr;
        std::vector<TailSlice> slices;
        if (!tailArcSlices(uFrom, uTo, &slices)) return false;
        // TRAJECTORY CONTINUATION rides each slice's own map, about the join
        // `uFrom` (the frontier) and evaluated at the slice's canvas midpoint
        // for the along compensation.  The slice SPANS are untouched — the map
        // is the identity in u to second order — so the run-left walk, the
        // seam capture and the union below are exactly what they were.
        if (traj != nullptr && traj->valid) {
            for (size_t i = 0; i < slices.size(); ++i) {
                slices[i].H = trajMap(*traj, uFrom,
                                      0.5 * (slices[i].u0 + slices[i].u1)) *
                              slices[i].H;
            }
        }

        int unionX0 = 0, unionX1 = 0, clipTotal = 0;
        bool any = false;
        double runLeft = 0.0;
        // THE SEAM THE PACK IS GATED ON IS THE BLOCK'S OWN, NOT A SLICE'S.
        // `commitStrip` overwrites `lastSeam*` on every call, so after a run of
        // slices those members describe the LAST slice's boundary — an interior
        // join between two slices of one frame at one exposure, which is ~0 by
        // construction.  Banking that into the percentiles would retire the
        // tail boundary from the integrity verdict while appearing to improve
        // it, so the FIRST committing slice's values (the real boundary against
        // the strip run) are captured and restored before returning.
        double seamLuma = 0.0, seamJog = 0.0, seamJogSigned = 0.0;
        double seamPhoto = 0.0, seamPhotoUni = -1.0, seamPhotoSpread = 0.0;
        double seamPhotoBase = 0.0;
        int seamPhotoBands = 0, seamSlabW = 0;
        bool seamLumaValid = false, seamJogValid = false, seamPhotoValid = false;
        double gainStepFirst = 1.0;

        // The slices are ONE commit; `commitStrip` must not bank them as strips.
        // The flag is the arc seed's — one name for one property, because a
        // second bool with the same job is how two paths drift apart — and it
        // is taken through `SliceRun`, which is what makes that sharing safe.
        SliceRun sliceRun(*this);
        for (size_t i = 0; i < slices.size(); ++i) {
            const TailSlice& s = slices[i];
            // First slice starts at its own edge; every later one starts where
            // the previous COMMITTED, so the run is gap-free without relying on
            // consecutive slices agreeing to the pixel (commitArcSeed's rule).
            const double left = any ? std::max(runLeft, s.u0) : s.u0;
            int x0 = 0, x1 = 0, clip = 0;
            double gs = 1.0;
            // `footprintLeft == left` on EVERY slice, which is what the single
            // block already passed (`highWater` for both arguments at the call
            // site below).  It makes `wx0 == x0` in `commitStrip`, so the gain
            // is APPLIED but never re-fitted — the tail flush has never fitted
            // it, and a per-slice re-fit would chain `gainCum` dozens of times
            // inside what is supposed to be one commit.
            if (!commitStrip(lastBgr, s.H, left, s.u1, left, doGain, expGain,
                             expResidual, &gs, &x0, &x1, &clip)) {
                *fatal = "canvas-full";
                return false;
            }
            clipTotal += clip;
            if (x1 > x0) {
                if (!any) {
                    unionX0 = x0; unionX1 = x1; any = true;
                    gainStepFirst = gs;
                    seamLuma = lastSeamLumaDN; seamLumaValid = lastSeamLumaValid;
                    seamJog = lastSeamJogPx; seamJogSigned = lastSeamJogSignedPx;
                    seamJogValid = lastSeamJogValid;
                    seamPhoto = lastSeamPhotoDN; seamPhotoUni = lastSeamPhotoUniform;
                    seamPhotoSpread = lastSeamPhotoSpreadDN;
                    seamPhotoBands = lastSeamPhotoBands;
                    seamPhotoValid = lastSeamPhotoValid;
                    seamPhotoBase = lastSeamPhotoBaseDN;
                    seamSlabW = lastSeamSlabW;
                } else {
                    unionX0 = std::min(unionX0, x0);
                    unionX1 = std::max(unionX1, x1);
                }
                runLeft = (double)x1;
            }
        }
        if (!any) return false;      // committed nothing — fall back to the block
        // ONE strip, banked once, exactly as the single-block tail banked itself.
        ++stripsCommitted;
        if (seedLensTally > 0) ++lensCorrectedStrips;
        else if (seedLensTally < 0) ++lensSkippedStrips;
        lastSeamLumaDN = seamLuma; lastSeamLumaValid = seamLumaValid;
        lastSeamJogPx = seamJog; lastSeamJogSignedPx = seamJogSigned;
        lastSeamJogValid = seamJogValid;
        lastSeamPhotoDN = seamPhoto; lastSeamPhotoUniform = seamPhotoUni;
        lastSeamPhotoSpreadDN = seamPhotoSpread;
        lastSeamPhotoBands = seamPhotoBands;
        lastSeamPhotoValid = seamPhotoValid;
        lastSeamPhotoBaseDN = seamPhotoBase;
        lastSeamSlabW = seamSlabW;
        *gainStepOut = gainStepFirst;
        *px0Out = unionX0;
        *px1Out = unionX1;
        *clipColsOut = clipTotal;
        return true;
    }

    // ── TRAJECTORY CONTINUATION ─────────────────────────────────────────────
    //
    // ONE routine, three callers: the tail flush, the preview's lead-out and
    // the seed's re-placement.  The reasoning is in Config::crossTraj and is
    // not repeated; what follows is what the code does.
    //
    // The map a block is placed through, in CANVAS coordinates, about the join
    // u_j.  With slope c and fan a about cross row v̄ it realises
    //
    //     v' = v̄ + (v − v̄) / (1 − a·(u − u_j)) + c·(u − u_j),      u' = u
    //
    // which at u = u_j is the identity (position continuous) and whose cross
    // slope at u_j is c + a·(v − v̄) (slope continuous, per cross row).  The
    // fan is PROJECTIVE rather than a per-slice affine on purpose: an affine
    // evaluated at a slice's midpoint is off by a·(v − v̄)·(half a slice) at the
    // cross extremes — 3 px for an 8 px slice at a = 0.0016 — and that is a
    // sawtooth between slices.  The projective form is one continuous function
    // of (u, v) for every slice.  Its price is that a homography cannot scale v
    // without scaling u by the same 1/w, so u is pre-compensated per slice by
    // the affine `Cu` below (the exact inverse is a Möbius map in u; linearised
    // about the slice midpoint the residual is second order, ~0.03 px over an 8
    // px slice at a = 0.002).  The shear is applied AFTER the fan so the two
    // are a rigid translation plus a magnification about v̄ rather than a
    // magnified translation — a linear model extrapolated 400 px has a free
    // quadratic term, and this is the one that keeps the shear what was fitted.
    static Mat33 trajMap(const CrossTraj& t, double uJoin, double uMid) {
        if (!t.valid) return Mat33::eye();
        double c = t.slope, a = t.fan;
        const double vb = t.fanCentreV;
        // RELAX (Config::crossTrajRelaxPx): the slope and fan are continued
        // exactly at the join and decay as exp(−Δu/L).  Per slice the map is
        // still a homography — the local slope c·e^{−Δ/L} with the offset that
        // puts the displacement c·L·(1 − e^{−Δ/L}) at the slice midpoint, and
        // the fan parameter that puts the magnification 1 + a·L·(1 − e^{−Δ/L})
        // there.  Everything below then reads as if a and c were constants.
        double dOff = 0.0;
        if (t.relaxPx > 0.0) {
            const double dm = uMid - uJoin;
            const double e = std::exp(-std::fabs(dm) / t.relaxPx);
            const double s = (dm >= 0.0 ? 1.0 : -1.0);
            const double disp = c * t.relaxPx * (1.0 - e) * s;    // shear at mid
            c = t.slope * e;                                       // local slope
            dOff = disp - c * dm;
            const double m = 1.0 + t.fan * t.relaxPx * (1.0 - e) * s;   // fan at mid
            a = (std::fabs(dm) > 1e-9 && m > 1e-6) ? (1.0 - 1.0 / m) / dm : t.fan;
        }
        // THE STEP, applied first and only where two frames meet (the seed):
        // a cross shift plus a cross scale about v̄, so a join whose two sides
        // disagree by a fan-shaped offset (the latch window's own scale change)
        // is made continuous in POSITION as well as slope.
        Mat33 St = Mat33::eye();
        if (t.applyStep && (t.stepPx != 0.0 || t.stepFan != 0.0)) {
            const double k = 1.0 + t.stepFan;
            St = Mat33(1.0, 0.0, 0.0,  0.0, k, t.stepPx - t.stepFan * vb,  0.0, 0.0, 1.0);
        }
        const Mat33 S(1.0, 0.0, 0.0,  c, 1.0, -c * uJoin + dOff,  0.0, 0.0, 1.0);
        if (a == 0.0) return S * St;
        // The fan's denominator must be w = 1 − a·(u − u_j) in the TRUE canvas
        // u, while the along coordinate handed to the projective row is the
        // pre-compensated x = σ·u + β chosen so that x / w(u) == u about the
        // slice midpoint.  So w is written in terms of x — p·x + q with
        // p = −a/σ, q = 1 + a·(β/σ + u_j) — which makes it exactly linear in u.
        // (The first cut wrote w in x with p = −a, i.e. evaluated the fan at
        // the compensated coordinate; measured on the zoom fixture that applied
        // 58 % of the fitted fan, and the bars kept 40 % of their hinge.)
        // Per slice: f(u) = u·(1 − a·(u − u_j)) is what x must equal for
        // x / w == u; linearised at uMid, σ = f'(uMid), β = f(uMid) − σ·uMid.
        // The residual is second order: |u' − u| ≤ 16·a ≈ 0.02 px over an 8 px
        // slice at a = 0.0013.
        const double fMid = uMid * (1.0 - a * (uMid - uJoin));
        const double sig = 1.0 + a * uJoin - 2.0 * a * uMid;
        if (!(std::fabs(sig) > 1e-6)) return S * St;
        const double beta = fMid - sig * uMid;
        const Mat33 Cu(sig, 0.0, beta,  0.0, 1.0, 0.0,  0.0, 0.0, 1.0);
        const Mat33 P(1.0, 0.0, 0.0,  0.0, 1.0, 0.0,
                      -a / sig, 0.0, 1.0 + a * (beta / sig + uJoin));
        return S * translate(0.0, vb) * P * translate(0.0, -vb) * Cu * St;
    }

    /// The same trajectory with the fan dropped — what a SINGLE-block path can
    /// carry (a fan needs slices to compensate u per slice).
    static CrossTraj shearOnly(const CrossTraj& t) {
        CrossTraj s = t;
        s.fan = 0.0;
        return s;
    }

    /// The cross-axis extent, in canvas v, the frame `src` reaches through
    /// `H` placed under `t` about `uJoin`, over canvas columns [ua, ub].  Used
    /// to grow the band BEFORE a sheared block is committed — the shear moves
    /// the block's far end by c·(ub − uJoin), which on a 0.15 px/px trajectory
    /// over a 360 px block is 54 px, and a strip path would have grown the
    /// band for that while the tail path never had to.
    bool trajExtentV(const CrossTraj& t, const Mat33& H, double uJoin,
                     double ua, double ub, double* v0, double* v1) const {
        double a0, a1, b0, b1;
        if (!mapBounds(trajMap(t, uJoin, ua) * H, imgW, imgH, &a0, &a1, v0, v1))
            return false;
        if (!mapBounds(trajMap(t, uJoin, ub) * H, imgW, imgH, &a0, &a1, &b0, &b1))
            return false;
        *v0 = std::min(*v0, b0);
        *v1 = std::max(*v1, b1);
        return std::isfinite(*v0) && std::isfinite(*v1);
    }

    /// Estimator 1 — THE CHAIN: least-squares d(posV)/d(posU) over the committed
    /// strips whose posU lies in the window on the `dir` side of `uJoin`.
    bool chainTrajectory(double uJoin, int dir, double N, CrossTraj* out) const {
        double su = 0, sv = 0, suu = 0, suv = 0;
        int n = 0;
        double uMin = 0, uMax = 0;
        for (size_t i = 0; i < stripTrail.size(); ++i) {
            const double du = stripTrail[i].first - uJoin;
            const bool in = (dir < 0) ? (du <= 0.0 && du >= -N)
                                      : (du >= 0.0 && du <= N);
            if (!in) continue;
            const double u = stripTrail[i].first, v = stripTrail[i].second;
            if (n == 0) { uMin = uMax = u; }
            uMin = std::min(uMin, u); uMax = std::max(uMax, u);
            su += u; sv += v; suu += u * u; suv += u * v; ++n;
        }
        out->samples = n;
        if (n < 6 || !(uMax - uMin >= 0.5 * N)) return false;
        const double den = (double)n * suu - su * su;
        if (!(std::fabs(den) > 1e-9)) return false;
        const double slope = ((double)n * suv - su * sv) / den;
        if (!std::isfinite(slope) || std::fabs(slope) > 0.5) return false;
        out->slope = slope;
        out->fan = 0.0;
        out->fanCentreV = 0.0;
        out->bands = 1;
        out->response = 1.0;
        out->valid = true;
        return true;
    }

    /// Estimator 2 — THE OVERLAP: the block frame's discarded half, warped over
    /// the window through the block's own law, tracked column by column against
    /// the canvas the strips committed there.
    ///
    /// WHY A TRACKER AND NOT ONE CORRELATION PER BAND.  Measured on 12-48-28,
    /// the cross offset between the strips and the last frame's rear half is
    /// tens of px at the cross extremes within 60 columns (the strips' bars
    /// there lean 0.8 px/px against the frame's 0.2), and the content — the
    /// operator's balusters — is periodic at ~40 px.  A fixed ±12 px search on
    /// 200-row bands aliased onto neighbouring bars and returned a slope of
    /// the wrong sign.  So: narrow bands (the offset is nearly uniform within
    /// 48 rows), and columns visited from the join OUTWARD with each band's
    /// search centred on the running fit's prediction — the offset is ~0 at
    /// the join by construction and grows linearly, so the prediction is
    /// always within a few px of the truth and a bar 40 px away is never the
    /// nearest peak.  Per band the offset is fitted as a QUADRATIC in x —
    /// δ = i + g·x + h·x² — and `g`, the slope AT the join, is what is
    /// continued; the reasoning is in Config::crossTraj ("the slope is the
    /// slope at the join").  The intercept is read from the six columns
    /// nearest the join rather than from the fit, so a join whose two sides
    /// are DIFFERENT frames (the seed's) carries the real step between them.
    /// Once a band has a fit of its own it predicts its own next column;
    /// until then the across-band line does, so a band cannot run away on
    /// three samples and a bent trajectory is still followed to the window's
    /// end.  A band whose fit leaves > 0.75 px rms locked onto nothing
    /// coherent and is dropped before the across-band fit.
    bool overlapTrajectory(const cv::Mat& src, const Mat33& H, double kfx,
                           double kfy, double kcx, double kcy, bool arcLaw,
                           double slicePx, double uJoin, int dir, double N,
                           double spanPx, CrossTraj* out) const {
        if (src.empty() || onesMask.empty() || canvas.empty() || !anyPainted)
            return false;
        double fu0, fu1, fv0, fv1;
        if (!mapBounds(H, imgW, imgH, &fu0, &fu1, &fv0, &fv1)) return false;
        double wa = (dir < 0) ? uJoin - N : uJoin;
        double wb = (dir < 0) ? uJoin : uJoin + N;
        wa = std::max(wa, std::max((double)minPaintedU, fu0));
        wb = std::min(wb, std::min((double)maxPaintedU, fu1));
        // THE SEED'S JOIN IS AGAINST THE FIRST STRIP, and the first strip is a
        // single-frame span: the latch fires only after `latchTotalPx` of
        // motion, so the first painted frame sits ≥ 24 px past the seed's
        // centre and paints from the frontier back — 41 px of ONE frame on
        // 12-48-28.  The strips proper, and their slope, begin at its far
        // edge; the seed's rear half meets the first strip's geometry, not
        // theirs.  So the window is clipped to that span (its step and its own
        // lean), and the minimum is relaxed to what such a span can be.
        if (dir > 0 && firstStripX1 > uJoin) wb = std::min(wb, firstStripX1);
        const double minSpan = (dir > 0) ? std::min(0.5 * N, 16.0) : 0.5 * N;
        if (!(wb - wa >= minSpan)) return false;
        const int c0 = std::max(0, (int)std::floor(wa));
        const int c1 = std::min(canvasW, (int)std::ceil(wb));
        const int W = c1 - c0;
        if (W < 8 || canvasH < 96) return false;

        // The frame's half, through the same law the block will be placed
        // under — arc slices when the block is arc-placed, else the one warp.
        std::vector<TailSlice> slices;
        const bool sliced =
            arcLaw && arcSlicesAbout(H, kcx, kcy, (double)c0, (double)c1,
                                     slicePx, /*spanIsCanvas=*/true, &slices) &&
            !slices.empty();
        if (!sliced) {
            TailSlice s;
            s.H = H; s.u0 = (double)c0; s.u1 = (double)c1;
            slices.assign(1, s);
        }
        cv::Mat scratch = cv::Mat::zeros(canvasH, W, CV_8UC3);
        cv::Mat smask = cv::Mat::zeros(canvasH, W, CV_8UC1);
        cv::Mat lensScratch;
        int runLeft = 0;
        for (size_t i = 0; i < slices.size(); ++i) {
            const int sx0 = std::max(runLeft, (int)std::floor(slices[i].u0) - c0);
            const int sx1 = std::min(W, (int)std::ceil(slices[i].u1) - c0);
            if (sx1 <= sx0) continue;
            const Mat33 Hp = translate(-(double)(c0 + sx0), 0.0) * slices[i].H;
            cv::Mat warped, wmask;
            // The SAME resample the strips went through (v10): an uncorrected
            // half against a corrected canvas read the lens's own cross scale
            // as a step-fan of −0.013 /px on every lens pack, and the seed
            // applied it.
            resampleFrame(src, Hp, sx1 - sx0, kfx, kfy, kcx, kcy, lensScratch,
                          &warped, &wmask);
            const cv::Rect r(sx0, 0, sx1 - sx0, canvasH);
            warped.copyTo(scratch(r), wmask);
            wmask.copyTo(smask(r));
            runLeft = sx1;
        }

        // Gray, high-passed ALONG v (a 1-D box mean, radius 9) so a column is
        // a set of edges whose cross position can be found, not an intensity
        // ramp whose correlation peaks at zero shift regardless of content.
        const cv::Rect win(c0, 0, W, canvasH);
        cv::Mat gA, gB, loA, loB, hpA, hpB;
        cv::cvtColor(scratch, gA, cv::COLOR_BGR2GRAY);
        cv::cvtColor(canvas(win), gB, cv::COLOR_BGR2GRAY);
        gA.convertTo(gA, CV_32F);
        gB.convertTo(gB, CV_32F);
        cv::blur(gA, loA, cv::Size(1, 19));
        cv::blur(gB, loB, cv::Size(1, 19));
        hpA = gA - loA;
        hpB = gB - loB;
        cv::Mat valid;
        cv::bitwise_and(smask, coverage(win), valid);

        // ── the tracker ────────────────────────────────────────────────
        const int S = 8;                  // search half-width about the prediction
        const int kMinRows = 24;          // valid rows a band must share
        const double kMinResp = 0.35;     // correlation peak to accept
        const double kMinEnergy = 4.0;    // DN² per row: a band with no edges says nothing
        const int bandH = std::max(32, canvasH / 24);
        const int nBands = std::max(1, canvasH / bandH);
        // Per band: weighted sums for δ = i + g·x (an intercept per band, so a
        // join whose two sides are DIFFERENT frames — the seed's — can carry
        // the real offset between them without folding it into the slope; a
        // 10 px step over a 60 px window would otherwise read as 0.25 px/px).
        // `sd0`/`n0`: δ over the SIX columns nearest the join, which is where
        // the step lives — the line's intercept would carry the slope's own
        // bias into it (a seed window begins with the first strip's
        // single-frame span, flat for tens of px, then the strips' slope;
        // the intercept of a line through both is neither).
        struct Band {
            double sw, sx, sd, sxx, sxd, v; int n; double g, i; bool has;
            double sd0, sw0; int n0;
            // the quadratic's extra moments, its curvature and its residual
            double sx3, sx4, sxxd, sdd, h, rms;
        };
        std::vector<Band> bands((size_t)nBands);
        for (int b = 0; b < nBands; ++b) {
            const int r0 = b * bandH;
            const int r1 = (b == nBands - 1) ? canvasH : r0 + bandH;
            bands[(size_t)b] = Band{0.0, 0.0, 0.0, 0.0, 0.0,
                                    0.5 * (double)(r0 + r1), 0, 0.0, 0.0, false,
                                    0.0, 0.0, 0,
                                    0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
        }
        // A curvature term needs columns to resolve it: below 32 the fit is a
        // line (the seed's window is a single frame's span, and linear there
        // by construction).
        const bool fitCurv = (W >= 32);
        const double kMaxBandRms = 0.75;
        // A FAN is a gradient ACROSS the cross axis, and needs that axis
        // sampled: with fewer than a third of the bands (8 of 24) it is two
        // clusters and a line between them.  Below this the slope is still
        // continued and the fan is 0 — on 15-48-37, where 5 bands survived,
        // the fan those five implied over-corrected the bars by 0.13 px/px.
        const int kMinFanBands = 8;
        // Weighted least squares per band.  Linear: δ = i + g·x.  Quadratic:
        // δ = i + g·x + h·x², solved from the 3×3 normal equations; `g` is
        // then the slope at x = 0, the join.  Returns false when singular.
        auto fitBand = [&](Band& bd) {
            const double den = bd.sw * bd.sxx - bd.sx * bd.sx;
            if (!(std::fabs(den) > 1e-9)) return false;
            const double gLin = (bd.sw * bd.sxd - bd.sx * bd.sd) / den;
            const double iLin = (bd.sd - gLin * bd.sx) / bd.sw;
            bd.g = gLin; bd.h = 0.0;
            double ssr = bd.sdd - iLin * bd.sd - gLin * bd.sxd;
            if (fitCurv && bd.n >= 8) {
                // Normal equations  [sw sx sxx; sx sxx sx3; sxx sx3 sx4]·[i g h]ᵀ
                // = [sd sxd sxxd]ᵀ, by Cramer's rule.
                const double a11 = bd.sw, a12 = bd.sx, a13 = bd.sxx;
                const double a22 = bd.sxx, a23 = bd.sx3, a33 = bd.sx4;
                const double D = a11 * (a22 * a33 - a23 * a23)
                               - a12 * (a12 * a33 - a23 * a13)
                               + a13 * (a12 * a23 - a22 * a13);
                if (std::fabs(D) > 1e-9 * std::max(1.0, a11 * a22 * a33)) {
                    const double b1 = bd.sd, b2 = bd.sxd, b3 = bd.sxxd;
                    const double Di = b1 * (a22 * a33 - a23 * a23)
                                    - a12 * (b2 * a33 - a23 * b3)
                                    + a13 * (b2 * a23 - a22 * b3);
                    const double Dg = a11 * (b2 * a33 - a23 * b3)
                                    - b1 * (a12 * a33 - a23 * a13)
                                    + a13 * (a12 * b3 - b2 * a13);
                    const double Dh = a11 * (a22 * b3 - b2 * a23)
                                    - a12 * (a12 * b3 - b2 * a13)
                                    + b1 * (a12 * a23 - a22 * a13);
                    const double iq = Di / D, gq = Dg / D, hq = Dh / D;
                    if (std::isfinite(iq) && std::isfinite(gq) && std::isfinite(hq)) {
                        bd.g = gq; bd.h = hq;
                        ssr = bd.sdd - iq * bd.sd - gq * bd.sxd - hq * bd.sxxd;
                    }
                }
            }
            bd.rms = std::sqrt(std::max(0.0, ssr) / bd.sw);
            bd.i = (bd.n0 >= 2 && bd.sw0 > 0.0) ? (bd.sd0 / bd.sw0) : iLin;
            return std::isfinite(bd.g) && std::isfinite(bd.i);
        };
        // The running fit: slope `c` and fan `a` about `vbar`, and the step
        // `sc` with its own fan `sa`, refreshed after every column from the
        // bands that have samples.
        double c = 0.0, a = 0.0, sc = 0.0, sa = 0.0;
        double vbar = 0.5 * (double)canvasH;
        // The across-band fit is CENTRE-WEIGHTED: a Gaussian in the band's
        // distance from the painted cross centre, σ = a third of the painted
        // cross extent.  Measured on 12-48-28 the lean profile is odd about
        // the axis and super-linear toward the ultra-wide corners (−1.6 px/px
        // at the top edge, +0.7 at the bottom, ~0 over the middle third); an
        // unweighted line through it put −0.22 at the axis where the bars
        // there lean −0.03, and the block's central bars ended up leaning
        // 0.2 px/px MORE than the strips — an elbow the other way.  A line
        // is what a homography can carry, so it is fitted where the eye
        // reads it; the corners keep what a line cannot give them.
        const double vC = anyPaintedV ? 0.5 * (double)(minPaintedV + maxPaintedV)
                                      : 0.5 * (double)canvasH;
        const double vSig = std::max(64.0, (anyPaintedV
                                              ? (double)(maxPaintedV - minPaintedV)
                                              : (double)canvasH) / 3.0);
        auto bandWeight = [&](const Band& bd) {
            const double z = (bd.v - vC) / vSig;
            return bd.sw * std::exp(-z * z);
        };
        auto refit = [&]() {
            double swAll = 0, sg = 0, si = 0, sv = 0;
            int nb = 0;
            for (size_t b = 0; b < bands.size(); ++b) {
                Band& bd = bands[b];
                bd.has = false;
                if (bd.n < 3 || !(bd.sw > 0.0)) continue;
                if (!fitBand(bd)) continue;
                bd.has = true;
                const double w = bandWeight(bd);
                swAll += w; sg += w * bd.g; si += w * bd.i;
                sv += w * bd.v; ++nb;
            }
            if (nb == 0 || !(swAll > 0.0)) { c = 0.0; a = 0.0; sc = 0.0; sa = 0.0; return; }
            c = sg / swAll;
            sc = si / swAll;
            vbar = sv / swAll;
            a = 0.0; sa = 0.0;
            if (cfg.crossTrajFan && nb >= kMinFanBands) {
                double svv = 0, svg = 0, svi = 0;
                for (size_t b = 0; b < bands.size(); ++b) {
                    if (!bands[b].has) continue;
                    const double w = bandWeight(bands[b]);
                    const double dv = bands[b].v - vbar;
                    svv += w * dv * dv;
                    svg += w * dv * (bands[b].g - c);
                    svi += w * dv * (bands[b].i - sc);
                }
                if (svv > 1e-9) { a = svg / svv; sa = svi / svv; }
            }
        };
        int samplesTotal = 0;
        // Columns from the join outward: for dir −1 the join is the window's
        // right edge (column W−1), for dir +1 its left edge (column 0).
        for (int k = 0; k < W; ++k) {
            const int col = (dir < 0) ? (W - 1 - k) : k;
            const double x = (double)(c0 + col) + 0.5 - uJoin;
            // Nothing predicts the first columns, so they search twice as
            // wide — the join's own step, if there is one, has to be found
            // before it can be tracked.
            const int Sk = (k < 3) ? 2 * S : S;
            for (int b = 0; b < nBands; ++b) {
                const int r0 = b * bandH;
                const int r1 = (b == nBands - 1) ? canvasH : r0 + bandH;
                Band& bd = bands[(size_t)b];
                // The band's own fit once it has one (and it is coherent),
                // else the across-band line.
                const double pred =
                    (bd.has && bd.n >= 12 && bd.rms <= 1.0)
                        ? (bd.i + bd.g * x + bd.h * x * x)
                        : (sc + sa * (bd.v - vbar)) + (c + a * (bd.v - vbar)) * x;
                const int pc = (int)std::lround(pred);
                double best = -2.0;
                int bestS = 0;
                double nccAt[4 * S + 1];
                bool any = false;
                for (int s = pc - Sk; s <= pc + Sk; ++s) {
                    double dot = 0, na = 0, nb = 0;
                    int cnt = 0;
                    const int ra = std::max(r0, -s), rb = std::min(r1, canvasH - s);
                    for (int r = ra; r < rb; ++r) {
                        if (!valid.at<uchar>(r, col) || !valid.at<uchar>(r + s, col))
                            continue;
                        const double av = hpA.at<float>(r, col);
                        const double bv = hpB.at<float>(r + s, col);
                        dot += av * bv; na += av * av; nb += bv * bv; ++cnt;
                    }
                    double ncc = -2.0;
                    if (cnt >= kMinRows && na > kMinEnergy * cnt &&
                        nb > kMinEnergy * cnt)
                        ncc = dot / std::sqrt(na * nb);
                    nccAt[s - (pc - Sk)] = ncc;
                    if (ncc > best) { best = ncc; bestS = s; any = true; }
                }
                if (!any || best < kMinResp) continue;
                if (bestS <= pc - Sk || bestS >= pc + Sk) continue;   // at the search edge
                const int i = bestS - (pc - Sk);
                const double l = nccAt[i - 1], m = nccAt[i], rr = nccAt[i + 1];
                if (l < -1.5 || rr < -1.5) continue;
                const double den = l - 2.0 * m + rr;
                double frac = (std::fabs(den) > 1e-9) ? 0.5 * (l - rr) / den : 0.0;
                if (std::fabs(frac) > 1.0) frac = 0.0;
                const double d = (double)bestS + frac;
                // δ = i + g·x + h·x², weighted by the peak.
                bd.sw += best;
                bd.sx += best * x;
                bd.sd += best * d;
                bd.sxx += best * x * x;
                bd.sxd += best * x * d;
                bd.sx3 += best * x * x * x;
                bd.sx4 += best * x * x * x * x;
                bd.sxxd += best * x * x * d;
                bd.sdd += best * d * d;
                bd.n += 1;
                if (k < 6) { bd.sd0 += best * d; bd.sw0 += best; bd.n0 += 1; }
                ++samplesTotal;
            }
            refit();
        }
        out->samples = samplesTotal;
        // A band whose own fit does not describe its samples (the ultra-wide
        // corners, where the tracker chases texture through a 4 px residual)
        // says nothing about the trajectory and is dropped first.
        for (size_t b = 0; b < bands.size(); ++b) {
            if (bands[b].has && bands[b].rms > kMaxBandRms) {
                bands[b].n = 0; bands[b].sw = 0.0;
            }
        }
        refit();
        int nb = 0;
        for (size_t b = 0; b < bands.size(); ++b) if (bands[b].has) ++nb;
        out->bands = nb;
        if (nb < 3 || samplesTotal < 24) return false;
        // The final fit, with one outlier pass across bands: a band whose slope
        // sits far off the line locked onto something the others did not.
        {
            std::vector<double> res;
            for (size_t b = 0; b < bands.size(); ++b)
                if (bands[b].has)
                    res.push_back(std::fabs(bands[b].g - (c + a * (bands[b].v - vbar))));
            std::vector<double> sorted = res;
            std::sort(sorted.begin(), sorted.end());
            const double mad = sorted[sorted.size() / 2];
            const double bar = std::max(0.05, 3.0 * mad);
            size_t j = 0;
            for (size_t b = 0; b < bands.size(); ++b) {
                if (!bands[b].has) continue;
                if (res[j] > bar) { bands[b].n = 0; bands[b].sw = 0.0; }
                ++j;
            }
            refit();
            nb = 0;
            for (size_t b = 0; b < bands.size(); ++b) if (bands[b].has) ++nb;
            if (nb < 3) return false;
        }
        double sr = 0, sn = 0;
        for (size_t b = 0; b < bands.size(); ++b)
            if (bands[b].has) { sr += bands[b].sw; sn += (double)bands[b].n; }
        if (!std::isfinite(c) || !std::isfinite(a) || !std::isfinite(sc) ||
            !std::isfinite(sa))
            return false;
        if (std::fabs(c) > 0.5 || std::fabs(a) > 0.006) return false;
        if (!detail::crossTrajFanWithinSpan(a, spanPx, out->relaxPx)) return false;
        if (std::fabs(sc) > 24.0 || std::fabs(sa) > 0.1) return false;
        out->slope = c;
        out->fan = a;
        out->fanCentreV = vbar;
        out->stepPx = sc;
        out->stepFan = sa;
        // The seed's join is two frames (the reference and the first strip's),
        // so its step is real and is applied; the tail's join is one frame and
        // its step is the instrument's, reported and not applied.
        out->applyStep = (dir > 0);
        out->response = (sn > 0.0) ? sr / sn : 0.0;
        out->bands = nb;
        out->valid = true;
        return true;
    }

    /// THE routine.  `dir` −1 measures the window BEHIND `uJoin` (the tail and
    /// the lead-out: the frame's rear half against the strips it followed);
    /// +1 measures AHEAD (the seed: the reference's forward half against the
    /// strips that overpainted it).  `arcLaw`/`slicePx` are the block's own
    /// law, so the frame is compared under the placement it will get.
    /// `kfx..kcy` are the FRAME's intrinsics — the last painted frame's for
    /// the tail and lead-out, the reference's for the seed — for the lens
    /// resample; `spanPx` is the block the estimate will be carried over,
    /// for the fan bound.
    bool crossTrajectory(const cv::Mat& src, const Mat33& H, double kfx,
                         double kfy, double kcx, double kcy, bool arcLaw,
                         double slicePx, double uJoin, int dir, double spanPx,
                         CrossTraj* out) const {
        *out = CrossTraj();
        if (cfg.crossTraj == 0) return false;
        out->source = cfg.crossTraj;
        out->relaxPx = std::max(0.0, cfg.crossTrajRelaxPx);
        const double N = cfg.crossTrajWindowPx;
        if (cfg.crossTraj == 1) return chainTrajectory(uJoin, dir, N, out);
        return overlapTrajectory(src, H, kfx, kfy, kcx, kcy, arcLaw, slicePx,
                                 uJoin, dir, N, spanPx, out);
    }

    /// Re-place the SEED's rear half `[seedX0, floor(seedCentre))` under `t`.
    ///
    /// A direct paint, not `commitStrip`: this is a re-placement of content
    /// the seed already committed, so it banks no strip, fits no gain, samples
    /// no seam and moves no frontier.  Nothing but the seed ever painted these
    /// columns (every later paint starts at `max(highWater, …)` and the
    /// frontier began at the seed's centre), so the span is cleared and
    /// repainted whole; coverage and the painted-row union follow the new
    /// mask.  Returns the columns repainted.
    double repaintSeedRear(const CrossTraj& t) {
        if (!t.valid || refKeep.empty() || onesMask.empty() || canvas.empty())
            return 0.0;
        if (!(seedCentreU > 0.0) || seedX1 <= seedX0) return 0.0;
        const int x0 = std::max(0, seedX0);
        const int x1 = std::min(canvasW, (int)std::floor(seedCentreU));
        if (x1 - x0 < 4) return 0.0;
        // The seed's matrix was baked against the latch-time origin; every
        // band growth since moved the canvas down by `vShiftTotal`.
        const Mat33 Hs = translate(0.0, vShiftTotal) * seedHref;
        std::vector<TailSlice> slices;
        const bool sliced =
            seedArced && arcSlicesAbout(Hs, refCx, refCy, (double)x0, (double)x1,
                                        cfg.seedArcSlicePx,
                                        /*spanIsCanvas=*/true, &slices) &&
            !slices.empty();
        if (!sliced) {
            TailSlice s;
            s.H = Hs; s.u0 = (double)x0; s.u1 = (double)x1;
            slices.assign(1, s);
        }
        const cv::Rect span(x0, 0, x1 - x0, canvasH);
        canvas(span).setTo(cv::Scalar());
        coverage(span).setTo(cv::Scalar());
        int runLeft = x0;
        double painted = 0.0;
        cv::Mat lensScratch;
        for (size_t i = 0; i < slices.size(); ++i) {
            const int sx0 = std::max(runLeft, (int)std::floor(slices[i].u0));
            const int sx1 = std::min(x1, (int)std::ceil(slices[i].u1));
            if (sx1 <= sx0) continue;
            const CrossTraj tt = sliced ? t : shearOnly(t);
            const Mat33 Hk = trajMap(tt, seedCentreU, 0.5 * (double)(sx0 + sx1)) *
                             slices[i].H;
            const Mat33 Hp = translate(-(double)sx0, 0.0) * Hk;
            cv::Mat warped, wmask;
            // The reference frame's own intrinsics, through the same v10
            // resample the seed was painted with — the lens verdict this
            // gives is the one the seed's slices got, so `lensCorrectedStrips`
            // still describes what is on the canvas.
            resampleFrame(refKeep, Hp, sx1 - sx0, refFx, refFy, refCx, refCy,
                          lensScratch, &warped, &wmask);
            const cv::Rect r(sx0, 0, sx1 - sx0, canvasH);
            warped.copyTo(canvas(r), wmask);
            coverage(r).setTo(cv::Scalar(255), wmask);
            if (wmask.rows > 0 && wmask.cols > 0) {
                cv::Mat rowsAny;
                cv::reduce(wmask, rowsAny, 1, cv::REDUCE_MAX, CV_8U);
                int first = -1, last = -1;
                for (int y = 0; y < rowsAny.rows; ++y) {
                    if (rowsAny.at<uchar>(y, 0)) { if (first < 0) first = y; last = y; }
                }
                if (first >= 0) {
                    if (!anyPaintedV) {
                        minPaintedV = first; maxPaintedV = last + 1;
                        anyPaintedV = true;
                    } else {
                        minPaintedV = std::min(minPaintedV, first);
                        maxPaintedV = std::max(maxPaintedV, last + 1);
                    }
                }
            }
            runLeft = sx1;
            painted += (double)(sx1 - sx0);
        }
        // THE REAR EDGE MOVES WITH THE MAP.  The seed's rearmost committed
        // column was set by the unsheared frame's mask; under the map the
        // frame's ragged rear edge can land a column later, and a column
        // inside `[minPaintedU, maxPaintedU)` with no coverage is reported as
        // a HOLE by `unpaintedRuns()` (measured: 10 of 16 packs gained one
        // such run at column minPaintedU).  The extent follows the coverage.
        for (int xcol = x0; xcol < x1; ++xcol) {
            if (cv::countNonZero(coverage.col(xcol)) > 0) {
                if (xcol > minPaintedU) minPaintedU = xcol;
                break;
            }
        }
        return painted;
    }

    // ── THE LATCH COMMIT ────────────────────────────────────────────────────
    // Adopt `axis`/`sweepSign`, size the canvas from the REFERENCE frame's own
    // footprint (its H_rect is the identity by construction, so the lead-in is
    // real image content) and bootstrap-paint it.  Shared verbatim by the
    // first latch and by every relatch, which is the point: a relatch is not a
    // second, subtly different code path — it is THIS path run again with a
    // corrected direction and a newer reference frame.
    //
    // Returns false only on an unrecoverable canvas failure; `*fatal` then
    // names it for abort().
    bool commitLatch(double accX, double accY, FrameOutcome& row,
                     const char** fatal) {
        *fatal = nullptr;
        if (cfg.axisOverride == 1) axis = 0;
        else if (cfg.axisOverride == 2) axis = 1;
        else axis = (std::fabs(accX) >= std::fabs(accY)) ? 0 : 1;
        const double dom = (axis == 0) ? accX : accY;
        if (cfg.signOverride != 0) sweepSign = cfg.signOverride;
        else sweepSign = (dom < 0.0) ? -1 : 1;
        A = axisMatrix(axis, sweepSign);

        const Mat33 HrefNoOrigin = A * scaleM(cfg.canvasScale);
        double fu0, fu1, fv0, fv1;
        if (!mapBounds(HrefNoOrigin, imgW, imgH, &fu0, &fu1, &fv0, &fv1)) {
            *fatal = "reference-footprint-degenerate";
            return false;
        }
        // One frame's extent along and across the sweep — the scale every
        // proportional bar in the engine is measured against (see
        // minCropBandPx and Config's relatch block).
        footprintU = fu1 - fu0;
        footprintV = fv1 - fv0;
        canvasH = (int)std::ceil(fv1 - fv0) + 2 * cfg.canvasPadPx;
        originU = cfg.canvasPadPx - fu0;
        originV = cfg.canvasPadPx - fv0;
        canvasW = 0;
        canvas.release();
        coverage.release();
        // The photometric field indexes CANVAS columns, so it dies with the
        // canvas.  A relatch that kept it would report a band in columns the
        // deliverable no longer contains.
        colScale.clear();
        photoScanU = -1; photoStartU = 0;
        photoHMin = photoTMin = photoHMax = photoTMax = 0;
        photoWorstP2P = 0.0; photoWorstAt = 0;
        photoGMin = 0.0; photoGMax = 0.0; photoCols = 0;
        minPaintedU = 0; maxPaintedU = 0; anyPainted = false;
        minPaintedV = 0; maxPaintedV = 0; anyPaintedV = false;
        d8JogRun = 0;   // v13 — guard state is canvas-scoped, like the rest
        // Option C: the provisional lead-in belongs to the canvas being
        // discarded, not to the one about to be seeded.  Cleared here and set
        // from the seed's OWN committed edge below, so a relatch cannot leave
        // a strip licensed to repaint a span in the new canvas that the old
        // canvas is the only reason to think is provisional.
        leadEndU = -1.0;
        leadFillU = -1.0;
        leadArcSeeded = false;
        // Trajectory continuation: the trail and the retained seed describe
        // the canvas being discarded.  Cleared with it; re-set below.
        stripTrail.clear();
        refKeep.release();
        firstStripX1 = -1.0;
        seedCentreU = -1.0;
        seedX0 = seedX1 = 0;
        seedArced = false;
        if (!ensureCanvasWidth(std::max(cfg.canvasInitWidthPx,
                                        (int)std::ceil(fu1 - fu0) +
                                            4 * cfg.canvasPadPx))) {
            *fatal = "canvas-alloc-failed";
            return false;
        }
        st.canvasH = canvasH;

        // Bootstrap paint: the reference frame's FULL footprint, with the
        // frontier set to its CENTRE so the sweep resumes immediately.
        //
        // ⚠️ KNOWN STRUCTURAL DEFECT — the lead-in ahead of the frontier is
        // PROVISIONAL, and the claim that later frames replace it is FALSE.
        // An earlier revision of this comment asserted "still single-owner at
        // the end"; measured on the operator's four packs it is not:
        //
        //   * the bootstrap frame still owns 31.1 / 32.7 / 33.5 / 33.9% of the
        //     DELIVERED canvas at the end of the sweep, and the tail-flush
        //     frame a further 22.6-27.8% — so 56.0-61.3% of every delivered
        //     panorama comes from TWO frames out of ~190-345 distinct owners.
        //   * on 15-58-22 the whole first 360 display rows are 100% bootstrap;
        //     rows 360-719 carry an UN-REPLACED provisional remnant as a
        //     contiguous sliver at the row extreme, 6.3% of the row width at
        //     p50 (9.8% max), sitting directly against content a median of
        //     182 frames later (p95 322, max 393).
        //
        // This is NOT what makes the band the operator rejected — the owner
        // map showed the band is the camera's unlocked auto-exposure, and the
        // photometric fix (the sweep lock plus exact radiometric
        // normalisation) is upstream of this.  Paying it the same photometry
        // as its source frame, which commitStrip below now does, removes its
        // PHOTOMETRIC contribution.
        //
        // Its GEOMETRIC contribution is now addressed by the ARC SEED below:
        // the footprint is still one frame's, but it is no longer painted
        // under a projection law of its own.  What remains open here is the
        // OWNERSHIP share quoted above, which is a lead-in policy question
        // and is still open.
        const Mat33 Href = translate(originU, originV) * HrefNoOrigin;
        double ru0, ru1, rv0, rv1;
        mapBounds(Href, imgW, imgH, &ru0, &ru1, &rv0, &rv1);
        double ucx = 0, ucy = 0;
        mapPoint(Href, 0.5 * imgW, 0.5 * imgH, &ucx, &ucy);
        int px0 = 0, px1 = 0, clipCols = 0; double gs = 1.0;
        // THE SEED'S PROJECTION LAW.  Sliced when the sweep is cylindrical and
        // rectifying, because that is exactly when the strips place content at
        // the arc and an unwarped block does not.  Under `projection == 0` the
        // strips are on the tangent plane themselves and `Href` already IS
        // their law, and under `rectify == false` there is no H_rect anywhere —
        // so both control arms keep the block and stay byte-identical, which is
        // what makes them still usable as controls.
        //
        // AND THE ATTITUDE MUST ACTUALLY HAVE MOVED.  `maxRectifyDeg` is the
        // largest attitude excursion this session has seen; on a PURE
        // TRANSLATION sweep dR is the identity on every frame, so it is
        // identically 0 — no threshold, no regime selector, the same
        // construction as the arc term's own `if (psi != 0.0)`.  Without this
        // clause a translation sweep painted its strips on the tangent plane
        // and its seed on the arc, which is the fork this change exists to
        // remove, pointing the other way; and it broke
        // PanoProjection.DegeneratesExactlyToThePlanarArmOnAPureTranslation-
        // Sweep, which is the contract that v5 == v4 whenever psi vanishes.
        //
        // ⚠ WHAT THIS GATE DOES NOT SETTLE.  It is binary, and the seed's
        // correction is not: a sweep that is overwhelmingly a dolly with a few
        // tenths of a degree of hand tremor trips it and gets the full arc
        // seed, which its mostly-tangent canvas does not want.  The quantity
        // that would decide it properly is `rotationFraction`, and that is not
        // known until the sweep ends.  The honest fix is to re-commit the seed
        // at finalize under the law the sweep TURNED OUT to have; it is not
        // built here, and this is the open edge of this change.
        bool arced = false;
        if (cfg.seedArcSlicePx > 0.0 && cfg.projection == 1 && cfg.rectify &&
            maxRectifyDeg > 0.0) {
            const char* seedFatal = nullptr;
            arced = commitArcSeed(&px0, &px1, &clipCols, &seedFatal);
            if (!arced && seedFatal != nullptr) { *fatal = seedFatal; return false; }
        }
        // The reference frame IS the exposure datum, so its own normalisation
        // factor is 1.0 by definition — not "unknown".
        if (!arced &&
            !commitStrip(refBgr, Href, ru0, ru1, ru0, false, 1.0, 1.0, &gs,
                         &px0, &px1, &clipCols)) {
            *fatal = "canvas-full";
            return false;
        }
        if (clipCols > 0) {   // only reachable with canvasPadPx == 0
            row.clipped = true;
            ++st.clippedFrames;
            st.clippedColumns += clipCols;
        }
        highWater = ucx;
        // OPTION C — everything between the frontier just set and the seed's
        // own committed edge is PROVISIONAL.  `px1` and not `ru1`: the arc
        // seed commits a narrower span than the unwarped footprint, and
        // licensing a repaint out to `ru1` would repaint columns the seed
        // never painted (`lastFu1` below makes the same distinction for the
        // backfill, for the same reason).  A degenerate seed that committed
        // nothing forward of its own centre leaves this at -1.
        leadEndU = (cfg.leadReplace && (double)px1 > ucx + 0.5)
                       ? (double)px1 : -1.0;
        // The fill starts where the frontier starts: nothing ahead of the
        // centre has been filled yet, and nothing behind it ever will be.
        leadFillU = (leadEndU > 0.0) ? ucx : -1.0;
        leadArcSeeded = arced;
        advancePhotoScan(highWater);
        lastPaintedU = ucx;
        stripsSinceLatch = 0;
        // WHERE THE SWEEP STARTED, for the tail's rotation-fraction gate.  ψ is
        // measured from the REFERENCE frame and is re-zeroed by every relatch
        // (:3127), so the canvas position it is compared against has to be
        // re-zeroed with it — which is exactly here, the one place a reference
        // is adopted.  Recorded rather than derived: `minPaintedU` is the
        // bootstrap block's rear edge, half a footprint away from its centre,
        // and using it made the gate's denominator NEGATIVE on a sweep whose
        // strip run is shorter than one frame (12-48-28: 641 px painted against
        // a 720 px footprint) and silently refused the arc tail there.
        latchCentreU = ucx;
        lastBgr = refBgr;
        // `lastBgr` and its exposure factor MUST move together: the tail flush
        // and the backfill paint `lastBgr`'s pixels.
        lastExpGain = 1.0;
        lastExpResidual = 1.0;
        // `lastHint` stays the phi == 0 homography — which the arc seed makes
        // its OWN centre slice, so this is the same matrix in both arms.  It is
        // read by the interior backfill, which fills [highWater, next frame's
        // fu0): a span bounded by one frame's advance, over which the tangent
        // and the arc differ by f·(tan φ − φ) ≈ 0.06 canvas px at 30 px ahead.
        // Measured on all six of the operator's packs the backfill never fired
        // after the seed at all (backfillPx == 0).
        lastHint = Href;
        // The forward edge the backfill may reach must be what the seed
        // actually COMMITTED, not the unwarped footprint: the arc seed is
        // narrower than `ru1`, and letting a backfill run out to `ru1` would
        // paint the difference through `lastHint`'s tangent law and put back a
        // slice of the very fork this change removes.
        lastFu1 = arced ? (double)px1 : ru1;
        lastValid = true;
        tailFlushed = false;
        // TRAJECTORY CONTINUATION — keep what the seed's re-placement needs.
        // `refKeep` is a shallow reference to the same buffer `refBgr` holds,
        // so the release below drops a refcount and not the frame; with the
        // flag off nothing is retained and the release frees it as before.
        if (cfg.crossTraj != 0 && cfg.crossTrajSeed) {
            refKeep = refBgr;
            seedHref = Href;
            seedArced = arced;
            seedX0 = px0;
            seedX1 = px1;
            seedCentreU = ucx;
        }
        refBgr.release();
        row.canvasX0 = px0;
        row.canvasX1 = px1;
        // What was PAINTED, which under the arc seed is not the unwarped
        // footprint width — the ledger's seed block is what the offline seam
        // reader consumes, so it has to describe the committed columns.
        row.stripW = arced ? (double)(px1 - px0) : (ru1 - ru0);
        row.posU = ucx;
        row.posV = ucy;

        axisLatched = true;
        st.axisLatched = true;
        st.axis = axis;
        st.sweepSign = sweepSign;
        // Arm the self-check.  gTot is the displacement the correction reads;
        // it starts at the first latch and is NEVER re-zeroed by a relatch.
        if (!everLatched) { gTotX = 0.0; gTotY = 0.0; everLatched = true; }
        framesSinceLatch = 0;
        relatchArmed = (cfg.relatchMaxCount > 0);
        return true;
    }

    /// Re-seed the reference frame to `in` — attitude, intrinsics, the
    /// correlation datum and every accumulator measured against it.  Called
    /// only by the relatch: the frame that exposes a wrong axis is the newest
    /// good frame available, so it becomes the new origin and the sweep
    /// restarts from there rather than from a frame the engine no longer holds.
    void reseedReferenceTo(const FrameInput& in) {
        R0 = quatToR(in.q);
        for (int k = 0; k < 4; ++k) refQuat[k] = in.q[k];
        refFx = in.fx; refFy = in.fy; refCx = in.cx; refCy = in.cy;
        natRefX = cfg.canvasScale * 0.5 * (double)imgW;
        natRefY = cfg.canvasScale * 0.5 * (double)imgH;
        prevCrX = 0.5 * (double)imgW;
        prevCrY = 0.5 * (double)imgH;
        posNatX = 0.0; posNatY = 0.0;
        rotNetX = rotNetY = resNetX = resNetY = 0.0;
        rotPathX = rotPathY = resPathX = resPathY = 0.0;
        gainCum = 1.0;
        // v6 — THE EXPOSURE DATUM MOVES WITH THE REFERENCE.  A relatch throws
        // the canvas away, so normalising the new sweep to the OLD reference's
        // exposure would carry a photometric offset nothing in the deliverable
        // can justify.
        {
            const double e = in.exposureDurationS * in.exposureISO;
            refExposure = (e > 0.0 && std::isfinite(e)) ? e : 0.0;
        }
        curExpGain = 1.0;
        lastExpGain = 1.0;
        curExpResidual = 1.0;
        lastExpResidual = 1.0;
        stallCount = 0;
        stalled = false;
        vShiftTotal = 0.0;
        refBgr = in.bgr->clone();

        // SESSION METRICS ARE RE-BASED TOO.  A relatch throws the canvas away
        // (commitLatch re-allocates it from the new reference's footprint), so
        // seam percentiles, the operator-facing warping number and the sweep
        // extent must not keep describing strips that are no longer in the
        // deliverable — the integrity verdict would otherwise be driven by
        // content nobody can see.  resetCrossWindows() below re-bases the
        // per-band accumulator, the cross scale and the distance fit.
        seamWorstSamples.clear();
        seamSpreadSamples.clear();
        seamLumaSamples.clear();
        seamJogSamples.clear();
        jogAcc = 0.0; jogAccMin = 0.0; jogAccMax = 0.0; jogAccN = 0;
        seamPhotoOverBar = 0;
        seamPhotoSamples.clear();
        seamPhotoUniSamples.clear();
        seamPhotoSpreadSamples.clear();
        seamPhotoNonUniform = 0;
        seamPhotoUniformUnknown = 0;
        photoCumDN = 0.0; photoCumMinDN = 0.0; photoCumMaxDN = 0.0;
        photoDriftLocalDN = 0.0; photoDriftWorstU = 0;
        photoCumMinQ.clear(); photoCumMaxQ.clear();
        seamStripsCommitted = 0;
        // v10 — THE LENS STRIP COUNTERS ARE RE-BASED WITH THE REST.  They are
        // per-strip metrics of the DELIVERED canvas, so after a relatch they
        // must not keep counting strips that were painted onto a canvas the
        // engine has just thrown away.  The DECISION (`lensDec`, the LUT, the
        // focal window) deliberately survives: the body and the lens have not
        // changed, and re-deciding on every relatch would let focus breathing
        // flip the gate mid-sweep at the tolerance edge.
        lensCorrectedStrips = 0;
        lensSkippedStrips = 0;
        stripsCommitted = 0;
        // OPTION C — RE-BASED FOR THE SAME REASON, and it has to be: the header
        // says these two are a SUBSET of `stripsCommitted`, and that is only
        // true if they are re-based with it.  Left alone, a sweep that relatches
        // late keeps counting fills that painted a canvas the engine has just
        // thrown away, and the containment the header promises can invert.
        st.leadRepaintStrips = 0;
        st.leadRepaintPx = 0.0;
        maxAreaScalePainted = 1.0;
        maxCrossRectifyDeg = 0.0;
        crossScaleCagedFrames = 0;
        crossScaleLeakedFrames = 0;
        crossGSum = 0.0; crossGCount = 0; crossDcRemovedFrames = 0;
        crossBandFitRefused = 0;
        crossGestureRefused = 0;
        // RE-BASED, deliberately, alongside crossScaleCagedFrames — its nearest
        // analogue (both count frames whose PLACEMENT ran outside a modelled
        // regime).  A relatch discards the canvas, so a clamp that happened on
        // the chain that produced it describes content nobody can see, which is
        // the whole reason this block exists.  Note that the reseed below puts
        // the new reference's window on the raster centre with no clamp, so the
        // re-based count starts from a state the identity certainly covers.
        // (exposureClampedFrames is NOT re-based, and should not be: it grades
        // the INPUT metadata's trustworthiness, not the delivered geometry.)
        corrOriginClamped = 0;
        minPsiDeg = 0.0; maxPsiDeg = 0.0;
        projectionSwitched = false;
        projectionSwitchSeq = -1;
        projectionSwitchStepPx = 0.0;

        // The new reference's own correlation window: H_rect is the identity
        // for it, so the window sits on the raster centre with no clamp.
        const double ws = cfg.workScale;
        prevOwX = 0.5 * imgW * ws - 0.5 * winW;
        prevOwY = 0.5 * imgH * ws - 0.5 * winH;
        cv::Mat win8;
        cv::warpPerspective(*in.grayWork, win8,
                            cv::Mat(translate(-prevOwX, -prevOwY)),
                            cv::Size(winW, winH), cv::INTER_LINEAR,
                            cv::BORDER_CONSTANT, cv::Scalar());
        win8.convertTo(prevWinF, CV_32F);
        for (int k = 0; k < 3; ++k) {
            refT[k] = in.t[k];
            fwdRef[k] = -R0(k, 2);
        }
        curK[0] = refFx; curK[1] = refFy; curK[2] = refCx; curK[3] = refCy;
        for (int k = 0; k < 4; ++k) lastK[k] = curK[k];
        resetCrossWindows();
    }

    /// K correlation windows spread ACROSS the sweep.  Slot centreSlot() is
    /// v4's window verbatim (same origin, same clamp, same buffer), so `r0` —
    /// the value that drives the chain — is bit-identical to v4.  The outer
    /// slots buy ONE extra degree of freedom (a linear gradient of the
    /// residual along the cross axis, physically the plane-at-d scale) and,
    /// for free, the per-band measurement the cut metric is made of.
    ///
    /// `bands` is filled with (slot, ξ, measured cross advance).  The cut
    /// metric is deliberately NOT computed here: it must be the residual of
    /// the placement the engine ACTUALLY APPLIES, which is not decided until
    /// the cage has had its say.  Scoring a fit against its own residual is
    /// how a metric ends up certifying output the operator can see is broken.
    void crossMeasure(const cv::Mat& grayWork, const Mat33& Hrect,
                      double bu0, double bu1, double bv0, double bv1,
                      double ws, double owX, double owY, const cv::Mat& curWinF,
                      double advX, double advY, double centreResponse,
                      double* gradOut, std::vector<CrossBand>* bands,
                      double* xiCOut, std::vector<cv::Mat>* curWins,
                      std::vector<double>* owXs, std::vector<double>* owYs,
                      double* avgCrossOut) {
        const int K = crossWindowCount();
        const int c = centreSlot();
        *gradOut = 0.0;
        *xiCOut = 0.0;
        // The default IS the centre window, so every early return below leaves
        // the caller with v7's value rather than with zero.
        *avgCrossOut = (axis == 0) ? advY : advX;
        bands->clear();
        curWins->assign((size_t)K, cv::Mat());
        owXs->assign((size_t)K, owX);
        owYs->assign((size_t)K, owY);
        (*curWins)[(size_t)c] = curWinF;
        if (K < 3 || !axisLatched) return;

        double lo = 0, hi = 0, base = 0;
        int winCross = 0;
        if (axis == 0) {                     // cross = natural y → work y
            lo = bv0 * ws; hi = bv1 * ws - (double)winH;
            base = owY; winCross = winH;
        } else {                             // cross = natural x → work x
            lo = bu0 * ws; hi = bu1 * ws - (double)winW;
            base = owX; winCross = winW;
        }
        if (!(hi > lo)) return;

        const double half =
            0.5 * std::max(0.0, std::min(1.0, cfg.crossSpanFrac)) * (hi - lo);
        const double step = (2.0 * half) / (double)(K - 1);
        for (int k = 0; k < K; ++k) {
            if (k == c) continue;
            const double v = std::max(lo, std::min(hi, base + (k - c) * step));
            if (axis == 0) (*owYs)[(size_t)k] = v; else (*owXs)[(size_t)k] = v;
        }
        auto xiOf = [&](int k) {
            const double oc = (axis == 0) ? (*owYs)[(size_t)k] : (*owXs)[(size_t)k];
            return (oc + 0.5 * (double)winCross) / ws * cfg.canvasScale;
        };
        const double xiC = xiOf(c);
        *xiCOut = xiC;
        const double r0 = (axis == 0) ? advY : advX;
        const double minSep = 0.15 * (double)winCross / ws * cfg.canvasScale;

        struct Pt { double xi, a, w; int k; };
        std::vector<Pt> pts;
        pts.reserve((size_t)K);
        for (int k = 0; k < K; ++k) {
            if (k == c) continue;
            const Mat33 Hw = translate(-(*owXs)[(size_t)k], -(*owYs)[(size_t)k]) *
                             scaleM(ws) * Hrect * scaleM(1.0 / ws);
            cv::Mat w8, cur;
            cv::warpPerspective(grayWork, w8, cv::Mat(Hw), cv::Size(winW, winH),
                                cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar());
            w8.convertTo(cur, CV_32F);
            (*curWins)[(size_t)k] = cur;
            if ((size_t)k >= prevWins.size()) continue;
            const cv::Mat& prev = prevWins[(size_t)k];
            if (prev.empty() || prev.size() != cur.size()) continue;
            prev.copyTo(corrPrev);
            cur.copyTo(corrCur);
            double resp = 0.0;
            const cv::Point2d sh = correlate(corrPrev, corrCur, &resp);
            if (!std::isfinite(sh.x) || !std::isfinite(sh.y)) continue;
            if (resp < cfg.minPhaseResponse) continue;
            const double aX = -((sh.x + ((*owXs)[(size_t)k] - prevWinOwX[(size_t)k])) / ws) *
                              cfg.canvasScale;
            const double aY = -((sh.y + ((*owYs)[(size_t)k] - prevWinOwY[(size_t)k])) / ws) *
                              cfg.canvasScale;
            const double aC = (axis == 0) ? aY : aX;
            const double xi = xiOf(k);
            if (std::fabs(xi - xiC) < minSep) continue;
            if (std::fabs(aC - r0) > maxAdvancePx) continue;   // the cage, per band
            pts.push_back(Pt{xi, aC, std::max(1e-3, resp), k});
            bands->push_back(CrossBand{k, xi, aC});
        }
        double num = 0.0, den = 0.0;
        for (const auto& p : pts) {
            num += p.w * (p.a - r0) * (p.xi - xiC);
            den += p.w * (p.xi - xiC) * (p.xi - xiC);
        }
        double grad = 0.0;
        if (den > 1e-9) {
            double g = num / den;
            g = std::max(-cfg.crossGradMaxPerFrame,
                         std::min(cfg.crossGradMaxPerFrame, g));
            *gradOut = g;
            grad = g;
        }
        // ── v8: THE GRADIENT-CORRECTED MULTI-WINDOW MEAN ────────────────
        // Every term is referred back to ξ_c, so a session with one usable
        // outer window is not pulled toward that window's own ξ, and with NO
        // usable outer window this is r0 exactly.  Computed unconditionally —
        // the measurements are already made and this is K multiply-adds — so
        // that Config::crossAvgWindows is a pure placement switch and never a
        // measurement switch.
        {
            double wNum = std::max(1e-3, centreResponse) * r0;
            double wDen = std::max(1e-3, centreResponse);
            for (const auto& p : pts) {
                wNum += p.w * (p.a - grad * (p.xi - xiC));
                wDen += p.w;
            }
            if (wDen > 1e-9) *avgCrossOut = wNum / wDen;
        }
    }
};

// ── Public surface ──────────────────────────────────────────────────────────

Engine::Engine() : impl_(new Impl()) {}
Engine::~Engine() = default;

bool Engine::configure(const Config& cfg, std::string* err) {
    auto fail = [&](const char* m) {
        if (err) *err = m;
        impl_->configured = false;
        return false;
    };
    if (!(cfg.canvasScale > 0.05 && cfg.canvasScale <= 1.0))
        return fail("canvasScale must be in (0.05, 1.0]");
    if (!(cfg.workScale > 0.05 && cfg.workScale <= 1.0))
        return fail("workScale must be in (0.05, 1.0]");
    if (!(cfg.stripMargin >= 1.0 && cfg.stripMargin <= 8.0))
        return fail("stripMargin must be in [1.0, 8.0]");
    if (!(cfg.minAdvancePx >= 0.0)) return fail("minAdvancePx must be >= 0");
    if (!(cfg.maxAdvancePx >= 0.0)) return fail("maxAdvancePx must be >= 0");
    if (!(cfg.maxAdvanceFrac > 0.0 && cfg.maxAdvanceFrac <= 1.0))
        return fail("maxAdvanceFrac must be in (0, 1]");
    if (!(cfg.maxSweepSpeedMps > 0.0)) return fail("maxSweepSpeedMps must be > 0");
    if (!(cfg.stallResumeResponse >= 0.0 && cfg.stallResumeResponse < 2.0))
        return fail("stallResumeResponse must be in [0, 2)");
    if (cfg.maxRejectRunFrames < 1) return fail("maxRejectRunFrames must be >= 1");
    if (!(cfg.poseSlackM >= 0.0)) return fail("poseSlackM must be >= 0");
    if (!(cfg.maxTranslationJumpM > 0.0))
        return fail("maxTranslationJumpM must be > 0");
    if (cfg.phaseWindowPx < 32) return fail("phaseWindowPx must be >= 32");
    if (cfg.corrCentroidBoxPx != 0 &&
        (cfg.corrCentroidBoxPx < 3 || cfg.corrCentroidBoxPx > 15))
        return fail("corrCentroidBoxPx must be 0 (derive) or in [3, 15]");
    if (cfg.canvasInitWidthPx < 256) return fail("canvasInitWidthPx must be >= 256");
    if (cfg.canvasMaxWidthPx < cfg.canvasInitWidthPx)
        return fail("canvasMaxWidthPx must be >= canvasInitWidthPx");
    if (cfg.canvasPadPx < 0) return fail("canvasPadPx must be >= 0");
    if (cfg.canvasMaxHeightPx < 64) return fail("canvasMaxHeightPx must be >= 64");
    if (!(cfg.canvasMaxPixels >= 1.0e6))
        return fail("canvasMaxPixels must be >= 1e6");
    if (cfg.trackingWarmupFrames < 1) return fail("trackingWarmupFrames must be >= 1");
    if (cfg.axisLatchFrames < 1) return fail("axisLatchFrames must be >= 1");
    if (cfg.axisLatchMaxFrames < cfg.axisLatchFrames)
        return fail("axisLatchMaxFrames must be >= axisLatchFrames");
    if (!(cfg.latchTotalPx > 0.0)) return fail("latchTotalPx must be > 0");
    if (!(cfg.relatchMotionPx > 0.0)) return fail("relatchMotionPx must be > 0");
    if (!(cfg.relatchCommitFrac > 0.0))
        return fail("relatchCommitFrac must be > 0");
    if (!(cfg.relatchDominance >= 1.0))
        return fail("relatchDominance must be >= 1");
    if (cfg.relatchMinFrames < 1) return fail("relatchMinFrames must be >= 1");
    if (cfg.relatchMaxCount < 0) return fail("relatchMaxCount must be >= 0");
    if (!(cfg.gainCumClamp >= 1.0)) return fail("gainCumClamp must be >= 1");
    if (!(cfg.gainStepClamp > 0.0 && cfg.gainStepClamp < 1.0))
        return fail("gainStepClamp must be in (0, 1)");
    if (!(cfg.rectifyYawLimitDeg > 0.0 && cfg.rectifyYawLimitDeg < 90.0))
        return fail("rectifyYawLimitDeg must be in (0, 90)");
    if (cfg.axisOverride < 0 || cfg.axisOverride > 2)
        return fail("axisOverride must be 0, 1 or 2");
    if (cfg.signOverride < -1 || cfg.signOverride > 1)
        return fail("signOverride must be -1, 0 or 1");
    // QUARTER TURNS ONLY.  The bake has to stay an exact transpose/flip — a
    // 37° "upright" would resample the whole deliverable and quietly cost
    // sharpness the sweep spent minutes earning.  Refusing by name beats
    // rounding: a host computing this wrong should hear about it at start,
    // not ship a slightly-blurred panorama.
    if (cfg.outputRotationCwDeg != 0 && cfg.outputRotationCwDeg != 90 &&
        cfg.outputRotationCwDeg != 180 && cfg.outputRotationCwDeg != 270)
        return fail("outputRotationCwDeg must be 0, 90, 180 or 270");
    if (cfg.projection < 0 || cfg.projection > 1)
        return fail("projection must be 0 (planar) or 1 (sweep-cylindrical)");
    if (!(cfg.sweepMaxDeg > 0.0 && cfg.sweepMaxDeg <= 179.0))
        return fail("sweepMaxDeg must be in (0, 179]");
    if (cfg.crossFitMode < 1 || cfg.crossFitMode > 2)
        return fail("crossFitMode must be 1 (image gradient) or 2 (plane)");
    if (cfg.crossTraj < 0 || cfg.crossTraj > 2)
        return fail("crossTraj must be 0 (off), 1 (chain) or 2 (overlap)");
    if (!(cfg.crossTrajWindowPx >= 8.0))
        return fail("crossTrajWindowPx must be >= 8");
    if (!(cfg.crossTrajRelaxPx >= 0.0))
        return fail("crossTrajRelaxPx must be >= 0 (0 = no relax)");
    if (cfg.d8JogGuard && !cfg.seamMetrics)
        return fail("d8JogGuard requires seamMetrics: with metrics off the "
                    "jog measurement silently returns invalid and the guard "
                    "would be a no-op that LOOKS armed");
    if (cfg.d8JogGuard && !(cfg.d8JogBarPx >= 1.0 && cfg.d8JogBarPx <= 64.0))
        return fail("d8JogBarPx must be in [1, 64]");
    if (cfg.d8JogGuard && (cfg.d8JogMaxRun < 1 || cfg.d8JogMaxRun > 30))
        return fail("d8JogMaxRun must be in [1, 30]");
    // THE SEED JUNCTION.  Same refusal shape as d8JogGuard above: a mode that
    // LOOKS armed and cannot fire is refused by name.  The hole this closes is
    // gapPx = du·(1 − stripMargin/2), so at stripMargin >= 2 it is identically
    // <= 0 — the first strip's left edge is already at or behind the seed's
    // frontier, there is nothing to meet, and an operator reading `on` in a
    // pack's config block would be reading a no-op.
    if (cfg.seedFrontierMeet && !(cfg.stripMargin < 2.0))
        return fail("seedFrontierMeet requires stripMargin < 2: at 2 or above "
                    "the seed junction's gap is identically zero "
                    "(gapPx = du*(1 - stripMargin/2)) and the knob would LOOK "
                    "armed and never fire");
    // ── the low-light registration gate (2026-09-07) ────────────────────
    if (cfg.crossResidualGate < 0 || cfg.crossResidualGate > 2)
        return fail("crossResidualGate must be 0 (off), 1 (log-only) or 2 (gate)");
    if (cfg.crossPeriodGuard < 0 || cfg.crossPeriodGuard > 1)
        return fail("crossPeriodGuard must be 0 or 1");
    // The d8JogGuard rule: a mode that LOOKS armed and cannot fire is refused
    // by name.  Gate mode needs at least one live test; the period guard needs
    // gate mode (it zeroes through the same path) and at least one live
    // threshold of its own.
    if (cfg.crossResidualGate == 2 && !(cfg.crossTextureMinVar > 0.0) &&
        !(cfg.crossPeakMinPSR > 0.0) && !(cfg.crossPeakMinMass > 0.0) &&
        cfg.crossPeriodGuard == 0)
        return fail("crossResidualGate 2 (gate) with crossTextureMinVar, "
                    "crossPeakMinPSR and crossPeakMinMass all 0 and no period "
                    "guard is a gate that LOOKS armed and can never fire — set a "
                    "threshold, or use 1 (log-only)");
    if (cfg.crossPeriodGuard == 1 && cfg.crossResidualGate != 2)
        return fail("crossPeriodGuard requires crossResidualGate 2 (gate): off "
                    "or log-only it would be a guard that LOOKS armed and only "
                    "logs");
    if (cfg.crossPeriodGuard == 1 && !(cfg.crossPeriodMaxFrac > 0.0) &&
        !(cfg.crossPeakSecondaryFrac > 0.0))
        return fail("crossPeriodGuard 1 with crossPeriodMaxFrac and "
                    "crossPeakSecondaryFrac both 0 is a guard that LOOKS armed "
                    "and can never fire");
    if (!(cfg.crossTextureMinVar >= 0.0)) return fail("crossTextureMinVar must be >= 0");
    if (!(cfg.crossPeakMinPSR >= 0.0)) return fail("crossPeakMinPSR must be >= 0");
    if (!(cfg.crossPeakMinMass >= 0.0 && cfg.crossPeakMinMass <= 1.0))
        return fail("crossPeakMinMass must be in [0, 1]");
    if (!(cfg.crossPeriodMaxFrac >= 0.0)) return fail("crossPeriodMaxFrac must be >= 0");
    if (!(cfg.crossPeakSecondaryFrac >= 0.0 && cfg.crossPeakSecondaryFrac <= 1.0))
        return fail("crossPeakSecondaryFrac must be in [0, 1]");
    if (cfg.crossWindows < 1 || cfg.crossWindows > 9)
        return fail("crossWindows must be in [1, 9]");
    if ((cfg.crossWindows % 2) == 0)
        return fail("crossWindows must be ODD (an even value silently "
                    "collapses to 1 and disables the cut metric)");
    if (!(cfg.crossSpanFrac > 0.0 && cfg.crossSpanFrac <= 1.0))
        return fail("crossSpanFrac must be in (0, 1]");
    if (!(cfg.crossGradMaxPerFrame > 0.0 && cfg.crossGradMaxPerFrame <= 0.5))
        return fail("crossGradMaxPerFrame must be in (0, 0.5]");
    if (!(cfg.crossScaleCageFrac > 0.0 && cfg.crossScaleCageFrac <= 2.0))
        return fail("crossScaleCageFrac must be in (0, 2]");
    if (!(cfg.subjectDistanceM >= 0.05 && cfg.subjectDistanceM <= 100.0))
        return fail("subjectDistanceM must be in [0.05, 100]");
    if (!(cfg.gainLeak >= 0.0 && cfg.gainLeak < 1.0))
        return fail("gainLeak must be in [0, 1)");
    // ── v6 ──────────────────────────────────────────────────────────────
    if (!(cfg.exposureGainClamp >= 1.0 && cfg.exposureGainClamp <= 64.0))
        return fail("exposureGainClamp must be in [1, 64]");
    if (cfg.photoMinSamples < 64)
        return fail("photoMinSamples must be >= 64");
    if (!(cfg.photoGradMaxDN > 0.0 && cfg.photoGradMaxDN <= 255.0))
        return fail("photoGradMaxDN must be in (0, 255]");
    if (!(cfg.photoUniformMinFrac > 0.0 && cfg.photoUniformMinFrac <= 1.0))
        return fail("photoUniformMinFrac must be in (0, 1]");
    if (cfg.photoUniformBands < 2 || cfg.photoUniformBands > 32)
        return fail("photoUniformBands must be in [2, 32]");
    if (cfg.photoLocalWindowPx < 2)
        return fail("photoLocalWindowPx must be >= 2");
    // ── v10 ─────────────────────────────────────────────────────────────
    if (!(cfg.lensFocalTolFrac > 0.0 && cfg.lensFocalTolFrac < 1.0))
        return fail("lensFocalTolFrac must be in (0, 1)");
    if (cfg.lensLutNodes < 16 || cfg.lensLutNodes > 65536)
        return fail("lensLutNodes must be in [16, 65536]");

    reset();
    impl_->cfg = cfg;
    // The DEVICE-level half of the gate, decided now so a session that never
    // latches a reference still reports a verdict rather than "disabled".  The
    // reference latch re-runs it with the frame's own intrinsics, which is
    // where the focal half is decided.
    impl_->lensDec = lens::resolve(cfg, 0.0, 0);
    impl_->configured = true;
    if (err) err->clear();
    return true;
}

void Engine::reset() {
    Config keep = impl_->cfg;
    const bool wasConfigured = impl_->configured;
    impl_.reset(new Impl());
    impl_->cfg = keep;
    impl_->configured = wasConfigured;
    // v10 — a reset session keeps its device-level lens verdict; the focal
    // half is re-decided at the next reference latch.
    if (wasConfigured) impl_->lensDec = lens::resolve(keep, 0.0, 0);
}

void Engine::abort(const std::string& reason) {
    if (impl_->aborted) return;
    impl_->aborted = true;
    impl_->abortReason = reason;
    impl_->st.abortReason = reason;
}

FrameOutcome Engine::ingest(const FrameInput& in) {
    Impl& S = *impl_;
    const double t0 = nowMs();

    FrameOutcome row;
    row.seq = in.seq;
    row.tsNs = in.tsNs;
    row.gainCum = S.gainCum;
    row.highWater = S.highWater;

    auto finishRow = [&](Outcome o) {
        row.outcome = o;
        row.stalled = S.stalled;
        row.gainCum = S.gainCum;
        row.highWater = S.highWater;
        row.vShiftPx = S.vShiftTotal;
        row.engineMs = nowMs() - t0;
        S.countOutcome(o);
        return row;
    };

    if (!S.configured) return finishRow(Outcome::RejectedInput);
    if (S.aborted) return finishRow(Outcome::AbortedTracking);

    // ── Input validation (a malformed frame is ledgered, never trusted) ─────
    if (in.bgr == nullptr || in.grayWork == nullptr ||
        in.bgr->empty() || in.grayWork->empty() ||
        in.bgr->type() != CV_8UC3 || in.grayWork->type() != CV_8UC1 ||
        in.imageWidth <= 0 || in.imageHeight <= 0 ||
        in.bgr->cols != in.imageWidth || in.bgr->rows != in.imageHeight ||
        !(in.fx > 1.0) || !(in.fy > 1.0) ||
        !std::isfinite(in.cx) || !std::isfinite(in.cy) ||
        !std::isfinite(in.tsNs)) {
        return finishRow(Outcome::RejectedInput);
    }
    // grayWork MUST be the frame downscaled by exactly Config::workScale — the
    // advance is scaled back up by 1/workScale, so a caller that resized by a
    // different factor would produce a plausible-looking but wrong advance on
    // every single frame.  Refuse instead of trusting it.
    {
        const int wantW = (int)std::lround(in.imageWidth * S.cfg.workScale);
        const int wantH = (int)std::lround(in.imageHeight * S.cfg.workScale);
        if (std::abs(in.grayWork->cols - wantW) > 2 ||
            std::abs(in.grayWork->rows - wantH) > 2) {
            return finishRow(Outcome::RejectedInput);
        }
        if (wantW < 64 || wantH < 48) return finishRow(Outcome::RejectedInput);
    }
    ++S.st.seen;

    // ── v6: THE FRAME'S EXACT RADIOMETRIC FACTOR ────────────────────────────
    // Computed ONCE per validated frame — including rejected ones — so the
    // pack's exposure trace covers the whole sweep and can answer "did the
    // capture-side AE lock actually hold?" from data rather than from the
    // lock's own return value.
    S.curExpGain = S.exposureGainFor(in);
    row.expDurationS = in.exposureDurationS;
    row.expISO       = in.exposureISO;
    row.expGain      = S.curExpGain;
    S.noteArExposure(in);

    // ── Session-lifecycle discontinuities (see the header's abort note) ─────
    //
    // A timestamp that does not ADVANCE is two different events wearing one
    // name, and treating them alike cost the operator two of three sweeps on
    // 2026-08-30 ("Sweep stopped — nonmonotonic timestamp", on a session also
    // dropping 77 and 59 pack writes):
    //
    //   · dt == 0, or a SMALL negative dt — the same frame delivered twice, or
    //     a reordering under delivery pressure.  Benign.  The frame carries no
    //     new information, so SKIP it and count it.  Killing a sweep for a
    //     repeat frame throws away everything already painted.
    //   · a LARGE negative dt — ARKit was re-run and handed us a new timebase.
    //     Fusing two clocks into one chain is the failure the abort exists for,
    //     and it stays fatal.
    //
    // The bound is deliberately generous: a real reordering is sub-frame, and a
    // new session timebase is orders of magnitude away, so nothing sits near it.
    if (S.haveTs && in.tsNs <= S.lastTsNs) {
        const int64_t backNs = S.lastTsNs - in.tsNs;   // >= 0 here
        if (backNs > kTimebaseResetNs) {
            abort("nonmonotonic-timestamp");
            return finishRow(Outcome::AbortedTracking);
        }
        ++S.st.skippedNonmonotonicTs;
        return finishRow(Outcome::RejectedInput);
    }
    const double dtSec = S.haveTs ? (in.tsNs - S.lastTsNs) * 1e-9 : 0.0;
    S.haveTs = true;
    S.lastTsNs = in.tsNs;

    try {
        // ── Reference latch ────────────────────────────────────────────────
        if (!S.refLatched) {
            if (in.tracking != 2) { S.warm = 0; return finishRow(Outcome::WarmingUp); }
            if (++S.warm < S.cfg.trackingWarmupFrames)
                return finishRow(Outcome::WarmingUp);

            S.R0 = quatToR(in.q);
            for (int k = 0; k < 4; ++k) S.refQuat[k] = in.q[k];
            S.refFx = in.fx; S.refFy = in.fy; S.refCx = in.cx; S.refCy = in.cy;
            S.imgW = in.imageWidth; S.imgH = in.imageHeight;
            // v6 — THE EXPOSURE DATUM.  Every other frame is normalised to
            // THIS frame's exposure, which is also the frame the bootstrap
            // lead-in is painted from: reference geometry and reference
            // photometry are the same frame, by construction.
            {
                const double e = in.exposureDurationS * in.exposureISO;
                S.refExposure = (e > 0.0 && std::isfinite(e)) ? e : 0.0;
            }
            S.curExpGain = 1.0;
            S.lastExpGain = 1.0;
            S.curExpResidual = 1.0;
            S.lastExpResidual = 1.0;
            row.expGain = 1.0;
            S.maxAdvancePx = S.cfg.maxAdvancePx > 0.0
                ? S.cfg.maxAdvancePx
                : S.cfg.maxAdvanceFrac * (double)S.imgW * S.cfg.canvasScale;

            // The reference frame's H_rect is the identity by construction,
            // so its natural-frame position is its own scaled centre.  Both
            // latch channels are measured against this datum.
            S.natRefX = S.cfg.canvasScale * 0.5 * (double)S.imgW;
            S.natRefY = S.cfg.canvasScale * 0.5 * (double)S.imgH;
            S.prevCrX = 0.5 * (double)S.imgW;
            S.prevCrY = 0.5 * (double)S.imgH;

            S.onesMask = cv::Mat(S.imgH, S.imgW, CV_8UC1, cv::Scalar(255));
            // CLONE, not a shallow reference: this one frame is held across the
            // axis-latch window and is the bootstrap lead-in's pixels.  One
            // 4-5 MB copy per SESSION is free; the per-frame `lastBgr` below
            // stays shallow (see FrameInput's contract).
            S.refBgr = in.bgr->clone();
            for (int k = 0; k < 3; ++k) S.lastT[k] = in.t[k];
            // v5: the plane prior is measured against THIS pose and THIS
            // optical axis.  GL camera forward is −Z of the camera frame, so
            // the world-frame forward direction is −R0's third column.
            for (int k = 0; k < 3; ++k) {
                S.refT[k] = in.t[k];
                S.fwdRef[k] = -S.R0(k, 2);
            }
            S.curK[0] = S.refFx; S.curK[1] = S.refFy;
            S.curK[2] = S.refCx; S.curK[3] = S.refCy;
            for (int k = 0; k < 4; ++k) S.lastK[k] = S.curK[k];

            // ── v10: THE LENS GATE, on the reference frame's own numbers ──
            S.resolveLens(in.fx, in.imageWidth);

            // Registration window: phaseWindowPx is in SOURCE px.
            const double ws = S.cfg.workScale;
            int ww = (int)std::lround(S.cfg.phaseWindowPx * ws);
            int wh = (int)std::lround(S.cfg.phaseWindowPx * ws *
                                      (double)S.imgH / (double)S.imgW);
            // Never larger than the work raster itself (a window overhanging
            // the frame correlates mostly border, not content).
            ww = std::min(ww, (int)(S.imgW * ws));
            wh = std::min(wh, (int)(S.imgH * ws));
            ww = std::max(32, ww); wh = std::max(32, wh);
            ww -= (ww & 1); wh -= (wh & 1);
            S.winW = ww; S.winH = wh;
            cv::createHanningWindow(S.hann, cv::Size(S.winW, S.winH), CV_32F);
            S.corrCentroidBox = (S.cfg.corrCentroidBoxPx > 0)
                                    ? (S.cfg.corrCentroidBoxPx | 1)
                                    : detail::centroidBoxFor(S.cfg.workScale);

            // Clamp the cage to what the correlation window can HONESTLY see.
            // Beyond ~0.4·winW the peak wraps circularly and the measurement
            // is a plausible-looking lie; a cage wider than that would be a
            // filter, not a search bound.
            const double corrLimitPx =
                0.40 * (double)S.winW / ws * S.cfg.canvasScale;
            S.maxAdvancePx = std::min(S.maxAdvancePx, corrLimitPx);

            // Reference frame's own window (H_rect == I by construction).
            const double cxw = 0.5 * S.imgW * ws, cyw = 0.5 * S.imgH * ws;
            S.prevOwX = cxw - 0.5 * S.winW;
            S.prevOwY = cyw - 0.5 * S.winH;
            cv::Mat win8;
            const Mat33 Hwin = translate(-S.prevOwX, -S.prevOwY);
            cv::warpPerspective(*in.grayWork, win8, cv::Mat(Hwin),
                                cv::Size(S.winW, S.winH), cv::INTER_LINEAR,
                                cv::BORDER_CONSTANT, cv::Scalar());
            win8.convertTo(S.prevWinF, CV_32F);
            S.resetCrossWindows();

            S.refLatched = true;
            S.st.referenceLatched = true;
            return finishRow(Outcome::Bootstrap);
        }

        // ── Post-latch discontinuity guards ────────────────────────────────
        if (in.imageWidth != S.imgW || in.imageHeight != S.imgH) {
            abort("format-change");
            return finishRow(Outcome::AbortedTracking);
        }
        if (in.tracking == 1) {
            // ARKit `.limited`.  Counted, NOT fatal: `.limited(.excessiveMotion)`
            // fires during exactly the deliberate pan pano+ asks for, and
            // `.limited(.relocalizing)` after any brief occlusion — while the
            // attitude this engine consumes stays gyro-driven and good.  The
            // one thing relocalisation really threatens (a translation
            // discontinuity) is caught by maxTranslationJumpM just below.
            ++S.st.limitedFrames;
            if (S.cfg.abortOnLimitedTracking) {
                abort("tracking-limited");
                return finishRow(Outcome::AbortedTracking);
            }
        } else if (in.tracking != 2) {
            // notAvailable — there is no attitude to rectify with.  HOLD the
            // chain (never advance it on a pose we do not believe) and abort
            // only if it never comes back.
            S.poseStale = true;
            if (S.noteRejection()) {
                abort("tracking-lost");
                return finishRow(Outcome::AbortedTracking);
            }
            return finishRow(Outcome::RejectedTracking);
        }

        double poseStepM = 0.0;
        if (S.poseStale) {
            // First usable pose after a tracking outage.  `lastT` was frozen
            // through the outage on purpose, so measuring a step across it
            // would read as a teleport and abort a sweep that merely blinked.
            // Re-seed instead, and skip both pose gates for this one frame.
            S.poseStale = false;
        } else {
            const double dx = in.t[0] - S.lastT[0];
            const double dy = in.t[1] - S.lastT[1];
            const double dz = in.t[2] - S.lastT[2];
            poseStepM = std::sqrt(dx * dx + dy * dy + dz * dz);
            if (poseStepM > S.cfg.maxTranslationJumpM) {
                // A single-frame translation this large is not motion; it is
                // ARKit relocalising onto a NEW world origin (RNSARSession's
                // stop/start runs with .resetTracking).  Fusing two coordinate
                // frames into one canvas is the failure this abort exists for.
                abort("session-restart");
                return finishRow(Outcome::AbortedTracking);
            }
        }
        // lastT advances on EVERY post-latch frame with a believable pose, so
        // the restart test above stays a true single-frame discontinuity test
        // even across a run of rejected frames.
        for (int k = 0; k < 3; ++k) S.lastT[k] = in.t[k];

        // ── POSE-SIDE CAGE ─────────────────────────────────────────────────
        // Image-independent bound on how far the scene can have moved.  This
        // is the gate that catches a lurch big enough to WRAP the correlation
        // window — such a displacement comes back MEASURED SMALL, so the
        // measured-advance cage below can never see it.
        if (dtSec > 0.0 &&
            poseStepM > S.cfg.maxSweepSpeedMps * dtSec + S.cfg.poseSlackM) {
            if (S.noteRejection()) {
                abort("chain-lost");
                return finishRow(Outcome::AbortedTracking);
            }
            return finishRow(Outcome::RejectedPoseSpeed);
        }

        // ── 1. RECTIFY ─────────────────────────────────────────────────────
        const Mat33 Ri = quatToR(in.q);
        const Mat33 dR_gl = S.R0.t() * Ri;                 // cam_0 ← cam_i (GL)
        const double rectDeg = rotationAngleDeg(dR_gl);
        row.rectifyDeg = rectDeg;
        S.maxRectifyDeg = std::max(S.maxRectifyDeg, rectDeg);

        // ATTITUDE-EXCURSION GATE — enforced in BOTH arms.  Scoping it to
        // `rectify == true` (as the first cut did) meant the control arm had
        // no excursion gate and could never produce RejectedRectify or its
        // chain-lost abort: the two arms would then differ in more than the
        // hypothesis, and the A/B would not be a controlled experiment.
        // ── v5: SPLIT THE EXCURSION AT THE SWEEP AXIS ──────────────────
        // ψ is the component ABOUT the latched sweep axis; R_cross is
        // everything else.  ψ is identically 0 pre-latch, in the planar arm,
        // in the rectify == false control arm and on a pure translation
        // sweep — and every line from here on is then v4 verbatim.
        const Mat33 F(1, 0, 0, 0, -1, 0, 0, 0, -1);
        const Mat33 dR_cv = F * dR_gl * F;                 // cam_0 ← cam_i (CV)
        double psi = 0.0;
        Mat33 dR_use = dR_cv;
        // Computed in BOTH A/B arms, deliberately.  The gate below reads
        // `crossDeg`, so scoping the split to `rectify == true` would leave
        // the control arm gating on a different quantity and the two arms
        // would reject different frames — an experiment whose arms differ in
        // more than the hypothesis.  Only the HOMOGRAPHY is arm-dependent.
        if (S.cfg.projection == 1 && S.axisLatched) {
            psi = sweepAngle(S.axis, dR_cv);
            dR_use = sweepRotation(S.axis, psi).t() * dR_cv;
            if (!S.projectionSwitched) {
                S.projectionSwitched = true;
                S.projectionSwitchSeq = in.seq;
                // The one-frame placement step the law change causes:
                // f·(tan ψ − ψ) reference-plane px, in canvas units.
                const double f = (S.axis == 0) ? S.refFx : S.refFy;
                S.projectionSwitchStepPx =
                    std::fabs(f * (std::tan(psi) - psi)) * S.cfg.canvasScale;
            }
        }
        const double crossDeg = rotationAngleDeg(dR_use);
        row.psiDeg = psi * 180.0 / CV_PI;
        row.crossRectifyDeg = crossDeg;
        S.maxCrossRectifyDeg = std::max(S.maxCrossRectifyDeg, crossDeg);
        S.minPsiDeg = std::min(S.minPsiDeg, row.psiDeg);
        S.maxPsiDeg = std::max(S.maxPsiDeg, row.psiDeg);

        // THE EXCURSION GATE now bounds what the HOMOGRAPHY carries (the
        // cross part) and the sweep is bounded separately by sweepMaxDeg.
        // With ψ == 0, crossDeg == rectDeg exactly, so this is v4's gate
        // unchanged in every v4-equivalent situation — and v5 can paint a
        // pivot past rectifyYawLimitDeg that v4 structurally refused.
        if (crossDeg > S.cfg.rectifyYawLimitDeg ||
            std::fabs(row.psiDeg) > S.cfg.sweepMaxDeg) {
            if (S.noteRejection()) {
                abort("chain-lost");
                return finishRow(Outcome::AbortedTracking);
            }
            return finishRow(Outcome::RejectedRectify);
        }

        Mat33 Hrect = Mat33::eye();
        if (S.cfg.rectify) {
            Hrect = kMat(S.refFx, S.refFy, S.refCx, S.refCy) * dR_use *
                    kInv(in.fx, in.fy, in.cx, in.cy);
            if (psi != 0.0) {
                // THE ARC.  The sweep component was taken OUT of the rotation,
                // so it goes back in as a TRANSLATION of f·ψ reference-plane
                // px — arc length instead of the tangent f·tan(ψ) that v4
                // carries.  Folding it into H_rect (rather than adding it to
                // the placement afterwards) is load-bearing: the correlation
                // window, `crx/cry`, the footprint bounds and the strip
                // geometry ALL derive from this one matrix, so a pure sweep
                // leaves world content STATIONARY in the registration raster —
                // exactly the property v4's rectification has.  Bolting the
                // arc on after the correlation destroys it: the correlation
                // then re-measures the sweep the pose already supplied and the
                // panorama is painted at 2× the true advance (measured:
                // duplicated shelf objects on pack 15-59-29).
                const double arcSrc = (S.axis == 0 ? S.refFx : S.refFy) * psi;
                Hrect = (S.axis == 0 ? translate(arcSrc, 0.0)
                                     : translate(0.0, arcSrc)) * Hrect;
            }
        }
        // The rectified footprint, needed TWICE: as the degeneracy guard (an
        // inverted or exploded footprint means the planar model has broken
        // down — reject rather than paint garbage) and as the clamp bound for
        // the correlation window below.  In the control arm H_rect is the
        // identity, so this is just the frame rect and can never trip.
        double bu0, bu1, bv0, bv1;
        if (!mapBounds(Hrect, S.imgW, S.imgH, &bu0, &bu1, &bv0, &bv1) ||
            (bu1 - bu0) < 0.25 * S.imgW || (bu1 - bu0) > 8.0 * S.imgW ||
            (bv1 - bv0) < 0.25 * S.imgH || (bv1 - bv0) > 8.0 * S.imgH) {
            return finishRow(Outcome::RejectedRectify);
        }

        // ── 2. ADVANCE (window-origin compensated phase correlation) ───────
        const double ws = S.cfg.workScale;
        double crx = 0.5 * S.imgW, cry = 0.5 * S.imgH;
        if (!mapPoint(Hrect, 0.5 * S.imgW, 0.5 * S.imgH, &crx, &cry))
            return finishRow(Outcome::RejectedRectify);
        double owX = crx * ws - 0.5 * S.winW;
        double owY = cry * ws - 0.5 * S.winH;
        // CLAMP the window into the RECTIFIED footprint.  Rectification moves
        // the frame centre by fx·tan(θ) (≈510 px at 20° yaw on a 1440 px
        // raster), so a window pinned to that centre walks off the raster
        // well before rectifyYawLimitDeg and starts correlating BORDER_CONSTANT
        // black — which surfaced as spurious rejected-low-response AND
        // held-backtrack rows, the second of which also pollutes the reversal
        // statistic the residual analysis reads.  The advance is
        // origin-COMPENSATED below, so any window placement inside the
        // footprint is equally valid; clamping strictly increases the real
        // content the correlation sees.
        // `owClamped` is recorded, not acted on: it is the PRECONDITION of the
        // attitude-cancellation identity (see
        // SessionStats::corrOriginClampedFrames).  Counted only once the frame
        // is ACCEPTED, further down — a rejected frame never reached the chain,
        // so counting it here would overstate how much of the sweep ran outside
        // the identity's regime.
        bool owClamped = false;
        {
            const double owXraw = owX, owYraw = owY;
            const double lo = bu0 * ws, hi = bu1 * ws - (double)S.winW;
            owX = (hi > lo) ? std::max(lo, std::min(hi, owX)) : 0.5 * (lo + hi);
            const double loY = bv0 * ws, hiY = bv1 * ws - (double)S.winH;
            owY = (hiY > loY) ? std::max(loY, std::min(hiY, owY)) : 0.5 * (loY + hiY);
            owClamped = (std::fabs(owX - owXraw) > 1e-9 ||
                         std::fabs(owY - owYraw) > 1e-9);
        }

        // work_i → work-rectified window:  T(-ow) · S(ws) · H_rect · S(1/ws)
        const Mat33 Hwin = translate(-owX, -owY) * scaleM(ws) * Hrect * scaleM(1.0 / ws);
        cv::Mat win8, curWinF;
        cv::warpPerspective(*in.grayWork, win8, cv::Mat(Hwin),
                            cv::Size(S.winW, S.winH), cv::INTER_LINEAR,
                            cv::BORDER_CONSTANT, cv::Scalar());
        win8.convertTo(curWinF, CV_32F);

        // ATTITUDE CHANNEL — the rotation-derived step across the SAME
        // interval the correlation below measures.  Computed before the
        // accept/reject decision so a held frame still ledgers what its
        // attitude said (which is how a rejection run stays diagnosable).
        const double dRotX = S.cfg.canvasScale * (crx - S.prevCrX);
        const double dRotY = S.cfg.canvasScale * (cry - S.prevCrY);
        row.advanceRotX = dRotX;
        row.advanceRotY = dRotY;
        // Seed the SUM here so the identity advanceTot == advanceRot + advance
        // holds on every row from this point on, including the rows the
        // response floor and the cage reject below.  Those rows keep
        // advance == 0 (the residual was never applied to the chain) and
        // advanceTot == advanceRot, which is the honest statement "attitude is
        // all we know about this frame" — not the broken identity that
        // publishing advanceTot == 0 beside a non-zero advanceRot would be.
        row.advanceTotX = dRotX;
        row.advanceTotY = dRotY;

        double response = 0.0;
        // COPIES, not the buffers themselves: cv::phaseCorrelate multiplies
        // both inputs by the window IN PLACE when no DFT padding is needed
        // (getOptimalDFTSize(192) == 192 and (144) == 144, so the default
        // window hits that path exactly).  See Impl::corrPrev.
        S.prevWinF.copyTo(S.corrPrev);
        curWinF.copyTo(S.corrCur);
        const cv::Point2d shift = S.correlate(S.corrPrev, S.corrCur, &response);
        row.response = response;
        // ── LOW-LIGHT REGISTRATION GATE — the instrument (log-only) ────────
        // On the PRISTINE windows (prevWinF / curWinF — the correlation above
        // saw copies), so nothing the shipped estimator read is touched, and
        // BEFORE the response floor so a rejected row carries the statistics
        // that explain it.  With the knob at 0 this block does not run and
        // the row is the v15 row.  See Config's gate block for definitions.
        if (S.cfg.crossResidualGate >= 1) {
            const bool crossIsX = (S.axis != 0);
            row.crossStatsComputed = true;
            row.crossTextureVar = detail::laplacianVariance(curWinF);
            const double periodWork = detail::dominantPeriodPx(curWinF, crossIsX);
            row.crossDominantPeriodPx = std::isfinite(periodWork)
                                            ? periodWork / ws * S.cfg.canvasScale
                                            : periodWork;
            double ps[3];
            detail::phasePeakStats(S.prevWinF, curWinF, S.hann, S.corrCentroidBox,
                                   crossIsX,
                                   std::isfinite(periodWork) ? 0.5 * periodWork : 0.0,
                                   ps);
            row.crossPeakPSR = ps[0];
            row.crossPeakMass = ps[1];
            row.crossPeakSecondary = ps[2];
        }
        // While the chain is HELD the reference window is stale, so a wrapped
        // (aliased) correlation becomes possible — demand a materially
        // stronger peak before trusting a resume.  See Config's stale-chain
        // note; this is the cage's "never resume on a lie" rule.
        const double responseFloor =
            S.stallCount > 0 ? std::max(S.cfg.minPhaseResponse,
                                        S.cfg.stallResumeResponse)
                             : S.cfg.minPhaseResponse;
        if (!std::isfinite(shift.x) || !std::isfinite(shift.y) ||
            response < responseFloor) {
            if (S.noteRejection()) {
                abort("chain-lost");
                return finishRow(Outcome::AbortedTracking);
            }
            return finishRow(Outcome::RejectedLowResponse);
        }

        // Content displacement in RECTIFIED source px, corrected for the fact
        // that the two windows sit at different origins in that raster.
        const double sxFull = (shift.x + (owX - S.prevOwX)) / ws;
        const double syFull = (shift.y + (owY - S.prevOwY)) / ws;
        // Frame POSITION advance is the negative of the content displacement.
        // `advX/advY` are what the chain APPLIES; below the cage the gate
        // (crossResidualGate == 2) may zero the cross one.  Off and log-only
        // never reassign them, so every reader below sees the measurement.
        double advX = -sxFull * S.cfg.canvasScale;
        double advY = -syFull * S.cfg.canvasScale;
        row.advanceX = advX;
        row.advanceY = advY;
        row.advanceTotX = dRotX + advX;
        row.advanceTotY = dRotY + advY;
        // The gate's raw cross residual: the component the chain update
        // reads (advY for axis 0, advX for axis 1), before any gating — in
        // log-only mode identical to the applied one.
        if (S.cfg.crossResidualGate >= 1)
            row.crossResidualRawPx = (S.axis == 0) ? advY : advX;

        // ── THE ALIASING CAGE — reject, never widen the search ─────────────
        // TWO bounds, same limit, different reasons — and the second is what
        // keeps the interior-gap proof true:
        //
        //   RESIDUAL  a correlation shift past ~0.40·winW has wrapped, so the
        //             measurement is a plausible-looking lie.
        //   TOTAL     `du` — the quantity the strip geometry and the gap rule
        //             actually consume — is the SUM of both channels.  Caging
        //             only the residual left the ATTITUDE channel with no
        //             per-frame rate gate at all, so a single-frame rotation
        //             step could open an interior hole that
        //             PanoGap.TheClampedCageMakesInteriorGapsUnreachable
        //             claims is unreachable.  maxAdvancePx is ≤ 0.40 of the
        //             footprint, so this bound is ~6° of pitch per frame at a
        //             1400 px focal — far outside any real gesture, and far
        //             inside the half-footprint that would gap.
        const double mag = std::sqrt(advX * advX + advY * advY);
        const double totMagStep = std::hypot(row.advanceTotX, row.advanceTotY);
        if (mag > S.maxAdvancePx || totMagStep > S.maxAdvancePx) {
            if (S.noteRejection()) {
                abort("chain-lost");
                return finishRow(Outcome::AbortedTracking);
            }
            return finishRow(Outcome::RejectedOutOfCage);
        }
        S.stallCount = 0;
        S.stalled = false;

        // ── LOW-LIGHT REGISTRATION GATE — the gate (mode 2) ────────────────
        // Applied to the MEASURED CROSS RESIDUAL ONLY (advY on axis 0, advX
        // on axis 1); the along-axis component is left exactly as measured.
        // Sits AFTER the response floor and the cage — both judge the
        // MEASUREMENT (a wrapped correlation is a lie whether or not its
        // cross half is then dropped), so the reject population is the
        // shipped one — and BEFORE the accumulators and the chain update.
        // It is a PLACEMENT decision, never a MEASUREMENT one: crossMeasure
        // below still reads the MEASURED residual as its `r0`, so the outer
        // windows' gradient fit, the per-band cage and the K-window mean are
        // the log-only engine's bit for bit on the same frame (the first arm
        // handed it the gated 0, which referred the fit to zero — 127 of
        // 2719 gated corpus rows moved crossGrad, max |Δg| 5.79e-06 — and,
        // with Config::crossAvgWindows on, let the chain walk on the outer
        // bands' UNGATED residual while the row said advanceX = 0; review
        // finding 1, 2026-09-07).  On a gated frame the chain applies the
        // gated value whichever placement switch is on: the K-window mean is
        // overridden to it after crossMeasure, so crossAvgDeltaPx reads
        // exactly 0 there and the row's advanceTot == advanceRot is true OF
        // THE CHAIN (PanoCrossGate.GatedFrameIsAttitudePlacedWithAvgWindowsOn
        // / GateLeavesTheOuterFitOnTheMeasurement).
        // Only once the axis is LATCHED: before the
        // latch the chain applies both components and "the cross axis" is
        // not yet a fact about this sweep.  A gated frame keeps its outcome,
        // still advances the chain, and still reaches the d8 jog guard on
        // its attitude placement (design (e)); it changes neither
        // `chainAdvanced` nor the guard's eligibility.
        //
        // Reasons (bitmask, one row may carry several, each counter counts
        // its own bit): 1 texture (crossTextureVar < crossTextureMinVar),
        // 2 peak (crossPeakPSR < crossPeakMinPSR OR crossPeakMass <
        // crossPeakMinMass), 4 periodicity (crossPeriodGuard: |measured
        // cross step − attitude cross prediction| > crossPeriodMaxFrac ×
        // crossDominantPeriodPx, OR crossPeakSecondary ≥
        // crossPeakSecondaryFrac).  The measured cross step is advanceRot +
        // advance and the attitude's prediction of it is advanceRot, so the
        // deviation the N× rule compares is the residual itself — the test
        // is referred to the ATTITUDE, never to zero: a one-period step the
        // attitude predicted has a residual near 0 and passes (Risk 2).  A
        // threshold at 0 disarms that test.  A non-finite statistic fails
        // CLOSED (gates) — never a NaN into the chain.
        // The measurement, kept for crossMeasure's `r0` whatever the gate does.
        const double advXMeas = advX, advYMeas = advY;
        bool crossGatedNow = false;
        if (S.cfg.crossResidualGate == 2 && S.axisLatched) {
            const bool crossIsX = (S.axis != 0);
            const double advCrossMeas = crossIsX ? advX : advY;
            int reason = 0;
            if (S.cfg.crossTextureMinVar > 0.0 &&
                !(row.crossTextureVar >= S.cfg.crossTextureMinVar))
                reason |= 1;
            if (S.cfg.crossPeakMinPSR > 0.0 &&
                !(row.crossPeakPSR >= S.cfg.crossPeakMinPSR))
                reason |= 2;
            if (S.cfg.crossPeakMinMass > 0.0 &&
                !(row.crossPeakMass >= S.cfg.crossPeakMinMass))
                reason |= 2;
            if (S.cfg.crossPeriodGuard == 1) {
                if (S.cfg.crossPeriodMaxFrac > 0.0) {
                    const double period = row.crossDominantPeriodPx;
                    const double deviationFromAttitude = std::fabs(advCrossMeas);
                    if (!std::isfinite(period) || !(period > 0.0) ||
                        !(deviationFromAttitude <= S.cfg.crossPeriodMaxFrac * period))
                        reason |= 4;
                }
                if (S.cfg.crossPeakSecondaryFrac > 0.0 &&
                    !(row.crossPeakSecondary < S.cfg.crossPeakSecondaryFrac))
                    reason |= 4;
            }
            if (reason != 0) {
                row.crossGated = reason;
                crossGatedNow = true;
                if (reason & 1) ++S.st.crossGatedTexture;
                if (reason & 2) ++S.st.crossGatedPeak;
                if (reason & 4) ++S.st.crossGatedPeriod;
                if (crossIsX) advX = 0.0; else advY = 0.0;
                row.advanceX = advX;
                row.advanceY = advY;
                row.advanceTotX = dRotX + advX;
                row.advanceTotY = dRotY + advY;
            }
        }

        // ── 2b. CROSS-SWEEP MEASUREMENT (v5) ───────────────────────────
        // Fed the MEASURED residual (advXMeas / advYMeas), gated or not — see
        // the gate block above.  The K-window mean it returns is then pinned
        // to the gated value on a gated frame, so whichever of `advCross` /
        // `crossAvgFit` the chain applies, it applies the attitude there.
        double crossGradFit = 0.0, xiC = 0.0;
        double crossAvgFit = (S.axis == 0) ? advYMeas : advXMeas;
        S.crossBands.clear();
        S.crossCurWins.clear();
        S.crossOwXs.clear();
        S.crossOwYs.clear();
        if (S.cfg.crossSweepFit || S.cfg.seamMetrics) {
            S.crossMeasure(*in.grayWork, Hrect, bu0, bu1, bv0, bv1, ws, owX, owY,
                           curWinF, advXMeas, advYMeas, response, &crossGradFit,
                           &S.crossBands, &xiC, &S.crossCurWins, &S.crossOwXs,
                           &S.crossOwYs, &crossAvgFit);
        }
        if (crossGatedNow) crossAvgFit = (S.axis == 0) ? advY : advX;

        // Accept: advance the chain.  The frame's real canvas-position step is
        // the SUM of the two channels — the rotation carried by H_rect plus the
        // residual just measured (row.advanceTot*, set above).  Neither is the
        // position on its own: reading only the residual is what latched the
        // first device pack backwards, and placing from the attitude alone
        // cannot move a walking sweep.
        row.chainAdvanced = true;
        if (owClamped) ++S.corrOriginClamped;
        // REGIME accounting spans every accepted frame SINCE THE CURRENT
        // REFERENCE, pre-latch ones included — and that is not an oversight.
        // A pre-latch frame paints nothing itself, but its TRAVEL still reaches
        // the canvas: the bootstrap paints the reference frame's whole
        // footprint and the first post-latch strip spans back to the frontier,
        // so the panorama covers the pre-latch excursion.  Dropping those
        // frames breaks the summary's identity (measured: travel 641 vs growth
        // 822 on a deliberately delayed latch) exactly as badly as
        // double-counting them would.  A RELATCH does reset these, in
        // reseedReferenceTo() — that canvas really is discarded.
        S.gTotX += row.advanceTotX;  S.gTotY += row.advanceTotY;
        S.rotNetX += dRotX;  S.rotNetY += dRotY;
        S.resNetX += advX;   S.resNetY += advY;
        S.rotPathX += std::fabs(dRotX); S.rotPathY += std::fabs(dRotY);
        S.resPathX += std::fabs(advX);  S.resPathY += std::fabs(advY);
        S.prevCrX = crx;
        S.prevCrY = cry;

        // ── 2c. THE CROSS-SWEEP PLACEMENT + THE CUT METRIC (v5) ────────
        if (S.axisLatched) {
            // Pnat ← Pnat · [ T(adv) · crossScale(1+g about ξ_c) ]
            const double gMeas = std::max(-S.cfg.crossGradMaxPerFrame,
                                          std::min(S.cfg.crossGradMaxPerFrame,
                                                   crossGradFit));
            const double sOld = S.crossScale;
            double g = 0.0, sNew = sOld;
            bool caged = false;

            // THE ONLINE SUBJECT-DISTANCE FIT.  The measured per-frame cross
            // gradient integrates to a log-scale; regressing it against the
            // pose's forward travel gives the distance of the surface being
            // swept.  Measured on the four device packs: 0.69-1.14 m, and the
            // online fit beats every fixed d tried (1.0 / 1.5 / 2.5 m) on
            // every pack.
            double fwd = 0.0;
            for (int k = 0; k < 3; ++k) fwd += (in.t[k] - S.refT[k]) * S.fwdRef[k];
            if (gMeas > -0.9) S.crossLogMeas += std::log1p(gMeas);
            S.dFitNum += fwd * (-S.crossLogMeas);
            S.dFitDen += fwd * fwd;

            // ── v11: THE FIT'S LEVERAGE, measured on the SAME frames ─────
            // `fwd` is the only regressor this estimator has.  A shelf sweep
            // holds standoff by design, so on the field packs its whole span
            // is 1-13 cm against a metre of perpendicular travel — and the
            // pack said nothing.  Measured here, next to the sample that
            // uses it, so the two can never describe different frame sets.
            // Pure accumulation: nothing below reads these back.
            {
                double perp2 = 0.0;
                for (int k = 0; k < 3; ++k) {
                    const double d = (in.t[k] - S.refT[k]) - fwd * S.fwdRef[k];
                    perp2 += d * d;
                }
                const double perp = std::sqrt(perp2);
                if (perp > S.dFitPerpMax) S.dFitPerpMax = perp;
                if (!S.dFitSpanSeen) {
                    S.dFitSpanSeen = true;
                    S.dFitFwdMin = S.dFitFwdMax = fwd;
                } else {
                    if (fwd < S.dFitFwdMin) S.dFitFwdMin = fwd;
                    if (fwd > S.dFitFwdMax) S.dFitFwdMax = fwd;
                }
                ++S.dFitSamples;
            }

            if (S.dFitDen > 1e-6 && std::fabs(S.dFitNum) > 1e-12) {
                const double dfit = S.dFitDen / S.dFitNum;
                if (std::isfinite(dfit) && dfit > 0.0) {
                    S.subjectDistanceFit = std::max(0.3, std::min(6.0, dfit));
                    // v11 — the RAW ratio and whether the shipped value is a
                    // rail.  Without this a clamped 6.00 and a genuine 6.00
                    // are the same field, which is exactly how a 7.5×-wrong
                    // standoff shipped silently on two field packs.
                    S.dFitRaw = dfit;
                    S.dFitSaturated = (dfit < 0.3 || dfit > 6.0);
                    if (S.dFitSaturated) ++S.dFitClamped;
                } else {
                    // A refused update SILENTLY RETAINS the previous value —
                    // so a fit that stopped converging halfway is otherwise
                    // indistinguishable from one that converged.
                    ++S.dFitRefused;
                }
            }

            if (S.cfg.crossSweepFit) {
                if (S.cfg.crossFitMode == 2) {
                    // THE OPERATOR'S VIRTUAL PLANE, as the MODEL.  A plane at
                    // `d` predicts the cross magnification from the pose alone.
                    // SIGN, derived and then verified on the packs: Pnat_i =
                    // Pnat_{i−1}·M and M maps frame-i coords INTO frame-(i−1)
                    // coords, so content that has grown by k (the camera moved
                    // TOWARD the surface) enters as 1/k and the accumulated
                    // cross scale FALLS.  The packs agree: measured cumulative
                    // cross log-scale −0.263 / −0.191 against forward travel
                    // +0.292 m / +0.152 m.  With the sign inverted the
                    // correction pushes the panorama the wrong way and the band
                    // divergence gets WORSE — which is how this was caught.
                    // Because it is ABSOLUTE rather than integrated it cannot
                    // random-walk, and the metric that scores it does not
                    // depend on it.
                    const double dUse =
                        (S.cfg.subjectDistanceAuto && S.subjectDistanceFit > 0.0)
                            ? S.subjectDistanceFit : S.cfg.subjectDistanceM;
                    double L = -fwd / std::max(0.05, dUse);
                    L = std::max(-S.cfg.crossScaleCageFrac,
                                 std::min(S.cfg.crossScaleCageFrac, L));
                    const double sTarget = std::exp(L);
                    g = (sOld > 1e-9) ? (sTarget / sOld) - 1.0 : 0.0;
                    if (std::fabs(g) > S.cfg.crossGradMaxPerFrame) {
                        g = std::max(-S.cfg.crossGradMaxPerFrame,
                                     std::min(S.cfg.crossGradMaxPerFrame, g));
                        caged = true;
                        ++S.crossScaleCagedFrames;
                    }
                    sNew = sOld * (1.0 + g);
                } else {
                    // MODE 1 — THE IMAGE-FITTED GRADIENT, INTEGRATED.
                    //
                    // Unlike mode 2 above this has no absolute target, so it
                    // random-walks: measured crossScale at sweep end 0.815 /
                    // 0.778 / 0.634 on three packs, against 1.000000 pinned on
                    // the shipped path.  See Config::crossScaleLeak for the
                    // measurements and for why the leak is the right cut.
                    // ── THE GESTURE GATE, AND IT IS AUTOMATIC ──────────
                    //
                    // The defect this mode corrects is specific to a sweep that
                    // runs LEFT-RIGHT IN THE WORLD, because only then do the
                    // shelf rails lie ALONG the sweep and collect every
                    // per-strip cross error. On a world-VERTICAL sweep the rails
                    // run ACROSS it, each sits inside one strip, and there is
                    // nothing for this to correct — while the estimator, looking
                    // along a uniform rail, has nothing to measure and integrates
                    // noise. Measured 2026-09-16: the clean vertical control came
                    // back with crossScale 0.9017, a 10% squash applied to a
                    // sweep that had nothing wrong with it.
                    //
                    // So the mode gates ITSELF rather than asking the operator to
                    // remember. Both terms are already known and neither is a
                    // guess about scene content: `S.axis` is the LATCHED sweep
                    // axis and `outputRotationCwDeg` is the hold the host
                    // measured at Start. The sweep is world-horizontal when the
                    // natural sweep axis maps to the canvas's horizontal after
                    // the output rotation — X with no swap, or Y with one.
                    // Measured on the three packs: sideways (axis 1, rot 90) and
                    // (axis 1, rot 90); vertical (axis 1, rot 0).
                    const int  outRot = ((S.cfg.outputRotationCwDeg % 360) + 360) % 360;
                    const bool rotSwapsAxes = (outRot == 90 || outRot == 270);
                    const bool sweepIsWorldHorizontal =
                        (S.axis == 0) ? !rotSwapsAxes : rotSwapsAxes;
                    if (!sweepIsWorldHorizontal) {
                        // Refuse, and COUNT it, so a pack can say the mode was
                        // armed and declined rather than looking like it was off.
                        ++S.crossGestureRefused;
                        g = 0.0;
                        sNew = sOld;
                    } else {

                    // ── THE OBSERVABILITY GATE, BEFORE ANYTHING ELSE ───
                    // Does the straight line through the K bands actually
                    // explain them?  If not, `gMeas` is a line fitted to noise
                    // and integrating it manufactures drift.  See
                    // Config::crossFitMinBandR2 for the pack that forced this.
                    bool bandFitOk = true;
                    double bandR2 = 1.0;
                    if (S.cfg.crossFitMinBandR2 > 0.0) {
                        const size_t nB = S.crossBands.size();
                        if (nB < 3) {
                            // No residual to judge: pass, and say so via the
                            // counter rather than silently crediting the fit.
                            bandFitOk = true;
                        } else {
                            double sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
                            for (size_t k = 0; k < nB; ++k) {
                                const double x = S.crossBands[k].xi;
                                const double y = S.crossBands[k].adv;
                                sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
                            }
                            const double n = (double)nB;
                            const double varX = sxx - sx * sx / n;
                            const double varY = syy - sy * sy / n;
                            const double cov  = sxy - sx * sy / n;
                            bandR2 = (varX > 1e-12 && varY > 1e-12)
                                         ? (cov * cov) / (varX * varY)
                                         : 0.0;
                            bandFitOk = (bandR2 >= S.cfg.crossFitMinBandR2);
                        }
                        if (!bandFitOk) ++S.crossBandFitRefused;
                    }
                    row.crossBandR2 = bandR2;
                    const double gRaw = bandFitOk ? gMeas : 0.0;

                    // DC REMOVAL. The running mean is updated on every frame the
                    // mode runs, whether or not it is subtracted, so turning the
                    // knob on mid-corpus cannot change what the estimator had
                    // already seen.  A gate-refused frame contributes 0, which
                    // is correct: it had no measurement to contribute.
                    ++S.crossGCount;
                    S.crossGSum += gRaw;
                    double gInt = gRaw;
                    if (S.cfg.crossFitDcRemove != 0 && S.crossGCount > 0) {
                        gInt = gRaw - (S.crossGSum / (double)S.crossGCount);
                        ++S.crossDcRemovedFrames;
                    }
                    sNew = sOld * (1.0 + gInt);
                    if (S.cfg.crossScaleLeak > 0.0 && sNew > 1e-9 && sOld > 1e-9) {
                        const double k = std::min(1.0, S.cfg.crossScaleLeak);
                        sNew = std::exp(std::log(sNew) * (1.0 - k));
                        ++S.crossScaleLeakedFrames;
                    }
                    // ⚠ RE-DERIVE g FROM THE COMMITTED SCALE, never leave it as
                    // gMeas.  `g` is not only the scale: it is also the
                    // centring term of the translation immediately below
                    // (tNew = sOld*(advCrossUsed − g*xiC) + tOld).  Leaving the
                    // pre-leak g there would scale the strip by one number and
                    // centre that scaling on another, which shears rather than
                    // scales.  Mode 2 derives g from its own target for exactly
                    // this reason; this is the same shape.
                    g = (sOld > 1e-9) ? (sNew / sOld) - 1.0 : 0.0;
                    }  // sweepIsWorldHorizontal
                }
            }
            const double advCross = (S.axis == 0) ? advY : advX;
            const double advAlong = (S.axis == 0) ? advX : advY;
            const double tOld = (S.axis == 0) ? S.posNatY : S.posNatX;
            const double uOld = (S.axis == 0) ? S.posNatX : S.posNatY;
            // v8 — WHICH measurement moves the chain.  Off (the default) this
            // is `advCross` and the arithmetic below is v7's, term for term.
            const double advCrossUsed =
                S.cfg.crossAvgWindows ? crossAvgFit : advCross;
            row.crossAvgDeltaPx = advCrossUsed - advCross;
            const double tNew = sOld * (advCrossUsed - g * xiC) + tOld;
            const double uNew = uOld + advAlong;
            S.crossScale = sNew;
            if (S.axis == 0) { S.posNatX = uNew; S.posNatY = tNew; }
            else             { S.posNatX = tNew; S.posNatY = uNew; }
            row.crossGrad = g;
            row.crossScale = sNew;
            row.crossScaleCaged = caged;

            // ── THE CUT METRIC, against the COMMITTED placement ─────────
            // Read the placement OUT OF THE MATRICES that were just written,
            // never back out of the variables the fit was made of.  Band k
            // measured that this frame's natural cross coordinate ξ_k holds
            // the content the previous frame held at ξ_k + a_k, so the cut a
            // canvas reader sees at that band is
            //
            //     cut_k = crossOf(Pnat_new, ξ_k) − crossOf(Pnat_old, ξ_k + a_k)
            //
            // in CANVAS px.  Algebraically this is −sOld·(a_k − (advCross +
            // g·(ξ_k−ξ_c))) — the same quantity the fit's own residual gives —
            // but it is now COMPUTED from the committed transform, so any
            // divergence between what was decided and what was written lands
            // in the metric instead of being cancelled out of it.  It is still
            // expressed in the frame's own natural coordinates, so the canvas
            // vertical-growth re-base (the benign ~128 px posV steps) cannot
            // reach it: the re-base is a translate applied to Hint AFTER pnat.
            //
            // What this still cannot see — and what seamCanvasJogPx exists for
            // — is a placement error introduced after this point, or every
            // window agreeing on the same wrong (aliased) peak.
            if (!S.crossBands.empty()) {
                const Mat33 pOld = Impl::pnatOf(sOld, tOld, uOld, S.axis);
                const Mat33 pNew = S.pnat();
                auto crossOf = [&](const Mat33& P, double xi) {
                    return (S.axis == 0) ? (P(1, 1) * xi + P(1, 2))
                                         : (P(0, 0) * xi + P(0, 2));
                };
                const double sInv = (std::fabs(sOld) > 1e-9) ? (1.0 / sOld) : 1.0;
                double worst = 0.0, lo = 0.0, hi = 0.0;
                bool first = true;
                for (const auto& b : S.crossBands) {
                    // Reported in the frame's own units (÷ sOld) so the bars
                    // calibrated on the four device packs keep their meaning
                    // whatever the accumulated cross scale has reached.
                    const double e =
                        -(crossOf(pNew, b.xi) - crossOf(pOld, b.xi + b.adv)) * sInv;
                    if ((size_t)b.slot < S.bandErrCum.size())
                        S.bandErrCum[(size_t)b.slot] += e;
                    worst = std::max(worst, std::fabs(e));
                    if (first) { lo = hi = e; first = false; }
                    else { lo = std::min(lo, e); hi = std::max(hi, e); }
                }
                row.seamWorstBandPx = worst;
                row.seamBandSpreadPx = hi - lo;
            }
            row.seamBands = (int)S.crossBands.size();
        } else {
            S.posNatX += advX;
            S.posNatY += advY;
        }

        S.prevWinF = curWinF;   // PRISTINE — phaseCorrelate saw copies
        S.prevOwX = owX;
        S.prevOwY = owY;
        if (S.crossCurWins.size() == S.prevWins.size()) {
            for (size_t k = 0; k < S.crossCurWins.size(); ++k) {
                if (S.crossCurWins[k].empty()) continue;
                S.prevWins[k] = S.crossCurWins[k];
                S.prevWinOwX[k] = S.crossOwXs[k];
                S.prevWinOwY[k] = S.crossOwYs[k];
            }
        }

        // ── 3. AXIS + SIGN LATCH ───────────────────────────────────────────
        //
        // THE bug the first device pack exposed.  v2 voted on Σ(advance) — the
        // rectification RESIDUAL — which is ≈ −(attitude step) on a pivot, so
        // it chose sweepSign −1 for a sweep running +1 and the high-water rule
        // then correctly refused to paint 71.8% of the frames.  Vote instead
        // on the channels the PLACEMENT is made of, and only once one of them
        // has moved far enough that its sign is not a coin flip.
        if (!S.axisLatched) {
            ++S.latchFrames;
            // ROTATION: the attitude excursion since the reference frame.
            // Absolute, not accumulated — it cannot drift.  Identically zero
            // in the rectify == false control arm.  RECORDED, never voted on:
            // it is perpendicular to a shelf walk, and letting it vote latched
            // the axis ACROSS the sweep on 21 of 45 measured walk gestures.
            S.latchRotX = S.cfg.canvasScale * crx - S.natRefX;
            S.latchRotY = S.cfg.canvasScale * cry - S.natRefY;
            // TOTAL: where the paint transform would actually put this frame.
            // THE quantity the latch votes on, and the only one.
            S.latchTotX = S.latchRotX + S.posNatX;
            S.latchTotY = S.latchRotY + S.posNatY;
            const double totMag = std::max(std::fabs(S.latchTotX),
                                           std::fabs(S.latchTotY));

            if (S.latchFrames < S.cfg.axisLatchFrames)
                return finishRow(Outcome::Bootstrap);

            // A fully FORCED axis+sign has nothing to vote on, so it must not
            // wait for motion — an A/B arm that pins both knobs would
            // otherwise sit in bootstrap while the arm it is compared against
            // paints, and the two runs would differ in more than the knob.
            const bool forced =
                (S.cfg.axisOverride != 0 && S.cfg.signOverride != 0);
            if (!forced && totMag < S.cfg.latchTotalPx) {
                // Nothing decisive yet.  Keep holding — but not forever: at
                // axisLatchMaxFrames decide on the best evidence there is and
                // FLAG the decision as weak, which the relatch will then very
                // likely correct once real motion arrives.
                if (S.latchFrames < S.cfg.axisLatchMaxFrames)
                    return finishRow(Outcome::Bootstrap);
                S.latchWasWeak = true;
            }

            const char* fatal = nullptr;
            if (!S.commitLatch(S.latchTotX, S.latchTotY, row, &fatal)) {
                abort(fatal);
                return finishRow(std::string(fatal) == "canvas-full"
                                     ? Outcome::CanvasFull
                                     : Outcome::AbortedTracking);
            }
            return finishRow(Outcome::Bootstrap);
        }

        // ── 3b. RELATCH — the latch checks its own work ────────────────────
        //
        // A wrong axis or sign cannot be ruled out at the moment of the vote
        // (a rising transient and a sweep are the same signal over a short
        // horizon), but it is unmistakable a few frames later: the canvas
        // stops growing while the camera keeps moving.  Read that, and correct.
        //
        // The check costs a handful of arithmetic ops per frame and is
        // disarmed for good the moment the panorama is self-evidently real.
        ++S.framesSinceLatch;
        if (S.relatchArmed) {
            const double grown =
                (double)std::max(0, S.maxPaintedU - S.minPaintedU) - S.footprintU;
            if (grown >= S.cfg.relatchCommitFrac * S.footprintU) {
                // The sweep is going where the latch said.  Never re-check
                // again: past this point a relatch would discard real
                // panorama, which is a worse outcome than any axis it could
                // fix.
                S.relatchArmed = false;
            } else if (S.relatchCount < S.cfg.relatchMaxCount &&
                       S.framesSinceLatch >=
                           S.cfg.relatchMinFrames * (S.relatchCount + 1)) {
                // ESCALATING EVIDENCE.  Each successive correction demands a
                // strictly LONGER window and MORE motion than the one before
                // it.  Without that, a wobble whose period exceeds the window
                // (measured: 6° at ~42 frames/cycle) decides every correction
                // the same wrong way and simply exhausts the budget — three
                // relatches, all on the same bad evidence.  Escalating makes a
                // later correction see a baseline the wobble cannot dominate,
                // and it bounds the total number of restarts by construction.
                const double bar = S.cfg.relatchMotionPx * (S.relatchCount + 1);
                // Cumulative displacement since the FIRST latch — the longest
                // baseline available, which is what averages a wobble out.
                const double dTotX = S.gTotX;
                const double dTotY = S.gTotY;
                // DECISIVENESS, not just magnitude.  The winning axis must
                // beat the other by relatchDominance or the evidence is called
                // ambiguous and the engine waits instead of spending a
                // correction on it — which is precisely what a half-returned
                // transient looks like.  Measured across 109 gestures: the
                // margin cut two-correction outcomes from 7 to 1 and total
                // failures from 11 to 4.  It cannot deadlock a genuinely
                // DIAGONAL sweep, because a diagonal projects ~0.7 of its
                // motion onto whichever axis latched, the canvas grows, and
                // the check disarms before the margin is ever consulted
                // (verified at 20°/35°/45°/55°/70°: zero relatches, full
                // growth, no holes).
                const double hi = std::max(std::fabs(dTotX), std::fabs(dTotY));
                const double lo = std::min(std::fabs(dTotX), std::fabs(dTotY));
                if (hi >= bar && hi >= S.cfg.relatchDominance * lo) {
                    const int wantAxis =
                        (S.cfg.axisOverride == 1) ? 0
                      : (S.cfg.axisOverride == 2) ? 1
                      : ((std::fabs(dTotX) >= std::fabs(dTotY)) ? 0 : 1);
                    const double dom = (wantAxis == 0) ? dTotX : dTotY;
                    const int wantSign = (S.cfg.signOverride != 0)
                                             ? S.cfg.signOverride
                                             : ((dom < 0.0) ? -1 : 1);
                    if (wantAxis != S.axis || wantSign != S.sweepSign) {
                        // CORRECT IT.  The reference moves to THIS frame (the
                        // newest good one the engine holds) and the canvas is
                        // rebuilt from it, so the restart is the ordinary
                        // latch path with a corrected direction — not a second
                        // code path that could drift from the first.
                        ++S.relatchCount;
                        S.st.relatchCount = S.relatchCount;
                        row.relatched = true;
                        S.reseedReferenceTo(in);
                        S.latchRotX = 0.0; S.latchRotY = 0.0;
                        S.latchTotX = dTotX; S.latchTotY = dTotY;
                        const char* fatal = nullptr;
                        if (!S.commitLatch(dTotX, dTotY, row, &fatal)) {
                            abort(fatal);
                            return finishRow(std::string(fatal) == "canvas-full"
                                                 ? Outcome::CanvasFull
                                                 : Outcome::AbortedTracking);
                        }
                        return finishRow(Outcome::Bootstrap);
                    }
                    // SAME answer — the latch was right, the evidence just
                    // was not conclusive yet.  Cost nothing, look again later.
                    // This is what makes an early or noisy trigger harmless
                    // instead of destructive.
                    S.framesSinceLatch = 0;
                }
            }
        }

        // ── 4. STRIP GEOMETRY ──────────────────────────────────────────────
        Mat33 Hint = translate(S.originU, S.originV) * S.A * S.pnat() *
                     scaleM(S.cfg.canvasScale) * Hrect;
        double fu0, fu1, fv0, fv1;
        if (!mapBounds(Hint, S.imgW, S.imgH, &fu0, &fu1, &fv0, &fv1))
            return finishRow(Outcome::RejectedRectify);
        double ucx = 0, ucy = 0;
        if (!mapPoint(Hint, 0.5 * S.imgW, 0.5 * S.imgH, &ucx, &ucy))
            return finishRow(Outcome::RejectedRectify);
        row.posU = ucx;
        row.posV = ucy;

        const double du = ucx - S.lastPaintedU;
        if (du < -S.cfg.minAdvancePx) return finishRow(Outcome::HeldBacktrack);
        if (du <= S.cfg.minAdvancePx) return finishRow(Outcome::SkippedNoAdvance);

        const double footprintW = fu1 - fu0;
        double w = du * S.cfg.stripMargin;
        w = std::max(1.0, std::min(w, footprintW));
        row.stripW = w;
        const double leftEdge = ucx - 0.5 * w;
        double rightEdge = std::min(ucx + 0.5 * w, fu1);

        // ── 5. HIGH-WATER ──────────────────────────────────────────────────
        // Forward motion, but this frame's strip is still entirely behind the
        // frontier (a transient lead — e.g. right after the bootstrap paint).
        // Distinct from HeldBacktrack: conflating them would corrupt the
        // reversal statistic the residual analysis reads.
        if (rightEdge <= S.highWater + 1e-6)
            return finishRow(Outcome::HeldFrontier);

        // ── 5b. PERPENDICULAR FIT ──────────────────────────────────────────
        // The canvas band is fixed at the axis latch, but the hand is not:
        // ±128 canvas px of pad is ≈ ±11 cm of drift at 0.6 m standoff, which
        // a 3-4 m sweep passes routinely.  Grow the band to fit BEFORE the
        // commit; whatever is still outside afterwards is reported, not
        // discarded in silence (warpPerspective has no return value, so an
        // ungrown, unreported clip is indistinguishable from a clean strip and
        // unpaintedRuns() would still say "no holes").
        //
        // Nothing above this point depends on the perpendicular origin: a top
        // growth shifts v only, so du / w / leftEdge / rightEdge are all
        // unaffected and only Hint and the v-bounds are re-based.
        {
            // Grow with a 1 px GUARD BAND.  The clip detector is the warp
            // mask touching row 0 / row canvasH-1, which fires when content
            // merely GRAZES the edge (fv1 = 795.4 in a 796-row canvas covers
            // row 795 while the analytic overhang is still negative).  Growing
            // to keep a pixel of clearance is what makes "the mask touched an
            // edge" mean "content was actually lost".
            const double kGuardPx = 1.0;
            const int needTop = (int)std::ceil(std::max(0.0, kGuardPx - fv0));
            const int needBot = (int)std::ceil(
                std::max(0.0, fv1 + kGuardPx - (double)S.canvasH));
            int addedTop = 0;
            if ((needTop > 0 || needBot > 0) &&
                S.ensureCanvasBand(needTop, needBot, &addedTop) && addedTop > 0) {
                Hint = translate(0.0, (double)addedTop) * Hint;
                fv0 += addedTop;
                fv1 += addedTop;
                ucy += addedTop;
                row.posV = ucy;
            }
        }
        row.clipTopPx = std::max(0.0, -fv0);
        row.clipBotPx = std::max(0.0, fv1 - (double)S.canvasH);

        // ── 6. GAP RULE ────────────────────────────────────────────────────
        Outcome outcome = Outcome::Painted;
        const double gapPx = std::max(0.0, leftEdge - S.highWater);
        row.gapPx = gapPx;
        double paintLeft = std::max(S.highWater, fu0);

        // ── 6a. THE SEED JUNCTION (Config::seedFrontierMeet, default off) ──
        // `commitLatch` hands the frontier the seed frame's CENTRE while every
        // strip's left edge is half a margin behind its OWN centre, so the
        // FIRST strip after a seed always starts
        //
        //     gapPx = du · (1 − stripMargin/2)      (= 0.375·du at 1.25)
        //
        // ahead of the frontier — and the bridge below drags it back to the
        // seed's centre, repainting that span of the DATUM frame with the
        // least-determined strip in the sweep.  Measured on this Mac over all
        // 36 pano+ packs on the machine, the identity holds to 0.000000 on the
        // 32 that have a strip after their seed (gapPx 9.178-12.965 px at
        // phaseWindowPx 384, 9.380-12.997 px at 768) — arithmetic, not
        // correlation.
        //
        // On, the two edges MEET: the strip paints from its own left edge and
        // the span stays the seed's, which is not a hole because the seed's
        // footprint runs a further ~0.5·footprintU past its centre and already
        // owns every column in it.
        //
        // FAIL-CLOSED, three ways.  Only the first strip after a latch
        // (`stripsSinceLatch == 0`, re-based by every relatch); only when this
        // frame's own footprint still reaches the frontier, so the backfill
        // branch below keeps precedence and its hole can never be hidden; and
        // only when the seed's ACTUALLY-COMMITTED forward edge (`lastFu1` —
        // narrower than the footprint when the seed was arc-sliced) covers the
        // span being left behind.  Any of those failing keeps today's bridge,
        // byte for byte.
        //
        // ⚠ IT DOES NOT PLACE THE STRIP.  How far the junction strip lands off
        // is a correlation question (48.54 px at phaseWindowPx 384 on Pano
        // plus 5 / 11-12-47-888Z, 1.70 px worst over the same 32 packs at
        // 768); this only stops a mis-landed one from reaching back into the
        // datum.
        //
        // ⚠ IT DOES NOT MEASURE THE STRIP EITHER.  `paintLeft` is also the
        // origin of the gain-fit and jog-guard window, so moving it moved the
        // d8 guard's own input and the guard changed which strips it admitted
        // (measured on this Mac at 768 over 36 packs: d8JogRefusals 31 → 26).
        // The measurement is therefore PINNED to the frontier the off arm used
        // — `Config::seedFrontierMeetPinMeasure`, see commitStrip's header.
        //
        // ⚠ AND IT DOES NOT DECIDE THE ROW.  `row.gapPx` is left at the true
        // geometric hole here and zeroed only once the commit has actually
        // PAINTED from the strip's own left edge.  Zeroing it in this block
        // made a junction the d8 guard then refused report `gapPx 0` on a row
        // where nothing landed and the hole was still open (measured: five
        // consecutive `d8-jog-held` rows on p5-2026-09-07T11-12-47-888Z at 384
        // reporting 0.000 against true gaps of 9.734-11.472 px), which is the
        // one instrument the whole A/B is scored on.
        bool meetSeed = false;
        double meetMeasureLeft = 0.0;
        double meetGapPx = 0.0;
        if (S.cfg.seedFrontierMeet && S.stripsSinceLatch == 0 && gapPx > 0.0 &&
            fu0 <= S.highWater + 0.5 && leftEdge <= S.lastFu1 + 0.5) {
            meetSeed = true;
            meetMeasureLeft = paintLeft;   // the frontier the OFF arm measured
            meetGapPx = gapPx;
            paintLeft = leftEdge;
        }

        if (fu0 > S.highWater + 0.5) {
            // BACKFILL (algorithm step 8).  This frame's footprint no longer
            // reaches the frontier, but the PREVIOUS painted frame's did — and
            // it really saw those columns, so filling them from its pixels is
            // recovery, not fabrication.  Gain is deliberately NOT run on the
            // backfill: it must not perturb the exposure chain.
            //
            // DEFENCE IN DEPTH, not a hot path.  Opening a gap needs
            // du > footprintU/2, while the cage is clamped to
            // 0.40·winW/workScale·canvasScale ≤ 0.40·footprintU — so under
            // every reachable config an advance big enough to gap is REJECTED
            // first, and a rejected frame does not advance the chain.  See
            // PanoGap.TheClampedCageMakesInteriorGapsUnreachable, which fails
            // loudly if a future knob change breaks that inequality and makes
            // this branch live.
            if (S.cfg.backfillGaps && S.lastValid && !S.lastBgr.empty()) {
                const double bx1 = std::min(fu0, S.lastFu1);
                if (bx1 > S.highWater + 0.5) {
                    int bp0 = 0, bp1 = 0, bClip = 0;
                    double bgs = 1.0;
                    for (int k = 0; k < 4; ++k) S.curK[k] = S.lastK[k];
                    if (S.commitStrip(S.lastBgr, S.lastHint, S.highWater, bx1,
                                      S.highWater, false, S.lastExpGain,
                                      S.lastExpResidual, &bgs, &bp0, &bp1,
                                      &bClip) && bp1 > bp0) {
                        S.highWater = std::min(bx1, (double)bp1);
                        S.advancePhotoScan(S.highWater);
                        row.backfillPx = (double)(bp1 - bp0);
                        if (bClip > 0) {
                            row.clipped = true;
                            S.st.clippedColumns += bClip;
                        }
                        paintLeft = std::max(S.highWater, fu0);
                    }
                }
            }
            outcome = (fu0 > S.highWater + 0.5) ? Outcome::GapBreak
                                                : Outcome::GapBackfilled;
        } else if (gapPx > 0.5 && !meetSeed) {
            outcome = Outcome::GapExtended;
        }

        // ── 7. WARP + GAIN + COMMIT ────────────────────────────────────────
        int px0 = 0, px1 = 0, clipCols = 0;
        double gainStep = 1.0;
        S.lastAreaScale = 1.0;
        S.curK[0] = in.fx; S.curK[1] = in.fy; S.curK[2] = in.cx; S.curK[3] = in.cy;
        if (!S.commitStrip(*in.bgr, Hint, paintLeft, rightEdge, fu0,
                           S.cfg.gainMatch, S.curExpGain, S.curExpResidual,
                           &gainStep, &px0, &px1, &clipCols,
                           /*jogGuardEligible=*/true,
                           /*applyChainGainNoFit=*/false,
                           (meetSeed && S.cfg.seedFrontierMeetPinMeasure)
                               ? meetMeasureLeft
                               : Engine::Impl::kNoMeasureLeft)) {
            abort("canvas-full");
            return finishRow(Outcome::CanvasFull);
        }
        // ── v13: a guard refusal is its OWN outcome, with its evidence ──
        // The measured jog rides the ledger row so a pack says exactly what
        // was refused and by how much; the frontier, the gain chain and
        // lastBgr are all untouched — the next well-placed strip paints the
        // span (mirrors the twin's D8_JOG_HELD path byte for byte).
        if (S.lastJogRefused) {
            row.seamCanvasJogPx = S.lastSeamJogPx;
            row.seamCanvasJogSignedPx = S.lastSeamJogSignedPx;
            row.seamCanvasJogValid = S.lastSeamJogValid;
            return finishRow(Outcome::JogHeld);
        }
        // Clip accounting BEFORE the HeldFrontier early return: a backfill
        // that painted clipped content must be counted even when this frame's
        // own strip then contributes nothing, or clippedColumns and
        // clippedFrames would disagree.
        if (clipCols > 0) {
            row.clipped = true;
            S.st.clippedColumns += clipCols;
        }
        if (row.clipped) {
            ++S.st.clippedFrames;
            S.st.maxClipTopPx = std::max(S.st.maxClipTopPx, row.clipTopPx);
            S.st.maxClipBotPx = std::max(S.st.maxClipBotPx, row.clipBotPx);
        }
        if (px1 <= px0) return finishRow(Outcome::HeldFrontier);

        // THE MEET, banked on the row that actually painted.  Three states stay
        // three: `gap-extended` (bridged), `seedMet` with `gapPx == 0` (met),
        // and `d8-jog-held` still carrying its true `gapPx` (nothing landed and
        // the hole is still open).
        if (meetSeed) {
            row.seedMet = true;
            row.seedMeetPx = meetGapPx;
            row.gapPx = 0.0;
        }
        row.gainStep = gainStep;
        row.canvasX0 = px0;
        row.canvasX1 = px1;
        row.areaScale = S.lastAreaScale;
        row.seamLumaStepDN = S.lastSeamLumaDN;
        row.seamCanvasJogPx = S.lastSeamJogPx;
        row.seamCanvasJogSignedPx = S.lastSeamJogSignedPx;
        row.seamCanvasJogValid = S.lastSeamJogValid;
        row.seamPhotoStepDN = S.lastSeamPhotoDN;
        row.seamPhotoUniform = S.lastSeamPhotoUniform;
        row.seamPhotoSpreadDN = S.lastSeamPhotoSpreadDN;
        row.seamPhotoBands = S.lastSeamPhotoBands;
        row.seamPhotoValid = S.lastSeamPhotoValid;
        row.photoScale = S.curExpResidual * (S.cfg.gainMatch ? S.gainCum : 1.0);
        if (S.cfg.seamMetrics) {
            ++S.seamStripsCommitted;
            if (row.seamBands > 0) {
                insertSorted(S.seamWorstSamples, (float)row.seamWorstBandPx);
                insertSorted(S.seamSpreadSamples, (float)row.seamBandSpreadPx);
            }
            if (S.lastSeamLumaValid)
                insertSorted(S.seamLumaSamples, (float)row.seamLumaStepDN);
            if (row.seamCanvasJogValid) {
                insertSorted(S.seamJogSamples, (float)row.seamCanvasJogPx);
                S.noteJogDrift(row.seamCanvasJogSignedPx);
            }
            // EVERY valid boundary enters the percentiles — including the
            // ones whose difference is not DC-like.  Excluding those would
            // condition the percentiles on the boundaries that happened to
            // look flat, which is exactly the bug the v5 luma metric's own
            // comment names.  The uniformity is a DIAGNOSTIC count instead.
            if (row.seamPhotoValid) {
                insertSorted(S.seamPhotoSamples,
                             (float)std::fabs(row.seamPhotoStepDN));
                if (std::fabs(row.seamPhotoStepDN) > kSeamPhotoStepMaxBarDN)
                    ++S.seamPhotoOverBar;
                S.noteSeamPhotoStep(px0, row.seamPhotoStepDN,
                                    S.lastSeamPhotoBaseDN,
                                    (double)(px1 - px0),
                                    (double)S.lastSeamSlabW);
                // THREE states, not two.  "Too few bands could measure" is
                // not "uniform", and folding it into either count would put a
                // number on something nothing measured.
                if (row.seamPhotoUniform < 0.0) {
                    ++S.seamPhotoUniformUnknown;
                } else {
                    // A measured spread is a measurement; an unknown one is
                    // not, and must not dilute the percentile with a zero.
                    insertSorted(S.seamPhotoSpreadSamples,
                                 (float)row.seamPhotoSpreadDN);
                    if (row.seamPhotoUniform < S.cfg.photoUniformMinFrac) {
                        ++S.seamPhotoNonUniform;
                    } else {
                        insertSorted(S.seamPhotoUniSamples,
                                     (float)std::fabs(row.seamPhotoStepDN));
                    }
                }
            }
        }
        // The frontier follows what was actually COMMITTED, never the
        // requested edge — otherwise the trim above would leave a sliver of
        // canvas that nothing owns and the next strip would start past it.
        S.highWater = std::min(rightEdge, (double)px1);
        // A column's photometry is FINAL once the frontier has passed it, so
        // the band scan advances here rather than in stats().
        S.advancePhotoScan(S.highWater);

        // ── OPTION C: FORCE REPLACEMENT OF THE PROVISIONAL LEAD-IN ──────
        // The seed painted a whole footprint and handed the frontier its
        // CENTRE, so `[highWater, leadEndU)` is canvas this frame can see and
        // no frame has yet voted on.  Fill it — a second, NON-ADVANCING commit
        // from the frame that just painted, bounded on the left by the frontier
        // exactly as its own strip was, and on the left AGAIN by `leadFillU`.
        //
        // SINGLE-OWNER, AND THAT IS THE WHOLE DESIGN.  The fill runs strictly
        // forward: `leadFillU` only ever advances, so a provisional column is
        // filled exactly ONCE, by one frame, and every row of that column has
        // the same owner.  The alternative — every frame repainting the whole
        // remaining band, which is what the first cut of this flag did — leaves
        // each surviving pixel owned by whichever mask reached it last, and
        // that made a comb out of a block (see `Impl::leadFillU` for the
        // measurement, and the design review for the pictures).  Filling once is
        // what keeps the boundaries vertical.
        //
        // WHY IT DOES NOT MOVE THE FRONTIER.  Advancing on this paint would
        // hand the band scan columns the strip chain has not swept yet and
        // break the "final behind the frontier" invariant the gain sample, the
        // seam step and the photometric band all rest on.  The frontier stays
        // the strip chain's; this only fills ahead of it.
        //
        // UNDER THE SWEEP'S OWN LAW.  The fill is WIDE — a half footprint in
        // one commit, ~360 canvas px on the operator's packs — and over that
        // span the tangent map and `projection == 1`'s arc map disagree by tens
        // of px at the far edge.  The seed itself is arc-sliced; a tangent-only
        // fill would put its content where the seed's is not.  So it goes
        // through the same slice builder the tail flush and the preview
        // lead-out use, asked about THIS frame, and falls back to the single
        // block only where that law does not apply (`projection != 1`, no
        // rectify, or a sweep the rotation-fraction gate says is a dolly).
        //
        // AFTER the row is populated, deliberately: `commitStrip` overwrites
        // `lastSeam*` on every call, so a fill placed above this point would
        // put its own boundary's numbers in the strip's ledger row.  Nothing
        // here touches `lastBgr`, `lastFu1`, `lastPaintedU`, `gainCum` or the
        // outcome; the fill is pixels and counters only.
        if (S.leadEndU > 0.0) {
            const double lFrom = std::max(S.highWater, S.leadFillU);
            const double lx1 = std::min(fu1, S.leadEndU);
            if (lx1 > lFrom + 0.5) {
                // ONE COMMIT, MANY CALLS — and the block path takes `SliceRun`
                // too, not just the sliced one.  It is what stops `commitStrip`
                // banking each call as its own strip; taking it on BOTH arms
                // means the fill is banked in exactly one place, once, whichever
                // law placed it, so `stripsCommitted` cannot depend on which
                // branch ran.  (Sharing the flag is safe because SliceRun owns
                // it — see its own note.)
                int lp0 = 0, lp1 = 0, lClip = 0;
                bool any = false, declined = false;
                std::vector<Engine::Impl::TailSlice> slices;
                const bool arcFill =
                    S.leadArcSeeded && S.cfg.projection == 1 &&
                    S.arcSlicesAbout(Hint, in.cx, in.cy, lFrom, lx1,
                                     S.cfg.seedArcSlicePx,
                                     /*spanIsCanvas=*/true, &slices);
                {
                    Engine::Impl::SliceRun sliceRun(S);
                    double runLeft = 0.0;
                    const size_t n = arcFill ? slices.size() : (size_t)1;
                    for (size_t i = 0; i < n && !declined; ++i) {
                        const Mat33 h = arcFill ? slices[i].H : Hint;
                        const double left =
                            arcFill ? (any ? std::max(runLeft, slices[i].u0)
                                           : std::max(lFrom, slices[i].u0))
                                    : lFrom;
                        const double right = arcFill ? slices[i].u1 : lx1;
                        int sx0 = 0, sx1 = 0, sClip = 0;
                        double sgs = 1.0;
                        // A false return is `ensureCanvasWidth` refusing, and
                        // the fill can only ask for columns the SEED already
                        // allocated, so it is unreachable here — which is
                        // exactly why it must not abort the session.  Decline
                        // the fill, bank nothing, leave `leadFillU` where it
                        // was: the next frame retries the same span, and a
                        // successfully committed strip is not turned into a
                        // CanvasFull by a fill that could not run.
                        if (!S.commitStrip(*in.bgr, h, left, right, left,
                                           /*doGain=*/false, S.curExpGain,
                                           S.curExpResidual, &sgs, &sx0, &sx1,
                                           &sClip, /*jogGuardEligible=*/false,
                                           /*applyChainGainNoFit=*/true)) {
                            declined = true;
                            break;
                        }
                        lClip += sClip;
                        if (sx1 > sx0) {
                            if (!any) { lp0 = sx0; lp1 = sx1; any = true; }
                            else { lp0 = std::min(lp0, sx0);
                                   lp1 = std::max(lp1, sx1); }
                            runLeft = (double)sx1;
                        }
                    }
                    // Banked INSIDE the run, while `seedLensTally` still holds
                    // this fill's verdict: the destructor only clears
                    // `seedSlicing`, but the next slice run would overwrite the
                    // tally, and a lens verdict read after the fact is a lens
                    // verdict about somebody else's strip.
                    if (any) {
                        ++S.stripsCommitted;
                        if (S.seedLensTally > 0) ++S.lensCorrectedStrips;
                        else if (S.seedLensTally < 0) ++S.lensSkippedStrips;
                    }
                }
                if (any) {
                    row.leadRepaintPx = (double)(lp1 - lp0);
                    ++S.st.leadRepaintStrips;
                    S.st.leadRepaintPx += row.leadRepaintPx;
                    // MONOTONE, and this is the single-owner rule itself.  The
                    // mark follows what was actually COMMITTED, never the
                    // requested edge — the same rule the frontier follows — so
                    // a run whose mask stopped short leaves the remainder for
                    // the next frame instead of silently declaring it filled.
                    S.leadFillU = std::max(S.leadFillU, (double)lp1);
                    if (lClip > 0) {
                        // Counted, never silent — a fill that reached a canvas
                        // edge lost content exactly as a strip would, and
                        // `clippedFrames` was already incremented for this row
                        // above if anything clipped, so only the column total
                        // moves here.
                        if (!row.clipped) {
                            row.clipped = true;
                            ++S.st.clippedFrames;
                            S.st.maxClipTopPx =
                                std::max(S.st.maxClipTopPx, row.clipTopPx);
                            S.st.maxClipBotPx =
                                std::max(S.st.maxClipBotPx, row.clipBotPx);
                        }
                        S.st.clippedColumns += lClip;
                    }
                }
            }
            // SPENT, not merely inactive — and REACHABLE, which the first cut
            // of this clear was not: it sat inside a `leadEndU > highWater`
            // guard and tested that guard's own negation, so it never ran and
            // `leadEndU` stayed positive for the rest of the session.  The band
            // is gone once either water mark has covered it, and the sentinel
            // returns to -1 so `leadEndU < 0` means what its own doc says.
            if (std::max(S.highWater, S.leadFillU) >= S.leadEndU - 0.5) {
                S.leadEndU = -1.0;
                S.leadFillU = -1.0;
                S.leadArcSeeded = false;
            }
        }
        // THE WARPING NUMBER DESCRIBES THE PIXELS THE FRAME COMMITTED — all of
        // them.  `lastAreaScale` is zeroed per frame and raised by every commit
        // including the fill, and `maxAreaScalePainted` already carries the
        // fill's; re-reading it here is what keeps the ledger's own max equal
        // to the session's, which is the identity a pack reader checks.  A
        // no-op when the flag is off: nothing above ran.
        row.areaScale = S.lastAreaScale;
        S.lastPaintedU = ucx;
        ++S.stripsSinceLatch;
        // Trajectory continuation, estimator 1's input: this strip's centre in
        // the axis-latch frame (`ucy` is in the CURRENT canvas frame; every
        // band growth so far is in `vShiftTotal`, so subtracting it puts rows
        // on either side of a growth on one axis).
        if (S.cfg.crossTraj != 0) {
            if (S.stripTrail.empty()) S.firstStripX1 = (double)px1;
            S.stripTrail.push_back(std::make_pair(ucx, ucy - S.vShiftTotal));
        }
        S.lastBgr = *in.bgr;      // shallow — see FrameInput's contract
        S.lastExpGain = S.curExpGain;   // moves WITH lastBgr, always
        S.lastExpResidual = S.curExpResidual;
        S.lastK[0] = in.fx; S.lastK[1] = in.fy;
        S.lastK[2] = in.cx; S.lastK[3] = in.cy;
        S.lastHint = Hint;
        S.lastFu1 = fu1;
        S.lastValid = true;
        S.tailFlushed = false;
        return finishRow(outcome);
    } catch (const cv::Exception&) {
        return finishRow(Outcome::RejectedInput);
    } catch (const std::exception&) {
        return finishRow(Outcome::RejectedInput);
    }
}

FrameOutcome Engine::finish() {
    Impl& S = *impl_;
    FrameOutcome row;
    row.outcome = Outcome::TailFlush;
    row.highWater = S.highWater;
    row.gainCum = S.gainCum;
    row.vShiftPx = S.vShiftTotal;
    const double t0 = nowMs();
    // A SWEEP THAT ENDED BEFORE THE LATCH still has a frame in it.  The motion
    // gate can legitimately hold every frame — the operator stopped early, or
    // never moved decisively — and without this the session would produce no
    // output object AT ALL (finalCanvas() returns false on !anyPainted), which
    // is a worse failure than a one-frame panorama and reads as a crash rather
    // than as "you did not sweep".  Commit the best direction the evidence
    // supports (a zero vote defaults to axis 0 / +1) and emit the reference
    // frame.  latchWasWeak is already the flag that says the vote was thin.
    if (!S.axisLatched && !S.aborted && S.refLatched && !S.refBgr.empty()) {
        S.latchWasWeak = true;
        const char* fatal = nullptr;
        FrameOutcome boot;
        if (S.commitLatch(S.latchTotX, S.latchTotY, boot, &fatal)) {
            S.relatchArmed = false;   // nothing follows this frame
        }
    }
    if (!S.axisLatched || !S.lastValid || S.tailFlushed || S.lastBgr.empty()) {
        row.engineMs = nowMs() - t0;
        return row;
    }
    // Recorded BEFORE the try, so `attempted && !tailFlushed` is exactly "the
    // lead-out threw".  A sweep that never latched has nothing to flush and
    // correctly reports attempted == false — that is not a fault, and the two
    // must not be conflated.
    S.st.tailFlushAttempted = true;
    try {
        const double x1 = std::min(S.lastFu1, (double)S.cfg.canvasMaxWidthPx);
        if (x1 > S.highWater + 0.5) {
            int px0 = 0, px1 = 0, clipCols = 0;
            double gs = 1.0;
            for (int k = 0; k < 4; ++k) S.curK[k] = S.lastK[k];
            S.lastAreaScale = 1.0;
            // THE TAIL FLUSH PAINTS THE LAST PAINTED FRAME, so it carries
            // THAT frame's exposure — 29-48% of the deliverable is this one
            // strip, and normalising it with the current frame's factor would
            // stamp a plateau offset across half the image.
            //
            // ── THE TAIL'S PROJECTION LAW ──────────────────────────────
            // Sliced onto the arc for the SEED's reason: `projection == 1`
            // places strips at f·φ, this block places its own field at f·tan φ,
            // and the two diverge across the block by 76-95 canvas px on the
            // operator's rotating packs.  Under `projection == 0` the strips
            // are on the tangent plane themselves and `lastHint` already IS
            // their law, and under `rectify == false` there is no H_rect
            // anywhere — both keep the block and stay byte-identical, which is
            // what keeps them usable as control arms.
            //
            // THE THIRD CONDITION IS NOT THE SEED'S.  The seed gates on
            // `maxRectifyDeg > 0` because at latch time ψ has not happened yet;
            // the tail runs at the end and can ask the question that one is a
            // proxy for — is this canvas carried by ROTATION at all?  It must,
            // because attitude excursion is not the same thing: a walk with a
            // settling transverse tilt has 6° of it and ψ ≡ 0, its canvas is a
            // planar mosaic, and the arc law compressed one such fixture by 28
            // canvas px.  See Config::tailArcMinRotFrac — including what the
            // bar does NOT settle.
            bool tailArced = false;
            bool tailCanvasFull = false;
            const bool arcGate =
                S.cfg.tailArcSlicePx > 0.0 && S.cfg.projection == 1 &&
                S.cfg.rectify &&
                S.tailArcRotationFraction() >= S.cfg.tailArcMinRotFrac;
            // ── TRAJECTORY CONTINUATION (Config::crossTraj) ────────────
            // Measured BEFORE anything is painted, on the canvas the strips
            // left behind the frontier, under the law this block will get.
            // Then the band is grown for where the sheared block will land —
            // the strip path grows the band for every strip and the tail
            // path never had to, because until now the block went exactly
            // where its frame's own geometry put it.  A declined estimate
            // leaves every line below exactly as it was.
            Impl::CrossTraj traj;
            if (S.cfg.crossTraj != 0) {
                S.crossTrajectory(S.lastBgr, S.lastHint, S.lastK[0], S.lastK[1],
                                  S.lastK[2], S.lastK[3], arcGate,
                                  S.cfg.tailArcSlicePx, S.highWater, -1,
                                  x1 - S.highWater, &traj);
                if (traj.valid) {
                    double tv0 = 0.0, tv1 = 0.0;
                    if (S.trajExtentV(arcGate ? traj : Impl::shearOnly(traj),
                                      S.lastHint, S.highWater, S.highWater, x1,
                                      &tv0, &tv1)) {
                        const double kGuardPx = 1.0;
                        const int needTop =
                            (int)std::ceil(std::max(0.0, kGuardPx - tv0));
                        const int needBot = (int)std::ceil(std::max(
                            0.0, tv1 + kGuardPx - (double)S.canvasH));
                        int addedTop = 0;
                        if ((needTop > 0 || needBot > 0) &&
                            S.ensureCanvasBand(needTop, needBot, &addedTop) &&
                            addedTop > 0) {
                            // `ensureCanvasBand` re-based `lastHint`; the fan
                            // centre is a canvas row and moves with it.
                            traj.fanCentreV += (double)addedTop;
                        }
                    }
                }
                S.st.tailTrajApplied = traj.valid;
                S.st.tailTrajSlope = traj.valid ? traj.slope : 0.0;
                S.st.tailTrajFan = traj.valid ? traj.fan : 0.0;
                S.st.tailTrajStepPx = traj.valid ? traj.stepPx : 0.0;
                S.st.tailTrajStepFan = traj.valid ? traj.stepFan : 0.0;
                S.st.tailTrajSamples = traj.samples;
                S.st.tailTrajBands = traj.bands;
                S.st.tailTrajResponse = traj.valid ? traj.response : 0.0;
                row.crossTrajApplied = traj.valid;
                row.crossTrajSlope = S.st.tailTrajSlope;
                row.crossTrajFan = S.st.tailTrajFan;
                row.crossTrajSamples = traj.samples;
            }
            if (arcGate) {
                const char* tailFatal = nullptr;
                tailArced = S.commitArcTail(S.highWater, x1, S.cfg.gainMatch,
                                            S.lastExpGain, S.lastExpResidual,
                                            &gs, &px0, &px1, &clipCols,
                                            &tailFatal,
                                            traj.valid ? &traj : nullptr);
                // A canvas-full mid-run must NOT fall through to the block: the
                // block would ask the same canvas for the same columns and fail
                // identically, and re-painting the slices already committed
                // under the other law is worse than the partial run.  The
                // single-block path has always answered a false return by
                // painting nothing and setting no abort; this keeps that.
                tailCanvasFull = (!tailArced && tailFatal != nullptr);
            }
            // The single-block path carries the trajectory's SHEAR only: a fan
            // needs slices to compensate u per slice, and this path has one
            // warp.  Identity when the flag is off or the estimate declined.
            const Mat33 blockH =
                traj.valid ? Impl::trajMap(Impl::shearOnly(traj), S.highWater,
                                           S.highWater) * S.lastHint
                           : S.lastHint;
            if (tailArced || (!tailCanvasFull &&
                S.commitStrip(S.lastBgr, blockH, S.highWater, x1,
                              S.highWater, S.cfg.gainMatch, S.lastExpGain,
                              S.lastExpResidual, &gs, &px0, &px1,
                              &clipCols))) {
                row.canvasX0 = px0;
                row.canvasX1 = px1;
                row.gainStep = gs;
                row.gainCum = S.gainCum;
                // The tail flush paints a WHOLE footprint, so it is where the
                // worst area magnification of the session usually lives (the
                // 13.0× floor trapezoid on 15-59-29 is this row).  Leaving
                // row.areaScale at 1.0 made the row that CAUSED the session
                // maximum claim it had seen nothing, so a pack reader could
                // not attribute the number to a strip.
                row.areaScale = S.lastAreaScale;
                row.seamLumaStepDN = S.lastSeamLumaDN;
                row.seamCanvasJogPx = S.lastSeamJogPx;
                row.seamCanvasJogSignedPx = S.lastSeamJogSignedPx;
                row.seamCanvasJogValid = S.lastSeamJogValid;
                row.seamPhotoStepDN = S.lastSeamPhotoDN;
                row.seamPhotoUniform = S.lastSeamPhotoUniform;
                row.seamPhotoSpreadDN = S.lastSeamPhotoSpreadDN;
                row.seamPhotoBands = S.lastSeamPhotoBands;
                row.seamPhotoValid = S.lastSeamPhotoValid;
                row.expGain = S.lastExpGain;
                row.photoScale = S.lastExpResidual * (S.cfg.gainMatch ? S.gainCum : 1.0);
                if (S.cfg.seamMetrics) {
                    ++S.seamStripsCommitted;
                    if (S.lastSeamLumaValid)
                        insertSorted(S.seamLumaSamples, (float)row.seamLumaStepDN);
                    if (row.seamCanvasJogValid) {
                        insertSorted(S.seamJogSamples, (float)row.seamCanvasJogPx);
                        S.noteJogDrift(row.seamCanvasJogSignedPx);
                    }
                    // The tail flush is 29-48% of the deliverable on the
                    // operator's packs — its boundary is a boundary like any
                    // other and must be able to fail the verdict.
                    if (row.seamPhotoValid) {
                        insertSorted(S.seamPhotoSamples,
                                     (float)std::fabs(row.seamPhotoStepDN));
                        if (std::fabs(row.seamPhotoStepDN) > kSeamPhotoStepMaxBarDN)
                            ++S.seamPhotoOverBar;
                        S.noteSeamPhotoStep(px0, row.seamPhotoStepDN,
                                            S.lastSeamPhotoBaseDN,
                                            (double)(px1 - px0),
                                            (double)S.lastSeamSlabW);
                        if (row.seamPhotoUniform < 0.0) {
                            ++S.seamPhotoUniformUnknown;
                        } else {
                            insertSorted(S.seamPhotoSpreadSamples,
                                         (float)row.seamPhotoSpreadDN);
                            if (row.seamPhotoUniform
                                    < S.cfg.photoUniformMinFrac) {
                                ++S.seamPhotoNonUniform;
                            } else {
                                insertSorted(
                                    S.seamPhotoUniSamples,
                                    (float)std::fabs(row.seamPhotoStepDN));
                            }
                        }
                    }
                }
                S.highWater = std::min(x1, (double)px1);
                S.advancePhotoScan(S.highWater);
                if (clipCols > 0) {
                    row.clipped = true;
                    ++S.st.clippedFrames;
                    S.st.clippedColumns += clipCols;
                }
            }
        }
        S.tailFlushed = true;
        S.st.tailFlushed = true;

        // ── THE SEED, THE SAME ROUTINE AT THE OTHER END ────────────────
        // The seed was committed before any strip existed, so its
        // continuation is necessarily retroactive: now that the first strips
        // are on the canvas, the reference frame's FORWARD half is compared
        // against them (dir +1) and the seed's REAR half is re-placed under
        // the trajectory they define.  Runs after the tail so a band growth
        // here cannot move the tail's own measurement, and inside the try so
        // a failure here is reported exactly as a tail failure is.
        // `firstStripX1 > seedCentreU`: a strip must have followed the seed —
        // on a sweep that never painted one, the window ahead of the seed's
        // centre holds the seed's own forward half (and the tail's copy of the
        // same frame), the offset is identically zero, and the "continuation"
        // would be a pointless re-resample of the rear half.
        if (S.cfg.crossTraj != 0 && S.cfg.crossTrajSeed && !S.refKeep.empty() &&
            S.seedCentreU > 0.0 && S.seedX1 > S.seedX0 &&
            S.firstStripX1 > S.seedCentreU) {
            Impl::CrossTraj seedTraj;
            const Mat33 Hs = translate(0.0, S.vShiftTotal) * S.seedHref;
            S.crossTrajectory(S.refKeep, Hs, S.refFx, S.refFy, S.refCx, S.refCy,
                              S.seedArced, S.cfg.seedArcSlicePx, S.seedCentreU,
                              +1, S.seedCentreU - (double)S.seedX0, &seedTraj);
            S.st.seedTrajApplied = false;
            S.st.seedTrajSlope = seedTraj.valid ? seedTraj.slope : 0.0;
            S.st.seedTrajFan = seedTraj.valid ? seedTraj.fan : 0.0;
            S.st.seedTrajStepPx = seedTraj.valid ? seedTraj.stepPx : 0.0;
            S.st.seedTrajStepFan = seedTraj.valid ? seedTraj.stepFan : 0.0;
            S.st.seedTrajSamples = seedTraj.samples;
            S.st.seedTrajRepaintPx = 0.0;
            if (seedTraj.valid) {
                double sv0 = 0.0, sv1 = 0.0;
                if (S.trajExtentV(S.seedArced ? seedTraj
                                              : Impl::shearOnly(seedTraj),
                                  Hs, S.seedCentreU, (double)S.seedX0,
                                  S.seedCentreU, &sv0, &sv1)) {
                    const double kGuardPx = 1.0;
                    const int needTop =
                        (int)std::ceil(std::max(0.0, kGuardPx - sv0));
                    const int needBot = (int)std::ceil(
                        std::max(0.0, sv1 + kGuardPx - (double)S.canvasH));
                    int addedTop = 0;
                    if ((needTop > 0 || needBot > 0) &&
                        S.ensureCanvasBand(needTop, needBot, &addedTop) &&
                        addedTop > 0) {
                        seedTraj.fanCentreV += (double)addedTop;
                    }
                }
                S.st.seedTrajRepaintPx = S.repaintSeedRear(seedTraj);
                S.st.seedTrajApplied = S.st.seedTrajRepaintPx > 0.0;
            }
        }
    // NEVER SILENT.  This block paints 29-48% of the deliverable on the
    // operator's packs (see the comment on the commitStrip call above), and
    // until 2026-08-30 both catches were EMPTY — the identical idiom that hid
    // the empty live preview for eleven days, sitting on the path that
    // produces up to half the panorama.  A throw here still leaves the sweep
    // usable, so it is deliberately not fatal; it is simply no longer
    // invisible.  `tailFlushed` stays false, the reason is kept verbatim, and
    // both reach the status dict, meta.json and the summary.
    } catch (const cv::Exception& e) {
        S.st.tailFlushError = std::string("cv::Exception: ") + e.what();
    } catch (const std::exception& e) {
        S.st.tailFlushError = std::string("std::exception: ") + e.what();
    } catch (...) {
        S.st.tailFlushError = "unknown native failure";
    }
    // FINAL FLUSH.  Mid-sweep the band scan deliberately stops at the frontier
    // because everything ahead of it is provisional and will be overwritten.
    // The sweep is over now, so whatever is still ahead of the frontier IS the
    // deliverable — on the operator's packs that is a 24-29% single-frame
    // block — and it must be inside the number that gates the pack.
    if (S.anyPainted) S.advancePhotoScan((double)S.maxPaintedU + 1.0);
    row.highWater = S.highWater;
    row.engineMs = nowMs() - t0;
    return row;
}

int Engine::canvasHeightPx() const noexcept { return impl_->canvasH; }

int Engine::previewCrossPx(bool cropPadRows) const noexcept {
    const Impl& S = *impl_;
    if (S.canvasH <= 0) return 0;
    if (!cropPadRows || !S.anyPaintedV) return S.canvasH;
    // The SAME row-union trim `previewIntoWindowed` applies (:2385 there), and
    // the same 8-row degeneracy floor: a band thinner than that is a tracker
    // bug, and both sites fall back to the full height rather than trust it.
    // If one of them changes, this one has to move with it — a window sized
    // off a cross the publish does not use is the artefact this method exists
    // to remove.
    const int v0 = std::max(0, std::min(S.minPaintedV, S.canvasH));
    const int v1 = std::max(v0, std::min(S.maxPaintedV, S.canvasH));
    return (v1 - v0 >= 8) ? (v1 - v0) : S.canvasH;
}

bool Engine::previewInto(cv::Mat& out, int maxW, int maxH) const {
    return previewIntoWindowed(out, maxW, maxH, 0, nullptr, false, false);
}

/// The one renderer both preview entry points share.  `windowAlongPx <= 0`
/// reproduces the pre-window behaviour EXACTLY (the roi is the whole painted
/// band and `win` reports view == band), which is what keeps every existing
/// caller and every existing test byte-identical.
bool Engine::previewIntoWindowed(cv::Mat& out, int maxW, int maxH,
                                 int windowAlongPx, PreviewWindow *win,
                                 bool cropPadRows, bool leadOut) const {
    const Impl& S = *impl_;
    if (maxW < 8 || maxH < 8) return false;

    // ── THE PRE-LATCH SEED — "the preview does not show up when I hold the
    //    button, I need to start moving for it to appear.  Why?" ─────────────
    //
    // Because until 2026-09-03 the next line was the whole answer.
    // `paintedBand` returns false while `!anyPainted`, `anyPainted` is set in
    // exactly one place (`commitStrip`, reached from `commitLatch`'s bootstrap
    // paint), and `commitLatch` is gated on MOTION: the axis latch holds for
    // `axisLatchFrames` and then refuses to fire until `totMag >=
    // latchTotalPx` (24 canvas px).  A stationary phone therefore paints
    // nothing, there is no canvas, and every preview attempt is refused.
    //
    // MEASURED on the operator's own five 2026-09-01 packs (ledger.jsonl,
    // first row with canvasX1 > 0), and this is WITH him panning promptly:
    // 817 / 950 / 600 / 667 / 634 ms of blank panel.  Held still the bound is
    // `axisLatchMaxFrames / fps` = 240/60 = 4.0 s.  "This is creating the
    // issue of not knowing where the pano starts" is exactly that window.
    //
    // THE PIXELS WERE ALREADY HERE.  `refBgr` is cloned at the REFERENCE latch
    // (see its clone site: "this one frame is held across the axis-latch
    // window and is the bootstrap lead-in's pixels") and released inside
    // `commitLatch` once it has been painted — so it is non-empty over exactly
    // `[reference latch, axis latch)`, which is exactly the blank window.
    // Showing it is not a new capability, it is publishing a frame the engine
    // already holds.
    //
    // WHY A PREVIEW-ONLY SEED AND NOT AN EARLY LATCH.  Latching early would
    // vote axis and sign on no evidence, pick axis 0 / +1 by default — and all
    // five of his packs are axis 1.  The relatch would then fire and
    // `reseedReferenceTo` THROWS THE CANVAS AWAY and rebuilds it, so he would
    // watch the preview appear and then reset.  That is worse than the wait.
    //
    // NOTHING ELSE IS TOUCHED.  This method is `const`; it writes no engine
    // state, casts no latch vote, moves no `highWater`, burns no relatch
    // budget and cannot reach the aliasing cage (`maxAdvancePx` /
    // `corrLimitPx` bound REGISTRATION, and nothing here registers).  The
    // DELIVERABLE is `finalCanvas`, which still refuses on `!anyPainted`, so
    // every parity fixture is byte-identical.
    if (!S.anyPainted) {
        if (S.refBgr.empty()) return false;
        // AND NOT AFTER AN ABORT.  `abort()` (:2910-2915) sets the flag and
        // never releases `refBgr`, and a tracking abort is reachable with
        // `anyPainted == false` (a `maxTranslationJumpM` step — ARKit
        // relocalising onto a new world origin — fires "session-restart" at
        // :3153 before the AXIS latch has run).  Without this clause the panel
        // would then show a frozen camera frame FOREVER, as the panorama, for
        // a sweep that will produce no canvas: `finalCanvas` still refuses on
        // `!anyPainted`, so the picture and the deliverable would disagree.
        // On Android it is worse than cosmetic — `PreviewPump::flush`
        // (rnis_pano_android_preview.cpp:368-378) would take its true branch
        // and publish that frame as the FINAL preview into the pack,
        // contradicting its own "an aborted or empty sweep has no panorama".
        // `finish()`'s bootstrap already guards on `aborted` for exactly this
        // reason (:4014); the seed simply has to agree with it.
        if (S.aborted) return false;
        // `orient` is whatever the latched axis/sign say.  On the FIRST latch
        // those are still their initial values (axis 0, sign +1) so it is a
        // plain copy and the seed lands in the camera raster frame — the same
        // frame every published preview is in, so the SDK's one quarter turn
        // on screen still applies unchanged.  After a RELATCH they are the
        // previous latch's values (`commitLatch` clears `anyPainted` at :2451
        // with both already set), which is the same transform the very next
        // committed frame will use — so the seed still cannot disagree with
        // what follows it.
        const double sc = std::min(1.0,
            std::min((double)maxW / (double)S.refBgr.cols,
                     (double)maxH / (double)S.refBgr.rows));
        cv::Mat small;
        if (sc >= 0.999) {
            small = S.refBgr;
        } else {
            const int w = std::max(1, (int)std::lround(S.refBgr.cols * sc));
            const int h = std::max(1, (int)std::lround(S.refBgr.rows * sc));
            cv::resize(S.refBgr, small, cv::Size(w, h), 0, 0, cv::INTER_AREA);
        }
        if (win != nullptr) {
            // EXPLICIT, not defaulted: the caller reuses one `PreviewWindow`
            // across ticks, so leaving these would publish the previous
            // sweep's numbers under this frame.  There is no band, no window
            // and no frontier yet, and `-1.0` is already this field's "nothing
            // to place" encoding.
            win->bandStartU = 0; win->bandEndU = 0;
            win->viewStartU = 0; win->viewEndU = 0;
            win->leadOutPx = 0;
            win->frontierU = 0.0;
            win->frontierFrac = -1.0;
            win->windowed = false;
            win->canvasCrossPx = 0; win->viewCrossPx = 0;
            // Same reason as the block above: the caller reuses one struct,
            // and there is no live footprint on the seed path (nothing has
            // been painted, so `lastValid` is false by construction).
            win->liveValid = false;
            win->lastFu1U = -1.0; win->leadClampU = -1.0;
            win->leadEndU = -1.0; win->leadArc = false;
            // And the lead-out's own start, trajectory and pad — the fields
            // the elbow fix added.  The block that fills them did not run
            // here, so they take the same "did not run" values it reports:
            // -1.0 for the start, nothing overwritten, no trajectory applied,
            // no pad.  Left alone, a window that carried a sheared, padded
            // lead-out on the previous tick kept saying so under the seed.
            win->leadStartU = -1.0; win->leadOverwritePx = 0;
            win->leadTrajApplied = false;
            win->leadTrajSlope = 0.0; win->leadTrajFan = 0.0;
            win->leadPadTopPx = 0; win->leadPadBotPx = 0;
        }
        S.orient(small, out);
        return !out.empty();
    }

    cv::Rect roi;
    // cropVertical is deliberately NOT applied on the preview path: its
    // per-column coverage scan is a finalize-time cost, and the operator
    // wants to SEE the ragged edge while sweeping.
    if (!S.paintedBand(roi, false)) return false;

    // ── THE FRONTIER WINDOW ─────────────────────────────────────────────────
    // Trailing `windowAlongPx` canvas px ending at the band's LEADING edge.
    // Leading, not `highWater`: the strip immediately behind the frontier is
    // the freshest committed pixels, and anchoring on the frontier itself
    // would slide the newest content off the far side of the panel the moment
    // it landed.  The frontier is REPORTED (frontierFrac) rather than used as
    // the anchor — the marker moves, the picture does not lurch.
    const int canvasCross = roi.height;
    // ── THE UNPAINTED PAD ───────────────────────────────────────────────────
    // The canvas is one frame's footprint plus TWO pads (1920 x 0.5 + 2 x 128
    // = 1216 rows on the operator's packs), and 256 of those rows — 21% — are
    // pad that nothing ever paints.  The live preview took all of them, so a
    // fifth of his panel was black bars AND, because the panel hugs the
    // preview's aspect, the shelf itself was drawn 21% smaller than the phone
    // was willing to draw it.  This trims the row UNION, so no committed pixel
    // can be lost and the ragged rectified edge stays visible.
    if (cropPadRows && S.anyPaintedV) {
        const int v0 = std::max(roi.y, std::min(S.minPaintedV, roi.y + roi.height));
        const int v1 = std::max(v0, std::min(S.maxPaintedV, roi.y + roi.height));
        // A degenerate band is a bug in the tracker, not a reason to render a
        // sliver: fall back to the full height rather than trusting it.
        if (v1 - v0 >= 8) { roi.y = v0; roi.height = v1 - v0; }
    }
    const int bandStart = roi.x, bandEnd = roi.x + roi.width;
    int viewStart = bandStart, viewEnd = bandEnd;
    if (windowAlongPx > 0 && roi.width > windowAlongPx) {
        viewStart = bandEnd - windowAlongPx;
        roi.x = viewStart;
        roi.width = windowAlongPx;
    }

    // ── v12: THE PROVISIONAL LEAD-OUT, PREVIEW ONLY ─────────────────────────
    // Strips commit only up to the frame's projected CENTRE, so the operator
    // is always LOOKING at half a field of view (42.8° on the ultra-wide) that
    // no preview carries — his 2026-08-31 report, verbatim: "the image is
    // behind where my phone is pointing".  The exact region the tail flush
    // will commit at stop is warped here from the LIVE frame into the preview,
    // DIMMED so it reads as provisional, and the frontier marker divides
    // committed from provisional exactly.  The canvas is never touched: the
    // scratch below is preview-local, so the deliverable and every parity
    // check stay byte-identical, and `leadOut == false` (every pre-existing
    // caller) skips this block entirely.
    //
    // NO exposure gain on the provisional pixels: `applyExposureGain` mutates
    // cached state on a path that must stay const, and on a LOCKED sweep the
    // factor is 1 anyway.
    //
    // ⚠ AND NO DIM EITHER, SINCE 2026-09-03.  These columns used to be
    // multiplied by 0.82 so "a reader cannot mistake [them] for committed
    // output".  The operator read the 18% luminance step as a second boundary
    // and said so: "There are 2 changing boundaries in the preview - which I
    // do not understand what they are... Make it like how iOS pano shows the
    // preview! Just the preview of what output looks like - the exact image
    // you are going to get as the result."
    //
    // He is right on the substance, not only the aesthetics.  This region is
    // not a guess about the output — it is the SAME PIXELS the deliverable
    // gets: the tail flush in `finish()` commits `lastBgr` through `lastHint`
    // out to the same `min(lastFu1, canvasMaxWidthPx)` bound this block warps.
    // Compare the two directly; they differ only in that one writes the canvas.
    // Marking them as "not the output" was the inaccuracy.
    //
    // The justification for the dim was an UNLOCKED sweep, where provisional
    // could sit a few percent off its committed neighbour.  Measured across
    // all five of his 2026-09-01 packs: `expGain` is 1.0000 on every one of
    // 1,128 painted frames — the sweep is AE-locked and the two regions are
    // photometrically identical, so the 0.82 was the ONLY thing making them
    // look different.  If an unlocked sweep is ever shipped, the honest fix is
    // to apply the gain, not to darken correct pixels.
    cv::Mat scratch;                 // outlives `band` below, which may view it
    cv::Mat band;
    int leadPx = 0;
    // Reported, not used: the provisional end this render RESOLVED, and which
    // law resolved it.  Captured here because the `win` fill is below the
    // block and these are local to it.  -1 / false ⇒ the block did not run.
    double leadEndReport = -1.0;
    bool   leadArcReport = false;
    double leadStartReport = -1.0;
    int    leadOverwrite = 0;
    Impl::CrossTraj leadTraj;
    int    leadPadTop = 0, leadPadBot = 0;
    if (leadOut && S.axisLatched && S.lastValid && !S.tailFlushed
        && !S.lastBgr.empty() && !S.onesMask.empty()) {
        const double leadX1 =
            std::min(S.lastFu1, (double)S.cfg.canvasMaxWidthPx);
        // ── THE LEAD-OUT USES THE TAIL'S LAW, OR IT IS NOT THE OUTPUT ──
        // The paragraph above promises these columns ARE the pixels the
        // deliverable gets.  Once `finish()` places this frame's field on the
        // arc, a lead-out that warps it through the raw `lastHint` shows a
        // block 76-95 px longer than the one that will be committed, and the
        // last thing the operator sees before the result is a region that then
        // visibly contracts.  The slices come from the SAME builder the commit
        // uses; when it declines (`projection == 0`, no rectify, a translation
        // sweep, `tailArcSlicePx == 0`) this falls back to the single warp and
        // is byte-identical to what shipped.
        std::vector<Impl::TailSlice> leadSlices;
        const bool arcGate =
            S.cfg.tailArcSlicePx > 0.0 && S.cfg.projection == 1 &&
            S.cfg.rectify &&
            S.tailArcRotationFraction() >= S.cfg.tailArcMinRotFrac;
        const bool leadArced =
            arcGate && S.tailArcSlices(S.highWater, leadX1, &leadSlices);
        const double leadEndU = leadArced ? leadSlices.back().u1 : leadX1;
        leadEndReport = leadEndU;
        leadArcReport = leadArced;
        const int extEnd = (int)std::ceil(leadEndU);
        const int committedEnd = roi.x + roi.width;
        // ── WHERE THE LIVE PAINT BEGINS (Config::leadOutFromFrontier) ──
        // Off: the appended columns only, as v12 shipped.  On: from the first
        // column no strip has committed — `ceil(highWater)`, because strips
        // commit to `ceil(rightEdge)` and `floor(highWater)` is theirs — so
        // the seed's stale provisional band between the frontier and the
        // band end is overwritten by the live frame and the preview carries
        // ONE boundary, at the frontier.  See the Config note for the
        // measurement behind it (his two lines were exactly these two edges).
        const int pStart =
            S.cfg.leadOutFromFrontier
                ? std::max(roi.x, std::min(committedEnd,
                                           (int)std::ceil(S.highWater)))
                : committedEnd;
        if (leadEndU > S.highWater + 0.5 && extEnd > pStart) {
            leadPx = std::max(0, extEnd - committedEnd);
            leadOverwrite = std::max(0, std::min(committedEnd, extEnd) - pStart);
            leadStartReport = (double)pStart;
            const int extW = roi.width + leadPx;
            // ── THE TAIL'S TRAJECTORY (Config::crossTraj), FIRST ───────
            // The same estimate `finish()` will make on this state, so the
            // provisional columns are the columns the flush will commit —
            // measured before the scratch is sized, because the sheared block
            // decides how tall the scratch has to be.  `leadOutTraj` off is
            // the cheap route: no estimate, so `leadTraj` stays invalid and
            // every branch below takes the plain `lastHint` — placed from
            // the same frontier, through the same lens, no shear, no fan,
            // no pad.  The flush reads `crossTraj` alone, so the committed
            // canvas is the same either way.
            if (S.cfg.crossTraj != 0 && S.cfg.leadOutTraj) {
                S.crossTrajectory(S.lastBgr, S.lastHint, S.lastK[0], S.lastK[1],
                                  S.lastK[2], S.lastK[3], arcGate,
                                  S.cfg.tailArcSlicePx, S.highWater, -1,
                                  leadEndU - S.highWater, &leadTraj);
            }
            // ── AND THE SCRATCH IS GROWN FOR IT, as the flush grows the
            // band: the same `trajExtentV` the flush asks, the same 1 px
            // guard, bounded by the same `canvasMaxHeightPx` the flush's
            // growth is.  The SCRATCH only — see below for why the published
            // band is not.
            //
            // ⚠ THE PUBLISHED SIZE IS NOT THIS KNOB'S TO CHANGE (2026-09-07).
            // A previous cut widened the visible band as well, "to the block's
            // reach", so the sheared lead-out was published uncropped.  The
            // trajectory is re-fitted on EVERY tick, so its extent — and with
            // it the pad, and with it the published cross extent — moved on
            // every tick; and because `previewIntoFit` fits into a fixed box
            // with the aspect preserved, a wider cross also shrank the
            // along-sweep height.  Field, iPhone, 2026-09-07: the panel jumped
            // thin/wide/tall/short as the operator swept.  Replayed offline on
            // that pack: imageH 459..800 and viewCrossPx 979..1145 bouncing,
            // 41 size changes in 45 ticks, against a monotonic 498..661 /
            // 978..995 with `leadOutTraj` off.  The rule now: the pads size
            // the scratch the sheared block is painted into, and the published
            // view is cropped back to the SAME rows `leadOutTraj = false`
            // publishes on this tick (`roi`, the row union or the canvas) —
            // the content inside it may follow the trajectory, its extent may
            // not.  A block reaching past those rows is clipped in the preview
            // exactly as the row-union crop clips the committed edge, and the
            // pads are still reported (`leadPadTopPx` / `leadPadBotPx`) so a
            // pack says how far it reached.
            if (leadTraj.valid) {
                double tv0 = 0.0, tv1 = 0.0;
                if (S.trajExtentV(leadArced ? leadTraj : Impl::shearOnly(leadTraj),
                                  S.lastHint, S.highWater, S.highWater, leadEndU,
                                  &tv0, &tv1)) {
                    const double kGuardPx = 1.0;
                    int padTop = (int)std::ceil(std::max(0.0, kGuardPx - tv0));
                    int padBot = (int)std::ceil(
                        std::max(0.0, tv1 + kGuardPx - (double)S.canvasH));
                    const int room = std::max(0, S.cfg.canvasMaxHeightPx - S.canvasH);
                    if (padTop + padBot > room) {
                        if (padTop <= room) padBot = room - padTop;
                        else { padTop = room; padBot = 0; }
                    }
                    leadPadTop = padTop;
                    leadPadBot = padBot;
                }
            }
            const int scratchH = S.canvasH + leadPadTop + leadPadBot;
            scratch = cv::Mat::zeros(scratchH, extW, CV_8UC3);
            S.canvas(cv::Rect(roi.x, 0, roi.width, S.canvasH))
                .copyTo(scratch(cv::Rect(0, leadPadTop, roi.width, S.canvasH)));
            // Provisional owns the columns from `pStart`.  With the flag off
            // that is ONLY the appended columns — not "from the frontier":
            // `floor(highWater)` sits a column or two inside the committed
            // band (strips paint to `ceil(rightEdge)`), and painting from
            // there overwrote committed pixels with dimmed live ones — caught
            // by the byte-identity test, 33 DN of drift on the last committed
            // columns.  With the flag on the stale band inside it is painted
            // OVER, not cleared: where the live frame's mask reaches, the
            // seed's pixels are replaced; where it does not (the cross
            // corners), they stay — see Config::leadOutFromFrontier for the
            // notch that clearing left.
            const cv::Rect pr(pStart - roi.x, 0, extW - (pStart - roi.x),
                              scratchH);
            cv::Mat warped, wmask, lensScratch;
            // Warps ONLY the destination columns `dst` covers.  A slice run
            // that warped the full width each time would do ~46 full-canvas
            // resamples per preview frame; this does the same total pixel work
            // as the single warp it replaces, which is what keeps the lead-out
            // affordable on the live path it renders from.
            //
            // THROUGH THE LENS when `leadOutFromFrontier` is on: the flush
            // commits this frame lens-corrected (v10), and a lead-out warped
            // plain differs from it by the field — up to 23 px at the corners
            // on the 09-05 packs — which is a registration line at the very
            // frontier this flag exists to make seamless.  Off, the plain
            // warp v12 shipped, byte for byte.
            auto paintInto = [&](const Mat33& H, const cv::Rect& dstRect) {
                const Mat33 Hp =
                    translate(-(double)(roi.x + dstRect.x), (double)leadPadTop) * H;
                if (S.cfg.leadOutFromFrontier) {
                    // `resampleFrame` sizes its output by the CANVAS height;
                    // the scratch may be taller, so the pad is folded into
                    // a canvas-height ROI placed at the pad offset.
                    cv::Mat sub = scratch(dstRect);
                    cv::Mat bgrK, maskK;
                    S.resampleFrame(S.lastBgr, Hp, dstRect.width,
                                    S.lastK[0] > 1.0 ? S.lastK[0] : S.refFx,
                                    S.lastK[1] > 1.0 ? S.lastK[1] : S.refFy,
                                    S.lastK[0] > 1.0 ? S.lastK[2] : S.refCx,
                                    S.lastK[1] > 1.0 ? S.lastK[3] : S.refCy,
                                    lensScratch, &bgrK, &maskK, scratchH);
                    bgrK.copyTo(sub, maskK);
                    return;
                }
                cv::warpPerspective(S.lastBgr, warped, cv::Mat(Hp),
                                    cv::Size(dstRect.width, scratchH),
                                    cv::INTER_LINEAR, cv::BORDER_CONSTANT,
                                    cv::Scalar());
                cv::warpPerspective(S.onesMask, wmask, cv::Mat(Hp),
                                    cv::Size(dstRect.width, scratchH),
                                    cv::INTER_NEAREST, cv::BORDER_CONSTANT,
                                    cv::Scalar());
                cv::Mat dst = scratch(dstRect);
                // Straight copy — see the dim's obituary above.
                warped.copyTo(dst, wmask);
            };
            if (leadArced) {
                // Each slice writes only its OWN canvas span, intersected with
                // the provisional region — the preview's equivalent of the
                // commit's `runLeft` walk, and the reason a slice cannot smear
                // its outer field across its neighbour's columns.
                int runLeft = pr.x;
                for (size_t i = 0; i < leadSlices.size(); ++i) {
                    const int sx0 = std::max(runLeft,
                        (int)std::floor(leadSlices[i].u0) - roi.x);
                    const int sx1 = std::min(pr.x + pr.width,
                        (int)std::ceil(leadSlices[i].u1) - roi.x);
                    if (sx1 <= sx0) continue;
                    const Mat33 Hk =
                        leadTraj.valid
                            ? Impl::trajMap(leadTraj, S.highWater,
                                            0.5 * (leadSlices[i].u0 +
                                                   leadSlices[i].u1)) *
                                  leadSlices[i].H
                            : leadSlices[i].H;
                    paintInto(Hk, cv::Rect(sx0, 0, sx1 - sx0, scratchH));
                    runLeft = sx1;
                }
            } else {
                paintInto(leadTraj.valid
                              ? Impl::trajMap(Impl::shearOnly(leadTraj),
                                              S.highWater, S.highWater) *
                                    S.lastHint
                              : S.lastHint,
                          pr);
            }
            // The visible band is `roi`'s rows — the unpadded band, at the
            // pad's offset into the scratch — so `drawH` below is `roi.height`
            // on every tick, pad or no pad, trajectory or not.  With
            // `leadOutTraj` off both pads are 0 and this is the same view of
            // the same scratch it always was.
            band = scratch(cv::Rect(0, roi.y + leadPadTop, extW, roi.height));
        }
    }
    if (band.empty()) band = S.canvas(roi);
    const int drawW = roi.width + leadPx;
    const int drawH = band.rows;

    if (win != nullptr) {
        // v12 — `viewEndU` includes the provisional lead-out (`leadOutPx`
        // says how much), so the frontier fraction below lands the marker
        // exactly on the committed/provisional boundary of the PUBLISHED
        // image rather than at its right edge.
        const int renderEnd = viewEnd + leadPx;
        win->bandStartU = bandStart; win->bandEndU = bandEnd;
        win->viewStartU = viewStart; win->viewEndU  = renderEnd;
        win->leadOutPx  = leadPx;
        win->frontierU  = S.highWater;
        win->windowed   = (viewStart != bandStart) || (viewEnd != bandEnd);
        win->canvasCrossPx = canvasCross;
        win->viewCrossPx   = drawH;   // the band; never a lead-out pad (09-07)
        // v14 — the live frame's footprint, reported whether or not the
        // lead-out ran, so "the frontier" and "the frame's far edge" are two
        // MEASURED numbers rather than one number and an inference.  The clamp
        // is the same `min(lastFu1, canvasMaxWidthPx)` the lead-out block and
        // `finish()`'s tail flush both take.
        win->liveValid = (S.lastValid && !S.tailFlushed);
        win->lastFu1U   = win->liveValid ? S.lastFu1 : -1.0;
        win->leadClampU = win->liveValid
            ? std::min(S.lastFu1, (double)S.cfg.canvasMaxWidthPx)
            : -1.0;
        win->leadEndU = leadEndReport;
        win->leadArc  = leadArcReport;
        win->leadStartU = leadStartReport;
        win->leadOverwritePx = leadOverwrite;
        win->leadTrajApplied = leadTraj.valid;
        win->leadTrajSlope = leadTraj.valid ? leadTraj.slope : 0.0;
        win->leadTrajFan = leadTraj.valid ? leadTraj.fan : 0.0;
        win->leadPadTopPx = leadPadTop;
        win->leadPadBotPx = leadPadBot;
        const double span = (double)(renderEnd - viewStart);
        if (span > 0.0 && S.highWater >= (double)viewStart
                       && S.highWater <= (double)renderEnd) {
            const double f = (S.highWater - (double)viewStart) / span;
            // `orient` flips the along axis for a negative sweep sign, so the
            // fraction has to flip with it or the marker lands at the wrong
            // end of the image on half the holds.
            win->frontierFrac = (S.sweepSign >= 0) ? f : (1.0 - f);
        } else {
            win->frontierFrac = -1.0;
        }
    }

    // Orientation swaps the axes for a vertical sweep, so the fit must be
    // computed against the ORIENTED extents.  `drawW`, not `roi.width`: the
    // provisional lead-out is part of the image being fitted.
    const int orientedW = (S.axis == 0) ? drawW : drawH;
    const int orientedH = (S.axis == 0) ? drawH : drawW;
    const double sc = std::min(1.0, std::min((double)maxW / (double)orientedW,
                                             (double)maxH / (double)orientedH));
    cv::Mat small;
    if (sc >= 0.999) {
        small = band;
    } else {
        // Downscale the BAND (a view) first: orienting the full painted canvas
        // every preview tick would copy megabytes on the live path.
        const int w = std::max(1, (int)std::lround(drawW * sc));
        const int h = std::max(1, (int)std::lround(drawH * sc));
        cv::resize(band, small, cv::Size(w, h), 0, 0, cv::INTER_AREA);
    }
    S.orient(small, out);
    return !out.empty();
}

bool Engine::previewIntoFit(cv::Mat& out, int maxAlong, int maxCross,
                            int windowAlongPx, PreviewWindow *win,
                            bool cropPadRows, bool leadOut) const {
    // The ONE line of this function is the whole fix: the box turns with the
    // sweep.  `previewInto` is left exactly as it was — its box is in oriented
    // output terms and there are callers (and a test) that mean it that way.
    //
    // `axis` is 0 until the latch commits.  That USED to be the window in
    // which nothing was published, so the pre-latch mapping was unobservable;
    // the pre-latch seed above (2026-09-03) makes it observable, and it always
    // takes the axis-0 route.  Safe, but not free: a 1920x1080 raster through
    // (maxAlong=2000, maxCross=800) fits to 1422x800, where the same raster
    // after an axis-1 latch fits to 800x450 through (800, 2000).  Both are
    // aspect-preserving and inside the box — the seed is simply published at a
    // higher resolution than the strips that follow it, and the SDK's
    // `contain` fit absorbs the difference.  Re-check that arithmetic if the
    // preview box is ever narrowed; it is what keeps the seed unclipped.
    const int axis = impl_->axis;
    return (axis == 0)
        ? previewIntoWindowed(out, maxAlong, maxCross, windowAlongPx, win,
                              cropPadRows, leadOut)
        : previewIntoWindowed(out, maxCross, maxAlong, windowAlongPx, win,
                              cropPadRows, leadOut);
}

bool Engine::finalCanvas(cv::Mat& out, bool cropPadRows,
                         int* cropCrossLoPx, int* cropCrossHiPx) const {
    return impl_->renderOriented(out, impl_->cfg.cropVertical, cropPadRows,
                                 cropCrossLoPx, cropCrossHiPx);
}

bool Engine::finalCoverage(cv::Mat& out, bool cropPadRows) const {
    return impl_->renderOriented(out, impl_->cfg.cropVertical, cropPadRows,
                                 nullptr, nullptr, &impl_->coverage);
}

SessionStats Engine::stats() const {
    Impl& S = *impl_;
    SessionStats s = S.st;
    s.canvasW = S.canvasW;
    s.canvasH = S.canvasH;
    s.axis = S.axis;
    s.sweepSign = S.sweepSign;
    s.axisLatched = S.axisLatched;
    s.referenceLatched = S.refLatched;
    s.stalled = S.stalled;
    for (int k = 0; k < 4; ++k) s.refQuat[k] = S.refQuat[k];
    s.refFx = S.refFx; s.refFy = S.refFy; s.refCx = S.refCx; s.refCy = S.refCy;
    s.maxRectifyDeg = S.maxRectifyDeg;
    s.maxAdvancePxResolved = S.maxAdvancePx;
    s.corrCentroidBoxResolved = S.corrCentroidBox;
    s.corrWindowW = S.winW;
    s.corrWindowH = S.winH;
    s.corrOriginClampedFrames = S.corrOriginClamped;
    // REGIME — project the two channels onto the latched sweep axis.  A is
    // orthogonal and axis-aligned, so this is a select-and-sign, not a warp.
    {
        const double sgn = (S.sweepSign < 0) ? -1.0 : 1.0;
        s.rotTravelPx = sgn * ((S.axis == 0) ? S.rotNetX : S.rotNetY);
        s.resTravelPx = sgn * ((S.axis == 0) ? S.resNetX : S.resNetY);
        s.rotPathPx   = (S.axis == 0) ? S.rotPathX : S.rotPathY;
        s.resPathPx   = (S.axis == 0) ? S.resPathX : S.resPathY;
        const double denom = s.rotPathPx + s.resPathPx;
        s.rotationFraction = (denom > 1e-9) ? (s.rotPathPx / denom) : 0.0;
        s.latchFramesUsed = S.latchFrames;
        s.latchWasWeak = S.latchWasWeak;
        s.latchRotPx[0] = S.latchRotX; s.latchRotPx[1] = S.latchRotY;
        s.latchTotPx[0] = S.latchTotX; s.latchTotPx[1] = S.latchTotY;
        s.relatchCount = S.relatchCount;
    }
    // ── v5: PROJECTION, WARPING, THE CUT METRIC ─────────────────────────
    s.projection = S.cfg.projection;
    s.maxAreaScalePainted = S.maxAreaScalePainted;
    s.maxCrossRectifyDeg = S.maxCrossRectifyDeg;
    s.sweepDeg = S.maxPsiDeg - S.minPsiDeg;
    // NO SORT, NO COPY, NO CACHE: the sample vectors are sorted at insert.
    // `maxOf` reads back() — which is the maximum because the vector really is
    // sorted, not because percentileOf happened to sort it on the line above
    // (an ordering dependency that turns "max" into "last sample" the moment
    // the lines move).
    auto maxOf = [](const std::vector<float>& v) {
        return v.empty() ? 0.0 : (double)v.back();
    };
    s.seamWorstBandP50Px  = percentileOf(S.seamWorstSamples, 50.0);
    s.seamWorstBandP95Px  = percentileOf(S.seamWorstSamples, 95.0);
    s.seamWorstBandMaxPx  = maxOf(S.seamWorstSamples);
    s.seamBandSpreadP95Px = percentileOf(S.seamSpreadSamples, 95.0);
    s.seamLumaStepP50DN   = percentileOf(S.seamLumaSamples, 50.0);
    s.seamLumaStepP95DN   = percentileOf(S.seamLumaSamples, 95.0);
    s.seamLumaStepMaxDN   = maxOf(S.seamLumaSamples);
    s.seamCanvasJogP50Px  = percentileOf(S.seamJogSamples, 50.0);
    s.seamCanvasJogP95Px  = percentileOf(S.seamJogSamples, 95.0);
    s.seamCanvasJogMaxPx  = maxOf(S.seamJogSamples);
    s.seamCanvasJogSamples = (int64_t)S.seamJogSamples.size();
    s.seamJogDriftPx      = S.jogAccMax - S.jogAccMin;
    s.seamJogDriftEndPx   = S.jogAcc;
    s.seamJogDriftSamples = S.jogAccN;
    s.seamBoundaries = (int64_t)S.seamWorstSamples.size();
    s.seamCoverageFrac =
        (S.seamStripsCommitted > 0)
            ? ((double)s.seamBoundaries / (double)S.seamStripsCommitted)
            : 0.0;
    if (!S.bandErrCum.empty()) {
        double lo = S.bandErrCum[0], hi = S.bandErrCum[0];
        for (double v : S.bandErrCum) { lo = std::min(lo, v); hi = std::max(hi, v); }
        s.crossBandDivergencePx = hi - lo;
    }
    // sqrt(n)-NORMALISED, and that is the gated number.  The raw sum is a
    // random walk: a driftless one grows as sqrt(n), so an absolute bar on it
    // fails a long sweep for being long (measured on 15-58-22, truncated:
    // 1.6 / 3.1 / 19.5 / 52.4 px at 73 / 107 / 192 / 318 boundaries).
    // Dividing by sqrt(n) is stationary under noise at any length and still
    // grows as sqrt(n) under a genuine systematic bias.
    s.crossBandDivergenceNormPx =
        (s.seamBoundaries > 0)
            ? (s.crossBandDivergencePx / std::sqrt((double)s.seamBoundaries))
            : 0.0;
    // NOT MEASURED is its own state and must never read as CLEAN.  BOTH
    // instruments are required: the band metric is the only one that sees
    // progressive shear (the divergence clause) and the jog is the only one
    // that reads committed pixels, so a session carrying just one of them is
    // partially blind, not clean.
    s.seamMeasured = (s.seamBoundaries > 0) && (s.seamCanvasJogSamples > 0);
    s.gainCumEnd = S.gainCum;

    // ── v6: RADIOMETRIC NORMALISATION + THE PHOTOMETRIC SEAM + THE BAND ──
    s.exposureMetaFrames    = S.exposureMetaFrames;
    s.exposureClampedFrames = S.exposureClampedFrames;
    s.exposureRefValue      = S.refExposure;
    s.exposureMinValue      = S.exposureMin;
    s.exposureMaxValue      = S.exposureMax;
    // 1.0 with exposureMetaFrames == 0 is UNKNOWN, not locked — the two are
    // read together or not at all.
    s.exposureRangeRatio =
        (S.exposureMin > 0.0 && S.exposureMax > 0.0)
            ? (S.exposureMax / S.exposureMin) : 1.0;

    // ── v11: THE SAME QUESTION, ASKED OF ARKit'S OWN CAMERA ─────────────
    // Same shape as the block above and read the same way: a ratio of 1.00
    // with `arExposureFrames == 0` is UNKNOWN, not locked.  The delta pair
    // is the device-identity evidence; both are 0 when nothing was paired,
    // which `arVsDevicePairedFrames` disambiguates from "identical".
    s.arExposureFrames        = S.arExposureFrames;
    s.arExposureMinS          = S.arExposureMinS;
    s.arExposureMaxS          = S.arExposureMaxS;
    s.arExposureRangeRatio =
        (S.arExposureMinS > 0.0 && S.arExposureMaxS > 0.0)
            ? (S.arExposureMaxS / S.arExposureMinS) : 1.0;
    s.arExposureOffsetMinEV   = S.arExposureOffsetMinEV;
    s.arExposureOffsetMaxEV   = S.arExposureOffsetMaxEV;
    s.arVsDevicePairedFrames  = S.arVsDevicePairedFrames;
    s.arVsDeviceMaxAbsDeltaS  = S.arVsDeviceMaxAbsDeltaS;
    s.arVsDeviceMaxRelDelta   = S.arVsDeviceMaxRelDelta;

    s.seamPhotoStepP50DN = percentileOf(S.seamPhotoSamples, 50.0);
    s.seamPhotoStepP95DN = percentileOf(S.seamPhotoSamples, 95.0);
    s.seamPhotoStepMaxDN = maxOf(S.seamPhotoSamples);
    s.seamPhotoSamples   = (int64_t)S.seamPhotoSamples.size();
    s.seamPhotoStepOverBar = S.seamPhotoOverBar;
    s.seamPhotoNonUniform = S.seamPhotoNonUniform;
    s.seamPhotoUniformUnknown = S.seamPhotoUniformUnknown;
    s.seamPhotoUniStepP95DN = percentileOf(S.seamPhotoUniSamples, 95.0);
    s.seamPhotoUniStepMaxDN = maxOf(S.seamPhotoUniSamples);
    s.seamPhotoUniSamples   = (int64_t)S.seamPhotoUniSamples.size();
    s.seamPhotoSpreadP95DN  = percentileOf(S.seamPhotoSpreadSamples, 95.0);
    s.seamPhotoSpreadMaxDN  = maxOf(S.seamPhotoSpreadSamples);
    s.seamPhotoDriftLocalPct = (std::exp(S.photoDriftLocalDN) - 1.0) * 100.0;
    s.seamPhotoDriftTotalPct =
        (std::exp(S.photoCumMaxDN - S.photoCumMinDN) - 1.0) * 100.0;
    s.seamPhotoDriftWorstU   = S.photoDriftWorstU;

    // THE BAND — READ, never computed here.  The scan runs on the WRITE side
    // (Impl::advancePhotoScan) precisely because stats() is called once per
    // frame for the live HUD and must not track the sweep length; see the
    // cursor's own comment and PanoGate.PerFrameStatsDoesNotCostMoreAsThe-
    // SweepGrows, which failed on the first cut of this metric.
    s.photoColumns = S.photoCols;
    if (S.photoCols > 0) {
        s.photoScaleMin = S.photoGMin;
        s.photoScaleMax = S.photoGMax;
        s.photoScaleRangePct =
            (S.photoGMin > 0.0) ? (S.photoGMax / S.photoGMin - 1.0) * 100.0 : 0.0;
    }
    s.photoLocalP2PPct = S.photoWorstP2P;
    s.photoLocalWorstU = S.photoWorstAt;
    s.crossScaleEnd = S.crossScale;
    s.crossScaleCagedFrames = S.crossScaleCagedFrames;
    s.crossScaleLeakedFrames = S.crossScaleLeakedFrames;
    s.crossDcRemovedFrames = S.crossDcRemovedFrames;
    s.crossBandFitRefused = S.crossBandFitRefused;
    s.crossGestureRefused = S.crossGestureRefused;
    s.crossGMean = (S.crossGCount > 0) ? (S.crossGSum / (double)S.crossGCount) : 0.0;
    s.subjectDistanceConfiguredM = S.cfg.subjectDistanceM;
    s.subjectDistanceUsedM =
        (S.cfg.subjectDistanceAuto && S.subjectDistanceFit > 0.0)
            ? S.subjectDistanceFit : S.cfg.subjectDistanceM;
    s.subjectDistanceFitM = S.subjectDistanceFit;

    // ── v11: THE FIT, GRADED — see SessionStats for the measured defect ──
    s.subjectDistanceFitRawM           = S.dFitRaw;
    s.subjectDistanceFitSaturated      = S.dFitSaturated;
    s.subjectDistanceFitClampedUpdates = S.dFitClamped;
    s.subjectDistanceFitRefusedUpdates = S.dFitRefused;
    s.subjectDistanceFitDen            = S.dFitDen;
    s.subjectDistanceFitNum            = S.dFitNum;
    s.subjectDistanceFitSamples        = S.dFitSamples;
    s.subjectDistanceFitFwdSpanM =
        S.dFitSpanSeen ? (S.dFitFwdMax - S.dFitFwdMin) : 0.0;
    s.subjectDistanceFitPerpSpanM = S.dFitPerpMax;
    // 0 when there was no perpendicular travel to divide by — a pure dolly,
    // where this estimator is WELL conditioned and a leverage ratio would be
    // meaningless rather than good.  `subjectDistanceFitDegenerate` therefore
    // requires a real perpendicular span before it can fire.
    s.subjectDistanceFitLeverRatio =
        (S.dFitPerpMax > 1e-9)
            ? (s.subjectDistanceFitFwdSpanM / S.dFitPerpMax) : 0.0;
    s.subjectDistanceFitDegenerate =
        (S.dFitSamples > 0) && (S.dFitPerpMax > kSubjectDistanceFitPerpFloorM)
        && (s.subjectDistanceFitLeverRatio < kSubjectDistanceFitLeverBar);
    // "The fit was 6.00 m" and "the placement RAN on 6.00 m" are different
    // facts, and a reader should not have to reconstruct the second from the
    // config plus two other fields.
    s.subjectDistanceFitInForce =
        (S.cfg.subjectDistanceAuto && S.subjectDistanceFit > 0.0);
    s.projectionSwitchSeq = S.projectionSwitchSeq;
    s.projectionSwitchStepPx = S.projectionSwitchStepPx;

    // THE VERDICT THE OPERATOR ASKED FOR.  v4 reported all four of his packs
    // clean; these bars fail all four of them under the v4 model.
    {
        std::string why;
        auto note = [&](const char* m) {
            if (!why.empty()) why += "; ";
            why += m;
        };
        // The clause v4 lacked TWICE OVER: it had no seam metric at all, and a
        // v5 session that fails to measure one must not inherit that silence.
        // Config::seamMetrics off, crossWindows 1, an unlatched axis and a
        // correlation that never locked all land here.
        if (S.st.painted > 0 && s.seamBoundaries == 0)
            note("band metric NOT MEASURED");
        if (S.st.painted > 0 && s.seamCanvasJogSamples == 0)
            note("committed-pixel metric NOT MEASURED");
        // v8: the band metric stops being EVIDENCE when the chain was fitted
        // to it — see the clause AFTER `integrityFailed` is computed, below.
        // It deliberately does not enter `why`.
        s.seamBandSelfScored = S.cfg.crossAvgWindows;
        if (s.seamWorstBandP95Px > 0.50) note("band p95 > 0.50 px");
        if (s.seamWorstBandMaxPx > 1.50) note("band max > 1.50 px");
        if (s.crossBandDivergenceNormPx > 6.00) note("band divergence/sqrt(n) > 6.00 px");
        if (s.seamCanvasJogP95Px > 1.50) note("committed-pixel jog p95 > 1.50 px");
        if (s.seamCanvasJogMaxPx > 4.00) note("committed-pixel jog max > 4.00 px");
        // ── v6: THE PHOTOMETRIC CLAUSES ─────────────────────────────────
        // v5 MEASURED a seam DC step and did not gate on it, which is the
        // whole reason pack 15-58-22 verdicted clean with a visible band in
        // it.  Same discipline as the geometric clauses: not measured is its
        // own failure, never silence.
        if (S.st.painted > 0 && s.seamPhotoSamples == 0)
            note("photometric seam NOT MEASURED");
        if (s.seamPhotoStepP95DN > 1.20) note("seam DC step p95 > 1.20 DN");
        // THE MAX CLAUSE NOW STATES ITS SUPPORT.  One anomalous boundary out
        // of six hundred and a genuine end-to-end band fire this identically,
        // and the operator could not tell them apart from the pack — he said
        // as much ("I am not sure I see the banding issue you are talking
        // about").  The bar is unchanged; the sentence now carries the count.
        if (s.seamPhotoStepMaxDN > kSeamPhotoStepMaxBarDN) {
            char buf[128];
            std::snprintf(buf, sizeof buf,
                          "seam DC step max > 3.00 DN (%lld of %lld boundaries)",
                          (long long)s.seamPhotoStepOverBar,
                          (long long)s.seamPhotoSamples);
            note(buf);
        }
        // THE BAND.  The clause a per-boundary metric structurally cannot
        // reach: 0.2% per strip, 10-24% over 40 columns on the operator's four
        // v5 packs, at exactly the rows he circled.
        // THE BAND, on COMMITTED PIXELS — the clause that survives a pack with
        // no exposure metadata, because it integrates what was painted rather
        // than what the engine applied.
        if (s.seamPhotoDriftLocalPct > 6.00)
            note("committed photometric band > 6% over 40 px");
        if (s.photoLocalP2PPct > 6.00) note("photometric band > 6% over 40 px");
        if (s.photoScaleRangePct > 20.00) note("photometric drift > 20% end-to-end");
        s.integrityFailed = !why.empty();
        // ── v8: THE BAND METRIC IS NOT EVIDENCE WHEN THE CHAIN FITTED IT ──
        //
        // NOT a failure clause, and v8 shipped it as one: it was appended to
        // `why`, and `integrityFailed = !why.empty()` two lines up made every
        // sweep with crossAvgWindows on verdict FAILED regardless of quality —
        // pinning the arm of the very A/B the knob was exposed for, and
        // flipping the live HUD to CUTS on the arm with the LOWEST band
        // number.  Four separate comments (here, the test, RNISPanoCore.mm and
        // a fourth comment) asserted it was not gated.  It is carried on
        // `integrityReason` alone now, AFTER the verdict is decided, and the
        // test pins that the verdict does not move.
        //
        // What the sentence stops is the 22-35% drop in the band clauses being
        // read as proof the averaged placement is better, when a least-squares
        // centre of the K band measurements is scored on the residual of those
        // same K.  Measured against the one instrument that cannot be fitted
        // (the committed-pixel jog, above) the same arm is 2 of 4 packs WORSE.
        if (s.seamBandSelfScored && s.seamBoundaries > 0) {
            if (!why.empty()) why += "; ";
            why += "NOTE band residual is the chain's own fit "
                   "(crossAvgWindows on) — read the committed-pixel jog instead";
        }
        s.integrityReason = why;
    }

    // ── v10: THE LENS DECISION, always reported ────────────────────────────
    // Reported whatever it was, including "disabled" and "unknown-device":
    // a pack that was not corrected has to SAY it was not corrected, and say
    // on what evidence, or the next reader cannot tell an uncorrected pack
    // from a pack written before the correction existed.
    s.lensApplied  = S.lensReady && S.lensDec.applied();
    s.lensGate     = lens::gateName(S.lensDec.gate);
    s.lensSource   = S.lensDec.source;
    s.lensDevice   = S.cfg.lensDeviceModel;
    s.lensDeviceLens = S.cfg.lensDeviceLens;
    s.lensK1 = s.lensApplied ? S.lensDec.model.k1 : 0.0;
    s.lensK2 = s.lensApplied ? S.lensDec.model.k2 : 0.0;
    s.lensFxOverWidth = S.lensDec.fxOverWidth;
    s.lensExpectedFxOverWidth = S.lensDec.expectedFxOverWidth;
    s.lensPeakRadialPx = s.lensApplied ? S.lensPeakRadialPx : 0.0;
    s.lensPeakResidualPx = s.lensApplied ? S.lensPeakResidualPx : 0.0;
    s.lensCorrectedStrips = S.lensCorrectedStrips;
    s.lensSkippedStrips = S.lensSkippedStrips;
    s.stripsCommitted = S.stripsCommitted;

    s.canvasGrowths = S.growths;
    s.canvasHeightGrowths = S.heightGrowths;
    s.vShiftTotalPx = S.vShiftTotal;
    s.abortReason = S.abortReason;
    if (S.anyPainted) {
        s.paintedW = std::max(0, S.maxPaintedU - S.minPaintedU);
        s.paintedH = S.canvasH;
        s.sweptExtentPx = (double)s.paintedW;
        // ANALYTIC, not rendered: stats() is called once per frame on the
        // engine queue, and rendering the oriented canvas here would copy
        // megabytes 30-60×/s.  cropVertical only ever NARROWS the
        // perpendicular dimension; finalCanvas() reports the exact size.
        s.outputW = (S.axis == 0) ? s.paintedW : s.paintedH;
        s.outputH = (S.axis == 0) ? s.paintedH : s.paintedW;
        // v14 — and then the upright bake transposes them again on a quarter
        // turn.  This has to move WITH `renderOriented`: `outputW/H` is what
        // the surface sizes the review viewport from before the canvas exists,
        // and a stats() that disagrees with the JPEG puts a portrait panorama
        // in a landscape box for the one frame before the real dims land.
        if (S.cfg.outputRotationCwDeg == 90 || S.cfg.outputRotationCwDeg == 270) {
            std::swap(s.outputW, s.outputH);
        }
    }
    // Echoed unconditionally — including on a sweep that painted nothing, where
    // it is still the honest answer to "which frame would this pack have been
    // written in".
    s.outputRotationCwDeg = S.cfg.outputRotationCwDeg;
    return s;
}

std::vector<std::pair<int, int>> Engine::unpaintedRuns() const {
    const Impl& S = *impl_;
    std::vector<std::pair<int, int>> runs;
    if (!S.anyPainted || S.coverage.empty()) return runs;
    const int u0 = std::max(0, std::min(S.minPaintedU, S.canvasW));
    const int u1 = std::max(u0, std::min(S.maxPaintedU, S.canvasW));
    const int n = u1 - u0;
    if (n <= 0) return runs;
    int runStart = -1;
    for (int i = 0; i < n; ++i) {
        const int x = u0 + i;
        bool painted = false;
        for (int y = 0; y < S.canvasH && !painted; ++y) {
            if (S.coverage.at<uchar>(y, x)) painted = true;
        }
        if (!painted) { if (runStart < 0) runStart = i; }
        else if (runStart >= 0) { runs.emplace_back(runStart, i); runStart = -1; }
    }
    if (runStart >= 0) runs.emplace_back(runStart, n);
    // Report in FINAL sweep-axis order: a negative sweep sign reverses the
    // axis in the finalize bake (flip / transpose+flip).
    if (S.sweepSign < 0) {
        for (auto& r : runs) { const int a = r.first; r.first = n - r.second; r.second = n - a; }
        std::reverse(runs.begin(), runs.end());
    }
    return runs;
}

std::vector<std::pair<int, int>> Engine::verticalEnvelope() const {
    const Impl& S = *impl_;
    std::vector<std::pair<int, int>> env;
    if (!S.anyPainted || S.coverage.empty()) return env;
    const int u0 = std::max(0, std::min(S.minPaintedU, S.canvasW));
    const int u1 = std::max(u0, std::min(S.maxPaintedU, S.canvasW));
    env.reserve(std::max(0, u1 - u0));
    for (int x = u0; x < u1; ++x) {
        int t = -1, b = -1;
        for (int y = 0; y < S.canvasH; ++y) {
            if (S.coverage.at<uchar>(y, x)) { t = y; break; }
        }
        if (t < 0) { env.emplace_back(0, 0); continue; }
        for (int y = S.canvasH - 1; y >= 0; --y) {
            if (S.coverage.at<uchar>(y, x)) { b = y + 1; break; }
        }
        env.emplace_back(t, b);
    }
    return env;
}

}  // namespace pano
}  // namespace rnis
