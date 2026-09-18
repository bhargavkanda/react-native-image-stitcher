// SPDX-License-Identifier: Apache-2.0
/**
 * PinchZoomView — dependency-free pinch-zoom + pan carrier for the ANDROID
 * review composites (Android-parity design doc 2026-07-17, Phase 5 / G7).
 *
 * WHY THIS EXISTS: the review zoom shipped on RN-core `ScrollView`
 * `maximumZoomScale`, which is UIScrollView-backed and therefore iOS-only —
 * Android pinch was a documented no-op. react-native-gesture-handler /
 * reanimated are deliberately NOT dependencies (parity doc NF1), so this is a
 * `PanResponder` + `Animated` implementation. iOS KEEPS the native ScrollView
 * zoom: UIScrollView brings fling/bounce/deceleration physics a JS responder
 * cannot match and is already field-verified — consumers branch on
 * `Platform.OS` rather than regress a proven gesture.
 *
 * TOUCH OWNERSHIP: pinch, pan and tap run through ONE deterministic
 * pipeline on the viewport view — the content wrapper is
 * `pointerEvents="none"`, so child touchables never see raw touches (they
 * stay in the tree for layout and for TalkBack, which activates their
 * `onPress` via accessibility click actions — those bypass touch dispatch
 * entirely). Taps are mapped through the INVERSE zoom/pan transform
 * (`viewToContent`) and delivered to `onTap` in CONTENT coordinates; the
 * consumer hit-tests them (`hitTestRects`) against the SAME rects it
 * rendered its hotspots from. That sidesteps RN-Android hit-testing through
 * transformed views entirely.
 *
 * PARENT SCROLLERS (W1, wiring review 2026-07-17): results screens wrap the
 * planogram strip in a vertical ScrollView. The viewport takes the responder
 * on touch-down via the ordinary NON-capture start claim (so taps work) and
 * `onShouldBlockNativeResponder` is CONDITIONAL (`shouldBlockNativeGesture`):
 * it blocks the native ancestor only while the gesture is ours to keep —
 * engaged pan/pinch, 2+ pointers, or zoomed-in content. At the minimum fit a
 * single-finger vertical drag therefore leaves the enclosing native
 * ScrollView free to intercept and scroll the page; when it does, our
 * responder gets `onPanResponderTerminate` and resets its gesture
 * bookkeeping without touching the applied transform (no visual jump).
 * Move-claims (`onMoveShouldSetPanResponder[Capture]`) go through the pure
 * `shouldClaimGesture` policy — 2+ touches always; one finger when zoomed;
 * one finger at the fit only for a horizontal-dominant drag over
 * horizontally-overflowing content. KNOWN LIMIT: Android evaluates the
 * native-block decision once, at responder grant — a pinch STARTED at the
 * minimum fit inside a scrollable page is granted unblocked, so the page
 * ScrollView can steal it once its touch slop trips; the partial zoom
 * sticks, and the next pinch (now zoomed) is granted blocked. Gesture feel
 * is DEVICE-verified, per the doc.
 *
 * Gesture grammar (all math in `zoomTransform.ts`, unit-tested):
 *   - two fingers: focal-anchored zoom (clamped minScale..maxScale) +
 *     two-finger pan; pinch→one-finger continues as pan (re-based);
 *   - one finger: pan when the content overflows (incl. the wide strip at
 *     scale 1), after a 10 pt tap-slop;
 *   - tap (release without slop breach): `onTap` in content coords;
 *   - double-tap (≤300 ms, ≤30 pt apart): reset to the clamped identity fit.
 *     The FIRST tap of a double-tap has already fired `onTap` — selection
 *     then reset is the accepted trade for not delaying every single tap.
 *
 * This component is the RN glue around the tested math — itself typecheck- +
 * device-verified (the ClickablePlanogram precedent).
 */

import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeTouchEvent,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  clampTransform,
  identityTransform,
  panTransform,
  pinchTransform,
  releaseGesture,
  rnTransform,
  shouldBlockNativeGesture,
  shouldClaimGesture,
  viewToContent,
  type TapMemory,
  type ZoomBounds,
  type ZoomPoint,
  type ZoomTransform,
} from './zoomTransform';

export interface PinchZoomViewProps {
  /** Laid-out content size (points) — the canvas the children fill. */
  contentWidth: number;
  contentHeight: number;
  /** Zoom range; defaults mirror the iOS ScrollView carrier (1..4). */
  minScale?: number;
  maxScale?: number;
  /**
   * Single non-drag tap, in CONTENT coordinates (already routed through the
   * inverse zoom/pan transform) — hit-test with `hitTestRects` against the
   * rects the hotspots were rendered from.
   */
  onTap?: (p: ZoomPoint) => void;
  /** Viewport style (sizing/positioning). Overflow is clipped. */
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** Movement below this (pt) is still a tap. */
const TAP_SLOP_PX = 10;
/** Pinches starting closer than this (pt) are ignored (ratio blow-up). */
const MIN_PINCH_DIST_PX = 8;

interface GestureRec {
  mode: 'idle' | 'pan' | 'pinch';
  /** Transform at gesture (re)base — deltas apply against this. */
  base: ZoomTransform;
  /** Single-finger pan anchor, PAGE coords (origin-free deltas). */
  panStart: ZoomPoint;
  /** Two-finger start distance (page coords) and midpoint (viewport coords). */
  pinchDist0: number;
  pinchFocal0: ZoomPoint;
  touchCount: number;
  moved: boolean;
  /** True once the gesture EVER had 2+ pointers — a later release must not
   *  run the tap branch (two-finger taps don't press on iOS either; W6). */
  hadMultiTouch: boolean;
  lastTap: TapMemory | null;
}

function setAnimated(
  anim: { scale: Animated.Value; tx: Animated.Value; ty: Animated.Value },
  t: ZoomTransform,
  contentW: number,
  contentH: number,
): void {
  const rn = rnTransform(t, contentW, contentH);
  anim.scale.setValue(rn.scale);
  anim.tx.setValue(rn.translateX);
  anim.ty.setValue(rn.translateY);
}

export function PinchZoomView({
  contentWidth,
  contentHeight,
  minScale = 1,
  maxScale = 4,
  onTap,
  style,
  children,
}: PinchZoomViewProps): React.JSX.Element {
  const viewRef = useRef<View>(null);
  const viewportRef = useRef({ w: 0, h: 0 });
  /** Window origin of the (untransformed) viewport — page → viewport coords. */
  const originRef = useRef({ x: 0, y: 0 });
  /** Live transform (updated on every applied gesture step). */
  const transformRef = useRef<ZoomTransform>(identityTransform());
  const anim = useRef({
    scale: new Animated.Value(1),
    tx: new Animated.Value(0),
    ty: new Animated.Value(0),
  }).current;
  const gestureRef = useRef<GestureRec>({
    mode: 'idle',
    base: identityTransform(),
    panStart: { x: 0, y: 0 },
    pinchDist0: 0,
    pinchFocal0: { x: 0, y: 0 },
    touchCount: 0,
    moved: false,
    hadMultiTouch: false,
    lastTap: null,
  });
  // The responder is created ONCE; callbacks read props via this ref so
  // content-size / handler changes reach the live closure.
  const propsRef = useRef({ contentWidth, contentHeight, minScale, maxScale, onTap });
  propsRef.current = { contentWidth, contentHeight, minScale, maxScale, onTap };

  // New content geometry (e.g. a fresh planogram on a mounted consumer, or a
  // keyed remount's first pass) → reset to the clamped identity fit.
  useEffect(() => {
    const p = propsRef.current;
    const t = clampTransform(identityTransform(), {
      contentW: p.contentWidth,
      contentH: p.contentHeight,
      viewportW: viewportRef.current.w,
      viewportH: viewportRef.current.h,
      minScale: p.minScale,
      maxScale: p.maxScale,
    });
    transformRef.current = t;
    setAnimated(anim, t, p.contentWidth, p.contentHeight);
    // anim is a stable ref value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentWidth, contentHeight]);

  const panResponder = useMemo(() => {
    const boundsNow = (): ZoomBounds => {
      const p = propsRef.current;
      return {
        contentW: p.contentWidth,
        contentH: p.contentHeight,
        viewportW: viewportRef.current.w,
        viewportH: viewportRef.current.h,
        minScale: p.minScale,
        maxScale: p.maxScale,
      };
    };
    const apply = (t: ZoomTransform): void => {
      transformRef.current = t;
      const p = propsRef.current;
      setAnimated(anim, t, p.contentWidth, p.contentHeight);
    };
    const measureOrigin = (): void => {
      viewRef.current?.measureInWindow((x: number, y: number) => {
        originRef.current = { x, y };
      });
    };
    const viewPoint = (pageX: number, pageY: number): ZoomPoint => ({
      x: pageX - originRef.current.x,
      y: pageY - originRef.current.y,
    });
    /** Pointer count changed → re-anchor deltas on the LIVE transform. */
    const rebase = (touches: NativeTouchEvent[]): void => {
      const g = gestureRef.current;
      g.base = transformRef.current;
      g.touchCount = touches.length;
      if (touches.length >= 2) {
        const [a, b] = touches;
        g.mode = 'pinch';
        g.hadMultiTouch = true;
        g.pinchDist0 = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
        g.pinchFocal0 = viewPoint(
          (a.pageX + b.pageX) / 2,
          (a.pageY + b.pageY) / 2,
        );
      } else if (touches.length === 1) {
        // Pinch → one remaining finger continues as a pan from here.
        if (g.mode === 'pinch') g.mode = 'pan';
        g.panStart = { x: touches[0].pageX, y: touches[0].pageY };
      }
    };
    /** The move-claim policy inputs, from the live event + gesture state. */
    const claimNow = (
      evt: GestureResponderEvent,
      gs: PanResponderGestureState,
    ): boolean =>
      shouldClaimGesture(
        evt.nativeEvent.touches.length,
        gs.dx,
        gs.dy,
        transformRef.current,
        boundsNow(),
      );
    return PanResponder.create({
      // W1: NO capture-claim on touch-down. The responder is taken via the
      // ordinary non-capture start claim (taps keep working; children are
      // raw-touch inert via the content wrapper's pointerEvents="none", so
      // the pipeline stays centralized here) and, when some other responder
      // got there first, stolen on MOVE only when the gesture is
      // unambiguously ours (pure policy: shouldClaimGesture).
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: claimNow,
      onMoveShouldSetPanResponderCapture: claimNow,
      // Android: block the native ancestor responder ONLY while the gesture
      // is ours to keep (engaged pan/pinch, 2+ pointers, or zoomed in). RN
      // evaluates this at responder grant; returning false for one finger at
      // the minimum fit is what lets an enclosing page ScrollView intercept
      // vertical drags (see file header).
      onShouldBlockNativeResponder: (evt: GestureResponderEvent) => {
        const g = gestureRef.current;
        return shouldBlockNativeGesture(
          g.mode,
          g.hadMultiTouch || evt.nativeEvent.touches.length >= 2,
          transformRef.current,
          boundsNow(),
        );
      },
      onPanResponderGrant: (evt: GestureResponderEvent) => {
        measureOrigin(); // refresh; one-frame-stale origins are tolerable
        const g = gestureRef.current;
        g.mode = 'idle';
        g.moved = false;
        g.hadMultiTouch = false;
        g.base = transformRef.current;
        const touches = evt.nativeEvent.touches;
        g.touchCount = touches.length;
        if (touches.length >= 2) {
          rebase(touches); // sets pinch mode + hadMultiTouch
        } else {
          g.panStart = { x: evt.nativeEvent.pageX, y: evt.nativeEvent.pageY };
        }
      },
      // Fires on EVERY additional pointer-down while we hold the responder —
      // the only signal for a second finger that never moves (a two-finger
      // tap never reaches onPanResponderMove), which must suppress the tap
      // branch on release (W6). Pinch anchors are still (re)based lazily in
      // onPanResponderMove via the touch-count comparison.
      onPanResponderStart: (evt: GestureResponderEvent) => {
        if (evt.nativeEvent.touches.length >= 2) {
          gestureRef.current.hadMultiTouch = true;
        }
      },
      onPanResponderMove: (evt: GestureResponderEvent) => {
        const g = gestureRef.current;
        const touches = evt.nativeEvent.touches;
        if (touches.length !== g.touchCount) rebase(touches);
        if (touches.length >= 2) {
          const [a, b] = touches;
          const d = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
          if (g.pinchDist0 < MIN_PINCH_DIST_PX) {
            g.pinchDist0 = d;
            return;
          }
          const focal = viewPoint(
            (a.pageX + b.pageX) / 2,
            (a.pageY + b.pageY) / 2,
          );
          g.moved = true;
          apply(
            pinchTransform(
              g.base,
              g.pinchFocal0,
              focal,
              d / g.pinchDist0,
              boundsNow(),
            ),
          );
        } else if (touches.length === 1 && g.mode !== 'pinch') {
          const t = touches[0];
          const dx = t.pageX - g.panStart.x;
          const dy = t.pageY - g.panStart.y;
          if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP_PX) return;
          g.moved = true;
          g.mode = 'pan';
          apply(panTransform(g.base, dx, dy, boundsNow()));
        }
      },
      onPanResponderRelease: (evt: GestureResponderEvent) => {
        const g = gestureRef.current;
        const p = viewPoint(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        // Pure release policy (W6/W7): moved or ever-multi-touch gestures
        // never tap AND clear the double-tap memory; clean taps chain into
        // double-tap reset within the window.
        const r = releaseGesture(g.moved, g.hadMultiTouch, g.lastTap, Date.now(), p);
        g.lastTap = r.lastTap;
        if (r.action === 'doubleTapReset') {
          apply(clampTransform(identityTransform(), boundsNow()));
        } else if (r.action === 'tap') {
          propsRef.current.onTap?.(viewToContent(p, transformRef.current));
        }
        g.mode = 'idle';
        g.moved = false;
        g.hadMultiTouch = false;
      },
      onPanResponderTerminate: () => {
        // The native side (e.g. the page ScrollView intercepting a vertical
        // drag at the minimum fit) or another JS responder took the gesture.
        // Reset the gesture bookkeeping ONLY — transformRef keeps the last
        // applied state, so there is no transform jump; the next gesture
        // re-bases cleanly on it.
        const g = gestureRef.current;
        g.mode = 'idle';
        g.moved = false;
        g.hadMultiTouch = false;
        g.lastTap = null; // an interrupted gesture must not chain a double-tap
      },
      onPanResponderTerminationRequest: () => {
        // A JS competitor asks for the responder: same keep policy as the
        // native block — grant unless the gesture is ours (engaged pan/pinch,
        // multi-touch, or zoomed-in content).
        const g = gestureRef.current;
        return !shouldBlockNativeGesture(
          g.mode,
          g.hadMultiTouch,
          transformRef.current,
          boundsNow(),
        );
      },
    });
    // All inputs are stable refs; create exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View
      ref={viewRef}
      style={[styles.viewport, style]}
      onLayout={(e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        viewportRef.current = { w: width, h: height };
        viewRef.current?.measureInWindow((x: number, y: number) => {
          originRef.current = { x, y };
        });
        // A resize can strand the old translation — re-clamp against the new
        // viewport (identity stays identity; a zoomed state snaps in-bounds).
        const p = propsRef.current;
        const t = clampTransform(transformRef.current, {
          contentW: p.contentWidth,
          contentH: p.contentHeight,
          viewportW: width,
          viewportH: height,
          minScale: p.minScale,
          maxScale: p.maxScale,
        });
        transformRef.current = t;
        setAnimated(anim, t, p.contentWidth, p.contentHeight);
      }}
      testID="pinch-zoom-view"
      {...panResponder.panHandlers}
    >
      <Animated.View
        // Children are raw-touch INERT (single gesture pipeline on the
        // viewport, exactly as under the old capture-claim): without this,
        // dropping the capture-claim would let hotspot touchables win the
        // non-capture start negotiation and re-open RN-Android hit-testing
        // through transformed views. TalkBack still activates them via
        // accessibility click actions, which bypass touch dispatch.
        pointerEvents="none"
        style={{
          width: contentWidth,
          height: contentHeight,
          transform: [
            { translateX: anim.tx },
            { translateY: anim.ty },
            { scale: anim.scale },
          ],
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: { overflow: 'hidden' },
});
