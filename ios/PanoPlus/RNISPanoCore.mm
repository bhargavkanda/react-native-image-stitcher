// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoCore.mm — session owner + pack writer for the pano+ engine.
//
// See RNISPanoCore.h for the API and the threading contract.  The three
// things this file exists to get right:
//
//  1. ARKit BUFFER LIFETIME.  `capturedImage` is valid only for the duration
//     of the plugin's `process(_:)`; ARKit recycles it the moment we return,
//     and a CF retain does NOT protect against pool reuse.  So the AR thread
//     memcpy's into a PRE-ALLOCATED ring slot (plane-aware, honouring
//     bytesPerRow) and enqueues.  Nothing downstream ever touches ARKit
//     memory.
//
//  2. THE AR THREAD IS SHARED.  Every registered plugin's `process(_:)` runs
//     serially on the ARKit delegate thread with no throttle and no
//     try/catch — blocking it stalls tracking AND every sibling plugin (DT
//     registers its own).  So this layer does a memcpy and an enqueue, and
//     NOTHING else.  A full ring DROPS and counts; it never waits.
//
//  3. AUTORELEASE / UAF DISCIPLINE.  Every primitive and std:: value read out
//     of a C++ result is captured ABOVE the @autoreleasepool that produced
//     it, so the NSDictionary / NSError built afterwards can never be
//     autoreleased-then-drained (the standing Obj-C++ bridge autorelease trap).

#import "RNISPanoCore.h"

#import <Foundation/Foundation.h>
#import <sys/utsname.h>
#import <os/lock.h>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "rnis_pano.hpp"

NSString *const RNISPanoPlusErrorDomain = @"RNISPanoPlusErrorDomain";

namespace {

// ── Small helpers ───────────────────────────────────────────────────────────

double numOr(NSDictionary<NSString *, id> *d, NSString *k, double fallback) {
    id v = d[k];
    return [v isKindOfClass:[NSNumber class]] ? ((NSNumber *)v).doubleValue : fallback;
}

bool boolOr(NSDictionary<NSString *, id> *d, NSString *k, bool fallback) {
    id v = d[k];
    return [v isKindOfClass:[NSNumber class]] ? ((NSNumber *)v).boolValue : fallback;
}

NSString *strOr(NSDictionary<NSString *, id> *d, NSString *k, NSString *fallback) {
    id v = d[k];
    return [v isKindOfClass:[NSString class]] ? (NSString *)v : fallback;
}

/// JSON-safe number: NaN / ±inf must never reach a JSON reader (the offline
/// replay twin parses these files), so an unmeasured value serialises as null.
/// 9 significant digits: canvas coordinates run to ~16 000 px and the residual
/// analysis reads sub-pixel frontier positions, so 6 digits would quantise
/// `highWater`/`posU` to 0.1 px on a long sweep.
void appendNum(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    s += buf;
}

/// Clock fields need EXACT round-trip: an epoch-ms or AR-ns value printed at
/// 6 significant digits loses seconds, and the offline replay twin aligns the
/// two clocks from these very fields.
void appendExact(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char buf[48];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    s += buf;
}

/// NaN / ±inf must never reach NSJSONSerialization (it throws) — an
/// unmeasured value crosses as null, mirroring the pod's existing D2 rule.
id jnum(double v) {
    return std::isfinite(v) ? (id)@(v) : (id)[NSNull null];
}

void appendInt(std::string& s, long long v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", v);
    s += buf;
}

double percentile(std::vector<double> v, double p) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const double idx = p * (double)(v.size() - 1);
    const size_t lo = (size_t)std::floor(idx), hi = (size_t)std::ceil(idx);
    if (lo == hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (idx - (double)lo);
}

NSDictionary *statsDict(const std::vector<double>& v) {
    if (v.empty()) return @{@"p50": @(0), @"p99": @(0), @"max": @(0), @"n": @(0)};
    double mx = 0;
    for (double d : v) mx = std::max(mx, d);
    return @{
        @"p50": @(percentile(v, 0.50)),
        @"p99": @(percentile(v, 0.99)),
        @"max": @(mx),
        @"n":   @((NSInteger)v.size()),
    };
}

NSString *deviceModel() {
    struct utsname sys;
    uname(&sys);
    return [NSString stringWithUTF8String:sys.machine];
}

// ── Frame ring ──────────────────────────────────────────────────────────────

enum class PixFmt { NV12, BGRA };

struct FrameSlot {
    std::vector<uint8_t> buf;
    PixFmt  fmt = PixFmt::NV12;
    int     w = 0, h = 0;        // the raster we actually copied
    int     declW = 0, declH = 0;// ARKit's declared imageResolution — the
                                 // raster the intrinsics are expressed against
    double  tsNs = 0;
    double  fx = 0, fy = 0, cx = 0, cy = 0;
    double  q[4] = {0, 0, 0, 1};
    double  t[3] = {0, 0, 0};
    int     tracking = 0;
    int64_t seq = 0;
    double  wallMs = 0;
    double  arThreadUs = 0;
    int64_t droppedBefore = 0;
    // v6 — the capture device's exposure for this frame.  0 ⇒ unavailable on
    // this path, which the engine treats as "needs no normalisation".
    double  expDurationS = 0.0;
    double  expISO = 0.0;
    // v11 — ARKit's OWN exposure for this frame, off the ARFrame rather than
    // off the AVCaptureDevice above.  `arExpHave` is carried separately
    // because `exposureOffset` is an EV OFFSET whose 0.0 is a legal reading,
    // so absence can never be inferred from the value.
    double  arExpDurationS = 0.0;
    double  arExpOffsetEV = 0.0;
    bool    arExpHave = false;
};

struct Ring {
    std::mutex mu;
    std::vector<std::unique_ptr<FrameSlot>> storage;
    std::vector<FrameSlot*> freeList;
    std::deque<FrameSlot*> ready;

    void reset(int capacity, size_t bytesPerSlot) {
        std::lock_guard<std::mutex> lk(mu);
        storage.clear(); freeList.clear(); ready.clear();
        storage.reserve(capacity);
        freeList.reserve(capacity);
        for (int i = 0; i < capacity; ++i) {
            storage.emplace_back(new FrameSlot());
            storage.back()->buf.resize(bytesPerSlot);
            freeList.push_back(storage.back().get());
        }
    }
    FrameSlot* acquire() {
        std::lock_guard<std::mutex> lk(mu);
        if (freeList.empty()) return nullptr;
        FrameSlot* s = freeList.back();
        freeList.pop_back();
        return s;
    }
    void publish(FrameSlot* s) {
        std::lock_guard<std::mutex> lk(mu);
        ready.push_back(s);
    }
    FrameSlot* take() {
        std::lock_guard<std::mutex> lk(mu);
        if (ready.empty()) return nullptr;
        FrameSlot* s = ready.front();
        ready.pop_front();
        return s;
    }
    void release(FrameSlot* s) {
        std::lock_guard<std::mutex> lk(mu);
        freeList.push_back(s);
    }
};

// ── Pack options ────────────────────────────────────────────────────────────

struct PackOptions {
    int packFramesMode = 0;      // 0 all, 1 painted-only, 2 none
    int frameEveryN = 1;
    int frameQuality = 70;
    int maxFrames = 1500;
    int canvasQuality = 92;
    /// 250 -> 120 ms.  MEASURED, on the operator's three 2026-08-29 packs
    /// replayed through the shipped layout
    /// (results/2026-08-30-panoplus-portrait/preview/): at 250 ms the panorama
    /// advanced 10-13 pt per tick (max 21) inside a 260-330 pt panel and the
    /// effective rate was 3.5-3.7 Hz, not 4 — the gate is
    /// `>= interval`, so a 60 fps frame clock quantises 250 ms up to 267.
    /// "The preview does not look good as I pan" is partly that ratchet.
    ///
    /// AFFORDABLE, and this is the part that is not a guess.  The resize runs
    /// on the INGEST queue behind a 6-slot ring, NOT on the AR thread, and all
    /// three packs report droppedQueue 0.  The pack's own previewMs is the
    /// cost: p99 7.6 / 8.9 / 14.3 ms against a 16.7 ms frame.  At 8 Hz that is
    /// 8 loaded frames per second out of 60, and the ring holds 100 ms of
    /// slack.  `previewMaxDutyPct` below is the belt for the braces.
    double previewIntervalMs = 120;
    /// THE SELF-THROTTLE.  `previewIntervalMs` is a FLOOR, not the schedule:
    /// after each render the next tick is held off until the preview has cost
    /// no more than this share of wall time, using an EWMA of its own measured
    /// render cost.  A thermally-throttled phone, a 2048-px canvas or a future
    /// box that makes the resize dearer therefore degrades the REFRESH RATE
    /// instead of the sweep, and the preview can never cost more of the ingest
    /// queue than it does today at 250 ms.  0 disables it.
    double previewMaxDutyPct = 8.0;
    /// THE FRONTIER WINDOW, in CANVAS px along the sweep.  0 = the whole
    /// panorama, which is what shipped and what the packs were captured with.
    ///
    /// Why it is not 0 any more: fitting the WHOLE band into a fixed panel
    /// shrinks the picture without bound.  Measured against the shipped
    /// `panoPlusPreviewLayout` on his 390x844 portrait-locked window, the
    /// inked panel area PEAKS at along ~2000 canvas px (84 765 pt²) and then
    /// collapses — 3.9 m of shelf is a 114x374 pt sliver at 7.1 source px per
    /// device px, 5.8 m is 76x374 pt at 10.7.  His three sweeps end at
    /// 1423-1711 px, one step short of the knee, which is why he reports "does
    /// not look good" rather than "is unusable".
    ///
    /// The value is HOST-COMPUTED and passed in, because the knee is a
    /// property of the PANEL (usable height ÷ max panel width in the
    /// operator's frame), and the engine has no business guessing a phone's
    /// chrome.  See `panoPlusPreviewWindowPx` in the SDK.  Below the knee the
    /// window is longer than the band and the path is byte-identical to 0.
    int previewWindowAlongPx = 0;
    /// THE WINDOW AS A MULTIPLE OF THE CANVAS'S CROSS EXTENT, which is the
    /// form the host can actually supply.  Engine options are sent at start()
    /// and the canvas is not sized until the axis latches, so an absolute px
    /// count cannot be computed by the host in time — but the RATIO can: the
    /// panel stops gaining on-screen size once along/cross exceeds
    /// (usable height ÷ max panel width) in the operator's frame, which is a
    /// property of the phone and is known before the first frame.  Measured on
    /// a 390x844 portrait-locked window: 1.445 in the landscape hold (panel),
    /// 1.558 in the portrait hold (band); the SDK passes the smaller so
    /// neither hold shrinks.  `previewWindowAlongPx` overrides it when set.
    /// 0 on both = the whole panorama, byte-identical to what shipped.
    double previewWindowCrossMult = 1.44;
    /// The live preview's JPEG quality.  60 -> 82.  Measured on pack 1's real
    /// canvas at true preview scale: q60 is 29.95 dB PSNR, q82 is ~32.9 dB,
    /// for +0.2 ms of encode ON THE PREVIEW QUEUE (never the ingest queue) and
    /// +57 kB per write.  The preview is rendered at ~1.03 JPEG px per device
    /// px — essentially 1:1 — so q60's blocking is not hidden by downscaling;
    /// it is being looked at directly.
    int previewQuality = 82;
    /// TRIM THE UNPAINTED CANVAS PAD off the live preview's cross axis.
    ///
    /// The canvas is one frame footprint plus TWO pads — 1920 x 0.5 + 2 x 128
    /// = 1216 rows on all three of the operator's packs — so 256 rows (21%)
    /// are pad nothing ever paints.  The preview took every one of them, which
    /// put black bars across a fifth of his panel AND, because the panel hugs
    /// the preview's aspect, drew the shelf 21% smaller than the phone was
    /// willing to draw it.  Found by rendering his own packs at true panel
    /// size; no number in any pack named it.
    ///
    /// It is the row UNION, so it can never cut a committed pixel — a
    /// different question from `cropVertical`, which cuts to the per-column
    /// intersection and is still finalize-only.  false restores the previous
    /// bytes exactly.
    bool previewCropPad = true;
    /// v12 — composite the PROVISIONAL lead-out (frontier → the live frame's
    /// leading edge) into the preview, dimmed.  Preview only; the canvas and
    /// every parity check are untouched.  See Engine::previewIntoFit.
    bool previewLeadOut = true;
    /// v12 — apply the preview's row-union pad trim to the FINAL canvas too,
    /// so canvas.jpg and the last preview agree on aspect instead of differing
    /// by the two unpainted 128 px pads.  Changes deliverable DIMS (not any
    /// committed pixel) — the engine version bump to 12 records it.
    bool canvasCropPad = true;
    /// THE LIVE PREVIEW'S FIT BOX, in SWEEP terms — `Along` caps the extent the
    /// sweep is growing along, `Cross` the perpendicular one.  It used to be
    /// `previewMaxW = 1400, previewMaxH = 220`, an ORIENTED box that assumed a
    /// wide horizontal panorama; the operator pans TOP TO BOTTOM in landscape,
    /// so all four of his packs are vertical sweeps (axis 1, 1344x1471 output)
    /// and that box collapsed the preview to 201x220 — a sixth of the size it
    /// should be, SHRINKING as the sweep grew.  See Engine::previewIntoFit.
    ///
    /// 800 x 2000 (was 360 x 1400, and 220 x 1400 in v6) BECAUSE THE BOX ON
    /// SCREEN GREW.  The JS side now sizes the panel in the OPERATOR'S frame
    /// rather than the portrait-locked framebuffer's, which puts a 259 x 283 pt
    /// panorama on his phone — 777 x 849 device px at @3x.  A 360-px source
    /// under that is a 2.2x upscale: a soft, obviously-degraded preview, and
    /// the operator cannot tell "my sweep is blurry" from "the preview is
    /// upscaled" by looking.  800 covers the cross axis exactly; 2000 covers a
    /// wide sweep's band (647 pt = 1941 px) before the along cap takes over.
    ///
    /// COST: the resize is INTER_AREA over the painted BAND, so it tracks the
    /// SOURCE (up to ~4 MP) and not this box, and the JPEG encode runs on the
    /// pack queue, not the engine queue.  meta.json's previewMs is the check —
    /// p50 5.9 / p99 8.05 / max 9.39 ms on the four packs at the OLD box.  A
    /// device pack that shows previewMs moving materially is the signal to
    /// bring these back down; nothing here is a guess that cannot be checked.
    int previewMaxAlong = 2000, previewMaxCross = 800;
    int queueMax = 8;
};

// ── Session state ───────────────────────────────────────────────────────────

struct SessionState {
    rnis::pano::Config cfg;
    PackOptions pack;
    /// THE ARM THIS SWEEP RUNS ON — 'ar' (ARKit) or 'imu' — as the live status
    /// reports it (`poseSourceRan`, the same key Android's recorder emits).
    /// Set once at start from the bridge's resolved `poseSource`: on iOS the
    /// arm is chosen before the sweep and never changes during it.
    NSString *poseSourceRan = @"ar";
    /// THE PHYSICAL HOLD, RECORDED — the one link in the portrait chain that
    /// was an INFERENCE rather than a measurement.
    ///
    /// `meta.json` carried `axis`, `sweepSign` and `axisOverride` but nothing
    /// about how the phone was held, so reading a pack back required deriving
    /// the hold from `referenceQuat` (world-up on ARKit camera +Y at 0.989 /
    /// 0.987 / 0.971 on the three 2026-08-29 packs ⇒ landscape-left).  That
    /// derivation is sound and it is still only a derivation: it pins the
    /// rotation chain the HUD arrow and the preview panel both walk, and the
    /// first portrait pack is exactly the case it has never been checked on.
    ///
    /// A passthrough string.  It reaches no config, no transform and no pixel
    /// — it is written to the pack and read by nothing else — so it cannot
    /// change what the engine does, only what a pack can answer afterwards.
    /// Empty when the host sent none, which is what every pack to date has.
    NSString *hold = @"";
    NSString *sessionDir = nil;
    NSString *framesDir = nil;
    NSString *previewPath = nil;

    dispatch_queue_t engineQ = nil;
    dispatch_queue_t packQ = nil;
    /// THE PREVIEW GETS ITS OWN QUEUE, and it is not a tidiness preference.
    ///
    /// The publish used to ride `packQ` — the SAME serial UTILITY queue that
    /// encodes and writes every 1920x1440 q70 frame JPEG (~420 KB measured).
    /// On the operator's third consecutive sweep that queue was 246 frames
    /// behind (`droppedPack` 10 -> 102 -> 246 while `framesWritten` FELL
    /// 428 -> 380 -> 234), so a preview enqueued there would land behind up to
    /// `queueMax` full-frame encodes.  The thing the operator judges this
    /// feature by — "is the panorama growing?" — would be seconds stale on
    /// exactly the sweeps where it matters most.
    ///
    /// USER_INITIATED, not UTILITY: this is on-screen feedback the operator is
    /// looking at, and it is ~10 ms of work every 250 ms.  It is deliberately
    /// NOT the engine queue: a JPEG encode there would push frames out of the
    /// ring, which is the cost the previous design was avoiding.
    dispatch_queue_t previewQ = nil;

    Ring ring;
    std::atomic<bool> capturing{false};
    std::atomic<int64_t> droppedQueue{0};
    std::atomic<int64_t> droppedPack{0};
    std::atomic<int64_t> packPending{0};
    std::atomic<int64_t> arSeq{0};
    std::atomic<int64_t> pendingDropReport{0};
    /// Set once finalize/cancel has torn the engine down.  A frame that got
    /// past `capturing` on the AR thread can still land on the engine queue
    /// AFTER the finalize barrier; this stops it mutating a finished session.
    std::atomic<bool> closed{false};

    // ENGINE-QUEUE ONLY below this line.
    rnis::pano::Engine engine;
    std::vector<double> engineMs;
    std::vector<double> arThreadUs;
    std::vector<double> previewMs;
    int64_t framesWritten = 0;
    int64_t engineFrames = 0;
    int64_t intrinsicsRescaled = 0;
    /// ⚠ THE DELIVERED FRAME SIZE — the raster the engine actually got.
    ///
    /// iOS `meta.json` carried no frame size at all, so "the output is small,
    /// what resolution are the frames?" had to be answered by inverting
    /// `canvasH = canvasScale * crossDim + 2 * canvasPadPx` off the finished
    /// canvas.  A pack that cannot state its own input is not a pack.
    ///
    /// This is the twin of Android's `PanoPlusLiveNative.deliveredW/H` and is
    /// latched at the same place in the chain: the one point every arm's
    /// frames funnel through on their way into `engine.ingest`.  It is the
    /// BUFFER's size, not the declared `imageWidth`/`imageHeight` — those two
    /// can disagree, which is what `intrinsicsRescaled` right above counts.
    ///
    /// No reset is needed as there is on Android: `S` is a fresh session per
    /// sweep, so a previous sweep's value cannot survive into this one.
    int     deliveredFrameW = 0;
    int     deliveredFrameH = 0;
    bool    frameCapHit = false;
    double  lastPreviewMs = 0;
    /// The DUTY-THROTTLED interval actually in force (>= pack.previewIntervalMs).
    /// Live on the status so a slow sweep can say it is refreshing slower,
    /// rather than the operator inferring it from a stuttering panel.
    double  previewIntervalEff = 0;
    /// EWMA of the measured render cost, ms.  Seeded on the first render.
    double  previewCostEwma = -1.0;
    int64_t previewSeq = 0;
    /// THE PUBLISHED PREVIEW'S PLACE IN THE PANORAMA — see
    /// rnis::pano::PreviewWindow.  `previewFrontierFrac` is what moves during
    /// the 2.4-2.9 s at the start of every one of his sweeps in which the
    /// painted band's extent does NOT (the bootstrap paints a whole 718 px
    /// footprint and the strip commit then starts half a footprint behind it).
    /// Written on the engine queue, read on the JS thread.
    std::atomic<int> previewViewPx{0};
    std::atomic<int> previewBandPx{0};
    std::atomic<int> previewViewStartPx{0};
    std::atomic<int> previewFrontierFracMilli{-1};
    std::atomic<bool> previewWindowed{false};
    /// v13 — how many canvas px of PROVISIONAL lead-out the last live preview
    /// carried (frontier -> the live frame's leading edge, i.e. exactly the
    /// span the tail flush will commit at stop).  Recorded because
    /// `leadOutEnabled` says the KNOB was on and this says the MECHANISM
    /// engaged — the operator asked, correctly, whether the preview really
    /// shows the region the output ends up containing.
    std::atomic<int> previewLeadOutPx{0};
    /// The canvas's cross extent and the rows the preview kept — the pad trim,
    /// measured rather than asserted.
    std::atomic<int> previewCanvasCrossPx{0};
    std::atomic<int> previewViewCrossPx{0};
    /// WHAT JS IS TOLD ABOUT THE PREVIEW, and it is deliberately NOT
    /// `previewSeq`.
    ///
    /// `previewSeq` counts previews the engine has RENDERED; the JPEG itself
    /// is written on the pack queue, behind up to `queueMax` frame writes.
    /// Publishing the rendered count would hand JS a cache-bust for a file
    /// that is not on disk yet — the first `<Image>` load of a sweep then
    /// fails, which is exactly the state the operator reported as "no live
    /// preview".  These three are written AFTER the atomic rename, so a
    /// non-zero `previewPublishedSeq` means the bytes ARE there.
    ///
    /// The dims travel with it because the host has to size its on-screen box
    /// from the panorama's own shape — a tall sweep needs a portrait panel,
    /// not a letterbox band — and the preview's pixel dims ARE that shape.
    /// Sticky: they describe the last published preview, on every frame.
    std::atomic<int64_t> previewPublishedSeq{0};
    std::atomic<int> previewPubW{0};
    std::atomic<int> previewPubH{0};
    /// THE THREE COUNTERS THAT WOULD HAVE ENDED THIS IN ONE PACK.
    ///
    /// `previewRendered` — previews the ENGINE produced.  `previewFailed` —
    /// publishes that could not write the file.  `previewSkipped` — publishes
    /// dropped because a newer one was already queued (see previewInFlight).
    /// Every one of them rides the LIVE status and meta.json.
    ///
    /// Before this existed the only observable was `previewSeq`, and a zero
    /// there is ambiguous three ways: nothing rendered, everything failed to
    /// write, or the status never arrived.  The engine rendered ~30 per sweep
    /// and every publish threw, and no pack could say so.  Rendered-vs-failed
    /// separates all three, and the HUD prints the difference.
    std::atomic<int64_t> previewRendered{0};
    std::atomic<int64_t> previewFailed{0};
    std::atomic<int64_t> previewSkipped{0};
    /// PUBLISHES THAT REACHED DISK — A COUNT, AND NOT `previewPublishedSeq`.
    ///
    /// The first cut of the pack reported `previewPublishedSeq` under the key
    /// `published`, which invited exactly the misreading a reviewer made out
    /// loud: "healthy is rendered == published".  That is FALSE whenever a
    /// tick coalesces.  `previewSeq` advances on every RENDER, so the last
    /// published seq trails the rendered count by however many ticks were
    /// skipped — on a perfectly healthy sweep.  A verdict keyed on that
    /// inequality would have cried wolf on every thermally-loaded sweep.
    ///
    /// With a real count the sweep obeys an exact identity, checked on the
    /// result screen once the queue is drained:
    ///
    ///     rendered == published + failed + skipped
    ///
    /// Every render ends in exactly one of the three.  A shortfall is a render
    /// that reached NONE of them — the silent class this whole change exists
    /// to end, and the only one no counter could previously name.
    std::atomic<int64_t> previewPublished{0};
    /// One publish in flight at a time.  A backlog of stale previews is worth
    /// nothing — the freshest is the only one the operator wants — so a tick
    /// that finds the queue busy is DROPPED and counted, never queued behind.
    std::atomic<bool> previewInFlight{false};
    /// The first publish failure's own words, verbatim from the publisher, so
    /// the pack carries the reason and not just a count.
    std::string previewFirstError;
    std::atomic<bool> previewErrorLogged{false};
    /// Frame JPEGs that were COUNTED in `framesWritten` (incremented on the
    /// engine queue) but did not reach disk.  Zero on all three of the
    /// operator's 2026-08-29 packs — this is instrumentation, not a known
    /// defect — but a silent one would make meta.json overstate the pack, and
    /// the pack is the only evidence channel we have.
    std::atomic<int64_t> frameWriteFailed{0};
    std::atomic<bool> frameErrorLogged{false};
    double  firstTsNs = 0, lastTsNs = 0;
    double  startWallMs = 0;

    // PACK-QUEUE ONLY.
    FILE *trackFp = nullptr;
    FILE *ledgerFp = nullptr;
    int64_t rowsSinceFlush = 0;
    /// Bytes of JPEG the pack has actually written.  `packFrames: 'all'` at
    /// 30 fps is hundreds of MB per sweep; the operator should be able to see
    /// that number rather than discover it when the device fills up.
    std::atomic<int64_t> packBytes{0};

    /// The capture-side AE/AWB/AF lock report (v6), as PanoPlusBridge got it
    /// back from RNISPanoCameraLock.  Written on the BRIDGE queue (once after
    /// start, once more at teardown when the sweep's own counters exist) and
    /// read at FINALIZE, on a different queue.
    ///
    /// GUARDED BY `statusLock`, and it must stay that way: an unsynchronised
    /// strong ARC store racing a load is an over-release, not a stale read.
    /// The window is real — start's `recordCameraLock` runs after a metering
    /// settle of up to 600 ms, and the native API is public, so nothing but
    /// the host's own single-flight kept a concurrent `finalizeSession` out of
    /// it.  Safety belongs here, not in JS.
    NSDictionary *cameraLock = nil;

    /// v11 — the AR-exposure probe's own report: HOW the ARSession was
    /// reached (or that it was not), and how many frames it sampled.  Same
    /// ownership rules as `cameraLock` above — written on the BRIDGE queue,
    /// read at FINALIZE on another, guarded by `statusLock`.
    ///
    /// Without it, `exposure.ar.frames == 0` is ambiguous between "this build
    /// cannot reach ARKit's camera", "the preview view was not mounted" and
    /// "the sweep ingested no frames".  A probe result that cannot say WHY it
    /// is empty is not evidence.
    NSDictionary *arExposureProbe = nil;

    /// The DECOUPLED arm's marker for `meta.json`.  nil on the ARKit arm, and
    /// the meta key is then ABSENT — that is the whole reason this is a
    /// separate field rather than an entry in the meta literal.  Same
    /// ownership rules as `cameraLock`: written on the bridge/teardown queue,
    /// read at FINALIZE on another, guarded by `statusLock`.
    NSDictionary *poseSource = nil;

    /// The SECOND ATTITUDE CHANNEL's account of itself, for `meta.json`.  nil
    /// unless the sweep armed `RNISPanoImuSidecar`, and the meta key is then
    /// ABSENT — the same emit-only-when-called contract as `poseSource`, and
    /// here it is what keeps an experiment from touching the shipped arm's
    /// pack.  Same ownership: written on the bridge/teardown queue, read at
    /// FINALIZE on another, guarded by `statusLock`.
    NSDictionary *imuSidecar = nil;

    // Status snapshot.  Also guards `cameraLock` — one uncontended lock for
    // both is cheaper than two, and neither is on a hot path.
    os_unfair_lock statusLock = OS_UNFAIR_LOCK_INIT;
    NSDictionary *status = nil;

    void setCameraLock(NSDictionary *d) {
        os_unfair_lock_lock(&statusLock);
        cameraLock = d;
        os_unfair_lock_unlock(&statusLock);
    }
    NSDictionary *getCameraLock() {
        os_unfair_lock_lock(&statusLock);
        NSDictionary *d = cameraLock;
        os_unfair_lock_unlock(&statusLock);
        return d;
    }

    void setPoseSource(NSDictionary *d) {
        os_unfair_lock_lock(&statusLock);
        poseSource = d;
        os_unfair_lock_unlock(&statusLock);
    }
    NSDictionary *getPoseSource() {
        os_unfair_lock_lock(&statusLock);
        NSDictionary *d = poseSource;
        os_unfair_lock_unlock(&statusLock);
        return d;
    }

    void setImuSidecar(NSDictionary *d) {
        os_unfair_lock_lock(&statusLock);
        imuSidecar = d;
        os_unfair_lock_unlock(&statusLock);
    }
    NSDictionary *getImuSidecar() {
        os_unfair_lock_lock(&statusLock);
        NSDictionary *d = imuSidecar;
        os_unfair_lock_unlock(&statusLock);
        return d;
    }

    void setArExposureProbe(NSDictionary *d) {
        os_unfair_lock_lock(&statusLock);
        arExposureProbe = d;
        os_unfair_lock_unlock(&statusLock);
    }
    NSDictionary *getArExposureProbe() {
        os_unfair_lock_lock(&statusLock);
        NSDictionary *d = arExposureProbe;
        os_unfair_lock_unlock(&statusLock);
        return d;
    }

    void setStatus(NSDictionary *d) {
        os_unfair_lock_lock(&statusLock);
        status = d;
        os_unfair_lock_unlock(&statusLock);
    }
    NSDictionary *getStatus() {
        os_unfair_lock_lock(&statusLock);
        NSDictionary *d = status;
        os_unfair_lock_unlock(&statusLock);
        return d;
    }
};

os_unfair_lock gSessionLock = OS_UNFAIR_LOCK_INIT;
std::shared_ptr<SessionState> gSession;

std::shared_ptr<SessionState> currentSession() {
    os_unfair_lock_lock(&gSessionLock);
    std::shared_ptr<SessionState> s = gSession;
    os_unfair_lock_unlock(&gSessionLock);
    return s;
}

/// Take EXCLUSIVE ownership of the running session: read and clear `gSession`
/// under ONE lock acquisition, so exactly one caller can ever win.
///
/// `finalize` and `cancel` are both dispatched onto a global CONCURRENT queue
/// by PanoPlusBridge, and nothing serialises them.  Read-then-clear in two
/// separate acquisitions let both obtain the same session, and then either
/// cancel's `engine.reset()` landed before finalize's `finish()` (a spurious
/// `panoplus-empty`) or cancel's `removeItemAtPath:` deleted the pack
/// finalize had just written — the one irreversible thing in this file.
/// `startWithOptions:` already claims under a single acquisition; these two
/// now release under one.
std::shared_ptr<SessionState> claimSession() {
    os_unfair_lock_lock(&gSessionLock);
    std::shared_ptr<SessionState> s = gSession;
    gSession = nullptr;
    os_unfair_lock_unlock(&gSessionLock);
    return s;
}

double nowMs() {
    return (double)(CFAbsoluteTimeGetCurrent() * 1000.0);
}

double wallEpochMs() {
    return [[NSDate date] timeIntervalSince1970] * 1000.0;
}

int trackingCode(NSString *s) {
    if ([s isEqualToString:@"normal"]) return 2;
    if ([s isEqualToString:@"limited"]) return 1;
    return 0;
}

}  // namespace

// ── Implementation ──────────────────────────────────────────────────────────

static void panoDrainOne(const std::shared_ptr<SessionState>& S);
static NSDictionary *panoConfigDict(const rnis::pano::Config& c,
                                    const PackOptions& p);

@implementation RNISPanoCore

+ (BOOL)startWithOptions:(NSDictionary<NSString *, id> *)options
                   error:(NSError **)error {
    auto reject = [&](NSInteger code, NSString *msg) {
        if (error) {
            *error = [NSError errorWithDomain:RNISPanoPlusErrorDomain
                                         code:code
                                     userInfo:@{NSLocalizedDescriptionKey: msg}];
        }
        return NO;
    };

    if (currentSession() != nullptr) {
        return reject(409, @"A pano+ sweep is already running.");
    }
    NSString *dir = strOr(options, @"sessionDir", nil);
    if (dir.length == 0) return reject(400, @"sessionDir is required.");

    auto S = std::make_shared<SessionState>();

    // ── Engine config — every knob 1:1 with rnis::pano::Config, so meta.json
    // round-trips and a pack is self-describing.
    rnis::pano::Config c;
    c.canvasScale          = numOr(options, @"canvasScale", c.canvasScale);
    c.stripMargin          = numOr(options, @"stripMargin", c.stripMargin);
    c.minAdvancePx         = numOr(options, @"minAdvancePx", c.minAdvancePx);
    c.maxAdvancePx         = numOr(options, @"maxAdvancePx", c.maxAdvancePx);
    c.maxAdvanceFrac       = numOr(options, @"maxAdvanceFrac", c.maxAdvanceFrac);
    c.maxSweepSpeedMps     = numOr(options, @"maxSweepSpeedMps", c.maxSweepSpeedMps);
    c.poseSlackM           = numOr(options, @"poseSlackM", c.poseSlackM);
    c.rectify              = boolOr(options, @"rectify", c.rectify);
    c.gainMatch            = boolOr(options, @"gainMatch", c.gainMatch);
    c.gainStepClamp        = numOr(options, @"gainStepClamp", c.gainStepClamp);
    c.gainCumClamp         = numOr(options, @"gainCumClamp", c.gainCumClamp);
    c.gainSampleMinPx      = numOr(options, @"gainSampleMinPx", c.gainSampleMinPx);
    c.workScale            = numOr(options, @"workScale", c.workScale);
    c.phaseWindowPx        = (int)numOr(options, @"phaseWindowPx", c.phaseWindowPx);
    c.corrCentroidBoxPx    = (int)numOr(options, @"corrCentroidBoxPx", c.corrCentroidBoxPx);
    c.minPhaseResponse     = numOr(options, @"minPhaseResponse", c.minPhaseResponse);
    c.stallResumeResponse  = numOr(options, @"stallResumeResponse", c.stallResumeResponse);
    c.maxRejectRunFrames   = (int)numOr(options, @"maxRejectRunFrames", c.maxRejectRunFrames);
    c.canvasInitWidthPx    = (int)numOr(options, @"canvasInitWidthPx", c.canvasInitWidthPx);
    c.canvasMaxWidthPx     = (int)numOr(options, @"canvasMaxWidthPx", c.canvasMaxWidthPx);
    c.canvasPadPx          = (int)numOr(options, @"canvasPadPx", c.canvasPadPx);
    c.canvasGrowVertical   = boolOr(options, @"canvasGrowVertical", c.canvasGrowVertical);
    c.canvasMaxHeightPx    = (int)numOr(options, @"canvasMaxHeightPx", c.canvasMaxHeightPx);
    c.canvasMaxPixels      = numOr(options, @"canvasMaxPixels", c.canvasMaxPixels);
    c.backfillGaps         = boolOr(options, @"backfillGaps", c.backfillGaps);
    c.abortOnLimitedTracking =
        boolOr(options, @"abortOnLimitedTracking", c.abortOnLimitedTracking);
    c.trackingWarmupFrames = (int)numOr(options, @"trackingWarmupFrames", c.trackingWarmupFrames);
    c.cageStallFrames      = (int)numOr(options, @"cageStallFrames", c.cageStallFrames);
    c.axisLatchFrames      = (int)numOr(options, @"axisLatchFrames", c.axisLatchFrames);
    c.axisLatchMaxFrames   = (int)numOr(options, @"axisLatchMaxFrames", c.axisLatchMaxFrames);
    c.latchTotalPx         = numOr(options, @"latchTotalPx", c.latchTotalPx);
    c.relatchMotionPx      = numOr(options, @"relatchMotionPx", c.relatchMotionPx);
    c.relatchCommitFrac    = numOr(options, @"relatchCommitFrac", c.relatchCommitFrac);
    c.relatchDominance     = numOr(options, @"relatchDominance", c.relatchDominance);
    c.relatchMinFrames     = (int)numOr(options, @"relatchMinFrames", c.relatchMinFrames);
    c.relatchMaxCount      = (int)numOr(options, @"relatchMaxCount", c.relatchMaxCount);
    c.maxTranslationJumpM  = numOr(options, @"maxTranslationJumpM", c.maxTranslationJumpM);
    c.rectifyYawLimitDeg   = numOr(options, @"rectifyYawLimitDeg", c.rectifyYawLimitDeg);
    c.axisOverride         = (int)numOr(options, @"axisOverride", c.axisOverride);
    c.signOverride         = (int)numOr(options, @"signOverride", c.signOverride);
    c.cropVertical         = boolOr(options, @"cropVertical", c.cropVertical);
    // ── v14: THE UPRIGHT BAKE ───────────────────────────────────────────
    // Host-supplied, and it HAS to be: a portrait-locked host (one whose
    // Info.plist lists `UIInterfaceOrientationPortrait` and nothing else)
    // makes UIKit report portrait in every hold, so asking it
    // here would hard-code the one answer that is wrong three times out of
    // four.  The SDK measures the hold from the accelerometer at Start and
    // sends `panoPlusUprightRotationDeg(orientation)`; see
    // `Config::outputRotationCwDeg` for the derivation and the four-hold
    // table.  DEFAULT 0 ⇒ an older host is byte-identical to v13.
    c.outputRotationCwDeg  = (int)numOr(options, @"outputRotationCwDeg",
                                        c.outputRotationCwDeg);
    // ── v5 ──────────────────────────────────────────────────────────────
    c.projection           = (int)numOr(options, @"projection", c.projection);
    c.sweepMaxDeg          = numOr(options, @"sweepMaxDeg", c.sweepMaxDeg);
    c.crossSweepFit        = boolOr(options, @"crossSweepFit", c.crossSweepFit);
    c.crossFitMode         = (int)numOr(options, @"crossFitMode", c.crossFitMode);
    c.crossWindows         = (int)numOr(options, @"crossWindows", c.crossWindows);
    c.crossAvgWindows      = boolOr(options, @"crossAvgWindows", c.crossAvgWindows);
    c.crossSpanFrac        = numOr(options, @"crossSpanFrac", c.crossSpanFrac);
    c.crossGradMaxPerFrame = numOr(options, @"crossGradMaxPerFrame", c.crossGradMaxPerFrame);
    c.crossScaleCageFrac   = numOr(options, @"crossScaleCageFrac", c.crossScaleCageFrac);
    // v9 (2026-09-16) — the image-fitted cross scale, made usable. Three knobs
    // that only mean anything together; see Config::crossScaleLeak.
    c.crossFitDcRemove     = (int)numOr(options, @"crossFitDcRemove", c.crossFitDcRemove);
    c.crossScaleLeak       = numOr(options, @"crossScaleLeak", c.crossScaleLeak);
    c.crossFitMinBandR2    = numOr(options, @"crossFitMinBandR2", c.crossFitMinBandR2);
    c.subjectDistanceM     = numOr(options, @"subjectDistanceM", c.subjectDistanceM);
    c.subjectDistanceAuto  = boolOr(options, @"subjectDistanceAuto", c.subjectDistanceAuto);
    c.seamMetrics          = boolOr(options, @"seamMetrics", c.seamMetrics);
    // v13 — the jog guard.  Engine default OFF; the instrumented internal
    // baseline sends true.  validateConfig refuses guard-without-
    // seamMetrics, so a host that disarms metrics cannot arm a blind guard.
    c.d8JogGuard           = boolOr(options, @"d8JogGuard", c.d8JogGuard);
    c.d8JogBarPx           = numOr(options, @"d8JogBarPx", c.d8JogBarPx);
    c.d8JogMaxRun          = (int)numOr(options, @"d8JogMaxRun", c.d8JogMaxRun);
    c.gainLeak             = numOr(options, @"gainLeak", c.gainLeak);
    // ── THE ELBOW FIX (2026-09-06) ──────────────────────────────────────
    // The bend is a HINGE where the flat seed/tail blocks meet the tilted
    // pose-chain strips. `crossTraj` lets those blocks continue the strips'
    // cross-axis tilt (0 off — as shipped; 1 chain; 2 overlap), and
    // `crossTrajRelaxPx` eases the tilt off after the join (0 = the block
    // keeps it to the far edge; 100 = the operator's RELAX flavour).
    // `leadOutFromFrontier` anchors the provisional lead-out on the commit
    // frontier, and `leadOutTraj` makes the preview's growing edge follow the
    // same trajectory — WYSIWYG at a per-tick cost; false is cheap placement.
    // `crossTraj`, `crossTrajRelaxPx` and `leadOutFromFrontier` default OFF
    // in the engine; `leadOutTraj` defaults TRUE there (rnis_pano.hpp) but is
    // only read while `crossTraj` != 0, so an older host that sends none of
    // the four is byte-identical.  The instrumented internal build sends the
    // RELAX arm — `crossTraj` 2, `crossTrajRelaxPx` 100,
    // `leadOutFromFrontier` true — and that default is OWNED by the host's
    // own capture-flag baseline (one trajectory flag, fanned onto these three
    // knobs; the alternative arm is one tap away in its UI).
    // `leadOutTraj` rides a host preview flag, FALSE on both baselines
    // since 2026-09-07 (the field test with it on showed the preview
    // resizing every tick) and inert while the trajectory is off.  Because
    // the Config default is true, the host's explicit false is what selects
    // the cheap placement — and this host always sends it (`boolOr` falls
    // back to the Config default only when the key is absent).
    c.crossTraj            = (int)numOr(options, @"crossTraj", c.crossTraj);
    c.crossTrajRelaxPx     = numOr(options, @"crossTrajRelaxPx", c.crossTrajRelaxPx);
    c.leadOutFromFrontier  = boolOr(options, @"leadOutFromFrontier", c.leadOutFromFrontier);
    c.leadOutTraj          = boolOr(options, @"leadOutTraj", c.leadOutTraj);
    // Config::seedLeadTrim — default ON; a host may still send false (the
    // control arm). The same top-level key reaches Android through
    // PanoPlusLiveModule's engineKnobKeys.
    c.seedLeadTrim         = boolOr(options, @"seedLeadTrim", c.seedLeadTrim);
    // ── THE LOW-LIGHT REGISTRATION GATE (Config::crossResidualGate) ─────
    // The mode and its six thresholds, read by the names the shared replay
    // knob table uses (rnis_pano_replay.cpp), so one options object arms the
    // same mode on both platforms — until this block existed the iOS arm
    // could not be armed at all, and a host's `crossResidualGate: 1` was
    // silently dropped here while Android ran it.  All seven default 0 in
    // the engine: OFF, no statistic computed and no ledger field written, so
    // a host that sends none of them is byte-identical.  1 is LOG-ONLY (the
    // statistics are ledgered, placement is untouched); 2 gates.  The two
    // integer knobs round the way the replay table does (std::lround), not
    // by truncation, so a fractional value arms the same mode on both arms.
    // `configure()` below refuses an inconsistent set (2 with every
    // threshold 0, a period guard without the gate) — the start rejects
    // rather than running a mode the host did not ask for.
    c.crossResidualGate    = (int)std::lround(
        numOr(options, @"crossResidualGate", (double)c.crossResidualGate));
    c.crossTextureMinVar   = numOr(options, @"crossTextureMinVar", c.crossTextureMinVar);
    c.crossPeakMinPSR      = numOr(options, @"crossPeakMinPSR", c.crossPeakMinPSR);
    c.crossPeakMinMass     = numOr(options, @"crossPeakMinMass", c.crossPeakMinMass);
    c.crossPeriodGuard     = (int)std::lround(
        numOr(options, @"crossPeriodGuard", (double)c.crossPeriodGuard));
    c.crossPeriodMaxFrac   = numOr(options, @"crossPeriodMaxFrac", c.crossPeriodMaxFrac);
    c.crossPeakSecondaryFrac = numOr(options, @"crossPeakSecondaryFrac",
                                     c.crossPeakSecondaryFrac);
    // ── v6 ──────────────────────────────────────────────────────────────
    c.exposureNormalize    = boolOr(options, @"exposureNormalize", c.exposureNormalize);
    c.exposureGainClamp    = numOr(options, @"exposureGainClamp", c.exposureGainClamp);
    c.photoMinSamples      = (int)numOr(options, @"photoMinSamples", c.photoMinSamples);
    c.photoGradMaxDN       = numOr(options, @"photoGradMaxDN", c.photoGradMaxDN);
    c.photoUniformMinFrac  = numOr(options, @"photoUniformMinFrac", c.photoUniformMinFrac);
    c.photoUniformBands    = (int)numOr(options, @"photoUniformBands", c.photoUniformBands);
    c.photoLocalWindowPx   = (int)numOr(options, @"photoLocalWindowPx", c.photoLocalWindowPx);
    // ── v10: LENS UNDISTORTION ──────────────────────────────────────────
    // The DEVICE IDENTITY is read HERE, never taken from the options dict: the
    // gate's entire job is to refuse coefficients that belong to another
    // camera, and a host that could claim a body it is not would defeat it.
    c.lensUndistort        = boolOr(options, @"lensUndistort", c.lensUndistort);
    c.lensDeviceModel      = std::string([deviceModel() UTF8String] ?: "");
    // ADVISORY, and labelled as such in the pack: `lensDeviceLens` is the
    // deviceType of the back wide-angle AVCaptureDevice the exposure lock
    // resolves — evidence about which device OBJECT exists, not a measurement
    // of which one ARKit is streaming.  The measurement that DECIDES is the
    // focal check, which reads ARKit's own per-frame intrinsics.  PanoPlusBridge
    // writes this key itself, over anything JS sent.
    c.lensDeviceLens       = std::string([strOr(options, @"lensDeviceLens", @"") UTF8String] ?: "");
    c.lensFocalTolFrac     = numOr(options, @"lensFocalTolFrac", c.lensFocalTolFrac);
    c.lensLutNodes         = (int)numOr(options, @"lensLutNodes", c.lensLutNodes);
    // ⚠ `lensModelOverride` / `lensK1` / `lensK2` ARE DELIBERATELY NOT READ
    // FROM THE OPTIONS DICT.  They are the one path that puts ARBITRARY radial
    // coefficients on ANY body, skipping the table — precisely the outcome the
    // gate exists to prevent ("applying them to a different device would ADD
    // geometric error rather than remove it").  Leaving them JS-reachable
    // would make the safety gate advisory.  They stay a C++ surface, used by
    // the host fixtures and the offline twin, which build Config directly.
    // The pack still LEDGERS them (`panoConfigDict`), so a reader can see they
    // were not used rather than having to assume it.

    std::string cfgErr;
    if (!S->engine.configure(c, &cfgErr)) {
        return reject(400, [NSString stringWithFormat:@"Invalid pano+ config: %s",
                                                      cfgErr.c_str()]);
    }
    S->cfg = c;
    {
        NSString *ps = strOr(options, @"poseSource", @"ar");
        S->poseSourceRan = [ps isEqualToString:@"imu"] ? @"imu" : @"ar";
    }

    // Recorded, never acted on.  See SessionState::hold.
    S->hold = strOr(options, @"hold", @"") ?: @"";

    NSString *mode = strOr(options, @"packFrames", @"all");
    S->pack.packFramesMode = [mode isEqualToString:@"none"] ? 2
                           : ([mode isEqualToString:@"painted"] ? 1 : 0);
    S->pack.frameEveryN       = std::max(1, (int)numOr(options, @"packFrameEveryN", 1));
    S->pack.frameQuality      = std::min(100, std::max(30, (int)numOr(options, @"packFrameQuality", 70)));
    S->pack.maxFrames         = std::max(0, (int)numOr(options, @"packMaxFrames", 1500));
    S->pack.canvasQuality     = std::min(100, std::max(50, (int)numOr(options, @"canvasQuality", 92)));
    S->pack.previewIntervalMs = std::max(50.0, numOr(options, @"previewIntervalMs", 120));
    S->pack.previewMaxDutyPct = std::max(0.0, numOr(options, @"previewMaxDutyPct", 8.0));
    // 0 = the whole panorama (the pre-2026-08-30 behaviour, byte for byte).
    S->pack.previewWindowAlongPx = std::max(0, (int)numOr(options,
                                                @"previewWindowAlongPx", 0));
    S->pack.previewWindowCrossMult = std::max(0.0, numOr(options,
                                                @"previewWindowCrossMult", 1.44));
    S->pack.previewQuality = (int)std::max(1.0, std::min(100.0,
                                 numOr(options, @"previewQuality", 82)));
    S->pack.previewCropPad = boolOr(options, @"previewCropPad", true);
    S->pack.previewLeadOut = boolOr(options, @"previewLeadOut", true);
    S->pack.canvasCropPad  = boolOr(options, @"canvasCropPad", true);
    S->previewIntervalEff = S->pack.previewIntervalMs;
    // The legacy `previewMaxW`/`previewMaxH` keys are still ACCEPTED, mapped
    // onto along/cross — which is what they always meant for the horizontal
    // sweep they were written for, and the honest reading of an old host's
    // intent.  A host that sends neither gets the defaults above.
    S->pack.previewMaxAlong   = std::max(64, (int)numOr(options, @"previewMaxAlong",
                                                        numOr(options, @"previewMaxW", 2000)));
    S->pack.previewMaxCross   = std::max(64, (int)numOr(options, @"previewMaxCross",
                                                        numOr(options, @"previewMaxH", 800)));
    S->pack.queueMax          = std::max(1, (int)numOr(options, @"packQueueMax", 8));

    // ── Session tree ───────────────────────────────────────────────────────
    NSFileManager *fm = [NSFileManager defaultManager];
    NSError *ioErr = nil;
    if (![fm createDirectoryAtPath:dir withIntermediateDirectories:YES
                        attributes:nil error:&ioErr]) {
        return reject(500, [NSString stringWithFormat:@"Could not create %@: %@",
                                                      dir, ioErr.localizedDescription]);
    }
    S->sessionDir = dir;
    S->framesDir = [dir stringByAppendingPathComponent:@"frames"];
    S->previewPath = [dir stringByAppendingPathComponent:@"preview.jpg"];
    if (S->pack.packFramesMode != 2) {
        [fm createDirectoryAtPath:S->framesDir withIntermediateDirectories:YES
                       attributes:nil error:nil];
    }

    S->trackFp = fopen([[dir stringByAppendingPathComponent:@"track.jsonl"] UTF8String], "wb");
    S->ledgerFp = fopen([[dir stringByAppendingPathComponent:@"ledger.jsonl"] UTF8String], "wb");
    if (S->trackFp == nullptr || S->ledgerFp == nullptr) {
        if (S->trackFp) fclose(S->trackFp);
        if (S->ledgerFp) fclose(S->ledgerFp);
        return reject(500, @"Could not open the pano+ pack writers.");
    }
    setvbuf(S->trackFp, nullptr, _IOFBF, 1 << 16);
    setvbuf(S->ledgerFp, nullptr, _IOFBF, 1 << 16);

    S->engineQ = dispatch_queue_create("io.imagestitcher.rn.panoplus.engine",
                                       dispatch_queue_attr_make_with_qos_class(
                                           DISPATCH_QUEUE_SERIAL,
                                           QOS_CLASS_USER_INITIATED, 0));
    S->packQ = dispatch_queue_create("io.imagestitcher.rn.panoplus.pack",
                                     dispatch_queue_attr_make_with_qos_class(
                                         DISPATCH_QUEUE_SERIAL,
                                         QOS_CLASS_UTILITY, 0));
    // See SessionState::previewQ: the live preview must not queue behind the
    // pack writer, which on the operator's third sweep was 246 frames behind.
    S->previewQ = dispatch_queue_create("io.imagestitcher.rn.panoplus.preview",
                                        dispatch_queue_attr_make_with_qos_class(
                                            DISPATCH_QUEUE_SERIAL,
                                            QOS_CLASS_USER_INITIATED, 0));

    // Ring slots are sized for the largest raster we might see (BGRA at the
    // AR format's own resolution).  Sized lazily on the first frame, because
    // the AR video format is not known until ARKit picks it.
    S->startWallMs = wallEpochMs();
    S->capturing.store(true);

    // Check-and-set under ONE lock acquisition: the early check above is a
    // cheap fast path, but two concurrent starts must not both win (they
    // would fight over the same session directory).
    bool claimed = false;
    os_unfair_lock_lock(&gSessionLock);
    if (gSession == nullptr) { gSession = S; claimed = true; }
    os_unfair_lock_unlock(&gSessionLock);
    if (!claimed) {
        S->capturing.store(false);
        if (S->trackFp) { fclose(S->trackFp); S->trackFp = nullptr; }
        if (S->ledgerFp) { fclose(S->ledgerFp); S->ledgerFp = nullptr; }
        return reject(409, @"A pano+ sweep is already running.");
    }

    NSLog(@"[RNIS pano+] session started dir=%@ rectify=%d gain=%d canvasScale=%.2f",
          dir, (int)c.rectify, (int)c.gainMatch, c.canvasScale);
    return YES;
}

+ (BOOL)isRunning {
    auto S = currentSession();
    return S != nullptr && S->capturing.load();
}

+ (nullable NSDictionary<NSString *, id> *)status {
    auto S = currentSession();
    return S ? S->getStatus() : nil;
}

// ── AR thread ───────────────────────────────────────────────────────────────

+ (void)ingestPixelBuffer:(CVPixelBufferRef)pixelBuffer
              timestampNs:(double)timestampNs
                       fx:(double)fx
                       fy:(double)fy
                       cx:(double)cx
                       cy:(double)cy
               imageWidth:(NSInteger)imageWidth
              imageHeight:(NSInteger)imageHeight
                 rotation:(NSArray<NSNumber *> *)rotation
              translation:(NSArray<NSNumber *> *)translation
                 tracking:(NSString *)tracking
        exposureDurationS:(double)exposureDurationS
              exposureISO:(double)exposureISO
      arExposureDurationS:(double)arExposureDurationS
       arExposureOffsetEV:(double)arExposureOffsetEV
           arExposureHave:(BOOL)arExposureHave {
    auto S = currentSession();
    if (S == nullptr || !S->capturing.load() || pixelBuffer == nullptr) return;

    const double t0 = nowMs();
    const OSType fmt = CVPixelBufferGetPixelFormatType(pixelBuffer);
    const bool isNV12 = (fmt == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ||
                         fmt == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
    const bool isBGRA = (fmt == kCVPixelFormatType_32BGRA);
    if (!isNV12 && !isBGRA) {
        // Unknown format: refuse LOUDLY-but-once rather than reading garbage.
        static std::atomic<bool> warned{false};
        if (!warned.exchange(true)) {
            NSLog(@"[RNIS pano+] unsupported pixel format %u — no frames will be ingested",
                  (unsigned)fmt);
        }
        S->droppedQueue.fetch_add(1);
        return;
    }

    const int w = (int)CVPixelBufferGetWidth(pixelBuffer);
    const int h = (int)CVPixelBufferGetHeight(pixelBuffer);
    if (w <= 0 || h <= 0 || (isNV12 && (h & 1))) {
        S->droppedQueue.fetch_add(1);
        return;
    }
    const size_t need = isNV12 ? (size_t)w * (size_t)h * 3 / 2
                               : (size_t)w * (size_t)h * 4;

    // Lazy, ONE-TIME ring allocation: the AR video format is not known until
    // the first frame arrives (RNSARSession picks it at run()).
    {
        std::lock_guard<std::mutex> lk(S->ring.mu);
        if (S->ring.storage.empty()) {
            // 6 slots (≈14 MB at 1440×1080 NV12).  Four was one preview tick
            // away from dropping: the preview's INTER_AREA resize runs on the
            // same ingest queue and can spike past a 33 ms frame budget on a
            // wide canvas.  meta.json's previewMs stats say whether that is
            // still true on the device.
            const int cap = 6;
            S->ring.storage.reserve(cap);
            S->ring.freeList.reserve(cap);
            for (int i = 0; i < cap; ++i) {
                S->ring.storage.emplace_back(new FrameSlot());
                S->ring.storage.back()->buf.resize(need);
                S->ring.freeList.push_back(S->ring.storage.back().get());
            }
        }
    }

    FrameSlot *slot = S->ring.acquire();
    if (slot == nullptr) {
        // Ring full — the engine queue is behind.  DROP and count: blocking
        // here would stall ARKit tracking and every sibling plugin.
        S->droppedQueue.fetch_add(1);
        S->pendingDropReport.fetch_add(1);
        return;
    }
    if (slot->buf.size() < need) slot->buf.resize(need);

    if (CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
        S->ring.release(slot);
        S->droppedQueue.fetch_add(1);
        return;
    }
    bool ok = true;
    if (isNV12) {
        const uint8_t *y = (const uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0);
        const uint8_t *uv = (const uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1);
        const size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0);
        const size_t uvStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1);
        if (y == nullptr || uv == nullptr) ok = false;
        else {
            uint8_t *dst = slot->buf.data();
            for (int r = 0; r < h; ++r) memcpy(dst + (size_t)r * w, y + (size_t)r * yStride, (size_t)w);
            uint8_t *dstUV = dst + (size_t)w * (size_t)h;
            const int uvRows = h / 2;
            for (int r = 0; r < uvRows; ++r)
                memcpy(dstUV + (size_t)r * w, uv + (size_t)r * uvStride, (size_t)w);
        }
    } else {
        const uint8_t *src = (const uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);
        const size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
        if (src == nullptr) ok = false;
        else {
            uint8_t *dst = slot->buf.data();
            for (int r = 0; r < h; ++r)
                memcpy(dst + (size_t)r * w * 4, src + (size_t)r * stride, (size_t)w * 4);
        }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    if (!ok) {
        S->ring.release(slot);
        S->droppedQueue.fetch_add(1);
        return;
    }

    slot->fmt = isNV12 ? PixFmt::NV12 : PixFmt::BGRA;
    slot->w = w; slot->h = h;
    slot->declW = (int)imageWidth; slot->declH = (int)imageHeight;
    slot->tsNs = timestampNs;
    slot->fx = fx; slot->fy = fy; slot->cx = cx; slot->cy = cy;
    for (int k = 0; k < 4; ++k)
        slot->q[k] = (rotation.count > (NSUInteger)k) ? rotation[k].doubleValue
                                                      : (k == 3 ? 1.0 : 0.0);
    for (int k = 0; k < 3; ++k)
        slot->t[k] = (translation.count > (NSUInteger)k) ? translation[k].doubleValue : 0.0;
    slot->tracking = trackingCode(tracking);
    // v6 — the frame's own exposure, straight through to rnis::pano::FrameInput.
    // Sanitised here rather than in the engine so a NaN from a device read can
    // never reach the LUT: anything non-finite or non-positive becomes 0,
    // which every consumer treats as "no metadata".
    slot->expDurationS = (std::isfinite(exposureDurationS) && exposureDurationS > 0.0)
                             ? exposureDurationS : 0.0;
    slot->expISO = (std::isfinite(exposureISO) && exposureISO > 0.0)
                       ? exposureISO : 0.0;
    // v11 — ARKit's own numbers, sanitised on the SAME rule.  A frame whose
    // duration is unreadable is not a frame with a zero exposure: `arExpHave`
    // goes false and the engine counts it in neither trace.  The EV offset is
    // allowed to be negative and to be exactly 0.
    slot->arExpHave = (arExposureHave &&
                       std::isfinite(arExposureDurationS) &&
                       arExposureDurationS > 0.0 &&
                       std::isfinite(arExposureOffsetEV));
    slot->arExpDurationS = slot->arExpHave ? arExposureDurationS : 0.0;
    slot->arExpOffsetEV  = slot->arExpHave ? arExposureOffsetEV : 0.0;
    slot->seq = S->arSeq.fetch_add(1);
    slot->wallMs = wallEpochMs();
    slot->droppedBefore = S->pendingDropReport.exchange(0);
    slot->arThreadUs = (nowMs() - t0) * 1000.0;

    S->ring.publish(slot);
    std::weak_ptr<SessionState> weak = S;
    dispatch_async(S->engineQ, ^{
        auto strong = weak.lock();
        if (strong) panoDrainOne(strong);
    });
}

// ── Engine queue ────────────────────────────────────────────────────────────

namespace {
/// Releases a ring slot EXACTLY once, however the drain leaves — including
/// down an exception path.  A leaked slot permanently shrinks the ring, so
/// after four leaks the AR thread drops every frame for the rest of the sweep
/// with nothing but `droppedQueue` to show for it.
struct SlotGuard {
    SessionState *s = nullptr;
    FrameSlot *slot = nullptr;
    ~SlotGuard() { reset(); }
    void reset() {
        if (slot != nullptr && s != nullptr) { s->ring.release(slot); }
        slot = nullptr;
    }
};
}  // namespace

static void panoDrainOneBody(const std::shared_ptr<SessionState>& S,
                             FrameSlot *slot, SlotGuard& guard);

static void panoDrainOne(const std::shared_ptr<SessionState>& S) {
    if (S->closed.load()) return;
    FrameSlot *slot = S->ring.take();
    if (slot == nullptr) return;
    SlotGuard guard{S.get(), slot};
    // An escaping C++ exception on a dispatch block is std::terminate.  The
    // engine, the preview resize and the ledger string building are all
    // allocating work on this queue; a cv::Exception or bad_alloc there must
    // end the FRAME, not the app — and must not leak the ring slot either.
    try {
        panoDrainOneBody(S, slot, guard);
    } catch (const cv::Exception& e) {
        NSLog(@"[RNIS pano+] frame dropped (cv): %s", e.what());
    } catch (const std::exception& e) {
        NSLog(@"[RNIS pano+] frame dropped: %s", e.what());
    } catch (...) {
        NSLog(@"[RNIS pano+] frame dropped (unknown native failure)");
    }
}

static void panoDrainOneBody(const std::shared_ptr<SessionState>& S,
                             FrameSlot *slot, SlotGuard& guard) {
    // Primitives read out of the C++ result live ABOVE the pool that builds
    // any ObjC object from them (the documented UAF discipline).
    rnis::pano::FrameOutcome row;
    cv::Mat bgrForPack;
    cv::Mat previewMat;
    rnis::pano::PreviewWindow previewWin;
    bool wantPreview = false;
    int previewW = 0, previewH = 0;

    @autoreleasepool {
        cv::Mat bgr, grayWork;
        try {
            if (slot->fmt == PixFmt::NV12) {
                cv::Mat nv12(slot->h + slot->h / 2, slot->w, CV_8UC1, slot->buf.data());
                cv::cvtColor(nv12, bgr, cv::COLOR_YUV2BGR_NV12);
                // The Y plane IS luma — no conversion needed for registration.
                cv::Mat y(slot->h, slot->w, CV_8UC1, slot->buf.data());
                cv::resize(y, grayWork, cv::Size(), S->cfg.workScale, S->cfg.workScale,
                           cv::INTER_AREA);
            } else {
                cv::Mat bgra(slot->h, slot->w, CV_8UC4, slot->buf.data());
                cv::cvtColor(bgra, bgr, cv::COLOR_BGRA2BGR);
                cv::Mat g;
                cv::cvtColor(bgra, g, cv::COLOR_BGRA2GRAY);
                cv::resize(g, grayWork, cv::Size(), S->cfg.workScale, S->cfg.workScale,
                           cv::INTER_AREA);
            }
        } catch (const cv::Exception& e) {
            NSLog(@"[RNIS pano+] frame conversion failed: %s", e.what());
            guard.reset();
            return;
        }

        rnis::pano::FrameInput in;
        in.bgr = &bgr;
        in.grayWork = &grayWork;
        in.tsNs = slot->tsNs;
        // INTRINSICS ↔ RASTER.  ARKit expresses `camera.intrinsics` against
        // `camera.imageResolution`, which the plugin forwards as
        // imageWidth/imageHeight — while the pixels we actually copied are
        // sized by the CVPixelBuffer.  They agree today, but nothing checked
        // it, and a divergence would silently mis-scale EVERY H_rect with no
        // ledger signal.  Rescale to the raster we hold and count it.
        double kfx = slot->fx, kfy = slot->fy, kcx = slot->cx, kcy = slot->cy;
        if (slot->declW > 0 && slot->declH > 0 &&
            (slot->declW != slot->w || slot->declH != slot->h)) {
            const double sx = (double)slot->w / (double)slot->declW;
            const double sy = (double)slot->h / (double)slot->declH;
            kfx *= sx; kcx *= sx; kfy *= sy; kcy *= sy;
            ++S->intrinsicsRescaled;
            static std::atomic<bool> warnedScale{false};
            if (!warnedScale.exchange(true)) {
                NSLog(@"[RNIS pano+] intrinsics declared against %dx%d but the "
                      @"buffer is %dx%d — rescaling (recorded in meta.json)",
                      slot->declW, slot->declH, slot->w, slot->h);
            }
        }
        in.fx = kfx; in.fy = kfy; in.cx = kcx; in.cy = kcy;
        in.imageWidth = slot->w; in.imageHeight = slot->h;
        // See the field's note: the raster the engine got, for the pack.
        S->deliveredFrameW = slot->w;
        S->deliveredFrameH = slot->h;
        for (int k = 0; k < 4; ++k) in.q[k] = slot->q[k];
        for (int k = 0; k < 3; ++k) in.t[k] = slot->t[k];
        in.tracking = slot->tracking;
        in.seq = slot->seq;
        in.exposureDurationS = slot->expDurationS;
        in.exposureISO = slot->expISO;
        in.arExposureDurationS = slot->arExpDurationS;
        in.arExposureOffsetEV  = slot->arExpOffsetEV;
        in.arExposureValid     = slot->arExpHave;

        row = S->engine.ingest(in);
        bgrForPack = bgr;   // shallow; the engine may hold its own reference

        const double nm = nowMs();
        if (nm - S->lastPreviewMs >= S->previewIntervalEff) {
            // MEASURED, not assumed: this INTER_AREA resize of the painted
            // band runs on the INGEST queue, and at max canvas width it is the
            // one piece of per-tick work that can plausibly push a frame out
            // of the ring.  meta.json carries p50/p99/max so the first packs
            // answer that with data instead of a guess.
            const double pv0 = nowMs();
            // The window in CANVAS px.  An explicit px count wins; otherwise
            // the host's ratio is applied to the cross the publish will
            // ACTUALLY carry (`previewCrossPx(cropPad)` — a bare accessor,
            // because `stats()` allocates seven strings and this runs on the
            // ingest queue).  Before the latch there is no canvas and no
            // window.
            //
            // NOT `canvasHeightPx()`, which was used here until 2026-09-04:
            // that is the PADDED height, but `previewCropPad` (default true,
            // :810) trims the pad rows out of what is published, so the window
            // engaged ~27% too late and the panorama drew thin with black bars
            // down both edges before snapping to full thickness.  The
            // multiplier is the on-screen capsule's own ratio, so the two ends
            // have to mean the same cross.
            int windowPx = S->pack.previewWindowAlongPx;
            if (windowPx <= 0 && S->pack.previewWindowCrossMult > 0.0) {
                const int ch = S->engine.previewCrossPx(S->pack.previewCropPad);
                if (ch > 0) {
                    windowPx = (int)std::lround(
                        S->pack.previewWindowCrossMult * (double)ch);
                }
            }
            wantPreview = S->engine.previewIntoFit(previewMat,
                                                   S->pack.previewMaxAlong,
                                                   S->pack.previewMaxCross,
                                                   windowPx,
                                                   &previewWin,
                                                   S->pack.previewCropPad,
                                                   S->pack.previewLeadOut);
            const double pvMs = nowMs() - pv0;
            // v12 — the interval clock advances on REFUSED attempts too.
            // Before this, a pre-latch refusal (nothing painted yet) never
            // advanced `lastPreviewMs`, so the probe re-ran on EVERY frame at
            // 60 Hz and pushed a ~0 ms sample each time — previewMs reported
            // n=106-126 with only 39-60 real renders and a p50 of 0.00,
            // corrupting the pack's own lag evidence.  Timing samples are now
            // renders only.
            S->lastPreviewMs = nm;
            if (wantPreview) {
                S->previewMs.push_back(pvMs);
                previewW = previewMat.cols;
                previewH = previewMat.rows;
                ++S->previewSeq;
                // RENDERED, counted here and separately from PUBLISHED below.
                // The two diverging is the entire signature of the 2026-08-29
                // defect and it was not observable from any pack.
                S->previewRendered.fetch_add(1);

                // ── WHERE THIS PREVIEW SITS IN THE PANORAMA ─────────────────
                // Published even when the window is off, because the FRONTIER
                // is the thing that moves through the 2.4-2.9 s at the start
                // of every sweep in which the band's extent does not.
                S->previewViewPx.store(previewWin.viewEndU - previewWin.viewStartU);
                S->previewBandPx.store(previewWin.bandEndU - previewWin.bandStartU);
                S->previewViewStartPx.store(previewWin.viewStartU
                                            - previewWin.bandStartU);
                S->previewWindowed.store(previewWin.windowed);
                S->previewLeadOutPx.store(previewWin.leadOutPx);
                S->previewCanvasCrossPx.store(previewWin.canvasCrossPx);
                S->previewViewCrossPx.store(previewWin.viewCrossPx);
                S->previewFrontierFracMilli.store(
                    previewWin.frontierFrac < 0.0
                        ? -1
                        : (int)std::lround(previewWin.frontierFrac * 1000.0));

                // ── THE SELF-THROTTLE ───────────────────────────────────────
                // `previewIntervalMs` is a floor.  The preview may cost at most
                // `previewMaxDutyPct` of wall time on this queue, judged by its
                // OWN measured cost, so a dearer render slows the REFRESH and
                // never the sweep.  Without this, dropping the interval from
                // 250 to 120 ms would be a promise about a phone we have not
                // measured; with it, the worst case is the rate we already ship.
                if (S->pack.previewMaxDutyPct > 0.0) {
                    S->previewCostEwma = (S->previewCostEwma < 0.0)
                        ? pvMs
                        : (0.8 * S->previewCostEwma + 0.2 * pvMs);
                    const double dutyFloor =
                        S->previewCostEwma * 100.0 / S->pack.previewMaxDutyPct;
                    S->previewIntervalEff = std::min(1000.0,
                        std::max(S->pack.previewIntervalMs, dutyFloor));
                } else {
                    S->previewIntervalEff = S->pack.previewIntervalMs;
                }
            }
        }
    }

    ++S->engineFrames;
    S->engineMs.push_back(row.engineMs);
    S->arThreadUs.push_back(slot->arThreadUs);
    if (S->firstTsNs == 0) S->firstTsNs = slot->tsNs;
    S->lastTsNs = slot->tsNs;

    const auto st = S->engine.stats();
    const bool painted = (row.outcome == rnis::pano::Outcome::Painted ||
                          row.outcome == rnis::pano::Outcome::GapExtended ||
                          row.outcome == rnis::pano::Outcome::GapBreak ||
                          row.outcome == rnis::pano::Outcome::Bootstrap);

    // ── Pack rows (built here, written on the pack queue) ───────────────────
    std::string trackLine, ledgerLine;
    {
        trackLine = "{\"seq\":"; appendInt(trackLine, slot->seq);
        // CLOCK LABELLING IS EXPLICIT: tsNs is the ARKit MONOTONIC media
        // clock; tsWallMs is Unix epoch ms.  The two clocks are mixed across
        // the stitcher's API, and an unlabelled pack would silently mis-align
        // the replay twin.
        trackLine += ",\"tsNs\":"; appendExact(trackLine, slot->tsNs);
        trackLine += ",\"tsWallMs\":"; appendExact(trackLine, slot->wallMs);
        trackLine += ",\"q\":["; appendNum(trackLine, slot->q[0]);
        for (int k = 1; k < 4; ++k) { trackLine += ","; appendNum(trackLine, slot->q[k]); }
        trackLine += "],\"t\":["; appendNum(trackLine, slot->t[0]);
        for (int k = 1; k < 3; ++k) { trackLine += ","; appendNum(trackLine, slot->t[k]); }
        trackLine += "],\"fx\":"; appendNum(trackLine, slot->fx);
        trackLine += ",\"fy\":"; appendNum(trackLine, slot->fy);
        trackLine += ",\"cx\":"; appendNum(trackLine, slot->cx);
        trackLine += ",\"cy\":"; appendNum(trackLine, slot->cy);
        trackLine += ",\"w\":"; appendInt(trackLine, slot->w);
        trackLine += ",\"h\":"; appendInt(trackLine, slot->h);
        trackLine += ",\"tracking\":"; appendInt(trackLine, slot->tracking);
        // v6 — THE FRAME'S OWN EXPOSURE.  Written into the TRACK file (not
        // only the ledger) because the track file is what the offline replay
        // twin feeds back into the engine: without these two numbers the twin
        // cannot reproduce the radiometric normalisation, and a replay that
        // silently skips it would report the fix working when it had not run.
        // 0 ⇒ the metadata was unavailable on this path, which every pack
        // written before v6 records by not having the fields at all.
        trackLine += ",\"expDurS\":"; appendNum(trackLine, slot->expDurationS);
        trackLine += ",\"expISO\":"; appendNum(trackLine, slot->expISO);
        // v11 — ARKit's own exposure for this frame, BESIDE the device's, so
        // the offline twin can compare them row by row instead of trusting
        // the session aggregate.  `arExpHave` is written explicitly: a row
        // with 0/0 and arExpHave=false is "unreadable", not "dark".
        trackLine += ",\"arExpDurS\":"; appendNum(trackLine, slot->arExpDurationS);
        trackLine += ",\"arExpOffsetEV\":"; appendNum(trackLine, slot->arExpOffsetEV);
        trackLine += ",\"arExpHave\":";
        trackLine += (slot->arExpHave ? "true" : "false");
        trackLine += ",\"arThreadUs\":"; appendNum(trackLine, slot->arThreadUs);
        trackLine += ",\"droppedBefore\":"; appendInt(trackLine, slot->droppedBefore);
        trackLine += "}\n";

        ledgerLine = "{\"seq\":"; appendInt(ledgerLine, row.seq);
        ledgerLine += ",\"tsNs\":"; appendExact(ledgerLine, row.tsNs);
        ledgerLine += ",\"outcome\":\"";
        ledgerLine += rnis::pano::outcomeName(row.outcome);
        // THE THREE ADVANCE CHANNELS.  advanceX/Y is the post-rectification
        // RESIDUAL (≈0 on a pivot, by design); advanceRotX/Y is the
        // attitude-derived step; advanceTotX/Y is their sum — the frame's real
        // canvas-position step.  The first device pack carried only the
        // residual, which is why "was that a pivot or a walk?" needed a
        // forensic offline pass to answer.
        ledgerLine += "\",\"advanceX\":"; appendNum(ledgerLine, row.advanceX);
        ledgerLine += ",\"advanceY\":"; appendNum(ledgerLine, row.advanceY);
        ledgerLine += ",\"advanceRotX\":"; appendNum(ledgerLine, row.advanceRotX);
        ledgerLine += ",\"advanceRotY\":"; appendNum(ledgerLine, row.advanceRotY);
        ledgerLine += ",\"advanceTotX\":"; appendNum(ledgerLine, row.advanceTotX);
        ledgerLine += ",\"advanceTotY\":"; appendNum(ledgerLine, row.advanceTotY);
        // FILTER ON THIS BEFORE SUMMING ANY ADVANCE COLUMN.  The per-frame
        // steps are measured from the last ACCEPTED frame, so a rejected row
        // and the accepted row after it cover OVERLAPPING intervals and a
        // naive Σ over every row double-counts.  Σ over chainAdvanced rows is
        // the session's own travel.
        ledgerLine += ",\"chainAdvanced\":";
        ledgerLine += (row.chainAdvanced ? "true" : "false");
        // The row at which the axis/sign latch corrected itself and the canvas
        // was restarted.  Everything painted before it was discarded.
        if (row.relatched) ledgerLine += ",\"relatched\":true";
        ledgerLine += ",\"response\":"; appendNum(ledgerLine, row.response);
        ledgerLine += ",\"posU\":"; appendNum(ledgerLine, row.posU);
        ledgerLine += ",\"posV\":"; appendNum(ledgerLine, row.posV);
        ledgerLine += ",\"stripW\":"; appendNum(ledgerLine, row.stripW);
        ledgerLine += ",\"canvasX0\":"; appendNum(ledgerLine, row.canvasX0);
        ledgerLine += ",\"canvasX1\":"; appendNum(ledgerLine, row.canvasX1);
        ledgerLine += ",\"gainStep\":"; appendNum(ledgerLine, row.gainStep);
        ledgerLine += ",\"gainCum\":"; appendNum(ledgerLine, row.gainCum);
        ledgerLine += ",\"highWater\":"; appendNum(ledgerLine, row.highWater);
        ledgerLine += ",\"gapPx\":"; appendNum(ledgerLine, row.gapPx);
        // THE SEED JUNCTION, only on the row it actually happened.
        // Conditional for the same reason `relatched` is: a device pack that
        // never armed `seedFrontierMeet` (the shipped default, and every pack
        // captured to date) must hash byte-for-byte to what it hashed before
        // the knob existed.
        if (row.seedMet) {
            ledgerLine += ",\"seedMet\":true";
            ledgerLine += ",\"seedMeetPx\":"; appendNum(ledgerLine, row.seedMeetPx);
        }
        ledgerLine += ",\"backfillPx\":"; appendNum(ledgerLine, row.backfillPx);
        ledgerLine += ",\"rectifyDeg\":"; appendNum(ledgerLine, row.rectifyDeg);
        ledgerLine += ",\"clipTopPx\":"; appendNum(ledgerLine, row.clipTopPx);
        ledgerLine += ",\"clipBotPx\":"; appendNum(ledgerLine, row.clipBotPx);
        ledgerLine += ",\"clipped\":"; ledgerLine += row.clipped ? "true" : "false";
        // The canvas frame this row's posU/posV were measured in.  A top
        // growth shifts every earlier pixel down, so without this the replay
        // twin would compare positions across two different origins.
        ledgerLine += ",\"vShiftPx\":"; appendNum(ledgerLine, row.vShiftPx);
        // ── v5: PROJECTION SPLIT + THE CUT METRIC ───────────────────────
        // psiDeg is the ALONG-SWEEP attitude this frame carries (0 in the
        // planar arm and on a pure walk); crossRectifyDeg is what is left for
        // the homography and is the quantity rectifyYawLimitDeg now gates.
        ledgerLine += ",\"psiDeg\":"; appendNum(ledgerLine, row.psiDeg);
        ledgerLine += ",\"crossRectifyDeg\":"; appendNum(ledgerLine, row.crossRectifyDeg);
        ledgerLine += ",\"areaScale\":"; appendNum(ledgerLine, row.areaScale);
        ledgerLine += ",\"crossGrad\":"; appendNum(ledgerLine, row.crossGrad);
        ledgerLine += ",\"crossScale\":"; appendNum(ledgerLine, row.crossScale);
        if (row.crossScaleCaged) ledgerLine += ",\"crossScaleCaged\":true";
        // THE CUT.  Per-band disagreement between what the K correlation
        // windows measured and what the placement applied, in the frame's own
        // rectified coordinates — so the canvas vertical-growth re-base (the
        // benign ~128 px posV steps) cannot contaminate it.
        ledgerLine += ",\"seamWorstBandPx\":"; appendNum(ledgerLine, row.seamWorstBandPx);
        ledgerLine += ",\"seamBandSpreadPx\":"; appendNum(ledgerLine, row.seamBandSpreadPx);
        ledgerLine += ",\"seamLumaStepDN\":"; appendNum(ledgerLine, row.seamLumaStepDN);
        ledgerLine += ",\"seamBands\":"; appendInt(ledgerLine, row.seamBands);
        // THE COMMITTED-PIXEL CUT.  The band numbers above score the placement
        // the engine DECIDED; this one correlates the slab of canvas the
        // incoming warp covered and the high-water clip discarded, so it
        // scores the pixels it PAINTED.  `false` means the overlap was too
        // small or the correlation too weak — never "zero".
        ledgerLine += ",\"seamCanvasJogPx\":"; appendNum(ledgerLine, row.seamCanvasJogPx);
        // v8 — THE SAME MEASUREMENT WITH ITS SIGN.  The absolute value above
        // says how badly two strips disagree; only the sign says whether the
        // panorama is walking, and it used to be taken with fabs() at the
        // point of measurement and was therefore not in the pack at all.
        ledgerLine += ",\"seamCanvasJogSignedPx\":";
        appendNum(ledgerLine, row.seamCanvasJogSignedPx);
        ledgerLine += ",\"seamCanvasJogValid\":";
        ledgerLine += row.seamCanvasJogValid ? "true" : "false";
        // v8 — how far crossAvgWindows moved this frame's cross advance.
        // Identically 0.0 on every row when the flag is off, which is how a
        // pack states which chain produced it.
        ledgerLine += ",\"crossAvgDeltaPx\":"; appendNum(ledgerLine, row.crossAvgDeltaPx);
        // The low-light registration gate's block — ONLY when the engine
        // computed it (Config::crossResidualGate ≥ 1 and the frame reached
        // the centre correlation).  Same guard, same keys and same order as
        // the shared writer (`replay::appendLedgerLine`), so with the knob at
        // 0 every row is byte-identical to the row before this block existed,
        // and an iOS pack that ran the log-only arm diffs against the replay
        // twin key for key.  A non-finite statistic lands as null.
        if (row.crossStatsComputed) {
            ledgerLine += ",\"crossGated\":"; appendInt(ledgerLine, row.crossGated);
            ledgerLine += ",\"crossTextureVar\":"; appendNum(ledgerLine, row.crossTextureVar);
            ledgerLine += ",\"crossPeakPSR\":"; appendNum(ledgerLine, row.crossPeakPSR);
            ledgerLine += ",\"crossPeakMass\":"; appendNum(ledgerLine, row.crossPeakMass);
            ledgerLine += ",\"crossDominantPeriodPx\":";
            appendNum(ledgerLine, row.crossDominantPeriodPx);
            ledgerLine += ",\"crossPeakSecondary\":"; appendNum(ledgerLine, row.crossPeakSecondary);
            ledgerLine += ",\"crossResidualRawPx\":"; appendNum(ledgerLine, row.crossResidualRawPx);
        }
        // ── v6: PHOTOMETRY ──────────────────────────────────────────────
        // expGain is the EXACT radiometric factor applied from the camera's
        // own exposure; photoScale is what the committed pixels actually
        // carry (expGain × gainCum), and its LOCAL excursions are the bands
        // the operator circled — so it is ledgered per row rather than
        // reconstructed from two other columns afterwards.
        ledgerLine += ",\"expGain\":"; appendNum(ledgerLine, row.expGain);
        ledgerLine += ",\"photoScale\":"; appendNum(ledgerLine, row.photoScale);
        // The photometric seam over the WHOLE shared footprint, SIGNED, plus
        // the uniformity that decides whether it is a photometric step at all
        // (a ragged difference is a geometry disagreement and belongs to the
        // jog).  `false` means NOT MEASURED — never "no step".
        ledgerLine += ",\"seamPhotoStepDN\":"; appendNum(ledgerLine, row.seamPhotoStepDN);
        ledgerLine += ",\"seamPhotoUniform\":"; appendNum(ledgerLine, row.seamPhotoUniform);
        ledgerLine += ",\"seamPhotoSpreadDN\":"; appendNum(ledgerLine, row.seamPhotoSpreadDN);
        ledgerLine += ",\"seamPhotoBands\":"; appendNum(ledgerLine, (double)row.seamPhotoBands);
        ledgerLine += ",\"seamPhotoValid\":";
        ledgerLine += row.seamPhotoValid ? "true" : "false";
        ledgerLine += ",\"engineMs\":"; appendNum(ledgerLine, row.engineMs);
        ledgerLine += ",\"stalled\":"; ledgerLine += row.stalled ? "true" : "false";
        ledgerLine += "}\n";
    }

    const bool wantFrame =
        S->pack.packFramesMode == 0 ||
        (S->pack.packFramesMode == 1 && painted);
    const bool cadenceOk = (slot->seq % S->pack.frameEveryN) == 0;
    const bool capOk = S->framesWritten < S->pack.maxFrames;
    if (wantFrame && !capOk && !S->frameCapHit) {
        S->frameCapHit = true;
        NSLog(@"[RNIS pano+] pack frame cap %d reached — further frames are not "
              @"written (recorded in meta.json)", S->pack.maxFrames);
    }
    bool writeFrame = wantFrame && cadenceOk && capOk;
    if (writeFrame) {
        if (S->packPending.load() >= S->pack.queueMax) {
            S->droppedPack.fetch_add(1);
            writeFrame = false;
        } else {
            ++S->framesWritten;
            S->packPending.fetch_add(1);
        }
    }

    // ── Status snapshot for the SYNC channel ───────────────────────────────
    NSString *speed = @"ok";
    const double mag = std::sqrt(row.advanceX * row.advanceX +
                                 row.advanceY * row.advanceY);
    if (row.outcome == rnis::pano::Outcome::SkippedNoAdvance || mag < S->cfg.minAdvancePx)
        speed = @"no-motion";
    else if (st.maxAdvancePxResolved > 0 && mag > 0.6 * st.maxAdvancePxResolved)
        speed = @"fast";

    NSString *abortStr = st.abortReason.empty()
        ? nil : [NSString stringWithUTF8String:st.abortReason.c_str()];
    NSDictionary *status = @{
        @"running":             @(S->capturing.load()),
        @"sessionDir":          S->sessionDir ?: @"",
        @"seq":                 @((NSInteger)row.seq),
        @"framesSeen":          @((NSInteger)st.seen),
        @"painted":             @((NSInteger)st.painted),
        @"heldBacktrack":       @((NSInteger)st.heldBacktrack),
        @"heldFrontier":        @((NSInteger)st.heldFrontier),
        @"skippedNoAdvance":    @((NSInteger)st.skippedNoAdvance),
        @"rejectedLowResponse": @((NSInteger)st.rejectedLowResponse),
        @"rejectedOutOfCage":   @((NSInteger)st.rejectedOutOfCage),
        @"rejectedPoseSpeed":   @((NSInteger)st.rejectedPoseSpeed),
        @"rejectedTracking":    @((NSInteger)st.rejectedTracking),
        @"rejectedRectify":     @((NSInteger)st.rejectedRectify),
        @"gapExtended":         @((NSInteger)st.gapExtended),
        @"gapBreak":            @((NSInteger)st.gapBreak),
        @"gapBackfilled":       @((NSInteger)st.gapBackfilled),
        @"limitedFrames":       @((NSInteger)st.limitedFrames),
        // PERPENDICULAR TRUNCATION, live.  The G1 hole gate only looks along
        // the sweep, so without this the operator can watch a clean-looking
        // HUD while the panorama loses shelf height.
        @"clippedFrames":       @((NSInteger)st.clippedFrames),
        @"clippedColumns":      @((NSInteger)st.clippedColumns),
        @"canvasHeightPx":      @((NSInteger)st.canvasH),
        @"paintedWidthPx":      @((NSInteger)st.paintedW),
        @"canvasWidthPx":       @((NSInteger)st.canvasW),
        @"advancePx":           jnum(mag),
        @"stripPx":             jnum(row.stripW),
        @"outcome":             [NSString stringWithUTF8String:rnis::pano::outcomeName(row.outcome)],
        @"speed":               speed,
        @"tracking":            @((NSInteger)slot->tracking),
        @"poseSourceRan":       S->poseSourceRan,
        @"stalled":             @(st.stalled),
        @"axisLatched":         @(st.axisLatched),
        @"axis":                @((NSInteger)st.axis),
        @"sweepSign":           @((NSInteger)st.sweepSign),
        @"maxRectifyDeg":       jnum(st.maxRectifyDeg),
        // ── v5, LIVE.  The operator watched a v4 sweep report CLEAN while he
        // could see cuts in it; these three are what let the HUD go red DURING
        // the sweep instead of in the pack afterwards.
        @"maxAreaScale":        jnum(st.maxAreaScalePainted),
        @"seamWorstBandP95Px":  jnum(st.seamWorstBandP95Px),
        @"seamWorstBandMaxPx":  jnum(st.seamWorstBandMaxPx),
        @"crossBandDivergencePx": jnum(st.crossBandDivergencePx),
        @"crossBandDivergenceNormPx": jnum(st.crossBandDivergenceNormPx),
        @"seamCanvasJogP95Px":  jnum(st.seamCanvasJogP95Px),
        @"seamCanvasJogMaxPx":  jnum(st.seamCanvasJogMaxPx),
        // ── v6, LIVE.  The BANDING the operator rejected twice.  A
        // per-boundary DC step is invisible on its own; the band number is
        // the one his eye integrates, so it goes on the HUD next to the cut
        // numbers rather than only into the pack.
        @"seamPhotoStepP95DN":  jnum(st.seamPhotoStepP95DN),
        @"seamPhotoStepMaxDN":  jnum(st.seamPhotoStepMaxDN),
        // v8, LIVE — the SUPPORT behind the max.  "BAND" on the HUD with one
        // breaching boundary out of four hundred and "BAND" with two hundred
        // are different sweeps, and the operator was being shown the same word
        // for both.
        @"seamPhotoStepOverBar": @((NSInteger)st.seamPhotoStepOverBar),
        @"seamPhotoSamples":    @((NSInteger)st.seamPhotoSamples),
        @"photoLocalP2PPct":    jnum(st.photoLocalP2PPct),
        @"photoScaleRangePct":  jnum(st.photoScaleRangePct),
        // COMMITTED PIXELS — the band clause that survives a pack with no
        // exposure metadata.  This is the number that goes red on the HUD.
        @"photoDriftLocalPct":  jnum(st.seamPhotoDriftLocalPct),
        @"photoDriftTotalPct":  jnum(st.seamPhotoDriftTotalPct),
        // 1.00 with exposureMetaFrames > 0 is the live proof the AE lock is
        // holding.  1.00 with exposureMetaFrames == 0 is UNKNOWN.
        @"exposureRangeRatio":  jnum(st.exposureRangeRatio),
        @"exposureMetaFrames":  @((NSInteger)st.exposureMetaFrames),
        // v8, LIVE — see meta.seam.bandSelfScored.  On the HUD this is what
        // stops "seam 0.25" reading as a cleaner sweep than "seam 0.38" when
        // the only thing that changed is which measurements the chain fitted.
        @"seamBandSelfScored":  @(st.seamBandSelfScored),
        @"seamMeasured":        @(st.seamMeasured),
        @"integrityFailed":     @(st.integrityFailed),
        @"projection":          @((NSInteger)st.projection),
        @"maxCrossRectifyDeg":  jnum(st.maxCrossRectifyDeg),
        // ── THE TWIN'S OTHER HALF ────────────────────────────────────
        // The drift verdict and the provenance split are computed in the
        // SHARED engine, so they exist on this arm already — they were just
        // never surfaced here. `rnis_pano_live.cpp` is the Android twin of
        // this dictionary, and a field added there and not here is silently
        // iOS-invisible: the value is right, the pack simply never says it.
        // That is how the drift detector shipped on 2026-09-22 and reached
        // zero iPhone packs.
        @"driftLevel":          @((NSInteger)st.driftLevel),
        @"driftArm":            (st.driftArm.empty()
                                    ? @"" : @(st.driftArm.c_str())),
        @"driftFiredAtRow":     @((NSInteger)st.driftFiredAtRow),
        @"driftPeakLeanDeg":    jnum(st.driftPeakLeanDeg),
        @"driftPeakSlideFrac":  jnum(st.driftPeakSlideFrac),
        // Where the delivered panorama came from, along the sweep axis.
        // `alongAxisIsOutputY` says WHICH output axis these measure — the
        // fact whose absence made a vertical sweep get split by columns.
        @"provenanceSeedPx":    @((NSInteger)st.provenanceSeedPx),
        @"provenanceStripPx":   @((NSInteger)st.provenanceStripPx),
        @"provenanceTailPx":    @((NSInteger)st.provenanceTailPx),
        @"alongAxisIsOutputY":  @(st.alongAxisIsOutputY),
        // Live regime read-out: 1 = a pivot, 0 = a walk.  Until the axis
        // latches this is the only signal that says WHY nothing is painting.
        @"rotationFraction":    jnum(st.rotationFraction),
        // How many times the axis/sign latch has CORRECTED itself.  Live,
        // because a correction discards the canvas: an operator watching the
        // preview shrink back to one frame deserves to know it was deliberate.
        @"relatchCount":        @((NSInteger)st.relatchCount),
        @"advanceRotPx":        jnum(std::sqrt(row.advanceRotX * row.advanceRotX +
                                               row.advanceRotY * row.advanceRotY)),
        @"previewPath":         S->previewPath ?: @"",
        // The PUBLISHED seq (see previewPublishedSeq): a cache-bust for bytes
        // that are actually on disk, never for a render still in the queue.
        @"previewSeq":          @((NSInteger)S->previewPublishedSeq.load()),
        // The published preview's own pixel dims, so the host sizes its
        // on-screen box from the panorama's shape instead of assuming one.
        @"previewW":            @((NSInteger)S->previewPubW.load()),
        @"previewH":            @((NSInteger)S->previewPubH.load()),
        // RENDERED vs FAILED vs SKIPPED, LIVE.  `previewSeq` alone is
        // ambiguous three ways when it is zero — nothing rendered, everything
        // failed to write, or no status arrived — and all three were on the
        // table for eleven days.  These make the HUD able to say WHICH.
        @"previewRenders":      @((NSInteger)S->previewRendered.load()),
        @"previewFails":        @((NSInteger)S->previewFailed.load()),
        @"previewSkips":        @((NSInteger)S->previewSkipped.load()),
        // ── WHERE THE PREVIEW SITS IN THE PANORAMA ──────────────────────────
        // `previewFrontierFrac` is 0..1 along the PUBLISHED image's own long
        // axis, already sign-corrected by the engine (see
        // rnis::pano::PreviewWindow), or -1 when there is nothing to place.
        // It exists because of a measured fact and not a hunch: on all three
        // 2026-08-29 packs the painted band's extent did not move for the
        // first 2.4-2.9 s of the sweep (40% / 30% / 33%) while the operator
        // was already panning, and the commit frontier moved the whole time.
        @"previewFrontierFrac": jnum(S->previewFrontierFracMilli.load() < 0
                                        ? -1.0
                                        : S->previewFrontierFracMilli.load() / 1000.0),
        // The slice the preview carries vs the whole painted band, canvas px
        // along the sweep, and where the slice starts inside the band.  Equal
        // (and viewStart 0) whenever the window is off or has not engaged.
        @"previewViewPx":       @((NSInteger)S->previewViewPx.load()),
        @"previewBandPx":       @((NSInteger)S->previewBandPx.load()),
        @"previewViewStartPx":  @((NSInteger)S->previewViewStartPx.load()),
        @"previewWindowed":     @(S->previewWindowed.load()),
        // The DUTY-THROTTLED interval actually in force.  A panel refreshing
        // at 5 Hz because the render got dear is a different fact from one
        // refreshing at 5 Hz because it was configured that way.
        @"previewIntervalMs":   jnum(S->previewIntervalEff),
        @"droppedQueue":        @((NSInteger)S->droppedQueue.load()),
        @"droppedPack":         @((NSInteger)S->droppedPack.load()),
        @"engineMs":            jnum(row.engineMs),
        @"abort":               abortStr ?: (id)[NSNull null],
    };
    S->setStatus(status);

    // The slot's pixels are no longer needed — everything downstream works
    // off the freshly allocated cv::Mats.  Nothing may touch `slot` after
    // this: the AR thread can reuse it on the very next frame.
    const int64_t seqForPack = slot->seq;
    guard.reset();

    NSString *framePath = writeFrame
        ? [S->framesDir stringByAppendingPathComponent:
              [NSString stringWithFormat:@"frame_%06lld.jpg", (long long)seqForPack]]
        : nil;
    if (framePath == nil) {
        // Not packing this frame — drop our reference now rather than keeping
        // a multi-megabyte BGR alive until the pack block runs.
        bgrForPack.release();
    }
    const int frameQ = S->pack.frameQuality;
    // Captured by value here, on the engine queue, so the publish block never
    // reaches through `keep` for a field the engine queue also writes.
    // NOT named previewQ: that is the dispatch queue, three lines below.
    const int previewJpegQuality = S->pack.previewQuality;
    std::shared_ptr<SessionState> keep = S;

    // ── PUBLISH THE LIVE PREVIEW ────────────────────────────────────────────
    // On its OWN queue (see SessionState::previewQ) and enqueued BEFORE the
    // pack block, so the thing the operator is watching never waits on the
    // frame writer — which on his third sweep was 246 frames behind.
    //
    // COALESCED, not queued: if a publish is still in flight this tick is
    // dropped and counted.  A backlog of stale panoramas is worth nothing;
    // only the newest one is.
    if (wantPreview && !previewMat.empty()) {
        NSString *previewPath = S->previewPath;
        const int64_t previewSeqForWrite = S->previewSeq;
        bool expected = false;
        if (!S->previewInFlight.compare_exchange_strong(expected, true)) {
            S->previewSkipped.fetch_add(1);
        } else {
            dispatch_async(S->previewQ, ^{
              // `previewInFlight` MUST be cleared however this block leaves.
              // Leaking it true would coalesce away every remaining preview of
              // the sweep — a silent, permanent empty panel, i.e. the exact bug
              // being fixed, reintroduced by its own fix.  An escaping C++
              // exception on a GCD block is also std::terminate, so the reset
              // and the catch are one construct rather than two hopes.
              struct Clear {
                  const std::shared_ptr<SessionState>& s;
                  ~Clear() { s->previewInFlight.store(false); }
              } clear{keep};
              try {
                  // previewMat is an INDEPENDENT buffer: Engine::orient's four
                  // branches (copyTo / flip / transpose / flip) all allocate,
                  // so nothing here aliases the canvas the engine is painting.
                  std::string err;
                  const bool ok = rnis::pano::publishJpegAtomically(
                      previewPath.UTF8String, previewMat, previewJpegQuality, &err);
                  if (ok) {
                      // ONLY NOW is there a file to point JS at.  Dims first,
                      // then the seq — JS keys its cache-bust off the seq, so a
                      // reader that sees the new seq must already see the dims
                      // (these are seq_cst, so that ordering is guaranteed).
                      keep->previewPubW.store(previewMat.cols);
                      keep->previewPubH.store(previewMat.rows);
                      keep->previewPublishedSeq.store(previewSeqForWrite);
                      // The COUNT, which is a different fact from the seq —
                      // see the declaration.  Incremented after the rename,
                      // like everything else here.
                      keep->previewPublished.fetch_add(1);
                  } else {
                      // NEVER SILENT AGAIN.  The previous publisher swallowed a
                      // cv::Exception here on every tick of every sweep for
                      // eleven days.  Count it (live, on the HUD), keep the
                      // first reason for the pack, and log it once so a console
                      // session sees it without needing a pack.
                      keep->previewFailed.fetch_add(1);
                      if (!keep->previewErrorLogged.exchange(true)) {
                          keep->previewFirstError = err;
                          NSLog(@"[RNIS pano+] LIVE PREVIEW NOT PUBLISHED — %s "
                                @"(path %@).  The sweep is unaffected; the "
                                @"panel on screen will stay empty.",
                                err.c_str(), previewPath);
                      }
                  }
              } catch (const std::exception& e) {
                  keep->previewFailed.fetch_add(1);
                  NSLog(@"[RNIS pano+] preview publish failed: %s", e.what());
              } catch (...) {
                  keep->previewFailed.fetch_add(1);
                  NSLog(@"[RNIS pano+] preview publish failed (unknown native "
                        @"failure)");
              }
            });
        }
    }

    dispatch_async(S->packQ, ^{
      // Decremented EXACTLY once whichever way this block leaves; a
      // double-decrement would let the pack queue run unbounded and a missed
      // one would wedge it closed after `queueMax` frames.
      bool pendingCounted = (framePath != nil);
      try {
        FILE *tf = keep->trackFp, *lf = keep->ledgerFp;
        if (tf) fwrite(trackLine.data(), 1, trackLine.size(), tf);
        if (lf) fwrite(ledgerLine.data(), 1, ledgerLine.size(), lf);
        // PERIODIC FLUSH.  The writers are 64 KB block-buffered, so a jetsam
        // / crash / background-kill mid-sweep would lose up to ~250 rows —
        // and pack-first says the ledger IS the evidence.  Flushing once a
        // second bounds that loss to ~30 rows for one fwrite of a partial
        // block per second.
        if (++keep->rowsSinceFlush >= 30) {
            keep->rowsSinceFlush = 0;
            if (tf) fflush(tf);
            if (lf) fflush(lf);
        }
        if (framePath != nil) {
            std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, frameQ};
            bool wroteFrame = false;
            std::string frameErr;
            try {
                wroteFrame = cv::imwrite(framePath.UTF8String, bgrForPack, params);
                if (wroteFrame) {
                    NSDictionary *attrs = [[NSFileManager defaultManager]
                        attributesOfItemAtPath:framePath error:nil];
                    if (attrs != nil) {
                        keep->packBytes.fetch_add((int64_t)[attrs fileSize]);
                    }
                } else {
                    frameErr = "cv::imwrite returned false";
                }
            }
            catch (const cv::Exception& e) { frameErr = e.what(); }
            if (!wroteFrame) {
                // NOT SWALLOWED.  `framesWritten` is incremented on the engine
                // queue BEFORE this block runs, so a silent failure here makes
                // meta.json overstate what is in the pack — and the pack is
                // our only evidence channel.  Count it and say so once.
                keep->frameWriteFailed.fetch_add(1);
                if (!keep->frameErrorLogged.exchange(true)) {
                    NSLog(@"[RNIS pano+] pack FRAME not written — %s (%@).  "
                          @"meta.json's frameWriteFailed carries the count.",
                          frameErr.c_str(), framePath);
                }
            }
            keep->packPending.fetch_sub(1);
            pendingCounted = false;
        }
      } catch (const std::exception& e) {
        // Same reason as the engine queue: an escaping exception on a GCD
        // block is std::terminate.  A lost pack row is not worth the app.
        NSLog(@"[RNIS pano+] pack write failed: %s", e.what());
        if (pendingCounted) keep->packPending.fetch_sub(1);
      } catch (...) {
        NSLog(@"[RNIS pano+] pack write failed (unknown native failure)");
        if (pendingCounted) keep->packPending.fetch_sub(1);
      }
    });
    (void)previewW; (void)previewH;
}

// ── Finalize / cancel ───────────────────────────────────────────────────────

+ (nullable NSDictionary<NSString *, id> *)finalizeSessionWithError:(NSError **)error {
    // CLAIM (read + clear under one lock) rather than read-then-clear: a
    // concurrent `cancel` must not be able to obtain the same session and
    // delete the pack this call is about to write.  See claimSession().
    auto S = claimSession();
    if (S == nullptr) {
        if (error) {
            *error = [NSError errorWithDomain:RNISPanoPlusErrorDomain
                                         code:404
                                     userInfo:@{NSLocalizedDescriptionKey:
                                                    @"No pano+ sweep is running."}];
        }
        return nil;
    }
    const double t0 = nowMs();
    // TWO BARRIERS, in this order, and the order is the whole point.
    //  1. `capturing = false` stops the AR thread enqueuing NEW work.
    //  2. An empty barrier lets everything ALREADY enqueued run — those are
    //     real frames whose strips belong in this panorama, and closing
    //     before them would silently throw away the last ~200 ms of sweep.
    //  3. `closed = true` turns any straggler that raced step 1 into a no-op.
    //  4. The finalize barrier itself.
    // Setting `closed` only AFTER step 4 (as the first cut did) let a
    // straggler run `engine.ingest()` on a finished engine and append a
    // ledger row AFTER the tail-flush row, which the replay twin reads as
    // out-of-order.  The serial queue guarantees anything enqueued between
    // steps 2 and 3 still runs before step 4, i.e. before the tail row.
    S->capturing.store(false);
    dispatch_sync(S->engineQ, ^{});
    S->closed.store(true);
    // 5. DRAIN THE PREVIEW QUEUE, before anything reads its counters.  It is
    //    its own serial queue now, so this barrier is also the happens-before
    //    edge that makes `previewFirstError` (written there, read below) safe
    //    to touch from here without a lock.
    dispatch_sync(S->previewQ, ^{});
    // 5a. SWEEP THE PUBLISHER'S SCRATCH FILE.  `publishJpegAtomically` removes
    //     its own `.part` on every failure path it can reach, but a jetsam or
    //     a background-kill mid-encode reaches none of them — and the pack is
    //     the evidence channel, so it must not ship a half-written JPEG
    //     fragment that a reader could mistake for the preview.  The queue is
    //     drained above, so anything still here is orphaned by definition.
    if (S->previewPath.length > 0) {
        [[NSFileManager defaultManager]
            removeItemAtPath:[S->previewPath stringByAppendingString:@".part"]
                       error:nil];
    }

    __block NSDictionary *summary = nil;
    __block NSString *failure = nil;
    dispatch_sync(S->engineQ, ^{
      // An escaping C++ exception on a GCD block is std::terminate.  The
      // canvas render below allocates tens of megabytes and the JPEG encode
      // can throw; neither is worth crashing the app over when the counters
      // alone are still evidence.
      try {
        // Values are pulled out of C++ ABOVE the pool that builds the ObjC
        // objects (the documented UAF discipline).
        rnis::pano::FrameOutcome tail = S->engine.finish();
        const auto st = S->engine.stats();
        const auto holes = S->engine.unpaintedRuns();
        const auto env = S->engine.verticalEnvelope();

        cv::Mat canvas;
        int canvasCropLo = 0, canvasCropHi = 0;
        const bool haveCanvas =
            S->engine.finalCanvas(canvas, S->pack.canvasCropPad,
                                  &canvasCropLo, &canvasCropHi)
            && !canvas.empty();
        // stats() reports the oriented size ANALYTICALLY (it must stay cheap —
        // it runs per frame); the authoritative dims are the real canvas's.
        const int outW = haveCanvas ? canvas.cols : 0;
        const int outH = haveCanvas ? canvas.rows : 0;
        NSString *canvasPath = [S->sessionDir stringByAppendingPathComponent:@"canvas.jpg"];
        bool wrote = false;
        if (haveCanvas) {
            std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, S->pack.canvasQuality};
            try { wrote = cv::imwrite(canvasPath.UTF8String, canvas, params); }
            catch (const cv::Exception& e) {
                NSLog(@"[RNIS pano+] canvas write failed: %s", e.what());
            }
        }

        // ── THE COVERAGE SIDECAR: `canvas.jpg.coverage.png` ──────────────
        //
        // ⚠ THE TWIN OF `rnis_pano_live.cpp`'s, AND THE FIRST CUT SHIPPED
        // ONLY THAT ONE. That file's own header states the rule — "every
        // decision here has a twin in ios/RNISPanoCore.mm and the twin is
        // named in the comment, because the two must not drift" — and the
        // sidecar was written on the Android leg alone. The consequence was
        // not a missing diagnostic: `<Camera>` also enabled the crop editor
        // for the sweep in the same change, so on iOS the editor opened
        // PRE-SEEDED on `computeInscribedRect`'s brightness-proxy fallback
        // and one tap on Confirm cropped the deliverable to it. On the
        // operator's own pack (`pp_1789931447063`) that proxy answers 24.3%
        // of the canvas — a thin band across the ceiling — against a true
        // 68.4%, because a black TV in the middle of the frame forces the
        // rectangle above it. Every number in that change set was measured
        // on iOS, and iOS was the platform it did not reach.
        //
        // The three rules the twin states, restated because they are the
        // whole contract:
        //   1. `finalCoverage` at the SAME `canvasCropPad` as `finalCanvas`
        //      above — one geometry path, one crop, or the mask describes a
        //      different picture and the crop lands on its boundary.
        //   2. PNG. The readers threshold at `> 0`, so JPEG ringing would
        //      leak non-zero into the unpainted region and widen the
        //      rectangle past the real edge.
        //   3. Best-effort and silent. The crop has a fallback; a sweep must
        //      never fail because a mask could not be written, and every
        //      reader re-checks the mask's dimensions before trusting it.
        if (wrote) {
            try {
                cv::Mat cov;
                if (S->engine.finalCoverage(cov, S->pack.canvasCropPad)
                    && !cov.empty() && cov.size() == canvas.size()) {
                    NSString *covPath =
                        [canvasPath stringByAppendingString:@".coverage.png"];
                    cv::imwrite(covPath.UTF8String, cov);
                }
            } catch (const cv::Exception& e) {
                NSLog(@"[RNIS pano+] coverage sidecar not written: %s", e.what());
            } catch (...) {
                NSLog(@"[RNIS pano+] coverage sidecar not written");
            }
        }

        // ── v12: THE FINAL PREVIEW — republished from the FINISHED engine ──
        // `finish()` above just committed the tail flush, which is 24-30% of
        // the deliverable on the operator's packs — painted AFTER the last
        // live publish, so preview.jpg in the pack (and the last thing on the
        // operator's screen) never contained it.  One more render + atomic
        // publish (~4 ms against a finalize that encodes the full canvas)
        // makes the last published preview BE the deliverable.  `leadOut` is
        // off here — nothing is provisional any more — and the seq bump lets
        // a poll that lands after finalize refresh the panel.
        bool previewFinalRepublished = false;
        if (wrote && S->previewPath.length > 0) {
            cv::Mat finalPv;
            rnis::pano::PreviewWindow finalWin;
            if (S->engine.previewIntoFit(finalPv,
                                         S->pack.previewMaxAlong,
                                         S->pack.previewMaxCross,
                                         0, &finalWin,
                                         S->pack.previewCropPad,
                                         /*leadOut=*/false)
                && !finalPv.empty()) {
                // REVIEW FIX — rendered is counted at RENDER time, exactly
                // like the live path, so a failed publish keeps the pack's
                // documented identity: rendered == published+failed+skipped.
                S->previewRendered.fetch_add(1);
                std::string err;
                previewFinalRepublished = rnis::pano::publishJpegAtomically(
                    S->previewPath.UTF8String, finalPv,
                    S->pack.previewQuality, &err);
                if (previewFinalRepublished) {
                    ++S->previewSeq;
                    S->previewPubW.store(finalPv.cols);
                    S->previewPubH.store(finalPv.rows);
                    S->previewPublishedSeq.store(S->previewSeq);
                    S->previewPublished.fetch_add(1);
                    // REVIEW FIX — the geometry atomics now describe the
                    // preview.jpg actually IN the pack (this render), not the
                    // last live tick.  Same stores as the live block, same
                    // ordering: geometry first, seq last.
                    S->previewViewPx.store(finalWin.viewEndU - finalWin.viewStartU);
                    S->previewBandPx.store(finalWin.bandEndU - finalWin.bandStartU);
                    S->previewViewStartPx.store(finalWin.viewStartU
                                                - finalWin.bandStartU);
                    S->previewWindowed.store(finalWin.windowed);
                    S->previewCanvasCrossPx.store(finalWin.canvasCrossPx);
                    S->previewViewCrossPx.store(finalWin.viewCrossPx);
                    S->previewFrontierFracMilli.store(
                        finalWin.frontierFrac < 0.0
                            ? -1
                            : (int)std::lround(finalWin.frontierFrac * 1000.0));
                } else {
                    S->previewFailed.fetch_add(1);
                    NSLog(@"[RNIS pano+] final preview republish failed: %s",
                          err.c_str());
                }
            }
        }

        // Tail-flush row joins the ledger like any other decision.
        std::string tailLine = "{\"seq\":-1,\"outcome\":\"";
        tailLine += rnis::pano::outcomeName(tail.outcome);
        tailLine += "\",\"canvasX0\":"; appendNum(tailLine, tail.canvasX0);
        tailLine += ",\"canvasX1\":"; appendNum(tailLine, tail.canvasX1);
        tailLine += ",\"gainCum\":"; appendNum(tailLine, tail.gainCum);
        tailLine += ",\"highWater\":"; appendNum(tailLine, tail.highWater);
        tailLine += ",\"engineMs\":"; appendNum(tailLine, tail.engineMs);
        tailLine += "}\n";
        if (S->ledgerFp) fwrite(tailLine.data(), 1, tailLine.size(), S->ledgerFp);

        // Envelope summary: the ragged edge rectification leaves is REPORTED,
        // never silently cropped away (Config::cropVertical defaults false).
        int envTopMax = 0, envBotMin = st.canvasH, envCovered = 0;
        for (const auto& e : env) {
            if (e.second <= e.first) continue;
            ++envCovered;
            envTopMax = std::max(envTopMax, e.first);
            envBotMin = std::min(envBotMin, e.second);
        }
        int64_t holeCols = 0;
        for (const auto& r : holes) holeCols += (r.second - r.first);

        const double sweepMs = (S->lastTsNs > S->firstTsNs)
            ? (S->lastTsNs - S->firstTsNs) * 1e-6 : 0.0;
        const double fpsMeasured = (sweepMs > 0 && S->engineFrames > 1)
            ? ((double)(S->engineFrames - 1) * 1000.0 / sweepMs) : 0.0;

        const std::string abortReason = st.abortReason;
        const bool anyPaint = st.painted > 0 && haveCanvas && wrote;

        @autoreleasepool {
            NSMutableArray *holeArr = [NSMutableArray array];
            for (const auto& r : holes) [holeArr addObject:@[@(r.first), @(r.second)]];

            NSDictionary *counts = @{
                @"seen":                @((NSInteger)st.seen),
                @"painted":             @((NSInteger)st.painted),
                @"heldBacktrack":       @((NSInteger)st.heldBacktrack),
                @"heldFrontier":        @((NSInteger)st.heldFrontier),
                @"skippedNoAdvance":    @((NSInteger)st.skippedNoAdvance),
                @"rejectedLowResponse": @((NSInteger)st.rejectedLowResponse),
                @"rejectedOutOfCage":   @((NSInteger)st.rejectedOutOfCage),
                @"rejectedPoseSpeed":   @((NSInteger)st.rejectedPoseSpeed),
                @"rejectedTracking":    @((NSInteger)st.rejectedTracking),
                @"rejectedRectify":     @((NSInteger)st.rejectedRectify),
                @"rejectedInput":       @((NSInteger)st.rejectedInput),
                // Repeat / reordered frame deliveries, skipped rather than
                // fatal (v11).  Its own key so a delivery hiccup can never be
                // read as a malformed frame — and so the field can SHOW how
                // often the old abort would have killed a sweep.
                @"skippedNonmonotonicTs": @((NSInteger)st.skippedNonmonotonicTs),
                // v13 — what the jog guard did; refusals with zero forced is
                // the guard working, forced > 0 names a persistent divergence
                // it could only defer.
                @"d8JogRefusals":       @((NSInteger)st.d8JogRefusals),
                @"d8JogForced":         @((NSInteger)st.d8JogForced),
                @"warmingUp":           @((NSInteger)st.warmingUp),
                @"bootstrap":           @((NSInteger)st.bootstrap),
                @"gapExtended":         @((NSInteger)st.gapExtended),
                @"gapBreak":            @((NSInteger)st.gapBreak),
                @"gapBackfilled":       @((NSInteger)st.gapBackfilled),
                @"limitedFrames":       @((NSInteger)st.limitedFrames),
                @"canvasGrowths":       @((NSInteger)st.canvasGrowths),
                @"canvasHeightGrowths": @((NSInteger)st.canvasHeightGrowths),
            };

            // PERPENDICULAR TRUNCATION — the failure `unpaintedRuns` cannot
            // see.  A clipped panorama must never report the same as a clean
            // one, so this rides both the summary and meta.json.
            NSDictionary *clipping = @{
                @"frames":     @((NSInteger)st.clippedFrames),
                @"columns":    @((NSInteger)st.clippedColumns),
                @"maxTopPx":   jnum(st.maxClipTopPx),
                @"maxBottomPx":jnum(st.maxClipBotPx),
                @"canvasH":    @(st.canvasH),
                @"heightGrowths": @((NSInteger)st.canvasHeightGrowths),
                @"vShiftTotalPx": jnum(st.vShiftTotalPx),
            };
            // REGIME — rotation vs translation, measured along the latched
            // sweep axis over accepted frames (see SessionStats).
            NSDictionary *regime = @{
                @"rotationFraction": jnum(st.rotationFraction),
                @"rotTravelPx":      jnum(st.rotTravelPx),
                @"resTravelPx":      jnum(st.resTravelPx),
                @"rotPathPx":        jnum(st.rotPathPx),
                @"resPathPx":        jnum(st.resPathPx),
            };
            NSDictionary *latch = @{
                @"framesUsed":  @((NSInteger)st.latchFramesUsed),
                // The latch votes on the TOTAL only; the rotation vector is
                // recorded so a reader can see the two DISAGREE (a walk with a
                // large perpendicular rotationPx is an operator who tilted
                // while walking).
                @"weak":        @(st.latchWasWeak),
                @"relatchCount": @((NSInteger)st.relatchCount),
                @"rotationPx":  @[jnum(st.latchRotPx[0]), jnum(st.latchRotPx[1])],
                @"totalPx":     @[jnum(st.latchTotPx[0]), jnum(st.latchTotPx[1])],
                @"axis":        @(st.axis),
                @"sweepSign":   @(st.sweepSign),
                @"latched":     @(st.axisLatched),
            };
            // ── v5: THE CUT METRIC + THE WARPING NUMBER ────────────────
            // v4 reported all four of the operator's packs CLEAN while he
            // could see cuts in every one of them.  These are the fields that
            // make that impossible, and `integrityFailed` is the engine's own
            // answer to "would this pack have been called clean?".
            NSDictionary *seam = @{
                @"worstBandP50Px":   jnum(st.seamWorstBandP50Px),
                @"worstBandP95Px":   jnum(st.seamWorstBandP95Px),
                @"worstBandMaxPx":   jnum(st.seamWorstBandMaxPx),
                @"bandSpreadP95Px":  jnum(st.seamBandSpreadP95Px),
                // CROSS-SWEEP SHEAR — corrected label, v8.  A per-boundary
                // residual of a few tenths of a px is invisible on its own and
                // integrates over hundreds of strips into a progressive shear
                // ACROSS the strip.  It was called "the wobble" through v5-v7
                // and it is not: the pose-anchor A/B measured it IDENTICAL in
                // every placement arm (32.2 / 52.4 / 17.0 / 66.4 px on the four
                // operator packs, unchanged to three figures) while the
                // slat-wall ruler on the same canvases moved by up to 40%.  It
                // cannot move — the rigid cross placement is common to every
                // band and cancels in the max−min.  For the walk see
                // `jogDriftPx` below, and read its scope note first.
                @"crossBandDivergencePx": jnum(st.crossBandDivergencePx),
                // ...and THIS is the gated one.  The raw sum above is
                // cumulative, so an absolute bar on it fails a long sweep for
                // being long; dividing by sqrt(n) is stationary under noise at
                // any length and still grows under a real systematic bias.
                @"crossBandDivergenceNormPx": jnum(st.crossBandDivergenceNormPx),
                @"lumaStepP50DN":    jnum(st.seamLumaStepP50DN),
                @"lumaStepP95DN":    jnum(st.seamLumaStepP95DN),
                @"lumaStepMaxDN":    jnum(st.seamLumaStepMaxDN),
                // ── v6: THE PHOTOMETRIC SEAM ────────────────────────────
                // Measured over the WHOLE shared footprint of the two owners
                // and UNIFORMITY-TESTED, so a misregistered scene edge cannot
                // fire it.  The v5 single-column `lumaStep*` above is kept
                // beside it as the control: it is quantisation-limited at
                // ±1 DN and could not resolve a 0.21 DN median from a 4.68 DN
                // band, which is why 15-58-22 verdicted clean.
                @"photoStepP50DN":   jnum(st.seamPhotoStepP50DN),
                @"photoStepP95DN":   jnum(st.seamPhotoStepP95DN),
                @"photoStepMaxDN":   jnum(st.seamPhotoStepMaxDN),
                @"photoSamples":     @((NSInteger)st.seamPhotoSamples),
                // v8 — HOW MANY boundaries were over the 3.00 DN max bar.  The
                // verdict's clause is a MAX clause, so one anomalous boundary
                // out of six hundred fires it exactly as loudly as a genuine
                // end-to-end band; the operator said he could not see the
                // banding we were describing, and this is the number that
                // tells those two apart from the pack alone.
                @"photoStepOverBar": @((NSInteger)st.seamPhotoStepOverBar),
                // DIAGNOSTIC: boundaries whose difference was not DC-like
                // ACROSS THE BOUNDARY'S OWN EXTENT (canvas-row bands).  They
                // ARE in the percentiles — excluding them would condition the
                // percentiles on the ones that happened to look flat.
                //
                // `photoUniStep*` is the cross-check that the gate is not
                // firing on scene structure: the same percentiles over the
                // DC-like boundaries ALONE.  On the operator's four packs the
                // gate still clears the bar there (1.57 / 1.66 / 0.75 / 1.85
                // DN), so the verdict is not an artefact of registration.
                @"photoNonUniform":  @((NSInteger)st.seamPhotoNonUniform),
                @"photoUniformUnknown":
                    @((NSInteger)st.seamPhotoUniformUnknown),
                @"photoUniStepP95DN": jnum(st.seamPhotoUniStepP95DN),
                @"photoUniStepMaxDN": jnum(st.seamPhotoUniStepMaxDN),
                @"photoUniSamples":  @((NSInteger)st.seamPhotoUniSamples),
                @"photoSpreadP95DN": jnum(st.seamPhotoSpreadP95DN),
                @"photoSpreadMaxDN": jnum(st.seamPhotoSpreadMaxDN),
                // THE BAND, ON COMMITTED PIXELS.  Integrating the SIGNED
                // per-boundary step reconstructs the brightness the canvas
                // actually carries — including the CAMERA's own drift, which
                // the engine's applied field structurally cannot see on a pack
                // captured without the exposure lock.  Calibration check: with
                // the chain's correction removed this reads +51 to +69% on the
                // operator's four packs, independently reproducing the offline
                // owner map's measurement of the camera (C = 1.50-1.79).
                @"photoDriftLocalPct": jnum(st.seamPhotoDriftLocalPct),
                @"photoDriftTotalPct": jnum(st.seamPhotoDriftTotalPct),
                @"photoDriftWorstU":   @((NSInteger)st.seamPhotoDriftWorstU),
                @"boundaries":       @((NSInteger)st.seamBoundaries),
                @"coverageFrac":     jnum(st.seamCoverageFrac),
                // COMMITTED PIXELS.  Independent of the placement arithmetic
                // above: measured on the canvas through the painting warp.
                @"canvasJogP50Px":   jnum(st.seamCanvasJogP50Px),
                @"canvasJogP95Px":   jnum(st.seamCanvasJogP95Px),
                @"canvasJogMaxPx":   jnum(st.seamCanvasJogMaxPx),
                @"canvasJogSamples": @((NSInteger)st.seamCanvasJogSamples),
                // ── v8: THE ACCUMULATED SIGNED MISREGISTRATION. DIAGNOSTIC. ─
                // Running sum of the SIGNED committed-pixel jog: how far the
                // panorama has WALKED, which no percentile above can reach.
                //
                // ⚠ NOT the wobble number, and the pack says so rather than
                // leaving the next reader to assume it.  Validated against the
                // slat-wall ruler on all four operator packs: the log-log
                // SLOPE tracks (mean |Δ| 0.16, both call it a walk on 4 of 4),
                // the AMPLITUDE is 1-4× high and ranks the packs differently,
                // because a running sum integrates this measurement's own
                // correlation noise alongside the defect.  Reported, never
                // gated — see rnis_pano.hpp::seamJogDriftPx.
                @"jogDriftPx":       jnum(st.seamJogDriftPx),
                @"jogDriftEndPx":    jnum(st.seamJogDriftEndPx),
                @"jogDriftSamples":  @((NSInteger)st.seamJogDriftSamples),
                // ── v8: IS THE BAND METRIC EVIDENCE, OR A FIT RESIDUAL? ──
                // TRUE when `crossAvgWindows` drove the chain, i.e. when the
                // placement is the least-squares centre of the same K band
                // measurements `worstBand*` scores it on.  A pack that carries
                // this true has NO independent band number; `canvasJog*` above
                // is the one that survives.  Reported rather than gated — the
                // averaged placement may be better, this only stops the band
                // improvement being quoted as the proof of it.
                //
                // v9: that sentence was FALSE when v8 shipped. The engine
                // appended the note to `why`, and `integrityFailed` is
                // `!why.empty()`, so the flag pinned every such pack to FAILED.
                // Fixed in rnis_pano.cpp (the note is carried on
                // `integrityReason` after the verdict, prefixed `NOTE `) and
                // pinned by PanoCrossAvg.TheBandResidualStopsBeing… — which
                // now checks the verdict rather than trusting this comment.
                @"bandSelfScored":   @(st.seamBandSelfScored),
                // FALSE means the numbers above describe NOTHING.  It is not
                // the same thing as clean and must never be read as clean.
                @"measured":         @(st.seamMeasured),
                @"integrityFailed":  @(st.integrityFailed),
                @"integrityReason":  [NSString stringWithUTF8String:
                                          st.integrityReason.c_str()],
            };
            NSDictionary *projection = @{
                @"mode":             @((NSInteger)st.projection),
                @"name":             (st.projection == 1 ? @"sweep-cylindrical"
                                                         : @"planar"),
                // THE WARPING NUMBER.  Worst area magnification over every
                // COMMITTED strip, relative to the reference optical axis.
                // 1.0 = none; a single photo from this camera is already 2.45
                // at its own corner, which is the scale to read it against.
                @"maxAreaScalePainted": jnum(st.maxAreaScalePainted),
                @"maxCrossRectifyDeg":  jnum(st.maxCrossRectifyDeg),
                // Same two blocks as the live dictionary above, for the same
                // reason: a pack that cannot say how much of itself came from
                // a single frame forces the question to be re-derived by
                // hand, and that re-derivation has already been got wrong.
                @"driftLevel":          @((NSInteger)st.driftLevel),
                @"driftArm":            (st.driftArm.empty()
                                            ? @"" : @(st.driftArm.c_str())),
                @"driftFiredAtRow":     @((NSInteger)st.driftFiredAtRow),
                @"driftPeakLeanDeg":    jnum(st.driftPeakLeanDeg),
                @"driftPeakSlideFrac":  jnum(st.driftPeakSlideFrac),
                @"provenanceSeedPx":    @((NSInteger)st.provenanceSeedPx),
                @"provenanceStripPx":   @((NSInteger)st.provenanceStripPx),
                @"provenanceTailPx":    @((NSInteger)st.provenanceTailPx),
                @"alongAxisIsOutputY":  @(st.alongAxisIsOutputY),
                @"seedLeadTrimPx":      @((NSInteger)st.seedLeadTrimPx),
                @"sweepDeg":            jnum(st.sweepDeg),
                @"crossScaleEnd":       jnum(st.crossScaleEnd),
                @"crossScaleCagedFrames": @((NSInteger)st.crossScaleCagedFrames),
                // 0 when the leak is off OR when mode 1 is not in use —
                // both are "it did nothing", and the pack must be able to
                // say so rather than omitting the field.
                @"crossScaleLeakedFrames": @((NSInteger)st.crossScaleLeakedFrames),
                // USED is the value the placement actually applied — under
                // the default subjectDistanceAuto that is the online fit, not
                // the configured number, and both are reported so a pack
                // reader never has to guess which one was in force.
                @"subjectDistanceUsedM":       jnum(st.subjectDistanceUsedM),
                @"subjectDistanceConfiguredM": jnum(st.subjectDistanceConfiguredM),
                @"subjectDistanceFitM":        jnum(st.subjectDistanceFitM),
                // ── v11: THE FIT, GRADED ────────────────────────────
                // MEASURED on the three Test-13 field packs: this fit
                // returned 1.95 / 6.00 / 5.87 m against a standoff
                // measured two independent ways at 0.6-1.0 m — 2× to
                // 7.5× wrong on every pack, on the 6.0 m clamp rail on
                // two of them — and the pack said NOTHING, because the
                // estimator self-scores.  These fields are hoisted to
                // the TOP of `projection`, not buried in the sub-dict,
                // so a reader who only skims cannot miss them.
                @"subjectDistanceFitSaturated":   @(st.subjectDistanceFitSaturated),
                @"subjectDistanceFitDegenerate":  @(st.subjectDistanceFitDegenerate),
                @"subjectDistanceFitRawM":        jnum(st.subjectDistanceFitRawM),
                @"subjectDistanceFit": @{
                    // The UNCLAMPED ratio.  Without it, a clamped 6.00
                    // and a genuine 6.00 are the same field.
                    @"rawM":            jnum(st.subjectDistanceFitRawM),
                    @"clampLoM":        @(0.3),
                    @"clampHiM":        @(6.0),
                    @"saturated":       @(st.subjectDistanceFitSaturated),
                    @"clampedUpdates":  @((NSInteger)st.subjectDistanceFitClampedUpdates),
                    // A REFUSED update silently retains the previous
                    // value, so a fit that stopped converging halfway
                    // is otherwise indistinguishable from one that did.
                    @"refusedUpdates":  @((NSInteger)st.subjectDistanceFitRefusedUpdates),
                    // THE REGRESSION DENOMINATOR — Σfwd², the whole
                    // conditioning of the estimate.  ~1e-4 m² on the
                    // field packs.
                    @"den":             jnum(st.subjectDistanceFitDen),
                    @"num":             jnum(st.subjectDistanceFitNum),
                    @"samples":         @((NSInteger)st.subjectDistanceFitSamples),
                    // THE LEVERAGE.  Forward travel is the only regressor
                    // this estimator has, and a shelf sweep holds standoff
                    // by design: 1.0% / 11.2% / 5.1% of perpendicular
                    // travel on the field packs.
                    @"fwdSpanM":        jnum(st.subjectDistanceFitFwdSpanM),
                    @"perpSpanM":       jnum(st.subjectDistanceFitPerpSpanM),
                    @"leverRatio":      jnum(st.subjectDistanceFitLeverRatio),
                    @"leverBar":        @(rnis::pano::kSubjectDistanceFitLeverBar),
                    @"perpFloorM":      @(rnis::pano::kSubjectDistanceFitPerpFloorM),
                    @"degenerate":      @(st.subjectDistanceFitDegenerate),
                    // "The fit was 6.00 m" and "the placement RAN on
                    // 6.00 m" are different facts.
                    @"inForce":         @(st.subjectDistanceFitInForce),
                },
                // ψ is gated on the axis latch, so the projection law changes
                // once, at the latch.  Bounded and self-correcting — and now
                // ledgered, because a projection that changes mid-sweep must
                // never do it silently.
                @"switchSeq":            @((NSInteger)st.projectionSwitchSeq),
                @"switchStepPx":         jnum(st.projectionSwitchStepPx),
            };
            // THE CHAINED EXPOSURE, reported rather than gated.  It walks
            // monotonically to 0.70-0.76 on every device pack — a 24-30%
            // end-to-end darkening with the same sign every time, i.e. a
            // BIASED estimator, not noise.  Config::gainLeak is the fix and is
            // OFF pending the operator's approval, so gating this would fail
            // every pack for a defect the engine is not yet allowed to correct.
            NSDictionary *gain = @{
                @"cumEnd":  jnum(st.gainCumEnd),
                @"leak":    jnum(S->cfg.gainLeak),
                @"cumClamp": jnum(S->cfg.gainCumClamp),
                // ── v6: THE BAND ────────────────────────────────────────
                // Peak-to-peak of the APPLIED photometric field over a
                // sliding 40-column window, and where the worst one starts.
                // THE number for the defect the operator circled: the chain
                // moves 0.2% per strip and 10-24% over 40 columns, and no
                // per-boundary metric can see that.
                @"localP2PPct":   jnum(st.photoLocalP2PPct),
                @"localWorstU":   @((NSInteger)st.photoLocalWorstU),
                @"localWindowPx": @(S->cfg.photoLocalWindowPx),
                @"rangePct":      jnum(st.photoScaleRangePct),
                @"scaleMin":      jnum(st.photoScaleMin),
                @"scaleMax":      jnum(st.photoScaleMax),
                @"columns":       @((NSInteger)st.photoColumns),
            };
            // ── v6: RADIOMETRIC NORMALISATION + THE CAPTURE-SIDE LOCK ────
            // `rangeRatio` is the EVIDENCE, and it outranks `lock` entirely:
            // the lock dictionary says what the device reported when we asked,
            // this says what the exposure actually did over the sweep.  1.00
            // with metaFrames > 0 ⇒ the lock held.  1.00 with metaFrames == 0
            // ⇒ UNKNOWN — there was no metadata to measure.  The v5 packs,
            // captured with no lock at all, ran 1.50-1.79.
            NSDictionary *exposure = @{
                @"normalize":     @(S->cfg.exposureNormalize),
                @"gainClamp":     jnum(S->cfg.exposureGainClamp),
                @"metaFrames":    @((NSInteger)st.exposureMetaFrames),
                @"clampedFrames": @((NSInteger)st.exposureClampedFrames),
                @"refValue":      jnum(st.exposureRefValue),
                @"minValue":      jnum(st.exposureMinValue),
                @"maxValue":      jnum(st.exposureMaxValue),
                @"rangeRatio":    jnum(st.exposureRangeRatio),
                @"lock":          S->getCameraLock() ?: (id)[NSNull null],
                // ── v11: THE NON-CIRCULAR HALF ──────────────────────
                // Everything above is measured on the AVCaptureDevice
                // this pod resolved and locked — the same object, read
                // back — so it cannot answer "is that the device ARKit
                // streams?" or "does the lock reach ARKit's pixels?".
                // This block is measured on `ARCamera`, i.e. on the
                // frames ARKit actually delivered.
                //
                // READ IT LIKE THIS:
                //   frames == 0            ⇒ UNKNOWN.  ARKit's numbers
                //       were unreachable on this run — not a failure of
                //       the lock, and not a success.  `probe` says why.
                //   rangeRatio == 1.00 with frames > 0 ⇒ the lock
                //       reached ARKit's pixels.  This is the claim the
                //       camera-lock header explicitly declined to make.
                //   pairedFrames > 0 and maxRelDelta ≈ 0 ⇒ ARKit's
                //       camera and the device we locked report the same
                //       exposure, i.e. the same physical device.
                @"ar": @{
                    @"frames":         @((NSInteger)st.arExposureFrames),
                    @"minDurationS":   jnum(st.arExposureMinS),
                    @"maxDurationS":   jnum(st.arExposureMaxS),
                    @"rangeRatio":     jnum(st.arExposureRangeRatio),
                    @"offsetMinEV":    jnum(st.arExposureOffsetMinEV),
                    @"offsetMaxEV":    jnum(st.arExposureOffsetMaxEV),
                    @"pairedFrames":   @((NSInteger)st.arVsDevicePairedFrames),
                    @"maxAbsDeltaS":   jnum(st.arVsDeviceMaxAbsDeltaS),
                    @"maxRelDelta":    jnum(st.arVsDeviceMaxRelDelta),
                    // HOW the ARSession was reached, and whether it was
                    // reached at all — supplied by the host at stop().
                    // Absent ⇒ the host did not report, which is itself
                    // distinguishable from "reported: not found".
                    @"probe":          S->getArExposureProbe() ?: (id)[NSNull null],
                },
            };
            // ── v10: THE LENS GATE'S VERDICT ────────────────────────
            // Always present, whatever it decided.  A pack that was NOT
            // corrected must say so, and say on what evidence — otherwise a
            // reader cannot tell an uncorrected pack from one written before
            // the correction existed.  `gate` is the decision; `fxOverWidth`
            // is what the gate MEASURED off ARKit's own per-frame intrinsics;
            // `deviceLens` is the ADVISORY name (see the config note).
            NSDictionary *lens = @{
                @"applied":       @(st.lensApplied),
                @"gate":          [NSString stringWithUTF8String:st.lensGate.c_str()],
                @"device":        [NSString stringWithUTF8String:st.lensDevice.c_str()],
                @"deviceLens":    [NSString stringWithUTF8String:st.lensDeviceLens.c_str()],
                @"k1":            jnum(st.lensK1),
                @"k2":            jnum(st.lensK2),
                @"source":        [NSString stringWithUTF8String:st.lensSource.c_str()],
                @"fxOverWidth":   jnum(st.lensFxOverWidth),
                @"expectedFxOverWidth": jnum(st.lensExpectedFxOverWidth),
                // What the applied model is WORTH, in SOURCE px, over this
                // frame's own radius range — a coefficient pair means nothing
                // to a pack reader, a peak displacement means something.  TWO
                // numbers, named apart, because "peak" alone is ambiguous and
                // the ambiguity has already caused one misreading:
                //   peakRadialPx   — the TOTAL radial move, scale included
                //                    (≈5.11 px on iPhone17,1 wide).
                //   peakResidualPx — the same with the pure-scale term removed
                //                    (2.8 px, peaking at the frame CORNER):
                //                    the MOUSTACHE, i.e. the only part that can
                //                    bend a straight line.  A pure scale moves
                //                    everything and bends nothing.
                // Neither is the "−4.36 px" the fit round quoted — that is
                // peakRadialPx on the SINGLE-SHOT coefficients, not on the
                // fixpoint pair that ships (see rnis_pano.hpp).
                @"peakRadialPx":   jnum(st.lensPeakRadialPx),
                @"peakResidualPx": jnum(st.lensPeakResidualPx),
                @"correctedStrips": @((NSInteger)st.lensCorrectedStrips),
                // Non-zero ⇒ strips painted from a frame whose focal the gate
                // refuses (a lens switch mid-sweep).  A finding, not noise.
                @"skippedStrips": @((NSInteger)st.lensSkippedStrips),
            };
            NSDictionary *envelope = @{
                @"columns":     @((NSInteger)env.size()),
                @"covered":     @((NSInteger)envCovered),
                @"commonTop":   @(envTopMax),
                @"commonBottom":@(envBotMin),
            };
            NSString *abortStr = abortReason.empty()
                ? nil : [NSString stringWithUTF8String:abortReason.c_str()];

            NSDictionary *meta = @{
                @"engineVersion":  @(rnis::pano::kEngineVersion),
                @"device":         deviceModel(),
                // The physical hold, so a pack no longer has to have its
                // orientation DERIVED from `referenceQuat` before any claim
                // about the sweep direction can be checked.  See
                // SessionState::hold.
                @"hold":           S->hold ?: @"",
                @"iosVersion":     [[NSProcessInfo processInfo] operatingSystemVersionString] ?: @"",
                @"config":         panoConfigDict(S->cfg, S->pack),
                @"format":         @{@"fpsMeasured": jnum(fpsMeasured)},
                @"referenceQuat":  @[jnum(st.refQuat[0]), jnum(st.refQuat[1]),
                                     jnum(st.refQuat[2]), jnum(st.refQuat[3])],
                @"referenceIntrinsics": @{@"fx": jnum(st.refFx), @"fy": jnum(st.refFy),
                                          @"cx": jnum(st.refCx), @"cy": jnum(st.refCy)},
                @"axis":           @(st.axis),
                @"sweepSign":      @(st.sweepSign),
                @"axisLatched":    @(st.axisLatched),
                // `w`/`h`/`paintedW` are CANVAS-frame (u,v); `outputW/H` are
                // canvas.jpg's own pixels and `outputRotationCwDeg` is the
                // quarter turn between the two — published so a pack reader
                // can map the ledger onto the image instead of assuming.
                //
                // ⚠ ONE `@"canvas"` ENTRY, AND IT HAS TO STAY ONE.  The v12
                // crop keys below arrived as a SECOND `@"canvas":` entry in
                // this same literal, so the dictionary kept the first and
                // dropped them — measured on all 37 iPhone packs on disk: 0
                // carry `cropCrossLoPx`.  The compiler had been saying so the
                // whole time (-Wobjc-dictionary-duplicate-keys) into a build
                // log nobody read.  Add to this literal; never re-open the key.
                //
                // canvas.jpg's cross extent can differ from the canvas frame
                // the ledger/meta coordinates live in (the pad trim).  Both
                // the knob and the APPLIED offsets ride the pack so the two
                // frames are reconcilable; offline tooling adds
                // `cropCrossLoPx` to a canvas.jpg cross coordinate to get back
                // to canvas-frame.  Without them an offline reader cannot map
                // the ledger onto the image at all — which is exactly what
                // "what resolution were these frames?" ran into on iOS.
                @"canvas":         @{@"w": @(st.canvasW), @"h": @(st.canvasH),
                                     @"paintedW": @(st.paintedW),
                                     @"outputW": @(outW), @"outputH": @(outH),
                                     @"outputRotationCwDeg": @(st.outputRotationCwDeg),
                                     @"cropPadRows":   @(S->pack.canvasCropPad),
                                     @"cropCrossLoPx": @(canvasCropLo),
                                     @"cropCrossHiPx": @(canvasCropHi)},
                @"maxAdvancePxResolved": jnum(st.maxAdvancePxResolved),
                @"corrCentroidBoxResolved": @(st.corrCentroidBoxResolved),
                @"corrWindowW":             @(st.corrWindowW),
                @"corrWindowH":             @(st.corrWindowH),
                // The precondition of the attitude-cancellation identity.
                // 0 ⇒ the whole sweep ran inside the regime where the
                // committed step carries no attitude term at all.
                @"corrOriginClampedFrames": @(st.corrOriginClampedFrames),
                @"maxRectifyDeg":  jnum(st.maxRectifyDeg),
                // WHAT KIND OF SWEEP THIS WAS.  Read `rotationFraction`
                // first: the two regimes fail differently, and a residual
                // read against the wrong one is worse than no read.
                @"regime":         regime,
                @"projection":     projection,
                @"seam":           seam,
                @"gain":           gain,
                @"exposure":       exposure,
                @"lens":           lens,
                // WHAT THE AXIS/SIGN LATCH DECIDED, AND ON WHAT.  A latch is
                // irreversible and decides whether anything paints at all, so
                // its evidence is part of the pack.
                @"latch":          latch,
                @"counts":         counts,
                @"unpaintedRuns":  holeArr,
                @"unpaintedColumns": @((NSInteger)holeCols),
                // The runs index the SWEEP axis, which is the output's column
                // axis only for a horizontal sweep — a vertical sweep is
                // transposed by the finalize bake.  Naming the axis here is
                // what stops a reader printing "columns" and being wrong.
                @"unpaintedRunsAxis": (st.axis == 0 ? @"x" : @"y"),
                @"clipping":       clipping,
                @"verticalEnvelope": envelope,
                @"engineMs":       statsDict(S->engineMs),
                @"arThreadUs":     statsDict(S->arThreadUs),
                @"previewMs":      statsDict(S->previewMs),
                // THE PREVIEW'S OWN LEDGER.  `rendered` is what the engine
                // produced, `published` what reached disk, `failed` what could
                // not be written and `firstError` why.  On the three 2026-08-29
                // packs the honest row would have read
                // rendered ~30 / published 0 / failed ~30 — and no pack could
                // say it, which is why the bug survived eleven days and six
                // green test runs.
                @"preview":        @{
                    // THE INTERVAL ACTUALLY IN FORCE at the end of the sweep.
                    // `config.pack.previewIntervalMs` is only the FLOOR; the
                    // duty throttle raises this one when the render gets dear,
                    // and an offline reader cannot tell a slow panel from a
                    // configured one without both numbers.
                    @"intervalEffMs": jnum(S->previewIntervalEff),
                    @"costEwmaMs":    jnum(S->previewCostEwma),
                    // The last published preview's place in the panorama.  A
                    // pack whose `bandPx` is much larger than `viewPx` is one
                    // where the frontier window engaged — the operator was
                    // shown a constant-scale slice instead of a shrinking
                    // whole.  Equal means it never engaged.
                    @"viewPx":        @((NSInteger)S->previewViewPx.load()),
                    @"bandPx":        @((NSInteger)S->previewBandPx.load()),
                    @"windowed":      @(S->previewWindowed.load()),
                    // The cross axis before and after the pad trim.  A pack
                    // whose `viewCrossPx` equals `canvasCrossPx` was rendered
                    // with 21% of the panel spent on black.
                    @"canvasCrossPx": @((NSInteger)S->previewCanvasCrossPx.load()),
                    @"viewCrossPx":   @((NSInteger)S->previewViewCrossPx.load()),
                    // v12 — whether the post-finish() republish landed, i.e.
                    // whether preview.jpg in this pack IS the deliverable
                    // (tail flush included) rather than the last live tick.
                    @"finalRepublished": @(previewFinalRepublished),
                    // v12 review fix — the knob, recorded so an offline reader
                    // can tell a lead-out preview from a committed-only one.
                    @"leadOutEnabled": @(S->pack.previewLeadOut),
                    // The last live preview's provisional span in canvas px.
                    // > 0 proves the lead-out actually engaged; the final
                    // republish (leadOut off, tail flush already committed)
                    // deliberately does NOT overwrite it.
                    @"leadOutPx":      @((NSInteger)S->previewLeadOutPx.load()),
                    @"rendered":   @((NSInteger)S->previewRendered.load()),
                    // A COUNT.  `rendered == published + failed + skipped`
                    // exactly, and a shortfall is a render that vanished
                    // without reaching any arm — see the declaration.
                    @"published":  @((NSInteger)S->previewPublished.load()),
                    @"failed":     @((NSInteger)S->previewFailed.load()),
                    @"skipped":    @((NSInteger)S->previewSkipped.load()),
                    // The SEQ of the last one that landed — what JS keys its
                    // cache-bust off.  Not the count, and no longer filed
                    // under a name that reads like one.
                    @"lastPublishedSeq": @((NSInteger)S->previewPublishedSeq.load()),
                    @"width":      @((NSInteger)S->previewPubW.load()),
                    @"height":     @((NSInteger)S->previewPubH.load()),
                    @"firstError": S->previewFirstError.empty()
                                       ? (id)[NSNull null]
                                       : [NSString stringWithUTF8String:
                                             S->previewFirstError.c_str()],
                },
                // THE LEAD-OUT'S OWN LEDGER, for the same reason.  The tail
                // flush paints 29-48% of the deliverable on the operator's
                // packs and its body used to sit inside two EMPTY catches, so
                // a throw dropped the last third of the panorama with nothing
                // anywhere able to say so.  `attempted && !flushed` is the
                // fault; `attempted == false` is a sweep that never latched
                // and legitimately had no lead-out to paint.
                @"tailFlush":      @{
                    @"attempted":  @(st.tailFlushAttempted),
                    @"flushed":    @(st.tailFlushed),
                    // HOW MUCH OF THE PANORAMA IT OWNS. See
                    // `SessionStats::tailFlushColumns`: one frame, one pose,
                    // no per-strip registration, 13-24% of the deliverable on
                    // the operator's own packs.
                    @"columns":    @((NSInteger)st.tailFlushColumns),
                    @"error":      st.tailFlushError.empty()
                                       ? (id)[NSNull null]
                                       : [NSString stringWithUTF8String:
                                             st.tailFlushError.c_str()],
                },
                @"droppedQueue":   @((NSInteger)S->droppedQueue.load()),
                @"droppedPack":    @((NSInteger)S->droppedPack.load()),
                @"framesWritten":  @((NSInteger)S->framesWritten),
                @"frameWriteFailed": @((NSInteger)S->frameWriteFailed.load()),
                @"packBytes":      @((NSInteger)S->packBytes.load()),
                @"intrinsicsRescaled": @((NSInteger)S->intrinsicsRescaled),
                @"deliveredFrameWidth":  S->deliveredFrameW > 0
                                            ? @(S->deliveredFrameW) : (id)[NSNull null],
                @"deliveredFrameHeight": S->deliveredFrameH > 0
                                            ? @(S->deliveredFrameH) : (id)[NSNull null],
                @"packFrameCapHit": @(S->frameCapHit),
                @"clocks":         @{@"startWallMs": jnum(S->startWallMs),
                                     @"endWallMs": jnum(wallEpochMs()),
                                     @"firstTsNs": jnum(S->firstTsNs),
                                     @"lastTsNs": jnum(S->lastTsNs)},
                @"sweepMs":        jnum(sweepMs),
                @"abort":          abortStr ?: (id)[NSNull null],
            };
            // ── THE DECOUPLED ARM'S MARKER, AND ONLY THEN ──────────────
            // `meta` above is the literal that shipped.  On the ARKit arm
            // `getPoseSource()` is nil, nothing is added, and the serialised
            // bytes are unchanged — the property this whole hook exists to
            // preserve.  On the decoupled arm the key names the producer, so a
            // reader can never take `counts.rejectedPoseSpeed: 0` for a cage
            // that ran.
            NSDictionary *poseSourceBlock = S->getPoseSource();
            if (poseSourceBlock.count > 0) {
                NSMutableDictionary *withPose = [meta mutableCopy];
                withPose[@"poseSource"] = poseSourceBlock;
                meta = [withPose copy];
            }
            // ── THE SECOND ATTITUDE CHANNEL, ON THE SAME CONTRACT ──────
            // Emitted only when the sweep armed the sidecar.  A sweep that did
            // not asks nothing of this block and gets the meta.json that
            // shipped — which is the property that lets an experiment sit
            // beside the field-validated ARKit arm without altering it.
            NSDictionary *imuSidecarBlock = S->getImuSidecar();
            if (imuSidecarBlock.count > 0) {
                NSMutableDictionary *withImu = [meta mutableCopy];
                withImu[@"imuSidecar"] = imuSidecarBlock;
                meta = [withImu copy];
            }

            NSError *jsonErr = nil;
            NSData *json = [NSJSONSerialization dataWithJSONObject:meta
                                                           options:NSJSONWritingPrettyPrinted
                                                             error:&jsonErr];
            if (json != nil) {
                [json writeToFile:[S->sessionDir stringByAppendingPathComponent:@"meta.json"]
                       atomically:YES];
            } else {
                NSLog(@"[RNIS pano+] meta.json serialisation failed: %@", jsonErr);
            }

            if (!anyPaint) {
                failure = abortStr.length > 0
                    ? [NSString stringWithFormat:
                          @"The sweep produced no panorama (%@).", abortStr]
                    : @"The sweep produced no panorama — nothing was painted.";
                // regime + latch belong here MORE than in the success case:
                // a sweep that painted nothing is exactly when the operator
                // needs to know which way the engine thought it was going and
                // how many times it changed its mind.  meta.json carries them
                // either way, but the live summary used to drop them.
                summary = @{
                    @"sessionDir": S->sessionDir ?: @"",
                    @"counts": counts,
                    @"clipping": clipping,
                    @"regime": regime,
                    @"latch": latch,
                    @"abort": abortStr ?: (id)[NSNull null],
                };
            } else {
                summary = @{
                    @"sessionDir":      S->sessionDir ?: @"",
                    @"canvasPath":      canvasPath,
                    @"previewPath":     S->previewPath ?: @"",
                    @"metaPath":        [S->sessionDir stringByAppendingPathComponent:@"meta.json"],
                    @"ledgerPath":      [S->sessionDir stringByAppendingPathComponent:@"ledger.jsonl"],
                    @"trackPath":       [S->sessionDir stringByAppendingPathComponent:@"track.jsonl"],
                    @"width":           @(outW),
                    @"height":          @(outH),
                    @"counts":          counts,
                    @"axis":            @(st.axis),
                    @"sweepSign":       @(st.sweepSign),
                    @"maxRectifyDeg":   jnum(st.maxRectifyDeg),
                    @"regime":          regime,
                    @"latch":           latch,
                    // v6 — the operator's two rejections ride the SUMMARY, not
                    // only meta.json: the result screen must be able to say
                    // "banded" without opening the pack.
                    @"seam":            seam,
                    @"gain":            gain,
                    @"exposure":        exposure,
                    // v10 — the lens verdict rides the SUMMARY too, so a
                    // result screen can say "this body is not calibrated"
                    // without opening the pack.
                    @"lens":            lens,
                    @"projection":      projection,
                    @"unpaintedRuns":   holeArr,
                    @"unpaintedColumns":@((NSInteger)holeCols),
                    @"unpaintedRunsAxis": (st.axis == 0 ? @"x" : @"y"),
                    @"clipping":        clipping,
                    @"verticalEnvelope":envelope,
                    @"engineMs":        statsDict(S->engineMs),
                    @"arThreadUs":      statsDict(S->arThreadUs),
                    @"previewMs":       statsDict(S->previewMs),
                    // Same three numbers on the SUMMARY, so a result screen
                    // can say "the preview never published" without opening
                    // the pack.  See the meta.json block for why.
                    @"previewRendered": @((NSInteger)S->previewRendered.load()),
                    // A COUNT (see the declaration): the seq trails the
                    // rendered count by the coalesced ticks on a HEALTHY
                    // sweep, so reporting it here would fail good packs.
                    @"previewPublished":@((NSInteger)S->previewPublished.load()),
                    @"previewLastPublishedSeq":
                                        @((NSInteger)S->previewPublishedSeq.load()),
                    @"previewFailed":   @((NSInteger)S->previewFailed.load()),
                    @"previewSkipped":  @((NSInteger)S->previewSkipped.load()),
                    @"previewError":    S->previewFirstError.empty()
                                            ? (id)[NSNull null]
                                            : [NSString stringWithUTF8String:
                                                  S->previewFirstError.c_str()],
                    // The lead-out, on the SUMMARY for the same reason: a
                    // panorama that lost 29-48% of itself to a throw must be
                    // able to say so on the result screen, not only in a pack
                    // nobody opens until the next field trip.
                    @"tailFlushAttempted": @(st.tailFlushAttempted),
                    @"tailFlushed":     @(st.tailFlushed),
                    @"tailFlushColumns": @((NSInteger)st.tailFlushColumns),
                    // Twin of the Android finalize summary's field.
                    @"seedLeadTrimPx":  @((NSInteger)st.seedLeadTrimPx),
                    @"tailFlushError":  st.tailFlushError.empty()
                                            ? (id)[NSNull null]
                                            : [NSString stringWithUTF8String:
                                                  st.tailFlushError.c_str()],
                    @"droppedQueue":    @((NSInteger)S->droppedQueue.load()),
                    @"droppedPack":     @((NSInteger)S->droppedPack.load()),
                    @"framesWritten":   @((NSInteger)S->framesWritten),
                    @"frameWriteFailed":@((NSInteger)S->frameWriteFailed.load()),
                    @"packBytes":       @((NSInteger)S->packBytes.load()),
                    @"intrinsicsRescaled": @((NSInteger)S->intrinsicsRescaled),
                    @"deliveredFrameWidth":  S->deliveredFrameW > 0
                                                ? @(S->deliveredFrameW) : (id)[NSNull null],
                    @"deliveredFrameHeight": S->deliveredFrameH > 0
                                                ? @(S->deliveredFrameH) : (id)[NSNull null],
                    @"packFrameCapHit": @(S->frameCapHit),
                    @"sweepMs":         jnum(sweepMs),
                    @"fpsMeasured":     jnum(fpsMeasured),
                    @"abort":           abortStr ?: (id)[NSNull null],
                };
            }
        }
      } catch (const std::exception& e) {
        NSLog(@"[RNIS pano+] finalize failed: %s", e.what());
        failure = [NSString stringWithFormat:@"pano+ could not finish: %s", e.what()];
      } catch (...) {
        NSLog(@"[RNIS pano+] finalize failed with an unknown C++ exception");
        failure = @"pano+ could not finish (unknown native failure).";
      }
    });

    // Flush + close the pack writers on their own queue, then wait.
    dispatch_sync(S->packQ, ^{
        if (S->trackFp) { fflush(S->trackFp); fclose(S->trackFp); S->trackFp = nullptr; }
        if (S->ledgerFp) { fflush(S->ledgerFp); fclose(S->ledgerFp); S->ledgerFp = nullptr; }
    });

    NSMutableDictionary *out = summary != nil ? [summary mutableCopy]
                                             : [NSMutableDictionary dictionary];
    out[@"finalizeMs"] = @(nowMs() - t0);

    if (failure != nil) {
        if (error) {
            NSMutableDictionary *ui = [out mutableCopy];
            ui[NSLocalizedDescriptionKey] = failure;
            // D2 pattern: a FAILED sweep still carries its counters and its
            // sessionDir across the bridge — that pack is the evidence.
            *error = [NSError errorWithDomain:RNISPanoPlusErrorDomain
                                         code:422
                                     userInfo:ui];
        }
        return nil;
    }
    return out;
}

+ (void)recordCameraLock:(nullable NSDictionary<NSString *, id> *)report {
    auto S = currentSession();
    if (S == nullptr) return;
    S->setCameraLock((report.count > 0) ? [report copy] : nil);
}

+ (void)recordArExposureProbe:(nullable NSDictionary<NSString *, id> *)report {
    auto S = currentSession();
    if (S == nullptr) return;
    S->setArExposureProbe((report.count > 0) ? [report copy] : nil);
}

+ (void)recordPoseSource:(nullable NSDictionary<NSString *, id> *)report {
    auto S = currentSession();
    if (S == nullptr) return;
    S->setPoseSource((report.count > 0) ? [report copy] : nil);
}

+ (void)recordImuSidecar:(nullable NSDictionary<NSString *, id> *)report {
    auto S = currentSession();
    if (S == nullptr) return;
    S->setImuSidecar((report.count > 0) ? [report copy] : nil);
}

+ (void)mergeCameraLock:(nullable NSDictionary<NSString *, id> *)extra {
    if (extra.count == 0) return;
    auto S = currentSession();
    if (S == nullptr) return;
    NSDictionary *base = S->getCameraLock();
    NSMutableDictionary *merged =
        base ? [base mutableCopy] : [NSMutableDictionary dictionary];
    // ADD ONLY.  The start report is what the DEVICE said after the write and
    // must not be rewritten by a later, coarser observation.
    [extra enumerateKeysAndObjectsUsingBlock:^(NSString *k, id v, BOOL *stop) {
        (void)stop;
        if (merged[k] == nil) merged[k] = v;
    }];
    S->setCameraLock([merged copy]);
}

+ (void)cancel {
    // CLAIM, so a concurrent finalize cannot also own this session and have
    // its pack deleted out from under it (see claimSession()).
    auto S = claimSession();
    if (S == nullptr) return;
    S->capturing.store(false);
    S->closed.store(true);
    dispatch_sync(S->engineQ, ^{
        try { S->engine.reset(); } catch (...) {}
    });
    // Drain the preview queue too, or a publish still in flight would write
    // preview.jpg into a session directory this method is about to delete.
    dispatch_sync(S->previewQ, ^{});
    dispatch_sync(S->packQ, ^{
        if (S->trackFp) { fclose(S->trackFp); S->trackFp = nullptr; }
        if (S->ledgerFp) { fclose(S->ledgerFp); S->ledgerFp = nullptr; }
    });
    if (S->sessionDir.length > 0) {
        [[NSFileManager defaultManager] removeItemAtPath:S->sessionDir error:nil];
    }
    NSLog(@"[RNIS pano+] session cancelled");
}

/// The FULLY RESOLVED config, so a pack is self-describing and the offline
/// replay twin never has to guess which knobs the device ran with.
static NSDictionary *panoConfigDict(const rnis::pano::Config &c, const PackOptions &p) {
    return @{
        @"canvasScale":          @(c.canvasScale),
        @"stripMargin":          @(c.stripMargin),
        @"minAdvancePx":         @(c.minAdvancePx),
        @"maxAdvancePx":         @(c.maxAdvancePx),
        @"maxAdvanceFrac":       @(c.maxAdvanceFrac),
        @"maxSweepSpeedMps":     @(c.maxSweepSpeedMps),
        @"poseSlackM":           @(c.poseSlackM),
        @"rectify":              @(c.rectify),
        @"gainMatch":            @(c.gainMatch),
        @"gainStepClamp":        @(c.gainStepClamp),
        @"gainCumClamp":         @(c.gainCumClamp),
        @"gainSampleMinPx":      @(c.gainSampleMinPx),
        @"workScale":            @(c.workScale),
        @"corrCentroidBoxPx":    @(c.corrCentroidBoxPx),
        @"phaseWindowPx":        @(c.phaseWindowPx),
        @"minPhaseResponse":     @(c.minPhaseResponse),
        @"stallResumeResponse":  @(c.stallResumeResponse),
        @"maxRejectRunFrames":   @(c.maxRejectRunFrames),
        @"canvasInitWidthPx":    @(c.canvasInitWidthPx),
        @"canvasMaxWidthPx":     @(c.canvasMaxWidthPx),
        @"canvasPadPx":          @(c.canvasPadPx),
        @"canvasGrowVertical":   @(c.canvasGrowVertical),
        @"canvasMaxHeightPx":    @(c.canvasMaxHeightPx),
        @"canvasMaxPixels":      @(c.canvasMaxPixels),
        @"backfillGaps":         @(c.backfillGaps),
        @"abortOnLimitedTracking": @(c.abortOnLimitedTracking),
        @"trackingWarmupFrames": @(c.trackingWarmupFrames),
        @"cageStallFrames":      @(c.cageStallFrames),
        @"axisLatchFrames":      @(c.axisLatchFrames),
        @"axisLatchMaxFrames":   @(c.axisLatchMaxFrames),
        @"latchTotalPx":         @(c.latchTotalPx),
        @"relatchMotionPx":      @(c.relatchMotionPx),
        @"relatchCommitFrac":    @(c.relatchCommitFrac),
        @"relatchDominance":     @(c.relatchDominance),
        @"relatchMinFrames":     @(c.relatchMinFrames),
        @"relatchMaxCount":      @(c.relatchMaxCount),
        @"maxTranslationJumpM":  @(c.maxTranslationJumpM),
        @"rectifyYawLimitDeg":   @(c.rectifyYawLimitDeg),
        @"projection":           @(c.projection),
        @"sweepMaxDeg":          @(c.sweepMaxDeg),
        @"crossSweepFit":        @(c.crossSweepFit),
        @"crossFitMode":         @(c.crossFitMode),
        @"crossWindows":         @(c.crossWindows),
        // v8 — which cross measurement moved the chain.  false (the shipped
        // default) is the v7 chain; a pack states this so an offline replay
        // never has to infer it from the numbers.
        @"crossAvgWindows":      @(c.crossAvgWindows),
        @"crossSpanFrac":        @(c.crossSpanFrac),
        @"crossGradMaxPerFrame": @(c.crossGradMaxPerFrame),
        @"crossScaleCageFrac":   @(c.crossScaleCageFrac),
        @"crossFitDcRemove":     @(c.crossFitDcRemove),
        @"crossScaleLeak":       @(c.crossScaleLeak),
        @"crossFitMinBandR2":    @(c.crossFitMinBandR2),
        @"subjectDistanceM":     @(c.subjectDistanceM),
        @"subjectDistanceAuto":  @(c.subjectDistanceAuto),
        @"seamMetrics":          @(c.seamMetrics),
        @"d8JogGuard":           @(c.d8JogGuard),
        @"d8JogBarPx":           @(c.d8JogBarPx),
        @"d8JogMaxRun":          @(c.d8JogMaxRun),
        @"gainLeak":             @(c.gainLeak),
        // The elbow fix — which trajectory arm the seed/tail blocks and the
        // preview lead-out ran under. A pack states this so an offline replay
        // of the hinge never has to infer the arm from the bend.
        @"crossTraj":            @(c.crossTraj),
        @"crossTrajRelaxPx":     @(c.crossTrajRelaxPx),
        @"leadOutFromFrontier":  @(c.leadOutFromFrontier),
        @"leadOutTraj":          @(c.leadOutTraj),
        // Recorded because it is the first knob whose ABSENCE would make a
        // replay differ from the device: the replay reads a missing
        // seedLeadTrim as OFF (every pack before v16 was painted untrimmed).
        @"seedLeadTrim":         @(c.seedLeadTrim),
        // The low-light registration gate — the mode and its six thresholds,
        // under the replay knob table's names, so a pack that ran an arm
        // replays under the same arm (`useMetaConfig`) instead of the twin
        // reading an absent key as OFF.  The ledger's cross block is the
        // OUTCOME; this is the REQUEST.
        @"crossResidualGate":    @(c.crossResidualGate),
        @"crossTextureMinVar":   @(c.crossTextureMinVar),
        @"crossPeakMinPSR":      @(c.crossPeakMinPSR),
        @"crossPeakMinMass":     @(c.crossPeakMinMass),
        @"crossPeriodGuard":     @(c.crossPeriodGuard),
        @"crossPeriodMaxFrac":   @(c.crossPeriodMaxFrac),
        @"crossPeakSecondaryFrac": @(c.crossPeakSecondaryFrac),
        @"exposureNormalize":    @(c.exposureNormalize),
        @"exposureGainClamp":    @(c.exposureGainClamp),
        @"photoMinSamples":      @(c.photoMinSamples),
        @"photoGradMaxDN":       @(c.photoGradMaxDN),
        @"photoUniformMinFrac":  @(c.photoUniformMinFrac),
        @"photoUniformBands":    @(c.photoUniformBands),
        @"photoLocalWindowPx":   @(c.photoLocalWindowPx),
        @"axisOverride":         @(c.axisOverride),
        @"signOverride":         @(c.signOverride),
        @"cropVertical":         @(c.cropVertical),
        @"outputRotationCwDeg":  @(c.outputRotationCwDeg),
        // v10 — the knobs.  What the gate DECIDED is a separate block
        // (`meta.lens`), because a request and a verdict are different facts.
        @"lensUndistort":        @(c.lensUndistort),
        @"lensDeviceModel":      [NSString stringWithUTF8String:c.lensDeviceModel.c_str()],
        @"lensDeviceLens":       [NSString stringWithUTF8String:c.lensDeviceLens.c_str()],
        @"lensFocalTolFrac":     @(c.lensFocalTolFrac),
        @"lensModelOverride":    @(c.lensModelOverride),
        @"lensK1":               jnum(c.lensK1),
        @"lensK2":               jnum(c.lensK2),
        @"lensLutNodes":         @(c.lensLutNodes),
        @"pack": @{
            @"packFrames":        @(p.packFramesMode),
            @"packFrameEveryN":   @(p.frameEveryN),
            @"packFrameQuality":  @(p.frameQuality),
            @"packMaxFrames":     @(p.maxFrames),
            @"canvasQuality":     @(p.canvasQuality),
            @"previewIntervalMs": @(p.previewIntervalMs),
            @"previewMaxDutyPct": @(p.previewMaxDutyPct),
            @"previewWindowAlongPx": @(p.previewWindowAlongPx),
            @"previewWindowCrossMult": @(p.previewWindowCrossMult),
            @"previewQuality":    @(p.previewQuality),
            @"previewCropPad":    @(p.previewCropPad),
            @"previewMaxAlong":   @(p.previewMaxAlong),
            @"previewMaxCross":   @(p.previewMaxCross),
            @"packQueueMax":      @(p.queueMax),
        },
    };
}

@end
