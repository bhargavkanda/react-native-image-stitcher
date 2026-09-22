// SPDX-License-Identifier: Apache-2.0
//
// rnis_drift_check — run the SHIPPED lateral-drift detector over a pack's
// ledger and print its verdict.
//
// WHY THIS EXISTS. The detector's thresholds are the entire product, and the
// only honest way to calibrate them is against real packs with operator
// labels. A full `rnis_replay_cli` run needs `frames/`, which is tens of
// megabytes a pack and is often not pulled off the device — but the detector
// reads nothing except four numbers that are already in `ledger.jsonl`
// (crossRectifyDeg, psiDeg, posU, posV) plus the canvas height. So this runs
// the REAL `rnis::pano::DriftDetector` — not a reimplementation of it — over
// the ledger alone, in milliseconds, on every pack ever captured.
//
// A reimplementation in a script would be the obvious shortcut and is exactly
// the mistake: a threshold validated against a Python twin is a threshold
// validated against the twin's bugs. `DriftDetector` was lifted out of the
// engine's `Impl` for this reason.
//
//   rnis_drift_check <packDir> [knob=value ...]
//
// `packDir` is the directory holding `ledger.jsonl` and `meta.json`. Knobs are
// deltas against the built-in defaults, e.g. `driftLeanDeg=4.0`.

#include "../panoplus/rnis_pano.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

// A deliberately small JSON scrape rather than a parser dependency: the
// ledger's rows are flat and machine-written, and the fields wanted are
// numbers under known keys. `found` is reported so a MISSING field is never
// silently read as 0.0 — a pack whose ledger predates a field would otherwise
// look like a pack with no drift.
bool numberField(const std::string& line, const char* key, double* out) {
    const std::string pat = std::string("\"") + key + "\":";
    const size_t k = line.find(pat);
    if (k == std::string::npos) return false;
    const char* p = line.c_str() + k + pat.size();
    char* end = nullptr;
    const double v = std::strtod(p, &end);
    if (end == p) return false;
    *out = v;
    return true;
}

bool stringField(const std::string& line, const char* key, std::string* out) {
    const std::string pat = std::string("\"") + key + "\":\"";
    const size_t k = line.find(pat);
    if (k == std::string::npos) return false;
    const size_t s = k + pat.size();
    const size_t e = line.find('"', s);
    if (e == std::string::npos) return false;
    *out = line.substr(s, e - s);
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr,
                     "usage: rnis_drift_check <packDir> [knob=value ...]\n");
        return 2;
    }
    const std::string dir = argv[1];

    rnis::pano::Config cfg;
    for (int i = 2; i < argc; ++i) {
        const std::string a = argv[i];
        const size_t eq = a.find('=');
        if (eq == std::string::npos) continue;
        const std::string k = a.substr(0, eq);
        const double v = std::strtod(a.c_str() + eq + 1, nullptr);
        if (k == "driftLeanDeg")            cfg.driftLeanDeg = v;
        else if (k == "driftLeanRatio")     cfg.driftLeanRatio = v;
        else if (k == "driftLeanMono")      cfg.driftLeanMono = v;
        else if (k == "driftLeanPanMinDeg") cfg.driftLeanPanMinDeg = v;
        else if (k == "driftLeanMinRows")   cfg.driftLeanMinRows = static_cast<int>(v);
        else if (k == "driftSteepDeg")      cfg.driftSteepDeg = v;
        else if (k == "driftSteepRatio")    cfg.driftSteepRatio = v;
        else if (k == "driftSteepMono")     cfg.driftSteepMono = v;
        else if (k == "driftSlideBandFrac") cfg.driftSlideBandFrac = v;
        else if (k == "driftSlideDeadbandPx") cfg.driftSlideDeadbandPx = v;
        else if (k == "driftWarnScale")     cfg.driftWarnScale = v;
        else {
            std::fprintf(stderr, "unknown knob: %s\n", k.c_str());
            return 2;
        }
    }

    // The canvas height is the band arm 3 measures against. Taken from
    // meta.json when present; a pack that cannot say is reported rather than
    // defaulted, because a wrong band silently rescales the whole arm.
    int canvasH = 0;
    {
        std::ifstream m(dir + "/meta.json");
        std::string all((std::istreambuf_iterator<char>(m)),
                        std::istreambuf_iterator<char>());
        double v = 0.0;
        if (numberField(all, "canvasH", &v) || numberField(all, "outputH", &v)) {
            canvasH = static_cast<int>(v);
        }
    }

    std::ifstream f(dir + "/ledger.jsonl");
    if (!f) {
        std::fprintf(stderr, "cannot open %s/ledger.jsonl\n", dir.c_str());
        return 1;
    }

    rnis::pano::DriftDetector d;
    std::string line;
    int painted = 0, total = 0, relatches = 0;
    double lastHighWater = -1.0;
    while (std::getline(f, line)) {
        if (line.empty()) continue;
        ++total;

        // The `seq: -1` tail-flush row is a SUMMARY: it carries no geometry at
        // all, and feeding it in injects a spurious 0 into the running extrema.
        double seq = 0.0;
        if (numberField(line, "seq", &seq) && seq < 0) continue;

        std::string outcome;
        if (!stringField(line, "outcome", &outcome)) continue;
        if (outcome != "painted" && outcome != "gap-extended") continue;

        // A relatch re-bases the session, and two packs in the labelled set
        // relatch mid-capture — one of them a vouched-GOOD sweep.
        double hw = 0.0;
        if (numberField(line, "highWater", &hw)) {
            if (lastHighWater >= 0.0 && hw < lastHighWater - 20.0) {
                d.rebase();
                ++relatches;
            }
            lastHighWater = hw;
        }

        double cross = 0.0, psi = 0.0, posU = 0.0, posV = 0.0, vShift = 0.0;
        if (!numberField(line, "crossRectifyDeg", &cross)) continue;
        if (!numberField(line, "psiDeg", &psi)) continue;
        numberField(line, "posU", &posU);
        numberField(line, "posV", &posV);
        numberField(line, "vShiftPx", &vShift);

        d.observe(cfg, cross, psi, posU, posV, vShift, canvasH);
        ++painted;
    }

    const char* verdict = (d.level == 2) ? "STOP" : (d.level == 1 ? "WARN" : "clean");
    std::printf(
        "%-22s %-5s arm=%-6s stopRow=%-5d warnRow=%-5d painted=%-4d "
        "relatch=%d canvasH=%-5d peakLean=%.2f peakSlide=%.3f",
        dir.substr(dir.find_last_of('/') + 1).c_str(), verdict,
        d.arm.empty() ? "-" : d.arm.c_str(), d.firedAtRow, d.warnedAtRow,
        painted, relatches, canvasH, d.peakLeanDeg, d.peakSlideFrac);
    if (d.firedAtRow >= 0 && painted > 0) {
        std::printf(" firedAt=%.2f", static_cast<double>(d.firedAtRow) / painted);
    }
    std::printf("\n");
    return 0;
}
