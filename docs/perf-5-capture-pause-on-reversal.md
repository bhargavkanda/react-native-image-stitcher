# Perf 5 — Capture-pause on direction reversal (pan-back rejection)

**Status:** spec — **DEFERRED** (operator-approved concept 2026-08-03, implementation
scheduled after Phases 0/1/3a/3b). Behind a flag, default OFF, until built + gated.
**Branch context:** written against `fix/RN0.79.X_optimize_process_time` @ `7df2dba`
(base `f87ab91` = v0.22.0). Every `file:line` verified against that tree on 2026-08-03;
re-verify before implementing.
**Companion:** [`perf-3b-native-stitch-speed.md`](perf-3b-native-stitch-speed.md) §3.2 —
this feature is what makes the range matcher's pan-back rescue redundant.

---

## 1. Summary

Today the capture flow accepts keyframes whenever the overlap gate is satisfied,
regardless of pan **direction**. An operator who sweeps back over already-scanned
shelf produces out-of-order keyframes with non-adjacent overlap — the capture shape
that forces the stitcher to keep the expensive O(N²) full-pairwise matcher as a
fallback (see 3b §3.2).

This spec designs that shape **out at capture time**. When the operator reverses
direction mid-capture:

1. **Stop accepting keyframes** — the gate force-rejects with a new reason
   `PausedReversed`.
2. **Turn the pan-speed border red** (the same border `PanoramaGuidance` already
   tints green/yellow/red for pan speed) and show a **"Capture paused"** message.
3. **Resume automatically** once the operator pans *forward* again — specifically,
   once pan progress passes the **frontier** (the position of the last accepted
   keyframe) in the original capture direction.

Net effect: the accepted keyframe set is **monotonic along one direction by
construction**, which (a) unlocks dropping the pan-back rescue in 3b, (b) prevents a
class of malformed captures that currently degrade stitch quality or force ladder
escalation, and (c) gives the operator immediate, corrective feedback instead of a
silently worse panorama at the end.

**Non-goal:** this is not a stitch-time robustness change. We are choosing to *not*
support pan-backs rather than stitch them well. 3b keeps its rescue as a safety
bridge until this ships (3b §3.2, "Sequencing").

---

## 2. Current state (verified)

### 2.1 The keyframe decision is shared C++, not per-platform

`KeyframeGate.kt` (`android/src/main/java/io/imagestitcher/rn/KeyframeGate.kt:37`)
and `KeyframeGate.swift` (`ios/Sources/RNImageStitcher/KeyframeGate.swift`) are **thin
facades** over a native handle: `evaluate()` / `evaluateWithFrame()` call
`nativeEvaluate…` (`KeyframeGate.kt:227-311`) and the accept/reject reason is a C++
`KeyframeGateDecisionReason` int mapped to a telemetry string at
`KeyframeGate.kt:365-395` (e.g. `10 → "overlap-too-high"`, `16 →
AcceptTimeInterval`). **The decision engine — and therefore reversal detection —
belongs in the shared C++ gate**, so both platforms get it from one implementation.
Confirm the C++ enum + gate source (search `cpp/` for `KeyframeGateDecisionReason`
and the flow/overlap strategy evaluator) before implementing.

### 2.2 The gate already tracks pan progress

The overlap/flow strategy already integrates inter-keyframe motion (pose yaw in AR
mode; gyro-integrated yaw + optical-flow in non-AR — the same signals
`useStitcherWorklet` synthesizes and `KeyframeGate` consumes). Reversal detection
reuses this: we need a **signed scalar of progress along the dominant pan axis**, not
a new sensor. The dominant axis is already resolved (`usePanMotion.ts` header: gyro-Y
for horizontal/Mode B, gyro-X for vertical/Mode A).

### 2.3 The pan-speed border already exists

`PanoramaGuidance.tsx:82-86` maps |rad/s| onto green/yellow/red buckets and applies
the tint as `borderColor: tint` (`PanoramaGuidance.tsx:236`). A "paused" state is a
new tint source that **overrides** the speed bucket (red + copy), not a new overlay.
Guidance copy lives in `src/camera/cameraGuidanceCopy.ts`.

### 2.4 The reject channel is about to become prompt

The `PausedReversed` reason surfaces to JS through the existing reject-state emit
(`emitBatchKeyframeRejectState`, `IncrementalStitcher.kt`). **Phase 1 sets the reject
throttle default to 0** (parity with iOS), so the pause message appears without the
250 ms lag the reviewed commit introduced — a dependency worth stating: this feature
should not ship on top of a non-zero default throttle, or the border will feel laggy.

---

## 3. Design

### 3.1 Frontier + capture direction (C++ gate)

- **Capture direction** is latched from the sign of the first non-trivial
  inter-keyframe progress delta (after keyframe #1). Before it latches, no reversal
  logic runs (the operator is still establishing the sweep).
- **Frontier** = the maximum signed progress reached in the capture direction. It
  advances every time a keyframe is accepted (the last accepted keyframe *is* the
  frontier by definition, since accepts only happen at/ahead of it).
- **Reversed state** latches when signed progress retreats from the frontier by more
  than `reversalHysteresisRad` (a wobble tolerance — must exceed normal hand jitter;
  seed from the existing speed-bucket "good" threshold, tune on-device).
- **Resume** when signed progress climbs back to `frontier` (in the capture
  direction). While `frontier − progress > 0` and reversed-latched, the gate
  force-rejects every frame with `PausedReversed`. Crossing the frontier clears the
  latch; normal overlap gating resumes and the next accept advances the frontier.

Hysteresis on both edges (enter reversed at `frontier − reversalHysteresisRad`, exit
at `frontier`) prevents flapping at the boundary.

### 3.2 New decision reason (all three layers)

- **C++:** add `KeyframeGateDecisionReason::PausedReversed` (next free int; the map at
  `KeyframeGate.kt:365-395` currently tops out at 16). Never accepts; carries the
  frontier-deficit so the UI could show "pan back N% to resume" later.
- **Kotlin/Swift:** extend the int→string maps (`KeyframeGate.kt:365-395` + the Swift
  equivalent) → `"paused-reversed"`.
- **Shared TS enum:** add the outcome to the `KeyframeGateDecision`/reject-outcome
  type consumed by `useIncrementalStitcher` and `PanoramaGuidance`. **Note the
  pre-existing Android outcome-code drift** (Android emits 5/6 where the shared TS
  enum defines 8/9 — flagged in the review); reconcile the new code on both platforms
  so it doesn't inherit the same mismatch.

### 3.3 UI (TS)

- `PanoramaGuidance.tsx`: when the latest incremental state's reject outcome is
  `paused-reversed`, force `tint = red` and render the paused copy, overriding the
  speed bucket. Border geometry unchanged.
- `cameraGuidanceCopy.ts`: add the string (e.g. "Capture paused — pan forward to
  continue"). Route through the existing i18n copy table.
- No new component; no new subscription (rides `subscribeIncrementalState`).

### 3.4 Flag

`pauseOnReversal` (bool, default **false**) plumbed through
`PanoramaSettings.ts` → `PanoramaSettingsBridge.ts` → native gate config, same
discipline as the flow keys. Off = today's behavior, byte-identical.

---

## 4. Verification & gates

- **Unit (C++ gate):** synthetic progress sequences — monotonic (never pauses),
  reversal-then-resume (pauses at frontier−hyst, resumes at frontier), wobble-under-
  hysteresis (never pauses), reversal-without-resume (stays paused to finalize).
- **Parity:** with `pauseOnReversal=false`, gate decisions are byte-identical to
  today across the 3b Set L (linear) and Set P (pan-back) corpora.
- **Integration:** the 3b Set P corpus, re-captured with the flag ON, must yield a
  **monotonic** accepted set (this is the property 3b relies on — cross-link the
  gate).
- **On-device (A35):** operator pans forward → reverses → border goes red + message
  appears within one frame of the reversal latching (verify the zero-throttle
  dependency from §2.4) → pans forward past frontier → capture resumes. AR mode
  (pose) and non-AR mode (gyro+flow) both, because their progress signals differ in
  drift characteristics.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Gyro-integrated yaw drifts in non-AR mode → false frontier over a long capture | Frontier is *relative* progress reset per capture, not absolute heading; hysteresis absorbs slow drift; validate on the longest realistic pan |
| Operator legitimately re-scans a missed spot → gets stuck paused | Message tells them to pan forward; the frontier is the last *good* keyframe so "forward past it" is where new coverage is anyway. Open question §7 on an explicit "give up and finalize" affordance |
| Vertical (Mode A) vs horizontal (Mode B) axis sign conventions | Reuse the already-resolved dominant axis (`usePanMotion.ts`); do not re-derive |
| Flapping at the boundary | Two-edge hysteresis (§3.1) |
| Inherits the Android 5/6 vs 8/9 outcome-code drift | Reconcile the new code deliberately across platforms (§3.2) |

---

## 6. Dependencies & sequencing

- **Depends on Phase 1** (reject throttle default 0) for a prompt border — §2.4.
- **Independent of Phase 0** (no telemetry field needed, though the paused-duration is
  worth adding to the Phase 0 event counters if cheap).
- **Unblocks a 3b follow-up:** once shipped + default-on, 3b can drop the pan-back
  rescue reason and retire the Set P parity gate (3b §3.2). Do not couple 3b's default
  flip to this — 3b is safe on its own via ladder fall-through.
- Ships **after** 3a/3b (it is deferred; those are the near-term perf wins).

---

## 7. Open questions

1. **"Past the last captured frame" — pose-progress vs overlap-with-frontier.** §3.1
   uses signed pose/gyro progress. An alternative is "resume when live overlap with
   the frontier keyframe's image exceeds the accept threshold again," which is
   drift-immune but costs a per-frame match against a stored frame. Decide after
   measuring non-AR yaw drift over a long pan.
2. **Reversal threshold (`reversalHysteresisRad`)** — seed value and whether it scales
   with the accept overlap threshold. Needs on-device tuning.
3. **Escape hatch** — should a sustained reversal (operator wants to end early) offer
   "finalize from here" rather than force forward re-pan? Product call.
4. **AR vs non-AR signal choice** — one unified progress scalar, or per-mode (pose in
   AR, gyro+flow in non-AR)? Affects where in the C++ gate the signal is read.
5. **Interaction with `forceAcceptNext`** (`KeyframeGate.kt:101`) — does a forced
   accept override the paused state, or is pause strictly higher priority? (Recommend:
   pause wins; forceAcceptNext is for start/seed frames, not mid-pan.)
