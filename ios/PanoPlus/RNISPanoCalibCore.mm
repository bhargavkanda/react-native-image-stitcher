// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoCalibCore.mm — the marshalling half.  Every decision of substance is
// in cpp/rnis_pano_calib.{hpp,cpp}; this file must stay boring, because the
// moment a bar is decided HERE it is decided on iOS only and the Android leg
// gets a different calibration.

#import "RNISPanoCalibCore.h"

#include <os/lock.h>

#include <algorithm>
#include <cmath>
#include <mutex>
#include <vector>

#include "rnis_pano_calib.hpp"

namespace {

namespace P = rnis::pano;

/// One lock over both series.  `pushImu` arrives on the CoreMotion queue,
/// `pushRef` on the ARKit delegate thread, and `liveExcitation` / `solveBasis`
/// on whichever queue the bridge hands us.  An unfair lock is right for the
/// pushes (a vector append) and acceptable for the reads, which run at a few Hz
/// at most and never on the ARKit thread.
os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
std::vector<P::AttitudeSample> gImu;
std::vector<P::AttitudeSample> gRef;
std::size_t gImuCap = 24000;
std::size_t gRefCap = 7200;
bool  gTruncated = false;
long long gRefRejectedTracking = 0;

/// ⚠ THE LIVE READ RUNS AT 4 Hz AGAINST A LOCK THE ARKit DELEGATE THREAD TAKES.
///
/// `liveExcitation` has to take a consistent snapshot of `gRef`, and a fresh
/// `std::vector` copy means a MALLOC of up to ~290 KB inside a critical section
/// that `pushRef` — on the ARKit delegate thread — contends for.  The reduction
/// is correctly outside the lock; the allocation was not.
///
/// This scratch is reserved ONCE (at `beginRecording`, to the ref cap) and
/// `assign()`ed under the lock thereafter, so the copy is a memcpy with no
/// allocator involvement.  It has its OWN lock, always taken BEFORE `gLock` and
/// never after, so the two can never deadlock; and it is a separate buffer from
/// the recording so a reader can never hand the reducer a series another thread
/// is appending to.
std::mutex gScratchMutex;
std::vector<P::AttitudeSample> gRefScratch;

id jnum(double v) { return std::isfinite(v) ? (id)@(v) : (id)[NSNull null]; }

NSArray *axisArray(const double v[3]) {
    return @[jnum(v[0]), jnum(v[1]), jnum(v[2])];
}

NSDictionary *axisDict(const double v[3]) {
    return @{@"tilt": jnum(v[0]), @"pan": jnum(v[1]), @"roll": jnum(v[2])};
}

NSDictionary *axisBoolDict(const bool v[3]) {
    return @{@"tilt": @(v[0]), @"pan": @(v[1]), @"roll": @(v[2])};
}

NSDictionary *excitationDict(const P::AxisExcitation& e,
                             const P::ExcitationVerdict& v) {
    return @{
        @"ok": @(e.ok),
        @"steps": @(e.steps),
        @"stepsBelowFloor": @(e.stepsBelowFloor),
        @"minStepDeg": jnum(P::kExcitationMinStepDeg),
        @"sweptDeg": jnum(e.sweptDeg),
        @"spanDeg": jnum(e.spanDeg),
        @"perAxisDeg": axisDict(e.perAxisDeg),
        @"perAxisDegArray": axisArray(e.perAxisDeg),
        @"eig": axisArray(e.eig),
        @"rank2": jnum(e.rank2),
        @"rank3": jnum(e.rank3),
        @"sufficient": @(v.sufficient),
        @"reason": @(v.reason),
        @"needMore": axisBoolDict(v.needMore),
        @"exercisedAxes": @(v.exercisedAxes),
        @"progress": jnum(v.progress),
    };
}

NSDictionary *fitDict(const P::BasisFit& f) {
    return @{
        @"index": @(f.index),
        @"label": @(f.label),
        @"pairs": @(f.pairs),
        @"rmsDeg": jnum(f.rmsDeg),
        @"maxDeg": jnum(f.maxDeg),
        @"finalDeg": jnum(f.finalDeg),
        @"driftDegPerS": jnum(f.driftDegPerS),
        @"rmsDetrendedDeg": jnum(f.rmsDetrendedDeg),
    };
}

double numOr(NSDictionary *o, NSString *k, double dflt) {
    id v = o[k];
    if ([v isKindOfClass:[NSNumber class]]) {
        const double d = [(NSNumber *)v doubleValue];
        if (std::isfinite(d)) return d;
    }
    return dflt;
}

}  // namespace

@implementation RNISPanoCalibCore

// ── The recorder ────────────────────────────────────────────────────────────

+ (void)beginRecordingImuCap:(NSUInteger)capImu refCap:(NSUInteger)capRef {
    os_unfair_lock_lock(&gLock);
    gImuCap = capImu > 0 ? (std::size_t)capImu : 24000;
    gRefCap = capRef > 0 ? (std::size_t)capRef : 7200;
    gImu.clear(); gRef.clear();
    gImu.reserve(std::min<std::size_t>(gImuCap, 24000));
    gRef.reserve(std::min<std::size_t>(gRefCap, 7200));
    gTruncated = false;
    gRefRejectedTracking = 0;
    const std::size_t refCap = gRefCap;
    os_unfair_lock_unlock(&gLock);

    // Reserve the live-read scratch to the same cap, OUTSIDE `gLock`, so the
    // 4 Hz snapshot never allocates while the ARKit delegate thread is waiting
    // to push.  Done here rather than lazily so the first read is not the one
    // that pays for it.
    {
        std::lock_guard<std::mutex> g(gScratchMutex);
        gRefScratch.clear();
        gRefScratch.reserve(std::min<std::size_t>(refCap, 7200));
    }
}

+ (void)pushImuAtTimeS:(double)tS
                    qx:(double)qx qy:(double)qy qz:(double)qz qw:(double)qw {
    if (!std::isfinite(tS) || !std::isfinite(qx) || !std::isfinite(qy)
        || !std::isfinite(qz) || !std::isfinite(qw)) return;
    P::AttitudeSample s;
    s.tS = tS; s.q[0] = qx; s.q[1] = qy; s.q[2] = qz; s.q[3] = qw;
    P::detail::quatNormalize(s.q);
    os_unfair_lock_lock(&gLock);
    // STRICTLY increasing, for the same reason `AttitudeAligner::push` insists
    // on it: `selectBasis` runs a binary search over these, and a binary search
    // over an unsorted array does not fail loudly — it returns a plausible
    // neighbour.
    if (gImu.empty() || s.tS > gImu.back().tS) {
        // STOP at the cap rather than wrapping.  A ring would silently discard
        // the START of the gesture, and the operator would then be graded on
        // whatever he happened to be doing at the end of it.
        if (gImu.size() < gImuCap) gImu.push_back(s); else gTruncated = true;
    }
    os_unfair_lock_unlock(&gLock);
}

+ (void)pushRefAtTimeS:(double)tS
                    qx:(double)qx qy:(double)qy qz:(double)qz qw:(double)qw {
    if (!std::isfinite(tS) || !std::isfinite(qx) || !std::isfinite(qy)
        || !std::isfinite(qz) || !std::isfinite(qw)) return;
    P::AttitudeSample s;
    s.tS = tS; s.q[0] = qx; s.q[1] = qy; s.q[2] = qz; s.q[3] = qw;
    P::detail::quatNormalize(s.q);
    os_unfair_lock_lock(&gLock);
    if (gRef.empty() || s.tS > gRef.back().tS) {
        if (gRef.size() < gRefCap) gRef.push_back(s); else gTruncated = true;
    }
    os_unfair_lock_unlock(&gLock);
}

+ (void)noteRefRejectedForTracking {
    os_unfair_lock_lock(&gLock);
    ++gRefRejectedTracking;
    os_unfair_lock_unlock(&gLock);
}

+ (void)endRecording {
    {
        // Same order as the live read: scratch first, then `gLock`.
        std::lock_guard<std::mutex> g(gScratchMutex);
        gRefScratch.clear();
        gRefScratch.shrink_to_fit();
    }
    os_unfair_lock_lock(&gLock);
    gImu.clear(); gImu.shrink_to_fit();
    gRef.clear(); gRef.shrink_to_fit();
    os_unfair_lock_unlock(&gLock);
}

+ (NSDictionary<NSString *, id> *)liveExcitation {
    // SCRATCH LOCK FIRST, ALWAYS — `gLock` is never taken before it, so the
    // ordering cannot deadlock.  It also serialises two concurrent live reads
    // onto one buffer, which is what makes reusing the buffer safe at all.
    std::lock_guard<std::mutex> scratch(gScratchMutex);

    os_unfair_lock_lock(&gLock);
    // Copy under the lock, reduce outside it: the reduction is O(n) and the
    // ARKit delegate thread is one of the pushers.  `assign()` into a buffer
    // already reserved to the cap is a memcpy — no malloc inside the critical
    // section the AR thread contends for.
    gRefScratch.assign(gRef.begin(), gRef.end());
    const std::size_t imuN = gImu.size();
    const bool trunc = gTruncated;
    const long long rejected = gRefRejectedTracking;
    os_unfair_lock_unlock(&gLock);

    const std::vector<P::AttitudeSample>& ref = gRefScratch;
    const P::AxisExcitation e = P::excitation(ref);
    const P::ExcitationVerdict v = P::gradeExcitation(e, P::ExcitationPolicy{});

    NSMutableDictionary *out = [excitationDict(e, v) mutableCopy];
    out[@"imuSamples"] = @((NSInteger)imuN);
    out[@"refSamples"] = @((NSInteger)ref.size());
    out[@"refRejectedTracking"] = @(rejected);
    out[@"truncated"] = @(trunc);
    out[@"refSpanS"] = ref.size() >= 2
        ? jnum(ref.back().tS - ref.front().tS) : (id)[NSNull null];
    return out;
}

+ (NSDictionary<NSString *, id> *)solveBasisWithTauS:(double)tauS
                                   stabilityOffsetsS:(NSArray<NSNumber *> *)offsets {
    os_unfair_lock_lock(&gLock);
    std::vector<P::AttitudeSample> imu = gImu;
    std::vector<P::AttitudeSample> ref = gRef;
    const bool trunc = gTruncated;
    const long long rejected = gRefRejectedTracking;
    os_unfair_lock_unlock(&gLock);

    const double tau = std::isfinite(tauS) ? tauS : 0.0;

    const P::ExcitationPolicy excPolicy;
    const P::BasisPolicy      basisPolicy;
    const P::AxisExcitation   excRef = P::excitation(ref);
    const P::AxisExcitation   excImu = P::excitation(imu);
    const P::ExcitationVerdict vRef  = P::gradeExcitation(excRef, excPolicy);
    const P::ExcitationVerdict vImu  = P::gradeExcitation(excImu, excPolicy);

    const P::BasisSelection sel = P::selectBasis(imu, ref, tau);
    const P::BasisVerdict   bv  = P::gradeBasis(sel, excRef, excPolicy, basisPolicy);

    std::vector<double> offs;
    if (offsets == nil) {
        offs = {tau - 0.010, tau - 0.005, tau, tau + 0.005, tau + 0.010};
    } else {
        for (NSNumber *n in offsets) {
            const double d = n.doubleValue;
            if (std::isfinite(d)) offs.push_back(d);
        }
    }
    const P::BasisStability st = P::basisStability(imu, ref, offs);

    NSMutableArray *ranked = [NSMutableArray array];
    // The top eight only.  All 24 would bury the four that matter, and the four
    // that matter are exactly the ones that TIE on a degenerate log.
    const std::size_t show = std::min<std::size_t>(sel.ranked.size(), 8);
    for (std::size_t i = 0; i < show; ++i) [ranked addObject:fitDict(sel.ranked[i])];

    NSMutableArray *offsetsOut = [NSMutableArray array];
    for (double d : offs) [offsetsOut addObject:jnum(d)];

    return @{
        @"ran": @YES,
        @"tauUsedS": jnum(tau),
        @"tauUsedNote": @"ARFrame.timestamp and CMDeviceMotion.timestamp both run "
                         "on the system uptime clock, so 0 is the physical answer; "
                         "the stability sweep is what makes that an observation "
                         "rather than an assumption.",
        @"imuSamples": @((NSInteger)imu.size()),
        @"refSamples": @((NSInteger)ref.size()),
        @"refRejectedTracking": @(rejected),
        @"truncated": @(trunc),
        @"durationS": ref.size() >= 2
            ? jnum(ref.back().tS - ref.front().tS) : (id)[NSNull null],
        @"deliveredImuHz": (imu.size() >= 2 && imu.back().tS > imu.front().tS)
            ? jnum((double)(imu.size() - 1) / (imu.back().tS - imu.front().tS))
            : (id)[NSNull null],
        @"excitationRef": excitationDict(excRef, vRef),
        // Reported so a reader can SEE that the two series describe the same
        // physical motion.  The eigen ratios are frame-invariant, so a large
        // disagreement between these two is a finding about the sensors, not
        // about the basis.
        @"excitationImu": excitationDict(excImu, vImu),
        @"selection": @{
            @"refusal": @(sel.refusal),
            @"unique": @(sel.unique),
            @"marginDeg": jnum(sel.marginDeg),
            @"candidates": @((NSInteger)sel.ranked.size()),
            @"ranked": ranked,
        },
        @"basis": @{
            @"ok": @(bv.ok),
            @"reason": @(bv.reason),
            @"index": @(bv.index),
            @"label": @(bv.label),
            @"pairs": @(bv.pairs),
            @"rmsDeg": jnum(bv.rmsDeg),
            @"maxDeg": jnum(bv.maxDeg),
            @"marginDeg": jnum(bv.marginDeg),
            @"unique": @(bv.unique),
            @"runnerUpIndex": @(bv.runnerUpIndex),
            @"runnerUpLabel": @(bv.runnerUpLabel),
            @"runnerUpRmsDeg": jnum(bv.runnerUpRmsDeg),
        },
        // SEPARATE from `basis`, deliberately.  The drift is the term that can
        // veto the ARCHITECTURE; it is not evidence about which of 24
        // permutations is correct, and letting it block the persist would throw
        // away a measurement that is exactly right.
        @"drift": @{
            @"measured": @(bv.drift.measured),
            @"degPerS": jnum(bv.drift.degPerS),
            @"canvasPxOverSweep": jnum(bv.drift.canvasPxOverSweep),
            @"sweepSeconds": jnum(bv.drift.sweepSeconds),
            @"canvasPxPerDeg": jnum(bv.drift.canvasPxPerDeg),
            @"budgetPx": jnum(bv.drift.budgetPx),
            @"withinBudget": @(bv.drift.withinBudget),
            @"rmsDetrendedDeg": jnum(bv.drift.rmsDetrendedDeg),
            @"biasedHigh": @(bv.drift.biasedHigh),
            @"biasedHighNote": @"the slope is fitted to |residual|, a magnitude, so "
                                "zero-mean noise still produces a positive slope: "
                                "read this as an upper-ish bound, not an unbiased "
                                "estimate.",
        },
        @"stability": @{
            @"ok": @(st.ok),
            @"reason": @(st.reason),
            @"winnerStable": @(st.winnerStable),
            @"winnerIndex": @(st.winnerIndex),
            @"triedOffsets": @(st.triedOffsets),
            @"agreeingOffsets": @(st.agreeingOffsets),
            @"minMarginDeg": jnum(st.minMarginDeg),
            @"offsetsS": offsetsOut,
        },
        @"policy": [RNISPanoCalibCore policy],
    };
}

// ── τ ───────────────────────────────────────────────────────────────────────

+ (NSDictionary<NSString *, id> *)combineTauRuns:(NSArray *)runs {
    std::vector<P::TauRun> v;
    NSMutableArray *echo = [NSMutableArray array];
    for (id o in runs) {
        if (![o isKindOfClass:[NSDictionary class]]) continue;
        NSDictionary *d = (NSDictionary *)o;
        P::TauRun r;
        id res = d[@"resolved"];
        r.resolved = [res isKindOfClass:[NSNumber class]] && [(NSNumber *)res boolValue];
        r.tauMs = numOr(d, @"tauMs", NAN);
        r.peakR = numOr(d, @"peakR", 0.0);
        r.bandWidthMs = numOr(d, @"bandWidthMs", 0.0);
        v.push_back(r);
        [echo addObject:@{@"resolved": @(r.resolved),
                          @"tauMs": jnum(r.tauMs),
                          @"peakR": jnum(r.peakR),
                          @"bandWidthMs": jnum(r.bandWidthMs)}];
    }

    const P::TauPolicy policy;
    const P::TauFit f = P::combineTau(v, policy);

    return @{
        @"ok": @(f.ok),
        @"reason": @(f.reason),
        @"runs": @(f.runs),
        @"resolvedRuns": @(f.resolvedRuns),
        // Runs the PROBE called resolved but which carried a non-finite tau or
        // peak.  Reported so `resolvedRuns < runs` never has to be explained
        // by guessing which of the two reasons applied.
        @"malformedRuns": @(f.malformedRuns),
        @"tauMs": jnum(f.tauMs),
        @"tauS": jnum(f.tauMs / 1000.0),
        @"meanMs": jnum(f.meanMs),
        @"sdMs": jnum(f.sdMs),
        @"spreadMs": jnum(f.spreadMs),
        @"stdErrMs": jnum(f.stdErrMs),
        @"worstPeakR": jnum(f.worstPeakR),
        @"maxBandWidthMs": jnum(f.maxBandWidthMs),
        @"budgetMs": jnum(f.budgetMs),
        @"budgetFractionUsed": jnum(f.budgetFractionUsed),
        @"smallSample": @(f.smallSample),
        @"smallSampleNote": @"with n = 3 the SD is itself uncertain to roughly "
                             "±40 %. Run more repeats to tighten it; the number "
                             "is not a converged quantity at this n.",
        // THE SIGN TRAVELS WITH THE NUMBER.  Applied backwards an offset does
        // not halve the error — it doubles it.
        @"tauSign": @"positive tau ⇒ attitude sampled at (pts + tau)",
        @"gradedOn": @"uncertainty",
        @"gradedOnNote": @"the gate is the standard error, NOT |tau|. The study's "
                          "3.08 ms p95 is the budget for the alignment error that "
                          "SURVIVES the correction; a large offset measured "
                          "precisely is a good calibration.",
        @"runsEcho": echo,
        @"policy": [RNISPanoCalibCore policy],
    };
}

+ (NSDictionary<NSString *, id> *)policy {
    const P::TauPolicy t;
    const P::ExcitationPolicy e;
    const P::BasisPolicy b;
    return @{
        @"tau": @{
            @"minRuns": @(t.minRuns),
            @"minPeakR": jnum(t.minPeakR),
            @"maxSpreadMs": jnum(t.maxSpreadMs),
            @"maxStdErrMs": jnum(t.maxStdErrMs),
            @"budgetMs": jnum(t.budgetMs),
        },
        @"excitation": @{
            @"minSweptDeg": jnum(e.minSweptDeg),
            @"minAxisDeg": jnum(e.minAxisDeg),
            @"minExercisedAxes": @(e.minExercisedAxes),
            @"minRank2": jnum(e.minRank2),
            @"minStepDeg": jnum(P::kExcitationMinStepDeg),
        },
        @"basis": @{
            @"maxRmsDeg": jnum(b.maxRmsDeg),
            @"minPairs": @(b.minPairs),
            @"candidates": @(P::basisCandidateCount()),
        },
    };
}

@end
