// SPDX-License-Identifier: Apache-2.0
/**
 * CapturePreview — shared full-screen image preview used for BOTH:
 *   1. Tap-to-preview from <CaptureThumbnailStrip> (existing thumbnails)
 *   2. Post-stitch confirmation (newly produced panorama)
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                                              [✕ close]   │
 *   │            ┌──────────────────────────────┐              │
 *   │            │     image (resizeMode=        │              │
 *   │            │              contain)         │              │
 *   │            └──────────────────────────────┘              │
 *   │                                                          │
 *   │      [action 1]   [action 2]   [action 3]                │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Actions are passed in by the host so a single component can
 * render the right buttons for each context:
 *   - Thumbnail tap, unsubmitted capture → [Delete] [Recapture]
 *   - Thumbnail tap, already-synced capture → [] (just close)
 *   - Post-stitch → [Discard] [Retry] [Save]
 *
 * The component is presentational — it does not know about audit
 * state, sync state, or any host-domain concept beyond the URI +
 * dimensions to display and the action callbacks to fire.
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

import { DISPLAY_DECODE_IMAGE_PROPS } from './displayDecodeImageProps';


export type CapturePreviewActionVariant =
  | 'primary'
  | 'neutral'
  | 'ghost'
  | 'destructive';


export interface CapturePreviewAction {
  /** Button label (visible text). */
  label: string;
  /** Optional leading glyph — usually a unicode arrow / check / cross. */
  icon?: string;
  /** Visual variant.  Defaults to "neutral". */
  variant?: CapturePreviewActionVariant;
  /** Disabled state — useful while an async action is in flight. */
  disabled?: boolean;
  /**
   * Called when the user presses the button.  Caller decides
   * whether the preview should close after — call `onClose` from
   * inside if that's the desired behaviour.
   */
  onPress: () => void;
}


export interface CapturePreviewProps {
  /** Whether the modal is shown.  Drive from host state. */
  visible: boolean;
  /** file:// or http(s) URI to display. */
  imageUri: string;
  /** Image width in px (for aspect-ratio rendering). */
  imageWidth?: number;
  /** Image height in px. */
  imageHeight?: number;
  /**
   * Action buttons rendered along the bottom.  Empty array (or
   * undefined) renders no buttons — only the close affordance is
   * available.  Up to 3 actions display cleanly across most
   * widths; more wraps on a typical phone.
   */
  actions?: CapturePreviewAction[];
  /**
   * Called when the user dismisses the preview without choosing an
   * action — tap on the close button, tap on the backdrop outside
   * the image, or hardware back on Android.
   */
  onClose: () => void;
  /** Optional title shown at the top of the modal. */
  title?: string;
}


export function CapturePreview({
  visible,
  imageUri,
  imageWidth,
  imageHeight,
  actions,
  onClose,
  title,
}: CapturePreviewProps): React.JSX.Element {
  const aspectRatio =
    imageWidth && imageHeight && imageWidth > 0 && imageHeight > 0
      ? imageWidth / imageHeight
      : 16 / 9;
  const hasActions = actions && actions.length > 0;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      // v0.13.1 — RN's iOS <Modal> defaults to portrait-only, which
      // pins the stitched-image preview to portrait even when the host
      // app is in landscape (the preview appeared sideways/letterboxed
      // under a non-locked host).  Declaring all four keeps the modal
      // aligned with the interface.  Mirrors the v0.12 fix already on
      // OrientationDriftModal + PanoramaSettingsModal.
      supportedOrientations={[
        'portrait',
        'portrait-upside-down',
        'landscape-left',
        'landscape-right',
      ]}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        {/* Top bar — title centred, close X right-aligned. */}
        <View style={styles.topBar}>
          <View style={styles.topBarSpacer} />
          {title ? (
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
          ) : (
            <View style={styles.topBarSpacer} />
          )}
          <Pressable
            onPress={onClose}
            hitSlop={20}
            style={styles.closeButton}
            accessibilityRole="button"
            accessibilityLabel="Close preview"
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        {/* Tapping outside the image (on the dim backdrop) also
         *  closes — matches the quick-dismiss pattern users learn
         *  from iOS share sheets. */}
        <Pressable
          style={styles.imageWrapper}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close preview"
        >
          <Image
            source={{ uri: imageUri }}
            style={[styles.image, { aspectRatio }]}
            resizeMode="contain"
            // OOM fix — decode at display size, not full panorama res
            // (see DISPLAY_DECODE_IMAGE_PROPS for the native-heap rationale).
            {...DISPLAY_DECODE_IMAGE_PROPS}
            accessibilityIgnoresInvertColors
          />
        </Pressable>

        {hasActions ? (
          <View style={styles.buttonRow}>
            {actions!.map((action, idx) => (
              <Pressable
                key={`${action.label}-${idx}`}
                onPress={action.onPress}
                disabled={action.disabled}
                style={[
                  styles.button,
                  buttonStyleFor(action.variant ?? 'neutral'),
                  action.disabled ? styles.buttonDisabled : null,
                ]}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled: action.disabled }}
              >
                <Text
                  style={[
                    styles.buttonText,
                    buttonTextStyleFor(action.variant ?? 'neutral'),
                  ]}
                  numberOfLines={1}
                >
                  {action.icon ? `${action.icon}  ` : ''}{action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}


function buttonStyleFor(variant: CapturePreviewActionVariant) {
  switch (variant) {
    case 'primary':
      return styles.buttonPrimary;
    case 'destructive':
      return styles.buttonDestructive;
    case 'ghost':
      return styles.buttonGhost;
    case 'neutral':
    default:
      return styles.buttonNeutral;
  }
}


function buttonTextStyleFor(variant: CapturePreviewActionVariant) {
  switch (variant) {
    case 'primary':
      return styles.buttonTextPrimary;
    case 'destructive':
      return styles.buttonTextDestructive;
    case 'ghost':
      return styles.buttonTextGhost;
    case 'neutral':
    default:
      return styles.buttonTextNeutral;
  }
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
    paddingTop: 56,
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  topBarSpacer: {
    width: 44,
  },
  title: {
    flex: 1,
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '300',
    lineHeight: 32,
    marginTop: -2,
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
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPrimary: {
    backgroundColor: '#34C759',
  },
  buttonNeutral: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  buttonDestructive: {
    backgroundColor: '#FF3B30',
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  buttonTextPrimary: {
    color: '#ffffff',
    fontWeight: '700',
  },
  buttonTextNeutral: {
    color: '#ffffff',
  },
  buttonTextGhost: {
    color: '#ffffff',
    opacity: 0.9,
    fontWeight: '500',
  },
  buttonTextDestructive: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
