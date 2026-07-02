// SPDX-License-Identifier: Apache-2.0
//
// FrameHomographyPlanarity.mm — Obj-C++ implementation of the
// scene-liveness "planarity" primitive.  ALL OpenCV (cv::) is
// confined to this translation unit; the public header
// (FrameHomographyPlanarity.h) carries ZERO cv:: tokens.
//
// Faithful port of the per-pair core in scene_liveness_validate.py:
//   ORB(1200).detectAndCompute → BFMatcher(NORM_HAMMING, crossCheck)
//   match → require >= 30 matches → median match displacement (flow)
//   → findHomography(RANSAC, reproj = 2.5px) → planarity = mask.mean().
// The moiré half of that script is intentionally dropped (already
// shipped separately).
//
// See the header for the algorithm/verdict/gyro-gate rationale.

// OpenCV's headers contain `enum { NO, ... }` / `enum { YES, ... }`
// which collide with Obj-C's `NO`/`YES` macros (defined transitively
// by <objc/objc.h>).  Undef both BEFORE importing opencv2/*, then
// restore them.  Same standard pattern as GlareBridge.mm /
// OpenCVStitcher.mm.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#import <opencv2/core.hpp>
#import <opencv2/imgproc.hpp>      // cv::resize, INTER_AREA
#import <opencv2/features2d.hpp>   // cv::ORB, cv::BFMatcher, DMatch, KeyPoint
#import <opencv2/calib3d.hpp>      // cv::findHomography, cv::RANSAC

// Restore the Obj-C boolean macros now that OpenCV is parsed.
#define NO  ((BOOL)0)
#define YES ((BOOL)1)

#import "FrameHomographyPlanarity.h"

#import <vector>
#import <deque>
#import <algorithm>
#import <cmath>

// ─────────────────────────────────────────────────────────────────
// Tunables — mirror scene_liveness_validate.py constants 1:1, plus the
// gyro gate the device path adds (the Python script had a fixed
// frame-stride baseline instead of a live gyro signal).
// ─────────────────────────────────────────────────────────────────
namespace {

constexpr int    kOrbFeatures      = 1200;   // ORB_create(1200)
constexpr int    kMinMatches       = 30;     // MIN_MATCHES
constexpr double kMinFlowPx        = 2.0;    // MIN_FLOW_PX
constexpr double kHInlierPx        = 2.5;    // H_INLIER_PX (RANSAC reproj)
constexpr double kMaxRotRadPerSec  = 0.35;   // gyro gate (device-only)
constexpr int    kRingCap          = 60;     // MAX_PAIRS — ring capacity
constexpr int    kReadyPairs       = 4;      // ready = pairsUsed >= 4
constexpr double kDownscale        = 0.5;    // cv::resize fx=fy=0.5

// Robust median of a deque<double> (np.median parity: average of the
// two middle elements for an even count).  Returns 0.0 when empty.
double robustMedian(const std::deque<double> &v) {
    const size_t n = v.size();
    if (n == 0) return 0.0;
    std::vector<double> s(v.begin(), v.end());
    std::sort(s.begin(), s.end());
    if (n % 2 == 1) {
        return s[n / 2];
    }
    return 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

// Pimpl: owns ALL cv:: state so the @interface ivar block (and thus
// any header that ever sees this class) stays free of cv:: tokens.
struct PlanarityState {
    cv::Ptr<cv::ORB>        orb;
    cv::Ptr<cv::BFMatcher>  matcher;

    // Previous frame, in the DOWNSCALED coordinate space.
    bool                       havePrev = false;
    std::vector<cv::KeyPoint>  prevKp;
    cv::Mat                    prevDesc;

    // Ring buffer of COUNTED per-pair inlier fractions.
    std::deque<double>         planarity;

    // Optional ROI in NORMALIZED full-frame coordinates (0..1).
    bool   haveRoi = false;
    double roiX = 0.0, roiY = 0.0, roiW = 0.0, roiH = 0.0;

    PlanarityState()
        : orb(cv::ORB::create(kOrbFeatures)),
          // crossCheck=true ⇒ symmetric best-match (1:1 with the
          // Python BFMatcher(NORM_HAMMING, crossCheck=True)).  No
          // ratio test / knnMatch — plain match() like the script.
          matcher(cv::makePtr<cv::BFMatcher>(cv::NORM_HAMMING, /*crossCheck=*/true)) {}
};

} // namespace

// ─────────────────────────────────────────────────────────────────

@implementation FrameHomographyPlanarity {
    NSLock         *_lock;
    BOOL            _enabled;
    PlanarityState *_state;   // owned; freed in dealloc

    // Plain-scalar counters (read under _lock for getMetrics).
    NSInteger _framesSeen;
    NSInteger _pairsUsed;        // pairs pushed into the ring (gate-passed)
    NSInteger _rotationSkipped;  // pairs skipped by the rotation gate
    double    _lastFlowPx;       // most recent matched-pair median flow
}

+ (instancetype)sharedInstance {
    static FrameHomographyPlanarity *shared = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        shared = [[FrameHomographyPlanarity alloc] init];
    });
    return shared;
}

- (instancetype)init {
    if ((self = [super init])) {
        _lock            = [[NSLock alloc] init];
        _enabled         = NO;
        _state           = new PlanarityState();
        _framesSeen      = 0;
        _pairsUsed       = 0;
        _rotationSkipped = 0;
        _lastFlowPx      = 0.0;
    }
    return self;
}

- (void)dealloc {
    delete _state;
    _state = nullptr;
}

// ── Settings ─────────────────────────────────────────────────────

- (void)setEnabled:(BOOL)enabled {
    [_lock lock];
    _enabled = enabled;
    [_lock unlock];
}

- (void)setROIWithX:(double)x y:(double)y width:(double)w height:(double)h {
    [_lock lock];
    // Ignore degenerate boxes (zero/negative extent) — treat as
    // "no ROI" so a bad call never silently kills detection.
    if (w > 0.0 && h > 0.0) {
        // Clamp to the unit square so a slightly-overflowing box still
        // yields a valid mask rect after scaling.
        double cx = std::max(0.0, std::min(1.0, x));
        double cy = std::max(0.0, std::min(1.0, y));
        double cw = std::max(0.0, std::min(1.0 - cx, w));
        double ch = std::max(0.0, std::min(1.0 - cy, h));
        if (cw > 0.0 && ch > 0.0) {
            _state->haveRoi = true;
            _state->roiX = cx;
            _state->roiY = cy;
            _state->roiW = cw;
            _state->roiH = ch;
        }
    }
    [_lock unlock];
}

- (void)clearROI {
    [_lock lock];
    _state->haveRoi = false;
    [_lock unlock];
}

- (void)reset {
    [_lock lock];
    _state->havePrev = false;
    _state->prevKp.clear();
    _state->prevDesc.release();
    _state->planarity.clear();
    _framesSeen      = 0;
    _pairsUsed       = 0;
    _rotationSkipped = 0;
    _lastFlowPx      = 0.0;
    [_lock unlock];
}

// ── Per-frame ingest ─────────────────────────────────────────────

- (void)processLumaPlane:(const uint8_t *)base
                   width:(NSInteger)w
                  height:(NSInteger)h
             bytesPerRow:(NSInteger)bpr
   rotationRateRadPerSec:(double)rot {

    if (base == NULL || w <= 0 || h <= 0 || bpr < w) {
        return;  // unusable input — never a verdict
    }

    [_lock lock];

    if (!_enabled) {
        [_lock unlock];
        return;
    }

    // OpenCV signals failures by THROWING cv::Exception (a C++
    // std::exception subclass), NOT NSException — so the guard must be
    // a C++ try/catch.  Any cv:: error inside (degenerate ORB, resize
    // on a bad Mat, …) is swallowed: the frame is dropped, prev is
    // left untouched, and the lock is always released below.  A liveness
    // probe must never crash the camera pipeline.
    try {
        _framesSeen += 1;

        // 1) Wrap the locked luma plane as 8UC1 — NO copy.  The
        //    CVPixelBuffer is owned/locked by the caller for the
        //    duration of this call and is NOT retained here.
        cv::Mat full((int)h, (int)w, CV_8UC1,
                     const_cast<uint8_t *>(base),
                     static_cast<size_t>(bpr));

        // 2) Downscale ~0.5 (INTER_AREA) — matches the Python
        //    cv2.resize(f, (0,0), fx=0.5, fy=0.5) decimation.
        cv::Mat small;
        cv::resize(full, small, cv::Size(), kDownscale, kDownscale, cv::INTER_AREA);

        // 3) Build the ORB detection mask from the optional ROI
        //    (normalized → downscaled-pixel rect).
        cv::Mat mask;  // empty ⇒ detect over the whole frame
        if (_state->haveRoi && small.cols > 0 && small.rows > 0) {
            int rx = static_cast<int>(std::lround(_state->roiX * small.cols));
            int ry = static_cast<int>(std::lround(_state->roiY * small.rows));
            int rw = static_cast<int>(std::lround(_state->roiW * small.cols));
            int rh = static_cast<int>(std::lround(_state->roiH * small.rows));
            rx = std::max(0, std::min(rx, small.cols - 1));
            ry = std::max(0, std::min(ry, small.rows - 1));
            rw = std::max(1, std::min(rw, small.cols - rx));
            rh = std::max(1, std::min(rh, small.rows - ry));
            mask = cv::Mat::zeros(small.size(), CV_8UC1);
            mask(cv::Rect(rx, ry, rw, rh)).setTo(255);
        }

        // 4) ORB detect+compute on the current frame.
        std::vector<cv::KeyPoint> curKp;
        cv::Mat                   curDesc;
        _state->orb->detectAndCompute(small, mask, curKp, curDesc);

        // 5) Pair test — only if a previous frame exists AND both
        //    frames clear the keypoint floor (>= 30 each), mirroring
        //    `len(ka) < MIN_MATCHES or len(kb) < MIN_MATCHES`.
        const bool prevOk =
            _state->havePrev &&
            !_state->prevDesc.empty() &&
            static_cast<int>(_state->prevKp.size()) >= kMinMatches;
        const bool curOk =
            !curDesc.empty() &&
            static_cast<int>(curKp.size()) >= kMinMatches;

        if (prevOk && curOk) {
            // BFMatcher(NORM_HAMMING, crossCheck) — symmetric matches.
            // Order matches the Python (a = prev, b = cur):
            //   m = bf.match(da, db); queryIdx→a, trainIdx→b.
            std::vector<cv::DMatch> matches;
            _state->matcher->match(_state->prevDesc, curDesc, matches);

            if (static_cast<int>(matches.size()) >= kMinMatches) {
                // Median match displacement = flow (downscaled px).
                std::vector<cv::Point2f> pa, pb;
                pa.reserve(matches.size());
                pb.reserve(matches.size());
                std::vector<double> disp;
                disp.reserve(matches.size());
                for (const cv::DMatch &m : matches) {
                    const cv::Point2f &p = _state->prevKp[m.queryIdx].pt;
                    const cv::Point2f &q = curKp[m.trainIdx].pt;
                    pa.push_back(p);
                    pb.push_back(q);
                    const double dx = static_cast<double>(p.x - q.x);
                    const double dy = static_cast<double>(p.y - q.y);
                    disp.push_back(std::sqrt(dx * dx + dy * dy));
                }
                std::sort(disp.begin(), disp.end());
                double flow;
                const size_t n = disp.size();
                if (n % 2 == 1) {
                    flow = disp[n / 2];
                } else {
                    flow = 0.5 * (disp[n / 2 - 1] + disp[n / 2]);
                }
                _lastFlowPx = flow;

                // ── Gyro + flow gate ──────────────────────────────
                //   COUNT the pair only when rotation is low (parallax
                //   is translation-driven) AND there's enough baseline
                //   flow.  High-rotation pairs are SKIPPED so a fast
                //   pan over a real shelf can't fit a homography and
                //   false-read as a flat screen.
                if (rot >= kMaxRotRadPerSec) {
                    _rotationSkipped += 1;
                } else if (flow >= kMinFlowPx) {
                    cv::Mat inlierMask;
                    cv::Mat H = cv::findHomography(pa, pb, cv::RANSAC,
                                                  kHInlierPx, inlierMask);
                    if (!H.empty() && !inlierMask.empty()) {
                        // planarity = inlier fraction = mask.mean().
                        // OpenCV's RANSAC mask is 8U {0,1}; mean over
                        // it == the fraction of inliers, matching
                        // np.float(mask.mean()).
                        const double inlierFrac = cv::mean(inlierMask)[0];
                        _state->planarity.push_back(inlierFrac);
                        if (static_cast<int>(_state->planarity.size()) > kRingCap) {
                            _state->planarity.pop_front();
                        }
                        // pairsUsed tracks pushed pairs (capped at ring).
                        _pairsUsed = static_cast<NSInteger>(_state->planarity.size());
                    }
                    // H == empty ⇒ degenerate; just don't count (the
                    // Python `if H is None: continue`).
                }
                // flow < MIN_FLOW_PX (and rotation low) ⇒ near-static
                // pair, no parallax to exploit — neither counted nor
                // rotation-skipped, exactly like the Python `continue`.
            }
            // too few matches ⇒ fall through, just update prev.
        }
        // prev/cur too textureless ⇒ fall through, just update prev —
        // graceful degradation, never a verdict.

        // 6) Always store the current frame as the new previous,
        //    regardless of whether the pair was counted.
        _state->prevKp   = std::move(curKp);
        _state->prevDesc = curDesc;   // shallow ref; curDesc owns its data
        _state->havePrev = true;
    }
    catch (const cv::Exception &e) {
        // OpenCV runtime error — drop this frame; prev is unchanged.
    }
    catch (const std::exception &e) {
        // Any other C++ failure — same graceful drop.
    }

    [_lock unlock];
}

// ── Read-only snapshot ───────────────────────────────────────────

- (NSDictionary *)getMetrics {
    [_lock lock];
    const double median  = robustMedian(_state->planarity);
    const BOOL   ready   = (_pairsUsed >= kReadyPairs);
    NSDictionary *out = @{
        @"ready"           : @(ready),
        @"pairsUsed"       : @(_pairsUsed),
        @"planarityMedian" : @(median),
        @"lastFlowPx"      : @(_lastFlowPx),
        @"framesSeen"      : @(_framesSeen),
        @"rotationSkipped" : @(_rotationSkipped),
    };
    [_lock unlock];
    return out;
}

@end
