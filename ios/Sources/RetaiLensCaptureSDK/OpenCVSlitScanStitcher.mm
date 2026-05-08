//
// OpenCVFirstWinsCylindricalStitcher.mm
//
// Apple-style slit-scan engine (Option B from the panorama north-star
// doc).  Reuses the panorama-frame coord setup from v9 but paints
// narrow vertical strips instead of warping whole frames.
//

#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#import <opencv2/opencv.hpp>
#import <opencv2/core.hpp>
#import <opencv2/imgproc.hpp>
#import <opencv2/imgcodecs.hpp>
#import <opencv2/features2d.hpp>  // ORB, BFMatcher (V12.11 Step 4)
#import <opencv2/calib3d.hpp>     // findHomography (V12.11 Step 4)

#import <vector>
#import <chrono>
#import <os/log.h>

// V13.0a.4 — diagnostic os_log subsystem.  os_log_with_type(FAULT)
// survives Console.app's NSLog burst rate-limit (~10/sec) — same
// pattern we used in V12.14.x to get crash-trail breadcrumbs through.
static os_log_t SlitDiagLog(void) {
    static os_log_t log = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        log = os_log_create("com.tiger.retailens.sdk", "slitscan");
    });
    return log;
}

#define NO  ((BOOL)0)
#define YES ((BOOL)1)

#import "OpenCVSlitScanStitcher.h"  // file name kept; class renamed to OpenCVFirstWinsCylindricalStitcher (V11 Gap #23)

@implementation OpenCVFirstWinsCylindricalStitcher {
    NSInteger _composeWidth;
    NSInteger _composeHeight;
    NSInteger _canvasWidth;
    NSInteger _canvasHeight;
    /// V12.12 — pan-axis canvas extent (defaults to max of
    /// constructor's canvasWidth/Height, e.g. 5000).  Used at first-
    /// frame allocation to size the pan-axis dimension of the canvas.
    /// The perpendicular axis is taken from the actual frame size at
    /// first-frame ingest, so the canvas is "just wide enough" along
    /// perpendicular and "5000-deep" along the pan axis.  This pairs
    /// with the new engine-internal canvas allocation (deferred to
    /// first frame so we can use the pose-detected orientation).
    NSInteger _canvasPanExtent;
    NSInteger _frameRotationDegrees;
    /// V12.3 orientation-aware cylinder axis — see v9 engine.
    BOOL _isLandscape;
    /// V12.7 Variant B: rectilinear mode.  When YES, skip cylindrical
    /// warp entirely.  First frame is pasted raw onto canvas.
    /// Subsequent frames contribute a narrow central strip placed by
    /// ARKit pose-delta, with first-painted-wins masking.  The
    /// canvas content stays in the camera's native rectilinear
    /// projection — zero cylindrical curvature.
    BOOL _useRectilinear;
    /// V12.7 first-frame anchor for rectilinear placement.
    int _firstFrameDstX;
    int _firstFrameDstY;
    /// V12.11 Step D — running max position along the pan axis.
    /// Tracks the FURTHEST extent reached during the current
    /// capture.  If a subsequent frame's homography-corrected
    /// dst position drops below `max - kReverseStopPx` the
    /// engine treats it as a reverse-direction event and emits
    /// RLISFrameOutcomeRejectedReverseDirection without pasting.
    /// Reset by `[reset]` to firstFrameDstX/Y at first frame.
    int _maxDstX;
    int _maxDstY;

    cv::Mat _canvas;
    cv::Mat _canvasMask;

    // Panorama-frame state — same shape as v9 hybrid engine.
    cv::Mat _firstRotationArkit;
    cv::Mat _M_arkitToCv;
    cv::Mat _R_panToWorld;
    cv::Mat _K_compose;
    double  _focalCompose;
    int     _canvasOriginCylX;
    int     _canvasOriginCylY;

    bool _hasFirstFrame;
    NSInteger _accepted;
    NSInteger _snapshotSeq;

    // Last-strip state — strip placement is incremental from here.
    // V11 Gap #22: deleted dead state (_lastAcceptedTheta,
    // _lastAcceptedH, _slitScanMode) — these were strip-extraction
    // state from the original slit-scan design, never used by the
    // first-painted-wins implementation.

    // ── V13.0e: ORB-triangulation translation correction state ────────
    // Per-frame ORB feature detection on each accepted slit; matched
    // against the previous accept to triangulate depth and compensate
    // canvas-paste position for camera translation parallax.
    //
    // Why this exists: pose-only paste assumes pure rotation.  Field
    // captures show ~30–40 cm of camera translation per pan, which at
    // typical 1–3 m scene depth produces ~30–100 px of perpendicular
    // jitter and missing scene content between adjacent slits (the
    // "translation gaps" Ram observed in V13.0d).  Triangulating
    // matched features between adjacent accepts gives a per-frame
    // depth estimate; the parallax correction Δpixel = focal × Δt_cam / Z
    // closes that gap.
    //
    // V12.11 Step 4's per-frame ORB+RANSAC homography approach was
    // brittle under low overlap / low texture / fast pan.  V13.0e is
    // different in TWO ways:
    //   1. Triangulation only — we use ORB to compute a depth scalar
    //      (median Z), not to drive a homography.  Geometric pose still
    //      drives placement; ORB just supplies the parallax denominator.
    //   2. Forward-only Y clamp on the correction — never pulls back
    //      below the running max along the pan axis.  Same lesson as
    //      V12.14 (frame-stacking under pull-back).
    cv::Ptr<cv::ORB> _orbDetector;
    std::vector<cv::KeyPoint> _prevKeypoints;
    cv::Mat _prevDescriptors;
    cv::Mat _prevRotationArkit;     // 3x3 R at previous accept
    cv::Mat _prevTranslationArkit;  // 3x1 t at previous accept (m)
    cv::Mat _firstTranslationArkit; // 3x1 t at first frame (m) — V13.0g unused, kept for diag.
    bool _hasPrevAccept;

    // V13.0g — per-accept incremental tri-correction accumulator.
    // V13.0e/f computed correction = focal × R^T × (t_now − t_first) / Z
    // (cumulative-from-first), capped at ±50/±100.  At realistic pan
    // motion (Δt cumulative ~40 cm) the true correction can reach 200–
    // 400 px; the cap clipped most of it, leaving tens to hundreds of
    // pixels of misalignment between adjacent slits.  V13.0g switches
    // to per-accept INCREMENTAL Δt (t_now − t_prev_accept ≈ 4 cm),
    // computes a small per-accept correction (~30–100 px), caps that
    // increment at ±80, and ACCUMULATES it.  Total correction over a
    // pan grows naturally to whatever cumulative parallax demands;
    // per-accept artifact stays bounded; bad-Z bursts on individual
    // accepts contribute ±80 (not the global rescaling that V13.0f's
    // cumulative-Z formula caused).
    double _accumTriCorrectionX;
    double _accumTriCorrectionY;

    // V14.0a — last accept's final canvas paste position.  Used to
    // build per-match canvas-coord pairs that feed RANSAC homography
    // in subsequent accepts.  Captured AFTER V13.0g's incremental
    // tri+accumulator and the forward-only Y clamp, because that's
    // what was actually painted onto canvas.  Initialized at first
    // accept; updated at the end of each subsequent accept.
    int _prevAcceptDstX;
    int _prevAcceptDstY;

    // V15 — runtime config controlling which correction stages run.
    // See RLISStitcherConfig in OpenCVIncrementalStitcher.h.  Set via
    // -setConfig: after init; defaults to slitscan-both factory config
    // if never set.
    RLISStitcherConfig *_config;
}

- (instancetype)initWithComposeWidth:(NSInteger)composeWidth
                       composeHeight:(NSInteger)composeHeight
                         canvasWidth:(NSInteger)canvasWidth
                        canvasHeight:(NSInteger)canvasHeight
                         featherPx:(NSInteger)featherPx
              frameRotationDegrees:(NSInteger)frameRotationDegrees
                     useRectilinear:(BOOL)useRectilinear
{
    if (self = [super init]) {
        _composeWidth  = composeWidth  > 0 ? composeWidth  : 960;
        _composeHeight = composeHeight > 0 ? composeHeight : 720;
        // V12.12 — canvasWidth/Height args become HINTS, not exact
        // dims: the engine allocates the actual canvas at first frame
        // based on detected orientation.  The pan-axis dimension is
        // max(canvasWidth, canvasHeight) — both are typically 5000 so
        // the value is unambiguous; the perpendicular dim is
        // determined by the actual frame size at first-frame ingest.
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 5000;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 5000;
        _canvasPanExtent = std::max(_canvasWidth, _canvasHeight);
        _frameRotationDegrees = frameRotationDegrees;
        _useRectilinear = useRectilinear;
        _firstFrameDstX = 0;
        _firstFrameDstY = 0;
        _maxDstX = 0;
        _maxDstY = 0;
        // V12.6 Step C: detected at first-frame init from R_panToCam,
        // not from frameRotationDegrees.  Default false here is just
        // a safe initialiser.
        _isLandscape = NO;

        _M_arkitToCv = (cv::Mat_<double>(3, 3) <<
            1, 0, 0,
            0, -1, 0,
            0, 0, -1);

        // V13.0e — ORB detector lives for the engine's lifetime;
        // detectAndCompute is called per accepted slit.  500 features
        // is plenty for matching across 50–60 px sliver advances; ORB
        // on 1920×1080 with this budget runs in ~5 ms on iPhone 14+.
        _orbDetector = cv::ORB::create(500);

        // V15 — default config (slitscan-both).  Caller should override
        // via -setConfig: after init.  Default chosen so engines work
        // correctly with the legacy `useRectilinear=YES` path even if
        // setConfig is never called.
        _config = [RLISStitcherConfig configForMode:@"slitscan-both"];

        [self reset];
    }
    return self;
}

- (void)setConfig:(RLISStitcherConfig *)config {
    if (config == nil) return;
    _config = config;
    NSLog(@"[V15-config] slit-scan config applied: panAxisFrac=%.2f "
          @"acceptGate=%ld tri=%d triAccum=%d 1dNcc=%d 2dNcc=%d "
          @"ransac=%d paint=%@",
          _config.kPanAxisFractionRect, (long)_config.kMinAcceptDeltaPx,
          (int)_config.enableTriangulation, (int)_config.enableTriAccumulator,
          (int)_config.enable1dNcc, (int)_config.enable2dNcc,
          (int)_config.enableRansacHomography,
          _config.paintMode == RLISPaintModeFeatherBlend
              ? @"FeatherBlend" : @"FirstPaintedWins");
}

- (void)reset {
    // V12.12 — canvas alloc DEFERRED to first-frame branch (see
    // ingestPixelBuffer below) so we can size it based on the
    // pose-detected orientation.  Empty Mats here signal "no canvas
    // yet" — first-frame branch checks `_canvas.empty()` and
    // allocates accordingly.
    _canvas = cv::Mat();
    _canvasMask = cv::Mat();
    _firstRotationArkit = cv::Mat();
    _R_panToWorld = cv::Mat();
    _K_compose = cv::Mat();
    _focalCompose = 0;
    _canvasOriginCylX = 0;
    _canvasOriginCylY = 0;
    _hasFirstFrame = false;
    _accepted = 0;
    _snapshotSeq = 0;
    // V12.11 Step D — clear running-max trackers; will be
    // re-initialised to first-frame position on next accept.
    _firstFrameDstX = 0;
    _firstFrameDstY = 0;
    _maxDstX = 0;
    _maxDstY = 0;

    // V13.0e — clear triangulation state so a fresh capture starts
    // with no carried-over keypoints/descriptors/poses.  ORB detector
    // itself stays alive (re-created in init only) — it has no
    // per-capture state.
    _prevKeypoints.clear();
    _prevDescriptors = cv::Mat();
    _prevRotationArkit = cv::Mat();
    _prevTranslationArkit = cv::Mat();
    _firstTranslationArkit = cv::Mat();
    _hasPrevAccept = false;

    // V13.0g — zero the per-accept incremental tri accumulator.
    _accumTriCorrectionX = 0.0;
    _accumTriCorrectionY = 0.0;

    // V14.0a — clear prev accept canvas position; set on first accept.
    _prevAcceptDstX = 0;
    _prevAcceptDstY = 0;
}

- (NSInteger)acceptedCount { return _accepted; }

// Quaternion → rotation matrix (CV_64F).
static cv::Mat quatToR(double qx, double qy, double qz, double qw) {
    double n = std::sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
    if (n > 1e-9) { qx /= n; qy /= n; qz /= n; qw /= n; }
    return (cv::Mat_<double>(3, 3) <<
        1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qw*qz),     2*(qx*qz + qw*qy),
        2*(qx*qy + qw*qz),     1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qw*qx),
        2*(qx*qz - qw*qy),     2*(qy*qz + qw*qx),     1 - 2*(qx*qx + qy*qy));
}

// V11 Gap #22: deleted dead kMinStripWidthPx/kMaxStripWidthPx.
// These were strip-width bounds for the original slit-scan design,
// never referenced in the first-painted-wins implementation.

// V12.12 — fraction of the PAN-AXIS the rectilinear engine retains
// per frame.  The remaining (1 - fraction) is cropped equally from
// both edges of the pan axis, keeping the perpendicular axis full.
//
// Apple-pano-style slit scan: each frame contributes a NARROWER-
// than-frame slit centred on the screen, perpendicular to motion.
// The clipped-out content (top/bottom in landscape, left/right in
// portrait — the user-perceived edges along the pan direction) sits
// behind translucent dim bars in the live preview.  Earlier versions
// (V12.11 Step 3) clipped the LONG sensor axis (perpendicular to
// pan in landscape, along pan in portrait) which produced bars on
// the wrong screen edge in landscape and forced the JS layer to
// guess orientation.  V12.12 makes the engine itself
// orientation-aware: clip rows for landscape (canvas Y is pan
// axis), clip cols for portrait (canvas X is pan axis).
//
// First-frame and subsequent-frame branches both reference this
// constant — DRY-critical because if they ever drift the engine
// misbehaves (frame 1 placed bigger than frame 2's source ROI).
// V14.0pre.1 — bumped from 0.10 back to 0.30 after V14.0pre field test
// surfaced gaps from fast-pan per-accept advance exceeding clipH.  At
// clipH=108 (V14.0pre), per-accept advance during burst pan (~3000 px/s
// pan rate × ~40 ms accept time = 120 px/accept) exceeds the slit, so
// adjacent slits don't overlap → unpainted canvas Y bands = gaps.
//
// At 0.30, clipH = 324 px.  Still 2× narrower than V13.0g's 0.70 (756
// px) — meaningfully reduces within-slit multi-depth disagreement (the
// door-shear in V13.0g) — but with 3× safety margin over typical burst
// per-accept advance, no gaps.
static const double kPanAxisFractionRect = 0.30;

// V13.0a — homographyOffset() and the kHomogTier* constants were
// removed in the revert from V12.11.1 + V12.14 (ORB+RANSAC homography
// correction with 3-tier confidence ladder) back to pose-only paste.
//
// Per-frame homography refinement was chronically fragile under low-
// overlap / low-texture / fast-pan conditions.  V12.14's tier ladder
// filtered the worst homographies but couldn't fully tame them — MED
// tier (translation-only) stripped rotation/scale and produced
// visible chevrons + frame-stacking pull-back artifacts.
//
// V13.0b will reintroduce a LIGHTWEIGHT 1D column-edge NCC
// correlation (~1 ms, ±100 px search) for sub-pixel perpendicular
// drift correction on top of pose — the algorithm production camera
// apps (iOS Camera Pano, Samsung native pano) ship.  Until that
// lands, perpendicular drift is bounded only by ARKit pose accuracy.

- (RLISFrameTelemetry *)ingestPixelBuffer:(CVPixelBufferRef)pixelBuffer
                                       qx:(double)qx
                                       qy:(double)qy
                                       qz:(double)qz
                                       qw:(double)qw
                                       tx:(double)tx
                                       ty:(double)ty
                                       tz:(double)tz
                                       fx:(double)fx
                                       fy:(double)fy
                                       cx:(double)cx
                                       cy:(double)cy
                              imageWidth:(NSInteger)imageWidth
                             imageHeight:(NSInteger)imageHeight
                                      yaw:(double)yaw
                                    pitch:(double)pitch
                          fovHorizDegrees:(double)fovHorizDegrees
                           fovVertDegrees:(double)fovVertDegrees
                             trackingPoor:(BOOL)trackingPoor
{
    auto t0 = std::chrono::steady_clock::now();
    RLISFrameTelemetry *tele = [[RLISFrameTelemetry alloc] init];
    // V12.12 — set isLandscape on every telemetry up-front so every
    // return path (early-out trackingPoor, alignment-lost, accept,
    // skip, reverse, etc.) carries the orientation.  Stays at the
    // FIRST-FRAME determination after that point.  Pre-first-frame
    // it's just the default (NO/portrait), which is a safe initial
    // state for the JS layer to render against.
    [tele setValue:@(_isLandscape ? YES : NO) forKey:@"isLandscape"];
    // V12.14.9 — paintedExtent + panExtent on EVERY return path so
    // the JS band overlay can size the thumb proportionally on every
    // state event (not just snapshot frames).
    // V12.14.10: unified — both supported modes use _maxDstY as the
    // pan-axis leading edge.  Pre-first-frame _maxDstY=0 so
    // paintedExtent=0 → fillRatio=0 → minimum-size thumb.
    [tele setValue:@(_maxDstY) forKey:@"paintedExtent"];
    [tele setValue:@(_canvasPanExtent) forKey:@"panExtent"];

    // V13.0a.2 — call counter + per-call state log.  Ram's V13.0a.1
    // trace showed only [V13.0a-focal] firing (1 per capture), no
    // [V13.0a-pose] / [V13.0a-paint] — meaning subsequent frames are
    // returning early before reaching the pose projection.  Most
    // likely culprit: trackingPoor=YES on ARKit → silent return at
    // line ~247.  This log fires on EVERY ingestPixelBuffer call
    // BEFORE any early returns, so we can see how many frames per
    // capture are coming in and what their tracking state is.
    static NSInteger _engineCallCounter = 0;
    _engineCallCounter += 1;
    // Log every 5th call to keep volume manageable but still see
    // the per-frame pattern.  (At 60 fps × 2 sec capture ≈ 120
    // frames → 24 log lines, fits in Console.app's burst budget.)
    if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 3) {
        // V13.0a.4 — FAULT-level os_log to bypass NSLog burst rate-limit.
        os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
            "[V13.0a-call] #%ld hasFirstFrame=%d trackingPoor=%d "
            "useRectilinear=%d _accepted=%ld",
            (long)_engineCallCounter, (int)_hasFirstFrame,
            (int)trackingPoor, (int)_useRectilinear,
            (long)_accepted);
    }

    if (trackingPoor) {
        [tele setValue:@(RLISFrameOutcomeSkippedTrackingPoor) forKey:@"outcome"];
        return tele;
    }

    cv::Mat frameBGR;
    if (![self convertPixelBuffer:pixelBuffer to:frameBGR]) {
        [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
        return tele;
    }

    cv::Mat R_new = quatToR(qx, qy, qz, qw);

    // ── First frame: build panorama coords + paint the FULL first
    //    frame via cylindrical warp.  Earlier slit-scan versions
    //    painted strips only; the user's expectation is "first full
    //    frame visible, slits append at its edges" — which is more
    //    natural than Apple's pure no-first-frame slit-scan.
    if (!_hasFirstFrame) {
        _firstRotationArkit = R_new.clone();
        // V11 Gaps #1, #2: per-axis K scaling + geometric-mean cylinder
        // radius.  See OpenCVIncrementalStitcher.mm for full annotation.
        double sx = (double)frameBGR.cols / std::max((NSInteger)1, imageWidth);
        double sy = (double)frameBGR.rows / std::max((NSInteger)1, imageHeight);
        _K_compose = (cv::Mat_<double>(3, 3) <<
                      fx * sx, 0,       cx * sx,
                      0,       fy * sy, cy * sy,
                      0,       0,       1);
        _focalCompose = std::sqrt((fx * sx) * (fy * sy));

        // V13.0a.1 — diagnostic log #1: focal scaling inputs +
        // computed `focalCompose`.  Lets us check whether
        // imageWidth/imageHeight (from host) match what fx/fy are
        // normalized to.  If `sx` or `sy` ≠ 1.0 unexpectedly, the
        // `alpha × focalCompose` pixel mapping undercounts (or
        // overcounts) → "everything shorter / taller than reality"
        // (the height-shrink artifact in V13.0a captures).
        NSLog(@"[V13.0a-focal] fx=%.1f fy=%.1f imageW=%ld imageH=%ld "
              @"frame=%dx%d sx=%.3f sy=%.3f focalCompose=%.1f",
              fx, fy, (long)imageWidth, (long)imageHeight,
              frameBGR.cols, frameBGR.rows, sx, sy, _focalCompose);

        cv::Mat fwdArkitCam = (cv::Mat_<double>(3, 1) << 0, 0, -1);
        cv::Mat fwdWorld = _firstRotationArkit * fwdArkitCam;
        double fwx = fwdWorld.at<double>(0);
        double fwz = fwdWorld.at<double>(2);
        double horiz = std::sqrt(fwx * fwx + fwz * fwz);
        // V11 Gap #3: reject if camera looking nearly vertical (no
        // horizontal forward to anchor the panorama frame).  See
        // OpenCVIncrementalStitcher.mm for full annotation.
        if (horiz < 0.1) {
            [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
            return tele;
        }
        double pzx = fwx / horiz, pzz = fwz / horiz;
        _R_panToWorld = (cv::Mat_<double>(3, 3) <<
            pzz,  0, pzx,
            0,    1, 0,
            -pzx, 0, pzz);

        // V12.6 Step C: detect orientation from R_panToCam at first
        // frame — see v9 engine for the rationale.  JS's
        // frameRotationDegrees is unreliable when iOS orientation-
        // lock is on; ARKit's pose is ground truth.
        cv::Mat R_panToCam_first = _M_arkitToCv * _firstRotationArkit.t() * _R_panToWorld;
        const double absR01 = std::fabs(R_panToCam_first.at<double>(0, 1));
        const double absR11 = std::fabs(R_panToCam_first.at<double>(1, 1));
        _isLandscape = (absR11 > absR01);
        // V12.12 — re-stamp the tele with the freshly-detected
        // isLandscape so the FIRST frame's state event carries the
        // right value (the up-front set at the top of this method
        // ran before _isLandscape was computed).
        [tele setValue:@(_isLandscape ? YES : NO) forKey:@"isLandscape"];
        NSLog(@"[V12.6-orient] engine=firstwins detected isLandscape=%d "
              @"|R[0,1]|=%.4f |R[1,1]|=%.4f (frameRotationDegrees from JS = %ld)",
              (int)_isLandscape, absR01, absR11, (long)_frameRotationDegrees);

        if (_useRectilinear) {
            // V12.14.10 — UNIFIED clip for both supported modes.
            // Per the two-mode spec (project memory `ar-stitching-two-modes`),
            // the supported modes are landscape+vertical-pan and
            // portrait+horizontal-pan.  Both have pan rotation around
            // CAM +X (the phone's long edge / sensor X direction):
            //
            //   - landscape vertical pan: phone long edge = user
            //     horizontal; rotation around it = tilt up/down.
            //   - portrait horizontal pan: phone long edge = user
            //     vertical; rotation around it = pan sideways.
            //
            // Both rotations move sensor content along sensor Y.
            // So clip ALONG sensor Y (clip rows to 70% = ~756 px),
            // perp = full sensor X (1920) — IDENTICAL in both modes.
            //
            // Pre-V12.14.10 the portrait branch wrongly clipped sensor X
            // (assumed cam +Y rotation = portrait+vertical-pan, an
            // unsupported mode).  That mis-wiring was the root cause of
            // Issue 2 ("sideways portrait → first frame only output").
            int clipW, clipH, srcClipX, srcClipY;
            clipW = frameBGR.cols;  // perpendicular: full sensor X (1920)
            // V15 — clipH driven by _config.kPanAxisFractionRect (was a
            // file-scope constant in V14.x).  Defaults to 0.30 in all
            // V15 modes; settings UI exposes a slider 0.10–0.70.
            clipH = std::max(1, (int)(frameBGR.rows * _config.kPanAxisFractionRect));
            srcClipX = 0;
            srcClipY = (frameBGR.rows - clipH) / 2;
            cv::Mat frameClipped = frameBGR(cv::Rect(srcClipX, srcClipY, clipW, clipH));

            // V12.14.10 — UNIFIED canvas allocation.  Both supported
            // modes pan along canvas Y (mirrors sensor Y motion).
            // Canvas: 1920 cols × 5000 rows = 1920w × 5000h.
            // Memory: ~28 MB BGR.
            //
            // For portrait+horizontal-pan, the saved JPEG must be in
            // user-perspective WIDE horizontal strip orientation
            // (~5000w × 1920h).  Rotation 90° applied at snapshot /
            // finalize time (see writeOutToPath) — keeps the runtime
            // engine simple, single rotation per output rather than
            // per-frame paste rotations.
            //
            // Pre-V12.14.10 the portrait canvas was 5000×1080 (perp =
            // sensor Y, wrong) — caused frames to never advance dstX
            // because the engine's pose projection was on a different
            // axis than the actual pan direction.
            if (_canvas.empty()) {
                int canvasCols = frameBGR.cols;        // perp = sensor X = 1920
                int canvasRows = (int)_canvasPanExtent; // pan = 5000
                _canvas = cv::Mat::zeros(canvasRows, canvasCols, CV_8UC3);
                _canvasMask = cv::Mat::zeros(canvasRows, canvasCols, CV_8UC1);
                NSLog(@"[V12.14.10-canvas] allocated %dx%d (cols x rows) for "
                      @"isLandscape=%d (pan extent %ld, frame=%dx%d)",
                      canvasCols, canvasRows, (int)_isLandscape,
                      (long)_canvasPanExtent, frameBGR.cols, frameBGR.rows);
                // V15 — log config snapshot at first frame.
                NSLog(@"[V15-slit] panAxisFrac=%.2f clipH=%d clipW=%d "
                      @"acceptGate=%ld tri=%d triAccum=%d 1dNcc=%d "
                      @"2dNcc=%d ransac=%d paint=%@",
                      _config.kPanAxisFractionRect, clipH, clipW,
                      (long)_config.kMinAcceptDeltaPx,
                      (int)_config.enableTriangulation,
                      (int)_config.enableTriAccumulator,
                      (int)_config.enable1dNcc,
                      (int)_config.enable2dNcc,
                      (int)_config.enableRansacHomography,
                      _config.paintMode == RLISPaintModeFeatherBlend
                          ? @"FeatherBlend" : @"FirstPaintedWins");
            }

            // V12.12 — first-frame placement at canvas ORIGIN (0, 0).
            // With the new engine-internal canvas allocation the
            // canvas perpendicular dim EXACTLY matches the clipped
            // frame's perpendicular dim, so there's no centring
            // offset — both axes are 0.  As the user pans, dstX
            // (portrait) or dstY (landscape) advances from 0.
            int dstX = 0;
            int dstY = 0;
            cv::Rect roi(dstX, dstY, clipW, clipH);
            roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
            cv::Rect srcR(0, 0, roi.width, roi.height);
            frameClipped(srcR).copyTo(_canvas(roi));
            cv::rectangle(_canvasMask, roi, cv::Scalar(255), cv::FILLED);
            _firstFrameDstX = dstX;
            _firstFrameDstY = dstY;
            // V14.0a — first accept's canvas position becomes prev for
            // the second accept's homography target-pair construction.
            _prevAcceptDstX = dstX;
            _prevAcceptDstY = dstY;
            // V12.11 Step D — initialise the running-max tracker
            // to first-frame position.  Subsequent frames must
            // monotonically advance from here along the pan axis.
            _maxDstX = dstX;
            _maxDstY = dstY;
            _hasFirstFrame = true;
            _accepted = 1;
            [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
            [tele setValue:@(1.0) forKey:@"confidence"];
            // V12.14.9 — first-frame paintedExtent on the RECTILINEAR
            // path (this is the actively-used engine; the cylindrical
            // branch below is V12.2 legacy).  Use the slit's pan-axis
            // size so the band thumb shows non-zero progress on the
            // very first frame.
            // V12.14.10: unified — both supported modes use clipH as
            // the slit's pan-axis extent.
            [tele setValue:@(clipH) forKey:@"paintedExtent"];
            NSLog(@"[V12.12-rect] first frame placed at (%d,%d) clipped=%dx%d "
                  @"(srcClip=%d,%d) along-pan-axis isLandscape=%d focal=%.2f canvas=%dx%d",
                  dstX, dstY, clipW, clipH, srcClipX, srcClipY,
                  (int)_isLandscape, _focalCompose,
                  _canvas.cols, _canvas.rows);

            // V13.0e — initialise translation correction state at the
            // FIRST accepted frame.  All subsequent slits' canvas
            // positions reference this anchor (firstFrameDstX/Y, set
            // above) AND this translation origin (_firstTranslationArkit).
            //
            // Detect ORB on the FULL sensor frame (not just the
            // 70%-clipped slit) so features near the leading edge of
            // the next pan are already in the prev set when the second
            // accept arrives — knnMatch quality depends on dense feature
            // coverage in the OVERLAP between consecutive slits.
            _firstTranslationArkit = (cv::Mat_<double>(3, 1) << tx, ty, tz);
            _prevRotationArkit = R_new.clone();
            _prevTranslationArkit = _firstTranslationArkit.clone();
            {
                cv::Mat frameGray;
                cv::cvtColor(frameBGR, frameGray, cv::COLOR_BGR2GRAY);
                std::vector<cv::KeyPoint> kps;
                cv::Mat descs;
                _orbDetector->detectAndCompute(frameGray, cv::noArray(), kps, descs);
                _prevKeypoints = std::move(kps);
                _prevDescriptors = descs;
            }
            _hasPrevAccept = true;
            return tele;
        }

        // V12.2 cylindrical-warp the first frame and place at canvas centre.
        cv::Mat warpedFirst, warpedFirstMask;
        cv::Point firstCornerCyl =
            [self cylindricalWarp:frameBGR rArkit:R_new
                            outImage:warpedFirst outMask:warpedFirstMask];
        if (warpedFirst.empty()) {
            [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
            return tele;
        }
        int dstX = (int)(_canvas.cols - warpedFirst.cols) / 2;
        int dstY = (int)(_canvas.rows - warpedFirst.rows) / 2;
        cv::Rect roi(dstX, dstY, warpedFirst.cols, warpedFirst.rows);
        roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        cv::Rect srcR(0, 0, roi.width, roi.height);
        warpedFirst(srcR).copyTo(_canvas(roi), warpedFirstMask(srcR));
        warpedFirstMask(srcR).copyTo(_canvasMask(roi),
                                       warpedFirstMask(srcR));
        _canvasOriginCylX = firstCornerCyl.x - dstX;
        _canvasOriginCylY = firstCornerCyl.y - dstY;

        _hasFirstFrame = true;
        _accepted = 1;
        [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        [tele setValue:@(1.0) forKey:@"confidence"];
        // V12.14.9 — paintedExtent was set at line ~445 to _maxDstY (= 0
        // before first frame).  In the cylindrical first-frame branch
        // we don't update _maxDstY (cylindrical uses its own canvas-
        // centre placement model rather than the slit-leading-edge
        // tracker).  Leaving paintedExtent at 0 here means the band
        // thumb shows zero progress on the cylindrical first frame —
        // acceptable; the next frame's running-max update will set
        // a real value.  Cylindrical is V12.2 legacy and not the
        // primary engine; rectilinear (above) sets a real value.
        return tele;
    }

    if (_useRectilinear) {
        // V12.8 Variant B subsequent frame: paste the SAME long-side-
        // clipped portion as the first frame, at canvas position
        // offset by pan_angle × focal along the pan axis.  First-
        // painted-wins masking ensures only the LEADING-EDGE sliver
        // (the part outside the previously-painted region) actually
        // gets painted.  Even tiny pans produce immediate
        // incremental growth — no V12.7 dead-zone where strips
        // entirely overlapped the first frame.
        cv::Mat R_rel = _firstRotationArkit.t() * R_new;
        // V12.14.10 — UNIFIED clip for both supported modes (see
        // first-frame branch comment).  Both pan around cam +X →
        // sensor content moves along sensor Y → clip sensor Y to
        // 70%, full sensor X.
        int clipW, clipH, srcClipX, srcClipY;
        clipW = frameBGR.cols;
        // V15 — clipH from _config (matches first-frame branch above).
        clipH = std::max(1, (int)(frameBGR.rows * _config.kPanAxisFractionRect));
        srcClipX = 0;
        srcClipY = (frameBGR.rows - clipH) / 2;
        cv::Mat frameClipped = frameBGR(cv::Rect(srcClipX, srcClipY, clipW, clipH));

        // V12.14.10 — UNIFIED pose projection.  Both supported modes
        // have pan rotation around cam +X axis.  alpha > 0 means the
        // camera rotated such that sensor content moved DOWN (cam-Z
        // toward cam+Y in OpenCV right-down-forward convention) →
        // dstY in canvas advances NEGATIVE (content shifts UP / to
        // smaller Y), matching the existing landscape paste convention.
        //
        // For portrait+horizontal-pan the user perceives this as
        // "look right" or "look left" depending on hold direction;
        // the canvas-Y growth still represents pan progress, and
        // the canvas-rotated saved JPEG (writeOutToPath) maps that
        // progress to the user-perspective horizontal direction.
        double alpha = std::atan2(R_rel.at<double>(2, 1), R_rel.at<double>(1, 1));
        int dstX = _firstFrameDstX;
        int dstY = _firstFrameDstY - (int)std::round(alpha * _focalCompose);

        // V13.0a.4 — FAULT-level os_log (bypasses NSLog burst rate-
        // limit; throttle still applied to keep Console.app readable).
        if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
            os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                "[V13.0a-pose] #%ld alpha_deg=%.3f focal=%.1f dstX=%d dstY=%d "
                "(firstDstY=%d, deltaDstY=%d)",
                (long)_engineCallCounter, alpha * 180.0 / M_PI, _focalCompose,
                dstX, dstY, _firstFrameDstY, dstY - _firstFrameDstY);
        }

        // V13.0a — REVERTED V12.11 Step 4 + V12.11.1 Item E + V12.14
        // homography refinement.  Restored pose-only paste.
        //
        // Why reverted: the ORB+RANSAC homography correction (V12.11)
        // and the full warpPerspective paste (V12.11.1) introduced
        // chronic chevron / banding / frame-stacking artifacts under
        // realistic capture conditions (low overlap, low texture,
        // fast pan).  V12.14's 3-tier ladder filtered the worst
        // homographies but couldn't fully tame them — MED tier
        // translation-only correction strips rotation/scale and
        // produces the "frames pull back" pattern in field traces.
        //
        // Pose-only paste is what production camera apps (iOS Camera
        // Pano, Samsung native pano) use as their PRIMARY tracking;
        // they layer lightweight 1D edge correlation on top for
        // sub-pixel perpendicular drift correction.  V13.0b will
        // restore that lightweight refinement (1D NCC column
        // correlation, ±100 px search) on top of this pose-only
        // baseline.
        //
        // For now (V13.0a): rotation is correct from ARKit pose;
        // perpendicular drift may be visible (~5–10 px on short
        // pans) until V13.0b lands.  Translation along the pan
        // axis comes from `alpha * _focalCompose` above.

        // V12.11 Step D — reverse-direction detection.
        //
        // After homography correction, check whether the new paste
        // position has REGRESSED from the running max along the
        // pan axis by more than `kReverseStopPx`.  If so, the
        // operator has reversed direction (intentionally or
        // accidentally) — skip the paste, emit
        // `RejectedReverseDirection`, and let the host auto-finalise.
        // The high-water-mark (max) is what we want to ship as the
        // pano; back-tracking would only damage it under
        // first-painted-wins.
        //
        // Threshold: 150 px ≈ 4° of pan at the typical iPhone focal —
        // comfortably above normal alignment-correction wobble.
        // V12.14.10 — UNIFIED running-max for both supported modes.
        // Both pan along canvas Y, so _maxDstY is the leading-edge
        // tracker in both.  _maxDstX stays at 0 (perp axis static).
        // Reverse-direction detection: when dstY regresses
        // > kReverseStopPx (150 px ≈ 4° at iPhone focal), auto-stop
        // the engine — operator has clearly reversed pan direction.
        constexpr int kReverseStopPx = 150;
        if (dstY < _maxDstY - kReverseStopPx) {
            NSLog(@"[V12.11-reverse] %s stop: dstY=%d max=%d (regressed %d px)",
                  _isLandscape ? "landscape" : "portrait",
                  dstY, _maxDstY, _maxDstY - dstY);
            [tele setValue:@(RLISFrameOutcomeRejectedReverseDirection) forKey:@"outcome"];
            return tele;
        }

        // V13.0b — minimum-Δ accept gate.  Slow handheld pans
        // currently produce 1–6 px slivers per accept (Ram's
        // V13.0a.4 trace showed ~2–3 px typical), creating ~270
        // zig-zag boundaries in 663 px of pan growth — the high-
        // frequency wobble pattern the eye reads as "compressed
        // vertical features" / TV-stand-looks-shorter.
        //
        // Throttle accepts to require at least kMinAcceptDeltaPx
        // of pan-axis advance from the last accepted frame.  Per-
        // accept sliver becomes ~50 px tall instead of ~2 px,
        // dropping zig-zag boundary count ~25× over the same pan
        // extent.  Same wobble magnitude per boundary, but spread
        // across far fewer transitions = visually much smoother.
        //
        // Mirrors how production camera apps gate slit-scan accepts
        // by motion-distance threshold (iOS Camera Pano, Samsung
        // native pano).  No new outcome enum — reuse SkippedTooClose
        // since the gate's intent matches: "frame too close to
        // previous accept to contribute meaningfully".
        // V15 — accept gate is config-driven.  When _config.kMinAcceptDeltaPx
        // is 0 (slitscan-rotate / slitscan-both defaults), the gate is
        // effectively disabled — we accept on every frame the engine isn't
        // already busy with.  When 50 (V13.0g/V14.0a default), throttles
        // accepts to one per 50 px of pan-axis advance to reduce zig-zag
        // boundary density.  Settings UI exposes this for testing.
        const int kMinAcceptDeltaPx = (int)_config.kMinAcceptDeltaPx;
        const int panDelta = dstY - _maxDstY;
        if (kMinAcceptDeltaPx > 0 && panDelta < kMinAcceptDeltaPx) {
            // V13.0b — diagnostic gate-fire log (throttled).
            if (_engineCallCounter % 5 == 0) {
                os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                    "[V13.0b-gate] #%ld dstY=%d _maxDstY=%d panDelta=%d "
                    "< kMinAcceptDeltaPx=%d -> SkippedTooClose",
                    (long)_engineCallCounter, dstY, _maxDstY, panDelta,
                    kMinAcceptDeltaPx);
            }
            [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
            auto t1 = std::chrono::steady_clock::now();
            double ms = std::chrono::duration_cast<std::chrono::microseconds>(
                t1 - t0).count() / 1000.0;
            [tele setValue:@(ms) forKey:@"processingMs"];
            return tele;
        }

        // V13.0f — TWO-LAYER alignment: ORB triangulation (depth-aware
        // big shifts) + 2D NCC (visual fine refinement) on top of
        // pose-only.  Paint is first-painted-wins on the full clipH.
        //
        // ─── ARCHITECTURE ────────────────────────────────────────────
        // Past the V13.0b 50 px gate; this slit will be accepted.  Three
        // independent error sources move scene pixels off their pose-
        // predicted canvas position:
        //
        //   (1) Translation parallax — the camera doesn't pivot in
        //       place; ARKit logs ~30–40 cm of camera translation per
        //       pan.  At 1–3 m scene depth that's tens to a hundred px
        //       of perpendicular drift.  This is depth-dependent and
        //       hence Z-aware.
        //   (2) ARKit pose drift / sensor wobble — sub-degree pose
        //       errors that show up as a few-px shift in image plane.
        //       Depth-INdependent (uniform across the slit).
        //   (3) Multi-depth disagreement — close objects have larger
        //       parallax than far objects; a single canvas-paste shift
        //       can't satisfy both.  Architectural limit; out of scope
        //       for V13.0f (would need per-pixel depth = LiDAR).
        //
        // V13.0e fixed (1) only — triangulation handles the depth-aware
        // big shifts.  But V13.0e bad-Z cases (close textured features
        // bias median Z) over-corrected, and the test exposed (2) as
        // visible hard seams in the rotation case.  V13.0f layers NCC
        // on top of triangulation so:
        //
        //   tri    handles parallax (when Z is plausible)
        //   NCC    handles residual visual mismatch (~ ±30 px)
        //
        // ─── TIGHTER TRIANGULATION ───────────────────────────────────
        //   • Z range filter [0.5m, 10m] (was [0.1, 20m]).  V13.0e test
        //     showed median Z = 0.27 m — real, but biased by
        //     close-textured peg-hook features.  Rejecting Z < 0.5 m
        //     biases median onto the dominant mid-scene plane (1–3 m).
        //   • Cap |triDx|, |triDy| at ±50 px (was ±100).  Smaller cap
        //     keeps the post-tri position close enough that NCC's ±30
        //     search can find the visually correct match if tri was off.
        //
        // ─── 2D NCC FINE-ALIGNMENT ──────────────────────────────────
        //   V13.0d's NCC bug: the X-search width clamped to canvas.cols
        //   left zero slide room (`searchW > clipW` was 1440 > 1440).
        //   V13.0f fixes this by NARROWING the SOURCE template by 30 px
        //   on each side (sourceW = clipW − 60).  matchTemplate over a
        //   1440 × ~160 search region against a 1380 × 100 source has
        //   60 × 60 of slide room — enough to recover ±30 px in X and Y.
        //
        //   Source: top kNccSourceHeight = 100 px of clipped slit, X-
        //   inset by kNccSourceXInset = 30.  Search: canvas region
        //   around (dstX, dstY) with ±kNccSearchMargin = 30 px slop.
        //   NCC confidence ≥ 0.6 to apply, else skip.
        //
        // ─── FORWARD-ONLY Y CLAMP (after both layers) ───────────────
        //   The combined tri + NCC correction can pull dstY below
        //   _maxDstY (V12.14 frame-stacking risk).  Clamp dstY ≥
        //   _maxDstY at the very end — applied ONCE on the final value,
        //   not inside each layer.
        //
        // ─── FIRST-PAINTED-WINS PAINT ───────────────────────────────
        //   No feather blend.  V13.0d showed feather + imperfect
        //   alignment = ghosting in detail-rich regions.  With tri + NCC
        //   doing the alignment work, residuals are sub-px to a few px
        //   — hard seams in those regions read as thin lines rather
        //   than blurred edges.
        const int poseDstY = dstY;
        const int poseDstX = dstX;

        // ── V15 LAYER 0: 1D NCC perpendicular-axis wobble correction ──
        // For slitscan-rotate (rotation-only pan), the dominant residual
        // after pose-only paste is small horizontal jitter in canvas-X
        // from handheld wobble (rotation around an imperfectly-stable
        // axis introduces small perpendicular displacement frame-to-
        // frame).  A narrow 1D NCC search in canvas-X (Y fixed at pose
        // value) recovers the sub-pixel offset.
        //
        // Source: a thin strip from the top of the new clipped slit
        // (the part that overlaps already-painted canvas).  Search:
        // canvas region around (dstX, poseDstY) with ±kRadius in X,
        // narrow Y window.  Templates correlate via TM_CCOEFF_NORMED;
        // confidence ≥ 0.6 to apply, else skip.
        //
        // Independent of triangulation/RANSAC stages — those handle
        // translation parallax (depth-dependent shift, big magnitudes).
        // 1D NCC handles depth-INDEPENDENT wobble (small, perpendicular).
        // Both can run simultaneously if the user enables them.
        int ncc1dDx = 0;
        double ncc1dConfidence = 0.0;
        bool ncc1dApplied = false;

        if (_config.enable1dNcc && _hasPrevAccept && _accepted >= 1) {
            const int kRadius = std::max(5, std::min(60,
                                  (int)_config.nccSearchRadius1d));
            const int kSourceHeight = 60;       // shallow strip
            const int kSourceXInset = kRadius;  // leave slide room
            const int sourceW = clipW - 2 * kSourceXInset;

            if (sourceW > 0
                && srcClipY >= 0
                && srcClipY + kSourceHeight <= frameBGR.rows
                && srcClipX + kSourceXInset + sourceW <= frameBGR.cols
                && dstY >= 0
                && dstY + kSourceHeight <= _canvas.rows) {

                cv::Mat sourceRegion = frameBGR(cv::Rect(
                    srcClipX + kSourceXInset, srcClipY,
                    sourceW, kSourceHeight));

                int searchLeft = std::max(0, dstX + kSourceXInset - kRadius);
                int searchRight = std::min((int)_canvas.cols,
                                  dstX + kSourceXInset + sourceW + kRadius);
                int searchTop = std::max(0, dstY);
                int searchBottom = std::min((int)_canvas.rows,
                                            dstY + kSourceHeight);
                const int searchW = searchRight - searchLeft;
                const int searchH = searchBottom - searchTop;

                if (searchW >= sourceW && searchH >= kSourceHeight) {
                    cv::Mat searchMaskRoi = _canvasMask(cv::Rect(
                        searchLeft, searchTop, searchW, searchH));
                    if (cv::countNonZero(searchMaskRoi) > 0) {
                        cv::Mat searchRegion = _canvas(cv::Rect(
                            searchLeft, searchTop, searchW, searchH));

                        cv::Mat sg, rg;
                        cv::cvtColor(sourceRegion, sg, cv::COLOR_BGR2GRAY);
                        cv::cvtColor(searchRegion, rg, cv::COLOR_BGR2GRAY);

                        cv::Mat result;
                        cv::matchTemplate(rg, sg, result,
                                          cv::TM_CCOEFF_NORMED);

                        double rmin, rmax;
                        cv::Point lmin, lmax;
                        cv::minMaxLoc(result, &rmin, &rmax, &lmin, &lmax);
                        ncc1dConfidence = rmax;

                        if (ncc1dConfidence >= 0.6) {
                            const int matchX = searchLeft + lmax.x;
                            int rawDx = matchX - (dstX + kSourceXInset);
                            if (rawDx >  kRadius) rawDx =  kRadius;
                            if (rawDx < -kRadius) rawDx = -kRadius;
                            ncc1dDx = rawDx;
                            dstX += ncc1dDx;
                            ncc1dApplied = true;
                        }
                    }
                }
            }
        }

        if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
            os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                "[V15-1dncc] #%ld dx=%+d conf=%.3f applied=%d "
                "(poseDstX=%d -> dstX=%d)",
                (long)_engineCallCounter, ncc1dDx, ncc1dConfidence,
                (int)ncc1dApplied, poseDstX, dstX);
        }

        // V15 — ORB detect runs only if any feature-using stage is
        // enabled.  Skips ~5 ms per accept when slitscan-rotate /
        // slitscan-both-default (pose-only + 1D NCC + feather) don't
        // need it.
        const bool needFeatures =
            _config.enableTriangulation ||
            _config.enable2dNcc ||
            _config.enableRansacHomography;

        std::vector<cv::KeyPoint> curKeypoints;
        cv::Mat curDescriptors;
        if (needFeatures) {
            cv::Mat curGray;
            cv::cvtColor(frameBGR, curGray, cv::COLOR_BGR2GRAY);
            _orbDetector->detectAndCompute(curGray, cv::noArray(),
                                           curKeypoints, curDescriptors);
        }

        // ── LAYER 1: triangulation-based parallax correction ────────
        // V13.0g: triDx/triDy report the ACCUMULATED total (rounded
        // _accumTriCorrectionX/Y) actually applied to dstX/Y.
        // triIncX/triIncY report this accept's incremental contribution
        // to that accumulator — useful for spotting bad-Z bursts.
        int triMatches = 0;
        double medianZ = 0.0;
        int triDx = 0;
        int triDy = 0;
        int triIncX = 0;
        int triIncY = 0;
        bool triApplied = false;

        // V14.0a — prevPts/curPts declared at outer scope (was inside
        // the triangulation if-block in V13.0g) so V14.0a's RANSAC
        // homography pass below can reuse them.  Empty when no matches
        // were computed (e.g., first accept, or _hasPrevAccept=false).
        std::vector<cv::Point2d> prevPts, curPts;

        // V15 — feature matching runs whenever ORB is detected.  The
        // resulting prevPts/curPts are reused by triangulation (this
        // block), 2D NCC (V13.0g code, gated on _config.enable2dNcc),
        // and RANSAC homography (V14.0a code, gated on
        // _config.enableRansacHomography).  Triangulation logic itself
        // is gated on _config.enableTriangulation inside.
        if (needFeatures
            && _hasPrevAccept
            && !curDescriptors.empty()
            && !_prevDescriptors.empty()
            && _prevKeypoints.size() >= 8
            && curKeypoints.size() >= 8) {

            cv::BFMatcher matcher(cv::NORM_HAMMING);
            std::vector<std::vector<cv::DMatch>> knnMatches;
            matcher.knnMatch(_prevDescriptors, curDescriptors, knnMatches, 2);

            // Lowe ratio test: keep matches where the best match's
            // descriptor distance is < 0.7 × second-best's, weeding
            // out ambiguous repeated-texture pairs.
            // V14.0a — prevPts/curPts moved to outer scope (just before
            // the if-block) so V14.0a's RANSAC homography pass below
            // can use them; declarations no longer here.
            prevPts.reserve(knnMatches.size());
            curPts.reserve(knnMatches.size());
            constexpr float kLoweRatio = 0.7f;
            for (const auto &m : knnMatches) {
                if (m.size() == 2 && m[0].distance < kLoweRatio * m[1].distance) {
                    prevPts.emplace_back(
                        _prevKeypoints[m[0].queryIdx].pt.x,
                        _prevKeypoints[m[0].queryIdx].pt.y);
                    curPts.emplace_back(
                        curKeypoints[m[0].trainIdx].pt.x,
                        curKeypoints[m[0].trainIdx].pt.y);
                }
            }

            // V15 — triangulation algorithm gated on enableTriangulation.
            // ORB matches above (prevPts/curPts) are computed regardless
            // because they're shared with V14.0a RANSAC homography below.
            if (_config.enableTriangulation && prevPts.size() >= 8) {
                // Build cv-frame projection matrices.  Pose convention:
                //   R_arkit is camera-to-world in arkit coords.
                //   R_cv  = M × R_arkit × M^T  (M = diag(1,-1,-1)).
                //   t_cv  = M × t_arkit  (camera origin in world cv).
                // World-to-camera projection: K × [R_cv^T | -R_cv^T × t_cv].
                cv::Mat R0_cv = _M_arkitToCv * _prevRotationArkit * _M_arkitToCv;
                cv::Mat R1_cv = _M_arkitToCv * R_new * _M_arkitToCv;
                cv::Mat t0_cv = _M_arkitToCv * _prevTranslationArkit;
                cv::Mat t1_cv = _M_arkitToCv * (cv::Mat_<double>(3, 1) << tx, ty, tz);

                cv::Mat T0(3, 4, CV_64F);
                cv::Mat T1(3, 4, CV_64F);
                {
                    cv::Mat R0t = R0_cv.t();
                    cv::Mat origin0 = -R0t * t0_cv;
                    R0t.copyTo(T0(cv::Rect(0, 0, 3, 3)));
                    origin0.copyTo(T0(cv::Rect(3, 0, 1, 3)));

                    cv::Mat R1t = R1_cv.t();
                    cv::Mat origin1 = -R1t * t1_cv;
                    R1t.copyTo(T1(cv::Rect(0, 0, 3, 3)));
                    origin1.copyTo(T1(cv::Rect(3, 0, 1, 3)));
                }

                cv::Mat P0 = _K_compose * T0;
                cv::Mat P1 = _K_compose * T1;

                // 2xN pixel-coord matrices for each camera.
                cv::Mat prevMat(2, (int)prevPts.size(), CV_64F);
                cv::Mat curMat(2, (int)curPts.size(), CV_64F);
                for (int i = 0; i < (int)prevPts.size(); i++) {
                    prevMat.at<double>(0, i) = prevPts[i].x;
                    prevMat.at<double>(1, i) = prevPts[i].y;
                    curMat.at<double>(0, i) = curPts[i].x;
                    curMat.at<double>(1, i) = curPts[i].y;
                }

                cv::Mat pts4D;
                cv::triangulatePoints(P0, P1, prevMat, curMat, pts4D);

                // Compute Z (depth) in CURRENT camera frame for each
                // triangulated point.  V13.0f tightens the filter to
                // [0.5m, 10m] (was [0.1, 20]) — V13.0e test showed
                // close textured features (peg hooks at ~30 cm) biased
                // the median.  Rejecting Z < 0.5 m biases the median
                // onto the dominant mid-scene plane.
                std::vector<double> zs;
                zs.reserve(pts4D.cols);
                cv::Mat R1_cv_T = R1_cv.t();
                for (int i = 0; i < pts4D.cols; i++) {
                    double w = pts4D.at<double>(3, i);
                    if (std::fabs(w) < 1e-9) continue;
                    cv::Mat Pworld = (cv::Mat_<double>(3, 1) <<
                                      pts4D.at<double>(0, i) / w,
                                      pts4D.at<double>(1, i) / w,
                                      pts4D.at<double>(2, i) / w);
                    cv::Mat Pcam = R1_cv_T * (Pworld - t1_cv);
                    double Z = Pcam.at<double>(2);
                    if (Z > 0.5 && Z < 10.0) {
                        zs.push_back(Z);
                    }
                }
                triMatches = (int)zs.size();

                if (zs.size() >= 5) {
                    std::sort(zs.begin(), zs.end());
                    medianZ = zs[zs.size() / 2];

                    // V13.0g — INCREMENTAL Δt since previous accept,
                    // NOT cumulative since first frame.  V13.0e/f's
                    // cumulative-from-first formulation produced
                    // corrections of hundreds of px at typical pan
                    // motion (Δt cumulative ≈ 40 cm × focal / Z), and
                    // the cap clipped most of them — leaving severe
                    // misalignment between adjacent slits in the late
                    // half of every pan.  Per-accept Δt is small
                    // (~4 cm); per-accept correction is small (~30–100
                    // px); we accumulate the increments in
                    // _accumTriCorrectionX/Y to recover the cumulative
                    // total without a hard cap on that total.
                    cv::Mat dt_world_cv = _M_arkitToCv *
                        ((cv::Mat_<double>(3, 1) << tx, ty, tz) - _prevTranslationArkit);
                    cv::Mat dt_cam_cv = R1_cv_T * dt_world_cv;

                    double rawTriDxInc = +_focalCompose * dt_cam_cv.at<double>(0) / medianZ;
                    double rawTriDyInc = +_focalCompose * dt_cam_cv.at<double>(1) / medianZ;

                    // V13.0g per-accept cap = ±80.  Bigger than V13.0f's
                    // ±50 because the INCREMENT lands at typical per-
                    // accept parallax magnitude (Δt ~4 cm × focal / Z ≈
                    // 30–100 px for Z ∈ [0.5, 1.5] m).  Bad-Z spikes on
                    // a single accept contribute up to ±80 to the
                    // accumulator; subsequent good-Z accepts continue
                    // with their correct magnitudes (no global
                    // rescaling like V13.0e/f cumulative formulas).
                    constexpr double kMaxTriIncCorrection = 80.0;
                    if (std::fabs(rawTriDxInc) > kMaxTriIncCorrection) {
                        rawTriDxInc = (rawTriDxInc > 0 ? 1.0 : -1.0) * kMaxTriIncCorrection;
                    }
                    if (std::fabs(rawTriDyInc) > kMaxTriIncCorrection) {
                        rawTriDyInc = (rawTriDyInc > 0 ? 1.0 : -1.0) * kMaxTriIncCorrection;
                    }

                    // Per-accept increment (ints, for diagnostics).
                    triIncX = (int)std::round(rawTriDxInc);
                    triIncY = (int)std::round(rawTriDyInc);

                    // Accumulate.  Total correction grows naturally
                    // as accepts process; no hard cap on the running
                    // total.  The applied dstX/Y delta is the ROUNDED
                    // accumulator, not just this accept's increment —
                    // pose-only dstX/Y is reset to first-frame anchor
                    // every accept, so we layer the full accumulator.
                    _accumTriCorrectionX += rawTriDxInc;
                    _accumTriCorrectionY += rawTriDyInc;

                    triDx = (int)std::round(_accumTriCorrectionX);
                    triDy = (int)std::round(_accumTriCorrectionY);

                    // V13.0f: NO inner Y clamp here.  The final
                    // forward-only clamp runs once after BOTH layers
                    // (tri + NCC), which is the point where dstY's
                    // value is actually committed.
                    dstX += triDx;
                    dstY += triDy;
                    triApplied = true;
                }
            }
        }

        if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
            os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                "[V13.0g-tri] #%ld matches=%d medianZ=%.2fm inc=%+d,%+d "
                "accum=%+d,%+d applied=%d (poseDstX=%d poseDstY=%d -> "
                "dstX=%d dstY=%d)",
                (long)_engineCallCounter, triMatches, medianZ,
                triIncX, triIncY, triDx, triDy, (int)triApplied,
                poseDstX, poseDstY, dstX, dstY);
        }

        // ── V15 LAYER 1.5: V13.0g-style 2D NCC fine-alignment ────────
        // Restored from V13.0g (was deleted in V14.0a in favour of
        // RANSAC homography).  Gated on _config.enable2dNcc.  When both
        // 2D NCC and RANSAC are enabled, 2D NCC's translation refines
        // dstX/dstY first; RANSAC then runs on top — if RANSAC produces
        // a valid homography it warps the slit non-rigidly, overriding
        // the rectangular paste path.  When RANSAC is disabled, 2D NCC
        // is the only refinement after triangulation.
        //
        // Source: top 100 px of clipped slit, X-inset 30 px each side
        // (so cv::matchTemplate has slide room).  Search: canvas region
        // around (dstX, dstY) with ±30 px X+Y slop.  Confidence ≥ 0.6
        // to apply, Δx/Δy each capped at ±30.
        int ncc2dDx = 0, ncc2dDy = 0;
        double ncc2dConfidence = 0.0;
        bool ncc2dApplied = false;

        if (_config.enable2dNcc) {
            constexpr int kNccSourceHeight = 100;
            constexpr int kNccSearchMargin = 30;
            constexpr int kNccSourceXInset = 30;

            const int sourceW = clipW - 2 * kNccSourceXInset;

            if (sourceW > 0
                && srcClipY + kNccSourceHeight <= frameBGR.rows
                && srcClipX + kNccSourceXInset + sourceW <= frameBGR.cols) {

                cv::Mat sourceRegion = frameBGR(cv::Rect(
                    srcClipX + kNccSourceXInset,
                    srcClipY,
                    sourceW, kNccSourceHeight));

                const int expectedMatchX = dstX + kNccSourceXInset;
                const int expectedMatchY = dstY;

                int searchLeft = std::max(0, expectedMatchX - kNccSearchMargin);
                int searchTop = std::max(0, expectedMatchY - kNccSearchMargin);
                int searchRight = std::min((int)_canvas.cols,
                                  expectedMatchX + sourceW + kNccSearchMargin);
                int searchBottom = std::min((int)_canvas.rows,
                                  expectedMatchY + kNccSourceHeight + kNccSearchMargin);
                const int searchW = searchRight - searchLeft;
                const int searchH = searchBottom - searchTop;

                if (searchW >= sourceW && searchH >= kNccSourceHeight) {
                    cv::Mat searchMaskRoi = _canvasMask(cv::Rect(
                        searchLeft, searchTop, searchW, searchH));
                    if (cv::countNonZero(searchMaskRoi) > 0) {
                        cv::Mat searchRegion = _canvas(cv::Rect(
                            searchLeft, searchTop, searchW, searchH));

                        cv::Mat sg, rg;
                        cv::cvtColor(sourceRegion, sg, cv::COLOR_BGR2GRAY);
                        cv::cvtColor(searchRegion, rg, cv::COLOR_BGR2GRAY);

                        cv::Mat result;
                        cv::matchTemplate(rg, sg, result, cv::TM_CCOEFF_NORMED);

                        double rmin, rmax;
                        cv::Point lmin, lmax;
                        cv::minMaxLoc(result, &rmin, &rmax, &lmin, &lmax);
                        ncc2dConfidence = rmax;

                        if (ncc2dConfidence >= 0.6) {
                            const int matchX = searchLeft + lmax.x;
                            const int matchY = searchTop + lmax.y;
                            int rawDx = matchX - expectedMatchX;
                            int rawDy = matchY - expectedMatchY;
                            if (rawDx >  kNccSearchMargin) rawDx =  kNccSearchMargin;
                            if (rawDx < -kNccSearchMargin) rawDx = -kNccSearchMargin;
                            if (rawDy >  kNccSearchMargin) rawDy =  kNccSearchMargin;
                            if (rawDy < -kNccSearchMargin) rawDy = -kNccSearchMargin;

                            ncc2dDx = rawDx;
                            ncc2dDy = rawDy;
                            dstX += ncc2dDx;
                            dstY += ncc2dDy;
                            ncc2dApplied = true;
                        }
                    }
                }
            }
        }

        if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
            os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                "[V15-2dncc] #%ld dx=%+d dy=%+d conf=%.3f applied=%d "
                "(after-tri dstX=%d dstY=%d)",
                (long)_engineCallCounter, ncc2dDx, ncc2dDy,
                ncc2dConfidence, (int)ncc2dApplied, dstX, dstY);
        }

        // ── LAYER 2: V14.0a RANSAC homography refinement ─────────────
        // V13.0g used 2D NCC to find a single (Δx, Δy) translation that
        // best aligned the slit's overlap region with the canvas's
        // existing painted region.  NCC's single-translation model
        // cannot satisfy multi-depth scenes (a door with frame at 1.4 m,
        // surface at 1.5 m, wall behind at 1.8 m): each depth wants a
        // different shift, so a single shift visibly mis-aligns at
        // least one depth → the door-shear visible in V13.0g and
        // V14.0pre.1 outputs.
        //
        // V14.0a feeds the SAME ORB matches V13.0g already computed
        // for triangulation into RANSAC homography fitting.
        // Homography is 8-DOF: each matched feature gets its own
        // implied position via a 3×3 projective transform.  The
        // dominant scene plane fits exactly; off-plane features (with
        // residual parallax) become RANSAC outliers and are filtered.
        // The slit is then warped via cv::warpPerspective into canvas
        // space — producing a non-rectangular footprint that aligns
        // visually for all features simultaneously.
        //
        // Failure mode: degenerate matches (fewer than 8 inliers, or
        // matches on a single line) → fall back to V13.0g pose+tri-only
        // rectangular paste.  No multi-tier ladder (V12.14's lesson:
        // confidence tiers compound errors).
        bool homographyApplied = false;
        cv::Mat homographyH;
        int homographyInlierCount = 0;
        double homographyAvgReproj = 0.0;

        // V15 — RANSAC homography gated on enableRansacHomography.
        if (_config.enableRansacHomography
            && _hasPrevAccept
            && prevPts.size() >= 8
            && curPts.size() >= 8) {
            // Build per-match canvas-coord targets: where each prev
            // feature was actually painted on the canvas.
            //
            // prev_pts is in PREV FRAME pixel coords (full sensor).
            // prev was painted at canvas position
            //   (_prevAcceptDstX + prev_fx − srcClipX,
            //    _prevAcceptDstY + prev_fy − srcClipY)
            // assuming a rectangular paste at (_prevAcceptDstX,
            // _prevAcceptDstY).  If the previous accept used homography
            // warp itself, this is approximate within the prev
            // homography's deviation from translation; RANSAC absorbs
            // the residual as match-pair noise.
            std::vector<cv::Point2f> srcPts;     // cur frame pixel coords
            std::vector<cv::Point2f> dstCanvasPts;  // canvas pixel coords
            srcPts.reserve(prevPts.size());
            dstCanvasPts.reserve(prevPts.size());
            for (size_t i = 0; i < prevPts.size(); i++) {
                const double prev_canvas_x =
                    _prevAcceptDstX + prevPts[i].x - srcClipX;
                const double prev_canvas_y =
                    _prevAcceptDstY + prevPts[i].y - srcClipY;
                srcPts.emplace_back((float)curPts[i].x, (float)curPts[i].y);
                dstCanvasPts.emplace_back((float)prev_canvas_x,
                                          (float)prev_canvas_y);
            }

            std::vector<unsigned char> ransacInliers;
            cv::Mat H = cv::findHomography(srcPts, dstCanvasPts,
                                            cv::RANSAC,
                                            3.0,        // reproj threshold (px)
                                            ransacInliers,
                                            2000,       // max iters
                                            0.995);     // confidence

            if (!H.empty()) {
                homographyInlierCount = cv::countNonZero(ransacInliers);

                // Reject degenerate homographies: too few inliers OR
                // a near-singular matrix (det close to 0, common when
                // matches lie on a single line — peg-board scenes).
                const double H_det = cv::determinant(H);
                const bool degenerate =
                    (homographyInlierCount < 8) ||
                    (std::fabs(H_det) < 1e-6);

                if (!degenerate) {
                    // Compute mean reprojection residual on inliers
                    // (diagnostic: tight homographies → small residual).
                    double sumResid = 0.0;
                    int nResid = 0;
                    for (size_t i = 0; i < srcPts.size(); i++) {
                        if (!ransacInliers[i]) continue;
                        cv::Mat src_h = (cv::Mat_<double>(3, 1) <<
                                         srcPts[i].x, srcPts[i].y, 1.0);
                        cv::Mat dst_h = H * src_h;
                        const double w = dst_h.at<double>(2);
                        if (std::fabs(w) < 1e-9) continue;
                        const double dxR = dst_h.at<double>(0) / w
                                           - dstCanvasPts[i].x;
                        const double dyR = dst_h.at<double>(1) / w
                                           - dstCanvasPts[i].y;
                        sumResid += std::sqrt(dxR * dxR + dyR * dyR);
                        nResid++;
                    }
                    homographyAvgReproj = (nResid > 0)
                        ? (sumResid / nResid) : 0.0;

                    homographyH = H;
                    homographyApplied = true;
                }
            }
        }

        if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
            os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                "[V14.0a-ransac] #%ld matches=%zu inliers=%d "
                "avgReproj=%.2fpx applied=%d",
                (long)_engineCallCounter,
                prevPts.size(), homographyInlierCount,
                homographyAvgReproj, (int)homographyApplied);
        }

        // ── Forward-only Y guard on running max ─────────────────────
        // For pose+tri fallback, dstY (post-clamp) is the slit top.
        // For homography path, the warped slit's actual top edge is
        // the warpedMask's bounding-box top.  Clamp dstY (used by
        // pose+tri fallback path AND as the diagnostic "pre-warp dstY"
        // value in the paint log).
        if (dstY < (int)_maxDstY) {
            dstY = (int)_maxDstY;
        }

        // ── V14.0a paint ────────────────────────────────────────────
        // Two paths: homography warp (preferred) or pose+tri rectangular
        // paste (fallback).  Both apply first-painted-wins masking so
        // earlier slits' content is preserved.
        cv::Mat warpedCanvas;
        cv::Mat warpedCanvasMask;

        if (homographyApplied) {
            // Warp the clipped slit into canvas-sized output via the
            // RANSAC homography.  Compose H with a translation matrix
            // so the warp source is the slit-local clipped ROI rather
            // than the full frame:
            //   pixel_canvas = H_full * pixel_full
            //   pixel_full   = pixel_slit + (srcClipX, srcClipY)
            //   ⇒ H_slit     = H_full * T(srcClipX, srcClipY)
            cv::Rect srcSlitRect(srcClipX, srcClipY, clipW, clipH);
            cv::Mat srcSlit = frameBGR(srcSlitRect);

            cv::Mat T_slit = (cv::Mat_<double>(3, 3) <<
                1, 0, (double)srcClipX,
                0, 1, (double)srcClipY,
                0, 0, 1);
            cv::Mat H_slit = homographyH * T_slit;

            warpedCanvas = cv::Mat::zeros(_canvas.size(), CV_8UC3);
            cv::warpPerspective(srcSlit, warpedCanvas, H_slit,
                                _canvas.size(),
                                cv::INTER_LINEAR,
                                cv::BORDER_CONSTANT,
                                cv::Scalar(0, 0, 0));

            cv::Mat whiteSlit(srcSlit.size(), CV_8UC1, cv::Scalar(255));
            warpedCanvasMask = cv::Mat::zeros(_canvas.size(), CV_8UC1);
            cv::warpPerspective(whiteSlit, warpedCanvasMask, H_slit,
                                _canvas.size(),
                                cv::INTER_NEAREST,
                                cv::BORDER_CONSTANT,
                                cv::Scalar(0));
        } else {
            // Fallback: V13.0g pose+tri-only rectangular paste at
            // (dstX, dstY).  Build a canvas-sized image with just the
            // slit pasted at its rectangular position.
            warpedCanvas = cv::Mat::zeros(_canvas.size(), CV_8UC3);
            warpedCanvasMask = cv::Mat::zeros(_canvas.size(), CV_8UC1);

            cv::Rect dstRoi(dstX, dstY, clipW, clipH);
            cv::Rect canvasBoundsRect(0, 0, _canvas.cols, _canvas.rows);
            cv::Rect dstClipped = dstRoi & canvasBoundsRect;
            if (dstClipped.width <= 0 || dstClipped.height <= 0) {
                [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost)
                        forKey:@"outcome"];
                return tele;
            }

            cv::Rect srcRoiInFrame(
                srcClipX + (dstClipped.x - dstX),
                srcClipY + (dstClipped.y - dstY),
                dstClipped.width, dstClipped.height);
            frameBGR(srcRoiInFrame).copyTo(warpedCanvas(dstClipped));
            warpedCanvasMask(dstClipped).setTo(255);
        }

        // ── Update running max along pan axis ───────────────────────
        // For non-rectangular warped footprints, use the mask's
        // bounding-box top as the upper edge (forward-only invariant
        // means we never let _maxDstY decrease).
        {
            int newMaxDstY = (int)_maxDstY;
            if (homographyApplied) {
                cv::Mat nz;
                cv::findNonZero(warpedCanvasMask, nz);
                if (!nz.empty()) {
                    cv::Rect bb = cv::boundingRect(nz);
                    newMaxDstY = std::max(newMaxDstY, bb.y);
                } else {
                    newMaxDstY = std::max(newMaxDstY, dstY);
                }
            } else {
                newMaxDstY = std::max(newMaxDstY, dstY);
            }
            _maxDstY = newMaxDstY;
        }

        [tele setValue:@(_maxDstY + clipH) forKey:@"paintedExtent"];

        // ── V15: Paint warpedCanvas onto _canvas, mode per config ────
        // FirstPaintedWins (default for slitscan-rotate, V13.0e+ baseline):
        //   Paint only where canvas is currently UNPAINTED (mask==0).
        //   Already-painted pixels are protected.
        //
        // FeatherBlend (default for slitscan-both):
        //   Paint UNPAINTED canvas pixels straight (mask==0 → copy).
        //   Already-painted overlap pixels (mask==255) get an alpha
        //   blend with the new content, preserving the first slit's
        //   structural signal while smoothing slit boundaries.
        //   Hypothesis (Ram): with no accept gate (kMinAcceptDeltaPx
        //   = 0 in slitscan-both default), per-accept advance is small
        //   (~5–10 px) → per-accept misalignment is small → blending
        //   small misalignment over large overlap looks smooth, not
        //   ghosted (the V13.0d ghosting came from blending 50 px
        //   misalignment in a 50 px overlap zone — much larger error/
        //   overlap ratio).
        cv::Mat canvasMaskZero;
        cv::compare(_canvasMask, 0, canvasMaskZero, cv::CMP_EQ);

        cv::Mat paintMaskFresh;
        cv::bitwise_and(canvasMaskZero, warpedCanvasMask, paintMaskFresh);

        // Always paint unpainted canvas pixels straight from new slit.
        warpedCanvas.copyTo(_canvas, paintMaskFresh);
        cv::bitwise_or(_canvasMask, paintMaskFresh, _canvasMask);

        if (_config.paintMode == RLISPaintModeFeatherBlend) {
            // For overlap pixels (already painted AND warpedCanvasMask
            // has new content): alpha-blend at 0.3 weight on new
            // content (= 70% prev / 30% new).  Choice of 0.3 keeps
            // first-arrival's signal dominant while letting later
            // slits soften visible seams.  At dense per-accept advance
            // (gate=0), each canvas pixel sees ~30 successive blends;
            // first-arrival's effective weight is 0.7^N + decay terms,
            // which converges so the FIRST slit dominates ~50% of
            // final value — analogous in spirit to first-painted-wins
            // but smoother at boundaries.
            cv::Mat canvasMaskNonZero;
            cv::compare(_canvasMask, 0, canvasMaskNonZero, cv::CMP_NE);
            cv::Mat overlapMask;
            cv::bitwise_and(canvasMaskNonZero, warpedCanvasMask, overlapMask);
            if (cv::countNonZero(overlapMask) > 0) {
                cv::Mat blended;
                cv::addWeighted(warpedCanvas, 0.3, _canvas, 0.7, 0.0, blended);
                blended.copyTo(_canvas, overlapMask);
            }
        }

        _accepted += 1;

        // Update prev state for next-frame triangulation.  Move (not
        // copy) the keypoint vector — std::move on cv::Mat is also
        // cheap (header copy, refcount bump).
        _prevKeypoints = std::move(curKeypoints);
        _prevDescriptors = curDescriptors;
        _prevRotationArkit = R_new.clone();
        _prevTranslationArkit = (cv::Mat_<double>(3, 1) << tx, ty, tz);
        // V14.0a — store this accept's final canvas position for the
        // NEXT accept's homography target-pair construction.  Use the
        // post-clamp dstX/dstY because that's what got painted (or, for
        // the homography path, the pose+tri pre-warp position — the
        // homography itself encodes the warp, so prev_pts in frame
        // coords + this dst position correctly identifies where each
        // matched feature landed on canvas).
        _prevAcceptDstX = dstX;
        _prevAcceptDstY = dstY;

        if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
            // V14.0a — note that when homo=1 the actual painted footprint
            // is non-rectangular; dstX/dstY here describe the pose+tri
            // pre-warp position (used by the fallback path), not the
            // warp result's centroid.
            os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                "[V14.0a-paint] #%ld dstX=%d dstY=%d homo=%d _accepted=%ld",
                (long)_engineCallCounter, dstX, dstY,
                (int)homographyApplied, (long)_accepted);
        }
        [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        auto t1 = std::chrono::steady_clock::now();
        double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
        [tele setValue:@(ms) forKey:@"processingMs"];
        return tele;
    }

    // ── Subsequent frame: cylindrical-warp the FULL new frame, then
    //    paint into the canvas ONLY where the canvas mask is empty.
    //    "First-painted wins" — the original first frame stays
    //    untouched in its footprint, and new frames append content
    //    only into pixels that have never been painted before.  This
    //    is what gives the user the "first full frame, slits at the
    //    edges" behaviour.  No gaps because the cylindrical-warped
    //    new frame covers a wide angular extent (similar to the
    //    first frame's), so adjacent frames overlap heavily and
    //    every pixel between them gets covered.
    cv::Mat warpedNew, warpedNewMask;
    cv::Point newCornerCyl =
        [self cylindricalWarp:frameBGR rArkit:R_new
                        outImage:warpedNew outMask:warpedNewMask];
    if (warpedNew.empty()) {
        [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
        return tele;
    }

    cv::Point newCornerCanvas(newCornerCyl.x - _canvasOriginCylX,
                              newCornerCyl.y - _canvasOriginCylY);
    cv::Rect dstRoi(newCornerCanvas.x, newCornerCanvas.y,
                    warpedNew.cols, warpedNew.rows);
    cv::Rect canvasBounds(0, 0, _canvas.cols, _canvas.rows);
    cv::Rect dstClipped = dstRoi & canvasBounds;
    if (dstClipped.width <= 0 || dstClipped.height <= 0) {
        [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
        return tele;
    }
    cv::Rect srcRoi(dstClipped.x - dstRoi.x, dstClipped.y - dstRoi.y,
                    dstClipped.width, dstClipped.height);

    cv::Mat warpedNewClipped     = warpedNew(srcRoi);
    cv::Mat warpedNewMaskClipped = warpedNewMask(srcRoi);
    cv::Mat canvasRoi            = _canvas(dstClipped);
    cv::Mat canvasMaskRoi        = _canvasMask(dstClipped);

    // Paint into NEW pixels only.
    cv::Mat noPrior;
    cv::compare(canvasMaskRoi, 0, noPrior, cv::CMP_EQ);
    cv::Mat paintMask;
    cv::bitwise_and(noPrior, warpedNewMaskClipped, paintMask);
    if (cv::countNonZero(paintMask) > 0) {
        warpedNewClipped.copyTo(canvasRoi, paintMask);
        cv::bitwise_or(canvasMaskRoi, paintMask, canvasMaskRoi);
        _accepted += 1;
        [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        [tele setValue:@(1.0) forKey:@"confidence"];
    } else {
        // No new content to paint — the new frame's coverage is
        // entirely inside the existing canvas.  Skip silently.
        [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
    }

    auto t1 = std::chrono::steady_clock::now();
    double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
    [tele setValue:@(ms) forKey:@"processingMs"];
    return tele;
}

// Hand-rolled cylindrical projection.  Same algorithm as v9's helper
// in OpenCVIncrementalStitcher.mm — duplicated here to keep the two
// engines cleanly separated as separate files.  See that file for
// the full annotation; in short:
//   - panorama frame is gravity-up Y, first-camera-forward Z
//   - R_panToCam = M · R_arkit⁻¹ · R_panToWorld
//   - V12.2 cylindrical projection (theta = atan2(-wx, wz),
//     h = wy/sqrt(wx²+wz²)).  The −wx flip is the V12 mirror fix.
//     V12 had switched to spherical to handle extreme pitch; that
//     bulged level frames into a fisheye, so V12.2 reverts to
//     cylindrical and will solve pitch via an orientation-aware
//     cylinder axis (Step 3).
//   - inverse-map each canvas pixel back to a source pixel
//   - cv::remap fills the output bbox
//   - output mask has 255 only where the inverse map landed inside
//     the source frame
- (cv::Point)cylindricalWarp:(const cv::Mat &)src
                       rArkit:(const cv::Mat &)rArkit
                     outImage:(cv::Mat &)outImage
                      outMask:(cv::Mat &)outMask
{
    if (_R_panToWorld.empty() || _focalCompose <= 0) {
        outImage = cv::Mat(); outMask = cv::Mat();
        return cv::Point(0, 0);
    }
    cv::Mat R_panToCam = _M_arkitToCv * rArkit.t() * _R_panToWorld;
    const double fx = _K_compose.at<double>(0, 0);
    const double fy = _K_compose.at<double>(1, 1);
    const double cx = _K_compose.at<double>(0, 2);
    const double cy = _K_compose.at<double>(1, 2);
    const double f  = _focalCompose;

    cv::Mat R_camToPan = R_panToCam.t();
    // V12.3: orientation-aware cylinder axis — see v9 engine for the
    // full derivation.  Portrait → vertical-axis cylinder.  Landscape
    // → transverse (pan_X-axis) cylinder.
    auto projectCorner = ^cv::Point2d(double u, double v) {
        double rx = (u - cx) / fx;
        double ry = (v - cy) / fy;
        double rz = 1.0;
        double wx = R_camToPan.at<double>(0,0)*rx + R_camToPan.at<double>(0,1)*ry + R_camToPan.at<double>(0,2)*rz;
        double wy = R_camToPan.at<double>(1,0)*rx + R_camToPan.at<double>(1,1)*ry + R_camToPan.at<double>(1,2)*rz;
        double wz = R_camToPan.at<double>(2,0)*rx + R_camToPan.at<double>(2,1)*ry + R_camToPan.at<double>(2,2)*rz;
        if (_isLandscape) {
            double denom = std::sqrt(wy*wy + wz*wz);
            double s = (denom > 1e-9) ? (-wx / denom) : 0.0;
            double theta = std::atan2(wy, wz);
            return cv::Point2d(f * s, -f * theta);
        } else {
            // V12 mirror fix kept: −wx so user's-right maps to canvas-right.
            double theta = std::atan2(-wx, wz);
            double denom = std::sqrt(wx*wx + wz*wz);
            double h = (denom > 1e-9) ? (wy / denom) : 0.0;
            return cv::Point2d(f * theta, -f * h);  // Y-flip
        }
    };
    cv::Point2d c00 = projectCorner(0, 0);
    cv::Point2d c10 = projectCorner((double)src.cols - 1, 0);
    cv::Point2d c01 = projectCorner(0, (double)src.rows - 1);
    cv::Point2d c11 = projectCorner((double)src.cols - 1, (double)src.rows - 1);
    double minX = std::min({c00.x, c10.x, c01.x, c11.x});
    double maxX = std::max({c00.x, c10.x, c01.x, c11.x});
    double minY = std::min({c00.y, c10.y, c01.y, c11.y});
    double maxY = std::max({c00.y, c10.y, c01.y, c11.y});
    int bboxX = (int)std::floor(minX);
    int bboxY = (int)std::floor(minY);
    int bboxW = (int)std::ceil(maxX - minX) + 1;
    int bboxH = (int)std::ceil(maxY - minY) + 1;
    if (bboxW <= 0 || bboxH <= 0
        || bboxW > (int)_canvas.cols * 2 || bboxH > (int)_canvas.rows * 2) {
        outImage = cv::Mat(); outMask = cv::Mat();
        return cv::Point(0, 0);
    }
    // V12.4 slit-scan + long-side clip — see v9 engine for the
    // rationale.  Same fractions, same axis-aware logic.
    static const double kPanStripFraction  = 0.70;
    static const double kLongSideFraction  = 0.85;
    int preCropX = bboxX, preCropY = bboxY, preCropW = bboxW, preCropH = bboxH;
    {
        int newW, newH;
        if (_isLandscape) {
            newW = std::max(1, (int)(bboxW * kLongSideFraction));
            newH = std::max(1, (int)(bboxH * kPanStripFraction));
        } else {
            newW = std::max(1, (int)(bboxW * kPanStripFraction));
            newH = std::max(1, (int)(bboxH * kLongSideFraction));
        }
        bboxX += (bboxW - newW) / 2;
        bboxY += (bboxH - newH) / 2;
        bboxW = newW;
        bboxH = newH;
    }
    // V12.5 telemetry — same line shape as v9 engine, engine tag swapped.
    NSLog(@"[V12.5-warp] engine=firstwins accepted=%ld isLandscape=%d "
          @"corners=(%.1f,%.1f),(%.1f,%.1f),(%.1f,%.1f),(%.1f,%.1f) "
          @"preCrop=(x=%d,y=%d,w=%d,h=%d) "
          @"postCrop=(x=%d,y=%d,w=%d,h=%d) "
          @"R_panToCam=[[%.4f,%.4f,%.4f],[%.4f,%.4f,%.4f],[%.4f,%.4f,%.4f]] "
          @"focalCompose=%.2f",
          (long)_accepted, (int)_isLandscape,
          c00.x, c00.y, c10.x, c10.y, c01.x, c01.y, c11.x, c11.y,
          preCropX, preCropY, preCropW, preCropH,
          bboxX, bboxY, bboxW, bboxH,
          R_panToCam.at<double>(0,0), R_panToCam.at<double>(0,1), R_panToCam.at<double>(0,2),
          R_panToCam.at<double>(1,0), R_panToCam.at<double>(1,1), R_panToCam.at<double>(1,2),
          R_panToCam.at<double>(2,0), R_panToCam.at<double>(2,1), R_panToCam.at<double>(2,2),
          f);
    cv::Mat mapX(bboxH, bboxW, CV_32FC1);
    cv::Mat mapY(bboxH, bboxW, CV_32FC1);
    const double r00 = R_panToCam.at<double>(0,0), r01 = R_panToCam.at<double>(0,1), r02 = R_panToCam.at<double>(0,2);
    const double r10 = R_panToCam.at<double>(1,0), r11 = R_panToCam.at<double>(1,1), r12 = R_panToCam.at<double>(1,2);
    const double r20 = R_panToCam.at<double>(2,0), r21 = R_panToCam.at<double>(2,1), r22 = R_panToCam.at<double>(2,2);
    if (_isLandscape) {
        // Transverse cylinder (axis = pan_X) inverse map.
        for (int y = 0; y < bboxH; y++) {
            float *mx = mapX.ptr<float>(y);
            float *my = mapY.ptr<float>(y);
            double cylY = (double)(bboxY + y);
            double theta = -cylY / f;
            double sinTh = std::sin(theta);
            double cosTh = std::cos(theta);
            for (int x = 0; x < bboxW; x++) {
                double cylX = (double)(bboxX + x);
                double s = cylX / f;
                double wx = -s, wy = sinTh, wz = cosTh;
                double rx = r00*wx + r01*wy + r02*wz;
                double ry = r10*wx + r11*wy + r12*wz;
                double rz = r20*wx + r21*wy + r22*wz;
                if (rz <= 1e-6) { mx[x] = -1.0f; my[x] = -1.0f; }
                else {
                    double u = fx * rx / rz + cx;
                    double v = fy * ry / rz + cy;
                    if (u < 0 || u >= (double)src.cols || v < 0 || v >= (double)src.rows) {
                        mx[x] = -1.0f; my[x] = -1.0f;
                    } else { mx[x] = (float)u; my[x] = (float)v; }
                }
            }
        }
    } else {
        // Vertical cylinder (axis = pan_Y) inverse map.
        for (int y = 0; y < bboxH; y++) {
            float *mx = mapX.ptr<float>(y);
            float *my = mapY.ptr<float>(y);
            double cylY = (double)(bboxY + y);
            double h = -cylY / f;  // inverse Y-flip
            for (int x = 0; x < bboxW; x++) {
                double cylX = (double)(bboxX + x);
                double theta = cylX / f;
                double sinT = std::sin(theta);
                double cosT = std::cos(theta);
                // Inverse of V12 mirror fix: wx = −sinT.
                double wx = -sinT, wy = h, wz = cosT;
                double rx = r00*wx + r01*wy + r02*wz;
                double ry = r10*wx + r11*wy + r12*wz;
                double rz = r20*wx + r21*wy + r22*wz;
                if (rz <= 1e-6) { mx[x] = -1.0f; my[x] = -1.0f; }
                else {
                    double u = fx * rx / rz + cx;
                    double v = fy * ry / rz + cy;
                    if (u < 0 || u >= (double)src.cols || v < 0 || v >= (double)src.rows) {
                        mx[x] = -1.0f; my[x] = -1.0f;
                    } else { mx[x] = (float)u; my[x] = (float)v; }
                }
            }
        }
    }
    outImage.create(bboxH, bboxW, src.type());
    cv::remap(src, outImage, mapX, mapY,
              cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0));
    outMask.create(bboxH, bboxW, CV_8UC1);
    outMask.setTo(0);
    for (int y = 0; y < bboxH; y++) {
        const float *mx = mapX.ptr<float>(y);
        uchar *m = outMask.ptr<uchar>(y);
        for (int x = 0; x < bboxW; x++) if (mx[x] >= 0.0f) m[x] = 255;
    }
    return cv::Point(bboxX, bboxY);
}

- (BOOL)convertPixelBuffer:(CVPixelBufferRef)pixelBuffer to:(cv::Mat &)outBGR {
    CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    OSType pf = CVPixelBufferGetPixelFormatType(pixelBuffer);
    size_t w = CVPixelBufferGetWidth(pixelBuffer);
    size_t h = CVPixelBufferGetHeight(pixelBuffer);
    cv::Mat frame;
    BOOL ok = NO;
    if (pf == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        || pf == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
        size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0);
        size_t uvStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1);
        uint8_t *yBase = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0);
        uint8_t *uvBase = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1);
        cv::Mat nv12((int)(h + h / 2), (int)w, CV_8UC1);
        for (size_t y = 0; y < h; y++) {
            memcpy(nv12.ptr<uchar>((int)y),
                   yBase + y * yStride, w);
        }
        for (size_t y = 0; y < h / 2; y++) {
            memcpy(nv12.ptr<uchar>((int)(h + y)),
                   uvBase + y * uvStride, w);
        }
        cv::cvtColor(nv12, frame, cv::COLOR_YUV2BGR_NV12);
        ok = YES;
    } else if (pf == kCVPixelFormatType_32BGRA) {
        size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
        uint8_t *base = (uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);
        cv::Mat bgra((int)h, (int)w, CV_8UC4, base, stride);
        cv::cvtColor(bgra, frame, cv::COLOR_BGRA2BGR);
        ok = YES;
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    if (!ok) return NO;

    double scale = std::min(
        (double)_composeWidth  / (double)frame.cols,
        (double)_composeHeight / (double)frame.rows
    );
    if (scale > 1.0) scale = 1.0;
    int outW = std::max(1, (int)std::round(frame.cols * scale));
    int outH = std::max(1, (int)std::round(frame.rows * scale));
    if (frame.cols == outW && frame.rows == outH) {
        outBGR = frame;
    } else {
        cv::resize(frame, outBGR, cv::Size(outW, outH), 0, 0, cv::INTER_AREA);
    }
    return YES;
}

- (nullable RLISSnapshot *)snapshotWithJpegQuality:(NSInteger)quality
                                              error:(NSError **)error
{
    _snapshotSeq += 1;
    NSString *tmpDir = NSTemporaryDirectory();
    NSInteger slot = _snapshotSeq % 4;
    NSString *path = [tmpDir stringByAppendingPathComponent:
                       [NSString stringWithFormat:@"rlss-live-%ld.jpg", (long)slot]];
    return [self writeOutToPath:path quality:quality applyExposureComp:NO error:error];
}

- (nullable RLISSnapshot *)finalizeAtPath:(NSString *)outputPath
                              jpegQuality:(NSInteger)quality
                                    error:(NSError **)error
{
    RLISSnapshot *snap = [self writeOutToPath:outputPath
                                       quality:quality
                              applyExposureComp:YES
                                         error:error];
    [self reset];
    return snap;
}

- (nullable RLISSnapshot *)writeOutToPath:(NSString *)outputPath
                                   quality:(NSInteger)quality
                          applyExposureComp:(BOOL)applyExposureComp
                                     error:(NSError **)error
{
    if (_accepted == 0) {
        if (error) {
            *error = [NSError errorWithDomain:RetaiLensIncrementalStitcherErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey:
                                       @"No strips painted yet."}];
        }
        return nil;
    }

    cv::Rect bbox = cv::boundingRect(_canvasMask);
    if (bbox.width <= 0 || bbox.height <= 0) {
        bbox = cv::Rect(0, 0, _canvas.cols, _canvas.rows);
    }
    cv::Mat cropped = _canvas(bbox).clone();

    // V12.14.10 — orientation-aware output rotation.
    //
    // The engine's canvas is in sensor-Y-as-pan-axis orientation in
    // both supported modes (1920w × 5000h, dstY grows with pan).
    // For LANDSCAPE+vertical-pan that's the user-natural output:
    // 1920 wide × Y tall → wide horizontal strip when displayed in
    // the portrait-locked app UI (matches what the user saw in
    // their landscape view).
    //
    // For PORTRAIT+horizontal-pan the canvas is the same shape
    // (1920w × Yh) but the user EXPECTS a wide horizontal strip
    // showing their horizontal pan extent.  Rotate 90° CCW so
    // the saved JPEG is Y wide × 1920 tall — wide strip in
    // portrait UI.
    //
    // V13.0a — ROTATE_90_CLOCKWISE (was COUNTERCLOCKWISE in V12.14.10).
    // Ram's V12.14.10 device test showed the saved JPEG appearing
    // upside-down in the portrait UI; CCW was the wrong direction.
    // CW maps the canvas's pan-axis growth direction to the user-
    // perspective rightward direction, which matches the UI's
    // expected wide-horizontal-strip layout.
    cv::Mat out;
    if (_isLandscape) {
        out = cropped;
    } else {
        cv::rotate(cropped, out, cv::ROTATE_90_CLOCKWISE);
    }

    if (applyExposureComp && !out.empty()) {
        cv::Mat lab;
        cv::cvtColor(out, lab, cv::COLOR_BGR2Lab);
        std::vector<cv::Mat> ch(3);
        cv::split(lab, ch);
        cv::Ptr<cv::CLAHE> clahe = cv::createCLAHE(2.0, cv::Size(8, 8));
        clahe->apply(ch[0], ch[0]);
        cv::merge(ch, lab);
        cv::cvtColor(lab, out, cv::COLOR_Lab2BGR);
    }

    int q = (int)std::clamp((long long)quality, 0LL, 100LL);
    std::vector<int> params = {cv::IMWRITE_JPEG_QUALITY, q};
    NSString *cleanPath = [outputPath hasPrefix:@"file://"]
        ? [outputPath substringFromIndex:7] : outputPath;
    if (!cv::imwrite(std::string([cleanPath UTF8String]), out, params)) {
        if (error) {
            *error = [NSError errorWithDomain:RetaiLensIncrementalStitcherErrorDomain
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey:
                                       @"imwrite failed"}];
        }
        return nil;
    }

    RLISSnapshot *snap = [[RLISSnapshot alloc] init];
    [snap setValue:cleanPath forKey:@"panoramaPath"];
    [snap setValue:@(out.cols) forKey:@"width"];
    [snap setValue:@(out.rows) forKey:@"height"];
    [snap setValue:@(_accepted) forKey:@"acceptedCount"];
    return snap;
}

@end
