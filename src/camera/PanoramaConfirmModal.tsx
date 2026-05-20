// SPDX-License-Identifier: Apache-2.0
/**
 * PanoramaConfirmModal — post-stitch review screen.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                                                          │
 *   │            ┌──────────────────────────────┐              │
 *   │            │     stitched panorama        │              │
 *   │            │     (resizeMode=contain)     │              │
 *   │            └──────────────────────────────┘              │
 *   │                                                          │
 *   │      [✕ Discard]    [↺ Retry]    [✓ Save]               │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Why this exists
 *   Without it, a panorama lands directly into the audit's
 *   thumbnail strip — operator only finds out it's bad once they
 *   tap the thumbnail, or worse, never.  The confirm step is the
 *   safety net iOS' native panorama UX gives by default.
 *
 * Three actions, three callbacks
 *   - Save:    host persists the panorama (writes Capture row, etc).
 *   - Retry:   host throws away the panorama and re-enters the
 *              capture flow.  Good UX is to keep the camera
 *              ready so the operator can immediately re-pan.
 *   - Discard: host throws away the panorama and returns to the
 *              capture flow without re-entering.  Same as Retry
 *              minus the "ready to record" hint.
 *
 * The modal is purely presentational — it doesn't know about
 * WatermelonDB, file paths, or any host-domain concept beyond the
 * panorama URI + dimensions to display.
 */

import React from 'react';
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';


export interface PanoramaConfirmModalProps {
  /**
   * Modal visibility.  When true, the modal animates in over the
   * current screen.  Drive this from the host's "stitch result is
   * pending review" state.
   */
  visible: boolean;
  /** file:// URI of the stitched panorama to preview. */
  panoramaUri: string;
  /** Pixel width of the panorama (for the preview's aspect ratio). */
  width: number;
  /** Pixel height of the panorama. */
  height: number;
  /** User confirmed — host should persist the panorama. */
  onSave: () => void;
  /** User wants to re-record — host should drop and reopen camera. */
  onRetry: () => void;
  /** User wants to discard without re-recording. */
  onDiscard: () => void;
  /** Optional override for the title (defaults to "Review panorama"). */
  title?: string;
}


export function PanoramaConfirmModal({
  visible,
  panoramaUri,
  width,
  height,
  onSave,
  onRetry,
  onDiscard,
  title = 'Review panorama',
}: PanoramaConfirmModalProps): React.JSX.Element {
  // The aspect-ratio-locked image lets `<Image>` size itself
  // correctly inside a flexible container without us having to
  // measure the modal's available area on every layout change.
  const aspectRatio = width > 0 && height > 0 ? width / height : 16 / 9;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={onDiscard}
    >
      <View style={styles.backdrop}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>

        <View style={styles.imageWrapper}>
          <Image
            source={{ uri: panoramaUri }}
            style={[styles.image, { aspectRatio }]}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            onPress={onDiscard}
            style={[styles.button, styles.buttonGhost]}
            accessibilityRole="button"
            accessibilityLabel="Discard panorama"
          >
            <Text style={styles.buttonGhostText}>✕  Discard</Text>
          </Pressable>
          <Pressable
            onPress={onRetry}
            style={[styles.button, styles.buttonNeutral]}
            accessibilityRole="button"
            accessibilityLabel="Retry panorama"
          >
            <Text style={styles.buttonNeutralText}>↺  Retry</Text>
          </Pressable>
          <Pressable
            onPress={onSave}
            style={[styles.button, styles.buttonPrimary]}
            accessibilityRole="button"
            accessibilityLabel="Save panorama"
          >
            <Text style={styles.buttonPrimaryText}>✓  Save</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
    paddingTop: 64,
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  title: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 12,
  },
  imageWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    maxHeight: '100%',
    backgroundColor: '#111',
    borderRadius: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  buttonGhostText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
    opacity: 0.9,
  },
  buttonNeutral: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  buttonNeutralText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonPrimary: {
    backgroundColor: '#34C759',
  },
  buttonPrimaryText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
});
