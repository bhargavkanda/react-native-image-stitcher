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
  const bg = colors?.background ?? '#000000';
  const titleColor = colors?.title ?? '#ffffff';
  const accent = colors?.accent ?? '#FF9F0A';
  const guidanceBg = colors?.guidanceBackground ?? 'rgba(255,255,255,0.08)';
  const guidanceColor = colors?.guidanceText ?? '#ffffff';

  return (
    <View style={[{ backgroundColor: bg }, style]}>
      <View style={[styles.titleRow, { paddingTop: topInset + 8 }]}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.backButton}
          >
            <Text style={[styles.backText, { color: accent }]}>
              {backLabel}
            </Text>
          </Pressable>
        ) : (
          // Empty spacer keeps the title centred even when back is hidden.
          <View style={styles.backButton} />
        )}
        <Text
          style={[styles.title, { color: titleColor }]}
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
            <Text style={[styles.gearIcon, { color: accent }]}>⚙</Text>
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
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  backButton: {
    minWidth: 64,
    paddingVertical: 4,
  },
  backText: {
    fontSize: 16,
    fontWeight: '500',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '600',
  },
  guidance: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  guidanceText: {
    fontSize: 13,
  },
  gearIcon: {
    fontSize: 22,
    textAlign: 'right',
  },
});
