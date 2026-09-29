// SPDX-License-Identifier: Apache-2.0
/**
 * SweepHatchScreen — what is left of the sweep's own screen, for the DR-1a
 * reference hatch ONLY. INTERNAL: not exported from the package.
 *
 * M10 deleted the sweep's second screen: the `PanoPlusCaptureSurface`
 * composite, its clone chrome (AR pill, lens chip, built-in shutter), the
 * first-run basis card, and its prompts. A sweep runs inside `<Camera>`, on
 * `<Camera>`'s own camera, shutter and chrome, and draws only its hold overlay
 * (`SweepHoldOverlay`).
 *
 * The one exception is `sweep.frameSourceOverride: 'own'` — a DEVICE-ROUND
 * switch that hands a non-AR sweep pano+'s OLD own camera so DR-1a can take
 * same-scene reference captures from the arm the vision-camera arm replaced.
 * That camera draws its own viewfinder, so the hatch needs a view that mounts
 * it. This is that view, and nothing more:
 *
 *   · the own arm's idle/sweep viewfinder (iOS AVF), or the explainer when
 *     there is nothing live to look at;
 *   · `<ARCameraView>` for the own IMU arm's ARKit FALLBACK on a phone with no
 *     stored basis (the arm ladder resolves such an arm to ARKit, and the
 *     fallback needs an AR session to read);
 *   · the hold overlay.
 *
 * Everything else on the hatch — the shutter, the AR pill, the lens chip,
 * the status banner, the review — is `<Camera>`'s. Deleted with the own arms
 * (M6a/M6b).
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ARCameraView } from '../camera/ARCameraView';
import type { SweepEngine } from './useSweepEngine';
import type { SweepEngineProps } from './sweepEngineProps';
import { SweepHoldOverlay } from './SweepHoldOverlay';
import { sweepSurfaceStyles as styles } from './sweepSurfaceStyles';

/** How often the AR metadata (and with it the sweep's status) reaches JS on
 *  the fallback AR view — 10 Hz, the same as `<Camera>`'s own AR view. */
const AR_META_INTERVAL_MS = 100;

export function SweepHatchScreen({
  surfaceProps: props,
  engine,
}: {
  surfaceProps: SweepEngineProps;
  engine: SweepEngine;
}): React.JSX.Element {
  const {
    frameSource = 'own',
    arSourceMaxLongEdge,
  } = props;
  const {
    AvfViewfinder,
    arArmed,
    arMayOpen,
    arReady,
    armContract,
    armDetailOpen,
    armNotice,
    cameraOffNotice,
    drops,
    error,
    guidance,
    handleArFrame,
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
    setSurfaceBox,
    sweepFaults,
    sweeping,
    viewfinderNotice,
  } = engine;

  return (
    <View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSurfaceBox((prev) => (
          prev != null && prev.width === width && prev.height === height
            ? prev
            : { width, height }
        ));
      }}
      // ALWAYS OPAQUE. This view is the only thing on screen whenever it is
      // mounted: `<Camera>` draws it only on the hatch, where its own preview
      // is never in the tree (`hostPreviewMounted` requires
      // `!sweepLegacyTree`), so there is nothing behind it to show through.
      // The transparent root for "the host is drawing behind us" was deleted
      // in the M10 review: `<Camera>` never sent the hatch that state
      // (`hostPreviewLive` is false there on every render), and the host
      // arm's hold overlay is drawn in `<Camera>`'s own tree, not here.
      style={styles.fill}>
      {/* Mounting this view IS what starts ARKit (didMoveToWindow →
          RNSARSession.shared.start()). `planeDetection="vertical"` costs
          nothing here — pano+ never reads a plane — but it keeps ARKit's
          tracker fed with the same structure the other shelf surfaces use, and
          a shared configuration is one less way for two surfaces to behave
          differently on the same rack. */}
      {arReady && arMayOpen && (
        <ARCameraView
          style={StyleSheet.absoluteFill}
          planeDetection="vertical"
          arFrameMetaInterval={AR_META_INTERVAL_MS}
          // ⚠ WITHOUT THIS THE AR ARM SWEEPS AT VGA. Measured on the operator's
          // first working Android AR captures: the frames reaching the engine
          // were 640x480 while the non-AR arm's were 1440x1080 — a FIVE-FOLD
          // area difference — and his verdict was "the output quality is
          // decisively worse than non-AR. WHY??"
          //
          // ARCore's default pairing on this exact handset is called out in the
          // library's own source: "ARCore's default often pairs a 16:9 GPU
          // texture with a 4:3 CPU image (e.g. 1920x1080 texture + 640x480
          // image on the Galaxy A35)". `selectMatchingCameraConfig` exists to
          // pick a matched-aspect config at the highest image resolution, and it
          // is gated on a REFCOUNT that only this prop raises — the same source
          // logs `kfQuality=true chose 1920x1080`. Another engine sets it; the
          // sweep never
          // did, so pano+ got ARCore's default.
          //
          // It also explains the second symptom without a separate cause: at a
          // 2.25x smaller raster the per-frame advance measured 0.13 px against
          // the non-AR arm's 0.40, so the phase correlation was resolving a
          // smaller displacement against the same noise floor.
          keyframeQualityCapture
          keyframeQualitySourceMaxLongEdge={arSourceMaxLongEdge}
          onArFrame={handleArFrame}
        />
      )}
      {/* v12 — THE DECOUPLED ARM'S VIEWFINDER. The arm's own capture session
          drawn straight to a layer: live during the sweep (it IS the sweep's
          session) and, via the engine's idle-preview effect, live before it too
          — the operator could not FRAME the first shot on this arm, and the
          first frame anchors the whole canvas. Null on builds without the
          native view (and under Jest), where the explainer below keeps doing
          the honest fallback job. */}
      {frameSource === 'own' && !arArmed && AvfViewfinder != null && (
        <AvfViewfinder
          style={StyleSheet.absoluteFill}
          testID="panoplus-avf-viewfinder"
        />
      )}
      {/* The explainer earns its place exactly when there is NOTHING live to
          look at: the AR arm warming up, or an IMU arm on a native build
          without the v12 viewfinder. A live feed explains itself, and a
          permanent centred caption over it would be clutter. */}
      {cameraOffNotice != null && (
        <View style={styles.cameraOff} pointerEvents="none">
          <Text style={styles.cameraOffText} testID="panoplus-camera-off">
            {cameraOffNotice}
          </Text>
        </View>
      )}

      <SweepHoldOverlay
        armContract={armContract}
        armDetailOpen={armDetailOpen}
        armNotice={armNotice}
        drops={drops}
        error={error}
        guidance={guidance}
        hud={hud}
        lockWarning={lockWarning}
        onPreviewSlotLoad={onPreviewSlotLoad}
        phase={phase}
        preview={preview}
        previewLayout={previewLayout}
        previewLoadFailed={previewLoadFailed}
        previewPinNotice={previewPinNotice}
        previewPlaceholder={previewPlaceholder}
        previewSlots={previewSlots}
        previewStale={previewStale}
        runningUncorrected={runningUncorrected}
        setArmDetailOpen={setArmDetailOpen}
        setPreviewLoadFailed={setPreviewLoadFailed}
        sweepFaults={sweepFaults}
        sweeping={sweeping}
        viewfinderNotice={viewfinderNotice}
      />
    </View>
  );
}
