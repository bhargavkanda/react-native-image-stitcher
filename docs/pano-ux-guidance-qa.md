# Panorama UX Guidance — on-device QA checklist

Branch: `feature/pano-ux-guidance` (off `fix/oom-complete`). Everything below
compiles + passes unit tests + builds (JS `tsc` 0, jest 208/208, cpp 62/62,
Android `:app:installDebug` OK). What remains is
**on-device camera / motion / gesture verification** — flows that can only be
eyeballed on a real device, which is why they're handed to you here.

Run: Metro on **8082** (`npx react-native start --port 8082 --reset-cache`;
`adb reverse tcp:8082 tcp:8082`), example app on the A35.

> **BREAKING:** `<Camera>` now defaults to `panMode="mode-a"` (landscape-only
> panorama). To restore both orientations pass `panMode="both"`. Verify the
> example app still behaves as intended under the new default.

## Per-item checks

**Item 1 + 2 — Mode-A gate + rotate prompt**
- [ ] In portrait, press-and-hold the shutter → capture does NOT start; the
      code-drawn rotating-phone graphic (sharp at any density) + "Rotate to
      landscape" pill appears, and the phone graphic animates (rotates
      portrait→landscape→portrait).
- [ ] Rotate the phone to landscape (try BOTH landscape-left and
      landscape-right) → prompt dismisses and capture auto-starts.
- [ ] Release the shutter while still in portrait → prompt clears, nothing
      starts, and rotating afterwards does NOT spuriously start a capture.
- [ ] With `panMode="both"`, a portrait hold starts immediately (no prompt)
      and pans Mode B (left→right) as before the guidance work. The example
      app has a `__DEV__` **🧭 panMode** toggle (top-left, under Rect debug)
      to flip `mode-a` ↔ `both` at runtime — verify the rotate prompt appears
      ONLY in `mode-a`.

**Item 3 — Pan how-to + bouncing arrow**
- [ ] At capture start the code-drawn pan graphic (white phone + sweeping
      amber band) shows for ~2.5 s with a bouncing amber arrow pointing DOWN
      (Mode A landscape). The band sweeps along the pan axis. It reads
      upright under a portrait-locked host. Auto-fades.

**Item 4 — "Moving too fast"**
- [ ] Pan fast → the "Moving too fast — slow down" pill appears; slow down →
      it disappears. Tune `panTooFastThreshold` (rad/s) if the trip point feels
      off (default warn = 1.0).

**Item 5 — 9 s countdown + auto-finalize**
- [ ] Countdown blinks 9→0 in the (user-perceived) top-left, upright in
      landscape.
- [ ] Hold WITHOUT releasing for 9 s → capture auto-finalizes and produces a
      panorama via `onCapture` (no manual release needed).
- [ ] Release at ~5 s → finalizes immediately, and the timer does NOT fire a
      second finalize afterwards (watch for a double `onCapture`).
- [ ] `maxPanDurationMs={0}` → countdown hidden, no auto-stop.

**Item 6 — Lateral drift → finalize + popup**  ⚠️ needs threshold tuning
- [ ] Deliberately slide the phone SIDEWAYS (cross-axis to the pan) → capture
      STOPS, **finalizes what was captured** (you get a panorama), and the
      "Keep the pan straight" popup shows.
- [ ] A normal straight pan (with natural wobble) does NOT false-trigger. This
      is the critical tuning gate — adjust `lateralBudgetCm` (default 5).
- [ ] **Assumption to confirm (`usePanMotion.ts`):** the cross-pan axis is
      assumed to be device-**Y**. If sideways motion does NOT trip it but
      forward/back does, swap the integrated accelerometer axis `y`→`x` in
      `usePanMotion.ts` (flagged in that file's header). Also note the IIR
      gravity model means a *constant* lean is absorbed (~200 ms) — only a
      transient SLIDE registers; confirm that matches the intended feel.

**Item 7 — Draggable-quad crop + perspective rectify**
- [ ] With `rectCropPreview`, after a stitch the crop editor shows the result
      with 4 draggable corners. Corners don't jump on first touch.
- [ ] Drag into a skewed (non-rectangular) quad → Crop → output is a
      perspective-rectified upright rectangle (native `cropToQuad`).
- [ ] Drag to an axis-aligned rectangle → Crop → a plain crop.
- [ ] Cancel → the original (un-cropped) panorama is emitted.
- [ ] OOM watch: crop a very large panorama — the native warp is size-guarded
      (`canvasExceedsGuard`) but verify no jetsam/lmkd on a low-RAM device.

## Native parity still to verify
- [ ] **iOS `cropToQuad`** (`OpenCVStitcher.mm` + Swift bridges) compiles +
      runs — it mirrors the Android Kotlin path but was NOT compiled headless
      (no xcodebuild run here). Build the iOS pod + run the Item-7 checks on
      iOS. Confirm the error codes (1023/1024/1025) surface acceptably via
      `classifyStitchError`.
- [ ] Confirm `NativeModules.BatchStitcher.cropToQuad` is registered on both
      platforms (the JS wrapper falls back gracefully if not).

## Carried over (separate from this feature)
- [ ] **OOM seam-fix wide-pan retest** (on `fix/oom-complete`, also in this
      branch): a single wide pan should now log `step9: … maxWarpedMP=… →
      seamMP≈0.10` and complete (`step11b`) without OOM. This was the last
      open OOM item when the UX work began.

## Hardening pass (v0.16) — crop, onCapture, stitch robustness, memory

**Issue 2 — crop seeded from the max-inscribed rectangle**
- [ ] With `rectCropPreview`, the editor opens with the quad already on the
      tightest clean rectangle (no black corners), NOT a uniform 8 % inset.
      (When the editor is on, the native auto-crop is forced off, so the
      panorama still shows its black borders for you to drag out into.)
- [ ] If the native `computeInscribedRect` is unavailable it silently falls
      back to the 8 % inset — capture still works.

**Issue 5 — "Use original" + warnings + unified onCapture**
- [ ] The crop editor shows three buttons: **Use original** (emits the
      stitch un-cropped), **Reset** (re-seed), **Crop** (apply).
- [ ] Pan a short/jerky capture so <70 % of frames are used → an amber
      **warning banner** appears across the top of the crop editor, and the
      `onCapture` result's `warnings[]` contains `LOW_FRAME_UTILIZATION`
      (check the example's `[example] capture warnings` log).
- [ ] Trigger a lateral-drift stop (item 6) → `warnings[]` contains
      `LATERAL_DRIFT_FINALIZE`.
- [ ] Force a stitch failure (e.g. cover the lens / too-fast pan) →
      `onCapture` fires with `ok:false` AND `onError` fires (mirror). The
      example logs `onError` and bails in `handleCapture`.

**Issue 3 — post-stitch disjoint/garbage detector**
- [ ] A clearly broken stitch (disjoint / floating-frame output) now FAILS
      with `STITCH_LOW_QUALITY` ("That didn't come out right — try again")
      instead of emitting a broken image. Watch logcat for
      `step11d: validate output components=… fragment=…` and, on reject,
      `step11d: REJECTED — stitch validation failed: disjoint output …`.
- [ ] A NORMAL good pano logs `step11d: … components=1 fragment=0.000` and
      passes (zero false positives — this is the key thing to confirm:
      good captures must never be rejected).

**Issue 4 — quality-driven cylindrical warper for wide pans**
- [ ] On a WIDE pan, logcat shows `step7.6: switching 'plane' -> cylindrical
      (diverge=0 wide=1 sweep=…deg …)` — the warper now switches on sweep
      angle, not just on an OOM divergence. A narrow pan stays on plane
      (`wide=0`, no switch).
- [ ] **A/B the end-perspective:** compare a wide pan's extremes vs the old
      plane output. ⚠️ cylindrical bounds the *horizontal* angle; for a
      Mode-A *vertical* pan the stretched axis is the cylinder's unbounded
      one. If the ends still look stretched, flip `kWidePanWarper` to
      `"spherical"` in `cpp/stitcher.cpp` (one line, flagged in the step-7.6
      comment) and rebuild. The sweep angle is logged so the 45° trip point
      is tunable from real traces.

**Issue 6 — headroom-based memory check (route, don't hard-abort)**
- [ ] The flat 700 MB-class RSS abort is gone. logcat at the routing point
      shows `step8: … rss=…MB budget=…MB (… or lowHeadroom=0/1) — routing to
      STREAM+feather` — under memory pressure it routes to STREAM instead of
      aborting.
- [ ] The pre-stitch abort now only fires when there's no room for even a
      minimal stitch: `PRE-STITCH ABORT: rss=… + minStitch=350MB >
      perProcessBudget=…`. A memory-heavy host with headroom remaining
      should NO LONGER spuriously abort a small stitch.

## Notes
- All guidance is gated behind `panGuidance` (default true) — set false to
  opt out entirely. All copy is overridable via the `guidanceCopy` prop.
- The two motion graphics (rotate-to-landscape, pan-capture) are drawn
  programmatically in `src/camera/guidanceGraphics.tsx` using pure RN core
  `View` + `Animated` — NO image assets, NO `react-native-svg`. They are
  resolution-independent (sharp at any screen density) and themeable via
  `GUIDANCE_TOKENS`.

## Host requirement: NONE for the guidance graphics (items 2 & 3)
The rotate/pan graphics are now code-drawn, so there is **no host setup**:
no Fresco `animated-gif` module, no bundled GIFs, no extra dependency. This
replaced the earlier GIF approach, which looked pixelated on high-density
screens and required every Android host to add Fresco's animated-gif module
to make the GIFs move.
