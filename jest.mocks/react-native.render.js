// SPDX-License-Identifier: Apache-2.0
/**
 * `react-native` mock for the RENDER test project (jest.config.js `projects`).
 *
 * WHY A SECOND MOCK. The pure suite's `react-native.js` exports data only — it
 * has no components, because nothing there renders. The render project mounts
 * real components through `react-test-renderer`, so the RN primitives have to
 * BE components. They are host strings ('View', 'Text', …) rather than real RN
 * views: react-test-renderer treats an unknown host type as an opaque node with
 * its props recorded, which is exactly what a HUD assertion needs — the tree
 * carries the text and the styles, and nothing has to draw a pixel.
 *
 * WHY NOT THE `react-native` PRESET. It pulls the RN babel preset and a metro
 * module map to render views we never look at. The T2 surface reaches for
 * exactly five RN symbols (NativeModules, StyleSheet, Text, TouchableOpacity,
 * View); mocking those five keeps the render project as cheap and as
 * rot-resistant as the pure one, which is the reason the original config gave
 * for staying off the preset.
 *
 * Add a symbol here only when a component under test genuinely reaches for it.
 */

/** StyleSheet.create is identity — tests assert on the style OBJECTS, so the
 *  registry-id indirection real RN adds would only obscure them. */
const StyleSheet = {
  create: (styles) => styles,
  flatten: (style) =>
    Array.isArray(style)
      ? style.filter(Boolean).reduce((acc, s) => Object.assign(acc, StyleSheet.flatten(s)), {})
      : (style ?? {}),
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hairlineWidth: 1,
};

/** Mutable so a render test can rotate the device (see `__setWindowDimensions`). */
const windowDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };

/**
 * `AppState`, ADDED 2026-09-03 with the pano+ idle viewfinder's re-arm.
 *
 * The surface subscribes so a backgrounded app that loses the camera gets its
 * feed back on foreground — without it the operator returns to a FROZEN last
 * frame that looks live (measured on the A35: no camera client, three
 * screenshots two seconds apart byte-identical). A mock that merely returned
 * `{remove(){}}` would satisfy the mount and prove nothing, so the listeners
 * are held and `__emitAppState` fires them: a test can drive the foreground
 * transition and assert the re-open actually happens.
 */
const appStateListeners = new Set();
const AppState = {
  currentState: 'active',
  addEventListener: (type, handler) => {
    if (type === 'change') appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  },
};

module.exports = {
  // M4 — <Camera> reads vision-camera's view tag for the sweep's AE/AWB lock.
  findNodeHandle: (ref) => (ref == null ? null : 101),
  AppState,
  __emitAppState: (next) => {
    AppState.currentState = next;
    for (const l of Array.from(appStateListeners)) l(next);
  },
  __appStateListenerCount: () => appStateListeners.size,
  // Host components — opaque to the renderer, fully inspectable in the tree.
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  // ⚠ ADDED so the KEYFRAME tree can be mounted at all. Without it any
  // render that reaches `PanoramaSettingsModal` dies with "Element type is
  // invalid", which meant no suite in this package could mount `<Camera>`
  // in its default (non-sweep) engine — and that gap hid a real defect: the
  // keyframe cell's preview was writing the SWEEP's "is it drawing" flag,
  // so sweep → keyframe → sweep reported a session-less preview as live.
  // See `cameraSweepHostArm.render.test.tsx`.
  Modal: 'Modal',
  Image: 'Image',
  ScrollView: 'ScrollView',
  // ⚠ THE SAME GAP AS `Modal` ABOVE, one component later. Without it any
  // render reaching `CaptureThumbnailStrip` dies with the identical
  // "Element type is invalid" — which is exactly how the sweep cell's
  // MISSING thumbnail strip stayed invisible to the suite: the one test that
  // mentioned the strip asserted it was ABSENT, so the mock gap and the
  // product gap agreed with each other and neither was visible.
  FlatList: 'FlatList',
  StyleSheet,
  Platform: { OS: 'ios', select: (o) => o.ios ?? o.default },
  Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) },
  // The pano+ surface places its live preview against the CURRENT window (a
  // tall panorama gets a portrait side panel, a wide one a top band), so the
  // render project needs the hook — and needs a test to be able to move it.
  //
  // PORTRAIT by default, and this is a CORRECTION. It read 844x390 with the
  // comment "pano+ is a landscape-only surface", which confuses the way the
  // phone is HELD with the window RN reports: the host app is portrait-LOCKED
  // (ios/the host app/Info.plist), so `useWindowDimensions()` returns 390x844
  // however it is held. The old value also disagreed with `Dimensions.get()`
  // three lines above, which was already portrait — a mock at odds with
  // itself. Sizing the preview panel against 844 pt of "width" is exactly the
  // geometry the operator never has.
  useWindowDimensions: () => ({ ...windowDimensions }),
  __setWindowDimensions: (w, h) => {
    windowDimensions.width = w;
    windowDimensions.height = h;
  },
  // The T2 surface gates its whole render on `NativeModules.RNSARSession`
  // having a `takePhoto` (puzzleCaptureIsAvailable) — the "AR session linked?"
  // probe. In a render test the session IS available (that is the state under
  // test), so provide the minimal shape the probe checks. The imperative
  // photo-taking still goes through ARCameraView's ref handle, not this — this
  // only has to satisfy the availability gate.
  //
  // ⚠ `isSupported` ADDED 2026-09-18 with `<Camera engine="sweep">`. Mounting
  // <Camera> at all runs `useARSession`, which PROBES support once on mount —
  // and a missing method there throws inside a passive effect, which
  // react-test-renderer reports as a stack ending in `commitHookEffectListMount`
  // rather than as "your mock is incomplete".
  //
  // It resolves TRUE because AR-capable is the state under test. The probe is
  // all the hook does on mount; `start()` is behind an explicit call that only
  // <ARCameraView> makes, which is what lets <Camera> run this hook in sweep
  // mode without opening a second session.
  NativeModules: {
    RNSARSession: {
      takePhoto: () => Promise.resolve({ path: '/tmp/rnsar.jpg' }),
      isSupported: () => Promise.resolve(true),
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    },
  },
  // ── Animated ──────────────────────────────────────────────────────────────
  // ADDED 2026-08-27 with the T2 HUD's three-state border, whose overshoot
  // arrow bounces. Without it EVERY render test in this project fails on
  // `new Animated.Value(0)` at module scope of the surface — 49 tests across 8
  // suites — because the mock silently returns `undefined` for any key it does
  // not define, so the failure surfaces as "Cannot read properties of
  // undefined (reading 'Value')" a long way from the missing export.
  //
  // Deliberately INERT: `Value` holds a number, the drivers are no-ops that
  // return a handle with start/stop, and `interpolate` returns the output
  // range's first entry. A render test asserts what is on the screen, not how
  // it got there over 380 ms — and a mock that actually animated would make
  // every assertion time-dependent, which is how a suite becomes flaky.
  Animated: {
    Value: class {
      constructor(v) { this._value = v; }
      setValue(v) { this._value = v; }
      stopAnimation() {}
      interpolate(cfg) {
        return (cfg && cfg.outputRange && cfg.outputRange[0]) ?? 0;
      }
    },
    // String tags, matching how this mock names every other host component —
    // `View: 'View'` above. Referencing bare identifiers here was a
    // ReferenceError that took out all 9 render suites at load time.
    View: 'Animated.View',
    Text: 'Animated.Text',
    timing: () => ({ start: (cb) => cb && cb({ finished: true }), stop: () => {} }),
    sequence: () => ({ start: (cb) => cb && cb({ finished: true }), stop: () => {} }),
    loop: () => ({ start: () => {}, stop: () => {} }),
  },
  Easing: {
    quad: (t) => t,
    in: (f) => f,
    out: (f) => f,
    inOut: (f) => f,
    linear: (t) => t,
  },
};

// ── Added with the sweep engine ─────────────────────────────────────────
//
// The sweep surface reaches for three RN symbols the mode-bar surfaces never
// did. All three are REAL enough to drive the code under test and no more.

/**
 * `requireNativeComponent` — returns a host component the renderer can mount
 * and a test can find by name.
 *
 * ⚠ IT MUST NOT THROW ON AN UNKNOWN NAME. The whole point of the view
 * resolvers under test is that they PROBE first and require only the name
 * that answered; a mock that threw would make the probe's failure path
 * indistinguishable from a crash, which is the one thing those tests exist
 * to tell apart.
 */
module.exports.requireNativeComponent = (name) => {
  const C = (props) => null;
  C.displayName = name;
  return C;
};

/**
 * `UIManager` — the existence probe, answering NOTHING by default.
 *
 * Both view resolvers memoise per name, so a test that wants a view
 * registered overrides these itself. Returning undefined here means the
 * default is "not in this build", which is the branch a render test hits
 * unless it says otherwise — and it is the branch that must not crash.
 */
module.exports.UIManager = {
  getViewManagerConfig: () => undefined,
  hasViewManagerConfig: () => false,
};

/**
 * `PanResponder` — a no-op gesture responder.
 *
 * The pinch-zoom viewer creates one at mount. Nothing in these tests drives
 * a gesture (there is no touch system off-DOM), so the handlers only have to
 * EXIST for the spread onto a View to be valid.
 */
module.exports.PanResponder = {
  create: () => ({ panHandlers: {} }),
};
