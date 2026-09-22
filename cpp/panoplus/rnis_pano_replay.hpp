// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_replay — drive the pano+ engine over a PACK DIRECTORY.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// The Android port needs three answers before a device is ever plugged in:
//
//   1. does the engine RUN on this platform's toolchain at all,
//   2. how FAST is one ingest() on this hardware,
//   3. does it produce the SAME decisions the shipped iOS arm produced?
//
// All three are answerable from a pack, which is a complete replayable record
// of one sweep (track.jsonl = every FrameInput field, frames/ = the pixels,
// ledger.jsonl = what iOS decided, meta.json = the Config it decided under).
// So the driver that reads a pack is written ONCE, here, in the same
// platform-free C++17 + OpenCV subset the engine itself is written in — and
// the Mac host runs it today under gtest while the JNI entry runs the
// IDENTICAL translation unit tomorrow.  A driver written twice would diverge
// on exactly the thing it exists to measure.
//
// ── WHAT THIS DELIBERATELY DOES NOT OFFER ───────────────────────────────────
//
// TAU AND BASIS ARE NOT REPLAYABLE FROM A PACK, and this API does not pretend
// otherwise.  `track.jsonl` carries the quaternion the engine CONSUMED — the
// host had already resampled attitude at (pts + tau) and applied the
// device→camera basis C before writing the row — and the raw CoreMotion
// samples those were derived from are not in the pack (verified 2026-08-31
// against a v13 pack: `pose_source.json` carries only counters and provenance,
// `samplesPushed`/`samplesHeld`, never the samples).  A `tauOverrideS` knob
// here could therefore only re-time nothing, and would report a difference of
// zero as evidence that tau does not bind.  See `ReplayReport::attitudeNote`,
// which states this in every report rather than leaving it to be rediscovered.
//
// ── FIDELITY: WHAT A REPLAY IS AND IS NOT ───────────────────────────────────
//
// A replay is NOT a bit-parity re-run of the device sweep, and the divergence
// is in the INPUT, not the engine:
//
//   · the device ingested the camera's raw NV12; the pack carries JPEG at
//     `pack.packFrameQuality` (70 on the operator's packs).  Lossy.
//   · the device's `grayWork` came from the NV12 **Y plane** — video-range
//     BT.601 luma, no colour conversion.  A replay has only the decoded BGR,
//     so its luma is `cv::COLOR_BGR2GRAY` of a JPEG, i.e. full-range and
//     twice-quantised.  Registration input therefore differs by an
//     approximately affine map plus JPEG noise.
//
// Both are stated in `ReplayReport::fidelityNote` on every run.  The right way
// to read a replay against a pack's own ledger is as a DIFFERENTIAL instrument
// (arm A vs arm B, same inputs) and as a THROUGHPUT instrument (ms per
// ingest); reading a per-row outcome disagreement as an engine defect is the
// mistake this comment exists to prevent.

#ifndef RNIS_PANO_REPLAY_HPP
#define RNIS_PANO_REPLAY_HPP

#include <string>
#include <utility>
#include <vector>

#include "rnis_pano.hpp"

namespace rnis {
namespace pano {
namespace replay {

// ── THE HOST'S PREVIEW KNOBS, AS A PACK RECORDS THEM ───────────────────────
//
// `meta.json → config.pack` carries the seven `PackOptions` members that fix
// the live preview's geometry (RNISPanoCore.mm writes them at its
// `@"pack": @{…}` block), and `meta.json → preview.leadOutEnabled` carries the
// eighth.  They are NOT engine `Config` knobs, so `applyMetaConfig` does not
// see them and a replay that wants to reproduce the geometry the OPERATOR saw
// has to read them separately.  Hard-coding the compiled iOS defaults instead
// would be wrong on the operator's own packs: `previewWindowCrossMult` is
// computed on the host from the on-screen capsule's ratio and reads 6.577 on
// the 2026-09-05 packs against a 1.44 default.
struct PackPreviewSettings {
    double intervalMs = 120.0;     ///< pack: previewIntervalMs (the FLOOR)
    int    maxAlong = 2000;        ///< pack: previewMaxAlong
    int    maxCross = 800;         ///< pack: previewMaxCross
    int    windowAlongPx = 0;      ///< pack: previewWindowAlongPx (0 ⇒ use mult)
    double windowCrossMult = 1.44; ///< pack: previewWindowCrossMult
    bool   cropPad = true;         ///< pack: previewCropPad
    int    quality = 82;           ///< pack: previewQuality
    bool   leadOut = true;         ///< meta.preview.leadOutEnabled
    /// Which of the eight were actually READ, and which fell back to the
    /// compiled iOS default.  Named, not counted — a pack that does not carry
    /// `previewWindowCrossMult` is a real difference between the device run
    /// and this one, and it changes where the window edge lands.
    std::vector<std::string> found;
    std::vector<std::string> defaulted;
};

/// Read the eight preview knobs out of a pack's whole `meta.json` text.
/// Returns false only when the text is not an object (nothing to read); a
/// missing knob leaves the field at its iOS default and lands in `defaulted`.
/// Exposed because it is a parsing claim, and a parsing claim deserves its own
/// test rather than being reachable only through a 300-frame replay — the same
/// rule `applyMetaConfig` and `parseTrackRow` are exposed under.
bool readPackPreviewSettings(const std::string& metaText,
                             PackPreviewSettings* out);

// ── PREVIEW INSTRUMENTATION — DIAGNOSTICS, OFF BY DEFAULT ──────────────────
//
// WHY IT EXISTS.  `PreviewWindow` already carries the whole geometry of a
// published preview, and a pack summarises the LAST one into `meta.preview` —
// but there is no per-tick record anywhere, on either platform.  So when the
// operator asks "what are the two horizontal boundaries I see in the preview
// while I sweep", the numbers that would answer it exist for ~40 renders per
// sweep and are kept for one.  This writes all of them.
//
// WHY A SIDECAR AND NOT THE LEDGER.  `ledger.jsonl` is the PARITY ORACLE:
// `scanLedgerOutcomes` joins it row-for-row by `seq` against the device's own,
// and `appendLedgerLine`'s field order is load-bearing for that diff (see its
// comment).  A preview tick is not a frame outcome — it fires on a clock, not
// on an ingest, and the final republish has no frame at all — so it has no
// `seq` to join on and would either corrupt the join or need a row type the
// oracle does not have.  It goes in its OWN file, `preview.jsonl`, next to the
// ledger in `outDir`.
//
// WHEN `enabled` IS FALSE NOT ONE `previewIntoFit` CALL IS MADE, so the run is
// the run it was before this existed — see PanoReplayPreview.OffIsByteIdentical.
struct PreviewCaptureOptions {
    /// The master gate.  false ⇒ no render, no file, no cost.
    bool enabled = false;

    /// Write `<outDir>/preview.jsonl`, one row per scheduled tick.
    bool writeJsonl = true;

    /// Save the PUBLISHED image for every Nth tick into
    /// `<outDir>/preview/preview_%05d.jpg`, indexed by tick so the JSONL's
    /// `tick` joins the filename.  0 ⇒ no images (the JSONL alone).
    int imageEveryN = 1;
    /// Hard cap on images written, so a long sweep at N=1 cannot fill a disk.
    /// The report says whether it bit (`previewImagesCapped`).
    int imageMaxCount = 240;
    /// JPEG quality for those images.  <= 0 ⇒ the pack's `previewQuality`,
    /// i.e. the same encode the device applied to `preview.jpg`.
    int imageQuality = 0;

    // ── the geometry, and how to override it ────────────────────────────
    // EVERY ONE defaults to "take the pack's own value" (readPackPreviewSettings
    // above).  A negative number / -1 means exactly that; anything else forces
    // the knob, which is the A/B mechanism, and the report's
    // `previewSettings` says what was actually used either way.
    double intervalMs = -1.0;
    int    maxAlong = -1, maxCross = -1;
    int    windowAlongPx = -1;
    double windowCrossMult = -1.0;
    int    cropPad = -1;   ///< -1 pack, 0 off, 1 on
    int    leadOut = -1;   ///< -1 pack, 0 off, 1 on
};

/// What the driver was asked to do.  Every field has a safe default, so a
/// zero-initialised struct with `packDir` set is a valid request.
struct ReplayOptions {
    /// The pack.  EITHER the pack root (the directory holding `panoplus/`)
    /// OR the `panoplus/` directory itself — both are accepted and the one
    /// actually used is reported in `ReplayReport::packDirResolved`.
    std::string packDir;

    /// Where `canvas.jpg` / `ledger.jsonl` go.  EMPTY ⇒ nothing is written and
    /// the run is pure measurement (which is what the gtest suite wants, and
    /// what a read-only Android asset directory needs).
    ///
    /// REFUSED when it resolves to the pack's own `panoplus/` directory: the
    /// pack's ledger is the ORACLE this replay is graded against, and a driver
    /// that can overwrite its own oracle is a driver that can silently agree
    /// with itself.
    std::string outDir;

    /// Stop after this many TRACK ROWS have been attempted.  0 ⇒ all of them.
    /// Rows left unattempted are counted in `ReplayReport::rowsTruncated`.
    int maxFrames = 0;

    bool writeCanvas = true;
    bool writeLedger = true;

    /// JPEG quality for `canvas.jpg`, and whether the finalize applies the
    /// pad-row trim.  Defaults match the shipped iOS finalize (92 / true), so
    /// a replayed canvas is comparable with the pack's own by eye.
    int  canvasQuality = 92;
    bool canvasCropPad = true;

    /// Adopt the Config recorded in the pack's `meta.json`.  ON is what makes
    /// a replay a replay.  OFF runs the engine's compiled defaults, which is
    /// only useful for "what would today's defaults have done to this sweep".
    /// Either way `ReplayReport::configFound` / `configDefaulted` names every
    /// knob, so a report never leaves the reader guessing which arm ran.
    bool useMetaConfig = true;

    /// Config knobs to force AFTER the pack's own config is adopted, as
    /// `{"name", "value"}` string pairs — the A/B mechanism.  Names are the
    /// SAME names `meta.json` uses (they go through the same table), values
    /// parse as number / `true` / `false`.  Every entry lands in exactly one
    /// of `overridesApplied`, `overridesUnknown` or `overridesMalformed`; an
    /// unknown knob is never silently ignored.
    ///
    /// A pair of strings rather than a fixed set of typed fields because this
    /// is the surface JNI has to marshal: two `String[]`s cross the boundary
    /// with no per-knob glue, and adding a knob later needs no API change.
    std::vector<std::pair<std::string, std::string> > configOverrides;

    /// Count outcomes in the pack's own `ledger.jsonl` and diff them against
    /// what this run decided.  Costs one extra file scan.  Silently becomes a
    /// no-op — reported as `haveOracle == false` — when the pack has no
    /// ledger.
    bool compareLedger = true;

    /// Frames whose `seq` is not in `frames/` are SKIPPED AND COUNTED.  With
    /// this on, the first `frameMissingReportCap` of them are also named in
    /// `framesMissingExamples` so a truncated pack is diagnosable without a
    /// directory listing.
    int frameMissingReportCap = 8;

    /// Per-tick preview geometry + images.  OFF by default; see the struct.
    PreviewCaptureOptions preview;
};

/// Everything the run observed.  Nothing here is inferred: a count that could
/// not be measured is reported as not-measured (`haveOracle`, `canvasWritten`)
/// rather than as zero.
struct ReplayReport {
    // ── what was found on disk ──────────────────────────────────────────
    std::string packDirResolved;   ///< the `panoplus/` directory actually used
    std::string trackPath;
    std::string framesDir;
    std::string metaPath;          ///< empty when the pack had no meta.json
    bool haveMeta = false;

    /// Config knob names read OUT of `meta.json` vs left at the engine
    /// default.  A knob the pack does not carry is a real difference between
    /// the device run and this one, so it is named, not counted.
    std::vector<std::string> configFound;
    std::vector<std::string> configDefaulted;
    std::vector<std::string> overridesApplied;
    std::vector<std::string> overridesUnknown;
    std::vector<std::string> overridesMalformed;

    /// The config the engine actually ran with, after meta + overrides.
    Config resolvedConfig;

    // ── the track file ──────────────────────────────────────────────────
    int rowsTotal = 0;        ///< non-blank lines in track.jsonl
    int framesRead = 0;       ///< rows that parsed into a usable FrameInput
    int rowsMalformed = 0;    ///< rows skipped: unparseable / missing a required field
    int rowsTruncated = 0;    ///< rows not attempted because maxFrames was hit
    int rowsMissingTracking = 0;  ///< rows with no `tracking` field — see note below
    std::string firstMalformedDetail;  ///< line number + why, for the first one

    // ── the frames ──────────────────────────────────────────────────────
    int framesMissing = 0;     ///< no file at frames/frame_%06lld.jpg
    int framesUnreadable = 0;  ///< the file exists and cv::imread declined it
    int framesIngested = 0;    ///< frames actually handed to Engine::ingest
    /// Frames whose decoded raster differed from the `w`/`h` the track row
    /// declared, so the intrinsics were rescaled onto the raster — the same
    /// correction RNISPanoCore applies, counted the same way.
    int intrinsicsRescaled = 0;
    /// Frames whose decoded raster is the TRANSPOSE of the dims the track row
    /// declared — the EXIF-orientation case.  SKIPPED, never rescaled: a
    /// transpose folded into the intrinsics rescale is a plausible-looking
    /// wrong H_rect on every frame, which is worse than a missing frame.
    int framesTransposed = 0;
    /// Frames whose `grayWork` came out of `cv::resize(…, workScale, workScale)`
    /// outside the engine's own ±2 px tolerance and had to be re-resized to an
    /// explicit size.  Expected 0; a non-zero count on a new OpenCV build is
    /// the difference between "the port works" and 400 rejected-input rows
    /// that would otherwise read as an engine finding.
    int grayWorkSizeCorrected = 0;
    std::vector<std::string> framesMissingExamples;

    // ── what the engine decided ─────────────────────────────────────────
    /// THE AUTHORITATIVE RECORD.  Outcome name → count, in the order the
    /// engine's own `outcomeName()` enumerates them.  The four coarse buckets
    /// below are convenience only; when they disagree with your reading of a
    /// sweep, this is the one to trust.
    std::vector<std::pair<std::string, int> > outcomeCounts;

    /// painted   = painted + bootstrap + gap-extended + gap-break +
    ///             gap-backfilled + tail-flush   (rows that committed pixels)
    /// held      = held-backtrack + held-frontier + d8-jog-held
    /// rejected  = rejected-{low-response,out-of-cage,rectify,input,
    ///                       pose-speed,tracking}
    /// skipped   = skipped-no-advance + warming-up
    /// other     = aborted + canvas-full
    int painted = 0, held = 0, rejected = 0, skipped = 0, other = 0;

    /// The engine's own session summary, verbatim — so a JNI caller can pull
    /// any field without this struct having to mirror all sixty of them.
    SessionStats stats;
    int holes = 0;             ///< unpaintedRuns().size() — 0 is the G1 guarantee
    std::string abortReason;   ///< empty ⇒ the sweep ran clean

    // ── throughput: THE ANDROID ANSWER ──────────────────────────────────
    /// Wall time of `Engine::ingest()` alone, milliseconds, over
    /// `framesIngested` calls.  Frame decode and colour conversion are NOT in
    /// here — they are in `loadMsTotal`, because on a live Android capture
    /// that work is the camera pipeline's, not the engine's, and conflating
    /// them would inflate every projection.
    double msP50 = 0, msP95 = 0, msMax = 0, totalMs = 0;
    double loadMsTotal = 0;    ///< imread + cvtColor + resize, all frames
    double finishMs = 0;       ///< Engine::finish()
    double finalizeMs = 0;     ///< finalCanvas() + encode + write

    // ── the deliverable ─────────────────────────────────────────────────
    int  canvasW = 0, canvasH = 0;   ///< 0 when nothing was painted
    bool canvasWritten = false;
    std::string canvasPath;
    std::string ledgerPath;
    std::string writeError;    ///< non-empty ⇒ a write failed; the run did not

    /// The DEVICE's own finished dimensions, read out of `meta.json`'s
    /// `canvas` block; -1 when the pack does not carry them.  Here so the size
    /// comparison is in the report rather than left to a second tool.
    int deviceOutputW = -1, deviceOutputH = -1, devicePaintedW = -1;
    /// Whether THIS run applied the finalize pad-row trim.  It comes from
    /// `ReplayOptions::canvasCropPad`, NOT from the pack — see `canvasNote`.
    bool canvasCropPadApplied = false;
    std::string canvasNote;

    // ── the oracle diff ─────────────────────────────────────────────────
    bool haveOracle = false;   ///< false ⇒ NOT MEASURED, never "agreed"
    int  oracleRows = 0;
    int  oracleMalformed = 0;
    std::vector<std::pair<std::string, int> > oracleCounts;
    /// Per-`seq` comparison over the rows BOTH sides have.  `oracleOnlySeqs`
    /// / `replayOnlySeqs` are rows one side has and the other does not (a
    /// skipped frame, a truncated run) — they are not disagreements.
    int outcomeAgree = 0, outcomeDisagree = 0;
    int oracleOnlySeqs = 0, replayOnlySeqs = 0;
    long long firstDivergenceSeq = -1;
    std::string firstDivergenceDetail;

    // ── the preview instrumentation ─────────────────────────────────────
    /// false ⇒ NOT MEASURED.  Every count below is 0 in that case and means
    /// "not asked for", never "no previews happened".
    bool previewEnabled = false;
    int  previewTicks = 0;       ///< scheduled attempts (renders + refusals)
    int  previewPublished = 0;   ///< attempts previewIntoFit returned true for
    int  previewRefused = 0;     ///< attempts it declined (nothing painted yet)
    int  previewSeeded = 0;      ///< published rows that were the PRE-LATCH SEED
                                 ///< (band empty — the reference frame, not a band)
    int  previewImagesWritten = 0;
    bool previewImagesCapped = false;   ///< imageMaxCount stopped further writes
    int  previewImageWriteFailed = 0;
    double previewMsTotal = 0;   ///< previewIntoFit wall time, NOT in totalMs
    std::string previewJsonlPath;   ///< empty ⇒ not written
    std::string previewImageDir;    ///< empty ⇒ no images
    /// The geometry this run actually rendered at, and where each knob came
    /// from.  Read this before reading a single row of preview.jsonl.
    PackPreviewSettings previewSettings;
    std::string previewNote;

    // ── standing caveats, on every report ───────────────────────────────
    std::string fidelityNote;
    std::string attitudeNote;

    /// The run completed and the report is meaningful.  On false, `error`
    /// says why and every count above is whatever had been measured when the
    /// driver gave up.
    bool ok = false;
    std::string error;
};

/// Replay one pack.  Returns `report->ok`.
///
/// NEVER THROWS.  `cv::Exception` and `std::exception` are caught at the API
/// boundary and turned into `report->error` — the JNI caller has no way to
/// unwind a C++ exception and a crashed field build reports nothing at all.
///
/// `report` must not be null.  It is fully overwritten.
bool replayPack(const ReplayOptions& opt, ReplayReport* report);

/// The report as one JSON object, hand-rolled in the same style as the pack's
/// own writers (no JSON library is in the engine's dependency set).  This is
/// what the Android JNI entry returns and what a CI job diffs.
std::string reportToJson(const ReplayReport& r);

// ── The pieces, exposed because they are separately assertable ─────────────
// A claim about parsing is a claim that deserves its own test rather than
// being reachable only through a 400-frame replay.

/// One parsed `track.jsonl` row.  `ok == false` ⇒ `why` says what was wrong
/// and the row must be skipped and counted.
struct TrackRow {
    bool ok = false;
    std::string why;

    long long seq = 0;
    double tsNs = 0;
    double q[4] = {0, 0, 0, 1};
    double t[3] = {0, 0, 0};
    double fx = 0, fy = 0, cx = 0, cy = 0;
    int w = 0, h = 0;
    int tracking = 2;
    /// The row carried no `tracking` field, so `tracking` above is the
    /// FALLBACK (2 = normal), not a reading.  A named, counted fallback: the
    /// alternative default (0 = notAvailable) would hold the chain for the
    /// whole sweep and report a dead replay as an engine finding.
    bool trackingDefaulted = false;
    double expDurS = 0, expISO = 0;
    double arExpDurS = 0, arExpOffsetEV = 0;
    bool arExpHave = false;
};

TrackRow parseTrackRow(const std::string& line);

/// The WRITER for the row `parseTrackRow` above reads, in `RNISPanoCore.mm`'s
/// field order.
///
/// ⚠ PUBLIC, AND BESIDE ITS PARSER ON PURPOSE — the same rule
/// `appendLedgerLine` states below.  Until 2026-09-22 there were two writers
/// of this file and neither was here: iOS built the line inline in
/// `RNISPanoCore.mm` and Android built a 46-key superset in Kotlin, while the
/// two arms that actually ship (`vc-plugin`, `ar-plugin`) wrote NOTHING and
/// left a 0-byte `track.jsonl` behind — so not one capture from either arm
/// could be replayed.  A third writer that drifted from this parser would be
/// worse than none: a pack that parses but decodes differently is undiffable
/// against the device it came from.  One function, next to the code that
/// reads it.
///
/// Emits exactly the replay contract and nothing beyond it.  `tsNs` goes
/// through `appendExact` (%.17g), NEVER the `%.9g` every other double uses:
/// it carries Android's `SENSOR_TIMESTAMP` nanoseconds (~1.7e14), which %.9g
/// quantises to the millisecond, and consecutive frames would then compare
/// EQUAL and be refused as non-monotonic for the whole sweep.
void appendTrackRow(std::string& out, const TrackRow& r);

/// Adopt `meta.json`'s `config` object onto `cfg`.  Returns false only when
/// the text is not an object with a `config` member; an individual knob that
/// is absent or the wrong type leaves the field alone and lands in
/// `defaulted`.  `text` is the whole file.
bool applyMetaConfig(const std::string& text, Config& cfg,
                     std::vector<std::string>* found,
                     std::vector<std::string>* defaulted);

/// Force one knob by name, as `meta.json` spells it.  Returns:
///   1  applied
///   0  unknown knob name
///  -1  known knob, unparseable value
int applyConfigOverride(Config& cfg, const std::string& name,
                        const std::string& value);

/// Spell `cfg` back out as the JSON object `meta.json → config` carries, using
/// the SAME table `applyMetaConfig` / `applyConfigOverride` read — so a config
/// this writes is a config those two adopt, by construction rather than by
/// review.
///
/// It exists for the LIVE Android session (cpp/rnis_pano_live.cpp), which is
/// the first writer of a pano+ pack outside `RNISPanoCore.mm`.  Without it a
/// live pack's `meta.json` would carry no `config` at all, and replaying that
/// pack would silently run at ENGINE DEFAULTS while reporting that it had
/// reproduced the sweep — the replay twin quietly measuring a different arm.
///
/// Appends; does not clear `out`.  Booleans print `true`/`false` and integer
/// knobs print without a fractional part, so the block is diffable against the
/// iOS writer's by eye and not only by parser.
void appendConfigJson(std::string& out, const Config& cfg);

/// The ledger row for one frame, and the synthetic lead-out row, in
/// `RNISPanoCore.mm`'s field ORDER.
///
/// Public for the live Android session, which writes `ledger.jsonl` DURING the
/// sweep rather than replaying one afterwards.  A second writer there would be
/// a second field order, and the first divergence would make a live pack
/// undiffable against the device ledger it exists to be compared with.
void appendLedgerLine(std::string& out, const FrameOutcome& row);
void appendTailFlushLine(std::string& out, const FrameOutcome& tail);

/// Count `outcome` strings in a ledger file's TEXT, and record each row's
/// outcome by `seq` for the per-row diff.  Malformed rows are counted in
/// `*malformed`, never fatal.
void scanLedgerOutcomes(const std::string& text,
                        std::vector<std::pair<long long, std::string> >* bySeq,
                        int* malformed);

}  // namespace replay
}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_REPLAY_HPP
