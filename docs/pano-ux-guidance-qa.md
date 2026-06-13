# Panorama UX Guidance — on-device QA checklist

Branch: `feature/pano-ux-guidance` (off `fix/oom-complete`). Everything below
compiles + passes unit tests + builds (JS `tsc` 0, jest 208/208, cpp 62/62,
Android `:app:installDebug` OK, GIFs verified in `npm pack`). What remains is
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
      `rotate-to-landscape.gif` + "Rotate to landscape" pill appears.
- [ ] Rotate the phone to landscape (try BOTH landscape-left and
      landscape-right) → prompt dismisses and capture auto-starts.
- [ ] Release the shutter while still in portrait → prompt clears, nothing
      starts, and rotating afterwards does NOT spuriously start a capture.
- [ ] With `panMode="both"`, a portrait hold starts immediately (no prompt).

**Item 3 — Pan how-to + bouncing arrow**
- [ ] At capture start the `pan-capture.gif` shows for ~2.5 s with a bouncing
      amber arrow pointing DOWN (Mode A landscape). It reads upright under a
      portrait-locked host. Auto-fades.

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

## Notes
- All guidance is gated behind `panGuidance` (default true) — set false to
  opt out entirely. All copy is overridable via the `guidanceCopy` prop.
- The two GIFs are bundled (`src/camera/assets/`, copied to `dist` on build,
  shipped via `dist/**/*.gif`). GIF was chosen over Lottie to avoid a heavy
  peer dep; the design handoff offers Lottie/APNG on request if the crisper
  look is wanted.


## Host requirement: animated GIFs on Android (items 2 & 3)
The two guidance animations ship as GIFs. **React Native's Android image
loader (Fresco) decodes only the FIRST frame of a GIF unless the host app adds
the animated-gif module** — otherwise the rotate/pan graphics appear *static*.
Hosts must add to their `android/app/build.gradle` dependencies (version
tracking RN's bundled Fresco, see `react-native/gradle/libs.versions.toml`):

    implementation("com.facebook.fresco:animated-gif:3.6.0")

iOS animates GIFs natively (no change). The example app now includes this dep.
If a dependency-free animation is preferred, the design handoff can supply a
Lottie/APNG export instead — that's a follow-up, not done here.
