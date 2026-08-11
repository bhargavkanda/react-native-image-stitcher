// Generalized on-device stitch probe for the offline debug-pack compare tool.
//
// Runs the REAL retailens::stitchFramePaths (the exact high-level PANORAMA path
// finalize() uses) with a config supplied on argv, so the offline tool can:
//   - replay a field pack's EXACT config (reproduce the field stitch time), and
//   - sweep ONE factor (compose MP, threads, seam, ...) for ablation RCA.
//
// Emits a single machine-parseable JSON line on stdout (RESULT {...}) plus the
// stitcher's own log lines on stderr (incl. the [dimstat] per-phase resolution
// budgets), so a wrapper can parse timing + dims without scraping prose.
//
// argv: <out.jpg> <composeMP> <regMP> <rangeWidth> <numThreads> <seam>
//       <warper> <orientation> <mode> <kf0> [kf1 ...]
//   composeMP/regMP <= 0  -> library default (compose: RAM-gated 1.0/0.6)
//   seam    : graphcut | voronoi | skip
//   warper  : plane | spherical | cylindrical
//   orient  : portrait | landscape-left | landscape-right | portrait-upside-down
//   mode    : panorama | scans | auto
#include "stitcher.hpp"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <chrono>

static void logcb(int level, const char* tag, const char* msg) {
    std::fprintf(stderr, "[L%d]%s %s\n", level, tag ? tag : "", msg ? msg : "");
}

static retailens::StitchMode parseMode(const std::string& m) {
    // stitchModeResolved from a pack is already resolved (panorama|scans);
    // anything else (incl. "auto") falls back to the fleet default Panorama.
    if (m == "scans") return retailens::StitchMode::Scans;
    return retailens::StitchMode::Panorama;
}

int main(int argc, char** argv) {
    if (argc < 11) {
        std::fprintf(stderr,
            "usage: %s <out.jpg> <composeMP> <regMP> <rangeWidth> <numThreads> "
            "<seam> <warper> <orientation> <mode> <kf0> [kf1 ...]\n", argv[0]);
        return 2;
    }
    const std::string out       = argv[1];
    const double composeMP      = std::atof(argv[2]);
    const double regMP          = std::atof(argv[3]);
    const int    rangeWidth     = std::atoi(argv[4]);
    const int    numThreads     = std::atoi(argv[5]);
    const std::string seam      = argv[6];
    const std::string warper    = argv[7];
    const std::string orient    = argv[8];
    const std::string mode      = argv[9];
    std::vector<std::string> paths;
    for (int i = 10; i < argc; ++i) paths.emplace_back(argv[i]);

    retailens::StitchConfig cfg;
    cfg.stitchMode           = parseMode(mode);
    cfg.useManualPipeline    = false;            // fleet path: high-level PANORAMA
    cfg.warperType           = warper;
    cfg.blenderType          = "multiband";
    cfg.seamFinderType       = seam;
    cfg.captureOrientation   = orient;
    cfg.useInscribedRectCrop = false;
    cfg.registrationResolMP  = (regMP     > 0.0) ? regMP     : -1.0;
    cfg.compositingResolMP   = (composeMP > 0.0) ? composeMP : -1.0;
    cfg.jpegQuality          = 95;
    cfg.rangeMatcherWidth    = rangeWidth;
    cfg.numThreads           = numThreads;

    const auto t0 = std::chrono::steady_clock::now();
    const retailens::StitchResult r = retailens::stitchFramePaths(paths, out, cfg, logcb);
    const auto t1 = std::chrono::steady_clock::now();
    const long long wallMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    // Single JSON line on stdout for the wrapper to parse.
    std::printf(
        "RESULT {\"success\":%d,\"errorCode\":%d,\"width\":%d,\"height\":%d,"
        "\"framesRequested\":%d,\"framesIncluded\":%d,\"durationMs\":%lld,"
        "\"wallMs\":%lld,\"composeMP\":%.4f,\"regMP\":%.4f,\"rangeWidth\":%d,"
        "\"numThreads\":%d,\"seam\":\"%s\",\"warper\":\"%s\",\"mode\":\"%s\","
        "\"keyframes\":%zu}\n",
        (int)r.success, (int)r.errorCode, r.width, r.height,
        r.framesRequested, r.framesIncluded, (long long)r.durationMs,
        wallMs, composeMP, regMP, rangeWidth, numThreads,
        seam.c_str(), warper.c_str(), mode.c_str(), paths.size());
    std::fprintf(stderr, "debugSummary: %s\n", r.debugSummary.c_str());
    if (!r.errorMessage.empty())
        std::fprintf(stderr, "errorMessage: %s\n", r.errorMessage.c_str());
    return r.success ? 0 : 1;
}
