// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoAttitude.h — Obj-C façade over `rnis::pano::AttitudeAligner`
// (cpp/rnis_pano_attitude.{hpp,cpp}), so the Swift AVF source can drive the
// SHARED time-alignment policy instead of carrying its own.
//
// PURE OBJ-C ON PURPOSE, for the reason RNISPanoCore.h states: the podspec
// puts every `ios/*.h` into the pod umbrella and the umbrella is compiled in
// Obj-C context, so a C++ type here would break the pod for any
// `use_frameworks!` host.  All C++ lives in the .mm.
//
// ── Why a façade at all, rather than the policy in Swift ─────────────────
//
// Because the Android leg calls the SAME translation unit through JNI.  τ
// application, bracket-or-refuse, SLERP and the derived tracking state are
// the one place an iOS implementation and an Android implementation would
// silently diverge — silently, because both would produce a canvas.  This
// file is 100 lines of marshalling; the alternative is the policy written
// twice.
//
// ── Threading ────────────────────────────────────────────────────────────
//
// `AttitudeAligner` is deliberately NOT thread-safe (the header says so), and
// on this path `push` runs on the CoreMotion queue while `align` runs on the
// AVCaptureVideoDataOutput queue.  THE LOCK LIVES HERE, in exactly one place,
// so neither caller can forget it and there is no second invisible lock beside
// the frame ring's.
//
// ── Lifetime ─────────────────────────────────────────────────────────────
//
// Class methods over one process-wide aligner, matching RNISPanoCore's shape:
// there is at most one pano+ sweep at a time, and the alternative (an instance
// handed across the Swift/ObjC/C++ boundary) buys nothing.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Mirrors `rnis::pano::AlignRefusal` so Swift never hardcodes a raw value.
/// The two are pinned to each other by `static_assert` in the .mm — a comment
/// saying "keep these in sync" is exactly the mechanism that fails silently.
typedef NS_ENUM(int, RNISPanoAlignRefusal) {
    RNISPanoAlignRefusalNone              = 0,
    RNISPanoAlignRefusalTauNotMeasured    = 1,   ///< FATAL
    RNISPanoAlignRefusalBasisNotValidated = 2,   ///< FATAL
    RNISPanoAlignRefusalBufferEmpty       = 3,
    RNISPanoAlignRefusalBeforeFirstSample = 4,
    RNISPanoAlignRefusalAfterLastSample   = 5,   ///< the IMU is behind: HOLD, never extrapolate
    RNISPanoAlignRefusalNonFiniteInput    = 6,
    RNISPanoAlignRefusalLurch             = 7,
    /// FATAL — the configuration claimed a MEASURED τ *and* an explicitly
    /// UNCORRECTED sweep (or claimed uncorrected while carrying a non-zero τ).
    /// Its own value, because it sends the caller somewhere entirely different
    /// from `TauNotMeasured`: not "go and measure one" but "you asked for two
    /// mutually exclusive things".
    RNISPanoAlignRefusalTauModeConflict   = 8,
};

/// One aligned frame.  A plain C struct returned BY VALUE — no allocation on
/// a path that runs 60 times a second, and no optional to unwrap in the hot
/// loop.
typedef struct {
    bool   ok;
    double qx, qy, qz, qw;   ///< world←cam (GL), ready for RNISPanoCore ingest
    int    tracking;         ///< 0 notAvailable / 1 limited / 2 normal, DERIVED
    RNISPanoAlignRefusal refusal;
    bool   fatal;            ///< the refusal is a CONFIGURATION fault
    bool   lurchEvaluated;
    double bracketGapS;
    double alpha;
    double targetS;
} RNISPanoAlignResult;

@interface RNISPanoAttitude : NSObject

/// Configure and CLEAR the aligner.  Returns NO with `*error` when the
/// configuration could never align a frame — a missing τ or an unvalidated
/// basis — so a sweep can be refused at `start` rather than producing a
/// canvas-free run of refusals the operator has to interpret afterwards.
///
/// `options`:
///   tauS             NSNumber  — the MEASURED offset, seconds (signed)
///   tauMeasured      NSNumber(bool) — true ⇒ a measured τ; there is no default
///   tauUncorrected   NSNumber(bool) — THE DELIBERATE τ = 0, UNMEASURED SWEEP.
///                    The one way to start this arm without a measured τ, and
///                    a SEPARATE key rather than `tauMeasured: true` with a
///                    zero, because the pack must never claim a calibration it
///                    does not have.  Setting it together with `tauMeasured`,
///                    or with a non-zero `tauS`, is refused (`tau-mode-
///                    conflict`) rather than resolved by a house rule.
///   basisIndex       NSNumber  — 0..23 from `selectBasis`; −1 ⇒ refuse
///                    (REQUIRED even for an uncorrected sweep: the basis is a
///                    different number, it really was measured, and without it
///                    the whole canvas is rotated)
///   maxBracketGapS   NSNumber  — default 0.025
///   holdBudgetS      NSNumber  — default 0.006 (the SOURCE performs the wait)
///   lurchAccelMps2   NSNumber  — default 0 (cage not configured, and counted)
///   capacity         NSNumber  — default 512 samples
+ (BOOL)configureWithOptions:(NSDictionary<NSString *, id> *)options
                       error:(NSError **)error
    NS_SWIFT_NAME(configure(options:));

/// Drop every retained sample and zero the counters.  Leaves the configuration.
+ (void)reset;

/// True when the current configuration can align at all.
+ (BOOL)isUsable;

/// Append one motion sample, in the SENSOR's timebase.  Safe from the motion
/// queue; non-finite and out-of-order samples are dropped and counted.
+ (void)pushSampleAtTimeS:(double)tS
                       qx:(double)qx qy:(double)qy qz:(double)qz qw:(double)qw
    NS_SWIFT_NAME(pushSample(atTimeS:qx:qy:qz:qw:));

/// Align one frame's PRESENTATION timestamp.  Pass a non-finite
/// `accelMagMps2` for "not available" — it is counted as not-evaluated, never
/// as a cage that passed.  Updates the counters.
+ (RNISPanoAlignResult)alignPtsS:(double)ptsS accelMagMps2:(double)accelMagMps2
    NS_SWIFT_NAME(align(ptsS:accelMagMps2:));

/// The SAME arithmetic as `align`, but PURE — it touches no counter.
///
/// ⚠ THE HOLD LOOP MUST USE THIS, and the distinction is not cosmetic.  A
/// source that retries `align` while waiting for the IMU to catch up would
/// record one held-then-rescued frame as six `after-last-sample` refusals, and
/// a pack reporting six lost frames where none were lost is worse than one
/// reporting nothing.  Exactly one COUNTED alignment per delivered frame.
+ (RNISPanoAlignResult)probePtsS:(double)ptsS accelMagMps2:(double)accelMagMps2
    NS_SWIFT_NAME(probe(ptsS:accelMagMps2:));

/// Newest retained sample timestamp, or NaN when empty.  The source needs it
/// to decide whether HOLDING a frame could possibly help: if the newest sample
/// already sits past `pts + τ`, waiting cannot change the answer and the hold
/// would only add latency to a refusal that is already certain.
+ (double)newestSampleS;

/// Stable machine-readable refusal name (`"after-last-sample"`, …).
+ (NSString *)refusalName:(RNISPanoAlignRefusal)refusal;

/// WHICH τ THE CALLER SHOULD USE, AND IN WHAT ORDER — `"uncorrected"` /
/// `"options"` / `"store"` / `"none"`.
///
/// A thin marshalling of `rnis::pano::resolveTauSource`, exposed because the
/// decision belongs to the SHARED C++ and not to the iOS bridge: Android will
/// have its own calibration store and would otherwise re-derive the ordering.
///
/// ⚠ THE ONE CLAUSE THAT MATTERS: an explicit UNCORRECTED request outranks a
/// stored τ.  The store's whole job is to fill in what a caller omitted, which
/// is right for a normal sweep and fatal for this one — an uncorrected
/// experiment quietly given a measured τ off disk is not the experiment, and
/// nothing in the pack would say so.
+ (NSString *)tauSourceForUncorrected:(BOOL)uncorrected
                         hasOptionTau:(BOOL)hasOptionTau
                          hasStoreTau:(BOOL)hasStoreTau
    NS_SWIFT_NAME(tauSource(uncorrected:hasOptionTau:hasStoreTau:));

/// AND WHETHER THE HOST MAY FORCE THE ZERO — `"none"` / `"measured-claim"` /
/// `"explicit-nonzero-tau"`.
///
/// A thin marshalling of `rnis::pano::inspectUncorrectedOptions`.  On an
/// uncorrected sweep the host's job is to force `tauS = 0` and write
/// `tauMeasured = false`, visibly and in the pack — but ONLY when nothing in
/// the caller's own bag contradicts the request.  Anything other than `"none"`
/// means the bag must be forwarded EXACTLY AS IT ARRIVED so `configure` refuses
/// it: this layer picking one of the caller's two claims is how the two states
/// stop being distinguishable.
///
/// ⚠ `claimsMeasuredTau` is the RAW `tauMeasured` the caller sent, NOT a
/// host-derived "claimed ∧ the number was finite".  A claim with no number
/// behind it is still a claim; collapsing it first is how it gets swallowed.
+ (NSString *)uncorrectedOptionConflictFor:(BOOL)uncorrected
                         claimsMeasuredTau:(BOOL)claimsMeasuredTau
                            hasExplicitTau:(BOOL)hasExplicitTau
                                      tauS:(double)tauS
    NS_SWIFT_NAME(uncorrectedOptionConflict(uncorrected:claimsMeasuredTau:hasExplicitTau:tauS:));

/// WHERE THE BASIS CAME FROM, as the pack's own word — `"measured"` /
/// `"caller-supplied"` / `"not-measured"` — DERIVED from `basisSource`
/// (`"store"` / `"options"` / anything else) rather than asserted beside it.
///
/// The basis is the half that DID calibrate on this device, and recording it as
/// measured is the truth for the store route.  Stamping the same word on a
/// caller-supplied basis would certify a calibration this build never ran —
/// the defect the τ side of this class exists to prevent, committed on the
/// other number.  An unrecognised source is answered conservatively, never
/// flatteringly.
+ (NSString *)basisProvenanceForSource:(nullable NSString *)source
    NS_SWIFT_NAME(basisProvenance(source:));

/// ── M5: THE ACCELEROMETER, HANDED ACROSS TO A FRAME PROCESSOR ────────────
///
/// The lurch cage needs `|userAcceleration|` at each frame.  The AVF arm read
/// it off its own CoreMotion callback; the vision-camera plugin has no
/// CoreMotion of its own and passed NaN ("not evaluated") on every frame.
/// The IMU arm now publishes the newest magnitude here and the plugin reads
/// it, so both arms cage the same quantity.  NaN until the first sample of a
/// sweep, and after `+clearAccelMagMps2`.
+ (void)noteAccelMagMps2:(double)accelMagMps2
    NS_SWIFT_NAME(noteAccelMag(mps2:));
+ (double)latestAccelMagMps2;
+ (void)clearAccelMagMps2;

/// ── M5 / D3: THE BACK CAMERA'S BASIS, DERIVED FROM ITS MOUNTING ─────────
///
/// A thin marshalling of `rnis::pano::android::deriveBasis` — the SAME pure,
/// host-tested derivation the Android recorder runs on `SENSOR_ORIENTATION`.
/// The input here is Apple's own statement of the mounting: the clockwise
/// rotation that makes the camera's raw buffer upright with the phone held in
/// portrait (`videoRotationAngleRelativeToDeviceOrientation(.portrait)` on
/// iOS 27, `videoRotationAngleForHorizonLevelCapture` in a confirmed portrait
/// hold before it).  That is exactly `SENSOR_ORIENTATION`'s meaning, and the
/// buffer reaches the engine unrotated (`RawSensorBuffer`) on both arms.
///
/// Returns `ok`, `index` (−1 on refusal), `label`, `refusal`, and the
/// `mountingAngleDeg` / `mirrored` it was asked about.  Refuses by name for an
/// angle that is not a multiple of 90 and for a mirrored buffer.
+ (NSDictionary<NSString *, id> *)deriveBackBasisForMountingAngleDeg:(NSInteger)mountingAngleDeg
                                                            mirrored:(BOOL)mirrored
    NS_SWIFT_NAME(deriveBackBasis(mountingAngleDeg:mirrored:));

/// The pack's word for a DERIVED basis — `"derived"` — from the shared C++,
/// never a local literal.  Not `measured`: nothing on the phone measured it.
+ (NSString *)derivedBasisProvenanceName;

/// The counters plus the resolved configuration, for the pack.  This is the
/// The derive-never-hardcode surface: with `t ≡ 0` the engine's own `rejectedPoseSpeed` and
/// `maxTranslationJump` read zero, and without these a reader concludes those
/// cages PASSED.  They did not run.
+ (NSDictionary<NSString *, id> *)report;

@end

NS_ASSUME_NONNULL_END
