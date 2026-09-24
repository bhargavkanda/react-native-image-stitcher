// SPDX-License-Identifier: Apache-2.0
//
// d3_basis_replay — D3 offline proof (2): the WRONG-BASIS NEGATIVE CONTROL.
//
//   d3_basis_replay <packDir> <outRoot> <tag> <arm> [<arm> …]
//
//   arm = "ar"      the pack's own track.jsonl, unmodified (ARKit attitude, the
//                   arm that actually captured it) — the baseline
//         "arq"     ARKit's q and tracking, in the vision-camera arm's ROW
//                   SHAPE (t = 0, no ARKit exposure) — isolates the source
//         <0..23>   the pack's CoreMotion sidecar mapped through basis C = that
//                   index, exactly as the vision-camera arm feeds the engine
//
// ── WHY A SYNTHESISED PACK, NOT A PATCHED DRIVER ────────────────────────────
//
// `replay::replayPack` takes no basis: it ingests track.jsonl's `q` verbatim
// (rnis_pano_replay.cpp, `in.q[k] = row.q[k]`), and its own header explains
// why it offers no override.  But these packs ALSO carry attitude_imu.jsonl,
// so the vision-camera arm's attitude can be REBUILT for these very frames.
// This tool therefore writes, per arm, a pack whose track.jsonl differs from
// the original ONLY in the attitude columns, and hands it to the UNMODIFIED
// `replayPack`.  The override lives here and nowhere else.
//
// The rebuilt row is what RNISPanoSweepFrameProcessor.mm hands
// `RNISPanoCore ingestPixelBuffer:` on the vision-camera arm:
//
//   q         AttitudeAligner{τ = 0 uncorrected, basisIndex = C}.alignAndCount
//             (pts) — i.e. R_engine = R_imu(pts) · C, slerped, never
//             extrapolated (the shared rnis_pano_attitude.cpp, not a copy)
//   tracking  2 / 1 from the aligner; a REFUSED alignment is still ingested
//             with tracking = notAvailable (0) and the aligner's identity q —
//             the arm's own "non-fatal refusals are still ingested" policy
//   t         0, 0, 0 — no VIO on this arm
//   arExp*    0 / false — no ARKit exposure on this arm
//   everything else (seq, tsNs, intrinsics, w/h, expDurS/expISO) unchanged
//
// frames/, meta.json and ledger.jsonl are SYMLINKED from the original pack, so
// the pixels, the Config (useMetaConfig) and the oracle are the device's own.
//
// Tool code: nothing here is linked into any shipped target.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "d3_packio.hpp"
#include "rnis_pano_attitude.hpp"
#include "rnis_pano_replay.hpp"

namespace fs = std::filesystem;
namespace P = rnis::pano;
namespace R = rnis::pano::replay;

namespace {

bool relink(const fs::path& target, const fs::path& link, std::string* err) {
    std::error_code ec;
    fs::remove(link, ec);
    fs::create_symlink(target, link, ec);
    if (ec) { *err = "symlink " + link.string() + ": " + ec.message(); return false; }
    return true;
}

struct AlignStats {
    bool ran = false;
    int basis = -1;
    P::AlignerCounters c;
    int rowsWritten = 0, rowsUnparsed = 0;
};

/// Build <armRoot>/panoplus/ for one arm.  Returns false with `err` set.
bool synthesise(const std::string& srcPanoplus, const fs::path& armRoot,
                const std::string& arm, const d3::Series& imu, AlignStats* as,
                std::string* err) {
    const fs::path pp = armRoot / "panoplus";
    std::error_code ec;
    fs::create_directories(pp, ec);
    if (ec) { *err = "mkdir " + pp.string() + ": " + ec.message(); return false; }
    const fs::path src = fs::absolute(srcPanoplus);
    if (!relink(src / "frames", pp / "frames", err)) return false;
    if (!relink(src / "meta.json", pp / "meta.json", err)) return false;
    if (fs::exists(src / "ledger.jsonl") && !relink(src / "ledger.jsonl", pp / "ledger.jsonl", err))
        return false;

    if (arm == "ar") {
        return relink(src / "track.jsonl", pp / "track.jsonl", err);
    }
    const bool arkitRowShape = (arm == "arq");

    const int basis = arkitRowShape ? -1 : std::atoi(arm.c_str());
    as->ran = !arkitRowShape;
    as->basis = basis;

    P::AttitudeAligner::Config cfg;
    cfg.tauS = 0.0;
    cfg.tauMeasured = false;
    cfg.tauUncorrected = true;     // what the vc arm runs on (PanoPlusBridge.swift)
    cfg.basisIndex = basis;
    // Offline every sample is already on disk, so the ring holds them all —
    // the live arm's 512-sample ring only ever needs the last ~2.5 s.
    cfg.capacity = imu.samples.size() + 2;
    P::AttitudeAligner al(cfg);
    for (const auto& s : imu.samples) al.push(s);

    std::string text;
    if (!d3::readFile(srcPanoplus + "/track.jsonl", &text)) {
        *err = "cannot read track.jsonl";
        return false;
    }
    std::istringstream in(text);
    std::string line, out;
    while (std::getline(in, line)) {
        if (line.find_first_not_of(" \t\r\n") == std::string::npos) continue;
        R::TrackRow r = R::parseTrackRow(line);
        if (!r.ok) { ++as->rowsUnparsed; continue; }
        if (!arkitRowShape) {
            const P::AlignedAttitude a = al.alignAndCount(r.tsNs / 1e9, std::nan(""));
            for (int k = 0; k < 4; ++k) r.q[k] = a.q[k];
            r.tracking = a.ok ? a.tracking : 0;
            r.trackingDefaulted = false;
        }
        // "arq" keeps ARKit's q and tracking and changes ONLY the row shape
        // below — so "arq" vs an IMU arm isolates the attitude SOURCE, and
        // "ar" vs "arq" isolates the row shape (t, ARKit exposure).
        r.t[0] = r.t[1] = r.t[2] = 0.0;
        r.arExpDurS = 0.0;
        r.arExpOffsetEV = 0.0;
        r.arExpHave = false;
        R::appendTrackRow(out, r);
        out += '\n';
        ++as->rowsWritten;
    }
    as->c = al.counters();
    const fs::path trackOut = pp / "track.jsonl";
    fs::remove(trackOut, ec);   // may be a symlink from an earlier "ar" layout
    std::ofstream f(trackOut, std::ios::binary);
    f << out;
    if (!f) { *err = "cannot write " + trackOut.string(); return false; }
    return true;
}

std::string reportJson(const std::string& tag, const std::string& arm,
                       const AlignStats& as, const R::ReplayReport& r) {
    using d3::jkey; using d3::jnum; using d3::jstr;
    std::string s = "{";
    jkey(s, "kind"); jstr(s, "basisReplay"); s += ',';
    jkey(s, "tag"); jstr(s, tag); s += ',';
    jkey(s, "arm"); jstr(s, arm); s += ',';
    jkey(s, "attitudeSource");
    jstr(s, arm == "ar" ? "arkit-track.jsonl"
          : arm == "arq" ? "arkit-q-in-vc-arm-row-shape"
          : "coremotion-sidecar-through-C");
    s += ',';
    jkey(s, "basisIndex"); jnum(s, as.ran ? as.basis : -1); s += ',';
    jkey(s, "basisLabel"); jstr(s, as.ran ? P::basisLabel(as.basis) : "arkit"); s += ',';
    jkey(s, "aligner");
    if (!as.ran) s += "null";
    else {
        s += '{';
        jkey(s, "rowsWritten"); jnum(s, as.rowsWritten); s += ',';
        jkey(s, "rowsUnparsed"); jnum(s, as.rowsUnparsed); s += ',';
        jkey(s, "aligned"); jnum(s, (double)as.c.aligned); s += ',';
        jkey(s, "accepted"); jnum(s, (double)as.c.accepted); s += ',';
        jkey(s, "acceptedNormal"); jnum(s, (double)as.c.acceptedNormal); s += ',';
        jkey(s, "acceptedLimited"); jnum(s, (double)as.c.acceptedLimited); s += ',';
        jkey(s, "refusedBefore"); jnum(s, (double)as.c.refusedBefore); s += ',';
        jkey(s, "refusedAfter"); jnum(s, (double)as.c.refusedAfter); s += ',';
        jkey(s, "refusedOther"); jnum(s, (double)(as.c.refusedTau + as.c.refusedBasis + as.c.refusedEmpty + as.c.refusedNonFinite + as.c.refusedLurch + as.c.refusedTauConflict)); s += ',';
        jkey(s, "maxBracketGapS"); jnum(s, as.c.maxBracketGapS);
        s += '}';
    }
    s += ',';
    jkey(s, "ok"); s += r.ok ? "true" : "false"; s += ',';
    jkey(s, "error"); jstr(s, r.error); s += ',';
    jkey(s, "framesIngested"); jnum(s, r.framesIngested); s += ',';
    jkey(s, "framesMissing"); jnum(s, r.framesMissing); s += ',';
    jkey(s, "rowsMalformed"); jnum(s, r.rowsMalformed); s += ',';
    jkey(s, "painted"); jnum(s, r.painted); s += ',';
    jkey(s, "held"); jnum(s, r.held); s += ',';
    jkey(s, "rejected"); jnum(s, r.rejected); s += ',';
    jkey(s, "skipped"); jnum(s, r.skipped); s += ',';
    jkey(s, "other"); jnum(s, r.other); s += ',';
    jkey(s, "outcomeCounts"); s += '{';
    for (size_t i = 0; i < r.outcomeCounts.size(); ++i) {
        if (i) s += ',';
        jkey(s, r.outcomeCounts[i].first.c_str()); jnum(s, r.outcomeCounts[i].second);
    }
    s += "},";
    jkey(s, "abortReason"); jstr(s, r.abortReason); s += ',';
    jkey(s, "holes"); jnum(s, r.holes); s += ',';
    jkey(s, "canvasW"); jnum(s, r.canvasW); s += ',';
    jkey(s, "canvasH"); jnum(s, r.canvasH); s += ',';
    jkey(s, "paintedW"); jnum(s, r.stats.paintedW); s += ',';
    jkey(s, "paintedH"); jnum(s, r.stats.paintedH); s += ',';
    jkey(s, "outputW"); jnum(s, r.stats.outputW); s += ',';
    jkey(s, "outputH"); jnum(s, r.stats.outputH); s += ',';
    jkey(s, "deviceOutputW"); jnum(s, r.deviceOutputW); s += ',';
    jkey(s, "deviceOutputH"); jnum(s, r.deviceOutputH); s += ',';
    jkey(s, "canvasPath"); jstr(s, r.canvasWritten ? r.canvasPath : ""); s += ',';
    jkey(s, "latch"); s += '{';
    jkey(s, "latched"); s += r.stats.axisLatched ? "true" : "false"; s += ',';
    jkey(s, "framesUsed"); jnum(s, r.stats.latchFramesUsed); s += ',';
    jkey(s, "weak"); s += r.stats.latchWasWeak ? "true" : "false"; s += ',';
    jkey(s, "relatchCount"); jnum(s, r.stats.relatchCount); s += ',';
    jkey(s, "axis"); jnum(s, r.stats.axis); s += ',';
    jkey(s, "sweepSign"); jnum(s, r.stats.sweepSign); s += ',';
    jkey(s, "rotationPx"); s += '['; jnum(s, r.stats.latchRotPx[0]); s += ','; jnum(s, r.stats.latchRotPx[1]); s += "],";
    jkey(s, "totalPx"); s += '['; jnum(s, r.stats.latchTotPx[0]); s += ','; jnum(s, r.stats.latchTotPx[1]); s += ']';
    s += "},";
    jkey(s, "regime"); s += '{';
    jkey(s, "rotationFraction"); jnum(s, r.stats.rotationFraction); s += ',';
    jkey(s, "rotTravelPx"); jnum(s, r.stats.rotTravelPx); s += ',';
    jkey(s, "resTravelPx"); jnum(s, r.stats.resTravelPx); s += ',';
    jkey(s, "rotPathPx"); jnum(s, r.stats.rotPathPx); s += ',';
    jkey(s, "resPathPx"); jnum(s, r.stats.resPathPx);
    s += "},";
    jkey(s, "maxRectifyDeg"); jnum(s, r.stats.maxRectifyDeg); s += ',';
    jkey(s, "sweepDeg"); jnum(s, r.stats.sweepDeg); s += ',';
    jkey(s, "integrityFailed"); s += r.stats.integrityFailed ? "true" : "false"; s += ',';
    jkey(s, "oracle"); s += '{';
    jkey(s, "have"); s += r.haveOracle ? "true" : "false"; s += ',';
    jkey(s, "agree"); jnum(s, r.outcomeAgree); s += ',';
    jkey(s, "disagree"); jnum(s, r.outcomeDisagree);
    s += '}';
    s += '}';
    return s;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 5) {
        std::fprintf(stderr,
                     "usage: %s <packDir> <outRoot> <tag> <arm> [<arm> ...]\n"
                     "  arm = ar | arq | <basis index 0..23>\n", argv[0]);
        return 2;
    }
    const std::string packDir = argv[1];
    const fs::path outRoot = argv[2];
    const std::string tag = argv[3];
    const std::string pp = d3::resolvePanoplus(packDir);

    d3::Series imu;
    std::string err;
    if (!d3::readImuSidecar(pp, &imu, &err)) {
        std::fprintf(stderr, "%s\n", err.c_str());
        return 1;
    }

    int rc = 0;
    for (int i = 4; i < argc; ++i) {
        const std::string arm = argv[i];
        if (arm != "ar" && arm != "arq") {
            char* end = nullptr;
            const long b = std::strtol(arm.c_str(), &end, 10);
            if (*end != '\0' || b < 0 || b >= P::basisCandidateCount()) {
                std::fprintf(stderr, "bad arm: %s\n", arm.c_str());
                return 2;
            }
        }
        const fs::path armRoot = outRoot / tag /
            ((arm == "ar" || arm == "arq") ? arm : ("imu_C" + arm));
        AlignStats as;
        if (!synthesise(pp, armRoot, arm, imu, &as, &err)) {
            std::fprintf(stderr, "%s: %s\n", arm.c_str(), err.c_str());
            rc = 1;
            continue;
        }
        R::ReplayOptions o;
        o.packDir = armRoot.string();
        o.outDir = (armRoot / "replay").string();
        o.useMetaConfig = true;
        o.writeCanvas = true;
        o.writeLedger = true;
        o.compareLedger = true;
        R::ReplayReport rep;
        R::replayPack(o, &rep);
        if (!rep.ok) rc = 1;
        std::printf("%s\n", reportJson(tag, arm, as, rep).c_str());
        std::fflush(stdout);
    }
    return rc;
}
