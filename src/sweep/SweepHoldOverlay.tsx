// SPDX-License-Identifier: Apache-2.0
/**
 * SweepHoldOverlay — what the sweep draws over the camera while it is armed
 * and running (M7): the growing-panorama capsule, and the governor / HUD
 * block with its τ chip and arm notice. MOVED VERBATIM from
 * `PanoPlusCaptureSurface`, which renders it at the same place in its tree;
 * from M8 `<Camera>` renders it over its own camera instead.
 *
 * Pure drawing: every value comes from `useSweepEngine`.
 */
import React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { sweepSurfaceStyles as styles } from './sweepSurfaceStyles';
import type { PreviewSlot, SweepEngine } from './useSweepEngine';

export interface SweepHoldOverlayProps {
  armContract: SweepEngine['armContract'];
  armDetailOpen: SweepEngine['armDetailOpen'];
  armNotice: SweepEngine['armNotice'];
  basisWriteDisagreement: SweepEngine['basisWriteDisagreement'];
  drops: SweepEngine['drops'];
  error: SweepEngine['error'];
  guidance: SweepEngine['guidance'];
  hud: SweepEngine['hud'];
  lockWarning: SweepEngine['lockWarning'];
  onPreviewSlotLoad: SweepEngine['onPreviewSlotLoad'];
  phase: SweepEngine['phase'];
  preview: SweepEngine['preview'];
  previewLayout: SweepEngine['previewLayout'];
  previewLoadFailed: SweepEngine['previewLoadFailed'];
  previewPinNotice: SweepEngine['previewPinNotice'];
  previewPlaceholder: SweepEngine['previewPlaceholder'];
  previewSlots: SweepEngine['previewSlots'];
  previewStale: SweepEngine['previewStale'];
  runningUncorrected: SweepEngine['runningUncorrected'];
  setArmDetailOpen: SweepEngine['setArmDetailOpen'];
  setPreviewLoadFailed: SweepEngine['setPreviewLoadFailed'];
  sweepFaults: SweepEngine['sweepFaults'];
  sweeping: SweepEngine['sweeping'];
  viewfinderNotice: SweepEngine['viewfinderNotice'];
}

export function SweepHoldOverlay({
  armContract,
  armDetailOpen,
  armNotice,
  basisWriteDisagreement,
  drops,
  error,
  guidance,
  hud,
  lockWarning,
  onPreviewSlotLoad,
  phase,
  preview,
  previewLayout,
  previewLoadFailed,
  previewPinNotice,
  previewPlaceholder,
  previewSlots,
  previewStale,
  runningUncorrected,
  setArmDetailOpen,
  setPreviewLoadFailed,
  sweepFaults,
  sweeping,
  viewfinderNotice,
}: SweepHoldOverlayProps): React.JSX.Element {
  return (
    <>
      {/* THE GROWING PANORAMA. Our own image, not the library's
          PanoramaBandOverlay: that component's fill-ratio progress reads
          `paintedExtent/panExtent`, which the shipped batch-keyframe engine
          hard-zeroes, so reusing it would render a progress bar that is
          structurally always empty.

          The FRAME is computed, not styled — `panoPlusPreviewLayout` places a
          FIXED capsule (the slit-scan band's own 64 pt strip) and lets the
          panorama grow inside it. It USED TO be sized from the live aspect so
          that it hugged the image; that is what made it walk across the screen
          as the sweep grew, which is defect #3 of 2026-09-03. Between those
          two it was a hard-coded 120 pt letterbox, which made a tall panorama
          invisible (2026-08-23). The capsule is neither.

          It is also rendered while there is nothing to show yet, carrying the
          reason — an empty screen is the bug being fixed here, and a frame
          that says "nothing has arrived" is a report, not a blank. */}
      {(preview != null || previewPlaceholder != null) && (
        <View
          style={[styles.previewFrame, previewLayout.frame]}
          pointerEvents="none"
          testID="panoplus-preview-frame">
          {preview != null ? (
            <>
              {/* THE ROTATION CONTAINER. `inner` is the frame's padded
                  interior, transposed on a quarter turn, so rotating this box
                  about its centre lands it back on that interior exactly —
                  the identity the old single-<Image> form relied on, kept, but
                  now with the IMAGE free to move inside it.

                  ⚠ THE IMAGE IS NO LONGER CENTRED IN THE FRAME (2026-09-03).
                  It is `contain`-fitted into `inner` and pinned at `anchor`,
                  which is the sweep's START edge. That is the half of the fix
                  the frame's own pinning does not cover: a centred image in a
                  fixed strip would still drift as it grew, and the operator's
                  "not knowing where the pano starts" would survive. */}
              <View
                style={{
                  position: 'absolute',
                  width: previewLayout.inner.width,
                  height: previewLayout.inner.height,
                  left: (previewLayout.frame.width
                    - previewLayout.inner.width) / 2,
                  top: (previewLayout.frame.height
                    - previewLayout.inner.height) / 2,
                  transform: [{ rotate: `${previewLayout.imageRotateDeg}deg` }],
                }}
                pointerEvents="none"
                testID="panoplus-preview-inner">
              {/* THE TWO SLOTS. Both mounted for the life of the sweep with
                  stable keys — mounting is itself what guarantees a blank, so
                  neither may be conditionally rendered. Only OPACITY changes
                  between them, and opacity is a view prop that cannot dirty a
                  Drawee. See [previewSlots] for the mechanism and for why the
                  two previous attempts could not have worked. */}
              {(['a', 'b'] as const).map((which) => {
                const held = previewSlots[which];
                const shown = previewSlots.visible === which;
                // FIRST-FRAME FALLBACK. The assignment runs in an effect, so on
                // the very first publish neither slot is filled yet. Without
                // this the panel would stay empty for one commit and the first
                // preview would arrive a frame late — the opposite of the point.
                // It applies ONLY while nothing is held anywhere; once either
                // slot has a uri the ping-pong owns both, and the visible
                // slot's source stops changing, which is the whole mechanism.
                const nothingHeld =
                  previewSlots.a == null && previewSlots.b == null;
                const slot: PreviewSlot | null =
                  held ??
                  (shown && nothingHeld && preview != null
                    ? {
                        uri: preview.uri,
                        width: previewLayout.content.width,
                        height: previewLayout.content.height,
                        left: previewLayout.anchor.left,
                        top: previewLayout.anchor.top,
                      }
                    : null);
                return (
                  <Image
                    key={`panoplus-preview-slot-${which}`}
                    // An empty uri on a slot that has never been filled: it
                    // stays mounted and simply paints nothing, which is what
                    // keeps it warm for its first real assignment.
                    source={slot != null ? { uri: slot.uri } : { uri: '' }}
                    style={[
                      styles.previewImage,
                      {
                        // FROZEN AT ASSIGN TIME, not read live. A held frame
                        // re-fitted into a box that has since grown would
                        // letterbox-centre under `contain` instead of staying
                        // anchored, which is the moving-boundary defect.
                        width: slot?.width ?? 0,
                        height: slot?.height ?? 0,
                        left: slot?.left ?? 0,
                        top: slot?.top ?? 0,
                        opacity: shown ? 1 : 0,
                      },
                    ]}
                    resizeMode="contain"
                    // ANDROID-ONLY, IGNORED ON iOS. Decodes to the VIEW's size
                    // rather than the file's, which is the preview's memory
                    // fix: a ~2.3 MB ARGB_8888 entry becomes ~0.4 MB at panel
                    // size. It is NOT related to the flicker in either
                    // direction; the earlier comment here blaming the fade was
                    // wrong and has been removed rather than reworded.
                    resizeMethod="resize"
                    // Kept, but for its own reason and not as the flicker fix:
                    // a 300 ms ramp against a sub-second publish interval would
                    // be a second, independent artefact, and a fade on the
                    // incoming slot would show the outgoing slot through it.
                    fadeDuration={0}
                    // The VISIBLE slot keeps the historic id, so every
                    // existing assertion about 'the preview' still points
                    // at the image the operator is actually looking at.
                    // testID is not a source prop and cannot dirty a Drawee.
                    testID={shown ? 'panoplus-preview' : `panoplus-preview-hidden-${which}`}
                    onLoad={() => {
                      if (slot != null) onPreviewSlotLoad(which, slot.uri);
                    }}
                    onError={() => {
                      // Release the slot rather than stranding the swap: the
                      // timeout would eventually promote a slot that will never
                      // paint, so mark the failure and let the next publish
                      // take this slot instead.
                      if (shown) setPreviewLoadFailed(true);
                    }}
                  />
                );
              })}
              </View>
              {/* ⚠ THE BLUE FRONTIER LINE AND ITS CAPTION WERE DELETED HERE ON
                  2026-09-03, AND SO WAS THE "showing the last x%" WINDOW
                  CAPTION. All three were engine diagnostics on an
                  operator-facing preview, and all three were reported as
                  defects in the same breath: "There are 2 changing boundaries
                  in the preview - which I do not understand what they are. One
                  is a blue line - do not understand why this is needed because
                  the image grows beyond that point... Make it like how iOS
                  pano shows the preview! Just the preview of what output looks
                  like - the exact image you are going to get as the result."

                  HIS REASONING IS ALSO CORRECT, which is why this is a delete
                  and not a re-caption: the pixels past the line ARE the
                  output. The preview's provisional lead-out warps the same
                  `lastBgr` through the same `lastHint` that `Engine::finish`'s
                  tail flush commits at stop (`rnis_pano.cpp:4213-4247` vs
                  `:4032-4045`), so a line saying "not saved yet" marks a
                  boundary the deliverable does not have.

                  NOTHING IS LOST TO THE PACK. `frontierFrac`, `leadOutPx`,
                  `previewWindowed`, `previewViewPx` and `previewBandPx` are
                  still computed, still published on the status channel and
                  still written to `meta.json`; `panoPlusPreviewMarker`,
                  `panoPlusFrontierCaption` and `panoPlusPreviewWindowCaption`
                  are still exported and still unit-tested. Only the CAPTURE
                  SCREEN loses them. */}
              {!previewLoadFailed && previewStale != null && (
                <View
                  style={[styles.previewNoticeInner, styles.previewNoticeBottom]}
                  testID="panoplus-preview-stale-inner">
                  <Text
                    style={styles.previewErrorText}
                    testID="panoplus-preview-stale">
                    {previewStale}
                  </Text>
                </View>
              )}
              {previewLoadFailed && (
                <View
                  style={[styles.previewNoticeInner, styles.previewNoticeBottom]}
                  testID="panoplus-preview-error-inner">
                  <Text
                    style={styles.previewErrorText}
                    testID="panoplus-preview-error">
                    {'The engine is writing previews but this screen cannot read '
                      + 'them. The sweep is unaffected — report this.'}
                  </Text>
                </View>
              )}
            </>
          ) : (
            /* THE NOTICE IS CHROME, AND CHROME DOES NOT TURN (2026-09-03).
               For four days this box carried the chrome rotation so it read
               upright in the operator's sideways hold (the 2026-08-29 RCA's
               break 2). Pano's words on the same screen — its REC banner
               aside, which is a library overlay — are laid out in the
               portrait framebuffer and read sideways in that hold, and the
               owner's requirement is that pano+ looks EXACTLY like Pano. So
               this fills the frame and turns with nothing. */
            <View
              style={styles.previewNoticeInner}
              testID="panoplus-preview-placeholder-inner">
              <Text
                style={styles.previewPlaceholderText}
                testID="panoplus-preview-placeholder">
                {previewPlaceholder}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Governor + HUD. One guidance line, one engine line, one drops line —
          three different questions, never merged. */}
      {/* ⚠ `box-none`, NOT `none` — 2026-09-02, and it is a BUG FIX rather than
          a preference. `pointerEvents="none"` makes the view AND EVERY
          DESCENDANT untouchable, and the arm-notice expander is a descendant
          (as the lens chip was, until it moved to Pano's bottom bar on
          2026-09-03): the `panoplus-lens-chip` Pressable added in P5b was
          never tappable on either platform for exactly this reason. Verified
          on the Galaxy A35 — tapping its centre (300,694) left the lens on
          `0.5×`, while the host's own pill flipped it to `1×` from the same
          finger. uiautomator reports the chip `clickable=true` throughout,
          because `pointerEvents` is a touch-dispatch flag and not an
          accessibility one, so the accessibility tree cannot see this class
          of defect at all.

          `box-none` means THIS view is never a touch target and its touchable
          children are — so nothing that was passing through starts being
          swallowed. Every read-only run below is additionally wrapped in its
          own `pointerEvents="none"` box: a bare `<Text>` under `box-none`
          WOULD become the deepest target under the finger (RN picks the
          deepest view and then looks for a JS responder; finding none, the
          touch dies there rather than falling through to a sibling). The
          wrappers make "the only touch target in here is the expander" a
          structural fact instead of a claim about text layout.

          THE HUD IS NOT TURNED (2026-09-03). It carried the chrome rotation
          so it read upright in a sideways hold; Pano's chrome does not turn,
          and pano+ is to look exactly like Pano. */}
      <View
        style={[styles.hud, previewLayout.hud]}
        pointerEvents="box-none"
        testID="panoplus-hud-block">
        {/* ── READ-ONLY RUN 1 ────────────────────────────────────────────
            Wrapped, and `none` rather than `box-none`, so this whole block
            is provably incapable of taking a touch. Layout is unchanged: a
            styleless View in a column is transparent to flex, and each
            child keeps its own `marginTop`. */}
        <View pointerEvents="none">
        {/* ⚠ GATED ON A NON-EMPTY HEADLINE SINCE 2026-09-07. The pre-sweep
            coaching paragraph left `panoPlusGuidance`'s idle branch that day
            ("Why is the text on the screen needed - regarding the panning?
            pano works the same way already right?"), and that branch now
            returns empty strings. Rendering an empty <Text> anyway would keep
            a line box in the column and push everything under it down by one
            line height for a string nobody can see — so the NODE goes with the
            text. Every other phase is unchanged: 'Metering — hold still',
            'Keep panning', 'Break in the panorama' all still have a headline
            and all still draw one. */}
        {guidance.headline !== '' && (
          <Text
            style={[
              styles.guidanceHeadline,
              guidance.tone === 'warn' && styles.toneWarn,
              guidance.tone === 'stop' && styles.toneStop,
            ]}
            testID="panoplus-guidance">
            {guidance.headline}
          </Text>
        )}
        {/* ── EVERYTHING BELOW THE HEADLINE IS IDLE-ONLY (2026-09-03) ──────
            "There is still some text shown in the pano+ screen - no point of
            it!" — the operator, on a healthy sweep, which painted FIVE
            simultaneous runs over the viewfinder: the headline, the guidance
            paragraph, the engine readout (`band 12% · WARP 5.1× · 8.4ms`),
            the drops line and the τ chip.

            The rule now: WHILE SWEEPING the HUD carries the headline and
            hard faults, and nothing else. Pano shows one status line over a
            pan; so does this.

            AT IDLE the same lines are kept, because that is when they are
            read and acted on — the detail is the pre-capture instruction, the
            lock warning tells him the exposure did not lock BEFORE he starts,
            and the engine/drops lines are the bench read. Nothing is deleted,
            only scoped to the phase where it is useful.

            AND NONE OF IT IS LOST FROM THE PACK. Every number behind `hud`
            and `drops` is already in native's `meta.json`, and the rendered
            SENTENCES are written verbatim at stop — see
            `PANO_PLUS_SWEEP_NOTICE_FILE` in `finish`. */}
        {/* ⚠ THE DETAIL IS SCOPED BY TONE, NOT BY PHASE, and the difference is
            the whole care in this change. On a healthy pan the detail reads
            `Painted 1832 px of canvas.` — a number nobody acts on, printed
            over the shelf, which is precisely the text being complained
            about. On a DEGRADED one it reads "412 px of drift left before the
            panorama starts losing height — recentre the shelf and keep the
            phone level", which is the only instruction on the screen that can
            still save the sweep.

            Gating on the phase alone would have deleted the second with the
            first. It would also have silently dropped the "Also: the canvas is
            at 2048/2048 px across" rung — the demoted ceiling warning that
            appears only when a REALISED hole has taken the headline, i.e.
            exactly when two things are wrong at once. */}
        {guidance.detail !== '' && (!sweeping || guidance.tone !== 'ok') && (
          <Text style={styles.guidanceDetail} testID="panoplus-guidance-detail">
            {guidance.detail}
          </Text>
        )}
        {/* ⚠️ THE HARD-FAULT HALF OF THE IDLE-ONLY RULE. The comment above says
            "WHILE SWEEPING the HUD carries the headline AND HARD FAULTS"; the
            code shipped only the first clause, and `{!sweeping && hud}` took
            the faults down with the chrome. That silenced the v5 CUTS warning,
            the v6/v8 BAND verdict, the drops line and the shear rung — each of
            which exists because of a field incident, and each of which is only
            actionable DURING the sweep it was meant to save.

            `panoPlusSweepFaults` is bars-only and returns null on a healthy
            pass, so this restores the faults without restoring the clutter the
            operator objected to. The full readout stays idle-only below.

            ⚠️ DROPS ARE DELIBERATELY NOT HERE. "moves drops off the live
            screen and INTO the pack — never silence" is an existing, tested
            decision with its own rationale: a drop is not something a gesture
            can fix mid-sweep, and the count rides the pack. The first cut of
            this fix restored the drops line too and that test caught it. A
            hard fault is a bar the operator can still act on; a drop is not. */}
        {sweeping && sweepFaults != null && (
          <Text style={styles.hudText} testID="panoplus-sweep-faults">
            {sweepFaults}
          </Text>
        )}
        {!sweeping && (
          <Text style={styles.hudText} testID="panoplus-hud">
            {hud}
          </Text>
        )}
        {!sweeping && drops != null && (
          <Text style={styles.hudDrops} testID="panoplus-drops">
            {drops}
          </Text>
        )}
        {!sweeping && lockWarning != null && (
          <Text style={styles.hudDrops} testID="panoplus-camera-lock">
            {lockWarning}
          </Text>
        )}
        {/* THE HEADLESS SWEEP, NAMED. A Camera2 session whose preview
            Surface arrived after `createCaptureSession` records perfectly
            and shows nothing; without this the operator cannot tell that
            from a camera failure, and the two have opposite responses —
            keep sweeping, or stop and restart. */}
        {viewfinderNotice != null && (
          <Text style={styles.hudDrops} testID="panoplus-viewfinder-note">
            {viewfinderNotice}
          </Text>
        )}
        {/* THE VIEWFINDER THAT IS UP AND DOES NOT MATCH. Sibling of the line
            above and deliberately in the same amber: both are "the picture is
            not the fact you think it is", and amber is this screen's
            degraded-but-working colour — the feed works, the framing rate does
            not, and the sweep is not refused over it. Native computed this
            since 2026-09-07 and nothing could print it: the knob was never
            sent and the coercion dropped the answer. */}
        {previewPinNotice != null && (
          <Text style={styles.hudDrops} testID="panoplus-preview-pin">
            {previewPinNotice}
          </Text>
        )}
        {/* THE SELECTED ARM AND ITS PRECONDITION.

            Rendered ONLY while idle: once a sweep is live the arm is latched
            and a banner about what it "would" run is noise over a pan. And
            rendered only on the IMU arm — `armNotice.headline` is the empty
            string on the ARKit default, which is what keeps the shipped
            surface pixel-identical. */}
        {/* ── THE EXPERIMENT CHIP, ON FOR THE WHOLE SWEEP ──────────
            The arm banner below is idle-ONLY (a banner about what a sweep
            "would" run is noise over a live pan), which is right for a
            precondition and wrong for this: an uncorrected sweep must be
            visibly an experiment while it is HAPPENING, not only before it
            starts. The one failure that leaves no trace in the pixels is a
            pack believed to be calibrated that was not, and the operator's
            memory of which button he pressed four minutes ago is not
            evidence. Driven by `runningUncorrected`, which is the arm that
            will ACTUALLY run — an ARKit fallback shows nothing. */}
        {/* ⚠ THE SAME FACT, TWO DIFFERENT THINGS TO SAY ABOUT IT. On iOS an
            uncorrected sweep is a DECLARED EXPERIMENT against a calibrated
            alternative, and the chip's job is to stop it being mistaken for
            that alternative four minutes in. On Android there is no
            alternative — no τ stage exists, because the clocks are directly
            comparable — so calling it an experiment would invent a control
            arm the platform does not have, and would read as "something
            unusual is happening" on every single sweep until it stopped being
            read at all. What is true on both is the τ and the missing ~97 ms
            of pipeline latency, so that is what each says. */}
        {/* ⚠ THE SENTENCE IS IDLE-ONLY SINCE 2026-09-03; THE CHIP IS NOT.
            The complaint being answered is about PROSE over a live pan, and
            this was the longest run of it — 55 characters across the
            viewfinder for the whole sweep, on a phone whose basis is
            currently cleared, so it fired on every single one. But deleting it
            outright would give back the failure it exists to prevent: a pack
            believed calibrated that was not.

            So the FACT stays on screen for the whole sweep and only the
            EXPLANATION is scoped to idle. `⚗︎ τ=0` is unmistakable, is in the
            same loud non-palette colour, and is four characters. */}
        {/* ⚠ THE iOS IDLE SENTENCE WENT ON 2026-09-07; THE CHIP DID NOT.
            The operator: "what do you mean by tau=0 experiment? Why should
            the user know this and what do they have to do about it?" Nothing —
            on iOS the experiment is a declaration he made himself in the gear,
            so the EXPLANATION was telling him something he already decided,
            in the loudest colour on the screen. `⚗︎ τ=0` is the FACT and it
            still rides every phase, for the same reason it was extended to
            the whole sweep in the first place: a pack believed calibrated
            that was not is the one failure that leaves no trace in the pixels.
            The sentence itself is in `host_notice.json`, written whole.

            ANDROID IS UNTOUCHED, and deliberately: there is no calibrated
            alternative on that platform, nothing the operator declared, and
            the line answers "why does this pack have no τ" rather than
            restating a choice. Removing it would be a different decision from
            the one that was approved. */}
        {runningUncorrected && (
          <Text style={styles.experimentChip} testID="panoplus-tau-uncorrected">
            {!sweeping && armContract === 'android-sensor'
              ? '⚗︎ τ=0 — NO CAMERA↔IMU TIMING CORRECTION ON THIS PLATFORM'
              : '⚗︎ τ=0'}
          </Text>
        )}
        </View>
        {/* The lens chip and its Android "readout" that lived here until
            2026-09-03 moved to Pano's bottom bar as Pano's own switcher — see
            `lensChipVisible` and the bottom of this render. */}
        {/* ── THE ARM NOTICE — HEADLINE ALWAYS, DETAIL ON A TAP ──────────
            2026-09-02. The headline is the summary and it never moves: it
            names the arm and what is wrong with it in one line, which is
            the whole of what has to be legible with the phone up at a
            shelf. The detail — the paragraph explaining SENSOR_ORIENTATION,
            τ, the ~97 ms pipeline latency — is a bench read, and on the A35
            it was 685 px of it printed over the live camera and over the
            host's own banner.

            Measured before the change, IMU arm, Galaxy A35: the HUD's text
            ran y=169..1539 of a 2,340 px screen. After: y=169..~800.

            THE DETAIL IS NOT LOST IN EITHER DIRECTION. One tap opens it,
            and `panoPlusNoticeSidecar` writes it into the pack in full on
            every sweep whether it was opened or not — with `shownExpanded`
            recording which. */}
        {/* ⚠ `packOnly` IS THE FOURTH CONDITION, ADDED 2026-09-07. It is true
            on exactly one branch — the τ = 0 EXPERIMENT — and the reason it is
            a field on the notice rather than a deletion is that the sentence
            is still written to `host_notice.json` in full on every sweep. The
            SCREEN loses it; the PACK keeps it, which is how an uncorrected
            pack is told apart from a calibrated one later.

            THE WHOLE CARD IS ONE CONDITIONAL, so nothing is left floating: the
            headline, the `tap for why` handle and the detail live and die
            together, and a suppressed notice renders no box, no padding and no
            touch target. Every REAL refusal — a missing pod, no ultra-wide, no
            60 fps format, a missing basis, an uncalibrated phone — has
            `packOnly` unset and still draws exactly as it did. */}
        {phase === 'idle' && armNotice.headline !== '' && !armNotice.packOnly && (
          <Pressable
            onPress={() => setArmDetailOpen((open) => !open)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: armDetailOpen }}
            accessibilityLabel={
              armDetailOpen
                ? `${armNotice.headline}. ${armNotice.detail} `
                  + 'Tap to hide this explanation.'
                : `${armNotice.headline}. Tap to read why.`
            }
            testID="panoplus-arm-notice">
            <Text
              style={[
                styles.armHeadline,
                // `warn` is the τ = 0 EXPERIMENT: it CAN start, so it is not
                // the red of a refusal, and it must not be the ordinary blue
                // of a calibrated arm either.
                armNotice.tone === 'warn' && styles.toneWarn,
                armNotice.tone === 'stop' && styles.toneStop,
              ]}
              testID="panoplus-arm-headline">
              {armNotice.headline}
            </Text>
            {/* THE AFFORDANCE SAYS WHERE THE TEXT WENT. A collapsed
                diagnostic with no visible handle is indistinguishable from
                one that was deleted, and the second reading is the one that
                gets a working feature reported as a regression. */}
            <Text style={styles.armMore} testID="panoplus-arm-more">
              {armDetailOpen
                ? '▾ tap to hide'
                : '▸ tap for why · full text is in the pack'}
            </Text>
            {armDetailOpen && (
              <Text style={styles.armDetail} testID="panoplus-arm-detail">
                {armNotice.detail}
              </Text>
            )}
          </Pressable>
        )}
        {/* ── READ-ONLY RUN 2 ────────────────────────────────────────────
            Same reason as run 1: nothing below here is interactive, so it
            is fenced off from touch explicitly rather than by inspection. */}
        <View pointerEvents="none">
        {/* THE WRITE/READ DISAGREEMENT. Not an error the operator caused and
            not something he can fix at the shelf — but the τ half of this
            same store shipped exactly this bug once, and it was only visible
            because a panel said two contradictory things one line apart. */}
        {basisWriteDisagreement != null && (
          <Text
            style={styles.hudError}
            testID="panoplus-basis-write-disagreement">
            {basisWriteDisagreement}
          </Text>
        )}
        {error != null && (
          <Text style={styles.hudError} testID="panoplus-error">
            {error}
          </Text>
        )}
        </View>
      </View>
    </>
  );
}
