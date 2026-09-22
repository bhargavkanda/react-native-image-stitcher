// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_replay.cpp — see the header for what this is and what it refuses
// to pretend to do.
//
// ── DEPENDENCY DISCIPLINE ───────────────────────────────────────────────────
// C++17 STL + OpenCV core/imgproc/imgcodecs + POSIX <sys/stat.h>/<stdlib.h>,
// and NOTHING else.  That is the exact set the engine itself compiles against
// on both legs, which is what lets the Mac host build and the NDK arm64 build
// share this translation unit byte for byte.
//
// POSIX rather than <filesystem> is deliberate: libc++'s filesystem is a
// separate archive whose availability has moved around across NDK releases and
// minSdk levels, and this file needs exactly three operations — does a path
// exist, make a directory, canonicalise a path — all of which `<sys/stat.h>`
// and `realpath` give unconditionally on both targets.  Nothing here is Apple-
// or Android-specific.
//
// ── NO JSON LIBRARY ─────────────────────────────────────────────────────────
// The engine's dependency set has none, and adding one for the replay driver
// would mean the Android build pulls a dependency the shipped engine does not.
// The pack's writers hand-roll JSON OUT (RNISPanoCore.mm's appendNum /
// appendInt / appendExact); this hand-rolls it IN.  The scanner below is a
// complete JSON value scanner rather than a line-grepper, because `meta.json`
// is pretty-printed and nested and a grepper would silently read the `pack`
// sub-object's `canvasQuality` as a top-level knob.

#include "rnis_pano_replay.hpp"

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <sys/stat.h>
#include <stdlib.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace rnis {
namespace pano {
namespace replay {

namespace {

// ── mini JSON ───────────────────────────────────────────────────────────────
namespace mj {

enum class Kind { Invalid, Null, Bool, Number, String, Array, Object };

struct Span {
    Kind kind = Kind::Invalid;
    size_t b = 0, e = 0;   // [b, e) over the source text
};

inline bool isWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

inline void skipWs(const std::string& s, size_t& p) {
    while (p < s.size() && isWs(s[p])) ++p;
}

// p must sit on the opening quote; leaves p one past the closing quote.
bool scanStringRaw(const std::string& s, size_t& p) {
    if (p >= s.size() || s[p] != '"') return false;
    ++p;
    while (p < s.size()) {
        const char c = s[p];
        if (c == '\\') {
            // A trailing backslash must not walk the cursor off the end.
            if (p + 1 >= s.size()) return false;
            p += 2;
            continue;
        }
        if (c == '"') { ++p; return true; }
        ++p;
    }
    return false;
}

// DEPTH IS BOUNDED.  A pack is written by our own code, but a replay driver
// that segfaults on a truncated or hostile file reports nothing at all, and
// "the pack was corrupt" is a finding the report has to be alive to make.
const int kMaxDepth = 64;

bool scanValue(const std::string& s, size_t& p, Span& out, int depth) {
    if (depth > kMaxDepth) return false;
    skipWs(s, p);
    if (p >= s.size()) return false;
    const size_t b = p;
    const char c = s[p];

    if (c == '{' || c == '[') {
        const bool obj = (c == '{');
        const char close = obj ? '}' : ']';
        ++p;
        skipWs(s, p);
        if (p < s.size() && s[p] == close) {
            ++p;
            out.kind = obj ? Kind::Object : Kind::Array;
            out.b = b; out.e = p;
            return true;
        }
        for (;;) {
            skipWs(s, p);
            if (obj) {
                if (!scanStringRaw(s, p)) return false;
                skipWs(s, p);
                if (p >= s.size() || s[p] != ':') return false;
                ++p;
            }
            Span tmp;
            if (!scanValue(s, p, tmp, depth + 1)) return false;
            skipWs(s, p);
            if (p >= s.size()) return false;
            if (s[p] == ',') { ++p; continue; }
            if (s[p] == close) { ++p; break; }
            return false;
        }
        out.kind = obj ? Kind::Object : Kind::Array;
        out.b = b; out.e = p;
        return true;
    }

    if (c == '"') {
        if (!scanStringRaw(s, p)) return false;
        out.kind = Kind::String;
        out.b = b; out.e = p;
        return true;
    }

    if (s.compare(p, 4, "true") == 0)  { p += 4; out = {Kind::Bool, b, p}; return true; }
    if (s.compare(p, 5, "false") == 0) { p += 5; out = {Kind::Bool, b, p}; return true; }
    if (s.compare(p, 4, "null") == 0)  { p += 4; out = {Kind::Null, b, p}; return true; }

    // Number.  Character-class scan then strtod, so "-" or "1e" is rejected by
    // the same authority that will later read the value.
    while (p < s.size()) {
        const char d = s[p];
        const bool numish = (d >= '0' && d <= '9') || d == '-' || d == '+' ||
                            d == '.' || d == 'e' || d == 'E';
        if (!numish) break;
        ++p;
    }
    if (p == b) return false;
    {
        const std::string num = s.substr(b, p - b);
        char* endp = nullptr;
        const double v = std::strtod(num.c_str(), &endp);
        (void)v;
        if (endp == nullptr || *endp != '\0') return false;
    }
    out = {Kind::Number, b, p};
    return true;
}

std::string decodeString(const std::string& s, const Span& sp) {
    std::string out;
    if (sp.kind != Kind::String || sp.e <= sp.b + 1) return out;
    size_t p = sp.b + 1;
    const size_t end = sp.e - 1;
    out.reserve(end - p);
    while (p < end) {
        const char c = s[p];
        if (c != '\\') { out += c; ++p; continue; }
        if (p + 1 >= end) break;
        const char esc = s[p + 1];
        p += 2;
        switch (esc) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case '"': out += '"';  break;
            case '\\': out += '\\'; break;
            case '/': out += '/';  break;
            case 'u': {
                // The pack writers never emit \u, so a faithful UTF-16
                // decoder here would be untested code guarding nothing.  The
                // escape is CONSUMED (so the string stays in sync) and
                // replaced with '?' rather than silently dropped.
                if (p + 4 <= end) p += 4;
                out += '?';
                break;
            }
            default: out += esc; break;
        }
    }
    return out;
}

double asNumber(const std::string& s, const Span& sp, bool* ok) {
    if (ok) *ok = false;
    if (sp.kind == Kind::Bool) {
        if (ok) *ok = true;
        return (s[sp.b] == 't') ? 1.0 : 0.0;
    }
    if (sp.kind != Kind::Number) return 0.0;
    const std::string num = s.substr(sp.b, sp.e - sp.b);
    char* endp = nullptr;
    const double v = std::strtod(num.c_str(), &endp);
    if (endp == nullptr || *endp != '\0') return 0.0;
    if (ok) *ok = true;
    return v;
}

/// Find `key` among the members of the object at `objSpan`.  Returns false
/// when the object is malformed or the key is absent — the caller cannot tell
/// those apart, and deliberately: both mean "this knob was not read".
bool member(const std::string& s, const Span& objSpan, const char* key, Span* out) {
    if (objSpan.kind != Kind::Object) return false;
    size_t p = objSpan.b + 1;
    skipWs(s, p);
    if (p < s.size() && s[p] == '}') return false;
    for (;;) {
        skipWs(s, p);
        const size_t kb = p;
        if (!scanStringRaw(s, p)) return false;
        Span kspan{Kind::String, kb, p};
        skipWs(s, p);
        if (p >= s.size() || s[p] != ':') return false;
        ++p;
        Span vspan;
        if (!scanValue(s, p, vspan, 0)) return false;
        if (decodeString(s, kspan) == key) { *out = vspan; return true; }
        skipWs(s, p);
        if (p < s.size() && s[p] == ',') { ++p; continue; }
        return false;
    }
}

bool elements(const std::string& s, const Span& arrSpan, std::vector<Span>* out) {
    out->clear();
    if (arrSpan.kind != Kind::Array) return false;
    size_t p = arrSpan.b + 1;
    skipWs(s, p);
    if (p < s.size() && s[p] == ']') return true;
    for (;;) {
        Span v;
        if (!scanValue(s, p, v, 0)) return false;
        out->push_back(v);
        skipWs(s, p);
        if (p < s.size() && s[p] == ',') { ++p; continue; }
        return true;
    }
}

/// Parse a whole document into its root span.  Trailing whitespace is allowed;
/// trailing GARBAGE is not (that is how a half-written file is caught).
bool parseDocument(const std::string& s, Span* root) {
    size_t p = 0;
    if (!scanValue(s, p, *root, 0)) return false;
    skipWs(s, p);
    return p == s.size();
}

}  // namespace mj

// ── filesystem, POSIX-only ──────────────────────────────────────────────────

/// Why a `stat` did not answer "yes".
///
/// A bare `stat(...) == 0` collapses "it is not there" and "this process may
/// not look" into the same verdict, and on Android those are the two commonest
/// outcomes for a pack that arrived by `adb push`: an app can read only inside
/// its own files directory, so a pack sitting in /sdcard/Download stats as
/// EACCES and the driver used to report `no track.jsonl at <the exact path the
/// operator can see the file at>` — a message that sends him looking for a file
/// that is demonstrably there.  A search-permission failure on a PARENT
/// directory surfaces here too (that is how a 0700 dir owned by another uid
/// reads), which is precisely the adb case.
enum class StatWhy { Ok, Absent, Denied, Other };

StatWhy statPath(const std::string& p, struct stat* st) {
    if (p.empty()) return StatWhy::Absent;
    errno = 0;
    if (::stat(p.c_str(), st) == 0) return StatWhy::Ok;
    switch (errno) {
        case ENOENT:
        case ENOTDIR:  // a path component that is a file, not a directory
            return StatWhy::Absent;
        case EACCES:
        case EPERM:
            return StatWhy::Denied;
        default:
            return StatWhy::Other;
    }
}

/// The remedy, named rather than left to be worked out on a phone in an aisle.
/// The package is not knowable from here, so it is spelled as a placeholder the
/// operator substitutes — the shape of the command is the part that is hard to
/// remember.
const char* kDeniedRemedy =
    " — this is a PERMISSION failure, not a missing file: the pack is very "
    "likely there and this process may not read it. An Android app can read "
    "only inside its own files directory, so copy the pack in first, e.g. "
    "`adb shell run-as <your.package> cp -r /sdcard/<pack> files/` (or push it "
    "straight into files/), then replay the copy.";

bool pathExists(const std::string& p) {
    struct stat st;
    return statPath(p, &st) == StatWhy::Ok;
}

bool isDir(const std::string& p) {
    struct stat st;
    return statPath(p, &st) == StatWhy::Ok && S_ISDIR(st.st_mode);
}

std::string joinPath(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    if (!a.empty() && a[a.size() - 1] == '/') return a + b;
    return a + "/" + b;
}

bool readFile(const std::string& path, std::string* out) {
    out->clear();
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) return false;
    char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) out->append(buf, n);
    const bool bad = (std::ferror(f) != 0);
    std::fclose(f);
    if (bad) { out->clear(); return false; }
    return true;
}

bool writeFile(const std::string& path, const std::string& body, std::string* err) {
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (f == nullptr) { if (err) *err = "could not open " + path; return false; }
    const size_t wrote = std::fwrite(body.data(), 1, body.size(), f);
    const bool flushed = (std::fflush(f) == 0);
    const bool closed  = (std::fclose(f) == 0);
    if (wrote != body.size() || !flushed || !closed) {
        if (err) *err = "short write to " + path;
        return false;
    }
    return true;
}

/// mkdir -p.  A directory that already exists is success, which is why EEXIST
/// is not inspected: the only verdict that matters is the stat at the end.
bool ensureDir(const std::string& d) {
    if (d.empty()) return false;
    for (size_t i = 1; i <= d.size(); ++i) {
        if (i != d.size() && d[i] != '/') continue;
        const std::string sub = d.substr(0, i);
        if (sub.empty() || sub == "/") continue;
        ::mkdir(sub.c_str(), 0777);
    }
    return isDir(d);
}

/// realpath when the path exists, a trailing-slash-stripped copy otherwise.
/// Used ONLY for the "is outDir the pack's own directory" guard, where a false
/// negative would let the driver overwrite its own oracle.
std::string canonical(const std::string& p) {
    if (p.empty()) return p;
    char buf[4096];
    if (::realpath(p.c_str(), buf) != nullptr) return std::string(buf);
    std::string s = p;
    while (s.size() > 1 && s[s.size() - 1] == '/') s.erase(s.size() - 1);
    return s;
}

// ── formatting, mirroring the pack writers exactly ──────────────────────────
// Same precisions as RNISPanoCore.mm's appendNum / appendExact / appendInt, so
// a replay ledger and a device ledger are textually comparable rather than
// merely semantically comparable.

void appendNum(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    s += buf;
}

void appendExact(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char buf[48];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    s += buf;
}

void appendInt(std::string& s, long long v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", v);
    s += buf;
}

void appendJsonString(std::string& s, const std::string& v) {
    s += '"';
    for (size_t i = 0; i < v.size(); ++i) {
        const unsigned char c = (unsigned char)v[i];
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
    s += '"';
}

double percentile(std::vector<double> v, double p) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const double idx = p * (double)(v.size() - 1);
    const size_t lo = (size_t)std::floor(idx), hi = (size_t)std::ceil(idx);
    if (lo == hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (idx - (double)lo);
}

double nowMs() {
    using clk = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(clk::now().time_since_epoch()).count();
}

// ── the Config knob table ───────────────────────────────────────────────────
// ONE table drives BOTH the meta.json adoption and the string overrides, so an
// A/B arm can never reach a knob the replay cannot report on, and a knob can
// never be readable from a pack but not forceable (or the reverse).  Names are
// the names panoConfigDict() writes, i.e. the C++ field names.

/// How the knob is SPELLED back out.  A bool written as `1` and an int written
/// as `2048.0` both round-trip through `applyConfigOverride` — but `meta.json`
/// is also read by eye and by the offline harness, and a config block that
/// prints `rectify: 1` beside `rectify: true` from the iOS writer would make
/// two packs look like two engines.
enum class KnobKind : int { Num = 0, Int = 1, Bool = 2 };

/// ONE row per knob carrying BOTH directions.  The getter is what lets a LIVE
/// Android sweep write a `meta.json` whose `config` block this same table can
/// adopt on replay — without it the replay of a live pack silently ran at
/// engine defaults while claiming to reproduce the sweep.
struct KnobNum {
    const char* name;
    void (*set)(Config&, double);
    double (*get)(const Config&);
    KnobKind kind;
};

const KnobNum kKnobs[] = {
    {"canvasScale",          [](Config& c, double v) { c.canvasScale = v; },
     [](const Config& c) -> double { return c.canvasScale; }, KnobKind::Num},
    {"stripMargin",          [](Config& c, double v) { c.stripMargin = v; },
     [](const Config& c) -> double { return c.stripMargin; }, KnobKind::Num},
    {"minAdvancePx",         [](Config& c, double v) { c.minAdvancePx = v; },
     [](const Config& c) -> double { return c.minAdvancePx; }, KnobKind::Num},
    {"maxAdvancePx",         [](Config& c, double v) { c.maxAdvancePx = v; },
     [](const Config& c) -> double { return c.maxAdvancePx; }, KnobKind::Num},
    {"maxAdvanceFrac",       [](Config& c, double v) { c.maxAdvanceFrac = v; },
     [](const Config& c) -> double { return c.maxAdvanceFrac; }, KnobKind::Num},
    {"maxSweepSpeedMps",     [](Config& c, double v) { c.maxSweepSpeedMps = v; },
     [](const Config& c) -> double { return c.maxSweepSpeedMps; }, KnobKind::Num},
    {"poseSlackM",           [](Config& c, double v) { c.poseSlackM = v; },
     [](const Config& c) -> double { return c.poseSlackM; }, KnobKind::Num},
    {"rectify",              [](Config& c, double v) { c.rectify = (v != 0.0); },
     [](const Config& c) -> double { return c.rectify ? 1.0 : 0.0; }, KnobKind::Bool},
    {"gainMatch",            [](Config& c, double v) { c.gainMatch = (v != 0.0); },
     [](const Config& c) -> double { return c.gainMatch ? 1.0 : 0.0; }, KnobKind::Bool},
    {"gainStepClamp",        [](Config& c, double v) { c.gainStepClamp = v; },
     [](const Config& c) -> double { return c.gainStepClamp; }, KnobKind::Num},
    {"gainCumClamp",         [](Config& c, double v) { c.gainCumClamp = v; },
     [](const Config& c) -> double { return c.gainCumClamp; }, KnobKind::Num},
    {"gainSampleMinPx",      [](Config& c, double v) { c.gainSampleMinPx = v; },
     [](const Config& c) -> double { return c.gainSampleMinPx; }, KnobKind::Num},
    {"workScale",            [](Config& c, double v) { c.workScale = v; },
     [](const Config& c) -> double { return c.workScale; }, KnobKind::Num},
    {"corrCentroidBoxPx",    [](Config& c, double v) { c.corrCentroidBoxPx = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.corrCentroidBoxPx; }, KnobKind::Int},
    {"phaseWindowPx",        [](Config& c, double v) { c.phaseWindowPx = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.phaseWindowPx; }, KnobKind::Int},
    {"minPhaseResponse",     [](Config& c, double v) { c.minPhaseResponse = v; },
     [](const Config& c) -> double { return c.minPhaseResponse; }, KnobKind::Num},
    {"stallResumeResponse",  [](Config& c, double v) { c.stallResumeResponse = v; },
     [](const Config& c) -> double { return c.stallResumeResponse; }, KnobKind::Num},
    {"maxRejectRunFrames",   [](Config& c, double v) { c.maxRejectRunFrames = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.maxRejectRunFrames; }, KnobKind::Int},
    {"canvasInitWidthPx",    [](Config& c, double v) { c.canvasInitWidthPx = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.canvasInitWidthPx; }, KnobKind::Int},
    {"canvasMaxWidthPx",     [](Config& c, double v) { c.canvasMaxWidthPx = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.canvasMaxWidthPx; }, KnobKind::Int},
    {"canvasPadPx",          [](Config& c, double v) { c.canvasPadPx = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.canvasPadPx; }, KnobKind::Int},
    {"canvasGrowVertical",   [](Config& c, double v) { c.canvasGrowVertical = (v != 0.0); },
     [](const Config& c) -> double { return c.canvasGrowVertical ? 1.0 : 0.0; }, KnobKind::Bool},
    {"canvasMaxHeightPx",    [](Config& c, double v) { c.canvasMaxHeightPx = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.canvasMaxHeightPx; }, KnobKind::Int},
    {"canvasMaxPixels",      [](Config& c, double v) { c.canvasMaxPixels = v; },
     [](const Config& c) -> double { return c.canvasMaxPixels; }, KnobKind::Num},
    {"backfillGaps",         [](Config& c, double v) { c.backfillGaps = (v != 0.0); },
     [](const Config& c) -> double { return c.backfillGaps ? 1.0 : 0.0; }, KnobKind::Bool},
    {"abortOnLimitedTracking", [](Config& c, double v) { c.abortOnLimitedTracking = (v != 0.0); },
     [](const Config& c) -> double { return c.abortOnLimitedTracking ? 1.0 : 0.0; }, KnobKind::Bool},
    {"trackingWarmupFrames", [](Config& c, double v) { c.trackingWarmupFrames = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.trackingWarmupFrames; }, KnobKind::Int},
    {"cageStallFrames",      [](Config& c, double v) { c.cageStallFrames = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.cageStallFrames; }, KnobKind::Int},
    {"axisLatchFrames",      [](Config& c, double v) { c.axisLatchFrames = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.axisLatchFrames; }, KnobKind::Int},
    {"axisLatchMaxFrames",   [](Config& c, double v) { c.axisLatchMaxFrames = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.axisLatchMaxFrames; }, KnobKind::Int},
    {"latchTotalPx",         [](Config& c, double v) { c.latchTotalPx = v; },
     [](const Config& c) -> double { return c.latchTotalPx; }, KnobKind::Num},
    {"relatchMotionPx",      [](Config& c, double v) { c.relatchMotionPx = v; },
     [](const Config& c) -> double { return c.relatchMotionPx; }, KnobKind::Num},
    {"relatchCommitFrac",    [](Config& c, double v) { c.relatchCommitFrac = v; },
     [](const Config& c) -> double { return c.relatchCommitFrac; }, KnobKind::Num},
    {"relatchDominance",     [](Config& c, double v) { c.relatchDominance = v; },
     [](const Config& c) -> double { return c.relatchDominance; }, KnobKind::Num},
    {"relatchMinFrames",     [](Config& c, double v) { c.relatchMinFrames = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.relatchMinFrames; }, KnobKind::Int},
    {"relatchMaxCount",      [](Config& c, double v) { c.relatchMaxCount = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.relatchMaxCount; }, KnobKind::Int},
    {"maxTranslationJumpM",  [](Config& c, double v) { c.maxTranslationJumpM = v; },
     [](const Config& c) -> double { return c.maxTranslationJumpM; }, KnobKind::Num},
    {"rectifyYawLimitDeg",   [](Config& c, double v) { c.rectifyYawLimitDeg = v; },
     [](const Config& c) -> double { return c.rectifyYawLimitDeg; }, KnobKind::Num},
    {"projection",           [](Config& c, double v) { c.projection = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.projection; }, KnobKind::Int},
    {"sweepMaxDeg",          [](Config& c, double v) { c.sweepMaxDeg = v; },
     [](const Config& c) -> double { return c.sweepMaxDeg; }, KnobKind::Num},
    {"seedArcSlicePx",       [](Config& c, double v) { c.seedArcSlicePx = v; },
     [](const Config& c) -> double { return c.seedArcSlicePx; }, KnobKind::Num},
    {"leadReplace",          [](Config& c, double v) { c.leadReplace = (v != 0.0); },
     [](const Config& c) -> double { return c.leadReplace ? 1.0 : 0.0; }, KnobKind::Bool},
    {"seedFrontierMeet",     [](Config& c, double v) { c.seedFrontierMeet = (v != 0.0); },
     [](const Config& c) -> double { return c.seedFrontierMeet ? 1.0 : 0.0; }, KnobKind::Bool},
    {"seedFrontierMeetPinMeasure",
     [](Config& c, double v) { c.seedFrontierMeetPinMeasure = (v != 0.0); },
     [](const Config& c) -> double { return c.seedFrontierMeetPinMeasure ? 1.0 : 0.0; },
     KnobKind::Bool},
    {"tailArcSlicePx",       [](Config& c, double v) { c.tailArcSlicePx = v; },
     [](const Config& c) -> double { return c.tailArcSlicePx; }, KnobKind::Num},
    {"tailArcMinRotFrac",    [](Config& c, double v) { c.tailArcMinRotFrac = v; },
     [](const Config& c) -> double { return c.tailArcMinRotFrac; }, KnobKind::Num},
    {"crossTraj",            [](Config& c, double v) { c.crossTraj = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.crossTraj; }, KnobKind::Int},
    {"crossTrajWindowPx",    [](Config& c, double v) { c.crossTrajWindowPx = v; },
     [](const Config& c) -> double { return c.crossTrajWindowPx; }, KnobKind::Num},
    {"crossTrajRelaxPx",     [](Config& c, double v) { c.crossTrajRelaxPx = v; },
     [](const Config& c) -> double { return c.crossTrajRelaxPx; }, KnobKind::Num},
    {"crossTrajFan",         [](Config& c, double v) { c.crossTrajFan = (v != 0.0); },
     [](const Config& c) -> double { return c.crossTrajFan ? 1.0 : 0.0; }, KnobKind::Bool},
    {"crossTrajSeed",        [](Config& c, double v) { c.crossTrajSeed = (v != 0.0); },
     [](const Config& c) -> double { return c.crossTrajSeed ? 1.0 : 0.0; }, KnobKind::Bool},
    {"leadOutFromFrontier",  [](Config& c, double v) { c.leadOutFromFrontier = (v != 0.0); },
     [](const Config& c) -> double { return c.leadOutFromFrontier ? 1.0 : 0.0; }, KnobKind::Bool},
    {"leadOutTraj",          [](Config& c, double v) { c.leadOutTraj = (v != 0.0); },
     [](const Config& c) -> double { return c.leadOutTraj ? 1.0 : 0.0; }, KnobKind::Bool},
    {"crossSweepFit",        [](Config& c, double v) { c.crossSweepFit = (v != 0.0); },
     [](const Config& c) -> double { return c.crossSweepFit ? 1.0 : 0.0; }, KnobKind::Bool},
    {"crossFitMode",         [](Config& c, double v) { c.crossFitMode = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.crossFitMode; }, KnobKind::Int},
    {"crossWindows",         [](Config& c, double v) { c.crossWindows = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.crossWindows; }, KnobKind::Int},
    {"crossAvgWindows",      [](Config& c, double v) { c.crossAvgWindows = (v != 0.0); },
     [](const Config& c) -> double { return c.crossAvgWindows ? 1.0 : 0.0; }, KnobKind::Bool},
    {"crossSpanFrac",        [](Config& c, double v) { c.crossSpanFrac = v; },
     [](const Config& c) -> double { return c.crossSpanFrac; }, KnobKind::Num},
    {"crossGradMaxPerFrame", [](Config& c, double v) { c.crossGradMaxPerFrame = v; },
     [](const Config& c) -> double { return c.crossGradMaxPerFrame; }, KnobKind::Num},
    {"crossScaleCageFrac",   [](Config& c, double v) { c.crossScaleCageFrac = v; },
     [](const Config& c) -> double { return c.crossScaleCageFrac; }, KnobKind::Num},
    {"crossScaleLeak",       [](Config& c, double v) { c.crossScaleLeak = v; },
     [](const Config& c) -> double { return c.crossScaleLeak; }, KnobKind::Num},
    {"crossFitDcRemove",     [](Config& c, double v) { c.crossFitDcRemove = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.crossFitDcRemove; }, KnobKind::Int},
    {"crossFitMinBandR2",    [](Config& c, double v) { c.crossFitMinBandR2 = v; },
     [](const Config& c) -> double { return c.crossFitMinBandR2; }, KnobKind::Num},
    {"subjectDistanceM",     [](Config& c, double v) { c.subjectDistanceM = v; },
     [](const Config& c) -> double { return c.subjectDistanceM; }, KnobKind::Num},
    {"subjectDistanceAuto",  [](Config& c, double v) { c.subjectDistanceAuto = (v != 0.0); },
     [](const Config& c) -> double { return c.subjectDistanceAuto ? 1.0 : 0.0; }, KnobKind::Bool},
    {"seamMetrics",          [](Config& c, double v) { c.seamMetrics = (v != 0.0); },
     [](const Config& c) -> double { return c.seamMetrics ? 1.0 : 0.0; }, KnobKind::Bool},
    {"d8JogGuard",           [](Config& c, double v) { c.d8JogGuard = (v != 0.0); },
     [](const Config& c) -> double { return c.d8JogGuard ? 1.0 : 0.0; }, KnobKind::Bool},
    {"d8JogBarPx",           [](Config& c, double v) { c.d8JogBarPx = v; },
     [](const Config& c) -> double { return c.d8JogBarPx; }, KnobKind::Num},
    {"d8JogMaxRun",          [](Config& c, double v) { c.d8JogMaxRun = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.d8JogMaxRun; }, KnobKind::Int},
    // The low-light registration gate (2026-09-07): the mode and
    // its six thresholds, so an A/B arm can force the log-only pass and a
    // pack that ran it replays with the same knobs.
    {"crossResidualGate",    [](Config& c, double v) { c.crossResidualGate = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.crossResidualGate; }, KnobKind::Int},
    {"crossTextureMinVar",   [](Config& c, double v) { c.crossTextureMinVar = v; },
     [](const Config& c) -> double { return c.crossTextureMinVar; }, KnobKind::Num},
    {"crossPeakMinPSR",      [](Config& c, double v) { c.crossPeakMinPSR = v; },
     [](const Config& c) -> double { return c.crossPeakMinPSR; }, KnobKind::Num},
    {"crossPeakMinMass",     [](Config& c, double v) { c.crossPeakMinMass = v; },
     [](const Config& c) -> double { return c.crossPeakMinMass; }, KnobKind::Num},
    {"crossPeriodGuard",     [](Config& c, double v) { c.crossPeriodGuard = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.crossPeriodGuard; }, KnobKind::Int},
    {"crossPeriodMaxFrac",   [](Config& c, double v) { c.crossPeriodMaxFrac = v; },
     [](const Config& c) -> double { return c.crossPeriodMaxFrac; }, KnobKind::Num},
    {"crossPeakSecondaryFrac", [](Config& c, double v) { c.crossPeakSecondaryFrac = v; },
     [](const Config& c) -> double { return c.crossPeakSecondaryFrac; }, KnobKind::Num},
    {"gainLeak",             [](Config& c, double v) { c.gainLeak = v; },
     [](const Config& c) -> double { return c.gainLeak; }, KnobKind::Num},
    {"exposureNormalize",    [](Config& c, double v) { c.exposureNormalize = (v != 0.0); },
     [](const Config& c) -> double { return c.exposureNormalize ? 1.0 : 0.0; }, KnobKind::Bool},
    {"exposureGainClamp",    [](Config& c, double v) { c.exposureGainClamp = v; },
     [](const Config& c) -> double { return c.exposureGainClamp; }, KnobKind::Num},
    {"photoMinSamples",      [](Config& c, double v) { c.photoMinSamples = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.photoMinSamples; }, KnobKind::Int},
    {"photoGradMaxDN",       [](Config& c, double v) { c.photoGradMaxDN = v; },
     [](const Config& c) -> double { return c.photoGradMaxDN; }, KnobKind::Num},
    {"photoUniformMinFrac",  [](Config& c, double v) { c.photoUniformMinFrac = v; },
     [](const Config& c) -> double { return c.photoUniformMinFrac; }, KnobKind::Num},
    {"photoUniformBands",    [](Config& c, double v) { c.photoUniformBands = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.photoUniformBands; }, KnobKind::Int},
    {"photoLocalWindowPx",   [](Config& c, double v) { c.photoLocalWindowPx = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.photoLocalWindowPx; }, KnobKind::Int},
    {"axisOverride",         [](Config& c, double v) { c.axisOverride = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.axisOverride; }, KnobKind::Int},
    {"signOverride",         [](Config& c, double v) { c.signOverride = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.signOverride; }, KnobKind::Int},
    {"cropVertical",         [](Config& c, double v) { c.cropVertical = (v != 0.0); },
     [](const Config& c) -> double { return c.cropVertical ? 1.0 : 0.0; }, KnobKind::Bool},
    // v14 — REPLAYABLE, which is the point: a device pack now records the
    // upright bake it was written with, so `applyMetaConfig` reproduces the
    // device's OWN output frame and the `canvas.outputW/H` comparison below
    // keeps comparing like with like.  A pre-v14 pack has no such key, lands
    // in `defaulted`, and replays at 0 — exactly what produced it.
    {"outputRotationCwDeg",  [](Config& c, double v) { c.outputRotationCwDeg = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.outputRotationCwDeg; }, KnobKind::Int},
    {"lensUndistort",        [](Config& c, double v) { c.lensUndistort = (v != 0.0); },
     [](const Config& c) -> double { return c.lensUndistort ? 1.0 : 0.0; }, KnobKind::Bool},
    {"lensFocalTolFrac",     [](Config& c, double v) { c.lensFocalTolFrac = v; },
     [](const Config& c) -> double { return c.lensFocalTolFrac; }, KnobKind::Num},
    {"lensModelOverride",    [](Config& c, double v) { c.lensModelOverride = (v != 0.0); },
     [](const Config& c) -> double { return c.lensModelOverride ? 1.0 : 0.0; }, KnobKind::Bool},
    {"lensK1",               [](Config& c, double v) { c.lensK1 = v; },
     [](const Config& c) -> double { return c.lensK1; }, KnobKind::Num},
    {"lensK2",               [](Config& c, double v) { c.lensK2 = v; },
     [](const Config& c) -> double { return c.lensK2; }, KnobKind::Num},
    {"lensLutNodes",         [](Config& c, double v) { c.lensLutNodes = (int)std::lround(v); },
     [](const Config& c) -> double { return (double)c.lensLutNodes; }, KnobKind::Int},
};
const size_t kKnobCount = sizeof(kKnobs) / sizeof(kKnobs[0]);

struct KnobStr {
    const char* name;
    void (*set)(Config&, const std::string&);
    const std::string& (*get)(const Config&);
};

const KnobStr kStrKnobs[] = {
    {"lensDeviceModel", [](Config& c, const std::string& v) { c.lensDeviceModel = v; },
     [](const Config& c) -> const std::string& { return c.lensDeviceModel; }},
    {"lensDeviceLens",  [](Config& c, const std::string& v) { c.lensDeviceLens = v; },
     [](const Config& c) -> const std::string& { return c.lensDeviceLens; }},
};
const size_t kStrKnobCount = sizeof(kStrKnobs) / sizeof(kStrKnobs[0]);

// ── outcome bookkeeping ─────────────────────────────────────────────────────
// The enum has no reflection, so the histogram is built over an explicit list.
// Keeping every name present with a 0 count (rather than only the ones seen) is
// what makes two reports diffable without a join.

const Outcome kAllOutcomes[] = {
    Outcome::Painted,             Outcome::HeldBacktrack,
    Outcome::SkippedNoAdvance,    Outcome::RejectedLowResponse,
    Outcome::RejectedOutOfCage,   Outcome::WarmingUp,
    Outcome::Bootstrap,           Outcome::GapExtended,
    Outcome::GapBreak,            Outcome::AbortedTracking,
    Outcome::CanvasFull,          Outcome::RejectedRectify,
    Outcome::RejectedInput,       Outcome::TailFlush,
    Outcome::HeldFrontier,        Outcome::RejectedPoseSpeed,
    Outcome::RejectedTracking,    Outcome::GapBackfilled,
    Outcome::JogHeld,
};
const size_t kOutcomeCount = sizeof(kAllOutcomes) / sizeof(kAllOutcomes[0]);

enum class Bucket { Painted, Held, Rejected, Skipped, Other };

Bucket bucketOf(Outcome o) {
    switch (o) {
        case Outcome::Painted:
        case Outcome::Bootstrap:
        case Outcome::GapExtended:
        case Outcome::GapBreak:
        case Outcome::GapBackfilled:
        case Outcome::TailFlush:
            return Bucket::Painted;
        case Outcome::HeldBacktrack:
        case Outcome::HeldFrontier:
        case Outcome::JogHeld:
            return Bucket::Held;
        case Outcome::RejectedLowResponse:
        case Outcome::RejectedOutOfCage:
        case Outcome::RejectedRectify:
        case Outcome::RejectedInput:
        case Outcome::RejectedPoseSpeed:
        case Outcome::RejectedTracking:
            return Bucket::Rejected;
        case Outcome::SkippedNoAdvance:
        case Outcome::WarmingUp:
            return Bucket::Skipped;
        case Outcome::AbortedTracking:
        case Outcome::CanvasFull:
            return Bucket::Other;
    }
    return Bucket::Other;
}

/// Split a text into lines WITHOUT allocating a copy per line for the caller.
/// Handles LF and CRLF; a final line with no terminator is still a line.
void forEachLine(const std::string& text,
                 const std::function<void(const std::string&, int)>& fn) {
    size_t p = 0;
    int lineNo = 0;
    while (p <= text.size()) {
        size_t nl = text.find('\n', p);
        if (nl == std::string::npos) nl = text.size();
        size_t e = nl;
        if (e > p && text[e - 1] == '\r') --e;
        ++lineNo;
        if (e > p) fn(text.substr(p, e - p), lineNo);
        if (nl == text.size()) break;
        p = nl + 1;
    }
}

}  // namespace

// ── public: ledger rows ─────────────────────────────────────────────────────
// PUBLIC because the Android LIVE session (cpp/rnis_pano_live.cpp) writes the
// same ledger while the sweep runs.  A second writer there would be a second
// field order to keep in step with RNISPanoCore.mm, and the first divergence
// would make a live pack textually undiffable against the device ledger it is
// supposed to be comparable with.

/// The ledger row, field for field and in the same order as RNISPanoCore.mm's
/// writer.  Divergence here would make a textual diff against a device ledger
/// useless, which is the whole reason to write one.
void appendLedgerLine(std::string& out, const FrameOutcome& row) {
    out += "{\"seq\":"; appendInt(out, (long long)row.seq);
    out += ",\"tsNs\":"; appendExact(out, row.tsNs);
    out += ",\"outcome\":\"";
    out += outcomeName(row.outcome);
    out += "\",\"advanceX\":"; appendNum(out, row.advanceX);
    out += ",\"advanceY\":"; appendNum(out, row.advanceY);
    out += ",\"advanceRotX\":"; appendNum(out, row.advanceRotX);
    out += ",\"advanceRotY\":"; appendNum(out, row.advanceRotY);
    out += ",\"advanceTotX\":"; appendNum(out, row.advanceTotX);
    out += ",\"advanceTotY\":"; appendNum(out, row.advanceTotY);
    out += ",\"chainAdvanced\":"; out += (row.chainAdvanced ? "true" : "false");
    if (row.relatched) out += ",\"relatched\":true";
    out += ",\"response\":"; appendNum(out, row.response);
    out += ",\"posU\":"; appendNum(out, row.posU);
    out += ",\"posV\":"; appendNum(out, row.posV);
    out += ",\"stripW\":"; appendNum(out, row.stripW);
    out += ",\"canvasX0\":"; appendNum(out, row.canvasX0);
    out += ",\"canvasX1\":"; appendNum(out, row.canvasX1);
    out += ",\"gainStep\":"; appendNum(out, row.gainStep);
    out += ",\"gainCum\":"; appendNum(out, row.gainCum);
    out += ",\"highWater\":"; appendNum(out, row.highWater);
    out += ",\"gapPx\":"; appendNum(out, row.gapPx);
    // EMITTED ONLY WHEN IT HAPPENED.  A pack that never armed
    // `seedFrontierMeet` must hash byte-for-byte to what it hashed before the
    // knob existed, which is the whole "off is byte-identical" claim; the same
    // reason `relatched` and `crossScaleCaged` are conditional.
    if (row.seedMet) {
        out += ",\"seedMet\":true";
        out += ",\"seedMeetPx\":"; appendNum(out, row.seedMeetPx);
    }
    out += ",\"backfillPx\":"; appendNum(out, row.backfillPx);
    out += ",\"leadRepaintPx\":"; appendNum(out, row.leadRepaintPx);
    out += ",\"rectifyDeg\":"; appendNum(out, row.rectifyDeg);
    out += ",\"clipTopPx\":"; appendNum(out, row.clipTopPx);
    out += ",\"clipBotPx\":"; appendNum(out, row.clipBotPx);
    out += ",\"clipped\":"; out += (row.clipped ? "true" : "false");
    out += ",\"vShiftPx\":"; appendNum(out, row.vShiftPx);
    out += ",\"psiDeg\":"; appendNum(out, row.psiDeg);
    out += ",\"crossRectifyDeg\":"; appendNum(out, row.crossRectifyDeg);
    out += ",\"areaScale\":"; appendNum(out, row.areaScale);
    out += ",\"crossGrad\":"; appendNum(out, row.crossGrad);
    out += ",\"crossBandR2\":"; appendNum(out, row.crossBandR2);
    out += ",\"crossScale\":"; appendNum(out, row.crossScale);
    if (row.crossScaleCaged) out += ",\"crossScaleCaged\":true";
    out += ",\"seamWorstBandPx\":"; appendNum(out, row.seamWorstBandPx);
    out += ",\"seamBandSpreadPx\":"; appendNum(out, row.seamBandSpreadPx);
    out += ",\"seamLumaStepDN\":"; appendNum(out, row.seamLumaStepDN);
    out += ",\"seamBands\":"; appendInt(out, row.seamBands);
    out += ",\"seamCanvasJogPx\":"; appendNum(out, row.seamCanvasJogPx);
    out += ",\"seamCanvasJogSignedPx\":"; appendNum(out, row.seamCanvasJogSignedPx);
    out += ",\"seamCanvasJogValid\":"; out += (row.seamCanvasJogValid ? "true" : "false");
    out += ",\"crossAvgDeltaPx\":"; appendNum(out, row.crossAvgDeltaPx);
    // The low-light registration gate's block — ONLY when the engine computed
    // it (Config::crossResidualGate ≥ 1), so a row the gate never touched is
    // textually the v15 row.  A non-finite statistic lands as null.
    if (row.crossStatsComputed) {
        out += ",\"crossGated\":"; appendInt(out, row.crossGated);
        out += ",\"crossTextureVar\":"; appendNum(out, row.crossTextureVar);
        out += ",\"crossPeakPSR\":"; appendNum(out, row.crossPeakPSR);
        out += ",\"crossPeakMass\":"; appendNum(out, row.crossPeakMass);
        out += ",\"crossDominantPeriodPx\":"; appendNum(out, row.crossDominantPeriodPx);
        out += ",\"crossPeakSecondary\":"; appendNum(out, row.crossPeakSecondary);
        out += ",\"crossResidualRawPx\":"; appendNum(out, row.crossResidualRawPx);
    }
    out += ",\"expGain\":"; appendNum(out, row.expGain);
    out += ",\"photoScale\":"; appendNum(out, row.photoScale);
    out += ",\"seamPhotoStepDN\":"; appendNum(out, row.seamPhotoStepDN);
    out += ",\"seamPhotoUniform\":"; appendNum(out, row.seamPhotoUniform);
    out += ",\"seamPhotoSpreadDN\":"; appendNum(out, row.seamPhotoSpreadDN);
    out += ",\"seamPhotoBands\":"; appendNum(out, (double)row.seamPhotoBands);
    out += ",\"seamPhotoValid\":"; out += (row.seamPhotoValid ? "true" : "false");
    out += ",\"engineMs\":"; appendNum(out, row.engineMs);
    out += ",\"stalled\":"; out += (row.stalled ? "true" : "false");
    out += "}\n";
}

/// THE TAIL-FLUSH ROW IS NOT AN ORDINARY ROW, and copying the ordinary writer
/// here was a real defect caught by the first real-pack diff.  RNISPanoCore.mm
/// writes it with a HARD-CODED `"seq":-1` and only five fields, because
/// `Engine::finish()` never sets `row.seq` — it comes back at the FrameOutcome
/// default of 0.  A full row at seq 0 collides with frame 0 in any per-seq
/// join, so the device's tail row read as "a row only the oracle has" and
/// frame 0's real outcome read as a disagreement with a tail flush.
void appendTailFlushLine(std::string& out, const FrameOutcome& tail) {
    out += "{\"seq\":-1,\"outcome\":\"";
    out += outcomeName(tail.outcome);
    out += "\",\"canvasX0\":"; appendNum(out, tail.canvasX0);
    out += ",\"canvasX1\":"; appendNum(out, tail.canvasX1);
    out += ",\"gainCum\":"; appendNum(out, tail.gainCum);
    out += ",\"highWater\":"; appendNum(out, tail.highWater);
    // Trajectory continuation (Config::crossTraj): what the tail block was
    // placed under.  All zero / false with the flag off, so the row's shape
    // is stable and a flag-off ledger differs from before only by these four
    // literal-constant fields.
    out += ",\"crossTrajApplied\":"; out += (tail.crossTrajApplied ? "true" : "false");
    out += ",\"crossTrajSlope\":"; appendNum(out, tail.crossTrajSlope);
    out += ",\"crossTrajFan\":"; appendNum(out, tail.crossTrajFan);
    out += ",\"crossTrajSamples\":"; appendInt(out, tail.crossTrajSamples);
    out += ",\"engineMs\":"; appendNum(out, tail.engineMs);
    out += "}\n";
}


// ── public: track row ───────────────────────────────────────────────────────

void appendTrackRow(std::string& out, const TrackRow& r) {
    out += "{\"seq\":";    appendInt(out, r.seq);
    // %.17g, not %.9g — see the declaration.  A millisecond-quantised tsNs
    // makes every frame after the first non-monotonic.
    out += ",\"tsNs\":";   appendExact(out, r.tsNs);
    out += ",\"q\":[";     appendNum(out, r.q[0]);
    for (int k = 1; k < 4; ++k) { out += ","; appendNum(out, r.q[k]); }
    out += "],\"t\":[";    appendNum(out, r.t[0]);
    for (int k = 1; k < 3; ++k) { out += ","; appendNum(out, r.t[k]); }
    out += "],\"fx\":";    appendNum(out, r.fx);
    out += ",\"fy\":";     appendNum(out, r.fy);
    out += ",\"cx\":";     appendNum(out, r.cx);
    out += ",\"cy\":";     appendNum(out, r.cy);
    out += ",\"w\":";      appendInt(out, r.w);
    out += ",\"h\":";      appendInt(out, r.h);
    // ALWAYS emitted.  `parseTrackRow` treats an absent `tracking` as a
    // NAMED, COUNTED fallback (`trackingDefaulted`), and a writer that can
    // supply the real value must never make a replay report it defaulted.
    out += ",\"tracking\":"; appendInt(out, r.tracking);
    out += ",\"expDurS\":";  appendNum(out, r.expDurS);
    out += ",\"expISO\":";   appendNum(out, r.expISO);
    out += "}\n";
}

TrackRow parseTrackRow(const std::string& line) {
    TrackRow r;
    mj::Span root;
    if (!mj::parseDocument(line, &root) || root.kind != mj::Kind::Object) {
        r.why = "not a JSON object";
        return r;
    }

    const auto num = [&](const char* key, double* dst) -> bool {
        mj::Span v;
        if (!mj::member(line, root, key, &v)) return false;
        bool ok = false;
        const double x = mj::asNumber(line, v, &ok);
        if (!ok) return false;
        *dst = x;
        return true;
    };

    double d = 0;
    if (!num("seq", &d)) { r.why = "missing/!numeric seq"; return r; }
    r.seq = (long long)std::llround(d);
    if (!num("tsNs", &r.tsNs)) { r.why = "missing/!numeric tsNs"; return r; }
    if (!num("fx", &r.fx) || !num("fy", &r.fy) ||
        !num("cx", &r.cx) || !num("cy", &r.cy)) {
        r.why = "missing/!numeric intrinsics";
        return r;
    }
    if (!num("w", &d)) { r.why = "missing/!numeric w"; return r; }
    r.w = (int)std::lround(d);
    if (!num("h", &d)) { r.why = "missing/!numeric h"; return r; }
    r.h = (int)std::lround(d);

    // The quaternion is REQUIRED and must be four finite numbers.  A three-
    // element or NaN-carrying q would reach the rectification as a silently
    // wrong rotation rather than as a rejected frame.
    {
        mj::Span qs;
        std::vector<mj::Span> el;
        if (!mj::member(line, root, "q", &qs) || !mj::elements(line, qs, &el) ||
            el.size() != 4) {
            r.why = "q is not a 4-element array";
            return r;
        }
        for (int k = 0; k < 4; ++k) {
            bool ok = false;
            r.q[k] = mj::asNumber(line, el[(size_t)k], &ok);
            if (!ok || !std::isfinite(r.q[k])) { r.why = "q element !finite"; return r; }
        }
    }
    // Translation is OPTIONAL: the imu-attitude-only arm writes [0,0,0] but a
    // pack from a pose source without translation may omit it entirely, and
    // zero is what the engine's own default is.
    {
        mj::Span ts;
        std::vector<mj::Span> el;
        if (mj::member(line, root, "t", &ts) && mj::elements(line, ts, &el) &&
            el.size() == 3) {
            for (int k = 0; k < 3; ++k) {
                bool ok = false;
                const double x = mj::asNumber(line, el[(size_t)k], &ok);
                if (ok && std::isfinite(x)) r.t[k] = x;
            }
        }
    }

    if (num("tracking", &d)) {
        r.tracking = (int)std::lround(d);
    } else {
        r.tracking = 2;
        r.trackingDefaulted = true;
    }

    num("expDurS", &r.expDurS);
    num("expISO", &r.expISO);
    num("arExpDurS", &r.arExpDurS);
    num("arExpOffsetEV", &r.arExpOffsetEV);
    {
        mj::Span v;
        if (mj::member(line, root, "arExpHave", &v) && v.kind == mj::Kind::Bool) {
            r.arExpHave = (line[v.b] == 't');
        }
    }

    if (!std::isfinite(r.tsNs) || !std::isfinite(r.fx) || !std::isfinite(r.fy) ||
        !std::isfinite(r.cx) || !std::isfinite(r.cy)) {
        r.why = "non-finite ts/intrinsics";
        return r;
    }
    if (r.w <= 0 || r.h <= 0) { r.why = "w/h <= 0"; return r; }

    r.ok = true;
    return r;
}

// ── public: config adoption ─────────────────────────────────────────────────

bool applyMetaConfig(const std::string& text, Config& cfg,
                     std::vector<std::string>* found,
                     std::vector<std::string>* defaulted) {
    mj::Span root;
    if (!mj::parseDocument(text, &root) || root.kind != mj::Kind::Object) return false;
    mj::Span cfgSpan;
    if (!mj::member(text, root, "config", &cfgSpan) ||
        cfgSpan.kind != mj::Kind::Object) {
        return false;
    }

    for (size_t i = 0; i < kKnobCount; ++i) {
        mj::Span v;
        bool ok = false;
        double x = 0;
        if (mj::member(text, cfgSpan, kKnobs[i].name, &v)) {
            x = mj::asNumber(text, v, &ok);
        }
        // `null` (jnum's unmeasured marker for lensK1/K2) is NOT a value.  It
        // reaches here as Kind::Null, asNumber declines it, and the knob lands
        // in `defaulted` — which is the truthful report.
        if (ok && std::isfinite(x)) {
            kKnobs[i].set(cfg, x);
            if (found) found->push_back(kKnobs[i].name);
        } else if (defaulted) {
            defaulted->push_back(kKnobs[i].name);
        }
    }
    for (size_t i = 0; i < kStrKnobCount; ++i) {
        mj::Span v;
        if (mj::member(text, cfgSpan, kStrKnobs[i].name, &v) &&
            v.kind == mj::Kind::String) {
            kStrKnobs[i].set(cfg, mj::decodeString(text, v));
            if (found) found->push_back(kStrKnobs[i].name);
        } else if (defaulted) {
            defaulted->push_back(kStrKnobs[i].name);
        }
    }
    return true;
}

// ── public: the HOST's preview knobs, as a pack records them ────────────────
// Seven live in `config.pack` and one — leadOutEnabled — in the top-level
// `preview` block, because on iOS the first seven are REQUESTS (PackOptions,
// written with the config) and the last is a VERDICT (written with the
// preview's own counters).  Both are read here so a replay renders the preview
// the operator actually saw rather than the compiled default.
bool readPackPreviewSettings(const std::string& text, PackPreviewSettings* out) {
    if (out == nullptr) return false;
    *out = PackPreviewSettings();

    mj::Span root;
    if (!mj::parseDocument(text, &root) || root.kind != mj::Kind::Object) {
        return false;
    }

    mj::Span cfgSpan, packSpan, prevSpan;
    const bool havePack =
        mj::member(text, root, "config", &cfgSpan) &&
        cfgSpan.kind == mj::Kind::Object &&
        mj::member(text, cfgSpan, "pack", &packSpan) &&
        packSpan.kind == mj::Kind::Object;
    const bool havePrev =
        mj::member(text, root, "preview", &prevSpan) &&
        prevSpan.kind == mj::Kind::Object;

    // One reader for all eight.  `asNumber` accepts Bool, so `previewCropPad`
    // and `leadOutEnabled` come through the same path as the numbers; `null`
    // is declined by it and lands in `defaulted`, which is the truthful report
    // rather than a silent 0.
    const std::string kPackPrefix = "config.pack.";
    auto grab = [&](bool haveObj, const mj::Span& obj, const char* key,
                    const std::string& label, double* dst) {
        mj::Span v;
        bool ok = false;
        double x = 0;
        if (haveObj && mj::member(text, obj, key, &v)) {
            x = mj::asNumber(text, v, &ok);
        }
        if (ok && std::isfinite(x)) {
            *dst = x;
            out->found.push_back(label);
        } else {
            out->defaulted.push_back(label);
        }
    };

    double intervalMs = out->intervalMs;
    double maxAlong = out->maxAlong, maxCross = out->maxCross;
    double windowAlongPx = out->windowAlongPx;
    double windowCrossMult = out->windowCrossMult;
    double cropPad = out->cropPad ? 1.0 : 0.0;
    double quality = out->quality;
    double leadOut = out->leadOut ? 1.0 : 0.0;

    grab(havePack, packSpan, "previewIntervalMs",
         kPackPrefix + "previewIntervalMs", &intervalMs);
    grab(havePack, packSpan, "previewMaxAlong",
         kPackPrefix + "previewMaxAlong", &maxAlong);
    grab(havePack, packSpan, "previewMaxCross",
         kPackPrefix + "previewMaxCross", &maxCross);
    grab(havePack, packSpan, "previewWindowAlongPx",
         kPackPrefix + "previewWindowAlongPx", &windowAlongPx);
    grab(havePack, packSpan, "previewWindowCrossMult",
         kPackPrefix + "previewWindowCrossMult", &windowCrossMult);
    grab(havePack, packSpan, "previewCropPad",
         kPackPrefix + "previewCropPad", &cropPad);
    grab(havePack, packSpan, "previewQuality",
         kPackPrefix + "previewQuality", &quality);
    grab(havePrev, prevSpan, "leadOutEnabled", "preview.leadOutEnabled",
         &leadOut);

    out->intervalMs      = intervalMs;
    out->maxAlong        = (int)std::lround(maxAlong);
    out->maxCross        = (int)std::lround(maxCross);
    out->windowAlongPx   = (int)std::lround(windowAlongPx);
    out->windowCrossMult = windowCrossMult;
    out->cropPad         = (cropPad != 0.0);
    out->quality         = (int)std::lround(quality);
    out->leadOut         = (leadOut != 0.0);
    return true;
}

void appendConfigJson(std::string& out, const Config& cfg) {
    out += "{";
    bool first = true;
    for (size_t i = 0; i < kKnobCount; ++i) {
        if (!first) out += ",";
        first = false;
        out += "\"";
        out += kKnobs[i].name;
        out += "\":";
        const double v = kKnobs[i].get(cfg);
        switch (kKnobs[i].kind) {
            case KnobKind::Bool: out += (v != 0.0 ? "true" : "false"); break;
            case KnobKind::Int:  appendInt(out, (long long)std::llround(v)); break;
            case KnobKind::Num:  appendNum(out, v); break;
        }
    }
    for (size_t i = 0; i < kStrKnobCount; ++i) {
        if (!first) out += ",";
        first = false;
        out += "\"";
        out += kStrKnobs[i].name;
        out += "\":";
        // Escaped the same way every other writer here escapes: the device
        // model is operator-visible text and a stray quote would make the
        // whole meta.json unparseable, which costs the pack rather than a
        // field.
        const std::string& sv = kStrKnobs[i].get(cfg);
        out += "\"";
        for (size_t k = 0; k < sv.size(); ++k) {
            const unsigned char c = (unsigned char)sv[k];
            if (c == '"') out += "\\\"";
            else if (c == '\\') out += "\\\\";
            else if (c < 0x20) out += ' ';
            else out += (char)c;
        }
        out += "\"";
    }
    out += "}";
}

int applyConfigOverride(Config& cfg, const std::string& name,
                        const std::string& value) {
    for (size_t i = 0; i < kStrKnobCount; ++i) {
        if (name == kStrKnobs[i].name) {
            kStrKnobs[i].set(cfg, value);
            return 1;
        }
    }
    for (size_t i = 0; i < kKnobCount; ++i) {
        if (name != kKnobs[i].name) continue;
        double v = 0;
        if (value == "true")       v = 1.0;
        else if (value == "false") v = 0.0;
        else {
            char* endp = nullptr;
            v = std::strtod(value.c_str(), &endp);
            if (value.empty() || endp == nullptr || *endp != '\0' ||
                !std::isfinite(v)) {
                return -1;
            }
        }
        kKnobs[i].set(cfg, v);
        return 1;
    }
    return 0;
}

// ── public: ledger scan ─────────────────────────────────────────────────────

void scanLedgerOutcomes(const std::string& text,
                        std::vector<std::pair<long long, std::string> >* bySeq,
                        int* malformed) {
    if (bySeq) bySeq->clear();
    if (malformed) *malformed = 0;
    forEachLine(text, [&](const std::string& line, int) {
        mj::Span root;
        if (!mj::parseDocument(line, &root) || root.kind != mj::Kind::Object) {
            if (malformed) ++(*malformed);
            return;
        }
        mj::Span sq, oc;
        if (!mj::member(line, root, "seq", &sq) ||
            !mj::member(line, root, "outcome", &oc) ||
            oc.kind != mj::Kind::String) {
            if (malformed) ++(*malformed);
            return;
        }
        bool ok = false;
        const double s = mj::asNumber(line, sq, &ok);
        if (!ok) { if (malformed) ++(*malformed); return; }
        if (bySeq) {
            bySeq->push_back(std::make_pair((long long)std::llround(s),
                                            mj::decodeString(line, oc)));
        }
    });
}

// ── public: the driver ──────────────────────────────────────────────────────

namespace {

bool replayPackBody(const ReplayOptions& opt, ReplayReport* R) {
    R->fidelityNote =
        "replay input is the pack's JPEG frames (lossy) and a BGR2GRAY luma, "
        "while the device ingested raw NV12 and used the Y plane directly for "
        "grayWork; registration input therefore differs by ~an affine map plus "
        "JPEG noise. Read a replay differentially (arm A vs arm B) and as a "
        "throughput measurement, not as bit parity with the device.";
    R->attitudeNote =
        "track.jsonl carries the quaternion the engine CONSUMED (tau already "
        "applied, basis C already applied). The raw attitude samples are not in "
        "a pack, so tau/basis cannot be re-timed from one and this driver does "
        "not offer an override that would report no-change as evidence.";

    // ── 1. resolve the pack directory ───────────────────────────────────
    if (opt.packDir.empty()) { R->error = "packDir is empty"; return false; }
    const std::string asPanoplus = joinPath(opt.packDir, "panoplus");
    const std::string trackInPanoplus = joinPath(asPanoplus, "track.jsonl");
    const std::string trackInRoot = joinPath(opt.packDir, "track.jsonl");
    struct stat probe;
    const StatWhy wPanoplus = statPath(trackInPanoplus, &probe);
    const StatWhy wRoot = statPath(trackInRoot, &probe);
    if (wPanoplus == StatWhy::Ok) {
        R->packDirResolved = asPanoplus;
    } else if (wRoot == StatWhy::Ok) {
        R->packDirResolved = opt.packDir;
    } else if (wPanoplus == StatWhy::Denied || wRoot == StatWhy::Denied) {
        R->error = "cannot read " +
                   (wPanoplus == StatWhy::Denied ? trackInPanoplus : trackInRoot) +
                   kDeniedRemedy;
        return false;
    } else {
        R->error = "no track.jsonl at " + trackInPanoplus +
                   " nor at " + trackInRoot;
        return false;
    }
    R->trackPath = joinPath(R->packDirResolved, "track.jsonl");
    R->framesDir = joinPath(R->packDirResolved, "frames");
    if (!isDir(R->framesDir)) {
        // Same distinction one level down: a frames/ directory the process may
        // not enter is not a frames/ directory that is missing, and only one of
        // the two is fixed by re-recording the sweep.
        R->error = (statPath(R->framesDir, &probe) == StatWhy::Denied)
            ? ("cannot read the frames directory " + R->framesDir + kDeniedRemedy)
            : ("frames directory missing: " + R->framesDir);
        return false;
    }

    // ── 2. output directory, and the oracle guard ───────────────────────
    std::string outDir = opt.outDir;
    if (!outDir.empty()) {
        if (!ensureDir(outDir)) {
            R->error = "could not create outDir: " + outDir;
            return false;
        }
        if (canonical(outDir) == canonical(R->packDirResolved)) {
            R->error =
                "outDir resolves to the pack's own panoplus directory (" +
                canonical(outDir) +
                ") — refusing, because ledger.jsonl there is the oracle this "
                "replay is graded against";
            return false;
        }
        R->canvasPath = joinPath(outDir, "canvas.jpg");
        R->ledgerPath = joinPath(outDir, "ledger.jsonl");
    }

    // ── 3. config ───────────────────────────────────────────────────────
    Config cfg;
    const std::string metaPath = joinPath(R->packDirResolved, "meta.json");
    std::string metaText;
    const bool haveMetaText = readFile(metaPath, &metaText);

    R->canvasCropPadApplied = opt.canvasCropPad;
    R->canvasNote =
        "the finalize pad-row trim (finalCanvas cropPadRows) is NOT recorded "
        "anywhere in a pack — not meta.json, not result.json — so this run's "
        "trim is the REPLAY OPTION's, not the device's. It is the v12+ default "
        "(true); a pre-v12 pack was finalized WITHOUT it, so its own "
        "canvas.outputW is ~2x canvasPadPx larger than this replay's for the "
        "same sweep. Compare deviceOutputW/H against canvasW/H with that in "
        "hand, and read paintedW as the size number that does not move.";

    if (opt.useMetaConfig) {
        if (haveMetaText) {
            R->metaPath = metaPath;
            if (applyMetaConfig(metaText, cfg, &R->configFound, &R->configDefaulted)) {
                R->haveMeta = true;
            } else {
                // The file is there but has no usable `config` object.  That is
                // a REPORTED condition, not a fatal one: a throughput run over
                // engine defaults is still a real measurement, as long as the
                // report says that is what it was.
                R->configFound.clear();
                R->configDefaulted.clear();
                R->configDefaulted.push_back("<all: meta.json has no parseable config object>");
            }
        } else {
            R->configDefaulted.push_back("<all: meta.json not readable>");
        }
    } else {
        R->configDefaulted.push_back("<all: useMetaConfig=false>");
    }

    for (size_t i = 0; i < opt.configOverrides.size(); ++i) {
        const std::string& k = opt.configOverrides[i].first;
        const std::string& v = opt.configOverrides[i].second;
        const int rc = applyConfigOverride(cfg, k, v);
        if (rc == 1)       R->overridesApplied.push_back(k + "=" + v);
        else if (rc == 0)  R->overridesUnknown.push_back(k);
        else               R->overridesMalformed.push_back(k + "=" + v);
    }
    R->resolvedConfig = cfg;

    Engine engine;
    std::string cfgErr;
    if (!engine.configure(cfg, &cfgErr)) {
        R->error = "Engine::configure declined the config: " + cfgErr;
        return false;
    }

    // ── 3b. the preview instrumentation ─────────────────────────────────
    // DIAGNOSTICS ONLY.  With `opt.preview.enabled` false nothing below runs,
    // not one `previewIntoFit` is called, no file is opened, and the run is
    // byte-for-byte the run it was before this block existed.
    const PreviewCaptureOptions& pv = opt.preview;
    R->previewEnabled = pv.enabled;
    PackPreviewSettings ps;                    // starts at the compiled iOS defaults
    std::string previewText;                   // preview.jsonl body
    std::string previewImgDir;                 // "" ⇒ no images
    int previewTick = 0;
    double previewLastTsNs = -1.0;
    double previewFirstTsNs = -1.0;
    double previewIntervalNs = 0.0;
    if (pv.enabled) {
        if (haveMetaText) {
            readPackPreviewSettings(metaText, &ps);
        } else {
            ps.defaulted.push_back("<all: meta.json not readable>");
        }
        // FORCED knobs are named, never silently folded into `found` — the
        // same rule the config overrides follow.
        if (pv.intervalMs      >= 0.0) { ps.intervalMs = pv.intervalMs;
            ps.found.push_back("forced:intervalMs"); }
        if (pv.maxAlong        >= 0)   { ps.maxAlong = pv.maxAlong;
            ps.found.push_back("forced:maxAlong"); }
        if (pv.maxCross        >= 0)   { ps.maxCross = pv.maxCross;
            ps.found.push_back("forced:maxCross"); }
        if (pv.windowAlongPx   >= 0)   { ps.windowAlongPx = pv.windowAlongPx;
            ps.found.push_back("forced:windowAlongPx"); }
        if (pv.windowCrossMult >= 0.0) { ps.windowCrossMult = pv.windowCrossMult;
            ps.found.push_back("forced:windowCrossMult"); }
        if (pv.cropPad         >= 0)   { ps.cropPad = (pv.cropPad != 0);
            ps.found.push_back("forced:cropPad"); }
        if (pv.leadOut         >= 0)   { ps.leadOut = (pv.leadOut != 0);
            ps.found.push_back("forced:leadOut"); }
        // A pack that recorded 0 would otherwise tick on every single frame.
        // iOS clamps the same knob to >= 50 where it reads it; the clamp is
        // applied HERE rather than in the parser so the parser keeps reporting
        // what the pack actually says.
        previewIntervalNs = std::max(1.0, ps.intervalMs) * 1e6;
        R->previewSettings = ps;
        R->previewNote =
            "preview ticks are scheduled on the PACK'S FRAME TIMESTAMP clock at "
            "intervalMs, not on wall time. The device's schedule was wall-clock "
            "AND duty-throttled (previewMaxDutyPct), and no pack records the "
            "per-tick schedule, so this reproduces the device's tick RATE and "
            "geometry but NOT its exact tick set — read a row as 'what the "
            "preview looked like at this point in the sweep', never as 'the "
            "device published exactly this'. Geometry fields are canvas-along "
            "(u) as PreviewWindow defines them; imageW/imageH are the PUBLISHED "
            "image, i.e. after the fit AND after orient(), so the SDK's own "
            "quarter turn on screen is still applied on top of them.";
        if (!outDir.empty()) {
            if (pv.writeJsonl) R->previewJsonlPath = joinPath(outDir, "preview.jsonl");
            if (pv.imageEveryN > 0 && pv.imageMaxCount > 0) {
                previewImgDir = joinPath(outDir, "preview");
                if (ensureDir(previewImgDir)) {
                    R->previewImageDir = previewImgDir;
                } else {
                    previewImgDir.clear();
                    R->writeError += (R->writeError.empty() ? "" : "; ");
                    R->writeError += "preview image dir could not be created";
                }
            }
        }
    }

    // ONE tick: render the preview the host would have rendered, record every
    // number `PreviewWindow` carries, and (every Nth, capped) save the image.
    //
    // WHERE THE NUMBERS COME FROM, so a reader can check them against source:
    //   · bandStartU/bandEndU/viewStartU/viewEndU/frontierU/frontierFrac/
    //     windowed/canvasCrossPx/viewCrossPx/leadOutPx, and the v14
    //     liveValid/lastFu1/leadClampU/leadEndU/leadArc — ALL of them are
    //     filled by Engine::previewIntoWindowed's `if (win != nullptr)` block
    //     (cpp/rnis_pano.cpp), which is the same struct the iOS host reads at
    //     RNISPanoCore.mm's live publish. `frontierU` IS `Impl::highWater`;
    //     `highWater` is emitted as well, under that name, because that is
    //     what ledger.jsonl calls the same quantity.
    //   · imageW/imageH — `previewMat.cols/rows` after previewIntoFit returned,
    //     i.e. the PUBLISHED image.
    //   · axis/sweepSign/axisLatched — Engine::stats().
    //   · windowAlongPx — computed HERE, mirroring RNISPanoCore.mm:1193-1199
    //     line for line (explicit px wins; else the ratio times
    //     previewCrossPx(cropPad), which is the cross the publish will CARRY).
    auto previewTickNow = [&](long long seq, double tsNs, int windowOverride,
                              bool leadOutThisTick, bool finalRepublish) {
        int windowPx = (windowOverride >= 0) ? windowOverride : ps.windowAlongPx;
        if (windowPx <= 0 && windowOverride < 0 && ps.windowCrossMult > 0.0) {
            const int ch = engine.previewCrossPx(ps.cropPad);
            if (ch > 0) {
                windowPx = (int)std::lround(ps.windowCrossMult * (double)ch);
            }
        }
        cv::Mat pvMat;
        PreviewWindow w;
        const double t0 = nowMs();
        const bool published = engine.previewIntoFit(pvMat, ps.maxAlong,
                                                     ps.maxCross, windowPx, &w,
                                                     ps.cropPad,
                                                     leadOutThisTick)
                               && !pvMat.empty();
        R->previewMsTotal += nowMs() - t0;

        const int tick = previewTick++;
        ++R->previewTicks;
        if (published) ++R->previewPublished; else ++R->previewRefused;
        // THE PRE-LATCH SEED, named rather than left to be inferred: a publish
        // with an EMPTY band is not a slice of the panorama, it is the held
        // reference frame (rnis_pano.cpp's `if (!S.anyPainted)` branch).  Its
        // geometry fields are all zero/-1 by that branch's own explicit reset.
        const bool seed = published && (w.bandEndU == w.bandStartU);
        if (seed) ++R->previewSeeded;

        std::string imgRel;
        if (published && !previewImgDir.empty() && pv.imageEveryN > 0 &&
            (tick % pv.imageEveryN) == 0) {
            if (R->previewImagesWritten >= pv.imageMaxCount) {
                R->previewImagesCapped = true;
            } else {
                char nb[64];
                std::snprintf(nb, sizeof(nb), "preview_%05d.jpg", tick);
                std::string err;
                const int q = (pv.imageQuality > 0) ? pv.imageQuality : ps.quality;
                if (publishJpegAtomically(joinPath(previewImgDir, nb), pvMat, q,
                                          &err)) {
                    ++R->previewImagesWritten;
                    imgRel = std::string("preview/") + nb;
                } else {
                    ++R->previewImageWriteFailed;
                }
            }
        }

        if (R->previewJsonlPath.empty()) return;
        const SessionStats st = engine.stats();
        std::string& o = previewText;
        o += "{\"tick\":";            appendInt(o, tick);
        o += ",\"seq\":";             appendInt(o, seq);
        o += ",\"tsNs\":";            appendExact(o, tsNs);
        o += ",\"tSweepMs\":";
        appendNum(o, (previewFirstTsNs >= 0.0 && tsNs >= 0.0)
                         ? (tsNs - previewFirstTsNs) / 1e6 : -1.0);
        o += ",\"published\":";       o += (published ? "true" : "false");
        o += ",\"seed\":";            o += (seed ? "true" : "false");
        o += ",\"finalRepublish\":";  o += (finalRepublish ? "true" : "false");
        o += ",\"axis\":";            appendInt(o, st.axis);
        o += ",\"sweepSign\":";       appendInt(o, st.sweepSign);
        o += ",\"axisLatched\":";     o += (st.axisLatched ? "true" : "false");
        o += ",\"outputRotationCwDeg\":"; appendInt(o, st.outputRotationCwDeg);
        o += ",\"bandStartU\":";      appendInt(o, w.bandStartU);
        o += ",\"bandEndU\":";        appendInt(o, w.bandEndU);
        o += ",\"viewStartU\":";      appendInt(o, w.viewStartU);
        o += ",\"viewEndU\":";        appendInt(o, w.viewEndU);
        o += ",\"windowed\":";        o += (w.windowed ? "true" : "false");
        o += ",\"windowAlongPx\":";   appendInt(o, windowPx);
        o += ",\"leadOutRequested\":"; o += (leadOutThisTick ? "true" : "false");
        o += ",\"leadOutPx\":";       appendInt(o, w.leadOutPx);
        // frontierU and highWater are THE SAME NUMBER (PreviewWindow::frontierU
        // is assigned Impl::highWater).  Both names are written because the
        // ledger calls it highWater and the preview struct calls it frontierU,
        // and a reader joining the two files should not have to know that.
        o += ",\"frontierU\":";       appendNum(o, w.frontierU);
        o += ",\"highWater\":";       appendNum(o, w.frontierU);
        o += ",\"frontierFrac\":";    appendNum(o, w.frontierFrac);
        o += ",\"liveValid\":";       o += (w.liveValid ? "true" : "false");
        o += ",\"lastFu1\":";         appendNum(o, w.lastFu1U);
        o += ",\"leadClampU\":";      appendNum(o, w.leadClampU);
        o += ",\"leadEndU\":";        appendNum(o, w.leadEndU);
        o += ",\"leadArc\":";         o += (w.leadArc ? "true" : "false");
        // Where the live paint BEGAN and how much stale band it replaced
        // (Config::leadOutFromFrontier), and the trajectory it was placed under
        // (Config::crossTraj) — the per-tick geometry that shows the lead-out
        // starting at the frontier rather than at the seed's footprint end.
        o += ",\"leadStartU\":";      appendNum(o, w.leadStartU);
        o += ",\"leadOverwritePx\":"; appendInt(o, w.leadOverwritePx);
        o += ",\"leadTrajApplied\":"; o += (w.leadTrajApplied ? "true" : "false");
        o += ",\"leadTrajSlope\":";   appendNum(o, w.leadTrajSlope);
        o += ",\"leadTrajFan\":";     appendNum(o, w.leadTrajFan);
        o += ",\"leadPadTopPx\":";    appendInt(o, w.leadPadTopPx);
        o += ",\"leadPadBotPx\":";    appendInt(o, w.leadPadBotPx);
        o += ",\"canvasCrossPx\":";   appendInt(o, w.canvasCrossPx);
        o += ",\"viewCrossPx\":";     appendInt(o, w.viewCrossPx);
        o += ",\"canvasW\":";         appendInt(o, st.canvasW);
        o += ",\"canvasH\":";         appendInt(o, st.canvasH);
        o += ",\"imageW\":";          appendInt(o, published ? pvMat.cols : 0);
        o += ",\"imageH\":";          appendInt(o, published ? pvMat.rows : 0);
        o += ",\"image\":";
        if (imgRel.empty()) o += "null"; else appendJsonString(o, imgRel);
        o += "}\n";
    };

    // ── 4. the track file ───────────────────────────────────────────────
    std::string trackText;
    if (!readFile(R->trackPath, &trackText)) {
        R->error = "could not read " + R->trackPath;
        return false;
    }
    std::vector<std::pair<std::string, int> > lines;   // text, line number
    forEachLine(trackText, [&](const std::string& l, int n) {
        lines.push_back(std::make_pair(l, n));
    });
    R->rowsTotal = (int)lines.size();
    if (lines.empty()) {
        R->error = "track.jsonl has no rows";
        return false;
    }

    const size_t limit = (opt.maxFrames > 0)
                             ? std::min(lines.size(), (size_t)opt.maxFrames)
                             : lines.size();
    R->rowsTruncated = (int)(lines.size() - limit);

    // ── 5. the sweep ────────────────────────────────────────────────────
    std::map<std::string, int> hist;
    for (size_t i = 0; i < kOutcomeCount; ++i) hist[outcomeName(kAllOutcomes[i])] = 0;
    std::vector<std::pair<long long, std::string> > mine;   // seq → outcome
    std::vector<double> ingestMs;
    std::string ledgerText;
    ingestMs.reserve(limit);
    mine.reserve(limit);

    char nameBuf[64];
    for (size_t i = 0; i < limit; ++i) {
        const TrackRow row = parseTrackRow(lines[i].first);
        if (!row.ok) {
            ++R->rowsMalformed;
            if (R->firstMalformedDetail.empty()) {
                R->firstMalformedDetail =
                    "line " + std::to_string(lines[i].second) + ": " + row.why;
            }
            continue;
        }
        ++R->framesRead;
        if (row.trackingDefaulted) ++R->rowsMissingTracking;

        std::snprintf(nameBuf, sizeof(nameBuf), "frame_%06lld.jpg", row.seq);
        const std::string framePath = joinPath(R->framesDir, nameBuf);
        if (!pathExists(framePath)) {
            ++R->framesMissing;
            if ((int)R->framesMissingExamples.size() < opt.frameMissingReportCap) {
                R->framesMissingExamples.push_back(nameBuf);
            }
            continue;
        }

        const double l0 = nowMs();
        cv::Mat img = cv::imread(framePath, cv::IMREAD_COLOR);
        if (img.empty()) {
            R->loadMsTotal += nowMs() - l0;
            ++R->framesUnreadable;
            continue;
        }
        // IMREAD_COLOR already yields CV_8UC3, but a build with a different
        // default conversion would otherwise reach the engine's validator as a
        // "malformed frame" and be reported as an input defect of the PACK.
        if (img.type() != CV_8UC3) {
            cv::Mat c;
            if (img.channels() == 1)      cv::cvtColor(img, c, cv::COLOR_GRAY2BGR);
            else if (img.channels() == 4) cv::cvtColor(img, c, cv::COLOR_BGRA2BGR);
            else { ++R->framesUnreadable; R->loadMsTotal += nowMs() - l0; continue; }
            img = c;
        }

        cv::Mat gray, grayWork;
        cv::cvtColor(img, gray, cv::COLOR_BGR2GRAY);
        // The fx/fy form, matching RNISPanoCore.mm exactly rather than an
        // explicit Size — the two differ only on a half-pixel tie, and parity
        // with the shipped path is worth more here than tidiness.
        cv::resize(gray, grayWork, cv::Size(), cfg.workScale, cfg.workScale,
                   cv::INTER_AREA);
        // …and then CHECK it against the engine's own ±2 px rule, because a
        // rounding difference in some other OpenCV build would otherwise show
        // up as 400 rejected-input rows and read as an engine finding.
        {
            const int wantW = (int)std::lround(img.cols * cfg.workScale);
            const int wantH = (int)std::lround(img.rows * cfg.workScale);
            if (std::abs(grayWork.cols - wantW) > 2 ||
                std::abs(grayWork.rows - wantH) > 2) {
                cv::resize(gray, grayWork, cv::Size(wantW, wantH), 0, 0,
                           cv::INTER_AREA);
                ++R->grayWorkSizeCorrected;
            }
        }
        R->loadMsTotal += nowMs() - l0;

        FrameInput in;
        in.bgr = &img;
        in.grayWork = &grayWork;
        in.tsNs = row.tsNs;
        // INTRINSICS ↔ RASTER, the same correction (and the same counter) the
        // iOS host applies: track.jsonl records the DECLARED w/h, and the
        // engine requires bgr dims == imageWidth/Height, so a pack whose frames
        // were written at a different size must have its intrinsics rescaled
        // rather than silently mis-scaling every H_rect.
        double fx = row.fx, fy = row.fy, cx = row.cx, cy = row.cy;
        // A TRANSPOSED raster is NOT a rescale, and folding it into one would
        // put a plausible-looking wrong H_rect on every single frame.  This is
        // an Android-leg risk specifically: `cv::imread` applies EXIF
        // orientation by default, and a pack written by a host whose JPEG
        // encoder stamps an orientation tag would decode rotated while
        // track.jsonl still declares the sensor's w/h.  Skip, count, name.
        if (row.w > 0 && row.h > 0 && row.w == img.rows && row.h == img.cols &&
            img.cols != img.rows) {
            ++R->framesTransposed;
            continue;
        }
        if (row.w > 0 && row.h > 0 && (row.w != img.cols || row.h != img.rows)) {
            const double sx = (double)img.cols / (double)row.w;
            const double sy = (double)img.rows / (double)row.h;
            fx *= sx; cx *= sx; fy *= sy; cy *= sy;
            ++R->intrinsicsRescaled;
        }
        in.fx = fx; in.fy = fy; in.cx = cx; in.cy = cy;
        in.imageWidth = img.cols;
        in.imageHeight = img.rows;
        for (int k = 0; k < 4; ++k) in.q[k] = row.q[k];
        for (int k = 0; k < 3; ++k) in.t[k] = row.t[k];
        in.tracking = row.tracking;
        in.seq = row.seq;
        in.exposureDurationS = row.expDurS;
        in.exposureISO = row.expISO;
        in.arExposureDurationS = row.arExpDurS;
        in.arExposureOffsetEV = row.arExpOffsetEV;
        in.arExposureValid = row.arExpHave;

        const double t0 = nowMs();
        const FrameOutcome oc = engine.ingest(in);
        const double dt = nowMs() - t0;

        ingestMs.push_back(dt);
        R->totalMs += dt;
        ++R->framesIngested;
        ++hist[outcomeName(oc.outcome)];
        mine.push_back(std::make_pair((long long)oc.seq, std::string(outcomeName(oc.outcome))));
        if (opt.writeLedger && !R->ledgerPath.empty()) appendLedgerLine(ledgerText, oc);

        // ── the preview tick, AFTER the ingest, on the pack's own clock ──
        // Its cost is in `previewMsTotal`, deliberately NOT in `ingestMs` /
        // `totalMs`: the throughput number this driver exists to produce must
        // not move because a diagnostic was switched on.
        if (pv.enabled) {
            if (previewFirstTsNs < 0.0) previewFirstTsNs = row.tsNs;
            // A BACKWARD jump suppresses ticks until the clock catches up.
            // That is deliberate: a backward jump past the bound is
            // `session-restart`, which aborts the sweep, and inventing ticks
            // across a discontinuity would put two different timebases in one
            // file under one monotonic `tick` index.
            if (previewLastTsNs < 0.0 ||
                (row.tsNs - previewLastTsNs) >= previewIntervalNs) {
                previewLastTsNs = row.tsNs;
                previewTickNow((long long)row.seq, row.tsNs, /*windowOverride=*/-1,
                               ps.leadOut, /*finalRepublish=*/false);
            }
        }
    }

    // ── 6. finish + finalize ────────────────────────────────────────────
    {
        const double t0 = nowMs();
        const FrameOutcome tail = engine.finish();
        R->finishMs = nowMs() - t0;
        // A no-op flush still returns a row (canvasX1 == canvasX0); it is
        // ledgered, exactly as iOS ledgers it, so the two files line up.
        ++hist[outcomeName(tail.outcome)];
        // seq −1, matching the device writer — see appendTailFlushLine.
        mine.push_back(std::make_pair((long long)-1,
                                      std::string(outcomeName(tail.outcome))));
        if (opt.writeLedger && !R->ledgerPath.empty()) appendTailFlushLine(ledgerText, tail);
        // ── THE FINAL REPUBLISH, the tick the operator's LAST look is ────
        // RNISPanoCore.mm:1839-1846 renders one more preview from the FINISHED
        // engine with `windowAlongPx = 0` and `leadOut = false` — the tail
        // flush has just committed the region that was provisional, so there
        // is nothing provisional left. Reproduced here with the same two
        // arguments, and flagged `finalRepublish` so it is never read as a
        // live tick. It is also the row that shows the provisional boundary
        // GONE, which is the control for every row above it.
        if (pv.enabled) {
            previewTickNow(/*seq=*/-1, previewLastTsNs, /*windowOverride=*/0,
                           /*leadOutThisTick=*/false, /*finalRepublish=*/true);
        }
    }

    R->stats = engine.stats();
    R->abortReason = R->stats.abortReason;
    R->holes = (int)engine.unpaintedRuns().size();

    // The device's own finished dimensions, so the size comparison lives in
    // the report instead of needing a second tool to join two files.
    if (haveMetaText) {
        mj::Span root, cv;
        if (mj::parseDocument(metaText, &root) &&
            mj::member(metaText, root, "canvas", &cv)) {
            const char* keys[3] = {"outputW", "outputH", "paintedW"};
            int* dst[3] = {&R->deviceOutputW, &R->deviceOutputH, &R->devicePaintedW};
            for (int k = 0; k < 3; ++k) {
                mj::Span v;
                bool ok = false;
                if (mj::member(metaText, cv, keys[k], &v)) {
                    const double x = mj::asNumber(metaText, v, &ok);
                    if (ok && std::isfinite(x)) *dst[k] = (int)std::lround(x);
                }
            }
        }
    }

    {
        const double t0 = nowMs();
        cv::Mat canvas;
        int lo = 0, hi = 0;
        const bool have = engine.finalCanvas(canvas, opt.canvasCropPad, &lo, &hi) &&
                          !canvas.empty();
        if (have) { R->canvasW = canvas.cols; R->canvasH = canvas.rows; }
        if (have && opt.writeCanvas && !R->canvasPath.empty()) {
            std::string err;
            R->canvasWritten = publishJpegAtomically(R->canvasPath, canvas,
                                                     opt.canvasQuality, &err);
            if (!R->canvasWritten) R->writeError = "canvas: " + err;
        }
        R->finalizeMs = nowMs() - t0;
    }

    if (opt.writeLedger && !R->ledgerPath.empty()) {
        std::string err;
        if (!writeFile(R->ledgerPath, ledgerText, &err)) {
            R->writeError += (R->writeError.empty() ? "" : "; ") + ("ledger: " + err);
        }
    }

    if (!R->previewJsonlPath.empty()) {
        std::string err;
        if (!writeFile(R->previewJsonlPath, previewText, &err)) {
            R->writeError += (R->writeError.empty() ? "" : "; ") +
                             ("preview.jsonl: " + err);
            R->previewJsonlPath.clear();
        }
    }

    // ── 7. histogram + buckets ──────────────────────────────────────────
    for (size_t i = 0; i < kOutcomeCount; ++i) {
        const char* n = outcomeName(kAllOutcomes[i]);
        const int c = hist[n];
        R->outcomeCounts.push_back(std::make_pair(std::string(n), c));
        switch (bucketOf(kAllOutcomes[i])) {
            case Bucket::Painted:  R->painted  += c; break;
            case Bucket::Held:     R->held     += c; break;
            case Bucket::Rejected: R->rejected += c; break;
            case Bucket::Skipped:  R->skipped  += c; break;
            case Bucket::Other:    R->other    += c; break;
        }
    }
    R->msP50 = percentile(ingestMs, 0.50);
    R->msP95 = percentile(ingestMs, 0.95);
    for (size_t i = 0; i < ingestMs.size(); ++i) R->msMax = std::max(R->msMax, ingestMs[i]);

    // ── 8. the oracle diff ──────────────────────────────────────────────
    if (opt.compareLedger) {
        std::string oracleText;
        const std::string oraclePath = joinPath(R->packDirResolved, "ledger.jsonl");
        if (readFile(oraclePath, &oracleText)) {
            std::vector<std::pair<long long, std::string> > theirs;
            scanLedgerOutcomes(oracleText, &theirs, &R->oracleMalformed);
            R->haveOracle = true;
            R->oracleRows = (int)theirs.size();

            std::map<std::string, int> ohist;
            for (size_t i = 0; i < kOutcomeCount; ++i) ohist[outcomeName(kAllOutcomes[i])] = 0;
            std::map<long long, std::string> byseq;
            for (size_t i = 0; i < theirs.size(); ++i) {
                ++ohist[theirs[i].second];
                // The TAIL FLUSH row repeats the last painted frame's seq, so a
                // plain map would drop one of the two.  Keeping the FIRST is
                // what makes the per-seq diff compare like with like (both
                // sides' tail rows are excluded from the join the same way).
                byseq.insert(std::make_pair(theirs[i].first, theirs[i].second));
            }
            for (std::map<std::string, int>::const_iterator it = ohist.begin();
                 it != ohist.end(); ++it) {
                R->oracleCounts.push_back(std::make_pair(it->first, it->second));
            }

            std::map<long long, std::string> mineBySeq;
            for (size_t i = 0; i < mine.size(); ++i) {
                mineBySeq.insert(std::make_pair(mine[i].first, mine[i].second));
            }
            for (std::map<long long, std::string>::const_iterator it = mineBySeq.begin();
                 it != mineBySeq.end(); ++it) {
                std::map<long long, std::string>::const_iterator o = byseq.find(it->first);
                if (o == byseq.end()) { ++R->replayOnlySeqs; continue; }
                if (o->second == it->second) {
                    ++R->outcomeAgree;
                } else {
                    ++R->outcomeDisagree;
                    if (R->firstDivergenceSeq < 0) {
                        R->firstDivergenceSeq = it->first;
                        R->firstDivergenceDetail =
                            "seq " + std::to_string(it->first) + ": device=" +
                            o->second + " replay=" + it->second;
                    }
                }
            }
            for (std::map<long long, std::string>::const_iterator it = byseq.begin();
                 it != byseq.end(); ++it) {
                if (mineBySeq.find(it->first) == mineBySeq.end()) ++R->oracleOnlySeqs;
            }
        }
    }

    R->ok = true;
    return true;
}

}  // namespace

bool replayPack(const ReplayOptions& opt, ReplayReport* report) {
    if (report == nullptr) return false;
    *report = ReplayReport();
    // THE BOUNDARY.  A JNI caller cannot unwind a C++ exception and a crashed
    // field build reports nothing at all, so everything below becomes a string.
    try {
        return replayPackBody(opt, report);
    } catch (const cv::Exception& e) {
        report->ok = false;
        report->error = std::string("cv::Exception: ") + e.what();
        return false;
    } catch (const std::exception& e) {
        report->ok = false;
        report->error = std::string("std::exception: ") + e.what();
        return false;
    } catch (...) {
        report->ok = false;
        report->error = "unknown non-standard exception";
        return false;
    }
}

// ── public: the report as JSON ──────────────────────────────────────────────

std::string reportToJson(const ReplayReport& r) {
    std::string s;
    s.reserve(4096);
    const auto strField = [&](const char* k, const std::string& v, bool first = false) {
        if (!first) s += ",";
        s += "\""; s += k; s += "\":";
        appendJsonString(s, v);
    };
    const auto intField = [&](const char* k, long long v) {
        s += ",\""; s += k; s += "\":";
        appendInt(s, v);
    };
    const auto numField = [&](const char* k, double v) {
        s += ",\""; s += k; s += "\":";
        appendNum(s, v);
    };
    const auto boolField = [&](const char* k, bool v) {
        s += ",\""; s += k; s += "\":";
        s += (v ? "true" : "false");
    };
    const auto strArray = [&](const char* k, const std::vector<std::string>& v) {
        s += ",\""; s += k; s += "\":[";
        for (size_t i = 0; i < v.size(); ++i) {
            if (i) s += ",";
            appendJsonString(s, v[i]);
        }
        s += "]";
    };
    const auto countObj = [&](const char* k,
                              const std::vector<std::pair<std::string, int> >& v) {
        s += ",\""; s += k; s += "\":{";
        for (size_t i = 0; i < v.size(); ++i) {
            if (i) s += ",";
            appendJsonString(s, v[i].first);
            s += ":";
            appendInt(s, v[i].second);
        }
        s += "}";
    };

    s += "{";
    strField("packDirResolved", r.packDirResolved, true);
    strField("trackPath", r.trackPath);
    strField("framesDir", r.framesDir);
    strField("metaPath", r.metaPath);
    boolField("haveMeta", r.haveMeta);
    boolField("ok", r.ok);
    strField("error", r.error);
    strField("writeError", r.writeError);

    intField("rowsTotal", r.rowsTotal);
    intField("framesRead", r.framesRead);
    intField("rowsMalformed", r.rowsMalformed);
    intField("rowsTruncated", r.rowsTruncated);
    intField("rowsMissingTracking", r.rowsMissingTracking);
    strField("firstMalformedDetail", r.firstMalformedDetail);
    intField("framesMissing", r.framesMissing);
    intField("framesUnreadable", r.framesUnreadable);
    intField("framesIngested", r.framesIngested);
    intField("intrinsicsRescaled", r.intrinsicsRescaled);
    intField("framesTransposed", r.framesTransposed);
    intField("grayWorkSizeCorrected", r.grayWorkSizeCorrected);
    strArray("framesMissingExamples", r.framesMissingExamples);

    countObj("outcomeCounts", r.outcomeCounts);
    intField("painted", r.painted);
    intField("held", r.held);
    intField("rejected", r.rejected);
    intField("skipped", r.skipped);
    intField("other", r.other);
    intField("holes", r.holes);
    strField("abortReason", r.abortReason);

    numField("msP50", r.msP50);
    numField("msP95", r.msP95);
    numField("msMax", r.msMax);
    numField("totalMs", r.totalMs);
    numField("loadMsTotal", r.loadMsTotal);
    numField("finishMs", r.finishMs);
    numField("finalizeMs", r.finalizeMs);

    intField("canvasW", r.canvasW);
    intField("canvasH", r.canvasH);
    boolField("canvasWritten", r.canvasWritten);
    boolField("canvasCropPadApplied", r.canvasCropPadApplied);
    intField("deviceOutputW", r.deviceOutputW);
    intField("deviceOutputH", r.deviceOutputH);
    intField("devicePaintedW", r.devicePaintedW);
    strField("canvasPath", r.canvasPath);
    strField("ledgerPath", r.ledgerPath);

    // The engine's own summary, the fields a port actually gets graded on.
    s += ",\"stats\":{";
    s += "\"seen\":";            appendInt(s, (long long)r.stats.seen);
    s += ",\"painted\":";        appendInt(s, (long long)r.stats.painted);
    s += ",\"paintedW\":";       appendInt(s, r.stats.paintedW);
    s += ",\"paintedH\":";       appendInt(s, r.stats.paintedH);
    s += ",\"canvasW\":";        appendInt(s, r.stats.canvasW);
    s += ",\"canvasH\":";        appendInt(s, r.stats.canvasH);
    s += ",\"outputW\":";        appendInt(s, r.stats.outputW);
    s += ",\"outputH\":";        appendInt(s, r.stats.outputH);
    // The frame `outputW/H` are expressed in — without it a reader comparing a
    // replay against a device pack cannot tell a transposed output from a
    // differently-shaped one.
    s += ",\"outputRotationCwDeg\":"; appendInt(s, r.stats.outputRotationCwDeg);
    s += ",\"axis\":";           appendInt(s, r.stats.axis);
    s += ",\"sweepSign\":";      appendInt(s, r.stats.sweepSign);
    s += ",\"axisLatched\":";    s += (r.stats.axisLatched ? "true" : "false");
    s += ",\"latchWasWeak\":";   s += (r.stats.latchWasWeak ? "true" : "false");
    s += ",\"relatchCount\":";   appendInt(s, r.stats.relatchCount);
    s += ",\"stalled\":";        s += (r.stats.stalled ? "true" : "false");
    s += ",\"maxRectifyDeg\":";  appendNum(s, r.stats.maxRectifyDeg);
    s += ",\"maxAdvancePxResolved\":"; appendNum(s, r.stats.maxAdvancePxResolved);
    s += ",\"clippedFrames\":";  appendInt(s, (long long)r.stats.clippedFrames);
    s += ",\"clippedColumns\":"; appendInt(s, (long long)r.stats.clippedColumns);
    s += ",\"d8JogRefusals\":";  appendInt(s, (long long)r.stats.d8JogRefusals);
    s += ",\"d8JogForced\":";    appendInt(s, (long long)r.stats.d8JogForced);
    // The low-light registration gate's counters (0 in log-only mode).
    s += ",\"crossGatedTexture\":"; appendInt(s, (long long)r.stats.crossGatedTexture);
    s += ",\"crossGatedPeak\":";    appendInt(s, (long long)r.stats.crossGatedPeak);
    s += ",\"crossGatedPeriod\":";  appendInt(s, (long long)r.stats.crossGatedPeriod);
    s += ",\"leadRepaintStrips\":";
    appendInt(s, (long long)r.stats.leadRepaintStrips);
    s += ",\"leadRepaintPx\":"; appendNum(s, r.stats.leadRepaintPx);
    // Trajectory continuation (Config::crossTraj) — the tail's and the seed's.
    s += ",\"tailTrajApplied\":"; s += (r.stats.tailTrajApplied ? "true" : "false");
    s += ",\"tailTrajSlope\":"; appendNum(s, r.stats.tailTrajSlope);
    s += ",\"tailTrajFan\":"; appendNum(s, r.stats.tailTrajFan);
    s += ",\"tailTrajStepPx\":"; appendNum(s, r.stats.tailTrajStepPx);
    s += ",\"tailTrajStepFan\":"; appendNum(s, r.stats.tailTrajStepFan);
    s += ",\"tailTrajSamples\":"; appendInt(s, (long long)r.stats.tailTrajSamples);
    s += ",\"tailTrajBands\":"; appendInt(s, (long long)r.stats.tailTrajBands);
    s += ",\"tailTrajResponse\":"; appendNum(s, r.stats.tailTrajResponse);
    s += ",\"seedTrajApplied\":"; s += (r.stats.seedTrajApplied ? "true" : "false");
    s += ",\"seedTrajSlope\":"; appendNum(s, r.stats.seedTrajSlope);
    s += ",\"seedTrajFan\":"; appendNum(s, r.stats.seedTrajFan);
    s += ",\"seedTrajStepPx\":"; appendNum(s, r.stats.seedTrajStepPx);
    s += ",\"seedTrajStepFan\":"; appendNum(s, r.stats.seedTrajStepFan);
    s += ",\"seedTrajSamples\":"; appendInt(s, (long long)r.stats.seedTrajSamples);
    s += ",\"seedTrajRepaintPx\":"; appendNum(s, r.stats.seedTrajRepaintPx);
    s += ",\"canvasGrowths\":";  appendInt(s, (long long)r.stats.canvasGrowths);
    s += ",\"corrOriginClampedFrames\":";
    appendInt(s, (long long)r.stats.corrOriginClampedFrames);
    s += "}";

    boolField("haveOracle", r.haveOracle);
    intField("oracleRows", r.oracleRows);
    intField("oracleMalformed", r.oracleMalformed);
    countObj("oracleCounts", r.oracleCounts);
    intField("outcomeAgree", r.outcomeAgree);
    intField("outcomeDisagree", r.outcomeDisagree);
    intField("oracleOnlySeqs", r.oracleOnlySeqs);
    intField("replayOnlySeqs", r.replayOnlySeqs);
    intField("firstDivergenceSeq", r.firstDivergenceSeq);
    strField("firstDivergenceDetail", r.firstDivergenceDetail);

    strArray("configFound", r.configFound);
    strArray("configDefaulted", r.configDefaulted);
    strArray("overridesApplied", r.overridesApplied);
    strArray("overridesUnknown", r.overridesUnknown);
    strArray("overridesMalformed", r.overridesMalformed);

    // ── the preview instrumentation.  `previewEnabled:false` ⇒ NOT MEASURED
    //    — every count under it is 0 because none was asked for.
    boolField("previewEnabled", r.previewEnabled);
    intField("previewTicks", r.previewTicks);
    intField("previewPublished", r.previewPublished);
    intField("previewRefused", r.previewRefused);
    intField("previewSeeded", r.previewSeeded);
    intField("previewImagesWritten", r.previewImagesWritten);
    boolField("previewImagesCapped", r.previewImagesCapped);
    intField("previewImageWriteFailed", r.previewImageWriteFailed);
    numField("previewMsTotal", r.previewMsTotal);
    strField("previewJsonlPath", r.previewJsonlPath);
    strField("previewImageDir", r.previewImageDir);
    s += ",\"previewSettings\":{";
    s += "\"intervalMs\":";       appendNum(s, r.previewSettings.intervalMs);
    s += ",\"maxAlong\":";        appendInt(s, r.previewSettings.maxAlong);
    s += ",\"maxCross\":";        appendInt(s, r.previewSettings.maxCross);
    s += ",\"windowAlongPx\":";   appendInt(s, r.previewSettings.windowAlongPx);
    s += ",\"windowCrossMult\":"; appendNum(s, r.previewSettings.windowCrossMult);
    s += ",\"cropPad\":";         s += (r.previewSettings.cropPad ? "true" : "false");
    s += ",\"leadOut\":";         s += (r.previewSettings.leadOut ? "true" : "false");
    s += ",\"quality\":";         appendInt(s, r.previewSettings.quality);
    s += "}";
    strArray("previewSettingsFound", r.previewSettings.found);
    strArray("previewSettingsDefaulted", r.previewSettings.defaulted);
    strField("previewNote", r.previewNote);

    strField("fidelityNote", r.fidelityNote);
    strField("attitudeNote", r.attitudeNote);
    strField("canvasNote", r.canvasNote);
    s += "}";
    return s;
}

}  // namespace replay
}  // namespace pano
}  // namespace rnis
