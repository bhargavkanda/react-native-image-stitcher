// SPDX-License-Identifier: Apache-2.0
// See stitch_mode_probe.hpp for why this exists and why the decision is
// deliberately asymmetric.

#include "stitch_mode_probe.hpp"

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/features2d.hpp>
#include <opencv2/stitching/detail/matchers.hpp>

#include <algorithm>
#include <chrono>
#include <cstdio>

namespace rnis {
namespace {

void logf(const ProbeLogFn& log, int level, const char* fmt, ...) {
    if (!log) return;
    char buf[512];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    log(level, "stitchModeProbe", buf);
}

/// Evenly sample at most `maxN` paths — a 30-frame capture does not need every
/// frame to establish which model fits, and the cost is linear in image count.
std::vector<std::string> samplePaths(const std::vector<std::string>& in, int maxN) {
    if (maxN <= 0 || static_cast<int>(in.size()) <= maxN) return in;
    std::vector<std::string> out;
    out.reserve(static_cast<size_t>(maxN));
    const double step = static_cast<double>(in.size() - 1) / (maxN - 1);
    for (int i = 0; i < maxN; ++i) {
        out.push_back(in[static_cast<size_t>(i * step + 0.5)]);
    }
    return out;
}

struct ModelScore {
    int strongPairs = 0;
    double meanConf = 0.0;
    int pairsWithH = 0;
};

/// Score one matcher over precomputed features.
///
/// `MatchesInfo::confidence` is exactly what `leaveBiggestComponent` thresholds
/// on, so `strongPairs` is a count of pairs the STITCH would keep connected —
/// not a proxy for it.
ModelScore scoreMatcher(cv::detail::FeaturesMatcher& matcher,
                        const std::vector<cv::detail::ImageFeatures>& feats,
                        double strongConf) {
    std::vector<cv::detail::MatchesInfo> pairwise;
    matcher(feats, pairwise);
    matcher.collectGarbage();

    ModelScore s;
    const int n = static_cast<int>(feats.size());
    double sum = 0.0;
    for (int i = 0; i < n; ++i) {
        for (int j = i + 1; j < n; ++j) {
            const cv::detail::MatchesInfo& mi = pairwise[static_cast<size_t>(i * n + j)];
            if (mi.H.empty() || mi.confidence <= 0.0) continue;
            s.pairsWithH += 1;
            sum += mi.confidence;
            if (mi.confidence >= strongConf) s.strongPairs += 1;
        }
    }
    s.meanConf = s.pairsWithH > 0 ? sum / s.pairsWithH : 0.0;
    return s;
}

}  // namespace

StitchModeProbeResult probeStitchMode(const std::vector<std::string>& framePaths,
                                      const StitchModeProbeConfig& cfg,
                                      const ProbeLogFn& log) {
    StitchModeProbeResult r;
    const auto t0 = std::chrono::steady_clock::now();
    const auto finish = [&]() {
        r.elapsedMs = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - t0).count();
        return r;
    };

    if (framePaths.size() < 2) {
        r.error = "too-few-frames";
        return finish();
    }

    const std::vector<std::string> paths = samplePaths(framePaths, cfg.maxImages);

    // ── Features.  Images are decoded, downscaled, fed to the finder and
    // RELEASED one at a time: only the descriptors survive the loop.  This runs
    // immediately before the stitch's own allocation peak, and this repo has a
    // documented jetsam RCA, so holding every full-resolution Mat here would be
    // the wrong place to be generous.
    std::vector<cv::detail::ImageFeatures> feats;
    feats.reserve(paths.size());
    cv::Ptr<cv::ORB> finder = cv::ORB::create(cfg.orbFeatures);

    for (const std::string& p : paths) {
        cv::Mat img = cv::imread(p, cv::IMREAD_GRAYSCALE);
        if (img.empty()) {
            logf(log, 1, "unreadable frame, skipping: %s", p.c_str());
            continue;
        }
        const int longest = std::max(img.cols, img.rows);
        if (cfg.workingMaxSide > 0 && longest > cfg.workingMaxSide) {
            const double s = static_cast<double>(cfg.workingMaxSide) / longest;
            cv::Mat small;
            cv::resize(img, small, cv::Size(), s, s, cv::INTER_AREA);
            img = small;   // full-size Mat released here
        }
        cv::detail::ImageFeatures f;
        try {
            cv::detail::computeImageFeatures(finder, img, f);
        } catch (const cv::Exception& e) {
            logf(log, 2, "feature computation threw: %s", e.what());
            r.error = "features-threw";
            return finish();
        }
        // Descriptors are needed; the source image is not.
        f.img_size = img.size();
        img.release();
        if (f.descriptors.empty() || f.keypoints.empty()) {
            logf(log, 1, "no features in a frame, skipping");
            continue;
        }
        feats.push_back(std::move(f));
    }

    if (feats.size() < 2) {
        r.error = "too-few-featured-frames";
        return finish();
    }
    r.imagesUsed = static_cast<int>(feats.size());

    // ── Score both models over the SAME features, so neither is advantaged by
    // a different detector or working size.
    ModelScore h, a;
    try {
        cv::detail::BestOf2NearestMatcher hm(false, cfg.matchConf);
        h = scoreMatcher(hm, feats, cfg.strongPairConf);
        cv::detail::AffineBestOf2NearestMatcher am(false, false, cfg.matchConf);
        a = scoreMatcher(am, feats, cfg.strongPairConf);
    } catch (const cv::Exception& e) {
        logf(log, 2, "matching threw: %s", e.what());
        r.error = "matching-threw";
        return finish();
    }

    r.homographyStrongPairs = h.strongPairs;
    r.affineStrongPairs = a.strongPairs;
    r.homographyMeanConf = h.meanConf;
    r.affineMeanConf = a.meanConf;

    // Neither model registered anything — the probe has no opinion, and saying
    // "panorama" here would be a guess dressed as a measurement.
    if (h.pairsWithH == 0 && a.pairsWithH == 0) {
        r.error = "no-pairs";
        return finish();
    }

    // ── The asymmetric decision.  Affine must win by a MARGIN.  Ties and
    // near-ties resolve to PANORAMA because that failure is recoverable via the
    // ladder's own scans rungs, whereas a wrong SCANS is terminal.
    r.preferScans = a.strongPairs >= h.strongPairs + cfg.scansStrongPairMargin;
    r.ok = true;

    logf(log, 0,
         "n=%d homog=%.2f/%d affine=%.2f/%d margin=%d -> %s (%.0f ms)",
         r.imagesUsed, h.meanConf, h.strongPairs, a.meanConf, a.strongPairs,
         cfg.scansStrongPairMargin, r.preferScans ? "scans" : "panorama",
         std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now() - t0).count());
    return finish();
}

}  // namespace rnis
