// SPDX-License-Identifier: Apache-2.0
//
// d3_select_basis — D3 offline proof (1): run the SHARED C++ basis selection
// over iOS AR-arm packs that carry both attitude channels, and run the SHARED
// derivation the iOS vision-camera arm now uses instead.
//
//   d3_select_basis --derive                 # deriveBasis(90°, Back, Raw) only
//   d3_select_basis <packDir> [<packDir> …]  # one JSON object per pack, per line
//
// WHAT IS CALLED — the production calibration's own sequence, from
// RNISPanoCalibCore.mm `solveBasisWithTauS:stabilityOffsetsS:` (nothing here
// re-implements any of it):
//
//   rnis::pano::selectBasis(imu, ref, τ = 0)
//   rnis::pano::gradeBasis(sel, excitation(ref), ExcitationPolicy{}, BasisPolicy{})
//   rnis::pano::basisStability(imu, ref, {τ−10, τ−5, τ, τ+5, τ+10} ms)
//
// with `imu` = attitude_imu.jsonl (CMDeviceMotion, .xArbitraryZVertical) and
// `ref` = track.jsonl's ARKit poseRotation on "normal" frames — the two series
// RNISPanoBasisCalibration feeds that function live.  τ = 0 because
// ARFrame.timestamp and CMDeviceMotion.timestamp are both the uptime clock —
// the production calibration's own `tauUsedS` — and the ±10 ms stability
// sweep is what checks that.
//
// Tool code: nothing here is linked into any shipped target.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "d3_packio.hpp"
#include "rnis_pano_android_basis.hpp"
#include "rnis_pano_attitude.hpp"
#include "rnis_pano_calib.hpp"

namespace P = rnis::pano;
namespace A = rnis::pano::android;

namespace {

constexpr int kExpected = 8;   // -y+x+z, measured on iPhone17,1 2026-08-31

void matrixJson(std::string& s, const double m[9]) {
    s += '[';
    for (int r = 0; r < 3; ++r) {
        if (r) s += ',';
        s += '[';
        for (int c = 0; c < 3; ++c) {
            if (c) s += ',';
            d3::jnum(s, m[r * 3 + c] == 0.0 ? 0.0 : m[r * 3 + c]);   // no -0
        }
        s += ']';
    }
    s += ']';
}

void fitJson(std::string& s, const P::BasisFit& f, int rank) {
    s += '{';
    d3::jkey(s, "rank"); d3::jnum(s, rank); s += ',';
    d3::jkey(s, "index"); d3::jnum(s, f.index); s += ',';
    d3::jkey(s, "label"); d3::jstr(s, f.label); s += ',';
    d3::jkey(s, "pairs"); d3::jnum(s, f.pairs); s += ',';
    d3::jkey(s, "rmsDeg"); d3::jnum(s, f.rmsDeg); s += ',';
    d3::jkey(s, "maxDeg"); d3::jnum(s, f.maxDeg); s += ',';
    d3::jkey(s, "finalDeg"); d3::jnum(s, f.finalDeg); s += ',';
    d3::jkey(s, "driftDegPerS"); d3::jnum(s, f.driftDegPerS); s += ',';
    d3::jkey(s, "rmsDetrendedDeg"); d3::jnum(s, f.rmsDetrendedDeg);
    s += '}';
}

void seriesJson(std::string& s, const d3::Series& x, bool isRef) {
    s += '{';
    d3::jkey(s, "lines"); d3::jnum(s, x.lines); s += ',';
    d3::jkey(s, "accepted"); d3::jnum(s, x.accepted); s += ',';
    d3::jkey(s, "malformed"); d3::jnum(s, x.malformed); s += ',';
    d3::jkey(s, "nonFinite"); d3::jnum(s, x.nonFinite); s += ',';
    d3::jkey(s, "nonMonotonic"); d3::jnum(s, x.nonMonotonic); s += ',';
    if (isRef) { d3::jkey(s, "rejectedTracking"); d3::jnum(s, x.rejectedTracking); s += ','; }
    d3::jkey(s, "firstS"); d3::jnum(s, x.firstS); s += ',';
    d3::jkey(s, "lastS"); d3::jnum(s, x.lastS); s += ',';
    d3::jkey(s, "spanS"); d3::jnum(s, x.lastS - x.firstS); s += ',';
    d3::jkey(s, "hz"); d3::jnum(s, x.hz);
    s += '}';
}

void excitationJson(std::string& s, const P::AxisExcitation& e,
                    const P::ExcitationVerdict& v) {
    s += '{';
    d3::jkey(s, "sufficient"); s += v.sufficient ? "true" : "false"; s += ',';
    d3::jkey(s, "reason"); d3::jstr(s, v.reason); s += ',';
    d3::jkey(s, "exercisedAxes"); d3::jnum(s, v.exercisedAxes); s += ',';
    d3::jkey(s, "sweptDeg"); d3::jnum(s, e.sweptDeg); s += ',';
    d3::jkey(s, "spanDeg"); d3::jnum(s, e.spanDeg); s += ',';
    d3::jkey(s, "perAxisDeg_tilt_pan_roll");
    s += '['; d3::jnum(s, e.perAxisDeg[0]); s += ','; d3::jnum(s, e.perAxisDeg[1]);
    s += ','; d3::jnum(s, e.perAxisDeg[2]); s += "],";
    d3::jkey(s, "rank2"); d3::jnum(s, e.rank2); s += ',';
    d3::jkey(s, "rank3"); d3::jnum(s, e.rank3);
    s += '}';
}

int runDerive() {
    // EXACTLY the request RNISPanoAttitude.mm
    // `deriveBackBasisForMountingAngleDeg:mirrored:` builds for the iOS arm
    // when Apple reports the back camera's 90° portrait mounting.
    A::BasisRequest req;
    req.sensorOrientationDeg = 90;
    req.facing = A::LensFacing::Back;
    req.recorder = A::RecorderRotation::RawSensorBuffer;
    req.mirrored = false;
    const A::BasisDerivation d = A::deriveBasis(req);
    double m8[9];
    P::basisMatrix(kExpected, m8);
    bool matrixEq = d.matrixValid;
    for (int i = 0; i < 9 && matrixEq; ++i) matrixEq = (d.m[i] == m8[i]);

    std::string s = "{";
    d3::jkey(s, "kind"); d3::jstr(s, "deriveBasis"); s += ',';
    d3::jkey(s, "request");
    s += "{\"sensorOrientationDeg\":90,\"facing\":\"back\",\"recorder\":\"raw-sensor-buffer\",\"mirrored\":false},";
    d3::jkey(s, "ok"); s += d.ok ? "true" : "false"; s += ',';
    d3::jkey(s, "index"); d3::jnum(s, d.index); s += ',';
    d3::jkey(s, "label"); d3::jstr(s, d.label); s += ',';
    d3::jkey(s, "refusal"); d3::jstr(s, d.refusal); s += ',';
    d3::jkey(s, "appliedRotationCwDeg"); d3::jnum(s, d.appliedRotationCwDeg); s += ',';
    d3::jkey(s, "residualRotationCwDeg"); d3::jnum(s, d.residualRotationCwDeg); s += ',';
    d3::jkey(s, "matrixValid"); s += d.matrixValid ? "true" : "false"; s += ',';
    d3::jkey(s, "m"); matrixJson(s, d.m); s += ',';
    d3::jkey(s, "basis8"); matrixJson(s, m8); s += ',';
    d3::jkey(s, "basis8Label"); d3::jstr(s, P::basisLabel(kExpected)); s += ',';
    d3::jkey(s, "equals8"); s += (d.ok && d.index == kExpected && matrixEq) ? "true" : "false";
    s += ',';
    d3::jkey(s, "provenance"); d3::jstr(s, A::derivedBasisProvenanceName());
    s += '}';
    std::printf("%s\n", s.c_str());

    // The whole enumeration, once, so an index in results.md is checkable.
    std::string t = "{\"kind\":\"basisTable\",\"candidates\":[";
    for (int i = 0; i < P::basisCandidateCount(); ++i) {
        double m[9];
        P::basisMatrix(i, m);
        if (i) t += ',';
        t += "{\"index\":"; d3::jnum(t, i);
        t += ",\"label\":"; d3::jstr(t, P::basisLabel(i));
        t += ",\"m\":"; matrixJson(t, m);
        t += '}';
    }
    t += "]}";
    std::printf("%s\n", t.c_str());
    return (d.ok && d.index == kExpected && matrixEq) ? 0 : 1;
}

int runPack(const std::string& packDir) {
    const std::string pp = d3::resolvePanoplus(packDir);
    std::string err;
    d3::Series imu, ref;
    std::string s = "{";
    d3::jkey(s, "kind"); d3::jstr(s, "selectBasis"); s += ',';
    d3::jkey(s, "pack"); d3::jstr(s, packDir); s += ',';
    if (!d3::readImuSidecar(pp, &imu, &err) || !d3::readArkitReference(pp, &ref, &err)) {
        d3::jkey(s, "error"); d3::jstr(s, err); s += '}';
        std::printf("%s\n", s.c_str());
        return 1;
    }

    const double tau = 0.0;
    const P::ExcitationPolicy excPolicy;
    const P::BasisPolicy basisPolicy;
    const P::AxisExcitation excRef = P::excitation(ref.samples);
    const P::AxisExcitation excImu = P::excitation(imu.samples);
    const P::ExcitationVerdict vRef = P::gradeExcitation(excRef, excPolicy);
    const P::ExcitationVerdict vImu = P::gradeExcitation(excImu, excPolicy);
    const P::BasisSelection sel = P::selectBasis(imu.samples, ref.samples, tau);
    const P::BasisVerdict bv = P::gradeBasis(sel, excRef, excPolicy, basisPolicy);
    const std::vector<double> offs = {tau - 0.010, tau - 0.005, tau, tau + 0.005, tau + 0.010};
    const P::BasisStability st = P::basisStability(imu.samples, ref.samples, offs);

    int rank8 = -1;
    for (size_t i = 0; i < sel.ranked.size(); ++i)
        if (sel.ranked[i].index == kExpected) { rank8 = (int)i; break; }

    d3::jkey(s, "tauS"); d3::jnum(s, tau); s += ',';
    d3::jkey(s, "imu"); seriesJson(s, imu, false); s += ',';
    d3::jkey(s, "ref"); seriesJson(s, ref, true); s += ',';
    d3::jkey(s, "excitationRef"); excitationJson(s, excRef, vRef); s += ',';
    d3::jkey(s, "excitationImu"); excitationJson(s, excImu, vImu); s += ',';
    d3::jkey(s, "selection");
    s += '{';
    d3::jkey(s, "refusal"); d3::jstr(s, sel.refusal); s += ',';
    d3::jkey(s, "unique"); s += sel.unique ? "true" : "false"; s += ',';
    d3::jkey(s, "marginDeg"); d3::jnum(s, sel.marginDeg); s += ',';
    d3::jkey(s, "candidates"); d3::jnum(s, (double)sel.ranked.size()); s += ',';
    d3::jkey(s, "winnerIndex"); d3::jnum(s, sel.ranked.empty() ? -1 : sel.ranked[0].index); s += ',';
    d3::jkey(s, "winnerLabel"); d3::jstr(s, sel.ranked.empty() ? "invalid" : sel.ranked[0].label); s += ',';
    d3::jkey(s, "winnerIs8"); s += (!sel.ranked.empty() && sel.ranked[0].index == kExpected) ? "true" : "false"; s += ',';
    d3::jkey(s, "rankOf8"); d3::jnum(s, rank8); s += ',';
    d3::jkey(s, "ranked");
    s += '[';
    for (size_t i = 0; i < sel.ranked.size() && i < 6; ++i) {
        if (i) s += ',';
        fitJson(s, sel.ranked[i], (int)i);
    }
    s += "],";
    d3::jkey(s, "fitOf8");
    if (rank8 >= 0) fitJson(s, sel.ranked[(size_t)rank8], rank8); else s += "null";
    s += "},";
    d3::jkey(s, "verdict");
    s += '{';
    d3::jkey(s, "ok"); s += bv.ok ? "true" : "false"; s += ',';
    d3::jkey(s, "reason"); d3::jstr(s, bv.reason); s += ',';
    d3::jkey(s, "index"); d3::jnum(s, bv.index); s += ',';
    d3::jkey(s, "label"); d3::jstr(s, bv.label); s += ',';
    d3::jkey(s, "pairs"); d3::jnum(s, bv.pairs); s += ',';
    d3::jkey(s, "rmsDeg"); d3::jnum(s, bv.rmsDeg); s += ',';
    d3::jkey(s, "runnerUpIndex"); d3::jnum(s, bv.runnerUpIndex); s += ',';
    d3::jkey(s, "runnerUpLabel"); d3::jstr(s, bv.runnerUpLabel); s += ',';
    d3::jkey(s, "runnerUpRmsDeg"); d3::jnum(s, bv.runnerUpRmsDeg); s += ',';
    d3::jkey(s, "driftDegPerS"); d3::jnum(s, bv.drift.degPerS); s += ',';
    d3::jkey(s, "driftCanvasPxOverSweep"); d3::jnum(s, bv.drift.canvasPxOverSweep);
    s += "},";
    d3::jkey(s, "stability");
    s += '{';
    d3::jkey(s, "reason"); d3::jstr(s, st.reason); s += ',';
    d3::jkey(s, "winnerStable"); s += st.winnerStable ? "true" : "false"; s += ',';
    d3::jkey(s, "winnerIndex"); d3::jnum(s, st.winnerIndex); s += ',';
    d3::jkey(s, "triedOffsets"); d3::jnum(s, st.triedOffsets); s += ',';
    d3::jkey(s, "agreeingOffsets"); d3::jnum(s, st.agreeingOffsets); s += ',';
    d3::jkey(s, "minMarginDeg"); d3::jnum(s, st.minMarginDeg);
    s += '}';
    s += '}';
    std::printf("%s\n", s.c_str());
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s --derive | <packDir> [<packDir> ...]\n", argv[0]);
        return 2;
    }
    if (std::strcmp(argv[1], "--derive") == 0) return runDerive();
    int rc = 0;
    for (int i = 1; i < argc; ++i) rc |= runPack(argv[i]);
    return rc;
}
