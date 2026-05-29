// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureHeader — top-of-screen header for any capture surface.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  ‹ Back        Cola Promo End Cap                        │
 *   │  Photograph the promotional cola end cap.                │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Two stacked rows — title row (back arrow + centred title) and an
 * optional guidance line below.  Lives in the SDK so every capture
 * surface gets identical chrome without re-implementing safe-area
 * handling, accessibility labels, and contrast on a black preview.
 *
 * Theming:
 *   The host has its own theme system; rather than coupling the SDK
 *   to it, the component exposes a small set of color props
 *   (defaulted to white-on-black for visibility against the camera
 *   preview).  Hosts that want to override pass `colors`.
 */

import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';


export interface CaptureHeaderProps {
  /** The audit / surface title.  Centred horizontally. */
  title: string;
  /**
   * Called when the back affordance is pressed.  If omitted, the
   * back button is hidden entirely (use this for surfaces invoked
   * as a top-level tab where back doesn't make sense).
   */
  onBack?: () => void;
  /** Custom label for the back button.  Defaults to "‹ Back". */
  backLabel?: string;
  /**
   * Called when the gear / settings affordance is pressed.  If
   * omitted, no settings icon is rendered.  Wire this to the
   * host's PanoramaSettingsModal `visible` state.
   */
  onSettingsPress?: () => void;
  /**
   * Optional second-line guidance text shown below the title row.
   * Renders nothing if absent.
   */
  guidance?: string;
  /**
   * Top inset in pixels.  Pass `useSafeAreaInsets().top` from
   * react-native-safe-area-context if your app uses it; otherwise a
   * sensible default is applied.
   */
  topInset?: number;
  /** Override the default text/background colors. */
  colors?: {
    background?: string;
    title?: string;
    accent?: string;
    guidanceBackground?: string;
    guidanceText?: string;
  };
  /** Additional style applied to the outer container. */
  style?: StyleProp<ViewStyle>;
}


export function CaptureHeader({
  title,
  onBack,
  backLabel = '‹ Back',
  onSettingsPress,
  guidance,
  topInset = 0,
  colors,
  style,
}: CaptureHeaderProps): React.JSX.Element {
  // v0.13.1 — defaults are now transparent over the camera preview
  // (matches the AR toggle / settings gear pill style); hosts using
  // the header outside a camera context can pass solid colours via
  // `colors`.  Title + gear get a text shadow for legibility over
  // bright preview content; guidance row keeps a translucent pill
  // background for the same reason.
  const bg = colors?.background ?? 'transparent';
  const titleColor = colors?.title ?? '#ffffff';
  const accent = colors?.accent ?? '#FF9F0A';
  const guidanceBg = colors?.guidanceBackground ?? 'rgba(0,0,0,0.45)';
  const guidanceColor = colors?.guidanceText ?? '#ffffff';

  return (
    <View style={[{ backgroundColor: bg }, style]}>
      <View style={[styles.titleRow, { paddingTop: topInset + 4 }]}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.backButton}
          >
            <Text style={[styles.backText, styles.textShadow, { color: accent }]}>
              {backLabel}
            </Text>
          </Pressable>
        ) : (
          // Empty spacer keeps the title centred even when back is hidden.
          <View style={styles.backButton} />
        )}
        <Text
          style={[styles.title, styles.textShadow, { color: titleColor }]}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {title}
        </Text>
        {/* Settings gear (right side).  Falls back to a spacer when
         *  the host doesn't wire a handler — keeps the title centred. */}
        {onSettingsPress ? (
          <Pressable
            onPress={onSettingsPress}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Open panorama settings"
            style={styles.backButton}
          >
            <Text style={[styles.gearIcon, styles.textShadow, { color: accent }]}>⚙</Text>
          </Pressable>
        ) : (
          <View style={styles.backButton} />
        )}
      </View>

      {guidance ? (
        <View
          style={[styles.guidance, { backgroundColor: guidanceBg }]}
          accessibilityRole="text"
        >
          <Text
            style={[styles.guidanceText, { color: guidanceColor }]}
            numberOfLines={2}
          >
            {guidance}
          </Text>
        </View>
      ) : null}
    </View>
  );
}


const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
  backButton: {
    minWidth: 56,
    paddingVertical: 2,
  },
  backText: {
    fontSize: 14,
    fontWeight: '500',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
  },
  guidance: {
    // v0.13.1 — guidance row is now a centred pill inset from the
    // edges (matches the AR-toggle / lens-chip pill style) rather
    // than a full-width band.  The pill background gives it its
    // own contrast over the preview without forcing a solid bar.
    alignSelf: 'center',
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    maxWidth: '90%',
  },
  guidanceText: {
    fontSize: 12,
    textAlign: 'center',
  },
  gearIcon: {
    fontSize: 20,
    textAlign: 'right',
  },
  // v0.13.1 — subtle text shadow so the (now-transparent) header
  // text stays legible over bright preview content.  Same trick
  // iOS Camera uses for the timestamp / mode labels.
  textShadow: {
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
