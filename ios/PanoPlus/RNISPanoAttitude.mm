// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoAttitude.mm — the marshalling half.  Every decision of substance is
// in cpp/rnis_pano_attitude.{hpp,cpp}; this file must stay boring, because the
// moment a policy is implemented HERE it is implemented on iOS only.

#import "RNISPanoAttitude.h"

#include <os/lock.h>

#include <algorithm>

#include <atomic>
#include <cmath>
#include <memory>

#include "rnis_pano_attitude.hpp"
#include "rnis_pano_android_basis.hpp"

namespace {

namespace P = rnis::pano;

// The Swift-visible enum and the C++ one are the SAME numbers, checked by the
// compiler.  Without this the Swift source would carry a mirrored literal and
// a reordering of the C++ enum would silently re-point a refusal branch.
static_assert((int)P::AlignRefusal::None              == RNISPanoAlignRefusalNone, "");
static_assert((int)P::AlignRefusal::TauNotMeasured    == RNISPanoAlignRefusalTauNotMeasured, "");
static_assert((int)P::AlignRefusal::BasisNotValidated == RNISPanoAlignRefusalBasisNotValidated, "");
static_assert((int)P::AlignRefusal::BufferEmpty       == RNISPanoAlignRefusalBufferEmpty, "");
static_assert((int)P::AlignRefusal::BeforeFirstSample == RNISPanoAlignRefusalBeforeFirstSample, "");
static_assert((int)P::AlignRefusal::AfterLastSample   == RNISPanoAlignRefusalAfterLastSample, "");
static_assert((int)P::AlignRefusal::NonFiniteInput    == RNISPanoAlignRefusalNonFiniteInput, "");
static_assert((int)P::AlignRefusal::Lurch             == RNISPanoAlignRefusalLurch, "");
static_assert((int)P::AlignRefusal::TauModeConflict   == RNISPanoAlignRefusalTauModeConflict, "");

/// The one process-wide aligner, and the one lock that guards it.  `push`
/// arrives on the CoreMotion queue and `align` on the video queue; an
/// unfair lock is the right primitive because both critical sections are a
/// handful of arithmetic operations and neither ever blocks.
os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
std::unique_ptr<P::AttitudeAligner> gAligner;
P::AttitudeAligner::Config gCfg;

double numOr(NSDictionary *o, NSString *k, double dflt) {
    id v = o[k];
    if ([v isKindOfClass:[NSNumber class]]) {
        const double d = [(NSNumber *)v doubleValue];
        if (std::isfinite(d)) return d;
    }
    return dflt;
}

bool boolOr(NSDictionary *o, NSString *k, bool dflt) {
    id v = o[k];
    if ([v isKindOfClass:[NSNumber class]]) return [(NSNumber *)v boolValue];
    return dflt;
}

/// NaN-safe JSON number: `NSNull` rather than a plausible zero.  A value
/// that was not measured is recorded as null, never as a number somebody could
/// read as a measurement.
id jnum(double v) {
    return std::isfinite(v) ? (id)@(v) : (id)[NSNull null];
}


}  // namespace

@implementation RNISPanoAttitude

+ (BOOL)configureWithOptions:(NSDictionary<NSString *, id> *)options
                       error:(NSError **)error {
    P::AttitudeAligner::Config c;

    // ── τ IS TWO KEYS AND THEY MUST TRAVEL TOGETHER ────────────────────
    //
    // `tauS` and `tauMeasured` arrive as INDEPENDENT optionals across the
    // bridge, and `configurationIsUsable()` only ever consulted the flag.  So
    // `{tauMeasured: true, basisIndex: 5}` with no `tauS` at all started a
    // sweep at τ = 0 and wrote `tauMeasured: true, tauS: 0` into the pack —
    // byte-indistinguishable from a device whose τ genuinely measured zero.
    // That is precisely the class this arm's whole calibration step exists to
    // prevent (and precisely what `subjectDistanceFitM` did): a number that
    // certifies itself.
    //
    // The flag is now DERIVED from the presence of a finite τ, so the two can
    // never disagree, and the orphan case gets its own message below rather
    // than being reported as "no measured τ" — which would send the operator
    // to run a calibration he has already run.
    id tauVal = options[@"tauS"];
    const bool haveFiniteTau =
        [tauVal isKindOfClass:[NSNumber class]]
        && std::isfinite([(NSNumber *)tauVal doubleValue]);
    const bool tauClaimed = boolOr(options, @"tauMeasured", false);

    // ── THE DELIBERATE τ = 0 SWEEP, AS ITS OWN INPUT ───────────────────
    //
    // 2026-08-31.  The device's τ calibration resolved on 8 of 12 runs and
    // scattered 5.03 ms — wider than the 3.08 ms the correction buys back —
    // so the persist gate refused to write one, correctly.  The open question
    // is whether τ binds at all, and the experiment that answers it is a sweep
    // with NO timing correction.
    //
    // The lazy route is `tauS: 0, tauMeasured: true`, and it is FORBIDDEN: it
    // writes a measurement claim into the pack for a sweep that measured
    // nothing — the same shape this very block already refuses two paragraphs
    // above.  So the uncorrected sweep declares itself, and the C++ carries
    // the state beside `tauMeasured` rather than inside it.
    //
    // ⚠ NOT normalised here.  A caller that sets BOTH, or sets this with a
    // non-zero τ, is refused by the aligner with its own `tau-mode-conflict`
    // name — silently picking one of the two claims is precisely how the two
    // states become indistinguishable in the pack.
    const bool tauUncorrected = boolOr(options, @"tauUncorrected", false);

    // ── THE CONTRADICTION IS NAMED HERE, ON THE *RAW* BAG ──────────────
    //
    // `c.tauMeasured` two lines below is DERIVED (`claim ∧ a finite number`),
    // and the aligner's own conflict rule can only see the derived value.  So
    // two shapes reached the aligner looking innocent and swept as the
    // experiment with the caller's claim silently dropped:
    //
    //   · `tauUncorrected` + `tauMeasured: true` with NO `tauS` — the claim
    //     collapsed to false before the aligner ever saw it;
    //   · `tauUncorrected` + an explicit non-zero `tauS` and no `tauMeasured` —
    //     handled correctly by the aligner, but only if the host forwards it,
    //     and the host's own test for "forward this" had the same gap.
    //
    // Both packs would have been TRUTHFUL about τ, which is exactly why this is
    // easy to leave in: the lie is not in the pack, it is that a caller's
    // explicit claim was discarded where nothing records it.  Refused, by the
    // shared rule, before an aligner exists to be misled.
    //
    // `tauUncorrected` false ⇒ `none` ⇒ this block is inert and the calibrated
    // path is byte-for-byte what it was.
    id rawTauVal = options[@"tauS"];
    const bool haveExplicitTau = [rawTauVal isKindOfClass:[NSNumber class]];
    const P::TauOptionConflict optConflict = P::inspectUncorrectedOptions(
        tauUncorrected, tauClaimed, haveExplicitTau,
        haveExplicitTau ? [(NSNumber *)rawTauVal doubleValue] : 0.0);
    if (optConflict != P::TauOptionConflict::None) {
        if (error) {
            NSString *why = [NSString stringWithFormat:
                @"This sweep asked for two mutually exclusive things "
                 "(tau-mode-conflict / %s). An UNCORRECTED sweep is τ = 0 and "
                 "DELIBERATELY UNMEASURED; anything the caller sends about τ "
                 "beside it is a second, contradicting claim. It is refused "
                 "rather than resolved here, because resolving it means "
                 "dropping one of the caller's two claims somewhere no reader "
                 "of the pack could ever see it. Send `tauUncorrected: true` "
                 "ALONE to run the experiment (the host writes the zero and "
                 "records it), or drop `tauUncorrected` to run the calibrated "
                 "sweep on the τ you are supplying.",
                P::tauOptionConflictName(optConflict)];
            *error = [NSError errorWithDomain:@"RNISPanoAttitude"
                                         code:400
                                     userInfo:@{NSLocalizedDescriptionKey: why}];
        }
        return NO;
    }

    c.tauS           = haveFiniteTau ? [(NSNumber *)tauVal doubleValue] : 0.0;
    c.tauMeasured    = tauClaimed && haveFiniteTau;
    c.tauUncorrected = tauUncorrected;
    c.basisIndex     = (int)llround(numOr(options, @"basisIndex", -1.0));
    c.maxBracketGapS = numOr(options, @"maxBracketGapS", 0.025);
    c.holdBudgetS    = numOr(options, @"holdBudgetS", 0.006);
    c.lurchAccelMps2 = numOr(options, @"lurchAccelMps2", 0.0);
    c.capacity       = (std::size_t)std::max(2.0, numOr(options, @"capacity", 512.0));

    auto fresh = std::make_unique<P::AttitudeAligner>(c);

    // REFUSE AT START, not per frame.  A sweep that runs to completion and
    // paints nothing because every frame was refused is far harder to read
    // than a start that says which of the two numbers is missing.
    if (!fresh->configurationIsUsable()) {
        if (error) {
            NSString *why =
                (fresh->tauProvenance() == P::TauProvenance::Conflict)
                    ? [NSString stringWithFormat:
                        @"This sweep asked for two mutually exclusive things (%s). An "
                         "UNCORRECTED sweep is τ = 0 and DELIBERATELY UNMEASURED; a "
                         "MEASURED sweep carries a τ that was measured. A run claiming "
                         "both has no honest pack — a reader six weeks from now could "
                         "not tell whether the number in it was measured or assumed — "
                         "so it is refused rather than resolved by a house rule. Drop "
                         "`tauMeasured` to run the experiment, or drop `tauUncorrected` "
                         "to run the calibrated sweep.",
                        fresh->tauConflictReason()]
                : (tauClaimed && !haveFiniteTau)
                    ? @"The caller claimed `tauMeasured` but supplied no finite `tauS`. "
                       "That combination used to sweep at τ = 0 and record "
                       "`tauMeasured: true, tauS: 0` — indistinguishable in the pack "
                       "from a device whose τ genuinely measured zero. It is refused "
                       "rather than defaulted: the two keys must travel together."
                : !c.tauMeasured
                    ? @"No measured τ for this (device, lens, format). τ folds the "
                       "camera/sensor epoch difference, the exposure-timestamp "
                       "convention and the rolling-shutter constant into one "
                       "number, and a mismatch on the convention alone is 8.3 ms "
                       "at 60 fps — about 3× the whole alignment budget. Run the "
                       "capture-clock probe for this configuration first; it is "
                       "refused rather than guessed. To sweep DELIBERATELY WITHOUT "
                       "a correction, pass `tauUncorrected: true` — that is a "
                       "declared experiment the pack records as such, and it is not "
                       "the same thing as claiming a τ of zero."
                    : @"The device→camera basis C has not been validated for this "
                       "device. Log CoreMotion beside a live ARKit session and let "
                       "selectBasis pick from the 24 candidates — and note the log "
                       "must rotate about MORE THAN ONE AXIS, because a pure pan "
                       "leaves an exact 4-way tie.";
            *error = [NSError errorWithDomain:@"RNISPanoAttitude"
                                         code:400
                                     userInfo:@{NSLocalizedDescriptionKey: why}];
        }
        return NO;
    }

    os_unfair_lock_lock(&gLock);
    gAligner = std::move(fresh);
    gCfg = c;
    os_unfair_lock_unlock(&gLock);
    return YES;
}

+ (void)reset {
    os_unfair_lock_lock(&gLock);
    if (gAligner) gAligner = std::make_unique<P::AttitudeAligner>(gCfg);
    os_unfair_lock_unlock(&gLock);
}

+ (BOOL)isUsable {
    os_unfair_lock_lock(&gLock);
    const bool ok = gAligner && gAligner->configurationIsUsable();
    os_unfair_lock_unlock(&gLock);
    return ok ? YES : NO;
}

+ (void)pushSampleAtTimeS:(double)tS
                       qx:(double)qx qy:(double)qy qz:(double)qz qw:(double)qw {
    const double q[4] = {qx, qy, qz, qw};
    os_unfair_lock_lock(&gLock);
    if (gAligner) gAligner->push(tS, q);
    os_unfair_lock_unlock(&gLock);
}

+ (RNISPanoAlignResult)alignPtsS:(double)ptsS accelMagMps2:(double)accelMagMps2 {
    RNISPanoAlignResult r = {};
    r.qw = 1.0;
    r.refusal = RNISPanoAlignRefusalBufferEmpty;

    os_unfair_lock_lock(&gLock);
    if (gAligner) {
        const P::AlignedAttitude a = gAligner->alignAndCount(ptsS, accelMagMps2);
        r.ok = a.ok;
        r.qx = a.q[0]; r.qy = a.q[1]; r.qz = a.q[2]; r.qw = a.q[3];
        r.tracking = a.tracking;
        r.refusal = (RNISPanoAlignRefusal)a.refusal;
        r.fatal = P::refusalIsFatal(a.refusal);
        r.lurchEvaluated = a.lurchEvaluated;
        r.bracketGapS = a.bracketGapS;
        r.alpha = a.alpha;
        r.targetS = a.targetS;
    }
    os_unfair_lock_unlock(&gLock);
    return r;
}

+ (RNISPanoAlignResult)probePtsS:(double)ptsS accelMagMps2:(double)accelMagMps2 {
    RNISPanoAlignResult r = {};
    r.qw = 1.0;
    r.refusal = RNISPanoAlignRefusalBufferEmpty;

    os_unfair_lock_lock(&gLock);
    if (gAligner) {
        // The CONST overload — the C++ keeps a pure `align` beside the
        // counting one for precisely this reason.
        const P::AlignedAttitude a = gAligner->align(ptsS, accelMagMps2);
        r.ok = a.ok;
        r.qx = a.q[0]; r.qy = a.q[1]; r.qz = a.q[2]; r.qw = a.q[3];
        r.tracking = a.tracking;
        r.refusal = (RNISPanoAlignRefusal)a.refusal;
        r.fatal = P::refusalIsFatal(a.refusal);
        r.lurchEvaluated = a.lurchEvaluated;
        r.bracketGapS = a.bracketGapS;
        r.alpha = a.alpha;
        r.targetS = a.targetS;
    }
    os_unfair_lock_unlock(&gLock);
    return r;
}

+ (double)newestSampleS {
    os_unfair_lock_lock(&gLock);
    const double t = gAligner ? gAligner->newestSampleS() : std::nan("");
    os_unfair_lock_unlock(&gLock);
    return t;
}

+ (NSString *)refusalName:(RNISPanoAlignRefusal)refusal {
    return @(P::refusalName((P::AlignRefusal)refusal));
}

+ (NSString *)tauSourceForUncorrected:(BOOL)uncorrected
                         hasOptionTau:(BOOL)hasOptionTau
                          hasStoreTau:(BOOL)hasStoreTau {
    // MARSHALLING ONLY.  The precedence — and above all the clause that an
    // explicit uncorrected request outranks a stored τ — is in the shared C++,
    // where the Android leg will read the same one.
    return @(P::tauSourceName(P::resolveTauSource(uncorrected != NO,
                                                  hasOptionTau != NO,
                                                  hasStoreTau != NO)));
}

+ (NSString *)uncorrectedOptionConflictFor:(BOOL)uncorrected
                         claimsMeasuredTau:(BOOL)claimsMeasuredTau
                            hasExplicitTau:(BOOL)hasExplicitTau
                                      tauS:(double)tauS {
    // MARSHALLING ONLY.  Which shapes must be left alone to be refused is in
    // the shared C++, host-tested there, and the Android bridge will read the
    // same one rather than re-derive it from this file's behaviour.
    return @(P::tauOptionConflictName(
        P::inspectUncorrectedOptions(uncorrected != NO,
                                     claimsMeasuredTau != NO,
                                     hasExplicitTau != NO,
                                     tauS)));
}

+ (NSString *)basisProvenanceForSource:(NSString *)source {
    return @(P::basisProvenanceName(
        P::basisProvenanceForSource(source != nil ? source.UTF8String : nullptr)));
}

// M5 — the newest |userAcceleration|, m/s², published by the IMU arm's
// CoreMotion callback and read by the vision-camera plugin. An atomic rather
// than the aligner's lock: the plugin reads it once per frame on vision-
// camera's queue, the arm writes it at 200 Hz, and neither may wait.
static std::atomic<double> gLatestAccelMagMps2{NAN};

+ (void)noteAccelMagMps2:(double)accelMagMps2 {
    gLatestAccelMagMps2.store(accelMagMps2, std::memory_order_relaxed);
}

+ (double)latestAccelMagMps2 {
    return gLatestAccelMagMps2.load(std::memory_order_relaxed);
}

+ (void)clearAccelMagMps2 {
    gLatestAccelMagMps2.store(NAN, std::memory_order_relaxed);
}

+ (NSDictionary<NSString *, id> *)deriveBackBasisForMountingAngleDeg:(NSInteger)mountingAngleDeg
                                                            mirrored:(BOOL)mirrored {
    namespace A = rnis::pano::android;
    A::BasisRequest req;
    req.sensorOrientationDeg = (int)mountingAngleDeg;
    req.facing = A::LensFacing::Back;
    req.recorder = A::RecorderRotation::RawSensorBuffer;
    req.mirrored = mirrored ? true : false;
    const A::BasisDerivation d = A::deriveBasis(req);
    return @{
        @"ok": @(d.ok),
        @"index": @(d.index),
        @"label": @(d.label ? d.label : "invalid"),
        @"refusal": @(d.refusal ? d.refusal : "unknown"),
        @"mountingAngleDeg": @(mountingAngleDeg),
        @"mirrored": @(mirrored),
        @"residualRotationCwDeg": @(d.residualRotationCwDeg),
    };
}

+ (NSString *)derivedBasisProvenanceName {
    return @(rnis::pano::android::derivedBasisProvenanceName());
}

+ (NSDictionary<NSString *, id> *)report {
    os_unfair_lock_lock(&gLock);
    if (!gAligner) {
        os_unfair_lock_unlock(&gLock);
        return @{@"configured": @NO};
    }
    const P::AlignerCounters c = gAligner->counters();
    const P::AttitudeAligner::Config cfg = gAligner->config();
    const std::size_t held = gAligner->size();
    // ASKED OF THE LIVE ALIGNER, inside the lock.  Re-deriving it out here
    // from `cfg` would be the conflict rule written a second time, on iOS
    // only — which is the exact failure this whole façade exists to avoid.
    const P::TauProvenance prov = gAligner->tauProvenance();
    os_unfair_lock_unlock(&gLock);

    double basis[9];
    const bool haveBasis = P::basisMatrix(cfg.basisIndex, basis);

    // ── THE τ PROVENANCE, THREE-VALUED AT THIS LAYER ───────────────────
    // `measured` / `uncorrected` / `not-measured` (`conflict` cannot reach
    // here — that configuration never starts).  The HOST refines `measured`
    // into `measured` vs `from-store`, which is the three-way field the pack
    // carries; this translation unit has no store and will not invent a value
    // it cannot observe.
    const bool uncorrected = (prov == P::TauProvenance::Uncorrected);

    return @{
        @"configured": @YES,
        // ── WHAT THIS ARM ACTUALLY IS ──────────────────────────────────
        // The single most important field in the pack for this arm.  Without
        // it a reader sees `rejectedPoseSpeed: 0` and `maxTranslationJump: 0`
        // and concludes those cages passed.  They never ran: there is no
        // translation on this path at all.
        @"poseSource": @"imu-attitude-only",
        @"translation": @"none",
        @"tauS": jnum(cfg.tauS),
        // KEPT, and it is still the answer to "was τ measured?" — NO on an
        // uncorrected sweep.  It is no longer the whole answer, which is the
        // point: the state that says WHY it is no rides beside it.
        @"tauMeasured": @(cfg.tauMeasured),
        // ── WHAT THE SEAM DID WITH τ — `tauMode` ───────────────────────
        //
        // Three values, never a boolean: `measured` / `uncorrected` /
        // `not-measured`.  `tauS: 0, tauMeasured: true` is the shape this arm
        // exists to make impossible, and a two-state field is exactly what let
        // it look reasonable.
        //
        // ⚠ DELIBERATELY A DIFFERENT KEY AND A DIFFERENT VOCABULARY FROM THE
        // HOST'S `tauProvenance` (`measured` / `from-store` / `uncorrected`),
        // which answers WHERE τ came from.  This layer cannot answer that —
        // it has no calibration store — and giving the two questions one key
        // with two vocabularies is how a reader ends up trusting the wrong
        // one.  `RNISPanoAvfSource.tauProvenance(report:)` composes the host
        // field from THIS one plus `tauSource`.
        @"tauMode": @(P::tauProvenanceName(prov)),
        @"tauUncorrected": @(cfg.tauUncorrected),
        // Did the seam apply an offset at all?  Stated, so nothing has to be
        // inferred from a zero.  The PROSE that goes with it lives once, at
        // the host layer, where the three-way vocabulary is complete.
        @"tauCorrectionApplied": @(!uncorrected && cfg.tauMeasured),
        // The sign convention, carried WITH the number, because an offset
        // applied backwards does not halve the error — it doubles it.
        @"tauSign": @"positive tau ⇒ attitude sampled at (pts + tau)",
        @"attitudeBasisIndex": @(cfg.basisIndex),
        @"attitudeBasisLabel": haveBasis ? @(P::basisLabel(cfg.basisIndex)) : @"invalid",
        @"maxBracketGapS": jnum(cfg.maxBracketGapS),
        @"holdBudgetS": jnum(cfg.holdBudgetS),
        @"lurchAccelMps2": jnum(cfg.lurchAccelMps2),
        @"samplesHeld": @((NSInteger)held),
        @"samplesPushed": @(c.pushed),
        @"samplesDroppedNonMonotonic": @(c.droppedNonMonotonic),
        @"samplesDroppedNonFinite": @(c.droppedNonFinite),
        @"framesAligned": @(c.aligned),
        @"accepted": @(c.accepted),
        @"acceptedNormal": @(c.acceptedNormal),
        @"acceptedLimited": @(c.acceptedLimited),
        @"maxBracketGapSeenS": jnum(c.maxBracketGapS),
        @"refusals": @{
            @"tau-not-measured":    @(c.refusedTau),
            @"basis-not-validated": @(c.refusedBasis),
            @"buffer-empty":        @(c.refusedEmpty),
            @"before-first-sample": @(c.refusedBefore),
            @"after-last-sample":   @(c.refusedAfter),
            @"non-finite-input":    @(c.refusedNonFinite),
            @"lurch":               @(c.refusedLurch),
            @"tau-mode-conflict":   @(c.refusedTauConflict),
        },
        // ── THE CAGE'S OWN HONESTY FIELDS ──────────────────────────────
        // FOUR states, none of which may share a field with another, and only
        // ONE of them is a pass.  `evaluatedFrames` is now derived from the
        // cage itself (`AlignedAttitude::lurchEvaluated`) rather than from the
        // caller's arguments: the cage sits after the bracket search, so every
        // frame refused upstream of it — `after-last-sample` above all — used
        // to be tallied as evaluated, and a pack reading
        // `evaluatedFrames: 1200, refusals.lurch: 0` said the cage had
        // examined 1200 frames when it had examined none.
        //
        // `state` is the one-word answer, so an offline reader never has to
        // infer "uncaged" from a zero.
        @"lurchCage": @{
            @"state":               (cfg.lurchAccelMps2 > 0.0 ? @"armed" : @"uncaged"),
            @"thresholdMps2":       cfg.lurchAccelMps2 > 0.0
                                        ? jnum(cfg.lurchAccelMps2) : (id)[NSNull null],
            @"evaluatedFrames":     @(c.lurchEvaluated),
            @"notConfiguredFrames": @(c.lurchNotConfigured),
            @"notEvaluatedFrames":  @(c.lurchNotEvaluated),
            // Configured, but the frame died BEFORE the cage. Not a pass, and
            // not the same thing as "no acceleration arrived".
            @"notReachedFrames":    @(c.lurchNotReached),
            // ── THE TUNING EVIDENCE, RECORDED WHETHER OR NOT THE CAGE RAN ──
            // The threshold is a number in a currency nothing in this repo has
            // measured, and it can only be chosen from this distribution.
            // Until 2026-08-31 the max was tracked only inside the CONFIGURED
            // branch, which made the first threshold unknowable by
            // construction. An uncaged sweep is now what tunes the first
            // caged one.
            @"maxAccelMps2Seen":    jnum(c.maxLurchAccelMps2),
            @"accelSamples":        @(c.accelSamples),
            @"tuningNote":          @"the threshold has never been tuned against a "
                                     "real lurch; maxAccelMps2Seen over accelSamples "
                                     "is the distribution to choose it from",
        },
    };
}

@end
