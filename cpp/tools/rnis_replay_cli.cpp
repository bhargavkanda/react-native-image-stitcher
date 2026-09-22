// SPDX-License-Identifier: Apache-2.0
//
// rnis_replay_cli — run the pano+ engine over a pack directory, off-device.
//
// ⚠ TWO SOURCE COMMENTS NAMED THIS DRIVER BEFORE IT EXISTED
// (`rnis_pano.hpp:1289`, `rnis_pano_test.cpp:10638` both cite it as the thing
// that answers a question offline).  `replayPack` has always been here; what
// was missing was a `main` — so every pack question was answered by hand
// instead, or not at all.
//
// It is only useful on a pack that carries `track.jsonl`, and until
// 2026-09-22 the two Android arms that ship wrote that file EMPTY (see
// `Options::writeTrack`), so in practice nothing the operator captured could
// be replayed.  Both halves are now true at once, which is the point.
//
//   rnis_replay_cli <packDir> [outDir] [knob=value ...]
//
// `knob=value` goes through the same override table `meta.json`'s config
// block does, so an A/B is one flag:
//
//   rnis_replay_cli pack out-a                 # the pack's own config
//   rnis_replay_cli pack out-b canvasScale=0.67
//
// Exit status is 0 only when the replay reports ok.
#include "rnis_pano_replay.hpp"

#include <cstdio>
#include <string>

int main(int argc, char** argv) {
    using namespace rnis::pano::replay;
    if (argc < 2) {
        std::fprintf(stderr,
                     "usage: %s <packDir> [outDir] [knob=value ...]\n", argv[0]);
        return 2;
    }
    ReplayOptions o;
    o.packDir = argv[1];
    // The pack's OWN config is the baseline, so an override is a DELTA against
    // the sweep that produced it rather than against engine defaults — the
    // distinction that makes an A/B mean anything.
    o.useMetaConfig = true;
    if (argc > 2) { o.outDir = argv[2]; o.writeCanvas = true; }
    for (int i = 3; i < argc; ++i) {
        const std::string kv(argv[i]);
        const size_t e = kv.find('=');
        if (e == std::string::npos) {
            std::fprintf(stderr, "not a knob=value: %s\n", argv[i]);
            return 2;
        }
        o.configOverrides.push_back(std::make_pair(kv.substr(0, e), kv.substr(e + 1)));
    }

    ReplayReport r;
    const bool ok = replayPack(o, &r);
    std::printf("ok=%d%s%s\n", (int)(ok && r.ok),
                r.error.empty() ? "" : " error=", r.error.c_str());
    // The four numbers that say whether the pack is REPLAYABLE, not merely
    // present: a row that could not be parsed, a row whose frame is missing,
    // and a row that had to fall back to a default tracking state are each
    // counted rather than silently skipped.
    std::printf("rowsTotal=%d rowsMalformed=%d rowsMissingTracking=%d "
                "framesMissing=%d framesIngested=%d\n",
                r.rowsTotal, r.rowsMalformed, r.rowsMissingTracking,
                r.framesMissing, r.framesIngested);
    std::printf("canvas=%dx%d painted=%d written=%d\n",
                r.canvasW, r.canvasH, r.painted, (int)r.canvasWritten);
    for (size_t i = 0; i < r.framesMissingExamples.size() && i < 3; ++i) {
        std::printf("  missing: %s\n", r.framesMissingExamples[i].c_str());
    }
    return (ok && r.ok) ? 0 : 1;
}
