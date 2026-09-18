// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoCalibCore.h — Obj-C façade over `cpp/rnis_pano_calib.{hpp,cpp}` and
// the `selectBasis` half of `cpp/rnis_pano_attitude`.
//
// PURE OBJ-C ON PURPOSE, for the reason RNISPanoCore.h and RNISPanoAttitude.h
// both state: the podspec puts every `ios/*.h` into the pod umbrella, the
// umbrella is compiled in Obj-C context, and a C++ type here would break the
// pod for any `use_frameworks!` host.  All C++ lives in the .mm.
//
// ── What this owns, and why it is a RECORDER and not a function ──────────
//
// The basis calibration is a CONCURRENT LOG: CoreMotion attitude arriving on
// its own queue at ~100 Hz, and the ARKit `world←camera` quaternion arriving on
// the ARKit delegate thread at 60 Hz, for several seconds.  Marshalling those
// through the RN bridge sample by sample would put a JS round-trip on the
// ARKit delegate thread — the one thread whose stall costs tracking for every
// plugin in the registry.  So both series are pushed straight into C++ vectors
// behind one lock, and JS sees only the reduction.
//
// ── THE REFERENCE IS `context.poseRotation`, NOT A SECOND ARSession ──────
//
// `RNISPanoPlusPlugin` feeds the engine `RNISARFrameContext.poseRotation`.  The
// basis `C` is defined by what the ENGINE consumes, so the calibration's
// reference must be that exact quantity, arriving through that exact code
// path.  Opening a private `ARSession` to get "the same thing" would introduce
// a convention that has to be argued rather than observed — and it could not
// run beside the app's own AR session anyway.
//
// ── Cross-lens transfer, stated rather than assumed ──────────────────────
//
// ARKit streams the WIDE camera; the decoupled arm streams the PHYSICAL
// ULTRA-WIDE.  `C` measured against one is applied to the other, and that is
// sound for one specific reason: `C` ranges over the 24 signed permutations,
// whose members are 90° apart.  Two back cameras on one rigid body are mounted
// parallel to within a fraction of a degree, so no mounting tolerance can
// promote one candidate over another.  It is recorded in the calibration
// record as `referenceSource` so nobody has to reconstruct this paragraph.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RNISPanoCalibCore : NSObject

// ── The concurrent recorder ─────────────────────────────────────────────

/// Drop both series and begin a fresh recording.  `capImu` / `capRef` bound the
/// buffers; 0 uses the defaults (24000 / 7200 ≈ 4 minutes at 100 / 30 Hz).
/// Growth past the cap STOPS and is counted — it never wraps, because a ring
/// would silently discard the beginning of the gesture and the operator would
/// be graded on the end of it.
+ (void)beginRecordingImuCap:(NSUInteger)capImu refCap:(NSUInteger)capRef
    NS_SWIFT_NAME(beginRecording(imuCap:refCap:));

/// Append one CoreMotion attitude sample (`R_ref←device`), sensor timebase.
+ (void)pushImuAtTimeS:(double)tS
                    qx:(double)qx qy:(double)qy qz:(double)qz qw:(double)qw
    NS_SWIFT_NAME(pushImu(atTimeS:qx:qy:qz:qw:));

/// Append one REFERENCE attitude sample (`world←camera`, exactly the quantity
/// `RNISARFrameContext.poseRotation` carries), ARKit timebase.
+ (void)pushRefAtTimeS:(double)tS
                    qx:(double)qx qy:(double)qy qz:(double)qz qw:(double)qw
    NS_SWIFT_NAME(pushRef(atTimeS:qx:qy:qz:qw:));

/// Count a reference frame that was DROPPED because ARKit was not tracking
/// normally.  A pose from a `limited` frame is not a reference; it is a guess,
/// and averaging guesses into the datum the whole basis is measured against is
/// how a calibration comes back confident and wrong.
+ (void)noteRefRejectedForTracking;

/// Free both buffers.  Safe to call twice.
+ (void)endRecording;

/// The LIVE coaching read, cheap enough to poll at a few Hz: how much the
/// REFERENCE series has turned, per named axis, and what is still missing.
///
/// Keys: `steps`, `stepsBelowFloor`, `sweptDeg`, `spanDeg`, `perAxisDeg`
/// ({tilt,pan,roll}), `eig`, `rank2`, `rank3`, `sufficient`, `reason`,
/// `needMore` ({tilt,pan,roll}), `exercisedAxes`, `progress`, plus
/// `imuSamples` / `refSamples` / `refRejectedTracking` / `truncated`.
///
/// ⚠ The per-axis names are read off the REFERENCE series only.  Naming the
/// IMU series' axes would be naming the very thing `C` has not been solved for.
+ (NSDictionary<NSString *, id> *)liveExcitation;

/// Reduce the recording to a verdict.
///
/// `tauS` — the offset between the ARKit and CoreMotion timebases used for the
/// fit.  Both run on the system uptime clock, so 0 is the physical answer; the
/// `stabilityOffsetsS` sweep is what turns "0 is right" from an assumption into
/// an observation.  Pass nil for the default `{-0.010, -0.005, 0, 0.005, 0.010}`.
///
/// Returns the full payload — `basis` (the winner and the persist decision),
/// `selection` (the ranked runners-up and the margin), `drift` (the
/// architecture verdict, kept SEPARATE because it is not evidence about which
/// permutation is correct), `excitationRef` / `excitationImu`, `stability` (the
/// τ-sensitivity sweep) and `policy`.
///
/// It NEVER returns a bare index: `basis.ok` is the only field a caller may act
/// on, and `basis.index` is present even on a refusal so the operator can see
/// what was rejected and by how much.
+ (NSDictionary<NSString *, id> *)solveBasisWithTauS:(double)tauS
                                   stabilityOffsetsS:(nullable NSArray<NSNumber *> *)offsets
    NS_SWIFT_NAME(solveBasis(tauS:stabilityOffsetsS:));

// ── τ: the repeat-combine, and its gate ─────────────────────────────────

/// Combine repeated optical τ measurements into one number WITH A STATED
/// UNCERTAINTY, and decide whether it may be persisted.
///
/// Each element of `runs` is `{ resolved: BOOL, tauMs: NSNumber,
/// peakR: NSNumber, bandWidthMs: NSNumber }` — the shape `CaptureClockProbe`
/// already returns.
///
/// ⚠ THE GATE IS ON THE UNCERTAINTY, NEVER ON |τ|.  The study's 3.08 ms p95 is
/// the budget for the alignment error that SURVIVES the correction; grading the
/// magnitude of τ against it grades the disease against the tolerance for the
/// cure.  A −11 ms offset repeatable to ±0.1 ms is an excellent calibration; a
/// +0.9 ms one recovered from three runs that disagree by 6 ms is not a
/// calibration at all.
+ (NSDictionary<NSString *, id> *)combineTauRuns:(NSArray *)runs
    NS_SWIFT_NAME(combineTauRuns(_:));

/// The policy constants, so a panel and a pack quote the SAME bars rather than
/// each carrying their own copy of 3.08.
+ (NSDictionary<NSString *, id> *)policy;

@end

NS_ASSUME_NONNULL_END
