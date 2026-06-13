// SPDX-License-Identifier: Apache-2.0
/**
 * LateralMotionModal — informational popup shown when the SDK stops an
 * in-progress capture because the user panned sideways (cross-axis /
 * lateral drift) instead of holding the single sweep direction
 * (Mode A: top→bottom; Mode B: left→right).
 *
 * ## When this modal appears
 *
 * This is the item-6 sibling of `OrientationDriftModal` — the "you
 * moved sideways" variant.  By the time the modal renders, the capture
 * has ALREADY been finalized by the parent `<Camera>` (the lateral-stop
 * effect calls the engine's `stop()` and keeps whatever was captured up
 * to that point — there is no malformed-output risk, so the copy says
 * "we stitched what you captured").  The modal exists solely to explain
 * to the user what happened and how to avoid it next time; the single
 * dismiss button just clears the latched lateral-stop state so the next
 * capture can start fresh.
 *
 * ## Layer-2 host usage
 *
 * Hosts using `CameraView` directly (rather than the flagship
 * `<Camera>`) can compose this modal with their own lateral-drift
 * detector for the same finalize-and-explain UX:
 *
 *   const lateral = useLateralDrift(captureActive);
 *   useEffect(() => {
 *     if (lateral.stopped) {
 *       // host finalizes capture (engine stop + keep captured output)
 *       finalizeCapture();
 *     }
 *   }, [lateral.stopped]);
 *
 *   return <>
 *     <CameraView ... />
 *     <LateralMotionModal
 *       visible={lateral.stopped}
 *       onDismiss={dismissLateralModal}
 *     />
 *   </>;
 *
 * ## Copy
 *
 * `title` / `body` / `dismissLabel` default to the centralised
 * `DEFAULT_GUIDANCE_COPY.lateralStop*` strings so hosts can localise or
 * re-word every guidance message in one place via the `guidanceCopy`
 * `<Camera>` prop; pass explicit props to override per-instance.
 *
 * ## Accessibility
 *
 * Modal `role` defaults to RN's native dialog handling.  The dismiss
 * button carries an `accessibilityRole='button'` + label.  Body text
 * uses `accessibilityRole='text'` so the guidance is read by VoiceOver
 * / TalkBack.
 */

import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { DEFAULT_GUIDANCE_COPY } from './cameraGuidanceCopy';


export interface LateralMotionModalProps {
  /**
   * Show / hide.  In the `<Camera>` integration this is driven by the
   * latched lateral-stop flag (capture already finalized when true).
   */
  visible: boolean;

  /**
   * Popup title.  Defaults to
   * `DEFAULT_GUIDANCE_COPY.lateralStopTitle`.
   */
  title?: string;

  /**
   * Popup body / guidance copy.  Defaults to
   * `DEFAULT_GUIDANCE_COPY.lateralStopBody`.
   */
  body?: string;

  /**
   * Dismiss button label.  Defaults to
   * `DEFAULT_GUIDANCE_COPY.lateralStopDismiss`.
   */
  dismissLabel?: string;

  /**
   * Tapped when the user dismisses.  By the time the modal renders the
   * capture is already finalized; this callback exists only to clear
   * the latched lateral-stop state so the next capture can start fresh.
   */
  onDismiss: () => void;
}


export function LateralMotionModal(
  props: LateralMotionModalProps,
): React.JSX.Element {
  const {
    visible,
    title = DEFAULT_GUIDANCE_COPY.lateralStopTitle,
    body = DEFAULT_GUIDANCE_COPY.lateralStopBody,
    dismissLabel = DEFAULT_GUIDANCE_COPY.lateralStopDismiss,
    onDismiss,
  } = props;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      accessibilityLabel="Capture finalized — moved sideways"
      // v0.12.0 — see OrientationDriftModal / PanoramaSettingsModal for
      // the same prop's rationale.  Declaring all orientations prevents
      // iOS from force-rotating the window to portrait when this modal
      // opens mid-rotation, which would otherwise leave the underlying
      // <Camera>'s ARSession in a stale-orientation state on dismiss.
      supportedOrientations={[
        'portrait',
        'portrait-upside-down',
        'landscape-left',
        'landscape-right',
      ]}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>

          <Text style={styles.body} accessibilityRole="text">
            {body}
          </Text>

          <Pressable
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
            ]}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel={dismissLabel}
          >
            <Text style={styles.buttonLabel}>{dismissLabel}</Text>
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
