// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_s1.cpp — see rnis_pano_android_s1.hpp for what this is and
// for the four things it refuses to do.

#include "rnis_pano_android_s1.hpp"

#include <sys/stat.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace rnis {
namespace pano {
namespace android {

const double kQuatNormTolerance = 1e-3;

namespace {

void appendNum(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    s += buf;
}

void appendInt(std::string& s, long long v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", v);
    s += buf;
}

void appendJsonString(std::string& s, const char* v) {
    s += '"';
    if (v != nullptr) {
        for (const char* p = v; *p != '\0'; ++p) {
            const unsigned char c = (unsigned char)*p;
            switch (c) {
                case '"':  s += "\\\""; break;
                case '\\': s += "\\\\"; break;
                case '\n': s += "\\n";  break;
                case '\r': s += "\\r";  break;
                case '\t': s += "\\t";  break;
                default:
                    if (c < 0x20) {
                        char b[8];
                        std::snprintf(b, sizeof(b), "\\u%04x", c);
                        s += b;
                    } else {
                        s += (char)c;
                    }
            }
        }
    }
    s += '"';
}

/// Skip past a JSON string starting at `p` (which must index its opening
/// quote).  Leaves `p` one past the closing quote.  False on an unterminated
/// string — which a truncated last line of a jsonl file genuinely produces
/// when the writer was killed mid-flush.
bool skipString(const std::string& s, size_t& p) {
    if (p >= s.size() || s[p] != '"') return false;
    ++p;
    while (p < s.size()) {
        const char c = s[p];
        if (c == '\\') { p += 2; continue; }
        if (c == '"') { ++p; return true; }
        ++p;
    }
    return false;
}

/// Skip one JSON value starting at `p`, whatever its type.  Leaves `p` one
/// past the value's last character.
bool skipValue(const std::string& s, size_t& p) {
    while (p < s.size() && (unsigned char)s[p] <= ' ') ++p;
    if (p >= s.size()) return false;
    const char c = s[p];
    if (c == '"') return skipString(s, p);
    if (c == '{' || c == '[') {
        int depth = 0;
        while (p < s.size()) {
            const char d = s[p];
            if (d == '"') { if (!skipString(s, p)) return false; continue; }
            if (d == '{' || d == '[') ++depth;
            else if (d == '}' || d == ']') {
                --depth;
                ++p;
                if (depth == 0) return true;
                continue;
            }
            ++p;
        }
        return false;
    }
    // A scalar runs until a structural character.
    while (p < s.size()) {
        const char d = s[p];
        if (d == ',' || d == '}' || d == ']' || (unsigned char)d <= ' ') break;
        ++p;
    }
    return true;
}

}  // namespace

namespace detail {

bool memberSpan(const std::string& s, const char* key, size_t* b, size_t* e) {
    if (key == nullptr || b == nullptr || e == nullptr) return false;
    const size_t keyLen = std::strlen(key);

    size_t p = 0;
    while (p < s.size() && (unsigned char)s[p] <= ' ') ++p;
    if (p >= s.size() || s[p] != '{') return false;
    ++p;

    for (;;) {
        while (p < s.size() && (unsigned char)s[p] <= ' ') ++p;
        if (p >= s.size()) return false;
        if (s[p] == '}') return false;
        if (s[p] == ',') { ++p; continue; }
        if (s[p] != '"') return false;

        const size_t nameStart = p + 1;
        size_t after = p;
        if (!skipString(s, after)) return false;
        const size_t nameEnd = after - 1;     // the closing quote

        while (after < s.size() && (unsigned char)s[after] <= ' ') ++after;
        if (after >= s.size() || s[after] != ':') return false;
        ++after;
        while (after < s.size() && (unsigned char)s[after] <= ' ') ++after;

        const size_t valStart = after;
        size_t valEnd = after;
        if (!skipValue(s, valEnd)) return false;

        const bool hit = (nameEnd - nameStart) == keyLen &&
            std::memcmp(s.data() + nameStart, key, keyLen) == 0;
        if (hit) { *b = valStart; *e = valEnd; return true; }

        p = valEnd;
    }
}

bool spanNumber(const std::string& s, size_t b, size_t e, double* out) {
    if (out == nullptr || b >= e || e > s.size()) return false;
    // `strtod` needs a NUL-terminated buffer and the span is a view into a
    // whole line, so copy the (always short) numeric text out.
    const size_t n = e - b;
    if (n >= 64) return false;
    char buf[64];
    std::memcpy(buf, s.data() + b, n);
    buf[n] = '\0';
    char* end = nullptr;
    const double v = std::strtod(buf, &end);
    if (end == buf) return false;
    // Trailing characters mean this was not a bare number — `null`, `true`, or
    // a malformed token that strtod happened to consume a prefix of.
    while (end != nullptr && *end != '\0' && (unsigned char)*end <= ' ') ++end;
    if (end == nullptr || *end != '\0') return false;
    if (!std::isfinite(v)) return false;
    *out = v;
    return true;
}

bool spanStringEquals(const std::string& s, size_t b, size_t e, const char* want) {
    if (want == nullptr || b >= e || e > s.size()) return false;
    if (s[b] != '"' || s[e - 1] != '"' || (e - b) < 2) return false;
    const size_t n = (e - 1) - (b + 1);
    return std::strlen(want) == n && std::memcmp(s.data() + b + 1, want, n) == 0;
}

bool spanNumberArray(const std::string& s, size_t b, size_t e, double* out, int n) {
    if (out == nullptr || n <= 0 || b >= e || e > s.size()) return false;
    if (s[b] != '[' || s[e - 1] != ']') return false;
    size_t p = b + 1;
    for (int i = 0; i < n; ++i) {
        while (p < e && ((unsigned char)s[p] <= ' ' || s[p] == ',')) ++p;
        size_t vEnd = p;
        if (!skipValue(s, vEnd)) return false;
        if (vEnd > e - 1) return false;
        if (!spanNumber(s, p, vEnd, &out[i])) return false;
        p = vEnd;
    }
    // Exactly `n`: a five-element array where four were expected is a writer
    // this reader does not understand, not a four-element array with a
    // spare.
    while (p < e - 1 && (unsigned char)s[p] <= ' ') ++p;
    return p == e - 1;
}

bool cameraTimestampSource(const std::string& deviceJson, std::string* out) {
    if (out == nullptr) return false;
    size_t b = 0, e = 0;
    if (!memberSpan(deviceJson, "clocks", &b, &e)) return false;
    if (b >= e || deviceJson[b] != '{') return false;
    const std::string clocks = deviceJson.substr(b, e - b);
    size_t vb = 0, ve = 0;
    if (!memberSpan(clocks, "cameraTimestampSource", &vb, &ve)) return false;
    if (ve - vb < 2 || clocks[vb] != '"' || clocks[ve - 1] != '"') return false;
    out->assign(clocks, vb + 1, (ve - 1) - (vb + 1));
    return true;
}

}  // namespace detail

namespace {

/// The shared body of both readers: walk the lines, apply a per-row filter,
/// pull `tS`/`tsNs` and the named quaternion field, and enforce the three
/// refusals (non-unit, out-of-order, malformed).
template <typename RowFilter>
SeriesParse parseSeries(const std::string& text,
                        const char* quatField,
                        RowFilter accept) {
    SeriesParse out;
    size_t i = 0;
    const size_t n = text.size();
    bool done = false;
    while (!done) {
        size_t j = i;
        while (j < n && text[j] != '\n') ++j;
        std::string line = text.substr(i, j - i);
        done = (j >= n);
        i = j + 1;

        // Trim: a CRLF pack (pulled through a Windows host, or a log copied
        // via a text-mode transfer) must not turn every row into a malformed
        // one.
        while (!line.empty() && (unsigned char)line[line.size() - 1] <= ' ') {
            line.erase(line.size() - 1);
        }
        size_t lead = 0;
        while (lead < line.size() && (unsigned char)line[lead] <= ' ') ++lead;
        if (lead > 0) line = line.substr(lead);
        if (line.empty()) continue;

        out.linesTotal++;

        if (!accept(line)) { out.rowsWrongType++; continue; }

        size_t b = 0, e = 0;
        double tS = 0.0;
        bool haveT = false;
        if (detail::memberSpan(line, "tS", &b, &e) &&
            detail::spanNumber(line, b, e, &tS)) {
            haveT = true;
        } else if (detail::memberSpan(line, "tsNs", &b, &e) &&
                   detail::spanNumber(line, b, e, &tS)) {
            tS /= 1e9;
            haveT = true;
        }

        double q[4] = {0, 0, 0, 1};
        const bool haveQ = detail::memberSpan(line, quatField, &b, &e) &&
            detail::spanNumberArray(line, b, e, q, 4);

        if (!haveT || !haveQ) { out.rowsMalformed++; continue; }

        const double norm = std::sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
        if (!std::isfinite(norm) || std::fabs(norm - 1.0) > kQuatNormTolerance) {
            out.rowsNonUnitQuat++;
            continue;
        }

        // STRICTLY increasing. Equal timestamps are dropped too: the aligner
        // brackets by time, and a duplicated instant makes the bracket search
        // ill-defined rather than merely redundant.
        if (!out.samples.empty() && tS <= out.samples.back().tS) {
            out.rowsOutOfOrder++;
            continue;
        }

        AttitudeSample s;
        s.tS = tS;
        for (int k = 0; k < 4; ++k) s.q[k] = q[k];
        out.samples.push_back(s);
        out.rowsAccepted++;
    }

    if (!out.samples.empty()) {
        out.firstTS = out.samples.front().tS;
        out.lastTS = out.samples.back().tS;
        const double span = out.lastTS - out.firstTS;
        if (out.samples.size() > 1 && span > 0.0) {
            out.hz = (double)(out.samples.size() - 1) / span;
        }
    }
    return out;
}

void appendSeriesJson(std::string& s, const char* name, const SeriesParse& p) {
    s += '"'; s += name; s += "\":{";
    s += "\"accepted\":";        appendInt(s, p.rowsAccepted);
    s += ",\"linesTotal\":";     appendInt(s, p.linesTotal);
    s += ",\"wrongType\":";      appendInt(s, p.rowsWrongType);
    s += ",\"malformed\":";      appendInt(s, p.rowsMalformed);
    s += ",\"nonUnitQuat\":";    appendInt(s, p.rowsNonUnitQuat);
    s += ",\"outOfOrder\":";     appendInt(s, p.rowsOutOfOrder);
    s += ",\"firstTS\":";        appendNum(s, p.firstTS);
    s += ",\"lastTS\":";         appendNum(s, p.lastTS);
    s += ",\"spanS\":";          appendNum(s, p.lastTS - p.firstTS);
    s += ",\"hz\":";             appendNum(s, p.hz);
    s += '}';
}

void appendExcitationJson(std::string& s, const char* name, const AxisExcitation& e) {
    s += '"'; s += name; s += "\":{";
    s += "\"ok\":";               s += (e.ok ? "true" : "false");
    s += ",\"steps\":";           appendInt(s, e.steps);
    s += ",\"stepsBelowFloor\":"; appendInt(s, e.stepsBelowFloor);
    s += ",\"sweptDeg\":";        appendNum(s, e.sweptDeg);
    s += ",\"spanDeg\":";         appendNum(s, e.spanDeg);
    s += ",\"perAxisDeg\":[";     appendNum(s, e.perAxisDeg[0]);
    s += ',';                     appendNum(s, e.perAxisDeg[1]);
    s += ',';                     appendNum(s, e.perAxisDeg[2]);
    s += "],\"eig\":[";           appendNum(s, e.eig[0]);
    s += ',';                     appendNum(s, e.eig[1]);
    s += ',';                     appendNum(s, e.eig[2]);
    s += "],\"rank2\":";          appendNum(s, e.rank2);
    s += ",\"rank3\":";           appendNum(s, e.rank3);
    s += '}';
}

void appendFitJson(std::string& s, const BasisFit& f) {
    s += "{\"index\":";            appendInt(s, f.index);
    s += ",\"label\":";            appendJsonString(s, f.label);
    s += ",\"pairs\":";            appendInt(s, f.pairs);
    s += ",\"rmsDeg\":";           appendNum(s, f.rmsDeg);
    s += ",\"maxDeg\":";           appendNum(s, f.maxDeg);
    s += ",\"finalDeg\":";         appendNum(s, f.finalDeg);
    s += ",\"driftDegPerS\":";     appendNum(s, f.driftDegPerS);
    s += ",\"rmsDetrendedDeg\":";  appendNum(s, f.rmsDetrendedDeg);
    s += '}';
}

}  // namespace

SeriesParse parseSensorsJsonl(const std::string& text, const char* type) {
    const char* want = (type != nullptr && type[0] != '\0') ? type : "rotation-vector";
    return parseSeries(text, "q", [want](const std::string& line) -> bool {
        size_t b = 0, e = 0;
        if (!detail::memberSpan(line, "type", &b, &e)) return false;
        return detail::spanStringEquals(line, b, e, want);
    });
}

SeriesParse parseArCoreJsonl(const std::string& text, const char* field) {
    const char* want = (field != nullptr && field[0] != '\0') ? field : "q";
    return parseSeries(text, want, [](const std::string& line) -> bool {
        size_t b = 0, e = 0;
        if (!detail::memberSpan(line, "kind", &b, &e)) return false;
        if (!detail::spanStringEquals(line, b, e, "arcore-frame")) return false;
        // A pose carried while ARCore was not tracking is not a measurement of
        // where the phone was pointing; letting one in would put a step
        // discontinuity into the reference series.
        if (!detail::memberSpan(line, "trackingState", &b, &e)) return false;
        return detail::spanStringEquals(line, b, e, "TRACKING");
    });
}

S1Report runS1(const SeriesParse& imu, const SeriesParse& ref, const S1Request& req) {
    S1Report r;
    r.imu = imu;
    r.ref = ref;
    r.tauS = req.tauS;

    if (imu.samples.empty()) { r.reason = "no-imu-samples"; return r; }
    if (ref.samples.empty()) { r.reason = "no-reference-samples"; return r; }

    r.refExcitation = excitation(ref.samples);
    r.imuExcitation = excitation(imu.samples);
    r.refExcitationVerdict = gradeExcitation(r.refExcitation, req.excitation);

    r.selection = selectBasis(imu.samples, ref.samples, req.tauS);

    r.verdict = gradeBasis(r.selection, r.refExcitation, req.excitation, req.basis);

    // `gradeBasis` converts the drift into canvas pixels using DriftVerdict's
    // own defaults — it has no parameter for a caller's sweep length. Re-doing
    // the conversion here is the only way to honour a real sweep duration, and
    // it must mirror gradeBasis's arithmetic EXACTLY (`fabs`, then `<=`) or the
    // same drift would read within-budget on one path and over on the other.
    if (r.verdict.drift.measured &&
        std::isfinite(req.sweepSeconds) && std::isfinite(req.canvasPxPerDeg)) {
        r.verdict.drift.sweepSeconds = req.sweepSeconds;
        r.verdict.drift.canvasPxPerDeg = req.canvasPxPerDeg;
        r.verdict.drift.canvasPxOverSweep =
            r.verdict.drift.degPerS * req.sweepSeconds * req.canvasPxPerDeg;
        r.verdict.drift.withinBudget =
            std::fabs(r.verdict.drift.canvasPxOverSweep) <= r.verdict.drift.budgetPx;
    }

    if (!req.tauCandidatesS.empty()) {
        r.stabilityRun = true;
        r.stability = basisStability(imu.samples, ref.samples, req.tauCandidatesS);
    }

    // ── The falsification ────────────────────────────────────────────────
    // Compared ONLY against a winner the selection itself calls unique. A
    // 4-way tie's ranked[0] is an arbitrary member of the tie, and comparing
    // the derivation against it would report "agree" or "disagree" about a
    // number the measurement never established.
    if (req.derivedBasisIndex < 0) {
        r.agreementWithheld = "no-derived-index-supplied";
    } else if (r.selection.ranked.empty()) {
        r.agreementWithheld = "no-measured-winner";
    } else if (!r.selection.unique) {
        r.agreementWithheld = "measured-winner-not-unique";
    } else {
        r.haveAgreement = true;
        r.agreement = compareDerivedWithReference(req.derivedBasisIndex,
                                                  r.selection.ranked[0].index);
    }

    r.ok = r.verdict.ok;
    r.reason = r.verdict.reason;
    return r;
}

std::string s1ReportToJson(const S1Report& r) {
    std::string s;
    s.reserve(4096);
    s += '{';
    s += "\"ok\":";       s += (r.ok ? "true" : "false");
    s += ",\"reason\":";  appendJsonString(s, r.reason);
    s += ",\"tauS\":";    appendNum(s, r.tauS);

    s += ",\"series\":{";
    appendSeriesJson(s, "imu", r.imu);
    s += ',';
    appendSeriesJson(s, "reference", r.ref);
    s += '}';

    s += ",\"excitation\":{";
    appendExcitationJson(s, "reference", r.refExcitation);
    s += ',';
    appendExcitationJson(s, "imu", r.imuExcitation);
    s += ",\"imuAxisNamesNote\":";
    appendJsonString(s,
        "excitation.imu.perAxisDeg is in the DEVICE frame, whose axis NAMES are "
        "exactly what C has not been solved for — do not coach from it. Only eig / "
        "rank2 / rank3 are frame-invariant and therefore comparable with the "
        "reference's.");
    s += ",\"verdict\":{";
    s += "\"sufficient\":";  s += (r.refExcitationVerdict.sufficient ? "true" : "false");
    s += ",\"reason\":";     appendJsonString(s, r.refExcitationVerdict.reason);
    s += ",\"exercisedAxes\":"; appendInt(s, r.refExcitationVerdict.exercisedAxes);
    s += ",\"progress\":";   appendNum(s, r.refExcitationVerdict.progress);
    s += ",\"needMore\":[";
    for (int i = 0; i < 3; ++i) {
        if (i) s += ',';
        s += '{';
        s += "\"axis\":";  appendJsonString(s, axisName(i));
        s += ",\"needMore\":"; s += (r.refExcitationVerdict.needMore[i] ? "true" : "false");
        s += ",\"deg\":";  appendNum(s, r.refExcitation.perAxisDeg[i]);
        s += '}';
    }
    s += "]}";
    s += '}';

    s += ",\"selection\":{";
    s += "\"refusal\":";    appendJsonString(s, r.selection.refusal);
    s += ",\"unique\":";    s += (r.selection.unique ? "true" : "false");
    s += ",\"marginDeg\":"; appendNum(s, r.selection.marginDeg);
    s += ",\"candidates\":"; appendInt(s, (long long)r.selection.ranked.size());
    s += ",\"ranked\":[";
    // TOP FIVE, not all 24. The tie that matters is 4-way, so five rows always
    // contain the whole of it plus the first candidate outside it — and a
    // 24-row array in a panel is unreadable.
    const size_t cap = r.selection.ranked.size() < 5 ? r.selection.ranked.size() : 5;
    for (size_t i = 0; i < cap; ++i) {
        if (i) s += ',';
        appendFitJson(s, r.selection.ranked[i]);
    }
    s += "]}";

    s += ",\"basisVerdict\":{";
    s += "\"ok\":";              s += (r.verdict.ok ? "true" : "false");
    s += ",\"reason\":";         appendJsonString(s, r.verdict.reason);
    s += ",\"index\":";          appendInt(s, r.verdict.index);
    s += ",\"label\":";          appendJsonString(s, r.verdict.label);
    s += ",\"pairs\":";          appendInt(s, r.verdict.pairs);
    s += ",\"rmsDeg\":";         appendNum(s, r.verdict.rmsDeg);
    s += ",\"maxDeg\":";         appendNum(s, r.verdict.maxDeg);
    s += ",\"marginDeg\":";      appendNum(s, r.verdict.marginDeg);
    s += ",\"unique\":";         s += (r.verdict.unique ? "true" : "false");
    s += ",\"runnerUpIndex\":";  appendInt(s, r.verdict.runnerUpIndex);
    s += ",\"runnerUpLabel\":";  appendJsonString(s, r.verdict.runnerUpLabel);
    s += ",\"runnerUpRmsDeg\":"; appendNum(s, r.verdict.runnerUpRmsDeg);
    s += ",\"drift\":{";
    s += "\"measured\":";           s += (r.verdict.drift.measured ? "true" : "false");
    s += ",\"degPerS\":";           appendNum(s, r.verdict.drift.degPerS);
    s += ",\"sweepSeconds\":";      appendNum(s, r.verdict.drift.sweepSeconds);
    s += ",\"canvasPxPerDeg\":";    appendNum(s, r.verdict.drift.canvasPxPerDeg);
    s += ",\"canvasPxOverSweep\":"; appendNum(s, r.verdict.drift.canvasPxOverSweep);
    s += ",\"budgetPx\":";          appendNum(s, r.verdict.drift.budgetPx);
    s += ",\"withinBudget\":";      s += (r.verdict.drift.withinBudget ? "true" : "false");
    s += ",\"rmsDetrendedDeg\":";   appendNum(s, r.verdict.drift.rmsDetrendedDeg);
    s += ",\"biasedHigh\":";        s += (r.verdict.drift.biasedHigh ? "true" : "false");
    s += ",\"note\":";
    appendJsonString(s,
        "driftDegPerS is fitted to |residual| through the origin, so zero-mean "
        "noise produces a positive slope: read it as an upper bound, with "
        "rmsDetrendedDeg beside it saying whether the residual really is a ramp. "
        "The drift NEVER gates persisting the index — a drifting gyro does not "
        "make a different signed permutation correct.");
    s += "}}";

    s += ",\"stability\":{";
    s += "\"run\":";               s += (r.stabilityRun ? "true" : "false");
    s += ",\"ok\":";               s += (r.stability.ok ? "true" : "false");
    s += ",\"reason\":";           appendJsonString(s, r.stability.reason);
    s += ",\"triedOffsets\":";     appendInt(s, r.stability.triedOffsets);
    s += ",\"agreeingOffsets\":";  appendInt(s, r.stability.agreeingOffsets);
    s += ",\"winnerStable\":";     s += (r.stability.winnerStable ? "true" : "false");
    s += ",\"winnerIndex\":";      appendInt(s, r.stability.winnerIndex);
    s += ",\"minMarginDeg\":";     appendNum(s, r.stability.minMarginDeg);
    s += '}';

    s += ",\"agreement\":{";
    s += "\"compared\":";  s += (r.haveAgreement ? "true" : "false");
    s += ",\"withheld\":"; appendJsonString(s, r.agreementWithheld);
    if (r.haveAgreement) {
        s += ",\"comparable\":";       s += (r.agreement.comparable ? "true" : "false");
        s += ",\"agree\":";            s += (r.agreement.agree ? "true" : "false");
        s += ",\"derivedIndex\":";     appendInt(s, r.agreement.derivedIndex);
        s += ",\"derivedLabel\":";     appendJsonString(s, r.agreement.derivedLabel);
        s += ",\"measuredIndex\":";    appendInt(s, r.agreement.referenceIndex);
        s += ",\"measuredLabel\":";    appendJsonString(s, r.agreement.referenceLabel);
        s += ",\"relativeAngleDeg\":"; appendNum(s, r.agreement.relativeAngleDeg);
        s += ",\"relativeAxis\":[";    appendNum(s, r.agreement.relativeAxis[0]);
        s += ',';                      appendNum(s, r.agreement.relativeAxis[1]);
        s += ',';                      appendNum(s, r.agreement.relativeAxis[2]);
        s += ']';
        s += ",\"aboutOpticalAxis\":"; s += (r.agreement.aboutOpticalAxis ? "true" : "false");
        s += ",\"diagnosis\":";        appendJsonString(s, r.agreement.diagnosis);
    }
    s += ",\"note\":";
    appendJsonString(s,
        "The MEASURED index wins when the two disagree: the derivation is "
        "arithmetic on SENSOR_ORIENTATION and cannot see what the recorder did to "
        "the buffer, while the measurement is against a live reference over the "
        "same motion. A comparison is made only against a winner selectBasis "
        "itself calls unique.");
    s += '}';

    s += '}';
    return s;
}

// ════════════════════════════════════════════════════════════════════════
//  Reading the two ledgers off disk
// ════════════════════════════════════════════════════════════════════════

namespace {

// POSIX <sys/stat.h> and <cstdio>, deliberately NOT <filesystem> — the same
// rule rnis_pano_replay.cpp states and for the same reason: libc++'s
// filesystem archive availability has moved across NDK releases and minSdk
// levels, and this translation unit compiles under the NDK.

bool isDirPath(const std::string& p) {
    if (p.empty()) return false;
    struct stat st;
    if (::stat(p.c_str(), &st) != 0) return false;
    return (st.st_mode & S_IFMT) == S_IFDIR;
}

std::string joinPath(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    if (!a.empty() && a[a.size() - 1] == '/') return a + b;
    return a + "/" + b;
}

/// Read a whole file.  False when it does not exist or cannot be opened —
/// the two are NOT distinguished here on purpose: the caller reports
/// "not found", and a permissions failure that read as "found but empty"
/// would produce a zero-sample series that looks like a sweep with no motion.
bool readWholeFile(const std::string& path, std::string* out) {
    if (out == nullptr) return false;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) return false;
    out->clear();
    char buf[64 * 1024];
    for (;;) {
        const size_t n = std::fread(buf, 1, sizeof(buf), f);
        if (n > 0) out->append(buf, n);
        if (n < sizeof(buf)) break;
    }
    const bool bad = (std::ferror(f) != 0);
    std::fclose(f);
    return !bad;
}

/// Strip a trailing slash and a `file://` scheme, then resolve the pack root
/// vs its `panoplus/` subdirectory.
///
/// BOTH are accepted because the two callers disagree: `stopRecording()`
/// reports `…/panoplus`, while an operator typing a path from the panel's
/// own "adb pull" line types the session root. Guessing wrong would report
/// "no pack here" for a pack that is right there.
std::string resolvePanoplusDir(const std::string& raw) {
    std::string p = raw;
    if (p.rfind("file://", 0) == 0) p = p.substr(7);
    while (p.size() > 1 && p[p.size() - 1] == '/') p.erase(p.size() - 1);
    if (p.empty()) return p;
    const std::string nested = joinPath(p, "panoplus");
    if (isDirPath(nested)) return nested;
    return p;
}

}  // namespace

S1PackResult runS1OnPack(const S1PackRequest& req) {
    S1PackResult out;
    if (req.packDir.empty()) { out.reason = "no-pack-dir"; return out; }

    out.panoplusDir = resolvePanoplusDir(req.packDir);
    out.sensorsPath = joinPath(out.panoplusDir, "sensors.jsonl");
    out.arcorePath = joinPath(out.panoplusDir, "attitude_arcore.jsonl");
    out.deviceJsonPath = joinPath(out.panoplusDir, "device.json");

    std::string sensorsText;
    std::string arcoreText;
    out.sensorsFound = readWholeFile(out.sensorsPath, &sensorsText);
    out.arcoreFound = readWholeFile(out.arcorePath, &arcoreText);

    // ── THE CLOCK, READ BEFORE ANY REFUSAL ──────────────────────────────
    // Read even on the paths that return early: "which clock was this camera
    // on" is a fact about the pack, not about whether the fit succeeded, and a
    // reader diagnosing a `no-reference-samples` pack wants it too.
    {
        std::string deviceText;
        out.deviceJsonFound = readWholeFile(out.deviceJsonPath, &deviceText);
        if (out.deviceJsonFound) {
            std::string src;
            if (detail::cameraTimestampSource(deviceText, &src)) {
                out.cameraTimestampSource = src;
            }
        }
        // τ ≠ 0 is the caller taking the decision themselves, so the REALTIME
        // check is not what justified it and the pack must not read as if it
        // had passed.
        if (req.run.tauS != 0.0) {
            out.clockAssumption = "caller-supplied-tau";
        } else if (out.cameraTimestampSource == "REALTIME") {
            out.clockAssumption = "confirmed-realtime";
        } else if (!out.cameraTimestampSource.empty()) {
            out.clockAssumption = "not-realtime";
        } else {
            out.clockAssumption = "unconfirmed";
        }
    }

    if (!out.sensorsFound) { out.reason = "sensors-jsonl-missing"; return out; }
    if (!out.arcoreFound) {
        // The COMMON case: the ARCore reference channel is off by default, so
        // most packs have no reference series at all. That is a pack without a
        // measurement, not a failed measurement, and the two must not collapse
        // into one word — the whole port would then read as broken.
        out.reason = "arcore-jsonl-missing";
        // The IMU side is still parsed, so the panel can say how many
        // rotation-vector rows the pack DOES have.
        out.report.imu = parseSensorsJsonl(sensorsText, req.imuType.c_str());
        return out;
    }

    const SeriesParse imu = parseSensorsJsonl(sensorsText, req.imuType.c_str());
    const SeriesParse ref = parseArCoreJsonl(arcoreText, req.refField.c_str());
    out.report = runS1(imu, ref, req.run);
    out.ok = out.report.ok;
    out.reason = out.report.reason;
    return out;
}

std::string s1PackResultToJson(const S1PackResult& r) {
    std::string s;
    s.reserve(4096);
    s += '{';
    s += "\"ok\":";           s += (r.ok ? "true" : "false");
    s += ",\"reason\":";      appendJsonString(s, r.reason);
    s += ",\"panoplusDir\":"; appendJsonString(s, r.panoplusDir.c_str());
    s += ",\"sensorsPath\":"; appendJsonString(s, r.sensorsPath.c_str());
    s += ",\"arcorePath\":";  appendJsonString(s, r.arcorePath.c_str());
    s += ",\"deviceJsonPath\":"; appendJsonString(s, r.deviceJsonPath.c_str());
    s += ",\"sensorsFound\":"; s += (r.sensorsFound ? "true" : "false");
    s += ",\"arcoreFound\":";  s += (r.arcoreFound ? "true" : "false");
    s += ",\"deviceJsonFound\":"; s += (r.deviceJsonFound ? "true" : "false");
    // ── THE CLOCK THE FIT WAS MADE UNDER ────────────────────────────────
    // Empty string, never a substituted "REALTIME": an unread source and a read
    // REALTIME are different facts and this whole block exists so a reader can
    // tell them apart.
    s += ",\"cameraTimestampSource\":";
    appendJsonString(s, r.cameraTimestampSource.c_str());
    s += ",\"clockAssumption\":"; appendJsonString(s, r.clockAssumption);
    s += ",\"clockNote\":";
    appendJsonString(s,
        "This run joins sensors.jsonl (SensorEvent.timestamp) to "
        "attitude_arcore.jsonl (ARCore's frame timestamp, the Camera2 "
        "SENSOR_TIMESTAMP domain) at report.tauS, which is 0 unless a caller "
        "supplied one. Zero is correct ONLY when the camera is on the "
        "elapsedRealtime clock, i.e. SENSOR_INFO_TIMESTAMP_SOURCE is REALTIME "
        "(device.json -> clocks.cameraTimestampSource, read above rather than "
        "assumed). UNKNOWN means the boot/uptime clock, which STOPS in suspend: "
        "the two series are then offset by the accumulated suspend time, which "
        "is small enough to fit and far outside the +-10ms basisStability "
        "sweep, so a stable unique winner would be reported for a fit made "
        "across two epochs. clockAssumption:'not-realtime' or 'unconfirmed' "
        "does NOT invalidate the winner below — it says the winner has not been "
        "shown to come from a same-clock fit, so the measured-beats-derived "
        "rule must not be applied on it alone.");
    s += ",\"report\":";
    s += s1ReportToJson(r.report);
    s += '}';
    return s;
}

}  // namespace android
}  // namespace pano
}  // namespace rnis
