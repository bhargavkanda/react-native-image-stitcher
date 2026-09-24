// SPDX-License-Identifier: Apache-2.0
//
// d3_packio.hpp — the two attitude ledgers of an iOS AR-arm pano+ pack, read
// the way the PRODUCTION calibration recorder ingests them.
//
//   panoplus/track.jsonl        — one row per ARKit frame the engine saw,
//                                 written by RNISPanoCore.mm.  `q` is
//                                 RNISARFrameContext.poseRotation (world<-cam,
//                                 GL), `tsNs` is ARFrame.timestamp * 1e9,
//                                 `tracking` 2 == "normal".  Parsed with the
//                                 replay's OWN parser (replay::parseTrackRow).
//
//   panoplus/attitude_imu.jsonl — RNISPanoImuSidecar.swift, one row per
//                                 CMDeviceMotion in .xArbitraryZVertical:
//     {"tsS":…,"qx":…,"qy":…,"qz":…,"qw":…,"accelMps2":…[,"rotationRate":[…]]}
//
// The ingest rules are RNISPanoCalibCore.mm's pushImu/pushRef, verbatim in
// effect: drop a non-finite row, NORMALISE the quaternion, drop a row whose
// timestamp is not strictly greater than the last accepted one — and, for the
// reference, drop every frame whose tracking is not "normal"
// (RNISPanoBasisCalibration.swift:135).  Each drop is COUNTED.
//
// Header-only, STL + the two shared headers.  Tool code, not production code.

#ifndef D3_PACKIO_HPP
#define D3_PACKIO_HPP

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <vector>

#include "rnis_pano_attitude.hpp"
#include "rnis_pano_replay.hpp"

namespace d3 {

inline bool readFile(const std::string& p, std::string* out) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    *out = ss.str();
    return true;
}

inline bool isDir(const std::string& p) {
    struct stat st;
    return ::stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

inline bool isFile(const std::string& p) {
    struct stat st;
    return ::stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

/// The pack root OR its panoplus/ directory → the panoplus/ directory.
inline std::string resolvePanoplus(const std::string& packDir) {
    std::string d = packDir;
    while (d.size() > 1 && d.back() == '/') d.pop_back();
    if (isFile(d + "/panoplus/track.jsonl")) return d + "/panoplus";
    return d;
}

/// Whitespace-tolerant `"key": <number>` scrape on one flat JSON row.
inline bool numberField(const std::string& line, const char* key, double* out) {
    const std::string pat = std::string("\"") + key + "\"";
    size_t k = line.find(pat);
    if (k == std::string::npos) return false;
    size_t i = k + pat.size();
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) ++i;
    if (i >= line.size() || line[i] != ':') return false;
    ++i;
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) ++i;
    const char* p = line.c_str() + i;
    char* end = nullptr;
    const double v = std::strtod(p, &end);
    if (end == p) return false;
    *out = v;
    return true;
}

struct Series {
    std::vector<rnis::pano::AttitudeSample> samples;
    std::vector<double> accelMps2;   ///< IMU only, parallel to samples (NaN if absent)
    int lines = 0, accepted = 0, malformed = 0, nonFinite = 0, nonMonotonic = 0;
    int rejectedTracking = 0;        ///< reference only
    double firstS = NAN, lastS = NAN, hz = 0.0;

    void finish() {
        accepted = (int)samples.size();
        if (accepted >= 2) {
            firstS = samples.front().tS;
            lastS = samples.back().tS;
            if (lastS > firstS) hz = (double)(accepted - 1) / (lastS - firstS);
        } else if (accepted == 1) {
            firstS = lastS = samples.front().tS;
        }
    }
};

/// Push with RNISPanoCalibCore.mm's rules.  Returns false when dropped.
inline bool pushLikeCalibCore(Series& s, double tS, const double q[4]) {
    if (!std::isfinite(tS) || !std::isfinite(q[0]) || !std::isfinite(q[1]) ||
        !std::isfinite(q[2]) || !std::isfinite(q[3])) {
        ++s.nonFinite;
        return false;
    }
    rnis::pano::AttitudeSample a;
    a.tS = tS;
    for (int k = 0; k < 4; ++k) a.q[k] = q[k];
    rnis::pano::detail::quatNormalize(a.q);
    if (!s.samples.empty() && !(a.tS > s.samples.back().tS)) {
        ++s.nonMonotonic;
        return false;
    }
    s.samples.push_back(a);
    return true;
}

/// attitude_imu.jsonl → the IMU series (R_ref<-device, CoreMotion timebase).
inline bool readImuSidecar(const std::string& panoplusDir, Series* out,
                           std::string* err) {
    std::string text;
    if (!readFile(panoplusDir + "/attitude_imu.jsonl", &text)) {
        *err = "attitude_imu.jsonl missing in " + panoplusDir;
        return false;
    }
    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        if (line.find_first_not_of(" \t\r\n") == std::string::npos) continue;
        ++out->lines;
        double t, q[4], acc = NAN;
        if (!numberField(line, "tsS", &t) || !numberField(line, "qx", &q[0]) ||
            !numberField(line, "qy", &q[1]) || !numberField(line, "qz", &q[2]) ||
            !numberField(line, "qw", &q[3])) {
            ++out->malformed;
            continue;
        }
        numberField(line, "accelMps2", &acc);
        if (pushLikeCalibCore(*out, t, q)) out->accelMps2.push_back(acc);
    }
    out->finish();
    return true;
}

/// track.jsonl → the ARKit reference series (world<-cam GL, ARFrame timebase),
/// "normal" tracking only — RNISPanoBasisCalibration.swift's rule.
inline bool readArkitReference(const std::string& panoplusDir, Series* out,
                               std::string* err) {
    std::string text;
    if (!readFile(panoplusDir + "/track.jsonl", &text)) {
        *err = "track.jsonl missing in " + panoplusDir;
        return false;
    }
    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        if (line.find_first_not_of(" \t\r\n") == std::string::npos) continue;
        ++out->lines;
        const rnis::pano::replay::TrackRow r = rnis::pano::replay::parseTrackRow(line);
        if (!r.ok) { ++out->malformed; continue; }
        if (r.trackingDefaulted || r.tracking != 2) { ++out->rejectedTracking; continue; }
        pushLikeCalibCore(*out, r.tsNs / 1e9, r.q);
    }
    out->finish();
    return true;
}

// ── tiny JSON emit helpers ─────────────────────────────────────────────────
inline void jnum(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char b[64];
    std::snprintf(b, sizeof b, "%.10g", v);
    s += b;
}
inline void jstr(std::string& s, const std::string& v) {
    s += '"';
    for (char c : v) {
        if (c == '"' || c == '\\') { s += '\\'; s += c; }
        else if ((unsigned char)c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); s += b; }
        else s += c;
    }
    s += '"';
}
inline void jkey(std::string& s, const char* k) { jstr(s, k); s += ':'; }

}  // namespace d3

#endif  // D3_PACKIO_HPP
