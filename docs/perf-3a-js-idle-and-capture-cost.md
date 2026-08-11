# Perf 3a — JS/worklet/event-layer cost reduction (RN-0.79 / Paper-host relief)

**Status:** spec — awaiting operator approval.
**Branch context:** written against `fix/RN0.79.X_optimize_process_time` @ `7df2dba`
(base `f87ab91` = v0.22.0), incorporating the decisions of the adversarial review
of `7df2dba` (all findings confirmed).
**Scope:** the four JS/worklet/event-layer changes (worklet ingest gate, worklet-side
decimation, Android accept-encode offload, coalesced state events). Native stitch-path
work (ladder, manual pipeline, budgets) is a separate spec.
**Companion work this spec assumes (do not re-litigate):**
Phase 0 (finalize `timings` telemetry block + JS markers + arch fingerprint) and
Phase 1 (AR-render-pause removal, low-RAM adaptive-resolution removal, reject-throttle
config default 0, `THREAD_PRIORITY_FOREGROUND`, `subscribeStitchingPhase()` TS wrapper)
land in parallel. §8 states the exact dependencies.

Every factual claim below is pinned to a `file:line` verified at `7df2dba`. If you
change the code, update the citation.

---

## 1. Summary

Non-AR capture pays a continuous JS/worklet/JNI tax that is unrelated to the stitch
itself, and it is worst exactly where the branch's original commit was aimed: RN 0.79
Paper hosts, where every frame-processor plugin call and every bridge event is more
expensive than under bridgeless.

Four coordinated changes, each independently landable:

1. **Worklet-side ingest gate** — a `sharedIngestActive` shared value checked at the
   top of the stitching worklet so idle-phase and stitch-phase frames skip pose
   synthesis, the params-object allocation, and the JSI→JNI `plugin.call` entirely.
   Today every one of those runs at camera FPS (up to 60) from mount to unmount; the
   only backstop is the Kotlin-side `AtomicBoolean` fast-exit, which is reached only
   *after* the JSI hop. Lifecycle is **lockstep-with-native** (§4.1): the gate opens
   *before* `incremental.start` is awaited and closes only *after*
   `incremental.finalize`/`cancel` has been invoked, so the gate-open interval is a
   strict superset of the native-ingest-enabled interval — the gate can only drop
   frames native would have dropped anyway. The 30 Hz gyro handler's shared-value
   writes are gated by the same flag (its idle accumulation is provably discarded —
   §3.1).
2. **Decimation before `packNV21`** — move the eval cadence into the worklet
   (`sharedEvalEveryN` is already wired end-to-end) and set native
   `flowEvalEveryNFrames = 1` for frameProcessor-mode captures. Effective cadence is
   unchanged (product semantics, `useStitcherWorklet.ts:89-94`: N_worklet × 1 = N).
   Today the shipped worklet default is 1 and native discards 4 of every 5 frames
   *after* the plugin has packed a full ~3–4 MB NV21 copy per frame
   (`IncrementalStitcher.kt:1667`, cadence check at `:1207-1211`). Includes the
   first-frame off-by-one fix (§3.2). AR mode untouched.
3. **Accept-path JPEG encode off the producer thread** (Android) — reserve the
   `keyframe-N.jpg` path and append to `batchKeyframePaths` synchronously (preserving
   the finalize snapshot contract), dispatch `encodeJpegFromNV21` to the serial
   `workScope`, and emit the accept event from the encode job's completion
   (JPEG-exists-before-event invariant). FIFO on the serial scope guarantees all
   encodes complete before the stitch job reads the files; a `File.exists()` filter at
   stitch start turns any encode failure into `framesDropped` instead of a crash.
   Removes the 30–50 ms accept stall from the camera producer thread
   (`IncrementalStitcher.kt:1630-1632`). Ships behind a native config flag
   `asyncAcceptEncode`, **default off** (byte-identical to today) — §4.3; the
   default flips only after the §7.2/§7.3 gates pass with the flag on.
4. **Coalesced `IncrementalStateUpdate` handling** — ref + at-most-one `setState` per
   animation frame in `useIncrementalStitcher`; ACCEPT events (and refine-stage
   transitions) flush immediately, rejects/hints coalesce; pending coalesced state
   is **discarded** at start/finalize/cancel — a named deviation from the original
   "flush pending state on finalize" brief, rationale in §4.4. Dedupe the double
   subscription with `Camera.tsx` so each event no longer drives two independent
   `setState`s into the ~3,500-line `Camera` tree (`Camera.tsx:1948`,
   `useIncrementalStitcher.ts:158`).

None of these changes touches the stitch algorithm. Change 1 is pixel-neutral via
the superset-interval argument (§4.1: the gate is open strictly longer than native
ingest is enabled, so it can only drop frames native would drop). Change 3 produces
byte-identical keyframe JPEGs and ships default-off behind `asyncAcceptEncode`
(§4.3). Change 4 touches only JS-side state consumption. Change 2 preserves
steady-state cadence exactly but moves the evaluated-frame grid anchor by up to one
bridge round-trip at capture start — an honest, bounded delta stated in §4.2 and
gated in §7.2; the optional time-based variant additionally requires an A/B before
it can become a default.

---

## 2. Motivation — the review findings this answers

The adversarial review of `7df2dba` confirmed that the commit treated the *symptom*
(stitch takes long, device feels saturated) with band-aids (render pause, resolution
cuts, reject throttling) while the *structural* JS-side costs were left in place:

- **F-idle (worklet runs regardless of ingest state).** The worklet body
  (`useStitcherWorklet.ts:335-412`) runs pose synthesis (6 trig calls, `:369-382`),
  allocates a fresh params object (`:394-402`), and makes the JSI→JNI `plugin.call`
  on **every camera frame from mount to unmount** — including the idle phase before
  the shutter is held and the multi-second stitch phase. The Kotlin fast-exit
  (`CvFlowGateFrameProcessor.kt:92-94`) catches it, but only after the plugin
  dispatch: the plugin's own comment (`:83-89`) concedes that on the old bridge
  (RN ≤ 0.79) *"each plugin callback — even a no-op — involves JNI + ImageProxy
  overhead at 30 fps."* The structural fix is to not make the call at all.
- **F-decimation (3 MB copied, then thrown away).** `Camera.tsx:1793` constructs the
  driver with no options, so the worklet's `evalEveryNFrames` stays at its default 1
  (`useStitcherWorklet.ts:223`). Every frame crosses into
  `consumeFrameFromPlugin`, which packs the full NV21 into a JVM array
  (`IncrementalStitcher.kt:1667`) *before* the cadence check at `:1207-1211` throws
  4 of every 5 frames away (JS default `evalEveryNFrames: 5`,
  `PanoramaSettings.ts:348`, always serialised to native by
  `PanoramaSettingsBridge.ts:126-128`). The copy belongs *after* the throttle, and
  the throttle belongs on the cheapest side of the JSI boundary.
- **F-accept-stall (synchronous encode on the producer thread).** The accept-path
  JPEG encode runs synchronously inside the plugin callback — 30–50 ms per accept on
  a mid-tier device by the repo's own measurement (`IncrementalStitcher.kt:1630-1632`)
  — and the encode itself includes a decode + rescale + re-encode round-trip whenever
  the source long edge exceeds the keyframe budget
  (`YuvImageConverter.kt:271-292`). The packed NV21 already outlives the callback
  (F8.6 / v0.21.1-review-C, `:1086-1092`, `:1614-1622`), so nothing forces this work
  onto the camera thread.
- **F-event-storm (two renders per engine event).** Every `IncrementalStateUpdate`
  triggers two unconditional `setState`s — `Camera.tsx:1948` and
  `useIncrementalStitcher.ts:158` — from two separate subscriptions
  (`Camera.tsx:1946-1961`, `useIncrementalStitcher.ts:147-182`), each re-rendering
  the ~3,500-line `Camera` tree. In AR mode the engine emits per processed ARFrame
  (~60 Hz, `useIncrementalStitcher.ts:13`); in non-AR mode rejects arrive at eval
  cadence (~6/s, `IncrementalStitcher.kt:1263-1266`) plus Phase 1 makes the reject
  throttle configurable with default 0 (no throttling), so the JS layer must be
  robust to the full event rate. Note `unstable_batchedUpdates` buys nothing here —
  React 18 auto-batches within a tick already; the win is **update frequency**, not
  batching.

Each mitigation below names its structural fix; no timers, retries, or safety nets
are introduced to paper over an unidentified root cause.

---

## 3. Current state (verified at `7df2dba`)

### 3.1 Worklet + gyro lifecycle

- `useStitcherWorklet` owns plugin acquisition (`useStitcherWorklet.ts:232-254`),
  the shared values (`:257-267`), the always-on gyro subscription (`:290-314`), and
  the worklet body (`:335-412`).
- Worklet body order today: `plugin == null` check (`:337`) → AR-source
  short-circuit (`:362`) → throttle (`:365-367`) → pose synthesis (`:369-382`) →
  intrinsics (`:384-388`) → `plugin.call` with a fresh object literal (`:394-402`).
  There is **no ingest-active check**: idle and stitch-phase frames pay everything up
  to and including the JSI→JNI hop.
- The gyro handler writes three shared values per sample at ~30 Hz
  (`:302-304`) whether or not a capture is running. The accumulated yaw/pitch/roll
  is **provably discarded** at every capture start: `useFrameProcessorDriver.start()`
  calls `stitcher.reset()` (`useFrameProcessorDriver.ts:133-137`), which zeroes all
  three plus the frame counter (`useStitcherWorklet.ts:317-322`); nothing else reads
  the shared values between captures (the worklet is their only consumer). Composed
  hosts are already documented as needing `reset()` at capture start
  (`useStitcherWorklet.ts:52-54`).
- `Camera.tsx` wires the driver with **no options** (`Camera.tsx:1793`). Verified
  call order in `startCapture`: `await incremental.start(...)` (`:2191-2210`)
  resolves **before** `fpDriver.start()` runs (`:2221-2223`) — native ingest is
  enabled a full bridge round-trip before the driver (and any JS gate it manages)
  starts. On the stop side, `handleHoldEnd` calls `fpDriver.stop()` (`:2334`)
  **before** a deliberate 50 ms macrotask yield (`:2343`, the V12.14.8
  camera-teardown window) and before `incremental.finalize` (`:2361`); native
  ingest is cut only *inside* finalize (`IncrementalStitcher.kt:736-737`). Today
  the 1–3 tail frames delivered in that window are still gate-evaluated, feed an
  open sharpness window as candidates (`:1253-1258`), and can replace the buffered
  best that the finalize drain commits (`:758-761`) — so a JS gate that closed at
  `stop()` would change which frame becomes the final keyframe. §4.1 designs the
  lifecycle around this. The remaining stop sites are all discard paths: drift
  auto-abandon (`:1885`), cancel (`:2557`), unmount (`:1797`).
- The native backstops are authoritative and stay: Kotlin
  `frameProcessorIngestEnabled` `AtomicBoolean` (`IncrementalStitcher.kt:309`,
  accessor `:314-315`, plugin fast-exit before `frame.image` at
  `CvFlowGateFrameProcessor.kt:92-99`); iOS mirror ivar
  (`IncrementalStitcher.swift:347-359`).

### 3.2 Cadence plumbing

- Worklet throttle (`useStitcherWorklet.ts:364-367`):
  `sharedFrameCounter.value += 1; if (N > 1 && (counter % N) !== 0) return;` —
  because the counter is pre-incremented, the **first frame after reset is skipped
  for any N > 1** and the first evaluation is delayed N−1 frames. Native deliberately
  avoided this: both platforms use `(counter − 1) % N == 0` so frame #1 always
  evaluates (`IncrementalStitcher.kt:284-291`, `:1207-1211`;
  `IncrementalStitcher.swift:2444-2449`).
- `sharedEvalEveryN` is already wired end-to-end (option → shared value → worklet:
  `useStitcherWorklet.ts:261`, `:270-272`, `:366`), so change 2 is a wiring change,
  not new plumbing. Clamp asymmetry: native clamps the cadence to **[1, 10]**
  (`IncrementalStitcher.kt:531-533`, `coerceIn(1, 10)`) while the worklet side only
  lower-bounds it (`Math.max(1, evalEveryNFrames)`, `useStitcherWorklet.ts:261`,
  `:270-272`) — §4.2 mirrors the clamp so out-of-range host settings keep today's
  effective cadence when the throttle moves JS-side.
- Counter lifecycle: the worklet counter increments on **every** non-AR frame from
  mount (`useStitcherWorklet.ts:365` — it free-runs during idle) and is zeroed only
  by `reset()` (`:317-322`), which the default integration reaches via
  `fpDriver.start()` (`useFrameProcessorDriver.ts:133-137`) — i.e. *after* the
  `incremental.start` await (§3.1). Native, by contrast, zeroes its own counter
  inside `start()` before any ingest (`IncrementalStitcher.kt:594`), so today the
  first ingested frame always evaluates deterministically. §4.2's counter-anchor
  story exists because of this asymmetry.
- Native `flowEvalEveryNFrames`: compiled-in default 1 when the key is absent
  (Android `IncrementalStitcher.kt:531-533`, iOS
  `IncrementalStitcher.swift:1048-1051`), but the JS bridge **always** serialises the
  JS default 5 (`PanoramaSettings.ts:348` via `PanoramaSettingsBridge.ts:126-128`).
  Cadence applies at the shared ingest entry on both platforms — Android
  `:1207-1211` (after `packNV21` at `:1667` in FP mode), iOS `:2448-2449`.
- The camera session runs at `min(format.maxFps ?? 30, 60)`
  (`CameraView.tsx:297-298`), i.e. 60 fps where the chosen format supports it, while
  the native cadence comments assume ~30 fps.
- Sharpness-window interaction: the raw window spans up to
  `sharpnessWindow × evalEveryNFrames` frames (`PanoramaSettings.ts:237-239`); the
  window consumes only *evaluated* frames, so moving the decimation across the JSI
  boundary does not change window behaviour as long as the evaluated-frame set is
  unchanged (§7.2).

### 3.3 Accept path (Android)

- FP-mode entry `consumeFrameFromPlugin` (`IncrementalStitcher.kt:1633-1783`): flag
  fast-exit (`:1652`) → `packNV21` (~w×h×1.5 bytes; ≈3.1 MB at 1920×1080, ≈4.1 MB at
  1920×1440) (`:1667`) → delegates to `ingestFromARCameraView` with an `onAccept`
  lambda that calls `YuvImageConverter.encodeJpegFromNV21` **synchronously on the
  producer thread** (`:1735-1769`, quality 80) and a `retainFrame` lambda that is a
  reference grab of the packed NV21 (`:1770-1781`).
- Both callers (AR view + FP plugin) pack NV21 *before* the ingest call, so the
  frame outlives the callback — the documented v0.21.1-review-C contract
  (`:1086-1092`).
- Default config routes accepts through the sharpness window (`sharpnessWindow`
  default 4, `:542-544`; gate default flow-based, `:581-584`), so the **dominant
  accept-path encode site is `commitSharpnessWindowLocked`** (`:1512-1589`), which
  encodes under `sharpnessWindowLock` (`:1538-1544`) on the producer thread, then
  appends (`:1562`) and emits (`:1573-1588`). The K == 1 / gate-disabled passthrough
  encodes via the `onAccept` lambda (`:1302-1326`).
- Finalize: flips `isRunning` + ingest flag first (`:736-737`), drains + commits an
  open window **under the window lock, synchronously on the calling thread**
  (`:758-761`), snapshots `keyframePathsSnapshot = batchKeyframePaths.toList()` at
  `:764` — **outside** the `:758-761` synchronized block, a pre-existing
  unsynchronised producer-`add`/`toList()` pair that §4.3.1 closes — then launches
  the stitch on `workScope` (`:853`) — the same serial `limitedParallelism(1)`
  dispatcher (`:323`) used by change 3's encode jobs. Stitch call at `:924-937`
  (`useManualPipeline = false`); result carries `acceptedCount =
  keyframePathsSnapshot.size` (`:956`) plus
  `framesRequested/framesIncluded/framesDropped` from the JNI dims (`:947-959`) and
  the exact keyframe paths for `refinePanorama` (`:978-980`).
- Reject-state events are emitted **synchronously on the producer thread** from the
  ingest path (`:1267-1272`) — in program order with today's synchronous accept
  encode + emit. Change 3 relaxes that ordering; §4.3.5 names the window and §4.4
  specifies the consumer policy.
- Cancel: flips flags, clears state, and defers the session-dir delete onto
  `workScope` (`:1054-1056`) so it runs after any in-flight ingest work — FIFO with
  change 3's encode jobs (§4.3).
- `refinePanorama` re-stitches the same keyframe files on `refineScope` (NOT
  `workScope`; `:2056`) with a pre-flight `File.exists()` check that **rejects** on
  any missing keyframe (`:2041-2054`). It is only reachable with paths returned by a
  resolved finalize, which resolves after the stitch job, which runs after all
  encode jobs (FIFO) — so change 3 introduces no new ordering hazard here.
- `encodeJpegFromNV21` does **not** create parent directories — the
  `FileOutputStream` write throws and the function returns null if the dir is gone
  (`YuvImageConverter.kt:293-297`). This makes the cancel-race outcome benign
  (§4.3).

### 3.4 Event layer

- `subscribeIncrementalState` constructs a `NativeEventEmitter` per call and returns
  an `addListener` subscription (`incremental.ts:1128-1141`).
- Subscribers in the default integration: `useIncrementalStitcher`
  (`useIncrementalStitcher.ts:147-182`; unconditional `setState` at `:158` with the
  sticky-snapshot merge at `:158-168`, hint ref at `:169-179`) **and** `Camera.tsx`
  directly (`Camera.tsx:1946-1961`; unconditional `setIncrementalState` at `:1948`
  plus a second thumbnail-array `setState` on accepts at `:1950-1957`).
  `useKeyframeStream` also subscribes (`useKeyframeStream.ts:81`) but is a
  host-facing callback hook, not mounted by `Camera.tsx`, and performs no `setState`
  — out of scope.
- `useIncrementalStitcher.finalize` clears state after the native promise resolves
  (`:233-240`); `start` clears **after** `await native.start(options)` resolves
  (`:193-196`) — so an event landing during the start-await window is wiped by the
  post-await `setState(null)`. (An earlier draft of this spec claimed `start`
  "clears before running" — wrong; corrected against the code.)
- `Camera.tsx` already fixed this exact race for its own state (2026-05-23): it
  clears `batchKeyframeThumbnails` + `incrementalState` **synchronously at the top
  of `startCapture`, before any await** (`:2151-2152`), because the AR GL thread
  can emit an ACCEPT during the `incremental.start` await window — full log trace
  in the removed-effect comment at `:1962-1979`. Step 3 must mirror this ordering
  in the hook once `Camera.tsx` renders from `incremental.state` (§4.4).
- The refine-progress contract (`validating → stitching → writing → done` with
  `refineStage`/`refineProgress` keys) is pinned by
  `src/stitching/__tests__/subscribeIncrementalState.refine.test.ts` driving a fake
  emitter synchronously.

---

## 4. Design

### 4.1 Change 1 — worklet-side ingest gate (+ gyro gating)

**Structural fix:** stop doing per-frame work whose output is guaranteed to be
discarded, at the earliest point that knows it will be discarded. The JS worklet
knows capture state one shared-value write after `start()`/`stop()`; native's
`AtomicBoolean` remains the *authoritative* gate (shared-value propagation can lag a
frame or two behind the JS write, and composed hosts may mismanage the JS gate), the
worklet gate is the *cheap* gate.

- New shared value `sharedIngestActive: boolean` in `useStitcherWorklet`.
- Worklet body order becomes: `plugin == null` check → AR-source check (`:362`,
  unchanged — AR frames must keep short-circuiting for the v0.11.1 reason documented
  there) → **`if (!sharedIngestActive.value) return;`** → throttle → pose → call.
  Idle/stitch frames now cost one shared-value read.
- **Composed-host semantics (decided):**
  - Bare `useStitcherWorklet()` defaults the gate **OPEN**
    (`initialIngestActive: true`) — zero behaviour change for existing composed
    hosts that never learn the new API.
  - `useFrameProcessorDriver` opts into management: constructs the hook with
    `initialIngestActive: false`; `start()` sets it true (alongside the existing
    `reset()`, `useFrameProcessorDriver.ts:133-137`), `stop()` sets it false.
  - New handle method `setActive(active: boolean)` exported for composed hosts that
    want the same relief (documented alongside Phase 1's
    `subscribeStitchingPhase()` guidance: `isActive` from that wrapper is the signal
    a composed host should feed into `setActive`).
- **Gate lifecycle in the default integration (decided: lockstep-with-native —
  open early, close late).** The naive wiring — gate driven by the *current*
  `fpDriver.start()`/`stop()` call sites — is **not** pixel-neutral, because those
  sites do not bracket native ingest (§3.1, verified): `fpDriver.start()` runs
  *after* `await incremental.start` resolves (`Camera.tsx:2191-2223`), so a
  start-driven open would lag native-enable by a bridge round-trip; and
  `fpDriver.stop()` runs 50 ms + a bridge hop *before* native cuts ingest inside
  finalize (`Camera.tsx:2334`, `:2343`, `:2361`;
  `IncrementalStitcher.kt:736-737`), so a stop-driven close would drop the 1–3
  tail frames that today feed the open sharpness window (`:1253-1258`) and can
  become the final committed keyframe via the finalize drain (`:758-761`).
  Therefore:
  - **Open early:** `startCapture` moves the `fpDriver.start()` call (today
    `:2221-2223`) to *before* `await incremental.start(...)` (`:2191`), and the
    `catch` path (`:2224-2234`) gains a matching `fpDriver.stop()`. Harmless by
    construction: the worklet already calls the plugin during the await window
    today (no gate exists), and native's `AtomicBoolean` fast-exit drops those
    strays until its `start()` completes — behaviour in that window is identical to
    today's. Side-effect: the driver's pose-accumulator `reset()` fires at the
    hold-start moment instead of one bridge round-trip later; the extra accumulated
    rotation is a common prefix on *all* subsequent gyro-synthesised poses, and its
    only consumer downstream of accepts is the stitch-mode auto-resolver, which
    uses the first-to-last pose *delta* (`IncrementalStitcher.kt:1333-1335`) — a
    common additive prefix cancels. Neutral.
  - **Close late:** `fpDriver.stop()` moves from `:2334` to a `finally` around the
    `await incremental.finalize(...)` call (`:2361`), so the gate stays open
    through the 50 ms teardown yield and the finalize bridge hop — exactly the
    window in which native still ingests today. Stitch-phase relief is unaffected:
    native cuts ingest synchronously at the top of finalize (`:736-737`), the
    `<CameraView>` unmount at `statusPhase === 'stitching'` (`:2335-2343`) stops
    frame delivery within a frame or two anyway, and the stitch runs for seconds —
    the 50 ms window is noise against it. The discard paths keep closing
    immediately (drift auto-abandon `:1885`, cancel `:2557`, unmount `:1797`):
    their output is thrown away, so tail-frame parity is moot there.
  - Note on intent: the `:2331-2333` comment ("stop pumping new frames before
    finalizing") is today implemented by native's finalize flag flip, **not** by
    `fpDriver.stop()` (which only resets accumulators — it stops nothing). Making
    the JS gate genuinely close pre-yield would realize that comment's intent *and*
    deterministically drop the tail frames — a defensible, arguably desirable
    product change, but one that alters final-keyframe selection and therefore
    needs its own A/B. Deferred as §11 Q7; not bundled into this change.
- **Gyro gating:** keep the subscription mounted (subscription churn buys ~nothing
  and adds re-warm latency), but while the gate is closed the handler updates
  `lastGyroAt = now` and **skips the three shared-value writes**
  (`useStitcherWorklet.ts:302-304`). Updating `lastGyroAt` while inactive is
  load-bearing: it prevents the first active-sample from integrating a giant idle-gap
  `dt`. Safe because idle accumulation is provably discarded by `reset()` at capture
  start (§3.1) — the writes we skip were dead work. Bare-hook composed hosts with the
  gate open keep today's always-accumulate behaviour verbatim.
- The Kotlin/iOS native fast-exits are untouched and remain the correctness
  backstop; the worklet gate is purely an optimisation and may lag them by 1–2
  frames in either direction.

**Pixel neutrality (restated):** with the lockstep lifecycle the gate-open interval
is a strict **superset** of the native-ingest-enabled interval on every capture
path: the gate opens before native `start()` is invoked and closes after native
`finalize()`/`cancel()` is invoked, while native's flags flip *inside* those calls
(`IncrementalStitcher.kt:381`, `:736-737`, `:1028`). The gate can therefore only
drop frames that native's `AtomicBoolean`/`isRunning` re-checks would have dropped
anyway — no frame that would have produced or influenced a keyframe (including
sharpness-window candidates) is gated. This replaces an earlier, wrong claim that
the gate closes "exactly when native ingest is already disabled": with the real
`Camera.tsx` ordering, a stop()-driven close strictly *precedes* native's finalize
flag flip and would not have been neutral. Because neutrality now holds by
interval-containment rather than by call-site coincidence, change 1 also gets a
cheap rig gate (§7.2 Step 2 gate) pinning final-keyframe index + hash — defence
against a future edit quietly re-closing the gate early.

### 4.2 Change 2 — decimation before `packNV21`

**Structural fix:** the throttle must run on the cheap side of the JSI/JNI boundary;
the 3–4 MB `packNV21` copy must only happen for frames that will be evaluated.

- `Camera.tsx` passes the eval cadence into the driver:
  `useFrameProcessorDriver({ evalEveryNFrames: settings.frameSelection.flow?.evalEveryNFrames ?? DEFAULT_FLOW_GATE_SETTINGS.evalEveryNFrames })`
  (today `Camera.tsx:1793` passes nothing → worklet N = 1).
- For **frameProcessor-mode captures only**, the native config gets
  `flowEvalEveryNFrames = 1` so the effective cadence (the product,
  `useStitcherWorklet.ts:89-94`) is unchanged: N_worklet × 1 = N. Implemented in the
  bridge adapter — `panoramaSettingsToNativeConfig(settings, { frameSourceMode })` —
  which is the declared single source of truth for the wire format
  (`Camera.tsx:2172-2179`); `Camera.tsx:2206-2209` passes the mode it already
  computes at `:2200`.
- **AR mode untouched:** for `frameSourceMode === 'arSession'` the adapter keeps
  serialising the settings value (AR frames never pass through the worklet, so the
  native cadence at `IncrementalStitcher.kt:1207-1211` / `.swift:2448-2449` is the
  only throttle they have).
- **First-frame off-by-one fix:** the worklet throttle becomes
  `const c = sharedFrameCounter.value; sharedFrameCounter.value = c + 1;
  if (N > 1 && (c % N) !== 0) return;` — 0-based counter, frame 0 always evaluates,
  matching native's `(counter − 1) % N == 0` semantics
  (`IncrementalStitcher.kt:284-291`).
- **Counter anchor (required in Step 1, not Step 2).** Today the counter free-runs
  from mount (`useStitcherWorklet.ts:365`) and is zeroed only inside
  `fpDriver.start()` (`useFrameProcessorDriver.ts:133-137`) — which runs *after*
  the `incremental.start` await (§3.1). Relocating decimation without fixing the
  anchor would filter the first frames of every capture through an arbitrary stale
  counter phase and then re-phase them mid-capture when the reset lands. The fix is
  part of Step 1's `Camera.tsx` edit (shared with §4.1's open-early move):
  `fpDriver.start()` — and with it the counter `reset()`
  (`useStitcherWorklet.ts:317-322`) — moves *before* the `incremental.start` await,
  anchoring the worklet's {0, N, 2N, …} grid at capture start with no mid-capture
  re-phase. (Change 1's gate check later sits *before* the counter increment so
  idle frames stop advancing it — irrelevant to phase, since `reset()` re-anchors
  at every capture start regardless.)
- **What "cadence-preserving" honestly means.** Steady-state spacing is exact:
  every Nth worklet frame evaluates, same as native's every-Nth-ingested-frame
  today. But the grid *anchor* moves: today it is the first frame native ingests
  after its own counter reset (`IncrementalStitcher.kt:594`); after Step 1 it is
  JS-side capture start, which precedes native-enable by one bridge round-trip.
  Frames the worklet forwards before native's `start()` completes are dropped by
  the native fast-exit, so the first *evaluated* frame can land up to N−1 frames
  later than today's, and every subsequent evaluated index carries the same bounded
  phase offset δ ∈ [0, N−1] frames (≤ 133 ms at 30 fps / N = 5). Exact
  evaluated-index-set equality across the change is therefore **not claimable** for
  N > 1 — δ depends on nondeterministic bridge timing. §7.2 states the Step 1 gate
  accordingly: N = 1 byte-identical; N > 1 exact spacing + bounded start offset,
  with accepted-keyframe count/dims as the hard criteria.
- **Clamp parity:** native clamps the cadence to [1, 10]
  (`IncrementalStitcher.kt:531-533`); the worklet today only lower-bounds it
  (`useStitcherWorklet.ts:261`, `:270-272`). Step 1 mirrors the clamp
  (`Math.min(10, Math.max(1, n))`) at the option → shared-value boundary so an
  out-of-range host setting (e.g. `evalEveryNFrames = 20`, effectively 10 today)
  keeps today's effective cadence once the throttle moves JS-side. Unit-tested
  (§7.1); bound noted in §5.
- **Frame-counter vs `runAtTargetFps` (decided: counter now, time-based later
  behind a gate).** The camera session runs at up to 60 fps
  (`CameraView.tsx:297-298`) while the tuned default N = 5 assumed ~30 fps — on a
  60 fps device today's pipeline evaluates ~12×/s, not the tuned ~6×/s. A time-based
  gate (`runAtTargetFps`-style, target = 30/N evals/s) would normalise that, but it
  **changes the evaluated-frame set on 60 fps devices** → output pixels can change →
  it needs the §7.2 parity/A-B gate before it can become the default, and vc's
  `runAtTargetFps` state-isolation across composed worklets could not be verified
  in-repo (no `node_modules` in this worktree). This spec therefore ships the
  cadence-preserving 0-based frame counter, and lists the time-based variant as a
  follow-up flag (§11 Q2).

**What this buys (estimated, to be confirmed by §7 measurements):** at 30 fps and
N = 5, four of every five `packNV21` copies (~12–16 MB/s of allocation + copy),
four of five plugin JNI dispatches, and four of five `Frame`/ImageProxy acquisitions
disappear from the producer thread. At 60 fps the saving doubles.

### 4.3 Change 3 — accept-path JPEG encode onto `workScope` (Android) — DROPPED (2026-08-03)

> **DROPPED per on-device profiling.** The fable per-phase profile of the real
> stitch path measured JPEG **decode + encode at 2.7%** of stitch wall-time (imread
> 38 ms + imwrite 8 ms on the 1280 px corpus) — this change offloads a ~30-50 ms
> per-accept encode off the *producer* thread (a capture-time frame-drop concern,
> not stitch time), and the intricate producer/serial-scope concurrency it needs
> (append-under-lock, FIFO ordering, exists-filter, accept/reject reordering
> window) is not worth that marginal, capture-only benefit. Not implementing.
> The producer-thread relief that DOES matter — skipping the whole gate+encode
> for decimated frames — is delivered by Changes 1 + 2 (worklet gate + decimation
> before `packNV21`), which remain. Section kept for the record.



**Structural fix:** the producer thread's job is to gate frames; persistence belongs
on the engine's serial work queue. The packed NV21 already outlives the callback
(`IncrementalStitcher.kt:1086-1092`), so the synchronous encode was never a lifetime
requirement — only an ordering convenience. We keep the ordering by construction
(serial FIFO) instead of by blocking.

**Runtime kill-switch (decided): the whole change ships behind a native config flag
`asyncAcceptEncode`, default `false` (byte-identical to today).** Read at `start()`
via the existing `getBooleanOrDefault` helper (`IncrementalStitcher.kt:2744`) into
an engine field; both encode sites branch on it (false → today's synchronous
encode + emit, verbatim). JS plumbs it as an optional `PanoramaSettings` key
through `panoramaSettingsToNativeConfig` (always serialised, default false — same
discipline as the flow keys, `PanoramaSettingsBridge.ts:126-128`). The default
flips to `true` in a separate follow-up commit only after the §7.2 byte-identity
gate and the §7.3 device-verify pass **with the flag on**; the flag and the
then-dead synchronous path are retired one release after the flip. Rationale: this
is the spec's only native behaviour change (accept-event timing, failure
bookkeeping, stitch-input filter), and the repo's convention for behaviour-altering
native changes is default-off + parity + device-verify before flipping — a
release revert is not an acceptable rollback story for it.

Applies to **both** encode sites (both run on the producer/AR-listener thread):

1. **Immediate-commit path** (K == 1 / gate-disabled;
   `IncrementalStitcher.kt:1302-1326`): today `onAccept(path)` encodes synchronously
   and a failure drops the frame before the append. New shape:
   - Synchronously (producer thread): reserve `keyframe-{batchKeyframePaths.size}.jpg`
     (naming preserved), **append the path + record pose bookkeeping under
     `sharpnessWindowLock`**, and enqueue the encode job (capturing the packed NV21 +
     quality + displayRotation — the same params `onAccept` uses today,
     `:1753-1759`) onto `workScope` *inside the same lock-held section*.
   - The encode job encodes to the reserved path and, on success, emits
     `emitBatchKeyframeAcceptedState` (event moves from `:1347-1363` to job
     completion — the JPEG-exists-before-event invariant holds because JS loads
     `thumbnailPath` into an `<Image>` the moment the event lands). On failure it
     logs; the missing file is absorbed at stitch start (below).
   - Taking `sharpnessWindowLock` for the append is a deliberate small structural
     upgrade — but it is only half of the pre-existing unsynchronised
     producer-`add`/bridge-`toList()` pair (`:1327` vs `:764`). The other half is
     finalize's side: `keyframePathsSnapshot = batchKeyframePaths.toList()` today
     runs at `:764`, **outside** the `:758-761` synchronized block. A producer that
     passed its `isRunning` re-check (`:1174`) pre-flip and acquires the window
     lock between `:761` and `:764` could append a path that the racy `toList()`
     observes while its encode job is enqueued *after* finalize's stitch enqueue —
     that path would then fail the exists-filter and be miscounted as
     `framesDropped` despite a perfectly healthy encode. Step 4 therefore **moves
     the snapshot capture inside the `:758-761` synchronized block**. The
     happens-before chain then holds for every snapshot path: *append +
     enqueue(encode) under the lock → release → finalize acquires the same lock
     (`:758`) → drain/commit (enqueuing any trailing encode) → snapshot → release →
     enqueue(stitch)* — a serial `limitedParallelism(1)` dispatcher executes in
     enqueue order, so every encode whose path is in the snapshot completes before
     the stitch job runs. A producer append that misses the snapshot (loses the
     lock race) is invisible to this stitch either way — same as today.
2. **Window-commit path** (default K = 4; `commitSharpnessWindowLocked`,
   `:1512-1589`): split into commit-bookkeeping (under the lock, unchanged
   idempotency: buffered best cleared up-front `:1519-1521`) + the encode/emit as a
   `workScope` job enqueued before the lock is released. The finalize drain
   (`:758-761`) runs on the bridge thread and enqueues its trailing encode before
   finalize enqueues the stitch job on the same thread — program order gives FIFO.
3. **Stitch-start guard:** inside the stitch job (`:853` block, before `:870`),
   filter `keyframePathsSnapshot` through `File.exists()`. Misses are counted into
   the result's `framesDropped` (decided): `framesRequested` stays
   `keyframePathsSnapshot.size`, `framesDropped = missingAtStitch +
   (framesRequested_jni − framesIncluded_jni)` (`:947-959`), and a distinct
   `keyframesMissingAtStitch` int is added to the Phase 0 `timings` block so encode
   failures are distinguishable from stitcher confidence drops. The returned
   `batchKeyframePaths` array (`:978-980`) lists only the files actually handed to
   `stitchSync` — `refinePanorama`'s pre-flight rejects on any missing path
   (`:2041-2054`), so returning ghosts would break the refine tab. The `< 2
   keyframes` check (`:870-876`) runs against the filtered list.
   **`acceptedCount` semantics (decided): stays pre-filter.** The finalize result's
   `acceptedCount = keyframePathsSnapshot.size` (`:956`) keeps reporting gate
   accepts, alongside the also-pre-filter `framesRequested`; only the
   `batchKeyframePaths` array is filtered. Stated consequence for consumers:
   `batchKeyframePaths.length` can be `< acceptedCount` when
   `keyframesMissingAtStitch > 0`. The "Stitched N of M" UX reads
   `framesIncluded`/`framesRequested` and is unaffected. Listed in the §5 table.
4. **Cancel ordering (verified):** `cancel()` enqueues the session-dir delete on
   `workScope` (`:1054-1056`). Encode jobs enqueued before it run first (FIFO),
   write their files, then the delete removes everything — clean. An encode job that
   loses the race (producer passed the `isRunning` re-check at `:1174` just before
   cancel, enqueues after the delete) writes into a deleted dir:
   `encodeJpegFromNV21` does not `mkdirs`, the write throws, it returns null
   (`YuvImageConverter.kt:293-297`) — no directory resurrection, no orphan file, and
   the appended path died with `batchKeyframePaths.clear()` (`:1039`).
5. **Behavioural deltas accepted (named, not hidden):**
   - Pose bookkeeping (`batchFirst/LastAcceptedPose`) is recorded at accept time even
     if the encode later fails (today a failed encode skips it, `:1315-1326`). Encode
     failure is a can't-write-to-own-cache-dir condition; accepting the delta is
     cheaper than plumbing a rollback. Consequence bounded to the stitch-mode
     auto-resolution inputs.
   - The accept event now lands ~30–50 ms later (encode duration) and no longer
     back-pressures the camera. Thumbnail-strip latency change is imperceptible; the
     event still precedes the file's first reader.
   - **Accept/reject event reordering window.** Accept events move to `workScope`
     job completion while reject-state events keep emitting synchronously from the
     producer thread (`:1267-1272`) — so JS can observe reject(frame k+1) *before*
     accept(frame k), impossible today (single-thread program order). Payloads are
     unchanged, only interleaving; the window is bounded by the encode duration
     (~30–50 ms ≈ one eval-cadence interval at defaults). For raw subscribers the
     effect is transient (the next reject refreshes overlap %). The default
     integration's coalescer policy for this window is specified in §4.4 and pinned
     by a Step 3 test.
   - Keyframe *indices* stay dense and capture-ordered (reservation is synchronous),
     but a failed encode leaves a hole on disk — absorbed by (3).

**iOS is out of scope for this change** and honestly diverges: the iOS plugin keeps
the `CVPixelBuffer` reachable into the engine (divergence note,
`CvFlowGateFrameProcessor.kt:46-52`) and serialises engine work on its own
`workQueue` (`IncrementalStitcher.swift:279`); whether its accept path blocks the
`AVCaptureVideoDataOutput` queue long enough to matter has not been measured. Mirror
only if Phase 0 markers show it (§11 Q4).

### 4.4 Change 4 — coalesced `IncrementalStateUpdate` handling

**Structural fix:** one subscription, one state writer, render frequency bounded by
the display, event classes with different urgency handled differently — instead of
two subscribers each re-rendering a 3,500-line tree per event.

- `useIncrementalStitcher` becomes the single stateful consumer:
  - Incoming events are classified:
    **immediate-flush** — accept events (`batchKeyframeThumbnailPath` present or
    `acceptedCount` increased or outcome ∈ {AcceptedHigh, AcceptedMedium}) and
    refine-stage transitions (`refineStage` present and ≠ previous) and any terminal
    refine state (`done`/`error`); **coalesced** — everything else (rejects, skips,
    overlap updates, hints).
  - Coalesced events land in a `pendingRef` (after the existing sticky-snapshot
    merge, `:158-168`, applied per-event so the last-good `panoramaPath` semantics
    are preserved) and a single `requestAnimationFrame` flush performs the one
    `setState` with the latest merged value. Immediate-flush events cancel/absorb
    any pending coalesced event and `setState` directly (out-of-order
    qualification under change 3 in the policy bullet below).
  - `hint`/`lastHintRef` (`:169-179`) keeps updating per raw event (ref write,
    no render); renders pick it up at the next flush.
  - **Lifecycle semantics (decided): discard, not flush.** `start()`, `finalize()`,
    `cancel()` cancel the pending rAF and clear `pendingRef` before their
    `setState(null)` (`:193-196`, `:233-240`, `:246-252`) so a late coalesced event
    cannot resurrect stale state after the capture ended. Unmount cleanup cancels
    the rAF. This is a **named deviation from the brief's "flush pending state on
    finalize"**: everything semantically important (accepts, refine stages,
    terminals) is immediate-flush and never sits in `pendingRef`; the only thing
    that can be pending is a reject/hint/overlap update, and flushing it at
    finalize would paint one frame of stale rejection UI over the stitch spinner
    immediately before the same call nulls the state. Discard is strictly simpler
    and loses nothing a consumer can act on. §1 states the same semantics; the
    Step 3 test list pins it ("finalize discards pending").
  - **`start()` clear ordering (requirement — mirrors the Camera.tsx 2026-05-23
    race fix):** the hook's state clear (`setState(null)`, `pendingRef` + rAF
    cancel, `lastHintRef` reset) moves to **before** `await native.start(options)`
    — today it runs after the await (`useIncrementalStitcher.ts:193-196`). Once
    `Camera.tsx` renders thumbnails from `incremental.state` (Step 3), an ACCEPT
    landing during the start-await window — which the AR GL thread provably does
    (`Camera.tsx:1962-1979`) — must survive; a post-await clear would wipe
    keyframe 0 from the strip, re-opening the exact regression the 2026-05-23 fix
    closed. Pinned by a Step 3 test: an accept event delivered between `start()`
    invocation and native-start resolution survives into `state`.
  - **Out-of-order policy for the change-3 reordering window (§4.3.5):** when an
    immediate-flush accept lands, any `pendingRef` content is JS-arrival-older and
    is dropped (the accept supersedes it). Under change 3, a dropped pending reject
    can be *device-newer* than the accept (evaluated after the accept's gate
    decision, observed before its deferred emit); the cost is one cadence interval
    (~166 ms at N = 5 / 30 fps) of overlap-% staleness, self-corrected by the next
    reject event, which coalesces and commits at the following rAF. Accepted
    explicitly — arrival-time bookkeeping for a UI-transient field is not worth
    building. Pinned by a Step 3 test: reject delivered before its
    device-earlier accept → accept commits immediately, pending reject dropped,
    a subsequent reject commits at the next rAF.
- `Camera.tsx` drops its direct subscription (`:1946-1961`) and its parallel
  `incrementalState` `useState` (`:1467`); it renders from `incremental.state`.
  The thumbnail accumulation (`:1950-1957`) moves to an effect keyed on
  `incremental.state?.batchKeyframeThumbnailPath` (same de-dupe + `toFileUri`
  normalisation). Because accepts are immediate-flush and are separated by at least
  the gate's novelty/window interval in practice, each accept produces its own
  committed state; the theoretical two-accepts-in-one-tick collapse is documented in
  §9 with its mitigation option.
- `subscribeIncrementalState` itself (`incremental.ts:1128-1141`) and
  `useKeyframeStream` are unchanged — the contract on the wire is untouched; only
  the default integration's consumption changes.
- Explicitly **not** doing: `unstable_batchedUpdates` (React 18 auto-batching
  already covers same-tick batching; the review's point stands — the win is
  frequency, and this design caps state commits at ≤1/frame + accepts).

---

## 5. API / config surface changes

| Surface | Change | Compat |
|---|---|---|
| `UseStitcherWorkletOptions` | + `initialIngestActive?: boolean` (default `true`) | additive; bare hosts unchanged |
| `StitcherWorkletHandle` | + `setActive(active: boolean): void` | additive |
| `useFrameProcessorDriver` | constructs the worklet with `initialIngestActive: false`; `start()`/`stop()` drive `setActive` | behavioural: worklet no longer calls the plugin while the driver is stopped (native already dropped those calls; only profiler-visible) |
| `panoramaSettingsToNativeConfig` | + second arg `{ frameSourceMode }`; emits `flowEvalEveryNFrames = 1` when `'frameProcessor'`, settings value otherwise | call-site updates in `Camera.tsx:2206` + `PanoramaSettingsModal` preview if it passes a mode (default keeps today's output) |
| `PanoramaSettings` / native config | + `asyncAcceptEncode?: boolean` (default `false`) — change-3 kill-switch, read via `getBooleanOrDefault` (`IncrementalStitcher.kt:2744`), always serialised | additive; default keeps today's synchronous encode byte-identical; default flipped in a follow-up commit only after the §7.2/§7.3 gates |
| `Camera.tsx` internal | driver constructed with `evalEveryNFrames` from settings (`:1793`); `fpDriver.start()` moves above the `incremental.start` await (+ `catch`-path stop) and `fpDriver.stop()` moves to a `finally` after finalize (§4.1); direct state subscription removed, incl. the `:2152` `setIncrementalState(null)` | none public |
| Worklet throttle | 0-based counter — first frame always evaluates for any N; cadence clamped to [1, 10] mirroring native (`IncrementalStitcher.kt:531-533`) | fixes a latent off-by-one; N=1 paths byte-identical; out-of-range settings keep today's effective cadence |
| Finalize result (Android) | `framesDropped` additionally counts keyframes missing at stitch start; `batchKeyframePaths` lists only files handed to the stitcher; `acceptedCount` stays **pre-filter** (`:956`, gate accepts) so `batchKeyframePaths.length` may be `< acceptedCount` when `keyframesMissingAtStitch > 0`; + `keyframesMissingAtStitch` in the Phase 0 `timings` block | shape-compatible (ints/array already present, `IncrementalStitcher.kt:947-980`) |
| Accept event timing (Android) | with `asyncAcceptEncode = true`: accept events emitted from the encode job (~30–50 ms later), file guaranteed on disk first; reject events may interleave ahead of a deferred accept (§4.3.5) | contract (JPEG-exists-before-event) unchanged; default off until gates pass |
| `useIncrementalStitcher` | same return shape; `state` commits coalesced to ≤1/animation-frame + immediate accept/refine flushes; pending coalesced state discarded at start/finalize/cancel; state cleared **before** the start await (§4.4) | hosts polling `state` per event will observe fewer intermediate values — documented in CHANGELOG |

No native module method signatures change. No Kotlin/Swift public API changes.

---

## 6. Implementation plan (ordered, per-platform)

Each step is a separate commit and independently revertible. Order chosen so the
pure-JS wins land first and the only native step lands last with the most gates.

1. **Step 1 — worklet off-by-one fix + cadence wiring + counter anchor (JS, both
   platforms).**
   Files: `src/stitching/useStitcherWorklet.ts` (0-based throttle, [1, 10] clamp),
   `src/camera/Camera.tsx` (`:1793` options; move `fpDriver.start()` above the
   `incremental.start` await + add `fpDriver.stop()` to the `catch` — the §4.2
   counter anchor and §4.1 open-early half),
   `src/camera/PanoramaSettingsBridge.ts` (+ mode arg),
   `src/camera/__tests__/PanoramaSettingsBridge.test.ts`,
   `src/stitching/__tests__/useStitcherWorklet.test.ts` (throttle-phase cases +
   out-of-range clamp case).
   Native untouched; AR path proven untouched by the bridge-adapter unit tests.
2. **Step 2 — ingest gate + gyro gating + close-late stop (JS, both platforms).**
   Files: `src/stitching/useStitcherWorklet.ts` (shared value, worklet check, gyro
   handler, `setActive`, `initialIngestActive`),
   `src/stitching/useFrameProcessorDriver.ts` (opt-in management),
   `src/camera/Camera.tsx` (relocate `fpDriver.stop()` from `:2334` to a `finally`
   around the finalize await — the §4.1 close-late half; discard paths `:1885`,
   `:2557`, `:1797` unchanged),
   `src/stitching/__tests__/useStitcherWorklet.test.ts` (gate-closed → no
   `plugin.call`; gate default open; `lastGyroAt` idle-gap behaviour),
   `docs/host-app-integration.md` (composed-host `setActive` +
   `subscribeStitchingPhase` pairing).
3. **Step 3 — coalesced events + subscription dedupe (JS, both platforms).**
   Files: `src/stitching/useIncrementalStitcher.ts` (coalescer; move the `start()`
   state clear + `pendingRef`/rAF cancel to *before* `await native.start` — §4.4
   requirement), `src/camera/Camera.tsx` (drop the `:1946-1961` subscription, the
   `:1467` `incrementalState` useState, **and** the now-dangling
   `setIncrementalState(null)` at `:2152` — the synchronous thumbnail clear at
   `:2151` stays; thumbnail effect keyed on
   `incremental.state?.batchKeyframeThumbnailPath`),
   `src/stitching/__tests__/subscribeIncrementalState.refine.test.ts` (extend with
   hook-level coverage: refine stages delivered under coalescing — they are
   immediate-flush, so the existing 4-stage ordering assertions gain a hook-level
   twin), new `src/stitching/__tests__/useIncrementalStitcher.coalesce.test.tsx`
   (fake rAF: N rejects → 1 commit; accept flushes immediately; finalize discards
   pending; late event after finalize does not resurrect state; accept during the
   start-await window survives the clear; reject-before-deferred-accept
   interleaving per §4.4's out-of-order policy).
4. **Step 4 — Android accept-encode offload behind `asyncAcceptEncode` (native +
   config plumbing).**
   Files: `android/src/main/java/io/imagestitcher/rn/IncrementalStitcher.kt`
   (flag read at `start()` via `getBooleanOrDefault` `:2744`; immediate path
   `:1302-1326`, window commit `:1512-1589`, stitch-start exists-filter +
   `framesDropped` fold-in `:853-959`, snapshot capture moved inside the `:758-761`
   synchronized block — §4.3.1, `keyframesMissingAtStitch` telemetry field),
   `src/camera/PanoramaSettings.ts` + `src/camera/PanoramaSettingsBridge.ts` +
   `src/camera/__tests__/PanoramaSettingsBridge.test.ts` (optional
   `asyncAcceptEncode`, default false, always serialised). The default stays
   `false` in this commit; the flip to `true` is a separate follow-up commit gated
   on §7.2 + §7.3 with the flag on. Device-verify points in §7.3.
5. **Step 5 — docs + CHANGELOG.** `CHANGELOG.md` (behaviour deltas from §4.3.5 and
   §5), `docs/stitch-pipeline-architecture.md` cross-reference if the accept-event
   timing note belongs there.

---

## 7. Verification & gates

### 7.1 Unit (jest, per step)

- Throttle: 0-based counter evaluates frames {0, N, 2N…}; N = 1 evaluates all;
  `reset()` re-phases; gate-closed frames do not advance the counter; out-of-range
  cadence (e.g. 20) clamps to 10, mirroring native's `coerceIn(1, 10)`.
- Gate: closed → no `plugin.call`, no counter advance; open-by-default for bare
  hook; driver `start()` → open + reset, `stop()` → closed.
- Bridge adapter: `frameProcessor` mode → `flowEvalEveryNFrames === 1`; `arSession`
  mode → settings value (5 by default); all other keys unchanged (snapshot).
- Coalescer: as listed in Step 3, plus sticky-snapshot merge preserved across
  coalesced updates, and hint stickiness semantics unchanged.

### 7.2 Output-parity gates (required before flipping any default)

- **Step 1 gate (cadence relocation):** stated per §4.2's honest cadence claim —
  exact evaluated-index-set equality is **not** the criterion for N > 1, because
  the grid anchor moves from native-enable to JS capture start (δ ≤ one bridge
  round-trip, nondeterministic run-to-run). On the fixed capture rig (same device,
  scripted pan; the e2e offline harness's replay discipline), record
  evaluated-frame indices native-side before/after. PASS =
  (a) N = 1 configs byte-identical (every frame evaluated, counter not in play);
  (b) N > 1: **exact inter-evaluation spacing** (every Nth arriving frame — any
  mid-capture re-phase is a hard fail) with a start-window offset ≤ N−1 frames vs
  baseline;
  (c) hard criteria: **accepted-keyframe count + dims equal** across rig runs, and
  a side-by-side stitch byte-identical whenever the two runs' keyframe JPEGs are
  identical (same files → same stitch input; the stitch itself is untouched by this
  spec). If the phase offset yields differing keyframe JPEGs on the rig, compare at
  the panorama level (SSIM) and take the delta + evaluated-index traces to the
  operator — explicit sign-off, not silent acceptance.
- **Step 2 gate (gate lifecycle):** superset-interval check on the rig, using
  Phase 0's counters (§7.4): capture-window `fpPluginFastExits` ≈ baseline for the
  same scripted pan (the gate must not drop capture-window frames — a handful at
  capture start from the pre-native-enable window is today's behaviour too), and
  **final-keyframe parity**: the last committed keyframe's index + file hash match
  baseline across rig runs — the tail-frame check proving the lockstep close keeps
  today's sharpness-window candidate set.
- **Step 4 gate (encode relocation):** run **with `asyncAcceptEncode = true`** (the
  flag-off path is byte-identical by construction and needs no gate; the default
  flip commit cites these results). Encode inputs (packed NV21, quality 80,
  displayRotation) are unchanged, so per-keyframe JPEGs must be **byte-identical**
  vs pre-change for the same captured frames; verified on the rig by hashing the
  session dir. Event-order gate: accept events observed in JS strictly follow
  file-exists (assert by statting `thumbnailPath` in a test listener on-device).
- **Deferred time-based cadence** (§11 Q2) additionally requires an A/B on a 60 fps
  device: accept-count distribution + SSIM of final panoramas vs frame-counter
  baseline, with operator sign-off, because it changes the evaluated set.

### 7.3 On-device verify points (named, per platform)

- Android (A35-class): idle phase (camera screen open, not capturing) — frame
  processor thread near-0 plugin activity; capture phase — no producer-thread stalls
  at accepts (systrace: camera thread max block < 10 ms, with
  `asyncAcceptEncode = true`); stitch phase — plugin silent; first keyframe present
  after a fast hold-start (the §4.4 start-await race, on device); cancel-mid-capture
  leaves no session dir and no orphan files; finalize with a hand-deleted keyframe
  file (fault injection) produces `framesDropped ≥ 1` +
  `keyframesMissingAtStitch = 1`, not a crash; refine tab still works after a
  normal finalize; a multi-capture soak with the flag on shows
  `keyframesMissingAtStitch = 0` throughout.
- iOS (iPhone 14-class): Steps 1–3 only — worklet gate closed during stitch phase
  (Instruments: no `cv_flow_gate` plugin calls), accept/refine event flow unchanged,
  AR-mode capture regression pass (worklet AR short-circuit untouched).
- RN 0.79 Paper host (the motivating environment): before/after CPU profile of the
  frame-processor thread and JS thread across idle → capture → stitch.

### 7.4 Measurement column — which telemetry proves each change

Phase 0 fields marked **(P0)**; fields this spec adds marked **(new)** — all (new)
fields ride in the same finalize `timings` block / JS markers Phase 0 introduces,
dev-gated the same way. External-profiler evidence marked **(prof)**.

| Change | Proof fields | Expected movement |
|---|---|---|
| 1. Ingest gate | `fpPluginCalls` + `fpPluginFastExits` **(new: native counters, reset at start, reported at finalize)**; frame-processor-thread CPU% idle/stitch **(prof)**; `jsOverheadMs` JS-side markers **(P0)** | idle/stitch-phase fast-exits → ~0 (calls stop arriving instead of being rejected); a handful of fast-exits remain per capture from the pre-native-enable start window (§4.1 — present today too); idle/stitch FP-thread CPU ↓ |
| 2. Decimation | `packNv21Count` vs `gateEvalCount` **(new: native counters)**; keyframe count + dims **(P0)**; producer-thread CPU **(prof)** | `packNv21Count ≈ gateEvalCount` (was ~N×); gateEvalCount unchanged vs baseline; keyframe count/dims unchanged |
| 3. Encode offload | `acceptEncodeMaxMs` + `acceptEncodeTotalMs` per capture **(new)**; `queueDelayMs` **(P0** — now also absorbs pending encode drain; expected still ≪ stitch time**)**; `keyframesMissingAtStitch` **(new)**; camera-thread max block **(prof)** | producer-thread accept block 30–50 ms → <1 ms; `queueDelayMs` grows by at most one trailing encode (~30–50 ms); missing-at-stitch stays 0 in healthy runs |
| 4. Event coalescing | `eventsReceived` vs `stateCommits` counters in the hook **(new: dev-only JS counters, exposed on the Phase 0 JS markers channel)**; render count of `Camera` **(prof: React Profiler)** | commits ≤ rAF rate + accepts; `Camera` renders/s during capture ↓ ~2× or better in AR mode |

All CPU-percentage claims in this spec are **estimated** until these fields say
otherwise; the only **measured** inputs are the repo's own figures cited in §3
(30–50 ms accept encode, `IncrementalStitcher.kt:1630-1632`; ~6 reject events/s at
default cadence, `:1263-1266`).

---

## 8. Dependencies & sequencing

- **On Phase 0 (telemetry):** §7.4's (new) counters are specified to ride inside the
  Phase 0 `timings` block and JS markers — Step 4's verification *depends on* Phase 0
  having landed (or the counters land with Phase 0 by agreement). Steps 1–3 can land
  before Phase 0 but their quantitative sign-off waits for it; the §7.2 parity gates
  do not depend on Phase 0.
- **On Phase 1:** no code dependency. Two coordination points: (a) the composed-host
  guidance for `setActive` references Phase 1's `subscribeStitchingPhase()` wrapper —
  docs merge after whichever lands second; (b) Phase 1's reject-throttle
  config (default 0 = unthrottled) makes change 4 the *only* protection against
  full-rate reject events on the render path — land Step 3 before or with any
  experiment that sets the reject throttle to 0 on a 60 Hz AR device.
- **Within this spec:** Step 1 → Step 2 (both touch the worklet body; 1 first keeps
  the parity gate isolated). Step 3 independent. Step 4 independent of 1–3 but last,
  because it is the only native step and the only one with device-verify blocking
  points; its `asyncAcceptEncode` default-flip is a separate follow-up commit that
  lands only after the §7.2 Step 4 gate and §7.3 device-verify pass with the flag
  on.
- **`refinePanorama` budget consistency:** this spec does not touch stitch budgets
  (Phase 1 removes the low-RAM block; budgets revert to pre-branch defaults), so
  refine (`IncrementalStitcher.kt:2056-2095`) stays consistent by not diverging —
  the only refine-relevant change here is that `batchKeyframePaths` in the finalize
  result is guaranteed to list existing files (§4.3.3), which *strengthens* refine's
  pre-flight contract (`:2041-2054`).

---

## 9. Risks & mitigations

| Risk | Mitigation | Structural note |
|---|---|---|
| Shared-value propagation lag around `setActive` writes | The lockstep lifecycle (§4.1) makes lag harmless in both directions: the gate opens before native `start()` is even invoked, so a late-propagating open only delays frames native would fast-exit anyway; it closes after `finalize()`/`cancel()` is invoked, when native ingest is already cut (`IncrementalStitcher.kt:736-737`, `:1028`) | The gate is an optimisation layered on a verified authoritative native gate — not a new correctness dependency |
| Future edit re-closes the gate before finalize (silently regressing tail-frame parity) | §7.2 Step 2 gate pins final-keyframe index + hash on the rig; §4.1 documents *why* close-late is load-bearing (tail frames feed the open sharpness window, `IncrementalStitcher.kt:1253-1258`) | The invariant is written down where the next editor will look, and gated |
| Composed host forgets `setActive` | Default-open bare hook = zero behaviour change; only opt-in managers change | API designed so ignorance is safe |
| Worklet grid anchor differs from today's native anchor (Step 1) | Counter reset moves to capture start, pre-await (§4.2): no mid-capture re-phase; steady-state spacing exact; start offset bounded ≤ N−1 frames; §7.2 Step 1 gate pins spacing + accepted-keyframe count/dims | Honest bounded delta — stated and gated, not claimed away |
| Step 4 regression discovered after release | `asyncAcceptEncode` default-false kill-switch (§4.3): flip-back is a config change, not a release revert; flag retired only one release after the default flip | Repo convention for behaviour-altering native changes, applied |
| Accept/reject reordering (change 3) confuses a raw subscriber | Window bounded to the encode duration; payloads unchanged; §4.3.5 names it, CHANGELOG documents it; the default integration's coalescer policy handles it (§4.4) with a pinned test | Named, accepted delta with a bounded, self-correcting consequence |
| Encode job fails after path committed (Android) | `File.exists()` filter at stitch start; `framesDropped` + `keyframesMissingAtStitch`; `< 2` check runs post-filter | Failure is absorbed at the single consumer of the paths, not scattered |
| Encode job races cancel's dir delete | FIFO puts queued encodes before the delete; late enqueue writes fail benignly (`YuvImageConverter.kt:293-297` — no `mkdirs`) | Verified ordering, not a sleep |
| Accept event later by encode duration | 30–50 ms on a strip that updates at human pan speed; invariant (file before event) preserved | Named, accepted delta (§4.3.5) |
| Pose bookkeeping recorded for a keyframe whose encode failed | Bounded to stitch-mode auto-resolution inputs; failure mode is already an unhealthy-device condition | Named, accepted delta (§4.3.5) |
| Coalescing hides an event a host depended on | Accepts + refine stages + terminals flush immediately; only rejects/hints/overlap coalesce, and only within one animation frame; CHANGELOG documents it | Event classes chosen by consumer semantics, not blanket throttling |
| Two accepts inside one JS tick collapse into one thumbnail | Accept spacing is bounded below by gate novelty/window in practice; if the rig ever shows it, the fallback is the hook maintaining the thumbnail array itself (raw-event append, coalesced expose) — noted, not built speculatively | Escape hatch identified before it's needed |
| `Camera.tsx` regressions from removing its subscription | The hook's state is a superset of what `Camera.tsx` consumed (same event payloads); Step 3 lands with the coalesce test suite + on-device capture UX pass | Single-writer state is the simpler invariant |

---

## 10. Non-goals

- **No Phase 1 work** (AR render pause removal, low-RAM block removal, reject
  throttle config, thread priority, `subscribeStitchingPhase`) — parallel spec.
- **No Phase 0 work** beyond declaring the counter fields this spec's verification
  consumes.
- **No stitch-pipeline changes** — ladder, manual-vs-high-level, matcher/seam
  settings, budgets, `refinePanorama` internals all untouched
  (`useManualPipeline=false` at `IncrementalStitcher.kt:936` stays as-is).
- **No AR-mode ingest changes** — the AR short-circuit (`useStitcherWorklet.ts:362`)
  and the AR-path cadence (`IncrementalStitcher.kt:1207-1211`) keep their behaviour.
- **No iOS accept-encode offload** (§4.3, §11 Q4) and no iOS-side native edits at
  all — Steps 1–3 reach iOS through shared JS only.
- **No keyframe resolution / quality changes** (640/1280 budgets in
  `YuvImageConverter.kt:247-249` untouched).
- **No event-contract changes on the wire** — `IncrementalStateUpdate` payloads and
  `subscribeIncrementalState` are byte-identical; only consumption changes.
- **No `useKeyframeStream` changes.**

---

## 11. Open questions

1. **Where exactly do the (new) counters live in the Phase 0 schema?** This spec
   assumes they are additive fields in the `timings` block (`fpPluginCalls`,
   `fpPluginFastExits`, `packNv21Count`, `gateEvalCount`, `acceptEncodeMaxMs`,
   `acceptEncodeTotalMs`, `keyframesMissingAtStitch`) + two JS-marker counters
   (`eventsReceived`, `stateCommits`). Needs a 10-minute schema agreement with the
   Phase 0 owner before Step 4.
2. **Time-based cadence (runAtTargetFps-style) as the eventual default?** Requires:
   (a) verifying `runAtTargetFps` per-callsite state isolation in the pinned
   vision-camera version (peer `>=4.7.0`, `package.json:78` — not verifiable in this
   worktree, no `node_modules`), or implementing the equivalent over a hook-owned
   `sharedLastEvalTs` with a verified `frame.timestamp` unit story on both
   platforms; (b) the §7.2 A/B on a 60 fps device; (c) a product decision on
   normalising 60 fps devices down to the 30 fps-tuned eval rate. Deferred; the
   frame counter ships first.
3. **Should the snapshot-consistency fixes be back-ported as their own commit?**
   §4.3.1 folds two pre-existing races into Step 4: the K == 1 append moving under
   `sharpnessWindowLock` (`IncrementalStitcher.kt:1327` / `:764`) and the finalize
   snapshot `toList()` moving inside the `:758-761` synchronized block. Both exist
   independently of this spec, and unlike the rest of Step 4 they are correct
   regardless of `asyncAcceptEncode`. If Step 4 slips, extract them.
4. **Does the iOS accept path measurably block the capture queue?** The iOS engine
   ingests the CVPixelBuffer zero-copy and serialises on `workQueue`
   (`IncrementalStitcher.swift:279`); whether its keyframe persistence stalls the
   `AVCaptureVideoDataOutput` queue the way Android's 30–50 ms encode stalls the
   producer thread is unmeasured. Decide after Phase 0 markers exist on iOS.
5. **Gyro: is skipping writes enough, or should long-idle screens unsubscribe?**
   The handler-gating design keeps the sensor sampling at 30 Hz (cost documented as
   ≪1% CPU, `useStitcherWorklet.ts:66-70`). If a host profile ever shows the
   subscription itself mattering, `setActive(false)` is the natural place to also
   pause the subscription — deferred until evidence exists.
6. **Multi-accept-per-tick thumbnail collapse** (§9): accept the documented risk or
   pre-build the hook-owned thumbnail array? This spec accepts the risk; revisit if
   the capture rig ever reproduces it.
7. **Should the JS gate eventually close *early* (pre-yield), realizing the
   `Camera.tsx:2331-2333` comment's intent?** This spec's lockstep close keeps
   pixel parity by letting the 1–3 pre-finalize tail frames keep feeding the open
   sharpness window (§4.1). Closing at `stop()` instead would deterministically end
   the candidate set at hold-release — arguably the better product behaviour (the
   comment's stated intent) and a stricter frames-stop-before-stitch invariant —
   but it changes final-keyframe selection. Needs a rig A/B on final-keyframe
   content + operator sign-off; deferred, not bundled.
