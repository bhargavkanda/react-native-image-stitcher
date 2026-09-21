// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano.hpp — pano+ slit-scan engine core.
//
// The device implementation of the pano+ slit-scan algorithm approved
// 2026-08-19: iOS-panorama-style video-rate strip
// painting, on the correct geometry for a shelf, with PER-FRAME ATTITUDE
// RECTIFICATION — the one input the offline replay proved the algorithm was
// missing (image-only registration cannot observe pitch/yaw at 1-frame
// baselines; the iPhone pano is straight because the gyro measures all three
// rotation DOFs in hardware).
//
// ── HAND-WRITTEN, NOT GENERATED ──────────────────────────────────────────
// This pair is hand-written code with no generated ancestor, and it is not
// produced or checked by any codegen step.
//
// ── Namespace ────────────────────────────────────────────────────────────
// `rnis::pano` — deliberately distinct from this package's own `rnis::`
// namespace, which the engine CALLS (`rnis::canvasExceedsGuard`, in
// rnis_pano.cpp).  Two namespaces rather than one so a host that links this
// package alongside other stitching code cannot collide on the generic type
// names both would want.
//
// ── OpenCV-free header ───────────────────────────────────────────────────
// `cv::Mat` appears only as a forward
// declaration so the ObjC++ session owner (ios/RNISPanoCore.mm) can include
// this without dragging OpenCV into any header that reaches the pod umbrella
// (which is compiled in pure Obj-C context).
//
// ── Threading ────────────────────────────────────────────────────────────
// NOT thread-safe.  One Engine instance is owned by exactly one serial
// queue; every method must be called from that queue.  The engine performs
// NO I/O, allocates only its canvas (bounded, see Config), and never throws
// across the API boundary (every entry point is wrapped).
//
// ── Coordinate contract (the single easiest thing to get backwards) ──────
//
//   ARKit `camera.transform`  : camera→world, GL convention (+X right,
//                               +Y UP, −Z forward).
//   ARKit `camera.intrinsics` : CV convention (+X right, +Y DOWN,
//                               +Z forward), expressed against the NATIVE
//                               sensor/landscape raster.
//   F = diag(1, −1, −1)       : the GL↔CV basis flip (F = F⁻¹).
//
//   R_i      = quat(FrameInput::q) → 3×3, world←cam_i, GL convention
//   ΔR_gl    = R_0ᵀ · R_i                  (cam_0 ← cam_i, GL)
//   ΔR_cv    = F · ΔR_gl · F               (cam_0 ← cam_i, CV)
//   H_rect   = K_0 · ΔR_cv · K_i⁻¹         (frame i px → reference-orientation px)
//
// Every frame uses ITS OWN K_i (per-frame intrinsics — NEVER hardcoded, the
// standing repo rule); K_0 is the reference frame's own K.  Everything stays
// in the AR sensor/landscape raster the intrinsics are expressed against and
// is NEVER rotated mid-pipeline (the standing orientation trap: takePhoto
// bakes rotation while the intrinsics stay unoriented).  Output orientation is applied ONCE,
// at finalCanvas().
//
// ⚠ THAT LAST SENTENCE WAS FALSE UNTIL v14, AND ITS FALSENESS IS WHY THE
// DELIVERABLE CAME OUT SIDEWAYS ON HALF THE HOLDS.  `finalCanvas()` applied
// the AXIS/SIGN bake — an exact undo of `axisMatrix`, which lands in the
// camera RASTER frame — and no device-orientation term at all.  Both
// platforms deferred that term to someone else (Android's recorder to "the
// offline pass", iOS's AVF source to this very line) and neither destination
// ever implemented it.  `Config::outputRotationCwDeg` IS that term, applied in
// `renderOriented()` exactly once, and the sentence above now holds.
//
// ── The algorithm, as implemented ────────────────────────────────────────
//  1. RECTIFY   — H_rect per frame (identity under Config::rectify == false,
//                 which is the operator's A/B hypothesis arm).
//  2. ADVANCE   — cv::phaseCorrelate on a small work-scale GRAY window
//                 warped through H_rect, window-origin-compensated so it
//                 tracks the frame as the attitude drifts away from R_0.
//  3. AXIS LATCH— dominant sweep axis + sign latched from the TOTAL placement
//                 (attitude + residual — where the paint transform actually
//                 puts the frame) once it has moved decisively; never from the
//                 rectification RESIDUAL alone, which is ≈ −(attitude) on a
//                 pivot and votes the sweep backwards, and never from the
//                 ATTITUDE alone, which is perpendicular to a shelf walk.  The
//                 engine then works in a MONOTONE-INCREASING coordinate u.
//                 The decision is RE-CHECKED against the sweep it produces and
//                 corrected if the canvas is not growing (Config's relatch
//                 block) — short-horizon evidence cannot separate a rising
//                 transient from a sweep, so the latch verifies instead of
//                 guessing harder.
//  4. STRIP     — width = |Δu since last PAINTED frame| × stripMargin.
//                 |Δu| ≤ minAdvancePx ⇒ ledgered skip (hold).
//  5. HIGH-WATER— paint ONLY [highWater, rightEdge).  The left clip to the
//                 frontier IS the single-owner guarantee: exactly one frame
//                 owns each column, and painted width per frame == advance,
//                 so there is neither duplication nor a gap by construction.
//                 rightEdge ≤ highWater ⇒ HeldBacktrack (paint nothing).
//  6. GAIN      — chained exposure match measured on the strip's OVERLAP
//                 with already-painted canvas (a widened sample window, not
//                 the sub-pixel strip overlap), rate-limited and clamped.
//  7. COMMIT    — hard REPLACE through the frame's own warp mask.  No
//                 accumulate, no feather, no blend (the v0 ghost defect).
//  8. BACKFILL  — a frame whose footprint no longer reaches the frontier
//                 would leave an interior hole.  Before declaring GapBreak
//                 the engine paints the missing columns from the PREVIOUS
//                 painted frame, which did see them (Config::backfillGaps).
//                 A hole is only reported when even that frame cannot reach.
//
// ── Memory, stated honestly ──────────────────────────────────────────────
// TWO full-canvas allocations, not one: `canvas` (CV_8UC3) and `coverage`
// (CV_8UC1) — 4 bytes per canvas pixel in total.  The canvas grows by
// doubling along the sweep axis (canvasInitWidthPx → canvasMaxWidthPx) AND,
// when Config::canvasGrowVertical is on, in 128 px steps along the
// perpendicular axis up to canvasMaxHeightPx.  Both dimensions are further
// bounded by canvasMaxPixels, which is the number that actually caps memory:
//
//   steady peak ≈ canvasMaxPixels × 4 bytes            (18 MP ⇒ ~72 MB)
//   transient   ≈ steady × ~1.75 during a growth       (18 MP ⇒ ~126 MB)
//
// (the growth path releases the old canvas before allocating the new
// coverage, so the transient is 2×canvas + 1×coverage, not 2× of both).
// On top of that the engine retains ONE shallow reference to the last
// painted frame (for the tail flush and the backfill).  Columns behind the
// frontier are immutable, so a longer sweep costs width, not per-column
// state.  The session owner's ring and pack queue are NOT counted here —
// see ios/RNISPanoCore.mm.

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace cv { class Mat; }

namespace rnis {
namespace pano {

// Bump on ANY behavioural change to the engine.  Written into every pack's
// meta.json so a pack is self-describing and the offline replay twin can
// refuse to compare across engine versions.
// v2 (2026-08-19, first-cut review pass): perpendicular canvas growth +
//     explicit vertical-clip reporting; interior-gap BACKFILL from the
//     previous painted frame; ARKit `.limited` no longer aborts; the
//     correlation window is clamped into the rectified footprint; the
//     attitude-excursion gate now applies to BOTH A/B arms.
// v3 (2026-08-20, first device pack): the AXIS/SIGN LATCH no longer votes on
//     Σ(advance).  `advance` is the post-rectification RESIDUAL, which for a
//     rotation-dominant sweep is ≈ −(attitude step) — so on the operator's
//     first pack the latch chose sweepSign −1 for a sweep running +1 and the
//     high-water rule correctly refused to paint 71.8% of the frames.  The
//     latch now reads the two channels the placement is actually made of (the
//     ATTITUDE excursion and the TOTAL position) and waits for decisive
//     MOTION rather than a fixed frame count.  Also: cv::phaseCorrelate
//     multiplies BOTH its inputs by the window IN PLACE when the size needs
//     no DFT padding (192×144 does not), and the engine stored that mutated
//     buffer as `prevWinF` — every correlation after the first compared
//     Hann²·prev against Hann¹·cur.  It is handed copies now.  New ledger /
//     stats fields name the regime (rotation vs translation) per frame and
//     per session, so the NEXT pack states what it was instead of us
//     inferring it.
// v4 (2026-08-20, two adversarial reviews of v3 — NEVER SHIPPED TO A DEVICE):
//     v3 fixed the PIVOT regime and broke the WALK regime the same way.  Its
//     rotation fast path gated on ‖rotation‖∞ > ‖residual‖∞ — ∞-norms of two
//     vectors that need not be parallel — so a shelf walk carrying incidental
//     pitch latched the axis ACROSS the sweep (21 of 45 measured gestures: a
//     one-frame canvas).  And a walk carrying a TRANSIENT tilt latched on the
//     wobble, which disabling the rotation channel did NOT fix — over a short
//     horizon a rising transient and a real sweep are the same signal, so no
//     threshold can separate them at the moment of the vote.
//     So: (a) the rotation fast path is REMOVED, not repaired — the latch
//     votes on the TOTAL alone, and removing the channel costs nothing
//     measurable (every pivot fixture keeps a byte-identical paintedW);
//     (b) the latch is no longer IRREVERSIBLE — it re-checks its decision
//     against the sweep it produces and restarts the canvas on a corrected
//     axis/sign when the panorama is not growing (see Config's relatch block).
//     Also: the advanceTot == advanceRot + advance identity is now
//     unconditional; `chainAdvanced` marks the rows that are safe to sum; the
//     cage bounds the TOTAL step, not only the residual; cropVertical's
//     decline bar is measured against the frame footprint rather than canvasH
//     (which grows with the sweep); a session that ends before the latch still
//     produces a canvas instead of no output object at all.
// v5 (2026-08-20, the operator REJECTED v4's output quality — "wobble,
//     warping and cuts ... not the production quality that is expected" —
//     while v4's own integrity verdict called all four packs CLEAN.  That
//     blind verdict is treated here as a first-class defect, the same class
//     as the vertical-clipping blind spot v2 fixed):
//
//     (a) SWEEP-REFERENCED RECTIFICATION.  v4 rectifies every frame into
//         FRAME 0's IMAGE PLANE, so the canvas is gnomonic and its area
//         magnification is sec³θ with θ measured from the reference optical
//         axis — unbounded as the sweep grows.  Measured on the operator's
//         pivot pack (15-59-29, 30.5° excursion): worst magnification 13.0×,
//         which is the giant stretched floor trapezoid he marked.  v5 splits
//         the excursion into the component ABOUT THE LATCHED SWEEP AXIS —
//         carried as ARC LENGTH f·ψ, i.e. CYLINDRICAL — and everything else,
//         still carried by the tangent-plane homography, i.e. RECTILINEAR
//         ACROSS the sweep so bay uprights stay straight.  There is no regime
//         selector and no threshold: ψ ≡ 0 on a pure walk, and v5 is then
//         BYTE-IDENTICAL to v4 (verified on all four device packs: max
//         |Δpos| = 0.000e+00, identical outcome sequence, identical
//         paintedW).  Measured effect: worst magnification 13.02 → 2.44 on
//         the pivot pack and 5.2-5.5 → 2.45 on the three walk packs — below
//         the 2.45 a single photo from this camera already has at its corner.
//         The arc is folded INTO H_rect rather than added to the placement
//         afterwards, which is load-bearing: the correlation window, the
//         footprint bounds and the strip geometry all derive from that one
//         matrix, so a pure sweep leaves world content STATIONARY in the
//         registration raster.  Adding the arc afterwards makes the
//         correlation re-measure the sweep the pose already supplied and the
//         panorama is painted at 2× the true advance (measured: duplicated
//         shelf objects on 15-59-29).
//
//     (b) CROSS-SWEEP PLACEMENT.  v4 fits ONE translation in a 384 px window
//         — 20% of the cross extent — and extrapolates it across the other
//         80%.  The two strips then meet correctly in the middle and diverge
//         at the edges, which IS the visible cut.  v5 measures K windows
//         spread across the sweep and gives the placement one extra degree of
//         freedom: a cross-sweep SCALE, driven by the operator's own
//         suggestion — a virtual plane at Config::subjectDistanceM, whose
//         magnification the ARKit pose predicts as exp(−forward/d).  The
//         image fits only the scalar d (online, clamped).  A per-frame
//         image-fitted gradient was built and MEASURED FIRST and is NOT the
//         default: it scores better on its own residual (that residual is its
//         own fit) while a sign error in its cage sheared the canvas, and a
//         gate that scores a model against its own fit is the blind verdict
//         this version exists to remove.  Config::crossFitMode = 1 keeps it
//         for the A/B.
//
//     (c) THE CUT METRIC.  Per strip boundary, the per-band disagreement
//         between what the K windows MEASURED and what the placement APPLIED
//         — in the frame's own rectified coordinates, so it is immune to the
//         canvas vertical-growth re-base by construction rather than by
//         subtracting vShiftPx afterwards.  Plus the photometric DC step at
//         the seam, measured on the CANVAS (the gain is fitted on a sample
//         window and applied to different content, so a gain that matches its
//         own sample exactly can still commit a visible step).  p50/p95/max
//         into stats and meta, and folded into the integrity verdict:
//         `integrityFailed` is true on ALL FOUR of the operator's v4 packs
//         and on one of the four v5 replays — the one that still carries a
//         real parallax cut.
//
//     Also: the excursion gate now bounds the CROSS excursion (what the
//     homography actually carries) with the sweep bounded separately by
//     sweepMaxDeg, so v5 paints pivots v4 structurally refused; and
//     Config::gainLeak is built, measured and left OFF pending the operator's
//     approval — the chained exposure walks monotonically to 0.72-0.76 over
//     every one of the four packs (a 24-28% end-to-end darkening, same sign
//     every time, i.e. a biased estimator rather than noise).
// v6 (2026-08-21, the operator REJECTED v5's output a SECOND time — "banding"
//     and "wobble".  The offline owner-map instrumentation settled the
//     mechanism rather than theorising about it, and every number below is
//     measured on his own four packs:
//
//     (a) THE BANDING IS NOT A SEAM, IT IS THE GAIN CHAIN.  Auto-exposure runs
//         unlocked for the whole sweep — measured on registered low-gradient
//         overlap, the camera brightens by 50-79% end to end (C = 1.50-1.79).
//         The chained overlap-gain estimator removes only 24-29% of that
//         (gainCum ends 0.71-0.76), so a 7-33% brightness ramp is STAMPED into
//         every deliverable — and, worse, the chain is an UNANCHORED
//         multiplicative accumulator whose ±1-3% per-strip estimator noise
//         INTEGRATES: peak-to-peak of the stamped gain field over a 40-column
//         window reaches 24.4 / 14.0 / 10.4 / 10.8% on the four packs, located
//         at exactly the display rows the operator circled.  Decomposed at
//         every strip boundary over the whole shared footprint, the camera
//         step is 0.00 DN at the median and the ENGINE's gain term is what
//         commits the visible step (+3.92 / +4.34 / −4.28 / −3.90 DN at the
//         four worst boundaries on 15-58-22, uniformity 0.93-0.95 — a genuine
//         uniform DC step, not misregistration noise).
//         So v6: (1) the CAPTURE side locks AE / white balance / focus for the
//         sweep (ios/RNISPanoCameraLock.swift — standard panorama practice and
//         what the operator's own iPhone does); (2) the ENGINE normalises each
//         frame to the reference frame's exposure EXACTLY, from per-frame
//         `exposureDurationS × exposureISO`, before any overlap fit runs; and
//         (3) the overlap fit is demoted to a BOUNDED RESIDUAL corrector by
//         turning Config::gainLeak on — it was built, measured and left off in
//         v5, and it is exactly the mean-reversion that turns a random walk
//         into an AR(1) that cannot integrate.
//
//     (b) THE SEAM GATE WAS BLIND TO IT.  v5's seamLumaStepDN compares ONE
//         canvas column against ONE column — quantisation-limited at ±1 DN —
//         and was REPORTED but never folded into integrityReason, so pack
//         15-58-22 verdicted "clean" with a visible band in it.  That is the
//         FOURTH time a pano+ gate passed output the operator rejected.  v6
//         adds a PHOTOMETRIC seam metric measured over the whole shared
//         footprint of the two owners (the slab of canvas the incoming warp
//         covers and the high-water clip discards — real overlapping content,
//         the same construction the committed-pixel jog uses), with a
//         UNIFORMITY test so a real scene edge cannot fire it, PLUS a
//         local-excursion metric over the applied photometric field which is
//         the only instrument that can see a band a per-boundary step cannot.
//         Both are folded into integrityFailed.
//
//     (c) THE SINGLE-FRAME BLOCKS.  55-69% of every deliverable is TWO
//         single-frame regions: the bootstrap lead-in behind the frontier
//         (24-29%, painted at gain exactly 1.0) and the finalize tail flush
//         (29-48%, painted at one frozen gain).  Only 40-44% is actually
//         swept.  They are not a seam defect — their own boundaries commit
//         +0.07 / −1.11 / −2.00 DN — but they mean a third of the image
//         carries the reference frame's photometry with the whole chain hung
//         off it, so the exposure normalisation is applied to them by the SAME
//         rule as the sweep (the tail flush and the interior backfill now
//         carry their source frame's own exposure gain, not the frame the
//         chain happened to end on).
//
//     Scope, stated honestly: the four existing packs carry NO exposure
//     metadata (track.jsonl has no duration/ISO on that path), so replaying
//     them exercises (3), (b) and (c) but NOT the normalisation itself, which
//     is identity without metadata — and BYTE-IDENTICAL to v5 when it is.
//
// v7 — THE LIVE PREVIEW IS VISIBLE (2026-08-23).  Not a pixel of the canvas
//     changes; what changes is what the operator can SEE while sweeping, which
//     he reported he could not: "I do not see a live preview of the image
//     growing as I take the capture".
//
//     `previewIntoFit` takes the fit box in SWEEP terms (along x cross) and
//     turns it with the latched axis, because `previewInto`'s box is in
//     ORIENTED terms and its shipped caller passed a LANDSCAPE 1400x220.  All
//     four device packs are VERTICAL sweeps (axis 1, 1344x1471 output), so the
//     fit collapsed to 0.15 and rendered a 201x220 thumbnail that got SMALLER
//     as the panorama got longer.  The host's box moved with it (1400x360 in
//     sweep terms), and `meta.json` now echoes `previewMaxAlong` /
//     `previewMaxCross` in place of `previewMaxW` / `previewMaxH` — the old
//     keys are still ACCEPTED on the way in.
//
//     A REPLAY IS UNAFFECTED: the preview path is not part of ingest, and this
//     version bump exists so a pack states which host geometry produced its
//     preview, not because a canvas differs.
// v8 — THE WOBBLE IS NOT FIXED, AND THE PACK NOW SAYS THE THINGS THAT WOULD
//     SETTLE IT (2026-08-23).  The operator asked for "the solution to solve
//     the wobble problem"; the honest answer this version ships is a measured
//     NO for the candidate that was designed for it, plus the instrumentation
//     that stops the next candidate being judged the way this one nearly was.
//
//     (a) POSE ANCHORING WAS BUILT, A/B'd ON ALL FOUR PACKS, AND IS NOT HERE.
//         The theory was sound and half of it is confirmed: placing every
//         frame from the ARKit pose (R, t) plus a scene plane at distance d,
//         with the image correlation demoted to a bounded residual, DOES pull
//         the random-walk exponent down — slope −0.37 / −0.20 / −0.03 / −0.01
//         on the four packs, the biggest win on the ramp outlier nothing else
//         explained.  It does NOT reduce the amplitude the operator can see
//         (rms worse on 2 of 4), it makes the seam WORSE on 4 of 4
//         (seamWorstBand p95 ×1.07-1.92; on 15-59-29 the slat wall carries a
//         visible lateral step the shipped arm does not), and it is limited by
//         a d that is not estimable to the accuracy it needs — the oracle
//         sweep costs 60% of the win for a 7% error in d, and the best of 18
//         estimators tried is 27% off on one pack.  Even with a hand-picked
//         per-pack d it is 3 wins and one loss, and on the best of the four
//         packs no plane distance beats the chain at all.  REFUTED ALONG THE
//         WAY: ARKit position noise is NOT the limit — measured 0.10-0.16 mm
//         p50, i.e. 0.05-0.07 canvas px against a 0.5-0.9 px defect.  The pose
//         is an order of magnitude cleaner than the wobble; the PLANE MODEL is
//         what fails.  Reopen it with a MEASURED d (ARKit sceneDepth, or an
//         operator-set standoff), not a fitted one.  The full arm, its
//         ledgered OFF/ACTIVE/HELD fallback and its identity tests live in the
//         offline twin; nothing in this
//         engine changed for it.
//
//     (b) MULTI-WINDOW CHAIN AVERAGING — the candidate the wobble hunt turned
//         up — IS here, BUILT and DEFAULT OFF, and the reason it is off is the
//         reason this version exists.  It looked like a free 22-35% seam
//         improvement on 4 of 4 packs.  It is scored on `seamWorstBand`, which
//         is the residual of the very measurements it averages: a
//         least-squares centre must win on its own residual.  Re-measured on
//         the one seam instrument that cannot be fitted — `seamCanvasJogPx`,
//         committed pixels through the painting matrix — it is two packs
//         worse, one flat, one better.  See Config::crossAvgWindows for the
//         table.  The engine now carries SessionStats::seamBandSelfScored and
//         the integrity verdict SAYS SO IN WORDS whenever the flag is on, so
//         the band p95 can never again be quoted as independent evidence for
//         the thing that produced it.
//
//     (c) WHAT THE PACK NOW REPORTS, so the next capture argues with data.
//         `seamJogDriftPx` — the running sum of the SIGNED committed-pixel
//         jog, i.e. how far the panorama has WALKED, which no percentile can
//         reach (the sign used to be destroyed by a `fabs` at the point of
//         measurement).  Validated against the slat-wall ruler and REPORTED,
//         NEVER GATED, with its scope on the field itself.
//         `crossBandDivergencePx` is relabelled CROSS-SWEEP SHEAR: it was
//         called "the wobble" through v5-v7 and it is not — it is identical to
//         three figures in every placement arm of the anchor A/B while the
//         ruler on the same canvases moved by up to 40%, because the rigid
//         cross placement is common to every band and cancels in the max−min.
//         `seamPhotoStepOverBar` — how many boundaries breached the 3.00 DN
//         max bar, not merely that one did, because the operator said "I am
//         not sure I see the banding issue you are talking about" and one
//         anomalous boundary out of six hundred fired that clause exactly as
//         loudly as an end-to-end band.
//
//     No canvas pixel changes under the shipped defaults; a v7 replay of any
//     pack is byte-identical.
//
// v9 (2026-08-23) — THE PREVIEW THE OPERATOR COULD NOT SEE, and two v8
//     corrections found by review rather than by testing.
//
//     (a) THE LIVE PREVIEW BOX. `previewMaxCross` 360 → 800 and
//         `previewMaxAlong` 1400 → 2000. v7 turned the fit box with the sweep
//         and left the CAP where a 220-px letterbox had put it; the host now
//         sizes the on-screen panel in the OPERATOR'S frame (the app is
//         portrait-locked, so the framebuffer's "width" is 390 pt however the
//         phone is held), which puts a 259x283 pt panorama on his screen —
//         777x849 device px at @3x, i.e. a 2.2x upscale of a 360-px source.
//         The resize is INTER_AREA over the painted band, so its cost tracks
//         the SOURCE and not this box, and the JPEG encode runs on the pack
//         queue; meta.json's previewMs (p50 5.9 / p99 8.05 / max 9.39 ms at
//         the old box) is the check, and is a DEVICE-VERIFY point.
//
//     (b) THE SELF-SCORED NOTE WAS A FAILURE CLAUSE. v8 appended it to `why`,
//         and `integrityFailed = !why.empty()` turned it into a verdict — so
//         every sweep with `crossAvgWindows` on read FAILED whatever its
//         pixels said, pinning one arm of the A/B the knob exists for and
//         flipping the live HUD to CUTS on the arm with the LOWEST band
//         number. Four separate comments all asserted it was not gated. It is now appended to
//         `integrityReason` AFTER the verdict, marked `NOTE `, and the test
//         checks the verdict mechanically instead of trusting the comments.
//
//     (c) A WITHDRAWN NUMBER. Config::crossAvgWindows dismissed the arm's
//         wobble effect as "inside the metric's own scatter (split-half of an
//         UNCHANGED capture moves rms by 1.13-3.53×)". No script or artefact
//         produces that figure and the twin has no split-half mode; it is
//         withdrawn there and here. Nothing rested on it — the seam table is
//         deterministic and ledger-derived — but the ANCHOR's wobble tables
//         were read against it too, so those are now labelled supporting
//         evidence with no scatter estimate attached, and the anchor refusal
//         is stated as resting on the seam table (0 of 4 down, ×1.07-1.92).
//         Related correction: "the exponent falls on 4 of 4" is true of the
//         λ=1.0 arm ONLY — pure pose dead-reckoning with the image residual
//         discarded. The bounded-residual arms the brief actually proposed are
//         3/4 (λ=0.30) and 1/4 (λ=0.10).
//
//     Under the shipped defaults the only behavioural delta in (b) and (c) is
//     comment text; `integrityReason` is byte-identical with crossAvgWindows
//     off, which is every shipped pack. (a) changes the PREVIEW JPEG only —
//     never a canvas pixel, never a ledger row.
// v10 (2026-08-25) — LENS UNDISTORTION, folded into the painter's own
//     homography sampling as a 1-D radius→scale LUT, gated on the device model
//     AND the active lens/focal, falling back to NO correction on anything the
//     table does not cover.  A GEOMETRIC-FIDELITY change, not a wobble fix.
//     Behavioural on the calibrated body only; byte-identical everywhere else.
// v12 (2026-08-31) — THE PREVIEW STOPS LYING, three ways.  (1) A PROVISIONAL
//     LEAD-OUT: the region between the commit frontier and the live frame's
//     leading edge — half the along-sweep field of view, which the operator is
//     LOOKING AT but which no strip has committed — is warped into the PREVIEW
//     ONLY, dimmed so it reads as provisional.  The deliverable is untouched
//     (`leadOut` defaults false; every pre-existing caller and test is
//     byte-identical).  (2) `finalCanvas` learns the same pad-row trim the
//     preview already had, so the finished canvas and the last preview agree
//     on aspect instead of differing by the two unpainted 128 px pads.
//     (3) The host republishes one final preview AFTER finish(), so the last
//     thing on screen IS the deliverable (the tail flush used to paint 24-30%
//     of the canvas after the last publish).  (2) changes deliverable DIMS
//     when the host asks for it — hence the version bump.
// v13 (2026-08-31) — THE JOG GUARD (the one of three proposed mechanisms
//     that survived review): pre-commit canvas-jog measurement with a
//     bounded fail-closed refusal.  Default OFF = byte-identical; the
//     instrumented internal baseline ships it ON.  The junction re-anchor
//     and innovation slew are deliberately NOT here — the review that
//     rejected them recorded why a step re-base moves error rather than
//     removing it.
// v14 (2026-09-02) — THE UPRIGHT BAKE.  The deliverable finally leaves the
//     camera raster frame.  Operator: "the output image is sideways" —
//     reproduced on his own packs that day, where four `hold: "landscape"`
//     sweeps come out upright and the one `hold: "portrait"` sweep comes out a
//     quarter turn over.  The cause was a MISSING step: the whole pipeline is
//     deliberately raster-referenced (rotating at ingest is the standing
//     orientation trap), and the raster -> world turn that Android's recorder
//     deferred to "the offline pass" and iOS's AVF source deferred to
//     `finalCanvas()` was never written in either place.  `outputRotationCwDeg`
//     is that turn, baked ONCE in `renderOriented()` as an exact
//     transpose/flip.  DEFAULT 0 = byte-identical to v13, and the version bump
//     is because a host that sets it gets different deliverable PIXELS AND DIMS
//     — the same reason v12 bumped.  The live preview is deliberately NOT baked
//     (the SDK's display chain already performs the identical turn); the ledger,
//     `unpaintedRuns`, `verticalEnvelope` and `PreviewWindow` stay canvas-frame
//     and `SessionStats::outputRotationCwDeg` publishes the mapping.
// v15 (2026-09-04) — THE ULTRA-WIDE ROW BECOMES REACHABLE.  `lens::resolve()`
//     matched calibration rows on the device BODY alone and `break`ed on the
//     first hit.  With two rows for one body — wide first, ultra-wide second —
//     an iPhone17,1 ALWAYS selected the wide row, and the ultra-wide name then
//     disagreed with it and returned LensMismatch.  So the v13 ultra-wide fit
//     (2026-08-31, clean_fit.json) was DEAD CODE from the day it shipped, and
//     every 0.5x sweep ran with no distortion correction at all — on the lens
//     that needs it most.  Test-14 pano+ pack 23-00-43 is the proof: k1=k2=0,
//     correctedStrips=0, and `expectedFxOverWidth` stamped 0.6952 (the WIDE
//     row's number) against ultra-wide frames measuring 0.4056.  The lens is
//     now part of the selection KEY rather than a check applied to whatever row
//     the body matched first.
//     THE BUMP IS BECAUSE 0.5x SWEEPS GET DIFFERENT PIXELS — they gain the
//     correction they were always supposed to have (peak corner move 19.1 px).
//     Wide and unnamed-lens (ARKit) sweeps are BYTE-IDENTICAL to v14: an
//     unnamed lens still takes the body's first row, which is the wide row,
//     which is the camera ARKit streams.  An unnamed lens is not an error and
//     must not become one — every ARKit pack in the corpus depends on it.
constexpr int kEngineVersion = 15;

/// How far a frame timestamp may run BACKWARDS before the engine treats it as a
/// new session timebase rather than a delivery hiccup.  0.25 s is ~15 frames at
/// 60 Hz: far beyond any plausible reordering (which is sub-frame), and far
/// below the discontinuity an `arSession.run` re-seed produces.  Nothing real
/// lands near this bound, which is the point — it separates two populations,
/// it does not tune between them.  See the skip/abort split in `ingestFrame`.
constexpr int64_t kTimebaseResetNs = 250'000'000;

// ── v11: THE TWO NAMED BARS FOR THE SUBJECT-DISTANCE FIT DIAGNOSTIC ─────────
//
// NOT ENGINE VERSION 11.  v11 adds no behaviour: it publishes the online
// subject-distance regression's own internals and ARKit's own per-frame
// exposure, and touches neither the placement, the gain chain nor the
// integrity verdict.  `kEngineVersion` therefore stays at 10 on purpose —
// bumping it would tell every offline reader that the pixels changed, and
// they did not.  (Verified: canvas and ledger byte-identical, PanoV11.*
// parity tests.)
//
// `kSubjectDistanceFitLeverBar` — the fraction of PERPENDICULAR travel that
// FORWARD travel must reach before the regression has anything to regress
// ON.  Measured on the three Test-13 field packs: 1.0% / 11.2% / 5.1%, with
// fits of 1.95 / 6.00 / 5.87 m against a standoff of 0.6-1.0 m.  0.20 sits
// well above all three and well below a genuine dolly-in, and it is a
// DIAGNOSTIC bar — it colours a pack field and nothing else.  It was chosen
// to separate the observed failures from a healthy sweep, not tuned to a
// target pass rate; a sweep between 11% and 20% will be flagged, which is
// the conservative direction for a report that exists to stop a silent
// 7.5×-wrong number.
constexpr double kSubjectDistanceFitLeverBar = 0.20;
// The perpendicular travel the ratio needs before it means anything.  Under
// this, the sweep barely moved at all and "forward travel is a small
// fraction of it" is arithmetic noise, not a finding.  1 cm.
constexpr double kSubjectDistanceFitPerpFloorM = 0.01;

/// The sub-pixel displacement estimator, exposed so the host tests can pin it
/// directly instead of only through a whole sweep.  Defined in rnis_pano.cpp.
namespace detail {
/// Odd centroid support in WORK px for a given work scale — the rule that
/// keeps the support spanning ~10 SOURCE px.  0.5 -> 5 (cv::phaseCorrelate's
/// own), 0.75 -> 7, 1.0 -> 9.
int centroidBoxFor(double workScale);
/// Phase correlation with an explicit centroid support.  `outXY` receives
/// (dx, dy) in the SAME sign convention cv::phaseCorrelate uses; `*response`
/// is always the 5x5 sum, so the aliasing cage's response gates never move
/// with `box`.
/// Declared with plain doubles because this header stays OpenCV-free apart
/// from the forward-declared cv::Mat.
void phaseShiftBoxXY(const cv::Mat& a, const cv::Mat& b, const cv::Mat& hann,
                     int box, double* outXY, double* response);
/// Trajectory continuation (Config::crossTraj): may a fitted fan `fan` (per
/// cross px) be carried over a block of `spanPx` canvas px?  The slice map
/// scales the cross axis by 1 / (1 − fan·Δu), so the far end is magnified by
/// 1 / (1 − fan·L) — a pole at Δu = 1/fan.  Accepted iff |fan|·L ≤ 0.3, i.e.
/// the far end is scaled by no more than 1.43x (or 0.77x).  With `relaxPx` >
/// 0 (Config::crossTrajRelaxPx) the fan decays as exp(−Δu/L_r) and its reach
/// is L_r·(1 − e^(−L/L_r)), which is what L becomes.  A non-positive span
/// accepts nothing but a zero fan.  Exposed so the rule is pinned directly.
bool crossTrajFanWithinSpan(double fan, double spanPx, double relaxPx);
/// Low-light registration gate statistics (Config::crossResidualGate), each
/// exposed so it can be pinned directly.  All take the CV_32F work-scale
/// window(s) the centre correlation used and return NaN when the input is
/// empty or carries no signal — the caller ledgers that as null.
///
/// Texture energy: variance of the 3x3 Laplacian over the whole window.
double laplacianVariance(const cv::Mat& winF);
/// Dominant spatial period of the window's mean profile along columns
/// (`alongX`) or rows, in the window's own px: argmax of the 1-D power
/// spectrum with DC and periods longer than half the profile excluded.
double dominantPeriodPx(const cv::Mat& winF, bool alongX);
/// Peak shape of the whitened cross-power surface of (a, b) — the same
/// surface phaseShiftBoxXY walks, built by the same code.  `box` is the odd
/// centroid support (work px); `crossIsX` names the cross axis on the
/// surface; `exclusionHalfPx` is half the dominant period (0 ⇒ the centroid
/// box alone).  `out[0]` = PSR, `out[1]` = |mass| inside the box over the
/// whole surface's |mass|, `out[2]` = the largest value outside the
/// one-period-wide band centred on the primary, over the primary.
void phasePeakStats(const cv::Mat& a, const cv::Mat& b, const cv::Mat& hann,
                    int box, bool crossIsX, double exclusionHalfPx, double* out);
}  // namespace detail

// ── PUBLISHING THE LIVE PREVIEW, ATOMICALLY ─────────────────────────────────
//
// THE BUG THIS FUNCTION EXISTS TO MAKE IMPOSSIBLE.  Pinned here because it
// ran for the whole life of the feature and no suite on either side of it
// went red.
//
// The live preview reached the operator's phone ZERO times, across all eight
// pano+ device packs on the bench (2026-08-19, 2026-08-20, 2026-08-29).  The
// engine RENDERED ~30 previews per sweep — `previewMs` proves it, p50 one
// timer tick for the pre-latch early returns and max 9.75 ms for the real
// INTER_AREA resizes.  The ObjC++ publisher wrote none of them.  It published
// atomically like this:
//
//     NSString *tmp = [previewPath stringByAppendingPathExtension:@"tmp"];
//     std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, 60};
//     try {
//         if (cv::imwrite(tmp.UTF8String, previewMat, params)
//             && rename(tmp.UTF8String, previewPath.UTF8String) == 0) { … }
//     } catch (const cv::Exception&) {}
//
// `cv::imwrite` chooses its encoder FROM THE DESTINATION FILE'S EXTENSION.
// "preview.jpg.tmp" has no encoder, so imwrite does not return false — it
// THROWS cv::Exception("could not find a writer for the specified
// extension"), and the empty catch two lines below swallowed it on every tick
// of every sweep.  `previewPublishedSeq` therefore never left 0, JS refused to
// build an <Image> source for seq 0, and the operator watched an empty panel
// while a perfectly good status channel updated the HUD beside it.
//
// The atomic-publish idiom and OpenCV's extension-sniffing API are DIRECTLY
// INCOMPATIBLE, and nothing in either type system says so.  So the encode no
// longer depends on the destination's name: `cv::imencode` takes the format as
// an EXPLICIT literal, the bytes reach the temp path through stdio (which has
// no opinion about extensions), and the rename publishes them.  A destination
// called `preview.jpg`, `preview.tmp` or `preview` now behaves identically.
//
// IT LIVES IN THE ENGINE'S TRANSLATION UNIT, NOT THE BRIDGE'S, for the second
// half of the lesson.  The C++ host suite covers `previewIntoFit` thoroughly
// (PanoPreview.*, green through every run that missed this) and the SDK suite
// covers the JS contract (106 tests, also green) — and the defect sat in the
// ObjC++ seam between them, which neither can reach.  Anything that CAN be
// tested belongs on this side of that seam.
//
// Returns false and fills `*err` (when non-null) with a specific reason on
// every failure path: an empty image, an encode that produces no bytes, a temp
// file that cannot be opened or fully written, a rename that fails.  It NEVER
// throws — a cv::Exception becomes `*err` text.  Callers are expected to
// SURFACE that text, not swallow it; silence is what let this run undetected.
bool publishJpegAtomically(const std::string& path, const cv::Mat& img,
                           int quality, std::string* err);

// ── Per-frame outcome ───────────────────────────────────────────────────────
// EVERY ingested frame produces exactly one of these, and every one of them
// becomes a ledger row.  Holds, skips and rejections are data — the residual
// evaluation gate is answered from this enum's distribution.
enum class Outcome : int32_t {
    Painted             = 0,   // a strip was committed
    HeldBacktrack       = 1,   // the sweep REVERSED — nothing painted, no duplication
    SkippedNoAdvance    = 2,   // |Δu| ≤ minAdvancePx (hold)
    RejectedLowResponse = 3,   // phase-correlation peak too weak — chain NOT advanced
    RejectedOutOfCage   = 4,   // |advance| > maxAdvancePx (aliasing cage) — chain NOT advanced
    WarmingUp           = 5,   // tracking not yet normal for trackingWarmupFrames
    Bootstrap           = 6,   // reference latch / axis latch / the lead-in paint
    GapExtended         = 7,   // strip extended leftward to the frontier (gap avoided)
    GapBreak            = 8,   // frame could not reach back to the frontier — interior hole
    AbortedTracking     = 9,   // session abandoned (see SessionStats::abortReason)
    CanvasFull          = 10,  // sweep exceeded canvasMaxWidthPx — visible stop
    RejectedRectify     = 11,  // rectified footprint degenerate / beyond rectifyYawLimitDeg
    RejectedInput       = 12,  // malformed frame (dims/intrinsics/pixels)
    TailFlush           = 13,  // finalize-time lead-out paint from the last painted frame
    HeldFrontier        = 14,  // moving forward, but the frontier is still ahead
                               // of this frame's strip (a transient lead, NOT a
                               // reversal — the two must not be conflated in the
                               // residual analysis)
    RejectedPoseSpeed   = 15,  // the POSE says the camera lurched faster than
                               // maxSweepSpeedMps — the image chain cannot be
                               // trusted at that step, so the chain is held
    RejectedTracking    = 16,  // ARKit tracking is notAvailable: the attitude
                               // is meaningless, so the chain is HELD.  A run
                               // longer than maxRejectRunFrames aborts.
                               // NOTE `.limited` is NOT this — see
                               // Config::abortOnLimitedTracking.
    GapBackfilled       = 17,  // the frame could not reach the frontier, but
                               // the PREVIOUS painted frame could: the missing
                               // columns were painted from its pixels, so no
                               // hole was left (algorithm step 8)
    JogHeld             = 18,  // v13: the pre-commit canvas jog
                               // exceeded d8JogBarPx and the strip was REFUSED
                               // (fail-closed, run-capped).  Distinct from
                               // HeldFrontier so a pack can tell a guard
                               // refusal from an ordinary transient lead.
};

const char* outcomeName(Outcome o);

// ── Configuration ───────────────────────────────────────────────────────────
// EVERY knob is written verbatim into the pack's meta.json.  Defaults are the
// first-cut hypothesis, not measured optima: the first device packs are the
// experiment that fixes them (operator's standing residual-evaluation gate).
struct Config {
    // Canvas resolution as a fraction of the source raster.  0.5 keeps a
    // 1440×1080 AR frame's strip warp sub-millisecond and the canvas bounded.
    double canvasScale = 0.5;

    // Strip width = |advance| × this.  The margin only sets how far AHEAD of
    // the frame centre we are willing to paint; the committed width per frame
    // is exactly the advance (the high-water left clip does that).
    double stripMargin = 1.25;

    // |Δu| at or below this (canvas px) ⇒ SkippedNoAdvance.
    double minAdvancePx = 0.5;

    // THE ALIASING CAGE.  A measured advance above this is
    // REJECTED — never met with a wider search.  0 ⇒ derived at reference
    // latch as `maxAdvanceFrac × imageWidth × canvasScale`.
    //
    // The resolved value is additionally CLAMPED to the phase-correlation
    // window's own unambiguous range (0.40 × winW ÷ workScale × canvasScale).
    // That clamp is what makes the cage a real search bound rather than a
    // post-hoc filter: a displacement beyond the window wraps circularly and
    // would be MEASURED SMALL, so the cage must never be wider than what the
    // window can honestly see.  See also maxSweepSpeedMps — the pose-side
    // gate that catches the lurch the image alone would mis-measure.
    double maxAdvancePx = 0.0;
    double maxAdvanceFrac = 0.10;   // ≈5.5 cm on canvas at 0.6 m standoff —
                                    // an order of magnitude below facing pitch

    // POSE-SIDE CAGE.  ARKit translation gives an image-independent bound on
    // how far the scene can have moved between two frames.  A step above
    // `maxSweepSpeedMps × Δt + poseSlackM` is rejected WITHOUT advancing the
    // chain — this is the gate that catches a lurch big enough to wrap the
    // correlation window (which the measured-advance cage cannot, because a
    // wrapped measurement comes back small).  Speed, not per-frame distance,
    // so a dropped frame widens the allowance instead of false-positiving.
    double maxSweepSpeedMps = 1.2;
    double poseSlackM       = 0.01;

    // THE HYPOTHESIS SWITCH.  false ⇒ H_rect := I (the image-only arm the
    // offline replay already ran).  Ship ON; flip only for the A/B pack.
    bool rectify = true;

    // Chained exposure match on the strip overlap.
    bool   gainMatch     = true;
    double gainStepClamp = 0.10;   // max per-strip change vs the previous gain
    double gainCumClamp  = 2.0;    // cumulative gain clamped to [1/x, x]
    double gainSampleMinPx = 24.0; // widen the overlap sample to at least this
                                   // many canvas px of already-painted canvas

    // Registration work scale + window.  phaseWindowPx is in SOURCE px; the
    // window actually correlated is phaseWindowPx × workScale wide.
    //
    // STILL 0.5, AND THAT IS A MEASURED DECISION, not an untouched default.
    // The 2026-08-24 precision round asked whether correlating at half
    // resolution is what limits the wobble.  It is not, and the chain of
    // evidence is in the offline noise study of 2026-08-24:
    //
    //   · the ESTIMATOR does get better.  Triangle closure — d(i,i+1) +
    //     d(i+1,i+2) − d(i,i+2), exactly zero for a rigid planar scene however
    //     the camera moved, N ≈ 480 per pack — falls to 0.74× at workScale
    //     0.75 and to 0.64× at 0.75 with the matched centroid support below.
    //     Better on ALL FOUR packs.
    //   · the DELIVERABLE does not.  Ten chain realisations per arm per pack
    //     (a sub-pixel jitter re-rolls the walk without carrying information),
    //     pack-balanced paired bootstrap: wobble rms 0.945 × v6, 95% CI
    //     [0.871, 1.034], better on 3 of 4 packs.  Not separable from zero.
    //   · because the estimator is only ~26 % of the local placement variance.
    //     Decomposing the committed cross step into the channels the ledger
    //     already carries: the ATTITUDE channel's high-frequency content is
    //     0.139/0.297/0.225/0.166 canvas px and the correlation residual's is
    //     0.073/0.106/0.179/0.104, and the attitude channel is IDENTICAL in
    //     every arm because it comes from ARKit, not from the image.  The
    //     estimator lever cannot reach it.
    //
    // What the finer scale DOES buy, measurably: the structure function at
    // short lags — the LOCAL placement error, i.e. whether neighbouring strips
    // line up — falls to 0.920 × [0.890, 0.951] at lag 2 and 0.908 ×
    // [0.872, 0.947] at lag 8, better on all four packs.  That is real and it
    // is small, and it costs 2.25× the correlated pixels and 2.25× the host's
    // grayWork resize on a tier whose whole point is low-end devices.  So the
    // knob is here, measured, and OFF.  Flip `workScale` alone to run it: the
    // support below follows automatically.
    double workScale        = 0.5;
    // 768 SINCE 2026-09-07, AND THE 384 IT REPLACES WAS KILLING WHOLE SWEEPS.
    // The operator's phone stopped producing ANY output on the ARKit arm:
    // `chain-lost`, 0 strips painted, 71-77 consecutive `rejected-low-response`
    // frames, response median 0.09-0.11, the axis never latching.  Three sweeps
    // 30 s apart in one room settle what it is and is not (packs pulled to
    // scratchpad/pull3; the offline replay reproduces the abort outcome-for-
    // outcome, so the evidence is in the pack and not in the live ingest):
    //
    //   19:04:37  chain-lost, 0 painted, response median 0.09
    //   19:05:07  WORKED,   168 painted, response median 0.86
    //   19:05:20  chain-lost, 0 painted, response median 0.11
    //
    // The two failures and the success share the camera to three digits —
    // 1920x1440, fx ~1328, exposure 0.0166 s, ISO 1181 vs 1143, 59.98 fps —
    // and the per-frame rotation is 2.3 px against 1.8 px, so it is not the
    // light, not the lens, not the hand and not motion blur; the frames are
    // sharp and full of structure when you open them.  Bisected on the pack:
    // `rectify=0` and `projection=0` change NOTHING (the attitude path is not
    // the cause), `workScale=1.0` is worse, dropping `minPhaseResponse` buys
    // output made of holds and refusals — and `phaseWindowPx=768` alone turns
    // the identical frames into a full panorama, 243 strips at response 0.89.
    // The second failed pack: 0 -> 200 strips at 0.92.
    //
    // It is not a rescue knob for bad captures either: the sweeps that already
    // worked get BETTER (response 0.78 -> 0.91 and committed jog p95 0.83 ->
    // 0.62 on the IMU pack of that same minute; 0.80 -> 0.96 and 1.59 -> 0.39
    // on the 14:50 one), and it is the only knob that moved the operator's
    // wobble band in the 2026-09-07 low-light study (mean |jog| 2.14 -> 1.31).
    // One window, three symptoms.
    //
    // COST, and it is not the 4x the area implies: per-frame engine time
    // p50 5.13 -> 7.52 ms on the offline driver (this Mac, -O0).  UNMEASURED
    // ON A DEVICE, and unmeasured on the A35, which is the tier that decides
    // whether this stays.  Operator approved the default on the evidence above.
    //
    // ⚠ The window is CAPPED at the work raster, so on a smaller raster this
    // silently means "the whole frame" — see the cap at rnis_pano.cpp:4610.
    //
    // ── 512 ON ANDROID SINCE 2026-09-10, AND 768 IS UNCHANGED ON iOS ──────
    //
    // The block above says the A35 is "the tier that decides whether this
    // stays". It was measured on 2026-09-10 and it decided: on Android the
    // window buys NOTHING, and it was costing more than half the frame budget.
    //
    // MEASURED, on the operator's A35, live: the engine took 30-31 ms per frame
    // against a 33.3 ms budget at the camera's 30 Hz, so 52 of 118 and 62 of
    // 148 delivered frames were dropped as droppedBusy and the engine actually
    // saw ~17 Hz. Halving the angular sampling rate is what put visible steps
    // in his canvas and stretched the reference latch past a second.
    //
    // THE WINDOW IS FREE ON ANDROID. Replaying his three A35 packs offline
    // across 384..768, painted and rejected are IDENTICAL to within one strip
    // at every size, with zero rejections anywhere:
    //
    //   pack           384        512        768        (painted / rejected)
    //   ...81466    112 / 0    112 / 0    111 / 0
    //   ...24271     68 / 0     68 / 0      69 / 0
    //   ...51528     63 / 0     63 / 0      63 / 0
    //   engine p50    1.6 ms     2.3 ms     4.0 ms
    //
    // AND IT IS NOT FREE ON iOS, which is why this is scoped and not global.
    // The three packs the 768 decision was made on (pull3, 19:04:37 / 19:05:07
    // / 19:05:20) replayed across the same range:
    //
    //   19:04:37   384 chain-lost | 512 197/24 | 640 280/0 | 768 294/0
    //   19:05:20   384 chain-lost | 512 218/25 | 640 256/1 | 768 252/1
    //   19:05:07   identical from 512 up
    //
    // So 512 does CLEAR the chain-lost failures — that is why 512 and not 384,
    // for margin against an Android scene that ever behaves like those — but on
    // those iOS captures it paints ~100 fewer strips and rejects frames where
    // 768 rejects none. Dropping the global default would trade a visible loss
    // on exactly the sweeps that motivated the knob. Operator approved the
    // Android-only scope on this evidence.
    //
    // Incidental, and it is why no intermediate size appears here: 448 is
    // consistently SLOWER than 512 on every pack measured. The transform
    // prefers powers of two, so the sizes between them cost more and buy less.
    //
    // THE DEFAULT IS RECORDED IN EVERY PACK, so a platform-dependent default
    // does not break replay fidelity: `meta.json` carries the value the engine
    // actually ran with and the replay driver adopts it (`useMetaConfig`).
    // Replaying an Android pack on a Mac therefore still runs 512.
    //
    // A HOST CAN STILL OVERRIDE IT — `phaseWindowPx` is already in the bridge's
    // passthrough list (PanoPlusLiveModule.kt:150) and typed on the JS side
    // (panoPlusTypes.ts:164), so the A/B needs no build.
    //
    // ── 512 WAS TOO SMALL. 640 SINCE 2026-09-10, SAME DAY, AFTER FIELD TEST ──
    //
    // The operator on the 512 build: "the preview does not flicker now. But the
    // output quality got bad." He was right and the A/B above was scoped wrong.
    //
    // THE MISTAKE, NAMED SO IT IS NOT REPEATED: the A/B that produced 512 was
    // run on packs captured at ~17 Hz, because the engine was then costing
    // 30 ms a frame and dropping half the camera's output. Making it faster
    // CHANGED THE INPUT REGIME the verdict was measured in — the device now
    // captures at ~25 Hz, with a smaller advance between consumed frames — and
    // a verdict measured in one regime was shipped into another. Scope a
    // verdict to the device class AND the input regime it was measured on —
    // a rule violated here by the same person who wrote it down.
    //
    // RE-MEASURED ON THE PACKS THE FAST ENGINE ACTUALLY PRODUCED. The metric
    // that moved is not painted count, it is CONFIDENCE — and weak frames are
    // exactly what tear a canvas:
    //
    //   pack ...400948   resp p50 / resp min / weak(<0.6) / |jog| max
    //     512             0.788    0.268      8            7.00
    //     640             0.810    0.519      5            1.89
    //     768             0.838    0.562      3            6.67
    //   pack ...451842
    //     512             0.944    0.308     11            2.55
    //     640             0.947    0.626      0            1.92
    //     768             0.947    0.745      0            1.80
    //
    // 640 recovers essentially all of it: weak frames 11 -> 0 and 8 -> 5, and
    // the minimum response roughly doubles. It also matched 768 outcome-for-
    // outcome on the iOS rescue packs (280/0 vs 294/0, and 256/1 vs 252/1 —
    // better on the second), so the margin against chain-loss is intact.
    //
    // AND IT KEEPS THE SPEED THAT MADE THIS WORTH DOING: 3.3 ms against 768's
    // 4.3 on the offline driver, which projects to ~24 ms on the A35 against a
    // 33.3 ms budget. 768 measured 30 ms live and dropped 44-55% of frames;
    // 640 stays inside the budget, so the frame rate stays up.
#ifdef __ANDROID__
    int    phaseWindowPx    = 640;
#else
    int    phaseWindowPx    = 768;
#endif
    double minPhaseResponse = 0.05;

    // SUB-PIXEL CENTROID SUPPORT, work px.  0 ⇒ derived from `workScale` so
    // the support always spans ~10 SOURCE px — which is what
    // cv::phaseCorrelate's hard-wired 5×5 already is at workScale 0.5.  At the
    // shipped scale this resolves to 5 and the engine calls cv::phaseCorrelate
    // itself, so the default path is the shipped path, not a re-derivation of
    // it (PanoCorr.TheDefaultPathIsLiterallyCvPhaseCorrelate).
    //
    // Raising the work scale WITHOUT widening the support gives most of the
    // gain back (closure 0.74× vs 0.64×): a support of `box` work px spans
    // box/workScale SOURCE px, so a fixed 5×5 shrinks in real terms as the
    // raster gets finer.
    //
    // Reading the peak MORE SHARPLY is a REFUTED direction, and the refutation
    // is the most useful thing that round found: an upsampled-DFT refinement
    // (Guizar-Sicairos) and Foroosh's closed form are 20-30× more precise than
    // the centroid on a SYNTHETIC pure-translation pair and 1.26-1.64× WORSE
    // on every real pack.  A real inter-frame pair is not a pure translation,
    // so the correlation surface is a displacement DISTRIBUTION rather than a
    // needle (measured peak/total 0.12-0.22 real vs 0.21-0.54 synthetic); its
    // centroid is the mean and its argmax is only the mode.
    int    corrCentroidBoxPx = 0;

    // STALE-CHAIN PROTECTION, part of the aliasing cage.  While the chain is
    // held (any rejection
    // run) the reference window ages, and an aged window can return a WRAPPED
    // correlation whose measured advance is small enough to pass the cage —
    // the exact silent alias the cage exists to prevent.  So: resuming from a
    // held chain demands a materially stronger peak than the ordinary floor,
    // and a rejection run that never resolves ABORTS the sweep (visible stop)
    // instead of eventually accepting something.
    //
    // RE-SCALED IN v3, and the reason is measured, not stylistic: until v3 the
    // engine handed cv::phaseCorrelate a buffer the previous call had already
    // multiplied by the Hann window, so every correlation after the first
    // compared Hann²·prev against Hann¹·cur and the peak was ARTIFICIALLY
    // WEAK.  On the first device pack, fixing that moves the response
    // distribution's low tail from 0.06-0.13 to 0.26-0.34 (median 0.80 →
    // 0.94).  Leaving the resume floor at 0.30 would have turned a gate that
    // 33% of frames failed into one that 2% fail — i.e. it would have
    // SILENTLY WEAKENED THE CAGE as a side effect of a correctness fix.  0.60 sits
    // just above the new low mode and far below a typical match, which is the
    // same character the old 0.30 had against the old scale.
    double stallResumeResponse = 0.60;
    int    maxRejectRunFrames  = 60;   // ~2 s at 30 fps

    // Canvas allocation.  Grows by doubling ALONG THE SWEEP AXIS; never
    // shrinks; never reallocated per frame.  Exceeding canvasMaxWidthPx (or
    // canvasMaxPixels) is a VISIBLE stop (CanvasFull), never a silent
    // truncation.
    int canvasInitWidthPx = 2048;
    int canvasMaxWidthPx  = 16384;

    // PERPENDICULAR slack for attitude/hand drift, applied once at the axis
    // latch.  ±128 canvas px ≈ ±256 source px ≈ ±11 cm of drift at 0.6 m
    // standoff — which a 3-4 m handheld sweep routinely exceeds, so the pad
    // alone is NOT the answer; canvasGrowVertical is.
    int canvasPadPx       = 128;

    // PERPENDICULAR GROWTH.  Without it, content that drifts outside the
    // fixed band is discarded by the warp with nothing to show for it: the
    // panorama silently loses shelf height while unpaintedRuns() still
    // reports zero holes (the G1 gate only looks along the sweep axis).  With
    // it on, the canvas grows in 128 px steps up to canvasMaxHeightPx /
    // canvasMaxPixels.  Whatever is STILL outside after growth is counted and
    // reported (SessionStats::clippedFrames / maxClipTopPx / maxClipBotPx and
    // FrameOutcome::clipTopPx / clipBotPx) — never silent either way.
    bool canvasGrowVertical = true;
    int  canvasMaxHeightPx  = 2048;

    // THE memory cap (see the header's memory note).  Growth in EITHER
    // dimension is refused when it would take the canvas past this.  18 MP ⇒
    // ~72 MB steady / ~126 MB transient across canvas + coverage.
    double canvasMaxPixels = 18.0e6;

    // INTERIOR-GAP BACKFILL (algorithm step 8).  When a frame's footprint no
    // longer reaches the frontier, paint the missing columns from the
    // PREVIOUS painted frame — which did see them — before declaring a hole.
    // Off ⇒ the gap is reported as GapBreak and left as a permanent hole.
    bool backfillGaps = true;

    // Session gating / discontinuity detection.
    int    trackingWarmupFrames = 5;    // consecutive "normal" frames before latch
    int    cageStallFrames      = 30;   // consecutive cage/response rejects ⇒ stalled
    int    axisLatchFrames      = 6;    // MINIMUM accepted frames before the latch
    double maxTranslationJumpM  = 0.30; // |Δt| above this ⇒ session-restart abort

    // ── AXIS / SIGN LATCH: what it votes on, and how it is CORRECTED ────────
    //
    // The frame's canvas position is the SUM of two measured channels:
    //
    //   ROTATION  canvasScale·(H_rect(centre) − reference centre)   — attitude,
    //             gyro-derived, essentially noise-free, and IDENTICALLY ZERO
    //             for a sweep that walks a shelf without turning;
    //   RESIDUAL  posNat, the accumulated phase-correlation advance — the
    //             translation/parallax part, and the ONLY channel that carries
    //             a walking sweep.
    //
    // The latch votes on the TOTAL — their sum, which is exactly where the
    // paint transform puts the frame — once it has moved latchTotalPx, and
    // NEVER on either channel alone:
    //
    //   * v2 voted on the RESIDUAL alone.  On a pivot the residual is
    //     ≈ −(rotation), so v2 votes BACKWARDS on the gesture people actually
    //     use to pano.  That is the first device pack's one-frame canvas.
    //   * v3 added a ROTATION fast path, gated on ‖rotation‖∞ > ‖residual‖∞.
    //     Those are ∞-norms of two vectors that can point in ORTHOGONAL
    //     directions, so on a shelf walk carrying incidental pitch the
    //     perpendicular rotation channel won the comparison and latched the
    //     axis ACROSS the sweep — a one-frame canvas again, in the other
    //     regime.  Measured: 21 of 45 walk-with-transverse-rotation gestures.
    //
    // The fast path is GONE rather than repaired, on evidence: with the
    // rotation channel disabled entirely, every pivot fixture (pitch and yaw,
    // ±8°/±18°/−30°) latches the same axis and sign and produces a
    // BYTE-IDENTICAL paintedW — the channel bought an earlier latch (6 frames
    // instead of 11) and no extra panorama at all.  One rule, one quantity,
    // and the quantity is the one the painter uses.
    //
    // WHY A MOTION GATE AND NOT A FRAME COUNT.  Measured on the first device
    // pack: over any 6-frame window the residual's accumulated SNR is ≈1, and
    // even the TOTAL channel votes the wrong sign for the first ~125 accepted
    // frames (the operator translated against his own rotation early in the
    // sweep, a real −15.9 canvas px excursion).  A count-based latch is a coin
    // flip whatever quantity it reads.
    //
    // WHY A GATE IS STILL NOT ENOUGH, AND WHAT ACTUALLY FIXES IT.  Over a
    // short horizon a RISING TRANSIENT is indistinguishable from a sweep: an
    // operator levelling the phone through 8° while walking moves the total
    // exactly as a pivot would, and no threshold can tell them apart at the
    // moment of crossing.  Raising latchTotalPx only moves the cliff (measured:
    // at 192 px the transient family passes and a slow walk latches at frame 78
    // of 90, painting one frame).  The defect is not WHERE the bar sits, it is
    // that the decision is IRREVERSIBLE on evidence that is genuinely ambiguous
    // when it is taken.  So the latch is no longer irreversible — see the
    // relatch block below.  The gate stays low and the latch stays EARLY (the
    // operator gets a preview in a few frames); correctness comes from
    // checking the decision, not from delaying it.
    double latchTotalPx     = 24.0;   // 1.5× the worst early reversal measured
                                      // on the first device pack (15.9 px)
    // THE CAP.  Reaching it means nothing ever moved decisively, so the vote is
    // weak BY CONSTRUCTION and SessionStats::latchWasWeak says so.
    //
    // KEPT LARGE DELIBERATELY, and the trade-off is measured rather than
    // assumed.  Nothing paints before the axis latches, so the motion gate also
    // blanks the operator's live preview — and on the first device pack the
    // TOTAL does not move latchTotalPx until accepted frame 131 (the operator
    // translated against his own rotation for the first ~2 s), i.e. ~2.2 s of
    // black preview at 60 fps.  Capping the wait at 45 fixes the preview and
    // costs deliverable: the vote is then FORCED while the evidence still says
    // the wrong thing, the sweep latches sign −1 (paintedW 726, 0 painted, 241
    // held-backtrack — the original one-frame canvas) and only the RELATCH
    // recovers it, to paintedW 1095 / 154 painted / zero holes.
    //
    // At 240 the primary rule gets that pack right UNAIDED — paintedW 1177, 135
    // painted, zero holes, relatchCount 0 — so correctness rests on the rule
    // and the correction stays the net it was built to be.  That is the safer
    // structure and the larger panorama, so it is the default.  A smaller value
    // is a live operator knob if preview latency turns out to matter more in
    // the field than the last 7% of the sweep; both arms are hole-free.
    int    axisLatchMaxFrames = 240;

    // ── RELATCH: the latch checks its own work ──────────────────────────────
    //
    // A wrong axis/sign has ONE unmistakable signature — the canvas stops
    // growing.  Every frame lands behind the frontier (HeldBacktrack) or fails
    // to advance along u at all (SkippedNoAdvance / HeldFrontier), so the
    // deliverable is a single frame no matter how long the operator sweeps.
    // That signature is available a few frames later, from evidence the engine
    // already has, and it is what the relatch reads:
    //
    //   ARMED   from the latch until the panorama has grown past
    //           relatchCommitFrac × (one frame's footprint along the sweep
    //           axis) — at which point the latch is self-evidently right and
    //           the relatch is disarmed FOREVER (no thrash, no oscillation).
    //   FIRES   when, while still armed, the camera's cumulative displacement
    //           since the FIRST latch has moved decisively (relatchMotionPx,
    //           ESCALATING per correction), is UNAMBIGUOUS (one axis beats the
    //           other by relatchDominance), and re-deciding axis+sign from it
    //           gives a DIFFERENT answer.  Same answer ⇒ no-op, re-checked
    //           later — which is what makes a premature or noisy trigger free
    //           rather than destructive.  The evidence is never re-zeroed by a
    //           correction: a relatch that fires mid-wobble must not restart
    //           the baseline at the worst possible moment.
    //   COSTS   the frames swept before the correction.  Bounded by
    //           relatchCommitFrac of a footprint, and paid only on a sweep
    //           that was producing a one-frame canvas anyway.
    //
    // relatchMaxCount bounds the total number of restarts so a pathological
    // input can never loop.  Every restart is counted in
    // SessionStats::relatchCount and flagged on the row (FrameOutcome::
    // relatched) — a corrected sweep says so in the pack rather than quietly
    // looking like a short one.  Set relatchMaxCount = 0 to disable.
    // relatchMinFrames is the ONE knob with a physical timescale behind it,
    // and it was measured rather than picked: the check must span longer than
    // a hand TRANSIENT, or the correction is decided by the same wobble that
    // caused the mis-latch.  At 6 accepted frames the transient family still
    // failed (the relatch fired mid-wobble, twice, and exhausted its budget);
    // at 12 every gesture recovered but the worst needed BOTH corrections; at
    // 20 — ≈0.33 s at 60 fps, ≈0.67 s at 30 — every gesture recovered with ONE
    // correction and budget still in reserve.  It costs nothing when the latch
    // was right, because a right latch grows the canvas past relatchCommitFrac
    // and disarms the check before it ever fires.
    double relatchMotionPx   = 24.0;
    double relatchCommitFrac = 0.15;  // of the sweep-axis footprint
    double relatchDominance  = 1.5;   // winning axis must beat the other by
                                      // this, or the evidence is ambiguous and
                                      // the engine waits rather than spending
                                      // a correction (1.3-1.6 is a measured
                                      // plateau; 2.0 starts refusing real ones)
    int    relatchMinFrames  = 20;    // accepted frames between re-checks
    int    relatchMaxCount   = 3;

    // ATTITUDE-EXCURSION GATE.  Beyond this total rotation vs the reference
    // the planar single-canvas model stops being a good description of the
    // scene, so the frame is REJECTED (RejectedRectify) and the chain held.
    //
    // Enforced in BOTH A/B arms.  It used to sit inside `if (rectify)`, which
    // meant the rectify=false control arm had no excursion gate at all and
    // could never produce RejectedRectify — an experiment whose arms differ
    // in more than the hypothesis is not a controlled experiment.
    //
    // The correlation window is separately CLAMPED into the rectified
    // footprint, so a large excursion no longer walks the window off the
    // raster and correlates border black (which used to manifest as spurious
    // rejected-low-response / held-backtrack rows past ~20°).
    double rectifyYawLimitDeg   = 35.0;

    // ARKit `.limited` handling.  Default FALSE: `.limited(.excessiveMotion)`
    // fires routinely during exactly the deliberate pan pano+ asks for, and
    // `.limited(.relocalizing)` after any brief occlusion — but neither
    // invalidates what this engine consumes.  Attitude stays gyro-driven and
    // good in `limited`, and the real relocalisation risk (a translation
    // discontinuity) is caught separately by maxTranslationJumpM.  Aborting
    // on it truncated a large fraction of field sweeps for no reason.
    // `notAvailable` is different and always holds the chain.
    bool abortOnLimitedTracking = false;

    // ── v5 PROJECTION ───────────────────────────────────────────────────
    // 0 = Planar   — v4's canvas: every frame rectified into FRAME 0's image
    //                plane.  Kept as the A/B control arm; area magnification
    //                grows as sec³θ off the reference axis without bound.
    // 1 = SweepCylindrical (DEFAULT, ships ON) — the excursion is split at
    //                the LATCHED SWEEP AXIS: the along-sweep component is
    //                carried as ARC LENGTH (cylindrical, uniform scale in the
    //                sweep angle) and everything else stays on the tangent
    //                plane (rectilinear across the sweep, so lines running
    //                ACROSS the sweep stay exactly straight).
    //
    // NOT a regime selector.  There is no threshold anywhere in the model:
    // ψ ≡ 0 pre-latch, in the rectify == false control arm, and on a pure
    // translation sweep, and v5 is then byte-identical to v4.  A
    // rotationFraction threshold would have had to fire at 0.38-0.52 on the
    // operator's own four packs, i.e. it would have been a coin flip on
    // exactly the inputs it exists to classify.
    int projection = 1;
    // Bounds the ALONG-SWEEP excursion, which rectifyYawLimitDeg no longer
    // does (that gate now bounds the CROSS excursion — the part the
    // homography actually carries).  canvasMaxWidthPx is the other bound.
    double sweepMaxDeg = 120.0;

    // ── THE ARC SEED — the bootstrap painted under the SWEEP's own law ──
    // Width, in CANVAS px, of each slice the bootstrap frame is committed in.
    // 0 disables the slicing and restores the single unwarped block.
    //
    // WHY THIS EXISTS.  `projection == 1` says the along-sweep component is
    // carried as ARC LENGTH — see this block's own text above, and
    // sweepRotation's ("v5 places it at +f·ψ instead — ARC LENGTH rather than
    // the tangent — and that substitution is the whole of the cylindrical
    // fix").  Every STRIP obeys that.  The BOOTSTRAP did not: commitLatch
    // pasted the reference frame's whole footprint through `Href`, which
    // carries no H_rect at all, so its content at field angle φ landed at
    // f·tan(φ) — the tangent law — while everything painted after it landed at
    // f·φ.  The two laws agree at φ = 0 and in first derivative, which is why
    // the seam's own step is small; they diverge as f·(tan φ − φ), which is
    // what the operator sees.  MEASURED on his six 2026-09-04 packs, at the
    // seed's own rear edge: 71.0 canvas px (ultra-wide, half-field 43.2°) and
    // 29.8 px (wide, 28.3°) — across 360 canvas px of rear half that the
    // frontier starts in front of and no strip ever revisits, i.e. roughly a
    // third of a landscape deliverable.
    //
    // WHAT THE SLICING DOES.  Each slice is painted as the frame a camera
    // ROTATED to that slice's own sweep angle would have produced, placed at
    // its arc — built from the engine's own sweepRotation/kMat/kInv/translate,
    // in the same order `Hrect` builds them, so it is the strips' law and not
    // a second one that resembles it.  The φ = 0 slice is `Href` exactly, so
    // the frame centre, `highWater` and the frontier do not move.
    //
    // 8 px keeps the within-slice tangent residual at 1.5e-4 px (it grows as
    // f·(tan δ − δ) in the half-slice δ, so even 32 px stays under 0.01 px);
    // the cost is ~72 bounded warps once per session, not per frame.
    double seedArcSlicePx = 8.0;

    // ── OPTION C — FORCE REPLACEMENT OF THE PROVISIONAL LEAD-IN ─────────
    // Default OFF, and the deliverable is byte-identical when it is off
    // (nothing below runs; proved by SHA-256 on the operator's packs).
    //
    // WHAT THE SEED LEAVES BEHIND.  `commitLatch` paints the reference
    // frame's WHOLE footprint — `[ru0, ru1]`, 720 canvas px on the
    // operator's 0.5x packs — and then sets `highWater` to the frame's
    // CENTRE (488 on 15-51-02).  So `[488, 848)` is painted but not yet
    // swept: PROVISIONAL lead-in.
    //
    // ⚠ WHAT THIS FLAG IS *NOT* FOR, MEASURED BEFORE IT WAS WRITTEN.  The
    // brief this was built from says the strips "commit only forward of
    // `highWater`, so `[488..848]` is first-frame content that is never
    // repainted".  THAT IS FALSE, and an owner map over the delivered
    // canvas says so: on all 16 of the operator's packs, every canvas
    // COLUMN ahead of the seed centre is repainted, and the seed keeps
    // ZERO of them.  `paintLeft = max(highWater, fu0)` starts each strip AT
    // the frontier, and the frontier starts at the centre — the strips
    // sweep the lead-in as a matter of course.  The seed's real 37.2 %
    // share of pack 15-51-02 is 36.9 % REAR half (`[128, 488)`, behind the
    // frontier, which no forward-only strip can ever reach) and 0.36 %
    // lead-in.  This flag therefore has a CEILING of 0.36 % on that pack
    // and 0.88 ± 0.18 % (n = 16) across the set.  It does not, and cannot,
    // touch the 30 % block; re-owning the rear half means re-committing the
    // seed at finalize from the pre-latch frames that also saw it, which is
    // a different change and is not this one.
    //
    // WHAT IS LEFT, AND WHY IT IS STILL WORTH FIXING.  The lead-in survives
    // in TWO dimensions, and the column map only sees one.  A later strip
    // repaints the seed's columns but only over the ROWS its own warp mask
    // covers; where the sweep has drifted perpendicular, the seed's rows at
    // the cross extreme are never covered again.  That residue is the
    // "un-replaced provisional remnant" of the v5/v6.7 design — a
    // contiguous sliver at the row extreme, 6.3 % of row width at p50,
    // standing against content a median of 182 frames newer.  It is a
    // VISIBLE artefact out of proportion to its area.
    //
    // WHAT THE FLAG DOES.  While any of the provisional band is left, each
    // painted frame commits a SECOND, non-advancing paint over
    // `[max(highWater, leadFill), min(fu1, leadEnd))` — the part of the band
    // this frame can see that nothing has filled yet.  It is the same
    // construction as the interior backfill and as the lead-out the live
    // preview already draws, pointed forward instead of back.
    //
    // ⚠ SINGLE-OWNER, AND THAT IS NOT A DETAIL — it is the difference between
    // this flag helping and this flag hurting.  The first cut had no
    // `leadFill` mark: every painted frame repainted the WHOLE remaining band,
    // each column was written dozens of times, and a surviving pixel's owner
    // was whichever warp mask reached it LAST — the mask's ragged cross-axis
    // edge, not the sweep.  Adjacent pixels came from frames hundreds apart.
    // Measured over exactly the 60 878 px the flag took back from the seed on
    // the operator's 12 same-raster packs: distinct owners 1 -> up to 163,
    // owner-boundary density 0.10 -> 0.87 per px, local |Laplacian| 26 -> 73 DN,
    // rougher on 12/12 packs; at 4x the band went from one coherent block with
    // a clean edge to a torn comb.  The band was no longer stale and was now an
    // artefact, which is worse, because the operator can see an artefact.
    // Filling strictly forward makes ownership inside the band a function of
    // COLUMN alone, so the only boundaries left are the vertical joins an
    // ordinary strip already makes.
    //
    // AND UNDER THE SWEEP'S OWN LAW.  The fill is wide — a half footprint in
    // one commit — and over that span `projection == 1`'s arc map and the
    // tangent map disagree by F·(d/F − atan(d/F)), which is 57 px at the far
    // edge on these packs.  The seed is arc-sliced, so the fill is too,
    // through the same slice builder the tail flush and the preview lead-out
    // use; it falls back to the single tangent block exactly where the seed
    // did.
    //
    // WHY IT CANNOT MOVE THE FRONTIER, and what distinguishes the true
    // frontier from the provisional lead-in.  `highWater` is BOTH "nothing
    // repaints behind here" and "the next paint starts here", and those two
    // must not be merged: the photometric band scan, the gain sample window
    // and the seam step all rest on a column being FINAL once the frontier
    // has passed it.  So the fill is bounded on the left by `highWater`
    // exactly as an ordinary strip is, and does not advance it — the strip
    // chain still owns the frontier, and a column behind it is still never
    // rewritten.  The extra state the distinction needs is three numbers:
    // `Impl::leadEndU`, the far edge the seed actually committed;
    // `Impl::leadFillU`, how far the fill has got; and `Impl::leadArcSeeded`,
    // which law the seed used.  Ahead of the frontier and behind `leadEndU` ⇒
    // provisional; behind `leadFillU` ⇒ already filled, and never touched
    // again; ahead of `leadEndU` ⇒ nothing of ours is there yet.  Once either
    // mark has covered the band it is gone, and this stops firing for the rest
    // of the sweep.
    //
    // ORDERING, and it is load-bearing.  The repaint runs AFTER the row's
    // seam/jog/gain fields have been read out of the engine, because
    // `commitStrip` overwrites `lastSeam*` on every call; and it runs with
    // the gain fit OFF (`applyChainGainNoFit`), so it carries the same total
    // photometric factor the strips carry without perturbing the chained
    // estimator that the strips own.
    //
    // COST.  One extra warp per frame for as long as any of the band is
    // unfilled.  Because the fill is forward-only that is normally settled in
    // the first painted frames — the whole band goes to one frame whose pose is
    // still next to the seed's — and what is left afterwards is the sliver each
    // frame's mask could not reach.  Reported as
    // `SessionStats::leadRepaintStrips` / `leadRepaintPx` and per-frame as
    // `FrameOutcome::leadRepaintPx`, so the trade is a measurement rather than
    // an estimate.
    bool leadReplace = false;

    // ── THE SEED JUNCTION — the ~10 px hole between the seed block and the
    //    strip chain, and whether the two are made to MEET instead of bridged
    //
    // `commitLatch` hands the frontier the seed frame's CENTRE ("so the sweep
    // resumes immediately"), while EVERY strip's left edge sits half a margin
    // BEHIND its own centre.  The two conventions disagree at exactly one
    // place — the first strip after a seed — and the disagreement is
    // arithmetic, not physics:
    //
    //     gapPx = du₁ · (1 − stripMargin/2)        (= 0.375 · du₁ at 1.25)
    //
    // where du₁ is that strip's advance from the seed's centre.  MEASURED on
    // this Mac (host replay, `rnis_replay_cli`) over every pano+ pack on the
    // machine — Pano plus 3/4/5/6 plus the two phone pulls, 36 packs, 32 with
    // a strip after their seed — the identity holds to |gapPx − 0.375·du₁| =
    // 0.000000 on 32/32, with gapPx 9.178–12.965 px at phaseWindowPx 384 (the
    // value every one of those packs was CAPTURED at) and 9.380–12.997 px at
    // 768.  The hole does not move with the correlation window because it is
    // not a correlation quantity.
    //
    // WHAT THE ENGINE DOES WITH IT WHEN THIS IS OFF: `paintLeft` is dragged
    // back to the frontier, the row is reported `gap-extended`, and the first
    // strip after the seed repaints that span OF THE SEED — the one frame on
    // the canvas with zero registration error by definition, since it IS the
    // datum — using the least-determined strip in the sweep (the first one
    // after a stationary seed, correlated against a reference it has barely
    // moved from).
    //
    // ON ⇒ the seed's committed edge and the first strip's start MEET at that
    // strip's own left edge: `paintLeft = leftEdge`, the span keeps the seed's
    // own pixels, the row reports `gapPx == 0`, `seedMet` and `painted` rather
    // than `gap-extended`, and nothing is bridged because there was never an
    // unpainted COLUMN to bridge — the seed's footprint runs a further
    // ~0.5·footprintU past its centre and already owns every column in the
    // hole.  FAIL-CLOSED: the meet is REFUSED (and the bridge kept exactly as
    // it is today) unless the seed's actually-committed forward edge covers
    // the span and this frame's own footprint still reaches the frontier, so a
    // degenerate or arc-narrowed seed can never turn this into a real hole.
    //
    // ⚠ "EVERY COLUMN" IS NOT "EVERY ROW".  The three guards above are all in
    // u; none compares the seed's warped ROW span over the band against the
    // incoming strip's.  Coverage is additive, so ON's span is structurally a
    // SUBSET of OFF's there and the band's painted height really does shrink —
    // measured on this Mac at phaseWindowPx 768, 19 rows over 9 columns on
    // Pano plus 3 / 2026-09-04T12-49-04-197Z (bottom 1102 → 1083), 18 over 12
    // on pull3-pp_1788825920544, 15 over 9 on pull2-pp_1788821625445 — while
    // `Engine::unpaintedRuns()` reported `holes: 0` in both arms, because it
    // marks a column painted on its FIRST painted row.  Those rows are the
    // seed's ragged edge.  A fourth, ROW-WISE fail-closed guard is NOT
    // implemented and is an open item.
    //
    // ⚠ THE DELIVERED CANVAS STILL MOVES, AND IT IS NOT THE ROW UNION.
    // At 768 the delivered canvas size changes on 9 of 34 packs with the meet
    // on (988 → 1009 px on p5-2026-09-07T11-14-16-066Z; 1031 → 1027 on
    // 11-11-46-413Z; 1015 → 1020 on pull2-pp_1788821659900).  The painted-row
    // union was the obvious suspect and is NOT the cause: a probe that folded
    // the band's own coverage back into `minPaintedV`/`maxPaintedV` was a
    // NO-OP on all 36 packs (72/72 manifest lines identical), so it was not
    // kept.  ISOLATED instead to the SEED LEAD-OUT TRAJECTORY estimator: on
    // 11-14-16-066Z the on/off ledgers differ on exactly ONE row (the junction)
    // yet `seedTrajSamples` goes 768 → 771 and `seedTrajSlope`
    // 0.00584071215 → −0.0200403966, and with `--set crossTrajSeed=0` BOTH
    // arms deliver 988 px.  The mechanism is the one that block's own comment
    // already warns about: the estimator fits the canvas AHEAD of the seed's
    // centre, and the meet is precisely the change that puts the SEED's own
    // forward half back into the first ~10 px of that window.  Not fixed here;
    // it is the next coupling to cut, and until it is, this knob can change
    // the delivered panorama's cross-axis size.
    //
    // ⚠ THIS IS NOT THE LANDING ERROR, and must not be sold as one.  How far
    // that first strip lands OFF is a correlation question this knob does not
    // touch: on the same corpus at phaseWindowPx 384 the junction jog reached
    // 48.54 px (Pano plus 5 / 11-12-47-888Z: refused five times by the d8 jog
    // guard at 47.5–73.3 px, then force-accepted at 72.85 px — the tear the
    // 2026-09-07 low-light doc could not explain), while at 768 the SAME 32
    // packs land within 1.70 px and refuse nothing.  Closing the hole narrows
    // what a mis-landed strip is allowed to repaint; it does not place it.
    //
    // OFF BY DEFAULT.  A default flip is the operator's call, after pictures.
    bool seedFrontierMeet = false;

    // ── AND WHERE THE MEET IS ALLOWED TO MEASURE FROM ───────────────────
    // Read ONLY when `seedFrontierMeet` is on, so the shipped default is
    // untouched by it and the OFF arm stays byte-identical either way.
    //
    // `paintLeft` was the origin of the PAINT and of the MEASUREMENT at once:
    // `commitStrip` derives `wx0` from it, the d8 jog guard correlates over
    // `[wx0, x0)` and the exposure fit is fitted on the same slab.  So the
    // meet — a bookkeeping change, by its own documentation — moved a quality
    // gate's input and the gate changed its mind.  MEASURED on this Mac (host
    // replay, 36 packs, phaseWindowPx 768) with the two coupled:
    //   · d8JogRefusals 31 → 26 corpus-wide; on pull3-pp_1788825920544 the
    //     junction flipped painted → refused (jog 9.907 → 10.425 across that
    //     pack's own 8 px bar) and a −57.02 px strip the off arm had refused
    //     was committed four rows later;
    //   · on packs with NO d8 change at all the exposure chain still re-fitted
    //     — p3-2026-09-04T12-47-06-709Z, zero refusals in either arm, one
    //     outcome change, yet gainStep 0.981425732 → 0.986620189 at the
    //     junction and 250 of 328 rows different afterwards; corpus-worst
    //     gainCum excursion 9.304 %, where the sibling knob's own bound test
    //     (PanoLeadReplace.TheChainedGainMovesOnlyBecauseItSamplesRepainted-
    //     Canvas) fails anything past 5 %.
    //
    // ON (the default when the meet is on) ⇒ the paint starts at the strip's
    // own left edge while the measurement stays anchored where the off arm
    // anchored it, so the guard and the fit read the same overlap of the same
    // two frames in both arms and the knob cannot change a d8 decision.
    //
    // ⚠ BOTH BANDS ARE HONEST, and this is a picture question, not a proof.
    // Pinned, the correlated slab is ~10 px behind where the strip actually
    // begins painting — still inside both the seed's committed span and this
    // frame's own warp, but no longer adjacent to the seam being committed.
    // OFF reproduces the coupled arm the 2026-09-08 review measured, so the
    // operator can A/B the two anchors on pictures rather than on this note.
    bool seedFrontierMeetPinMeasure = true;

    // ── THE ARC TAIL — the tail flush painted under the SWEEP's own law ──
    // Width, in CANVAS px, of each slice the TAIL FLUSH is committed in.
    // 0 disables the slicing and restores the single unwarped block.
    //
    // THE SAME FORK AS THE SEED, AT THE OTHER END OF THE SWEEP.  `finish()`
    // commits the last painted frame over everything still ahead of the
    // frontier — 371-407 canvas px, 29-48 % of the deliverable, on the
    // operator's 2026-09-04 packs — through ONE homography, `lastHint`.  That
    // homography places a ray at angle φ off THAT FRAME's optical axis at the
    // tangent u_c + F·tan φ (F = canvasScale·f_ref canvas px per radian) while
    // every strip beside it places content at the arc u_c + F·φ.
    //
    // WHY IT SHOWS AND THE SEED'S DID NOT.  Both blocks BEGIN at their frame's
    // own optical centre — `highWater = ucx` at the bootstrap
    // (rnis_pano.cpp:2774) and the last strip's own `rightEdge` at the tail —
    // where the two laws agree in value AND slope.  So neither boundary has a
    // lateral step, and fixing the seed changed nothing anyone could see.  What
    // differs is the far side: the seed's φ > 0 half is overpainted by the
    // strips that follow it, leaving only a lead-in that borders nothing; the
    // tail's φ > 0 half IS the end of the panorama and nothing overpaints it.
    // It is stretched by 1/cos²φ, reaching 1.93× at φ = 44° on 12-48-28, and a
    // straight line's lean is multiplied by cos²φ along with it — which is the
    // bend the operator circled, and why the defect is a SLOPE discontinuity
    // and not the lateral step every seam metric here reports.
    //
    // MEASURED, NOT ASSUMED, that the strips build an ARC canvas: fitting the
    // ledger's own posU against ψ and against tan ψ across the strip run gives
    // an arc residual of 0.72 / 1.19 / 1.73 px against a tangent residual of
    // 16.89 / 9.50 / 3.97 px on the three packs with real rotation (57 / 47 /
    // 36°).  The other three sweep 1.6-3.4° — where tan ψ ≡ ψ to 0.05 % and no
    // measurement could separate the laws, which is also why the
    // `maxRectifyDeg > 0` gate below leaves them alone.
    //
    // WHAT THE SLICING DOES.  g(u) = u_c + F·atan((u − u_c)/F), linearised per
    // slice.  g(u_c) = u_c and g'(u_c) = 1 for ANY F, so the frontier, the last
    // strip's content and the boundary row do not move and no step is
    // introduced whatever F is; F is the camera's own because that is the
    // projection's definition and the constant `arcSeedH` already uses.  g is
    // EVEN in F, so `sweepSign` never enters and a −1 sweep needs no case.
    // Content is not dropped — the same field of view is committed, at the
    // scale the rest of the canvas is in, so the deliverable ends 76-95 px
    // earlier than the tangent block ended and shows the same last shelf.
    //
    // 8 px matches the seed's slice width for the same reason: the within-slice
    // residual grows as F·(tan δ − δ) in the half-slice δ, which at 8 canvas px
    // is 1.5e-4 px.  ~46 bounded warps once per session, not per frame.
    double tailArcSlicePx = 8.0;

    // How much of the sweep's canvas growth must come from ROTATION about the
    // sweep axis before the tail block is placed on the arc.  Measured as
    //
    //     rotFrac = canvasScale·f·Δψ / |lastPaintedU − latchCentreU|
    //
    // i.e. the canvas px the arc term contributed, over the px the sweep's
    // frame centre actually travelled from the reference it is measured from.
    //
    // WHY A FRACTION AND NOT THE SEED'S `maxRectifyDeg > 0`.  Because the
    // seed's gate is wrong here and the suite proved it.  `maxRectifyDeg` is
    // the total ATTITUDE excursion, which a WALK carrying a settling transverse
    // tilt has plenty of while its ψ — the component about the sweep axis — is
    // identically zero.  Such a canvas is a planar mosaic: it is carried by
    // `posNat`, its frames are related by translation, and one frame's field
    // belongs on it RECTILINEARLY.  Placing that block on the arc compressed
    // PanoMisLatch.AWalkCarryingASettlingTransverseTiltSweepsAlongTheWalk by 28
    // canvas px (growth 219 → 191 against its 191.125 bar) — a real regression,
    // caught because that test can fail.
    //
    // The tail can ask this and the seed cannot: ψ is identically 0 until the
    // axis latches, and the seed runs AT the latch.  That is a difference in
    // what each end can MEASURE, not two laws — both place the block on the arc
    // when the canvas is an arc canvas.  Whether the seed should now be gated
    // on the same quantity at finalize is a separate change with its own
    // evidence; the seed's own note already asks for it.
    //
    // ⚠ 0.5 IS A DECISION, NOT A DERIVATION, AND THE BAND AROUND IT IS
    // UNMEASURED.  It says "rotation, not translation, is what carries this
    // canvas".  Measured: the operator's six 2026-09-04 packs sit at 0.68 /
    // 0.72 / 0.76 / 0.76 / 0.78 / 0.87 and the walk fixture at 0.00 — so on
    // everything this run has, the bar is nowhere near a decision boundary.
    // NOTHING here measures the 0.05-0.65 band, and a genuinely mixed sweep has
    // no derived within-frame law at all: arc and tangent are both defensible
    // there and the honest answer needs a pack in that band, captured on
    // purpose.  The seed's own note records rotationFraction landing at
    // 0.38-0.52 on an EARLIER four-pack set, where this bar WOULD have been a
    // coin flip — which is the reason it is a knob.
    double tailArcMinRotFrac = 0.5;

    // ── TRAJECTORY CONTINUATION — a block continues the strip chain's ──
    //    cross-axis trajectory instead of its own frame's ──────────────
    // Default OFF; every path below is skipped and the deliverable, the
    // ledger and the preview are byte-identical when it is off (SHA-256 on
    // every pack on disk, see the change's evidence).
    //
    // THE DEFECT.  A block — the tail flush, the seed, the preview's
    // lead-out — is ONE frame through ONE homography.  The strips beside it
    // are a slit-scan: each canvas column is a different frame at its own
    // optical centre.  Where the two meet, the cross-axis POSITION is
    // continuous by construction (the last strip and the block are the same
    // frame through the same matrix) but the cross-axis SLOPE is not: the
    // strips carry whatever cross-axis drift the run accumulated relative to
    // single-frame geometry, and the block carries none.  Measured on the
    // operator's 12-48-28 pack: bars lean -0.13 px/row through the strips
    // and +0.05 inside the block, a slope discontinuity of +0.159 [+0.097,
    // +0.284] n=17 at the tail edge against a 0.027 px/row floor inside any
    // block.  The elbow he circled is that hinge.
    //
    // WHAT THIS DOES.  Measure the strip chain's cross-axis trajectory over a
    // window behind the join and place the block so that its cross position
    // AND slope at the join equal the chain's extrapolation.  The hinge is
    // then gone by construction; what remains is the strips' own lean,
    // continued across the block as a uniform tilt.  That residual tilt is a
    // separate defect (attitude bias) and is NOT addressed here.
    //
    // TWO ESTIMATORS of the same trajectory, selected by `crossTraj`:
    //   1  CHAIN — least-squares d(posV)/d(posU) over the committed strips in
    //      the window: the chain's own bookkeeping, no pixels read.
    //   2  OVERLAP — the block frame's DISCARDED half (the rear half for the
    //      tail and lead-out, the forward half for the seed) is warped over
    //      the window through the block's own law — AND through the same
    //      lens resample every strip went through (v10), so the comparison
    //      is against the placement the block will actually get — and
    //      correlated column by column against the canvas the strips
    //      committed there.  The cross-axis offset between them, fitted
    //      against u, IS the strips' trajectory relative to this frame's
    //      geometry — measured on the pixels, in bands across the cross axis,
    //      so a FAN (a slope that varies across the cross axis) is fitted too
    //      when `crossTrajFan`.
    // Both return the same struct and both are applied by the same slice map.
    //
    // ⚠ THE SLOPE IS THE SLOPE AT THE JOIN, NOT THE WINDOW'S MEAN.  Per band
    // the offset is fitted as a QUADRATIC in u and the linear term — the
    // derivative at the join — is what is continued.  A first cut fitted a
    // line, i.e. the mean slope over the window, and that manufactured a
    // hinge on packs whose strips BEND inside the window: on 15-51-42 the
    // strips' bars run tangent to the block at the join (r2 hinge −0.03
    // [−0.04, −0.01] n=18) and curve away over the 60 px behind it, so the
    // line read −0.19 px/px in the bars' band, the block was sheared to the
    // mean, and the r2 hinge went to −0.13 — a kink half the size of the one
    // the operator circled, on a pack that had none.  The quadratic's slope
    // at the join reads +0.03 there and −0.22 on 12-48-28's central bars,
    // against r2 readings of −0.03 and +0.27 (opposite sign convention): the
    // eye judges the kink AT the join, and so must the estimator.  A band
    // needs 32 columns before its curvature term is fitted; shorter windows
    // (the seed's single-frame span) keep the line.
    //
    // ⚠ WHICH ONE THE PACKS NEED — measured before either was written, on the
    // device ledger of 12-48-28 (tools in the change's evidence dir):
    //     d(posV)/d(posU), last 60 px      -0.054   (-0.11 over 30, -0.08 over 200)
    //     of which residual (correlation)  +0.006   flat on all three landscape packs
    //     of which rotation (attitude)     -0.058
    //     bars' lean, strips vs block      -0.18    (the hinge, opposite sign convention)
    // The chain's cross trajectory is the ATTITUDE's, and rectified content
    // does not follow the attitude — a tilt moves posV and the frame's pixels
    // by the same amount, so the bar stays put.  The residual channel, which
    // is what would move content against the frame, is flat.  So estimator 1
    // predicts at most a third of the hinge on this pack and estimator 2 is
    // the one that can close it.  Estimator 1 is kept because it is the
    // brief's literal definition and is measurable against 2 on every pack.
    //
    // WINDOW.  `crossTrajWindowPx` canvas px behind (or, for the seed, ahead
    // of) the join.  60 is the instrument's own window (the r2 bar fit uses
    // half=60) and is where the measured sweep bottoms out — on 12-48-28,
    // the tail hinge's median |slope discontinuity| over the same 20 bars at
    // N = 30 / 45 / 60 / 90 / 120 px reads 0.050 / 0.030 / 0.024 / 0.024 /
    // 0.027 px/px against a 0.027 floor, with the signed median crossing zero
    // at 60 (−0.020 at 30, +0.027 at 120): below 45 the fit chases the last
    // strips' own noise, above 90 it averages in the run's curvature.  The
    // fan it fits is stable across the sweep (0.00089-0.00099 /px).  A window
    // the sweep cannot fill (fewer than half its columns painted, or a frame
    // whose discarded half does not reach) declines and the block is placed
    // exactly as before, which the ledger says.
    //
    // SANITY, NOT TUNING.  A fitted slope beyond 0.5 px/px (27°) is not a
    // trajectory, it is a failed correlation, and the estimator declines
    // rather than clamps: a clamped nonsense value would still shear the
    // block by the cap.  The FAN's bound is a function of the span the map is
    // carried over (`detail::crossTrajFanWithinSpan`): the map's cross scale
    // at Δu is 1 / (1 − a·Δu), a pole at Δu = 1/a, and every tail block on
    // disk spans 277–401 px — a flat cap of 0.006 /px accepted fans whose
    // pole sat INSIDE the block (a = 0.004 mirrors the far end of a 296 px
    // block).  The rule is |a|·L ≤ 0.3, i.e. the far end is scaled by no
    // more than 1.43x (or 0.77x), with L the block's own span (relax mode:
    // the relaxed magnification's own reach, L_r·(1 − e^(−L/L_r))).  A band
    // whose quadratic fit leaves more than 0.75 px rms is a band that locked
    // onto nothing, and it is dropped before the across-band fit; a fan is
    // fitted only when at least 8 of the 24 bands survive (a gradient across
    // the cross axis needs that axis sampled), else the slope alone is.
    int    crossTraj = 0;
    double crossTrajWindowPx = 60.0;
    bool   crossTrajFan = true;
    /// HOW FAR the continuation is carried into the block.  0 (the plan as
    /// approved) continues the fitted slope and fan across the WHOLE block —
    /// which on the operator's 12-48-28 is a 0.09 %/px cross-scale gradient
    /// carried 296 px, i.e. the block's far end magnified ~1.4x about the
    /// axis (canvas 1034 → 1346 px wide).  A positive value is an e-folding
    /// length in canvas px: the slope and fan are continued exactly at the
    /// join (the hinge is still gone) and decay as exp(−Δu/L), so the far
    /// end returns to the frame's own geometry.  Measured on that pack with
    /// L = 100: the same paired hinge removal at the join (−0.21 [−0.27,
    /// −0.15] n=20 against −0.20 [−0.26, −0.11] n=17), canvas 1034 → 1090.
    /// Realised per slice — the decay is a smooth function of Δu matched at
    /// each slice's midpoint, with a ≤ 0.1 px mismatch between slices at the
    /// cross extremes.  Both arms are in the change's evidence; the choice
    /// between them is the operator's, which is why it is a knob and why the
    /// default is the brief's.
    double crossTrajRelaxPx = 0.0;
    /// Also re-place the SEED's rear half at finish() under the trajectory of
    /// the first strips.  The seed is committed before any strip exists, so
    /// its continuation is necessarily retroactive: the reference frame is
    /// retained (one shallow cv::Mat reference — the frame the engine already
    /// cloned for the latch, kept instead of released) and the rear half
    /// `[seedX0, seedCentre)` is repainted at finish through the seed's own
    /// law plus the trajectory map — and through the same v10 lens resample
    /// the seed was painted with, so the repaint does not put the barrel
    /// distortion back into a half of the seed the ledger says is corrected.
    /// Nothing but the seed ever owns those columns, so the repaint cannot
    /// touch a strip.  Measured on 12-48-28 the seed's hinge is -0.03 px/row
    /// — at the floor — which is why this is its own switch: it is the same
    /// routine at the sweep's other end, and it must be measurable on its
    /// own.  The repaint is NOT byte-identical to the seed's own paint at a
    /// zero trajectory: the seed walked `arcSeedH` in φ, the repaint walks
    /// the same arc law in canvas px (`arcSlicesAbout`), and the two slice
    /// boundaries differ by the slice-linearisation residual (≤ 0.1 px).
    bool   crossTrajSeed = true;

    // ── THE PREVIEW'S LEAD-OUT STARTS AT THE FRONTIER ──────────────────
    // Default OFF, preview-only, the canvas path never reads it.
    //
    // THE OPERATOR'S TWO LINES.  Measured per tick on his 15-51-02 pack: the
    // upper line is the frontier (highWater); the lower line is the seed's
    // committed footprint end (848).  Between them the preview shows the
    // SEED's provisional lead-in — pixels 4.4 s / 266 frames old that the
    // strips have not reached yet — and the live lead-out is appended only
    // PAST that stale band.  Both lines are registration breaks (5.5-6.3x
    // structural score), not brightness; the dim was already removed.
    //
    // WITH THIS ON the live frame is warped from `ceil(highWater)` — the first
    // column no strip has committed — over the stale band AND past it, so the
    // preview carries exactly one boundary: the frontier, which is the only
    // place pixels are being added.  `ceil`, not `floor`: strips commit to
    // `ceil(rightEdge)`, so `floor(highWater)` is a committed column and
    // painting it with live pixels is the 33 DN drift the byte-identity test
    // caught in v12.  The band is painted OVER, not cleared first: where the
    // live frame's mask does not reach (the cross corners the seed's frame
    // reached and this frame's does not) the seed's pixels stay, because a
    // cleared corner is a black notch in the very preview this exists to
    // quieten (measured: 168 rows with a ≥ 16 px black run on 15-51-42 tick
    // 16 when it was cleared).  `PreviewWindow::leadStartU` /
    // `leadOverwritePx` report where the live paint began and how much stale
    // band it replaced, so a per-tick reader can see the lead-out start at
    // the frontier rather than infer it.
    //
    // WITH THIS ON the lead-out is also resampled THROUGH THE LENS the flush
    // will use (v10) — the plain warp v12 shipped differs from the committed
    // block by the field, up to 23 px at the ultra-wide corners on the 09-05
    // packs, which is a line at the frontier.
    //
    // WITH `crossTraj` ON AS WELL the lead-out is placed under the tail's
    // trajectory, and the preview's SCRATCH is padded to where that puts the
    // block (`leadPadTopPx` / `leadPadBotPx`) exactly as `finish()` grows the
    // band for it — a first cut allocated the scratch at the canvas height
    // and the sheared block ran off it, so the preview showed a crop of what
    // the flush then committed (381 content px in the outermost 3 columns on
    // 15-51-02 tick 24 against 29 with the flag off).  The PUBLISHED rows are
    // not padded: they are the same rows `leadOutTraj = false` publishes on
    // the tick, so the preview never changes size for the trajectory (a
    // second cut widened them too, and the panel breathed on 41 of 45 ticks
    // of the 2026-09-07 pack — see the lead-out block).
    bool   leadOutFromFrontier = false;
    // WHETHER THE LEAD-OUT FOLLOWS THAT TRAJECTORY AT ALL.  With `crossTraj`
    // on, every preview tick re-runs the tail's trajectory estimate on the
    // live frame and shears/fans the provisional block under it — the exact
    // image the flush will commit, at the cost of the estimate and the taller
    // scratch on every tick.  OFF: the lead-out is placed exactly as
    // `leadOutFromFrontier` places it, from the same frontier, through the
    // same lens, but under the plain `lastHint` warp — no fitted slope, no fan
    // (`PreviewWindow::leadTrajApplied` false, slope / fan 0, pads 0), the
    // cheap route.  The seed repaint and the tail flush are not this knob's:
    // they read `crossTraj` alone, so the FINAL canvas is byte-identical
    // either way — this only decides what the operator sees ahead of the
    // frontier while the sweep is live, and what each tick costs.  The
    // PUBLISHED SIZE is not this knob's either: on any tick both settings
    // publish the same (imageW, imageH, viewCrossPx, canvasCrossPx) — only
    // the pixels ahead of the frontier differ (2026-09-07).
    bool   leadOutTraj = true;

    // ── v5 CROSS-SWEEP PLACEMENT ────────────────────────────────────────
    // K correlation windows spread ACROSS the sweep instead of one at the
    // centre.  Slot (K−1)/2 is v4's window VERBATIM — same origin, same
    // clamp, same buffer — so the value that drives the chain is
    // bit-identical and crossSweepFit == false reproduces v4's posNat
    // sequence element for element (verified on all four device packs).
    // The outer slots buy exactly one extra degree of freedom and, for free,
    // the cut metric.
    bool crossSweepFit = true;
    // 1 = per-frame image-fitted gradient.  MEASURED AND NOT DEFAULTED: its
    //     residual is measured against its own fit, so it always scores well;
    //     it is kept only so the A/B can be re-run.
    // 2 = plane at subjectDistanceM (DEFAULT).  The cross magnification is
    //     PREDICTED from the pose (exp(−forward/d)) and is therefore absolute
    //     — it cannot random-walk — and the metric that scores it is
    //     independent of it.  Measured against every fixed d tried (1.0 /
    //     1.5 / 2.5 m) the online fit wins on every pack.
    int crossFitMode = 2;
    // ODD and >= 1.  configure() REJECTS an even value: crossWindowCount()
    // collapses anything below 3 to a single window, so `2` used to disable
    // every outer slot AND the cut metric silently — a validated knob value
    // that turned the integrity gate green is exactly the blind verdict this
    // version exists to remove.
    int    crossWindows = 3;          // odd; 1 disables the outer slots
    // ── v8: MULTI-WINDOW CHAIN AVERAGING.  BUILT, MEASURED, DEFAULT OFF. ──
    //
    // The engine already correlates K windows across the sweep (they are what
    // the cut metric is made of) and then drives the chain from ONE of them,
    // throwing the other K−1 measurements away.  With this on, the cross
    // advance that MOVES THE CHAIN is the response-weighted, gradient-
    // corrected mean of all K.  With one window it reduces to the centre
    // window exactly — every term is referred back to ξ_c — so it costs
    // nothing to leave computed and cannot change a K=1 session.
    //
    // ⚠ THE 22-35% SEAM WIN DOES NOT SURVIVE AN INDEPENDENT INSTRUMENT.  Read
    // this whole block before flipping the flag; the first draft of this
    // comment quoted only the first table and would have shipped it.
    //
    // MEASURED, offline twin, all four operator packs, K=3 vs the shipped
    // chain (seamWorstBand p95, canvas px):
    //     15-57-16  0.38 → 0.25      15-58-22  0.38 → 0.25
    //     15-59-29  0.35 → 0.23      16-00-28  0.41 → 0.32
    // 22-35% better on 4 of 4, with `painted`, `holes` and
    // `maxAreaScalePainted` byte-identical on every pack (it changes WHERE a
    // strip goes, never WHICH strips go or how far they are warped).  The
    // control arm — K=5 windows measured but NOT averaged — is 1.01-1.07×,
    // i.e. the movement is the averaging and not the extra windows.
    //
    // BUT seamWorstBand IS THE RESIDUAL OF THE K MEASUREMENTS THIS AVERAGES.
    // With the flag off the chain is driven by ONE of the K and scored on all
    // K, so K−1 of those residuals are independent of the placement.  With it
    // on the placement is the weighted least-squares centre of the same K, so
    // the metric is the fit's own residual and MUST fall.  The engine already
    // refuses to default `crossFitMode == 1` for exactly this reason; the same
    // trap was walked into again here and caught by re-measuring against the
    // instrument that cannot be fitted — `seamCanvasJogPx`, committed pixels
    // correlated through the painting matrix.  Same four packs, same twin,
    // K=3, jog p95 / max in canvas px:
    //
    //     15-57-16   p95 0.307 → 1.026   max 0.801 → 1.327   3.3× WORSE
    //     15-58-22   p95 0.874 → 0.856   max 1.101 → 1.259   flat / worse
    //     15-59-29   p95 0.641 → 0.318   max 0.942 → 0.452   2.0× better
    //     16-00-28   p95 0.568 → 0.759   max 1.451 → 1.460   1.3× worse
    //
    // Two worse, one flat, one better.  So the honest statement is that the
    // averaging moves the placement toward the K windows' consensus and that
    // consensus is right on one pack of four — NOT that it is a free seam fix.
    // K=5 is the same picture (jog p95 ×3.28 / ×0.85 / ×0.40 / ×1.26).
    //
    // IT IS NOT A WOBBLE FIX either, and is not defaulted on as one.  Its
    // effect on the ruler-measured wobble is 3/4 down at K=5 and 2/4 at K=3
    // (offline verdict, paired direction) — no consistent sign, which is the only
    // test n=4 supports.
    //
    // A PREVIOUS VERSION OF THIS COMMENT DISMISSED IT WITH A SCATTER FIGURE —
    // "split-half of an UNCHANGED capture moves rms by 1.13-3.53×" — and that
    // figure is WITHDRAWN: no script or artefact in
    // results/2026-08-23-panoplus-anchor-ab/ produces it, and the twin has no
    // split-half mode to produce it with.  Nothing here rests on it: the seam
    // table above is deterministic and ledger-derived, and it is what the
    // refusal rests on.  The same withdrawal applies wherever the anchor's
    // wobble amplitudes were compared against it — those tables are SUPPORTING
    // evidence with no scatter estimate attached, and are labelled as such.
    //
    // ONE MORE THING TO KNOW BEFORE FLIPPING IT: with K windows averaged, the
    // committed cross advance is a weighted mean of K candidates, each of which
    // only had to pass |a_k − r0| <= maxAdvancePx individually (the per-window
    // admission test), plus a gradient correction of up to
    // crossGradMaxPerFrame·|xi_k − xi_c|.  `advCrossUsed` is not re-checked
    // against the single-window cage afterwards, so the effective CROSS bound
    // is up to ~2× maxAdvancePx while the flag is on.  The ALONG channel — the
    // one the aliasing cage and the interior-gap guarantee consume — is
    // untouched.  Re-check or re-bound that before this ever defaults on.
    //
    // SO: OFF, and the reason is a measurement rather than caution.  Two
    // further reasons to leave it reachable rather than delete it: the numbers
    // above are the offline TWIN's, and the twin is a good but not exact model
    // of this engine (graded against the shipped ledger of pack 15-57-16:
    // 98.4% outcome match, posU max |Δ| 2.2 px, 346 painted vs the device's
    // 351); and if a device pack ever shows the jog moving the other way, the
    // arm is one option key away.  When it IS on, SessionStats::
    // seamBandSelfScored goes true and the integrity verdict says so in words,
    // so no future reader can quote the band p95 as independent evidence.
    bool   crossAvgWindows = false;
    double crossSpanFrac = 1.0;       // of the clamped origin range
    double crossGradMaxPerFrame = 0.02;
    double crossScaleCageFrac = 0.50; // |log(cross scale)| bound
    // ── DC-FREE INTEGRATION FOR crossFitMode 1.  DEFAULT 0 = OFF, and off is
    //    BYTE-IDENTICAL to the shipped path. ────────────────────────────────
    //
    // Mode 1 integrates a per-frame image-fitted gradient with no absolute
    // anchor, and it RUNS AWAY.  Measured 2026-09-16 on three packs replayed
    // through the offline twin, crossScale at the end of the sweep:
    //     A 1x wide  1.000000 -> 0.815286      B 0.5x ultra-wide -> 0.777575
    //     C the CLEAN landscape control        1.000000 -> 0.633656
    // Confirmed in PIXELS independently of the engine's own numbers by
    // measuring painted content extent along the sweep (ratio-of-ratios 0.813
    // / 0.775 / 0.633, agreeing with the ledger to 0.003).  On the clean pack
    // it opens black voids and truncates the bottom shelf.  That is why mode 1
    // is not the default and must not become it without this.
    //
    // ⚠ THE DAMAGE AND THE CORRECTION ARE SEPARABLE, WHICH IS THE WHOLE POINT.
    // Splitting the fitted gradient into its steady and wobble parts:
    //     pack   mean g       AC rms      |DC|/rms   integrated drift
    //     A     -0.000281    0.001116      0.245        -0.2079
    //     B     -0.000624    0.001070      0.504        -0.2536
    //     C     -0.001512    0.002488      0.519        -0.4560
    // The DC fraction is LARGEST on the pack with NO wobble to correct — on
    // the clean control mode 1's output is almost entirely drift.  Removing
    // the steady part ends crossScale at 0.999 on all three while retaining
    // the wobble-frequency power that actually straightens the rails.
    //
    // Implemented as a LEAKY INTEGRATOR on log(crossScale) rather than as a
    // mean subtracted from g: one parameter, it bounds the runaway directly
    // (the runaway IS the damage), and it needs no estimate of a mean the
    // sweep may not be long enough to form.  Per frame:
    //     log s  <-  (1 - leak) * (log s + g)
    // so the integrator's DC gain becomes 1/leak instead of infinity.  Pick
    // leak against the SEPARATION: the wobble runs 250-1200 canvas px
    // (~3.5 cycles per sweep) and the drift is one, so there is roughly 3.5x
    // of room and the leak must sit inside it.
    //
    // NOT the photometric `gainLeak`, which was REFUTED on committed pixels.
    // Different axis, different quantity, different evidence; the name is
    // deliberately distinct so the two are never conflated.
    double crossScaleLeak = 0.0;      // per-frame leak on log(cross scale)
    // ── AND THE ONE THAT ACTUALLY SELF-ADAPTS.  DEFAULT 0 = OFF. ──────────
    //
    // ⚠ THE LEAK ABOVE WAS MEASURED FIRST AND IS NOT ENOUGH ON ITS OWN, which
    // is recorded here rather than quietly dropped.  A leaky integrator driven
    // by a constant DC g0 settles at log s = g0 / leak, so the residual squash
    // scales with EACH PACK'S OWN DC and one fixed leak cannot serve two packs.
    // Measured 2026-09-16, crossScale at sweep end:
    //     leak      pack A (DC -0.000281)      pack C, CLEAN (DC -0.001512)
    //     0.000           0.8155                        0.6337
    //     0.020           1.0001                        0.8534
    //     0.100             —                           0.9773
    // A needed 0.020; C still fails the do-no-harm gate at five times that.
    // The ratio is the ratio of their DCs, exactly as the steady state says.
    //
    // SUBTRACTING THE MEAN REMOVES THE DC WHATEVER ITS SIZE, which is why the
    // validated counterfactual used it: it ended crossScale at 0.9996 / 0.9998
    // / 0.9993 on all three packs while retaining the wobble-frequency power.
    // Implemented as a CUMULATIVE running mean rather than an EMA, deliberately
    // and for a reason the packs force: the wobble runs 78-375 frames per cycle
    // so an EMA must have a time constant well past that to pass it, and the
    // CLEAN pack is only 214 strips long — an EMA slow enough to be honest
    // would never leave its own initial value on a sweep that short.  The
    // cumulative mean converges to the true mean with no time constant to tune
    // and no length to assume, and the integral of (g - mean) telescopes toward
    // zero by construction.
    //
    // ⚠ WHAT IT COSTS, AND IT IS NOT NOTHING: it also removes a GENUINE slow
    // scale change — an operator who really does walk closer across the sweep.
    // That ambiguity is not resolvable from the image alone; it is exactly what
    // pose translation would settle, and on an imu-attitude-only arm there is
    // none.  So this is the right tool for a sweep at roughly constant standoff
    // and the WRONG one for a deliberate dolly, and nothing in the engine can
    // currently tell those apart.
    int crossFitDcRemove = 0;         // 1 = integrate (g - running mean of g)
    // ── THE OBSERVABILITY GATE.  0 = off (no gate), the shipped behaviour. ──
    //
    // The mode-1 gradient is a straight-line fit of the K windows' measured
    // cross advance against their cross position.  When the scene HAS structure
    // crossing the cross axis the bands line up on that line; when it does not,
    // they scatter and the "gradient" is the fit of a line to noise — which is
    // then INTEGRATED, so the noise becomes drift.
    //
    // ⚠ THIS IS WHY THE CLEAN PACK BROKE, and it is a property of the GESTURE.
    // On a landscape-hold vertical sweep the cross axis runs ALONG the shelf
    // rails, and a uniform rail offers nothing to measure across its own
    // length.  Measured 2026-09-16 with the correction otherwise fully on, the
    // clean control still ended at crossScale 0.9017 — a 10% vertical squash
    // applied to a sweep that had nothing wrong with it — while the two
    // sideways packs it was built for reached 0.9976 and 0.9628.  No setting of
    // the DC removal or the leak fixed that, because the input was never signal.
    //
    // So the gate is on the FIT, not on the hold: require the band fit to
    // actually explain the bands (R^2 over the K windows) before the gradient
    // is allowed to move the chain.  A gesture-keyed gate would read the same
    // way on these three packs and be wrong on the first scene that breaks the
    // correlation — a shelf photographed end-on, a bare wall, a dark aisle.
    //
    // Needs >= 3 windows to mean anything; with crossWindows == 1 the fit has
    // no residual and the gate passes vacuously, which is stated here so nobody
    // reads a passing gate on a K=1 session as evidence of anything.
    double crossFitMinBandR2 = 0.0;   // 0 = ungated; 0.5-0.7 is the useful band
    // THE OPERATOR'S VIRTUAL PLANE.  Answering his question with a number,
    // and stating the scope of that answer exactly:
    //
    //   Under ROTATION the rectifying homography is K0·R·Ki⁻¹ and carries no
    //   plane term at all, so re-deriving it as "ray → virtual plane at d →
    //   pixel" gives the SAME matrix for every d — the d cancels between the
    //   ray/plane intersection and the plane/pixel scale (measured: max
    //   |Δcanvas| 1.6e-12 px at d = 0.3 m, 9.1e-13 at 1.0 m, 1.4e-12 at
    //   3.0 m).  Moving the plane therefore cannot change the warping.
    //
    //   Under TRANSLATION the plane term t·nᵀ/d does NOT cancel, and that is
    //   the whole reason this knob exists: d is what converts the pose's
    //   forward travel into the canvas CROSS SCALE (crossFitMode 2), which is
    //   where the cuts live.  So the answer is "no" for the warping and "yes,
    //   and it is already wired" for the cuts — not "a plane does nothing".
    double subjectDistanceM = 1.5;
    bool   subjectDistanceAuto = true;   // refine d online from the K windows

    // ── v5 METRICS ──────────────────────────────────────────────────────
    // Off makes the engine blind again; it exists only so the cost can be
    // measured.  The K windows are shared with crossSweepFit, so the metric
    // costs nothing extra when the fit is on.
    bool seamMetrics = true;

    // ── v13: THE JOG GUARD — refuse, never move ─────────────────
    // The 2026-08-31 tau=0 packs committed 92/110 px cuts while the image
    // chain read a smooth 1.1 px/frame: the placement was wrong, not the
    // chain.  When the PRE-COMMIT canvas jog (the same phase-correlation
    // measurement the ledger already carries, run before the gain fit — it is
    // normalised by cross-power magnitude, so the pending gain cannot move
    // it) exceeds `d8JogBarPx`, the strip is REFUSED rather than painted.
    // Fail-closed and bounded: after `d8JogMaxRun` consecutive refusals the
    // commit is accepted anyway (and counted as forced), so a genuine
    // divergence delays by at most that many strips instead of stalling the
    // sweep.  The measurement feeds NOTHING into placement — measure, never
    // move — and the twin-refuted junction re-anchor is the cautionary
    // sibling (its step re-base minted new kinks; review of 2026-08-31).
    // Default OFF (byte-identical); the instrumented internal baseline ships
    // it ON.  Requires `seamMetrics` (validated): with metrics off the
    // measurement silently returns invalid and the guard would be a no-op
    // that LOOKS armed.  Twin-validated on the five tau=0 packs: removes the
    // one committed >8 px cut it was aimed at (18.4 -> 1.9 px, one refusal)
    // and never lost a column of coverage; its known limit — a persistent
    // parallax divergence is deferred, not fixed (139.9 px event: deferred
    // 22 strips when the guard acted alone).
    bool   d8JogGuard  = false;
    double d8JogBarPx  = 8.0;
    int    d8JogMaxRun = 5;

    // ── LOW-LIGHT REGISTRATION GATE (2026-09-07) ────────────────────────
    // The 2026-09-07 packs (ISO 1839-3034 at 1/60 s, a textureless white
    // ceiling right after the seed, a striped wallpaper) wobble on the CROSS
    // axis while `response` reads 0.82-1.11.  cv::phaseCorrelate's response
    // scores how clean the peak is RELATIVE TO ITS OWN SURFACE, not whether
    // the window held anything to register, so `minPhaseResponse` cannot
    // fire on a flat window that returns a confident quarter-pixel of noise
    // — and the chain adds that quarter pixel to the attitude every frame
    // (advanceTot = advanceRot + advance) until it is the several-pixel
    // S-wave the attic canvas shows.  Nothing in the engine before this
    // block measured the WINDOW'S texture or the SURFACE'S shape; the
    // corrCentroidBoxPx note above had already seen the shape (peak/total
    // 0.12-0.22 on real pairs vs 0.21-0.54 on a synthetic translation) and
    // this is that instrument, ledgered.  Instrument first, gate second:
    //
    //   crossResidualGate  0  OFF — no statistic computed, no ledger field
    //                         written that was not written before.
    //                         Byte-identical; pinned by
    //                         PanoCrossGate.OffWritesNoNewFieldAndMatchesTheShippedCanvas.
    //                      1  LOG-ONLY — on every frame that reached the
    //                         centre correlation the statistics below are
    //                         computed on the PRISTINE work-scale windows
    //                         (the correlation itself saw copies) and
    //                         ledgered beside the residual.  Placement is
    //                         untouched and advanceTot == advanceRot +
    //                         advance holds row for row exactly as at 0
    //                         (PanoCrossGate.LogOnlyLeavesPlacementUntouched).
    //                         The thresholds are chosen from this arm over
    //                         the corpus, not guessed.
    //                      2  GATE (design steps 3 + 4) — the statistics are
    //                         computed as at 1, and on every LATCHED frame
    //                         that passed the response floor and the cage
    //                         the MEASURED CROSS RESIDUAL (advanceY on axis
    //                         0, advanceX on axis 1) is set to 0 before it
    //                         reaches the accumulators and the chain update
    //                         when any live test fails, so the frame is
    //                         placed by the attitude on that axis:
    //                         advance's cross component reads 0, advanceTot's
    //                         equals advanceRot's, crossResidualRawPx keeps
    //                         the measurement, crossGated carries the reason
    //                         bitmask and the crossGated* counters move.  A
    //                         PLACEMENT decision only: crossMeasure still
    //                         reads the MEASURED residual, so the outer
    //                         windows' gradient fit, the per-band cage and
    //                         the K-window mean are the log-only engine's on
    //                         the same frame, and with crossAvgWindows on the
    //                         chain applies the gated value all the same —
    //                         the K-window mean is pinned to it, so
    //                         crossAvgDeltaPx reads exactly 0 on every gated
    //                         row and advanceTot == advanceRot is true of the
    //                         chain, not only of the row (the first arm fed
    //                         crossMeasure the gated 0; review finding 1,
    //                         2026-09-07 — pinned by PanoCrossGate.
    //                         GatedFrameIsAttitudePlacedWithAvgWindowsOn /
    //                         GateLeavesTheOuterFitOnTheMeasurement).  The
    //                         along-axis component is never touched; the
    //                         outcome, chainAdvanced and the d8 jog guard's
    //                         eligibility are the shipped ones (a gated frame
    //                         still reaches the guard, on its attitude
    //                         placement — design (e)).  Before the axis latch
    //                         nothing is gated: the chain applies both
    //                         components there and "the cross axis" is not
    //                         yet a fact about the sweep.  The cage and the
    //                         response floor judge the MEASUREMENT and run
    //                         first, so the reject population is the shipped
    //                         one.  Reasons: 1 texture (crossTextureVar <
    //                         crossTextureMinVar), 2 peak (crossPeakPSR <
    //                         crossPeakMinPSR or crossPeakMass <
    //                         crossPeakMinMass), 4 periodicity (guard (b)
    //                         below).  A threshold at 0 disarms that test; a
    //                         non-finite statistic fails CLOSED.  configure()
    //                         refuses 2 with every threshold at 0 and no
    //                         guard — the armed-looking no-op the d8JogGuard
    //                         validation exists to forbid.
    //                         Pinned by PanoCrossGate.FlatWindowFallsBackToAttitude
    //                         / TexturedWindowIsUntouched / IdentityHoldsOnGatedRows
    //                         / AlongAxisIsNeverGated.
    //
    // GUARD (b) — crossPeriodGuard 1 (requires crossResidualGate 2 and at
    // least one of its two thresholds > 0; refused otherwise): reason 4 when
    //   |measured cross step − attitude cross prediction| >
    //       crossPeriodMaxFrac × crossDominantPeriodPx,
    // where the measured cross step is advanceRot + advance and the attitude
    // predicts advanceRot, so the deviation IS the residual — the rule is
    // referred to the ATTITUDE, never to zero: a one-period step the attitude
    // carried and the estimator agreed with has a residual near 0 and passes
    // (Risk 2, PanoCrossGate.RealTranslationOfOnePeriodPasses), while the
    // alias — measured on the tiled fixture: a one-period yaw step on which
    // the estimator locks to the zero-lag peak and reports a residual that
    // CANCELS the attitude, advanceTot ≈ 0 while the camera turned — is a
    // whole period off the attitude and is refused
    // (PanoCrossGate.PeriodicWindowRejectsWholePeriodJump).  Or when
    //   crossPeakSecondary ≥ crossPeakSecondaryFrac
    // — a second peak comparable to the primary one period away, the direct
    // test of ambiguity, which fires on a periodic window whatever the truth
    // (a wallpaper is ambiguous on every frame) and never on an aperiodic
    // one (PanoCrossGate.AperiodicWindowPassesPeriodGuard).  Which of the two
    // survives is a step-2 decision still open.  Note the period
    // instrument reads the mean profile's loudest HARMONIC (6 / 12 / 24 canvas
    // px on a 24 px tile), which makes the N× rule stricter than the
    // fundamental would.
    //
    // THE STATISTICS (FrameOutcome::cross*, one row each; work px unless
    // stated; `detail::` exposes each so it can be pinned on its own):
    //   crossTextureVar       variance of the 3x3 Laplacian of the current
    //                         window (DN²) — texture energy.  Computed over
    //                         the whole buffer the correlation used,
    //                         BORDER_CONSTANT padding included, so it scores
    //                         what the estimator actually saw.
    //   crossPeakPSR          peak-to-sidelobe ratio of the whitened
    //                         cross-power surface: (peak − mean of the
    //                         surface outside the centroid box) / that
    //                         region's standard deviation.
    //   crossPeakMass         |surface| mass inside the centroid box over the
    //                         whole surface's |mass|.  ABSOLUTE, and the
    //                         reason is arithmetic: the SIGNED total of the
    //                         DFT_SCALE'd surface is the whitened DC term,
    //                         identically ≈ 1, so a signed ratio collapses to
    //                         the 5x5 `response` it is meant to complement.
    //   crossDominantPeriodPx dominant spatial period of the window's mean
    //                         CROSS-axis profile — argmax of its 1-D power
    //                         spectrum with DC and periods > window/2
    //                         excluded — converted to CANVAS px through
    //                         canvasScale / workScale.
    //   crossPeakSecondary    the largest surface value outside a band ONE
    //                         PERIOD WIDE centred on the primary peak
    //                         (|cross offset| < period/2 excluded, never
    //                         narrower than the centroid box; full extent
    //                         along the sweep axis), over the primary.  On a
    //                         periodic window the alias peak sits one period
    //                         from the primary, so a full-period exclusion
    //                         would exclude the very peak this looks for.
    //   crossResidualRawPx    the measured cross residual (advanceY for
    //                         axis 0, advanceX for axis 1, canvas px, the
    //                         same selector the chain update reads) BEFORE
    //                         any gating — equal to the applied one in
    //                         log-only mode.
    // The cross axis is read from the latched axis; before the latch it is
    // whatever the chain would read (axis 0), and the row says which by its
    // position in the sweep.  A non-finite statistic is ledgered as null;
    // the gate (step 3) treats it as "no texture" — fail-closed, never a NaN
    // into the chain.
    //
    // THRESHOLDS — all 0 (every test disarmed) until the log-only pass over
    // the 22 pano+ packs AND a shelf-pack corpus sets them:
    //   crossTextureMinVar / crossPeakMinPSR / crossPeakMinMass   gate (a);
    //   crossPeriodGuard 0/1, crossPeriodMaxFrac,
    //   crossPeakSecondaryFrac                                    guard (b).
    // Field posture: OFF in production; the instrumented internal build
    // flips it only
    // after the shelf packs' crossGated* counters are shown to stay low.
    int    crossResidualGate = 0;
    double crossTextureMinVar = 0.0;
    double crossPeakMinPSR = 0.0;
    double crossPeakMinMass = 0.0;
    int    crossPeriodGuard = 0;
    double crossPeriodMaxFrac = 0.0;
    double crossPeakSecondaryFrac = 0.0;
    // Per-strip pull of the chained gain back toward unity.  STILL OFF in v6,
    // and the reason is a measurement that REFUTED turning it on.
    //
    // The offline owner map found the chain to be an unanchored multiplicative
    // accumulator whose per-strip error integrates into 10-24% excursions over
    // a 40-column window, and inferred that this leak was the fix.  v6 built
    // the instrument to check that inference on COMMITTED PIXELS — integrating
    // the signed per-boundary DC step, so the camera's own drift is included
    // rather than invisible — and the answer is the opposite of the applied-
    // field's.  Measured on all four device packs (committed local band % /
    // committed end-to-end drift %):
    //
    //   pack       leak 0.00      leak 0.15      leak 0.40      leak 0.60
    //   15-57-16   14.7 / 18.3    13.2 / 51.1     8.9 / 65.2     6.4 / 68.6
    //   15-58-22    7.7 / 11.3     5.8 / 34.8     5.7 / 47.5     8.0 / 50.9
    //   15-59-29    6.9 /  8.7    10.5 / 52.1     9.8 / 66.6     9.1 / 68.7
    //   16-00-28    8.5 / 12.7    12.1 / 51.3    10.0 / 57.5     8.3 / 56.2
    //
    // The leak makes the END-TO-END drift 3-6× WORSE on every pack and the
    // local band worse on half of them.  The chain is doing real work: at
    // leak 0.6 it has effectively stopped correcting and the deliverable
    // carries +51 to +69% of camera drift — which independently reproduces the
    // owner map's own measurement of the camera (C = 1.50-1.79) from a
    // completely different construction, and is the calibration check for this
    // instrument.
    //
    // WHY THE EARLIER INFERENCE WAS WRONG: the 10-24% figure is peak-to-peak
    // of the field the ENGINE APPLIED, which is the engine scoring its own
    // correction — the same class of blind verdict v5 exists to remove.  The
    // committed band is 6-15% at leak 0 and does not improve with the leak.
    //
    // WHAT THIS LEAVES: at leak 0.6 (chain effectively off) the committed
    // local band is still 6.4-9.1%, i.e. the CAMERA's own auto-exposure is
    // producing 6-9% excursions over 40 columns on its own.  That is what the
    // capture-side lock removes, and it is why the lock — not this knob — is
    // v6's answer to the banding.
    //
    // REOPEN CONDITION, stated so it is not re-litigated from the mechanism:
    // a pack captured WITH exposure metadata.  Once each frame is normalised
    // exactly, the residual the chain fits is ≈1 by construction and pulling
    // it to 1 can no longer destroy information — but no such pack exists yet,
    // so shipping a non-zero default would be shipping an untested one.
    double gainLeak = 0.0;

    // ── v6 RADIOMETRIC NORMALISATION ────────────────────────────────────
    // Strictly better than estimating exposure from image overlap, because it
    // does not have to be estimated at all: iOS reports the exposure each
    // frame was taken at, and scene radiance is LINEAR in duration × ISO.  So
    // every frame is scaled to the REFERENCE frame's exposure exactly, before
    // any overlap fit runs, and the chained fit is left only the residual
    // (lens shading, flare, sensor non-linearity) to correct.
    //
    // IDENTITY when the metadata is absent (FrameInput::exposureDurationS or
    // exposureISO ≤ 0) — which is the case for every pack captured before
    // this version, so a v5 pack replays BYTE-IDENTICALLY through this path.
    //
    // Applied in LINEAR LIGHT via a 256-entry sRGB LUT, not as a naive scale
    // on the encoded pixels: exposure is linear in radiance and the raster is
    // gamma-encoded, and for a 1.8× exposure swing (which is what an unlocked
    // AE actually does over a sweep — measured C = 1.50-1.79) the two differ
    // materially in the shadows.  The RESIDUAL corrector stays in the encoded
    // domain, where it is both fitted and applied, so it is self-consistent.
    bool   exposureNormalize = true;
    // ±2 stops.  A ratio outside this is not an exposure change, it is bad
    // metadata; it is clamped AND counted (SessionStats::exposureClampedFrames)
    // rather than trusted.
    double exposureGainClamp = 4.0;

    // ── v6 PHOTOMETRIC SEAM METRIC ──────────────────────────────────────
    // The step is measured over the WHOLE shared footprint of the two owners
    // and accepted only when it is UNIFORM across the boundary: a real scene
    // edge that is misregistered produces a large but ragged difference, an
    // exposure mismatch produces a flat DC offset.  Without the uniformity
    // test the metric would fire on the geometry defect it is not measuring.
    // Shared LOW-GRADIENT pixels needed before a boundary is measured at all.
    // Below this the median is not a median, it is a small sample.
    int    photoMinSamples     = 1500;
    // "Low gradient" in DN per pixel, measured on the already-committed side.
    // Photometry is only measurable where the scene has no structure of its
    // own: on a textured pixel a quarter-pixel of misregistration moves the
    // value by more than any exposure step.  8 DN/px keeps 40-60% of a real
    // shelf raster (measured on the operator's packs) and excludes every edge.
    double photoGradMaxDN      = 8.0;
    // Reporting floor for `seamPhotoUniform`.  A boundary below it is counted
    // in SessionStats::seamPhotoNonUniform as a DIAGNOSTIC — it is NOT
    // excluded from the percentiles, because excluding it would condition them
    // on the boundaries that happened to look flat (the same bug the v5 luma
    // metric's own comment warns about).
    double photoUniformMinFrac = 0.60;
    // How many bands the boundary's OWN EXTENT (canvas rows, i.e. the
    // cross-sweep direction) is split into for that uniformity test.  An
    // exposure change offsets every point along a boundary identically; a
    // scene edge, a shading ramp or a local misregistration does not.
    //
    // 4 is a measured choice, not a round number: the earlier PER-PIXEL form
    // of this statistic flagged 71-99.7% of boundaries "non-uniform" on the
    // operator's four packs — at the operating point the spread of a
    // low-gradient difference field is dominated by the residual sub-pixel
    // resample, not by the step, so it could not discriminate anything.  The
    // across-extent form flags 8.5 / 12.5 / 16.5 / 21.3% on the same packs.
    int    photoUniformBands   = 4;
    // The BAND instrument.  A per-boundary step of 0.2 DN is invisible; the
    // same chain drifting 14% over 40 columns is the thing the operator can
    // see.  Peak-to-peak of the APPLIED photometric field over a sliding
    // window this wide (canvas columns along the sweep).
    int    photoLocalWindowPx  = 40;

    // ── v10: LENS UNDISTORTION (geometric fidelity) ─────────────────────
    //
    // WHAT THIS IS FOR, and what it is NOT for.  It is NOT a wobble fix: that
    // hypothesis was measured and refused (the correlation window is pinned to
    // the raw frame centre where the radial field is zero — total view travel
    // < 3 px over a whole sweep — so distortion is ≤ 2 % of the wobble
    // variance).  What the lens DOES cost is GEOMETRIC FIDELITY: straight
    // world edges are not straight in the delivered panorama.  Measured
    // model-free by pairing slat edges between arms, the lens puts 3.7-4.5
    // canvas px of cross displacement peak-to-peak into the deliverable, of
    // which 0.67-0.78 px survives a global affine (the part a straightness
    // ruler can ever see) — the SAME curve on all four operator packs.
    //
    // WHERE IT IS APPLIED.  In the painter's EXISTING homography sampling, as
    // a 1-D radius→scale LUT (see `lens::RadialLut`).  Not as a separate
    // full-frame remap pass: that is 2.8 Mpx/frame, 2-4× the engine's own
    // 0.75 ms p50 budget, for a correction the strip needs over a few thousand
    // pixels.  The CORRELATION window is deliberately NOT corrected — the
    // field is ~0.197 px at its farthest pixel, so correcting it would be
    // wasted work AND would perturb the wobble baseline for no reason.
    //
    // THE GATE IS A SAFETY REQUIREMENT.  The coefficients are one body's one
    // lens.  Applying them to another device, or to the ultra-wide / tele on
    // the same body, would ADD geometric error rather than remove it.  So
    // `lens::resolve()` matches the device model AND the active lens/focal,
    // and every path that is not an exact match falls back to NO CORRECTION —
    // never to a guess.  The decision, and what it was decided on, is written
    // into SessionStats and from there into the pack's meta.json, so an
    // uncorrected pack says so rather than being silently uncorrected.
    //
    // DEFAULT ON.  Safe because the GATE decides, not the flag: on an unknown
    // body this paints byte-identical pixels to the shipped engine
    // (PanoLens.TheFlagIsOnByDefaultAndInertOnAnUnknownDevice).  The field
    // (IR) build ships every feature on — a feature shipped off has not been
    // tested.
    bool lensUndistort = true;
    /// `uname().machine` ("iPhone17,1"), supplied by the host.  EMPTY ⇒
    /// unknown ⇒ no correction.  There is deliberately no default body.
    std::string lensDeviceModel;
    /// The active capture device's type, when the host can name it
    /// ("AVCaptureDeviceTypeBuiltInWideAngleCamera").  Empty ⇒ unnamed, and
    /// then the FOCAL check alone stands in for the lens check.
    ///
    /// ⚠ THIS IS PART OF THE SELECTION KEY AS OF v15, not a check applied to
    /// whatever row the body matched first.  With two rows for one body it
    /// decides WHICH CALIBRATION IS APPLIED, so what produces it matters.
    ///
    /// WHAT PRODUCES IT DIFFERS PER ARM (PanoPlusBridge.swift:293-305), and
    /// the older claim that only the wide-angle name could ever appear was
    /// true of one arm and stated as though it were true of both:
    ///   • ARKit arm — `RNISPanoCameraLock.lensType()` asks AVFoundation for
    ///     the default BACK WIDE-ANGLE device and reports THAT device's type.
    ///     ARKit does not expose which camera it is streaming, so this arm can
    ///     only ever say wide-angle (or nothing).  Here the name really is
    ///     advisory: it can refuse a session that claims another lens, never
    ///     confirm one.
    ///   • AVF / `poseSource == "imu"` arm — the name comes from the SAME
    ///     format resolver that `start` will use
    ///     (`RNISPanoAvfSource.plannedFormatReport()["lens"]`), so it names the
    ///     device actually being opened and CAN say ultra-wide.  MEASURED on
    ///     the operator's 2026-09-04 packs: all six are `imu-attitude-only`,
    ///     four carry `lensRequested: ultraWide` with the ultra-wide name and
    ///     a delivered fx÷W of 0.3992-0.4054, two carry wide with 0.6950 and
    ///     0.7010.  The name and the frames agree on every one.
    ///
    /// EVEN SO, THE NAME IS NEVER THE THING THAT ACCEPTS.  The FOCAL check
    /// below reads the frames and has the last word on both arms — an ARKit
    /// session mislabelled wide-angle, or any misnamed lens, selects a row and
    /// is then refused by its focal (the rows sit 71 % apart against a ±4 %
    /// tolerance).  Do not count the name as a second barrier in a safety
    /// argument; count the focal.
    std::string lensDeviceLens;
    /// Fractional tolerance on fx ÷ imageWidth against the calibrated value.
    /// ARKit's own focus breathing moved it 0.69404-0.69743 (0.5 %) across the
    /// four packs; the ultra-wide sits at ≈0.37 and the tele at ≈1.4, so this
    /// admits the former and refuses the latter with three orders of margin.
    double lensFocalTolFrac = 0.04;
    /// A/B + fixture escape hatch: use `lensK1`/`lensK2` directly and skip the
    /// table. Ledgered as gate `override`, so a pack can never be read as
    /// though the shipped table had matched.
    ///
    /// ⚠ NOT REACHABLE FROM JS, DELIBERATELY.  These three fields are the one
    /// way to put arbitrary radial coefficients on an arbitrary body — exactly
    /// the outcome the gate exists to prevent ("would ADD geometric error
    /// rather than remove it").  So the iOS bridge does NOT read them from the
    /// options dictionary (`RNISPanoCore.mm`), and the SDK does not spell them:
    /// the only callers are the C++ host fixtures and the offline twin, both of
    /// which construct `Config` directly.  A pack can still SEE that they were
    /// not used — `panoConfigDict` ledgers them either way.
    bool   lensModelOverride = false;
    double lensK1 = 0.0, lensK2 = 0.0;
    /// LUT resolution. 1024 nodes over r² put the worst sampling error at
    /// ~1e-4 px (PanoLens.TheLutIsTheExactModelToWellUnderAHundredthOfAPixel).
    int    lensLutNodes = 1024;

    // 0 = auto-latch, 1 = force horizontal, 2 = force vertical.
    int axisOverride = 0;
    // 0 = auto-latch, +1 / −1 = force sweep sign along the latched axis.
    int signOverride = 0;

    // finalCanvas(): crop to the common vertical band shared by every painted
    // column.  Default FALSE — the ragged attitude-rectified top/bottom edge
    // is REPORTED (verticalEnvelope()), not hidden.
    bool cropVertical = false;

    // ── THE UPRIGHT BAKE (v14) ──────────────────────────────────────────────
    //
    // THE DEFECT THIS CLOSES, stated as the operator saw it: "the output image
    // is sideways".  REPRODUCED on his own 2026-09-02 packs — the four
    // `hold: "landscape"` sweeps come out upright and the one
    // `hold: "portrait"` sweep comes out rotated a quarter turn, shelves
    // running down the image instead of across it.  Rotating that canvas 90°
    // CW gives a plumb, level, correct panorama; nothing shears.
    //
    // THE CAUSE IS A MISSING STEP, NOT A WRONG ONE.  The whole pipeline is
    // deliberately raster-referenced: the Android recorder writes frames with
    // "NO ROTATION and NO EXIF" (PanoPlusAndroidRecorder.kt), the iOS AVF
    // source never sets `videoOrientation` (RNISPanoAvfSource.swift), and
    // `axisMatrix`/`orient` define the natural canvas as the camera raster's
    // own axes.  That is CORRECT and must stay: pixels and intrinsics agree,
    // so `H_rect` is sound (rotating at ingest is the standing repo trap —
    // rotated pixels against unoriented intrinsics).  What was never written
    // is the LAST step: raster → world-upright.  Android's recorder deferred
    // it to "the offline pass"; iOS's header claimed `finalCanvas()` already
    // did it.  Neither destination implemented it.  As of v14 the iOS comment
    // is true, and this is the field that makes it true.
    //
    //   outputRotationCwDeg = (sensorOrientationCw − deviceRotationCw) mod 360
    //
    // `sensorOrientationCw` is Camera2's `SENSOR_ORIENTATION` (90 on the A35's
    // back camera; 90 is also the iPhone back-camera constant the SDK's
    // `panoPlusImageRotationDeg` has always spelled).  `deviceRotationCw` is
    // how far the phone was turned clockwise from its natural upright AT SWEEP
    // START — a fact only the host measures, so the host supplies the result.
    //
    // The four holds, back camera, SENSOR_ORIENTATION 90:
    //
    //   hold                   deviceRotCw   outputRotationCwDeg
    //   portrait                     0               90
    //   landscape-left              90                0     ← today's accident
    //   portrait-upside-down       180              270
    //   landscape-right            270              180
    //
    // ONE rigid turn covers every (hold × pan direction) pair, because it
    // carries the latched sweep axis with it: a landscape hold panned
    // top-to-bottom latches axis 1 on the raster's SHORT side and stays a tall
    // output; a portrait hold panned left-to-right latches axis 1 too and
    // becomes a WIDE one.  There is nothing per-pan-direction to decide.
    //
    // WHERE IT IS APPLIED, and where it deliberately is NOT:
    //  · `renderOriented()` — the DELIVERABLE, after the axis/sign undo.  A
    //    JPEG leaves the phone with no display chain behind it, so the turn
    //    has to be in its pixels.  Orthogonal, so it stays an exact
    //    transpose/flip — never a resample.
    //  · NOT `orient()` itself, and so NOT the live preview.  The preview is
    //    drawn on a screen bolted to the same body as the sensor, and the SDK
    //    already turns it: `panoPlusImageRotationDeg − panoPlusChromeRotationDeg`
    //    ≡ `90 − deviceRotCw` ≡ THIS ANGLE, identically, on both a
    //    portrait-locked and an unlocked host.  Baking it here as well would
    //    double-turn every live preview.  (That identity is asserted in the
    //    SDK suite so the two can never drift apart.)
    //  · NOT the ledger, `unpaintedRuns()`, `verticalEnvelope()` or
    //    `PreviewWindow`.  Those are CANVAS-frame (u,v) and stay canvas-frame;
    //    `SessionStats::outputRotationCwDeg` is published so a reader can map
    //    them onto the emitted image instead of having to assume.
    //
    // 0, 90, 180 or 270 — `configure()` refuses anything else.  DEFAULT 0, so
    // a host that sends nothing (and every existing pack, fixture and replay)
    // is byte-identical to v13.
    int outputRotationCwDeg = 0;
};

// ── Lens undistortion: the model, the shipped table, and the gate ───────────
//
// CONVENTION, fixed here once because a sign error in it is silent.  The fit
// produced the UNDISTORTION polynomial U in NORMALISED coordinates
// (u,v) = ((x−cx)/fx, (y−cy)/fy):
//
//     r_ideal = U(r_observed) = r_observed · (1 + k1 r² + k2 r⁴)
//
// i.e. given where the lens PUT a point, U says where a pinhole would have.
// The painter needs the inverse: it starts from an IDEAL (pinhole) source
// position — because that is the geometry `H` was built for — and must sample
// the frame where the lens actually put that content.  `RadialLut` is exactly
// that inverse, tabulated: `scaleForRadiusSq(r_ideal²)` returns s with
// r_observed = s · r_ideal.
namespace lens {

struct Model {
    double k1 = 0.0, k2 = 0.0;
};

/// Why the correction was, or was not, applied.  Every non-`Applied` value
/// means NO correction was made — there is no "best effort" state.
enum class Gate : int32_t {
    Disabled      = 0,  // Config::lensUndistort == false
    UnknownDevice = 1,  // no row for this body (or no body given)
    LensMismatch  = 2,  // right body, a lens the fit does not cover
    FocalMismatch = 3,  // fx ÷ imageWidth outside the calibrated tolerance
    NoIntrinsics  = 4,  // no usable fx / imageWidth to check against
    Applied       = 5,  // the shipped table matched
    Override      = 6,  // Config::lensModelOverride — A/B and fixtures only
    // The model was ACCEPTED and then the LUT could not be built on this
    // frame's geometry (a degenerate radius range, a non-invertible model).
    // A separate value on purpose: without it a pack reads gate `applied`
    // beside `applied:false`, and a reader has to combine two fields to learn
    // that nothing was corrected.  Reported by `resolveLens`, never by
    // `resolve` — the gate itself has no frame to fail on.
    LutFailed     = 7,
};
const char* gateName(Gate g);

struct Decision {
    Gate        gate = Gate::Disabled;
    Model       model;                    // zero unless applied()
    std::string source;                   // provenance, ledgered
    double      fxOverWidth = 0.0;        // what the gate MEASURED
    double      expectedFxOverWidth = 0.0;// what the table wanted
    bool applied() const {
        return gate == Gate::Applied || gate == Gate::Override;
    }
};

/// One row of the shipped per-model table.  A device is corrected only if it
/// appears here — see `resolve`.
struct Entry {
    const char* device;        // uname machine, exact match
    const char* lens;          // AVCaptureDevice.deviceType raw value
    double      fxOverWidth;   // the calibrated normalised focal
    double      k1, k2;
    const char* source;        // where the numbers came from
};
/// The table itself, exposed so a test can assert its CONTENTS rather than a
/// transcription of them.
const Entry* table(size_t* count);

/// The gate.  `fx` and `imageWidth` come from the frame, not from the host.
Decision resolve(const Config& cfg, double fx, int imageWidth);

/// The 1-D LUT the painter samples through.  Indexed by r² so the painter
/// needs no sqrt per pixel; the reparametrisation is monotone, so this is the
/// same one-dimensional radius→scale curve.
class RadialLut {
public:
    /// Tabulate `m` over ideal radii [0, maxIdealRadius].  `nodes` ≥ 16.
    /// A zero model builds an EXACT identity (no interpolation error at all).
    void build(const Model& m, double maxIdealRadius, int nodes = 1024);
    bool valid() const { return valid_; }
    bool identity() const { return identity_; }
    const Model& model() const { return model_; }
    /// s such that r_observed = s · r_ideal, for rr = r_ideal².  Radii past
    /// the tabulated range clamp to the last node: those samples land far
    /// outside the frame and are discarded by the warp mask either way.
    double scaleForRadiusSq(double rr) const;

private:
    Model               model_;
    std::vector<double> lut_;     // scale at node i
    double              step_ = 0.0;   // in r² units
    double              invStep_ = 0.0;// 1/step_, so the painter's inner loop
                                       // costs a multiply and not a divide
    double              maxRr_ = 0.0;
    bool                valid_ = false;
    bool                identity_ = true;
};

}  // namespace lens

// ── One frame in ────────────────────────────────────────────────────────────
// `bgr` and `grayWork` are borrowed for the duration of ingest() with ONE
// documented exception: the engine keeps a SHALLOW cv::Mat reference to the
// last PAINTED frame's `bgr` for the finalize tail flush.  The caller must
// therefore hand ingest() a freshly allocated `bgr` per frame (ios/
// RNISPanoCore.mm does — cvtColor allocates), never a reused scratch buffer.
struct FrameInput {
    const cv::Mat* bgr      = nullptr;  // CV_8UC3, imageWidth × imageHeight
    const cv::Mat* grayWork = nullptr;  // CV_8UC1, ≈ imageWidth×workScale

    double tsNs = 0.0;                  // ARKit monotonic media clock, ns

    // Per-frame intrinsics, PIXELS, against imageWidth × imageHeight.
    double fx = 0, fy = 0, cx = 0, cy = 0;
    int    imageWidth = 0, imageHeight = 0;

    double q[4] = {0, 0, 0, 1};         // world←cam unit quaternion [x,y,z,w] (GL)
    double t[3] = {0, 0, 0};            // camera position, world metres

    int     tracking = 0;               // 0 notAvailable, 1 limited, 2 normal
    int64_t seq      = 0;               // caller's monotonic frame counter

    // ── v6: THE FRAME'S OWN EXPOSURE ────────────────────────────────────
    // `AVCaptureDevice.exposureDuration` in SECONDS and `AVCaptureDevice.ISO`,
    // sampled on the AR thread for this frame (ios/RNISPanoPlusPlugin.swift).
    // Scene radiance is linear in their PRODUCT, which is what makes exact
    // normalisation possible instead of an overlap estimate.
    //
    // ZERO means "not available on this path", and every consumer treats that
    // as identity — never as a dark frame.  Packs captured before v6 have no
    // such field and replay byte-identically.
    double exposureDurationS = 0.0;
    double exposureISO       = 0.0;

    // ── v11: ARKit's OWN exposure for THIS frame ────────────────────────
    // `ARCamera.exposureDuration` (SECONDS) and `ARCamera.exposureOffset`
    // (EV), read off the ARFrame ARKit is delivering — NOT off the
    // `AVCaptureDevice` the two fields above sample.
    //
    // WHY BOTH, when the pair above already exists.  The lock is asserted on
    // an `AVCaptureDevice` WE resolve (`AVCaptureDevice.default(.builtIn-
    // WideAngleCamera, …)`) and then verified by reading that SAME object
    // back, so `exposureRangeRatio == 1` proves only that the object we
    // touched did not move.  It is circular with respect to the two
    // questions that matter: is that the device ARKit is streaming, and does
    // the lock reach the pixels ARKit hands us?  These two numbers come off
    // ARKit's own camera and settle both — agreement is device identity,
    // and a flat ARKit trace is the lock reaching ARKit's frames.
    //
    // EVIDENCE ONLY.  Nothing here feeds the radiometric normalisation, the
    // gain chain, the placement or the verdict: `exposureGainFor()` reads
    // `exposureDurationS × exposureISO` and nothing else, exactly as in v6.
    // ZERO / non-finite means "not available", recorded as such and never
    // substituted for the device reading.
    //
    // exposureOffset is an EV OFFSET, not an absolute — it can legitimately
    // be negative, so 0.0 is a legal VALUE here and the presence of the
    // sample is carried by `arExposureValid`, never inferred from the float.
    double arExposureDurationS = 0.0;
    double arExposureOffsetEV  = 0.0;
    bool   arExposureValid     = false;
};

// ── One ledger row ──────────────────────────────────────────────────────────
struct FrameOutcome {
    Outcome outcome = Outcome::RejectedInput;
    int64_t seq     = 0;
    double  tsNs    = 0.0;

    // ── THE TWO CHANNELS OF THE ADVANCE, per frame, CANVAS px, natural
    // (pre-axis-remap) frame.  Reading only one of them is what made the
    // first device pack unreadable, so all three are ledgered:
    //
    //   advanceX/Y      RESIDUAL — the phase-correlation advance measured
    //                   AFTER attitude rectification.  Under a pure rotation
    //                   this is ≈0 BY DESIGN (the rotation is already carried
    //                   by H_rect); it is the translation/parallax part.
    //                   Field name kept from v2 so old ledgers still parse.
    //   advanceRotX/Y   ROTATION — canvasScale·(H_rect(centre) step) since the
    //                   last ACCEPTED frame: the attitude-derived motion.
    //                   Reported on rejected frames too (what it would have
    //                   been), which is how a held chain stays diagnosable.
    //   advanceTotX/Y   the SUM — the frame's actual canvas-position step, and
    //                   the quantity posU/posV move by.
    //
    // The identity advanceTot == advanceRot + advance holds on EVERY row
    // unconditionally.  On a row whose residual was never measured (rejected
    // before the correlation, or rejected BY it) advance is 0 and advanceTot
    // collapses to advanceRot — "attitude is all we know about this frame",
    // which is true rather than a broken identity.  `chainAdvanced` is what
    // separates the two cases; see below.
    double advanceX = 0.0, advanceY = 0.0;
    double advanceRotX = 0.0, advanceRotY = 0.0;
    double advanceTotX = 0.0, advanceTotY = 0.0;
    double response = 0.0;      // phase-correlation peak response

    /// True iff this frame ADVANCED the registration chain (passed every gate
    /// and moved prevCr / posNat).  THE flag to filter on before summing any
    /// advance column: the per-frame steps are measured from the last ACCEPTED
    /// frame, so a rejected row and the accepted row after it report
    /// OVERLAPPING intervals and a naive Σ over all rows double-counts.
    /// Σ(advanceTot) over chainAdvanced rows == the session's own travel.
    bool chainAdvanced = false;

    /// True on the single row at which the axis/sign latch was CORRECTED and
    /// the canvas restarted (Config's relatch block).  Everything painted
    /// before this row was discarded — the row is the pack's record of that.
    bool relatched = false;

    double posU = 0.0, posV = 0.0;   // internal canvas position of this frame
    double stripW    = 0.0;          // requested strip width (canvas px)
    double canvasX0  = 0.0;          // committed span, internal canvas px
    double canvasX1  = 0.0;
    double gainStep  = 1.0;
    double gainCum   = 1.0;
    double highWater = 0.0;
    double gapPx     = 0.0;          // leftward extension that avoided a gap
    /// THE SEED JUNCTION, on the row it actually happened
    /// (`Config::seedFrontierMeet`).  `seedMet` is true ONLY when the meet
    /// reached committed pixels — the strip painted, from its own left edge —
    /// and `seedMeetPx` is the span that was left to the seed, i.e. the
    /// geometric hole the meet closed.  Both stay 0/false on every other row
    /// and in the whole OFF arm, so a pack that never armed the knob is
    /// byte-identical (the replay emits them only when `seedMet`).
    ///
    /// THREE STATES, NOT TWO.  Before 2026-09-08 the meet zeroed `gapPx` in the
    /// DECISION block, so a junction the d8 jog guard then REFUSED reported
    /// `gapPx 0` on a row where nothing was painted and the hole was still
    /// open — "the hole was bridged", "the hole was met" and "nothing landed
    /// at all" collapsed into one reading, on precisely the frames where the
    /// knob failed.  `gapPx` is now zeroed only after the commit returns
    /// having painted.
    bool   seedMet   = false;
    double seedMeetPx = 0.0;
    double backfillPx = 0.0;         // columns filled from the PREVIOUS painted
                                     // frame because this one could not reach
                                     // the frontier (algorithm step 8)
    /// Option C (`Config::leadReplace`): columns of the seed's PROVISIONAL
    /// lead-in this frame filled ahead of the frontier.  0 whenever the flag is
    /// off, and 0 once the band has been covered — which is why it is a per-row
    /// number and not a session flag: the row it stops on is the row the
    /// lead-in was finally resolved.  The fill is forward-only, so these are
    /// DISJOINT across rows and sum to no more than the band.
    double leadRepaintPx = 0.0;
    /// Trajectory continuation (`Config::crossTraj`), on the TAIL-FLUSH row
    /// only: whether the block was placed under the strip chain's trajectory,
    /// the slope (canvas cross px per along px) and fan (per cross px) that
    /// were applied, and how many column samples the estimator fitted.  All
    /// zero / false when the flag is off or the estimator declined — a declined
    /// estimate is a block placed exactly as before, and the row says so.
    bool   crossTrajApplied = false;
    double crossTrajSlope = 0.0;
    double crossTrajFan = 0.0;
    int    crossTrajSamples = 0;
    double rectifyDeg = 0.0;         // total rotation vs the reference attitude

    // PERPENDICULAR CLIPPING, in canvas px, AFTER any vertical growth: how
    // much of this frame's footprint fell outside the canvas band and was
    // therefore discarded by the warp.  Both zero ⇒ nothing was lost.
    // `clipped` is the exact (mask-measured) fact that the committed strip
    // reached a canvas edge; clipTopPx/clipBotPx are the analytic magnitudes.
    double clipTopPx = 0.0, clipBotPx = 0.0;
    bool   clipped   = false;

    /// Cumulative canvas px every painted pixel has been SHIFTED DOWN by, up
    /// to and including this frame, because the band grew at the top.
    ///
    /// Load-bearing for the offline replay twin: `posV` is measured in the
    /// canvas frame that was current when the row was written, so two rows on
    /// opposite sides of a growth are NOT directly comparable.  Subtracting
    /// `vShiftPx` puts every row back into the axis-latch frame.
    double vShiftPx = 0.0;

    // ── v5 ──────────────────────────────────────────────────────────────
    /// The along-sweep attitude component this frame carries, degrees.  0 in
    /// the planar arm, pre-latch, and on a pure translation sweep.
    double psiDeg = 0.0;
    /// What is LEFT for the homography after the sweep component is removed —
    /// the quantity rectifyYawLimitDeg now gates.  Equals rectifyDeg exactly
    /// whenever psiDeg is 0.
    double crossRectifyDeg = 0.0;
    /// THE WARPING NUMBER for this strip: the worst area magnification of the
    /// committed span relative to the reference optical axis.  1.0 = none;
    /// one ordinary photo from a 1335 px-focal 1920×1440 camera is 2.45 at
    /// its own corner.
    double areaScale = 1.0;

    /// The cross-sweep scale STEP actually applied, and the accumulated
    /// factor.  `crossScaleCaged` says the step was clamped.
    double crossGrad  = 0.0;
    /// How well the straight line through the K cross windows explained them.
    /// 1.0 when the gate is off or fewer than 3 bands exist — see
    /// Config::crossFitMinBandR2.
    double crossBandR2 = 1.0;
    double crossScale = 1.0;
    bool   crossScaleCaged = false;
    /// v8 — how far Config::crossAvgWindows moved this frame's cross advance:
    /// (the averaged value the chain used) − (the centre window's value it
    /// would have used).  EXACTLY 0.0 on every row when the flag is off, which
    /// is how a pack states that it ran the shipped chain — and EXACTLY 0.0
    /// on every crossResidualGate-2 gated row whatever the flag, because a
    /// gated frame is placed by the attitude on the cross axis and there is
    /// nothing left to average (see Config::crossResidualGate).
    double crossAvgDeltaPx = 0.0;

    /// ── LOW-LIGHT REGISTRATION GATE (Config::crossResidualGate) ─────────
    /// COMPUTED — and written by the ledger — only when the knob is ≥ 1 and
    /// the frame reached the centre correlation; `crossStatsComputed` says
    /// so.  With the knob at 0 every field below is its default and the
    /// ledger row does not carry them, which is how a pack states it ran
    /// the shipped chain.  Definitions in Config's gate block.
    bool   crossStatsComputed = false;
    /// Reason bitmask: 1 texture, 2 peak, 4 periodicity — several bits may
    /// be set on one row, and each counter counts its own bit.  0 in log-only
    /// mode and on every ungated row.  Non-zero ⇒ the cross component of
    /// `advance` is 0.0, advanceTot's equals advanceRot's, and
    /// crossResidualRawPx holds what was measured.
    int    crossGated = 0;
    double crossTextureVar = 0.0;
    double crossPeakPSR = 0.0;
    double crossPeakMass = 0.0;
    double crossDominantPeriodPx = 0.0;
    double crossPeakSecondary = 0.0;
    double crossResidualRawPx = 0.0;

    /// THE CUT METRIC.  Per band, what the K windows measured MINUS what the
    /// placement applied, in canvas px, in the frame's own rectified
    /// coordinates — so a canvas vertical-growth re-base cannot contaminate
    /// it (the ~128 px posV steps are exactly that re-base and are benign).
    /// `seamBands` is how many bands were usable; 0 means not measured.
    double seamWorstBandPx  = 0.0;   // max_k |residual|
    double seamBandSpreadPx = 0.0;   // max_k − min_k, the shear term
    /// The photometric seam: the DC step between the last already-painted
    /// canvas column and the first newly committed one, over the rows both
    /// cover.  Measured on the CANVAS, not on the gain's own sample window —
    /// the gain is fitted on one region and applied to another, so a gain
    /// that matches its sample exactly can still commit a visible step.
    double seamLumaStepDN = 0.0;
    int    seamBands = 0;

    /// THE COMMITTED-PIXEL CUT.  The band metric above scores the placement
    /// the engine DECIDED; this one scores the pixels it actually PAINTED.
    /// At every strip boundary the incoming frame's warp already covers a
    /// slab of canvas LEFT of the frontier (the gain sample window) that the
    /// high-water clip then throws away.  Correlating that discarded slab
    /// against the canvas underneath it measures the cross-sweep
    /// misregistration between the two frames in CANVAS pixels, from the
    /// warp matrix that did the painting — so it cannot be fooled by any
    /// divergence between what was measured, what was decided and what was
    /// committed, and it cannot be fooled by the K windows agreeing on a
    /// common-mode alias (the slab is real overlapping content, not two
    /// neighbouring world columns).  `seamCanvasJogValid` is false when the
    /// overlap was too small or the correlation response too weak.
    double seamCanvasJogPx = 0.0;
    bool   seamCanvasJogValid = false;
    /// v8 — THE SAME MEASUREMENT WITH ITS SIGN.  `seamCanvasJogPx` is
    /// `fabs(this)`, and every shipped bar, percentile and gate still reads
    /// the absolute field, so nothing that consumed it moves.
    ///
    /// The sign is the difference between "these two strips disagree by 0.4 px"
    /// and "the panorama has drifted 0.4 px further in the same direction".
    /// It was taken with `std::fabs` at the point of measurement and was
    /// therefore UNRECOVERABLE from the pack — which mattered, because the
    /// operator's standing complaint is a LOW-FREQUENCY RANDOM WALK of the
    /// cross-sweep placement and this is its per-boundary increment.
    ///
    /// 0 (and meaningless) whenever `seamCanvasJogValid` is false.
    double seamCanvasJogSignedPx = 0.0;

    // ── v6: PHOTOMETRY ──────────────────────────────────────────────────
    /// This frame's own exposure as reported by the camera (seconds × ISO
    /// units), echoed so the pack can be re-normalised offline without the
    /// track file.  0 ⇒ the metadata was not available on this path.
    double expDurationS = 0.0;
    double expISO       = 0.0;
    /// The EXACT radiometric factor applied to this frame before any overlap
    /// fit: reference exposure ÷ this frame's exposure, clamped.  1.0 when
    /// there is no metadata, which is byte-identical to v5.
    double expGain      = 1.0;
    /// THE EFFECTIVE SCENE→CANVAS TRANSFER this strip's pixels carry,
    /// relative to the reference frame — `(cameraExposure ratio × expGain) ×
    /// gainCum`.  NOT the applied gain: under a working normalisation the
    /// applied gain legitimately ramps by the camera's own 1.5-1.8×, and it is
    /// camera × applied that the eye integrates.  This is the field whose
    /// LOCAL excursions ARE the bands, so it is ledgered per row rather than
    /// reconstructed from two other columns afterwards.
    double photoScale   = 1.0;

    /// THE PHOTOMETRIC SEAM, measured over the WHOLE shared footprint of the
    /// two owners rather than one canvas column against one (the v5 metric was
    /// quantisation-limited at ±1 DN and could not resolve a 0.2 DN median
    /// from a 4.7 DN band).  Signed median of (incoming − already-painted)
    /// luma over the rows both cover, in DN.
    double seamPhotoStepDN  = 0.0;
    /// Fraction of the boundary's own EXTENT (canvas-row bands) whose
    /// independently-measured step agrees with the whole-slab step — 1.0 is a
    /// DC offset that holds all the way along the boundary (an exposure
    /// mismatch), a low value is a step that exists only in part of it (a
    /// scene edge, a shading ramp, a local misregistration).
    ///
    /// −1 ⇒ FEWER THAN TWO BANDS could measure, so uniformity is UNKNOWN.
    /// Deliberately not 1.0: "nothing measured it" is not "it was uniform".
    ///
    /// REPORTED, not used to exclude: the interquartile mean over the shared
    /// low-gradient footprint is ALREADY the construction that makes a shifted
    /// scene edge unable to fire this (its difference field is symmetric, so
    /// its trimmed mean is ≈0), and excluding low-uniformity boundaries would
    /// condition the percentiles on the flat-looking ones.  The cross-check
    /// lives in SessionStats::seamPhotoUniStepP95DN instead.
    double seamPhotoUniform = -1.0;
    /// The worst band's disagreement with the whole-slab step, DN.  0 when
    /// uniformity is unknown.
    double seamPhotoSpreadDN = 0.0;
    /// How many bands had enough low-gradient samples to measure.
    int    seamPhotoBands = 0;
    /// False ⇒ not measured.  Never the same thing as "no step".
    bool   seamPhotoValid   = false;

    double engineMs  = 0.0;
    bool   stalled   = false;        // cage/response stall is now operator-visible
};

/// WHAT THE LIVE PREVIEW ACTUALLY SHOWED — in canvas-along coordinates, and
/// the answer to two MEASURED complaints rather than a tidiness exercise.
///
/// Both come off the operator's three 2026-08-29 pano+ packs, replayed through
/// the shipped layout (results/2026-08-30-panoplus-portrait/preview/):
///
///  1. THE OPENING STALL.  `bootstrap` paints ONE WHOLE FRAME FOOTPRINT
///     (measured: canvas u 129..847, 718 px) and then the strip commit starts
///     at the frame's CENTRE — u ≈ 488 on all three packs.  So the frontier has
///     to travel half a footprint before the painted band's OUTER EXTENT moves
///     at all.  Measured: the band sat at exactly 718 px for 2.94 s / 2.39 s /
///     2.62 s — 40% / 30% / 33% of each sweep — while the operator was already
///     panning.  The preview is not frozen (strips ARE landing), but it does
///     not GROW, and "the preview does not look good as I pan" is what that
///     looks like from behind the phone.  `frontierU` is the number that was
///     moving the whole time, and it is now published so the surface can show
///     it moving.
///
///  2. THE GROWING EDGE.  Fitting the WHOLE band into a fixed panel means the
///     panorama shrinks without bound.  Measured against the shipped
///     `panoPlusPreviewLayout` on a 390x844 portrait-locked window: the panel's
///     inked area PEAKS at along ≈ 2000 canvas px (84 765 pt²) and then
///     collapses — 3.9 m of shelf gives a 114x374 pt sliver at 7.1 source px
///     per device px, 5.8 m gives 76x374 pt at 10.7.  His three sweeps end at
///     1423-1711 px, i.e. they stop one step SHORT of the knee, which is why
///     the packs show the complaint at its mildest.  A window caps that: past
///     the knee the scale stops falling instead of falling forever.
///
/// Every field is in the ENGINE's canvas-along frame (u grows along the sweep
/// axis before `orient`), EXCEPT `frontierFrac`, which is already turned into
/// the oriented image's own along direction — that flip needs `sweepSign`,
/// which is engine knowledge, and duplicating it in a host was the exact class
/// of bug that produced the 154x100 pt preview panel.
struct PreviewWindow {
    /// The whole painted band, [start, end).
    int bandStartU = 0, bandEndU = 0;
    /// The slice this preview carries, [start, end).  Equal to the band when
    /// `windowAlongPx` was 0 or the band is shorter than the window.
    int viewStartU = 0, viewEndU = 0;
    /// The commit frontier at render time (`Impl::highWater`).
    double frontierU = 0.0;
    /// Where the frontier falls inside the PUBLISHED image, 0..1 along its own
    /// long axis, already sign-corrected.  -1 when there is nothing to place.
    double frontierFrac = -1.0;
    /// True when the view is a strict subset of the band.
    bool windowed = false;
    /// The canvas's full cross extent, and the rows the view kept.  Equal
    /// unless `cropPadRows` trimmed the unpainted pad.
    int canvasCrossPx = 0, viewCrossPx = 0;
    /// v12 — how many canvas px of PROVISIONAL lead-out (frontier → the live
    /// frame's leading edge) this preview carries beyond the committed band.
    /// 0 when `leadOut` was off or nothing extended past the frontier.  When
    /// non-zero, `viewEndU` already includes it — the frontier marker then
    /// divides committed from provisional exactly.
    int leadOutPx = 0;

    // ── v14 — WHERE THE LIVE FRAME'S FOOTPRINT ENDS ─────────────────────────
    //
    // WHY THESE ARE HERE.  `leadOutPx` says how many provisional columns the
    // preview carries; it does NOT say where the live frame's far edge is, nor
    // WHICH LAW put the provisional columns where they are.  Those are exactly
    // the two questions a reader has when they see a boundary in the panel and
    // ask what it is: the frontier (`frontierU`, the commit high-water) is one
    // candidate, the frame's own leading edge is the other, and the tail-arc
    // law can place the second up to ~95 px short of the raw footprint (see the
    // lead-out block's own comment).  Publishing only `leadOutPx` left that
    // gap to be inferred, and inference is what this file has been burned by.
    //
    // Every one is canvas-along (u), like the rest of this struct, and -1 is
    // "not applicable / nothing to place" — never 0, which is a real u.
    //
    /// `Impl::lastValid && !Impl::tailFlushed` — i.e. there IS a live frame
    /// whose footprint could extend beyond the frontier.  False after the tail
    /// flush has committed it, which is the state the final republish renders.
    bool   liveValid = false;
    /// `Impl::lastFu1` — the last painted frame's projected FAR edge, raw and
    /// unclamped.  -1 when `liveValid` is false.
    double lastFu1U = -1.0;
    /// `min(lastFu1, Config::canvasMaxWidthPx)` — the bound the lead-out and
    /// the tail flush BOTH use.  Differs from `lastFu1U` only against the
    /// canvas cap.  -1 when `liveValid` is false.
    double leadClampU = -1.0;
    /// The provisional end this render actually resolved: the arc law's last
    /// slice edge when it engaged, else `leadClampU`.  -1 when the lead-out
    /// block did not run (leadOut off, or no live frame).  When `leadOutPx > 0`
    /// this equals `ceil(leadEndU) == viewEndU`, by construction.
    double leadEndU = -1.0;
    /// The tail-arc law supplied the lead-out slices (as opposed to the single
    /// `lastHint` warp).  Only meaningful when `leadEndU >= 0`.
    bool   leadArc = false;

    // ── THE LEAD-OUT'S OWN START, and what it replaced ──────────────────────
    /// Canvas u the live frame's provisional paint BEGINS at in this render.
    /// With `Config::leadOutFromFrontier` off this is the committed band's end
    /// (the lead-out only appends); with it on this is `ceil(frontierU)`.  -1
    /// when the lead-out block did not run.
    double leadStartU = -1.0;
    /// Columns of already-painted canvas the live frame overwrote in the
    /// preview: `bandEndU - leadStartU` when positive, else 0.  With the flag
    /// off this is 0 by construction — the stale band is what the operator's
    /// lower line was, and this number is it going away.
    int    leadOverwritePx = 0;
    /// Trajectory continuation applied to the lead-out (`Config::crossTraj`),
    /// with the slope and fan used — the same numbers the tail flush will
    /// commit with, measured on this tick's state.
    bool   leadTrajApplied = false;
    double leadTrajSlope = 0.0;
    double leadTrajFan = 0.0;
    /// Rows the preview's SCRATCH was padded by, top and bottom, past the
    /// canvas height so the trajectory-placed lead-out fits while it is
    /// painted — the preview's counterpart of the band growth `finish()` does
    /// for the same block.  0 when the block stays inside the canvas rows.
    ///
    /// ⚠ NOT rows the published image grew by.  The published view is cropped
    /// back to the same rows `leadOutTraj = false` publishes (`viewCrossPx`
    /// never includes a pad): a per-tick trajectory estimate is a per-tick
    /// pad, and a preview that published it changed size on 41 of 45 ticks
    /// of the 2026-09-07 pack.  These say how far the block reached; they
    /// do not say the image is any larger.
    int    leadPadTopPx = 0;
    int    leadPadBotPx = 0;
};

// ── Session summary ─────────────────────────────────────────────────────────
struct SessionStats {
    // `seen` counts frames that PASSED input validation (a malformed frame is
    // tallied in `rejectedInput` and is deliberately not in `seen`).  Rows with
    // outcome AbortedTracking / CanvasFull / TailFlush appear in ledger.jsonl
    // but are not in any tally here — the ledger is the complete record.
    int64_t seen = 0, painted = 0, heldBacktrack = 0, heldFrontier = 0;
    int64_t skippedNoAdvance = 0;
    int64_t rejectedLowResponse = 0, rejectedOutOfCage = 0, rejectedRectify = 0;
    int64_t rejectedPoseSpeed = 0, rejectedTracking = 0;
    int64_t rejectedInput = 0, warmingUp = 0, bootstrap = 0;
    /// Frames skipped because their timestamp did not advance — a DUPLICATE
    /// delivery (dt == 0) or a small reordering.  These are benign under
    /// delivery pressure and are SKIPPED, not fatal: the 2026-08-30 field
    /// recording lost two of three sweeps to `nonmonotonic-timestamp` on a
    /// session that was also dropping 77 and 59 pack writes, i.e. exactly the
    /// load where a repeat frame is expected.  A genuinely NEW timebase is
    /// still fatal and is caught by the backward-jump bound below (and by the
    /// independent `session-restart` translation gate).  Counted separately
    /// from `rejectedInput` so "the camera hiccupped" can never be read as
    /// "the frame was malformed".
    int64_t skippedNonmonotonicTs = 0;
    // v13 — what the jog guard did.  `d8JogRefusals` strips were
    // refused over the bar; `d8JogForced` were painted anyway because the
    // refusal run hit d8JogMaxRun.  refusals > 0 with forced == 0 is the
    // guard working; forced > 0 names a persistent divergence it could only
    // defer.
    int64_t d8JogRefusals = 0;
    int64_t d8JogForced = 0;
    // Low-light registration gate (Config::crossResidualGate) — accepted
    // frames whose cross residual was dropped for the attitude, by reason.
    // All 0 in log-only mode and with the knob off; non-zero on a P5-class
    // pack and near zero on a clean one is the gate firing where the light
    // is bad, not everywhere.
    int64_t crossGatedTexture = 0;
    int64_t crossGatedPeak = 0;
    int64_t crossGatedPeriod = 0;
    int64_t gapExtended = 0, gapBreak = 0, gapBackfilled = 0;
    int64_t canvasGrowths = 0, canvasHeightGrowths = 0;

    /// Frames ARKit reported as `.limited` and the engine processed anyway
    /// (see Config::abortOnLimitedTracking).  Reported so a pack reader can
    /// tell "the sweep ran through poor tracking" from "the sweep was clean".
    int64_t limitedFrames = 0;

    /// PERPENDICULAR CLIPPING — the failure mode the G1 column gate cannot
    /// see.  `clippedFrames` > 0 means the panorama is missing shelf height
    /// on that many strips; max*ClipPx are the worst single-frame overhangs.
    int64_t clippedFrames = 0;
    double  maxClipTopPx = 0.0, maxClipBotPx = 0.0;
    /// Canvas columns whose committed strip touched a canvas edge — i.e. the
    /// width of the panorama that is vertically truncated.
    int64_t clippedColumns = 0;
    /// Total canvas px the band grew at the TOP over the session — the amount
    /// every ledger `posV` has drifted from the axis-latch frame.
    double  vShiftTotalPx = 0.0;

    int canvasW = 0, canvasH = 0;       // ALLOCATED canvas
    int paintedW = 0, paintedH = 0;     // painted extent (pre-orientation)
    int outputW = 0, outputH = 0;       // after finalCanvas()'s orientation bake
    /// v14 — the upright bake ACTUALLY APPLIED, echoed so a pack reader never
    /// has to infer it.  Everything else in this struct, in the ledger and in
    /// `unpaintedRuns()`/`verticalEnvelope()`/`PreviewWindow` is CANVAS-frame;
    /// this is the quarter turn between that frame and `canvas.jpg`'s pixels.
    /// See `Config::outputRotationCwDeg`.
    int outputRotationCwDeg = 0;

    int    axis = 0;                    // 0 horizontal, 1 vertical
    int    sweepSign = 1;
    bool   axisLatched = false;
    bool   referenceLatched = false;
    bool   stalled = false;
    double refQuat[4] = {0, 0, 0, 1};
    double refFx = 0, refFy = 0, refCx = 0, refCy = 0;
    double maxRectifyDeg = 0.0;         // worst attitude excursion vs reference —
                                        // the planar-canvas sufficiency evidence
    double maxAdvancePxResolved = 0.0;  // the cage actually in force
    int    corrCentroidBoxResolved = 0; // sub-pixel support in force, work px
    int    corrWindowW = 0, corrWindowH = 0;  // the correlated window, work px
    /// Accepted frames whose correlation-window origin was CLAMPED into the
    /// rectified footprint instead of sitting on the rectified frame centre.
    ///
    /// This is the precondition of the engine's attitude-cancellation property,
    /// made observable.  Measured 2026-08-24 (results/2026-08-24-panoplus-noise-
    /// impl/wobble_source.json, four device packs, 1709 accepted frames): with
    /// the origin UNCLAMPED the committed step is
    ///
    ///     advanceTot == −canvasScale · shift / workScale
    ///
    /// EXACTLY — max error 0.0e+00 canvas px on all four packs — because
    /// `owX == crx·ws − winW/2` makes the origin-compensation term
    /// `(owX − prevOwX)` equal to `ws·(crx − prevCrX)`, which is the attitude
    /// channel itself.  The attitude therefore cancels out of the committed
    /// step algebraically rather than approximately.
    ///
    /// When the clamp FIRES that cancellation stops holding, and `advanceTot`
    /// — the quantity the cage's TOTAL bound tests — starts measuring
    /// something else.  The PLACEMENT is unaffected either way (it consumes the
    /// origin-compensated residual, which stays correct at any origin), so this
    /// is a diagnostic, not a fault: it says how much of the sweep ran outside
    /// the regime the identity covers.  0 on all four operator packs.
    ///
    /// RE-BASED BY A RELATCH, like `crossScaleCagedFrames` and unlike
    /// `exposureClampedFrames`: a relatch discards the canvas, so this counts
    /// the chain that produced the panorama you are holding, not one nobody can
    /// see.  Read it beside `relatchCount`.
    int64_t corrOriginClampedFrames = 0;
    double sweptExtentPx = 0.0;

    // ── REGIME: was this a pivot or a walk? ─────────────────────────────────
    // The operator asked for the pack to STATE its regime instead of leaving
    // it to be inferred.  All five are measured along the LATCHED SWEEP AXIS,
    // in canvas px, over accepted frames only.
    //
    //   *TravelPx   net (signed) contribution of that channel to the sweep —
    //               rotTravelPx + resTravelPx == the panorama's own travel.
    //   *PathPx     Σ|per-frame step| — a wobbling sweep has a path much
    //               longer than its travel, which is exactly the signature of
    //               a noise-dominated channel.
    //   rotationFraction  rotPathPx ÷ (rotPathPx + resPathPx).  1 ⇒ a pure
    //               pivot, 0 ⇒ a pure walk.  Read it BEFORE reading any other
    //               residual: the two regimes fail differently.
    //
    // ALONG THE SWEEP AXIS is the whole of the claim: a rotation PERPENDICULAR
    // to the sweep (a walk down an aisle with the phone drifting in pitch)
    // contributes nothing to the sweep and is correctly reported as
    // rotationFraction 0.  What it does contribute — vertical drift — is
    // reported by clippedFrames / vShiftTotalPx, which is the right place for
    // it.
    double rotTravelPx = 0.0, resTravelPx = 0.0;
    double rotPathPx   = 0.0, resPathPx   = 0.0;
    double rotationFraction = 0.0;

    // What the axis/sign latch actually decided, and on what evidence.  Both
    // channel vectors are recorded even though only the TOTAL votes: their
    // DISAGREEMENT is the diagnostic (a walk that reports a large perpendicular
    // latchRotPx is an operator who tilted while walking), and the rotation
    // vector is what the removed v3 fast path would have voted.
    int    latchFramesUsed = 0;   // accepted frames the latch consumed
    bool   latchWasWeak    = false;   // decided at axisLatchMaxFrames because
                                      // nothing ever moved latchTotalPx — the
                                      // vote is weak BY CONSTRUCTION and says so
    double latchRotPx[2]   = {0, 0};   // the rotation channel, natural frame
    double latchTotPx[2]   = {0, 0};   // the TOTAL — what the latch voted on

    /// How many times the latch CORRECTED itself (Config's relatch block).
    /// > 0 means the panorama starts partway into the sweep: the frames before
    /// the correction were painted on the wrong axis/sign and discarded.  A
    /// short panorama with relatchCount 0 and one with relatchCount 1 are
    /// different findings, which is why this is in the summary and not only
    /// on the row.
    int    relatchCount    = 0;

    // ── v5: PROJECTION + WARPING ────────────────────────────────────────
    int    projection = 1;              // Config::projection, as latched
    /// Worst area magnification over every COMMITTED strip, relative to the
    /// reference optical axis.  THE operator-facing warping number.
    double maxAreaScalePainted = 1.0;
    /// Worst CROSS excursion — what the homography carries after the sweep
    /// component is removed.  Equals maxRectifyDeg in the planar arm.
    double maxCrossRectifyDeg = 0.0;
    /// Total along-sweep attitude travel (max ψ − min ψ), degrees.
    double sweepDeg = 0.0;

    // ── v5: THE CUT METRIC ──────────────────────────────────────────────
    // Roll-ups over committed strips.  These are what makes the integrity
    // verdict able to see a cut at all: v4 reported all four of the
    // operator's packs CLEAN (unpaintedColumns 0, gapBreak 0, clipping 0)
    // while he could see cuts in every one of them.
    double seamWorstBandP50Px = 0.0;
    double seamWorstBandP95Px = 0.0;
    double seamWorstBandMaxPx = 0.0;
    double seamBandSpreadP95Px = 0.0;
    /// CROSS-SWEEP SHEAR.  Per-band accumulated seam residual, max − min: a
    /// per-boundary residual of a few tenths of a px is invisible on its own
    /// and integrates over hundreds of strips into a progressive SHEAR across
    /// the strip.  A per-boundary metric alone cannot see it.
    ///
    /// ⚠ CORRECTED IN v8, and the correction is the point.  This field was
    /// documented as "THE WOBBLE NUMBER" through v5-v7 and it is NOT one.  The
    /// pose-anchor A/B of 2026-08-23 re-rendered all four operator packs under
    /// six placement arms and measured this field IDENTICAL in every anchor arm
    /// — 32.2 / 52.4 / 17.0 / 66.4 px, unchanged to three figures — while the
    /// slat-wall ruler on the same canvases moved by up to 40%.  It cannot move:
    /// the accumulator sums the PER-BAND cut error and the rigid cross
    /// placement is common to every band, so it cancels in the max−min across
    /// bands BY CONSTRUCTION.  This measures how much the strips SHEAR relative
    /// to each other, which is real and worth gating; it says nothing about how
    /// far the panorama has WALKED.  For that, see seamJogDriftPx — and read
    /// its scope note before believing its amplitude either.
    double crossBandDivergencePx = 0.0;
    /// crossBandDivergencePx is a CUMULATIVE sum: a driftless random walk
    /// grows it as sqrt(n), so an absolute bar on the raw number penalises a
    /// long sweep for being long (measured on 15-58-22 truncated: 1.6 / 3.1 /
    /// 19.5 / 52.4 px at 73 / 107 / 192 / 318 boundaries).  Dividing by
    /// sqrt(n) is the null-stable normalisation — stationary under noise at
    /// any length, still growing as sqrt(n) under a genuine systematic bias,
    /// which is the defect it exists to catch.  THIS is the gated number.
    double crossBandDivergenceNormPx = 0.0;
    double seamLumaStepP50DN = 0.0;
    double seamLumaStepP95DN = 0.0;
    double seamLumaStepMaxDN = 0.0;
    int64_t seamBoundaries = 0;
    /// Fraction of committed strips that produced a usable band measurement.
    /// A pack whose boundaries are mostly unmeasured is not a clean pack; it
    /// is an unmeasured one, and the roll-ups above describe only the
    /// measured part.
    double seamCoverageFrac = 0.0;

    /// COMMITTED-PIXEL roll-ups (FrameOutcome::seamCanvasJogPx).  Measured on
    /// the canvas from the painting warp, so this is the clause that survives
    /// any divergence between the fit and the commit.
    double seamCanvasJogP50Px = 0.0;
    double seamCanvasJogP95Px = 0.0;
    double seamCanvasJogMaxPx = 0.0;
    int64_t seamCanvasJogSamples = 0;

    /// ── v8: IS THE BAND RESIDUAL EVIDENCE, OR IS IT THE CHAIN'S OWN FIT? ──
    /// True when Config::crossAvgWindows drove the chain, i.e. when the
    /// placement is the weighted least-squares centre of the SAME K band
    /// measurements `seamWorstBand*` scores it against.  A least-squares
    /// centre must score better on its own residual, so under this flag the
    /// band percentiles are a FIT QUALITY and not a seam measurement, and the
    /// only seam number left that is independent of the placement is
    /// `seamCanvasJog*` (committed pixels, correlated through the painting
    /// matrix).
    ///
    /// It is REPORTED, not gated: the averaged placement may genuinely be
    /// better, and this flag does not claim otherwise.  What it prevents is
    /// the 22-35% band improvement being read as proof that it is, which is
    /// the same trap Config::crossFitMode == 1 is kept out of the default for.
    /// See Config::crossAvgWindows for what the independent instrument said.
    bool seamBandSelfScored = false;

    /// ── v8: THE ACCUMULATED SIGNED MISREGISTRATION.  A DIAGNOSTIC. ─────
    /// Running sum of FrameOutcome::seamCanvasJogSignedPx along the sweep:
    /// `...DriftPx` is its peak-to-peak range, `...DriftEndPx` where it
    /// finished, `...DriftSamples` how many boundaries it is made of.  The
    /// percentiles above answer "how bad is a boundary"; these answer "how far
    /// has the panorama walked", which no per-boundary statistic can reach.
    ///
    /// ⚠ THIS IS NOT THE WOBBLE NUMBER, and the scope is stated here rather
    /// than left to be assumed, because this codebase has already shipped one
    /// field labelled that way which turned out to be blind (see
    /// crossBandDivergencePx).  Validated against the slat-wall ruler on the
    /// rendered canvas of all four operator packs (twin, arm v6, swept zone,
    /// cubic-detrended):
    ///
    ///   pack       ruler slope / rms@128     this, cumulated: slope / rms@128
    ///   15-57-16   0.98 / 1.177 px           0.59 / 1.006 px
    ///   15-58-22   0.83 / 1.175 px           0.83 / 4.816 px
    ///   15-59-29   1.38 / 1.307 px           1.20 / 3.009 px
    ///   16-00-28   0.87 / 0.873 px           0.92 / 2.679 px
    ///
    /// The SLOPE tracks the ruler (mean |Δ| 0.16; both call the process a walk
    /// on 4 of 4).  The AMPLITUDE does not — 1-4× high, and it ranks the four
    /// packs in a different order — because the jog carries its own
    /// phase-correlation noise and a running sum integrates that noise
    /// alongside the defect.  So it is REPORTED and NOT GATED: it is the raw
    /// material for an on-device wobble metric, not that metric.
    double  seamJogDriftPx    = 0.0;
    double  seamJogDriftEndPx = 0.0;
    int64_t seamJogDriftSamples = 0;

    /// TRUE only when BOTH instruments produced samples.  The band metric is
    /// the only one that sees progressive shear (the divergence clause) and
    /// the jog is the only one that reads committed pixels, so a session
    /// carrying just one of them is partially blind — Config::seamMetrics
    /// off, crossWindows 1, or an axis that never latched.  Deliberately NOT
    /// the same thing as "clean": integrityFailed is TRUE whenever a session
    /// painted strips and either instrument is silent.
    bool seamMeasured = false;

    /// End-of-session chained exposure.  Measured 0.702-0.764 across every
    /// device pack — a 24-30% monotone darkening, same sign every time, i.e.
    /// a biased estimator and not noise.  Config::gainLeak is the fix and is
    /// OFF pending the operator's approval, so this number is REPORTED
    /// rather than gated: gating it would fail every pack for a defect the
    /// engine is not yet allowed to correct.
    double gainCumEnd = 1.0;

    // ── v6: RADIOMETRIC NORMALISATION ───────────────────────────────────
    /// Frames that carried usable exposure metadata.  0 on every pack
    /// captured before v6 — and on any device path where the metadata is
    /// unavailable, which the pack then STATES rather than implying by a
    /// suspiciously flat gain trace.
    int64_t exposureMetaFrames = 0;
    /// Frames whose reported exposure ratio was outside exposureGainClamp and
    /// was clamped.  Non-zero means the metadata is not to be trusted.
    int64_t exposureClampedFrames = 0;
    /// The reference frame's exposure (duration × ISO) — the datum every
    /// other frame is normalised to.  0 ⇒ never established.
    double  exposureRefValue = 0.0;
    /// Min / max exposure (duration × ISO) seen over the sweep and their
    /// ratio.  THIS is how a pack proves whether the capture-side AE lock
    /// actually held: locked ⇒ ratio 1.00, unlocked ⇒ the 1.5-1.8× the
    /// operator's v5 packs carried.  1.0 with exposureMetaFrames == 0 means
    /// UNKNOWN, not locked.
    double  exposureMinValue = 0.0, exposureMaxValue = 0.0;
    double  exposureRangeRatio = 1.0;

    // ── v11: THE NON-CIRCULAR EXPOSURE EVIDENCE ─────────────────────────
    // Everything above is measured on the `AVCaptureDevice` this pod
    // resolved and locked — the same object, read back.  Everything here is
    // measured on `ARCamera`, i.e. on the frames ARKit actually delivered.
    // Reported, never gated, and never fed to the normalisation.
    //
    // HOW TO READ THE PAIR:
    //   arExposureFrames == 0                  ⇒ ARKit's own numbers were
    //       unreachable on this build/run.  NOT "the lock failed" and NOT
    //       "the lock held" — unknown, and the pack says so.
    //   arExposureRangeRatio == 1.00 (frames>0) ⇒ the lock reached ARKit's
    //       pixels.  This is the claim the camera-lock header declined to
    //       make from the device read-back alone.
    //   arVsDeviceMaxAbsDeltaS ≈ 0 (paired>0)   ⇒ ARKit's camera and the
    //       AVCaptureDevice we locked report the SAME exposure, i.e. they
    //       are the same physical device.  A large delta is the finding
    //       that the lock was asserted on the wrong object.
    int64_t arExposureFrames = 0;
    double  arExposureMinS = 0.0, arExposureMaxS = 0.0;
    double  arExposureRangeRatio = 1.0;
    /// `ARCamera.exposureOffset` in EV.  Legitimately negative, so min/max
    /// are seeded from the first sample rather than from 0.
    double  arExposureOffsetMinEV = 0.0, arExposureOffsetMaxEV = 0.0;
    /// Frames where BOTH ARKit's duration and the device's duration were
    /// present — the denominator of the identity check below.
    int64_t arVsDevicePairedFrames = 0;
    /// Worst |ARKit duration − device duration| over the paired frames, in
    /// SECONDS, and the same as a fraction of the device duration.  Two
    /// numbers because a sub-microsecond absolute is meaningless without the
    /// scale it sits on (a 1/60 s exposure is 16.7 ms).
    double  arVsDeviceMaxAbsDeltaS = 0.0;
    double  arVsDeviceMaxRelDelta  = 0.0;

    // ── v6: THE PHOTOMETRIC SEAM + THE BAND ─────────────────────────────
    /// Per-boundary DC step over the shared footprint, ABSOLUTE DN, over the
    /// boundaries whose measurement passed the uniformity test.
    double  seamPhotoStepP50DN = 0.0;
    double  seamPhotoStepP95DN = 0.0;
    double  seamPhotoStepMaxDN = 0.0;
    int64_t seamPhotoSamples   = 0;
    /// v8 — HOW MANY boundaries were over the 3.00 DN max bar, not merely that
    /// one was.  The verdict's `seam DC step max > 3.00 DN` clause is a MAX
    /// clause: one anomalous boundary out of six hundred fires it exactly as
    /// loudly as an end-to-end band does, and the pack could not tell the
    /// operator which of those two he was looking at.  He reported "I am not
    /// sure I see the banding issue you are talking about", and this is the
    /// number that settles that class of question by measurement rather than
    /// by assertion.  The bar itself is NOT loosened — a single 3 DN seam is
    /// visible — the verdict simply now states its support.
    int64_t seamPhotoStepOverBar = 0;
    /// DIAGNOSTIC: boundaries whose difference was measured but was not
    /// DC-like ACROSS THE BOUNDARY'S EXTENT (uniformity below
    /// Config::photoUniformMinFrac) — the two owners disagree geometrically as
    /// well as photometrically there.  These ARE in the percentiles above; the
    /// count exists so a reader can tell a pack whose steps are clean offsets
    /// from one whose steps are a mess.  Measured on the operator's four
    /// packs: 8.5 / 12.5 / 16.5 / 21.3% of measured boundaries.
    int64_t seamPhotoNonUniform = 0;
    /// Boundaries where fewer than two bands could measure, so uniformity is
    /// UNKNOWN.  Counted apart from both of the above: putting them in either
    /// would assert something nothing measured.
    int64_t seamPhotoUniformUnknown = 0;
    /// THE CROSS-CHECK THE BRIEF ASKED FOR, and the reason the gate can be
    /// trusted not to be firing on scene structure: the same |step|
    /// percentiles restricted to the DC-like boundaries ALONE.  If the gate
    /// were an artefact of registration-shaped boundaries these would collapse
    /// under the bar.  Measured on the operator's four packs: 1.57 / 1.66 /
    /// 0.75 / 1.85 DN against an all-boundaries 2.09 / 1.86 / 0.77 / 2.43 —
    /// i.e. it fires on genuinely DC-like steps.
    ///
    /// REPORTED ONLY.  The verdict still reads the all-boundaries percentile,
    /// because gating on this one would condition the verdict on the
    /// boundaries that happened to look flat.
    double  seamPhotoUniStepP95DN = 0.0;
    double  seamPhotoUniStepMaxDN = 0.0;
    int64_t seamPhotoUniSamples   = 0;
    /// How far the worst band strayed from the whole-slab step, over all
    /// measured boundaries.  The continuous form of the uniformity count.
    double  seamPhotoSpreadP95DN = 0.0;
    double  seamPhotoSpreadMaxDN = 0.0;

    /// THE COMMITTED PHOTOMETRIC DRIFT, in DN.  Integrating the SIGNED
    /// per-boundary DC step along the sweep reconstructs the brightness
    /// profile the canvas actually carries relative to its first column —
    /// and, unlike the applied-scale band below, it is measured on COMMITTED
    /// PIXELS, so it includes the camera's own drift as well as the engine's.
    /// That distinction is load-bearing on any pack captured without the
    /// exposure lock: there the camera term is the larger of the two and is
    /// otherwise unobservable.
    ///
    ///   Local  = worst peak-to-peak over a Config::photoLocalWindowPx window
    ///            — THE BAND, as the eye integrates it.
    ///   Total  = end-to-end range of the same profile.
    ///
    /// In PERCENT, not DN, for two reasons: a 2 DN step on a 30 DN shadow and
    /// on a 200 DN highlight are different defects, and only a ratio can be
    /// checked against the offline owner map's independent measurement of the
    /// camera's own cumulative brightness change (C = 1.50-1.79 on these four
    /// packs).  See rnis_pano.cpp::noteSeamPhotoStep for the two
    /// normalisations and the approximation each of them makes.
    double  seamPhotoDriftLocalPct = 0.0;
    double  seamPhotoDriftTotalPct = 0.0;
    /// Canvas column along the sweep where the worst local window starts.
    int64_t seamPhotoDriftWorstU  = 0;

    /// THE BAND NUMBER.  Peak-to-peak of the EFFECTIVE photometric scale over a
    /// sliding window of Config::photoLocalWindowPx canvas columns, as a
    /// percentage.  A per-boundary step cannot see this: the chain moves 0.2%
    /// per strip and 14% over 40 columns, and it is the 40-column number the
    /// operator's eye integrates.  Measured 10.4-24.4% on his four v5 packs.
    double  photoLocalP2PPct = 0.0;
    /// Where the worst window starts, in canvas columns along the sweep — so
    /// the number can be pointed at a place in the image.
    int64_t photoLocalWorstU = 0;
    /// End-to-end range of the applied photometric scale, as a percentage.
    double  photoScaleRangePct = 0.0;
    double  photoScaleMin = 1.0, photoScaleMax = 1.0;
    /// Canvas columns that carry a recorded photometric scale — the support
    /// the two numbers above were measured over.
    int64_t photoColumns = 0;

    double  crossScaleEnd = 1.0;
    int64_t crossScaleCagedFrames = 0;
    int64_t crossScaleLeakedFrames = 0;
    int64_t crossDcRemovedFrames = 0;
    /// Frames whose band fit did not explain the bands, so the gradient was
    /// refused. Reads 0 when the gate is off AND when it never refused.
    int64_t crossBandFitRefused = 0;
    /// Frames the image cross-scale declined because the sweep was world-VERTICAL,
    /// where the rails run across the sweep and there is nothing to correct.
    /// Non-zero on a vertical sweep with the mode on; 0 on a sideways one.
    int64_t crossGestureRefused = 0;
    /// The mean mode-1 gradient actually seen. The DC the wobble rode on.
    double  crossGMean = 0.0;
    /// The distance the placement ACTUALLY USED on the last accepted frame —
    /// which under the default subjectDistanceAuto is the online fit, not the
    /// configured value.  Both are reported because a field named "used" that
    /// carries the value that was not used is worse than no field at all.
    double  subjectDistanceUsedM = 0.0;
    double  subjectDistanceConfiguredM = 0.0;  // Config::subjectDistanceM
    double  subjectDistanceFitM  = 0.0;   // what the K windows measured (0 = none)

    // ── v11: WHY THE FIT IS ALLOWED TO BE WRONG, IN THE PACK ────────────
    //
    // THE DEFECT THESE FIELDS EXIST TO MAKE VISIBLE (measured on the three
    // Test-13 field packs, 2026-08-30): `subjectDistanceFitM` returned
    // 1.95 / 6.00 / 5.87 m against a standoff measured two independent ways
    // at 0.6-1.0 m — 2× to 7.5× wrong on EVERY pack, sitting on the 6.0 m
    // clamp rail on two of three — and NOTHING in the pack said so, because
    // the fit self-scores.  A number that is 7.5× wrong and silent is worse
    // than no number.
    //
    // THE MECHANISM, which is structural rather than unlucky.  The estimator
    // regresses the integrated cross log-scale on FORWARD travel along the
    // reference optical axis.  Holding standoff is the POINT of a shelf
    // sweep, so forward travel is 1.0% / 11.2% / 5.1% of the perpendicular
    // travel on those packs: `dFitDen = Σfwd²` is tiny, the normal equation
    // is ill-conditioned, and the ratio runs away into the clamp.
    //
    // NOTHING HERE CHANGES THE ESTIMATOR OR THE VERDICT.  These are the
    // regression's own internals, published so a reader can grade the number
    // instead of trusting it.  `integrityFailed` deliberately gains no
    // clause: the predictor is benign-degenerate (with fwd ≈ 0 the model
    // predicts s = exp(−fwd/d) ≈ 1 whatever d is), so a wrong d costs these
    // packs almost nothing — failing them for it would be a false alarm.
    // The fix to the estimator is a separate, un-approved piece of work.

    /// The UNCLAMPED ratio the last accepted frame computed, in metres.
    /// `subjectDistanceFitM` is this passed through max(0.3, min(6.0, ·)).
    /// 0 ⇒ the fit never ran (no accepted post-latch frame, or the guards
    /// below never opened).  THE field that makes saturation provable: a
    /// clamped 6.00 and a genuine 6.00 are indistinguishable without it.
    double  subjectDistanceFitRawM = 0.0;
    /// TRUE when the SHIPPED value is a clamp rail rather than a
    /// measurement, i.e. the last raw ratio fell outside [0.3, 6.0].
    bool    subjectDistanceFitSaturated = false;
    /// How many of the fit's updates were clamped, and how many were
    /// REFUSED for a non-finite or non-positive ratio.  A refusal silently
    /// retains the previous value — so a pack whose fit stopped updating
    /// halfway looks identical to one that converged, unless this is
    /// reported.
    int64_t subjectDistanceFitClampedUpdates = 0;
    int64_t subjectDistanceFitRefusedUpdates = 0;
    /// Σfwd² (m²) and Σ fwd·(−Σlog s) (m) — the regression's denominator and
    /// numerator at the end of the sweep.  THE denominator the brief asked
    /// for: it is the conditioning of the whole estimate, and on the field
    /// packs it is ~1e-4 m².
    double  subjectDistanceFitDen = 0.0;
    double  subjectDistanceFitNum = 0.0;
    /// Accepted post-latch frames that contributed a sample.
    int64_t subjectDistanceFitSamples = 0;
    /// The regressor's LEVERAGE, in metres: the span of forward travel
    /// actually seen (max fwd − min fwd), against the largest perpendicular
    /// displacement from the reference pose over the same frames.  These are
    /// the two numbers whose RATIO is the study's 1.0% / 11.2% / 5.1%.
    double  subjectDistanceFitFwdSpanM  = 0.0;
    double  subjectDistanceFitPerpSpanM = 0.0;
    /// fwdSpan / perpSpan.  0 when there was no perpendicular travel to
    /// divide by (a pure dolly, where the estimator is well conditioned and
    /// this number would be meaningless rather than good).
    double  subjectDistanceFitLeverRatio = 0.0;
    /// TRUE when the leverage is below `kSubjectDistanceFitLeverBar` — the
    /// regressor had almost no forward travel to regress ON, so the fit is
    /// not evidence about the standoff whatever value it returned.  A
    /// DIAGNOSTIC with a named bar, never a gate: see the note above on why
    /// `integrityFailed` does not move.
    bool    subjectDistanceFitDegenerate = false;
    /// TRUE when `subjectDistanceAuto` was on and the fit produced a value,
    /// i.e. the placement really did run on the fit rather than on
    /// `Config::subjectDistanceM`.  Without it, "the fit was 6.00 m" and
    /// "the placement used 6.00 m" have to be inferred from two other
    /// fields and the config.
    bool    subjectDistanceFitInForce = false;

    /// THE PROJECTION SWITCH.  ψ is gated on the axis latch, so the frame
    /// before the latch is placed on the tangent (f·tan ψ) and the frame
    /// after on the arc (f·ψ).  The step is bounded (pre-latch ψ is still
    /// inside the 35° excursion gate) and self-correcting (the next
    /// correlation folds it into posNat once), but the brief asked that the
    /// projection never change mid-sweep without being ledgered, so it is.
    /// -1 = never switched (planar arm, or never latched).
    int64_t projectionSwitchSeq = -1;
    double  projectionSwitchStepPx = 0.0;

    /// TRUE when the pack must NOT be called clean.  The engine's own answer
    /// to "would this pack have been reported intact?".  Consumers may apply
    /// their own thresholds; this is the one the engine ships:
    ///
    ///     painted > 0 && seamBoundaries == 0           (NOT MEASURED != clean)
    ///     painted > 0 && seamCanvasJogSamples == 0     (NOT MEASURED != clean)
    ///     seamWorstBandP95Px        >  0.50
    ///     seamWorstBandMaxPx        >  1.50
    ///     crossBandDivergenceNormPx >  6.00   (sqrt(n)-normalised, see above)
    ///     seamCanvasJogP95Px        >  1.50   (committed pixels)
    ///     seamCanvasJogMaxPx        >  4.00   (committed pixels)
    ///
    /// v6 adds the PHOTOMETRIC clauses.  v5 measured a seam DC step and did
    /// NOT gate on it, which is why pack 15-58-22 reported clean with a
    /// visible band in it:
    ///
    ///     painted > 0 && seamPhotoSamples == 0  (NOT MEASURED != clean)
    ///     seamPhotoStepP95DN        >  1.20  DN (shared-footprint median)
    ///     seamPhotoStepMaxDN        >  3.00  DN
    ///     seamPhotoDriftLocalPct    >  6.00  %  (THE BAND on COMMITTED pixels)
    ///     photoLocalP2PPct          >  6.00  %  (the ENGINE's own share)
    ///     photoScaleRangePct        > 20.00  %  (end-to-end drift)
    ///
    /// The first clause is the one the v4 blind verdict lacked in two ways at
    /// once: v4 had no seam metric, and a v5 session that fails to measure
    /// one must not inherit v4's silence.  The two jog clauses are the ones
    /// that read PAINTED PIXELS rather than the placement's own arithmetic.
    /// Calibration, on the operator's own four packs: ALL FOUR fail under the
    /// v4 model; three of four pass under v5 and the fourth fails on a real
    /// local parallax cut.
    bool integrityFailed = false;

    // ── v10: WHAT THE LENS GATE DECIDED, AND ON WHAT ────────────────────
    // A pack that was NOT corrected must say so — "no lens block" and "the
    // lens block says unknown-device" are different facts, and only the second
    // one is self-describing.  Every field here is a MEASUREMENT or a
    // decision, never a request.
    bool        lensApplied = false;
    std::string lensGate;               // lens::gateName of the decision
    std::string lensSource;             // provenance of the applied model
    std::string lensDevice;             // the body the gate saw
    std::string lensDeviceLens;         // the lens the host could name (may be "")
    double      lensK1 = 0.0, lensK2 = 0.0;
    double      lensFxOverWidth = 0.0;         // what the gate measured
    double      lensExpectedFxOverWidth = 0.0; // what the table wanted
    /// TWO DIFFERENT NUMBERS, BOTH NAMED, because one field called "peak"
    /// invites exactly the conflation the design had to correct:
    ///
    ///  · `lensPeakRadialPx` — max |r_observed − r_ideal| in SOURCE px over
    ///    the frame's own radius range. The TOTAL radial move, scale term
    ///    included. On iPhone17,1 wide this is ≈5.11 px at r≈980 px.
    ///  · `lensPeakResidualPx` — the same field after least-squares removal of
    ///    the pure-scale term (d ← d − a·r): the MOUSTACHE, i.e. the only part
    ///    that can bend a straight line. On the same body/raster this is
    ///    2.79-2.86 px on the operator's four packs, and it peaks at the
    ///    frame CORNER, not at r≈980.
    ///
    /// ⚠ AND A THIRD NUMBER THAT IS NOT EITHER OF THESE. The fit round's
    /// write-up quotes "−4.36 px peak at r≈935, −0.38 px at the corner". That
    /// is `lensPeakRadialPx` computed on the SINGLE-SHOT ROBUST coefficients
    /// (k1 −0.023494, k2 +0.028524), not on the FIXPOINT pair that ships —
    /// reproduced exactly: −4.35 px at r=937, −0.38 px at the corner. Same
    /// quantity, different fit. The two fits differ by 2.6 % in k1 and by
    /// **6×** at the frame corner (−0.38 px vs −2.36 px), because the slat wall
    /// puts no lines out there to constrain them. Do not quote a corner number
    /// as an established property of the shipped model.
    ///
    /// Both are 0 when nothing was applied.
    double      lensPeakRadialPx = 0.0;
    double      lensPeakResidualPx = 0.0;
    /// Strips committed THROUGH the correction, and strips that fell back
    /// because the frame they painted from carried a focal the gate refuses
    /// (a lens switch mid-sweep). The second being non-zero on a shipped pack
    /// is a finding, not noise.
    ///
    /// COUNTED ON COMMIT, not on attempt: a strip that resamples and then
    /// commits zero columns (the whole warp mask fell outside the claimed
    /// span) is neither corrected nor skipped, because it contributed no
    /// pixels to the deliverable. And both are RE-BASED by a reference reseed,
    /// exactly like every other seam/session metric there — after a relatch
    /// the counters must describe the canvas that survives, not one that was
    /// discarded.
    int64_t     lensCorrectedStrips = 0;
    int64_t     lensSkippedStrips = 0;
    /// THE DENOMINATOR that makes the two above checkable: every strip that
    /// committed at least one column, from any path — the bootstrap lead-in,
    /// the steady-state strips, an interior backfill, the tail flush.  It is
    /// NOT `painted` (a frame count): a sweep commits two strips that no frame
    /// row is marked Painted for, which is why the first cut of the ledger
    /// read "347 corrected" against "345 painted" and looked broken when it
    /// was merely being compared against the wrong number.  With the
    /// correction live and no lens switch, corrected + skipped == this.
    int64_t     stripsCommitted = 0;
    /// OPTION C (`Config::leadReplace`), and it is included in
    /// `stripsCommitted` above — a lead-in fill IS a committed strip, with its
    /// own lens verdict, and hiding it would break the one identity that makes
    /// the lens counters checkable (corrected + skipped == committed).  A fill
    /// placed as a run of arc slices is ONE strip, banked once, exactly as the
    /// arc seed and the arc tail are.  Both are RE-BASED by a relatch, with
    /// `stripsCommitted` and for the same reason — a relatch throws its canvas
    /// away, and a counter that kept describing it would make the containment
    /// stated here false.  So: how much of that total was the lead-in fill,
    /// read off the pack rather than estimated; 0 / 0 whenever the flag is
    /// off.
    int64_t     leadRepaintStrips = 0;
    double      leadRepaintPx = 0.0;
    /// Human-readable list of the clauses that fired ("" when none did), so a
    /// pack reader never has to re-derive which bar failed.
    std::string integrityReason;

    // ── THE TAIL FLUSH, MADE OBSERVABLE ─────────────────────────────────────
    // `Engine::finish()` paints a lead-out strip from the LAST painted frame,
    // and on the operator's packs that one strip is 29-48% OF THE DELIVERABLE.
    // Until 2026-08-30 its body sat inside
    //
    //     } catch (const cv::Exception&) {
    //     } catch (const std::exception&) {
    //     }
    //
    // — the same swallow-everything idiom that hid the empty live preview for
    // eleven days, on the path that produces up to half the panorama.  A throw
    // there dropped the last third of the image and left `tailFlushed` false,
    // and `tailFlushed` reached NOTHING: not the status, not meta.json, not
    // the summary.  The panorama would simply have been short, with no field
    // anywhere able to say why.
    //
    // Read the three together:
    //   tailFlushAttempted  the sweep had a lead-out to paint at all (a sweep
    //                       that never latched, or whose frontier already
    //                       reached the last frame's edge, legitimately has
    //                       none — that is `false`, not a fault)
    //   tailFlushed         the lead-out ran to completion (it may legitimately
    //                       have had zero columns left to paint).  attempted &&
    //                       !this ⇒ it THREW, and the panorama is missing its
    //                       tail.
    //   tailFlushError      why, in the thrower's own words ("" when clean).
    bool        tailFlushAttempted = false;
    bool        tailFlushed = false;
    std::string tailFlushError;
    /// ── HOW MUCH OF THE PANORAMA THE LEAD-OUT OWNS ──────────────────────
    ///
    /// The along-axis extent, in canvas px, that {@link tailFlushed} painted
    /// in ONE block from ONE frame.
    ///
    /// ⚠ THIS IS A QUALITY FACT, NOT A COUNTER, and it is here because the
    /// bool above is not enough to read the picture. Measured on nine of the
    /// operator's iPhone packs, 2026-09-20: the lead-out spans 353 and 449
    /// canvas columns on packs whose every incremental strip is 1-33 px wide
    /// — 13% and 24% of the finished panorama, from a SINGLE frame, with no
    /// per-strip registration, no gain chain and one pose. That region is
    /// where the band collapses (median thickness 952 px -> 5 px) and where
    /// the top-edge boundary excursion lives (peaks 863 px, confined to
    /// columns 1413-1440 of 1441). It is the operator's own report: "in the
    /// output, I want you to see why there is some broken parts towards the
    /// edges".
    ///
    /// It is NOT free to delete — measured both ways: dropping those columns
    /// costs 24% of kept pixels on one pack and buys 9 points of painted
    /// fraction on the other. The region carries real image; what is wrong
    /// is its QUALITY, not its presence. So it is REPORTED, at the extent
    /// that makes it readable, rather than removed or hidden.
    ///
    /// 0 when the lead-out did not run, which is not the same as 0 columns
    /// painted by one that did — read {@link tailFlushAttempted} alongside.
    int64_t     tailFlushColumns = 0;

    // ── TRAJECTORY CONTINUATION (`Config::crossTraj`) ───────────────────
    // What the tail flush and the seed re-placement measured and applied.
    // All zero / false with the flag off.  `*Applied` false with the flag ON
    // means the estimator DECLINED (window unfilled, correlation too weak, or
    // a nonsense fit) and the block was placed exactly as before.
    bool        tailTrajApplied = false;
    double      tailTrajSlope = 0.0;    // canvas cross px per along px
    double      tailTrajFan = 0.0;      // d(slope)/d(cross px)
    double      tailTrajStepPx = 0.0;   // fitted offset AT the join (diagnostic;
                                        // ~0 by construction, never applied)
    double      tailTrajStepFan = 0.0;  // its fan (diagnostic, never applied)
    int         tailTrajSamples = 0;
    int         tailTrajBands = 0;
    double      tailTrajResponse = 0.0; // mean correlation peak (estimator 2)
    bool        seedTrajApplied = false;
    double      seedTrajSlope = 0.0;
    double      seedTrajFan = 0.0;
    double      seedTrajStepPx = 0.0;   // the step the seed's rear half WAS
                                        // shifted by (applied, unlike the tail's)
    double      seedTrajStepFan = 0.0;  // and its fan (cross scale about the axis)
    int         seedTrajSamples = 0;
    double      seedTrajRepaintPx = 0.0; // columns of the seed's rear half re-placed

    std::string abortReason;            // empty ⇒ clean
};

// ── The engine ──────────────────────────────────────────────────────────────
class Engine {
public:
    Engine();
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    /// Validate + adopt `cfg`.  Must be called before ingest().  Returns false
    /// (and fills `err`) on a degenerate config; the engine stays unusable.
    bool configure(const Config& cfg, std::string* err);

    /// Process exactly one frame.  Never throws.  ALWAYS returns a row.
    FrameOutcome ingest(const FrameInput& in);

    /// Lead-out: paint the last painted frame's remaining footprint ahead of
    /// the frontier, so the sweep does not end on a black tail.  Idempotent;
    /// returns the synthetic ledger row (Outcome::TailFlush) or an outcome
    /// with canvasX1 == canvasX0 when there was nothing to flush.
    FrameOutcome finish();

    /// Downscaled BGR band of the painted extent, for the live preview.
    /// Returns false when nothing is painted yet.
    ///
    /// ⚠ THE BOX IS IN ORIENTED OUTPUT TERMS (`maxW` x `maxH` of the image the
    /// operator would SEE), which is why it is the wrong entry point for a
    /// caller that does not know which way the sweep runs — see
    /// {@link previewIntoFit}.
    bool previewInto(cv::Mat& out, int maxW, int maxH) const;

    /// AXIS-AWARE preview fit.  The box is given in SWEEP terms — `maxAlong`
    /// caps the extent the sweep is GROWING along, `maxCross` the
    /// perpendicular one — and is mapped onto the oriented output HERE, where
    /// the latched axis is known.
    ///
    /// WHY THIS EXISTS, on the record.  `previewInto`'s box is oriented W x H,
    /// and its one shipped caller (RNISPanoCore) passed a LANDSCAPE box,
    /// 1400x220.  Every one of the operator's four device packs is a VERTICAL
    /// sweep (`axis == 1`, 1344x1471 output — he pans the phone top to bottom
    /// in landscape), so the fit collapsed to min(1400/1344, 220/1471) = 0.15
    /// and produced a 201x220 thumbnail of a 1344-px-wide shelf, which then
    /// went into a 120 px letterbox on screen.  That is the "I do not see a
    /// live preview of the image growing" report of 2026-08-23: the preview
    /// was being produced the whole time and was ~1/6 of the size it should
    /// have been, SHRINKING as the sweep grew.  The box has to turn with the
    /// sweep, and only the engine knows which way that is.
    ///
    /// Before the axis latches (`axis` defaults to 0) this is exactly
    /// `previewInto(out, maxAlong, maxCross)` — nothing is painted then
    /// either, so it returns false regardless.
    ///
    /// `windowAlongPx > 0` asks for a FRONTIER WINDOW instead of the whole
    /// panorama: the trailing `windowAlongPx` canvas px ending at the painted
    /// band's leading edge.  0 (the default, and every pre-existing caller)
    /// is the whole band, byte for byte as before.  See {@link PreviewWindow}
    /// for what it is for and what it measured against.
    /// `cropPadRows` additionally trims the rows NOTHING ever painted — the
    /// canvas's two 128 px pads, 21% of the operator's 1216-row canvas and
    /// therefore 21% of his preview panel.  It is the row UNION, so it can
    /// never cut a committed pixel and the ragged rectified edge stays
    /// visible; that is a different question from `cropVertical`, which cuts
    /// to the per-column INTERSECTION and has to be able to decline.
    /// Default false, so every pre-existing caller is byte-identical.
    /// `leadOut` composites the PROVISIONAL region between the commit frontier
    /// and the live frame's leading edge into the preview — dimmed, preview
    /// only, never the canvas.  Without it the preview trails where the phone
    /// points by half the along-sweep FoV (42.8° on the ultra-wide), because
    /// strips commit only up to the frame's projected CENTRE.  Default false:
    /// byte-identical for every pre-existing caller.
    bool previewIntoFit(cv::Mat& out, int maxAlong, int maxCross,
                        int windowAlongPx = 0, PreviewWindow *win = nullptr,
                        bool cropPadRows = false, bool leadOut = false) const;

    /// The canvas's CROSS extent in canvas px, or 0 before the latch sizes it.
    /// A one-word accessor rather than `stats().canvasH` because the live
    /// preview needs it on every tick and `stats()` allocates seven strings.
    int canvasHeightPx() const noexcept;

    /// The cross extent the NEXT preview publish will actually carry, in
    /// canvas px — i.e. `canvasHeightPx()` with the unpainted pad rows trimmed
    /// when `cropPadRows` is on, which is what both hosts ship.
    ///
    /// This exists because the two are not interchangeable and a host that
    /// used the wrong one produced a visible artefact.  The preview WINDOW is
    /// sized as `mult * cross`, where `mult` is the on-screen capsule's own
    /// along/cross ratio — so the window is meant to engage exactly at the
    /// knee where the panorama stops filling the capsule's thickness.  Measured
    /// against the PADDED height (1216 rows on the operator's packs, of which
    /// only ~960 are ever painted) the window engages ~27% too late, and in
    /// that gap the panorama is length-limited inside a fixed-thickness strip:
    /// it draws thin, with black bars down both long edges, then snaps back to
    /// full thickness when the window finally kicks in.  Multiply by THIS.
    ///
    /// Returns 0 before the latch sizes the canvas, like `canvasHeightPx()`.
    int previewCrossPx(bool cropPadRows) const noexcept;

    /// The shared renderer behind both preview entry points.  Box in ORIENTED
    /// output terms (like {@link previewInto}); `windowAlongPx <= 0` is the
    /// whole painted band.  Public because the window is a claim about
    /// geometry and a claim about geometry should be assertable directly.
    bool previewIntoWindowed(cv::Mat& out, int maxW, int maxH,
                             int windowAlongPx, PreviewWindow *win,
                             bool cropPadRows = false,
                             bool leadOut = false) const;

    /// The finished panorama: cropped to the painted extent and rotated ONCE
    /// into natural viewing order (undoing the axis/sign remap).  Returns
    /// false when nothing is painted.
    /// v12 — `cropPadRows` applies the SAME row-union pad trim the preview
    /// has always applied, so the deliverable and the last preview agree on
    /// aspect (they used to differ by the two unpainted 128 px pads — 18.6%
    /// black bars the preview never showed).  Row UNION, so no committed
    /// pixel can be lost; degenerate bands decline the trim.  Default false:
    /// byte-identical for every pre-existing caller.
    /// `cropCrossLoPx`/`cropCrossHiPx` report the APPLIED trim (canvas rows
    /// removed at the low/high cross edge; 0 when the trim was off or
    /// declined), so canvas-frame coordinates elsewhere in the pack stay
    /// reconcilable with canvas.jpg.
    bool finalCanvas(cv::Mat& out, bool cropPadRows = false,
                     int* cropCrossLoPx = nullptr,
                     int* cropCrossHiPx = nullptr) const;

    /// THE COVERAGE MASK FOR THE FINISHED PANORAMA — CV_8UC1, 255 where a
    /// frame committed a pixel, byte-aligned with {@link finalCanvas}'s
    /// output at the SAME `cropPadRows`.
    ///
    /// ⚠ WHY THIS EXISTS AT ALL, when the engine already reports
    /// {@link verticalEnvelope}: the envelope is per-column (top, bottom)
    /// PRE-ORIENTATION and only its summary reaches `meta.json`, so no
    /// consumer of `canvas.jpg` can reconstruct which pixels are painted.
    /// The one that needs to is the maximum-inscribed-rectangle crop, and
    /// without a mask it falls back to a BRIGHTNESS PROXY — which cannot
    /// tell dark CONTENT from unpainted canvas. Measured on the operator's
    /// own sweep (`pp_1789931447063`, 1441x1026): the brightness mask put
    /// the largest rectangle at 24.3% of the canvas, a thin band across the
    /// ceiling with the whole room excluded, because a black TV in the middle
    /// of the frame forced the rectangle above it. The true answer on the
    /// same image and the same algorithm is 68.4%. Border-connected
    /// hole-filling — which both platforms already apply — recovers the TV
    /// and still loses every dark object that TOUCHES the boundary, which on
    /// that pack is a high chair on the left, a ceiling fan on the top and
    /// the floor on the right.
    ///
    /// The batch stitcher has written this sidecar since v0.15 and both
    /// platforms' `computeInscribedRect` already prefer it; pano+ wrote none,
    /// so the sweep was the one engine on the proxy.
    ///
    /// ⚠ PASS THE SAME `cropPadRows` AS `finalCanvas`. The two are rendered
    /// by one function through one geometry path, and this argument is the
    /// only thing that can separate them. A mask of a different size is
    /// refused by every consumer (they re-check dimensions), so the failure
    /// mode is a silent fallback rather than a wrong crop — but it is still
    /// a lost mask.
    bool finalCoverage(cv::Mat& out, bool cropPadRows = false) const;

    SessionStats stats() const;

    /// Interior slices inside the painted extent that no frame ever owned, as
    /// [start, end) runs ALONG THE SWEEP AXIS, in final sweep order.
    ///
    /// ⚠ These index the SWEEP axis, which is the output's COLUMN axis only
    /// for a horizontal sweep (stats().axis == 0).  A vertical sweep
    /// (axis == 1) is transposed by the finalize bake, so the same runs index
    /// the output's ROW axis.  A consumer that prints "columns" unconditionally
    /// is wrong half the time — read stats().axis alongside this.
    ///
    /// Empty ⇒ the G1 zero-breaks guarantee held ALONG THE SWEEP.  It says
    /// nothing about the perpendicular direction: for that read
    /// SessionStats::clippedFrames / clippedColumns.
    std::vector<std::pair<int, int>> unpaintedRuns() const;

    /// Per painted column, the [top, bottom) row band that carries pixels —
    /// the ragged edge left by attitude rectification.  Pre-orientation.
    std::vector<std::pair<int, int>> verticalEnvelope() const;

    /// Abandon the sweep with a reason (the caller's session-lifecycle
    /// detector; the engine has its own too).  Painted content is kept.
    void abort(const std::string& reason);

    void reset();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace pano
}  // namespace rnis
