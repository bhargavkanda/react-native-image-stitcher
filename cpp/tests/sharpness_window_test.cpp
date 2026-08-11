// SPDX-License-Identifier: Apache-2.0
//
// sharpness_window_test.cpp — GoogleTest coverage for the shared
// pick-sharpest-in-window decision machine (cpp/sharpness_window.*).
//
// The machine is the single source of truth for WHEN a window opens,
// WHEN a candidate replaces the buffered best, and WHEN the window
// closes — both platforms (IncrementalStitcher.swift / .kt) consult
// it per gate-evaluated frame.  These tests pin the semantics the
// platforms rely on:
//   - open on accept (K > 1), immediate save for K == 1
//   - streaming max: replace ONLY on a strictly better score
//   - window-full close after K−1 candidate slots
//   - flush-then-open on a new accept mid-window
//   - early close on the overlap-drift guard (novelty > thr/2)
//   - finalize drain() flush semantics
//   - determinism across identical event sequences

#include <gtest/gtest.h>

#include <vector>

#include "sharpness_window.hpp"

using retailens::SharpnessWindowAction;
using retailens::SharpnessWindowCloseReason;
using retailens::SharpnessWindowDecision;
using retailens::SharpnessWindowMachine;

namespace {

// Shorthand: candidate event with the drift guard quiescent (the gate
// computed a small novelty well under half the 0.4 threshold).
SharpnessWindowDecision candidate(SharpnessWindowMachine& m, double score,
                                  double novelty = 0.05,
                                  double threshold = 0.4) {
    return m.ingest(false, score, novelty, threshold);
}

SharpnessWindowDecision accept(SharpnessWindowMachine& m, double score,
                               double novelty = 0.45,
                               double threshold = 0.4) {
    return m.ingest(true, score, novelty, threshold);
}

} // namespace

// ── Open on accept ─────────────────────────────────────────────────

TEST(SharpnessWindowTest, AcceptOpensWindowWhenKGreaterThanOne) {
    SharpnessWindowMachine m(4);
    ASSERT_FALSE(m.isOpen());

    const auto d = accept(m, 100.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::OpenWindow);
    EXPECT_TRUE(d.replaceBest);  // seed: buffer THIS frame
    EXPECT_EQ(d.closeReason, SharpnessWindowCloseReason::NotClosed);
    EXPECT_TRUE(m.isOpen());
    EXPECT_EQ(m.remainingSlots(), 3);
    EXPECT_DOUBLE_EQ(m.bestScore(), 100.0);
}

TEST(SharpnessWindowTest, CandidateBeforeAnyWindowIsIgnored) {
    SharpnessWindowMachine m(4);
    const auto d = candidate(m, 500.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::None);
    EXPECT_FALSE(d.replaceBest);
    EXPECT_FALSE(m.isOpen());
}

// ── K == 1: immediate save, window bypassed ────────────────────────

TEST(SharpnessWindowTest, KOneAcceptSavesImmediately) {
    SharpnessWindowMachine m(1);
    const auto d = accept(m, 100.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::SaveImmediately);
    EXPECT_FALSE(d.replaceBest);
    EXPECT_FALSE(m.isOpen());

    // Subsequent rejected frames are never candidates with K == 1.
    const auto c = candidate(m, 999.0);
    EXPECT_EQ(c.action, SharpnessWindowAction::None);

    // Every accept keeps saving immediately.
    EXPECT_EQ(accept(m, 50.0).action,
              SharpnessWindowAction::SaveImmediately);
}

TEST(SharpnessWindowTest, KBelowOneClampsToOne) {
    SharpnessWindowMachine m(0);
    EXPECT_EQ(m.windowSize(), 1);
    EXPECT_EQ(accept(m, 1.0).action,
              SharpnessWindowAction::SaveImmediately);

    SharpnessWindowMachine neg(-3);
    EXPECT_EQ(neg.windowSize(), 1);
}

// ── Streaming max: strictly-better replacement ─────────────────────

TEST(SharpnessWindowTest, CandidateReplacesOnlyOnStrictlyBetterScore) {
    SharpnessWindowMachine m(6);  // seed + 5 slots: 4 candidates below
                                  // leave the window open throughout
    accept(m, 100.0);

    // Equal score → KEEP (strictly-better required; ties keep the
    // earlier frame, which sits closer to the accepted pose).
    auto d = candidate(m, 100.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_FALSE(d.replaceBest);
    EXPECT_DOUBLE_EQ(m.bestScore(), 100.0);

    // Worse score → KEEP.
    d = candidate(m, 99.9);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_DOUBLE_EQ(m.bestScore(), 100.0);

    // Strictly better → REPLACE, best advances.
    d = candidate(m, 100.1);
    EXPECT_EQ(d.action, SharpnessWindowAction::ReplaceBest);
    EXPECT_TRUE(d.replaceBest);
    EXPECT_DOUBLE_EQ(m.bestScore(), 100.1);

    // Better than the ORIGINAL but not the current best → KEEP.
    d = candidate(m, 100.05);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_DOUBLE_EQ(m.bestScore(), 100.1);
}

// ── Window-full close ──────────────────────────────────────────────

TEST(SharpnessWindowTest, WindowClosesWhenCandidateSlotsExhausted) {
    SharpnessWindowMachine m(3);  // seed + 2 candidate slots
    accept(m, 100.0);
    EXPECT_EQ(m.remainingSlots(), 2);

    auto d = candidate(m, 50.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_EQ(m.remainingSlots(), 1);

    d = candidate(m, 60.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::CloseAndSave);
    EXPECT_EQ(d.closeReason, SharpnessWindowCloseReason::WindowFull);
    EXPECT_FALSE(d.replaceBest);  // 60 < 100: buffered best wins
    EXPECT_FALSE(m.isOpen());
    // Sticky best survives the close (platforms log it post-close).
    EXPECT_DOUBLE_EQ(m.bestScore(), 100.0);

    // Post-close frames are ignored until the next accept.
    EXPECT_EQ(candidate(m, 999.0).action, SharpnessWindowAction::None);
}

TEST(SharpnessWindowTest, ClosingCandidateThatWinsSetsReplaceBest) {
    SharpnessWindowMachine m(2);  // seed + 1 candidate slot
    accept(m, 100.0);

    const auto d = candidate(m, 150.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::CloseAndSave);
    EXPECT_EQ(d.closeReason, SharpnessWindowCloseReason::WindowFull);
    EXPECT_TRUE(d.replaceBest);  // the closing candidate is the winner
    EXPECT_DOUBLE_EQ(m.bestScore(), 150.0);
    EXPECT_FALSE(m.isOpen());
}

// ── Flush-then-open on a new accept mid-window ─────────────────────

TEST(SharpnessWindowTest, NewAcceptMidWindowFlushesThenReopens) {
    SharpnessWindowMachine m(4);
    accept(m, 100.0);
    candidate(m, 120.0);  // best is now 120

    const auto d = accept(m, 80.0);  // force-last / time-budget accept
    EXPECT_EQ(d.action, SharpnessWindowAction::FlushThenOpen);
    EXPECT_TRUE(d.replaceBest);  // seed the NEW window with this frame
    EXPECT_TRUE(m.isOpen());
    EXPECT_EQ(m.remainingSlots(), 3);           // fresh window
    EXPECT_DOUBLE_EQ(m.bestScore(), 80.0);      // new seed's score
}

// ── Overlap-drift guard (early close) ──────────────────────────────

TEST(SharpnessWindowTest, DriftGuardClosesEarlyWhenNoveltyExceedsHalfThreshold) {
    SharpnessWindowMachine m(10);
    accept(m, 100.0);

    // novelty 0.15 ≤ 0.5 × 0.4 → window stays open.
    auto d = m.ingest(false, 90.0, 0.15, 0.4);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_TRUE(m.isOpen());

    // novelty 0.21 > 0.20 → close NOW, save best-so-far.  The drifted
    // candidate is EXCLUDED even though it is sharper than the best.
    d = m.ingest(false, 500.0, 0.21, 0.4);
    EXPECT_EQ(d.action, SharpnessWindowAction::CloseAndSave);
    EXPECT_EQ(d.closeReason, SharpnessWindowCloseReason::NoveltyDrift);
    EXPECT_FALSE(d.replaceBest);
    EXPECT_FALSE(m.isOpen());
    EXPECT_DOUBLE_EQ(m.bestScore(), 100.0);  // drifted 500 never won
}

TEST(SharpnessWindowTest, DriftGuardBoundaryIsExclusive) {
    SharpnessWindowMachine m(10);
    accept(m, 100.0);
    // novelty EXACTLY 0.5 × threshold does not trigger (guard fires on
    // "exceeds", not "reaches").
    const auto d = m.ingest(false, 90.0, 0.20, 0.4);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_TRUE(m.isOpen());
}

TEST(SharpnessWindowTest, DriftGuardIgnoresSentinelNoveltyAndDisabledThreshold) {
    SharpnessWindowMachine m(10);
    accept(m, 100.0);

    // -1.0 = "gate didn't compute novelty" → never triggers.
    auto d = m.ingest(false, 90.0, -1.0, 0.4);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_TRUE(m.isOpen());

    // threshold ≤ 0 disables the guard even for large novelty.
    d = m.ingest(false, 90.0, 0.9, 0.0);
    EXPECT_EQ(d.action, SharpnessWindowAction::KeepBest);
    EXPECT_TRUE(m.isOpen());
}

// ── Finalize drain() semantics ─────────────────────────────────────

TEST(SharpnessWindowTest, DrainFlushesOpenWindowExactlyOnce) {
    SharpnessWindowMachine m(4);
    accept(m, 100.0);
    candidate(m, 120.0);

    EXPECT_TRUE(m.drain());       // pending best → platform must save
    EXPECT_FALSE(m.isOpen());
    EXPECT_DOUBLE_EQ(m.bestScore(), 120.0);  // sticky for the flush

    EXPECT_FALSE(m.drain());      // idempotent: second drain is a no-op
}

TEST(SharpnessWindowTest, DrainWithoutWindowReturnsFalse) {
    SharpnessWindowMachine m(4);
    EXPECT_FALSE(m.drain());

    // Window fully closed by slot exhaustion → nothing left to drain.
    SharpnessWindowMachine m2(2);
    accept(m2, 100.0);
    candidate(m2, 50.0);  // CloseAndSave
    EXPECT_FALSE(m2.drain());
}

// ── Reset (cancel / start) ─────────────────────────────────────────

TEST(SharpnessWindowTest, ResetDiscardsOpenWindow) {
    SharpnessWindowMachine m(4);
    accept(m, 100.0);
    m.reset();
    EXPECT_FALSE(m.isOpen());
    EXPECT_DOUBLE_EQ(m.bestScore(), -1.0);
    EXPECT_EQ(candidate(m, 999.0).action, SharpnessWindowAction::None);

    // A fresh accept re-opens normally after reset.
    EXPECT_EQ(accept(m, 10.0).action, SharpnessWindowAction::OpenWindow);
}

TEST(SharpnessWindowTest, SetWindowSizeResetsAndClamps) {
    SharpnessWindowMachine m(4);
    accept(m, 100.0);
    m.setWindowSize(6);
    EXPECT_EQ(m.windowSize(), 6);
    EXPECT_FALSE(m.isOpen());  // reconfigure discards the old window

    m.setWindowSize(0);
    EXPECT_EQ(m.windowSize(), 1);
}

// ── Determinism ────────────────────────────────────────────────────

TEST(SharpnessWindowTest, IdenticalEventSequencesProduceIdenticalDecisions) {
    struct Event {
        bool isAccept;
        double score;
        double novelty;
    };
    const std::vector<Event> events = {
        {true, 100.0, 0.45}, {false, 90.0, 0.05}, {false, 130.0, 0.10},
        {true, 70.0, 0.50},  {false, 75.0, 0.19}, {false, 60.0, 0.21},
        {false, 55.0, 0.02}, {true, 40.0, 0.41},  {false, 45.0, 0.03},
    };

    auto run = [&events]() {
        SharpnessWindowMachine m(4);
        std::vector<SharpnessWindowDecision> out;
        out.reserve(events.size());
        for (const auto& e : events) {
            out.push_back(m.ingest(e.isAccept, e.score, e.novelty, 0.4));
        }
        return out;
    };

    const auto a = run();
    const auto b = run();
    ASSERT_EQ(a.size(), b.size());
    for (size_t i = 0; i < a.size(); ++i) {
        EXPECT_EQ(a[i].action, b[i].action) << "event " << i;
        EXPECT_EQ(a[i].replaceBest, b[i].replaceBest) << "event " << i;
        EXPECT_EQ(a[i].closeReason, b[i].closeReason) << "event " << i;
    }
}

// ── End-to-end shaped sequence (platform integration contract) ─────

TEST(SharpnessWindowTest, TypicalCaptureSequence) {
    // K=4 window: accept → 3 candidates → close; then a fresh accept.
    SharpnessWindowMachine m(4);

    EXPECT_EQ(accept(m, 200.0).action, SharpnessWindowAction::OpenWindow);
    EXPECT_EQ(candidate(m, 180.0).action, SharpnessWindowAction::KeepBest);
    EXPECT_EQ(candidate(m, 240.0).action, SharpnessWindowAction::ReplaceBest);
    const auto closing = candidate(m, 220.0);
    EXPECT_EQ(closing.action, SharpnessWindowAction::CloseAndSave);
    EXPECT_EQ(closing.closeReason, SharpnessWindowCloseReason::WindowFull);
    EXPECT_FALSE(closing.replaceBest);       // 220 < 240
    EXPECT_DOUBLE_EQ(m.bestScore(), 240.0);  // the frame that gets saved

    // Between windows: rejected frames do nothing.
    EXPECT_EQ(candidate(m, 999.0).action, SharpnessWindowAction::None);

    // Next accept opens a fresh window.
    EXPECT_EQ(accept(m, 150.0).action, SharpnessWindowAction::OpenWindow);
    EXPECT_EQ(m.remainingSlots(), 3);
    EXPECT_DOUBLE_EQ(m.bestScore(), 150.0);
}

// ── The HOLD re-open sequence (v0.23 anti-blur) ─────────────────────
//
// When the admission policy holds a keyframe, the platforms re-open the
// just-closed window by feeding an ACCEPT carrying the machine's OWN
// bestScore. That re-arms the candidate slots without disturbing the
// streaming max, so the held frame still has to be beaten on merit.
//
// The guard logic around this lives in two bridges
// (SharpnessWindowBridge.mm and SharpnessWindow.kt) rather than in the
// machine, which is exactly the drift risk the shared port exists to
// remove — the v0.23 review found the two spellings already disagreed on
// NaN. These cases pin the MACHINE-side contract both bridges depend on,
// so a future change to the machine can't silently break the hold path.
TEST(SharpnessWindowMachine, ReopenAfterCloseRearmsSlotsAndKeepsBest) {
    SharpnessWindowMachine m(4);

    EXPECT_EQ(accept(m, 200.0).action, SharpnessWindowAction::OpenWindow);
    EXPECT_EQ(candidate(m, 240.0).action, SharpnessWindowAction::ReplaceBest);
    EXPECT_EQ(candidate(m, 100.0).action, SharpnessWindowAction::KeepBest);
    EXPECT_EQ(candidate(m, 110.0).action, SharpnessWindowAction::CloseAndSave);
    ASSERT_FALSE(m.isOpen());
    const double bestAtClose = m.bestScore();
    EXPECT_DOUBLE_EQ(bestAtClose, 240.0);

    // The re-open: an accept seeded with the machine's own best.
    const auto reopened = accept(m, bestAtClose);
    EXPECT_EQ(reopened.action, SharpnessWindowAction::OpenWindow);
    EXPECT_TRUE(m.isOpen());
    // Slots are re-armed …
    EXPECT_EQ(m.remainingSlots(), 3);
    // … and the streaming max is unchanged, so a held candidate is not
    // silently promoted: a WORSE frame must still lose.
    EXPECT_DOUBLE_EQ(m.bestScore(), 240.0);
    EXPECT_EQ(candidate(m, 200.0).action, SharpnessWindowAction::KeepBest);
    EXPECT_DOUBLE_EQ(m.bestScore(), 240.0);
    // … while a genuinely sharper one still wins.
    EXPECT_EQ(candidate(m, 300.0).action, SharpnessWindowAction::ReplaceBest);
    EXPECT_DOUBLE_EQ(m.bestScore(), 300.0);
}

TEST(SharpnessWindowMachine, RepeatedReopenTerminatesAtFinalizeDrain) {
    // A hold must never outlive the capture. Even if the policy held on
    // every close, drain() at finalize still claims the buffered best —
    // the capture cannot hang and the keyframe cannot be lost.
    SharpnessWindowMachine m(2);
    EXPECT_EQ(accept(m, 50.0).action, SharpnessWindowAction::OpenWindow);
    for (int i = 0; i < 25; ++i) {
        const auto closing = candidate(m, 10.0);
        ASSERT_EQ(closing.action, SharpnessWindowAction::CloseAndSave);
        ASSERT_FALSE(m.isOpen());
        ASSERT_EQ(accept(m, m.bestScore()).action,
                  SharpnessWindowAction::OpenWindow);
    }
    EXPECT_TRUE(m.drain());   // the pending best is still claimable
    EXPECT_FALSE(m.drain());  // idempotent
}

TEST(SharpnessWindowMachine, KOneNeverOpensSoReopenHasNothingToRearm) {
    // K == 1 bypasses the window entirely (SaveImmediately), which is
    // why both bridges refuse to re-open there: a hold would have
    // nowhere to live and would drop the keyframe outright.
    SharpnessWindowMachine m(1);
    EXPECT_EQ(accept(m, 100.0).action, SharpnessWindowAction::SaveImmediately);
    EXPECT_FALSE(m.isOpen());
    EXPECT_EQ(accept(m, 100.0).action, SharpnessWindowAction::SaveImmediately);
    EXPECT_FALSE(m.isOpen());
}
