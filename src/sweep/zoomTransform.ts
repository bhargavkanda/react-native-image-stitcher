// SPDX-License-Identifier: Apache-2.0
/**
 * zoomTransform.ts — PURE pinch-zoom / pan transform math behind
 * `PinchZoomView` (the dependency-free Android zoom carrier; Android-parity
 * design doc 2026-07-17, Phase 5 / G7).
 *
 * Model: a zoom state maps CONTENT coordinates (the fixed-size canvas the
 * consumer lays out — composite pixels already scaled to layout points) into
 * VIEWPORT coordinates via
 *
 *     v = scale · p + t        (t = (tx, ty), both spaces top-left origin)
 *
 * Every part that goes wrong in hand-rolled zoomers is concentrated here and
 * unit-tested:
 *   - focal-point-anchored pinch (zoom about the pinch midpoint, NOT the
 *     origin) — `pinchTransform`;
 *   - the inverse map taps must ride through before hit-testing hotspots —
 *     `viewToContent` + `hitTestRects`;
 *   - the conversion to React Native's CENTER-origin `transform` array —
 *     `rnTransform`;
 *   - translation clamping that pins overflowing axes to the viewport and
 *     centres underflowing ones — `clampTransform`.
 *
 * Deliberately React-free so it runs in camera-sdk's plain-node jest (the
 * `reviewGeometry.ts` precedent); the component around it is typecheck- +
 * device-verified.
 */

/** A point, in whichever of the two spaces the function documents. */
export interface ZoomPoint {
  x: number;
  y: number;
}

/** The zoom state: `v = scale · p + t`. `scale` MUST be > 0. */
export interface ZoomTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** Geometry the clamps operate against. `minScale` MUST be > 0. */
export interface ZoomBounds {
  /** Laid-out content size (points). */
  contentW: number;
  contentH: number;
  /** Measured viewport size (points). */
  viewportW: number;
  viewportH: number;
  minScale: number;
  maxScale: number;
}

/** Content overflow below this many points does not count as pannable. */
const PAN_EPS = 0.5;

/** The no-zoom state: content top-left on viewport top-left at scale 1. */
export function identityTransform(): ZoomTransform {
  return { scale: 1, tx: 0, ty: 0 };
}

/** Where a CONTENT point lands in the viewport: `v = scale · p + t`. */
export function contentToView(p: ZoomPoint, t: ZoomTransform): ZoomPoint {
  return { x: t.scale * p.x + t.tx, y: t.scale * p.y + t.ty };
}

/**
 * The inverse map, `p = (v − t) / scale` — a VIEWPORT point (e.g. a tap)
 * back into content coordinates. The tap path routes through this BEFORE
 * `hitTestRects`, which is what keeps hotspot taps landing at any zoom.
 */
export function viewToContent(v: ZoomPoint, t: ZoomTransform): ZoomPoint {
  return { x: (v.x - t.tx) / t.scale, y: (v.y - t.ty) / t.scale };
}

/**
 * Clamp a transform into bounds: `scale` into `[minScale, maxScale]`; then
 * each translation axis independently so the scaled content
 * (`scale·contentW × scale·contentH`) never leaves a gap inside the viewport
 * on an axis it can fill (`t ∈ [viewport − scaled, 0]`) and is centred on an
 * axis it cannot (`t = (viewport − scaled) / 2`).
 */
export function clampTransform(t: ZoomTransform, b: ZoomBounds): ZoomTransform {
  const scale = clamp(t.scale, b.minScale, b.maxScale);
  return {
    scale,
    tx: clampAxis(t.tx, scale * b.contentW, b.viewportW),
    ty: clampAxis(t.ty, scale * b.contentH, b.viewportH),
  };
}

/**
 * Focal-point-anchored pinch step. `start` is the transform at gesture start,
 * `f0`/`f1` the pinch midpoint at start/now (VIEWPORT coords), `distRatio`
 * the current two-finger distance over the start distance.
 *
 * Math: new scale `s = clamp(start.scale · distRatio)`; the content anchor
 * `a = viewToContent(f0, start)` must stay under the CURRENT midpoint, i.e.
 * `s·a + t = f1`, giving `t = f1 − s·a`. The `f1 − f0` drift makes two-finger
 * pan fall out for free. Result is clamped into bounds.
 */
export function pinchTransform(
  start: ZoomTransform,
  f0: ZoomPoint,
  f1: ZoomPoint,
  distRatio: number,
  b: ZoomBounds,
): ZoomTransform {
  const scale = clamp(start.scale * distRatio, b.minScale, b.maxScale);
  const a = viewToContent(f0, start);
  return clampTransform(
    { scale, tx: f1.x - scale * a.x, ty: f1.y - scale * a.y },
    b,
  );
}

/**
 * Single-finger pan step: translate `start` by the finger delta (viewport
 * points), clamped — a non-pannable axis snaps to its centred position, so
 * panning a strip that only overflows horizontally cannot drag it vertically.
 */
export function panTransform(
  start: ZoomTransform,
  dx: number,
  dy: number,
  b: ZoomBounds,
): ZoomTransform {
  return clampTransform(
    { scale: start.scale, tx: start.tx + dx, ty: start.ty + dy },
    b,
  );
}

/**
 * Whether the scaled content overflows the viewport per axis. The responder
 * uses this to hand vertical drags it cannot consume back to an enclosing
 * scroller (results screens wrap the strip in a vertical ScrollView).
 */
export function isPannable(
  t: ZoomTransform,
  b: ZoomBounds,
): { x: boolean; y: boolean } {
  return {
    x: t.scale * b.contentW > b.viewportW + PAN_EPS,
    y: t.scale * b.contentH > b.viewportH + PAN_EPS,
  };
}

/**
 * Convert the top-left-origin model into the values React Native's
 * `transform: [{translateX}, {translateY}, {scale}]` needs. RN applies the
 * array right-to-left about the view's CENTER `C = (contentW/2, contentH/2)`:
 * `p ↦ s·p + C·(1−s) + T`. Solving against the model `v = s·p + t` gives
 * `T = t − C·(1−s)` — without this correction the zoom anchors at the content
 * centre instead of the pinch focal point.
 */
export function rnTransform(
  t: ZoomTransform,
  contentW: number,
  contentH: number,
): { scale: number; translateX: number; translateY: number } {
  return {
    scale: t.scale,
    translateX: t.tx - (contentW / 2) * (1 - t.scale),
    translateY: t.ty - (contentH / 2) * (1 - t.scale),
  };
}

/** An axis-aligned hotspot rect in CONTENT coordinates (RN layout fields). */
export interface HitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Index of the hotspot under a CONTENT-space point, mirroring RN sibling
 * hit-testing: the LAST containing rect wins (later siblings render on top),
 * each rect padded by `slop` points on all four sides (the `hitSlop` the
 * touchables use on iOS). Returns −1 on miss.
 */
export function hitTestRects(
  p: ZoomPoint,
  rects: readonly HitRect[],
  slop = 0,
): number {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (
      p.x >= r.left - slop &&
      p.x <= r.left + r.width + slop &&
      p.y >= r.top - slop &&
      p.y <= r.top + r.height + slop
    ) {
      return i;
    }
  }
  return -1;
}

/** Scale must exceed `minScale` by this before the content counts as
 *  zoomed in — a pinch released exactly at the minimum fit is NOT zoomed. */
const ZOOMED_IN_SCALE_EPS = 1e-3;

/** Double-tap window / proximity (release-to-release). */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;

/**
 * True when `t.scale > b.minScale + ε` — the content is zoomed past its
 * minimum fit. In that state every single-finger drag belongs to the zoom
 * viewport (panning), never to an enclosing page scroller.
 */
export function isZoomedIn(t: ZoomTransform, b: ZoomBounds): boolean {
  return t.scale > b.minScale + ZOOMED_IN_SCALE_EPS;
}

/**
 * Responder policy for a MOVING gesture — should the zoom viewport claim
 * (or steal) the responder, given the live pointer count, the accumulated
 * drag delta `(dx, dy)` in viewport points, and the current transform/bounds?
 *
 * Decision table (W1, wiring review 2026-07-17):
 *   - 2+ pointers          → claim: a pinch is always ours;
 *   - 1 pointer, zoomed in → claim: panning zoomed content;
 *   - 1 pointer, min fit   → claim ONLY when the drag is horizontal-dominant
 *     (`|dx| > |dy|`) AND the content actually overflows horizontally at the
 *     current scale (`isPannable().x` — the wide-strip pan). A vertical-
 *     dominant drag at the minimum fit is NOT ours: an enclosing vertical
 *     ScrollView (AuditFlow wraps the planogram strip on small screens) must
 *     stay free to take it natively and scroll the page;
 *   - 0 pointers           → never.
 */
export function shouldClaimGesture(
  touchCount: number,
  dx: number,
  dy: number,
  t: ZoomTransform,
  b: ZoomBounds,
): boolean {
  if (touchCount >= 2) return true;
  if (touchCount < 1) return false;
  if (isZoomedIn(t, b)) return true;
  return Math.abs(dx) > Math.abs(dy) && isPannable(t, b).x;
}

/**
 * Whether an already-granted responder should lock out competing responders
 * (Android: block the native ancestor responder, i.e.
 * `requestDisallowInterceptTouchEvent`; JS: refuse a termination request).
 * True ONLY while the gesture is ours to keep — an engaged pan/pinch, a
 * multi-touch (pinch forming), or zoomed-in content. At the minimum fit with
 * one still finger this is FALSE, which leaves an enclosing native
 * ScrollView able to intercept a vertical drag and scroll the page (the W1
 * fix — the previous unconditional `true` made that impossible).
 */
export function shouldBlockNativeGesture(
  mode: 'idle' | 'pan' | 'pinch',
  multiTouch: boolean,
  t: ZoomTransform,
  b: ZoomBounds,
): boolean {
  return mode !== 'idle' || multiTouch || isZoomedIn(t, b);
}

/** The last completed tap, for double-tap chaining. `p` in VIEWPORT coords. */
export interface TapMemory {
  time: number;
  p: ZoomPoint;
}

/**
 * Tap outcome of a gesture release. Inputs: whether the gesture ever moved
 * past the tap slop, whether it EVER had 2+ pointers (`hadMultiTouch`), the
 * previous tap memory, the release time (ms) and point (viewport coords).
 *
 *   - moved or multi-touch → `none`, and the tap memory is CLEARED so a
 *     tap → drag/pinch → tap sequence can never fake a double-tap (W7).
 *     Multi-touch releases must not tap at all: iOS touchables do not fire
 *     on two-finger taps, and Android mirrors that here (W6);
 *   - clean tap within 300 ms and 30 pt of the previous one →
 *     `doubleTapReset` (memory cleared — a triple tap is not two doubles);
 *   - any other clean tap → `tap`, remembered for the next release.
 */
export function releaseGesture(
  moved: boolean,
  hadMultiTouch: boolean,
  lastTap: TapMemory | null,
  now: number,
  p: ZoomPoint,
): { action: 'none' | 'tap' | 'doubleTapReset'; lastTap: TapMemory | null } {
  if (moved || hadMultiTouch) return { action: 'none', lastTap: null };
  if (
    lastTap != null &&
    now - lastTap.time <= DOUBLE_TAP_MS &&
    Math.hypot(p.x - lastTap.p.x, p.y - lastTap.p.y) <= DOUBLE_TAP_SLOP_PX
  ) {
    return { action: 'doubleTapReset', lastTap: null };
  }
  return { action: 'tap', lastTap: { time: now, p } };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampAxis(t: number, scaled: number, viewport: number): number {
  if (scaled <= viewport) return (viewport - scaled) / 2;
  return clamp(t, viewport - scaled, 0);
}
