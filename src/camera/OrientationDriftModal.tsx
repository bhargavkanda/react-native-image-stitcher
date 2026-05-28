// SPDX-License-Identifier: Apache-2.0
/**
 * OrientationDriftModal — informational popup shown when the SDK
 * auto-abandons an in-progress capture because the device rotated
 * between Mode A (landscape + vertical pan) and Mode B (portrait
 * + horizontal pan) mid-flight.
 *
 * ## When this modal appears
 *
 * In the v0.12 `<Camera>` integration, the modal is rendered while
 * `useOrientationDrift(active).drifted === true`.  By the time the
 * modal renders, the capture has ALREADY been stopped (the
 * `<Camera>` component's drift effect calls the engine's `stop()`
 * the same render).  The modal exists solely to explain to the
 * user what happened — no "Continue" / "Resume" affordance because
 * the engine docstring at `incremental.ts:373-403` is explicit
 * that cross-mode capture is "best-effort, not supported" and
 * continuing past drift produces malformed output.
 *
 * ## Layer-2 host usage
 *
 * Hosts using `CameraView` directly (rather than the flagship
 * `<Camera>`) can compose this modal with `useOrientationDrift`
 * for the same auto-abandon UX:
 *
 *   const drift = useOrientationDrift(captureActive);
 *   useEffect(() => {
 *     if (drift.drifted) {
 *       // host abandons capture (engine stop + state cleanup)
 *       stopCapture();
 *     }
 *   }, [drift.drifted]);
 *
 *   return <>
 *     <CameraView ... />
 *     <OrientationDriftModal
 *       visible={drift.drifted}
 *       captureOrientation={drift.captureOrientation}
 *       currentOrientation={drift.currentOrientation}
 *       onAcknowledge={dismissDriftModal}
 *     />
 *   </>;
 *
 * ## Accessibility
 *
 * Modal `role` defaults to RN's native dialog handling.  The OK
 * button carries an `accessibilityRole='button'` + label.  Body
 * text uses `accessibilityRole='text'` so the orientation summary
 * is read by VoiceOver / TalkBack.
 */

import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { type DeviceOrientation } from './useDeviceOrientation';


export interface OrientationDriftModalProps {
  /**
   * Show / hide.  In the `<Camera>` integration this is driven by
   * the latched `drifted` flag from `useOrientationDrift`.
   */
  visible: boolean;

  /**
   * Orientation the capture started in.  Shown in the body copy
   * ("Capture started in PORTRAIT") so the user understands the
   * baseline.  `undefined` is tolerated (the modal hides the line);
   * the prop is optional only to mirror `useOrientationDrift`'s
   * return shape (which has `undefined` when inactive).  When the
   * modal is `visible`, drift detection means this was non-
   * undefined at the moment the flag latched — so undefined here
   * is unlikely in practice.
   */
  captureOrientation: DeviceOrientation | undefined;

  /**
   * Current device orientation.  Shown in the body copy ("now
   * LANDSCAPE-LEFT") so the user understands what changed.
   */
  currentOrientation: DeviceOrientation;

  /**
   * Tapped when the user dismisses with OK.  By the time the
   * modal renders the capture is already stopped; this callback
   * exists only to clear the latched drift state so the next
   * capture can start fresh.
   */
  onAcknowledge: () => void;
}


/**
 * Pretty-print a `DeviceOrientation` for body copy.  Returns the
 * uppercase form because the modal copy reads as "Capture started
 * in PORTRAIT, now LANDSCAPE-LEFT" — uppercase orientations stand
 * out from the surrounding lowercase sentence.
 */
function formatOrientation(o: DeviceOrientation): string {
  switch (o) {
    case 'portrait':
      return 'PORTRAIT';
    case 'portrait-upside-down':
      return 'PORTRAIT-UPSIDE-DOWN';
    case 'landscape-left':
      return 'LANDSCAPE-LEFT';
    case 'landscape-right':
      return 'LANDSCAPE-RIGHT';
  }
}


export function OrientationDriftModal(
  props: OrientationDriftModalProps,
): React.JSX.Element {
  const { visible, captureOrientation, currentOrientation, onAcknowledge } = props;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onAcknowledge}
      accessibilityLabel="Capture cancelled — orientation drift"
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Capture cancelled
          </Text>

          <Text style={styles.body} accessibilityRole="text">
            Rotation detected mid-capture. Please hold the device
            steady and try again.
          </Text>

          {captureOrientation !== undefined && (
            <Text style={styles.subBody} accessibilityRole="text">
              Capture started in {formatOrientation(captureOrientation)},
              now {formatOrientation(currentOrientation)}.
            </Text>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
            ]}
            onPress={onAcknowledge}
            accessibilityRole="button"
            accessibilityLabel="OK"
          >
            <Text style={styles.buttonLabel}>OK</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 24,
    width: '100%',
    maxWidth: 340,
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    color: '#e5e5ea',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 12,
  },
  subBody: {
    color: '#8e8e93',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#0a84ff',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonPressed: {
    backgroundColor: '#0860c0',
  },
  buttonLabel: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
});
